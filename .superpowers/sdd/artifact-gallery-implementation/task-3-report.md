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

---

## Fix round 1

### Findings addressed

1. **Source/asset capability separation**
   - Kept `authorizeFile()` restricted to `.html`, `.htm`, and `.md` UTF-8 sources.
   - Added `authorizeAsset()` for contained regular files used by Playwright fulfillment.
   - Asset handles expose MIME metadata and `Buffer` reads, including CSS, common image/font/script types, and a safe `application/octet-stream` fallback.
   - Both source and asset reads revalidate path containment, symlink state, type, and readability immediately before the read syscall.
2. **Recursive directory replacement**
   - Every recursive `readdir()` now runs only after a fresh canonical containment, symlink, directory-type, and read/execute permission validation.
   - A deterministic real-filesystem replacement test captures the actual parent Dirent snapshot, swaps the child directory for an outside symlink, and verifies the outside child name is never enumerated.
3. **Public filesystem error normalization**
   - Normalized allowed-root `realpath`, missing-parent `realpath`, directory `stat/access`, root `readdir`, and post-validation `readFile` failures to `PathPolicyError`.
   - Added focused missing-root, unreadable-root, post-validation disappearance, and post-validation permission-loss coverage.

### Fix-round RED/GREEN evidence

| Regression | RED evidence | GREEN evidence |
| --- | --- | --- |
| MIME-typed binary asset handle without widening source formats | `authorizeAsset` was not a function | CSS/PNG/WOFF2/unknown bytes and MIME cases passed; `.css` remained rejected as a source |
| Recursive directory replacement | Result exposed `z-replaceable/outside-secret.html` instead of rejecting `z-replaceable` itself | Replacement is reported at the directory as `SYMLINK_REJECTED`; outside child is absent |
| Missing allowed root at policy creation | Raw `ENOENT` escaped | Classified `SOURCE_MISSING` `PathPolicyError` passed |
| Allowed root removed before missing-path validation | Raw `ENOENT` escaped | Classified `SOURCE_MISSING` `PathPolicyError` passed |
| Unreadable directory/root enumeration | Authorization resolved or raw `EACCES` escaped | Classified `UNREADABLE_SOURCE` `PathPolicyError` passed |
| File removed after validation but before read syscall | Raw `ENOENT` escaped | Classified `SOURCE_MISSING` `PathPolicyError` passed |
| Permission removed after validation but before read syscall | Raw `EACCES` escaped | Classified `UNREADABLE_SOURCE` `PathPolicyError` passed |

The two post-validation read races use a narrowly scoped fault hook around only the final `readFile` boundary; all validation and the failing read remain real filesystem operations. The directory replacement hook performs the real `readdir` first, then changes the real filesystem before returning its stale Dirent snapshot.

### Fix-round verification

Fresh command:

```text
pnpm exec vitest run tests/security/path-policy.test.ts && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Result: exit 0.

- Focused PathPolicy tests: 23 passed, 0 failed
- ESLint: clean
- TypeScript typecheck: clean
- Full Vitest suite: 7 files passed, 48 tests passed, 0 failed
- Client and server builds: succeeded

### Fix-round self-review

- Source authorization remains extension-restricted; only the explicit asset capability permits other contained regular files.
- Asset reads return bytes and never reuse the source text API.
- All read handles preserve immediate revalidation and normalize final syscall races.
- Recursive enumeration treats a Dirent only as discovery data, not authorization; the directory is reauthorized immediately before use.
- Public filesystem boundaries now convert raw Node errno failures into the five policy classifications.
- Mutation review covers removing source extension enforcement, removing asset revalidation, trusting stale Dirents, and deleting each error-normalization boundary.

### Fix-round concerns

None. Permission tests require POSIX permission semantics, which are supported by the target macOS environment.

---

## Fix round 2

### Finding addressed

Closed the remaining recursive enumeration window between a successful directory validation and the path-based `readdir()` syscall.

- Directory validation now returns a private snapshot containing canonical path, device id, and inode.
- `walkFolder()` obtains a pre-read snapshot, performs `readdir`, then revalidates the same path before processing any returned Dirent.
- A post-read symlink or containment/type failure discards the complete Dirent result and reports only the replaced directory.
- A successful post-read validation with changed `dev/ino` is classified as `UNREADABLE_SOURCE`, likewise discarding the complete result.
- No test hook or filesystem adapter was added to the production API.

### RED/GREEN evidence

| Regression | RED evidence | GREEN evidence |
| --- | --- | --- |
| Validated directory replaced by outside symlink immediately before `readdir` | Errors exposed `replaceable/outside-secret.html`; no error existed for `replaceable` itself | Only `replaceable` is reported as `SYMLINK_REJECTED`; outside child name appears in neither files nor errors |
| Validated directory replaced by a different allowed-root inode immediately before `readdir` | Replacement child was accepted as a source and no directory error was returned | Pre/post `dev/ino` mismatch reports only `replaceable` as `UNREADABLE_SOURCE`; replacement child appears in neither files nor errors |

The narrowly scoped test hook runs the real filesystem replacement immediately before the real `readdir` call. It changes only scheduling; validation, replacement, `readdir`, identity checks, and assertions all use the real filesystem.

### Verification

Fresh command:

```text
pnpm exec vitest run tests/security/path-policy.test.ts && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Result: exit 0.

- Focused PathPolicy tests: 25 passed, 0 failed
- ESLint: clean
- TypeScript typecheck: clean
- Full Vitest suite: 7 files passed, 50 tests passed, 0 failed
- Client and server builds: succeeded

### Self-review

- Dirent data is never processed until post-read policy validation succeeds.
- Device and inode comparison detects non-symlink rename replacement within an allowed root.
- The previous parent-snapshot/child-validation replacement regression remains covered independently.
- A post-read failure propagates to the parent entry boundary, so the item-level error path names the replaced directory rather than any fetched child.
- Mutation review covers removal of post-read validation and removal of either identity comparison field.

### Concerns

None.
