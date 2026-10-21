// Node 半边：注册 /weld 命令，把多个会话焊成一个新会话。
//
// 这条路为什么这么绕：
//   · 会话不是「扫目录」发现的——侧栏读的是 ~/.dsh/storages/workspace.json 里
//     workspaces[].sessionIds 这份所有权账本，手写文件不 attach 就不会出现。
//   · ctx.sessions.create() 只让会话活在内存里，不落盘也不进账本
//     （它等的是 session/event 上的持久化订阅，而种子历史不会重放事件）。
// 所以这里自己干两件事：按宿主物理格式分帧写日志，再 attachSession 进账本。
//
// 合并规则在 ../src/merge.mjs，和离线脚本 scripts/merge-sessions.mjs 共用同一份。
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { mergeEventStreams, tailByTurns } from '../src/merge.mjs'

export const name = 'dsh-union-view'
export const inject = ['sessions', 'commands', 'workspaceRegistry', 'sessionPersistence']

const LOG_NAME = 'session.v4.jsonl.zstd'
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/** 扫所有工程目录下的会话目录（只认有日志文件的）。 */
function listSessionDirs() {
  const out = []
  if (!existsSync(SESSIONS_ROOT)) return out
  for (const proj of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const projPath = join(SESSIONS_ROOT, proj.name)
    let entries
    try {
      entries = readdirSync(projPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of entries) {
      if (!s.isDirectory()) continue
      const dir = join(projPath, s.name)
      if (existsSync(join(dir, LOG_NAME))) out.push({ id: s.name, dir })
    }
  }
  return out
}

function readLog(dir) {
  // 日志是多帧 zstd（header 一帧 + 每条事件一帧），zstdDecompressSync 会连续解完。
  const text = zstdDecompressSync(readFileSync(join(dir, LOG_NAME))).toString('utf8')
  const lines = text.split('\n').filter((l) => l.length > 0)
  const header = JSON.parse(lines[0])
  const events = lines.slice(1).map((l) => JSON.parse(l))
  return { header, events }
}

// 宿主读 header 时只解压「第一个 zstd frame」，并要求这一帧里只有 header 一行
// （assertZstdHeaderFrame）。整份压成一个 frame 会被判成 corrupt。
function writeLog(dir, header, events) {
  mkdirSync(dir, { recursive: true })
  const frames = [zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))]
  for (const ev of events) {
    frames.push(zstdCompressSync(Buffer.from(JSON.stringify(ev) + '\n', 'utf8')))
  }
  writeFileSync(join(dir, LOG_NAME), Buffer.concat(frames))
}

/** 会话在磁盘上的工程目录：和 dsh 的 projectKey 规则一致（D:\dsh-workspace → --D-dsh-workspace--）。 */
function projectDirFor(cwd) {
  const key = `--${String(cwd).replace(/:/g, '').replace(/[\\/]+/g, '-')}--`
  return join(SESSIONS_ROOT, key)
}

/** 从事件里挖出可读文字，用于列表预览。结构在不同事件上不统一，逐层兜。 */
function eventText(ev) {
  const c = ev?.data?.message?.content ?? ev?.data?.content ?? ev?.data
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join(' ')
  }
  return ''
}

/** 宿主塞进来的样板消息（不是人打的字），列表预览里要跳过。 */
function isInjected(text) {
  const t = String(text || '').trim()
  if (t.length === 0) return true
  return /^(The approval policy changed|The output token limit|<)/.test(t)
}

