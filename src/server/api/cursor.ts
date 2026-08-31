import { createHmac, timingSafeEqual } from 'node:crypto'

import type { GalleryFilter, GallerySortMode, GalleryStatusFilter } from '../../shared/contracts.js'

export interface CursorContext {
  readonly sort: GallerySortMode
  readonly filter: GalleryFilter
  readonly status: GalleryStatusFilter
  readonly queryFingerprint: string
  readonly catalogRevision: string
  readonly searchRevision: string
}

export interface CursorPayload extends CursorContext {
  readonly version: 1
  readonly lastSortKey: string
  readonly lastId: number
}

export class StaleCursorError extends Error {
  constructor() {
    super('The cursor is invalid or no longer matches the requested result set.')
    this.name = 'StaleCursorError'
  }
}

export class CursorCodec {
  constructor(private readonly secret: Buffer) {}

  encode(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${body}.${this.sign(body)}`
  }

  decode(cursor: string, expected: CursorContext): CursorPayload {
    const [body, signature, extra] = cursor.split('.')
    if (!body || !signature || extra !== undefined || !this.signatureMatches(body, signature)) {
      throw new StaleCursorError()
    }
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown
      if (!isCursorPayload(parsed) || !sameContext(parsed, expected)) {
        throw new StaleCursorError()
      }
      return parsed
    } catch (error) {
      if (error instanceof StaleCursorError) throw error
      throw new StaleCursorError()
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url')
  }

  private signatureMatches(body: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(body))
    const received = Buffer.from(signature)
    return expected.byteLength === received.byteLength && timingSafeEqual(expected, received)
  }
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.version === 1 &&
    typeof candidate.lastSortKey === 'string' &&
    typeof candidate.lastId === 'number' &&
    Number.isSafeInteger(candidate.lastId) &&
    (candidate.sort === 'newest' || candidate.sort === 'title') &&
    (candidate.filter === 'all' ||
      candidate.filter === 'html' ||
      candidate.filter === 'markdown') &&
    (candidate.status === 'all' ||
      candidate.status === 'missing' ||
      candidate.status === 'processing' ||
      candidate.status === 'ready' ||
      candidate.status === 'partial' ||
      candidate.status === 'failed') &&
    typeof candidate.queryFingerprint === 'string' &&
    typeof candidate.catalogRevision === 'string' &&
    typeof candidate.searchRevision === 'string'
  )
}

function sameContext(payload: CursorPayload, expected: CursorContext): boolean {
  return (
    payload.sort === expected.sort &&
    payload.filter === expected.filter &&
    payload.status === expected.status &&
    payload.queryFingerprint === expected.queryFingerprint &&
    payload.catalogRevision === expected.catalogRevision &&
    payload.searchRevision === expected.searchRevision
  )
}
