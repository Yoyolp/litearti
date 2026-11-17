/**
 * The Bangumi data source, as the rest of the app sees it.
 *
 * Everything goes through Tauri commands so the network stays on the Rust side; the
 * frontend never talks to the mirror directly. That is the same rule the source
 * engine follows, and it is what keeps "network only through Rust" true rather than
 * aspirational.
 *
 * Parsing happens here rather than in Rust because the two endpoints disagree on
 * field shapes, and the normalisation is already written and tested against real
 * captured responses in `subject.ts`. A second parser in Rust would be a second place
 * for the same bug.
 */

import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import {
  parseCalendar,
  parsePopular,
  type CalendarDay,
  type PopularPage,
} from './subject'

/** One anime season: a calendar year and a quarter, 1..4. */
export interface Season {
  year: number
  quarter: 1 | 2 | 3 | 4
}

/** The current season, in which season number 1 is winter. */
export function currentSeason(now = new Date()): Season {
  // getMonth is 0-based: 0..2 is winter, 3..5 spring, 6..8 summer, 9..11 autumn.
  const quarter = (Math.floor(now.getMonth() / 3) + 1) as Season['quarter']
  return { year: now.getFullYear(), quarter }
}

/** The season before this one, rolling the year when needed. */
export function previousSeason(season: Season): Season {
  if (season.quarter === 1) {
    return { year: season.year - 1, quarter: 4 }
  }
  return { year: season.year, quarter: (season.quarter - 1) as Season['quarter'] }
}

/** The season after this one, rolling the year when needed. */
export function nextSeason(season: Season): Season {
  if (season.quarter === 4) {
    return { year: season.year + 1, quarter: 1 }
  }
  return { year: season.year, quarter: (season.quarter + 1) as Season['quarter'] }
}

/** Whether two seasons are the same. */
export function sameSeason(a: Season, b: Season): boolean {
  return a.year === b.year && a.quarter === b.quarter
}

/**
 * Load the calendar for a season.
 *
 * The date range comes from Rust so the quarter boundaries live in one place; the
 * frontend passing its own guesses would drift.
 */
export async function loadCalendar(season: Season): Promise<CalendarDay[]> {
  const [start, end] = await invoke<[string, string]>('bangumi_season_range', {
    year: season.year,
    quarter: season.quarter,
  })
  const raw = await invoke<string>('bangumi_calendar', { start, end })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Bangumi 返回的不是合法 JSON')
  }
  return parseCalendar(parsed)
}

/**
 * Load one page of trending subjects.
 *
 * `limit` is fixed here rather than exposed: the UI always wants the same page size,
 * and Rust clamps it anyway.
 */
export const POPULAR_PAGE_SIZE = 24

export async function loadPopular(offset = 0): Promise<PopularPage> {
  const raw = await invoke<string>('bangumi_popular', {
    limit: POPULAR_PAGE_SIZE,
    offset,
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Bangumi 返回的不是合法 JSON')
  }
  return parsePopular(parsed, POPULAR_PAGE_SIZE)
}

/** Drop the on-disk cache, so the next load hits the network. */
export async function clearCache(): Promise<void> {
  await invoke('bangumi_clear_cache')
}

/**
 * Resolve a remote cover to something the webview can render.
 *
 * The cover hosts (`api.bgm.tv`, `lain.bgm.tv`) are unreachable from some networks,
 * and a grid of cards would otherwise fire one doomed request each on every render.
 * Rust caches successes on disk and remembers failures for an hour, so this returns
 * null quickly in the common failure case instead of hanging.
 *
 * A null result is not an error: the card falls back to a typographic tile.
 */
export async function coverUrl(url: string | null): Promise<string | null> {
  if (!url) return null
  try {
    const path = await invoke<string | null>('bangumi_cover', { url })
    // A local filesystem path cannot be used as an `<img src>`: the webview refuses
    // `file://` origins. `convertFileSrc` rewrites it to the asset protocol, which
    // Rust allows for the app data directory.
    return path ? convertFileSrc(path) : null
  } catch {
    return null
  }
}

/** Bytes and file count of the cover cache, for the settings page. */
export async function coverCacheStats(): Promise<{ bytes: number; files: number }> {
  const [bytes, files] = await invoke<[number, number]>('bangumi_cover_stats')
  return { bytes, files }
}

/** Delete every cached cover. */
export async function clearCovers(): Promise<void> {
  await invoke('bangumi_clear_covers')
}

/** A season as a label, e.g. `2025 年 10 月`. */
export function seasonLabel(season: Season): string {
  const startMonth = (season.quarter - 1) * 3 + 1
  return `${season.year} 年 ${startMonth} 月`
}
