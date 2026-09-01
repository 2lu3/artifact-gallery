import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase, type OpenDatabaseOptions } from '../../src/server/db/database.js'
import type { PathPolicy } from '../../src/server/security/path-policy.js'

interface SeededState {
  readonly root: string
  readonly stateDirectory: string
  readonly databaseFilename: string
  readonly thumbnailDirectory: string
}

interface SeedStateDependencies {
  readonly openDatabase?: typeof openDatabase
  readonly createPathPolicy?: (roots: readonly string[]) => Promise<PathPolicy>
}

type CreateSeededPerformanceState = (
  root: string,
  prefix: string,
  sourcePaths: readonly string[],
  dependencies?: SeedStateDependencies,
) => Promise<SeededState>

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('performance seed state lifecycle', () => {
  it('closes the opened database and removes partial state when PathPolicy creation rejects', async () => {
    const createSeededState = await loadCreateSeededState()
    expect(typeof createSeededState).toBe('function')
    if (!createSeededState) return

    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-seed-policy-'))
    temporaryDirectories.push(root)
    const sourceDirectory = join(root, 'sources')
    const sourcePath = join(sourceDirectory, 'artifact.md')
    await mkdir(sourceDirectory)
    await writeFile(sourcePath, '# seeded artifact')
    let databaseClosed = false

    await expect(
      createSeededState(root, 'state-', [sourcePath], {
        openDatabase: trackedOpenDatabase(() => {
          databaseClosed = true
        }),
        createPathPolicy: async () => {
          throw new Error('injected PathPolicy failure')
        },
      }),
    ).rejects.toThrow('injected PathPolicy failure')

    expect(databaseClosed).toBe(true)
    expect(await readdir(root)).toEqual(['sources'])
  })

  it('closes the database without leaving a lock or temp state for an invalid root', async () => {
    const createSeededState = await loadCreateSeededState()
    expect(typeof createSeededState).toBe('function')
    if (!createSeededState) return

    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-seed-invalid-root-'))
    temporaryDirectories.push(root)
    let databaseClosed = false

    await expect(
      createSeededState(root, 'state-', [join(root, 'missing', 'artifact.md')], {
        openDatabase: trackedOpenDatabase(() => {
          databaseClosed = true
        }),
      }),
    ).rejects.toThrow()

    expect(databaseClosed).toBe(true)
    expect(await readdir(root)).toEqual([])
  })
})

async function loadCreateSeededState(): Promise<CreateSeededPerformanceState | undefined> {
  try {
    const moduleUrl = new URL('./seed-state.ts', import.meta.url)
    const seedState = (await import(/* @vite-ignore */ moduleUrl.href)) as {
      createSeededPerformanceState?: CreateSeededPerformanceState
    }
    return seedState.createSeededPerformanceState
  } catch {
    return undefined
  }
}

function trackedOpenDatabase(onClose: () => void): typeof openDatabase {
  return (options: OpenDatabaseOptions) => {
    const database = openDatabase(options)
    const close = database.close.bind(database)
    database.close = () => {
      onClose()
      close()
    }
    return database
  }
}
