# Task 9 Reliability Report

## Status

Implemented the production reliability boundary described by the Task 9 brief:

- `ImportWorker` now owns the bounded queue, per-source serialization, processor dispatch, the 30-second hard attempt deadline, graceful accept-stop, and drain.
- The API depends on the worker rather than directly owning `ArtifactProcessor` or `BackgroundQueue`.
- Production rendering and thumbnail re-encoding share one Chromium process and one global two-context limiter.
- Source HTML/Markdown reads are bounded at 10 MiB before full-file allocation. Existing renderer limits remain 10 MiB per asset and 50 MiB total; processor and API retain the 500 KiB thumbnail ceiling.
- Runtime startup reconciles SQLite and same-root temporary derivatives before constructing the request-serving app.
- Recovery preserves completed derivatives and active generation pointers, reports queued/unstarted items, returns structured per-item cleanup errors, and does not recursively or broadly delete files.

## Crash/restart stage matrix

Each row uses a real child process, SQLite database, source filesystem, `ImportWorker`, and `ArtifactProcessor`. The render row additionally stops a real Chromium-backed asset read. The parent sends `SIGKILL` only after the fixture reports that the durable stage transition occurred, then starts the production runtime against the same database and derivative root.

| Forced boundary | Durable state before kill | Restart assertion | Result |
| --- | --- | --- | --- |
| inspect | run `running`, item `inspect` | run/item `interrupted`; no generation claimed | PASS |
| extract | item `extract`, generation `processing` | run/item/generation `interrupted` | PASS |
| render | item `render`, real Chromium context active | run/item/generation `interrupted`; runtime available | PASS |
| index | item `index`, generation `processing` | run/item/generation `interrupted` | PASS |
| commit | item `commit`, optimizer boundary active | run/item/generation `interrupted`; no endless processing state | PASS |

The pre-existing completed-derivative recovery fixture also passes: the completed thumbnail and active generation pointer remain intact, unfinished extraction data remains available for diagnosis, the queued item is reported as unstarted, and only the direct-root `.tmp` file is removed.

## Resource and cancellation measurements

Measured while two real Chromium contexts were blocked concurrently through the production worker:

| Measurement | Observed | Enforced smoke ceiling |
| --- | ---: | ---: |
| Chromium descendant peak RSS | 326.3 MiB | 4096 MiB |
| Running-item cancel latency under two-context load | 32.4 ms | 1500 ms |
| Browser processes launched for the three-item load | 1 | 1 |
| Peak disposable contexts | 2 | 2 |

The RSS ceiling is intentionally generous for the 16 GiB target and avoids an exact, machine-sensitive assertion. The test samples the Chromium descendant process tree with `ps`, sums RSS, and records the observed value. Cancellation is requested while the current render is active; that current noninterruptible asset read is released, the next stage is prevented, and the durable run summary becomes `cancelled`.

Browser disconnect coverage closes the first real browser during one worker item, observes that item fail in isolation, relaunches Chromium, completes the following item, and verifies zero contexts remain. External worker deadline coverage closes a stalled real render context in 329 ms against a 1000 ms assertion.

## RED/GREEN record

| Behavior | RED evidence | GREEN evidence |
| --- | --- | --- |
| Queue shutdown | `TypeError: queue.close is not a function` | close rejects new work and drains active/pending work |
| Production worker | `Cannot find module './worker.js'` | bounded concurrency, source serialization, timeout, close/drain tests pass |
| Durable deadline | render deadline test timed out at 5000 ms | worker deadline becomes durable `TIMEOUT` at `render`; no index starts |
| Responsive Chromium abort | 3016 ms, exceeding 1000 ms | stalled context closes in 329 ms |
| Startup recovery module | `Cannot find module './recovery.js'` | SQLite reconciliation plus limited cleanup and structured errors pass |
| Startup-before-API | recovered run remained `queued` | production runtime exposes `interrupted` before accepting requests |
| Bounded source read | 1025-byte real source resolved despite 1024-byte cap | `AssetReadLimitError` raised before full read; processor maps 10 MiB breach to `INPUT_TOO_LARGE` |
| Forced-stage matrix | fixture exited before `READY` | inspect/extract/render/index/commit all pass deterministic kill/restart assertions |
| Shared re-encoder browser | `renderer.encodeWebp is not a function` | render and thumbnail encode reuse one browser and close every context |
| Full-suite load order | run 1 stayed active because the harness released run 2's first-arriving callback | per-item deterministic gates remove ordering dependence |

## Verification

- `pnpm lint` — PASS
- `pnpm typecheck` — PASS
- `pnpm build` — PASS
- `pnpm test` — PASS, 199/199
- `pnpm test:e2e` — PASS, 19/19

## Concerns

- The RSS smoke measurement uses macOS/Linux `ps` process-tree data and is intentionally not an exact performance benchmark.
- A non-cooperative dependency is hard-failed by the worker at 30 seconds. Production filesystem, renderer, index preparation, and shared thumbnail encoding all receive cooperative deadline handling so late results cannot activate a generation; synchronous SQLite transaction work remains bounded by the local operations it performs.
