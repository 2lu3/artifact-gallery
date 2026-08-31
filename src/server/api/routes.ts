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
  type GalleryStatusFilter,
  type PlatformActionResult,
  type RegistrationResponse,
} from '../../shared/contracts.js'
import {
  ArtifactProcessingError,
  mapProcessingError,
  toPublicProcessingError,
  type PublicProcessingError,
} from '../../shared/errors.js'
import { MAX_THUMBNAIL_BYTES } from '../processing/thumbnail-optimizer.js'
import type {
  ArtifactProcessOperation,
  ImportWorker,
  ImportWorkerCallbacks,
  ImportWorkerContext,
} from '../processing/worker.js'
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
import { GalleryRepository } from '../repositories/gallery-repository.js'
import type { PathPolicy, PathPolicyItemError } from '../security/path-policy.js'
import { normalizeSearchText } from '../search/search-query.js'
import { SearchRepository } from '../search/search-repository.js'
import { CursorCodec, StaleCursorError, type CursorContext } from './cursor.js'
import { InvalidResourceTokenError, ThumbnailResourceCodec } from './resource-token.js'

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
  readonly pathPolicy: Pick<PathPolicy, 'authorizeFile' | 'enumerateFolder'>
  readonly derivativePathPolicy: Pick<PathPolicy, 'authorizeAsset'>
  readonly importWorker: Pick<ImportWorker, 'enqueue' | 'enqueueTask' | 'close'>
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
  thumbnail_generation_id: number | null
}

export interface AbortSource {
  readonly request: IncomingMessage
  readonly response: ServerResponse
}

