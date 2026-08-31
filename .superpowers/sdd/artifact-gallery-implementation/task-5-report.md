# Task 5 report — Processing

## Status

Implemented one durable staged processor for register, refresh, retry, and rebuild:

```text
inspect -> extract -> render -> index -> commit
```

The task adds the closed structured-error boundary, safe Markdown extraction/rendering,
partial generation handling, cancellation gates, stale-counter protection, atomic thumbnail
replacement, and WebP optimization to the 500 KB target.

## Files

- `src/shared/errors.ts`
  - Closed Task 5 taxonomy plus non-retryable `UNKNOWN`
  - Boundary classification and public-response projection without technical detail
- `src/server/rendering/markdown-renderer.ts`
  - Safe CommonMark-style headings, paragraphs, lists, blockquotes, links, tables, fenced
    code, emphasis, and text extraction
  - Raw HTML escaped; active/external link capabilities removed
- `src/server/processing/artifact-processor.ts`
  - Shared staged pipeline and durable import-item transitions
  - Partial-result/error lifecycle, cancellation, title precedence, stale generation guard
  - SQLite transaction + same-directory `.tmp` + atomic rename + old-thumbnail retirement
- `src/server/processing/thumbnail-optimizer.ts`
  - Quality-first and then dimension optimization with a hard 500 KB postcondition
  - Chromium WebP encoder for oversized previews
- `src/server/processing/index.ts`
  - Processing exports
- Four colocated behavior test files

## Per-stage RED / GREEN evidence

All production branches were introduced after focused failing tests. Real temporary files and
SQLite databases were used for the pipeline; only Chromium rendering, indexing, encoding, and
filesystem failure injection were replaced at their explicit boundaries.

| Stage / behavior | Observed RED | GREEN evidence |
| --- | --- | --- |
| Structured error boundary | `Cannot find module './errors.js'` | Known boundary codes, SQLite busy mapping, non-retryable `UNKNOWN`, and public redaction: 3 passed |
| Markdown extract/render | `Cannot find module './markdown-renderer.js'` | Title/text extraction, all allowed constructs, raw HTML escaping, link capability filtering, and structured parse failure: 4 passed |
| Thumbnail optimization | `Cannot find module './thumbnail-optimizer.js'` | Bounded passthrough, quality-before-dimension search, identifiable minimum, and hard oversize failure: 4 passed |
| Shared pipeline | `Cannot find module './artifact-processor.js'` | All four entrypoints produced generations 1–4 through the persisted commit stage |
| Inspect failure | Outside-root source had no processor mapping | Item failed with `OUTSIDE_ALLOWED_ROOT` before artifact creation |
| Extract failure | NUL Markdown lacked structured processing behavior | `MARKDOWN_PARSE_FAILED` persisted; no dependent derivative was marked ready |
| Render failure / partial result | Renderer failure had no orchestration path | Content and index remained ready, render failed, technical detail stayed private |
| Index failure / partial result | Index failure had no orchestration path | Content and thumbnail remained ready, index failed with `INDEX_UPDATE_FAILED` |
| Commit stale guard | No processor commit existed | Counter invalidation returned `STALE_GENERATION`, rolled back the attempt, retained old active generation/file, and cleaned temp output |
| Commit write/rename failure | No atomic filesystem/DB coordinator existed | Partial write and rename failures returned `DERIVED_WRITE_FAILED`, rolled back DB activation, retained old thumbnail, and removed `.tmp` |
| Cancellation boundaries | No processing cancellation behavior existed | Cancellation before inspect/extract/render/index/commit stopped the next stage and durably cancelled item/run |
| Non-interruptible cancellation | No render-to-cancel boundary existed | Render completed, then cancellation was recorded before index work began |
| Error/warning lifecycle | No processing lifecycle existed | Partial retry retained prior errors/warnings and thumbnail; clean success cleared stale issues; current clipped warning remained durable |
| Title self-review | Second HTML `<title>` replaced the first | First HTML title wins after user title; filename is fallback |
| Failure-title self-review | Extraction failure changed a user title to filename | Persisted user title survives extraction failure |

