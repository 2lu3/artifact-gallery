import { basename } from 'node:path'

import type Database from 'better-sqlite3'

import {
  SearchVisibilityRepository,
  type GenerationSearchCandidate,
} from '../repositories/search-visibility-repository.js'
import {
  buildFts5Query,
  parseSearchQuery,
  searchableCharacterCount,
  type SearchQueryPart,
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

interface ShortCandidateRow extends SearchCandidateRow {
  user_title_normalized: string
  derived_title_normalized: string
  body_normalized: string
  registered_at: string
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
      candidates = this.readShortQueryCandidates(parseSearchQuery(query))
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
         JOIN artifact_generation
           ON artifact_generation.id = artifact.active_generation_id
          AND artifact_generation.artifact_id = artifact.id
          AND artifact_generation.generation = CAST(artifact_search_fts.generation AS INTEGER)
          AND artifact_generation.index_status = 'ready'
         JOIN artifact_search_visibility
           ON artifact_search_visibility.artifact_id = artifact.id
          AND artifact_search_visibility.generation_id = artifact_generation.id
          AND artifact_search_visibility.state = 'visible'
         WHERE artifact_search_fts MATCH ?
         ORDER BY bm25(artifact_search_fts, 0.0, 0.0, 16.0, 8.0, 2.0, 1.0),
                  artifact.registered_at DESC,
                  artifact.id DESC
         LIMIT ?`,
      )
      .all(expression, EXTERNAL_CANDIDATE_LIMIT) as SearchCandidateRow[]
    return rows.map(toCandidate)
  }

  private readShortQueryCandidates(parts: readonly SearchQueryPart[]): SearchCandidate[] {
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
           JOIN artifact_generation
             ON artifact_generation.id = artifact.active_generation_id
            AND artifact_generation.artifact_id = artifact.id
            AND artifact_generation.generation = artifact_search_document.generation
            AND artifact_generation.index_status = 'ready'
           JOIN artifact_search_visibility
             ON artifact_search_visibility.artifact_id = artifact.id
            AND artifact_search_visibility.generation_id = artifact_generation.id
            AND artifact_search_visibility.state = 'visible'
           ORDER BY artifact.registered_at DESC, artifact.id DESC
           LIMIT ${SHORT_SCAN_LIMIT}
         )
         SELECT artifact_id,
                generation,
                user_title,
                derived_title,
                source_path,
                user_title_normalized,
                derived_title_normalized,
                body_normalized,
                registered_at
         FROM recent
         ORDER BY registered_at DESC, artifact_id DESC`,
      )
      .all() as ShortCandidateRow[]
    return rows
      .map((row) => ({ row, rank: shortCandidateRank(row, parts) }))
      .filter(
        (candidate): candidate is { row: ShortCandidateRow; rank: ShortCandidateRank } =>
          candidate.rank !== null,
      )
      .toSorted(compareShortCandidates)
      .map(({ row }) => toCandidate(row))
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
         JOIN artifact_generation
           ON artifact_generation.id = artifact.active_generation_id
          AND artifact_generation.artifact_id = artifact.id
          AND artifact_generation.generation = artifact_search_document.generation
          AND artifact_generation.index_status = 'ready'
         JOIN artifact_search_visibility
           ON artifact_search_visibility.artifact_id = artifact.id
          AND artifact_search_visibility.generation_id = artifact_generation.id
          AND artifact_search_visibility.state = 'visible'
         ORDER BY artifact.registered_at DESC, artifact.id DESC
         LIMIT ?`,
      )
      .all(EXTERNAL_CANDIDATE_LIMIT) as SearchCandidateRow[]
    return rows.map(toCandidate)
  }
}

type ShortCandidateRank = readonly [userTitle: number, derivedTitle: number, body: number]

function shortCandidateRank(
  row: ShortCandidateRow,
  parts: readonly SearchQueryPart[],
): ShortCandidateRank | null {
  const counts = [0, 0, 0] as [number, number, number]
  const fields = [
    row.user_title_normalized,
    row.derived_title_normalized,
    row.body_normalized,
  ]
  for (const part of parts) {
    const fieldIndex = fields.findIndex((field) => field.includes(part.value))
    if (fieldIndex === -1) return null
    counts[fieldIndex] += 1
  }
  return counts
}

function compareShortCandidates(
  left: { row: ShortCandidateRow; rank: ShortCandidateRank },
  right: { row: ShortCandidateRow; rank: ShortCandidateRank },
): number {
  for (let field = 0; field < left.rank.length; field += 1) {
    const difference = (right.rank[field] as number) - (left.rank[field] as number)
    if (difference !== 0) return difference
  }
  return (
    right.row.registered_at.localeCompare(left.row.registered_at) ||
    right.row.artifact_id - left.row.artifact_id
  )
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