/** /weld 不带参数：列最近用过的会话，让人凭"第一句话"认出编号。 */
function listSessions() {
  const all = listSessionDirs()
  if (all.length === 0) return `没有找到任何会话日志（${SESSIONS_ROOT}）`
  const rows = []
  for (const s of all) {
    try {
      const st = statSync(join(s.dir, LOG_NAME))
      const log = readLog(s.dir)
      // 首条 user/message 常是宿主注入的样板（审批策略变更、XML 包裹的附件），跳过它们才看得懂
      const firstUser = log.events.find((e) => e.type === 'user/message' && !isInjected(eventText(e)))
      const snippet = String(eventText(firstUser) || '').replace(/\s+/g, ' ').trim().slice(0, 42)
      rows.push({ id: s.id, last: st.mtimeMs, snippet })
    } catch {
      // 单个会话读不动就跳过，列表不该因为一个坏文件整体失败
    }
  }
  rows.sort((a, b) => b.last - a.last)
  const lines = rows.slice(0, 12).map((r) => {
    const t = new Date(r.last).toLocaleString('zh-CN', {
      hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    return `${r.id.slice(8, 16)}  ${t}  ${r.snippet || '（没有文字消息）'}`
  })
  return `最近用过的会话（共 ${rows.length} 个）\n\n`
    + lines.join('\n')
    + '\n\n把左边那 8 个字符填进去：/weld 编号1 编号2 --turns 20'
}

function parseArgs(raw) {  const tokens = String(raw || '').trim().split(/\s+/).filter(Boolean)
  let turns = 0
  const wanted = []
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === '--turns') {
      turns = Number(tokens[i + 1]) || 0
      i += 1
      continue
    }
    wanted.push(tokens[i])
  }
  return { turns, wanted }
}

