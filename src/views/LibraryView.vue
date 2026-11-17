<script setup lang="ts">
/**
 * The library screen.
 *
 * This is the app's home. It has one job: get you into a file. Two layouts serve
 * that differently — a list for scanning titles, a grid for recognising things by
 * shape — and both are the same data through the same query model
 * (`src/library/query.ts`), so switching never changes what is shown, only how.
 *
 * Hierarchy here:
 *   - primary action: import (the hero when the library is empty, otherwise a
 *     quiet solid button in the header)
 *   - secondary: opening an entry (the whole row or card is the target)
 *   - tertiary: removing, renaming (quiet until hover, or until selection mode)
 *
 * Selection mode is shared with export via `stores/selection.ts` and is reused
 * here for batch deletion, because "pick some rows and act on them" is one
 * interaction, not two features.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { useExportStore } from '@/stores/export'
import { useSelectionStore } from '@/stores/selection'
import { t } from '@/i18n'
import { extensionLabel, formatRelative, formatSize } from '@/utils/format'
import { onFileDrop } from '@/api/library'
import {
  applyQuery,
  countsByStatus,
  DEFAULT_QUERY,
  displayTitle,
  distinctGroups,
  FORMAT_GROUPS,
  formatGroupOf,
  isDefaultQuery,
  ORIGIN_FILTERS,
  READ_STATUSES,
  readStatusOf,
  SORT_KEYS,
  type FormatGroup,
  type LibraryQuery,
  type OriginFilter,
  type ReadStatus,
  type SortKey,
} from '@/library/query'
import { readProgress } from '@/library/progress'
import { loadQuery, loadView, saveQuery, saveView, type LibraryView } from '@/library/viewPrefs'
import type { Entry } from '@/types/viewer'
import EmptyLibrary from '@/components/EmptyLibrary.vue'
import ImportFeedback from '@/components/ImportFeedback.vue'
import ExportMenu from '@/components/ExportMenu.vue'
import ExportFeedback from '@/components/ExportFeedback.vue'
import LibraryCard from '@/components/LibraryCard.vue'

const emit = defineEmits<{ open: [entry: Entry] }>()

const store = useLibraryStore()
const exporter = useExportStore()
const selection = useSelectionStore()

// --- Query state -----------------------------------------------------------

/**
 * One reactive query object.
 *
 * Kept as a single ref rather than a ref per field so `watch` can persist it with
 * one call and so `applyQuery` receives a value, not a pile of arguments. The
 * stored default is loaded once at setup; validation lives in `viewPrefs.ts`.
 */
const query = ref<LibraryQuery>(loadQuery())
const view = ref<LibraryView>(loadView())

const visible = computed(() => applyQuery(store.entries, query.value))

const isEmpty = computed(() => !store.loading && store.entries.length === 0)
const filtering = computed(() => !isDefaultQuery(query.value))
const searching = computed(() => query.value.text.trim().length > 0)

/** Counts for the filter menus, computed over everything (not the filtered set). */
const formatCounts = computed(() => {
  const counts = Object.fromEntries(FORMAT_GROUPS.map((g) => [g, 0])) as Record<
    FormatGroup,
    number
  >
  for (const entry of store.entries) counts[formatGroupOf(entry.extension)] += 1
  return counts
})
const statusCounts = computed(() => countsByStatus(store.entries))
const groups = computed(() => distinctGroups(store.entries))

/**
 * The narrow statistics strip.
 *
 * What is left of the old dashboard: four numbers, no charts, no "recent" list.
 * Format and status distributions were dropped because the list below already
 * answers those questions with a filter, and showing the same fact twice in two
 * shapes is how a UI starts disagreeing with itself.
 *
 * "This week" was dropped on purpose: for imported files it counted opens, and
 * counting opens is not counting reading — a number that looks meaningful and is
 * not is worse than no number.
 */
const stats = computed(() => {
  const entries = store.entries
  let reading = 0
  let finished = 0
  let bytes = 0
  for (const entry of entries) {
    const status = readStatusOf(entry)
    if (status === 'reading') reading += 1
    if (status === 'finished') finished += 1
    // Only real files take space. An online entry is a few hundred bytes of
    // metadata, and counting it as "local storage" would be a lie.
    if (entry.kind !== 'online') bytes += entry.size
  }
  return { total: entries.length, reading, finished, bytes }
})

/** The source name shown on an online row, falling back to a generic label. */
function sourceLabel(entry: Entry): string {
  return entry.reference?.sourceName || t('library.origin.online')
}

