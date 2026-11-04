#!/usr/bin/env node
/**
 * Convert Legado (阅读) book sources into litearti's format.
 *
 *   node scripts/legado-convert.mjs <input.json> [--out sources/from-legado]
 *
 * The two formats are *not* equivalent. This tool converts the subset that maps
 * cleanly and reports, per source, exactly what could not be carried over —
 * because a half-converted source that silently returns nothing is worse than an
 * honest refusal.
 *
 * See docs/legado-conversion.md for the mapping table and why some rules have
 * no equivalent.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

// --- rule translation -----------------------------------------------------

/** `//meta[@property='og:x']/@content` — the one XPath shape we can rewrite. */
const META_XPATH = /^\/\/meta\[@(?:property|name)=['"]([^'"]+)['"]\]\/@content$/

/** Attributes Legado extracts with a trailing `@name`. */
const ATTR_TAIL = new Set([
  'href', 'src', 'data-src', 'data-lazy', 'data-original', 'onclick', 'title',
  'content', 'data-bid', 'alt', 'value', 'id',
])

/** Extraction modes; our engine always returns text, so they are dropped. */
const EXTRACT_TAIL = new Set(['text', 'html', 'textnodes', 'owntext', 'all', 'string'])

/** Things that make a rule unportable, with the reason. */
const BLOCKERS = [
  [/\bjava\.(ajax|getElement|startBrowserAwait|put|get|post|base64|toast|longToast|hexDecode|timeFormat|androidId|getCookie|getVerificationCode|encodeURI|setContent)\b/, 'java.* 调用', '沙箱没有 Java 桥（ajax / 浏览器 / 变量存取都不提供）'],
  [/\bsource\.(getVariable|setVariable|getLoginInfoMap|getKey|bookSourceUrl|loginUrl)\b/, 'source.* 调用', '沙箱不提供 source 对象'],
  [/\bcookie\.(getCookie|setCookie|removeCookie)\b/, 'cookie.* 调用', '本引擎不维护 cookie jar（该功能搁置）'],
  [/\borg\.jsoup\./, 'jsoup 调用', '沙箱里没有 Jsoup'],
  [/\bbook\.(durChapterTitle|origin|type|name|author)\b/, 'book.* 运行时变量', '规则引用了阅读器的运行时对象'],
  [/\bjava\.startBrowserAwait\b/, '浏览器等待', '需要人工在网页里操作（验证码/登录），本引擎没有该能力'],
]

function blockerFor(rule) {
  for (const [pattern, name, reason] of BLOCKERS) {
    if (pattern.test(rule)) return { name, reason }
  }
  return null
}

/** Strip Legado's `##pattern##replacement`; we cannot apply it. */
function splitTransform(rule) {
  const at = rule.indexOf('##')
  return at < 0 ? { body: rule, transform: null } : { body: rule.slice(0, at), transform: rule.slice(at) }
}

/**
 * Turn a Legado selector expression into plain CSS.
 *
 * Handles the shorthands that appear in real sources:
 *   `class.a.b.0@tag.c@text`   → `.a.b c`
 *   `#author@tbody@tr!0`       → `#author tbody tr`
 *   `.odd.0`                   → `.odd`
 *   `a@href`                   → `a` + attribute `href`
 */
function legadoSelectorToCss(body) {
  const warnings = []
  let text = body.trim()
  let attr = null

  // Trailing extraction mode, e.g. `@text`, `@html`, `@textNodes`.
  const extractMatch = /@([a-zA-Z]+)$/.exec(text)
  if (extractMatch && EXTRACT_TAIL.has(extractMatch[1].toLowerCase())) {
    if (extractMatch[1].toLowerCase() === 'html') warnings.push('`@html` 已降级为纯文本（引擎不注入 HTML）')
    text = text.slice(0, extractMatch.index)
  } else if (extractMatch && ATTR_TAIL.has(extractMatch[1].toLowerCase())) {
    attr = extractMatch[1]
    text = text.slice(0, extractMatch.index)
  }

  const segments = text.split('@').map((s) => s.trim()).filter(Boolean)
  if (!segments.length) return { selector: attr ? `css:@${attr}` : null, warnings }

  const parts = []
  for (let segment of segments) {
    // `children[0]` / `children` is Legado's "direct children" step. In CSS a
    // descendant combinator reaches the same elements for our purposes.
    if (/^children(\[\d+\])?$/i.test(segment)) {
      warnings.push('`children` 已降级为后代选择器')
      continue
    }

    // Legado `!0` means "skip the first match". Our list step already skips
    // rows whose title selector yields nothing (that is how table headers are
    // filtered), so dropping it is safe — but say so.
    if (/(^|\.)!-?\d+$/.test(segment)) {
      segment = segment.replace(/!-?\d+$/, '')
      warnings.push('已忽略 `!0`（排除首项）：本引擎会自动跳过取不到标题的行')
    }

    const shorthand = /^(class|id|tag|text)\.(.+)$/.exec(segment)
    if (shorthand) {
      const kind = shorthand[1]
      const allParts = shorthand[2].split('.')
      const names = allParts.filter((p) => !/^-?\d+$/.test(p))
      if (names.length !== allParts.length) warnings.push('索引已忽略（引擎取第一个匹配）')
      if (!names.length) continue
      if (kind === 'class') parts.push(...names.map((n) => `.${n}`))
      else if (kind === 'id') parts.push(`#${names[0]}`)
      else if (kind === 'tag') parts.push(names[0])
      else warnings.push('`text.` 定位已忽略（无法等价表达）')
      continue
    }

    // Plain CSS segment; drop a trailing numeric index (`.0`, `.-1`).
    const cleaned = segment.replace(/\.-?\d+$/, '')
    if (cleaned !== segment) warnings.push('索引已忽略（引擎取第一个匹配）')
    if (cleaned) parts.push(cleaned)
  }

  const query = parts.join(' ').trim()
  if (!query) return { selector: attr ? `css:@${attr}` : null, warnings }
  return { selector: `css:${query}${attr ? `@${attr}` : ''}`, warnings }
}

