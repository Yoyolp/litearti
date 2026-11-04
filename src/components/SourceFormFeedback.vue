<script setup lang="ts">
/**
 * Validation feedback for a book source import.
 *
 * A source is hand-written JSON, so a failed import is the normal first
 * outcome. The validator reports every issue with a dotted field path; this
 * component's job is to make that list scannable rather than alarming — the
 * message says what to fix, not that something is "invalid".
 */
import { computed } from 'vue'
import { t } from '@/i18n'
import type { ValidationIssue } from '@/sources/schema'

const props = defineProps<{ issues: ValidationIssue[] }>()
const emit = defineEmits<{ dismiss: [] }>()

const visible = computed(() => props.issues.length > 0)

/** Group by top-level field so a source with six problems in `search` reads as
 *  one block instead of six unrelated lines. */
const grouped = computed(() => {
  const groups = new Map<string, ValidationIssue[]>()
  for (const issue of props.issues) {
    const key = issue.path.split('.')[0] || '（根）'
    const list = groups.get(key)
    if (list) list.push(issue)
    else groups.set(key, [issue])
  }
  return [...groups.entries()]
})
</script>

<template>
  <div v-if="visible" class="feedback">
    <div class="feedback-line">
      <p class="feedback-text">{{ t('source.issues', { count: issues.length }) }}</p>
      <button
        class="btn btn--tertiary dismiss"
        type="button"
        :aria-label="t('common.close')"
        @click="emit('dismiss')"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.4" />
        </svg>
      </button>
    </div>

    <div v-for="[group, list] in grouped" :key="group" class="issue-group">
      <p class="issue-group-name">{{ group }}</p>
      <ul class="issue-list">
        <li v-for="(issue, index) in list" :key="index" class="issue">
          <!-- The path is the actionable part: it names the exact field. -->
          <code class="issue-path">{{ issue.path || '根' }}</code>
          <span class="issue-message">{{ issue.message }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.feedback {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
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

.dismiss {
  margin-left: auto;
  color: var(--tone-warning);
  opacity: 0.6;
}

.dismiss:hover {
  opacity: 1;
  background: transparent;
  color: var(--tone-warning);
}

.issue-group {
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
}

.issue-group-name {
  font-size: var(--text-xs);
  font-weight: var(--weight-strong);
  color: var(--ink-secondary);
  margin-bottom: var(--space-1);
}

.issue-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.issue {
  display: flex;
  gap: var(--space-2);
  align-items: baseline;
  font-size: var(--text-xs);
  line-height: var(--leading-snug);
}

.issue-path {
  flex: none;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  color: var(--ink-secondary);
  user-select: text;
}

.issue-message {
  color: var(--ink-tertiary);
}
</style>
