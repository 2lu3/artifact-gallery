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
