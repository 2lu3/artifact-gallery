import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { SESSION_TOKEN_HEADER } from '../src/shared/contracts.js'
import { extractBootstrapToken } from './production-smoke.js'

const DEVELOPMENT_ORIGIN = 'http://127.0.0.1:5173'
const API_ORIGIN = 'http://127.0.0.1:3000'
const TIMEOUT_MS = 20_000

export async function runDevelopmentSmoke(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-development-smoke-'))
  const logs: string[] = []
  const child = spawn('pnpm', ['dev'], {
    cwd: resolve('.'),
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      PORT: '3000',
      ARTIFACT_GALLERY_API_ORIGIN: API_ORIGIN,
      ARTIFACT_GALLERY_STATE_DIRECTORY: join(directory, 'state'),
      ARTIFACT_GALLERY_DATABASE: join(directory, 'state', 'catalog.sqlite'),
      ARTIFACT_GALLERY_THUMBNAILS: join(directory, 'state', 'thumbnails'),
      ARTIFACT_GALLERY_ALLOWED_ROOTS: [directory].join(delimiter),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => rememberLog(logs, chunk))
  child.stderr?.on('data', (chunk: Buffer) => rememberLog(logs, chunk))
  const exited = Promise.race([
    once(child, 'exit').then(([code, signal]) => ({ code, signal, error: null })),
    once(child, 'error').then(([error]) => ({ code: null, signal: null, error })),
  ])
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const bootstrapResponse = await fetchDevelopmentBootstrap(exited)
    const document = await bootstrapResponse.text()
    const token = extractBootstrapToken(document)
    assertNonceCompatibleDocument(bootstrapResponse.headers, document)

    const health = await fetch(`${DEVELOPMENT_ORIGIN}/api/health`, {
      headers: { [SESSION_TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!health.ok || ((await health.json()) as { status?: unknown }).status !== 'ok') {
      throw new Error('The development API proxy did not authenticate the health request.')
    }

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const browserErrors: string[] = []
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    const navigation = await page.goto(DEVELOPMENT_ORIGIN, { waitUntil: 'networkidle' })
    if (!navigation?.ok()) throw new Error('The Vite development document did not load.')
    await page.getByRole('heading', { name: 'Artifact Gallery' }).waitFor({ state: 'visible' })
    await page.getByText('最初の生成物を登録').waitFor({ state: 'visible' })
    if (browserErrors.length > 0) {
      throw new Error(`The development browser reported an error: ${browserErrors[0]}`)
    }
    process.stdout.write('development-smoke bootstrap-mounted-authenticated\n')
  } catch (error) {
    const detail = logs.join('').slice(-8_000)
    throw new Error(
      `${error instanceof Error ? error.message : 'Development smoke failed.'}${
        detail ? `\nDevelopment process output:\n${detail}` : ''
      }`,
      { cause: error },
    )
  } finally {
    await browser?.close()
    await terminateProcessTree(child, exited)
    await rm(directory, { recursive: true, force: true })
  }
}

async function fetchDevelopmentBootstrap(
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: unknown }>,
): Promise<Response> {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const request = fetch(DEVELOPMENT_ORIGIN, { signal: AbortSignal.timeout(1_000) }).catch(
      () => null,
    )
    const outcome = await Promise.race([
      request.then((response) => ({ response, exited: false as const })),
      exited.then(() => ({ response: null, exited: true as const })),
    ])
    if (outcome.exited) throw new Error('The development process exited before readiness.')
    if (outcome.response?.ok) return outcome.response
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error('Timed out waiting for Vite on port 5173.')
}

export function assertNonceCompatibleDocument(headers: Headers, document: string): void {
  const policy = headers.get('content-security-policy') ?? ''
  const nonce = /'nonce-([A-Za-z0-9_-]+)'/u.exec(policy)?.[1]
  if (!nonce || !document.includes(`nonce="${nonce}"`)) {
    throw new Error('The development CSP nonce does not authorize Vite transforms.')
  }
}

async function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: unknown }>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  signalProcessTree(child.pid, 'SIGTERM')
  let timer: NodeJS.Timeout | undefined
  const result = await Promise.race([
    exited.then(() => 'exit' as const),
    new Promise<'timeout'>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout('timeout'), 5_000)
      timer.unref()
    }),
  ])
  if (timer) clearTimeout(timer)
  if (result === 'timeout') {
    signalProcessTree(child.pid, 'SIGKILL')
    await exited
  }
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    // A concurrently-managed child can finish between the state check and the signal.
  }
}

function rememberLog(logs: string[], chunk: Buffer): void {
  logs.push(chunk.toString('utf8'))
  if (logs.length > 100) logs.splice(0, logs.length - 100)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runDevelopmentSmoke().catch((error: unknown) => {
    process.stderr.write(
      `development-smoke failed: ${error instanceof Error ? error.message : 'unknown failure'}\n`,
    )
    process.exitCode = 1
  })
}
