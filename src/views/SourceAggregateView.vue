<script setup lang="ts">
/**
 * Aggregate search across every enabled source.
 *
 * An engine's search is the same request the single-source browse view makes, so
 * this reuses the engine rather than reimplementing it — the difference is
 * orchestration, not fetching.
 *
 * Two views of the same results:
 *   - **by source**: each source is a group, failures included as their own row.
 *     This is the honest default, because it answers "which sources came back".
 *   - **merged**: one flat list, each row labelled with its source. For comparing
 *     which source has more chapters or a better blurb.
 *
 * Results appear as each source settles. Waiting for the slowest source before
 * showing anything would throw away the whole reason to run them concurrently.
 */
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { t } from '@/i18n'
import { useSourcesStore } from '@/stores/sources'
import { aggregateSearch, sourcesForType, type AggregateOutcome } from '@/sources/aggregate'
import type { SourceItem } from '@/sources/engine'
import type { ResourceType } from '@/sources/schema'
import SourceCard from '@/components/SourceCard.vue'

const props = defineProps<{
  /** Which resource kind to search. `null` searches every enabled source. */
  type?: ResourceType | null
}>()

const emit = defineEmits<{
  open: [sourceId: string, item: SourceItem]
  switchSource: [sourceId: string]
}>()

const store = useSourcesStore()
const keyword = ref('')
const searching = ref(false)
const searched = ref(false)
const outcomes = ref<AggregateOutcome[]>([])
/** Merge view is off by default: grouped results are easier to trust. */
const merged = ref(false)
const mountHost = ref<HTMLElement | null>(null)
const signal = shallowRef<{ cancelled: boolean } | null>(null)

const targets = computed(() => sourcesForType(store.sources, props.type ?? null))

const succeeded = computed(() =>
  outcomes.value.filter((o): o is Extract<AggregateOutcome, { kind: 'ok' }> => o.kind === 'ok'),
)
const failed = computed(() =>
  outcomes.value.filter((o): o is Extract<AggregateOutcome, { kind: 'error' }> => o.kind === 'error'),
)
const totalItems = computed(() => succeeded.value.reduce((sum, o) => sum + o.items.length, 0))
const totalSkipped = computed(() => succeeded.value.reduce((sum, o) => sum + o.skipped, 0))

/** Every successful row, flattened, for the merged view. */
const flattened = computed(() =>
  succeeded.value.flatMap((outcome) =>
    outcome.items.map((item) => ({ item, sourceName: outcome.sourceName, sourceId: outcome.sourceId })),
  ),
)

async function run(): Promise<void> {
  const query = keyword.value.trim()
  if (!query || !targets.value.length) return

  // A second run must not append to the first one's results.
  cancel()
  searching.value = true
  searched.value = true
  outcomes.value = []

  const token = { cancelled: false }
  signal.value = token
  try {
    await aggregateSearch({
      keyword: query,
      sources: targets.value,
      signal: token,
      mountHost: mountHost.value ?? undefined,
      // Results land in the list as each source settles, rather than all at once.
      onSettled: (outcome) => {
        if (token.cancelled) return
        outcomes.value = [...outcomes.value, outcome]
      },
    })
  } finally {
    if (!token.cancelled) searching.value = false
  }
}

function cancel(): void {
  if (signal.value) signal.value.cancelled = true
  signal.value = null
  searching.value = false
}

function openItem(sourceId: string, item: SourceItem): void {
  emit('open', sourceId, item)
}

// A run holds live engines until it finishes; leaving the view must stop it, or
// the sandbox frames and pending requests outlive the screen.
onBeforeUnmount(() => {
  cancel()
})
</script>

