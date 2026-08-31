import { afterEach, describe, expect, it, vi } from 'vitest'

import viteConfig from './vite.config.js'

type Middleware = (
  request: { url?: string; headers: Record<string, string | undefined> },
  response: TestResponse,
  next: () => void,
) => void | Promise<void>

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('trusted bootstrap Vite middleware', () => {
  it('recognizes bootstrap pathnames with queries and applies Vite HTML transforms', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          '<!doctype html><html><head></head><body><script id="artifact-gallery-bootstrap">token</script></body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    )
    const middleware = readBootstrapMiddleware(async (_url, html) =>
      html.replace('</head>', '<script type="module" src="/@vite/client"></script></head>'),
    )
    for (const url of ['/?mode=dev', '/index.html?cache-bust=1']) {
      const response = new TestResponse()
      let passedThrough = false

      await middleware({ url, headers: {} }, response, () => {
        passedThrough = true
      })

      expect(passedThrough, url).toBe(false)
      expect(response.statusCode, url).toBe(200)
      expect(response.body, url).toContain('/@vite/client')
      expect(response.body, url).toContain('artifact-gallery-bootstrap')
      expect(response.headers.get('cache-control'), url).toBe('no-store')
    }
  })

  it('fails closed when upstream bootstrap fetch fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('upstream unavailable')
    })
    const middleware = readBootstrapMiddleware(async (_url, html) => html)
    const response = new TestResponse()
    let passedThrough = false

    await middleware({ url: '/', headers: {} }, response, () => {
      passedThrough = true
    })

    expect(passedThrough).toBe(false)
    expect(response.statusCode).toBe(502)
    expect(response.body).not.toContain('token')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('fails closed instead of recursively proxying its own bootstrap request', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('<html><body>token</body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    )
    const middleware = readBootstrapMiddleware(async (_url, html) => html)
    const response = new TestResponse()

    await middleware(
      { url: '/', headers: { 'x-artifact-gallery-bootstrap-proxy': '1' } },
      response,
      () => {
        throw new Error('Bootstrap recursion must not pass through to Vite.')
      },
    )

    expect(response.statusCode).toBe(502)
    expect(response.body).not.toContain('token')
  })
})

function readBootstrapMiddleware(
  transformIndexHtml: (url: string, html: string) => Promise<string>,
): Middleware {
  const config = viteConfig as {
    plugins: Array<{
      name?: string
      configureServer?: (server: {
        middlewares: { use: (middleware: Middleware) => void }
        transformIndexHtml: typeof transformIndexHtml
      }) => void
    }>
  }
  const plugin = config.plugins.find(({ name }) => name === 'artifact-gallery-trusted-bootstrap')
  if (!plugin?.configureServer) throw new Error('Trusted bootstrap plugin is missing.')
  let middleware: Middleware | undefined
  plugin.configureServer({
    middlewares: {
      use: (candidate) => {
        middleware = candidate
      },
    },
    transformIndexHtml,
  })
  if (!middleware) throw new Error('Trusted bootstrap middleware was not registered.')
  return middleware
}

class TestResponse {
  statusCode = 200
  readonly headers = new Map<string, string>()
  body = ''

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value)
  }

  end(body: string): void {
    this.body = body
  }
}
