import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { SESSION_TOKEN_HEADER } from '../shared/contracts.js'
import { buildApp, DEFAULT_LISTEN_OPTIONS } from './app.js'

describe('buildApp', () => {
  it('requires the startup session token for every API route', async () => {
    const app = buildApp()

    const protectedRoutes = [
      { method: 'GET', url: '/api/health' },
      { method: 'GET', url: '/api/gallery' },
      { method: 'GET', url: '/api/search?q=test' },
      { method: 'GET', url: '/api/artifacts/1' },
      { method: 'POST', url: '/api/registrations/file' },
      { method: 'POST', url: '/api/registrations/folder' },
      { method: 'GET', url: '/api/imports/1' },
      { method: 'POST', url: '/api/imports/1/cancel' },
      { method: 'POST', url: '/api/artifacts/1/refresh' },
      { method: 'POST', url: '/api/artifacts/1/retry' },
      { method: 'POST', url: '/api/artifacts/1/rebuild' },
      { method: 'POST', url: '/api/artifacts/1/relink' },
      { method: 'PATCH', url: '/api/artifacts/1/title' },
      { method: 'DELETE', url: '/api/artifacts/1' },
      { method: 'POST', url: '/api/artifacts/1/reveal' },
      { method: 'POST', url: '/api/artifacts/1/open-source' },
    ] as const
    for (const route of protectedRoutes) {
      const missing = await app.inject(route)
      expect(missing.statusCode, `${route.method} ${route.url}`).toBe(401)
    }
    const incorrect = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { [SESSION_TOKEN_HEADER]: 'a'.repeat(43) },
    })
    const authorized = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { [SESSION_TOKEN_HEADER]: String(app.sessionToken) },
    })

    expect(incorrect.statusCode).toBe(401)
    expect(authorized.statusCode).toBe(200)
    expect(authorized.json()).toEqual({ status: 'ok' })

    await app.close()
  })

  it('creates a fresh session token for every app startup', async () => {
    const first = buildApp()
    const second = buildApp()

    expect(first.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.sessionToken).not.toBe(second.sessionToken)

    await first.close()
    await second.close()
  })

  it('publishes the token only through the trusted bootstrap document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-client-'))
    const assets = join(directory, 'assets')
    await mkdir(assets)
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>',
    )
    await writeFile(join(assets, 'app.js'), 'document.body.dataset.loaded = "true"')
    const app = buildApp({ clientDirectory: directory })

    const bootstrap = await app.inject({ method: 'GET', url: '/' })
    const modulePath = bootstrap.body.match(/src="([^"]+)"/)?.[1]
    const moduleAsset = await app.inject({ method: 'GET', url: modulePath ?? '/missing' })
    const api = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { [SESSION_TOKEN_HEADER]: app.sessionToken },
    })
    const publicRoute = await app.inject({ method: 'GET', url: '/not-found' })

    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.headers['content-type']).toContain('text/html')
    expect(bootstrap.headers['cache-control']).toBe('no-store')
    expect(bootstrap.body).toContain(JSON.stringify({ sessionToken: app.sessionToken }))
    expect(moduleAsset.statusCode).toBe(200)
    expect(moduleAsset.headers['content-type']).toContain('javascript')
    expect(moduleAsset.body).toContain('dataset.loaded')
    expect(moduleAsset.body).not.toContain(app.sessionToken)
    expect(api.statusCode).toBe(200)
    expect(api.json()).toEqual({ status: 'ok' })
    expect(publicRoute.body).not.toContain(app.sessionToken)

    await app.close()
    await rm(directory, { recursive: true })
  })

  it('uses an IPv4 loopback-only listen configuration', () => {
    expect(DEFAULT_LISTEN_OPTIONS).toEqual({ host: '127.0.0.1', port: 3000 })
  })
})
