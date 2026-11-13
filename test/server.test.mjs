/**
 * MCP サーバー（--plugin aggregate → agg_*）。材料はアプリ集計プラグインの zip（隣の aggregate/dist/aggregate-plugin67.zip。無ければ飛ばす）。
 *   1. ソースのサーバーを同じプロセスでつなぎ、kintone は代役（GET の応答）で、新しく作る → 直す → 検査 → 取り込み用のファイルまで通す
 *   2. ビルドした本体（dist/server/index.cjs）を起動して、状態・資料・ファイルの操作が通る
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZIP = path.resolve(HERE, "../../aggregate/dist/aggregate-plugin67.zip");
const skip = existsSync(ZIP) ? false : `アプリ集計の zip が無い: ${ZIP}`;

const OWN = {
  得意先LU: { type: "SINGLE_LINE_TEXT", code: "得意先LU", label: "得意先（ルックアップ）", lookup: { relatedApp: { app: "200" }, relatedKeyField: "顧客" } },
  得意先CD: { type: "SINGLE_LINE_TEXT", code: "得意先CD", label: "得意先コード" },
  合計: { type: "NUMBER", code: "合計", label: "受注金額の合計" },
  基準日: { type: "DATE", code: "基準日", label: "集計の基準日" },
  明細: { type: "SUBTABLE", code: "明細", label: "受注の明細", fields: { 品名: { type: "SINGLE_LINE_TEXT", code: "品名", label: "商品名" } } }
};
const TARGET = { 顧客: { type: "SINGLE_LINE_TEXT", code: "顧客", label: "得意先コード" }, 金額: { type: "NUMBER", code: "金額", label: "受注金額" }, 受注日: { type: "DATE", code: "受注日", label: "受注日" } };

/** kintone の代役: GET の URL から応答を決める。呼ばれた URL と認証ヘッダーの名前を控える */
function fakeKintone() {
  const calls = [];
  const body = (obj) => { const bytes = new TextEncoder().encode(JSON.stringify(obj)); let done = false; return { getReader: () => ({ read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })), cancel: async () => {} }) }; };
  const fetch = async (url, init) => {
    const u = new URL(url);
    const api = u.pathname.replace(/^\/k\/v1\//, "").replace(/\.json$/, "");
    const app = u.searchParams.get("app") ?? u.searchParams.get("id");
    calls.push({ method: init.method, api, app, auth: Object.keys(init.headers).filter((h) => /token|authorization/i.test(h)) });
    const table = {
      "app:100": { appId: "100", name: "集計先" }, "app:200": { appId: "200", name: "受注" },
      "preview/app/form/fields:100": { properties: OWN, revision: "1" }, "preview/app/form/layout:100": { layout: [], revision: "1" }, "preview/app/views:100": { views: {} },
      "app/form/fields:100": { properties: OWN, revision: "1" },
      "app/form/fields:200": { properties: TARGET, revision: "1" }, "app/form/layout:200": { layout: [], revision: "1" }, "app/views:200": { views: {} }
    };
    const hit = table[`${api}:${app}`];
    return hit ? { ok: true, status: 200, body: body(hit) } : { ok: false, status: 403, body: body({ code: "GAIA_NO01", message: "no privilege" }) };
  };
  return { fetch, calls };
}

async function connect(env, extra = {}) {
  const server = createServer({ plugin: "aggregate", env, cwd: env.PCA_WORKSPACE, ...extra });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  };
  return { client, call, close: () => client.close() };
}
function makeDirs() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pca-mcp-")));
  const ws = path.join(base, "ws");
  mkdirSync(ws);
  const conn = path.join(base, "connections.json");
  writeFileSync(conn, JSON.stringify({ defaultProfile: "dev", profiles: { dev: { baseUrl: "https://dev-x.cybozu.com", tokenMap: { APP100: "token-100", APP200: "token-200" } } } }), { mode: 0o600 });
  return { base, ws, conn, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("ツールの名前は製品の頭（agg_）で出る。指示に製品の名前が入る", { skip }, async () => {
  const d = makeDirs();
  try {
    const { client, close } = await connect({ PCA_WORKSPACE: d.ws, AGGREGATE_PLUGIN_ZIP: ZIP });
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["agg_check", "agg_diff", "agg_docs", "agg_export", "agg_fields", "agg_files", "agg_new", "agg_read", "agg_status", "agg_update"]);
    assert.match(client.getInstructions() ?? "", /アプリ集計/);
    assert.equal(client.getServerVersion().name, "aggregate");
    await close();
  } finally { d.cleanup(); }
});

