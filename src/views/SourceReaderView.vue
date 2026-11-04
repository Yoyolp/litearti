<script setup lang="ts">
/**
 * Reading one chapter of a source item.
 *
 * Typography deliberately matches `TextReader.vue`: same measure cap, same line
 * height, same 13–28px size control. A person switching between a local TXT and
 * a source chapter should not have to re-learn how the text sits on the page.
 *
 * Progress is stored per (source, chapter url), separate from library progress,
 * because these URLs can disappear — unlike an imported file, which is ours.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { t } from '@/i18n'
import { useSourcesStore } from '@/stores/sources'
import { clamp } from '@/utils/format'
import { SourceEngine, type SourceChapter } from '@/sources/engine'
import { SelectorError } from '@/sources/selector'

const props = defineProps<{
  sourceId: string
  chapters: SourceChapter[]
  chapter: SourceChapter
}>()

const emit = defineEmits<{ back: [] }>()

const store = useSourcesStore()
const scrollEl = ref<HTMLElement | null>(null)
const sandboxMount = ref<HTMLElement | null>(null)
const engine = shallowRef<SourceEngine | null>(null)

const text = ref('')
const loading = ref(true)
const error = ref<string | null>(null)
const fontSize = ref(17)
const currentIndex = ref(0)

const source = computed(() => store.byId(props.sourceId))

const currentChapter = computed(() => props.chapters[currentIndex.value] ?? props.chapter)
const atFirst = computed(() => currentIndex.value <= 0)
const atLast = computed(() => currentIndex.value >= props.chapters.length - 1)

const paragraphs = computed(() => {
  const body = text.value
  if (!body) return []
  // Source chapter bodies usually arrive as one blob with newlines; splitting
  // lets the renderer space paragraphs instead of producing a wall of text.
  return body.split(/\r\n|\r|\n/).map((line, index) => ({
    key: index,
    text: line.trim(),
    blank: !line.trim(),
  }))
})

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
  text.value = ''
  try {
    const active = ensureEngine()
    if (!active) throw new Error('书源不存在')
    text.value = await active.chapter(currentChapter.value.url)

    // Restore the saved ratio for this exact chapter, if any.
    const saved = store.getProgress(props.sourceId, currentChapter.value.url)
    if (saved) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const element = scrollEl.value
      if (element) {
        const max = element.scrollHeight - element.clientHeight
        element.scrollTop = clamp(saved.ratio, 0, 1) * Math.max(0, max)
      }
    } else {
      scrollEl.value?.scrollTo({ top: 0 })
    }
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

/** Trailing-edge progress save, same shape as the local viewers. */
let saveTimer: number | undefined
function scheduleSave(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const element = scrollEl.value
    if (!element) return
    const max = element.scrollHeight - element.clientHeight
    const ratio = max > 0 ? element.scrollTop / max : 0
    void store.saveProgress({
      sourceId: props.sourceId,
      chapterUrl: currentChapter.value.url,
      chapterTitle: currentChapter.value.title,
      ratio: clamp(ratio, 0, 1),
      updatedAt: Date.now(),
    })
  }, 600)
}

async function goTo(index: number): Promise<void> {
  if (index < 0 || index >= props.chapters.length || index === currentIndex.value) return
  currentIndex.value = index
  await load()
}

function changeFontSize(delta: number): void {
  fontSize.value = clamp(fontSize.value + delta, 13, 28)
}

onMounted(() => {
  // Start at whichever chapter was handed in, not always the first.
  const start = props.chapters.findIndex((c) => c.url === props.chapter.url)
  currentIndex.value = start >= 0 ? start : 0
  void load()
})

onBeforeUnmount(() => {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  engine.value?.dispose()
  engine.value = null
})

watch(
  () => props.chapter.url,
  () => {
    const start = props.chapters.findIndex((c) => c.url === props.chapter.url)
    if (start >= 0 && start !== currentIndex.value) {
      currentIndex.value = start
      void load()
    }
  },
)
</script>

