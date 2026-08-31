import { createServer } from 'node:net'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { extractBootstrapToken, runProductionSmoke } from '../../scripts/production-smoke.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('production smoke', () => {
  it('extracts exactly one valid bootstrap token', () => {
    const document =
      '<main>Gallery</main><script id="artifact-gallery-bootstrap" type="application/json">' +
      '{"sessionToken":"0123456789abcdefghijklmnopqrstuvwxyz_SAFE"}</script>'

    expect(extractBootstrapToken(document)).toBe('0123456789abcdefghijklmnopqrstuvwxyz_SAFE')
    expect(() => extractBootstrapToken('<main>missing</main>')).toThrow(/bootstrap/u)
    expect(() =>
      extractBootstrapToken(
        `${document}<script id="artifact-gallery-bootstrap" type="application/json">` +
          '{"sessionToken":"another_0123456789abcdefghijklmnopqrstuvwxyz"}</script>',
      ),
    ).toThrow(/exactly one/u)
  })

  it('starts a real child, authorizes health and gallery, hides the token, and stops gracefully', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-prod-smoke-test-'))
    temporaryDirectories.push(directory)
    const marker = join(directory, 'graceful.txt')
    const fixture = join(directory, 'server.mjs')
    const port = await availablePort()
    const secret = 'do-not-log-this-session-token-0123456789'
    await writeFile(
      fixture,
      `import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
const secret = ${JSON.stringify(secret)}
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.setHeader('content-type', 'text/html')
    response.end('<script id="artifact-gallery-bootstrap" type="application/json">' + JSON.stringify({ sessionToken: secret }) + '</script>')
    return
  }
  if (request.headers['x-artifact-gallery-token'] !== secret) {
    response.statusCode = 401
    response.end('{}')
    return
  }
  if (request.url === '/api/health') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.url === '/api/gallery') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ items: [], nextCursor: null, catalogTotal: 0, filteredTotal: 0, formatCounts: { all: 0, html: 0, markdown: 0 } }))
    return
  }
  response.statusCode = 404
  response.end('{}')
})
server.listen(Number(process.env.PORT), '127.0.0.1')
process.on('SIGTERM', () => server.close(async () => {
  await writeFile(${JSON.stringify(marker)}, 'graceful')
  process.exit(0)
}))
`,
    )
    const logs: string[] = []
    const timeoutsBefore = activeTimeoutCount()

    const result = await runProductionSmoke({
      command: process.execPath,
      args: [fixture],
      port,
      environment: { PORT: String(port) },
      timeoutMs: 5_000,
      log: (message) => logs.push(message),
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(result).toEqual({ health: 'ok', galleryItems: 0, exitCode: 0 })
    await expect(access(marker)).resolves.toBeUndefined()
    expect(logs.join('\n')).not.toContain(secret)
    expect(logs).toEqual([
      'production-smoke server-ready',
      'production-smoke health-ok',
      'production-smoke gallery-ok items=0',
      'production-smoke shutdown-ok',
    ])
    expect(activeTimeoutCount()).toBeLessThanOrEqual(timeoutsBefore)
  })

  it('bounds a stalled bootstrap request and still terminates the child', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-prod-smoke-timeout-'))
    temporaryDirectories.push(directory)
    const marker = join(directory, 'graceful.txt')
    const fixture = join(directory, 'server.mjs')
    const port = await availablePort()
    await writeFile(
      fixture,
      `import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
const server = createServer((request) => setTimeout(() => request.socket.destroy(), 600))
server.listen(Number(process.env.PORT), '127.0.0.1')
process.on('SIGTERM', () => server.close(async () => {
  await writeFile(${JSON.stringify(marker)}, 'graceful')
  process.exit(0)
}))
`,
    )
    const startedAt = performance.now()

    await expect(
      runProductionSmoke({
        command: process.execPath,
        args: [fixture],
        port,
        environment: { PORT: String(port) },
        timeoutMs: 100,
        log: () => undefined,
      }),
    ).rejects.toThrow(/Timed out/u)

    expect(performance.now() - startedAt).toBeLessThan(400)
    await expect(access(marker)).resolves.toBeUndefined()
  })
})

function activeTimeoutCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a port.')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}
