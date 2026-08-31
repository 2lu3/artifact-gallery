import { existsSync, renameSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactProcessingError } from '../../shared/errors.js'
import { openDatabase } from '../db/database.js'
import { MarkdownRenderer } from '../rendering/markdown-renderer.js'
import { ArtifactRepository } from '../repositories/artifact-repository.js'
import { ImportRepository } from '../repositories/import-repository.js'
import { SearchVisibilityRepository } from '../repositories/search-visibility-repository.js'
import { PathPolicy } from '../security/path-policy.js'
import {
  ArtifactProcessor,
  type ArtifactIndexer,
  type ProcessingOperationalError,
  type ProcessorFileSystem,
} from './artifact-processor.js'
import { MAX_THUMBNAIL_BYTES, type ThumbnailOptimizer } from './thumbnail-optimizer.js'

const temporaryDirectories: string[] = []
const NOW = '2026-09-01T00:00:00.000Z'

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('ArtifactProcessor staged pipeline', () => {
  it('uses the prepared SQLite indexer by default and commits its generation row atomically', async () => {
    const harness = await makeHarness({ useDefaultIndexer: true })
    await writeFile(harness.sourcePath, '# Default searchable title\n\nＡＴＯＭＩＣ body.')

    const result = await harness.processor.register({ sourcePath: harness.sourcePath })

    expect(result.outcome).toBe('completed')
    expect(
      harness.database
        .prepare(
          `SELECT body_normalized, derived_title_normalized
           FROM artifact_search_document WHERE generation_id = ?`,
        )
        .get(result.generationId),
    ).toEqual({
      body_normalized: 'default searchable title\natomic body.',
      derived_title_normalized: 'default searchable title',
    })
    harness.database.close()
  })

  it('routes register, refresh, retry, and rebuild through inspect → extract → render → index → commit', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# Source title\n\nBody text.')

    const results = [
      await harness.processor.register({ sourcePath: harness.sourcePath }),
      await harness.processor.refresh({ sourcePath: harness.sourcePath }),
      await harness.processor.retry({ sourcePath: harness.sourcePath }),
      await harness.processor.rebuild({ sourcePath: harness.sourcePath }),
    ]

    expect(results.map((result) => result.outcome)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ])
    expect(results.map((result) => result.generation)).toEqual([1, 2, 3, 4])
    expect(
      harness.database
        .prepare(
          `SELECT import_item.stage, import_item.status
           FROM import_item ORDER BY import_item.id`,
        )
        .all(),
    ).toEqual([
      { stage: 'commit', status: 'completed' },
      { stage: 'commit', status: 'completed' },
      { stage: 'commit', status: 'completed' },
      { stage: 'commit', status: 'completed' },
    ])
    expect(
      harness.database
        .prepare(
          `SELECT derived_title, generation_counter
           FROM artifact WHERE id = ?`,
        )
        .get(results[0]?.artifactId),
    ).toEqual({ derived_title: 'Source title', generation_counter: 4 })
    expect(
      harness.database
        .prepare(
          `SELECT job_status, content_status, render_status, index_status, extracted_text
           FROM artifact_generation ORDER BY generation DESC LIMIT 1`,
        )
        .get(),
    ).toEqual({
      job_status: 'idle',
      content_status: 'ready',
      render_status: 'ready',
      index_status: 'ready',
      extracted_text: 'Source title\nBody text.',
    })

    harness.database.close()
  })

  it('applies user title, document title, then filename fallback in precedence order', async () => {
    const harness = await makeHarness({ sourceName: 'fallback-name.html' })
    await writeFile(
      harness.sourcePath,
      '<html><head><title>Document title</title><title>Ignored later title</title></head><body><h1>Visible</h1></body></html>',
    )

    const first = await harness.processor.register({
      sourcePath: harness.sourcePath,
      userTitle: 'Chosen title',
    })
    const artifactId = requireResultNumber(first.artifactId)
    expect(readTitle(harness.database, artifactId)).toEqual({
      user_title: 'Chosen title',
      derived_title: 'Chosen title',
    })

    harness.database
      .prepare('UPDATE artifact SET user_title = NULL WHERE id = ?')
      .run(first.artifactId)
    await harness.processor.refresh({ sourcePath: harness.sourcePath })
    expect(readTitle(harness.database, artifactId)).toEqual({
      user_title: null,
      derived_title: 'Document title',
    })

    await writeFile(harness.sourcePath, '<html><body>No title</body></html>')
    await harness.processor.refresh({ sourcePath: harness.sourcePath })
    expect(readTitle(harness.database, artifactId)).toEqual({
      user_title: null,
      derived_title: 'fallback-name.html',
    })

    harness.database.close()
  })

  it('maps inspect, extract, render, and index failures while committing independent partial results', async () => {
    const inspectHarness = await makeHarness()
    const outsidePath = join(await temporaryDirectory(), 'outside.md')
    await writeFile(outsidePath, '# Outside')
    const inspect = await inspectHarness.processor.register({ sourcePath: outsidePath })
    expect(inspect).toMatchObject({ outcome: 'failed' })
    expect(inspect.errors).toMatchObject([{ code: 'OUTSIDE_ALLOWED_ROOT', stage: 'inspect' }])
    inspectHarness.database.close()

    const extractHarness = await makeHarness()
    await writeFile(extractHarness.sourcePath, 'before\0after')
    const extract = await extractHarness.processor.register({
      sourcePath: extractHarness.sourcePath,
      userTitle: 'Title survives extraction failure',
    })
    expect(extract).toMatchObject({ outcome: 'failed' })
    expect(extract.errors).toMatchObject([{ code: 'MARKDOWN_PARSE_FAILED', stage: 'extract' }])
    expect(
      readTitle(extractHarness.database, requireResultNumber(extract.artifactId)),
    ).toMatchObject({ derived_title: 'Title survives extraction failure' })
    extractHarness.database.close()

    const renderHarness = await makeHarness({
      render: async () => {
        throw Object.assign(new Error('chromium crashed at /private/path'), {
          code: 'HTML_RENDER_FAILED',
        })
      },
    })
    await writeFile(renderHarness.sourcePath, '# Render failure\n\nIndexable.')
    const render = await renderHarness.processor.register({ sourcePath: renderHarness.sourcePath })
    expect(render).toMatchObject({
      outcome: 'partial',
      contentStatus: 'ready',
      renderStatus: 'failed',
      indexStatus: 'ready',
    })
    expect(render.errors).toEqual([
      {
        code: 'HTML_RENDER_FAILED',
        stage: 'render',
        retryable: true,
        message: 'The preview could not be rendered.',
      },
    ])
    expect(JSON.stringify(render)).not.toContain('/private/path')
    expect(JSON.stringify(render)).not.toContain('technicalDetail')
    expect(render).not.toHaveProperty('publicErrors')
    renderHarness.database.close()

    const indexHarness = await makeHarness({
      indexer: {
        prepare: async () => {
          throw new Error('search backend unavailable')
        },
      },
    })
    await writeFile(indexHarness.sourcePath, '# Index failure')
    const index = await indexHarness.processor.register({ sourcePath: indexHarness.sourcePath })
    expect(index).toMatchObject({
      outcome: 'partial',
      contentStatus: 'ready',
      renderStatus: 'ready',
      indexStatus: 'failed',
    })
    expect(index.errors).toMatchObject([{ code: 'INDEX_UPDATE_FAILED', stage: 'index' }])
    indexHarness.database.close()
  })

  it.each(['inspect', 'extract', 'render', 'index', 'commit'] as const)(
    'records cancellation before %s work starts and leaves no thumbnail temp file',
    async (cancelledStage) => {
      const harness = await makeHarness()
      await writeFile(harness.sourcePath, '# Cancellation')
      const imports = new ImportRepository(harness.database)
      const run = imports.createRun([harness.sourcePath])
      imports.startRun(run.id, NOW)
      const requestCancellation = () => imports.requestCancellation(run.id, NOW)

      if (cancelledStage === 'inspect') requestCancellation()
      harness.controls.cancelAfterInspect =
        cancelledStage === 'extract' ? requestCancellation : undefined
      harness.controls.cancelAfterExtract =
        cancelledStage === 'render' ? requestCancellation : undefined
      harness.controls.cancelAfterRender =
        cancelledStage === 'index' ? requestCancellation : undefined
      harness.controls.cancelAfterIndex =
        cancelledStage === 'commit' ? requestCancellation : undefined

      const result = await harness.processor.register({
        sourcePath: harness.sourcePath,
        runId: run.id,
        itemId: run.itemIds[0],
      })

      expect(result.outcome).toBe('cancelled')
      expect(result.errors.at(-1)).toMatchObject({ code: 'CANCELLED', stage: cancelledStage })
      expect(imports.getItem(run.itemIds[0])).toMatchObject({ status: 'cancelled' })
      expect(imports.getRun(run.id)).toMatchObject({ status: 'cancelled' })
      expect(
        (await readdir(harness.derivedDirectory)).filter((name) => name.includes('.tmp')),
      ).toEqual([])
      harness.database.close()
    },
  )

  it('finishes non-interruptible render work before recording cancellation at the next boundary', async () => {
    let renderFinished = false
    const harness = await makeHarness({
      render: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        renderFinished = true
        harness.controls.cancelAfterRender?.()
        return rendered(Buffer.from('RIFF-render-finished-WEBP'))
      },
    })
    await writeFile(harness.sourcePath, '# Delayed render')
    const imports = new ImportRepository(harness.database)
    const run = imports.createRun([harness.sourcePath])
    imports.startRun(run.id, NOW)
    harness.controls.cancelAfterRender = () => imports.requestCancellation(run.id, NOW)

    const result = await harness.processor.register({
      sourcePath: harness.sourcePath,
      runId: run.id,
      itemId: run.itemIds[0],
    })

    expect(renderFinished).toBe(true)
    expect(result).toMatchObject({ outcome: 'cancelled' })
    expect(result.errors.at(-1)).toMatchObject({ code: 'CANCELLED', stage: 'index' })
    harness.database.close()
  })

  it('records a worker deadline during render as a durable TIMEOUT and starts no later stage', async () => {
    let indexStarted = false
    let markRenderStarted!: () => void
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve
    })
    const harness = await makeHarness({
      render: async (request) => {
        markRenderStarted()
        return new Promise((resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
            once: true,
          })
        })
      },
      indexer: {
        prepare: async () => {
          indexStarted = true
          return preparedIndex()
        },
      },
    })
    await writeFile(harness.sourcePath, '# Deadline')
    const imports = new ImportRepository(harness.database)
    const run = imports.createRun([harness.sourcePath])
    const deadline = new AbortController()

    const processing = harness.processor.register({
      sourcePath: harness.sourcePath,
      runId: run.id,
      itemId: run.itemIds[0],
      signal: deadline.signal,
    })
    await renderStarted
    deadline.abort(new ArtifactProcessingError('TIMEOUT', 'render'))
    const result = await processing

    expect(result).toMatchObject({
      outcome: 'failed',
      errors: [expect.objectContaining({ code: 'TIMEOUT', stage: 'render' })],
    })
    expect(indexStarted).toBe(false)
    expect(imports.getItem(run.itemIds[0]).status).toBe('failed')
    expect(imports.getRun(run.id).status).toBe('failed')
    expect(
      harness.database
        .prepare('SELECT job_status FROM artifact_generation WHERE id = ?')
        .pluck()
        .get(result.generationId),
    ).toBe('interrupted')
    harness.database.close()
  })

  it('keeps TIMEOUT diagnostics but terminally cancels when cancellation wins during a held render', async () => {
    let markRenderStarted!: () => void
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve
    })
    const harness = await makeHarness({
      render: async (request) => {
        markRenderStarted()
        return new Promise((resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
            once: true,
          })
        })
      },
    })
    await writeFile(harness.sourcePath, '# Cancelled before deadline')
    const imports = new ImportRepository(harness.database)
    const run = imports.createRun([harness.sourcePath])
    const deadline = new AbortController()
    const processing = harness.processor.register({
      sourcePath: harness.sourcePath,
      runId: run.id,
      itemId: run.itemIds[0],
      signal: deadline.signal,
    })

    await renderStarted
    imports.requestCancellation(run.id, NOW)
    deadline.abort(new ArtifactProcessingError('TIMEOUT', 'render'))
    const result = await processing

    expect(result).toMatchObject({
      outcome: 'cancelled',
      errors: [
        expect.objectContaining({ code: 'TIMEOUT', stage: 'render' }),
        expect.objectContaining({ code: 'CANCELLED', stage: 'render' }),
      ],
    })
    expect(imports.getItem(run.itemIds[0]).status).toBe('cancelled')
    expect(imports.getRun(run.id).status).toBe('cancelled')
    expect(
      harness.database
        .prepare('SELECT job_status FROM artifact_generation WHERE id = ?')
        .pluck()
        .get(result.generationId),
    ).toBe('interrupted')
    harness.database.close()
  })

  it('records cancellation after thumbnail optimization before activating the new generation', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# Previous thumbnail')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const oldThumbnail = first.thumbnailPath as string
    const imports = new ImportRepository(harness.database)
    const run = imports.createRun([harness.sourcePath])
    imports.startRun(run.id, NOW)
    const cancellingProcessor = harness.createProcessor({
      optimizer: {
        optimize: async ({ bytes, width, height }) => {
          imports.requestCancellation(run.id, NOW)
          return { bytes, width, height, quality: 80 }
        },
      },
    })

    const cancelled = await cancellingProcessor.refresh({
      sourcePath: harness.sourcePath,
      runId: run.id,
      itemId: run.itemIds[0],
    })

    expect(cancelled.outcome).toBe('cancelled')
    expect(cancelled.errors.at(-1)).toMatchObject({ code: 'CANCELLED', stage: 'commit' })
    expect(activeGenerationId(harness.database, artifactId)).toBe(first.generationId)
    expect(existsSync(oldThumbnail)).toBe(true)
    expect(
      (await readdir(harness.derivedDirectory)).filter((name) => name.endsWith('.webp')),
    ).toEqual([oldThumbnail.split('/').at(-1)])
    harness.database.close()
  })

  it('records cancellation after atomic rename and rolls back the renamed generation', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# Previous generation')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const oldThumbnail = first.thumbnailPath as string
    const imports = new ImportRepository(harness.database)
    const run = imports.createRun([harness.sourcePath])
    imports.startRun(run.id, NOW)
    const cancellingProcessor = harness.createProcessor({
      fileSystem: {
        ...realFileSystem,
        rename: (from, to) => {
          renameSync(from, to)
          imports.requestCancellation(run.id, NOW)
        },
      },
    })

    const cancelled = await cancellingProcessor.refresh({
      sourcePath: harness.sourcePath,
      runId: run.id,
      itemId: run.itemIds[0],
    })

    expect(cancelled.outcome).toBe('cancelled')
    expect(activeGenerationId(harness.database, artifactId)).toBe(first.generationId)
    expect(existsSync(oldThumbnail)).toBe(true)
    expect(
      (await readdir(harness.derivedDirectory)).filter((name) => name.endsWith('.webp')),
    ).toEqual([oldThumbnail.split('/').at(-1)])
    expect(imports.getItem(run.itemIds[0]).status).toBe('cancelled')
    expect(imports.getRun(run.id).status).toBe('cancelled')
    harness.database.close()
  })

  it('rolls back generation activation when synchronous commit work crosses the budget', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# Previous active generation')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const oldThumbnail = first.thumbnailPath as string
    const imports = new ImportRepository(harness.database)
    const run = imports.createRun([harness.sourcePath])
    const deadlineProcessor = harness.createProcessor({
      fileSystem: {
        ...realFileSystem,
        rename: (from, to) => {
          renameSync(from, to)
          const busyUntil = performance.now() + 250
          while (performance.now() < busyUntil) {
            // A synchronous filesystem boundary can delay event-loop timers.
          }
        },
      },
    })

    const result = await deadlineProcessor.refresh({
      sourcePath: harness.sourcePath,
      runId: run.id,
      itemId: run.itemIds[0],
      deadlineAt: Date.now() + 200,
    })

    expect(result).toMatchObject({
      outcome: 'failed',
      errors: [expect.objectContaining({ code: 'TIMEOUT', stage: 'commit' })],
    })
    expect(activeGenerationId(harness.database, artifactId)).toBe(first.generationId)
    expect(existsSync(oldThumbnail)).toBe(true)
    expect(imports.getItem(run.itemIds[0]).status).toBe('failed')
    expect(imports.getRun(run.id).status).toBe('failed')
    expect(
      (await readdir(harness.derivedDirectory)).filter((name) => name.includes('.tmp')),
    ).toEqual([])
    harness.database.close()
  })

  it('does not enter rename or SQLite commit without a bounded remaining-time reserve', async () => {
    let renamed = false
    let indexCommitted = false
    const harness = await makeHarness({
      indexer: {
        prepare: async () => ({
          commit: () => {
            indexCommitted = true
          },
          rollback: async () => undefined,
          quarantine: async () => undefined,
        }),
      },
    })
    await writeFile(harness.sourcePath, '# Insufficient commit reserve')
    const imports = new ImportRepository(harness.database)
    const run = imports.createRun([harness.sourcePath])
    const processor = harness.createProcessor({
      fileSystem: {
        ...realFileSystem,
        rename: (from, to) => {
          renamed = true
          renameSync(from, to)
        },
      },
    })

    const result = await processor.register({
      sourcePath: harness.sourcePath,
      runId: run.id,
      itemId: run.itemIds[0],
      deadlineAt: Date.now() + 75,
    })

    expect(result).toMatchObject({
      outcome: 'failed',
      errors: [expect.objectContaining({ code: 'TIMEOUT', stage: 'commit' })],
    })
    expect(renamed).toBe(false)
    expect(indexCommitted).toBe(false)
    expect(
      harness.database
        .prepare('SELECT active_generation_id FROM artifact WHERE id = ?')
        .pluck()
        .get(result.artifactId),
    ).toBeNull()
    harness.database.close()
  })

  it('caps SQLite busy_timeout to the remaining budget and restores the connection setting', async () => {
    let observedBusyTimeoutMs = 0
    const harness = await makeHarness({
      indexer: {
        prepare: async () => ({
          commit: () => {
            observedBusyTimeoutMs = harness.database.pragma('busy_timeout', {
              simple: true,
            }) as number
          },
          rollback: async () => undefined,
          quarantine: async () => undefined,
        }),
      },
    })
    await writeFile(harness.sourcePath, '# Bounded SQLite wait')
    const configuredBusyTimeoutMs = harness.database.pragma('busy_timeout', {
      simple: true,
    }) as number

    const result = await harness.processor.register({
      sourcePath: harness.sourcePath,
      deadlineAt: Date.now() + 1_000,
    })

    expect(result.outcome).toBe('completed')
    expect(observedBusyTimeoutMs).toBeGreaterThan(0)
    expect(observedBusyTimeoutMs).toBeLessThanOrEqual(1_000)
    expect(harness.database.pragma('busy_timeout', { simple: true })).toBe(configuredBusyTimeoutMs)
    harness.database.close()
  })

  it('compensates activation when the SQLite transaction call returns after the deadline', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# Previous committed generation')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const oldThumbnail = first.thumbnailPath as string
    const imports = new ImportRepository(harness.database)
    const run = imports.createRun([harness.sourcePath])
    let delayTransactionReturn = false
    const originalTransaction = harness.database.transaction.bind(harness.database)
    harness.database.transaction = ((operation: (...parameters: never[]) => unknown) => {
      const transaction = originalTransaction(operation)
      return (...parameters: never[]) => {
        const result = transaction(...parameters)
        if (delayTransactionReturn && !harness.database.inTransaction) {
          delayTransactionReturn = false
          const busyUntil = performance.now() + 250
          while (performance.now() < busyUntil) {
            // Model a synchronous SQLite COMMIT returning after the cooperative budget.
          }
        }
        return result
      }
    }) as typeof harness.database.transaction
    const processor = harness.createProcessor({
      fileSystem: {
        ...realFileSystem,
        rename: (from, to) => {
          renameSync(from, to)
          delayTransactionReturn = true
        },
      },
    })

    const result = await processor.refresh({
      sourcePath: harness.sourcePath,
      runId: run.id,
      itemId: run.itemIds[0],
      deadlineAt: Date.now() + 200,
    })

    expect(result).toMatchObject({
      outcome: 'failed',
      errors: [expect.objectContaining({ code: 'TIMEOUT', stage: 'commit' })],
    })
    expect(activeGenerationId(harness.database, artifactId)).toBe(first.generationId)
    expect(existsSync(oldThumbnail)).toBe(true)
    expect(imports.getItem(run.itemIds[0]).status).toBe('failed')
    expect(imports.getRun(run.id).status).toBe('failed')
    harness.database.close()
  })

  it('restores prior diagnostics and item error relations after post-commit expiry', async () => {
    const harness = await makeHarness({
      render: async () => rendered(Buffer.from('RIFF-warning-WEBP'), [{ code: 'CONTENT_CLIPPED' }]),
    })
    await writeFile(harness.sourcePath, '# Diagnostic baseline')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const generationId = requireResultNumber(first.generationId)
    harness.database.prepare('DELETE FROM artifact_warning WHERE artifact_id = ?').run(artifactId)
    const artifacts = new ArtifactRepository(harness.database)
    const oldErrorId = artifacts.recordError({
      artifactId,
      generationId,
      code: 'HTML_RENDER_FAILED',
      stage: 'render',
      retryable: true,
      userMessage: 'Old error',
      technicalDetail: 'old detail',
      occurredAt: '2026-08-31T23:59:00.000Z',
    })
    const oldWarningId = artifacts.recordWarning({
      artifactId,
      generationId,
      code: 'ASSET_BLOCKED',
      detail: 'Old warning',
      occurredAt: '2026-08-31T23:59:30.000Z',
    })
    const previousItemId = harness.database
      .prepare('SELECT id FROM import_item WHERE artifact_id = ? ORDER BY id LIMIT 1')
      .pluck()
      .get(artifactId) as number
    harness.database
      .prepare('UPDATE import_item SET error_id = ? WHERE id = ?')
      .run(oldErrorId, previousItemId)
    const priorErrors = harness.database
      .prepare('SELECT * FROM artifact_error WHERE artifact_id = ? ORDER BY id')
      .all(artifactId)
    const priorWarnings = harness.database
      .prepare('SELECT * FROM artifact_warning WHERE artifact_id = ? ORDER BY id')
      .all(artifactId)
    const priorActiveGeneration = harness.database
      .prepare('SELECT * FROM artifact_generation WHERE id = ?')
      .get(generationId)
    const imports = new ImportRepository(harness.database)
    const run = imports.createRun([harness.sourcePath])
    const delayTransactionReturn = installDelayedTransactionReturn(harness.database, 250)
    const processor = harness.createProcessor({
      fileSystem: {
        ...realFileSystem,
        rename: (from, to) => {
          renameSync(from, to)
          delayTransactionReturn()
        },
      },
    })
    const result = await processor.refresh({
      sourcePath: harness.sourcePath,
      runId: run.id,
      itemId: run.itemIds[0],
      deadlineAt: Date.now() + 200,
    })

    expect(result.errors.at(-1)).toMatchObject({ code: 'TIMEOUT', stage: 'commit' })
    expect(
      harness.database
        .prepare(
          `SELECT * FROM artifact_error
           WHERE artifact_id = ? AND code <> 'TIMEOUT' ORDER BY id`,
        )
        .all(artifactId),
    ).toEqual(priorErrors)
    expect(
      harness.database
        .prepare('SELECT * FROM artifact_warning WHERE artifact_id = ? ORDER BY id')
        .all(artifactId),
    ).toEqual(priorWarnings)
    expect(
      harness.database
        .prepare('SELECT error_id FROM import_item WHERE id = ?')
        .pluck()
        .get(previousItemId),
    ).toBe(oldErrorId)
    expect(
      harness.database
        .prepare('SELECT COUNT(*) FROM artifact_warning WHERE id <> ? AND artifact_id = ?')
        .pluck()
        .get(oldWarningId, artifactId),
    ).toBe(0)
    expect(
      harness.database.prepare('SELECT * FROM artifact_generation WHERE id = ?').get(generationId),
    ).toEqual(priorActiveGeneration)
    expect(activeGenerationId(harness.database, artifactId)).toBe(generationId)
    expect(
      harness.database
        .prepare(
          `SELECT artifact_generation.job_status, artifact_search_visibility.state
           FROM artifact_generation
           JOIN artifact_search_visibility
             ON artifact_search_visibility.generation_id = artifact_generation.id
           WHERE artifact_generation.id = ?`,
        )
        .get(result.generationId),
    ).toEqual({ job_status: 'interrupted', state: 'staged' })
    expect(imports.getItem(run.itemIds[0]).status).toBe('failed')
    expect(imports.getRun(run.id).status).toBe('failed')
    harness.database.close()
  })

  it('rolls back a stale generation, cleans temp output, and retains the prior active generation and thumbnail', async () => {
    let invalidateAtIndex = false
    let artifactId = 0
    const harness = await makeHarness({
      indexer: {
        prepare: async () => {
          if (invalidateAtIndex) {
            new ArtifactRepository(harness.database).createGeneration(artifactId, NOW)
          }
          return preparedIndex()
        },
      },
    })
    await writeFile(harness.sourcePath, '# Stable')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    artifactId = requireResultNumber(first.artifactId)
    const oldThumbnail = first.thumbnailPath as string
    invalidateAtIndex = true

    const stale = await harness.processor.refresh({ sourcePath: harness.sourcePath })

    expect(stale.outcome).toBe('stale')
    expect(stale.errors.at(-1)).toMatchObject({ code: 'STALE_GENERATION', stage: 'commit' })
    expect(activeGenerationId(harness.database, artifactId)).toBe(first.generationId)
    expect(existsSync(oldThumbnail)).toBe(true)
    expect(
      (await readdir(harness.derivedDirectory)).filter((name) => name.includes('.tmp')),
    ).toEqual([])
    expect(
      (await readdir(harness.derivedDirectory)).filter((name) => name.endsWith('.webp')),
    ).toEqual([oldThumbnail.split('/').at(-1)])
    harness.database.close()
  })

  it('keeps the previous visible search result when generation commit fails', async () => {
    let visibleText: string | null = null
    const indexer = {
      prepare: async ({ text }: { text: string }) => {
        const previousText = visibleText
        return {
          commit: () => {
            visibleText = text
          },
          rollback: async () => {
            visibleText = previousText
          },
          quarantine: async () => {
            visibleText = null
          },
        }
      },
    }
    const harness = await makeHarness({ indexer })
    await writeFile(harness.sourcePath, '# First searchable text')
    await harness.processor.register({ sourcePath: harness.sourcePath })
    expect(visibleText).toBe('First searchable text')
    await writeFile(harness.sourcePath, '# Uncommitted searchable text')
    const failingProcessor = harness.withFileSystem({
      ...realFileSystem,
      rename: () => {
        throw new Error('rename failed after index preparation')
      },
    })

    const failed = await failingProcessor.refresh({ sourcePath: harness.sourcePath })

    expect(failed.outcome).toBe('failed')
    expect(visibleText).toBe('First searchable text')
    harness.database.close()
  })

  it('quarantines a prepared index and records durable repair work when rollback fails', async () => {
    let visibleText: string | null = null
    let quarantined = false
    const indexer = {
      prepare: async ({ text }: { text: string }) => {
        const previousText = visibleText
        return {
          commit: () => {
            visibleText = text
          },
          rollback: async () => {
            if (text.includes('Unrecoverable')) throw new Error('index rollback unavailable')
            visibleText = previousText
          },
          quarantine: async () => {
            visibleText = null
            quarantined = true
          },
        }
      },
    }
    const harness = await makeHarness({ indexer })
    await writeFile(harness.sourcePath, '# Previous searchable text')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    expect(visibleText).toBe('Previous searchable text')
    await writeFile(harness.sourcePath, '# Unrecoverable searchable text')
    const failingProcessor = harness.withFileSystem({
      ...realFileSystem,
      rename: () => {
        throw new Error('rename failed after index activation')
      },
    })

    const failed = await failingProcessor.refresh({ sourcePath: harness.sourcePath })

    expect(failed.outcome).toBe('failed')
    expect(failed.errors.at(-1)).toMatchObject({ code: 'INDEX_UPDATE_FAILED', stage: 'index' })
    expect(failed.indexStatus).toBe('failed')
    expect(activeGenerationId(harness.database, artifactId)).toBe(first.generationId)
    expect(quarantined).toBe(true)
    expect(visibleText).toBeNull()
    expect(new ArtifactRepository(harness.database).listWarnings(artifactId)).toContainEqual({
      code: 'INDEX_REPAIR_PENDING',
      detail: 'Search index repair is pending.',
      occurredAt: NOW,
    })
    harness.database.close()
  })

  it('durably gates search when prepared-index rollback and quarantine both fail', async () => {
    const externalRows: Array<{
      artifactId: number
      generation: number
      text: string
    }> = []
    const indexer: ArtifactIndexer = {
      prepare: async ({ artifactId, generation, text }) => ({
        commit: () => {
          externalRows.push({ artifactId, generation, text })
        },
        rollback: async () => {
          if (generation > 1) throw new Error('external rollback failed')
          externalRows.splice(
            externalRows.findIndex(
              (row) => row.artifactId === artifactId && row.generation === generation,
            ),
            1,
          )
        },
        quarantine: async () => {
          throw new Error('external quarantine failed')
        },
      }),
    }
    const harness = await makeHarness({ indexer })
    await writeFile(harness.sourcePath, '# Previous indexed text')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    await writeFile(harness.sourcePath, '# Leaked external text')
    const failingProcessor = harness.withFileSystem({
      ...realFileSystem,
      rename: () => {
        throw new Error('rename failed after external commit')
      },
    })

    const failed = await failingProcessor.refresh({ sourcePath: harness.sourcePath })

    expect(failed.outcome).toBe('failed')
    expect(failed.errors.at(-1)).toMatchObject({ code: 'INDEX_UPDATE_FAILED', stage: 'index' })
    expect(externalRows).toContainEqual({
      artifactId,
      generation: failed.generation,
      text: 'Leaked external text',
    })
    expect(
      new SearchVisibilityRepository(harness.database).filterVisibleCandidates(externalRows),
    ).toEqual([{ artifactId, generation: first.generation, text: 'Previous indexed text' }])
    expect(
      harness.database
        .prepare(
          `SELECT state FROM artifact_search_visibility
           WHERE artifact_id = ? AND generation_id = ?`,
        )
        .get(artifactId, failed.generationId),
    ).toEqual({ state: 'quarantined' })
    expect(new ArtifactRepository(harness.database).listWarnings(artifactId)).toContainEqual({
      code: 'INDEX_REPAIR_PENDING',
      detail: 'Search index repair is pending.',
      occurredAt: NOW,
    })
    harness.database.close()
  })

  it('reports an index commit failure at the index stage with matching persisted statuses', async () => {
    const harness = await makeHarness({
      indexer: {
        prepare: async () => ({
          commit: () => {
            throw new Error('index commit failed')
          },
          rollback: async () => undefined,
          quarantine: async () => undefined,
        }),
      },
    })
    await writeFile(harness.sourcePath, '# Index commit failure')

    const failed = await harness.processor.register({ sourcePath: harness.sourcePath })

    expect(failed.outcome).toBe('failed')
    expect(failed.errors.at(-1)).toMatchObject({ code: 'INDEX_UPDATE_FAILED', stage: 'index' })
    expect({
      content_status: failed.contentStatus,
      render_status: failed.renderStatus,
      index_status: failed.indexStatus,
    }).toEqual(
      harness.database
        .prepare(
          `SELECT content_status, render_status, index_status
           FROM artifact_generation WHERE id = ?`,
        )
        .get(failed.generationId),
    )
    expect(failed.indexStatus).toBe('failed')
    expect(
      new ArtifactRepository(harness.database).listErrors(requireResultNumber(failed.artifactId)),
    ).toContainEqual(expect.objectContaining({ code: 'INDEX_UPDATE_FAILED', stage: 'index' }))
    harness.database.close()
  })

  it('rolls back a rename failure, then atomically replaces the generation and retires the old thumbnail on success', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# First')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const oldThumbnail = first.thumbnailPath as string
    const failingProcessor = harness.withFileSystem({
      ...realFileSystem,
      rename: () => {
        throw Object.assign(new Error('rename denied'), { code: 'EACCES' })
      },
    })
    await writeFile(harness.sourcePath, '# Second')

    const failed = await failingProcessor.refresh({ sourcePath: harness.sourcePath })

    expect(failed.outcome).toBe('failed')
    expect(failed.errors.at(-1)).toMatchObject({ code: 'DERIVED_WRITE_FAILED', stage: 'commit' })
    expect(activeGenerationId(harness.database, artifactId)).toBe(first.generationId)
    expect(await readFile(oldThumbnail, 'utf8')).toBe('RIFF-small-preview-WEBP')
    expect(
      (await readdir(harness.derivedDirectory)).filter((name) => name.includes('.tmp')),
    ).toEqual([])

    const successful = await harness.processor.refresh({ sourcePath: harness.sourcePath })
    expect(successful.outcome).toBe('completed')
    expect(activeGenerationId(harness.database, artifactId)).toBe(successful.generationId)
    expect(existsSync(oldThumbnail)).toBe(false)
    expect(existsSync(successful.thumbnailPath as string)).toBe(true)
    harness.database.close()
  })

  it('cleans a partially written temp file and keeps the old generation when thumbnail writing fails', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# Stable thumbnail')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const oldThumbnail = first.thumbnailPath as string
    const failingProcessor = harness.withFileSystem({
      ...realFileSystem,
      writeFile: async (path, bytes) => {
        await writeFile(path, bytes.subarray(0, 4))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      },
    })

    const failed = await failingProcessor.refresh({ sourcePath: harness.sourcePath })

    expect(failed.outcome).toBe('failed')
    expect(failed.errors.at(-1)).toMatchObject({ code: 'DERIVED_WRITE_FAILED', stage: 'commit' })
    expect(activeGenerationId(harness.database, artifactId)).toBe(first.generationId)
    expect(existsSync(oldThumbnail)).toBe(true)
    expect(
      (await readdir(harness.derivedDirectory)).filter((name) => name.includes('.tmp')),
    ).toEqual([])
    harness.database.close()
  })

  it('rolls back generation activation and keeps the old thumbnail when item completion fails', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# Previous active generation')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const oldThumbnail = first.thumbnailPath as string
    harness.database.exec(`
      CREATE TRIGGER fail_import_item_completion
      BEFORE UPDATE OF status ON import_item
      WHEN NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'completion probe failed');
      END;
    `)
    await writeFile(harness.sourcePath, '# Must roll back')

    const failed = await harness.processor.refresh({ sourcePath: harness.sourcePath })

    expect(failed.outcome).toBe('failed')
    expect(activeGenerationId(harness.database, artifactId)).toBe(first.generationId)
    expect(await readFile(oldThumbnail, 'utf8')).toBe('RIFF-small-preview-WEBP')
    expect(
      (await readdir(harness.derivedDirectory)).filter((name) => name.endsWith('.webp')),
    ).toEqual([oldThumbnail.split('/').at(-1)])
    expect(
      (await readdir(harness.derivedDirectory)).filter((name) => name.includes('.tmp')),
    ).toEqual([])
    harness.database.close()
  })

  it('records a durable path-free cleanup warning when the old thumbnail cannot be retired', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# Old thumbnail')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const oldThumbnail = first.thumbnailPath as string
    const processor = harness.createProcessor({
      fileSystem: {
        ...realFileSystem,
        remove: async (path) => {
          if (path === oldThumbnail)
            throw Object.assign(new Error(`denied: ${path}`), { code: 'EACCES' })
          return realFileSystem.remove(path)
        },
      },
    })
    await writeFile(harness.sourcePath, '# New thumbnail')

    const completed = await processor.refresh({ sourcePath: harness.sourcePath })

    expect(completed.outcome).toBe('completed')
    expect(existsSync(oldThumbnail)).toBe(true)
    expect(existsSync(completed.thumbnailPath as string)).toBe(true)
    expect(new ArtifactRepository(harness.database).listWarnings(artifactId)).toEqual([
      {
        code: 'THUMBNAIL_RETIRE_PENDING',
        detail: 'Previous thumbnail cleanup is pending.',
        occurredAt: NOW,
      },
    ])
    expect(JSON.stringify(completed)).not.toContain(oldThumbnail)
    harness.database.close()
  })

  it('does not roll back a completed generation when retirement warning persistence fails', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# Old active thumbnail')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const oldThumbnail = first.thumbnailPath as string
    harness.database.exec(`
      CREATE TRIGGER fail_retirement_warning
      BEFORE INSERT ON artifact_warning
      WHEN NEW.code = 'THUMBNAIL_RETIRE_PENDING'
      BEGIN
        SELECT RAISE(ABORT, 'warning persistence probe failed');
      END;
    `)
    const processor = harness.createProcessor({
      fileSystem: {
        ...realFileSystem,
        remove: async (path) => {
          if (path === oldThumbnail) throw new Error('old thumbnail unlink failed')
          return realFileSystem.remove(path)
        },
      },
    })
    await writeFile(harness.sourcePath, '# New active thumbnail')

    const completed = await processor.refresh({ sourcePath: harness.sourcePath })

    expect(completed.outcome).toBe('completed')
    expect(activeGenerationId(harness.database, artifactId)).toBe(completed.generationId)
    expect(existsSync(oldThumbnail)).toBe(true)
    expect(existsSync(completed.thumbnailPath as string)).toBe(true)
    expect(harness.operationalErrors).toEqual([
      {
        operation: 'thumbnail-retirement-warning',
        artifactId,
        generationId: completed.generationId,
        technicalDetail: 'warning persistence probe failed',
      },
    ])
    expect(
      harness.database
        .prepare(
          `SELECT import_item.status AS item_status, import_run.status AS run_status
           FROM import_item JOIN import_run ON import_run.id = import_item.run_id
           ORDER BY import_item.id DESC LIMIT 1`,
        )
        .get(),
    ).toEqual({ item_status: 'completed', run_status: 'completed' })
    harness.database.close()
  })

  it('preserves a pending retirement warning until retry removes every inactive thumbnail', async () => {
    const harness = await makeHarness()
    await writeFile(harness.sourcePath, '# Generation one')
    const first = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(first.artifactId)
    const firstThumbnail = first.thumbnailPath as string
    const neverRemoveThumbnail = harness.createProcessor({
      fileSystem: {
        ...realFileSystem,
        remove: async (path) => {
          if (path.endsWith('.webp')) throw new Error('thumbnail remains in use')
          return realFileSystem.remove(path)
        },
      },
    })
    await writeFile(harness.sourcePath, '# Generation two')
    const second = await neverRemoveThumbnail.refresh({ sourcePath: harness.sourcePath })
    const secondThumbnail = second.thumbnailPath as string
    const firstWarning = harness.database
      .prepare(
        `SELECT id, generation_id FROM artifact_warning
         WHERE artifact_id = ? AND code = 'THUMBNAIL_RETIRE_PENDING'`,
      )
      .get(artifactId)
    expect(firstWarning).toBeDefined()

    await writeFile(harness.sourcePath, '# Generation three')
    await neverRemoveThumbnail.refresh({ sourcePath: harness.sourcePath })

    expect(
      harness.database
        .prepare(
          `SELECT id, generation_id FROM artifact_warning
           WHERE artifact_id = ? AND code = 'THUMBNAIL_RETIRE_PENDING'`,
        )
        .get(artifactId),
    ).toEqual(firstWarning)
    expect(existsSync(firstThumbnail)).toBe(true)
    expect(existsSync(secondThumbnail)).toBe(true)

    await writeFile(harness.sourcePath, '# Generation four')
    const fourth = await harness.processor.refresh({ sourcePath: harness.sourcePath })

    expect(fourth.outcome).toBe('completed')
    expect(existsSync(firstThumbnail)).toBe(false)
    expect(existsSync(secondThumbnail)).toBe(false)
    expect(
      harness.database
        .prepare(
          `SELECT COUNT(*) AS count FROM artifact_warning
           WHERE artifact_id = ? AND code = 'THUMBNAIL_RETIRE_PENDING'`,
        )
        .get(artifactId),
    ).toEqual({ count: 0 })
    harness.database.close()
  })

  it('writes no thumbnail over 500KB and keeps errors until a clean success while persisting clipped warnings', async () => {
    let renderMode: 'clipped' | 'failed' | 'clean' = 'clipped'
    const optimizer: ThumbnailOptimizer = {
      optimize: async ({ bytes, width, height }) => ({
        bytes: bytes.subarray(0, MAX_THUMBNAIL_BYTES),
        width,
        height,
        quality: 45,
      }),
    }
    const harness = await makeHarness({
      optimizer,
      render: async () => {
        if (renderMode === 'failed') {
          throw Object.assign(new Error('render failed'), { code: 'HTML_RENDER_FAILED' })
        }
        return rendered(
          Buffer.alloc(MAX_THUMBNAIL_BYTES + 100, 0x63),
          renderMode === 'clipped' ? [{ code: 'CONTENT_CLIPPED' as const }] : [],
        )
      },
    })
    await writeFile(harness.sourcePath, '# Lifecycle')

    const clipped = await harness.processor.register({ sourcePath: harness.sourcePath })
    const artifactId = requireResultNumber(clipped.artifactId)
    expect((await readFile(clipped.thumbnailPath as string)).byteLength).toBeLessThanOrEqual(
      MAX_THUMBNAIL_BYTES,
    )
    expect(new ArtifactRepository(harness.database).listWarnings(artifactId)).toEqual([
      { code: 'CONTENT_CLIPPED', detail: 'Preview exceeded 2400px.', occurredAt: NOW },
    ])

    renderMode = 'failed'
    const partial = await harness.processor.refresh({ sourcePath: harness.sourcePath })
    expect(partial.outcome).toBe('partial')
    expect(new ArtifactRepository(harness.database).listErrors(artifactId)).toHaveLength(1)
    expect(new ArtifactRepository(harness.database).listWarnings(artifactId)).toHaveLength(1)

    renderMode = 'clean'
    const clean = await harness.processor.refresh({ sourcePath: harness.sourcePath })
    expect(clean.outcome).toBe('completed')
    expect(new ArtifactRepository(harness.database).listErrors(artifactId)).toEqual([])
    expect(new ArtifactRepository(harness.database).listWarnings(artifactId)).toEqual([])
    harness.database.close()
  })
})

