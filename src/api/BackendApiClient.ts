import axios, { AxiosInstance } from 'axios'
import type { AgentConfig } from '../config'
import { logger } from '../utils/logger'

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
 */
export class BackendApiClient {
  private client: AxiosInstance
  private config: AgentConfig
  private workspaceId: string | null = null
  private workspaceName: string | null = null
  private agentId: string | null = null
  private configVersion: string | null = null

  constructor(config: AgentConfig) {
    this.config = config

    this.client = axios.create({
      baseURL: config.apiUrl,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000, // 30 seconds
    })

    // Add request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        logger.debug('API Request', {
          method: config.method,
          url: config.url,
        })
        return config
      },
      (error) => {
        logger.error('API Request Error', { error: error.message })
        return Promise.reject(error)
      }
    )

    // Add response interceptor for logging
    this.client.interceptors.response.use(
      (response) => {
        logger.debug('API Response', {
          status: response.status,
          url: response.config.url,
        })
        return response
      },
      (error) => {
        logger.error('API Response Error', {
          status: error.response?.status,
          url: error.config?.url,
          message: error.message,
        })
        return Promise.reject(error)
      }
    )
  }

  /**
   * Authenticate with the backend and get workspace context
   */
  async authenticate(): Promise<boolean> {
    try {
      const response = await this.client.post('/api/agent/auth')

      this.workspaceId = response.data.workspace_id
      this.workspaceName = response.data.workspace_name
      this.agentId = response.data.agent_id
      this.configVersion = response.data.config_version

      logger.info('Authenticated successfully', {
        workspaceId: this.workspaceId,
        workspaceName: this.workspaceName,
        agentId: this.agentId,
      })

      return true
    } catch (error: any) {
      logger.error('Authentication failed', {
        error: error.message,
        status: error.response?.status,
      })
      return false
    }
  }

  /**
   * Get agent configuration from backend
   */
  async getConfig(): Promise<AgentConfigResponse | null> {
    try {
      const response = await this.client.get('/api/agent/config')
      return response.data
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
      const response = await this.client.get('/api/agent/workspace-config')
      logger.info('[BackendApiClient] Fetched workspace configuration', {
        ado_configured: response.data.config_status?.ado_configured,
        openai_configured: response.data.config_status?.openai_configured,
      })
      return response.data
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
      await this.client.post('/api/agent/signal', { signals })
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
      const response = await this.client.get(`/api/agent/tasks?limit=${limit}`)
      return response.data.tasks || []
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
      const response = await this.client.post(`/api/agent/tasks/${taskId}/claim`)
      if (response.data.claimed) {
        return response.data.task
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
      await this.client.post(`/api/agent/tasks/${taskId}/complete`, { result })
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
      await this.client.post(`/api/agent/tasks/${taskId}/fail`, { error, retryable })
      return true
    } catch (error: any) {
      logger.error('Failed to fail task', { taskId, error: error.message })
      return false
    }
  }

  /**
   * Get workspace context
   */
  getWorkspaceContext() {
    return {
      workspaceId: this.workspaceId,
      workspaceName: this.workspaceName,
      agentId: this.agentId,
      configVersion: this.configVersion,
    }
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
      if (error.response?.status >= 400 && error.response?.status < 500 && error.response?.status !== 429) {
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