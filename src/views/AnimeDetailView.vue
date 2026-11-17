<script setup lang="ts">
/**
 * Video source detail: metadata, playback lines, episodes.
 *
 * The shape differs from the book detail page in one important way: episodes are
 * grouped into **lines** (线路). A site usually offers the same show from several
 * upstream providers, each with its own episode list and its own reliability. So
 * the line picker is the primary control here — choosing a line changes which
 * episodes exist.
 *
 * ## Saying what will not work
 *
 * Most real anime sources resolve their media URL through a third-party player or
 * an obfuscated iframe, which needs a browser to sniff. This app does not do that
 * (see `docs/kazumi-community-sources.md`). Rather than let a person pick an
 * episode and get a black screen, the page probes one episode up front and warns
 * when the source looks unplayable. That costs one request and saves a confusing
 * failure.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { t } from '@/i18n'
import { useSourcesStore } from '@/stores/sources'
import { useLibraryStore } from '@/stores/library'
import { SourceEngine, type SourceItem, type VideoDetail } from '@/sources/engine'
import { SelectorError } from '@/sources/selector'
import type { VideoEpisode } from '@/sources/engine'
import * as api from '@/api/library'

const props = defineProps<{
  sourceId: string
  item: SourceItem
}>()

const emit = defineEmits<{
  back: []
  play: [episode: VideoEpisode, episodes: VideoEpisode[], roadIndex: number]
}>()

const store = useSourcesStore()
/** Adding a title writes through the backend, so the store must learn about it. */
const library = useLibraryStore()
const detail = ref<VideoDetail | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const coverFailed = ref(false)
const roadIndex = ref(0)
const sandboxMount = ref<HTMLElement | null>(null)
const engine = shallowRef<SourceEngine | null>(null)

/**
 * Whether this source can actually produce a media URL.
 *
 * `null` while unknown — the probe is one network request, so it must not block
 * rendering the episode list. The list is useful even when playback will fail,
 * because it tells a person how many episodes exist.
 */
const playable = ref<boolean | null>(null)
const probeMessage = ref<string | null>(null)
/** True while a sniff is running, so the ten-second wait is not silent. */
const probing = ref(false)

const source = computed(() => store.byId(props.sourceId))
const roads = computed(() => detail.value?.roads ?? [])
const currentRoad = computed(() => roads.value[roadIndex.value] ?? null)
const episodes = computed(() => currentRoad.value?.episodes ?? [])

