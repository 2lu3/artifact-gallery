import { createHmac, timingSafeEqual } from 'node:crypto'

interface ThumbnailResource {
  readonly version: 1
  readonly artifactId: number
  readonly generationId: number
}

export class InvalidResourceTokenError extends Error {
  constructor() {
    super('Invalid resource token.')
    this.name = 'InvalidResourceTokenError'
  }
}

export class ThumbnailResourceCodec {
  constructor(private readonly secret: Buffer) {}

  encode(artifactId: number, generationId: number): string {
    const payload = Buffer.alloc(17)
    payload.writeUInt8(1, 0)
    payload.writeBigUInt64BE(BigInt(artifactId), 1)
    payload.writeBigUInt64BE(BigInt(generationId), 9)
    const body = payload.toString('base64url')
    return `${body}.${this.sign(body)}`
  }

  decode(token: string): ThumbnailResource {
    const [body, signature, extra] = token.split('.')
    if (!body || !signature || extra !== undefined || !this.matches(body, signature)) {
      throw new InvalidResourceTokenError()
    }
    try {
      const payload = Buffer.from(body, 'base64url')
      if (payload.byteLength !== 17 || payload.readUInt8(0) !== 1) {
        throw new InvalidResourceTokenError()
      }
      const artifactId = Number(payload.readBigUInt64BE(1))
      const generationId = Number(payload.readBigUInt64BE(9))
      const value = { version: 1, artifactId, generationId } as const
      if (!isThumbnailResource(value)) throw new InvalidResourceTokenError()
      return value
    } catch (error) {
      if (error instanceof InvalidResourceTokenError) throw error
      throw new InvalidResourceTokenError()
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret)
      .update(body)
      .digest()
      .subarray(0, 16)
      .toString('base64url')
  }

  private matches(body: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(body))
    const received = Buffer.from(signature)
    return expected.byteLength === received.byteLength && timingSafeEqual(expected, received)
  }
}

function isThumbnailResource(value: unknown): value is ThumbnailResource {
  if (typeof value !== 'object' || value === null) return false
  const resource = value as Record<string, unknown>
  return (
    resource.version === 1 &&
    typeof resource.artifactId === 'number' &&
    Number.isSafeInteger(resource.artifactId) &&
    resource.artifactId > 0 &&
    typeof resource.generationId === 'number' &&
    Number.isSafeInteger(resource.generationId) &&
    resource.generationId > 0
  )
}
