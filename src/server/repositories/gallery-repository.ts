import type Database from 'better-sqlite3'

import type { GallerySortMode, GalleryStatusFilter } from '../../shared/contracts.js'
import type {
  ArtifactFormat,
  CardPresentation,
  DerivedStatus,
  GenerationJobStatus,
  SourceStatus,
} from './artifact-repository.js'

export interface GalleryRow {
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
  presentation_status: CardPresentation
  sort_key: string
}

export interface GalleryPageQuery {
  readonly sort: GallerySortMode
  readonly format: 'all' | ArtifactFormat
  readonly status: GalleryStatusFilter
  readonly cursor?: { readonly lastSortKey: string; readonly lastId: number } | null
  readonly artifactIds?: readonly number[]
  readonly limit: number
}

const PRESENTATION_STATUS_SQL = `CASE
  WHEN artifact.source_status = 'missing' THEN 'missing'
  WHEN current_generation.job_status IN ('queued', 'processing') THEN 'processing'
  WHEN current_generation.content_status = 'ready'
   AND current_generation.render_status = 'ready'
   AND current_generation.index_status = 'ready' THEN 'ready'
  WHEN current_generation.content_status = 'ready'
    OR current_generation.render_status = 'ready'
    OR current_generation.index_status = 'ready' THEN 'partial'
  ELSE 'failed'
END`

export class GalleryRepository {
  constructor(private readonly database: Database.Database) {}

  readPage(query: GalleryPageQuery): GalleryRow[] {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 201) {
      throw new TypeError('Gallery page limit is invalid.')
    }
    if (query.artifactIds?.length === 0) return []
    const sortExpression =
      query.sort === 'newest'
        ? 'artifact.registered_at'
        : `search_normalize(COALESCE(
            artifact.user_title,
            artifact.derived_title,
            path_basename(artifact.source_path)
          ))`
    const predicates: string[] = []
    const parameters: Array<string | number> = []
    if (query.format !== 'all') {
      predicates.push('format = ?')
      parameters.push(query.format)
    }
    if (query.status !== 'all') {
      predicates.push('presentation_status = ?')
      parameters.push(query.status)
    }
    if (query.artifactIds) {
      predicates.push(`id IN (${query.artifactIds.map(() => '?').join(', ')})`)
      parameters.push(...query.artifactIds)
    }
    if (query.cursor) {
      const comparison = query.sort === 'newest' ? '<' : '>'
      predicates.push(`(sort_key ${comparison} ? OR (sort_key = ? AND id ${comparison} ?))`)
      parameters.push(query.cursor.lastSortKey, query.cursor.lastSortKey, query.cursor.lastId)
    }
    parameters.push(query.limit)
    const direction = query.sort === 'newest' ? 'DESC' : 'ASC'
    const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : ''
    return this.database
      .prepare(
        `WITH gallery_rows AS (
           SELECT artifact.id,
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
                  active_generation.id AS thumbnail_generation_id,
                  ${PRESENTATION_STATUS_SQL} AS presentation_status,
                  ${sortExpression} AS sort_key
           FROM artifact
           LEFT JOIN artifact_generation AS current_generation
             ON current_generation.artifact_id = artifact.id
            AND current_generation.generation = artifact.generation_counter
           LEFT JOIN artifact_generation AS active_generation
             ON active_generation.id = artifact.active_generation_id
            AND active_generation.artifact_id = artifact.id
         )
         SELECT * FROM gallery_rows
         ${where}
         ORDER BY sort_key ${direction}, id ${direction}
         LIMIT ?`,
      )
      .all(...parameters) as GalleryRow[]
  }
}
