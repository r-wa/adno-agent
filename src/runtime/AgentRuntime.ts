import type { AgentConfig } from '../config'
import { BackendApiClient, type AgentTask, type AgentConfigResponse, type WorkspaceConfigResponse } from '../api/BackendApiClient'
import { TaskExecutor } from './TaskExecutor'
import { VersionChecker } from '../version/VersionChecker'
import { logger } from '../utils/logger'

/**
 * Main agent runtime that manages task polling, execution, and lifecycle
 */
export class AgentRuntime {
  private config: AgentConfig
  private apiClient: BackendApiClient
  private taskExecutor: TaskExecutor
  private versionChecker: VersionChecker

  private isRunning: boolean = false
  private isShuttingDown: boolean = false

  private heartbeatInterval: NodeJS.Timeout | null = null
  private configPollInterval: NodeJS.Timeout | null = null
  private taskPollInterval: NodeJS.Timeout | null = null

  private backendConfig: AgentConfigResponse | null = null
  private workspaceConfig: WorkspaceConfigResponse | null = null
  private activeTasks: Set<string> = new Set()

  // Exponential backoff state for polling failures
  private consecutivePollingFailures: number = 0
  private currentPollingIntervalMs: number = 0

  // Stuck detection timestamps
  private lastPollTime: number = 0
  private lastHeartbeatTime: number = 0

  // Task cancellation controllers
  private activeTaskControllers: Map<string, AbortController> = new Map()

  constructor(config: AgentConfig) {
    this.config = config
    this.apiClient = new BackendApiClient(config)
    this.taskExecutor = new TaskExecutor(config, this.apiClient)
    this.versionChecker = new VersionChecker(config)
    this.currentPollingIntervalMs = config.pollIntervalMs
  }

  /**
   * Start the agent runtime
   */
  async start(): Promise<void> {
    logger.info('Starting agent runtime...')

    try {
      const authenticated = await this.apiClient.authenticate()
      if (!authenticated) {
        throw new Error('Failed to authenticate with backend')
      }

      await this.loadWorkspaceConfig()

      await this.loadConfig()

      logger.info('Sending agent_starting signal...')
      const startingSignalSent = await this.apiClient.sendSignal({
        type: 'agent_starting',
        message: 'Agent starting up',
        payload: {
          version: process.env.npm_package_version || '1.0.0',
          nodeVersion: process.version,
          platform: process.platform,
        },
      })
      logger.info('Agent_starting signal sent', { success: startingSignalSent })

      this.isRunning = true
      this.startHeartbeat()
      this.startConfigPolling()
      this.startTaskPolling()

      logger.info('Agent runtime started successfully')
    } catch (error) {
      logger.error('Failed to start agent runtime', { error })
      throw error
    }
  }

  /**
   * Stop the agent runtime gracefully
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) {
      return
    }

    this.isShuttingDown = true
    logger.info('Stopping agent runtime...')

    this.isRunning = false

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    if (this.configPollInterval) {
      clearInterval(this.configPollInterval)
    }
    if (this.taskPollInterval) {
      clearInterval(this.taskPollInterval)
    }

    logger.info(`Signalling ${this.activeTaskControllers.size} active tasks to cancel...`)
    for (const [taskId, controller] of this.activeTaskControllers.entries()) {
      logger.debug('Aborting task', { taskId })
      controller.abort()
    }

    const SHUTDOWN_TIMEOUT = 30000 // 30 seconds
    const startTime = Date.now()

    while (this.activeTasks.size > 0 && Date.now() - startTime < SHUTDOWN_TIMEOUT) {
      logger.info(`Waiting for ${this.activeTasks.size} active tasks to complete...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    if (this.activeTasks.size > 0) {
      logger.warn(`Shutdown timeout reached with ${this.activeTasks.size} tasks still active`, {
        taskIds: Array.from(this.activeTasks),
      })
    }

    await this.apiClient.sendSignal({
      type: 'agent_stopping',
      message: 'Agent shutting down',
      payload: {
        activeTasks: this.activeTasks.size,
      },
    })

    logger.info('Agent runtime stopped')
  }

  /**
   * Load workspace configuration (ADO/OpenAI credentials) from backend
   */
  private async loadWorkspaceConfig(): Promise<void> {
    logger.info('Loading workspace configuration from backend...')

    const config = await this.apiClient.getWorkspaceConfig()
    if (!config) {
      logger.warn('Failed to load workspace config from backend')
      throw new Error('Workspace configuration is required but could not be loaded')
    }

    this.workspaceConfig = config

    this.taskExecutor.setWorkspaceConfig(config)

    logger.info('Workspace configuration loaded', {
      ado_configured: config.config_status.ado_configured,
      openai_configured: config.config_status.openai_configured,
    })

    // Validate required configuration
    if (!config.config_status.ado_configured) {
      logger.warn('Azure DevOps is not configured in workspace settings')
    }
    if (!config.config_status.openai_configured) {
      logger.warn('OpenAI is not configured in workspace settings')
    }
  }

