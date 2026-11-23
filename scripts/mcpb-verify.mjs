// .mcpb の検査（製品ごと）。kSQL アクションのオーサリングの scripts/mcpb-verify.mjs を元にした（正本は formula MCP）。
//   1. zip を開いて、要るファイル・入れてはいけないもの・manifest の値（版、起動の形、設定項目の種類、秘密の値を設定項目に持たないこと、
//      配布元とプライバシーポリシー）、THIRD_PARTY_NOTICES.md がリポジトリのものと同じこと
//   2. 展開して、Desktop と同じ形（node server/index.cjs + 引数 + 環境変数、起動の場所はドライブのいちばん上）で起動し、MCP のクライアントで話す:
//      指示に製品の名前、ツールの一覧が manifest と同じ並び、準備の診断（zip を読めて署名を確かめた）、設定ファイルを作れる、
//      固定した profile と別の profile は断る、試験用の API トークンが引数・応答・標準エラーに出ない
//   3. 任意の設定（接続のファイル・profile）を入れていない形（${user_config.…} が展開されないまま渡る）でも起動して、準備の診断が返る
// 使い方: npm run build && node scripts/build-mcpb.mjs && node scripts/mcpb-verify.mjs [製品...]
//   （プラグインの zip は PCA_TEST_<製品>_ZIP か、隣の <製品>/dist/ の決まった名前）
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCPB_FILES, mcpbName, mcpbNames, outPath, VERSION } from "./build-mcpb.mjs";
import { problemsOf } from "./forbidden-files.mjs";
import { PRIVACY_URL, productOf, REPO_URL, SUPPORT_URL } from "./products.mjs";
import { eol, NOTICES_FILE } from "./third-party-notices.mjs";
import { readZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TOKEN = "TEST-not-a-real-token-0123456789"; // 本物の資格情報は使わない
/** 試験に使う kintone のプラグインの zip（隣のリポジトリのビルドしたもの） */
const TEST_ZIPS = { aggregate: "../aggregate/dist/aggregate-plugin67.zip", "field-format": "../field-format/dist/field-format-plugin16.zip", "confirm-dialog": "../confirm-dialog/dist/confirm-dialog-plugin6.zip" };
const envName = (name) => `PCA_TEST_${name.toUpperCase().replace(/-/g, "_")}_ZIP`;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Desktop と同じ形で起動して、クライアントで話す */
async function withServer(manifest, bundleDir, values, fn) {
  const fill = (s) => Object.entries(values).reduce((acc, [k, v]) => acc.replaceAll(k, v), s);
  const argv = manifest.server.mcp_config.args.map((a) => a.replace("${__dirname}", bundleDir));
  const env = { PATH: process.env.PATH ?? "" };
  for (const [k, v] of Object.entries(manifest.server.mcp_config.env)) env[k] = fill(v);
  const transport = new StdioClientTransport({ command: process.execPath, args: argv, env, cwd: path.parse(process.cwd()).root, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "mcpb-verify", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const seen = [];
  try {
    await fn(client, seen);
  } finally {
    await client.close();
  }
  return { argv, env, seen: seen.join("\n"), stderr };
}

async function verify(name) {
  const product = productOf(name);
  const tmp = path.join(root, ".tmp", "mcpb-verify", name);
  const ZIP = process.env[envName(name)] ?? path.resolve(root, TEST_ZIPS[name] ?? "");
  assert(TEST_ZIPS[name] !== undefined || process.env[envName(name)], `試験に使う zip の場所が決まっていない: ${name}（TEST_ZIPS に足す）`);
  assert(existsSync(ZIP), `${product.title}プラグインの zip が無い: ${ZIP}（${envName(name)} で指す）`);
  const out = outPath(name);
  const raw = readFileSync(out);
  const entries = readZip(out);
  assert(JSON.stringify([...entries.keys()].sort()) === JSON.stringify([...MCPB_FILES].sort()), `中身が違う: ${[...entries.keys()].join(", ")}`);
  const problems = problemsOf(entries);
  assert(!problems.length, `入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  assert(eol(entries.get(NOTICES_FILE).toString("utf8")) === eol(readFileSync(path.join(root, NOTICES_FILE), "utf8")), `${NOTICES_FILE} がリポジトリのものと違う`);

  const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  assert(manifest.manifest_version === "0.3", "manifest_version");
  assert(manifest.name === `${name}-authoring` && manifest.version === VERSION && path.basename(out) === mcpbName(name, manifest.version), `manifest の名前・版: ${manifest.name} ${manifest.version}`);
  assert(manifest.display_name.includes(product.title) && manifest.description.includes(product.title), "名前と説明に製品の名前（何の拡張機能かが分かる）");
  assert(manifest.icon === "icon.png" && entries.get("icon.png").subarray(1, 4).toString("latin1") === "PNG", "アイコンは PNG");
  assert(manifest.server?.type === "node" && manifest.server.entry_point === "server/index.cjs" && entries.has("server/index.cjs"), "server の形");
  assert(JSON.stringify(manifest.server.mcp_config.args) === JSON.stringify(["${__dirname}/server/index.cjs", "--plugin", name]), "起動のファイルと、製品の名前（--plugin）");
  const wantEnv = { PCA_WORKSPACE: "${user_config.workspaceDir}", [product.zipEnv]: "${user_config.pluginZip}", PCA_KINTONE_CONFIG: "${user_config.kintoneConfig}", PCA_KINTONE_PROFILE: "${user_config.kintoneProfile}" };
  assert(JSON.stringify(manifest.server.mcp_config.env) === JSON.stringify(wantEnv), `作業フォルダー・zip・接続のファイル・profile は env で渡す: ${JSON.stringify(manifest.server.mcp_config.env)}`);
  const uc = manifest.user_config;
  assert(JSON.stringify(Object.keys(uc).sort()) === JSON.stringify(["kintoneConfig", "kintoneProfile", "pluginZip", "workspaceDir"]), "設定項目は作業フォルダー・zip・接続のファイル・profile だけ");
  assert(uc.workspaceDir.type === "directory" && uc.workspaceDir.required === true, "workspaceDir は必須のフォルダー");
  assert(uc.pluginZip.type === "file" && uc.pluginZip.required === true && uc.pluginZip.title.includes(product.title), "pluginZip は必須のファイル（題に製品の名前）");
  assert(uc.kintoneConfig.type === "file" && uc.kintoneConfig.required === false, "kintoneConfig は任意のファイル");
  assert(uc.kintoneProfile.type === "string" && uc.kintoneProfile.required === false, "kintoneProfile は任意の文字");
  for (const [k, v] of Object.entries(uc)) assert(v.sensitive === undefined && !/token|password|username/i.test(k), `秘密の値を設定項目に持たない: ${k}`);
  assert(JSON.stringify(manifest.compatibility?.platforms) === JSON.stringify(["darwin", "win32"]), "platforms");
  assert(manifest.homepage === REPO_URL && manifest.repository?.type === "git" && manifest.repository.url === REPO_URL && manifest.support === SUPPORT_URL, "配布元（homepage、repository、support）");
  assert(JSON.stringify(manifest.privacy_policies) === JSON.stringify([PRIVACY_URL]) && existsSync(path.join(root, "PRIVACY.md")), "privacy_policies は PRIVACY.md の https の URL");
  assert(manifest.description.includes("レコードは読まない") === !product.simulate, "レコードを読む製品は「レコードは読まない」と書かない");

  rmSync(tmp, { recursive: true, force: true });
  const bundleDir = path.join(tmp, "bundle");
  for (const [p, data] of entries) {
    mkdirSync(path.dirname(path.join(bundleDir, p)), { recursive: true });
    writeFileSync(path.join(bundleDir, p), data);
  }
  const workspace = path.join(realpathSync(tmp), "workspace");
  mkdirSync(workspace, { recursive: true });
  const connFile = path.join(realpathSync(tmp), "ksql.config.json");
  const profile = (host) => ({ baseUrl: `https://${host}.cybozu.com`, tokenMap: { APP1001: TEST_TOKEN } });
  writeFileSync(connFile, JSON.stringify({ defaultProfile: "prod", profiles: { dev: profile("dev-x"), prod: profile("x") } }), { mode: 0o600 });

  let toolCount = 0;
  const text = (r) => r.content.map((c) => c.text).join("");
  const json = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  };
  // 設定を全部入れた形
  const full = await withServer(manifest, bundleDir, { "${user_config.workspaceDir}": workspace, "${user_config.pluginZip}": ZIP, "${user_config.kintoneConfig}": connFile, "${user_config.kintoneProfile}": "dev" }, async (client, seen) => {
    const call = async (tool, args = {}) => {
      const s = text(await client.callTool({ name: `${product.toolPrefix}_${tool}`, arguments: args }));
      seen.push(s);
      return json(s);
    };
    const instructions = String(client.getInstructions?.());
    seen.push(instructions);
    assert(instructions.includes(product.title), `指示に製品の名前: ${instructions.slice(0, 80)}`);
    const { tools } = await client.listTools();
    toolCount = tools.length;
    assert(JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(manifest.tools.map((t) => t.name)), `ツールの一覧が manifest と違う: ${tools.map((t) => t.name).join(", ")}`);
    const st = await call("status");
    assert(st.status === "ok" && st.plugin === name, `準備ができた: ${JSON.stringify(st).slice(0, 400)}`);
    assert(st.zip?.status === "ok" && st.zip.signed === true, `プラグインの zip を読めて、署名を確かめた: ${JSON.stringify(st.zip)}`);
    assert(st.kintone?.status === "ok" && st.kintone.profileSelection === "locked", `接続のファイルを読めて、profile は固定: ${JSON.stringify(st.kintone)}`);
    assert(!JSON.stringify(st).includes(connFile) && !JSON.stringify(st).includes(ZIP), "診断は接続のファイルと zip の場所を返さない");
    assert(typeof (await call("docs")) === "string", "資料の目次が読める");
    const made = await call("new", { file: `${name}-app1001.json`, app: 1001, appName: "受注" });
    assert(made.status === "saved" && existsSync(path.join(workspace, `${name}-app1001.json`)), `設定ファイルを作れる（本体・Worker・moment が動く）: ${JSON.stringify(made).slice(0, 300)}`);
    const other = await call("fields", { app: 1001, profile: "prod" });
    assert(other.status === "denied", `固定した profile と別の profile は断る: ${JSON.stringify(other).slice(0, 200)}`);
  });
  assert(!full.argv.some((a) => a.includes(TEST_TOKEN)) && !Object.values(full.env).some((v) => v.includes(TEST_TOKEN)), "引数と環境変数にトークンが無い（接続のファイルだけ）");
  assert(!full.seen.includes(TEST_TOKEN) && !full.stderr.includes(TEST_TOKEN), "応答と標準エラーにトークンが出ない");
  assert(!full.stderr.includes(connFile), "標準エラーに接続のファイルの場所が出ない");

  // 任意の設定を入れていない形（Desktop は、入れていない設定を ${user_config.…} のまま渡す）
  await withServer(manifest, bundleDir, { "${user_config.workspaceDir}": workspace, "${user_config.pluginZip}": ZIP }, async (client) => {
    const st = json(text(await client.callTool({ name: `${product.toolPrefix}_status`, arguments: {} })));
    assert(st.zip?.status === "ok", `接続のファイルが無くても zip は読める: ${JSON.stringify(st.zip)}`);
    assert(st.kintone?.status === "not-configured", `接続のファイルを入れていなければ not-configured: ${JSON.stringify(st.kintone)}`);
  });

  console.log(`[mcpb-verify] ok（${path.basename(out)}、${raw.length.toLocaleString()} bytes、ツール ${toolCount}、node ${process.version} で起動。Desktop の Node の版と画面は手で確かめる）`);
  console.log(`sha256 ${createHash("sha256").update(raw).digest("hex")}`);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : mcpbNames();
let failed = false;
for (const name of names) {
  try {
    await verify(name);
  } catch (e) {
    failed = true;
    console.error(`[mcpb-verify] ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (failed) process.exitCode = 1;
