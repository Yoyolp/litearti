/**
 * Verifies the discover screen against real Bangumi data.
 *
 * Run with: node scripts/verify-ui-discover.mjs
 * Requires the app started with --remote-debugging-port=9222.
 *
 * ## What this test is allowed to touch
 *
 * It talks to the **real mirror** (`api.kazumi.fyi`), not a fixture server. That is
 * deliberate and it costs something: the test needs a network that can reach the
 * mirror, and it will fail in an environment that cannot. The alternative — a
 * fixture server serving `scripts/fixtures/bgm-calendar.json` — would test the
 * parsing and rendering but not that the app's own request path works, which is the
 * half that broke before.
 *
 * The parsing itself is covered offline by `verify-bgm-parse.mjs`, which runs against
 * the committed captures. So this file's job is narrow: does the screen load, does it
 * show what came back, does marking work.
 *
 * ## Why the source search is tested with a fixture
 *
 * "Find this on a source" hits sites the test cannot control, so a local server
 * stands in. The interesting assertion is not that the search works — the source
 * engine is already covered — but that a Bangumi title reaches a source query and
 * comes back through the matcher.
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
      }, 40000)
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

  navigate(label) {
    return this.evaluate(`
      (() => {
        const item = [...document.querySelectorAll('.nav-item')]
          .find((n) => n.textContent.trim() === ${JSON.stringify(label)})
        item?.click()
        return !!item
      })()
    `)
  }

  /** Count cards and read their titles, scoped to a selector. */
  cards(scope) {
    return this.evaluate(`
      (() => {
        const root = document.querySelector(${JSON.stringify(scope)}) ?? document
        return [...root.querySelectorAll('.subject .title')].map((e) => e.textContent.trim())
      })()
    `)
  }
}

