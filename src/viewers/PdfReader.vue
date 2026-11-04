<script setup lang="ts">
/**
 * PDF viewer, backed by pdf.js rendered into canvases.
 *
 * Why pdf.js rather than a native engine: it renders identically on every
 * platform and needs no per-target native library, which is what keeps the
 * Android move cheap. The cost is that very large or vector-heavy documents
 * render slower than a native engine would.
 *
 * Rendering model: one canvas per page, mounted lazily by IntersectionObserver
 * and released when far off-screen. This keeps memory bounded on long
 * documents instead of allocating a canvas per page up front.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Entry, ViewerHost } from '@/types/viewer'
import { t } from '@/i18n'
import { clamp } from '@/utils/format'

const props = defineProps<{ entry: Entry; host: ViewerHost }>()

interface PdfProgress {
  version: 1
  page: number
}

// pdf.js is loaded lazily so the app starts instantly for text/audio users.
type PdfModule = typeof import('pdfjs-dist')
let pdfjs: PdfModule | null = null

const scrollEl = ref<HTMLElement | null>(null)
const canvasHosts = ref<HTMLElement[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const pageCount = ref(0)
const currentPage = ref(1)
const zoom = ref(1)
const needPassword = ref(false)
const passwordInput = ref('')
const passwordWrong = ref(false)

/** Page geometry from the document, used to size placeholders. */
interface PageBox {
  width: number
  height: number
}
const pageBoxes = ref<PageBox[]>([])

const doc = shallowRef<import('pdfjs-dist').PDFDocumentProxy | null>(null)
/** pdf.js 6 removed `PDFDocumentProxy.destroy`; teardown lives on the task. */
let loadingTask: import('pdfjs-dist').PDFDocumentLoadingTask | null = null
const rendered = new Set<number>()
const observers = new Map<number, IntersectionObserver>()
let resizeObserver: ResizeObserver | null = null
let passwordResolve: ((value: string) => void) | null = null
/** How many times the password prompt has appeared; 2+ means a wrong guess. */
let passwordAttempts = 0

const fitScale = ref(1)

/** Render scale: fit-to-width base times the zoom multiplier, capped by DPR. */
function scaleFor(): number {
  return fitScale.value * zoom.value
}

function computeFitScale(page: PageBox): number {
  const host = scrollEl.value
  if (!host) return 1
  // Leave a comfortable gutter on both sides; the page should never touch
  // the window edge. Read the gutter from the design system rather than
  // inventing a number here.
  const styles = getComputedStyle(host)
  const gutter =
    parseFloat(styles.getPropertyValue('--page-gutter')) || 96
  const available = host.clientWidth - gutter
  return clamp(available / page.width, 0.2, 4)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  needPassword.value = false
  passwordWrong.value = false
  rendered.clear()
  // Drop stale element references from the previous document; v-for hands us
  // fresh ones, and a leftover index would be observed twice.
  canvasHosts.value = []
  passwordAttempts = 0

  try {
    if (!pdfjs) {
      pdfjs = await import('pdfjs-dist')
      // The worker is copied verbatim into public/pdfjs by the build script;
      // pointing at it directly avoids bundler-specific worker plumbing.
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.min.mjs'
    }

    const bytes = await props.host.readBinary(props.entry.id)
    // Tear down any previous document before opening the next one, so paging
    // between two PDFs doesn't leave a worker and its buffers behind.
    if (loadingTask) {
      await loadingTask.destroy().catch(() => undefined)
      loadingTask = null
    }

    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
      iccUrl: '/pdfjs/iccs/',
    })

    task.onPassword = (update: (password: string) => void, reason: number) => {
      // reason 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD. Only the second is a
      // retry, so the message can say the password was wrong instead of just
      // silently re-prompting.
      passwordWrong.value = reason === 2 || passwordAttempts > 0
      passwordAttempts += 1
      needPassword.value = true
      passwordResolve = update
    }

    const loaded = await task.promise
    loadingTask = task
    doc.value = loaded
    pageCount.value = loaded.numPages

    // Read every page box up front so placeholders have the right aspect
    // ratio and the scrollbar doesn't jump as pages render.
    const first = await loaded.getPage(1)
    const viewport = first.getViewport({ scale: 1 })
    const boxes: PageBox[] = []
    for (let i = 1; i <= loaded.numPages; i += 1) {
      const page = i === 1 ? first : await loaded.getPage(i)
      const size = page.getViewport({ scale: 1 })
      boxes.push({ width: size.width, height: size.height })
      if (i !== 1) page.cleanup()
    }
    pageBoxes.value = boxes

    fitScale.value = computeFitScale(boxes[0] ?? { width: viewport.width, height: viewport.height })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    // pdf.js reports a cancelled load when the password prompt is dismissed.
    if (message.includes('PasswordException')) {
      needPassword.value = true
    } else {
      error.value = message
    }
  } finally {
    loading.value = false
    // Everything that touches page elements must wait until `loading` flips:
    // the placeholders live behind `v-else`, so before this point the host
    // array is empty and both scrolling and observing silently do nothing.
    await nextTick()
    if (!error.value && pageBoxes.value.length) {
      const stored = readStoredProgress()
      if (stored) {
        // Restore before observing, and without scheduling a save, so the
        // restored position isn't immediately overwritten by a page-1 write.
        restoring = true
        goToPage(stored.page, false)
        restoring = false
      }
      observePages()
    }
  }
}

