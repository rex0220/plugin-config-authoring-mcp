// 計算式エンジンを使うプラグイン（アプリ集計など）のオーサリングのための Claude Code のフック。製品に依らず同じもの。
// パスを解決する助けの関数は **formula MCP の hooks/register.ts からの写し**（あちらが正本。kSQL アクションの写しを経由）。
//   - 直接の Write / Edit で、セッションのフォルダーの**直下の *.json** のうち、次のものを変える・作るのを拒否する
//       設定ファイル（kind が rex0220-authoring-source。*_new / *_update から）
//       取り込み用のファイル（名前が -import.json で終わる。*_export が検査を通ったものから作る）
//       設定画面の［設定をダウンロード］のファイル（pluginID が rex0220 …。利用者が置く）
//     作業フォルダーは直下に JSON を置く形なので、名前では守れない。**今の中身と、書こうとする中身**で見分ける
//     （package.json・tsconfig.json など、関係のない JSON は止めない）
//   - 直下でない所、*.json でないもの、セッションのフォルダーの外は止めない
//   - 拒否のフックは .catch で失敗を拒否にする（fail-closed）。今の中身を読めない直下の *.json も拒否する
//   - 作業フォルダーを起動の設定（PCA_WORKSPACE）で別の所にしたときは、このフックは届かない（守るのはセッションのフォルダーだけ）
import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

/** 設定ファイルの印（中核の SOURCE_FILE_KIND と同じ） */
const SOURCE_MARK = /"kind"\s*:\s*"rex0220-authoring-source"/
/** 設定画面のダウンロード・取り込み用のファイルの印（封筒の pluginID） */
const ENVELOPE_MARK = /"pluginID"\s*:\s*"rex0220[ "]/
/** 取り込み用のファイルの名前（中核の importFileName） */
const IMPORT_NAME = /-import\.json$/i

const WHY_SOURCE = '設定ファイルは設定のツール（*_new で作る、*_update で直す）から保存する（digest の照合と上書きしない決まりを通す）'
const WHY_ENVELOPE = '取り込み用のファイルは *_export が検査を通った設定から作る。設定画面のダウンロードは利用者が置くファイル（AI が作らない・直さない）'

/** 中身から、守るファイルかを見分ける。守るものなら理由 */
const whyProtected = (text: string): string | undefined => (SOURCE_MARK.test(text) ? WHY_SOURCE : ENVELOPE_MARK.test(text) ? WHY_ENVELOPE : undefined)

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
    const input = e as { file_path?: unknown; content?: unknown; new_string?: unknown }
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
    // 書こうとする中身（Write は全文、Edit は置き換える文）
    const incoming = whyProtected(`${typeof input.content === 'string' ? input.content : ''}\n${typeof input.new_string === 'string' ? input.new_string : ''}`)
    if (incoming) return { deny: `pca: ${rel} は直接書かない。${incoming}` }
    // 今の中身（あれば）。読めなければ確かめられないので拒否する
    // あるかどうかはフォルダーの一覧で見る（stat の失敗を「無い」とみなさない。一覧が取れなければ .catch で拒否）
    const lower = rel.toLowerCase()
    const entry = (await $.fs.list(base)).find((x) => x.name.toLowerCase() === lower)
    if (entry === undefined) return next(e) // 新しいファイルで、中身も守るものでない
    const current = await $.fs.read(`${base}${sepOf(base)}${entry.name}`).catch(() => undefined) // 一覧にある名前で読む（大文字・小文字だけ違う書き方でも同じファイル）
    if (typeof current !== 'string') return { deny: `pca: ${rel} の今の中身を読めないので、設定ファイルでないことを確かめられない` }
    const existing = whyProtected(current)
    if (existing) return { deny: `pca: ${rel} は直接書き換えない。${existing}` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pca: 書き込む先の確認に失敗した' }))
}