Representative focused commands:

```text
pnpm test src/shared/errors.test.ts
pnpm test src/server/rendering/markdown-renderer.test.ts
pnpm test src/server/processing/thumbnail-optimizer.test.ts
pnpm test src/server/processing/artifact-processor.test.ts
```

Final focused processing result: 24 tests passed, 0 failed.

## Required verification

Fresh verification after the final self-review fixes:

```text
pnpm lint
eslint .                                      exit 0

pnpm typecheck
tsc --noEmit                                  exit 0

pnpm test
Test Files  12 passed (12)
Tests       118 passed (118)

pnpm build
vite build                                   exit 0
tsc --project tsconfig.server.json            exit 0
```

The full test command was executed outside the managed macOS process sandbox because Chromium
Mach rendezvous registration is denied inside it. The first in-sandbox run confirmed that this
was the only failure source; the unrestricted run passed all 118 tests.

## Self-review

- The error code domain exactly matches the brief and defaults unknown failures to a
  non-retryable result; only the persisted technical field retains causes.
- Every stage transition is written through `ImportRepository.startStage()` before work starts,
  using its cancellation-aware conditional update.
- Markdown output is constructed only from the requested safe element set. Raw HTML is text,
  and generated links cannot carry external, protocol, traversal, event, script, embed, or
  network capability.
- User title, first HTML title / first Markdown H1, and canonical filename are applied in that
  order, including extraction-failure attempts.
- A new thumbnail is written to a randomized `.tmp` in its final directory. Generation facts,
  title, issue cleanup, warnings, and rename run under one SQLite transaction. Rename or commit
  failure rolls the generation back and removes any new file.
- The previous thumbnail is retired only after the new DB transaction and rename succeed.
- Partial generations reuse prior extracted text and thumbnail paths without erasing errors;
  only a clean attempt clears stale errors and warnings.
- The processor verifies the optimizer output again before writing, so no injected or default
  optimizer can persist a thumbnail over 500 KB.
- Mutation review covers wrong stage ordering, omitted cancellation checks, stale counter
  acceptance, dropped rollback/cleanup, changed title precedence, unsafe Markdown output,
  missing error redaction, and removal of the final size check.
- Existing persistence, PathPolicy, and isolated HTML renderer files/interfaces were not changed.

## Commit

Implementation: `1f168ff` (`feat: add staged artifact processor`)

## Concerns

- Real Chromium tests and the default oversized-WebP encoder require execution outside the
  managed macOS process sandbox. This is an environment permission restriction, not a product
  test failure; the full suite passed in the permitted execution context.

---

## Fix round 1/5

### Findings addressed

1. **Generation, file, and import terminal atomicity**
   - Moved successful and partial `import_item` / `import_run` terminal transitions into the
     same outer SQLite transaction as generation activation, title/issues, staged-index commit,
     and atomic thumbnail rename.
   - The old thumbnail is now retired only after that complete transaction succeeds.
   - A real SQLite trigger that rejects `completeItem` proves the active pointer rolls back, the
     renamed new file is removed, and the prior active generation and file remain intact.
2. **Prepared search index contract**
   - Replaced eager `ArtifactIndexer.update()` with `prepare()` returning explicit synchronous
     `commit()` and asynchronous `rollback()` operations.
   - `commit()` runs inside the active-generation transaction. Any stale, rename, terminal, or
     database failure invokes `rollback()`, so the prior visible search result remains visible.
3. **Cancellation after non-interruptible work**
   - Rechecks durable cancellation after optimizer completion, after temp-file write, and after
     atomic rename while the database transaction can still roll back.
   - Cancellation observed inside a transaction is re-persisted after rollback before the item
     and run are terminally cancelled.
