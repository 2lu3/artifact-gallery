import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/database.js'
import { GalleryRepository } from './gallery-repository.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('GalleryRepository', () => {
  it('applies format/status/keyset predicates in SQLite and returns only limit + 1 rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-page-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    seedArtifacts(database)
    const repository = new GalleryRepository(database)

    const first = repository.readPage({
      sort: 'newest',
      format: 'markdown',
      status: 'ready',
      limit: 31,
    })
    expect(first).toHaveLength(31)
    expect(first.every((row) => row.format === 'markdown')).toBe(true)
    expect(first.every((row) => row.presentation_status === 'ready')).toBe(true)

    const last = first.at(-1) as (typeof first)[number]
    const second = repository.readPage({
      sort: 'newest',
      format: 'markdown',
      status: 'ready',
      cursor: { lastSortKey: last.sort_key, lastId: last.id },
      limit: 31,
    })
    expect(second).toHaveLength(4)
    expect(new Set([...first, ...second].map(({ id }) => id)).size).toBe(35)

    const titleFirst = repository.readPage({
      sort: 'title',
      format: 'markdown',
      status: 'ready',
      limit: 31,
    })
    const titleLast = titleFirst.at(-1) as (typeof titleFirst)[number]
    const titleSecond = repository.readPage({
      sort: 'title',
      format: 'markdown',
      status: 'ready',
      cursor: { lastSortKey: titleLast.sort_key, lastId: titleLast.id },
      limit: 31,
    })
    expect(titleFirst).toHaveLength(31)
    expect(titleSecond).toHaveLength(4)
    expect(new Set([...titleFirst, ...titleSecond].map(({ id }) => id)).size).toBe(35)

    const htmlFailures = repository.readPage({
      sort: 'newest',
      format: 'html',
      status: 'failed',
      limit: 31,
    })
    expect(htmlFailures).toHaveLength(5)
    database.close()
  })
})

function seedArtifacts(database: ReturnType<typeof openDatabase>): void {
  const insertArtifact = database.prepare(
    `INSERT INTO artifact
      (source_path, format, source_status, created_at, updated_at, registered_at, generation_counter)
     VALUES (?, ?, 'available', ?, ?, ?, 1)`,
  )
  const insertGeneration = database.prepare(
    `INSERT INTO artifact_generation
      (artifact_id, generation, job_status, content_status, render_status, index_status)
     VALUES (?, 1, 'idle', ?, ?, ?)`,
  )
  database.transaction(() => {
    for (let index = 0; index < 40; index += 1) {
      const format = index < 35 ? 'markdown' : 'html'
      const state = format === 'markdown' ? 'ready' : 'failed'
      const timestamp = `2026-08-31T00:00:${index.toString().padStart(2, '0')}.000Z`
      const artifactId = Number(
        insertArtifact.run(`/catalog/${index}.${format === 'markdown' ? 'md' : 'html'}`, format, timestamp, timestamp, timestamp)
          .lastInsertRowid,
      )
      const generationId = Number(
        insertGeneration.run(artifactId, state, state, state).lastInsertRowid,
      )
      database.prepare('UPDATE artifact SET active_generation_id = ? WHERE id = ?').run(generationId, artifactId)
    }
  })()
}
