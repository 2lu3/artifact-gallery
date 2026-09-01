import { SESSION_TOKEN_HEADER, type ApiErrorResponse } from '../shared/contracts'

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage)
    this.name = 'ApiRequestError'
  }
}

export class ApiClient {
  private constructor(private readonly sessionToken: string) {}

  static fromTrustedBootstrap(documentRoot: Document = document): ApiClient {
    const element = documentRoot.getElementById('artifact-gallery-bootstrap')
    if (!element) throw new Error('Trusted bootstrap is unavailable.')
    try {
      const bootstrap = JSON.parse(element.textContent ?? '') as { sessionToken?: unknown }
      if (typeof bootstrap.sessionToken !== 'string' || bootstrap.sessionToken.length < 32) {
        throw new Error('Trusted bootstrap is invalid.')
      }
      return new ApiClient(bootstrap.sessionToken)
    } finally {
      element.remove()
    }
  }

  async get<T>(url: string, init: RequestInit = {}): Promise<T> {
    return this.request<T>(url, { ...init, method: 'GET' })
  }

  async post<T>(url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
    return this.request<T>(url, {
      ...init,
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: jsonHeaders(init.headers, body),
    })
  }

  async patch<T>(url: string, body: unknown, init: RequestInit = {}): Promise<T> {
    return this.request<T>(url, {
      ...init,
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: jsonHeaders(init.headers, body),
    })
  }

  async delete(url: string, init: RequestInit = {}): Promise<void> {
    await this.request<never>(url, { ...init, method: 'DELETE' })
  }

  async blob(url: string, init: RequestInit = {}): Promise<Blob> {
    const response = await this.fetch(url, { ...init, method: 'GET' })
    return response.blob()
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetch(url, init)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set(SESSION_TOKEN_HEADER, this.sessionToken)
    const response = await fetch(url, { ...init, headers })
    if (!response.ok) {
      const body = await readErrorResponse(response)
      throw new ApiRequestError(
        response.status,
        body?.error.message ?? '操作を完了できませんでした。',
      )
    }
    return response
  }
}

function jsonHeaders(existing: HeadersInit | undefined, body: unknown): Headers {
  const headers = new Headers(existing)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return headers
}

async function readErrorResponse(response: Response): Promise<ApiErrorResponse | null> {
  try {
    return (await response.json()) as ApiErrorResponse
  } catch {
    return null
  }
}
