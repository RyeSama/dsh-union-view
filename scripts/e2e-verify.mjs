// 端到端验收：新实例 → 开会话 → 切「联合视图」→ 选 N 个会话 → 三布局截图 + 断言
// 交互统一走合成 click（button / 会话行 / 面板行都吃 onClick）；只有会话行需要真鼠标时才退回 CDP。
import { writeFileSync } from 'node:fs'

const HTTP_PORT = process.argv[2] || '63499'
const CDP_PORT = process.argv[3] || '53015'
const TOKEN = process.argv[4]
const SESSION_TITLE = process.argv[5] || '长上下文自动总结优化'
const PICKS = (process.argv[6] || '长上下文自动总结优化|数控雕刻文件任务指导').split('|')
const OUT = 'D:\\dsh-workspace\\dsh-union-view\\e2e'
const URL_TARGET = `http://127.0.0.1:${HTTP_PORT}/?token=${TOKEN}`

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('edge://'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true })
  ws.addEventListener('error', j, { once: true })
})
let seq = 0
const pending = new Map()
const logs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    logs.push('[exception] ' + (d.exception?.description || d.text))
  }
  if (m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type)) {
    logs.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
  }
})
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
  return r.result.value
}
const click = async (x, y) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(60)
  }
}
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}-${name}.png`, Buffer.from(s.data, 'base64'))
  console.log('   shot → e2e-' + name + '.png')
}
const state = () =>
  ev(`(() => {
  const root = document.querySelector('[data-union-view]')
  return {
    tab: (() => { const t = [...document.querySelectorAll('[role=tab]')].find(x => (x.textContent||'').trim() === '联合视图'); return t ? t.getAttribute('aria-selected') : null })(),
    hasRoot: !!root,
    h: root ? Math.round(root.getBoundingClientRect().height) : null,
    bg: root ? getComputedStyle(root).backgroundColor : null,
    stat: root ? ((root.innerText.slice(0, 120).match(/\\d+ 个会话 · \\d+ 条消息/) || [])[0] || null) : null,
    err: root ? ((root.innerText.slice(0, 200).match(/宿主未暴露[^\\n]*|无法读取[^\\n]*/) || [])[0] || null) : null,
  }
})()`)

await send('Runtime.enable')
await send('Page.enable')

console.log('[1] navigate')
await send('Page.navigate', { url: URL_TARGET })
await sleep(4500)
await ev(`(() => { const r=document.getElementById('dsh-startup-root'); if(r) r.remove(); document.documentElement.classList.remove('dsu-lock'); if(document.body) document.body.style.overflow=''; return !!r })()`)
await sleep(1800)

console.log('[2] dismiss notice')
await ev(`(() => {
  const cb = [...document.querySelectorAll('input[type=checkbox]')].find(c => (c.closest('div,label')?.innerText || '').includes('我已阅读'))
  if (cb && !cb.checked) cb.click()
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('我已知晓并继续') && !b.disabled)
  if (btn) btn.click()
  return true
})()`)
await sleep(1000)

console.log('[3] close stray panels')
await ev(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const x = [...document.querySelectorAll('[aria-label*="关闭"],button')].find(b => /^(关闭|×|✕)$/.test((b.textContent||'').trim()))
  if (x) x.click()
  return document.querySelectorAll('[role=tab]').length
})()`)
await sleep(600)

console.log('[4] open session:', SESSION_TITLE)
const opened = await ev(`(() => {
  const leaf = [...document.querySelectorAll('span')].find(e => (e.textContent||'').trim() === ${JSON.stringify(SESSION_TITLE)})
  if (!leaf) return 'no-leaf'
  const row = leaf.closest('[class*=sessionRow]') || leaf.parentElement.parentElement
  row.click()
  return 'clicked'
})()`)
console.log('   ', opened)
await sleep(2500)
// 合成 click 不生效时退回真鼠标
if (!(await state()).hasRoot && !(await ev(`document.body.innerText.includes('对话')`))) {
  const r = await ev(`(() => {
    const leaf = [...document.querySelectorAll('span')].find(e => (e.textContent||'').trim() === ${JSON.stringify(SESSION_TITLE)})
    if (!leaf) return null
    const b = (leaf.closest('[class*=sessionRow]') || leaf.parentElement).getBoundingClientRect()
    return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) }
  })()`)
  if (r) {
    await click(r.x, r.y)
    await sleep(2500)
  }
}

console.log('[5] switch tab')
console.log('   tab:', await ev(`(() => {
  const t = [...document.querySelectorAll('[role=tab]')].find(x => (x.textContent||'').trim() === '联合视图')
  if (!t) return 'no-tab'
  t.click(); return 'clicked'
})()`))
await sleep(1800)
console.log('   state:', JSON.stringify(await state()))
await shot('v-start')

console.log('[6] picker + picks')
console.log('   open:', await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '选择会话')
  if (!b) return 'no-btn'
  b.click(); return 'clicked'
})()`))
await sleep(700)
// 先清空，避免上一次会话留在 localStorage 里导致 toggle 变成「取消选中」
console.log('   clear:', await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '清空')
  if (!b) return 'no-clear'
  b.click(); return 'cleared'
})()`))
await sleep(800)
for (const want of PICKS) {
  const r = await ev(`(() => {
    const root = document.querySelector('[data-union-view]')
    if (!root) return 'no-root'
    const hit = [...root.querySelectorAll('div,span,li,button,label')].find(e => (e.textContent||'').trim() === ${JSON.stringify(want)} && e.offsetParent)
    if (!hit) return 'no-row'
    ;(hit.closest('div') || hit).click()
    return 'ok'
  })()`)
  console.log('   pick', want, '→', r)
  await sleep(2600)
}
await sleep(1000)
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '选择会话'); if (b) b.click(); return true })()`)
await sleep(900)

console.log('[7] state', JSON.stringify(await state()))
for (const [label, name] of [['时间线', 'v-timeline'], ['分栏', 'v-columns'], ['轮次对齐', 'v-turns']]) {
  const ok = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === ${JSON.stringify(label)})
    if (!b) return 'missing'
    b.click(); return 'ok'
  })()`)
  await sleep(1100)
  console.log('   layout', label, '→', ok, JSON.stringify(await state()))
  await shot(name)
}
if (logs.length) console.log('---- logs ----\n' + logs.slice(-15).join('\n'))
ws.close()
