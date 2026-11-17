/**
 * Selector evaluation.
 *
 * Three syntaxes, chosen by prefix:
 *
 *   `$.a.b[0].c`        simplified JSONPath, for JSON APIs
 *   `css:.book .title`  CSS selector, for HTML pages
 *   `@js:<expr>`        JS expression, run in the sandbox
 *
 * The JSONPath subset is deliberately small. A full implementation is a parser
 * with filters, wildcards, slices and unions; a book source needs "walk into
 * this path and give me the values", which is what this does. Being small is
 * what makes it auditable and testable.
 *
 * Supported: `$.a.b`, `$.a[0]`, `$.a[*]`, `$.a[*].b`, `$.a.b[*]`.
 * Not supported: filters `[?()]`, recursive descent `..`, slices `[1:3]`,
 * unions `[a,b]`. Those return an error that says so, rather than silently
 * producing nothing.
 */

/** A value a selector can yield: one or many. */
export type SelectResult = string[]

export class SelectorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectorError'
  }
}

/** Whether a field value uses the JS syntax. */
export function isJsSelector(selector: string): boolean {
  return selector.startsWith('@js:')
}

/** The JS body of an `@js:` selector. */
export function jsBody(selector: string): string {
  return selector.slice('@js:'.length)
}

// --- JSONPath -------------------------------------------------------------

type PathSegment = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wildcard' }

/** Parse the supported JSONPath subset into segments. */
export function parseJsonPath(path: string): PathSegment[] {
  if (!path.startsWith('$')) {
    throw new SelectorError(`JSONPath 必须以 $ 开头：${path}`)
  }
  if (path.includes('..')) {
    throw new SelectorError('不支持递归下降（..）')
  }
  if (path.includes('?(')) {
    throw new SelectorError('不支持过滤表达式（?()）')
  }
  if (/\{\d*:\d*\}/.test(path) || /\[\d*:\d*\]/.test(path)) {
    throw new SelectorError('不支持切片（[a:b]）')
  }

  const segments: PathSegment[] = []
  let i = 1 // skip '$'

  while (i < path.length) {
    const char = path[i]

    if (char === '.') {
      i += 1
      if (path[i] === '*') {
        segments.push({ kind: 'wildcard' })
        i += 1
        continue
      }
      let key = ''
      while (i < path.length && path[i] !== '.' && path[i] !== '[') {
        key += path[i]
        i += 1
      }
      if (!key) throw new SelectorError(`JSONPath 在位置 ${i} 缺少字段名`)
      segments.push({ kind: 'key', key })
      continue
    }

    if (char === '[') {
      const close = path.indexOf(']', i)
      if (close < 0) throw new SelectorError('JSONPath 方括号未闭合')
      const inner = path.slice(i + 1, close).trim()
      if (inner === '*') {
        segments.push({ kind: 'wildcard' })
      } else if (/^\d+$/.test(inner)) {
        segments.push({ kind: 'index', index: Number(inner) })
      } else if (/^['"].*['"]$/.test(inner)) {
        segments.push({ kind: 'key', key: inner.slice(1, -1) })
      } else {
        throw new SelectorError(`不支持的方括号内容：[${inner}]`)
      }
      i = close + 1
      continue
    }

    throw new SelectorError(`JSONPath 在位置 ${i} 出现意外字符「${char}」`)
  }

  return segments
}

/**
 * Walk a parsed path over a JSON value, collecting every match.
 *
 * Recursion advances by `depth` alone. Passing a pre-sliced `rest` *and*
 * incrementing the depth would skip a segment on every step — the bug that
 * makes `$.data.total` return the whole `data` object.
 */
function walkPath(value: unknown, segments: PathSegment[], depth = 0): unknown[] {
  if (depth >= segments.length) return [value]

  const segment = segments[depth]!

  if (segment.kind === 'wildcard') {
    // Wildcard applies to arrays (each element) and objects (each value).
    if (Array.isArray(value)) return value.flatMap((item) => walkPath(item, segments, depth + 1))
    if (value !== null && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).flatMap((item) =>
        walkPath(item, segments, depth + 1),
      )
    }
    return []
  }

  if (segment.kind === 'index') {
    if (!Array.isArray(value)) return []
    const item = value[segment.index]
    return item === undefined ? [] : walkPath(item, segments, depth + 1)
  }

  if (value === null || typeof value !== 'object') return []
  const next = (value as Record<string, unknown>)[segment.key]
  return next === undefined ? [] : walkPath(next, segments, depth + 1)
}

