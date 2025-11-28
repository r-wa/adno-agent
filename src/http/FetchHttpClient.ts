import type { HttpClient } from './types'
import { HttpError } from '../utils/HttpError'
import { logger } from '../utils/logger'

/**
 * Core HTTP client implementation using native fetch API
 * Handles basic HTTP operations with timeout support
 */
export class FetchHttpClient implements HttpClient {
  constructor(
    private readonly baseURL: string,
    private readonly defaultHeaders: Record<string, string>,
    private readonly timeoutMs: number = 30000
  ) {}

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseURL}${path}`

    logger.debug('HTTP Request', {
      method: options.method || 'GET',
      url: path,
    })

    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.defaultHeaders,
        ...options.headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    logger.debug('HTTP Response', {
      status: response.status,
      url: path,
    })

    if (!response.ok) {
      const contentType = response.headers.get('content-type') || ''
      const errorText = await response.text().catch(() => 'Unknown error')

      let errorMessage = errorText

      // Pretty-print JSON responses for readability
      if (contentType.includes('application/json')) {
        try {
          const errorJson = JSON.parse(errorText)
          errorMessage = JSON.stringify(errorJson, null, 2)
        } catch {
          // Keep original text if JSON parsing fails
        }
      }

      throw new HttpError(`HTTP ${response.status}: ${errorMessage}`, response.status)
    }

    return response.json() as Promise<T>
  }
}
