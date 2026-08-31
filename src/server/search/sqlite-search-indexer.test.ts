import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/database.js'
import { ArtifactRepository, type GenerationRecord } from '../repositories/artifact-repository.js'
import { SearchVisibilityRepository } from '../repositories/search-visibility-repository.js'
import { SQLiteSearchIndexer } from './sqlite-search-indexer.js'

const NOW = '2026-09-01T00:00:00.000Z'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('SQLiteSearchIndexer', () => {
  it('stages normalized generation text and finalizes ranked fields inside the processor transaction', async () => {
    const harness = await makeHarness('/Library/Ｆｏｏ-Bar/Guide.MD')
    harness.database
      .prepare('UPDATE artifact SET user_title = ? WHERE id = ?')
      .run('ＵＳＥＲ Title', harness.artifactId)
    const generation = harness.artifacts.createGeneration(harness.artifactId, NOW)

    const prepared = await harness.indexer.prepare({
      artifactId: harness.artifactId,
      generation: generation.generation,
      sourcePath: '/Library/Ｆｏｏ-Bar/Guide.MD',
      text: 'ＢＯＤＹ Search Ω',
    })

    expect(readDocument(harness.database, generation.id)).toEqual({
      user_title_normalized: 'user title',
      derived_title_normalized: '',
      body_normalized: 'body search Ω',
      path_segments_normalized: 'library foo bar guide md',
    })
    expect(readVisibility(harness.database, generation.id)).toBe('staged')

    harness.database.transaction(() => {
      harness.database
        .prepare('UPDATE artifact SET derived_title = ? WHERE id = ?')
        .run('ＤＥＲＩＶＥＤ Guide', harness.artifactId)
      commitReady(harness.artifacts, harness.artifactId, generation, 'ＢＯＤＹ Search Ω')
      prepared.commit()
    })()

    expect(readDocument(harness.database, generation.id)).toMatchObject({
      user_title_normalized: 'user title',
      derived_title_normalized: 'derived guide',
    })
    expect(
      harness.database
        .prepare(
          `SELECT artifact_id, generation FROM artifact_search_fts
           WHERE artifact_search_fts MATCH '"body search"'`,
        )
        .get(),
    ).toEqual({ artifact_id: harness.artifactId, generation: generation.generation })
    harness.database.close()
  })

  it('removes only the staged generation on rollback or quarantine', async () => {
    const harness = await makeHarness('/canonical/stable.md')
    const active = harness.artifacts.createGeneration(harness.artifactId, NOW)
    const activeIndex = await harness.indexer.prepare({
      artifactId: harness.artifactId,
      generation: active.generation,
      sourcePath: '/canonical/stable.md',
      text: 'stable searchable text',
    })
    harness.database.transaction(() => {
      commitReady(harness.artifacts, harness.artifactId, active, 'stable searchable text')
      activeIndex.commit()
    })()
    const staged = harness.artifacts.createGeneration(harness.artifactId, NOW)
    const stagedIndex = await harness.indexer.prepare({
      artifactId: harness.artifactId,
      generation: staged.generation,
      sourcePath: '/canonical/stable.md',
      text: 'uncommitted text',
    })

    await stagedIndex.rollback()
    expect(readIndexedGenerations(harness.database)).toEqual([active.generation])

    const quarantinedIndex = await harness.indexer.prepare({
      artifactId: harness.artifactId,
      generation: staged.generation,
      sourcePath: '/canonical/stable.md',
      text: 'quarantined text',
    })
    await quarantinedIndex.quarantine()
    expect(readIndexedGenerations(harness.database)).toEqual([active.generation])
    harness.database.close()
  })

  it('repairs a quarantined active ready generation before reopening the visibility gate', async () => {
    const harness = await makeHarness('/canonical/repair.md')
    const generation = harness.artifacts.createGeneration(harness.artifactId, NOW)
    const prepared = await harness.indexer.prepare({
      artifactId: harness.artifactId,
      generation: generation.generation,
      sourcePath: '/canonical/repair.md',
      text: 'repairable index text',
    })
    harness.database.transaction(() => {
      commitReady(harness.artifacts, harness.artifactId, generation, 'repairable index text')
      prepared.commit()
    })()
    const visibility = new SearchVisibilityRepository(harness.database)
    visibility.quarantineGeneration({
      artifactId: harness.artifactId,
      generationId: generation.id,
      now: NOW,
    })
    await prepared.quarantine()
    harness.artifacts.recordWarning({
      artifactId: harness.artifactId,
      generationId: generation.id,
      code: 'INDEX_REPAIR_PENDING',
      detail: 'Search index repair is pending.',
      occurredAt: NOW,
    })

    harness.indexer.repair({
      artifactId: harness.artifactId,
      generation: generation.generation,
      now: NOW,
    })

    const candidate = { artifactId: harness.artifactId, generation: generation.generation }
    expect(visibility.filterVisibleCandidates([candidate])).toEqual([candidate])
    expect(readDocument(harness.database, generation.id)).toMatchObject({
      body_normalized: 'repairable index text',
    })
    expect(harness.artifacts.listWarnings(harness.artifactId)).toEqual([])
    harness.database.close()
  })
})

async function makeHarness(sourcePath: string) {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-search-indexer-'))
  temporaryDirectories.push(directory)
  const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
  const artifacts = new ArtifactRepository(database)
  const artifact = artifacts.register({ sourcePath, format: 'markdown', now: NOW })
  return {
    database,
    artifacts,
    artifactId: artifact.id,
    indexer: new SQLiteSearchIndexer(database),
  }
}

function commitReady(
  artifacts: ArtifactRepository,
  artifactId: number,
  generation: GenerationRecord,
  text: string,
): void {
  artifacts.commitGeneration({
    artifactId,
    generationId: generation.id,
    expectedGeneration: generation.generation,
    contentStatus: 'ready',
    renderStatus: 'ready',
    indexStatus: 'ready',
    extractedText: text,
    extractorVersion: 'search-test-1',
    thumbnailPath: null,
    previewedAt: NOW,
    completedAt: NOW,
  })
}

function readDocument(database: ReturnType<typeof openDatabase>, generationId: number) {
  return database
    .prepare(
      `SELECT user_title_normalized, derived_title_normalized,
              body_normalized, path_segments_normalized
       FROM artifact_search_document WHERE generation_id = ?`,
    )
    .get(generationId)
}

function readVisibility(database: ReturnType<typeof openDatabase>, generationId: number) {
  return database
    .prepare('SELECT state FROM artifact_search_visibility WHERE generation_id = ?')
    .pluck()
    .get(generationId)
}

function readIndexedGenerations(database: ReturnType<typeof openDatabase>): number[] {
  return database
    .prepare('SELECT generation FROM artifact_search_document ORDER BY generation')
    .pluck()
    .all() as number[]
}
