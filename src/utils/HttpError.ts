/**
 * Custom HTTP error class with status code support
 * Used for proper error typing instead of `any` in catch blocks
 */
export class HttpError extends Error {
  status: number
  response?: { status: number }

  constructor(message: string, status: number) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.response = { status }

    // Maintains proper stack trace for where error was thrown (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, HttpError)
    }
  }

  /**
   * Check if an error is an HttpError
   */
  static isHttpError(error: unknown): error is HttpError {
    return error instanceof HttpError
  }
}

/**
 * Type guard to check if an error has message and status properties
 * Useful for narrowing unknown errors in catch blocks
 */
export function isErrorWithStatus(error: unknown): error is { message: string; status?: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  )
}

/**
 * Get error message safely from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'Unknown error'
}

/**
 * Get error status safely from unknown error
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (error instanceof HttpError) {
    return error.status
  }
  if (isErrorWithStatus(error)) {
    return error.status
  }
  return undefined
}
