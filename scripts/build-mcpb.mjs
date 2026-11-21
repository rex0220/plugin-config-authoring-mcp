// Claude Desktop の .mcpb を、製品ごとに作る（kSQL アクションのオーサリングの build-mcpb.mjs を元にした。正本は formula MCP）。
// 違いは、1 つの本体から製品ごとの .mcpb を作ること（起動の引数 --plugin <製品>。名前・ツールの頭・zip の環境変数は中核の表から）。
//   - 中身: manifest.json、icon.png、server/（束ねた本体と Worker の入口）、vendor/（moment）、LICENSE、THIRD_PARTY_NOTICES.md、短い README
//   - vendor/ は server/ の 1 つ上に置く（src/server.ts が「本体の 1 つ上の vendor/」を見る。Claude Code のプラグインの dist/server・dist/vendor と同じ並び）
//   - 設定項目: 作業フォルダー（directory、必須）、プラグインの zip（file、必須）、kintone の接続のファイル（file、任意）、使う profile（string、任意）
//   - 設定の値は引数でなく環境変数で渡す（mcp_config.env）。秘密の値は設定項目に持たない（接続のファイルの場所だけ）
//   - Claude Code のプラグインにあるフック（設定ファイルへの直接の書き込みを止める）は、Desktop には無い
//   - 入れてはいけないもの（scripts/forbidden-files.mjs）があれば作らない
// 使い方: npm run build && node scripts/build-mcpb.mjs [製品...]（省くと、アイコンのある製品の全部）→ dist-mcpb/<製品>-authoring-<版>.mcpb
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { problemsOf } from "./forbidden-files.mjs";
import { AUTHOR, kintoneTools, PRIVACY_URL, productNames, productOf, readsNote, REPO_URL, SUPPORT_URL } from "./products.mjs";
import { NOTICES_FILE } from "./third-party-notices.mjs";
import { createZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const outDir = path.join(root, "dist-mcpb");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
export const VERSION = pkg.version;

export const mcpbName = (name, version) => `${name}-authoring-${version}.mcpb`;
export const outPath = (name) => path.join(outDir, mcpbName(name, VERSION));

/** 束ねた本体（.mcpb の中のパス → リポジトリの中のパス） */
export const SERVER_FILES = {
  "server/index.cjs": "dist/server/index.cjs",
  "server/server.cjs": "dist/server/server.cjs",
  "server/generic-worker.mjs": "dist/server/generic-worker.mjs",
  "vendor/moment-with-locales.min.js": "dist/vendor/moment-with-locales.min.js",
  "vendor/moment.json": "dist/vendor/moment.json"
};
export const MCPB_FILES = ["manifest.json", "icon.png", ...Object.keys(SERVER_FILES), "LICENSE", NOTICES_FILE, "README.md"];

/** .mcpb を作れる製品（アイコンがあるもの） */
export const mcpbNames = () => productNames().filter((n) => productOf(n).icon);

/**
 * Desktop の拡張機能の画面に出すツールの一覧（短い説明。AI に渡る説明は本体の tools/list）。
 * 並びは本体の tools/list と同じ（scripts/mcpb-verify.mjs が照合する）
 */
export function manifestTools(p) {
  const t = (name, description) => ({ name: `${p.toolPrefix}_${name}`, description });
  return [
    t("status", "準備の診断（MCP の版、プラグインの zip、kintone の接続）"),
    t("docs", `${p.title}の設定づくりの手順と、設定ファイルの書き方`),
    t("files", "作業フォルダーの JSON の一覧"),
    t("fields", "アプリの項目定義と一覧（GET だけ）"),
    t("new", "設定ファイルを新しく作る（空、または設定画面でダウンロードしたファイルから。上書きしない）"),
    t("read", "設定ファイルを読む（要約・行・行の外の設定・行の雛形）"),
    t("update", "設定ファイルを直す（読んだときの digest を照合）"),
    t("diff", "2 つの設定ファイルの差分"),
    t("check", "kintone の今の項目定義で検査する（設定画面と同じ決まり）"),
    t("export", "検査を通った設定から、設定画面で取り込むファイルを作る（上書きしない）"),
    ...(p.simulate ? [t("try", "設定ファイルにレコードを当てて、どの条件が選ばれるかを確かめる（GET だけ。読んだレコードそのものは返さない）")] : [])
  ];
}

/** manifest.json */
export function manifestOf(name, version) {
  const p = productOf(name);
  return {
    manifest_version: "0.3",
    name: `${p.name}-authoring`,
    display_name: `${p.title} 設定オーサリング`,
    version,
    description: `kintone の${p.title}プラグイン（rex0220。Ver.${p.minPluginVersion} 以降）の設定を、設定画面と同じ検査を通して作る・直す。${readsNote(p)}。取り込みと保存は利用者が設定画面で行う`,
    author: { name: AUTHOR },
    license: "MIT",
    // 拡張機能の一覧のアイコン。指定しないと display_name の先頭 1 文字になる（白地に 1 文字。角丸の枠は Desktop が描く）
    icon: "icon.png",
    homepage: REPO_URL,
    repository: { type: "git", url: REPO_URL },
    support: SUPPORT_URL,
    privacy_policies: [PRIVACY_URL],
    server: {
      type: "node",
      entry_point: "server/index.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.cjs", "--plugin", p.name],
        env: {
          PCA_WORKSPACE: "${user_config.workspaceDir}",
          [p.zipEnv]: "${user_config.pluginZip}",
          PCA_KINTONE_CONFIG: "${user_config.kintoneConfig}",
          PCA_KINTONE_PROFILE: "${user_config.kintoneProfile}"
        }
      }
    },
    tools: manifestTools(p),
    tools_generated: false,
    keywords: p.keywords,
    compatibility: {
      claude_desktop: ">=0.10.0",
      platforms: ["darwin", "win32"],
      runtimes: { node: ">=20.0.0" }
    },
    user_config: {
      workspaceDir: {
        type: "directory",
        title: "作業フォルダー",
        description: `${p.title}の設定ファイルと、設定画面で取り込むファイルを置くフォルダー（空のフォルダーでよい）`,
        required: true
      },
      pluginZip: {
        type: "file",
        title: `${p.title}プラグインの zip`,
        description: `アプリに入れた${p.title}プラグイン（Ver.${p.minPluginVersion} 以降。試用版でよい）の zip（配布元から入手したもの。同じ版）。設定の検査は、この zip から読む`,
        required: true
      },
      kintoneConfig: {
        type: "file",
        title: "kintone の接続のファイル",
        description: `接続先と認証を書いた JSON（kSQL の ksql.config.json と同じ形。作業フォルダーの外に置く）。無ければ kintone を使うツール（${kintoneTools(p)}）は使えない`,
        required: false
      },
      kintoneProfile: {
        type: "string",
        title: "使う接続の profile（省略可）",
        description: "接続のファイルの中の profile の名前。書くと、その profile だけを使う（本番の profile が同じファイルにあるときに書く）。空なら接続のファイルの defaultProfile",
        required: false
      }
    }
  };
}

