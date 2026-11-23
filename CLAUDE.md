# plugin-config-authoring-mcp — Claude Code 向けメモ

計算式エンジンを使う rex0220 のプラグイン（最初はアプリ集計）の設定のオーサリングの MCP。設計・経緯・進み具合は `../work-link/plugin-authoring-plan.md`、親フォルダーの決まりは `../CLAUDE.md`（コミット・push・公開の前に確認）。

## 作り

- **コードは 1 つ、名前は製品ごと**（`--plugin aggregate` → `agg_*`）。ツールを足すときは `src/server.ts` に 1 回書けば、全部の製品に出る。製品の名前を条件にした分岐は、最後に伝える文（`nextSteps`）と資料だけにする。**`<頭>_try` の入力と説明は製品ごとの定義**（`src/try-defs.ts`。2026-11-23 Takashi。模擬の入力と答えは契約の版 1 では自由な JSON なので、AI に見せる形と上限をここに書く。レコードの渡し方・検査を先に通す・結果の上限・読んだレコードを返さない、は `server.ts` の共通の所）
- プラグインの決まり（何が誤りか・保存値の作り方）は**ここに書かない**。プラグインの zip の authoring API が持つ（設定画面と同じ関数）。ここが持つのは、ファイルの操作と、資料
- 中核は `@rex0220/formula-authoring-tools/generic`（`../formula-authoring/tools/src/generic/`）。zip の読み取り・Worker・設定ファイルの操作・項目定義の取得はそちら
- 製品を足すとき: ① プラグインの zip に authoring API を載せる（kit の契約）② 中核の表（`registry.ts`）に 1 行 ③ `guide/<製品>/` に資料（`howto.md`・`spec.md`）と `src/docs.ts` の `DOC_LIST` ④ `nextSteps` に製品の文（取り込み方が「全部入れ替え」でない製品は、設定画面の言葉で書き分ける。項目書式は 全置換 / 項目の置換 と「共通の設定」の群）⑤ `scripts/products.mjs` の `TEXTS` に検索の語、`scripts/plugin-zip-verify.mjs` と `mcpb-verify.mjs` の `TEST_ZIPS` に試験の zip ⑥ 模擬のある製品は `src/try-defs.ts` に 1 つ（無いと起動で止まる）⑦ README の互換表。配布するとき（`released: true`）は、アイコンと、README・PRIVACY.md・SECURITY.md の「何を読むか」の文も

## 守ること

- **プロセス管理の設定を読むのは、中核の表に `status` の印のある製品（確認ダイアログ）だけ**（動作テスト環境の GET。`<頭>_fields` の `preview: true`・検査・模擬）。印の無い製品では読まない（`test/confirm-dialog.test.mjs` が、項目書式の検査で読まないことを見る）
- kintone へは GET だけ。レコードを読むのは、模擬のある製品（中核の表の `simulate`。項目書式と確認ダイアログ）の `<頭>_try` だけ（2026-11-20。番号か条件で指定されたものを 20 件まで）。**読んだレコードそのものは返さない**（プラグインの API に渡し、返すのは選ばれた条件の番号と、式の結果の例）。秘密の値・接続のファイルの場所と中身は返さない
- **設定ファイルを読む・直す入口には、起動した製品の名前を渡す**（`G.readSourceFile(workspace, file, plugin.name)`・`G.updateSourceFile(…, plugin.name)`）。設定ファイルの形はどの製品も `{ common, rows }` なので、渡さないと別の製品のファイルを読めてしまい、空の設定の取り込み用のファイルを作れる（2026-11-20 Codex BLOCKER。`test/field-format.test.mjs` が両方向を見る）
- `<頭>_try` の結果は 60,000 字まで（`TRY_MAX_CHARS`）。超えたら `too-large` で、絞り方を返す。設定に error があるときは、中核が検査を先に通すので、レコードを読まない
- **アプリの今の設定を読む（`<頭>_pull`。0.2.0）**: kintone の API ラボの GET（中核の `fetchStoredConfig`）。保存値をほどくのは中核、**読み方（スキーマ・元の値への変換）は zip の `toSource`**。ほどいた保存値そのもの（更新者の名前・最終更新が入っている）は返さない・置かない。API を呼べないときは `hint` で「設定をダウンロード」を案内する（API ラボは共通管理者が有効にした環境だけ）。プラグインの設定を**変更する** API は呼ばない
- 作業フォルダーの直下の `*.json` だけを読み書きする。設定ファイルは下書きとして検査なしでも保存できるが、取り込み用のファイルは検査を通ったものからだけ作る
- 標準出力は JSON-RPC だけ（Worker の出力は捨てる）
- 資料（`guide/`）は、プラグインの「設定の説明」（`help.ts`）と authoring API のコードを読んで書く。**設定画面で選べる値の範囲は、dialog のコードで確かめる**（実データに無い値を見落とす。OR 条件の位置を 2 値に丸めていた例）。**取り込みの画面の既定（チェックの初期値）も、dialog のコードか実機で確かめる**（項目書式の「共通の設定」は最初から全部チェック。「チェックを入れた群だけ」と書いて、利用者に誤った手順を伝えていた。2026-11-20）。式の例は、プラグインの zip のエンジンで 1 つずつ評価してから書く
- 試験で起動したサーバーは必ず閉じる（閉じないと試験が終わらない）
- 取り込み用のファイルは `saveNewImportFileFor` で置く（設定ファイルのロックの中で digest を確かめ直す。検査は kintone の読み取りを挟むので、その間に直されていたら作らない）
- 式の評価に渡す文脈は自アプリの番号だけ。利用者・組織・グループの情報は渡さない（検査は式の形と使う項目だけで、値は使わない）。模擬（`<頭>_try`）もログインユーザーは中核の既定の利用者のまま（資料と結果の注記に書いてある。ログインユーザーに依る条件は画面で確かめてもらう）
- 項目書式の取り込み用のファイルは保存値そのものではない（共通の設定 + `pluginInfos`。内部番号は設定画面が保存のときに作る）。**取り込み用のファイルを kintone の設定に直接書く道具を足さない**

