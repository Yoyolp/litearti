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
import { t } from '@/i18n'
import AppSidebar from '@/components/AppSidebar.vue'
import type { ShellSection } from '@/components/AppSidebar.vue'
import SettingsView from '@/views/SettingsView.vue'
import DiscoverView from '@/views/DiscoverView.vue'
import LibraryView from '@/views/LibraryView.vue'
import ReaderView from '@/views/ReaderView.vue'
import SourcesView from '@/views/SourcesView.vue'
import SourceBrowseView from '@/views/SourceBrowseView.vue'
import SourceDetailView from '@/views/SourceDetailView.vue'
import SourceReaderView from '@/views/SourceReaderView.vue'
import SourceEditorView from '@/views/SourceEditorView.vue'
import SourceTrialView from '@/views/SourceTrialView.vue'
import SourceAggregateView from '@/views/SourceAggregateView.vue'
import AnimeDetailView from '@/views/AnimeDetailView.vue'
import AnimePlayerView from '@/views/AnimePlayerView.vue'
import type { ResourceType } from '@/sources/schema'
import { SourceEngine, type VideoEpisode } from '@/sources/engine'
import { useSourcesStore } from '@/stores/sources'
import * as api from '@/api/library'
import { findExactMatch } from '@/library/rematch'
import { savePlaybackProgress, loadPlaybackProgress } from '@/sources/playbackProgress'
import { useLibraryStore } from '@/stores/library'
import { useThemeStore } from '@/stores/theme'
import { registerBuiltinViewers } from '@/viewers/builtins'
import type { Entry } from '@/types/viewer'
import type { SourceChapter, SourceItem } from '@/sources/engine'

const COLLAPSE_KEY = 'litearti.sidebar-collapsed'

const store = useLibraryStore()
const theme = useThemeStore()
/** Needed to resolve an online entry's source, and to re-match across sources. */
const sources = useSourcesStore()

const section = ref<ShellSection>('library')
const openId = ref<string | null>(null)

/** Entry id currently being re-matched, so its row can say so instead of hanging. */
const rematching = ref<string | null>(null)
/** The last re-match that happened, for the reversible strip. */
const rematchNotice = ref<{
  entryId: string
  previous: NonNullable<Entry['reference']>
  sourceName: string
} | null>(null)
/** Entry id that could not be opened because no source had it. */
const brokenNotice = ref<string | null>(null)

/**
 * Source navigation state.
 *
 * A small explicit set of refs rather than a router: the source section has a
 * handful of screens on a mostly linear path, and a router for that would be more
 * machinery than the problem needs.
 *
 * The editor, trial-run and aggregate screens are **modes**, not stack entries.
 * They replace the whole section rather than pushing onto it: you finish editing
 * a source and go back to the list you came from, you do not go "back" through an
 * editor you already saved.
 */
const sourceId = ref<string | null>(null)
const sourceItem = ref<SourceItem | null>(null)
const sourceChapters = ref<SourceChapter[]>([])
const sourceChapter = ref<SourceChapter | null>(null)

/** Which non-stack source screen is open, if any. */
const sourceMode = ref<'none' | 'editor' | 'trial' | 'aggregate'>('none')
/** Source being edited; null means "new source". */
const editingId = ref<string | null>(null)
/** Source being trial-run. */
const trialId = ref<string | null>(null)
/** Which type the aggregate search was opened for. */
const aggregateType = ref<ResourceType | null>(null)

/**
 * Video playback state.
 *
 * The player is a **mode**, like the reader: it takes the whole window with no
 * sidebar, because watching is a focused activity, not a section of the app.
 * Keeping the episode list in `videoEpisodes` (rather than re-deriving it) is what
 * makes "play next" possible without another network round trip.
 */
const playingEpisode = ref<VideoEpisode | null>(null)
const videoEpisodes = ref<VideoEpisode[]>([])
const videoRoadIndex = ref(0)
/** Media URL for the current episode, resolved before the player mounts. */
const playingMediaUrl = ref<string | null>(null)
const resolvingMedia = ref(false)
const resolveError = ref<string | null>(null)

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
const showShell = computed(
  () =>
    openEntry.value === null &&
    sourceChapter.value === null &&
    playingEpisode.value === null,
)

async function open(entry: Entry): Promise<void> {
  // An online entry opens its show, not a file: the source detail screen is the
  // right destination, and it can also run the re-match when the source is gone.
  if (entry.kind === 'online') {
    await openOnlineEntry(entry)
    return
  }
  openId.value = entry.id
  // Recording "opened" is fire-and-forget: it must never delay the viewer.
  void store.markOpened(entry.id)
}

