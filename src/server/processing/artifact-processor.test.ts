import { existsSync, renameSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/database.js'
import { MarkdownRenderer } from '../rendering/markdown-renderer.js'
import { ArtifactRepository } from '../repositories/artifact-repository.js'
import { ImportRepository } from '../repositories/import-repository.js'
import { PathPolicy } from '../security/path-policy.js'
import {
  ArtifactProcessor,
  type ArtifactIndexer,
  type ProcessorFileSystem,
} from './artifact-processor.js'
import { MAX_THUMBNAIL_BYTES, type ThumbnailOptimizer } from './thumbnail-optimizer.js'

const temporaryDirectories: string[] = []
const NOW = '2026-09-01T00:00:00.000Z'

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('ArtifactProcessor staged pipeline', () => {
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
    expect(render.errors).toMatchObject([{ code: 'HTML_RENDER_FAILED', stage: 'render' }])
    expect(JSON.stringify(render.publicErrors)).not.toContain('/private/path')
    renderHarness.database.close()

    const indexHarness = await makeHarness({
      indexer: {
        update: async () => {
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
      harness.controls.cancelAfterInspect = cancelledStage === 'extract' ? requestCancellation : undefined
      harness.controls.cancelAfterExtract = cancelledStage === 'render' ? requestCancellation : undefined
      harness.controls.cancelAfterRender = cancelledStage === 'index' ? requestCancellation : undefined
      harness.controls.cancelAfterIndex = cancelledStage === 'commit' ? requestCancellation : undefined

      const result = await harness.processor.register({
        sourcePath: harness.sourcePath,
        runId: run.id,
        itemId: run.itemIds[0],
      })

      expect(result.outcome).toBe('cancelled')
      expect(result.errors.at(-1)).toMatchObject({ code: 'CANCELLED', stage: cancelledStage })
      expect(imports.getItem(run.itemIds[0])).toMatchObject({ status: 'cancelled' })
      expect(imports.getRun(run.id)).toMatchObject({ status: 'cancelled' })
      expect((await readdir(harness.derivedDirectory)).filter((name) => name.includes('.tmp'))).toEqual([])
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

  it('rolls back a stale generation, cleans temp output, and retains the prior active generation and thumbnail', async () => {
    let invalidateAtIndex = false
    let artifactId = 0
    const harness = await makeHarness({
      indexer: {
        update: async () => {
          if (invalidateAtIndex) {
            new ArtifactRepository(harness.database).createGeneration(artifactId, NOW)
          }
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
    expect((await readdir(harness.derivedDirectory)).filter((name) => name.includes('.tmp'))).toEqual([])
    expect((await readdir(harness.derivedDirectory)).filter((name) => name.endsWith('.webp'))).toEqual([
      oldThumbnail.split('/').at(-1),
    ])
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
    expect((await readdir(harness.derivedDirectory)).filter((name) => name.includes('.tmp'))).toEqual([])

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
    expect((await readdir(harness.derivedDirectory)).filter((name) => name.includes('.tmp'))).toEqual([])
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

async function makeHarness(options: {
  sourceName?: string
  render?: ArtifactProcessorConstructor['render']
  indexer?: ArtifactIndexer
  optimizer?: ThumbnailOptimizer
} = {}) {
  const root = await temporaryDirectory()
  const sourcePath = join(root, options.sourceName ?? 'artifact.md')
  const derivedDirectory = join(root, 'derived')
  await mkdir(derivedDirectory)
  const database = openDatabase({ filename: join(root, 'gallery.sqlite') })
  const realPolicy = await PathPolicy.create([root])
  const controls: Controls = {}
  const markdown = new MarkdownRenderer()
  const indexer = options.indexer ?? { update: async () => undefined }
  const render = options.render ?? (async () => rendered(Buffer.from('RIFF-small-preview-WEBP')))

  const dependencies = (fileSystem: ProcessorFileSystem) => ({
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
    indexer: {
      update: async (request: Parameters<ArtifactIndexer['update']>[0]) => {
        await indexer.update(request)
        controls.cancelAfterIndex?.()
      },
    },
    thumbnailDirectory: derivedDirectory,
    thumbnailOptimizer: options.optimizer ?? {
      optimize: async ({ bytes, width, height }) => ({ bytes, width, height, quality: 80 }),
    },
    fileSystem,
    now: () => NOW,
  })
  const processor = new ArtifactProcessor(dependencies(realFileSystem))
  return {
    root,
    sourcePath,
    derivedDirectory,
    database,
    controls,
    processor,
    withFileSystem: (fileSystem: ProcessorFileSystem) =>
      new ArtifactProcessor(dependencies(fileSystem)),
  }
}

interface Controls {
  cancelAfterInspect?: () => void
  cancelAfterExtract?: () => void
  cancelAfterRender?: () => void
  cancelAfterIndex?: () => void
}

interface ArtifactProcessorConstructor {
  render: (request: { html: string; sourcePath: string }) => Promise<{
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
    database
      .prepare('SELECT active_generation_id FROM artifact WHERE id = ?')
      .get(artifactId) as { active_generation_id: number }
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
