<script setup lang="ts">
/**
 * One entry as a card.
 *
 * The cover is typographic, not an image. A local file has no cover art, and the
 * two alternatives are both worse: fetching one from a book database means a
 * network call for a local-only app and a wrong guess half the time; showing a
 * grey box with a generic file icon tells you nothing. So the "cover" is built
 * from what is actually known — the format, the title, and how far in you are —
 * and it is laid out like a book spine so a grid of them is scannable.
 *
 * This is the one place the design system's "no card grid" rule is deliberately
 * relaxed (see `docs/design-system.md`). The rule exists because cards waste
 * space on text; here the card is carrying a visual identity, which is the case
 * the rule never covered.
 */
import { computed } from 'vue'
import type { Entry } from '@/types/viewer'
import { displayTitle, formatGroupOf } from '@/library/query'
import { readProgress } from '@/library/progress'
import { extensionLabel, formatSize } from '@/utils/format'
import { t } from '@/i18n'

const props = defineProps<{
  entry: Entry
  selecting: boolean
  selected: boolean
  /** False when the current action cannot take this entry (export targets). */
  eligible: boolean
}>()

const emit = defineEmits<{
  open: [entry: Entry]
  toggle: [entry: Entry]
}>()

const title = computed(() => displayTitle(props.entry))
const progress = computed(() => readProgress(props.entry))
const group = computed(() => formatGroupOf(props.entry.extension))

/** A reference to a source rather than a managed file. */
const isOnline = computed(() => props.entry.kind === 'online')

/** The reference is broken: its source was deleted or disabled. */
const isBroken = computed(() => isOnline.value && props.entry.reference?.invalid === true)

/**
 * Format word for the spine.
 *
 * Full words rather than the extension, because a card has the room and "PDF" vs
 * "EPUB" vs "音频" is faster to read than three uppercase acronyms of similar shape.
 * An online entry has no format, so the spine names the source instead — that is
 * the fact a person actually needs to tell two copies of the same title apart.
 */
const formatLabel = computed(() => {
  if (isOnline.value) {
    return props.entry.reference?.sourceName || t('library.origin.online')
  }
  switch (group.value) {
    case 'pdf':
      return 'PDF'
    case 'epub':
      return 'EPUB'
    case 'audio':
      return t('library.format.audio')
    case 'text':
      return t('library.format.text')
    default:
      return extensionLabel(props.entry.extension)
  }
})

/**
 * The meta line under the title.
 *
 * Files show extension and size; online entries show episode count and, when the
 * source is gone, that fact. Showing "0 B" for a reference would be true and
 * useless.
 */
const metaText = computed(() => {
  if (isOnline.value) {
    const count = props.entry.reference?.episodeCount
    return typeof count === 'number' && count > 0
      ? t('library.online.episodes', { count })
      : t('library.origin.online')
  }
  return `${extensionLabel(props.entry.extension)} · ${formatSize(props.entry.size)}`
})

/** Progress bar fill, or null when the payload has no honest fraction. */
const ratio = computed(() => progress.value.ratio)

function onActivate(): void {
  // In selection mode the whole card is a checkbox target, not an "open" target.
  // Opening a file and choosing a file are different intentions and must not
  // share a hit area.
  if (props.selecting) {
    if (props.eligible) emit('toggle', props.entry)
    return
  }
  emit('open', props.entry)
}
</script>

<template>
  <div
    class="card"
    :class="{ 'is-selected': selected, 'is-ineligible': selecting && !eligible }"
  >
    <button class="card-hit" type="button" @click="onActivate">
      <span class="cover">
        <span class="spine">
          <span class="format">{{ formatLabel }}</span>
          <span class="spine-title">{{ title }}</span>
        </span>
        <span v-if="ratio !== null" class="bar" aria-hidden="true">
          <span class="bar-fill" :style="{ width: `${Math.round(ratio * 100)}%` }" />
        </span>
        <span v-if="progress.label" class="bar-label">{{ progress.label }}</span>
        <!-- A broken reference is stated on the card, not hidden by removing it:
             the record of what someone added is theirs, and a silently vanishing
             card looks like data loss. -->
        <span v-if="isBroken" class="broken">{{ t('library.online.broken') }}</span>
      </span>

      <span class="body">
        <span class="title" :title="title">{{ title }}</span>
        <span class="meta">
          <span>{{ metaText }}</span>
        </span>
      </span>
    </button>

    <!-- A checkbox, not a click target: it says what it does and it is reachable
         by keyboard on its own. -->
    <label v-if="selecting" class="check">
      <input
        type="checkbox"
        :checked="selected"
        :disabled="!eligible"
        :aria-label="title"
        @change="emit('toggle', entry)"
      />
    </label>
  </div>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
}

.card-hit {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  text-align: left;
  border-radius: var(--radius-md);
}

/* --- Cover --------------------------------------------------------------
   A spine: the format pinned to the top, the title running down. The background
   step is the only separation from the page, per the design system — no border,
   no shadow. */
.cover {
  position: relative;
  display: flex;
  flex-direction: column;
  aspect-ratio: var(--card-cover-aspect);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  overflow: hidden;
  transition: background-color var(--duration-fast) var(--ease-out);
}

.card-hit:hover .cover {
  background: var(--surface-hover);
}

.spine {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}

.format {
  flex: none;
  font-size: var(--text-xs);
  font-weight: var(--weight-strong);
  letter-spacing: 0.06em;
  color: var(--ink-tertiary);
}

/* `-webkit-line-clamp` is the only way to ellipsize at N lines without
   measuring in JS; three lines is what fits before the bar. */
.spine-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-snug);
  color: var(--ink-primary);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

/* Pinned to the bottom so the bar lines up across a row of cards. */
.bar {
  position: absolute;
  left: var(--space-3);
  right: var(--space-3);
  bottom: var(--space-3);
  height: 2px;
  border-radius: var(--radius-full);
  background: var(--line-strong);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  background: var(--ink-secondary);
}

.bar-label {
  position: absolute;
  left: var(--space-3);
  bottom: calc(var(--space-3) + 6px);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

/* Sits where the format label would be, in the same muted weight: a fact about
   the entry, not an error state demanding attention. */
.broken {
  position: absolute;
  right: var(--space-3);
  bottom: calc(var(--space-3) + 6px);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

/* --- Body --------------------------------------------------------------- */
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: 0 var(--space-1);
}

.title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.dot {
  color: var(--line-strong);
}

/* --- States -------------------------------------------------------------
   Selected and ineligible use surface and opacity, never hue. */
.card.is-selected .cover {
  background: var(--surface-active);
}

.card.is-ineligible {
  opacity: 0.45;
}

.card.is-ineligible .card-hit {
  cursor: default;
}

.check {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-full);
  background: var(--surface-raised);
  box-shadow: var(--shadow-e1);
  cursor: pointer;
}

.check input {
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: var(--surface-ink);
}

.check input:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}
</style>
