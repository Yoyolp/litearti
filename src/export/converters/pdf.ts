/**
 * PDF → plain text.
 *
 * This is a **lossy** conversion and the code says so rather than pretending
 * otherwise. A PDF has no reading order: it has glyphs at coordinates. What can
 * be recovered is the text stream per page, grouped into lines by vertical
 * position. What cannot be recovered is layout, images, tables, columns, and
 * anything that was never text (a scanned page yields nothing at all).
 *
 * Design choices that follow from that:
 *
 * - **Page markers are kept.** When the result is compared against the original
 *   PDF, a page number is the only anchor a reader has. Without it, a 300-page
 *   book becomes an undifferentiated wall of text.
 * - **Lines are rebuilt from coordinates**, not from the order items arrive in.
 *   pdf.js emits items in content-stream order, which for a two-column paper is
 *   left column then right column — rebuilding by y-then-x is what makes the
 *   output read left-to-right in the common single-column case.
 * - **No attempt at paragraphs.** A blank-line heuristic would be guesswork;
 *   guessing wrong merges unrelated sections.
 */

import type { ConvertInput } from '../registry'

/** A text item as pdf.js reports it, narrowed to the fields used here. */
interface RawItem {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

/** Vertical distance (in PDF units) under which two items share a line. */
const LINE_TOLERANCE = 2

export async function pdfToText(input: ConvertInput): Promise<string> {
  const bytes = await input.readBinary()

  // Imported lazily so the ~470 KB engine is only fetched when someone
  // actually exports a PDF, matching how the PDF viewer loads it.
  const pdfjs = await import('pdfjs-dist')
  // Only set the worker location if nothing else has. The viewer sets the same
  // value, and a host that has already configured pdf.js (a test harness, a
  // future Android shell with a different asset root) should not be overridden
  // by a hardcoded web path.
  pdfjs.GlobalWorkerOptions.workerSrc ||= '/pdfjs/build/pdf.worker.min.mjs'

  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    iccUrl: '/pdfjs/iccs/',
  })

  const doc = await task.promise
  const pages: string[] = []

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const items = (content.items as unknown[]).filter(
          (item): item is RawItem =>
            typeof item === 'object' && item !== null && typeof (item as RawItem).str === 'string',
        )
        const text = rebuildPage(items)
        pages.push(`── 第 ${pageNumber} 页 ──\n${text}`)
      } finally {
        // Release the page's resources; a long document would otherwise hold
        // every page's font and glyph data for the whole export.
        page.cleanup()
      }
    }
  } finally {
    await task.destroy().catch(() => undefined)
  }

  return pages.join('\n\n')
}

/**
 * Rebuild one page's text from positioned items.
 *
 * Items are bucketed into lines by their y coordinate (transform[5]), then
 * sorted left-to-right within each line. A space is inserted when the gap
 * between two items is wider than a small fraction of their height, which is
 * what keeps words from running together when the PDF stored them as separate
 * glyph runs.
 */
function rebuildPage(items: RawItem[]): string {
  if (!items.length) return ''

  interface Line {
    y: number
    items: RawItem[]
  }

  const lines: Line[] = []
  for (const item of items) {
    if (!item.str) continue
    const y = item.transform[5] ?? 0
    // Find an existing line within tolerance. Documents are usually emitted
    // top-to-bottom, so checking from the end finds it quickly.
    let line: Line | undefined
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const candidate = lines[i]
      if (candidate && Math.abs(candidate.y - y) <= LINE_TOLERANCE) {
        line = candidate
        break
      }
    }
    if (line) line.items.push(item)
    else lines.push({ y, items: [item] })
  }

  // PDF y grows upward, so a larger y is higher on the page.
  lines.sort((a, b) => b.y - a.y)

  const out: string[] = []
  for (const line of lines) {
    const sorted = [...line.items].sort(
      (a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0),
    )
    let text = ''
    let previousEnd: number | null = null
    for (const item of sorted) {
      const x = item.transform[4] ?? 0
      if (previousEnd !== null) {
        const gap = x - previousEnd
        const threshold = Math.max(1, (item.height || 10) * 0.25)
        // Only add a space when the visual gap suggests one; PDFs frequently
        // split a single word into several items with zero gap.
        if (gap > threshold && !text.endsWith(' ') && !item.str.startsWith(' ')) {
          text += ' '
        }
      }
      text += item.str
      previousEnd = x + (item.width || 0)
    }
    const trimmed = text.trimEnd()
    if (trimmed) out.push(trimmed)
  }

  return out.join('\n')
}
