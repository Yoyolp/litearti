/**
 * The only module that talks to Tauri.
 *
 * Every other module imports from here. That single choke point is what makes
 * the desktop-to-mobile move tractable: on Android, file picking, byte access
 * and progress storage all have different primitives, and only this file has
 * to grow a second implementation.
 */

import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import type { Entry } from '@/types/viewer'

export interface ImportReport {
  imported: Entry[]
  duplicates: number
  failed: { sourcePath: string; reason: string }[]
}

export interface DecodedText {
  text: string
  encoding: string
  hadBom: boolean
  lossy: boolean
}

/** Extensions the import dialog offers. Custom containers are added here
 *  once a viewer claims them — the list is a filter, not a capability. */
export const IMPORT_EXTENSIONS = [
  'txt',
  'md',
  'log',
  'pdf',
  'epub',
  'mp3',
  'm4a',
  'flac',
  'wav',
  'ogg',
  'opus',
] as const

export async function listEntries(): Promise<Entry[]> {
  return invoke<Entry[]>('library_list')
}

export async function importPaths(paths: string[]): Promise<ImportReport> {
  return invoke<ImportReport>('library_import', { paths })
}

export async function removeEntry(id: string): Promise<void> {
  await invoke('library_remove', { id })
}

export async function setProgress(id: string, progress: unknown): Promise<Entry> {
  return invoke<Entry>('library_set_progress', { id, progress })
}

export async function touchEntry(id: string): Promise<Entry> {
  return invoke<Entry>('library_touch', { id })
}

export async function readBinary(id: string): Promise<ArrayBuffer> {
  const response = await invoke<ArrayBuffer | number[]>('read_binary', { id })
  // Tauri returns a raw Response for byte commands; older paths may hand back
  // a plain array. Normalize so callers always get an ArrayBuffer.
  if (response instanceof ArrayBuffer) return response
  return new Uint8Array(response).buffer
}

export async function readText(id: string, encoding?: string): Promise<DecodedText> {
  return invoke<DecodedText>('read_text', { id, encoding })
}

export async function entryPath(id: string): Promise<string> {
  return invoke<string>('entry_path', { id })
}

/** One file handed to the backend for writing. */
export interface ExportFile {
  fileName: string
  bytes: Uint8Array
}

/** A file the backend refused to write. */
export interface ExportFailure {
  fileName: string
  reason: string
}

export interface ExportWriteOutcome {
  written: number
  /** Final names on disk, after collision handling. */
  writtenNames: string[]
  failed: ExportFailure[]
}

/**
 * Write converted files into a directory.
 *
 * Bytes are sent, not source paths: the backend must not be able to read from
 * anywhere a malformed call names. Per-file failures come back in the outcome
 * rather than as an error, so one bad file does not discard the batch.
 */
export async function exportWrite(
  dir: string,
  items: ExportFile[],
): Promise<ExportWriteOutcome> {
  return invoke<ExportWriteOutcome>('export_write', { dir, items })
}

// --- book sources ---------------------------------------------------------

/** One HTTP request made on behalf of a book source. */
export interface SourceFetchRequest {
  url: string
  method?: string
  body?: string
  headers?: Record<string, string>
  timeoutMs?: number
  /**
   * Which source is asking.
   *
   * The backend uses it to look up that source's login cookie. The cookie is
   * attached server-side and never travels through the renderer, so a malicious
   * or compromised page cannot read it even with full IPC access.
   */
  sourceId?: string
}

