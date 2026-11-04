/**
 * Aggregation for the dashboard.
 *
 * Every number here is derived from fields the library already stores
 * (`size`, `extension`, `progress`, `addedAt`, `lastOpenedAt`). Nothing is
 * invented, and nothing needs new tracking: a stat that would require
 * instrumentation (reading time, streaks) is deliberately absent rather than
 * faked.
 */

import type { Entry } from '@/types/viewer'

/** A format bucket: how many entries of one extension, and their total size. */
export interface FormatBucket {
  extension: string
  count: number
  bytes: number
}

/** Where an entry stands, inferred from its opaque progress blob. */
export type ReadingState = 'unread' | 'in-progress' | 'finished'

export interface LibrarySummary {
  total: number
  totalBytes: number
  formats: FormatBucket[]
  states: Record<ReadingState, number>
  /** Entries opened at least once, newest first. */
  recent: Entry[]
  /** Entries added in the last 7 days. */
  addedThisWeek: number
}

/**
 * Classify an entry by its progress payload.
 *
 * The shell does not interpret progress, but the dashboard has to show
 * *something*, so this reads the three field names the built-in viewers agree
 * on. A custom viewer using other fields simply lands in "unread" — a
 * harmless default, not an error.
 */
export function readingState(entry: Entry): ReadingState {
  const progress = entry.progress
  if (!progress || typeof progress !== 'object') return 'unread'
  const raw = progress as {
    version?: number
    ratio?: number
    page?: number
    time?: number
    chapter?: number
  }

  // EPUB: a chapter index, where the first chapter is the starting point.
  // Whether that is the *last* chapter is not recorded here (the shell never
  // learns the chapter count), so it can only ever report "in progress".
  if (typeof raw.chapter === 'number') {
    return raw.chapter > 0 ? 'in-progress' : 'unread'
  }

  // Text: a ratio, where 0.98+ counts as finished (the last line is often
  // unreachable because of scroll padding).
  if (typeof raw.ratio === 'number') {
    if (raw.ratio >= 0.98) return 'finished'
    return raw.ratio > 0.01 ? 'in-progress' : 'unread'
  }
  // PDF: any page past the first means started. Without the page count the
  // dashboard cannot know "last page", so it never claims finished.
  if (typeof raw.page === 'number') {
    return raw.page > 1 ? 'in-progress' : 'unread'
  }
  // Audio: having played more than a few seconds means started.
  if (typeof raw.time === 'number') {
    return raw.time > 5 ? 'in-progress' : 'unread'
  }
  return 'unread'
}

/** Build the dashboard summary from the current entry list. */
export function summarize(entries: readonly Entry[], now = Date.now()): LibrarySummary {
  const byExtension = new Map<string, FormatBucket>()
  const states: Record<ReadingState, number> = {
    unread: 0,
    'in-progress': 0,
    finished: 0,
  }
  let totalBytes = 0
  let addedThisWeek = 0
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000

  for (const entry of entries) {
    totalBytes += entry.size
    if (entry.addedAt >= weekAgo) addedThisWeek += 1
    states[readingState(entry)] += 1

    const key = entry.extension || ''
    const bucket = byExtension.get(key)
    if (bucket) {
      bucket.count += 1
      bucket.bytes += entry.size
    } else {
      byExtension.set(key, { extension: key, count: 1, bytes: entry.size })
    }
  }

  const formats = [...byExtension.values()].sort((a, b) => {
    // Most numerous first; ties broken by size so the order is stable.
    if (b.count !== a.count) return b.count - a.count
    return b.bytes - a.bytes
  })

  const recent = entries
    .filter((e) => e.lastOpenedAt !== null)
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
    .slice(0, 5)

  return {
    total: entries.length,
    totalBytes,
    formats,
    states,
    recent,
    addedThisWeek,
  }
}

/** Share of the largest bucket, for scaling the distribution bars. */
export function largestBucketCount(formats: readonly FormatBucket[]): number {
  return formats.reduce((max, f) => Math.max(max, f.count), 0)
}
