import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

import * as performanceResources from './resource-lifecycle.js'
import { runManagedPerformanceScenario, terminateChildProcess } from './resource-lifecycle.js'

interface HangingProduction {
  readonly child: ChildProcess
  baseUrl: string
}

describe('performance setup HTTP lifecycle', () => {
  it('times out a TCP-ready hanging bootstrap and promptly cleans child and state', async () => {
    const fetchWithinDeadline = (
      performanceResources as unknown as {
        fetchWithinPerformanceDeadline?: (
          input: string,
          init: RequestInit,
          deadlineAt: number,
          operation: string,
        ) => Promise<Response>
      }
    ).fetchWithinPerformanceDeadline
    expect(typeof fetchWithinDeadline).toBe('function')
    if (!fetchWithinDeadline) return

    const temporaryState = await mkdtemp(join(tmpdir(), 'artifact-gallery-perf-http-hang-'))
    const fixture = join(temporaryState, 'server.mjs')
    await writeFile(
      fixture,
      `import { createServer } from 'node:http'
const server = createServer(() => undefined)
server.listen(0, '127.0.0.1', () => process.send?.({ port: server.address().port }))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`,
    )
    const activeBefore = ownedActiveResources()
    let production: HangingProduction | undefined
    let browserLaunchAttempted = false
    let childStopped = false
    let stateRemoved = false
    const startedAt = performance.now()

    await expect(
      runManagedPerformanceScenario<
        HangingProduction,
        undefined,
        { closed: boolean },
        { closed: boolean },
        number
      >({
        spawnProcess: () => {
          production = {
            child: spawn(process.execPath, [fixture], {
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            }),
            baseUrl: '',
          }
          return production
        },
        waitForProcess: async (processHandle) => {
          const [message] = (await once(processHandle.child, 'message')) as [{ port: number }]
          processHandle.baseUrl = `http://127.0.0.1:${message.port}`
        },
        prepare: async (processHandle) => {
          await fetchWithinDeadline(
            `${processHandle.baseUrl}/bootstrap`,
            {},
            performance.now() + 75,
            'thumbnail bootstrap',
          )
        },
        launchBrowser: async () => {
          browserLaunchAttempted = true
          return { closed: false }
        },
        createContext: async () => ({ closed: false }),
        execute: async () => 1,
        cleanupTimeoutMs: 25,
        closeContext: async (context) => {
          context.closed = true
        },
        closeBrowser: async (browser) => {
          browser.closed = true
        },
        stopProcess: async ({ child }) => {
          await terminateChildProcess(child, {
            sigtermTimeoutMs: 50,
            sigkillTimeoutMs: 250,
          })
          childStopped = true
        },
        removeState: async () => {
          await rm(temporaryState, { force: true, recursive: true })
          stateRemoved = true
        },
      }),
    ).rejects.toThrow(/thumbnail bootstrap timed out/u)

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(browserLaunchAttempted).toBe(false)
    expect(childStopped).toBe(true)
    expect(stateRemoved).toBe(true)
    expect(production?.child.exitCode !== null || production.child.signalCode !== null).toBe(true)
    await expect(access(temporaryState)).rejects.toThrow()
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
    expectNoAdditionalOwnedResources(activeBefore)
  })

  it('times out a hanging browser thumbnail fetch before cleaning browser, child, and state', async () => {
    const measureThumbnailBatch = (
      performanceResources as unknown as {
        measureThumbnailBatchWithinDeadline?: (
          page: Page,
          paths: readonly string[],
          deadlineAt: number,
        ) => Promise<number>
      }
    ).measureThumbnailBatchWithinDeadline
    expect(typeof measureThumbnailBatch).toBe('function')
    if (!measureThumbnailBatch) return

    const temporaryState = await mkdtemp(join(tmpdir(), 'artifact-gallery-perf-thumb-hang-'))
    const fixture = join(temporaryState, 'server.mjs')
    await writeFile(
      fixture,
      `import { createServer } from 'node:http'
const server = createServer(() => undefined)
server.listen(0, '127.0.0.1', () => process.send?.({ port: server.address().port }))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`,
    )
    const activeBefore = ownedActiveResources()
    let production: HangingProduction | undefined
    let browser: Browser | undefined
    let stateRemoved = false
    let fetchStartedAt: number | undefined

    await expect(
      runManagedPerformanceScenario<
        HangingProduction,
        undefined,
        Browser,
        Awaited<ReturnType<Browser['newContext']>>,
        number
      >({
        spawnProcess: () => {
          production = {
            child: spawn(process.execPath, [fixture], {
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            }),
            baseUrl: '',
          }
          return production
        },
        waitForProcess: async (processHandle) => {
          const [message] = (await once(processHandle.child, 'message')) as [{ port: number }]
          processHandle.baseUrl = `http://127.0.0.1:${message.port}`
        },
        prepare: async () => undefined,
        launchBrowser: async () => {
          browser = await chromium.launch({ headless: true })
          return browser
        },
        createContext: async (launchedBrowser) => launchedBrowser.newContext(),
        execute: async ({ process: processHandle, context }) => {
          const page = await context.newPage()
          fetchStartedAt = performance.now()
          return measureThumbnailBatch(
            page,
            [`${processHandle.baseUrl}/thumbnail.webp`],
            performance.now() + 75,
          )
        },
        cleanupTimeoutMs: 500,
        closeContext: async (context) => context.close(),
        closeBrowser: async (launchedBrowser) => launchedBrowser.close(),
        stopProcess: async ({ child }) => {
          await terminateChildProcess(child, {
            sigtermTimeoutMs: 50,
            sigkillTimeoutMs: 250,
          })
        },
        removeState: async () => {
          await rm(temporaryState, { force: true, recursive: true })
          stateRemoved = true
        },
      }),
    ).rejects.toThrow(/thumbnail fetch timed out/u)

    expect(fetchStartedAt).toBeTypeOf('number')
    expect(performance.now() - (fetchStartedAt as number)).toBeLessThan(1_000)
    expect(browser?.isConnected()).toBe(false)
    expect(stateRemoved).toBe(true)
    expect(production?.child.exitCode !== null || production.child.signalCode !== null).toBe(true)
    await expect(access(temporaryState)).rejects.toThrow()
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
    expectNoAdditionalOwnedResources(activeBefore)
  })
})

function ownedActiveResources(): Record<'ChildProcess' | 'Timeout', number> {
  const active = process.getActiveResourcesInfo()
  return {
    ChildProcess: active.filter((resource) => resource === 'ChildProcess').length,
    Timeout: active.filter((resource) => resource === 'Timeout').length,
  }
}

function expectNoAdditionalOwnedResources(
  baseline: Record<'ChildProcess' | 'Timeout', number>,
): void {
  const after = ownedActiveResources()
  expect(after.ChildProcess).toBeLessThanOrEqual(baseline.ChildProcess)
  expect(after.Timeout).toBeLessThanOrEqual(baseline.Timeout)
}
