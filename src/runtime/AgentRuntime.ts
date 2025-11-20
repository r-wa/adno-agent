import type { AgentConfig } from '../config'
import { BackendApiClient, type AgentTask, type AgentConfigResponse, type WorkspaceConfigResponse } from '../api/BackendApiClient'
import { TaskExecutor } from './TaskExecutor'
import { HealthCheckServer } from './HealthCheckServer'
import { VersionChecker } from '../version/VersionChecker'
import { logger } from '../utils/logger'

/**
 * Main agent runtime that manages task polling, execution, and lifecycle
 */
export class AgentRuntime {
  private config: AgentConfig
  private apiClient: BackendApiClient
  private taskExecutor: TaskExecutor
  private healthCheckServer: HealthCheckServer
  private versionChecker: VersionChecker

  private isRunning: boolean = false
  private isShuttingDown: boolean = false

  private heartbeatInterval: NodeJS.Timeout | null = null
  private configPollInterval: NodeJS.Timeout | null = null
  private taskPollInterval: NodeJS.Timeout | null = null

  private backendConfig: AgentConfigResponse | null = null
  private workspaceConfig: WorkspaceConfigResponse | null = null
  private activeTasks: Set<string> = new Set()

  constructor(config: AgentConfig) {
    this.config = config
    this.apiClient = new BackendApiClient(config)
    this.taskExecutor = new TaskExecutor(config, this.apiClient)
    this.healthCheckServer = new HealthCheckServer(config)
    this.versionChecker = new VersionChecker(config)
  }

