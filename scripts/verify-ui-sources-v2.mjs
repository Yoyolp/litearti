// Verifies the rebuilt source section in the running app.
//
// Run with: node scripts/verify-ui-sources-v2.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// Covers what P3 added, in the order a person would hit it:
//   1. management: grouping by type, search, selection mode, delete confirm
//   2. editor: opens blank and populated, form/raw round-trip, field-level
//      validation, save persists through the real IPC
//   3. trial run: runs a stage against a fixture server and shows a request URL
//   4. aggregate: searches several sources, keeps failures visible
//
// A local HTTP fixture server is used for 3 and 4 so the checks are deterministic
// and do not depend on any live site. That is the only way "a source that fails is
// reported as failed" can be tested at all.

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

function equal(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(label, a === e, `expected ${e}, got ${a}`)
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

  async reload(waitMs = 2600) {
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

/** A source fixture pointing at the local test server. */
function source(id, name, type, searchPath, extra = {}) {
  return {
    schemaVersion: 1,
    id,
    name,
    version: '1.0.0',
    homepage: extra.homepage ?? 'http://127.0.0.1:0/',
    type,
    enabled: true,
    request: { headers: {}, timeoutMs: 5000, delayMs: 0 },
    search: {
      url: `http://127.0.0.1:0${searchPath}`,
      method: 'GET',
      list: 'css:li',
      fields: { title: 'css:.t', detailUrl: 'css:a@href' },
    },
    detail: { list: 'css:a', fields: { title: 'css:', url: 'css:@href' } },
    chapter: { content: 'css:#c' },
    ...extra,
  }
}

async function main() {
  // --- fixture server ------------------------------------------------------
  const good = `<!doctype html><ul>
    <li><a class="t" href="/book/1">书一</a></li>
    <li><a class="t" href="/book/2">书二</a></li>
    <li><span>坏行，没有标题也没有链接</span></li>
    <li><a class="t" href="/book/3">书三</a></li>
  </ul>`
  const detail = `<div>
    <a href="/c/1">第一章</a><a>没有链接的章</a><a href="/c/2">第二章</a>
  </div>`

  let fixturePort = 0
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/search')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(good)
      return
    }
    if (url.startsWith('/book/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(detail)
      return
    }
    if (url.startsWith('/slow')) {
      // Longer than the aggregate timeout, to prove the isolation.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<ul><li><a class="t" href="/book/1">慢书</a></li></ul>`)
      }, 20000)
      return
    }
    res.writeHead(404)
    res.end('no')
  })
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fixturePort = server.address().port
      resolve()
    })
  })
  const base = `http://127.0.0.1:${fixturePort}`

  const seed = [
    source('good-novel', '示例小说源', 'novel', '/search?q={{keyword}}'),
    source('second-novel', '第二个小说源', 'novel', '/search?q={{keyword}}'),
    {
      // A video source must carry a `video` block (the schema rule added with the
      // player). Without one it is rejected at save time, which would silently
      // shrink this fixture and make the count assertions fail with no stated
      // reason — exactly what happened the first time this ran after that change.
      ...source('video-source', '视频源', 'video', '/search?q={{keyword}}'),
      video: {
        episodes: 'css:.episode a',
        episodeUrl: 'css:@href',
        playback: { kind: 'regex', pattern: "url: '([^']+)'" },
      },
    },
    source('slow-source', '慢源', 'novel', '/slow?q={{keyword}}'),
  ].map((item) => ({
    ...item,
    homepage: `${base}/`,
    search: { ...item.search, url: item.search.url.replace('http://127.0.0.1:0', base) },
  }))

  const dir = await mkdtemp(join(tmpdir(), 'litearti-p3-'))
  const seedFile = join(dir, 'sources.json')
  await writeFile(seedFile, JSON.stringify(seed), 'utf8')

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  // Install the fixtures through the real persistence path.
  await session.evaluate(`
    (async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke
      await invoke('sources_save', { sources: ${JSON.stringify(seed)} })
      return true
    })()
  `)
  await session.reload()
  await session.evaluate(`[...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === '源')?.click()`)
  await sleep(1200)

  // --- management ----------------------------------------------------------
  console.log('management')
  {
    const state = await session.evaluate(`
      (() => ({
        groups: [...document.querySelectorAll('.group-label')].map((e) => (e.textContent || '').trim()),
        rows: document.querySelectorAll('.source-row').length,
        chips: document.querySelectorAll('.chip').length,
        newBtn: [...document.querySelectorAll('.actions button')].some((b) => (b.textContent || '').trim() === '新建源'),
        aggregateBtn: [...document.querySelectorAll('.actions button')].some((b) => (b.textContent || '').trim() === '聚合检索'),
        selectBtn: [...document.querySelectorAll('.toolbar button')].some((b) => (b.textContent || '').trim() === '选择'),
      }))()
    `)
    check('rows render for every source', state.rows === 4, `${state.rows}`)
    check('sources are grouped by type', state.groups.includes('小说') && state.groups.includes('视频'), JSON.stringify(state.groups))
    equal('type chips shown', state.chips, 4)
    check('a new-source button exists', state.newBtn === true)
    check('an aggregate entry exists', state.aggregateBtn === true)
    check('a selection entry exists', state.selectBtn === true)

    // Group collapse must actually hide rows.
    await session.evaluate(`
      (() => {
        const heads = [...document.querySelectorAll('.group-head')]
        const novel = heads.find((h) => (h.textContent || '').includes('小说'))
        if (novel) novel.click()
      })()
    `)
    await sleep(300)
    const collapsed = await session.evaluate(`document.querySelectorAll('.source-row').length`)
    check('collapsing a group hides its rows', collapsed === 1, `${collapsed}`)

    // Expand again.
    await session.evaluate(`
      (() => {
        const heads = [...document.querySelectorAll('.group-head')]
        const novel = heads.find((h) => (h.textContent || '').includes('小说'))
        if (novel) novel.click()
      })()
    `)
    await sleep(300)

    // Text search.
    await session.evaluate(`
      (() => {
        const input = document.querySelector('.search-input')
        if (!input) return
        input.value = '视频'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(400)
    const searched = await session.evaluate(`document.querySelectorAll('.source-row').length`)
    check('text search narrows to one row', searched === 1, `${searched}`)

    await session.evaluate(`
      (() => {
        const input = document.querySelector('.search-input')
        if (!input) return
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(300)

    // Selection mode: enable/disable and delete actions must appear.
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.toolbar button')]
          .find((b) => (b.textContent || '').trim() === '选择')
        if (btn) btn.click()
      })()
    `)
    await sleep(400)
    const selecting = await session.evaluate(`
      (() => ({
        checkboxes: document.querySelectorAll('.row-check input').length,
        disableBtn: [...document.querySelectorAll('.selection-actions button')].some((b) => (b.textContent || '').trim() === '停用所选'),
        deleteBtn: [...document.querySelectorAll('.selection-actions button')].some((b) => (b.textContent || '').trim() === '删除所选'),
        toolbarGone: !document.querySelector('.toolbar'),
      }))()
    `)
    check('every row gets a checkbox', selecting.checkboxes === 4, `${selecting.checkboxes}`)
    check('batch disable exists', selecting.disableBtn === true)
    check('batch delete exists', selecting.deleteBtn === true)
    check('toolbar hides in selection mode', selecting.toolbarGone === true)

    await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    await sleep(400)
    const exited = await session.evaluate(`!!document.querySelector('.toolbar')`)
    check('Esc leaves selection mode', exited === true)
  }

  // --- editor --------------------------------------------------------------
  console.log('editor: new source')
  {
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.actions button')]
          .find((b) => (b.textContent || '').trim() === '新建源')
        if (btn) btn.click()
      })()
    `)
    await sleep(700)
    const state = await session.evaluate(`
      (() => ({
        editor: !!document.querySelector('.editor'),
        sections: document.querySelectorAll('.section').length,
        saveDisabled: (() => {
          const btn = [...document.querySelectorAll('.head-actions button')]
            .find((b) => (b.textContent || '').trim() === '保存')
          return btn ? btn.disabled : null
        })(),
        issueCount: (document.querySelector('.issue-count')?.textContent || '').trim(),
        tester: !!document.querySelector('.tester'),
      }))()
    `)
    check('editor opens', state.editor === true, JSON.stringify(state))
    check('editor has all form sections', state.sections >= 5, `${state.sections}`)
    check('save is disabled while the document is invalid', state.saveDisabled === true)
    check('a validation count is shown', state.issueCount.includes('处'), state.issueCount)
    check('the selector tester is present', state.tester === true)

    // Raw mode round-trip: switch, confirm JSON, switch back.
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.mode-btn')]
          .find((b) => (b.textContent || '').trim() === '原文')
        if (btn) btn.click()
      })()
    `)
    await sleep(400)
    const raw = await session.evaluate(`
      (() => {
        const area = document.querySelector('.raw-input')
        if (!area) return { found: false }
        let parsed = null
        try { parsed = JSON.parse(area.value) } catch {}
        return { found: true, keys: parsed ? Object.keys(parsed) : null }
      })()
    `)
    check('raw mode shows parseable JSON', raw.found && Array.isArray(raw.keys), JSON.stringify(raw))
    check(
      'raw JSON has the schema fields',
      (raw.keys ?? []).includes('search') && (raw.keys ?? []).includes('detail'),
      JSON.stringify(raw.keys),
    )

    // A broken raw document must not be accepted.
    await session.evaluate(`
      (() => {
        const area = document.querySelector('.raw-input')
        if (!area) return
        area.value = '{ broken'
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(200)
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.mode-btn')]
          .find((b) => (b.textContent || '').trim() === '表单')
        if (btn) btn.click()
      })()
    `)
    await sleep(400)
    const afterBroken = await session.evaluate(`
      (() => ({
        stillRaw: !!document.querySelector('.raw-input'),
        error: (document.querySelector('.raw-error')?.textContent || '').trim(),
      }))()
    `)
    check('invalid raw JSON keeps the editor in raw mode', afterBroken.stillRaw === true, JSON.stringify(afterBroken))
    check('invalid raw JSON explains itself', afterBroken.error.includes('JSON'), afterBroken.error)

    // Fill the form properly and save.
    await session.evaluate(`
      (() => {
        const area = document.querySelector('.raw-input')
        if (!area) return
        area.value = ${JSON.stringify(
          JSON.stringify(
            {
              schemaVersion: 1,
              id: 'created-by-test',
              name: '测试新建源',
              version: '1.0.0',
              homepage: base + '/',
              type: 'novel',
              enabled: true,
              request: { headers: {}, timeoutMs: 5000, delayMs: 0 },
              search: {
                url: base + '/search?q={{keyword}}',
                method: 'GET',
                list: 'css:li',
                fields: { title: 'css:.t', detailUrl: 'css:a@href' },
              },
              detail: { list: 'css:a', fields: { title: 'css:', url: 'css:@href' } },
              chapter: { content: 'css:#c' },
            },
            null,
            2,
          ),
        )}
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(200)
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.mode-btn')]
          .find((b) => (b.textContent || '').trim() === '表单')
        if (btn) btn.click()
      })()
    `)
    await sleep(500)
    const filled = await session.evaluate(`
      (() => ({
        editor: !!document.querySelector('.editor'),
        saveDisabled: (() => {
          const btn = [...document.querySelectorAll('.head-actions button')]
            .find((b) => (b.textContent || '').trim() === '保存')
          return btn ? btn.disabled : null
        })(),
        issues: (document.querySelector('.issue-count')?.textContent || '').trim(),
      }))()
    `)
    check('a valid document returns to form mode', filled.editor === true, JSON.stringify(filled))
    check('save becomes enabled once valid', filled.saveDisabled === false, JSON.stringify(filled))
    check('no issues remain on a valid document', filled.issues === '', filled.issues)

    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.head-actions button')]
          .find((b) => (b.textContent || '').trim() === '保存')
        if (btn) btn.click()
      })()
    `)
    await sleep(1000)

    const persisted = await session.evaluate(`
      (async () => {
        const raw = await window.__TAURI_INTERNALS__.invoke('sources_load')
        const list = Array.isArray(raw) ? raw : []
        return { count: list.length, hasNew: list.some((s) => s.id === 'created-by-test') }
      })()
    `)
    check('saving persists the new source', persisted.hasNew === true, JSON.stringify(persisted))
    equal('the source count grew by one', persisted.count, 5)
  }

  console.log('editor: edit an existing source')
  {
    await session.reload()
    await session.evaluate(`[...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === '源')?.click()`)
    await sleep(1000)
    await session.evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.source-row')]
          .find((r) => (r.querySelector('.source-name')?.textContent || '').includes('测试新建源'))
        if (!row) return
        const btn = [...row.querySelectorAll('button')]
          .find((b) => (b.textContent || '').trim() === '编辑')
        if (btn) btn.click()
      })()
    `)
    await sleep(800)
    const state = await session.evaluate(`
      (() => {
        const inputs = [...document.querySelectorAll('.section .input')]
        const name = inputs.find((i) => i.value === '测试新建源')
        const title = (document.querySelector('.title-line')?.textContent || '').trim()
        return { namePrefilled: !!name, title }
      })()
    `)
    check('editing prefills the form', state.namePrefilled === true, JSON.stringify(state))
    check('the header says which source is being edited', state.title.includes('测试新建源'), state.title)

    // The selector tester must report something measurable. The field is
    // pre-filled with the source's real selector, so this exercises the "already
    // valid selector" path — the one a person hits when re-checking a source.
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.selector-row button')][0]
        if (btn) btn.click()
      })()
    `)
    await sleep(1800)
    const tested = await session.evaluate(`
      (() => {
        const result = document.querySelector('.test-result')
        if (!result) return null
        return {
          ok: result.classList.contains('is-ok'),
          message: (result.querySelector('.test-message')?.textContent || '').trim(),
        }
      })()
    `)
    check('the tester reports a result', !!tested, JSON.stringify(tested))
    check(
      'the tester reports a match count for a working selector',
      (tested?.message ?? '').includes('匹配'),
      JSON.stringify(tested),
    )

    await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    await sleep(500)
  }

  // --- selector tester against the fixture server --------------------------
  console.log('selector tester: live page')
  {
    await session.evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.source-row')]
          .find((r) => (r.querySelector('.source-name')?.textContent || '').includes('示例小说源'))
        if (!row) return
        const btn = [...row.querySelectorAll('button')]
          .find((b) => (b.textContent || '').trim() === '编辑')
        if (btn) btn.click()
      })()
    `)
    await sleep(800)

    await session.evaluate(`
      (() => {
        const input = document.querySelector('.tester-field .input')
        if (!input) return
        input.value = ${JSON.stringify(`${base}/search?q=x`)};
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(300)

    // Test the search list selector (the first `.selector-row button`).
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.selector-row button')][0]
        if (btn) btn.click()
      })()
    `)
    await sleep(1800)
    const result = await session.evaluate(`
      (() => {
        const box = document.querySelector('.test-result')
        if (!box) return null
        return {
          ok: box.classList.contains('is-ok'),
          message: (box.querySelector('.test-message')?.textContent || '').trim(),
          sampleCount: box.querySelectorAll('.test-sample li').length,
        }
      })()
    `)
    check('the tester fetched and matched', !!result && result.ok === true, JSON.stringify(result))
    check(
      'the match count is reported',
      (result?.message ?? '').includes('匹配'),
      JSON.stringify(result),
    )
    check('sample values are shown', (result?.sampleCount ?? 0) > 0, JSON.stringify(result))

    await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    await sleep(500)
  }

  // --- trial run -----------------------------------------------------------
  console.log('trial run')
  {
    await session.evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.source-row')]
          .find((r) => (r.querySelector('.source-name')?.textContent || '').includes('示例小说源'))
        if (!row) return
        const btn = [...row.querySelectorAll('button')]
          .find((b) => (b.textContent || '').trim() === '试跑')
        if (btn) btn.click()
      })()
    `)
    await sleep(800)
    const opened = await session.evaluate(`!!document.querySelector('.trial')`)
    check('the trial page opens', opened === true)

    await session.evaluate(`
      (() => {
        const input = document.querySelector('.input-row .input')
        if (!input) return
        input.value = 'x'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(200)
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.input-row button')]
          .find((b) => (b.textContent || '').trim() === '运行')
        if (btn) btn.click()
      })()
    `)
    await sleep(2000)

    const trial = await session.evaluate(`
      (() => ({
        rows: document.querySelectorAll('.result-row').length,
        hasRequestUrl: !!document.querySelector('.request-url code'),
        requestUrl: (document.querySelector('.request-url code')?.textContent || '').trim(),
        diagShown: !!document.querySelector('.block.is-warn'),
        diagCount: document.querySelectorAll('.diagnosis-row').length,
      }))()
    `)
    check('the trial lists parsed rows', trial.rows === 3, JSON.stringify(trial))
    check('the trial shows the request URL', trial.hasRequestUrl === true, JSON.stringify(trial))
    check('the request URL has the keyword substituted', trial.requestUrl.includes('q=x'), trial.requestUrl)
    check('a skipped row is reported as a diagnosis', trial.diagShown === true, JSON.stringify(trial))
    equal('exactly one row was diagnosed', trial.diagCount, 1)

    // Detail stage must also work, and report its own diagnosis.
    await session.evaluate(`
      (() => {
        const chip = [...document.querySelectorAll('.stage-row .chip')]
          .find((c) => (c.textContent || '').trim() === '详情')
        if (chip) chip.click()
      })()
    `)
    await sleep(300)
    await session.evaluate(`
      (() => {
        const input = document.querySelector('.input-row .input')
        if (input) {
          input.value = ${JSON.stringify(`${base}/book/1`)};
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })()
    `)
    await sleep(200)
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.input-row button')]
          .find((b) => (b.textContent || '').trim() === '运行')
        if (btn) btn.click()
      })()
    `)
    await sleep(1800)
    const detailTrial = await session.evaluate(`
      (() => ({
        rows: document.querySelectorAll('.result-row').length,
        diagCount: document.querySelectorAll('.diagnosis-row').length,
      }))()
    `)
    check('the detail stage parses chapters', detailTrial.rows === 2, JSON.stringify(detailTrial))
    equal('the detail stage diagnoses the unlinked chapter', detailTrial.diagCount, 1)

    await session.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    await sleep(500)
  }

  // --- aggregate -----------------------------------------------------------
  console.log('aggregate search')
  {
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.actions button')]
          .find((b) => (b.textContent || '').trim() === '聚合检索')
        if (btn) btn.click()
      })()
    `)
    await sleep(700)
    const opened = await session.evaluate(`!!document.querySelector('.aggregate')`)
    check('the aggregate page opens', opened === true)

    await session.evaluate(`
      (() => {
        const input = document.querySelector('.aggregate .search-input')
        if (!input) return
        input.value = 'x'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(200)
    await session.evaluate(`
      (() => {
        const btn = [...document.querySelectorAll('.aggregate .search-row button')]
          .find((b) => (b.textContent || '').trim() === '搜索')
        if (btn) btn.click()
      })()
    `)
    // The slow source has a 20s delay and the aggregate timeout is 12s, so wait
    // past the deadline. That is the whole point: the run must finish anyway.
    await sleep(14000)

    const agg = await session.evaluate(`
      (() => ({
        groups: [...document.querySelectorAll('.group-name')].map((e) => (e.textContent || '').trim()),
        cards: document.querySelectorAll('.aggregate .card').length,
        failures: document.querySelectorAll('.failure-row').length,
        failureMessages: [...document.querySelectorAll('.failure-message')].map((e) => (e.textContent || '').trim()),
        summaryWarn: document.querySelectorAll('.summary-line.is-warn').length,
      }))()
    `)
    check('successful sources produce groups', agg.groups.length >= 2, JSON.stringify(agg.groups))
    check('results are rendered as cards', agg.cards >= 6, `${agg.cards}`)
    check('the slow source is reported as a failure', agg.failures >= 1, JSON.stringify(agg))
    check(
      'the failure names the deadline instead of saying "no results"',
      (agg.failureMessages[0] ?? '').includes('秒') || (agg.failureMessages[0] ?? '').includes('超时'),
      JSON.stringify(agg.failureMessages),
    )
    check('a failure summary line is shown', agg.summaryWarn >= 1, `${agg.summaryWarn}`)

    // Merged view: one flat list with source labels.
    await session.evaluate(`
      (() => {
        const btn = document.querySelector('.view-toggle')
        if (btn) btn.click()
      })()
    `)
    await sleep(500)
    const merged = await session.evaluate(`
      (() => ({
        cards: document.querySelectorAll('.merged-cell .card').length,
        labels: document.querySelectorAll('.merged-source').length,
      }))()
    `)
    check('merged view flattens the results', merged.cards >= 6, JSON.stringify(merged))
    equal('every merged row is labelled with its source', merged.labels, merged.cards)
  }

  // Clean up: restore an empty source list so the next run starts clean.
  await session.evaluate(`
    (async () => {
      await window.__TAURI_INTERNALS__.invoke('sources_save', { sources: [] })
      return true
    })()
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
