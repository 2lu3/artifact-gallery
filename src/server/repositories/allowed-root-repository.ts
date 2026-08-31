import type Database from 'better-sqlite3'

export interface AllowedRootRecord {
  id: number
  canonicalPath: string
  createdAt: string
}

interface AllowedRootRow {
  id: number
  canonical_path: string
  created_at: string
}

export class AllowedRootRepository {
  constructor(private readonly database: Database.Database) {}

  add(canonicalPath: string, createdAt: string): AllowedRootRecord {
    const row = this.database
      .prepare(
        `INSERT INTO allowed_root (canonical_path, created_at)
         VALUES (?, ?)
         ON CONFLICT(canonical_path) DO UPDATE SET canonical_path = excluded.canonical_path
         RETURNING id, canonical_path, created_at`,
      )
      .get(canonicalPath, createdAt) as AllowedRootRow
    return mapAllowedRoot(row)
  }

  list(): AllowedRootRecord[] {
    const rows = this.database
      .prepare('SELECT id, canonical_path, created_at FROM allowed_root ORDER BY canonical_path')
      .all() as AllowedRootRow[]
    return rows.map(mapAllowedRoot)
  }
}

function mapAllowedRoot(row: AllowedRootRow): AllowedRootRecord {
  return { id: row.id, canonicalPath: row.canonical_path, createdAt: row.created_at }
}
