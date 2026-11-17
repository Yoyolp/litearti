/**
 * Matching a Bangumi title against search results from a source.
 *
 * ## Why this is fuzzy when re-matching is exact
 *
 * `library/rematch.ts` requires titles to be **identical after normalisation**, and
 * this module deliberately does not. The difference is what a wrong answer costs:
 *
 * | | re-match | discover |
 * |---|---|---|
 * | what it does | **overwrites** the source an existing entry points at | opens a search result |
 * | cost of a false positive | the entry silently points at the wrong show, and the person may watch an episode before noticing | one wrong result is shown next to the right one |
 * | cost of a false negative | the entry stays broken, visibly | nothing happens, and the person searches by hand |
 *
 * Re-matching rewrites stored data, so its bar is "provably the same title". Here the
 * worst case is a mis-ordered result list, and the alternative — exact matching
 * between Bangumi's canonical titles and whatever a site typed — would miss most
 * shows. Bangumi says「孤独摇滚！」, a site says「孤独摇滚 第一季」.
 *
 * ## The measure
 *
 * Dice coefficient over character bigrams. Chosen over edit distance because it is
 * insensitive to word order and to a shared prefix, which is exactly the variation
 * seen here: titles differ by a season marker, punctuation, or a subtitle appended.
 *
 * Normalisation is shared with `rematch.ts` — same folding, so a title that would be
 * "equal" there can never score below 1 here.
 */

import { normalizeTitle } from '@/library/rematch'

/**
 * Minimum score to consider a result related.
 *
 * Calibrated against real fixture titles paired with plausible site titles; see
 * `scripts/verify-bgm-match.mjs`, which asserts both directions.
 */
export const MATCH_THRESHOLD = 0.6

/**
 * Suffixes that mean "another season of the same show" rather than "a different
 * show".
 *
 * Stripped before scoring, which fixes a real ranking bug: raw Dice coefficient
 * rewards a *shorter* suffix, so「进击的巨人 中学」(0.80, a parody spin-off) outranked
 * 「进击的巨人 第一季」(0.727, the actual show). Removing the continuation marker makes
 * the season variants score a clean 1.0, which puts them where they belong.
 *
 * The list is deliberately limited to markers that cannot denote a different work.
 * Anything ambiguous — `剧场版`, `番外`, `中学`, `OVA`, `总集篇`, `真人版` — is left in
 * place, so those variants stay distinguishable instead of collapsing onto the base
 * title and tying with it.
 */
const CONTINUATION_MARKERS: readonly RegExp[] = [
  // 第一季 / 第2季 / 第 12 季, also 第X期 (broadcast season).
  /第[0-9一二三四五六七八九十百]+[季期]$/,
  // 最终季 / 完结篇 / 最终章 as a trailing marker.
  /(最终季|最终章|完结篇|完結篇)$/,
  // Season 2 / Season II / S2.
  /(?:season|s)[0-9]+$/,
  // Part 2 / 第2部分.
  /(?:part|第)?[0-9]+部分$/,
]

/**
 * Drop a trailing "same show, next season" marker from a normalised title.
 *
 * Applied repeatedly so「第二季 最终季」and similar stacks reduce fully. Returns the
 * input unchanged when no marker matches, which is the common case.
 */
function stripContinuation(normalized: string): string {
  let text = normalized
  // Two passes is enough for any real title; a loop with a guard would be more code
  // for a case that does not occur.
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false
    for (const pattern of CONTINUATION_MARKERS) {
      const next = text.replace(pattern, '')
      if (next !== text && next.length > 0) {
        text = next
        changed = true
      }
    }
    if (!changed) break
  }
  return text
}

/** Character bigrams of a string. Falls back to unigrams for one-character input. */
function bigrams(text: string): string[] {
  if (text.length <= 1) return text ? [text] : []
  const out: string[] = []
  for (let index = 0; index < text.length - 1; index += 1) {
    out.push(text.slice(index, index + 2))
  }
  return out
}

/** Compare two titles that have already been normalised and de-suffixed. */
function dice(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right) return 1

  const leftGrams = bigrams(left)
  const rightGrams = bigrams(right)
  if (!leftGrams.length || !rightGrams.length) return 0

  // Multiset intersection: a repeated bigram may only be counted as often as it
  // appears on both sides, otherwise a title that repeats one syllable would score
  // high against anything.
  const pool = new Map<string, number>()
  for (const gram of leftGrams) pool.set(gram, (pool.get(gram) ?? 0) + 1)

  let shared = 0
  for (const gram of rightGrams) {
    const count = pool.get(gram) ?? 0
    if (count > 0) {
      shared += 1
      pool.set(gram, count - 1)
    }
  }

  return (2 * shared) / (leftGrams.length + rightGrams.length)
}

/**
 * Similarity of two titles, in [0, 1].
 *
 * Symmetric in spirit but not in effect: both sides are de-suffixed, so
 * 「孤独摇滚」against「孤独摇滚 第二季」and the reverse both score 1. Returns 0 when
 * either side normalises to nothing — an empty key carries no evidence.
 */
export function similarity(a: string, b: string): number {
  const left = normalizeTitle(a)
  const right = normalizeTitle(b)
  if (!left || !right) return 0
  if (left === right) return 1

  // Score the plain forms and the de-suffixed forms, and keep the best. A season
  // marker on one side should not count against it, but stripping it must never make
  // two unrelated titles look closer than they are — so the raw score stays in the
  // running rather than being replaced.
  return Math.max(dice(left, right), dice(stripContinuation(left), stripContinuation(right)))
}

/** One candidate with its score, so callers can show why it was picked. */
export interface ScoredCandidate<T> {
  item: T
  score: number
}

/**
 * Score candidates against a title and keep the ones above the threshold.
 *
 * Sorted by score descending; ties keep the input order (a stable sort), so the
 * caller's own ranking — a source's search order — is respected as a tiebreak.
 */
export function rankCandidates<T extends { title: string }>(
  title: string,
  candidates: readonly T[],
  threshold = MATCH_THRESHOLD,
): ScoredCandidate<T>[] {
  const scored: ScoredCandidate<T>[] = []
  for (const item of candidates) {
    const score = similarity(title, item.title)
    if (score >= threshold) scored.push({ item, score })
  }
  // Explicit index tiebreak rather than relying on Array#sort stability, which is
  // guaranteed in modern engines but not obvious at the call site.
  const order = new Map<T, number>()
  candidates.forEach((item, index) => order.set(item, index))
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return (order.get(a.item) ?? 0) - (order.get(b.item) ?? 0)
  })
  return scored
}

/**
 * The single best candidate, or null.
 *
 * Used by the "open this show on a source" path, where picking one is the whole job.
 * Returning the score too lets the UI mention that it was not an exact match.
 */
export function bestMatch<T extends { title: string }>(
  title: string,
  candidates: readonly T[],
  threshold = MATCH_THRESHOLD,
): ScoredCandidate<T> | null {
  return rankCandidates(title, candidates, threshold)[0] ?? null
}
