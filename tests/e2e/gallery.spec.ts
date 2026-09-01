import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'

import { createServerRuntime, type ServerRuntimeOptions } from '../../src/server/runtime.js'

test.describe.serial('Artifact Gallery', () => {
  let application: Awaited<ReturnType<typeof createServerRuntime>> | undefined
  let baseURL: string
  let root: string
  let sourceDirectory: string
  let thumbnailDirectory: string
  let databaseFilename: string

  test.beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'artifact-gallery-e2e-'))
    sourceDirectory = join(root, 'sources')
    thumbnailDirectory = join(root, 'thumbnails')
    await mkdir(sourceDirectory)
    await mkdir(thumbnailDirectory)
    const port = await availablePort()
    databaseFilename = join(root, 'catalog.sqlite')
    const options: ServerRuntimeOptions = {
      databaseFilename,
      thumbnailDirectory,
      allowedRoots: [sourceDirectory],
      clientDirectory: join(process.cwd(), 'dist'),
      port,
    }
    application = await createServerRuntime(options)
    await application.listen({ host: '127.0.0.1', port })
    baseURL = `http://127.0.0.1:${port}`
  })

  test.afterAll(async () => {
    await application?.close()
    await rm(root, { recursive: true, force: true })
  })

  test('shows the approved first-use gallery and registration entry point', async ({ page }) => {
    await page.goto(baseURL)

    await expect(page.getByRole('heading', { name: 'Artifact Gallery', level: 1 })).toBeVisible()
    await expect(page.getByRole('searchbox', { name: '生成物を検索' })).toBeVisible()
    await expect(page.getByRole('button', { name: '生成物を登録' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '最初の生成物を登録' })).toBeVisible()
    await expect(
      page.getByText('HTML または Markdown のファイルかフォルダーを登録できます。'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'すべて' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  test('registers a Markdown file and renders its gallery card', async ({ page }) => {
    const sourcePath = join(sourceDirectory, 'kyoto-plan.md')
    await writeFile(sourcePath, '# 京都旅行プラン\n\n3日間で巡る、建築と喫茶店。')
    await page.goto(baseURL)

    await page.getByRole('button', { name: '生成物を登録' }).click()
    const dialog = page.getByRole('dialog', { name: '生成物を登録' })
    await dialog.getByLabel('ファイルまたはフォルダーのパス').fill(sourcePath)
    await dialog.getByRole('button', { name: '登録を開始' }).click()

    await expect(dialog.getByText('登録中')).toBeVisible()
    const card = page.getByRole('button', { name: /京都旅行プラン/u })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.getByText('MARKDOWN')).toBeVisible()
    await expect(card.locator('img')).toHaveAttribute('loading', 'lazy')
    await expect(card.locator('img')).toHaveAttribute('alt', '京都旅行プランのプレビュー')
    await expect(card.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/u)
  })

  test('registers an HTML file through the same real processing boundary', async ({ page }) => {
    const sourcePath = join(sourceDirectory, 'dashboard.html')
    await writeFile(sourcePath, '<!doctype html><title>売上ダッシュボード</title><h1>12.4M</h1>')
    await page.goto(baseURL)

    await registerPath(page, sourcePath, 'file')

    const card = page.getByRole('button', { name: /売上ダッシュボード/u })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.getByText('HTML', { exact: true })).toBeVisible()
  })

  test('registers a folder recursively and reports an item-level symlink failure', async ({
    page,
  }) => {
    const folder = join(sourceDirectory, 'folder-import')
    await mkdir(join(folder, 'notes'), { recursive: true })
    await writeFile(join(folder, 'landing.html'), '<title>Folder Landing</title><p>from folder</p>')
    await writeFile(join(folder, 'notes', 'readme.md'), '# Folder Notes')
    await symlink(join(folder, 'notes', 'readme.md'), join(folder, 'linked.md'))
    await page.goto(baseURL)

    const dialog = await registerPath(page, folder, 'folder')

    await expect(page.getByRole('button', { name: /Folder Landing/u })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByRole('button', { name: /Folder Notes/u })).toBeVisible()
    await expect(dialog.getByText(/linked\.md:/u)).toBeVisible()
    await expect(dialog.getByText(/symbolic link/i)).toBeVisible()
  })

  test('allows a running folder registration to be cancelled without losing completed work', async ({
    page,
  }) => {
    const folder = join(sourceDirectory, 'cancel-import')
    await mkdir(folder)
    for (let index = 0; index < 24; index += 1) {
      await writeFile(
        join(folder, `${index.toString().padStart(2, '0')}.html`),
        `<title>Cancel item ${index}</title><main>${'<section>content</section>'.repeat(300)}</main>`,
      )
    }
    await page.goto(baseURL)
    await page.getByRole('button', { name: '生成物を登録' }).click()
    const dialog = page.getByRole('dialog', { name: '生成物を登録' })
    await dialog.getByRole('radio', { name: 'フォルダー' }).check()
    await dialog.getByLabel('ファイルまたはフォルダーのパス').fill(folder)
    await dialog.getByRole('button', { name: '登録を開始' }).click()

    await expect(dialog.getByText(/[1-9]\d*\/24件/u)).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'キャンセル' }).click({ timeout: 15_000 })

    await expect(dialog.getByText('登録をキャンセルしました')).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByText(/[1-9]\d*件登録 · [1-9]\d*件未開始/u)).toBeVisible()
    await expect(page.getByRole('button', { name: /Cancel item 0/u })).toBeVisible()
  })

  test('prevents duplicate cards when a path is submitted again rapidly', async ({ page }) => {
    const sourcePath = join(sourceDirectory, 'duplicate.md')
    await writeFile(sourcePath, '# Duplicate Guard')
    await page.goto(baseURL)
    const secondPage = await page.context().newPage()
    await secondPage.goto(baseURL)
    for (const candidate of [page, secondPage]) {
      await candidate.getByRole('button', { name: '生成物を登録' }).click()
      await candidate
        .getByRole('dialog', { name: '生成物を登録' })
        .getByLabel('ファイルまたはフォルダーのパス')
        .fill(sourcePath)
    }
    let arrivalCount = 0
    let markBothArrived!: () => void
    const bothArrived = new Promise<void>((resolve) => {
      markBothArrived = resolve
    })
    let releaseSubmissions!: () => void
    const submissionsReleased = new Promise<void>((resolve) => {
      releaseSubmissions = resolve
    })
    await page.context().route('**/api/registrations/file', async (route) => {
      arrivalCount += 1
      if (arrivalCount === 2) markBothArrived()
      await submissionsReleased
      await route.continue()
    })
    const submits = Promise.all([
      page
        .getByRole('dialog', { name: '生成物を登録' })
        .getByRole('button', { name: '登録を開始' })
        .click(),
      secondPage
        .getByRole('dialog', { name: '生成物を登録' })
        .getByRole('button', { name: '登録を開始' })
        .click(),
    ])
    await bothArrived
    await expect(
      page.getByRole('dialog', { name: '生成物を登録' }).getByText('登録完了'),
    ).toHaveCount(0)
    await expect(
      secondPage.getByRole('dialog', { name: '生成物を登録' }).getByText('登録完了'),
    ).toHaveCount(0)
    releaseSubmissions()
    await submits
    await expect(
      page.getByRole('dialog', { name: '生成物を登録' }).getByText('登録完了'),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      secondPage.getByRole('dialog', { name: '生成物を登録' }).getByText('登録完了'),
    ).toBeVisible({ timeout: 30_000 })

    await expect(page.getByRole('button', { name: /Duplicate Guard/u })).toHaveCount(1)
    await secondPage.close()
  })

  test('keeps the trusted bootstrap token out of URLs, storage, DOM, and console', async ({
    page,
  }) => {
    const apiRequests: Array<{ url: string; token: string | undefined }> = []
    const consoleMessages: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/')) {
        apiRequests.push({
          url: request.url(),
          token: request.headers()['x-artifact-gallery-token'],
        })
      }
    })
    page.on('console', (message) => consoleMessages.push(message.text()))

    await page.goto(baseURL)
    await expect(page.getByRole('heading', { name: 'Artifact Gallery' })).toBeVisible()

    const request = apiRequests.find(({ url }) => url.includes('/api/gallery'))
    const tokenIsValid =
      typeof request?.token === 'string' && /^[A-Za-z0-9_-]{40,}$/u.test(request.token)
    expect(tokenIsValid).toBe(true)
    const tokenIsAbsentFromUrl =
      typeof request?.token === 'string' && !request.url.includes(request.token)
    expect(tokenIsAbsentFromUrl).toBe(true)
    expect(new URL(page.url()).search).toBe('')
    expect(
      await page.evaluate(() => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
        bootstrap: document.getElementById('artifact-gallery-bootstrap'),
      })),
    ).toEqual({ local: [], session: [], bootstrap: null })
    const tokenIsAbsentFromConsole =
      typeof request?.token === 'string' &&
      consoleMessages.every((message) => !message.includes(request.token as string))
    expect(tokenIsAbsentFromConsole).toBe(true)
  })

  test('debounces search, cancels obsolete results, filters, sorts, and shows no results', async ({
    page,
  }) => {
    const kyotoPath = join(sourceDirectory, 'search-kyoto.md')
    const salesPath = join(sourceDirectory, 'search-sales.html')
    await writeFile(kyotoPath, '# 京都旅行プラン\n\n建築と喫茶店')
    await writeFile(salesPath, '<title>売上ダッシュボード</title><p>四半期の売上</p>')
    let releaseSlowSearch!: () => void
    const slowSearchReleased = new Promise<void>((resolve) => {
      releaseSlowSearch = resolve
    })
    let slowSearchStarted!: () => void
    const slowSearchRequest = new Promise<void>((resolve) => {
      slowSearchStarted = resolve
    })
    await page.route('**/api/search?*', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('q')
      if (query === '京都') {
        slowSearchStarted()
        await slowSearchReleased
      }
      await route.continue().catch(() => undefined)
    })
    await page.goto(baseURL)
    await registerPath(page, kyotoPath, 'file')
    await page.getByRole('button', { name: '登録画面を閉じる' }).click()
    await registerPath(page, salesPath, 'file')
    await page.getByRole('button', { name: '登録画面を閉じる' }).click()
    const search = page.getByRole('searchbox', { name: '生成物を検索' })

    await search.fill('京都')
    await slowSearchRequest
    await search.fill('売上')
    const salesCards = page.getByRole('button', { name: /売上ダッシュボード/u })
    await expect(salesCards.first()).toBeVisible()
    releaseSlowSearch()
    await expect(salesCards.first()).toBeVisible()
    await expect(page.getByRole('button', { name: /京都旅行プラン/u })).toHaveCount(0)

    await search.fill('存在しない検索語')
    await expect(page.getByRole('heading', { name: '検索結果がありません' })).toBeVisible()

    await search.fill('')
    await page.getByRole('button', { name: 'HTML' }).click()
    await expect(salesCards.first()).toBeVisible()
    await expect(page.getByRole('button', { name: /京都旅行プラン/u })).toHaveCount(0)
    await page.getByRole('button', { name: /^すべて/u }).click()
    await page.getByLabel('並び順').selectOption('title')
    await expect(page.getByLabel('並び順')).toHaveValue('title')
    await expect(page.locator('.artifact-card strong').first()).toBeVisible()
    const sortedTitles = await page.locator('.artifact-card strong').allTextContents()
    expect(sortedTitles.length).toBeGreaterThan(1)
    expect(sortedTitles).toEqual([...sortedTitles].sort())

    const searchMeasurements = await page.evaluate(() =>
      performance.getEntriesByName('artifact-gallery-search').map((entry) => entry.duration),
    )
    expect(searchMeasurements.length).toBeGreaterThan(0)
  })

  test('opens a no-navigation lightbox and restores query, filter, sort, scroll, and focus', async ({
    page,
  }) => {
    const sourcePath = join(sourceDirectory, 'restorable-card.md')
    await writeFile(sourcePath, '# Restorable Card\n\nLightbox state anchor.')
    await page.goto(baseURL)
    await registerPath(page, sourcePath, 'file')
    await page.getByRole('button', { name: '登録画面を閉じる' }).click()
    await page.setViewportSize({ width: 900, height: 320 })
    const search = page.getByRole('searchbox', { name: '生成物を検索' })
    await search.fill('Restorable')
    await page.getByRole('button', { name: 'Markdown' }).click()
    await page.getByLabel('並び順').selectOption('title')
    const card = page.getByRole('button', { name: /Restorable Card/u })
    await expect(card).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await card.focus()
    const before = await page.evaluate(() => ({ url: location.href, scrollY }))

    await card.click()

    const lightbox = page.getByRole('dialog', { name: 'Restorable Card' })
    await expect(lightbox).toBeVisible()
    expect(page.url()).toBe(before.url)
    await expect(search).toHaveValue('Restorable')
    await expect(page.getByRole('button', { name: 'Markdown' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByLabel('並び順')).toHaveValue('title')
    await page.keyboard.press('Escape')
    await expect(lightbox).toHaveCount(0)
    await expect(card).toBeFocused()
    expect(Math.abs((await page.evaluate(() => scrollY)) - before.scrollY)).toBeLessThanOrEqual(1)
  })

  test('updates title and preview and exposes safe source actions from the lightbox', async ({
    page,
  }) => {
    const sourcePath = join(sourceDirectory, 'lightbox-actions.md')
    await writeFile(sourcePath, '# Action Card\n\nVersion one.')
    await page.goto(baseURL)
    await registerPath(page, sourcePath, 'file')
    await page.getByRole('button', { name: '登録画面を閉じる' }).click()
    await page.getByRole('button', { name: /Action Card/u }).click()
    const lightbox = page.getByRole('dialog', { name: 'Action Card' })

    await lightbox.getByLabel('タイトル').fill('Renamed Artifact')
    await lightbox.getByRole('button', { name: 'タイトルを保存' }).click()
    const renamedLightbox = page.getByRole('dialog', { name: 'Renamed Artifact' })
    await expect(renamedLightbox.getByRole('heading', { name: 'Renamed Artifact' })).toBeVisible()
    await writeFile(sourcePath, '# Updated From Source\n\nVersion two.')
    await renamedLightbox.getByRole('button', { name: '更新' }).click()
    await expect(renamedLightbox.getByText('世代 2')).toBeVisible({ timeout: 30_000 })
    await expect(renamedLightbox.getByRole('heading', { name: 'Renamed Artifact' })).toBeVisible()

    await renamedLightbox.getByRole('button', { name: '元ファイルを開く' }).click()
    await expect(renamedLightbox.getByRole('alert')).toHaveText(
      'This action is not supported on the current platform.',
    )
    await renamedLightbox.getByRole('button', { name: 'Finderで表示' }).click()
    await expect(renamedLightbox.getByRole('alert')).toHaveText(
      'This action is not supported on the current platform.',
    )
  })

  test('keeps the last preview while missing and validates relink before retrying', async ({
    page,
  }) => {
    const sourcePath = join(sourceDirectory, 'missing-original.md')
    const wrongFormatPath = join(sourceDirectory, 'wrong-format.html')
    const replacementPath = join(sourceDirectory, 'missing-replacement.md')
    await writeFile(sourcePath, '# Missing Original\n\nLast good preview.')
    await writeFile(wrongFormatPath, '<title>Wrong format</title>')
    await writeFile(replacementPath, '# Relinked Content\n\nNew source.')
    await page.goto(baseURL)
    await registerPath(page, sourcePath, 'file')
    await page.getByRole('button', { name: '登録画面を閉じる' }).click()
    await page.getByRole('button', { name: /Missing Original/u }).click()
    const lightbox = page.getByRole('dialog', { name: 'Missing Original' })
    await rm(sourcePath)

    await lightbox.getByRole('button', { name: '更新' }).click()

    await expect(lightbox.locator('.status-value')).toHaveText('参照切れ', { timeout: 30_000 })
    await expect(lightbox.locator('.lightbox__preview img')).toBeVisible()
    const relink = lightbox.getByLabel('新しいファイルのパス')
    await relink.fill(wrongFormatPath)
    await lightbox.getByRole('button', { name: '再リンク' }).click()
    await expect(lightbox.getByRole('alert')).toHaveText('This file format is not supported.')
    await expect(lightbox.locator('.status-value')).toHaveText('参照切れ')

    await relink.fill(replacementPath)
    await lightbox.getByRole('button', { name: '再リンク' }).click()
    await expect(lightbox.locator('.status-value')).toHaveText('登録済み')
    await expect(lightbox.getByText(replacementPath)).toBeVisible()
    await lightbox.getByRole('button', { name: '再試行' }).click()
    await expect(
      page.getByRole('dialog', { name: 'Relinked Content' }).getByText('世代 2'),
    ).toBeVisible({
      timeout: 30_000,
    })
  })

  test('requires confirmation and deletes only the catalog record', async ({ page }) => {
    const sourcePath = join(sourceDirectory, 'catalog-only-delete.md')
    await writeFile(sourcePath, '# Catalog Only Delete\n\nThe source must survive.')
    await page.goto(baseURL)
    await registerPath(page, sourcePath, 'file')
    await page.getByRole('button', { name: '登録画面を閉じる' }).click()
    await page.getByRole('button', { name: /Catalog Only Delete/u }).click()
    const lightbox = page.getByRole('dialog', { name: 'Catalog Only Delete' })

    await lightbox.getByRole('button', { name: 'ギャラリーから削除' }).click()

    const confirmation = page.getByRole('alertdialog', { name: 'ギャラリー記録を削除' })
    const cancelDelete = confirmation.getByRole('button', { name: 'キャンセル' })
    await expect(confirmation.getByText('元ファイルは削除されません。')).toBeVisible()
    await expect(cancelDelete).toBeFocused()
    await expect(page.locator('.lightbox')).toHaveAttribute('inert', '')
    await expect(page.locator('.lightbox')).toHaveAttribute('aria-hidden', 'true')
    await page.keyboard.press('Shift+Tab')
    await expect(confirmation.getByRole('button', { name: '記録だけ削除' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(cancelDelete).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(confirmation).toHaveCount(0)
    await expect(lightbox).toBeVisible()
    await expect(lightbox.getByRole('button', { name: 'ギャラリーから削除' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(lightbox.getByRole('button', { name: '詳細を閉じる' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(lightbox.getByRole('button', { name: 'ギャラリーから削除' })).toBeFocused()

    await lightbox.getByRole('button', { name: 'ギャラリーから削除' }).click()
    await confirmation.getByRole('button', { name: '記録だけ削除' }).click()
    await expect(page.getByRole('button', { name: /Catalog Only Delete/u })).toHaveCount(0)
    await expect(access(sourcePath)).resolves.toBeUndefined()
  })

  test('loads stable cursor pages of 30 cards and then the remaining cards', async ({ page }) => {
    seedReadyCards(databaseFilename, 35)
    await page.goto(baseURL)
    await page.getByRole('searchbox', { name: '生成物を検索' }).fill('Cursor Card')
    const cards = page.locator('.artifact-card')

    await expect(cards).toHaveCount(30)
    await expect(page.getByRole('button', { name: 'すべて 35' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'HTML 0' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Markdown 35' })).toBeVisible()
    await page.getByRole('button', { name: 'HTML 0' }).click()
    await expect(page.getByRole('heading', { name: '検索結果がありません' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '最初の生成物を登録' })).toHaveCount(0)
    await page.getByRole('button', { name: 'すべて 35' }).click()
    const nextPageResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        ['/api/gallery', '/api/search'].includes(url.pathname) && url.searchParams.has('cursor')
      )
    })
    await page.getByRole('button', { name: 'さらに読み込む' }).click()
    expect((await nextPageResponse).status()).toBe(200)

    await expect(cards).toHaveCount(35)
    await expect(page.getByRole('button', { name: 'さらに読み込む' })).toHaveCount(0)
    await expect(cards.first().locator('[role="img"]')).toHaveAttribute(
      'aria-label',
      /プレビューはありません/u,
    )
  })

  test('defers authenticated thumbnail requests until a below-fold card nears the viewport', async ({
    page,
  }) => {
    const sourcePath = join(sourceDirectory, 'lazy-thumbnail-source.html')
    await writeFile(
      sourcePath,
      '<!doctype html><title>Lazy Thumbnail Source</title><h1>Creates a real protected WebP.</h1>',
    )
    await page.goto(baseURL)
    await registerPath(page, sourcePath, 'file')
    await page.getByRole('button', { name: '登録画面を閉じる' }).click()
    const thumbnailPath = join(thumbnailDirectory, 'lazy-thumbnail.webp')
    await writeFile(
      thumbnailPath,
      Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuUAAA=', 'base64'),
    )
    seedThumbnailCards(databaseFilename, thumbnailPath, 20)
    await page.setViewportSize({ width: 900, height: 500 })
    const thumbnailRequests: string[] = []
    const thumbnailStatuses: number[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/thumbnails/')) {
        thumbnailRequests.push(request.url())
      }
    })
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/api/thumbnails/')) {
        thumbnailStatuses.push(response.status())
      }
    })

    const galleryResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/gallery' && !url.searchParams.has('cursor')
    })
    await page.reload()
    const galleryPage = (await (await galleryResponse).json()) as {
      items: Array<{ title: string; thumbnailUrl: string | null }>
    }
    const belowFoldThumbnailUrl = galleryPage.items.find(
      (item) => item.title === 'Lazy Thumbnail 00',
    )?.thumbnailUrl
    expect(belowFoldThumbnailUrl).toBeTruthy()
    const absoluteBelowFoldThumbnailUrl = new URL(belowFoldThumbnailUrl!, baseURL).href
    const belowFold = page.getByRole('button', { name: /Lazy Thumbnail 00/u })
    await expect(belowFold).toBeAttached()
    expect((await belowFold.boundingBox())?.y).toBeGreaterThan(820)
    await page.waitForTimeout(250)
    expect(thumbnailStatuses.every((status) => status === 200)).toBe(true)
    expect(thumbnailRequests).not.toContain(absoluteBelowFoldThumbnailUrl)
    expect(thumbnailRequests.length).toBeLessThan(21)
    await expect(belowFold.locator('img')).toHaveCount(0)

    await belowFold.scrollIntoViewIfNeeded()

    await expect.poll(() => thumbnailRequests).toContain(absoluteBelowFoldThumbnailUrl)
    await expect(belowFold.locator('img')).toBeVisible()
  })

  test('discards a late load-more page after the gallery context changes', async ({ page }) => {
    seedReadyCards(databaseFilename, 35)
    seedRecoveryCards(databaseFilename)
    let releasePage!: () => void
    const pageReleased = new Promise<void>((resolve) => {
      releasePage = resolve
    })
    let markPageStarted!: () => void
    const pageStarted = new Promise<void>((resolve) => {
      markPageStarted = resolve
    })
    await page.route('**/api/gallery?*', async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.has('cursor') && !url.searchParams.has('format')) {
        markPageStarted()
        await pageReleased
      }
      await route.continue().catch(() => undefined)
    })
    await page.goto(baseURL)

    await page.getByRole('button', { name: 'さらに読み込む' }).click()
    await pageStarted
    await page.getByRole('button', { name: /^HTML \d+$/u }).click()
    await expect(page.getByRole('button', { name: /^HTML \d+$/u })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.locator('.artifact-card').first()).toBeVisible()
    releasePage()
    await page.waitForTimeout(250)

    await expect
      .poll(async () => page.locator('.artifact-card .format-label').allTextContents())
      .toEqual(expect.arrayContaining(['HTML']))
    expect(await page.locator('.artifact-card .format-label').allTextContents()).not.toContain(
      'MARKDOWN',
    )
    await expect(page.getByRole('button', { name: 'さらに読み込む' })).toHaveCount(0)
  })

  test('renders processing, partial, and failed cards with safe recovery details', async ({
    page,
  }) => {
    seedRecoveryCards(databaseFilename)
    await page.goto(baseURL)

    await expect(
      page.getByRole('button', { name: /State Processing/u }).getByText('描画中'),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /State Partial/u }).getByText('一部失敗'),
    ).toBeVisible()
    const failed = page.getByRole('button', { name: /State Failed/u })
    await expect(failed.getByText('処理失敗')).toBeVisible()
    await failed.click()
    const lightbox = page.getByRole('dialog', { name: 'State Failed' })
    await expect(lightbox.getByText('The preview could not be rendered.')).toBeVisible()
    await expect(lightbox).not.toContainText('/private/internal-render-command')
  })

  test('recovers a real Markdown parse failure through retry', async ({ page }) => {
    const sourcePath = join(sourceDirectory, 'broken-markdown.md')
    await writeFile(sourcePath, 'before\0after')
    await page.goto(baseURL)
    await registerPath(page, sourcePath, 'file')
    await page.getByRole('button', { name: '登録画面を閉じる' }).click()
    await page.getByLabel('並び順').selectOption('title')
    await page.getByRole('button', { name: /broken-markdown\.md/u }).click()
    const failedLightbox = page.getByRole('dialog', { name: 'broken-markdown.md' })
    await expect(failedLightbox.locator('.status-value')).toHaveText('処理失敗')
    await expect(failedLightbox.getByText('The Markdown could not be read.')).toBeVisible()
    await writeFile(sourcePath, '# Recovered Markdown\n\nRetry succeeded.')

    await failedLightbox.getByRole('button', { name: '再試行' }).click()

    const recovered = page.getByRole('dialog', { name: 'Recovered Markdown' })
    await expect(recovered.locator('.status-value')).toHaveText('登録済み', { timeout: 30_000 })
    await expect(recovered.getByText('世代 2')).toBeVisible()
  })

  test('shows a safe structured gallery API error instead of a blank screen', async ({ page }) => {
    await page.route('**/api/gallery?*', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'DATABASE_BUSY',
            stage: 'catalog',
            retryable: true,
            message: 'The gallery is temporarily busy.',
          },
        }),
      })
    })
    await page.goto(baseURL)

    await expect(
      page.getByRole('heading', { name: 'ギャラリーを読み込めませんでした' }),
    ).toBeVisible()
    await expect(page.getByText('The gallery is temporarily busy.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Artifact Gallery' })).toBeVisible()
  })

  test('keeps the lightbox trapped, labelled, and usable at mobile width', async ({ page }) => {
    const sourcePath = join(sourceDirectory, 'mobile-focus.md')
    await writeFile(sourcePath, '# Mobile Focus\n\nAccessible overlay.')
    await page.goto(baseURL)
    await registerPath(page, sourcePath, 'file')
    await page.getByRole('button', { name: '登録画面を閉じる' }).click()
    await page.getByRole('searchbox', { name: '生成物を検索' }).fill('Mobile Focus')
    await page.setViewportSize({ width: 390, height: 720 })
    await page.getByRole('button', { name: /Mobile Focus/u }).click()
    const lightbox = page.getByRole('dialog', { name: 'Mobile Focus' })

    await expect(lightbox).toHaveAttribute('aria-modal', 'true')
    await expect(lightbox.getByRole('button', { name: '詳細を閉じる' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(lightbox.getByRole('button', { name: 'ギャラリーから削除' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(lightbox.getByRole('button', { name: '詳細を閉じる' })).toBeFocused()
    expect((await lightbox.boundingBox())?.width).toBeLessThanOrEqual(390)
  })
})

async function registerPath(page: Page, path: string, kind: 'file' | 'folder') {
  await page.getByRole('button', { name: '生成物を登録' }).click()
  const dialog = page.getByRole('dialog', { name: '生成物を登録' })
  await dialog.getByRole('radio', { name: kind === 'file' ? 'ファイル' : 'フォルダー' }).check()
  await dialog.getByLabel('ファイルまたはフォルダーのパス').fill(path)
  await dialog.getByRole('button', { name: '登録を開始' }).click()
  await expect(dialog.getByText(/登録完了|一部の項目を登録できませんでした/u)).toBeVisible({
    timeout: 30_000,
  })
  return dialog
}

function seedReadyCards(filename: string, count: number) {
  const database = new Database(filename)
  const existingCount = Number(
    database
      .prepare("SELECT COUNT(*) FROM artifact WHERE source_path LIKE '/e2e/cursor-%'")
      .pluck()
      .get(),
  )
  const additions = Math.max(0, count - existingCount)
  const now = '2026-09-01T00:00:00.000Z'
  const insertArtifact = database.prepare(
    `INSERT OR IGNORE INTO artifact
      (source_path, format, derived_title, source_status, created_at, updated_at, registered_at, generation_counter)
     VALUES (?, 'markdown', ?, 'available', ?, ?, ?, 1)`,
  )
  const artifactId = database.prepare('SELECT id FROM artifact WHERE source_path = ?').pluck()
  const insertGeneration = database.prepare(
    `INSERT OR IGNORE INTO artifact_generation
      (artifact_id, generation, job_status, content_status, render_status, index_status, extracted_text, extractor_version, completed_at)
     VALUES (?, 1, 'idle', 'ready', 'ready', 'ready', ?, 'e2e', ?)`,
  )
  const generationId = database
    .prepare('SELECT id FROM artifact_generation WHERE artifact_id = ? AND generation = 1')
    .pluck()
  const activate = database.prepare('UPDATE artifact SET active_generation_id = ? WHERE id = ?')
  const showInSearch = database.prepare(
    `INSERT OR IGNORE INTO artifact_search_visibility (artifact_id, generation_id, state, updated_at)
     VALUES (?, ?, 'visible', ?)`,
  )
  const insertSearchDocument = database.prepare(
    `INSERT OR IGNORE INTO artifact_search_document
      (generation_id, artifact_id, generation, user_title_normalized, derived_title_normalized, body_normalized, path_segments_normalized)
     VALUES (?, ?, 1, '', ?, ?, ?)`,
  )
  database.transaction(() => {
    for (let index = 0; index < additions; index += 1) {
      const sourcePath = `/e2e/cursor-${index.toString().padStart(2, '0')}.md`
      const title = `Cursor Card ${index.toString().padStart(2, '0')}`
      insertArtifact.run(sourcePath, title, now, now, now)
      const id = artifactId.get(sourcePath) as number
      const body = `Cursor body ${index}`
      insertGeneration.run(id, body, now)
      const currentGenerationId = generationId.get(id) as number
      activate.run(currentGenerationId, id)
      showInSearch.run(id, currentGenerationId, now)
      insertSearchDocument.run(
        currentGenerationId,
        id,
        title.toLowerCase(),
        body.toLowerCase(),
        sourcePath,
      )
    }
  })()
  database.close()
}

function seedRecoveryCards(filename: string) {
  const database = new Database(filename)
  const now = '2999-09-01T00:00:00.000Z'
  const insertArtifact = database.prepare(
    `INSERT OR IGNORE INTO artifact
      (source_path, format, derived_title, source_status, created_at, updated_at, registered_at, generation_counter)
     VALUES (?, 'html', ?, 'available', ?, ?, ?, 1)`,
  )
  const artifactId = database.prepare('SELECT id FROM artifact WHERE source_path = ?').pluck()
  const insertGeneration = database.prepare(
    `INSERT OR IGNORE INTO artifact_generation
      (artifact_id, generation, job_status, content_status, render_status, index_status, extracted_text, extractor_version)
     VALUES (?, 1, ?, ?, ?, ?, ?, 'e2e')`,
  )
  database.transaction(() => {
    const states = [
      ['processing', 'State Processing', 'processing', 'pending', 'pending', 'pending'],
      ['partial', 'State Partial', 'idle', 'ready', 'failed', 'ready'],
      ['failed', 'State Failed', 'idle', 'failed', 'failed', 'failed'],
    ] as const
    for (const [slug, title, job, content, render, index] of states) {
      const sourcePath = `/e2e/state-${slug}.html`
      insertArtifact.run(sourcePath, title, now, now, now)
      const id = artifactId.get(sourcePath) as number
      insertGeneration.run(id, job, content, render, index, `${title} body`)
      if (slug === 'failed') {
        database
          .prepare(
            `INSERT INTO artifact_error
              (artifact_id, generation_id, code, stage, retryable, user_message, technical_detail, occurred_at)
             SELECT ?, NULL, 'HTML_RENDER_FAILED', 'render', 1, ?, ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM artifact_error WHERE artifact_id = ? AND code = 'HTML_RENDER_FAILED'
             )`,
          )
          .run(
            id,
            'The preview could not be rendered.',
            '/private/internal-render-command',
            now,
            id,
          )
      }
    }
  })()
  database.close()
}

function seedThumbnailCards(filename: string, thumbnailPath: string, count: number) {
  const database = new Database(filename)
  const now = '2998-09-01T00:00:00.000Z'
  const insertArtifact = database.prepare(
    `INSERT INTO artifact
      (source_path, format, derived_title, source_status, created_at, updated_at, registered_at, generation_counter)
     VALUES (?, 'markdown', ?, 'available', ?, ?, ?, 1)`,
  )
  const insertGeneration = database.prepare(
    `INSERT INTO artifact_generation
      (artifact_id, generation, job_status, content_status, render_status, index_status, extracted_text, extractor_version, thumbnail_path, completed_at)
     VALUES (?, 1, 'idle', 'ready', 'ready', 'ready', ?, 'e2e', ?, ?)`,
  )
  const activate = database.prepare('UPDATE artifact SET active_generation_id = ? WHERE id = ?')
  database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const title = `Lazy Thumbnail ${index.toString().padStart(2, '0')}`
      const artifact = insertArtifact.run(`/e2e/lazy-thumbnail-${index}.md`, title, now, now, now)
      const artifactId = Number(artifact.lastInsertRowid)
      const generation = insertGeneration.run(artifactId, `${title} body`, thumbnailPath, now)
      activate.run(Number(generation.lastInsertRowid), artifactId)
    }
  })()
  database.close()
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('An E2E port could not be allocated.'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}
