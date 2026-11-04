/**
 * Verifies EPUB package parsing: container → OPF → manifest/spine/metadata,
 * plus both TOC shapes (EPUB 3 nav document and EPUB 2 NCX).
 *
 * Run with: node scripts/verify-epub-package.mjs
 *
 * `package.ts` depends on `DOMParser`, which Node does not provide. A tiny
 * shim over a real XML parser would be a dependency, so this test uses a
 * purpose-built minimal XML DOM instead: enough of the API surface that
 * package.ts uses (localName, querySelectorAll('*'), getAttribute, children,
 * textContent) to exercise the parsing logic honestly.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

// --- minimal XML DOM ------------------------------------------------------

class MiniNode {
  constructor(name, attributes = {}) {
    this.nodeName = name
    this.localName = name
    this.attributes = Object.entries(attributes).map(([key, value]) => ({ name: key, value }))
    this.children = []
    this.parent = null
    this._text = ''
  }
  getAttribute(name) {
    return this.attributes.find((a) => a.name === name)?.value ?? null
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('')
  }
  /**
   * Descendant query. The real DOM exposes this on every Element as well as on
   * Document, and `package.ts` relies on that (it calls findAll on elements
   * like `nav` and `navPoint`), so the shim must too.
   */
  querySelectorAll() {
    return [...walk(this)]
  }
}

/** Parse a small, well-formed XML subset — enough for OPF/NCX/nav fixtures. */
function parseMiniXml(source) {
  const text = source.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const rootNode = new MiniNode('#document')
  const stack = [rootNode]
  const tagPattern = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  let lastIndex = 0
  let match

  while ((match = tagPattern.exec(text)) !== null) {
    const between = text.slice(lastIndex, match.index)
    if (between.trim()) stack[stack.length - 1]._text += between
    lastIndex = tagPattern.lastIndex

    const [, closing, rawName, attrText, selfClosing] = match
    // Namespaces are irrelevant to the code under test, which matches on local
    // names, so the prefix is stripped the same way the browser would.
    const name = rawName.replace(/^.*:/, '')

    if (closing) {
      if (stack.length > 1) stack.pop()
      continue
    }

    const attributes = {}
    const attrPattern = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let attrMatch
    while ((attrMatch = attrPattern.exec(attrText)) !== null) {
      attributes[attrMatch[1].replace(/^.*:/, '')] = attrMatch[2] ?? attrMatch[3] ?? ''
    }

    const node = new MiniNode(name, attributes)
    node.parent = stack[stack.length - 1]
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }

  return rootNode
}

/** Depth-first walk over a MiniNode tree. */
function* walk(node) {
  for (const child of node.children) {
    yield child
    yield* walk(child)
  }
}

function installDomParserShim() {
  globalThis.DOMParser = class {
    parseFromString(source) {
      const doc = parseMiniXml(source)
      // The code under test calls `findAll(doc, ...)`, which uses
      // querySelectorAll('*') and filters by localName.
      doc.querySelectorAll = () => [...walk(doc)]
      doc.querySelector = () => null
      return doc
    }
  }
}

// --- load the module under test -------------------------------------------

async function loadModule(relativePath) {
  const esbuildEntry = join(
    root,
    'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js',
  )
  const esbuild = require(esbuildEntry)
  const source = await readFile(join(root, relativePath), 'utf8')
  const { code } = await esbuild.transform(source, { loader: 'ts', format: 'esm' })
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  return import(dataUrl)
}

/** Fake archive backed by a plain map, so package.ts runs without ZIP logic. */
class FakeZip {
  constructor(files) {
    this.files = new Map(Object.entries(files))
  }
  has(name) {
    return this.files.has(name)
  }
  names() {
    return [...this.files.keys()]
  }
  async read(name) {
    const value = this.files.get(name)
    if (value === undefined) throw new Error(`missing ${name}`)
    return new TextEncoder().encode(value)
  }
  async text(name) {
    const value = this.files.get(name)
    if (value === undefined) throw new Error(`missing ${name}`)
    return value
  }
}

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

// --- fixtures -------------------------------------------------------------

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

/** EPUB 3: nav document, cover-image property, three spine items. */
const OPF3 = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title>
    <dc:creator>某作者</dc:creator>
    <dc:creator>另一位</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="rendition:layout">reflowable</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>`

const NAV3 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="text/ch1.xhtml">第一章</a></li>
        <li><a href="text/ch2.xhtml#sec2">第二章</a>
          <ol>
            <li><a href="text/ch2.xhtml#sec2-1">第二节之一</a></li>
          </ol>
        </li>
      </ol>
    </nav>
  </body>
</html>`

/** EPUB 2: NCX with nested navPoints, and no nav document. */
const OPF2 = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>旧书</dc:title>
    <dc:creator>老作者</dc:creator>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="p1" href="part1.xhtml" media-type="application/xhtml+xml"/>
    <item id="p2" href="part2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="images/old-cover.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="p1"/>
    <itemref idref="p2"/>
  </spine>
</package>`

const NCX2 = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>第一部分</text></navLabel>
      <content src="part1.xhtml"/>
      <navPoint id="n1-1" playOrder="2">
        <navLabel><text>第一章</text></navLabel>
        <content src="part1.xhtml#c1"/>
      </navPoint>
    </navPoint>
    <navPoint id="n2" playOrder="3">
      <navLabel><text>第二部分</text></navLabel>
      <content src="part2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`

