import type Database from 'better-sqlite3'

import { ArtifactProcessingError, mapProcessingError } from '../../shared/errors.js'
import { ArtifactRepository } from '../repositories/artifact-repository.js'

const DEFAULT_STARTUP_LIMIT = 256
const CHECK_CONCURRENCY = 8
const SOURCE_CHECK_ERROR_CODES = [
  'SOURCE_MISSING',
  'OUTSIDE_ALLOWED_ROOT',
  'SYMLINK_REJECTED',
  'UNREADABLE_SOURCE',
  'UNSUPPORTED_FORMAT',
  'TIMEOUT',
] as const

interface SourceRow {
  id: number
  source_path: string
}

export interface SourceStatusReconciliationOptions {
  readonly database: Database.Database
  readonly authorizeFile: (sourcePath: string) => Promise<unknown>
  readonly artifactIds?: readonly number[]
  readonly limit?: number
  readonly timeoutMs: number
  readonly now?: () => string
}

export async function reconcileSourceStatuses(
  options: SourceStatusReconciliationOptions,
): Promise<void> {
  const rows = readSourceRows(options)
  const artifacts = new ArtifactRepository(options.database)
  const now = options.now ?? (() => new Date().toISOString())
  for (let offset = 0; offset < rows.length; offset += CHECK_CONCURRENCY) {
    await Promise.all(
      rows.slice(offset, offset + CHECK_CONCURRENCY).map(async (row) => {
        try {
          await boundedAuthorization(options.authorizeFile(row.source_path), options.timeoutMs)
          options.database.transaction(() => {
            artifacts.setSourceStatus(row.id, 'available', now())
            clearSourceCheckErrors(options.database, row.id)
          })()
        } catch (error) {
          const mapped = mapProcessingError(error, 'inspect', 'UNREADABLE_SOURCE')
          options.database.transaction(() => {
            if (mapped.code === 'SOURCE_MISSING') {
              artifacts.setSourceStatus(row.id, 'missing', now())
            }
            clearSourceCheckErrors(options.database, row.id)
            artifacts.recordError({
              artifactId: row.id,
              generationId: null,
              code: mapped.code,
              stage: mapped.stage,
              retryable: mapped.retryable,
              userMessage: mapped.userMessage,
              technicalDetail: null,
              occurredAt: now(),
            })
          })()
        }
      }),
    )
  }
}

function readSourceRows(options: SourceStatusReconciliationOptions): SourceRow[] {
  if (options.artifactIds) {
    if (options.artifactIds.length === 0) return []
    return options.database
      .prepare(
        `SELECT id, source_path FROM artifact
         WHERE id IN (${options.artifactIds.map(() => '?').join(', ')})
         ORDER BY id`,
      )
      .all(...options.artifactIds) as SourceRow[]
  }
  const limit = Math.max(1, Math.min(DEFAULT_STARTUP_LIMIT, options.limit ?? DEFAULT_STARTUP_LIMIT))
  return options.database
    .prepare('SELECT id, source_path FROM artifact ORDER BY id LIMIT ?')
    .all(limit) as SourceRow[]
}

async function boundedAuthorization(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ArtifactProcessingError('TIMEOUT', 'inspect')),
          Math.max(1, timeoutMs),
        )
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function clearSourceCheckErrors(database: Database.Database, artifactId: number): void {
  database
    .prepare(
      `DELETE FROM artifact_error
       WHERE artifact_id = ?
         AND generation_id IS NULL
         AND stage = 'inspect'
         AND code IN (${SOURCE_CHECK_ERROR_CODES.map(() => '?').join(', ')})`,
    )
    .run(artifactId, ...SOURCE_CHECK_ERROR_CODES)
}
