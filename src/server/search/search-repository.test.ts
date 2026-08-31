import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/database.js'
import { ArtifactRepository, type DerivedStatus } from '../repositories/artifact-repository.js'
import { SearchVisibilityRepository } from '../repositories/search-visibility-repository.js'
import { SearchRepository } from './search-repository.js'
import { SQLiteSearchIndexer } from './sqlite-search-indexer.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('SearchRepository', () => {
  it('uses trigram AND, quoted phrase, punctuation, and NFKC query semantics', async () => {
    const harness = await makeHarness()
    const exact = await harness.seed({
      sourcePath: '/corpus/exact.md',
      text: 'Alpha beta uses node.js, C++, and compatibility artifact text.',
    })
    await harness.seed({
      sourcePath: '/corpus/separated.md',
      text: 'Alpha has many unrelated words before beta.',
    })
    await harness.seed({ sourcePath: '/corpus/alpha-only.md', text: 'Alpha only.' })

    expect(harness.search.search('alpha artifact').map(({ artifactId }) => artifactId)).toEqual([
      exact.artifactId,
    ])
    expect(harness.search.search('"alpha beta"').map(({ artifactId }) => artifactId)).toEqual([
      exact.artifactId,
    ])
    expect(harness.search.search('node.js').map(({ artifactId }) => artifactId)).toEqual([
      exact.artifactId,
    ])
    expect(harness.search.search('C++').map(({ artifactId }) => artifactId)).toEqual([
      exact.artifactId,
    ])
    expect(harness.search.search('ＡＲＴＩＦＡＣＴ').map(({ artifactId }) => artifactId)).toEqual([
      exact.artifactId,
    ])
    harness.database.close()
  })

  it('ranks user title above derived title, body, and path', async () => {
    const harness = await makeHarness()
    const path = await harness.seed({
      sourcePath: '/corpus/rankingtoken/path.md',
      derivedTitle: 'Unrelated path card',
      text: 'ordinary content',
    })
    const body = await harness.seed({
      sourcePath: '/corpus/body.md',
      derivedTitle: 'Unrelated body card',
      text: 'rankingtoken',
    })
    const derived = await harness.seed({
      sourcePath: '/corpus/derived.md',
      derivedTitle: 'rankingtoken',
      text: 'ordinary content',
    })
    const user = await harness.seed({
      sourcePath: '/corpus/user.md',
      userTitle: 'rankingtoken',
      derivedTitle: 'Unrelated user card',
      text: 'ordinary content',
    })

    expect(harness.search.search('rankingtoken').map(({ artifactId }) => artifactId)).toEqual([
      user.artifactId,
      derived.artifactId,
      body.artifactId,
      path.artifactId,
    ])
    harness.database.close()
  })

  it('scans normalized title and body for 1–2 character queries with a hard 100-artifact bound', async () => {
    const harness = await makeHarness()
    for (let index = 0; index < 101; index += 1) {
      await harness.seed({
        sourcePath: `/short/${index}.md`,
        userTitle: index === 100 ? 'AI title' : null,
        text: `猫 AI body ${index}`,
        registeredAt: timestamp(index),
      })
    }

    const japanese = harness.search.search('猫', { limit: 200 })
    const ascii = harness.search.search('ＡI', { limit: 200 })

    expect(japanese).toHaveLength(100)
    expect(ascii).toHaveLength(100)
    expect(ascii[0]?.title).toBe('AI title')
    harness.database.close()
  })

  it('applies AND to unquoted short terms while only quoted short text requires adjacency', async () => {
    const harness = await makeHarness()
    const separated = await harness.seed({
      sourcePath: '/short/separated.md',
      derivedTitle: 'Title',
      text: 'a middle b',
      registeredAt: timestamp(1),
    })
    const exact = await harness.seed({
      sourcePath: '/short/exact.md',
      derivedTitle: 'Title',
      text: 'a b',
      registeredAt: timestamp(2),
    })
    await harness.seed({
      sourcePath: '/short/incomplete.md',
      derivedTitle: 'Title',
      text: 'a middle',
      registeredAt: timestamp(3),
    })
    const mixed = await harness.seed({
      sourcePath: '/short/mixed.md',
      userTitle: '猫',
      derivedTitle: 'Title',
      text: 'a marker',
      registeredAt: timestamp(4),
    })
    const japanese = await harness.seed({
      sourcePath: '/short/japanese.md',
      derivedTitle: 'Title',
      text: '猫 middle 犬',
      registeredAt: timestamp(5),
    })

    expect(harness.search.search('a b').map(({ artifactId }) => artifactId)).toEqual([
      exact.artifactId,
      separated.artifactId,
    ])
    expect(harness.search.search('"a b"').map(({ artifactId }) => artifactId)).toEqual([
      exact.artifactId,
    ])
    expect(harness.search.search('猫 a').map(({ artifactId }) => artifactId)).toEqual([
      mixed.artifactId,
    ])
    expect(harness.search.search('猫 犬').map(({ artifactId }) => artifactId)).toEqual([
      japanese.artifactId,
    ])
    expect(harness.search.search('"猫 犬"')).toEqual([])
    harness.database.close()
  })

  it('returns visible indexed artifacts newest registered first for an empty query', async () => {
    const harness = await makeHarness()
    const oldest = await harness.seed({
      sourcePath: '/empty/oldest.md',
      text: 'oldest',
      registeredAt: timestamp(1),
    })
    const newest = await harness.seed({
      sourcePath: '/empty/newest.md',
      text: 'newest',
      registeredAt: timestamp(3),
    })
    const middle = await harness.seed({
      sourcePath: '/empty/middle.md',
      text: 'middle',
      registeredAt: timestamp(2),
    })

    expect(harness.search.search('').map(({ artifactId }) => artifactId)).toEqual([
      newest.artifactId,
      middle.artifactId,
      oldest.artifactId,
    ])
    harness.database.close()
  })

  it('passes FTS, short-query, and empty-query candidates through the visibility repository', async () => {
    const harness = await makeHarness()
    const visible = await harness.seed({
      sourcePath: '/visibility/visible.md',
      userTitle: '猫 visible',
      text: 'visiblegalaxy',
      registeredAt: timestamp(1),
    })
    const quarantined = await harness.seed({
      sourcePath: '/visibility/quarantined.md',
      userTitle: '猫 quarantined',
      text: 'quarantinegalaxy',
      registeredAt: timestamp(4),
    })
    new SearchVisibilityRepository(harness.database).quarantineGeneration({
      artifactId: quarantined.artifactId,
      generationId: quarantined.generationId,
      now: timestamp(5),
    })
    const failed = await harness.seed({
      sourcePath: '/visibility/failed.md',
      userTitle: '猫 failed',
      text: 'failedgalaxy',
      indexStatus: 'failed',
      registeredAt: timestamp(3),
    })
    const stale = await harness.seed({
      sourcePath: '/visibility/stale.md',
      userTitle: '猫 stale',
      text: 'stalegalaxy',
      registeredAt: timestamp(2),
    })
    harness.database
      .prepare('UPDATE artifact SET user_title = NULL, derived_title = ? WHERE id = ?')
      .run('replacement title', stale.artifactId)
    await harness.addGeneration(stale.artifactId, '/visibility/stale.md', 'replacement text')

    expect(harness.search.search('visiblegalaxy').map(({ artifactId }) => artifactId)).toEqual([
      visible.artifactId,
    ])
    expect(harness.search.search('quarantinegalaxy')).toEqual([])
    expect(harness.search.search('failedgalaxy')).toEqual([])
    expect(harness.search.search('stalegalaxy')).toEqual([])
    expect(harness.search.search('猫').map(({ artifactId }) => artifactId)).toEqual([
      visible.artifactId,
    ])
    expect(harness.search.search('').map(({ artifactId }) => artifactId)).not.toContain(
      quarantined.artifactId,
    )
    expect(harness.search.search('').map(({ artifactId }) => artifactId)).not.toContain(
      failed.artifactId,
    )
    harness.database.close()
  })

  it('ranks and limits only eligible active rows when 500 stale generations score higher', async () => {
    const harness = await makeHarness()
    const artifact = await harness.seed({
      sourcePath: '/visibility/overflow.md',
      derivedTitle: 'overflowtoken',
      text: 'old body',
    })
    for (let generation = 2; generation <= 500; generation += 1) {
      await harness.addGeneration(
        artifact.artifactId,
        '/visibility/overflow.md',
        `old body ${generation}`,
      )
    }
    harness.database
      .prepare('UPDATE artifact SET derived_title = ? WHERE id = ?')
      .run('active title', artifact.artifactId)
    const active = await harness.addGeneration(
      artifact.artifactId,
      '/visibility/overflow.md',
      'active body contains overflowtoken',
    )

    expect(active.generation).toBe(501)
    expect(harness.search.search('overflowtoken').map(({ artifactId }) => artifactId)).toEqual([
      artifact.artifactId,
    ])
    harness.database.close()
  })

  it('applies short-query eligibility before 101 newer failed or quarantined rows reach the 100-row bound', async () => {
    const harness = await makeHarness()
    const eligible = await harness.seed({
      sourcePath: '/eligibility/short-visible.md',
      derivedTitle: 'Visible short result',
      text: '猫',
      registeredAt: timestamp(0),
    })
    const visibility = new SearchVisibilityRepository(harness.database)
    for (let index = 1; index <= 101; index += 1) {
      const ineligible = await harness.seed({
        sourcePath: `/eligibility/short-hidden-${index}.md`,
        derivedTitle: `Hidden short result ${index}`,
        text: '猫',
        registeredAt: timestamp(index),
        indexStatus: index % 2 === 0 ? 'failed' : 'ready',
      })
      if (index % 2 === 1) {
        visibility.quarantineGeneration({
          artifactId: ineligible.artifactId,
          generationId: ineligible.generationId,
          now: timestamp(index + 200),
        })
      }
    }

    expect(harness.search.search('猫').map(({ artifactId }) => artifactId)).toEqual([
      eligible.artifactId,
    ])
    harness.database.close()
  })

  it('applies empty-query eligibility before 501 newer failed or quarantined rows reach the 500-row bound', async () => {
    const harness = await makeHarness()
    const eligible = await harness.seed({
      sourcePath: '/eligibility/empty-visible.md',
      derivedTitle: 'Visible empty result',
      text: 'visible',
      registeredAt: timestamp(0),
    })
    const visibility = new SearchVisibilityRepository(harness.database)
    for (let index = 1; index <= 501; index += 1) {
      const ineligible = await harness.seed({
        sourcePath: `/eligibility/empty-hidden-${index}.md`,
        derivedTitle: `Hidden empty result ${index}`,
        text: 'hidden',
        registeredAt: timestamp(index),
        indexStatus: index % 2 === 0 ? 'failed' : 'ready',
      })
      if (index % 2 === 1) {
        visibility.quarantineGeneration({
          artifactId: ineligible.artifactId,
          generationId: ineligible.generationId,
          now: timestamp(index + 600),
        })
      }
    }

    expect(harness.search.search('').map(({ artifactId }) => artifactId)).toEqual([
      eligible.artifactId,
    ])
    harness.database.close()
  })
})

