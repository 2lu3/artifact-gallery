# Fixed search corpus

The artifact IDs are the insertion-order IDs declared in `manifest.json`. Do not reorder the
artifact list without updating every expected ID.

Evaluation flow:

```text
20 HTML/Markdown files
          |
          v
real processor extraction
          |
          v
SQLite normalized generation rows
          |
          +--> query has 3+ chars --> FTS5 trigram
          |
          +--> query has 1-2 chars -> bounded 100-row scan
          |
          v
SearchVisibilityRepository gate
          |
          v
ranked top five ---- expected artifact ID
```

Each query runs ten times. The evaluation records per-query median and maximum latency, requires
at least 18 of 20 expected IDs in the top five, requires every median to be at most 200 ms, and
flags any maximum over 400 ms for investigation. The prototype bigram comparison uses these same
normalized rows. FTS5 trigram remains the default whenever it meets both quality and median gates.