  /**
   * Load configuration from backend
   */
  private async loadConfig(): Promise<void> {
    logger.info('Loading configuration from backend...')

    const config = await this.apiClient.getConfig()
    if (!config) {
      logger.warn('Failed to load config from backend, using defaults')
      return
    }

    this.backendConfig = config

    logger.info('Configuration loaded', {
      version: config.version,
      pollIntervalMs: config.poll_interval_ms,
      heartbeatIntervalMs: config.heartbeat_interval_ms,
      enabledTaskTypes: config.enabled_task_types,
      maxConcurrentTasks: config.max_concurrent_tasks,
    })

    this.versionChecker.checkVersion(config.version_info)

    this.updateIntervals(config)
  }

  /**
   * Update polling intervals based on backend config
   */
  private updateIntervals(config: AgentConfigResponse): void {
    if (this.heartbeatInterval && this.config.heartbeatIntervalMs !== config.heartbeat_interval_ms) {
      clearInterval(this.heartbeatInterval)
      this.config.heartbeatIntervalMs = config.heartbeat_interval_ms
      this.startHeartbeat()
      logger.info('Updated heartbeat interval', { intervalMs: config.heartbeat_interval_ms })
    }

    if (this.taskPollInterval && this.config.pollIntervalMs !== config.poll_interval_ms) {
      clearInterval(this.taskPollInterval)
      this.config.pollIntervalMs = config.poll_interval_ms
      this.startTaskPolling()
      logger.info('Updated poll interval', { intervalMs: config.poll_interval_ms })
    }

    if (this.config.maxConcurrentTasks !== config.max_concurrent_tasks) {
      this.config.maxConcurrentTasks = config.max_concurrent_tasks
      logger.info('Updated max concurrent tasks', { maxConcurrent: config.max_concurrent_tasks })
    }
  }

  /**
   * Start sending heartbeats
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      await this.sendHeartbeat()
    }, this.config.heartbeatIntervalMs)

    this.sendHeartbeat()
  }

  /**
   * Start polling for config updates
   */
  private startConfigPolling(): void {
    this.configPollInterval = setInterval(async () => {
      await this.loadConfig()
    }, 30000) // Check config every 30 seconds
  }

  /**
   * Start polling for tasks
   */
  private startTaskPolling(): void {
    this.taskPollInterval = setInterval(async () => {
      if (this.isRunning && !this.isShuttingDown) {
        await this.pollAndExecuteTasks()
      }
    }, this.currentPollingIntervalMs)

    this.pollAndExecuteTasks()
  }

  /**
   * Restart task polling with exponential backoff on failures
   */
  private restartTaskPollingWithBackoff(): void {
    if (this.taskPollInterval) {
      clearInterval(this.taskPollInterval)
    }

    const baseDelay = this.config.pollIntervalMs
    const maxDelay = 300000 // 5 minutes
    const backoffDelay = Math.min(baseDelay * Math.pow(2, this.consecutivePollingFailures), maxDelay)

    this.currentPollingIntervalMs = backoffDelay

    logger.warn('Restarting task polling with exponential backoff', {
      consecutiveFailures: this.consecutivePollingFailures,
      baseDelayMs: baseDelay,
      backoffDelayMs: backoffDelay,
    })

    this.startTaskPolling()
  }

