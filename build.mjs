// MCP を esbuild で束ねる（formula MCP の build-mcp.mjs と同じ考え方）。
//   dist/server/server.cjs        本体（中核 @rex0220/formula-authoring-tools/generic、MCP の SDK、zod、happy-dom を束ねる）
//   dist/server/index.cjs         起動のファイル（main を呼ぶ）
//   dist/server/generic-worker.mjs  プラグインの zip のコードを動かす Worker の入口（中核の dist/generic-worker.mjs を happy-dom ごと束ねた ESM）
//   dist/vendor/                  中核が読む moment（と、その出どころの控え moment.json）
//   THIRD_PARTY_NOTICES.md        束ねた依存の著作権表示がリポジトリのものと同じか（違えば止める。--write-notices で書き直す）
// プラグインのコード（計算式エンジンと authoring API）は束ねない（利用者のプラグインの zip から読む）。資料（guide/）は本体に埋め込む
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const toolsDir = path.join(root, "node_modules", "@rex0220", "formula-authoring-tools");
const tools = JSON.parse(readFileSync(path.join(toolsDir, "package.json"), "utf8"));
const { bundledPackages, eol, NOTICES_FILE, renderNotices, vendorMoment } = await import(pathToFileURL(path.join(root, "scripts", "third-party-notices.mjs")).href);
const { DOC_LIST } = await import(pathToFileURL(path.join(root, "src", "docs.ts")).href);

const docs = {};
for (const [plugin, list] of Object.entries(DOC_LIST)) {
  docs[plugin] = list.map((d) => ({ ...d, text: readFileSync(path.join(root, "guide", plugin, `${d.key}.md`), "utf8") }));
}

rmSync(dist, { recursive: true, force: true });
const leaked = (inputs) => inputs.filter((p) => /kintone-plugin[\\/](aggregate|data-generator|formula)[\\/](src|prod|lib)[\\/]|plugin-config-kit[\\/]src|rexgrid[\\/]src/.test(p));
const note = `rex0220 plugin-config-authoring MCP ${pkg.version}（中核 @rex0220/formula-authoring-tools ${tools.version}）。MIT License. プラグインのコード（計算式エンジンと authoring API）は利用者のプラグインの zip から読む（このファイルには含まれない）`;

const worker = await build({
  entryPoints: [path.join(toolsDir, "dist", "generic-worker.mjs")],
  outfile: path.join(dist, "server", "generic-worker.mjs"),
  bundle: true, format: "esm", platform: "node", target: "node20", charset: "utf8", legalComments: "eof",
  external: ["bufferutil", "utf-8-validate"],
  // 束ねた CJS の依存（happy-dom など）が Node の組み込みを require するので、ESM でも require を使えるようにする
  banner: { js: `/*! ${note} */\nimport { createRequire as __pca_createRequire } from "node:module";\nconst require = __pca_createRequire(import.meta.url);` },
  absWorkingDir: root, metafile: true, logLevel: "warning"
});
if (leaked(Object.keys(worker.metafile.inputs)).length) throw new Error(`Worker にプラグイン / kit / rexgrid のコードが入っている:\n  ${leaked(Object.keys(worker.metafile.inputs)).join("\n  ")}`);

const server = await build({
  entryPoints: [path.join(root, "src", "server.ts")],
  outfile: path.join(dist, "server", "server.cjs"),
  bundle: true, format: "cjs", platform: "node", target: "node20", charset: "utf8", legalComments: "eof",
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: `/*! ${note} */\nvar __pca_import_meta_url = require("node:url").pathToFileURL(__filename).href;` },
  define: { __PCA_VERSION__: JSON.stringify(pkg.version), __PCA_DOCS__: JSON.stringify(JSON.stringify(docs)), "import.meta.url": "__pca_import_meta_url" },
  absWorkingDir: root, metafile: true, logLevel: "warning"
});
if (leaked(Object.keys(server.metafile.inputs)).length) throw new Error(`本体にプラグイン / kit / rexgrid のコードが入っている:\n  ${leaked(Object.keys(server.metafile.inputs)).join("\n  ")}`);

writeFileSync(path.join(dist, "server", "index.cjs"), `/*! ${note} */\nrequire("./server.cjs").main(process.argv.slice(2), __dirname).catch((e) => { process.stderr.write(String(e && e.message ? e.message : e) + "\\n"); process.exit(1); });\n`);
mkdirSync(path.join(dist, "vendor"), { recursive: true });
for (const f of ["moment-with-locales.min.js", "moment.json"]) copyFileSync(path.join(toolsDir, "vendor", f), path.join(dist, "vendor", f));

const notices = renderNotices(
  bundledPackages(root, [{ label: "本体", metafile: server.metafile }, { label: "Worker", metafile: worker.metafile }]),
  vendorMoment(path.join(toolsDir, "vendor", "moment.json"))
);
const noticesPath = path.join(root, NOTICES_FILE);
if (process.argv.includes("--write-notices")) {
  writeFileSync(noticesPath, notices);
  console.log(`${NOTICES_FILE} を書き直した`);
} else if (!existsSync(noticesPath) || eol(readFileSync(noticesPath, "utf8")) !== notices) {
  throw new Error(`${NOTICES_FILE} が束ねた依存と合わない（npm run notices で作り直し、差分を確かめてコミットする）`);
}
const size = (f) => readFileSync(path.join(dist, "server", f)).length.toLocaleString();
console.log(`wrote dist/server/server.cjs (${size("server.cjs")} bytes), generic-worker.mjs (${size("generic-worker.mjs")} bytes), index.cjs, dist/vendor/moment（MCP ${pkg.version}、中核 ${tools.version}）`);
