<script setup lang="ts">
/**
 * The app sidebar.
 *
 * It has exactly two widths: full (labels) and a 56px rail (icons only).
 * Collapsing to the rail is what makes "minimal mode" the same screen as the
 * full shell rather than a second design — there is one component and one
 * code path either way.
 *
 * Hierarchy inside the sidebar is carried by weight and a background step, not
 * by an accent color: the active item is the only one at full ink strength.
 */
import { t } from '@/i18n'

export type ShellSection = 'library' | 'sources' | 'discover' | 'settings'

const props = defineProps<{
  section: ShellSection
  collapsed: boolean
}>()

const emit = defineEmits<{
  navigate: [section: ShellSection]
  'toggle-collapsed': []
}>()
</script>

<template>
  <nav class="sidebar" :class="{ 'is-collapsed': props.collapsed }" :aria-label="t('nav.primary')">
    <!-- Brand row. The mark is the collapse-independent anchor of the shell. -->
    <div class="brand">
      <svg class="brand-mark" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2" y="2" width="11" height="14" rx="2" fill="currentColor" opacity="0.28" />
        <rect x="6" y="4" width="11" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
        <rect x="9" y="9" width="5" height="1.6" rx="0.8" fill="currentColor" />
        <rect x="9" y="12.5" width="3.5" height="1.6" rx="0.8" fill="currentColor" opacity="0.6" />
      </svg>
      <span v-if="!props.collapsed" class="brand-name">litearti</span>
    </div>

    <ul class="nav-list">
      <li>
        <button
          class="nav-item"
          type="button"
          :class="{ 'is-active': props.section === 'library' }"
          :aria-current="props.section === 'library' ? 'page' : undefined"
          :title="props.collapsed ? t('nav.library') : undefined"
          @click="emit('navigate', 'library')"
        >
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 3.5h12M2 8h12M2 12.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          <span v-if="!props.collapsed" class="nav-label">{{ t('nav.library') }}</span>
        </button>
      </li>

      <!-- The one section that reaches the network. Kept in the same nav list
           as the others because to the reader it is another place to find
           something to read, not a separate application. -->
      <li>
        <button
          class="nav-item"
          type="button"
          :class="{ 'is-active': props.section === 'sources' }"
          :aria-current="props.section === 'sources' ? 'page' : undefined"
          :title="props.collapsed ? t('nav.sources') : undefined"
          @click="emit('navigate', 'sources')"
        >
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M1.8 8h12.4M8 1.8c2 2 2 10.4 0 12.4M8 1.8c-2 2-2 10.4 0 12.4" fill="none" stroke="currentColor" stroke-width="1.2" />
          </svg>
          <span v-if="!props.collapsed" class="nav-label">{{ t('nav.sources') }}</span>
        </button>
      </li>

      <li>
        <button
          class="nav-item"
          type="button"
          :class="{ 'is-active': props.section === 'discover' }"
          :aria-current="props.section === 'discover' ? 'page' : undefined"
          :title="props.collapsed ? t('nav.discover') : undefined"
          @click="emit('navigate', 'discover')"
        >
          <!-- A compass: finding things you did not know you wanted, as opposed to
               the globe (sources) which is where you look for a specific title. -->
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path
              d="M10.6 5.4L9 9 5.4 10.6 7 7z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linejoin="round"
            />
          </svg>
          <span v-if="!props.collapsed" class="nav-label">{{ t('nav.discover') }}</span>
        </button>
      </li>

      <li>
        <button
          class="nav-item"
          type="button"
          :class="{ 'is-active': props.section === 'settings' }"
          :aria-current="props.section === 'settings' ? 'page' : undefined"
          :title="props.collapsed ? t('nav.settings') : undefined"
          @click="emit('navigate', 'settings')"
        >
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path
              d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
          </svg>
          <span v-if="!props.collapsed" class="nav-label">{{ t('nav.settings') }}</span>
        </button>
      </li>
    </ul>

    <!-- Bottom cluster: only the collapse control now. The theme moved into
         Settings, where a person goes looking for appearance instead of finding it
         tucked under navigation. -->
    <div class="sidebar-foot">
      <button
        class="nav-item collapse-item"
        type="button"
        :title="props.collapsed ? t('nav.expand') : t('nav.collapse')"
        :aria-label="props.collapsed ? t('nav.expand') : t('nav.collapse')"
        :aria-expanded="!props.collapsed"
        @click="emit('toggle-collapsed')"
      >
        <svg
          class="nav-icon chevron"
          :class="{ 'is-flipped': props.collapsed }"
          width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
        >
          <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span v-if="!props.collapsed" class="nav-label">{{ t('nav.collapse') }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  flex: none;
  width: var(--sidebar-width);
  height: 100%;
  padding: var(--space-3) var(--space-2) var(--space-2);
  /* A one-step background difference is enough to separate the rail from the
     content. No border: a vertical rule here would read as a hard split. */
  background: var(--surface-sunken);
  transition: width var(--duration-base) var(--ease-out);
  overflow: hidden;
}

.sidebar.is-collapsed {
  width: var(--sidebar-rail);
}

/* --- Brand -------------------------------------------------------------- */

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-lg);
  padding: 0 var(--space-2);
  margin-bottom: var(--space-5);
  color: var(--ink-primary);
  flex: none;
}

.brand-mark {
  flex: none;
}

.brand-name {
  font-size: var(--text-base);
  font-weight: var(--weight-strong);
  letter-spacing: -0.01em;
  white-space: nowrap;
}

/* --- Navigation --------------------------------------------------------- */

.nav-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: none;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  height: var(--sidebar-item-height);
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--ink-secondary);
  font-size: var(--text-sm);
  white-space: nowrap;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.nav-item:hover {
  background: var(--surface-hover);
  color: var(--ink-primary);
}

/* Active is the only full-strength item. No pill, no accent hue — the
   contrast step alone marks it. */
.nav-item.is-active {
  background: var(--surface-raised);
  color: var(--ink-primary);
  font-weight: var(--weight-medium);
  box-shadow: var(--shadow-e1);
}

.nav-icon {
  flex: none;
}

.nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Rail mode centres the single icon that remains. */
.sidebar.is-collapsed .nav-item {
  justify-content: center;
  padding: 0;
}

/* --- Footer ------------------------------------------------------------- */

.sidebar-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: none;
}

.theme-item {
  color: var(--ink-tertiary);
}

.collapse-item {
  color: var(--ink-tertiary);
}

.chevron {
  transition: transform var(--duration-base) var(--ease-out);
}

.chevron.is-flipped {
  transform: rotate(180deg);
}
</style>
