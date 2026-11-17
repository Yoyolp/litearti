/**
 * Aggregate search: ask several sources at once, keep the failures visible.
 *
 * The single-source browse view answers "does this source have it". The question
 * people actually have is "where can I read this", and answering it by opening
 * five sources and retyping the same keyword five times is the current cost. This
 * module does that in one pass.
 *
 * ## What it deliberately does not do
 *
 * **No cross-source merging.** Two sources returning the same book are two rows,
 * because deciding they are the same book requires title fuzzy-matching, and that
 * gets it wrong just often enough to hide the real result. The UI labels every row
 * with its source instead; comparing is the person's job, and it is cheap.
 *
 * ## Failure is a result, not an absence
 *
 * A source that times out is reported as a timed-out source with its own message.
 * Silently dropping it would make "no results" and "could not ask" look identical,
 * which is the worst confusion in a scraper.
 */

import type { BookSource, ResourceType } from './schema'
import { SourceEngine, type SourceItem } from './engine'

/** How many sources may be in flight at once. */
export const DEFAULT_CONCURRENCY = 4

/** Per-source deadline. A slow site must not hold the whole search hostage. */
export const DEFAULT_TIMEOUT_MS = 12_000

export type AggregateOutcome =
  | {
      kind: 'ok'
      sourceId: string
      sourceName: string
      items: SourceItem[]
      /** How many rows the list selector matched but the fields could not parse. */
      skipped: number
      /** Wall-clock time for this source, so a slow-but-working source is visible. */
      elapsedMs: number
    }
  | {
      kind: 'error'
      sourceId: string
      sourceName: string
      message: string
      elapsedMs: number
    }

export interface AggregateOptions {
  /** Keyword typed by the person. */
  keyword: string
  /** Which sources to ask. Callers usually pass the enabled, matching-type ones. */
  sources: readonly BookSource[]
  /** Called as each source settles, so results can appear as they arrive. */
  onSettled?: (outcome: AggregateOutcome) => void
  /** Cancels the whole run; checks between dispatches and after each await. */
  signal?: { cancelled: boolean }
  concurrency?: number
  timeoutMs?: number
  /**
   * Builds an engine for a source.
   *
   * Injected so this module has no opinion about sandboxes or DOM mounting — and
   * so a test can drive it with a fake that returns fixed items.
   */
  engineFor?: (source: BookSource) => SourceEngine
  /**
   * Where to park per-engine sandbox iframes.
   *
   * A source that uses `@js:` needs a mounted frame, and each engine needs its
   * own — so the batch cannot share one. When this is omitted, `@js:` sources get
   * a clear error instead of a confusing null; when it is present, one zero-sized
   * div per engine is created and removed with the engine.
   */
  mountHost?: HTMLElement
}

/**
 * Turn a failure into one sentence.
 *
 * The distinction that matters to a reader is "the site said no" versus "we never
 * got there" versus "the rule is broken". Anything else is detail that belongs in
 * the expanded view.
 */
function describeFailure(cause: unknown, timeoutMs: number): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/超时|timeout|timed out/i.test(message)) {
    // A transport timeout already names its own deadline, which is more accurate
    // than the aggregate's ceiling — so keep the message when it has one.
    return /秒|秒数/.test(message) ? message : `超过 ${Math.round(timeoutMs / 1000)} 秒没有响应`
  }
  if (/选择器|SelectorError|selector/i.test(message)) {
    return `规则有问题：${message}`
  }
  if (/HTTP\s*(4\d\d|5\d\d)/i.test(message)) {
    return message
  }
  if (/fetch|network|请求失败|Failed to fetch|无法连接/i.test(message)) {
    return message.startsWith('无法') || message.startsWith('请求') ? message : `无法访问网站：${message}`
  }
  return message
}

/** Reject after `ms`, so one stuck source cannot stall the batch. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Run the aggregate search.
 *
 * Resolves with every outcome, successes first in completion order — not in source
 * order, because making the fast sources wait for the slow one is exactly the
 * latency this feature exists to remove. The caller renders as they land via
 * `onSettled`.
 */
export async function aggregateSearch(options: AggregateOptions): Promise<AggregateOutcome[]> {
  const {
    keyword,
    sources,
    onSettled,
    signal,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    engineFor,
    mountHost,
  } = options

  const outcomes: AggregateOutcome[] = []
  if (!sources.length || !keyword.trim()) return outcomes

  const queue = [...sources]
  const limit = Math.max(1, Math.min(concurrency, sources.length))

  /** One private mount point per engine, cleaned up with it. */
  function createMountSlot(): HTMLElement | undefined {
    if (!mountHost) return undefined
    const slot = document.createElement('div')
    slot.className = 'aggregate-sandbox'
    slot.setAttribute('aria-hidden', 'true')
    mountHost.appendChild(slot)
    return slot
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (signal?.cancelled) return
      const source = queue.shift()
      if (!source) return

      const startedAt = Date.now()
      const slot = createMountSlot()
      const engine = engineFor ? engineFor(source) : new SourceEngine(source, undefined, slot)

      try {
        // The timeout wraps the whole per-source operation, not one request: a
        // source may legitimately need a redirect or a second page, and cutting
        // it off mid-flight would report a working source as broken.
        const { items, diagnoses } = await withTimeout(
          engine.searchWithDiagnoses(keyword),
          timeoutMs,
          source.name,
        )
        if (signal?.cancelled) return
        const outcome: AggregateOutcome = {
          kind: 'ok',
          sourceId: source.id,
          sourceName: source.name,
          items,
          skipped: diagnoses.length,
          elapsedMs: Date.now() - startedAt,
        }
        outcomes.push(outcome)
        onSettled?.(outcome)
      } catch (cause) {
        if (signal?.cancelled) return
        const outcome: AggregateOutcome = {
          kind: 'error',
          sourceId: source.id,
          sourceName: source.name,
          message: describeFailure(cause, timeoutMs),
          elapsedMs: Date.now() - startedAt,
        }
        outcomes.push(outcome)
        onSettled?.(outcome)
      } finally {
        // A plain search does not touch the sandbox, but a source that uses `@js:`
        // creates one. Disposing unconditionally costs nothing and is the only
        // reliable place to do it.
        engine.dispose()
        slot?.remove()
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))
  return outcomes
}

/** Sources worth asking: enabled, and of the given resource kind. */
export function sourcesForType(
  sources: readonly BookSource[],
  type: ResourceType | null,
): BookSource[] {
  return sources.filter((source) => source.enabled && (type === null || source.type === type))
}
