import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiOrigin = process.env.ARTIFACT_GALLERY_API_ORIGIN ?? 'http://127.0.0.1:3000'
const BOOTSTRAP_PROXY_HEADER = 'x-artifact-gallery-bootstrap-proxy'

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
            for (const header of [
              'content-type',
              'content-security-policy',
              'cache-control',
              'pragma',
            ]) {
              const value = upstream.headers.get(header)
              if (value) response.setHeader(header, value)
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
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: apiOrigin },
    },
  },
})

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
