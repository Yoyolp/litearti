<script setup lang="ts">
/**
 * Browsing one source: pick a source, search, get a grid of cards.
 *
 * The engine and its sandbox live here, mounted once per source, because a
 * sandbox iframe per card would be absurd. Disposal is explicit: the sandbox
 * must be torn down when leaving, or its frame leaks for the session.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useSourcesStore } from '@/stores/sources'
import { t } from '@/i18n'
import { SourceEngine, type SourceItem } from '@/sources/engine'
import { SelectorError } from '@/sources/selector'
import { openExternal } from '@/api/library'
import SourceCard from '@/components/SourceCard.vue'

const props = defineProps<{ sourceId: string }>()
const emit = defineEmits<{
  back: []
  open: [item: SourceItem]
  switchSource: [sourceId: string]
}>()

const store = useSourcesStore()
const keyword = ref('')
const items = ref<SourceItem[]>([])
const searching = ref(false)
const error = ref<string | null>(null)
const searched = ref(false)
/** Mount point for the sandbox iframe. */
const sandboxMount = ref<HTMLElement | null>(null)
const engine = shallowRef<SourceEngine | null>(null)

const source = computed(() => store.byId(props.sourceId))

const enabledSources = computed(() => store.enabled)

function disposeEngine(): void {
  engine.value?.dispose?.()
  engine.value = null
}

/** Create (or recreate) the engine for the current source. */
function ensureEngine(): SourceEngine | null {
  const current = source.value
  if (!current) return null
  if (engine.value) return engine.value
  const mount = sandboxMount.value
  engine.value = new SourceEngine(current, undefined, mount ?? undefined)
  return engine.value
}

/** Whether the input is a URL rather than a search keyword. */
function looksLikeUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim())
}

/**
 * Load a pasted book URL as a single result.
 *
 * The input box is labelled as a search field, but pasting a link is a natural
 * thing to do — and a link is not a keyword, so sending it to the site's search
 * would return nothing and look broken. When the input parses as http(s), the
 * engine reads that page as a detail page and shows it as the one card.
 */
async function loadFromUrl(url: string): Promise<void> {
  const active = ensureEngine()
  if (!active) throw new Error('书源不存在')
  const item = await active.itemFromUrl(url)
  items.value = [item]
  searched.value = true
  // A pasted URL already has its cover from the detail page.
  void fillCovers(active, coverGeneration)
}

