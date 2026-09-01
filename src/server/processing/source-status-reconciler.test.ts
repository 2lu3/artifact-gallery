import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactProcessingError } from '../../shared/errors.js'
import { openDatabase } from '../db/database.js'
import { ArtifactRepository } from '../repositories/artifact-repository.js'
import { reconcileSourceStatuses } from './source-status-reconciler.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('source status reconciliation', () => {
  it('marks only missing sources missing and persists safe non-missing inspect errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-source-status-'))
    temporaryDirectories.push(root)
    const database = openDatabase({ filename: join(root, 'catalog.sqlite') })
    const artifacts = new ArtifactRepository(database)
    const available = artifacts.register({
      sourcePath: '/available.md',
      format: 'markdown',
      now: 'now',
    })
    const missing = artifacts.register({
      sourcePath: '/missing.md',
      format: 'markdown',
      now: 'now',
    })
    const rejected = artifacts.register({
      sourcePath: '/rejected.md',
      format: 'markdown',
      now: 'now',
    })

    await reconcileSourceStatuses({
      database,
      artifactIds: [available.id, missing.id, rejected.id],
      timeoutMs: 50,
      authorizeFile: async (sourcePath) => {
        if (sourcePath === '/missing.md') {
          throw new ArtifactProcessingError('SOURCE_MISSING', 'inspect', 'private missing path')
        }
        if (sourcePath === '/rejected.md') {
          throw new ArtifactProcessingError('SYMLINK_REJECTED', 'inspect', 'private target')
        }
        return { canonicalPath: sourcePath, read: async () => '' }
      },
      now: () => 'later',
    })

    expect(database.prepare('SELECT id, source_status FROM artifact ORDER BY id').all()).toEqual([
      { id: available.id, source_status: 'available' },
      { id: missing.id, source_status: 'missing' },
      { id: rejected.id, source_status: 'available' },
    ])
    expect(artifacts.listErrors(missing.id)).toEqual([
      expect.objectContaining({ code: 'SOURCE_MISSING', technicalDetail: null }),
    ])
    expect(artifacts.listErrors(rejected.id)).toEqual([
      expect.objectContaining({ code: 'SYMLINK_REJECTED', technicalDetail: null }),
    ])
    database.close()
  })

  it('bounds a stalled source check and clears stale source errors after recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-source-timeout-'))
    temporaryDirectories.push(root)
    const database = openDatabase({ filename: join(root, 'catalog.sqlite') })
    const artifacts = new ArtifactRepository(database)
    const artifact = artifacts.register({
      sourcePath: '/source.md',
      format: 'markdown',
      now: 'now',
    })

    await reconcileSourceStatuses({
      database,
      artifactIds: [artifact.id],
      timeoutMs: 5,
      authorizeFile: () => new Promise(() => undefined),
      now: () => 'timeout',
    })
    expect(artifacts.listErrors(artifact.id)).toEqual([
      expect.objectContaining({ code: 'TIMEOUT', technicalDetail: null }),
    ])

    await reconcileSourceStatuses({
      database,
      artifactIds: [artifact.id],
      timeoutMs: 50,
      authorizeFile: async (sourcePath) => ({ canonicalPath: sourcePath, read: async () => '' }),
      now: () => 'recovered',
    })
    expect(artifacts.listErrors(artifact.id)).toEqual([])
    database.close()
  })
})
