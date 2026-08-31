# Task 3 report: centralized PathPolicy

## Status

Complete. The centralized filesystem authorization boundary is implemented without modifying the existing database or repository persistence code.

## Files

- `src/server/security/path-policy.ts`
  - Canonical allowed-root creation and component-aware containment
  - Existing file and directory authorization
  - Separate missing-path validation without a read capability
  - Classified `PathPolicyError` failures
  - Recursive folder enumeration with item-level errors
  - Revalidating file read handle for check/use replacement defense
- `tests/security/path-policy.test.ts`
  - 15 real-filesystem tests covering the required security and enumeration behavior
- `.superpowers/sdd/artifact-gallery-implementation/task-3-report.md`
  - This report

## Strict TDD RED/GREEN evidence

Each behavior group was introduced as a focused test and run before its implementation.

| Behavior group | Observed RED | Observed GREEN |
| --- | --- | --- |
| Allowed existing file and canonical read handle | Suite failed to import because `path-policy.ts` did not exist | 1 focused test passed |
| Component containment and sibling-prefix rejection | Outside sibling promise resolved instead of rejecting | 2 focused tests passed |
| Traversal rejection | Traversing path resolved and was authorized | 3 focused tests passed |
| Symlink rejection at file/intermediate components | Symlinked path resolved and was authorized | 4 focused tests passed |
| Hidden path components | Hidden path resolved and was authorized | 5 focused tests passed |
| Supported extension allowlist | `.txt` promise resolved instead of rejecting | 6 focused tests passed |
| Directory passed where file required | Directory promise resolved instead of rejecting | 7 focused tests passed |
| File passed where directory required | `authorizeDirectory` was not a function | 8 focused tests passed |
| Missing-path descriptor and missing classification | `validateMissingPath` was not a function | 9 focused tests passed |
| Recursive enumeration | `enumerateFolder` was not a function | 10 focused tests passed |
| Enumeration symlink handling | Enumeration aborted with `SYMLINK_REJECTED` instead of returning an item error | 11 focused tests passed |
| Unreadable-item continuation | Mode-`000` file was returned as an authorized file | 12 focused tests passed |
| Hidden-entry pruning during enumeration | Enumerator descended into the hidden directory and reported the child instead | 13 focused tests passed |
| Check/use replacement | Authorized read returned the outside symlink target contents | 14 focused tests passed |
| Self-review: outside-to-inside symlink and missing-path remainder | Outside symlink was authorized; missing path with later hidden component resolved | 15 focused tests passed |

Final focused run: `tests/security/path-policy.test.ts` — 15 passed, 0 failed.

## Required verification

Fresh command:

```text
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Result: exit 0.

- ESLint: clean
- TypeScript typecheck: clean
- Vitest: 7 files passed, 40 tests passed, 0 failed
- Vite client build: succeeded
- TypeScript server build: succeeded

## Self-review

- Containment uses `path.relative` component semantics, so sibling prefix names are not accepted.
- Existing targets are resolved with `realpath`; lexical components below an allowed root are independently checked with `lstat` so symlinks are not silently followed.
- Traversal and hidden components are rejected before use, including components after the first missing segment.
- Enumeration sorts entries deterministically, prunes hidden entries and symlinks, and records classified item errors while continuing with siblings.
- Every `AuthorizedFile.read()` re-runs file validation and canonical containment immediately before `readFile`.
- Mutation review confirms each security branch is protected by at least one behavior test.
- Existing persistence files and migrations were not changed.

## Commit

Implementation commit: `3245c3e` (`feat: add centralized path policy`)

## Concerns

None. The unreadable-item test uses POSIX mode `000`, which is supported by the target macOS environment as required by the brief.
