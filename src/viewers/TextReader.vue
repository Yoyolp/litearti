<script setup lang="ts">
/**
 * Text viewer.
 *
 * Design notes:
 * - The prose column is capped by `--measure-prose` so lines stay readable
 *   regardless of window width; the rest of the window is quiet margin.
 * - Progress is stored as a *ratio*, not a pixel offset, so the same entry
 *   resumes sensibly at a different window size or font size.
 * - Encoding is a first-class control, not a hidden setting: a mis-detected
 *   file is the single most common way a Chinese text file looks broken.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DecodedText, Entry, ViewerHost } from '@/types/viewer'
import { t } from '@/i18n'
import { clamp } from '@/utils/format'
import { chapterAtRatio, chapterBody, splitChapters, type TextChapter } from './txt/chapters'

const props = defineProps<{ entry: Entry; host: ViewerHost }>()

const scrollEl = ref<HTMLElement | null>(null)
const decoded = ref<DecodedText | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const fontSize = ref(17)
const chosenEncoding = ref<string | undefined>(undefined)
const encodingMenuOpen = ref(false)
const tocOpen = ref(false)

/** Encodings worth offering: the two that cover nearly all Chinese text. */
const ENCODINGS = [
  { value: undefined, label: '自动' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gb18030', label: 'GB18030 / GBK' },
  { value: 'big5', label: 'Big5' },
] as const

interface TextProgress {
  version: 1
  ratio: number
  fontSize?: number
  /** Index into the detected chapter list; absent for an unchaptered file. */
  chapter?: number
}

/** Raw lines of the document, kept so chapter slices can be taken cheaply. */
const allLines = ref<string[]>([])

/** Detected chapters, empty when the file does not look chaptered. */
const chapters = ref<TextChapter[]>([])

/** Index of the chapter being read, or 0 when the file has no chapters. */
const chapterIndex = ref(0)

const chaptered = computed(() => chapters.value.length > 0)

const currentChapter = computed<TextChapter | null>(
  () => chapters.value[chapterIndex.value] ?? null,
)

function readStoredProgress(): TextProgress | null {
  const raw = props.entry.progress
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<TextProgress>
  if (candidate.version !== 1 || typeof candidate.ratio !== 'number') return null
  return candidate as TextProgress
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const result = await props.host.readText(props.entry.id, chosenEncoding.value)
    decoded.value = result

    allLines.value = result.text.split(/\r\n|\r|\n/)
    chapters.value = splitChapters(result.text)

    const stored = readStoredProgress()
    if (stored && typeof stored.fontSize === 'number') fontSize.value = stored.fontSize

    if (chapters.value.length) {
      // Progress written before chapters existed holds a whole-file ratio.
      // Map it onto a chapter so an existing reader is not thrown back to the
      // start of the book.
      if (typeof stored?.chapter === 'number') {
        chapterIndex.value = clamp(stored.chapter, 0, chapters.value.length - 1)
      } else if (stored) {
        chapterIndex.value = chapterAtRatio(chapters.value, allLines.value.length, stored.ratio)
      } else {
        chapterIndex.value = 0
      }
    }

    // Restore scroll after the text is in the DOM, otherwise scrollHeight is
    // still zero and the ratio has nothing to multiply against.
    if (stored) {
      await nextTick()
      requestAnimationFrame(() => restoreScroll(stored.ratio))
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function restoreScroll(ratio: number): void {
  const el = scrollEl.value
  if (!el) return
  const max = el.scrollHeight - el.clientHeight
  el.scrollTop = clamp(ratio, 0, 1) * Math.max(0, max)
}

/** Save on a trailing edge so scrolling stays smooth. */
let saveTimer: number | undefined
function scheduleSave(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const el = scrollEl.value
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    const ratio = max > 0 ? el.scrollTop / max : 0
    void props.host.saveProgress(props.entry.id, {
      version: 1,
      ratio: clamp(ratio, 0, 1),
      fontSize: fontSize.value,
      ...(chaptered.value ? { chapter: chapterIndex.value } : {}),
    } satisfies TextProgress)
  }, 600)
}

function onScroll(): void {
  scheduleSave()
}

function setEncoding(value: string | undefined): void {
  chosenEncoding.value = value
  encodingMenuOpen.value = false
  void load()
}

function changeFontSize(delta: number): void {
  fontSize.value = clamp(fontSize.value + delta, 13, 28)
  scheduleSave()
}

/**
 * Move to another chapter and return to the top of it.
 *
 * Chapter progress is deliberately *not* per-chapter: the stored ratio describes
 * the position within the current chapter, and switching chapters resets it.
 * Keeping one ratio per chapter would need a map that grows without bound for
 * little benefit — people resume the chapter they were on.
 */
async function goToChapter(index: number): Promise<void> {
  if (!chaptered.value) return
  const next = clamp(index, 0, chapters.value.length - 1)
  if (next === chapterIndex.value) return
  chapterIndex.value = next
  tocOpen.value = false
  await nextTick()
  scrollEl.value?.scrollTo({ top: 0 })
  scheduleSave()
}

/** Lines rendered: the whole file, or just the current chapter. */
const visibleLines = computed(() => {
  const chapter = currentChapter.value
  if (!chapter) {
    return allLines.value.map((text, index) => ({ key: index, text }))
  }
  return chapterBody(allLines.value, chapter).map((text, index) => ({
    key: chapter.start + index,
    text,
  }))
})

/** Paragraphs, so the renderer can space them without wrapping every line. */
const paragraphs = computed(() =>
  visibleLines.value.map((line) => ({
    key: line.key,
    text: line.text,
    blank: line.text.trim().length === 0,
  })),
)

const atFirstChapter = computed(() => chapterIndex.value <= 0)
const atLastChapter = computed(() => chapterIndex.value >= chapters.value.length - 1)

const encodingLabel = computed(() => {
  if (chosenEncoding.value) {
    const found = ENCODINGS.find((e) => e.value === chosenEncoding.value)
    return found?.label ?? chosenEncoding.value
  }
  return decoded.value ? t('txt.encodingAuto', { encoding: decoded.value.encoding }) : ''
})

watch(() => props.entry.id, () => void load())

onMounted(() => void load())
onBeforeUnmount(() => {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  // Flush the pending position so closing right after scrolling still saves.
  const el = scrollEl.value
  if (el) {
    const max = el.scrollHeight - el.clientHeight
    const ratio = max > 0 ? el.scrollTop / max : 0
    void props.host.saveProgress(props.entry.id, {
      version: 1,
      ratio: clamp(ratio, 0, 1),
      fontSize: fontSize.value,
    } satisfies TextProgress)
  }
})
</script>

<template>
  <div class="txt-viewer">
    <!-- A slim toolbar, not a chrome bar: only controls that change reading. -->
    <div class="txt-toolbar">
      <div class="encoding">
        <button
          class="btn btn--tertiary encoding-trigger"
          type="button"
          :aria-expanded="encodingMenuOpen"
          @click="encodingMenuOpen = !encodingMenuOpen"
        >
          {{ encodingLabel }}
          <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
        <ul v-if="encodingMenuOpen" class="encoding-menu" role="listbox">
          <li v-for="option in ENCODINGS" :key="option.label">
            <button
              type="button"
              class="encoding-option"
              :class="{ 'is-active': option.value === chosenEncoding }"
              role="option"
              :aria-selected="option.value === chosenEncoding"
              @click="setEncoding(option.value)"
            >
              {{ option.label }}
            </button>
          </li>
        </ul>
      </div>

      <p v-if="decoded?.lossy" class="lossy-hint">{{ t('txt.lossy') }}</p>

      <!-- Chapter navigation appears only when the file was recognised as a
           chaptered novel. An unchaptered text keeps the old toolbar exactly. -->
      <div v-if="chaptered" class="chapter-nav">
        <button
          class="btn btn--tertiary toc-trigger"
          type="button"
          :aria-expanded="tocOpen"
          @click="tocOpen = !tocOpen"
        >
          {{ t('txt.toc') }}
        </button>

        <button
          class="btn btn--tertiary"
          type="button"
          :aria-label="t('txt.prevChapter')"
          :disabled="atFirstChapter"
          @click="goToChapter(chapterIndex - 1)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M9 2L4 7l5 5" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>

        <span class="chapter-label" :title="currentChapter?.title">
          {{ t('txt.chapterPosition', { index: chapterIndex + 1, total: chapters.length }) }}
        </span>

        <button
          class="btn btn--tertiary"
          type="button"
          :aria-label="t('txt.nextChapter')"
          :disabled="atLastChapter"
          @click="goToChapter(chapterIndex + 1)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M5 2l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
      </div>

      <div class="font-controls">
        <button
          class="btn btn--tertiary"
          type="button"
          :aria-label="t('txt.fontSmaller')"
          :disabled="fontSize <= 13"
          @click="changeFontSize(-1)"
        >
          A−
        </button>
        <button
          class="btn btn--tertiary"
          type="button"
          :aria-label="t('txt.fontLarger')"
          :disabled="fontSize >= 28"
          @click="changeFontSize(1)"
        >
          A+
        </button>
      </div>
    </div>

    <!-- Chapter title, shown above the text only in chaptered mode: the toolbar
         is too narrow for a long Chinese chapter name. -->
    <div v-if="chaptered && currentChapter" class="chapter-heading">
      <h2 class="chapter-title">{{ currentChapter.title }}</h2>
    </div>

    <div ref="scrollEl" class="txt-scroll" @scroll.passive="onScroll">
      <div v-if="loading" class="state">{{ t('common.loading') }}</div>
      <div v-else-if="error" class="state">
        <p class="state-title">{{ t('viewer.error.title') }}</p>
        <p class="state-body">{{ error }}</p>
        <button class="btn btn--secondary" type="button" @click="load">
          {{ t('common.retry') }}
        </button>
      </div>
      <article v-else class="prose" :style="{ fontSize: `${fontSize}px` }">
        <p
          v-for="line in paragraphs"
          :key="line.key"
          :class="{ 'is-blank': line.blank }"
        >{{ line.blank ? '\u00a0' : line.text }}</p>
      </article>

      <!-- End-of-chapter footer: a chaptered novel needs an explicit "next",
           the same way the EPUB viewer does. -->
      <div v-if="chaptered && !loading && !error" class="chapter-footer">
        <button
          v-if="!atLastChapter"
          class="btn btn--secondary"
          type="button"
          @click="goToChapter(chapterIndex + 1)"
        >
          {{ t('txt.nextChapter') }}
        </button>
        <p v-else class="end-note">{{ t('txt.lastChapter') }}</p>
      </div>
    </div>

    <!-- Table of contents drawer. -->
    <Transition name="drawer">
      <div v-if="tocOpen" class="toc-backdrop" @click.self="tocOpen = false">
        <aside class="toc-drawer" role="dialog" aria-modal="true" :aria-label="t('txt.toc')">
          <header class="toc-header">
            <h2 class="toc-title">{{ t('txt.toc') }}</h2>
            <button class="btn btn--tertiary" type="button" @click="tocOpen = false">
              {{ t('common.close') }}
            </button>
          </header>
          <nav class="toc-list">
            <button
              v-for="(chapter, index) in chapters"
              :key="chapter.start"
              class="toc-item"
              :class="{ 'is-current': index === chapterIndex }"
              type="button"
              @click="goToChapter(index)"
            >
              <span class="toc-index">{{ index + 1 }}</span>
              <span class="toc-text">{{ chapter.title }}</span>
            </button>
          </nav>
        </aside>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.txt-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.txt-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-5);
  border-bottom: 1px solid var(--line-subtle);
  flex: none;
}

