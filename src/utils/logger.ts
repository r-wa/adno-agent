/**
 * Simple structured logger for the agent
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  data?: any
}

class Logger {
  private logLevel: LogLevel = 'info'
  private logFormat: 'json' | 'text' = 'json'

  constructor() {
    this.logLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'
    this.logFormat = (process.env.LOG_FORMAT as any) || 'json'
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error']
    return levels.indexOf(level) >= levels.indexOf(this.logLevel)
  }

  private formatLog(level: LogLevel, message: string, data?: any): string {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    }

    if (this.logFormat === 'json') {
      return JSON.stringify(entry)
    }

    // Text format
    const dataStr = data ? ` ${JSON.stringify(data)}` : ''
    return `[${entry.timestamp}] ${level.toUpperCase()}: ${message}${dataStr}`
  }

  debug(message: string, data?: any) {
    if (this.shouldLog('debug')) {
      console.debug(this.formatLog('debug', message, data))
    }
  }

  info(message: string, data?: any) {
    if (this.shouldLog('info')) {
      console.info(this.formatLog('info', message, data))
    }
  }

  warn(message: string, data?: any) {
    if (this.shouldLog('warn')) {
      console.warn(this.formatLog('warn', message, data))
    }
  }

  error(message: string, data?: any) {
    if (this.shouldLog('error')) {
      console.error(this.formatLog('error', message, data))
    }
  }
}

export const logger = new Logger()