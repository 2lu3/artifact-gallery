import type { ChildProcess } from 'node:child_process'
import type { Page } from 'playwright'

export interface ManagedPerformanceResources<Process, Prepared, Browser, Context> {
  readonly process: Process
  readonly prepared: Prepared
  readonly browser: Browser
  readonly context: Context
}

export interface ManagedPerformanceScenarioOptions<Process, Prepared, Browser, Context, Result> {
  readonly spawnProcess: () => Process
  readonly waitForProcess: (process: Process) => Promise<void>
  readonly prepare: (process: Process) => Promise<Prepared>
  readonly launchBrowser: (process: Process, prepared: Prepared) => Promise<Browser>
  readonly createContext: (
    browser: Browser,
    process: Process,
    prepared: Prepared,
  ) => Promise<Context>
  readonly execute: (
    resources: ManagedPerformanceResources<Process, Prepared, Browser, Context>,
  ) => Promise<Result>
  readonly cleanupTimeoutMs?: number
  readonly closeContext: (context: Context) => Promise<void>
  readonly closeBrowser: (browser: Browser) => Promise<void>
  readonly stopProcess: (process: Process) => Promise<void>
  readonly removeState: () => Promise<void>
}

export interface ChildTerminationOptions {
  readonly exited?: Promise<unknown>
  readonly sigtermTimeoutMs: number
  readonly sigkillTimeoutMs: number
}

export async function fetchWithinPerformanceDeadline(
  input: string | URL,
  init: RequestInit,
  deadlineAt: number,
  operation: string,
): Promise<Response> {
  const timeoutMs = remainingPerformanceBudget(deadlineAt, operation)
  const controller = new AbortController()
  let timedOut = false
  const inheritedSignal = init.signal
  const abortFromInheritedSignal = (): void => controller.abort(inheritedSignal?.reason)
  if (inheritedSignal?.aborted) abortFromInheritedSignal()
  else inheritedSignal?.addEventListener('abort', abortFromInheritedSignal, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref()
  try {
    const response = await fetch(input, { ...init, signal: controller.signal })
    await response.clone().arrayBuffer()
    return response
  } catch (error) {
    if (timedOut) throw new Error(`${operation} timed out.`, { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    inheritedSignal?.removeEventListener('abort', abortFromInheritedSignal)
  }
}

export function remainingPerformanceBudget(deadlineAt: number, operation: string): number {
  const remainingMs = Math.ceil(deadlineAt - performance.now())
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error(`${operation} timed out.`)
  }
  return remainingMs
}

export async function measureThumbnailBatchWithinDeadline(
  page: Page,
  paths: readonly string[],
  deadlineAt: number,
): Promise<number> {
  const timeoutMs = remainingPerformanceBudget(deadlineAt, 'thumbnail fetch')
  return page.evaluate(
    async ({ thumbnailPaths, batchTimeoutMs }) => {
      const startedAt = performance.now()
      const batchDeadline = startedAt + batchTimeoutMs
      for (const path of thumbnailPaths) {
        const remainingMs = Math.ceil(batchDeadline - performance.now())
        if (remainingMs <= 0) throw new Error('thumbnail fetch timed out.')
        try {
          const response = await fetch(path, { signal: AbortSignal.timeout(remainingMs) })
          if (!response.ok) throw new Error('A benchmark thumbnail was unavailable.')
          await response.arrayBuffer()
        } catch (error) {
          if (
            performance.now() >= batchDeadline ||
            (error instanceof DOMException &&
              (error.name === 'AbortError' || error.name === 'TimeoutError'))
          ) {
            throw new Error('thumbnail fetch timed out.')
          }
          throw error
        }
      }
      return performance.now() - startedAt
    },
    { thumbnailPaths: paths, batchTimeoutMs: timeoutMs },
  )
}

export async function runManagedPerformanceScenario<Process, Prepared, Browser, Context, Result>(
  options: ManagedPerformanceScenarioOptions<Process, Prepared, Browser, Context, Result>,
): Promise<Result> {
  let production: Process | undefined
  let browser: Browser | undefined
  let context: Context | undefined
  let operationResult: Result | undefined
  let operationError: unknown
  let operationFailed = false
  const cleanupFailures: unknown[] = []
  try {
    try {
      production = options.spawnProcess()
      await options.waitForProcess(production)
      const prepared = await options.prepare(production)
      browser = await options.launchBrowser(production, prepared)
      context = await options.createContext(browser, production, prepared)
      operationResult = await options.execute({
        process: production,
        prepared,
        browser,
        context,
      })
    } catch (error) {
      operationFailed = true
      operationError = error
    }
  } finally {
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000
    if (context !== undefined) {
      const contextFailure = await cleanupFailureWithin(
        () => options.closeContext(context as Context),
        cleanupTimeoutMs,
        'context',
      )
      if (contextFailure !== undefined) cleanupFailures.push(contextFailure)
    }
    if (browser !== undefined) {
      const browserFailure = await cleanupFailureWithin(
        () => options.closeBrowser(browser as Browser),
        cleanupTimeoutMs,
        'browser',
      )
      if (browserFailure !== undefined) cleanupFailures.push(browserFailure)
    }
    try {
      if (production !== undefined) {
        try {
          await options.stopProcess(production)
        } catch (error) {
          cleanupFailures.push(error)
        }
      }
    } finally {
      try {
        await options.removeState()
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
  }
  if (operationFailed) throw operationError
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Unable to release performance resources.')
  }
  return operationResult as Result
}

export async function terminateChildProcess(
  child: ChildProcess,
  options: ChildTerminationOptions,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = options.exited ?? observeChildExit(child)
  child.kill('SIGTERM')
  if (await settlesWithin(exited, options.sigtermTimeoutMs)) return
  child.kill('SIGKILL')
  if (!(await settlesWithin(exited, options.sigkillTimeoutMs))) {
    throw new Error('A performance child process did not exit after SIGKILL.')
  }
}

export function observeChildExit(child: ChildProcess): Promise<unknown> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveExit) => {
    const finish = (outcome: unknown): void => {
      child.off('exit', onExit)
      child.off('error', onError)
      resolveExit(outcome)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({ code, signal, error: null })
    }
    const onError = (error: Error): void => {
      finish({ code: null, signal: null, error })
    }
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function settlesWithin(completion: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      completion.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function cleanupFailureWithin(
  cleanup: () => Promise<void>,
  timeoutMs: number,
  resource: string,
): Promise<unknown | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve()
        .then(cleanup)
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
      new Promise<Error>((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout(new Error(`Performance ${resource} cleanup timed out.`)),
          timeoutMs,
        )
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
