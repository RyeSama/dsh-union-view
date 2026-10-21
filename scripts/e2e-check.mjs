// 重启后确认：焊接出来的会话出现在侧栏，点进去能渲染。
import { writeFileSync } from 'node:fs'
const [httpPort, cdpPort, token, needle] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
      else if (m.method === 'Runtime.exceptionThrown') this.logs.push('[exc] ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 200))
    }) }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value }
}
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const cdp = new CDP(ws)
await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
async function shot(n) { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(n, Buffer.from(data, 'base64')); console.log('  shot →', n) }
async function clickAt(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
}

await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/?token=${token}` })
await sleep(9000)
await cdp.eval(`(function(){const r=document.getElementById('dsh-startup-root');if(r)r.remove();document.documentElement.classList.remove('dsu-lock');document.body.style.overflow=''})()`)
await sleep(800)
for (const txt of ['保持我的设置', '我已知晓并继续', '明白']) {
  await cdp.eval(`(function(){const b=[...document.querySelectorAll('button')].find(x=>x.innerText&&x.innerText.trim()===${JSON.stringify(txt)}&&x.offsetParent!==null);if(b)b.click()})()`)
  await sleep(400)
}

const rows = await cdp.eval(`
  JSON.stringify([...document.querySelectorAll('[class*=sessionRow]')].map(r => (r.innerText||'').replace(/\\n/g,' / ').slice(0,60)))
`)
console.log('rows:', rows)

const box = JSON.parse(await cdp.eval(`
  (function(){
    const rows = [...document.querySelectorAll('[class*=sessionRow]')]
    const hit = rows.find(r => r.innerText && r.innerText.includes(${JSON.stringify(needle)}))
    if (!hit) return JSON.stringify({ ok:false, count: rows.length })
    const b = hit.getBoundingClientRect()
    return JSON.stringify({ ok:true, x: Math.round(b.x+40), y: Math.round(b.y+b.height/2), text: (hit.innerText||'').replace(/\\n/g,' / ').slice(0,80) })
  })()
`))
console.log('find:', JSON.stringify(box))
if (box.ok) {
  await clickAt(box.x, box.y)
  await sleep(3500)
  const body = await cdp.eval(`
    JSON.stringify({
      len: document.body.innerText.length,
      head: document.body.innerText.slice(0, 300).replace(/\\n+/g,' | '),
      tail: document.body.innerText.slice(-300).replace(/\\n+/g,' | '),
      err: (document.body.innerText.match(/加载失败[^\\n]*|出错了[^\\n]*|corrupt[^\\n]*/) || [null])[0]
    })
  `)
  console.log('body:', body)
}
await shot('e2e-weld-final.png')
console.log('---- exc ----'); console.log(cdp.logs.slice(-5).join('\n') || '(none)')
ws.close()
