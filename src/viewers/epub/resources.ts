/**
 * Resource plumbing for the EPUB viewer: turning archive paths into URLs the
 * webview can load, and making an EPUB document safe to put in an iframe.
 *
 * Two hard rules drive this module:
 *
 * 1. **No network.** litearti promises it never talks to the internet, so a
 *    book that references `https://…` images or fonts must not cause a
 *    request. Remote URLs are neutralised rather than left to fail on their
 *    own — a failed load is still a connection attempt.
 * 2. **No script execution.** Book content is untrusted input. Every `<script>`,
 *    inline handler and `javascript:` URL is stripped before the document is
 *    handed to the frame.
 *
 * Stylesheets are inlined into `<style>` elements instead of being linked:
 * the frame is fed via `srcdoc`, where relative URLs have nothing to resolve
 * against, and inlining removes a whole class of load-order problems.
 */

import { resolveHref } from './package'
import type { ZipArchive } from './zip'

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  css: 'text/css',
}

function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

/** Whether a href points outside the archive. */
export function isRemote(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href.trim())
}

/**
 * Lazily creates and caches blob URLs for archive entries.
 *
 * Caching matters: a chapter with forty illustrations must decode each image
 * once, and flipping back to a previously read chapter must not re-inflate it.
 */
export class ResourceStore {
  private readonly zip: ZipArchive
  private readonly urls = new Map<string, string>()
  private readonly pending = new Map<string, Promise<string | null>>()

  constructor(zip: ZipArchive) {
    this.zip = zip
  }

  /** Blob URL for an archive path, or null when the entry is missing. */
  async url(path: string): Promise<string | null> {
    const cached = this.urls.get(path)
    if (cached) return cached
    const inFlight = this.pending.get(path)
    if (inFlight) return inFlight

    const task = (async () => {
      try {
        const bytes = await this.zip.read(path)
        // Copy into a fresh buffer: the subarray may be a view into the whole
        // archive, and keeping that view alive would pin the entire file.
        const blob = new Blob([bytes.slice()], { type: mimeFor(path) })
        const url = URL.createObjectURL(blob)
        this.urls.set(path, url)
        return url
      } catch {
        return null
      } finally {
        this.pending.delete(path)
      }
    })()

    this.pending.set(path, task)
    return task
  }

  /** One archive entry decoded as UTF-8 text (used for stylesheets). */
  text(path: string): Promise<string> {
    return this.zip.text(path)
  }

  /** Release every URL. Called when the book is closed. */
  dispose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
    this.pending.clear()
  }
}

/** Rewrite relative `url(...)` references inside CSS to blob URLs. */
async function rewriteCss(
  css: string,
  cssPath: string,
  resources: ResourceStore,
  depth = 0,
): Promise<string> {
  // `@import` first: an imported sheet is inlined, so its own relative urls
  // resolve against *its* location, not the importer's.
  const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")]+)['"]?\s*\)?\s*;?/gi)]
  let out = css
  for (const match of imports) {
    const href = match[1]?.trim()
    if (!href || isRemote(href)) {
      out = out.replace(match[0], '')
      continue
    }
    if (depth >= 4) {
      out = out.replace(match[0], '')
      continue
    }
    const target = resolveHref(cssPath, href)
    try {
      const imported = await rewriteCss(await resources.text(target), target, resources, depth + 1)
      out = out.replace(match[0], imported)
    } catch {
      out = out.replace(match[0], '')
    }
  }

  const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
  const replacements = new Map<string, string>()
  for (const match of out.matchAll(urlPattern)) {
    const href = match[2]?.trim()
    if (!href || href.startsWith('data:') || href.startsWith('#')) continue
    if (isRemote(href)) {
      // Replace with a harmless empty data URL so the rule stays syntactically
      // valid while guaranteeing no outbound request.
      replacements.set(match[0], 'url("data:,")')
      continue
    }
    const blob = await resources.url(resolveHref(cssPath, href))
    if (blob) replacements.set(match[0], `url("${blob}")`)
  }

  for (const [from, to] of replacements) out = out.split(from).join(to)
  return out
}

/** Elements that can never be part of a rendered book page. */
const FORBIDDEN_TAGS = new Set([
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'link',
  'meta',
  'template',
])

