/**
 * Authenticated HTTP client for making requests to the adno backend
 * Automatically includes Authorization header from TaskContext
 */
import { http, type FetchOptions } from './fetch-helper'
import type { TaskContext } from '../runtime/TaskExecutor'

export class AuthenticatedHttpClient {
  private baseURL: string
  private apiKey: string

  constructor(context: TaskContext) {
    this.baseURL = context.config.apiUrl
    this.apiKey = context.config.apiKey
  }

  /**
   * Get default options with authentication
   */
  private getOptions(options: FetchOptions = {}): FetchOptions {
    return {
      ...options,
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        ...options.headers,
      },
    }
  }

  /**
   * Make GET request with authentication
   */
  async get<T = any>(url: string, options: FetchOptions = {}): Promise<T> {
    return http.get<T>(url, this.getOptions(options))
  }

  /**
   * Make POST request with authentication
   */
  async post<T = any>(url: string, data?: any, options: FetchOptions = {}): Promise<T> {
    return http.post<T>(url, data, this.getOptions(options))
  }

  /**
   * Make PUT request with authentication
   */
  async put<T = any>(url: string, data?: any, options: FetchOptions = {}): Promise<T> {
    return http.put<T>(url, data, this.getOptions(options))
  }

  /**
   * Make PATCH request with authentication
   */
  async patch<T = any>(url: string, data?: any, options: FetchOptions = {}): Promise<T> {
    return http.patch<T>(url, data, this.getOptions(options))
  }

  /**
   * Make DELETE request with authentication
   */
  async delete<T = any>(url: string, options: FetchOptions = {}): Promise<T> {
    return http.delete<T>(url, this.getOptions(options))
  }
}

/**
 * Factory function to create authenticated HTTP client from context
 */
export function createAuthenticatedClient(context: TaskContext): AuthenticatedHttpClient {
  return new AuthenticatedHttpClient(context)
}
