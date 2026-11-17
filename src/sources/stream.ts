/**
 * Building `kazumi-stream://` URLs.
 *
 * Every media request the player makes — the playlist, each segment, keys — goes
 * through the Rust proxy, because that is where the Referer and User-Agent live.
 * The origin server never sees the webview directly.
 *
 * ## Why the parameters are in the URL
 *
 * No server-side session means no cross-contamination: two episodes, or two
 * sources with different Referers, cannot interfere. Replaying a request from a
 * cold start works because the URL carries everything.
 *
 * The encoding must match `stream.rs::encode_target` byte for byte. `encodeURIComponent`
 * leaves `!'()*` alone whereas Rust escapes them, which would make the two sides
 * disagree about a URL containing those characters. Re-encoding them here keeps
 * one canonical form.
 */

/** The scheme name, matching `proto.rs::SCHEME`. */
export const STREAM_SCHEME = 'kazumi-stream'

/**
 * The origin that actually reaches the scheme handler.
 *
 * Tauri maps a custom scheme to a real HTTP origin on some platforms and not
 * others, and the difference is not cosmetic — the wrong form fails at
 * `fetch` before the handler is ever called:
 *
 * - **Windows / Android:** custom protocols are served over
 *   `http://<scheme>.localhost`. A `kazumi-stream://` URL gets
 *   `TypeError: Failed to fetch`.
 * - **macOS / Linux:** the scheme stays `kazumi-stream://localhost`.
 *
 * Detected from the platform rather than configured, because it is a property of
 * the webview, not of this app. A wrong guess fails loudly at the first media
 * request, which is why `scripts/verify-stream-proxy.mjs` exercises both forms
 * against the running app.
 */
function streamOrigin(): string {
  const isWindowsOrAndroid =
    /Windows|Android/i.test(navigator.userAgent) ||
    // WebView2 reports Windows in the UA; a fallback for a stripped UA is the
    // fact that the app itself is running under Tauri on a desktop.
    typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined' &&
      /Win/i.test(navigator.platform ?? '')
  return isWindowsOrAndroid
    ? `http://${STREAM_SCHEME}.localhost`
    : `${STREAM_SCHEME}://localhost`
}

export interface StreamTarget {
  /** Absolute media URL. */
  url: string
  /** Referer the origin expects, if the source declared one. */
  referer?: string | null
  /** User-Agent to present, if the source declared one. */
  userAgent?: string | null
}

/**
 * Percent-encode a value the way `stream.rs::encode_target` does.
 *
 * `encodeURIComponent` is the right base — it already escapes `&`, `?`, `#` and
 * `%` — but it deliberately leaves `!'()*` unescaped. Rust escapes them. Rather
 * than change the Rust side (its more aggressive set is safer), normalise here.
 */
export function encodeStreamParam(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * Build a proxy URL for one media target.
 *
 * Empty referer/UA are omitted rather than sent as empty strings: an empty
 * `Referer` header is different from no header at all, and some origins reject it.
 */
export function streamUrl(target: StreamTarget): string {
  const params = [`u=${encodeStreamParam(target.url)}`]
  if (target.referer) params.push(`r=${encodeStreamParam(target.referer)}`)
  if (target.userAgent) params.push(`ua=${encodeStreamParam(target.userAgent)}`)
  return `${streamOrigin()}/stream?${params.join('&')}`
}

/**
 * Whether a URL is one of ours.
 *
 * Both origins are accepted: a URL may have been built on a platform that uses the
 * other form (a saved progress record, a test), and rejecting it would turn a
 * cosmetic difference into a playback failure.
 */
export function isStreamUrl(url: string): boolean {
  return (
    url.startsWith(`${STREAM_SCHEME}://`) ||
    url.includes(`//${STREAM_SCHEME}.localhost/`)
  )
}

/** The audio/video MIME hint for a URL, from its extension. */
export function mediaTypeOf(url: string): 'hls' | 'mp4' | 'unknown' {
  const path = url.split('?')[0]?.toLowerCase() ?? ''
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls'
  if (path.endsWith('.mp4') || path.endsWith('.m4v') || path.endsWith('.webm')) return 'mp4'
  return 'unknown'
}
