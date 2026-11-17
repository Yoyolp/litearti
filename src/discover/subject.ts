/**
 * Bangumi subject, normalised.
 *
 * ## Why this is defensive
 *
 * The two endpoints this app uses are **not the same API**. `calendar/season`
 * returns `{ "1": [{ subject }] }` and `popular/subjects` returns `{ data: [subject] }`,
 * and the subject objects inside them do not carry the same fields:
 *
 * | field | calendar | popular |
 * |---|---|---|
 * | `rating.count` | object keyed "1".."10" | **array** |
 * | `date` | present | **absent** |
 * | `metaTags`, `platform`, `series`, `locked`, `nsfw` | absent | present |
 * | `nameCN` | present | present |
 *
 * Both were verified against real responses (see `scripts/fixtures/bgm-*.json`).
 * Since they disagree, every field here is optional and parsed leniently — a subject
 * missing `date` is still worth showing, and a code that assumes otherwise would
 * blank the whole list over one odd item.
 *
 * ## Not modelled
 *
 * There is no detail endpoint behind these, so the fields present in the list
 * response are all that will ever be shown: summary, rating, tags, cover. That is
 * deliberate, not a shortcut — the mirror does not proxy `/v0/subjects/{id}`, and
 * adding a second data source for one screen is not worth it.
 */

/** One subject, as much as either endpoint provides. */
export interface Subject {
  id: number
  /** Japanese (or original) title. */
  name: string
  /** Chinese title. Empty string when the response has none. */
  nameCN: string
  summary: string
  /** ISO date `YYYY-MM-DD`, or null when the endpoint does not provide one. */
  date: string | null
  /** Bangumi type: 2 is anime. Others are excluded by the server anyway. */
  type: number
  images: SubjectImages
  rating: SubjectRating
  tags: SubjectTag[]
}

export interface SubjectImages {
  /** Largest available; used for the detail-ish card. */
  large: string | null
  /** Grid thumbnail; used in lists. */
  grid: string | null
  small: string | null
}

export interface SubjectRating {
  /** 0 when nobody has rated it yet. */
  score: number
  /** 0 means unranked. Bangumi's ranks start at 1. */
  rank: number
  total: number
}

export interface SubjectTag {
  name: string
  count: number
}

/** One day of the weekly calendar. Index 0 is Monday. */
export interface CalendarDay {
  /** 1..7, matching Bangumi's weekday numbering (Monday = 1). */
  weekday: number
  subjects: Subject[]
}

/** A page of recommendations. */
export interface PopularPage {
  subjects: Subject[]
  /**
   * Whether another page is likely to exist.
   *
   * Derived from `subjects.length >= requested limit` rather than from a total,
   * because neither endpoint reports one. It can therefore be wrong by one page at
   * the end of the list, which is the harmless direction: asking for one extra page
   * and getting nothing costs a request, while stopping early loses items.
   */
  hasMore: boolean
}

/** Read a string field, tolerating absence and non-strings. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Read a finite number, defaulting to 0. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Parse the `images` block.
 *
 * Both endpoints use Bangumi's shape (`large`/`grid`/`small`/…), but the values are
 * absolute URLs pointing at `api.bgm.tv`, which means the cover needs a network
 * request to a host this app does not otherwise contact. A cover that fails to load
 * is expected, not exceptional, so every field is nullable and the UI falls back to
 * a typographic placeholder.
 */
function parseImages(raw: unknown): SubjectImages {
  if (raw === null || typeof raw !== 'object') {
    return { large: null, grid: null, small: null }
  }
  const value = raw as Record<string, unknown>
  const pick = (key: string): string | null => {
    const url = str(value[key])
    return url ? url : null
  }
  // `common` is present on the calendar endpoint and absent on some popular items;
  // `large` is the better fallback of the two because it is what both provide.
  return {
    large: pick('large') ?? pick('common'),
    grid: pick('grid') ?? pick('common') ?? pick('medium'),
    small: pick('small'),
  }
}