const readmeOf = (name, version) => {
  const p = productOf(name);
  return `# ${p.title} 設定オーサリング ${version}（Claude Desktop の拡張機能）

kintone の${p.title}プラグイン（rex0220。Ver.${p.minPluginVersion} 以降）の設定を、設定画面と同じ検査を通して作る・直す Claude Desktop の拡張機能。
チャットで「${p.title}の設定を作って」と頼む（手順と設定の形は ${p.toolPrefix}_docs、準備の状態は ${p.toolPrefix}_status）。
${readsNote(p)}。設定の取り込みと保存は利用者が kintone の設定画面で行う。
同梱の依存の著作権表示とライセンスは ${NOTICES_FILE} にある。
プライバシーポリシー、セキュリティ、変更履歴: ${REPO_URL}
`;
};

/** .mcpb の中身。ファイルの欠け・入れてはいけないものがあれば止める */
export function mcpbEntries(name) {
  const p = productOf(name);
  if (!p.icon) throw new Error(`アイコンが無い: ${name}（scripts/products.mjs の TEXTS の icon）`);
  const need = [p.icon, ...Object.values(SERVER_FILES), "LICENSE", NOTICES_FILE, "PRIVACY.md"];
  const missing = need.filter((f) => !existsSync(path.join(root, f)));
  if (missing.length) throw new Error(`無いファイル（先に npm run build）: ${missing.join(", ")}`);
  const entries = [
    { path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifestOf(name, VERSION), null, 2)}\n`, "utf8") },
    { path: "icon.png", data: readFileSync(path.join(root, p.icon)) },
    ...Object.entries(SERVER_FILES).map(([to, from]) => ({ path: to, data: readFileSync(path.join(root, from)) })),
    { path: "LICENSE", data: readFileSync(path.join(root, "LICENSE")) },
    { path: NOTICES_FILE, data: readFileSync(path.join(root, NOTICES_FILE)) },
    { path: "README.md", data: Buffer.from(readmeOf(name, VERSION), "utf8") }
  ];
  const problems = problemsOf(entries.map((e) => [e.path, e.data]));
  if (problems.length) throw new Error(`入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  return entries;
}

function isIgnored() {
  const p = path.join(root, ".gitignore");
  const lines = existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/).map((l) => l.trim()) : [];
  return lines.includes("dist-mcpb/") && lines.includes("*.mcpb");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!isIgnored()) throw new Error(".gitignore に dist-mcpb/ と *.mcpb が無い（成果物をコミットしない）");
  const names = process.argv.slice(2).length ? process.argv.slice(2) : mcpbNames();
  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    const zip = createZip(mcpbEntries(name));
    writeFileSync(outPath(name), zip);
    console.log(`[build-mcpb] ${path.relative(root, outPath(name))} (${zip.length.toLocaleString()} bytes; 版 ${VERSION})`);
  }
}
