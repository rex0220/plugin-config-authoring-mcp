// 計算式エンジンを使うプラグイン（アプリ集計など）のオーサリングのための Claude Code のフック。製品に依らず同じもの。
// パスを解決する助けの関数は **formula MCP の hooks/register.ts からの写し**（あちらが正本。kSQL アクションの写しを経由）。
//   - 直接の Write / Edit で、セッションのフォルダーの**直下の *.json** のうち、次のものを変える・作るのを拒否する
//       設定ファイル（kind が rex0220-authoring-source。*_new / *_update から）
//       取り込み用のファイル（名前が -import.json で終わる。*_export が検査を通ったものから作る）
//       設定画面の［設定をダウンロード］のファイル（pluginID が rex0220 …。利用者が置く）
//     作業フォルダーは直下に JSON を置く形なので、名前では守れない。**今の中身と、書いた後の中身**で見分ける
//     （package.json・tsconfig.json など、関係のない JSON は止めない）
//   - 見分けるのは、JSON として読んだ**いちばん上のオブジェクトの値**（ツールがファイルを見分けるのと同じ見方）。
//     文字の並びでは見ない（"\u0065" のような書き方ですり抜ける。逆に、値の中に印の文字があるだけの関係のない JSON を止めてしまう）
//   - Edit は、今の中身に置き換えを当てた**編集の後の全文**で見る（印を 2 回の編集に分けて作っても、出来上がる編集で止まる）。
//     置き換えを再現できない Edit（今の中身に old_string が無い）は拒否する
//   - 直下でない所、*.json でないもの、セッションのフォルダーの外は止めない
//   - 拒否のフックは .catch で失敗を拒否にする（fail-closed）。今の中身を読めない直下の *.json も拒否する
//   - 作業フォルダーを起動の設定（PCA_WORKSPACE）で別の所にしたときは、このフックは届かない（守るのはセッションのフォルダーだけ）
import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

/** 設定ファイルの印（中核の SOURCE_FILE_KIND と同じ） */
const SOURCE_KIND = 'rex0220-authoring-source'
/** 設定画面のダウンロード・取り込み用のファイルの印（封筒の pluginID。"rex0220 aggregate records plugin" など） */
const ENVELOPE_ID = /^rex0220( |$)/
/** JSON として読めない中身のときだけ使う、文字の並びの印（読めないものは安全側に倒す） */
const SOURCE_MARK = /"kind"\s*:\s*"rex0220-authoring-source"/
const ENVELOPE_MARK = /"pluginID"\s*:\s*"rex0220[ "]/
/** 取り込み用のファイルの名前（中核の importFileName） */
const IMPORT_NAME = /-import\.json$/i

const WHY_SOURCE = '設定ファイルは設定のツール（*_new で作る、*_update で直す）から保存する（digest の照合と上書きしない決まりを通す）'
const WHY_ENVELOPE = '取り込み用のファイルは *_export が検査を通った設定から作る。設定画面のダウンロードは利用者が置くファイル（AI が作らない・直さない）'

/**
 * 中身から、守るファイルかを見分ける。守るものなら理由。
 * JSON として読めれば、いちばん上のオブジェクトの kind / pluginID の**値**で決める。
 * 読めなければ（書きかけ・壊れた JSON）、\uXXXX を字に戻してから文字の並びで見る（後の編集で直せば守るファイルになるものを、先に置かせない）
 */
function whyProtected(text: string): string | undefined {
  const body = text.replace(/^\uFEFF/, '')
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    const plain = body.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    return SOURCE_MARK.test(plain) ? WHY_SOURCE : ENVELOPE_MARK.test(plain) ? WHY_ENVELOPE : undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const top = value as Record<string, unknown>
  if (top.kind === SOURCE_KIND) return WHY_SOURCE
  if (typeof top.pluginID === 'string' && ENVELOPE_ID.test(top.pluginID)) return WHY_ENVELOPE
  return undefined
}

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)
const sepOf = (p: string) => (isWindowsPath(p) ? '\\' : '/')
const foldCase = (p: string) => (isWindowsPath(p) ? p.toLowerCase() : p)
const trimSep = (p: string) => p.replace(/[\\/]+$/, '') || p

/** パスを実際のパス（symlink を解く）に直す。フォルダーだけ。だめなら undefined */
async function realDir($: $, p: string): Promise<string | undefined> {
  const st = await $.fs.stat(p, { resolve: true }).catch(() => undefined)
  return st?.kind === 'dir' && st.realPath ? foldCase(trimSep(st.realPath)) : undefined
}

/**
 * Write がまだ無いファイル・フォルダーを指してもよいように、着地する実際のパスを返す。
 * パスの . と .. を字面でたたんでから、存在する一番深い親を実際のパス（symlink を解く）に直し、残りをつなげる。
 * ドライブ相対・ネットワーク（\\ や //）・空・. / .. の名前は解決しない（undefined → 拒否）
 */
