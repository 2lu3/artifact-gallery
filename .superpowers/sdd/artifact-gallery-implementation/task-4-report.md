# Task 4 report

## Status

Implemented the default-deny Playwright HTML rendering boundary with one reusable Chromium process, disposable contexts, a two-context concurrency cap, and no HTTP asset proxy.

## RED / GREEN evidence

Strict TDD was used for each new production branch. Representative observed RED failures and their GREEN results:

| Behavior | RED evidence | GREEN evidence |
| --- | --- | --- |
| HTML input limit | Expected `INPUT_TOO_LARGE`, received `HTML_RENDER_FAILED` | Oversized 10 MiB + 1 byte input rejected before browser launch |
| Real Chromium/WebP | Renderer returned `HTML_RENDER_FAILED`; direct Playwright screenshot rejected `webp` as unsupported | Native CDP `Page.captureScreenshot(format: webp)` returned RIFF/WEBP |
| Allowed local assets | Expected no warnings, received `ASSET_BLOCKED` | Real CSS/image/font bytes authorized by `PathPolicy` and fulfilled with MIME |
| External/loopback/file warning | HTTP, HTTPS, loopback, and file cases returned no warnings | Each case returned only `{ code: 'ASSET_BLOCKED' }` |
| Symlink/outside denial | Expected `ASSET_BLOCKED`, received no warning | Real outside symlink rejected through `PathPolicy.authorizeAsset()` |
| Single asset limit | 10 MiB + 1 byte asset rendered instead of rejecting | Rejected with `ASSET_TOO_LARGE` |
| Total asset limit | Six 9 MiB requests rendered instead of rejecting | 54 MiB attempt rejected at the 50 MiB boundary |
| Long-page warning | Height clipped to 2400 but warning was absent | `CONTENT_CLIPPED` emitted |
| Redirect/navigation | Meta refresh destroyed the execution context and mapped to `HTML_RENDER_FAILED` | External navigation aborted, safe in-memory blank document restored, warning emitted |
| Context cleanup | Success left one real browser context open | Context closed in `finally` after success and boundary error |
| Timeout cleanup | Stalled real-browser asset read returned `TIMEOUT_MISSING` | `TIMEOUT` returned only after the context closed |
| Browser reuse | Two concurrent renders launched two Chromium processes | Launch is serialized; one reusable process observed |
| Context cap | Third asset read began before either of the first two closed | Third context waited; observed context count never exceeded two |

During WebP debugging, Chromium image decode succeeded, but `canvas.toBlob('image/webp')` stalled even in isolation. The same installed Chromium completed native CDP WebP capture, which is the implementation used.

## Denial matrix

All security claims below use real Chromium integration tests.

| Matrix item | Verification |
| --- | --- |
| Script execution | Script attempts to grow the document; no execution/clipping observed |
| Service worker registration | JavaScript disabled, `serviceWorkers: 'block'`, worker CSP denied |
| External HTTP(S) | Restrictive CSP/default-deny route; structured warning only |
| Loopback/API | `127.0.0.1` API resource denied; structured warning only |
| File URL | `file:///etc/passwd` denied; structured warning only |
| Parent traversal | `../outside.png` cannot retain the per-render virtual capability prefix |
| Symlink/outside asset | Real symlink rejected by the reused `PathPolicy` capability |
| Redirect | Meta-refresh external redirect aborted before external content load |
| Popup/window.open | JavaScript disabled; popup listener closes defense-in-depth |
| Dialog | JavaScript disabled; dialog listener dismisses defense-in-depth |
| Download | `acceptDownloads: false`; download listener cancels defense-in-depth |
| WebSocket | JavaScript/CSP denied; Playwright WebSocket route closes defense-in-depth |
| External navigation | Navigation requests are default-denied and replaced with a safe memory document |
| Allowed CSS/image/font | Real bytes fulfilled by route after `authorizeAsset()`; screenshot pixels verify CSS/image |
| Context closure | Real browser `contexts()` is empty after success, error, and timeout |
| Concurrency | At most two real contexts active; one Chromium process reused |

## Browser/version setup

- Package: Playwright `1.58.2`
- Installed command: `pnpm exec playwright install chromium`
- Playwright Chromium package: `v1208`
- Browser: Chrome for Testing `145.0.7632.6`
- macOS sandbox note: real Chromium requires execution outside the managed filesystem/process sandbox because Chromium Mach rendezvous registration is denied inside it.

## Verification

Focused suite:

```text
pnpm exec vitest run tests/security/html-isolation.test.ts
Test Files  1 passed (1)
Tests       25 passed (25)
```

Binding final verification:

```text
pnpm lint && pnpm typecheck && pnpm test && pnpm build
Test Files  8 passed (8)
Tests       75 passed (75)
vite build: passed
tsc --project tsconfig.server.json: passed
```

Additional checks:

```text
git diff --check
Playwright 1.58.2
Google Chrome for Testing 145.0.7632.6
```

## Self-review

- Main HTML is supplied only through `page.setContent()`; no file or loopback main document is used.
- The default-deny route is registered before `newPage()`/content loading and includes the required inline ASCII decision tree.
- Local bytes come only from the injected `PathPolicy.authorizeAsset()` result and are served with its MIME through `route.fulfill()`.
- Per-render random virtual prefixes prevent an untrusted absolute URL from naming the local capability namespace.
- HTTP(S), loopback, file, traversal, symlink, outside-root, navigation, and WebSocket paths default to denial.
- Context cleanup precedes limiter release in `finally`, so the third context cannot open before one of the first two is closed.
- Browser launch is serialized and disconnected browsers are relaunched.
- Boundary outputs contain codes only; causes stay inside `HtmlRenderError` and are not exposed in warnings.
- Input, per-asset, cumulative-asset, timeout, screenshot width, and clipping limits match the brief.
- No HTTP server or HTTP asset proxy was introduced.

## Commits

- `1b3c573` — `feat: isolate untrusted HTML rendering`
- Report — this report commit

## Concerns

- The 500 KB screenshot target is intentionally not enforced here; the brief assigns guaranteed processing/encoding to Task 5. Task 4 emits WebP at quality 80 with the required dimensions.
- The allowed-font integration fixture copies the macOS system Symbol font; the current Codex desktop target is macOS. A cross-platform CI environment would need a checked-in redistributable font fixture.
