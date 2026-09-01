export type ShutdownSignal = 'SIGINT' | 'SIGTERM'

export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown
  off(signal: ShutdownSignal, listener: () => void): unknown
}

export interface GracefulShutdownOptions {
  readonly app: { close(): Promise<void> }
  readonly signals?: SignalSource
  readonly exit?: (code: number) => void
}

export function installGracefulShutdown(options: GracefulShutdownOptions): () => void {
  const signals = options.signals ?? process
  const exit = options.exit ?? ((code: number) => process.exit(code))
  let closing: Promise<void> | null = null
  let listening = true

  const cleanup = () => {
    if (!listening) return
    listening = false
    signals.off('SIGINT', handleSignal)
    signals.off('SIGTERM', handleSignal)
  }
  const handleSignal = () => {
    if (closing) return
    try {
      closing = options.app.close()
    } catch (error) {
      closing = Promise.reject(error)
    }
    void closing.then(
      () => {
        cleanup()
        exit(0)
      },
      () => {
        cleanup()
        exit(1)
      },
    )
  }

  signals.on('SIGINT', handleSignal)
  signals.on('SIGTERM', handleSignal)
  return cleanup
}
