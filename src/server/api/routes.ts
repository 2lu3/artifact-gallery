import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname } from 'node:path'

import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyReply } from 'fastify'

import { normalizeArtifactTitle } from '../../shared/artifact-title.js'
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
import { reconcileSourceStatuses } from '../processing/source-status-reconciler.js'
import { PlatformActionError } from '../platform/platform-adapter.js'
import type {
  ArtifactProcessOperation,
  ImportWorker,
  ImportWorkerCallbacks,
  ImportWorkerContext,
} from '../processing/worker.js'
import { MAX_PROCESSING_ATTEMPT_MS } from '../processing/worker.js'
import {
  ArtifactRepository,
  deriveCardPresentation,
  type ArtifactFormat,
  type CardPresentation,
  type DerivedStatus,
  type GenerationJobStatus,
  type SourceStatus,
} from '../repositories/artifact-repository.js'
import { AllowedRootRepository } from '../repositories/allowed-root-repository.js'
import { ImportRepository, type ImportRunStatus } from '../repositories/import-repository.js'
import { GalleryRepository } from '../repositories/gallery-repository.js'
import type { DerivativePathPolicy } from '../security/derivative-path-policy.js'
import {
  FolderEnumerationCancelledError,
  FolderEnumerationDeadlineError,
  FolderEnumerationLimitError,
  type CanonicalPathCapability,
  PathPolicy,
  type PathPolicyItemError,
} from '../security/path-policy.js'
import { normalizeSearchText } from '../search/search-query.js'
import { SearchRepository, type SearchResult } from '../search/search-repository.js'
import { CursorCodec, StaleCursorError, type CursorContext } from './cursor.js'
import { InvalidResourceTokenError, ThumbnailResourceCodec } from './resource-token.js'

