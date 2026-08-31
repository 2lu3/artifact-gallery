import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import { openDatabase } from '../db/database.js'
import { ArtifactProcessor } from '../processing/artifact-processor.js'
import { SearchVisibilityRepository } from '../repositories/search-visibility-repository.js'
import { PathPolicy } from '../security/path-policy.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe('local API integration', () => {
  it('paginates exactly 30 visible cards and rejects changed cursor context', async () => {
    const harness = await makeHarness()
    for (let index = 0; index < 35; index += 1) {
      await writeFile(
        join(harness.sourceDirectory, `${index.toString().padStart(2, '0')}.md`),
        `# Pagination artifact ${index.toString().padStart(2, '0')}\n\nshared searchable body`,
      )
    }

    const registered = await harness.app.inject({
      method: 'POST',
      url: '/api/registrations/folder',
      headers: harness.headers,
      payload: { path: harness.sourceDirectory },
    })
    expect(registered.statusCode).toBe(202)
    expect(registered.json().results).toHaveLength(35)

    const first = await harness.app.inject({
      method: 'GET',
      url: '/api/gallery?sort=newest&filter=ready',
      headers: harness.headers,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().items).toHaveLength(30)
    expect(first.json().nextCursor).toEqual(expect.any(String))
    expect(first.json().items[0]).toMatchObject({
      status: 'ready',
      diagram: expect.stringContaining('->'),
    })

    const second = await harness.app.inject({
      method: 'GET',
      url: `/api/gallery?sort=newest&filter=ready&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: harness.headers,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().items).toHaveLength(5)
    expect(second.json().nextCursor).toBeNull()
    expect(new Set([...first.json().items, ...second.json().items].map((item) => item.id))).toHaveProperty(
      'size',
      35,
    )

    const search = await harness.app.inject({
      method: 'GET',
      url: '/api/search?q=shared%20searchable%20body&sort=newest&filter=ready',
      headers: harness.headers,
    })
    expect(search.statusCode).toBe(200)
    expect(search.json().items).toHaveLength(30)

    const cursor = first.json().nextCursor as string
    const tamperedCursor = `${cursor.slice(0, -1)}${cursor.endsWith('x') ? 'y' : 'x'}`
    const tampered = await harness.app.inject({
      method: 'GET',
      url: `/api/gallery?sort=newest&filter=ready&cursor=${encodeURIComponent(tamperedCursor)}`,
      headers: harness.headers,
    })
    expectCursorStale(tampered)

    const changedFilter = await harness.app.inject({
      method: 'GET',
      url: `/api/gallery?sort=newest&filter=all&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: harness.headers,
    })
    expectCursorStale(changedFilter)

    const changedSort = await harness.app.inject({
      method: 'GET',
      url: `/api/gallery?sort=title&filter=ready&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: harness.headers,
    })
    expectCursorStale(changedSort)

    const changedQuery = await harness.app.inject({
      method: 'GET',
      url: `/api/search?q=different&sort=newest&filter=ready&cursor=${encodeURIComponent(search.json().nextCursor)}`,
      headers: harness.headers,
    })
    expectCursorStale(changedQuery)

    const titleUpdate = await harness.app.inject({
      method: 'PATCH',
      url: `/api/artifacts/${first.json().items[0].id}/title`,
      headers: harness.headers,
      payload: { title: 'Changed title' },
    })
    expect(titleUpdate.statusCode).toBe(200)
    const titleSearch = await harness.app.inject({
      method: 'GET',
      url: '/api/search?q=changed%20title',
      headers: harness.headers,
    })
    expect(titleSearch.statusCode).toBe(200)
    expect(titleSearch.json().items.map((item: { id: number }) => item.id)).toEqual([
      first.json().items[0].id,
    ])

    const stale = await harness.app.inject({
      method: 'GET',
      url: `/api/gallery?sort=newest&filter=ready&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: harness.headers,
    })
    expectCursorStale(stale)

    await harness.close()
  })

  it('upserts rapid duplicate registration and exposes import status idempotently', async () => {
    const harness = await makeHarness()
    const sourcePath = join(harness.sourceDirectory, 'duplicate.md')
    await writeFile(sourcePath, '# One catalog artifact')

    const requests = Array.from({ length: 4 }, () =>
      harness.app.inject({
        method: 'POST',
        url: '/api/registrations/file',
        headers: harness.headers,
        payload: { path: sourcePath },
      }),
    )
    const responses = await Promise.all(requests)

    expect(responses.every((response) => response.statusCode === 202)).toBe(true)
    expect(
      harness.database.prepare('SELECT COUNT(*) AS count FROM artifact').get(),
    ).toEqual({ count: 1 })
    const artifactIds = responses.map((response) => response.json().results[0].artifactId)
    expect(new Set(artifactIds).size).toBe(1)

    const runId = responses[0].json().runIds[0]
    const status = await harness.app.inject({
      method: 'GET',
      url: `/api/imports/${runId}`,
      headers: harness.headers,
    })
    const cancelled = await harness.app.inject({
      method: 'POST',
      url: `/api/imports/${runId}/cancel`,
      headers: harness.headers,
    })
    expect(status.statusCode).toBe(200)
    expect(status.json().status).toBe('completed')
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().status).toBe('completed')

    await harness.close()
  })

  it('redacts technical errors, rejects relink without changing generation, and deletes only catalog data', async () => {
    const harness = await makeHarness()
    const sourcePath = join(harness.sourceDirectory, 'kept.md')
    const invalidPath = join(harness.sourceDirectory, 'outside.txt')
    await writeFile(sourcePath, '# Keep the source')
    await writeFile(invalidPath, 'unsupported')

    const registered = await harness.app.inject({
      method: 'POST',
      url: '/api/registrations/file',
      headers: harness.headers,
      payload: { path: sourcePath },
    })
    const artifactId = registered.json().results[0].artifactId
    const before = harness.database
      .prepare('SELECT generation_counter FROM artifact WHERE id = ?')
      .get(artifactId)

    const rejectedRelink = await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/relink`,
      headers: harness.headers,
      payload: { sourcePath: invalidPath },
    })
    expect(rejectedRelink.statusCode).toBe(400)
    expect(rejectedRelink.json()).toEqual({
      error: {
        code: 'UNSUPPORTED_FORMAT',
        stage: 'inspect',
        retryable: false,
        message: 'This file format is not supported.',
      },
    })
    expect(JSON.stringify(rejectedRelink.json())).not.toContain(invalidPath)
    expect(
      harness.database.prepare('SELECT generation_counter FROM artifact WHERE id = ?').get(artifactId),
    ).toEqual(before)

    await rm(sourcePath)
    const refreshed = await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/refresh`,
      headers: harness.headers,
    })
    expect(refreshed.statusCode).toBe(200)
    expect(JSON.stringify(refreshed.json())).not.toContain(sourcePath)
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/artifacts/${artifactId}`,
      headers: harness.headers,
    })
    expect(detail.json()).toMatchObject({
      id: artifactId,
      status: 'missing',
      thumbnailPath: expect.any(String),
      errors: [{ code: 'SOURCE_MISSING', stage: 'inspect', retryable: true }],
    })
    expect(JSON.stringify(detail.json())).not.toContain('technicalDetail')

    await writeFile(sourcePath, '# Keep the source')
    const derivedPath = detail.json().thumbnailPath
    const firstDelete = await harness.app.inject({
      method: 'DELETE',
      url: `/api/artifacts/${artifactId}`,
      headers: harness.headers,
    })
    const secondDelete = await harness.app.inject({
      method: 'DELETE',
      url: `/api/artifacts/${artifactId}`,
      headers: harness.headers,
    })
    expect(firstDelete.statusCode).toBe(204)
    expect(secondDelete.statusCode).toBe(204)
    expect(existsSync(sourcePath)).toBe(true)
    expect(existsSync(derivedPath)).toBe(false)

    await harness.close()
  })

  it('bounds schemas and authorizes source actions before returning a platform result', async () => {
    const harness = await makeHarness()
    const sourcePath = join(harness.sourceDirectory, 'action.md')
    await writeFile(sourcePath, '# Action')
    const registered = await harness.app.inject({
      method: 'POST',
      url: '/api/registrations/file',
      headers: harness.headers,
      payload: { path: sourcePath },
    })
    const artifactId = registered.json().results[0].artifactId

    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/registrations/file',
      headers: harness.headers,
      payload: { path: 'x'.repeat(4097) },
    })
    const reveal = await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/reveal`,
      headers: harness.headers,
    })
    const open = await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/open-source`,
      headers: harness.headers,
    })

    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error.code).toBe('INVALID_REQUEST')
    expect(reveal.statusCode).toBe(501)
    expect(reveal.json().error.code).toBe('UNSUPPORTED_PLATFORM')
    expect(open.statusCode).toBe(501)
    expect(open.json().error.code).toBe('UNSUPPORTED_PLATFORM')

    await harness.close()
  })

  it('keeps the last successful thumbnail while card state moves through partial, failed, and missing', async () => {
    const harness = await makeHarness()
    const sourcePath = join(harness.sourceDirectory, 'states.md')
    await writeFile(sourcePath, '# Initial success')
    const registered = await harness.app.inject({
      method: 'POST',
      url: '/api/registrations/file',
      headers: harness.headers,
      payload: { path: sourcePath },
    })
    const artifactId = registered.json().results[0].artifactId
    const ready = await artifactDetail(harness, artifactId)
    const successfulThumbnail = ready.thumbnailPath

    harness.setRenderFailure(true)
    const partialResponse = await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/refresh`,
      headers: harness.headers,
    })
    expect(partialResponse.json().outcome).toBe('partial')
    expect(await artifactDetail(harness, artifactId)).toMatchObject({
      status: 'partial',
      thumbnailPath: successfulThumbnail,
    })

    harness.setRenderFailure(false)
    await writeFile(sourcePath, 'before\0after')
    const failedResponse = await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/retry`,
      headers: harness.headers,
    })
    expect(failedResponse.json().outcome).toBe('failed')
    expect(await artifactDetail(harness, artifactId)).toMatchObject({
      status: 'failed',
      thumbnailPath: successfulThumbnail,
    })

    await rm(sourcePath)
    await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/rebuild`,
      headers: harness.headers,
    })
    expect(await artifactDetail(harness, artifactId)).toMatchObject({
      status: 'missing',
      thumbnailPath: successfulThumbnail,
    })

    await harness.close()
  })

  it('accepts format-safe relinks without generation changes and routes all processing actions', async () => {
    const harness = await makeHarness()
    const firstPath = join(harness.sourceDirectory, 'first.md')
    const secondPath = join(harness.sourceDirectory, 'second.md')
    await writeFile(firstPath, '# First searchable')
    await writeFile(secondPath, '# Second searchable')
    const registered = await harness.app.inject({
      method: 'POST',
      url: '/api/registrations/file',
      headers: harness.headers,
      payload: { path: firstPath },
    })
    const artifactId = registered.json().results[0].artifactId

    const relinked = await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/relink`,
      headers: harness.headers,
      payload: { sourcePath: secondPath },
    })
    expect(relinked.statusCode).toBe(200)
    expect(relinked.json()).toMatchObject({
      sourcePath: await realpath(secondPath),
      generation: 1,
    })
    const relinkSearch = await harness.app.inject({
      method: 'GET',
      url: '/api/search?q=second',
      headers: harness.headers,
    })
    expect(relinkSearch.statusCode).toBe(200)
    expect(relinkSearch.json().items.map((item: { id: number }) => item.id)).toEqual([artifactId])

    for (const operation of ['refresh', 'retry', 'rebuild']) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/artifacts/${artifactId}/${operation}`,
        headers: harness.headers,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().outcome).toBe('completed')
    }
    expect((await artifactDetail(harness, artifactId)).generation).toBe(4)

    const activeGeneration = harness.database
      .prepare('SELECT active_generation_id FROM artifact WHERE id = ?')
      .pluck()
      .get(artifactId) as number
    new SearchVisibilityRepository(harness.database).quarantineGeneration({
      artifactId,
      generationId: activeGeneration,
      now: new Date().toISOString(),
    })
    const hidden = await harness.app.inject({
      method: 'GET',
      url: '/api/search?q=second%20searchable',
      headers: harness.headers,
    })
    expect(hidden.statusCode).toBe(200)
    expect(hidden.json().items).toEqual([])

    await harness.close()
  })

})

