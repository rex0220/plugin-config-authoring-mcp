# plugin-config-authoring-mcp

rex0220 の kintone プラグイン（計算式エンジンを使うもの）の設定を、AI が作る・直す・検査するための MCP サーバーです。

- **コードは 1 つ、名前は製品ごと**。起動のときに `--plugin <名前>` で製品を 1 つ決め、その製品の名前でツールを出します。
- 今の対象は **アプリ集計**（`--plugin aggregate` → `agg_*`。Ver.67 以降）。
- **kintone には何も書きません。** 読むのは項目定義とアプリの名前だけ（GET）。書くのは作業フォルダーのファイルだけで、設定画面への読み込みと保存は利用者が行います。

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
| 環境変数 `PCA_KINTONE_PROFILE` | 使う profile を 1 つに固定する（省略すると、ツールの引数か `defaultProfile`）。固定すると、AI はほかの profile を選べない |

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

## 作り方と試験

```
npm install
npm run check
npm test        # ビルドしてから試験（アプリ集計の zip が隣の aggregate/dist にあるとき）
```

開発中は、中核を隣のリポジトリから読みます（`package.json` の `file:../formula-authoring/tools`。先にそちらで `npm run build`）。公開のときは、公開した中核の版に替えます。

## ライセンス

MIT。プラグインの zip の中身（計算式エンジン、設定画面と authoring API のコード）は、各プラグインの利用規約に従います。
