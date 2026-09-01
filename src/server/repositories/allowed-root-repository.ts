import type Database from 'better-sqlite3'

export interface AllowedRootRecord {
  id: number
  canonicalPath: string
  kind: AllowedRootKind
  createdAt: string
}

export type AllowedRootKind = 'file' | 'folder'

interface AllowedRootRow {
  id: number
  canonical_path: string
  kind: AllowedRootKind
  created_at: string
}

export class AllowedRootRepository {
  constructor(private readonly database: Database.Database) {}

  add(canonicalPath: string, kind: AllowedRootKind, createdAt: string): AllowedRootRecord {
    const row = this.database
      .prepare(
        `INSERT INTO allowed_root (canonical_path, kind, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(canonical_path) DO UPDATE SET kind = excluded.kind
         RETURNING id, canonical_path, kind, created_at`,
      )
      .get(canonicalPath, kind, createdAt) as AllowedRootRow
    return mapAllowedRoot(row)
  }

  list(): AllowedRootRecord[] {
    const rows = this.database
      .prepare(
        'SELECT id, canonical_path, kind, created_at FROM allowed_root ORDER BY canonical_path',
      )
      .all() as AllowedRootRow[]
    return rows.map(mapAllowedRoot)
  }

  linkArtifact(artifactId: number, allowedRootId: number): void {
    this.database
      .prepare(
        `INSERT INTO artifact_allowed_root (artifact_id, allowed_root_id)
         VALUES (?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET allowed_root_id = excluded.allowed_root_id`,
      )
      .run(artifactId, allowedRootId)
  }

  findForArtifact(artifactId: number): AllowedRootRecord | null {
    const row = this.database
      .prepare(
        `SELECT allowed_root.id, allowed_root.canonical_path, allowed_root.kind,
                allowed_root.created_at
         FROM artifact_allowed_root
         JOIN allowed_root ON allowed_root.id = artifact_allowed_root.allowed_root_id
         WHERE artifact_allowed_root.artifact_id = ?`,
      )
      .get(artifactId) as AllowedRootRow | undefined
    return row ? mapAllowedRoot(row) : null
  }
}

function mapAllowedRoot(row: AllowedRootRow): AllowedRootRecord {
  return {
    id: row.id,
    canonicalPath: row.canonical_path,
    kind: row.kind,
    createdAt: row.created_at,
  }
}