/**
 * Translate one Legado rule into a selector our engine understands.
 *
 * Returns `{ selector }` on success, `{ error }` when the rule needs something
 * the engine lacks.
 */
function translateRule(rule, context) {
  if (typeof rule !== 'string' || !rule.trim()) return { selector: undefined }
  const raw = rule.trim()

  const blocked = blockerFor(raw)
  if (blocked) return { error: `${blocked.name}：${blocked.reason}` }

  const { body, transform } = splitTransform(raw)
  const warnings = []
  if (transform) warnings.push(`\`${transform}\` 正则变换已丢弃（引擎不支持）`)

  const meta = META_XPATH.exec(body)
  if (meta) return { selector: `css:meta[property="${meta[1]}"]@content`, warnings }
  if (body.startsWith('//') || body.startsWith('(')) {
    return { error: 'XPath 规则：引擎不支持 XPath，需要手工改写成 CSS' }
  }

  if (body.startsWith('$.')) return { selector: body, warnings }
  if (body.startsWith('css:')) return { selector: body, warnings }
  if (body.startsWith('@js:')) return { selector: body, warnings }

  // Legado often takes an attribute and then runs JS over it
  // (`@onclick@js:result.match(...)`). Our field selectors on a CSS list are
  // synchronous CSS only, so this cannot be carried over — and emitting a
  // broken selector would silently return nothing.
  if (body.includes('@js:')) {
    return { error: '属性后接 @js: 处理：CSS 列表字段不支持 JS（改用 @js: 整体取 input）' }
  }

  // A bare keyword means "on the current element".
  if (/^(text|html|textNodes|ownText|all)$/i.test(body)) {
    if (/^(html|textNodes)$/i.test(body)) warnings.push('`@html` 已降级为纯文本')
    return { selector: 'css:', warnings }
  }
  if (ATTR_TAIL.has(body.toLowerCase())) {
    return { selector: `css:@${body.toLowerCase()}`, warnings }
  }

  // `{{$.field}}` inside a URL — expressible only for JSON lists. Several
  // placeholders may appear in one rule, so build one concatenation.
  if (/\{\{\$\.\w+\}\}/.test(body)) {
    if (context?.listKind !== 'json') {
      return { error: '规则里嵌了 {{$.字段}}，但列表不是 JSON，无法自动改写' }
    }
    const quoted = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    const pieces = []
    let last = 0
    for (const match of body.matchAll(/\{\{\$\.([\w.]+)\}\}/g)) {
      const [whole, field] = match
      const prefix = body.slice(last, match.index)
      if (prefix) pieces.push(quoted(prefix))
      pieces.push(`String(input.${field})`)
      last = match.index + whole.length
    }
    const tail = body.slice(last)
    if (tail) pieces.push(quoted(tail))
    return {
      selector: `@js:${pieces.join('+')}`,
      warnings: [...warnings, '已改写为 @js: 拼接（仅 JSON 列表可用）'],
    }
  }

  // Regex-based chapter lists (`:"sS":(\d),..."`) are not selectors at all.
  if (/^:|^\(\?|\\d|\\w/.test(body)) {
    return { error: '这是正则表达式而非选择器，引擎不支持' }
  }

  const converted = legadoSelectorToCss(body)
  if (converted.selector) return { selector: converted.selector, warnings: [...warnings, ...converted.warnings] }

  return { error: `无法识别的规则写法：${body.slice(0, 60)}` }
}

// --- source conversion ----------------------------------------------------

function parseHeader(raw) {
  if (!raw || !raw.trim()) return { headers: {}, warnings: [] }
  const headers = {}
  for (const m of raw.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]*)['"]/g)) {
    headers[m[1]] = m[2]
  }
  return {
    headers,
    warnings: Object.keys(headers).length ? [] : ['请求头无法解析，已忽略'],
  }
}

