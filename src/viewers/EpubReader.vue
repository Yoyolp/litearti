<script setup lang="ts">
/**
 * EPUB viewer.
 *
 * Model: one spine document at a time, rendered into a sandboxed iframe.
 *
 * Why an iframe rather than injecting HTML into the app's DOM: book content is
 * untrusted and carries its own CSS, and an iframe is the only boundary that
 * keeps a publisher's stylesheet from reaching into the shell. `srcdoc` plus
 * `sandbox="allow-same-origin"` — deliberately *without* `allow-scripts` —
 * yields a document that can be measured and styled from here but cannot run
 * code.
 *
 * Layout note: the frame is sized to its own content height and the *outer*
 * container scrolls. Letting the frame scroll internally would push the
 * end-of-chapter affordance out of the visible area, and would make progress a
 * ratio of an inner scroll box whose height the shell cannot see.
 *
 * Two rendering modes, both required by the product:
 *
 * - `original` — the book's own CSS, laid out as the publisher intended. This
 *   is the default, because an EPUB's design is part of the book.
 * - `reflow` — the publisher's CSS is dropped and the app's reading column is
 *   applied, so a badly typeset book is still comfortable.
 *
 * Fixed-layout (pre-paginated) books take a third path: one spine document per
 * screen, no scrolling, turned with the arrow keys.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Entry, ViewerHost } from '@/types/viewer'
import { t } from '@/i18n'
import { clamp } from '@/utils/format'
import { ZipArchive, ZipError } from './epub/zip'
import {
  flattenToc,
  readContainer,
  readPackage,
  splitFragment,
  type EpubPackage,
  type TocNode,
} from './epub/package'
import { prepareChapter, ResourceStore } from './epub/resources'
import { buildFixedThemeCss, buildReflowCss } from './epub/theme'

const props = defineProps<{ entry: Entry; host: ViewerHost }>()

/** Books above this size are refused rather than risking an out-of-memory freeze. */
const MAX_BOOK_BYTES = 200 * 1024 * 1024

interface EpubProgress {
  version: 1
  /** Index into the spine. */
  chapter: number
  /** Scroll ratio within that chapter, for reflowable books. */
  ratio?: number
  fontSize?: number
  mode?: 'original' | 'reflow'
}

type Mode = 'original' | 'reflow'

const loading = ref(true)
const error = ref<string | null>(null)
/** Set when the book is DRM-protected; a distinct state, not a generic error. */
const drmProtected = ref(false)

const book = shallowRef<EpubPackage | null>(null)
const resources = shallowRef<ResourceStore | null>(null)
/** The open archive; chapter rendering needs it alongside the resource cache. */
const archive = shallowRef<ZipArchive | null>(null)

const mode = ref<Mode>('original')
const fontSize = ref(17)
/** When on, fixed-layout pages get the app's surface behind them. */
const followTheme = ref(false)

const tocOpen = ref(false)
const tocFlat = computed(() => flattenToc(book.value?.toc ?? []))

const chapterIndex = ref(0)
const chapterHtml = ref<string | null>(null)
const chapterLoading = ref(false)
const iframeEl = ref<HTMLIFrameElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)

const chapterLabel = computed(() => {
  const pkg = book.value
  if (!pkg) return ''
  const path = pkg.spine[chapterIndex.value]
  if (!path) return ''
  return findTocLabel(pkg.toc, path) ?? path.split('/').pop()?.replace(/\.x?html?$/i, '') ?? ''
})

const total = computed(() => book.value?.spine.length ?? 0)
const atFirst = computed(() => chapterIndex.value <= 0)
const atLast = computed(() => chapterIndex.value >= total.value - 1)
const fixed = computed(() => book.value?.fixedLayout === true)

function findTocLabel(nodes: TocNode[], path: string): string | null {
  for (const node of nodes) {
    if (node.href === path) return node.label
    const nested = findTocLabel(node.children, path)
    if (nested) return nested
  }
  return null
}

