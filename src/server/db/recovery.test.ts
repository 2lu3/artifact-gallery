import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './database.js'
import { reconcileStartup } from './recovery.js'
import { ImportRepository } from '../repositories/import-repository.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

interface FixtureState {
  artifactId: number
  completedGenerationId: number
  activeGenerationId: number
  runId: number
  processingItemId: number
  unstartedItemId: number
}

describe('reconcileStartup', () => {
  it('reconciles a force-terminated process without losing completed derivatives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-recovery-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'gallery.sqlite')
    const derivedDirectory = join(directory, 'derived')
    const permanentThumbnail = join(derivedDirectory, 'current.webp')
    const temporaryThumbnail = join(derivedDirectory, 'replacement.webp.tmp')
    const unrelatedFile = join(derivedDirectory, 'notes.txt')
    await mkdir(derivedDirectory)
    await writeFile(permanentThumbnail, 'completed thumbnail')
    await writeFile(temporaryThumbnail, 'incomplete thumbnail')
    await writeFile(unrelatedFile, 'keep unrelated file')

    const fixture = fileURLToPath(
      new URL('../../../tests/fixtures/forced-termination.ts', import.meta.url),
    )
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      fixture,
      filename,
      permanentThumbnail,
    ])
    const [chunk] = (await once(child.stdout, 'data')) as [Buffer]
    const output = chunk.toString('utf8').trim()
    expect(output.startsWith('READY ')).toBe(true)
    const state = JSON.parse(output.slice('READY '.length)) as FixtureState

    child.kill('SIGKILL')
    await once(child, 'exit')

    const database = openDatabase({ filename })
    const report = await reconcileStartup(database, {
      temporaryDerivativeDirectory: derivedDirectory,
      interruptedAt: '2026-08-31T00:05:00.000Z',
    })

    expect(report).toEqual({
      interruptedRunIds: [state.runId],
      interruptedItemIds: [state.processingItemId, state.unstartedItemId],
      interruptedGenerationIds: [state.activeGenerationId],
      unstartedItems: [
        {
          id: state.unstartedItemId,
          runId: state.runId,
          canonicalPath: '/canonical/unstarted.md',
        },
      ],
      removedTemporaryFiles: [temporaryThumbnail],
      errors: [],
    })

    const imports = new ImportRepository(database)
    expect(imports.getRun(state.runId).status).toBe('interrupted')
    expect(imports.getItem(state.processingItemId).status).toBe('interrupted')
    expect(imports.getItem(state.unstartedItemId).status).toBe('interrupted')
    expect(
      database
        .prepare(
          `SELECT id, job_status, content_status, extracted_text, thumbnail_path
           FROM artifact_generation WHERE artifact_id = ? ORDER BY generation`,
        )
        .all(state.artifactId),
    ).toEqual([
      {
        id: state.completedGenerationId,
        job_status: 'idle',
        content_status: 'ready',
        extracted_text: 'completed text',
        thumbnail_path: permanentThumbnail,
      },
      {
        id: state.activeGenerationId,
        job_status: 'interrupted',
        content_status: 'ready',
        extracted_text: 'completed extraction survives',
        thumbnail_path: null,
      },
    ])
    expect(await readFile(permanentThumbnail, 'utf8')).toBe('completed thumbnail')
    expect(await readFile(unrelatedFile, 'utf8')).toBe('keep unrelated file')
    await expect(access(temporaryThumbnail)).rejects.toThrow()

    database.close()
  })
})
