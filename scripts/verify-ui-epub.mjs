// Drives the running litearti app through the WebView2 DevTools protocol to
// verify the EPUB viewer end to end in the packaged binary.
//
// Run with: node scripts/verify-ui-epub.mjs
// The app must be started with:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//
// CDP is used rather than screenshots or UI Automation because this
// environment cannot read images back, and the WebView2 accessibility tree
// stops at the browser boundary. Evaluating against the real DOM is both
// possible here and a stronger assertion: it proves the chapter text actually
// reached the document, not merely that a window exists.

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
      }, 20000)
    })
  }

  /**
   * Reload the page without waiting for a reply.
   *
   * `location.reload()` destroys the execution context, so the reply to that
   * very evaluation never arrives. Sending it fire-and-forget and waiting a
   * fixed interval is the only reliable way to reload over CDP.
   */
  async reload(waitMs = 2200) {
    this.ws.send(
      JSON.stringify({
        id: this.nextId++,
        method: 'Runtime.evaluate',
        params: { expression: 'location.reload()' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, waitMs))
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
      // Include the offending expression: without it a page-side error is
      // impossible to attribute to one of the many evaluations in this script.
      throw new Error(`${detail}\n  while evaluating: ${expression.trim().slice(0, 200)}`)
    }
    return result.result.value
  }
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  // Reload so every run starts from the dashboard.
  await session.reload()
  await sleep(1800)

  // Clear any progress left by a previous run, so the assertions below always
  // describe chapter 1 in original mode rather than wherever the last run
  // stopped. This is the viewer's own storage path, so it also exercises the
  // "progress is optional" contract.
  await session.evaluate(`
    (async () => {
      const entries = await window.__TAURI_INTERNALS__.invoke('library_list')
      const epub = entries.find((e) => e.extension === 'epub')
      if (epub) await window.__TAURI_INTERNALS__.invoke('library_set_progress', { id: epub.id, progress: null })
    })()
  `)
  await session.reload()
  await sleep(1800)

  console.log('app shell')
  {
    const shell = await session.evaluate(`
      (() => ({
        title: document.title,
        hasShell: !!document.querySelector('.shell'),
        hasSidebar: !!document.querySelector('.sidebar'),
        navItems: [...document.querySelectorAll('.nav-item')].length,
      }))()
    `)
    check('page loaded', typeof shell.title === 'string' && shell.title.length > 0, shell.title)
    check('shell rendered', shell.hasShell === true)
    check('sidebar rendered', shell.hasSidebar === true)
  }

  console.log('navigate to library and open the epub')
  {
    // The sidebar may be collapsed, so the label is absent; the library entry
    // is the second nav item by structure.
    const nav = await session.evaluate(`
      (() => {
        const items = [...document.querySelectorAll('.nav-item')]
        if (items.length < 2) return { error: 'not enough nav items' }
        items[1].click()
        return { clicked: true }
      })()
    `)
    check('clicked library nav', nav.clicked === true, JSON.stringify(nav))
    await sleep(900)

    const library = await session.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.entry')]
        const epubRow = rows.find((r) => (r.textContent || '').includes('EPUB'))
        return {
          rowCount: rows.length,
          found: !!epubRow,
          text: epubRow ? epubRow.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null,
        }
      })()
    `)
    check('library list rendered', library.rowCount > 0, `${library.rowCount}`)
    check('epub entry present', library.found === true, JSON.stringify(library))
    if (library.text) console.log(`       row: ${library.text}`)

    const opened = await session.evaluate(`
      (() => {
        // The clickable target is the inner entry-open button; the row
        // itself has no handler.
        const rows = [...document.querySelectorAll('.entry')]
        const epubRow = rows.find((r) => (r.textContent || '').includes('EPUB'))
        if (!epubRow) return 'no-row'
        const trigger = epubRow.querySelector('.entry-open')
        if (!trigger) return 'no-open-button'
        trigger.click()
        return 'clicked'
      })()
    `)
    check('clicked epub entry', opened === 'clicked', opened)
    await sleep(3000)
  }

  console.log('epub viewer mounted')
  {
    const state = await session.evaluate(`
      (() => {
        const viewer = document.querySelector('.epub-viewer')
        const frame = document.querySelector('.chapter-frame')
        const toolbar = document.querySelector('.epub-toolbar')
        const err = document.querySelector('.state-body')
        return {
          viewer: !!viewer,
          frame: !!frame,
          toolbar: !!toolbar,
          errorText: err ? err.textContent.trim().slice(0, 200) : null,
        }
      })()
    `)
    check('viewer mounted', state.viewer === true, JSON.stringify(state).slice(0, 250))
    check('iframe present', state.frame === true)
    check('toolbar present', state.toolbar === true)
    check('no error state', state.errorText === null, state.errorText)
  }

  console.log('chapter content rendered')
  {
    const frameState = await session.evaluate(`
      (() => {
        const frame = document.querySelector('.chapter-frame')
        if (!frame) return { error: 'no frame' }
        const doc = frame.contentDocument
        if (!doc) return { error: 'no contentDocument (sandbox blocked?)' }
        const text = (doc.body ? doc.body.innerText : '') || ''
        const images = [...doc.querySelectorAll('img')]
        return {
          textLength: text.length,
          firstLine: text.split('\\n').map(s => s.trim()).filter(Boolean)[0] || '',
          hasH1: !!doc.querySelector('h1'),
          images: images.length,
          blobImages: images.filter((i) => (i.src || '').startsWith('blob:')).length,
          scripts: doc.querySelectorAll('script').length,
          height: frame.style.height,
          // The sample book's stylesheet sets a serif stack; in original mode
          // it must survive, proving the publisher CSS was inlined.
          hasPublisherFont: (doc.documentElement.outerHTML || '').includes('Songti'),
        }
      })()
    `)
    check('chapter text present', (frameState.textLength ?? 0) > 100, JSON.stringify(frameState).slice(0, 300))
    check('chapter heading present', frameState.hasH1 === true)
    check('no script executed/kept', frameState.scripts === 0, `${frameState.scripts}`)
    check('image rendered via blob url', (frameState.blobImages ?? 0) > 0, `${frameState.blobImages}/${frameState.images}`)
    check('frame sized to content', /^\d+px$/.test(frameState.height ?? ''), frameState.height)
    check('publisher css applied (original mode)', frameState.hasPublisherFont === true)
    if (frameState.firstLine) console.log(`       first line: ${frameState.firstLine}`)
  }

  console.log('table of contents')
  {
    const opened = await session.evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('.epub-toolbar button')]
        const toc = buttons.find((b) => (b.textContent || '').trim() === '目录')
        if (!toc) return { error: 'no toc button', labels: buttons.map(b => (b.textContent || '').trim()) }
        toc.click()
        return { clicked: true }
      })()
    `)
    check('toc button found', opened.clicked === true, JSON.stringify(opened))
    await sleep(600)

    const drawer = await session.evaluate(`
      (() => {
        const items = [...document.querySelectorAll('.toc-item')]
        return {
          count: items.length,
          labels: items.map((i) => (i.textContent || '').trim()),
        }
      })()
    `)
    check('toc lists entries', drawer.count >= 4, `${drawer.count}`)
    check('toc has nested chapters', (drawer.labels ?? []).some((l) => l.includes('三个动作')), JSON.stringify(drawer.labels))
    if (drawer.labels?.length) console.log(`       toc: ${drawer.labels.join(' / ')}`)

    // Close the drawer again so the next steps see the text.
    await session.evaluate(`
      (() => {
        const close = [...document.querySelectorAll('.toc-header button')][0]
        if (close) close.click()
      })()
    `)
    await sleep(500)
  }

  console.log('reflow mode')
  {
    const switched = await session.evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('.mode-option')]
        const reflow = buttons.find((b) => (b.textContent || '').trim() === '重排')
        if (!reflow) return { error: 'no reflow button' }
        reflow.click()
        return { clicked: true }
      })()
    `)
    check('reflow button found', switched.clicked === true, JSON.stringify(switched))
    await sleep(2500)

    const reflowState = await session.evaluate(`
      (() => {
        const frame = document.querySelector('.chapter-frame')
        const doc = frame && frame.contentDocument
        if (!doc) return { error: 'no frame' }
        const text = (doc.body ? doc.body.innerText : '') || ''
        const html = doc.documentElement.outerHTML || ''
        return {
          textLength: text.length,
          keepsHeading: !!doc.querySelector('h1'),
          keepsImage: [...doc.querySelectorAll('img')].some((i) => (i.src || '').startsWith('blob:')),
          // Publisher CSS must be gone in reflow mode...
          hasPublisherFont: html.includes('Songti'),
          // ...and the app's own reading column applied instead.
          hasThemeColumn: html.includes('measure-prose') || /max-width/.test(html),
          fontSize: doc.documentElement.style.fontSize || getComputedStyle(doc.documentElement).fontSize,
        }
      })()
    `)
    check('reflow keeps text', (reflowState.textLength ?? 0) > 100, JSON.stringify(reflowState).slice(0, 300))
    check('reflow keeps structure', reflowState.keepsHeading === true)
    check('reflow keeps image', reflowState.keepsImage === true)
    check('reflow drops publisher css', reflowState.hasPublisherFont === false)
    check('reflow applies app column', reflowState.hasThemeColumn === true)
    if (reflowState.fontSize) console.log(`       base font-size: ${reflowState.fontSize}`)
  }

  console.log('chapter navigation and progress')
  {
    const stepped = await session.evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('.epub-toolbar button')]
        const next = buttons.find((b) => b.getAttribute('aria-label') === '下一章')
        if (!next) return { error: 'no next button' }
        next.click()
        return { clicked: true }
      })()
    `)
    check('next-chapter button found', stepped.clicked === true, JSON.stringify(stepped))
    await sleep(2500)

    const chapter2 = await session.evaluate(`
      (() => {
        const frame = document.querySelector('.chapter-frame')
        const doc = frame && frame.contentDocument
        const text = doc && doc.body ? doc.body.innerText : ''
        const label = document.querySelector('.chapter-label')
        return {
          text: (text || '').slice(0, 120),
          label: label ? label.textContent.trim() : null,
          indicator: (document.querySelector('.page-indicator') || {}).textContent,
        }
      })()
    `)
    check('moved to chapter 2', (chapter2.text ?? '').includes('格式的归属'), chapter2.text)
    check('toolbar label updated', (chapter2.label ?? '').includes('格式的归属'), chapter2.label)
    console.log(`       indicator: ${(chapter2.indicator ?? '').trim()}`)

    await sleep(1200)
    const stored = await session.evaluate(`
      (async () => {
        const entries = await window.__TAURI_INTERNALS__.invoke('library_list')
        const epub = entries.find((e) => e.extension === 'epub')
        return epub ? epub.progress : null
      })()
    `)
    check('progress persisted', stored !== null, JSON.stringify(stored))
    check('progress has chapter index', stored?.chapter === 1, JSON.stringify(stored))
    check('progress records mode', stored?.mode === 'reflow', JSON.stringify(stored))
    if (stored) console.log(`       stored: ${JSON.stringify(stored)}`)
  }

  console.log('resume after reload')
  {
    await session.reload()
    await sleep(2200)

    // The app comes back on the dashboard, so navigate to the library before
    // looking for the row.
    await session.evaluate(`[...document.querySelectorAll('.nav-item')][1].click()`)
    await sleep(1000)

    const resumed = await session.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.entry')]
        const epubRow = rows.find((r) => (r.textContent || '').includes('EPUB'))
        if (!epubRow) return { found: false }
        // Read the dedicated progress element rather than regexing the row:
        // the hint is rendered into .entry-progress when present.
        const hint = epubRow.querySelector('.entry-progress')
        return {
          found: true,
          hint: hint ? hint.textContent.trim() : null,
          rowText: epubRow.textContent.replace(/\\s+/g, ' ').trim(),
        }
      })()
    `)
    check('epub row still listed', resumed.found === true, JSON.stringify(resumed))
    check('library row shows progress', resumed.hint === '第 2 章', JSON.stringify(resumed))
  }

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
    // The CDP websocket keeps the event loop alive; without this the script
    // finishes its checks and then hangs forever.
    setTimeout(() => process.exit(0), 100)
  })
