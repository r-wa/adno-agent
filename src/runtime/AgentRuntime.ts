import type { AgentConfig } from '../config'
import { BackendApiClient, type AgentTask, type AgentConfigResponse, type WorkspaceConfigResponse, type WorkerSettings, type CreateTaskRequest } from '../api/BackendApiClient'
import { HttpClientFactory } from '../http/HttpClientFactory'
import { InMemoryConfigVersionStore } from '../state/ConfigVersionStore'
import { TaskExecutor } from './TaskExecutor'
import { VersionChecker } from '../version/VersionChecker'
import { logger, setLogLevel, getLogLevel } from '../utils/logger'
import { getErrorMessage } from '../utils/HttpError'

type WorkerType = 'fetcher' | 'suggestion' | 'apply' | 'logger' | 'maintain'

/**
 * Main agent runtime that manages task polling, execution, and lifecycle
 *
 * Architecture:
 * - Heartbeat: 30s/60s/2m - Health signals only
 * - Task Poll: 5m/15m/60m - Check queue + config piggyback
 * - Worker Schedulers: Per-worker intervals for creating tasks
 */
export class AgentRuntime {
  private config: AgentConfig
  private apiClient: BackendApiClient
  private taskExecutor: TaskExecutor
  private versionChecker: VersionChecker

  private isRunning: boolean = false
  private isShuttingDown: boolean = false

  // Separate intervals for different concerns
  private heartbeatInterval: NodeJS.Timeout | null = null
  private taskPollInterval: NodeJS.Timeout | null = null
  private workerSchedulers: Map<WorkerType, NodeJS.Timeout> = new Map()

  private backendConfig: AgentConfigResponse | null = null
  private workspaceConfig: WorkspaceConfigResponse | null = null
  private activeTasks: Set<string> = new Set()

  // Exponential backoff state for polling failures
  private consecutivePollingFailures: number = 0
  private currentTaskPollIntervalMs: number = 0

  // Stuck detection timestamps
  private lastPollTime: number = 0
  private lastHeartbeatTime: number = 0

  // Task cancellation controllers
  private activeTaskControllers: Map<string, AbortController> = new Map()

  constructor(config: AgentConfig) {
    this.config = config

    // Create HTTP client with decorator chain (logging → circuit breaker → retry → fetch)
    const httpClient = HttpClientFactory.createResilientClient({
      baseURL: config.apiUrl,
      apiKey: config.apiKey,
      timeoutMs: 30000,
      circuitBreaker: {
        failureThreshold: 5,
        recoveryTimeoutMs: 60000,
        successThreshold: 2,
        timeoutMs: 30000,
      },
      retry: {
        maxRetries: 3,
        backoffMs: 1000,
      },
    })

    // Create config version store
    const configVersionStore = new InMemoryConfigVersionStore()

    // Create API client with injected dependencies
    this.apiClient = new BackendApiClient(httpClient, configVersionStore)

    this.taskExecutor = new TaskExecutor(config, this.apiClient)
    this.versionChecker = new VersionChecker(config)
    // Default task poll interval (will be updated from backend config)
    this.currentTaskPollIntervalMs = 300000 // 5 minutes default
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
      this.startTaskPolling()
      this.startWorkerSchedulers()

      logger.info('Agent runtime started successfully')
    } catch (error) {
      // Error already logged at the source (e.g., BackendApiClient.authenticate())
      // Just re-throw to propagate up the stack
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
    if (this.taskPollInterval) {
      clearInterval(this.taskPollInterval)
    }
    // Clear all worker schedulers
    for (const [workerType, interval] of this.workerSchedulers.entries()) {
      clearInterval(interval)
      logger.debug('Stopped worker scheduler', { workerType })
    }
    this.workerSchedulers.clear()

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

    this.applyConfig(config)
  }

  /**
   * Apply configuration changes
   * Called on startup and when config changes via piggyback
   */
  private applyConfig(config: AgentConfigResponse): void {
    const isInitial = !this.backendConfig
    const oldConfig = this.backendConfig
    this.backendConfig = config

    // Get enabled workers for logging
    const enabledWorkers = Object.entries(config.workers)
      .filter(([_, settings]) => settings.enabled)
      .map(([name]) => name)

    logger.info('Configuration applied', {
      version: config.version,
      heartbeatIntervalMs: config.heartbeat_interval_ms,
      taskPollIntervalMs: config.task_poll_interval_ms,
      maxConcurrentTasks: config.max_concurrent_tasks,
      enabledWorkers,
    })

    this.versionChecker.checkVersion(config.version_info)

    // Update intervals if changed
    if (!isInitial) {
      this.updateIntervals(config, oldConfig)
      this.updateWorkerSchedulers(config.workers, oldConfig?.workers)
    }

    this.updateWorkerSettings(config.workers)
  }

