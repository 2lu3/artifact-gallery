# Artifact Gallery

Artifact Gallery は、手元の HTML / Markdown を登録し、サムネイル付きで検索・閲覧するローカル専用ギャラリーです。アプリが変更・移動・削除するのはカタログと派生データだけで、登録した元ファイルは読み取り専用として扱います。

## 必要条件

- Node.js `24.20.0`（現在の LTS。`.nvmrc` と `engines.node` で固定）
- pnpm `11.21.0`（`packageManager` と `engines.pnpm` で固定）
- macOS または Linux。HTML の隔離描画と E2E には Playwright Chromium が必要です。

Corepack を使う場合は、`corepack enable` と `corepack prepare pnpm@11.21.0 --activate` を先に実行してください。

## インストール

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Linux で Chromium の共有ライブラリも必要な場合は `pnpm exec playwright install --with-deps chromium` を使います。

## 起動

開発時は次の1コマンドで API、worker、Vite UI が起動します。

```sh
pnpm dev
```

ブラウザーで `http://127.0.0.1:5173` を開きます。API は `127.0.0.1:3000` のみに listen し、Vite が信頼済み bootstrap と `/api` を中継します。

プロダクション相当ではビルドしてから起動します。

```sh
pnpm build
pnpm start
```

`http://127.0.0.1:3000` を開いてください。`pnpm smoke:prod` は、親プロセスの DB / thumbnail / state / allowed-root / port 設定を child へ継承せず、絶対パスで指定した空の一時データ領域だけを使ってビルド済みサーバーを loopback 起動します。bootstrap、認証付き health、空の gallery、SIGTERM による正常終了を検査し、セッショントークンはログへ出しません。

## 生成物を登録する

1. 画面右上の「生成物を登録」を選びます。
2. 「ファイル」または「フォルダー」を選び、許可ルート配下の絶対パスを入力します。
3. 「登録を開始」を選び、完了件数または項目ごとのエラーを確認します。

対応形式は `.html`、`.htm`、`.md`、`.markdown` です。フォルダー登録は再帰的です。シンボリックリンク、許可ルート外の参照、隠し項目、対応外形式は拒否されます。

## 許可ルートとローカルセキュリティ

既定の許可ルートは `pnpm start` を実行したディレクトリです。複数指定する場合は、macOS / Linux では `:`、Windows では `;` で区切ります。

```sh
ARTIFACT_GALLERY_ALLOWED_ROOTS="/Users/me/artifacts:/Users/me/notes" pnpm start
```

- サーバーは `127.0.0.1` 固定です。listen host は環境変数で変更できません。
- 起動ごとに新しいセッショントークンを生成し、信頼済み HTML bootstrap から UI へ一度だけ渡します。URL、Web Storage、SQLite、通常ログには保存しません。
- API は正しい loopback `Host` とセッショントークンの両方を要求します。
- 未信頼 HTML は JavaScript、service worker、popup、redirect、外部通信、loopback 通信、`file:` 読み込みを既定拒否した Chromium context で描画します。
- 元ファイルは読み取り専用です。カタログから削除しても、元ファイルは削除されません。

## データの場所と設定

データはリポジトリ内に置かれません。既定値は次のとおりです。

| OS      | 状態ディレクトリ                                     |
| ------- | ---------------------------------------------------- |
| macOS   | `~/Library/Application Support/Artifact Gallery`     |
| Linux   | `${XDG_STATE_HOME:-~/.local/state}/artifact-gallery` |
| Windows | `%LOCALAPPDATA%\Artifact Gallery`                    |

状態ディレクトリには `catalog.sqlite`（カタログ、ジョブ、検索索引）と `thumbnails/`（再生成可能な派生 WebP）が入ります。SQLite が動作中は同じ場所に `catalog.sqlite-wal` と `catalog.sqlite-shm` が存在する場合があります。

| 環境変数                            | 用途                                                |
| ----------------------------------- | --------------------------------------------------- |
| `ARTIFACT_GALLERY_STATE_DIRECTORY`  | DB と派生データの親ディレクトリ                     |
| `ARTIFACT_GALLERY_DATABASE`         | SQLite ファイルだけを個別指定                       |
| `ARTIFACT_GALLERY_THUMBNAILS`       | 派生サムネイルだけを個別指定                        |
| `ARTIFACT_GALLERY_ALLOWED_ROOTS`    | 読み取りを許可する元ファイルのルート                |
| `ARTIFACT_GALLERY_CLIENT_DIRECTORY` | `pnpm start` が配信するビルド済み UI（既定 `dist`） |
| `PORT`                              | loopback ポート（既定 `3000`）                      |

