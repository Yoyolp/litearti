/**
 * Reading preferences shared by every reader.
 *
 * There are two readers — the local-file one and the source one — and they used to
 * disagree: the source reader had its own `fontSize` in component state that reset
 * on navigation, while the local reader had no control at all and followed CSS
 * variables. Adding a Settings page made that untenable: a value shown in Settings
 * has to be the value the reader uses, or the setting is decoration.
 *
 * So this module is the single source of truth. Both readers read from it, and
 * neither keeps a local copy — a component-local `ref(17)` is exactly how the two
 * drift apart again.
 *
 * Stored in `localStorage`, not `library.json`: how text looks is an interface
 * preference, not library data, and putting it in the library file would give every
 * future migration one more field to worry about.
 */

import { computed, ref } from 'vue'

export type ReadingMode = 'scroll' | 'page'

export interface ReadingPrefs {
  /** Body text size in px. */
  fontSize: number
  /** Line height as a multiple of the font size. */
  lineHeight: number
  /** Maximum line length in `ch` units. */
  measure: number
  mode: ReadingMode
}

const STORAGE_KEY = 'litearti.reading'

/** Bounds, exported so the settings UI and the readers agree on them. */
export const FONT_SIZE_RANGE = { min: 13, max: 28, step: 1 } as const
export const LINE_HEIGHT_RANGE = { min: 1.4, max: 2.2, step: 0.1 } as const
export const MEASURE_RANGE = { min: 40, max: 100, step: 4 } as const

export const DEFAULT_READING: ReadingPrefs = {
  fontSize: 17,
  lineHeight: 1.75,
  // 68 characters is inside the range typography guides recommend for body text,
  // and it is what the source reader was already using.
  measure: 68,
  mode: 'scroll',
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Read the stored preferences, field by field, falling back per field. */
export function loadReading(): ReadingPrefs {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return { ...DEFAULT_READING }
  }
  if (!raw) return { ...DEFAULT_READING }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_READING }
  }
  if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_READING }

  const value = parsed as Record<string, unknown>
  return {
    // Each field is validated on its own: a hand-edited file that broke `mode`
    // should not also throw away a deliberate font size.
    fontSize:
      typeof value.fontSize === 'number'
        ? clamp(Math.round(value.fontSize), FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max)
        : DEFAULT_READING.fontSize,
    lineHeight:
      typeof value.lineHeight === 'number'
        ? clamp(value.lineHeight, LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max)
        : DEFAULT_READING.lineHeight,
    measure:
      typeof value.measure === 'number'
        ? clamp(Math.round(value.measure), MEASURE_RANGE.min, MEASURE_RANGE.max)
        : DEFAULT_READING.measure,
    mode: value.mode === 'page' || value.mode === 'scroll' ? value.mode : DEFAULT_READING.mode,
  }
}

function saveReading(prefs: ReadingPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Best-effort: a private-mode refusal must not interrupt reading.
  }
}

/**
 * The reactive reading preferences.
 *
 * A module-level `ref` rather than a Pinia store: it is a handful of scalars with no
 * actions, and both readers import it directly, which keeps the dependency obvious
 * instead of routing through a store the reader may not have mounted.
 */
const current = ref<ReadingPrefs>(loadReading())

/** Read-only view of the current preferences. */
export const reading = computed(() => current.value)

/** Replace some fields and persist. Values are clamped to their ranges. */
export function updateReading(patch: Partial<ReadingPrefs>): void {
  const next: ReadingPrefs = {
    ...current.value,
    ...patch,
  }
  next.fontSize = clamp(Math.round(next.fontSize), FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max)
  next.lineHeight = clamp(next.lineHeight, LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max)
  next.measure = clamp(Math.round(next.measure), MEASURE_RANGE.min, MEASURE_RANGE.max)
  current.value = next
  saveReading(next)
}

/** Reset every field to its default, for a "restore" control. */
export function resetReading(): void {
  current.value = { ...DEFAULT_READING }
  saveReading(current.value)
}

/**
 * Inline style object a reader applies to its text container.
 *
 * Kept here rather than duplicated in two components: if the two readers compute
 * this themselves, one of them eventually measures `ch` differently or forgets
 * `max-width` and the setting appears to work in only one place.
 */
export function readingStyle(): Record<string, string> {
  return {
    fontSize: `${current.value.fontSize}px`,
    lineHeight: String(current.value.lineHeight),
    maxWidth: `${current.value.measure}ch`,
  }
}
