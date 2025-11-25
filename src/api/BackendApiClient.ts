import type { AgentConfig } from '../config'
import { logger } from '../utils/logger'
import { CircuitBreaker, CircuitBreakerOpenError } from '../utils/circuit-breaker'

export interface AgentTask {
  id: string
  type: 'ado_sync' | 'clarity_suggestion' | 'consensus_evaluation'
  payload: Record<string, any>
  scheduled_at: string
  priority: number
}

export interface VersionInfo {
  recommended_version: string
  download_url: string
  checksum_sha256: string
  release_notes: string | null
  is_required: boolean
  should_update: boolean
}

export interface AgentConfigResponse {
  poll_interval_ms: number
  heartbeat_interval_ms: number
  enabled_task_types: string[]
  max_concurrent_tasks: number
  limits: {
    max_ado_syncs_per_hour: number
    max_clarity_requests_per_hour: number
    max_openai_tokens_per_hour: number
  }
  version: string
  version_info?: VersionInfo | null
}

export interface WorkspaceConfigResponse {
  ado_organization: string | null
  ado_project: string | null
  ado_team: string | null
  ado_pat_token: string | null
  azure_openai_endpoint: string | null
  azure_openai_deployment: string | null
  azure_openai_api_key: string | null
  azure_openai_api_version: string
  config_status: {
    ado_configured: boolean
    openai_configured: boolean
  }
}

export interface SignalPayload {
  type: 'heartbeat' | 'task_started' | 'task_completed' | 'task_failed' | 'log' | 'agent_starting' | 'agent_stopping' | 'error'
  payload?: Record<string, any>
  severity?: 'debug' | 'info' | 'warn' | 'error'
  message?: string
  timestamp?: string
}

/**
 * API client for communicating with the adno backend
 * Uses native fetch API (Node 18+) instead of axios
 */
export class BackendApiClient {
  private config: AgentConfig
  private configVersion: string | null = null
  private baseURL: string
  private defaultHeaders: Record<string, string>
  private circuitBreaker: CircuitBreaker

