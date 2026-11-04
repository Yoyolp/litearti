/**
 * Book source definitions and their validator.
 *
 * A book source is a JSON document that describes how to read one website:
 * where to search, which selectors pull out the fields, how to get a chapter's
 * body. The point is that adding a site means writing JSON — no code, no
 * rebuild.
 *
 * The validator is hand-written rather than an off-the-shelf JSON Schema
 * implementation for one concrete reason: the format is ours, so the errors can
 * name the exact field in Chinese ("search.fields.title 缺失"). A generic
 * validator would report `instance.search.fields requires property "title"`,
 * which is correct and much less useful.
 *
 * ## On "strict" constraints and JS
 *
 * These two requirements pull against each other, and it is worth being explicit
 * rather than pretending otherwise:
 *
 * - The schema constrains **structure**: which fields exist, their types, the
 *   closed set of resource types, the closed set of selector prefixes.
 * - The schema cannot constrain what an `@js:` expression *does*. That is
 *   handled by static checks here (banned identifiers) plus the runtime sandbox
 *   (`sandbox.ts`) plus a timeout. Claiming the schema makes JS safe would be a
 *   lie.
 */

/** The closed set of resource kinds. Adding one is a schema change. */
export const RESOURCE_TYPES = ['novel', 'comic', 'audio', 'video'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

/** Selector prefixes. A field value must start with one of these. */
export const SELECTOR_PREFIXES = ['$.', 'css:', '@js:'] as const

/** Placeholders allowed in URL templates. */
export const URL_VARIABLES = ['keyword', 'page', 'id', 'url'] as const

/** Only version 1 exists; the field is here so a future change is detectable. */
export const SUPPORTED_SCHEMA_VERSION = 1

export interface RequestConfig {
  headers: Record<string, string>
  timeoutMs: number
  /** Politeness delay between consecutive requests to the same source. */
  delayMs: number
}

export interface FieldMap {
  [field: string]: string
}

export interface SearchConfig {
  url: string
  method: 'GET' | 'POST'
  body?: string
  list: string
  fields: {
    title: string
    author?: string
    cover?: string
    intro?: string
    detailUrl: string
  }
}

export interface DetailConfig {
  list: string
  fields: { title: string; url: string }
  /**
   * Selector for a **separate** table-of-contents page.
   *
   * Many sites keep the book's blurb and the chapter list on different pages:
   * the detail page has title/author/cover, and the TOC page has the chapters.
   * Without this the engine would look for `list` on the detail page, find
   * nothing, and report an empty book.
   *
   * The selector runs against the **detail** page and yields the TOC URL.
   */
  tocUrl?: string
  /** The book's own title on the detail page, distinct from a chapter title. */
  title?: string
  author?: string
  intro?: string
  cover?: string
}

export interface ChapterConfig {
  content: string
  nextUrl?: string
}

export interface DownloadConfig {
  url?: string
  format: 'txt' | 'epub' | 'pdf' | 'mp3'
}

/**
 * Declares that a source needs a login, and where to get one.
 *
 * The declaration does not carry the secret — cookies live in the credential
 * store, keyed by source id. What this block does is tell the UI to offer a
 * login button and tell the network layer which host the resulting cookie
 * belongs to. A source that omits it is simply never sent a cookie.
 */
export interface AuthConfig {
  type: 'cookie'
  /** Page to open for logging in. Defaults to `homepage`. */
  loginUrl?: string
  /** Host the cookie is scoped to. Defaults to the login URL's host. */
  host?: string
}

export interface BookSource {
  schemaVersion: number
  id: string
  name: string
  version: string
  homepage: string
  language?: string
  type: ResourceType
  enabled: boolean
  request: RequestConfig
  search: SearchConfig
  detail: DetailConfig
  chapter: ChapterConfig
  download?: DownloadConfig
  auth?: AuthConfig
}

/** One validation problem, addressed to the field that caused it. */
export interface ValidationIssue {
  /** Dotted path into the document, e.g. `search.fields.title`. */
  path: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
  /** Present only when `ok` is true. */
  source?: BookSource
}

/**
 * Identifiers an `@js:` expression may not mention.
 *
 * This is defence in depth, not the primary boundary: the sandbox has no
 * network and no parent DOM, so most of these would fail anyway. Rejecting them
 * up front turns a confusing runtime failure into a clear validation error, and
 * catches the obvious attempts early.
 */
const BANNED_IDENTIFIERS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'import(',
  'eval(',
  'new Function',
  'Function(',
  'document',
  'window',
  'parent',
  'top',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  '__TAURI_INTERNALS__',
  'require(',
  'process.',
]

