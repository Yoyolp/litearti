<script setup lang="ts">
/**
 * The `...` menu in the library header.
 *
 * Two levels on purpose: the top level is a small, stable set of actions
 * ("export" today, more later), and the second level is the list of export
 * formats. That keeps the header from growing a button per format, and means a
 * newly registered target appears without touching this component.
 *
 * The menu closes on outside click and on Esc. Esc is handled with
 * `preventDefault` so it does not also leave the reader — the shell's Esc
 * handler checks `defaultPrevented`.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useExportStore } from '@/stores/export'
import { t } from '@/i18n'
import type { Entry } from '@/types/viewer'

const props = defineProps<{
  /** Entries the action would apply to (the current, possibly filtered list). */
  entries: readonly Entry[]
}>()

const store = useExportStore()
const open = ref(false)
const exportOpen = ref(false)
const root = ref<HTMLElement | null>(null)

/**
 * Targets worth showing.
 *
 * A target that no entry in the library can use is hidden entirely rather than
 * shown greyed: an option that is never applicable is noise. A target that
 * some entries can use is shown, and per-entry eligibility is decided later.
 */
const available = computed(() =>
  store.targets.filter((target) =>
    props.entries.some((entry) =>
      target.supports === 'all' ? true : target.supports.includes(entry.extension),
    ),
  ),
)

/** How many of the current entries each target could handle. */
function usableCount(targetId: string): number {
  const target = store.targets.find((t) => t.id === targetId)
  if (!target) return 0
  return props.entries.filter((entry) =>
    target.supports === 'all' ? true : target.supports.includes(entry.extension),
  ).length
}

function toggleMenu(): void {
  open.value = !open.value
  if (!open.value) exportOpen.value = false
}

function startExport(targetId: string): void {
  store.begin(targetId)
  open.value = false
  exportOpen.value = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return
  const element = root.value
  if (element && !element.contains(event.target as Node)) {
    open.value = false
    exportOpen.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return
  // Claim Esc so the shell's reader-exit handler does not also fire.
  event.preventDefault()
  open.value = false
  exportOpen.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="root" class="menu-root">
    <button
      class="btn btn--tertiary menu-trigger"
      type="button"
      :aria-expanded="open"
      aria-haspopup="menu"
      :aria-label="t('export.menu')"
      @click="toggleMenu"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="3" cy="8" r="1.3" fill="currentColor" />
        <circle cx="8" cy="8" r="1.3" fill="currentColor" />
        <circle cx="13" cy="8" r="1.3" fill="currentColor" />
      </svg>
    </button>

    <ul v-if="open" class="menu" role="menu">
      <li>
        <button
          class="menu-item"
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          :aria-expanded="exportOpen"
          @click="exportOpen = !exportOpen"
        >
          <span>{{ t('export.action') }}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" class="chevron">
            <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </button>

        <ul v-if="exportOpen" class="submenu" role="menu">
          <li v-for="target in available" :key="target.id">
            <button
              class="menu-item"
              type="button"
              role="menuitem"
              :disabled="usableCount(target.id) === 0"
              @click="startExport(target.id)"
            >
              <span>{{ target.label }}</span>
              <!-- Show the count so the greyed-out case is explainable before
                   the click, not after a failure. -->
              <span class="menu-count">{{ usableCount(target.id) }}</span>
            </button>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.menu-root {
  position: relative;
  flex: none;
}

.menu-trigger {
  width: var(--control-md);
  height: var(--control-md);
  padding: 0;
  border-radius: var(--radius-md);
}

.menu {
  position: absolute;
  top: calc(100% + var(--space-1));
  right: 0;
  z-index: 20;
  min-width: var(--menu-min-width);
  margin: 0;
  padding: var(--space-1);
  list-style: none;
  background: var(--surface-raised);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-e2);
}

.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.menu-item:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--ink-primary);
}

.menu-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.chevron {
  flex: none;
  color: var(--ink-tertiary);
}

/* The submenu sits beside its parent item, not below the whole menu: it is a
   refinement of one action, and nesting it downward would suggest a third
   level exists. */
.submenu {
  margin: var(--space-1) 0 0;
  padding: var(--space-1) 0 0;
  list-style: none;
  border-top: 1px solid var(--line-subtle);
}

.menu-count {
  flex: none;
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}
</style>
