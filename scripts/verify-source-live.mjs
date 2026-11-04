/**
 * Live end-to-end test of a book source against the real site.
 *
 * Run with: node scripts/verify-source-live.mjs [path/to/source.json]
 *
 * This is the only test that touches the network, and it is deliberately not
 * part of the default suite: sites change, go down, and rate-limit. It exists to
 * answer one question when a source is written — "does this actually work
 * against the site today?" — rather than to guard a build.
 *
 * The engine talks HTTP through an injected fetcher, so this substitutes a
 * Node `fetch` implementation for the Rust command. Everything downstream
 * (template filling, selector evaluation, pagination following) is the real
 * code the app runs.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

/**
 * A DOM sufficient for the source's selectors.
 *
 * The engine needs real `querySelectorAll` semantics (attribute selectors,
 * sibling combinator `~`, `:first-child`), so a hand-rolled matcher would test
 * the matcher rather than the source. This builds just enough of a parser for
 * the pages involved and supports the selector forms used.
 */
function installDom() {
  /**
   * A text node. Real DOMs hold text as nodes, and `blockText` walks
   * `childNodes` looking for `nodeType === 3`. Storing text on the parent
   * instead would make paragraph extraction look broken here while working in
   * the app — the test would be lying.
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
      this.attributes = Object.entries(attrs).map(([n, v]) => ({ name: n, value: v }))
      this.children = []
      this.childNodes = []
      this.parent = null
      this.nodeType = 1
    }
    getAttribute(n) {
      const found = this.attributes.find((a) => a.name === n)
      return found === undefined ? null : found.value
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('')
    }
    querySelectorAll(sel) {
      const groups = splitTopLevel(sel)
      return [...walk(this)].filter((node) => groups.some((g) => matchesSelector(node, g)))
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null
    }
  }

  function splitTopLevel(sel) {
    // Split on top-level commas only (not inside brackets/parens).
    const out = []
    let depth = 0
    let current = ''
    for (const ch of sel) {
      if (ch === '[' || ch === '(') depth += 1
      if (ch === ']' || ch === ')') depth -= 1
      if (ch === ',' && depth === 0) {
        out.push(current.trim())
        current = ''
        continue
      }
      current += ch
    }
    if (current.trim()) out.push(current.trim())
    return out
  }

  /** Match a complex selector: sequence of compound selectors + combinators. */
  function matchesSelector(node, selector) {
    const tokens = tokenize(selector)
    return matchFrom(node, tokens, tokens.length - 1)
  }

  function tokenize(selector) {
    const tokens = []
    let current = ''
    let depth = 0
    for (const ch of selector) {
      if (ch === '[' || ch === '(') depth += 1
      if (ch === ']' || ch === ')') depth -= 1
      if (depth === 0 && (ch === ' ' || ch === '>' || ch === '~' || ch === '+')) {
        if (current) {
          tokens.push(current)
          current = ''
        }
        if (ch !== ' ') tokens.push(ch)
        continue
      }
      current += ch
    }
    if (current) tokens.push(current)
    return tokens
  }

  function matchFrom(node, tokens, index) {
    if (index < 0) return true
    const token = tokens[index]

    // Combinator sitting between compound selectors.
    if (token === '~' || token === '+' || token === '>') {
      const leftIndex = index - 1
      if (leftIndex < 0) return false
      let sibling = node.parent
      if (token === '>') {
        return node.parent ? matchFrom(node.parent, tokens, leftIndex) : false
      }
      if (token === '+') {
        const siblings = node.parent ? node.parent.children : []
        const at = siblings.indexOf(node)
        return at > 0 ? matchFrom(siblings[at - 1], tokens, leftIndex) : false
      }
      // `~` — any preceding sibling must match the left-hand compound.
      const siblings = node.parent ? node.parent.children : []
      for (let i = siblings.indexOf(node) - 1; i >= 0; i -= 1) {
        if (matchFrom(siblings[i], tokens, leftIndex)) return true
      }
      return false
    }

    if (!matchCompound(node, token)) return false
    // Walk up for descendant combinator (the token before is not a combinator).
    const prev = index - 1
    if (prev < 0) return true
    const prevToken = tokens[prev]
    if (prevToken === '~' || prevToken === '+' || prevToken === '>') {
      return matchFrom(node, tokens, index - 1)
    }
    let ancestor = node.parent
    while (ancestor) {
      if (matchFrom(ancestor, tokens, prev)) return true
      ancestor = ancestor.parent
    }
    return false
  }

  function matchCompound(node, compound) {
    if (!node || node.nodeType !== 1) return false
    let rest = compound

    // Pseudo-classes used by book sources: :first-child, :last-child, :nth-child(n).
    const pseudo = /:(first-child|last-child|nth-child\((\d+)\))/.exec(rest)
    if (pseudo) {
      const siblings = node.parent ? node.parent.children : []
      const at = siblings.indexOf(node)
      if (pseudo[1] === 'first-child' && at !== 0) return false
      if (pseudo[1] === 'last-child' && at !== siblings.length - 1) return false
      if (pseudo[2] !== undefined && at !== Number(pseudo[2]) - 1) return false
      rest = rest.replace(pseudo[0], '')
    }

    const attr = /\[([\w-]+)(?:([~|^$*]?=)["']?([^"'\]]*)["']?)?\]/.exec(rest)
    if (attr) {
      const value = node.getAttribute(attr[1])
      if (value === null) return false
      const [, , op, expected] = attr
      if (op === '=' && value !== expected) return false
      if (op === '^=' && !value.startsWith(expected)) return false
      if (op === '$=' && !value.endsWith(expected)) return false
      if (op === '*=' && !value.includes(expected)) return false
      rest = rest.replace(attr[0], '')
    }

    const id = /#([\w-]+)/.exec(rest)
    if (id) {
      if (node.getAttribute('id') !== id[1]) return false
      rest = rest.replace(id[0], '')
    }

    const cls = /\.([\w-]+)/.exec(rest)
    if (cls) {
      const classes = (node.getAttribute('class') ?? '').split(/\s+/)
      if (!classes.includes(cls[1])) return false
      rest = rest.replace(cls[0], '')
    }

    const tag = rest.trim().toLowerCase()
    if (tag && tag !== '*') return node.localName === tag
    return true
  }

  function* walk(node) {
    for (const child of node.children) {
      yield child
      yield* walk(child)
    }
  }

  function parse(html) {
    const doc = new El('#document')
    doc.nodeType = 9
    const head = new El('head')
    const body = new El('body')
    head.parent = doc
    body.parent = doc
    doc.children.push(head, body)
    doc.childNodes.push(head, body)

    const text = html
      .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')

    const re = /<(\/?)([A-Za-z_][\w:-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*)\s*(\/?)>/g
    let stack = [body]
    let last = 0
    let m

    while ((m = re.exec(text)) !== null) {
      const between = text.slice(last, m.index)
      if (between) {
        // Text becomes a real node, so `blockText` can see it.
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
      if (name === 'html') continue
      if (name === 'head') {
        stack = [head]
        continue
      }
      if (name === 'body') {
        stack = [body]
        continue
      }

      const attrs = {}
      const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
      let am
      while ((am = ar.exec(attrText)) !== null) attrs[am[1]] = am[2] ?? am[3] ?? am[4] ?? ''

      const node = new El(name, attrs)
      const parent = stack[stack.length - 1]
      node.parent = parent
      parent.children.push(node)
      parent.childNodes.push(node)

      const VOID = ['br', 'img', 'hr', 'meta', 'link', 'input', 'source', 'area', 'base', 'col']
      if (!selfClosing && !VOID.includes(name)) stack.push(node)
    }

    // `<meta>` lives in head but the naive walker puts it wherever it appears;
    // meta tags before <body> are the ones a source reads, so hoist them.
    return doc
  }

  globalThis.DOMParser = class {
    parseFromString(html) {
      return parse(html)
    }
  }
}

/** Load the engine + selector modules as one bundle (shared registry). */
async function loadModules(paths) {
  const esbuild = require(
    join(root, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'),
  )
  const dir = await mkdtemp(join(root, 'node_modules/.tmp/verify-live-'))
  const entry = join(dir, 'entry.ts')
  await (await import('node:fs/promises')).writeFile(
    entry,
    paths.map((p) => `export * from ${JSON.stringify(join(root, p).replace(/\\/g, '/'))}`).join('\n'),
    'utf8',
  )
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent',
    external: ['@tauri-apps/api/core', '@tauri-apps/plugin-dialog'],
  })
  const mod = await import(pathToFileURL(outfile).href)
  await rm(dir, { recursive: true, force: true })
  return mod
}

/** Node fetch with the source's headers, honouring the requested method. */
function makeFetcher(source) {
  return async (url, _source, options) => {
    const method = options?.method ?? 'GET'
    const init = {
      method,
      headers: { ...source.request.headers },
      redirect: 'follow',
    }
    if (method === 'POST' && options?.body) {
      init.body = options.body
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    const response = await fetch(url, init)
    const text = await response.text()
    return { status: response.status, url: response.url || url, body: text }
  }
}

async function main() {
  installDom()

  const sourcePath = process.argv[2] ?? join(root, 'sources/bqg5555.json')
  const raw = JSON.parse(await readFile(sourcePath, 'utf8'))

  const mod = await loadModules([
    'src/sources/schema.ts',
    'src/sources/selector.ts',
    'src/sources/engine.ts',
  ])

  console.log('validate')
  const validation = mod.validateSource(raw)
  check('source passes the validator', validation.ok === true, JSON.stringify(validation.issues))
  if (!validation.ok) {
    process.exit(1)
  }
  const source = validation.source

  const engine = new mod.SourceEngine(source, makeFetcher(source))

  console.log('search (live POST)')
  const keyword = process.argv[3] ?? '斗破'
  const items = await engine.search(keyword)
  check('search returned results', items.length > 0, `${items.length} items`)
  if (items.length) {
    check('titles are non-empty', items.every((i) => i.title && i.title.length > 0))
    check(
      'detail urls are absolute',
      items.every((i) => i.detailUrl.startsWith('https://')),
      items[0].detailUrl,
    )
    check(
      'header row was skipped (no "作品名称")',
      !items.some((i) => i.title.includes('作品名称')),
      JSON.stringify(items.slice(0, 3).map((i) => i.title)),
    )
    const withAuthor = items.filter((i) => i.author)
    check('authors extracted', withAuthor.length > 0, `${withAuthor.length}/${items.length}`)
    console.log(`       first 3: ${items.slice(0, 3).map((i) => `${i.title} / ${i.author ?? '?'}`).join(' | ')}`)
  }

  console.log('cover enrichment (search listing has no image)')
  {
    const first = items[0]
    if (first) {
      const hasListingCover = items.some((i) => i.cover)
      console.log(`       listing provided covers for ${items.filter((i) => i.cover).length}/${items.length} items`)
      const cover = await engine.cover(first.detailUrl).catch(() => null)
      // The browse view relies on this to satisfy "every card shows a cover".
      check('cover fetched from detail page', !!cover && cover.startsWith('http'), String(cover))
      if (hasListingCover) {
        console.log('       (this site also exposes covers in the listing)')
      }
      console.log(`       cover: ${cover}`)
    }
  }

  console.log('detail (live)')
  /**
   * Some search results point at books whose detail page is empty — the site
   * keeps the listing after removing the content. A real reader picks one that
   * opens, so the test walks the first few results instead of assuming the
   * first is usable.
   */
  let target = null
  let detail = null
  let tried = 0
  for (const candidate of items.slice(0, 6)) {
    tried += 1
    const attempt = await engine.detail(candidate.detailUrl).catch(() => null)
    if (attempt && attempt.chapters.length > 0) {
      target = candidate
      detail = attempt
      break
    }
  }
  console.log(`       tried ${tried} result(s) before finding one with chapters`)

  if (!detail) {
    check('detail reachable', false, `no usable detail page among the first ${tried} results`)
  } else {
    check('detail title', !!detail.title && detail.title !== '未命名', detail.title)
    check('detail author', !!detail.author, detail.author)
    check('detail cover', !!detail.cover && detail.cover.startsWith('http'), detail.cover)
    check('detail intro', !!detail.intro && detail.intro.length > 10, (detail.intro ?? '').slice(0, 60))
    check('chapters found', detail.chapters.length > 5, `${detail.chapters.length}`)
    check(
      'chapter urls absolute',
      detail.chapters.every((c) => c.url.startsWith('https://')),
      detail.chapters[0]?.url,
    )
    // The full chapter list must not include the "latest chapters" block, which
    // would duplicate entries. All chapter links share one URL prefix per book.
    const prefixes = new Set(detail.chapters.map((c) => c.url.replace(/\/\d+\.html$/, '')))
    check('chapters come from one book', prefixes.size === 1, [...prefixes].join(', '))
    console.log(`       ${detail.title} / ${detail.author} / ${detail.chapters.length} 章`)
    console.log(`       cover: ${detail.cover}`)
    console.log(`       first chapter: ${detail.chapters[0].title}`)

    console.log('chapter (live, with pagination)')
    const first = detail.chapters[0]
    if (first) {
      const text = await engine.chapter(first.url)
      check('chapter has text', text.length > 100, `${text.length} chars`)

      // Paragraph breaks must survive: a chapter rendered as one line is
      // technically "text" but useless to read.
      const lines = text.split('\n').filter((l) => l.trim())
      check('paragraphs preserved', lines.length > 3, `${lines.length} lines`)

      check(
        'pagination markup not leaked into text',
        !text.includes('本章未完') && !text.includes('点击下一页'),
        text.slice(-200),
      )
      console.log(`       ${first.title}: ${text.length} chars, ${lines.length} paragraphs`)
      console.log(`       first line: ${lines[0]?.slice(0, 50)}`)
      console.log(`       last line:  ${lines[lines.length - 1]?.slice(0, 50)}`)

      /**
       * Pagination needs a chapter that is actually split — the opening
       * chapters of a book are often single short pages, and some books are
       * short throughout. Sample one book, then fall back to a second book
       * before giving up: the point is to exercise the following logic against
       * a real split page, not to prove a particular book is long.
       */
      const fetcher = makeFetcher(source)

      async function findSplitChapter(book, indices) {
        for (const index of indices) {
          const chapter = book.chapters[index]
          if (!chapter) continue
          const page = await fetcher(chapter.url, source, { method: 'GET' }).catch(() => null)
          if (!page) continue
          // Attribute order varies between sites (`href` before or after
          // `rel`), so test for the token, not for a specific arrangement.
          const hasNext = /<a\b[^>]*\brel=["']?next\b/i.test(page.body)
          if (hasNext) return { chapter, page }
        }
        return null
      }

      let split = await findSplitChapter(
        detail,
        detail.chapters.map((_, i) => i).filter((i) => i % 5 === 0).slice(0, 12),
      )

      if (!split) {
        // Second book: the first search result that opens and differs.
        for (const candidate of items.slice(0, 4)) {
          if (candidate.detailUrl === target.detailUrl) continue
          const other = await engine.detail(candidate.detailUrl).catch(() => null)
          if (!other || !other.chapters.length) continue
          split = await findSplitChapter(other, [...Array(Math.min(6, other.chapters.length)).keys()])
          if (split) {
            console.log(`       (using a second book for the pagination check: ${other.title})`)
            break
          }
        }
      }

      if (!split) {
        // Last resort: another keyword, whose results are different books. Some
        // books never split their chapters; without this the run would silently
        // never exercise the pagination path.
        const altItems = await engine.search('海贼').catch(() => [])
        for (const candidate of altItems.slice(0, 3)) {
          const other = await engine.detail(candidate.detailUrl).catch(() => null)
          if (!other || !other.chapters.length) continue
          split = await findSplitChapter(other, [...Array(Math.min(6, other.chapters.length)).keys()])
          if (split) {
            console.log(`       (using "${candidate.title}" for the pagination check)`)
            break
          }
        }
      }

      if (split) {
        const pageOneText = mod.selectCss(split.page.body, 'css:#content')[0] ?? ''
        const full = await engine.chapter(split.chapter.url)
        check(
          'pagination followed (full text longer than page one)',
          full.length > pageOneText.length,
          `${full.length} vs ${pageOneText.length}`,
        )
        check(
          'multi-page chapter has no page-one marker',
          !full.includes('本章未完'),
          full.slice(-120),
        )
        console.log(
          `       ${split.chapter.title}: page1 ${pageOneText.length} chars -> combined ${full.length} chars`,
        )
      } else {
        console.log('  skip  no split chapter found in the sampled books (nothing to verify)')
      }
    }
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