const MAX_PATH_LENGTH = 4096
const MAX_QUERY_LENGTH = 512
const MAX_CURSOR_LENGTH = 4096
const MAX_FOLDER_FILES = 1000

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
  readonly pathPolicy: Pick<
    PathPolicy,
    'addSelectedCapability' | 'authorizeFile' | 'enumerateFolder'
  >
  readonly derivativePathPolicy: Pick<PathPolicy, 'authorizeAsset'>
  readonly derivativeMutationPolicy: Pick<DerivativePathPolicy, 'remove'>
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
  const allowedRoots = new AllowedRootRepository(dependencies.database)
  const now = dependencies.now ?? (() => new Date().toISOString())
  const worker = dependencies.importWorker
  app.addHook('onClose', () => worker.close())

  const enqueueItem = (
    operation: ArtifactProcessOperation,
    runId: number,
    itemId: number,
    sourcePath: string,
    capability?: { readonly recordId: number; readonly value: CanonicalPathCapability },
    onResult?: ImportWorkerCallbacks['onResult'],
  ): boolean =>
    worker.enqueue(
      operation,
      {
        sourcePath,
        runId,
        itemId,
        capability: capability?.value,
        capabilityId: capability?.recordId,
      },
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
    const remove = observeRequestAbort({ request, response: reply.raw }, () =>
      requestCancellationIfActive(imports, dependencies.database, runId, now()),
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
      return searchPageResponse(dependencies.database, cursorCodec, thumbnailCodec, search, query)
    } catch (error) {
      return sendBoundaryError(reply, error)
    }
  })

  app.get('/api/artifacts/:id', async (request, reply) => {
    try {
      const artifactId = readPositiveId(request.params)
      let row = readArtifactRows(dependencies.database, [artifactId])[0]
      if (!row) return sendNotFound(reply)
      const sourcePolicy = artifactPathPolicy(allowedRoots, artifactId, dependencies.pathPolicy)
      await reconcileSourceStatuses({
        database: dependencies.database,
        artifactIds: [artifactId],
        authorizeFile: sourcePolicy.authorizeFile.bind(sourcePolicy),
        timeoutMs: 250,
        now,
      })
      row = readArtifactRows(dependencies.database, [artifactId])[0]
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
      const granted = await dependencies.pathPolicy.addSelectedCapability(sourcePath, 'file')
      const persisted = allowedRoots.add(granted.canonicalPath, granted.kind, now())
      const canonicalPath = granted.canonicalPath
      const run = imports.createRun([canonicalPath])
      const accepted = enqueueItem('register', run.id, run.itemIds[0] as number, canonicalPath, {
        recordId: persisted.id,
        value: granted,
      })
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
        return sendError(
          reply,
          503,
          toPublicProcessingError(new ArtifactProcessingError('DATABASE_BUSY', 'inspect')),
        )
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
      const granted = await dependencies.pathPolicy.addSelectedCapability(folderPath, 'folder')
      const persisted = allowedRoots.add(granted.canonicalPath, granted.kind, now())
      const run = imports.createRun([])
      const accepted = worker.enqueueTask(
        async (context) => {
          await processFolderRun({
            database: dependencies.database,
            imports,
            artifacts,
            pathPolicy: dependencies.pathPolicy,
            runId: run.id,
            folderPath: granted.canonicalPath,
            capability: { recordId: persisted.id, value: granted },
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
            granted.canonicalPath,
            error,
            now(),
          )
        },
      )
      if (!accepted) {
        imports.requestCancellation(run.id, now())
        imports.cancelRun(run.id, now())
        return sendError(
          reply,
          503,
          toPublicProcessingError(new ArtifactProcessingError('DATABASE_BUSY', 'inspect')),
        )
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
      if ((run.status === 'queued' || run.status === 'running') && run.cancelRequestedAt === null) {
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
        const persistedCapability = allowedRoots.findForArtifact(artifactId)
        const run = imports.createRun([artifact.sourcePath])
        const accepted = enqueueItem(
          operation,
          run.id,
          run.itemIds[0] as number,
          artifact.sourcePath,
          persistedCapability
            ? {
                recordId: persistedCapability.id,
                value: {
                  canonicalPath: persistedCapability.canonicalPath,
                  kind: persistedCapability.kind,
                },
              }
            : undefined,
          (result) => {
            persistExistingArtifactInspectErrors(
              dependencies.database,
              artifacts,
              artifactId,
              result.errors,
              now(),
            )
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
          return sendError(
            reply,
            503,
            toPublicProcessingError(new ArtifactProcessingError('DATABASE_BUSY', 'inspect')),
          )
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
      const granted = await dependencies.pathPolicy.addSelectedCapability(
        readPath(body.sourcePath),
        'file',
      )
      if (formatFor(granted.canonicalPath) !== artifact.format) {
        throw new ArtifactProcessingError('UNSUPPORTED_FORMAT', 'inspect')
      }
      const persisted = allowedRoots.add(granted.canonicalPath, granted.kind, now())
      try {
        dependencies.database.transaction(() => {
          dependencies.database
            .prepare(
              `UPDATE artifact
               SET source_path = ?, source_status = 'available', updated_at = ?
               WHERE id = ?`,
            )
            .run(granted.canonicalPath, now(), artifactId)
          allowedRoots.linkArtifact(artifactId, persisted.id)
          dependencies.database
            .prepare(
              `UPDATE artifact_search_document
               SET path_segments_normalized = search_path_segments(?)
               WHERE artifact_id = ?
                 AND generation_id = (SELECT active_generation_id FROM artifact WHERE id = ?)`,
            )
            .run(granted.canonicalPath, artifactId, artifactId)
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
        thumbnailPaths.map((path) =>
          dependencies.derivativeMutationPolicy.remove(path).catch(() => undefined),
        ),
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
        const sourcePolicy = artifactPathPolicy(allowedRoots, artifactId, dependencies.pathPolicy)
        const authorized = await sourcePolicy.authorizeFile(artifact.sourcePath)
        const adapter = dependencies.platformAdapter?.[adapterMethod]
        if (!adapter) {
          return sendError(reply, 501, {
            code: 'UNSUPPORTED_PLATFORM',
            stage: 'request',
            retryable: false,
            message: 'This action is not supported on the current platform.',
          })
        }
        return await adapter(authorized.canonicalPath)
      } catch (error) {
        if (error instanceof PlatformActionError) {
          return sendError(reply, 502, {
            code: 'PLATFORM_ACTION_FAILED',
            stage: 'request',
            retryable: true,
            message: error.message,
          })
        }
        return sendBoundaryError(reply, error)
      }
    })
  }
}

function artifactPathPolicy(
  allowedRoots: AllowedRootRepository,
  artifactId: number,
  fallback: Pick<PathPolicy, 'authorizeFile'>,
): Pick<PathPolicy, 'authorizeFile'> {
  const capability = allowedRoots.findForArtifact(artifactId)
  return capability
    ? PathPolicy.restoreCapabilities([
        { canonicalPath: capability.canonicalPath, kind: capability.kind },
      ])
    : fallback
}

interface FolderRunDependencies {
  readonly database: Database.Database
  readonly imports: ImportRepository
  readonly artifacts: ArtifactRepository
  readonly pathPolicy: Pick<PathPolicy, 'enumerateFolder'>
  readonly runId: number
  readonly folderPath: string
  readonly capability: { readonly recordId: number; readonly value: CanonicalPathCapability }
  readonly now: () => string
  readonly process: ImportWorkerContext['process']
}

async function processFolderRun(dependencies: FolderRunDependencies): Promise<void> {
  const { database, imports, artifacts, process, runId, folderPath, now } = dependencies
  if (imports.getRun(runId).cancelRequestedAt !== null) {
    imports.cancelRun(runId, now())
    return
  }
  imports.startRun(runId, now())

  let enumeration: Awaited<ReturnType<FolderRunDependencies['pathPolicy']['enumerateFolder']>>
  try {
    enumeration = await dependencies.pathPolicy.enumerateFolder(folderPath, {
      maxItems: MAX_FOLDER_FILES,
      deadlineAt: Date.now() + MAX_PROCESSING_ATTEMPT_MS,
      isCancelled: () => imports.getRun(runId).cancelRequestedAt !== null,
    })
  } catch (error) {
    if (
      error instanceof FolderEnumerationCancelledError ||
      imports.getRun(runId).cancelRequestedAt !== null
    ) {
      cancelOutstandingRun(database, imports, runId, now())
      return
    }
    const [itemId] = imports.addItems(runId, [folderPath])
    const mapped =
      error instanceof FolderEnumerationLimitError
        ? new ArtifactProcessingError('INPUT_TOO_LARGE', 'inspect')
        : error instanceof FolderEnumerationDeadlineError
          ? new ArtifactProcessingError('TIMEOUT', 'inspect')
          : error
    persistItemFailure(imports, artifacts, itemId as number, mapped, now())
    finishImportRun(database, imports, runId, now())
    return
  }

  if (imports.getRun(runId).cancelRequestedAt !== null) {
    cancelOutstandingRun(database, imports, runId, now())
    return
  }
  const files = [...new Map(enumeration.files.map((file) => [file.canonicalPath, file])).values()]
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
      capability: dependencies.capability.value,
      capabilityId: dependencies.capability.recordId,
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

function persistExistingArtifactInspectErrors(
  database: Database.Database,
  artifacts: ArtifactRepository,
  artifactId: number,
  errors: readonly PublicProcessingError[],
  occurredAt: string,
): void {
  const inspectErrors = errors.filter(({ stage }) => stage === 'inspect')
  if (inspectErrors.length === 0) return
  database.transaction(() => {
    database
      .prepare(
        `DELETE FROM artifact_error
         WHERE artifact_id = ? AND generation_id IS NULL AND stage = 'inspect'`,
      )
      .run(artifactId)
    for (const error of inspectErrors) {
      if (error.code === 'SOURCE_MISSING') {
        artifacts.setSourceStatus(artifactId, 'missing', occurredAt)
      }
      artifacts.recordError({
        artifactId,
        generationId: null,
        code: error.code,
        stage: error.stage,
        retryable: error.retryable,
        userMessage: error.message,
        technicalDetail: null,
        occurredAt,
      })
    }
  })()
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
      .prepare(
        "UPDATE import_run SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'running'",
      )
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

function searchPageResponse(
  database: Database.Database,
  codec: CursorCodec,
  thumbnailCodec: ThumbnailResourceCodec,
  search: SearchRepository,
  query: PageQuery,
): GalleryPage {
  const context = cursorContext(database, query, `search:${normalizeSearchText(query.query)}`)
  const cursor = query.cursor ? codec.decode(query.cursor, context) : null
  const results = readSearchWindow(database, search, query, cursor, GALLERY_PAGE_SIZE + 1)
  const rowsById = new Map(
    readArtifactRowsInBatches(
      database,
      results.map(({ artifactId }) => artifactId),
    ).map((row) => [row.id, row]),
  )
  const counts = readSearchCounts(database, search, query, context.catalogRevision)
  const page = results.slice(0, GALLERY_PAGE_SIZE)
  const last = page.at(-1)
  return {
    items: page.map((result) => {
      const row = rowsById.get(result.artifactId)
      if (!row) throw new StaleCursorError()
      return {
        ...toArtifactCard(row, thumbnailCodec),
        match: { reason: result.matchReason, snippet: result.snippet },
      }
    }),
    nextCursor:
      results.length > GALLERY_PAGE_SIZE && last
        ? codec.encode({
            version: 1,
            ...context,
            lastSortKey: last.relevanceKey,
            lastId: last.artifactId,
          })
        : null,
    catalogTotal: database.prepare('SELECT COUNT(*) FROM artifact').pluck().get() as number,
    filteredTotal: query.filter === 'all' ? counts.all : counts[query.filter],
    formatCounts: counts,
  }
}

function readSearchWindow(
  database: Database.Database,
  search: SearchRepository,
  query: PageQuery,
  cursor: { lastSortKey: string; lastId: number } | null,
  limit: number,
): SearchResult[] {
  const matches: SearchResult[] = []
  let after = cursor ? { relevanceKey: cursor.lastSortKey, artifactId: cursor.lastId } : undefined
  while (matches.length < limit) {
    const batch = search.search(query.query, { limit: 100, after })
    if (batch.length === 0) break
    const rows = new Map(
      readArtifactRowsInBatches(
        database,
        batch.map(({ artifactId }) => artifactId),
      ).map((row) => [row.id, row]),
    )
    for (const result of batch) {
      const row = rows.get(result.artifactId)
      if (
        row &&
        (query.status === 'all' || presentationFor(row) === query.status) &&
        (query.filter === 'all' || result.format === query.filter)
      ) {
        matches.push(result)
        if (matches.length === limit) break
      }
    }
    const last = batch.at(-1)
    if (!last || batch.length < 100) break
    after = { relevanceKey: last.relevanceKey, artifactId: last.artifactId }
  }
  return matches
}

function readSearchCounts(
  database: Database.Database,
  search: SearchRepository,
  query: PageQuery,
  revision: string,
): { all: number; html: number; markdown: number } {
  const cacheKey = `${revision}\u0000${query.status}\u0000${normalizeSearchText(query.query)}`
  const cached = searchCountCache.get(database)?.get(cacheKey)
  if (cached) return cached
  const counts = { all: 0, html: 0, markdown: 0 }
  let after: { relevanceKey: string; artifactId: number } | undefined
  for (;;) {
    const batch = search.search(query.query, { limit: 250, after })
    if (batch.length === 0) break
    const rows = new Map(
      readArtifactRowsInBatches(
        database,
        batch.map(({ artifactId }) => artifactId),
      ).map((row) => [row.id, row]),
    )
    for (const result of batch) {
      const row = rows.get(result.artifactId)
      if (!row || (query.status !== 'all' && presentationFor(row) !== query.status)) continue
      counts.all += 1
      counts[result.format] += 1
    }
    const last = batch.at(-1)
    if (!last || batch.length < 250) break
    after = { relevanceKey: last.relevanceKey, artifactId: last.artifactId }
  }
  let databaseCache = searchCountCache.get(database)
  if (!databaseCache) {
    databaseCache = new Map()
    searchCountCache.set(database, databaseCache)
  }
  if (databaseCache.size >= 32) databaseCache.clear()
  databaseCache.set(cacheKey, counts)
  return counts
}

const searchCountCache = new WeakMap<
  Database.Database,
  Map<string, { all: number; html: number; markdown: number }>
>()

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
  if (typeof filter !== 'string' || !['all', 'html', 'markdown'].includes(filter)) {
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

function readArtifactRowsInBatches(
  database: Database.Database,
  ids: readonly number[],
): ArtifactRow[] {
  const rows: ArtifactRow[] = []
  for (let offset = 0; offset < ids.length; offset += 500) {
    rows.push(...readArtifactRows(database, ids.slice(offset, offset + 500)))
  }
  return rows
}

function presentationFor(row: ArtifactRow): CardPresentation {
  return deriveCardPresentation({
    source_status: row.source_status,
    job_status: row.job_status,
    content_status: row.content_status,
    render_status: row.render_status,
    index_status: row.index_status,
  })
}

function toArtifactCard(row: ArtifactRow, thumbnailCodec: ThumbnailResourceCodec): ArtifactCard {
  const status = presentationFor(row)
  return {
    id: row.id,
    title:
      normalizeArtifactTitle(row.user_title) ??
      normalizeArtifactTitle(row.derived_title) ??
      normalizeArtifactTitle(basename(row.source_path)) ??
      'Untitled',
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

function readPublicErrors(
  database: Database.Database,
  artifactId: number,
): PublicProcessingError[] {
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
  if (typeof value !== 'string') throw invalidRequest()
  return normalizeArtifactTitle(value)
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
