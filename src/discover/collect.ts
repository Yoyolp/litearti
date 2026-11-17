/**
 * Locally-tracked watch status for a Bangumi subject.
 *
 * ## Why this is not in the library
 *
 * The library holds things you can open. A watch status is a note about a title you
 * may not have anywhere to watch yet — "I want to see this when it airs". Tying it to
 * a library entry would mean you had to add a title before you could mark interest,
 * which is backwards: the timeline is where you *discover* what to add.
 *
 * So this is its own small store, keyed by Bangumi subject id. An entry here and a
 * library entry can both exist for the same show; they answer different questions
 * ("do I care about this?" and "can I open this?").
 *
 * ## Not Bangumi's collection
 *
 * These four states mirror Bangumi's own (想看/在看/看过/搁置), because people already
 * know what they mean. They are **local only**: nothing is sent to Bangumi, and there
 * is no account. The names match so the mental model transfers, not because the data
 * does.
 */

import { computed, ref } from 'vue'

/** Mirrors Bangumi's collection states, in the order the UI shows them. */
export type CollectStatus = 'wish' | 'watching' | 'watched' | 'onHold'

export const COLLECT_STATUSES: readonly CollectStatus[] = [
  'wish',
  'watching',
  'watched',
  'onHold',
]

export interface CollectEntry {
  status: CollectStatus
  /** Milliseconds since the epoch, for ordering by recent activity. */
  updatedAt: number
}

const STORAGE_KEY = 'litearti.bangumi.collect'

/** Narrow an unknown value to a known status. */
function asStatus(value: unknown): CollectStatus | null {
  return typeof value === 'string' && (COLLECT_STATUSES as readonly string[]).includes(value)
    ? (value as CollectStatus)
    : null
}

/**
 * Read the stored table, dropping anything malformed.
 *
 * Per-entry validation rather than all-or-nothing: one hand-edited garbage row must
 * not discard the other fifty.
 */
export function loadCollect(): Record<number, CollectEntry> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return {}
  }
  if (!raw) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') return {}

  const out: Record<number, CollectEntry> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const id = Number(key)
    if (!Number.isInteger(id) || id <= 0) continue
    if (value === null || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const status = asStatus(entry.status)
    if (!status) continue
    const updatedAt =
      typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
        ? entry.updatedAt
        : 0
    out[id] = { status, updatedAt }
  }
  return out
}

function saveCollect(table: Record<number, CollectEntry>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(table))
  } catch {
    // Best-effort. A private-mode refusal must not break browsing.
  }
}

/**
 * The reactive table.
 *
 * A module-level `ref` rather than a Pinia store: two screens read it, neither owns
 * it, and it has no actions beyond set/clear. A store would add ceremony without
 * adding a boundary.
 */
const current = ref<Record<number, CollectEntry>>(loadCollect())

/** Read-only view, for templates. */
export const collectTable = computed(() => current.value)

/**
 * Set or clear one subject's status.
 *
 * Passing `null` removes the entry entirely rather than storing a fifth "none"
 * state: absence already means no interest, and a stored null would need handling
 * everywhere the table is read.
 */
export function setStatus(id: number, status: CollectStatus | null): void {
  if (id <= 0) return
  const next = { ...current.value }
  if (status === null) {
    delete next[id]
  } else {
    next[id] = { status, updatedAt: Date.now() }
  }
  current.value = next
  saveCollect(next)
}

/** The status for one subject, or null when it has none. */
export function statusOf(id: number): CollectStatus | null {
  return current.value[id]?.status ?? null
}

/** How many subjects carry a given status. */
export function countByStatus(status: CollectStatus): number {
  let total = 0
  for (const entry of Object.values(current.value)) {
    if (entry.status === status) total += 1
  }
  return total
}

/** Ids with a given status, for filtering a list. */
export function idsWithStatus(status: CollectStatus): Set<number> {
  const ids = new Set<number>()
  for (const [key, entry] of Object.entries(current.value)) {
    if (entry.status === status) ids.add(Number(key))
  }
  return ids
}

/** Remove every entry. Used by the settings page's reset, if it ever needs one. */
export function clearAll(): void {
  current.value = {}
  saveCollect({})
}
