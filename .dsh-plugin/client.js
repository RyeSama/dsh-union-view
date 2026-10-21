window.__ModuleLoader__.load({
	id: "dsh-union-view",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
// dsh-union-view · client half
//
// 目标：把 N 个会话的转录只读地拼成一个"联合视图"，挂在 conversation.view 槽位上。
//
// 三条硬约束（决定了整个实现形态）：
//   1) 只读 —— 只用 ctx.sessions.retain() 借一个 Client generation，用完 release()。
//      不写会话日志、不 fork、不改标题、不发消息。
//   2) 不进模型上下文 —— 视图只在浏览器里渲染，不 inject 任何东西给 agent。
//      因此 prefix cache 一次都不失效（对比：物理合并两个 350K 会话要重写 700K 前缀）。
//   3) 零后端 —— 不注册服务、不落盘、不开端口。选中的会话 id 只存 localStorage。
//
// 数据通路（全部是官方注入面，无 monkey patch）：
//   ctx.sessions.retain(id, {source:'unionView'})  → SessionReference{ binding, ready, release }
//   ctx.uiConversation.binding(ref.binding)        → ConversationBinding{ target('chat') }
//   binding.target('chat')                          → ObservableSnapshot<ChatSnapshot|undefined>
//   ChatSnapshot.legacy.nodes                       → readonly ConversationNode[]
//   （首个 subscriber 会激活 chat target，从而触发历史加载；取消订阅后 target 保持激活到会话生命周期结束）
//
// 本文件是 CJS 片段：由 scripts/build-client.mjs 包进 window.__ModuleLoader__.load 的
// factory 作用域。唯一外部依赖是 factory 参数提供的 require('react')。

'use strict'

const React = require('react')
const { useState, useEffect, useMemo, useRef, useCallback } = React
const h = React.createElement

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const VIEW_ID = 'union'
const VIEW_ORDER = 6
const SOURCE = 'unionView'
const LS_KEY = 'dsh-union-view:v1'
const MAX_SESSIONS = 6
const READY_TIMEOUT_MS = 6000
// 单个布局最多挂多少条消息节点：真实会话常有 1000+ 条，6 个会话一起渲染会把 DOM 撑到十几万像素高，
// 滚动直接卡死。时间线/分栏只渲染「最近这么多条」，更早的折叠成一行提示。
const ROW_LIMIT = 400

const COLORS = [
  '#4f9cf9', // 蓝
  '#e8734a', // 橙
  '#3fb98a', // 绿
  '#b56cf0', // 紫
  '#e0b341', // 金
  '#e05c7e', // 品红
]

const LAYOUTS = [  { id: 'timeline', label: '时间线', hint: '按墙钟时间把多个会话交错成一条流' },
  { id: 'columns', label: '分栏', hint: '每个会话一列，各自滚动' },
  { id: 'turns', label: '轮次对齐', hint: '以「轮」为行，横向对比各会话的同阶段表现' },
]

/* ------------------------------------------------------------------ *
 * 样式小工具（全部内联，跟随主题色，不硬编码背景）
 * ------------------------------------------------------------------ */

const S = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    // 高度不要在这里写：fill 状态下 top+bottom 已经定死高度，
    // 再给一个内联 height:100% 会让 over-constrained 的 bottom 被忽略（实测 814 而不是 662）。
    minHeight: 0,
    minWidth: 0,
    // 绝对定位之后的子内容不会被祖先自动裁剪：分栏里某一列高度约束算漏一点，
    // 正文就会画到面板底边之外、压在输入席上。这里统一裁掉。
    overflow: 'hidden',
    font: 'inherit',
    color: 'inherit',
    // 会话主体里 dsh 的输入席是浮层，联合视图必须自己铺一层不透明底，
    // 否则壁纸会从面板底下透上来，正文和插图糊在一起。
    // 定位方式交给 CSS（[data-union-view] / [data-union-fill]）：
    // 内联 position 会盖掉 CSS 里的 absolute，fill 就失效了。
    isolation: 'isolate',
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    padding: '8px 12px',
    borderBottom: '1px solid rgba(128,128,128,.22)',
    flex: '0 0 auto',
  },
  barTitle: { fontSize: 13, fontWeight: 600, letterSpacing: '.02em', opacity: 0.9 },
  barSpacer: { flex: '1 1 auto' },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 9px',
    borderRadius: 999,
    border: '1px solid rgba(128,128,128,.3)',
    background: 'rgba(128,128,128,.08)',
    fontSize: 12,
    lineHeight: '18px',
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  },
  chipOn: {
    borderColor: 'rgba(79,156,249,.85)',
    background: 'rgba(79,156,249,.16)',
  },
  dot: { width: 8, height: 8, borderRadius: 999, flex: '0 0 auto' },
  btn: {
    padding: '3px 10px',
    borderRadius: 7,
    border: '1px solid rgba(128,128,128,.3)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
  },
  btnOn: {
    borderColor: 'rgba(79,156,249,.85)',
    background: 'rgba(79,156,249,.16)',
  },
  // 「合并为新会话」主按钮：它是这一屏唯一会真的写东西的动作，给个明显的样子。
  btnWeld: {
    padding: '3px 10px',
    borderRadius: 7,
    border: '1px solid rgba(79,156,249,.9)',
    background: 'rgba(79,156,249,.22)',
    color: 'inherit',
    font: 'inherit',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnWeldOff: {
    padding: '3px 10px',
    borderRadius: 7,
    border: '1px solid rgba(128,128,128,.3)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 12,
    cursor: 'not-allowed',
    opacity: 0.45,
  },
  num: {
    width: 48,
    padding: '2px 6px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,.3)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 12,
  },
  tiny: { fontSize: 11.5, opacity: 0.62, whiteSpace: 'nowrap' },
  picker: {
    flex: '0 0 auto',
    maxHeight: 220,
    overflowY: 'auto',
    borderBottom: '1px solid rgba(128,128,128,.22)',
    padding: '4px 0',
  },
  pickRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 12px',
    fontSize: 12.5,
    cursor: 'pointer',
    lineHeight: '18px',
  },
  pickTitle: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pickMeta: { flex: '0 0 auto', fontSize: 11, opacity: 0.55, whiteSpace: 'nowrap' },
  body: { flex: '1 1 auto', minHeight: 0, display: 'flex', overflow: 'hidden' },
  col: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid rgba(128,128,128,.18)',
  },
  colHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    borderBottom: '1px solid rgba(128,128,128,.18)',
    flex: '0 0 auto',
    position: 'sticky',
    top: 0,
    background: 'inherit',
    zIndex: 1,
  },
  colBody: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '6px 0' },
  scroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '6px 0 40px' },
  more: {
    margin: '6px 12px 10px',
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px dashed rgba(128,128,128,.35)',
    fontSize: 11.5,
    opacity: 0.6,
    textAlign: 'center',
  },
  row: {
    display: 'flex',
    gap: 8,
    padding: '5px 12px',
    alignItems: 'flex-start',
  },
  rowRail: { width: 3, borderRadius: 2, alignSelf: 'stretch', flex: '0 0 auto', opacity: 0.85 },
  rowMain: { flex: '1 1 auto', minWidth: 0 },
  rowHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 7,
    fontSize: 11,
    opacity: 0.6,
    marginBottom: 2,
    whiteSpace: 'nowrap',
  },
  rowTag: { fontWeight: 600, opacity: 1 },
  rowText: {
    fontSize: 13,
    lineHeight: '1.55',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    opacity: 0.94,
  },
  rowTextDim: { opacity: 0.62, fontStyle: 'italic' },
  empty: {
    flex: '1 1 auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
    textAlign: 'center',
    fontSize: 13,
    opacity: 0.7,
  },
  err: {
    margin: '8px 12px',
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid rgba(224,92,126,.5)',
    background: 'rgba(224,92,126,.12)',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
  },
  turnGrid: {
    display: 'grid',
    gap: 0,
    alignItems: 'stretch',
  },
  turnCell: {
    padding: '6px 10px',
    borderBottom: '1px solid rgba(128,128,128,.14)',
    minWidth: 0,
    fontSize: 12.5,
  },
  turnIdx: {
    flex: '0 0 auto',
    width: 44,
    padding: '6px 0 6px 10px',
    fontSize: 11,
    opacity: 0.5,
    borderRight: '1px solid rgba(128,128,128,.14)',
  },
}

