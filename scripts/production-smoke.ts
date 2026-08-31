import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SESSION_TOKEN_HEADER, type GalleryPage } from '../src/shared/contracts.js'

export interface ProductionSmokeOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly port: number
  readonly environment?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly log?: (message: string) => void
}

export interface ProductionSmokeResult {
  readonly health: 'ok'
  readonly galleryItems: number
  readonly exitCode: number
}

export function extractBootstrapToken(document: string): string {
  const pattern =
    /<script\b[^>]*\bid=["']artifact-gallery-bootstrap["'][^>]*>([\s\S]*?)<\/script>/giu
  const matches = [...document.matchAll(pattern)]
  if (matches.length !== 1) {
    throw new Error('The bootstrap document must contain exactly one token payload.')
  }
  let payload: unknown
  try {
    payload = JSON.parse(matches[0]?.[1] ?? '')
  } catch {
    throw new Error('The bootstrap token payload is invalid.')
  }
  const token = (payload as { sessionToken?: unknown } | null)?.sessionToken
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,}$/u.test(token)) {
    throw new Error('The bootstrap token payload is invalid.')
  }
  return token
}

export async function runProductionSmoke(
  options: ProductionSmokeOptions,
): Promise<ProductionSmokeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const log = options.log ?? console.info
  const child = spawn(options.command, [...options.args], {
    env: { ...process.env, ...options.environment, PORT: String(options.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  const exited = Promise.race([
    once(child, 'exit').then(([code, signal]) => ({ code, signal, error: null })),
    once(child, 'error').then(([error]) => ({ code: null, signal: null, error })),
  ])
  let smokeError: unknown
  let result: Omit<ProductionSmokeResult, 'exitCode'> | undefined
  try {
    const baseUrl = `http://127.0.0.1:${options.port}`
    const bootstrap = await fetchUntilReady(baseUrl, timeoutMs, exited)
    const sessionToken = extractBootstrapToken(bootstrap)
    log('production-smoke server-ready')
    const headers = { [SESSION_TOKEN_HEADER]: sessionToken }
    const healthResponse = await fetch(`${baseUrl}/api/health`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const health = (await healthResponse.json()) as { status?: unknown }
    if (!healthResponse.ok || health.status !== 'ok') {
      throw new Error('The production health endpoint failed.')
    }
    log('production-smoke health-ok')
    const galleryResponse = await fetch(`${baseUrl}/api/gallery`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const gallery = (await galleryResponse.json()) as Partial<GalleryPage>
    if (!galleryResponse.ok || !Array.isArray(gallery.items)) {
      throw new Error('The production gallery endpoint failed.')
    }
    log(`production-smoke gallery-ok items=${gallery.items.length}`)
    result = { health: 'ok', galleryItems: gallery.items.length }
  } catch (error) {
    smokeError = error
  }

  const termination = await terminateGracefully(child, exited, timeoutMs)
  if (!termination.graceful) {
    throw new Error('The production server did not stop gracefully.')
  }
  log('production-smoke shutdown-ok')
  if (smokeError) throw smokeError
  if (!result) throw new Error('The production smoke did not produce a result.')
  return { ...result, exitCode: termination.exitCode }
}

async function fetchUntilReady(
  baseUrl: string,
  timeoutMs: number,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: unknown }>,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now())
    const attempt = fetch(baseUrl, { signal: AbortSignal.timeout(remainingMs) })
      .then(async (response) => (response.ok ? response.text() : null))
      .catch(() => null)
    const outcome = await Promise.race([
      attempt.then((document) => ({ kind: 'response' as const, document })),
      exited.then(() => ({ kind: 'exit' as const, document: null })),
    ])
    if (outcome.kind === 'exit') throw new Error('The production server exited before readiness.')
    if (outcome.document !== null) return outcome.document
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for the production server.')
}

async function terminateGracefully(
  child: ReturnType<typeof spawn>,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: unknown }>,
  timeoutMs: number,
): Promise<{ graceful: boolean; exitCode: number }> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ kind: 'timeout'; value: null }>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ kind: 'timeout', value: null }), timeoutMs)
  })
  const outcome = await Promise.race([
    exited.then((value) => ({ kind: 'exit' as const, value })),
    timeout,
  ])
  if (timer) clearTimeout(timer)
  if (outcome.kind === 'timeout') {
    child.kill('SIGKILL')
    await exited
    return { graceful: false, exitCode: 1 }
  }
  if (outcome.value.error || outcome.value.signal !== null || outcome.value.code !== 0) {
    return { graceful: false, exitCode: outcome.value.code ?? 1 }
  }
  return { graceful: true, exitCode: outcome.value.code }
}

async function runCli(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-production-smoke-'))
  try {
    const port = await availablePort()
    await runProductionSmoke({
      command: process.execPath,
      args: [resolve('dist/server/server/index.js')],
      port,
      environment: {
        ARTIFACT_GALLERY_STATE_DIRECTORY: join(directory, 'state'),
        ARTIFACT_GALLERY_ALLOWED_ROOTS: directory,
        ARTIFACT_GALLERY_CLIENT_DIRECTORY: resolve('dist'),
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a port.')
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
  return address.port
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure'
    process.stderr.write(`production-smoke failed: ${message}\n`)
    process.exitCode = 1
  })
}
