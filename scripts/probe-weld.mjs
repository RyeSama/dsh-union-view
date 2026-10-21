import fs from 'node:fs'
const [httpPort, cdpPort, token] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }) }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value }
}
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const cdp = new CDP(ws)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/?token=${token}` })
await sleep(9000)
await cdp.eval(`(function(){const x=document.getElementById('dsh-startup-root');if(x)x.remove();document.documentElement.classList.remove('dsu-lock');document.body.style.overflow=''})()`)
await sleep(600)
for (const txt of ['保持我的设置','我已知晓并继续','明白']) { await cdp.eval(`(function(){const b=[...document.querySelectorAll('button')].find(x=>x.innerText&&x.innerText.trim()===${JSON.stringify(txt)}&&x.offsetParent!==null);if(b)b.click()})()`); await sleep(400) }
const r = await cdp.eval(`
  (function(){
    const rows = [...document.querySelectorAll('[class*=sessionRow]')]
    const hit = rows.find(r => r.innerText && r.innerText.includes('未命名'))
    if (!hit) return 'no row'
    const target = hit.querySelector('span') || hit
    const b = target.getBoundingClientRect()
    const x = Math.round(b.x + b.width/2), y = Math.round(b.y + b.height/2)
    for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
      target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true }))
    }
    return JSON.stringify({ x, y, text: hit.innerText.replace(/\\n/g,' / ') })
  })()
`)
console.log('dispatch:', r)
await sleep(4000)
const state = await cdp.eval(`
  JSON.stringify({
    crumb: [...document.querySelectorAll('[class*=crumbSeg]')].map(e => e.innerText.trim()).join(' > '),
    len: document.body.innerText.length,
    hasLoadOlder: document.body.innerText.includes('加载更早'),
    firstUser: (document.body.innerText.match(/现在的问题是[^\\n]{0,60}/) || [null])[0],
    err: (document.body.innerText.match(/加载失败[^\\n]*|corrupt[^\\n]*|出错[^\\n]*/) || [null])[0]
  })
`)
console.log('state:', state)
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('e2e-weld-final.png', Buffer.from(data, 'base64'))
ws.close()


