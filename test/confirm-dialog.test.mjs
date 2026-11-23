/**
 * MCP サーバー（--plugin confirm-dialog → cdlg_*）。材料は確認ダイアログプラグインの zip（隣の confirm-dialog/dist/confirm-dialog-plugin6.zip。無ければ飛ばす）。
 * ソースのサーバーを同じプロセスでつなぎ、kintone は代役（GET の応答）で、新しく作る → 検査 → レコードと場面を当てて確かめる → 取り込み用のファイルまで通す。
 *   - <頭>_try の入力は製品ごと（確認ダイアログは scenes / html、項目書式は screens / fields / probes）
 *   - プロセス管理の設定（preview/app/status）を読むのは、中核の表に status の印のある製品だけ（項目書式では読まない）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { TRY_COMMON_KEYS, TRY_DEFS, tryDefOf } from "../src/try-defs.ts";
import * as G from "@rex0220/formula-authoring-tools/generic";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZIP = path.resolve(HERE, "../../confirm-dialog/dist/confirm-dialog-plugin6.zip");
const FF_ZIP = path.resolve(HERE, "../../field-format/dist/field-format-plugin16.zip");
const skip = existsSync(ZIP) ? false : `確認ダイアログの zip が無い: ${ZIP}`;

// 項目コードとラベルを別にする（ラベルで書いた式が通らないことが分かるように）
const PROPS = {
  件名: { type: "SINGLE_LINE_TEXT", code: "件名", label: "タイトル" },
  金額: { type: "NUMBER", code: "金額", label: "見積金額", digit: true },
  状況: { type: "DROP_DOWN", code: "状況", label: "対応状況", options: { 未対応: { label: "未対応", index: "0" }, 完了: { label: "完了", index: "1" } } },
  明細: { type: "SUBTABLE", code: "明細", label: "見積の明細", fields: { 品名: { type: "SINGLE_LINE_TEXT", code: "品名", label: "品" }, 数量: { type: "NUMBER", code: "数量", label: "数" } } }
};
/** プロセス管理（en だけ、言語ごとの名前が付いている） */
const statusOf = (lang) => {
  const n = (ja, en) => (lang === "en" ? en : ja);
  return {
    enable: true,
    states: { 完了: { name: n("完了", "Done"), index: "2" }, 未処理: { name: n("未処理", "Not started"), index: "0" }, 処理中: { name: n("処理中", "In progress"), index: "1" } },
    actions: [{ name: n("申請", "Apply"), from: n("未処理", "Not started"), to: n("処理中", "In progress") }, { name: n("承認", "Approve"), from: n("処理中", "In progress"), to: n("完了", "Done") }],
    revision: "3"
  };
};
const record = (id, v = {}) => ({
  ...(id ? { $id: { type: "__ID__", value: String(id) } } : {}),
  件名: { type: "SINGLE_LINE_TEXT", value: v.件名 ?? "見積 A" }, 金額: { type: "NUMBER", value: v.金額 ?? "" }, 状況: { type: "DROP_DOWN", value: v.状況 ?? "未対応" },
  明細: { type: "SUBTABLE", value: (v.明細 ?? []).map(([品名, 数量], i) => ({ id: String(i + 1), value: { 品名: { type: "SINGLE_LINE_TEXT", value: 品名 }, 数量: { type: "NUMBER", value: String(数量) } } })) }
});
const RECORDS = { 1: record(1, { 金額: "1500000", 状況: "完了", 明細: [["ねじ", 2], ["板", 5]] }), 2: record(2, { 金額: "500", 件名: "秘密の件名" }) };

