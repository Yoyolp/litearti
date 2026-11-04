<script setup lang="ts">
/**
 * Audio viewer: a single-file player.
 *
 * Deliberately not a playlist. One file, one player, resume where you left
 * off. A playlist would imply queue management, which is a whole surface the
 * MVP has not earned.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Entry, ViewerHost } from '@/types/viewer'
import { t } from '@/i18n'
import { clamp, formatDuration } from '@/utils/format'

const props = defineProps<{ entry: Entry; host: ViewerHost }>()

interface AudioProgress {
  version: 1
  time: number
  rate?: number
}

const audioEl = ref<HTMLAudioElement | null>(null)
const src = ref('')
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const rate = ref(1)
const volume = ref(1)
const error = ref<string | null>(null)
const loading = ref(true)

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const

function readStoredProgress(): AudioProgress | null {
  const raw = props.entry.progress
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<AudioProgress>
  if (candidate.version !== 1 || typeof candidate.time !== 'number') return null
  return candidate as AudioProgress
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const url = await props.host.entryUrl(props.entry.id)
    const stored = readStoredProgress()
    if (stored) rate.value = stored.rate ?? 1
    // Assign last: the <audio> element only exists once `src` is set, so the
    // element ref is only valid after this assignment plus a tick.
    src.value = url
    await nextTick()

    const el = audioEl.value
    if (el) {
      el.playbackRate = rate.value
      el.volume = volume.value
    }

    if (stored && el) {
      // Defer the seek until metadata exists; setting currentTime earlier is
      // silently discarded by most engines.
      const apply = () => {
        const target = audioEl.value
        if (!target) return
        if (Number.isFinite(target.duration) && stored.time < target.duration) {
          target.currentTime = stored.time
        }
        target.playbackRate = rate.value
        target.removeEventListener('loadedmetadata', apply)
      }
      if (el.readyState >= 1) apply()
      else el.addEventListener('loadedmetadata', apply)
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

/** Save position on a trailing edge so playback isn't disturbed. */
let saveTimer: number | undefined
function scheduleSave(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    void props.host.saveProgress(props.entry.id, {
      version: 1,
      time: currentTime.value,
      rate: rate.value,
    } satisfies AudioProgress)
  }, 800)
}

function toggle(): void {
  const el = audioEl.value
  if (!el) return
  if (el.paused) void el.play()
  else el.pause()
}

function onTimeUpdate(): void {
  const el = audioEl.value
  if (!el) return
  currentTime.value = el.currentTime
  scheduleSave()
}

function onLoadedMetadata(): void {
  const el = audioEl.value
  if (!el) return
  duration.value = Number.isFinite(el.duration) ? el.duration : 0
  el.playbackRate = rate.value
  el.volume = volume.value
}

function onSeek(event: Event): void {
  const el = audioEl.value
  const target = event.target as HTMLInputElement
  if (!el) return
  el.currentTime = Number(target.value)
  currentTime.value = el.currentTime
  scheduleSave()
}

function setRate(value: number): void {
  rate.value = value
  if (audioEl.value) audioEl.value.playbackRate = value
  scheduleSave()
}

function setVolume(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  volume.value = value
  if (audioEl.value) audioEl.value.volume = value
}

function skip(seconds: number): void {
  const el = audioEl.value
  if (!el) return
  el.currentTime = clamp(el.currentTime + seconds, 0, duration.value || el.duration)
  currentTime.value = el.currentTime
  scheduleSave()
}

function onKeydown(event: KeyboardEvent): void {
  // Space toggles only when the control itself isn't focused, so buttons keep
  // their normal activation behaviour.
  if (event.code === 'Space' && (event.target as HTMLElement)?.tagName !== 'BUTTON') {
    event.preventDefault()
    toggle()
  }
}

const progressPercent = computed(() => {
  if (!duration.value) return 0
  return clamp((currentTime.value / duration.value) * 100, 0, 100)
})

const timeLabel = computed(() =>
  t('audio.position', {
    current: formatDuration(currentTime.value),
    duration: formatDuration(duration.value),
  }),
)

onMounted(() => {
  void load()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  const el = audioEl.value
  if (el) {
    // Flush the last position; pausing first keeps the write consistent.
    el.pause()
    void props.host.saveProgress(props.entry.id, {
      version: 1,
      time: el.currentTime,
      rate: rate.value,
    } satisfies AudioProgress)
  }
})
</script>

