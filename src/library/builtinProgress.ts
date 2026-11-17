/**
 * Progress readers for the built-in viewers.
 *
 * Each one understands the payload its viewer writes, and nothing else. They
 * live together because they are five small functions over the same contract;
 * splitting them into each viewer's directory would spread one decision across
 * five files without making any of them clearer.
 *
 * The shapes these read are documented at their writers:
 *   text  — `TextReader.vue`  `{ version: 1, ratio, fontSize?, chapter? }`
 *   pdf   — `PdfReader.vue`   `{ version: 1, page }`
 *   epub  — `EpubReader.vue`  `{ version: 1, chapter, ratio?, fontSize?, mode? }`
 *   audio — `AudioPlayer.vue` `{ version: 1, time, rate? }`
 *
 * Anything unrecognised returns null, which the registry turns into "no
 * progress shown". That is the right failure mode: a row without a percentage
 * is a small loss, a thrown exception in the middle of a list is not.
 */

import { t } from '@/i18n'
import type { ProgressReader } from './progress'
import { formatDuration } from '@/utils/format'

/** Narrow an unknown payload, or null when it is not an object at all. */
function asRecord(progress: unknown): Record<string, unknown> | null {
  if (progress === null || typeof progress !== 'object') return null
  return progress as Record<string, unknown>
}

/** A finite number in [0, 1], or null. */
function ratioOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > 1) return null
  return value
}

/**
 * Text: mostly a scroll ratio, but a chaptered file also carries a chapter
 * index. The chapter number is the more useful hint of "how far in", so it wins
 * when present — the same precedence the old inline version had.
 */
const readTextProgress: ProgressReader = (progress) => {
  const raw = asRecord(progress)
  if (!raw) return null

  const chapter = raw.chapter
  if (typeof chapter === 'number' && Number.isInteger(chapter) && chapter >= 0) {
    return {
      // A chapter index is not a fraction of the book, so there is no honest
      // bar to draw; the label carries the information instead.
      ratio: ratioOf(raw.ratio),
      label: t('entry.progress.chapter', { chapter: chapter + 1 }),
    }
  }

  const ratio = ratioOf(raw.ratio)
  if (ratio === null) return null
  const percent = Math.round(ratio * 100)
  return {
    ratio,
    // Below 1% there is nothing worth saying, and "已读 0%" reads as a bug.
    label: percent >= 1 ? t('entry.progress', { percent }) : null,
  }
}

/**
 * PDF: a page number and nothing else.
 *
 * The payload has no total page count — the viewer does not write one — so a
 * progress bar would require inventing a denominator. The label is the honest
 * form, matching what the old inline version did.
 */
const readPdfProgress: ProgressReader = (progress) => {
  const raw = asRecord(progress)
  if (!raw) return null
  const page = raw.page
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null
  if (page === 1) return { ratio: null, label: null }
  return { ratio: null, label: t('entry.progress.page', { page }) }
}

/**
 * EPUB: a spine index plus a within-chapter ratio for reflowable books.
 *
 * A fixed-layout book has no ratio, so only the chapter is known. A chapter
 * index of 0 is the first chapter, which is worth showing — unlike page 1 of a
 * PDF, "第 1 章" tells you the book was opened.
 */
const readEpubProgress: ProgressReader = (progress) => {
  const raw = asRecord(progress)
  if (!raw) return null
  const chapter = raw.chapter
  if (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter < 0) return null
  return {
    ratio: ratioOf(raw.ratio),
    label: t('entry.progress.chapter', { chapter: chapter + 1 }),
  }
}

/**
 * Audio: an elapsed timestamp, with no duration stored.
 *
 * So the label reports how much has been heard rather than a fake percentage.
 * Under five seconds is treated as "not really started" — the viewer saves on
 * pause and on unload, and a payload from a mis-click is not progress.
 */
const readAudioProgress: ProgressReader = (progress) => {
  const raw = asRecord(progress)
  if (!raw) return null
  const time = raw.time
  if (typeof time !== 'number' || !Number.isFinite(time)) return null
  if (time < 5) return { ratio: null, label: null }
  return { ratio: null, label: t('entry.progress.audio', { time: formatDuration(time) }) }
}

/** Register every built-in reader. Idempotent, so HMR can call it again. */
export function registerBuiltinProgressReaders(
  register: (extensions: readonly string[], read: ProgressReader) => void,
): void {
  register(['txt', 'md', 'log', 'text', 'csv', 'json', 'yml', 'yaml'], readTextProgress)
  register(['pdf'], readPdfProgress)
  register(['epub'], readEpubProgress)
  register(['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'weba'], readAudioProgress)
}