  /**
   * Start the agent runtime
   */
  async start(): Promise<void> {
    logger.info('Starting agent runtime...')

    try {
      // 1. Authenticate with backend
      const authenticated = await this.apiClient.authenticate()
      if (!authenticated) {
        throw new Error('Failed to authenticate with backend')
      }

      // 2. Load workspace configuration (ADO/OpenAI credentials)
      await this.loadWorkspaceConfig()

      // 3. Load agent configuration
      await this.loadConfig()

      // 4. Send agent_starting signal
      await this.apiClient.sendSignal({
        type: 'agent_starting',
        message: 'Agent starting up',
        payload: {
          version: process.env.npm_package_version || '1.0.0',
          nodeVersion: process.version,
          platform: process.platform,
        },
      })

      // 5. Start health check server
      await this.healthCheckServer.start(this.getHealthStatus.bind(this))

      // 6. Start periodic tasks
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

    // 1. Stop claiming new tasks
    this.isRunning = false

    // 2. Clear intervals
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    if (this.configPollInterval) {
      clearInterval(this.configPollInterval)
    }
    if (this.taskPollInterval) {
      clearInterval(this.taskPollInterval)
    }

    // 3. Wait for active tasks to complete (with timeout)
    const SHUTDOWN_TIMEOUT = 30000 // 30 seconds
    const startTime = Date.now()

    while (this.activeTasks.size > 0 && Date.now() - startTime < SHUTDOWN_TIMEOUT) {
      logger.info(`Waiting for ${this.activeTasks.size} active tasks to complete...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    if (this.activeTasks.size > 0) {
      logger.warn(`Shutdown timeout reached with ${this.activeTasks.size} tasks still active`)
    }

    // 4. Send agent_stopping signal
    await this.apiClient.sendSignal({
      type: 'agent_stopping',
      message: 'Agent shutting down',
      payload: {
        activeTasks: this.activeTasks.size,
      },
    })

    // 5. Stop health check server
    await this.healthCheckServer.stop()

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

    // Pass workspace config to task executor
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

    // Check for version updates
    this.versionChecker.checkVersion(config.version_info)

    // Update local intervals if changed
    this.updateIntervals(config)
  }

  /**
   * Update polling intervals based on backend config
   */
  private updateIntervals(config: AgentConfigResponse): void {
    // Restart heartbeat if interval changed
    if (this.heartbeatInterval && this.config.heartbeatIntervalMs !== config.heartbeat_interval_ms) {
      clearInterval(this.heartbeatInterval)
      this.config.heartbeatIntervalMs = config.heartbeat_interval_ms
      this.startHeartbeat()
      logger.info('Updated heartbeat interval', { intervalMs: config.heartbeat_interval_ms })
    }

    // Restart task polling if interval changed
    if (this.taskPollInterval && this.config.pollIntervalMs !== config.poll_interval_ms) {
      clearInterval(this.taskPollInterval)
      this.config.pollIntervalMs = config.poll_interval_ms
      this.startTaskPolling()
      logger.info('Updated poll interval', { intervalMs: config.poll_interval_ms })
    }

    // Update max concurrent tasks
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

    // Send initial heartbeat immediately
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
    }, this.config.pollIntervalMs)

    // Poll immediately
    this.pollAndExecuteTasks()
  }

  /**
   * Send heartbeat to backend
   */
  private async sendHeartbeat(): Promise<void> {
    try {
      await this.apiClient.sendSignal({
        type: 'heartbeat',
        payload: {
          version: this.versionChecker.getCurrentVersion(),
          activeTasks: this.activeTasks.size,
          maxConcurrentTasks: this.config.maxConcurrentTasks,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        },
      })
      logger.debug('Heartbeat sent')
    } catch (error) {
      logger.error('Failed to send heartbeat', { error })
    }
  }

  /**
   * Poll for tasks and execute them
   */
  private async pollAndExecuteTasks(): Promise<void> {
    try {
      // Check if we have capacity for more tasks
      const availableSlots = this.config.maxConcurrentTasks - this.activeTasks.size
      if (availableSlots <= 0) {
        logger.debug('No available task slots', {
          active: this.activeTasks.size,
          max: this.config.maxConcurrentTasks,
        })
        return
      }

      // Get pending tasks
      const tasks = await this.apiClient.getTasks(availableSlots)

      if (tasks.length === 0) {
        logger.debug('No pending tasks')
        return
      }

      logger.info(`Found ${tasks.length} pending tasks`, {
        availableSlots,
        tasks: tasks.map(t => ({ id: t.id, type: t.type })),
      })

      // Execute tasks in parallel (up to available slots)
      const tasksToExecute = tasks.slice(0, availableSlots)
      await Promise.allSettled(
        tasksToExecute.map(task => this.executeTask(task))
      )
    } catch (error) {
      logger.error('Error in task polling', { error })
    }
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: AgentTask): Promise<void> {
    logger.info('Executing task', { taskId: task.id, type: task.type })

    try {
      // Claim the task
      const claimedTask = await this.apiClient.claimTask(task.id)
      if (!claimedTask) {
        logger.debug('Task already claimed by another agent', { taskId: task.id })
        return
      }

      // Add to active tasks
      this.activeTasks.add(task.id)

      // Send task_started signal
      await this.apiClient.sendSignal({
        type: 'task_started',
        payload: {
          taskId: task.id,
          taskType: task.type,
        },
      })

      // Execute the task
      const result = await this.taskExecutor.execute(claimedTask)

      // Mark as complete
      await this.apiClient.completeTask(task.id, result)

      // Send task_completed signal
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
      logger.error('Task execution failed', {
        taskId: task.id,
        type: task.type,
        error: error.message,
      })

      // Mark as failed
      await this.apiClient.failTask(task.id, error.message, true)

      // Send task_failed signal
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
      // Remove from active tasks
      this.activeTasks.delete(task.id)
    }
  }

  /**
   * Get health status for health check endpoint
   */
  private getHealthStatus() {
    const context = this.apiClient.getWorkspaceContext()

    return {
      status: this.isRunning && !this.isShuttingDown ? 'healthy' : 'unhealthy',
      workspaceId: context.workspaceId,
      workspaceName: context.workspaceName,
      agentId: context.agentId,
      activeTasks: this.activeTasks.size,
      maxConcurrentTasks: this.config.maxConcurrentTasks,
      configVersion: this.backendConfig?.version || null,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    }
  }
}