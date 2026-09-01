# Status

承認済みワイヤーフレームに沿うギャラリー UI と回復操作を実装した。認証サムネイルは viewport 近傍まで request を遅延し、条件変更時の追加読み込みは AbortController と context generation で stale response/cursor を破棄する。API の catalog/filtered/format 集計により初回空状態と検索・絞り込み0件を区別し、削除確認は独立した alertdialog として背景を inert にして focus を閉じ込める。キャンセル結果は完了分・未開始分を明示し、完了カードを保持する。

# Commit

`fix: harden gallery async and modal flows`

# Tests

- `npm run lint`
- `npm run typecheck`
- `npm test` — 182 passed
- `npm run build`
- `npm run test:e2e` — 19 passed（実 Fastify、SQLite、ローカルファイル、Chromium）

# Concerns

なし。
