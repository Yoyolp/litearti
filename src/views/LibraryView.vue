<script setup lang="ts">
/**
 * The library screen.
 *
 * This is the app's home, not a dashboard. It has one job: get you into a
 * file. So the layout is a single column of entries with a generous top area
 * reserved for the title and the import action — no cards, no grid, no stats.
 *
 * Hierarchy here:
 *   - primary action: import (only when the library is empty, it's the hero;
 *     otherwise it's a quiet solid button in the header)
 *   - secondary: opening an entry (the whole row is the target)
 *   - tertiary: removing an entry (hidden until row hover)
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { useExportStore } from '@/stores/export'
import { t } from '@/i18n'
import { extensionLabel, formatDuration, formatRelative, formatSize } from '@/utils/format'
import { onFileDrop } from '@/api/library'
import type { Entry } from '@/types/viewer'
import EmptyLibrary from '@/components/EmptyLibrary.vue'
import ImportFeedback from '@/components/ImportFeedback.vue'
import ExportMenu from '@/components/ExportMenu.vue'
import ExportFeedback from '@/components/ExportFeedback.vue'

const emit = defineEmits<{ open: [entry: Entry] }>()

const store = useLibraryStore()
const exporter = useExportStore()
const query = ref('')
const dragging = ref(false)
const confirmRemove = ref<Entry | null>(null)
const dragDepth = ref(0)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return store.sorted
  return store.sorted.filter((entry) => entry.title.toLowerCase().includes(q))
})

const isEmpty = computed(() => !store.loading && store.entries.length === 0)
const searching = computed(() => query.value.trim().length > 0)

/** Entries the export action applies to: the visible list, search included. */
const exportable = computed(() => filtered.value)

function onSelectToggle(entry: Entry): void {
  exporter.toggle(entry.id)
}

async function runExport(): Promise<void> {
  await exporter.run(exportable.value)
}

/** Esc leaves selection mode without touching the shell's reader-exit path. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !exporter.selecting) return
  if (event.defaultPrevented) return
  event.preventDefault()
  exporter.cancel()
}

async function handleImport(): Promise<void> {
  const report = await store.pickAndImport()
  if (report && report.imported.length === 1) {
    // Importing a single file is almost always "I want to read this now".
    const only = report.imported[0]
    if (only) emit('open', only)
  }
}

function onDragEnter(event: DragEvent): void {
  event.preventDefault()
  dragDepth.value += 1
  if (event.dataTransfer?.types.includes('Files')) dragging.value = true
}

function onDragLeave(event: DragEvent): void {
  event.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) dragging.value = false
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
}

async function onDrop(event: DragEvent): Promise<void> {
  event.preventDefault()
  dragDepth.value = 0
  dragging.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (!files.length) return
  // Browser fallback only. Tauri intercepts native drops (see the drag-drop
  // listener below), so this path runs in `pnpm dev` without the shell.
  const paths = files
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
  if (!paths.length) return
  await store.importFromPaths(paths)
}

async function confirmRemoval(): Promise<void> {
  const target = confirmRemove.value
  if (!target) return
  await store.remove(target.id)
  confirmRemove.value = null
}

/** Progress shown inline on a row, so resuming is discoverable at a glance. */
function progressLabel(entry: Entry): string | null {
  const progress = entry.progress
  if (!progress || typeof progress !== 'object') return null
  const raw = progress as {
    version?: number
    ratio?: number
    page?: number
    time?: number
    chapter?: number
  }

  // EPUB reports a chapter index. Checked before `ratio` because an EPUB
  // payload may also carry the within-chapter ratio, and the chapter number
  // is the more useful hint of "how far into the book" you are.
  if (typeof raw.chapter === 'number' && raw.chapter > 0) {
    return `第 ${raw.chapter + 1} 章`
  }
  if (typeof raw.ratio === 'number') {
    const percent = Math.round(raw.ratio * 100)
    return percent >= 1 ? t('entry.progress', { percent }) : null
  }
  if (typeof raw.page === 'number' && raw.page > 1) {
    return `第 ${raw.page} 页`
  }
  if (typeof raw.time === 'number' && raw.time >= 5) {
    // Audio has no total duration stored, so report elapsed time rather than a
    // fake percentage.
    return `听到 ${formatDuration(raw.time)}`
  }
  return null
}

