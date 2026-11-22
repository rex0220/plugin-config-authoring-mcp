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
import { MARKETPLACE_NAME, mcpJson, pluginJson, PRIVACY_URL, productMismatch, productNames, productOf, readmeOf, releasedNames, REPO_URL, SUPPORT_URL, zipName } from "../scripts/products.mjs";
import { manifestOf, mcpbNames, MCPB_FILES } from "../scripts/build-mcpb.mjs";
import { marketplace } from "../scripts/write-marketplace.mjs";

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
    assert.deepEqual([plugin.privacyPolicyUrl, plugin.supportUrl], [PRIVACY_URL, SUPPORT_URL], "プライバシーポリシーと問い合わせ先");
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
    // レコードを読む製品（模擬あり）の配布物は「レコードは読まない」と書かない。接続が要るツールに <頭>_try を入れる
    const readme = readmeOf(name, "1.2.3", "THIRD_PARTY_NOTICES.md");
    const tryTool = `${core.toolPrefix}_try`;
    assert.equal(p.simulate, core.simulate === true);
    assert.equal(readme.includes("レコードは読まない"), !p.simulate, `${name}: README のレコードの文`);
    assert.equal(readme.includes(tryTool), p.simulate, `${name}: README に ${tryTool}`);
    assert.equal(plugin.userConfig.kintoneConfig.description.includes(tryTool), p.simulate, `${name}: 接続のファイルの説明に ${tryTool}`);
  }
  assert.equal(productOf("field-format").simulate, true, "項目書式は模擬あり（レコードを読む）");
  assert.equal(productOf("aggregate").simulate, false);
  assert.throws(() => productOf("formula"), /製品の定義が無い/);
  // 中核の表と配布の定義は同じ製品を持つ（片方だけに足すと、その製品が配布と試験から黙って消える）
  assert.deepEqual(productMismatch(), []);
  assert.deepEqual(names.slice().sort(), Object.keys(GENERIC_PLUGINS).sort());
  assert.equal(productMismatch({ aggregate: {}, "data-generator": {} }, { aggregate: {} }).length, 1, "中核にだけある製品");
  assert.equal(productMismatch({ aggregate: {} }, { aggregate: {}, extra: {} }).length, 1, "配布の定義にだけある製品");
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

test("marketplace: 製品ごとのプラグインを並べ、リリースの zip を sha256 で固定して指す（版は書かない）", () => {
  const sha256 = "0".repeat(64);
  // 並べるのは配布する製品だけ（対応の版がリリースされていない製品は出さない）
  assert.deepEqual(releasedNames(), ["field-format"]);
  assert.ok(releasedNames().every((n) => productNames().includes(n)));
  const m = marketplace(releasedNames().map((name) => ({ plugin: pluginJson(name, "1.2.3"), sha256 })));
  assert.equal(m.name, "rex0220-plugin-authoring");
  assert.equal(m.name, MARKETPLACE_NAME);
  assert.deepEqual(m.plugins.map((p) => p.name), releasedNames());
  assert.ok(m.description.includes("項目書式") && !m.description.includes("アプリ集計"), "説明に出すのは配布する製品だけ");
  for (const p of m.plugins) {
    assert.deepEqual(p.source, { source: "archive", url: `${REPO_URL}/releases/download/v1.2.3/${p.name}-authoring-plugin-1.2.3.zip`, sha256 });
    assert.equal(p.version, undefined, "版は plugin.json だけに書く");
    assert.equal(p.userConfig, undefined, "利用者の設定は写さない");
    assert.ok(p.description.includes(productOf(p.name).title));
  }
});

test("互換表（README）が中核の表と合う", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  for (const name of productNames()) {
    const core = GENERIC_PLUGINS[name];
    const row = readme.split(/\r?\n/).find((l) => l.startsWith("|") && l.includes(`（\`${name}\`）`));
    assert.ok(row, `互換表に ${name} の行がある`);
    const cells = row.split("|").map((c) => c.trim());
    assert.deepEqual([cells[1], cells[2], cells[3], cells[4]], [`${core.title}（\`${name}\`）`, `\`${core.toolPrefix}_*\``, `Ver.${core.minPluginVersion} 以降`, core.contractVersions.join("、")]);
  }
});

test(".mcpb: 配布する製品は .mcpb を作れ、manifest が Claude Code のプラグインと同じ製品・同じ設定を指す", () => {
  assert.ok(releasedNames().every((n) => mcpbNames().includes(n)), "配布する製品にはアイコンがある");
  for (const name of mcpbNames()) {
    const core = GENERIC_PLUGINS[name];
    const m = manifestOf(name, "1.2.3");
    assert.deepEqual([m.name, m.version], [`${name}-authoring`, "1.2.3"]);
    assert.ok(m.display_name.includes(core.title));
    assert.deepEqual(m.server.mcp_config.args, ["${__dirname}/server/index.cjs", "--plugin", name]);
    assert.deepEqual(Object.keys(m.server.mcp_config.env).sort(), [core.zipEnv, "PCA_KINTONE_CONFIG", "PCA_KINTONE_PROFILE", "PCA_WORKSPACE"].sort());
    for (const v of Object.values(m.server.mcp_config.env)) assert.ok(m.user_config[v.match(/^\$\{user_config\.(\w+)\}$/)?.[1]], `env の値は設定を指す: ${v}`);
    assert.deepEqual(m.privacy_policies, [PRIVACY_URL]);
    assert.equal(m.support, SUPPORT_URL);
    assert.deepEqual(m.tools.map((t) => t.name.replace(`${core.toolPrefix}_`, "")), ["status", "docs", "files", "fields", "new", "pull", "read", "update", "diff", "check", "export", ...(core.simulate ? ["try"] : [])]);
    assert.equal(m.description.includes("レコードは読まない"), core.simulate !== true);
    assert.ok(existsSync(path.join(root, productOf(name).icon)), "アイコンのファイルがある");
  }
  assert.ok(MCPB_FILES.includes("manifest.json") && MCPB_FILES.includes("icon.png"));
  for (const f of ["PRIVACY.md", "SECURITY.md", "CHANGELOG.md"]) assert.ok(existsSync(path.join(root, f)), `${f} がある`);
});