function readStoredProgress(): PdfProgress | null {
  const raw = props.entry.progress
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<PdfProgress>
  if (candidate.version !== 1 || typeof candidate.page !== 'number') return null
  return candidate as PdfProgress
}

/** Save the current page, trailing-edge so paging stays snappy. */
let saveTimer: number | undefined
/** True while a restored position is being applied; suppresses saving. */
let restoring = false
function scheduleSave(): void {
  if (restoring) return
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    void props.host.saveProgress(props.entry.id, {
      version: 1,
      page: currentPage.value,
    } satisfies PdfProgress)
  }, 500)
}

async function renderPage(index: number): Promise<void> {
  const document_ = doc.value
  const host = canvasHosts.value[index]
  if (!document_ || !host || rendered.has(index)) return

  try {
    const pageNumber = index + 1
    const page = await document_.getPage(pageNumber)
    const scale = scaleFor()
    const viewport = page.getViewport({ scale })
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    host.replaceChildren(canvas)

    // Pass `canvas` only. pdf.js 6 derives the context itself when a canvas is
    // given; supplying a context we created with different options made the
    // render silently produce an empty surface.
    await page.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise

    rendered.add(index)
    page.cleanup()
  } catch (cause) {
    // A page that fails to paint must say so. Previously this rejection was
    // swallowed by the observer callback, leaving a blank page with no
    // explanation — the worst possible failure mode.
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function observePages(): void {
  for (const observer of observers.values()) observer.disconnect()
  observers.clear()

  canvasHosts.value.forEach((host, index) => {
    if (!host) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void renderPage(index)
          } else if (rendered.has(index)) {
            // Release far-away canvases so long PDFs don't accumulate memory.
            const canvas = host.querySelector('canvas')
            if (canvas) host.replaceChildren()
            rendered.delete(index)
          }
        }
      },
      // A generous margin pre-renders neighbours so scrolling feels seamless.
      { root: scrollEl.value, rootMargin: '600px 0px' },
    )
    observer.observe(host)
    observers.set(index, observer)
  })
}

function onScroll(): void {
  const host = scrollEl.value
  if (!host) return
  // Ignore scroll events while a restored position is being applied; the
  // browser reports intermediate offsets during the jump, and recording them
  // would clobber the very value being restored.
  if (restoring) return
  // Treat the page whose top sits closest to a small offset below the viewport
  // top as current. The offset is the design system's step, not a magic number.
  const offset = parseFloat(getComputedStyle(host).getPropertyValue('--space-5')) || 24
  const hostTop = host.getBoundingClientRect().top
  let best = 1
  let bestDistance = Number.POSITIVE_INFINITY
  canvasHosts.value.forEach((element, index) => {
    if (!element) return
    const distance = Math.abs(element.getBoundingClientRect().top - hostTop - offset)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index + 1
    }
  })
  if (best !== currentPage.value) {
    currentPage.value = best
    scheduleSave()
  }
}

function goToPage(page: number, smooth = true): void {
  const index = clamp(page, 1, pageCount.value) - 1
  const target = canvasHosts.value[index]
  if (!target) return
  target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
  currentPage.value = index + 1
  scheduleSave()
}

function step(delta: number): void {
  goToPage(currentPage.value + delta)
}

function changeZoom(factor: number): void {
  zoom.value = clamp(zoom.value * factor, 0.4, 4)
  rerenderAll()
}

function fitWidth(): void {
  zoom.value = 1
  const first = pageBoxes.value[0]
  if (first) fitScale.value = computeFitScale(first)
  rerenderAll()
}

/** Drop every canvas and let the observers repaint at the new scale. */
function rerenderAll(): void {
  rendered.clear()
  for (const host of canvasHosts.value) host?.replaceChildren()
  // Next frame, so layout has settled at the new size.
  requestAnimationFrame(() => observePages())
}

function submitPassword(): void {
  if (!passwordResolve) return
  const value = passwordInput.value
  passwordInput.value = ''
  needPassword.value = false
  passwordWrong.value = false
  passwordResolve(value)
  passwordResolve = null
}

function cancelPassword(): void {
  needPassword.value = false
  error.value = t('pdf.error')
  passwordResolve = null
}

const pageLabel = computed(() =>
  t('pdf.page', { page: currentPage.value, total: pageCount.value }),
)

watch(() => props.entry.id, () => {
  doc.value = null
  pageBoxes.value = []
  pageCount.value = 0
  void load()
})

