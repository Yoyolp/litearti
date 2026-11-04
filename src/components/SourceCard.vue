<script setup lang="ts">
/**
 * A resource card in the browse grid.
 *
 * The card shows cover, title, type and a secondary line. Covers come from
 * arbitrary sites, so they fail often; a failed image falls back to a typographic
 * placeholder rather than a broken-image icon, because a grid of broken icons
 * looks like the app is broken.
 */
import { computed, ref } from 'vue'
import type { SourceItem } from '@/sources/engine'
import type { ResourceType } from '@/sources/schema'

const props = defineProps<{ item: SourceItem }>()
const emit = defineEmits<{ open: [item: SourceItem] }>()

const coverFailed = ref(false)

/**
 * Resource-kind labels.
 *
 * A static map rather than a template string: `t()` takes a closed key union,
 * so `t(\`source.type.${type}\`)` would not type-check and, worse, would break
 * silently if a key were missing.
 */
const TYPE_LABELS: Record<ResourceType, string> = {
  novel: '小说',
  comic: '漫画',
  audio: '听书',
  video: '视频',
}

const typeLabel = computed(() => TYPE_LABELS[props.item.type])

/** First character of the title, used in the placeholder tile. */
const initial = computed(() => props.item.title.trim().charAt(0) || '?')

const subtitle = computed(() => props.item.author ?? props.item.intro ?? '')
</script>

<template>
  <button class="card" type="button" @click="emit('open', item)">
    <span class="cover">
      <img
        v-if="item.cover && !coverFailed"
        class="cover-image"
        :src="item.cover"
        :alt="item.title"
        loading="lazy"
        referrerpolicy="no-referrer"
        @error="coverFailed = true"
      />
      <span v-else class="cover-fallback" aria-hidden="true">{{ initial }}</span>
    </span>

    <span class="body">
      <span class="title" :title="item.title">{{ item.title }}</span>
      <span class="meta">
        <!-- The resource kind is text, not a colored badge: the design system
             carries meaning with contrast and position, never hue. -->
        <span class="type">{{ typeLabel }}</span>
        <span v-if="subtitle" class="dot" aria-hidden="true">·</span>
        <span v-if="subtitle" class="subtitle" :title="subtitle">{{ subtitle }}</span>
      </span>
    </span>
  </button>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 0;
  text-align: left;
  border-radius: var(--radius-md);
  transition: transform var(--duration-fast) var(--ease-out);
}

.card:hover {
  transform: translateY(-2px);
}

.card:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.cover {
  position: relative;
  display: block;
  width: 100%;
  /* A fixed 3:4 ratio keeps the grid even regardless of what the site serves. */
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
  box-shadow: var(--shadow-e1);
}

.cover-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* A missing cover becomes a quiet tile with the title's first character, which
   still distinguishes one card from another. */
.cover-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: var(--text-2xl);
  font-weight: var(--weight-strong);
  color: var(--ink-tertiary);
  background: var(--surface-sunken);
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
  line-height: var(--leading-snug);
  /* Two lines maximum: a three-line title would break the grid's rhythm. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  min-width: 0;
}

.type {
  flex: none;
  font-weight: var(--weight-medium);
}

.dot {
  flex: none;
  color: var(--line-strong);
}

.subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
