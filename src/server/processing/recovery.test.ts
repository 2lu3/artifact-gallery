import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/database.js'
import { ImportRepository } from '../repositories/import-repository.js'
import { ArtifactRepository } from '../repositories/artifact-repository.js'
import { reconcileStartup } from './recovery.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await chmod(join(directory, 'derived'), 0o700).catch(() => undefined)
      await rm(directory, { force: true, recursive: true })
    }),
  )
})

describe('processing startup reconciliation', () => {
  it('removes permanent rename-before-DB and DB-before-old-cleanup orphans but keeps the active thumbnail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-recovery-orphans-'))
    temporaryDirectories.push(root)
    const derived = join(root, 'derived')
    await mkdir(derived)
    const database = openDatabase({ filename: join(root, 'gallery.sqlite') })
    const artifacts = new ArtifactRepository(database)
    const artifact = artifacts.register({
      sourcePath: join(root, 'source.md'),
      format: 'markdown',
      now: '2026-09-01T00:00:00.000Z',
    })
    const active = artifacts.createGeneration(artifact.id, '2026-09-01T00:00:00.000Z')
    const activePath = join(derived, `artifact-${artifact.id}-generation-${active.generation}.webp`)
    await writeFile(activePath, 'active')
    artifacts.commitGeneration({
      artifactId: artifact.id,
      generationId: active.id,
      expectedGeneration: active.generation,
      contentStatus: 'ready',
      renderStatus: 'ready',
      indexStatus: 'ready',
      extractedText: 'active',
      extractorVersion: 'test',
      thumbnailPath: activePath,
      previewedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:00:00.000Z',
    })
    const old = artifacts.createGeneration(artifact.id, '2026-09-01T00:01:00.000Z')
    const oldPath = join(derived, `artifact-${artifact.id}-generation-${old.generation}.webp`)
    const renamedBeforeDb = join(derived, 'artifact-999-generation-1.webp')
    await writeFile(oldPath, 'old inactive')
    await writeFile(renamedBeforeDb, 'renamed before DB')
    database
      .prepare('UPDATE artifact_generation SET thumbnail_path = ? WHERE id = ?')
      .run(oldPath, old.id)

    const report = await reconcileStartup(database, {
      temporaryDerivativeDirectory: derived,
      interruptedAt: '2026-09-01T00:02:00.000Z',
    })

    expect(report.removedOrphanFiles).toEqual([oldPath, renamedBeforeDb].sort())
    await expect(access(activePath)).resolves.toBeUndefined()
    await expect(access(oldPath)).rejects.toThrow()
    await expect(access(renamedBeforeDb)).rejects.toThrow()
    database.close()
  })

  it('does not traverse a derivative symlink while reconciling permanent files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-recovery-symlink-'))
    temporaryDirectories.push(root)
    const derived = join(root, 'derived')
    const outside = join(root, 'outside')
    await mkdir(derived)
    await mkdir(outside)
    const outsideFile = join(outside, 'artifact-77-generation-1.webp')
    await writeFile(outsideFile, 'outside')
    await symlink(outside, join(derived, 'escape'), 'dir')
    const database = openDatabase({ filename: join(root, 'gallery.sqlite') })

    await reconcileStartup(database, {
      temporaryDerivativeDirectory: derived,
      interruptedAt: '2026-09-01T00:00:00.000Z',
    })

    await expect(access(outsideFile)).resolves.toBeUndefined()
    database.close()
  })

  it('reports an unreadable same-root temp item without blocking startup or broad deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-recovery-errors-'))
    temporaryDirectories.push(root)
    const derived = join(root, 'derived')
    const nested = join(derived, 'nested')
    const temporary = join(derived, '.artifact-1.webp.unreadable.tmp')
    const permanent = join(derived, 'artifact-1.webp')
    const nestedTemporary = join(nested, 'unrelated.tmp')
    await mkdir(nested, { recursive: true })
    await writeFile(temporary, 'partial')
    await writeFile(permanent, 'ready')
    await writeFile(nestedTemporary, 'outside the derivative root level')
    const database = openDatabase({ filename: join(root, 'gallery.sqlite') })
    const imports = new ImportRepository(database)
    const run = imports.createRun(['/source/unstarted.md'])
    await chmod(derived, 0o500)

    const report = await reconcileStartup(database, {
      temporaryDerivativeDirectory: derived,
      interruptedAt: '2026-09-01T00:00:00.000Z',
    })

    expect(imports.getRun(run.id).status).toBe('interrupted')
    expect(imports.getItem(run.itemIds[0]).status).toBe('interrupted')
    expect(report.removedTemporaryFiles).toEqual([])
    expect(report.errors).toEqual([
      {
        code: 'TEMPORARY_DERIVATIVE_UNREADABLE',
        operation: 'remove-temporary-derivative',
        path: temporary,
        detail: expect.any(String),
      },
    ])
    await expect(access(temporary)).resolves.toBeUndefined()
    await expect(access(permanent)).resolves.toBeUndefined()
    await expect(access(nestedTemporary)).resolves.toBeUndefined()
    database.close()
  })
})
