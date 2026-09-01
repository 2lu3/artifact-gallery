import type Database from 'better-sqlite3'

export type SearchVisibilityState = 'staged' | 'visible' | 'quarantined'

export interface GenerationSearchCandidate {
  readonly artifactId: number
  readonly generation: number
}

export interface SearchVisibilityTransitionInput {
  readonly artifactId: number
  readonly generationId: number
  readonly now: string
}

export class SearchVisibilityTransitionError extends Error {
  constructor(operation: 'quarantine' | 'repair') {
    super(`Search visibility could not complete the ${operation} transition.`)
    this.name = 'SearchVisibilityTransitionError'
  }
}

/**
 * SQLite is the visibility authority for candidates returned by any search index.
 * Task 6 search readers must pass every external candidate through this repository.
 */
export class SearchVisibilityRepository {
  constructor(private readonly database: Database.Database) {}

  filterVisibleCandidates<T extends GenerationSearchCandidate>(candidates: readonly T[]): T[] {
    const isVisible = this.database.prepare(
      `SELECT 1
       FROM artifact
       JOIN artifact_generation
         ON artifact_generation.id = artifact.active_generation_id
        AND artifact_generation.artifact_id = artifact.id
       JOIN artifact_search_visibility
         ON artifact_search_visibility.artifact_id = artifact.id
        AND artifact_search_visibility.generation_id = artifact_generation.id
       WHERE artifact.id = ?
         AND artifact_generation.generation = ?
         AND artifact_generation.index_status = 'ready'
         AND artifact_search_visibility.state = 'visible'`,
    )
    return candidates.filter((candidate) =>
      Boolean(isVisible.get(candidate.artifactId, candidate.generation)),
    )
  }

  quarantineGeneration(input: SearchVisibilityTransitionInput): void {
    const result = this.database
      .prepare(
        `UPDATE artifact_search_visibility
         SET state = 'quarantined', updated_at = ?
         WHERE artifact_id = ? AND generation_id = ?`,
      )
      .run(input.now, input.artifactId, input.generationId)
    if (result.changes !== 1) throw new SearchVisibilityTransitionError('quarantine')
  }

  clearQuarantineAfterRepair(input: SearchVisibilityTransitionInput): void {
    const result = this.database
      .prepare(
        `UPDATE artifact_search_visibility
         SET state = CASE WHEN EXISTS (
           SELECT 1
           FROM artifact
           JOIN artifact_generation
             ON artifact_generation.id = artifact.active_generation_id
            AND artifact_generation.artifact_id = artifact.id
           WHERE artifact.id = ?
             AND artifact_generation.id = ?
             AND artifact_generation.index_status = 'ready'
         ) THEN 'visible' ELSE 'staged' END,
         updated_at = ?
         WHERE artifact_id = ? AND generation_id = ? AND state = 'quarantined'`,
      )
      .run(input.artifactId, input.generationId, input.now, input.artifactId, input.generationId)
    if (result.changes !== 1) throw new SearchVisibilityTransitionError('repair')
  }
}
