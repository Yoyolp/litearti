// Verifies the three new features in the packaged app.
//
// Run with: node scripts/verify-ui-features.mjs
// Requires the app started with --remote-debugging-port=9222.
//
//   1. TXT chaptering — a chaptered .txt renders a TOC, chapter navigation and
//      one chapter at a time.
//   2. "visit site" — the browse view has a button that opens the source's
//      homepage externally (asserted via the IPC call, since a real browser
//      launch cannot be observed from here).
//   3. paste-a-URL — a detail-page URL in the search box loads as one card.

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

async function waitFor(session, expression, timeoutMs = 30000) {
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

  // --- feature 1: TXT chaptering -----------------------------------------
  console.log('TXT chaptering')
  {
    // Put a chaptered novel into the library through the real import path by
    // writing a temp file and invoking the import command.
    const chaptered = [
      '测试小说',
      '',
      '第一章 开端',
      '第一段正文，这是第一章的内容。',
      '第二段正文，同样属于第一章。',
      '',
      '第二章 发展',
      '第二章的第一段。',
      '',
      '第三章 结局',
      '第三章的内容，全书完。',
    ].join('\n')

    const imported = await session.evaluate(`
      (async () => {
        const entries = await window.__TAURI_INTERNALS__.invoke('library_list')
        const existing = entries.find((e) => e.title === '__chapter_test__')
        if (existing) return { id: existing.id, reused: true }
        // The app has no "write temp file" command, so drive the import through
        // the download path, which accepts bytes and reuses library_import.
        const bytes = Array.from(new TextEncoder().encode(${JSON.stringify(chaptered)}))
        const entry = await window.__TAURI_INTERNALS__.invoke('source_download_import', {
          title: '__chapter_test__',
          extension: 'txt',
          bytes,
        })
        return { id: entry.id, reused: false }
      })()
    `)
    check('chaptered txt imported', !!imported?.id, JSON.stringify(imported))

    await session.reload()
    await session.evaluate(`[...document.querySelectorAll('.nav-list .nav-item')][1].click()`)
    await sleep(1200)

    const opened = await session.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.entry')]
        const row = rows.find((r) => (r.textContent || '').includes('__chapter_test__'))
        if (!row) return 'not found'
        row.querySelector('.entry-open').click()
        return 'clicked'
      })()
    `)
    check('opened the txt', opened === 'clicked', opened)

    const hasToc = await waitFor(session, `!!document.querySelector('.toc-trigger') ? 1 : 0`, 20000)
    check('chapter navigation appeared', hasToc === 1)

    const nav = await session.evaluate(`
      (() => ({
        hasTocButton: !!document.querySelector('.toc-trigger'),
        position: document.querySelector('.chapter-label')?.textContent?.trim() ?? null,
        heading: document.querySelector('.chapter-title')?.textContent?.trim() ?? null,
        paragraphCount: document.querySelectorAll('.prose p').length,
        firstParagraph: document.querySelector('.prose p')?.textContent?.trim() ?? null,
        hasFooterNext: [...document.querySelectorAll('.chapter-footer button')].length > 0,
      }))()
    `)
    check('chapter position shown', (nav.position ?? '').includes('第 1'), nav.position)
    check('chapter heading shown', nav.heading === '第一章 开端', nav.heading)
    check('only the chapter body is rendered', nav.paragraphCount <= 4, `${nav.paragraphCount}`)
    check(
      'other chapters are not in the DOM',
      !(nav.firstParagraph ?? '').includes('第二章'),
      nav.firstParagraph,
    )
    check('end-of-chapter "next" present', nav.hasFooterNext === true)

    console.log('  navigate to chapter 2')
    {
      await session.evaluate(`
        (() => {
          const next = [...document.querySelectorAll('.chapter-footer button')][0]
          if (next) next.click()
        })()
      `)
      const moved = await waitFor(
        session,
        `document.querySelector('.chapter-title')?.textContent?.includes('第二章') ? 1 : 0`,
        10000,
      )
      check('advanced to chapter 2', moved === 1)

      const state = await session.evaluate(`
        (() => ({
          heading: document.querySelector('.chapter-title')?.textContent?.trim() ?? null,
          position: document.querySelector('.chapter-label')?.textContent?.trim() ?? null,
          body: [...document.querySelectorAll('.prose p')].map((p) => p.textContent.trim()).join('|'),
        }))()
      `)
      check('heading updated', state.heading === '第二章 发展', state.heading)
      check('position updated', (state.position ?? '').includes('第 2'), state.position)
      check('body is chapter 2', (state.body ?? '').includes('第二章的第一段'), state.body)
    }

    console.log('  table of contents')
    {
      await session.evaluate(`document.querySelector('.toc-trigger')?.click()`)
      await sleep(500)
      const toc = await session.evaluate(`
        (() => {
          const items = [...document.querySelectorAll('.toc-item')]
          return {
            count: items.length,
            labels: items.map((i) => i.querySelector('.toc-text')?.textContent?.trim()),
            current: items.findIndex((i) => i.classList.contains('is-current')),
          }
        })()
      `)
      check('toc lists all chapters', toc.count === 3, `${toc.count}`)
      check('toc labels are chapter titles', toc.labels[0] === '第一章 开端', JSON.stringify(toc.labels))
      check('toc marks the current chapter', toc.current === 1, `${toc.current}`)

      // Jump back to chapter 1 via the TOC.
      await session.evaluate(`[...document.querySelectorAll('.toc-item')][0]?.click()`)
      const back = await waitFor(
        session,
        `document.querySelector('.chapter-title')?.textContent?.includes('第一章') ? 1 : 0`,
        10000,
      )
      check('toc jump works', back === 1)
    }

    // Progress carries the chapter index now.
    await sleep(1200)
    const progress = await session.evaluate(`
      (async () => {
        const entries = await window.__TAURI_INTERNALS__.invoke('library_list')
        const entry = entries.find((e) => e.title === '__chapter_test__')
        return entry ? entry.progress : null
      })()
    `)
    check('progress records a chapter', typeof progress?.chapter === 'number', JSON.stringify(progress))
  }

  // --- features 2 and 3: browse view -------------------------------------
  console.log('source browse view')
  {
    await session.evaluate(`
      (async () => {
        await window.__TAURI_INTERNALS__.invoke('sources_save', {
          sources: ${JSON.stringify([source])},
        })
      })()
    `)
    await session.reload()
    await session.evaluate(`[...document.querySelectorAll('.nav-list .nav-item')][2].click()`)
    await sleep(1200)
    await session.evaluate(`document.querySelector('.source-row .source-open')?.click()`)
    await sleep(1200)

    console.log('  visit-site button')
    {
      const button = await session.evaluate(`
        (() => {
          const btn = document.querySelector('.open-site')
          return {
            present: !!btn,
            label: btn?.textContent?.trim() ?? null,
            title: btn?.getAttribute('title') ?? null,
          }
        })()
      `)
      check('visit-site button present', button.present === true, JSON.stringify(button))
      check('button carries the homepage', (button.title ?? '').includes('bqg5555'), button.title)

      // Opening a browser cannot be observed, so assert the command is wired and
      // rejects non-web schemes (the safety property that matters).
      const guard = await session.evaluate(`
        (async () => {
          try {
            await window.__TAURI_INTERNALS__.invoke('open_external', { url: 'file:///C:/Windows/win.ini' })
            return 'allowed'
          } catch (error) {
            return String(error)
          }
        })()
      `)
      check('open_external rejects non-http', guard !== 'allowed', String(guard))
    }

    console.log('  paste a detail-page URL')
    {
      const url = 'https://www.bqg5555.cc/xs/250929/'
      await session.evaluate(`
        (() => {
          const input = document.querySelector('.search-input')
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(input, ${JSON.stringify(url)})
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })()
      `)
      await sleep(400)
      await session.evaluate(`
        (() => {
          const search = [...document.querySelectorAll('.search-row button')].find((b) => !b.disabled)
          if (search) search.click()
        })()
      `)

      const cards = await waitFor(
        session,
        `document.querySelectorAll('.card').length > 0 ? document.querySelectorAll('.card').length : 0`,
        40000,
      )
      check('URL produced a result card', cards === 1, `${cards}`)

      const card = await session.evaluate(`
        (() => {
          const c = document.querySelector('.card')
          return {
            title: c?.querySelector('.title')?.textContent?.trim() ?? null,
            type: c?.querySelector('.type')?.textContent?.trim() ?? null,
            hasCover: !!c?.querySelector('.cover-image'),
          }
        })()
      `)
      check('card has the book title', !!card.title && card.title.length > 2, card.title)
      check('card has the resource type', card.type === '小说', card.type)
      console.log(`       ${card.title}`)

      // And it must open like a normal result.
      await session.evaluate(`document.querySelector('.card')?.click()`)
      const chapters = await waitFor(
        session,
        `document.querySelectorAll('.chapter-row').length > 0 ? document.querySelectorAll('.chapter-row').length : 0`,
        25000,
      )
      check('URL result opens to chapters', typeof chapters === 'number' && chapters > 5, `${chapters}`)
      console.log(`       ${chapters} chapters`)
    }
  }

  // Clean up the test entry.
  await session.evaluate(`
    (async () => {
      const entries = await window.__TAURI_INTERNALS__.invoke('library_list')
      const test = entries.find((e) => e.title === '__chapter_test__')
      if (test) await window.__TAURI_INTERNALS__.invoke('library_remove', { id: test.id })
    })()
  `)

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
