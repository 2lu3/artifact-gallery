# Task 7 report

## Status

完了。起動ごとに生成するセッショントークンで全 `/api` route を保護し、trusted bootstrap 注入、`127.0.0.1` 固定 bind、実 processor・SearchRepository visibility gate・PathPolicy・SQLite 永続化へ接続した API を実装した。gallery/search は署名付き opaque cursor に sort key、ID、sort、filter、正規化 query fingerprint、catalog/search revision を含め、30件固定の keyset pagination と tamper／stale 検出を行う。

登録、import status/cancel、refresh/retry/rebuild、relink、title、catalog-only delete、detail、Finder/open-source adapter 境界を追加した。公開エラーは code/stage/retryable/safe message のみに限定し、missing/processing/ready/partial/failed の ASCII 状態図と、失敗時にも最後の成功サムネイルを保持する card contract を実装した。

## Commit

`feat: add token-protected local API`（このレポートを含む Task 7 コミット）

## Tests

- `pnpm lint`: PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS（20 files、165 tests。実 Chromium のため sandbox 外で実行）
- Task 7 focused: 4 files、14 tests PASS
- 実 temp SQLite/filesystem/PathPolicy/ArtifactProcessor と Fastify inject で、全 route auth、token freshness/non-persistence、loopback bind、30+5 pagination、cursor tamper/stale/filter/query/sort、SearchRepository visibility gate、rapid duplicate upsert、structured error redaction、relink acceptance/rejection、title index update、refresh/retry/rebuild、状態遷移と thumbnail retention、idempotent catalog-only delete/source preservation、platform action authorization を検証した。
- request/response abort event は listener cleanup と cancellation callback を独立テストし、登録処理では durable import cancellation へ接続した。

## Concerns

- 実装上の未解決事項なし。
- sandbox 内では macOS Mach port 制限により Chromium が起動できない。同一の `pnpm test` を権限付きで実行し、HTML isolation 37件を含む全165件の通過を確認した。
