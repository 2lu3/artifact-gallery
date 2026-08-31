import { randomBytes, timingSafeEqual } from 'node:crypto'

import Fastify, { type FastifyInstance } from 'fastify'

import { SESSION_TOKEN_HEADER } from '../shared/contracts.js'
import { registerApiRoutes, type ApiRouteDependencies } from './api/routes.js'

export type LocalApiApp = FastifyInstance & {
  readonly sessionToken: string
}

export const DEFAULT_LISTEN_OPTIONS = { host: '127.0.0.1', port: 3000 } as const

export type BuildAppOptions = Partial<ApiRouteDependencies>

export function buildApp(options: BuildAppOptions = {}): LocalApiApp {
  const app = Fastify({ bodyLimit: 64 * 1024 }) as unknown as LocalApiApp
  const sessionToken = randomBytes(32).toString('base64url')
  Object.defineProperty(app, 'sessionToken', {
    value: sessionToken,
    configurable: false,
    enumerable: false,
    writable: false,
  })

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api')) return
    const supplied = request.headers[SESSION_TOKEN_HEADER]
    if (typeof supplied !== 'string' || !tokensEqual(sessionToken, supplied)) {
      await reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          stage: 'request',
          retryable: false,
          message: 'A valid session token is required.',
        },
      })
    }
  })

  app.get('/api/health', () => ({ status: 'ok' }))

  app.get('/', (_request, reply) =>
    reply
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'",
      )
      .type('text/html; charset=utf-8')
      .send(trustedBootstrapDocument(sessionToken)),
  )

  if (hasApiDependencies(options)) {
    registerApiRoutes(app, options)
  }

  app.setNotFoundHandler((request, reply) => {
    if (!request.url.startsWith('/api')) return reply.code(404).send()
    return reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        stage: 'request',
        retryable: false,
        message: 'The requested API route was not found.',
      },
    })
  })

  app.setErrorHandler((_error, _request, reply) =>
    reply.code(400).send({
      error: {
        code: 'INVALID_REQUEST',
        stage: 'request',
        retryable: false,
        message: 'The request is invalid.',
      },
    }),
  )

  return app
}

function tokensEqual(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected)
  const suppliedBytes = Buffer.from(supplied)
  return (
    expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  )
}

function hasApiDependencies(options: BuildAppOptions): options is ApiRouteDependencies {
  return Boolean(
    options.database && options.pathPolicy && options.processor && options.thumbnailDirectory,
  )
}

function trustedBootstrapDocument(sessionToken: string): string {
  const bootstrap = JSON.stringify({ sessionToken })
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Artifact Gallery</title></head><body><div id="root"></div>',
    `<script id="artifact-gallery-bootstrap" type="application/json">${bootstrap}</script>`,
    '<script type="module" src="/src/client/main.tsx"></script></body></html>',
  ].join('')
}
