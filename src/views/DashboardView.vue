<script setup lang="ts">
/**
 * The dashboard.
 *
 * Design constraint: every figure here is real. The library already stores
 * size, extension, progress and timestamps, so the overview needs no new
 * instrumentation — and anything that *would* need it (reading time, streaks)
 * is absent instead of faked.
 *
 * Visual constraint: no colored stat tiles. Hierarchy comes from number size
 * and the contrast ramp; distribution is a set of gray bars, not a pie chart.
 * At four files the layout collapses to a single readable column rather than
 * stretching four cards across an empty canvas.
 */
import { computed } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { t } from '@/i18n'
import { formatRelative, formatSize } from '@/utils/format'
import { largestBucketCount, summarize } from '@/utils/dashboard'
import { extensionLabel } from '@/utils/format'
import type { Entry } from '@/types/viewer'

const emit = defineEmits<{ open: [entry: Entry]; 'go-import': [] }>()

const store = useLibraryStore()
const summary = computed(() => summarize(store.entries))
const maxCount = computed(() => largestBucketCount(summary.value.formats))

/** Total across all states, for computing the state bar proportions. */
const stateTotal = computed(() => {
  const s = summary.value.states
  return s.unread + s['in-progress'] + s.finished
})

const stateRows = computed(() => {
  const s = summary.value.states
  const total = stateTotal.value || 1
  return [
    { key: 'in-progress' as const, label: t('dashboard.state.in-progress'), count: s['in-progress'], ratio: s['in-progress'] / total },
    { key: 'finished' as const, label: t('dashboard.state.finished'), count: s.finished, ratio: s.finished / total },
    { key: 'unread' as const, label: t('dashboard.state.unread'), count: s.unread, ratio: s.unread / total },
  ]
})

const isEmpty = computed(() => !store.loading && summary.value.total === 0)

/** Progress text for a recent row, matching the library list's wording. */
function recentProgress(entry: Entry): string {
  const progress = entry.progress
  if (!progress || typeof progress !== 'object') return ''
  const raw = progress as { ratio?: number; page?: number; time?: number }
  if (typeof raw.ratio === 'number') return t('entry.progress', { percent: Math.round(raw.ratio * 100) })
  if (typeof raw.page === 'number') return `第 ${raw.page} 页`
  return ''
}
</script>

<template>
  <div class="dashboard">
    <header class="dash-header">
      <h1 class="dash-title">{{ t('dashboard.title') }}</h1>
      <p class="dash-sub">{{ t('dashboard.subtitle') }}</p>
    </header>

    <div v-if="store.loading" class="dash-loading">{{ t('common.loading') }}</div>

    <div v-else-if="isEmpty" class="dash-empty">
      <p class="dash-empty-title">{{ t('dashboard.empty.title') }}</p>
      <p class="dash-empty-body">{{ t('dashboard.empty.body') }}</p>
      <button class="btn btn--primary" type="button" @click="emit('go-import')">
        {{ t('dashboard.empty.action') }}
      </button>
    </div>

    <div v-else class="dash-body">
      <!-- Figures first: four numbers, no tiles. Size carries the hierarchy. -->
      <section class="figures" aria-label="概览">
        <div class="figure">
          <span class="figure-value">{{ summary.total }}</span>
          <span class="figure-label">{{ t('dashboard.total') }}</span>
        </div>
        <div class="figure">
          <span class="figure-value">{{ formatSize(summary.totalBytes) }}</span>
          <span class="figure-label">{{ t('dashboard.storage') }}</span>
        </div>
        <div class="figure">
          <span class="figure-value">{{ summary.states['in-progress'] }}</span>
          <span class="figure-label">{{ t('dashboard.inProgress') }}</span>
        </div>
        <div class="figure">
          <span class="figure-value">{{ summary.addedThisWeek }}</span>
          <span class="figure-label">{{ t('dashboard.thisWeek') }}</span>
        </div>
      </section>

      <div class="panels">
        <!-- Distribution: horizontal bars, one per format. Bar length is the
             only encoding, so no legend and no color are needed. -->
        <section class="panel">
          <h2 class="panel-title">{{ t('dashboard.formats') }}</h2>
          <p v-if="!summary.formats.length" class="panel-empty">{{ t('dashboard.formats.empty') }}</p>
          <ul v-else class="format-list">
            <li v-for="format in summary.formats" :key="format.extension || 'none'" class="format-row">
              <span class="format-name">{{ extensionLabel(format.extension) }}</span>
              <span class="format-bar-track">
                <span
                  class="format-bar"
                  :style="{ width: `${maxCount ? (format.count / maxCount) * 100 : 0}%` }"
                />
              </span>
              <span class="format-count">{{ format.count }}</span>
              <span class="format-size">{{ formatSize(format.bytes) }}</span>
            </li>
          </ul>
        </section>

        <section class="panel">
          <h2 class="panel-title">{{ t('dashboard.states') }}</h2>
          <ul class="state-list">
            <li v-for="row in stateRows" :key="row.key" class="state-row">
              <span class="state-label">{{ row.label }}</span>
              <span class="state-bar-track">
                <span class="state-bar" :style="{ width: `${row.ratio * 100}%` }" />
              </span>
              <span class="state-count">{{ row.count }}</span>
            </li>
          </ul>
        </section>
      </div>

      <section class="panel recent-panel">
        <h2 class="panel-title">{{ t('dashboard.recent') }}</h2>
        <p v-if="!summary.recent.length" class="panel-empty">{{ t('dashboard.recent.empty') }}</p>
        <ul v-else class="recent-list">
          <li v-for="entry in summary.recent" :key="entry.id">
            <button class="recent-row" type="button" @click="emit('open', entry)">
              <span class="recent-ext">{{ extensionLabel(entry.extension) }}</span>
              <span class="recent-title">{{ entry.title }}</span>
              <span class="recent-progress">{{ recentProgress(entry) }}</span>
              <span class="recent-time">{{ formatRelative(entry.lastOpenedAt ?? entry.addedAt) }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.dash-header {
  padding: var(--space-7) var(--content-pad) var(--space-4);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  flex: none;
}

.dash-title {
  font-size: var(--text-2xl);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
  letter-spacing: -0.01em;
}

.dash-sub {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

.dash-loading,
.dash-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-9) var(--space-5);
  text-align: center;
  color: var(--ink-tertiary);
}

