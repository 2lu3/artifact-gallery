import { basename } from 'node:path'

import type Database from 'better-sqlite3'

import type { ArtifactIndexer, PreparedArtifactIndex } from '../processing/artifact-processor.js'
import { SearchVisibilityRepository } from '../repositories/search-visibility-repository.js'
import { normalizeSearchIndexBody } from './search-index-normalizer.js'
import { normalizePathSegments, normalizeSearchText } from './search-query.js'

export interface SearchIndexRepairInput {
  readonly artifactId: number
  readonly generation: number
  readonly now: string
}

interface PreparedGenerationIndex {
  readonly generationId: number
  readonly artifactId: number
  readonly generation: number
  readonly bodyNormalized: string
  readonly derivedTitleOverride?: string | null
}

interface ArtifactIndexMetadata {
  readonly source_path: string
  readonly format: 'html' | 'markdown'
  readonly user_title: string | null
  readonly derived_title: string | null
}

export class SQLiteSearchIndexer implements ArtifactIndexer {
  private readonly visibility: SearchVisibilityRepository

  constructor(private readonly database: Database.Database) {
    this.visibility = new SearchVisibilityRepository(database)
  }

  async prepare(request: {
    readonly artifactId: number
    readonly generation: number
    readonly sourcePath: string
    readonly text: string
    readonly title?: string | null
    readonly signal?: AbortSignal
  }): Promise<PreparedArtifactIndex> {
    const generationId = this.readGenerationId(request.artifactId, request.generation)
    const normalized = await normalizeSearchIndexBody({
      body: request.text,
      signal: request.signal,
    })
    const staged: PreparedGenerationIndex = {
      generationId,
      artifactId: request.artifactId,
      generation: request.generation,
      bodyNormalized: normalized.body,
      derivedTitleOverride: request.title,
    }
    this.upsertCurrentDocument(staged)

    return {
      commit: () => this.upsertCurrentDocument(staged),
      rollback: async () => this.removeDocument(generationId),
      quarantine: async () => this.removeDocument(generationId),
    }
  }

  async repair(input: SearchIndexRepairInput): Promise<void> {
    const source = this.readRepairSource(input.artifactId, input.generation)
    const normalized = await normalizeSearchIndexBody({
      body: source.text,
    })
    this.database.transaction(() => {
      this.upsertCurrentDocument({
        generationId: source.generationId,
        artifactId: source.artifactId,
        generation: source.generation,
        bodyNormalized: normalized.body,
      })
      this.visibility.clearQuarantineAfterRepair({
        artifactId: input.artifactId,
        generationId: source.generationId,
        now: input.now,
      })
      this.database
        .prepare(
          `DELETE FROM artifact_warning
           WHERE artifact_id = ? AND code = 'INDEX_REPAIR_PENDING'`,
        )
        .run(input.artifactId)
    })()
  }

  private readGenerationId(artifactId: number, generation: number): number {
    const generationId = this.database
      .prepare(
        `SELECT id FROM artifact_generation
         WHERE artifact_id = ? AND generation = ?`,
      )
      .pluck()
      .get(artifactId, generation)
    if (typeof generationId !== 'number') {
      throw new Error('The search generation does not exist.')
    }
    return generationId
  }

  private readRepairSource(
    artifactId: number,
    generation: number,
  ): {
    readonly generationId: number
    readonly artifactId: number
    readonly generation: number
    readonly text: string
  } {
    const row = this.database
      .prepare(
        `SELECT artifact_generation.id AS generation_id,
                artifact.id AS artifact_id,
                artifact_generation.generation,
                artifact_generation.extracted_text
         FROM artifact_generation
         JOIN artifact ON artifact.id = artifact_generation.artifact_id
         WHERE artifact.id = ?
           AND artifact_generation.generation = ?
           AND artifact.active_generation_id = artifact_generation.id
           AND artifact_generation.index_status = 'ready'`,
      )
      .get(artifactId, generation) as
      | {
          generation_id: number
          artifact_id: number
          generation: number
          extracted_text: string | null
        }
      | undefined
    if (!row || row.extracted_text === null) {
      throw new Error('Only an active, ready generation can be repaired.')
    }
    return {
      generationId: row.generation_id,
      artifactId: row.artifact_id,
      generation: row.generation,
      text: row.extracted_text,
    }
  }

  private readMetadata(artifactId: number): ArtifactIndexMetadata {
    const metadata = this.database
      .prepare('SELECT source_path, format, user_title, derived_title FROM artifact WHERE id = ?')
      .get(artifactId) as ArtifactIndexMetadata | undefined
    if (!metadata) throw new Error('The indexed artifact does not exist.')
    return metadata
  }

  private upsertCurrentDocument(source: PreparedGenerationIndex): void {
    const metadata = this.readMetadata(source.artifactId)
    const derivedTitle =
      source.derivedTitleOverride === undefined
        ? (metadata.derived_title ?? basename(metadata.source_path))
        : (source.derivedTitleOverride ?? basename(metadata.source_path))
    this.database
      .prepare(
        `INSERT INTO artifact_search_document (
           generation_id,
           artifact_id,
           generation,
           user_title_normalized,
           derived_title_normalized,
           body_normalized,
           path_segments_normalized,
           format_normalized
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(generation_id) DO UPDATE SET
           artifact_id = excluded.artifact_id,
           generation = excluded.generation,
           user_title_normalized = excluded.user_title_normalized,
           derived_title_normalized = excluded.derived_title_normalized,
           body_normalized = excluded.body_normalized,
           path_segments_normalized = excluded.path_segments_normalized,
           format_normalized = excluded.format_normalized`,
      )
      .run(
        source.generationId,
        source.artifactId,
        source.generation,
        normalizeSearchText(metadata.user_title ?? ''),
        normalizeSearchText(derivedTitle),
        source.bodyNormalized,
        normalizePathSegments(metadata.source_path),
        normalizeSearchText(metadata.format),
      )
  }

  private removeDocument(generationId: number): void {
    this.database
      .prepare('DELETE FROM artifact_search_document WHERE generation_id = ?')
      .run(generationId)
  }
}
