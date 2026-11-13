/**
 * 配布の形（Claude Code のプラグイン）の決まり。zip そのものの検査は scripts/plugin-zip-verify.mjs（npm run verify:plugin）。
 *   - リポジトリに入れてはいけないもの（認証情報、実案件の設定、本物の環境のホスト名）が無い
 *   - 製品ごとの定義（scripts/products.mjs）が中核の表と合い、何のプラグインかが名前と文で分かる
 *   - フックのモジュールがあり、設定ファイルの印が中核の SOURCE_FILE_KIND と同じ
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GENERIC_PLUGINS } from "@rex0220/formula-authoring-tools/generic";
import { forbiddenReasons, realHosts, repoProblems } from "../scripts/forbidden-files.mjs";
import { mcpJson, pluginJson, productNames, productOf, zipName } from "../scripts/products.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("リポジトリに入れてはいけないものが無い", () => {
  assert.deepEqual(repoProblems(root), []);
  assert.equal(forbiddenReasons("rex0220-aggregate-records-app2593-20261113-112413.json").length, 1, "設定画面のダウンロード");
  assert.equal(forbiddenReasons("work/aggregate-app100-20261113-120000-import.json").length, 1, "取り込み用のファイル");
  assert.equal(forbiddenReasons("ksql.config.json").length, 1);
  assert.deepEqual(forbiddenReasons("test/server.test.mjs"), []);
  assert.deepEqual(realHosts("https://x.cybozu.com と https://dev-x.cybozu.com"), []);
  const real = ["real-company", "cybozu", "com"].join("."); // このファイル自身が検査に当たらないように、つなげて作る
  assert.deepEqual(realHosts(`https://${real}/k/1/`), [real]);
});

test("製品ごとの定義: 中核の表にある製品だけを、製品の名前で出す", () => {
  const names = productNames();
  assert.ok(names.includes("aggregate"));
  for (const name of names) {
    const core = GENERIC_PLUGINS[name];
    const p = productOf(name);
    assert.deepEqual([p.name, p.toolPrefix, p.zipEnv, p.minPluginVersion], [core.name, core.toolPrefix, core.zipEnv, core.minPluginVersion]);
    const plugin = pluginJson(name, "1.2.3");
    assert.deepEqual([plugin.name, plugin.version], [name, "1.2.3"]);
    assert.ok(plugin.description.includes(core.title), "説明に製品の名前");
    for (const [k, v] of Object.entries(plugin.userConfig)) {
      assert.ok(v.title.includes(core.title), `設定 ${k} の題に製品の名前`);
      assert.equal(v.required, false, "設定は後からでも入れられる（無ければ status が足りないものを言う）");
      assert.equal(v.sensitive, undefined, "秘密の値は設定に持たない（接続のファイルの場所だけ）");
    }
    const server = mcpJson(name).mcpServers[name];
    assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/dist/server/index.cjs", "--plugin", name]);
    assert.deepEqual(Object.keys(server.env), [core.zipEnv, "PCA_KINTONE_CONFIG", "PCA_KINTONE_PROFILE", "PCA_WORKSPACE"]);
    for (const v of Object.values(server.env)) assert.ok(plugin.userConfig[v.match(/^\$\{user_config\.(\w+)\}$/)?.[1]], `env の値は設定を指す: ${v}`);
    assert.equal(zipName(name, "1.2.3"), `${name}-authoring-plugin-1.2.3.zip`);
  }
  assert.throws(() => productOf("formula"), /製品の定義が無い/);
});

test("フック: モジュールがあり、設定ファイルの印が中核と同じ", async () => {
  const hooks = JSON.parse(readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(hooks.modules, ["./register.ts"]);
  for (const m of hooks.modules) assert.ok(existsSync(path.join(root, "hooks", m)));
  const src = readFileSync(path.join(root, "hooks", "register.ts"), "utf8");
  const tools = readFileSync(path.join(root, "node_modules", "@rex0220", "formula-authoring-tools", "dist", "generic.mjs"), "utf8");
  const kind = src.match(/SOURCE_MARK = \/"kind"\\s\*:\\s\*"([\w-]+)"\//)?.[1];
  assert.equal(kind, "rex0220-authoring-source");
  assert.ok(tools.includes(`"${kind}"`), "中核の SOURCE_FILE_KIND と同じ");
});
