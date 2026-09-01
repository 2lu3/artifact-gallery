# Task 10 Report

## 実装状況

- Node.js `24.20.0` / pnpm `11.21.0` を `.nvmrc`、`engines`、`packageManager`、CI、README で統一し、`.npmrc` の `engine-strict=true` と frozen lockfile install を採用した。
- Prettier `3.8.2` と `format` / `format:check` を追加し、既存ソースを一度整形した。`pnpm-lock.yaml`、履歴レポート、生成物、font/image/SQLite fixture は `.prettierignore` で除外した。
- GitHub Actions を8ケースの least-privilege matrix として追加した。30分 timeout、同一 ref の concurrency cancellation、Node/pnpm/lock hash を含む pnpm cache key、Playwright `1.58.2`/lock hash を含む Chromium cache keyを設定した。
- 100件の固定性能コーパス、中央値・最大値・2倍外れ値ゲートを追加した。first page の5回は各回を新規 state、production Node process、Chromium process/context で起動し、navigationから30カードまでを測る。固定10検索は各10回、debounce後→render と入力前の外部 `performance.now()`→render の両方を記録・強制する。thumbnail は別の新規派生ディレクトリ、新規 context、cache disabled でcold、その同一リソース再読でwarmを測る。Task 9 の実 Chromium RSS・2 context・キャンセル harness も両 profile から再利用した。
- performance runner のproduction childを同期spawn直後から一つのresource scopeで所有するようにした。readiness、bootstrap/gallery、Chromium、context、計測本体のどこで失敗しても、取得済みcontext/browser、child、stateを順に回収する。context/browser closeは個別に2秒で打ち切るunref timerを持ち、一方が永続pendingでもchild停止とstate削除へ進む。childはSIGTERM後に時間制限付きSIGKILLへ移行する。
- thumbnail bootstrap/galleryはbody完了まで共有15秒deadlineのowned AbortControllerで囲み、health navigationとbrowser内thumbnail cold/warmも同deadlineの残り時間で打ち切る。性能state seedingはDB open直後から`try/finally`で所有し、PathPolicy/processor/indexingの失敗でもDB close後に部分stateを削除する。
- production smoke は親環境の DB/thumbnail/state/root/client/port/development override を除去し、絶対パスの一時 DB・thumbnail・state だけでビルド済み server を loopback 起動する。bootstrap token を取得して health と空 gallery を認証付きで確認し、SIGTERM の正常終了を待つ。token と child output はログへ出さない。
- CI failure artifact は credential scanner を通過した performance JSON だけに限定した。Playwright は line reporter のみで、HTML/trace/video/screenshot を生成・uploadしない。テストのtoken非出力検査も actual token ではなく boolean/redacted assertion にした。
- runtime state の既定値をリポジトリ内 `.artifact-gallery` から OS 標準のユーザーデータ領域へ移した。環境変数による DB/thumbnail/root/port の上書きは維持した。
- README に install、dev/build/start、UI登録、許可ルート、token/HTML隔離、データ場所、backup、crash recovery、sandbox/browser troubleshooting、カタログ削除とアプリ削除、元ファイル非削除、test/perf コマンドを記載した。

## Strict TDD evidence