function mapType(value) {
  if (value === 1) return 'audio'
  if (value === 2) return 'comic'
  return 'novel'
}

function makeId(url, name) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  } catch {
    const slug = String(name).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')
    return (slug || 'source').slice(0, 48).toLowerCase()
  }
}

/** Resolve Legado's relative search paths against the source's own site. */
function absoluteUrl(url, base) {
  if (/^https?:\/\//i.test(url)) return url
  if (!base) return url
  // String join rather than `new URL` so `{{keyword}}` survives untouched.
  const trimmedBase = base.replace(/\/+$/, '')
  const path = url.startsWith('/') ? url : `/${url}`
  return `${trimmedBase}${path}`
}

function parseSearchUrl(raw, homepage) {
  const warnings = []
  let url = String(raw ?? '').trim()
  let method = 'GET'
  let body
  let charset

  const brace = url.lastIndexOf(',{')
  if (brace >= 0) {
    const options = url.slice(brace + 1)
    url = url.slice(0, brace)
    if (/['"]?method['"]?\s*:\s*['"]?post['"]?/i.test(options)) method = 'POST'
    const bodyMatch = /['"]?body['"]?\s*:\s*['"]([^'"]*)['"]/i.exec(options)
    if (bodyMatch) body = bodyMatch[1]
    const charsetMatch = /['"]?charset['"]?\s*:\s*['"]([^'"]*)['"]/i.exec(options)
    if (charsetMatch) charset = charsetMatch[1].toLowerCase()
  }

  if (!/^https?:\/\//i.test(url)) {
    url = absoluteUrl(url, homepage)
    warnings.push('搜索地址原为相对路径，已按站点地址补全')
  }

  url = url.replace(/\{\{\s*key\s*\}\}/g, '{{keyword}}')
  if (/\{\{\s*page\s*-\s*1\s*\}\}/.test(url)) {
    warnings.push('分页从 0 开始（{{page-1}}），已改为 {{page}}，页码会差 1')
    url = url.replace(/\{\{\s*page\s*-\s*1\s*\}\}/g, '{{page}}')
  }
  if (body) body = body.replace(/\{\{\s*key\s*\}\}/g, '{{keyword}}')

  if (charset && charset !== 'utf-8') {
    warnings.push(`站点使用 ${charset.toUpperCase()} 编码：引擎目前按 UTF-8 解码，中文会乱码`)
  }
  return { url, method, body, warnings }
}

/**
 * Legado's `ruleBookInfo.init` rebases every detail rule onto a sub-path
 * (`$.data`). Our engine has no `init`, so the prefix is folded into each rule.
 */
function applyInit(selector, init) {
  if (!selector || !init || !init.startsWith('$.')) return selector
  const rest = init.slice(1) // `.data`
  if (selector.startsWith('$.')) return `${init}${selector.slice(1)}`
  if (selector.startsWith('@js:')) {
    const path = rest.slice(1) // `data`
    return selector.replace(/\binput\./g, `input.${path}.`)
  }
  return selector
}

function convertOne(legado, index) {
  const errors = []
  const warnings = []
  const name = legado.bookSourceName ?? `未命名-${index}`

  if (!legado.bookSourceUrl) errors.push('缺少 bookSourceUrl')
  if (!legado.searchUrl && !legado.ruleSearch?.bookList) {
    errors.push('既没有 searchUrl 也没有 ruleSearch.bookList，无法搜索')
  }

  const { url: searchUrl, method, body, warnings: searchWarnings } = parseSearchUrl(
    legado.searchUrl,
    legado.bookSourceUrl,
  )
  warnings.push(...searchWarnings)

  const { headers, warnings: headerWarnings } = parseHeader(legado.header)
  warnings.push(...headerWarnings)

  const search = legado.ruleSearch ?? {}
  const toc = legado.ruleToc ?? {}
  const info = legado.ruleBookInfo ?? {}
  const content = legado.ruleContent ?? {}

  const listRule = translateRule(search.bookList, { listKind: 'list' })
  if (listRule.error) errors.push(`搜索列表：${listRule.error}`)
  warnings.push(...(listRule.warnings ?? []))
  const listKind = listRule.selector?.startsWith('$.') ? 'json' : 'css'

  const field = (rule, label, kind = listKind) => {
    const result = translateRule(rule, { listKind: kind })
    if (result.error) errors.push(`${label}：${result.error}`)
    warnings.push(...(result.warnings ?? []))
    return result.selector
  }

  const searchTitle = field(search.name, '搜索结果标题')
  const searchUrlField = field(search.bookUrl, '搜索结果书页地址')
  const searchAuthor = field(search.author, '搜索结果作者')
  const searchCover = field(search.coverUrl, '搜索结果封面')
  const searchIntro = field(search.intro, '搜索结果简介')

  // A separate TOC page is supported via `detail.tocUrl`.
  const init = typeof info.init === 'string' ? info.init : undefined
  if (info.init && !String(info.init).startsWith('$.')) {
    warnings.push(`ruleBookInfo.init 不是 JSONPath（${String(info.init).slice(0, 30)}），已忽略`)
  }
  const tocUrlRule = info.tocUrl ? translateRule(info.tocUrl, { listKind }) : { selector: undefined }
  if (tocUrlRule.error) errors.push(`目录页地址：${tocUrlRule.error}`)
  if (tocUrlRule.selector) tocUrlRule.selector = applyInit(tocUrlRule.selector, init)

  const chapterList = translateRule(toc.chapterList, { listKind: 'css' })
  if (chapterList.error) errors.push(`章节列表：${chapterList.error}`)
  // Chapter fields follow the chapter list's kind, not the search list's.
  const chapterKind = chapterList.selector?.startsWith('$.') ? 'json' : 'css'
  const chapterName = field(toc.chapterName, '章节标题', chapterKind)
  const chapterUrl = field(toc.chapterUrl, '章节地址', chapterKind)

  const contentRule = translateRule(content.content, { listKind: 'page' })
  if (contentRule.error) errors.push(`正文：${contentRule.error}`)
  const nextRule = content.nextContentUrl
    ? translateRule(content.nextContentUrl, { listKind: 'page' })
    : { selector: undefined }
  if (nextRule.error) errors.push(`下一页：${nextRule.error}`)

  const detailTitle = applyInit(field(info.name, '书籍标题', 'page'), init)
  const detailAuthor = applyInit(field(info.author, '书籍作者', 'page'), init)
  const detailIntro = applyInit(field(info.intro, '书籍简介', 'page'), init)
  const detailCover = applyInit(field(info.coverUrl, '书籍封面', 'page'), init)

  if (errors.length) return { name, ok: false, errors, warnings }

  const source = {
    schemaVersion: 1,
    id: makeId(legado.bookSourceUrl, name),
    name,
    version: '1.0.0',
    homepage: legado.bookSourceUrl,
    type: mapType(legado.bookSourceType),
    enabled: legado.enabled !== false,
    request: { headers, timeoutMs: 20000, delayMs: 500 },
    search: {
      url: searchUrl,
      method,
      ...(body ? { body } : {}),
      list: listRule.selector,
      fields: {
        title: searchTitle,
        ...(searchAuthor ? { author: searchAuthor } : {}),
        ...(searchCover ? { cover: searchCover } : {}),
        ...(searchIntro ? { intro: searchIntro } : {}),
        detailUrl: searchUrlField,
      },
    },
    detail: {
      list: chapterList.selector,
      fields: { title: chapterName, url: chapterUrl },
      ...(tocUrlRule.selector ? { tocUrl: tocUrlRule.selector } : {}),
      ...(detailTitle ? { title: detailTitle } : {}),
      ...(detailAuthor ? { author: detailAuthor } : {}),
      ...(detailIntro ? { intro: detailIntro } : {}),
      ...(detailCover ? { cover: detailCover } : {}),
    },
    chapter: {
      content: contentRule.selector,
      ...(nextRule.selector ? { nextUrl: nextRule.selector } : {}),
    },
  }

  return { name, ok: true, source, errors, warnings }
}

// --- CLI ------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const input = args[0]
  if (!input) {
    console.error('用法: node scripts/legado-convert.mjs <input.json> [--out <dir>]')
    process.exit(2)
  }
  const outIndex = args.indexOf('--out')
  const outDir = outIndex >= 0 ? args[outIndex + 1] : 'sources/from-legado'

  const raw = JSON.parse(await readFile(input, 'utf8'))
  const list = Array.isArray(raw) ? raw : [raw]

  console.log(`共 ${list.length} 个书源\n`)
  const converted = []

  for (const [index, item] of list.entries()) {
    const result = convertOne(item, index)
    console.log(`${result.ok ? '✅ 可转换' : '❌ 无法转换'}  ${result.name}`)
    for (const error of result.errors) console.log(`       ✗ ${error}`)
    for (const warning of result.warnings) console.log(`       ! ${warning}`)
    if (result.ok) {
      const file = join(outDir, `${result.source.id}.json`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify(result.source, null, 2)}\n`, 'utf8')
      converted.push(result.source.id)
    }
  }

  console.log(`\n${converted.length}/${list.length} 可自动转换`)
  if (converted.length) console.log(`已写入 ${outDir}/：${converted.join(', ')}`)
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exit(1)
})