/* ------------------------------------------------------------------ *
 * 主题与容器填充
 * ------------------------------------------------------------------ */

const THEME_DARK = { bg: '#14161b', fg: '#e6e8ee' }
const THEME_LIGHT = { bg: '#fbfcfd', fg: '#1b1d22' }

/** 从宿主 body 背景亮度推断明暗，决定本视图铺哪套底色（不吃壁纸）。 */
function detectTheme() {
  try {
    const bg = getComputedStyle(document.body).backgroundColor || ''
    const m = bg.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/)
    if (m) {
      const lum = (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255
      if (lum > 0.55) return THEME_LIGHT
    }
  } catch {
    /* 忽略 */
  }
  return THEME_DARK
}

let styleInjected = false

/** 注入本视图的 CSS（幂等）。只做两件事：滚动条外观 + 「填满会话主体」的定位规则。 */
function ensureStyle() {
  if (styleInjected || typeof document === 'undefined') return
  styleInjected = true
  const el = document.createElement('style')
  el.setAttribute('data-dsh-union-view', '')
  el.textContent = [
    // 默认相对定位；拿到「填满」标记后绝对定位铺满会话主体。
    // dsh 的视图区 .wSkVaW_viewArea 是 flex:1 0 auto（跟着内容长），原生滚动在外层
    // .wSkVaW_scrollBody —— 不铺满的话 400 条消息会把会话区撑到 11 万像素，整页滚动。
    '[data-union-view]{position:relative}',
    // 底部让出输入席（composer）的高度：输入席在会话主体里是更高的浮层，
    // 硬拼 z-index 只会打架，直接把可用区域缩到它上面更干净。
    '[data-union-view][data-union-fill]{position:absolute;inset:0 0 152px 0;z-index:20;border-radius:0}',
    '[data-union-view] ::-webkit-scrollbar{width:9px;height:9px}',
    '[data-union-view] ::-webkit-scrollbar-thumb{background:rgba(128,128,128,.42);border-radius:9px}',
    '[data-union-view] ::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.62)}',
    '[data-union-view] ::-webkit-scrollbar-track{background:transparent}',
  ].join('\n')
  document.head.appendChild(el)
}

