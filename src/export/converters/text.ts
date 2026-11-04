/**
 * Text → text.
 *
 * The simplest converter, and the one that must not be clever: the reader has
 * already decoded the bytes with the same rules the viewer uses, so exporting
 * is a matter of writing that string back out. Line endings are preserved
 * exactly — a person who exported a `.txt` expects the file to be the file, not
 * a normalized rewrite of it.
 */

import type { ConvertInput } from '../registry'

export async function textToText(input: ConvertInput): Promise<string> {
  const decoded = await input.readText()
  // `readText` strips a BOM and reports it; the exported file is UTF-8 without
  // a BOM, which is the least surprising choice for a fresh file.
  return decoded.text
}
