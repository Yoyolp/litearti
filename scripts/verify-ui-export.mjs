// Verifies the export UI in the packaged app: the `...` menu, selection mode,
// and an actual write to disk.
//
// Run with: node scripts/verify-ui-export.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// The native folder picker cannot be driven over CDP, so the directory is
// injected by stubbing the store action that opens it. Everything downstream —
// conversion, IPC, the Rust write, the file on disk — is real.

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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

async function main() {
  const outDir = await mkdtemp(join(tmpdir(), 'litearti-export-ui-'))

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  await session.reload()
  await session.evaluate(`[...document.querySelectorAll('.nav-item')][1].click()`)
  await sleep(1000)

  console.log('menu')
  {
    const menu = await session.evaluate(`
      (() => {
        const trigger = document.querySelector('.menu-trigger')
        if (!trigger) return { found: false }
        trigger.click()
        return { found: true }
      })()
    `)
    check('menu trigger present', menu.found === true, JSON.stringify(menu))
    await sleep(400)

    const items = await session.evaluate(`
      (() => {
        const labels = [...document.querySelectorAll('.menu-item')].map((b) => (b.textContent || '').trim())
        return { labels }
      })()
    `)
    check('export entry in menu', (items.labels ?? []).some((l) => l.includes('导出')), JSON.stringify(items))

    // Open the second level.
    await session.evaluate(`
      (() => {
        const first = document.querySelector('.menu-item')
        if (first) first.click()
      })()
    `)
    await sleep(400)

    const targets = await session.evaluate(`
      (() => {
        const items = [...document.querySelectorAll('.submenu .menu-item')]
        return items.map((b) => ({
          label: (b.textContent || '').trim(),
          disabled: b.disabled,
        }))
      })()
    `)
    check('two targets listed', (targets ?? []).length >= 2, JSON.stringify(targets))
    check(
      'original + text present',
      (targets ?? []).some((t) => t.label.includes('原始')) &&
        (targets ?? []).some((t) => t.label.includes('纯文本')),
      JSON.stringify(targets),
    )
    console.log(`       targets: ${(targets ?? []).map((t) => t.label).join(' | ')}`)
  }

  console.log('selection mode')
  {
    const entered = await session.evaluate(`
      (() => {
        const items = [...document.querySelectorAll('.submenu .menu-item')]
        const text = items.find((b) => (b.textContent || '').includes('纯文本'))
        if (!text) return { error: 'no text target' }
        text.click()
        return { clicked: true }
      })()
    `)
    check('entered selection mode', entered.clicked === true, JSON.stringify(entered))
    await sleep(600)

    const state = await session.evaluate(`
      (() => ({
        checkboxes: document.querySelectorAll('.entry-check input').length,
        hasToolbar: !!document.querySelector('.selection-actions'),
        removeHidden: document.querySelectorAll('.entry-remove').length === 0,
      }))()
    `)
    check('checkboxes rendered', state.checkboxes > 0, `${state.checkboxes}`)
    check('selection toolbar shown', state.hasToolbar === true)
    check('remove buttons hidden', state.removeHidden === true)

    // Select the text-able entries (txt, pdf, epub) but leave audio alone.
    const selected = await session.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.entry')]
        let picked = 0
        for (const row of rows) {
          const box = row.querySelector('.entry-check input')
          if (!box || box.disabled) continue
          box.click()
          picked += 1
        }
        return { picked }
      })()
    `)
    check('selected convertible entries', selected.picked >= 2, JSON.stringify(selected))
    await sleep(400)

    const count = await session.evaluate(`
      (() => {
        const el = document.querySelector('.selection-count')
        return el ? el.textContent.trim() : null
      })()
    `)
    check('count reflects selection', /已选 \d+/.test(count ?? ''), count)
    console.log(`       ${count}`)
  }

  console.log('run export (stubbed directory)')
  {
    // Point the picker at a temp dir. Everything after this is the real path.
    await session.evaluate(`
      (() => {
        window.__exportDir = ${JSON.stringify(outDir)}
      })()
    `)

    const ran = await session.evaluate(`
      (async () => {
        const mod = await import('/src/stores/export.ts').catch(() => null)
        // The app is built, so source paths are not importable. Fall back to
        // the pinia store instance exposed through the Vue devtools hook.
        return mod ? 'dev' : 'built'
      })()
    `)
    check('detected build mode', ran === 'built', ran)

    // In a production build the store is not reachable by import. Drive the
    // real UI instead, and stub only the folder picker: the dialog plugin goes
    // through `plugin:dialog|open`, and every other IPC call (read_binary,
    // export_write) must keep flowing to the real backend or the export would
    // be testing a mock.
    const stubbed = await session.evaluate(`
      (() => {
        const internals = window.__TAURI_INTERNALS__
        if (!internals || typeof internals.invoke !== 'function') return { error: 'no tauri internals' }
        if (!window.__origInvoke) window.__origInvoke = internals.invoke.bind(internals)
        internals.invoke = async (cmd, args) => {
          if (cmd === 'plugin:dialog|open') return window.__exportDir
          return window.__origInvoke(cmd, args)
        }
        return { ok: true }
      })()
    `)
    check('dialog stubbed', stubbed.ok === true, JSON.stringify(stubbed))

    await session.evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('.selection-actions button')]
        const run = buttons.find((b) => (b.textContent || '').trim() === '导出')
        if (run) run.click()
      })()
    `)

    // Conversion of a PDF/EPUB takes a moment.
    await sleep(8000)

    const feedback = await session.evaluate(`
      (() => {
        const el = document.querySelector('.feedback-text')
        const stillSelecting = !!document.querySelector('.selection-actions')
        return { text: el ? el.textContent.trim() : null, stillSelecting }
      })()
    `)
    check('result strip shown', feedback.text !== null, JSON.stringify(feedback))
    check('selection mode closed', feedback.stillSelecting === false)
    console.log(`       ${feedback.text}`)

    const files = await readdir(outDir)
    check('files written', files.length > 0, `${files.length}`)
    console.log(`       files: ${files.join(', ')}`)

    const txtFiles = files.filter((f) => f.endsWith('.txt'))
    check('text outputs have .txt extension', txtFiles.length > 0, files.join(','))

    // The EPUB should have produced readable prose.
    const epubOut = txtFiles.find((f) => f.includes('安静地读'))
    if (epubOut) {
      const content = await readFile(join(outDir, epubOut), 'utf8')
      check('epub text has chapter heading', content.includes('# '), content.slice(0, 80))
      check('epub text has prose', content.includes('阅读这件事'), content.slice(0, 200))
      console.log(`       ${epubOut}: ${content.length} chars`)
    } else {
      check('epub text output present', false, files.join(','))
    }
  }

  console.log('collision handling')
  {
    // Run the same export again into the same folder: names must not collide.
    await session.evaluate(`
      (() => {
        const trigger = document.querySelector('.menu-trigger')
        if (trigger) trigger.click()
      })()
    `)
    await sleep(400)
    await session.evaluate(`
      (() => {
        const first = document.querySelector('.menu-item')
        if (first) first.click()
      })()
    `)
    await sleep(400)
    await session.evaluate(`
      (() => {
        const items = [...document.querySelectorAll('.submenu .menu-item')]
        const text = items.find((b) => (b.textContent || '').includes('纯文本'))
        if (text) text.click()
      })()
    `)
    await sleep(600)
    await session.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.entry')]
        for (const row of rows) {
          const box = row.querySelector('.entry-check input')
          if (box && !box.disabled) box.click()
        }
      })()
    `)
    await sleep(400)
    await session.evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('.selection-actions button')]
        const run = buttons.find((b) => (b.textContent || '').trim() === '导出')
        if (run) run.click()
      })()
    `)
    await sleep(8000)

    const files = await readdir(outDir)
    const suffixed = files.filter((f) => / \(\d+\)\.txt$/.test(f))
    check('second run did not overwrite', suffixed.length > 0, files.join(', '))
    console.log(`       files now: ${files.join(', ')}`)
  }

  await rm(outDir, { recursive: true, force: true }).catch(() => {})

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