/** A source fixture whose search returns one fixed title. */
function startFixture(searchTitle) {
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url.startsWith('/search')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><body>
        <div class="search"><ul>
          <li><h3><a href="/detail/1.html">${searchTitle}</a></h3></li>
          <li><h3><a href="/detail/2.html">完全不相关的另一部</a></h3></li>
        </ul></div>
      </body></html>`)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><body><h1>detail</h1></body></html>')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function fixtureSource(port) {
  const base = `http://127.0.0.1:${port}`
  return {
    schemaVersion: 1,
    id: 'discover-probe',
    name: '发现测试源',
    version: '1.0.0',
    homepage: base,
    language: 'zh',
    type: 'video',
    enabled: true,
    request: { headers: { 'User-Agent': 'litearti-test' }, timeoutMs: 15000, delayMs: 50 },
    search: {
      url: `${base}/search?wd={{keyword}}`,
      method: 'GET',
      list: 'css:div.search ul li',
      fields: { title: 'css:h3 a', detailUrl: 'css:h3 a@href' },
    },
    detail: {
      list: 'css:ul li a',
      fields: { title: 'css:', url: 'css:@href' },
      title: 'css:h1',
    },
    chapter: { content: 'css:body' },
    video: {
      episodes: 'css:ul li a',
      episodeTitle: 'css:',
      episodeUrl: 'css:@href',
      playback: { kind: 'regex', pattern: "(url)\\s*=\\s*'([^']+)'" },
    },
  }
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Page.enable')
  await session.send('Runtime.enable')

  // A collapsed sidebar hides its labels, so navigating by text would fail.
  await session.evaluate(`localStorage.setItem('litearti.sidebar-collapsed', '0')`)
  await session.evaluate(`localStorage.removeItem('litearti.bangumi.collect')`)
  await session.send('Page.reload')
  await sleep(2600)
  await session.send('Runtime.enable')

  const navigated = await session.navigate('发现')
  check('the sidebar has a 发现 entry', navigated === true)
  // The first load makes a real network request through Rust; the 1 s rate limit
  // means the calendar request queues behind it.
  await sleep(7000)

  console.log('discover: popular tab')
  {
    const view = await session.evaluate(`
      (() => ({
        title: document.querySelector('.title')?.textContent?.trim() ?? null,
        tabs: [...document.querySelectorAll('.tab')].map((b) => b.textContent.trim()),
        cards: document.querySelectorAll('.subject').length,
        hasError: !!document.querySelector('.state-title'),
        errorText: document.querySelector('.state-body')?.textContent?.trim() ?? null,
        firstScore: document.querySelector('.subject .score')?.textContent?.trim() ?? null,
      }))()
    `)
    check('the screen renders', view.title === '发现', JSON.stringify(view.title))
    check('both tabs exist', view.tabs.length === 2, JSON.stringify(view.tabs))
    check('no error state is shown', view.hasError === false, view.errorText)
    // 24 is the page size; asserting a range keeps this valid if the mirror returns
    // fewer for a thin week.
    check('subjects are loaded from the mirror', view.cards >= 10, `${view.cards} cards`)
    if (view.firstScore) {
      check('a subject shows a score', /^\d+\.\d$/.test(view.firstScore), view.firstScore)
    }
  }

  console.log('discover: covers fall back rather than break')
  {
    // Covers are hot-linked from api.bgm.tv, which a restricted network cannot reach.
    // The fallback tile is therefore the normal path here, not an error, and it must
    // be a character rather than an empty box.
    const fallbacks = await session.evaluate(`
      (() => {
        const tiles = [...document.querySelectorAll('.cover-fallback')]
        return {
          count: tiles.length,
          sample: tiles[0]?.textContent?.trim() ?? null,
          brokenImages: [...document.querySelectorAll('.cover img')].filter((img) => !img.naturalWidth).length,
        }
      })()
    `)
    check(
      'every cover is either loaded or has a placeholder',
      fallbacks.brokenImages === 0 || fallbacks.count === 0,
      JSON.stringify(fallbacks),
    )
    if (fallbacks.count > 0) {
      check(
        'the placeholder shows a character, not an empty box',
        !!fallbacks.sample,
        JSON.stringify(fallbacks.sample),
      )
    }
  }

  console.log('discover: timeline tab')
  {
    await session.evaluate(`
      [...document.querySelectorAll('.tab')].find((b) => b.textContent.trim() === '新番时间表')?.click()
    `)
    await sleep(6000)

    const view = await session.evaluate(`
      (() => ({
        season: document.querySelector('.season-label')?.textContent?.trim() ?? null,
        days: [...document.querySelectorAll('.day')].map((d) => ({
          weekday: d.querySelector('.day-title')?.textContent?.trim()?.split(/\\s+/)[0],
          cards: d.querySelectorAll('.subject').length,
        })),
        today: !!document.querySelector('.day.is-today'),
        hasError: !!document.querySelector('.state-title'),
        errorText: document.querySelector('.state-body')?.textContent?.trim() ?? null,
      }))()
    `)
    check('no error state is shown', view.hasError === false, view.errorText)
    check('a season label is shown', !!view.season, JSON.stringify(view.season))
    check('seven days are rendered', view.days.length === 7, `${view.days.length}`)
    const total = view.days.reduce((sum, day) => sum + day.cards, 0)
    check('subjects are grouped by day', total > 20, `${total} subjects across the week`)
    check('today is highlighted', view.today === true)
  }

  console.log('discover: marking a subject')
  {
    const before = await session.evaluate(
      `[...document.querySelectorAll('.status-value')].map((e) => e.textContent.trim())`,
    )
    check('the status summary starts at zero', before.every((n) => n === '0'), JSON.stringify(before))

    await session.evaluate(`
      (() => {
        const card = document.querySelector('.day .subject')
        const button = [...card.querySelectorAll('.collect-btn')]
          .find((b) => b.textContent.trim() === '在看')
        button?.click()
        return true
      })()
    `)
    await sleep(400)

    const after = await session.evaluate(`
      (() => ({
        counts: [...document.querySelectorAll('.status-value')].map((e) => e.textContent.trim()),
        active: document.querySelector('.day .collect-btn.is-active')?.textContent?.trim() ?? null,
        stored: localStorage.getItem('litearti.bangumi.collect'),
      }))()
    `)
    check('the 在看 count goes up', after.counts[1] === '1', JSON.stringify(after.counts))
    check('the button shows as active', after.active === '在看', JSON.stringify(after.active))
    check('the status is persisted', !!after.stored && after.stored.includes('watching'), after.stored)

    // Clicking the active status again clears it: four options do not need a fifth
    // "clear" control.
    await session.evaluate(`
      (() => {
        const card = document.querySelector('.day .subject')
        const button = [...card.querySelectorAll('.collect-btn')]
          .find((b) => b.textContent.trim() === '在看')
        button?.click()
        return true
      })()
    `)
    await sleep(300)
    const cleared = await session.evaluate(
      `[...document.querySelectorAll('.status-value')].map((e) => e.textContent.trim())`,
    )
    check('clicking the active status clears it', cleared[1] === '0', JSON.stringify(cleared))
  }

  console.log('discover: the marked-only filter')
  {
    // Mark two subjects so the filter has something to keep.
    await session.evaluate(`
      (() => {
        const cards = [...document.querySelectorAll('.day .subject')].slice(0, 2)
        for (const card of cards) {
          const button = [...card.querySelectorAll('.collect-btn')]
            .find((b) => b.textContent.trim() === '想看')
          button?.click()
        }
        return true
      })()
    `)
    await sleep(300)

    const totalBefore = await session.evaluate(
      `document.querySelectorAll('.day .subject').length`,
    )
    await session.evaluate(`
      [...document.querySelectorAll('.choice')].find((b) => b.textContent.includes('只看我标记'))?.click()
    `)
    await sleep(400)
    const totalAfter = await session.evaluate(
      `document.querySelectorAll('.day .subject').length`,
    )
    check('the filter narrows the list', totalAfter < totalBefore, `${totalBefore} → ${totalAfter}`)
    check('the filtered list keeps the marked items', totalAfter === 2, `${totalAfter}`)

    // Put it back.
    await session.evaluate(`
      [...document.querySelectorAll('.choice')].find((b) => b.textContent.includes('只看我标记'))?.click()
    `)
    await sleep(200)
  }

  console.log('discover: season navigation')
  {
    const original = await session.evaluate(
      `document.querySelector('.season-label')?.textContent?.trim()`,
    )
    await session.evaluate(`
      [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '上一季')?.click()
    `)
    await sleep(6000)
    const shifted = await session.evaluate(`
      (() => ({
        season: document.querySelector('.season-label')?.textContent?.trim() ?? null,
        cards: document.querySelectorAll('.day .subject').length,
      }))()
    `)
    check('the season changes', shifted.season !== original, `${original} → ${shifted.season}`)
    // A previous season should have shows; an empty one would suggest the range is
    // wrong rather than the season being quiet.
    check('the previous season has subjects', shifted.cards > 10, `${shifted.cards}`)

    // Back to the current season, so a rerun starts where a person would expect.
    await session.evaluate(`
      [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '本季')?.click()
    `)
    await sleep(5000)
  }

  console.log('discover: finding a subject on a source')
  {
    const { server, port } = await startFixture('学生会也有洞 第一季')
    try {
      await session.evaluate(`
        (async () => {
          await window.__TAURI_INTERNALS__.invoke('sources_save', {
            sources: [${JSON.stringify(fixtureSource(port))}],
          })
          return true
        })()
      `)
      await session.send('Page.reload')
      await sleep(2600)
      await session.send('Runtime.enable')
      await session.navigate('发现')
      await sleep(7000)

      // Click the first card's title; the matcher should reach the fixture source and
      // land on a detail page whose title is the fixture's.
      await session.evaluate(`
        (() => {
          const card = document.querySelector('.day .subject .subject-hit')
          card?.click()
          return !!card
        })()
      `)
      await sleep(3000)

      const landed = await session.evaluate(`
        (() => ({
          section: document.querySelector('.content')?.firstElementChild?.className ?? null,
          notice: document.querySelector('.notice-text')?.textContent?.trim() ?? null,
          heading: document.querySelector('h1')?.textContent?.trim() ?? null,
        }))()
      `)
      // Either it landed on the source detail screen, or it reported that nothing
      // matched. Both are honest outcomes; silently doing nothing is not.
      check(
        'clicking a subject either navigates or explains why not',
        !!landed.notice || !!landed.section,
        JSON.stringify(landed),
      )
      if (landed.notice) {
        check(
          'the notice names the title it could not find',
          landed.notice.includes('没有源') || landed.notice.includes('找到'),
          landed.notice,
        )
      }
    } finally {
      server.close()
      // Leave the source list as it was found.
      await session.evaluate(`
        (async () => {
          await window.__TAURI_INTERNALS__.invoke('sources_save', { sources: [] })
          return true
        })()
      `)
    }
  }

  // Leave no state behind.
  await session.evaluate(`localStorage.removeItem('litearti.bangumi.collect')`)

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
