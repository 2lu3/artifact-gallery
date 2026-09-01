import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { runManagedPerformanceScenario, terminateChildProcess } from './resource-lifecycle.js'

type FailureStage = 'readiness' | 'bootstrap' | 'gallery' | 'browser' | 'context' | 'execute'

interface FakeBrowser {
  closed: boolean
}

interface FakeContext {
  closed: boolean
}

interface TestProcess {
  readonly child: ChildProcess
}

const lifecycleCases = [
  {
    name: 'cold-start',
    stages: ['readiness', 'browser', 'context', 'execute'] as const,
  },
  {
    name: 'thumbnail',
    stages: ['readiness', 'bootstrap', 'gallery', 'browser', 'context', 'execute'] as const,
  },
] as const

describe('performance resource lifecycle', () => {
  for (const lifecycleCase of lifecycleCases) {
    for (const stage of lifecycleCase.stages) {
      it(`${lifecycleCase.name} rejects promptly and releases every acquired resource after ${stage} fails`, async () => {
        const temporaryState = await mkdtemp(join(tmpdir(), 'artifact-gallery-perf-lifecycle-'))
        const browser: FakeBrowser = { closed: false }
        const context: FakeContext = { closed: false }
        let production: TestProcess | undefined
        let browserAcquired = false
        let contextAcquired = false
        const activeBefore = ownedActiveResources()
        const startedAt = performance.now()

        await expect(
          runManagedPerformanceScenario<TestProcess, string, FakeBrowser, FakeContext, number>({
            spawnProcess: () => {
              production = {
                child: spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
                  stdio: 'ignore',
                }),
              }
              return production
            },
            waitForProcess: async () => {
              if (stage === 'readiness') throw injectedFailure(stage)
            },
            prepare: async () => {
              if (stage === 'bootstrap') throw injectedFailure(stage)
              await Promise.resolve()
              if (stage === 'gallery') throw injectedFailure(stage)
              return 'prepared'
            },
            launchBrowser: async () => {
              if (stage === 'browser') throw injectedFailure(stage)
              browserAcquired = true
              return browser
            },
            createContext: async () => {
              if (stage === 'context') throw injectedFailure(stage)
              contextAcquired = true
              return context
            },
            execute: async () => {
              if (stage === 'execute') throw injectedFailure(stage)
              return 1
            },
            closeContext: async (acquiredContext) => {
              acquiredContext.closed = true
            },
            closeBrowser: async (acquiredBrowser) => {
              acquiredBrowser.closed = true
            },
            stopProcess: async ({ child }) => {
              await terminateChildProcess(child, { sigtermTimeoutMs: 50, sigkillTimeoutMs: 250 })
            },
            removeState: async () => {
              await rm(temporaryState, { force: true, recursive: true })
            },
          }),
        ).rejects.toThrow(`injected ${stage} failure`)

        expect(performance.now() - startedAt).toBeLessThan(1_000)
        expect(production).toBeDefined()
        expect(production?.child.exitCode !== null || production.child.signalCode !== null).toBe(
          true,
        )
        expect(production?.child.listenerCount('exit')).toBe(0)
        expect(production?.child.listenerCount('error')).toBe(0)
        expect(browser.closed).toBe(browserAcquired)
        expect(context.closed).toBe(contextAcquired)
        await expect(access(temporaryState)).rejects.toThrow()
        await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
        expectNoAdditionalOwnedResources(activeBefore)
      })
    }
  }

  it('continues nested cleanup when context, browser, and process cleanup report failures', async () => {
    const temporaryState = await mkdtemp(join(tmpdir(), 'artifact-gallery-perf-cleanup-'))
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
      stdio: 'ignore',
    })
    const browser: FakeBrowser = { closed: false }
    const context: FakeContext = { closed: false }

    await expect(
      runManagedPerformanceScenario<TestProcess, undefined, FakeBrowser, FakeContext, number>({
        spawnProcess: () => ({ child }),
        waitForProcess: async () => undefined,
        prepare: async () => undefined,
        launchBrowser: async () => browser,
        createContext: async () => context,
        execute: async () => {
          throw injectedFailure('execute')
        },
        closeContext: async (acquiredContext) => {
          acquiredContext.closed = true
          throw new Error('context close failed')
        },
        closeBrowser: async (acquiredBrowser) => {
          acquiredBrowser.closed = true
          throw new Error('browser close failed')
        },
        stopProcess: async ({ child: processChild }) => {
          await terminateChildProcess(processChild, {
            sigtermTimeoutMs: 50,
            sigkillTimeoutMs: 250,
          })
          throw new Error('process close failed')
        },
        removeState: async () => {
          await rm(temporaryState, { force: true, recursive: true })
        },
      }),
    ).rejects.toThrow('injected execute failure')

    expect(context.closed).toBe(true)
    expect(browser.closed).toBe(true)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    await expect(access(temporaryState)).rejects.toThrow()
  })

  it('uses a bounded SIGKILL fallback and clears its termination timers', async () => {
    const activeBefore = ownedActiveResources()
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => undefined); process.send?.('ready'); setInterval(() => undefined, 1_000)",
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    )
    await new Promise<void>((resolveReady) => child.once('message', () => resolveReady()))
    const startedAt = performance.now()

    await terminateChildProcess(child, { sigtermTimeoutMs: 25, sigkillTimeoutMs: 250 })

    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(child.signalCode).toBe('SIGKILL')
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
    expectNoAdditionalOwnedResources(activeBefore)
  })
})

function injectedFailure(stage: FailureStage): Error {
  return new Error(`injected ${stage} failure`)
}

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
