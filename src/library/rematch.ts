/**
 * Finding a title on another source after the original one disappeared.
 *
 * ## Why only exact matches
 *
 * The obvious approach is similarity scoring — normalise, then accept anything above
 * some threshold. It is rejected here on purpose. Anime sites reuse titles heavily:
 * 「孤独摇滚」 and 「孤独摇滚 第二季」 are different shows, TV and movie cuts share a
 * name, and a live-action adaptation can carry the same characters. A fuzzy match
 * that silently swaps the entry would put someone in the wrong show, and they might
 * not notice for an entire episode.
 *
 * So the rule is: normalise hard, then require **exact equality**. Missing a match
 * costs one manual switch. Matching wrongly costs trust in the whole feature.
 *
 * ## Normalisation
 *
 * Only transformations that cannot change which show is meant:
 * - full-width → half-width (a full-width digit is the same digit)
 * - traditional → simplified (same word, different orthography)
 * - strip whitespace, punctuation, and bracketed asides like 【】（）[]
 *
 * Case is folded because a Latin title capitalised differently is the same title.
 */

/** Characters that never distinguish one title from another. */
const NOISE =
  /[\s\u3000·・:：,，.。!！?？\-—_~～/／\\|｜+＋&＆'‘’"“”`、;；<>《》〈〉()（）[\]【】{}｛｝]/g

/**
 * Traditional → simplified pairs, as a flat string.
 *
 * Written as `繁简` pairs rather than an object literal for a practical reason: a
 * hand-maintained object of a few hundred entries accumulates duplicate keys, and a
 * duplicate key is a compile error that says nothing about which character was
 * mistyped. Parsing a string makes duplicates harmless — the last one wins — and
 * keeps the data readable.
 *
 * The set is deliberately small. A full conversion table is thousands of entries and
 * has no business being in a source file. These are the characters that actually
 * appear in Chinese names of anime and manga, which is the only place this is used.
 * A title containing an unmapped character simply fails to match, which is the safe
 * direction.
 */
const TRADITIONAL_PAIRS =
  '戰战記记進进擊击鋼钢煉炼術术師师學学園园會会體体驗验動动畫画劇剧場场' +
  '遊游戲戏龍龙與与貓猫戀恋愛爱時时間间無无雙双劍剑騎骑傳传說说話话語语' +
  '讀读書书圖图館馆國国際际線线級级給给業业產产團团队队員员軍军鬥斗爭争' +
  '奪夺權权靈灵魂魂獸兽鳥鸟魚鱼鷹鹰風风雲云電电气气聲声響响樂乐夢梦現现' +
  '實实虛虚構构創创開开關关閉闭發发過过這这个个們们來来將将經经歷历險险' +
  '難难應应對对從从於于為为還还麼么東东極极点点總总統统結结續续終终轉转' +
  '輪轮迴回歸归隱隐尋寻誰谁認认識识親亲敵敌殺杀傷伤醫医药药療疗機机裝装' +
  '飛飞艦舰銀银縣县區区邊边裡里裏里內内頭头長长髮发臉脸鏡镜紅红綠绿藍蓝' +
  '黃黄鐵铁憶忆懷怀願愿藝艺术乐憂忧憂懼惧驚惊嘆叹嗎吗呢呢戀恋髮发'

/** Traditional → simplified, built once from the pair string. */
const TRADITIONAL_TO_SIMPLIFIED: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  // Two code points per pair. `Array.from` rather than index arithmetic so a pair
  // sits in one UTF-16 unit only by accident; this stays correct either way.
  const chars = Array.from(TRADITIONAL_PAIRS)
  for (let index = 0; index + 1 < chars.length; index += 2) {
    map.set(chars[index], chars[index + 1])
  }
  return map
})()

/**
 * Normalise a title to a comparable key.
 *
 * Returns an empty string when nothing is left, which callers must treat as
 * "cannot compare" rather than "matches everything".
 */
export function normalizeTitle(raw: string): string {
  if (!raw) return ''
  let folded = ''
  for (const char of raw) {
    folded += TRADITIONAL_TO_SIMPLIFIED.get(char) ?? char
  }
  // Full-width ASCII (U+FF01..U+FF5E) folds to half-width by subtracting 0xFEE0.
  folded = folded.replace(/[\uFF01-\uFF5E]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  )
  return folded.replace(NOISE, '').toLowerCase()
}

/** Whether two titles name the same thing, by the strict rule above. */
export function sameTitle(a: string, b: string): boolean {
  const left = normalizeTitle(a)
  const right = normalizeTitle(b)
  // An empty key matches nothing, including another empty key: two titles that are
  // both punctuation are not evidence of anything.
  if (!left || !right) return false
  return left === right
}

/**
 * Pick a candidate whose title equals `title`.
 *
 * `candidates` is already the result of a search on another source, so this only
 * decides whether any of them is the same show. Returns the first exact match, or
 * null. First rather than best: with exact equality there is no ranking to do, and
 * inventing one would reintroduce the guesswork this module exists to avoid.
 */
export function findExactMatch<T extends { title: string }>(
  title: string,
  candidates: readonly T[],
): T | null {
  for (const candidate of candidates) {
    if (sameTitle(title, candidate.title)) return candidate
  }
  return null
}
