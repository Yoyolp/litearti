// Verifies the login-credential plumbing in the packaged app.
//
// Run with: node scripts/verify-ui-credentials.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// The one thing this cannot drive is the login window itself — it is a separate
// native window showing a third-party site, so the actual "log in, close the
// window, get cookies" loop stays a manual check. Everything around it is
// asserted here: the IPC surface, the status shape, the guarantee that no cookie
// reaches the frontend, and clearing.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const ROOT = 'D:/Myproject/litearti'
const APP_DATA = join(
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'app.litearti.reader',
)
const SOURCES_DIR = join(APP_DATA, 'sources')

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
      throw new Error(detail)
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

async function waitFor(session, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await session.evaluate(expression)
    if (value) return value
    await sleep(250)
  }
  return null
}

async function main() {
  const source = JSON.parse(await readFile(join(ROOT, 'sources/bqg5555.json'), 'utf8'))
  // A copy that declares a login, which is what the UI keys its button off.
  const withAuth = { ...source, id: 'auth-test', name: '登录测试源', auth: { type: 'cookie' } }

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  await session.reload()

  console.log('install a source that declares auth')
  {
    const saved = await session.evaluate(`
      (async () => {
        await window.__TAURI_INTERNALS__.invoke('sources_save', {
          sources: ${JSON.stringify([source, withAuth])},
        })
        const loaded = await window.__TAURI_INTERNALS__.invoke('sources_load')
        return loaded.map((s) => s.id)
      })()
    `)
    check('both sources persisted', (saved ?? []).length === 2, JSON.stringify(saved))
  }

  await session.reload()
  await session.evaluate(`[...document.querySelectorAll('.nav-list .nav-item')][2].click()`)
  await sleep(1500)

  console.log('login affordance appears only for sources that declare auth')
  {
    const rows = await session.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.source-row')]
        return rows.map((row) => ({
          name: row.querySelector('.source-name')?.textContent?.trim(),
          hasAuthUi: !!row.querySelector('.auth'),
          state: row.querySelector('.auth-state')?.textContent?.trim() ?? null,
        }))
      })()
    `)
    const plain = (rows ?? []).find((r) => r.name?.includes('笔趣阁'))
    const authed = (rows ?? []).find((r) => r.name === '登录测试源')
    check('plain source has no login UI', plain?.hasAuthUi === false, JSON.stringify(plain))
    check('auth source shows login UI', authed?.hasAuthUi === true, JSON.stringify(authed))
    check('starts logged out', authed?.state === '未登录', authed?.state)
  }

  console.log('status endpoint never returns the cookie')
  {
    // Seed a credential directly, since the login window cannot be driven here.
    await mkdir(SOURCES_DIR, { recursive: true })
    await writeFile(
      join(SOURCES_DIR, 'credentials.json'),
      JSON.stringify(
        {
          version: 1,
          entries: {
            'auth-test': {
              host: 'www.bqg5555.cc',
              cookie: 'plain:sid=SECRET-VALUE',
              updatedAt: Date.now(),
              origin: 'login',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const status = await session.evaluate(`
      (async () => {
        const map = await window.__TAURI_INTERNALS__.invoke('credentials_status')
        return { keys: Object.keys(map), entry: map['auth-test'] ?? null, raw: JSON.stringify(map) }
      })()
    `)
    check('status reports the credential', (status?.keys ?? []).includes('auth-test'), JSON.stringify(status?.keys))
    check('status reports the host', status?.entry?.host === 'www.bqg5555.cc', status?.entry?.host)
    check('status reports hasCookie', status?.entry?.hasCookie === true)
    check(
      'status carries no cookie value',
      !(status?.raw ?? '').includes('SECRET-VALUE'),
      status?.raw,
    )
    check(
      'status has no cookie field at all',
      !Object.prototype.hasOwnProperty.call(status?.entry ?? {}, 'cookie'),
      JSON.stringify(status?.entry),
    )
  }

  console.log('the UI reflects a stored login')
  {
    await session.reload()
    await session.evaluate(`[...document.querySelectorAll('.nav-list .nav-item')][2].click()`)
    const state = await waitFor(
      session,
      `(() => {
        const rows = [...document.querySelectorAll('.source-row')]
        const row = rows.find((r) => r.querySelector('.source-name')?.textContent?.trim() === '登录测试源')
        const el = row?.querySelector('.auth-state')
        return el ? el.textContent.trim() : ''
      })()`,
      15000,
    )
    check('row shows logged-in state with the host', (state ?? '').includes('已登录'), state)
    check('host is visible to the person', (state ?? '').includes('www.bqg5555.cc'), state)

    const buttons = await session.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.source-row')]
        const row = rows.find((r) => r.querySelector('.source-name')?.textContent?.trim() === '登录测试源')
        return [...(row?.querySelectorAll('.auth button') ?? [])].map((b) => b.textContent.trim())
      })()
    `)
    check('offers re-login', (buttons ?? []).includes('重新登录'), JSON.stringify(buttons))
    check('offers logout', (buttons ?? []).includes('退出登录'), JSON.stringify(buttons))
  }

  console.log('logout clears the credential')
  {
    await session.evaluate(`
      (async () => {
        await window.__TAURI_INTERNALS__.invoke('credentials_clear', { sourceId: 'auth-test' })
      })()
    `)
    const after = await session.evaluate(`
      (async () => {
        const map = await window.__TAURI_INTERNALS__.invoke('credentials_status')
        return Object.keys(map)
      })()
    `)
    check('credential is gone', !(after ?? []).includes('auth-test'), JSON.stringify(after))

    await session.reload()
    await session.evaluate(`[...document.querySelectorAll('.nav-list .nav-item')][2].click()`)
    const state = await waitFor(
      session,
      `(() => {
        const rows = [...document.querySelectorAll('.source-row')]
        const row = rows.find((r) => r.querySelector('.source-name')?.textContent?.trim() === '登录测试源')
        const el = row?.querySelector('.auth-state')
        return el && el.textContent.trim() === '未登录' ? 'logged-out' : ''
      })()`,
      15000,
    )
    check('row returns to logged-out', state === 'logged-out', state)
  }

  console.log('login on a source without auth is refused')
  {
    const result = await session.evaluate(`
      (async () => {
        try {
          await window.__TAURI_INTERNALS__.invoke('source_login_start', { sourceId: 'bqg5555' })
          return 'started'
        } catch (error) {
          return String(error)
        }
      })()
    `)
    check('refuses to open a login for a source without auth', result !== 'started', String(result))
    check('error names the missing declaration', (result ?? '').includes('auth'), String(result))
  }

  // Restore a clean state: only the real source, no test credential.
  await session.evaluate(`
    (async () => {
      await window.__TAURI_INTERNALS__.invoke('sources_save', {
        sources: ${JSON.stringify([source])},
      })
      await window.__TAURI_INTERNALS__.invoke('credentials_clear', { sourceId: 'auth-test' })
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
