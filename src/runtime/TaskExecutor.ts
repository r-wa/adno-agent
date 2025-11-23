import type { AgentConfig } from '../config'
import type { BackendApiClient, AgentTask, WorkspaceConfigResponse } from '../api/BackendApiClient'
import { logger } from '../utils/logger'

// Task handlers will be imported here
import { AdoSyncHandler } from '../tasks/AdoSyncHandler'
import { ClaritySuggestionHandler } from '../tasks/ClaritySuggestionHandler'
import { ConsensusEvaluationHandler } from '../tasks/ConsensusEvaluationHandler'

export interface TaskHandler {
  execute(task: AgentTask, context: TaskContext): Promise<Record<string, any>>
}

export interface TaskContext {
  config: AgentConfig
  apiClient: BackendApiClient
  workspaceId: string
  agentId: string
  workspaceConfig: WorkspaceConfigResponse | null
  signal?: AbortSignal  // Cancellation signal for graceful shutdown
}

/**
 * Task executor that routes tasks to appropriate handlers
 */
export class TaskExecutor {
  private config: AgentConfig
  private apiClient: BackendApiClient
  private workspaceConfig: WorkspaceConfigResponse | null = null
  private handlers: Map<string, TaskHandler>

  constructor(config: AgentConfig, apiClient: BackendApiClient) {
    this.config = config
    this.apiClient = apiClient

    // Register task handlers
    this.handlers = new Map<string, TaskHandler>([
      ['ado_sync', new AdoSyncHandler()],
      ['clarity_suggestion', new ClaritySuggestionHandler()],
      ['consensus_evaluation', new ConsensusEvaluationHandler()],
    ])
  }

  /**
   * Set workspace configuration (ADO/OpenAI credentials)
   */
  setWorkspaceConfig(config: WorkspaceConfigResponse): void {
    this.workspaceConfig = config
    logger.info('Workspace configuration set in TaskExecutor', {
      ado_configured: config.config_status.ado_configured,
      openai_configured: config.config_status.openai_configured,
    })
  }

  /**
   * Execute a task using the appropriate handler
   */
  async execute(task: AgentTask, signal?: AbortSignal): Promise<Record<string, any>> {
    logger.info('Executing task', { taskId: task.id, type: task.type })

    const handler = this.handlers.get(task.type)
    if (!handler) {
      throw new Error(`No handler registered for task type: ${task.type}`)
    }

    const context = this.getTaskContext(signal)

    // Check if already cancelled before starting
    if (signal?.aborted) {
      throw new Error('Task cancelled before execution')
    }

    try {
      const result = await handler.execute(task, context)
      logger.info('Task executed successfully', {
        taskId: task.id,
        type: task.type,
      })
      return result
    } catch (error: any) {
      // Check if error was due to cancellation
      if (signal?.aborted) {
        logger.warn('Task execution cancelled', {
          taskId: task.id,
          type: task.type,
        })
        throw new Error('Task execution cancelled')
      }

      logger.error('Task execution failed', {
        taskId: task.id,
        type: task.type,
        error: error.message,
      })
      throw error
    }
  }

  /**
   * Get task context for handlers
   */
  private getTaskContext(signal?: AbortSignal): TaskContext {
    const workspaceContext = this.apiClient.getWorkspaceContext()

    // Validate workspace context is properly initialized
    if (!workspaceContext.workspaceId) {
      throw new Error('Workspace ID not available. Ensure agent is authenticated before executing tasks.')
    }
    if (!workspaceContext.agentId) {
      throw new Error('Agent ID not available. Ensure agent is authenticated before executing tasks.')
    }

    return {
      config: this.config,
      apiClient: this.apiClient,
      workspaceId: workspaceContext.workspaceId,
      agentId: workspaceContext.agentId,
      workspaceConfig: this.workspaceConfig,
      signal,
    }
  }

  /**
   * Register a custom task handler
   */
  registerHandler(taskType: string, handler: TaskHandler): void {
    this.handlers.set(taskType, handler)
    logger.info('Registered task handler', { taskType })
  }
}