const realFileSystem: ProcessorFileSystem = {
  mkdir,
  writeFile,
  rename: renameSync,
  remove: (path) => rm(path, { force: true }),
}

async function makeHarness(
  options: {
    sourceName?: string
    render?: ArtifactProcessorConstructor['render']
    indexer?: ArtifactIndexer
    optimizer?: ThumbnailOptimizer
    useDefaultIndexer?: boolean
  } = {},
) {
  const root = await temporaryDirectory()
  const sourcePath = join(root, options.sourceName ?? 'artifact.md')
  const derivedDirectory = join(root, 'derived')
  await mkdir(derivedDirectory)
  const database = openDatabase({ filename: join(root, 'gallery.sqlite') })
  const realPolicy = await PathPolicy.create([root])
  const controls: Controls = {}
  const operationalErrors: ProcessingOperationalError[] = []
  const markdown = new MarkdownRenderer()
  const indexer = options.indexer ?? { prepare: async () => preparedIndex() }
  const render = options.render ?? (async () => rendered(Buffer.from('RIFF-small-preview-WEBP')))

  const defaultOptimizer = options.optimizer ?? {
    optimize: async ({ bytes, width, height }: Parameters<ThumbnailOptimizer['optimize']>[0]) => ({
      bytes,
      width,
      height,
      quality: 80,
    }),
  }
  const dependencies = (
    overrides: {
      fileSystem?: ProcessorFileSystem
      optimizer?: ThumbnailOptimizer
    } = {},
  ) => ({
    database,
    pathPolicy: {
      authorizeFile: async (path: string) => {
        const authorized = await realPolicy.authorizeFile(path)
        controls.cancelAfterInspect?.()
        return authorized
      },
    },
    markdownRenderer: {
      render: (source: string) => {
        const result = markdown.render(source)
        controls.cancelAfterExtract?.()
        return result
      },
    },
    htmlRenderer: {
      render: async (request: { html: string; sourcePath: string }) => {
        const result = await render(request)
        controls.cancelAfterRender?.()
        return result
      },
    },
    ...(options.useDefaultIndexer
      ? {}
      : {
          indexer: {
            prepare: async (request: Parameters<ArtifactIndexer['prepare']>[0]) => {
              const prepared = await indexer.prepare(request)
              controls.cancelAfterIndex?.()
              return prepared
            },
          },
        }),
    thumbnailDirectory: derivedDirectory,
    thumbnailOptimizer: overrides.optimizer ?? defaultOptimizer,
    fileSystem: overrides.fileSystem ?? realFileSystem,
    now: () => NOW,
    reportOperationalError: async (error: ProcessingOperationalError) => {
      operationalErrors.push(error)
    },
  })
  const processor = new ArtifactProcessor(dependencies())
  return {
    root,
    sourcePath,
    derivedDirectory,
    database,
    controls,
    operationalErrors,
    processor,
    createProcessor: (overrides: {
      fileSystem?: ProcessorFileSystem
      optimizer?: ThumbnailOptimizer
    }) => new ArtifactProcessor(dependencies(overrides)),
    withFileSystem: (fileSystem: ProcessorFileSystem) =>
      new ArtifactProcessor(dependencies({ fileSystem })),
  }
}