export interface SourceFetchResponse {
  status: number
  /** Final URL after redirects, used as the base for resolving relative links. */
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * Fetch a URL through the Rust side.
 *
 * The only network path in the app. It goes through Rust rather than `fetch`
 * because CORS would block nearly every site a book source targets, and because
 * the backend is where the scheme allowlist, timeout and size cap are enforced.
 */
export async function sourceFetch(request: SourceFetchRequest): Promise<SourceFetchResponse> {
  return invoke<SourceFetchResponse>('source_fetch', { request })
}

export async function sourcesLoad(): Promise<unknown> {
  return invoke<unknown>('sources_load')
}

export async function sourcesSave(sources: unknown): Promise<void> {
  await invoke('sources_save', { sources })
}

export async function sourceProgressLoad(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('source_progress_load')
}

export async function sourceProgressSave(progress: unknown): Promise<void> {
  await invoke('source_progress_save', { progress })
}

/**
 * Read a text file the person picked in a native dialog.
 *
 * Exists so importing a source JSON does not require `plugin-fs`. The path
 * always comes from a dialog the person operated.
 */
export async function readPickedTextFile(path: string): Promise<string> {
  return invoke<string>('read_picked_text_file', { path })
}

/**
 * Open a URL in the system browser.
 *
 * Not `window.open`: inside the Tauri webview that would replace the app window
 * with the site, losing the reader. The backend only accepts http(s).
 */
export async function openExternal(url: string): Promise<void> {
  await invoke('open_external', { url })
}

/** Metadata about a stored login. Deliberately carries no cookie value. */
export interface CredentialStatus {
  host: string
  /** Unix milliseconds. */
  updatedAt: number
  origin: string
  hasCookie: boolean
}

/**
 * Which sources have a stored login, and for which host.
 *
 * There is no counterpart that returns the cookie itself: the value never leaves
 * the backend.
 */
export async function credentialsStatus(): Promise<Record<string, CredentialStatus>> {
  return invoke<Record<string, CredentialStatus>>('credentials_status')
}

/** Forget one source's login. */
export async function credentialsClear(sourceId: string): Promise<void> {
  await invoke('credentials_clear', { sourceId })
}

/**
 * Open the site's login page in its own window and capture the cookies.
 *
 * Resolves as soon as the window opens; the result arrives through
 * {@link onLoginFinished}. Awaiting the whole login here would freeze the
 * sources screen for as long as the person takes to type a password.
 */
export async function sourceLoginStart(sourceId: string): Promise<void> {
  await invoke('source_login_start', { sourceId })
}

/** One login attempt's outcome, delivered when the login window closes. */
export interface LoginFinished {
  sourceId: string
  ok: boolean
  message: string
  cookieCount: number
}

/**
 * Subscribe to login outcomes.
 *
 * Returns an unsubscribe function. The event is emitted app-wide, so callers
 * filter by `sourceId`.
 */
export async function onLoginFinished(
  handler: (event: LoginFinished) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => {}
  try {
    const { listen } = await import('@tauri-apps/api/event')
    return await listen<LoginFinished>('source-login-finished', (event) => {
      handler(event.payload)
    })
  } catch {
    return () => {}
  }
}

/**
 * Import downloaded bytes into the library.
 *
 * Bytes rather than a URL: the download happens in the frontend where the
 * source definition lives. The backend only owns the filesystem half, and goes
 * through the same import path as a picked file.
 */
export async function sourceDownloadImport(
  title: string,
  extension: string,
  bytes: Uint8Array,
): Promise<Entry> {
  return invoke<Entry>('source_download_import', {
    title,
    extension,
    // Tauri serializes arrays, not typed arrays, across IPC.
    bytes: Array.from(bytes),
  })
}

/**
 * A URL the webview can actually load for an entry's stored copy.
 *
 * A raw filesystem path in `<audio src>` does not work: the webview refuses
 * `file://` origins. `convertFileSrc` rewrites it to the asset protocol, which
 * the Rust side allows for the app data directory.
 */
export async function entryUrl(id: string): Promise<string> {
  const path = await entryPath(id)
  return convertFileSrc(path)
}


/**
 * Show the native file picker and return the chosen paths.
 *
 * Returns an empty array when the person cancels — cancellation is not an
 * error and should not surface as one.
 */
export async function pickFiles(): Promise<string[]> {
  const selected = await openDialog({
    multiple: true,
    directory: false,
    filters: [
      { name: '所有支持的文件', extensions: [...IMPORT_EXTENSIONS] },
      { name: '文本', extensions: ['txt', 'md', 'log'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'EPUB', extensions: ['epub'] },
      { name: '音频', extensions: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'] },
    ],
  })
  if (!selected) return []
  return Array.isArray(selected) ? selected : [selected]
}

/** Whether we're running inside Tauri, or in a plain browser (dev preview). */
export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Payload of a native drag-and-drop event from the webview. */
export interface DragDropEvent {
  type: 'enter' | 'over' | 'leave' | 'drop'
  /** Absolute paths of the dropped files; empty for non-drop events. */
  paths: string[]
}

/**
 * Subscribe to the webview's native drag-and-drop events.
 *
 * Tauri intercepts native file drops before they become DOM drag events, so a
 * plain `@drop` handler never fires in the packaged app. This is the supported
 * path. It lives here rather than in a component so that Tauri stays confined
 * to this module — that confinement is what makes an Android port a one-file
 * change.
 *
 * Returns an unsubscribe function; a no-op when not running under Tauri.
 */
export async function onFileDrop(
  handler: (event: DragDropEvent) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => {}
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    return await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload
      if (payload.type === 'drop') {
        handler({ type: 'drop', paths: payload.paths })
      } else if (payload.type === 'enter') {
        handler({ type: 'enter', paths: [] })
      } else if (payload.type === 'leave') {
        handler({ type: 'leave', paths: [] })
      }
    })
  } catch {
    // Without the shell there is no webview drag API; the DOM path covers it.
    return () => {}
  }
}