/**
 * Evaluate a JSONPath against parsed JSON.
 *
 * Scalars are stringified; objects and arrays are not — a selector that lands
 * on a whole object is almost certainly a mistake in the source, and returning
 * `[object Object]` would hide it. The caller gets an empty result instead.
 */
export function selectJson(data: unknown, path: string): SelectResult {
  const segments = parseJsonPath(path)
  return walkPath(data, segments)
    .map(toText)
    .filter((text): text is string => text !== null)
}

/** Convert a matched value to display text, or null when it is not a scalar. */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // Arrays of scalars are joined: a site that returns ["tag","tag"] for a
  // category field should render, not disappear.
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
    return value.join(' / ')
  }
  return null
}

// --- CSS ------------------------------------------------------------------

/** Elements that should start a new line when their text is extracted. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'blockquote', 'pre', 'li', 'tr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'dd', 'dt',
])

/**
 * Extract an element's text, keeping paragraph breaks.
 *
 * `textContent` alone would flatten a chapter's `<p>` elements into one
 * unbroken line — readable enough for a title, useless for prose. Walking the
 * tree and emitting a newline at every block boundary is what makes the result
 * something a reader can actually read.
 *
 * `<br>` becomes a newline too, and runs of blank lines collapse to one.
 */
export function blockText(element: Element): string {
  const parts: string[] = []

  const walk = (node: Node): void => {
    if (node.nodeType === 3 /* text */) {
      parts.push(node.textContent ?? '')
      return
    }
    if (node.nodeType !== 1 /* element */) return

    const el = node as Element
    const tag = el.localName.toLowerCase()

    if (tag === 'br') {
      parts.push('\n')
      return
    }
    // Scripts and styles contribute nothing but can contain braces and quotes.
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return

    const isBlock = BLOCK_TAGS.has(tag)
    if (isBlock) parts.push('\n')
    for (const child of [...el.childNodes]) walk(child)
    if (isBlock) parts.push('\n')
  }

  walk(element)

  return parts
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1] !== ''))
    .join('\n')
    .trim()
}

/**
 * Text for a matched element, choosing between inline and block extraction.
 *
 * A title or author is inline content: collapsing its whitespace gives "第一章
 * 俗套的重生", which is what we want. A chapter body is made of `<p>` elements:
 * collapsing it would produce one endless line. So the decision is made from the
 * content — if the element actually contains block children (or `<br>`), keep
 * the newlines; otherwise collapse.
 */
