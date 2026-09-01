import { describe, expect, it } from 'vitest'

import { ArtifactProcessingError, mapProcessingError, toPublicProcessingError } from './errors.js'

describe('processing error boundary', () => {
  it('maps a known boundary code without exposing its technical cause publicly', () => {
    const cause = Object.assign(new Error('/private/root/missing.md'), {
      code: 'SOURCE_MISSING',
    })

    const mapped = mapProcessingError(cause, 'inspect')

    expect(mapped).toMatchObject({
      code: 'SOURCE_MISSING',
      stage: 'inspect',
      retryable: true,
      technicalDetail: '/private/root/missing.md',
    })
    expect(toPublicProcessingError(mapped)).toEqual({
      code: 'SOURCE_MISSING',
      stage: 'inspect',
      retryable: true,
      message: 'The source file could not be found.',
    })
  })

  it('defaults unknown failures to a non-retryable UNKNOWN result', () => {
    const mapped = mapProcessingError(new Error('password=secret'), 'commit')

    expect(mapped).toBeInstanceOf(ArtifactProcessingError)
    expect(mapped).toMatchObject({
      code: 'UNKNOWN',
      stage: 'commit',
      retryable: false,
      technicalDetail: 'password=secret',
    })
    expect(JSON.stringify(toPublicProcessingError(mapped)).includes('secret')).toBe(false)
  })

  it('classifies SQLite busy failures as retryable database contention', () => {
    const mapped = mapProcessingError(
      Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
      'commit',
    )

    expect(mapped).toMatchObject({
      code: 'DATABASE_BUSY',
      stage: 'commit',
      retryable: true,
    })
  })
})
