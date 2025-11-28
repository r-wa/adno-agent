import type { HttpClient } from './types'
import { HttpError, type ProblemDetails } from '../utils/HttpError'
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

      // RFC 9457 Problem Details response
      if (contentType.includes('application/problem+json')) {
        try {
          const problem: ProblemDetails = JSON.parse(errorText)
          const message = problem.detail
            ? `${problem.title}: ${problem.detail}`
            : problem.title
          throw new HttpError(message, problem.status || response.status, problem)
        } catch (e) {
          if (e instanceof HttpError) throw e
          // Fall through to generic handling if parsing fails
        }
      }

      // Generic JSON error response
      let errorMessage = errorText
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
