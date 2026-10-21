// 事件流合并核心：纯函数，不碰磁盘。
//
// 两个使用者：
//   scripts/merge-sessions.mjs  离线产出 session.v4.jsonl.zstd（调试 / 导出）
//   .dsh-plugin/index.mjs       /weld 命令，走 ctx.sessions.create 落进宿主
//
// 为什么要重编号：dsh 的会话是 append-only 事件流，seq 必须从 0 连续；
// surfaceOp.replace 和 sourceEventSeqs 里还存着别的 seq 的引用，
// 直接拼接会让这些引用指向错误的行。所以 seq / 引用 / turn 都要重映射。

// 这些事件只属于原会话的生命周期，合并进新会话会污染语义，直接丢掉。
export const DROP_TYPES = new Set([
  'session/end-seed',      // fork 继承标记，只有 Session 构造函数能写
  'session/title',         // 带 messageSeqs 引用，合并后指向已裁掉的消息 → 校验直接判 corrupt
  'agent/inbox/spliced',   // agent 内部收件箱状态
  'session/title-llm-request',
  'deliverables/presented',
  'workspace/changes',
])

// 携带 turn 编号、需要重排的事件（其余事件原样搬）。
const TURN_CARRYING = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'user/message', 'developer/message', 'system/message', 'assistant/message',
  'assistant/attempt', 'tool/call', 'tool/result',
])

/**
 * 每源只保留最近 k 个完整轮次（从 turn/start 起算），外加最开始那条 system/message。
 * 全量合并一个几千条消息的会话，光第一次请求就会把窗口撑爆——截断不是优化，是前提。
 */
export function tailByTurns(events, k) {
  if (!k || k <= 0) return events
  const starts = []
  events.forEach((e, i) => { if (e.type === 'turn/start') starts.push(i) })
  if (starts.length <= k) return events
  const from = starts[starts.length - k]
  const head = events.find((e) => e.type === 'system/message')
  const tail = events.slice(from)
  if (head && !tail.includes(head)) return [head, ...tail]
  return tail
}

/**
 * 合并多段事件流。
 * @param sources {{ header: object, events: object[] }[]}
 * @returns 新事件数组（seq 已从 0 连续重编号，内部引用已重映射，reasoning 已剥离）
 */
export function mergeEventStreams(sources) {
  const out = []

  // 摊平所有源事件；只留第一份 system/message：
  // 渲染出的系统提示是 surface node 0，多份叠在一起会让 replay 在「清空 / 改写 head」之间打转。
  const flat = []
  let sawSystem = false
  for (const { header, events } of sources) {
    for (const ev of events) {
      if (DROP_TYPES.has(ev.type)) continue
      if (ev.type === 'system/message') {
        if (sawSystem) continue
        sawSystem = true
      }
      let kept = ev
      // 思考过程既不显示也不参与合并，在摊平阶段就剥掉：
      // 事件里的内容块用的是 `kind`（实测一个工作区 5378 个 reasoning / 5982 个
      // tool-call 全是 kind），`type` 是 LLM 原始格式的写法，两个都得判。
      // 整条只剩思考的消息直接丢，否则会留下一条空 content 的 assistant 消息。
      if (ev.type === 'assistant/message' && Array.isArray(ev.data?.message?.content)) {
        const blocks = ev.data.message.content.filter((b) => {
          if (!b) return false
          const k = b.kind ?? b.type
          return k !== 'reasoning' && k !== 'thinking'
        })
        if (blocks.length !== ev.data.message.content.length) {
          if (blocks.length === 0) continue
          kept = { ...ev, data: { ...ev.data, message: { ...ev.data.message, content: blocks } } }
        }
      }
      flat.push({ ev: kept, srcId: header.id })
    }
  }

  // 每源的 turn 最小值 → 重排后从 1 开始连续，跨源接着往上数。
  // 只认 turn/start：留作门面的那条 system/message 带 turn=1，
  // 拿它一起算最小值会把整段轮次编号抬高。
  const turnMin = new Map()
  for (const { ev, srcId } of flat) {
    if (ev.type !== 'turn/start') continue
    const t = ev.data && ev.data.turn
    if (typeof t !== 'number') continue
    const cur = turnMin.get(srcId)
    if (cur === undefined || t < cur) turnMin.set(srcId, t)
  }

  // 第一遍：按源分段重排 turn。
  const rewritten = []
  let turnBase = 0
  let prevSrcId = null
  let srcTurnMax = 0

  for (let i = 0; i < flat.length; i += 1) {
    const { ev, srcId } = flat[i]
    if (srcId !== prevSrcId) {
      // 切到下一段：把这一段的轮次整体抬到上一段末尾之后，避免撞号。
      if (prevSrcId !== null) turnBase += srcTurnMax
      prevSrcId = srcId
      srcTurnMax = 0
    }
    const next = { ...ev }
    if (TURN_CARRYING.has(ev.type) && ev.data && typeof ev.data.turn === 'number') {
      const shifted = ev.data.turn - (turnMin.get(srcId) || 0) + 1 + turnBase
      if (shifted > srcTurnMax) srcTurnMax = shifted
      next.data = { ...ev.data, turn: shifted }
    }
    rewritten.push({ next, origin: ev })
  }

  // 第二遍：写新 seq + 重映射引用。
  const seqNumMap = new Map()
  for (let i = 0; i < flat.length; i += 1) seqNumMap.set(flat[i].ev.seq, i)

  for (let i = 0; i < rewritten.length; i += 1) {
    const { next, origin } = rewritten[i]
    next.seq = i
    if (origin.surfaceOp && typeof origin.surfaceOp === 'object') {
      // 宿主对 seed 有一道硬校验：replace 的 sourceEventSeqs 必须列全被遮盖的
      // 每一条 surface 事件（少一条就 "invalid seed event ... must include every
      // shadowed surface"）。跨会话合并后这种谱系本来就断了，补不回来，
      // 所以统一降级成 append——代价是被压缩重写过的旧消息会和新消息一起出现，
      // 换来的是一份宿主肯定吃得下的种子。
      next.surfaceOp = 'append'
    }
    if (Array.isArray(origin.sourceEventSeqs)) {
      const mapped = origin.sourceEventSeqs.map((s) => seqNumMap.get(s)).filter((v) => typeof v === 'number')
      if (mapped.length > 0) next.sourceEventSeqs = mapped
      else delete next.sourceEventSeqs
    }
    out.push(next)
  }

  return out
}