/** The meta shown for an online entry in the list view. */
function onlineMeta(entry: Entry): string {
  const count = entry.reference?.episodeCount
  return typeof count === 'number' && count > 0
    ? t('library.online.episodes', { count })
    : t('library.origin.online')
}

/**
 * Label tables.
 *
 * Static maps rather than template strings: `t()` takes a closed key union, so a
 * missing key is a compile error instead of a string that silently renders as the
 * key itself.
 */
const SORT_LABELS: Record<SortKey, string> = {
  recent: t('library.sort.recent'),
  added: t('library.sort.added'),
  title: t('library.sort.title'),
  size: t('library.sort.size'),
  progress: t('library.sort.progress'),
}
const FORMAT_LABELS: Record<FormatGroup, string> = {
  text: t('library.format.text'),
  pdf: t('library.format.pdf'),
  epub: t('library.format.epub'),
  audio: t('library.format.audio'),
  other: t('library.format.other'),
}
const STATUS_LABELS: Record<ReadStatus, string> = {
  unread: t('library.status.unread'),
  reading: t('library.status.reading'),
  finished: t('library.status.finished'),
}

/** Entries the header actions apply to: what is currently visible. */
const actionable = computed(() => visible.value)

// Preferences persist on change, not on every keystroke of the search box —
// writing localStorage per character is pointless churn.
watch([view], () => saveView(view.value))
watch(
  () => ({ ...query.value }),
  (value) => saveQuery(value),
)

function setSort(sort: SortKey): void {
  // Re-picking the active key flips the direction, which is the behaviour every
  // file manager has and the one people try first.
  if (query.value.sort === sort) {
    query.value = { ...query.value, direction: query.value.direction === 'asc' ? 'desc' : 'asc' }
    return
  }
  query.value = { ...query.value, sort, direction: sort === 'title' ? 'asc' : 'desc' }
}

function setFormat(format: FormatGroup | null): void {
  query.value = { ...query.value, format: query.value.format === format ? null : format }
}

function setStatus(status: ReadStatus | null): void {
  query.value = { ...query.value, status: query.value.status === status ? null : status }
}

function setGroup(group: string | null): void {
  query.value = { ...query.value, group: query.value.group === group ? null : group }
}

const ORIGIN_LABELS: Record<OriginFilter, string> = {
  file: t('library.origin.file'),
  online: t('library.origin.online'),
}

/** How many entries of each kind exist, so the filter can show counts. */
const originCounts = computed(() => {
  let file = 0
  let online = 0
  for (const entry of store.entries) {
    if (entry.kind === 'online') online += 1
    else file += 1
  }
  return { file, online }
})

function setOrigin(origin: OriginFilter | null): void {
  query.value = { ...query.value, origin: query.value.origin === origin ? null : origin }
}

function clearFilters(): void {
  query.value = { ...DEFAULT_QUERY, sort: query.value.sort, direction: query.value.direction }
}

// --- Selection -------------------------------------------------------------

const selecting = computed(() => selection.active)

function toggleSelected(entry: Entry): void {
  selection.toggle(entry.id)
}

function startDeleteSelection(): void {
  // Everything is deletable, so no eligibility predicate.
  selection.begin('delete')
}

async function confirmBatchDelete(): Promise<void> {
  const chosen = selection.pick(actionable.value)
  if (!chosen.length) return
  await store.removeMany(chosen.map((entry) => entry.id))
  selection.cancel()
  batchConfirm.value = false
}

const batchConfirm = ref(false)

function runExport(): void {
  void exporter.run(actionable.value)
}

function onSelectToggle(entry: Entry): void {
  // Export's own selection uses the same store, so this only fires in export
  // mode; the delete mode uses the card/row checkbox through `toggleSelected`.
  selection.toggle(entry.id)
}

// --- Rename ----------------------------------------------------------------

const renameTarget = ref<Entry | null>(null)
const renameDraft = ref('')

function startRename(entry: Entry): void {
  renameTarget.value = entry
  renameDraft.value = displayTitle(entry)
}

async function commitRename(): Promise<void> {
  const target = renameTarget.value
  if (!target) return
  const next = renameDraft.value.trim()
  // An unchanged or cleared name both mean "no rename"; the backend normalizes
  // blank to null, so passing it through is the undo.
  await store.rename(target.id, next === target.title ? null : next)
  renameTarget.value = null
  renameDraft.value = ''
}

// --- Single removal --------------------------------------------------------

