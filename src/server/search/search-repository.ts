import { basename } from 'node:path'

import type Database from 'better-sqlite3'

import type { ArtifactFormat } from '../repositories/artifact-repository.js'
import {
  SearchVisibilityRepository,
  type GenerationSearchCandidate,
} from '../repositories/search-visibility-repository.js'
import { parseSearchQuery, type SearchQueryPart } from './search-query.js'

const DEFAULT_LIMIT = 5
const SHORT_SCAN_LIMIT = 100
const EMPTY_QUERY_LIMIT = 500
const SNIPPET_CODE_POINT_LIMIT = 160

export interface SearchOptions {
  readonly limit?: number
}

export type SearchMatchReason = 'title' | 'body' | 'path' | 'format'

export interface SearchResult {
  readonly artifactId: number
  readonly generation: number
  readonly title: string
  readonly sourcePath: string
  readonly format: ArtifactFormat
  readonly matchReason: SearchMatchReason
  readonly snippet: string
  /** Opaque, stable ordering key for relevance-specific cursor pagination. */
  readonly relevanceKey: string
}

interface SearchCandidate extends GenerationSearchCandidate {
  readonly userTitle: string | null
  readonly derivedTitle: string | null
  readonly sourcePath: string
  readonly format: ArtifactFormat
  readonly registeredAt: string
  readonly normalizedFields: readonly [
    userTitle: string,
    derivedTitle: string,
    body: string,
    path: string,
    format: string,
  ]
}

interface SearchCandidateRow {
  artifact_id: number
  generation: number
  user_title: string | null
  derived_title: string | null
  source_path: string
  format: ArtifactFormat
  registered_at: string
  user_title_normalized: string
  derived_title_normalized: string
  body_normalized: string
  path_segments_normalized: string
  format_normalized: string
}

type CandidateRank = readonly [
  userTitle: number,
  derivedTitle: number,
  body: number,
  path: number,
  format: number,
]

export class SearchRepository {
  private readonly visibility: SearchVisibilityRepository

  constructor(private readonly database: Database.Database) {
    this.visibility = new SearchVisibilityRepository(database)
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = normalizeLimit(options.limit)
    const parts = parseSearchQuery(query)
    let candidates: SearchCandidate[]

    if (parts.length === 0) {
      candidates = this.readNewestCandidates()
    } else {
      const ftsParts = parts.filter(isFtsSearchable)
      candidates =
        ftsParts.length === 0
          ? this.readShortQueryCandidates()
          : this.readFtsCandidates(buildFtsExpression(ftsParts))
      candidates = candidates.filter((candidate) => candidateRank(candidate, parts) !== null)
      if (ftsParts.length === 0) {
        candidates = candidates.toSorted((left, right) => compareCandidates(left, right, parts))
      }
    }

    const visible = this.visibility.filterVisibleCandidates(candidates)
    return visible.slice(0, limit).map((candidate, index) => {
      const rank = candidateRank(candidate, parts)
      const reason = rank ? reasonForRank(rank) : 'title'
      return {
        artifactId: candidate.artifactId,
        generation: candidate.generation,
        title: candidate.userTitle ?? candidate.derivedTitle ?? basename(candidate.sourcePath),
        sourcePath: candidate.sourcePath,
        format: candidate.format,
        matchReason: reason,
        snippet: snippetFor(candidate, reason, parts),
        relevanceKey: `${String(index).padStart(12, '0')}:${candidate.artifactId}`,
      }
    })
  }

