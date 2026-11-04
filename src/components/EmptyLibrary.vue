<script setup lang="ts">
/**
 * The empty library state.
 *
 * This is the first thing anyone sees, so it carries three jobs: say what the
 * app is for, show the one action that starts it, and set expectations about
 * where files go. No illustration, no mascot — a quiet mark and real words.
 */
import { t } from '@/i18n'

defineProps<{ importing: boolean }>()
const emit = defineEmits<{ import: [] }>()
</script>

<template>
  <div class="empty">
    <div class="empty-inner">
      <!-- A single geometric mark, drawn from the same grayscale ladder. -->
      <svg
        class="empty-mark"
        width="56"
        height="56"
        viewBox="0 0 56 56"
        aria-hidden="true"
      >
        <rect x="6" y="4" width="30" height="38" rx="4" fill="var(--line-subtle)" />
        <rect x="12" y="10" width="30" height="38" rx="4" fill="var(--surface-raised)" stroke="var(--line-strong)" stroke-width="1.5" />
        <rect x="18" y="20" width="16" height="2.5" rx="1.25" fill="var(--ink-secondary)" />
        <rect x="18" y="27" width="20" height="2.5" rx="1.25" fill="var(--ink-tertiary)" />
        <rect x="18" y="34" width="12" height="2.5" rx="1.25" fill="var(--ink-tertiary)" />
      </svg>

      <h2 class="empty-title">{{ t('library.empty.title') }}</h2>
      <p class="empty-body">{{ t('library.empty.body') }}</p>

      <button
        class="btn btn--primary empty-action"
        type="button"
        :disabled="importing"
        @click="emit('import')"
      >
        {{ importing ? t('library.importing') : t('library.empty.action') }}
      </button>

      <p class="empty-hint">{{ t('library.empty.hint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6) var(--space-6) var(--space-9);
}

.empty-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* A deliberately narrow column: this block should feel like a sentence,
     not a section. */
  max-width: var(--measure-narrow);
  text-align: center;
}

.empty-mark {
  margin-bottom: var(--space-5);
}

.empty-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
  color: var(--ink-primary);
}

.empty-body {
  margin-top: var(--space-3);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--ink-secondary);
}

.empty-action {
  margin-top: var(--space-6);
}

.empty-hint {
  margin-top: var(--space-4);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}
</style>