/**
 * Parse the `rating` block.
 *
 * `count` is deliberately ignored: it is an object on one endpoint and an array on
 * the other, and nothing in this app uses the histogram. Parsing it would be code
 * that exists only to be wrong in one of the two cases.
 */
function parseRating(raw: unknown): SubjectRating {
  if (raw === null || typeof raw !== 'object') {
    return { score: 0, rank: 0, total: 0 }
  }
  const value = raw as Record<string, unknown>
  return {
    score: num(value.score),
    rank: num(value.rank),
    total: num(value.total),
  }
}

/** Parse the `tags` array, dropping entries without a usable name. */
function parseTags(raw: unknown): SubjectTag[] {
  if (!Array.isArray(raw)) return []
  const out: SubjectTag[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const tag = item as Record<string, unknown>
    const name = str(tag.name)
    if (!name) continue
    out.push({ name, count: num(tag.count) })
  }
  return out
}

/**
 * Parse one subject from either endpoint.
 *
 * Returns null only when there is no usable title at all — everything else has a
 * sensible empty value. A subject with an id but no name cannot be shown or searched
 * for, so dropping it keeps the list honest instead of rendering a blank card.
 */
export function parseSubject(raw: unknown): Subject | null {
  if (raw === null || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>

  const id = num(value.id)
  if (id <= 0) return null

  const name = str(value.name)
  // `nameCN` and `name_cn` are both returned, sometimes with different casing of the
  // key and sometimes with different content; preferring the camelCase one and
  // falling back keeps a Chinese title when either is populated.
  const nameCN = str(value.nameCN) || str(value.name_cn)
  if (!name && !nameCN) return null

  const date = str(value.date)

  return {
    id,
    name,
    nameCN,
    summary: str(value.summary),
    date: date ? date.slice(0, 10) : null,
    type: num(value.type),
    images: parseImages(value.images),
    rating: parseRating(value.rating),
    tags: parseTags(value.tags),
  }
}

/**
 * Parse the season calendar response.
 *
 * Shape: `{ "1": [{ subject }], ..., "7": [{ subject }] }`. Always returns seven
 * days even when the response omits some, because a weekday with no shows is still a
 * weekday — the UI shows an empty column rather than a gap.
 */
export function parseCalendar(raw: unknown): CalendarDay[] {
  const days: CalendarDay[] = []
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const list = source[String(weekday)]
    const subjects: Subject[] = []
    if (Array.isArray(list)) {
      for (const entry of list) {
        // The calendar wraps each subject; the popular endpoint does not. Handling
        // both here means one parser covers the two shapes.
        const inner =
          entry !== null && typeof entry === 'object' && 'subject' in entry
            ? (entry as Record<string, unknown>).subject
            : entry
        const subject = parseSubject(inner)
        if (subject) subjects.push(subject)
      }
    }
    days.push({ weekday, subjects })
  }

  return days
}

/**
 * Parse the popular/recommended response.
 *
 * Shape: `{ data: [subject] }`, where the items are subjects directly rather than
 * wrapped. `limit` is passed in so `hasMore` can be derived without a total count.
 */
export function parsePopular(raw: unknown, limit: number): PopularPage {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const list = Array.isArray(source.data) ? source.data : []
  const subjects: Subject[] = []
  for (const entry of list) {
    const subject = parseSubject(entry)
    if (subject) subjects.push(subject)
  }
  return { subjects, hasMore: subjects.length >= limit }
}

/** The title to show in this app: Chinese when available, original otherwise. */
export function displayName(subject: Subject): string {
  return subject.nameCN || subject.name
}

/** A score formatted for display, or null when the subject is unrated. */
export function scoreLabel(subject: Subject): string | null {
  if (subject.rating.score <= 0) return null
  // One decimal: Bangumi reports two, but a list does not need that precision and
  // "7.72" reads as a measurement rather than a rating.
  return subject.rating.score.toFixed(1)
}
