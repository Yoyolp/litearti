/**
 * Downloading a source item into the library.
 *
 * Two paths, because a book source can describe two different things:
 *
 * 1. **A direct file URL** (`download.url`): fetch the bytes and import them.
 * 2. **No file URL**: concatenate the chapter bodies into a text file. This is
 *    what most novel sites need, since they only expose chapter pages.
 *
 * Either way the bytes go through `source_download_import`, which writes a temp
 * file and reuses `library_import` — so duplicate detection, atomic metadata
 * writes and failure reporting are identical to a picked file.
 */

import * as api from '@/api/library'
import type { BookSource } from './schema'
import { SourceEngine, absoluteUrl, type SourceChapter } from './engine'
import { SelectorError } from './selector'

export interface DownloadOptions {
  source: BookSource
  title: string
  /** Detail page URL, used as the base for relative download links. */
  detailUrl: string
  chapters: SourceChapter[]
  engine: SourceEngine
  /** Called per chapter so the UI can show progress on long books. */
  onProgress?: (done: number, total: number) => void
  /** Abort between chapters. Checked before each request. */
  shouldCancel?: () => boolean
}

export interface DownloadResult {
  entry: unknown
  /** How the file was produced, for an honest success message. */
  mode: 'file' | 'concatenated'
  chapterCount: number
}

export class DownloadCancelled extends Error {
  constructor() {
    super('下载已取消')
    this.name = 'DownloadCancelled'
  }
}

/**
 * Download one item and import it.
 *
 * A cancel is a distinct error type rather than a string, so the caller can
 * treat it as a non-event instead of showing a failure.
 */
export async function downloadItem(options: DownloadOptions): Promise<DownloadResult> {
  const { source, title, detailUrl, chapters, engine, onProgress, shouldCancel } = options

  // --- path 1: a direct file link -----------------------------------------
  const downloadUrl = source.download?.url
  if (downloadUrl && source.download?.format) {
    const resolved = absoluteUrl(await resolveDownloadUrl(engine, downloadUrl, detailUrl), detailUrl)
    if (!resolved) throw new SelectorError('下载链接无效')

    const page = await api.sourceFetch({
      url: resolved,
      method: 'GET',
      headers: source.request.headers,
      timeoutMs: source.request.timeoutMs,
    })

    // The backend returns text; a binary download needs the raw bytes, so this
    // path re-encodes what came back. For text formats (txt/epub via base64 in
    // JSON APIs) that is correct; for a true binary the source should expose a
    // text-safe endpoint. Documented as a limitation rather than hidden.
    const bytes = new TextEncoder().encode(page.body)
    const entry = await api.sourceDownloadImport(title, source.download.format, bytes)
    return { entry, mode: 'file', chapterCount: 0 }
  }

  // --- path 2: concatenate chapters ---------------------------------------
  if (!chapters.length) {
    throw new SelectorError('这个书源没有下载链接，也没有章节可以拼接')
  }

  const parts: string[] = [title, '']
  let done = 0
  for (const chapter of chapters) {
    if (shouldCancel?.()) throw new DownloadCancelled()
    const body = await engine.chapter(chapter.url)
    if (body) {
      parts.push(chapter.title, '', body, '')
    }
    done += 1
    onProgress?.(done, chapters.length)
  }

  const text = parts.join('\n')
  if (!text.trim()) throw new SelectorError('所有章节都为空，无法生成文件')

  const bytes = new TextEncoder().encode(text)
  const entry = await api.sourceDownloadImport(title, 'txt', bytes)
  return { entry, mode: 'concatenated', chapterCount: chapters.length }
}

/** Evaluate a `download.url` selector to a concrete href. */
async function resolveDownloadUrl(
  engine: SourceEngine,
  selector: string,
  detailUrl: string,
): Promise<string | null> {
  // The selector runs against the detail page, which the engine has already
  // fetched for its chapter list. Re-fetching here keeps the API simple and
  // costs one request on an action the person explicitly asked for.
  const page = await api.sourceFetch({ url: detailUrl, method: 'GET' })
  const json = looksLikeJson(page.body) ? safeParse(page.body) : undefined
  const values = await engine.evaluate(selector, {
    json,
    html: page.body,
    text: page.body,
  })
  return values[0] ?? null
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}