/** Fixed layout with right-to-left page progression. */
const OPF_FXL = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>画册</dc:title>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:page-spread-direction">rtl</meta>
  </metadata>
  <manifest>
    <item id="p1" href="page1.xhtml" media-type="application/xhtml+xml"/>
    <item id="p2" href="page2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="p1"/>
    <itemref idref="p2"/>
  </spine>
</package>`

// --- tests ----------------------------------------------------------------

async function main() {
  installDomParserShim()
  const pkg = await loadModule('src/viewers/epub/package.ts')

  console.log('href resolution')
  {
    check(
      'sibling resolves against directory',
      pkg.resolveHref('OEBPS/content.opf', 'text/ch1.xhtml') === 'OEBPS/text/ch1.xhtml',
      pkg.resolveHref('OEBPS/content.opf', 'text/ch1.xhtml'),
    )
    check(
      'parent traversal',
      pkg.resolveHref('OEBPS/text/ch1.xhtml', '../images/a.png') === 'OEBPS/images/a.png',
      pkg.resolveHref('OEBPS/text/ch1.xhtml', '../images/a.png'),
    )
    check(
      'leading slash is archive-root',
      pkg.resolveHref('OEBPS/content.opf', '/OEBPS/x.css') === 'OEBPS/x.css',
      pkg.resolveHref('OEBPS/content.opf', '/OEBPS/x.css'),
    )
    const split = pkg.splitFragment('text/ch2.xhtml#sec2')
    check('fragment split', split.path === 'text/ch2.xhtml' && split.fragment === 'sec2')
    const noFragment = pkg.splitFragment('text/ch1.xhtml')
    check('no fragment', noFragment.path === 'text/ch1.xhtml' && noFragment.fragment === null)
  }

  console.log('EPUB 3 package')
  {
    const zip = new FakeZip({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': OPF3,
      'OEBPS/nav.xhtml': NAV3,
    })
    const opfPath = await pkg.readContainer(zip)
    check('container yields opf path', opfPath === 'OEBPS/content.opf', opfPath)

    const book = await pkg.readPackage(zip, opfPath)
    check('title', book.title === '测试之书', book.title)
    check('multiple creators joined', book.author === '某作者、另一位', book.author)
    check('language', book.language === 'zh-CN', book.language)
    check('spine excludes linear=no', book.spine.length === 2, book.spine.join(','))
    check(
      'spine hrefs absolute',
      book.spine[0] === 'OEBPS/text/ch1.xhtml' && book.spine[1] === 'OEBPS/text/ch2.xhtml',
      book.spine.join(','),
    )
    check('cover from properties', book.cover === 'OEBPS/images/cover.jpg', book.cover)
    check('reflowable not fixed', book.fixedLayout === false)

    check('toc parsed from nav', book.toc.length === 2, `${book.toc.length}`)
    check('toc label', book.toc[0]?.label === '第一章', book.toc[0]?.label)
    check('toc href absolute', book.toc[0]?.href === 'OEBPS/text/ch1.xhtml', book.toc[0]?.href)
    check('toc fragment', book.toc[1]?.fragment === 'sec2', book.toc[1]?.fragment)
    check('nested toc child', book.toc[1]?.children[0]?.label === '第二节之一', JSON.stringify(book.toc[1]))

    const flat = pkg.flattenToc(book.toc)
    check('flatten keeps depth', flat.length === 3 && flat[2].depth === 1, JSON.stringify(flat.map((f) => f.depth)))
  }

  console.log('EPUB 2 package (NCX)')
  {
    const zip = new FakeZip({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': OPF2,
      'OEBPS/toc.ncx': NCX2,
    })
    const book = await pkg.readPackage(zip, 'OEBPS/content.opf')
    check('title', book.title === '旧书', book.title)
    check('cover from meta name', book.cover === 'OEBPS/images/old-cover.png', book.cover)
    check('spine from opf2', book.spine.length === 2, book.spine.join(','))
    check('toc from ncx', book.toc.length === 2, `${book.toc.length}`)
    check('ncx label', book.toc[0]?.label === '第一部分', book.toc[0]?.label)
    check('ncx href', book.toc[0]?.href === 'OEBPS/part1.xhtml', book.toc[0]?.href)
    check('ncx nested', book.toc[0]?.children.length === 1, JSON.stringify(book.toc[0]))
    check('ncx nested label', book.toc[0]?.children[0]?.label === '第一章', book.toc[0]?.children[0]?.label)
    check('ncx nested fragment', book.toc[0]?.children[0]?.fragment === 'c1')
    check('second top-level node', book.toc[1]?.label === '第二部分', book.toc[1]?.label)
  }

  console.log('fixed layout')
  {
    const zip = new FakeZip({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': OPF_FXL,
    })
    const book = await pkg.readPackage(zip, 'OEBPS/content.opf')
    check('detected pre-paginated', book.fixedLayout === true)
    check('page direction rtl', book.pageDirection === 'rtl', book.pageDirection)
    check('no toc is fine', Array.isArray(book.toc) && book.toc.length === 0)
  }

  console.log('broken toc falls back')
  {
    const zip = new FakeZip({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': OPF2,
      // NCX missing entirely: parsing must not throw.
      'OEBPS/part1.xhtml': '<html/>',
    })
    const book = await pkg.readPackage(zip, 'OEBPS/content.opf')
    check('missing ncx yields empty toc', book.toc.length === 0)
    check('spine still intact', book.spine.length === 2)
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