/**
 * Open a title that lives on a source.
 *
 * Three cases, in order:
 *
 * 1. The source is present → show its detail page directly.
 * 2. The source is gone → search the other enabled sources for an exact title match.
 *    Silence on a hit: the click already expressed the intent, and a confirmation
 *    dialog for "we found the same show elsewhere" is friction on the common path.
 *    A strip is shown afterwards so a wrong match can be undone.
 * 3. Nothing matches → show the entry as broken, with the site button still usable.
 */
async function openOnlineEntry(entry: Entry): Promise<void> {
  const reference = entry.reference
  if (!reference) return

  const direct = sources.byId(reference.sourceId)
  if (direct && direct.enabled) {
    void store.markOpened(entry.id)
    switchToSource(direct.id, { detailUrl: reference.detailUrl, title: entry.title })
    return
  }

  rematching.value = entry.id
  try {
    const match = await findOnOtherSources(entry.title)
    if (match) {
      const updated = await api.rematchOnline(entry.id, {
        sourceId: match.sourceId,
        sourceName: match.sourceName,
        detailUrl: match.detailUrl,
        cover: match.cover ?? null,
        episodeCount: match.episodeCount ?? null,
        invalid: false,
      })
      store.replace(updated)
      // Layout-shifting and reversible rather than a modal: the entry already
      // switched, so the only honest thing left is to say so and offer the way back.
      rematchNotice.value = { entryId: entry.id, previous: reference, sourceName: match.sourceName }
      switchToSource(match.sourceId, { detailUrl: match.detailUrl, title: entry.title })
      return
    }
    // No match: leave the entry as it is and say why nothing opened.
    rematchNotice.value = null
    brokenNotice.value = entry.id
  } catch (cause) {
    rematchNotice.value = null
    brokenNotice.value = entry.id
    void cause
  } finally {
    rematching.value = null
  }
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
  sourceMode.value = 'none'
  editingId.value = null
  trialId.value = null
  aggregateType.value = null
  closePlayer()
}

/** The source currently playing, for the player's header and headers. */
const playingSource = computed(() => {
  const id = sourceId.value
  if (!id) return undefined
  return useSourcesStore().byId(id)
})

/** Header values the origin expects, read once per render. */
const playingHeaders = computed(() => playingSource.value?.request.headers ?? {})

/**
 * Whether the currently opened source is a video source.
 *
 * Decides which detail page renders. Read from the source rather than from the
 * item, because an item from a search carries a `type` too — but that one comes
 * from the search result and could disagree with the stored source after an edit.
 */
const sourceDetailIsVideo = computed(() => {
  const id = sourceId.value
  if (!id) return false
  return useSourcesStore().byId(id)?.type === 'video'
})

/**
 * Resume position for the current episode.
 *
 * Read at mount time rather than passed reactively: the player only needs it once,
 * and re-reading it on every progress save would fight the write it just made.
 */
const resumeAt = computed(() => {
  const episode = playingEpisode.value
  const id = sourceId.value
  if (!episode || !id) return 0
  return loadPlaybackProgress(id, episode.url)?.position ?? 0
})

function onPlayerProgress(seconds: number, duration: number): void {
  const episode = playingEpisode.value
  const id = sourceId.value
  if (!episode || !id) return
  savePlaybackProgress(id, episode.url, seconds, duration)
}

/**
 * Resolve an episode's media URL, then open the player.
 *
 * The resolution happens **here** rather than inside the player so the failure has
 * somewhere to show: resolving needs the source engine (and its sandbox), and the
 * player deliberately knows nothing about sources — it takes a URL. Doing it on
 * this side also means the error can name the reason instead of leaving the player
 * to report a generic "cannot play".
 */
async function playEpisode(
  episode: VideoEpisode,
  episodes: VideoEpisode[],
  roadIndex: number,
): Promise<void> {
  const id = sourceId.value
  const source = id ? useSourcesStore().byId(id) : undefined
  if (!id || !source) return

  videoEpisodes.value = episodes
  videoRoadIndex.value = roadIndex
  resolvingMedia.value = true
  resolveError.value = null
  playingMediaUrl.value = null

  const engine = new SourceEngine(source)
  try {
    playingMediaUrl.value = await engine.episodeVideoUrl(episode.url)
    playingEpisode.value = episode
  } catch (cause) {
    resolveError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    resolvingMedia.value = false
    engine.dispose()
  }
}

function closePlayer(): void {
  playingEpisode.value = null
  playingMediaUrl.value = null
  videoEpisodes.value = []
  videoRoadIndex.value = 0
  resolveError.value = null
}