function ensureEngine(): SourceEngine | null {
  const current = source.value
  if (!current) return null
  if (engine.value) return engine.value
  engine.value = new SourceEngine(current, undefined, sandboxMount.value ?? undefined)
  return engine.value
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  playable.value = null
  probeMessage.value = null
  try {
    const active = ensureEngine()
    if (!active) throw new Error('源不存在')
    detail.value = await active.videoDetail(props.item.detailUrl)
    // Default to the line with the most episodes: a site's first line is often a
    // dead one, and the fullest list is the best guess at "the real one".
    roadIndex.value = pickBestRoad(detail.value)
    void probePlayback(active)
  } catch (cause) {
    error.value =
      cause instanceof SelectorError
        ? `选择器有问题：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : String(cause)
  } finally {
    loading.value = false
  }
}

function pickBestRoad(value: VideoDetail): number {
  let best = 0
  let bestCount = -1
  value.roads.forEach((road, index) => {
    if (road.episodes.length > bestCount) {
      bestCount = road.episodes.length
      best = index
    }
  })
  return best
}

/**
 * Try to resolve the first episode's media URL, once.
 *
 * The result is *only* used to warn. A failure here does not break the page: the
 * episode list stays usable, and the person can still open the source's own site to
 * watch. That is a better outcome than hiding the list behind an error.
 *
 * When the source uses `sniff` this takes ten seconds or more, because the
 * collector deliberately waits to gather every candidate instead of taking the
 * first one. So the wait is announced — a silent ten-second pause reads as a hang.
 */
async function probePlayback(active: SourceEngine): Promise<void> {
  const first = detail.value?.roads.flatMap((road) => road.episodes)[0]
  if (!first) return
  const isSniffing = source.value?.video?.playback.kind === 'sniff'
  if (isSniffing) probing.value = true
  try {
    await active.episodeVideoUrl(first.url)
    playable.value = true
  } catch (cause) {
    playable.value = false
    probeMessage.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    probing.value = false
  }
}

function playEpisode(episode: VideoEpisode): void {
  emit('play', episode, episodes.value, roadIndex.value)
}

/** True while the add request is in flight, so the button cannot double-fire. */
const adding = ref(false)
/** True once this title is in the library. */
const added = ref(false)

/**
 * Add this title to the library as a reference.
 *
 * Stores the source id, its display name, the detail URL and the episode count —
 * no file, no copy. The source name is captured now rather than looked up later so
 * that a deleted source can still be named in the library instead of showing an
 * id nobody recognises.
 */
async function addToLibrary(): Promise<void> {
  if (adding.value || added.value) return
  const current = source.value
  const info = detail.value
  if (!current || !info) return
  adding.value = true
  try {
    const entry = await api.addOnline(
      {
        sourceId: current.id,
        sourceName: current.name,
        detailUrl: props.item.detailUrl,
        cover: info.cover ?? null,
        episodeCount: episodes.value.length || null,
        invalid: false,
      },
      info.title || props.item.title,
    )
    // Push the entry into the running store. `add_online` only writes the file; the
    // library reads it once at startup, so without this the title would exist on
    // disk but not in the app until a restart.
    library.upsert(entry)
    added.value = true
  } catch {
    // Best-effort: a failure to add is not worth an error banner on a page whose
    // main job is playback. The button stays enabled so it can be retried.
  } finally {
    adding.value = false
  }
}

function selectRoad(index: number): void {
  roadIndex.value = index
}

onBeforeUnmount(() => {
  engine.value?.dispose()
  engine.value = null
})

watch(
  () => props.item.detailUrl,
  () => void load(),
  { immediate: true },
)
</script>

<template>
  <div class="detail">
    <header class="detail-header">
      <button class="btn btn--tertiary" type="button" @click="emit('back')">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M9 2L4 7l5 5" fill="none" stroke="currentColor" stroke-width="1.6" />
        </svg>
        {{ t('source.backToBrowse') }}
      </button>
    </header>

    <div ref="sandboxMount" class="sandbox-host" aria-hidden="true" />

    <div v-if="loading" class="state">{{ t('common.loading') }}</div>

    <div v-else-if="error" class="state">
      <p class="state-title">{{ t('viewer.error.title') }}</p>
      <p class="state-body">{{ error }}</p>
      <button class="btn btn--secondary" type="button" @click="load">
        {{ t('common.retry') }}
      </button>
    </div>

    <template v-else-if="detail">
      <section class="hero">
        <div class="hero-cover">
          <img
            v-if="detail.cover && !coverFailed"
            class="hero-image"
            :src="detail.cover"
            :alt="detail.title"
            referrerpolicy="no-referrer"
            @error="coverFailed = true"
          />
          <span v-else class="hero-fallback" aria-hidden="true">
            {{ detail.title.charAt(0) }}
          </span>
        </div>

        <div class="hero-info">
          <h1 class="hero-title">{{ detail.title }}</h1>
          <p v-if="detail.author" class="hero-author">{{ detail.author }}</p>
          <p class="hero-count">
            {{ t('source.roadCount', { roads: roads.length, episodes: episodes.length }) }}
          </p>
          <p v-if="detail.intro" class="hero-intro">{{ detail.intro }}</p>

          <!-- A sniff takes ten seconds by design; an unannounced wait reads as a
               hang and invites a second click. -->
          <p v-if="probing" class="probing">{{ t('source.sniffing') }}</p>

          <div class="hero-actions">
            <button
              class="btn btn--primary"
              type="button"
              :disabled="!episodes.length"
              @click="episodes[0] && playEpisode(episodes[0])"
            >
              {{ t('source.watchFirst') }}
            </button>
            <!-- Adding is a reference, not a download: what gets stored is the
                 source id and detail URL, so the entry stays a few hundred bytes
                 and keeps working as long as the source does. -->
            <button
              class="btn btn--tertiary"
              type="button"
              :disabled="adding"
              @click="addToLibrary()"
            >
              {{ added ? t('library.addedAlready') : t('source.addToLibrary') }}
            </button>
            <a
              v-if="source?.homepage"
              class="btn btn--tertiary"
              :href="source.homepage"
              target="_blank"
              rel="noreferrer"
            >
              {{ t('source.openSite') }}
            </a>
          </div>

          <!-- The probe result. Only shown when it failed: a working source needs
               no reassurance, and a permanent "✓ 可播放" line is noise. -->
          <div v-if="playable === false" class="warn">
            <p class="warn-title">{{ t('source.playbackUnavailable.title') }}</p>
            <p class="warn-body">{{ t('source.playbackUnavailable.body') }}</p>
            <p v-if="probeMessage" class="warn-detail">{{ probeMessage }}</p>
          </div>
        </div>
      </section>

      <section v-if="detail.diagnoses.length" class="diagnoses">
        <p class="diagnoses-text">
          {{ t('source.diagnosesCount', { count: detail.diagnoses.length }) }}
        </p>
      </section>

      <section class="episodes">
        <h2 class="episodes-title">{{ t('source.episodes') }}</h2>

        <!-- Lines. A chip row, because the count is small and always visible;
             a dropdown would hide which lines exist. -->
        <div v-if="roads.length > 1" class="roads" role="tablist">
          <button
            v-for="(road, index) in roads"
            :key="road.name"
            class="road-chip"
            :class="{ 'is-active': index === roadIndex }"
            type="button"
            role="tab"
            :aria-selected="index === roadIndex"
            @click="selectRoad(index)"
          >
            {{ road.name }}
            <span class="road-count">{{ road.episodes.length }}</span>
          </button>
        </div>

        <p v-if="!episodes.length" class="episodes-empty">{{ t('source.noEpisodes') }}</p>

        <!-- A grid of numbers rather than a list of titles: episode titles on
             these sites are almost always just the number, and a grid of 200
             numbered boxes is far easier to scan than 200 rows. -->
        <div v-else class="episode-grid">
          <button
            v-for="(episode, index) in episodes"
            :key="episode.url"
            class="episode"
            type="button"
            :title="episode.title"
            @click="playEpisode(episode)"
          >
            <span class="episode-label">{{ episode.title || index + 1 }}</span>
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.detail-header {
  flex: none;
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: var(--space-4) var(--content-pad) 0;
}

.sandbox-host {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}

.hero {
  display: flex;
  gap: var(--space-6);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: var(--space-5) var(--content-pad) var(--space-5);
}

/* 2:3 for a video poster is the convention on every anime site, and matching it
   makes the cover look like it belongs rather than like a book. */
.hero-cover {
  flex: none;
  width: 160px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--surface-sunken);
}

.hero-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.hero-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: var(--text-2xl);
  font-weight: var(--weight-strong);
  color: var(--ink-tertiary);
}

.hero-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.hero-title {
  font-size: var(--text-xl);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}

.hero-author,
.hero-count {
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.hero-count {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.hero-intro {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  line-height: var(--leading-normal);
  max-width: 60ch;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hero-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.probing {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

/* A warning, not a blocker: the episode list below stays usable. */
.warn {
  margin-top: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--tone-warning-surface);
  max-width: 60ch;
}

.warn-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--tone-warning);
}

.warn-body {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--ink-secondary);
  line-height: var(--leading-normal);
}

.warn-detail {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  word-break: break-word;
}

.diagnoses {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
}

.diagnoses-text {
  font-size: var(--text-xs);
  color: var(--tone-warning);
}

/* --- Episodes ----------------------------------------------------------- */
.episodes {
  flex: 1;
  min-height: 0;
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-7);
}

.episodes-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  margin-bottom: var(--space-3);
}

.roads {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.road-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  color: var(--ink-secondary);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.road-chip:hover {
  background: var(--surface-hover);
  color: var(--ink-primary);
}

/* Active is a surface step plus weight, never a hue — the design system has no
   accent colour to spend here. */
.road-chip.is-active {
  background: var(--surface-ink);
  color: var(--ink-inverse);
  font-weight: var(--weight-medium);
}

.road-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.65;
}

.episode-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: var(--space-2);
}

.episode {
  display: flex;
  align-items: center;
  justify-content: center;
  height: var(--control-lg);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  font-size: var(--text-sm);
  color: var(--ink-primary);
  font-variant-numeric: tabular-nums;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.episode:hover {
  background: var(--surface-active);
}

.episode-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.episodes-empty {
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  flex: 1;
  padding: var(--space-9) var(--space-6);
  text-align: center;
}

.state-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
}

.state-body {
  max-width: 46ch;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  line-height: var(--leading-normal);
}
</style>
