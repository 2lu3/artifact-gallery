import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'

import { observeRequestAbort } from './routes.js'

describe('observeRequestAbort', () => {
  it('cancels on request abort and removes every listener after cleanup', () => {
    const source = abortSource()
    let cancellations = 0
    const cleanup = observeRequestAbort(source, () => {
      cancellations += 1
    })

    source.request.emit('aborted')
    cleanup()
    source.request.emit('aborted')
    source.response.emit('close')

    expect(cancellations).toBe(1)
  })

  it('cancels when the response closes before it is written', () => {
    const source = abortSource()
    let cancelled = false
    observeRequestAbort(source, () => {
      cancelled = true
    })

    source.response.emit('close')

    expect(cancelled).toBe(true)
  })
})

function abortSource() {
  const request = Object.assign(new EventEmitter(), {
    aborted: false,
    complete: false,
  }) as unknown as IncomingMessage
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  }) as unknown as ServerResponse
  return { request, response }
}
