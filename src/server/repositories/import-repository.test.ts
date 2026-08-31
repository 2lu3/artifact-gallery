import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database.js'
import { ArtifactRepository } from './artifact-repository.js'
import { ImportRepository } from './import-repository.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('ImportRepository', () => {
  it('adds enumerated items to an existing queued or running run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-import-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const repository = new ImportRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const run = repository.createRun([])

    repository.startRun(run.id, now)
    const itemIds = repository.addItems(run.id, ['/canonical/a.md', '/canonical/b.html'])

    expect(itemIds).toHaveLength(2)
    expect(repository.getItem(itemIds[0] as number)).toMatchObject({
      runId: run.id,
      canonicalPath: '/canonical/a.md',
      stage: 'queued',
      status: 'queued',
    })
    expect(repository.getItem(itemIds[1] as number)).toMatchObject({
      runId: run.id,
      canonicalPath: '/canonical/b.html',
    })
    database.close()
  })

  it('persists run and item transitions before stage work can start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-import-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'gallery.sqlite')
    const database = openDatabase({ filename })
    const repository = new ImportRepository(database)
    const startedAt = '2026-08-31T00:00:01.000Z'
    const completedAt = '2026-08-31T00:00:02.000Z'

    const run = repository.createRun(['/canonical/a.md', '/canonical/b.html'])
    repository.startRun(run.id, startedAt)
    repository.startStage(run.itemIds[0], 'inspect', startedAt)

    const observer = openDatabase({ filename })
    const observedRepository = new ImportRepository(observer)
    expect(observedRepository.getRun(run.id)).toEqual({
      id: run.id,
      status: 'running',
      cancelRequestedAt: null,
      startedAt,
      completedAt: null,
    })
    expect(observedRepository.getItem(run.itemIds[0])).toEqual({
      id: run.itemIds[0],
      runId: run.id,
      canonicalPath: '/canonical/a.md',
      artifactId: null,
      stage: 'inspect',
      status: 'processing',
      errorId: null,
      startedAt,
      completedAt: null,
    })

    repository.completeItem(run.itemIds[0], completedAt)
    repository.completeRun(run.id, completedAt)
    observer.close()
    database.close()

    const reopened = openDatabase({ filename })
    const reopenedRepository = new ImportRepository(reopened)
    expect(reopenedRepository.getItem(run.itemIds[0]).status).toBe('completed')
    expect(reopenedRepository.getRun(run.id).status).toBe('completed')
    reopened.close()
  })

  it('durably links item failures and records requested cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-import-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'gallery.sqlite')
    const database = openDatabase({ filename })
    const imports = new ImportRepository(database)
    const artifacts = new ArtifactRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const artifact = artifacts.register({
      sourcePath: '/canonical/broken.md',
      format: 'markdown',
      now,
    })
    const run = imports.createRun(['/canonical/broken.md', '/canonical/not-started.md'])
    imports.startRun(run.id, now)
    imports.attachArtifact(run.itemIds[0], artifact.id)
    imports.startStage(run.itemIds[0], 'extract', now)
    const errorId = artifacts.recordError({
      artifactId: artifact.id,
      generationId: null,
      code: 'MARKDOWN_PARSE_FAILED',
      stage: 'extract',
      retryable: true,
      userMessage: 'The Markdown could not be read.',
      technicalDetail: 'Unexpected parser failure.',
      occurredAt: now,
    })
    imports.failItem(run.itemIds[0], errorId, now)
    imports.requestCancellation(run.id, now)
    imports.cancelItem(run.itemIds[1], now)
    imports.cancelRun(run.id, now)
    database.close()

    const reopened = openDatabase({ filename })
    const persisted = new ImportRepository(reopened)
    expect(persisted.getItem(run.itemIds[0])).toMatchObject({
      artifactId: artifact.id,
      errorId,
      stage: 'extract',
      status: 'failed',
      completedAt: now,
    })
    expect(persisted.getItem(run.itemIds[1])).toMatchObject({
      stage: 'queued',
      status: 'cancelled',
      completedAt: now,
    })
    expect(persisted.getRun(run.id)).toEqual({
      id: run.id,
      status: 'cancelled',
      cancelRequestedAt: now,
      startedAt: now,
      completedAt: now,
    })
    reopened.close()
  })

  it('does not start another stage after cancellation is requested', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-import-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const repository = new ImportRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const run = repository.createRun(['/canonical/not-started.md'])
    repository.startRun(run.id, now)
    repository.requestCancellation(run.id, now)

    expect(repository.startStage(run.itemIds[0], 'inspect', now)).toBe(false)
    expect(repository.getItem(run.itemIds[0])).toMatchObject({
      stage: 'queued',
      status: 'queued',
      startedAt: null,
    })

    database.close()
  })

  it('rejects an item failure owned by another artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-import-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const imports = new ImportRepository(database)
    const artifacts = new ArtifactRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const first = artifacts.register({
      sourcePath: '/canonical/first.md',
      format: 'markdown',
      now,
    })
    const second = artifacts.register({
      sourcePath: '/canonical/second.md',
      format: 'markdown',
      now,
    })
    const run = imports.createRun(['/canonical/first.md'])
    imports.startRun(run.id, now)
    imports.attachArtifact(run.itemIds[0], first.id)
    imports.startStage(run.itemIds[0], 'extract', now)
    const foreignErrorId = artifacts.recordError({
      artifactId: second.id,
      generationId: null,
      code: 'MARKDOWN_PARSE_FAILED',
      stage: 'extract',
      retryable: true,
      userMessage: 'The Markdown could not be read.',
      technicalDetail: null,
      occurredAt: now,
    })

    expect(() => imports.failItem(run.itemIds[0], foreignErrorId, now)).toThrow()
    expect(imports.getItem(run.itemIds[0])).toMatchObject({
      artifactId: first.id,
      errorId: null,
      status: 'processing',
      completedAt: null,
    })

    database.close()
  })

  it('rejects an artifact-owned error on an item without an artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-import-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const imports = new ImportRepository(database)
    const artifacts = new ArtifactRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const artifact = artifacts.register({
      sourcePath: '/canonical/owned.md',
      format: 'markdown',
      now,
    })
    const ownedErrorId = artifacts.recordError({
      artifactId: artifact.id,
      generationId: null,
      code: 'MARKDOWN_PARSE_FAILED',
      stage: 'extract',
      retryable: true,
      userMessage: 'The Markdown could not be read.',
      technicalDetail: null,
      occurredAt: now,
    })
    const run = imports.createRun(['/canonical/not-yet-registered.md'])
    imports.startRun(run.id, now)
    imports.startStage(run.itemIds[0], 'inspect', now)

    expect(() => imports.failItem(run.itemIds[0], ownedErrorId, now)).toThrow()
    expect(imports.getItem(run.itemIds[0])).toMatchObject({
      artifactId: null,
      errorId: null,
      status: 'processing',
      completedAt: null,
    })

    database.close()
  })

  it('persists an item-level error before an artifact is created', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-import-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const imports = new ImportRepository(database)
    const artifacts = new ArtifactRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const run = imports.createRun(['/outside/allowed-root.md'])
    imports.startRun(run.id, now)
    imports.startStage(run.itemIds[0], 'inspect', now)
    const itemErrorId = artifacts.recordError({
      artifactId: null,
      generationId: null,
      code: 'OUTSIDE_ALLOWED_ROOT',
      stage: 'inspect',
      retryable: false,
      userMessage: 'The source is outside an allowed root.',
      technicalDetail: '/outside/allowed-root.md',
      occurredAt: now,
    })

    imports.failItem(run.itemIds[0], itemErrorId, now)

    expect(imports.getItem(run.itemIds[0])).toMatchObject({
      artifactId: null,
      errorId: itemErrorId,
      status: 'failed',
      completedAt: now,
    })
    expect(
      database.prepare('SELECT artifact_id FROM artifact_error WHERE id = ?').get(itemErrorId),
    ).toEqual({ artifact_id: null })

    database.close()
  })

  it('rejects restart and terminal mutation of completed or interrupted jobs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-import-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const imports = new ImportRepository(database)
    const artifacts = new ArtifactRepository(database)
    const now = '2026-08-31T00:00:00.000Z'
    const artifact = artifacts.register({
      sourcePath: '/canonical/completed.md',
      format: 'markdown',
      now,
    })
    const completed = imports.createRun(['/canonical/completed.md'])
    imports.startRun(completed.id, now)
    imports.attachArtifact(completed.itemIds[0], artifact.id)
    imports.startStage(completed.itemIds[0], 'extract', now)
    const errorId = artifacts.recordError({
      artifactId: artifact.id,
      generationId: null,
      code: 'MARKDOWN_PARSE_FAILED',
      stage: 'extract',
      retryable: true,
      userMessage: 'The Markdown could not be read.',
      technicalDetail: null,
      occurredAt: now,
    })
    imports.completeItem(completed.itemIds[0], now)
    imports.completeRun(completed.id, now)

    expect(() => imports.startRun(completed.id, now)).toThrow(/import run transition/i)
    expect(() => imports.requestCancellation(completed.id, now)).toThrow(/import run transition/i)
    expect(() => imports.cancelRun(completed.id, now)).toThrow(/import run transition/i)
    expect(() => imports.completeRun(completed.id, now)).toThrow(/import run transition/i)
    expect(() => imports.attachArtifact(completed.itemIds[0], artifact.id)).toThrow(
      /import item transition/i,
    )
    expect(() => imports.failItem(completed.itemIds[0], errorId, now)).toThrow(
      /import item transition/i,
    )
    expect(() => imports.cancelItem(completed.itemIds[0], now)).toThrow(/import item transition/i)
    expect(() => imports.completeItem(completed.itemIds[0], now)).toThrow(/import item transition/i)

    const interrupted = imports.createRun(['/canonical/interrupted.md'])
    database
      .prepare("UPDATE import_run SET status = 'interrupted' WHERE id = ?")
      .run(interrupted.id)
    database
      .prepare("UPDATE import_item SET status = 'interrupted' WHERE id = ?")
      .run(interrupted.itemIds[0])
    expect(() => imports.startRun(interrupted.id, now)).toThrow(/import run transition/i)
    expect(() => imports.cancelRun(interrupted.id, now)).toThrow(/import run transition/i)
    expect(() => imports.completeItem(interrupted.itemIds[0], now)).toThrow(
      /import item transition/i,
    )

    database.close()
  })

  it('reports unknown import run and item IDs instead of silently succeeding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-import-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const repository = new ImportRepository(database)
    const now = '2026-08-31T00:00:00.000Z'

    const runMutations = [
      () => repository.startRun(999, now),
      () => repository.requestCancellation(999, now),
      () => repository.cancelRun(999, now),
      () => repository.completeRun(999, now),
    ]
    for (const mutate of runMutations) {
      expect(mutate).toThrow(/import run transition/i)
    }

    const itemMutations = [
      () => repository.attachArtifact(999, 999),
      () => repository.failItem(999, 999, now),
      () => repository.cancelItem(999, now),
      () => repository.completeItem(999, now),
    ]
    for (const mutate of itemMutations) {
      expect(mutate).toThrow(/import item transition/i)
    }
    expect(repository.startStage(999, 'inspect', now)).toBe(false)

    database.close()
  })
})