## 配布の形（Claude Code のプラグインと Claude Desktop の .mcpb）

- **配布する製品は `scripts/products.mjs` の `released`**（2026-11-22 Takashi「項目書式だけ」。アプリ集計は Ver.67 のリリースのときに true にする）。marketplace・リリース・記事に出すのは released の製品だけ。false の製品も、ビルド・試験・zip の検査は通す
- marketplace の名前は `rex0220-plugin-authoring`（同日。公開の後は変えない）
- **Claude Desktop の .mcpb は `scripts/build-mcpb.mjs`**（製品ごと。アイコンは `assets/icon-<製品>.png` = 白地に 1 文字、512×512。項目書式は「書」）。検査は `npm run verify:mcpb`（manifest のツールの並びが本体の tools/list と同じ、任意の設定を入れない形でも起動する）。Desktop にフックは無い
- 利用者に見せる文で「レコードは読まない」と書くのは、模擬の無い製品だけ（`readsNote`。項目書式は `ffmt_try` が読む）。PRIVACY.md・SECURITY.md も同じ

- 配るのは**製品ごとのプラグイン**（アプリ集計は `aggregate`）。`.claude-plugin/plugin.json` と `.mcp.json` はリポジトリに置かず、`scripts/products.mjs` が製品ごとに作る（名前・ツールの頭・zip の環境変数・扱う版は中核の表から取る。ここに書くのは利用者に見せる文だけ）
- `npm run verify:plugin` = ビルド → `dist-plugin/<製品>-authoring-plugin-<版>.zip` と展開した形 `dist-plugin/<製品>/` → 検査。`dist-plugin/` はコミットしない
- フック（`hooks/register.ts`）は製品に依らず 1 つ。作業フォルダーの直下の `*.json` を**中身**（`kind`・`pluginID`）と名前（`-import.json`）で見分けて、直接の Write / Edit を止める。見分けるのは JSON として読んだいちばん上の値（文字の並びではない）、Edit は編集の後の全文。**fail-closed** なので、直したら `claude plugin test .`（11 件）を流す。設定ファイルの印は中核の `SOURCE_FILE_KIND` と同じ（`test/release.test.mjs` が見る）
- パスを解決する助けの関数・`scripts/zip.mjs`・`forbidden-files.mjs`・`third-party-notices.mjs` は formula MCP → kSQL アクションのオーサリングからの写し（正本は formula MCP）
- 依存を変えたら `npm run notices`（`THIRD_PARTY_NOTICES.md` を作り直す。合っていないとビルドが止まる）
- 公開の前に `node scripts/forbidden-files.mjs --history`（履歴に本物の環境のホスト名・実案件の設定が無いこと）

## ビルドと試験

- 中核は npm の公開版に固定（2026-11-22 から。0.1.0 は `0.7.0`、0.2.0 は `0.8.0`、確認ダイアログを足した版〈0.3.0 の予定。未公開〉は `0.9.0`。それまでは `file:../formula-authoring/tools`）。**まだ公開していない中核で試すときは、隣でビルドして `npm install --no-save ../formula-authoring/tools`**（`package.json` と lockfile は変えない。公開したら版を上げて `npm install --save-dev --save-exact`、`npm run notices`）
- `npm run check`（本体とフックの型）→ `npm test`（ビルドしてから試験）→ `claude plugin test .`（フック）。試験の材料は隣の `aggregate/dist/aggregate-plugin67.zip`
