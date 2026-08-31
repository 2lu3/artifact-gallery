import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { installGracefulShutdown } from './graceful-shutdown.js'

describe('installGracefulShutdown', () => {
  it('handles SIGINT/SIGTERM once, waits for app.close, and removes listeners', async () => {
    const signals = new EventEmitter()
    let closeCalls = 0
    let releaseClose!: () => void
    const closeReleased = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    const exits: number[] = []
    const cleanup = installGracefulShutdown({
      app: {
        close: async () => {
          closeCalls += 1
          await closeReleased
        },
      },
      signals,
      exit: (code) => {
        exits.push(code)
      },
    })

    signals.emit('SIGINT')
    signals.emit('SIGTERM')
    expect(closeCalls).toBe(1)
    expect(exits).toEqual([])
    expect(signals.listenerCount('SIGINT')).toBe(1)
    expect(signals.listenerCount('SIGTERM')).toBe(1)

    releaseClose()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(exits).toEqual([0])
    expect(signals.listenerCount('SIGINT')).toBe(0)
    expect(signals.listenerCount('SIGTERM')).toBe(0)

    cleanup()
    cleanup()
  })

  it('reports close failure once without retaining signal listeners', async () => {
    const signals = new EventEmitter()
    const exits: number[] = []
    installGracefulShutdown({
      app: {
        close: async () => {
          throw new Error('close failed')
        },
      },
      signals,
      exit: (code) => {
        exits.push(code)
      },
    })

    signals.emit('SIGTERM')
    signals.emit('SIGINT')
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(exits).toEqual([1])
    expect(signals.listenerCount('SIGINT')).toBe(0)
    expect(signals.listenerCount('SIGTERM')).toBe(0)
  })
})
