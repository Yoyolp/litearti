/**
 * End-to-end check of the EPUB pipeline against a real .epub byte stream.
 *
 * Run with: node scripts/verify-epub-e2e.mjs
 *
 * The unit tests cover the ZIP reader and the package parser separately. This
 * one exercises the seam between them: build a real archive, open it, parse it,
 * and prepare a chapter into the self-contained HTML string the iframe will
 * receive. The assertions are about that string — text present, images rewritten
 * to blob URLs, scripts and remote URLs gone, publisher CSS inlined.
 *
 * Node has no DOM, so a small DOM shim is installed. It implements exactly the
 * surface `resources.ts` uses (attributes, children, a few selectors, and
 * outerHTML serialisation) rather than pretending to be a browser.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

// --- ZIP builder ----------------------------------------------------------

function crc32(bytes) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let c = i
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c
    }
  }
  let crc = -1
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  return (crc ^ -1) >>> 0
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data
    const stored = entry.store === true
    const payload = stored ? data : await deflateRaw(data)
    const nameBytes = new TextEncoder().encode(entry.name)
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length + payload.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, stored ? 0 : 8, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, payload.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(payload, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, stored ? 0 : 8, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, payload.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)
    offset += local.length
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const out = new Uint8Array(offset + centralSize + eocd.length)
  let p = 0
  for (const local of locals) { out.set(local, p); p += local.length }
  for (const central of centrals) { out.set(central, p); p += central.length }
  out.set(eocd, p)
  return out
}

// --- bundling -------------------------------------------------------------

let workDir = null

/** Bundle a module (following its relative imports) into an importable file. */
async function loadModule(entryRelativePath) {
  const esbuildEntry = join(
    root,
    'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js',
  )
  const esbuild = require(esbuildEntry)
  const name = entryRelativePath.replace(/[\\/]/g, '_').replace(/\.ts$/, '')
  const outfile = join(workDir, `${name}.mjs`)
  await esbuild.build({
    entryPoints: [join(root, entryRelativePath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

// --- minimal DOM ----------------------------------------------------------

class Node {
  constructor(name, attrs = {}) {
    // The real DOM reports `localName` without the namespace prefix while
    // `nodeName` keeps it. The EPUB code matches on localName, so the shim has
    // to do the same or `dc:title` would never match `title`.
    this.nodeName = name
    this.localName = name.replace(/^.*:/, '')
    this.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }))
    this.children = []
    this.childNodes = []
    this.parent = null
    this._text = ''
  }
  getAttribute(name) {
    return this.attributes.find((a) => a.name === name)?.value ?? null
  }
  setAttribute(name, value) {
    const found = this.attributes.find((a) => a.name === name)
    if (found) found.value = String(value)
    else this.attributes.push({ name, value: String(value) })
  }
  removeAttribute(name) {
    this.attributes = this.attributes.filter((a) => a.name !== name)
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this
      this.children.push(node)
      this.childNodes.push(node)
    }
  }
  appendChild(node) {
    this.append(node)
    return node
  }
  replaceChildren(...nodes) {
    this.children = []
    this.childNodes = []
    this.append(...nodes)
  }
  replaceWith(...nodes) {
    const parent = this.parent
    if (!parent) return
    const index = parent.children.indexOf(this)
    if (index < 0) return
    for (const node of nodes) node.parent = parent
    parent.children.splice(index, 1, ...nodes)
    const ci = parent.childNodes.indexOf(this)
    if (ci >= 0) parent.childNodes.splice(ci, 1, ...nodes)
  }
  remove() {
    this.replaceWith()
  }
  get isConnected() {
    let node = this
    while (node.parent) node = node.parent
    return node.localName === '#document'
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('')
  }
  set textContent(value) {
    this.children = []
    this.childNodes = []
    this._text = String(value)
  }
  get id() {
    return this.getAttribute('id')
  }
  /** Serialise this node and its subtree, the way a browser would. */
  get outerHTML() {
    if (this.localName === '#document') {
      return this.children.map((c) => c.outerHTML).join('')
    }
    const attrs = this.attributes
      .map((a) => ` ${a.name}="${String(a.value).replace(/"/g, '&quot;')}"`)
      .join('')
    const inner = this._text + this.children.map((c) => c.outerHTML).join('')
    if (VOID_TAGS.has(this.localName)) return `<${this.localName}${attrs}>`
    return `<${this.localName}${attrs}>${inner}</${this.localName}>`
  }
  /** Selector support limited to what resources.ts uses. */
  querySelectorAll(selector) {
    const matches = compileSelector(selector)
    return [...walk(this)].filter(matches)
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
  getElementById(id) {
    return [...walk(this)].find((n) => n.getAttribute('id') === id) ?? null
  }
  closest() {
    return null
  }
}

const VOID_TAGS = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'source', 'area', 'base'])

