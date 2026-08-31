# Task 9 Reliability Report

## Status

Implemented the production reliability boundary described by the Task 9 brief:

- `ImportWorker` now owns the bounded queue, per-source serialization, processor dispatch, the 30-second hard attempt deadline, graceful accept-stop, and drain.
- Every attempt carries one absolute epoch deadline. Timers are armed before processor dispatch, results returned after the deadline are rejected, and every production stage checks elapsed time after synchronous work.
- Production Markdown parse/sanitize/text extraction and HTML parse/text extraction run in a terminate-capable worker thread. SQLite, filesystem commit, and Chromium ownership remain in the main processor so no database transaction is killed in flight.
- Commit uses pre/post elapsed guards inside the short SQLite transaction. If the SQLite transaction wrapper itself returns after the deadline, a compensating transaction restores the previous active generation, staged generation state, search visibility, and run/item state before terminal `TIMEOUT` persistence.
- A durable cancellation request wins the terminal summary over a simultaneous stage timeout: `TIMEOUT` remains available as diagnostics, while result, item, and run finish as `cancelled` with a `CANCELLED` summary.
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
| Chromium descendant peak RSS | 347.7 MiB | 4096 MiB |
| Chromium descendant RSS samples | 5 | > 1 |
| Running-item cancel latency under two-context load | 65.6 ms | 1500 ms |
| Browser processes launched for the three-item load | 1 | 1 |
| Peak disposable contexts | 2 | 2 |

The RSS ceiling is intentionally generous for the 16 GiB target and avoids an exact, machine-sensitive assertion. A single-flight periodic sampler starts before the three-item workload, samples the Chromium descendant process tree with `ps` throughout render and thumbnail encoding, performs a final sample after worker idle, verifies the reported value equals `max(samples)`, and always clears its timer in `finally`. Cancellation is requested while the current render is active; that current noninterruptible asset read is released, the next stage is prevented, and the durable run summary becomes `cancelled`.

Browser disconnect coverage closes the first real browser during one worker item, observes that item fail in isolation, relaunches Chromium, completes the following item, and verifies zero contexts remain.

## Absolute deadline and cancellation corrections

- A generic injected processor that synchronously occupies the event loop past a 20 ms deadline can no longer publish a successful result. The worker rejects it with `TIMEOUT` after the synchronous call returns.
- The production CPU-heavy extraction path is isolated in a worker thread and is terminated by the attempt abort signal, so Markdown/HTML parsing cannot block the owner event loop through the 30-second boundary.
- The production processor checks the absolute deadline before and after inspect, source read, extraction, render, index preparation, thumbnail optimization, directory/file writes, index commit, rename, item completion, and the SQLite transaction.
- A synchronous rename regression that crosses the deadline rolls back SQLite activation, rolls back the prepared index, removes the renamed output, retains the previous thumbnail and active generation, and durably fails the current run with commit-stage `TIMEOUT`.
- A held-render regression requests durable cancellation first and reaches the worker deadline second. It persists both `TIMEOUT` and `CANCELLED` diagnostics, but returns `outcome: cancelled` and terminally cancels the item/run.

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
| Cancel/deadline race | held render finished as failed `TIMEOUT` despite `cancel_requested_at` | diagnostics retain `TIMEOUT`; result/item/run finish `cancelled` |
| Synchronous CPU deadline | 45 ms busy processor published `completed` after a 20 ms deadline | late result is rejected as `TIMEOUT`; no result callback runs |
| Commit deadline activation | synchronous rename, or transaction return, crossed the deadline and still activated the generation | transaction guard/compensation restores the prior generation, visibility, thumbnail, and terminal state |
| CPU extraction ownership | Markdown/HTML parsing occupied the SQLite/renderer owner thread | production extraction runs in a terminate-capable worker thread |
| RSS peak sampling | one point-in-time sample could miss the workload peak | 5 samples span the workload; reported peak is verified as `max(samples)` |

## Verification

- `pnpm lint` — PASS
- `pnpm typecheck` — PASS
- `pnpm build` — PASS
- `pnpm test` — PASS, 206/206
- `pnpm test:e2e` — PASS, 19/19

## Concerns

- The RSS smoke measurement uses macOS/Linux `ps` process-tree data and is intentionally not an exact performance benchmark.
- An arbitrary injected processor that synchronously blocks the owner thread cannot be forcibly preempted safely; its late success is rejected after it returns. The production CPU-heavy extraction path is therefore isolated and terminate-capable, while the SQLite/renderer/fs owner remains stable.
- SQLite transaction work is deliberately never killed. It is kept to bounded local statements, guarded inside the transaction, and followed by a compensating nonactivation path if the transaction call itself crosses the absolute deadline.
