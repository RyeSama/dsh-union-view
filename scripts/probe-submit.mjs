const WebSocket = globalThis.WebSocket
const [,,cdpPort,httpPort,token]=process.argv;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const list=await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page=list.find(t=>t.type==="page");
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener("open",r));
  let id=0;const pending=new Map();
  ws.addEventListener("message",(e)=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}});
  const send=(method,params={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
  const ev=async(expr)=>{const r=await send("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true});return r.result&&r.result.result&&r.result.result.value};
  await send("Page.navigate",{url:`http://127.0.0.1:${httpPort}/?token=${token}`});
  await sleep(9000);
  await ev(`(function(){const r=document.getElementById('dsh-startup-root');if(r)r.remove();document.documentElement.classList.remove('dsu-lock');document.body.style.overflow=''})()`);
  await sleep(600);
  for(let i=0;i<3;i++){await ev(`(function(){let a=0;for(const c of document.querySelectorAll('input[type=checkbox]')){if(c.offsetParent&&!c.checked){c.click();a++}}for(const t of ['我已知晓并继续','保持我的设置']){const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()===t&&x.offsetParent&&!x.disabled);if(b){b.click();a++}}return a})()`);await sleep(500)}
  // 打开"大肥鱼将军"（肯定没在用）
  const pos=await ev(`(function(){const r=[...document.querySelectorAll('[class*=sessionRow]')].find(x=>x.offsetParent&&x.innerText.includes('大肥鱼将军'));if(!r)return null;const b=r.getBoundingClientRect();return JSON.stringify({x:b.x+40,y:b.y+b.height/2})})()`);
  console.log("row:",pos);
  if(pos){const p=JSON.parse(pos);
    await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:p.x,y:p.y,buttons:0});
    await send("Input.dispatchMouseEvent",{type:"mousePressed",x:p.x,y:p.y,button:"left",clickCount:1,buttons:1});
    await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:p.x,y:p.y,button:"left",clickCount:1,buttons:0});
    await ev(`(function(){const el=document.elementFromPoint(${p.x},${p.y});if(!el)return;const o={clientX:${p.x},clientY:${p.y},bubbles:true,cancelable:true,button:0,buttons:1,view:window,pointerId:1,isPrimary:true,pointerType:'mouse'};el.dispatchEvent(new PointerEvent('pointerdown',o));el.dispatchEvent(new MouseEvent('mousedown',o));el.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}));el.dispatchEvent(new MouseEvent('mouseup',{...o,buttons:0}));el.dispatchEvent(new MouseEvent('click',{...o,buttons:0}))})()`);
  }
  await sleep(3500);
  // 逐字符输入命令
  await ev(`(function(){const ed=document.querySelector('[contenteditable=true]');if(ed)ed.focus()})()`);
  const cmd="/weld 6fd8d9d4 aeaa7874 --turns 2";
  for(const ch of cmd){
    await send("Input.dispatchKeyEvent",{type:"keyDown",key:ch,code:"Key"+ch.toUpperCase(),text:ch});
    await send("Input.dispatchKeyEvent",{type:"char",key:ch,text:ch});
    await send("Input.dispatchKeyEvent",{type:"keyUp",key:ch,code:"Key"+ch.toUpperCase()});
    await sleep(18);
  }
  await sleep(800);
  console.log("draft:",await ev(`(function(){const ed=document.querySelector('[contenteditable=true]');return ed?ed.innerText.slice(0,120):'(none)'})()`));
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13,text:"\r"});
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  await sleep(1200);
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13,text:"\r"});
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  await sleep(6000);
  console.log("after draft:",await ev(`(function(){const ed=document.querySelector('[contenteditable=true]');return ed?ed.innerText.slice(0,120):'(none)'})()`));
  console.log("body tail:",await ev(`document.body.innerText.slice(-500).replace(/\\n+/g,' | ')`));
  ws.close();
})();