<template>
  <div class="reader">
    <header class="reader-header">
      <button class="btn btn--tertiary back" type="button" @click="emit('back')">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M9 2L4 7l5 5" fill="none" stroke="currentColor" stroke-width="1.6" />
        </svg>
        {{ t('source.backToDetail') }}
      </button>

      <div class="identity">
        <h1 class="reader-title">{{ currentChapter.title }}</h1>
        <p class="reader-meta">
          {{ t('source.chapterPosition', { index: currentIndex + 1, total: chapters.length }) }}
        </p>
      </div>

      <div class="reader-controls">
        <div class="font-size">
          <button
            class="btn btn--tertiary"
            type="button"
            :aria-label="t('txt.fontSmaller')"
            :disabled="fontSize <= 13"
            @click="changeFontSize(-1)"
          >
            −
          </button>
          <span class="font-value">{{ fontSize }}</span>
          <button
            class="btn btn--tertiary"
            type="button"
            :aria-label="t('txt.fontLarger')"
            :disabled="fontSize >= 28"
            @click="changeFontSize(1)"
          >
            +
          </button>
        </div>

        <button
          class="btn btn--tertiary"
          type="button"
          :disabled="atFirst"
          @click="goTo(currentIndex - 1)"
        >
          {{ t('source.prevChapter') }}
        </button>
        <button
          class="btn btn--tertiary"
          type="button"
          :disabled="atLast"
          @click="goTo(currentIndex + 1)"
        >
          {{ t('source.nextChapter') }}
        </button>
      </div>
    </header>

    <div ref="sandboxMount" class="sandbox-host" aria-hidden="true" />

    <div ref="scrollEl" class="reader-body" @scroll.passive="scheduleSave">
      <div v-if="loading" class="state">{{ t('common.loading') }}</div>

      <div v-else-if="error" class="state">
        <p class="state-title">{{ t('viewer.error.title') }}</p>
        <p class="state-body">{{ error }}</p>
        <button class="btn btn--secondary" type="button" @click="load">
          {{ t('common.retry') }}
        </button>
      </div>

      <div v-else-if="!paragraphs.length" class="state">
        <p class="state-title">{{ t('source.emptyChapter') }}</p>
        <p class="state-body">{{ t('source.emptyChapterBody') }}</p>
      </div>

      <article v-else class="prose" :style="{ fontSize: `${fontSize}px` }">
        <template v-for="paragraph in paragraphs" :key="paragraph.key">
          <p v-if="!paragraph.blank" class="paragraph">{{ paragraph.text }}</p>
          <div v-else class="paragraph-gap" aria-hidden="true" />
        </template>
      </article>

      <div v-if="!loading && !error && paragraphs.length" class="chapter-footer">
        <button
          v-if="!atLast"
          class="btn btn--secondary"
          type="button"
          @click="goTo(currentIndex + 1)"
        >
          {{ t('source.nextChapter') }}
        </button>
        <p v-else class="end-note">{{ t('source.lastChapter') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reader {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.reader-header {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex: none;
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--line-subtle);
  background: var(--surface-page);
}

.back {
  flex: none;
  gap: var(--space-1);
  font-size: var(--text-sm);
}

.identity {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.reader-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reader-meta {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.reader-controls {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.font-size {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-right: var(--space-2);
}

.font-value {
  min-width: 2ch;
  text-align: center;
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.sandbox-host {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}

.reader-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--surface-page);
}

/* Same measure and rhythm as the local text viewer, so the two reading
   surfaces are the same surface. */
.prose {
  max-width: var(--measure-prose);
  margin: 0 auto;
  padding: var(--space-7) var(--content-pad) var(--space-5);
  line-height: var(--leading-relaxed);
  color: var(--ink-primary);
  user-select: text;
}

.paragraph {
  margin: 0 0 var(--space-4);
}

/* A blank source line becomes a gap rather than an empty paragraph, which would
   otherwise collapse to zero height and lose the author's spacing. */
.paragraph-gap {
  height: var(--space-3);
}

.chapter-footer {
  display: flex;
  justify-content: center;
  padding: 0 var(--space-5) var(--space-8);
}

.end-note {
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  height: 100%;
  padding: var(--space-6);
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
</style>
