<script setup lang="ts">
/**
 * Trial run: execute one stage of a source and show what came back.
 *
 * The editor's per-field tester answers "what does this selector match". This
 * answers "does the whole stage work" — search, then detail, then chapter — with
 * timing, HTTP status and the skipped-node diagnoses in one place. The two are
 * complementary: the tester is for writing a selector, this is for confirming a
 * source.
 *
 * The request URL is shown because "the source built the wrong URL" is the most
 * common cause of an empty result, and no amount of selector inspection reveals
 * it.
 */
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { t } from '@/i18n'
import { useSourcesStore } from '@/stores/sources'
import { SourceEngine, type Diagnosis, type SourceChapter, type SourceItem } from '@/sources/engine'
import { SelectorError } from '@/sources/selector'

const props = defineProps<{ sourceId: string }>()
const emit = defineEmits<{ back: [] }>()

const store = useSourcesStore()

type Stage = 'search' | 'detail' | 'chapter'

const stage = ref<Stage>('search')
const input = ref('')
const running = ref(false)
const error = ref<string | null>(null)
const sandboxMount = ref<HTMLElement | null>(null)
const engine = shallowRef<SourceEngine | null>(null)

interface StageResult {
  stage: Stage
  requestUrl: string
  status: number | null
  elapsedMs: number
  items: SourceItem[]
  chapters: SourceChapter[]
  text: string
  diagnoses: Diagnosis[]
}

const result = ref<StageResult | null>(null)

const source = computed(() => store.byId(props.sourceId))

const STAGE_LABELS: Record<Stage, string> = {
  search: t('source.trialSearch'),
  detail: t('source.trialDetail'),
  chapter: t('source.trialChapters'),
}

function ensureEngine(): SourceEngine | null {
  const current = source.value
  if (!current) return null
  if (engine.value) return engine.value
  engine.value = new SourceEngine(current, undefined, sandboxMount.value ?? undefined)
  return engine.value
}

/** Where the request actually went, with placeholders filled in. */
function predictUrl(value: string, currentStage: Stage): string {
  const base = source.value
  if (!base) return ''
  if (currentStage === 'search') {
    return base.search.url
      .replace(/\{\{keyword\}\}/g, encodeURIComponent(value))
      .replace(/\{\{page\}\}/g, '1')
  }
  return value
}