| 境界 | RED | GREEN |
| --- | --- | --- |
| 性能 corpus / 統計 / profile | `tests/performance/harness.test.ts` が未実装 module で失敗 | 50 HTML + 50 Markdown、50MB gate、中央値/最大値/2倍判定、acceptance/smoke profile の4 testsが通過 |
| production smoke | 未実装 module で失敗 | 実 child server で bootstrap、認証 health/空gallery、token非出力、SIGTERM終了の3 testsが通過 |
| runtime data default | repo内 `.artifact-gallery` が期待に反して失敗 | macOS/Linux/Windows のユーザーデータ領域を返す実装で通過 |
| acceptance gate | 未実装関数で失敗 | Apple Silicon 条件、median超過、2倍外れ値を拒否する test が通過 |
| performance runner | state directory 不在、旧 runtime token の thumbnail URL で順に失敗 | state directory 作成と同一 runtime の resource token 使用で実 smoke が通過 |
| smoke timer cleanup | 実行後の active timeout が 1件増えて失敗 | 終了 race の timer を clear し、CLI所要時間を約15.5秒から約0.47秒へ短縮 |
| smoke request timeout | 停止した bootstrap 応答が100ms budgetを超え、約721ms待って失敗 | fetch を残り budget で abort し、約241ms以内に child の正常停止まで完了 |
| UI search run sequence | 未実装関数で失敗 | 固定10検索を同一語が連続しない順序で各10回実行する sequence test が通過 |
| user-observed search gate | debounce後のアプリ値16.90msに対して入力前からの実測中央値282.34msとなり、200ms gateに失敗 | debounceを100msに変更し、アプリ値と外部実測値を別系列で保存・gate。外部 worst median 125ms台で通過 |
| independent cold lifecycle | cold resource作成関数が存在せず、5回の作成/終了 test が失敗 | 各回を別 state・production Node・Chromium/context とし、HTTPでrootをwarmせずTCP listen確認後にnavigation計測 |
| smoke environment isolation | 親環境の user DB/root override がchildへ残り、gallery itemsが1件となって失敗 | overrideを除去して絶対一時DB/thumbnail/stateを明示し、非空gallery自体も失敗にした |
| token-free artifact | scanner CLIが存在せず失敗 | metricsは許可し、bootstrap marker、token header、`sessionToken`、40文字以上のtoken候補を固定文だけで拒否 |
| Node pin consistency | package enginesが旧pinのため失敗 | `.nvmrc`、package engines、CIの3箇所、READMEを24.20.0へ統一し、metadata testが通過 |
| Node 24.20 parallel timing | full suiteで既存30ms worker fixtureがrender到達前のextract timeoutとなり1件失敗。production smoke fixtureも600msで閉じるstalled socketに対し100msのshutdown猶予では並列時だけ不足 | production上限は変えずworker fixtureを250ms、smoke fixtureを400ms（総rejectは1秒未満）へ拡張し、full suite 243/243でdurable terminal stateとgraceful child終了を再確認 |
| performance resource lifecycle | 新規 lifecycle module が無いためfailure-injection suiteがimport時にRED。その後、未選択の終了監視listener 1件とnever-settling closeによる200ms stallもRED | cold/thumbnailの10取得段階、cleanup競合、SIGKILL fallback、永続pending context/browser closeを検査。各closeを個別期限でsettleし、child/state回収、active resource非増加、listener 0件を含む13/13が通過 |
| performance HTTP deadline | deadline helperとbrowser thumbnail helperが未実装のため各testがRED | TCP-readyで応答しない実Node childのbootstrapを75msでabortし、実Chromium thumbnail fetchも同様にtimeout。いずれもbrowser/child/stateを1秒未満で回収する2/2が通過 |
| performance seed ownership | seed-state module未実装で2 testsがRED | 注入PathPolicy rejectionと実invalid rootの双方で、open済みSQLite closeを観測し、部分temp stateとlockを残さない2/2が通過 |

## Clean install evidence

- 元の `node_modules`（約212MB）は削除・再リンクしていない。
- round3最終ソースを `/tmp/artifact-gallery-round3-clean.QBHk4j` へ `node_modules` / `.git` / build・test出力を除外してコピーした。
- miseへNode.js `24.20.0`とpnpm `11.21.0`を導入し、その指定版で一時コピーの `pnpm install --frozen-lockfile --store-dir /Users/rainly/.local/share/pnpm/store/v11` を実行した。lockfile unchanged、352 packages reused、exit 0。
- 同じ指定版・一時コピーで `format:check`、`lint`、`typecheck`、`pnpm build` がexit 0。client 18 modulesとserver outputを確認した。

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