async function placed($: $, p: string): Promise<string | undefined> {
  if (/^[A-Za-z]:(?![\\/])/.test(p) || /^[\\/][\\/]/.test(p)) return undefined
  const sep = sepOf(p)
  const drive = /^[A-Za-z]:/.test(p) ? p.slice(0, 2) : ''
  const parts: string[] = []
  for (const part of p.slice(drive.length).split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const name = parts[parts.length - 1]
  if (name === undefined || /^[A-Za-z]:/.test(name)) return undefined
  // 一番深い存在する親を探す（ファイルそのものから順にさかのぼる）
  for (let i = parts.length; i >= 0; i--) {
    const head = `${drive}${sep}${parts.slice(0, i).join(sep)}`
    const st = await $.fs.stat(head, { resolve: true }).catch(() => undefined)
    if (st?.realPath === undefined) continue
    const rest = parts.slice(i)
    if (rest.length > 0 && st.kind !== 'dir') return undefined // ファイルの下には置けない
    const base = trimSep(st.realPath)
    return foldCase(rest.length === 0 ? base : `${base}${sepOf(base)}${rest.join(sepOf(base))}`)
  }
  return undefined
}

const isUnder = (child: string, parent: string) => child === parent || child.startsWith(parent + sepOf(parent))

export const register: Register = (on) => {
  // 直接の Write / Edit で設定ファイル・取り込み用のファイル・ダウンロードを変えない
  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const input = e as { file_path?: unknown; content?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown }
    const filePath = String(input.file_path ?? '')
    const base = await realDir($, await $.session.root())
    if (base === undefined) return { deny: 'pca: セッションのフォルダーを解決できない' }
    const absolute = isWindowsPath(filePath) || filePath.startsWith('/') ? filePath : `${await $.session.cwd()}${sepOf(base)}${filePath}`
    const real = await placed($, absolute)
    if (real === undefined) return { deny: 'pca: 書き込む先を解決できない' }
    if (!isUnder(real, base) || real === base) return next(e) // セッションのフォルダーの外は止めない
    const rel = real.slice(base.length + 1).replace(/\\/g, '/')
    if (rel.includes('/') || rel.startsWith('.') || !/\.json$/i.test(rel)) return next(e) // 作業フォルダーのファイルは直下の *.json だけ
    if (IMPORT_NAME.test(rel)) return { deny: `pca: ${rel} は直接書き換えない。${WHY_ENVELOPE}` }
    // 今の中身（あれば）。あるかどうかはフォルダーの一覧で見る（stat の失敗を「無い」とみなさない。一覧が取れなければ .catch で拒否）
    const lower = rel.toLowerCase()
    const entry = (await $.fs.list(base)).find((x) => x.name.toLowerCase() === lower)
    let current: string | undefined
    if (entry !== undefined) {
      // 一覧にある名前で読む（大文字・小文字だけ違う書き方でも同じファイル）。読めなければ確かめられないので拒否する
      const text = await $.fs.read(`${base}${sepOf(base)}${entry.name}`).catch(() => undefined)
      if (typeof text !== 'string') return { deny: `pca: ${rel} の今の中身を読めないので、設定ファイルでないことを確かめられない` }
      const existing = whyProtected(text)
      if (existing) return { deny: `pca: ${rel} は直接書き換えない。${existing}` }
      current = text
    }
    // 書いた後の中身（Write は全文。Edit は、今の中身に置き換えを当てた全文）
    let after: string
    if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
      if (current === undefined) return next(e) // 無いファイルへの Edit は、道具の側で失敗する
      // 改行だけ違う（ファイルは CRLF、old_string は LF）書き方は、LF にそろえて当てる（見分けるのは JSON の値なので、改行は結果に関わらない）
      const lf = (t: string) => t.replace(/\r\n/g, '\n')
      const exact = typeof input.old_string === 'string' && input.old_string !== '' && current.includes(input.old_string)
      const text = exact ? current : lf(current)
      const from = typeof input.old_string === 'string' ? (exact ? input.old_string : lf(input.old_string)) : ''
      const to = typeof input.new_string === 'string' ? (exact ? input.new_string : lf(input.new_string)) : ''
      if (from === '' || !text.includes(from)) return { deny: `pca: ${rel} への Edit を再現できない（今の中身に old_string が無い）ので、書いた後に設定ファイルにならないことを確かめられない` }
      after = input.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to)
    } else {
      after = typeof input.content === 'string' ? input.content : ''
    }
    const incoming = whyProtected(after)
    if (incoming) return { deny: `pca: ${rel} は直接書かない。${incoming}` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pca: 書き込む先の確認に失敗した' }))
}