const MIN_TIMEOUT = 1000
const MAX_TIMEOUT = 60000
const MAX_DELAY = 10000

class Issues {
  readonly list: ValidationIssue[] = []

  add(path: string, message: string): void {
    this.list.push({ path, message })
  }

  /** Require a non-empty string at `path`. */
  string(parent: Record<string, unknown> | undefined, path: string, key: string, required = true): string | undefined {
    const value = parent?.[key]
    if (value === undefined || value === null) {
      if (required) this.add(path, '必填字段缺失')
      return undefined
    }
    if (typeof value !== 'string') {
      this.add(path, `应为字符串，实际是 ${typeName(value)}`)
      return undefined
    }
    if (!value.trim()) {
      this.add(path, '不能为空')
      return undefined
    }
    return value
  }

  /** Require a number in a range. */
  number(
    parent: Record<string, unknown> | undefined,
    path: string,
    key: string,
    min: number,
    max: number,
    required = true,
  ): number | undefined {
    const value = parent?.[key]
    if (value === undefined || value === null) {
      if (required) this.add(path, '必填字段缺失')
      return undefined
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.add(path, `应为数字，实际是 ${typeName(value)}`)
      return undefined
    }
    if (value < min || value > max) {
      this.add(path, `应在 ${min}–${max} 之间，实际是 ${value}`)
      return undefined
    }
    return value
  }

  /** Require an object. */
  object(parent: Record<string, unknown> | undefined, path: string, key: string, required = true): Record<string, unknown> | undefined {
    const value = parent?.[key]
    if (value === undefined || value === null) {
      if (required) this.add(path, '必填字段缺失')
      return undefined
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.add(path, `应为对象，实际是 ${typeName(value)}`)
      return undefined
    }
    return value as Record<string, unknown>
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  return typeof value === 'object' ? '对象' : typeof value
}

/** A selector must start with a known prefix. */
function checkSelector(issues: Issues, path: string, value: string): void {
  if (!SELECTOR_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    issues.add(path, `选择器必须以 ${SELECTOR_PREFIXES.join(' / ')} 之一开头`)
    return
  }
  if (value.startsWith('@js:')) {
    checkJsExpression(issues, path, value.slice('@js:'.length))
  }
}

/** Static checks on an `@js:` body. */
function checkJsExpression(issues: Issues, path: string, expression: string): void {
  if (!expression.trim()) {
    issues.add(path, 'JS 表达式为空')
    return
  }
  for (const banned of BANNED_IDENTIFIERS) {
    if (expression.includes(banned)) {
      issues.add(path, `JS 表达式不能使用 ${banned}（沙箱不提供网络与 DOM）`)
    }
  }
  // A crude balance check catches the most common authoring mistake (a
  // truncated expression) without pretending to be a parser.
  const pairs: [string, string][] = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ]
  for (const [open, close] of pairs) {
    const opened = (expression.match(new RegExp(`\\${open}`, 'g')) ?? []).length
    const closed = (expression.match(new RegExp(`\\${close}`, 'g')) ?? []).length
    if (opened !== closed) {
      issues.add(path, `JS 表达式括号不匹配（${open} ${opened} 个，${close} ${closed} 个）`)
      break
    }
  }
}

/** A URL template may only use known placeholders. */
function checkUrlTemplate(issues: Issues, path: string, template: string): void {
  let url: URL
  try {
    // Substitute placeholders with a dummy value so the URL parses. This also
    // catches templates that are not URLs at all.
    url = new URL(template.replace(/\{\{(\w+)\}\}/g, 'x'))
  } catch {
    issues.add(path, '不是合法的 URL')
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    issues.add(path, `只支持 http/https，实际是 ${url.protocol}`)
  }

  const used = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? '')
  for (const name of used) {
    if (!URL_VARIABLES.includes(name as (typeof URL_VARIABLES)[number])) {
      issues.add(path, `未知的占位符 {{${name}}}，可用：${URL_VARIABLES.join(' / ')}`)
    }
  }
}

/**
 * Validate one parsed JSON document as a book source.
 *
 * Returns every issue rather than the first, so a person fixing a source sees
 * the whole list instead of playing whack-a-mole.
 */
