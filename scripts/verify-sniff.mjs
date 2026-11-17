/**
 * Verifies the sniffing collector end to end, against a live local page.
 *
 * Run with: node scripts/verify-sniff.mjs
 * Requires the app started with --remote-debugging-port=9222. No internet needed:
 * the page is a local server that requests a synthetic HLS playlist.
 *
 * What this checks that unit tests cannot:
 *   - the off-screen window actually gets created and loads
 *   - `Network.enable` is accepted and events start arriving
 *   - the CDP handler feeds the buffer on the webview thread
 *   - cookies come back from the session
 *   - the whole IPC round trip (`sniff_media`) returns a `found` report
 *
 * The collector has no unit tests by design: its COM setup aborts the test harness
 * at load time (see the `not(test)` gate in sniff/mod.rs), so this script is the
 * only automated coverage the Windows collector has. If it breaks, the collector
 * is untested — that is a documented hole, not an oversight.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.CDP_PORT ?? 9222)

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
}

async function main() {
  // A page that, on load, fetches an mp4 first (a decoy) and then the HLS playlist
  // (the target). Ordered so the score function has to prefer HLS over MP4, which is
  // the same judgement it makes on real pages.
  let fixturePort = 0
  const decoy = Buffer.from('%PDF-fake-mp4-body'.repeat(10))
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.endsWith('.mp4')) {
      res.writeHead(200, { 'content-type': 'video/mp4' })
      return res.end(decoy)
    }
    if (url.endsWith('.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      return res.end(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nlow/index.m3u8\n',
      )
    }
    // The page itself.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'probe_session=abc123; Path=/' })
    return res.end(`<!doctype html><html><body><script>
      // The decoy first, then the real one: the collector must not take the first hit.
      fetch('/decoy.mp4');
      setTimeout(() => fetch('/stream/master.m3u8'), 300);
    </script></body></html>`)
  })
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fixturePort = server.address().port
      resolve()
    })
  })
  const base = `http://127.0.0.1:${fixturePort}`

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  console.log('sniff: support check')
  {
    const support = await session.evaluate(`
      (async () => {
        return await window.__TAURI_INTERNALS__.invoke('sniff_supported')
      })()
    `)
    check('sniffing is reported supported on Windows', support.supported === true, JSON.stringify(support))
  }

  console.log('sniff: capability (sniff_media)')
  {
    // A short timeout because the page's fetches fire within half a second; the
    // default 12 s exists for slow real pages, not for this fixture.
    const report = await session.evaluate(`
      (async () => {
        return await window.__TAURI_INTERNALS__.invoke('sniff_media', {
          pageUrl: ${JSON.stringify(base + '/play/1')},
          sourceId: 'sniff-probe-source',
          referer: null,
          userAgent: null,
          timeoutMs: 6000,
        })
      })()
    `)

    check('the command returns', report !== undefined && report !== null, JSON.stringify(report))
    check(
      'the outcome is a found report',
      report?.kind === 'found',
      JSON.stringify(report),
    )
    if (report?.kind === 'found') {
      check(
        'the URL is the HLS playlist, not the mp4 decoy',
        report.url.includes('.m3u8'),
        report.url,
      )
      check(
        'the URL points at the fixture server',
        report.url.startsWith('http://127.0.0.1:'),
        report.url,
      )
      console.log(`       (found: ${report.url})`)
    }
  }

  console.log('sniff: session cookies are persisted')
  {
    // The fixture sets probe_session=abc123. `sniff_media` should have written it
    // back into the credential store keyed on the source id.
    const stored = await session.evaluate(`
      (async () => {
        const all = await window.__TAURI_INTERNALS__.invoke('credentials_status')
        return all['sniff-probe-source'] ?? null
      })()
    `)
    check('a credential was recorded for the sniff source', stored !== null, JSON.stringify(stored))
    if (stored) {
      check('it reports having a cookie', stored.hasCookie === true, JSON.stringify(stored))
      console.log(`       (host: ${stored.host})`)
    }
  }

  console.log('sniff: error paths')
  {
    // An unreachable page must fail with a message, not hang the window forever.
    const failed = await session.evaluate(`
      (async () => {
        try {
          const report = await window.__TAURI_INTERNALS__.invoke('sniff_media', {
            pageUrl: 'http://127.0.0.1:1/nope',
            sourceId: 'sniff-probe-source',
            referer: null,
            userAgent: null,
            timeoutMs: 3000,
          })
          return { kind: 'ok', report }
        } catch (error) {
          return { kind: 'error', message: String(error) }
        }
      })()
    `)
    // Either a NotFound report or an error is acceptable — the window opens, finds
    // nothing (connection refused), and the timeout expires. What is NOT acceptable
    // is a hang or a crash.
    check(
      'an unreachable page produces an answer, not a hang',
      failed?.kind === 'ok' || failed?.kind === 'error',
      JSON.stringify(failed).slice(0, 300),
    )
    if (failed?.kind === 'ok') {
      check('the answer is notFound, not a bogus found', failed.report.kind === 'notFound', JSON.stringify(failed.report))
      console.log(`       (${failed.report.message})`)
    } else {
      console.log(`       (error: ${String(failed.message).slice(0, 100)})`)
    }
  }

  console.log('sniff: the stream proxy still serves main only')
  {
    // The sniffing window exists by now; make sure the label check did its job by
    // asking from the *page* (main) — this must still succeed, proving the guard
    // did not accidentally lock everything out.
    const origin = await session.evaluate(`
      (async () => {
        for (const form of ['http://kazumi-stream.localhost', 'kazumi-stream://localhost']) {
          try {
            const response = await fetch(form + '/stream?u=' + encodeURIComponent('data:,'))
            if (response.status) return form
          } catch {}
        }
        return null
      })()
    `)
    check('the proxy still answers the main window', !!origin, JSON.stringify(origin))
  }

  // Clean up the probe credential so a rerun starts fresh.
  await session.evaluate(`
    (async () => {
      await window.__TAURI_INTERNALS__.invoke('credentials_clear', { sourceId: 'sniff-probe-source' })
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
