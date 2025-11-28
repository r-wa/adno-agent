import type { HttpClient, CircuitBreakerConfig, RetryConfig } from './types'
import { FetchHttpClient } from './FetchHttpClient'
import { RetryHttpClient, ExponentialBackoffRetryPolicy } from './decorators/RetryHttpClient'
import { CircuitBreakerHttpClient } from './decorators/CircuitBreakerHttpClient'
import { LoggingHttpClient } from './decorators/LoggingHttpClient'
import { CircuitBreaker } from '../utils/circuit-breaker'

/**
 * Configuration for creating a resilient HTTP client
 */
export interface ResilientHttpClientConfig {
  baseURL: string
  apiKey: string
  timeoutMs?: number
  circuitBreaker?: CircuitBreakerConfig
  retry?: RetryConfig
}

/**
 * Factory for creating HTTP clients with decorator chain
 * Composes multiple decorators to add resilience features
 */
export class HttpClientFactory {
  /**
   * Create a resilient HTTP client with full decorator chain:
   * LoggingHttpClient → CircuitBreakerHttpClient → RetryHttpClient → FetchHttpClient
   */
  static createResilientClient(config: ResilientHttpClientConfig): HttpClient {
    // 1. Core HTTP client (innermost layer)
    const coreClient = new FetchHttpClient(
      config.baseURL,
      {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      config.timeoutMs ?? 30000
    )

    // 2. Wrap with retry policy
    const retryPolicy = new ExponentialBackoffRetryPolicy(
      config.retry?.maxRetries ?? 3,
      config.retry?.backoffMs ?? 1000
    )
    const retryClient = new RetryHttpClient(coreClient, retryPolicy)

    // 3. Wrap with circuit breaker
    const circuitBreaker = new CircuitBreaker({
      failureThreshold: config.circuitBreaker?.failureThreshold ?? 5,
      recoveryTimeoutMs: config.circuitBreaker?.recoveryTimeoutMs ?? 60000,
      successThreshold: config.circuitBreaker?.successThreshold ?? 2,
      timeoutMs: config.circuitBreaker?.timeoutMs ?? 30000,
    })
    const resilientClient = new CircuitBreakerHttpClient(retryClient, circuitBreaker)

    // 4. Wrap with logging (outermost layer)
    return new LoggingHttpClient(resilientClient)
  }
}
