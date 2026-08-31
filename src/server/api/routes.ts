import { createHash, randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, relative, resolve } from 'node:path'

import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  GALLERY_PAGE_SIZE,
  type ApiError,
  type ArtifactCard,
  type ArtifactDetail,
  type GalleryFilter,
  type GalleryPage,
  type GallerySortMode,
  type PlatformActionResult,
  type RegistrationResponse,
} from '../../shared/contracts.js'
import {
  ArtifactProcessingError,
  mapProcessingError,
  toPublicProcessingError,
  type PublicProcessingError,
} from '../../shared/errors.js'
import type { ArtifactProcessor, ArtifactProcessResult } from '../processing/artifact-processor.js'
import {
  ArtifactRepository,
  deriveCardPresentation,
  type ArtifactFormat,
  type CardPresentation,
  type DerivedStatus,
  type GenerationJobStatus,
  type SourceStatus,
} from '../repositories/artifact-repository.js'
import { ImportRepository, type ImportRunStatus } from '../repositories/import-repository.js'
import type { AuthorizedFile, PathPolicy } from '../security/path-policy.js'
import { normalizeSearchText } from '../search/search-query.js'
import { SearchRepository } from '../search/search-repository.js'
import { CursorCodec, StaleCursorError, type CursorContext } from './cursor.js'

const MAX_PATH_LENGTH = 4096
const MAX_QUERY_LENGTH = 512
const MAX_CURSOR_LENGTH = 4096
const MAX_TITLE_LENGTH = 256
const MAX_FOLDER_FILES = 1000
const MAX_SEARCH_RESULTS = 200

const CURSOR_STALE_ERROR: ApiError = {
  code: 'CURSOR_STALE',
  stage: 'request',
  retryable: true,
  message: 'The requested result page is out of date.',
}

export interface PlatformAdapter {
  revealSource?(sourcePath: string): Promise<PlatformActionResult>
  openSource?(sourcePath: string): Promise<PlatformActionResult>
}

export interface ApiRouteDependencies {
  readonly database: Database.Database
  readonly pathPolicy: PathPolicy
  readonly processor: ArtifactProcessor
  readonly thumbnailDirectory: string
  readonly cursorSecret?: Buffer
  readonly platformAdapter?: PlatformAdapter
  readonly now?: () => string
}

interface ArtifactRow {
  id: number
  source_path: string
  format: ArtifactFormat
  source_status: SourceStatus
  generation_counter: number
  user_title: string | null
  derived_title: string | null
  registered_at: string
  job_status: GenerationJobStatus | null
  content_status: DerivedStatus | null
  render_status: DerivedStatus | null
  index_status: DerivedStatus | null
  thumbnail_path: string | null
}

interface RegistrationEnvelope {
  readonly runId: number
  readonly result: ArtifactProcessResult
}

export interface AbortSource {
  readonly request: IncomingMessage
  readonly response: ServerResponse
}

