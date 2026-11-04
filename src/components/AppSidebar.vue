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
import { computed } from 'vue'
import { t } from '@/i18n'
import { useThemeStore } from '@/stores/theme'
import type { ThemeChoice } from '@/stores/theme'

export type ShellSection = 'dashboard' | 'library' | 'sources'

const props = defineProps<{
  section: ShellSection
  collapsed: boolean
}>()

const emit = defineEmits<{
  navigate: [section: ShellSection]
  'toggle-collapsed': []
}>()

const theme = useThemeStore()

const themeLabel = computed(() => {
  const map: Record<ThemeChoice, string> = {
    light: t('theme.light'),
    dark: t('theme.dark'),
    system: t('theme.system'),
  }
  return map[theme.choice]
})

/** One icon per state, so the control's current value is legible at a glance. */
const themeIcon = computed(() => theme.choice)
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
          :class="{ 'is-active': props.section === 'dashboard' }"
          :aria-current="props.section === 'dashboard' ? 'page' : undefined"
          :title="props.collapsed ? t('nav.dashboard') : undefined"
          @click="emit('navigate', 'dashboard')"
        >
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="1.5" width="5.5" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4" />
            <rect x="9" y="1.5" width="5.5" height="4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4" />
            <rect x="1.5" y="10.5" width="5.5" height="4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4" />
            <rect x="9" y="7.5" width="5.5" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
          <span v-if="!props.collapsed" class="nav-label">{{ t('nav.dashboard') }}</span>
        </button>
      </li>

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
    </ul>

    <!-- Bottom cluster: theme and the collapse control live together, away
         from navigation, because neither changes which screen you are on. -->
    <div class="sidebar-foot">
      <button
        class="nav-item theme-item"
        type="button"
        :title="props.collapsed ? `${t('theme.label')}：${themeLabel}` : undefined"
        @click="theme.cycle()"
      >
        <svg v-if="themeIcon === 'light'" class="nav-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3 3l1.3 1.3M11.7 11.7L13 13M13 3l-1.3 1.3M4.3 11.7L3 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <svg v-else-if="themeIcon === 'dark'" class="nav-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13.5 9.5A5.8 5.8 0 016.5 2.5a5.8 5.8 0 107 7z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
        <svg v-else class="nav-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 2.4v11.2" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 2.4a5.6 5.6 0 010 11.2z" fill="currentColor" />
        </svg>
        <span v-if="!props.collapsed" class="nav-label">{{ themeLabel }}</span>
      </button>

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
