// 製品ごとの配布の定義（Claude Code のプラグイン）。**コードは 1 つ、名前は製品ごと**なので、
// プラグインの定義（.claude-plugin/plugin.json）と起動の設定（.mcp.json）は、ここの表から製品ごとに作る（リポジトリには置かない）。
//   - 製品の名前（--plugin の値）・ツールの頭・zip の環境変数・扱う版は中核の表（@rex0220/formula-authoring-tools/generic の GENERIC_PLUGINS）から取る
//   - ここに書くのは、利用者に見せる文と検索の語だけ
//   - Claude Code のプラグインの名前と MCP サーバーの名前は、製品の名前（aggregate → ツールは mcp__plugin_aggregate_aggregate__agg_*）
// 製品を足すとき: 中核の表に 1 行 → ここに 1 つ → guide/<製品>/ と src/docs.ts（CLAUDE.md の「製品を足すとき」）
import { GENERIC_PLUGINS } from "@rex0220/formula-authoring-tools/generic";

export const REPO_URL = "https://github.com/rex0220/plugin-config-authoring-mcp";
export const AUTHOR = "rex0220";
/** marketplace（.claude-plugin/marketplace.json）の名前。入れ方は /plugin install <製品>@<この名前>（2026-11-22 Takashi。公開の後は変えない） */
export const MARKETPLACE_NAME = "rex0220-plugin-authoring";
/** プライバシーポリシーと問い合わせ先（plugin.json と .mcpb の manifest に書く。kintone に接続するので要る） */
export const PRIVACY_URL = `${REPO_URL}/blob/main/PRIVACY.md`;
export const SUPPORT_URL = `${REPO_URL}/issues`;

/** 利用者に見せる文（製品ごと） */
const TEXTS = {
  // released: 配布する（marketplace とリリースに出す）か。kintone のプラグインの対応の版がリリースされてから true にする
  // （アプリ集計は Ver.67 のリリースのときに。2026-11-22 Takashi「項目書式だけ」）。false でも、ビルド・試験・zip の検査は通す
  // icon: Claude Desktop の拡張機能の一覧のアイコン（白地に 1 文字。無いと display_name の先頭の字になる）
  aggregate: {
    keywords: ["kintone", "アプリ集計", "aggregate", "mcp"],
    released: false,
    icon: null
  },
  "field-format": {
    keywords: ["kintone", "項目書式", "field-format", "mcp"],
    released: true,
    icon: "assets/icon-field-format.png"
  }
};

/**
 * 製品の定義（中核の表 + ここの文）
 * @param {string} name 製品の名前（--plugin の値）
 */
export function productOf(name) {
  const core = GENERIC_PLUGINS[name];
  const text = TEXTS[name];
  if (!core || !text) throw new Error(`製品の定義が無い: ${name}（中核の表と scripts/products.mjs の TEXTS の両方に要る。ある名前: ${Object.keys(TEXTS).join(", ")}）`);
  return { name: core.name, title: core.title, toolPrefix: core.toolPrefix, zipEnv: core.zipEnv, minPluginVersion: core.minPluginVersion, simulate: core.simulate === true, ...text };
}

/**
 * kintone を読むツールの名前（接続のファイルが無いと使えないもの）。模擬のある製品は <頭>_try も読む
 * （自分で書いたレコードだけを当てるときも、項目定義は読む）
 */
export const kintoneTools = (p) => ["fields", "pull", "check", ...(p.simulate ? ["try"] : []), "export"].map((t) => `${p.toolPrefix}_${t}`).join(" / ");

/**
 * kintone から何を読むかの文。**模擬のある製品は、<頭>_try が指定されたレコードを読む**ので「レコードは読まない」と書かない
 * （2026-11-22。項目書式の配布物の README が「レコードは読まない」のままだった）
 */
export const readsNote = (p) =>
  p.simulate
    ? `kintone には読み取り（GET）だけ。レコードを読むのは ${p.toolPrefix}_try（指定されたレコードを当てて確かめる）だけで、読んだレコードそのものは返さない`
    : "kintone には読み取り（GET）だけで、レコードは読まない";

/**
 * 配布する製品の名前。**中核の表とここの TEXTS は同じ製品を持つ**（片方だけに書くと、その製品がビルドと試験から黙って消える）ので、
 * ずれていれば止める（zip を作るとき・marketplace を書くとき・試験）
 */
export function productNames() {
  const problems = productMismatch();
  if (problems.length) throw new Error(`製品の定義がそろっていない:\n  ${problems.join("\n  ")}`);
  return Object.keys(TEXTS);
}

