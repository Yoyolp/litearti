/**
 * Playback progress for video sources.
 *
 * Kept in its own file, not in `source-progress.json`. Those two look similar and
 * are not: a chapter's progress is a scroll ratio inside a page, an episode's is a
 * timestamp inside a media file. Storing them together would mean one opaque
 * union type and a migration the first time either shape changes.
 *
 * Keyed by `sourceId::episodeUrl`, the same convention the source store uses for
 * chapter progress, because the same argument applies: the URL identifies the
 * episode and may disappear, so it is the right key for a best-effort record.
 *
 * No IPC: this is a small map written on a timer, and a Tauri command per second
 * would be a lot of ceremony for a few hundred bytes. `localStorage` is the right
 * home for it — same call the theme and library view made.
 */

const KEY = 'litearti.anime-progress'

/** One episode's resume point. */
export interface PlaybackProgress {
  /** Seconds into the media. */
  position: number
  /** Total length, when known. `0` while the media has not loaded metadata. */
  duration: number
  /** Milliseconds since the epoch, for "most recently watched" ordering. */
  updatedAt: number
}

export type PlaybackProgressMap = Record<string, PlaybackProgress>

/**
 * How far from the end still counts as "finished".
 *
 * Five seconds: an episode that credits out at 23:50 should be marked watched,
 * and treating "position == duration" exactly would almost never match.
 */
const FINISHED_MARGIN = 5

export function progressKey(sourceId: string, episodeUrl: string): string {
  return `${sourceId}::${episodeUrl}`
}

function readAll(): PlaybackProgressMap {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Trust the shape only as far as it is checkable: a hand-edited or older
    // entry should be skipped rather than crash the page.
    const out: PlaybackProgressMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      if (typeof entry.position !== 'number' || !Number.isFinite(entry.position)) continue
      out[key] = {
        position: Math.max(0, entry.position),
        duration: typeof entry.duration === 'number' && Number.isFinite(entry.duration)
          ? Math.max(0, entry.duration)
          : 0,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(map: PlaybackProgressMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    // Best-effort by contract: losing a resume point is not worth an error, and
    // a full quota should not break playback.
  }
}

export function loadPlaybackProgress(
  sourceId: string,
  episodeUrl: string,
): PlaybackProgress | null {
  return readAll()[progressKey(sourceId, episodeUrl)] ?? null
}

/**
 * Record a position.
 *
 * A position within `FINISHED_MARGIN` of the end is stored as the end, so the
 * episode list can mark it watched without re-deriving the rule at each call site.
 */
export function savePlaybackProgress(
  sourceId: string,
  episodeUrl: string,
  position: number,
  duration: number,
): void {
  if (!Number.isFinite(position) || position < 0) return
  const clamped = duration > 0 ? Math.min(position, duration) : position
  const map = readAll()
  map[progressKey(sourceId, episodeUrl)] = {
    position: clamped,
    duration: duration > 0 ? duration : 0,
    updatedAt: Date.now(),
  }
  writeAll(map)
}

export function clearPlaybackProgress(sourceId: string, episodeUrl: string): void {
  const map = readAll()
  delete map[progressKey(sourceId, episodeUrl)]
  writeAll(map)
}

/**
 * Whether an episode counts as watched.
 *
 * Two ways to be finished: within the margin of the end, or past 95% of a known
 * duration. The percentage covers a media file whose last few seconds are silent
 * padding, which is common.
 */
export function isEpisodeFinished(progress: PlaybackProgress | null): boolean {
  if (!progress) return false
  if (progress.duration <= 0) return false
  if (progress.position >= progress.duration - FINISHED_MARGIN) return true
  return progress.position >= progress.duration * 0.95
}

/**
 * Watched state for a whole episode list, for the episode grid.
 *
 * Returned as a per-URL map rather than a list of indices so the caller can key
 * on the same value it renders.
 */
export function watchedMap(
  sourceId: string,
  episodeUrls: readonly string[],
): Record<string, boolean> {
  const all = readAll()
  const out: Record<string, boolean> = {}
  for (const url of episodeUrls) {
    out[url] = isEpisodeFinished(all[progressKey(sourceId, url)] ?? null)
  }
  return out
}
