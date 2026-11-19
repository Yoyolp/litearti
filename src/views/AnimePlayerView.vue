<script setup lang="ts">
/**
 * The video player.
 *
 * ## Why this is not a `<video src>` and done
 *
 * Real sources hand out HLS, not a single file. Chromium — and therefore WebView2
 * and WebKitGTK — cannot play HLS natively, so a `.m3u8` needs hls.js. Safari can,
 * so the native path is preferred when available: one less JS layer, and the
 * platform's own buffering heuristics.
 *
 * ## The proxy is not optional
 *
 * Every media request goes through `kazumi-stream://` (see `sources/stream.ts`),
 * because the Referer and User-Agent a source requires cannot be set on a plain
 * `<video src>`. Even for a URL that works directly, going through the proxy keeps
 * one code path — and keeps the origin from ever talking to the webview.
 *
 * ## What this deliberately does not do
 *
 * No danmaku, no casting, no upscaling. Those are separate features with their own
 * data and their own failure modes; folding them in here would make a file that is
 * already the largest in the app into the only file anyone can change.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@/i18n'
import { isStreamUrl, mediaTypeOf, streamUrl } from '@/sources/stream'

const props = defineProps<{
  /** Media URL as the source returned it (not yet proxied). */
  mediaUrl: string
  /** Referer the origin expects. */
  referer?: string | null
  /** User-Agent to present. */
  userAgent?: string | null
  /** Episode title, shown in the bar. */
  title: string
  /** Source name, shown as the second line. */
  sourceName: string
  /** Resume position in seconds. */
  startAt?: number
  /** Called with the current position, throttled to once a second. */
  onProgress?: (seconds: number, duration: number) => void
  /** Called when the media ends, for "play next". */
  onEnded?: () => void
}>()

/**
 * Leaving the player.
 *
 * Emitted rather than handled here because the parent owns the navigation state;
 * this component only knows that the person wants out. On desktop Escape does the
 * same thing through App.vue's global handler, but a phone has no keyboard, so
 * the button below is the only way back for most users.
 */
const emit = defineEmits<{ back: [] }>()

const videoEl = ref<HTMLVideoElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)
const muted = ref(false)
const rate = ref(1)
/** Whether the platform plays HLS without hls.js. */
const nativeHls = ref(false)

/**
 * Whether the browser genuinely demuxes HLS.
 *
 * `canPlayType` is a "maybe" API, and on WebView2 it answers `'maybe'` for
 * `application/vnd.apple.mpegurl` even though Chromium has no HLS demuxer — the
 * element then fails with `MEDIA_ERR_SRC_NOT_SUPPORTED`, which surfaces as a black
 * screen and error code 4. Trusting it costs the whole feature.
 *
 * So only `'probably'` counts. Safari and iOS webviews answer `'probably'`;
 * Chromium answers `'maybe'`, and for Chromium hls.js is the right path anyway
 * because MediaSource is available.
 */
function hasNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') === 'probably'
}

/**
 * hls.js instance, kept out of reactive state.
 *
 * Wrapping a large object graph in a `ref` makes Vue walk it on every access,
 * which is both slow and pointless — nothing in the template reads it.
 */
let hls: import('hls.js').default | null = null

/** The proxied URL the player actually uses. */
const playbackUrl = computed(() =>
  streamUrl({
    url: props.mediaUrl,
    referer: props.referer ?? null,
    userAgent: props.userAgent ?? null,
  }),
)

const kind = computed(() => mediaTypeOf(props.mediaUrl))

