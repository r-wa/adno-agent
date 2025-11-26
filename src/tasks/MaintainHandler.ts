/**
 * MaintainHandler - Handles log cleanup and maintenance tasks
 *
 * Cleans up old log files based on retention policy.
 * Supports both Pino app logs (logs/app/) and NSSM service logs (logs/nssm/).
 */

import type { TaskHandler, TaskContext } from '../runtime/TaskExecutor'
import type { AgentTask } from '../api/BackendApiClient'
import { logger, getLogDirectory } from '../utils/logger'
import * as fs from 'fs'
import * as path from 'path'

interface MaintainPayload {
  retention_days?: number
}

/**
 * Handler for MAINTAIN tasks - cleans up old log files
 */
export class MaintainHandler implements TaskHandler {
  async execute(task: AgentTask, context: TaskContext): Promise<Record<string, any>> {
    logger.info('Starting maintenance', { taskId: task.id })

    try {
      const payload = task.payload as MaintainPayload
      const retentionDays = payload.retention_days || 7

      // Get log directories to clean
      const appLogDir = getLogDirectory() // logs/app/
      const nssmLogDir = path.join(path.dirname(appLogDir), 'nssm') // logs/nssm/

      let totalDeleted = 0
      let totalBytes = 0

      // Clean app logs (Pino)
      const appResult = await this.cleanDirectory(appLogDir, retentionDays)
      totalDeleted += appResult.deleted
      totalBytes += appResult.bytes

      // Clean NSSM logs if directory exists
      if (fs.existsSync(nssmLogDir)) {
        const nssmResult = await this.cleanDirectory(nssmLogDir, retentionDays)
        totalDeleted += nssmResult.deleted
        totalBytes += nssmResult.bytes
      }

      logger.info('Maintenance completed', {
        deleted: totalDeleted,
        bytesFreed: totalBytes,
        retentionDays,
      })

      return {
        deleted: totalDeleted,
        bytes_freed: totalBytes,
        retention_days: retentionDays,
        success: true,
      }
    } catch (error: any) {
      logger.error('Maintenance failed', { error: error.message })
      throw error
    }
  }

  /**
   * Clean old files from a directory
   */
  private async cleanDirectory(
    dirPath: string,
    retentionDays: number
  ): Promise<{ deleted: number; bytes: number }> {
    let deleted = 0
    let bytes = 0

    try {
      if (!fs.existsSync(dirPath)) {
        return { deleted, bytes }
      }

      const files = fs.readdirSync(dirPath)
      const now = Date.now()
      const maxAge = retentionDays * 24 * 60 * 60 * 1000 // Convert days to ms

      for (const file of files) {
        const filePath = path.join(dirPath, file)

        try {
          const stats = fs.statSync(filePath)

          // Skip directories
          if (stats.isDirectory()) {
            continue
          }

          // Check if file is older than retention period
          const age = now - stats.mtimeMs
          if (age > maxAge) {
            // Delete the file
            fs.unlinkSync(filePath)
            deleted++
            bytes += stats.size

            logger.debug('Deleted old log file', {
              file,
              ageHours: Math.round(age / 3600000),
              size: stats.size,
            })
          }
        } catch (fileError: any) {
          logger.warn('Failed to process file', {
            file,
            error: fileError.message,
          })
        }
      }
    } catch (error: any) {
      logger.error('Failed to clean directory', {
        dir: dirPath,
        error: error.message,
      })
    }

    return { deleted, bytes }
  }
}
