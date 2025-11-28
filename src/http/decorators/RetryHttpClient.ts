import type { HttpClient, RetryPolicy } from '../types'
import { getErrorStatus, getErrorMessage } from '../../utils/HttpError'
import { logger } from '../../utils/logger'

/**
 * HTTP client decorator that adds retry logic
 * Wraps another HttpClient and retries failed requests according to policy
 */
export class RetryHttpClient implements HttpClient {
  constructor(
    private readonly innerClient: HttpClient,
    private readonly retryPolicy: RetryPolicy
  ) {}

  async request<T>(path: string, options?: RequestInit): Promise<T> {
    return this.retryPolicy.execute(() =>
      this.innerClient.request<T>(path, options)
    )
  }
}

/**
 * Exponential backoff retry policy
 * Retries failed requests with increasing delays
 */
export class ExponentialBackoffRetryPolicy implements RetryPolicy {
  constructor(
    private readonly maxRetries: number = 3,
    private readonly backoffMs: number = 1000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown = null

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error: unknown) {
        lastError = error
        const status = getErrorStatus(error)

        // Don't retry on 4xx errors (except 429 rate limit)
        if (status && status >= 400 && status < 500 && status !== 429) {
          throw error
        }

        if (attempt < this.maxRetries) {
          const delay = this.backoffMs * Math.pow(2, attempt - 1)
          logger.warn(`Retrying after ${delay}ms (attempt ${attempt}/${this.maxRetries})`, {
            error: getErrorMessage(error),
          })
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError
  }
}
