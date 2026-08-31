export interface BackgroundQueueOptions {
  readonly concurrency: number
  readonly capacity: number
  readonly onError?: (error: unknown) => void
}

export class BackgroundQueue {
  private readonly pending: Array<() => Promise<void>> = []
  private readonly idleWaiters: Array<() => void> = []
  private active = 0
  private scheduled = false
  private accepting = true

  constructor(private readonly options: BackgroundQueueOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new TypeError('Background queue concurrency must be a positive integer.')
    }
    if (!Number.isInteger(options.capacity) || options.capacity < options.concurrency) {
      throw new TypeError('Background queue capacity must cover its concurrency.')
    }
  }

  enqueue(task: () => Promise<void>): boolean {
    if (!this.accepting) return false
    if (this.active + this.pending.length >= this.options.capacity) return false
    this.pending.push(task)
    this.schedulePump()
    return true
  }

  onIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  close(): Promise<void> {
    this.accepting = false
    return this.onIdle()
  }

  private schedulePump(): void {
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < this.options.concurrency) {
      const task = this.pending.shift()
      if (!task) break
      this.active += 1
      void task()
        .catch((error: unknown) => this.options.onError?.(error))
        .finally(() => {
          this.active -= 1
          this.pump()
          this.resolveIdle()
        })
    }
    this.resolveIdle()
  }

  private resolveIdle(): void {
    if (this.active !== 0 || this.pending.length !== 0) return
    this.idleWaiters.splice(0).forEach((resolve) => resolve())
  }
}
