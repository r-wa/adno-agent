/**
 * LoggerHandler - Transfers collected logs to the server
 *
 * Collects logs from the LogCollector and sends them to the backend
 * via the signal API. This is a polling-based worker that runs periodically.
 */

import type { TaskHandler, TaskContext } from '../runtime/TaskExecutor'
import type { AgentTask } from '../api/BackendApiClient'
import { logger } from '../utils/logger'
import { logCollector, type ParsedLogEntry } from '../services/LogCollector'

const MAX_LOGS_PER_BATCH = 50

/**
 * Handler for LOGGER tasks - transfers logs to the server
 */
export class LoggerHandler implements TaskHandler {
  async execute(task: AgentTask, context: TaskContext): Promise<Record<string, any>> {
    logger.debug('Starting log transfer', { taskId: task.id })

    try {
      // Collect new logs since last transfer
      const logs = await logCollector.collectLogs(MAX_LOGS_PER_BATCH)

      if (logs.length === 0) {
        logger.debug('No new logs to transfer')
        return {
          transferred: 0,
          success: true,
        }
      }

      // Send logs to backend via signals
      const transferred = await this.sendLogs(context, logs)

      logger.debug('Log transfer completed', { transferred })

      return {
        transferred,
        success: true,
      }
    } catch (error: any) {
      logger.error('Log transfer failed', { error: error.message })
      throw error
    }
  }

  /**
   * Send collected logs to the backend via signal API
   */
  private async sendLogs(context: TaskContext, logs: ParsedLogEntry[]): Promise<number> {
    const signals = logs.map(log => ({
      category: 'log' as const,
      type: 'log' as const,
      severity: log.severity,
      message: log.message,
      timestamp: log.timestamp,
      payload: log.metadata,
    }))

    // Send in batches if needed
    const batchSize = 10
    let transferred = 0

    for (let i = 0; i < signals.length; i += batchSize) {
      const batch = signals.slice(i, i + batchSize)

      const success = await context.apiClient.sendSignals(batch)

      if (success) {
        transferred += batch.length
      } else {
        logger.warn('Failed to send log batch', { batchIndex: Math.floor(i / batchSize) })
      }
    }

    return transferred
  }
}
