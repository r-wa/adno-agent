import type { HttpClient } from '../http/types'
import type { ConfigVersionStore } from '../state/ConfigVersionStore'
import { logger } from '../utils/logger'
import { getErrorMessage, getErrorStatus, getErrorInfo } from '../utils/HttpError'

export interface AgentTask {
  id: string
  type: 'fetcher' | 'suggestion' | 'apply' | 'logger' | 'maintain'
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

// Worker settings types - per-worker configuration
// schedule_interval_ms = how often the worker creates tasks
export interface FetcherWorkerSettings {
  enabled: boolean
  schedule_interval_ms: number  // 1h/8h/24h - how often to sync from ADO
  max_items?: number  // Maximum items to fetch per sync (100/500/1000). Default: 500
}

export interface SuggestionWorkerSettings {
  enabled: boolean
}

export interface ApplyWorkerSettings {
  enabled: boolean
}

export interface LoggerWorkerSettings {
  enabled: boolean
  log_level: 'debug' | 'info' | 'warn' | 'error'
  schedule_interval_ms: number  // 10s/30s/60s - how often to send logs
}

export interface MaintainWorkerSettings {
  enabled: boolean
  retention_days: number
  schedule_interval_ms: number  // 1h/6h/24h - how often to run cleanup
}

export interface WorkerSettings {
  fetcher: FetcherWorkerSettings
  suggestion: SuggestionWorkerSettings
  apply: ApplyWorkerSettings
  logger: LoggerWorkerSettings
  maintain: MaintainWorkerSettings
}

export interface AgentConfigResponse {
  heartbeat_interval_ms: number
  task_poll_interval_ms: number  // How often to poll for tasks (5m/15m/60m)
  max_concurrent_tasks: number
  workers: WorkerSettings
  limits: {
    max_ado_syncs_per_hour: number
    max_suggestion_requests_per_hour: number
    max_openai_tokens_per_hour: number
  }
  version: string
  version_info?: VersionInfo | null
}

// Response from GET /api/agent/tasks (includes config piggyback)
export interface GetTasksResponse {
  tasks: AgentTask[]
  config?: AgentConfigResponse | null  // Included when config version changes
}

// Request to create a task (used by worker schedulers)
export interface CreateTaskRequest {
  type: 'fetcher' | 'suggestion' | 'apply' | 'logger' | 'maintain'
  priority?: 'low' | 'normal' | 'high'
  payload?: Record<string, any>
}

export interface CreateTaskResponse {
  task_id: string
  status: 'pending' | 'already_pending'
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

// Signal category distinguishes operational events from application logs
export type SignalCategory = 'event' | 'log'

// Event types for operational signals (category='event')
export type SignalEventType = 'heartbeat' | 'task_started' | 'task_completed' | 'task_failed' | 'agent_starting' | 'agent_stopping' | 'error'

// Severity levels for log signals (category='log')
export type SignalSeverity = 'debug' | 'info' | 'warn' | 'error'

export interface SignalPayload {
  // Category distinguishes events from logs
  category: SignalCategory

  // For events (category='event') - the specific event type
  // For logs (category='log') - preserved as 'log' for backwards compatibility
  type: SignalEventType | 'log'

  // Severity level (primarily for logs, but also used for error events)
  severity?: SignalSeverity

  // Human-readable message
  message?: string

  // Structured data payload
  payload?: Record<string, any>

  // ISO timestamp (optional, server will use received_at if not provided)
  timestamp?: string
}

/**
 * API client for communicating with the adno backend
 * Uses injected HttpClient for all HTTP operations (retry, circuit breaker, logging handled by decorators)
 */
export class BackendApiClient {
  private httpClient: HttpClient
  private configVersionStore: ConfigVersionStore

  constructor(httpClient: HttpClient, configVersionStore: ConfigVersionStore) {
    this.httpClient = httpClient
    this.configVersionStore = configVersionStore
  }

  /**
   * Authenticate with the backend by attempting to fetch config
   * All agent endpoints perform authentication, so a successful config fetch confirms auth
   */
  async authenticate(): Promise<boolean> {
    try {
      const config = await this.httpClient.request<AgentConfigResponse>('/api/agent/config')
      this.configVersionStore.setVersion(config.version)

      logger.info('Authenticated successfully', {
        configVersion: config.version,
      })

      return true
    } catch (error: unknown) {
      const { title, status, detail } = getErrorInfo(error)

      // Distinguish auth failures from infrastructure failures
      if (status === 401) {
        logger.error(title || 'Authentication failed: Invalid or expired API key', {
          status,
          detail,
          suggestion: 'Check ADNO_API_KEY environment variable',
        })
      } else if (status === 403) {
        logger.error(title || 'Authentication failed: Permission denied', {
          status,
          detail,
          suggestion: 'API key does not have required permissions',
        })
      } else {
        logger.error(title || 'Authentication request failed', {
          status,
          detail,
          suggestion: 'Check network connectivity and backend availability',
        })
      }

      return false
    }
  }

