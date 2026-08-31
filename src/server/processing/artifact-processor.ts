import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import type Database from 'better-sqlite3'

import {
  ArtifactProcessingError,
  mapProcessingError,
  toPublicProcessingError,
  type ProcessingStage,
  type PublicProcessingError,
} from '../../shared/errors.js'
import type { HtmlRenderResult } from '../rendering/html-renderer.js'
import {
  MarkdownRenderer,
  type MarkdownRenderResult,
} from '../rendering/markdown-renderer.js'
import {
  ArtifactRepository,
  StaleGenerationError,
  type ArtifactFormat,
  type DerivedStatus,
} from '../repositories/artifact-repository.js'
import { ImportRepository, type ImportItemStage } from '../repositories/import-repository.js'
import { SearchVisibilityRepository } from '../repositories/search-visibility-repository.js'
import { AssetReadLimitError, type AuthorizedFile } from '../security/path-policy.js'
import { SQLiteSearchIndexer } from '../search/sqlite-search-indexer.js'
import {
  MAX_THUMBNAIL_BYTES,
  ThumbnailOptimizationError,
  WebpThumbnailOptimizer,
  type ThumbnailOptimizer,
} from './thumbnail-optimizer.js'
import {
  extractHtmlSource,
  extractMarkdownResult,
  type SourceExtraction,
} from './source-extraction.js'
import { extractSourceInWorker } from './source-extractor.js'

const MAX_SOURCE_BYTES = 10 * 1024 * 1024
export const MIN_COMMIT_REMAINING_MS = 100

type ActiveGeneration = {
  readonly extractedText: string | null
  readonly extractorVersion: string | null
  readonly thumbnailPath: string | null
}

interface CommitSnapshot {
  readonly artifact: {
    readonly active_generation_id: number | null
    readonly derived_title: string | null
    readonly updated_at: string
  }
  readonly generation: {
    readonly job_status: string
    readonly content_status: string
    readonly render_status: string
    readonly index_status: string
    readonly extracted_text: string | null
    readonly extractor_version: string | null
    readonly thumbnail_path: string | null
    readonly previewed_at: string | null
    readonly completed_at: string | null
  }
  readonly visibility: {
    readonly state: string
    readonly updated_at: string
  }
  readonly item: {
    readonly status: string
    readonly error_id: number | null
    readonly completed_at: string | null
  }
  readonly run: {
    readonly status: string
    readonly completed_at: string | null
  }
  readonly diagnostics: ArtifactDiagnosticSnapshot
}

interface ArtifactDiagnosticSnapshot {
  readonly errors: ReadonlyArray<{
    readonly id: number
    readonly artifact_id: number
    readonly generation_id: number | null
    readonly code: string
    readonly stage: string
    readonly retryable: number
    readonly user_message: string
    readonly technical_detail: string | null
    readonly occurred_at: string
  }>
  readonly warnings: ReadonlyArray<{
    readonly id: number
    readonly artifact_id: number
    readonly generation_id: number | null
    readonly code: string
    readonly detail: string
    readonly occurred_at: string
  }>
  readonly itemErrorRelations: ReadonlyArray<{
    readonly item_id: number
    readonly error_id: number
  }>
}

export interface ArtifactIndexer {
  /** Prepares generation-keyed index data without changing the currently visible result. */
  prepare(request: {
    readonly artifactId: number
    readonly generation: number
    readonly sourcePath: string
    readonly text: string
    readonly title?: string | null
    readonly signal?: AbortSignal
  }): Promise<PreparedArtifactIndex>
}

export interface PreparedArtifactIndex {
  /** Runs synchronously while the active-generation SQLite transaction is still open. */
  commit(): void
  /** Restores the previously visible index after any later transaction or file failure. */
  rollback(): Promise<void>
  /** Hides the index if the previous visible state cannot be restored. */
  quarantine(): Promise<void>
}

export interface ProcessingOperationalError {
  readonly operation:
    | 'thumbnail-retirement-cleanup'
    | 'thumbnail-retirement-warning'
    | 'index-rollback'
    | 'index-quarantine-gate'
    | 'index-quarantine'
    | 'index-repair-warning'
  readonly artifactId: number
  readonly generationId: number
  readonly technicalDetail: string | null
}

export interface CommitCriticalSectionMeasurement {
  readonly durationMs: number
  readonly remainingBudgetMs: number | null
}

export interface ProcessorFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  writeFile(path: string, bytes: Buffer): Promise<unknown>
  rename(from: string, to: string): void
  remove(path: string): Promise<unknown>
}

export interface ArtifactProcessorDependencies {
  readonly database: Database.Database
  readonly pathPolicy: {
    authorizeFile(path: string): Promise<AuthorizedFile>
  }
  readonly markdownRenderer?: {
    render(markdown: string): MarkdownRenderResult
  }
  readonly sourceExtractor?: {
    extract(request: {
      readonly format: ArtifactFormat
      readonly source: string
      readonly signal?: AbortSignal
    }): Promise<SourceExtraction>
  }
  readonly htmlRenderer: {
    render(request: {
      html: string
      sourcePath: string
      signal?: AbortSignal
    }): Promise<HtmlRenderResult>
  }
  readonly indexer?: ArtifactIndexer
  readonly thumbnailDirectory: string
  readonly thumbnailOptimizer?: ThumbnailOptimizer
  readonly fileSystem?: ProcessorFileSystem
  readonly now?: () => string
  readonly reportOperationalError?: (
    error: ProcessingOperationalError,
  ) => void | Promise<void>
  readonly reportCommitCriticalSection?: (
    measurement: CommitCriticalSectionMeasurement,
  ) => void
}