onMounted(async () => {
  await load()

  resizeObserver = new ResizeObserver(() => {
    const first = pageBoxes.value[0]
    if (!first || !scrollEl.value) return
    const next = computeFitScale(first)
    if (Math.abs(next - fitScale.value) > 0.02) {
      fitScale.value = next
      rerenderAll()
    }
  })
  if (scrollEl.value) resizeObserver.observe(scrollEl.value)
})

onBeforeUnmount(() => {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  for (const observer of observers.values()) observer.disconnect()
  observers.clear()
  resizeObserver?.disconnect()
  void loadingTask?.destroy().catch(() => undefined)
  loadingTask = null
})
</script>

<template>
  <div class="pdf-viewer">
    <div class="pdf-toolbar">
      <div class="pager">
        <button
          class="btn btn--tertiary"
          type="button"
          :aria-label="t('pdf.prev')"
          :disabled="currentPage <= 1"
          @click="step(-1)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M9 2L4 7l5 5" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
        <span class="page-label">{{ pageLabel }}</span>
        <button
          class="btn btn--tertiary"
          type="button"
          :aria-label="t('pdf.next')"
          :disabled="currentPage >= pageCount"
          @click="step(1)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M5 2l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
      </div>

      <div class="zoomer">
        <button
          class="btn btn--tertiary"
          type="button"
          :aria-label="t('pdf.zoomOut')"
          :disabled="zoom <= 0.4"
          @click="changeZoom(1 / 1.2)"
        >
          −
        </button>
        <button class="btn btn--tertiary" type="button" @click="fitWidth">
          {{ t('pdf.fitWidth') }}
        </button>
        <button
          class="btn btn--tertiary"
          type="button"
          :aria-label="t('pdf.zoomIn')"
          :disabled="zoom >= 4"
          @click="changeZoom(1.2)"
        >
          +
        </button>
      </div>
    </div>

    <div ref="scrollEl" class="pdf-scroll" @scroll.passive="onScroll">
      <div v-if="loading" class="state">{{ t('pdf.loading') }}</div>
      <div v-else-if="error" class="state">
        <p class="state-title">{{ t('viewer.error.title') }}</p>
        <p class="state-body">{{ error }}</p>
        <button class="btn btn--secondary" type="button" @click="load">
          {{ t('common.retry') }}
        </button>
      </div>
      <div v-else class="pages">
        <div
          v-for="(box, index) in pageBoxes"
          :key="index"
          :ref="(el) => { if (el) canvasHosts[index] = el as HTMLElement }"
          class="page-host"
          :style="{
            width: `${Math.round(box.width * scaleFor())}px`,
            height: `${Math.round(box.height * scaleFor())}px`,
          }"
        />
      </div>
    </div>

    <!-- Password gate: a small modal, not a full-screen takeover, because the
         document is already behind it and context should stay visible. -->
    <div v-if="needPassword" class="gate" role="dialog" aria-modal="true">
      <form class="gate-card" @submit.prevent="submitPassword">
        <h2 class="gate-title">{{ t('pdf.password.title') }}</h2>
        <p class="gate-body">{{ t('pdf.password.body') }}</p>
        <input
          v-model="passwordInput"
          class="gate-input"
          type="password"
          :placeholder="t('pdf.password.placeholder')"
          autofocus
        />
        <p v-if="passwordWrong" class="gate-error">{{ t('pdf.password.wrong') }}</p>
        <div class="gate-actions">
          <button class="btn btn--tertiary" type="button" @click="cancelPassword">
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn--primary" type="submit">
            {{ t('pdf.password.submit') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.pdf-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.pdf-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-5);
  border-bottom: 1px solid var(--line-subtle);
  flex: none;
}

.pager,
.zoomer {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.page-label {
  min-width: 8ch;
  text-align: center;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  font-variant-numeric: tabular-nums;
}

.pdf-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* A slightly sunken backdrop makes white pages read as paper on a desk. */
  background: var(--surface-sunken);
  /* Horizontal breathing room around a fitted page, read by the fit logic. */
  --page-gutter: calc(var(--space-7) * 2);
}

.pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-6) var(--space-5) var(--space-8);
}

.page-host {
  background: var(--surface-raised);
  box-shadow: var(--shadow-e1);
  border-radius: var(--radius-sm);
  overflow: hidden;
  flex: none;
}

.page-host :deep(canvas) {
  display: block;
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

.gate {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.28);
}

.gate-card {
  width: min(360px, calc(100vw - var(--space-7)));
  padding: var(--space-5);
  background: var(--surface-raised);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-e3);
}

.gate-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}

.gate-body {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.gate-input {
  width: 100%;
  margin-top: var(--space-4);
  height: var(--control-lg);
  padding: 0 var(--space-3);
  background: var(--surface-page);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  font-size: var(--text-base);
}

.gate-error {
  margin-top: var(--space-2);
  font-size: var(--text-xs);
  color: var(--tone-danger);
}

.gate-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-5);
}
</style>
