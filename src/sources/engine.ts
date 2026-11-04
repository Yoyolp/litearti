/**
 * The book source engine: turns a validated `BookSource` plus a keyword into
 * results, by fetching, selecting, and evaluating.
 *
 * Layering, and why it is layered this way:
 *
 *   engine.ts      orchestration — knows about pages, lists, chapters
 *   selector.ts    evaluation — knows about JSONPath and CSS
 *   sandbox.ts     JS execution — knows nothing about sources
 *   net.rs         transport — knows nothing about parsing
 *
 * The engine is the only module that combines them, so a test can drive the
 * selection logic with fixed HTML/JSON and no network, and a different transport
 * (a mock, or an offline cache) can be substituted by passing a fetcher.
 */

import * as api from '@/api/library'
import type { BookSource, ResourceType } from './schema'
import {
  isJsSelector,
  jsBody,
  selectCss,
  selectCssElements,
  selectFromElement,
  selectJson,
  SelectorError,
  type SelectResult,
} from './selector'
import { JsSandbox } from './sandbox'

/**
 * How many paginated pages one chapter may span.
 *
 * A cap rather than unbounded following: a source whose `nextUrl` selector
 * matches something that always resolves would otherwise fetch forever. Twenty
 * is far past any real chapter split (sites use 2–5).
 */
const MAX_CHAPTER_PAGES = 20

/** One search/browse result, ready for a card. */
export interface SourceItem {
  title: string
  author: string | null
  cover: string | null
  intro: string | null
  /** Resource kind for the card's type label. */
  type: ResourceType
  /** Absolute URL of the detail page. */
  detailUrl: string
}

/** One chapter in a detail page. */
export interface SourceChapter {
  title: string
  url: string
}

export interface SourceDetail {
  title: string
  author: string | null
  cover: string | null
  intro: string | null
  chapters: SourceChapter[]
}

/** A fetched page, already decoded to text. */
export interface FetchedPage {
  status: number
  url: string
  body: string
}

/** How the engine reaches the network. Injectable so tests need no server. */
export type Fetcher = (
  url: string,
  source: BookSource,
  /**
   * Request options. Only a search may use POST; detail and chapter pages are
   * always fetched with GET.
   */
  options?: { method?: 'GET' | 'POST'; body?: string },
) => Promise<FetchedPage>

/**
 * Default fetcher: goes through the Rust command.
 *
 * The JS sandbox has no network access at all; this is the only path out.
 *
 * The method defaults to GET. Using the search's method for every request — as
 * this did originally — sends a bodyless POST to detail and chapter URLs, which
 * many sites answer with an empty page. The symptom is a book whose chapter list
 * loads but whose text is always blank.
 */
export const defaultFetcher: Fetcher = async (url, source, options) => {
  const method = options?.method ?? 'GET'
  const response = await api.sourceFetch({
    url,
    method,
    body: method === 'POST' ? (options?.body ?? '') : undefined,
    headers: source.request.headers,
    timeoutMs: source.request.timeoutMs,
    // Lets the backend attach this source's login cookie. The value never comes
    // back through here; only the id travels.
    sourceId: source.id,
  })

  // A source that declares a login and is answered with 401/403 is almost always
  // in one of two states: never logged in, or the session expired. Saying so is
  // far more useful than letting an empty page look like a broken selector.
  if (source.auth && (response.status === 401 || response.status === 403)) {
    throw new Error(
      `需要登录（HTTP ${response.status}），请到书源页登录后重试`,
    )
  }

  return { status: response.status, url: response.url, body: response.body }
}

/** Substitute `{{var}}` placeholders in a URL template. */
export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : encodeURIComponent(String(value))
  })
}

/** Resolve a possibly-relative URL against the page it was found on. */
export function absoluteUrl(href: string | null, base: string): string | null {
  if (!href) return null
  const trimmed = href.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed, base).toString()
  } catch {
    return null
  }
}

/**
 * The engine instance for one source.
 *
 * Holds the sandbox, because creating an iframe per field would be absurd. The
 * caller owns disposal.
 */
export class SourceEngine {
  private sandbox: JsSandbox | null = null

  constructor(
    private readonly source: BookSource,
    private readonly fetcher: Fetcher = defaultFetcher,
    private readonly mount?: HTMLElement,
  ) {}

  private getSandbox(): JsSandbox {
    if (!this.sandbox) {
      if (!this.mount) {
        throw new Error('需要挂载点才能执行 JS 选择器')
      }
      this.sandbox = new JsSandbox(this.mount)
    }
    return this.sandbox
  }

