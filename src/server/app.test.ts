import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { SESSION_TOKEN_HEADER } from '../shared/contracts.js'
import { buildApp, DEFAULT_LISTEN_OPTIONS } from './app.js'

describe('buildApp', () => {
  it('rejects untrusted Host values before exposing the bootstrap token', async () => {
    const app = buildApp()

    for (const host of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:3000']) {
      const response = await app.inject({ method: 'GET', url: '/', headers: { host } })
      expect(response.statusCode, host).toBe(200)
      expect(response.body.includes(app.sessionToken), host).toBe(true)
    }
    for (const host of [
      'attacker.example',
      'attacker.example:3000',
      'localhost:3001',
      'localhost:99999',
      '[::1]:3000',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: '/',
        headers: { host, 'x-forwarded-host': 'localhost:3000' },
      })
      expect(response.statusCode, host).toBe(421)
      expect(response.body.includes(app.sessionToken), host).toBe(false)
    }

    const forwardedAttacker = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: '127.0.0.1:3000', 'x-forwarded-host': 'attacker.example' },
    })
    expect(forwardedAttacker.statusCode).toBe(200)
    const attackerApi = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'attacker.example' },
    })
    expect(attackerApi.statusCode).toBe(421)
    expect(attackerApi.json().error.code).toBe('UNTRUSTED_HOST')

    const ipv6 = buildApp({ trustedHosts: ['::1'], trustedPort: 3000 })
    expect(
      (
        await ipv6.inject({
          method: 'GET',
          url: '/',
          headers: { host: '[::1]:3000' },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await ipv6.inject({
          method: 'GET',
          url: '/',
          headers: { host: 'localhost:3000' },
        })
      ).statusCode,
    ).toBe(421)

    await app.close()
    await ipv6.close()
  })

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
      const missing = await app.inject({ ...route, headers: { host: '127.0.0.1:3000' } })
      expect(missing.statusCode, `${route.method} ${route.url}`).toBe(401)
    }
    const incorrect = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:3000', [SESSION_TOKEN_HEADER]: 'a'.repeat(43) },
    })
    const authorized = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        host: '127.0.0.1:3000',
        [SESSION_TOKEN_HEADER]: String(app.sessionToken),
      },
    })

    expect(incorrect.statusCode).toBe(401)
    expect(authorized.statusCode).toBe(200)
    expect(authorized.json()).toEqual({ status: 'ok' })

    await app.close()
  })

  it('prevents caching and safely varies every API response by the token header', async () => {
    const app = buildApp()
    const responses = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host: '127.0.0.1:3000' },
      }),
      app.inject({
        method: 'GET',
        url: '/api/health',
        headers: {
          host: '127.0.0.1:3000',
          [SESSION_TOKEN_HEADER]: app.sessionToken,
        },
      }),
      app.inject({
        method: 'GET',
        url: '/api/not-found',
        headers: {
          host: '127.0.0.1:3000',
          [SESSION_TOKEN_HEADER]: app.sessionToken,
        },
      }),
      app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host: 'attacker.example' },
      }),
    ])

    for (const response of responses) {
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers.vary?.toLowerCase().split(/\s*,\s*/u)).toContain(SESSION_TOKEN_HEADER)
    }
    await app.close()
  })

  it('creates a fresh session token for every app startup', async () => {
    const first = buildApp()
    const second = buildApp()

    expect(/^[A-Za-z0-9_-]{43}$/.test(first.sessionToken)).toBe(true)
    expect(/^[A-Za-z0-9_-]{43}$/.test(second.sessionToken)).toBe(true)
    expect(first.sessionToken === second.sessionToken).toBe(false)

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

    const bootstrap = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: '127.0.0.1:3000' },
    })
    const modulePath = bootstrap.body.match(/src="([^"]+)"/)?.[1]
    const moduleAsset = await app.inject({
      method: 'GET',
      url: modulePath ?? '/missing',
      headers: { host: '127.0.0.1:3000' },
    })
    const api = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:3000', [SESSION_TOKEN_HEADER]: app.sessionToken },
    })
    const publicRoute = await app.inject({
      method: 'GET',
      url: '/not-found',
      headers: { host: '127.0.0.1:3000' },
    })

    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.headers['content-type']).toContain('text/html')
    expect(bootstrap.headers['cache-control']).toBe('no-store')
    expect(bootstrap.body.includes(JSON.stringify({ sessionToken: app.sessionToken }))).toBe(true)
    expect(moduleAsset.statusCode).toBe(200)
    expect(moduleAsset.headers['content-type']).toContain('javascript')
    expect(moduleAsset.body).toContain('dataset.loaded')
    expect(moduleAsset.body.includes(app.sessionToken)).toBe(false)
    expect(api.statusCode).toBe(200)
    expect(api.json()).toEqual({ status: 'ok' })
    expect(publicRoute.body.includes(app.sessionToken)).toBe(false)

    await app.close()
    await rm(directory, { recursive: true })
  })

  it('uses an IPv4 loopback-only listen configuration', () => {
    expect(DEFAULT_LISTEN_OPTIONS).toEqual({ host: '127.0.0.1', port: 3000 })
  })
})
