import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'

import Fastify, { type FastifyInstance } from 'fastify'

import { SESSION_TOKEN_HEADER } from '../shared/contracts.js'
import { registerApiRoutes, type ApiRouteDependencies } from './api/routes.js'

export type LocalApiApp = FastifyInstance & {
  readonly sessionToken: string
}

export const DEFAULT_LISTEN_OPTIONS = { host: '127.0.0.1', port: 3000 } as const

export type BuildAppOptions = Partial<ApiRouteDependencies> & {
  readonly clientDirectory?: string
}

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

  app.get('/', async (_request, reply) => {
    const document = options.clientDirectory
      ? await readFile(resolve(options.clientDirectory, 'index.html'), 'utf8')
      : developmentIndexDocument()
    return reply
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'",
      )
      .header('cache-control', 'no-store')
      .header('pragma', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(injectTrustedBootstrap(document, sessionToken))
  })

  if (options.clientDirectory) {
    app.get('/assets/*', async (request, reply) => {
      const requested = (request.params as { '*': string })['*']
      const asset = await readStaticAsset(options.clientDirectory as string, requested)
      if (!asset) return reply.code(404).send()
      return reply
        .header('cache-control', 'public, max-age=31536000, immutable')
        .type(asset.contentType)
        .send(asset.bytes)
    })
  }

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
    options.database &&
      options.pathPolicy &&
      options.derivativePathPolicy &&
      options.processor &&
      options.thumbnailDirectory,
  )
}

function developmentIndexDocument(): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Artifact Gallery</title></head><body><div id="root"></div>',
    '<script type="module" src="/src/client/main.tsx"></script></body></html>',
  ].join('')
}

function injectTrustedBootstrap(document: string, sessionToken: string): string {
  const bootstrap = JSON.stringify({ sessionToken })
  const injection = `<script id="artifact-gallery-bootstrap" type="application/json">${bootstrap}</script>`
  return document.includes('</body>')
    ? document.replace('</body>', `${injection}</body>`)
    : `${document}${injection}`
}

async function readStaticAsset(
  clientDirectory: string,
  requested: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (requested.length === 0 || requested.includes('\0')) return null
  const root = await realpath(resolve(clientDirectory, 'assets'))
  const candidate = resolve(root, requested)
  if (!isContained(root, candidate)) return null
  try {
    const canonical = await realpath(candidate)
    if (!isContained(root, canonical)) return null
    return { bytes: await readFile(canonical), contentType: staticContentType(canonical) }
  } catch {
    return null
  }
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'))
}

function staticContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.woff2':
      return 'font/woff2'
    default:
      return 'application/octet-stream'
  }
}
