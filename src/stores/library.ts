/**
 * The library store: the single source of truth for entries and selection.
 *
 * Views read from here and never cache entries themselves, so a rename,
 * removal, or progress write in one place is immediately consistent
 * everywhere.
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
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

  const sorted = computed(() =>
    [...entries.value].sort((a, b) => {
      // Order by "last activity": opening a file or importing it both count.
      // Sorting by opened-only would push a freshly imported file below
      // everything else, which is the opposite of what a person expects right
      // after they import it.
      const aTime = Math.max(a.lastOpenedAt ?? 0, a.addedAt)
      const bTime = Math.max(b.lastOpenedAt ?? 0, b.addedAt)
      return bTime - aTime
    }),
  )


  function byId(id: string): Entry | undefined {
    return entries.value.find((e) => e.id === id)
  }

  function replace(entry: Entry): void {
    const index = entries.value.findIndex((e) => e.id === entry.id)
    if (index >= 0) entries.value[index] = entry
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

  return {
    entries,
    sorted,
    loading,
    importing,
    error,
    lastFailures,
    byId,
    load,
    importFromPaths,
    pickAndImport,
    remove,
    markOpened,
    saveProgress,
    clearError,
  }
})