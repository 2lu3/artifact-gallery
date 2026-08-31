import { basename } from 'node:path'

import type Database from 'better-sqlite3'

import type {
  ArtifactIndexer,
  PreparedArtifactIndex,
} from '../processing/artifact-processor.js'
import { SearchVisibilityRepository } from '../repositories/search-visibility-repository.js'
import {
  normalizeSearchIndexFields,
  type NormalizedSearchIndexFields,
} from './search-index-normalizer.js'

export interface SearchIndexRepairInput {
  readonly artifactId: number
  readonly generation: number
  readonly now: string
}

interface IndexedGenerationSource {
  readonly generationId: number
  readonly artifactId: number
  readonly generation: number
  readonly sourcePath: string
  readonly userTitle: string | null
  readonly derivedTitle: string | null
  readonly text: string
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
    const titles = this.readTitles(request.artifactId)
    const derivedTitle =
      request.title === undefined
        ? (titles.derived_title ?? basename(request.sourcePath))
        : (request.title ?? basename(request.sourcePath))
    const normalized = await normalizeSearchIndexFields({
      sourcePath: request.sourcePath,
      userTitle: titles.user_title ?? '',
      derivedTitle,
      body: request.text,
      signal: request.signal,
    })
    const staged: IndexedGenerationSource & { normalized: NormalizedSearchIndexFields } = {
      generationId,
      artifactId: request.artifactId,
      generation: request.generation,
      sourcePath: request.sourcePath,
      userTitle: titles.user_title,
      derivedTitle,
      text: request.text,
      normalized,
    }
    this.upsertNormalizedDocument(staged)

    return {
      commit: () => this.upsertNormalizedDocument(staged),
      rollback: async () => this.removeDocument(generationId),
      quarantine: async () => this.removeDocument(generationId),
    }
  }

  async repair(input: SearchIndexRepairInput): Promise<void> {
    const source = this.readRepairSource(input.artifactId, input.generation)
    const normalized = await normalizeSearchIndexFields({
      sourcePath: source.sourcePath,
      userTitle: source.userTitle ?? '',
      derivedTitle: source.derivedTitle ?? '',
      body: source.text,
    })
    this.database.transaction(() => {
      this.upsertNormalizedDocument({ ...source, normalized })
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

  private readRepairSource(artifactId: number, generation: number): IndexedGenerationSource {
    const row = this.database
      .prepare(
        `SELECT artifact_generation.id AS generation_id,
                artifact.id AS artifact_id,
                artifact_generation.generation,
                artifact.source_path,
                artifact.user_title,
                artifact.derived_title,
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
          source_path: string
          user_title: string | null
          derived_title: string | null
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
      sourcePath: row.source_path,
      userTitle: row.user_title,
      derivedTitle: row.derived_title,
      text: row.extracted_text,
    }
  }

  private readTitles(artifactId: number): {
    user_title: string | null
    derived_title: string | null
  } {
    const titles = this.database
      .prepare('SELECT user_title, derived_title FROM artifact WHERE id = ?')
      .get(artifactId) as
      | { user_title: string | null; derived_title: string | null }
      | undefined
    if (!titles) throw new Error('The indexed artifact does not exist.')
    return titles
  }

  private upsertNormalizedDocument(
    source: IndexedGenerationSource & { readonly normalized: NormalizedSearchIndexFields },
  ): void {
    this.database
      .prepare(
        `INSERT INTO artifact_search_document (
           generation_id,
           artifact_id,
           generation,
           user_title_normalized,
           derived_title_normalized,
           body_normalized,
           path_segments_normalized
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(generation_id) DO UPDATE SET
           artifact_id = excluded.artifact_id,
           generation = excluded.generation,
           user_title_normalized = excluded.user_title_normalized,
           derived_title_normalized = excluded.derived_title_normalized,
           body_normalized = excluded.body_normalized,
           path_segments_normalized = excluded.path_segments_normalized`,
      )
      .run(
        source.generationId,
        source.artifactId,
        source.generation,
        source.normalized.userTitle,
        source.normalized.derivedTitle,
        source.normalized.body,
        source.normalized.pathSegments,
      )
  }

  private removeDocument(generationId: number): void {
    this.database
      .prepare('DELETE FROM artifact_search_document WHERE generation_id = ?')
      .run(generationId)
  }
}