/** Seconds left, for the remaining-time readout. */
const remaining = computed(() =>
  duration.value > 0 ? Math.max(0, duration.value - currentTime.value) : 0,
)

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Load the media, choosing native HLS or hls.js. */
async function load(): Promise<void> {
  const video = videoEl.value
  if (!video) return

  loading.value = true
  error.value = null
  destroyHls()

  const url = playbackUrl.value
  const type = kind.value

  try {
    // Native HLS only when the engine really demuxes it; see `hasNativeHls`.
    const canNativeHls = hasNativeHls(video)
    nativeHls.value = type === 'hls' && canNativeHls

    if (type === 'hls' && !canNativeHls) {
      const { default: Hls } = await import('hls.js')
      if (!Hls.isSupported()) {
        throw new Error(
          '这个环境不支持 HLS 播放（缺少 MediaSource）。mp4 源仍然可以播放。',
        )
      }
      const instance = new Hls({
        // A short playlist is the norm for VOD; letting hls.js buffer far ahead
        // wastes memory on a file the person may close in ten seconds.
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        // The proxy adds one hop, so the default is a little tight.
        manifestLoadingTimeOut: 20000,
        levelLoadingTimeOut: 20000,
        fragLoadingTimeOut: 30000,
      })
      hls = instance
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        // Fatal errors are the ones worth telling someone about; a recovered
        // fragment retry is noise.
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            error.value = `加载视频失败：${data.details}。可能是源已失效，或者防盗链拒绝了请求。`
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            error.value = `视频解码失败：${data.details}。这个格式可能不受支持。`
            break
          default:
            error.value = `播放失败：${data.details}`
        }
        loading.value = false
      })
      instance.loadSource(url)
      instance.attachMedia(video)
      // hls.js needs the manifest parsed before playback can start; calling
      // `play()` earlier is a no-op on some versions. The event is the reliable
      // signal, and it is also where a resume seek belongs.
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        applyResumeSeek(video)
        void attemptPlay()
      })
    } else {
      video.src = url
      // Native playback: wait for metadata, then seek and play.
      const onReady = () => {
        applyResumeSeek(video)
        void attemptPlay()
        video.removeEventListener('loadedmetadata', onReady)
      }
      video.addEventListener('loadedmetadata', onReady)
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    loading.value = false
  }
}

/**
 * Jump to the saved position, if there is one worth jumping to.
 *
 * Under two seconds is the beginning: seeking there would just be a visual jump
 * for no benefit, and a resume point of 0.4s usually means "started and stopped".
 */
function applyResumeSeek(video: HTMLVideoElement): void {
  const start = props.startAt ?? 0
  if (start <= 2) return
  // A duration of 0 or NaN means metadata is not ready; the caller already
  // guarantees it is, but a defensive check costs nothing.
  if (!Number.isFinite(video.duration) || video.duration <= 0) return
  // Do not seek into the last two seconds of a finished file — that would land on
  // the end card and immediately fire `ended`.
  if (start >= video.duration - 2) return
  video.currentTime = start
}

/**
 * Try to start playback, tolerating a policy rejection.
 *
 * Browsers block autoplay with sound until the user has interacted with the page.
 * Inside a desktop app that interaction already happened (the click that opened
 * this screen), so it normally succeeds — but a rejection is not a failure, and
 * surfacing it as one would be wrong.
 *
 * `muted` is *not* forced: muting to sneak past the policy would silently rob
 * someone of audio, which is worse than a visible play button.
 */
async function attemptPlay(): Promise<void> {
  const video = videoEl.value
  if (!video) return
  try {
    await video.play()
  } catch {
    // Autoplay declined. The centre overlay button is already rendered because
    // `playing` is still false, so there is nothing to report.
  }
}

function destroyHls(): void {
  if (hls) {
    hls.destroy()
    hls = null
  }
}

// --- Playback state --------------------------------------------------------

let lastReported = 0

function onTimeUpdate(): void {
  const video = videoEl.value
  if (!video) return
  currentTime.value = video.currentTime
  // Report at most once a second: the caller writes to disk, and a progress write
  // per frame would be absurd.
  const now = Date.now()
  if (props.onProgress && now - lastReported > 1000) {
    lastReported = now
    props.onProgress(video.currentTime, video.duration || 0)
  }
}

function onLoadedMetadata(): void {
  const video = videoEl.value
  if (!video) return
  duration.value = video.duration || 0
  loading.value = false
}

function onPlaying(): void {
  playing.value = true
  loading.value = false
}

function onPause(): void {
  playing.value = false
}

function onWaiting(): void {
  loading.value = true
}

function onCanPlay(): void {
  loading.value = false
}

function onError(): void {
  loading.value = false
  const video = videoEl.value
  const code = video?.error?.code
  // The proxy explains its own failures in the response body, but a media element
  // only reports a numeric code. Map the useful ones and point at the proxy.
  switch (code) {
    case 1:
      error.value = '播放被中止。'
      break
    case 2:
      error.value = isStreamUrl(playbackUrl.value)
        ? '读取视频失败：源站拒绝了请求，或者这个地址已经失效。'
        : '读取视频失败。'
      break
    case 3:
      error.value = '视频解码失败，这个格式可能不受支持。'
      break
    case 4:
      error.value = '这个视频无法播放：地址失效或格式不支持。'
      break
    default:
      error.value = '播放失败。'
  }
}

