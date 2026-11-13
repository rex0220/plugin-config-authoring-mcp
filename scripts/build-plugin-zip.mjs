// Claude Code のプラグインの zip を、製品ごとに作る（kSQL アクションのオーサリングの scripts/build-plugin-zip.mjs を元にした）。
//   - 中身はプラグインに要るものだけ: .claude-plugin/plugin.json と .mcp.json（scripts/products.mjs が製品ごとに作る）、
//     hooks/（試験と tsconfig を除く）、dist/server/、dist/vendor/、LICENSE、THIRD_PARTY_NOTICES.md、短い README。プラグインの root は zip のいちばん上
//   - package.json と lockfile は入れない（Claude Code が依存を入れようとしない。本体は束ねてある）
//   - 名前は <製品>-authoring-plugin-<版>.zip（kintone のプラグインの zip〈aggregate-plugin67.zip など〉と混ざらないようにする）
//   - 入れてはいけないもの（scripts/forbidden-files.mjs）があれば作らない
//   - 展開した形も dist-plugin/<製品>/ に置く（claude --plugin-dir dist-plugin/<製品> で試せる）
// 使い方: npm run build && node scripts/build-plugin-zip.mjs [製品...]（省くと全部）→ dist-plugin/<製品>-authoring-plugin-<版>.zip
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { problemsOf } from "./forbidden-files.mjs";
import { mcpJson, pluginJson, productNames, readmeOf, zipName } from "./products.mjs";
import { NOTICES_FILE } from "./third-party-notices.mjs";
import { createZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const outDir = path.join(root, "dist-plugin");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
export const VERSION = pkg.version;

/** リポジトリからそのまま入れるファイル（zip の中のパス = リポジトリの中のパス） */
export const COPIED_FILES = [
  "hooks/hooks.json",
  "hooks/register.ts",
  "dist/server/index.cjs",
  "dist/server/server.cjs",
  "dist/server/generic-worker.mjs",
  "dist/vendor/moment-with-locales.min.js",
  "dist/vendor/moment.json",
  "LICENSE",
  NOTICES_FILE
];
/** 製品ごとに作るファイル */
export const GENERATED_FILES = [".claude-plugin/plugin.json", ".mcp.json", "README.md"];

export const outPath = (name) => path.join(outDir, zipName(name, VERSION));
export const unpackedDir = (name) => path.join(outDir, name);

const json = (v) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, "utf8");

/** zip の中身。ファイルの欠け・入れてはいけないものがあれば止める */
export function pluginEntries(name) {
  const missing = COPIED_FILES.filter((f) => !existsSync(path.join(root, f)));
  if (missing.length) throw new Error(`無いファイル（先に npm run build）: ${missing.join(", ")}`);
  const entries = [
    { path: ".claude-plugin/plugin.json", data: json(pluginJson(name, VERSION)) },
    { path: ".mcp.json", data: json(mcpJson(name)) },
    ...COPIED_FILES.map((f) => ({ path: f, data: readFileSync(path.join(root, f)) })),
    { path: "README.md", data: Buffer.from(readmeOf(name, VERSION, NOTICES_FILE), "utf8") }
  ];
  const problems = problemsOf(entries.map((e) => [e.path, e.data]));
  if (problems.length) throw new Error(`入れてはいけないもの:\n  ${problems.join("\n  ")}`);
  return entries;
}

function isIgnored() {
  const p = path.join(root, ".gitignore");
  return existsSync(p) && readFileSync(p, "utf8").split(/\r?\n/).some((l) => l.trim() === "dist-plugin/");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!isIgnored()) throw new Error(".gitignore に dist-plugin/ が無い（成果物をコミットしない）");
  const names = process.argv.slice(2).length ? process.argv.slice(2) : productNames();
  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    const entries = pluginEntries(name);
    const zip = createZip(entries);
    rmSync(unpackedDir(name), { recursive: true, force: true });
    for (const e of entries) {
      const to = path.join(unpackedDir(name), e.path);
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, e.data);
    }
    writeFileSync(outPath(name), zip);
    console.log(`[build-plugin-zip] ${path.relative(root, outPath(name))} (${zip.length.toLocaleString()} bytes; 版 ${VERSION})、展開した形 ${path.relative(root, unpackedDir(name))}/`);
  }
}