function readStoredProgress(): EpubProgress | null {
  const raw = props.entry.progress
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<EpubProgress>
  if (candidate.version !== 1 || typeof candidate.chapter !== 'number') return null
  return candidate as EpubProgress
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  drmProtected.value = false
  book.value = null
  archive.value = null
  chapterHtml.value = null
  teardownResources()

  try {
    const bytes = await props.host.readBinary(props.entry.id)
    if (bytes.byteLength > MAX_BOOK_BYTES) {
      error.value = t('epub.tooLarge', {
        size: Math.round(bytes.byteLength / 1024 / 1024),
        limit: MAX_BOOK_BYTES / 1024 / 1024,
      })
      return
    }

    const zip = ZipArchive.open(new Uint8Array(bytes))

    // DRM is checked before anything else: an encrypted book has a perfectly
    // readable ZIP structure, so every later step would fail with a
    // misleading "corrupt file" instead of naming the real cause.
    if (await detectDrm(zip)) {
      drmProtected.value = true
      return
    }

    const opfPath = await readContainer(zip)
    const parsed = await readPackage(zip, opfPath)
    if (!parsed.spine.length) {
      error.value = t('epub.noContent')
      return
    }

    book.value = parsed
    archive.value = zip
    resources.value = new ResourceStore(zip)

    const stored = readStoredProgress()
    if (stored) {
      chapterIndex.value = clamp(stored.chapter, 0, parsed.spine.length - 1)
      if (typeof stored.fontSize === 'number') fontSize.value = clamp(stored.fontSize, 13, 28)
      if (stored.mode === 'reflow' || stored.mode === 'original') mode.value = stored.mode
    }

    // Flip `loading` before rendering the first chapter. The template only
    // mounts the iframe once `loading` is false, and `renderChapter` needs a
    // real iframe element to size and measure — waiting for `finally` here
    // would leave the first chapter with no frame at all.
    loading.value = false
    await nextTick()
    await renderChapter(stored?.ratio)
  } catch (cause) {
    error.value = describeFailure(cause)
  } finally {
    loading.value = false
  }
}

/**
 * Whether the archive declares DRM.
 *
 * `META-INF/encryption.xml` appears in DRM'd books *and* in books that merely
 * obfuscate fonts, which is legal and still readable. Only a non-benign
 * algorithm marks the book unreadable.
 */
async function detectDrm(zip: ZipArchive): Promise<boolean> {
  if (!zip.has('META-INF/encryption.xml')) return false
  try {
    const text = await zip.text('META-INF/encryption.xml')
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    const benign = [
      'http://www.idpf.org/2008/embedding',
      'http://ns.adobe.com/pdf/enc#RC',
    ]
    const algorithms = [...doc.querySelectorAll('*')]
      .filter((el) => (el.localName || '').toLowerCase() === 'encryptionmethod')
      .map((el) => el.getAttribute('Algorithm') ?? '')
    return algorithms.some((algorithm) => !benign.includes(algorithm))
  } catch {
    // An unreadable encryption manifest is treated as benign; genuinely
    // encrypted resources fail later with their own, more specific error.
    return false
  }
}

function describeFailure(cause: unknown): string {
  if (cause instanceof ZipError) return cause.message
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/decompress|inflate/i.test(message)) return t('epub.badArchive')
  return message
}

function teardownResources(): void {
  resources.value?.dispose()
  resources.value = null
}

/** Build and install one chapter document. */
async function renderChapter(restoreRatio?: number): Promise<void> {
  const pkg = book.value
  const zip = archive.value
  const store = resources.value
  if (!pkg || !zip || !store) return

  const path = pkg.spine[chapterIndex.value]
  if (!path) return

  chapterLoading.value = true
  chapterHtml.value = null
  iframeEl.value?.style.removeProperty('height')
  try {
    const prepared = await prepareChapter(zip, store, path, {
      reflow: mode.value === 'reflow',
      themeCss: buildReflowCss(document.documentElement, fontSize.value),
      extraCss:
        pkg.fixedLayout && followTheme.value
          ? buildFixedThemeCss(document.documentElement)
          : undefined,
    })
    chapterHtml.value = prepared.html
    // The frame is `v-show`-hidden while `chapterLoading` is true, so it has
    // no layout box yet. Clear the flag first, otherwise `fitFrame` measures
    // a display:none element and reads a height of zero.
    chapterLoading.value = false
    await nextTick()
    await waitForFrame()
    wireLinks()
    fitFrame()
    applyRestore(restoreRatio)
  } catch (cause) {
    error.value = describeFailure(cause)
  } finally {
    chapterLoading.value = false
  }
}

/**
 * Wait until the frame holds the chapter we just handed it.
 *
 * Event-based waiting is unreliable here: changing `srcdoc` can produce a
 * `load` for the intermediate `about:blank` document, and a listener attached
 * after the fact misses the real one entirely. Both failure modes leave the
 * caller holding a document with no body, which then measures as zero height.
 * Polling for actual content is boring and always correct.
 */
