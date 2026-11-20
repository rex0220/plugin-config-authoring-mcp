// プラグインの zip の検査（kSQL アクションのオーサリングの scripts/plugin-zip-verify.mjs を元にした。製品ごとに回す）。
//   1. zip を開いて、中身の一覧（決まったファイルだけ）、入れてはいけないもの、版（plugin.json と package.json）、THIRD_PARTY_NOTICES.md がリポジトリと同じ、
//      .mcp.json が zip の中の本体を指し、製品の名前を --plugin で、zip・接続のファイル・profile・作業フォルダーを env で渡す、hooks.json のモジュールが zip にある
//   2. 展開して、Claude Code と同じ形（.mcp.json の command と args。${CLAUDE_PLUGIN_ROOT} は展開したフォルダー）で起動し、MCP のクライアントで話す:
//      ツールの一覧（製品の頭）、<頭>_status（zip の署名、接続、profile の固定）、<頭>_new で設定ファイルを作る（zip の中の本体・Worker・dist/vendor の moment が動く）、
//      固定した profile と別の profile を断る、試験用の API トークンが応答・標準エラーに出ないこと
//   3. claude があれば claude plugin validate（展開したフォルダー。CLAUDE=<claude の実行ファイル> で指定できる）
//   4. sha256 を出す（marketplace の archive が固定して指す値）
// 使い方: npm run build && node scripts/build-plugin-zip.mjs && node scripts/plugin-zip-verify.mjs [製品...]
//   （プラグインの zip は PCA_TEST_<製品>_ZIP か、隣の <製品>/dist/ の決まった名前。TEST_ZIPS）
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COPIED_FILES, GENERATED_FILES, outPath, VERSION } from "./build-plugin-zip.mjs";
import { problemsOf } from "./forbidden-files.mjs";
import { productNames, productOf, zipName } from "./products.mjs";
import { eol, NOTICES_FILE } from "./third-party-notices.mjs";
import { readZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TOKEN = "TEST-not-a-real-token-0123456789"; // 本物の資格情報は使わない

/** 試験に使う kintone のプラグインの zip（隣のリポジトリのビルドしたもの） */
const TEST_ZIPS = { aggregate: "../aggregate/dist/aggregate-plugin67.zip", "field-format": "../field-format/dist/field-format-plugin16.zip" };
const testZipOf = (name) => process.env[`PCA_TEST_${name.toUpperCase().replace(/-/g, "_")}_ZIP`] ?? path.resolve(root, TEST_ZIPS[name] ?? "");

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function verify(name) {
  const product = productOf(name);
  const tmp = path.join(root, ".tmp", "plugin-zip-verify", name);
  const ZIP = testZipOf(name);
  assert(TEST_ZIPS[name] !== undefined || process.env[`PCA_TEST_${name.toUpperCase()}_ZIP`], `試験に使う zip の場所が決まっていない: ${name}（TEST_ZIPS に足す）`);
  assert(existsSync(ZIP), `${product.title}プラグインの zip が無い: ${ZIP}（PCA_TEST_${name.toUpperCase()}_ZIP で指す）`);
  const out = outPath(name);
  const entries = readZip(out);
  const expected = [...COPIED_FILES, ...GENERATED_FILES];
  assert(JSON.stringify([...entries.keys()].sort()) === JSON.stringify([...expected].sort()), `中身が違う: ${[...entries.keys()].join(", ")}`);
  const problems = problemsOf(entries);
  assert(!problems.length, `入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  assert(eol(entries.get(NOTICES_FILE).toString("utf8")) === eol(readFileSync(path.join(root, NOTICES_FILE), "utf8")), `${NOTICES_FILE} がリポジトリのものと違う`);

  const plugin = JSON.parse(entries.get(".claude-plugin/plugin.json").toString("utf8"));
  assert(plugin.name === name && plugin.version === VERSION, `plugin.json の名前・版: ${plugin.name} ${plugin.version}`);
  assert(path.basename(out) === zipName(name, plugin.version), "zip の名前に版");
  assert(plugin.description.includes(product.title), "説明に製品の名前（何のプラグインかが分かる）");
  for (const [k, v] of Object.entries(plugin.userConfig)) {
    assert((v.sensitive === true) === /token|password|username/i.test(k), `プラグインの ${k} の sensitive（秘密の値の項目だけ）`);
    assert(v.title.includes(product.title), `設定の ${k} の題に製品の名前（/config でほかのプラグインと並ぶ）`);
  }
  const server = JSON.parse(entries.get(".mcp.json").toString("utf8")).mcpServers?.[name];
  assert(server?.command === "node" && server.args[0] === "${CLAUDE_PLUGIN_ROOT}/dist/server/index.cjs" && entries.has("dist/server/index.cjs"), ".mcp.json が zip の中の本体を指す");
  assert(JSON.stringify(server.args.slice(1)) === JSON.stringify(["--plugin", name]), "製品の名前は --plugin で渡す");
  const wantEnv = { [product.zipEnv]: "${user_config.pluginZip}", PCA_KINTONE_CONFIG: "${user_config.kintoneConfig}", PCA_KINTONE_PROFILE: "${user_config.kintoneProfile}", PCA_WORKSPACE: "${user_config.workspace}" };
  assert(JSON.stringify(server.env) === JSON.stringify(wantEnv), `zip・接続のファイル・profile・作業フォルダーは env で渡す: ${JSON.stringify(server.env)}`);
  for (const ref of JSON.stringify(server).match(/\$\{user_config\.(\w+)\}/g) ?? []) assert(plugin.userConfig[ref.slice(14, -1)], `.mcp.json が指す設定が plugin.json にある: ${ref}`);
  const hooks = JSON.parse(entries.get("hooks/hooks.json").toString("utf8"));
  assert(Array.isArray(hooks.modules) && hooks.modules.every((m) => entries.has(path.posix.join("hooks", m))), "hooks.json のモジュールが zip にある");
  assert(![...entries.keys()].some((p) => /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|bun\.lock)$/.test(p)), "package.json と lockfile は入れない（依存を入れさせない）");
  assert(![...entries.keys()].some((p) => /\.test\.|tsconfig/.test(p)), "試験と tsconfig は入れない");

  rmSync(tmp, { recursive: true, force: true });
  const pluginDir = path.join(tmp, "plugin");
  for (const [p, data] of entries) {
    mkdirSync(path.dirname(path.join(pluginDir, p)), { recursive: true });
    writeFileSync(path.join(pluginDir, p), data);
  }
  const workspace = path.join(realpathSync(tmp), "workspace");
  mkdirSync(workspace, { recursive: true });
  const connFile = path.join(realpathSync(tmp), "ksql.config.json");
  const profile = (host) => ({ baseUrl: `https://${host}.cybozu.com`, tokenMap: { APP1001: TEST_TOKEN } });
  writeFileSync(connFile, JSON.stringify({ defaultProfile: "prod", profiles: { dev: profile("dev-x"), prod: profile("x") } }), { mode: 0o600 });
  const values = { "${CLAUDE_PLUGIN_ROOT}": pluginDir, "${user_config.workspace}": workspace, "${user_config.pluginZip}": ZIP, "${user_config.kintoneConfig}": connFile, "${user_config.kintoneProfile}": "dev" };
  const fill = (s) => Object.entries(values).reduce((acc, [k, v]) => acc.replaceAll(k, v), s);
  const argv = server.args.map(fill);
  const env = { PATH: process.env.PATH ?? "", CLAUDE_PLUGIN_ROOT: pluginDir };
  for (const [k, v] of Object.entries(server.env)) env[k] = fill(v);
  const transport = new StdioClientTransport({ command: process.execPath, args: argv, env, cwd: path.parse(process.cwd()).root, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "plugin-zip-verify", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const seen = [];
  let toolCount = 0;
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: `${product.toolPrefix}_${tool}`, arguments: args });
    const text = r.content.map((c) => c.text).join("");
    seen.push(text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  try {
    const instructions = String(client.getInstructions?.());
    seen.push(instructions);
    assert(instructions.includes(product.title), `指示に製品の名前: ${instructions.slice(0, 80)}`);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    toolCount = names.length;
    assert(names.length > 0 && names.every((n) => n.startsWith(`${product.toolPrefix}_`)), `ツールは製品の頭で出る: ${names.join(", ")}`);
    for (const t of ["status", "docs", "new", "update", "check", "export"]) assert(names.includes(`${product.toolPrefix}_${t}`), `ツール ${product.toolPrefix}_${t} がある`);
    const st = await call("status");
    assert(st.status === "ok" && st.plugin === name, `準備ができた: ${JSON.stringify(st).slice(0, 400)}`);
    assert(st.zip?.status === "ok" && st.zip.signed === true, `プラグインの zip を読めて、署名を確かめた: ${JSON.stringify(st.zip)}`);
    assert(st.kintone?.status === "ok", `接続のファイルを読めた: ${JSON.stringify(st.kintone)}`);
    assert(JSON.stringify(st).includes('"dev"') && !JSON.stringify(st).includes(connFile), "profile は起動の設定で dev に固定、接続のファイルの場所は返さない");
    assert(typeof (await call("docs")) === "string", "資料の目次が読める");
    const made = await call("new", { file: `${name}-app1001.json`, app: 1001, appName: "受注" });
    assert(made.status === "saved" && existsSync(path.join(workspace, `${name}-app1001.json`)), `設定ファイルを作れる（zip の中の本体・Worker・moment が動く）: ${JSON.stringify(made).slice(0, 300)}`);
    const other = await call("fields", { app: 1001, profile: "prod" });
    assert(other.status === "denied", `固定した profile と別の profile は断る: ${JSON.stringify(other).slice(0, 200)}`);
  } finally {
    await client.close();
  }
  assert(!seen.join("\n").includes(TEST_TOKEN) && !stderr.includes(TEST_TOKEN), "応答と標準エラーにトークンが出ない");

  // claude plugin validate（claude が無ければ飛ばす）
  const claude = process.env.CLAUDE ?? "claude";
  const v = spawnSync(claude, ["plugin", "validate", pluginDir], { encoding: "utf8" });
  if (v.error?.code === "ENOENT") console.log(`[plugin-zip-verify] claude が無いので plugin validate は飛ばした（CLAUDE=<claude の実行ファイル> で指定できる）`);
  else assert(v.status === 0, `claude plugin validate が通らない:\n${v.stdout}${v.stderr}`);

  const zip = readFileSync(out);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  console.log(`[plugin-zip-verify] ok（${path.basename(out)}、${zip.length.toLocaleString()} bytes、ツール ${toolCount}、node ${process.version} で起動${v.error ? "" : "、claude plugin validate 済み"}）`);
  console.log(`sha256 ${sha256}`);
}

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : productNames();
  for (const name of names) await verify(name);
}

main().catch((e) => {
  console.error(`[plugin-zip-verify] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
