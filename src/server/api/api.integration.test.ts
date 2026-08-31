import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app.js'
import { openDatabase } from '../db/database.js'
import { ArtifactProcessor } from '../processing/artifact-processor.js'
import { ImportWorker } from '../processing/worker.js'
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
  it('canonicalizes aliased source paths before locking and creating import runs', async () => {
    let markRenderingStarted!: () => void
    let releaseRendering!: () => void
    const renderingStarted = new Promise<void>((resolve) => {
      markRenderingStarted = resolve
    })
    const renderingReleased = new Promise<void>((resolve) => {
      releaseRendering = resolve
    })
    const harness = await makeHarness({
      beforeRender: async () => {
        markRenderingStarted()
        await renderingReleased
      },
    })
    const canonicalPath = join(harness.sourceDirectory, 'aliased.md')
    const aliasPath = `${harness.sourceDirectory}/./aliased.md`
    await writeFile(canonicalPath, '# Canonical lock')

    const responsesPromise = Promise.all(
      [canonicalPath, aliasPath].map((sourcePath) =>
        harness.app.inject({
          method: 'POST',
          url: '/api/registrations/file',
          headers: harness.headers,
          payload: { path: sourcePath },
        }),
      ),
    )
    await renderingStarted
    releaseRendering()
    const responses = await responsesPromise
    const runs = await Promise.all(
      responses.map((response) => waitForRun(harness, response.json().runId)),
    )

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([202, 202])
    expect(runs.map(({ status }) => status)).toEqual(['completed', 'completed'])
    expect(
      harness.database
        .prepare('SELECT canonical_path FROM import_item ORDER BY id')
        .pluck()
        .all(),
    ).toEqual([await realpath(canonicalPath), await realpath(canonicalPath)])
    expect(harness.database.prepare('SELECT COUNT(*) AS count FROM artifact').get()).toEqual({
      count: 1,
    })
    await harness.close()
  })

  it('returns a durable run before background rendering finishes', async () => {
    let markRenderingStarted!: () => void
    let releaseRendering!: () => void
    const renderingStarted = new Promise<void>((resolve) => {
      markRenderingStarted = resolve
    })
    const renderingReleased = new Promise<void>((resolve) => {
      releaseRendering = resolve
    })
    const harness = await makeHarness({
      beforeRender: async () => {
        markRenderingStarted()
        await renderingReleased
      },
    })
    const sourcePath = join(harness.sourceDirectory, 'background.md')
    await writeFile(sourcePath, '# Background')

    let responseSettled = false
    const responsePromise = harness.app
      .inject({
        method: 'POST',
        url: '/api/registrations/file',
        headers: harness.headers,
        payload: { path: sourcePath },
      })
      .then((response) => {
        responseSettled = true
        return response
      })
    await renderingStarted
    await new Promise<void>((resolve) => setImmediate(resolve))
    const settledBeforeRenderFinished = responseSettled
    releaseRendering()
    const response = await responsePromise

    expect(settledBeforeRenderFinished).toBe(true)
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ runId: expect.any(Number) })
    await harness.close()
  })

  it('reports and durably cancels a run while background processing is active', async () => {
    let markRenderingStarted!: () => void
    let releaseRendering!: () => void
    const renderingStarted = new Promise<void>((resolve) => {
      markRenderingStarted = resolve
    })
    const renderingReleased = new Promise<void>((resolve) => {
      releaseRendering = resolve
    })
    const harness = await makeHarness({
      beforeRender: async () => {
        markRenderingStarted()
        await renderingReleased
      },
    })
    const sourcePath = join(harness.sourceDirectory, 'cancel.md')
    await writeFile(sourcePath, '# Cancel')
    const queued = await harness.app.inject({
      method: 'POST',
      url: '/api/registrations/file',
      headers: harness.headers,
      payload: { path: sourcePath },
    })
    const runId = queued.json().runId as number
    await renderingStarted

    const active = await harness.app.inject({
      method: 'GET',
      url: `/api/imports/${runId}`,
      headers: harness.headers,
    })
    expect(active.json()).toMatchObject({
      id: runId,
      status: 'running',
      items: [{ stage: 'render', status: 'processing' }],
    })
    const cancellation = await harness.app.inject({
      method: 'POST',
      url: `/api/imports/${runId}/cancel`,
      headers: harness.headers,
    })
    expect(cancellation.json().cancelRequestedAt).toEqual(expect.any(String))
    releaseRendering()

    const terminal = await waitForRun(harness, runId)
    expect(terminal).toMatchObject({ status: 'cancelled', items: [{ status: 'cancelled' }] })
    await harness.close()
  })

  it('persists folder enumeration errors with safe item names while valid files continue', async () => {
    const harness = await makeHarness()
    const validPath = join(harness.sourceDirectory, 'valid.md')
    const rejectedPath = join(harness.sourceDirectory, 'linked.md')
    await writeFile(validPath, '# Valid')
    await symlink(validPath, rejectedPath)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/registrations/folder',
      headers: harness.headers,
      payload: { path: harness.sourceDirectory },
    })
    expect(response.statusCode).toBe(202)
    const run = await waitForRun(harness, response.json().runId)

    expect(run.status).toBe('failed')
    expect(run.items).toEqual([
      expect.objectContaining({ name: 'valid.md', status: 'completed', error: null }),
      expect.objectContaining({
        name: 'linked.md',
        status: 'failed',
        error: {
          code: 'SYMLINK_REJECTED',
          stage: 'inspect',
          retryable: false,
          message: 'Symbolic links are not allowed.',
        },
      }),
    ])
    expect(JSON.stringify(run)).not.toContain(harness.root)
    expect(harness.database.prepare('SELECT COUNT(*) AS count FROM artifact').get()).toEqual({
      count: 1,
    })
    await harness.close()
  })

  it('honors cancellation at the folder enumeration boundary', async () => {
    let markEnumerationStarted!: () => void
    let releaseEnumeration!: () => void
    const enumerationStarted = new Promise<void>((resolve) => {
      markEnumerationStarted = resolve
    })
    const enumerationReleased = new Promise<void>((resolve) => {
      releaseEnumeration = resolve
    })
    const harness = await makeHarness({
      beforeEnumeration: async () => {
        markEnumerationStarted()
        await enumerationReleased
      },
    })
    await writeFile(join(harness.sourceDirectory, 'never-processed.md'), '# Cancel folder')

    const queued = await harness.app.inject({
      method: 'POST',
      url: '/api/registrations/folder',
      headers: harness.headers,
      payload: { path: harness.sourceDirectory },
    })
    const runId = queued.json().runId as number
    await enumerationStarted
    const cancellation = await harness.app.inject({
      method: 'POST',
      url: `/api/imports/${runId}/cancel`,
      headers: harness.headers,
    })
    expect(cancellation.json().cancelRequestedAt).toEqual(expect.any(String))
    releaseEnumeration()

    const terminal = await waitForRun(harness, runId)
    expect(terminal).toMatchObject({ status: 'cancelled', items: [] })
    expect(harness.database.prepare('SELECT COUNT(*) AS count FROM artifact').get()).toEqual({
      count: 0,
    })
    await harness.close()
  })

  it('serves thumbnails only through an authenticated opaque derivative URL', async () => {
    const harness = await makeHarness()
    const sourcePath = join(harness.sourceDirectory, 'thumbnail.md')
    await writeFile(sourcePath, '# Opaque thumbnail')
    await harness.processor.register({ sourcePath })

    const gallery = await harness.app.inject({
      method: 'GET',
      url: '/api/gallery?filter=markdown&status=ready',
      headers: harness.headers,
    })
    const card = gallery.json().items[0]
    expect(card.thumbnailUrl).toMatch(/^\/api\/thumbnails\/[A-Za-z0-9_.-]+$/)
    expect(card).not.toHaveProperty('thumbnailPath')
    expect(JSON.stringify(card)).not.toContain(harness.thumbnailDirectory)

    const unauthorized = await harness.app.inject({
      method: 'GET',
      url: card.thumbnailUrl,
      headers: { host: '127.0.0.1:3000' },
    })
    const thumbnail = await harness.app.inject({
      method: 'GET',
      url: card.thumbnailUrl,
      headers: harness.headers,
    })
    expect(unauthorized.statusCode).toBe(401)
    expect(thumbnail.statusCode).toBe(200)
    expect(thumbnail.headers['content-type']).toContain('image/webp')
    expect(thumbnail.headers['cache-control']).toBe('no-store')
    expect(thumbnail.headers.vary?.toLowerCase().split(/\s*,\s*/u)).toContain(
      'x-artifact-gallery-token',
    )
    expect(thumbnail.rawPayload).toEqual(Buffer.from('RIFF-api-preview-WEBP'))

    const tamperedUrl = `${card.thumbnailUrl.slice(0, -1)}${card.thumbnailUrl.endsWith('x') ? 'y' : 'x'}`
    const tampered = await harness.app.inject({
      method: 'GET',
      url: tamperedUrl,
      headers: harness.headers,
    })
    expect(tampered.statusCode).toBe(404)
    expect(JSON.stringify(tampered.json())).not.toContain(harness.thumbnailDirectory)

    await harness.close()
  })

  it('paginates exactly 30 visible cards and rejects changed cursor context', async () => {
    const harness = await makeHarness()
    for (let index = 0; index < 35; index += 1) {
      await writeFile(
        join(harness.sourceDirectory, `${index.toString().padStart(2, '0')}.md`),
        `# Pagination artifact ${index.toString().padStart(2, '0')}\n\nshared searchable body`,
      )
    }
    await writeFile(
      join(harness.sourceDirectory, 'html-only.html'),
      '<!doctype html><title>HTML only</title><p>format filtered</p>',
    )

    const registered = await harness.app.inject({
      method: 'POST',
      url: '/api/registrations/folder',
      headers: harness.headers,
      payload: { path: harness.sourceDirectory },
    })
    expect(registered.statusCode).toBe(202)
    await waitForRun(harness, registered.json().runId)

    const first = await harness.app.inject({
      method: 'GET',
      url: '/api/gallery?sort=newest&filter=markdown&status=ready',
      headers: harness.headers,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().items).toHaveLength(30)
    expect(first.json()).toMatchObject({
      catalogTotal: 36,
      filteredTotal: 35,
      formatCounts: { all: 36, html: 1, markdown: 35 },
    })
    expect(first.json().nextCursor).toEqual(expect.any(String))
    expect(first.json().items[0]).toMatchObject({
      status: 'ready',
      diagram: expect.stringContaining('->'),
    })

    const second = await harness.app.inject({
      method: 'GET',
      url: `/api/gallery?sort=newest&filter=markdown&status=ready&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: harness.headers,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().items).toHaveLength(5)
    expect(second.json().nextCursor).toBeNull()
    expect(new Set([...first.json().items, ...second.json().items].map((item) => item.id))).toHaveProperty(
      'size',
      35,
    )

    const htmlOnly = await harness.app.inject({
      method: 'GET',
      url: '/api/gallery?filter=html&status=ready',
      headers: harness.headers,
    })
    expect(htmlOnly.statusCode).toBe(200)
    expect(htmlOnly.json().items).toHaveLength(1)
    expect(htmlOnly.json().items[0]).toMatchObject({ format: 'html', title: 'HTML only' })
    expect(htmlOnly.json()).toMatchObject({
      catalogTotal: 36,
      filteredTotal: 1,
      formatCounts: { all: 36, html: 1, markdown: 35 },
    })

    const search = await harness.app.inject({
      method: 'GET',
      url: '/api/search?q=shared%20searchable%20body&sort=newest&filter=markdown&status=ready',
      headers: harness.headers,
    })
    expect(search.statusCode).toBe(200)
    expect(search.json().items).toHaveLength(30)
    expect(search.json()).toMatchObject({
      catalogTotal: 36,
      filteredTotal: 35,
      formatCounts: { all: 35, html: 0, markdown: 35 },
    })

    const cursor = first.json().nextCursor as string
    const tamperedCursor = `${cursor.slice(0, -1)}${cursor.endsWith('x') ? 'y' : 'x'}`
    const tampered = await harness.app.inject({
      method: 'GET',
      url: `/api/gallery?sort=newest&filter=markdown&status=ready&cursor=${encodeURIComponent(tamperedCursor)}`,
      headers: harness.headers,
    })
    expectCursorStale(tampered)

    const changedFormat = await harness.app.inject({
      method: 'GET',
      url: `/api/gallery?sort=newest&filter=html&status=ready&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: harness.headers,
    })
    expectCursorStale(changedFormat)

    const changedStatus = await harness.app.inject({
      method: 'GET',
      url: `/api/gallery?sort=newest&filter=markdown&status=failed&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: harness.headers,
    })
    expectCursorStale(changedStatus)

    const changedSort = await harness.app.inject({
      method: 'GET',
      url: `/api/gallery?sort=title&filter=markdown&status=ready&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: harness.headers,
    })
    expectCursorStale(changedSort)

    const changedQuery = await harness.app.inject({
      method: 'GET',
      url: `/api/search?q=different&sort=newest&filter=markdown&status=ready&cursor=${encodeURIComponent(search.json().nextCursor)}`,
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
      url: `/api/gallery?sort=newest&filter=markdown&status=ready&cursor=${encodeURIComponent(first.json().nextCursor)}`,
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
    await Promise.all(responses.map((response) => waitForRun(harness, response.json().runId)))
    expect(harness.database.prepare('SELECT COUNT(*) AS count FROM artifact').get()).toEqual({
      count: 1,
    })

    const runId = responses[0].json().runId
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

    const { artifactId } = await registerFile(harness, sourcePath)
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
    expect(refreshed.statusCode).toBe(202)
    expect(JSON.stringify(refreshed.json())).not.toContain(sourcePath)
    await waitForRun(harness, refreshed.json().runId)
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/artifacts/${artifactId}`,
      headers: harness.headers,
    })
    expect(detail.json()).toMatchObject({
      id: artifactId,
      status: 'missing',
      thumbnailUrl: expect.any(String),
      errors: [{ code: 'SOURCE_MISSING', stage: 'inspect', retryable: true }],
    })
    expect(JSON.stringify(detail.json())).not.toContain('technicalDetail')

    await writeFile(sourcePath, '# Keep the source')
    const derivedPath = harness.database
      .prepare(
        'SELECT thumbnail_path FROM artifact_generation WHERE artifact_id = ? AND thumbnail_path IS NOT NULL ORDER BY id DESC LIMIT 1',
      )
      .pluck()
      .get(artifactId) as string
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
    const { artifactId } = await registerFile(harness, sourcePath)

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
    const { artifactId } = await registerFile(harness, sourcePath)
    const ready = await artifactDetail(harness, artifactId)
    const successfulThumbnail = ready.thumbnailUrl
    const successfulThumbnailPath = activeThumbnailPath(harness, artifactId)

    harness.setRenderFailure(true)
    const partialResponse = await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/refresh`,
      headers: harness.headers,
    })
    await waitForRun(harness, partialResponse.json().runId)
    expect(await artifactDetail(harness, artifactId)).toMatchObject({
      status: 'partial',
      thumbnailUrl: expect.any(String),
    })
    expect(activeThumbnailPath(harness, artifactId)).toBe(successfulThumbnailPath)

    harness.setRenderFailure(false)
    await writeFile(sourcePath, 'before\0after')
    const failedResponse = await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/retry`,
      headers: harness.headers,
    })
    await waitForRun(harness, failedResponse.json().runId)
    expect(await artifactDetail(harness, artifactId)).toMatchObject({
      status: 'failed',
      thumbnailUrl: expect.any(String),
    })
    expect(activeThumbnailPath(harness, artifactId)).toBe(successfulThumbnailPath)

    await rm(sourcePath)
    const rebuilt = await harness.app.inject({
      method: 'POST',
      url: `/api/artifacts/${artifactId}/rebuild`,
      headers: harness.headers,
    })
    await waitForRun(harness, rebuilt.json().runId)
    expect(await artifactDetail(harness, artifactId)).toMatchObject({
      status: 'missing',
      thumbnailUrl: expect.any(String),
    })
    expect(activeThumbnailPath(harness, artifactId)).toBe(successfulThumbnailPath)
    expect(successfulThumbnail).toEqual(expect.any(String))

    await harness.close()
  })

  it('accepts format-safe relinks without generation changes and routes all processing actions', async () => {
    const harness = await makeHarness()
    const firstPath = join(harness.sourceDirectory, 'first.md')
    const secondPath = join(harness.sourceDirectory, 'second.md')
    await writeFile(firstPath, '# First searchable')
    await writeFile(secondPath, '# Second searchable')
    const { artifactId } = await registerFile(harness, firstPath)

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
      expect(response.statusCode).toBe(202)
      await waitForRun(harness, response.json().runId)
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

async function makeHarness(
  options: {
    beforeRender?: () => Promise<void>
    beforeEnumeration?: () => Promise<void>
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-api-'))
  temporaryDirectories.push(root)
  const sourceDirectory = join(root, 'sources')
  const thumbnailDirectory = join(root, 'derived')
  await mkdir(sourceDirectory)
  await mkdir(thumbnailDirectory)
  const database = openDatabase({ filename: join(root, 'gallery.sqlite') })
  const pathPolicy = await PathPolicy.create([sourceDirectory])
  const routePathPolicy = {
    authorizeFile: pathPolicy.authorizeFile.bind(pathPolicy),
    enumerateFolder: async (sourcePath: string) => {
      await options.beforeEnumeration?.()
      return pathPolicy.enumerateFolder(sourcePath)
    },
  }
  const derivativePathPolicy = await PathPolicy.create([thumbnailDirectory])
  let renderFailure = false
  const processor = new ArtifactProcessor({
    database,
    pathPolicy,
    htmlRenderer: {
      render: async () => {
        await options.beforeRender?.()
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
  const importWorker = new ImportWorker({ processor, concurrency: 2, capacity: 64 })
  const app = buildApp({
    database,
    pathPolicy: routePathPolicy,
    derivativePathPolicy,
    importWorker,
    thumbnailDirectory,
  })
  const headers = {
    host: '127.0.0.1:3000',
    'x-artifact-gallery-token': app.sessionToken,
  }

  return {
    app,
    database,
    headers,
    root,
    sourceDirectory,
    thumbnailDirectory,
    processor,
    importWorker,
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

async function registerFile(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  sourcePath: string,
): Promise<{ runId: number; artifactId: number }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/registrations/file',
    headers: harness.headers,
    payload: { path: sourcePath },
  })
  expect(response.statusCode).toBe(202)
  const runId = response.json().runId as number
  const run = await waitForRun(harness, runId)
  const artifactId = run.items[0]?.artifactId
  expect(artifactId).toEqual(expect.any(Number))
  if (typeof artifactId !== 'number') throw new Error('Registration did not attach an artifact.')
  return { runId, artifactId }
}

async function waitForRun(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  runId: number,
): Promise<{
  status: string
  items: Array<{
    artifactId?: number | null
    [key: string]: unknown
  }>
  [key: string]: unknown
}> {
  await harness.importWorker.onIdle()
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/imports/${runId}`,
      headers: harness.headers,
    })
    const run = response.json() as {
      status: string
      items: Array<{ artifactId?: number | null; [key: string]: unknown }>
      [key: string]: unknown
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return run
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`Import run ${runId} did not become terminal.`)
}

function activeThumbnailPath(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  artifactId: number,
): string {
  return harness.database
    .prepare(
      `SELECT artifact_generation.thumbnail_path
       FROM artifact
       JOIN artifact_generation ON artifact_generation.id = artifact.active_generation_id
       WHERE artifact.id = ?`,
    )
    .pluck()
    .get(artifactId) as string
}

function renderedPreview() {
  return {
    screenshot: Buffer.from('RIFF-api-preview-WEBP'),
    width: 1200,
    height: 800,
    warnings: [] as const,
  }
}
