/**
 * The export target registry.
 *
 * Deliberately the same shape as `viewers/registry.ts`: the shell asks the
 * registry "what can this file become", and never learns what a PDF or an EPUB
 * is. Adding a target (Markdown, a custom container, an image bundle) means
 * calling `registerConvertTarget` — no edit to the library view, the store, or
 * the pipeline.
 *
 * The one target the pipeline special-cases is `original`, which means "copy
 * the stored bytes verbatim". It has no converter because there is nothing to
 * convert; treating it as a normal target would force every converter to
 * re-implement a byte copy.
 */

import type { DecodedText, Entry } from '@/types/viewer'

/** What a converter is handed. It gets capabilities, never the filesystem. */
export interface ConvertInput {
  entry: Entry
  /** Raw stored bytes. */
  readBinary: () => Promise<ArrayBuffer>
  /** Decoded text, with the same sniffing rules as the text viewer. */
  readText: (encoding?: string) => Promise<DecodedText>
}

/** Bytes or text; text is written as UTF-8. */
export type ConvertOutput = string | Uint8Array

export interface ConvertTarget {
  /** Stable identifier. `original` is reserved for the byte copy. */
  id: string
  /** Human label shown in the menu. */
  label: string
  /**
   * Extension for the output, without the dot. An empty string means "keep the
   * source extension", which is what `original` does.
   */
  extension: string
  /**
   * Source extensions this target accepts. `'all'` accepts everything.
   *
   * Audio, for instance, has no text representation here, so the text target
   * simply does not list audio extensions and the menu greys it out for those
   * entries instead of failing at write time.
   */
  supports: string[] | 'all'
  /**
   * Produce the output. Absent only for `original`, which the pipeline handles
   * by copying bytes.
   */
  convert?: (input: ConvertInput) => Promise<ConvertOutput>
  /** Why a format is unsupported, shown next to a greyed-out menu item. */
  unsupportedReason?: string
}

const registry: ConvertTarget[] = []

/** Register one target. Later registrations with the same id replace earlier. */
export function registerConvertTarget(target: ConvertTarget): void {
  if (!target.id) throw new Error('convert target needs an id')
  if (target.supports !== 'all' && !target.supports.length) {
    throw new Error(`convert target "${target.id}" supports nothing`)
  }
  if (target.id !== 'original' && !target.convert) {
    throw new Error(`convert target "${target.id}" has no converter`)
  }
  const existing = registry.findIndex((t) => t.id === target.id)
  if (existing >= 0) registry[existing] = target
  else registry.push(target)
}

/** Every registered target, in registration order. */
export function allTargets(): ConvertTarget[] {
  return [...registry]
}

/** Whether a target accepts this extension. */
export function targetSupports(target: ConvertTarget, extension: string): boolean {
  if (target.supports === 'all') return true
  return target.supports.includes(extension.toLowerCase())
}

/**
 * Targets that accept this extension.
 *
 * Used both to decide whether a menu item is enabled and to skip entries
 * during a mixed selection.
 */
export function targetsFor(extension: string): ConvertTarget[] {
  return registry.filter((target) => targetSupports(target, extension))
}

/** Whether *any* registered target converts this extension to text. */
export function canConvertToText(extension: string): boolean {
  return registry.some((t) => t.id !== 'original' && targetSupports(t, extension))
}
