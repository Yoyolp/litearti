/**
 * Export state: which target is chosen, and what happened last time.
 *
 * Selection itself is not here. It used to be, which meant the export feature
 * owned the library's "I am choosing rows" mode — and once batch deletion wanted
 * the same mode, that ownership was clearly wrong. See `stores/selection.ts`.
 *
 * What remains is genuinely export-specific: the target format, the conversion
 * run, and its outcome.
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Entry } from '@/types/viewer'
import { registerBuiltinTargets } from '@/export/builtins'
import { pickExportDirectory } from '@/export/pickDirectory'
import { runExport, type ExportSkip } from '@/export/pipeline'
import { allTargets, targetSupports, type ConvertTarget } from '@/export/registry'
import { useSelectionStore } from '@/stores/selection'

export interface ExportResult {
  written: number
  skipped: ExportSkip[]
}

export const useExportStore = defineStore('export', () => {
  const selection = useSelectionStore()

  /** Chosen target id; null until a menu item is picked. */
  const targetId = ref<string | null>(null)
  const running = ref(false)
  /** Progress during conversion: [done, total]. */
  const progress = ref<[number, number] | null>(null)
  const result = ref<ExportResult | null>(null)
  const error = ref<string | null>(null)

  registerBuiltinTargets()

  const targets = computed(() => allTargets())

  const target = computed<ConvertTarget | null>(
    () => targets.value.find((t) => t.id === targetId.value) ?? null,
  )

  /**
   * Whether a target can take this entry.
   *
   * The menu uses this to grey out formats that make no sense for a selection —
   * a person should learn "audio has no text" before clicking, not from a
   * failure afterwards.
   */
  function supports(entry: Entry): boolean {
    const current = target.value
    if (!current) return false
    return targetSupports(current, entry.extension)
  }

  /**
   * Enter selection mode for a target.
   *
   * The eligibility predicate is close over the target, so the checkboxes in the
   * list can grey out ineligible rows without the selection store knowing what an
   * export target is.
   */
  function begin(nextTargetId: string): void {
    targetId.value = nextTargetId
    result.value = null
    error.value = null
    selection.begin('export', (entry) => {
      const current = targets.value.find((t) => t.id === nextTargetId) ?? null
      return current ? targetSupports(current, entry.extension) : false
    })
  }

  function cancel(): void {
    selection.cancel()
    targetId.value = null
    progress.value = null
  }

  /** Entries in the current selection that the target can actually handle. */
  function eligible(entries: readonly Entry[]): Entry[] {
    return entries.filter((entry) => supports(entry))
  }

  /** Skipped-because-unsupported entries, for an honest pre-flight count. */
  function ineligible(entries: readonly Entry[]): Entry[] {
    return entries.filter((entry) => !supports(entry))
  }

  /**
   * Run the export: pick a directory, convert, write.
   *
   * Returns false when the person cancelled the folder picker, so the caller
   * can keep the selection mode open instead of closing it on a non-event.
   */
  async function run(entries: readonly Entry[]): Promise<boolean> {
    const current = target.value
    if (!current) return false

    const chosen = selection.pick(entries)
    if (!chosen.length) return false

    const usable = eligible(chosen)
    const unusable = ineligible(chosen)
    if (!usable.length) {
      error.value = '所选条目都不支持这个格式'
      return false
    }

    error.value = null
    running.value = true
    // No progress yet: the next thing that happens is a native folder dialog,
    // and "正在转换 0 / 3" while that dialog is open would claim work that has
    // not started. Progress begins only once a directory is chosen.
    progress.value = null

    try {
      const directory = await pickExportDirectory()
      if (!directory) {
        // Cancelling the picker is not a failure; leave the mode as it was.
        return false
      }

      progress.value = [0, usable.length]
      const outcome = await runExport(usable, current, directory, (done, total) => {
        progress.value = [done, total]
      })

      result.value = {
        written: outcome.written,
        skipped: [
          // Entries the target cannot handle are reported alongside conversion
          // failures, so the count in the message always adds up.
          ...unusable.map((entry) => ({
            entry,
            reason: current.unsupportedReason ?? '这个格式不支持转换',
          })),
          ...outcome.skipped,
        ],
      }

      selection.cancel()
      targetId.value = null
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return false
    } finally {
      running.value = false
      progress.value = null
    }
  }

  function dismissResult(): void {
    result.value = null
  }

  function clearError(): void {
    error.value = null
  }

  return {
    targetId,
    target,
    targets,
    running,
    progress,
    result,
    error,
    supports,
    begin,
    cancel,
    eligible,
    ineligible,
    run,
    dismissResult,
    clearError,
  }
})