  /**
   * Update polling intervals based on backend config
   */
  private updateIntervals(config: AgentConfigResponse, oldConfig: AgentConfigResponse | null): void {
    // Update heartbeat interval
    const oldHeartbeat = oldConfig?.heartbeat_interval_ms ?? this.config.heartbeatIntervalMs
    if (config.heartbeat_interval_ms !== oldHeartbeat) {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval)
      }
      this.config.heartbeatIntervalMs = config.heartbeat_interval_ms
      this.startHeartbeat()
      logger.info('Updated heartbeat interval', { intervalMs: config.heartbeat_interval_ms })
    }

    // Update task poll interval (global setting)
    const oldTaskPoll = oldConfig?.task_poll_interval_ms ?? this.currentTaskPollIntervalMs
    if (config.task_poll_interval_ms !== oldTaskPoll) {
      if (this.taskPollInterval) {
        clearInterval(this.taskPollInterval)
      }
      this.currentTaskPollIntervalMs = config.task_poll_interval_ms
      this.startTaskPolling()
      logger.info('Updated task poll interval', { intervalMs: config.task_poll_interval_ms })
    }

    // Update max concurrent tasks
    if (config.max_concurrent_tasks !== oldConfig?.max_concurrent_tasks) {
      this.config.maxConcurrentTasks = config.max_concurrent_tasks
      logger.info('Updated max concurrent tasks', { maxConcurrent: config.max_concurrent_tasks })
    }
  }

  /**
   * Update worker schedulers when worker settings change
   */
  private updateWorkerSchedulers(workers: WorkerSettings, oldWorkers?: WorkerSettings): void {
    const workerTypes: WorkerType[] = ['fetcher', 'logger', 'maintain']

    for (const workerType of workerTypes) {
      const settings = workers[workerType]
      const oldSettings = oldWorkers?.[workerType]

      // Check if we need to restart this worker's scheduler
      const wasEnabled = oldSettings?.enabled ?? false
      const isEnabled = settings.enabled
      const oldInterval = this.getScheduleInterval(oldSettings)
      const newInterval = this.getScheduleInterval(settings)

      if (!isEnabled && wasEnabled) {
        // Worker was disabled - stop scheduler
        this.stopWorkerScheduler(workerType)
      } else if (isEnabled && !wasEnabled) {
        // Worker was enabled - start scheduler
        this.startWorkerScheduler(workerType, newInterval)
      } else if (isEnabled && newInterval !== oldInterval) {
        // Interval changed - restart scheduler
        this.stopWorkerScheduler(workerType)
        this.startWorkerScheduler(workerType, newInterval)
      }
    }
  }

  /**
   * Get schedule interval from worker settings
   * Not all workers have schedule_interval_ms (e.g., suggestion, apply)
   */
  private getScheduleInterval(settings: { enabled: boolean; schedule_interval_ms?: number } | undefined): number {
    if (!settings || !('schedule_interval_ms' in settings)) {
      return 0
    }
    return settings.schedule_interval_ms ?? 0
  }

  /**
   * Update worker settings from backend config
   */
  private updateWorkerSettings(workers: WorkerSettings): void {
    // Update log level if logger worker settings changed
    if (workers.logger.enabled) {
      const currentLevel = getLogLevel()
      const newLevel = workers.logger.log_level
      if (currentLevel !== newLevel) {
        setLogLevel(newLevel)
      }
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
   * Start polling for tasks
   * Uses task_poll_interval_ms from config
   */
  private startTaskPolling(): void {
    // Use backend config if available, otherwise use default
    const intervalMs = this.backendConfig?.task_poll_interval_ms ?? this.currentTaskPollIntervalMs

    this.taskPollInterval = setInterval(async () => {
      if (this.isRunning && !this.isShuttingDown) {
        await this.pollAndExecuteTasks()
      }
    }, intervalMs)

    logger.info('Task polling started', { intervalMs })

    // Initial poll
    this.pollAndExecuteTasks()
  }

  /**
   * Start all worker schedulers based on config
   */
  private startWorkerSchedulers(): void {
    if (!this.backendConfig) {
      logger.warn('Cannot start worker schedulers without config')
      return
    }

    const workers = this.backendConfig.workers

    // Start scheduler for each enabled worker that has a schedule
    if (workers.fetcher.enabled) {
      this.startWorkerScheduler('fetcher', workers.fetcher.schedule_interval_ms)
    }
    if (workers.logger.enabled) {
      this.startWorkerScheduler('logger', workers.logger.schedule_interval_ms)
    }
    if (workers.maintain.enabled) {
      this.startWorkerScheduler('maintain', workers.maintain.schedule_interval_ms)
    }

    // Note: suggestion and apply workers don't have schedulers
    // They respond to tasks created by other processes (e.g., vote triggers)
  }

  /**
   * Start a scheduler for a specific worker type
   */
  private startWorkerScheduler(workerType: WorkerType, intervalMs: number): void {
    if (this.workerSchedulers.has(workerType)) {
      logger.warn('Worker scheduler already running', { workerType })
      return
    }

    logger.info('Starting worker scheduler', { workerType, intervalMs })

    const scheduler = setInterval(async () => {
      if (this.isRunning && !this.isShuttingDown) {
        await this.createScheduledTask(workerType)
      }
    }, intervalMs)

    this.workerSchedulers.set(workerType, scheduler)

    // Create initial task immediately
    this.createScheduledTask(workerType)
  }

  /**
   * Stop a worker scheduler
   */
  private stopWorkerScheduler(workerType: WorkerType): void {
    const scheduler = this.workerSchedulers.get(workerType)
    if (scheduler) {
      clearInterval(scheduler)
      this.workerSchedulers.delete(workerType)
      logger.info('Stopped worker scheduler', { workerType })
    }
  }

  /**
   * Create a scheduled task for a worker
   * Deduplication is handled by the backend (returns 'already_pending' if task exists)
   */
  private async createScheduledTask(workerType: WorkerType): Promise<void> {
    try {
      const request: CreateTaskRequest = {
        type: workerType,
        priority: 'normal',
      }

      const response = await this.apiClient.createTask(request)

      if (response) {
        if (response.status === 'pending') {
          logger.info('Scheduled task created', { workerType, taskId: response.task_id })
        } else {
          logger.debug('Task already pending', { workerType, taskId: response.task_id })
        }
      }
    } catch (error) {
      logger.error('Failed to create scheduled task', { workerType, error })
    }
  }

  /**
   * Restart task polling with exponential backoff on failures
   */
  private restartTaskPollingWithBackoff(): void {
    if (this.taskPollInterval) {
      clearInterval(this.taskPollInterval)
    }

    const baseDelay = this.backendConfig?.task_poll_interval_ms ?? this.currentTaskPollIntervalMs
    const maxDelay = 3600000 // 1 hour max
    const backoffDelay = Math.min(baseDelay * Math.pow(2, this.consecutivePollingFailures), maxDelay)

    this.currentTaskPollIntervalMs = backoffDelay

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
    const normalInterval = this.backendConfig?.task_poll_interval_ms ?? 300000
    if (this.currentTaskPollIntervalMs !== normalInterval) {
      logger.info('Resetting task polling to normal interval', {
        intervalMs: normalInterval,
      })

      this.currentTaskPollIntervalMs = normalInterval

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
      logger.debug('Sending heartbeat...')
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
      logger.debug('Heartbeat sent', { success: sent })

      this.lastHeartbeatTime = Date.now()
    } catch (error) {
      logger.error('Failed to send heartbeat', { error })
    }
  }

  /**
   * Poll for tasks and execute them
   * Also handles config updates via piggyback
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

      // Get tasks with potential config piggyback
      const response = await this.apiClient.getTasks(availableSlots)

      // Handle config update if piggybacked
      if (response.config) {
        logger.info('Received config update via piggyback', { version: response.config.version })
        this.applyConfig(response.config)
      }

      const tasks = response.tasks

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
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error)

      if (abortController.signal.aborted) {
        logger.warn('Task execution cancelled', {
          taskId: task.id,
          type: task.type,
        })
        await this.apiClient.failTask(task.id, 'Task cancelled during shutdown', false)
        return
      }

      logger.error({ err: error, taskId: task.id, type: task.type }, 'Task execution failed')

      await this.apiClient.failTask(task.id, errorMessage, true)

      await this.apiClient.sendSignal({
        type: 'task_failed',
        severity: 'error',
        message: errorMessage,
        payload: {
          taskId: task.id,
          taskType: task.type,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
      })
    } finally {
      this.activeTasks.delete(task.id)
      this.activeTaskControllers.delete(task.id)
    }
  }

}