4. **CommonMark-compatible Markdown**
   - Replaced the handwritten regex parser with pinned `markdown-it` 14.1.0.
   - Kept raw HTML disabled in the parser and added a separate parse5 DOM allowlist sanitizer
     for elements, attributes, code-language classes, ordered-list starts, and local-only links.
   - Text/title extraction now consumes the sanitized DOM.
5. **Public/internal error separation**
   - `ArtifactProcessResult.errors` now contains only `PublicProcessingError` projections.
   - Raw `ArtifactProcessingError` values, causes, and `technicalDetail` remain internal and in
     persistence only; serializing the complete result cannot expose them.
6. **Old-thumbnail cleanup retry record**
   - An unlink failure leaves both the active new thumbnail and old cleanup target intact and
     records `THUMBNAIL_RETIRE_PENDING` durably against the new generation.
   - The warning detail is fixed, path-free user text; the old path is discoverable only from
     internal inactive-generation persistence for a future cleanup retry.

### Focused RED / GREEN evidence

| Regression | Observed RED | GREEN evidence |
| --- | --- | --- |
| Completion transition fails after generation commit | Expected old active generation `1`, received new generation `2` | Completion trigger failure rolls back DB activation and rename; old file is the only `.webp` |
| Search update survives failed generation | Expected `First searchable text`, received `Uncommitted searchable text` | Prepared index rollback restores prior visible result after rename failure |
| Cancellation during optimization | Expected `cancelled`, received `completed` | Optimizer finishes, durable cancel is rechecked, no new file/generation is activated |
| Cancellation during rename | Expected `cancelled`, received `completed` | Rename completes, transaction detects cancel and rolls back; cancel is re-persisted |
| CommonMark continuation/fences | Continuation became a separate paragraph; `~~~` and indented code became paragraphs | Continuation stays in its `<li>`; both code forms emit allowlisted `<pre><code>` |
| Raw error serialization | Result contained `ArtifactProcessingError.technicalDetail` with `/private/path` | Complete result JSON contains only code/stage/retryability/safe message |
| Old-thumbnail unlink failure | No warning was persisted | Durable path-free `THUMBNAIL_RETIRE_PENDING` warning is stored |

Focused command:

```text
pnpm test src/server/processing/artifact-processor.test.ts \
  src/server/processing/thumbnail-optimizer.test.ts \
  src/server/rendering/markdown-renderer.test.ts \
  src/shared/errors.test.ts

Test Files  4 passed (4)
Tests       30 passed (30)
```

### Verification

Fresh verification after the final fix and self-review:

```text
pnpm lint
eslint .                                      exit 0

pnpm typecheck
tsc --noEmit                                  exit 0

pnpm test
Test Files  12 passed (12)
Tests       124 passed (124)

pnpm build
vite build                                   exit 0
tsc --project tsconfig.server.json            exit 0
```

The full suite again ran outside the managed macOS process sandbox solely because Chromium Mach
rendezvous registration is denied inside it.

### Self-review

- Mutation: moving item completion outside the transaction fails the completion-trigger test.
- Mutation: publishing index state from `prepare()` or omitting rollback fails the retained-search
  result test.
- Mutation: removing either post-optimizer or post-rename cancellation probe fails its dedicated
  non-activation test.
- Mutation: returning internal errors restores the technical-path JSON leak.
- Mutation: replacing markdown-it with the former parser fails list continuation, tilde fence,
  and indented-code coverage.
- Mutation: skipping the DOM sanitizer restores unsafe/external link attributes and non-allowlist
  elements.
- Mutation: swallowing old-thumbnail unlink failure loses the durable cleanup-pending warning.
- Existing persistence, PathPolicy, and isolated HTML renderer APIs remain unchanged; the indexer
  interface intentionally changed to the review-required prepare/commit/rollback contract.

### Commit

Fix round and report: this commit.

### Concerns

- Real Chromium verification retains the same macOS managed-sandbox limitation documented above;
  all 124 tests pass in the permitted execution context.