// --- Controls --------------------------------------------------------------

function togglePlay(): void {
  const video = videoEl.value
  if (!video) return
  if (video.paused) void video.play()
  else video.pause()
}

function seekTo(seconds: number): void {
  const video = videoEl.value
  if (!video || !Number.isFinite(seconds)) return
  video.currentTime = Math.max(0, Math.min(seconds, duration.value || seconds))
}

function onSeekInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  seekTo(value)
}

function skip(delta: number): void {
  seekTo(currentTime.value + delta)
}

function setVolume(value: number): void {
  const video = videoEl.value
  if (!video) return
  volume.value = Math.max(0, Math.min(1, value))
  video.volume = volume.value
  muted.value = volume.value === 0
}

function toggleMute(): void {
  const video = videoEl.value
  if (!video) return
  video.muted = !video.muted
  muted.value = video.muted
}

function setRate(value: number): void {
  const video = videoEl.value
  if (!video) return
  rate.value = value
  video.playbackRate = value
}

/**
 * Fullscreen state.
 *
 * Two mechanisms, because no single one works everywhere:
 *
 * - `nativeFullscreen` is the real Fullscreen API. It works on desktop and is what
 *   gives a true OS-level fullscreen there.
 * - `pseudoFullscreen` is a CSS-only mode that pins the player over the whole
 *   viewport. It exists because **Android's WebView cannot do the real thing in
 *   this stack**: wry's `RustWebChromeClient.onShowCustomView` calls
 *   `callback.onCustomViewHidden()` immediately instead of adopting the custom
 *   view, so a `requestFullscreen()` is granted and revoked in the same frame and
 *   the button appears to do nothing at all.
 *
 * The CSS mode is used as the fallback rather than an error, so the control always
 * does something the person can see.
 */
const nativeFullscreen = ref(false)
const pseudoFullscreen = ref(false)

/** True when either mechanism is active, for the button's label. */
const fullscreen = computed(() => nativeFullscreen.value || pseudoFullscreen.value)

function onFullscreenChange(): void {
  nativeFullscreen.value = document.fullscreenElement !== null
  // A real fullscreen supersedes the CSS one; leaving both on would strand the
  // pseudo class on the element after the person exits native fullscreen.
  if (nativeFullscreen.value) pseudoFullscreen.value = false
}

async function toggleFullscreen(): Promise<void> {
  if (fullscreen.value) {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined)
    }
    pseudoFullscreen.value = false
    return
  }

  const shell = videoEl.value?.closest('.player') as HTMLElement | null
  if (!shell) return

  // Try the real API first: on desktop it gives a proper fullscreen window, and
  // on Android it may one day be implemented. A rejected promise (or a grant that
  // is revoked straight away) falls through to the CSS mode.
  try {
    await shell.requestFullscreen()
    // Browsers resolve `requestFullscreen` even when the result is immediately
    // discarded, so success is judged by the state, not by the promise.
    if (document.fullscreenElement) return
  } catch {
    // Denied or unsupported — the CSS mode below covers both.
  }

  pseudoFullscreen.value = true
}

function onEnded(): void {
  playing.value = false
  props.onEnded?.()
}

/** Keyboard: the standard player set, so muscle memory works. */
function onKeydown(event: KeyboardEvent): void {
  // Never steal keys from a field the person is typing in.
  const target = event.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

  switch (event.key) {
    case 'Escape':
      // Fullscreen is the platform's to unwind; if the picture is not
      // fullscreen, Escape means "leave the player". Letting fullscreen handle
      // it first avoids dropping the person out of the page when they only
      // wanted their desktop back.
      if (document.fullscreenElement) return
      event.preventDefault()
      emit('back')
      break
    case ' ':
      event.preventDefault()
      togglePlay()
      break
    case 'ArrowLeft':
      event.preventDefault()
      skip(-5)
      break
    case 'ArrowRight':
      event.preventDefault()
      skip(5)
      break
    case 'ArrowUp':
      event.preventDefault()
      setVolume(volume.value + 0.05)
      break
    case 'ArrowDown':
      event.preventDefault()
      setVolume(volume.value - 0.05)
      break
    case 'f':
    case 'F':
      event.preventDefault()
      void toggleFullscreen()
      break
    default:
      break
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  await load()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  destroyHls()
  const video = videoEl.value
  if (video) {
    video.pause()
    // Clearing the source stops the proxy request from continuing to stream into
    // a detached element.
    video.removeAttribute('src')
    video.load()
  }
})