/** Put the entry back on its original source after a re-match. */
async function undoRematch(): Promise<void> {
  const notice = rematchNotice.value
  if (!notice) return
  rematchNotice.value = null
  try {
    // One write, with the flag already set. The source it goes back to is still the
    // broken one, so the entry has to keep saying so — restoring it as healthy would
    // make it look openable and then fail again on the next click.
    const restored = await api.rematchOnline(notice.entryId, {
      ...notice.previous,
      invalid: true,
    })
    store.replace(restored)
  } catch {
    // Nothing to restore to; the entry keeps its new source, which still works.
  }
}

/** Play the next episode in the list, if there is one. */
function playNextEpisode(): void {
  const current = playingEpisode.value
  if (!current) return
  const index = videoEpisodes.value.findIndex((e) => e.url === current.url)
  const next = index >= 0 ? videoEpisodes.value[index + 1] : undefined
  if (!next) return
  void playEpisode(next, videoEpisodes.value, videoRoadIndex.value)
}

function browseSource(id: string): void {
  sourceId.value = id
  sourceItem.value = null
  sourceChapter.value = null
  closePlayer()
}

function openSourceItem(item: SourceItem): void {
  sourceItem.value = item
  sourceChapter.value = null
}

/**
 * Jump from a discovered subject to its page on a source.
 *
 * The discover screen has already done the matching and picked the best result, so
 * this only has to put the app on that source's detail screen. It reuses the same
 * path as the library's online entries, which keeps one way of arriving at a source
 * detail page instead of two.
 */
function openFromDiscover(payload: { sourceId: string; detailUrl: string; title: string }): void {
  switchToSource(payload.sourceId, { detailUrl: payload.detailUrl, title: payload.title })
}

/** Open an item from the aggregate view: switch source, then show its detail. */
function openFromAggregate(id: string, item: SourceItem): void {
  sourceId.value = id
  sourceMode.value = 'none'
  sourceItem.value = item
  sourceChapter.value = null
}

/**
 * Jump to a source's detail screen for one title.
 *
 * Builds a minimal `SourceItem` rather than fetching it first: the detail screen
 * already loads by URL, so fetching here would do the same request twice and add a
 * wait before anything appears.
 */
function switchToSource(id: string, item: { detailUrl: string; title: string }): void {
  section.value = 'sources'
  sourceMode.value = 'none'
  sourceId.value = id
  sourceItem.value = {
    title: item.title,
    detailUrl: item.detailUrl,
    author: null,
    cover: null,
    intro: null,
  } as SourceItem
  sourceChapter.value = null
  closePlayer()
}

/** What a re-match found on another source. */
interface RematchHit {
  sourceId: string
  sourceName: string
  detailUrl: string
  cover?: string | null
  episodeCount?: number | null
}

/**
 * Search every other enabled video source for an exact title match.
 *
 * Sequential rather than concurrent on purpose: this runs when someone opens a
 * broken entry, and firing ten searches at ten sites at once to answer one question
 * is rude to those sites and slow to cancel. Stopping at the first exact match also
 * means the usual case does one request, not ten.
 *
 * Searches fail independently — one site being down must not stop the search.
 */
async function findOnOtherSources(title: string): Promise<RematchHit | null> {
  const candidates = sources.sources.filter(
    (source) => source.enabled && source.type === 'video',
  )
  for (const source of candidates) {
    try {
      // The default fetcher is the app's own network path; passing one here would
      // only duplicate what the engine already defaults to.
      const engine = new SourceEngine(source)
      const result = await engine.search(title)
      const hit = findExactMatch(title, result)
      if (hit) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          detailUrl: hit.detailUrl,
          cover: hit.cover ?? null,
          episodeCount: null,
        }
      }
    } catch {
      // This source could not answer; the next one might.
    }
  }
  return null
}

function openAggregate(): void {
  sourceMode.value = 'aggregate'
  aggregateType.value = null
}

function openEditor(id: string | null): void {
  editingId.value = id
  sourceMode.value = 'editor'
}

function openTrial(id: string): void {
  trialId.value = id
  sourceMode.value = 'trial'
}

function closeSourceMode(): void {
  sourceMode.value = 'none'
  editingId.value = null
  trialId.value = null
  aggregateType.value = null
}