/** Open the source's own site in the system browser. */
async function openHomepage(): Promise<void> {
  const homepage = source.value?.homepage
  if (!homepage) return
  try {
    await openExternal(homepage)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function search(): Promise<void> {
  const current = source.value
  if (!current) return
  const q = keyword.value.trim()
  if (!q) return

  searching.value = true
  error.value = null
  coverGeneration += 1
  try {
    const active = ensureEngine()
    if (!active) throw new Error('书源不存在')

    if (looksLikeUrl(q)) {
      await loadFromUrl(q)
    } else {
      items.value = await active.search(q)
      searched.value = true
      void fillCovers(active, coverGeneration)
    }
  } catch (cause) {
    error.value = describe(cause)
    items.value = []
  } finally {
    searching.value = false
  }
}

/**
 * Fill in missing covers in the background.
 *
 * A search listing often has no image; the cover lives on the detail page. The
 * list is shown first and each card upgrades in place, so the result is
 * immediate and the covers arrive as they are found. Requests are serial with
 * the source's own `delayMs` between them — ten parallel hits on a small site
 * is rude and gets blocked.
 */
let coverGeneration = 0

/**
 * How many covers one search may backfill.
 *
 * A listing can return a hundred results, and fetching a detail page for each
 * would mean a hundred requests to a site that is doing us a favour. The cap
 * covers roughly what is visible in the first two screens; the rest keep the
 * initial tile, which is a deliberate trade rather than an oversight.
 */
const MAX_COVER_FETCHES = 24

async function fillCovers(active: SourceEngine, generation: number): Promise<void> {
  const delay = source.value?.request.delayMs ?? 300
  let fetched = 0
  for (const item of items.value) {
    // A newer search or leaving the view cancels the rest.
    if (generation !== coverGeneration) return
    if (item.cover) continue
    if (fetched >= MAX_COVER_FETCHES) return
    fetched += 1
    try {
      const cover = await active.cover(item.detailUrl)
      if (generation !== coverGeneration) return
      if (cover) item.cover = cover
    } catch {
      // A card without a cover is a cosmetic miss, not a reason to surface an
      // error over a working search.
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

/** Turn an engine failure into a sentence that points at the likely cause. */
function describe(cause: unknown): string {
  if (cause instanceof SelectorError) {
    return `选择器有问题：${cause.message}`
  }
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/请求失败|network|timed out|timeout/i.test(message)) {
    return `无法访问网站：${message}`
  }
  return message
}

// Switching source invalidates the engine: the definition changed, and a stale
// sandbox would keep the old source's context alive.
watch(
  () => props.sourceId,
  () => {
    coverGeneration += 1
    disposeEngine()
    items.value = []
    searched.value = false
    error.value = null
  },
)

onBeforeUnmount(() => {
  // Stop any in-flight cover fetches before the engine goes away.
  coverGeneration += 1
  disposeEngine()
})
</script>

<template>
  <div class="browse">
    <header class="browse-header">
      <div class="head-row">
        <button class="btn btn--tertiary" type="button" @click="emit('back')">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M9 2L4 7l5 5" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          {{ t('source.backToSources') }}
        </button>

        <label v-if="enabledSources.length > 1" class="source-picker">
          <select
            class="source-select"
            :value="sourceId"
            :aria-label="t('source.pick')"
            @change="emit('switchSource', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="option in enabledSources" :key="option.id" :value="option.id">
              {{ option.name }}
            </option>
          </select>
        </label>

        <!-- Visit the site itself. Opens in the system browser rather than the
             webview: the app window must not be replaced by the site. -->
        <button
          v-if="source?.homepage"
          class="btn btn--tertiary open-site"
          type="button"
          :title="source.homepage"
          @click="openHomepage"
        >
          {{ t('source.openSite') }}
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 1h7v7M11 1L5 7M9 7v4H1V3h4" fill="none" stroke="currentColor" stroke-width="1.3" />
          </svg>
        </button>
      </div>

      <div class="search-row">
        <label class="search">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="search-icon">
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.4" />
          </svg>
          <input
            v-model="keyword"
            class="search-input"
            type="search"
            :placeholder="t('source.searchPlaceholder')"
            :aria-label="t('source.searchPlaceholder')"
            @keydown.enter="search"
          />
        </label>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="searching || !keyword.trim()"
          @click="search"
        >
          {{ searching ? t('source.searching') : t('source.search') }}
        </button>
      </div>

      <!-- Explains the URL affordance without a tooltip nobody reads. -->
      <p class="search-hint">{{ t('source.searchHintUrl') }}</p>
    </header>

    <!-- Sandbox host: zero-sized, never visible. The engine appends its iframe
         here so the frame lives inside this view's lifetime. -->
    <div ref="sandboxMount" class="sandbox-host" aria-hidden="true" />

    <div v-if="error" class="error-wrap">
      <div class="error-strip">
        <p class="error-text">{{ error }}</p>
        <button class="btn btn--tertiary" type="button" @click="error = null">
          {{ t('common.close') }}
        </button>
      </div>
    </div>

    <div v-if="searching" class="state">{{ t('source.searching') }}</div>

    <div v-else-if="!searched" class="state">
      <p class="state-title">{{ t('source.searchHint.title') }}</p>
      <p class="state-body">{{ t('source.searchHint.body') }}</p>
    </div>

    <div v-else-if="!items.length" class="state">
      <p class="state-title">{{ t('source.noResults') }}</p>
      <p class="state-body">{{ t('source.noResultsBody', { keyword }) }}</p>
    </div>

    <div v-else class="grid">
      <SourceCard v-for="item in items" :key="item.detailUrl" :item="item" @open="emit('open', $event)" />
    </div>
  </div>
</template>

<style scoped>
.browse {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.browse-header {
  flex: none;
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: var(--space-5) var(--content-pad) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

/* The "visit site" button sits at the far right of the head row, away from the
   back button, so a misclick cannot navigate away from the source. */
.open-site {
  margin-left: auto;
  gap: var(--space-2);
  font-size: var(--text-xs);
}

.search-hint {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  line-height: var(--leading-snug);
}

.source-picker {
  flex: none;
}

.source-select {
  height: var(--control-md);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--line-strong);
  background: var(--surface-raised);
  font-size: var(--text-sm);
  color: var(--ink-primary);
}

.search-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  height: var(--control-md);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.search:focus-within {
  background: var(--surface-raised);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}

.search-icon {
  flex: none;
  color: var(--ink-tertiary);
}

.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: var(--text-sm);
  color: var(--ink-primary);
}

/* Zero-sized host: the iframe inside must not affect layout. */
.sandbox-host {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-5) var(--space-4);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-7);
  align-content: start;
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
  color: var(--ink-primary);
}

.state-body {
  max-width: 46ch;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  line-height: var(--leading-normal);
}

.error-wrap {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
}

.error-strip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--tone-danger-surface);
}

.error-text {
  flex: 1;
  font-size: var(--text-sm);
  color: var(--tone-danger);
}
</style>