// A new episode means a fresh pipeline: reusing the hls.js instance across
// different media is a known source of stale-buffer bugs.
watch(
  () => props.mediaUrl,
  async () => {
    destroyHls()
    currentTime.value = 0
    duration.value = 0
    await load()
  },
)
</script>

<template>
  <div class="player" :class="{ 'is-pseudo-fullscreen': pseudoFullscreen }">
    <div class="stage">
      <video
        ref="videoEl"
        class="video"
        playsinline
        preload="metadata"
        @timeupdate="onTimeUpdate"
        @loadedmetadata="onLoadedMetadata"
        @playing="onPlaying"
        @pause="onPause"
        @waiting="onWaiting"
        @canplay="onCanPlay"
        @error="onError"
        @ended="onEnded"
        @click="togglePlay"
      />

      <div v-if="loading && !error" class="overlay">
        <p class="overlay-text">{{ t('player.loading') }}</p>
      </div>

      <!-- The way out. On a phone there is no Escape key, and this screen has no
           other navigation chrome: without it the only exit is the system back
           gesture, which is not discoverable and not present on every device.
           Placed over the picture (top-left) because the bar below is dense and
           the top of a video frame is conventionally empty at the start. -->
      <button
        class="btn back-overlay"
        type="button"
        :aria-label="t('player.back')"
        @click="emit('back')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ t('player.back') }}</span>
      </button>

      <div v-if="error" class="overlay is-error">
        <p class="overlay-title">{{ t('player.error.title') }}</p>
        <p class="overlay-text">{{ error }}</p>
        <button class="btn btn--secondary" type="button" @click="load">
          {{ t('common.retry') }}
        </button>
      </div>

      <!-- A big centre button only while paused and not errored: a permanent
           overlay would sit over the picture. -->
      <button
        v-if="!playing && !loading && !error"
        class="center-play"
        type="button"
        :aria-label="t('player.play')"
        @click="togglePlay"
      >
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5l12 7-12 7z" fill="currentColor" />
        </svg>
      </button>
    </div>

    <div class="bar">
      <div class="bar-title">
        <span class="episode-title" :title="title">{{ title }}</span>
        <span class="source-name">{{ sourceName }}</span>
      </div>

      <div class="progress-row">
        <input
          class="progress"
          type="range"
          min="0"
          :max="duration || 0"
          step="0.1"
          :value="currentTime"
          :aria-label="t('player.progress')"
          @input="onSeekInput"
        />
        <span class="time">
          {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
          <span v-if="remaining > 0" class="remaining">−{{ formatTime(remaining) }}</span>
        </span>
      </div>

      <div class="controls">
        <!-- Transport: the three things a hand reaches for most. -->
        <div class="control-group">
          <button class="btn btn--tertiary" type="button" :aria-label="t('player.play')" @click="togglePlay">
            {{ playing ? t('player.pause') : t('player.play') }}
          </button>
          <button class="btn btn--tertiary" type="button" :aria-label="t('player.skipBack')" @click="skip(-10)">
            −10s
          </button>
          <button class="btn btn--tertiary" type="button" :aria-label="t('player.skipForward')" @click="skip(10)">
            +10s
          </button>
        </div>

        <!-- Environment: settings that change how it plays, not what plays. -->
        <div class="control-group">
          <label class="volume">
            <button class="btn btn--tertiary" type="button" :aria-label="t('player.mute')" @click="toggleMute">
              {{ muted || volume === 0 ? t('player.muted') : t('player.volume') }}
            </button>
            <input
              class="volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="muted ? 0 : volume"
              :aria-label="t('player.volume')"
              @input="setVolume(Number(($event.target as HTMLInputElement).value))"
            />
          </label>

          <label class="rate">
            <select
              class="rate-select"
              :value="rate"
              :aria-label="t('player.rate')"
              @change="setRate(Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="option in [0.5, 0.75, 1, 1.25, 1.5, 2]" :key="option" :value="option">
                {{ option }}×
              </option>
            </select>
          </label>

          <button class="btn btn--tertiary fullscreen" type="button" @click="toggleFullscreen">
            {{ fullscreen ? t('player.exitFullscreen') : t('player.fullscreen') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.player {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-page);
}

/* CSS fullscreen.
   Used where the Fullscreen API is unavailable (Android WebView — see the
   `toggleFullscreen` comment). `position: fixed` with `inset: 0` covers the
   viewport including area under the notch, which is the intent of fullscreen:
   the picture, nothing else. `z-index` must beat the app shell's stacking, and
   `background: #000` hides whatever is behind rather than letting it bleed
   around the letterbox. */
.player.is-pseudo-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 1000;
  height: 100%;
  background: #000;
}

/* The inset is not automatic: the shell is a flex column, and a fixed child
   still resolves against the viewport, so the bottom bar would otherwise be
   covered — which is correct for fullscreen, but the *content* must not slide
   under the gesture bar. Applied to the control bar so buttons stay reachable. */
.player.is-pseudo-fullscreen .bar {
  padding-bottom: calc(var(--space-3) + var(--safe-bottom));
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Black behind the picture regardless of theme: a light letterbox around video
     reads as a broken player. */
  background: #000;
}

.video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-6);
  text-align: center;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}

