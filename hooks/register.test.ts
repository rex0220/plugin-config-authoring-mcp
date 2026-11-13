// フックの試験（claude plugin test hooks）。仮のファイルの仕組みは formula MCP の hooks/register.test.ts からの写し（あちらが正本）。
// このフックは「作業フォルダーの直下の *.json を、中身で見分けて止める」ので、中身を返す fs.read と一覧の fs.list を足している。
import { describe, expect, test } from 'claude-code/testing'

const SOURCE = JSON.stringify({ kind: 'rex0220-authoring-source', plugin: 'aggregate', appId: 1001, appName: '受注', source: { common: {}, rows: [] } }, null, 2)
const DOWNLOAD = '{"date":"2026-11-13 11:24:12","pluginName":"アプリ集計","pluginID":"rex0220 aggregate records plugin","PluginVersion":"67"}'

/** 仮のファイルの仕組み: フォルダーとファイル（中身つき）と symlink（/link → /ws） */
const DIRS = new Set(['/ws', '/ws/src', '/ws/sub', '/other'])
const FILES: Record<string, string | null> = {
  '/ws/agg-1001.json': SOURCE,
  '/ws/rex0220-aggregate-records-app1001-20261113-112413.json': DOWNLOAD,
  '/ws/aggregate-app1001-20261113-120000-import.json': DOWNLOAD,
  '/ws/package.json': '{"name":"x","version":"1.0.0"}',
  '/ws/broken.json': null, // 読めないファイル
  '/ws/src/x.ts': 'export {}',
  '/ws/sub/agg-1001.json': SOURCE,
  '/other/agg-1001.json': SOURCE,
}
const LINKS: Record<string, string> = { '/link': '/ws' }

/** Windows の Claude Code は $.fs.stat('/ws') を C:\ws に直してから渡すので、ドライブ名を外して区切りを / にそろえる */
const posix = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

function fold(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  let joined = '/' + out.join('/')
  for (const [from, to] of Object.entries(LINKS)) if (joined === from || joined.startsWith(from + '/')) joined = to + joined.slice(from.length)
  return joined
}

type Setup = { session?: string; brokenRoot?: boolean; brokenList?: boolean }

/** 試験の on に、エンジンの代わりの答えを並べる。返り値は、下まで届いた tool.call の記録 */
function engine(on: any, { session = '/ws', brokenRoot = false, brokenList = false }: Setup = {}) {
  const reached: Array<Record<string, unknown>> = []
  on('session.root', () => (brokenRoot ? { deny: 'root is broken' } : { value: session }))
  on('session.cwd', () => ({ value: session }))
  on('fs.stat', ($: unknown, e: { path: string }) => {
    const path = posix(e.path)
    const real = fold(path)
    const isLink = Object.keys(LINKS).some(l => path === l || path.startsWith(l + '/'))
    if (DIRS.has(real)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink, realPath: real } }
    if (real in FILES) return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink, realPath: real } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', ($: unknown, e: { path?: string }) => {
    if (brokenList) return { deny: 'EACCES' }
    const dir = fold(posix(e.path ?? session))
    const names = Object.keys(FILES).filter(f => f.startsWith(dir + '/') && !f.slice(dir.length + 1).includes('/')).map(f => f.slice(dir.length + 1))
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($: unknown, e: { path: string }) => {
    const text = FILES[fold(posix(e.path))]
    return typeof text === 'string' ? { value: text } : { deny: `EACCES ${e.path}` }
  })
  on('tool.call', { tool: ['Write', 'Edit'] }, ($: unknown, e: Record<string, unknown>) => {
    reached.push(e)
    return { result: { type: 'create', filePath: e.file_path } }
  })
  return reached
}

const isDenied = (r: any) => r?.deny !== undefined || r?.isError === true
const denyText = (r: any) => String(r?.deny ?? r?.text ?? '')
const write = ($: any, file_path: string, content: string) => $.tool.call({ tool: 'Write', file_path, content } as any)
const edit = ($: any, file_path: string, new_string = 'b') => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string } as any)

describe('直接の Write / Edit を止める（作業フォルダーの直下の *.json を中身で見分ける）', () => {
  test('設定ファイルへの Edit と Write を拒否し、設定のツールを案内する', async ($, on) => {
    const reached = engine(on)
    for (const r of [await edit($, '/ws/agg-1001.json'), await write($, 'agg-1001.json', '{}'), await edit($, '/ws/src/../AGG-1001.JSON')]) {
      expect(isDenied(r)).toBe(true)
      expect(denyText(r)).toMatch(/_update/)
    }
    expect(reached.length).toBe(0)
  })

  test('設定ファイルの中身を新しい名前で Write するのを拒否する（手で作らせない）', async ($, on) => {
    const reached = engine(on)
    const r = await write($, '/ws/new.json', SOURCE)
    expect(isDenied(r)).toBe(true)
    expect(denyText(r)).toMatch(/_new/)
    expect(isDenied(await edit($, '/ws/package.json', '"kind": "rex0220-authoring-source"'))).toBe(true)
    expect(reached.length).toBe(0)
  })

  test('取り込み用のファイル（-import.json）と設定画面のダウンロードを拒否する', async ($, on) => {
    const reached = engine(on)
    for (const r of [
      await edit($, '/ws/aggregate-app1001-20261113-120000-import.json'),
      await write($, '/ws/aggregate-app1002-20261113-130000-import.json', '{}'), // まだ無い名前でも
      await edit($, '/ws/rex0220-aggregate-records-app1001-20261113-112413.json'),
      await write($, '/ws/copy.json', DOWNLOAD),
    ]) {
      expect(isDenied(r)).toBe(true)
      expect(denyText(r)).toMatch(/_export/)
    }
    expect(reached.length).toBe(0)
  })

  test('symlink（/link → /ws）を通した Edit を拒否する', async ($, on) => {
    engine(on)
    expect(isDenied(await edit($, '/link/agg-1001.json'))).toBe(true)
  })

  test('今の中身を読めない直下の *.json は拒否する（fail-closed）', async ($, on) => {
    const reached = engine(on)
    const r = await edit($, '/ws/broken.json')
    expect(isDenied(r)).toBe(true)
    expect(denyText(r)).toMatch(/読めない/)
    expect(reached.length).toBe(0)
  })

  test('フォルダーの一覧が取れなければ拒否する（fail-closed）', async ($, on) => {
    const reached = engine(on, { brokenList: true })
    expect(isDenied(await write($, '/ws/notes.json', '{}'))).toBe(true)
    expect(reached.length).toBe(0)
  })

  test('関係のないファイルは通す（package.json、新しい JSON、直下でない所、*.json でないもの、セッションの外）', async ($, on) => {
    const reached = engine(on)
    const passes = [
      await edit($, '/ws/package.json'),
      await write($, '/ws/notes.json', '{"memo":1}'),
      await write($, 'src/x.ts', 'x'),
      await edit($, '/ws/sub/agg-1001.json'), // 直下でない（作業フォルダーのファイルではない）
      await edit($, '/other/agg-1001.json'), // セッションのフォルダーの外
      await write($, '/ws/notes.md', SOURCE), // *.json でない
    ]
    for (const r of passes) expect(isDenied(r)).toBe(false)
    expect(reached.length).toBe(passes.length)
  })

  test('セッションのフォルダーが解決できなければ拒否する（fail-closed）', async ($, on) => {
    const reached = engine(on, { brokenRoot: true })
    expect(isDenied(await write($, '/ws/src/x.ts', 'x'))).toBe(true)
    expect(reached.length).toBe(0)
  })
})
