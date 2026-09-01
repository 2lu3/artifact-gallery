import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CREDENTIAL_PATTERNS = [
  /artifact-gallery-bootstrap/iu,
  /x-artifact-gallery-token/iu,
  /sessionToken/iu,
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/u,
] as const

export function assertTokenFreeArtifactText(text: string): void {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error('Artifact contains credential material.')
  }
}

async function scanArtifact(path: string): Promise<void> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  assertTokenFreeArtifactText(text)
}

async function main(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) throw new Error('At least one artifact path is required.')
  for (const path of paths) {
    try {
      await scanArtifact(path)
    } catch {
      throw new Error(`Artifact refused by credential scan: ${basename(path)}`)
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Artifact credential scan failed.'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
