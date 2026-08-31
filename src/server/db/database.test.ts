import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

  it('matches nullable import-item and error owners even through direct SQL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-db-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const now = '2026-08-31T00:00:00.000Z'
    const artifactId = Number(
      database
        .prepare(
          `INSERT INTO artifact
            (source_path, format, source_status, created_at, updated_at, registered_at)
           VALUES ('/canonical/owned.md', 'markdown', 'available', ?, ?, ?)`,
        )
        .run(now, now, now).lastInsertRowid,
    )
    const insertError = database.prepare(
      `INSERT INTO artifact_error
        (artifact_id, generation_id, code, stage, retryable, user_message, occurred_at)
       VALUES (?, NULL, 'OUTSIDE_ALLOWED_ROOT', 'inspect', 0, 'Outside root.', ?)`,
    )
    const ownedErrorId = Number(insertError.run(artifactId, now).lastInsertRowid)
    const itemErrorId = Number(insertError.run(null, now).lastInsertRowid)
    const runId = Number(
      database.prepare("INSERT INTO import_run (status) VALUES ('running')").run().lastInsertRowid,
    )
    const insertItem = database.prepare(
      `INSERT INTO import_item (run_id, canonical_path, stage, status)
       VALUES (?, ?, 'inspect', 'processing')`,
    )
    const unlinkedItemId = Number(
      insertItem.run(runId, '/canonical/not-registered.md').lastInsertRowid,
    )
    const itemErrorItemId = Number(
      insertItem.run(runId, '/outside/allowed-root.md').lastInsertRowid,
    )

    expect(() =>
      database
        .prepare('UPDATE import_item SET error_id = ? WHERE id = ?')
        .run(ownedErrorId, unlinkedItemId),
    ).toThrow()
    database
      .prepare('UPDATE import_item SET error_id = ? WHERE id = ?')
      .run(itemErrorId, itemErrorItemId)
    expect(() =>
      database
        .prepare('UPDATE import_item SET artifact_id = ? WHERE id = ?')
        .run(artifactId, itemErrorItemId),
    ).toThrow()

    expect(
      database
        .prepare('SELECT artifact_id, error_id FROM import_item WHERE id = ?')
        .get(itemErrorItemId),
    ).toEqual({ artifact_id: null, error_id: itemErrorId })
    database.close()
  })

  it('upgrades an existing 001 database without losing persisted rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-db-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'gallery.sqlite')
    const legacyMigrations = join(directory, 'legacy-migrations')
    await mkdir(legacyMigrations)
    await copyFile(
      resolve(process.cwd(), 'tests/fixtures/migrations/001_initial.sql'),
      join(legacyMigrations, '001_initial.sql'),
    )
    const legacy = openDatabase({ filename, migrationsDirectory: legacyMigrations })
    const now = '2026-08-31T00:00:00.000Z'
    const artifactId = Number(
      legacy
        .prepare(
          `INSERT INTO artifact
            (source_path, format, source_status, created_at, updated_at, registered_at, generation_counter)
           VALUES ('/canonical/legacy.md', 'markdown', 'available', ?, ?, ?, 1)`,
        )
        .run(now, now, now).lastInsertRowid,
    )
    const generationId = Number(
      legacy
        .prepare(
          `INSERT INTO artifact_generation
            (artifact_id, generation, job_status, content_status, render_status, index_status,
             extracted_text, thumbnail_path, completed_at)
           VALUES (?, 1, 'idle', 'ready', 'ready', 'ready', 'legacy text', '/derived/legacy.webp', ?)`,
        )
        .run(artifactId, now).lastInsertRowid,
    )
    legacy
      .prepare('UPDATE artifact SET active_generation_id = ? WHERE id = ?')
      .run(generationId, artifactId)
    const errorId = Number(
      legacy
        .prepare(
          `INSERT INTO artifact_error
            (artifact_id, generation_id, code, stage, retryable, user_message, occurred_at)
           VALUES (?, ?, 'ASSET_BLOCKED', 'render', 0, 'Asset blocked.', ?)`,
        )
        .run(artifactId, generationId, now).lastInsertRowid,
    )
    legacy
      .prepare(
        `INSERT INTO artifact_warning
          (artifact_id, generation_id, code, detail, occurred_at)
         VALUES (?, ?, 'PAGE_CLIPPED', 'Preview clipped.', ?)`,
      )
      .run(artifactId, generationId, now)
    const runId = Number(
      legacy.prepare("INSERT INTO import_run (status) VALUES ('completed')").run().lastInsertRowid,
    )
    const itemId = Number(
      legacy
        .prepare(
          `INSERT INTO import_item
            (run_id, canonical_path, artifact_id, stage, status, error_id, completed_at)
           VALUES (?, '/canonical/legacy.md', ?, 'render', 'failed', ?, ?)`,
        )
        .run(runId, artifactId, errorId, now).lastInsertRowid,
    )
    legacy.close()

    const upgraded = openDatabase({ filename })

    expect(
      upgraded.prepare('SELECT version FROM schema_migration ORDER BY version').all(),
    ).toEqual([{ version: '001_initial.sql' }, { version: '002_error_ownership.sql' }])
    expect(
      upgraded
        .prepare(
          `SELECT active_generation_id, generation_counter
           FROM artifact WHERE id = ?`,
        )
        .get(artifactId),
    ).toEqual({ active_generation_id: generationId, generation_counter: 1 })
    expect(
      upgraded
        .prepare(
          `SELECT artifact_id, generation_id, code
           FROM artifact_error WHERE id = ?`,
        )
        .get(errorId),
    ).toEqual({ artifact_id: artifactId, generation_id: generationId, code: 'ASSET_BLOCKED' })
    expect(
      upgraded
        .prepare('SELECT artifact_id, error_id, status FROM import_item WHERE id = ?')
        .get(itemId),
    ).toEqual({ artifact_id: artifactId, error_id: errorId, status: 'failed' })
    expect(
      upgraded.prepare('SELECT COUNT(*) AS count FROM artifact_warning').get(),
    ).toEqual({ count: 1 })
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO artifact_error
            (artifact_id, generation_id, code, stage, retryable, user_message, occurred_at)
           VALUES (NULL, NULL, 'OUTSIDE_ALLOWED_ROOT', 'inspect', 0, 'Outside root.', ?)`,
        )
        .run(now),
    ).not.toThrow()
    upgraded.close()
  })

  it('upgrades the pre-002 ownership variant without losing rows or ownership checks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-db-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'gallery.sqlite')
    const legacyMigrations = join(directory, 'legacy-migrations')
    await mkdir(legacyMigrations)
    await copyFile(
      resolve(process.cwd(), 'tests/fixtures/migrations/001_error_ownership.sql'),
      join(legacyMigrations, '001_initial.sql'),
    )
    const legacy = openDatabase({ filename, migrationsDirectory: legacyMigrations })
    legacy.exec(`
      CREATE TRIGGER artifact_active_generation_owner_insert
      AFTER INSERT ON artifact BEGIN SELECT 1; END;
      CREATE TRIGGER artifact_active_generation_owner_update
      BEFORE UPDATE OF active_generation_id ON artifact BEGIN SELECT 1; END;
      CREATE TRIGGER artifact_error_generation_owner_insert
      BEFORE INSERT ON artifact_error BEGIN SELECT 1; END;
      CREATE TRIGGER artifact_error_generation_owner_update
      BEFORE UPDATE OF generation_id, artifact_id ON artifact_error BEGIN SELECT 1; END;
      CREATE TRIGGER artifact_warning_generation_owner_insert
      BEFORE INSERT ON artifact_warning BEGIN SELECT 1; END;
      CREATE TRIGGER artifact_warning_generation_owner_update
      BEFORE UPDATE OF generation_id, artifact_id ON artifact_warning BEGIN SELECT 1; END;
    `)
    const now = '2026-08-31T00:00:00.000Z'
    const artifactId = Number(
      legacy
        .prepare(
          `INSERT INTO artifact
            (source_path, format, source_status, created_at, updated_at, registered_at, generation_counter)
           VALUES ('/canonical/pre-002.md', 'markdown', 'available', ?, ?, ?, 1)`,
        )
        .run(now, now, now).lastInsertRowid,
    )
    const generationId = Number(
      legacy
        .prepare(
          `INSERT INTO artifact_generation
            (artifact_id, generation, job_status, content_status, render_status, index_status,
             extracted_text, thumbnail_path, completed_at)
           VALUES (?, 1, 'idle', 'ready', 'ready', 'ready', 'pre-002 text',
                   '/derived/pre-002.webp', ?)`,
        )
        .run(artifactId, now).lastInsertRowid,
    )
    legacy
      .prepare('UPDATE artifact SET active_generation_id = ? WHERE id = ?')
      .run(generationId, artifactId)
    const errorId = Number(
      legacy
        .prepare(
          `INSERT INTO artifact_error
            (artifact_id, generation_id, code, stage, retryable, user_message, occurred_at)
           VALUES (?, ?, 'ASSET_BLOCKED', 'render', 0, 'Asset blocked.', ?)`,
        )
        .run(artifactId, generationId, now).lastInsertRowid,
    )
    legacy
      .prepare(
        `INSERT INTO artifact_warning
          (artifact_id, generation_id, code, detail, occurred_at)
         VALUES (?, ?, 'PAGE_CLIPPED', 'Preview clipped.', ?)`,
      )
      .run(artifactId, generationId, now)
    const runId = Number(
      legacy.prepare("INSERT INTO import_run (status) VALUES ('completed')").run().lastInsertRowid,
    )
    const itemId = Number(
      legacy
        .prepare(
          `INSERT INTO import_item
            (run_id, canonical_path, artifact_id, stage, status, error_id, completed_at)
           VALUES (?, '/canonical/pre-002.md', ?, 'render', 'failed', ?, ?)`,
        )
        .run(runId, artifactId, errorId, now).lastInsertRowid,
    )
    legacy.close()

    const upgraded = openDatabase({ filename })

    expect(
      upgraded.prepare('SELECT version FROM schema_migration ORDER BY version').all(),
    ).toEqual([{ version: '001_initial.sql' }, { version: '002_error_ownership.sql' }])
    expect(
      upgraded
        .prepare(
          `SELECT artifact.active_generation_id, artifact.generation_counter,
                  artifact_generation.extracted_text, artifact_generation.thumbnail_path
           FROM artifact
           JOIN artifact_generation ON artifact_generation.artifact_id = artifact.id
           WHERE artifact.id = ?`,
        )
        .get(artifactId),
    ).toEqual({
      active_generation_id: generationId,
      generation_counter: 1,
      extracted_text: 'pre-002 text',
      thumbnail_path: '/derived/pre-002.webp',
    })
    expect(
      upgraded
        .prepare(
          `SELECT artifact_error.generation_id, artifact_warning.generation_id AS warning_generation_id,
                  import_item.artifact_id, import_item.error_id, import_item.status
           FROM artifact_error
           JOIN artifact_warning ON artifact_warning.artifact_id = artifact_error.artifact_id
           JOIN import_item ON import_item.error_id = artifact_error.id
           WHERE artifact_error.id = ? AND import_item.id = ?`,
        )
        .get(errorId, itemId),
    ).toEqual({
      generation_id: generationId,
      warning_generation_id: generationId,
      artifact_id: artifactId,
      error_id: errorId,
      status: 'failed',
    })

    const otherArtifactId = Number(
      upgraded
        .prepare(
          `INSERT INTO artifact
            (source_path, format, source_status, created_at, updated_at, registered_at)
           VALUES ('/canonical/other.md', 'markdown', 'available', ?, ?, ?)`,
        )
        .run(now, now, now).lastInsertRowid,
    )
    const otherGenerationId = Number(
      upgraded
        .prepare(
          `INSERT INTO artifact_generation
            (artifact_id, generation, job_status, content_status, render_status, index_status)
           VALUES (?, 1, 'idle', 'ready', 'ready', 'ready')`,
        )
        .run(otherArtifactId).lastInsertRowid,
    )
    expect(() =>
      upgraded
        .prepare('UPDATE artifact SET active_generation_id = ? WHERE id = ?')
        .run(otherGenerationId, artifactId),
    ).toThrow()
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO artifact_error
            (artifact_id, generation_id, code, stage, retryable, user_message, occurred_at)
           VALUES (?, ?, 'INTERRUPTED', 'render', 1, 'Interrupted.', ?)`,
        )
        .run(artifactId, otherGenerationId, now),
    ).toThrow()
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO artifact_warning
            (artifact_id, generation_id, code, detail, occurred_at)
           VALUES (?, ?, 'PAGE_CLIPPED', 'Clipped.', ?)`,
        )
        .run(artifactId, otherGenerationId, now),
    ).toThrow()

    const otherErrorId = Number(
      upgraded
        .prepare(
          `INSERT INTO artifact_error
            (artifact_id, generation_id, code, stage, retryable, user_message, occurred_at)
           VALUES (?, ?, 'INTERRUPTED', 'render', 1, 'Interrupted.', ?)`,
        )
        .run(otherArtifactId, otherGenerationId, now).lastInsertRowid,
    )
    expect(() =>
      upgraded.prepare('UPDATE import_item SET error_id = ? WHERE id = ?').run(otherErrorId, itemId),
    ).toThrow()
    upgraded.close()
  })

  it('deletes an artifact catalog row while preserving unrelated rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-db-'))
    temporaryDirectories.push(directory)
    const database = openDatabase({ filename: join(directory, 'gallery.sqlite') })
    const now = '2026-08-31T00:00:00.000Z'
    const insertArtifact = database.prepare(
      `INSERT INTO artifact
        (source_path, format, source_status, created_at, updated_at, registered_at)
       VALUES (?, 'markdown', 'available', ?, ?, ?)`,
    )
    const deletedArtifactId = Number(
      insertArtifact.run('/canonical/delete.md', now, now, now).lastInsertRowid,
    )
    const preservedArtifactId = Number(
      insertArtifact.run('/canonical/preserve.md', now, now, now).lastInsertRowid,
    )
    const insertError = database.prepare(
      `INSERT INTO artifact_error
        (artifact_id, generation_id, code, stage, retryable, user_message, occurred_at)
       VALUES (?, NULL, 'ASSET_BLOCKED', 'render', 0, 'Asset blocked.', ?)`,
    )
    const deletedErrorId = Number(insertError.run(deletedArtifactId, now).lastInsertRowid)
    const preservedErrorId = Number(insertError.run(preservedArtifactId, now).lastInsertRowid)
    const runId = Number(
      database.prepare("INSERT INTO import_run (status) VALUES ('completed')").run().lastInsertRowid,
    )
    const insertItem = database.prepare(
      `INSERT INTO import_item
        (run_id, canonical_path, artifact_id, stage, status, error_id, completed_at)
       VALUES (?, ?, ?, 'render', 'failed', ?, ?)`,
    )
    const clearedItemId = Number(
      insertItem
        .run(runId, '/canonical/delete.md', deletedArtifactId, deletedErrorId, now)
        .lastInsertRowid,
    )
    const preservedItemId = Number(
      insertItem
        .run(runId, '/canonical/preserve.md', preservedArtifactId, preservedErrorId, now)
        .lastInsertRowid,
    )

    expect(() =>
      database.prepare('DELETE FROM artifact WHERE id = ?').run(deletedArtifactId),
    ).not.toThrow()
    expect(
      database.prepare('SELECT artifact_id, error_id FROM import_item WHERE id = ?').get(clearedItemId),
    ).toEqual({ artifact_id: null, error_id: null })
    expect(
      database.prepare('SELECT artifact_id, error_id FROM import_item WHERE id = ?').get(preservedItemId),
    ).toEqual({ artifact_id: preservedArtifactId, error_id: preservedErrorId })
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact WHERE id = ?').get(deletedArtifactId)).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_error WHERE id = ?').get(deletedErrorId)).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact WHERE id = ?').get(preservedArtifactId)).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_error WHERE id = ?').get(preservedErrorId)).toEqual({ count: 1 })

    database.close()
  })
})
