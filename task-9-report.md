# Task 9 Reliability Report

## Status

Implemented the production reliability boundary described by the Task 9 brief:

- `ImportWorker` now owns the bounded queue, per-source serialization, processor dispatch, a 30-second cooperative attempt budget, graceful accept-stop, and drain.
- Timers are armed before processor dispatch, every production stage checks the shared budget after work, and results settling after the budget are rejected. This is not presented as OS-level wall-clock preemption of arbitrary synchronous injected code.
- Production Markdown/HTML extraction and full search-index normalization run in terminate-capable worker threads. SQLite, filesystem commit, and Chromium ownership remain in the main processor so no database transaction is killed in flight.
- Commit requires at least 100 ms remaining before entry, temporarily caps SQLite `busy_timeout` to the remaining budget, keeps index/rename outside the SQLite transaction, and performs no await inside the measured critical section. A noninterruptible operation is allowed to finish; elapsed checks then reject activation or run full compensation.
- Post-commit compensation restores the prior active generation, current generation/search visibility staging, run/item state, every prior `artifact_error`/`artifact_warning` row with its original ID and timestamp, and every import-item error relation before terminal `TIMEOUT` persistence.
- A durable cancellation request wins the terminal summary over a simultaneous stage timeout: `TIMEOUT` remains available as diagnostics, while result, item, and run finish as `cancelled` with a `CANCELLED` summary.
- The API depends on the worker rather than directly owning `ArtifactProcessor` or `BackgroundQueue`.
- Production rendering and thumbnail re-encoding share one Chromium process and one global two-context limiter.
- Source HTML/Markdown reads and HTML rewrite input are bounded at 10 MiB. CSS rewrite is bounded at 10 MiB per asset and 50 MiB total. Chromium performs image encoding; optimizer input is capped at 16 MiB and final thumbnails at 500 KiB.
- Runtime startup reconciles SQLite and same-root temporary derivatives before constructing the request-serving app.
- Recovery preserves completed derivatives and active generation pointers, reports queued/unstarted items, returns structured per-item cleanup errors, and does not recursively or broadly delete files.

## Crash/restart stage matrix

Each row uses a real test-fixture child process, SQLite database, source filesystem, `ImportWorker`, and `ArtifactProcessor`. The render row additionally stops a real Chromium-backed asset read. These forced-termination children are test infrastructure, not the production attempt topology. The parent sends `SIGKILL` only after the fixture reports that the durable stage transition occurred, then starts the production runtime against the same database and derivative root.

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
| Chromium descendant peak RSS | 347.4 MiB | 4096 MiB |
| Chromium descendant RSS samples | 5 | > 1 |
| Running-item cancel latency under two-context load | 66.8 ms | 1500 ms |
| Production commit critical-section maximum | 0.68 ms | 250 ms smoke ceiling |
| Browser processes launched for the three-item load | 1 | 1 |
| Peak disposable contexts | 2 | 2 |

The RSS ceiling is intentionally generous for the 16 GiB target and avoids an exact, machine-sensitive assertion. A single-flight periodic sampler starts before the three-item workload, samples the Chromium descendant process tree with `ps` throughout render and thumbnail encoding, performs a final sample after worker idle, verifies the reported value equals `max(samples)`, and always clears its timer in `finally`. Cancellation is requested while the current render is active; that current noninterruptible asset read is released, the next stage is prevented, and the durable run summary becomes `cancelled`.

Browser disconnect coverage closes the first real browser during one worker item, observes that item fail in isolation, relaunches Chromium, completes the following item, and verifies zero contexts remain.

## Cooperative budget and cancellation corrections

- A generic injected processor that synchronously occupies the event loop past a 20 ms test budget cannot publish a successful result. The worker rejects it with `TIMEOUT` when the synchronous call eventually returns; caller settlement at 20 ms is not claimed.
- Production CPU-heavy extraction and full-text/path/title normalization are isolated in worker threads and terminated by the attempt abort signal.
- Production synchronous work remaining on the owner thread is explicitly input-bounded: source/HTML/CSS sizes, fixed render dimensions, 16 MiB optimizer input, bounded warning cardinality, and short local SQLite/fs statements.
- The processor checks elapsed budget before and after inspect, source read, extraction, render, index preparation, thumbnail optimization, directory/file writes, index commit, rename, item completion, and SQLite work.
- A synchronous rename regression that crosses the budget rolls back the prepared index, removes the renamed output, retains the previous thumbnail/active generation, and durably fails the current run with commit-stage `TIMEOUT`.
- A transaction-return regression that crosses the budget restores exact prior diagnostics and relations, removes attempt warning rows, stages the interrupted generation, and retains only the new terminal `TIMEOUT` alongside the restored prior errors.
- A held-render regression requests durable cancellation first and reaches the worker budget second. It persists both `TIMEOUT` and `CANCELLED` diagnostics, but returns `outcome: cancelled` and terminally cancels the item/run.