test("状態: zip（版・署名）と接続（profile。秘密の値と場所は返さない）。未設定は理由と環境変数の名前", { skip }, async () => {
  const d = makeDirs();
  try {
    const ok = await connect({ PCA_WORKSPACE: d.ws, AGGREGATE_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn });
    const s = await ok.call("agg_status");
    assert.deepEqual([s.status, s.plugin, s.zip.status, s.zip.signed, s.zip.contractVersion, s.kintone.status, s.kintone.file, s.kintone.defaultProfile], ["ok", "aggregate", "ok", true, 1, "ok", "connections.json", "dev"]);
    assert.deepEqual(s.kintone.profiles[0].tokenApps, [100, 200]);
    const text = JSON.stringify(s);
    assert.ok(!text.includes("token-100") && !text.includes(d.conn), "トークンと接続のファイルの場所を返さない");
    await ok.close();
    const ng = await connect({ PCA_WORKSPACE: d.ws });
    const n = await ng.call("agg_status");
    assert.deepEqual([n.status, n.zip.status, n.zip.env, n.kintone.status, n.kintone.env], ["problem", "not-configured", "AGGREGATE_PLUGIN_ZIP", "not-configured", "PCA_KINTONE_CONFIG"]);
    await ng.close();
  } finally { d.cleanup(); }
});

test("資料: 目次と本文（作業手順・設定ファイルの書き方）", { skip }, async () => {
  const d = makeDirs();
  try {
    const { call, close } = await connect({ PCA_WORKSPACE: d.ws, AGGREGATE_PLUGIN_ZIP: ZIP });
    assert.match(await call("agg_docs"), /- howto: .*\n- spec: /);
    assert.match(await call("agg_docs", { section: "spec" }), /式を書く場所と、使える項目/);
    assert.match(await call("agg_docs", { section: "howto" }), /最後に必ず伝えること/);
    assert.equal((await call("agg_docs", { section: "none" })).status, "invalid");
    await close();
  } finally { d.cleanup(); }
});

