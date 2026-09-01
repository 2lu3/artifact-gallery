import { randomBytes } from 'node:crypto'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiOrigin = process.env.ARTIFACT_GALLERY_API_ORIGIN ?? 'http://127.0.0.1:3000'
const BOOTSTRAP_PROXY_HEADER = 'x-artifact-gallery-bootstrap-proxy'
const DEVELOPMENT_CSP_NONCE = randomBytes(18).toString('base64url')

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'artifact-gallery-trusted-bootstrap',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          let pathname: string
          try {
            pathname = new URL(request.url ?? '', 'http://vite.local').pathname
          } catch {
            return next()
          }
          if (pathname !== '/' && pathname !== '/index.html') return next()
          if (request.headers[BOOTSTRAP_PROXY_HEADER] !== undefined) {
            sendBootstrapUnavailable(response)
            return
          }
          try {
            const upstream = await fetch(new URL('/', apiOrigin), {
              headers: { [BOOTSTRAP_PROXY_HEADER]: '1' },
              redirect: 'error',
            })
            if (!upstream.ok || !upstream.headers.get('content-type')?.includes('text/html')) {
              throw new Error('Trusted bootstrap upstream response is invalid.')
            }
            const transformed = await server.transformIndexHtml(
              request.url ?? pathname,
              await upstream.text(),
            )
            response.statusCode = 200
            for (const header of ['content-type', 'cache-control', 'pragma']) {
              const value = upstream.headers.get(header)
              if (value) response.setHeader(header, value)
            }
            const contentSecurityPolicy = upstream.headers.get('content-security-policy')
            if (contentSecurityPolicy) {
              response.setHeader(
                'content-security-policy',
                authorizeViteNonce(contentSecurityPolicy, DEVELOPMENT_CSP_NONCE),
              )
            }
            response.setHeader('cache-control', 'no-store')
            response.end(transformed)
          } catch {
            sendBootstrapUnavailable(response)
          }
        })
      },
    },
  ],
  html: { cspNonce: DEVELOPMENT_CSP_NONCE },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiOrigin, changeOrigin: true },
    },
  },
})

function authorizeViteNonce(policy: string, nonce: string): string {
  return authorizeDirectiveNonce(
    authorizeDirectiveNonce(policy, 'script-src', nonce),
    'style-src',
    nonce,
  )
}

function authorizeDirectiveNonce(policy: string, directive: string, nonce: string): string {
  const nonceSource = `'nonce-${nonce}'`
  const expression = new RegExp(`${directive}\\s+([^;]*)`, 'iu')
  if (expression.test(policy)) {
    return policy.replace(expression, (_matched, sources: string) => {
      if (sources.split(/\s+/u).includes(nonceSource)) return `${directive} ${sources.trim()}`
      return `${directive} ${sources.trim()} ${nonceSource}`.trim()
    })
  }
  return `${policy.replace(/;?\s*$/u, '')}; ${directive} 'self' ${nonceSource}`
}

function sendBootstrapUnavailable(response: {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body: string): void
}): void {
  response.statusCode = 502
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'text/plain; charset=utf-8')
  response.setHeader('x-content-type-options', 'nosniff')
  response.end('Trusted bootstrap is unavailable.')
}
