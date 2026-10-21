// 把多个会话的事件流焊成一个新会话（离线产出 session.v4.jsonl.zstd）。
//
// 合并规则住在 src/merge.mjs（Node 半边的 /weld 命令也用同一份）。
// 这个脚本只负责「读磁盘 + 写磁盘 + 打印诊断」。
//
// ⚠️ 注意：dsh 的会话列表来自 ~/.dsh/storages/workspace.json 的注册表，
// 不是扫目录。手写出来的文件即使格式完全正确，也不会出现在侧栏里。
// 想让它真正可用，走插件里的 /weld 命令（ctx.sessions.create）。
// 这个脚本留作离线分析 / 导出用。
//
// 用法：
//   node scripts/merge-sessions.mjs --dry <sessionDirA> <sessionDirB> [...]
//   node scripts/merge-sessions.mjs --out <新会话目录> --turns K <A> <B> [...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { mergeEventStreams, tailByTurns } from '../src/merge.mjs'

const LOG_NAME = 'session.v4.jsonl.zstd'

function readLog(dir) {
  const p = join(dir, LOG_NAME)
  const text = zstdDecompressSync(readFileSync(p)).toString('utf8')
  const lines = text.split('\n').filter((l) => l.length > 0)
  const header = JSON.parse(lines[0])
  const events = lines.slice(1).map((l) => JSON.parse(l))
  return { header, events }
}

// dsh 读 header 时会单独解压「第一个 zstd frame」，并要求这一帧里只有 header 一行
// （assertZstdHeaderFrame）。所以整份日志不能压成一个 frame：
// 必须 header 独占一帧，事件各自成帧——和 dsh 自己 append 出来的物理布局一致。
function writeLog(dir, header, events) {
  mkdirSync(dir, { recursive: true })
  const frames = [zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))]
  for (const ev of events) {
    frames.push(zstdCompressSync(Buffer.from(JSON.stringify(ev) + '\n', 'utf8')))
  }
  writeFileSync(join(dir, LOG_NAME), Buffer.concat(frames))
}

function main() {
  const argv = process.argv.slice(2)
  const dry = argv[0] === '--dry'
  const outId = dry ? null : argv[0] === '--out' ? argv[1] : null
  const rest = argv.slice(dry ? 1 : outId ? 2 : 1)
  const turnsArg = rest.findIndex((a) => a === '--turns')
  const turns = turnsArg >= 0 ? Number(rest[turnsArg + 1]) : 0
  const dirs = rest.filter((a, i) => a !== '--turns' && i !== turnsArg + 1)

  const sources = dirs.map((d) => {
    const s = readLog(d)
    const kept = tailByTurns(s.events, turns)
    if (kept !== s.events) console.log(`  ${s.header.id}: 保留最近 ${turns} 轮（${s.events.length} → ${kept.length} 事件）`)
    return { header: s.header, events: kept }
  })
  sources.forEach((s, i) => {
    console.log(`源 ${i + 1}: ${s.header.id}  事件 ${s.events.length}  cwd=${s.header.cwd}`)
  })

  const merged = mergeEventStreams(sources)

  const counts = new Map()
  for (const e of merged) counts.set(e.type, (counts.get(e.type) || 0) + 1)
  console.log('\n=== 合并后事件类型 ===')
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), k)
  console.log('总计:', merged.length, ' seq:', merged[0]?.seq, '→', merged[merged.length - 1]?.seq)

  for (let i = 0; i < merged.length; i += 1) {
    if (merged[i].seq !== i) { console.log('!! seq 不连续 at', i, merged[i].seq); break }
  }

  const badRefs = merged.filter((e) => Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.some((s) => s < 0 || s >= merged.length))
  console.log('越界 sourceEventSeqs 的事件:', badRefs.length)
  const badRep = merged.filter((e) => e.surfaceOp && typeof e.surfaceOp === 'object' && (e.surfaceOp.startSeq >= merged.length || e.surfaceOp.endSeq >= merged.length))
  console.log('越界 replace 的事件:', badRep.length)

  if (dry) {
    console.log('\n=== 前 6 条 ===')
    console.log(merged.slice(0, 6).map((e) => JSON.stringify(e).slice(0, 160)).join('\n'))
    return
  }
  if (!outId) { console.error('缺少 --out <新会话目录>'); process.exit(1) }

  const cwd = sources[0].header.cwd
  const header = {
    type: 'session',
    version: 4,
    id: basename(outId),          // 目录名就是会话 id
    createdAt: Date.now(),
    ...(cwd ? { cwd } : {}),
    isSeeded: false,
    delegationDepth: 0,
  }
  writeLog(outId, header, merged)
  console.log('\n已写出:', outId, '  会话 id:', header.id)
  console.log('提醒：手写文件不会进侧栏（会话列表读 workspace.json 注册表），请用 /weld 命令。')
}

if (process.argv[1] && process.argv[1].endsWith('merge-sessions.mjs')) main()
