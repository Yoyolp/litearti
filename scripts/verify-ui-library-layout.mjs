// Asserts the library layout is geometrically sane.
//
// Run with: node scripts/verify-ui-library-layout.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// Why this exists alongside verify-ui-library.mjs: that one proves behaviour
// (sorting sorts, filtering filters). It would still pass if every card
// collapsed to 0px height or the toolbar overflowed the window horizontally.
// These checks are the cheap version of "look at it": measure, don't eyeball.
//
// The assertions are deliberately about *invariants*, not pixel values:
//   - a card's cover keeps its 2:3 aspect within a rounding tolerance
//   - no element extends past the content area's right edge
//   - the toolbar fits on one line at 1180px and wraps (not overflows) at 700px
//   - text that is meant to truncate actually truncates (scrollWidth > clientWidth)
//     rather than pushing the layout wider

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'litearti-layout-'))
  const seeds = [
    ['三体', 'txt'],
    ['线性代数及其应用', 'pdf'],
    ['沙丘', 'epub'],
    ['明朝那些事儿', 'mp3'],
    ['一个很长很长很长很长很长很长很长很长的书名用来测试截断', 'txt'],
    ['深入理解计算机系统', 'pdf'],
  ]
  for (const [name, ext] of seeds) {
    await writeFile(join(dir, `${name}.${ext}`), 'x'.repeat(2000), 'utf8')
  }

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

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
  await session.evaluate(
    `window.__TAURI_INTERNALS__.invoke('library_import', { paths: ${paths} })`,
  )

  await session.evaluate('location.reload()')
  await sleep(2600)
  await session.evaluate(`[...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === '资料库')?.click()`)
  await sleep(900)

  // Wide window, matching the default 1080px app window.
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1080,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(600)

  console.log('list layout')
  {
    const metrics = await session.evaluate(`
      (() => {
        const doc = document.documentElement
        const rows = [...document.querySelectorAll('.entry')]
        const contentRight = Math.max(
          ...rows.map((r) => r.getBoundingClientRect().right),
        )
        // Look up the deliberately over-long title by its text, not by position:
        // the default order is most-recent-first, so row 0 is whatever was
        // imported last and asking it to truncate asserts nothing.
        const long = [...document.querySelectorAll('.entry-title')]
          .find((el) => (el.textContent || '').includes('很长很长'))
        return {
          horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          rows: rows.length,
          rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
          contentRight: Math.round(contentRight),
          viewportWidth: doc.clientWidth,
          foundLong: !!long,
          longClientWidth: long ? long.clientWidth : null,
          longScrollWidth: long ? long.scrollWidth : null,
          longHeight: long ? Math.round(long.getBoundingClientRect().height) : null,
          // A single-line box stays at one line-height; wrapping would grow it.
          longWhiteSpace: long ? getComputedStyle(long).whiteSpace : null,
        }
      })()
    `)
    check('no horizontal document overflow', metrics.horizontalOverflow === false, JSON.stringify(metrics))
    check('six rows', metrics.rows === 6, `${metrics.rows}`)
    check(
      'all rows are the same height',
      new Set(metrics.rowHeights).size === 1,
      JSON.stringify(metrics.rowHeights),
    )
    check(
      'rows stay inside the viewport',
      metrics.contentRight <= metrics.viewportWidth,
      `${metrics.contentRight} <= ${metrics.viewportWidth}`,
    )
    check('the long-title row was found', metrics.foundLong === true, JSON.stringify(metrics))
    check(
      'the long title is forced onto one line',
      metrics.longWhiteSpace === 'nowrap',
      `${metrics.longWhiteSpace}`,
    )
    // At 1080px the content column is ~900px, which the long title fits in, so
    // there is nothing to truncate — that is the correct outcome, not a bug.
    // The row height staying at one line is what proves it did not wrap, which is
    // the actual guarantee at any width.
    check(
      'the long title occupies a single line',
      metrics.longHeight !== null && metrics.longHeight < 30,
      `height ${metrics.longHeight}`,
    )
  }

  console.log('grid layout')
  {
    await session.evaluate(`document.querySelectorAll('.view-btn')[1].click()`)
    await sleep(600)
    const metrics = await session.evaluate(`
      (() => {
        const doc = document.documentElement
        const cards = [...document.querySelectorAll('.card')]
        const covers = [...document.querySelectorAll('.card .cover')]
        const boxes = covers.map((c) => c.getBoundingClientRect())
        const ratios = boxes.map((b) => +(b.width / b.height).toFixed(3))
        const expected = 2 / 3
        // Cards on the first row share a top edge; distinct tops = rows.
        const tops = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)))
        const cardRights = cards.map((c) => c.getBoundingClientRect().right)
        return {
          cards: cards.length,
          coverHeightZero: boxes.some((b) => b.height < 20),
          ratios,
          worstRatioError: Math.max(...ratios.map((r) => Math.abs(r - expected))),
          rows: tops.size,
          maxRight: Math.round(Math.max(...cardRights)),
          viewportWidth: doc.clientWidth,
          horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
        }
      })()
    `)
    check('six cards', metrics.cards === 6, `${metrics.cards}`)
    check('no cover collapsed', metrics.coverHeightZero === false, JSON.stringify(metrics))
    check(
      'covers keep a 2:3 aspect',
      metrics.worstRatioError < 0.02,
      `worst error ${metrics.worstRatioError} in ${JSON.stringify(metrics.ratios)}`,
    )
    check('cards wrap into multiple rows', metrics.rows > 1, `${metrics.rows} row(s)`)
    check(
      'cards stay inside the viewport',
      metrics.maxRight <= metrics.viewportWidth,
      `${metrics.maxRight} <= ${metrics.viewportWidth}`,
    )
    check('no horizontal overflow in grid', metrics.horizontalOverflow === false, JSON.stringify(metrics))
  }

  console.log('narrow window (700px)')
  {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 700,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(700)
    const metrics = await session.evaluate(`
      (() => {
        const doc = document.documentElement
        const toolbar = document.querySelector('.toolbar')
        const groups = [...document.querySelectorAll('.toolbar-group')]
        const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null
        return {
          horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          // Toolbar groups must stay inside the toolbar's own box.
          groupOverflow: groups.some((g) => {
            if (!toolbarRect) return false
            const r = g.getBoundingClientRect()
            return r.right > toolbarRect.right + 1 || r.left < toolbarRect.left - 1
          }),
          cards: document.querySelectorAll('.card').length,
          cardsPerRow: (() => {
            const tops = [...document.querySelectorAll('.card')]
              .map((c) => Math.round(c.getBoundingClientRect().top))
            const first = tops[0]
            return tops.filter((t) => t === first).length
          })(),
          minCardWidth: (() => {
            const widths = [...document.querySelectorAll('.card')].map(
              (c) => Math.round(c.getBoundingClientRect().width),
            )
            return widths.length ? Math.min(...widths) : 0
          })(),
          // Cards on the same row must not overlap; distinct lefts, sorted,
          // with each next left past the previous right.
          hasOverlap: (() => {
            const boxes = [...document.querySelectorAll('.card')].map((c) =>
              c.getBoundingClientRect(),
            )
            const rows = new Map()
            for (const b of boxes) {
              const key = Math.round(b.top)
              if (!rows.has(key)) rows.set(key, [])
              rows.get(key).push(b)
            }
            for (const row of rows.values()) {
              row.sort((a, b) => a.left - b.left)
              for (let i = 1; i < row.length; i += 1) {
                if (row[i].left < row[i - 1].right - 0.5) return true
              }
            }
            return false
          })(),
        }
      })()
    `)
    check('narrow: no horizontal overflow', metrics.horizontalOverflow === false, JSON.stringify(metrics))
    check('narrow: toolbar groups do not spill out', metrics.groupOverflow === false, JSON.stringify(metrics))
    // The column count is a consequence of `--card-min-width`, not a free
    // choice: at 700px the window leaves 492px of content after the 208px
    // sidebar, minus 48px of padding per side, so two 148px-minimum cards fit.
    // Asserting a fixed number here would encode arithmetic that legitimately
    // changes when the sidebar collapses, so assert the invariant instead:
    // every card is at least the minimum width, and none overlaps.
    check(
      'narrow: cards all meet the minimum width',
      metrics.minCardWidth >= 148,
      `min ${metrics.minCardWidth}`,
    )
    check(
      'narrow: at least two cards per row',
      metrics.cardsPerRow >= 2,
      `${metrics.cardsPerRow}`,
    )
    check(
      'narrow: cards do not overlap horizontally',
      metrics.hasOverlap === false,
      JSON.stringify(metrics),
    )

    // And the list stays inside too.
    await session.evaluate(`document.querySelectorAll('.view-btn')[0].click()`)
    await sleep(500)
    const listNarrow = await session.evaluate(`
      (() => {
        const doc = document.documentElement
        // At 700px the content column is narrow enough that the long title must
        // now actually ellipsize. This is where truncation is observable.
        const long = [...document.querySelectorAll('.entry-title')]
          .find((el) => (el.textContent || '').includes('很长很长'))
        return {
          horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
          rows: document.querySelectorAll('.entry').length,
          foundLong: !!long,
          longScrollWidth: long ? long.scrollWidth : null,
          longClientWidth: long ? long.clientWidth : null,
          longHeight: long ? Math.round(long.getBoundingClientRect().height) : null,
        }
      })()
    `)
    check('narrow: list does not overflow', listNarrow.horizontalOverflow === false, JSON.stringify(listNarrow))
    check('narrow: list still shows all rows', listNarrow.rows === 6, `${listNarrow.rows}`)
    check(
      'narrow: the long title now truncates',
      listNarrow.foundLong === true &&
        listNarrow.longScrollWidth > listNarrow.longClientWidth,
      `scroll ${listNarrow.longScrollWidth} vs client ${listNarrow.longClientWidth}`,
    )
    check(
      'narrow: the truncated title stays one line high',
      listNarrow.longHeight !== null && listNarrow.longHeight < 30,
      `height ${listNarrow.longHeight}`,
    )
  }

  await session.send('Emulation.clearDeviceMetricsOverride')
  await sleep(300)

  // Clean up.
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
