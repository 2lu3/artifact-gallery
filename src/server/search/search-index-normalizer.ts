import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { ArtifactProcessingError } from '../../shared/errors.js'

export interface NormalizedSearchIndexBody {
  readonly body: string
}

interface NormalizationRequest {
  readonly body: string
  readonly signal?: AbortSignal
}

interface WorkerNormalizationRequest extends Omit<NormalizationRequest, 'signal'> {
  readonly id: number
}

type NormalizationWorkerMessage =
  | { readonly id: number; readonly ok: true; readonly value: NormalizedSearchIndexBody }
  | {
      readonly id: number
      readonly ok: false
      readonly error: { readonly name: string; readonly message: string }
    }

interface PendingNormalization {
  readonly request: WorkerNormalizationRequest
  readonly signal?: AbortSignal
  readonly resolve: (value: NormalizedSearchIndexBody) => void
  readonly reject: (error: unknown) => void
  onAbort?: () => void
}

interface WorkerSlot {
  worker: Worker | undefined
  task: PendingNormalization | undefined
}

const NORMALIZATION_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')

const searchModule = import(workerData.searchQueryUrl)

parentPort.on('message', async (request) => {
  try {
    const search = await searchModule
    parentPort.postMessage({
      id: request.id,
      ok: true,
      value: {
        body: search.normalizeSearchText(request.body),
      },
    })
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : 'Search normalization failed.',
      },
    })
  }
})
`

class SearchIndexNormalizerPool {
  readonly #slots: WorkerSlot[]
  readonly #queue: PendingNormalization[] = []
  #nextId = 1

  constructor(size: number) {
    this.#slots = Array.from({ length: size }, () => ({
      worker: undefined,
      task: undefined,
    }))
  }

  normalize(request: NormalizationRequest): Promise<NormalizedSearchIndexBody> {
    if (request.signal?.aborted) return Promise.reject(this.#timeoutError(request.signal))

    return new Promise<NormalizedSearchIndexBody>((resolve, reject) => {
      const task: PendingNormalization = {
        request: {
          id: this.#nextId++,
          body: request.body,
        },
        signal: request.signal,
        resolve,
        reject,
      }
      task.onAbort = () => this.#abort(task)
      task.signal?.addEventListener('abort', task.onAbort, { once: true })
      this.#queue.push(task)
      this.#drain()
    })
  }

  #drain(): void {
    for (const slot of this.#slots) {
      while (!slot.task && this.#queue.length > 0) {
        const task = this.#queue.shift()
        if (!task) break
        if (task.signal?.aborted) {
          this.#cleanup(task)
          task.reject(this.#timeoutError(task.signal))
          continue
        }

        try {
          const worker = slot.worker ?? this.#createWorker(slot)
          slot.task = task
          worker.ref()
          worker.postMessage(task.request)
        } catch (error) {
          slot.task = undefined
          this.#cleanup(task)
          task.reject(error)
          this.#discardWorker(slot)
        }
      }
    }
  }

  #createWorker(slot: WorkerSlot): Worker {
    const compiledUrl = new URL('./search-query.js', import.meta.url)
    const runsTypeScript = !existsSync(fileURLToPath(compiledUrl))
    const worker = new Worker(NORMALIZATION_WORKER_SOURCE, {
      eval: true,
      execArgv: runsTypeScript ? ['--import', 'tsx'] : [],
      workerData: {
        searchQueryUrl: new URL(
          runsTypeScript ? './search-query.ts' : './search-query.js',
          import.meta.url,
        ).href,
      },
    })
    slot.worker = worker
    worker.unref()
    worker.on('message', (message: NormalizationWorkerMessage) => {
      const task = slot.task
      if (!task || task.request.id !== message.id) return
      slot.task = undefined
      worker.unref()
      this.#cleanup(task)
      if (message.ok) task.resolve(message.value)
      else task.reject(Object.assign(new Error(message.error.message), { name: message.error.name }))
      this.#drain()
    })
    worker.on('error', (error) => {
      if (slot.worker !== worker) return
      const task = slot.task
      slot.worker = undefined
      slot.task = undefined
      if (task) {
        this.#cleanup(task)
        task.reject(error)
      }
      this.#drain()
    })
    worker.on('exit', (code) => {
      if (slot.worker !== worker) return
      const task = slot.task
      slot.worker = undefined
      slot.task = undefined
      if (task) {
        this.#cleanup(task)
        task.reject(new Error(`Search normalization worker exited with code ${code}.`))
      }
      this.#drain()
    })
    return worker
  }

  #abort(task: PendingNormalization): void {
    const queuedIndex = this.#queue.indexOf(task)
    if (queuedIndex >= 0) {
      this.#queue.splice(queuedIndex, 1)
      this.#cleanup(task)
      task.reject(this.#timeoutError(task.signal))
      return
    }

    const slot = this.#slots.find((candidate) => candidate.task === task)
    if (!slot) return
    const worker = slot.worker
    slot.worker = undefined
    slot.task = undefined
    this.#cleanup(task)
    task.reject(this.#timeoutError(task.signal))
    if (worker) void worker.terminate()
    this.#drain()
  }

  #discardWorker(slot: WorkerSlot): void {
    const worker = slot.worker
    slot.worker = undefined
    if (worker) void worker.terminate()
  }

  #cleanup(task: PendingNormalization): void {
    if (task.onAbort) task.signal?.removeEventListener('abort', task.onAbort)
  }

  #timeoutError(signal: AbortSignal | undefined): ArtifactProcessingError {
    return new ArtifactProcessingError('TIMEOUT', 'index', undefined, {
      cause: signal?.reason,
    })
  }
}

const normalizerPool = new SearchIndexNormalizerPool(2)

export function normalizeSearchIndexBody(
  request: NormalizationRequest,
): Promise<NormalizedSearchIndexBody> {
  return normalizerPool.normalize(request)
}
