import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database.js'
import { AllowedRootRepository } from './allowed-root-repository.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('AllowedRootRepository', () => {
  it('idempotently persists canonical allowed roots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-roots-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'gallery.sqlite')
    const database = openDatabase({ filename })
    const repository = new AllowedRootRepository(database)
    const first = repository.add('/canonical/b', '2026-08-31T00:00:00.000Z')
    const duplicate = repository.add('/canonical/b', '2026-08-31T00:01:00.000Z')
    const second = repository.add('/canonical/a', '2026-08-31T00:02:00.000Z')

    expect(duplicate.id).toBe(first.id)
    database.close()

    const reopened = openDatabase({ filename })
    expect(new AllowedRootRepository(reopened).list()).toEqual([
      {
        id: second.id,
        canonicalPath: '/canonical/a',
        createdAt: '2026-08-31T00:02:00.000Z',
      },
      {
        id: first.id,
        canonicalPath: '/canonical/b',
        createdAt: '2026-08-31T00:00:00.000Z',
      },
    ])
    reopened.close()
  })
})
