import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { cpus, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

import {
  buildIsolatedProductionEnvironment,
  extractBootstrapToken,
} from '../../scripts/production-smoke.js'
import { openDatabase } from '../../src/server/db/database.js'
import { ArtifactProcessor } from '../../src/server/processing/artifact-processor.js'
import { PathPolicy } from '../../src/server/security/path-policy.js'
import type { GalleryPage } from '../../src/shared/contracts.js'
import {
  assertPerformanceGate,
  buildSearchRunSequence,
  createPerformanceCorpus,
  performanceProfile,
  runIndependentColdMeasurements,
  summarizeDurations,
  type DurationSummary,
  type PerformanceProfileName,
} from './harness.js'
import {
  observeChildExit,
  runManagedPerformanceScenario,
  terminateChildProcess,
} from './resource-lifecycle.js'

const FIRST_PAGE_RUNS = 5
const SEARCH_RUNS = 10
const DEFAULT_RESULTS_PATH = 'test-results/performance/results.json'
const PROCESS_READY_TIMEOUT_MS = 15_000
const PROCESS_TERM_TIMEOUT_MS = 2_000
const PROCESS_KILL_TIMEOUT_MS = 2_000

interface SearchMeasurement {
  readonly query: string
  readonly summary: DurationSummary
}

interface SeededState {
  readonly root: string
  readonly stateDirectory: string
  readonly databaseFilename: string
  readonly thumbnailDirectory: string
}

interface ProductionProcess {
  readonly baseUrl: string
  readonly child: ChildProcess
  readonly exited: Promise<unknown>
}

interface ThumbnailPreparation {
  readonly sessionToken: string
  readonly thumbnailPaths: readonly string[]
}

async function main(): Promise<void> {
  const profileName = readProfile(process.argv.slice(2))
  const profile = performanceProfile(profileName)
  const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-performance-'))
  const corpusDirectory = join(root, 'corpus')
  const resultsPath = process.env.ARTIFACT_GALLERY_PERF_RESULTS ?? DEFAULT_RESULTS_PATH
  try {
    const corpus = await createPerformanceCorpus(corpusDirectory)
    const sourcePaths = corpus.files.map(({ absolutePath }) => absolutePath)
    const firstPageDurations = await measureColdFirstPages({
      root,
      corpusDirectory,
      sourcePaths,
    })
    const interactive = await measureInteractiveSearches({
      root,
      corpusDirectory,
      sourcePaths,
      queries: [...new Set(corpus.files.map(({ query }) => query))],
      searchTargetMs: profile.searchTargetMs,
    })
    const thumbnails = await measureThumbnailCases({
      root,
      corpusDirectory,
      sourcePaths,
    })

    const hardware = {
      platform: process.platform,
      architecture: process.arch,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    }
    const firstPageSummary = summarizeDurations(firstPageDurations, profile.firstPageTargetMs)
    const report = {
      profile,
      hardware,
      methodology: {
        firstPage:
          'Each run uses a freshly seeded state directory, independent production Node process, Chromium process, and browser context; timing is navigation start to 30 rendered cards.',
        searches:
          'acceptedToRender is the app measure after debounce; userObservedFillToRender is external runner performance.now before fill through rendered-result measure completion.',
        thumbnails:
          'A separately seeded derivative directory and new Chromium context use disabled browser cache; warm repeats the same resource paths after the cold batch.',
      },
      corpus: {
        htmlFiles: corpus.files.filter(({ format }) => format === 'html').length,
        markdownFiles: corpus.files.filter(({ format }) => format === 'markdown').length,
        totalBytes: corpus.totalBytes,
      },
      firstPage: firstPageSummary,
      searches: {
        acceptedToRender: interactive.acceptedToRender,
        userObservedFillToRender: interactive.userObservedFillToRender,
      },
      thumbnails: {
        cold: summarizeDurations([thumbnails.coldMs], profile.firstPageTargetMs),
        warm: summarizeDurations([thumbnails.warmMs], profile.firstPageTargetMs),
      },
    }
    await mkdir(dirname(resultsPath), { recursive: true })
    await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(
      `performance-${profile.name} firstPageMedianMs=${firstPageSummary.medianMs.toFixed(2)} ` +
        `firstPageMaxMs=${firstPageSummary.maxMs.toFixed(2)} ` +
        `searchAcceptedWorstMedianMs=${worstMedian(interactive.acceptedToRender).toFixed(2)} ` +
        `searchAcceptedMaxMs=${worstMaximum(interactive.acceptedToRender).toFixed(2)} ` +
        `searchObservedWorstMedianMs=${worstMedian(interactive.userObservedFillToRender).toFixed(2)} ` +
        `searchObservedMaxMs=${worstMaximum(interactive.userObservedFillToRender).toFixed(2)} ` +
        `thumbnailColdMs=${thumbnails.coldMs.toFixed(2)} ` +
        `thumbnailWarmMs=${thumbnails.warmMs.toFixed(2)}\n`,
    )
    assertPerformanceGate({
      profile,
      hardware,
      firstPage: firstPageSummary,
      searches: interactive.acceptedToRender.map(({ summary }) => summary),
      userObservedSearches: interactive.userObservedFillToRender.map(({ summary }) => summary),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function measureColdFirstPages(options: {
  readonly root: string
  readonly corpusDirectory: string
  readonly sourcePaths: readonly string[]
}): Promise<number[]> {
  return runIndependentColdMeasurements(FIRST_PAGE_RUNS, async (run) => {
    const port = await availablePort()
    return {
      measure: async () => {
        const state = await createSeededState(options.root, `cold-${run}-`, options.sourcePaths)
        return runManagedPerformanceScenario<
          ProductionProcess,
          undefined,
          Browser,
          BrowserContext,
          number
        >({
          spawnProcess: () => spawnProductionProcess(state, options.corpusDirectory, port),
          waitForProcess: waitForProductionProcess,
          prepare: async () => undefined,
          launchBrowser: async () => chromium.launch({ headless: true }),
          createContext: async (browser) => browser.newContext(),
          execute: async ({ process: production, context }) => {
            const page = await context.newPage()
            const startedAt = performance.now()
            await page.goto(production.baseUrl)
            await page.locator('.artifact-card').first().waitFor()
            await page.waitForFunction(
              () => document.querySelectorAll('.artifact-card').length === 30,
            )
            const catalog = await page.locator('.result-count').textContent()
            if (catalog !== '100件') {
              throw new Error('The independent cold run did not render the complete corpus count.')
            }
            return performance.now() - startedAt
          },
          closeContext: async (context) => context.close(),
          closeBrowser: async (browser) => browser.close(),
          stopProcess: stopProductionProcess,
          removeState: async () => rm(state.root, { recursive: true, force: true }),
        })
      },
      close: async () => undefined,
    }
  })
}

async function measureInteractiveSearches(options: {
  readonly root: string
  readonly corpusDirectory: string
  readonly sourcePaths: readonly string[]
  readonly queries: readonly string[]
  readonly searchTargetMs: number
}): Promise<{
  acceptedToRender: SearchMeasurement[]
  userObservedFillToRender: SearchMeasurement[]
}> {
  const port = await availablePort()
  const state = await createSeededState(options.root, 'search-', options.sourcePaths)
  return runManagedPerformanceScenario<
    ProductionProcess,
    undefined,
    Browser,
    BrowserContext,
    { acceptedToRender: SearchMeasurement[]; userObservedFillToRender: SearchMeasurement[] }
  >({
    spawnProcess: () => spawnProductionProcess(state, options.corpusDirectory, port),
    waitForProcess: waitForProductionProcess,
    prepare: async () => undefined,
    launchBrowser: async () => chromium.launch({ headless: true }),
    createContext: async (browser) => browser.newContext(),
    execute: async ({ process: production, context }) => {
      const page = await context.newPage()
      await page.goto(production.baseUrl)
      await page.locator('.artifact-card').first().waitFor()
      const searchbox = page.getByRole('searchbox', { name: '生成物を検索' })
      const acceptedByQuery = new Map(options.queries.map((query) => [query, [] as number[]]))
      const observedByQuery = new Map(options.queries.map((query) => [query, [] as number[]]))
      let measurementCount = 0
      for (const query of buildSearchRunSequence(options.queries, SEARCH_RUNS)) {
        const fillStartedAt = performance.now()
        await searchbox.fill(query)
        measurementCount += 1
        await page.waitForFunction(
          (expectedCount) =>
            performance.getEntriesByName('artifact-gallery-search').length >= expectedCount,
          measurementCount,
        )
        const acceptedDuration = await page.evaluate(
          () => performance.getEntriesByName('artifact-gallery-search').at(-1)?.duration,
        )
        if (typeof acceptedDuration !== 'number') {
          throw new Error('The accepted-to-render UI search measure is unavailable.')
        }
        acceptedByQuery.get(query)?.push(acceptedDuration)
        observedByQuery.get(query)?.push(performance.now() - fillStartedAt)
      }
      return {
        acceptedToRender: summarizeSearches(
          options.queries,
          acceptedByQuery,
          options.searchTargetMs,
        ),
        userObservedFillToRender: summarizeSearches(
          options.queries,
          observedByQuery,
          options.searchTargetMs,
        ),
      }
    },
    closeContext: async (context) => context.close(),
    closeBrowser: async (browser) => browser.close(),
    stopProcess: stopProductionProcess,
    removeState: async () => rm(state.root, { recursive: true, force: true }),
  })
}

async function measureThumbnailCases(options: {
  readonly root: string
  readonly corpusDirectory: string
  readonly sourcePaths: readonly string[]
}): Promise<{ coldMs: number; warmMs: number }> {
  const port = await availablePort()
  const state = await createSeededState(options.root, 'thumbnails-', options.sourcePaths)
  return runManagedPerformanceScenario<
    ProductionProcess,
    ThumbnailPreparation,
    Browser,
    BrowserContext,
    { coldMs: number; warmMs: number }
  >({
    spawnProcess: () => spawnProductionProcess(state, options.corpusDirectory, port),
    waitForProcess: waitForProductionProcess,
    prepare: async (production) => {
      const bootstrapResponse = await fetch(production.baseUrl)
      if (!bootstrapResponse.ok) throw new Error('The thumbnail bootstrap is unavailable.')
      const sessionToken = extractBootstrapToken(await bootstrapResponse.text())
      const galleryResponse = await fetch(`${production.baseUrl}/api/gallery`, {
        headers: { 'x-artifact-gallery-token': sessionToken },
      })
      if (!galleryResponse.ok) throw new Error('The thumbnail benchmark gallery is unavailable.')
      const gallery = (await galleryResponse.json()) as GalleryPage
      return {
        sessionToken,
        thumbnailPaths: gallery.items
          .map(({ thumbnailUrl }) => thumbnailUrl)
          .filter((path): path is string => path !== null),
      }
    },
    launchBrowser: async () => chromium.launch({ headless: true }),
    createContext: async (browser, _production, preparation) =>
      browser.newContext({
        extraHTTPHeaders: { 'x-artifact-gallery-token': preparation.sessionToken },
      }),
    execute: async ({ process: production, prepared, context }) => {
      const page = await context.newPage()
      const session = await context.newCDPSession(page)
      await session.send('Network.enable')
      await session.send('Network.setCacheDisabled', { cacheDisabled: true })
      const health = await page.goto(`${production.baseUrl}/api/health`)
      if (!health?.ok()) throw new Error('The thumbnail browser origin is unavailable.')
      return {
        coldMs: await measureThumbnailBatch(page, prepared.thumbnailPaths),
        warmMs: await measureThumbnailBatch(page, prepared.thumbnailPaths),
      }
    },
    closeContext: async (context) => context.close(),
    closeBrowser: async (browser) => browser.close(),
    stopProcess: stopProductionProcess,
    removeState: async () => rm(state.root, { recursive: true, force: true }),
  })
}

async function createSeededState(
  root: string,
  prefix: string,
  sourcePaths: readonly string[],
): Promise<SeededState> {
  const stateRoot = await mkdtemp(join(root, prefix))
  const stateDirectory = join(stateRoot, 'state')
  const databaseFilename = join(stateDirectory, 'catalog.sqlite')
  const thumbnailDirectory = join(stateDirectory, 'thumbnails')
  await mkdir(stateDirectory, { recursive: true })
  await seedCorpus(databaseFilename, thumbnailDirectory, sourcePaths)
  return { root: stateRoot, stateDirectory, databaseFilename, thumbnailDirectory }
}

async function seedCorpus(
  databaseFilename: string,
  thumbnailDirectory: string,
  sourcePaths: readonly string[],
): Promise<void> {
  const database = openDatabase({ filename: databaseFilename })
  const pathPolicy = await PathPolicy.create([dirname(sourcePaths[0] as string)])
  const processor = new ArtifactProcessor({
    database,
    pathPolicy,
    htmlRenderer: {
      render: async ({ html }) => ({
        screenshot: Buffer.from(`RIFF${html.slice(0, 64)}WEBP`),
        width: 1200,
        height: 800,
        warnings: [],
      }),
    },
    thumbnailDirectory,
    thumbnailOptimizer: {
      optimize: async ({ bytes, width, height }) => ({ bytes, width, height, quality: 80 }),
    },
  })
  try {
    for (const sourcePath of sourcePaths) {
      const result = await processor.register({ sourcePath })
      if (result.outcome !== 'completed') {
        throw new Error('Unable to index a performance corpus item.')
      }
    }
  } finally {
    database.close()
  }
}

function spawnProductionProcess(
  state: SeededState,
  corpusDirectory: string,
  port: number,
): ProductionProcess {
  const child = spawn(process.execPath, [resolve('dist/server/server/index.js')], {
    env: buildIsolatedProductionEnvironment(
      process.env,
      {
        stateDirectory: state.stateDirectory,
        databaseFilename: state.databaseFilename,
        thumbnailDirectory: state.thumbnailDirectory,
        allowedRoots: [corpusDirectory],
        clientDirectory: resolve('dist'),
      },
      port,
    ),
    stdio: 'ignore',
  })
  const exited = observeChildExit(child)
  return { baseUrl: `http://127.0.0.1:${port}`, child, exited }
}

async function waitForProductionProcess(production: ProductionProcess): Promise<void> {
  const port = Number(new URL(production.baseUrl).port)
  await waitForProductionPort(port, production.exited)
}

async function waitForProductionPort(port: number, exited: Promise<unknown>): Promise<void> {
  const deadline = Date.now() + PROCESS_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const attempt = new Promise<boolean>((resolveAttempt) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(Math.min(500, Math.max(1, deadline - Date.now())))
      socket.once('connect', () => {
        socket.destroy()
        resolveAttempt(true)
      })
      socket.once('error', () => resolveAttempt(false))
      socket.once('timeout', () => {
        socket.destroy()
        resolveAttempt(false)
      })
    })
    const outcome = await Promise.race([
      attempt.then((ready) => ({ kind: 'socket' as const, ready })),
      exited.then(() => ({ kind: 'exit' as const, ready: false })),
    ])
    if (outcome.kind === 'exit') throw new Error('A production performance process exited early.')
    if (outcome.ready) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  throw new Error('Timed out waiting for a production performance process.')
}

async function stopProductionProcess(production: ProductionProcess): Promise<void> {
  await terminateChildProcess(production.child, {
    exited: production.exited,
    sigtermTimeoutMs: PROCESS_TERM_TIMEOUT_MS,
    sigkillTimeoutMs: PROCESS_KILL_TIMEOUT_MS,
  })
}

async function measureThumbnailBatch(page: Page, paths: readonly string[]): Promise<number> {
  return page.evaluate(async (thumbnailPaths) => {
    const startedAt = performance.now()
    for (const path of thumbnailPaths) {
      const response = await fetch(path)
      if (!response.ok) throw new Error('A benchmark thumbnail was unavailable.')
      await response.arrayBuffer()
    }
    return performance.now() - startedAt
  }, paths)
}

function summarizeSearches(
  queries: readonly string[],
  durationsByQuery: ReadonlyMap<string, readonly number[]>,
  targetMs: number,
): SearchMeasurement[] {
  return queries.map((query) => ({
    query,
    summary: summarizeDurations(durationsByQuery.get(query) ?? [], targetMs),
  }))
}

function worstMedian(measurements: readonly SearchMeasurement[]): number {
  return Math.max(...measurements.map(({ summary }) => summary.medianMs))
}

function worstMaximum(measurements: readonly SearchMeasurement[]): number {
  return Math.max(...measurements.map(({ summary }) => summary.maxMs))
}

function readProfile(arguments_: readonly string[]): PerformanceProfileName {
  const value = arguments_
    .find((argument) => argument.startsWith('--profile='))
    ?.slice('--profile='.length)
  if (value === 'smoke' || value === 'acceptance') return value
  throw new Error('Use --profile=smoke or --profile=acceptance.')
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown failure'
  process.stderr.write(`performance failed: ${message}\n`)
  process.exitCode = 1
})