.dash-empty-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-strong);
  color: var(--ink-primary);
}

.dash-empty-body {
  max-width: 34ch;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--ink-secondary);
}

.dash-empty .btn {
  margin-top: var(--space-3);
}

.dash-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-9);
}

/* --- Figures ------------------------------------------------------------ */

/* Four numbers on a row. No card, no fill: the size jump from label to value
   is the entire hierarchy, which is why they need no boxes around them. */
.figures {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-5);
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--line-subtle);
}

.figure {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.figure-value {
  font-size: var(--text-xl);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
  color: var(--ink-primary);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.figure-label {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

/* --- Panels ------------------------------------------------------------- */

.panels {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-6);
}

.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.panel-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-strong);
  color: var(--ink-secondary);
}

.panel-empty {
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

/* --- Format distribution ------------------------------------------------ */

.format-list,
.state-list,
.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.format-row {
  display: grid;
  /* Fixed label column keeps every bar starting at the same x, so lengths are
     comparable at a glance. */
  grid-template-columns: var(--ext-column) 1fr auto auto;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--text-sm);
}

.format-name {
  font-size: var(--text-xs);
  font-weight: var(--weight-strong);
  color: var(--ink-tertiary);
  letter-spacing: 0.04em;
}

.format-bar-track,
.state-bar-track {
  display: block;
  height: var(--track-thickness);
  border-radius: var(--radius-full);
  /* Visible as a scale on both themes; see --chart-track's note in tokens. */
  background: var(--chart-track);
  overflow: hidden;
}

.format-bar,
.state-bar {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  /* Bars use ink, not a hue: length is the data, so color would be redundant. */
  background: var(--chart-fill);
  transition: width var(--duration-base) var(--ease-out);
}

.format-count {
  font-size: var(--text-xs);
  color: var(--ink-secondary);
  font-variant-numeric: tabular-nums;
  min-width: 2ch;
  text-align: right;
}

.format-size {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
  min-width: 6ch;
  text-align: right;
}

/* --- Reading states ----------------------------------------------------- */

.state-row {
  display: grid;
  grid-template-columns: 6em 1fr auto;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--text-sm);
}

.state-label {
  color: var(--ink-secondary);
}

/* In-progress is the state worth spotting, so it gets the darker bar; the
   others stay light. That is contrast doing the work, not color. */
.state-row:first-child .state-bar {
  background: var(--chart-fill-strong);
}

.state-count {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
  min-width: 2ch;
  text-align: right;
}

/* --- Recent ------------------------------------------------------------- */

.recent-panel {
  padding-top: var(--space-5);
  border-top: 1px solid var(--line-subtle);
}

.recent-row {
  display: grid;
  grid-template-columns: var(--ext-column) 1fr auto auto;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3);
  margin: 0 calc(var(--space-3) * -1);
  border-radius: var(--radius-md);
  text-align: left;
  transition: background-color var(--duration-fast) var(--ease-out);
}

.recent-row:hover {
  background: var(--surface-hover);
}

.recent-ext {
  font-size: var(--text-xs);
  font-weight: var(--weight-strong);
  color: var(--ink-tertiary);
  letter-spacing: 0.04em;
}

.recent-title {
  font-size: var(--text-sm);
  color: var(--ink-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-progress {
  font-size: var(--text-xs);
  color: var(--ink-secondary);
  font-variant-numeric: tabular-nums;
}

.recent-time {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  min-width: 6ch;
  text-align: right;
}

/* --- Narrow windows -----------------------------------------------------
   Below 900px the four figures and the two panels stack. This is not a full
   mobile layout (that is a separate piece of work); it just keeps the screen
   from breaking at the window's minimum width. */
@media (max-width: 900px) {
  .figures {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
  }

  .panels {
    grid-template-columns: minmax(0, 1fr);
  }

  .dash-header,
  .dash-body {
    padding-left: var(--space-5);
    padding-right: var(--space-5);
  }
}
</style>
