/**
 * Selection mode: which entries are chosen, and whether the list is in that mode.
 *
 * This used to live inside `stores/export.ts`, which was wrong in a way that only
 * showed up once a second feature needed it: selection is not an export concern,
 * it is a list concern. Export picks a target and writes files; deleting makes
 * files go away. Both start by choosing rows.
 *
 * So selection is its own thing, and each action supplies a predicate for what it
 * can accept. Export passes "targets that can convert this format", which is why
 * a checkbox goes grey for audio when the target is text. Delete passes nothing,
 * because everything is deletable.
 *
 * The mode is transient by design: it belongs to the screen you are on, and
 * leaving the screen drops it (the view calls `cancel` on unmount).
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Entry } from '@/types/viewer'

/** What the selection is being gathered for. */
export type SelectionPurpose = 'export' | 'delete'

export const useSelectionStore = defineStore('selection', () => {
  const active = ref(false)
  const purpose = ref<SelectionPurpose | null>(null)
  const selected = ref<Set<string>>(new Set())

  /**
   * Whether an entry may be chosen right now.
   *
   * A plain function rather than a stored descriptor so the caller can close over
   * whatever it needs (the export target, for instance) without this store
   * learning about it.
   */
  const accepts = ref<(entry: Entry) => boolean>(() => true)

  const count = computed(() => selected.value.size)

  function isSelected(id: string): boolean {
    return selected.value.has(id)
  }

  function allows(entry: Entry): boolean {
    return accepts.value(entry)
  }

  /** Enter selection mode. Re-entering resets, so a switch cannot inherit ids. */
  function begin(next: SelectionPurpose, acceptsEntry?: (entry: Entry) => boolean): void {
    active.value = true
    purpose.value = next
    selected.value = new Set()
    accepts.value = acceptsEntry ?? (() => true)
  }

  function cancel(): void {
    active.value = false
    purpose.value = null
    selected.value = new Set()
    accepts.value = () => true
  }

  function toggle(id: string): void {
    // Replace the Set so Vue's reactivity sees the change; mutating in place
    // would not notify the template.
    const next = new Set(selected.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selected.value = next
  }

  /** Select every entry the current purpose accepts. */
  function selectAll(entries: readonly Entry[]): void {
    selected.value = new Set(entries.filter(allows).map((e) => e.id))
  }

  function clear(): void {
    selected.value = new Set()
  }

  /** The selected entries, in the order given. */
  function pick(entries: readonly Entry[]): Entry[] {
    return entries.filter((entry) => selected.value.has(entry.id))
  }

  return {
    active,
    purpose,
    selected,
    count,
    isSelected,
    allows,
    begin,
    cancel,
    toggle,
    selectAll,
    clear,
    pick,
  }
})
