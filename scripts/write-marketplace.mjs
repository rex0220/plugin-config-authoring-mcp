// .claude-plugin/marketplace.json を書く（GitHub のリリースに製品ごとのプラグインの zip を置いた後）。
// **kSQL アクションのオーサリングの scripts/write-marketplace.mjs を元にした**（正本は formula MCP）。違いは、1 つの marketplace に製品ごとのプラグインを並べること。
//   - プラグインの source は archive（GitHub のリリースの zip の URL と sha256）。sha256 は手元の zip から作る（リリースに置いたものと同じ zip）
//   - 版は書かない（plugin.json の版が使われる。両方に書くと食い違いの警告）
//   - archive の source では、入れる前に利用者に見えるのは marketplace の項目だけなので、説明・作者・配布元・ライセンス・キーワードを zip の中の plugin.json から写す
//   - **リリースにファイルを置いてから**書き換えて push する（逆だと、入れられない時間ができる）。リポジトリが private の間は利用者が取れない
// 使い方: npm run verify:plugin → リリースに zip を置く → node scripts/write-marketplace.mjs（dist-plugin/ の、配布する製品の zip を読む）→ claude plugin validate .
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { outPath, VERSION } from "./build-plugin-zip.mjs";
import { AUTHOR, MARKETPLACE_NAME, productOf, releasedNames, REPO_URL, zipName } from "./products.mjs";
import { readZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** GitHub のリリースの zip を指す archive の source */
export function archiveSource(name, version, sha256) {
  return { source: "archive", url: `${REPO_URL}/releases/download/v${version}/${zipName(name, version)}`, sha256 };
}

/**
 * marketplace.json の中身
 * @param {{ plugin: Record<string, any>, sha256: string }[]} items 製品ごとの、zip の中の plugin.json と zip の sha256
 */
export function marketplace(items) {
  const pick = ["description", "author", "homepage", "repository", "license", "keywords"];
  return {
    name: MARKETPLACE_NAME,
    description: `rex0220 の kintone プラグイン（${items.map((i) => productOf(i.plugin.name).title).join("、")}）の設定を、Claude Code で作る・直す`,
    owner: { name: AUTHOR, url: `https://github.com/${AUTHOR}` },
    plugins: items.map(({ plugin, sha256 }) => ({
      name: plugin.name,
      ...Object.fromEntries(pick.filter((k) => plugin[k] !== undefined).map((k) => [k, plugin[k]])),
      source: archiveSource(plugin.name, plugin.version, sha256)
    }))
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 並べるのは配布する製品だけ（scripts/products.mjs の released）
  const items = releasedNames().map((name) => {
    const file = outPath(name);
    if (!existsSync(file)) throw new Error(`zip が無い: ${file}（先に npm run verify:plugin）`);
    const zip = readFileSync(file);
    const plugin = JSON.parse(readZip(zip).get(".claude-plugin/plugin.json").toString("utf8"));
    if (plugin.name !== name || plugin.version !== VERSION) throw new Error(`zip の中の plugin.json が合わない: ${plugin.name} ${plugin.version}（${name} ${VERSION} のはず）`);
    return { plugin, sha256: createHash("sha256").update(zip).digest("hex") };
  });
  const out = path.join(root, ".claude-plugin", "marketplace.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(marketplace(items), null, 2)}\n`);
  console.log(`[write-marketplace] ${out}（${items.map((i) => `${i.plugin.name} ${i.plugin.version} sha256 ${i.sha256}`).join("、")}）`);
}