/** After saving a source, return to the list it came from. */
function onSourceSaved(): void {
  closeSourceMode()
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

/** Esc leaves a reader (local or source), matching the back button. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  // Let a viewer's own Escape handling win if it has a modal open.
  if (event.defaultPrevented) return
  if (openId.value) {
    back()
    return
  }
  // A source mode closes before the stack beneath it does: Esc out of an editor
  // should return to the list, not jump out of the section.
  if (playingEpisode.value) {
    closePlayer()
    return
  }
  if (sourceMode.value !== 'none') {
    closeSourceMode()
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
      <!-- A persistent strip, never a toast: the design system has no toast, and a
           message that disappears on its own cannot be acted on. This one reports a
           re-match and offers the way back for as long as it is relevant. -->
      <div v-if="rematchNotice" class="global-notice" role="status">
        <span class="global-notice-text">
          {{
            t('library.online.rematched', { name: rematchNotice.sourceName })
          }}
        </span>
        <button class="btn btn--tertiary global-notice-action" type="button" @click="undoRematch()">
          {{ t('library.online.rematchUndo') }}
        </button>
        <button
          class="global-notice-close"
          type="button"
          :aria-label="t('common.dismiss')"
          @click="rematchNotice = null"
        >
          ×
        </button>
      </div>

      <div v-else-if="brokenNotice" class="global-notice" role="status">
        <span class="global-notice-text">{{ t('library.online.notFound') }}</span>
        <button
          class="global-notice-close"
          type="button"
          :aria-label="t('common.dismiss')"
          @click="brokenNotice = null"
        >
          ×
        </button>
      </div>
      <Transition name="fade" mode="out-in">
        <!-- The player takes precedence over everything: it is a focused mode,
             and it must not be unmounted by a section change happening behind it. -->
        <AnimePlayerView
          v-if="playingEpisode && playingMediaUrl && sourceId"
          :key="playingEpisode.url"
          :media-url="playingMediaUrl"
          :referer="playingHeaders.Referer ?? playingHeaders.referer ?? null"
          :user-agent="playingHeaders['User-Agent'] ?? playingHeaders['user-agent'] ?? null"
          :title="playingEpisode.title"
          :source-name="playingSource?.name ?? ''"
          :start-at="resumeAt"
          :on-progress="onPlayerProgress"
          :on-ended="playNextEpisode"
        />

        <!-- Resolving a media URL is visible: it is a network round trip and can
             fail, and a silent wait would look like a dead click. -->
        <div v-else-if="resolvingMedia || resolveError" class="player-gate">
          <p v-if="resolvingMedia" class="gate-text">{{ t('player.loading') }}</p>
          <template v-else>
            <p class="gate-title">{{ t('player.error.title') }}</p>
            <p class="gate-text">{{ resolveError }}</p>
            <button class="btn btn--secondary" type="button" @click="closePlayer">
              {{ t('common.close') }}
            </button>
          </template>
        </div>

        <ReaderView
          v-else-if="openEntry"
          :key="openEntry.id"
          :entry="openEntry"
          @back="back"
        />
        <LibraryView v-else-if="section === 'library'" key="library" @open="open" />
        <DiscoverView
          v-else-if="section === 'discover'"
          key="discover"
          @open="openFromDiscover"
        />
        <SettingsView v-else-if="section === 'settings'" key="settings" />

        <!-- Source modes replace the section rather than stacking on it: an
             editor or a trial run is a detour from the source list, and finishing
             it returns there. -->
        <SourceEditorView
          v-else-if="section === 'sources' && sourceMode === 'editor'"
          :key="`editor-${editingId ?? 'new'}`"
          :source-id="editingId"
          @saved="onSourceSaved"
          @cancel="closeSourceMode"
        />
        <SourceTrialView
          v-else-if="section === 'sources' && sourceMode === 'trial' && trialId"
          :key="`trial-${trialId}`"
          :source-id="trialId"
          @back="closeSourceMode"
        />
        <SourceAggregateView
          v-else-if="section === 'sources' && sourceMode === 'aggregate'"
          key="aggregate"
          :type="aggregateType"
          @open="openFromAggregate"
          @switch-source="browseSource"
        />

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
        <!-- A video source gets its own detail page: episodes grouped into lines
             are a different shape from a flat chapter list, and one page trying to
             serve both would branch on type at every field. -->
        <AnimeDetailView
          v-else-if="section === 'sources' && sourceScreen === 'detail' && sourceItem && sourceDetailIsVideo"
          :key="`video-${sourceItem.detailUrl}`"
          :source-id="sourceId!"
          :item="sourceItem"
          @back="sourceItem = null"
          @play="playEpisode"
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
          @aggregate="openAggregate"
          @edit="openEditor"
          @create="openEditor(null)"
          @trial="openTrial"
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

/* --- Notice strip -------------------------------------------------------
   A persistent row rather than a toast: a message that disappears on its own
   cannot be acted on, and the design system has no toast for that reason. It
   sits above the content and pushes it down, which is honest about taking up
   attention. */
.global-notice {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--content-pad);
  background: var(--surface-sunken);
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.global-notice-text {
  flex: 1;
  min-width: 0;
}

.global-notice-action {
  flex: none;
}

.global-notice-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  font-size: var(--text-md);
  line-height: 1;
  color: var(--ink-tertiary);
  border-radius: var(--radius-sm);
}

.global-notice-close:hover {
  background: var(--surface-hover);
  color: var(--ink-primary);
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