function cx() {
  const out = {}
  for (let i = 0; i < arguments.length; i += 1) {
    const a = arguments[i]
    if (!a) continue
    for (const k in a) out[k] = a[k]
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 文本提取（对未知形状全部兜底，绝不因为字段缺失抛错）
 * ------------------------------------------------------------------ */

function str(v) {
  return typeof v === 'string' ? v : ''
}

/** 单个内容块 → 纯文本。兼容 {type:'text',text} / {kind:'text',text} / 字符串。 */
function blockText(b) {
  if (b == null) return ''
  if (typeof b === 'string') return b
  if (Array.isArray(b)) return b.map(blockText).join('')
  const k = str(b.type) || str(b.kind)
  // 思考过程不进视图：reasoning 块自己带 text 字段，
  // 必须先按 kind 拦掉，否则下面那句 str(b.text) 会把它当成正文吐出来。
  if (k === 'reasoning') return ''
  if (k === 'tool-call') return '[调用 ' + (str(b.name) || '工具') + ']'
  if (k === 'tool-result') return ''
  if (k === 'image') return '[图片]'
  const t = str(b.text)
  if (t) return t
  if (k === 'text') return ''
  const c = str(b.content)
  if (c) return c
  return ''
}

function textOfContent(blocks) {
  if (!blocks) return ''
  const arr = Array.isArray(blocks) ? blocks : [blocks]
  return arr.map(blockText).join('').trim()
}

function textOfAssistant(blocks) {
  if (!blocks || !Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    const k = str(b && b.kind) || str(b && b.type)
    if (k === 'tool-call') {
      const name = str(b.name)
      let args = str(b.argsRaw)
      if (args.length > 120) args = args.slice(0, 120) + '…'
      parts.push('[调用 ' + (name || '工具') + (args ? ' ' + args : '') + ']')
      continue
    }
    const t = blockText(b)
    if (t) parts.push(t)
  }
  return parts.join('\n').trim()
}

function timeOf(node) {
  const t = node && node.time
  return typeof t === 'number' && isFinite(t) ? t : 0
}

function fmtClock(t) {
  if (!t) return ''
  try {
    const d = new Date(t)
    const p = (n) => (n < 10 ? '0' + n : String(n))
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  } catch {
    return ''
  }
}

function fmtDay(t) {
  if (!t) return ''
  try {
    const d = new Date(t)
    return (d.getMonth() + 1) + '/' + d.getDate()
  } catch {
    return ''
  }
}

function fmtAgo(t) {
  if (!t) return ''
  const diff = Date.now() - t
  if (!isFinite(diff) || diff < 0) return ''
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  const d = Math.floor(h / 24)
  if (d < 30) return d + ' 天前'
  return fmtDay(t)
}

function shortId(id) {
  const s = String(id || '')
  return s.length > 14 ? s.slice(0, 8) + '…' + s.slice(-4) : s
}

/* ------------------------------------------------------------------ *
 * 节点 → 展示行
 * ------------------------------------------------------------------ */

const SYSTEM_KINDS = {
  'tool-result': '工具',
  command: '命令',
  compaction: '压缩',
  context: '上下文',
  'model-retry': '重试',
  'turn-error': '出错',
  'turn-max-tokens': '截断',
  'turn-tail': '轮次',
}

function describeNode(node) {
  const kind = str(node && node.kind) || 'unknown'
  if (kind === 'user') {
    return { role: 'user', tag: '你', text: textOfContent(node.content), system: false }
  }
  if (kind === 'assistant') {
    return { role: 'ai', tag: 'AI', text: textOfAssistant(node.blocks), system: false }
  }
  if (kind === 'steering') {
    return { role: 'user', tag: '插话', text: textOfContent(node.content), system: false }
  }
  if (kind === 'tool-result') {
    let t = str(node.text) || str(node.output)
    if (!t) {
      try {
        t = JSON.stringify(node.data !== undefined ? node.data : node).slice(0, 400)
      } catch {
        t = ''
      }
    }
    return { role: 'tool', tag: '工具', text: t, system: true }
  }
  if (kind === 'command') {
    const t = str(node.command) || str(node.text) || str(node.name) || ''
    return { role: 'sys', tag: '命令', text: t, system: true }
  }
  if (kind === 'compaction') {
    const t = str(node.summary) || str(node.topic) || ''
    return { role: 'sys', tag: '压缩', text: t, system: true }
  }
  if (kind === 'context') {
    return { role: 'sys', tag: '上下文', text: textOfContent(node.content), system: true }
  }
  if (kind === 'turn-error') {
    return { role: 'sys', tag: '出错', text: str(node.message) || str(node.text), system: true }
  }
  return {
    role: 'sys',
    tag: SYSTEM_KINDS[kind] || kind,
    text: '',
    system: true,
  }
}

/* ------------------------------------------------------------------ *
 * ObservableSnapshot 订阅（不依赖 useSyncExternalStore，兼容 React 18/19）
 * ------------------------------------------------------------------ */

function useSource(source) {
  const [value, setValue] = useState(() => {
    try {
      return source ? source.getSnapshot() : undefined
    } catch {
      return undefined
    }
  })
  useEffect(() => {
    if (!source) {
      setValue(undefined)
      return undefined
    }
    let alive = true
    const read = () => {
      if (!alive) return
      let v
      try {
        v = source.getSnapshot()
      } catch {
        v = undefined
      }
      setValue(v)
    }
    read()
    let un
    try {
      un = source.subscribe(read)
    } catch {
      un = undefined
    }
    return () => {
      alive = false
      if (typeof un === 'function') {
        try {
          un()
        } catch {
          /* 忽略 */
        }
      }
    }
  }, [source])
  return value
}

/* ------------------------------------------------------------------ *
 * 会话目录
 * ------------------------------------------------------------------ */

function useCatalog(sessions) {
  const list = useSource(sessions ? sessions.list : undefined)
  return useMemo(() => {
    if (!list) return []
    const ids = Array.isArray(list.ids) ? list.ids : []
    const byId = list.byId || {}
    const rows = []
    for (const id of ids) {
      const meta = byId[id] || {}
      rows.push({
        id,
        title: str(meta.displayTitle) || str(meta.title) || shortId(id),
        cwd: str(meta.cwd),
        running: meta.running === true,
        blank: meta.blank === true,
        updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
      })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows
  }, [list])
}

/* ------------------------------------------------------------------ *
 * 联合数据：retain N 个会话 → 订阅 chat target → 汇总节点
 * ------------------------------------------------------------------ */

/**
 * @param {{ sessions: any, uiConversation: any } | undefined} api
 * @param {string[]} ids
 * @returns {{ phase: 'idle'|'loading'|'ready', cols: Array<object>, errors: string[] }}
 */
function useUnion(api, ids, reloadToken) {
  const [state, setState] = useState({ phase: 'idle', cols: [], errors: [] })
  const key = ids.join('|')

  useEffect(() => {
    if (!api || !api.sessions || !api.uiConversation) {
      setState({ phase: 'idle', cols: [], errors: [] })
      return undefined
    }
    if (ids.length === 0) {
      setState({ phase: 'idle', cols: [], errors: [] })
      return undefined
    }

    let alive = true
    const refs = []
    const unsubs = []
    /** @type {Map<string, any>} */
    const cols = new Map()
    const errors = []
    let live = 0

    const flush = () => {
      if (!alive) return
      const list = []
      ids.forEach((id, i) => {
        const c = cols.get(id)
        if (c) {
          c.color = COLORS[i % COLORS.length]
          list.push(c)
        }
      })
      setState({
        phase: live >= ids.length ? 'ready' : 'loading',
        cols: list,
        errors: errors.slice(0, 4),
      })
    }

    /** 从 ChatSnapshot 取节点数组：优先 legacy.nodes，退化为 order+nodes 的 kind 列表。 */
    const nodesOf = (snap) => {
      if (!snap) return []
      const legacy = snap.legacy
      if (legacy && Array.isArray(legacy.nodes) && legacy.nodes.length > 0) {
        return legacy.nodes
      }
      const order = Array.isArray(snap.order) ? snap.order : []
      const store = snap.nodes
      if (!store || order.length === 0) return []
      const out = []
      for (const k of order) {
        let n
        try {
          n = store.get(k)
        } catch {
          n = undefined
        }
        if (!n) continue
        out.push({
          kind: str(n.kind) || 'unknown',
          seq: typeof n.anchorSeq === 'number' ? n.anchorSeq : 0,
          time: 0,
          content: n.data && n.data.blocks ? n.data.blocks : undefined,
          blocks: n.data && n.data.blocks ? n.data.blocks : undefined,
          __synthetic: true,
        })
      }
      return out
    }

    const attach = (id) => {
      const col = {
        id,
        title: titleOf(id),
        color: COLORS[0],
        nodes: [],
        status: 'loading',
        error: '',
      }
      cols.set(id, col)
      return col
    }

    const titleOf = (id) => {
      try {
        const snap = api.sessions.list.getSnapshot()
        const meta = snap && snap.byId ? snap.byId[id] : undefined
        const t = (meta && (str(meta.displayTitle) || str(meta.title))) || ''
        return t || shortId(id)
      } catch {
        return shortId(id)
      }
    }

    /** 等待就绪，超时返回 undefined（会话打不开时不能让整个循环卡死）。 */
    const waitReady = (p) =>
      new Promise((resolve) => {
        let done = false
        const finish = (v) => {
          if (done) return
          done = true
          resolve(v)
        }
        const timer = window.setTimeout(() => finish(undefined), READY_TIMEOUT_MS)
        timers.push(timer)
        Promise.resolve(p).then(
          (v) => {
            window.clearTimeout(timer)
            finish(v)
          },
          () => {
            window.clearTimeout(timer)
            finish(undefined)
          },
        )
      })

    /** @type {number[]} */
    const timers = []

    const run = async () => {
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i]
        try {
          const ref = api.sessions.retain(id, { source: SOURCE })
          refs.push(ref)
          attach(id)
          flush()

          const binding = await waitReady(ref.ready)
          if (!binding) throw new Error('打开会话超时')
          const conv = api.uiConversation.binding(binding)
          const src = conv.target('chat')

          const read = () => {
            if (!alive) return
            let snap
            try {
              snap = src.getSnapshot()
            } catch {
              snap = undefined
            }
            const c = cols.get(id)
            if (!c) return
            c.nodes = nodesOf(snap)
            c.status = 'ok'
            flush()
          }

          // 先订阅再读：首个 subscriber 会激活 chat target 并触发历史加载
          let un
          try {
            un = src.subscribe(read)
          } catch {
            un = undefined
          }
          if (typeof un === 'function') unsubs.push(un)
          read()

          live += 1
          flush()
        } catch (e) {
          const msg = (e && e.message) || String(e)
          errors.push(shortId(id) + '：' + msg)
          const c = cols.get(id)
          if (c) {
            c.status = 'error'
            c.error = msg
          }
          live += 1
          flush()
        }
      }
    }

    run()

    const guard = window.setTimeout(() => {
      if (!alive) return
      if (live < ids.length) {
        live = ids.length
        flush()
      }
    }, READY_TIMEOUT_MS)
    timers.push(guard)

    return () => {
      alive = false
      for (const t of timers) {
        try {
          window.clearTimeout(t)
        } catch {
          /* 忽略 */
        }
      }
      for (const un of unsubs) {
        try {
          un()
        } catch {
          /* 忽略 */
        }
      }
      for (const r of refs) {
        try {
          r.release()
        } catch {
          /* 忽略 */
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, reloadToken])

  return state
}

/* ------------------------------------------------------------------ *
 * 三种布局
 * ------------------------------------------------------------------ */

// 轮次对齐每格只放这么多条预览：一轮里可能有几百条工具节点，
// 全渲染进 grid 会把单行撑到几万像素高（实测 1354 条 → 会话区 119 万像素）。
const CELL_PREVIEW = 3
const TURN_LIMIT = 120

function Rail(props) {
  return h('div', { style: cx(S.rowRail, { background: props.color }) })
}

function MessageRow(props) {
  const { color, sessionTitle, node, showSystem, showSession, dense } = props
  const d = describeNode(node)
  if (d.system && !showSystem) return null
  const clock = fmtClock(timeOf(node))
  const empty = d.text === ''
  return h(
    'div',
    { style: cx(S.row, { paddingLeft: dense ? 8 : 12, paddingRight: dense ? 8 : 12 }) },
    h(Rail, { color }),
    h(
      'div',
      { style: S.rowMain },
      h(
        'div',
        { style: S.rowHead },
        showSession ? h('span', { style: cx(0, { color, fontWeight: 700, opacity: 0.95 }) }, sessionTitle) : null,
        h('span', { style: cx({ fontWeight: 600 }, d.role === 'user' ? { color } : null) }, d.tag),
        clock ? h('span', null, clock) : null,
      ),
      empty
        ? null
        : h('div', { style: cx(S.rowText, d.system ? S.rowTextDim : null) }, d.text),
    ),
  )
}

function ColumnBody(props) {
  const { col, showSystem } = props
  if (col.status === 'loading' && col.nodes.length === 0) {
    return h('div', { style: { padding: '10px 12px', fontSize: 12, opacity: 0.55 } }, '载入中…')
  }
  if (col.status === 'error') {
    return h('div', { style: { padding: '10px 12px', fontSize: 12, opacity: 0.7 } }, '无法读取：' + col.error)
  }
  if (col.nodes.length === 0) {
    return h('div', { style: { padding: '10px 12px', fontSize: 12, opacity: 0.55 } }, '（没有可见消息）')
  }
  const shown = col.nodes.length > ROW_LIMIT ? col.nodes.slice(col.nodes.length - ROW_LIMIT) : col.nodes
  const folded = col.nodes.length - shown.length
  return [
    folded > 0
      ? h('div', { key: 'folded', style: { padding: '6px 12px', fontSize: 11, opacity: 0.55 } },
          '更早的 ' + folded + ' 条已折叠')
      : null,
    ...shown.map((node, i) =>
      h(MessageRow, {
        key: (node.seq || i) + ':' + i,
        color: col.color,
        sessionTitle: col.title,
        node,
        showSystem,
        showSession: false,
      }),
    ),
  ]
}

function ColumnsLayout(props) {
  const { cols, showSystem } = props
  return h(
    'div',
    { style: cx(S.body, { overflowX: 'auto' }) },
    cols.map((col) =>
      h(
        'div',
        { key: col.id, style: cx(S.col, { minWidth: 240, flexBasis: 0 }) },
        h(
          'div',
          { style: S.colHead },
          h('span', { style: cx(S.dot, { background: col.color }) }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, col.title),
          h('span', { style: { opacity: 0.5, fontWeight: 400, fontSize: 11 } }, String(col.nodes.length)),
        ),
        h('div', { style: S.colBody }, h(ColumnBody, { col, showSystem })),
      ),
    ),
  )
}

function TimelineLayout(props) {
  const { cols, showSystem } = props
  const rows = useMemo(() => {
    const all = []
    for (const col of cols) {
      for (const node of col.nodes) {
        all.push({ col, node })
      }
    }
    all.sort((a, b) => {
      const ta = timeOf(a.node)
      const tb = timeOf(b.node)
      if (ta !== tb) return ta - tb
      return (a.node.seq || 0) - (b.node.seq || 0)
    })
    return all
  }, [cols])

  if (rows.length === 0) {
    return h('div', { style: S.empty }, h('div', null, '还没有可显示的消息'))
  }
  const shown = rows.length > ROW_LIMIT ? rows.slice(rows.length - ROW_LIMIT) : rows
  const folded = rows.length - shown.length
  return h(
    'div',
    { style: S.scroll },
    folded > 0
      ? h('div', { style: S.more }, '更早的 ' + folded + ' 条已折叠（时间线只渲染最近 ' + ROW_LIMIT + ' 条）')
      : null,
    shown.map((r, i) =>
      h(MessageRow, {
        key: r.col.id + ':' + (r.node.seq || 0) + ':' + i,
        color: r.col.color,
        sessionTitle: r.col.title,
        node: r.node,
        showSystem,
        showSession: true,
        dense: true,
      }),
    ),
  )
}

/** 按「用户发言」切轮：每个会话切成 turns[N] = 该轮内所有节点。 */
function splitTurns(nodes) {
  const turns = []
  let cur = null
  for (const node of nodes) {
    const kind = str(node.kind)
    const isStart = kind === 'user'
    if (isStart || cur === null) {
      cur = { index: turns.length, nodes: [] }
      turns.push(cur)
    }
    cur.nodes.push(node)
  }
  return turns
}

function TurnsLayout(props) {
  const { cols, showSystem, bg } = props
  const perCol = useMemo(() => cols.map((c) => ({ col: c, turns: splitTurns(c.nodes) })), [cols])
  const maxTurns = useMemo(() => perCol.reduce((m, p) => Math.max(m, p.turns.length), 0), [perCol])

  if (maxTurns === 0) {
    return h('div', { style: S.empty }, h('div', null, '还没有可对齐的轮次'))
  }

  const gridStyle = cx(S.turnGrid, {
    gridTemplateColumns: '44px repeat(' + perCol.length + ', minmax(0, 1fr))',
    minWidth: perCol.length * 220 + 44,
  })
  // 外层是唯一的 grid；所有行都用 display:contents 把自己的格子直接交给它。
  // 如果某一行自带 gridTemplateColumns（而不是 contents），它自己只占第一列 44px，
  // 后面每行用 contents 进来就会塌成内容宽度（实测左列被挤到 55px、正文竖排）。
  const headCell = { position: 'sticky', top: 0, zIndex: 2, background: bg }

  const out = []
  out.push(
    h(
      'div',
      { key: 'head', style: { display: 'contents' } },
      h('div', { style: cx(S.turnIdx, headCell, { borderRight: 'none' }) }, '#'),
      ...perCol.map((p) =>
        h(
          'div',
          { key: p.col.id, style: cx(S.turnCell, headCell, { fontWeight: 600, fontSize: 12, borderBottom: '1px solid rgba(128,128,128,.28)' }) },
          h('span', { style: cx(S.dot, { background: p.col.color, display: 'inline-block', marginRight: 6 }) }),
          p.col.title,
        ),
      ),
    ),
  )

  const start = maxTurns > TURN_LIMIT ? maxTurns - TURN_LIMIT : 0
  if (start > 0) {
    out.push(
      h(
        'div',
        { key: 'folded', style: { gridColumn: '1 / -1' } },
        h('div', { style: { padding: '6px 12px', fontSize: 11.5, opacity: 0.6, textAlign: 'center' } },
          '更早的 ' + start + ' 轮已折叠（只渲染最近 ' + TURN_LIMIT + ' 轮）'),
      ),
    )
  }
  for (let t = start; t < maxTurns; t += 1) {
    out.push(
      h(
        'div',
        { key: 'r' + t, style: { display: 'contents' } },
        h('div', { key: 'i', style: S.turnIdx }, String(t + 1)),
        ...perCol.map((p) => {
          const turn = p.turns[t]
          if (!turn) {
            return h('div', { key: p.col.id, style: cx(S.turnCell, { opacity: 0.28 }) }, '·')
          }
          const shown = turn.nodes.filter((n) => {
            const d = describeNode(n)
            return showSystem || !d.system
          })
          return h(
            'div',
            { key: p.col.id, style: S.turnCell },
            shown.length === 0
              ? h('span', { style: { opacity: 0.3 } }, '—')
              : [
                  ...shown.slice(0, CELL_PREVIEW).map((n, j) => {
                    const d = describeNode(n)
                    return h(
                      'div',
                      { key: j, style: { marginBottom: 4 } },
                      h('div', { style: cx({ fontSize: 10.5, opacity: 0.55, marginBottom: 1 }) }, d.tag),
                      h('div', { style: cx(S.rowText, { fontSize: 12.5 }, d.system ? S.rowTextDim : null) },
                        d.text.length > 240 ? d.text.slice(0, 240) + '…' : d.text),
                    )
                  }),
                  shown.length > CELL_PREVIEW
                    ? h('div', { key: 'more', style: { fontSize: 11, opacity: 0.5 } },
                        '…还有 ' + (shown.length - CELL_PREVIEW) + ' 条')
                    : null,
                ],
          )
        }),
      ),
    )
  }

  return h('div', { style: cx(S.scroll, { overflowX: 'auto' }) }, h('div', { style: gridStyle }, out))
}

/* ------------------------------------------------------------------ *
 * 会话选择器
 * ------------------------------------------------------------------ */

function Picker(props) {
  const { rows, selected, onToggle, onClear } = props
  if (rows.length === 0) {
    return h('div', { style: S.picker }, h('div', { style: { padding: '8px 12px', fontSize: 12, opacity: 0.6 } }, '没有可用会话'))
  }
  return h(
    'div',
    { style: S.picker },
    rows.map((row) => {
      const on = selected.indexOf(row.id) >= 0
      const idx = selected.indexOf(row.id)
      return h(
        'div',
        {
          key: row.id,
          style: cx(S.pickRow, on ? { background: 'rgba(79,156,249,.1)' } : null),
          onClick: () => onToggle(row.id),
          title: row.cwd || row.id,
        },
        h(
          'span',
          {
            style: cx({
              width: 14,
              height: 14,
              borderRadius: 4,
              border: '1px solid rgba(128,128,128,.55)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              flex: '0 0 auto',
            }, on ? { background: COLORS[idx % COLORS.length], borderColor: 'transparent', color: '#fff' } : null),
          },
          on ? '✓' : '',
        ),
        row.running ? h('span', { style: cx(S.dot, { background: '#3fb98a' }) }) : null,
        h('span', { style: S.pickTitle }, row.title),
        h('span', { style: S.pickMeta }, fmtAgo(row.updatedAt)),
      )
    }),
  )
}

/* ------------------------------------------------------------------ *
 * 主组件
 * ------------------------------------------------------------------ */

function UnionView(props) {
  const api = props && props.api
  // 会话列表默认收起：选中会话之后它只是干扰，点「选择会话」再展开。
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState(() => {
    try {
      const raw = window.localStorage.getItem(LS_KEY)
      if (raw) {
        const saved = JSON.parse(raw)
        if (saved && typeof saved.layout === 'string') return saved.layout
      }
    } catch {
      /* 忽略 */
    }
    return 'timeline'
  })
  const [selected, setSelected] = useState(() => {
    try {
      const raw = window.localStorage.getItem(LS_KEY)
      if (raw) {
        const saved = JSON.parse(raw)
        if (saved && Array.isArray(saved.ids)) return saved.ids.slice(0, MAX_SESSIONS)
      }
    } catch {
      /* 忽略 */
    }
    return []
  })
  const [showSystem, setShowSystem] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  // 合并时每个源取最近多少轮。给默认值而不是留空：长会话全量合并会直接顶满模型窗口。
  const [turns, setTurns] = useState(20)
  const [weldNote, setWeldNote] = useState('')

  const catalog = useCatalog(api && api.sessions)
  const union = useUnion(api, selected, reloadToken)

  // 底色：自己铺一层不透明底，避免壁纸从面板底下透上来（dsh 的输入席/会话底是透明的）。
  const theme = useMemo(() => detectTheme(), [])
  const rootStyle = useMemo(
    () => ({ ...S.root, background: theme.bg, color: theme.fg }),
    [theme],
  )
  const rootRef = useRef(null)
  useEffect(() => {
    ensureStyle()
    const el = rootRef.current
    if (!el) return undefined
    // 向上找最近的「定位祖先」：dsh 的 .wSkVaW_body 是 position:relative，高度正好是会话主体高度。
    // 中间那两三层 display:contents 包装是 static 且零高，跳过。
    let host = el.parentElement
    while (host && host !== document.body && getComputedStyle(host).position === 'static') {
      host = host.parentElement
    }
    if (!host || host === document.body) return undefined
    el.setAttribute('data-union-fill', '')
    return () => el.removeAttribute('data-union-fill')
  }, [])

  // 持久化选择
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify({ ids: selected, layout }))
    } catch {
      /* 忽略 */
    }
  }, [selected, layout])

  const toggle = useCallback((id) => {
    setSelected((prev) => {
      if (prev.indexOf(id) >= 0) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_SESSIONS) return prev
      return prev.concat([id])
    })
  }, [])

  const clear = useCallback(() => setSelected([]), [])

  // 「合并为新会话」：不自己造会话，而是替用户把 /weld 命令写进输入框并提交。
  // 走命令而不是直连后端，是因为 /weld 在 Node 半边、又必须拿到 workspaceRegistry
  // 才能把新会话登记进侧栏账本；这些都在命令进程里现成的。
  const weldNow = useCallback(() => {
    const actions = props && props.inputActions
    if (!actions || selected.length < 2) return
    if (typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') {
      setWeldNote('这个版本的宿主没有暴露 setDraft/submit，请手动输入 /weld')
      return
    }
    const cmd = `/weld ${selected.join(' ')} --turns ${turns}`
    actions.setDraft(cmd)
    actions.submit()
    setWeldNote(`已提交：${selected.length} 个会话 · 每个取最近 ${turns} 轮。等侧栏出现「未命名」再点开。`)
    // 焊接是后端命令，写完文件后侧栏不会自己重拉；这里补一次刷新，省掉手动刷页面。
    setTimeout(() => {
      try {
        api?.refreshSessions?.()
      } catch {
        /* 刷新失败不影响焊接本身 */
      }
    }, 3000)
  }, [props, selected, turns])

  const body = (() => {
    if (!api || !api.sessions || !api.uiConversation) {
      return h('div', { style: S.empty }, h('div', null, '宿主未暴露 sessions / uiConversation 服务'))
    }
    if (selected.length === 0) {
      return h(
        'div',
        { style: S.empty },
        h('div', { style: { fontSize: 14, fontWeight: 600, opacity: 0.9 } }, '选择一个或多个会话'),
        h('div', { style: { maxWidth: 460, lineHeight: 1.6 } },
          '联合视图只读取这些会话的转录并拼在一起：不写日志、不进模型上下文、不改动任何会话状态。',
          '在下面的列表里点选即可（最多 ' + MAX_SESSIONS + ' 个）。'),
      )
    }
    if (union.phase === 'loading' && union.cols.every((c) => c.nodes.length === 0)) {
      return h('div', { style: S.empty }, h('div', null, '正在打开 ' + selected.length + ' 个会话的转录…'))
    }
    if (layout === 'columns') return h(ColumnsLayout, { cols: union.cols, showSystem })
    if (layout === 'turns') return h(TurnsLayout, { cols: union.cols, showSystem, bg: theme.bg })
    return h(TimelineLayout, { cols: union.cols, showSystem })
  })()

  const totalRows = union.cols.reduce((n, c) => n + c.nodes.length, 0)

  return h(
    'div',
    { ref: rootRef, 'data-union-view': '', style: rootStyle },
    h(
      'div',
      { style: S.bar },
      h('span', { style: S.barTitle }, '联合视图'),
      h('span', { style: { fontSize: 11.5, opacity: 0.55 } },
        selected.length + ' 个会话 · ' + totalRows + ' 条消息 · 只读'),
      h('span', { style: S.barSpacer }),
      ...LAYOUTS.map((l) =>
        h(
          'button',
          {
            key: l.id,
            type: 'button',
            title: l.hint,
            style: cx(S.btn, layout === l.id ? S.btnOn : null),
            onClick: () => setLayout(l.id),
          },
          l.label,
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          title: '显示/隐藏工具调用、压缩、命令等系统事件',
          style: cx(S.btn, showSystem ? S.btnOn : null),
          onClick: () => setShowSystem((v) => !v),
        },
        '系统事件',
      ),
      h(
        'button',
        {
          type: 'button',
          title: '重新读取选中会话',
          style: S.btn,
          onClick: () => setReloadToken((v) => v + 1),
        },
        '刷新',
      ),
      h(
        'button',
        {
          type: 'button',
          title: open ? '收起会话列表' : '展开会话列表',
          style: cx(S.btn, open ? S.btnOn : null),
          onClick: () => setOpen((v) => !v),
        },
        '选择会话',
      ),
      selected.length > 0
        ? h('button', { type: 'button', style: S.btn, onClick: clear }, '清空')
        : null,
      h('span', { style: S.barSpacer }),
      h('span', { style: S.tiny }, '每个取最近'),
      h('input', {
        type: 'number',
        min: 1,
        max: 500,
        value: turns,
        style: S.num,
        onChange: (e) => {
          const n = Number(e.target.value)
          setTurns(Number.isFinite(n) ? Math.max(1, Math.min(500, Math.round(n))) : 1)
        },
      }),
      h('span', { style: S.tiny }, '轮 →'),
      h(
        'button',
        {
          type: 'button',
          disabled: selected.length < 2,
          title:
            selected.length < 2
              ? '至少要选两个会话'
              : '把这些会话的历史装进一个新会话，原会话一个字不改',
          style: selected.length >= 2 ? S.btnWeld : S.btnWeldOff,
          onClick: weldNow,
        },
        '合并为新会话',
      ),
    ),
    weldNote ? h('div', { style: S.tiny }, weldNote) : null,
    open
      ? h(Picker, { rows: catalog, selected, onToggle: toggle, onClear: clear })
      : null,
    union.errors.length > 0
      ? h('div', { style: S.err }, union.errors.join('\n'))
      : null,
    body,
  )
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

