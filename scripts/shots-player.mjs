// Captures the video player and its detail page.
//
// Run with: node scripts/shots-player.mjs
// Requires the app started with --remote-debugging-port=9222, and network access
// for the media itself.
//
// Output: .shots/player-<state>.png
//
// A local fixture source supplies the pages; the media is a real remote HLS
// stream, because a screenshot of a player showing an error is not useful evidence.

import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT = 'D:/Myproject/litearti/.shots'
const MASTER = 'https://yzzy.play-cdn7.com/20221009/21929_100d2320/index.m3u8'

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
      }, 60000)
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
    await writeFile(join(OUT, `player-${name}.png`), Buffer.from(data, 'base64'))
    console.log(`  wrote player-${name}.png`)
  }
}

async function main() {
  await mkdir(OUT, { recursive: true })

  const searchPage = `<ul class="list"><li><a class="t" href="/detail/1">示例番剧（可播放）</a></li></ul>`
  const detailPage = `<div class="meta"><h1>示例番剧</h1></div>
    <div class="line"><ul>
      ${Array.from({ length: 12 }, (_, i) => `<li><a href="/play/${i + 1}">第 ${i + 1} 集</a></li>`).join('')}
    </ul></div>`
  const playPage = `<html><body><script>player.setup({ url: '${MASTER}', type: 'm3u8' });</script></body></html>`

  let fixturePort = 0
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (url.startsWith('/detail')) return res.end(detailPage)
    if (url.startsWith('/play')) return res.end(playPage)
    return res.end(searchPage)
  })
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fixturePort = server.address().port
      resolve()
    })
  })
  const base = `http://127.0.0.1:${fixturePort}`

  const source = {
    schemaVersion: 1,
    id: 'player-shot',
    name: '示例视频源',
    version: '1.0.0',
    homepage: `${base}/`,
    type: 'video',
    enabled: true,
    request: { headers: {}, timeoutMs: 20000, delayMs: 0 },
    search: {
      url: `${base}/search?q={{keyword}}`,
      method: 'GET',
      list: 'css:.list li',
      fields: { title: 'css:.t', detailUrl: 'css:a@href' },
    },
    detail: {
      list: 'css:.line ul li a',
      fields: { title: 'css:', url: 'css:@href' },
      title: 'css:h1',
    },
    chapter: { content: 'css:body' },
    video: {
      episodes: 'css:.line ul li a',
      episodeTitle: 'css:',
      episodeUrl: 'css:@href',
      playback: { kind: 'regex', pattern: "url: '([^']+\\.m3u8[^']*)'" },
    },
  }

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')
  await session.send('Page.enable')

  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1080,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  })

  await session.evaluate(`
    window.__TAURI_INTERNALS__.invoke('sources_save', { sources: ${JSON.stringify([source])} })
  `)
  await session.evaluate('location.reload()')
  await sleep(2800)
  await session.evaluate(`[...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === '源')?.click()`)
  await sleep(1000)

  console.log('capturing')
  await session.shot('list')

  // Detail page.
  await session.evaluate(`
    (() => {
      const row = document.querySelector('.source-row')
      row?.querySelector('.source-open')?.click()
    })()
  `)
  await sleep(800)
  await session.evaluate(`
    (() => {
      const input = document.querySelector('.browse .search-input')
      if (input) { input.value = 'x'; input.dispatchEvent(new Event('input', { bubbles: true })) }
    })()
  `)
  await sleep(200)
  await session.evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.browse .search-row button')]
        .find((b) => (b.textContent || '').trim() === '搜索')
      btn?.click()
    })()
  `)
  await sleep(1500)
  await session.evaluate(`document.querySelector('.browse .card')?.click()`)
  await sleep(4000)
  await session.shot('detail')

  // Player, playing. Wait for actual decode progress rather than a fixed sleep:
  // a screenshot taken before the first frame is a screenshot of a black rectangle,
  // which is useless as evidence that playback works.
  await session.evaluate(`document.querySelector('.episode')?.click()`)
  const playing = await session.evaluate(`
    (async () => {
      const deadline = Date.now() + 40000
      while (Date.now() < deadline) {
        const video = document.querySelector('.player .video')
        if (video && video.currentTime > 2 && video.videoWidth > 0) {
          return { ok: true, t: video.currentTime, w: video.videoWidth, h: video.videoHeight }
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      return { ok: false }
    })()
  `)
  console.log(`  playback state: ${JSON.stringify(playing)}`)
  await sleep(1200)
  await session.shot('playing')

  // Player with controls visible in dark theme.
  await session.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
  await sleep(1200)
  await session.shot('playing-dark')
  await session.evaluate(`document.documentElement.removeAttribute('data-theme')`)

  // Clean up.
  await session.evaluate(`
    (async () => {
      localStorage.removeItem('litearti.anime-progress')
      await window.__TAURI_INTERNALS__.invoke('sources_save', { sources: [] })
      return true
    })()
  `)
  await session.send('Emulation.clearDeviceMetricsOverride')
  server.close()

  console.log('done')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