<template>
  <div class="audio-viewer">
    <div v-if="loading" class="state">{{ t('common.loading') }}</div>
    <div v-else-if="error" class="state">
      <p class="state-title">{{ t('audio.unsupported') }}</p>
      <p class="state-body">{{ error }}</p>
    </div>

    <div v-else class="player">
      <!-- The title is the largest thing here: for audio, the identity of the
           file is the only thing worth reading on screen. -->
      <h1 class="player-title">{{ props.entry.title }}</h1>

      <div class="scrubber">
        <input
          class="range range--seek"
          type="range"
          min="0"
          :max="duration || 0"
          step="0.1"
          :value="currentTime"
          :style="{ '--fill': `${progressPercent}%` }"
          :aria-label="timeLabel"
          @input="onSeek"
        />
        <div class="times">
          <span>{{ formatDuration(currentTime) }}</span>
          <span>{{ formatDuration(duration) }}</span>
        </div>
      </div>

      <div class="transport">
        <button class="btn btn--tertiary skip" type="button" aria-label="后退 10 秒" @click="skip(-10)">
          −10s
        </button>

        <button class="play" type="button" :aria-label="playing ? t('audio.pause') : t('audio.play')" @click="toggle">
          <svg v-if="!playing" width="20" height="22" viewBox="0 0 20 22" aria-hidden="true">
            <path d="M3 2l15 9-15 9z" fill="currentColor" />
          </svg>
          <svg v-else width="18" height="20" viewBox="0 0 18 20" aria-hidden="true">
            <rect x="2" y="2" width="5" height="16" rx="1.5" fill="currentColor" />
            <rect x="11" y="2" width="5" height="16" rx="1.5" fill="currentColor" />
          </svg>
        </button>

        <button class="btn btn--tertiary skip" type="button" aria-label="前进 10 秒" @click="skip(10)">
          +10s
        </button>
      </div>

      <div class="extras">
        <div class="speeds" role="group" :aria-label="t('audio.speed')">
          <button
            v-for="speed in SPEEDS"
            :key="speed"
            type="button"
            class="speed"
            :class="{ 'is-active': rate === speed }"
            @click="setRate(speed)"
          >
            {{ speed }}×
          </button>
        </div>

        <label class="volume">
          <span class="visually-hidden">{{ t('audio.volume') }}</span>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" class="volume-icon">
            <path d="M2 6v4h3l4 3V3L5 6z" fill="currentColor" />
          </svg>
          <input
            class="range range--volume"
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="volume"
            :style="{ '--fill': `${volume * 100}%` }"
            @input="setVolume"
          />
        </label>
      </div>
    </div>

    <!-- Only mount the element once a source exists. An <audio> with src=""
         fires `error` immediately, which would show "cannot play" for a file
         that is perfectly fine. -->
    <audio
      v-if="src"
      ref="audioEl"
      :src="src"
      preload="metadata"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onLoadedMetadata"
      @play="playing = true"
      @pause="playing = false"
      @ended="playing = false"
      @error="error = t('audio.unsupported')"
    />
  </div>
</template>

<style scoped>
.audio-viewer {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: var(--space-6);
}

.player {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  width: min(440px, 100%);
}

.player-title {
  font-size: var(--text-xl);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
  /* Titles can be long file names; allow two lines then clamp. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.scrubber {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.times {
  display: flex;
  justify-content: space-between;
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-5);
}

.skip {
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.play {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--space-8);
  height: var(--space-8);
  border-radius: var(--radius-full);
  background: var(--surface-ink);
  color: var(--ink-inverse);
  box-shadow: var(--shadow-e2);
  transition:
    transform var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}

.play:hover {
  background: var(--surface-ink-hover);
}

.play:active {
  transform: scale(0.96);
  box-shadow: var(--shadow-e1);
}

.extras {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--line-subtle);
}

.speeds {
  display: flex;
  gap: var(--space-1);
}

.speed {
  min-width: var(--ext-column);
  height: var(--control-sm);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
  transition: background-color var(--duration-fast) var(--ease-out);
}

.speed:hover {
  background: var(--surface-hover);
  color: var(--ink-secondary);
}

.speed.is-active {
  background: var(--surface-active);
  color: var(--ink-primary);
  font-weight: var(--weight-strong);
}

.volume {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-tertiary);
}

.volume-icon {
  flex: none;
}

/* One range style for both scrubber and volume: track + filled portion,
   drawn with a gradient so no extra DOM is needed. */
.range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: var(--track-thickness);
  border-radius: var(--radius-full);
  background: linear-gradient(
    to right,
    var(--ink-secondary) 0%,
    var(--ink-secondary) var(--fill, 0%),
    var(--line-strong) var(--fill, 0%),
    var(--line-strong) 100%
  );
  cursor: pointer;
}

.range--volume {
  width: var(--volume-width);
}

.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: var(--thumb-size);
  height: var(--thumb-size);
  border-radius: var(--radius-full);
  background: var(--surface-raised);
  box-shadow: var(--shadow-e1), 0 0 0 1px var(--line-strong);
  transition: transform var(--duration-fast) var(--ease-out);
}

.range::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

.range::-moz-range-thumb {
  width: var(--thumb-size);
  height: var(--thumb-size);
  border: none;
  border-radius: var(--radius-full);
  background: var(--surface-raised);
  box-shadow: var(--shadow-e1), 0 0 0 1px var(--line-strong);
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
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
}
</style>
