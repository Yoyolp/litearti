<script setup lang="ts">
/**
 * One Bangumi subject, as a card.
 *
 * Two jobs: show enough to decide whether you care, and let you say that you do. The
 * status control is a small set of words rather than a dropdown, because there are
 * only four states and a select would hide them behind a click.
 *
 * Covers come from `api.bgm.tv`, a host this app otherwise never contacts, and they
 * fail often enough that the fallback is the normal path, not the exception. A failed
 * image becomes a typographic tile rather than a broken-image icon: a grid of broken
 * icons reads as "the app is broken".
 */
import { computed, ref } from 'vue'
import { t } from '@/i18n'
import { displayName, scoreLabel, type Subject } from '@/discover/subject'
import { COLLECT_STATUSES, statusOf, setStatus, type CollectStatus } from '@/discover/collect'

const props = defineProps<{
  subject: Subject
  /** Whether the status controls are shown. Hidden while browsing quickly. */
  showCollect?: boolean
}>()

const emit = defineEmits<{ open: [subject: Subject] }>()

const coverFailed = ref(false)

const title = computed(() => displayName(props.subject))
const score = computed(() => scoreLabel(props.subject))
const current = computed(() => statusOf(props.subject.id))

/** First character of the title, for the placeholder tile. */
const initial = computed(() => title.value.trim().charAt(0) || '?')

const STATUS_LABELS: Record<CollectStatus, string> = {
  wish: t('discover.collect.wish'),
  watching: t('discover.collect.watching'),
  watched: t('discover.collect.watched'),
  onHold: t('discover.collect.onHold'),
}

function toggle(status: CollectStatus): void {
  // Clicking the active state clears it: a separate "clear" control for four options
  // would be more chrome than the feature deserves.
  setStatus(props.subject.id, current.value === status ? null : status)
}
</script>

<template>
  <div class="subject">
    <button class="subject-hit" type="button" @click="emit('open', subject)">
      <span class="cover">
        <img
          v-if="subject.images.grid && !coverFailed"
          class="cover-image"
          :src="subject.images.grid"
          :alt="title"
          loading="lazy"
          referrerpolicy="no-referrer"
          @error="coverFailed = true"
        />
        <span v-else class="cover-fallback" aria-hidden="true">{{ initial }}</span>
      </span>

      <span class="body">
        <span class="title" :title="title">{{ title }}</span>
        <span class="meta">
          <!-- Score is a number, so it is set in tabular figures and kept on one
               line with the air date; no badge, no colour. -->
          <span v-if="score" class="score">{{ score }}</span>
          <span v-if="score && subject.date" class="dot" aria-hidden="true">·</span>
          <span v-if="subject.date">{{ subject.date }}</span>
        </span>
      </span>
    </button>

    <div v-if="showCollect" class="collect" role="group" :aria-label="title">
      <button
        v-for="status in COLLECT_STATUSES"
        :key="status"
        class="collect-btn"
        type="button"
        :class="{ 'is-active': current === status }"
        :aria-pressed="current === status"
        @click="toggle(status)"
      >
        {{ STATUS_LABELS[status] }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.subject {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.subject-hit {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  text-align: left;
  border-radius: var(--radius-md);
}

/* Portrait, like a book — and like the library's cards, so the two grids feel
   like the same app. */
.cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: var(--card-cover-aspect);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  overflow: hidden;
  transition: background-color var(--duration-fast) var(--ease-out);
}

.subject-hit:hover .cover {
  background: var(--surface-hover);
}

.cover-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-fallback {
  font-size: var(--text-xl);
  font-weight: var(--weight-strong);
  color: var(--ink-tertiary);
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.score {
  color: var(--ink-secondary);
  font-weight: var(--weight-medium);
}

.dot {
  color: var(--line-strong);
}

/* --- Status -------------------------------------------------------------
   Four words in a row. The active one steps up a surface level; the rest are
   flat. No accent colour: the design system carries state with contrast. */
.collect {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.collect-btn {
  padding: 2px var(--space-2);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  border-radius: var(--radius-sm);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.collect-btn:hover {
  background: var(--surface-hover);
  color: var(--ink-secondary);
}

.collect-btn.is-active {
  background: var(--surface-active);
  color: var(--ink-primary);
  font-weight: var(--weight-medium);
}
</style>
