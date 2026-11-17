/**
 * Library view preferences: which layout, and the current query.
 *
 * These live in `localStorage`, not in `library.json`. The library file is the
 * person's content and has a versioned schema the backend migrates; how they last
 * looked at it is an interface preference, and mixing the two would give every
 * future migration one more field to worry about. The theme already made this
 * call (`litearti.theme`), and the sidebar collapse state follows it too.
 *
 * Everything stored is validated on read. `localStorage` can hold anything a
 * previous build or a hand-edit left behind, and a malformed query must fall back
 * to the default rather than rendering an empty library that looks like data loss.
 */

import {
  DEFAULT_QUERY,
  FORMAT_GROUPS,
  ORIGIN_FILTERS,
  READ_STATUSES,
  SORT_KEYS,
  type FormatGroup,
  type LibraryQuery,
  type OriginFilter,
  type ReadStatus,
  type SortDirection,
  type SortKey,
} from './query'

export type LibraryView = 'list' | 'grid'

const VIEW_KEY = 'litearti.library.view'
const QUERY_KEY = 'litearti.library.query'

/** Read a key without letting a disabled storage throw. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Preference persistence is best-effort; a private-mode refusal is not
    // worth interrupting anyone over.
  }
}

export function loadView(): LibraryView {
  return read(VIEW_KEY) === 'grid' ? 'grid' : 'list'
}

export function saveView(view: LibraryView): void {
  write(VIEW_KEY, view)
}

/** Narrow an unknown value to one of `allowed`, or null. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

/**
 * Load the query, falling back field by field.
 *
 * A partially valid stored query keeps its valid parts: someone who picked "PDF"
 * and then edited the file badly should still get their PDF filter, not a reset.
 */
export function loadQuery(): LibraryQuery {
  const raw = read(QUERY_KEY)
  if (!raw) return { ...DEFAULT_QUERY }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_QUERY }
  }
  if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_QUERY }

  const value = parsed as Record<string, unknown>
  return {
    text: typeof value.text === 'string' ? value.text : DEFAULT_QUERY.text,
    format: oneOf<FormatGroup>(value.format, FORMAT_GROUPS),
    status: oneOf<ReadStatus>(value.status, READ_STATUSES),
    group: typeof value.group === 'string' && value.group ? value.group : null,
    origin: oneOf<OriginFilter>(value.origin, ORIGIN_FILTERS),
    sort: oneOf<SortKey>(value.sort, SORT_KEYS) ?? DEFAULT_QUERY.sort,
    direction: oneOf<SortDirection>(value.direction, ['asc', 'desc']) ?? DEFAULT_QUERY.direction,
  }
}

export function saveQuery(query: LibraryQuery): void {
  write(
    QUERY_KEY,
    JSON.stringify({
      text: query.text,
      format: query.format,
      status: query.status,
      group: query.group,
      origin: query.origin,
      sort: query.sort,
      direction: query.direction,
    }),
  )
}
