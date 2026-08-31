import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/database.js'
import { ImportRepository } from '../repositories/import-repository.js'
import { PathPolicy } from '../security/path-policy.js'
import { ArtifactProcessor } from './artifact-processor.js'
import type { ArtifactProcessRequest, ArtifactProcessResult } from './artifact-processor.js'
import { ImportWorker } from './worker.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

const RESULT: ArtifactProcessResult = {
  outcome: 'completed',
  artifactId: 1,
  generationId: 1,
  generation: 1,
  contentStatus: 'ready',
  renderStatus: 'ready',
  indexStatus: 'ready',
  title: 'worker',
  thumbnailPath: null,
  errors: [],
}

describe('ImportWorker', () => {
  it('owns bounded processing, serializes one source, and drains on close', async () => {
    const releases: Array<() => void> = []
    let active = 0
    let peak = 0
    const starts: string[] = []
    const processor = processorWith(async (request) => {
      starts.push(request.sourcePath)
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return RESULT
    })
    const worker = new ImportWorker({ processor, concurrency: 2, capacity: 4 })

    expect(worker.enqueue('register', { sourcePath: '/same.md' })).toBe(true)
    expect(worker.enqueue('register', { sourcePath: '/other.md' })).toBe(true)
    expect(worker.enqueue('refresh', { sourcePath: '/same.md' })).toBe(true)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(starts).toEqual(['/same.md', '/other.md'])
    expect(peak).toBe(2)
    const closing = worker.close()
    expect(worker.enqueue('register', { sourcePath: '/late.md' })).toBe(false)
    releases.splice(0).forEach((release) => release())
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(starts).toEqual(['/same.md', '/other.md', '/same.md'])
    releases.splice(0).forEach((release) => release())
    await closing
  })

  it('caps every processing attempt and aborts the owned processor call', async () => {
    let observedAbort = false
    const worker = new ImportWorker({
      processor: processorWith(
        (request) =>
          new Promise<ArtifactProcessResult>((_resolve, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => {
                observedAbort = true
                reject(request.signal?.reason)
              },
              { once: true },
            )
          }),
      ),
      attemptTimeoutMs: 20,
    })
    const failures: unknown[] = []

    expect(
      worker.enqueue('register', { sourcePath: '/slow.md' }, {
        onError: (error) => {
          failures.push(error)
        },
      }),
    ).toBe(true)
    await worker.onIdle()

    expect(observedAbort).toBe(true)
    expect(failures).toEqual([
      expect.objectContaining({ code: 'TIMEOUT', stage: 'inspect' }),
    ])
    await worker.close()
  })

  it('turns a real SQLite/filesystem processor deadline into a durable terminal result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-worker-'))
    temporaryDirectories.push(root)
    const sourcePath = join(root, 'slow.md')
    const thumbnailDirectory = join(root, 'derived')
    await mkdir(thumbnailDirectory)
    await writeFile(sourcePath, '# Slow render')
    const database = openDatabase({ filename: join(root, 'gallery.sqlite') })
    const pathPolicy = await PathPolicy.create([root])
    const processor = new ArtifactProcessor({
      database,
      pathPolicy,
      htmlRenderer: {
        render: (request) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(request.signal?.reason),
              { once: true },
            )
          }),
      },
      thumbnailDirectory,
    })
    const imports = new ImportRepository(database)
    const run = imports.createRun([sourcePath])
    const results: ArtifactProcessResult[] = []
    const failures: unknown[] = []
    const worker = new ImportWorker({ processor, attemptTimeoutMs: 30 })

    expect(
      worker.enqueue(
        'register',
        { sourcePath, runId: run.id, itemId: run.itemIds[0] },
        {
          onResult: (result) => {
            results.push(result)
          },
          onError: (error) => {
            failures.push(error)
          },
        },
      ),
    ).toBe(true)
    await worker.onIdle()

    expect(failures).toEqual([])
    expect(results).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        errors: [expect.objectContaining({ code: 'TIMEOUT', stage: 'render' })],
      }),
    ])
    expect(imports.getRun(run.id).status).toBe('failed')
    expect(imports.getItem(run.itemIds[0]).status).toBe('failed')
    await worker.close()
    database.close()
  })
})

function processorWith(
  operation: (request: ArtifactProcessRequest & { signal?: AbortSignal }) => Promise<ArtifactProcessResult>,
) {
  return {
    register: operation,
    refresh: operation,
    retry: operation,
    rebuild: operation,
  }
}
