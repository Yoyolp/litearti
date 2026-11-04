/**
 * Choosing an export destination.
 *
 * Kept out of the pipeline so the pipeline stays testable without a dialog, and
 * out of the component so `@tauri-apps/plugin-dialog` stays confined to the
 * places that already use it.
 */

import { open as openDialog } from '@tauri-apps/plugin-dialog'

/**
 * Show the native folder picker.
 *
 * Returns `null` when the person cancels — cancellation is a normal outcome and
 * must not surface as an error.
 */
export async function pickExportDirectory(): Promise<string | null> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: '选择导出位置',
  })
  if (!selected) return null
  return Array.isArray(selected) ? (selected[0] ?? null) : selected
}
