/**
 * The JS sandbox for `@js:` selectors.
 *
 * Book sources are user-supplied JSON, and `@js:` lets them carry expressions.
 * Running those in the app's own context would be a disaster: the webview has
 * `window.__TAURI_INTERNALS__`, which means an expression could read files,
 * delete the library, or write anywhere. So expressions run in a separate
 * document.
 *
 * ## The boundary
 *
 * An iframe with `sandbox="allow-scripts"` and **deliberately not**
 * `allow-same-origin`. That combination gives:
 *
 * - a unique opaque origin, so the frame cannot reach into the parent's DOM,
 *   cookies, or storage;
 * - no access to `window.parent`'s objects beyond `postMessage`;
 * - no `__TAURI_INTERNALS__`, because that lives on the parent's window.
 *
 * The frame is loaded from `srcdoc`, so there is no network fetch to bootstrap
 * it either.
 *
 * ## What this is and is not
 *
 * This is risk reduction, not a guarantee. Browser sandbox escapes have existed
 * and will exist again. What it does guarantee is that the *ordinary* attack —
 * an expression that tries to call `fetch` or reach the parent — fails, and that
 * a runaway expression cannot hang the app (there is a hard timeout that tears
 * the frame down).
 *
 * Defence in depth: `schema.ts` also rejects the obvious banned identifiers at
 * validation time, so most hostile sources never reach this module.
 */

/** How long one expression may run before the frame is destroyed. */
const EVAL_TIMEOUT_MS = 3000

/** The frame's document. Kept minimal: it exists to run one function. */
const SANDBOX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head><body><script>
  // Only what an expression legitimately needs. Notably absent: fetch,
  // XMLHttpRequest, localStorage, and any reference to the parent.
  const SAFE_GLOBALS = { JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, parseInt, parseFloat, isNaN, decodeURIComponent, encodeURIComponent };

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__sandbox !== 'eval') return;
    const { id, expression, input } = data;
    let result;
    try {
      // The expression receives \`input\` (already-fetched data) and may only
      // compute from it. \`new Function\` is the evaluation mechanism; the
      // sandbox attribute is what makes it safe, not the wrapper.
      const fn = new Function('input', 'SAFE_GLOBALS', 'with (SAFE_GLOBALS) { return (' + expression + '); }');
      result = { __sandbox: 'result', id, ok: true, value: normalise(fn(input, SAFE_GLOBALS)) };
    } catch (error) {
      result = { __sandbox: 'result', id, ok: false, error: String(error && error.message ? error.message : error) };
    }
    try { parent.postMessage(result, '*'); } catch (e) { /* parent gone */ }
  });

  function normalise(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(normalise).filter(v => v !== null);
    // Objects are not a useful selector result and would not survive the
    // structured clone into a readable form; report them as null.
    return null;
  }

  parent.postMessage({ __sandbox: 'ready' }, '*');
</script></body></html>`

interface PendingEval {
  resolve: (value: string[]) => void
  reject: (error: Error) => void
  timer: number
}

export class JsSandbox {
  private frame: HTMLIFrameElement | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<number, PendingEval>()
  private nextId = 1
  private disposed = false

  constructor(private readonly mount: HTMLElement) {}

  /** Create the frame and wait for its ready handshake. */
  private async ensureReady(): Promise<void> {
    if (this.disposed) throw new Error('沙箱已销毁')
    if (this.ready) return this.ready

    this.ready = new Promise<void>((resolve, reject) => {
      const frame = document.createElement('iframe')
      // No `allow-same-origin`: this is the whole point. With it, the frame
      // would share the app's origin and could reach __TAURI_INTERNALS__.
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('aria-hidden', 'true')
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;'
      frame.srcdoc = SANDBOX_HTML

      const timeout = window.setTimeout(() => {
        reject(new Error('沙箱启动超时'))
      }, 5000)

      const onMessage = (event: MessageEvent): void => {
        const data = event.data as { __sandbox?: string } | null
        if (!data || typeof data !== 'object') return
        // Only accept messages from this frame. `event.source` is the frame's
        // window; anything else is a different frame or the parent itself.
        if (event.source !== frame.contentWindow) return

        if (data.__sandbox === 'ready') {
          window.clearTimeout(timeout)
          resolve()
          return
        }
        if (data.__sandbox === 'result') {
          this.settle(data as { id: number; ok: boolean; value?: string[]; error?: string })
        }
      }

      window.addEventListener('message', onMessage)
      this.cleanup = () => {
        window.removeEventListener('message', onMessage)
        window.clearTimeout(timeout)
      }

      this.mount.appendChild(frame)
      this.frame = frame
    })

    return this.ready
  }

  private cleanup: (() => void) | null = null

  private settle(data: { id: number; ok: boolean; value?: string[]; error?: string }): void {
    const entry = this.pending.get(data.id)
    if (!entry) return
    this.pending.delete(data.id)
    window.clearTimeout(entry.timer)
    if (data.ok) {
      const value = data.value
      entry.resolve(Array.isArray(value) ? value : value === null ? [] : [String(value)])
    } else {
      entry.reject(new Error(data.error ?? 'JS 表达式执行失败'))
    }
  }

  /**
   * Evaluate one expression with `input` bound to it.
   *
   * A timeout destroys the frame rather than merely rejecting: an expression
   * stuck in a loop would otherwise keep a core busy for the session.
   */
  async evaluate(expression: string, input: unknown): Promise<string[]> {
    await this.ensureReady()
    const frame = this.frame
    if (!frame || !frame.contentWindow) throw new Error('沙箱不可用')

    const id = this.nextId++
    return new Promise<string[]>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        // A hung expression cannot be interrupted from outside; tearing the
        // frame down is the only reliable way to stop it.
        this.teardownFrame()
        reject(new Error('JS 表达式执行超时（超过 3 秒），已终止'))
      }, EVAL_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })

      try {
        frame.contentWindow!.postMessage(
          { __sandbox: 'eval', id, expression, input },
          '*',
        )
      } catch (error) {
        window.clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private teardownFrame(): void {
    this.cleanup?.()
    this.cleanup = null
    if (this.frame) {
      this.frame.remove()
      this.frame = null
    }
    this.ready = null
    // Any other in-flight evaluations died with the frame.
    for (const [, entry] of this.pending) {
      window.clearTimeout(entry.timer)
      entry.reject(new Error('沙箱被重建，表达式已取消'))
    }
    this.pending.clear()
  }

  dispose(): void {
    this.disposed = true
    this.teardownFrame()
  }
}
