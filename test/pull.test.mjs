/**
 * アプリの今の設定を読む（<頭>_pull）。材料は項目書式プラグインの zip（隣の field-format/dist/field-format-plugin16.zip。無ければ飛ばす）。
 *   作った設定を「設定画面が保存した形」（compress "2"）にして kintone の代役に置き、pull で読み戻す。
 *   kintone へは GET だけ、既定は動作テスト環境、上書きしない、保存値そのもの（更新者の名前など）を返さない、
 *   設定が空・API を呼べないときの答え、profile を固定したときは別の profile を断る
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as G from "@rex0220/formula-authoring-tools/generic";
import { createServer } from "../src/server.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZIP = path.resolve(HERE, "../../field-format/dist/field-format-plugin16.zip");
const AGG_ZIP = path.resolve(HERE, "../../aggregate/dist/aggregate-plugin67.zip");
const skip = existsSync(ZIP) ? false : `項目書式の zip が無い: ${ZIP}`;
const FF = G.genericPlugin("field-format");

const PROPS = {
  期限: { type: "DATE", code: "期限", label: "回答期限" },
  状況: { type: "DROP_DOWN", code: "状況", label: "対応状況", options: { 未対応: { label: "未対応", index: "0" }, 完了: { label: "完了", index: "1" } } }
};
const LAYOUT = [{ type: "ROW", fields: [{ type: "DATE", code: "期限" }, { type: "DROP_DOWN", code: "状況" }] }];
const UPDATER = "山田 太郎（更新者）";

/** compress "2" の保存値（設定画面の保存の形） */
const stored2 = (data) => ({ compress: "2", json: deflateSync(Buffer.from(encodeURIComponent(JSON.stringify(data)), "utf8")).toString("base64") });

