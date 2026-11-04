<script setup lang="ts">
/**
 * Export result strip.
 *
 * Same shape as `ImportFeedback`: one quiet line above the list, dismissible,
 * details on demand. Export is an action people repeat, so a modal would be an
 * interruption — but silence would be worse, because "did it work" is exactly
 * the question a file write leaves open.
 *
 * The numbers shown are the ones the backend reported. Nothing is rounded or
 * inferred, so a partial export never looks like a full one.
 */
import { computed, ref } from 'vue'
import { useExportStore } from '@/stores/export'
import { t } from '@/i18n'

const store = useExportStore()
const showDetails = ref(false)

const result = computed(() => store.result)
const visible = computed(() => result.value !== null)

const skippedCount = computed(() => result.value?.skipped.length ?? 0)
const partial = computed(() => skippedCount.value > 0)

const summary = computed(() => {
  const written = result.value?.written ?? 0
  if (!partial.value) return t('export.done', { count: written })
  return t('export.partial', { written, skipped: skippedCount.value })
})

function dismiss(): void {
  showDetails.value = false
  store.dismissResult()
}
</script>

<template>
  <div v-if="visible" class="feedback">
    <div class="feedback-line" :class="{ 'is-warning': partial }">
      <p class="feedback-text">{{ summary }}</p>
      <button
        v-if="partial"
        class="btn btn--tertiary details-toggle"
        type="button"
        :aria-expanded="showDetails"
        @click="showDetails = !showDetails"
      >
        {{ t('export.skippedMore') }}
      </button>
      <button
        class="btn btn--tertiary dismiss"
        type="button"
        :aria-label="t('common.close')"
        @click="dismiss"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.4" />
        </svg>
      </button>
    </div>

    <ul v-if="showDetails && partial" class="skip-list">
      <li v-for="(skip, index) in result?.skipped ?? []" :key="index" class="skip">
        <span class="skip-title">{{ skip.entry.title }}</span>
        <span class="skip-reason">{{ skip.reason }}</span>
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
  background: var(--surface-sunken);
}

/* A partial export is a warning, not a success: something the person asked for
   did not happen. */
.feedback-line.is-warning {
  background: var(--tone-warning-surface);
}

.feedback-text {
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.feedback-line.is-warning .feedback-text {
  color: var(--tone-warning);
}

.details-toggle {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--tone-warning);
}

.dismiss {
  color: var(--ink-tertiary);
  opacity: 0.6;
}

.dismiss:hover {
  opacity: 1;
  background: transparent;
  color: var(--ink-primary);
}

.skip-list {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.skip {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
}

.skip-title {
  font-size: var(--text-xs);
  color: var(--ink-secondary);
}

.skip-reason {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}
</style>