/** 中核の表と TEXTS のずれ（無ければ空） */
export function productMismatch(core = GENERIC_PLUGINS, texts = TEXTS) {
  return [
    ...Object.keys(core).filter((n) => !texts[n]).map((n) => `${n}: 中核の表にあるが、scripts/products.mjs の TEXTS に無い（配布されない）`),
    ...Object.keys(texts).filter((n) => !core[n]).map((n) => `${n}: scripts/products.mjs の TEXTS にあるが、中核の表に無い`)
  ];
}

/** 配布する製品（marketplace・リリース・.mcpb）。**ここに無い製品を marketplace に並べない**（対応の版の zip を利用者が持てない） */
export const releasedNames = () => productNames().filter((n) => TEXTS[n].released === true);

export const zipName = (name, version) => `${name}-authoring-plugin-${version}.zip`;

export const describe = (p) =>
  `kintone の${p.title}プラグイン（rex0220）の設定を、設定画面と同じ検査を通して作る・直す（${p.toolPrefix}_* のツールと、設定ファイルへの直接の書き込みを止めるフック）。kintone には読み取りだけ。取り込みと保存は利用者が設定画面で行う`;

/** .claude-plugin/plugin.json */
export function pluginJson(name, version) {
  const p = productOf(name);
  return {
    name: p.name,
    version,
    description: describe(p),
    author: { name: AUTHOR },
    homepage: REPO_URL,
    repository: REPO_URL,
    license: "MIT",
    keywords: p.keywords,
    privacyPolicyUrl: PRIVACY_URL,
    supportUrl: SUPPORT_URL,
    userConfig: {
      pluginZip: {
        type: "string",
        title: `${p.title}プラグインの zip`,
        description: `アプリに入れた${p.title}プラグイン（Ver.${p.minPluginVersion} 以降。試用版でよい）の zip の絶対パス。設定の検査と保存する値の組み立ては、この zip から読む（設定画面と同じ決まり）`,
        required: false
      },
      kintoneConfig: {
        type: "string",
        title: `${p.title}の設定づくりの接続のファイル（kintone）`,
        description: `kSQL の ksql.config.json と同じ形のファイルの絶対パス（作業フォルダーの外に置く。kSQL と同じファイルでもよい）。空なら kintone を使うツール（${kintoneTools(p)}）は使えない`,
        required: false
      },
      kintoneProfile: {
        type: "string",
        title: `${p.title}の設定づくりで使う接続の profile（省略可）`,
        description: "接続のファイルの中の profile の名前。書くと、その profile だけを使う（ほかの profile を指す呼び出しは断る。本番の profile が同じファイルにあるときに書く）。空なら接続のファイルの defaultProfile",
        required: false
      },
      workspace: {
        type: "string",
        title: `${p.title}の設定づくりの作業フォルダー（省略可）`,
        description: "設定ファイルを置くフォルダーの絶対パス。空なら Claude Code を起動したフォルダー（ふつうは空のままでよい。別の所にすると、直接の書き込みを止めるフックは届かない）",
        required: false
      }
    }
  };
}

/** .mcp.json（本体は zip の中。zip・接続のファイル・profile・作業フォルダーは env で渡す。引数に入れない） */
export function mcpJson(name) {
  const p = productOf(name);
  return {
    mcpServers: {
      [p.name]: {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/dist/server/index.cjs", "--plugin", p.name],
        env: {
          [p.zipEnv]: "${user_config.pluginZip}",
          PCA_KINTONE_CONFIG: "${user_config.kintoneConfig}",
          PCA_KINTONE_PROFILE: "${user_config.kintoneProfile}",
          PCA_WORKSPACE: "${user_config.workspace}"
        }
      }
    }
  };
}

/** zip に入れる短い README */
export function readmeOf(name, version, noticesFile) {
  const p = productOf(name);
  return `# ${p.name} ${version}（Claude Code のプラグイン）

kintone の${p.title}プラグイン（rex0220。Ver.${p.minPluginVersion} 以降）の設定を、設定画面と同じ検査を通して作る・直す Claude Code のプラグイン（${p.toolPrefix}_* のツールと、設定ファイルへの直接の書き込みを止めるフック）。${readsNote(p)}。設定の取り込みと保存は利用者が kintone の設定画面で行う。

- 設定: \`/plugin configure ${p.name}@${MARKETPLACE_NAME}\` で、${p.title}プラグインの zip と kintone の接続のファイル（本番の profile が同じファイルにあるなら、使う profile も）
- 使い方: 「${p.title}の設定を作って」と頼む。手順と設定の形は ${p.toolPrefix}_docs、準備の状態は ${p.toolPrefix}_status
- リポジトリ: ${REPO_URL}
- 同梱の依存の著作権表示とライセンス: ${noticesFile}
`;
}
