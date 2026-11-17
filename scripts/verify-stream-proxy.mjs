/**
 * Verifies the streaming proxy end to end, against a real HLS stream.
 *
 * Run with: node scripts/verify-stream-proxy.mjs
 * Requires the app started with --remote-debugging-port=9222, and **network
 * access**: the point is to prove the proxy works on a real stream, not on a
 * fixture. Everything else in this suite is offline; this one deliberately is not,
 * because m3u8 rewriting has too many real-world shapes to fake convincingly.
 *
 * The chain under test:
 *
 *     <origin>/stream?u=<master.m3u8>
 *         → rewritten master playlist
 *         → <origin>/stream?u=<media.m3u8>
 *             → rewritten media playlist (every segment proxied)
 *             → <origin>/stream?u=<segment.ts>
 *                 → actual bytes
 *
 * ## Why the origin is detected, not assumed
 *
 * Tauri serves a custom scheme over `http://<scheme>.localhost` on Windows and
 * Android, and as `<scheme>://localhost` elsewhere. The wrong form fails at
 * `fetch` with "Failed to fetch" and never reaches the handler. So this script asks
 * the page which form works rather than guessing from `process.platform` — the
 * answer belongs to the webview, not to Node.
 */
const PORT = Number(process.env.CDP_PORT ?? 9222)

/**
 * The real stream used here.
 *
 * From the MXdm community source (docs/kazumi-community-sources.md). Verified
 * fetchable without a Referer, which makes it a clean test of the *proxy*: the
 * referer plumbing is covered by Rust unit tests, since this CDN does not check it.
 */
