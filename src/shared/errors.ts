export const ARTIFACT_ERROR_CODES = [
  'SOURCE_MISSING',
  'OUTSIDE_ALLOWED_ROOT',
  'SYMLINK_REJECTED',
  'UNSUPPORTED_FORMAT',
  'UNREADABLE_SOURCE',
  'CANCELLED',
  'INTERRUPTED',
  'STALE_GENERATION',
  'TIMEOUT',
  'INPUT_TOO_LARGE',
  'MARKDOWN_PARSE_FAILED',
  'HTML_RENDER_FAILED',
  'ASSET_BLOCKED',
  'ASSET_TOO_LARGE',
  'DERIVED_WRITE_FAILED',
  'DATABASE_BUSY',
  'INDEX_UPDATE_FAILED',
  'CURSOR_STALE',
  'UNKNOWN',
] as const

export type ArtifactErrorCode = (typeof ARTIFACT_ERROR_CODES)[number]
export type ProcessingStage = 'inspect' | 'extract' | 'render' | 'index' | 'commit'

interface ErrorDefinition {
  readonly retryable: boolean
  readonly userMessage: string
}

const ERROR_DEFINITIONS: Readonly<Record<ArtifactErrorCode, ErrorDefinition>> = {
  SOURCE_MISSING: { retryable: true, userMessage: 'The source file could not be found.' },
  OUTSIDE_ALLOWED_ROOT: {
    retryable: false,
    userMessage: 'The source is outside an allowed root.',
  },
  SYMLINK_REJECTED: { retryable: false, userMessage: 'Symbolic links are not allowed.' },
  UNSUPPORTED_FORMAT: { retryable: false, userMessage: 'This file format is not supported.' },
  UNREADABLE_SOURCE: { retryable: true, userMessage: 'The source file could not be read.' },
  CANCELLED: { retryable: true, userMessage: 'Processing was cancelled.' },
  INTERRUPTED: { retryable: true, userMessage: 'Processing was interrupted.' },
  STALE_GENERATION: {
    retryable: true,
    userMessage: 'A newer version replaced this processing attempt.',
  },
  TIMEOUT: { retryable: true, userMessage: 'Processing took too long.' },
  INPUT_TOO_LARGE: { retryable: false, userMessage: 'The source file is too large.' },
  MARKDOWN_PARSE_FAILED: { retryable: false, userMessage: 'The Markdown could not be read.' },
  HTML_RENDER_FAILED: { retryable: true, userMessage: 'The preview could not be rendered.' },
  ASSET_BLOCKED: { retryable: false, userMessage: 'An unsafe asset was blocked.' },
  ASSET_TOO_LARGE: { retryable: false, userMessage: 'A preview asset is too large.' },
  DERIVED_WRITE_FAILED: {
    retryable: true,
    userMessage: 'The generated preview could not be saved.',
  },
  DATABASE_BUSY: { retryable: true, userMessage: 'The gallery is temporarily busy.' },
  INDEX_UPDATE_FAILED: { retryable: true, userMessage: 'Search indexing could not be updated.' },
  CURSOR_STALE: { retryable: true, userMessage: 'The requested result page is out of date.' },
  UNKNOWN: { retryable: false, userMessage: 'Processing failed unexpectedly.' },
}

const ARTIFACT_ERROR_CODE_SET = new Set<string>(ARTIFACT_ERROR_CODES)

export class ArtifactProcessingError extends Error {
  readonly retryable: boolean
  readonly userMessage: string

  constructor(
    readonly code: ArtifactErrorCode,
    readonly stage: ProcessingStage,
    readonly technicalDetail: string | null = null,
    options?: ErrorOptions,
  ) {
    super(ERROR_DEFINITIONS[code].userMessage, options)
    this.name = 'ArtifactProcessingError'
    this.retryable = ERROR_DEFINITIONS[code].retryable
    this.userMessage = ERROR_DEFINITIONS[code].userMessage
  }
}

export interface PublicProcessingError {
  readonly code: ArtifactErrorCode
  readonly stage: ProcessingStage
  readonly retryable: boolean
  readonly message: string
}

export function mapProcessingError(
  error: unknown,
  stage: ProcessingStage,
  fallbackCode: ArtifactErrorCode = 'UNKNOWN',
): ArtifactProcessingError {
  if (error instanceof ArtifactProcessingError) return error

  const boundaryCode = readErrorCode(error)
  const code =
    boundaryCode === 'SQLITE_BUSY' || boundaryCode === 'SQLITE_BUSY_TIMEOUT'
      ? 'DATABASE_BUSY'
      : boundaryCode && ARTIFACT_ERROR_CODE_SET.has(boundaryCode)
        ? (boundaryCode as ArtifactErrorCode)
        : fallbackCode

  return new ArtifactProcessingError(code, stage, technicalDetail(error), { cause: error })
}

export function toPublicProcessingError(error: ArtifactProcessingError): PublicProcessingError {
  return {
    code: error.code,
    stage: error.stage,
    retryable: error.retryable,
    message: error.userMessage,
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function technicalDetail(error: unknown): string | null {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return null
}