export interface ArtifactProcessRequest {
  readonly sourcePath: string
  readonly userTitle?: string | null
  readonly runId?: number
  readonly itemId?: number
  readonly signal?: AbortSignal
  /** Epoch milliseconds. The worker owns this cooperative budget boundary. */
  readonly deadlineAt?: number
}

export type ProcessingOutcome = 'completed' | 'partial' | 'failed' | 'cancelled' | 'stale'

export interface ArtifactProcessResult {
  readonly outcome: ProcessingOutcome
  readonly artifactId: number | null
  readonly generationId: number | null
  readonly generation: number | null
  readonly contentStatus: DerivedStatus
  readonly renderStatus: DerivedStatus
  readonly indexStatus: DerivedStatus
  readonly title: string | null
  readonly thumbnailPath: string | null
  readonly errors: readonly PublicProcessingError[]
}

interface RunContext {
  readonly runId: number
  readonly itemId: number
}

class CommitCancellationError extends Error {
  constructor() {
    super('Cancellation was requested during commit work.')
    this.name = 'CommitCancellationError'
  }
}

class IndexCommitError extends Error {
  constructor(readonly originalError: unknown) {
    super('The prepared index could not be committed.', { cause: originalError })
    this.name = 'IndexCommitError'
  }
}

interface MutableAttempt {
  artifactId: number | null
  generationId: number | null
  generation: number | null
  contentStatus: DerivedStatus
  renderStatus: DerivedStatus
  indexStatus: DerivedStatus
  title: string | null
  thumbnailPath: string | null
  extraction: SourceExtraction | null
  renderResult: HtmlRenderResult | null
  preparedIndex: PreparedArtifactIndex | null
  errors: ArtifactProcessingError[]
  errorIds: number[]
  diagnosticSnapshot: ArtifactDiagnosticSnapshot | null
}

const nodeFileSystem: ProcessorFileSystem = {
  mkdir,
  writeFile,
  rename: renameSync,
  remove: (path) => rm(path, { force: true }),
}

export class ArtifactProcessor {
  private readonly artifacts: ArtifactRepository
  private readonly imports: ImportRepository
  private readonly searchVisibility: SearchVisibilityRepository
  private readonly markdownRenderer: NonNullable<ArtifactProcessorDependencies['markdownRenderer']>
  private readonly sourceExtractor: NonNullable<ArtifactProcessorDependencies['sourceExtractor']>
  private readonly indexer: ArtifactIndexer
  private readonly optimizer: ThumbnailOptimizer
  private readonly fileSystem: ProcessorFileSystem
  private readonly now: () => string

  constructor(private readonly dependencies: ArtifactProcessorDependencies) {
    this.artifacts = new ArtifactRepository(dependencies.database)
    this.imports = new ImportRepository(dependencies.database)
    this.searchVisibility = new SearchVisibilityRepository(dependencies.database)
    this.markdownRenderer = dependencies.markdownRenderer ?? new MarkdownRenderer()
    this.sourceExtractor =
      dependencies.sourceExtractor ??
      (dependencies.markdownRenderer
        ? {
            extract: async ({ format, source }) =>
              format === 'markdown'
                ? extractMarkdownResult(this.markdownRenderer.render(source))
                : extractHtmlSource(source),
          }
        : { extract: extractSourceInWorker })
    this.indexer = dependencies.indexer ?? new SQLiteSearchIndexer(dependencies.database)
    this.optimizer = dependencies.thumbnailOptimizer ?? new WebpThumbnailOptimizer()
    this.fileSystem = dependencies.fileSystem ?? nodeFileSystem
    this.now = dependencies.now ?? (() => new Date().toISOString())
  }

  register(request: ArtifactProcessRequest): Promise<ArtifactProcessResult> {
    return this.process(request)
  }

  refresh(request: ArtifactProcessRequest): Promise<ArtifactProcessResult> {
    return this.process(request)
  }

  retry(request: ArtifactProcessRequest): Promise<ArtifactProcessResult> {
    return this.process(request)
  }

  rebuild(request: ArtifactProcessRequest): Promise<ArtifactProcessResult> {
    return this.process(request)
  }