/* Both text and icon are white because this sits on video, not on a themed
   surface — the design system's ink tokens would be unreadable over an
   arbitrary frame. `backdrop-filter` keeps it legible over a bright scene
   without resorting to an opaque box. */
.back-overlay {
  position: absolute;
  top: var(--space-3);
  left: var(--space-3);
  z-index: 2;
  gap: var(--space-1);
  height: var(--control-md);
  padding: 0 var(--space-3);
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
  border-radius: var(--radius-full);
  backdrop-filter: blur(8px);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.back-overlay:hover {
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
}

/* Clear the status bar / cutout: this button is the topmost thing on a
   full-screen screen, so it owns the inset. */
@media (max-width: 719px) {
  .back-overlay {
    top: calc(var(--space-3) + var(--safe-top));
    left: calc(var(--space-3) + var(--safe-left));
    /* A real touch target, and large enough that the label can show without
       crowding the picture. */
    height: var(--hit-touch);
  }
}

.overlay-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
}

.overlay-text {
  max-width: 46ch;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: rgba(255, 255, 255, 0.82);
}

.center-play {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: var(--radius-full);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  transition: transform var(--duration-fast) var(--ease-out);
}

.center-play:hover {
  transform: scale(1.05);
}

.center-play:active {
  transform: scale(0.96);
}

/* --- Bar ---------------------------------------------------------------- */
.bar {
  flex: none;
  display: flex;
  flex-direction: column;
  /* Tighter than the page rhythm: this is a control cluster, and the grouping
     inside each cluster already carries the separation. */
  gap: var(--space-2);
  padding: var(--space-3) var(--content-pad) var(--space-3);
  border-top: 1px solid var(--line-subtle);
  background: var(--surface-page);
}

.bar-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  min-width: 0;
}

.episode-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-name {
  flex: none;
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.progress-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* The track uses a plain range input: it gets native keyboard and Touch support
   for free, and the browser's own hit area is larger than it looks. The height
   is set explicitly so the thumb is a finger-sized target rather than the
   browser's hairline default. */
.progress {
  flex: 1;
  min-width: 0;
  height: var(--hit-min);
  accent-color: var(--surface-ink);
  cursor: pointer;
}

.time {
  flex: none;
  font-size: var(--text-xs);
  color: var(--ink-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.remaining {
  margin-left: var(--space-2);
  color: var(--ink-tertiary);
}

/* Controls as three groups instead of one wrapping row.
   Left: transport (play, ±10s). Right: environment (mute, rate, fullscreen).
   `space-between` puts them at opposite ends, which is where a hand expects
   them; `flex-wrap` keeps the groups intact when they do not both fit, rather
   than splitting a group across two lines. */
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.control-group {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.volume {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: var(--space-2);
}

.volume-slider {
  width: var(--volume-width);
  accent-color: var(--surface-ink);
}

/* Below the phone breakpoint the volume slider has no room; the mute toggle
   still works and the hardware keys do the rest. */
@media (max-width: 719px) {
  .volume-slider {
    display: none;
  }

  .bar {
    /* The control bar is the last thing on screen, so it owns the bottom
       inset: without this the buttons sit under the gesture bar. */
    padding-bottom: calc(var(--space-3) + var(--safe-bottom));
  }

  /* Transport controls get real touch targets and the two skip buttons sit
     next to play, which is the arrangement every video app uses. */
  .controls .btn {
    min-height: var(--hit-touch);
  }
}

.rate-select {
  height: var(--control-sm);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface-raised);
  font-size: var(--text-xs);
  color: var(--ink-secondary);
}

.rate {
  margin-left: var(--space-2);
}

.fullscreen {
  margin-left: auto;
}
</style>
