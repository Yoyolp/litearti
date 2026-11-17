/**
 * Progress interpretation registry.
 *
 * `Entry.progress` is deliberately opaque: the backend stores whatever a viewer
 * hands it, and the viewer decides the shape (see `types/viewer.ts` and
 * `src-tauri/src/model.rs`). That is the right call for storage, but it left the
 * library list parsing those shapes inline — one `if` per format, inside a view
 * file. Adding a viewer meant editing the shell, which is exactly what the
 * viewer registry exists to prevent.
 *
 * So interpretation gets its own registry, with the same shape as the viewer one:
 * a viewer's author registers how to read their payload, and the library calls
 * `readProgress(entry)` without knowing what a PDF is.
 *
 * Readers are keyed by **extension**, not by viewer id, because an `Entry`
 * carries only an extension. Two viewers competing for one extension would
 * disagree about the payload shape, but they also cannot both own the file at
 * once, so the last registration wins — same convention as the viewer registry.
 */

import type { Entry } from '@/types/viewer'

/** What the library needs to render a row or a card. */
export interface ProgressInfo {
  /** 0–1 for a progress bar, or null when the payload has no usable fraction. */
  ratio: number | null
  /**
   * Human-readable resume hint, already localized: "已读 42%", "第 12 页".
   * Null when there is nothing worth saying.
   */
  label: string | null
}

/** Interprets one viewer's opaque payload. Null means "not my shape". */
export type ProgressReader = (progress: unknown) => ProgressInfo | null

const readers = new Map<string, ProgressReader>()

/** The empty answer, returned for unclaimed formats and unusable payloads. */
const NO_PROGRESS: ProgressInfo = { ratio: null, label: null }

function normalize(extension: string): string {
  return extension.toLowerCase().replace(/^\./, '')
}

/**
 * Claim a set of extensions.
 *
 * Registering an extension twice replaces the earlier reader, so a custom viewer
 * can take over a built-in format by registering after it.
 */
export function registerProgressReader(
  extensions: readonly string[],
  read: ProgressReader,
): void {
  for (const extension of extensions) {
    readers.set(normalize(extension), read)
  }
}

/**
 * Read an entry's progress.
 *
 * Never throws: a payload written by an older version of a viewer, or a
 * hand-edited `library.json`, must degrade to "no progress shown" rather than
 * take down the list. A reader that throws is treated as a miss.
 */
export function readProgress(entry: Entry): ProgressInfo {
  const read = readers.get(normalize(entry.extension))
  if (!read) return NO_PROGRESS
  if (entry.progress === null || entry.progress === undefined) return NO_PROGRESS

  try {
    return read(entry.progress) ?? NO_PROGRESS
  } catch {
    return NO_PROGRESS
  }
}
