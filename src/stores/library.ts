/**
 * The library store: the single source of truth for entries and selection.
 *
 * Views read from here and never cache entries themselves, so a rename,
 * removal, or progress write in one place is immediately consistent
 * everywhere.
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '@/api/library'
import type { Entry } from '@/types/viewer'

/**
 * Turn whatever the picker threw into a sentence a person can act on.
 *
 * The two failures worth naming are a missing permission (a packaging mistake)
 * and a missing platform portal (a Linux-only concern); anything else is passed
 * through with its original text so it stays diagnosable.
 */
function describePickerError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (/not allowed|denied|permission/i.test(raw)) {
    return `无法打开文件选择器：缺少权限。${raw}`
  }
  if (/portal|xdg|dbus/i.test(raw)) {
    return `无法打开文件选择器：系统缺少文件对话框支持。${raw}`
  }
  return `无法打开文件选择器：${raw}`
}

export const useLibraryStore = defineStore('library', () => {
  const entries = ref<Entry[]>([])
  const loading = ref(false)
  const importing = ref(false)
  const error = ref<string | null>(null)
  /** Paths from the last import that failed, for the failure detail popover. */
  const lastFailures = ref<{ sourcePath: string; reason: string }[]>([])

  // Ordering lives in `src/library/query.ts`, not here. The store holds the
  // entries as the backend returned them; every view derives its own order via
  // `applyQuery`. Keeping a second, fixed order in the store would mean two
  // answers to "what order is the library in".

  function byId(id: string): Entry | undefined {
    return entries.value.find((e) => e.id === id)
  }

  function replace(entry: Entry): void {
    const index = entries.value.findIndex((e) => e.id === entry.id)
    if (index >= 0) entries.value[index] = entry
  }

  /**
   * Insert an entry the backend just created, or update it if it is already here.
   *
   * Needed because `add_online` writes to disk in the Rust side, and this store only
   * reads the whole list once at startup. Without this, a title added from a source
   * detail page exists in `library.json` but not in the running app — the library
   * looks empty until a restart, which reads as data loss.
   *
   * Insert-or-replace rather than plain push: `add_online` is idempotent on
   * `(sourceId, detailUrl)` and returns the existing entry on a repeat, so a second
   * click must not produce two rows.
   */
  function upsert(entry: Entry): void {
    const index = entries.value.findIndex((e) => e.id === entry.id)
    if (index >= 0) entries.value[index] = entry
    else entries.value = [entry, ...entries.value]
  }

  /**
   * Mark in-memory entries that reference `sourceId` as invalid.
   *
   * The backend does the same write; this keeps the running app in step with it.
   * Called from the sources store after deleting or disabling a source, rather than
   * having that store reach into this one — the dependency runs one way (sources →
   * library is a call, library → sources is not a dependency), which keeps either
   * module loadable on its own.
   */
  function markSourceInvalid(sourceId: string): void {
    for (const entry of entries.value) {
      if (entry.kind !== 'online') continue
      if (entry.reference?.sourceId === sourceId) entry.reference.invalid = true
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      entries.value = await api.listEntries()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  async function importFromPaths(paths: string[]): Promise<api.ImportReport | null> {
    if (!paths.length) return null
    importing.value = true
    error.value = null
    try {
      const report = await api.importPaths(paths)
      entries.value = [...entries.value, ...report.imported]
      lastFailures.value = report.failed
      return report
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    } finally {
      importing.value = false
    }
  }

  async function pickAndImport(): Promise<api.ImportReport | null> {
    error.value = null
    let paths: string[]
    try {
      paths = await api.pickFiles()
    } catch (cause) {
      // Opening the picker can fail on its own (permission denied, no portal
      // on Linux). Swallowing that would make the button look dead, so it is
      // reported like any other import failure.
      error.value = describePickerError(cause)
      return null
    }
    return importFromPaths(paths)
  }

  async function remove(id: string): Promise<void> {
    try {
      await api.removeEntry(id)
      entries.value = entries.value.filter((e) => e.id !== id)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  /** Result of the last batch removal, for the feedback strip. */
  const lastRemoval = ref<{ removed: number; failed: number } | null>(null)

  /**
   * Remove several entries in one call.
   *
   * Unlike `remove`, this reports partial failure instead of a throwing error:
   * a batch where two of ten ids were stale should still delete the other eight
   * and say so, rather than leaving the person to wonder what happened.
   */
  async function removeMany(ids: string[]): Promise<void> {
    if (!ids.length) return
    try {
      const report = await api.removeEntries(ids)
      const gone = new Set(ids)
      // Only drop the ids the backend confirms it removed, minus the failures.
      const failedIds = new Set(report.failed.map((failure) => failure.id))
      entries.value = entries.value.filter((e) => !gone.has(e.id) || failedIds.has(e.id))
      lastRemoval.value = { removed: report.removed, failed: report.failed.length }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  /**
   * Set or clear the display name.
   *
   * A rename is display-only, so a failure here is reported but leaves the entry
   * as it was; it is never worth blocking the list over.
   */
  async function rename(id: string, name: string | null): Promise<void> {
    try {
      replace(await api.renameEntry(id, name))
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function markOpened(id: string): Promise<void> {
    try {
      replace(await api.touchEntry(id))
    } catch {
      // Failing to record "opened" must never block opening the file.
    }
  }

  async function saveProgress(id: string, progress: unknown): Promise<void> {
    try {
      replace(await api.setProgress(id, progress))
    } catch {
      // Progress is best-effort by design; losing it is not worth an error.
    }
  }

  function clearError(): void {
    error.value = null
  }

  function clearRemoval(): void {
    lastRemoval.value = null
  }

  return {
    entries,
    loading,
    importing,
    error,
    lastFailures,
    lastRemoval,
    byId,
    replace,
    upsert,
    markSourceInvalid,
    load,
    importFromPaths,
    pickAndImport,
    remove,
    removeMany,
    rename,
    markOpened,
    saveProgress,
    clearError,
    clearRemoval,
  }
})