<script setup lang="ts">
/**
 * The reading screen: a thin header plus whatever viewer claimed the file.
 *
 * The header is intentionally minimal — a back affordance and the title. It
 * exists to answer "where am I and how do I leave", nothing else. Any control
 * that belongs to reading lives inside the viewer, next to the content it
 * affects, so the header never becomes a second toolbar.
 */
import { computed, ref, watch } from 'vue'
import { t } from '@/i18n'
import { extensionLabel, formatSize } from '@/utils/format'
import { resolveViewer } from '@/viewers/registry'
import { viewerHost } from '@/viewers/host'
import type { Entry, ViewerDescriptor } from '@/types/viewer'

const props = defineProps<{ entry: Entry }>()
const emit = defineEmits<{ back: [] }>()

const viewer = ref<ViewerDescriptor | null>(null)
const resolving = ref(true)
const resolveError = ref<string | null>(null)

async function resolve(): Promise<void> {
  resolving.value = true
  resolveError.value = null
  viewer.value = null
  try {
    viewer.value = await resolveViewer(props.entry, () =>
      viewerHost.readBinary(props.entry.id),
    )
  } catch (cause) {
    resolveError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    resolving.value = false
  }
}

const hasExtension = computed(() => props.entry.extension.length > 0)

watch(() => props.entry.id, () => void resolve(), { immediate: true })
</script>

<template>
  <div class="reader">
    <header class="reader-header">
      <button class="btn btn--tertiary back" type="button" @click="emit('back')">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M9 2L4 7l5 5" fill="none" stroke="currentColor" stroke-width="1.6" />
        </svg>
        {{ t('viewer.back') }}
      </button>

      <div class="identity">
        <h1 class="reader-title">{{ entry.title }}</h1>
        <p class="reader-meta">
          {{ extensionLabel(entry.extension) }}
          <span class="dot" aria-hidden="true">·</span>
          {{ formatSize(entry.size) }}
        </p>
      </div>
    </header>

    <main class="reader-body">
      <div v-if="resolving" class="state">{{ t('common.loading') }}</div>

      <div v-else-if="resolveError" class="state">
        <p class="state-title">{{ t('viewer.error.title') }}</p>
        <p class="state-body">{{ resolveError }}</p>
        <button class="btn btn--secondary" type="button" @click="resolve">
          {{ t('common.retry') }}
        </button>
      </div>

      <!-- Unknown format is an empty state, not an error: it's a normal
           situation, and the copy explains how to add support. -->
      <div v-else-if="!viewer" class="state">
        <p class="state-title">{{ t('viewer.missing.title') }}</p>
        <p class="state-body">
          {{
            hasExtension
              ? t('viewer.missing.body', { ext: entry.extension })
              : t('viewer.missing.noExt')
          }}
        </p>
      </div>

      <component :is="viewer.component" v-else :entry="entry" :host="viewerHost" />
    </main>
  </div>
</template>

<style scoped>
.reader {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.reader-header {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex: none;
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--line-subtle);
  background: var(--surface-page);
}

.back {
  flex: none;
  gap: var(--space-1);
  font-size: var(--text-sm);
}

.identity {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}

.reader-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reader-meta {
  flex: none;
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.dot {
  color: var(--line-strong);
}

.reader-body {
  flex: 1;
  min-height: 0;
  position: relative;
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  height: 100%;
  padding: var(--space-6);
  text-align: center;
  color: var(--ink-secondary);
}

.state-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  color: var(--ink-primary);
}

.state-body {
  max-width: 46ch;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ink-secondary);
}
</style>
