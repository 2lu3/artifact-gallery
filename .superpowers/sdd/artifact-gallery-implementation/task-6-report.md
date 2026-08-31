# Task 6 report

## Status

完了。FTS5 trigram 検索、1–2 文字 fallback、固定 20 件 corpus 評価、prepared SQLite indexer、repair、および全検索 return path の `SearchVisibilityRepository.filterVisibleCandidates()` gate を実装した。

## Commit

`feat: implement FTS5 trigram search`（このレポートを含む Task 6 コミット）

## Tests

- `pnpm lint`: PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS（17 files、147 tests。実 Chromium のため sandbox 外で実行）
- 固定 corpus: trigram 20/20 top-five、prototype bigram 20/20 top-five
- 各固定 query を 10 回実行: per-query median はすべて 200 ms 以下、全体 median 0.084 ms、max 0.279 ms（400 ms 超過なし）
- RED を確認した主な境界: 004 schema、NFKC/parser、prepared indexer、processor default indexer、検索 repository、legacy backfill

## Concerns

- 実装上の未解決事項なし。
- sandbox 内では macOS Mach port 制限により Chromium が起動できない。権限付きの同一 `pnpm test` 実行では HTML isolation 37 件を含む全 147 件が通過した。