const name = 'dsh-union-view'
// 必需服务：slots 用来注册视图；sessions / uiConversation 读别的会话转录。
// 不写进来，cordis 不会把这两个服务挂到本插件的 ctx 上（拿到的永远是 undefined）。
const inject = ['slots', 'sessions', 'uiConversation']

/**
 * @param {any} ctx - client 根上下文。
 */
function apply(ctx) {
  if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return

  // 延迟解析服务：apply 时机早于某些服务就绪，用 getter 避免 undefined 固化。
  const api = {
    get sessions() {
      try {
        return ctx.sessions
      } catch {
        return undefined
      }
    },
    get uiConversation() {
      try {
        return ctx.uiConversation
      } catch {
        return undefined
      }
    },
    // /weld 是后端命令，写完文件后宿主不一定立刻重拉会话列表；
    // 合并按钮提交几秒后主动刷一次，用户不用手动刷新页面。
    refreshSessions() {
      try {
        return ctx.sessions?.refresh?.()
      } catch {
        return undefined
      }
    },
  }

  ctx.slots.inject('conversation.view', () => {
    let dispose = null
    const register = () => {
      dispose = ctx.slots.register(
        {
          name: 'conversation.view',
          id: VIEW_ID,
          order: VIEW_ORDER,
          label: () => '联合视图',
          inject: () => ({ api }),
        },
        UnionView,
      )
    }
    register()
    return () => {
      if (dispose !== null) {
        try {
          dispose()
        } catch {
          /* 忽略 */
        }
        dispose = null
      }
    }
  })
}

module.exports = { name, inject, apply }
		return module.exports;
	}
});
