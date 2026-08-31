import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/database.js'
import { ArtifactRepository } from './artifact-repository.js'
import { SearchVisibilityRepository } from './search-visibility-repository.js'

const temporaryDirectories: string[] = []
const NOW = '2026-09-01T00:00:00.000Z'

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('SearchVisibilityRepository', () => {
  it('returns only external candidates whose generation is active, index-ready, and visible', async () => {
    const { database, artifacts, visibility } = await makeHarness()
    const artifact = artifacts.register({
      sourcePath: '/canonical/searchable.md',
      format: 'markdown',
      now: NOW,
    })
    const active = artifacts.createGeneration(artifact.id, NOW)
    artifacts.commitGeneration({
      artifactId: artifact.id,
      generationId: active.id,
      expectedGeneration: active.generation,
      contentStatus: 'ready',
      renderStatus: 'ready',
      indexStatus: 'ready',
      extractedText: 'active text',
      extractorVersion: 'commonmark-safe-1',
      thumbnailPath: '/derived/active.webp',
      previewedAt: NOW,
      completedAt: NOW,
    })
    const staged = artifacts.createGeneration(artifact.id, NOW)
    database
      .prepare(
        `UPDATE artifact_generation SET index_status = 'ready'
         WHERE id = ?`,
      )
      .run(staged.id)
    database
      .prepare(
        `UPDATE artifact_search_visibility SET state = 'visible'
         WHERE generation_id = ?`,
      )
      .run(staged.id)
    const candidates = [
      { artifactId: artifact.id, generation: active.generation, text: 'active text' },
      { artifactId: artifact.id, generation: staged.generation, text: 'staged text' },
    ]

    expect(visibility.filterVisibleCandidates(candidates)).toEqual([candidates[0]])

    database
      .prepare("UPDATE artifact_generation SET index_status = 'failed' WHERE id = ?")
      .run(active.id)
    expect(visibility.filterVisibleCandidates(candidates)).toEqual([])
    database.close()
  })

  it('persists quarantine and releases an active ready generation only after repair succeeds', async () => {
    const { database, filename, artifacts, visibility } = await makeHarness()
    const artifact = artifacts.register({
      sourcePath: '/canonical/repair.md',
      format: 'markdown',
      now: NOW,
    })
    const generation = artifacts.createGeneration(artifact.id, NOW)
    artifacts.commitGeneration({
      artifactId: artifact.id,
      generationId: generation.id,
      expectedGeneration: generation.generation,
      contentStatus: 'ready',
      renderStatus: 'ready',
      indexStatus: 'ready',
      extractedText: 'repairable text',
      extractorVersion: 'commonmark-safe-1',
      thumbnailPath: '/derived/repair.webp',
      previewedAt: NOW,
      completedAt: NOW,
    })
    const candidate = {
      artifactId: artifact.id,
      generation: generation.generation,
      text: 'repairable text',
    }

    visibility.quarantineGeneration({
      artifactId: artifact.id,
      generationId: generation.id,
      now: NOW,
    })
    database.close()

    const reopened = openDatabase({ filename })
    const persisted = new SearchVisibilityRepository(reopened)
    expect(persisted.filterVisibleCandidates([candidate])).toEqual([])

    persisted.clearQuarantineAfterRepair({
      artifactId: artifact.id,
      generationId: generation.id,
      now: NOW,
    })
    expect(persisted.filterVisibleCandidates([candidate])).toEqual([candidate])
    reopened.close()
  })
})

async function makeHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-search-visibility-'))
  temporaryDirectories.push(directory)
  const filename = join(directory, 'gallery.sqlite')
  const database = openDatabase({ filename })
  return {
    filename,
    database,
    artifacts: new ArtifactRepository(database),
    visibility: new SearchVisibilityRepository(database),
  }
}
