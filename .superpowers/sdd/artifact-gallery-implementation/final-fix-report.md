# Artifact Gallery final fix report

- 実施日: 2026-09-01
- Review base: `230b8bc`
- 統合修正 commit: `173519a` (`fix: close artifact gallery final review findings`)
- Findings source: `final-review-findings.md` のみ
- 結果: Critical 1件、Important 9件、Minor 1件の全11件を解消

## Findings mapping

### Critical 1: `pnpm dev` のUI起動失敗

- Vite `/api` proxyへ `changeOrigin: true` を設定し、5173を `strictPort` で固定した。
- Viteが挿入するscript/styleへ単一nonceを付け、API由来CSPの `script-src` / `style-src` に同じnonceを追加した。
- `scripts/development-smoke.ts` と `pnpm smoke:dev` を追加し、実際の `pnpm dev`、Vite 5173、API 3000、bootstrap token、認証済みhealth、React mount、初期galleryをChromiumで検証した。
- REDではscript修正後にstyle CSP違反を実ブラウザーが検出し、style nonce追加後にGREENとなった。

### Important 1: cancel/deadline後の空generation・artifact残存

- inspect/extract/render/index/commitのcancel・timeoutで未commit generationを削除し、新規かつactive generationがないartifactはimport itemとの関連を安全に外して削除するよう統一した。
- prepared index、temporary/final derivative、generation counter、card可視性をrollbackし、terminal item/run errorだけを保持する。
- 全stageのDB/generation/file/card状態、rename後cancel、同期commit超過、commit reserve、post-transaction deadlineをfocused testでRED→GREEN化した。

### Important 2: refresh index failureによる前世代破壊

- index stage errorをpartial commitせず、失敗generation全体をrollbackする。
- 以前のactive generation、derived title、thumbnail、search visibilityを維持する。
- 成功して修復済みのstage errorだけを消し、今回のindex errorはgenerationからdetachして保持する。
- index prepare/commit failure、rollback/quarantine failure、commit deadline snapshot restoreをfocused testで検証した。

### Important 3: selected capability境界と永続化

- `allowed_root.kind` (`file` / `folder`) と `artifact_allowed_root` を追加し、選択時にcanonical capabilityを永続化・artifactへ連結する。
- file capabilityは選択ファイルだけ、folder capabilityは配下だけを許可し、HTML renderにはartifact固有policyを渡す。
- runtimeの暗黙cwd許可を廃止し、保存済みcapabilityを復元して選択rootを動的追加する。
- 旧catalog artifactはmigration 005でleast-privilegeなexact-file capabilityへbackfillする。
- source消失後も保存済みcapabilityを再canonicalizeせず復元し、inspectのdurable `SOURCE_MISSING` としてterminal化する。

### Important 4: derivative mutationのpolicy迂回

- canonical derivative root直下だけを対象とする `DerivativePathPolicy` を追加した。
- writeは `O_EXCL` / `O_NOFOLLOW` とFD identity再検証、rename/removeは即時canonical containment・symlink・file種別検査を行う。
- processorのwrite/rename/removeとcatalog deleteを同policyへ集約した。
- 外側path、final symlink、directory symlinkを拒否し、source/outside derivativeが残ることをtestで確認した。

### Important 5: folder traversalの不要errorと無制限列挙

- hidden entryとunsupported CSS/image/font等は通常skipする。
- symlink/unreadableはitem errorとして維持する。
- traversal中にcount上限、deadline、AbortSignal、durable cancellationを各entry/再帰境界で確認し、上限到達時点で停止する。
- APIではlimit/deadline/cancelを安全なterminal run状態へ変換する。

### Important 6: search契約

- 3文字以上はFTS、1–2文字はbounded fallbackとしてtermごとに処理し、mixed queryをAND semanticsで照合する。
- `format_normalized` をdocument/FTSへ追加し、format matchを可能にした。
- repository/APIの200件上限を撤廃し、relevance順を維持する専用cursorを追加した。
- visibility gateを維持し、各cardへ `match.reason` (`title` / `body` / `path` / `format`) とbounded snippetを返す。
- 205件のAPI pagination、500 stale generation、short scan bound、fixed search qualityを検証した。

