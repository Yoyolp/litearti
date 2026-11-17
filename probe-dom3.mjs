const sleep = ms => new Promise(r => setTimeout(r, ms))
const t = await (await fetch("http://127.0.0.1:9222/json/list")).json()
const ws = new WebSocket(t[0].webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener("open", () => r(), {once:true}))
let id=1; const p=new Map()
ws.addEventListener("message", e => { const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)} })
const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}))})
const ev = async (expr) => { const r = await send("Runtime.evaluate", {expression:expr, awaitPromise:true, returnByValue:true}); return r.result?.result?.value }
await send("Runtime.enable")
// 已在 browse 页，直接搜索
await ev(`(() => { const i=document.querySelector('.search-input'); i.value='测试'; i.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
await sleep(300)
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='搜索')?.click()`)
await sleep(2500)
console.log(await ev(`JSON.stringify({
  cls: [...new Set([...document.querySelectorAll('.content *')].map(e=>e.className).filter(c=>typeof c==='string'&&c))].slice(0,20),
  text: document.querySelector('.content')?.textContent?.trim()?.slice(0,200),
})`))
process.exit(0)