function waitForFrame(): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + 5000
    const poll = (): void => {
      const doc = frameDocument()
      const ready =
        !!doc &&
        !!doc.body &&
        (doc.body.childElementCount > 0 || (doc.body.textContent ?? '').trim().length > 0)
      if (ready || Date.now() > deadline) {
        resolve()
        return
      }
      window.setTimeout(poll, 50)
    }
    poll()
  })
}

function frameDocument(): Document | null {
  try {
    return iframeEl.value?.contentDocument ?? null
  } catch {
    // A cross-origin frame would throw; with `allow-same-origin` it should not,
    // but a null is a safe answer either way.
    return null
  }
}

/**
 * Size the frame to its content so the outer container owns the scrollbar.
 *
 * A ResizeObserver keeps this correct as images finish loading or the reader
 * changes the font size — both change the document height after first paint.
 */
let frameObserver: ResizeObserver | null = null

function fitFrame(): void {
  const frame = iframeEl.value
  const doc = frameDocument()
  if (!frame || !doc) return

  if (fixed.value) {
    // A pre-paginated page is exactly one screen; it never grows.
    frame.style.height = '100%'
    frameObserver?.disconnect()
    frameObserver = null
    return
  }

  const measure = (): void => {
    const height = Math.max(
      doc.documentElement?.scrollHeight ?? 0,
      doc.body?.scrollHeight ?? 0,
    )
    if (height > 0) frame.style.height = `${height}px`
  }
  measure()

  frameObserver?.disconnect()
  frameObserver = new ResizeObserver(measure)
  if (doc.body) frameObserver.observe(doc.body)
  if (doc.documentElement) frameObserver.observe(doc.documentElement)
}

function applyRestore(ratio?: number): void {
  const outer = scrollEl.value
  if (!outer) return
  if (fixed.value) {
    outer.scrollTop = 0
    return
  }
  if (typeof ratio !== 'number') {
    outer.scrollTop = 0
    return
  }
  const max = outer.scrollHeight - outer.clientHeight
  outer.scrollTop = clamp(ratio, 0, 1) * Math.max(0, max)
}

/** Turn `data-epub-href` anchors into navigation the parent controls. */
function wireLinks(): void {
  const doc = frameDocument()
  if (!doc) return
  doc.addEventListener('click', (event) => {
    const target = (event.target as Element | null)?.closest?.('[data-epub-href]')
    if (!target) return
    event.preventDefault()
    const href = target.getAttribute('data-epub-href')
    if (href) void followLink(href)
  })
}

/** Same-document fragments scroll here; cross-document targets switch chapters. */
async function followLink(href: string): Promise<void> {
  const pkg = book.value
  if (!pkg) return
  const { path, fragment } = splitFragment(href)
  const currentPath = pkg.spine[chapterIndex.value]

  if (!path || path === currentPath) {
    if (fragment) scrollToFragment(fragment)
    return
  }

  const target = pkg.spine.indexOf(path)
  if (target < 0) return
  chapterIndex.value = target
  await renderChapter()
  await nextTick()
  if (fragment) scrollToFragment(fragment)
  save()
}

/**
 * Scroll the outer container to an element inside the frame.
 *
 * `scrollIntoView` cannot be used: it would scroll the iframe's own document,
 * which no longer scrolls. The element's offset has to be translated into the
 * outer coordinate space by hand.
 */
function scrollToFragment(fragment: string): void {
  const doc = frameDocument()
  const frame = iframeEl.value
  const outer = scrollEl.value
  if (!doc || !frame || !outer) return

  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(fragment) : fragment
  const target =
    doc.getElementById(fragment) ?? doc.querySelector(`[name="${escaped}"]`)
  if (!target) return

  const delta = target.getBoundingClientRect().top - frame.getBoundingClientRect().top
  const gutter = parseFloat(getComputedStyle(outer).getPropertyValue('--space-5')) || 24
  outer.scrollTop += delta - gutter
}

/** Debounced progress write, same trailing-edge shape as the other viewers. */
let saveTimer: number | undefined
function scheduleSave(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(save, 600)
}

function save(): void {
  const pkg = book.value
  if (!pkg) return
  const payload: EpubProgress = {
    version: 1,
    chapter: chapterIndex.value,
    fontSize: fontSize.value,
    mode: mode.value,
  }
  if (!pkg.fixedLayout) {
    const ratio = currentRatio()
    if (ratio !== undefined) payload.ratio = ratio
  }
  void props.host.saveProgress(props.entry.id, payload)
}

