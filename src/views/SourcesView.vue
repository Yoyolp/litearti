<script setup lang="ts">
/**
 * Source management.
 *
 * This screen answers three questions: what do I have, which ones work, and how
 * do I change one. The old version answered only the first — it was a flat list
 * with an import button, so editing a selector meant rewriting the whole JSON in
 * an external editor and re-importing.
 *
 * So: grouped by resource type, searchable, batch-operable, and every row leads
 * somewhere (edit, trial run, aggregate search). The template panel is gone:
 * "copy this JSON elsewhere" was a workaround for having no editor, and now there
 * is one.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSourcesStore } from '@/stores/sources'
import { t } from '@/i18n'
import { RESOURCE_TYPES, type ResourceType } from '@/sources/schema'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { onLoginFinished, readPickedTextFile } from '@/api/library'
import SourceFormFeedback from '@/components/SourceFormFeedback.vue'

const emit = defineEmits<{
  browse: [sourceId: string]
  aggregate: []
  edit: [sourceId: string]
  create: []
  trial: [sourceId: string]
}>()

const store = useSourcesStore()

const importing = ref(false)
const loginMessage = ref('')
const loginError = ref(false)
let unsubscribeLogin: (() => void) | null = null

/** Free-text filter over name, id and homepage. */
const query = ref('')
/** Type filter. `null` means every type. */
const typeFilter = ref<ResourceType | null>(null)
const collapsed = ref<Record<string, boolean>>({})
const selecting = ref(false)
const selected = ref<Set<string>>(new Set())
const confirmDelete = ref(false)

const TYPE_LABELS: Record<ResourceType, string> = {
  novel: t('source.type.novel'),
  comic: t('source.type.comic'),
  audio: t('source.type.audio'),
  video: t('source.type.video'),
}

const isEmpty = computed(() => !store.loading && store.sources.length === 0)

/** Sources after the text and type filters. */
const filtered = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return store.sources.filter((source) => {
    if (typeFilter.value !== null && source.type !== typeFilter.value) return false
    if (!terms.length) return true
    const haystack = [source.name, source.id, source.homepage].join('\n').toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
})

/**
 * Groups in display order.
 *
 * A fixed type order rather than alphabetical: 小说, 视频, 漫画, 听书 is the order
 * people think in for this app, and it stays stable when sources are added.
 */
const groups = computed(() => {
  const byType = new Map<ResourceType, typeof filtered.value>()
  for (const source of filtered.value) {
    const list = byType.get(source.type) ?? []
    list.push(source)
    byType.set(source.type, list)
  }
  return RESOURCE_TYPES.filter((type) => byType.has(type)).map((type) => ({
    type,
    label: TYPE_LABELS[type],
    sources: byType.get(type) ?? [],
  }))
})

const enabledCount = computed(() => store.sources.filter((s) => s.enabled).length)

const typeCounts = computed(() => {
  const counts = new Map<ResourceType, number>()
  for (const source of store.sources) {
    counts.set(source.type, (counts.get(source.type) ?? 0) + 1)
  }
  return counts
})

function toggleCollapsed(type: ResourceType): void {
  collapsed.value = { ...collapsed.value, [type]: !collapsed.value[type] }
}

// --- Selection -------------------------------------------------------------

function startSelecting(): void {
  selecting.value = true
  selected.value = new Set()
}

function cancelSelecting(): void {
  selecting.value = false
  selected.value = new Set()
  confirmDelete.value = false
}

function toggleSelected(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function selectAll(): void {
  selected.value = new Set(filtered.value.map((s) => s.id))
}

const selectedSources = computed(() => store.sources.filter((s) => selected.value.has(s.id)))

async function setSelectedEnabled(enabled: boolean): Promise<void> {
  for (const source of selectedSources.value) {
    await store.setEnabled(source.id, enabled)
  }
  cancelSelecting()
}

async function deleteSelected(): Promise<void> {
  for (const source of selectedSources.value) {
    await store.remove(source.id)
  }
  cancelSelecting()
}

// --- Import ----------------------------------------------------------------

async function handleImport(): Promise<void> {
  store.clearIssues()
  importing.value = true
  try {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: '源 JSON', extensions: ['json'] }],
    })
    if (!picked) return
    const path = Array.isArray(picked) ? picked[0] : picked
    if (!path) return

    const text = await readPickedTextFile(path)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // A JSON syntax error is the most common first mistake; report the
      // parser's own position rather than a generic "invalid".
      store.lastIssues = [
        {
          path: '',
          message: `JSON 语法错误：${error instanceof Error ? error.message : String(error)}`,
        },
      ]
      return
    }

    await store.importDocument(parsed)
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    importing.value = false
  }
}

