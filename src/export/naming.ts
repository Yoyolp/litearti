/**
 * Output file naming.
 *
 * The library stores a UUID as the on-disk name and keeps only the title (the
 * original file stem) and the extension. Export has to reconstruct a usable
 * name from those two facts, which means dealing with everything a title can
 * contain and a filename cannot.
 *
 * This module is the frontend's copy of the rule. Rust applies the same rule
 * again before writing — never trust a name that crossed IPC, and the Rust side
 * is what has to be correct on disk.
 */

/** Characters Windows forbids in a filename, plus the POSIX separator. */
const ILLEGAL = /[\\/:*?"<>|]/g

/** Device names Windows reserves regardless of extension. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/**
 * Longest stem to keep, in characters.
 *
 * Well under the 255-byte filesystem limit: CJK titles are three UTF-8 bytes
 * per character, so 80 characters is already 240 bytes before the extension.
 */
const MAX_STEM = 80

/**
 * Turn a title into a safe filename stem.
 *
 * Trailing dots and spaces are stripped because Windows silently drops them,
 * which would make the name on disk differ from the name reported back.
 */
export function sanitizeStem(title: string): string {
  let stem = title.replace(ILLEGAL, '_').trim()
  // Collapse whitespace runs: titles pasted from web pages often carry
  // non-breaking spaces and doubled spaces.
  stem = stem.replace(/\s+/g, ' ')
  // Leading/trailing dots and spaces are both problematic on Windows.
  stem = stem.replace(/^[.\s]+|[.\s]+$/g, '')
  if (!stem) stem = '未命名'
  if (RESERVED.has(stem.toLowerCase())) stem = `_${stem}`
  if (stem.length > MAX_STEM) stem = stem.slice(0, MAX_STEM).trim()
  return stem || '未命名'
}

/** Full filename for an entry exported to a target. */
export function outputFileName(title: string, sourceExtension: string, targetExtension: string): string {
  const stem = sanitizeStem(title)
  // An empty target extension means "keep the source one", which is how the
  // `original` target preserves the format it was imported as.
  const extension = targetExtension || sourceExtension
  return extension ? `${stem}.${extension}` : stem
}

/**
 * The ` (2)`, ` (3)` variant used when a name is taken.
 *
 * Mirrored in `src-tauri/src/export.rs`; both sides must agree or the name
 * reported to the user would not be the name on disk.
 */
export function withSuffix(fileName: string, attempt: number): string {
  if (attempt <= 1) return fileName
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return `${fileName} (${attempt})`
  return `${fileName.slice(0, dot)} (${attempt})${fileName.slice(dot)}`
}