function currentRatio(): number | undefined {
  const outer = scrollEl.value
  if (!outer || fixed.value) return undefined
  const max = outer.scrollHeight - outer.clientHeight
  return max > 0 ? clamp(outer.scrollTop / max, 0, 1) : 0
}

function onScroll(): void {
  scheduleSave()
}

async function goToChapter(index: number, restoreRatio?: number): Promise<void> {
  if (index < 0 || index >= total.value || index === chapterIndex.value) return
  chapterIndex.value = index
  tocOpen.value = false
  await renderChapter(restoreRatio)
  save()
}

function step(delta: number): void {
  void goToChapter(chapterIndex.value + delta)
}

/** Jump to a TOC entry: same chapter scrolls, another chapter switches. */
async function jumpTo(node: TocNode): Promise<void> {
  const pkg = book.value
  if (!pkg) return

  // A heading with no target is a section label; there is nowhere to go.
  if (!node.href) {
    tocOpen.value = false
    return
  }

  const index = pkg.spine.indexOf(node.href)
  if (index < 0) {
    tocOpen.value = false
    return
  }

  if (index === chapterIndex.value) {
    tocOpen.value = false
    if (node.fragment) scrollToFragment(node.fragment)
    return
  }

  chapterIndex.value = index
  tocOpen.value = false
  await renderChapter()
  await nextTick()
  if (node.fragment) scrollToFragment(node.fragment)
  save()
}

async function setMode(next: Mode): Promise<void> {
  if (next === mode.value) return
  // The two layouts share no geometry, so only the scroll ratio can carry over.
  const ratio = currentRatio()
  mode.value = next
  await renderChapter(ratio)
  save()
}

function changeFontSize(delta: number): void {
  fontSize.value = clamp(fontSize.value + delta, 13, 28)
  if (mode.value === 'reflow') void renderChapter(currentRatio())
  scheduleSave()
}

async function toggleFollowTheme(): Promise<void> {
  followTheme.value = !followTheme.value
  await renderChapter(currentRatio())
}

/** Arrow-key paging for fixed-layout books; Esc still belongs to the shell. */
function onKeydown(event: KeyboardEvent): void {
  if (!fixed.value) return
  if (event.defaultPrevented) return
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault()
    step(book.value?.pageDirection === 'rtl' ? 1 : -1)
  } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
    event.preventDefault()
    step(book.value?.pageDirection === 'rtl' ? -1 : 1)
  }
}

watch(
  () => props.entry.id,
  () => {
    chapterIndex.value = 0
    void load()
  },
)

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await load()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  frameObserver?.disconnect()
  frameObserver = null
  teardownResources()
})
</script>

