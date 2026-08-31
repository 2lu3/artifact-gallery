import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  ArtifactCard,
  ArtifactDetail,
  GalleryFilter,
  GalleryPage,
  GallerySortMode,
} from '../shared/contracts'
import { ApiClient, ApiRequestError } from './api-client'

const api = ApiClient.fromTrustedBootstrap()

interface RegistrationRun {
  readonly id: number
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly items: readonly RegistrationItem[]
}

interface RegistrationItem {
  readonly id: number
  readonly name: string
  readonly stage: string
  readonly status: string
  readonly error: { readonly message: string } | null
}

export function App() {
  const [items, setItems] = useState<readonly ArtifactCard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [filter, setFilter] = useState<GalleryFilter>('all')
  const [sort, setSort] = useState<GallerySortMode>('newest')
  const [query, setQuery] = useState('')
  const [acceptedQuery, setAcceptedQuery] = useState('')
  const [registrationOpen, setRegistrationOpen] = useState(false)
  const [selected, setSelected] = useState<ArtifactCard | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const initialListMeasured = useRef(false)
  const lightboxOrigin = useRef<{ element: HTMLElement; artifactId: number; scrollY: number } | null>(null)

  function openLightbox(item: ArtifactCard, element: HTMLElement) {
    lightboxOrigin.current = { element, artifactId: item.id, scrollY: window.scrollY }
    setSelected(item)
  }

  const closeLightbox = useCallback(() => {
    const origin = lightboxOrigin.current
    setSelected(null)
    window.requestAnimationFrame(() => {
      if (!origin) return
      window.scrollTo({ top: origin.scrollY })
      const focusTarget = origin.element.isConnected
        ? origin.element
        : document.querySelector<HTMLElement>(`[data-artifact-id="${origin.artifactId}"]`)
      focusTarget?.focus({ preventScroll: true })
    })
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const next = query.trim()
      if (next !== acceptedQuery) {
        if (next) performance.mark('artifact-gallery-search-accepted')
        setAcceptedQuery(next)
      }
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [acceptedQuery, query])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api
      .get<GalleryPage>(resultsUrl({ filter, query: acceptedQuery, sort }), {
        signal: controller.signal,
      })
      .then((page) => {
        setItems(page.items)
        setNextCursor(page.nextCursor)
        window.requestAnimationFrame(() => {
          if (acceptedQuery) {
            performance.mark('artifact-gallery-search-rendered')
            performance.measure(
              'artifact-gallery-search',
              'artifact-gallery-search-accepted',
              'artifact-gallery-search-rendered',
            )
          } else if (!initialListMeasured.current) {
            initialListMeasured.current = true
            performance.mark('artifact-gallery-initial-interactive')
            performance.measure(
              'artifact-gallery-initial-list',
              'navigationStart',
              'artifact-gallery-initial-interactive',
            )
          }
        })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setError(safeErrorMessage(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [acceptedQuery, filter, reloadKey, sort])

  const counts = useMemo(
    () => ({
      all: items.length,
      html: items.filter(({ format }) => format === 'html').length,
      markdown: items.filter(({ format }) => format === 'markdown').length,
    }),
    [items],
  )

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setError(null)
    try {
      const page = await api.get<GalleryPage>(
        resultsUrl({ filter, query: acceptedQuery, sort, cursor: nextCursor }),
      )
      setItems((existing) => {
        const known = new Set(existing.map(({ id }) => id))
        return [...existing, ...page.items.filter(({ id }) => !known.has(id))]
      })
      setNextCursor(page.nextCursor)
    } catch (cause) {
      setError(safeErrorMessage(cause))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>Artifact Gallery</h1>
        <label className="search-field">
          <span className="sr-only">生成物を検索</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="「青いダッシュボード」「京都の旅行プラン」で検索"
          />
        </label>
        <button className="primary-action" type="button" onClick={() => setRegistrationOpen(true)}>
          <span aria-hidden="true">＋</span> 生成物を登録
        </button>
      </header>

      <main>
        <section className="gallery-toolbar" aria-label="ギャラリーの表示設定">
          <div className="filter-group" aria-label="形式">
            {(['all', 'html', 'markdown'] as const).map((value) => (
              <button
                className="filter-chip"
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {filterLabel(value)}
                {filter === 'all' && !loading ? ` ${counts[value]}` : ''}
              </button>
            ))}
          </div>
          <label className="sort-control">
            <span className="sr-only">並び順</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as GallerySortMode)}>
              <option value="newest">新しい順</option>
              <option value="title">タイトル順</option>
            </select>
          </label>
        </section>

        {loading ? <GalleryStatus title="ギャラリーを読み込み中" message="少しお待ちください。" /> : null}
        {!loading && error ? (
          <GalleryStatus title="ギャラリーを読み込めませんでした" message={error} tone="error" />
        ) : null}
        {!loading && !error && items.length === 0 && acceptedQuery ? (
          <GalleryStatus
            title="検索結果がありません"
            message="検索語や形式フィルターを変えてお試しください。"
          />
        ) : null}
        {!loading && !error && items.length === 0 && !acceptedQuery ? (
          <GalleryStatus
            title="最初の生成物を登録"
            message="HTML または Markdown のファイルかフォルダーを登録できます。"
          />
        ) : null}
        {!loading && !error && items.length > 0 ? (
          <>
            <section className="gallery-grid" aria-label="生成物">
              {items.map((item) => (
                <ArtifactCardView item={item} key={item.id} onOpen={openLightbox} />
              ))}
            </section>
            {nextCursor ? (
              <button className="load-more" type="button" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? '読み込み中…' : 'さらに読み込む'}
              </button>
            ) : null}
          </>
        ) : null}
      </main>

      {registrationOpen ? (
        <div className="modal-layer" role="presentation" onMouseDown={() => setRegistrationOpen(false)}>
          <RegistrationDialog
            onClose={() => setRegistrationOpen(false)}
            onGalleryChanged={() => setReloadKey((value) => value + 1)}
          />
        </div>
      ) : null}
      {selected ? (
        <ArtifactLightbox
          item={selected}
          onClose={closeLightbox}
          onGalleryChanged={() => setReloadKey((value) => value + 1)}
        />
      ) : null}
    </div>
  )
}

function RegistrationDialog({
  onClose,
  onGalleryChanged,
}: {
  onClose: () => void
  onGalleryChanged: () => void
}) {
  const [path, setPath] = useState('')
  const [kind, setKind] = useState<'file' | 'folder'>('file')
  const [run, setRun] = useState<RegistrationRun | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!path.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const response = await api.post<{ runId: number }>(`/api/registrations/${kind}`, {
        path: path.trim(),
      })
      const terminal = await pollImport(response.runId, (next) => setRun(next))
      setRun(terminal)
      onGalleryChanged()
    } catch (cause) {
      setError(safeErrorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function cancel() {
    if (!run) return
    try {
      const next = await api.post<RegistrationRun>(`/api/imports/${run.id}/cancel`)
      setRun({ ...next, items: run.items })
    } catch (cause) {
      setError(safeErrorMessage(cause))
    }
  }

  return (
    <section
      aria-modal="true"
      aria-labelledby="registration-title"
      className="dialog"
      role="dialog"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        aria-label="登録画面を閉じる"
        className="icon-button dialog-close"
        type="button"
        onClick={onClose}
      >
        ×
      </button>
      <h2 id="registration-title">生成物を登録</h2>
      <p>ローカルのファイルまたはフォルダーのパスを入力します。</p>
      <form className="registration-form" onSubmit={submit}>
        <fieldset disabled={submitting}>
          <legend>登録する種類</legend>
          <label>
            <input
              type="radio"
              name="registration-kind"
              value="file"
              checked={kind === 'file'}
              onChange={() => setKind('file')}
            />
            ファイル
          </label>
          <label>
            <input
              type="radio"
              name="registration-kind"
              value="folder"
              checked={kind === 'folder'}
              onChange={() => setKind('folder')}
            />
            フォルダー
          </label>
        </fieldset>
        <label className="path-field">
          <span>ファイルまたはフォルダーのパス</span>
          <input
            type="text"
            value={path}
            disabled={submitting}
            onChange={(event) => setPath(event.target.value)}
            autoComplete="off"
          />
        </label>
        <p className="field-hint">
          単体 HTML の相対画像や CSS も必要な場合は、親フォルダーを登録してください。
        </p>
        <button className="primary-button" type="submit" disabled={!path.trim() || submitting}>
          登録を開始
        </button>
      </form>
      {submitting ? (
        <section className="registration-progress" aria-live="polite">
          <strong>登録中</strong>
          <span>{run ? registrationProgress(run) : '受付中…'}</span>
          {run && (run.status === 'queued' || run.status === 'running') ? (
            <button type="button" onClick={cancel}>キャンセル</button>
          ) : null}
        </section>
      ) : null}
      {run && !submitting ? (
        <section className="registration-progress" aria-live="polite">
          <strong>{registrationResultLabel(run.status)}</strong>
          <span>{registrationProgress(run)}</span>
          {run.items.filter((item) => item.error).map((item) => (
            <p className="item-error" key={item.id}>
              {item.name}: {item.error?.message}
            </p>
          ))}
        </section>
      ) : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </section>
  )
}

function ArtifactCardView({
  item,
  onOpen,
}: {
  item: ArtifactCard
  onOpen: (item: ArtifactCard, element: HTMLElement) => void
}) {
  return (
    <article className={`artifact-card artifact-card--${item.status}`}>
      <button
        className="artifact-card__button"
        data-artifact-id={item.id}
        type="button"
        aria-label={`${item.title}を開く`}
        onClick={(event) => onOpen(item, event.currentTarget)}
      >
        <ProtectedThumbnail item={item} />
        <span className="artifact-card__body">
          <span className="format-label">{item.format.toUpperCase()}</span>
          <strong>{item.title}</strong>
          <span>
            {parentName(item.sourcePath)} · <time dateTime={item.registeredAt}>{formatDate(item.registeredAt)}</time>
            {' · '}{statusLabel(item.status)}
          </span>
        </span>
      </button>
    </article>
  )
}

function ArtifactLightbox({
  item,
  onClose,
  onGalleryChanged,
}: {
  item: ArtifactCard
  onClose: () => void
  onGalleryChanged: () => void
}) {
  const dialog = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [detail, setDetail] = useState<ArtifactDetail | null>(null)
  const [title, setTitle] = useState(item.title)
  const titleDirty = useRef(false)
  const [relinkPath, setRelinkPath] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [alert, setAlert] = useState<string | null>(null)
  const [deleteConfirmation, setDeleteConfirmation] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    api
      .get<ArtifactDetail>(`/api/artifacts/${item.id}`, { signal: controller.signal })
      .then((next) => {
        setDetail(next)
        if (!titleDirty.current) setTitle(next.title)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setAlert(safeErrorMessage(cause))
      })
    return () => controller.abort()
  }, [item.id])

  const current = detail ?? item

  async function saveTitle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busyAction) return
    setBusyAction('title')
    setAlert(null)
    try {
      const next = await api.patch<ArtifactDetail>(`/api/artifacts/${item.id}/title`, {
        title: title.trim() || null,
      })
      setDetail(next)
      setTitle(next.title)
      titleDirty.current = false
      onGalleryChanged()
    } catch (cause) {
      setAlert(safeErrorMessage(cause))
    } finally {
      setBusyAction(null)
    }
  }

  async function process(operation: 'refresh' | 'retry' | 'rebuild') {
    if (busyAction) return
    setBusyAction(operation)
    setAlert(null)
    try {
      const response = await api.post<{ runId: number }>(`/api/artifacts/${item.id}/${operation}`)
      await pollImport(response.runId, () => undefined)
      const next = await api.get<ArtifactDetail>(`/api/artifacts/${item.id}`)
      setDetail(next)
      setTitle(next.title)
      onGalleryChanged()
    } catch (cause) {
      setAlert(safeErrorMessage(cause))
    } finally {
      setBusyAction(null)
    }
  }

  async function platformAction(route: 'open-source' | 'reveal') {
    if (busyAction) return
    setBusyAction(route)
    setAlert(null)
    try {
      await api.post(`/api/artifacts/${item.id}/${route}`)
    } catch (cause) {
      setAlert(safeErrorMessage(cause))
    } finally {
      setBusyAction(null)
    }
  }

  async function relink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busyAction || !relinkPath.trim()) return
    setBusyAction('relink')
    setAlert(null)
    try {
      const next = await api.post<ArtifactDetail>(`/api/artifacts/${item.id}/relink`, {
        sourcePath: relinkPath.trim(),
      })
      setDetail(next)
      setTitle(next.title)
      setRelinkPath('')
      onGalleryChanged()
    } catch (cause) {
      setAlert(safeErrorMessage(cause))
    } finally {
      setBusyAction(null)
    }
  }

  async function deleteCatalogRecord() {
    if (busyAction) return
    setBusyAction('delete')
    setAlert(null)
    try {
      await api.delete(`/api/artifacts/${item.id}`)
      onGalleryChanged()
      onClose()
    } catch (cause) {
      setDeleteConfirmation(false)
      setAlert(safeErrorMessage(cause))
      setBusyAction(null)
    }
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div className="lightbox-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="lightbox"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lightbox-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="lightbox__header">
          <div>
            <span className="format-label">{item.format.toUpperCase()}</span>
            <h2 id="lightbox-title">{current.title}</h2>
          </div>
          <button
            ref={closeButton}
            className="icon-button"
            type="button"
            aria-label="詳細を閉じる"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="lightbox__content">
          <div className="lightbox__preview"><ProtectedThumbnail item={current} /></div>
          <aside className="lightbox__details">
            <p>
              <strong>状態</strong><br />
              <span className="status-value">{statusLabel(current.status)}</span>
              {detail ? <span className="generation-label">世代 {detail.generation}</span> : null}
            </p>
            <p><strong>選択した元ファイル</strong><br /><span className="source-path">{current.sourcePath}</span></p>
            <form className="title-form" onSubmit={saveTitle}>
              <label>
                <span>タイトル</span>
                <input
                  value={title}
                  maxLength={256}
                  onChange={(event) => {
                    titleDirty.current = true
                    setTitle(event.target.value)
                  }}
                />
              </label>
              <button type="submit" disabled={Boolean(busyAction)}>タイトルを保存</button>
            </form>
            <div className="action-grid" aria-label="生成物の操作">
              <button type="button" disabled={Boolean(busyAction)} onClick={() => platformAction('open-source')}>
                元ファイルを開く
              </button>
              <button type="button" disabled={Boolean(busyAction)} onClick={() => platformAction('reveal')}>
                Finderで表示
              </button>
              <button type="button" disabled={Boolean(busyAction)} onClick={() => process('refresh')}>
                更新
              </button>
              <button type="button" disabled={Boolean(busyAction)} onClick={() => process('retry')}>
                再試行
              </button>
              <button type="button" disabled={Boolean(busyAction)} onClick={() => process('rebuild')}>
                再構築
              </button>
            </div>
            {current.status === 'missing' ? (
              <form className="relink-form" onSubmit={relink}>
                <label>
                  <span>新しいファイルのパス</span>
                  <input
                    value={relinkPath}
                    onChange={(event) => setRelinkPath(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button type="submit" disabled={Boolean(busyAction) || !relinkPath.trim()}>
                  再リンク
                </button>
              </form>
            ) : null}
            <button
              className="danger-button"
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => setDeleteConfirmation(true)}
            >
              ギャラリーから削除
            </button>
            {busyAction ? <p className="busy-message" aria-live="polite">処理中…</p> : null}
            {detail?.errors.length ? (
              <section className="detail-errors" aria-label="処理エラー">
                {detail.errors.map((error, index) => (
                  <p key={`${error.code}-${index}`}>{error.message}</p>
                ))}
              </section>
            ) : null}
            {alert ? <p className="inline-error" role="alert">{alert}</p> : null}
          </aside>
        </div>
        {deleteConfirmation ? (
          <div className="confirmation-layer" role="presentation">
            <section className="confirmation" role="alertdialog" aria-labelledby="delete-title" aria-modal="true">
              <h3 id="delete-title">ギャラリー記録を削除</h3>
              <p>プレビュー、検索データ、ギャラリー記録を削除します。</p>
              <p><strong>元ファイルは削除されません。</strong></p>
              <div className="confirmation__actions">
                <button type="button" disabled={Boolean(busyAction)} onClick={() => setDeleteConfirmation(false)}>
                  キャンセル
                </button>
                <button className="danger-button" type="button" disabled={Boolean(busyAction)} onClick={deleteCatalogRecord}>
                  記録だけ削除
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function ProtectedThumbnail({ item }: { item: ArtifactCard }) {
  const [source, setSource] = useState<string | null>(null)
  useEffect(() => {
    if (!item.thumbnailUrl) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    api
      .blob(item.thumbnailUrl, { signal: controller.signal })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob)
        setSource(objectUrl)
      })
      .catch(() => {
        if (!controller.signal.aborted) setSource(null)
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [item.thumbnailUrl])

  if (source) {
    return (
      <span className="artifact-preview">
        <img src={source} loading="lazy" alt={`${item.title}のプレビュー`} />
        {item.status !== 'ready' ? <span className="state-banner">{statusLabel(item.status)}</span> : null}
      </span>
    )
  }
  return (
    <span className="artifact-preview artifact-preview--fallback" role="img" aria-label={`${item.title}のプレビューはありません`}>
      <span>{statusDescription(item.status)}</span>
      <code aria-hidden="true">{item.diagram}</code>
    </span>
  )
}

async function pollImport(
  runId: number,
  onUpdate: (run: RegistrationRun) => void,
): Promise<RegistrationRun> {
  for (;;) {
    const run = await api.get<RegistrationRun>(`/api/imports/${runId}`)
    onUpdate(run)
    if (!['queued', 'running'].includes(run.status)) return run
    await new Promise((resolve) => window.setTimeout(resolve, 120))
  }
}

function registrationProgress(run: RegistrationRun): string {
  if (run.items.length === 0) return run.status === 'queued' ? 'ファイルを確認しています…' : '対象を列挙しています…'
  const completed = run.items.filter((item) => ['completed', 'failed', 'cancelled'].includes(item.status)).length
  const active = run.items.find((item) => item.status === 'processing')
  return `${completed}/${run.items.length}件${active ? ` · ${stageLabel(active.stage)}` : ''}`
}

function registrationResultLabel(status: RegistrationRun['status']): string {
  if (status === 'completed') return '登録完了'
  if (status === 'cancelled') return '登録をキャンセルしました'
  return '一部の項目を登録できませんでした'
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    queued: '待機中', inspect: '確認中', extract: 'テキスト抽出中', render: '描画中', index: '検索準備中', commit: '保存中',
  }
  return labels[stage] ?? '処理中'
}

function parentName(sourcePath: string): string {
  const parts = sourcePath.split(/[\\/]/u).filter(Boolean)
  return parts.at(-2) ?? 'ローカル'
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? '登録日不明'
    : new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(date)
}

function statusLabel(status: ArtifactCard['status']): string {
  return { missing: '参照切れ', processing: '描画中', ready: '登録済み', partial: '一部失敗', failed: '処理失敗' }[status]
}

function statusDescription(status: ArtifactCard['status']): string {
  return {
    missing: '元ファイルが見つかりません', processing: 'プレビューを作成中…', ready: 'プレビューを読み込めません', partial: '利用できる情報を表示しています', failed: 'プレビューを作成できませんでした',
  }[status]
}

function GalleryStatus({
  title,
  message,
  tone = 'neutral',
}: {
  title: string
  message: string
  tone?: 'neutral' | 'error'
}) {
  return (
    <section className={`gallery-status gallery-status--${tone}`} aria-live="polite">
      <h2>{title}</h2>
      <p>{message}</p>
    </section>
  )
}

function filterLabel(filter: GalleryFilter): string {
  if (filter === 'all') return 'すべて'
  if (filter === 'html') return 'HTML'
  return 'Markdown'
}

function resultsUrl({
  cursor,
  filter,
  query,
  sort,
}: {
  cursor?: string
  filter: GalleryFilter
  query: string
  sort: GallerySortMode
}): string {
  const parameters = new URLSearchParams({ filter, sort, status: 'all' })
  if (cursor) parameters.set('cursor', cursor)
  if (query) {
    parameters.set('q', query)
    return `/api/search?${parameters.toString()}`
  }
  return `/api/gallery?${parameters.toString()}`
}

function safeErrorMessage(error: unknown): string {
  return error instanceof ApiRequestError ? error.publicMessage : 'もう一度お試しください。'
}
