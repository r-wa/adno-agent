/**
 * LogCollector - Collects and tracks log entries for transfer to the server
 *
 * Reads Pino JSON log files and tracks read position to avoid duplicates.
 * Provides batches of log entries for the LoggerHandler to send.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { getLogDirectory, getLogFilePath } from '../utils/logger'

export interface LogEntry {
  level: number
  time: string
  msg: string
  pid?: number
  hostname?: string
  [key: string]: any
}

export interface ParsedLogEntry {
  severity: 'debug' | 'info' | 'warn' | 'error'
  message: string
  timestamp: string
  metadata?: Record<string, any>
}

// Pino log levels mapping
const PINO_LEVELS: Record<number, 'debug' | 'info' | 'warn' | 'error'> = {
  10: 'debug', // trace
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'error', // fatal
}

export class LogCollector {
  private logDir: string
  private currentLogFile: string
  private lastReadPosition: number = 0
  private lastReadInode: number | null = null

  constructor() {
    this.logDir = getLogDirectory()
    this.currentLogFile = getLogFilePath()
  }

  /**
   * Collect new log entries since last read
   * Returns parsed log entries ready for transfer
   */
  async collectLogs(maxEntries: number = 100): Promise<ParsedLogEntry[]> {
    const entries: ParsedLogEntry[] = []

    try {
      // Check if log file exists
      if (!fs.existsSync(this.currentLogFile)) {
        return entries
      }

      // Get file stats to detect rotation
      const stats = fs.statSync(this.currentLogFile)
      const currentInode = stats.ino

      // If inode changed, file was rotated - start from beginning
      if (this.lastReadInode !== null && this.lastReadInode !== currentInode) {
        this.lastReadPosition = 0
      }
      this.lastReadInode = currentInode

      // If position is beyond file size, file was truncated - start from beginning
      if (this.lastReadPosition > stats.size) {
        this.lastReadPosition = 0
      }

      // Read new content from last position
      const newEntries = await this.readLogFile(this.lastReadPosition, maxEntries)

      for (const entry of newEntries) {
        const parsed = this.parseLogEntry(entry.content)
        if (parsed) {
          entries.push(parsed)
        }
        // Update position after each entry
        this.lastReadPosition = entry.endPosition
      }

    } catch (error: any) {
      console.error(`[LogCollector] Error collecting logs: ${error.message}`)
    }

    return entries
  }

  /**
   * Read log file from position, returning raw entries with their end positions
   */
  private async readLogFile(
    startPosition: number,
    maxEntries: number
  ): Promise<Array<{ content: string; endPosition: number }>> {
    return new Promise((resolve, reject) => {
      const entries: Array<{ content: string; endPosition: number }> = []

      const stream = fs.createReadStream(this.currentLogFile, {
        start: startPosition,
        encoding: 'utf8',
      })

      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      })

      let currentPosition = startPosition

      rl.on('line', (line) => {
        if (line.trim()) {
          currentPosition += Buffer.byteLength(line, 'utf8') + 1 // +1 for newline
          entries.push({
            content: line,
            endPosition: currentPosition,
          })

          if (entries.length >= maxEntries) {
            rl.close()
            stream.destroy()
          }
        }
      })

      rl.on('close', () => {
        resolve(entries)
      })

      rl.on('error', (error) => {
        reject(error)
      })

      stream.on('error', (error) => {
        reject(error)
      })
    })
  }

  /**
   * Parse a Pino JSON log entry into a standardized format
   */
  private parseLogEntry(content: string): ParsedLogEntry | null {
    try {
      const entry: LogEntry = JSON.parse(content)

      // Map Pino level to severity
      const severity = PINO_LEVELS[entry.level] || 'info'

      // Extract message
      const message = entry.msg || ''

      // Build timestamp from entry time or current time
      let timestamp: string
      if (entry.time) {
        // Pino time is usually just HH:MM:ss.mmm, need to add date
        const now = new Date()
        const datePart = now.toISOString().split('T')[0]
        timestamp = entry.time.includes('T') ? entry.time : `${datePart}T${entry.time}Z`
      } else {
        timestamp = new Date().toISOString()
      }

      // Collect additional metadata (excluding standard fields)
      const metadata: Record<string, any> = {}
      const excludeFields = ['level', 'time', 'msg', 'pid', 'hostname', 'v']

      for (const [key, value] of Object.entries(entry)) {
        if (!excludeFields.includes(key)) {
          metadata[key] = value
        }
      }

      return {
        severity,
        message,
        timestamp,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      }
    } catch {
      // Not valid JSON, skip
      return null
    }
  }

  /**
   * Get list of all log files in the log directory
   * Includes rotated files (e.g., agent.log.1.gz)
   */
  getLogFiles(): string[] {
    try {
      if (!fs.existsSync(this.logDir)) {
        return []
      }

      const files = fs.readdirSync(this.logDir)
      return files
        .filter(f => f.startsWith('agent.log') || f.endsWith('.gz'))
        .map(f => path.join(this.logDir, f))
        .sort((a, b) => {
          // Sort by modification time, oldest first
          const statA = fs.statSync(a)
          const statB = fs.statSync(b)
          return statA.mtimeMs - statB.mtimeMs
        })
    } catch (error: any) {
      console.error(`[LogCollector] Error listing log files: ${error.message}`)
      return []
    }
  }

  /**
   * Get statistics about the log collection state
   */
  getStats(): { logDir: string; currentFile: string; lastPosition: number; hasLogs: boolean } {
    return {
      logDir: this.logDir,
      currentFile: this.currentLogFile,
      lastPosition: this.lastReadPosition,
      hasLogs: fs.existsSync(this.currentLogFile),
    }
  }

  /**
   * Reset the read position (useful after manual cleanup)
   */
  resetPosition(): void {
    this.lastReadPosition = 0
    this.lastReadInode = null
  }
}

// Export singleton instance
export const logCollector = new LogCollector()
