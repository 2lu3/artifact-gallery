import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from './db/database.js'
import type { StartupReconciliationReport } from './processing/recovery.js'
import { ImportRepository } from './repositories/import-repository.js'
import { AllowedRootRepository } from './repositories/allowed-root-repository.js'
import { ArtifactRepository } from './repositories/artifact-repository.js'
import { createServerRuntime, runtimeOptionsFromEnvironment } from './runtime.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('server composition root', () => {
  it('reconciles interrupted SQLite and derivative state before exposing the API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-runtime-recovery-'))
    temporaryDirectories.push(root)
    const databaseFilename = join(root, 'state', 'catalog.sqlite')
    const thumbnailDirectory = join(root, 'state', 'thumbnails')
    await mkdir(thumbnailDirectory, { recursive: true })
    const temporaryThumbnail = join(thumbnailDirectory, '.artifact-1.webp.crash.tmp')
    await writeFile(temporaryThumbnail, 'partial')
    const seed = openDatabase({ filename: databaseFilename })
    const imports = new ImportRepository(seed)
    const run = imports.createRun([join(root, 'queued.md')])
    seed.close()

    const reports: StartupReconciliationReport[] = []
    const app = await createServerRuntime({
      databaseFilename,
      thumbnailDirectory,
      allowedRoots: [root],
      port: 4173,
      reportRecovery: (report) => {
        reports.push(report)
      },
    })
    const recovered = await app.inject({
      method: 'GET',
      url: `/api/imports/${run.id}`,
      headers: {
        host: '127.0.0.1:4173',
        'x-artifact-gallery-token': app.sessionToken,
      },
    })

    expect(recovered.json()).toMatchObject({
      status: 'interrupted',
      items: [{ status: 'interrupted', stage: 'queued' }],
    })
    expect(reports).toEqual([
      expect.objectContaining({
        unstartedItems: [
          expect.objectContaining({ runId: run.id, canonicalPath: join(root, 'queued.md') }),
        ],
      }),
    ])
    await expect(access(temporaryThumbnail)).rejects.toThrow()
    await app.close()
  })

  it('wires the protected API without persisting its startup token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-runtime-'))
    temporaryDirectories.push(root)
    const databaseFilename = join(root, 'state', 'catalog.sqlite')
    const app = await createServerRuntime({
      databaseFilename,
      thumbnailDirectory: join(root, 'state', 'thumbnails'),
      allowedRoots: [root],
      port: 4173,
    })
    const token = app.sessionToken

    const health = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:4173', 'x-artifact-gallery-token': token },
    })
    const registrationRoute = await app.inject({
      method: 'POST',
      url: '/api/registrations/file',
      headers: { host: '127.0.0.1:4173', 'x-artifact-gallery-token': token },
      payload: {},
    })

    expect(health.statusCode).toBe(200)
    expect(registrationRoute.statusCode).toBe(400)
    await app.close()
    expect((await readFile(databaseFilename)).includes(Buffer.from(token))).toBe(false)
  })

  it('derives state paths and roots without allowing a listen host override', () => {
    const options = runtimeOptionsFromEnvironment({
      ARTIFACT_GALLERY_STATE_DIRECTORY: '/tmp/artifact-gallery-state',
      ARTIFACT_GALLERY_ALLOWED_ROOTS: `/tmp/one${process.platform === 'win32' ? ';' : ':'}/tmp/two`,
      PORT: '4173',
    })

    expect(options).toEqual({
      databaseFilename: '/tmp/artifact-gallery-state/catalog.sqlite',
      thumbnailDirectory: '/tmp/artifact-gallery-state/thumbnails',
      allowedRoots: ['/tmp/one', '/tmp/two'],
      clientDirectory: resolve('dist'),
      port: 4173,
    })
    expect(options).not.toHaveProperty('host')
  })

  it('keeps the default runtime database and derivatives outside the repository', () => {
    const options = runtimeOptionsFromEnvironment({ HOME: '/tmp/artifact-gallery-user' })

    expect(options.databaseFilename).toMatch(/^\/tmp\/artifact-gallery-user\//u)
    expect(options.thumbnailDirectory).toMatch(/^\/tmp\/artifact-gallery-user\//u)
    expect(options.databaseFilename).not.toContain(process.cwd())
    expect(options.thumbnailDirectory).not.toContain(process.cwd())
    expect(options.allowedRoots).toEqual([])
  })

  it('restores persisted file capabilities and marks missing sources before serving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-runtime-missing-'))
    temporaryDirectories.push(root)
    const databaseFilename = join(root, 'state', 'catalog.sqlite')
    const sourcePath = join(root, 'selected.md')
    await mkdir(join(root, 'state'))
    await writeFile(sourcePath, '# Selected')
    const seed = openDatabase({ filename: databaseFilename })
    const artifact = new ArtifactRepository(seed).register({
      sourcePath,
      format: 'markdown',
      now: '2026-09-01T00:00:00.000Z',
    })
    const capability = new AllowedRootRepository(seed).add(
      sourcePath,
      'file',
      '2026-09-01T00:00:00.000Z',
    )
    new AllowedRootRepository(seed).linkArtifact(artifact.id, capability.id)
    seed.close()
    await rm(sourcePath)

    const app = await createServerRuntime({
      databaseFilename,
      thumbnailDirectory: join(root, 'state', 'thumbnails'),
      allowedRoots: [],
      port: 4173,
    })
    const response = await app.inject({
      method: 'GET',
      url: `/api/artifacts/${artifact.id}`,
      headers: {
        host: '127.0.0.1:4173',
        'x-artifact-gallery-token': app.sessionToken,
      },
    })

    expect(response.json()).toMatchObject({
      status: 'missing',
      errors: [expect.objectContaining({ code: 'SOURCE_MISSING' })],
    })
    await app.close()
  })
})
