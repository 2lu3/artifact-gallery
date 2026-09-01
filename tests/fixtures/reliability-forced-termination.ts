import { writeSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { openDatabase } from '../../src/server/db/database.js'
import { ArtifactProcessor, type ArtifactIndexer } from '../../src/server/processing/artifact-processor.js'
import { ImportWorker } from '../../src/server/processing/worker.js'
import { HtmlRenderer } from '../../src/server/rendering/html-renderer.js'
import { ImportRepository } from '../../src/server/repositories/import-repository.js'
import { ArtifactRepository } from '../../src/server/repositories/artifact-repository.js'
import { DerivativePathPolicy } from '../../src/server/security/derivative-path-policy.js'
import { PathPolicy } from '../../src/server/security/path-policy.js'
import { SQLiteSearchIndexer } from '../../src/server/search/sqlite-search-indexer.js'
import type { ProcessingStage } from '../../src/shared/errors.js'

const stages = new Set<ProcessingStage>(['inspect', 'extract', 'render', 'index', 'commit'])
type CrashPoint = ProcessingStage | 'rename-before-db' | 'db-before-old-cleanup'
const crashPoints = new Set<CrashPoint>([
  ...stages,
  'rename-before-db',
  'db-before-old-cleanup',
])
const stage = process.argv[2] as CrashPoint | undefined
const filename = process.argv[3]
const sourcePath = process.argv[4]
const thumbnailDirectory = process.argv[5]
if (!stage || !crashPoints.has(stage) || !filename || !sourcePath || !thumbnailDirectory) {
  throw new Error('stage, database filename, source path, and thumbnail directory are required.')
}

const database = openDatabase({
  filename: resolve(filename),
  migrationsDirectory: resolve(process.cwd(), 'migrations'),
})
await mkdir(resolve(thumbnailDirectory), { recursive: true })
const realPolicy = await PathPolicy.create([resolve(sourcePath, '..')])
const canonicalSourcePath = (await realPolicy.authorizeFile(resolve(sourcePath))).canonicalPath
const imports = new ImportRepository(database)
const run = imports.createRun([resolve(sourcePath)])
let ready = false
const signalReady = (details: { orphanPath?: string; activePath?: string } = {}) => {
  if (ready) return
  ready = true
  writeSync(
    1,
    `READY ${JSON.stringify({ runId: run.id, itemId: run.itemIds[0], stage, ...details })}\n`,
  )
}
const never = <T>(): Promise<T> => new Promise<T>(() => undefined)

const pathPolicy = {
  authorizeFile: async (requestedPath: string) => {
    if (stage === 'inspect') {
      signalReady()
      return never<Awaited<ReturnType<typeof realPolicy.authorizeFile>>>()
    }
    const authorized = await realPolicy.authorizeFile(requestedPath)
    if (stage !== 'extract') return authorized
    return {
      canonicalPath: authorized.canonicalPath,
      read: async (encoding: 'utf8', maxBytes?: number) => {
        void encoding
        void maxBytes
        signalReady()
        return never<string>()
      },
    }
  },
  authorizeAsset: async (requestedPath: string) => {
    const asset = await realPolicy.authorizeAsset(requestedPath)
    if (stage !== 'render') return asset
    return {
      canonicalPath: asset.canonicalPath,
      mimeType: asset.mimeType,
      read: async () => {
        signalReady()
        return never<Buffer>()
      },
    }
  },
}

const htmlRenderer =
  stage === 'render'
    ? new HtmlRenderer(pathPolicy)
    : {
        render: async () => ({
          screenshot: Buffer.from('RIFF-fixture-preview-WEBP'),
          width: 1200,
          height: 800,
          warnings: [] as const,
        }),
      }

const realIndexer = new SQLiteSearchIndexer(database)
const indexer: ArtifactIndexer = {
  prepare: async (request) => {
    if (stage === 'index') {
      signalReady()
      return never<Awaited<ReturnType<ArtifactIndexer['prepare']>>>()
    }
    return realIndexer.prepare(request)
  },
}

const realDerivativePolicy = await DerivativePathPolicy.create(resolve(thumbnailDirectory))
let oldThumbnailPath: string | null = null
if (stage === 'db-before-old-cleanup') {
  const artifacts = new ArtifactRepository(database)
  const artifact = artifacts.register({
    sourcePath: canonicalSourcePath,
    format: resolve(sourcePath).endsWith('.md') ? 'markdown' : 'html',
    now: new Date().toISOString(),
  })
  const generation = artifacts.createGeneration(artifact.id, new Date().toISOString())
  oldThumbnailPath = resolve(
    thumbnailDirectory,
    `artifact-${artifact.id}-generation-${generation.generation}.webp`,
  )
  await writeFile(oldThumbnailPath, 'old active thumbnail')
  artifacts.commitGeneration({
    artifactId: artifact.id,
    generationId: generation.id,
    expectedGeneration: generation.generation,
    contentStatus: 'ready',
    renderStatus: 'ready',
    indexStatus: 'ready',
    extractedText: 'old active text',
    extractorVersion: 'crash-fixture',
    thumbnailPath: oldThumbnailPath,
    previewedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })
}
const derivativePathPolicy = {
  mkdir: realDerivativePolicy.mkdir.bind(realDerivativePolicy),
  writeFile: realDerivativePolicy.writeFile.bind(realDerivativePolicy),
  rename: (from: string, to: string) => {
    realDerivativePolicy.rename(from, to)
    if (stage === 'rename-before-db') {
      signalReady({ orphanPath: to })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
  },
  remove: async (path: string) => {
    if (stage === 'db-before-old-cleanup' && path === oldThumbnailPath) {
      const activePath = database
        .prepare(
          `SELECT artifact_generation.thumbnail_path
           FROM artifact
           JOIN artifact_generation ON artifact_generation.id = artifact.active_generation_id
           WHERE artifact.source_path = ?`,
        )
        .pluck()
        .get(canonicalSourcePath) as string
      signalReady({ orphanPath: path, activePath })
      return never<void>()
    }
    return realDerivativePolicy.remove(path)
  },
}

const processor = new ArtifactProcessor({
  database,
  pathPolicy,
  derivativePathPolicy,
  htmlRenderer,
  indexer,
  thumbnailDirectory: resolve(thumbnailDirectory),
  thumbnailOptimizer: {
    optimize: async (input) => {
      if (stage === 'commit') {
        signalReady()
        return never<{ bytes: Buffer; width: number; height: number; quality: number }>()
      }
      return { ...input, quality: 80 }
    },
  },
})
const worker = new ImportWorker({
  processor,
  onError: (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  },
})
worker.enqueue(
  stage === 'db-before-old-cleanup' ? 'refresh' : 'register',
  {
    sourcePath: resolve(sourcePath),
    runId: run.id,
    itemId: run.itemIds[0],
  },
  {
    onResult: (result) => {
      if (!ready) writeSync(2, `RESULT ${JSON.stringify(result)}\n`)
    },
  },
)

setInterval(() => undefined, 60_000)
