import { chromium, type Browser } from 'playwright'

export const MAX_THUMBNAIL_BYTES = 500 * 1024

const MIN_IDENTIFIABLE_WIDTH = 480
const MIN_IDENTIFIABLE_HEIGHT = 480
const QUALITY_STEPS = [70, 60, 50, 45] as const
const DIMENSION_STEPS = [1, 0.85, 0.7, 0.55, 0.4] as const

export interface ThumbnailInput {
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
}

export interface OptimizedThumbnail extends ThumbnailInput {
  readonly quality: number
}

export interface WebpEncodeRequest extends ThumbnailInput {
  readonly quality: number
}

export interface WebpEncoder {
  encode(request: WebpEncodeRequest): Promise<Buffer>
}

export interface ThumbnailOptimizer {
  optimize(input: ThumbnailInput): Promise<OptimizedThumbnail>
}

export class ThumbnailOptimizationError extends Error {
  readonly code = 'DERIVED_WRITE_FAILED' as const

  constructor(options?: ErrorOptions) {
    super('Unable to produce a bounded WebP thumbnail.', options)
    this.name = 'ThumbnailOptimizationError'
  }
}

export class WebpThumbnailOptimizer implements ThumbnailOptimizer {
  private readonly encoder: WebpEncoder
  private readonly ownsEncoder: boolean

  constructor(encoder?: WebpEncoder) {
    this.encoder = encoder ?? new ChromiumWebpEncoder()
    this.ownsEncoder = encoder === undefined
  }

  async optimize(input: ThumbnailInput): Promise<OptimizedThumbnail> {
    if (input.bytes.byteLength <= MAX_THUMBNAIL_BYTES) {
      return { ...input, quality: 80 }
    }

    try {
      for (const scale of DIMENSION_STEPS) {
        const width = Math.max(MIN_IDENTIFIABLE_WIDTH, Math.round(input.width * scale))
        const height = Math.max(MIN_IDENTIFIABLE_HEIGHT, Math.round(input.height * scale))
        for (const quality of QUALITY_STEPS) {
          const bytes = await this.encoder.encode({ ...input, width, height, quality })
          if (bytes.byteLength <= MAX_THUMBNAIL_BYTES) {
            return { bytes, width, height, quality }
          }
        }
      }
      throw new ThumbnailOptimizationError()
    } catch (error) {
      if (error instanceof ThumbnailOptimizationError) throw error
      throw new ThumbnailOptimizationError({ cause: error })
    } finally {
      if (this.ownsEncoder && this.encoder instanceof ChromiumWebpEncoder) {
        await this.encoder.close()
      }
    }
  }
}

export class ChromiumWebpEncoder implements WebpEncoder {
  private browser: Browser | null = null

  async encode(request: WebpEncodeRequest): Promise<Buffer> {
    const browser = await this.getBrowser()
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: request.width, height: request.height },
    })
    try {
      const page = await context.newPage()
      const source = `data:image/webp;base64,${request.bytes.toString('base64')}`
      await page.setContent(
        `<style>html,body{margin:0;width:${request.width}px;height:${request.height}px;overflow:hidden}` +
          `img{display:block;width:${request.width}px;height:${request.height}px;object-fit:contain}</style>` +
          `<img src="${source}" alt="">`,
        { waitUntil: 'load' },
      )
      const session = await page.context().newCDPSession(page)
      try {
        const result = await session.send('Page.captureScreenshot', {
          format: 'webp',
          quality: request.quality,
          clip: {
            x: 0,
            y: 0,
            width: request.width,
            height: request.height,
            scale: 1,
          },
          captureBeyondViewport: true,
        })
        return Buffer.from(result.data, 'base64')
      } finally {
        await session.detach().catch(() => undefined)
      }
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    await browser?.close().catch(() => undefined)
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser
    this.browser = await chromium.launch({ headless: true })
    return this.browser
  }
}