  /**
   * Get agent configuration from backend
   */
  async getConfig(): Promise<AgentConfigResponse | null> {
    try {
      return await this.httpClient.request<AgentConfigResponse>('/api/agent/config')
    } catch (error: unknown) {
      const { title, status, detail } = getErrorInfo(error)
      logger.error(title || 'Failed to get config', { status, detail })
      return null
    }
  }

  /**
   * Get workspace configuration (ADO and OpenAI credentials)
   */
  async getWorkspaceConfig(): Promise<WorkspaceConfigResponse | null> {
    try {
      const data = await this.httpClient.request<WorkspaceConfigResponse>('/api/agent/workspace-config')
      logger.info('[BackendApiClient] Fetched workspace configuration', {
        ado_configured: data.config_status?.ado_configured,
        openai_configured: data.config_status?.openai_configured,
      })
      return data
    } catch (error: unknown) {
      const { title, status, detail } = getErrorInfo(error)
      logger.error(title || 'Failed to get workspace config', { status, detail })
      return null
    }
  }

  /**
   * Send signals (heartbeats, logs, etc) to backend
   */
  async sendSignals(signals: SignalPayload[]): Promise<boolean> {
    try {
      await this.httpClient.request('/api/agent/signal', {
        method: 'POST',
        body: JSON.stringify({ signals }),
      })
      return true
    } catch (error: unknown) {
      const { title, status, detail } = getErrorInfo(error)
      logger.error(title || 'Failed to send signals', { status, detail })
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
   * Also returns config if version changed (piggyback pattern)
   */
  async getTasks(limit: number = 10): Promise<GetTasksResponse> {
    try {
      // Include config_version for piggyback - server returns config only if version changed
      const version = this.configVersionStore.getVersion()
      const versionParam = version ? `&config_version=${version}` : ''
      const data = await this.httpClient.request<GetTasksResponse>(`/api/agent/tasks?limit=${limit}${versionParam}`)

      // Update config version if new config received
      if (data.config) {
        this.configVersionStore.setVersion(data.config.version)
        logger.info('Config updated via piggyback', { version: data.config.version })
      }

      return {
        tasks: data.tasks || [],
        config: data.config,
      }
    } catch (error: unknown) {
      const { title, status, detail } = getErrorInfo(error)
      logger.error(title || 'Failed to get tasks', { status, detail })
      return { tasks: [] }
    }
  }

  /**
   * Create a new task (used by worker schedulers)
   * Returns 'already_pending' if task with same type already exists
   */
  async createTask(request: CreateTaskRequest): Promise<CreateTaskResponse | null> {
    try {
      const data = await this.httpClient.request<CreateTaskResponse>('/api/agent/tasks', {
        method: 'POST',
        body: JSON.stringify(request),
      })
      logger.debug('Task created', {
        taskId: data.task_id,
        status: data.status,
        type: request.type,
      })
      return data
    } catch (error: unknown) {
      const { title, status, detail } = getErrorInfo(error)
      logger.error(title || 'Failed to create task', {
        type: request.type,
        status,
        detail,
      })
      return null
    }
  }

  /**
   * Claim a task atomically
   */
  async claimTask(taskId: string): Promise<AgentTask | null> {
    try {
      const data = await this.httpClient.request<{ claimed: boolean; task?: AgentTask }>(`/api/agent/tasks/${taskId}/claim`, {
        method: 'POST',
      })
      if (data.claimed) {
        return data.task || null
      }
      return null
    } catch (error: unknown) {
      const { title, status, detail } = getErrorInfo(error)
      logger.error(title || 'Failed to claim task', { taskId, status, detail })
      return null
    }
  }

  /**
   * Mark a task as completed
   */
  async completeTask(taskId: string, result: Record<string, any>): Promise<boolean> {
    try {
      await this.httpClient.request(`/api/agent/tasks/${taskId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ result }),
      })
      return true
    } catch (error: unknown) {
      const { title, status, detail } = getErrorInfo(error)
      logger.error(title || 'Failed to complete task', { taskId, status, detail })
      return false
    }
  }

  /**
   * Mark a task as failed
   */
  async failTask(taskId: string, error: string, retryable: boolean = true): Promise<boolean> {
    try {
      await this.httpClient.request(`/api/agent/tasks/${taskId}/fail`, {
        method: 'POST',
        body: JSON.stringify({ error, retryable }),
      })
      return true
    } catch (err: unknown) {
      const { title, status, detail } = getErrorInfo(err)
      logger.error(title || 'Failed to report task failure', { taskId, status, detail })
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
      configVersion: this.configVersionStore.getVersion(),
    }
  }
}
