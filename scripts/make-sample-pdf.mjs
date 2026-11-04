/**
 * Generates a small, real PDF for verifying the PDF → text export path.
 *
 * Run with: node scripts/make-sample-pdf.mjs [outputPath]
 *
 * Hand-writing a PDF keeps the repo dependency-free: the format is simple
 * enough that a page with a few text runs fits in a few dozen lines. The output
 * has two pages with known strings, so the converter can be checked for page
 * markers, line reconstruction, and word spacing.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outPath = process.argv[2] ?? join(root, 'demo', 'sample.pdf')

/** Escape a string for a PDF literal, using WinAnsi for ASCII only. */
function pdfString(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * Build a two-page PDF.
 *
 * Text is placed with explicit coordinates so the converter's line
 * reconstruction has something meaningful to do: two runs on one line, then a
 * run on the next line down.
 */
function buildPdf() {
  const objects = []

  // 1: catalog, 2: pages, 3..4: page objects, 5..6: contents, 7: font
  const page1 = [
    'BT',
    '/F1 18 Tf',
    '1 0 0 1 72 720 Tm',
    `(${pdfString('Chapter One')}) Tj`,
    '/F1 12 Tf',
    '1 0 0 1 72 690 Tm',
    // Two runs on the same baseline, separated by a wide gap: the converter
    // should join them with a single space rather than running them together.
    `(${pdfString('Hello')}) Tj`,
    '1 0 0 1 160 690 Tm',
    `(${pdfString('world from a PDF')}) Tj`,
    '1 0 0 1 72 660 Tm',
    `(${pdfString('Second line of the first page.')}) Tj`,
    'ET',
  ].join('\n')

  const page2 = [
    'BT',
    '/F1 18 Tf',
    '1 0 0 1 72 720 Tm',
    `(${pdfString('Chapter Two')}) Tj`,
    '/F1 12 Tf',
    '1 0 0 1 72 690 Tm',
    `(${pdfString('Text on the second page.')}) Tj`,
    'ET',
  ].join('\n')

  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>')
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  )
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  )
  objects.push(`<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`)
  objects.push(`<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`)
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  let out = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefStart = out.length
  out += `xref\n0 ${objects.length + 1}\n`
  out += '0000000000 65535 f \n'
  for (let i = 1; i <= objects.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  return out
}

async function main() {
  const pdf = buildPdf()
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, pdf, 'latin1')
  console.log(`wrote ${outPath} (${pdf.length} bytes)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
