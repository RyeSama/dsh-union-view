// 验证「合并为新会话」按钮：选两个会话 → 点按钮 → 看侧栏是否多出「未命名」。
// 用法: node scripts/e2e-weldbtn.mjs <httpPort> <cdpPort> <token>
import { writeFileSync } from 'node:fs'
const [httpPort, cdpPort, token] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id)
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
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
}

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const cdp = new CDP(ws)
await cdp.send('Runtime.enable'); await cdp.send('Page.enable')

async function shot(n) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(n, Buffer.from(data, 'base64'))
  console.log('  shot →', n)
}
async function clickAt(x, y) {
  // dsh 的会话行对纯 mousePressed/mouseReleased 不响应，要补齐 pointer 事件再补一个 click。
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
/** 用真实鼠标点一个「文字包含 txt」的可见按钮/元素，返回是否点中。 */
async function clickText(txt, tag = 'button') {
  const box = JSON.parse(await cdp.eval(`
    (function(){
      const els = [...document.querySelectorAll(${JSON.stringify(tag)})]
      const hit = els.find(e => (e.innerText||'').includes(${JSON.stringify(txt)}) && e.offsetParent !== null && (e.innerText||'').length < 40)
      if (!hit) return JSON.stringify({ ok:false })
      const b = hit.getBoundingClientRect()
      return JSON.stringify({ ok:true, x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2) })
    })()
  `))
  if (!box.ok) return false
  await clickAt(box.x, box.y)
  return true
}

await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/?token=${token}` })
await sleep(9000)
await cdp.eval(`(function(){const r=document.getElementById('dsh-startup-root');if(r)r.remove();document.documentElement.classList.remove('dsu-lock');document.body.style.overflow=''})()`)
await sleep(700)

// 弹窗清扫：dsh-purge 的「用户须知」必须先勾复选框，否则确认按钮是禁用的。
async function dismissDialogs() {
  for (let round = 0; round < 4; round += 1) {
    const did = await cdp.eval(`
      (function(){
        let acted = 0
        for (const c of document.querySelectorAll('input[type=checkbox]')) {
          if (c.offsetParent !== null && !c.checked) { c.click(); acted += 1 }
        }
        for (const t of ['我已知晓并继续','保持我的设置','明白','知道了']) {
          const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim() === t && x.offsetParent !== null && !x.disabled)
          if (b) { b.click(); acted += 1 }
        }
        return acted
      })()
    `)
    await sleep(700)
    if (!did) break
  }
}
await dismissDialogs()
await sleep(600)

// 打开第一个会话（联合视图挂在会话作用域里）
const first = JSON.parse(await cdp.eval(`
  (function(){
    const r = [...document.querySelectorAll('[class*=sessionRow]')].filter(x => x.offsetParent !== null)[1]
    if (!r) return JSON.stringify({ ok:false })
    const b = r.getBoundingClientRect()
    return JSON.stringify({ ok:true, x: Math.round(b.x+40), y: Math.round(b.y+b.height/2), text:(r.innerText||'').replace(/\\n/g,' / ') })
  })()
`))
console.log('[1] 打开会话:', JSON.stringify(first))
if (first.ok) { await clickAt(first.x, first.y); await sleep(3000) }

// 切「联合视图」
console.log('[2] 切联合视图:', await clickText('联合视图'))
await sleep(1500)
await shot('e2e-btn-1.png')

// 展开选择面板，勾两个（内联样式没有 className，只能按文本精确匹配）
console.log('[3] 展开选择会话:', await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='选择会话'); if(!b) return 'no-btn'; b.click(); return 'clicked' })()`))
await sleep(900)
console.log('    清空:', await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='清空'); if(!b) return 'no-clear'; b.click(); return 'cleared' })()`))
await sleep(900)

const WANTS = ['长上下文自动总结优化', '数控雕刻文件任务指导']
for (const want of WANTS) {
  const r = await cdp.eval(`
    (() => {
      const root = document.querySelector('[data-union-view]')
      if (!root) return 'no-root'
      const hit = [...root.querySelectorAll('div,span,li,button,label')].find(e => (e.textContent||'').trim() === ${JSON.stringify(want)} && e.offsetParent)
      if (!hit) return 'no-row'
      ;(hit.closest('div') || hit).click()
      return 'ok'
    })()
  `)
  console.log('    pick', want, '→', r)
  await sleep(2600)
}
await sleep(1200)

// 收起面板
await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='选择会话'); if(b) b.click() })()`)
await sleep(800)
const before = await cdp.eval(`
  JSON.stringify({
    bar: (document.querySelector('[data-union-view]') ? document.querySelector('[data-union-view]').innerText.slice(0,260).replace(/\\n+/g,' | ') : '(no root)'),
    hasBtn: !!([...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '合并为新会话'))
  })
`)
console.log('[5] 工具栏:', before)
await shot('e2e-btn-2.png')

// 点「合并为新会话」
const clicked = await clickText('合并为新会话')
console.log('[6] 点合并:', clicked)
await sleep(4000)
const after = await cdp.eval(`
  JSON.stringify({
    root: (document.querySelector('[data-union-view]') ? document.querySelector('[data-union-view]').innerText.slice(0,400).replace(/\\n+/g,' | ') : '(no root)'),
    draft: (function(){const ed=document.querySelector('[contenteditable=true]'); return ed ? ed.innerText.slice(0,120) : '(none)'})(),
    notices: [...document.querySelectorAll('[class*=notice], [class*=Notice]')].map(n=>(n.innerText||'').slice(0,120)).slice(0,3)
  })
`)
console.log('[7] 4 秒后:', after)
await sleep(5000)
await shot('e2e-btn-3.png')
const rowsNow = await cdp.eval(`JSON.stringify([...document.querySelectorAll('[class*=sessionRow]')].filter(x=>x.offsetParent!==null).slice(0,4).map(r=>(r.innerText||'').replace(/\\n/g,' / ')))`)
console.log('[8] 侧栏前四:', rowsNow)
console.log('---- exc ----'); console.log(cdp.logs.slice(-6).join('\n') || '(none)')
ws.close()
