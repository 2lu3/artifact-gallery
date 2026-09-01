import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { openDatabase } from '../../src/server/db/database.js'
import { ArtifactProcessor } from '../../src/server/processing/artifact-processor.js'
import { DerivativePathPolicy } from '../../src/server/security/derivative-path-policy.js'
import { PathPolicy } from '../../src/server/security/path-policy.js'

export interface SeededState {
  readonly root: string
  readonly stateDirectory: string
  readonly databaseFilename: string
  readonly thumbnailDirectory: string
}

export interface SeedStateDependencies {
  readonly openDatabase?: typeof openDatabase
  readonly createPathPolicy?: (roots: readonly string[]) => Promise<PathPolicy>
}

export async function createSeededPerformanceState(
  root: string,
  prefix: string,
  sourcePaths: readonly string[],
  dependencies: SeedStateDependencies = {},
): Promise<SeededState> {
  const stateRoot = await mkdtemp(join(root, prefix))
  const stateDirectory = join(stateRoot, 'state')
  const databaseFilename = join(stateDirectory, 'catalog.sqlite')
  const thumbnailDirectory = join(stateDirectory, 'thumbnails')
  try {
    await mkdir(stateDirectory, { recursive: true })
    await seedPerformanceCorpus(databaseFilename, thumbnailDirectory, sourcePaths, dependencies)
    return { root: stateRoot, stateDirectory, databaseFilename, thumbnailDirectory }
  } catch (error) {
    await rm(stateRoot, { recursive: true, force: true })
    throw error
  }
}

async function seedPerformanceCorpus(
  databaseFilename: string,
  thumbnailDirectory: string,
  sourcePaths: readonly string[],
  dependencies: SeedStateDependencies,
): Promise<void> {
  const database = (dependencies.openDatabase ?? openDatabase)({ filename: databaseFilename })
  try {
    const pathPolicy = await (dependencies.createPathPolicy ?? PathPolicy.create)([
      dirname(sourcePaths[0] as string),
    ])
    await mkdir(thumbnailDirectory, { recursive: true })
    const derivativePathPolicy = await DerivativePathPolicy.create(thumbnailDirectory)
    const processor = new ArtifactProcessor({
      database,
      pathPolicy,
      derivativePathPolicy,
      htmlRenderer: {
        render: async ({ html }) => ({
          screenshot: Buffer.from(`RIFF${html.slice(0, 64)}WEBP`),
          width: 1200,
          height: 800,
          warnings: [],
        }),
      },
      thumbnailDirectory,
      thumbnailOptimizer: {
        optimize: async ({ bytes, width, height }) => ({ bytes, width, height, quality: 80 }),
      },
    })
    for (const sourcePath of sourcePaths) {
      const result = await processor.register({ sourcePath })
      if (result.outcome !== 'completed') {
        throw new Error('Unable to index a performance corpus item.')
      }
    }
  } finally {
    database.close()
  }
}
