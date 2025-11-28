import type { HttpClient } from '../types'
import { logger } from '../../utils/logger'
import { getErrorMessage, getErrorStatus } from '../../utils/HttpError'

/**
 * HTTP client decorator that adds error logging
 * Logs failed requests without interfering with normal operation
 */
export class LoggingHttpClient implements HttpClient {
  constructor(private readonly innerClient: HttpClient) {}

  async request<T>(path: string, options?: RequestInit): Promise<T> {
    try {
      const result = await this.innerClient.request<T>(path, options)
      return result
    } catch (error: unknown) {
      const status = getErrorStatus(error)

      // Let application layer handle 4xx errors with context
      // Only log server errors (5xx) and network errors
      if (!status || status >= 500) {
        logger.error('HTTP Request Failed', {
          url: path,
          method: options?.method || 'GET',
          status,
          error: getErrorMessage(error),
        })
      }

      throw error
    }
  }
}