.encoding {
  position: relative;
}

.encoding-trigger {
  gap: var(--space-2);
}

.encoding-menu {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  z-index: 10;
  min-width: var(--menu-min-width);
  margin: 0;
  padding: var(--space-1);
  list-style: none;
  background: var(--surface-raised);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-e2);
}

.encoding-option {
  display: block;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.encoding-option:hover {
  background: var(--surface-hover);
  color: var(--ink-primary);
}

.encoding-option.is-active {
  color: var(--ink-primary);
  font-weight: var(--weight-strong);
}

.lossy-hint {
  flex: 1;
  font-size: var(--text-xs);
  color: var(--tone-warning);
}

/* --- chapters ----------------------------------------------------------- */

.chapter-nav {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}

.toc-trigger {
  margin-right: var(--space-1);
}

.chapter-label {
  min-width: 7ch;
  text-align: center;
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* The chapter title sits above the text, not in the toolbar: Chinese chapter
   names are long, and squeezing one into a single-line toolbar truncates it to
   uselessness. */
.chapter-heading {
  flex: none;
  max-width: var(--measure-prose);
  width: 100%;
  margin: 0 auto;
  padding: var(--space-5) var(--content-pad) 0;
}

.chapter-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  color: var(--ink-primary);
  line-height: var(--leading-snug);
}

.chapter-footer {
  display: flex;
  justify-content: center;
  padding: var(--space-5) var(--space-5) var(--space-8);
}

.end-note {
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

/* --- toc drawer --------------------------------------------------------- */

.toc-backdrop {
  position: absolute;
  inset: 0;
  display: flex;
  background: color-mix(in srgb, var(--surface-page) 60%, transparent);
  z-index: 20;
}

.toc-drawer {
  display: flex;
  flex-direction: column;
  width: min(320px, 80%);
  height: 100%;
  background: var(--surface-raised);
  border-right: 1px solid var(--line-subtle);
  box-shadow: var(--shadow-e3);
}

.toc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex: none;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--line-subtle);
}