/** kintone の代役: GET の URL から応答を決める。呼ばれた API を控える。status = false でプロセス管理を読めない環境 */
function fakeKintone({ status = true, statesOnly = false } = {}) {
  const calls = [];
  const body = (obj) => { const bytes = new TextEncoder().encode(JSON.stringify(obj)); let done = false; return { getReader: () => ({ read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })), cancel: async () => undefined, releaseLock: () => undefined }) }; };
  const fetch = async (url, init) => {
    const u = new URL(url);
    const api = u.pathname.replace(/^\/k\/v1\//, "").replace(/\.json$/, "");
    calls.push({ method: init.method, api, id: u.searchParams.get("id"), lang: u.searchParams.get("lang") });
    let hit;
    if (api === "app") hit = { appId: "30", name: "見積" };
    else if (api === "preview/app/form/fields" || api === "app/form/fields") hit = { properties: PROPS, revision: "1" };
    else if (api === "preview/app/form/layout") hit = { layout: [{ type: "ROW", fields: [{ type: "SINGLE_LINE_TEXT", code: "件名" }, { type: "NUMBER", code: "金額" }, { type: "DROP_DOWN", code: "状況" }] }, { type: "SUBTABLE", code: "明細", fields: [{ type: "SINGLE_LINE_TEXT", code: "品名" }, { type: "NUMBER", code: "数量" }] }], revision: "1" };
    else if (api === "preview/app/views") hit = { views: {} };
    else if (api === "preview/app/status") {
      hit = status ? statusOf(statesOnly ? null : u.searchParams.get("lang")) : undefined;
      // ステータスの表示名だけが言語ごと（アクションの名前・元・先は既定の名称のまま）
      if (hit && statesOnly && u.searchParams.get("lang") === "en") hit.states.完了.name = "Done";
    }
    else if (api === "record") hit = RECORDS[u.searchParams.get("id")] ? { record: RECORDS[u.searchParams.get("id")] } : undefined;
    else if (api === "records") hit = { records: [RECORDS[2], RECORDS[1]] };
    return hit ? { ok: true, status: 200, body: body(hit) } : { ok: false, status: 403, body: body({ code: "CB_NO02", message: "no permission" }) };
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
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pca-cdlg-")));
  const ws = path.join(base, "ws");
  mkdirSync(ws);
  const conn = path.join(base, "connections.json");
  writeFileSync(conn, JSON.stringify({ defaultProfile: "dev", profiles: { dev: { baseUrl: "https://dev-x.cybozu.com", tokenMap: { APP30: "token-30" } } } }), { mode: 0o600 });
  return { base, ws, conn, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const step = (o = {}) => ({ state: true, desc: "確認", cond: "1", dialog: true, icon: "info", title: '"確認"', body: '"本文"', notify: false, ok: "", cancel: "", ...o });
const APPROVE = { name: "承認", from: "処理中", to: "完了" };

test("模擬の定義: 模擬のある製品は try-defs に 1 つずつある。製品ごとの入力の名前は、共通の入力と重ならない", () => {
  const withSim = Object.values(G.GENERIC_PLUGINS).filter((p) => p.simulate).map((p) => p.name).sort();
  assert.deepEqual(Object.keys(TRY_DEFS).sort(), withSim);
  for (const name of withSim) {
    const d = tryDefOf(name);
    assert.ok(d.about && d.returns && d.resultKey && d.invalidMessage && d.narrow && d.note);
    assert.equal(Object.keys(d.options).some((k) => TRY_COMMON_KEYS.includes(k)), false);
  }
  assert.throws(() => tryDefOf("aggregate"), /定義が無い/);
  assert.throws(() => tryDefOf("constructor"), /定義が無い/);
});

test("確認ダイアログ: ツールは cdlg_ で出る。cdlg_try の入力は scenes / html（項目書式の screens / fields / probes は無い）。資料に落とし穴がある", { skip }, async () => {
  const d = makeDirs();
  try {
    const { client, call, close } = await connect("confirm-dialog", { PCA_WORKSPACE: d.ws, CONFIRM_DIALOG_PLUGIN_ZIP: ZIP });
    const list = (await client.listTools()).tools;
    assert.deepEqual(list.map((t) => t.name).sort(), ["cdlg_check", "cdlg_diff", "cdlg_docs", "cdlg_export", "cdlg_fields", "cdlg_files", "cdlg_new", "cdlg_pull", "cdlg_read", "cdlg_status", "cdlg_try", "cdlg_update"]);
    const tr = list.find((t) => t.name === "cdlg_try");
    assert.deepEqual(Object.keys(tr.inputSchema.properties).sort(), ["file", "html", "ids", "probes", "profile", "query", "records", "scenes"]);
    assert.deepEqual(tr.inputSchema.required.slice().sort(), ["file", "scenes"]);
    assert.match(tr.description, /どのダイアログがどの順に/);
    assert.match(tr.description, /読んだレコードそのものは返さない/);
    assert.match(list.find((t) => t.name === "cdlg_fields").description, /プロセス管理/);
    assert.match(client.getInstructions() ?? "", /確認ダイアログ/);
    assert.match(client.getInstructions() ?? "", /cdlg_try で、レコードと場面を当てて確かめる/);
    const s = await call("cdlg_status");
    assert.deepEqual([s.plugin, s.zip.status, s.zip.pluginVersion, s.zip.signed], ["confirm-dialog", "ok", "6", true]);
    assert.match(await call("cdlg_docs"), /- howto: .*\n- spec: /);
    const spec = await call("cdlg_docs", { section: "spec" });
    for (const word of ["SEL_CODE(担当者,\"array\")", "app.record.index.edit.submit", "MIN(数量)<=0", "probes", "TAGS_HTML", "`TAG(…)` だけを本文に書かない", "ESC_HTML", "既定の名称", "空の数値は 0 と同じ", "UINFO", "step.errorIcon", "onCancel", '"state": false'] ) assert.ok(spec.includes(word), word);
    const howto = await call("cdlg_docs", { section: "howto" });
    assert.match(howto, /全置換.*一部置換.*追加/s);
    assert.match(howto, /最初はどれもチェックが外れている/);
    await close();
    // 項目書式の入力と説明は変わらない（screens / fields / probes。scenes は無い）
    if (existsSync(FF_ZIP)) {
      const ff = await connect("field-format", { PCA_WORKSPACE: d.ws, FIELD_FORMAT_PLUGIN_ZIP: FF_ZIP });
      const ft = (await ff.client.listTools()).tools.find((t) => t.name === "ffmt_try");
      assert.deepEqual(Object.keys(ft.inputSchema.properties).sort(), ["fields", "file", "ids", "probes", "profile", "query", "records", "screens"]);
      assert.deepEqual(ft.inputSchema.required, ["file"]);
      assert.match(ft.description, /^設定ファイルにレコードを当てて、どの条件が選ばれるかを確かめる/);
      assert.match(ft.description, /ログインユーザーはツールの既定の利用者で評価する。$/);
      assert.doesNotMatch((await ff.client.listTools()).tools.find((t) => t.name === "ffmt_fields").description, /プロセス管理/);
      await ff.close();
    }
  } finally { d.cleanup(); }
});

test("確認ダイアログ: プロセス管理を確かめる → 新しく作る → 検査 → レコードと場面を当てる → 取り込み用のファイル（kintone へは GET だけ）", { skip }, async () => {
  const d = makeDirs();
  const k = fakeKintone();
  try {
    const { call, close } = await connect("confirm-dialog", { PCA_WORKSPACE: d.ws, CONFIRM_DIALOG_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    // 項目定義とプロセス管理（既定の名称。ステータスは並びの順）
    const f = await call("cdlg_fields", { app: 30, preview: true });
    assert.deepEqual(f.process, { enabled: true, states: ["未処理", "処理中", "完了"], actions: [{ name: "申請", from: "未処理", to: "処理中" }, APPROVE] });
    assert.match(f.processNote, /言語ごとの名前が付いている/);
    assert.deepEqual(k.calls.filter((c) => c.api === "preview/app/status").map((c) => c.lang), [null, "ja", "en", "zh"]);
    // 運用環境の項目定義を読むときは、プロセス管理を読まない
    k.calls.length = 0;
    const live = await call("cdlg_fields", { app: 30 });
    assert.deepEqual(["process" in live, "processNote" in live, k.calls.some((c) => c.api === "preview/app/status")], [false, false, false]);

    const made = await call("cdlg_new", { file: "cdlg-app30.json", app: 30, appName: "見積" });
    assert.deepEqual([made.status, made.rows], ["saved", 0]);
    const tpl = (await call("cdlg_read", { file: "cdlg-app30.json", key: "new" })).row;
    assert.deepEqual([tpl.event, tpl.save, tpl.steps.length], ["save", { create: true, update: true }, 1]);
    // わざと、ラベルで書いた式（見積金額）を入れる
    const added = await call("cdlg_update", {
      file: "cdlg-app30.json", expectedDigest: made.digest,
      ops: [
        { op: "addRow", row: { state: true, name: "高額の確認", event: "save", save: { create: true, update: true }, steps: [step({ cond: "見積金額>=1000000", icon: "warning", title: '"金額の確認"', body: '"見積金額は " & FVAL(金額) & " です。<br>保存しますか？"', notify: true, ok: '"保存しました"', cancel: '"金額を見直してください"' })] } },
        { op: "addRow", row: { state: true, name: "承認の確認", event: "process", actions: [APPROVE], steps: [step({ title: '"実行確認"', title_en: '"Confirm"', body: 'EV_INFO("action") & ": " & 件名', notify: true, ok: '"承認しました"', cancel: '"やめました"' }), step({ desc: "未完了", cond: '状況!="完了"', icon: "error", body: '"対応状況が完了ではありません"', notify: true, cancel: '"完了にしてから承認してください"' })] } },
        { op: "addRow", row: { state: true, name: "明細の概要", event: "button", buttons: { detail: { state: true, cond: "COUNTROW(明細)>0", name: "明細を見る", name_en: "Items" }, create: { state: false, cond: "1", name: "明細を見る" }, update: { state: false, cond: "1", name: "明細を見る" } }, steps: [step({ title: '件名 & " の明細"', body: 'TAGS_HTML(TAG("p", "合計数量: " & SUM(数量)), TABLE_HTML(明細, 品名, 数量))' })] } }
      ]
    });
    assert.deepEqual(added.rows, [{ key: "01", state: true, name: "高額の確認" }, { key: "02", state: true, name: "承認の確認" }, { key: "03", state: true, name: "明細の概要" }], "行の見出しはダイアログ名");
    k.calls.length = 0;
    const c1 = await call("cdlg_check", { file: "cdlg-app30.json" });
    assert.deepEqual([c1.status, c1.issues.map((x) => [x.severity, x.code, x.rowKey, x.section, x.label])], ["has-errors", [["error", "formula", "01", "steps[1]", "cond"], ["warning", "step.errorIcon", "02", "steps[2]", "icon"]]]);
    assert.deepEqual(k.calls.filter((c) => c.api === "preview/app/status").map((c) => c.lang), [null, "ja", "en", "zh"], "検査はプロセス管理を読む");
    // 検査で止まる間は、模擬も取り込み用のファイルも作らない。レコードも読まない
    k.calls.length = 0;
    const t0 = await call("cdlg_try", { file: "cdlg-app30.json", ids: [1], scenes: [{ event: "update" }] });
    assert.deepEqual([t0.status, "results" in t0, "recordsFrom" in t0, /レコードも読んでいない/.test(t0.message)], ["has-errors", false, false, true]);
    assert.equal(k.calls.some((c) => c.api === "record" || c.api === "records"), false, "止まる設定ではレコードを読まない");
    assert.equal((await call("cdlg_export", { file: "cdlg-app30.json", expectedDigest: added.digest })).status, "has-errors");
    // 項目コードに直す
    const row = (await call("cdlg_read", { file: "cdlg-app30.json", key: "01" })).row;
    const fixed = await call("cdlg_update", { file: "cdlg-app30.json", expectedDigest: added.digest, ops: [{ op: "patchRow", key: "01", patch: { steps: [{ ...row.steps[0], cond: "金額>=1000000" }] } }] });
    const c2 = await call("cdlg_check", { file: "cdlg-app30.json" });
    assert.deepEqual([c2.status, c2.issues.map((x) => x.code)], ["has-warnings", ["step.errorIcon"]]);

    // レコードと場面を当てる
    k.calls.length = 0;
    const scenes = [{ event: "update" }, { event: "process", action: APPROVE }, { event: "process", action: APPROVE, lang: "en" }, { event: "button", screen: "detail" }];
    const t1 = await call("cdlg_try", { file: "cdlg-app30.json", ids: [1, 2], scenes });
    assert.deepEqual([t1.status, t1.recordsFrom, t1.recordCount, t1.results.length, t1.digest], ["ok", "ids", 2, 8, fixed.digest]);
    assert.match(t1.evaluation, /レコード画面と同じ順に式を評価した/);
    const at = (rec, i) => t1.results.filter((x) => x.record === rec)[i];
    // 保存: 100 万円以上のレコードだけ。キャンセルで止まり、OK なら通知
    assert.deepEqual(at("1", 0).dialogs.map((x) => [x.row, x.step, x.icon, x.title, x.text, x.ok, x.cancel, x.onCancel]), [["01", 1, "warning", "金額の確認", "見積金額は 1,500,000 です。\n保存しますか？", "保存する", "キャンセル", { error: "金額を見直してください" }]]);
    assert.deepEqual(at("1", 0).notices, ["保存しました"]);
    assert.deepEqual([at("2", 0).dialogs, at("2", 0).notices], [[], []]);
    // アクション: 完了のレコードは 1 つ、未完了のレコードは error のダイアログで必ず止まる。en でも同じ行が選ばれ、言語ごとのタイトルになる
    assert.deepEqual(at("1", 1).dialogs.map((x) => [x.row, x.step, x.title, x.text, x.ok]), [["02", 1, "実行確認", "承認: 見積 A", "実行する"]]);
    assert.deepEqual(at("1", 2).dialogs.map((x) => [x.row, x.step, x.title, x.text]), [["02", 1, "Confirm", "Approve: 見積 A"]]);
    assert.deepEqual(at("2", 1).dialogs.map((x) => [x.step, x.icon, x.ok, x.last]), [[1, "info", "次へ", false], [2, "error", null, true]]);
    assert.equal(at("2", 1).stoppedWith, "完了にしてから承認してください");
    // ボタン: 明細のあるレコードだけに出る
    assert.deepEqual(at("1", 3).buttons.map((b) => [b.row, b.label, b.dialogs.map((x) => [x.title, x.text, x.ok, x.cancel])]), [["03", "明細を見る", [["見積 A の明細", "合計数量: 7\n品 数\nねじ 2\n板 5", "閉じる", null]]]]);
    assert.deepEqual(at("1", 3).buttons[0].dialogs[0].onCancel, { stopped: true }, "キャンセルのボタンが無い dialog も、閉じたときの結果が付く");
    assert.deepEqual(at("2", 3).buttons, []);
    assert.deepEqual(k.calls.filter((c) => c.api === "record").map((c) => c.id), ["1", "2"]);
    assert.ok(k.calls.every((c) => c.method === "GET"));
    assert.equal("html" in at("1", 0).dialogs[0], false, "HTML は頼まれたときだけ");
    // 自分で書いたレコード（追加の画面 = $id なし）。kintone のレコードは読まない
    k.calls.length = 0;
    const t2 = await call("cdlg_try", { file: "cdlg-app30.json", records: [record(0, { 金額: "1000000" })], scenes: [{ event: "create" }], html: true });
    assert.deepEqual([t2.status, t2.recordsFrom, t2.results[0].record, t2.results[0].dialogs.length, typeof t2.results[0].dialogs[0].html], ["ok", "records", "#1", 1, "string"]);
    assert.equal(k.calls.some((c) => c.api === "record" || c.api === "records"), false);
    // 設定に入れずに、式の値だけを見る（probes）。値を書き換える関数は書けない（レコードを読んだ後に、プラグインの API が断る）
    const tp = await call("cdlg_try", { file: "cdlg-app30.json", ids: [1, 2], scenes: [{ event: "update" }], probes: [{ formula: "状況" }, { formula: "COUNTROW(明細)" }, { formula: "見積金額" }] });
    assert.deepEqual(tp.results.map((r) => r.probes.map((p) => ("error" in p ? "error" : p.value))), [["完了", 2, "error"], ["未対応", 0, "error"]]);
    const tb = await call("cdlg_try", { file: "cdlg-app30.json", ids: [1], scenes: [{ event: "update" }], probes: [{ formula: 'FSET(件名,"x")' }] });
    assert.deepEqual([tb.status, tb.issues.filter((x) => x.severity === "error").map((x) => x.code), /scenes・probes の指定を直すか/.test(tb.message)], ["has-errors", ["simulate.probes.sideEffect"], true]);
    // モバイルに一覧での編集は無い（起こらない場面を「確かめた」ことにしない）。入れ子の綴り違いは検査で止まる
    const mob = await call("cdlg_try", { file: "cdlg-app30.json", ids: [1], scenes: [{ event: "index", mobile: true }] });
    assert.deepEqual([mob.status, mob.issues.filter((x) => x.severity === "error").map((x) => x.code), "results" in mob], ["has-errors", ["simulate.scenes"], false]);
    assert.equal((await call("cdlg_try", { file: "cdlg-app30.json", ids: [1], scenes: [{ event: "update", mobile: true }, { event: "index" }] })).status, "ok");
    // どの行でも選ばれていないアクションは、そう伝える
    const t3 = await call("cdlg_try", { file: "cdlg-app30.json", ids: [1], scenes: [{ event: "process", action: { name: "申請", from: "未処理", to: "処理中" } }] });
    assert.deepEqual([t3.results[0].dialogs, /どの行でも選ばれていません/.test(t3.results[0].note)], [[], true]);
    // 場面の組み合わせの誤りは、プラグインの API が返す（レコードは読んだ）。scenes を書かないのは、受ける前に断る
    const bad = await call("cdlg_try", { file: "cdlg-app30.json", ids: [1], scenes: [{ event: "process" }] });
    assert.deepEqual([bad.status, bad.issues.filter((x) => x.severity === "error").map((x) => x.code), bad.recordsFrom, /scenes・probes の指定を直すか/.test(bad.message)], ["has-errors", ["simulate.scenes"], "ids", true]);
    assert.match(String(await call("cdlg_try", { file: "cdlg-app30.json", ids: [1] })), /scenes/);
    // 知らない入力（ほかの製品の入力・綴り違い）は、受ける前に断る（黙って捨てて ok を返さない）。レコードも読まない
    k.calls.length = 0;
    for (const extra of [{ screens: ["detail"] }, { htlm: true }, { proebs: [{ formula: "1" }] }]) {
      const res = await call("cdlg_try", { file: "cdlg-app30.json", ids: [1], scenes: [{ event: "update" }], ...extra });
      assert.match(String(res), new RegExp(Object.keys(extra)[0]), JSON.stringify(res).slice(0, 200));
    }
    assert.equal(k.calls.length, 0);
    // 渡し方の誤り
    assert.deepEqual([(await call("cdlg_try", { file: "cdlg-app30.json", scenes: [{ event: "update" }] })).status, (await call("cdlg_try", { file: "cdlg-app30.json", ids: [99], scenes: [{ event: "update" }] })).status], ["invalid", "kintone-error"]);

    // 取り込み用のファイル: 保存値の形（行 + 派生値）。行の外の設定は書いていないので入らない。伝える文に取り込み方
    const ex = await call("cdlg_export", { file: "cdlg-app30.json", expectedDigest: fixed.digest });
    assert.equal(ex.status, "saved", JSON.stringify(ex).slice(0, 300));
    assert.ok(ex.nextSteps.some((s) => /最初「全置換」が選ばれています/.test(s) && /一部置換/.test(s) && /追加/.test(s)), ex.nextSteps.join("\n"));
    // 「追加」は名前を変えない（設定画面の import-plan.ts の mergeRows は、ファイルの行をそのまま末尾に足す）
    assert.ok(ex.nextSteps.some((s) => /その名前のまま足されます/.test(s)) && !ex.nextSteps.some((s) => /名前が変わ/.test(s)), ex.nextSteps.join("\n"));
    assert.ok(ex.nextSteps.some((s) => /共通の設定（プラグイン有効・NOTE・説明・共通CSS・通知秒数・メニュー表示・運用環境に反映）は入っていません/.test(s)), ex.nextSteps.join("\n"));
    assert.ok(ex.nextSteps.some((s) => /warning の指摘があります/.test(s)));
    const env = JSON.parse(readFileSync(path.join(d.ws, ex.importFile), "utf8"));
    assert.deepEqual([env.pluginID, env.PluginVersion, env.appId, env.pluginInfos.map((x) => x.menu), "options" in env, "pluginEnable" in env], ["rex0220 Confirm dialog plugin", "6", 30, ["高額の確認", "承認の確認", "明細の概要"], false, false]);
    assert.deepEqual(Object.keys(env.statusByLid).sort(), ["en", "ja", "zh"]);
    assert.deepEqual(env.statusByLid.en, { "Approve\tIn progress\tDone": "承認\t処理中\t完了" }, "言語ごとの名前から、既定の名称を引く");
    // 取り込み用のファイルから設定ファイルに写すと、同じ行になる（設定画面の「設定をダウンロード」と同じ道）
    const back = await call("cdlg_new", { file: "cdlg-back.json", from: ex.importFile });
    assert.deepEqual([back.status, back.appId, back.rows], ["saved", 30, 3]);
    assert.equal((await call("cdlg_diff", { before: "cdlg-app30.json", after: "cdlg-back.json" })).diff.trim().split("\n").filter((l) => /^[+-]/.test(l)).length, 0, "差が無い");
    // 行の外の設定を書くと、ファイルに入り、伝える文が変わる
    const cur = await call("cdlg_read", { file: "cdlg-app30.json" });
    const withCommon = await call("cdlg_update", { file: "cdlg-app30.json", expectedDigest: cur.digest, ops: [{ op: "patchCommon", patch: { notifySeconds: "5", pluginComment: "メモ" } }] });
    await new Promise((r) => setTimeout(r, 1100));
    const ex2 = await call("cdlg_export", { file: "cdlg-app30.json", expectedDigest: withCommon.digest });
    assert.equal(ex2.status, "saved", JSON.stringify(ex2).slice(0, 300));
    assert.ok(ex2.nextSteps.some((s) => /共通の設定のうち NOTE と 通知秒数 が入っています/.test(s) && /最初はどれもチェックが外れています/.test(s)), ex2.nextSteps.join("\n"));
    const env2 = JSON.parse(readFileSync(path.join(d.ws, ex2.importFile), "utf8"));
    assert.deepEqual([env2.options, env2.pluginComment], [{ notifySeconds: "5" }, "メモ"]);
    // 行の外の設定の入れ子の綴り違い（英語の見出しを eng と書いた）は、黙って捨てずに検査で止める
    const typo = await call("cdlg_update", { file: "cdlg-app30.json", expectedDigest: withCommon.digest, ops: [{ op: "patchCommon", patch: { menu: { enabled: true, label: { default: "概要", eng: "Overview" } } } }] });
    assert.equal(typo.status, "saved");
    const tc = await call("cdlg_check", { file: "cdlg-app30.json" });
    assert.deepEqual([tc.status, tc.issues.filter((x) => x.severity === "error").map((x) => [x.code, x.section, x.label])], ["has-errors", [["key.unknown", "menu.label", "eng"]]]);
    await close();
  } finally { d.cleanup(); }
});

test("確認ダイアログ: プロセス管理を読めない環境では、アクションを確かめていないと伝える（検査は通る）。読んだレコードの値のうち、ダイアログに出ないものは返さない", { skip }, async () => {
  const d = makeDirs();
  const k = fakeKintone({ status: false });
  try {
    const { call, close } = await connect("confirm-dialog", { PCA_WORKSPACE: d.ws, CONFIRM_DIALOG_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    const f = await call("cdlg_fields", { app: 30, preview: true });
    assert.deepEqual(["process" in f, /プロセス管理を読めない/.test(f.processNote)], [false, true]);
    const made = await call("cdlg_new", { file: "a.json", app: 30 });
    const added = await call("cdlg_update", { file: "a.json", expectedDigest: made.digest, ops: [{ op: "addRow", row: { state: true, name: "承認の確認", event: "process", actions: [APPROVE], steps: [step({ body: '"金額: " & 金額' })] } }] });
    const c = await call("cdlg_check", { file: "a.json" });
    assert.deepEqual([c.status, c.issues.map((x) => x.code)], ["has-warnings", ["status.unavailable"]]);
    assert.ok(c.notes.some((n) => /アプリ 30 のプロセス管理を読めない/.test(n)), c.notes.join(" / "));
    // 模擬は、書いた名前のままで引く
    const t = await call("cdlg_try", { file: "a.json", ids: [2], scenes: [{ event: "process", action: APPROVE }] });
    assert.deepEqual([t.status, t.results[0].dialogs.map((x) => x.text)], ["ok", ["金額: 500"]]);
    assert.equal(JSON.stringify(t).includes("秘密の件名"), false, "式に書いていない項目の値は返らない");
    const ex = await call("cdlg_export", { file: "a.json", expectedDigest: added.digest });
    assert.equal(ex.status, "saved");
    assert.equal("statusByLid" in JSON.parse(readFileSync(path.join(d.ws, ex.importFile), "utf8")), false, "読めなかったときは、言語ごとの名前の表を入れない（設定画面が保存のときに作る）");
    await close();
  } finally { d.cleanup(); }
});

test("項目書式の検査・模擬・項目定義は、プロセス管理を読まない（status の印のある製品だけが読む）", { skip: existsSync(FF_ZIP) ? false : "項目書式の zip が無い" }, async () => {
  const d = makeDirs();
  const k = fakeKintone();
  try {
    const { call, close } = await connect("field-format", { PCA_WORKSPACE: d.ws, FIELD_FORMAT_PLUGIN_ZIP: FF_ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    const f = await call("ffmt_fields", { app: 30, preview: true });
    assert.equal("process" in f || "processNote" in f, false);
    const made = await call("ffmt_new", { file: "f.json", app: 30 });
    const tpl = (await call("ffmt_read", { file: "f.json", key: "new" })).row;
    await call("ffmt_update", { file: "f.json", expectedDigest: made.digest, ops: [{ op: "addRow", row: { ...tpl, field: "金額", value: [{ state: true, formula: "金額>=100", theme: "", color: "#ff0000", bcolor: "", fsize: "", fstyle: "" }] } }] });
    const fc = await call("ffmt_check", { file: "f.json" });
    assert.equal(fc.status, "ok", JSON.stringify(fc.issues));
    const t = await call("ffmt_try", { file: "f.json", ids: [1] });
    assert.deepEqual([t.status, t.records[0].screens.detail.金額.value], ["ok", 1]);
    assert.equal(k.calls.some((c) => c.api === "preview/app/status"), false, "項目書式ではプロセス管理を読まない");
    await close();
  } finally { d.cleanup(); }
});

test("確認ダイアログ: ステータスの名前だけが言語ごとのアプリでも、言語ごとの名前の注記が出る。指摘は 1 件の文と全部の大きさに上限がある", { skip }, async () => {
  const d = makeDirs();
  const k = fakeKintone({ statesOnly: true });
  try {
    const { call, close } = await connect("confirm-dialog", { PCA_WORKSPACE: d.ws, CONFIRM_DIALOG_PLUGIN_ZIP: ZIP, PCA_KINTONE_CONFIG: d.conn }, { fetch: k.fetch });
    const f = await call("cdlg_fields", { app: 30, preview: true });
    assert.deepEqual(f.process.actions.map((a) => a.name), ["申請", "承認"]);
    assert.match(f.processNote ?? "", /言語ごとの名前が付いている/);
    // 長い式の誤りを 80 個（1 件の文は切り詰め、全部で 40,000 字まで。数は issuesTotal に出る）
    const made = await call("cdlg_new", { file: "big.json", app: 30 });
    const long = `no_such_field_${"x".repeat(1500)}`;
    const steps = Array.from({ length: 80 }, (_, i) => step({ desc: `s${i}`, cond: long }));
    const added = await call("cdlg_update", { file: "big.json", expectedDigest: made.digest, ops: [{ op: "addRow", row: { state: true, name: "大きい", event: "save", steps } }] });
    assert.equal(added.status, "saved");
    for (const res of [await call("cdlg_check", { file: "big.json" }), await call("cdlg_try", { file: "big.json", ids: [1], scenes: [{ event: "update" }] }), await call("cdlg_export", { file: "big.json", expectedDigest: added.digest })]) {
      assert.equal(res.status, "has-errors");
      assert.ok(res.issues.length > 0 && res.issues.length < 80, String(res.issues.length));
      assert.ok(res.issues.every((x) => x.message.length <= 601), "1 件の文は 600 字まで");
      assert.deepEqual(res.issuesTotal, { error: 80, warning: 0 });
      assert.ok(JSON.stringify(res).length < 60000, String(JSON.stringify(res).length));
    }
    await close();
  } finally { d.cleanup(); }
});
