// Verifies the rebuilt library screen in the running app.
//
// Run with: node scripts/verify-ui-library.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// What this covers, and why each check earns its place:
//
//   1. Toolbar renders — sort chips, format chips, status/group selects, the
//      layout switch and the "select" button. If any is missing the header is
//      silently back to its old state.
//   2. Sort and filter actually change what is listed, counted against what the
//      view says it is showing. A filter that only greys a chip is a lie.
//   3. The view switch swaps the list for the grid and back, and the preference
//      survives a reload.
//   4. Selection mode hides the toolbar and shows the batch actions, including
//      the delete button that only appears for purpose === 'delete'.
//   5. Rename opens with the current display name prefilled, and clearing it is
//      the documented undo.
//
// It seeds entries through the real IPC path (`library_import`) rather than
// fabricating DOM, so duplicate detection, the metadata write and the progress
// payload all go through the code under test.

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
      const detail =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`${detail}\n  while evaluating: ${expression.trim().slice(0, 200)}`)
    }
    return result.result.value
  }

  async reload(waitMs = 2400) {
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

/** Seed a handful of entries through the real import command. */
const SEED = `
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke
  const existing = await invoke('library_list')
  if (existing.length) return { seeded: 0, total: existing.length }
  const titles = [
    ['/tmp/种子-A.txt', 'plain text body'],
    ['/tmp/种子-B.md', '# markdown'],
    ['/tmp/种子-C.pdf', '%PDF-1.4 fake'],
    ['/tmp/种子-D.epub', 'epub'],
  ]
  const paths = window.__SEED_PATHS__ ?? []
  if (!paths.length) return { seeded: 0, total: existing.length }
  const report = await invoke('library_import', { paths })
  return { seeded: report.imported.length, total: report.imported.length }
})()
`

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'litearti-lib-ui-'))
  const seeds = [
    ['种子-A.txt', 'plain text body'],
    ['种子-B.md', '# markdown'],
    ['种子-C.pdf', '%PDF-1.4 fake'],
    ['种子-D.epub', 'epub'],
  ]
  for (const [name, body] of seeds) await writeFile(join(dir, name), body, 'utf8')

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  // Start from a clean slate so the assertions are about this run.
  await session.evaluate(`
    (async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke
      const all = await invoke('library_list')
      if (all.length) await invoke('library_remove_many', { ids: all.map((e) => e.id) })
      localStorage.removeItem('litearti.library.query')
      localStorage.removeItem('litearti.library.view')
      return all.length
    })()
  `)

  const seedPaths = JSON.stringify(seeds.map(([name]) => join(dir, name)))
  const seedResult = await session.evaluate(`
    (async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke
      const report = await invoke('library_import', { paths: ${seedPaths} })
      return { imported: report.imported.length, duplicates: report.duplicates, failed: report.failed.length }
    })()
  `)
  check('seeded four entries through library_import', seedResult.imported === 4, JSON.stringify(seedResult))
  check('no seed failures', seedResult.failed === 0, JSON.stringify(seedResult))

  await session.reload()
  await session.evaluate(`[...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === '资料库')?.click()`)
  await sleep(900)

  console.log('toolbar')
  {
    const state = await session.evaluate(`
      (() => ({
        toolbar: !!document.querySelector('.toolbar'),
        sortChips: [...document.querySelectorAll('.toolbar-group .chip')].length,
        viewSwitch: !!document.querySelector('.view-switch'),
        selectBtn: [...document.querySelectorAll('.toolbar button')].some((b) => (b.textContent || '').trim() === '选择'),
        rows: document.querySelectorAll('.entry').length,
      }))()
    `)
    check('toolbar rendered', state.toolbar === true, JSON.stringify(state))
    // 5 sort chips + 5 format chips.
    check('ten chips (5 sort + 5 format)', state.sortChips === 10, `${state.sortChips}`)
    check('layout switch present', state.viewSwitch === true)
    check('select-mode button present', state.selectBtn === true)
    check('four rows listed', state.rows === 4, `${state.rows}`)
  }

  console.log('sorting')
  {
    // Sort by title ascending, then read the rendered order back.
    await session.evaluate(`
      (() => {
        const chip = [...document.querySelectorAll('.toolbar-group .chip')]
          .find((c) => (c.textContent || '').trim().startsWith('名称'))
        if (chip) chip.click()
      })()
    `)
    await sleep(400)
    const order = await session.evaluate(`
      [...document.querySelectorAll('.entry-title')].map((e) => (e.textContent || '').trim())
    `)
    check('title sort returns four rows', order.length === 4, JSON.stringify(order))
    // Ascending by codepoint: 种子-A..D keep their order, which also proves the
    // click produced asc rather than leaving desc on.
    const sorted = [...order].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    check('rows are in ascending title order', JSON.stringify(order) === JSON.stringify(sorted), JSON.stringify(order))

    // Clicking the same chip again must flip to descending.
    await session.evaluate(`
      (() => {
        const chip = [...document.querySelectorAll('.toolbar-group .chip')]
          .find((c) => (c.textContent || '').trim().startsWith('名称'))
        if (chip) chip.click()
      })()
    `)
    await sleep(400)
    const flipped = await session.evaluate(`
      [...document.querySelectorAll('.entry-title')].map((e) => (e.textContent || '').trim())
    `)
    check(
      're-clicking the sort chip flips direction',
      JSON.stringify(flipped) === JSON.stringify([...order].reverse()),
      JSON.stringify(flipped),
    )
  }

  console.log('filtering')
  {
    // Click the PDF format chip and assert only the PDF row survives.
    await session.evaluate(`
      (() => {
        const chip = [...document.querySelectorAll('.chip')]
          .find((c) => (c.textContent || '').trim().startsWith('PDF'))
        if (chip) chip.click()
      })()
    `)
    await sleep(400)
    const filtered = await session.evaluate(`
      (() => ({
        rows: [...document.querySelectorAll('.entry-title')].map((e) => (e.textContent || '').trim()),
        count: (document.querySelector('.count')?.textContent || '').trim(),
        clearVisible: !!document.querySelector('.clear-filters'),
      }))()
    `)
    check('PDF filter leaves one row', filtered.rows.length === 1, JSON.stringify(filtered.rows))
    check('the surviving row is the PDF', (filtered.rows[0] ?? '').includes('C'), JSON.stringify(filtered.rows))
    check('count shows filtered / total', filtered.count.includes('/'), filtered.count)
    check('a clear-filters button appears', filtered.clearVisible === true)

    // Clear and confirm everything is back.
    await session.evaluate(`document.querySelector('.clear-filters')?.click()`)
    await sleep(400)
    const cleared = await session.evaluate(`document.querySelectorAll('.entry').length`)
    check('clearing restores all rows', cleared === 4, `${cleared}`)
  }

  console.log('layout switch')
  {
    await session.evaluate(`document.querySelectorAll('.view-btn')[1].click()`)
    await sleep(500)
    const grid = await session.evaluate(`
      (() => ({
        cards: document.querySelectorAll('.card').length,
        rows: document.querySelectorAll('.entry').length,
      }))()
    `)
    check('grid shows four cards', grid.cards === 4, JSON.stringify(grid))
    check('list rows are gone', grid.rows === 0, JSON.stringify(grid))

    // The preference must survive a reload; that is the whole point of storing it.
    await session.reload()
    await session.evaluate(`[...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === '资料库')?.click()`)
    await sleep(800)
    const afterReload = await session.evaluate(`document.querySelectorAll('.card').length`)
    check('grid preference survives a reload', afterReload === 4, `${afterReload}`)

    // Back to list for the remaining checks.
    await session.evaluate(`document.querySelectorAll('.view-btn')[0].click()`)
    await sleep(400)
    const backToList = await session.evaluate(`document.querySelectorAll('.entry').length`)
    check('switching back restores the list', backToList === 4, `${backToList}`)
  }

  console.log('selection mode')
  {
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.toolbar button')]
          .find((b) => (b.textContent || '').trim() === '选择')
        if (btn) btn.click()
      })()
    `)
    await sleep(400)
    const mode = await session.evaluate(`
      (() => ({
        toolbarGone: !document.querySelector('.toolbar'),
        checkboxes: document.querySelectorAll('.entry-check input').length,
        deleteBtn: [...document.querySelectorAll('.selection-actions button')]
          .some((b) => (b.textContent || '').trim() === '移除所选'),
        exportBtn: [...document.querySelectorAll('.selection-actions button')]
          .some((b) => (b.textContent || '').trim() === '导出'),
      }))()
    `)
    check('toolbar hides in selection mode', mode.toolbarGone === true, JSON.stringify(mode))
    check('every row gets a checkbox', mode.checkboxes === 4, `${mode.checkboxes}`)
    check('delete action appears for delete purpose', mode.deleteBtn === true)
    check('export action is not shown for delete purpose', mode.exportBtn === false)

    // Select all, confirm the count in the header.
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.selection-actions button')]
          .find((b) => (b.textContent || '').trim() === '全选')
        if (btn) btn.click()
      })()
    `)
    await sleep(300)
    const selected = await session.evaluate(`
      (() => ({
        checked: document.querySelectorAll('.entry-check input:checked').length,
        label: (document.querySelector('.selection-count')?.textContent || '').trim(),
      }))()
    `)
    check('select all checks four', selected.checked === 4, JSON.stringify(selected))
    check('selection count reads 4 / 4', selected.label.includes('4'), selected.label)

    // Esc leaves the mode.
    await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    await sleep(400)
    const exited = await session.evaluate(`
      (() => ({
        toolbar: !!document.querySelector('.toolbar'),
        checkboxes: document.querySelectorAll('.entry-check input').length,
      }))()
    `)
    check('Esc leaves selection mode', exited.toolbar === true && exited.checkboxes === 0, JSON.stringify(exited))
  }

  console.log('rename')
  {
    // Rename the first row and check both the row and the store agree.
    await session.evaluate(`
      (() => {
        const row = document.querySelector('.entry')
        const btn = [...row.querySelectorAll('button')]
          .find((b) => (b.textContent || '').trim() === '重命名')
        if (btn) btn.click()
      })()
    `)
    await sleep(400)
    const dialog = await session.evaluate(`
      (() => {
        const input = document.querySelector('.rename-input')
        return { open: !!input, value: input ? input.value : null }
      })()
    `)
    check('rename dialog opens', dialog.open === true, JSON.stringify(dialog))
    check('rename field is prefilled with the current name', !!dialog.value, JSON.stringify(dialog))

    await session.evaluate(`
      (() => {
        const input = document.querySelector('.rename-input')
        if (!input) return
        input.value = '改过的名字'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(200)
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.confirm-actions button')]
          .find((b) => (b.textContent || '').trim() === '保存')
        if (btn) btn.click()
      })()
    `)
    await sleep(700)

    const renamed = await session.evaluate(`
      (() => {
        const titles = [...document.querySelectorAll('.entry-title')].map((e) => (e.textContent || '').trim())
        return { titles }
      })()
    `)
    check('renamed row shows the new name', renamed.titles.includes('改过的名字'), JSON.stringify(renamed.titles))

    // The backend must hold it as `rename`, with `title` intact.
    const stored = await session.evaluate(`
      (async () => {
        const all = await window.__TAURI_INTERNALS__.invoke('library_list')
        const hit = all.find((e) => e.rename === '改过的名字')
        return hit ? { rename: hit.rename, title: hit.title } : null
      })()
    `)
    check('backend stores rename without touching title', !!stored && stored.title !== '改过的名字', JSON.stringify(stored))

    // Clearing it must restore the imported title.
    await session.evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.entry')]
          .find((r) => (r.querySelector('.entry-title')?.textContent || '').trim() === '改过的名字')
        if (!row) return
        const btn = [...row.querySelectorAll('button')]
          .find((b) => (b.textContent || '').trim() === '重命名')
        if (btn) btn.click()
      })()
    `)
    await sleep(400)
    await session.evaluate(`
      (() => {
        const input = document.querySelector('.rename-input')
        if (!input) return
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(200)
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.confirm-actions button')]
          .find((b) => (b.textContent || '').trim() === '保存')
        if (btn) btn.click()
      })()
    `)
    await sleep(700)
    const afterClear = await session.evaluate(`
      (async () => {
        const all = await window.__TAURI_INTERNALS__.invoke('library_list')
        return all.filter((e) => e.rename).length
      })()
    `)
    check('clearing the rename removes it from the backend', afterClear === 0, `${afterClear}`)
  }

  // Leave the app in a clean state.
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
    // The CDP websocket keeps the event loop alive, so an explicit exit is
    // required — otherwise a passing script hangs forever and a CI run times out
    // on success.
    process.exit(1)
  }
  console.log('all checks passed')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
