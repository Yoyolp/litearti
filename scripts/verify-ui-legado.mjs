// Verifies a Legado-converted source end to end in the packaged app.
//
// Run with: node scripts/verify-ui-legado.mjs <converted.json>
// Requires the app started with --remote-debugging-port=9222.
const PORT = Number(process.env.CDP_PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
import { readFile } from 'node:fs/promises'

const sourcePath = process.argv[2]
if (!sourcePath) {
  console.error('用法: node scripts/verify-ui-legado.mjs <converted.json> [关键词]')
  process.exit(2)
}
const keyword = process.argv[3] ?? '系统'
const source = JSON.parse(await readFile(sourcePath, 'utf8'))

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target; start the app with the debug port')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', () => reject(new Error('ws failed')), { once: true })
})

let id = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
async function evaluate(expression) {
  const myId = id++
  const result = await new Promise((resolve) => {
    pending.set(myId, resolve)
    ws.send(
      JSON.stringify({
        id: myId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  })
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description ?? 'exception')
  }
  return result.result?.result?.value
}
async function waitFor(expression, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(300)
  }
  return null
}

console.log(`安装转换后的书源：${source.name}`)
await evaluate(`
  (async () => {
    await window.__TAURI_INTERNALS__.invoke('sources_save', { sources: ${JSON.stringify([source])} })
  })()
`)
await evaluate('location.reload()')
await sleep(2500)

console.log('搜索')
await evaluate(`[...document.querySelectorAll('.nav-list .nav-item')][2].click()`)
const rows = await waitFor(`document.querySelectorAll('.source-row').length`, 20000)
if (!rows) {
  const diag = await evaluate(`({
    nav: [...document.querySelectorAll('.nav-list .nav-item')].map((n) => n.textContent.trim()),
    body: document.body.innerText.slice(0, 400),
    hasStore: !!document.querySelector('.sources'),
  })`)
  console.log('诊断：', JSON.stringify(diag, null, 2))
}
await evaluate(`document.querySelector('.source-row .source-open')?.click()`)
await waitFor(`document.querySelector('.search-input') ? 1 : 0`, 20000)

const ready = await evaluate(`!!document.querySelector('.search-input')`)
if (!ready) {
  const diag = await evaluate(`document.body.innerText.slice(0, 400)`)
  console.error('搜索框没出现，页面内容：', diag)
  process.exit(1)
}

await evaluate(`
  (() => {
    const input = document.querySelector('.search-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(keyword)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()
`)
await sleep(300)
await evaluate(`
  (() => {
    const search = [...document.querySelectorAll('.search-row button')].find((b) => !b.disabled)
    if (search) search.click()
  })()
`)

const cardCount = await waitFor(
  `document.querySelectorAll('.card').length > 0 ? document.querySelectorAll('.card').length : 0`,
  45000,
)
check('搜索结果有卡片', typeof cardCount === 'number' && cardCount > 0, `${cardCount}`)

const first = await evaluate(`
  (() => {
    const c = document.querySelector('.card')
    return c ? { title: c.querySelector('.title')?.textContent?.trim() } : null
  })()
`)
console.log(`       第一本：${first?.title}`)

if (cardCount > 0) {
  console.log('打开详情（需要独立目录页）')
  await evaluate(`document.querySelector('.card')?.click()`)
  const chapters = await waitFor(
    `document.querySelectorAll('.chapter-row').length > 0 ? document.querySelectorAll('.chapter-row').length : 0`,
    40000,
  )
  check('章节列表加载成功（tocUrl 生效）', typeof chapters === 'number' && chapters > 0, `${chapters}`)
  console.log(`       ${chapters} 章`)

  if (chapters > 0) {
    console.log('读一章')
    await evaluate(`document.querySelector('.chapter-row .chapter-open')?.click()`)
    const paragraphs = await waitFor(
      `document.querySelectorAll('.prose .paragraph').length > 0 ? document.querySelectorAll('.prose .paragraph').length : 0`,
      40000,
    )
    check('正文渲染出段落', typeof paragraphs === 'number' && paragraphs > 0, `${paragraphs}`)
    const dump = await evaluate(`
      (() => {
        const ps = [...document.querySelectorAll('.prose .paragraph')]
        return { count: ps.length, text: ps.map((p) => p.textContent.trim()).join('\\n') }
      })()
    `)
    const text = typeof dump?.text === 'string' ? dump.text : ''
    check('正文有真实内容', text.length > 100, `${text.length} 字`)
    console.log(`       ${dump?.count} 段 / ${text.length} 字`)
    console.log(`       开头：${text.slice(0, 40)}`)
  }
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} 项失败`)
  process.exit(1)
}
console.log('all checks passed')
process.exit(0)
