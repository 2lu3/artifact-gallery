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

export interface StartupReconciliationError {
  code: 'TEMPORARY_DERIVATIVE_UNREADABLE'
  operation: 'scan-temporary-derivatives' | 'remove-temporary-derivative'
  path: string
  detail: string | null
}

export interface StartupReconciliationReport {
  interruptedRunIds: number[]
  interruptedItemIds: number[]
  interruptedGenerationIds: number[]
  unstartedItems: UnstartedImportItem[]
  removedTemporaryFiles: string[]
  errors: StartupReconciliationError[]
}

interface ItemRow {
  id: number
  run_id: number
  canonical_path: string
  status: 'queued' | 'processing'
}

/*
 * crash/restart
 *      |
 *      +--> SQLite transaction: queued/running ----------------> interrupted
 *      |                         completed/active generation ---> preserved
 *      `--> derivative root: direct *.tmp -> remove | structured error
 *                              nested/permanent -> preserve
 *      |
 *      `--> report queued/unstarted items; never silently resume
 */
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

  const cleanup = await removeTemporaryDerivativeFiles(options.temporaryDerivativeDirectory)
  return { ...interrupted, ...cleanup }
}

function selectIds(database: Database.Database, sql: string): number[] {
  return (database.prepare(sql).all() as Array<{ id: number }>).map((row) => row.id)
}

async function removeTemporaryDerivativeFiles(
  directory: string,
): Promise<Pick<StartupReconciliationReport, 'removedTemporaryFiles' | 'errors'>> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removedTemporaryFiles: [], errors: [] }
    }
    return {
      removedTemporaryFiles: [],
      errors: [recoveryError('scan-temporary-derivatives', directory, error)],
    }
  }

  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
    .map((entry) => join(directory, entry.name))
    .sort()
  const removedTemporaryFiles: string[] = []
  const errors: StartupReconciliationError[] = []
  for (const path of paths) {
    try {
      await unlink(path)
      removedTemporaryFiles.push(path)
    } catch (error) {
      errors.push(recoveryError('remove-temporary-derivative', path, error))
    }
  }
  return { removedTemporaryFiles, errors }
}

function recoveryError(
  operation: StartupReconciliationError['operation'],
  path: string,
  error: unknown,
): StartupReconciliationError {
  return {
    code: 'TEMPORARY_DERIVATIVE_UNREADABLE',
    operation,
    path,
    detail: error instanceof Error ? error.message : typeof error === 'string' ? error : null,
  }
}
