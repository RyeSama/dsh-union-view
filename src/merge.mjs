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

// 会话开头的三条初始化事件，宿主校验要求第一个 turn/start 跟在它们后面。
// 合并时只保留一组，见 mergeEventStreams 里 sawInit 的用法。
export const INIT_TYPES = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])

/**
 * 每源只保留最近 k 个完整轮次（从 turn/start 起算），外加最开始那条 system/message。
 * 全量合并一个几千条消息的会话，光第一次请求就会把窗口撑爆——截断不是优化，是前提。
 */
export function tailByTurns(events, k) {
  if (!k || k <= 0) return events
  const starts = []
  const ends = []
  events.forEach((e, i) => {
    if (e.type === 'turn/start') starts.push(i)
    if (e.type === 'turn/end') ends.push(i)
  })
  if (starts.length <= k) return events
  const from = starts[starts.length - k]
  // 必须停在一个完整的 turn/end 上：源会话可能正跑到一半，末尾那轮没有收尾事件，
  // 直接切到流末尾会让下一段源的 turn/start 紧跟在 assistant/message 后面。
  const lastEnd = ends.length > 0 ? ends[ends.length - 1] : events.length - 1
  const head = events.find((e) => e.type === 'system/message')
  const tail = events.slice(from, lastEnd + 1)
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
  const sawInit = new Set()
  for (const { header, events } of sources) {
    for (const ev of events) {
      if (DROP_TYPES.has(ev.type)) continue
      // 会话开头的三条初始化事件（permission/preset、sandbox/mode、approval/policy）
      // 宿主是认的：第一个 turn/start 必须跟在它们后面。合并时只保留第一条源里的
      // 这一组，后面每个源重复出现的丢掉——否则第二个源的 turn/start 会被顶到
      // 不属于它的位置，校验报 "turn/start does not open the expected turn"。
      if (INIT_TYPES.has(ev.type)) {
        if (sawInit.has(ev.type)) continue
        sawInit.add(ev.type)
      }
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
      // 光剥 content 不够：assistant/message 还挂着 data.stream，那是逐 token 的
      // 流式回放记录，里面照样有 blockType:"reasoning" 的 block-start 和整段
      // reasoning-chunks。宿主重建节点时会读它，思考过程就又从这儿冒出来了。
      // stream 只是「打字机效果」的回放素材，transcript 的真相是 message.content，
      // 所以整段丢掉最干净（去掉单个元素会让后面的 index 错位）。
      if (kept.type === 'assistant/message' && kept.data && kept.data.stream) {
        const { stream, ...rest } = kept.data
        kept = { ...kept, data: rest }
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

  // 第一遍：按 turn/start 出现的顺序发号。
  // 不能拿「原 turn 号做数学偏移」：源会话里的 turn 号本身可能跳号（被压缩、
  // 被裁掉过），偏移之后依旧不连续，宿主校验 `turn/start does not open the
  // expected turn` 就整份拒收。改成顺序发号，保证新日志里 turn 严格 1,2,3… 连续。
  const turnMap = new Map() // `${srcId}#${oldTurn}` -> newTurn
  const rewritten = []
  let nextTurn = 1

  for (let i = 0; i < flat.length; i += 1) {
    const { ev, srcId } = flat[i]
    const next = { ...ev }
    if (TURN_CARRYING.has(ev.type) && ev.data && typeof ev.data.turn === 'number') {
      if (ev.type === 'turn/start') {
        turnMap.set(`${srcId}#${ev.data.turn}`, nextTurn)
        nextTurn += 1
      }
      const mapped = turnMap.get(`${srcId}#${ev.data.turn}`)
      if (mapped !== undefined) next.data = { ...ev.data, turn: mapped }
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
      // 宿主校验：sourceEventSeqs 里不能有重复值，也不能引用自己或后面的行
      // （实测 "sourceEventSeqs ranges must contain unique earlier seqs"）。
      // 重映射后去重，只留 < 当前位置的。
      const seen = new Set()
      const mapped = []
      for (const s of origin.sourceEventSeqs) {
        const v = seqNumMap.get(s)
        if (typeof v !== 'number' || v >= i || seen.has(v)) continue
        seen.add(v)
        mapped.push(v)
      }
      if (mapped.length > 0) next.sourceEventSeqs = mapped
      else delete next.sourceEventSeqs
    }
    out.push(next)
  }

  return out
}
