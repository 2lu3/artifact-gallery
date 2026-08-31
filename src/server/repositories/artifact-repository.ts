import type Database from 'better-sqlite3'

export type ArtifactFormat = 'markdown' | 'html'
export type SourceStatus = 'available' | 'missing'
export type GenerationJobStatus = 'queued' | 'processing' | 'idle' | 'interrupted'
export type DerivedStatus = 'pending' | 'ready' | 'failed'
export type CardPresentation = 'missing' | 'processing' | 'ready' | 'partial' | 'failed'

export interface ArtifactRecord {
  id: number
  sourcePath: string
  format: ArtifactFormat
  sourceStatus: SourceStatus
  generationCounter: number
  activeGenerationId: number | null
}

export interface GenerationRecord {
  id: number
  artifactId: number
  generation: number
}

export interface GenerationState {
  jobStatus: GenerationJobStatus
  contentStatus: DerivedStatus
  renderStatus: DerivedStatus
  indexStatus: DerivedStatus
}

export interface ArtifactErrorInput {
  artifactId: number | null
  generationId: number | null
  code: string
  stage: string
  retryable: boolean
  userMessage: string
  technicalDetail: string | null
  occurredAt: string
}

export interface ArtifactErrorRecord {
  code: string
  stage: string
  retryable: boolean
  userMessage: string
  technicalDetail: string | null
  occurredAt: string
}

export interface ArtifactWarningInput {
  artifactId: number
  generationId: number | null
  code: string
  detail: string
  occurredAt: string
}

export interface ArtifactWarningRecord {
  code: string
  detail: string
  occurredAt: string
}

export interface CommitGenerationInput {
  artifactId: number
  generationId: number
  expectedGeneration: number
  contentStatus: DerivedStatus
  renderStatus: DerivedStatus
  indexStatus: DerivedStatus
  extractedText: string | null
  extractorVersion: string | null
  thumbnailPath: string | null
  previewedAt: string | null
  completedAt: string
}

export class StaleGenerationError extends Error {
  constructor() {
    super('The artifact generation changed before commit.')
    this.name = 'StaleGenerationError'
  }
}

interface PresentationRow {
  source_status: SourceStatus
  job_status: GenerationJobStatus | null
  content_status: DerivedStatus | null
  render_status: DerivedStatus | null
  index_status: DerivedStatus | null
}

export class ArtifactRepository {
  constructor(private readonly database: Database.Database) {}

  register(input: { sourcePath: string; format: ArtifactFormat; now: string }): ArtifactRecord {
    const row = this.database
      .prepare(
        `INSERT INTO artifact
          (source_path, format, source_status, created_at, updated_at, registered_at)
         VALUES (?, ?, 'available', ?, ?, ?)
         ON CONFLICT(source_path) DO UPDATE SET
           format = excluded.format,
           source_status = 'available',
           updated_at = excluded.updated_at
         RETURNING id, source_status, generation_counter, active_generation_id`,
      )
      .get(input.sourcePath, input.format, input.now, input.now, input.now) as {
      id: number
      source_status: SourceStatus
      generation_counter: number
      active_generation_id: number | null
    }

    return {
      id: row.id,
      sourcePath: input.sourcePath,
      format: input.format,
      sourceStatus: row.source_status,
      generationCounter: row.generation_counter,
      activeGenerationId: row.active_generation_id,
    }
  }

  createGeneration(artifactId: number, now: string): GenerationRecord {
    return this.database.transaction(() => {
      const artifact = this.database
        .prepare(
          `UPDATE artifact
           SET generation_counter = generation_counter + 1, updated_at = ?
           WHERE id = ?
           RETURNING generation_counter`,
        )
        .get(now, artifactId) as { generation_counter: number }

      const result = this.database
        .prepare(
          `INSERT INTO artifact_generation
            (artifact_id, generation, job_status, content_status, render_status, index_status)
           VALUES (?, ?, 'queued', 'pending', 'pending', 'pending')`,
        )
        .run(artifactId, artifact.generation_counter)

      return {
        id: Number(result.lastInsertRowid),
        artifactId,
        generation: artifact.generation_counter,
      }
    })()
  }