/**
 * Native drag-and-drop, subscribed through the API module.
 *
 * Tauri intercepts file drops before they become DOM events, so `@drop` alone
 * never fires in the packaged app. The subscription itself lives in
 * `api/library.ts` to keep Tauri imports confined to that one file; the DOM
 * handlers above remain for plain-browser development.
 */
let unlistenDrag: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  unlistenDrag = await onFileDrop((event) => {
    if (event.type === 'enter') {
      dragging.value = true
    } else if (event.type === 'leave') {
      dragging.value = false
    } else if (event.type === 'drop') {
      dragging.value = false
      if (event.paths.length) void store.importFromPaths(event.paths)
    }
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unlistenDrag?.()
  unlistenDrag = null
  // Leaving the screen must not strand the export mode: the selection belongs
  // to this view and would otherwise come back half-finished.
  if (exporter.selecting) exporter.cancel()
})
</script>

<template>
  <div
    class="library"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <header class="library-header">
      <div class="heading">
        <h1 class="title">{{ t('library.title') }}</h1>
        <p v-if="!isEmpty" class="count">{{ t('library.count', { count: store.entries.length }) }}</p>
      </div>

      <div v-if="!isEmpty && !exporter.selecting" class="header-actions">
        <label class="search">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="search-icon">
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.4" />
          </svg>
          <input
            v-model="query"
            class="search-input"
            type="search"
            :placeholder="t('library.search')"
            :aria-label="t('library.search')"
          />
        </label>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="store.importing"
          @click="handleImport"
        >
          {{ store.importing ? t('library.importing') : t('library.import') }}
        </button>
        <ExportMenu :entries="exportable" />
      </div>

      <!-- Selection mode replaces the header actions rather than adding to
           them: during a selection, importing or searching would be a
           distraction from the one thing in progress. -->
      <div v-else-if="exporter.selecting" class="selection-actions">
        <p class="selection-count">
          {{ t('export.selected', { count: exporter.count, total: exportable.length }) }}
        </p>
        <button class="btn btn--tertiary" type="button" @click="exporter.selectAll(exportable)">
          {{ t('export.selectAll') }}
        </button>
        <button
          class="btn btn--tertiary"
          type="button"
          :disabled="!exporter.count"
          @click="exporter.clearSelection()"
        >
          {{ t('export.clearSelection') }}
        </button>
        <button class="btn btn--tertiary" type="button" @click="exporter.cancel()">
          {{ t('export.cancel') }}
        </button>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="!exporter.count || exporter.running"
          @click="runExport"
        >
          {{
            exporter.progress
              ? t('export.converting', {
                  done: exporter.progress[0] ?? 0,
                  total: exporter.progress[1] ?? 0,
                })
              : exporter.running
                ? t('export.running')
                : t('export.run')
          }}
        </button>
      </div>
    </header>

    <ImportFeedback />
    <ExportFeedback />

    <!-- Errors are shown, never swallowed. A silent failure reads as a dead
         button, which is the worst possible feedback. -->
    <div v-if="store.error" class="error-wrap">
      <div class="error-strip">
        <p class="error-text">{{ store.error }}</p>
        <button
          class="btn btn--tertiary error-dismiss"
          type="button"
          :aria-label="t('common.close')"
          @click="store.clearError()"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="store.loading" class="loading">{{ t('common.loading') }}</div>

    <EmptyLibrary v-else-if="isEmpty" :importing="store.importing" @import="handleImport" />

    <div v-else-if="searching && !filtered.length" class="no-results">
      <p class="no-results-title">{{ t('library.searchEmpty', { query: query.trim() }) }}</p>
      <button class="btn btn--tertiary" type="button" @click="query = ''">
        {{ t('library.clearSearch') }}
      </button>
    </div>

    <ul v-else class="entries">
      <li
        v-for="entry in filtered"
        :key="entry.id"
        class="entry"
        :class="{
          'is-selecting': exporter.selecting,
          'is-selected': exporter.isSelected(entry.id),
          'is-ineligible': exporter.selecting && !exporter.supports(entry),
        }"
      >
        <!-- Selection is a checkbox, not a row click: opening a file and
             choosing a file are different intentions and must not share a
             target. -->
        <label v-if="exporter.selecting" class="entry-check">
          <input
            type="checkbox"
            :checked="exporter.isSelected(entry.id)"
            :disabled="!exporter.supports(entry)"
            :aria-label="entry.title"
            @change="onSelectToggle(entry)"
          />
        </label>

        <button class="entry-open" type="button" @click="emit('open', entry)">
          <span class="entry-ext">{{ extensionLabel(entry.extension) }}</span>

          <span class="entry-main">
            <span class="entry-title">{{ entry.title }}</span>
            <span class="entry-meta">
              <span>{{ formatSize(entry.size) }}</span>
              <span class="dot" aria-hidden="true">·</span>
              <span v-if="entry.lastOpenedAt">{{ formatRelative(entry.lastOpenedAt) }}</span>
              <span v-else>{{ formatRelative(entry.addedAt) }}</span>
              <template v-if="progressLabel(entry)">
                <span class="dot" aria-hidden="true">·</span>
                <span class="entry-progress">{{ progressLabel(entry) }}</span>
              </template>
            </span>
          </span>
        </button>

        <!-- Removal hides during selection: a misclick there would delete a
             file the person was about to export. -->
        <button
          v-if="!exporter.selecting"
          class="entry-remove btn btn--danger"
          type="button"
          :aria-label="t('entry.remove')"
          @click="confirmRemove = entry"
        >
          {{ t('entry.remove') }}
        </button>
      </li>
    </ul>

    <!-- Drag overlay: appears only while a file is over the window. -->
    <div v-if="dragging" class="drop-overlay">
      <div class="drop-card">
        <p class="drop-title">{{ t('library.drag.title') }}</p>
        <p class="drop-body">{{ t('library.drag.body') }}</p>
      </div>
    </div>

    <!-- Removal confirmation: a small inline modal, not a scary dialog. -->
    <div v-if="confirmRemove" class="confirm-backdrop" @click.self="confirmRemove = null">
      <div class="confirm" role="dialog" aria-modal="true">
        <h2 class="confirm-title">{{ t('entry.removeConfirm', { title: confirmRemove.title }) }}</h2>
        <p class="confirm-body">{{ t('entry.removeConfirmBody') }}</p>
        <div class="confirm-actions">
          <button class="btn btn--tertiary" type="button" @click="confirmRemove = null">
            {{ t('entry.removeCancel') }}
          </button>
          <button class="btn btn--secondary" type="button" @click="confirmRemoval">
            {{ t('entry.removeAction') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.library {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.library-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-5);
  /* Generous top space is the point: the title should breathe. */
  padding: var(--space-7) var(--content-pad) var(--space-4);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
}

.title {
  font-size: var(--text-2xl);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
  letter-spacing: -0.01em;
}

.count {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* Selection toolbar: same height as the actions it replaces, so the header does
   not jump when the mode toggles. */
.selection-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.selection-count {
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  font-variant-numeric: tabular-nums;
}

.entry-check {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--ext-column);
  align-self: stretch;
  cursor: pointer;
}

.entry-check input {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--surface-ink);
}

