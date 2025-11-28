import { logger } from './logger'
import { getErrorStatus } from './HttpError'

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Circuit is open, failing fast
  HALF_OPEN = 'HALF_OPEN' // Testing if service has recovered
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number
  /** Time in ms to wait before attempting recovery (OPEN → HALF_OPEN) */
  recoveryTimeoutMs: number
  /** Number of successful calls in HALF_OPEN before closing circuit */
  successThreshold: number
  /** Timeout in ms for each request */
  timeoutMs: number
}

/**
 * Circuit breaker error thrown when circuit is open
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string = 'Circuit breaker is OPEN') {
    super(message)
    this.name = 'CircuitBreakerOpenError'
  }
}

/**
 * Circuit breaker pattern implementation
 * Prevents cascading failures by failing fast when backend is down
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED
  private failureCount: number = 0
  private successCount: number = 0
  private nextAttemptTime: number = 0
  private config: CircuitBreakerConfig

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      recoveryTimeoutMs: config.recoveryTimeoutMs ?? 60000, // 1 minute
      successThreshold: config.successThreshold ?? 2,
      timeoutMs: config.timeoutMs ?? 30000, // 30 seconds
    }
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttemptTime) {
        throw new CircuitBreakerOpenError(
          `Circuit breaker is OPEN. Next attempt at ${new Date(this.nextAttemptTime).toISOString()}`
        )
      }

      this.state = CircuitState.HALF_OPEN
      this.successCount = 0
      logger.info('Circuit breaker transitioning to HALF_OPEN for recovery attempt')
    }

    try {
      const result = await this.executeWithTimeout(fn, this.config.timeoutMs)

      this.onSuccess()

      return result
    } catch (error) {
      const status = getErrorStatus(error)

      // Only record 5xx errors and network failures as circuit breaker failures
      // Skip 4xx client errors (not transient failures)
      if (!status || status >= 500) {
        this.onFailure(error)
      }

      throw error
    }
  }

  /**
   * Execute function with timeout
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Circuit breaker timeout')), timeoutMs)
    })

    return Promise.race([fn(), timeoutPromise])
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.failureCount = 0

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++

      if (this.successCount >= this.config.successThreshold) {
        // Enough successes - close the circuit
        this.state = CircuitState.CLOSED
        this.successCount = 0
        logger.info('Circuit breaker transitioned to CLOSED (service recovered)')
      } else {
        logger.debug('Circuit breaker in HALF_OPEN', {
          successCount: this.successCount,
          successThreshold: this.config.successThreshold,
        })
      }
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(error: any): void {
    this.failureCount++

    logger.warn('Circuit breaker recorded failure', {
      state: this.state,
      failureCount: this.failureCount,
      failureThreshold: this.config.failureThreshold,
      error: error.message,
    })

    if (this.state === CircuitState.HALF_OPEN) {
      // Failed during recovery - reopen circuit
      this.tripCircuit()
    } else if (this.failureCount >= this.config.failureThreshold) {
      // Too many failures - open circuit
      this.tripCircuit()
    }
  }

  /**
   * Trip (open) the circuit
   */
  private tripCircuit(): void {
    this.state = CircuitState.OPEN
    this.failureCount = 0
    this.successCount = 0
    this.nextAttemptTime = Date.now() + this.config.recoveryTimeoutMs

    logger.error('Circuit breaker OPEN - failing fast', {
      recoveryTimeoutMs: this.config.recoveryTimeoutMs,
      nextAttemptTime: new Date(this.nextAttemptTime).toISOString(),
    })
  }

  /**
   * Get current circuit breaker state
   */
  getState(): CircuitState {
    return this.state
  }

  /**
   * Get circuit breaker stats
   */
  getStats() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      nextAttemptTime: this.nextAttemptTime > 0 ? new Date(this.nextAttemptTime).toISOString() : null,
    }
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this.state = CircuitState.CLOSED
    this.failureCount = 0
    this.successCount = 0
    this.nextAttemptTime = 0
    logger.info('Circuit breaker manually reset to CLOSED')
  }
}
