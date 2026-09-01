import { describe, expect, it } from 'vitest'

import { assertNonceCompatibleDocument } from '../../scripts/development-smoke.js'

describe('development smoke contract', () => {
  it('requires the CSP nonce to be present on the transformed document', () => {
    const headers = new Headers({
      'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-safe_nonce'",
    })

    expect(() =>
      assertNonceCompatibleDocument(
        headers,
        '<script type="module" nonce="safe_nonce" src="/@vite/client"></script>',
      ),
    ).not.toThrow()
    expect(() =>
      assertNonceCompatibleDocument(headers, '<script src="/@vite/client"></script>'),
    ).toThrow(/nonce/u)
  })
})
