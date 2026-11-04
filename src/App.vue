<script setup lang="ts">
/**
 * App shell.
 *
 * Layout is a sidebar plus one content region. The sidebar can collapse to a
 * 56px icon rail; when it does, the app looks like the original minimal build
 * — same components, same code path, just less chrome. That is deliberate:
 * "minimal mode" is a density of this shell, not a separate design to
 * maintain.
 *
 * The reader takes over the whole window (no sidebar) because reading is a
 * focused mode, not a section of the app.
 */
import { computed, onMounted, ref, watch } from 'vue'
import AppSidebar from '@/components/AppSidebar.vue'
import type { ShellSection } from '@/components/AppSidebar.vue'
import DashboardView from '@/views/DashboardView.vue'
import LibraryView from '@/views/LibraryView.vue'
import ReaderView from '@/views/ReaderView.vue'
import SourcesView from '@/views/SourcesView.vue'
import SourceBrowseView from '@/views/SourceBrowseView.vue'
import SourceDetailView from '@/views/SourceDetailView.vue'
import SourceReaderView from '@/views/SourceReaderView.vue'
import { useLibraryStore } from '@/stores/library'
import { useThemeStore } from '@/stores/theme'
import { registerBuiltinViewers } from '@/viewers/builtins'
import type { Entry } from '@/types/viewer'
import type { SourceChapter, SourceItem } from '@/sources/engine'

const COLLAPSE_KEY = 'litearti.sidebar-collapsed'

const store = useLibraryStore()
const theme = useThemeStore()

const section = ref<ShellSection>('dashboard')
const openId = ref<string | null>(null)

/**
 * Source navigation state.
 *
 * A small explicit set of refs rather than a router: the source section has
 * exactly four screens and one linear path (list → browse → detail → read), and
 * a router for that would be more machinery than the problem needs.
 */
const sourceId = ref<string | null>(null)
const sourceItem = ref<SourceItem | null>(null)
const sourceChapters = ref<SourceChapter[]>([])
const sourceChapter = ref<SourceChapter | null>(null)

/** Collapse state persists: a person who prefers the rail should keep it. */
const collapsed = ref(readCollapsed())

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0')
  } catch {
    // Preference persistence is best-effort.
  }
}

const openEntry = computed<Entry | null>(() => {
  if (!openId.value) return null
  return store.byId(openId.value) ?? null
})

/** Reading is full-window, so the sidebar hides while a reader is open. */
const showShell = computed(() => openEntry.value === null && sourceChapter.value === null)

async function open(entry: Entry): Promise<void> {
  openId.value = entry.id
  // Recording "opened" is fire-and-forget: it must never delay the viewer.
  void store.markOpened(entry.id)
}

function back(): void {
  openId.value = null
}

function navigate(next: ShellSection): void {
  openId.value = null
  section.value = next
  // Leaving the source section resets its stack, so returning always starts at
  // the source list rather than wherever the last visit ended.
  if (next !== 'sources') resetSourceNavigation()
}

function resetSourceNavigation(): void {
  sourceId.value = null
  sourceItem.value = null
  sourceChapters.value = []
  sourceChapter.value = null
}

function browseSource(id: string): void {
  sourceId.value = id
  sourceItem.value = null
  sourceChapter.value = null
}

function openSourceItem(item: SourceItem): void {
  sourceItem.value = item
  sourceChapter.value = null
}

function readSourceChapter(chapter: SourceChapter, chapters: SourceChapter[]): void {
  sourceChapters.value = chapters
  sourceChapter.value = chapter
}

/** Which source screen is showing, derived from the navigation state. */
const sourceScreen = computed<'list' | 'browse' | 'detail' | 'read'>(() => {
  if (sourceChapter.value) return 'read'
  if (sourceItem.value) return 'detail'
  if (sourceId.value) return 'browse'
  return 'list'
})

/** The dashboard's empty state sends people to the library to import. */
function goImport(): void {
  section.value = 'library'
}

/** Esc leaves a reader (local or source), matching the back button. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  // Let a viewer's own Escape handling win if it has a modal open.
  if (event.defaultPrevented) return
  if (openId.value) {
    back()
    return
  }
  if (sourceChapter.value) {
    sourceChapter.value = null
    return
  }
  if (sourceItem.value) {
    sourceItem.value = null
  }
}

// Opening a file from the dashboard should leave the dashboard selected
// underneath, so returning lands where the person started.
watch(openId, (id) => {
  if (id === null) return
})

onMounted(() => {
  registerBuiltinViewers()
  theme.init()
  void store.load()
  window.addEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="shell">
    <AppSidebar
      v-if="showShell"
      :section="section"
      :collapsed="collapsed"
      @navigate="navigate"
      @toggle-collapsed="toggleCollapsed"
    />

    <div class="content">
      <Transition name="fade" mode="out-in">
        <ReaderView
          v-if="openEntry"
          :key="openEntry.id"
          :entry="openEntry"
          @back="back"
        />
        <DashboardView
          v-else-if="section === 'dashboard'"
          key="dashboard"
          @open="open"
          @go-import="goImport"
        />
        <LibraryView v-else-if="section === 'library'" key="library" @open="open" />

        <!-- Source section. The reader takes the whole content area (no
             sidebar) for the same reason the local reader does: reading is a
             focused mode, not a section of the app. -->
        <SourceReaderView
          v-else-if="section === 'sources' && sourceScreen === 'read' && sourceChapter && sourceId"
          :key="`read-${sourceChapter.url}`"
          :source-id="sourceId"
          :chapters="sourceChapters"
          :chapter="sourceChapter"
          @back="sourceChapter = null"
        />
        <SourceDetailView
          v-else-if="section === 'sources' && sourceScreen === 'detail' && sourceItem && sourceId"
          :key="`detail-${sourceItem.detailUrl}`"
          :source-id="sourceId"
          :item="sourceItem"
          @back="sourceItem = null"
          @read="readSourceChapter"
        />
        <SourceBrowseView
          v-else-if="section === 'sources' && sourceScreen === 'browse' && sourceId"
          :key="`browse-${sourceId}`"
          :source-id="sourceId"
          @back="resetSourceNavigation"
          @open="openSourceItem"
          @switch-source="browseSource"
        />
        <SourcesView
          v-else-if="section === 'sources'"
          key="sources"
          @browse="browseSource"
        />
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--surface-page);
}

.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.content > * {
  flex: 1;
  min-height: 0;
}

/* A short cross-fade is enough; sliding panes would imply a spatial model
   that three screens don't have. */
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--duration-base) var(--ease-out);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
