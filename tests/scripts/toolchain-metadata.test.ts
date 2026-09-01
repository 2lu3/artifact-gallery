import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('toolchain metadata', () => {
  it('pins Node 24.20.0 consistently for local installs, package engines, CI, and docs', async () => {
    const [packageText, nvmrc, workflow, readme] = await Promise.all([
      readFile('package.json', 'utf8'),
      readFile('.nvmrc', 'utf8'),
      readFile('.github/workflows/ci.yml', 'utf8'),
      readFile('README.md', 'utf8'),
    ])
    const packageMetadata = JSON.parse(packageText) as { engines?: { node?: string } }

    expect(packageMetadata.engines?.node).toBe('24.20.0')
    expect(nvmrc.trim()).toBe('24.20.0')
    expect(workflow.match(/24\.20\.0/gu)).toHaveLength(3)
    expect(readme).toContain('Node.js `24.20.0`')
  })
})
