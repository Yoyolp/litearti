/**
 * The library query model.
 *
 * Pure functions over `Entry[]`: extract, filter, sort, count. No Pinia, no
 * reactivity, no `localStorage`. The view holds a `LibraryQuery` value and calls
 * `applyQuery`; the store persists the value. That split is what makes the whole
 * thing testable with a plain `node` script (`scripts/verify-library-query.mjs`)
 * instead of a browser.
 *
 * The shape follows Kazumi's `CollectLibraryQuery`, which is the same idea for
 * the same reason: filtering, counting and sorting are one problem, and they
 * should be solved once in a testable place rather than three times in widgets.
 */

import type { Entry } from '@/types/viewer'

// --- Groups ----------------------------------------------------------------

/**
 * Format buckets.
 *
 * Deliberately coarser than the extension list: a person filtering their library
 * thinks "the PDFs" or "the audiobooks", not "the .m4a ones". `other` exists so a
 * custom container format is still reachable and its absence from the named
 * buckets is visible rather than hidden.
 */
export type FormatGroup = 'text' | 'pdf' | 'epub' | 'audio' | 'other'

export const FORMAT_GROUPS: readonly FormatGroup[] = ['text', 'pdf', 'epub', 'audio', 'other']

/** Extensions that fall into each named bucket. Anything else is `other`. */
const TEXT_EXTENSIONS = ['txt', 'md', 'log', 'text', 'csv', 'json', 'yml', 'yaml']
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'weba']

export function formatGroupOf(extension: string): FormatGroup {
  const ext = extension.toLowerCase().replace(/^\./, '')
  if (ext === 'pdf') return 'pdf'
  if (ext === 'epub') return 'epub'
  if (TEXT_EXTENSIONS.includes(ext)) return 'text'
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
  return 'other'
}

// --- Read status -----------------------------------------------------------

/**
 * Coarse reading state, inferred from the progress payload.
 *
 * This is necessarily approximate, because viewers store what they need and no
 * more: a PDF payload is `{page}` with no total page count, an audio payload is
 * `{time}` with no duration, an EPUB payload is `{chapter}` with no chapter
 * total. So:
 *
 *   - `finished` means "the viewer's own payload says the end was reached",
 *     which today only text (ratio ≥ 0.98) and EPUB (ratio ≥ 0.98) can report.
 *   - Everything else with any payload counts as `reading`.
 *
 * Pretending to a precise "已读完" for every format would require viewers to
 * store totals, which is a payload change and a separate decision. Saying so in
 * one place beats three widgets each guessing differently.
 */
export type ReadStatus = 'unread' | 'reading' | 'finished'

export const READ_STATUSES: readonly ReadStatus[] = ['unread', 'reading', 'finished']

/** Ratio at or above which an entry counts as read to the end. */
const FINISHED_RATIO = 0.98

export function readStatusOf(entry: Entry): ReadStatus {
  const progress = entry.progress
  if (progress === null || progress === undefined) return 'unread'
  if (typeof progress !== 'object') return 'reading'

  const raw = progress as { ratio?: unknown; page?: unknown; time?: unknown }
  if (typeof raw.ratio === 'number') {
    if (!Number.isFinite(raw.ratio)) return 'reading'
    return raw.ratio >= FINISHED_RATIO ? 'finished' : 'reading'
  }
  // A payload with a page or a timestamp means "opened and moved"; neither
  // format reports a total, so neither can claim to be finished.
  if (typeof raw.page === 'number' && raw.page > 1) return 'reading'
  if (typeof raw.time === 'number' && raw.time > 0) return 'reading'
  return 'reading'
}

// --- Query -----------------------------------------------------------------

/**
 * Sort keys.
 *
 * `recent` is the default and reproduces the previous behaviour exactly: last
 * activity, where opening a file or importing it both count. Sorting by
 * opened-only would push a just-imported file below everything else, which is
 * the opposite of what a person expects right after importing.
 */
export type SortKey = 'recent' | 'added' | 'title' | 'size' | 'progress'

export const SORT_KEYS: readonly SortKey[] = ['recent', 'added', 'title', 'size', 'progress']

export type SortDirection = 'asc' | 'desc'

/**
 * Which shelf an entry lives on.
 *
 * `file` is an imported copy; `online` is a reference to a source. The list shows
 * both by default — that is the point of one shelf — and this filter is how you
 * narrow to one kind without moving to a different page.
 */
export type OriginFilter = 'file' | 'online'

export const ORIGIN_FILTERS: readonly OriginFilter[] = ['file', 'online']

export interface LibraryQuery {
  /** Free text. Split on whitespace; every term must match (AND). */
  text: string
  /** Null means every format. */
  format: FormatGroup | null
  /** Null means every status. */
  status: ReadStatus | null
  /** Null means no group filter. Matches `Entry.group` exactly. */
  group: string | null
  /** Null means both kinds. */
  origin: OriginFilter | null
  sort: SortKey
  direction: SortDirection
}

/** The default query, i.e. what the library shows on a fresh start. */
export const DEFAULT_QUERY: LibraryQuery = {
  text: '',
  format: null,
  status: null,
  group: null,
  origin: null,
  sort: 'recent',
  direction: 'desc',
}

