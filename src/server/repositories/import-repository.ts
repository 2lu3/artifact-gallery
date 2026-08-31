import type Database from 'better-sqlite3'

export type ImportRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export type ImportItemStage = 'queued' | 'inspect' | 'extract' | 'render' | 'index' | 'commit'
export type ImportItemStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ImportRunRecord {
  id: number
  status: ImportRunStatus
  cancelRequestedAt: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface ImportItemRecord {
  id: number
  runId: number
  canonicalPath: string
  artifactId: number | null
  stage: ImportItemStage
  status: ImportItemStatus
  errorId: number | null
  startedAt: string | null
  completedAt: string | null
}

interface ImportRunRow {
  id: number
  status: ImportRunStatus
  cancel_requested_at: string | null
  started_at: string | null
  completed_at: string | null
}

interface ImportItemRow {
  id: number
  run_id: number
  canonical_path: string
  artifact_id: number | null
  stage: ImportItemStage
  status: ImportItemStatus
  error_id: number | null
  started_at: string | null
  completed_at: string | null
}

export class InvalidImportTransitionError extends Error {
  constructor(entity: 'run' | 'item', id: number, action: string) {
    super(`Invalid import ${entity} transition '${action}' for id ${id}.`)
    this.name = 'InvalidImportTransitionError'
  }
}

export class ImportRepository {
  constructor(private readonly database: Database.Database) {}

  createRun(canonicalPaths: readonly string[]): { id: number; itemIds: number[] } {
    return this.database.transaction(() => {
      const run = this.database.prepare("INSERT INTO import_run (status) VALUES ('queued')").run()
      const runId = Number(run.lastInsertRowid)
      const insertItem = this.database.prepare(
        `INSERT INTO import_item (run_id, canonical_path, stage, status)
         VALUES (?, ?, 'queued', 'queued')`,
      )
      const itemIds = canonicalPaths.map((canonicalPath) =>
        Number(insertItem.run(runId, canonicalPath).lastInsertRowid),
      )

      return { id: runId, itemIds }
    })()
  }

  startRun(runId: number, startedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE import_run
         SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'queued' AND cancel_requested_at IS NULL`,
      )
      .run(startedAt, runId)
    requireTransition(result.changes, 'run', runId, 'start')
  }

  startStage(
    itemId: number,
    stage: Exclude<ImportItemStage, 'queued'>,
    startedAt: string,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE import_item
         SET stage = ?, status = 'processing', started_at = COALESCE(started_at, ?)
         WHERE id = ?
           AND status IN ('queued', 'processing')
           AND EXISTS (
             SELECT 1 FROM import_run
             WHERE import_run.id = import_item.run_id
               AND import_run.status = 'running'
               AND import_run.cancel_requested_at IS NULL
           )`,
      )
      .run(stage, startedAt, itemId)
    return result.changes === 1
  }

  attachArtifact(itemId: number, artifactId: number): void {
    const result = this.database
      .prepare(
        `UPDATE import_item SET artifact_id = ?
         WHERE id = ? AND status IN ('queued', 'processing')`,
      )
      .run(artifactId, itemId)
    requireTransition(result.changes, 'item', itemId, 'attach artifact')
  }

  failItem(itemId: number, errorId: number, completedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE import_item
         SET status = 'failed', error_id = ?, completed_at = ?
         WHERE id = ?
           AND status = 'processing'
           AND EXISTS (
             SELECT 1 FROM artifact_error
             WHERE artifact_error.id = ?
               AND artifact_error.artifact_id IS import_item.artifact_id
           )`,
      )
      .run(errorId, completedAt, itemId, errorId)
    requireTransition(result.changes, 'item', itemId, 'fail')
  }

  requestCancellation(runId: number, requestedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE import_run SET cancel_requested_at = ?
         WHERE id = ?
           AND status IN ('queued', 'running')
           AND cancel_requested_at IS NULL`,
      )
      .run(requestedAt, runId)
    requireTransition(result.changes, 'run', runId, 'request cancellation')
  }

  cancelItem(itemId: number, completedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE import_item SET status = 'cancelled', completed_at = ?
         WHERE id = ? AND status IN ('queued', 'processing')`,
      )
      .run(completedAt, itemId)
    requireTransition(result.changes, 'item', itemId, 'cancel')
  }

  cancelRun(runId: number, completedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE import_run SET status = 'cancelled', completed_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(completedAt, runId)
    requireTransition(result.changes, 'run', runId, 'cancel')
  }

  completeItem(itemId: number, completedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE import_item SET status = 'completed', completed_at = ?
         WHERE id = ? AND status = 'processing'`,
      )
      .run(completedAt, itemId)
    requireTransition(result.changes, 'item', itemId, 'complete')
  }

  completeRun(runId: number, completedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE import_run SET status = 'completed', completed_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(completedAt, runId)
    requireTransition(result.changes, 'run', runId, 'complete')
  }

  getRun(runId: number): ImportRunRecord {
    const row = this.database.prepare('SELECT * FROM import_run WHERE id = ?').get(runId) as ImportRunRow
    return {
      id: row.id,
      status: row.status,
      cancelRequestedAt: row.cancel_requested_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }
  }

  getItem(itemId: number): ImportItemRecord {
    const row = this.database.prepare('SELECT * FROM import_item WHERE id = ?').get(itemId) as ImportItemRow
    return {
      id: row.id,
      runId: row.run_id,
      canonicalPath: row.canonical_path,
      artifactId: row.artifact_id,
      stage: row.stage,
      status: row.status,
      errorId: row.error_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }
  }
}

function requireTransition(
  changes: number,
  entity: 'run' | 'item',
  id: number,
  action: string,
): void {
  if (changes !== 1) {
    throw new InvalidImportTransitionError(entity, id, action)
  }
}
