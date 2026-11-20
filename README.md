# plugin-config-authoring-mcp

rex0220 の kintone プラグイン（計算式エンジンを使うもの）の設定を、AI が作る・直す・検査するための MCP サーバーです。

- **コードは 1 つ、名前は製品ごと**。起動のときに `--plugin <名前>` で製品を 1 つ決め、その製品の名前でツールを出します。
- 今の対象は **アプリ集計**（`--plugin aggregate` → `agg_*`。Ver.67 以降）と **項目書式**（`--plugin field-format` → `ffmt_*`。Ver.16 以降）。
- **kintone には何も書きません。** 読むのは項目定義とアプリの名前（GET）。項目書式の `ffmt_try`（レコードを当てて確かめる）だけは、指定されたレコードも読みます（GET。読んだレコードそのものは返しません）。書くのは作業フォルダーのファイルだけで、設定画面への読み込みと保存は利用者が行います。

設計と経緯は、非公開の作業記録（kintone-plugin の `work-link/plugin-authoring-plan.md`）にあります。

## しくみ

| 層 | 置き場 | 役目 |
|---|---|---|
| 口の形（契約） | `plugin-config-kit` の `src/authoring.ts` | プラグインが zip に載せる authoring API の形 |
| プラグインの決まり | プラグインの zip（アプリ集計は `config_js/aggregate-authoring-api.js`） | 設定ファイル（元の値）から保存値を組み立てる。決まりは設定画面と同じ関数 |
| 中核 | `@rex0220/formula-authoring-tools` の `./generic` | zip の読み取り（プラグイン ID と署名の検証）、Worker での実行、設定ファイルの操作、kintone の項目定義の取得 |
| MCP | このリポジトリ | ツールと資料 |

プラグインの zip のコード（計算式エンジンと authoring API）は、このリポジトリにも配布物にも入れません。利用者の zip から、実行のたびに読みます。

## 起動の設定（AI の引数では変えられない）

| 設定 | 意味 |
|---|---|
| `--plugin aggregate` | 扱うプラグイン |
| 環境変数 `AGGREGATE_PLUGIN_ZIP` | アプリ集計プラグインの zip（アプリに入れたものと同じ版） |
| 環境変数 `PCA_WORKSPACE` | 作業フォルダー（省略時は起動したフォルダー）。読み書きするのは、この直下の `*.json` だけ |
| 環境変数 `PCA_KINTONE_CONFIG` | kintone の接続のファイル（kSQL の `ksql.config.json` と同じ形）。**作業フォルダーの外**に置く。API トークンは閲覧だけでよい |
| 環境変数 `PCA_KINTONE_PROFILE` | 使う profile を 1 つに固定する（省略すると、ツールの引数か `defaultProfile`）。固定すると、AI はほかの profile を選べない。**接続のファイルに本番の profile があるなら固定する**（固定していないことは `<頭>_status` の `profileSelection: "tool-selectable"` で分かり、手順の資料は「読む前に利用者に確かめる」としている） |

## ツール（アプリ集計）

| ツール | 内容 | 触る場所 |
|---|---|---|
| `agg_status` | MCP の版、zip（版・署名）、kintone の接続の診断 | なし |
| `agg_docs` | 資料（`howto` = 作業手順、`spec` = 設定ファイルの書き方） | なし |
| `agg_files` | 作業フォルダーの JSON の一覧 | なし |
| `agg_fields` | アプリの項目定義（項目コード・タイプ・テーブル・参照先） | kintone（GET） |
| `agg_new` | 設定ファイルを新しく作る（空、または設定画面でダウンロードしたファイルから。上書きしない） | 作業フォルダー |
| `agg_read` | 設定ファイルを読む（要約・行・行の外の設定・行の雛形） | なし |
| `agg_update` | 設定ファイルを直す（digest を照合） | 作業フォルダー |
| `agg_diff` | 2 つの設定ファイルの差分 | なし |
| `agg_check` | kintone の今の項目定義で検査する | kintone（GET） |
| `agg_export` | 検査を通った設定から、設定画面の「設定をアップロード」で読むファイルを作る（上書きしない） | kintone（GET）＋ 作業フォルダー |

項目書式は同じ 10 個が `ffmt_*` の名前で出て、もう 1 つあります。

| ツール | 内容 | 触る場所 |
|---|---|---|
| `ffmt_try` | 設定ファイルにレコードを当てて、どの条件が選ばれるかを確かめる（レコード番号・条件・自分で書いたレコードのどれか。1 回に 20 件まで）。返すのは選ばれた条件の番号と、条件ごとの評価（真の数・例外・式の結果の例） | kintone（GET。項目定義と、指定されたレコード） |

- 項目書式の取り込み用のファイルは「共通の設定 + 項目の設定」だけです（テーブルの書式に使う kintone の内部番号は設定画面の中からしか取れないので、設定画面が取り込んで保存するときに作ります）。
- `ffmt_try` を使うには、API トークンにレコードの閲覧の権限が要ります（`records` に自分で書いたレコードを渡すだけなら要りません）。

