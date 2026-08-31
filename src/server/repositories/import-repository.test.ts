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
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('ImportRepository', () => {
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
})
