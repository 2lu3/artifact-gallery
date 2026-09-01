import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database.js'
import { ArtifactRepository, StaleGenerationError } from './artifact-repository.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('ArtifactRepository', () => {
  it('derives card presentation from independent persisted facts in precedence order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-artifacts-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const repository = new ArtifactRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const artifact = repository.register({
      sourcePath: '/canonical/note.md',
      format: 'markdown',
      now,
    })

    expect(repository.getCardPresentation(artifact.id)).toBe('failed')

    const generation = repository.createGeneration(artifact.id, now)
    expect(repository.getCardPresentation(artifact.id)).toBe('processing')

    repository.setGenerationState(generation.id, {
      jobStatus: 'idle',
      contentStatus: 'ready',
      renderStatus: 'ready',
      indexStatus: 'ready',
    })
    expect(repository.getCardPresentation(artifact.id)).toBe('ready')

    repository.setGenerationState(generation.id, {
      jobStatus: 'idle',
      contentStatus: 'ready',
      renderStatus: 'failed',
      indexStatus: 'failed',
    })
    expect(repository.getCardPresentation(artifact.id)).toBe('partial')

    repository.setGenerationState(generation.id, {
      jobStatus: 'idle',
      contentStatus: 'failed',
      renderStatus: 'failed',
      indexStatus: 'failed',
    })
    expect(repository.getCardPresentation(artifact.id)).toBe('failed')

    repository.setGenerationState(generation.id, {
      jobStatus: 'processing',
      contentStatus: 'ready',
      renderStatus: 'ready',
      indexStatus: 'ready',
    })
    expect(repository.getCardPresentation(artifact.id)).toBe('processing')

    repository.setSourceStatus(artifact.id, 'missing', now)
    expect(repository.getCardPresentation(artifact.id)).toBe('missing')

    database.close()
  })

  it('stores structured errors and warnings without overwriting artifact state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-artifacts-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'gallery.sqlite')
    const database = openDatabase({ filename })
    const repository = new ArtifactRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const artifact = repository.register({
      sourcePath: '/canonical/note.md',
      format: 'markdown',
      now,
    })
    const generation = repository.createGeneration(artifact.id, now)
    repository.setGenerationState(generation.id, {
      jobStatus: 'idle',
      contentStatus: 'ready',
      renderStatus: 'ready',
      indexStatus: 'ready',
    })

    repository.recordError({
      artifactId: artifact.id,
      generationId: generation.id,
      code: 'ASSET_BLOCKED',
      stage: 'render',
      retryable: false,
      userMessage: 'An asset was blocked.',
      technicalDetail: 'https://outside.example/image.png',
      occurredAt: now,
    })
    repository.recordWarning({
      artifactId: artifact.id,
      generationId: generation.id,
      code: 'PAGE_CLIPPED',
      detail: 'Preview exceeded 2400px.',
      occurredAt: now,
    })
    database.close()

    const reopened = openDatabase({ filename })
    const persisted = new ArtifactRepository(reopened)
    expect(persisted.listErrors(artifact.id)).toEqual([
      {
        code: 'ASSET_BLOCKED',
        stage: 'render',
        retryable: false,
        userMessage: 'An asset was blocked.',
        technicalDetail: 'https://outside.example/image.png',
        occurredAt: now,
      },
    ])
    expect(persisted.listWarnings(artifact.id)).toEqual([
      {
        code: 'PAGE_CLIPPED',
        detail: 'Preview exceeded 2400px.',
        occurredAt: now,
      },
    ])
    expect(persisted.getCardPresentation(artifact.id)).toBe('ready')
    reopened.close()
  })

  it('atomically commits a generation and preserves the prior success after a stale commit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-artifacts-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const repository = new ArtifactRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const artifact = repository.register({
      sourcePath: '/canonical/note.md',
      format: 'markdown',
      now,
    })

    const first = repository.createGeneration(artifact.id, now)
    repository.commitGeneration({
      artifactId: artifact.id,
      generationId: first.id,
      expectedGeneration: first.generation,
      contentStatus: 'ready',
      renderStatus: 'ready',
      indexStatus: 'ready',
      extractedText: 'first text',
      extractorVersion: 'commonmark-1',
      thumbnailPath: '/derived/first.webp',
      previewedAt: now,
      completedAt: now,
    })

    const second = repository.createGeneration(artifact.id, now)
    expect(() =>
      repository.commitGeneration({
        artifactId: artifact.id,
        generationId: second.id,
        expectedGeneration: first.generation,
        contentStatus: 'ready',
        renderStatus: 'ready',
        indexStatus: 'ready',
        extractedText: 'stale text',
        extractorVersion: 'commonmark-1',
        thumbnailPath: '/derived/stale.webp',
        previewedAt: now,
        completedAt: now,
      }),
    ).toThrow(StaleGenerationError)

    expect(
      database.prepare('SELECT active_generation_id FROM artifact WHERE id = ?').get(artifact.id),
    ).toEqual({ active_generation_id: first.id })
    expect(
      database
        .prepare(
          `SELECT job_status, content_status, extracted_text, thumbnail_path
           FROM artifact_generation WHERE id = ?`,
        )
        .get(second.id),
    ).toEqual({
      job_status: 'queued',
      content_status: 'pending',
      extracted_text: null,
      thumbnail_path: null,
    })

    database.close()
  })

  it('keeps the prior active generation when a new generation has no ready derivative', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-artifacts-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const repository = new ArtifactRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const artifact = repository.register({
      sourcePath: '/canonical/note.md',
      format: 'markdown',
      now,
    })
    const successful = repository.createGeneration(artifact.id, now)
    repository.commitGeneration({
      artifactId: artifact.id,
      generationId: successful.id,
      expectedGeneration: successful.generation,
      contentStatus: 'ready',
      renderStatus: 'ready',
      indexStatus: 'ready',
      extractedText: 'previous successful text',
      extractorVersion: 'commonmark-1',
      thumbnailPath: '/derived/success.webp',
      previewedAt: now,
      completedAt: now,
    })

    const failed = repository.createGeneration(artifact.id, now)
    repository.commitGeneration({
      artifactId: artifact.id,
      generationId: failed.id,
      expectedGeneration: failed.generation,
      contentStatus: 'failed',
      renderStatus: 'failed',
      indexStatus: 'failed',
      extractedText: null,
      extractorVersion: null,
      thumbnailPath: null,
      previewedAt: null,
      completedAt: now,
    })

    expect(
      database.prepare('SELECT active_generation_id FROM artifact WHERE id = ?').get(artifact.id),
    ).toEqual({ active_generation_id: successful.id })
    expect(
      database
        .prepare(
          'SELECT job_status, content_status, render_status, index_status FROM artifact_generation WHERE id = ?',
        )
        .get(failed.id),
    ).toEqual({
      job_status: 'idle',
      content_status: 'failed',
      render_status: 'failed',
      index_status: 'failed',
    })

    database.close()
  })

  it('upserts a canonical source path without discarding its successful generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-artifacts-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const repository = new ArtifactRepository(database)
    const firstSeenAt = '2026-08-31T00:00:00.000Z'
    const seenAgainAt = '2026-08-31T00:01:00.000Z'
    const first = repository.register({
      sourcePath: '/canonical/note.md',
      format: 'markdown',
      now: firstSeenAt,
    })
    const generation = repository.createGeneration(first.id, firstSeenAt)
    repository.commitGeneration({
      artifactId: first.id,
      generationId: generation.id,
      expectedGeneration: generation.generation,
      contentStatus: 'ready',
      renderStatus: 'ready',
      indexStatus: 'ready',
      extractedText: 'preserve me',
      extractorVersion: 'commonmark-1',
      thumbnailPath: '/derived/first.webp',
      previewedAt: firstSeenAt,
      completedAt: firstSeenAt,
    })

    const duplicate = repository.register({
      sourcePath: '/canonical/note.md',
      format: 'markdown',
      now: seenAgainAt,
    })

    expect(duplicate.id).toBe(first.id)
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count, generation_counter, active_generation_id, updated_at
           FROM artifact WHERE source_path = ?`,
        )
        .get('/canonical/note.md'),
    ).toEqual({
      count: 1,
      generation_counter: 1,
      active_generation_id: generation.id,
      updated_at: seenAgainAt,
    })

    database.close()
  })
})