## 互換表（製品別）

| 製品（Claude Code のプラグイン） | ツール | kintone のプラグインの版 | 契約の版 | この MCP |
|---|---|---|---|---|
| アプリ集計（`aggregate`） | `agg_*` | Ver.67 以降 | 1 | 0.1.0〜 |
| 項目書式（`field-format`） | `ffmt_*` | Ver.16 以降 | 1 | 0.1.0〜 |

- 条件は中核の表（`@rex0220/formula-authoring-tools/generic` の `GENERIC_PLUGINS`）が持ち、起動のたびに zip を確かめます（版が古い = `unsupported-version`、authoring API が無い = `no-api`、契約の版が合わない = `api-unsupported`、署名が合わない = `bad-signature`）。結果は `<頭>_status` に出ます
- 「契約の版」は、プラグインの zip の authoring API の形の版（plugin-config-kit の `AUTHORING_CONTRACT_VERSION`）。プラグインの版が上がっても、契約の版が同じなら MCP はそのまま使えます
- 設定の検査と保存する値の組み立ては zip の中のコードが行うので、**アプリに入れたものと同じ版の zip** を指してください

## Claude Code のプラグインとして配る形（製品ごと）

コードは 1 つですが、配るものは**製品ごとのプラグイン**です（アプリ集計は `aggregate`。ツールは `agg_*`）。プラグインの定義（`.claude-plugin/plugin.json`）と起動の設定（`.mcp.json`）はリポジトリに置かず、`scripts/products.mjs` の表から製品ごとに作ります。

| 入るもの | 中身 |
|---|---|
| `.claude-plugin/plugin.json` | 製品の名前と、利用者の設定 4 つ（プラグインの zip、接続のファイル、使う profile、作業フォルダー。どれも秘密の値ではない） |
| `.mcp.json` | `node ${CLAUDE_PLUGIN_ROOT}/dist/server/index.cjs --plugin <製品>`。設定は環境変数で渡す |
| `hooks/` | 設定ファイルへの直接の書き込みを止めるフック（下） |
| `dist/server/`・`dist/vendor/` | 本体（束ねてある）と moment |
| `LICENSE`・`THIRD_PARTY_NOTICES.md`・`README.md` | ライセンスと、同梱の依存の著作権表示 |

### フック（`hooks/register.ts`）

AI が Write / Edit で作業フォルダーのファイルを直接書き換えると、digest の照合・上書きしない決まり・「取り込み用のファイルは検査を通ったものからだけ」が抜けます。フックはそれを止めます。

- 見るのは、セッションのフォルダーの**直下の `*.json`** だけ。**今の中身と、書いた後の中身**で見分ける（作業フォルダーは直下に JSON を置く形なので、名前では守れない）
  - 設定ファイル（いちばん上の `kind` が `rex0220-authoring-source`）→ 拒否（`*_new` / `*_update` で）
  - 取り込み用のファイル（名前が `-import.json` で終わる）と、設定画面のダウンロード（いちばん上の `pluginID` が `rex0220 …`）→ 拒否
  - `package.json` など関係のない JSON（値の中に同じ文字があるだけのものも）、直下でない所、セッションのフォルダーの外 → 止めない
- 見分けるのは **JSON として読んだ値**（ツールがファイルを見分けるのと同じ見方）。文字の並びでは見ないので、`\u0065` のような書き方ではすり抜けない。JSON として読めない書きかけの中身だけ、文字の並びで安全側に見る
- Edit は、今の中身に置き換えを当てた**編集の後の全文**で見る（印を 2 回の編集に分けて作っても、出来上がる編集で止まる）
- 確かめられないとき（セッションのフォルダーを解決できない、一覧が取れない、今の中身を読めない、Edit の置き換えを再現できない）は拒否する（fail-closed）
- 作業フォルダーを設定で別の所にしたときは届かない（守るのはセッションのフォルダー）

### 作る・確かめる

```sh
npm run verify:plugin        # ビルド → 製品ごとの zip（dist-plugin/<製品>-authoring-plugin-<版>.zip）→ 検査（展開して起動、claude があれば plugin validate）
claude plugin test .         # フックの試験（hooks/register.test.ts）
claude --plugin-dir dist-plugin/aggregate   # 展開した形を、手元の Claude Code で試す
```

フックの型を見るには `.claude-plugin/types/`（`claude-code` の型。git に入れない。kSQL アクションのオーサリングの同じフォルダーから写せる）が要ります。marketplace と Claude Desktop（.mcpb）はまだありません。

## 作り方と試験

```
npm install
npm run check
npm test        # ビルドしてから試験（アプリ集計の zip が隣の aggregate/dist にあるとき）
```

開発中は、中核を隣のリポジトリから読みます（`package.json` の `file:../formula-authoring/tools`。先にそちらで `npm run build`）。公開のときは、公開した中核の版に替えます。

## ライセンス

MIT。プラグインの zip の中身（計算式エンジン、設定画面と authoring API のコード）は、各プラグインの利用規約に従います。