const confirmRemove = ref<Entry | null>(null)

async function confirmRemoval(): Promise<void> {
  const target = confirmRemove.value
  if (!target) return
  await store.remove(target.id)
  confirmRemove.value = null
}

/** Esc leaves selection mode without touching the shell's reader-exit path. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !selecting.value) return
  if (event.defaultPrevented) return
  event.preventDefault()
  if (batchConfirm.value) {
    batchConfirm.value = false
    return
  }
  selection.cancel()
}

async function handleImport(): Promise<void> {
  const report = await store.pickAndImport()
  if (report && report.imported.length === 1) {
    // Importing a single file is almost always "I want to read this now".
    const only = report.imported[0]
    if (only) emit('open', only)
  }
}

// --- Drag and drop ---------------------------------------------------------

const dragging = ref(false)
const dragDepth = ref(0)

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

/** Progress shown inline on a row, so resuming is discoverable at a glance. */
function progressLabel(entry: Entry): string | null {
  // Interpreted by the format's own reader (`src/library/progress.ts`), not
  // here: the payload shape belongs to the viewer that wrote it. Adding a format
  // must not mean editing this view.
  return readProgress(entry).label
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
  // Leaving the screen must not strand the selection: it belongs to this view and
  // would otherwise come back half-finished.
  if (selection.active) selection.cancel()
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
        <p v-if="!isEmpty" class="count">
          <template v-if="filtering">
            {{ t('library.countFiltered', { shown: visible.length, total: store.entries.length }) }}
          </template>
          <template v-else>{{ t('library.count', { count: store.entries.length }) }}</template>
        </p>
      </div>

      <!-- What survives of the old dashboard: four numbers on one line. Charts and
           distributions are gone because the filterable list below answers the same
           questions with fewer places to disagree. -->
      <dl v-if="!isEmpty" class="stats">
        <div class="stat">
          <dt class="stat-label">{{ t('library.stat.total') }}</dt>
          <dd class="stat-value">{{ stats.total }}</dd>
        </div>
        <div class="stat">
          <dt class="stat-label">{{ t('library.stat.reading') }}</dt>
          <dd class="stat-value">{{ stats.reading }}</dd>
        </div>
        <div class="stat">
          <dt class="stat-label">{{ t('library.stat.finished') }}</dt>
          <dd class="stat-value">{{ stats.finished }}</dd>
        </div>
        <div class="stat">
          <dt class="stat-label">{{ t('library.stat.storage') }}</dt>
          <dd class="stat-value">{{ formatSize(stats.bytes) }}</dd>
        </div>
      </dl>

      <div v-if="!isEmpty && !selecting" class="header-actions">
        <label class="search">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="search-icon">>
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.4" />
          </svg>
          <input
            :value="query.text"
            class="search-input"
            type="search"
            :placeholder="t('library.search')"
            :aria-label="t('library.search')"
            @input="query = { ...query, text: ($event.target as HTMLInputElement).value }"
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
        <ExportMenu :entries="actionable" />
      </div>

      <!-- Selection mode replaces the header actions rather than adding to
           them: during a selection, importing or searching would be a
           distraction from the one thing in progress. -->
      <div v-else-if="selecting" class="selection-actions">
        <p class="selection-count">
          {{ t('export.selected', { count: selection.count, total: actionable.length }) }}
        </p>
        <button class="btn btn--tertiary" type="button" @click="selection.selectAll(actionable)">
          {{ t('export.selectAll') }}
        </button>
        <button
          class="btn btn--tertiary"
          type="button"
          :disabled="!selection.count"
          @click="selection.clear()"
        >
          {{ t('export.clearSelection') }}
        </button>
        <button class="btn btn--tertiary" type="button" @click="selection.cancel()">
          {{ t('export.cancel') }}
        </button>

        <!-- Export mode and delete mode share the selection; whichever purpose
             is active decides which action the primary button runs. -->
        <button
          v-if="selection.purpose === 'delete'"
          class="btn btn--secondary"
          type="button"
          :disabled="!selection.count"
          @click="batchConfirm = true"
        >
          {{ t('library.deleteSelected') }}
        </button>
        <button
          v-else
          class="btn btn--primary"
          type="button"
          :disabled="!selection.count || exporter.running"
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

    <!-- Batch-removal outcome: a persistent strip, not a toast, for the same
         reason import feedback is one — a toast disappears before it is read. -->
    <div v-if="store.lastRemoval" class="error-wrap">
      <div class="notice-strip">
        <p class="notice-text">
          {{
            store.lastRemoval.failed
              ? t('library.deletePartial', {
                  removed: store.lastRemoval.removed,
                  failed: store.lastRemoval.failed,
                })
              : t('library.deleteDone', { count: store.lastRemoval.removed })
          }}
        </p>
        <button class="btn btn--tertiary" type="button" @click="store.clearRemoval()">
          {{ t('common.close') }}
        </button>
      </div>
    </div>

    <!-- Toolbar: sort, filter, layout. Hidden while selection is active so the
         header has exactly one set of actions at a time. -->
    <div v-if="!isEmpty && !selecting" class="toolbar">
      <div class="toolbar-group">
        <span class="toolbar-label">{{ t('library.sort') }}</span>
        <button
          v-for="key in SORT_KEYS"
          :key="key"
          class="chip"
          :class="{ 'is-active': query.sort === key }"
          type="button"
          :aria-pressed="query.sort === key"
          @click="setSort(key)"
        >
          {{ SORT_LABELS[key] }}
          <svg
            v-if="query.sort === key"
            width="9"
            height="9"
            viewBox="0 0 10 10"
            aria-hidden="true"
            class="chip-arrow"
            :class="{ 'is-asc': query.direction === 'asc' }"
          >
            <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </button>
      </div>

      <div class="toolbar-group">
        <span class="toolbar-label">{{ t('library.filter') }}</span>
        <button
          v-for="format in FORMAT_GROUPS"
          :key="format"
          class="chip"
          :class="{ 'is-active': query.format === format, 'is-empty': !formatCounts[format] }"
          type="button"
          :disabled="!formatCounts[format]"
          :aria-pressed="query.format === format"
          @click="setFormat(format)"
        >
          {{ FORMAT_LABELS[format] }}
          <span class="chip-count">{{ formatCounts[format] }}</span>
        </button>

        <!-- Status is a second axis; it collapses into one select to keep the
             toolbar from growing a row of chips per dimension. -->
        <select
          class="toolbar-select"
          :value="query.status ?? ''"
          :aria-label="t('library.filter.status')"
          @change="setStatus((($event.target as HTMLSelectElement).value || null) as ReadStatus | null)"
        >
          <option value="">{{ t('library.filter.status') }}：{{ t('library.filter.all') }}</option>
          <option v-for="status in READ_STATUSES" :key="status" :value="status">
            {{ STATUS_LABELS[status] }}（{{ statusCounts[status] }}）
          </option>
        </select>

        <select
          v-if="groups.length"
          class="toolbar-select"
          :value="query.group ?? ''"
          :aria-label="t('library.filter.group')"
          @change="setGroup((($event.target as HTMLSelectElement).value || null))"
        >
          <option value="">{{ t('library.filter.group') }}：{{ t('library.filter.all') }}</option>
          <option v-for="group in groups" :key="group" :value="group">{{ group }}</option>
        </select>

        <!-- Local files and source references live in one list; this is how you
             narrow to one kind without moving to another page. Hidden when the
             library holds only one kind, because then it can only do nothing. -->
        <select
          v-if="originCounts.file && originCounts.online"
          class="toolbar-select"
          :value="query.origin ?? ''"
          :aria-label="t('library.filter.origin')"
          @change="setOrigin((($event.target as HTMLSelectElement).value || null) as OriginFilter | null)"
        >
          <option value="">{{ t('library.filter.origin') }}：{{ t('library.filter.all') }}</option>
          <option v-for="origin in ORIGIN_FILTERS" :key="origin" :value="origin">
            {{ ORIGIN_LABELS[origin] }}（{{ originCounts[origin] }}）
          </option>
        </select>

        <button
          v-if="filtering"
          class="btn btn--tertiary clear-filters"
          type="button"
          @click="clearFilters"
        >
          {{ t('library.filter.clear') }}
        </button>
      </div>

      <div class="toolbar-group toolbar-end">
        <button
          class="btn btn--tertiary"
          type="button"
          @click="startDeleteSelection"
        >
          {{ t('library.select') }}
        </button>

        <!-- Two densities, not two designs: same data, same query, same store. -->
        <div class="view-switch" role="group" :aria-label="t('library.view')">
          <button
            class="view-btn"
            :class="{ 'is-active': view === 'list' }"
            type="button"
            :aria-pressed="view === 'list'"
            :title="t('library.view.list')"
            @click="view = 'list'"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M1 3h12M1 7h12M1 11h12" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </button>
          <button
            class="view-btn"
            :class="{ 'is-active': view === 'grid' }"
            type="button"
            :aria-pressed="view === 'grid'"
            :title="t('library.view.grid')"
            @click="view = 'grid'"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="1" y="1" width="5" height="5" fill="currentColor" />
              <rect x="8" y="1" width="5" height="5" fill="currentColor" />
              <rect x="1" y="8" width="5" height="5" fill="currentColor" />
              <rect x="8" y="8" width="5" height="5" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div v-if="store.loading" class="loading">{{ t('common.loading') }}</div>

    <EmptyLibrary v-else-if="isEmpty" :importing="store.importing" @import="handleImport" />

    <div v-else-if="!visible.length" class="no-results">
      <p class="no-results-title">
        {{ searching ? t('library.searchEmpty', { query: query.text.trim() }) : t('library.filteredEmpty') }}
      </p>
      <button v-if="filtering" class="btn btn--tertiary" type="button" @click="clearFilters">
        {{ t('library.filter.clear') }}
      </button>
    </div>

    <!-- Grid: the same entries, recognised by shape instead of read by title. -->
    <div v-else-if="view === 'grid'" class="cards">
      <LibraryCard
        v-for="entry in visible"
        :key="entry.id"
        :entry="entry"
        :selecting="selecting"
        :selected="selection.isSelected(entry.id)"
        :eligible="selection.allows(entry)"
        @open="emit('open', $event)"
        @toggle="toggleSelected"
      />
    </div>

    <ul v-else class="entries">
      <li
        v-for="entry in visible"
        :key="entry.id"
        class="entry"
        :class="{
          'is-selecting': selecting,
          'is-selected': selection.isSelected(entry.id),
          'is-ineligible': selecting && !selection.allows(entry),
        }"
      >
        <!-- Selection is a checkbox, not a row click: opening a file and
             choosing a file are different intentions and must not share a
             target. -->
        <label v-if="selecting" class="entry-check">
          <input
            type="checkbox"
            :checked="selection.isSelected(entry.id)"
            :disabled="!selection.allows(entry)"
            :aria-label="displayTitle(entry)"
            @change="onSelectToggle(entry)"
          />
        </label>

        <button class="entry-open" type="button" @click="emit('open', entry)">
          <!-- An online entry has no extension; the source name is the useful
               label there, because two copies of one title differ by source. -->
          <span class="entry-ext">
            {{ entry.kind === 'online' ? sourceLabel(entry) : extensionLabel(entry.extension) }}
          </span>

          <span class="entry-main">
            <span class="entry-title">{{ displayTitle(entry) }}</span>
            <span class="entry-meta">
              <template v-if="entry.kind === 'online'">
                <span>{{ onlineMeta(entry) }}</span>
                <span class="dot" aria-hidden="true">·</span>
                <span v-if="entry.lastOpenedAt">{{ formatRelative(entry.lastOpenedAt) }}</span>
                <span v-else>{{ formatRelative(entry.addedAt) }}</span>
                <template v-if="entry.reference?.invalid">
                  <span class="dot" aria-hidden="true">·</span>
                  <span class="entry-progress">{{ t('library.online.broken') }}</span>
                </template>
              </template>
              <template v-else>
                <span>{{ formatSize(entry.size) }}</span>
                <span class="dot" aria-hidden="true">·</span>
                <span v-if="entry.lastOpenedAt">{{ formatRelative(entry.lastOpenedAt) }}</span>
                <span v-else>{{ formatRelative(entry.addedAt) }}</span>
              </template>
              <template v-if="progressLabel(entry)">
                <span class="dot" aria-hidden="true">·</span>
                <span class="entry-progress">{{ progressLabel(entry) }}</span>
              </template>
            </span>
          </span>
        </button>

        <!-- Removal and rename hide during selection: a misclick there would
             delete or rename a file the person was about to act on. -->
        <template v-if="!selecting">
          <button class="entry-action btn btn--tertiary" type="button" @click="startRename(entry)">
            {{ t('library.rename') }}
          </button>
          <button
            class="entry-remove btn btn--danger"
            type="button"
            :aria-label="t('entry.remove')"
            @click="confirmRemove = entry"
          >
            {{ t('entry.remove') }}
          </button>
        </template>
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
        <h2 class="confirm-title">{{ t('entry.removeConfirm', { title: displayTitle(confirmRemove) }) }}</h2>
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

    <!-- Batch removal confirmation. The count is spelled out because that is the
         only thing the person can still check at this point. -->
    <div v-if="batchConfirm" class="confirm-backdrop" @click.self="batchConfirm = false">
      <div class="confirm" role="dialog" aria-modal="true">
        <h2 class="confirm-title">{{ t('library.deleteConfirm', { count: selection.count }) }}</h2>
        <p class="confirm-body">{{ t('library.deleteConfirmBody') }}</p>
        <div class="confirm-actions">
          <button class="btn btn--tertiary" type="button" @click="batchConfirm = false">
            {{ t('entry.removeCancel') }}
          </button>
          <button class="btn btn--secondary" type="button" @click="confirmBatchDelete">
            {{ t('entry.removeAction') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Rename. Clearing the field is the undo, which the hint says outright so
         nobody wonders whether the original name is lost. -->
    <div v-if="renameTarget" class="confirm-backdrop" @click.self="renameTarget = null">
      <div class="confirm" role="dialog" aria-modal="true">
        <h2 class="confirm-title">
          {{ t('library.renameTitle', { title: displayTitle(renameTarget) }) }}
        </h2>
        <label class="rename-field">
          <input
            v-model="renameDraft"
            class="rename-input"
            type="text"
            :placeholder="t('library.renamePlaceholder')"
            @keydown.enter="commitRename"
          />
        </label>
        <p class="confirm-body">{{ t('library.renameHint') }}</p>
        <div class="confirm-actions">
          <button class="btn btn--tertiary" type="button" @click="renameTarget = null">
            {{ t('entry.removeCancel') }}
          </button>
          <button class="btn btn--secondary" type="button" @click="commitRename">
            {{ t('library.renameSave') }}
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

/* Four numbers on one line, aligned with the heading's baseline. Not a card, not a
   panel: a definition list with spacing doing the dividing, per the design system. */
.stats {
  display: flex;
  gap: var(--space-6);
  margin: 0;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.stat-label {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  letter-spacing: 0.02em;
}

.stat-value {
  margin: 0;
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  font-variant-numeric: tabular-nums;
  color: var(--ink-primary);
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
/* --- Toolbar ------------------------------------------------------------
   One row that holds sorting, filtering and the layout switch. Its height is
   fixed so toggling a filter or the view never shifts the list below it. */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3) var(--space-5);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
}

.toolbar-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* Pushed to the right edge: destructive mode entry and the view switch are not
   part of the filter story, so they sit away from it. */
.toolbar-end {
  margin-left: auto;
}

.toolbar-label {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  margin-right: var(--space-1);
}

/* A chip is a toggle, so its active state must be legible without hue: it goes
   to full ink strength with a solid background step. */
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  color: var(--ink-secondary);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.chip:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--ink-primary);
}

