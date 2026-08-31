import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

export interface StartupReconciliationOptions {
  temporaryDerivativeDirectory: string
  interruptedAt: string
}

export interface UnstartedImportItem {
  id: number
  runId: number
  canonicalPath: string
}

export interface StartupReconciliationReport {
  interruptedRunIds: number[]
  interruptedItemIds: number[]
  interruptedGenerationIds: number[]
  unstartedItems: UnstartedImportItem[]
  removedTemporaryFiles: string[]
}

interface ItemRow {
  id: number
  run_id: number
  canonical_path: string
  status: 'queued' | 'processing'
}

export async function reconcileStartup(
  database: Database.Database,
  options: StartupReconciliationOptions,
): Promise<StartupReconciliationReport> {
  const interrupted = database.transaction(() => {
    const interruptedRunIds = selectIds(
      database,
      "SELECT id FROM import_run WHERE status IN ('queued', 'running') ORDER BY id",
    )
    const itemRows = database
      .prepare(
        `SELECT id, run_id, canonical_path, status
         FROM import_item WHERE status IN ('queued', 'processing') ORDER BY id`,
      )
      .all() as ItemRow[]
    const unstartedItems = itemRows
      .filter((row) => row.status === 'queued')
      .map((row) => ({ id: row.id, runId: row.run_id, canonicalPath: row.canonical_path }))
    const interruptedGenerationIds = selectIds(
      database,
      `SELECT id FROM artifact_generation
       WHERE job_status IN ('queued', 'processing') ORDER BY id`,
    )

    database
      .prepare(
        `UPDATE import_run
         SET status = 'interrupted', completed_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(options.interruptedAt)
    database
      .prepare(
        `UPDATE import_item
         SET status = 'interrupted', completed_at = ?
         WHERE status IN ('queued', 'processing')`,
      )
      .run(options.interruptedAt)
    database
      .prepare(
        `UPDATE artifact_generation
         SET job_status = 'interrupted', completed_at = ?
         WHERE job_status IN ('queued', 'processing')`,
      )
      .run(options.interruptedAt)

    return {
      interruptedRunIds,
      interruptedItemIds: itemRows.map((row) => row.id),
      interruptedGenerationIds,
      unstartedItems,
    }
  })()

  const removedTemporaryFiles = await removeTemporaryDerivativeFiles(
    options.temporaryDerivativeDirectory,
  )

  return { ...interrupted, removedTemporaryFiles }
}

function selectIds(database: Database.Database, sql: string): number[] {
  return (database.prepare(sql).all() as Array<{ id: number }>).map((row) => row.id)
}

async function removeTemporaryDerivativeFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }

  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
    .map((entry) => join(directory, entry.name))
    .sort()
  await Promise.all(paths.map((path) => unlink(path)))
  return paths
}
