/**
 * Chapter detection for plain-text novels.
 *
 * A downloaded `.txt` novel is usually one long file with chapter headings in
 * the text: `第一章 少年`, `第 12 章`, `Chapter 3`. Finding those headings lets the
 * reader page through it the way the EPUB viewer does, instead of scrolling a
 * multi-megabyte wall.
 *
 * ## Why this is conservative
 *
 * A false positive splits a narrative in half, which is worse than not
 * splitting at all — the reader shows a "chapter" that starts mid-sentence.
 * A false negative just leaves the file as it was. So every rule here is
 * biased toward "not a heading":
 *
 * - the heading must start a line;
 * - the line must be short (a real heading is a title, not a paragraph);
 * - after the unit character (`章`/`节`/…) there must be whitespace, a separator,
 *   or end-of-line — this is what rejects `第一节课`, which is prose;
 * - the line must not end with sentence punctuation;
 * - at least three headings must be found before the file is treated as
 *   chaptered. Two matches in a 500 KB file are coincidence.
 */

export interface TextChapter {
  /** Display title, taken verbatim from the heading line. */
  title: string
  /** First line index of the chapter body (the heading line). */
  start: number
  /** Exclusive end line index. */
  end: number
}

/** A heading is a title, not a paragraph. */
const MAX_HEADING_LENGTH = 40

/** Chinese numerals plus ASCII and full-width digits. */
const NUM = '[0-9０-９零〇一二三四五六七八九十百千万两]+'

/**
 * `第一章 标题` / `第 12 章` / `第一卷` / `第三节` / `第一百二十三回`.
 *
 * The trailing group requires whitespace, a separator, or end-of-line after the
 * unit character. Without it, `第一节课` and `第二天` would match; with it they do
 * not, because `课` and `天` are neither.
 */
const CN_HEADING = new RegExp(
  `^第\\s*${NUM}\\s*[章节回卷集部篇](?:[\\s:：、.．·\\-—_]+.*)?$`,
)

/** `Chapter 12 标题` / `CHAPTER 1`. */
const EN_HEADING = /^(?:chapter|part)\s+[0-9０-９ivxlcdm]+\b.{0,30}$/i

/** Lines that look like a heading but are really prose. */
const SENTENCE_END = /[。！？…」』”’"']$/

/** Minimum headings before the file is treated as chaptered. */
const MIN_CHAPTERS = 3

/** Whether one line is a chapter heading. */
export function isChapterHeading(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) return false
  // A heading never ends a sentence; prose that happens to start with 第 does.
  if (SENTENCE_END.test(trimmed)) return false
  return CN_HEADING.test(trimmed) || EN_HEADING.test(trimmed)
}

/**
 * Split text into chapters.
 *
 * Returns an empty array when the file does not look chaptered — the caller then
 * keeps its single-document behaviour. Content before the first heading is kept
 * as a preface chapter when it is more than a title page's worth of text, since
 * dropping it would lose the book's front matter.
 */
export function splitChapters(text: string): TextChapter[] {
  if (!text) return []

  const lines = text.split(/\r\n|\r|\n/)
  const starts: { line: number; title: string }[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (isChapterHeading(line)) {
      starts.push({ line: i, title: line.trim() })
    }
  }

  if (starts.length < MIN_CHAPTERS) return []

  const chapters: TextChapter[] = []

  // Front matter: only kept when it is substantial, otherwise it is just the
  // title and author lines and would render as an empty chapter.
  const firstStart = starts[0]!.line
  if (firstStart > 0) {
    const preface = lines.slice(0, firstStart).join('\n').trim()
    if (preface.length > 20) {
      chapters.push({ title: '前言', start: 0, end: firstStart })
    }
  }

  for (let i = 0; i < starts.length; i += 1) {
    const current = starts[i]!
    const next = starts[i + 1]
    chapters.push({
      title: current.title,
      start: current.line,
      end: next ? next.line : lines.length,
    })
  }

  return chapters
}

/** Lines belonging to one chapter, heading excluded. */
export function chapterBody(lines: readonly string[], chapter: TextChapter): string[] {
  // Skip the heading line itself: it is already shown in the reader's header,
  // and repeating it as the first paragraph reads like a typo.
  return lines.slice(chapter.start + 1, chapter.end)
}

/**
 * Which chapter contains a whole-document ratio.
 *
 * Used to migrate progress written before chapters existed: that payload stored
 * one ratio for the entire file, and the reader now needs a chapter index.
 * Mapping by line position keeps the reader roughly where it was instead of
 * sending them back to the start.
 */
export function chapterAtRatio(chapters: readonly TextChapter[], totalLines: number, ratio: number): number {
  if (!chapters.length || totalLines <= 0) return 0
  const targetLine = Math.min(totalLines - 1, Math.max(0, ratio) * totalLines)
  for (let i = chapters.length - 1; i >= 0; i -= 1) {
    if (chapters[i]!.start <= targetLine) return i
  }
  return 0
}
