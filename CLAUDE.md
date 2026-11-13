# plugin-config-authoring-mcp — Claude Code 向けメモ

計算式エンジンを使う rex0220 のプラグイン（最初はアプリ集計）の設定のオーサリングの MCP。設計・経緯・進み具合は `../work-link/plugin-authoring-plan.md`、親フォルダーの決まりは `../CLAUDE.md`（コミット・push・公開の前に確認）。

## 作り

- **コードは 1 つ、名前は製品ごと**（`--plugin aggregate` → `agg_*`）。ツールを足すときは `src/server.ts` に 1 回書けば、全部の製品に出る。製品の名前を条件にした分岐は、最後に伝える文（`nextSteps`）と資料だけにする
- プラグインの決まり（何が誤りか・保存値の作り方）は**ここに書かない**。プラグインの zip の authoring API が持つ（設定画面と同じ関数）。ここが持つのは、ファイルの操作と、資料
- 中核は `@rex0220/formula-authoring-tools/generic`（`../formula-authoring/tools/src/generic/`）。zip の読み取り・Worker・設定ファイルの操作・項目定義の取得はそちら
- 製品を足すとき: ① プラグインの zip に authoring API を載せる（kit の契約）② 中核の表（`registry.ts`）に 1 行 ③ `guide/<製品>/` に資料（`howto.md`・`spec.md`）と `src/docs.ts` の `DOC_LIST` ④ `nextSteps` に製品の文 ⑤ `scripts/products.mjs` の `TEXTS` に検索の語、`scripts/plugin-zip-verify.mjs` の `TEST_ZIPS` に試験の zip

## 守ること

- kintone へは GET だけ。レコードは読まない。秘密の値・接続のファイルの場所と中身は返さない
- 作業フォルダーの直下の `*.json` だけを読み書きする。設定ファイルは下書きとして検査なしでも保存できるが、取り込み用のファイルは検査を通ったものからだけ作る
- 標準出力は JSON-RPC だけ（Worker の出力は捨てる）
- 資料（`guide/`）は、プラグインの「設定の説明」（`help.ts`）と authoring API のコードを読んで書く。**設定画面で選べる値の範囲は、dialog のコードで確かめる**（実データに無い値を見落とす。OR 条件の位置を 2 値に丸めていた例）
- 試験で起動したサーバーは必ず閉じる（閉じないと試験が終わらない）

## 配布の形（Claude Code のプラグイン）

- 配るのは**製品ごとのプラグイン**（アプリ集計は `aggregate`）。`.claude-plugin/plugin.json` と `.mcp.json` はリポジトリに置かず、`scripts/products.mjs` が製品ごとに作る（名前・ツールの頭・zip の環境変数・扱う版は中核の表から取る。ここに書くのは利用者に見せる文だけ）
- `npm run verify:plugin` = ビルド → `dist-plugin/<製品>-authoring-plugin-<版>.zip` と展開した形 `dist-plugin/<製品>/` → 検査。`dist-plugin/` はコミットしない
- フック（`hooks/register.ts`）は製品に依らず 1 つ。作業フォルダーの直下の `*.json` を**中身**（`kind`・`pluginID`）と名前（`-import.json`）で見分けて、直接の Write / Edit を止める。**fail-closed** なので、直したら `claude plugin test .`（8 件）を流す。設定ファイルの印は中核の `SOURCE_FILE_KIND` と同じ（`test/release.test.mjs` が見る）
- パスを解決する助けの関数・`scripts/zip.mjs`・`forbidden-files.mjs`・`third-party-notices.mjs` は formula MCP → kSQL アクションのオーサリングからの写し（正本は formula MCP）
- 依存を変えたら `npm run notices`（`THIRD_PARTY_NOTICES.md` を作り直す。合っていないとビルドが止まる）
- 公開の前に `node scripts/forbidden-files.mjs --history`（履歴に本物の環境のホスト名・実案件の設定が無いこと）

## ビルドと試験

- 中核を直したら、先に `../formula-authoring/tools` で `npm run build`（`dist/generic.mjs` と `dist/generic-worker.mjs` を束ねている）
- `npm run check`（本体とフックの型）→ `npm test`（ビルドしてから試験）→ `claude plugin test .`（フック）。試験の材料は隣の `aggregate/dist/aggregate-plugin67.zip`