export function validateSource(input: unknown): ValidationResult {
  const issues = new Issues()

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ path: '', message: '书源必须是一个 JSON 对象' }] }
  }
  const root = input as Record<string, unknown>

  // --- identity ---
  const schemaVersion = root.schemaVersion
  if (schemaVersion === undefined) {
    issues.add('schemaVersion', '必填字段缺失')
  } else if (typeof schemaVersion !== 'number') {
    issues.add('schemaVersion', `应为数字，实际是 ${typeName(schemaVersion)}`)
  } else if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    issues.add('schemaVersion', `不支持的版本 ${schemaVersion}，当前支持 ${SUPPORTED_SCHEMA_VERSION}`)
  }

  const id = issues.string(root, 'id', 'id')
  if (id !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    issues.add('id', '只能用字母、数字、下划线和连字符，且以字母或数字开头，最长 64')
  }

  issues.string(root, 'name', 'name')
  issues.string(root, 'version', 'version')

  const homepage = issues.string(root, 'homepage', 'homepage')
  if (homepage !== undefined) {
    try {
      const url = new URL(homepage)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        issues.add('homepage', `只支持 http/https，实际是 ${url.protocol}`)
      }
    } catch {
      issues.add('homepage', '不是合法的 URL')
    }
  }

  issues.string(root, 'language', 'language', false)

  const type = root.type
  if (type === undefined) {
    issues.add('type', '必填字段缺失')
  } else if (typeof type !== 'string' || !RESOURCE_TYPES.includes(type as ResourceType)) {
    issues.add('type', `应为 ${RESOURCE_TYPES.join(' / ')} 之一，实际是 ${String(type)}`)
  }

  if (root.enabled !== undefined && typeof root.enabled !== 'boolean') {
    issues.add('enabled', `应为布尔值，实际是 ${typeName(root.enabled)}`)
  }

  // --- request ---
  const request = issues.object(root, 'request', 'request')
  if (request) {
    const headers = request.headers
    if (headers !== undefined) {
      if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
        issues.add('request.headers', `应为对象，实际是 ${typeName(headers)}`)
      } else {
        for (const [key, value] of Object.entries(headers)) {
          if (typeof value !== 'string') {
            issues.add(`request.headers.${key}`, `应为字符串，实际是 ${typeName(value)}`)
          }
        }
      }
    }
    issues.number(request, 'request.timeoutMs', 'timeoutMs', MIN_TIMEOUT, MAX_TIMEOUT, false)
    issues.number(request, 'request.delayMs', 'delayMs', 0, MAX_DELAY, false)
  }

  // --- search ---
  const search = issues.object(root, 'search', 'search')
  if (search) {
    const url = issues.string(search, 'search.url', 'url')
    if (url !== undefined) checkUrlTemplate(issues, 'search.url', url)

    const method = search.method
    if (method !== undefined && method !== 'GET' && method !== 'POST') {
      issues.add('search.method', `应为 GET 或 POST，实际是 ${String(method)}`)
    }
    issues.string(search, 'search.body', 'body', false)

    const list = issues.string(search, 'search.list', 'list')
    if (list !== undefined) checkSelector(issues, 'search.list', list)

    const fields = issues.object(search, 'search.fields', 'fields')
    if (fields) {
      const title = issues.string(fields, 'search.fields.title', 'title')
      if (title !== undefined) checkSelector(issues, 'search.fields.title', title)

      const detailUrl = issues.string(fields, 'search.fields.detailUrl', 'detailUrl')
      if (detailUrl !== undefined) checkSelector(issues, 'search.fields.detailUrl', detailUrl)

      // `type` used to be listed here but the engine never read it — the card's
      // resource kind comes from the source-level `type`. Keeping a config key
      // that does nothing is worse than not having it.
      for (const optional of ['author', 'cover', 'intro']) {
        const value = issues.string(fields, `search.fields.${optional}`, optional, false)
        if (value !== undefined) checkSelector(issues, `search.fields.${optional}`, value)
      }
    }
  }

  // --- detail ---
  const detail = issues.object(root, 'detail', 'detail')
  if (detail) {
    const list = issues.string(detail, 'detail.list', 'list')
    if (list !== undefined) checkSelector(issues, 'detail.list', list)

    const fields = issues.object(detail, 'detail.fields', 'fields')
    if (fields) {
      for (const key of ['title', 'url'] as const) {
        const value = issues.string(fields, `detail.fields.${key}`, key)
        if (value !== undefined) checkSelector(issues, `detail.fields.${key}`, value)
      }
    }

    for (const optional of ['title', 'author', 'intro', 'cover', 'tocUrl']) {
      const value = issues.string(detail, `detail.${optional}`, optional, false)
      if (value !== undefined) checkSelector(issues, `detail.${optional}`, value)
    }
  }

  // --- chapter ---
  const chapter = issues.object(root, 'chapter', 'chapter')
  if (chapter) {
    const content = issues.string(chapter, 'chapter.content', 'content')
    if (content !== undefined) checkSelector(issues, 'chapter.content', content)

    const nextUrl = issues.string(chapter, 'chapter.nextUrl', 'nextUrl', false)
    if (nextUrl !== undefined) checkSelector(issues, 'chapter.nextUrl', nextUrl)
  }

  // --- download (optional) ---
  const download = issues.object(root, 'download', 'download', false)
  if (download) {
    const url = issues.string(download, 'download.url', 'url', false)
    if (url !== undefined) checkSelector(issues, 'download.url', url)

    const format = download.format
    const formats = ['txt', 'epub', 'pdf', 'mp3']
    if (format === undefined) {
      issues.add('download.format', '必填字段缺失')
    } else if (typeof format !== 'string' || !formats.includes(format)) {
      issues.add('download.format', `应为 ${formats.join(' / ')} 之一，实际是 ${String(format)}`)
    }
  }

  // --- auth (optional) ---
  const auth = issues.object(root, 'auth', 'auth', false)
  if (auth) {
    const kind = auth.type
    if (kind === undefined) {
      issues.add('auth.type', '必填字段缺失')
    } else if (kind !== 'cookie') {
      issues.add('auth.type', `应为 cookie，实际是 ${String(kind)}`)
    }

    const loginUrl = issues.string(auth, 'auth.loginUrl', 'loginUrl', false)
    if (loginUrl !== undefined) {
      try {
        const parsed = new URL(loginUrl)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          issues.add('auth.loginUrl', `只支持 http/https，实际是 ${parsed.protocol}`)
        }
      } catch {
        issues.add('auth.loginUrl', '不是合法的 URL')
      }
    }

    // A bare hostname, not a URL: the value is used for comparison against a
    // request's host, so a scheme or path in it could only ever fail to match.
    const host = issues.string(auth, 'auth.host', 'host', false)
    if (host !== undefined && /[:/?#@]/.test(host)) {
      issues.add('auth.host', '应为主机名（不含协议、端口与路径），例如 example.com')
    }
  }

  if (issues.list.length) return { ok: false, issues: issues.list }

  // Safe to assemble: every required field was checked above.
  const source: BookSource = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    id: id as string,
    name: root.name as string,
    version: root.version as string,
    homepage: homepage as string,
    language: (root.language as string | undefined) ?? undefined,
    type: type as ResourceType,
    enabled: (root.enabled as boolean | undefined) ?? true,
    request: {
      headers: (request?.headers as Record<string, string> | undefined) ?? {},
      timeoutMs: (request?.timeoutMs as number | undefined) ?? 15000,
      delayMs: (request?.delayMs as number | undefined) ?? 300,
    },
    search: {
      url: search!.url as string,
      method: (search!.method as 'GET' | 'POST' | undefined) ?? 'GET',
      body: search!.body as string | undefined,
      list: search!.list as string,
      fields: search!.fields as SearchConfig['fields'],
    },
    detail: {
      list: detail!.list as string,
      fields: detail!.fields as DetailConfig['fields'],
      tocUrl: detail!.tocUrl as string | undefined,
      title: detail!.title as string | undefined,
      author: detail!.author as string | undefined,
      intro: detail!.intro as string | undefined,
      cover: detail!.cover as string | undefined,
    },
    chapter: {
      content: chapter!.content as string,
      nextUrl: chapter!.nextUrl as string | undefined,
    },
    download: download
      ? {
          url: download.url as string | undefined,
          format: download.format as DownloadConfig['format'],
        }
      : undefined,
    // The secret itself is never part of a source: only the declaration that a
    // login exists, and which host it applies to.
    auth: auth
      ? {
          type: 'cookie',
          loginUrl: auth.loginUrl as string | undefined,
          host: auth.host as string | undefined,
        }
      : undefined,
  }

  return { ok: true, issues: [], source }
}

/** Validate a whole file that should contain an array of sources. */
export function validateSourceFile(input: unknown): {
  ok: boolean
  issues: ValidationIssue[]
  sources: BookSource[]
} {
  const list = Array.isArray(input) ? input : [input]
  const issues: ValidationIssue[] = []
  const sources: BookSource[] = []
  const seen = new Map<string, number>()

  list.forEach((item, index) => {
    const result = validateSource(item)
    const prefix = Array.isArray(input) ? `[${index}]` : ''
    if (!result.ok) {
      for (const issue of result.issues) {
        issues.push({ path: `${prefix}${issue.path ? `.${issue.path}` : ''}`, message: issue.message })
      }
      return
    }
    const source = result.source!
    const previous = seen.get(source.id)
    if (previous !== undefined) {
      issues.push({
        path: `${prefix}id`,
        message: `id「${source.id}」与第 ${previous + 1} 个书源重复`,
      })
      return
    }
    seen.set(source.id, index)
    sources.push(source)
  })

  return { ok: issues.length === 0, issues, sources }
}
