# Task 7 report

## Status

完了。fix round 2/5 の5 findingsをすべて修正した。round 1のasync queue、opaque thumbnail、SQL keyset paginationも維持している。

- file registrationはPathPolicy認可後のcanonical pathでrun/itemを作成し、同じcanonical pathをsource lock keyとprocessor入力に使う。`/x`と`/./x`の同時登録は直列化され、両runがcompletedになる。
- trusted bootstrapを返す前にHostを検証する。default allowlistは`localhost`と`127.0.0.1`のみ、optional portは実際のconfigured portだけを許可する。IPv6 loopbackは明示設定時だけ許可し、forwarded host headersは参照しない。
- 成功・認証失敗・Host失敗・not found・thumbnailを含む全`/api` responseへ`Cache-Control: no-store`とtoken headerの固定`Vary`を付与する。
- Vite dev middlewareはquery付き`/`と`/index.html`をpathnameで判定し、Fastify bootstrapを`transformIndexHtml`へ通してHMR clientを注入する。upstream失敗・不正content-type・自己proxy markerは502/no-storeでfail closedする。
- server entrypointはSIGINT/SIGTERMを一つのclosing promiseへ集約する。close中もsignal listenersを保持し、background queueをdrainする`app.close()`完了後にのみexitし、成功/失敗時にlistenersを除去する。

## Commit

`fix: secure local bootstrap and shutdown`（このレポートを含むfix roundコミット）

## Tests

- `pnpm lint`: PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS（24 files、182 tests。実Chromiumを含みsandbox外で実行）
- round 2 focused: 5 files、25 tests PASS
- 実temp SQLite/Fastify/PathPolicy/ArtifactProcessorでcanonical alias同時登録を検証し、Host/port/IPv6/forwarded header、全API cache headers、Vite query/HMR/fail-closed/recursion、SIGINT/SIGTERM one-shot drain/listener cleanupを検証した。

## Concerns

- 実装上の未解決事項なし。
- sandbox内の全テストはmacOS Mach port制限でChromium起動に失敗する。同じ`pnpm test`をsandbox外で再実行し、HTML isolation 37件を含む全182件の通過を確認した。