interface Controls {
  cancelAfterInspect?: () => void
  cancelAfterExtract?: () => void
  cancelAfterRender?: () => void
  cancelAfterIndex?: () => void
}

interface ArtifactProcessorConstructor {
  render: (request: { html: string; sourcePath: string; signal?: AbortSignal }) => Promise<{
    screenshot: Buffer
    width: number
    height: number
    warnings: ReadonlyArray<{ code: 'ASSET_BLOCKED' | 'CONTENT_CLIPPED' }>
  }>
}

function rendered(
  screenshot: Buffer,
  warnings: ReadonlyArray<{ code: 'ASSET_BLOCKED' | 'CONTENT_CLIPPED' }> = [],
) {
  return { screenshot, width: 1200, height: 800, warnings }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-processing-'))
  temporaryDirectories.push(directory)
  return directory
}

function activeGenerationId(database: ReturnType<typeof openDatabase>, artifactId: number): number {
  return (
    database.prepare('SELECT active_generation_id FROM artifact WHERE id = ?').get(artifactId) as {
      active_generation_id: number
    }
  ).active_generation_id
}

function readTitle(database: ReturnType<typeof openDatabase>, artifactId: number) {
  return database
    .prepare('SELECT user_title, derived_title FROM artifact WHERE id = ?')
    .get(artifactId)
}

function requireResultNumber(value: number | null): number {
  expect(value).not.toBeNull()
  return value as number
}

function preparedIndex() {
  return {
    commit: () => undefined,
    rollback: async () => undefined,
    quarantine: async () => undefined,
  }
}

function installDelayedTransactionReturn(
  database: ReturnType<typeof openDatabase>,
  delayMs: number,
): () => void {
  let armed = false
  const originalTransaction = database.transaction.bind(database)
  database.transaction = ((operation: (...parameters: never[]) => unknown) => {
    const transaction = originalTransaction(operation)
    return (...parameters: never[]) => {
      const result = transaction(...parameters)
      if (armed && !database.inTransaction) {
        armed = false
        const busyUntil = performance.now() + delayMs
        while (performance.now() < busyUntil) {
          // Model a synchronous SQLite COMMIT returning after the cooperative budget.
        }
      }
      return result
    }
  }) as typeof database.transaction
  return () => {
    armed = true
  }
}
