import { describe, expect, it } from 'vitest'

import {
  MAX_OPTIMIZER_INPUT_BYTES,
  MAX_THUMBNAIL_BYTES,
  WebpThumbnailOptimizer,
  type WebpEncoder,
} from './thumbnail-optimizer.js'

describe('WebpThumbnailOptimizer', () => {
  it('rejects an image beyond the bounded Chromium screenshot envelope before encoding', async () => {
    let encoded = false
    const optimizer = new WebpThumbnailOptimizer({
      encode: async () => {
        encoded = true
        return Buffer.alloc(1)
      },
    })

    await expect(
      optimizer.optimize({
        bytes: Buffer.alloc(MAX_OPTIMIZER_INPUT_BYTES + 1),
        width: 1200,
        height: 2400,
      }),
    ).rejects.toMatchObject({ code: 'DERIVED_WRITE_FAILED' })
    expect(encoded).toBe(false)
  })

  it('keeps an already bounded WebP without re-encoding it', async () => {
    const source = Buffer.alloc(100_000, 0x61)
    const optimizer = new WebpThumbnailOptimizer({
      encode: async () => {
        throw new Error('bounded images must not be re-encoded')
      },
    })

    const result = await optimizer.optimize({ bytes: source, width: 1200, height: 800 })

    expect(result).toEqual({ bytes: source, width: 1200, height: 800, quality: 80 })
  })

  it('reduces quality before dimensions and returns no more than 500KB', async () => {
    const encoder: WebpEncoder = {
      encode: async ({ width, height, quality }) => {
        const size = Math.ceil(width * height * (quality / 100))
        return Buffer.alloc(size, 0x62)
      },
    }
    const optimizer = new WebpThumbnailOptimizer(encoder)

    const result = await optimizer.optimize({
      bytes: Buffer.alloc(MAX_THUMBNAIL_BYTES + 1),
      width: 1200,
      height: 1200,
    })

    expect(result.bytes.byteLength).toBeLessThanOrEqual(MAX_THUMBNAIL_BYTES)
    expect(result).toMatchObject({ width: 1020, height: 1020, quality: 45 })
  })

  it('continues shrinking dimensions for high-entropy previews while retaining an identifiable size', async () => {
    const optimizer = new WebpThumbnailOptimizer({
      encode: async ({ width, height }) => Buffer.alloc(Math.ceil(width * height)),
    })

    const result = await optimizer.optimize({
      bytes: Buffer.alloc(MAX_THUMBNAIL_BYTES + 1),
      width: 1200,
      height: 2400,
    })

    expect(result.bytes.byteLength).toBeLessThanOrEqual(MAX_THUMBNAIL_BYTES)
    expect(result.width).toBeGreaterThanOrEqual(480)
    expect(result.height).toBeGreaterThanOrEqual(480)
  })

  it('fails rather than writing an oversized result when the encoder cannot reach the cap', async () => {
    const optimizer = new WebpThumbnailOptimizer({
      encode: async () => Buffer.alloc(MAX_THUMBNAIL_BYTES + 1),
    })

    await expect(
      optimizer.optimize({
        bytes: Buffer.alloc(MAX_THUMBNAIL_BYTES + 1),
        width: 1200,
        height: 2400,
      }),
    ).rejects.toMatchObject({ code: 'DERIVED_WRITE_FAILED' })
  })
})