.entry-check input:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

/* A selected row reads as chosen without becoming a colored band: the
   design system carries state with surface contrast, not hue. */
.entry.is-selected {
  background: var(--surface-active);
}

/* Formats the target cannot handle stay visible but visibly inert, so the
   reason for the skip is evident before the export runs. */
.entry.is-ineligible .entry-main {
  opacity: 0.45;
}

.entry.is-selecting .entry-open {
  cursor: default;
}

.search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-md);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  color: var(--ink-tertiary);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.search:hover {
  background: var(--surface-hover);
}

.search:focus-within {
  background: var(--surface-raised);
  box-shadow: var(--shadow-e1);
  color: var(--ink-secondary);
}

.search-icon {
  flex: none;
}

.search-input {
  width: var(--search-width);
  border: none;
  background: none;
  font-size: var(--text-sm);
  color: var(--ink-primary);
}

.search-input::placeholder {
  color: var(--ink-tertiary);
}

.search-input:focus-visible {
  box-shadow: none;
}

/* Entries: a plain list. The row is the hit target; metadata is quiet. */
.entries {
  list-style: none;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-9);
  max-width: var(--shell-max);
  width: 100%;
  display: flex;
  flex-direction: column;
}

.entry {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: var(--radius-md);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.entry:hover {
  background: var(--surface-hover);
}

.entry + .entry::before {
  content: '';
  position: absolute;
  top: 0;
  left: var(--space-4);
  right: var(--space-4);
  height: var(--hairline);
  background: var(--line-subtle);
}

.entry:hover::before,
.entry:hover + .entry::before {
  background: transparent;
}

.entry-open {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex: 1;
  min-width: 0;
  padding: var(--space-4);
  text-align: left;
}

/* The extension is a fixed-width type marker, not a colorful badge. */
.entry-ext {
  flex: none;
  width: var(--ext-column);
  font-size: var(--text-xs);
  font-weight: var(--weight-strong);
  color: var(--ink-tertiary);
  letter-spacing: 0.04em;
}

.entry-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.entry-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  /* Long titles truncate rather than wrap, keeping rows a constant height. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.dot {
  color: var(--line-strong);
}

.entry-progress {
  color: var(--ink-secondary);
}

/* Removal is invisible until intent: hover on the row, or keyboard focus. */
.entry-remove {
  flex: none;
  margin-right: var(--space-3);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}

.entry:hover .entry-remove,
.entry-remove:focus-visible {
  opacity: 1;
}

.loading,
.no-results {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-9) var(--space-5);
  color: var(--ink-tertiary);
  font-size: var(--text-sm);
}