<template>
  <div class="epub-viewer">
    <div v-if="!loading && !error && !drmProtected && book" class="epub-toolbar">
      <div class="chapter-nav">
        <button
          class="btn btn--tertiary"
          type="button"
          :aria-label="t('epub.prevChapter')"
          :disabled="atFirst"
          @click="step(-1)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M9 2L4 7l5 5" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
        <span class="chapter-label" :title="chapterLabel">{{ chapterLabel }}</span>
        <button
          class="btn btn--tertiary"
          type="button"
          :aria-label="t('epub.nextChapter')"
          :disabled="atLast"
          @click="step(1)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M5 2l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
      </div>

      <div class="controls">
        <button class="btn btn--tertiary" type="button" @click="tocOpen = true">
          {{ t('epub.toc') }}
        </button>

        <div v-if="!fixed" class="mode-switch" role="group" :aria-label="t('epub.mode')">
          <button
            class="mode-option"
            :class="{ 'is-active': mode === 'original' }"
            type="button"
            :aria-pressed="mode === 'original'"
            @click="setMode('original')"
          >
            {{ t('epub.modeOriginal') }}
          </button>
          <button
            class="mode-option"
            :class="{ 'is-active': mode === 'reflow' }"
            type="button"
            :aria-pressed="mode === 'reflow'"
            @click="setMode('reflow')"
          >
            {{ t('epub.modeReflow') }}
          </button>
        </div>

        <div v-if="mode === 'reflow' && !fixed" class="font-size">
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
          v-if="fixed"
          class="btn btn--tertiary"
          type="button"
          :aria-pressed="followTheme"
          @click="toggleFollowTheme"
        >
          {{ t('epub.followTheme') }}
        </button>

        <span class="page-indicator">{{ chapterIndex + 1 }} / {{ total }}</span>
      </div>
    </div>

    <div
      ref="scrollEl"
      class="epub-body"
      :class="{ 'is-fixed': fixed }"
      @scroll.passive="onScroll"
    >
      <div v-if="loading" class="state">{{ t('epub.loading') }}</div>

      <div v-else-if="drmProtected" class="state">
        <p class="state-title">{{ t('epub.drm.title') }}</p>
        <p class="state-body">{{ t('epub.drm.body') }}</p>
      </div>

      <div v-else-if="error" class="state">
        <p class="state-title">{{ t('viewer.error.title') }}</p>
        <p class="state-body">{{ error }}</p>
        <button class="btn btn--secondary" type="button" @click="load">
          {{ t('common.retry') }}
        </button>
      </div>

      <template v-else-if="book">
        <div v-if="chapterLoading" class="state">{{ t('common.loading') }}</div>

        <!-- `allow-same-origin` without `allow-scripts`: the document can be
             measured and styled from here, but cannot execute code. -->
        <iframe
          v-show="!chapterLoading && chapterHtml"
          ref="iframeEl"
          class="chapter-frame"
          :class="{ 'is-fixed': fixed }"
          :srcdoc="chapterHtml ?? undefined"
          sandbox="allow-same-origin"
          referrerpolicy="no-referrer"
          :title="chapterLabel"
        />

        <!-- Chapter footer: the linear model needs an explicit "next", and
             finishing a book should feel like finishing something. -->
        <div v-if="!chapterLoading && chapterHtml" class="chapter-footer">
          <button v-if="!atLast" class="btn btn--secondary next" type="button" @click="step(1)">
            {{ t('epub.nextChapter') }}
          </button>
          <p v-else class="end-note">{{ t('epub.finished') }}</p>
        </div>
      </template>
    </div>

    <!-- TOC drawer: overlays the text instead of narrowing it. -->
    <Transition name="drawer">
      <div v-if="tocOpen" class="toc-backdrop" @click.self="tocOpen = false">
        <aside class="toc-drawer" role="dialog" aria-modal="true" :aria-label="t('epub.toc')">
          <header class="toc-header">
            <h2 class="toc-title">{{ t('epub.toc') }}</h2>
            <button class="btn btn--tertiary" type="button" @click="tocOpen = false">
              {{ t('common.close') }}
            </button>
          </header>
          <nav class="toc-list">
            <p v-if="!tocFlat.length" class="toc-empty">{{ t('epub.tocEmpty') }}</p>
            <button
              v-for="(item, index) in tocFlat"
              :key="`${index}-${item.node.label}`"
              class="toc-item"
              :class="{ 'is-current': item.node.href === book?.spine[chapterIndex] }"
              :style="{ paddingLeft: `calc(var(--space-4) + ${item.depth} * var(--space-4))` }"
              type="button"
              @click="jumpTo(item.node)"
            >
              {{ item.node.label }}
            </button>
          </nav>
        </aside>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.epub-viewer {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.epub-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex: none;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--line-subtle);
  background: var(--surface-page);
}

.chapter-nav {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.chapter-label {
  max-width: 34ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: none;
}

.mode-switch {
  display: flex;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
}

.mode-option {
  height: var(--control-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.mode-option:hover {
  color: var(--ink-primary);
}

.mode-option.is-active {
  background: var(--surface-raised);
  color: var(--ink-primary);
  box-shadow: var(--shadow-e1);
}

.font-size {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.font-value {
  min-width: 2ch;
  text-align: center;
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.page-indicator {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.epub-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--surface-page);
}

/* Fixed layout owns the whole area and never scrolls: one page, one screen. */
.epub-body.is-fixed {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.chapter-frame {
  display: block;
  width: 100%;
  border: none;
  background: var(--surface-page);
}

.chapter-frame.is-fixed {
  flex: 1;
  min-height: 0;
}

.chapter-footer {
  display: flex;
  justify-content: center;
  padding: var(--space-6) var(--space-5) var(--space-8);
}

.next {
  min-width: 160px;
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
  color: var(--ink-secondary);
}

.state-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  color: var(--ink-primary);
}

.state-body {
  max-width: 46ch;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ink-secondary);
}

/* --- TOC drawer --------------------------------------------------------- */

.toc-backdrop {
  position: absolute;
  inset: 0;
  display: flex;
  background: color-mix(in srgb, var(--surface-page) 60%, transparent);
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

.toc-empty {
  padding: var(--space-4);
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

.toc-item {
  display: block;
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
</style>