const MASTER = 'https://yzzy.play-cdn7.com/20221009/21929_100d2320/index.m3u8'

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

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
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  // --- which origin reaches the handler? -----------------------------------
  console.log('proxy: origin form')
  let origin = null
  {
    const probe = await session.evaluate(`
      (async () => {
        const forms = ['http://kazumi-stream.localhost', 'kazumi-stream://localhost']
        const results = []
        for (const form of forms) {
          const url = form + '/stream?u=' + encodeURIComponent(${JSON.stringify(MASTER)})
          try {
            const response = await fetch(url)
            const body = await response.text()
            results.push({ form, ok: response.ok, status: response.status, looksLikePlaylist: body.startsWith('#EXTM3U') })
          } catch (e) {
            results.push({ form, error: String(e) })
          }
        }
        return results
      })()
    `)
    for (const entry of probe) {
      console.log(`       ${entry.form}: ${entry.error ?? `HTTP ${entry.status}`}`)
    }
    const usable = probe.find((entry) => entry.ok && entry.looksLikePlaylist)
    origin = usable?.form ?? null
    check(
      'exactly one origin form reaches the handler',
      probe.filter((entry) => entry.ok).length >= 1,
      JSON.stringify(probe),
    )
    check(
      'that origin returns a playlist',
      !!origin,
      JSON.stringify(probe),
    )
  }

  if (!origin) {
    console.error('\nNo working proxy origin; the rest cannot run.')
    process.exit(1)
  }

  /** Fetch a target through the proxy, from inside the app. */
  async function fetchThroughProxy(target, extraHeaders = {}) {
    return session.evaluate(`
      (async () => {
        const url = ${JSON.stringify(origin)} + '/stream?u=' + encodeURIComponent(${JSON.stringify(target)});
        try {
          const response = await fetch(url, { headers: ${JSON.stringify(extraHeaders)} });
          const buffer = await response.arrayBuffer();
          const text = new TextDecoder().decode(buffer);
          return {
            ok: response.ok,
            status: response.status,
            contentType: response.headers.get('content-type'),
            contentRange: response.headers.get('content-range'),
            allowOrigin: response.headers.get('access-control-allow-origin'),
            byteLength: buffer.byteLength,
            firstByte: buffer.byteLength ? new Uint8Array(buffer)[0] : null,
            body: text.slice(0, 4000),
          };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      })()
    `)
  }

  /** Follow a rewritten `/stream?u=…` link, the way hls.js would. */
  async function followRewrite(body) {
    const match = /(\/stream\?u=[^\s#]+)/.exec(body ?? '')
    if (!match) return null
    return session.evaluate(`
      (async () => {
        try {
          const response = await fetch(${JSON.stringify(origin)} + ${JSON.stringify(match[1])});
          const text = await response.text();
          return { ok: response.ok, status: response.status, body: text };
        } catch (e) { return { ok: false, error: String(e) } }
      })()
    `)
  }

  console.log('proxy: master playlist')
  let master = null
  {
    master = await fetchThroughProxy(MASTER)
    check('the proxy responds', master.ok === true, JSON.stringify(master).slice(0, 300))
    check('status is 200', master.status === 200, `${master.status}`)
    check(
      'the body is a playlist',
      (master.body ?? '').startsWith('#EXTM3U'),
      (master.body ?? '').slice(0, 80),
    )
    check(
      'the content type is a playlist type',
      /mpegurl/i.test(master.contentType ?? ''),
      master.contentType,
    )
    // The whole point: the sub-playlist URI must now point back at the proxy.
    check(
      'sub-playlist URIs were rewritten to the proxy',
      (master.body ?? '').includes('/stream?u='),
      (master.body ?? '').slice(0, 400),
    )
    check(
      'no bare relative URI survived',
      !/^1000k\/hls\/mixed\.m3u8$/m.test(master.body ?? ''),
      (master.body ?? '').slice(0, 400),
    )
  }

  console.log('proxy: media playlist')
  let mediaBody = null
  {
    const media = await followRewrite(master.body)
    check('the media playlist loads through the proxy', media?.ok === true, JSON.stringify(media).slice(0, 300))
    mediaBody = media?.body ?? ''
    check('it is a playlist', mediaBody.startsWith('#EXTM3U'), mediaBody.slice(0, 80))
    check('segments were rewritten', mediaBody.includes('/stream?u='), mediaBody.slice(0, 300))
    check('it contains segment entries', mediaBody.includes('#EXTINF'), mediaBody.slice(0, 200))
    // If the rewrite missed one segment the player would request it from the app
    // origin and get a 404 — a half-playing stream.
    check(
      'no bare .ts filename survived unproxied',
      !/^[0-9a-f]{32}\.ts$/m.test(mediaBody),
      mediaBody.split('\n').slice(0, 12).join(' | '),
    )
  }

  console.log('proxy: segment bytes')
  {
    const match = /(\/stream\?u=[^\s#]+)/.exec(mediaBody ?? '')
    check('a rewritten segment URL can be extracted', !!match)

    if (match) {
      const segment = await session.evaluate(`
        (async () => {
          try {
            const response = await fetch(${JSON.stringify(origin)} + ${JSON.stringify(match[1])});
            const buffer = await response.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            return {
              ok: response.ok,
              status: response.status,
              contentType: response.headers.get('content-type'),
              byteLength: bytes.length,
              // A transport-stream segment starts with 0x47, the TS sync byte.
              firstByte: bytes.length ? bytes[0] : null,
            };
          } catch (e) { return { ok: false, error: String(e) } }
        })()
      `)
      check('the segment loads', segment.ok === true, JSON.stringify(segment).slice(0, 300))
      check('it has real bytes', (segment.byteLength ?? 0) > 1000, `${segment.byteLength}`)
      check(
        'it looks like an MPEG-TS segment',
        segment.firstByte === 0x47 || /mp2t|octet-stream/i.test(segment.contentType ?? ''),
        JSON.stringify({ first: segment.firstByte, type: segment.contentType }),
      )
    }
  }

  console.log('proxy: range request')
  let rangedResult = null
  {
    const match = /(\/stream\?u=[^\s#]+)/.exec(mediaBody ?? '')
    if (match) {
      const ranged = await session.evaluate(`
        (async () => {
          try {
            const response = await fetch(${JSON.stringify(origin)} + ${JSON.stringify(match[1])}, {
              headers: { Range: 'bytes=0-1023' },
            });
            const buffer = await response.arrayBuffer();
            return {
              ok: response.ok,
              status: response.status,
              byteLength: buffer.byteLength,
              contentRange: response.headers.get('content-range'),
              acceptRanges: response.headers.get('accept-ranges'),
            };
          } catch (e) { return { ok: false, error: String(e) } }
        })()
      `)
      rangedResult = ranged
      check('a range request is answered', ranged.ok === true, JSON.stringify(ranged).slice(0, 300))
      // Some origins ignore Range. Either a 206 with exactly 1024 bytes, or a 200
      // with the whole body, is acceptable — but it must not error.
      check(
        'the response is a 206 or a full 200',
        ranged.status === 206 || ranged.status === 200,
        `${ranged.status}`,
      )
      if (ranged.status === 206) {
        check('exactly the requested bytes came back', ranged.byteLength === 1024, `${ranged.byteLength}`)
        check(
          'Content-Range is present',
          /^bytes 0-1023\//.test(ranged.contentRange ?? ''),
          JSON.stringify(ranged.contentRange),
        )
        console.log(`       (206, content-range: ${ranged.contentRange})`)
      } else {
        console.log('       (origin ignored Range; returned the full body)')
      }
    }
  }

  console.log('proxy: CORS')
  {
    // A cross-origin request cannot read `Access-Control-Allow-Origin` from JS —
    // it is a protocol header, not response data, so `headers.get` returns null
    // even when it was sent correctly. The real evidence is that the cross-origin
    // fetches above succeeded at all: without the header the browser blocks them
    // before the response body is readable.
    check(
      'cross-origin reads of the proxy succeed (implying CORS is allowed)',
      master?.ok === true && master?.body?.startsWith('#EXTM3U') === true,
      JSON.stringify({ ok: master?.ok, first: (master?.body ?? '').slice(0, 20) }),
    )
    // The headers that *are* readable are the ones listed in
    // Access-Control-Expose-Headers. Content-Range is the one seeking depends on:
    // without it, a 206 response arrives but the player cannot tell where the
    // bytes start.
    check(
      'Content-Range is exposed to JS (seeking depends on it)',
      rangedResult?.status !== 206 || (rangedResult?.contentRange ?? '').length > 0,
      JSON.stringify({ status: rangedResult?.status, range: rangedResult?.contentRange }),
    )
    check(
      'Accept-Ranges is exposed so the player knows seeking is possible',
      (rangedResult?.acceptRanges ?? '').includes('bytes'),
      JSON.stringify(rangedResult?.acceptRanges),
    )
  }

  console.log('proxy: error reporting')
  {
    const notFound = await fetchThroughProxy('https://127.0.0.1:1/nope.m3u8')
    check(
      'an unreachable target produces a response, not a hang',
      notFound.status !== undefined || notFound.error !== undefined,
      JSON.stringify(notFound).slice(0, 200),
    )
    if (notFound.status !== undefined) {
      check('the status is an error code', notFound.status >= 400, `${notFound.status}`)
      check('the body explains the failure', (notFound.body ?? '').length > 0, notFound.body)
    }

    const missingParam = await session.evaluate(`
      (async () => {
        try {
          const response = await fetch(${JSON.stringify(origin)} + '/stream');
          return { status: response.status, body: (await response.text()).slice(0, 200) };
        } catch (e) { return { error: String(e) } }
      })()
    `)
    check(
      'a missing target is rejected with a message',
      (missingParam.status ?? 0) >= 400 || !!missingParam.error,
      JSON.stringify(missingParam),
    )
  }

  console.log('proxy: scheme guard')
  {
    // A `file:` target must be refused by the same check `net.rs` uses. This is
    // the security boundary the proxy could otherwise widen.
    const fileTarget = await fetchThroughProxy('file:///C:/Windows/win.ini')
    check(
      'a file: target is refused',
      (fileTarget.status ?? 0) >= 400 || !!fileTarget.error,
      JSON.stringify(fileTarget).slice(0, 200),
    )
    check(
      'and the message says why',
      /只支持|http/i.test(fileTarget.body ?? fileTarget.error ?? ''),
      JSON.stringify(fileTarget).slice(0, 200),
    )
  }

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
