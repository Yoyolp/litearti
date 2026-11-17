// Captures screenshots of the settings screen.
//
// Run with: node scripts/shots-settings.mjs
// Requires the app started with --remote-debugging-port=9222.
//
// Why images for a settings page: every tab here is a form, and a form can be
// functionally correct and still be unreadable — a slider with no room for its
// value, a category list that collapses to nothing at a narrow width. Assertions
// pass and the page looks wrong, so the only check that catches it is looking.
//
// Output: .shots/settings-<category>.png

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT = 'D:/Myproject/litearti/.shots'

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

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(OUT, `settings-${name}.png`), Buffer.from(data, 'base64'))
    console.log(`  wrote settings-${name}.png`)
  }
}

/** Click a category by its visible label, so a reorder cannot mis-target. */
async function openCategory(session, label) {
  await session.evaluate(`
    (() => {
      const button = [...document.querySelectorAll('.category')]
        .find((b) => b.textContent.trim() === ${JSON.stringify(label)})
      button?.click()
      return !!button
    })()
  `)
  await sleep(250)
}

async function main() {
  await mkdir(OUT, { recursive: true })

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)

  await session.send('Page.enable')
  await session.send('Runtime.enable')
  // A collapsed sidebar hides its labels, so navigating by text would fail. Another
  // script leaves that preference set, and inheriting it is not this script's state.
  await session.evaluate(`localStorage.setItem('litearti.sidebar-collapsed', '0')`)
  await session.evaluate(`location.reload()`)
  await sleep(2500)

  // Navigate to Settings by label; the sidebar's order has changed once already.
  const opened = await session.evaluate(`
    (() => {
      const item = [...document.querySelectorAll('.nav-item')]
        .find((n) => n.textContent.trim() === '设置')
      item?.click()
      return !!item
    })()
  `)
  if (!opened) throw new Error('no settings nav item')
  await sleep(600)

  const categories = ['外观', '阅读', '网络', '存储', '关于']
  const names = ['appearance', 'reading', 'network', 'storage', 'about']
  for (const [index, label] of categories.entries()) {
    await openCategory(session, label)
    await session.shot(names[index])
  }

  // Light theme, so the two palettes are both on record.
  await openCategory(session, '外观')
  await session.evaluate(`
    (() => {
      const button = [...document.querySelectorAll('.choice')]
        .find((b) => b.textContent.trim() === '浅色')
      button?.click()
      return true
    })()
  `)
  await sleep(400)
  await session.shot('appearance-light')

  // Restore the system choice so a rerun starts from the same place.
  await session.evaluate(`
    (() => {
      const button = [...document.querySelectorAll('.choice')]
        .find((b) => b.textContent.trim() === '跟随系统')
      button?.click()
      return true
    })()
  `)
  await sleep(200)

  console.log('done')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
