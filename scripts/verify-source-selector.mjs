/**
 * Verifies the selector engine: JSONPath subset and CSS extraction.
 *
 * Run with: node scripts/verify-source-selector.mjs
 *
 * The JSONPath subset is small but has sharp edges (wildcards on objects vs
 * arrays, numeric indices, the difference between "no match" and "match that is
 * not a scalar"), so each is pinned here.
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

/** Minimal DOM for CSS selectors: enough for the selectors this project uses. */
function installDomShim() {
  class El {
    constructor(name, attrs = {}) {
      this.localName = name
      this.nodeName = name
      this.attributes = Object.entries(attrs).map(([n, v]) => ({ name: n, value: v }))
      this.children = []
      this.parent = null
      this._text = ''
    }
    getAttribute(n) {
      return this.attributes.find((a) => a.name === n)?.value ?? null
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('')
    }
    /** Selector support limited to: tag, .class, #id, [attr], and descendants. */
    matches(selector) {
      const parts = selector.trim().split(/\s+/)
      return matchesChain(this, parts, parts.length - 1)
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
    // Descendant combinator: any ancestor may satisfy the rest.
    let ancestor = node.parent
    while (ancestor) {
      if (matchesChain(ancestor, parts, index - 1)) return true
      ancestor = ancestor.parent
    }
    return index === 0
  }

  function matchesSimple(node, simple) {
    if (!simple) return true
    // `:first-child` and similar pseudo classes are not supported; the fixtures
    // do not need them and pretending otherwise would be a false test.
    if (simple.includes(':')) throw new Error(`shim does not support pseudo-class: ${simple}`)

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
      const body = new El('body')
      doc.children.push(body)
      body.parent = doc

      const text = html
        .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
      const re = /<(\/?)([A-Za-z_][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
      let stack = [body]
      let last = 0
      let m
      while ((m = re.exec(text)) !== null) {
        const between = text.slice(last, m.index)
        if (between) stack[stack.length - 1]._text += between
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
        node.parent = stack[stack.length - 1]
        stack[stack.length - 1].children.push(node)
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
  const dir = await mkdtemp(join(root, 'node_modules/.tmp/verify-selector-'))
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    entryPoints: [join(root, relativePath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent',
  })
  const module_ = await import(pathToFileURL(outfile).href)
  await rm(dir, { recursive: true, force: true })
  return module_
}

const SAMPLE_JSON = {
  data: {
    total: 2,
    items: [
      { name: '第一本', author: '作者甲', tags: ['玄幻', '连载'] },
      { name: '第二本', author: '作者乙', tags: ['都市'] },
    ],
  },
}

const SAMPLE_HTML = `<html><body>
  <ul class="book-list">
    <li class="book"><a class="title" href="/book/1">第一本</a><span class="author">作者甲</span><img src="/c/1.jpg"/></li>
    <li class="book"><a class="title" href="/book/2">第二本</a><span class="author">作者乙</span><img src="/c/2.jpg"/></li>
  </ul>
  <div id="content"><p>正文第一段</p><p>正文第二段</p></div>
</body></html>`

async function main() {
  installDomShim()
  const { selectJson, selectCss, selectOne, selectCssElements, selectFromElement, parseJsonPath, SelectorError } =
    await loadModule('src/sources/selector.ts')

  console.log('jsonpath parsing')
  {
    check('parses a simple path', parseJsonPath('$.a.b').length === 2)
    check('parses an index', parseJsonPath('$.a[0].b').length === 3)
    check('parses a wildcard', parseJsonPath('$.a[*]').length === 2)
    check('parses a quoted key', parseJsonPath('$["a-b"]').length === 1)

    const rejects = (path, label) => {
      let threw = false
      try {
        parseJsonPath(path)
      } catch (error) {
        threw = error instanceof SelectorError
      }
      check(label, threw, path)
    }
    rejects('a.b', 'rejects path without $')
    rejects('$..a', 'rejects recursive descent')
    rejects('$.a[?(@.x)]', 'rejects filter expression')
    rejects('$.a[1:3]', 'rejects slice')
  }

  console.log('jsonpath evaluation')
  {
    check('reads a scalar', selectJson(SAMPLE_JSON, '$.data.total')[0] === '2')
    check('reads nested string', selectJson(SAMPLE_JSON, '$.data.items[0].name')[0] === '第一本')
    check('wildcard over array', selectJson(SAMPLE_JSON, '$.data.items[*].name').length === 2)
    check(
      'wildcard preserves order',
      selectJson(SAMPLE_JSON, '$.data.items[*].name').join(',') === '第一本,第二本',
    )
    check(
      'joins scalar arrays',
      selectJson(SAMPLE_JSON, '$.data.items[0].tags')[0] === '玄幻 / 连载',
    )
    check('no match returns empty', selectJson(SAMPLE_JSON, '$.data.nope').length === 0)
    check('index out of range is empty', selectJson(SAMPLE_JSON, '$.data.items[99].name').length === 0)
    // A path landing on an object is a source mistake; it must not render as
    // "[object Object]".
    check('object match yields nothing', selectJson(SAMPLE_JSON, '$.data.items[0]').length === 0)
    check('missing intermediate is empty', selectJson(SAMPLE_JSON, '$.x.y.z').length === 0)
  }

  console.log('css evaluation')
  {
    check('selects by class', selectCss(SAMPLE_HTML, 'css:.title')[0] === '第一本')
    check('returns all matches', selectCss(SAMPLE_HTML, 'css:.title', true).length === 2)
    check('selects by id', selectCss(SAMPLE_HTML, 'css:#content p', true).join('|') === '正文第一段|正文第二段')
    check('attribute selector extracts href', selectCss(SAMPLE_HTML, 'css:a.title@href')[0] === '/book/1')
    check('attribute selector extracts src', selectCss(SAMPLE_HTML, 'css:img@src')[0] === '/c/1.jpg')
    check('selectOne returns first', selectOne(SAMPLE_HTML, 'css:.author') === '作者甲')
    check('no match is null', selectOne(SAMPLE_HTML, 'css:.nothing') === null)

    // A bare `css:` is legal: it addresses the document body. That is what lets
    // a chapter whose content is the whole page be expressed without a magic
    // selector, and it is the form used for "this element" inside list items.
    // (The body-text case needs a real DOMParser to have `doc.body`; the shim
    // here only supports element-scoped forms, which is where it is used.)
    check(
      'bare css: is accepted, not rejected',
      (() => {
        try {
          selectCss(SAMPLE_HTML, 'css:')
          return true
        } catch {
          return false
        }
      })(),
    )
  }

  console.log('per-element extraction (list items)')
  {
    const elements = selectCssElements(SAMPLE_HTML, 'css:.book')
    check('finds list elements', elements.length === 2)
    check('extracts title within element', selectFromElement(elements[0], 'css:.title') === '第一本')
    check('extracts href within element', selectFromElement(elements[0], 'css:a@href') === '/book/1')
    check('extracts author within element', selectFromElement(elements[1], 'css:.author') === '作者乙')
    check('missing field within element is null', selectFromElement(elements[0], 'css:.nope') === null)
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