export function registerApiRoutes(app: FastifyInstance, dependencies: ApiRouteDependencies): void {
  const cursorCodec = new CursorCodec(dependencies.cursorSecret ?? randomBytes(32))
  const search = new SearchRepository(dependencies.database)
  const imports = new ImportRepository(dependencies.database)
  const now = dependencies.now ?? (() => new Date().toISOString())
  const inflightRegistrations = new Map<string, Promise<RegistrationEnvelope>>()

  const registerAuthorized = (
    file: AuthorizedFile,
    abortSource?: AbortSource,
  ): Promise<RegistrationEnvelope> => {
    const existing = inflightRegistrations.get(file.canonicalPath)
    if (existing) return existing
    const processing = dependencies.processor.register({ sourcePath: file.canonicalPath })
    const runId = readResultRunId(dependencies.database, file.canonicalPath)
    const cancelOnAbort = () => requestCancellationIfActive(imports, dependencies.database, runId, now())
    const removeAbortListeners = abortSource
      ? observeRequestAbort(abortSource, cancelOnAbort)
      : () => undefined
    const operation = processing
      .then((result) => ({ runId, result }))
      .finally(() => {
        removeAbortListeners()
        inflightRegistrations.delete(file.canonicalPath)
      })
    inflightRegistrations.set(file.canonicalPath, operation)
    return operation
  }

  app.get('/api/gallery', async (request, reply) => {
    try {
      const query = readPageQuery(request.query, false)
      return pageResponse(
        dependencies.database,
        cursorCodec,
        readArtifactRows(dependencies.database),
        query,
        'gallery:',
      )
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.get('/api/search', async (request, reply) => {
    try {
      const query = readPageQuery(request.query, true)
      const results = search.search(query.query, { limit: MAX_SEARCH_RESULTS })
      const ids = results.map(({ artifactId }) => artifactId)
      const rows = readArtifactRows(dependencies.database, ids)
      return pageResponse(
        dependencies.database,
        cursorCodec,
        rows,
        query,
        `search:${normalizeSearchText(query.query)}`,
      )
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.get('/api/artifacts/:id', async (request, reply) => {
    try {
      const artifactId = readPositiveId(request.params)
      const row = readArtifactRows(dependencies.database, [artifactId])[0]
      if (!row) return sendNotFound(reply)
      return toArtifactDetail(dependencies.database, row)
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.post('/api/registrations/file', async (request, reply) => {
    try {
      const body = readObject(request.body)
      assertKeys(body, ['path'])
      const sourcePath = readPath(body.path)
      const file = await dependencies.pathPolicy.authorizeFile(sourcePath)
      const registration = await registerAuthorized(file, {
        request: request.raw,
        response: reply.raw,
      })
      return reply.code(202).send(toRegistrationResponse([registration]))
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.post('/api/registrations/folder', async (request, reply) => {
    try {
      const body = readObject(request.body)
      assertKeys(body, ['path'])
      const folderPath = readPath(body.path)
      const enumeration = await dependencies.pathPolicy.enumerateFolder(folderPath)
      if (enumeration.files.length > MAX_FOLDER_FILES) throw invalidRequest()
      const distinct = [...new Map(enumeration.files.map((file) => [file.canonicalPath, file])).values()]
      const cancelFolderOnAbort = () => {
        for (const file of distinct) {
          const runId = readLatestRunId(dependencies.database, file.canonicalPath)
          if (runId !== undefined) {
            requestCancellationIfActive(imports, dependencies.database, runId, now())
          }
        }
      }
      const removeAbortListeners = observeRequestAbort(
        { request: request.raw, response: reply.raw },
        cancelFolderOnAbort,
      )
      const registrations = await Promise.all(distinct.map((file) => registerAuthorized(file))).finally(
        removeAbortListeners,
      )
      return reply.code(202).send(toRegistrationResponse(registrations))
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.get('/api/imports/:id', async (request, reply) => {
    try {
      const runId = readPositiveId(request.params)
      const run = readImportRun(dependencies.database, runId)
      if (!run) return sendNotFound(reply)
      return { ...run, items: readImportItems(dependencies.database, runId) }
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.post('/api/imports/:id/cancel', async (request, reply) => {
    try {
      const runId = readPositiveId(request.params)
      const run = readImportRun(dependencies.database, runId)
      if (!run) return sendNotFound(reply)
      if (
        (run.status === 'queued' || run.status === 'running') &&
        run.cancelRequestedAt === null
      ) {
        imports.requestCancellation(runId, now())
      }
      return readImportRun(dependencies.database, runId)
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  for (const operation of ['refresh', 'retry', 'rebuild'] as const) {
    app.post(`/api/artifacts/:id/${operation}`, async (request, reply) => {
      try {
        const artifactId = readPositiveId(request.params)
        const artifact = readArtifactIdentity(dependencies.database, artifactId)
        if (!artifact) return sendNotFound(reply)
        const result = await dependencies.processor[operation]({ sourcePath: artifact.sourcePath })
        const missingError = result.errors.find(({ code }) => code === 'SOURCE_MISSING')
        if (missingError) {
          dependencies.database
            .prepare("UPDATE artifact SET source_status = 'missing', updated_at = ? WHERE id = ?")
            .run(now(), artifactId)
          new ArtifactRepository(dependencies.database).recordError({
            artifactId,
            generationId: null,
            code: missingError.code,
            stage: missingError.stage,
            retryable: missingError.retryable,
            userMessage: missingError.message,
            technicalDetail: null,
            occurredAt: now(),
          })
        }
        return result
      } catch (error) {
        return sendBoundaryError(reply, error)
      }
    })
  }

  app.post('/api/artifacts/:id/relink', async (request, reply) => {
    try {
      const artifactId = readPositiveId(request.params)
      const artifact = readArtifactIdentity(dependencies.database, artifactId)
      if (!artifact) return sendNotFound(reply)
      const body = readObject(request.body)
      assertKeys(body, ['sourcePath'])
      const authorized = await dependencies.pathPolicy.authorizeFile(readPath(body.sourcePath))
      if (formatFor(authorized.canonicalPath) !== artifact.format) {
        throw new ArtifactProcessingError('UNSUPPORTED_FORMAT', 'inspect')
      }
      try {
        dependencies.database.transaction(() => {
          dependencies.database
            .prepare(
              `UPDATE artifact
               SET source_path = ?, source_status = 'available', updated_at = ?
               WHERE id = ?`,
            )
            .run(authorized.canonicalPath, now(), artifactId)
          dependencies.database
            .prepare(
              `UPDATE artifact_search_document
               SET path_segments_normalized = search_path_segments(?)
               WHERE artifact_id = ?
                 AND generation_id = (SELECT active_generation_id FROM artifact WHERE id = ?)`,
            )
            .run(authorized.canonicalPath, artifactId, artifactId)
        })()
      } catch {
        throw invalidRequest()
      }
      return toArtifactDetail(
        dependencies.database,
        readArtifactRows(dependencies.database, [artifactId])[0] as ArtifactRow,
      )
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.patch('/api/artifacts/:id/title', async (request, reply) => {
    try {
      const artifactId = readPositiveId(request.params)
      if (!readArtifactIdentity(dependencies.database, artifactId)) return sendNotFound(reply)
      const body = readObject(request.body)
      assertKeys(body, ['title'])
      const title = readTitle(body.title)
      dependencies.database.transaction(() => {
        dependencies.database
          .prepare('UPDATE artifact SET user_title = ?, updated_at = ? WHERE id = ?')
          .run(title, now(), artifactId)
        dependencies.database
          .prepare(
            `UPDATE artifact_search_document
             SET user_title_normalized = search_normalize(?)
             WHERE artifact_id = ?
               AND generation_id = (SELECT active_generation_id FROM artifact WHERE id = ?)`,
          )
          .run(title, artifactId, artifactId)
      })()
      return toArtifactDetail(
        dependencies.database,
        readArtifactRows(dependencies.database, [artifactId])[0] as ArtifactRow,
      )
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.delete('/api/artifacts/:id', async (request, reply) => {
    try {
      const artifactId = readPositiveId(request.params)
      const thumbnailPaths = dependencies.database
        .prepare(
          'SELECT thumbnail_path FROM artifact_generation WHERE artifact_id = ? AND thumbnail_path IS NOT NULL',
        )
        .pluck()
        .all(artifactId) as string[]
      dependencies.database.prepare('DELETE FROM artifact WHERE id = ?').run(artifactId)
      await Promise.all(
        thumbnailPaths
          .filter((path) => isContained(dependencies.thumbnailDirectory, path))
          .map((path) => rm(path, { force: true })),
      )
      return reply.code(204).send()
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  for (const [route, adapterMethod] of [
    ['reveal', 'revealSource'],
    ['open-source', 'openSource'],
  ] as const) {
    app.post(`/api/artifacts/:id/${route}`, async (request, reply) => {
      try {
        const artifactId = readPositiveId(request.params)
        const artifact = readArtifactIdentity(dependencies.database, artifactId)
        if (!artifact) return sendNotFound(reply)
        const authorized = await dependencies.pathPolicy.authorizeFile(artifact.sourcePath)
        const adapter = dependencies.platformAdapter?.[adapterMethod]
        if (!adapter) {
          return sendError(reply, 501, {
            code: 'UNSUPPORTED_PLATFORM',
            stage: 'request',
            retryable: false,
            message: 'This action is not supported on the current platform.',
          })
        }
        return adapter(authorized.canonicalPath)
      } catch (error) {
        return sendBoundaryError(reply, error)
      }
    })
  }
}

function pageResponse(
  database: Database.Database,
  codec: CursorCodec,
  rows: ArtifactRow[],
  query: PageQuery,
  queryIdentity: string,
): GalleryPage {
  const context = cursorContext(database, query, queryIdentity)
  const cursor = query.cursor ? codec.decode(query.cursor, context) : null
  const filtered = rows
    .map((row) => ({ row, card: toArtifactCard(row), sortKey: sortKey(row, query.sort) }))
    .filter(({ card }) => query.filter === 'all' || card.status === query.filter)
    .toSorted((left, right) => comparePageRows(left, right, query.sort))
    .filter(({ row, sortKey: key }) => !cursor || isAfterCursor(key, row.id, cursor, query.sort))
  const page = filtered.slice(0, GALLERY_PAGE_SIZE)
  const last = page.at(-1)
  return {
    items: page.map(({ card }) => card),
    nextCursor:
      filtered.length > GALLERY_PAGE_SIZE && last
        ? codec.encode({
            version: 1,
            ...context,
            lastSortKey: last.sortKey,
            lastId: last.row.id,
          })
        : null,
  }
}

interface PageQuery {
  readonly cursor: string | null
  readonly sort: GallerySortMode
  readonly filter: GalleryFilter
  readonly query: string
}

function readPageQuery(value: unknown, requiresQuery: boolean): PageQuery {
  const query = readObject(value)
  assertKeys(query, requiresQuery ? ['q', 'sort', 'filter', 'cursor'] : ['sort', 'filter', 'cursor'])
  const sort = query.sort ?? 'newest'
  const filter = query.filter ?? 'all'
  const searchQuery = query.q ?? ''
  const cursor = query.cursor ?? null
  if (sort !== 'newest' && sort !== 'title') throw invalidRequest()
  if (
    typeof filter !== 'string' ||
    !['all', 'missing', 'processing', 'ready', 'partial', 'failed'].includes(filter)
  ) {
    throw invalidRequest()
  }
  if (typeof searchQuery !== 'string' || searchQuery.length > MAX_QUERY_LENGTH) {
    throw invalidRequest()
  }
  if (requiresQuery && normalizeSearchText(searchQuery).length === 0) throw invalidRequest()
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH)) {
    throw invalidRequest()
  }
  return {
    cursor,
    sort,
    filter: filter as GalleryFilter,
    query: searchQuery,
  }
}

function cursorContext(
  database: Database.Database,
  query: PageQuery,
  queryIdentity: string,
): CursorContext {
  const revision = databaseRevision(database)
  return {
    sort: query.sort,
    filter: query.filter,
    queryFingerprint: createHash('sha256').update(queryIdentity).digest('base64url'),
    catalogRevision: revision,
    searchRevision: revision,
  }
}

function databaseRevision(database: Database.Database): string {
  const dataVersion = database.pragma('data_version', { simple: true })
  const totalChanges = database.prepare('SELECT total_changes()').pluck().get()
  return `${String(dataVersion)}:${String(totalChanges)}`
}

function readArtifactRows(database: Database.Database, ids?: readonly number[]): ArtifactRow[] {
  if (ids && ids.length === 0) return []
  const where = ids ? `WHERE artifact.id IN (${ids.map(() => '?').join(', ')})` : ''
  return database
    .prepare(
      `SELECT artifact.id,
              artifact.source_path,
              artifact.format,
              artifact.source_status,
              artifact.generation_counter,
              artifact.user_title,
              artifact.derived_title,
              artifact.registered_at,
              current_generation.job_status,
              current_generation.content_status,
              current_generation.render_status,
              current_generation.index_status,
              active_generation.thumbnail_path
       FROM artifact
       LEFT JOIN artifact_generation AS current_generation
         ON current_generation.artifact_id = artifact.id
        AND current_generation.generation = artifact.generation_counter
       LEFT JOIN artifact_generation AS active_generation
         ON active_generation.id = artifact.active_generation_id
        AND active_generation.artifact_id = artifact.id
       ${where}`,
    )
    .all(...(ids ?? [])) as ArtifactRow[]
}

function toArtifactCard(row: ArtifactRow): ArtifactCard {
  const status = deriveCardPresentation({
    source_status: row.source_status,
    job_status: row.job_status,
    content_status: row.content_status,
    render_status: row.render_status,
    index_status: row.index_status,
  })
  return {
    id: row.id,
    title: row.user_title ?? row.derived_title ?? basename(row.source_path),
    sourcePath: row.source_path,
    format: row.format,
    status,
    thumbnailPath: row.thumbnail_path,
    diagram: statusDiagram(status),
  }
}

function toArtifactDetail(database: Database.Database, row: ArtifactRow): ArtifactDetail {
  return {
    ...toArtifactCard(row),
    generation: row.generation_counter,
    errors: readPublicErrors(database, row.id),
  }
}

function statusDiagram(status: CardPresentation): string {
  switch (status) {
    case 'missing':
      return '[source ?] -> [last preview]'
    case 'processing':
      return '[source] -> [processing ...]'
    case 'ready':
      return '[source] -> [content] -> [preview] -> [search]'
    case 'partial':
      return '[source] -> [content/preview/search ~]'
    case 'failed':
      return '[source] -x [processing]'
  }
}

function sortKey(row: ArtifactRow, sort: GallerySortMode): string {
  return sort === 'newest'
    ? row.registered_at
    : normalizeSearchText(row.user_title ?? row.derived_title ?? basename(row.source_path))
}

function comparePageRows(
  left: { row: ArtifactRow; sortKey: string },
  right: { row: ArtifactRow; sortKey: string },
  sort: GallerySortMode,
): number {
  if (left.sortKey !== right.sortKey) {
    const comparison = left.sortKey < right.sortKey ? -1 : 1
    return sort === 'newest' ? -comparison : comparison
  }
  return sort === 'newest' ? right.row.id - left.row.id : left.row.id - right.row.id
}

function isAfterCursor(
  key: string,
  id: number,
  cursor: { lastSortKey: string; lastId: number },
  sort: GallerySortMode,
): boolean {
  if (key === cursor.lastSortKey) {
    return sort === 'newest' ? id < cursor.lastId : id > cursor.lastId
  }
  return sort === 'newest' ? key < cursor.lastSortKey : key > cursor.lastSortKey
}

function readPublicErrors(database: Database.Database, artifactId: number): PublicProcessingError[] {
  const rows = database
    .prepare(
      `SELECT code, stage, retryable, user_message
       FROM artifact_error WHERE artifact_id = ? ORDER BY id`,
    )
    .all(artifactId) as Array<{
    code: PublicProcessingError['code']
    stage: PublicProcessingError['stage']
    retryable: number
    user_message: string
  }>
  return rows.map((row) => ({
    code: row.code,
    stage: row.stage,
    retryable: row.retryable === 1,
    message: row.user_message,
  }))
}

function toRegistrationResponse(registrations: readonly RegistrationEnvelope[]): RegistrationResponse {
  return {
    runIds: registrations.map(({ runId }) => runId),
    results: registrations.map(({ runId, result }) => ({
      runId,
      artifactId: result.artifactId,
      outcome: result.outcome,
      errors: result.errors,
    })),
  }
}

function readResultRunId(database: Database.Database, canonicalPath: string): number {
  const runId = readLatestRunId(database, canonicalPath)
  if (runId === undefined) throw new Error('The processor did not create an import run.')
  return runId
}

function readLatestRunId(database: Database.Database, canonicalPath: string): number | undefined {
  const runId = database
    .prepare('SELECT run_id FROM import_item WHERE canonical_path = ? ORDER BY id DESC LIMIT 1')
    .pluck()
    .get(canonicalPath)
  return typeof runId === 'number' ? runId : undefined
}

function readImportRun(database: Database.Database, runId: number) {
  const row = database
    .prepare(
      `SELECT id, status, cancel_requested_at, started_at, completed_at
       FROM import_run WHERE id = ?`,
    )
    .get(runId) as
    | {
        id: number
        status: ImportRunStatus
        cancel_requested_at: string | null
        started_at: string | null
        completed_at: string | null
      }
    | undefined
  return row
    ? {
        id: row.id,
        status: row.status,
        cancelRequestedAt: row.cancel_requested_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      }
    : undefined
}

function requestCancellationIfActive(
  imports: ImportRepository,
  database: Database.Database,
  runId: number,
  requestedAt: string,
): void {
  const run = readImportRun(database, runId)
  if (
    run &&
    (run.status === 'queued' || run.status === 'running') &&
    run.cancelRequestedAt === null
  ) {
    imports.requestCancellation(runId, requestedAt)
  }
}

export function observeRequestAbort(source: AbortSource, cancel: () => void): () => void {
  const onRequestClose = () => {
    if (source.request.aborted || source.request.complete !== true) cancel()
  }
  const onResponseClose = () => {
    if (!source.response.writableEnded) cancel()
  }
  if (source.request.aborted || source.response.destroyed) cancel()
  source.request.once('aborted', cancel)
  source.request.once('close', onRequestClose)
  source.response.once('close', onResponseClose)
  return () => {
    source.request.off('aborted', cancel)
    source.request.off('close', onRequestClose)
    source.response.off('close', onResponseClose)
  }
}

function readImportItems(database: Database.Database, runId: number) {
  return database
    .prepare(
      `SELECT id, artifact_id AS artifactId, stage, status
       FROM import_item WHERE run_id = ? ORDER BY id`,
    )
    .all(runId)
}

function readArtifactIdentity(database: Database.Database, artifactId: number) {
  return database
    .prepare('SELECT source_path AS sourcePath, format FROM artifact WHERE id = ?')
    .get(artifactId) as { sourcePath: string; format: ArtifactFormat } | undefined
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidRequest()
  return value as Record<string, unknown>
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalidRequest()
}

function readPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    throw invalidRequest()
  }
  return value
}

function readPositiveId(params: unknown): number {
  const id = readObject(params).id
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) throw invalidRequest()
  const parsed = Number(id)
  if (!Number.isSafeInteger(parsed)) throw invalidRequest()
  return parsed
}

function readTitle(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > MAX_TITLE_LENGTH) throw invalidRequest()
  const normalized = value.trim()
  return normalized.length === 0 ? null : normalized
}

function formatFor(sourcePath: string): ArtifactFormat {
  return extname(sourcePath).toLowerCase() === '.md' ? 'markdown' : 'html'
}

function invalidRequest(): ArtifactProcessingError {
  return Object.assign(new ArtifactProcessingError('UNKNOWN', 'inspect'), {
    apiCode: 'INVALID_REQUEST' as const,
  })
}

function sendBoundaryError(reply: FastifyReply, error: unknown) {
  if (error instanceof StaleCursorError) return sendError(reply, 409, CURSOR_STALE_ERROR)
  if (isInvalidRequest(error)) {
    return sendError(reply, 400, {
      code: 'INVALID_REQUEST',
      stage: 'request',
      retryable: false,
      message: 'The request is invalid.',
    })
  }
  const mapped = mapProcessingError(error, 'inspect')
  const publicError = toPublicProcessingError(mapped)
  const status =
    mapped.code === 'OUTSIDE_ALLOWED_ROOT' || mapped.code === 'SYMLINK_REJECTED'
      ? 403
      : mapped.code === 'SOURCE_MISSING'
        ? 404
        : 400
  return sendError(reply, status, publicError)
}

function isInvalidRequest(error: unknown): error is ArtifactProcessingError & { apiCode: string } {
  return (
    error instanceof ArtifactProcessingError &&
    'apiCode' in error &&
    error.apiCode === 'INVALID_REQUEST'
  )
}

function sendNotFound(reply: FastifyReply) {
  return sendError(reply, 404, {
    code: 'NOT_FOUND',
    stage: 'catalog',
    retryable: false,
    message: 'The requested catalog item was not found.',
  })
}

function sendError(reply: FastifyReply, status: number, error: ApiError) {
  return reply.code(status).send({ error })
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'))
}
