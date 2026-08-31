import type { ArtifactFormat, CardPresentation } from '../server/repositories/artifact-repository.js'
import type { PublicProcessingError } from './errors.js'

/** Sent by the trusted bootstrap document on every local API request. */
export const SESSION_TOKEN_HEADER = 'x-artifact-gallery-token'
export const GALLERY_PAGE_SIZE = 30

export type GallerySortMode = 'newest' | 'title'
export type GalleryFilter = 'all' | ArtifactFormat
export type GalleryStatusFilter = 'all' | CardPresentation

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'UNTRUSTED_HOST'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'CURSOR_STALE'
  | 'UNSUPPORTED_PLATFORM'
  | PublicProcessingError['code']

export interface ApiError {
  readonly code: ApiErrorCode
  readonly stage: PublicProcessingError['stage'] | 'request' | 'catalog'
  readonly retryable: boolean
  readonly message: string
}

export interface ApiErrorResponse {
  readonly error: ApiError
}

export interface ArtifactCard {
  readonly id: number
  readonly title: string
  readonly sourcePath: string
  readonly format: ArtifactFormat
  readonly registeredAt: string
  readonly status: CardPresentation
  readonly thumbnailUrl: string | null
  readonly diagram: string
}

export interface GalleryPage {
  readonly items: readonly ArtifactCard[]
  readonly nextCursor: string | null
}

export interface ArtifactDetail extends ArtifactCard {
  readonly generation: number
  readonly errors: readonly PublicProcessingError[]
}

export interface RegistrationResponse {
  readonly runId: number
}

export interface PlatformActionResult {
  readonly supported: true
}
