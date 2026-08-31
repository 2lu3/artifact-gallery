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

## Round 1 security follow-up

All four Important review findings were addressed with focused RED/GREEN cycles:

| Finding | Focused RED | GREEN implementation/evidence |
| --- | --- | --- |
| Asset reads allocated the complete file before checking limits | `AuthorizedAsset.read(1024)` returned all 1025 bytes instead of rejecting | `PathPolicy` now opens and stats the file, then reads at most `limit + 1` in 64 KiB chunks; `AssetReadLimitError` is preserved across filesystem normalization |
| Parallel requests raced the 50 MiB cumulative check | Six simulated 9 MiB reads ran concurrently (`peakReads = 6`) | Per-render `AssetBudget` serializes reservation/read/commit, passes the remaining individual/total bound before I/O, and the regression observes `peakReads = 1` with the sixth request bounded to 5 MiB |
| Contexts were untracked during `newContext()` / `clearPermissions()` | A context returned after timeout still entered `clearPermissions()`; a context was visible while delayed permission clearing timed out | Context is recorded immediately after creation, each awaited setup step is followed by an abort check, and setup failures close their own context; both delayed regressions observe zero live contexts without adding a production test hook |
| Font fixture/application and CORS were not demonstrated | Browser-observed font response reported `access-control-allow-origin: null` | Route fulfillment now emits `Access-Control-Allow-Origin: *`; the checked-in Abel fixture visibly changes text metrics/pixels and `document.fonts.ready` completes in real Chromium |
| Browser URL normalization erased raw traversal evidence | Raw, percent-encoded, inline-CSS, and CSS-escaped nested traversal produced no warning and read the sibling asset | `parse5` walks HTML attributes before content load and `css-tree` walks inline/external CSS URL AST nodes before fulfillment; allowed relative references are rewritten to the per-render virtual capability origin, traversal is decoded repeatedly and denied before Chromium sees it, and six real-browser cases observe that sibling bytes are never read |

The traversal boundary also neutralizes user `<base>`, meta refresh, `srcset`, `ping`, and `srcdoc` capabilities before content loading. Invalid/unparsed CSS is default-denied instead of being passed through. The implementation still uses Playwright routing directly and introduces no HTTP server or proxy.

### Portable font fixture

- Fixture: `tests/fixtures/fonts/abel/Abel-Regular.ttf`
- License: SIL Open Font License 1.1, copied at `tests/fixtures/fonts/abel/OFL.txt`
- Provenance and SHA-256 are fixed in `tests/fixtures/fonts/abel/SOURCE.md`
- Font SHA-256: `8809dcad25318225052f88333e208c5aad4adcb7b2c934c135735ec19aa410b4`
- The former macOS system-font concern is resolved; the integration test no longer depends on `/System/Library/Fonts`.

### Round 1 verification

Focused security verification:

```text
pnpm exec vitest run tests/security/html-isolation.test.ts tests/security/path-policy.test.ts
Test Files  2 passed (2)
Tests       61 passed (61)
```

Binding full verification:

```text
pnpm lint
passed

pnpm typecheck
passed

pnpm test
Test Files  8 passed (8)
Tests       86 passed (86)

pnpm build
vite build: passed
tsc --project tsconfig.server.json: passed
```

Round 1 fix and report are committed together in the follow-up commit.