  // One durable pipeline for every entrypoint: inspect -> extract -> render -> index -> commit.
  async process(request: ArtifactProcessRequest): Promise<ArtifactProcessResult> {
    const run = this.prepareRun(request)
    const attempt: MutableAttempt = {
      artifactId: null,
      generationId: null,
      generation: null,
      contentStatus: 'failed',
      renderStatus: 'failed',
      indexStatus: 'failed',
      title: null,
      thumbnailPath: null,
      extraction: null,
      renderResult: null,
      preparedIndex: null,
      errors: [],
      errorIds: [],
      diagnosticSnapshot: null,
    }

    let authorizedFile: AuthorizedFile
    let sourceFormat: ArtifactFormat
    try {
      if (!this.startStage(run, 'inspect')) return this.cancel(run, attempt, 'inspect')
      this.assertWithinDeadline(request.deadlineAt, 'inspect')
      authorizedFile = await this.waitForAttempt(
        this.dependencies.pathPolicy.authorizeFile(request.sourcePath),
        request.signal,
        'inspect',
      )
      this.assertWithinDeadline(request.deadlineAt, 'inspect')
      sourceFormat = formatFor(authorizedFile.canonicalPath)
      const artifact = this.artifacts.register({
        sourcePath: authorizedFile.canonicalPath,
        format: sourceFormat,
        now: this.now(),
      })
      attempt.artifactId = artifact.id
      this.imports.attachArtifact(run.itemId, artifact.id)
      attempt.diagnosticSnapshot = this.captureArtifactDiagnostics(artifact.id)
      if (request.userTitle !== undefined) {
        this.dependencies.database
          .prepare('UPDATE artifact SET user_title = ? WHERE id = ?')
          .run(normalizeTitle(request.userTitle), artifact.id)
      }
      const storedTitle = this.dependencies.database
        .prepare('SELECT user_title FROM artifact WHERE id = ?')
        .get(artifact.id) as { user_title: string | null }
      attempt.title =
        normalizeTitle(request.userTitle) ??
        normalizeTitle(storedTitle.user_title) ??
        basename(authorizedFile.canonicalPath)
      const generation = this.artifacts.createGeneration(artifact.id, this.now())
      attempt.generationId = generation.id
      attempt.generation = generation.generation
      this.artifacts.setGenerationState(generation.id, {
        jobStatus: 'processing',
        contentStatus: 'pending',
        renderStatus: 'pending',
        indexStatus: 'pending',
      })
      this.assertWithinDeadline(request.deadlineAt, 'inspect')
    } catch (error) {
      const mapped = mapProcessingError(error, 'inspect')
      if (mapped.code === 'TIMEOUT') return this.timeout(run, attempt, 'inspect')
      this.recordError(attempt, mapped)
      this.failItemAndRun(run, attempt)
      return this.result('failed', attempt)
    }

    if (!this.startStage(run, 'extract')) return this.cancel(run, attempt, 'extract')
    try {
      this.assertWithinDeadline(request.deadlineAt, 'extract')
      const source = await this.waitForAttempt(
        authorizedFile.read('utf8', MAX_SOURCE_BYTES),
        request.signal,
        'extract',
      )
      this.assertWithinDeadline(request.deadlineAt, 'extract')
      if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
        throw new ArtifactProcessingError('INPUT_TOO_LARGE', 'extract')
      }
      attempt.extraction = await this.waitForAttempt(
        this.sourceExtractor.extract({
          format: sourceFormat,
          source,
          signal: request.signal,
        }),
        request.signal,
        'extract',
      )
      this.assertWithinDeadline(request.deadlineAt, 'extract')
      attempt.contentStatus = 'ready'
      attempt.title = this.resolveTitle(attempt.artifactId, request.userTitle, attempt.extraction, authorizedFile)
    } catch (error) {
      const mapped =
        error instanceof AssetReadLimitError
          ? new ArtifactProcessingError('INPUT_TOO_LARGE', 'extract')
          : mapProcessingError(
              error,
              'extract',
              sourceFormat === 'markdown' ? 'MARKDOWN_PARSE_FAILED' : 'UNKNOWN',
            )
      if (mapped.code === 'TIMEOUT') return this.timeout(run, attempt, 'extract')
      this.recordError(attempt, mapped)
    }

    if (!this.startStage(run, 'render')) return this.cancel(run, attempt, 'render')
    if (attempt.extraction) {
      try {
        this.assertWithinDeadline(request.deadlineAt, 'render')
        attempt.renderResult = await this.dependencies.htmlRenderer.render({
          html: attempt.extraction.html,
          sourcePath: authorizedFile.canonicalPath,
          signal: request.signal,
        })
        this.assertWithinDeadline(request.deadlineAt, 'render')
        attempt.renderStatus = 'ready'
      } catch (error) {
        const mapped = mapProcessingError(error, 'render', 'HTML_RENDER_FAILED')
        if (mapped.code === 'TIMEOUT') return this.timeout(run, attempt, 'render')
        this.recordError(attempt, mapped)
      }
    }

    if (!this.startStage(run, 'index')) return this.cancel(run, attempt, 'index')
    if (attempt.extraction) {
      try {
        this.assertWithinDeadline(request.deadlineAt, 'index')
        attempt.preparedIndex = await this.waitForAttempt(
          this.indexer.prepare({
            artifactId: attempt.artifactId,
            generation: attempt.generation,
            sourcePath: authorizedFile.canonicalPath,
            text: attempt.extraction.text,
            title: attempt.title,
            signal: request.signal,
          }),
          request.signal,
          'index',
          (prepared) => prepared.rollback(),
        )
        this.assertWithinDeadline(request.deadlineAt, 'index')
        attempt.indexStatus = 'ready'
      } catch (error) {
        const mapped = mapProcessingError(error, 'index', 'INDEX_UPDATE_FAILED')
        if (mapped.code === 'TIMEOUT') return this.timeout(run, attempt, 'index')
        this.recordError(attempt, mapped)
      }
    }

