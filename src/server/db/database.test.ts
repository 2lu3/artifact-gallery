import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './database.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('openDatabase', () => {
  it('initializes a fresh database with the complete schema and durable pragmas', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-db-'))
    temporaryDirectories.push(directory)

    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })

    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name)

    expect(tables).toEqual([
      'allowed_root',
      'artifact',
      'artifact_error',
      'artifact_generation',
      'artifact_warning',
      'import_item',
      'import_run',
      'schema_migration',
    ])
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal')

    const columnNames = (table: string) =>
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name)

    expect(columnNames('artifact')).toEqual([
      'id',
      'source_path',
      'format',
      'derived_title',
      'user_title',
      'source_status',
      'created_at',
      'updated_at',
      'registered_at',
      'active_generation_id',
      'generation_counter',
    ])
    expect(columnNames('artifact_generation')).toEqual([
      'id',
      'artifact_id',
      'generation',
      'job_status',
      'content_status',
      'render_status',
      'index_status',
      'extracted_text',
      'extractor_version',
      'thumbnail_path',
      'previewed_at',
      'started_at',
      'completed_at',
    ])
    expect(columnNames('artifact_error')).toEqual([
      'id',
      'artifact_id',
      'generation_id',
      'code',
      'stage',
      'retryable',
      'user_message',
      'technical_detail',
      'occurred_at',
    ])
    expect(columnNames('artifact_warning')).toEqual([
      'id',
      'artifact_id',
      'generation_id',
      'code',
      'detail',
      'occurred_at',
    ])
    expect(columnNames('allowed_root')).toEqual(['id', 'canonical_path', 'created_at'])
    expect(columnNames('import_run')).toEqual([
      'id',
      'status',
      'cancel_requested_at',
      'started_at',
      'completed_at',
    ])
    expect(columnNames('import_item')).toEqual([
      'id',
      'run_id',
      'canonical_path',
      'artifact_id',
      'stage',
      'status',
      'error_id',
      'started_at',
      'completed_at',
    ])

    database.close()
  })

  it('enforces canonical path and generation uniqueness', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-db-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const now = '2026-08-31T00:00:00.000Z'

    const artifact = database
      .prepare(
        `INSERT INTO artifact
          (source_path, format, source_status, created_at, updated_at, registered_at)
         VALUES (?, 'markdown', 'available', ?, ?, ?)`,
      )
      .run('/canonical/note.md', now, now, now)

    expect(() =>
      database
        .prepare(
          `INSERT INTO artifact
            (source_path, format, source_status, created_at, updated_at, registered_at)
           VALUES (?, 'markdown', 'available', ?, ?, ?)`,
        )
        .run('/canonical/note.md', now, now, now),
    ).toThrow()

    const insertGeneration = database.prepare(
      `INSERT INTO artifact_generation
        (artifact_id, generation, job_status, content_status, render_status, index_status)
       VALUES (?, 1, 'queued', 'pending', 'pending', 'pending')`,
    )
    insertGeneration.run(artifact.lastInsertRowid)
    expect(() => insertGeneration.run(artifact.lastInsertRowid)).toThrow()

    database.prepare('INSERT INTO allowed_root (canonical_path, created_at) VALUES (?, ?)').run(
      '/canonical',
      now,
    )
    expect(() =>
      database
        .prepare('INSERT INTO allowed_root (canonical_path, created_at) VALUES (?, ?)')
        .run('/canonical', now),
    ).toThrow()

    database.close()
  })

  it('rejects orphaned relational records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-db-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })

    expect(() =>
      database
        .prepare(
          `INSERT INTO artifact_generation
            (artifact_id, generation, job_status, content_status, render_status, index_status)
           VALUES (999, 1, 'queued', 'pending', 'pending', 'pending')`,
        )
        .run(),
    ).toThrow()
    expect(() =>
      database
        .prepare(
          `INSERT INTO import_item (run_id, canonical_path, stage, status)
           VALUES (999, '/canonical/note.md', 'queued', 'queued')`,
        )
        .run(),
    ).toThrow()

    database.close()
  })

  it('rejects values outside every persisted status domain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-db-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const now = '2026-08-31T00:00:00.000Z'

    expect(() =>
      database
        .prepare(
          `INSERT INTO artifact
            (source_path, format, source_status, created_at, updated_at, registered_at)
           VALUES ('/bad.txt', 'text', 'available', ?, ?, ?)`,
        )
        .run(now, now, now),
    ).toThrow()
    expect(() =>
      database
        .prepare(
          `INSERT INTO artifact
            (source_path, format, source_status, created_at, updated_at, registered_at)
           VALUES ('/unknown.md', 'markdown', 'unknown', ?, ?, ?)`,
        )
        .run(now, now, now),
    ).toThrow()

    const artifact = database
      .prepare(
        `INSERT INTO artifact
          (source_path, format, source_status, created_at, updated_at, registered_at)
         VALUES ('/canonical/note.md', 'markdown', 'available', ?, ?, ?)`,
      )
      .run(now, now, now)

    for (const field of [
      'job_status',
      'content_status',
      'render_status',
      'index_status',
    ] as const) {
      const statusValues = {
        job_status: ['unknown', 'pending', 'pending', 'pending'],
        content_status: ['queued', 'unknown', 'pending', 'pending'],
        render_status: ['queued', 'pending', 'unknown', 'pending'],
        index_status: ['queued', 'pending', 'pending', 'unknown'],
      }[field]
      expect(() =>
        database
          .prepare(
            `INSERT INTO artifact_generation
              (artifact_id, generation, job_status, content_status, render_status, index_status)
             VALUES (?, 1, ?, ?, ?, ?)`,
          )
          .run(artifact.lastInsertRowid, ...statusValues),
      ).toThrow()
    }
    expect(() => database.prepare("INSERT INTO import_run (status) VALUES ('active')").run()).toThrow()

    const run = database.prepare("INSERT INTO import_run (status) VALUES ('queued')").run()
    expect(() =>
      database
        .prepare(
          `INSERT INTO import_item (run_id, canonical_path, stage, status)
           VALUES (?, '/canonical/note.md', 'unknown', 'active')`,
        )
        .run(run.lastInsertRowid),
    ).toThrow()
    expect(() =>
      database
        .prepare(
          `INSERT INTO import_item (run_id, canonical_path, stage, status)
           VALUES (?, '/canonical/note.md', 'queued', 'active')`,
        )
        .run(run.lastInsertRowid),
    ).toThrow()

    database.close()
  })

  it('rejects cross-artifact generation and issue associations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-db-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const now = '2026-08-31T00:00:00.000Z'
    const insertArtifact = database.prepare(
      `INSERT INTO artifact
        (source_path, format, source_status, created_at, updated_at, registered_at)
       VALUES (?, 'markdown', 'available', ?, ?, ?)`,
    )
    const firstArtifactId = Number(
      insertArtifact.run('/canonical/first.md', now, now, now).lastInsertRowid,
    )
    const secondArtifactId = Number(
      insertArtifact.run('/canonical/second.md', now, now, now).lastInsertRowid,
    )
    const insertGeneration = database.prepare(
      `INSERT INTO artifact_generation
        (artifact_id, generation, job_status, content_status, render_status, index_status)
       VALUES (?, 1, 'idle', 'ready', 'ready', 'ready')`,
    )
    insertGeneration.run(firstArtifactId)
    const secondGenerationId = Number(insertGeneration.run(secondArtifactId).lastInsertRowid)

    expect(() =>
      database
        .prepare('UPDATE artifact SET active_generation_id = ? WHERE id = ?')
        .run(secondGenerationId, firstArtifactId),
    ).toThrow()
    expect(() =>
      database
        .prepare(
          `INSERT INTO artifact_error
            (artifact_id, generation_id, code, stage, retryable, user_message, occurred_at)
           VALUES (?, ?, 'INTERRUPTED', 'render', 1, 'Interrupted.', ?)`,
        )
        .run(firstArtifactId, secondGenerationId, now),
    ).toThrow()
    expect(() =>
      database
        .prepare(
          `INSERT INTO artifact_warning
            (artifact_id, generation_id, code, detail, occurred_at)
           VALUES (?, ?, 'PAGE_CLIPPED', 'Clipped.', ?)`,
        )
        .run(firstArtifactId, secondGenerationId, now),
    ).toThrow()

    const secondErrorId = Number(
      database
        .prepare(
          `INSERT INTO artifact_error
            (artifact_id, generation_id, code, stage, retryable, user_message, occurred_at)
           VALUES (?, ?, 'INTERRUPTED', 'render', 1, 'Interrupted.', ?)`,
        )
        .run(secondArtifactId, secondGenerationId, now).lastInsertRowid,
    )
    const runId = Number(
      database.prepare("INSERT INTO import_run (status) VALUES ('running')").run().lastInsertRowid,
    )
    const itemId = Number(
      database
        .prepare(
          `INSERT INTO import_item (run_id, canonical_path, artifact_id, stage, status)
           VALUES (?, '/canonical/first.md', ?, 'render', 'processing')`,
        )
        .run(runId, firstArtifactId).lastInsertRowid,
    )
    expect(() =>
      database.prepare('UPDATE import_item SET error_id = ? WHERE id = ?').run(secondErrorId, itemId),
    ).toThrow()

    database.close()
  })
})
