# Task 2 report — Persistence

## Files changed

- Added `migrations/001_initial.sql` with the seven binding data-model tables,
  closed status checks, path/generation uniqueness, foreign keys, and lookup indexes.
- Added `src/server/db/database.ts` for ordered SQL migrations and per-connection
  WAL, foreign-key, and busy-timeout configuration.
- Added `src/server/repositories/artifact-repository.ts` for canonical-path
  upsert, orthogonal state, structured issues, generation allocation, and atomic
  generation commits guarded by the artifact generation counter.
- Added `src/server/repositories/import-repository.ts` for durable run/item
  creation, pre-stage transitions, cancellation gating, failure linkage, and
  terminal transitions.
- Added `src/server/repositories/allowed-root-repository.ts` for idempotent
  canonical allowed-root persistence.
- Added `src/server/db/recovery.ts` for startup interruption reconciliation,
  unstarted-item reporting, and narrowly scoped temporary derivative cleanup.
- Added five integration test files plus a real child-process fixture under
  `tests/fixtures/forced-termination.ts`.

## Per-behavior RED evidence

Every behavior was introduced by a focused test against real temporary SQLite
databases. No database or repository mocks were used.

1. **Fresh migration and durable PRAGMAs**
   - Command: `pnpm test src/server/db/database.test.ts`
   - RED: suite failed to import missing `./database.js`.
   - Break caught: absent migration runner/schema, WAL, or foreign-key setup.
2. **Schema integrity constraints**
   - Command: `pnpm test src/server/db/database.test.ts`
   - RED: 3/4 tests failed because duplicate paths/generations, orphan rows, and
     out-of-domain states were accepted.
   - Break caught: removal of UNIQUE, FOREIGN KEY, or CHECK constraints.
3. **Orthogonal card-state derivation**
   - Command: `pnpm test src/server/repositories/artifact-repository.test.ts`
   - RED: suite failed to import missing `./artifact-repository.js`.
   - Break caught: incorrect `missing > processing > ready > partial > failed`
     precedence over independently persisted facts.
4. **Structured durable errors and warnings**
   - Command: `pnpm test src/server/repositories/artifact-repository.test.ts`
   - RED: `repository.recordError is not a function`.
   - Break caught: missing durable structure or accidental mutation of card state.
5. **Atomic generation commit and stale rollback**
   - Command: `pnpm test src/server/repositories/artifact-repository.test.ts`
   - RED: `repository.commitGeneration is not a function`.
   - Break caught: partial generation updates or loss of the prior active success
     when the generation counter has advanced.
6. **Canonical-path repository upsert**
   - Command: `pnpm test src/server/repositories/artifact-repository.test.ts`
   - RED: `UNIQUE constraint failed: artifact.source_path`.
   - Break caught: duplicate rows or discarded active generation/counter state.
7. **Durable import transitions before work**
   - Command: `pnpm test src/server/repositories/import-repository.test.ts`
   - RED: suite failed to import missing `./import-repository.js`.
   - Break caught: in-memory-only run/item stage transitions.
8. **Failure linkage and cancellation persistence**
   - Command: `pnpm test src/server/repositories/import-repository.test.ts`
   - RED: `imports.attachArtifact is not a function`.
   - Break caught: dropped `artifact_id`/`error_id` links or terminal state.
9. **Cancellation gate**
   - Command: `pnpm test src/server/repositories/import-repository.test.ts`
   - RED: `startStage` returned `undefined` and mutated a cancelled run's item.
   - Break caught: a new stage starting after `cancel_requested_at` is persisted.
10. **Allowed-root persistence**
    - Command: `pnpm test src/server/repositories/allowed-root-repository.test.ts`
    - RED: suite failed to import missing `./allowed-root-repository.js`.
    - Break caught: duplicate canonical roots or non-durable root registration.
11. **Forced-termination startup recovery**
    - Command: `pnpm test src/server/db/recovery.test.ts`
    - RED: suite failed to import missing `./recovery.js`.
    - Break caught: stranded active state, silent resume of queued items, loss of
      completed derivative facts, or deletion outside the `.tmp` contract.

## GREEN evidence

- Fresh migration/constraint suite: 4/4 passed.
- Artifact repository suite: 4/4 passed.
- Import repository suite: 3/3 passed.
- Allowed-root repository suite: 1/1 passed.
- Forced-termination recovery suite: 1/1 passed after a real child process was
  killed with `SIGKILL` and the database reopened.
- Focused persistence command passed 13/13 tests across 5 files.

## Verification commands and output

Required full verification was run after the final self-review changes:

```text
pnpm lint && pnpm typecheck && pnpm test && pnpm build

eslint .                                      exit 0
tsc --noEmit                                  exit 0
Test Files  6 passed (6)
Tests       14 passed (14)
vite build                                   15 modules transformed, exit 0
tsc --project tsconfig.server.json            exit 0
```

The focused persistence verification was also run independently:

```text
Test Files  5 passed (5)
Tests       13 passed (13)
```

## Self-review

- The migration creates every listed field on `artifact`,
  `artifact_generation`, `artifact_error`, `artifact_warning`, `allowed_root`,
  `import_run`, and `import_item`; tests inspect the complete column lists.
- `artifact.source_path`, `allowed_root.canonical_path`, and
  `(artifact_id, generation)` are unique final defenses; orphan generation and
  import-item rows are rejected with foreign keys enabled.
