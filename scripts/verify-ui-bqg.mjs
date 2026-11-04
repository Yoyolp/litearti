// Drives the packaged app against the real bqg5555 source.
//
// Run with: node scripts/verify-ui-bqg.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// This is the end-to-end proof for the book source feature: the app's own UI,
// its own IPC, and the Rust HTTP client — no shims. It is kept as a separate
// script from the offline suite because it depends on a third-party site being
// reachable and unchanged.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const ROOT = 'D:/Myproject/litearti'

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
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`${detail}\n  while evaluating: ${expression.trim().slice(0, 200)}`)
    }
    return result.result.value
  }

  async reload(waitMs = 2200) {
    this.ws.send(
      JSON.stringify({
        id: this.nextId++,
        method: 'Runtime.evaluate',
        params: { expression: 'location.reload()' },
      }),
    )
    await sleep(waitMs)
  }
}

/** Wait until `expression` returns truthy, or time out. */
async function waitFor(session, expression, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await session.evaluate(expression)
    if (value) return value
    await sleep(300)
  }
  return null
}

async function main() {
  const source = JSON.parse(await readFile(join(ROOT, 'sources/bqg5555.json'), 'utf8'))

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  await session.reload()

  console.log('install the source through IPC')
  {
    const saved = await session.evaluate(`
      (async () => {
        await window.__TAURI_INTERNALS__.invoke('sources_save', {
          sources: ${JSON.stringify([source])},
        })
        const loaded = await window.__TAURI_INTERNALS__.invoke('sources_load')
        return Array.isArray(loaded) && loaded.length === 1 ? loaded[0].id : null
      })()
    `)
    check('source persisted', saved === 'bqg5555', String(saved))
  }

  await session.reload()
  await session.evaluate(`[...document.querySelectorAll('.nav-list .nav-item')][2].click()`)
  await sleep(1500)

  console.log('sources list')
  {
    const rows = await session.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.source-row')]
        return { count: rows.length, text: rows[0]?.textContent?.replace(/\\s+/g, ' ').trim() ?? null }
      })()
    `)
    check('source is listed', rows.count === 1, JSON.stringify(rows))
    check('row shows its name', (rows.text ?? '').includes('笔趣阁'), rows.text)
  }

  console.log('open the source and search (live, through Rust HTTP)')
  {
    const clicked = await session.evaluate(`
      (() => {
        const row = document.querySelector('.source-row .source-open')
        if (!row) return 'no row'
        row.click()
        return 'clicked'
      })()
    `)
    check('opened browse view', clicked === 'clicked', clicked)
    await sleep(1200)

    const view = await session.evaluate(`
      (() => ({
        browse: !!document.querySelector('.browse'),
        hasSearch: !!document.querySelector('.search-input'),
      }))()
    `)
    check('browse view mounted', view.browse === true, JSON.stringify(view))

    // Type and search.
    await session.evaluate(`
      (() => {
        const input = document.querySelector('.search-input')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '斗破')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(400)
    await session.evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('.search-row button')]
        const search = buttons.find((b) => !b.disabled)
        if (search) search.click()
      })()
    `)

    const cards = await waitFor(
      session,
      `document.querySelectorAll('.card').length > 0 ? document.querySelectorAll('.card').length : 0`,
      40000,
    )
    check('search returned cards', typeof cards === 'number' && cards > 0, `${cards}`)

    const sample = await session.evaluate(`
      (() => {
        const cards = [...document.querySelectorAll('.card')]
        return cards.slice(0, 3).map((c) => ({
          title: c.querySelector('.title')?.textContent?.trim(),
          type: c.querySelector('.type')?.textContent?.trim(),
          hasCover: !!c.querySelector('.cover-image'),
          coverSrc: c.querySelector('.cover-image')?.getAttribute('src') ?? null,
        }))
      })()
    `)
    check('cards have titles', (sample ?? []).every((c) => c.title && c.title.length > 0), JSON.stringify(sample))
    check('cards show the resource type', (sample ?? []).every((c) => c.type === '小说'), JSON.stringify(sample))
    console.log(`       first 3: ${(sample ?? []).map((c) => c.title).join(' | ')}`)
    // Covers are backfilled from detail pages after the list appears, one
    // request per card. Wait until several have actually decoded — asserting on
    // the element existing would pass before the image loads.
    const loadedCovers = await waitFor(
      session,
      `[...document.querySelectorAll('.cover-image')].filter((i) => i.complete && i.naturalWidth > 0).length >= 3
        ? [...document.querySelectorAll('.cover-image')].filter((i) => i.complete && i.naturalWidth > 0).length
        : 0`,
      60000,
    )
    check('covers backfilled and decoded', typeof loadedCovers === 'number' && loadedCovers >= 3, `${loadedCovers}`)

    const coverInfo = await session.evaluate(`
      (() => {
        const imgs = [...document.querySelectorAll('.cover-image')]
        return {
          total: document.querySelectorAll('.card').length,
          withImage: imgs.length,
          firstSrc: imgs[0]?.getAttribute('src') ?? null,
          loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
          firstSize: imgs[0] ? [imgs[0].naturalWidth, imgs[0].naturalHeight] : null,
        }
      })()
    `)
    check('cover images actually load', (coverInfo?.loaded ?? 0) > 0, JSON.stringify(coverInfo))
    console.log(`       covers: ${coverInfo.withImage}/${coverInfo.total} cards, ${coverInfo.loaded} decoded`)
    console.log(`       first cover: ${coverInfo.firstSrc} (${coverInfo.firstSize?.join('x')})`)
  }

  console.log('open a detail page')
  {
    // Pick a card whose book actually opens; some listings are dead.
    let opened = false
    for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
      await session.evaluate(`
        (() => {
          const cards = [...document.querySelectorAll('.card')]
          const card = cards[${attempt}]
          if (card) card.click()
        })()
      `)
      const listed = await waitFor(
        session,
        `document.querySelectorAll('.chapter-row').length > 0 ? document.querySelectorAll('.chapter-row').length : 0`,
        20000,
      )
      if (listed) opened = true
      else {
        // Go back and try the next card.
        await session.evaluate(`
          (() => {
            const back = [...document.querySelectorAll('.detail-header button')][0]
            if (back) back.click()
          })()
        `)
        await sleep(800)
      }
    }
    check('a detail page loaded with chapters', opened === true)

    if (opened) {
      const detail = await session.evaluate(`
        (() => ({
          title: document.querySelector('.hero-title')?.textContent?.trim(),
          author: document.querySelector('.hero-author')?.textContent?.trim(),
          hasCover: !!document.querySelector('.hero-image'),
          introLength: (document.querySelector('.hero-intro')?.textContent ?? '').trim().length,
          chapters: document.querySelectorAll('.chapter-row').length,
        }))()
      `)
      check('detail title', !!detail.title, detail.title)
      check('detail author', !!detail.author, detail.author)
      check('detail cover', detail.hasCover === true)
      check('detail intro', detail.introLength > 10, `${detail.introLength}`)
      check('chapters listed', detail.chapters > 5, `${detail.chapters}`)
      console.log(`       ${detail.title} / ${detail.author} / ${detail.chapters} 章`)

      console.log('read a chapter')
      {
        await session.evaluate(`
          (() => {
            const rows = [...document.querySelectorAll('.chapter-row .chapter-open')]
            if (rows[0]) rows[0].click()
          })()
        `)
        const paragraphs = await waitFor(
          session,
          `document.querySelectorAll('.prose .paragraph').length > 0 ? document.querySelectorAll('.prose .paragraph').length : 0`,
          30000,
        )
        check('chapter text rendered', typeof paragraphs === 'number' && paragraphs > 0, `${paragraphs}`)

        // Return a plain object rather than a bare array: object serialisation
        // over CDP is unambiguous, and it lets one call carry both the count and
        // the text.
        const chapterDump = await session.evaluate(`
          (() => {
            const ps = [...document.querySelectorAll('.prose .paragraph')]
            const lines = ps.map((p) => (p.textContent || '').trim())
            return { count: ps.length, text: lines.join(String.fromCharCode(10)) }
          })()
        `)
        const text = typeof chapterDump?.text === 'string' ? chapterDump.text : ''
        check('chapter has real content', text.length > 50, `${text.length} chars (count=${chapterDump?.count})`)
        check('no navigation text leaked', !text.includes('本章未完'), text.slice(-80))
        console.log(`       ${chapterDump?.count} paragraphs, ${text.length} chars`)
        console.log(`       first: ${text.split('\n')[0]?.slice(0, 46)}`)
      }
    }
  }

  // Leave the app with the source installed: it is the requested deliverable.
  console.log('')
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
}

main()
  .catch((error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
  .finally(() => {
    setTimeout(() => process.exit(0), 100)
  })
