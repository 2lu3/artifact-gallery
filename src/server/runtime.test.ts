import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createServerRuntime, runtimeOptionsFromEnvironment } from './runtime.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('server composition root', () => {
  it('wires the protected API without persisting its startup token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-runtime-'))
    temporaryDirectories.push(root)
    const databaseFilename = join(root, 'state', 'catalog.sqlite')
    const app = await createServerRuntime({
      databaseFilename,
      thumbnailDirectory: join(root, 'state', 'thumbnails'),
      allowedRoots: [root],
    })
    const token = app.sessionToken

    const health = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-artifact-gallery-token': token },
    })
    const registrationRoute = await app.inject({
      method: 'POST',
      url: '/api/registrations/file',
      headers: { 'x-artifact-gallery-token': token },
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
    })

    expect(options).toEqual({
      databaseFilename: '/tmp/artifact-gallery-state/catalog.sqlite',
      thumbnailDirectory: '/tmp/artifact-gallery-state/thumbnails',
      allowedRoots: ['/tmp/one', '/tmp/two'],
    })
    expect(options).not.toHaveProperty('host')
  })
})
