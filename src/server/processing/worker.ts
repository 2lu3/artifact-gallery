import { ArtifactProcessingError } from '../../shared/errors.js'
import { BackgroundQueue } from '../api/background-queue.js'
import type {
  ArtifactProcessRequest,
  ArtifactProcessResult,
  ArtifactProcessor,
} from './artifact-processor.js'

export const MAX_PROCESSING_ATTEMPT_MS = 30_000

export type ArtifactProcessOperation = 'register' | 'refresh' | 'retry' | 'rebuild'

export interface BoundedArtifactProcessor {
  register(request: ArtifactProcessRequest): Promise<ArtifactProcessResult>
  refresh(request: ArtifactProcessRequest): Promise<ArtifactProcessResult>
  retry(request: ArtifactProcessRequest): Promise<ArtifactProcessResult>
  rebuild(request: ArtifactProcessRequest): Promise<ArtifactProcessResult>
}

export interface ImportWorkerOptions {
  readonly processor: BoundedArtifactProcessor | ArtifactProcessor
  readonly concurrency?: number
  readonly capacity?: number
  readonly attemptTimeoutMs?: number
  readonly onError?: (error: unknown) => void | Promise<void>
}

export interface ImportWorkerCallbacks {
  readonly onResult?: (result: ArtifactProcessResult) => void | Promise<void>
  readonly onError?: (error: unknown) => void | Promise<void>
}

export interface ImportWorkerContext {
  process(
    operation: ArtifactProcessOperation,
    request: ArtifactProcessRequest,
  ): Promise<ArtifactProcessResult>
}

export class ImportWorker {
  private readonly queue: BackgroundQueue
  private readonly sourceLocks = new Map<string, Promise<void>>()
  private readonly attemptTimeoutMs: number

  constructor(private readonly options: ImportWorkerOptions) {
    this.queue = new BackgroundQueue({
      concurrency: options.concurrency ?? 2,
      capacity: options.capacity ?? 64,
      onError: options.onError,
    })
    this.attemptTimeoutMs = Math.min(
      MAX_PROCESSING_ATTEMPT_MS,
      Math.max(1, Math.floor(options.attemptTimeoutMs ?? MAX_PROCESSING_ATTEMPT_MS)),
    )
  }

  enqueue(
    operation: ArtifactProcessOperation,
    request: ArtifactProcessRequest,
    callbacks: ImportWorkerCallbacks = {},
  ): boolean {
    return this.enqueueTask(
      async (context) => {
        const result = await context.process(operation, request)
        await callbacks.onResult?.(result)
      },
      callbacks.onError,
    )
  }

  enqueueTask(
    task: (context: ImportWorkerContext) => Promise<void>,
    onError?: (error: unknown) => void | Promise<void>,
  ): boolean {
    return this.queue.enqueue(async () => {
      try {
        await task({ process: this.process.bind(this) })
      } catch (error) {
        await onError?.(error)
        if (!onError) await this.options.onError?.(error)
      }
    })
  }

  onIdle(): Promise<void> {
    return this.queue.onIdle()
  }

  close(): Promise<void> {
    return this.queue.close()
  }

  private process(
    operation: ArtifactProcessOperation,
    request: ArtifactProcessRequest,
  ): Promise<ArtifactProcessResult> {
    return this.serializeSource(request.sourcePath, () => this.processBounded(operation, request))
  }

  private async processBounded(
    operation: ArtifactProcessOperation,
    request: ArtifactProcessRequest,
  ): Promise<ArtifactProcessResult> {
    const deadlineAt = Date.now() + this.attemptTimeoutMs
    const abortController = new AbortController()
    const timeoutError = new ArtifactProcessingError('TIMEOUT', 'inspect')
    const abortGraceMs = Math.min(100, Math.max(1, Math.floor(this.attemptTimeoutMs / 2)))
    const abortTimer = setTimeout(
      () => abortController.abort(timeoutError),
      this.attemptTimeoutMs - abortGraceMs,
    )
    let hardDeadlineTimer: ReturnType<typeof setTimeout> | undefined
    const hardDeadline = new Promise<never>((_resolve, reject) => {
      hardDeadlineTimer = setTimeout(() => reject(timeoutError), this.attemptTimeoutMs)
    })
    const boundedRequest = { ...request, signal: abortController.signal, deadlineAt }
    const operationPromise = Promise.resolve()
      .then(() => this.options.processor[operation](boundedRequest))
      .then((result) => {
        if (Date.now() >= deadlineAt) throw timeoutError
        return result
      })
    operationPromise.catch(() => undefined)
    try {
      return await Promise.race([operationPromise, hardDeadline])
    } finally {
      clearTimeout(abortTimer)
      if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer)
    }
  }

  private async serializeSource<T>(sourcePath: string, task: () => Promise<T>): Promise<T> {
    const predecessor = this.sourceLocks.get(sourcePath) ?? Promise.resolve()
    let resolveOperation!: () => void
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve
    })
    this.sourceLocks.set(sourcePath, operation)
    await predecessor.catch(() => undefined)
    try {
      return await task()
    } finally {
      resolveOperation()
      if (this.sourceLocks.get(sourcePath) === operation) this.sourceLocks.delete(sourcePath)
    }
  }
}
