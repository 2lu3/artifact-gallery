import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiOrigin = process.env.ARTIFACT_GALLERY_API_ORIGIN ?? 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'artifact-gallery-trusted-bootstrap',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== '/' && request.url !== '/index.html') return next()
          try {
            const upstream = await fetch(`${apiOrigin}/`)
            response.statusCode = upstream.status
            for (const header of ['content-type', 'content-security-policy', 'cache-control', 'pragma']) {
              const value = upstream.headers.get(header)
              if (value) response.setHeader(header, value)
            }
            response.end(await upstream.text())
          } catch {
            next()
          }
        })
      },
    },
  ],
  server: {
    proxy: {
      '/api': { target: apiOrigin },
    },
  },
})