  /**
   * Reset task polling to normal interval after successful poll
   */
  private resetTaskPollingInterval(): void {
    if (this.currentPollingIntervalMs !== this.config.pollIntervalMs) {
      logger.info('Resetting task polling to normal interval', {
        intervalMs: this.config.pollIntervalMs,
      })

      this.currentPollingIntervalMs = this.config.pollIntervalMs

      if (this.taskPollInterval) {
        clearInterval(this.taskPollInterval)
      }
      this.startTaskPolling()
    }
  }

  /**
   * Send heartbeat to backend
   */
  private async sendHeartbeat(): Promise<void> {
    try {
      logger.info('Sending heartbeat...')
      const sent = await this.apiClient.sendSignal({
        type: 'heartbeat',
        payload: {
          version: this.versionChecker.getCurrentVersion(),
          activeTasks: this.activeTasks.size,
          maxConcurrentTasks: this.config.maxConcurrentTasks,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        },
      })
      logger.info('Heartbeat sent', { success: sent })

      this.lastHeartbeatTime = Date.now()
    } catch (error) {
      logger.error('Failed to send heartbeat', { error })
    }
  }

  /**
   * Poll for tasks and execute them
   */
  private async pollAndExecuteTasks(): Promise<void> {
    this.lastPollTime = Date.now()

    try {
      const availableSlots = this.config.maxConcurrentTasks - this.activeTasks.size
      if (availableSlots <= 0) {
        logger.debug('No available task slots', {
          active: this.activeTasks.size,
          max: this.config.maxConcurrentTasks,
        })
        // Reset failure count even when at capacity (successful connection)
        if (this.consecutivePollingFailures > 0) {
          this.consecutivePollingFailures = 0
          this.resetTaskPollingInterval()
        }
        return
      }

      const tasks = await this.apiClient.getTasks(availableSlots)

      if (tasks.length === 0) {
        logger.debug('No pending tasks')
      } else {
        logger.info(`Found ${tasks.length} pending tasks`, {
          availableSlots,
          tasks: tasks.map(t => ({ id: t.id, type: t.type })),
        })

        const tasksToExecute = tasks.slice(0, availableSlots)
        await Promise.allSettled(
          tasksToExecute.map(task => this.executeTask(task))
        )
      }

      if (this.consecutivePollingFailures > 0) {
        this.consecutivePollingFailures = 0
        this.resetTaskPollingInterval()
      }
    } catch (error) {
      logger.error('Error in task polling', { error })

      this.consecutivePollingFailures++
      this.restartTaskPollingWithBackoff()
    }
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: AgentTask): Promise<void> {
    logger.info('Executing task', { taskId: task.id, type: task.type })

    const abortController = new AbortController()

    try {
      const claimedTask = await this.apiClient.claimTask(task.id)
      if (!claimedTask) {
        logger.debug('Task already claimed by another agent', { taskId: task.id })
        return
      }

      this.activeTasks.add(task.id)
      this.activeTaskControllers.set(task.id, abortController)

      await this.apiClient.sendSignal({
        type: 'task_started',
        payload: {
          taskId: task.id,
          taskType: task.type,
        },
      })

      const result = await this.taskExecutor.execute(claimedTask, abortController.signal)

      if (abortController.signal.aborted) {
        logger.warn('Task was cancelled during execution', { taskId: task.id })
        await this.apiClient.failTask(task.id, 'Task cancelled during shutdown', false)
        return
      }

      await this.apiClient.completeTask(task.id, result)

      await this.apiClient.sendSignal({
        type: 'task_completed',
        payload: {
          taskId: task.id,
          taskType: task.type,
          result,
        },
      })

      logger.info('Task completed successfully', { taskId: task.id, type: task.type })
    } catch (error: any) {
      if (abortController.signal.aborted) {
        logger.warn('Task execution cancelled', {
          taskId: task.id,
          type: task.type,
        })
        await this.apiClient.failTask(task.id, 'Task cancelled during shutdown', false)
        return
      }

      logger.error('Task execution failed', {
        taskId: task.id,
        type: task.type,
        error: error.message,
      })

      await this.apiClient.failTask(task.id, error.message, true)

      await this.apiClient.sendSignal({
        type: 'task_failed',
        severity: 'error',
        message: error.message,
        payload: {
          taskId: task.id,
          taskType: task.type,
          error: error.message,
          stack: error.stack,
        },
      })
    } finally {
      this.activeTasks.delete(task.id)
      this.activeTaskControllers.delete(task.id)
    }
  }

}