/** Esc leaves selection mode before it leaves the screen. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !selecting.value) return
  if (event.defaultPrevented) return
  event.preventDefault()
  if (confirmDelete.value) {
    confirmDelete.value = false
    return
  }
  cancelSelecting()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void store.load()
  // The login window lives outside this view, so its outcome arrives as an
  // event rather than a resolved promise.
  void onLoginFinished((event) => {
    loginError.value = !event.ok
    loginMessage.value = event.ok
      ? t('source.loginSuccess', { count: event.cookieCount })
      : event.message
    void store.finishLogin(event.sourceId)
  }).then((off) => {
    unsubscribeLogin = off
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unsubscribeLogin?.()
  unsubscribeLogin = null
})
</script>

<template>
  <div class="sources">
    <header class="sources-header">
      <div class="heading">
        <h1 class="title">{{ t('source.title') }}</h1>
        <p v-if="!isEmpty" class="count">
          {{ t('source.count', { count: store.sources.length }) }}
          <template v-if="enabledCount !== store.sources.length">
            · {{ enabledCount }} {{ t('source.enabled') }}
          </template>
        </p>
      </div>

      <div v-if="!selecting" class="actions">
        <button class="btn btn--tertiary" type="button" @click="emit('aggregate')">
          {{ t('source.aggregate') }}
        </button>
        <button class="btn btn--tertiary" type="button" @click="emit('create')">
          {{ t('source.new') }}
        </button>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="importing"
          @click="handleImport"
        >
          {{ importing ? t('source.importing') : t('source.import') }}
        </button>
      </div>

      <div v-else class="selection-actions">
        <p class="selection-count">{{ t('source.selected', { count: selected.size, total: filtered.length }) }}</p>
        <button class="btn btn--tertiary" type="button" @click="selectAll">
          {{ t('export.selectAll') }}
        </button>
        <button class="btn btn--tertiary" type="button" :disabled="!selected.size" @click="setSelectedEnabled(true)">
          {{ t('source.enableSelected') }}
        </button>
        <button class="btn btn--tertiary" type="button" :disabled="!selected.size" @click="setSelectedEnabled(false)">
          {{ t('source.disableSelected') }}
        </button>
        <button class="btn btn--tertiary" type="button" @click="cancelSelecting">
          {{ t('export.cancel') }}
        </button>
        <button
          class="btn btn--secondary"
          type="button"
          :disabled="!selected.size"
          @click="confirmDelete = true"
        >
          {{ t('source.deleteSelected') }}
        </button>
      </div>
    </header>

    <!-- The network notice is not optional chrome: this is the one section that
         leaves the machine, and the app otherwise promises it never does. -->
    <div class="notice">
      <p class="notice-text">{{ t('source.networkNotice') }}</p>
    </div>

    <SourceFormFeedback :issues="store.lastIssues" @dismiss="store.clearIssues()" />

    <div v-if="store.error" class="error-wrap">
      <div class="error-strip">
        <p class="error-text">{{ store.error }}</p>
        <button class="btn btn--tertiary" type="button" @click="store.clearError()">
          {{ t('common.close') }}
        </button>
      </div>
    </div>

    <!-- Toolbar: search, type filter, selection mode. -->
    <div v-if="!isEmpty && !selecting" class="toolbar">
      <label class="search">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="search-icon">
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.4" />
        </svg>
        <input
          v-model="query"
          class="search-input"
          type="search"
          :placeholder="t('source.searchSources')"
          :aria-label="t('source.searchSources')"
        />
      </label>

      <button
        v-for="type in RESOURCE_TYPES"
        :key="type"
        class="chip"
        :class="{ 'is-active': typeFilter === type, 'is-empty': !typeCounts.get(type) }"
        type="button"
        :disabled="!typeCounts.get(type)"
        :aria-pressed="typeFilter === type"
        @click="typeFilter = typeFilter === type ? null : type"
      >
        {{ TYPE_LABELS[type] }}
        <span class="chip-count">{{ typeCounts.get(type) ?? 0 }}</span>
      </button>

      <button class="btn btn--tertiary toolbar-end" type="button" @click="startSelecting">
        {{ t('source.select') }}
      </button>
    </div>

    <div v-if="store.loading" class="loading">{{ t('common.loading') }}</div>

    <div v-else-if="isEmpty" class="empty">
      <p class="empty-title">{{ t('source.empty.title') }}</p>
      <p class="empty-body">{{ t('source.empty.body') }}</p>
      <div class="empty-actions">
        <button class="btn btn--secondary" type="button" @click="emit('create')">
          {{ t('source.new') }}
        </button>
        <button class="btn btn--tertiary" type="button" @click="handleImport">
          {{ t('source.import') }}
        </button>
      </div>
    </div>

    <div v-else-if="!filtered.length" class="empty">
      <p class="empty-title">{{ t('source.searchEmpty', { query: query.trim() }) }}</p>
      <button class="btn btn--tertiary" type="button" @click="query = ''; typeFilter = null">
        {{ t('library.filter.clear') }}
      </button>
    </div>

    <div v-else class="groups">
      <section v-for="group in groups" :key="group.type" class="group">
        <button
          class="group-head"
          type="button"
          :aria-expanded="!collapsed[group.type]"
          @click="toggleCollapsed(group.type)"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            class="chevron"
            :class="{ 'is-collapsed': collapsed[group.type] }"
          >
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
          <span class="group-label">{{ group.label }}</span>
          <span class="group-count">{{ group.sources.length }}</span>
        </button>

        <ul v-if="!collapsed[group.type]" class="source-list">
          <li
            v-for="source in group.sources"
            :key="source.id"
            class="source-row"
            :class="{ 'is-selected': selected.has(source.id) }"
          >
            <label v-if="selecting" class="row-check">
              <input
                type="checkbox"
                :checked="selected.has(source.id)"
                :aria-label="source.name"
                @change="toggleSelected(source.id)"
              />
            </label>

            <button class="source-open" type="button" @click="selecting ? toggleSelected(source.id) : emit('browse', source.id)">
              <span class="source-main">
                <span class="source-name">
                  <!-- The title is its own element because `text-overflow` does not
                       apply to a flex container: with the text directly inside,
                       a long name would push the row wide instead of ellipsizing. -->
                  <span class="source-name-text">{{ source.name }}</span>
                  <span v-if="!source.enabled" class="source-off">{{ t('source.disabled') }}</span>
                </span>
                <span class="source-meta">
                  <span>v{{ source.version }}</span>
                  <span class="dot" aria-hidden="true">·</span>
                  <span class="source-url">{{ source.homepage }}</span>
                </span>
              </span>
            </button>

            <template v-if="!selecting">
              <!-- Login controls appear only for sources that declare `auth`. A
                   source without it never receives a cookie, so offering a login
                   button there would be a lie. -->
              <div v-if="source.auth" class="auth">
                <span
                  class="auth-state"
                  :class="{ 'is-in': store.credentialFor(source.id)?.hasCookie }"
                  :title="store.credentialFor(source.id)?.host ?? source.auth.host ?? ''"
                >
                  {{
                    store.credentialFor(source.id)?.hasCookie
                      ? t('source.loggedIn', { host: store.credentialFor(source.id)?.host ?? '' })
                      : t('source.loggedOut')
                  }}
                </span>
                <button
                  v-if="!store.credentialFor(source.id)?.hasCookie"
                  class="btn btn--tertiary"
                  type="button"
                  :disabled="store.loggingIn[source.id]"
                  @click="store.startLogin(source.id)"
                >
                  {{ store.loggingIn[source.id] ? t('source.loggingIn') : t('source.login') }}
                </button>
                <template v-else>
                  <button class="btn btn--tertiary" type="button" @click="store.startLogin(source.id)">
                    {{ t('source.relogin') }}
                  </button>
                  <button class="btn btn--tertiary" type="button" @click="store.clearLogin(source.id)">
                    {{ t('source.logout') }}
                  </button>
                </template>
              </div>

              <label class="toggle">
                <input
                  type="checkbox"
                  :checked="source.enabled"
                  :aria-label="t('source.enabled')"
                  @change="store.setEnabled(source.id, ($event.target as HTMLInputElement).checked)"
                />
              </label>

              <div class="row-actions">
                <button class="btn btn--tertiary row-action" type="button" @click="emit('trial', source.id)">
                  {{ t('source.trial') }}
                </button>
                <button class="btn btn--tertiary row-action" type="button" @click="emit('edit', source.id)">
                  {{ t('source.edit') }}
                </button>
                <button
                  class="btn btn--danger row-action is-danger"
                  type="button"
                  :aria-label="t('source.remove')"
                  @click="store.remove(source.id)"
                >
                  {{ t('source.remove') }}
                </button>
              </div>
            </template>
          </li>
        </ul>
      </section>
    </div>

    <p v-if="loginMessage" class="login-message" :class="{ 'is-error': loginError }">
      {{ loginMessage }}
    </p>

    <!-- Batch delete confirmation. Bodies are not affected, and saying so here is
         the difference between a confident click and a worried one. -->
    <div v-if="confirmDelete" class="confirm-backdrop" @click.self="confirmDelete = false">
      <div class="confirm" role="dialog" aria-modal="true">
        <h2 class="confirm-title">{{ t('source.deleteConfirm', { count: selected.size }) }}</h2>
        <p class="confirm-body">{{ t('source.deleteConfirmBody') }}</p>
        <div class="confirm-actions">
          <button class="btn btn--tertiary" type="button" @click="confirmDelete = false">
            {{ t('entry.removeCancel') }}
          </button>
          <button class="btn btn--secondary" type="button" @click="deleteSelected">
            {{ t('entry.removeAction') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sources {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.sources-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-6) var(--content-pad) var(--space-3);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  flex-wrap: wrap;
}

.title {
  font-size: var(--text-2xl);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}

.count {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

.actions,
.selection-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.selection-count {
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  font-variant-numeric: tabular-nums;
}

.notice {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
}

.notice-text {
  font-size: var(--text-xs);
  color: var(--tone-warning);
  background: var(--tone-warning-surface);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  line-height: var(--leading-snug);
}

/* --- Toolbar ------------------------------------------------------------ */
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
}

