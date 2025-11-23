/**
 * Simple fetch helper for making HTTP requests
 * Replacement for axios using native fetch (Node 18+)
 */

export interface FetchOptions extends RequestInit {
  baseURL?: string
  timeout?: number
}

/**
 * Make an HTTP request using native fetch
 */
export async function fetchJson<T = any>(
  url: string,
  options: FetchOptions = {}
): Promise<T> {
  const {
    baseURL,
    timeout = 30000,
    ...fetchOptions
  } = options

  const fullUrl = baseURL ? `${baseURL}${url}` : url

  try {
    const response = await fetch(fullUrl, {
      ...fetchOptions,
      signal: AbortSignal.timeout(timeout),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      const error: any = new Error(`HTTP ${response.status}: ${errorText}`)
      error.status = response.status
      error.response = { status: response.status, data: errorText }
      throw error
    }

    const data = await response.json()
    return data as T
  } catch (error: any) {
    // Re-throw with status if it's a fetch error
    if (error.name === 'AbortError') {
      const timeoutError: any = new Error(`Request timeout after ${timeout}ms`)
      timeoutError.code = 'ETIMEDOUT'
      throw timeoutError
    }
    throw error
  }
}

/**
 * Convenience methods for common HTTP verbs
 */
export const http = {
  get: async <T = any>(url: string, options: FetchOptions = {}): Promise<T> => {
    return fetchJson<T>(url, { ...options, method: 'GET' })
  },

  post: async <T = any>(url: string, data?: any, options: FetchOptions = {}): Promise<T> => {
    return fetchJson<T>(url, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
  },

  put: async <T = any>(url: string, data?: any, options: FetchOptions = {}): Promise<T> => {
    return fetchJson<T>(url, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
  },

  patch: async <T = any>(url: string, data?: any, options: FetchOptions = {}): Promise<T> => {
    return fetchJson<T>(url, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
  },

  delete: async <T = any>(url: string, options: FetchOptions = {}): Promise<T> => {
    return fetchJson<T>(url, { ...options, method: 'DELETE' })
  },
}