  commitGeneration(input: CommitGenerationInput): void {
    this.database.transaction(() => {
      const generation = this.database
        .prepare(
          `UPDATE artifact_generation
           SET job_status = 'idle',
               content_status = ?,
               render_status = ?,
               index_status = ?,
               extracted_text = ?,
               extractor_version = ?,
               thumbnail_path = ?,
               previewed_at = ?,
               completed_at = ?
           WHERE id = ? AND artifact_id = ? AND generation = ?`,
        )
        .run(
          input.contentStatus,
          input.renderStatus,
          input.indexStatus,
          input.extractedText,
          input.extractorVersion,
          input.thumbnailPath,
          input.previewedAt,
          input.completedAt,
          input.generationId,
          input.artifactId,
          input.expectedGeneration,
        )
      if (generation.changes !== 1) {
        throw new StaleGenerationError()
      }

      const artifact = this.database
        .prepare(
          `UPDATE artifact
           SET active_generation_id = CASE WHEN ? THEN ? ELSE active_generation_id END,
               updated_at = ?
           WHERE id = ? AND generation_counter = ?`,
        )
        .run(
          input.contentStatus === 'ready' ||
            input.renderStatus === 'ready' ||
            input.indexStatus === 'ready'
            ? 1
            : 0,
          input.generationId,
          input.completedAt,
          input.artifactId,
          input.expectedGeneration,
        )
      if (artifact.changes !== 1) {
        throw new StaleGenerationError()
      }
    })()
  }

  setGenerationState(generationId: number, state: GenerationState): void {
    this.database
      .prepare(
        `UPDATE artifact_generation
         SET job_status = ?, content_status = ?, render_status = ?, index_status = ?
         WHERE id = ?`,
      )
      .run(
        state.jobStatus,
        state.contentStatus,
        state.renderStatus,
        state.indexStatus,
        generationId,
      )
  }

  setSourceStatus(artifactId: number, sourceStatus: SourceStatus, now: string): void {
    this.database
      .prepare('UPDATE artifact SET source_status = ?, updated_at = ? WHERE id = ?')
      .run(sourceStatus, now, artifactId)
  }

  recordError(input: ArtifactErrorInput): number {
    const result = this.database
      .prepare(
        `INSERT INTO artifact_error
          (artifact_id, generation_id, code, stage, retryable, user_message, technical_detail, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.artifactId,
        input.generationId,
        input.code,
        input.stage,
        input.retryable ? 1 : 0,
        input.userMessage,
        input.technicalDetail,
        input.occurredAt,
      )
    return Number(result.lastInsertRowid)
  }

  recordWarning(input: ArtifactWarningInput): number {
    const result = this.database
      .prepare(
        `INSERT INTO artifact_warning
          (artifact_id, generation_id, code, detail, occurred_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.artifactId, input.generationId, input.code, input.detail, input.occurredAt)
    return Number(result.lastInsertRowid)
  }

  listErrors(artifactId: number): ArtifactErrorRecord[] {
    const rows = this.database
      .prepare(
        `SELECT code, stage, retryable, user_message, technical_detail, occurred_at
         FROM artifact_error WHERE artifact_id = ? ORDER BY id`,
      )
      .all(artifactId) as Array<{
      code: string
      stage: string
      retryable: number
      user_message: string
      technical_detail: string | null
      occurred_at: string
    }>
    return rows.map((row) => ({
      code: row.code,
      stage: row.stage,
      retryable: row.retryable === 1,
      userMessage: row.user_message,
      technicalDetail: row.technical_detail,
      occurredAt: row.occurred_at,
    }))
  }

  listWarnings(artifactId: number): ArtifactWarningRecord[] {
    const rows = this.database
      .prepare(
        `SELECT code, detail, occurred_at
         FROM artifact_warning WHERE artifact_id = ? ORDER BY id`,
      )
      .all(artifactId) as Array<{ code: string; detail: string; occurred_at: string }>
    return rows.map((row) => ({
      code: row.code,
      detail: row.detail,
      occurredAt: row.occurred_at,
    }))
  }

  getCardPresentation(artifactId: number): CardPresentation {
    const row = this.database
      .prepare(
        `SELECT
           artifact.source_status,
           artifact_generation.job_status,
           artifact_generation.content_status,
           artifact_generation.render_status,
           artifact_generation.index_status
         FROM artifact
         LEFT JOIN artifact_generation
           ON artifact_generation.artifact_id = artifact.id
          AND artifact_generation.generation = artifact.generation_counter
         WHERE artifact.id = ?`,
      )
      .get(artifactId) as PresentationRow

    return deriveCardPresentation(row)
  }
}

export function deriveCardPresentation(state: PresentationRow): CardPresentation {
  if (state.source_status === 'missing') {
    return 'missing'
  }
  if (state.job_status === 'queued' || state.job_status === 'processing') {
    return 'processing'
  }
  if (
    state.content_status === 'ready' &&
    state.render_status === 'ready' &&
    state.index_status === 'ready'
  ) {
    return 'ready'
  }
  if (
    state.content_status === 'ready' ||
    state.render_status === 'ready' ||
    state.index_status === 'ready'
  ) {
    return 'partial'
  }
  return 'failed'
}