.search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 180px;
  height: var(--control-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
}

.search:focus-within {
  background: var(--surface-raised);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}

.search-icon {
  flex: none;
  color: var(--ink-tertiary);
}

.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: var(--text-sm);
  color: var(--ink-primary);
}

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

.toolbar-end {
  margin-left: auto;
}

/* --- Groups ------------------------------------------------------------- */
.groups {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 0 var(--space-7);
}

.group + .group {
  margin-top: var(--space-4);
}

.group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--content-pad);
  text-align: left;
  color: var(--ink-secondary);
}

.group-head:hover {
  color: var(--ink-primary);
}

.chevron {
  flex: none;
  color: var(--ink-tertiary);
  transition: transform var(--duration-fast) var(--ease-out);
}

.chevron.is-collapsed {
  transform: rotate(-90deg);
}

.group-label {
  font-size: var(--text-xs);
  font-weight: var(--weight-strong);
  letter-spacing: 0.04em;
}

.group-count {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.source-list {
  list-style: none;
  margin: 0;
  padding: 0 var(--content-pad);
}

.source-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border-radius: var(--radius-md);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.source-row:hover {
  background: var(--surface-hover);
}

.source-row.is-selected {
  background: var(--surface-active);
}

.row-check {
  flex: none;
  display: flex;
  align-items: center;
  padding-left: var(--space-4);
}

.row-check input,
.toggle input {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--surface-ink);
}

