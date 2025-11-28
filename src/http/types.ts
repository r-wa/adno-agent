/**
 * Core HTTP client interface
 * All HTTP implementations and decorators must implement this interface
 */
export interface HttpClient {
  request<T>(path: string, options?: RequestInit): Promise<T>
}

/**
 * Circuit breaker policy interface
 * Provides fault tolerance and fail-fast behavior
 */
export interface CircuitBreakerPolicy {
  execute<T>(fn: () => Promise<T>): Promise<T>
  getState(): string
  getStats(): CircuitBreakerStats
  reset(): void
}

/**
 * Circuit breaker statistics
 */
export interface CircuitBreakerStats {
  state: string
  failureCount: number
  successCount: number
  nextAttemptTime: string | null
}

/**
 * Retry policy interface
 * Handles transient failures with configurable retry logic
 */
export interface RetryPolicy {
  execute<T>(fn: () => Promise<T>): Promise<T>
}

/**
 * Circuit breaker configuration
 * Re-export from utils for convenience
 */
export interface CircuitBreakerConfig {
  failureThreshold: number
  recoveryTimeoutMs: number
  successThreshold: number
  timeoutMs: number
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxRetries: number
  backoffMs: number
}
