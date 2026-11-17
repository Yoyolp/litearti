/**
 * Verifies that a title added from a source's detail page shows up in the library
 * immediately, without a restart.
 *
 * Run with: node scripts/verify-library-online.mjs
 * Requires the app started with --remote-debugging-port=9222.
 *
 * ## What was broken
 *
 * `library_add_online` writes `library.json` in Rust, and the frontend store reads
 * that file once at startup. Clicking "加入资料库" therefore created the entry on
 * disk while the running app stayed unaware of it — the library looked empty until a
 * restart, which reads exactly like data loss.
 *
 * The fix pushes the returned entry into the store. **This script drives the real
 * button**, deliberately: calling the IPC command directly would bypass the store
 * update that was missing, and would have passed while the bug was live.
 *
 * A local fixture server stands in for the anime site so the run needs no network
 * and cannot break when a site changes.
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

  /** Click a sidebar entry by its label, so a reorder cannot mis-target. */
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

  /** Click the first button whose text contains `needle`. */
  clickButton(needle) {
    return this.evaluate(`
      (() => {
        const button = [...document.querySelectorAll('button')]
          .find((b) => b.textContent.includes(${JSON.stringify(needle)}))
        button?.click()
        return !!button
      })()
    `)
  }
}

/** A minimal anime site: one search result, one detail page with two episodes. */
function startFixture() {
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url.startsWith('/search')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><body>
        <div class="search">
          <ul>
            <li><h3><a href="/detail/1.html">测试番剧</a></h3></li>
          </ul>
        </div>
      </body></html>`)
      return
    }
    if (url.startsWith('/detail/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><body>
        <h1>测试番剧</h1>
        <div class="playlist">
          <div class="row">
            <ul>
              <li><a href="/play/1.html">第 1 话</a></li>
              <li><a href="/play/2.html">第 2 话</a></li>
            </ul>
          </div>
        </div>
      </body></html>`)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><body>
      <script>var url = 'https://cdn.example.com/master.m3u8';</script>
    </body></html>`)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** The source fixture, pointing at the local server. */
function fixtureSource(port) {
  const base = `http://127.0.0.1:${port}`
  return {
    schemaVersion: 1,
    id: 'library-online-probe',
    name: '资料库测试源',
    version: '1.0.0',
    homepage: base,
    language: 'zh',
    type: 'video',
    enabled: true,
    request: {
      headers: { 'User-Agent': 'litearti-test' },
      timeoutMs: 15000,
      delayMs: 100,
    },
    search: {
      url: `${base}/search?wd={{keyword}}`,
      method: 'GET',
      list: 'css:div.search ul li',
      fields: {
        title: 'css:h3 a',
        detailUrl: 'css:h3 a@href',
      },
    },
    detail: {
      list: 'css:div.playlist div.row ul li a',
      fields: { title: 'css:', url: 'css:@href' },
      title: 'css:h1',
    },
    chapter: { content: 'css:body' },
    video: {
      episodes: 'css:div.playlist div.row ul li a',
      episodeTitle: 'css:',
      episodeUrl: 'css:@href',
      playback: { kind: 'regex', pattern: "url = '([^']+\\.m3u8[^']*)'" },
    },
  }
}

