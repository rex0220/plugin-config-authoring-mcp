/**
 * MCP サーバー（--plugin field-format → ffmt_*）。材料は項目書式プラグインの zip（隣の field-format/dist/field-format-plugin16.zip。無ければ飛ばす）。
 * ソースのサーバーを同じプロセスでつなぎ、kintone は代役（GET の応答）で、新しく作る → 検査 → レコードを当てて確かめる → 取り込み用のファイルまで通す。
 * アプリ集計（模擬の無い製品）に ffmt_try に当たるツールが出ないことも見る
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZIP = path.resolve(HERE, "../../field-format/dist/field-format-plugin16.zip");
const AGG_ZIP = path.resolve(HERE, "../../aggregate/dist/aggregate-plugin67.zip");
const skip = existsSync(ZIP) ? false : `項目書式の zip が無い: ${ZIP}`;

const PROPS = {
  件名: { type: "SINGLE_LINE_TEXT", code: "件名", label: "タイトル" },
  金額: { type: "NUMBER", code: "金額", label: "見積金額" },
  期限: { type: "DATE", code: "期限", label: "回答期限" },
  状況: { type: "DROP_DOWN", code: "状況", label: "対応状況", options: { 未対応: { label: "未対応", index: "0" }, 完了: { label: "完了", index: "1" } } },
  明細: { type: "SUBTABLE", code: "明細", label: "見積の明細", fields: { 数量: { type: "NUMBER", code: "数量", label: "数" } } }
};
const LAYOUT = [{ type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "件名" }, { type: "NUMBER", code: "金額" }, { type: "DATE", code: "期限" }, { type: "DROP_DOWN", code: "状況" }] }, { type: "SUBTABLE", code: "明細", fields: [{ type: "NUMBER", code: "数量" }] }];
const record = (id, v) => ({ $id: { type: "__ID__", value: String(id) }, 件名: { type: "SINGLE_LINE_TEXT", value: v.件名 ?? "x" }, 金額: { type: "NUMBER", value: v.金額 ?? "" }, 期限: { type: "DATE", value: v.期限 ?? null }, 状況: { type: "DROP_DOWN", value: v.状況 ?? "未対応" }, 明細: { type: "SUBTABLE", value: (v.数量 ?? []).map((q, i) => ({ id: String(i + 1), value: { 数量: { type: "NUMBER", value: String(q) } } })) } });
const RECORDS = { 1: record(1, { 金額: "1500", 期限: "2000-01-01", 数量: [12, 3] }), 2: record(2, { 金額: "50", 期限: "2099-12-31", 状況: "完了" }), 3: record(3, {}) };

/** kintone の代役: GET の URL から応答を決める。呼ばれた API を控える */
function fakeKintone() {
  const calls = [];
  const body = (obj) => { const bytes = new TextEncoder().encode(JSON.stringify(obj)); let done = false; return { getReader: () => ({ read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })), cancel: async () => undefined, releaseLock: () => undefined }) }; };
  const fetch = async (url, init) => {
    const u = new URL(url);
    const api = u.pathname.replace(/^\/k\/v1\//, "").replace(/\.json$/, "");
    calls.push({ method: init.method, api, id: u.searchParams.get("id"), query: u.searchParams.get("query") });
    let hit;
    if (api === "app") hit = { appId: "300", name: "見積" };
    else if (api === "preview/app/form/fields" || api === "app/form/fields") hit = { properties: PROPS, revision: "1" };
    else if (api === "preview/app/form/layout") hit = { layout: LAYOUT, revision: "1" };
    else if (api === "preview/app/views") hit = { views: { 一覧A: { id: "5001", type: "LIST", name: "一覧A", index: "0" } } };
    else if (api === "record") hit = RECORDS[u.searchParams.get("id")] ? { record: RECORDS[u.searchParams.get("id")] } : undefined;
    else if (api === "records") hit = { records: /件名 = "無い"/.test(u.searchParams.get("query") ?? "") ? [] : [RECORDS[2], RECORDS[1]] };
    return hit ? { ok: true, status: 200, body: body(hit) } : { ok: false, status: 404, body: body({ code: "GAIA_RE01", message: "not found" }) };
  };
  return { fetch, calls };
}
async function connect(plugin, env, extra = {}) {
  const server = createServer({ plugin, env, cwd: env.PCA_WORKSPACE, ...extra });
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
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pca-ffmt-")));
  const ws = path.join(base, "ws");
  mkdirSync(ws);
  const conn = path.join(base, "connections.json");
  writeFileSync(conn, JSON.stringify({ defaultProfile: "dev", profiles: { dev: { baseUrl: "https://dev-x.cybozu.com", tokenMap: { APP300: "token-300" } } } }), { mode: 0o600 });
  return { base, ws, conn, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const cond = (formula, more = {}) => ({ state: true, formula, theme: "", color: "", bcolor: "", fsize: "", fstyle: "", ...more });

test("項目書式: ツールは ffmt_ で出て、模擬（ffmt_try）がある。模擬の無い製品（アプリ集計）には出ない。資料に式の落とし穴がある", { skip }, async () => {
  const d = makeDirs();
  try {
    const { client, call, close } = await connect("field-format", { PCA_WORKSPACE: d.ws, FIELD_FORMAT_PLUGIN_ZIP: ZIP });
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["ffmt_check", "ffmt_diff", "ffmt_docs", "ffmt_export", "ffmt_fields", "ffmt_files", "ffmt_new", "ffmt_read", "ffmt_status", "ffmt_try", "ffmt_update"]);
    assert.match(client.getInstructions() ?? "", /項目書式/);
    assert.match(client.getInstructions() ?? "", /ffmt_try で、レコードを当てて確かめる/);
    const s = await call("ffmt_status");
    assert.deepEqual([s.plugin, s.zip.status, s.zip.pluginVersion, s.zip.signed], ["field-format", "ok", "16", true]);
    assert.match(await call("ffmt_docs"), /- howto: .*\n- spec: /);
    const spec = await call("ffmt_docs", { section: "spec" });
    for (const word of ["DATE_FORMAT(期限)<TODAY()", "空の数値は 0 と同じ", "$STATUS_HISTORY", "最初に真になった条件", "UINFO"]) assert.ok(spec.includes(word), word);
    assert.match(await call("ffmt_docs", { section: "howto" }), /全置換.*項目の置換/s);
    await close();
    if (existsSync(AGG_ZIP)) {
      const agg = await connect("aggregate", { PCA_WORKSPACE: d.ws, AGGREGATE_PLUGIN_ZIP: AGG_ZIP });
      assert.equal((await agg.client.listTools()).tools.some((t) => /_try$/.test(t.name)), false);
      assert.doesNotMatch(agg.client.getInstructions() ?? "", /_try/);
      await agg.close();
    }
  } finally { d.cleanup(); }
});

test("項目書式: 新しく作る → 検査で止まる → 直す → レコードを当てて確かめる → 取り込み用のファイル（kintone へは GET だけ。レコードそのものは返さない）", { skip }, async () => {
  const d = makeDirs();
  const k = fakeKintone();
  try {
    const { call, close } = await connect("field-format", { PCA_WORKSPACE: d.ws, FIELD_FORMAT_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    const f = await call("ffmt_fields", { app: 300, preview: true });
    assert.deepEqual(f.fields.find((x) => x.code === "状況").options, ["未対応", "完了"]);
    assert.deepEqual(f.views, [{ id: "5001", name: "一覧A", type: "LIST" }], "一覧の ID を確かめられる");
    const made = await call("ffmt_new", { file: "ffmt-app300.json", app: 300, appName: "見積" });
    assert.deepEqual([made.status, made.rows], ["saved", 0]);
    const tpl = (await call("ffmt_read", { file: "ffmt-app300.json", key: "new" })).row;
    assert.deepEqual(Object.keys(tpl).sort(), ["detail", "field", "key", "label", "list", "state", "value"]);
    // 期限切れを赤く（わざと、日付をそのまま TODAY() と比べる式と、色の名前で書く）
    const added = await call("ffmt_update", {
      file: "ffmt-app300.json", expectedDigest: made.digest,
      ops: [
        { op: "addRow", row: { ...tpl, field: "期限", value: [cond("期限<TODAY()", { color: "red" })] } },
        { op: "addRow", row: { ...tpl, field: "数量", value: [cond("数量>=10", { fstyle: "bold" })] } }
      ]
    });
    assert.deepEqual(added.rows, [{ key: "01", state: true, name: "期限" }, { key: "02", state: true, name: "数量" }], "行の見出しは項目コード");
    const c1 = await call("ffmt_check", { file: "ffmt-app300.json" });
    assert.deepEqual([c1.status, c1.issues.map((x) => [x.code, x.rowKey, x.section, x.label])], ["has-errors", [["color.format", "01", "value", "1"]]]);
    // 検査で止まる間は、模擬も取り込み用のファイルも作らない。**レコードも読まない**
    k.calls.length = 0;
    const t0 = await call("ffmt_try", { file: "ffmt-app300.json", ids: [1] });
    assert.deepEqual([t0.status, t0.issues.map((x) => x.code), "records" in t0, "recordsFrom" in t0], ["has-errors", ["color.format"], false, false]);
    assert.equal(k.calls.some((c) => c.api === "record" || c.api === "records"), false, "止まる設定ではレコードを読まない");
    assert.equal((await call("ffmt_export", { file: "ffmt-app300.json", expectedDigest: added.digest })).status, "has-errors");
    // 色を直す。式は検査を通る（文法は正しい）
    const row = (await call("ffmt_read", { file: "ffmt-app300.json", key: "01" })).row;
    const fixed = await call("ffmt_update", { file: "ffmt-app300.json", expectedDigest: added.digest, ops: [{ op: "patchRow", key: "01", patch: { value: [{ ...row.value[0], color: "#ff0000" }] } }] });
    const c2 = await call("ffmt_check", { file: "ffmt-app300.json" });
    assert.deepEqual([c2.status, c2.issues], ["ok", []]);
    // レコードを当てる: 期限が 2000-01-01 のレコード 1 でも、条件は真にならない（日付の項目は数、TODAY() は文字）
    k.calls.length = 0;
    const t1 = await call("ffmt_try", { file: "ffmt-app300.json", ids: [1, 2] });
    assert.deepEqual([t1.status, t1.recordsFrom, t1.recordCount, t1.screens], ["ok", "ids", 2, ["detail", "list"]]);
    const due = t1.conditions.find((x) => x.field === "期限");
    assert.deepEqual([due.rowKey, due.cond, due.total, due.hits, due.errors], ["01", 1, 2, 0, 0], "一度も真にならない");
    assert.deepEqual(t1.records[0].screens.detail.数量, { label: 0, value: [1, 0] });
    assert.deepEqual(k.calls.filter((c) => c.api === "record").map((c) => c.id), ["1", "2"]);
    assert.ok(k.calls.every((c) => c.method === "GET"));
    assert.equal(JSON.stringify(t1).includes("1500"), false, "レコードの値そのものは返さない");
    // 式を直して、もう一度当てる（条件で読む。空の日付のレコードは自分で書く）
    const fixed2 = await call("ffmt_update", { file: "ffmt-app300.json", expectedDigest: fixed.digest, ops: [{ op: "patchRow", key: "01", patch: { value: [{ ...row.value[0], color: "#ff0000", formula: 'AND(期限!="",DATE_FORMAT(期限)<TODAY())' }] } }] });
    const t2 = await call("ffmt_try", { file: "ffmt-app300.json", query: "order by $id desc", screens: ["detail"] });
    assert.deepEqual([t2.status, t2.recordsFrom, t2.query, t2.records.map((r) => [r.id, r.screens.detail.期限.value])], ["ok", "query", "order by $id desc limit 20", [["2", 0], ["1", 1]]]);
    const t3 = await call("ffmt_try", { file: "ffmt-app300.json", records: [RECORDS[3]] });
    assert.deepEqual([t3.recordsFrom, t3.records[0].screens.detail.期限.value], ["records", 0], "空の日付には付かない");
    // fields で答えを絞る
    const t5 = await call("ffmt_try", { file: "ffmt-app300.json", ids: [1], fields: ["数量"] });
    assert.deepEqual([Object.keys(t5.records[0].screens.detail), t5.conditions.map((x) => x.field)], [["数量"], ["数量"]]);
    // 設定に入れずに式の値だけを見る（probes）。条件に合うレコードが無いのは、誤りとは別の答え
    const t4 = await call("ffmt_try", { file: "ffmt-app300.json", ids: [1, 2], probes: [{ formula: "状況" }, { formula: "数量*2", field: "数量" }] });
    assert.deepEqual(t4.probes.map((p) => [p.formula, p.field, p.total, p.samples.map((s) => s.value)]), [["状況", undefined, 2, ["未対応", "完了"]], ["数量*2", "数量", 2, ["24", "6"]]]);
    assert.deepEqual((await call("ffmt_try", { file: "ffmt-app300.json", ids: [1], probes: [{ formula: "1", field: "nothing" }] })).issues.map((x) => x.code), ["simulate.probes"]);
    assert.equal((await call("ffmt_try", { file: "ffmt-app300.json", query: '件名 = "無い"' })).status, "no-records");
    // 渡し方の誤り
    assert.deepEqual([(await call("ffmt_try", { file: "ffmt-app300.json" })).status, (await call("ffmt_try", { file: "ffmt-app300.json", ids: [1], query: "" })).status, (await call("ffmt_try", { file: "ffmt-app300.json", query: "limit 5" })).status], ["invalid", "invalid", "invalid"]);
    assert.equal((await call("ffmt_try", { file: "ffmt-app300.json", ids: [99] })).status, "kintone-error");
    // 取り込み用のファイル: 共通の設定 + pluginInfos（派生値なし）。伝える文に取り込み方
    const ex = await call("ffmt_export", { file: "ffmt-app300.json", expectedDigest: fixed2.digest });
    assert.equal(ex.status, "saved");
    assert.ok(ex.nextSteps.some((s) => /全置換/.test(s) && /項目の置換/.test(s)), ex.nextSteps.join("\n"));
    // 新しく作った設定は、行の外の設定を持たない（取り込んでも、利用者の NOTE・説明・一覧別設定は今のまま）
    assert.ok(ex.nextSteps.some((s) => /共通の設定（一覧別設定・説明・NOTE・プラグイン有効・運用環境に反映）は入っていません/.test(s)), ex.nextSteps.join("\n"));
    const env = JSON.parse(readFileSync(path.join(d.ws, ex.importFile), "utf8"));
    assert.deepEqual([env.pluginID, env.PluginVersion, env.appId, env.pluginInfos.map((x) => x.fieldcode), "pluginFields" in env, "pluginPP" in env], ["rex0220 field format plugin", "16", 300, ["期限", "数量"], false, false]);
    assert.equal(env.pluginInfos[0].condInfos[0].condSet, 'AND(期限!="",DATE_FORMAT(期限)<TODAY())');
    assert.deepEqual(["pluginListInfo" in env, "pluginComment" in env, "pluginEnable" in env], [false, false, false]);
    // 一覧別設定を書くと、ファイルに入り、伝える文が変わる
    const cur = await call("ffmt_read", { file: "ffmt-app300.json" });
    const withList = await call("ffmt_update", { file: "ffmt-app300.json", expectedDigest: cur.digest, ops: [{ op: "patchCommon", patch: { listInfo: { all_enabled: false, views: { 5001: "" } } } }] });
    // 取り込み用のファイルの名前は秒まで（同じ秒に 2 つは作れない = 上書きしない）
    await new Promise((r) => setTimeout(r, 1100));
    const ex2 = await call("ffmt_export", { file: "ffmt-app300.json", expectedDigest: withList.digest });
    assert.equal(ex2.status, "saved", JSON.stringify(ex2).slice(0, 300));
    assert.ok(ex2.nextSteps.some((s) => /共通の設定のうち 一覧別設定 が入っています/.test(s) && /チェックを外してください/.test(s)), ex2.nextSteps.join("\n"));
    assert.deepEqual(JSON.parse(readFileSync(path.join(d.ws, ex2.importFile), "utf8")).pluginListInfo, { all_enabled: false, views: { 5001: "一覧A" } });
    await close();
  } finally { d.cleanup(); }
});

test("別の製品の設定ファイルは読まない・直さない・取り込み用のファイルにしない（同じ作業フォルダーにアプリ集計と項目書式のファイルがあっても）", { skip: skip || (existsSync(AGG_ZIP) ? false : "アプリ集計の zip が無い") }, async () => {
  const d = makeDirs();
  const k = fakeKintone();
  try {
    const ff = await connect("field-format", { PCA_WORKSPACE: d.ws, FIELD_FORMAT_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    const agg = await connect("aggregate", { PCA_WORKSPACE: d.ws, AGGREGATE_PLUGIN_ZIP: AGG_ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    const a = await agg.call("agg_new", { file: "agg.json", app: 300 });
    const f = await ff.call("ffmt_new", { file: "ffmt.json", app: 300 });
    assert.deepEqual([a.status, f.status], ["saved", "saved"]);
    k.calls.length = 0;
    // 項目書式のツールに、アプリ集計の設定ファイルを渡す（行が空なので、通ってしまうと「項目の設定が空」の取り込み用のファイルができる）
    const denied = (r, what) => assert.deepEqual([r.status, r.code], ["invalid", "other-plugin"], `${what}: ${JSON.stringify(r).slice(0, 200)}`);
    denied(await ff.call("ffmt_read", { file: "agg.json" }), "read");
    denied(await ff.call("ffmt_check", { file: "agg.json" }), "check");
    denied(await ff.call("ffmt_try", { file: "agg.json", ids: [1] }), "try");
    denied(await ff.call("ffmt_export", { file: "agg.json", expectedDigest: a.digest }), "export");
    denied(await ff.call("ffmt_update", { file: "agg.json", expectedDigest: a.digest, ops: [{ op: "patchCommon", patch: { pluginComment: "x" } }] }), "update");
    denied(await ff.call("ffmt_diff", { before: "agg.json", after: "ffmt.json" }), "diff");
    // 逆向きも
    denied(await agg.call("agg_read", { file: "ffmt.json" }), "agg read");
    denied(await agg.call("agg_export", { file: "ffmt.json", expectedDigest: f.digest }), "agg export");
    denied(await agg.call("agg_update", { file: "ffmt.json", expectedDigest: f.digest, ops: [{ op: "patchCommon", patch: { pluginComment: "x" } }] }), "agg update");
    assert.deepEqual(k.calls, [], "止めたときは kintone を読んでいない");
    assert.equal(readdirSync(d.ws).some((n) => /-import\.json$/.test(n)), false, "取り込み用のファイルはできていない");
    assert.deepEqual([(await agg.call("agg_read", { file: "agg.json" })).digest, (await ff.call("ffmt_read", { file: "ffmt.json" })).digest], [a.digest, f.digest], "どちらのファイルも変わっていない");
    await ff.close();
    await agg.close();
  } finally { d.cleanup(); }
});

test("項目書式: 模擬の結果が大きすぎるときは返さずに、絞り方を伝える（fields で絞れば返る）", { skip }, async () => {
  const d = makeDirs();
  const k = fakeKintone();
  // 行の多いテーブルのレコードを自分で書いて渡す（1 レコード 1,500 行 × 20 レコード）
  const big = (id) => ({ $id: { type: "__ID__", value: String(id) }, 金額: { type: "NUMBER", value: "1" }, 明細: { type: "SUBTABLE", value: Array.from({ length: 1500 }, (_x, i) => ({ id: String(i + 1), value: { 数量: { type: "NUMBER", value: String(i) } } })) } });
  try {
    const { call, close } = await connect("field-format", { PCA_WORKSPACE: d.ws, FIELD_FORMAT_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    const made = await call("ffmt_new", { file: "big.json", app: 300 });
    const tpl = (await call("ffmt_read", { file: "big.json", key: "new" })).row;
    await call("ffmt_update", { file: "big.json", expectedDigest: made.digest, ops: [{ op: "addRow", row: { ...tpl, field: "数量", value: [cond("数量>=10")] } }, { op: "addRow", row: { ...tpl, field: "金額", value: [cond("金額>0")] } }] });
    const records = Array.from({ length: 20 }, (_x, i) => big(i + 1));
    const all = await call("ffmt_try", { file: "big.json", records });
    assert.deepEqual([all.status, all.size > all.limit, "records" in all, /fields で確かめる項目を絞る/.test(all.message)], ["too-large", true, false, true]);
    const few = await call("ffmt_try", { file: "big.json", records, fields: ["金額"], screens: ["detail"] });
    assert.deepEqual([few.status, few.records.length, few.records[0].screens.detail], ["ok", 20, { 金額: { label: 0, value: 1 } }]);
    await close();
  } finally { d.cleanup(); }
});