    if (!this.startStage(run, 'commit')) return this.cancel(run, attempt, 'commit')
    return this.commit(run, attempt, authorizedFile, request)
  }

  private async commit(
    run: RunContext,
    attempt: MutableAttempt,
    authorizedFile: AuthorizedFile,
    request: ArtifactProcessRequest,
  ): Promise<ArtifactProcessResult> {
    const { deadlineAt, signal } = request
    const artifactId = requireAttemptNumber(attempt.artifactId, 'artifact id')
    const generationId = requireAttemptNumber(attempt.generationId, 'generation id')
    const generation = requireAttemptNumber(attempt.generation, 'generation counter')
    const active = this.readActiveGeneration(artifactId)
    let temporaryPath: string | null = null
    let finalPath: string | null = null
    let renamed = false

    try {
      this.assertWithinDeadline(deadlineAt, 'commit')
      if (attempt.renderResult) {
        const optimized = await this.waitForAttempt(
          this.optimizer.optimize({
            bytes: attempt.renderResult.screenshot,
            width: attempt.renderResult.width,
            height: attempt.renderResult.height,
            signal,
          }),
          signal,
          'commit',
        )
        this.assertWithinDeadline(deadlineAt, 'commit')
        if (optimized.bytes.byteLength > MAX_THUMBNAIL_BYTES) {
          throw new ThumbnailOptimizationError()
        }
        if (this.isCancellationRequested(run.runId)) {
          return this.cancel(run, attempt, 'commit')
        }
        await this.waitForAttempt(
          this.fileSystem.mkdir(this.dependencies.thumbnailDirectory, { recursive: true }),
          signal,
          'commit',
        )
        this.assertWithinDeadline(deadlineAt, 'commit')
        const base = `artifact-${artifactId}-generation-${generation}.webp`
        finalPath = join(this.dependencies.thumbnailDirectory, base)
        temporaryPath = join(
          this.dependencies.thumbnailDirectory,
          `.${base}.${randomUUID()}.tmp`,
        )
        await this.waitForAttempt(
          this.fileSystem.writeFile(temporaryPath, optimized.bytes),
          signal,
          'commit',
        )
        this.assertWithinDeadline(deadlineAt, 'commit')
      }

      if (this.isCancellationRequested(run.runId)) {
        await this.cleanupPath(temporaryPath)
        return this.cancel(run, attempt, 'commit')
      }

      const cleanSuccess = attempt.errors.length === 0
      const extractedText = attempt.extraction?.text ?? active?.extractedText ?? null
      const extractorVersion =
        attempt.extraction?.extractorVersion ?? active?.extractorVersion ?? null
      const thumbnailPath = finalPath ?? active?.thumbnailPath ?? null
      const completedAt = this.now()
      const remainingBudgetMs = this.requireCommitReserve(deadlineAt)
      const criticalSectionStartedAt = performance.now()
      const configuredBusyTimeoutMs = this.readBusyTimeout()
      const boundedBusyTimeoutMs = this.boundedBusyTimeout(deadlineAt, configuredBusyTimeoutMs)
      let commitSnapshot: CommitSnapshot | null = null
      try {
        this.setBusyTimeout(boundedBusyTimeoutMs)
        commitSnapshot = this.captureCommitSnapshot(
          artifactId,
          generationId,
          run,
          attempt.diagnosticSnapshot ?? this.captureArtifactDiagnostics(artifactId),
        )
        this.requireCommitReserve(deadlineAt)
        try {
          attempt.preparedIndex?.commit()
        } catch (error) {
          throw new IndexCommitError(error)
        }
        this.assertWithinDeadline(deadlineAt, 'commit')
        if (temporaryPath && finalPath) {
          this.fileSystem.rename(temporaryPath, finalPath)
          renamed = true
        }
        this.assertWithinDeadline(deadlineAt, 'commit')
        if (this.isCancellationRequested(run.runId)) throw new CommitCancellationError()
        const transaction = this.dependencies.database.transaction(() => {
          this.assertWithinDeadline(deadlineAt, 'commit')
          this.artifacts.commitGeneration({
            artifactId,
            generationId,
            expectedGeneration: generation,
            contentStatus: attempt.contentStatus,
            renderStatus: attempt.renderStatus,
            indexStatus: attempt.indexStatus,
            extractedText,
            extractorVersion,
            thumbnailPath,
            previewedAt: attempt.renderResult ? completedAt : null,
            completedAt,
          })
          this.assertWithinDeadline(deadlineAt, 'commit')
          this.dependencies.database
            .prepare('UPDATE artifact SET derived_title = ?, updated_at = ? WHERE id = ?')
            .run(attempt.title ?? basename(authorizedFile.canonicalPath), completedAt, artifactId)
          this.assertWithinDeadline(deadlineAt, 'commit')
          if (cleanSuccess) {
            this.dependencies.database
              .prepare('DELETE FROM artifact_error WHERE artifact_id = ?')
              .run(artifactId)
            this.dependencies.database
              .prepare(
                `DELETE FROM artifact_warning
                 WHERE artifact_id = ?
                   AND code NOT IN ('THUMBNAIL_RETIRE_PENDING', 'INDEX_REPAIR_PENDING')`,
              )
              .run(artifactId)
          }
          for (const warning of attempt.renderResult?.warnings ?? []) {
            this.artifacts.recordWarning({
              artifactId,
              generationId,
              code: warning.code,
              detail:
                warning.code === 'CONTENT_CLIPPED'
                  ? 'Preview exceeded 2400px.'
                  : 'One or more preview assets were blocked.',
              occurredAt: completedAt,
            })
          }
          if (this.isCancellationRequested(run.runId)) throw new CommitCancellationError()
          if (attempt.errors.length > 0) {
            this.failItemAndRun(run, attempt)
          } else {
            this.imports.completeItem(run.itemId, completedAt)
            this.finishRunIfTerminal(run.runId, completedAt)
          }
          this.assertWithinDeadline(deadlineAt, 'commit')
        })
        transaction()
      } finally {
        this.setBusyTimeout(configuredBusyTimeoutMs)
        this.reportCommitCriticalSection({
          durationMs: performance.now() - criticalSectionStartedAt,
          remainingBudgetMs,
        })
      }
      if (this.deadlineExceeded(deadlineAt)) {
        if (!commitSnapshot) throw new ArtifactProcessingError('TIMEOUT', 'commit')
        this.restoreCommitSnapshot(artifactId, generationId, run, commitSnapshot)
        throw new ArtifactProcessingError('TIMEOUT', 'commit')
      }
      attempt.thumbnailPath = thumbnailPath
    } catch (error) {
      const indexRecoveryError = await this.recoverPreparedIndex(attempt)
      await this.cleanupPath(temporaryPath)
      if (renamed) await this.cleanupPath(finalPath)
      if (error instanceof CommitCancellationError) {
        this.ensureCancellationRequested(run.runId)
        if (indexRecoveryError) this.recordError(attempt, indexRecoveryError)
        return this.cancel(run, attempt, 'commit', false)
      }
      const mapped =
        indexRecoveryError ??
        (error instanceof IndexCommitError
          ? mapProcessingError(error.originalError, 'index', 'INDEX_UPDATE_FAILED')
          : error instanceof StaleGenerationError
          ? new ArtifactProcessingError('STALE_GENERATION', 'commit', error.message, {
              cause: error,
            })
          : mapProcessingError(error, 'commit', 'DERIVED_WRITE_FAILED'))
      if (mapped.code === 'TIMEOUT') {
        return this.timeout(run, attempt, 'commit', false)
      }
      attempt.contentStatus = 'failed'
      attempt.renderStatus = 'failed'
      attempt.indexStatus = 'failed'
      this.recordError(attempt, mapped)
      if (attempt.generationId !== null) {
        this.artifacts.setGenerationState(attempt.generationId, {
          jobStatus: mapped.code === 'STALE_GENERATION' ? 'interrupted' : 'idle',
          contentStatus: 'failed',
          renderStatus: 'failed',
          indexStatus: 'failed',
        })
      }
      this.failItemAndRun(run, attempt)
      return this.result(mapped.code === 'STALE_GENERATION' ? 'stale' : 'failed', attempt)
    }

    // The generation, import item, and index are committed at this point. Cleanup failures
    // must never enter the transaction rollback path or remove the new active thumbnail.
    try {
      await this.cleanupInactiveThumbnails(artifactId, generationId, attempt.thumbnailPath)
    } catch (error) {
      await this.reportOperationalError({
        operation: 'thumbnail-retirement-cleanup',
        artifactId,
        generationId,
        technicalDetail: technicalDetail(error),
      })
    }
    if (attempt.indexStatus === 'ready') {
      try {
        this.dependencies.database
          .prepare(
            `DELETE FROM artifact_warning
             WHERE artifact_id = ? AND code = 'INDEX_REPAIR_PENDING'`,
          )
          .run(artifactId)
      } catch (error) {
        await this.reportOperationalError({
          operation: 'index-repair-warning',
          artifactId,
          generationId,
          technicalDetail: technicalDetail(error),
        })
      }
    }

    if (attempt.errors.length > 0) {
      return this.result(hasReadyDerivative(attempt) ? 'partial' : 'failed', attempt)
    }
    return this.result('completed', attempt)
  }

  private prepareRun(request: ArtifactProcessRequest): RunContext {
    if ((request.runId === undefined) !== (request.itemId === undefined)) {
      throw new Error('runId and itemId must be provided together.')
    }
    if (request.runId !== undefined && request.itemId !== undefined) {
      const run = this.imports.getRun(request.runId)
      const item = this.imports.getItem(request.itemId)
      if (item.runId !== run.id) throw new Error('Import item does not belong to the run.')
      if (run.status === 'queued' && run.cancelRequestedAt === null) {
        this.imports.startRun(run.id, this.now())
      }
      return { runId: run.id, itemId: item.id }
    }
    const created = this.imports.createRun([request.sourcePath])
    this.imports.startRun(created.id, this.now())
    return { runId: created.id, itemId: created.itemIds[0] as number }
  }

  private startStage(run: RunContext, stage: Exclude<ImportItemStage, 'queued'>): boolean {
    return this.imports.startStage(run.itemId, stage, this.now())
  }

  private async cancel(
    run: RunContext,
    attempt: MutableAttempt,
    stage: ProcessingStage,
    rollbackPreparedIndex = true,
  ): Promise<ArtifactProcessResult> {
    if (rollbackPreparedIndex) {
      const indexRecoveryError = await this.recoverPreparedIndex(attempt)
      if (indexRecoveryError) this.recordError(attempt, indexRecoveryError)
    }
    const error = new ArtifactProcessingError('CANCELLED', stage)
    this.recordError(attempt, error)
    if (attempt.generationId !== null) {
      this.artifacts.setGenerationState(attempt.generationId, {
        jobStatus: 'interrupted',
        contentStatus: attempt.contentStatus,
        renderStatus: attempt.renderStatus,
        indexStatus: attempt.indexStatus,
      })
    }
    this.imports.cancelItem(run.itemId, this.now())
    this.finishRunIfTerminal(run.runId, this.now())
    return this.result('cancelled', attempt)
  }

  private async timeout(
    run: RunContext,
    attempt: MutableAttempt,
    stage: ProcessingStage,
    rollbackPreparedIndex = true,
  ): Promise<ArtifactProcessResult> {
    if (rollbackPreparedIndex) {
      const indexRecoveryError = await this.recoverPreparedIndex(attempt)
      if (indexRecoveryError) this.recordError(attempt, indexRecoveryError)
    }
    const error = new ArtifactProcessingError('TIMEOUT', stage)
    this.recordError(attempt, error)
    if (this.isCancellationRequested(run.runId)) {
      return this.cancel(run, attempt, stage, false)
    }
    if (attempt.generationId !== null) {
      this.artifacts.setGenerationState(attempt.generationId, {
        jobStatus: 'interrupted',
        contentStatus: attempt.contentStatus,
        renderStatus: attempt.renderStatus,
        indexStatus: attempt.indexStatus,
      })
    }
    this.failItemAndRun(run, attempt)
    return this.result('failed', attempt)
  }

  private assertWithinDeadline(
    deadlineAt: number | undefined,
    stage: ProcessingStage,
  ): void {
    if (this.deadlineExceeded(deadlineAt)) {
      throw new ArtifactProcessingError('TIMEOUT', stage)
    }
  }

  private deadlineExceeded(deadlineAt: number | undefined): boolean {
    return deadlineAt !== undefined && Date.now() >= deadlineAt
  }

  private requireCommitReserve(deadlineAt: number | undefined): number | null {
    if (deadlineAt === undefined) return null
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs < MIN_COMMIT_REMAINING_MS) {
      throw new ArtifactProcessingError('TIMEOUT', 'commit')
    }
    return remainingMs
  }

  private boundedBusyTimeout(
    deadlineAt: number | undefined,
    configuredBusyTimeoutMs: number,
  ): number {
    if (deadlineAt === undefined) return configuredBusyTimeoutMs
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs < MIN_COMMIT_REMAINING_MS) {
      throw new ArtifactProcessingError('TIMEOUT', 'commit')
    }
    return Math.max(1, Math.min(configuredBusyTimeoutMs, Math.floor(remainingMs)))
  }

  private readBusyTimeout(): number {
    return this.dependencies.database.pragma('busy_timeout', { simple: true }) as number
  }

  private setBusyTimeout(timeoutMs: number): void {
    this.dependencies.database.pragma(`busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`)
  }

  private reportCommitCriticalSection(measurement: CommitCriticalSectionMeasurement): void {
    try {
      this.dependencies.reportCommitCriticalSection?.(measurement)
    } catch {
      // Reliability measurement cannot change a committed user-visible result.
    }
  }

  private captureCommitSnapshot(
    artifactId: number,
    generationId: number,
    run: RunContext,
    diagnostics: ArtifactDiagnosticSnapshot,
  ): CommitSnapshot {
    const artifact = this.dependencies.database
      .prepare('SELECT active_generation_id, derived_title, updated_at FROM artifact WHERE id = ?')
      .get(artifactId) as CommitSnapshot['artifact'] | undefined
    const generation = this.dependencies.database
      .prepare(
        `SELECT job_status, content_status, render_status, index_status,
                extracted_text, extractor_version, thumbnail_path, previewed_at, completed_at
         FROM artifact_generation WHERE id = ?`,
      )
      .get(generationId) as CommitSnapshot['generation'] | undefined
    const visibility = this.dependencies.database
      .prepare(
        `SELECT state, updated_at FROM artifact_search_visibility
         WHERE artifact_id = ? AND generation_id = ?`,
      )
      .get(artifactId, generationId) as CommitSnapshot['visibility'] | undefined
    const item = this.dependencies.database
      .prepare('SELECT status, error_id, completed_at FROM import_item WHERE id = ?')
      .get(run.itemId) as CommitSnapshot['item'] | undefined
    const importRun = this.dependencies.database
      .prepare('SELECT status, completed_at FROM import_run WHERE id = ?')
      .get(run.runId) as CommitSnapshot['run'] | undefined
    if (!artifact || !generation || !visibility || !item || !importRun) {
      throw new Error('Commit state could not be snapshotted.')
    }
    return { artifact, generation, visibility, item, run: importRun, diagnostics }
  }

  private captureArtifactDiagnostics(artifactId: number): ArtifactDiagnosticSnapshot {
    const errors = this.dependencies.database
      .prepare('SELECT * FROM artifact_error WHERE artifact_id = ? ORDER BY id')
      .all(artifactId) as ArtifactDiagnosticSnapshot['errors']
    const warnings = this.dependencies.database
      .prepare('SELECT * FROM artifact_warning WHERE artifact_id = ? ORDER BY id')
      .all(artifactId) as ArtifactDiagnosticSnapshot['warnings']
    const itemErrorRelations = this.dependencies.database
      .prepare(
        `SELECT import_item.id AS item_id, import_item.error_id
         FROM import_item
         JOIN artifact_error ON artifact_error.id = import_item.error_id
         WHERE artifact_error.artifact_id = ?
         ORDER BY import_item.id`,
      )
      .all(artifactId) as ArtifactDiagnosticSnapshot['itemErrorRelations']
    return { errors, warnings, itemErrorRelations }
  }

  private restoreCommitSnapshot(
    artifactId: number,
    generationId: number,
    run: RunContext,
    snapshot: CommitSnapshot,
  ): void {
    this.dependencies.database.transaction(() => {
      this.dependencies.database
        .prepare('DELETE FROM artifact_warning WHERE artifact_id = ?')
        .run(artifactId)
      this.dependencies.database
        .prepare('DELETE FROM artifact_error WHERE artifact_id = ?')
        .run(artifactId)
      const insertError = this.dependencies.database.prepare(
        `INSERT INTO artifact_error (
           id, artifact_id, generation_id, code, stage, retryable,
           user_message, technical_detail, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const error of snapshot.diagnostics.errors) {
        insertError.run(
          error.id,
          error.artifact_id,
          error.generation_id,
          error.code,
          error.stage,
          error.retryable,
          error.user_message,
          error.technical_detail,
          error.occurred_at,
        )
      }
      const insertWarning = this.dependencies.database.prepare(
        `INSERT INTO artifact_warning (
           id, artifact_id, generation_id, code, detail, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const warning of snapshot.diagnostics.warnings) {
        insertWarning.run(
          warning.id,
          warning.artifact_id,
          warning.generation_id,
          warning.code,
          warning.detail,
          warning.occurred_at,
        )
      }
      const restoreErrorRelation = this.dependencies.database.prepare(
        'UPDATE import_item SET error_id = ? WHERE id = ?',
      )
      for (const relation of snapshot.diagnostics.itemErrorRelations) {
        restoreErrorRelation.run(relation.error_id, relation.item_id)
      }
      this.dependencies.database
        .prepare(
          `UPDATE artifact
           SET active_generation_id = ?, derived_title = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          snapshot.artifact.active_generation_id,
          snapshot.artifact.derived_title,
          snapshot.artifact.updated_at,
          artifactId,
        )
      this.dependencies.database
        .prepare(
          `UPDATE artifact_generation
           SET job_status = ?, content_status = ?, render_status = ?, index_status = ?,
               extracted_text = ?, extractor_version = ?, thumbnail_path = ?,
               previewed_at = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(
          snapshot.generation.job_status,
          snapshot.generation.content_status,
          snapshot.generation.render_status,
          snapshot.generation.index_status,
          snapshot.generation.extracted_text,
          snapshot.generation.extractor_version,
          snapshot.generation.thumbnail_path,
          snapshot.generation.previewed_at,
          snapshot.generation.completed_at,
          generationId,
        )
      this.dependencies.database
        .prepare(
          `UPDATE artifact_search_visibility SET state = ?, updated_at = ?
           WHERE artifact_id = ? AND generation_id = ?`,
        )
        .run(snapshot.visibility.state, snapshot.visibility.updated_at, artifactId, generationId)
      this.dependencies.database
        .prepare(
          `UPDATE import_item SET status = ?, error_id = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(snapshot.item.status, snapshot.item.error_id, snapshot.item.completed_at, run.itemId)
      this.dependencies.database
        .prepare('UPDATE import_run SET status = ?, completed_at = ? WHERE id = ?')
        .run(snapshot.run.status, snapshot.run.completed_at, run.runId)
    })()
  }

  private waitForAttempt<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
    stage: ProcessingStage,
    disposeLateResult?: (value: T) => Promise<unknown>,
  ): Promise<T> {
    if (!signal) return operation
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        reject(new ArtifactProcessingError('TIMEOUT', stage, undefined, { cause: signal.reason }))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      void operation.then(
        (value) => {
          if (settled) {
            void disposeLateResult?.(value).catch(() => undefined)
            return
          }
          settled = true
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  private isCancellationRequested(runId: number): boolean {
    return this.imports.getRun(runId).cancelRequestedAt !== null
  }

  private ensureCancellationRequested(runId: number): void {
    if (!this.isCancellationRequested(runId)) {
      this.imports.requestCancellation(runId, this.now())
    }
  }

  private recordError(attempt: MutableAttempt, error: ArtifactProcessingError): void {
    attempt.errors.push(error)
    const errorId = this.artifacts.recordError({
      artifactId: attempt.artifactId,
      generationId: attempt.generationId,
      code: error.code,
      stage: error.stage,
      retryable: error.retryable,
      userMessage: error.userMessage,
      technicalDetail: error.technicalDetail,
      occurredAt: this.now(),
    })
    attempt.errorIds.push(errorId)
  }

  private failItemAndRun(run: RunContext, attempt: MutableAttempt): void {
    const errorId = attempt.errorIds.at(-1)
    if (errorId === undefined) throw new Error('A failed import item requires an error.')
    this.imports.failItem(run.itemId, errorId, this.now())
    this.finishRunIfTerminal(run.runId, this.now())
  }

  private finishRunIfTerminal(runId: number, completedAt: string): void {
    const statuses = this.dependencies.database
      .prepare('SELECT status FROM import_item WHERE run_id = ?')
      .all(runId) as Array<{ status: string }>
    if (statuses.some(({ status }) => status === 'queued' || status === 'processing')) return
    if (statuses.some(({ status }) => status === 'cancelled')) {
      this.imports.cancelRun(runId, completedAt)
      return
    }
    if (statuses.some(({ status }) => status === 'failed' || status === 'interrupted')) {
      this.dependencies.database
        .prepare(
          `UPDATE import_run SET status = 'failed', completed_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(completedAt, runId)
      return
    }
    this.imports.completeRun(runId, completedAt)
  }

  private resolveTitle(
    artifactId: number,
    requestedUserTitle: string | null | undefined,
    extraction: SourceExtraction,
    authorizedFile: AuthorizedFile,
  ): string {
    const persisted = this.dependencies.database
      .prepare('SELECT user_title FROM artifact WHERE id = ?')
      .get(artifactId) as { user_title: string | null }
    return (
      normalizeTitle(requestedUserTitle) ??
      normalizeTitle(persisted.user_title) ??
      normalizeTitle(extraction.documentTitle) ??
      basename(authorizedFile.canonicalPath)
    )
  }

  private readActiveGeneration(artifactId: number): ActiveGeneration | null {
    const row = this.dependencies.database
      .prepare(
        `SELECT artifact_generation.extracted_text, artifact_generation.extractor_version,
                artifact_generation.thumbnail_path
         FROM artifact
         JOIN artifact_generation ON artifact_generation.id = artifact.active_generation_id
         WHERE artifact.id = ?`,
      )
      .get(artifactId) as
      | {
          extracted_text: string | null
          extractor_version: string | null
          thumbnail_path: string | null
        }
      | undefined
    return row
      ? {
          extractedText: row.extracted_text,
          extractorVersion: row.extractor_version,
          thumbnailPath: row.thumbnail_path,
        }
      : null
  }

  private async cleanupPath(path: string | null): Promise<void> {
    if (!path) return
    await this.fileSystem.remove(path).catch(() => undefined)
  }

  private async cleanupInactiveThumbnails(
    artifactId: number,
    generationId: number,
    activeThumbnailPath: string | null,
  ): Promise<void> {
    const rows = this.dependencies.database
      .prepare(
        `SELECT DISTINCT thumbnail_path
         FROM artifact_generation
         WHERE artifact_id = ? AND id <> ? AND thumbnail_path IS NOT NULL
           AND (? IS NULL OR thumbnail_path <> ?)`,
      )
      .all(artifactId, generationId, activeThumbnailPath, activeThumbnailPath) as Array<{
      thumbnail_path: string
    }>
    let cleanupFailed = false
    for (const row of rows) {
      try {
        await this.fileSystem.remove(row.thumbnail_path)
      } catch {
        cleanupFailed = true
      }
    }

    if (!cleanupFailed) {
      this.dependencies.database
        .prepare(
          `DELETE FROM artifact_warning
           WHERE artifact_id = ? AND code = 'THUMBNAIL_RETIRE_PENDING'`,
        )
        .run(artifactId)
      return
    }

    const pending = this.dependencies.database
      .prepare(
        `SELECT 1 FROM artifact_warning
         WHERE artifact_id = ? AND code = 'THUMBNAIL_RETIRE_PENDING' LIMIT 1`,
      )
      .get(artifactId)
    if (pending) return
    try {
      this.artifacts.recordWarning({
        artifactId,
        generationId,
        code: 'THUMBNAIL_RETIRE_PENDING',
        detail: 'Previous thumbnail cleanup is pending.',
        occurredAt: this.now(),
      })
    } catch (error) {
      await this.reportOperationalError({
        operation: 'thumbnail-retirement-warning',
        artifactId,
        generationId,
        technicalDetail: technicalDetail(error),
      })
    }
  }

  private async recoverPreparedIndex(
    attempt: MutableAttempt,
  ): Promise<ArtifactProcessingError | null> {
    if (!attempt.preparedIndex) return null
    try {
      await attempt.preparedIndex.rollback()
      return null
    } catch (rollbackError) {
      attempt.indexStatus = 'failed'
      const artifactId = requireAttemptNumber(attempt.artifactId, 'artifact id')
      const generationId = requireAttemptNumber(attempt.generationId, 'generation id')
      await this.reportOperationalError({
        operation: 'index-rollback',
        artifactId,
        generationId,
        technicalDetail: technicalDetail(rollbackError),
      })
      let durableQuarantineError: unknown = null
      try {
        this.searchVisibility.quarantineGeneration({
          artifactId,
          generationId,
          now: this.now(),
        })
      } catch (error) {
        durableQuarantineError = error
        await this.reportOperationalError({
          operation: 'index-quarantine-gate',
          artifactId,
          generationId,
          technicalDetail: technicalDetail(error),
        })
      }
      try {
        await attempt.preparedIndex.quarantine()
      } catch (quarantineError) {
        await this.reportOperationalError({
          operation: 'index-quarantine',
          artifactId,
          generationId,
          technicalDetail: technicalDetail(quarantineError),
        })
      }
      try {
        const pending = this.dependencies.database
          .prepare(
            `SELECT 1 FROM artifact_warning
             WHERE artifact_id = ? AND code = 'INDEX_REPAIR_PENDING' LIMIT 1`,
          )
          .get(artifactId)
        if (!pending) {
          this.artifacts.recordWarning({
            artifactId,
            generationId,
            code: 'INDEX_REPAIR_PENDING',
            detail: 'Search index repair is pending.',
            occurredAt: this.now(),
          })
        }
      } catch (warningError) {
        await this.reportOperationalError({
          operation: 'index-repair-warning',
          artifactId,
          generationId,
          technicalDetail: technicalDetail(warningError),
        })
      }
      return mapProcessingError(
        durableQuarantineError ?? rollbackError,
        'index',
        'INDEX_UPDATE_FAILED',
      )
    }
  }

  private async reportOperationalError(error: ProcessingOperationalError): Promise<void> {
    try {
      await this.dependencies.reportOperationalError?.(error)
    } catch {
      // Operational reporting cannot change an already committed user-visible result.
    }
  }

  private result(outcome: ProcessingOutcome, attempt: MutableAttempt): ArtifactProcessResult {
    return {
      outcome,
      artifactId: attempt.artifactId,
      generationId: attempt.generationId,
      generation: attempt.generation,
      contentStatus: attempt.contentStatus,
      renderStatus: attempt.renderStatus,
      indexStatus: attempt.indexStatus,
      title: attempt.title,
      thumbnailPath: attempt.thumbnailPath,
      errors: attempt.errors.map(toPublicProcessingError),
    }
  }
}

function normalizeTitle(title: string | null | undefined): string | null {
  const normalized = title?.trim()
  return normalized ? normalized : null
}

function formatFor(path: string): ArtifactFormat {
  const extension = extname(path).toLowerCase()
  return extension === '.md' ? 'markdown' : 'html'
}

function hasReadyDerivative(attempt: MutableAttempt): boolean {
  return (
    attempt.contentStatus === 'ready' ||
    attempt.renderStatus === 'ready' ||
    attempt.indexStatus === 'ready'
  )
}

function requireAttemptNumber(value: number | null, label: string): number {
  if (value === null) throw new Error(`Processing attempt is missing ${label}.`)
  return value
}

function technicalDetail(error: unknown): string | null {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return null
}
