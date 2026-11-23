/**
 * <頭>_try（レコードを当てて確かめる）の、製品ごとの定義。
 *
 * レコードの渡し方（ids / query / records）と、検査を先に通す・結果の上限・読んだレコードを返さない、はどの製品も同じ（server.ts）。
 * 製品ごとに違うのは「何を当てて、何が返るか」: プラグインの authoring API の simulate に渡す入力（レコード以外）と、答えの形。
 * 契約の版 1 では simulate の入力と答えは自由な JSON なので、**入力の形（AI に見せる説明と、受ける前の検査）をここに書く**
 * （2026-11-23 Takashi。項目書式の形〈screens / fields / probes → records〉に決め打ちだったのを、製品ごとに分けた）。
 * 中身の検査（項目があるか・場面の組み合わせ）はプラグインの API が行う。ここは形と上限だけ。
 *
 * 模擬のある製品（中核の表の simulate）を足すときは、ここに 1 つ書く（無いと、サーバーの起動で止まる）。
 */
import { z } from "zod";

export interface TryDef {
  /** 何を確かめるツールか（説明の先頭の文） */
  about: string;
  /** 何が返るか（「読んだレコードそのものは返さない。」に続く文） */
  returns: string;
  /** 説明の末尾に足す文（製品ごとの入力の使い方、評価のしかた） */
  more: readonly string[];
  /** 製品ごとの入力（レコードの渡し方以外）。プラグインの simulate に、書かれたものだけをそのまま渡す */
  options: Record<string, z.ZodTypeAny>;
  /** プラグインの答えのうち、結果の入るキー（配列）。無ければ、指定の誤りで模擬していない */
  resultKey: string;
  /** レコードを読んだ後に、プラグインの API が入力を断ったときに伝える文 */
  invalidMessage: string;
  /** 結果が大きすぎるときの絞り方 */
  narrow: string;
  /** 答えに添える注記（どう評価したか・確かめていないこと） */
  note: string;
  /** サーバーの指示に入れる 1 行（何を、このツールで確かめるか） */
  instruction: (tool: string, check: string) => string;
}

const FF_SCREENS = ["detail", "print", "list", "mobileDetail", "mobileList"] as const;

const FIELD_FORMAT: TryDef = {
  about: "設定ファイルにレコードを当てて、どの条件が選ばれるかを確かめる（模擬。kintone には書かない）。設定ファイルに error があれば、指摘だけを返す。",
  returns: "返すのは、レコードごと・画面ごと・項目ごとに選ばれた条件の番号（1 始まり。0 = どれも付かない）と、条件ごとの評価（真の数・例外の数・式の結果の例）。設定の行が多いときは fields で項目を絞る。",
  more: [
    "probes に式を渡すと、設定に入れずにその式の値を見られる（項目の今の値、書く前の式の結果）。",
    "式の中の今日の日付はツールを動かした日、ログインユーザーはツールの既定の利用者で評価する。"
  ],
  options: {
    screens: z.array(z.enum(FF_SCREENS)).min(1).max(FF_SCREENS.length).optional().describe("確かめる画面（省略すると detail と list）。detail = PC の詳細、print = 印刷、list = PC の一覧、mobileDetail / mobileList = モバイル"),
    fields: z.array(z.string().min(1).max(256)).min(1).max(100).optional().describe("答えをこの項目コードだけに絞る（設定の行が多いとき。省略すると全部）"),
    probes: z.array(z.object({ formula: z.string().min(1).max(2000).describe("値を見たい式（項目の今の値を見るなら、項目コードだけを書く）"), field: z.string().max(256).optional().describe("その項目の値の書式の条件として評価する（テーブルの中の項目・テーブルなら行ごと）。省略するとレコードに 1 回") })).min(1).max(10).optional().describe("設定に入れずに、式の値だけを見る（10 個まで）。条件を書く前に、項目の値の形や式の結果を確かめるとき。設定ファイルを試しに書き換えない")
  },
  resultKey: "records",
  invalidMessage: "fields・probes・screens の指定を直してからやり直す（模擬の結果は返していない。レコードは読んだ）",
  narrow: "fields で確かめる項目を絞る、screens を 1 つにする、レコードを減らす、のどれかでやり直す",
  note: "渡したレコードで、レコード画面と同じ順に式を評価した。今日の日付はツールを動かした日、ログインユーザーはツールの既定の利用者。画面の見え方（要素に書式が付くこと）までは確かめていない",
  instruction: (tool, check) => `- 式の検査（${check}）は架空のレコードでの評価（文法と、項目があるかまで）。**条件が思ったとおりに選ばれるかは ${tool} で、レコードを当てて確かめる**（利用者に、確かめるレコードの番号か条件を聞く。真になる例とならない例の両方を当てる）`
};

