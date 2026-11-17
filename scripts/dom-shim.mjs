/**
 * A minimal DOM for the offline verify scripts.
 *
 * The source engine parses HTML with `DOMParser`, which Node does not have. Three
 * options existed: pull in jsdom (a large dependency, for tests only), skip the
 * HTML paths in tests (which would leave the most-used selectors unverified), or
 * write the small subset this project actually uses.
 *
 * The third is what this is. It covers exactly what `selector.ts` asks for:
 *
 *   tag, .class, #id, [attr], [attr=value], descendants (space), and comma lists
 *
 * It is deliberately not a browser. Anything beyond the above throws or silently
 * fails to match rather than pretending to work, so a test cannot pass because of
 * a shim bug covering for a real one.
 *
 * Text nodes are real nodes because the engine's paragraph extraction walks
 * `childNodes` looking for `nodeType === 3`. Keeping text on the parent instead
 * would make every chapter extract as empty in tests while working in the app —
 * a shim that hides the behaviour under test.
 */

class ShimTextNode {
  constructor(value) {
    this.nodeType = 3
    this.localName = '#text'
    this.nodeName = '#text'
    this.children = []
    this.childNodes = []
    this.parent = null
    this.data = value
  }
  get textContent() {
    return this.data
  }
}

class ShimElement {
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

/**
 * Parse HTML into a body-rooted shim tree.
 *
 * A hand-written tag scanner rather than a parser: it handles the well-formed
 * markup these fixtures use, and refuses to be clever about implied tags or
 * malformed nesting — which is what a fixture should be anyway.
 */
function parseHtml(html) {
  const doc = new ShimElement('#document')
  doc.nodeType = 9
  const body = new ShimElement('body')
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
      const textNode = new ShimTextNode(between)
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
    const node = new ShimElement(name, attrs)
    const parent = stack[stack.length - 1]
    node.parent = parent
    parent.children.push(node)
    parent.childNodes.push(node)
    if (!selfClosing && !['br', 'img', 'hr', 'meta', 'link', 'input'].includes(name)) {
      stack.push(node)
    }
  }
  return doc
}

/** Install `globalThis.DOMParser`. Call once, before loading the engine module. */
export function installDomShim() {
  globalThis.DOMParser = class {
    parseFromString(html) {
      return parseHtml(html)
    }
  }
}
