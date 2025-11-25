/**
 * Production-grade structured logger using Pino
 * Provides compatibility wrapper for the old logger API
 */
import pino from 'pino'
import { createStream } from 'rotating-file-stream'
import * as path from 'path'

// Determine log level from environment
const logLevel = (process.env.LOG_LEVEL as pino.Level) || 'info'

// Detect if running inside pkg bundle or production environment
// process.pkg is defined when code runs inside a pkg-bundled executable
const isPkgBundle = (process as any).pkg !== undefined
const isProduction = process.env.NODE_ENV === 'production'

// Check if file logging is requested
const logFilePath = process.env.LOG_FILE

// Only use pino-pretty transport in development (not in pkg bundles)
// pkg cannot bundle Worker Thread-based transports correctly
const usePrettyPrint = !isPkgBundle && !isProduction && process.env.LOG_FORMAT !== 'json' && !logFilePath

/**
 * Create rotating file stream for production logging
 */
function createRotatingFileStream() {
  if (!logFilePath) {
    return undefined
  }

  try {
    const logDir = path.dirname(logFilePath)
    const logFileName = path.basename(logFilePath)

    // Create rotating stream with daily rotation and max 10 files
    const stream = createStream(logFileName, {
      path: logDir,
      size: '10M',          // Rotate every 10MB
      interval: '1d',       // Rotate daily
      maxFiles: 10,         // Keep max 10 files
      compress: 'gzip',     // Compress rotated files
    })

    console.log(`[Logger] File logging enabled: ${logFilePath}`)
    return stream
  } catch (error: any) {
    console.warn(`[Logger] Failed to create rotating file stream: ${error.message}`)
    return undefined
  }
}

/**
 * Create pino logger with graceful fallback
 * If logger initialization fails, falls back to basic JSON logging
 */
function createLogger(): pino.Logger {
  const fileStream = createRotatingFileStream()

  try {
    const baseConfig = {
      level: logLevel,

      base: {
        pid: process.pid,
        hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
      },

      timestamp: () => {
        const now = new Date()
        const hours = now.getHours().toString().padStart(2, '0')
        const minutes = now.getMinutes().toString().padStart(2, '0')
        const seconds = now.getSeconds().toString().padStart(2, '0')
        const ms = now.getMilliseconds().toString().padStart(3, '0')
        return `,"time":"${hours}:${minutes}:${seconds}.${ms}"`
      },
    }

    if (fileStream) {
      return pino(baseConfig, fileStream)
    }

    if (usePrettyPrint) {
      return pino({
        ...baseConfig,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
            singleLine: false,
          },
        },
      })
    }

    // Production/Service mode: split stdout/stderr by log level
    // Info/debug/warn → stdout (captured by NSSM as agent.log)
    // Error/fatal → stderr (captured by NSSM as agent-error.log)
    return pino(baseConfig, pino.multistream([
      { level: 'trace', stream: process.stdout },
      { level: 'error', stream: process.stderr },
    ]))
  } catch (error: any) {
    console.warn('[Logger] Failed to initialize with transport, falling back to JSON output:', error.message)

    return pino({
      level: logLevel,
      base: {
        pid: process.pid,
        hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
      },
      timestamp: () => {
        const now = new Date()
        const hours = now.getHours().toString().padStart(2, '0')
        const minutes = now.getMinutes().toString().padStart(2, '0')
        const seconds = now.getSeconds().toString().padStart(2, '0')
        const ms = now.getMilliseconds().toString().padStart(3, '0')
        return `,"time":"${hours}:${minutes}:${seconds}.${ms}"`
      },
    })
  }
}

// Create the logger instance
const pinoLogger = createLogger()

/**
 * Flush logs synchronously before process exit
 * This ensures buffered logs are written to stdout/stderr before termination
 */
export function flushLogs(): void {
  try {
    // pino.flush() is synchronous when using multistream
    if (typeof pinoLogger.flush === 'function') {
      pinoLogger.flush()
    }
  } catch {
    // Ignore flush errors during shutdown
  }
}

/**
 * Compatibility wrapper for the old logger API
 * Supports both old API (message, data) and pino API (data, message)
 */
export const logger = {
  debug(messageOrData: string | object, dataOrMessage?: object | string) {
    if (typeof messageOrData === 'string') {
      // Old API: logger.debug('message', { data })
      pinoLogger.debug(dataOrMessage || {}, messageOrData)
    } else {
      // Pino API: logger.debug({ data }, 'message')
      pinoLogger.debug(messageOrData, dataOrMessage as string)
    }
  },

  info(messageOrData: string | object, dataOrMessage?: object | string) {
    if (typeof messageOrData === 'string') {
      // Old API: logger.info('message', { data })
      pinoLogger.info(dataOrMessage || {}, messageOrData)
    } else {
      // Pino API: logger.info({ data }, 'message')
      pinoLogger.info(messageOrData, dataOrMessage as string)
    }
  },

  warn(messageOrData: string | object, dataOrMessage?: object | string) {
    if (typeof messageOrData === 'string') {
      // Old API: logger.warn('message', { data })
      pinoLogger.warn(dataOrMessage || {}, messageOrData)
    } else {
      // Pino API: logger.warn({ data }, 'message')
      pinoLogger.warn(messageOrData, dataOrMessage as string)
    }
  },

  error(messageOrData: string | object, dataOrMessage?: object | string) {
    if (typeof messageOrData === 'string') {
      // Old API: logger.error('message', { data })
      pinoLogger.error(dataOrMessage || {}, messageOrData)
    } else {
      // Pino API: logger.error({ data }, 'message')
      pinoLogger.error(messageOrData, dataOrMessage as string)
    }
  },
}

// Export default for compatibility
export default logger
