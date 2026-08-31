import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'

import { openDatabase } from '../db/database.js'
import { HtmlRenderer } from '../rendering/html-renderer.js'
import { ImportRepository } from '../repositories/import-repository.js'
import { PathPolicy } from '../security/path-policy.js'
import { createServerRuntime } from '../runtime.js'
import type { ProcessingStage } from '../../shared/errors.js'
import { ArtifactProcessor } from './artifact-processor.js'
import { ImportWorker } from './worker.js'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('production crash recovery matrix', () => {
  it.each(['inspect', 'extract', 'render', 'index', 'commit'] as const)(
    'force-terminates at %s and exposes interrupted terminal state after a real restart',
    async (stage) => {
      const root = await mkdtemp(join(tmpdir(), `artifact-gallery-crash-${stage}-`))
      temporaryDirectories.push(root)
      const sourcePath = join(root, 'source.html')
      const thumbnailDirectory = join(root, 'derived')
      const databaseFilename = join(root, 'gallery.sqlite')
      await mkdir(thumbnailDirectory)
      await writeFile(join(root, 'gate.css'), 'body { color: navy }')
      await writeFile(sourcePath, '<link rel="stylesheet" href="./gate.css"><h1>Crash</h1>')
      const fixture = fileURLToPath(
        new URL('../../../tests/fixtures/reliability-forced-termination.ts', import.meta.url),
      )
      const child = spawn(process.execPath, [
        '--import',
        'tsx',
        fixture,
        stage,
        databaseFilename,
        sourcePath,
        thumbnailDirectory,
      ])
      const state = await readReadyState(child, stage)

      expect(child.kill('SIGKILL')).toBe(true)
      await once(child, 'exit')

      const reports: unknown[] = []
      const app = await createServerRuntime({
        databaseFilename,
        thumbnailDirectory,
        allowedRoots: [root],
        port: 4173,
        reportRecovery: (report) => {
          reports.push(report)
        },
      })
      const response = await app.inject({
        method: 'GET',
        url: `/api/imports/${state.runId}`,
        headers: {
          host: '127.0.0.1:4173',
          'x-artifact-gallery-token': app.sessionToken,
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        id: state.runId,
        status: 'interrupted',
        items: [{ id: state.itemId, stage, status: 'interrupted' }],
      })
      expect(reports).toEqual([
        expect.objectContaining({
          interruptedRunIds: [state.runId],
          interruptedItemIds: [state.itemId],
          interruptedGenerationIds: stage === 'inspect' ? [] : [expect.any(Number)],
        }),
      ])
      await app.close()
    },
    20_000,
  )
})

describe('production worker with real Chromium', () => {
  it('uses one browser and at most two contexts while measuring RSS and cancellation latency under load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-worker-load-'))
    temporaryDirectories.push(root)
    const thumbnailDirectory = join(root, 'derived')
    await mkdir(thumbnailDirectory)
    const sourcePaths = await Promise.all(
      [1, 2, 3].map(async (id) => {
        const sourcePath = join(root, `source-${id}.html`)
        await writeFile(join(root, `gate-${id}.css`), 'body { color: teal }')
        await writeFile(
          sourcePath,
          `<link rel="stylesheet" href="./gate-${id}.css"><h1>Item ${id}</h1>`,
        )
        return sourcePath
      }),
    )
    const database = openDatabase({ filename: join(root, 'gallery.sqlite') })
    const realPolicy = await PathPolicy.create([root])
    const releases = new Map<number, () => void>()
    let readsStarted = 0
    let resolveFirstTwo!: () => void
    let resolveThird!: () => void
    const firstTwoStarted = new Promise<void>((resolve) => {
      resolveFirstTwo = resolve
    })
    const thirdStarted = new Promise<void>((resolve) => {
      resolveThird = resolve
    })
    const launchedBrowsers: Browser[] = []
    const commitCriticalSectionMs: number[] = []
    let peakContexts = 0
    const renderer = new HtmlRenderer(
      {
        authorizeAsset: async (requestedPath) => {
          const asset = await realPolicy.authorizeAsset(requestedPath)
          const itemId = Number(/gate-(\d+)\.css$/u.exec(requestedPath)?.[1])
          return {
            canonicalPath: asset.canonicalPath,
            mimeType: asset.mimeType,
            read: async (maxBytes?: number) => {
              readsStarted += 1
              peakContexts = Math.max(
                peakContexts,
                ...launchedBrowsers.map((browser) => browser.contexts().length),
              )
              if (readsStarted === 2) resolveFirstTwo()
              if (readsStarted === 3) resolveThird()
              await new Promise<void>((resolve) => releases.set(itemId, resolve))
              return asset.read(maxBytes)
            },
          }
        },
      },
      {
        launchBrowser: async () => {
          const browser = await chromium.launch({ headless: true })
          launchedBrowsers.push(browser)
          return browser
        },
      },
    )
    const processor = new ArtifactProcessor({
      database,
      pathPolicy: realPolicy,
      htmlRenderer: renderer,
      thumbnailDirectory,
      reportCommitCriticalSection: ({ durationMs }) => {
        commitCriticalSectionMs.push(durationMs)
      },
    })
    const worker = new ImportWorker({ processor, concurrency: 2, capacity: 4 })
    const imports = new ImportRepository(database)
    const runs = sourcePaths.map((sourcePath) => imports.createRun([sourcePath]))
    const rssSampler = startPeriodicPeakSampler(() => chromiumDescendantRssBytes(process.pid), 100)
    let rssMeasurement!: Awaited<ReturnType<typeof rssSampler.stop>>
    let cancelLatencyMs = 0
    try {
      runs.forEach((run, index) => {
        worker.enqueue('register', {
          sourcePath: sourcePaths[index] as string,
          runId: run.id,
          itemId: run.itemIds[0],
        })
      })

      await firstTwoStarted
      expect(launchedBrowsers).toHaveLength(1)
      expect(launchedBrowsers[0]?.contexts()).toHaveLength(2)
      expect(imports.getItem(runs[2]!.itemIds[0]).status).toBe('queued')

      const cancelStartedAt = performance.now()
      imports.requestCancellation(runs[0]!.id, new Date().toISOString())
      releases.get(1)?.()
      await waitForTerminal(imports, runs[0]!.id)
      cancelLatencyMs = performance.now() - cancelStartedAt
      expect(imports.getRun(runs[0]!.id).status).toBe('cancelled')
      expect(cancelLatencyMs).toBeLessThan(1_500)

      releases.get(2)?.()
      await thirdStarted
      releases.get(3)?.()
      await worker.onIdle()
    } finally {
      rssMeasurement = await rssSampler.stop()
    }
    expect(rssMeasurement.sampleCount).toBeGreaterThan(1)
    expect(rssMeasurement.peakBytes).toBe(Math.max(...rssMeasurement.samples))
    expect(rssMeasurement.peakBytes).toBeGreaterThan(0)
    expect(rssMeasurement.peakBytes).toBeLessThan(4 * 1024 * 1024 * 1024)
    expect(commitCriticalSectionMs.length).toBeGreaterThan(1)
    const maxCommitCriticalSectionMs = Math.max(...commitCriticalSectionMs)
    expect(maxCommitCriticalSectionMs).toBeLessThan(250)
    expect(peakContexts).toBe(2)
    expect(launchedBrowsers).toHaveLength(1)
    expect(launchedBrowsers[0]?.contexts()).toHaveLength(0)
    expect(imports.getRun(runs[1]!.id).status).toBe('completed')
    expect(imports.getRun(runs[2]!.id).status).toBe('completed')
    console.info(
      `task9-reliability chromiumPeakRssMiB=${(rssMeasurement.peakBytes / 1024 / 1024).toFixed(1)} rssSamples=${rssMeasurement.sampleCount} cancelLatencyMs=${cancelLatencyMs.toFixed(1)} commitCriticalMaxMs=${maxCommitCriticalSectionMs.toFixed(2)}`,
    )

    await worker.close()
    await renderer.close()
    database.close()
  }, 20_000)

  it('relaunches after an isolated browser crash and lets the worker complete the next item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-worker-crash-'))
    temporaryDirectories.push(root)
    const thumbnailDirectory = join(root, 'derived')
    await mkdir(thumbnailDirectory)
    const crashSource = join(root, 'crash.html')
    const recoverySource = join(root, 'recovery.html')
    await writeFile(join(root, 'crash.css'), 'body { color: red }')
    await writeFile(crashSource, '<link rel="stylesheet" href="./crash.css"><h1>Crash</h1>')
    await writeFile(recoverySource, '<h1>Recovered</h1>')
    const database = openDatabase({ filename: join(root, 'gallery.sqlite') })
    const realPolicy = await PathPolicy.create([root])
    const launchedBrowsers: Browser[] = []
    let crashed = false
    const renderer = new HtmlRenderer(
      {
        authorizeAsset: async (requestedPath) => {
          const asset = await realPolicy.authorizeAsset(requestedPath)
          if (!crashed) {
            crashed = true
            await launchedBrowsers[0]?.close()
          }
          return asset
        },
      },
      {
        launchBrowser: async () => {
          const browser = await chromium.launch({ headless: true })
          launchedBrowsers.push(browser)
          return browser
        },
      },
    )
    const processor = new ArtifactProcessor({
      database,
      pathPolicy: realPolicy,
      htmlRenderer: renderer,
      thumbnailDirectory,
    })
    const worker = new ImportWorker({ processor, concurrency: 1 })
    const imports = new ImportRepository(database)
    const crashRun = imports.createRun([crashSource])
    const recoveryRun = imports.createRun([recoverySource])

    worker.enqueue('register', {
      sourcePath: crashSource,
      runId: crashRun.id,
      itemId: crashRun.itemIds[0],
    })
    worker.enqueue('register', {
      sourcePath: recoverySource,
      runId: recoveryRun.id,
      itemId: recoveryRun.itemIds[0],
    })
    await worker.onIdle()

    expect(imports.getRun(crashRun.id).status).toBe('failed')
    expect(imports.getRun(recoveryRun.id).status).toBe('completed')
    expect(launchedBrowsers).toHaveLength(2)
    expect(launchedBrowsers[1]?.contexts()).toHaveLength(0)
    await worker.close()
    await renderer.close()
    database.close()
  }, 20_000)
})