export function registerApiRoutes(app: FastifyInstance, dependencies: ApiRouteDependencies): void {
  const cursorCodec = new CursorCodec(dependencies.cursorSecret ?? randomBytes(32))
  const thumbnailCodec = new ThumbnailResourceCodec(randomBytes(32))
  const search = new SearchRepository(dependencies.database)
  const gallery = new GalleryRepository(dependencies.database)
  const imports = new ImportRepository(dependencies.database)
  const artifacts = new ArtifactRepository(dependencies.database)
  const now = dependencies.now ?? (() => new Date().toISOString())
  const worker = dependencies.importWorker
  app.addHook('onClose', () => worker.close())

  const enqueueItem = (
    operation: ArtifactProcessOperation,
    runId: number,
    itemId: number,
    sourcePath: string,
    onResult?: ImportWorkerCallbacks['onResult'],
  ): boolean =>
    worker.enqueue(
      operation,
      { sourcePath, runId, itemId },
      {
        onResult,
        onError: (error) => {
          persistBackgroundFailure(
            dependencies.database,
            imports,
            artifacts,
            runId,
            itemId,
            error,
            now(),
          )
        },
      },
    )

  const cancelRunOnAbort = (request: IncomingMessage, reply: FastifyReply, runId: number) => {
    const remove = observeRequestAbort(
      { request, response: reply.raw },
      () => requestCancellationIfActive(imports, dependencies.database, runId, now()),
    )
    reply.raw.once('finish', remove)
  }

  app.get('/api/gallery', async (request, reply) => {
    try {
      const query = readPageQuery(request.query, false)
      return pageResponse(
        dependencies.database,
        cursorCodec,
        thumbnailCodec,
        gallery,
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
      return pageResponse(
        dependencies.database,
        cursorCodec,
        thumbnailCodec,
        gallery,
        query,
        `search:${normalizeSearchText(query.query)}`,
        ids,
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
      return toArtifactDetail(dependencies.database, row, thumbnailCodec)
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.get('/api/thumbnails/:token', async (request, reply) => {
    try {
      const token = readObject(request.params).token
      if (typeof token !== 'string' || token.length > MAX_CURSOR_LENGTH) return sendNotFound(reply)
      const resource = thumbnailCodec.decode(token)
      const thumbnailPath = dependencies.database
        .prepare(
          `SELECT thumbnail_path
           FROM artifact_generation
           WHERE id = ? AND artifact_id = ? AND thumbnail_path IS NOT NULL`,
        )
        .pluck()
        .get(resource.generationId, resource.artifactId)
      if (typeof thumbnailPath !== 'string' || extname(thumbnailPath).toLowerCase() !== '.webp') {
        return sendNotFound(reply)
      }
      const authorized = await dependencies.derivativePathPolicy.authorizeAsset(thumbnailPath)
      if (authorized.mimeType !== 'image/webp') return sendNotFound(reply)
      const bytes = await authorized.read(MAX_THUMBNAIL_BYTES)
      return reply
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .type('image/webp')
        .send(bytes)
    } catch (error) {
      if (error instanceof InvalidResourceTokenError) return sendNotFound(reply)
      return sendNotFound(reply)
    }
  })

  app.post('/api/registrations/file', async (request, reply) => {
    try {
      const body = readObject(request.body)
      assertKeys(body, ['path'])
      const sourcePath = readPath(body.path)
      const authorized = await dependencies.pathPolicy.authorizeFile(sourcePath)
      const canonicalPath = authorized.canonicalPath
      const run = imports.createRun([canonicalPath])
      const accepted = enqueueItem('register', run.id, run.itemIds[0] as number, canonicalPath)
      if (!accepted) {
        persistBackgroundFailure(
          dependencies.database,
          imports,
          artifacts,
          run.id,
          run.itemIds[0] as number,
          new ArtifactProcessingError('DATABASE_BUSY', 'inspect'),
          now(),
        )
        return sendError(reply, 503, toPublicProcessingError(new ArtifactProcessingError('DATABASE_BUSY', 'inspect')))
      }
      cancelRunOnAbort(request.raw, reply, run.id)
      return reply.code(202).send({ runId: run.id } satisfies RegistrationResponse)
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.post('/api/registrations/folder', async (request, reply) => {
    try {
      const body = readObject(request.body)
      assertKeys(body, ['path'])
      const folderPath = readPath(body.path)
      const run = imports.createRun([])
      const accepted = worker.enqueueTask(
        async (context) => {
          await processFolderRun({
            database: dependencies.database,
            imports,
            artifacts,
            pathPolicy: dependencies.pathPolicy,
            runId: run.id,
            folderPath,
            now,
            process: context.process,
          })
        },
        (error) => {
          persistFolderBackgroundFailure(
            dependencies.database,
            imports,
            artifacts,
            run.id,
            folderPath,
            error,
            now(),
          )
        },
      )
      if (!accepted) {
        imports.requestCancellation(run.id, now())
        imports.cancelRun(run.id, now())
        return sendError(reply, 503, toPublicProcessingError(new ArtifactProcessingError('DATABASE_BUSY', 'inspect')))
      }
      cancelRunOnAbort(request.raw, reply, run.id)
      return reply.code(202).send({ runId: run.id } satisfies RegistrationResponse)
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
        const run = imports.createRun([artifact.sourcePath])
        const accepted = enqueueItem(
          operation,
          run.id,
          run.itemIds[0] as number,
          artifact.sourcePath,
          (result) => {
            const missingError = result.errors.find(({ code }) => code === 'SOURCE_MISSING')
            if (missingError) {
              dependencies.database
                .prepare("UPDATE artifact SET source_status = 'missing', updated_at = ? WHERE id = ?")
                .run(now(), artifactId)
              artifacts.recordError({
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
          },
        )
        if (!accepted) {
          persistBackgroundFailure(
            dependencies.database,
            imports,
            artifacts,
            run.id,
            run.itemIds[0] as number,
            new ArtifactProcessingError('DATABASE_BUSY', 'inspect'),
            now(),
          )
          return sendError(reply, 503, toPublicProcessingError(new ArtifactProcessingError('DATABASE_BUSY', 'inspect')))
        }
        cancelRunOnAbort(request.raw, reply, run.id)
        return reply.code(202).send({ runId: run.id } satisfies RegistrationResponse)
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
        thumbnailCodec,
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
        thumbnailCodec,
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

interface FolderRunDependencies {
  readonly database: Database.Database
  readonly imports: ImportRepository
  readonly artifacts: ArtifactRepository
  readonly pathPolicy: Pick<PathPolicy, 'enumerateFolder'>
  readonly runId: number
  readonly folderPath: string
  readonly now: () => string
  readonly process: ImportWorkerContext['process']
}

async function processFolderRun(dependencies: FolderRunDependencies): Promise<void> {
  const { database, imports, artifacts, process, runId, folderPath, now } =
    dependencies
  if (imports.getRun(runId).cancelRequestedAt !== null) {
    imports.cancelRun(runId, now())
    return
  }
  imports.startRun(runId, now())

  let enumeration: Awaited<ReturnType<FolderRunDependencies['pathPolicy']['enumerateFolder']>>
  try {
    enumeration = await dependencies.pathPolicy.enumerateFolder(folderPath)
  } catch (error) {
    if (imports.getRun(runId).cancelRequestedAt !== null) {
      cancelOutstandingRun(database, imports, runId, now())
      return
    }
    const [itemId] = imports.addItems(runId, [folderPath])
    persistItemFailure(imports, artifacts, itemId as number, error, now())
    finishImportRun(database, imports, runId, now())
    return
  }

  if (imports.getRun(runId).cancelRequestedAt !== null) {
    cancelOutstandingRun(database, imports, runId, now())
    return
  }
  const files = [
    ...new Map(enumeration.files.map((file) => [file.canonicalPath, file])).values(),
  ]
  if (files.length + enumeration.errors.length > MAX_FOLDER_FILES) {
    const [itemId] = imports.addItems(runId, [folderPath])
    persistItemFailure(
      imports,
      artifacts,
      itemId as number,
      new ArtifactProcessingError('INPUT_TOO_LARGE', 'inspect'),
      now(),
    )
    finishImportRun(database, imports, runId, now())
    return
  }

  const itemIds = imports.addItems(runId, [
    ...files.map(({ canonicalPath }) => canonicalPath),
    ...enumeration.errors.map(({ path }) => path),
  ])
  const fileItemIds = itemIds.slice(0, files.length)
  const errorItemIds = itemIds.slice(files.length)
  enumeration.errors.forEach((error, index) => {
    persistEnumerationError(imports, artifacts, errorItemIds[index] as number, error, now())
  })

  for (const [index, file] of files.entries()) {
    if (imports.getRun(runId).cancelRequestedAt !== null) {
      cancelOutstandingRun(database, imports, runId, now())
      return
    }
    await process('register', {
      sourcePath: file.canonicalPath,
      runId,
      itemId: fileItemIds[index] as number,
    })
  }
  finishImportRun(database, imports, runId, now())
}

function persistEnumerationError(
  imports: ImportRepository,
  artifacts: ArtifactRepository,
  itemId: number,
  error: PathPolicyItemError,
  occurredAt: string,
): void {
  persistItemFailure(
    imports,
    artifacts,
    itemId,
    new ArtifactProcessingError(error.code, 'inspect'),
    occurredAt,
  )
}

function persistItemFailure(
  imports: ImportRepository,
  artifacts: ArtifactRepository,
  itemId: number,
  error: unknown,
  occurredAt: string,
): void {
  const mapped = mapProcessingError(error, 'inspect')
  if (!imports.startStage(itemId, 'inspect', occurredAt)) return
  const item = imports.getItem(itemId)
  const errorId = artifacts.recordError({
    artifactId: item.artifactId,
    generationId: null,
    code: mapped.code,
    stage: mapped.stage,
    retryable: mapped.retryable,
    userMessage: mapped.userMessage,
    technicalDetail: mapped.technicalDetail,
    occurredAt,
  })
  imports.failItem(itemId, errorId, occurredAt)
}

function persistFolderBackgroundFailure(
  database: Database.Database,
  imports: ImportRepository,
  artifacts: ArtifactRepository,
  runId: number,
  folderPath: string,
  error: unknown,
  occurredAt: string,
): void {
  const run = imports.getRun(runId)
  if (run.status !== 'queued' && run.status !== 'running') return
  if (run.cancelRequestedAt !== null) {
    cancelOutstandingRun(database, imports, runId, occurredAt)
    return
  }
  if (run.status === 'queued') imports.startRun(runId, occurredAt)
  let itemIds = database
    .prepare(
      `SELECT id FROM import_item
       WHERE run_id = ? AND status IN ('queued', 'processing') ORDER BY id`,
    )
    .pluck()
    .all(runId) as number[]
  if (itemIds.length === 0) itemIds = imports.addItems(runId, [folderPath])
  itemIds.forEach((itemId) => persistItemFailure(imports, artifacts, itemId, error, occurredAt))
  finishImportRun(database, imports, runId, occurredAt)
}

function persistBackgroundFailure(
  database: Database.Database,
  imports: ImportRepository,
  artifacts: ArtifactRepository,
  runId: number,
  itemId: number,
  error: unknown,
  occurredAt: string,
): void {
  const run = imports.getRun(runId)
  if (run.status !== 'queued' && run.status !== 'running') return
  if (run.cancelRequestedAt !== null) {
    cancelOutstandingRun(database, imports, runId, occurredAt)
    return
  }
  if (run.status === 'queued') imports.startRun(runId, occurredAt)
  persistItemFailure(imports, artifacts, itemId, error, occurredAt)
  finishImportRun(database, imports, runId, occurredAt)
}

function cancelOutstandingRun(
  database: Database.Database,
  imports: ImportRepository,
  runId: number,
  completedAt: string,
): void {
  const itemIds = database
    .prepare(
      `SELECT id FROM import_item
       WHERE run_id = ? AND status IN ('queued', 'processing') ORDER BY id`,
    )
    .pluck()
    .all(runId) as number[]
  itemIds.forEach((itemId) => imports.cancelItem(itemId, completedAt))
  const run = imports.getRun(runId)
  if (run.status === 'queued' || run.status === 'running') imports.cancelRun(runId, completedAt)
}

function finishImportRun(
  database: Database.Database,
  imports: ImportRepository,
  runId: number,
  completedAt: string,
): void {
  const run = imports.getRun(runId)
  if (run.status !== 'running') return
  const statuses = database
    .prepare('SELECT status FROM import_item WHERE run_id = ?')
    .pluck()
    .all(runId) as string[]
  if (statuses.some((status) => status === 'queued' || status === 'processing')) return
  if (run.cancelRequestedAt !== null || statuses.some((status) => status === 'cancelled')) {
    imports.cancelRun(runId, completedAt)
  } else if (statuses.some((status) => status === 'failed' || status === 'interrupted')) {
    database
      .prepare("UPDATE import_run SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'running'")
      .run(completedAt, runId)
  } else {
    imports.completeRun(runId, completedAt)
  }
}

function pageResponse(
  database: Database.Database,
  codec: CursorCodec,
  thumbnailCodec: ThumbnailResourceCodec,
  gallery: GalleryRepository,
  query: PageQuery,
  queryIdentity: string,
  artifactIds?: readonly number[],
): GalleryPage {
  const context = cursorContext(database, query, queryIdentity)
  const cursor = query.cursor ? codec.decode(query.cursor, context) : null
  const rows = gallery.readPage({
    sort: query.sort,
    format: query.filter,
    status: query.status,
    cursor,
    artifactIds,
    limit: GALLERY_PAGE_SIZE + 1,
  })
  const page = rows.slice(0, GALLERY_PAGE_SIZE)
  const last = page.at(-1)
  const counts = gallery.readCounts({
    format: query.filter,
    status: query.status,
    artifactIds,
  })
  return {
    items: page.map((row) => toArtifactCard(row, thumbnailCodec)),
    nextCursor:
      rows.length > GALLERY_PAGE_SIZE && last
        ? codec.encode({
            version: 1,
            ...context,
            lastSortKey: last.sort_key,
            lastId: last.id,
          })
        : null,
    ...counts,
  }
}

interface PageQuery {
  readonly cursor: string | null
  readonly sort: GallerySortMode
  readonly filter: GalleryFilter
  readonly status: GalleryStatusFilter
  readonly query: string
}

function readPageQuery(value: unknown, requiresQuery: boolean): PageQuery {
  const query = readObject(value)
  assertKeys(
    query,
    requiresQuery
      ? ['q', 'sort', 'filter', 'status', 'cursor']
      : ['sort', 'filter', 'status', 'cursor'],
  )
  const sort = query.sort ?? 'newest'
  const filter = query.filter ?? 'all'
  const status = query.status ?? 'all'
  const searchQuery = query.q ?? ''
  const cursor = query.cursor ?? null
  if (sort !== 'newest' && sort !== 'title') throw invalidRequest()
  if (
    typeof filter !== 'string' ||
    !['all', 'html', 'markdown'].includes(filter)
  ) {
    throw invalidRequest()
  }
  if (
    typeof status !== 'string' ||
    !['all', 'missing', 'processing', 'ready', 'partial', 'failed'].includes(status)
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
    status: status as GalleryStatusFilter,
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
    status: query.status,
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

function readArtifactRows(database: Database.Database, ids: readonly number[]): ArtifactRow[] {
  if (ids.length === 0) return []
  const where = `WHERE artifact.id IN (${ids.map(() => '?').join(', ')})`
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
              active_generation.thumbnail_path,
              active_generation.id AS thumbnail_generation_id
       FROM artifact
       LEFT JOIN artifact_generation AS current_generation
         ON current_generation.artifact_id = artifact.id
        AND current_generation.generation = artifact.generation_counter
       LEFT JOIN artifact_generation AS active_generation
         ON active_generation.id = artifact.active_generation_id
        AND active_generation.artifact_id = artifact.id
       ${where}`,
    )
    .all(...ids) as ArtifactRow[]
}

function toArtifactCard(row: ArtifactRow, thumbnailCodec: ThumbnailResourceCodec): ArtifactCard {
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
    registeredAt: row.registered_at,
    status,
    thumbnailUrl:
      row.thumbnail_path && row.thumbnail_generation_id
        ? `/api/thumbnails/${thumbnailCodec.encode(row.id, row.thumbnail_generation_id)}`
        : null,
    diagram: statusDiagram(status),
  }
}

function toArtifactDetail(
  database: Database.Database,
  row: ArtifactRow,
  thumbnailCodec: ThumbnailResourceCodec,
): ArtifactDetail {
  return {
    ...toArtifactCard(row, thumbnailCodec),
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
  const rows = database
    .prepare(
      `SELECT import_item.id,
              import_item.canonical_path,
              import_item.artifact_id,
              import_item.stage,
              import_item.status,
              artifact_error.code,
              artifact_error.stage AS error_stage,
              artifact_error.retryable,
              artifact_error.user_message
       FROM import_item
       LEFT JOIN artifact_error ON artifact_error.id = import_item.error_id
       WHERE import_item.run_id = ?
       ORDER BY import_item.id`,
    )
    .all(runId) as Array<{
    id: number
    canonical_path: string
    artifact_id: number | null
    stage: string
    status: string
    code: PublicProcessingError['code'] | null
    error_stage: PublicProcessingError['stage'] | null
    retryable: number | null
    user_message: string | null
  }>
  return rows.map((row) => ({
    id: row.id,
    name: basename(row.canonical_path),
    artifactId: row.artifact_id,
    stage: row.stage,
    status: row.status,
    error:
      row.code && row.error_stage && row.retryable !== null && row.user_message
        ? {
            code: row.code,
            stage: row.error_stage,
            retryable: row.retryable === 1,
            message: row.user_message,
          }
        : null,
  }))
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