- Card presentation reads the current generation-counter row and applies the
  binding precedence without an overloaded artifact status column.
- Generation commit updates result facts and the active pointer in one SQLite
  transaction. A stale counter throws `StaleGenerationError` and rolls back the
  generation update, leaving the previous active generation intact.
- Import stages are written synchronously before control returns to the caller;
  a cancellation request is checked in the same conditional UPDATE that starts
  a stage.
- Recovery changes only queued/running runs, queued/processing items, and
  queued/processing generations. It does not clear ready fields, extracted text,
  thumbnail paths, or the prior active pointer.
- Cleanup is restricted to regular files ending in `.tmp` within the explicitly
  supplied derivative directory; permanent and unrelated files are covered by
  the forced-termination test.
- The child-process fixture lives outside `src`, so it is not emitted in the
  production server build.

## Commit hash

`346f4d11c511c79a948574b9362121dd342d1ca7`

## Concerns

- Later processing code must use the `.tmp` suffix and pass its derivative
  directory to startup reconciliation so cleanup remains narrow and auditable.
- Import run/item status domains were closed around the lifecycle required by
  this task (`queued/running/...` and `queued/processing/...`); future lifecycle
  expansion must use a migration rather than inserting ad-hoc status strings.

## Fix round 1/5

### Files changed

- Updated `src/server/repositories/artifact-repository.ts` so an all-failed
  generation is committed as durable history without replacing the prior active
  successful generation.
- Updated `migrations/001_initial.sql` with composite owner foreign keys for
  artifact active generations, error/warning generations, and import-item errors.
- Updated `src/server/repositories/import-repository.ts` with guarded from-state
  transitions and explicit `InvalidImportTransitionError` failures for zero-row
  run/item mutations.
- Extended `database.test.ts`, `artifact-repository.test.ts`, and
  `import-repository.test.ts` with regression coverage for all three findings.

### RED evidence

1. **All-failed generation fallback**
   - Focused test:
     `src/server/repositories/artifact-repository.test.ts` —
     `keeps the prior active generation when a new generation has no ready derivative`.
   - Command:
     `pnpm test src/server/repositories/artifact-repository.test.ts -t "keeps the prior active generation"`.
   - RED: expected `active_generation_id: 1`, received
     `active_generation_id: 2`; 1 failed, 4 skipped.
2. **Cross-artifact ownership**
   - Focused migration test:
     `src/server/db/database.test.ts` —
     `rejects cross-artifact generation and issue associations`.
   - Command:
     `pnpm test src/server/db/database.test.ts -t "rejects cross-artifact"`.
   - RED: updating artifact A to generation B did not throw; 1 failed, 4 skipped.
   - Focused repository test:
     `src/server/repositories/import-repository.test.ts` —
     `rejects an item failure owned by another artifact`.
   - Command:
     `pnpm test src/server/repositories/import-repository.test.ts -t "owned by another artifact"`.
   - RED: linking artifact A's item to artifact B's error did not throw; 1 failed,
     3 skipped.
3. **Import transition guards and unknown IDs**
   - Focused tests:
     `rejects restart and terminal mutation of completed or interrupted jobs` and
     `reports unknown import run and item IDs instead of silently succeeding` in
     `src/server/repositories/import-repository.test.ts`.
   - Command:
     `pnpm test src/server/repositories/import-repository.test.ts -t "rejects restart and terminal mutation|reports unknown"`.
   - RED: both tests observed void success instead of an explicit transition
     failure; 2 failed, 4 skipped.

### GREEN evidence

- All-failed fallback focused test: 1/1 passed.
- Cross-artifact migration focused test: 1/1 passed.
- Cross-artifact import repository focused test: 1/1 passed.
- Import terminal/unknown-ID focused tests: 2/2 passed.
- Combined changed suites:
  `pnpm test src/server/db/database.test.ts src/server/repositories/artifact-repository.test.ts src/server/repositories/import-repository.test.ts`
  passed 16/16 tests across 3 files.

### Full verification

The required command was rerun after the fixes and self-review:

```text
git diff --check && pnpm lint && pnpm typecheck && pnpm test && pnpm build

git diff --check                              exit 0
eslint .                                      exit 0
tsc --noEmit                                  exit 0
Test Files  6 passed (6)
Tests       19 passed (19)
vite build                                   15 modules transformed, exit 0
tsc --project tsconfig.server.json            exit 0
```

### Self-review

- `commitGeneration` still validates the generation counter and commits the
  failed generation atomically, but only changes `active_generation_id` when at
  least one derived result is ready.
- Composite foreign keys use `(id, artifact_id)` parent keys, so existence alone
  is insufficient: active generations, issue generations, and import errors must
  have the same artifact owner as their child row.
- Run transitions now permit only `queued -> running`, active -> cancelled, and
  `running -> completed`. Item terminal transitions require an active item;
  completed/interrupted records cannot be reopened or overwritten.
- All void mutation methods validate exactly one updated row and throw
  `InvalidImportTransitionError` for both invalid from-state and unknown IDs.
  `startStage` retains its existing explicit boolean failure contract.

### Commit hash

`a499e4eca706ada57a09ec34cf6d477ca2253b03`

### Concerns

- `InvalidImportTransitionError` intentionally does not distinguish an unknown
  ID from a known row in the wrong state; callers receive one safe transition
  failure while repository internals avoid an extra race-prone read.