.toc-title {
  font-size: var(--text-base);
  font-weight: var(--weight-strong);
}

.toc-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) 0;
}

.toc-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-4);
  text-align: left;
  font-size: var(--text-sm);
  line-height: var(--leading-snug);
  color: var(--ink-secondary);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.toc-item:hover {
  background: var(--surface-hover);
  color: var(--ink-primary);
}

.toc-item.is-current {
  color: var(--ink-primary);
  font-weight: var(--weight-medium);
  background: var(--surface-active);
}

.toc-index {
  flex: none;
  min-width: 2.5ch;
  text-align: right;
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.toc-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-enter-active,
.drawer-leave-active {
  transition: opacity var(--duration-base) var(--ease-out);
}

.drawer-enter-active .toc-drawer,
.drawer-leave-active .toc-drawer {
  transition: transform var(--duration-base) var(--ease-out);
}

.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}

.drawer-enter-from .toc-drawer,
.drawer-leave-to .toc-drawer {
  transform: translateX(-100%);
}

.font-controls {
  margin-left: auto;
  display: flex;
  gap: var(--space-1);
}

.txt-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Generous top space: starting a document mid-screen feels cramped. */
  padding: var(--space-8) var(--space-5) var(--space-9);
}

.prose {
  max-width: var(--measure-prose);
  margin: 0 auto;
  line-height: var(--leading-relaxed);
  color: var(--ink-primary);
  /* Prose is the one place selection is expected. */
  user-select: text;
  cursor: text;
  /* CJK text has no spaces; a modest tracking value keeps it from feeling
     like a solid block without hurting Latin runs. */
  letter-spacing: 0.01em;
}

.prose p {
  margin: 0;
  /* Each source line becomes a paragraph with a hair of space, so a text file
     with hard-wrapped lines still reads as blocks rather than a wall. */
  min-height: 1em;
}

.prose p + p {
  margin-top: 0.15em;
}

.prose p.is-blank {
  margin-top: 0.85em;
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-9) var(--space-5);
  color: var(--ink-secondary);
  text-align: center;
}

.state-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  color: var(--ink-primary);
}

.state-body {
  max-width: 40ch;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
</style>
