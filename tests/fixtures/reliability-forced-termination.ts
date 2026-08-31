import { resolve } from 'node:path'

import { openDatabase } from '../../src/server/db/database.js'
import { ArtifactProcessor, type ArtifactIndexer } from '../../src/server/processing/artifact-processor.js'
import { ImportWorker } from '../../src/server/processing/worker.js'
import { HtmlRenderer } from '../../src/server/rendering/html-renderer.js'
import { ImportRepository } from '../../src/server/repositories/import-repository.js'
import { PathPolicy } from '../../src/server/security/path-policy.js'
import { SQLiteSearchIndexer } from '../../src/server/search/sqlite-search-indexer.js'
import type { ProcessingStage } from '../../src/shared/errors.js'

const stages = new Set<ProcessingStage>(['inspect', 'extract', 'render', 'index', 'commit'])
const stage = process.argv[2] as ProcessingStage | undefined
const filename = process.argv[3]
const sourcePath = process.argv[4]
const thumbnailDirectory = process.argv[5]
if (!stage || !stages.has(stage) || !filename || !sourcePath || !thumbnailDirectory) {
  throw new Error('stage, database filename, source path, and thumbnail directory are required.')
}

const database = openDatabase({
  filename: resolve(filename),
  migrationsDirectory: resolve(process.cwd(), 'migrations'),
})
const realPolicy = await PathPolicy.create([resolve(sourcePath, '..')])
const imports = new ImportRepository(database)
const run = imports.createRun([resolve(sourcePath)])
let ready = false
const signalReady = () => {
  if (ready) return
  ready = true
  process.stdout.write(
    `READY ${JSON.stringify({ runId: run.id, itemId: run.itemIds[0], stage })}\n`,
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
}

const htmlRenderer =
  stage === 'render'
    ? new HtmlRenderer({
        authorizeAsset: async (requestedPath) => {
          const asset = await realPolicy.authorizeAsset(requestedPath)
          return {
            canonicalPath: asset.canonicalPath,
            mimeType: asset.mimeType,
            read: async () => {
              signalReady()
              return never<Buffer>()
            },
          }
        },
      })
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

const processor = new ArtifactProcessor({
  database,
  pathPolicy,
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
worker.enqueue('register', {
  sourcePath: resolve(sourcePath),
  runId: run.id,
  itemId: run.itemIds[0],
})

setInterval(() => undefined, 60_000)