async function readReadyState(
  child: ReturnType<typeof spawn>,
  expectedStage: ProcessingStage,
): Promise<{ runId: number; itemId: number }> {
  if (!child.stdout) throw new Error('Fixture stdout is not piped.')
  const event = await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => ({ chunk: chunk as Buffer })),
    once(child, 'exit').then(([code]) => ({ code })),
  ])
  if (!('chunk' in event)) {
    throw new Error(`Fixture exited ${String(event.code)} before READY.`)
  }
  const chunk = event.chunk
  const line = chunk.toString('utf8').trim()
  if (!line.startsWith('READY ')) {
    throw new Error(`Fixture emitted invalid READY state: ${line}`)
  }
  const state = JSON.parse(line.slice('READY '.length)) as {
    runId: number
    itemId: number
    stage: ProcessingStage
  }
  expect(state.stage).toBe(expectedStage)
  return state
}

async function waitForTerminal(imports: ImportRepository, runId: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(imports.getRun(runId).status)
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Run ${runId} did not become terminal.`)
}

async function chromiumDescendantRssBytes(parentPid: number): Promise<number> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command='])
  const rows = stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssKiB: Number(match[3]),
      command: match[4] ?? '',
    }))
  const descendants = new Set([parentPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return (
    rows
      .filter(
        (row) =>
          descendants.has(row.pid) && /(?:chromium|chrome-headless|Chromium)/u.test(row.command),
      )
      .reduce((total, row) => total + row.rssKiB, 0) * 1024
  )
}

function startPeriodicPeakSampler(
  sample: () => Promise<number>,
  intervalMs: number,
): {
  stop(): Promise<{ samples: readonly number[]; sampleCount: number; peakBytes: number }>
} {
  const samples: number[] = []
  let stopped = false
  let failure: unknown
  let timer: ReturnType<typeof setTimeout> | undefined
  let sampling: Promise<void> | undefined
  const scheduleSample = () => {
    sampling = sample()
      .then((bytes) => {
        samples.push(bytes)
      })
      .catch((error: unknown) => {
        failure ??= error
      })
      .finally(() => {
        sampling = undefined
        if (!stopped) timer = setTimeout(scheduleSample, intervalMs)
      })
  }
  scheduleSample()
  return {
    stop: async () => {
      if (!stopped) {
        stopped = true
        if (timer) clearTimeout(timer)
      }
      await sampling
      if (failure) throw failure
      samples.push(await sample())
      return {
        samples,
        sampleCount: samples.length,
        peakBytes: Math.max(...samples),
      }
    },
  }
}
