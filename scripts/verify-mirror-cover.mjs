/**
 * Verifies the rule mirror client and the cover cache.
 *
 * Run with: node scripts/verify-mirror-cover.mjs
 * Requires the app started with --remote-debugging-port=9222.
 *
 * ## What this touches
 *
 * Both features talk to the network, so this script does too. That is a real cost —
 * it needs a network where the mirrors are reachable — but the alternative is worse:
 * a fixture server would only prove that the parser parses whatever the fixture
 * author wrote, while the whole point of these two features is that the real world
 * is inconsistent (one mirror is stale, the image hosts may be blocked).
 *
 * ## What it deliberately does not assert
 *
 * The exact rule count. Mirrors update independently and the catalogue changes as
 * rules are added or retired; pinning a number would make this fail for a reason that
 * has nothing to do with the code. It asserts *relationships* instead: the same
 * mirror answers twice, rule names are fetchable, and an unknown name is refused.
 */
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

  /** Call a Tauri command, returning `{ok, value}` or `{ok:false, error}`. */
  async command(name, args = {}) {
    const raw = await this.evaluate(`
      (async () => {
        try {
          const value = await window.__TAURI_INTERNALS__.invoke(
            ${JSON.stringify(name)},
            ${JSON.stringify(args)},
          )
          return JSON.stringify({ ok: true, value })
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error) })
        }
      })()
    `)
    return JSON.parse(raw)
  }
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  console.log('rules: the mirror list is fixed')
  {
    const result = await session.command('rules_mirrors')
    check('the command answers', result.ok === true, JSON.stringify(result))
    const ids = result.ok ? result.value : []
    check('three mirrors are offered', ids.length === 3, JSON.stringify(ids))
    // The ids are what the frontend stores; a change here would silently reset
    // everyone's choice to the default.
    check(
      'the ids are the documented ones',
      ['gitcode', 'ghproxy', 'github'].every((id) => ids.includes(id)),
      JSON.stringify(ids),
    )
  }

  console.log('rules: unknown ids are refused')
  {
    // A typo must not look like an empty catalogue.
    const bad = await session.command('rules_index', { mirror: 'nonsense' })
    check('an unknown mirror is an error', bad.ok === false, JSON.stringify(bad))
    const traversal = await session.command('rules_rule', {
      mirror: 'github',
      name: '../escape',
    })
    check('a path traversal name is refused', traversal.ok === false, JSON.stringify(traversal))
  }

  console.log('rules: at least one mirror serves the catalogue')
  {
    const results = []
    for (const mirror of ['gitcode', 'ghproxy', 'github']) {
      const result = await session.command('rules_index', { mirror })
      let count = 0
      let names = []
      if (result.ok) {
        try {
          const parsed = JSON.parse(result.value)
          if (Array.isArray(parsed)) {
            names = parsed.map((item) => item.name).filter(Boolean)
            count = names.length
          }
        } catch {
          count = -1
        }
      }
      results.push({ mirror, count, names })
      console.log(`       ${mirror.padEnd(9)} ${count} 条`)
    }

    // The whole feature is pointless if every mirror is down, and that is worth a
    // failure rather than a skip: it means the app cannot browse rules at all.
    const working = results.filter((entry) => entry.count > 0)
    check('at least one mirror returns a catalogue', working.length > 0, JSON.stringify(results.map((r) => [r.mirror, r.count])))

    const names = working[0]?.names ?? []
    check('the catalogue has entries', names.length > 5, `${names.length}`)
    check(
      'entries have plausible names',
      names.every((name) => /^[\w.-]+$/.test(name)),
      JSON.stringify(names.slice(0, 5)),
    )

    // Mirrors update independently. Recording the disagreement rather than failing on
    // it: a stale mirror is a fact about the world, and the UI lets people switch.
    const counts = working.map((entry) => entry.count)
    if (new Set(counts).size > 1) {
      console.log(`       (mirrors disagree: ${working.map((r) => `${r.mirror}=${r.count}`).join(', ')} — one may be stale)`)
    }

    console.log('rules: a rule file can be fetched by name')
    if (working.length > 0 && names.length > 0) {
      const sample = names[0]
      const rule = await session.command('rules_rule', {
        mirror: working[0].mirror,
        name: sample,
      })
      check(`the rule "${sample}" is fetchable`, rule.ok === true, JSON.stringify(rule).slice(0, 200))
      if (rule.ok) {
        let parsed = null
        try {
          parsed = JSON.parse(rule.value)
        } catch {
          // handled by the assertion below
        }
        check('the rule is JSON', parsed !== null)
        // A community rule always names itself; a response without a name is a
        // mirror serving something else.
        check(
          'the rule names itself',
          typeof parsed?.name === 'string' && parsed.name.length > 0,
          JSON.stringify(parsed)?.slice(0, 120),
        )
      }

      // Case matters to the server. Recording it so a future reader does not "fix"
      // this into a silent fallback that hides a broken catalogue.
      const wrongCase = await session.command('rules_rule', {
        mirror: working[0].mirror,
        name: sample.toUpperCase(),
      })
      if (sample.toUpperCase() !== sample) {
        check(
          'an uppercased name is not silently matched',
          wrongCase.ok === false,
          JSON.stringify(wrongCase).slice(0, 160),
        )
      }
    }
  }

  console.log('rules: the cached catalogue is served without a second request')
  {
    const mirror = 'gitcode'
    const first = await session.command('rules_index', { mirror })
    if (first.ok) {
      const started = Date.now()
      const second = await session.command('rules_index', { mirror })
      const elapsed = Date.now() - started
      check('the second call succeeds', second.ok === true, JSON.stringify(second).slice(0, 160))
      check('the content is identical', second.value === first.value)
      // A cache hit is a file read; a network round trip is much slower. 250 ms is
      // generous for a local read and strict enough to catch a cache miss.
      check(`the second call is served from cache (${elapsed} ms)`, elapsed < 250, `${elapsed} ms`)
    } else {
      console.log('       (skipped: the mirror did not answer)')
    }
  }

  console.log('cover cache: failures are remembered')
  {
    // A URL on an unroutable host: the request fails immediately rather than hanging,
    // so the negative-cache path is exercised without a 10 s timeout.
    const url = 'https://127.0.0.1:1/never.jpg'

    const first = await session.command('bangumi_cover', { url })
    check('a failing cover resolves to null rather than an error', first.ok === true, JSON.stringify(first))
    check('the value is null', first.ok && first.value === null, JSON.stringify(first.value))

    const started = Date.now()
    const second = await session.command('bangumi_cover', { url })
    const elapsed = Date.now() - started
    check('the second attempt also returns null', second.ok && second.value === null)
    // The first attempt had to open a socket; the second is answered from the failure
    // record. Under 100 ms is clearly the cached path.
    check(`the second attempt is not retried (${elapsed} ms)`, elapsed < 100, `${elapsed} ms`)
  }

  console.log('cover cache: a bad scheme is refused')
  {
    const result = await session.command('bangumi_cover', { url: 'file:///etc/passwd' })
    check('a file:// cover URL is an error', result.ok === false, JSON.stringify(result))
  }

  console.log('cover cache: stats and clearing')
  {
    const before = await session.command('bangumi_cover_stats')
    check('stats answer', before.ok === true, JSON.stringify(before))
    // The failure record must not be counted as a cached image.
    check(
      'a failure record is not counted as a file',
      before.ok && Array.isArray(before.value) && before.value[1] === 0,
      JSON.stringify(before.value),
    )

    const cleared = await session.command('bangumi_clear_covers')
    check('clearing succeeds', cleared.ok === true, JSON.stringify(cleared))

    const after = await session.command('bangumi_cover_stats')
    check('the cache is empty afterwards', after.ok && after.value[0] === 0 && after.value[1] === 0, JSON.stringify(after.value))
  }

  console.log('metadata cache: clearing')
  {
    const cleared = await session.command('bangumi_clear_cache')
    check('clearing succeeds', cleared.ok === true, JSON.stringify(cleared))
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
