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

## Review fix round 1

- Status: 完了。
- Commit: `fix: preserve eligible search candidates and short query semantics`（この追記を含む review fix コミット）。
- P1 visibility starvation: FTS candidate SQL が active generation、`index_status=ready`、visibility `visible` を BM25 ranking と `LIMIT 500` より前に適用するよう修正。最終 `SearchVisibilityRepository.filterVisibleCandidates()` gate は全 return path で維持。
- P1 short fallback: parser が normalized part ごとの `{ value, phrase }` を公開し、unquoted part はフィールド横断 AND、quoted part のみ contiguous phrase として評価。1–2 Unicode 文字と最大 100 active candidates の境界を維持。
- RED/GREEN: stale 500 世代が active generation 501 を押し出す実 SQLite 再現、`a middle b`、`"a b"`、`猫 a`、`猫 middle 犬` を追加。
- `pnpm lint`: PASS。
- `pnpm typecheck`: PASS。
- `pnpm build`: PASS。
- `pnpm test`: PASS（17 files、150 tests。実 Chromium のため sandbox 外で実行）。
- 固定 corpus: trigram 20/20 top-five、prototype bigram 20/20 top-five。10 回/query の全体 median 0.110 ms、max 5.325 ms。200 ms／400 ms gate を維持。
- Concerns: 未解決事項なし。

## Review fix round 2

- Status: 完了。
- Commit: `fix: filter short and empty candidates before limits`（この追記を含む review fix コミット）。
- P1 short/empty starvation: short CTE と empty list の candidate SQL に active generation、`index_status=ready`、visibility `visible` JOIN を追加し、100／500 件の LIMIT より前に eligibility を適用。最終 `SearchVisibilityRepository.filterVisibleCandidates()` gate は両経路で維持。
- RED/GREEN: short は新しい failed/quarantined 101 artifacts、empty は 501 artifacts が古い eligible candidate を押し出す実 SQLite 再現を追加。
- `pnpm lint`: PASS。
- `pnpm typecheck`: PASS。
- `pnpm build`: PASS。
- `pnpm test`: PASS（17 files、152 tests。実 Chromium のため sandbox 外で実行）。
- 固定 corpus: trigram 20/20 top-five、prototype bigram 20/20 top-five。10 回/query の全体 median 0.112 ms、max 5.253 ms。200 ms／400 ms gate を維持。
- Concerns: 未解決事項なし。
