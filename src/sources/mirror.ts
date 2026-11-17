/**
 * The community rule catalogue, fetched through a mirror.
 *
 * ## Why a mirror is a setting rather than a constant
 *
 * The rules live in a GitHub repository. `raw.githubusercontent.com` is unreachable
 * from some networks — measured unreachable from where this was written — while two
 * relays answered in under a second. Which one works depends on where you are, so it
 * cannot be hard-coded.
 *
 * ## Why the frontend picks an id, not a URL
 *
 * The mirror list is compiled into Rust and each id maps to one base URL there.
 * Letting the frontend pass a URL would turn the command into a general proxy, which
 * is exactly what `net.rs` and `proto.rs` are careful not to be.
 */

import { invoke } from '@tauri-apps/api/core'

/** The mirrors the Rust side knows about. */
export type MirrorId = 'gitcode' | 'ghproxy' | 'github'

/** Display order, matching Rust's `all_mirrors`. */
export const MIRRORS: readonly MirrorId[] = ['gitcode', 'ghproxy', 'github']

const STORAGE_KEY = 'litearti.rules.mirror'

/**
 * The default.
 *
 * GitCode, because it measured ~4× faster than the gh-proxy relay and does not
 * depend on a third-party proxy staying up. The upstream direct option is kept for
 * networks where GitHub works, since it adds no intermediary.
 */
const DEFAULT_MIRROR: MirrorId = 'gitcode'

/** Read the chosen mirror, falling back when the stored value is not a known id. */
export function loadMirror(): MirrorId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && (MIRRORS as readonly string[]).includes(raw)) return raw as MirrorId
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return DEFAULT_MIRROR
}

export function saveMirror(mirror: MirrorId): void {
  try {
    localStorage.setItem(STORAGE_KEY, mirror)
  } catch {
    // Best-effort: the choice still applies for this session.
  }
}

/** One entry in the catalogue. */
export interface RuleSummary {
  name: string
  version: string
  author: string
  /** Milliseconds since the epoch, or null when the catalogue omits it. */
  lastUpdate: number | null
}

/**
 * Parse the catalogue.
 *
 * Kept lenient: the file is maintained by another project, and a single malformed
 * entry must not hide the other seventeen. Entries without a usable `name` are
 * dropped, because the name is what the rule is fetched by.
 */
export function parseIndex(raw: string): RuleSummary[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('规则索引不是合法 JSON')
  }
  if (!Array.isArray(parsed)) return []

  const out: RuleSummary[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (!name) continue
    out.push({
      name,
      version: typeof value.version === 'string' ? value.version : '',
      author: typeof value.author === 'string' ? value.author : '',
      lastUpdate:
        typeof value.lastUpdate === 'number' && Number.isFinite(value.lastUpdate)
          ? value.lastUpdate
          : null,
    })
  }
  return out
}

/** Fetch the catalogue through the given mirror. */
export async function fetchIndex(mirror: MirrorId): Promise<RuleSummary[]> {
  const raw = await invoke<string>('rules_index', { mirror })
  return parseIndex(raw)
}

/** Fetch one rule's JSON text. */
export async function fetchRule(mirror: MirrorId, name: string): Promise<string> {
  return invoke<string>('rules_rule', { mirror, name })
}
