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

const videoEl = ref<HTMLVideoElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)
const muted = ref(false)
const rate = ref(1)
const fullscreen = ref(false)
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

async function toggleFullscreen(): Promise<void> {
  const shell = videoEl.value?.closest('.player') as HTMLElement | null
  if (!shell) return
  if (document.fullscreenElement) {
    await document.exitFullscreen()
  } else {
    await shell.requestFullscreen()
  }
}

function onFullscreenChange(): void {
  fullscreen.value = !!document.fullscreenElement
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
  <div class="player">
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
        <button class="btn btn--tertiary" type="button" :aria-label="t('player.play')" @click="togglePlay">
          {{ playing ? t('player.pause') : t('player.play') }}
        </button>
        <button class="btn btn--tertiary" type="button" @click="skip(-10)">
          −10s
        </button>
        <button class="btn btn--tertiary" type="button" @click="skip(10)">
          +10s
        </button>

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
</template>

<style scoped>
.player {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-page);
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
  gap: var(--space-2);
  padding: var(--space-3) var(--content-pad) var(--space-4);
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
   for free, and the browser's own hit area is larger than it looks. */
.progress {
  flex: 1;
  min-width: 0;
  accent-color: var(--surface-ink);
  cursor: pointer;
}

.time {
  flex: none;
  font-size: var(--text-xs);
  color: var(--ink-secondary);
  font-variant-numeric: tabular-nums;
}

.remaining {
  margin-left: var(--space-2);
  color: var(--ink-tertiary);
}

.controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
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