/** kintone の代役。state.config = プラグインの設定（運用環境・動作テスト環境で別に置ける）。呼ばれた API を控える */
function fakeKintone(state) {
  const calls = [];
  const body = (obj) => { const bytes = new TextEncoder().encode(JSON.stringify(obj)); let done = false; return { getReader: () => ({ read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })), cancel: async () => {} }) }; };
  const fetch = async (url, init) => {
    const u = new URL(url);
    const api = u.pathname.replace(/^\/k\/v1\//, "").replace(/\.json$/, "");
    calls.push({ method: init.method, api, app: u.searchParams.get("app"), id: u.searchParams.get("id") });
    let hit;
    if (api === "app") hit = { appId: "300", name: "見積" };
    else if (api === "preview/app/form/fields" || api === "app/form/fields") hit = { properties: PROPS, revision: "1" };
    else if (api === "preview/app/form/layout") hit = { layout: LAYOUT, revision: "1" };
    else if (api === "preview/app/views") hit = { views: {} };
    else if (api === "preview/app/plugin/config" && state.apiOff !== true) hit = { config: state.preview ?? {}, revision: "12" };
    else if (api === "app/plugin/config" && state.apiOff !== true) hit = { config: state.live ?? {}, revision: "11" };
    return hit ? { ok: true, status: 200, body: body(hit) } : { ok: false, status: 404, body: body({ code: "GAIA_XX00", message: "not found" }) };
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
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pca-pull-")));
  const ws = path.join(base, "ws");
  mkdirSync(ws);
  const conn = path.join(base, "connections.json");
  const profile = (host) => ({ baseUrl: `https://${host}.cybozu.com`, tokenMap: { APP300: "token-300" } });
  writeFileSync(conn, JSON.stringify({ defaultProfile: "dev", profiles: { dev: profile("dev-x"), prod: profile("x") } }), { mode: 0o600 });
  return { base, ws, conn, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const cond = (formula, more = {}) => ({ state: true, formula, theme: "", color: "", bcolor: "", fsize: "", fstyle: "", ...more });
const usedRows = (rows) => rows.filter((r) => r.state).map((r) => ({ field: r.field, detail: r.detail, list: r.list, label: r.label.map(({ rid, ...c }) => c), value: r.value.map(({ rid, ...c }) => c) }));

test("pull: 作った設定を設定画面が保存した形にして置き、読み戻すと同じ設定になる（GET だけ・既定は動作テスト環境・上書きしない・保存値そのものは返さない）", { skip }, async () => {
  const d = makeDirs();
  const state = {};
  const k = fakeKintone(state);
  try {
    const { client, call, close } = await connect("field-format", { PCA_WORKSPACE: d.ws, FIELD_FORMAT_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("ffmt_pull"));
    assert.ok(names.indexOf("ffmt_pull") === names.indexOf("ffmt_new") + 1, "並びは new の次");

    // まだ保存していないアプリ
    const none = await call("ffmt_pull", { file: "now.json", app: 300 });
    assert.equal(none.status, "no-config");
    assert.equal(none.code, "stored-empty");
    assert.match(none.message, /動作テスト環境/);
    assert.equal(existsSync(path.join(d.ws, "now.json")), false);

    // 設定を作って、取り込み用のファイルにし、その本体を「保存値」にする（設定画面が保存した形 = compress "2"。更新者の名前を足す）
    const made = await call("ffmt_new", { file: "src.json", app: 300 });
    const row = (await call("ffmt_read", { file: "src.json", key: "new" })).row;
    const up = await call("ffmt_update", {
      file: "src.json", expectedDigest: made.digest,
      ops: [
        { op: "addRow", row: { ...row, field: "期限", state: true, value: [cond('AND(期限!="",DATE_FORMAT(期限)<TODAY())', { color: "#ffffff", bcolor: "#ff0000", fstyle: "bold" })] } },
        { op: "addRow", row: { ...row, field: "状況", state: true, list: false, value: [cond('状況="完了"', { bcolor: "#d3d3d3" })] } },
        { op: "patchCommon", patch: { pluginComment: "メモ" } }
      ]
    });
    assert.equal(up.status, "saved", JSON.stringify(up).slice(0, 300));
    const ex = await call("ffmt_export", { file: "src.json", expectedDigest: up.digest });
    assert.equal(ex.status, "saved", JSON.stringify(ex).slice(0, 300));
    const env = await G.callGeneric({ plugin: "field-format", zip: ZIP, method: "readEnvelope", args: [readFileSync(path.join(d.ws, ex.importFile), "utf8")] }, { timeoutSec: 60 });
    state.preview = stored2({ ...env.body, pluginUpdater: UPDATER, pluginLastUpdate: "2026-11-22 10:00:00" });
    state.live = stored2({ ...env.body, pluginComment: "運用環境のメモ", pluginUpdater: UPDATER });

    k.calls.length = 0;
    const got = await call("ffmt_pull", { file: "now.json", app: 300 });
    assert.equal(got.status, "saved", JSON.stringify(got).slice(0, 400));
    assert.deepEqual([got.file, got.appId, got.appName, got.profile, got.from, got.revision, got.rows], ["now.json", 300, "見積", "dev", "preview", "12", 2]);
    assert.ok(got.notes.some((n) => /動作テスト環境/.test(n)) && got.notes.some((n) => /全置換/.test(n)));
    // kintone へは GET だけ。呼ぶのはアプリの名前と、動作テスト環境のプラグインの設定（プラグイン ID は製品の表のもの）
    assert.deepEqual(k.calls, [{ method: "GET", api: "app", app: null, id: "300" }, { method: "GET", api: "preview/app/plugin/config", app: "300", id: FF.kintonePluginId }]);
    // 保存値そのもの（更新者の名前）は、答えにも、置いた設定ファイルにも入らない
    assert.ok(!JSON.stringify(got).includes(UPDATER));
    assert.ok(!readFileSync(path.join(d.ws, "now.json"), "utf8").includes(UPDATER));

    // 読み戻した設定は、作った設定と同じ（行のキーと rid を除く）
    const a = await call("ffmt_read", { file: "src.json" });
    const b = await call("ffmt_read", { file: "now.json" });
    const rowsOf = async (file, list) => Promise.all(list.rows.map(async (r) => (await call("ffmt_read", { file, key: r.key })).row));
    assert.deepEqual(usedRows(await rowsOf("now.json", b)), usedRows(await rowsOf("src.json", a)));
    assert.equal((await call("ffmt_read", { file: "now.json", key: "common" })).common.pluginComment, "メモ");
    // そのまま検査を通る（続けて直せる）
    assert.equal((await call("ffmt_check", { file: "now.json" })).status, "ok");

    // 上書きしない
    const again = await call("ffmt_pull", { file: "now.json", app: 300 });
    assert.equal(again.status, "exists", JSON.stringify(again).slice(0, 200));

    // 運用環境
    k.calls.length = 0;
    const live = await call("ffmt_pull", { file: "live.json", app: 300, preview: false });
    assert.deepEqual([live.status, live.from, live.revision], ["saved", "live", "11"]);
    assert.equal(k.calls[1].api, "app/plugin/config");
    assert.equal((await call("ffmt_read", { file: "live.json", key: "common" })).common.pluginComment, "運用環境のメモ");
    await close();
  } finally {
    d.cleanup();
  }
});

test("pull: API を呼べない（API ラボが無効・権限が無い）ときは、設定をダウンロードする道を hint で返す。ほどけない保存値は置かない", { skip }, async () => {
  const d = makeDirs();
  const state = { apiOff: true };
  const k = fakeKintone(state);
  try {
    const { call, close } = await connect("field-format", { PCA_WORKSPACE: d.ws, FIELD_FORMAT_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    const off = await call("ffmt_pull", { file: "now.json", app: 300 });
    assert.equal(off.status, "kintone-error");
    assert.equal(off.httpStatus, 404);
    assert.match(off.hint, /API ラボ/);
    assert.match(off.hint, /設定をダウンロード/);
    assert.match(off.hint, /アプリ管理/);
    assert.equal(existsSync(path.join(d.ws, "now.json")), false);

    state.apiOff = false;
    state.preview = { json: "{}" }; // 平文（この入口は読まない）
    const plain = await call("ffmt_pull", { file: "now.json", app: 300 });
    assert.deepEqual([plain.status, plain.code], ["invalid", "stored-unsupported-compress"]);
    state.preview = stored2({ pluginInfos: "行の並びでない" }); // ほどけるが、プラグインの検査に通らない
    const bad = await call("ffmt_pull", { file: "now.json", app: 300 });
    assert.equal(bad.status, "invalid", JSON.stringify(bad).slice(0, 300));
    assert.equal(existsSync(path.join(d.ws, "now.json")), false, "検査に通らない保存値からは、設定ファイルを置かない");
    await close();
  } finally {
    d.cleanup();
  }
});

test("pull: profile を起動の設定で固定すると、別の profile からは読まない。アプリ集計にも agg_pull が出る", { skip }, async () => {
  const d = makeDirs();
  const k = fakeKintone({});
  try {
    const fixed = await connect("field-format", { PCA_WORKSPACE: d.ws, FIELD_FORMAT_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn, PCA_KINTONE_PROFILE: "dev" }, { fetch: k.fetch });
    const denied = await fixed.call("ffmt_pull", { file: "now.json", app: 300, profile: "prod" });
    assert.deepEqual([denied.status, denied.code], ["denied", "profile-fixed"]);
    assert.equal(k.calls.length, 0, "断るときは kintone に行かない");
    await fixed.close();
    if (existsSync(AGG_ZIP)) {
      const agg = await connect("aggregate", { PCA_WORKSPACE: d.ws, AGGREGATE_PLUGIN_ZIP: AGG_ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
      const names = (await agg.client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes("agg_pull"));
      const none = await agg.call("agg_pull", { file: "agg.json", app: 300 });
      assert.equal(none.status, "no-config");
      assert.equal(k.calls.at(-1).id, G.genericPlugin("aggregate").kintonePluginId, "読むのは、その製品のプラグイン ID の設定");
      await agg.close();
    }
  } finally {
    d.cleanup();
  }
});
