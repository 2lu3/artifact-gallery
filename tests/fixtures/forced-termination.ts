import { resolve } from 'node:path'
import { openDatabase } from '../../src/server/db/database.js'
import { ArtifactRepository } from '../../src/server/repositories/artifact-repository.js'
import { ImportRepository } from '../../src/server/repositories/import-repository.js'

const filename = process.argv[2]
const permanentThumbnailPath = process.argv[3]
if (!filename || !permanentThumbnailPath) {
  throw new Error('Database filename and permanent thumbnail path are required.')
}

const database = openDatabase({
  filename: resolve(filename),
  migrationsDirectory: resolve(process.cwd(), 'migrations'),
})
const artifacts = new ArtifactRepository(database)
const imports = new ImportRepository(database)
const now = '2026-08-31T00:00:00.000Z'

const artifact = artifacts.register({
  sourcePath: '/canonical/note.md',
  format: 'markdown',
  now,
})
const completedGeneration = artifacts.createGeneration(artifact.id, now)
artifacts.commitGeneration({
  artifactId: artifact.id,
  generationId: completedGeneration.id,
  expectedGeneration: completedGeneration.generation,
  contentStatus: 'ready',
  renderStatus: 'ready',
  indexStatus: 'ready',
  extractedText: 'completed text',
  extractorVersion: 'commonmark-1',
  thumbnailPath: permanentThumbnailPath,
  previewedAt: now,
  completedAt: now,
})

const activeGeneration = artifacts.createGeneration(artifact.id, now)
artifacts.setGenerationState(activeGeneration.id, {
  jobStatus: 'processing',
  contentStatus: 'ready',
  renderStatus: 'pending',
  indexStatus: 'pending',
})
database
  .prepare('UPDATE artifact_generation SET extracted_text = ? WHERE id = ?')
  .run('completed extraction survives', activeGeneration.id)

const run = imports.createRun(['/canonical/note.md', '/canonical/unstarted.md'])
imports.startRun(run.id, now)
imports.startStage(run.itemIds[0], 'render', now)

process.stdout.write(
  `READY ${JSON.stringify({
    artifactId: artifact.id,
    completedGenerationId: completedGeneration.id,
    activeGenerationId: activeGeneration.id,
    runId: run.id,
    processingItemId: run.itemIds[0],
    unstartedItemId: run.itemIds[1],
  })}\n`,
)

setInterval(() => undefined, 60_000)
