/** 資料（<頭>_docs）。build.mjs が guide/<プラグイン>/ の本文を __PCA_DOCS__ に埋め込む。ソースから動かすときは guide/ を読む */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const __PCA_DOCS__: string | undefined;

export interface DocSection { key: string; title: string; text: string }

/** プラグインごとの資料の並び（キーと題。本文は guide/<プラグイン>/<キー>.md） */
export const DOC_LIST: Record<string, Array<{ key: string; title: string }>> = {
  aggregate: [
    { key: "howto", title: "作業手順（新しく作る・今の設定を直す・最後に伝えること）" },
    { key: "spec", title: "設定ファイルの書き方（行・行の外の設定・式を書く場所と使える項目・検査の指摘）" }
  ],
  "field-format": [
    { key: "howto", title: "作業手順（新しく作る・今の設定を直す・レコードを当てて確かめる・最後に伝えること）" },
    { key: "spec", title: "設定ファイルの書き方（項目の行・条件・色と文字・一覧別設定・式の書き方と落とし穴・検査の指摘・模擬の結果の読み方）" }
  ]
};

function load(): Record<string, DocSection[]> {
  if (typeof __PCA_DOCS__ === "string") return JSON.parse(__PCA_DOCS__) as Record<string, DocSection[]>;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "guide");
  const out: Record<string, DocSection[]> = {};
  for (const [plugin, list] of Object.entries(DOC_LIST)) {
    out[plugin] = list.map((d) => {
      const f = path.join(root, plugin, `${d.key}.md`);
      return { ...d, text: existsSync(f) ? readFileSync(f, "utf8") : "" };
    });
  }
  return out;
}

export const DOCS: Record<string, DocSection[]> = load();

export function docIndex(plugin: string, prefix: string): string {
  const list = DOCS[plugin] ?? [];
  return [`資料の目次（${prefix}_docs の section に、左のキーを渡す）`, ...list.map((d) => `- ${d.key}: ${d.title}`)].join("\n");
}