class Document extends Node {
  constructor() {
    super('#document')
    this.head = new Node('head')
    this.body = new Node('body')
    this.documentElement = new Node('html')
    this.documentElement.append(this.head, this.body)
    this.append(this.documentElement)
  }
  createElement(name) {
    return new Node(name)
  }
}

function* walk(node) {
  for (const child of node.children) {
    yield child
    yield* walk(child)
  }
}

/** Compile the small selector subset used by the EPUB code. */
function compileSelector(selector) {
  const raw = selector.trim()
  if (raw === '*') return () => true

  // tag[attr="value"] | tag[attr] | [attr="value"] | tag
  const match = /^([\w-]*)(?:\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/.exec(raw)
  if (!match) throw new Error(`shim does not support selector: ${selector}`)
  const [, tag, attr, value] = match

  return (node) => {
    if (tag && node.localName !== tag) return false
    if (attr) {
      const actual = node.getAttribute(attr)
      if (actual === null) return false
      if (value !== undefined && actual !== value) return false
    }
    return true
  }
}

/**
 * Parse a small, well-formed XHTML document.
 *
 * Deliberately naive: the fixtures are hand-written, and a real parser is a
 * dependency this test does not need. It only has to produce the same tree
 * shape that `prepareChapter` expects to walk.
 */
function parseHtml(source) {
  const doc = new Document()
  const body = doc.body
  const head = doc.head
  // Comments, doctype and processing instructions carry no structure here.
  const text = source
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  const tagPattern = /<(\/?)([A-Za-z_][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  let stack = [body]
  let last = 0
  let match

  while ((match = tagPattern.exec(text)) !== null) {
    const between = text.slice(last, match.index)
    if (between) stack[stack.length - 1]._text += decodeEntities(between)
    last = tagPattern.lastIndex

    const [, closing, rawName, attrText, selfClosing] = match
    const name = rawName.toLowerCase()
    // Closing tags must be compared against `localName`, which has the
    // namespace prefix stripped — `</dc:title>` closes the `title` node.
    const local = name.replace(/^.*:/, '')

    if (closing) {
      // Pop to the matching open tag; tolerate mismatches.
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].localName === local) {
          stack.length = i
          break
        }
      }
      continue
    }

    if (local === 'html') continue
    if (local === 'head') { stack = [head]; continue }
    if (local === 'body') { stack = [body]; continue }

    const attrs = {}
    const attrPattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let am
    while ((am = attrPattern.exec(attrText)) !== null) {
      attrs[am[1]] = decodeEntities(am[2] ?? am[3] ?? '')
    }

    const node = new Node(name, attrs)
    stack[stack.length - 1].append(node)
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(node)
  }

  return doc
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function installDomShim() {
  globalThis.DOMParser = class {
    parseFromString(source) {
      return parseHtml(source)
    }
  }
  globalThis.CSS = { escape: (value) => String(value).replace(/[^\w-]/g, '\\$&') }
}

// --- fixtures -------------------------------------------------------------

const CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>第一章</title>
    <link rel="stylesheet" href="../styles/book.css"/>
    <script src="evil.js">alert('removed')</script>
  </head>
  <body>
    <h1>第一章 开始</h1>
    <p>这是正文的第一段，含中文与标点。</p>
    <p><img src="../images/pic.png" alt="插图"/></p>
    <p><a href="ch2.xhtml#note">跳到第二章</a></p>
    <p><a href="https://example.com/away">外部链接</a></p>
    <p onclick="alert('x')">带内联事件的段落</p>
  </body>
</html>`

const CSS = `body { font-family: "Some Publisher Font"; color: #222; }
.cover { background: url(../images/pic.png); }
.remote { background: url(https://tracker.example/pixel.png); }
@import "extra.css";`

const EXTRA_CSS = `p { text-indent: 2em; }`

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>端到端测试书</dc:title>
    <dc:creator>测试</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><nav epub:type="toc"><ol>
    <li><a href="text/ch1.xhtml">第一章</a></li>
    <li><a href="text/ch2.xhtml">第二章</a></li>
  </ol></nav></body>
</html>`

const CHAPTER2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body><h1>第二章</h1><p id="note">注脚内容</p></body>
</html>`

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

// --- tests ----------------------------------------------------------------

async function main() {
  workDir = await mkdtemp(join(tmpdir(), 'litearti-epub-'))
  installDomShim()

  const zipModule = await loadModule('src/viewers/epub/zip.ts')
  const pkgModule = await loadModule('src/viewers/epub/package.ts')
  const resModule = await loadModule('src/viewers/epub/resources.ts')

  const epubBytes = await buildZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/nav.xhtml', data: NAV },
    { name: 'OEBPS/text/ch1.xhtml', data: CHAPTER },
    { name: 'OEBPS/text/ch2.xhtml', data: CHAPTER2 },
    { name: 'OEBPS/styles/book.css', data: CSS },
    { name: 'OEBPS/styles/extra.css', data: EXTRA_CSS },
    { name: 'OEBPS/images/pic.png', data: PNG },
  ])

  console.log('open a real epub')
  const zip = zipModule.ZipArchive.open(epubBytes)
  check('archive opens', zip.names().length === 9, zip.names().join(','))

  const opfPath = await pkgModule.readContainer(zip)
  const book = await pkgModule.readPackage(zip, opfPath)
  check('title read', book.title === '端到端测试书', book.title)
  check('spine has 2 chapters', book.spine.length === 2, book.spine.join(','))
  check('toc has 2 entries', book.toc.length === 2, `${book.toc.length}`)

  console.log('prepare chapter (original mode)')
  const resources = new resModule.ResourceStore(zip)
  const original = await resModule.prepareChapter(zip, resources, 'OEBPS/text/ch1.xhtml', {
    reflow: false,
    themeCss: '',
  })
  const html = original.html

  check('produces full document', html.startsWith('<!doctype html>'), html.slice(0, 40))
  check('body text survives', html.includes('这是正文的第一段'))
  check('script tag removed', !/<script/i.test(html), 'script leaked')
  check('inline handler removed', !/onclick/i.test(html), 'onclick leaked')
  check('remote anchor stripped', !html.includes('example.com/away'), 'remote anchor kept')
  check('publisher css inlined', html.includes('Some Publisher Font'), 'css missing')
  check('@import inlined', html.includes('text-indent'), 'imported css missing')
  check('remote css url neutralised', !html.includes('tracker.example'), 'remote url kept')
  check('image rewritten to blob', html.includes('blob:'), 'no blob url')
  check('internal link marked', html.includes('data-epub-href'), 'anchor not marked')
  check('no raw relative img src', !html.includes('src="../images/pic.png"'), 'relative src kept')

  console.log('prepare chapter (reflow mode)')
  const reflow = await resModule.prepareChapter(zip, resources, 'OEBPS/text/ch1.xhtml', {
    reflow: true,
    themeCss: 'html { font-size: 17px; }',
  })
  const reflowHtml = reflow.html
  check('reflow keeps text', reflowHtml.includes('这是正文的第一段'))
  check('reflow keeps heading structure', /<h1/i.test(reflowHtml), 'h1 lost')
  check('reflow drops publisher font', !reflowHtml.includes('Some Publisher Font'))
  check('reflow keeps theme css', reflowHtml.includes('font-size: 17px'))
  check('reflow keeps image', reflowHtml.includes('blob:'), 'image lost')
  check('reflow drops script', !/<script/i.test(reflowHtml))

  console.log('prepare second chapter')
  const second = await resModule.prepareChapter(zip, resources, 'OEBPS/text/ch2.xhtml', {
    reflow: false,
    themeCss: '',
  })
  check('second chapter renders', second.html.includes('注脚内容'))

  console.log('resource cache')
  {
    const url1 = await resources.url('OEBPS/images/pic.png')
    const url2 = await resources.url('OEBPS/images/pic.png')
    check('same path returns cached url', url1 === url2, `${url1} vs ${url2}`)
    const missing = await resources.url('OEBPS/images/nope.png')
    check('missing resource is null', missing === null)
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
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })
