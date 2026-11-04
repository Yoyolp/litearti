/**
 * EPUB → plain text / Markdown-ish text.
 *
 * The best of the three conversions, because the structure is real: an EPUB
 * declares its own spine order and table of contents, so headings are actual
 * headings rather than guesses from font size.
 *
 * It reuses `viewers/epub/package.ts` — the same OPF/NCX/nav parsing the reader
 * uses. Nothing in that module is modified; export is simply a second consumer.
 * That is the payoff of having kept parsing separate from rendering.
 *
 * Output is deliberately plain text with Markdown heading markers (`#`). The
 * markers cost nothing in a `.txt` file and carry the hierarchy, so the same
 * bytes are useful either way.
 */

import type { ConvertInput } from '../registry'
import { readContainer, readPackage, type TocNode } from '@/viewers/epub/package'
import { ZipArchive } from '@/viewers/epub/zip'

/** Heading level for a TOC depth; deeper than six collapses to six. */
function headingLevel(depth: number): string {
  return '#'.repeat(Math.min(6, Math.max(1, depth + 1)))
}

/** Flatten the TOC into a path → label map, keeping each entry's depth. */
function tocIndex(nodes: TocNode[], depth = 0, into = new Map<string, { label: string; depth: number }>()): Map<string, { label: string; depth: number }> {
  for (const node of nodes) {
    // The first entry for a document wins: a chapter usually has several TOC
    // entries pointing into it (sections), and the top-most one is its title.
    if (node.href && !into.has(node.href)) into.set(node.href, { label: node.label, depth })
    if (node.children.length) tocIndex(node.children, depth + 1, into)
  }
  return into
}

/**
 * Node type numbers.
 *
 * Written as literals rather than `Node.TEXT_NODE` so this module does not
 * depend on the global `Node` constructor being in scope. It runs inside a
 * webview today, but the EPUB parser it sits next to is deliberately
 * platform-neutral, and this keeps the same property.
 */
const TEXT_NODE = 3
const ELEMENT_NODE = 1

/**
 * Pull readable text out of one XHTML document.
 *
 * A DOM is built only to walk the tree; the result is plain text. Block-level
 * elements become line breaks, list items get a bullet, and everything else
 * contributes its text content.
 */
function extractBodyText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const body = doc.body
  if (!body) return ''

  // Remove things that are not prose before walking.
  for (const element of [...body.querySelectorAll('script, style, nav, svg, math')]) {
    element.remove()
  }

  const blocks: string[] = []
  const blockTags = new Set([
    'p', 'div', 'section', 'article', 'blockquote', 'pre',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'figcaption',
  ])

  const walk = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      const text = node.textContent ?? ''
      if (text.trim()) blocks.push(text.replace(/\s+/g, ' '))
      return
    }
    if (node.nodeType !== ELEMENT_NODE) return

    const element = node as Element
    const tag = element.localName.toLowerCase()

    if (tag === 'br') {
      blocks.push('\n')
      return
    }
    if (tag === 'img') {
      const alt = element.getAttribute('alt')
      if (alt?.trim()) blocks.push(`[图：${alt.trim()}]`)
      return
    }

    const isBlock = blockTags.has(tag)
    if (tag === 'li') blocks.push('- ')
    for (const child of [...element.childNodes]) walk(child)
    if (isBlock) blocks.push('\n')
  }

  walk(body)

  // Collapse the marker stream into lines: join everything, then normalize
  // runs of blank lines down to one.
  return blocks
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1] !== ''))
    .join('\n')
    .trim()
}

export async function epubToText(input: ConvertInput): Promise<string> {
  const bytes = await input.readBinary()
  const zip = ZipArchive.open(new Uint8Array(bytes))

  const opfPath = await readContainer(zip)
  const pkg = await readPackage(zip, opfPath)

  const toc = tocIndex(pkg.toc)
  const sections: string[] = []

  // Title page: the book's own metadata, which the reader shows in its header
  // but which would otherwise be lost in a text export.
  const heading = [pkg.title, pkg.author].filter(Boolean).join(' — ')
  if (heading) sections.push(heading)

  for (const path of pkg.spine) {
    let html: string
    try {
      html = await zip.text(path)
    } catch {
      // A missing spine document should not abort the whole export.
      continue
    }

    const text = extractBodyText(html)
    if (!text) continue

    const entry = toc.get(path)
    // Only emit a heading when the TOC actually has one for this document.
    // Inventing headings from file names would be worse than none.
    if (entry) {
      sections.push(`${headingLevel(entry.depth)} ${entry.label}`)
    }

    sections.push(text)
  }

  return sections.join('\n\n')
}