async function weld(ctx, raw) {
  const { turns, wanted } = parseArgs(raw)
  if (wanted.length === 0) return { kind: 'success', text: listSessions() }
  if (wanted.length < 2) {
    return { kind: 'error', text: '用法：/weld <编号> <编号> [...] [--turns N]\n只看不写：/weld（不带参数）会列出最近用过的会话。' }
  }

  const all = listSessionDirs()
  if (all.length === 0) return { kind: 'error', text: `没有找到任何会话日志（${SESSIONS_ROOT}）` }

  const picked = []
  for (const w of wanted) {
    const hits = all.filter((s) => s.id === w || s.id.includes(w))
    if (hits.length === 0) return { kind: 'error', text: `找不到会话：${w}` }
    if (hits.length > 1) return { kind: 'error', text: `前缀 ${w} 命中 ${hits.length} 个会话，写长一点再试` }
    if (picked.some((p) => p.id === hits[0].id)) continue
    picked.push(hits[0])
  }
  if (picked.length < 2) return { kind: 'error', text: '至少要两个不同的会话' }

  const sources = picked.map((p) => {
    const s = readLog(p.dir)
    return { header: s.header, events: tailByTurns(s.events, turns) }
  })

  const merged = mergeEventStreams(sources)
  if (merged.length === 0) return { kind: 'error', text: '合并结果为空' }

  const newId = `session-${randomUUID()}`
  const cwd = sources[0].header.cwd
  if (!cwd) return { kind: 'error', text: '源会话的 header 没有 cwd，无法判断放到哪个工作区' }

  // sessionPersistence.create() 要的是「header 的载荷」，不是已经序列化成一行的那份：
  // `type: 'session'` 由 format 层自己补（手动塞进去会被判
  // "format v4 header has unexpected field type"），但 `version` 必须自己给
  // （缺了会报 "Session format version must be a non-negative safe integer"）。
  const headerPayload = {
    version: 4,
    id: newId,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }

  // 正路：让宿主自己写，不碰物理格式。
  //  1) sessionPersistence.create() 先落一个空日志文件并拿到写句柄 —— 不能省：
  //     持久化插件靠 `this.writers.get(session.id)` 路由 session/event，
  //     writer 只在 create/open 时注册；没有 writer，flush 会静默什么都不做
  //     （源码：`if (writer === null || writer === void 0) return void 0`），
  //     于是事件全留在内存里 —— 账本有 id、磁盘没文件。
  //  2) sessions.create() 建活会话，逐条 append —— seq 由宿主自己发，天然连续，
  //     surfaceManager.validateNext 逐步校验，报错能点名到具体事件和序号。
  //  3) handle.flush() 把 writer 的缓冲真正落盘。
  let how = ''
  let handle = null
  try {
    const persistence = ctx.sessionPersistence
    if (persistence && typeof persistence.create === 'function') {
      handle = await persistence.create(headerPayload, { inheritedEventCount: 0 })
    }
    const session = ctx.sessions.create(newId, { meta: { cwd } })
    for (const ev of merged) {
      const opts = {}
      if (ev.surfaceOp !== undefined) opts.surfaceOp = ev.surfaceOp
      if (Array.isArray(ev.sourceEventSeqs)) opts.sourceEventSeqs = ev.sourceEventSeqs
      session.append(ev.type, ev.data, opts)
    }
    // 有的宿主把 flush 放在 service 上，有的放在 session 上，有的只在句柄上。
    if (typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(session)
    else if (typeof session.flush === 'function') await session.flush()
    if (handle && typeof handle.flush === 'function') await handle.flush()
    if (handle && typeof handle.close === 'function') { await handle.close(); handle = null }
    how = '由宿主写入（persistence.create + append + flush）'
  } catch (err) {
    if (handle && typeof handle.close === 'function') {
      try { await handle.close() } catch { /* 关不掉就交给后面的清理 */ }
    }
    // append 走的是宿主正常写入路径，报错定位比读盘校验精确得多（点名到事件类型和序号），
    // 所以这里不回退手写 —— 写一份必然打不开的日志只会把错误藏起来，还污染账本。
    throw new Error(`宿主拒绝了这批事件：${err && err.message ? err.message : err}`)
  }

  // 写进所有权账本，侧栏才会认它。
  let attached = '未注册'
  try {
    const ws = (await ctx.workspaceRegistry.resolveByPath(cwd)) || (await ctx.workspaceRegistry.create(cwd))
    await ws.attachSession(newId)
    attached = '已注册'
  } catch (err) {
    attached = `注册失败：${err && err.message ? err.message : err}`
  }

  const per = sources.map((s) => `${s.header.id.slice(0, 16)}… ${s.events.length}`).join(' + ')
  return {
    kind: 'success',
    text: `已焊成新会话 ${newId}（${attached}）\n写入方式：${how}\n来源：${per} → ${merged.length} 条事件`
      + (turns > 0 ? `\n（每个源只取最近 ${turns} 轮）` : '')
      + '\n源会话没有被修改。刷新侧栏或重开会话列表即可看到它。',
  }
}

export function apply(ctx) {
  try {
    ctx.commands.register({
      name: 'weld',
      description: '把多个会话的历史焊成一个新会话（源会话只读，新会话可以接着聊）',
      input: { hint: '<会话id或前缀> <会话id或前缀> [...] [--turns N]' },
      handler: (inv) => weld(ctx, inv.rawInput),
    })
    console.log('[dsh-union-view] /weld 已注册')
    // 自检：UV_WELD_LIST=1 时打印 /weld 的会话列表，验证列表逻辑而不用手敲命令
    if (process.env.UV_WELD_LIST) {
      console.log('[list]\n' + listSessions())
    }
  } catch (err) {
    console.error('[dsh-union-view] /weld 注册失败:', err && err.stack ? err.stack : err)
  }

  // 自检：UI 里敲命令不方便时用它跑一遍完整链路。
  // 只在显式设了 UV_WELD_SELFTEST 时执行，平时完全不碰。
  if (process.env.UV_WELD_SELFTEST) {
    const src = process.env.UV_WELD_SRC || ''
    const turns = Number(process.env.UV_WELD_TURNS || 0)
    setTimeout(async () => {
      try {
        console.log('[selftest] 开始，源:', src, 'turns:', turns)
        const r = await weld(ctx, `${src.replace(/,/g, ' ')}${turns ? ` --turns ${turns}` : ''}`)
        console.log('[selftest] 结果:', r.kind, '|', String(r.text).replace(/\n/g, ' / '))
      } catch (err) {
        console.error('[selftest] 抛错:', err && err.stack ? err.stack : err)
      }
    }, 3000)
  }
}
