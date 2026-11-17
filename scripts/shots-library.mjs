// Captures screenshots of the library screen's states.
//
// Run with: node scripts/shots-library.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// Why separate from verify-ui-library.mjs: that script asserts behaviour, this
// one produces images a person can look at. Behaviour can be right while the
// layout is broken (overlapping text, a card that collapsed to zero height), and
// the only way to catch that is to look.
//
// Output: .shots/library-<state>.png

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
    await writeFile(join(OUT, `library-${name}.png`), Buffer.from(data, 'base64'))
    console.log(`  wrote library-${name}.png`)
  }
}

async function main() {
  await mkdir(OUT, { recursive: true })

  // Seed a realistic spread of formats so the grid has variety.
  const dir = await mkdtemp(join(tmpdir(), 'litearti-shots-'))
  const seeds = [
    ['三体', 'txt', 'x'.repeat(4000)],
    ['人类简史', 'txt', 'y'.repeat(9000)],
    ['线性代数及其应用', 'pdf', '%PDF-1.4 ' + 'z'.repeat(2000)],
    ['深入理解计算机系统', 'pdf', '%PDF-1.4 ' + 'w'.repeat(3000)],
    ['沙丘', 'epub', 'epub'.repeat(500)],
    ['银河系漫游指南', 'epub', 'epub'.repeat(400)],
    ['明朝那些事儿', 'mp3', 'ID3'.repeat(300)],
    ['一个很长很长很长很长很长很长很长很长的书名用来测试截断', 'txt', 'q'.repeat(500)],
  ]
  for (const [name, ext, body] of seeds) {
    await writeFile(join(dir, `${name}.${ext}`), body, 'utf8')
  }

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')
  await session.send('Page.enable')

  await session.evaluate(`
    (async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke
      const all = await invoke('library_list')
      if (all.length) await invoke('library_remove_many', { ids: all.map((e) => e.id) })
      localStorage.removeItem('litearti.library.query')
      localStorage.removeItem('litearti.library.view')
      return true
    })()
  `)

  const paths = JSON.stringify(seeds.map(([name, ext]) => join(dir, `${name}.${ext}`)))
  await session.evaluate(`
    (async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke
      const report = await invoke('library_import', { paths: ${paths} })
      // Give a couple of entries progress so the cards show bars and labels.
      const all = await invoke('library_list')
      const byTitle = (needle) => all.find((e) => e.title.includes(needle))
      const a = byTitle('三体')
      if (a) await invoke('library_set_progress', { id: a.id, progress: { version: 1, ratio: 0.42 } })
      const b = byTitle('线性代数')
      if (b) await invoke('library_set_progress', { id: b.id, progress: { version: 1, page: 37 } })
      const c = byTitle('沙丘')
      if (c) await invoke('library_set_progress', { id: c.id, progress: { version: 1, chapter: 4, ratio: 0.6 } })
      const d = byTitle('明朝')
      if (d) await invoke('library_set_progress', { id: d.id, progress: { version: 1, time: 204 } })
      return report.imported.length
    })()
  `)

  await session.evaluate('location.reload()')
  await sleep(2600)
  await session.evaluate(`[...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === '资料库')?.click()`)
  await sleep(1000)

  console.log('capturing')
  await session.shot('list')

  await session.evaluate(`document.querySelectorAll('.view-btn')[1].click()`)
  await sleep(700)
  await session.shot('grid')

  // Narrow window: the grid must reflow, the toolbar must not overflow.
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 700,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(700)
  await session.shot('grid-narrow')
  await session.evaluate(`document.querySelectorAll('.view-btn')[0].click()`)
  await sleep(500)
  await session.shot('list-narrow')
  await session.send('Emulation.clearDeviceMetricsOverride')
  await sleep(500)

  // Dark theme, list and grid.
  await session.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
  await sleep(400)
  await session.evaluate(`document.querySelectorAll('.view-btn')[1].click()`)
  await sleep(600)
  await session.shot('grid-dark')
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 700,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(500)
  await session.shot('grid-dark-narrow')
  await session.send('Emulation.clearDeviceMetricsOverride')
  await session.evaluate(`document.documentElement.removeAttribute('data-theme')`)
  await sleep(300)

  // Selection mode, and the rename dialog.
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
      const cb = [...document.querySelectorAll('.entry-check input')].slice(0, 3)
      for (const c of cb) c.click()
    })()
  `)
  await sleep(400)
  await session.shot('selecting')

  await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await sleep(400)
  await session.evaluate(`document.querySelectorAll('.view-btn')[0].click()`)
  await sleep(400)
  await session.evaluate(`
    (() => {
      const row = document.querySelector('.entry')
      const btn = [...row.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === '重命名')
      if (btn) btn.click()
    })()
  `)
  await sleep(500)
  await session.shot('rename')

  // Leave clean.
  await session.evaluate(`
    (async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke
      const all = await invoke('library_list')
      if (all.length) await invoke('library_remove_many', { ids: all.map((e) => e.id) })
      localStorage.removeItem('litearti.library.query')
      localStorage.removeItem('litearti.library.view')
      return true
    })()
  `)
  await rm(dir, { recursive: true, force: true })

  console.log('done')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