async function run(): Promise<void> {
  const value = input.value.trim()
  if (!value) {
    error.value = t('source.trialNeedInput')
    return
  }
  const active = ensureEngine()
  if (!active) {
    error.value = '源不存在'
    return
  }

  running.value = true
  error.value = null
  result.value = null
  const startedAt = Date.now()
  const requestUrl = predictUrl(value, stage.value)

  try {
    if (stage.value === 'search') {
      const { items, diagnoses } = await active.searchWithDiagnoses(value)
      result.value = {
        stage: 'search',
        requestUrl,
        status: null,
        elapsedMs: Date.now() - startedAt,
        items,
        chapters: [],
        text: '',
        diagnoses,
      }
    } else if (stage.value === 'detail') {
      const detail = await active.detail(value)
      result.value = {
        stage: 'detail',
        requestUrl,
        status: null,
        elapsedMs: Date.now() - startedAt,
        items: [],
        chapters: detail.chapters,
        text: [detail.title, detail.author, detail.intro].filter(Boolean).join('\n'),
        diagnoses: detail.diagnoses,
      }
    } else {
      const body = await active.chapter(value)
      result.value = {
        stage: 'chapter',
        requestUrl,
        status: null,
        elapsedMs: Date.now() - startedAt,
        items: [],
        chapters: [],
        text: body,
        diagnoses: [],
      }
    }
  } catch (cause) {
    error.value =
      cause instanceof SelectorError
        ? `选择器有问题：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : String(cause)
  } finally {
    running.value = false
  }
}

onBeforeUnmount(() => {
  engine.value?.dispose()
  engine.value = null
})
</script>

<template>
  <div class="trial">
    <header class="trial-header">
      <button class="btn btn--tertiary" type="button" @click="emit('back')">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M9 2L4 7l5 5" fill="none" stroke="currentColor" stroke-width="1.6" />
        </svg>
        {{ t('source.backToSources') }}
      </button>
      <h1 class="title">{{ t('source.trialTitle') }} · {{ source?.name ?? '' }}</h1>
    </header>

    <div ref="sandboxMount" class="sandbox-host" aria-hidden="true" />

    <div class="controls">
      <div class="stage-row">
        <span class="control-label">{{ t('source.trialStage') }}</span>
        <button
          v-for="option in (['search', 'detail', 'chapter'] as Stage[])"
          :key="option"
          class="chip"
          :class="{ 'is-active': stage === option }"
          type="button"
          :aria-pressed="stage === option"
          @click="stage = option; result = null; error = null"
        >
          {{ STAGE_LABELS[option] }}
        </button>
      </div>

      <label class="input-row">
        <span class="control-label">{{ t('source.trialInput') }}</span>
        <input
          v-model="input"
          class="input"
          type="text"
          :placeholder="stage === 'search' ? '关键词' : 'https://example.com/…'"
          @keydown.enter="run"
        />
        <button class="btn btn--primary" type="button" :disabled="running" @click="run">
          {{ running ? t('source.trialRunning') : t('source.trialRun') }}
        </button>
      </label>
    </div>

    <p v-if="error" class="error-strip">{{ error }}</p>

    <template v-if="result">
      <dl class="stats">
        <div class="stat">
          <dt>{{ t('source.trialStatus') }}</dt>
          <dd>{{ result.status ?? '—' }}</dd>
        </div>
        <div class="stat">
          <dt>{{ t('source.trialElapsed') }}</dt>
          <dd>{{ t('source.aggregateElapsed', { ms: result.elapsedMs }) }}</dd>
        </div>
        <div class="stat">
          <dt>{{ t('source.trialMatched') }}</dt>
          <dd>{{ result.items.length || result.chapters.length || (result.text ? 1 : 0) }}</dd>
        </div>
      </dl>

      <p class="request-url">
        <span class="request-label">{{ t('source.trialRequest') }}</span>
        <code>{{ result.requestUrl }}</code>
      </p>

      <!-- Diagnoses first: they explain a count that looks too low, which is the
           question a trial run usually exists to answer. -->
      <section v-if="result.diagnoses.length" class="block is-warn">
        <h2 class="block-title">{{ t('source.diagnosesCount', { count: result.diagnoses.length }) }}</h2>
        <ul class="diagnosis-list">
          <li v-for="d in result.diagnoses" :key="`${d.stage}-${d.index}`" class="diagnosis-row">
            <span class="diagnosis-index">{{ t('source.diagnoseRow', { index: d.index, reason: d.reason }) }}</span>
            <span v-if="d.excerpt" class="diagnosis-excerpt">{{ d.excerpt }}</span>
          </li>
        </ul>
      </section>

      <section v-if="result.items.length" class="block">
        <h2 class="block-title">{{ t('source.trialResult') }}</h2>
        <ol class="result-list">
          <li v-for="item in result.items" :key="item.detailUrl" class="result-row">
            <span class="result-title">{{ item.title }}</span>
            <span class="result-meta">{{ item.author ?? '—' }}</span>
            <span class="result-url" :title="item.detailUrl">{{ item.detailUrl }}</span>
          </li>
        </ol>
      </section>

      <section v-if="result.chapters.length" class="block">
        <h2 class="block-title">{{ t('source.chapters') }}</h2>
        <ol class="result-list">
          <li v-for="(chapter, index) in result.chapters.slice(0, 40)" :key="chapter.url" class="result-row">
            <span class="result-index">{{ index + 1 }}</span>
            <span class="result-title">{{ chapter.title }}</span>
            <span class="result-url" :title="chapter.url">{{ chapter.url }}</span>
          </li>
        </ol>
        <p v-if="result.chapters.length > 40" class="more">
          …共 {{ result.chapters.length }} 条
        </p>
      </section>

      <section v-if="result.text" class="block">
        <h2 class="block-title">{{ t('source.trialResult') }}</h2>
        <pre class="body-preview">{{ result.text.slice(0, 4000) }}</pre>
      </section>

      <p
        v-if="!result.items.length && !result.chapters.length && !result.text && !result.diagnoses.length"
        class="empty"
      >
        {{ t('source.trialNoResult') }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.trial {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.trial-header {
  flex: none;
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: var(--space-4) var(--content-pad) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.title {
  font-size: var(--text-xl);
  font-weight: var(--weight-strong);
}

.sandbox-host {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}

.controls {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.stage-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.control-label {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.chip {
  height: var(--control-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  color: var(--ink-secondary);
}

.chip:hover {
  background: var(--surface-hover);
  color: var(--ink-primary);
}

.chip.is-active {
  background: var(--surface-ink);
  color: var(--ink-inverse);
}

.input-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.input {
  flex: 1;
  min-width: 0;
  height: var(--control-md);
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface-page);
  font-size: var(--text-sm);
  color: var(--ink-primary);
}

.input:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.error-strip {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  color: var(--tone-danger);
  background: var(--tone-danger-surface);
  border-radius: var(--radius-md);
}

/* --- Stats -------------------------------------------------------------- */
.stats {
  display: flex;
  gap: var(--space-6);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
}

.stat dt {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.stat dd {
  font-size: var(--text-md);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  font-variant-numeric: tabular-nums;
}

.request-url {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-4);
  display: flex;
  gap: var(--space-2);
  align-items: baseline;
  font-size: var(--text-xs);
}

.request-label {
  flex: none;
  color: var(--ink-tertiary);
}

.request-url code {
  color: var(--ink-secondary);
  word-break: break-all;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
}

/* --- Blocks ------------------------------------------------------------- */
.block {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-5);
}

.block.is-warn {
  padding: var(--space-3) var(--content-pad);
}

.block-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-strong);
  margin-bottom: var(--space-2);
}

.block.is-warn .block-title {
  color: var(--tone-warning);
}

.diagnosis-list,
.result-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.diagnosis-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) 0;
  font-size: var(--text-xs);
}

.diagnosis-row + .diagnosis-row {
  border-top: 1px solid var(--line-subtle);
}

.diagnosis-index {
  color: var(--tone-warning);
}

.diagnosis-excerpt {
  color: var(--ink-tertiary);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  font-size: var(--text-xs);
}

.result-row + .result-row {
  border-top: 1px solid var(--line-subtle);
}

.result-index {
  flex: none;
  width: 2.5ch;
  text-align: right;
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.result-title {
  flex: 1;
  min-width: 0;
  color: var(--ink-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-meta {
  flex: none;
  color: var(--ink-tertiary);
}

.result-url {
  flex: 1;
  min-width: 0;
  color: var(--ink-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more,
.empty {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  padding: var(--space-2) 0;
}

.body-preview {
  max-height: 40vh;
  overflow: auto;
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  font-size: var(--text-xs);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
</style>
