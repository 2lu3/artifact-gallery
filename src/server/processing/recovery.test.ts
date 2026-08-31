import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/database.js'
import { ImportRepository } from '../repositories/import-repository.js'
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
