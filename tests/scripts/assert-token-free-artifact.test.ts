import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const scanner = resolve('scripts/assert-token-free-artifact.ts')
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs')

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('token-free artifact scanner', () => {
  it('accepts metrics but refuses credential-bearing artifacts without echoing the secret', async () => {
    await expect(access(scanner)).resolves.toBeUndefined()
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-artifact-scan-'))
    temporaryDirectories.push(directory)
    const metrics = join(directory, 'metrics.json')
    await writeFile(metrics, '{"firstPage":{"medianMs":72.5},"search":{"medianMs":118.2}}\n')

    await expect(runScanner(metrics)).resolves.toMatchObject({ exitCode: 0, stderr: '' })

    const secret = 'credential_that_must_never_reach_ci_artifacts_0123456789'
    for (const unsafe of [
      `{"sessionToken":"${secret}"}`,
      `<script id="artifact-gallery-bootstrap">${secret}</script>`,
      `x-artifact-gallery-token: ${secret}`,
      `{"opaque":"${secret}"}`,
      `{"opaque":"--${'a'.repeat(38)}"}`,
    ]) {
      await writeFile(metrics, unsafe)
      const result = await runScanner(metrics)
      expect(result.exitCode).toBe(1)
      expect(result.stderr.includes(secret)).toBe(false)
    }
  })
})

async function runScanner(path: string): Promise<{ exitCode: number; stderr: string }> {
  const child = spawn(process.execPath, [tsxCli, scanner, path], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const [exitCode] = (await once(child, 'exit')) as [number]
  return { exitCode, stderr }
}
