/**
 * Verifies playback through the app's own player.
 *
 * Run with: node scripts/verify-stream-playback.mjs
 * Requires the app started with --remote-debugging-port=9222, and network access.
 *
 * ## Why this drives the real UI
 *
 * The first version of this script built its own `<video>` + hls.js in the page.
 * That was a mistake: it tested a *reimplementation*, and it is exactly how the
 * `canPlayType` bug slipped through. The app decided "native HLS" because
 * `canPlayType` returned `'maybe'` — a claim WebView2 makes and then fails to
 * honour — and a hand-written probe that used the same wrong check reproduced the
 * bug rather than catching it.
 *
 * So this walks the actual path: install a source, search, open the detail page,
 * click an episode, and read the state of the element the app created. If the app's
 * player is wrong, this fails.
 *
 * Fixtures come from a local HTTP server, so the *source* is deterministic; only
 * the media itself is a real remote stream (there is no honest way to fake an HLS
 * container that a real demuxer will play).
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const ROOT = 'D:/Myproject/litearti'

/** A real, short, public HLS stream for the media itself. */
const MASTER = 'https://yzzy.play-cdn7.com/20221009/21929_100d2320/index.m3u8'

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

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
      }, 90000)
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
}

async function main() {
  // --- a local source that resolves to the real stream ---------------------
  let fixturePort = 0
  const searchPage = `<ul class="list">
    <li><a class="t" href="/detail/1">测试番剧</a></li>
  </ul>`
  const detailPage = `<div class="meta"><h1>测试番剧</h1></div>
    <div class="line"><ul>
      <li><a href="/play/1">第 1 集</a></li>
      <li><a href="/play/2">第 2 集</a></li>
    </ul></div>`
  // The episode page carries the media URL inline, which is what the `regex`
  // playback kind extracts. Using the real stream keeps the media path honest.
  const playPage = `<html><body><script>
    player.setup({ url: '${MASTER}', type: 'm3u8' });
  </script></body></html>`

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
    id: 'playback-probe',
    name: '播放测试源',
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
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  await session.evaluate(`
    window.__TAURI_INTERNALS__.invoke('sources_save', { sources: ${JSON.stringify([source])} })
  `)
  await session.evaluate('location.reload()')
  await sleep(2800)
  await session.evaluate(`[...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === '源')?.click()`)
  await sleep(1000)

  // --- search -------------------------------------------------------------
  console.log('setup: search and detail')
  {
    await session.evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.source-row')]
          .find((r) => (r.textContent || '').includes('播放测试源'))
        row?.querySelector('.source-open')?.click()
      })()
    `)
    await sleep(800)
    await session.evaluate(`
      (() => {
        const input = document.querySelector('.browse .search-input')
        if (input) {
          input.value = 'x'
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
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

    const cards = await session.evaluate(`document.querySelectorAll('.browse .card').length`)
    check('the search found the item', cards === 1, `${cards}`)
  }

  // --- open the detail page ----------------------------------------------
  {
    await session.evaluate(`document.querySelector('.browse .card')?.click()`)
    // The detail page resolves the media URL for the first episode up front, which
    // is a network round trip.
    await sleep(4000)

    const detail = await session.evaluate(`
      (() => ({
        isVideoDetail: !!document.querySelector('.episodes'),
        episodes: document.querySelectorAll('.episode').length,
        warned: !!document.querySelector('.warn'),
        warnText: (document.querySelector('.warn')?.textContent || '').trim().slice(0, 140),
      }))()
    `)
    check('the video detail page rendered', detail.isVideoDetail === true, JSON.stringify(detail))
    check('both episodes are listed', detail.episodes === 2, `${detail.episodes}`)
    // The probe resolves through the regex against the fixture page, so it should
    // succeed — a warning here would mean the source wiring is wrong.
    check('no "cannot play" warning for a resolvable source', detail.warned === false, detail.warnText)
  }

  // --- play ---------------------------------------------------------------
  console.log('playback through the app player')
  {
    await session.evaluate(`document.querySelector('.episode')?.click()`)
    // Resolution + mount + manifest + first segment: generous but bounded.
    await sleep(3000)

    const mounted = await session.evaluate(`
      (() => ({
        player: !!document.querySelector('.player'),
        video: !!document.querySelector('.player .video'),
        error: (document.querySelector('.overlay.is-error')?.textContent || '').trim().slice(0, 200),
      }))()
    `)
    check('the player mounted', mounted.player && mounted.video, JSON.stringify(mounted))
    check('no error overlay on mount', !mounted.error, mounted.error)

    // Wait for actual decode progress, reading the app's own element.
    const state = await session.evaluate(`
      (async () => {
        const video = document.querySelector('.player .video')
        if (!video) return { missing: true }
        const deadline = Date.now() + 40000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500))
          if (video.currentTime > 1.5) {
            return {
              ok: true,
              currentTime: video.currentTime,
              duration: video.duration,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
              readyState: video.readyState,
            }
          }
          const overlay = document.querySelector('.overlay.is-error')
          if (overlay) {
            return { ok: false, overlay: (overlay.textContent || '').trim().slice(0, 200) }
          }
        }
        return {
          ok: false,
          currentTime: video.currentTime,
          duration: video.duration,
          readyState: video.readyState,
          error: video.error ? { code: video.error.code, message: video.error.message } : null,
        }
      })()
    `)

    check('the duration is known', (state?.duration ?? 0) > 0, JSON.stringify(state))
    check(
      'a real frame size was decoded',
      (state?.videoWidth ?? 0) > 0 && (state?.videoHeight ?? 0) > 0,
      `${state?.videoWidth}x${state?.videoHeight}`,
    )
    check('playback advanced past 1.5s', state?.ok === true, JSON.stringify(state))
    if (state?.ok) {
      console.log(
        `       (played to ${state.currentTime.toFixed(1)}s of ${state.duration.toFixed(0)}s at ${state.videoWidth}x${state.videoHeight})`,
      )
    }

    if (state?.ok) {
      console.log('seeking through the app progress bar')
      const seek = await session.evaluate(`
        (async () => {
          const video = document.querySelector('.player .video')
          const range = document.querySelector('.player .progress')
          if (!video || !range) return { missing: true }
          const target = Math.min(60, Math.max(10, video.duration / 4))
          // Drive the real control, not the element: that is the path a person takes.
          range.value = String(target)
          range.dispatchEvent(new Event('input', { bubbles: true }))
          const deadline = Date.now() + 25000
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 400))
            if (Math.abs(video.currentTime - target) < 2) {
              return { ok: true, target, landed: video.currentTime }
            }
          }
          return { ok: false, target, landed: video.currentTime }
        })()
      `)
      check('seeking lands near the target', seek?.ok === true, JSON.stringify(seek))
      if (seek?.ok) {
        console.log(`       (sought to ${seek.target.toFixed(1)}s, landed ${seek.landed.toFixed(1)}s)`)
      }

      console.log('progress is recorded')
      const recorded = await session.evaluate(`
        (() => {
          const raw = localStorage.getItem('litearti.anime-progress')
          if (!raw) return { found: false }
          const map = JSON.parse(raw)
          const entries = Object.entries(map)
          return {
            found: entries.length > 0,
            first: entries[0] ? { key: entries[0][0].slice(0, 60), position: entries[0][1].position } : null,
          }
        })()
      `)
      check('a resume point was written', recorded.found === true, JSON.stringify(recorded))
      check(
        'the recorded position is plausible',
        (recorded.first?.position ?? 0) > 0,
        JSON.stringify(recorded.first),
      )
    }
  }

  // --- cleanup ------------------------------------------------------------
  await session.evaluate(`
    (async () => {
      localStorage.removeItem('litearti.anime-progress')
      await window.__TAURI_INTERNALS__.invoke('sources_save', { sources: [] })
      return true
    })()
  `)
  server.close()

  console.log('')
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
