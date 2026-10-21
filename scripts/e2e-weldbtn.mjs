// 验证「合并为新会话」按钮：选两个会话 → 点按钮 → 看侧栏是否出现新会话。
// 用法: node scripts/e2e-weldbtn.mjs <httpPort> <cdpPort> <token>
import { writeFileSync } from 'node:fs'

const [httpPort, cdpPort, token] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.logs = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.logs.push('[exc] ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 300))
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.logs.push('[console] ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
}

const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
const cdp = new CDP(ws)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

async function shot(n) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(n, Buffer.from(data, 'base64'))
  console.log('  shot ->', n)
}

async function clickAt(x, y) {
  const base = { x, y, button: 'left', clickCount: 1, buttons: 1 }
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 })
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
  await cdp.eval(`
    (function(){
      const el = document.elementFromPoint(${x}, ${y})
      if (!el) return
      const o = { clientX: ${x}, clientY: ${y}, bubbles: true, cancelable: true, button: 0, buttons: 1, view: window, pointerId: 1, isPrimary: true, pointerType: 'mouse' }
      el.dispatchEvent(new PointerEvent('pointerdown', o))
      el.dispatchEvent(new MouseEvent('mousedown', o))
      el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }))
      el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }))
      el.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0 }))
    })()
  `)
}

async function clickText(text, scope = 'body') {
  const pos = await cdp.eval(`
    (function(){
      const root = document.querySelector(${JSON.stringify(scope)}) || document.body
      const el = [...root.querySelectorAll('button,[role=tab],[role=option],div,span')]
        .find((x) => x.offsetParent !== null && (x.innerText || '').trim() === ${JSON.stringify(text)} && !x.closest('[class*="crumb" i]'))
      if (!el) return null
      const b = el.getBoundingClientRect()
      return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    })()
  `)
  if (!pos) return false
  const p = JSON.parse(pos)
  await clickAt(p.x, p.y)
  return true
}

await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/?token=${token}` })
await sleep(9000)
await cdp.eval(`(function(){const r=document.getElementById('dsh-startup-root');if(r)r.remove();document.documentElement.classList.remove('dsu-lock');document.body.style.overflow=''})()`)
await sleep(700)

for (let round = 0; round < 4; round += 1) {
  const did = await cdp.eval(`
    (function(){
      let acted = 0
      for (const c of document.querySelectorAll('input[type=checkbox]')) {
        if (c.offsetParent !== null && !c.checked) { c.click(); acted += 1 }
      }
      for (const t of ['我已知晓并继续','保持我的设置','明白','知道了']) {
        const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === t && x.offsetParent !== null && !x.disabled)
        if (b) { b.click(); acted += 1 }
      }
      return acted
    })()
  `)
  await sleep(700)
  if (!did) break
}
await sleep(600)

// 打开一个没被别的实例占用的会话
const rowPos = await cdp.eval(`
  (function(){
    const rows = [...document.querySelectorAll('[class*=sessionRow]')].filter((x) => x.offsetParent !== null)
    const r = rows.find((x) => (x.innerText || '').includes('大肥鱼将军')) || rows[1]
    if (!r) return null
    const b = r.getBoundingClientRect()
    return JSON.stringify({ x: b.x + 40, y: b.y + b.height / 2, text: (r.innerText || '').replace(/\\n/g, ' ') })
  })()
`)
console.log('[1] 打开会话:', rowPos)
if (rowPos) {
  const p = JSON.parse(rowPos)
  await clickAt(p.x, p.y)
}
await sleep(3500)

console.log('[2] 切联合视图:', await clickText('联合视图'))
await sleep(1200)
console.log('[3] 展开选择会话:', await clickText('选择会话'))
await sleep(1000)

const picks = await cdp.eval(`
  (function(){
    const root = document.querySelector('[data-union-view]')
    if (!root) return '[]'
    const rows = [...root.querySelectorAll('[class*=pick],[class*=Pick],[class*=row],[class*=Row]')]
      .filter((x) => x.offsetParent !== null && (x.innerText || '').trim().length > 3 && (x.innerText || '').includes('前'))
      .slice(0, 4)
      .map((x) => { const b = x.getBoundingClientRect(); return { x: b.x + 30, y: b.y + b.height / 2, t: (x.innerText || '').replace(/\\n/g, ' ').slice(0, 40) } })
    return JSON.stringify(rows)
  })()
`)
console.log('[4] 候选:', picks)
for (const p of JSON.parse(picks).slice(0, 2)) {
  await clickAt(p.x, p.y)
  await sleep(500)
  console.log('    pick', p.t)
}
await sleep(800)

await clickText('选择会话')
await sleep(600)

const bar = await cdp.eval(`
  (function(){
    const r = document.querySelector('[data-union-view]')
    return r ? r.innerText.slice(0, 260).replace(/\\n+/g, ' | ') : '(no root)'
  })()
`)
console.log('[5] 工具栏:', bar)
await shot('e2e-btn-2.png')

console.log('[6] 点合并:', await clickText('合并为新会话'))
await sleep(2000)

const mid = await cdp.eval(`(function(){const ed=document.querySelector('[contenteditable=true]'); return ed ? ed.innerText.slice(0,160) : '(none)'})()`)
console.log('[6b] 草稿:', mid)

await sleep(8000)

const after = await cdp.eval(`
  JSON.stringify({
    draft: (function(){const ed=document.querySelector('[contenteditable=true]'); return ed ? ed.innerText.slice(0,160) : '(none)'})(),
    note: (function(){const r=document.querySelector('[data-union-view]'); if(!r) return '(no root)'; const m=r.innerText.match(/已提交[^|]*/); return m?m[0]:'(no note)'})(),
    rows: [...document.querySelectorAll('[class*=sessionRow]')].filter(x=>x.offsetParent!==null).slice(0,4).map(r=>(r.innerText||'').replace(/\\n/g,' / '))
  })
`)
console.log('[7] 8 秒后:', after)
await shot('e2e-btn-3.png')

console.log('---- exc ----')
for (const l of cdp.logs.slice(0, 6)) console.log(' ', l)
ws.close()
