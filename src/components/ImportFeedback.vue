<script setup lang="ts">
/**
 * Import feedback strip.
 *
 * Import is the one place where a partial failure is normal (one bad file in a
 * batch), so it reports quietly: a single line above the list, dismissible,
 * with details available on demand. It never blocks the list with a dialog.
 */
import { computed, ref, watch } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { t } from '@/i18n'

const store = useLibraryStore()
const showDetails = ref(false)
const dismissed = ref(false)

const failures = computed(() => store.lastFailures)
const hasFailures = computed(() => failures.value.length > 0)
const visible = computed(() => hasFailures.value && !dismissed.value)

// A later import must be able to re-open the strip, even if it fails the same
// way; otherwise one dismissal would silence every future failure report.
watch(
  () => store.lastFailures,
  () => {
    dismissed.value = false
    showDetails.value = false
  },
  { deep: true },
)

function dismiss(): void {
  dismissed.value = true
  showDetails.value = false
}
</script>

<template>
  <div v-if="visible" class="feedback">
    <div class="feedback-line">
      <p class="feedback-text">
        {{ t('library.failed', { count: failures.length }) }}
      </p>
      <button
        class="btn btn--tertiary details-toggle"
        type="button"
        :aria-expanded="showDetails"
        @click="showDetails = !showDetails"
      >
        {{ t('library.failedMore') }}
      </button>
      <button class="btn btn--tertiary dismiss" type="button" :aria-label="t('common.close')" @click="dismiss">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.4" />
        </svg>
      </button>
    </div>

    <ul v-if="showDetails" class="failure-list">
      <li v-for="failure in failures" :key="failure.sourcePath" class="failure">
        <span class="failure-path">{{ failure.sourcePath }}</span>
        <span class="failure-reason">{{ failure.reason }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.feedback {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--space-7) var(--space-3);
}

.feedback-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--tone-warning-surface);
}

.feedback-text {
  font-size: var(--text-sm);
  color: var(--tone-warning);
}

.details-toggle {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--tone-warning);
}

.dismiss {
  color: var(--tone-warning);
  opacity: 0.6;
}

.dismiss:hover {
  opacity: 1;
  background: transparent;
  color: var(--tone-warning);
}

.failure-list {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.failure {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
}

.failure-path {
  font-size: var(--text-xs);
  color: var(--ink-secondary);
  word-break: break-all;
}

.failure-reason {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}
</style>
