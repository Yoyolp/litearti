/**
 * Verifies the source engine end to end with a mock fetcher.
 *
 * Run with: node scripts/verify-source-engine.mjs
 *
 * No network: the engine takes its fetcher by injection, so this drives the
 * whole pipeline (template filling, list iteration, per-field extraction,
 * URL resolution, chapter loading) against fixed HTML and JSON. That is the
 * part worth testing; the transport is a thin wrapper over reqwest and has its
 * own Rust tests.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = 'D:/Myproject/litearti'
const require = createRequire(import.meta.url)

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

/** Minimal DOM: tag, class, id, attribute selectors plus descendants. */
function installDomShim() {
  /**
   * Text nodes are real nodes here because the engine's paragraph extraction
   * walks `childNodes` looking for `nodeType === 3`. Storing text on the parent
   * instead would make every chapter extract as empty in tests while working in
   * the app — a shim that hides the very behaviour under test.
   */
  class TextNode {
    constructor(value) {
      this.nodeType = 3
      this.localName = '#text'
      this.children = []
      this.childNodes = []
      this.parent = null
      this.data = value
    }
    get textContent() {
      return this.data
    }
  }

  class El {
    constructor(name, attrs = {}) {
      this.localName = name
      this.nodeName = name
      this.nodeType = 1
      this.attributes = Object.entries(attrs).map(([n, v]) => ({ name: n, value: v }))
      this.children = []
      this.childNodes = []
      this.parent = null
    }
    getAttribute(n) {
      return this.attributes.find((a) => a.name === n)?.value ?? null
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('')
    }
    matches(selector) {
      return matchesChain(this, selector.trim().split(/\s+/), selector.trim().split(/\s+/).length - 1)
    }
    querySelectorAll(selector) {
      const list = selector.split(',').map((s) => s.trim())
      return [...walk(this)].filter((node) => list.some((sel) => node.matches(sel)))
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    }
  }

  function matchesChain(node, parts, index) {
    if (index < 0) return true
    if (!matchesSimple(node, parts[index])) return false
    let ancestor = node.parent
    while (ancestor) {
      if (matchesChain(ancestor, parts, index - 1)) return true
      ancestor = ancestor.parent
    }
    return index === 0
  }

  function matchesSimple(node, simple) {
    // A bare `css:` means "this element", so an empty simple selector matches.
    if (!simple) return true
    const attrMatch = /\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/.exec(simple)
    if (attrMatch) {
      const value = node.getAttribute(attrMatch[1])
      if (value === null) return false
      if (attrMatch[2] !== undefined && value !== attrMatch[2]) return false
      simple = simple.replace(attrMatch[0], '')
    }
    const idMatch = /#([\w-]+)/.exec(simple)
    if (idMatch) {
      if (node.getAttribute('id') !== idMatch[1]) return false
      simple = simple.replace(idMatch[0], '')
    }
    const classMatch = /\.([\w-]+)/.exec(simple)
    if (classMatch) {
      const classes = (node.getAttribute('class') ?? '').split(/\s+/)
      if (!classes.includes(classMatch[1])) return false
      simple = simple.replace(classMatch[0], '')
    }
    const tag = simple.trim()
    return !tag || node.localName === tag
  }

  function* walk(node) {
    for (const child of node.children) {
      yield child
      yield* walk(child)
    }
  }

  globalThis.DOMParser = class {
    parseFromString(html) {
      const doc = new El('#document')
      doc.nodeType = 9
      const body = new El('body')
      doc.children.push(body)
      doc.childNodes.push(body)
      body.parent = doc
      const text = html.replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
      const re = /<(\/?)([A-Za-z_][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
      const stack = [body]
      let last = 0
      let m
      while ((m = re.exec(text)) !== null) {
        const between = text.slice(last, m.index)
        if (between) {
          const textNode = new TextNode(between)
          const parent = stack[stack.length - 1]
          textNode.parent = parent
          parent.childNodes.push(textNode)
        }
        last = re.lastIndex
        const [, closing, rawName, attrText, selfClosing] = m
        const name = rawName.toLowerCase()
        if (closing) {
          for (let i = stack.length - 1; i > 0; i -= 1) {
            if (stack[i].localName === name) {
              stack.length = i
              break
            }
          }
          continue
        }
        if (name === 'body') continue
        const attrs = {}
        const ar = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
        let am
        while ((am = ar.exec(attrText)) !== null) attrs[am[1]] = am[2] ?? am[3] ?? ''
        const node = new El(name, attrs)
        const parent = stack[stack.length - 1]
        node.parent = parent
        parent.children.push(node)
        parent.childNodes.push(node)
        if (!selfClosing && !['br', 'img', 'hr', 'meta', 'link', 'input'].includes(name)) stack.push(node)
      }
      return doc
    }
  }
}

async function loadModule(relativePath) {
  const esbuild = require(
    join(root, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'),
  )
  const dir = await mkdtemp(join(root, 'node_modules/.tmp/verify-engine-'))
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    entryPoints: [join(root, relativePath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent',
    // The engine imports the Tauri API for its default fetcher; that path is
    // not exercised here, so stub it rather than resolving the real module.
    external: ['@tauri-apps/api/core', '@tauri-apps/plugin-dialog'],
  })
  const module_ = await import(pathToFileURL(outfile).href)
  await rm(dir, { recursive: true, force: true })
  return module_
}

const SEARCH_HTML = `<html><body>
  <ul class="book-list">
    <li class="book">
      <a class="title" href="/book/1">第一本</a>
      <span class="author">作者甲</span>
      <img src="/covers/1.jpg"/>
      <p class="intro">简介一</p>
    </li>
    <li class="book">
      <a class="title" href="/book/2">第二本</a>
      <span class="author">作者乙</span>
      <img src="https://cdn.example.com/2.jpg"/>
      <p class="intro">简介二</p>
    </li>
    <li class="book"><span class="author">没有标题的项</span></li>
  </ul>
</body></html>`

const DETAIL_HTML = `<html><body>
  <h1 class="book-title">第一本</h1>
  <span class="author">作者甲</span>
  <div class="intro">这是一段简介</div>
  <div class="chapters">
    <a href="/chapter/1">第一章</a>
    <a href="/chapter/2">第二章</a>
  </div>
</body></html>`

const CHAPTER_HTML = `<html><body><div id="content"><p>正文第一段</p><p>正文第二段</p></div></body></html>`

const SEARCH_JSON = JSON.stringify({
  data: {
    items: [
      { name: 'JSON 第一本', author: '甲', url: '/book/1', cover: '/c/1.jpg' },
      { name: 'JSON 第二本', author: '乙', url: '/book/2', cover: '/c/2.jpg' },
    ],
  },
})

function makeSource(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'test',
    name: '测试源',
    version: '1.0.0',
    homepage: 'https://example.com',
    type: 'novel',
    enabled: true,
    request: { headers: {}, timeoutMs: 15000, delayMs: 0 },
    search: {
      url: 'https://example.com/s?q={{keyword}}&p={{page}}',
      method: 'GET',
      list: 'css:.book',
      fields: {
        title: 'css:.title',
        author: 'css:.author',
        cover: 'css:img@src',
        intro: 'css:.intro',
        detailUrl: 'css:a@href',
      },
    },
    detail: {
      list: 'css:.chapters a',
      fields: { title: 'css:', url: 'css:@href' },
      title: 'css:.book-title',
      intro: 'css:.intro',
    },
    chapter: { content: 'css:#content' },
    ...overrides,
  }
}

async function main() {
  installDomShim()
  const { SourceEngine, fillTemplate, absoluteUrl, selectJsonObjects } = await loadModule(
    'src/sources/engine.ts',
  )

  console.log('template filling')
  {
    check(
      'fills keyword and page',
      fillTemplate('https://x/s?q={{keyword}}&p={{page}}', { keyword: '书', page: 2 }) ===
        'https://x/s?q=%E4%B9%A6&p=2',
      fillTemplate('https://x/s?q={{keyword}}&p={{page}}', { keyword: '书', page: 2 }),
    )
    check(
      'url-encodes the keyword',
      fillTemplate('https://x/?q={{keyword}}', { keyword: 'a b&c' }).includes('a%20b%26c'),
    )
    check(
      'leaves unknown placeholders alone',
      fillTemplate('https://x/?q={{unknown}}', {}) === 'https://x/?q={{unknown}}',
    )
  }

  console.log('url resolution')
  {
    check('resolves relative', absoluteUrl('/book/1', 'https://example.com/s') === 'https://example.com/book/1')
    check(
      'resolves parent-relative',
      absoluteUrl('../x', 'https://example.com/a/b') === 'https://example.com/x',
    )
    check('keeps absolute', absoluteUrl('https://cdn.x/y.jpg', 'https://example.com') === 'https://cdn.x/y.jpg')
    check('null stays null', absoluteUrl(null, 'https://example.com') === null)
    check('empty stays null', absoluteUrl('  ', 'https://example.com') === null)
  }

  console.log('search with CSS (HTML site)')
  {
    const requested = []
    const fetcher = async (url) => {
      requested.push(url)
      return { status: 200, url: 'https://example.com/s?q=x', body: SEARCH_HTML }
    }
    const engine = new SourceEngine(makeSource(), fetcher)
    const items = await engine.search('关键词')

    check('requested the search url', requested.length === 1)
    check('url carries the keyword', requested[0].includes('%E5%85%B3%E9%94%AE%E8%AF%8D'), requested[0])
    // The third <li> has no title, so it must be skipped rather than rendered
    // as an empty card.
    check('skips items without a title', items.length === 2, `${items.length}`)
    check('reads title', items[0].title === '第一本', items[0].title)
    check('reads author', items[0].author === '作者甲', items[0].author)
    check('reads intro', items[0].intro === '简介一', items[0].intro)
    check(
      'absolutises relative cover',
      items[0].cover === 'https://example.com/covers/1.jpg',
      items[0].cover,
    )
    check(
      'keeps absolute cover',
      items[1].cover === 'https://cdn.example.com/2.jpg',
      items[1].cover,
    )
    check(
      'absolutises detail url',
      items[0].detailUrl === 'https://example.com/book/1',
      items[0].detailUrl,
    )
    check('carries the resource type', items[0].type === 'novel')
  }

  console.log('search with JSONPath (API site)')
  {
    const source = makeSource({
      search: {
        url: 'https://api.example.com/search?q={{keyword}}',
        method: 'GET',
        list: '$.data.items[*]',
        fields: {
          title: '$.name',
          author: '$.author',
          cover: '$.cover',
          detailUrl: '$.url',
        },
      },
    })
    const fetcher = async () => ({
      status: 200,
      url: 'https://api.example.com/search?q=x',
      body: SEARCH_JSON,
    })
    const engine = new SourceEngine(source, fetcher)
    const items = await engine.search('x')

    check('reads json list', items.length === 2, `${items.length}`)
    check('reads json title', items[0].title === 'JSON 第一本', items[0].title)
    check('reads json author', items[0].author === '甲', items[0].author)
    check(
      'absolutises json cover',
      items[0].cover === 'https://api.example.com/c/1.jpg',
      items[0].cover,
    )
  }

  console.log('selectJsonObjects keeps structure')
  {
    const objects = selectJsonObjects(JSON.parse(SEARCH_JSON), '$.data.items[*]')
    check('returns objects not strings', typeof objects[0] === 'object')
    check('returns two', objects.length === 2)
    check('objects keep fields', objects[0].name === 'JSON 第一本')
  }

  console.log('detail')
  {
    const fetcher = async (url) => {
      if (url.includes('/book/')) return { status: 200, url, body: DETAIL_HTML }
      return { status: 200, url, body: SEARCH_HTML }
    }
    const engine = new SourceEngine(makeSource(), fetcher)
    const detail = await engine.detail('https://example.com/book/1')

    check('reads detail title', detail.title === '第一本', detail.title)
    check('reads detail intro', detail.intro === '这是一段简介', detail.intro)
    check('reads chapters', detail.chapters.length === 2, `${detail.chapters.length}`)
    check('chapter title', detail.chapters[0].title === '第一章', detail.chapters[0].title)
    check(
      'absolutises chapter url',
      detail.chapters[0].url === 'https://example.com/chapter/1',
      detail.chapters[0].url,
    )
  }

  console.log('detail with a separate toc page')
  {
    // Real sites often split the blurb and the chapter list across two pages.
    const DETAIL_ONLY = `<!doctype html><html><body>
      <h1 class="title">第一本</h1>
      <div class="intro">这是一段简介</div>
      <a class="toc-link" href="/toc/1/">目录</a>
    </body></html>`
    const TOC_ONLY = `<!doctype html><html><body>
      <ul class="chapters">
        <li><a href="/chapter/1">第一章</a></li>
        <li><a href="/chapter/2">第二章</a></li>
      </ul>
    </body></html>`

    const requested = []
    const fetcher = async (url) => {
      requested.push(url)
      return { status: 200, url, body: url.includes('/toc/') ? TOC_ONLY : DETAIL_ONLY }
    }

    const source = makeSource({
      detail: {
        list: 'css:ul.chapters li a',
        fields: { title: 'css:', url: 'css:@href' },
        title: 'css:h1.title',
        tocUrl: 'css:a.toc-link@href',
      },
    })
    const engine = new SourceEngine(source, fetcher)
    const detail = await engine.detail('https://example.com/book/1')

    check('fetched both pages', requested.length === 2, requested.join(' -> '))
    check('detail title from the detail page', detail.title === '第一本', detail.title)
    check('chapters came from the toc page', detail.chapters.length === 2, `${detail.chapters.length}`)
    check(
      'chapter urls resolve against the toc page',
      detail.chapters[0].url === 'https://example.com/chapter/1',
      detail.chapters[0].url,
    )
  }

  console.log('detail without tocUrl fetches once')
  {
    let requests = 0
    const fetcher = async (url) => {
      requests += 1
      return { status: 200, url, body: DETAIL_HTML }
    }
    const engine = new SourceEngine(makeSource(), fetcher)
    await engine.detail('https://example.com/book/1')
    check('single request when the list is inline', requests === 1, `${requests}`)
  }

  console.log('chapter')
  {
    const fetcher = async (url) => ({ status: 200, url, body: CHAPTER_HTML })
    const engine = new SourceEngine(makeSource(), fetcher)
    const text = await engine.chapter('https://example.com/chapter/1')

    check('extracts chapter text', text.includes('正文第一段'), text)
    check('includes both paragraphs', text.includes('正文第二段'), text)
  }

  console.log('paragraph structure is preserved')
  {
    const html = `<html><body>
      <div id="content">
        <p>第一段正文</p>
        <p>第二段正文</p>
        <p>第三段正文</p>
      </div>
    </body></html>`
    const fetcher = async (url) => ({ status: 200, url, body: html })
    const engine = new SourceEngine(makeSource(), fetcher)
    const text = await engine.chapter('https://example.com/c/1')

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    check('paragraphs stay on separate lines', lines.length === 3, JSON.stringify(lines))
    check('paragraph text intact', lines[0] === '第一段正文', lines[0])
    // A single collapsed blob would be the regression this guards against.
    check('no collapse into one line', !text.includes('第一段正文第二段正文'), text.slice(0, 60))
  }

  console.log('chapter pagination is followed')
  {
    const page1 = `<html><body><div id="content"><p>第一页的正文</p></div>
      <a href="/c/1_2.html" rel="next">下一页</a></body></html>`
    const page2 = `<html><body><div id="content"><p>第二页的正文</p></div>
      <a href="/c/1_3.html" rel="next">下一页</a></body></html>`
    const page3 = `<html><body><div id="content"><p>第三页的正文</p></div></body></html>`

    const requested = []
    const fetcher = async (url) => {
      requested.push(url)
      const body = url.endsWith('_2.html') ? page2 : url.endsWith('_3.html') ? page3 : page1
      return { status: 200, url, body }
    }
    const source = makeSource({
      chapter: { content: 'css:#content p', nextUrl: 'css:a[rel=next]@href' },
    })
    const engine = new SourceEngine(source, fetcher)
    const text = await engine.chapter('https://example.com/c/1.html')

    check('fetched all three pages', requested.length === 3, requested.join(' -> '))
    check('page 1 text present', text.includes('第一页的正文'), text)
    check('page 2 text present', text.includes('第二页的正文'), text)
    check('page 3 text present', text.includes('第三页的正文'), text)
    check('navigation text excluded', !text.includes('下一页'), text)
  }

  console.log('pagination cannot loop forever')
  {
    // A `next` link that always points back at itself must not hang the reader.
    const loop = `<html><body><div id="content"><p>正文</p></div>
      <a href="/c/1.html" rel="next">下一页</a></body></html>`
    let requests = 0
    const fetcher = async (url) => {
      requests += 1
      return { status: 200, url, body: loop }
    }
    const source = makeSource({
      chapter: { content: 'css:#content p', nextUrl: 'css:a[rel=next]@href' },
    })
    const engine = new SourceEngine(source, fetcher)
    const text = await engine.chapter('https://example.com/c/1.html')

    check('stops on a self-referencing link', requests === 1, `${requests} requests`)
    check('still returns the text', text.includes('正文'), text)
  }

  console.log('mismatched selector kinds are reported')
  {
    const source = makeSource({
      search: {
        url: 'https://example.com/s?q={{keyword}}',
        method: 'GET',
        list: '$.data.items[*]',
        fields: { title: '$.name', detailUrl: '$.url' },
      },
    })
    const fetcher = async () => ({ status: 200, url: 'https://example.com', body: SEARCH_HTML })
    const engine = new SourceEngine(source, fetcher)

    let message = ''
    try {
      await engine.search('x')
    } catch (error) {
      message = error.message
    }
    check('json list against html is an error', message.length > 0, message)
  }

  console.log('http error surfaces')
  {
    const fetcher = async () => {
      throw new Error('请求失败：500')
    }
    const engine = new SourceEngine(makeSource(), fetcher)
    let message = ''
    try {
      await engine.search('x')
    } catch (error) {
      message = error.message
    }
    check('propagates fetch failure', message.includes('500'), message)
  }

  console.log('')
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