.no-results-title {
  color: var(--ink-secondary);
}

/* --- Error strip -------------------------------------------------------- */

/* The strip shares the header/list inset so it lines up with them. */
.error-wrap {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
}

.error-strip {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--tone-danger-surface);
}

.error-text {
  flex: 1;
  font-size: var(--text-sm);
  line-height: var(--leading-snug);
  color: var(--tone-danger);
  /* Errors often carry a raw system message; let it wrap instead of clipping. */
  word-break: break-word;
}

.error-dismiss {
  flex: none;
  color: var(--tone-danger);
  opacity: 0.6;
}

.error-dismiss:hover {
  opacity: 1;
  background: transparent;
  color: var(--tone-danger);
}

/* --- Drag overlay ------------------------------------------------------- */

.drop-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--surface-page) 78%, transparent);
  backdrop-filter: blur(2px);
  z-index: 20;
  pointer-events: none;
}

.drop-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-7) var(--space-8);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  box-shadow: var(--shadow-e3);
  text-align: center;
}

.drop-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
}

.drop-body {
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

/* --- Confirm ------------------------------------------------------------ */

.confirm-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.24);
  z-index: 30;
}

.confirm {
  width: min(400px, calc(100vw - var(--space-7)));
  padding: var(--space-5);
  background: var(--surface-raised);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-e3);
}

.confirm-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  line-height: var(--leading-snug);
}

.confirm-body {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  line-height: var(--leading-normal);
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-5);
}
</style>