---

## Fix round 2/5

### Findings addressed

1. **Post-commit thumbnail maintenance isolation**
   - The rollback catch now ends at the SQLite/index/file activation boundary. Once generation,
     item, and run commit successfully, inactive-thumbnail cleanup cannot delete the new active
     file or attempt an invalid failure transition.
   - Cleanup-marker persistence failures are reported only through the internal
     `ProcessingOperationalError` channel and do not alter the completed public result.
2. **Non-silent prepared-index recovery**
   - `PreparedArtifactIndex` now requires `quarantine()` in addition to `commit()` and
     `rollback()`.
   - A rollback failure quarantines search visibility, records durable `INDEX_REPAIR_PENDING`,
     reports the internal recovery fault, and returns/persists `INDEX_UPDATE_FAILED` at `index`.
   - A later successful prepared-index commit clears the repair marker only after the full
     generation transaction succeeds.
3. **Durable thumbnail cleanup retry**
   - Clean processing no longer deletes `THUMBNAIL_RETIRE_PENDING` or `INDEX_REPAIR_PENDING`.
   - Every committed generation retries removal of all inactive, non-active thumbnail paths.
     The original pending-warning row remains unchanged across failed retries and is deleted only
     after every inactive path is removed successfully.
4. **Index commit failure classification and state consistency**
   - Prepared-index `commit()` failures are mapped to public and persisted
     `INDEX_UPDATE_FAILED / index`, rather than `DERIVED_WRITE_FAILED / commit`.
   - Failed transaction results now return the same `failed` content/render/index statuses stored
     on the attempted generation.

### Focused RED / GREEN evidence

| Regression | Observed RED | GREEN evidence |
| --- | --- | --- |
| Thumbnail unlink plus warning-insert failure | Processor threw `InvalidImportTransitionError` after trying to fail an already completed item | Result remains completed; new generation/file stay active; old file stays pending; internal warning-persistence event is captured |
| Prepared-index rollback failure | Returned `DERIVED_WRITE_FAILED / commit`; uncommitted search text remained visible | Returns `INDEX_UPDATE_FAILED / index`; old DB generation remains active; search is quarantined; durable repair marker exists |
| Prepared-index commit failure | Returned `DERIVED_WRITE_FAILED / commit` with ready result statuses | Public and persisted error is `INDEX_UPDATE_FAILED / index`; returned and stored statuses are all failed |
| Repeated thumbnail cleanup failure | Existing warning was rewritten from generation 2 to generation 3 while the oldest file remained | Original warning identity is preserved; next successful retry removes all inactive files before deleting it |

Focused command:

```text
pnpm test src/server/processing/artifact-processor.test.ts

Test Files  1 passed (1)
Tests       22 passed (22)
```

### Verification

Fresh verification after the final change:

```text
pnpm lint
eslint .                                      exit 0

pnpm typecheck
tsc --noEmit                                  exit 0

pnpm test
Test Files  12 passed (12)
Tests       128 passed (128)

pnpm build
vite build                                   exit 0
tsc --project tsconfig.server.json            exit 0
```

The full suite ran outside the managed macOS process sandbox solely because Chromium Mach
rendezvous registration is denied inside it.

### Self-review

- Mutation: rejoining post-commit cleanup with the transaction catch reproduces the completed-item
  transition exception and removes the new active file.
- Mutation: swallowing index rollback failure leaves the uncommitted search document visible and
  loses both the public index error and durable repair marker.
- Mutation: deleting all warnings on clean success changes the pending-warning identity before the
  associated inactive files are removed.
- Mutation: classifying prepared-index commit through the generic commit fallback restores the
  wrong code/stage and returned-versus-persisted status mismatch.
- Existing repository, import-transition, rendering, and path-policy contracts remain unchanged;
  the index contract intentionally gains mandatory quarantine semantics.

### Commit

Fix round and report: this commit.

### Concerns