### Process-topology ruling

The global plan permits no general production child process beyond Chromium. Whole-attempt process termination would violate that constraint and would also split ownership of better-sqlite3, renderer contexts, and filesystem commit state. Worker threads are used only for pure CPU transformations. Therefore an arbitrary injected synchronous collaborator cannot be forcibly preempted by the OS in this design. If OS-level settlement at exactly 30 seconds is required, that is a plan conflict requiring an explicit topology change; this implementation does not fake that guarantee.

## RED/GREEN record

| Behavior | RED evidence | GREEN evidence |
| --- | --- | --- |
| Queue shutdown | `TypeError: queue.close is not a function` | close rejects new work and drains active/pending work |
| Production worker | `Cannot find module './worker.js'` | bounded concurrency, source serialization, timeout, close/drain tests pass |
| Cooperative budget | render budget test timed out at 5000 ms | worker abort becomes durable `TIMEOUT` at `render`; no index starts |
| Responsive Chromium abort | 3016 ms, exceeding 1000 ms | stalled context closes in 329 ms |
| Startup recovery module | `Cannot find module './recovery.js'` | SQLite reconciliation plus limited cleanup and structured errors pass |
| Startup-before-API | recovered run remained `queued` | production runtime exposes `interrupted` before accepting requests |
| Bounded source read | 1025-byte real source resolved despite 1024-byte cap | `AssetReadLimitError` raised before full read; processor maps 10 MiB breach to `INPUT_TOO_LARGE` |
| Forced-stage matrix | fixture exited before `READY` | inspect/extract/render/index/commit all pass deterministic kill/restart assertions |
| Shared re-encoder browser | `renderer.encodeWebp is not a function` | render and thumbnail encode reuse one browser and close every context |
| Full-suite load order | run 1 stayed active because the harness released run 2's first-arriving callback | per-item deterministic gates remove ordering dependence |
| Cancel/budget race | held render finished as failed `TIMEOUT` despite `cancel_requested_at` | diagnostics retain `TIMEOUT`; result/item/run finish `cancelled` |
| Synchronous injected CPU | 45 ms busy processor published `completed` after a 20 ms budget | late result is rejected as `TIMEOUT`; no result callback runs |
| Commit budget activation | synchronous rename, or transaction return, crossed the budget and still activated the generation | guard/compensation restores the prior generation, visibility, thumbnail, and terminal state |
| CPU extraction ownership | Markdown/HTML parsing occupied the SQLite/renderer owner thread | production extraction runs in a terminate-capable worker thread |
| Index normalization ownership | `async prepare()` normalized the full body before yielding | body/path/title normalization runs in a terminate-capable worker thread |
| Commit entry reserve | 75 ms remaining still entered index/rename/SQLite commit | entry is rejected below the 100 ms reserve |
| SQLite lock wait | connection retained a 5000 ms busy wait with 1000 ms remaining | critical-section `busy_timeout` is capped to remaining budget and restored afterward |
| Diagnostic compensation | old error IDs/relations were lost and the attempt warning remained | exact prior error/warning rows and relations return; attempt rows are removed before terminal timeout |
| Optimizer input | an arbitrarily large buffer reached base64/encoder work | input above the 16 MiB render envelope fails before encoding |
| RSS peak sampling | one point-in-time sample could miss the workload peak | 5 samples span the workload; reported peak is verified as `max(samples)` |

## Verification

- `pnpm lint` — PASS
- `pnpm typecheck` — PASS
- `pnpm build` — PASS
- `pnpm test` — PASS, 212/212
- `pnpm test:e2e` — PASS, 19/19

## Concerns

- The RSS smoke measurement uses macOS/Linux `ps` process-tree data and is intentionally not an exact performance benchmark.
- The 250 ms commit critical-section assertion is a generous smoke ceiling, not a wall-clock guarantee. The observed 0.68 ms maximum is machine-specific.
- An arbitrary injected processor that synchronously blocks the owner thread cannot be forcibly preempted under the one-process plan. Its late success is rejected after it returns; production user-sized extraction/normalization work is isolated and terminate-capable.
- SQLite/fs commit work is deliberately never killed. It starts only with a reserve, uses a remaining-budget lock wait, completes its bounded noninterruptible section, and compensates any late activation.
