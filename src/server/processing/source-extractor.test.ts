import { describe, expect, it } from 'vitest'

import { extractSourceInWorker } from './source-extractor.js'

describe('source extraction worker boundary', () => {
  it('keeps Markdown CPU parsing off the owner event loop', async () => {
    const source = `${'# Worker title\n\n- item\n'.repeat(2_000)}`
    let ownerTicked = false
    const extraction = extractSourceInWorker({ format: 'markdown', source })
    setImmediate(() => {
      ownerTicked = true
    })

    const result = await extraction

    expect(ownerTicked).toBe(true)
    expect(result.documentTitle).toBe('Worker title')
    expect(result.extractorVersion).toBe('commonmark-safe-1')
  })

  it('terminates extraction when the owning attempt is aborted', async () => {
    const deadline = new AbortController()
    const extraction = extractSourceInWorker({
      format: 'html',
      source: `<main>${'<p>large document</p>'.repeat(100_000)}</main>`,
      signal: deadline.signal,
    })

    deadline.abort()

    await expect(extraction).rejects.toMatchObject({ code: 'TIMEOUT', stage: 'extract' })
  })
})
