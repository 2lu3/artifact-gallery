import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { ArtifactProcessingError } from '../../shared/errors.js'
import type { ArtifactFormat } from '../repositories/artifact-repository.js'
import type { SourceExtraction } from './source-extraction.js'

const EXTRACTION_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')

Promise.all([
  import(workerData.markdownRendererUrl),
  import(workerData.sourceExtractionUrl),
]).then(([markdown, extraction]) => {
  const value = workerData.format === 'markdown'
    ? extraction.extractMarkdownResult(new markdown.MarkdownRenderer().render(workerData.source))
    : extraction.extractHtmlSource(workerData.source)
  parentPort.postMessage({ ok: true, value })
}).catch((error) => {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : 'Source extraction failed.',
      ...(error && typeof error === 'object' && typeof error.code === 'string'
        ? { code: error.code }
        : {}),
    },
  })
})
`

type ExtractionWorkerMessage =
  | { readonly ok: true; readonly value: SourceExtraction }
  | {
      readonly ok: false
      readonly error: { readonly name: string; readonly message: string; readonly code?: string }
    }

export function extractSourceInWorker(request: {
  readonly format: ArtifactFormat
  readonly source: string
  readonly signal?: AbortSignal
}): Promise<SourceExtraction> {
  const compiledExtractionUrl = new URL('./source-extraction.js', import.meta.url)
  const runsTypeScript = !existsSync(fileURLToPath(compiledExtractionUrl))
  const worker = new Worker(EXTRACTION_WORKER_SOURCE, {
    eval: true,
    execArgv: runsTypeScript ? ['--import', 'tsx'] : [],
    workerData: {
      format: request.format,
      source: request.source,
      markdownRendererUrl: new URL(
        runsTypeScript ? '../rendering/markdown-renderer.ts' : '../rendering/markdown-renderer.js',
        import.meta.url,
      ).href,
      sourceExtractionUrl: new URL(
        runsTypeScript ? './source-extraction.ts' : './source-extraction.js',
        import.meta.url,
      ).href,
    },
  })

  return new Promise<SourceExtraction>((resolve, reject) => {
    let settled = false
    const settle = (operation: () => void) => {
      if (settled) return
      settled = true
      request.signal?.removeEventListener('abort', onAbort)
      operation()
    }
    const onAbort = () => {
      settle(() => {
        void worker.terminate()
        reject(
          new ArtifactProcessingError('TIMEOUT', 'extract', undefined, {
            cause: request.signal?.reason,
          }),
        )
      })
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) {
      onAbort()
      return
    }
    worker.once('message', (message: ExtractionWorkerMessage) => {
      settle(() => {
        if (message.ok) {
          resolve(message.value)
          return
        }
        reject(
          Object.assign(new Error(message.error.message), {
            name: message.error.name,
            ...(message.error.code ? { code: message.error.code } : {}),
          }),
        )
      })
    })
    worker.once('error', (error) => settle(() => reject(error)))
    worker.once('exit', (code) => {
      if (code !== 0) {
        settle(() => reject(new Error(`Source extraction worker exited with code ${code}.`)))
      }
    })
  })
}