/** 確認ダイアログの場面の数（プラグインの API の上限と同じ） */
const CD_MAX_SCENES = 10;
const cdAction = z.object({
  name: z.string().min(1).max(200).describe("アクション名（プロセス管理の既定の名称）"),
  from: z.string().min(1).max(200).describe("実行する前のステータス（既定の名称）"),
  to: z.string().min(1).max(200).describe("実行した後のステータス（既定の名称）")
});
const cdScene = z.object({
  event: z.enum(["create", "update", "index", "process", "button"]).describe("create = 追加の画面の保存 / update = 編集の画面の保存 / index = 一覧での編集の保存 / process = プロセス管理のアクションの実行 / button = ボタンクリックの行のボタン"),
  action: cdAction.optional().describe("event が process のとき（必須）。実行するアクション"),
  screen: z.enum(["detail", "create", "update"]).optional().describe("event が button のとき（必須）。ボタンを出す画面（detail = 詳細、create = 追加、update = 編集）"),
  lang: z.enum(["ja", "en", "zh"]).optional().describe("利用者の表示言語（省略すると ja）。言語ごとの式・ボタン名を確かめるとき"),
  mobile: z.boolean().optional().describe("モバイルの画面で確かめる（省略すると PC）。モバイルに一覧での編集は無いので、event が index のときは書けない")
});

const CONFIRM_DIALOG: TryDef = {
  about: "設定ファイルにレコードと場面（保存・アクション・ボタン）を当てて、どのダイアログがどの順に、どんな字で出るかを確かめる（模擬。kintone には書かない）。設定ファイルに error があれば、指摘だけを返す。",
  returns: "返すのは、レコードごと・場面ごとに出るダイアログの並び（どの行の何番目のステップか・アイコン・タイトル・本文を文字にしたもの〈300 字まで〉・ボタンの字・そこでキャンセルしたときの結果）、全部 OK を押したときの通知、ボタンの場面では出るボタンの字、評価できなかった式。probes を渡したときは、その式の値（300 字まで）。",
  more: [
    `scenes に場面を ${CD_MAX_SCENES} 個まで書く（必須）。追加の画面（create）を確かめるときは、records に $id の無いレコードを書いて渡す（ids・query で読んだレコードは $id を持つ）。`,
    "probes に式を渡すと、設定に入れずにその式の値を見られる（項目の値の形、書く前の条件の結果。レコード × 場面ごとに評価する）。確かめるための設定ファイルを別に作らない。",
    "値を書き換える・画面を操作する関数（FSET など）がある式は模擬しない（指摘を返す）。式の中の今日の日付はツールを動かした日、ログインユーザーはツールの仮の利用者で評価する。"
  ],
  options: {
    scenes: z.array(cdScene).min(1).max(CD_MAX_SCENES).describe(`確かめる場面（1〜${CD_MAX_SCENES} 個。レコードごとに、全部の場面を当てる）`),
    html: z.boolean().optional().describe("本文の HTML も返す（4,000 字まで。省略すると、文字にした要約だけ）。HTML の組み立てを確かめるときだけ"),
    probes: z.array(z.object({ formula: z.string().min(1).max(2000).describe("値を見たい式（項目の今の値を見るなら、項目コードだけを書く）") })).min(1).max(10).optional().describe("設定に入れずに、式の値だけを見る（10 個まで）。条件を書く前に、項目の値の形や式の結果を確かめるとき。設定ファイルを試しに書き換えない")
  },
  resultKey: "results",
  invalidMessage: "scenes・probes の指定を直すか、指摘された式を直してからやり直す（模擬の結果は返していない。レコードは読んだ）",
  narrow: "scenes を減らす、html を外す、probes を減らす、レコードを減らす、のどれかでやり直す",
  note: "渡したレコードで、レコード画面と同じ順に式を評価した。今日の日付はツールを動かした日、ログインユーザーはツールの仮の利用者。画面での見え方（置き場所・共通 CSS・アイコンの絵）、他の利用者の更新の確かめ、値を書き換える関数の動きは確かめていない",
  instruction: (tool, check) => `- 式の検査（${check}）は架空のレコードでの評価（文法と、項目があるかまで）。**ダイアログが思ったとおりに出るかは ${tool} で、レコードと場面を当てて確かめる**（利用者に、確かめるレコードの番号か条件を聞く。出るはずの例と出ないはずの例の両方を当てる）`
};

/** 製品の名前（中核の表の name）→ 定義 */
export const TRY_DEFS: Readonly<Record<string, TryDef>> = { "field-format": FIELD_FORMAT, "confirm-dialog": CONFIRM_DIALOG };

/** どの製品も使う入力の名前（製品ごとの入力に、同じ名前を書かない） */
export const TRY_COMMON_KEYS = ["file", "ids", "query", "records", "profile"] as const;

export function tryDefOf(plugin: string): TryDef {
  const d = Object.prototype.hasOwnProperty.call(TRY_DEFS, plugin) ? TRY_DEFS[plugin] : undefined;
  if (!d) throw new Error(`模擬のある製品だが、<頭>_try の定義が無い: ${plugin}（src/try-defs.ts に足す）`);
  const clash = Object.keys(d.options).filter((k) => (TRY_COMMON_KEYS as readonly string[]).includes(k));
  if (clash.length) throw new Error(`<頭>_try の製品ごとの入力の名前が、共通の入力と重なる: ${plugin} ${clash.join(", ")}`);
  return d;
}