### Important 7: platform・missing・terminal error表示

- macOSは `/usr/bin/open` / `open -R`、Linuxは `/usr/bin/xdg-open` をshellなし・固定timeout・validated absolute pathで実行するadapterを追加した。
- command失敗はlocal detailをredactした `PLATFORM_ACTION_FAILED` として返す。
- startupは最大256件・8並列・250ms/件、detail表示は対象artifactを250msでsource再確認し、missingおよび全inspect errorを安全に永続化する。
- refresh/retry/rebuildのterminal item errorをUI alertへ表示する。
- E2Eではcanonical source pathがopen/reveal adapterへ渡り、navigationやerror漏洩がないことを確認した。

### Important 8: permanent orphan thumbnailの回収

- startup reconciliationでactive generationから参照されない `artifact-<id>-generation-<n>.webp` をderivative policy経由で削除する。
- nested、symlink、unrelated、active derivativeは保持する。
- rename-before-DBとDB-before-old-cleanupの両窓で実childをSIGKILLし、再起動後のrun状態・active file保持・orphan除去を検証した。

### Important 9: title上限

- HTML title、Markdown H1、processor user title、API title、client編集を共通 `normalizeArtifactTitle` に統一した。
- 256 Unicode code points以内かつgraphemeを分断しないprefixへclampしてからDB/index/APIへ渡す。
- emojiと複合family graphemeを使い、derived titleとAPI user titleのDB/index/responseを検証した。

### Minor 1: README形式とfolder説明

- `.markdown` を対応形式から削除し、`.html` / `.htm` / `.md` に一致させた。
- hidden/unsupportedのskip、symlink/unreadable error、dynamic capability、既定事前許可rootなしを実装に合わせて記載した。

## Migration and source-safety audit

- 既存migration `001_initial.sql`〜`004_search.sql` は変更していない。
- 新規 `005_capabilities.sql` はcapability schemaと旧artifact exact-file backfillを追加した。
- 新規 `006_search_contract.sql` はformat列と7-column trigram FTSを追加し、既存search documentを再投入する。
- production codeのfilesystem削除は `DerivativePathPolicy.remove()` のcanonical derivative root直下に限定した。
- catalog delete、rollback、startup recoveryのいずれもsource fileを削除しない。outside/symlink pathは拒否または保持する。
- staged diffに削除ファイルはなく、`git diff --check` はcleanだった。

## TDD and verification evidence

Focused RED→GREENでは、dev CSP、各stage rollback、refresh index rollback、capability scope/persistence/missing restore、derivative mutation、folder bounds、search pagination/relevance、platform/source status、2つのcrash window、title clamp、legacy migration backfillを個別に再現してから修正した。

最終検証:

- `pnpm format:check`: PASS
- `pnpm lint`: PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS（Vite 19 modules + server TypeScript emit）
- `pnpm test`: PASS（39 files、282 tests）
- `pnpm test:e2e`: PASS（19 tests）
- `pnpm smoke:prod`: PASS（server-ready、health-ok、gallery items=0、shutdown-ok）
- `pnpm smoke:dev`: PASS（`bootstrap-mounted-authenticated`）
- `pnpm perf:smoke`: PASS
  - first page median `80.31ms`、max `82.44ms`
  - search accepted worst median `11.85ms`、max `14.10ms`
  - user-observed search worst median `125.40ms`、max `140.51ms`
  - thumbnail cold `41.00ms`、warm `33.10ms`
  - Chromium peak RSS `315.4MiB`、context peak 2、cancel latency `63.0ms`、commit critical max `1.19ms`
- `pnpm artifacts:check`: PASS
- 001–004 migration diff audit: PASS（差分なし）
- source deletion audit: PASS

## Residual concern

- 検証hostはNode.js `v24.14.0` で、repository pinは `24.20.0`。全ゲートは通過したが、release/CIではpinどおり `24.20.0` で再実行する。
