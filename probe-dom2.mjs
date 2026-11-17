const sleep = ms => new Promise(r => setTimeout(r, ms))
const t = await (await fetch("http://127.0.0.1:9222/json/list")).json()
const ws = new WebSocket(t[0].webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener("open", () => r(), {once:true}))
let id=1; const p=new Map()
ws.addEventListener("message", e => { const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)} })
const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}))})
const ev = async (expr) => { const r = await send("Runtime.evaluate", {expression:expr, awaitPromise:true, returnByValue:true}); return r.result?.result?.value }
await send("Runtime.enable")
await ev(`localStorage.setItem('litearti.sidebar-collapsed','0')`)
await send("Page.enable"); await send("Page.reload"); await sleep(2500)
await ev(`[...document.querySelectorAll('.nav-item')].find(n=>n.textContent.trim()==='源')?.click()`)
await sleep(1500)
console.log("源页按钮:", await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,10))`))
// 点开第一个源
await ev(`document.querySelector('.source-row')?.querySelector('button')?.click()`)
await sleep(1500)
console.log("进源后:", await ev(`JSON.stringify({
  cls: [...new Set([...document.querySelectorAll('[class]')].map(e=>e.className).filter(c=>typeof c==='string'))].slice(0,20),
  buttons: [...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,10),
  inputs: [...document.querySelectorAll('input')].map(i=>({type:i.type,cls:i.className})),
})`))
process.exit(0)