.chip.is-active {
  background: var(--surface-ink);
  color: var(--ink-inverse);
  font-weight: var(--weight-medium);
}

.chip:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.chip-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.65;
}

.chip-arrow {
  transition: transform var(--duration-fast) var(--ease-out);
}

.chip-arrow.is-asc {
  transform: rotate(180deg);
}

.toolbar-select {
  height: var(--control-sm);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface-raised);
  font-size: var(--text-xs);
  color: var(--ink-secondary);
}

.clear-filters {
  font-size: var(--text-xs);
}

/* --- View switch --------------------------------------------------------- */
.view-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
}

.view-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--ink-tertiary);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.view-btn:hover {
  color: var(--ink-secondary);
}

.view-btn.is-active {
  background: var(--surface-raised);
  color: var(--ink-primary);
  box-shadow: var(--shadow-e1);
}

/* --- Card grid -----------------------------------------------------------
   Column count comes from a minimum readable width, so resizing adds a column
   instead of squeezing every card. */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--card-min-width), 1fr));
  gap: var(--grid-gap-roomy) var(--grid-gap);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-9);
  align-content: start;
}

/* --- Row actions ---------------------------------------------------------
   Rename joins remove in the hover-only group: neither is the row's job. */
.entry-action {
  flex: none;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}

.entry:hover .entry-action,
.entry-action:focus-visible {
  opacity: 1;
}

/* --- Notice strip (batch removal outcome) -------------------------------- */
.notice-strip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
}

.notice-text {
  flex: 1;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

/* --- Rename dialog ------------------------------------------------------- */
.rename-field {
  display: block;
  margin-top: var(--space-4);
}

.rename-input {
  width: 100%;
  height: var(--control-md);
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface-page);
  font-size: var(--text-sm);
  color: var(--ink-primary);
}

.rename-input:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
</style>