  private readFtsCandidates(expression: string): SearchCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT artifact_search_document.artifact_id,
                artifact_search_document.generation,
                artifact.user_title,
                artifact.derived_title,
                artifact.source_path,
                artifact.format,
                artifact.registered_at,
                artifact_search_document.user_title_normalized,
                artifact_search_document.derived_title_normalized,
                artifact_search_document.body_normalized,
                artifact_search_document.path_segments_normalized,
                artifact_search_document.format_normalized
         FROM artifact_search_fts
         JOIN artifact_search_document
           ON artifact_search_document.generation_id = artifact_search_fts.rowid
         JOIN artifact
           ON artifact.id = artifact_search_document.artifact_id
         JOIN artifact_generation
           ON artifact_generation.id = artifact.active_generation_id
          AND artifact_generation.artifact_id = artifact.id
          AND artifact_generation.generation = artifact_search_document.generation
          AND artifact_generation.index_status = 'ready'
         JOIN artifact_search_visibility
           ON artifact_search_visibility.artifact_id = artifact.id
          AND artifact_search_visibility.generation_id = artifact_generation.id
          AND artifact_search_visibility.state = 'visible'
         WHERE artifact_search_fts MATCH ?
         ORDER BY bm25(artifact_search_fts, 0.0, 0.0, 16.0, 8.0, 2.0, 1.0, 4.0),
                  artifact.registered_at DESC,
                  artifact.id DESC`,
      )
      .all(expression) as SearchCandidateRow[]
    return rows.map(toCandidate)
  }

  private readShortQueryCandidates(): SearchCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT artifact_search_document.artifact_id,
                artifact_search_document.generation,
                artifact.user_title,
                artifact.derived_title,
                artifact.source_path,
                artifact.format,
                artifact.registered_at,
                artifact_search_document.user_title_normalized,
                artifact_search_document.derived_title_normalized,
                artifact_search_document.body_normalized,
                artifact_search_document.path_segments_normalized,
                artifact_search_document.format_normalized
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
      .all(SHORT_SCAN_LIMIT) as SearchCandidateRow[]
    return rows.map(toCandidate)
  }

  private readNewestCandidates(): SearchCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT artifact_search_document.artifact_id,
                artifact_search_document.generation,
                artifact.user_title,
                artifact.derived_title,
                artifact.source_path,
                artifact.format,
                artifact.registered_at,
                artifact_search_document.user_title_normalized,
                artifact_search_document.derived_title_normalized,
                artifact_search_document.body_normalized,
                artifact_search_document.path_segments_normalized,
                artifact_search_document.format_normalized
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
      .all(EMPTY_QUERY_LIMIT) as SearchCandidateRow[]
    return rows.map(toCandidate)
  }
}

function isFtsSearchable(part: SearchQueryPart): boolean {
  return Array.from(part.value.replace(/\s+/gu, '')).length >= 3
}

function buildFtsExpression(parts: readonly SearchQueryPart[]): string {
  return parts.map(({ value }) => `"${value.replaceAll('"', '""')}"`).join(' AND ')
}

function candidateRank(
  candidate: SearchCandidate,
  parts: readonly SearchQueryPart[],
): CandidateRank | null {
  const counts = [0, 0, 0, 0, 0] as [number, number, number, number, number]
  for (const part of parts) {
    const searchableFields = isFtsSearchable(part)
      ? candidate.normalizedFields
      : candidate.normalizedFields.slice(0, 3)
    const fieldIndex = searchableFields.findIndex((field, index) =>
      index === 4 ? field === part.value : field.includes(part.value),
    )
    if (fieldIndex === -1) return null
    counts[fieldIndex] += 1
  }
  return counts
}

function compareCandidates(
  left: SearchCandidate,
  right: SearchCandidate,
  parts: readonly SearchQueryPart[],
): number {
  const leftRank = candidateRank(left, parts) as CandidateRank
  const rightRank = candidateRank(right, parts) as CandidateRank
  for (let field = 0; field < leftRank.length; field += 1) {
    const difference = (rightRank[field] as number) - (leftRank[field] as number)
    if (difference !== 0) return difference
  }
  return right.registeredAt.localeCompare(left.registeredAt) || right.artifactId - left.artifactId
}

function reasonForRank(rank: CandidateRank): SearchMatchReason {
  if (rank[0] > 0 || rank[1] > 0) return 'title'
  if (rank[2] > 0) return 'body'
  if (rank[3] > 0) return 'path'
  return 'format'
}

function snippetFor(
  candidate: SearchCandidate,
  reason: SearchMatchReason,
  parts: readonly SearchQueryPart[],
): string {
  const field =
    reason === 'title'
      ? candidate.normalizedFields[0] || candidate.normalizedFields[1]
      : reason === 'body'
        ? candidate.normalizedFields[2]
        : reason === 'path'
          ? candidate.normalizedFields[3]
          : candidate.normalizedFields[4]
  const compact = field.replace(/\s+/gu, ' ').trim()
  const firstMatch = parts
    .map(({ value }) => compact.indexOf(value))
    .filter((index) => index >= 0)
    .toSorted((left, right) => left - right)[0]
  const points = Array.from(compact)
  if (points.length <= SNIPPET_CODE_POINT_LIMIT) return compact
  const matchOffset = firstMatch === undefined ? 0 : Array.from(compact.slice(0, firstMatch)).length
  const start = Math.max(0, matchOffset - Math.floor(SNIPPET_CODE_POINT_LIMIT / 3))
  const end = Math.min(points.length, start + SNIPPET_CODE_POINT_LIMIT)
  return `${start > 0 ? '…' : ''}${points.slice(start, end).join('')}${end < points.length ? '…' : ''}`
}

function toCandidate(row: SearchCandidateRow): SearchCandidate {
  return {
    artifactId: row.artifact_id,
    generation: row.generation,
    userTitle: row.user_title,
    derivedTitle: row.derived_title,
    sourcePath: row.source_path,
    format: row.format,
    registeredAt: row.registered_at,
    normalizedFields: [
      row.user_title_normalized,
      row.derived_title_normalized,
      row.body_normalized,
      row.path_segments_normalized,
      row.format_normalized,
    ],
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.floor(limit))
}