  /**
   * Evaluate one selector against a payload.
   *
   * `payload` is either parsed JSON (for `$.` paths) or an HTML string (for
   * `css:`). JS selectors receive the parsed JSON when available, otherwise the
   * raw string — the expression author decides what to do with it.
   */
  async evaluate(
    selector: string,
    payload: { json?: unknown; html?: string; text: string },
    /** Return every match instead of only the first (CSS selectors only). */
    all = false,
  ): Promise<SelectResult> {
    if (selector.startsWith('$.')) {
      if (payload.json === undefined) {
        // A JSONPath against HTML is a source authoring mistake; say so rather
        // than returning an empty list that looks like "no results".
        throw new SelectorError('JSONPath 需要 JSON 响应，但得到的是 HTML')
      }
      return selectJson(payload.json, selector)
    }

    if (selector.startsWith('css:')) {
      if (payload.html === undefined) {
        throw new SelectorError('CSS 选择器需要 HTML 响应，但得到的是 JSON')
      }
      return selectCss(payload.html, selector, all)
    }

    if (isJsSelector(selector)) {
      const input = payload.json !== undefined ? payload.json : payload.html ?? payload.text
      return this.getSandbox().evaluate(jsBody(selector), input)
    }

    throw new SelectorError(`无法识别的选择器：${selector}`)
  }

  /** One value, or null. */
  private async evaluateOne(
    selector: string | undefined,
    payload: { json?: unknown; html?: string; text: string },
  ): Promise<string | null> {
    if (!selector) return null
    const values = await this.evaluate(selector, payload)
    return values[0] ?? null
  }