- Real Chromium verification retains the same managed-sandbox limitation; all 128 tests pass in
  the permitted execution context.

---

## Fix round 3/5

### Finding addressed

**Durable SQLite search-visibility authority**

- Added immutable migration `003_search_visibility.sql` with one gate row per artifact generation.
  Fresh generations start `staged`; only the successful generation transaction changes an
  index-ready generation to `visible`; recovery can persist `quarantined`.
- The migration backfills only the current active, index-ready generation as `visible`. Every
  other legacy generation is backfilled `staged`, and owner triggers reject cross-artifact gate
  associations.
- Added `SearchVisibilityRepository.filterVisibleCandidates()` as the Task 6 read contract. It
  returns an external candidate only when SQLite confirms the same artifact generation is active,
  its `index_status` is `ready`, and its gate is `visible`.
- Added durable `quarantineGeneration()` and `clearQuarantineAfterRepair()` transitions. Repair
  re-evaluates active generation and index readiness, returning an inactive generation to
  `staged` rather than making it visible.
- `ArtifactProcessor` now persists the generation quarantine after prepared-index rollback fails,
  before attempting the external quarantine. If both external rollback and quarantine fail, an
  externally leaked row remains unreadable through the SQLite-authoritative repository API.
- Gate persistence errors are mapped through the normal processing error boundary (including
  `DATABASE_BUSY` for SQLite busy codes), reported internally, and remain fatal to the attempt.
  The pre-existing `staged` default remains fail-closed if the quarantine transition itself fails.

### Focused RED / GREEN evidence

| Regression | Observed RED | GREEN evidence |
| --- | --- | --- |
| Missing immutable migration | Fresh schema omitted the gate table; 001 and pre-002 upgrades applied only two migrations | Fresh and upgraded databases apply `003`; the legacy active+ready generation is backfilled `visible` |
| Missing Task 6 read authority | Repository module was absent | Real SQLite repository returns only active+ready+visible candidates and persists quarantine across reopen |
| External rollback and quarantine both fail | Generation gate remained `staged`; no durable quarantine transition represented the recovery fault | External new row remains present, failed generation gate is `quarantined`, and read API returns only the previous active row |
| Repair completes | No gate-release contract existed | Repair release rechecks SQLite active/readiness and restores the repaired active generation to visible |

Focused command:

```text
pnpm test src/server/processing/artifact-processor.test.ts \
  src/server/repositories/search-visibility-repository.test.ts \
  src/server/db/database.test.ts

Test Files  3 passed (3)
Tests       34 passed (34)
```

### Verification

Fresh verification after the final implementation and self-review:

```text
pnpm lint
eslint .                                      exit 0

pnpm typecheck
tsc --noEmit                                  exit 0

pnpm test
Test Files  13 passed (13)
Tests       131 passed (131)

pnpm build
vite build                                   exit 0
tsc --project tsconfig.server.json            exit 0
```

The full suite ran outside the managed macOS process sandbox solely because Chromium Mach
rendezvous registration is denied inside it.

### Self-review

- Mutation: omitting migration 003 fails fresh-schema and both legacy-upgrade assertions.
- Mutation: omitting staged-row creation or transactional visible activation causes repository
  commit/filter tests to fail closed instead of returning the active candidate.
- Mutation: dropping any active-generation, index-ready, or visible-gate predicate exposes the
  deliberately invalid external candidate in the repository test.
- Mutation: swallowing both external recovery failures without the SQLite quarantine leaves the
  processor regression at `staged` rather than the required durable `quarantined` state.
- Mutation: clearing quarantine directly to visible exposes inactive generations; the repair test
  requires the active/readiness recheck.

### Commit

Fix round and report: this commit.

### Concerns

- Task 6 must consume external search candidates through `SearchVisibilityRepository`; returning
  backend rows directly would bypass the SQLite authority defined by this fix.
- Real Chromium verification retains the same managed-sandbox limitation; all 131 tests pass in
  the permitted execution context.
