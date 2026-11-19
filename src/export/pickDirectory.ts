/**
 * Choosing an export destination.
 *
 * Kept out of the pipeline so the pipeline stays testable without a dialog, and
 * out of the component so `@tauri-apps/plugin-dialog` stays confined to the
 * places that already use it.
 */

import { open as openDialog } from '@tauri-apps/plugin-dialog'

/**
 * Is this the Android build?
 *
 * Read from the user agent rather than a backend call: Android System WebView
 * always reports `Android` there, and adding a command just to learn the
 * platform would mean a round trip on a path that already has a native dialog
 * to wait for.
 */
export function isAndroid(): boolean {
  return /\bAndroid\b/i.test(navigator.userAgent)
}

/**
 * Folder picking has no Android equivalent.
 *
 * Android has no "pick a writable directory" gesture — scoped storage means an
 * app only ever gets per-file grants (`ACTION_CREATE_DOCUMENT`), and the dialog
 * plugin reports `Folder picker is not implemented on mobile`. Export writes
 * several files into one chosen directory, which that model cannot express, so
 * the honest answer is to say so before opening anything, in words the person
 * can act on, instead of surfacing the plugin's English error.
 */
export const ANDROID_EXPORT_UNSUPPORTED =
  '安卓上暂不支持批量导出到文件夹：系统只允许逐个文件选择保存位置。' +
  '可以在电脑上导出，或直接阅读。'

/**
 * Show the native folder picker.
 *
 * Returns `null` when the person cancels — cancellation is a normal outcome and
 * must not surface as an error.
 */
export async function pickExportDirectory(): Promise<string | null> {
  if (isAndroid()) {
    throw new Error(ANDROID_EXPORT_UNSUPPORTED)
  }

  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: '选择导出位置',
  })
  if (!selected) return null
  return Array.isArray(selected) ? (selected[0] ?? null) : selected
}