  /** Parse a body as JSON when it looks like JSON, else null. */
  private parseJson(body: string): unknown {
    const trimmed = body.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
    try {
      return JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }

  /** Search (or browse) this source. */
  async search(keyword: string, page = 1): Promise<SourceItem[]> {
    const vars = { keyword, page }
    const url = fillTemplate(this.source.search.url, vars)
    // A POST search carries its query in the body, so the body is a template
    // too. Leaving it unsubstituted would send the literal `{{keyword}}` to the
    // site and silently return the same results for every query.
    const body = this.source.search.body ? fillTemplate(this.source.search.body, vars) : undefined
    const page_ = await this.fetcher(url, this.source, {
      method: this.source.search.method,
      body,
    })
    const json = this.parseJson(page_.body)

    const fields = this.source.search.fields

    // The list selector determines the shape of iteration:
    //   css:  → one element per item, fields evaluated within it
    //   $.   → one object per item, fields evaluated against it
    if (this.source.search.list.startsWith('css:')) {
      const elements = selectCssElements(page_.body, this.source.search.list)
      const items: SourceItem[] = []
      for (const element of elements) {
        const title = selectFromElement(element, fields.title)
        if (!title) continue
        const href = selectFromElement(element, fields.detailUrl)
        const detailUrl = absoluteUrl(href, page_.url)
        if (!detailUrl) continue

        items.push({
          title,
          author: fields.author ? selectFromElement(element, fields.author) : null,
          cover: absoluteUrl(fields.cover ? selectFromElement(element, fields.cover) : null, page_.url),
          intro: fields.intro ? selectFromElement(element, fields.intro) : null,
          type: this.source.type,
          detailUrl,
        })
      }
      return items
    }

    // A JSON list must be walked as objects so per-field selectors can address
    // into each item; `evaluate` alone would stringify them.
    if (json === undefined) {
      throw new SelectorError('列表选择器需要 JSON 响应')
    }
    const objects = selectJsonObjects(json, this.source.search.list)
    const items: SourceItem[] = []
    for (const object of objects) {
      const itemPayload = { json: object, text: JSON.stringify(object) }
      const title = await this.evaluateOne(fields.title, itemPayload)
      if (!title) continue
      const href = await this.evaluateOne(fields.detailUrl, itemPayload)
      const detailUrl = absoluteUrl(href, page_.url)
      if (!detailUrl) continue

      items.push({
        title,
        author: await this.evaluateOne(fields.author, itemPayload),
        cover: absoluteUrl(await this.evaluateOne(fields.cover, itemPayload), page_.url),
        intro: await this.evaluateOne(fields.intro, itemPayload),
        type: this.source.type,
        detailUrl,
      })
    }
    return items
  }

  /** Load a detail page and its chapter list. */
  async detail(detailUrl: string): Promise<SourceDetail> {
    const page = await this.fetcher(detailUrl, this.source)
    const json = this.parseJson(page.body)
    const payload = { json, html: page.body, text: page.body }
    const config = this.source.detail

    // `detail.title` is the book's title. Falling back to the search-field
    // selector is wrong (that one runs against a *list item*), so the fallback
    // is the caller-supplied item title, handled by the view.
    const title = (await this.evaluateOne(config.title, payload)) ?? '未命名'

    const author =
      (await this.evaluateOne(config.author, payload)) ??
      (await this.evaluateOne(this.source.search.fields.author, payload))

    const intro = config.intro ? await this.evaluateOne(config.intro, payload) : null
    const cover = absoluteUrl(
      config.cover ? await this.evaluateOne(config.cover, payload) : null,
      page.url,
    )

    // Chapters sometimes live on their own page. The TOC selector runs against
    // the detail page and yields a URL; a source without `tocUrl` reuses the
    // detail page it already fetched, so the common case costs nothing extra.
    let tocHtml = page.body
    let tocBase = page.url
    let tocJson = json
    if (config.tocUrl) {
      const href = await this.evaluateOne(config.tocUrl, payload)
      const resolved = absoluteUrl(href, page.url)
      if (!resolved) {
        throw new SelectorError('目录页地址解析失败（detail.tocUrl 没有取到链接）')
      }
      if (resolved !== page.url) {
        const tocPage = await this.fetcher(resolved, this.source)
        tocHtml = tocPage.body
        tocBase = tocPage.url
        tocJson = this.parseJson(tocPage.body)
      }
    }

    const chapters: SourceChapter[] = []
    if (config.list.startsWith('css:')) {
      const elements = selectCssElements(tocHtml, config.list)
      for (const element of elements) {
        const chapterTitle = selectFromElement(element, config.fields.title)
        const href = selectFromElement(element, config.fields.url)
        // Resolved against the TOC page: relative links are relative to where
        // the list actually was found, not to the detail page.
        const url = absoluteUrl(href, tocBase)
        if (chapterTitle && url) chapters.push({ title: chapterTitle, url })
      }
    } else {
      if (tocJson === undefined) throw new SelectorError('章节列表需要 JSON 响应')
      const objects = selectJsonObjects(tocJson, config.list)
      for (const object of objects) {
        const itemPayload = { json: object, text: JSON.stringify(object) }
        const chapterTitle = await this.evaluateOne(config.fields.title, itemPayload)
        const href = await this.evaluateOne(config.fields.url, itemPayload)
        const url = absoluteUrl(href, tocBase)
        if (chapterTitle && url) chapters.push({ title: chapterTitle, url })
      }
    }

    return {
      title,
      author,
      cover,
      intro,
      chapters,
    }
  }

  /**
   * Load one chapter's body text.
   *
   * If the source declares `chapter.nextUrl`, pagination is followed: many
   * sites split a long chapter across `xxx_2.html`, `xxx_3.html`… and each page
   * carries a "next" link. Without following it the reader would silently get
   * only the first third of a chapter, which looks like the book is broken.
   *
   * The loop is bounded twice over — a page cap, and a visited-set that stops a
   * link pointing back at a page already read. A malformed source must not be
   * able to hang the reader.
   */
  async chapter(chapterUrl: string): Promise<string> {
    const parts: string[] = []
    const visited = new Set<string>()
    let current: string | null = chapterUrl

    for (let page = 0; page < MAX_CHAPTER_PAGES && current; page += 1) {
      if (visited.has(current)) break
      visited.add(current)

      const fetched = await this.fetcher(current, this.source)
      const json = this.parseJson(fetched.body)
      const payload = { json, html: fetched.body, text: fetched.body }

      // `all` matters here: a chapter body is often several sibling blocks
      // (`#content p`), and taking only the first would return one paragraph.
      // It also lets a source select the paragraphs specifically, which is how
      // navigation links that sit beside them stay out of the text.
      const values = await this.evaluate(this.source.chapter.content, payload, true)
      const text = values.join('\n').trim()
      if (text) parts.push(text)

      if (!this.source.chapter.nextUrl) break

      const next = await this.evaluateOne(this.source.chapter.nextUrl, payload)
      const resolved = absoluteUrl(next, fetched.url)
      // `absoluteUrl` returns null for an empty href, which is how most sites
      // mark "this is the last page".
      current = resolved
    }

    return parts.join('\n').trim()
  }

  /**
   * Fetch just the cover for a search result.
   *
   * Many sites put no image in their search listing — the cover only exists on
   * the detail page. Showing an initial tile forever would technically render,
   * but the feature asks for a cover on every item, so the browse view fills
   * them in progressively after the list appears.
   *
   * Returns null when the source declares no `detail.cover`, which is the signal
   * to leave the placeholder alone rather than issue a pointless request.
   */
  async cover(detailUrl: string): Promise<string | null> {
    const selector = this.source.detail.cover
    if (!selector) return null

    const page = await this.fetcher(detailUrl, this.source, { method: 'GET' })
    const json = this.parseJson(page.body)
    const value = await this.evaluateOne(selector, {
      json,
      html: page.body,
      text: page.body,
    })
    return absoluteUrl(value, page.url)
  }

  /**
   * Build a card item from a detail-page URL, without searching.
   *
   * People paste a book's URL — `https://site/xs/250929/` — rather than typing a
   * title, especially when they came from a browser. Treating that input as a
   * search keyword finds nothing, so the browse view detects it and calls this
   * instead.
   *
   * The metadata comes from the detail page itself, so the resulting card is
   * identical to one produced by search. A missing title falls back to the URL's
   * last path segment, which is still recognisable to the person who pasted it.
   */
  async itemFromUrl(url: string): Promise<SourceItem> {
    const detail = await this.detail(url)
    if (!detail.chapters.length) {
      throw new SelectorError('这个地址没有解析到章节，可能不是书籍目录页')
    }
    return {
      title: detail.title === '未命名' ? (url.split('/').filter(Boolean).pop() ?? url) : detail.title,
      author: detail.author,
      cover: detail.cover,
      intro: detail.intro,
      type: this.source.type,
      detailUrl: url,
    }
  }

  /**
   * Tear down the sandbox.
   *
   * Must be called when leaving the view: the sandbox owns an iframe, and
   * leaving it attached would keep a frame (and its JS context) alive for the
   * rest of the session.
   */
  dispose(): void {
    this.sandbox?.dispose()
    this.sandbox = null
  }
}

/**
 * Walk a JSONPath and keep the matched *objects*.
 *
 * `selectJson` stringifies scalars, which is right for field extraction but
 * wrong for the list step: the engine needs each item as an object so per-field
 * selectors can address into it.
 *
 * An array result is flattened one level. `$.data` where `data` *is* the array
 * means "iterate these", and that is how virtually every JSON API — and every
 * Legado source — expresses a list. Without the flatten the whole array arrives
 * as a single item and no field selector can address into it.
 */
export function selectJsonObjects(data: unknown, path: string): unknown[] {
  // Reuse the selector module's parser, then walk without stringifying.
  const segments = parseForObjects(path)
  let current: unknown[] = [data]
  for (const segment of segments) {
    const next: unknown[] = []
    for (const value of current) {
      if (segment === '*') {
        if (Array.isArray(value)) next.push(...value)
        else if (value !== null && typeof value === 'object') next.push(...Object.values(value as Record<string, unknown>))
      } else if (typeof segment === 'number') {
        if (Array.isArray(value) && value[segment] !== undefined) next.push(value[segment])
      } else if (value !== null && typeof value === 'object') {
        const child = (value as Record<string, unknown>)[segment]
        if (child !== undefined) next.push(child)
      }
    }
    current = next
  }
  return current.flatMap((value) => (Array.isArray(value) ? value : [value]))
}

/** Minimal segment parser matching `selector.ts`, kept local to avoid exporting internals. */
function parseForObjects(path: string): (string | number)[] {
  const segments: (string | number)[] = []
  let i = path.startsWith('$') ? 1 : 0
  while (i < path.length) {
    const char = path[i]
    if (char === '.') {
      i += 1
      if (path[i] === '*') {
        segments.push('*')
        i += 1
        continue
      }
      let key = ''
      while (i < path.length && path[i] !== '.' && path[i] !== '[') {
        key += path[i]
        i += 1
      }
      if (key) segments.push(key)
      continue
    }
    if (char === '[') {
      const close = path.indexOf(']', i)
      if (close < 0) break
      const inner = path.slice(i + 1, close).trim()
      if (inner === '*') segments.push('*')
      else if (/^\d+$/.test(inner)) segments.push(Number(inner))
      else segments.push(inner.replace(/^['"]|['"]$/g, ''))
      i = close + 1
      continue
    }
    i += 1
  }
  return segments
}