.source-open {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  padding: var(--space-3) var(--space-4);
  text-align: left;
}

.source-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.source-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  min-width: 0;
}

/* The truncating element: a block-level child of the flex row, so ellipsis has
   something to apply to. */
.source-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Disabled is stated in words, not by fading the whole row: a faded row reads as
   "loading", and the source is still perfectly usable to edit. */
.source-off {
  flex: none;
  font-size: var(--text-xs);
  font-weight: var(--weight-normal);
  color: var(--ink-tertiary);
}

.source-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  min-width: 0;
}

.source-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot {
  color: var(--line-strong);
}

.toggle {
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 var(--space-2);
}

/* Row actions stay quiet until the row is hovered or focused: three visible
   buttons per row would out-shout the source names. */
.row-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-right: var(--space-2);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}

.source-row:hover .row-actions,
.row-actions:focus-within {
  opacity: 1;
}

.row-action {
  font-size: var(--text-xs);
}

.row-action.is-danger:hover {
  color: var(--tone-danger);
  background: var(--tone-danger-surface);
}

/* --- auth --------------------------------------------------------------- */
.auth {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.auth-state {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  white-space: nowrap;
}

.auth-state::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: var(--space-2);
  border-radius: 50%;
  background: var(--ink-tertiary);
  vertical-align: middle;
}

.auth-state.is-in {
  color: var(--ink-secondary);
}

.auth-state.is-in::before {
  background: var(--ink-secondary);
}

.login-message {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-4);
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.login-message.is-error {
  color: var(--tone-warning);
}

.loading,
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  flex: 1;
  padding: var(--space-9) var(--space-6);
  text-align: center;
}

.empty-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
}

.empty-body {
  max-width: 46ch;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  line-height: var(--leading-normal);
}

.empty-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.error-wrap {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
}

.error-strip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--tone-danger-surface);
}

.error-text {
  flex: 1;
  font-size: var(--text-sm);
  color: var(--tone-danger);
}

/* --- confirm ------------------------------------------------------------ */
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