test("新しく作る → 行を足す → 検査 → 直す → 取り込み用のファイル（kintone へは GET だけ）", { skip }, async () => {
  const d = makeDirs();
  const k = fakeKintone();
  try {
    const { call, close } = await connect({ PCA_WORKSPACE: d.ws, AGGREGATE_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    // 項目を確かめる
    const f = await call("agg_fields", { app: 100, preview: true });
    assert.deepEqual([f.status, f.appName, f.fields.find((x) => x.code === "得意先LU").lookupApp, f.fields.find((x) => x.code === "品名").table], ["ok", "集計先", "200", "明細"]);
    // 設定ファイルを作る
    const made = await call("agg_new", { file: "agg-app100.json", app: 100, appName: "集計先" });
    assert.deepEqual([made.status, made.rows], ["saved", 0]);
    assert.equal((await call("agg_new", { file: "agg-app100.json", app: 100 })).status, "exists", "上書きしない");
    // 行の雛形を取り、中身を入れて足す（わざと、集計項目に自アプリの項目を # なしで書く）
    const tpl = (await call("agg_read", { file: "agg-app100.json", key: "new" })).row;
    const row = { ...tpl, name: "受注の合計", app: { id: "", fcode: "得意先LU" }, filters: [{ state: true, field: "顧客", cond: "=", value: "得意先CD" }], fields: [{ state: true, to: "合計", summary: "sum", formula: "IF(受注日<=基準日,金額,0)", init: true, editable: false }] };
    const added = await call("agg_update", { file: "agg-app100.json", expectedDigest: made.digest, ops: [{ op: "addRow", row }] });
    assert.deepEqual([added.status, added.rows.map((r) => r.key)], ["saved", ["01"]]);
    assert.match(added.diff, /\[行 01\] 足した 受注の合計/);
    assert.equal((await call("agg_update", { file: "agg-app100.json", expectedDigest: made.digest, ops: [{ op: "removeRow", key: "01" }] })).status, "conflict", "古い digest では直せない");
    // 検査: 取り違えを止める。error の間は取り込み用のファイルを作れない
    const c1 = await call("agg_check", { file: "agg-app100.json" });
    assert.deepEqual([c1.status, c1.issues.map((i) => `${i.severity}:${i.code}:${i.rowKey}`), c1.apps], ["has-errors", ["error:formula:01"], ["200"]]);
    assert.match(c1.evaluation, /架空のレコード/);
    assert.equal((await call("agg_export", { file: "agg-app100.json", expectedDigest: c1.digest })).status, "has-errors");
    // 直す: 行を読んで式を直し、入れ替える
    const r = await call("agg_read", { file: "agg-app100.json", key: "01" });
    r.row.fields[0].formula = "IF(受注日<=#基準日,金額,0)";
    const fixed = await call("agg_update", { file: "agg-app100.json", expectedDigest: r.digest, ops: [{ op: "setRow", key: "01", row: r.row }, { op: "patchCommon", patch: { pluginComment: "受注の合計を出す" } }] });
    assert.match(fixed.diff, /fields\[0\]\.formula: .*基準日.* → .*#基準日/);
    const c2 = await call("agg_check", { file: "agg-app100.json" });
    assert.deepEqual([c2.status, c2.issues], ["ok", []]);
    // 取り込み用のファイル
    assert.equal((await call("agg_export", { file: "agg-app100.json", expectedDigest: fixed.digest.replace(/^./, (ch) => (ch === "0" ? "1" : "0")) })).status, "conflict", "検査したものと違う digest では作らない");
    const ex = await call("agg_export", { file: "agg-app100.json", expectedDigest: c2.digest });
    assert.equal(ex.status, "saved");
    assert.match(ex.importFile, /^aggregate-app100-\d{8}-\d{6}-import\.json$/);
    assert.ok(ex.nextSteps.some((s) => /設定をアップロード/.test(s)) && ex.nextSteps.some((s) => /既存のレコードは変わりません/.test(s)) && ex.nextSteps.some((s) => /kintone には何も書いていません/.test(s)));
    const env = JSON.parse(readFileSync(path.join(d.ws, ex.importFile), "utf8"));
    assert.deepEqual([env.pluginID, env.PluginVersion, env.appId, env.pluginComment, env.pluginInfos[0].appKey, env.pluginInfos[0].fieldsInfo[0].toField], ["rex0220 aggregate records plugin", "67", 100, "受注の合計を出す", "200:(得意先LU):受注", "受注金額の合計:合計"]);
    // 一覧と、取り込み用のファイルからの作り直し
    const files = (await call("agg_files")).files;
    assert.deepEqual(files.map((x) => x.type).sort(), ["envelope", "source"]);
    const copy = await call("agg_new", { file: "agg-app100-copy.json", from: ex.importFile });
    assert.deepEqual([copy.status, copy.appId, copy.rows], ["saved", 100, 1]);
    // 取り込み用のファイルから戻した設定は、元の設定ファイルと同じ。違うのは、項目から引いた対象アプリの番号が入ることだけ
    assert.equal((await call("agg_diff", { before: "agg-app100.json", after: "agg-app100-copy.json" })).diff, "[行 01] 変わった 受注の合計\n  app.id:  → 200");
    // kintone へは GET だけ。アプリごとの API トークンで読む
    assert.ok(k.calls.length > 0 && k.calls.every((c) => c.method === "GET"));
    assert.deepEqual([...new Set(k.calls.map((c) => c.api))].sort(), ["app", "app/form/fields", "app/form/layout", "app/views", "preview/app/form/fields", "preview/app/form/layout", "preview/app/views"]);
    assert.deepEqual(readdirSync(d.ws).filter((n) => n.startsWith(".")), [], "一時ファイルとロックが残らない");
    await close();
  } finally { d.cleanup(); }
});

test("接続が無い・ファイルの名前が外を指す・読めないアプリ", { skip }, async () => {
  const d = makeDirs();
  const k = fakeKintone();
  try {
    const none = await connect({ PCA_WORKSPACE: d.ws, AGGREGATE_PLUGIN_ZIP: ZIP });
    await none.call("agg_new", { file: "a.json", app: 100 });
    assert.deepEqual([(await none.call("agg_check", { file: "a.json" })).status, (await none.call("agg_fields", { app: 100 })).status], ["connection-error", "connection-error"]);
    assert.equal((await none.call("agg_new", { file: "../b.json", app: 100 })).status, "denied");
    assert.equal((await none.call("agg_read", { file: "none.json" })).status, "missing");
    await none.close();
    const { call, close } = await connect({ PCA_WORKSPACE: d.ws, AGGREGATE_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    // トークンの無いアプリ（300）を対象アプリにした行
    const made = await call("agg_read", { file: "a.json" });
    const tpl = (await call("agg_read", { file: "a.json", key: "new" })).row;
    await call("agg_update", { file: "a.json", expectedDigest: made.digest, ops: [{ op: "addRow", row: { ...tpl, name: "読めないアプリ", app: { id: "300", fcode: "" }, fields: [{ state: true, to: "合計", summary: "sum", formula: "1", init: false, editable: false }] } }] });
    const c = await call("agg_check", { file: "a.json" });
    assert.deepEqual([c.status, c.issues.map((i) => i.code)], ["has-errors", ["app.unknown"]]);
    assert.ok(c.notes.some((n) => /アプリ 300 の名前を読めない/.test(n)), JSON.stringify(c.notes));
    assert.ok(!JSON.stringify(c).includes("token-"), "秘密の値を返さない");
    await close();
  } finally { d.cleanup(); }
});

test("ビルドした本体を起動して、状態・資料・ファイルの操作が通る（標準出力は JSON-RPC だけ）", { skip: skip || (existsSync(path.join(HERE, "../dist/server/index.cjs")) ? false : "dist が無い（npm run build）") }, async () => {
  const d = makeDirs();
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, "../dist/server/index.cjs"), "--plugin", "aggregate"], env: { ...process.env, PCA_WORKSPACE: d.ws, AGGREGATE_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: "" }, stderr: "pipe" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    // 期待と違っても、起動したサーバーを必ず閉じる（閉じないと試験が終わらない）
    try {
    const call = async (name, args = {}) => { const t = (await client.callTool({ name, arguments: args })).content[0].text; try { return JSON.parse(t); } catch { return t; } };
    const s = await call("agg_status");
    assert.deepEqual([s.status, s.zip.status, s.zip.signed, s.kintone.status, s.mcp], ["problem", "ok", true, "not-configured", JSON.parse(readFileSync(path.join(HERE, "../package.json"), "utf8")).version]);
    assert.match(await call("agg_docs", { section: "spec" }), /設定ファイルの書き方/);
    const made = await call("agg_new", { file: "x.json", app: 5 });
    assert.equal(made.status, "saved");
    const tpl = (await call("agg_read", { file: "x.json", key: "new" })).row;
    assert.deepEqual(Object.keys(tpl).sort(), ["app", "fields", "filters", "key", "name", "orFrom", "order", "reflect", "state", "table"]);
    } finally { await client.close(); }
  } finally { d.cleanup(); }
});