失敗時 artifact は scanner がtoken候補、bootstrap marker、token headerを含まないと確認した performance metrics JSON のみに限定した。Playwright はline reporterのみでHTML/trace/video/screenshotを生成・uploadしない。

## Performance results

基準環境: macOS / arm64、16 CPU cores、128GiB。コーパス: HTML 50 + Markdown 50、252,430 bytes。

| Profile / measurement | Median | Max | Gate |
| --- | ---: | ---: | --- |
| acceptance first page（5 independent production cold starts） | 81.58ms | 81.71ms | 1,000ms |
| acceptance search accepted→render（worst query） | 12.15ms | 119.00ms | 200ms |
| acceptance search user-observed fill→render（worst query） | 125.77ms | 251.12ms | 200ms |
| acceptance thumbnail cold / warm（30件） | 51.40ms / 38.10ms | 同左 | 記録値 |
| CI smoke first page（5 independent production cold starts） | 81.47ms | 105.74ms | 5,000ms |
| CI smoke search accepted→render（worst query） | 12.65ms | 19.40ms | 1,000ms |
| CI smoke search user-observed fill→render（worst query） | 126.96ms | 135.33ms | 1,000ms |
| CI smoke thumbnail cold / warm（30件） | 46.00ms / 30.00ms | 同左 | 記録値 |

最大値が各 profile target の2倍を超えた項目はない。

Task 9 harness 再利用結果:

- acceptance: Chromium peak RSS 317.7MiB、5 samples、2 contexts、cancel 62.6ms、commit critical max 1.01ms。
- CI smoke: Chromium peak RSS 307.1MiB、5 samples、2 contexts、cancel 61.9ms、commit critical max 0.92ms。

## Verification

- `pnpm dev`: API / worker / Vite の3 process を起動。API `127.0.0.1:3000` と UI `127.0.0.1:5173` は本文/tokenを表示せず HTTP 200 を確認し、Ctrl-C で停止。
- 指定toolchain: Node.js `24.20.0` / pnpm `11.21.0`。
- `pnpm test`: 35 files / 243 tests passed。search 20/20、median 0.154ms、max 7.205ms。実 Chromium reliability 7/7、peak RSS 269.0MiB、cancel 62.3ms、commit critical max 1.95ms。実 Chromium isolation 39/39。
- `pnpm test:e2e`: line reporterで19/19 passed。HTML/trace/video/screenshotなし。
- `pnpm perf:smoke`: independent production cold、両検索系列、thumbnail cold/warmがpassed。Task 9 reliability selected test passed。
- `pnpm perf:acceptance`: 同上、Apple Silicon acceptanceがpassed。Task 9 reliability selected test passed。
- `pnpm build`: Vite client 18 modules と TypeScript server build passed。
- `pnpm smoke:prod`: 親runtime overrideを継承せず、bootstrap / health / empty gallery / graceful shutdown passed、token非出力。
- `pnpm artifacts:check`: performance JSONのcredential scan passed。
- failure injection: lifecycle 13/13、HTTP hang 2/2、seed failure 2/2 passed。永続pending close、TCP-ready hang、PathPolicy rejection/invalid rootの各失敗でchild/browser/DB/state/timer/listenerを残さない。
- round3最終一時clean copyで `pnpm install --frozen-lockfile`、`format:check`、`lint`、`typecheck`、`build` passed。
- CI YAML parse と `git diff --check`: passed。

## Concerns

- GitHub-hosted runner 上の workflow 自体は未実行。8つの matrix command は同一 macOS host 上で個別に検証済みで、Ubuntu固有の Chromium system dependencies は CI の `playwright install --with-deps chromium` に委ねる。
- 性能値はこのホスト固有。CI smoke は機械差を吸収する余裕ある閾値で、製品 acceptance は指定 Apple Silicon 条件でのみ強制する。
