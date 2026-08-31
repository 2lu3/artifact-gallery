# Task 7 report

## Status

完了。fix round 1/5 の6 findingsをすべて修正した。

- devはViteがFastifyのtrusted bootstrapを同一originへ中継し、`/api`をproxyする。prodはFastifyがVite build済み`index.html`と`/assets/*`を配信し、tokenをno-store bootstrapへだけ注入する。
- card/detailから絶対`thumbnailPath`を除去し、署名付きopaque URLとsession-token必須のWebP endpointへ変更した。derivative専用PathPolicy、identity再検証、read上限、MIME確認、安全な404を接続した。
- file/folder登録とrefresh/retry/rebuildはrun/itemを先に永続化して即時202 `{ runId }`を返し、capacity 64/concurrency 2のbackground queueで実processorを実行する。request abort、明示cancel、列挙境界、processor stage境界でdurable cancelする。
- folder列挙エラーもartifact未所有の`artifact_error`とfailed import itemとして保存し、成功itemは継続する。run summaryはbasenameと公開code/stage/retryable/messageだけを返す。
- `filter=all|html|markdown`と独立`status` filterをSQLite側で適用し、両方を署名cursor contextへ含めた。
- GalleryRepositoryがstatus/format/keyset tuple predicates、SQL ORDER、LIMIT 31を実行する。gallery全件のJS materializationを廃止し、SearchRepositoryの200件上限とvisibility gateを維持したまま同じkeyset queryへ接続した。

## Commit

`fix: harden async local API integration`（このレポートを含むfix roundコミット）

## Tests

- `pnpm lint`: PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS（22 files、174 tests。実Chromiumを含みsandbox外で実行）
- Task 7 focused: 7 files、31 tests PASS
- 実temp SQLite/Fastify/filesystem/PathPolicy/ArtifactProcessorで、prod bootstrap→module asset→API、opaque thumbnail auth/read/tamper、即時202、処理中cancel、列挙中cancel、already-aborted、部分列挙失敗継続、rapid duplicate、format/status cursor stale、newest/title SQL keyset 31件取得を検証した。

## Concerns

- 実装上の未解決事項なし。
- sandbox内の全テストはmacOS Mach port制限でChromium起動に失敗する。同じ`pnpm test`をsandbox外で再実行し、HTML isolation 37件を含む全174件の通過を確認した。