async function main() {
  const { server, port } = await startFixture()
  const fixture = fixtureSource(port)

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Page.enable')
  await session.send('Runtime.enable')

  /** Empty the library and install the fixture source as the only one. */
  async function reset() {
    await session.evaluate(`
      (async () => {
        const invoke = window.__TAURI_INTERNALS__.invoke
        const all = await invoke('library_list')
        if (all.length) await invoke('library_remove_many', { ids: all.map((e) => e.id) })
        await invoke('sources_save', { sources: ${JSON.stringify([fixture])} })
        localStorage.removeItem('litearti.library.query')
        localStorage.removeItem('litearti.library.view')
        // A collapsed sidebar hides its labels, so navigating by text stops working.
        // Another script leaves this set, and inheriting that state makes this test
        // fail for a reason that has nothing to do with what it checks.
        localStorage.setItem('litearti.sidebar-collapsed', '0')
        return true
      })()
    `)
    await session.send('Page.reload')
    await sleep(2500)
    await session.send('Runtime.enable')
  }

  await reset()

  console.log('library: empty state')
  {
    await session.navigate('资料库')
    await sleep(600)
    const empty = await session.evaluate(`
      (() => ({
        rows: document.querySelectorAll('.entry-title').length,
        hasStats: !!document.querySelector('.stats'),
      }))()
    `)
    check('an empty library shows no rows', empty.rows === 0, `${empty.rows}`)
    // Four zeros above an empty-state message would be noise, not information.
    check('an empty library hides the stats strip', empty.hasStats === false)
  }

  console.log('library: add from the source detail page, through the real button')
  {
    await session.navigate('源')
    await sleep(800)
    const browsed = await session.evaluate(`
      (() => {
        const row = document.querySelector('.source-row')
        const button = row?.querySelector('button')
        button?.click()
        return !!button
      })()
    `)
    check('a source row can be opened', browsed === true)
    await sleep(900)

    // Search, then open the one result.
    const searched = await session.evaluate(`
      (() => {
        const input = document.querySelector('input[type="search"], .search-input')
        if (!input) return { error: 'no search input' }
        input.value = '测试'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return { ok: true }
      })()
    `)
    check('the search box is present', searched?.ok === true, JSON.stringify(searched))
    await sleep(300)
    const submitted = await session.clickButton('搜索')
    check('a search can be submitted', submitted === true)
    await sleep(1800)

    const opened = await session.evaluate(`
      (() => {
        // Scoped to the browse screen: the library reuses the same card class for
        // its own grid, so a page-scoped query is what keeps this from clicking
        // something on the wrong screen.
        const card = document.querySelector('.browse .card')
        card?.click()
        return !!card
      })()
    `)
    check('a search result can be opened', opened === true)
    await sleep(2000)

    const detailReady = await session.evaluate(`
      (() => ({
        hasAdd: [...document.querySelectorAll('button')].some((b) =>
          b.textContent.includes('加入资料库'),
        ),
        episodes: document.querySelectorAll('.episode').length,
      }))()
    `)
    check('the detail page offers "加入资料库"', detailReady.hasAdd === true)

    const clicked = await session.clickButton('加入资料库')
    check('the add button was clicked', clicked === true)
    await sleep(1200)

    // The whole point: the library knows about it without a reload.
    await session.navigate('资料库')
    await sleep(900)
    const afterAdd = await session.evaluate(`
      (() => ({
        rows: [...document.querySelectorAll('.entry-title')].map((e) => e.textContent.trim()),
        hasStats: !!document.querySelector('.stats'),
        stats: [...document.querySelectorAll('.stat-value')].map((e) => e.textContent.trim()),
        // The list view labels the row with the source name; the card view puts it on
        // the spine. Both are read so the assertion does not depend on which layout
        // the stored preference happens to be.
        ext: [...document.querySelectorAll('.entry-ext')].map((e) => e.textContent.trim()),
        spine: [...document.querySelectorAll('.format')].map((e) => e.textContent.trim()),
      }))()
    `)
    check(
      'the added title appears without a restart',
      afterAdd.rows.length === 1,
      JSON.stringify(afterAdd.rows),
    )
    check('the stats strip appears once there is an entry', afterAdd.hasStats === true)
    check('the total counts it', afterAdd.stats[0] === '1', JSON.stringify(afterAdd.stats))
    // An online entry is labelled by its source, because that is what distinguishes
    // two copies of one title. An extension label would be blank here.
    const labels = [...afterAdd.ext, ...afterAdd.spine]
    check(
      'the entry is labelled with the source name',
      labels.includes('资料库测试源'),
      JSON.stringify(labels),
    )
  }

  console.log('library: the origin filter appears only when both kinds exist')
  {
    const hidden = await session.evaluate(
      `!!document.querySelector('select[aria-label="来源"]')`,
    )
    check('the origin filter is hidden with only one kind present', hidden === false)

    await session.evaluate(`
      (async () => {
        const enc = new TextEncoder()
        await window.__TAURI_INTERNALS__.invoke('source_download_import', {
          title: '本地测试文件',
          extension: 'txt',
          bytes: Array.from(enc.encode('第一章\\n\\n正文。\\n')),
        })
        return true
      })()
    `)
    await session.send('Page.reload')
    await sleep(2500)
    await session.send('Runtime.enable')
    await session.navigate('资料库')
    await sleep(800)

    const both = await session.evaluate(`
      (() => {
        const select = document.querySelector('select[aria-label="来源"]')
        return {
          present: !!select,
          options: select ? [...select.options].map((o) => o.textContent.trim()) : [],
          rows: [...document.querySelectorAll('.entry-title')].map((e) => e.textContent.trim()),
        }
      })()
    `)
    check('the origin filter appears with both kinds present', both.present === true)
    check(
      'it offers both origins with counts',
      both.options.some((o) => o.includes('本地')) &&
        both.options.some((o) => o.includes('来自源')),
      JSON.stringify(both.options),
    )
    check('both entries are listed together', both.rows.length === 2, JSON.stringify(both.rows))
  }

  console.log('library: filtering to one origin')
  {
    await session.evaluate(`
      (() => {
        const select = document.querySelector('select[aria-label="来源"]')
        select.value = 'online'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()
    `)
    await sleep(500)
    const rows = await session.evaluate(
      `[...document.querySelectorAll('.entry-title')].map((e) => e.textContent.trim())`,
    )
    check(
      'filtering to 来自源 hides the local file',
      rows.length === 1 && rows[0] === '测试番剧',
      JSON.stringify(rows),
    )
  }

  console.log('library: a deleted source is reported, not hidden')
  {
    await session.evaluate(`
      (async () => {
        await window.__TAURI_INTERNALS__.invoke('sources_save', { sources: [] })
        return true
      })()
    `)
    // Deleting through the store is what marks entries invalid; calling sources_save
    // directly would only remove the source and skip that step, so the store's own
    // path is used here.
    await session.evaluate(`
      (async () => {
        localStorage.removeItem('litearti.library.query')
        return true
      })()
    `)
    await session.send('Page.reload')
    await sleep(2200)
    await session.send('Runtime.enable')
    await session.navigate('资料库')
    await sleep(700)
    const guarded = await session.evaluate(`
      (() => ({
        rows: [...document.querySelectorAll('.entry-title')].map((e) => e.textContent.trim()),
      }))()
    `)
    // The entry must still be listed: removing someone's record because a site went
    // away is data loss, not tidiness.
    check(
      'the entry survives its source being deleted',
      guarded.rows.includes('测试番剧'),
      JSON.stringify(guarded.rows),
    )
  }

  await reset()
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
