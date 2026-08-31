import { createServer } from 'node:net'
import { cpus, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'

import { chromium, type Browser } from 'playwright'

import type { GalleryPage } from '../../src/shared/contracts.js'
import { openDatabase } from '../../src/server/db/database.js'
import { ArtifactProcessor } from '../../src/server/processing/artifact-processor.js'
import { PathPolicy } from '../../src/server/security/path-policy.js'
import { createServerRuntime } from '../../src/server/runtime.js'
import {
  assertPerformanceGate,
  buildSearchRunSequence,
  createPerformanceCorpus,
  performanceProfile,
  summarizeDurations,
  type DurationSummary,
  type PerformanceProfileName,
} from './harness.js'

const FIRST_PAGE_RUNS = 5
const SEARCH_RUNS = 10
const DEFAULT_RESULTS_PATH = 'test-results/performance/results.json'

interface SearchMeasurement {
  readonly query: string
  readonly summary: DurationSummary
}

async function main(): Promise<void> {
  const profileName = readProfile(process.argv.slice(2))
  const profile = performanceProfile(profileName)
  const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-performance-'))
  const corpusDirectory = join(root, 'corpus')
  const stateDirectory = join(root, 'state')
  const databaseFilename = join(stateDirectory, 'catalog.sqlite')
  const thumbnailDirectory = join(stateDirectory, 'thumbnails')
  const resultsPath = process.env.ARTIFACT_GALLERY_PERF_RESULTS ?? DEFAULT_RESULTS_PATH
  try {
    const corpus = await createPerformanceCorpus(corpusDirectory)
    await mkdir(stateDirectory, { recursive: true })
    await seedCorpus(
      databaseFilename,
      thumbnailDirectory,
      corpus.files.map(({ absolutePath }) => absolutePath),
    )
    const browser = await chromium.launch({ headless: true })
    let firstPageDurations: number[]
    let searches: SearchMeasurement[]
    let coldThumbnailMs: number
    let warmThumbnailMs: number
    try {
      firstPageDurations = await measureColdFirstPages(browser, {
        databaseFilename,
        thumbnailDirectory,
        corpusDirectory,
      })
      const interactive = await measureInteractiveCases(browser, {
        databaseFilename,
        thumbnailDirectory,
        corpusDirectory,
        queries: [...new Set(corpus.files.map(({ query }) => query))],
        searchTargetMs: profile.searchTargetMs,
      })
      searches = interactive.searches
      coldThumbnailMs = interactive.coldThumbnailMs
      warmThumbnailMs = interactive.warmThumbnailMs
    } finally {
      await browser.close()
    }

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
      corpus: {
        htmlFiles: corpus.files.filter(({ format }) => format === 'html').length,
        markdownFiles: corpus.files.filter(({ format }) => format === 'markdown').length,
        totalBytes: corpus.totalBytes,
      },
      firstPage: firstPageSummary,
      searches,
      thumbnails: {
        cold: summarizeDurations([coldThumbnailMs], profile.firstPageTargetMs),
        warm: summarizeDurations([warmThumbnailMs], profile.firstPageTargetMs),
      },
    }
    await mkdir(dirname(resultsPath), { recursive: true })
    await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(
      `performance-${profile.name} firstPageMedianMs=${firstPageSummary.medianMs.toFixed(2)} ` +
        `firstPageMaxMs=${firstPageSummary.maxMs.toFixed(2)} ` +
        `searchWorstMedianMs=${Math.max(...searches.map(({ summary }) => summary.medianMs)).toFixed(2)} ` +
        `searchMaxMs=${Math.max(...searches.map(({ summary }) => summary.maxMs)).toFixed(2)} ` +
        `thumbnailColdMs=${coldThumbnailMs.toFixed(2)} thumbnailWarmMs=${warmThumbnailMs.toFixed(2)}\n`,
    )
    assertPerformanceGate({
      profile,
      hardware,
      firstPage: firstPageSummary,
      searches: searches.map(({ summary }) => summary),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

interface RuntimeMeasurementOptions {
  readonly databaseFilename: string
  readonly thumbnailDirectory: string
  readonly corpusDirectory: string
}

async function measureColdFirstPages(
  browser: Browser,
  options: RuntimeMeasurementOptions,
): Promise<number[]> {
  const durations: number[] = []
  for (let run = 0; run < FIRST_PAGE_RUNS; run += 1) {
    const port = await availablePort()
    const startedAt = performance.now()
    const app = await createServerRuntime({
      ...options,
      allowedRoots: [options.corpusDirectory],
      clientDirectory: resolve('dist'),
      port,
    })
    const context = await browser.newContext()
    try {
      await app.listen({ host: '127.0.0.1', port })
      const page = await context.newPage()
      await page.goto(`http://127.0.0.1:${port}`)
      await page.locator('.artifact-card').first().waitFor()
      const counts = await page.evaluate(() => ({
        cards: document.querySelectorAll('.artifact-card').length,
        catalog: document.querySelector('.result-count')?.textContent,
      }))
      if (counts.cards !== 30 || counts.catalog !== '100件') {
        throw new Error('The performance corpus was not visible in the first gallery page.')
      }
      durations.push(performance.now() - startedAt)
    } finally {
      await context.close()
      await app.close()
    }
  }
  return durations
}

async function measureInteractiveCases(
  browser: Browser,
  options: RuntimeMeasurementOptions & {
    readonly queries: readonly string[]
    readonly searchTargetMs: number
  },
): Promise<{
  searches: SearchMeasurement[]
  coldThumbnailMs: number
  warmThumbnailMs: number
}> {
  const port = await availablePort()
  const app = await createServerRuntime({
    ...options,
    allowedRoots: [options.corpusDirectory],
    clientDirectory: resolve('dist'),
    port,
  })
  const context = await browser.newContext()
  try {
    await app.listen({ host: '127.0.0.1', port })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${port}`)
    await page.locator('.artifact-card').first().waitFor()
    const searchbox = page.getByRole('searchbox', { name: '生成物を検索' })
    const durationsByQuery = new Map(options.queries.map((query) => [query, [] as number[]]))
    let measurementCount = 0
    for (const query of buildSearchRunSequence(options.queries, SEARCH_RUNS)) {
      await searchbox.fill(query)
      measurementCount += 1
      await page.waitForFunction(
        (expectedCount) =>
          performance.getEntriesByName('artifact-gallery-search').length >= expectedCount,
        measurementCount,
      )
      const duration = await page.evaluate(
        () => performance.getEntriesByName('artifact-gallery-search').at(-1)?.duration,
      )
      if (typeof duration !== 'number') throw new Error('The UI search measure is unavailable.')
      durationsByQuery.get(query)?.push(duration)
    }
    const searches = options.queries.map((query) => ({
      query,
      summary: summarizeDurations(durationsByQuery.get(query) ?? [], options.searchTargetMs),
    }))
    const currentPageResponse = await app.inject({
      method: 'GET',
      url: '/api/gallery',
      headers: authenticatedHeaders(app.sessionToken, port),
    })
    const currentPage = currentPageResponse.json<GalleryPage>()
    const thumbnailPaths = currentPage.items
      .map(({ thumbnailUrl }) => thumbnailUrl)
      .filter((path): path is string => path !== null)
    return {
      searches,
      coldThumbnailMs: await measureThumbnailBatch(app, thumbnailPaths, port),
      warmThumbnailMs: await measureThumbnailBatch(app, thumbnailPaths, port),
    }
  } finally {
    await context.close()
    await app.close()
  }
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
        throw new Error(`Unable to index performance corpus item ${sourcePath}.`)
      }
    }
  } finally {
    database.close()
  }
}

async function measureThumbnailBatch(
  app: Awaited<ReturnType<typeof createServerRuntime>>,
  paths: readonly string[],
  port: number,
): Promise<number> {
  const startedAt = performance.now()
  for (const path of paths) {
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: authenticatedHeaders(app.sessionToken, port),
    })
    if (response.statusCode !== 200) throw new Error('A benchmark thumbnail was unavailable.')
  }
  return performance.now() - startedAt
}

function authenticatedHeaders(sessionToken: string, port: number): Record<string, string> {
  return { host: `127.0.0.1:${port}`, 'x-artifact-gallery-token': sessionToken }
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
