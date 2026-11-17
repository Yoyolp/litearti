// Captures screenshots of the source section's screens.
//
// Run with: node scripts/shots-sources.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// Output: .shots/sources-<state>.png
//
// A fixture server provides the pages, so the trial run and aggregate search have
// something real to render.

import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT = 'D:/Myproject/litearti/.shots'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Session {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true })
    })
    return new Session(ws)
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} timed out`))
        }
      }, 30000)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      )
    }
    return result.result.value
  }

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(OUT, `sources-${name}.png`), Buffer.from(data, 'base64'))
    console.log(`  wrote sources-${name}.png`)
  }
}

async function main() {
  await mkdir(OUT, { recursive: true })

  const searchPage = `<!doctype html><html><body><ul class="book-list">
    ${Array.from({ length: 8 }, (_, i) => `<li><a class="t" href="/book/${i + 1}">示例书名 ${i + 1}</a><span class="a">作者 ${i + 1}</span></li>`).join('')}
    <li><span>这是一个没有标题也没有链接的坏行</span></li>
  </ul></body></html>`
  const detailPage = `<!doctype html><html><body>
    <h1>示例书名</h1>
    <div class="chapters">
      ${Array.from({ length: 12 }, (_, i) => `<a href="/c/${i + 1}">第 ${i + 1} 章</a>`).join('')}
      <a>没有链接的章</a>
    </div>
  </body></html>`

  let fixturePort = 0
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end((req.url ?? '').startsWith('/book/') ? detailPage : searchPage)
  })
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fixturePort = server.address().port
      resolve()
    })
  })
  const base = `http://127.0.0.1:${fixturePort}`

  function src(id, name, type) {
    return {
      schemaVersion: 1,
      id,
      name,
      version: '1.2.0',
      homepage: `${base}/`,
      type,
      enabled: true,
      request: { headers: { 'User-Agent': 'Mozilla/5.0' }, timeoutMs: 8000, delayMs: 100 },
      search: {
        url: `${base}/search?q={{keyword}}`,
        method: 'GET',
        list: 'css:.book-list li',
        fields: { title: 'css:.t', author: 'css:.a', detailUrl: 'css:.t@href' },
      },
      detail: {
        list: 'css:.chapters a',
        fields: { title: 'css:', url: 'css:@href' },
        title: 'css:h1',
      },
      chapter: { content: 'css:body' },
    }
  }

  const seed = [
    src('demo-novel', '示例小说源', 'novel'),
    src('demo-novel-2', '第二个小说源', 'novel'),
    src('demo-comic', '示例漫画源', 'comic'),
    src('demo-audio', '示例听书源', 'audio'),
    src('demo-video', '示例视频源（未启用）', 'video'),
  ]
  seed[4].enabled = false

  const dir = await mkdtemp(join(tmpdir(), 'litearti-shots-p3-'))
  const seedFile = join(dir, 'seed.json')
  await writeFile(seedFile, JSON.stringify(seed), 'utf8')

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const target = targets.find((t) => t.type === 'page')
  const session = await Session.connect(target.webSocketDebuggerUrl)
  await session.send('Runtime.enable')
  await session.send('Page.enable')

  await session.evaluate(`
    window.__TAURI_INTERNALS__.invoke('sources_save', { sources: ${JSON.stringify(seed)} })
  `)
  await session.evaluate('location.reload()')
  await sleep(2600)
  await session.evaluate(`[...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === '源')?.click()`)
  await sleep(1000)

  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1080,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(500)

  console.log('capturing')
  await session.shot('list')

  // Selection mode with a couple of rows checked.
  await session.evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.toolbar button')]
        .find((b) => (b.textContent || '').trim() === '选择')
      if (btn) btn.click()
    })()
  `)
  await sleep(400)
  await session.evaluate(`
    (() => {
      for (const cb of [...document.querySelectorAll('.row-check input')].slice(0, 2)) cb.click()
    })()
  `)
  await sleep(400)
  await session.shot('selecting')

  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await sleep(400)

  // Editor, form mode.
  await session.evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.actions button')]
        .find((b) => (b.textContent || '').trim() === '新建源')
      if (btn) btn.click()
    })()
  `)
  await sleep(800)
  await session.shot('editor-form')

  // Editor with a tester result against the fixture page.
  await session.evaluate(`
    (() => {
      const input = document.querySelector('.tester-field .input')
      if (input) {
        input.value = ${JSON.stringify(`${base}/search?q=x`)};
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })()
  `)
  await sleep(300)
  await session.evaluate(`
    (() => {
      const inputs = [...document.querySelectorAll('.section .input')]
      // Fill the search URL and list selector so the tester has something to run.
      const urlInput = inputs.find((i) => (i.getAttribute('placeholder') || '').includes('{{keyword}}'))
      if (urlInput) {
        urlInput.value = ${JSON.stringify(`${base}/search?q={{keyword}}`)};
        urlInput.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const listInput = inputs.find((i) => (i.getAttribute('placeholder') || '') === 'css:.book-list li')
      if (listInput) {
        listInput.value = 'css:.book-list li'
        listInput.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })()
  `)
  await sleep(400)
  await session.evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.selector-row button')][0]
      if (btn) btn.click()
    })()
  `)
  await sleep(1800)

  // Scroll the tester result into view before the shot.
  await session.evaluate(`
    (() => {
      const box = document.querySelector('.test-result')
      if (box) box.scrollIntoView({ block: 'center' })
    })()
  `)
  await sleep(500)
  await session.shot('editor-tester')

  // Editor, raw mode.
  await session.evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.mode-btn')]
        .find((b) => (b.textContent || '').trim() === '原文')
      if (btn) btn.click()
    })()
  `)
  await sleep(500)
  await session.shot('editor-raw')

  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await sleep(600)

  // Trial run.
  await session.evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.source-row')]
        .find((r) => (r.querySelector('.source-name')?.textContent || '').includes('示例小说源'))
      if (!row) return
      const btn = [...row.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === '试跑')
      if (btn) btn.click()
    })()
  `)
  await sleep(800)
  await session.evaluate(`
    (() => {
      const input = document.querySelector('.input-row .input')
      if (input) {
        input.value = '测试'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })()
  `)
  await sleep(200)
  await session.evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.input-row button')]
        .find((b) => (b.textContent || '').trim() === '运行')
      if (btn) btn.click()
    })()
  `)
  await sleep(2000)
  await session.shot('trial')

  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await sleep(600)

  // Aggregate search.
  await session.evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.actions button')]
        .find((b) => (b.textContent || '').trim() === '聚合检索')
      if (btn) btn.click()
    })()
  `)
  await sleep(700)
  await session.evaluate(`
    (() => {
      const input = document.querySelector('.aggregate .search-input')
      if (input) {
        input.value = '测试'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })()
  `)
  await sleep(200)
  await session.evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.aggregate .search-row button')]
        .find((b) => (b.textContent || '').trim() === '搜索')
      if (btn) btn.click()
    })()
  `)
  await sleep(3500)
  await session.shot('aggregate')

  // Dark theme of the management page.
  await session.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
  await sleep(400)
  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await sleep(700)
  await session.shot('list-dark')
  await session.evaluate(`document.documentElement.removeAttribute('data-theme')`)

  // Restore.
  await session.evaluate(`
    window.__TAURI_INTERNALS__.invoke('sources_save', { sources: [] })
  `)
  await rm(dir, { recursive: true, force: true })
  server.close()

  console.log('done')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
