# TODOS

## Search

### Evaluate semantic search alongside lexical search

**What:** Evaluate semantic search as a supplement to the SQLite lexical search.

**Why:** It may improve rediscovery when the remembered wording does not occur in the artifact.

**Context:** Complete the v1 twenty-query lexical-search evaluation first, then analyze failed queries. Preserve lexical search as the baseline and add embeddings only if measured misses show that semantic retrieval would help.

**Effort:** L
**Priority:** P3
**Depends on:** v1 search evaluation and real usage data

## Import

### Evaluate automatic refresh with file watching

**What:** Detect changes under allowed roots and propose or run refreshes for affected artifacts.

**Why:** It may reduce stale thumbnails and search content caused by forgotten manual refreshes.

**Context:** V1 intentionally uses manual refresh. Revisit only if update omissions become a real problem, accounting for duplicate macOS events, rename and atomic-save patterns, bulk changes, and changes during active processing. Reuse `ArtifactProcessor`; do not create a second refresh pipeline.

**Effort:** L
**Priority:** P3
**Depends on:** Stable v1 `ArtifactProcessor` and evidence of update friction

### Suggest relink candidates by content hash

**What:** Suggest files inside allowed roots whose content hash matches a missing artifact.

**Why:** It may shorten recovery after a source file is moved.

**Context:** V1 requires explicit file selection. A future version may show candidates but must never relink automatically. Restrict discovery to allowed roots and require the user to choose when identical content exists at multiple paths.

**Effort:** M
**Priority:** P3
**Depends on:** Measured missing-reference frequency and allowed-root scan performance

## Rendering

### Design isolated rendering for script-dependent HTML

**What:** Investigate a separate rendering boundary for HTML that requires JavaScript.

**Why:** Canvas, client-rendered charts, and other dynamic artifacts may be blank when v1 disables scripts.

**Context:** Do not add a script-enabled switch to the v1 renderer. Any future design must reconsider the threat model and include OS-level isolation, complete network denial, and CPU, memory, and time limits. Start only after collecting real examples that cannot be represented safely by the static renderer.

**Effort:** XL
**Priority:** P4
**Depends on:** Real unsupported artifacts and a new security review

## Completed
