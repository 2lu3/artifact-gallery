import { basename } from 'node:path'

import type Database from 'better-sqlite3'

import {
  SearchVisibilityRepository,
  type GenerationSearchCandidate,
} from '../repositories/search-visibility-repository.js'
import {
  buildFts5Query,
  normalizeSearchNeedle,
  searchableCharacterCount,
} from './search-query.js'

const DEFAULT_LIMIT = 5
const MAX_RESULT_LIMIT = 200
const SHORT_SCAN_LIMIT = 100
const EXTERNAL_CANDIDATE_LIMIT = 500

export interface SearchOptions {
  readonly limit?: number
}

export interface SearchResult {
  readonly artifactId: number
  readonly generation: number
  readonly title: string
  readonly sourcePath: string
}

interface SearchCandidate extends GenerationSearchCandidate {
  readonly userTitle: string | null
  readonly derivedTitle: string | null
  readonly sourcePath: string
}

interface SearchCandidateRow {
  artifact_id: number
  generation: number
  user_title: string | null
  derived_title: string | null
  source_path: string
}

export class SearchRepository {
  private readonly visibility: SearchVisibilityRepository

  constructor(private readonly database: Database.Database) {
    this.visibility = new SearchVisibilityRepository(database)
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = normalizeLimit(options.limit)
    const characterCount = searchableCharacterCount(query)
    let candidates: SearchCandidate[]

    if (characterCount === 0) {
      candidates = this.readNewestCandidates()
    } else if (characterCount <= 2) {
      candidates = this.readShortQueryCandidates(normalizeSearchNeedle(query))
    } else {
      candidates = this.readFtsCandidates(buildFts5Query(query) as string)
    }

    return this.visibility
      .filterVisibleCandidates(candidates)
      .slice(0, limit)
      .map((candidate) => ({
        artifactId: candidate.artifactId,
        generation: candidate.generation,
        title:
          candidate.userTitle ??
          candidate.derivedTitle ??
          basename(candidate.sourcePath),
        sourcePath: candidate.sourcePath,
      }))
  }

  private readFtsCandidates(expression: string): SearchCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT CAST(artifact_search_fts.artifact_id AS INTEGER) AS artifact_id,
                CAST(artifact_search_fts.generation AS INTEGER) AS generation,
                artifact.user_title,
                artifact.derived_title,
                artifact.source_path
         FROM artifact_search_fts
         JOIN artifact
           ON artifact.id = CAST(artifact_search_fts.artifact_id AS INTEGER)
         WHERE artifact_search_fts MATCH ?
         ORDER BY bm25(artifact_search_fts, 0.0, 0.0, 16.0, 8.0, 2.0, 1.0),
                  artifact.registered_at DESC,
                  artifact.id DESC
         LIMIT ?`,
      )
      .all(expression, EXTERNAL_CANDIDATE_LIMIT) as SearchCandidateRow[]
    return rows.map(toCandidate)
  }

  private readShortQueryCandidates(needle: string): SearchCandidate[] {
    const rows = this.database
      .prepare(
        `WITH recent AS (
           SELECT artifact_search_document.artifact_id,
                  artifact_search_document.generation,
                  artifact_search_document.user_title_normalized,
                  artifact_search_document.derived_title_normalized,
                  artifact_search_document.body_normalized,
                  artifact.user_title,
                  artifact.derived_title,
                  artifact.source_path,
                  artifact.registered_at
           FROM artifact_search_document
           JOIN artifact
             ON artifact.id = artifact_search_document.artifact_id
            AND artifact.active_generation_id = artifact_search_document.generation_id
           ORDER BY artifact.registered_at DESC, artifact.id DESC
           LIMIT ${SHORT_SCAN_LIMIT}
         )
         SELECT artifact_id, generation, user_title, derived_title, source_path
         FROM recent
         WHERE instr(user_title_normalized, ?) > 0
            OR instr(derived_title_normalized, ?) > 0
            OR instr(body_normalized, ?) > 0
         ORDER BY CASE
                    WHEN instr(user_title_normalized, ?) > 0 THEN 0
                    WHEN instr(derived_title_normalized, ?) > 0 THEN 1
                    ELSE 2
                  END,
                  registered_at DESC,
                  artifact_id DESC`,
      )
      .all(needle, needle, needle, needle, needle) as SearchCandidateRow[]
    return rows.map(toCandidate)
  }

  private readNewestCandidates(): SearchCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT artifact_search_document.artifact_id,
                artifact_search_document.generation,
                artifact.user_title,
                artifact.derived_title,
                artifact.source_path
         FROM artifact_search_document
         JOIN artifact
           ON artifact.id = artifact_search_document.artifact_id
          AND artifact.active_generation_id = artifact_search_document.generation_id
         ORDER BY artifact.registered_at DESC, artifact.id DESC
         LIMIT ?`,
      )
      .all(EXTERNAL_CANDIDATE_LIMIT) as SearchCandidateRow[]
    return rows.map(toCandidate)
  }
}

function toCandidate(row: SearchCandidateRow): SearchCandidate {
  return {
    artifactId: row.artifact_id,
    generation: row.generation,
    userTitle: row.user_title,
    derivedTitle: row.derived_title,
    sourcePath: row.source_path,
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.floor(limit)))
}