## バックアップと復旧

整合したバックアップを取るには、まず `Ctrl-C` でアプリを正常終了し、状態ディレクトリ全体をコピーします。最小バックアップは `catalog.sqlite` ですが、`thumbnails/` も保存すれば復元後の再描画を減らせます。動作中の SQLite ファイルだけをコピーせず、必ず停止後にコピーしてください。

処理中に強制終了しても、次回起動時に未完了 run/item を `interrupted` へ調停し、不完全な一時派生ファイルを除去します。画面から再試行または再構築できます。派生データを失っても元ファイルから再構築でき、artifact ID、元パス、ユーザー指定タイトル、登録日時はカタログに保持されます。

## テストと性能検証

```sh
pnpm format:check       # Prettier 差分がないこと
pnpm lint
pnpm typecheck
pnpm test               # 全 Vitest（実 Chromium 隔離・検索評価・信頼性を含む）
pnpm test:e2e
pnpm build
pnpm smoke:prod
```

性能コーパスは実行ごとに同一内容の HTML 50件 + Markdown 50件（合計 50MB 以下）を一時領域へ生成します。初期一覧の5回は、それぞれ新規 state、production Node process、Chromium process、browser context を使い、navigation 開始から30カードが操作可能になるまでを測定します。固定10検索は各10回、debounce 後から render までのアプリ内値と、runner が入力前の `performance.now()` から render まで測る利用者体感値を別々に記録し、acceptance では両方に200msを適用します。サムネイルは別の新規派生ディレクトリと cache disabled の新規 context で cold を読み、その同じリソースを再読して warm を記録します。

結果は `test-results/performance/results.json` に token や resource URL を含めず保存します。CI はこの JSON を credential scanner に通し、bootstrap marker、token header、token候補を検出した場合は artifact upload を拒否します。E2E は line reporter のみで、HTML / trace / video / screenshot を artifact にしません。各中央値が目標を超えた場合、または最大値が目標の2倍を超えた場合は失敗します。

```sh
pnpm perf:smoke       # CI 向け: 初期一覧 5秒、検索 1秒の安定性閾値
pnpm perf:acceptance  # 基準 Apple Silicon: 初期一覧 1秒、検索 200ms
```

どちらも Task 9 の実 Chromium 負荷試験を続けて実行し、ブラウザー1個・context 最大2個、peak RSS、処理中キャンセル応答を再検証します。`perf:acceptance` は macOS / arm64、8コア以上、16GiB 以上でのみ受理されます。

## トラブルシューティング

- `browserType.launch` や Chromium executable のエラー: `pnpm exec playwright install chromium` を再実行します。Linux の共有ライブラリエラーは `pnpm exec playwright install --with-deps chromium` を使います。
- sandbox 内の `listen EPERM`: sandbox が loopback socket を禁止しています。信頼できるローカル端末で `pnpm dev`、`pnpm smoke:prod`、E2E を実行してください。
- macOS sandbox / Mach port で Chromium が起動しない: 同じテストを通常のローカル端末から実行し、Chromium の初回起動許可を確認します。
- `401 Unauthorized`: API を直接呼ばず、起動後の UI を再読み込みして新しい bootstrap token を取得します。以前の起動の token は再利用できません。
- `421 Untrusted Host`: `localhost` または `127.0.0.1` の表示 URL を使い、別ホスト名やリバースプロキシを介さないでください。
- 登録が拒否される: 入力が `ARTIFACT_GALLERY_ALLOWED_ROOTS` 配下の通常ファイルで、シンボリックリンクや隠し項目でないことを確認します。
- クラッシュ後に項目が `interrupted`: 詳細画面から「再試行」または「再構築」を選びます。

## 削除

アプリを停止してから行います。

- カタログデータだけを完全削除: 上表の状態ディレクトリ（または指定した DB / thumbnails）を削除します。次回起動時に空のカタログが作られます。
- アプリ自体をアンインストール: カタログデータを残すか削除するか決めた後、このリポジトリの checkout を削除します。グローバルインストールはありません。

どちらの操作でも、登録元の HTML / Markdown は削除されません。元ファイルを削除する操作は Artifact Gallery にありません。
