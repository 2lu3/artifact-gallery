import type { ChildProcess } from 'node:child_process'

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
    const contextCleanup = await Promise.allSettled([
      context === undefined
        ? Promise.resolve()
        : Promise.resolve().then(() => options.closeContext(context as Context)),
    ])
    const browserCleanup = await Promise.allSettled([
      browser === undefined
        ? Promise.resolve()
        : Promise.resolve().then(() => options.closeBrowser(browser as Browser)),
    ])
    cleanupFailures.push(
      ...contextCleanup
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map(({ reason }) => reason),
      ...browserCleanup
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map(({ reason }) => reason),
    )
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
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
