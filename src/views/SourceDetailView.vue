<script setup lang="ts">
/**
 * Source item detail: cover, metadata, chapter list, and the two actions.
 *
 * The two actions are deliberately different in kind: reading is instant and
 * reversible, downloading writes to the library and is not. So "read" is the
 * primary and "download" is secondary — the same hierarchy the library uses for
 * import versus open.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { t } from '@/i18n'
import { useSourcesStore } from '@/stores/sources'
import { SourceEngine, type SourceChapter, type SourceDetail, type SourceItem } from '@/sources/engine'
import { SelectorError } from '@/sources/selector'
import { downloadItem, DownloadCancelled } from '@/sources/download'

const props = defineProps<{ sourceId: string; item: SourceItem }>()
const emit = defineEmits<{
  back: []
  read: [chapter: SourceChapter, chapters: SourceChapter[]]
}>()

const store = useSourcesStore()
const detail = ref<SourceDetail | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const downloading = ref(false)
const downloadProgress = ref<[number, number] | null>(null)
const downloadDone = ref<string | null>(null)
const coverFailed = ref(false)
const sandboxMount = ref<HTMLElement | null>(null)
const engine = shallowRef<SourceEngine | null>(null)

const source = computed(() => store.byId(props.sourceId))
const chapters = computed(() => detail.value?.chapters ?? [])

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
  try {
    const active = ensureEngine()
    if (!active) throw new Error('书源不存在')
    detail.value = await active.detail(props.item.detailUrl)
  } catch (cause) {
    error.value = cause instanceof SelectorError
      ? `选择器有问题：${cause.message}`
      : cause instanceof Error
        ? cause.message
        : String(cause)
  } finally {
    loading.value = false
  }
}

function readChapter(chapter: SourceChapter): void {
  emit('read', chapter, chapters.value)
}

async function download(): Promise<void> {
  const current = source.value
  const active = ensureEngine()
  if (!current || !active) return

  downloading.value = true
  downloadDone.value = null
  error.value = null
  downloadProgress.value = null
  try {
    const result = await downloadItem({
      source: current,
      title: detail.value?.title ?? props.item.title,
      detailUrl: props.item.detailUrl,
      chapters: chapters.value,
      engine: active,
      onProgress: (done, total) => {
        downloadProgress.value = [done, total]
      },
    })
    downloadDone.value =
      result.mode === 'concatenated'
        ? t('source.downloadDoneJoined', { count: result.chapterCount })
        : t('source.downloadDoneFile')
  } catch (cause) {
    if (cause instanceof DownloadCancelled) {
      // Cancelling is not a failure and should not read like one.
      error.value = null
    } else {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  } finally {
    downloading.value = false
    downloadProgress.value = null
  }
}

onMounted(() => void load())
onBeforeUnmount(() => {
  engine.value?.dispose()
  engine.value = null
})
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
          <p class="hero-count">{{ t('source.chapterCount', { count: chapters.length }) }}</p>
          <p v-if="detail.intro" class="hero-intro">{{ detail.intro }}</p>

          <div class="hero-actions">
            <button
              class="btn btn--primary"
              type="button"
              :disabled="!chapters.length"
              @click="chapters[0] && readChapter(chapters[0])"
            >
              {{ t('source.readOnline') }}
            </button>
            <button
              class="btn btn--secondary"
              type="button"
              :disabled="downloading || !chapters.length"
              @click="download"
            >
              {{
                downloading
                  ? downloadProgress
                    ? t('source.downloading', {
                        done: downloadProgress[0],
                        total: downloadProgress[1],
                      })
                    : t('source.downloadStarting')
                  : t('source.download')
              }}
            </button>
          </div>

          <p v-if="downloadDone" class="download-done">{{ downloadDone }}</p>
          <p v-if="error && !loading" class="download-error">{{ error }}</p>
        </div>
      </section>

      <section class="chapters">
        <h2 class="chapters-title">{{ t('source.chapters') }}</h2>
        <p v-if="!chapters.length" class="chapters-empty">{{ t('source.noChapters') }}</p>
        <ol v-else class="chapter-list">
          <li v-for="(chapter, index) in chapters" :key="chapter.url" class="chapter-row">
            <button class="chapter-open" type="button" @click="readChapter(chapter)">
              <span class="chapter-index">{{ index + 1 }}</span>
              <span class="chapter-title">{{ chapter.title }}</span>
            </button>
          </li>
        </ol>
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
  padding: var(--space-5) var(--content-pad) var(--space-6);
}

.hero-cover {
  flex: none;
  width: 160px;
  aspect-ratio: 3 / 4;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--surface-sunken);
  box-shadow: var(--shadow-e1);
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

.hero-author {
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
  /* Long blurbs collapse rather than pushing the chapter list off-screen. */
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hero-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.download-done {
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.download-error {
  font-size: var(--text-sm);
  color: var(--tone-danger);
}

.chapters {
  flex: 1;
  min-height: 0;
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-7);
}

.chapters-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  margin-bottom: var(--space-3);
}

.chapters-empty {
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

.chapter-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.chapter-row {
  position: relative;
  border-radius: var(--radius-sm);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.chapter-row:hover {
  background: var(--surface-hover);
}

.chapter-row + .chapter-row::before {
  content: '';
  position: absolute;
  top: 0;
  left: var(--space-3);
  right: var(--space-3);
  height: var(--hairline);
  background: var(--line-subtle);
}

.chapter-open {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  text-align: left;
}

.chapter-index {
  flex: none;
  width: 2.5ch;
  text-align: right;
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.chapter-title {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--ink-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
