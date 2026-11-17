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
import { sniffMedia } from '@/api/library'
import type { BookSource, ResourceType } from './schema'
import {
  isJsSelector,
  jsBody,
  selectCss,
  selectCssElements,
  selectFromElement,
  selectJson,
  selectXPath,
  selectXPathFromElement,
  selectXPathNodes,
  selectXPathNodesIn,
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

/**
 * A node the engine had to skip.
 *
 * Rule authors debug by reading, so "3 results came back out of 10 rows" is the
 * single most useful sentence a scraper can say. Without it, a selector that
 * matches 10 rows but yields 3 items looks exactly like a site that only has 3
 * results — and the author edits the wrong field.
 *
 * The three cases that produce one are all real and all silent before this
 * existed: a row with no title, a row whose link did not resolve, and a chapter
 * entry with no URL.
 */
export interface Diagnosis {
  /** Which step produced it: `search`, `detail`, or `chapter`. */
  stage: 'search' | 'detail' | 'chapter'
  /** Zero-based index of the node within its list. */
  index: number
  /** What went wrong, in the author's language. */
  reason: string
  /** The matched node's text, truncated. Enough to recognise which row it is. */
  excerpt: string
}

export interface SourceDetail {
  title: string
  author: string | null
  cover: string | null
  intro: string | null
  chapters: SourceChapter[]
  /** Nodes skipped while parsing; empty on a clean parse. */
  diagnoses: Diagnosis[]
}

/** One episode of a video source. */
export interface VideoEpisode {
  title: string
  url: string
}

/** One playback line: a set of episodes from the same source site. */
export interface VideoRoad {
  name: string
  episodes: VideoEpisode[]
}

export interface VideoDetail {
  title: string
  author: string | null
  cover: string | null
  intro: string | null
  roads: VideoRoad[]
  diagnoses: Diagnosis[]
}

/** How much of a skipped node's text to keep in a diagnosis. */
const EXCERPT_LENGTH = 80

/**
 * A short, recognisable slice of a node's content.
 *
 * The point is for an author to say "ah, that row" — not to reproduce the row.
 * Whitespace is collapsed so a pretty-printed HTML block does not turn into forty
 * blank lines inside a one-line message.
 */
function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH)}…` : flat
}

/** Build a diagnosis from a DOM node. */
function skip(stage: Diagnosis['stage'], index: number, reason: string, node: Element): Diagnosis {
  return { stage, index, reason, excerpt: excerptOf(node.textContent ?? '') }
}

/**
 * Whether a list selector yields elements rather than JSON objects.
 *
 * `css:` and `xpath:` both do; `$.` does not. Used to pick the iteration shape.
 */
function isElementListSelector(selector: string): boolean {
  return selector.startsWith('css:') || selector.startsWith('xpath:')
}

/** The list step's elements, for either element-based syntax. */
function selectElementsForList(html: string, selector: string): Element[] {
  if (selector.startsWith('xpath:')) {
    return selectXPathNodes(html, selector).filter(
      (node): node is Element => node.nodeType === 1,
    )
  }
  return selectCssElements(html, selector)
}

/**
 * Run one field selector inside a list node, for either element-based syntax.
 *
 * The two syntaxes have different "this element" conventions (`css:` empty body
 * and XPath `self::*`), so this keeps the dispatch in one place instead of at
 * every call site.
 */
function selectFieldFromNode(node: Element, selector: string): string | null {
  if (selector.startsWith('xpath:')) return selectXPathFromElement(node, selector)
  return selectFromElement(node, selector)
}

/**
 * Every element a field selector matches inside one node.
 *
 * The road step needs the road *elements* to iterate into, and `episodes` must
 * then run inside each — so a value-returning selector is not enough.
 */
function selectFieldNodesFromNode(node: Node, selector: string): Element[] {
  if (selector.startsWith('xpath:')) {
    return selectXPathNodesFromNode(node, selector)
  }
  // CSS against an element: run the query in its subtree.
  if (node.nodeType !== 1) return []
  const body = selector.startsWith('css:') ? selector.slice('css:'.length).trim() : selector
  if (!body) return []
  try {
    return [...(node as Element).querySelectorAll(body)]
  } catch {
    throw new SelectorError(`CSS 选择器语法错误：${body}`)
  }
}

/** The XPath list step against an arbitrary node (document or element). */
function selectXPathNodesFromNode(node: Node, selector: string): Element[] {
  const body = selector.startsWith('xpath:') ? selector.slice('xpath:'.length).trim() : selector
  if (!body) throw new SelectorError('XPath 选择器为空')
  return selectXPathNodesIn(node, body).filter((n): n is Element => n.nodeType === 1)
}

/** Build a Document from an HTML string, for use as an XPath context. */
function documentFromHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
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
      `需要登录（HTTP ${response.status}），请到源页登录后重试`,
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
   * Fetch one page through this source's headers and transport.
   *
   * Exposed for the editor's selector tester, which needs "the raw page at this
   * URL" so it can evaluate a single selector without running a whole stage. It
   * is deliberately not a general-purpose fetcher: it takes no method or body and
   * always issues a GET, because that is all a tester needs and a wider surface
   * here would only invite the editor to reimplement the engine.
   */
  fetchPage(url: string): Promise<FetchedPage> {
    return this.fetcher(url, this.source, { method: 'GET' })
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

    if (selector.startsWith('xpath:')) {
      if (payload.html === undefined) {
        throw new SelectorError('XPath 选择器需要 HTML 响应，但得到的是 JSON')
      }
      return selectXPath(payload.html, selector, all)
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
    return (await this.searchWithDiagnoses(keyword, page)).items
  }

  /**
   * Search, keeping the list of skipped nodes.
   *
   * `search` is the thin wrapper that drops them, so existing callers are
   * unaffected. The rule editor and the trial-run page use this form, because
   * they are the places where "why did I get 3 of 10" is the actual question.
   */
  async searchWithDiagnoses(
    keyword: string,
    page = 1,
  ): Promise<{ items: SourceItem[]; diagnoses: Diagnosis[] }> {
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
    const diagnoses: Diagnosis[] = []

    // The list selector determines the shape of iteration:
    //   css: / xpath:  → one node per item, fields evaluated within it
    //   $.             → one object per item, fields evaluated against it
    //
    // `css:` and `xpath:` share the per-item path because both yield elements and
    // both support running a field selector *inside* one. Keeping them separate
    // would duplicate the field/diagnosis loop for no benefit.
    if (isElementListSelector(this.source.search.list)) {
      const nodes = selectElementsForList(page_.body, this.source.search.list)
      const items: SourceItem[] = []
      nodes.forEach((node, index) => {
        const element = node as Element
        const title = selectFieldFromNode(element, fields.title)
        if (!title) {
          diagnoses.push(skip('search', index, '缺少标题', element))
          return
        }
        const href = selectFieldFromNode(element, fields.detailUrl)
        const detailUrl = absoluteUrl(href, page_.url)
        if (!detailUrl) {
          diagnoses.push(skip('search', index, '链接没有解析成有效地址', element))
          return
        }

        items.push({
          title,
          author: fields.author ? selectFieldFromNode(element, fields.author) : null,
          cover: absoluteUrl(
            fields.cover ? selectFieldFromNode(element, fields.cover) : null,
            page_.url,
          ),
          intro: fields.intro ? selectFieldFromNode(element, fields.intro) : null,
          type: this.source.type,
          detailUrl,
        })
      })
      return { items, diagnoses }
    }

    // A JSON list must be walked as objects so per-field selectors can address
    // into each item; `evaluate` alone would stringify them.
    if (json === undefined) {
      throw new SelectorError('列表选择器需要 JSON 响应')
    }
    const objects = selectJsonObjects(json, this.source.search.list)
    const items: SourceItem[] = []
    for (const [index, object] of objects.entries()) {
      const itemPayload = { json: object, text: JSON.stringify(object) }
      const title = await this.evaluateOne(fields.title, itemPayload)
      if (!title) {
        diagnoses.push({
          stage: 'search',
          index,
          reason: '缺少标题',
          excerpt: excerptOf(JSON.stringify(object)),
        })
        continue
      }
      const href = await this.evaluateOne(fields.detailUrl, itemPayload)
      const detailUrl = absoluteUrl(href, page_.url)
      if (!detailUrl) {
        diagnoses.push({
          stage: 'search',
          index,
          reason: '链接没有解析成有效地址',
          excerpt: excerptOf(JSON.stringify(object)),
        })
        continue
      }

      items.push({
        title,
        author: await this.evaluateOne(fields.author, itemPayload),
        cover: absoluteUrl(await this.evaluateOne(fields.cover, itemPayload), page_.url),
        intro: await this.evaluateOne(fields.intro, itemPayload),
        type: this.source.type,
        detailUrl,
      })
    }
    return { items, diagnoses }
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
    const diagnoses: Diagnosis[] = []
    if (isElementListSelector(config.list)) {
      const elements = selectElementsForList(tocHtml, config.list)
      elements.forEach((element, index) => {
        const chapterTitle = selectFieldFromNode(element, config.fields.title)
        const href = selectFieldFromNode(element, config.fields.url)
        // Resolved against the TOC page: relative links are relative to where
        // the list actually was found, not to the detail page.
        const url = absoluteUrl(href, tocBase)
        if (!chapterTitle) {
          diagnoses.push(skip('detail', index, '缺少章节标题', element))
          return
        }
        if (!url) {
          diagnoses.push(skip('detail', index, '章节链接没有解析成有效地址', element))
          return
        }
        chapters.push({ title: chapterTitle, url })
      })
    } else {
      if (tocJson === undefined) throw new SelectorError('章节列表需要 JSON 响应')
      const objects = selectJsonObjects(tocJson, config.list)
      for (const [index, object] of objects.entries()) {
        const itemPayload = { json: object, text: JSON.stringify(object) }
        const chapterTitle = await this.evaluateOne(config.fields.title, itemPayload)
        const href = await this.evaluateOne(config.fields.url, itemPayload)
        const url = absoluteUrl(href, tocBase)
        if (!chapterTitle) {
          diagnoses.push({
            stage: 'detail',
            index,
            reason: '缺少章节标题',
            excerpt: excerptOf(JSON.stringify(object)),
          })
          continue
        }
        if (!url) {
          diagnoses.push({
            stage: 'detail',
            index,
            reason: '章节链接没有解析成有效地址',
            excerpt: excerptOf(JSON.stringify(object)),
          })
          continue
        }
        chapters.push({ title: chapterTitle, url })
      }
    }

    return {
      title,
      author,
      cover,
      intro,
      chapters,
      diagnoses,
    }
  }

  /**
   * Detail page for a video source: metadata plus playback lines and episodes.
   *
   * Kept separate from `detail()` rather than folded into it because the shapes
   * genuinely differ: a video source has lines of episodes, a text source has one
   * flat chapter list. Trying to serve both from one method would mean every
   * caller branching on `type`, and the text path (with its pagination and
   * paragraph handling) would grow video-only fields it never uses.
   */
  async videoDetail(detailUrl: string): Promise<VideoDetail> {
    const config = this.source.video
    if (!config) {
      throw new SelectorError('这个源没有 video 配置，不能当作视频源使用')
    }

    const page = await this.fetcher(detailUrl, this.source)
    const json = this.parseJson(page.body)
    const payload = { json, html: page.body, text: page.body }
    const detailConfig = this.source.detail

    const title = (await this.evaluateOne(detailConfig.title, payload)) ?? '未命名'
    const author =
      (await this.evaluateOne(detailConfig.author, payload)) ??
      (await this.evaluateOne(this.source.search.fields.author, payload))
    const intro = detailConfig.intro ? await this.evaluateOne(detailConfig.intro, payload) : null
    const cover = absoluteUrl(
      detailConfig.cover ? await this.evaluateOne(detailConfig.cover, payload) : null,
      page.url,
    )

    const roads: VideoRoad[] = []
    const diagnoses: Diagnosis[] = []

    /**
     * Read the episodes inside one container (the page, or one road element).
     *
     * Factored out because the single-line and multi-line cases differ only in
     * which node they start from.
     */
    const readEpisodes = (container: Element | null, baseUrl: string): VideoEpisode[] => {
      const episodes: VideoEpisode[] = []
      let nodes: Element[]

      if (container) {
        // Inside a road element: only element-based syntax can run here, because
        // a JSONPath has no notion of "inside this element".
        nodes = isElementListSelector(config.episodes)
          ? selectFieldNodesFromNode(container, config.episodes)
          : []
      } else {
        nodes = selectElementsForList(page.body, config.episodes)
      }

      nodes.forEach((node, index) => {
        const href = selectFieldFromNode(node, config.episodeUrl)
        const url = absoluteUrl(href, baseUrl)
        if (!url) {
          diagnoses.push(skip('detail', index, '剧集链接没有解析成有效地址', node))
          return
        }
        const rawName = config.episodeTitle ? selectFieldFromNode(node, config.episodeTitle) : null
        episodes.push({
          title: rawName?.trim() || `第 ${index + 1} 集`,
          url,
        })
      })
      return episodes
    }

    if (config.roads) {
      const roadNodes = selectFieldNodesFromNode(
        // The road list lives on the detail page, so the document is the context.
        documentFromHtml(page.body),
        config.roads,
      )
      roadNodes.forEach((roadNode, index) => {
        const name =
          (config.roadsName ? selectFieldFromNode(roadNode, config.roadsName) : null)?.trim() ||
          `线路 ${index + 1}`
        const episodes = readEpisodes(roadNode, page.url)
        if (!episodes.length) {
          diagnoses.push(skip('detail', index, `线路「${name}」没有解析到剧集`, roadNode))
          return
        }
        roads.push({ name, episodes })
      })
    } else {
      const episodes = readEpisodes(null, page.url)
      if (episodes.length) {
        roads.push({ name: '线路 1', episodes })
      }
    }

    return { title, author, cover, intro, roads, diagnoses }
  }

  /**
   * Resolve one episode to a media URL.
   *
   * Returns the address only — it does not check that the URL plays, because
   * "reachable" and "playable" are different questions and only the player can
   * answer the second.
   */
  async episodeVideoUrl(episodeUrl: string): Promise<string> {
    const config = this.source.video
    if (!config) {
      throw new SelectorError('这个源没有 video 配置')
    }
    const playback = config.playback

    switch (playback.kind) {
      case 'direct': {
        const page = await this.fetcher(episodeUrl, this.source)
        return this.readMediaUrl(page.body, page.url, playback.url)
      }

      case 'page': {
        // The episode page links to a player page; read the address from there.
        const first = await this.fetcher(episodeUrl, this.source)
        const payload = { html: first.body, text: first.body }
        const href = await this.evaluateOne(playback.pageUrl, payload)
        const playerUrl = absoluteUrl(href, first.url)
        if (!playerUrl) {
          throw new SelectorError('播放页地址解析失败（playback.pageUrl 没有取到链接）')
        }
        const player = await this.fetcher(playerUrl, this.source)
        return this.readMediaUrl(player.body, player.url, playback.url)
      }

      case 'regex': {
        const page = await this.fetcher(episodeUrl, this.source)
        let expression: RegExp
        try {
          expression = new RegExp(playback.pattern)
        } catch (error) {
          throw new SelectorError(
            `取流正则无效：${error instanceof Error ? error.message : String(error)}`,
          )
        }
        const match = expression.exec(page.body)
        if (!match) {
          throw new SelectorError(
            '页面里没有匹配到播放地址。这个源可能需要浏览器嗅探，或者站点改版了。',
          )
        }
        const group = playback.group ?? 1
        const value = match[group]
        if (!value) {
          throw new SelectorError(`正则第 ${group} 组没有捕获到内容`)
        }
        // The captured value is often a relative path or has escaped slashes.
        return absoluteUrl(value.replace(/\\\//g, '/'), page.url) ?? value
      }

      case 'api': {
        const url = fillTemplate(playback.url, { url: episodeUrl })
        const response = await this.fetcher(url, this.source, {
          method: playback.method,
          body: playback.method === 'POST' ? (playback.body ?? '') : undefined,
        })
        const json = this.parseJson(response.body)
        if (json === undefined) {
          throw new SelectorError('取流接口返回的不是 JSON')
        }
        const value = selectJson(json, playback.urlPath)[0]
        if (!value) {
          throw new SelectorError(`接口响应里没有 ${playback.urlPath} 对应的地址`)
        }
        return absoluteUrl(value, response.url) ?? value
      }

      case 'sniff': {
        // Open the episode page in a hidden browser window and watch its traffic.
        //
        // This is the slowest strategy and the only one that needs the platform's
        // help. The failure messages are deliberately specific per outcome: "no
        // address found" and "this is DRM-protected" lead to different actions, and
        // collapsing them would send a person hunting for a selector that is fine.
        const report = await sniffMedia({
          pageUrl: episodeUrl,
          sourceId: this.source.id,
          referer: this.source.request.headers.Referer ?? this.source.request.headers.referer,
          userAgent:
            this.source.request.headers['User-Agent'] ?? this.source.request.headers['user-agent'],
        })

        if (report.kind === 'found') {
          // A proxied playback of a sniffed URL still needs the referer/UA the page
          // used, and those are already on the source, so the player picks them up
          // from there.
          return report.url
        }
        throw new SelectorError(report.message)
      }
    }
  }

  /**
   * Read a media URL out of a page using one selector.
   *
   * Falls back to a regex over the raw source when the selector is a plain
   * selector but the address only exists inside an inline script — which is the
   * majority case on real anime sites, and the reason `regex` playback exists.
   */
  private async readMediaUrl(html: string, baseUrl: string, selector: string): Promise<string> {
    const payload = { html, text: html }
    const value = await this.evaluateOne(selector, payload)
    if (!value) {
      throw new SelectorError(
        '页面里没有取到播放地址。这个源可能需要浏览器嗅探，或者站点改版了。',
      )
    }
    return absoluteUrl(value, baseUrl) ?? value
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