/** Strip every executable or externally-loading part of a document. */
export function sanitize(doc: Document): void {
  for (const element of [...doc.querySelectorAll('*')]) {
    const tag = element.localName.toLowerCase()
    if (FORBIDDEN_TAGS.has(tag)) {
      element.remove()
      continue
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      // Inline event handlers (`onclick`, `onerror`, …).
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name)
        continue
      }
      const value = attribute.value.trim()
      if (/^javascript:/i.test(value) || /^data:text\/html/i.test(value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }
}

export interface PreparedChapter {
  /** Complete HTML document, ready for an iframe `srcdoc`. */
  html: string
}

/**
 * Turn one spine document into a self-contained HTML string.
 *
 * `themeCss` is injected in reflow mode. `extraCss` is applied in original
 * mode, on top of the book's own CSS — used for the optional "follow theme"
 * surface on fixed-layout pages.
 */
export async function prepareChapter(
  zip: ZipArchive,
  resources: ResourceStore,
  chapterPath: string,
  options: { reflow: boolean; themeCss: string; extraCss?: string },
): Promise<PreparedChapter> {
  const raw = await zip.text(chapterPath)
  const doc = new DOMParser().parseFromString(raw, 'text/html')

  // `<link rel=stylesheet>` must be captured before sanitize removes `link`.
  const styles: string[] = []
  for (const link of [...doc.querySelectorAll('link')]) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase()
    if (!rel.split(/\s+/).includes('stylesheet')) continue
    const href = link.getAttribute('href')
    if (!href || isRemote(href)) continue
    const cssPath = resolveHref(chapterPath, href)
    try {
      styles.push(await rewriteCss(await resources.text(cssPath), cssPath, resources))
    } catch {
      // A missing stylesheet is not fatal; the page still renders unstyled.
    }
  }
  // Inline `<style>` blocks also carry relative urls.
  for (const style of [...doc.querySelectorAll('style')]) {
    styles.push(await rewriteCss(style.textContent ?? '', chapterPath, resources))
  }

  // Rewrite every resource-bearing attribute to a blob URL.
  const srcAttributes = ['src', 'poster']
  for (const element of [...doc.querySelectorAll('*')]) {
    for (const attr of srcAttributes) {
      const value = element.getAttribute(attr)
      if (!value || value.startsWith('data:') || isRemote(value)) {
        if (value && isRemote(value)) element.removeAttribute(attr)
        continue
      }
      const blob = await resources.url(resolveHref(chapterPath, value))
      if (blob) element.setAttribute(attr, blob)
      else element.removeAttribute(attr)
    }

    // `<img srcset>` — pick the first candidate; the viewer renders at one
    // size and multi-resolution selection would need real layout feedback.
    const srcset = element.getAttribute('srcset')
    if (srcset) {
      const first = srcset.split(',')[0]?.trim().split(/\s+/)[0]
      if (first && !isRemote(first)) {
        const blob = await resources.url(resolveHref(chapterPath, first))
        if (blob) element.setAttribute('src', blob)
      }
      element.removeAttribute('srcset')
    }

    // SVG images use `xlink:href` / `href` inside `<image>`.
    if (element.localName.toLowerCase() === 'image') {
      for (const attr of ['href', 'xlink:href']) {
        const value = element.getAttribute(attr)
        if (!value || value.startsWith('data:') || isRemote(value)) continue
        const blob = await resources.url(resolveHref(chapterPath, value))
        if (blob) element.setAttribute(attr, blob)
      }
    }
  }

  // Internal links must not navigate the frame. They are left as anchors with
  // a marker attribute so the parent can intercept clicks.
  for (const anchor of [...doc.querySelectorAll('a[href]')]) {
    const href = anchor.getAttribute('href') ?? ''
    if (isRemote(href)) {
      anchor.removeAttribute('href')
      continue
    }
    anchor.setAttribute('data-epub-href', href)
    anchor.removeAttribute('href')
  }

  sanitize(doc)

  const head = doc.head ?? doc.createElement('head')
  const body = doc.body ?? doc.createElement('body')

  if (options.reflow) {
    // Reflow throws away the publisher's CSS on purpose: the point is a
    // consistent column that matches the app's own reading surface.
    head.replaceChildren()
    const style = doc.createElement('style')
    style.textContent = options.themeCss
    head.append(style)
    reflowStructure(body)
  } else {
    for (const css of styles) {
      const style = doc.createElement('style')
      style.textContent = css
      head.append(style)
    }
    const base = doc.createElement('style')
    // Keep the book's look, but never let it paint outside its own frame or
    // scroll horizontally inside a page-sized viewport.
    base.textContent = `
      html { overflow-x: hidden; }
      img, svg, video { max-width: 100%; height: auto; }
      a[data-epub-href] { cursor: pointer; }
    `
    head.append(base)

    // Applied last so it wins the cascade over the book's own rules.
    if (options.extraCss) {
      const extra = doc.createElement('style')
      extra.textContent = options.extraCss
      head.append(extra)
    }
  }

  return { html: `<!doctype html>${doc.documentElement.outerHTML}` }
}

/**
 * Flatten a book document into semantic blocks for reflow mode.
 *
 * Only structure is kept — headings, paragraphs, lists, quotes, tables, images
 * — and every styling attribute is dropped. Anything the app does not have a
 * reading style for is unwrapped to its text, so nothing can escape the
 * column or carry the publisher's fonts along.
 */
function reflowStructure(body: HTMLElement): void {
  const keep = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'em', 'strong', 'b', 'i', 'u', 's', 'sup', 'sub', 'br', 'hr',
    'img', 'figure', 'figcaption', 'a',
  ])

  for (const element of [...body.querySelectorAll('*')]) {
    if (!element.isConnected) continue
    const tag = element.localName.toLowerCase()
    if (keep.has(tag)) {
      // Keep the semantics, drop presentation.
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase()
        const allowed = tag === 'img'
          ? name === 'src' || name === 'alt'
          : name === 'data-epub-href' || name === 'colspan' || name === 'rowspan'
        if (!allowed) element.removeAttribute(attribute.name)
      }
      continue
    }
    // Unknown wrapper: replace it with its children so its text survives but
    // its styling does not.
    if (['div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'span', 'font', 'center'].includes(tag)) {
      element.replaceWith(...element.childNodes)
    } else if (tag === 'style') {
      element.remove()
    }
  }
}
