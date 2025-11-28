/**
 * RFC 9457 Problem Details for HTTP APIs
 * @see https://www.rfc-editor.org/rfc/rfc9457.html
 */
export interface ProblemDetails {
  title: string
  status: number
  detail?: string
}

/**
 * Custom HTTP error class with RFC 9457 Problem Details support
 * Used for proper error typing instead of `any` in catch blocks
 */
export class HttpError extends Error {
  status: number
  /** RFC 9457: Short, human-readable summary */
  title?: string
  /** RFC 9457: Human-readable explanation specific to this occurrence */
  detail?: string
  response?: { status: number }

  constructor(message: string, status: number, problem?: ProblemDetails) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.title = problem?.title
    this.detail = problem?.detail
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

/**
 * Get RFC 9457 title safely from unknown error
 */
export function getErrorTitle(error: unknown): string | undefined {
  if (error instanceof HttpError) {
    return error.title
  }
  return undefined
}

/**
 * Get RFC 9457 detail safely from unknown error
 */
export function getErrorDetail(error: unknown): string | undefined {
  if (error instanceof HttpError) {
    return error.detail
  }
  return undefined
}

/**
 * Get structured error info for logging (RFC 9457 compatible)
 */
export function getErrorInfo(error: unknown): {
  title?: string
  status?: number
  detail?: string
  message: string
} {
  if (error instanceof HttpError) {
    return {
      title: error.title,
      status: error.status,
      detail: error.detail,
      message: error.message,
    }
  }
  return {
    message: getErrorMessage(error),
  }
}
