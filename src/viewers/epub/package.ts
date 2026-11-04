/**
 * EPUB package parsing: container → OPF → manifest/spine/metadata, plus the
 * table of contents in both of its historical shapes.
 *
 * EPUB 2 and EPUB 3 differ here and the viewer has to accept both, because
 * plenty of books in the wild are still EPUB 2:
 *
 *   EPUB 3  `<nav epub:type="toc">` inside an XHTML navigation document
 *   EPUB 2  `<spine toc="ncx">` pointing at an NCX file with a nested navMap
 *
 * Everything is resolved to absolute archive paths at parse time. Relative
 * hrefs are the single most error-prone part of EPUB (they are relative to
 * whichever document declared them), so they never leak past this module.
 */

import type { ZipArchive } from './zip'

export interface ManifestItem {
  id: string
  /** Absolute path inside the archive. */
  href: string
  mediaType: string
  properties: string[]
}

export interface TocNode {
  label: string
  /** Absolute path inside the archive; null for a heading with no target. */
  href: string | null
  /** Fragment within the target document, without the `#`. */
  fragment: string | null
  children: TocNode[]
}

export interface EpubPackage {
  title: string
  author: string
  language: string
  /** Absolute path of the OPF, used as the base for every relative href. */
  opfPath: string
  manifest: ManifestItem[]
  /** Absolute paths of the spine documents, in reading order. */
  spine: string[]
  toc: TocNode[]
  /** True when the package declares a fixed-layout rendition. */
  fixedLayout: boolean
  /** Reading direction for fixed-layout pages; ignored for reflowable books. */
  pageDirection: 'ltr' | 'rtl'
  /** Cover image path, when one is declared. */
  cover: string | null
}

/** Resolve `href` against the directory containing `base`, POSIX-style. */
export function resolveHref(base: string, href: string): string {
  const clean = href.split('#')[0] ?? ''
  if (!clean) return base
  // An absolute href (rare, and technically invalid in EPUB) is taken as-is.
  if (clean.startsWith('/')) return clean.slice(1)
  const segments = base.split('/')
  segments.pop()
  for (const part of clean.split('/')) {
    if (part === '..') segments.pop()
    else if (part !== '.' && part !== '') segments.push(part)
  }
  return segments.join('/')
}

/** Split `path#fragment` into its two halves. */
export function splitFragment(href: string): { path: string; fragment: string | null } {
  const hash = href.indexOf('#')
  if (hash < 0) return { path: href, fragment: null }
  const fragment = href.slice(hash + 1)
  return { path: href.slice(0, hash), fragment: fragment || null }
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('XML 解析失败')
  }
  return doc
}

/** Local name without the namespace prefix, so `dc:title` and `title` both match. */
function localName(element: Element): string {
  return element.localName || element.nodeName.replace(/^.*:/, '')
}

/** All descendants whose local name matches, namespace-agnostic. */
function findAll(root: ParentNode, name: string): Element[] {
  return [...root.querySelectorAll('*')].filter((el) => localName(el) === name)
}

function findFirst(root: ParentNode, name: string): Element | null {
  return findAll(root, name)[0] ?? null
}

/** Read `container.xml` and return the OPF path. */
export async function readContainer(zip: ZipArchive): Promise<string> {
  const text = await zip.text('META-INF/container.xml')
  const doc = parseXml(text)
  const rootfile = findFirst(doc, 'rootfile')
  const path = rootfile?.getAttribute('full-path')
  if (!path) throw new Error('container.xml 里没有 rootfile')
  return path.replace(/^\/+/, '')
}

/** Parse the OPF: metadata, manifest, spine, and fixed-layout hints. */
export async function readPackage(zip: ZipArchive, opfPath: string): Promise<EpubPackage> {
  const doc = parseXml(await zip.text(opfPath))

  const manifest: ManifestItem[] = findAll(doc, 'item').map((item) => ({
    id: item.getAttribute('id') ?? '',
    href: resolveHref(opfPath, item.getAttribute('href') ?? ''),
    mediaType: item.getAttribute('media-type') ?? '',
    properties: (item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
  }))
  const byId = new Map(manifest.map((item) => [item.id, item]))

  const spine: string[] = []
  for (const ref of findAll(doc, 'itemref')) {
    // `linear="no"` marks supplementary content (answers, pop-up notes) that
    // is not part of the linear reading order.
    if (ref.getAttribute('linear') === 'no') continue
    const idref = ref.getAttribute('idref')
    const item = idref ? byId.get(idref) : undefined
    if (item) spine.push(item.href)
  }

  const title = findFirst(doc, 'title')?.textContent?.trim() ?? ''
  const author = findAll(doc, 'creator')
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean)
    .join('、')
  const language = findFirst(doc, 'language')?.textContent?.trim() ?? ''

  const meta = (property: string): string =>
    findAll(doc, 'meta')
      .filter((el) => el.getAttribute('property') === property)
      .map((el) => el.textContent?.trim() ?? '')[0] ?? ''

  // Rendition metadata can be declared per-spine-item, but a book that mixes
  // layouts is vanishingly rare and the viewer only supports one model at a
  // time, so the package-level declaration is what decides.
  const layout = meta('rendition:layout') || findFirst(doc, 'spine')?.getAttribute('rendition:layout') || ''
  const fixedLayout = layout === 'pre-paginated'
  const direction = meta('rendition:page-spread-direction') || findFirst(doc, 'spine')?.getAttribute('page-progression-direction') || ''
  const pageDirection = direction === 'rtl' ? 'rtl' : 'ltr'

  // EPUB 2 cover convention: <meta name="cover" content="item-id">.
  let cover: string | null = null
  const coverId = findAll(doc, 'meta')
    .filter((el) => el.getAttribute('name') === 'cover')
    .map((el) => el.getAttribute('content') ?? '')[0]
  if (coverId) cover = byId.get(coverId)?.href ?? null
  if (!cover) {
    cover = manifest.find((item) => item.properties.includes('cover-image'))?.href ?? null
  }

  const toc = await readToc(zip, doc, byId)

  return {
    title: title || '未命名',
    author,
    language,
    opfPath,
    manifest,
    spine,
    toc,
    fixedLayout,
    pageDirection,
    cover,
  }
}

