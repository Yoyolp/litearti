// Asserts the source section's layout is geometrically sane.
//
// Run with: node scripts/verify-ui-sources-layout.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// Same idea as verify-ui-library-layout.mjs: measure, don't eyeball. The failures
// this catches are the ones that pass a behaviour test — a form row that overflows
// the window, an editor section that collapses to nothing, a group header that
// overlaps its rows.

import { createServer } from 'node:http'
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
  const page = `<!doctype html><ul>
    <li><a class="t" href="/book/1">书一</a></li>
    <li><a class="t" href="/book/2">书二</a></li>
  </ul>`
  let fixturePort = 0
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fixturePort = server.address().port
      resolve()
    })
  })
  const base = `http://127.0.0.1:${fixturePort}`

  const seed = [
    {
      schemaVersion: 1,
      id: 'layout-a',
      name: '一个名字相当长的源用来测试截断行为',
      version: '1.0.0',
      homepage: `${base}/`,
      type: 'novel',
      enabled: true,
      request: { headers: {}, timeoutMs: 5000, delayMs: 0 },
      search: {
        url: `${base}/s?q={{keyword}}`,
        method: 'GET',
        list: 'css:li',
        fields: { title: 'css:.t', detailUrl: 'css:a@href' },
      },
      detail: { list: 'css:a', fields: { title: 'css:', url: 'css:@href' } },
      chapter: { content: 'css:#c' },
    },
    {
      schemaVersion: 1,
      id: 'layout-b',
      name: '视频源',
      version: '1.0.0',
      homepage: `${base}/`,
      type: 'video',
      enabled: true,
      request: { headers: {}, timeoutMs: 5000, delayMs: 0 },
      search: {
        url: `${base}/s?q={{keyword}}`,
        method: 'GET',
        list: 'css:li',
        fields: { title: 'css:.t', detailUrl: 'css:a@href' },
      },
      detail: { list: 'css:a', fields: { title: 'css:', url: 'css:@href' } },
      chapter: { content: 'css:#c' },
      // Required for `type: video`. Without it the source is rejected at save and
      // this fixture silently shrinks to one row — which is how the count
      // assertions started failing with no stated reason.
      video: {
        episodes: 'css:a',
        episodeUrl: 'css:@href',
        playback: { kind: 'regex', pattern: "url: '([^']+)'" },
      },
    },
  ]

  const dir = await mkdtemp(join(tmpdir(), 'litearti-p3-layout-'))
  const seedFile = join(dir, 'seed.json')
  await writeFile(seedFile, JSON.stringify(seed), 'utf8')

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const target = targets.find((t) => t.type === 'page')
  const session = await Session.connect(target.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  await session.evaluate(`
    window.__TAURI_INTERNALS__.invoke('sources_save', { sources: ${JSON.stringify(seed)} })
  `)
  await session.evaluate('location.reload()')
  await sleep(2600)
  await session.evaluate(`[...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === '源')?.click()`)
  await sleep(1000)

  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1080,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(600)

  console.log('source list layout')
  {
    const metrics = await session.evaluate(`
      (() => {
        const doc = document.documentElement
        const rows = [...document.querySelectorAll('.source-row')]
        const name = document.querySelector('.source-name-text')
        const groups = [...document.querySelectorAll('.group-head')]
        return {
          overflow: doc.scrollWidth > doc.clientWidth + 1,
          rows: rows.length,
          rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
          maxRight: Math.round(Math.max(...rows.map((r) => r.getBoundingClientRect().right))),
          viewport: doc.clientWidth,
          // Group headers must sit above their rows, not on top of them.
          groupOverlapsRow: (() => {
            for (const g of groups) {
              const gb = g.getBoundingClientRect()
              for (const r of rows) {
                const rb = r.getBoundingClientRect()
                if (rb.top < gb.bottom - 0.5 && rb.top > gb.top) return true
              }
            }
            return false
          })(),
          // These are booleans computed in the page, not style strings.
          nameTruncates: name ? getComputedStyle(name).textOverflow === 'ellipsis' : null,
          nameClipped: name ? name.scrollWidth > name.clientWidth : null,
        }
      })()
    `)
    check('no horizontal overflow', metrics.overflow === false, JSON.stringify(metrics))
    check('both sources listed', metrics.rows === 2, `${metrics.rows}`)
    check(
      'rows are a consistent height',
      new Set(metrics.rowHeights).size === 1,
      JSON.stringify(metrics.rowHeights),
    )
    check('rows stay inside the viewport', metrics.maxRight <= metrics.viewport, `${metrics.maxRight} <= ${metrics.viewport}`)
    check('group headers do not overlap rows', metrics.groupOverlapsRow === false)
    check('long names are set up to truncate', metrics.nameTruncates === true, `${metrics.nameTruncates}`)
    // At 1080px this particular name fits, so clipping is not expected here; the
    // guarantee that matters is that it *can* clip, checked at 700px below.
  }

  console.log('source list at 700px')
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
        const rows = [...document.querySelectorAll('.source-row')]
        const name = document.querySelector('.source-name-text')
        return {
          overflow: doc.scrollWidth > doc.clientWidth + 1,
          rows: rows.length,
          maxRight: Math.round(Math.max(...rows.map((r) => r.getBoundingClientRect().right))),
          viewport: doc.clientWidth,
          nameClipped: name ? name.scrollWidth > name.clientWidth : null,
          nameHeight: name ? Math.round(name.getBoundingClientRect().height) : null,
        }
      })()
    `)
    check('narrow: no horizontal overflow', metrics.overflow === false, JSON.stringify(metrics))
    check('narrow: both rows still listed', metrics.rows === 2, `${metrics.rows}`)
    check('narrow: rows stay inside the viewport', metrics.maxRight <= metrics.viewport, `${metrics.maxRight} <= ${metrics.viewport}`)
    // This is where a long name must actually be clipped rather than widening the
    // row — the failure mode the flex container originally had.
    check(
      'narrow: the long name is clipped, not wrapped or widened',
      metrics.nameClipped === true,
      JSON.stringify(metrics),
    )
    check('narrow: the name stays one line high', metrics.nameHeight !== null && metrics.nameHeight < 30, `${metrics.nameHeight}`)

    await session.send('Emulation.clearDeviceMetricsOverride')
    await sleep(300)
  }

  console.log('editor layout')
  {
    await session.evaluate(`
      (() => {
        const row = document.querySelector('.source-row')
        const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '编辑')
        if (btn) btn.click()
      })()
    `)
    await sleep(900)

    const metrics = await session.evaluate(`
      (() => {
        const doc = document.documentElement
        const sections = [...document.querySelectorAll('.section')]
        const inputs = [...document.querySelectorAll('.section .input')]
        const rows = [...document.querySelectorAll('.field-row')]
        return {
          overflow: doc.scrollWidth > doc.clientWidth + 1,
          sections: sections.length,
          sectionHeights: sections.map((s) => Math.round(s.getBoundingClientRect().height)),
          anyCollapsed: sections.some((s) => s.getBoundingClientRect().height < 20),
          inputs: inputs.length,
          // Inputs must not spill past the content column.
          inputOverflow: inputs.some((i) => i.getBoundingClientRect().right > doc.clientWidth + 1),
          fieldRows: rows.length,
          headerSticky: getComputedStyle(document.querySelector('.editor-header')).position === 'sticky',
        }
      })()
    `)
    check('no horizontal overflow in the editor', metrics.overflow === false, JSON.stringify(metrics))
    check('all form sections render', metrics.sections >= 5, `${metrics.sections}`)
    check('no section collapsed to nothing', metrics.anyCollapsed === false, JSON.stringify(metrics.sectionHeights))
    check('inputs stay inside the content column', metrics.inputOverflow === false)
    check('the header is sticky so the save button stays reachable', metrics.headerSticky === true)

    // Narrow window: the two-column field rows must not overflow.
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 700,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(700)
    const narrow = await session.evaluate(`
      (() => {
        const doc = document.documentElement
        const inputs = [...document.querySelectorAll('.section .input')]
        return {
          overflow: doc.scrollWidth > doc.clientWidth + 1,
          inputOverflow: inputs.some((i) => i.getBoundingClientRect().right > doc.clientWidth + 1),
          inputs: inputs.length,
        }
      })()
    `)
    check('narrow: no horizontal overflow', narrow.overflow === false, JSON.stringify(narrow))
    check('narrow: inputs still fit', narrow.inputOverflow === false, JSON.stringify(narrow))

    await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    await sleep(600)
  }

  await session.send('Emulation.clearDeviceMetricsOverride')
  await sleep(300)

  await session.evaluate(`
    window.__TAURI_INTERNALS__.invoke('sources_save', { sources: [] })
  `)
  await rm(dir, { recursive: true, force: true })
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