<template>
  <div class="aggregate">
    <header class="agg-header">
      <div class="head-row">
        <h1 class="title">{{ t('source.aggregate') }}</h1>
        <p v-if="totalItems" class="count">
          {{ t('source.aggregateBySource') }} · {{ t('library.count', { count: totalItems }) }}
        </p>
      </div>

      <div class="search-row">
        <label class="search">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="search-icon">
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.4" />
          </svg>
          <input
            v-model="keyword"
            class="search-input"
            type="search"
            :placeholder="t('source.aggregatePlaceholder')"
            :aria-label="t('source.aggregatePlaceholder')"
            @keydown.enter="run"
          />
        </label>
        <button class="btn btn--primary" type="button" :disabled="searching || !keyword.trim()" @click="run">
          {{ searching ? t('source.searching') : t('source.search') }}
        </button>
        <button v-if="searching" class="btn btn--tertiary" type="button" @click="cancel">
          {{ t('export.cancel') }}
        </button>
      </div>

      <div class="meta-row">
        <p class="hint">{{ t('source.aggregateHint') }}</p>
        <button
          v-if="totalItems && !searching"
          class="btn btn--tertiary view-toggle"
          type="button"
          @click="merged = !merged"
        >
          {{ merged ? t('source.aggregateBySource') : t('source.aggregateMerged') }}
        </button>
      </div>
    </header>

    <!-- Sandbox host: engines create one zero-sized slot each inside it. -->
    <div ref="mountHost" class="sandbox-host" aria-hidden="true" />

    <div v-if="!targets.length" class="state">
      <p class="state-title">{{ t('source.empty.title') }}</p>
      <p class="state-body">{{ t('source.aggregateNoSources') }}</p>
    </div>

    <div v-else-if="searching && !outcomes.length" class="state">
      <p class="state-title">{{ t('source.aggregateSearching', { count: targets.length }) }}</p>
    </div>

    <div v-else-if="searched && !totalItems && !failed.length" class="state">
      <p class="state-title">{{ t('source.aggregateEmpty') }}</p>
      <p class="state-body">{{ t('source.noResultsBody', { keyword }) }}</p>
    </div>

    <template v-else-if="searched">
      <!-- Summary strip: what came back, what did not, and how much was skipped.
           This is the line that makes "no results" and "could not ask" different
           things. -->
      <div class="summary">
        <p v-if="totalSkipped" class="summary-line">
          {{ t('source.aggregateSkipped', { count: totalSkipped }) }}
        </p>
        <p v-if="failed.length" class="summary-line is-warn">
          {{ t('source.aggregateFailed', { count: failed.length }) }}
        </p>
        <p v-if="searching" class="summary-line">{{ t('source.aggregateSearching', { count: targets.length }) }}</p>
      </div>

      <!-- Merged: one list, every row labelled with its source. -->
      <div v-if="merged" class="grid">
        <div v-for="row in flattened" :key="`${row.sourceId}-${row.item.detailUrl}`" class="merged-cell">
          <SourceCard :item="row.item" @open="openItem(row.sourceId, $event)" />
          <p class="merged-source">{{ t('source.aggregateSourceLabel', { source: row.sourceName }) }}</p>
        </div>
      </div>

      <!-- By source: successes first, then failures as their own rows. -->
      <template v-else>
        <section v-for="outcome in succeeded" :key="outcome.sourceId" class="group">
          <header class="group-head">
            <button
              class="group-name"
              type="button"
              @click="emit('switchSource', outcome.sourceId)"
            >
              {{ outcome.sourceName }}
            </button>
            <span class="group-count">{{ t('library.count', { count: outcome.items.length }) }}</span>
            <span class="group-elapsed">{{ t('source.aggregateElapsed', { ms: outcome.elapsedMs }) }}</span>
            <span v-if="outcome.skipped" class="group-skipped">
              {{ t('source.aggregateSkipped', { count: outcome.skipped }) }}
            </span>
          </header>

          <p v-if="!outcome.items.length" class="group-empty">{{ t('source.noResults') }}</p>
          <div v-else class="grid">
            <SourceCard
              v-for="item in outcome.items"
              :key="item.detailUrl"
              :item="item"
              @open="openItem(outcome.sourceId, $event)"
            />
          </div>
        </section>

        <!-- Failures: named, with their own message. Never collapsed into "no
             results", which would blame the keyword for a dead site. -->
        <section v-if="failed.length" class="group is-failed">
          <header class="group-head">
            <span class="group-name is-static">{{ t('source.aggregateFailed', { count: failed.length }) }}</span>
          </header>
          <ul class="failure-list">
            <li v-for="outcome in failed" :key="outcome.sourceId" class="failure-row">
              <button class="failure-name" type="button" @click="emit('switchSource', outcome.sourceId)">
                {{ outcome.sourceName }}
              </button>
              <span class="failure-message">{{ outcome.message }}</span>
            </li>
          </ul>
        </section>
      </template>
    </template>

    <div v-else class="state">
      <p class="state-title">{{ t('source.searchHint.title') }}</p>
      <p class="state-body">{{ t('source.aggregateHint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.aggregate {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.agg-header {
  flex: none;
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: var(--space-6) var(--content-pad) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.head-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
}

.title {
  font-size: var(--text-2xl);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}

.count {
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

.search-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  height: var(--control-md);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
  transition: background-color var(--duration-fast) var(--ease-out);
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

.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.hint {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  line-height: var(--leading-snug);
}

.view-toggle {
  flex: none;
  font-size: var(--text-xs);
}

.sandbox-host {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}

.summary {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.summary-line {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.summary-line.is-warn {
  color: var(--tone-warning);
}

/* --- Groups ------------------------------------------------------------- */
.group {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-5);
}

.group-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--line-section);
  margin-bottom: var(--space-3);
}

.group-name {
  font-size: var(--text-sm);
  font-weight: var(--weight-strong);
  color: var(--ink-primary);
}

.group-name:hover {
  text-decoration: underline;
}

.group-name.is-static {
  text-decoration: none;
  cursor: default;
}

.group-count,
.group-elapsed,
.group-skipped {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.group-skipped {
  color: var(--tone-warning);
}

.group-empty {
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
  padding: var(--space-2) 0;
}

.group.is-failed {
  margin-top: var(--space-2);
}

.failure-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.failure-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.failure-row + .failure-row {
  border-top: 1px solid var(--line-subtle);
}

.failure-name {
  flex: none;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.failure-name:hover {
  color: var(--ink-primary);
  text-decoration: underline;
}

.failure-message {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--tone-danger);
  word-break: break-word;
}

/* --- Grid ---------------------------------------------------------------
   Same card grid as the library's, so a result looks like a result everywhere. */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--card-min-width), 1fr));
  gap: var(--grid-gap-roomy) var(--grid-gap);
  align-content: start;
}

.merged-cell {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.merged-source {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  padding: 0 var(--space-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  flex: 1;
  padding: var(--space-9) var(--space-6);
  text-align: center;
}

.state-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
}

.state-body {
  max-width: 46ch;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  line-height: var(--leading-normal);
}
</style>