/**
 * Table of contents: prefer the EPUB 3 navigation document, fall back to NCX.
 *
 * Both are read when present rather than trusting one: EPUB 3 books sometimes
 * ship a stale NCX and a correct nav, and EPUB 2 books only have NCX. The nav
 * document is the more precise of the two, so it wins when both exist.
 */
async function readToc(
  zip: ZipArchive,
  opf: Document,
  byId: Map<string, ManifestItem>,
): Promise<TocNode[]> {
  const navItem = [...byId.values()].find((item) => item.properties.includes('nav'))
  if (navItem) {
    try {
      const nodes = await readNavDocument(zip, navItem.href)
      if (nodes.length) return nodes
    } catch {
      // A malformed nav document is not fatal: NCX may still be usable.
    }
  }

  const spineElement = findFirst(opf, 'spine')
  const ncxId = spineElement?.getAttribute('toc')
  const ncxItem = ncxId ? byId.get(ncxId) : undefined
  const ncxHref = ncxItem?.href ?? [...byId.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml')?.href
  if (ncxHref) {
    try {
      return await readNcx(zip, ncxHref)
    } catch {
      // No usable TOC at all; the viewer falls back to spine order.
    }
  }
  return []
}

async function readNavDocument(zip: ZipArchive, navPath: string): Promise<TocNode[]> {
  const doc = parseXml(await zip.text(navPath))
  // The toc nav is identified by `epub:type="toc"`. Fall back to the first nav
  // when the type attribute is missing, which is common in hand-made books.
  const navs = findAll(doc, 'nav')
  const tocNav =
    navs.find((nav) => (nav.getAttribute('epub:type') ?? nav.getAttribute('type')) === 'toc') ?? navs[0]
  if (!tocNav) return []
  const list = findFirst(tocNav, 'ol') ?? findFirst(tocNav, 'ul')
  if (!list) return []
  return parseNavList(list, navPath)
}

function parseNavList(list: Element, base: string): TocNode[] {
  const nodes: TocNode[] = []
  for (const li of [...list.children].filter((el) => localName(el) === 'li')) {
    // The label lives in the first <a> or <span> that is a direct child.
    const anchor = [...li.children].find((el) => ['a', 'span'].includes(localName(el)))
    const label = anchor?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    const hrefAttr = anchor && localName(anchor) === 'a' ? anchor.getAttribute('href') : null
    const nested = [...li.children].find((el) => ['ol', 'ul'].includes(localName(el)))

    let href: string | null = null
    let fragment: string | null = null
    if (hrefAttr) {
      const split = splitFragment(hrefAttr)
      href = split.path ? resolveHref(base, split.path) : base
      fragment = split.fragment
    }

    const children = nested ? parseNavList(nested, base) : []
    if (label || href) nodes.push({ label: label || '未命名章节', href, fragment, children })
  }
  return nodes
}

async function readNcx(zip: ZipArchive, ncxPath: string): Promise<TocNode[]> {
  const doc = parseXml(await zip.text(ncxPath))
  const map = findFirst(doc, 'navMap')
  if (!map) return []
  return parseNavPoints(map, ncxPath)
}

/**
 * Parse one level of `navPoint`s. Nested navPoints are children of the current
 * one, so recursion runs on the navPoint element itself — `navMap` is just the
 * container that starts the walk.
 */
function parseNavPoints(parent: Element, base: string): TocNode[] {
  const nodes: TocNode[] = []
  for (const point of [...parent.children].filter((el) => localName(el) === 'navPoint')) {
    const label = findFirst(point, 'text')?.textContent?.replace(/\s+/g, ' ').trim() ?? '未命名章节'
    const src = findFirst(point, 'content')?.getAttribute('src') ?? ''
    const split = splitFragment(src)

    nodes.push({
      label,
      href: split.path ? resolveHref(base, split.path) : null,
      fragment: split.fragment,
      children: parseNavPoints(point, base),
    })
  }
  return nodes
}

/** Flatten a TOC tree into reading order, keeping depth for indentation. */
export function flattenToc(nodes: TocNode[], depth = 0): { node: TocNode; depth: number }[] {
  const out: { node: TocNode; depth: number }[] = []
  for (const node of nodes) {
    out.push({ node, depth })
    if (node.children.length) out.push(...flattenToc(node.children, depth + 1))
  }
  return out
}