async function makeHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-search-repository-'))
  temporaryDirectories.push(directory)
  const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
  const artifacts = new ArtifactRepository(database)
  const indexer = new SQLiteSearchIndexer(database)

  const addGeneration = async (
    artifactId: number,
    sourcePath: string,
    text: string,
    indexStatus: DerivedStatus = 'ready',
  ) => {
    const generation = artifacts.createGeneration(artifactId, timestamp(0))
    const prepared = await indexer.prepare({
      artifactId,
      generation: generation.generation,
      sourcePath,
      text,
    })
    database.transaction(() => {
      artifacts.commitGeneration({
        artifactId,
        generationId: generation.id,
        expectedGeneration: generation.generation,
        contentStatus: 'ready',
        renderStatus: 'ready',
        indexStatus,
        extractedText: text,
        extractorVersion: 'search-test-1',
        thumbnailPath: null,
        previewedAt: timestamp(0),
        completedAt: timestamp(0),
      })
      prepared.commit()
    })()
    return { artifactId, generationId: generation.id, generation: generation.generation }
  }

  const seed = async (input: {
    sourcePath: string
    text: string
    userTitle?: string | null
    derivedTitle?: string | null
    registeredAt?: string
    indexStatus?: DerivedStatus
  }) => {
    const registeredAt = input.registeredAt ?? timestamp(0)
    const artifact = artifacts.register({
      sourcePath: input.sourcePath,
      format: 'markdown',
      now: registeredAt,
    })
    database
      .prepare('UPDATE artifact SET user_title = ?, derived_title = ? WHERE id = ?')
      .run(input.userTitle ?? null, input.derivedTitle ?? basename(input.sourcePath), artifact.id)
    return addGeneration(artifact.id, input.sourcePath, input.text, input.indexStatus ?? 'ready')
  }

  return {
    database,
    artifacts,
    indexer,
    search: new SearchRepository(database),
    seed,
    addGeneration,
  }
}

function timestamp(offset: number): string {
  return new Date(Date.UTC(2026, 8, 1, 0, 0, offset)).toISOString()
}
