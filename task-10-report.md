# Task 10 Report

## 実装状況

- Node.js `24.14.0` / pnpm `11.21.0` を `.nvmrc`、`engines`、`packageManager`、CI、README で統一し、`.npmrc` の `engine-strict=true` と frozen lockfile install を採用した。
- Prettier `3.8.2` と `format` / `format:check` を追加し、既存ソースを一度整形した。`pnpm-lock.yaml`、履歴レポート、生成物、font/image/SQLite fixture は `.prettierignore` で除外した。
- GitHub Actions を8ケースの least-privilege matrix として追加した。30分 timeout、同一 ref の concurrency cancellation、Node/pnpm/lock hash を含む pnpm cache key、Playwright `1.58.2`/lock hash を含む Chromium cache keyを設定した。
- 100件の固定性能コーパス、中央値・最大値・2倍外れ値ゲート、5回の実UI cold-start first page、固定10検索の各10回 render-update 計測、cold/warm thumbnail 読み出しを追加した。acceptance と CI smoke の閾値を分離し、Task 9 の実 Chromium RSS・2 context・キャンセル harness を両コマンドから再利用した。
- production smoke はビルド済み server を一時 state directory と loopback port で起動し、bootstrap token を取得して health/gallery を認証付きで確認し、SIGTERM の正常終了を待つ。token と child output はログへ出さない。
- runtime state の既定値をリポジトリ内 `.artifact-gallery` から OS 標準のユーザーデータ領域へ移した。環境変数による DB/thumbnail/root/port の上書きは維持した。
- README に install、dev/build/start、UI登録、許可ルート、token/HTML隔離、データ場所、backup、crash recovery、sandbox/browser troubleshooting、カタログ削除とアプリ削除、元ファイル非削除、test/perf コマンドを記載した。

## Strict TDD evidence

| 境界 | RED | GREEN |
| --- | --- | --- |
| 性能 corpus / 統計 / profile | `tests/performance/harness.test.ts` が未実装 module で失敗 | 50 HTML + 50 Markdown、50MB gate、中央値/最大値/2倍判定、acceptance/smoke profile の4 testsが通過 |
| production smoke | 未実装 module で失敗 | 実 child server で bootstrap、認証 health/gallery、token非出力、SIGTERM終了の2 testsが通過 |
| runtime data default | repo内 `.artifact-gallery` が期待に反して失敗 | macOS/Linux/Windows のユーザーデータ領域を返す実装で通過 |
| acceptance gate | 未実装関数で失敗 | Apple Silicon 条件、median超過、2倍外れ値を拒否する test が通過 |
| performance runner | state directory 不在、旧 runtime token の thumbnail URL で順に失敗 | state directory 作成と同一 runtime の resource token 使用で実 smoke が通過 |
| smoke timer cleanup | 実行後の active timeout が 1件増えて失敗 | 終了 race の timer を clear し、CLI所要時間を約15.5秒から約0.47秒へ短縮 |
| smoke request timeout | 停止した bootstrap 応答が100ms budgetを超え、約721ms待って失敗 | fetch を残り budget で abort し、約241ms以内に child の正常停止まで完了 |
| UI search run sequence | 未実装関数で失敗 | 固定10検索を同一語が連続しない順序で各10回実行する sequence test が通過 |

## Clean install evidence

- 元の `node_modules`（約212MB）は削除・再リンクしていない。
- 最終ソースを `/tmp/artifact-gallery-final-clean.gQp8GG` へ `node_modules` / `.git` / build・test出力を除外してコピーした。
- 一時コピーで `pnpm install --frozen-lockfile --store-dir /Users/rainly/.local/share/pnpm/store/v11` を実行し、lockfile unchanged、352 packages、exit 0 を確認した。
- 同じ一時コピーで `format:check`、`lint`、`typecheck`、`build:client`、`build:server` がすべて exit 0。build は client 18 modules と TypeScript server output を生成した。

## CI matrix

| Job | Command | Chromium |
| --- | --- | --- |
| Format, lint, and typecheck | `pnpm format:check && pnpm lint && pnpm typecheck` | no |
| Unit and integration | `pnpm test:unit` | no |
| Chromium isolation | `pnpm test:isolation` | yes |
| Reliability integration | `pnpm test:reliability` | yes |
| Search evaluation | `pnpm test:search` | no |
| Performance smoke | `pnpm perf:smoke` | yes |
| End to end | `pnpm test:e2e` | yes |
| Production build and smoke | `pnpm build && pnpm smoke:prod` | no |

失敗時 artifact は token/data を含まない performance metrics JSON と、trace/video/screenshot を無効化した Playwright HTML report のみに限定した。

## Performance results

基準環境: macOS / arm64、16 CPU cores、128GiB。コーパス: HTML 50 + Markdown 50、252,430 bytes。

| Profile / measurement | Median | Max | Gate |
| --- | ---: | ---: | --- |
| acceptance first page (5 app/UI cold starts) | 66.97ms | 107.71ms | 1,000ms |
| acceptance worst UI search-render median (10 runs/query) | 24.60ms | 31.30ms（全検索の最大） | 200ms |
| acceptance thumbnail cold / warm (30件) | 19.19ms / 14.87ms | 同左 | 記録値 |
| CI smoke first page | 70.81ms | 146.69ms | 5,000ms |
| CI smoke worst UI search-render median | 17.55ms | 19.60ms（全検索の最大） | 1,000ms |
| CI smoke thumbnail cold / warm (30件) | 12.32ms / 14.38ms | 同左 | 記録値 |

最大値が各 profile target の2倍を超えた項目はない。

Task 9 harness 再利用結果:

- acceptance: Chromium peak RSS 282.2MiB、5 samples、2 contexts、cancel 67.2ms、commit critical max 0.77ms。
- CI smoke: Chromium peak RSS 283.7MiB、5 samples、2 contexts、cancel 52.4ms、commit critical max 0.71ms。

## Verification

- `pnpm dev`: API / worker / Vite の3 process を起動。API `127.0.0.1:3000` と UI `127.0.0.1:5173` は本文/tokenを表示せず HTTP 200 を確認し、Ctrl-C で停止。
- `pnpm test:unit`: 27 files / 175 tests passed。
- `pnpm test:isolation`: 実 Chromium 39 tests passed。
- `pnpm test:search`: 20/20 hits、median 0.097ms、max 4.545ms。
- `pnpm test:reliability`: 実 Chromium 7/7 tests passed。最終 run は peak RSS 356.6MiB、2 contexts、cancel 51.6ms、commit critical max 0.69ms。
- `pnpm perf:smoke`: passed。Task 9 reliability 1 selected test passed。
- `pnpm perf:acceptance`: passed。Task 9 reliability 1 selected test passed。
- `pnpm test`: 30 files / 222 tests passed。最終 run の search は20/20、median 0.115ms、max 5.083ms。実 Chromium peak RSS 348.0MiB、cancel 53.2ms、commit critical max 0.57ms。
- `pnpm test:e2e`: 19/19 passed。
- `pnpm build`: Vite client と TypeScript server build passed。
- `pnpm smoke:prod`: bootstrap / health / empty gallery / graceful shutdown passed、token非出力。
- `git diff --check`: passed。

## Concerns

- GitHub-hosted runner 上の workflow 自体は未実行。8つの matrix command は同一 macOS host 上で個別に検証済みで、Ubuntu固有の Chromium system dependencies は CI の `playwright install --with-deps chromium` に委ねる。
- 性能値はこのホスト固有。CI smoke は機械差を吸収する余裕ある閾値で、製品 acceptance は指定 Apple Silicon 条件でのみ強制する。
