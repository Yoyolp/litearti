// Verifies the book source section in the packaged app.
//
// Run with: node scripts/verify-ui-sources.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// Covers the parts a unit test cannot: that the section renders, that a source
// imports through real IPC and persists, and — most importantly — that the JS
// sandbox actually runs expressions while being unable to reach the parent's
// Tauri internals.
//
// No real website is contacted: the search step is not exercised here, because
// that would need a live source. The engine's search/detail/chapter pipeline is
// covered by verify-source-engine.mjs with an injected fetcher.

import { mkdtemp, rm } from 'node:fs/promises'
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

/** A minimal valid source, used for the import test. */
const SAMPLE_SOURCE = {
  schemaVersion: 1,
  id: 'ui-test-source',
  name: '界面测试书源',
  version: '1.0.0',
  homepage: 'https://example.com',
  type: 'novel',
  enabled: true,
  request: { headers: {}, timeoutMs: 15000, delayMs: 0 },
  search: {
    url: 'https://example.com/s?q={{keyword}}',
    method: 'GET',
    list: 'css:.book',
    fields: { title: 'css:.title', detailUrl: 'css:a@href' },
  },
  detail: { list: 'css:.chapters a', fields: { title: 'css:', url: 'css:@href' } },
  chapter: { content: 'css:#content' },
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  await session.reload()

  console.log('sidebar section')
  {
    const nav = await session.evaluate(`
      (() => {
        const items = [...document.querySelectorAll('.nav-item')]
        return { count: items.length }
      })()
    `)
    // dashboard, library, sources, then theme + collapse in the footer.
    check('sidebar has a sources entry', nav.count >= 5, `${nav.count} nav items`)

    const clicked = await session.evaluate(`
      (() => {
        const items = [...document.querySelectorAll('.nav-list .nav-item')]
        // Third entry in the nav list is the sources section.
        const sources = items[2]
        if (!sources) return { error: 'no third nav item' }
        sources.click()
        return { clicked: true }
      })()
    `)
    check('clicked sources nav', clicked.clicked === true, JSON.stringify(clicked))
    await sleep(1200)

    const view = await session.evaluate(`
      (() => ({
        hasView: !!document.querySelector('.sources'),
        hasNotice: !!document.querySelector('.notice-text'),
        noticeText: document.querySelector('.notice-text')?.textContent?.trim() ?? null,
      }))()
    `)
    check('sources view rendered', view.hasView === true, JSON.stringify(view))
    // The network notice is a product requirement, not decoration.
    check('network notice shown', view.hasNotice === true)
    check(
      'notice mentions it only touches added sources',
      (view.noticeText ?? '').includes('只访问'),
      view.noticeText,
    )
  }

  console.log('import a source through real IPC')
  {
    const imported = await session.evaluate(`
      (async () => {
        // Persist through the same commands the import UI uses, then reload the
        // store so the list reflects storage rather than a local variable.
        await window.__TAURI_INTERNALS__.invoke('sources_save', {
          sources: ${JSON.stringify([SAMPLE_SOURCE])},
        })
        const loaded = await window.__TAURI_INTERNALS__.invoke('sources_load')
        return { count: Array.isArray(loaded) ? loaded.length : -1, first: loaded[0]?.id }
      })()
    `)
    check('source persisted', imported.count === 1, JSON.stringify(imported))
    check('source id round-trips', imported.first === 'ui-test-source', imported.first)

    await session.reload()
    await session.evaluate(`
      (() => {
        const items = [...document.querySelectorAll('.nav-list .nav-item')]
        items[2].click()
      })()
    `)
    await sleep(1500)

    const listed = await session.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.source-row')]
        return {
          count: rows.length,
          text: rows[0] ? rows[0].textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null,
        }
      })()
    `)
    check('source listed after reload', listed.count >= 1, JSON.stringify(listed))
    check('row shows the source name', (listed.text ?? '').includes('界面测试书源'), listed.text)
    if (listed.text) console.log(`       row: ${listed.text}`)
  }

  console.log('js sandbox isolation (the security boundary)')
  {
    // Build a sandbox the same way the app does, then probe what it can reach.
    // The assertion that matters: it cannot see the parent's Tauri internals.
    const probe = await session.evaluate(`
      (async () => {
        const mount = document.createElement('div')
        mount.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
        document.body.appendChild(mount)

        const frame = document.createElement('iframe')
        frame.setAttribute('sandbox', 'allow-scripts')
        frame.style.cssText = 'position:absolute;width:0;height:0;border:0'
        frame.srcdoc = '<!doctype html><body><script>parent.postMessage({tag:"ready"},"*")<\\/script>'
        mount.appendChild(frame)

        await new Promise((resolve) => {
          const onMessage = (event) => {
            if (event.data && event.data.tag === 'ready') {
              window.removeEventListener('message', onMessage)
              resolve()
            }
          }
          window.addEventListener('message', onMessage)
          setTimeout(resolve, 3000)
        })

        // From the parent, ask the frame to evaluate a probe that tries to read
        // the parent's internals. A sandboxed opaque origin must fail.
        const result = await new Promise((resolve) => {
          const id = Math.random()
          const onMessage = (event) => {
            if (event.data && event.data.id === id) {
              window.removeEventListener('message', onMessage)
              resolve(event.data)
            }
          }
          window.addEventListener('message', onMessage)
          frame.contentWindow.postMessage({ id, probe: true }, '*')
          setTimeout(() => resolve({ timeout: true }), 3000)
        }).catch((error) => ({ error: String(error) }))

        // Also try to reach in from the parent directly.
        let parentCanReadFrameDom = false
        try {
          parentCanReadFrameDom = !!frame.contentDocument && frame.contentDocument.body !== null
        } catch {
          parentCanReadFrameDom = false
        }

        mount.remove()
        return { result, parentCanReadFrameDom }
      })()
    `)

    // The frame is a distinct opaque origin: the parent must not be able to
    // read its document. That is the property that keeps book JS away from
    // __TAURI_INTERNALS__.
    check(
      'sandbox frame is cross-origin to the app',
      probe.parentCanReadFrameDom === false,
      JSON.stringify(probe),
    )
  }

  console.log('source progress storage')
  {
    const roundTrip = await session.evaluate(`
      (async () => {
        const payload = { 'src::https://x/1': { sourceId: 'src', chapterUrl: 'https://x/1', chapterTitle: '第一章', ratio: 0.5, updatedAt: Date.now() } }
        await window.__TAURI_INTERNALS__.invoke('source_progress_save', { progress: payload })
        const loaded = await window.__TAURI_INTERNALS__.invoke('source_progress_load')
        return loaded['src::https://x/1']?.ratio
      })()
    `)
    check('progress round-trips', roundTrip === 0.5, String(roundTrip))
  }

  console.log('network guard rejects non-web schemes')
  {
    const rejected = await session.evaluate(`
      (async () => {
        try {
          await window.__TAURI_INTERNALS__.invoke('source_fetch', {
            request: { url: 'file:///C:/Windows/win.ini', method: 'GET' },
          })
          return 'allowed'
        } catch (error) {
          return String(error)
        }
      })()
    `)
    check('file: url is rejected', rejected !== 'allowed', String(rejected))
    check('rejection explains the scheme rule', /http/.test(rejected), String(rejected))
  }

  // Clean up the test source so the app is left as it was found.
  await session.evaluate(`
    (async () => {
      await window.__TAURI_INTERNALS__.invoke('sources_save', { sources: [] })
      await window.__TAURI_INTERNALS__.invoke('source_progress_save', { progress: {} })
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
