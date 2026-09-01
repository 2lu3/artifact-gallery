import { readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import Database from 'better-sqlite3'

import { normalizeArtifactTitle } from '../../shared/artifact-title.js'
import { normalizePathSegments, normalizeSearchText } from '../search/search-query.js'

export interface OpenDatabaseOptions {
  filename: string
  migrationsDirectory?: string
}

export function openDatabase({
  filename,
  migrationsDirectory = resolve(process.cwd(), 'migrations'),
}: OpenDatabaseOptions): Database.Database {
  const database = new Database(filename)

  try {
    database.function('search_normalize', { deterministic: true }, (value: string | null) =>
      normalizeSearchText(value ?? ''),
    )
    database.function('search_path_segments', { deterministic: true }, (value: string) =>
      normalizePathSegments(value),
    )
    database.function('path_basename', { deterministic: true }, (value: string) => basename(value))
    database.function('artifact_title_clamp', { deterministic: true }, (value: string | null) =>
      normalizeArtifactTitle(value),
    )
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    database.pragma('busy_timeout = 5000')
    applyMigrations(database, migrationsDirectory)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function applyMigrations(database: Database.Database, migrationsDirectory: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT
  `)

  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = ?')
  const record = database.prepare(
    'INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)',
  )

  for (const version of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    if (applied.get(version)) {
      continue
    }

    const sql = readFileSync(resolve(migrationsDirectory, version), 'utf8')
    database.transaction(() => {
      database.exec(sql)
      record.run(version, new Date().toISOString())
    })()
  }
}
