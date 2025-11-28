import type { HttpClient, CircuitBreakerPolicy } from '../types'

/**
 * HTTP client decorator that adds circuit breaker pattern
 * Prevents cascading failures by failing fast when backend is down
 */
export class CircuitBreakerHttpClient implements HttpClient {
  constructor(
    private readonly innerClient: HttpClient,
    private readonly circuitBreaker: CircuitBreakerPolicy
  ) {}

  async request<T>(path: string, options?: RequestInit): Promise<T> {
    return this.circuitBreaker.execute(() =>
      this.innerClient.request<T>(path, options)
    )
  }

  /**
   * Get current circuit breaker state for monitoring
   */
  getCircuitBreakerState() {
    return this.circuitBreaker.getStats()
  }

  /**
   * Manually reset the circuit breaker
   */
  resetCircuitBreaker() {
    this.circuitBreaker.reset()
  }
}
