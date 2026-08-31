import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../../src/server/db/database.js'
import { ArtifactProcessor } from '../../src/server/processing/artifact-processor.js'
import { PathPolicy } from '../../src/server/security/path-policy.js'
import { normalizeSearchNeedle } from '../../src/server/search/search-query.js'
import { SearchRepository } from '../../src/server/search/search-repository.js'

const CORPUS_DIRECTORY = resolve(process.cwd(), 'tests/fixtures/search-corpus')
const RUNS_PER_QUERY = 10
const temporaryDirectories: string[] = []

interface CorpusManifest {
  artifacts: Array<{ id: number; file: string; userTitle?: string }>
  queries: Array<{ query: string; expectedId: number }>
}

interface BigramDocument {
  artifactId: number
  userTitle: string
  derivedTitle: string
  body: string
  path: string
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('fixed search quality evaluation', () => {
  it('keeps FTS5 trigram when it meets top-five quality and latency gates against bigram', async () => {
    const manifest = JSON.parse(
      await readFile(join(CORPUS_DIRECTORY, 'manifest.json'), 'utf8'),
    ) as CorpusManifest
    expect(manifest.artifacts).toHaveLength(20)
    expect(manifest.queries).toHaveLength(20)

    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-search-eval-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const pathPolicy = await PathPolicy.create([CORPUS_DIRECTORY])
    let clock = 0
    const processor = new ArtifactProcessor({
      database,
      pathPolicy,
      htmlRenderer: {
        render: async () => ({
          screenshot: Buffer.from('RIFF-search-eval-WEBP'),
          width: 1200,
          height: 800,
          warnings: [],
        }),
      },
      thumbnailDirectory: join(directory, 'thumbnails'),
      thumbnailOptimizer: {
        optimize: async ({ bytes, width, height }) => ({
          bytes,
          width,
          height,
          quality: 80,
        }),
      },
      now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, clock++)).toISOString(),
    })

    for (const artifact of manifest.artifacts) {
      const result = await processor.register({
        sourcePath: join(CORPUS_DIRECTORY, artifact.file),
        userTitle: artifact.userTitle,
      })
      expect(result).toMatchObject({ outcome: 'completed', artifactId: artifact.id })
    }

    const repository = new SearchRepository(database)
    const queryStats = manifest.queries.map(({ query, expectedId }) => {
      const timings: number[] = []
      let resultIds: number[] = []
      for (let run = 0; run < RUNS_PER_QUERY; run += 1) {
        const startedAt = performance.now()
        resultIds = repository.search(query).map(({ artifactId }) => artifactId)
        timings.push(performance.now() - startedAt)
      }
      return {
        query,
        hit: resultIds.includes(expectedId),
        medianMs: median(timings),
        maxMs: Math.max(...timings),
      }
    })
    const trigramHits = queryStats.filter(({ hit }) => hit).length
    const trigramMedianMs = median(queryStats.flatMap(({ medianMs }) => [medianMs]))
    const trigramMaxMs = Math.max(...queryStats.map(({ maxMs }) => maxMs))

    const bigramDocuments = database
      .prepare(
        `SELECT artifact_id,
                user_title_normalized,
                derived_title_normalized,
                body_normalized,
                path_segments_normalized
         FROM artifact_search_document`,
      )
      .all()
      .map((row) => {
        const document = row as {
          artifact_id: number
          user_title_normalized: string
          derived_title_normalized: string
          body_normalized: string
          path_segments_normalized: string
        }
        return {
          artifactId: document.artifact_id,
          userTitle: document.user_title_normalized,
          derivedTitle: document.derived_title_normalized,
          body: document.body_normalized,
          path: document.path_segments_normalized,
        }
      }) satisfies BigramDocument[]
    const bigramHits = manifest.queries.filter(({ query, expectedId }) =>
      prototypeBigramSearch(query, bigramDocuments).includes(expectedId),
    ).length

    console.info(
      `search-eval trigram=${trigramHits}/20 bigram=${bigramHits}/20 ` +
        `median=${trigramMedianMs.toFixed(3)}ms max=${trigramMaxMs.toFixed(3)}ms`,
    )
    expect(trigramHits).toBeGreaterThanOrEqual(18)
    expect(queryStats.every(({ medianMs }) => medianMs <= 200)).toBe(true)
    expect(trigramMaxMs).toBeLessThanOrEqual(400)
    expect(trigramHits >= 18 && trigramMedianMs <= 200 ? 'trigram' : 'bigram').toBe(
      'trigram',
    )
    database.close()
  })
})

function prototypeBigramSearch(query: string, documents: BigramDocument[]): number[] {
  const normalized = normalizeSearchNeedle(query)
  const quoted = query.trim().startsWith('"') && query.trim().endsWith('"')
  const terms = quoted ? [normalized] : normalized.split(/\s+/u).filter(Boolean)
  return documents
    .map((document) => ({
      artifactId: document.artifactId,
      score: Math.max(
        bigramFieldScore(document.userTitle, terms, 4),
        bigramFieldScore(document.derivedTitle, terms, 3),
        bigramFieldScore(document.body, terms, 2),
        bigramFieldScore(document.path, terms, 1),
      ),
    }))
    .filter(({ score }) => score > 0)
    .toSorted((left, right) => right.score - left.score || left.artifactId - right.artifactId)
    .slice(0, 5)
    .map(({ artifactId }) => artifactId)
}

function bigramFieldScore(field: string, terms: string[], weight: number): number {
  return terms.every((term) => bigrams(term).every((bigram) => field.includes(bigram)))
    ? weight
    : 0
}

function bigrams(term: string): string[] {
  const characters = Array.from(term)
  if (characters.length <= 2) return [term]
  return characters.slice(0, -1).map((character, index) => character + characters[index + 1])
}

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}