/** Last activity: opening a file or importing it, whichever is later. */
function activityAt(entry: Entry): number {
  return Math.max(entry.lastOpenedAt ?? 0, entry.addedAt)
}

/** Display title: the manual rename when present, else the imported title. */
export function displayTitle(entry: Entry): string {
  const renamed = (entry as Entry & { rename?: string | null }).rename
  return renamed && renamed.trim() ? renamed : entry.title
}

/**
 * Filter by text.
 *
 * Whitespace splits the query into terms that must all match, which is the
 * behaviour Kazumi's collect search has and the behaviour people expect from a
 * filter box: "上 册" narrows rather than broadens. Matching is
 * case-insensitive over the display title, and also over the extension and
 * group so "pdf" finds the PDFs without reaching for the format filter.
 */
function matchesText(entry: Entry, terms: string[]): boolean {
  if (!terms.length) return true
  const haystack = [displayTitle(entry), entry.extension, entry.group ?? '']
    .join('\n')
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/** The progress fraction used for sorting, or -1 when there is none. */
function progressSortValue(entry: Entry): number {
  const progress = entry.progress
  if (progress === null || progress === undefined || typeof progress !== 'object') return -1
  const raw = progress as { ratio?: unknown; chapter?: unknown }
  if (typeof raw.ratio === 'number' && Number.isFinite(raw.ratio)) return raw.ratio
  // A chapter index is not a fraction of the book, so it cannot be compared
  // across entries; treat it as "some progress" rather than inventing a scale.
  if (typeof raw.chapter === 'number') return 0
  return -1
}

function compareBy(key: SortKey, a: Entry, b: Entry): number {
  switch (key) {
    case 'recent':
      return activityAt(a) - activityAt(b)
    case 'added':
      return a.addedAt - b.addedAt
    case 'title':
      // `localeCompare` with a Chinese collator would sort by pinyin, which is
      // pleasant but surprising when the list mixes scripts. Plain codepoint
      // order is predictable and stable, which matters more for a file list.
      return displayTitle(a).toLowerCase().localeCompare(displayTitle(b).toLowerCase())
    case 'size':
      return a.size - b.size
    case 'progress':
      return progressSortValue(a) - progressSortValue(b)
  }
}

/**
 * Apply a query.
 *
 * Order of operations is filter → sort, and the sort is stable, so ties keep the
 * order the backend returned. The previous version sorted by recency only; this
 * version must produce that same order for the default query, which is why
 * `recent` is the default key and `desc` the default direction.
 */
export function applyQuery(entries: readonly Entry[], query: LibraryQuery): Entry[] {
  const terms = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean)

  const filtered = entries.filter((entry) => {
    if (query.format !== null && formatGroupOf(entry.extension) !== query.format) return false
    if (query.status !== null && readStatusOf(entry) !== query.status) return false
    if (query.group !== null && (entry.group ?? null) !== query.group) return false
    if (query.origin !== null) {
      const isOnline = entry.kind === 'online'
      if (query.origin === 'online' ? !isOnline : isOnline) return false
    }
    return matchesText(entry, terms)
  })

  const sorted = [...filtered]
  const sign = query.direction === 'asc' ? 1 : -1
  sorted.sort((a, b) => {
    const primary = compareBy(query.sort, a, b)
    if (primary !== 0) return primary * sign
    // Ties fall back to recency, newest first, then id: a stable total order
    // means re-rendering never reshuffles equal items under the cursor.
    const byActivity = activityAt(b) - activityAt(a)
    if (byActivity !== 0) return byActivity
    return a.id.localeCompare(b.id)
  })
  return sorted
}

// --- Counts ----------------------------------------------------------------

export type FormatCounts = Record<FormatGroup, number>
export type StatusCounts = Record<ReadStatus, number>

/**
 * Counts per format bucket.
 *
 * Counted over the entries passed in, *without* the format filter applied, so
 * the filter UI can show "how many there would be" for each option. Passing an
 * already format-filtered list would make every other count zero.
 */
export function countsByFormat(entries: readonly Entry[]): FormatCounts {
  const counts = { text: 0, pdf: 0, epub: 0, audio: 0, other: 0 } as FormatCounts
  for (const entry of entries) {
    counts[formatGroupOf(entry.extension)] += 1
  }
  return counts
}

/** Counts per read status, with the same "ignore the status filter" rule. */
export function countsByStatus(entries: readonly Entry[]): StatusCounts {
  const counts = { unread: 0, reading: 0, finished: 0 } as StatusCounts
  for (const entry of entries) {
    counts[readStatusOf(entry)] += 1
  }
  return counts
}

/**
 * Distinct groups present, sorted.
 *
 * Used to build the group filter. An empty list means nothing has been grouped,
 * which is the normal case for a library of hand-imported files.
 */
export function distinctGroups(entries: readonly Entry[]): string[] {
  const seen = new Set<string>()
  for (const entry of entries) {
    const group = entry.group
    if (group && group.trim()) seen.add(group)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** Whether a query differs from the default, i.e. whether to offer "clear". */
export function isDefaultQuery(query: LibraryQuery): boolean {
  return (
    !query.text.trim() &&
    query.format === null &&
    query.status === null &&
    query.group === null &&
    query.sort === DEFAULT_QUERY.sort &&
    query.direction === DEFAULT_QUERY.direction
  )
}