  constructor(config: AgentConfig) {
    this.config = config
    this.baseURL = config.apiUrl
    this.defaultHeaders = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    }
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      recoveryTimeoutMs: 60000,
      successThreshold: 2,
      timeoutMs: 30000,
    })
  }

  /**
   * Redact sensitive headers for safe logging
   */
  private redactHeaders(headers?: Record<string, string> | Headers): Record<string, string> {
    if (!headers) return {}
    const headerObj = headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers as Record<string, string>
    const redacted = { ...headerObj }
    // Redact sensitive headers
    const sensitiveHeaders = ['authorization', 'api-key', 'x-api-key']
    for (const key of Object.keys(redacted)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        redacted[key] = '[REDACTED]'
      }
    }
    return redacted
  }

  /**
   * Helper method to make HTTP requests with native fetch
   * Protected by circuit breaker to prevent cascading failures
   * Note: Headers are never logged to protect credentials
   */
  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    // Wrap request in circuit breaker
    return this.circuitBreaker.execute(async () => {
      const url = `${this.baseURL}${path}`

      logger.debug('API Request', {
        method: options.method || 'GET',
        url: path,
        circuitState: this.circuitBreaker.getState(),
        // Headers intentionally omitted for security
      })

      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            ...this.defaultHeaders,
            ...options.headers,
          },
          signal: AbortSignal.timeout(30000), // 30 second timeout
        })

        logger.debug('API Response', {
          status: response.status,
          url: path,
        })

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error')
          const error: any = new Error(`HTTP ${response.status}: ${errorText}`)
          error.status = response.status
          error.response = { status: response.status }
          throw error
        }

        const data = await response.json()
        return data as T
      } catch (error: any) {
        logger.error('API Request Error', {
          url: path,
          message: error.message,
          status: error.status,
        })
        throw error
      }
    })
  }

  /**
   * Authenticate with the backend by attempting to fetch config
   * All agent endpoints perform authentication, so a successful config fetch confirms auth
   */
  async authenticate(): Promise<boolean> {
    try {
      const config = await withRetry(async () => {
        return await this.request<AgentConfigResponse>('/api/agent/config')
      }, 3, 1000)

      this.configVersion = config.version

      logger.info('Authenticated successfully', {
        configVersion: this.configVersion,
      })

      return true
    } catch (error: any) {
      logger.error('Authentication failed', {
        error: error.message,
        status: error.status,
      })
      return false
    }
  }

  /**
   * Get agent configuration from backend
   */
  async getConfig(): Promise<AgentConfigResponse | null> {
    try {
      return await withRetry(async () => {
        return await this.request<AgentConfigResponse>('/api/agent/config')
      }, 3, 1000)
    } catch (error: any) {
      logger.error('Failed to get config', { error: error.message })
      return null
    }
  }

  /**
   * Get workspace configuration (ADO and OpenAI credentials)
   */
  async getWorkspaceConfig(): Promise<WorkspaceConfigResponse | null> {
    try {
      const data = await withRetry(async () => {
        return await this.request<WorkspaceConfigResponse>('/api/agent/workspace-config')
      }, 3, 1000)
      logger.info('[BackendApiClient] Fetched workspace configuration', {
        ado_configured: data.config_status?.ado_configured,
        openai_configured: data.config_status?.openai_configured,
      })
      return data
    } catch (error: any) {
      logger.error('[BackendApiClient] Failed to get workspace config', { error: error.message })
      return null
    }
  }

  /**
   * Send signals (heartbeats, logs, etc) to backend
   */
  async sendSignals(signals: SignalPayload[]): Promise<boolean> {
    try {
      await this.request('/api/agent/signal', {
        method: 'POST',
        body: JSON.stringify({ signals }),
      })
      return true
    } catch (error: any) {
      logger.error('Failed to send signals', { error: error.message })
      return false
    }
  }

  /**
   * Send a single signal
   */
  async sendSignal(signal: SignalPayload): Promise<boolean> {
    return this.sendSignals([signal])
  }

  /**
   * Get pending tasks from backend
   */
  async getTasks(limit: number = 10): Promise<AgentTask[]> {
    try {
      const data = await withRetry(async () => {
        return await this.request<{ tasks: AgentTask[] }>(`/api/agent/tasks?limit=${limit}`)
      }, 3, 1000)
      return data.tasks || []
    } catch (error: any) {
      logger.error('Failed to get tasks', { error: error.message })
      return []
    }
  }

  /**
   * Claim a task atomically
   */
  async claimTask(taskId: string): Promise<AgentTask | null> {
    try {
      const data = await withRetry(async () => {
        return await this.request<{ claimed: boolean; task?: AgentTask }>(`/api/agent/tasks/${taskId}/claim`, {
          method: 'POST',
        })
      }, 3, 1000)
      if (data.claimed) {
        return data.task || null
      }
      return null
    } catch (error: any) {
      logger.error('Failed to claim task', { taskId, error: error.message })
      return null
    }
  }

  /**
   * Mark a task as completed
   */
  async completeTask(taskId: string, result: Record<string, any>): Promise<boolean> {
    try {
      await withRetry(async () => {
        return await this.request(`/api/agent/tasks/${taskId}/complete`, {
          method: 'POST',
          body: JSON.stringify({ result }),
        })
      }, 3, 1000)
      return true
    } catch (error: any) {
      logger.error('Failed to complete task', { taskId, error: error.message })
      return false
    }
  }

  /**
   * Mark a task as failed
   */
  async failTask(taskId: string, error: string, retryable: boolean = true): Promise<boolean> {
    try {
      await withRetry(async () => {
        return await this.request(`/api/agent/tasks/${taskId}/fail`, {
          method: 'POST',
          body: JSON.stringify({ error, retryable }),
        })
      }, 3, 1000)
      return true
    } catch (error: any) {
      logger.error('Failed to fail task', { taskId, error: error.message })
      return false
    }
  }

  /**
   * Get workspace context
   * Note: workspaceId, workspaceName, and agentId are no longer tracked
   * as all API endpoints handle authentication internally
   */
  getWorkspaceContext() {
    return {
      workspaceId: null as string | null,
      workspaceName: null as string | null,
      agentId: null as string | null,
      configVersion: this.configVersion,
    }
  }

  /**
   * Get circuit breaker state for monitoring
   */
  getCircuitBreakerState() {
    return this.circuitBreaker.getStats()
  }

  /**
   * Manually reset the circuit breaker
   */
  resetCircuitBreaker() {
    this.circuitBreaker.reset()
  }
}

/**
 * Retry wrapper for API calls
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  backoffMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error: any) {
      lastError = error

      // Don't retry on 4xx errors (except 429 rate limit)
      if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        throw error
      }

      if (attempt < maxRetries) {
        const delay = backoffMs * Math.pow(2, attempt - 1)
        logger.warn(`Retrying after ${delay}ms (attempt ${attempt}/${maxRetries})`, {
          error: error.message,
        })
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError
}