function elementText(element: Element): string {
  const hasBlocks =
    element.querySelector('p, div, br, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr') !== null
  if (hasBlocks) return blockText(element)
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Split `selector@attr` into its two parts.
 *
 * `@` at index 0 is the "this element's attribute" form (`css:@href`), so the
 * check must be `>= 0`, not `> 0`. Getting that wrong silently returns null for
 * every `css:@href`, which is one of the most common field selectors.
 */
function splitAttribute(body: string): { query: string; attr: string | null } {
  const at = body.lastIndexOf('@')
  if (at < 0) return { query: body.trim(), attr: null }
  return {
    query: body.slice(0, at).trim(),
    attr: body.slice(at + 1).trim() || null,
  }
}

/**
 * Evaluate a CSS selector against an HTML document.
 *
 * Uses a detached document so the caller can pass raw HTML without touching
 * the live DOM. `all: true` returns every match's text; otherwise the first.
 *
 * An attribute selector with `@attr` suffix is supported for pulling a URL out
 * of an `<a href>` or an image out of `<img src>` — the single most common need
 * when scraping a list page.
 *
 * A bare `css:` (no selector) is legal and means "the document's body text".
 * That is what makes a chapter whose content is the whole page expressible
 * without a magic selector.
 */
export function selectCss(html: string, selector: string, all = false): SelectResult {
  const body = selector.slice('css:'.length).trim()
  const { query, attr } = splitAttribute(body)

  const doc = new DOMParser().parseFromString(html, 'text/html')

  // An empty selector addresses the body itself.
  if (!query) {
    if (attr) {
      const value = doc.body?.getAttribute(attr) ?? null
      return value === null ? [] : [value.trim()]
    }
    if (!doc.body) return []
    const text = elementText(doc.body)
    return text ? [text] : []
  }

  let elements: Element[]
  try {
    elements = [...doc.querySelectorAll(query)]
  } catch {
    throw new SelectorError(`CSS 选择器语法错误：${query}`)
  }

  const picked = all ? elements : elements.slice(0, 1)
  const out: SelectResult = []
  for (const element of picked) {
    if (attr) {
      const value = element.getAttribute(attr)
      if (value !== null) out.push(value.trim())
    } else {
      const text = elementText(element)
      if (text) out.push(text)
    }
  }
  return out
}

/** A single value from a selector, or null. */
export function selectOne(html: string, selector: string): string | null {
  return selectCss(html, selector, false)[0] ?? null
}

/**
 * Evaluate a CSS selector returning elements rather than text.
 *
 * Needed by the list step, which must keep each item's element to run
 * per-field selectors against it.
 */
export function selectCssElements(html: string, selector: string): Element[] {
  const body = selector.startsWith('css:') ? selector.slice('css:'.length).trim() : selector
  if (!body) throw new SelectorError('CSS 选择器为空')
  const doc = new DOMParser().parseFromString(html, 'text/html')
  try {
    return [...doc.querySelectorAll(body)]
  } catch {
    throw new SelectorError(`CSS 选择器语法错误：${body}`)
  }
}

/** Run a field selector against one element's subtree. */
export function selectFromElement(element: Element, selector: string): string | null {
  const body = selector.startsWith('css:') ? selector.slice('css:'.length).trim() : selector
  const { query, attr } = splitAttribute(body)

  let target: Element | null
  try {
    // An empty query means the element itself — the form used for chapter
    // links, where the `<a>` is both the item and the value.
    target = query ? element.querySelector(query) : element
  } catch {
    throw new SelectorError(`CSS 选择器语法错误：${query}`)
  }
  if (!target) return null

  if (attr) return target.getAttribute(attr)?.trim() ?? null
  return elementText(target) || null
}

// --- XPath ----------------------------------------------------------------

/**
 * XPath attribute extraction.
 *
 * Kazumi's rules say `searchResult: "//h3/a"` and take the element's `href`
 * internally. litearti needs that to be *expressible*, but the CSS-style
 * `@attr` suffix cannot work here: `@` is already XPath syntax for an attribute
 * predicate, so `//div[@class="x"]` would have its last `@` mistaken for a
 * suffix and split into `//div[` + `class="x"]`.
 *
 * So XPath uses a function-style marker that no real expression contains:
 *
 *     xpath://a[@class="title"]/::attr(href)
 *
 * The `::attr(name)` is stripped before evaluation, and the attribute is read
 * from each matched node. `::attr()` with an empty name means "the node's own
 * text", which is what a bare `xpath:` already does — it exists only so a rule
 * can be explicit about it.
 */
const XPATH_ATTR = '::attr('

/**
 * Split `.../::attr(href)` into the expression and the attribute name.
 *
 * Tolerates a doubled slash (`a//::attr(href)`) and trims a trailing slash off
 * the expression. Both are what a person writes when they are thinking of the
 * `//` step separator rather than of the marker, and both would otherwise become
 * a trailing `/` that XPath rejects — an error that points at the expression, not
 * at the spelling, and so is hard to diagnose.
 */
function splitXPathAttribute(body: string): { expression: string; attr: string | null } {
  // `lastIndexOf` because an expression could theoretically contain the token in
  // a string literal; the real marker is always at the end.
  const at = body.lastIndexOf(XPATH_ATTR)
  if (at < 0 || !body.endsWith(')')) return { expression: body.trim(), attr: null }
  const attr = body.slice(at + XPATH_ATTR.length, -1).trim()
  const expression = body.slice(0, at).replace(/\/+$/, '').trim()
  return { expression, attr }
}

/**
 * Evaluate an XPath against a document or an element.
 *
 * Uses the browser's own engine, so every axis, predicate and function works —
 * `following-sibling::`, `contains()`, `position()`, `text()` all included. That
 * is a real advantage over Kazumi's hand-rolled support (its README admits only
 * `//`-prefixed selectors work).
 *
 * `base` is the context node, which is how a per-item field selector runs inside
 * one list row. A relative expression (`./li/a`, `ul/li`) must resolve against
 * that node rather than the document, so the context is threaded through.
 */
function evaluateXPath(base: Node, expression: string): Node[] {
  const doc = base.nodeType === 9 ? (base as Document) : base.ownerDocument
  if (!doc) throw new SelectorError('XPath 需要一个文档作为上下文')
  const rebased = rebaseOntoContext(expression, base)
  try {
    const result = doc.evaluate(
      rebased,
      base,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    )
    const nodes: Node[] = []
    for (let i = 0; i < result.snapshotLength; i += 1) {
      const node = result.snapshotItem(i)
      if (node) nodes.push(node)
    }
    return nodes
  } catch (error) {
    throw new SelectorError(
      `XPath 语法错误：${expression}${error instanceof Error ? `（${error.message}）` : ''}`,
    )
  }
}

/** Text of a node, preferring an element's readable content. */
function nodeText(node: Node): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Rebase an absolute expression onto a context element.
 *
 * This is the one place XPath's own semantics fight what a rule author means.
 *
 * `//ul/li/a` is **absolute**: it searches from the document root no matter what
 * context node is passed. So a per-road episode selector written that way returns
 * every episode on the page for *each* road — three roads with 12, 12, 12
 * episodes instead of 12, 8, 4. That is a silent, plausible-looking wrong answer,
 * which is the worst kind.
 *
 * Kazumi's rules are written with exactly this expectation: `chapterResult` is
 * evaluated *inside* each road element, and every community rule writes it as
 * `//li/a`. So when the context is an element and the expression starts with
 * `//`, it is treated as `.//` — "descendants of this element". A genuinely
 * document-wide query from inside an element is not something a source rule
 * needs, and if it ever does, `xpath:` on the document is the way to say it.
 *
 * `self::*` and `.` are unaffected: they already mean "this node".
 */
function rebaseOntoContext(expression: string, context: Node): string {
  if (context.nodeType === 9) return expression
  if (expression === 'self::*' || expression === '.') return expression
  if (expression.startsWith('//')) return `.${expression}`
  return expression
}

/**
 * Evaluate an `xpath:` value against a whole HTML document.
 *
 * A bare `xpath:` means "the document body's text", matching the `css:` rule.
 */
export function selectXPath(html: string, selector: string, all = false): SelectResult {
  const body = selector.startsWith('xpath:') ? selector.slice('xpath:'.length).trim() : selector
  const doc = new DOMParser().parseFromString(html, 'text/html')

  if (!body) {
    const text = doc.body ? nodeText(doc.body) : ''
    return text ? [text] : []
  }

  const { expression, attr } = splitXPathAttribute(body)
  const nodes = evaluateXPath(doc, expression || '.')
  const picked = all ? nodes : nodes.slice(0, 1)

  const out: SelectResult = []
  for (const node of picked) {
    if (attr !== null) {
      const element = node.nodeType === 1 ? (node as Element) : null
      const value = element?.getAttribute(attr)?.trim() ?? ''
      if (value) out.push(value)
      continue
    }
    const text = nodeText(node)
    if (text) out.push(text)
  }
  return out
}

/**
 * Evaluate an `xpath:` value returning the matched nodes.
 *
 * Needed by the list step, which must keep each row's element so per-field
 * selectors can run inside it — the same reason `selectCssElements` exists.
 */
export function selectXPathNodes(html: string, selector: string): Node[] {
  const body = selector.startsWith('xpath:') ? selector.slice('xpath:'.length).trim() : selector
  if (!body) throw new SelectorError('XPath 选择器为空')
  const { expression } = splitXPathAttribute(body)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return evaluateXPath(doc, expression || '.')
}

/**
 * Evaluate an `xpath:` expression against an arbitrary context node.
 *
 * The road step needs this: the roads themselves are matched against the detail
 * document, then each episode list is matched *inside* one road element. Passing
 * the node in keeps the context explicit instead of re-parsing the page per road.
 */
export function selectXPathNodesIn(base: Node, expression: string): Node[] {
  return evaluateXPath(base, expression)
}

/**
 * Run an `xpath:` field selector against one element's subtree.
 *
 * Relative expressions resolve against the element, which is what makes
 * `xpath: /self::*` and `xpath: .//li/a` behave the way a rule author expects.
 * `self::*` in particular is how a rule says "this matched element is the
 * value", the XPath equivalent of an empty `css:`.
 */
export function selectXPathFromElement(element: Element, selector: string): string | null {
  const body = selector.startsWith('xpath:') ? selector.slice('xpath:'.length).trim() : selector
  const { expression, attr } = splitXPathAttribute(body)

  // A bare `xpath:` means the element itself, matching the `css:` convention.
  const nodes = expression ? evaluateXPath(element, expression) : [element]
  const node = nodes[0]
  if (!node) return null

  if (attr !== null) {
    const target = node.nodeType === 1 ? (node as Element) : null
    return target?.getAttribute(attr)?.trim() ?? null
  }

  const text = nodeText(node)
  return text || null
}