function expectCursorStale(response: Awaited<ReturnType<ReturnType<typeof buildApp>['inject']>>): void {
  expect(response.statusCode).toBe(409)
  expect(response.json()).toEqual({
    error: {
      code: 'CURSOR_STALE',
      stage: 'request',
      retryable: true,
      message: 'The requested result page is out of date.',
    },
  })
}

async function makeHarness() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-api-'))
  temporaryDirectories.push(root)
  const sourceDirectory = join(root, 'sources')
  const thumbnailDirectory = join(root, 'derived')
  await mkdir(sourceDirectory)
  await mkdir(thumbnailDirectory)
  const database = openDatabase({ filename: join(root, 'gallery.sqlite') })
  const pathPolicy = await PathPolicy.create([sourceDirectory])
  let renderFailure = false
  const processor = new ArtifactProcessor({
    database,
    pathPolicy,
    htmlRenderer: {
      render: async () => {
        if (renderFailure) {
          throw Object.assign(new Error('browser details must stay private'), {
            code: 'HTML_RENDER_FAILED',
          })
        }
        return renderedPreview()
      },
    },
    thumbnailDirectory,
    thumbnailOptimizer: {
      optimize: async ({ bytes, width, height }) => ({ bytes, width, height, quality: 80 }),
    },
  })
  const app = buildApp({ database, pathPolicy, processor, thumbnailDirectory })
  const headers = { 'x-artifact-gallery-token': app.sessionToken }

  return {
    app,
    database,
    headers,
    root,
    sourceDirectory,
    setRenderFailure: (value: boolean) => {
      renderFailure = value
    },
    close: async () => {
      await app.close()
      database.close()
    },
  }
}

async function artifactDetail(harness: Awaited<ReturnType<typeof makeHarness>>, artifactId: number) {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/artifacts/${artifactId}`,
    headers: harness.headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json()
}

function renderedPreview() {
  return {
    screenshot: Buffer.from('RIFF-api-preview-WEBP'),
    width: 1200,
    height: 800,
    warnings: [] as const,
  }
}
