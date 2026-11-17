<script setup lang="ts">
/**
 * The source editor.
 *
 * Two modes over one object: a form, and the raw JSON. Neither is a copy — both
 * edit the same `draft`, so switching cannot lose work and there is no second
 * source of truth to reconcile. The raw mode exists because a form that covers
 * every field would be forty inputs; the form exists because hand-editing JSON to
 * change one selector is what the old version forced on people.
 *
 * ## Validation
 *
 * Field-level, on blur, using the same `checkSelector`/`checkUrlTemplate` rules as
 * the whole-file validator — a field that passes here will pass there. The point
 * is to fail next to the input that caused it, instead of as `search.fields.title`
 * in a list at the top of the screen.
 *
 * ## The selector tester
 *
 * Every selector field can be tried against the live page. That single affordance
 * is most of the reason Kazumi's editor is usable at all: a selector is a guess
 * until you see what it matches, and reading the error afterwards cannot tell you
 * whether you are one `@href` away or pointed at the wrong element entirely.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { t } from '@/i18n'
import { useSourcesStore } from '@/stores/sources'
import { SourceEngine } from '@/sources/engine'
import { validateSource, type BookSource, type ResourceType, RESOURCE_TYPES } from '@/sources/schema'
import { SelectorError, isJsSelector } from '@/sources/selector'

const props = defineProps<{
  /** Editing an existing source; omit to create one. */
  sourceId?: string | null
}>()

const emit = defineEmits<{
  saved: [sourceId: string]
  cancel: []
}>()

const store = useSourcesStore()

const mode = ref<'form' | 'raw'>('form')
const rawText = ref('')
const rawError = ref<string | null>(null)
const saving = ref(false)
const saveError = ref<string | null>(null)
const mounted = ref(false)

/** Section anchors: the form is long, and scrolling blind is not navigation. */
const SECTIONS = ['basic', 'request', 'search', 'detail', 'chapter', 'video'] as const
type Section = (typeof SECTIONS)[number]

const SECTION_LABELS: Record<Section, string> = {
  basic: t('source.editor.basic'),
  request: t('source.editor.request'),
  search: t('source.editor.search'),
  detail: t('source.editor.detail'),
  chapter: t('source.editor.chapter'),
  video: t('source.editor.video'),
}

/**
 * The working copy.
 *
 * A plain reactive object shaped like a `BookSource`, seeded from the existing
 * source or a blank template. It is deliberately *not* a validated `BookSource`
 * while being edited: intermediate states (a half-typed selector) are normal and
 * must not be rejected.
 */
interface Draft {
  schemaVersion: number
  id: string
  name: string
  version: string
  homepage: string
  language: string
  type: ResourceType
  enabled: boolean
  request: { headers: Record<string, string>; timeoutMs: number; delayMs: number }
  search: {
    url: string
    method: 'GET' | 'POST'
    body: string
    list: string
    fields: { title: string; detailUrl: string; author: string; cover: string; intro: string }
  }
  detail: {
    list: string
    fields: { title: string; url: string }
    title: string
    author: string
    intro: string
    cover: string
    tocUrl: string
  }
  chapter: { content: string; nextUrl: string }
}

function blankDraft(): Draft {
  return {
    schemaVersion: 1,
    id: '',
    name: '',
    version: '1.0.0',
    homepage: '',
    language: 'zh',
    type: 'novel',
    enabled: true,
    request: {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeoutMs: 15000,
      delayMs: 300,
    },
    search: {
      url: '',
      method: 'GET',
      body: '',
      list: '',
      fields: { title: '', detailUrl: '', author: '', cover: '', intro: '' },
    },
    detail: { list: '', fields: { title: '', url: '' }, title: '', author: '', intro: '', cover: '', tocUrl: '' },
    chapter: { content: '', nextUrl: '' },
  }
}

/** Turn a stored source into a draft, filling absent optionals with ''. */
function draftFrom(source: BookSource): Draft {
  return {
    schemaVersion: source.schemaVersion,
    id: source.id,
    name: source.name,
    version: source.version,
    homepage: source.homepage,
    language: source.language ?? 'zh',
    type: source.type,
    enabled: source.enabled,
    request: {
      headers: { ...source.request.headers },
      timeoutMs: source.request.timeoutMs,
      delayMs: source.request.delayMs,
    },
    search: {
      url: source.search.url,
      method: source.search.method,
      body: source.search.body ?? '',
      list: source.search.list,
      fields: {
        title: source.search.fields.title,
        detailUrl: source.search.fields.detailUrl,
        author: source.search.fields.author ?? '',
        cover: source.search.fields.cover ?? '',
        intro: source.search.fields.intro ?? '',
      },
    },
    detail: {
      list: source.detail.list,
      fields: { title: source.detail.fields.title, url: source.detail.fields.url },
      title: source.detail.title ?? '',
      author: source.detail.author ?? '',
      intro: source.detail.intro ?? '',
      cover: source.detail.cover ?? '',
      tocUrl: source.detail.tocUrl ?? '',
    },
    chapter: { content: source.chapter.content, nextUrl: source.chapter.nextUrl ?? '' },
  }
}

const existing = computed(() =>
  props.sourceId ? store.byId(props.sourceId) : undefined,
)
const isEditing = computed(() => !!existing.value)

const draft = ref<Draft>(
  existing.value ? draftFrom(existing.value) : blankDraft(),
)

/**
 * Serialize a draft back to a `BookSource`-shaped object.
 *
 * Empty strings become absent rather than `""`, because the validator treats an
 * empty optional as absent anyway and the stored file is nicer to read without
 * twenty empty keys.
 */
function draftToJson(value: Draft): Record<string, unknown> {
  const optional = (text: string): string | undefined => (text.trim() ? text.trim() : undefined)
  const fields = value.search.fields
  return {
    schemaVersion: 1,
    id: value.id.trim(),
    name: value.name.trim(),
    version: value.version.trim(),
    homepage: value.homepage.trim(),
    ...(optional(value.language) ? { language: value.language.trim() } : {}),
    type: value.type,
    enabled: value.enabled,
    request: {
      headers: Object.fromEntries(
        Object.entries(value.request.headers).filter(([key]) => key.trim()),
      ),
      timeoutMs: value.request.timeoutMs,
      delayMs: value.request.delayMs,
    },
    search: {
      url: value.search.url.trim(),
      method: value.search.method,
      ...(value.search.method === 'POST' && value.search.body.trim()
        ? { body: value.search.body }
        : {}),
      list: value.search.list.trim(),
      fields: {
        title: fields.title.trim(),
        detailUrl: fields.detailUrl.trim(),
        ...(optional(fields.author) ? { author: fields.author.trim() } : {}),
        ...(optional(fields.cover) ? { cover: fields.cover.trim() } : {}),
        ...(optional(fields.intro) ? { intro: fields.intro.trim() } : {}),
      },
    },
    detail: {
      list: value.detail.list.trim(),
      fields: {
        title: value.detail.fields.title.trim(),
        url: value.detail.fields.url.trim(),
      },
      ...(optional(value.detail.title) ? { title: value.detail.title.trim() } : {}),
      ...(optional(value.detail.author) ? { author: value.detail.author.trim() } : {}),
      ...(optional(value.detail.intro) ? { intro: value.detail.intro.trim() } : {}),
      ...(optional(value.detail.cover) ? { cover: value.detail.cover.trim() } : {}),
      ...(optional(value.detail.tocUrl) ? { tocUrl: value.detail.tocUrl.trim() } : {}),
    },
    chapter: {
      content: value.chapter.content.trim(),
      ...(optional(value.chapter.nextUrl) ? { nextUrl: value.chapter.nextUrl.trim() } : {}),
    },
  }
}

// --- Validation ------------------------------------------------------------

/**
 * Whole-document validation, run on every change.
 *
 * Cheaper than it looks (a few hundred string checks) and it means the save
 * button can be honest about whether the document is valid, rather than finding
 * out after a click.
 */
const validation = computed(() => validateSource(draftToJson(draft.value)))

/** Issues grouped by their dotted path, so a field can render its own error. */
const issuesByPath = computed(() => {
  const map = new Map<string, string[]>()
  for (const issue of validation.value.issues) {
    const list = map.get(issue.path) ?? []
    list.push(issue.message)
    map.set(issue.path, list)
  }
  return map
})

function issuesFor(path: string): string[] {
  return issuesByPath.value.get(path) ?? []
}

/** Issues not attached to a field the form shows, surfaced in a summary strip. */
const unplacedIssues = computed(() =>
  validation.value.issues.filter(
    (issue) => !issue.path.startsWith('search.') && !issue.path.startsWith('detail.') && !issue.path.startsWith('chapter.') && !['id', 'name', 'version', 'homepage', 'type'].includes(issue.path),
  ),
)

// --- Raw mode --------------------------------------------------------------

/**
 * Switching to raw re-serializes the draft.
 *
 * Pretty-printed and with a stable key order, so flipping back and forth does not
 * produce spurious diffs.
 */
watch(mode, (next) => {
  if (next === 'raw') {
    rawText.value = JSON.stringify(draftToJson(draft.value), null, 2)
    rawError.value = null
  }
})

/**
 * Switching back parses the raw text.
 *
 * Going through `applyRaw` rather than assigning `mode` directly is load-bearing:
 * the two modes edit one draft, and jumping to the form without parsing would
 * silently render the *previous* draft while the raw text sat unread in the
 * textarea. That looked exactly like "my edits vanished".
 */
function toFormMode(): void {
  if (mode.value === 'raw') {
    if (!applyRaw()) return
  }
  mode.value = 'form'
}

/**
 * Parse errors keep the user in raw mode with the message attached: dropping them
 * back into the form would silently discard what they typed.
 */
function applyRaw(): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText.value)
  } catch (error) {
    rawError.value = `JSON 语法错误：${error instanceof Error ? error.message : String(error)}`
    return false
  }
  const result = validateSource(parsed)
  if (!result.ok) {
    rawError.value = result.issues
      .slice(0, 4)
      .map((issue) => `${issue.path || '（根）'}: ${issue.message}`)
      .join('\n')
    return false
  }
  draft.value = draftFrom(result.source!)
  rawError.value = null
  mode.value = 'form'
  return true
}

// --- Header editing (key/value table) -------------------------------------

const newHeaderKey = ref('')
const newHeaderValue = ref('')

function addHeader(): void {
  const key = newHeaderKey.value.trim()
  if (!key) return
  draft.value.request.headers = {
    ...draft.value.request.headers,
    [key]: newHeaderValue.value,
  }
  newHeaderKey.value = ''
  newHeaderValue.value = ''
}

function removeHeader(key: string): void {
  const next = { ...draft.value.request.headers }
  delete next[key]
  draft.value.request.headers = next
}

// --- Selector tester ------------------------------------------------------

/**
 * Per-field test results.
 *
 * Keyed by the dotted path of the field, so a result can render under the input
 * that produced it and a stale result can be cleared when the field changes.
 */
interface TestResult {
  ok: boolean
  message: string
  /** Matched values, truncated for display. */
  sample: string[]
}

const tests = ref<Record<string, TestResult>>({})
const testing = ref<Record<string, boolean>>({})
const testerUrl = ref('')
const sandboxMount = ref<HTMLElement | null>(null)
const engine = shallowRef<SourceEngine | null>(null)

/** Which URL the tester loads: the explicit one, else the source's search URL. */
function effectiveUrl(): string | null {
  const explicit = testerUrl.value.trim()
  if (explicit) return explicit
  const templateUrl = draft.value.search.url.trim()
  if (!templateUrl) return null
  // Substitute placeholders so the URL is fetchable.
  return templateUrl
    .replace(/\{\{keyword\}\}/g, encodeURIComponent('测试'))
    .replace(/\{\{page\}\}/g, '1')
}

function ensureEngine(): SourceEngine | null {
  const result = validateSource(draftToJson(draft.value))
  if (!result.ok) return null
  if (engine.value) return engine.value
  engine.value = new SourceEngine(result.source!, undefined, sandboxMount.value ?? undefined)
  return engine.value
}

/**
 * Evaluate one selector against the page at the tester URL.
 *
 * Uses the selector module directly rather than the engine's field logic: the
 * question here is "what does this selector match", not "does this stage
 * succeed", and the two need different error messages.
 */
async function testSelector(path: string, selector: string): Promise<void> {
  const expression = selector.trim()
  if (!expression) {
    tests.value = { ...tests.value, [path]: { ok: false, message: '选择器为空', sample: [] } }
    return
  }
  const url = effectiveUrl()
  if (!url) {
    tests.value = {
      ...tests.value,
      [path]: { ok: false, message: '先填写搜索地址，或在上面指定一个测试页面', sample: [] },
    }
    return
  }

  testing.value = { ...testing.value, [path]: true }
  try {
    // A `@js:` expression needs the sandbox; the engine owns it, so borrow it.
    if (isJsSelector(expression)) {
      const active = ensureEngine()
      if (!active) {
        tests.value = {
          ...tests.value,
          [path]: { ok: false, message: '源本身还有校验错误，无法执行 JS 选择器', sample: [] },
        }
        return
      }
    }
    const active = ensureEngine()
    if (!active) {
      tests.value = {
        ...tests.value,
        [path]: { ok: false, message: '源本身还有校验错误，先修好其他字段', sample: [] },
      }
      return
    }

    const page = await active.fetchPage(url)
    const json = tryParseJson(page.body)
    const values = await active.evaluate(expression, {
      json,
      html: page.body,
      text: page.body,
    }, true)

    if (!values.length) {
      tests.value = {
        ...tests.value,
        [path]: { ok: false, message: '没有匹配到任何内容', sample: [] },
      }
      return
    }
    tests.value = {
      ...tests.value,
      [path]: {
        ok: true,
        message: `匹配 ${values.length} 项`,
        sample: values.slice(0, 3).map((value) => truncate(value, 100)),
      },
    }
  } catch (cause) {
    tests.value = {
      ...tests.value,
      [path]: {
        ok: false,
        message: cause instanceof SelectorError
          ? `选择器有问题：${cause.message}`
          : cause instanceof Error
            ? cause.message
            : String(cause),
        sample: [],
      },
    }
  } finally {
    testing.value = { ...testing.value, [path]: false }
  }
}

function tryParseJson(body: string): unknown {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function clearTest(path: string): void {
  if (!tests.value[path]) return
  const next = { ...tests.value }
  delete next[path]
  tests.value = next
}

// --- Save ------------------------------------------------------------------

async function save(): Promise<void> {
  if (mode.value === 'raw') {
    if (!applyRaw()) return
  }
  const result = validateSource(draftToJson(draft.value))
  if (!result.ok) {
    saveError.value = `还有 ${result.issues.length} 处问题需要修正`
    return
  }
  saving.value = true
  saveError.value = null
  try {
    // `importDocument` merges by id, which is exactly "save this source": an
    // existing id is replaced in place, a new one is added. There is no separate
    // update path to keep in sync.
    const outcome = await store.importDocument(result.source!)
    if (!outcome.imported.length) {
      saveError.value = outcome.issues[0]?.message ?? '保存失败'
      return
    }
    emit('saved', result.source!.id)
  } catch (cause) {
    saveError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

onBeforeUnmount(() => {
  engine.value?.dispose()
  engine.value = null
})

// Keep the draft in sync if the underlying source is replaced (e.g. a batch
// update landed while the editor was open on a non-edited field).
watch(existing, (next) => {
  if (next && !mounted.value) {
    draft.value = draftFrom(next)
    mounted.value = true
  }
})
</script>

<template>
  <div class="editor">
    <header class="editor-header">
      <div class="head-row">
        <button class="btn btn--tertiary" type="button" @click="emit('cancel')">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M9 2L4 7l5 5" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          {{ t('common.cancel') }}
        </button>

        <div class="mode-switch" role="group">
          <button
            class="mode-btn"
            :class="{ 'is-active': mode === 'form' }"
            type="button"
            :aria-pressed="mode === 'form'"
            @click="toFormMode"
          >
            {{ t('source.editor.formMode') }}
          </button>
          <button
            class="mode-btn"
            :class="{ 'is-active': mode === 'raw' }"
            type="button"
            :aria-pressed="mode === 'raw'"
            @click="mode = 'raw'"
          >
            {{ t('source.editor.rawMode') }}
          </button>
        </div>

        <div class="head-actions">
          <span v-if="!validation.ok" class="issue-count">
            {{ t('source.editor.issueCount', { count: validation.issues.length }) }}
          </span>
          <button class="btn btn--primary" type="button" :disabled="saving || !validation.ok" @click="save">
            {{ saving ? t('source.editor.saving') : t('source.editor.save') }}
          </button>
        </div>
      </div>

      <p class="title-line">
        {{ isEditing ? t('source.editor.editing', { name: existing?.name ?? '' }) : t('source.editor.creating') }}
      </p>

      <p v-if="saveError" class="save-error">{{ saveError }}</p>
    </header>

    <div ref="sandboxMount" class="sandbox-host" aria-hidden="true" />

    <!-- Raw mode: one textarea, checked on exit. -->
    <div v-if="mode === 'raw'" class="raw">
      <p class="raw-hint">{{ t('source.editor.rawHint') }}</p>
      <textarea v-model="rawText" class="raw-input" spellcheck="false" />
      <p v-if="rawError" class="raw-error">{{ rawError }}</p>
    </div>

    <template v-else>
      <!-- Selector tester: one URL for the whole session of testing. -->
      <section class="tester">
        <label class="tester-field">
          <span class="tester-label">{{ t('source.editor.testerUrl') }}</span>
          <input
            v-model="testerUrl"
            class="input"
            type="text"
            :placeholder="t('source.editor.testerPlaceholder')"
          />
        </label>
        <p class="tester-hint">{{ t('source.editor.testerHint') }}</p>
      </section>

      <div class="sections">
        <!-- basic -->
        <section class="section">
          <h2 class="section-title">{{ SECTION_LABELS.basic }}</h2>

          <label class="field">
            <span class="field-label">{{ t('source.editor.id') }}</span>
            <input v-model="draft.id" class="input" type="text" placeholder="my-source" />
            <p class="field-hint">{{ t('source.editor.idHint') }}</p>
            <p v-for="issue in issuesFor('id')" :key="issue" class="field-error">{{ issue }}</p>
          </label>

          <label class="field">
            <span class="field-label">{{ t('source.editor.name') }}</span>
            <input v-model="draft.name" class="input" type="text" />
            <p v-for="issue in issuesFor('name')" :key="issue" class="field-error">{{ issue }}</p>
          </label>

          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('source.editor.version') }}</span>
              <input v-model="draft.version" class="input" type="text" />
              <p v-for="issue in issuesFor('version')" :key="issue" class="field-error">{{ issue }}</p>
            </label>

            <label class="field">
              <span class="field-label">{{ t('source.editor.type') }}</span>
              <select v-model="draft.type" class="input">
                <option v-for="type in RESOURCE_TYPES" :key="type" :value="type">
                  {{ t(`source.type.${type}` as 'source.type.novel') }}
                </option>
              </select>
            </label>
          </div>

          <label class="field">
            <span class="field-label">{{ t('source.editor.homepage') }}</span>
            <input v-model="draft.homepage" class="input" type="text" placeholder="https://example.com" />
            <p v-for="issue in issuesFor('homepage')" :key="issue" class="field-error">{{ issue }}</p>
          </label>

          <label class="field checkbox-field">
            <input v-model="draft.enabled" type="checkbox" />
            <span class="field-label">{{ t('source.editor.enabled') }}</span>
          </label>
        </section>

        <!-- request -->
        <section class="section">
          <h2 class="section-title">{{ SECTION_LABELS.request }}</h2>

          <div class="field">
            <span class="field-label">{{ t('source.editor.headers') }}</span>
            <ul class="header-list">
              <li v-for="(value, key) in draft.request.headers" :key="key" class="header-row">
                <span class="header-key">{{ key }}</span>
                <span class="header-value" :title="value">{{ value }}</span>
                <button class="btn btn--tertiary" type="button" @click="removeHeader(String(key))">
                  {{ t('source.editor.removeHeader') }}
                </button>
              </li>
            </ul>
            <div class="header-add">
              <input v-model="newHeaderKey" class="input" type="text" placeholder="Header" />
              <input v-model="newHeaderValue" class="input" type="text" placeholder="Value" />
              <button class="btn btn--tertiary" type="button" :disabled="!newHeaderKey.trim()" @click="addHeader">
                {{ t('source.editor.addHeader') }}
              </button>
            </div>
          </div>

          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('source.editor.timeout') }}</span>
              <input v-model.number="draft.request.timeoutMs" class="input" type="number" min="1000" max="60000" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('source.editor.delay') }}</span>
              <input v-model.number="draft.request.delayMs" class="input" type="number" min="0" max="10000" />
            </label>
          </div>
        </section>

        <!-- search -->
        <section class="section">
          <h2 class="section-title">{{ SECTION_LABELS.search }}</h2>

          <label class="field">
            <span class="field-label">{{ t('source.editor.searchUrl') }}</span>
            <input v-model="draft.search.url" class="input" type="text" placeholder="https://example.com/search?q={{keyword}}" />
            <p class="field-hint">{{ t('source.editor.urlHint') }}</p>
            <p v-for="issue in issuesFor('search.url')" :key="issue" class="field-error">{{ issue }}</p>
          </label>

          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('source.editor.method') }}</span>
              <select v-model="draft.search.method" class="input">
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
            </label>
            <label v-if="draft.search.method === 'POST'" class="field">
              <span class="field-label">{{ t('source.editor.body') }}</span>
              <input v-model="draft.search.body" class="input" type="text" placeholder="q={{keyword}}" />
            </label>
          </div>

          <label class="field">
            <span class="field-label">{{ t('source.editor.searchList') }}</span>
            <div class="selector-row">
              <input v-model="draft.search.list" class="input" type="text" placeholder="css:.book-list li" />
              <button
                class="btn btn--tertiary"
                type="button"
                :disabled="testing['search.list']"
                @click="testSelector('search.list', draft.search.list)"
              >
                {{ testing['search.list'] ? t('source.editor.testing') : t('source.editor.test') }}
              </button>
            </div>
            <p v-for="issue in issuesFor('search.list')" :key="issue" class="field-error">{{ issue }}</p>
            <div v-if="tests['search.list']" class="test-result" :class="{ 'is-ok': tests['search.list'].ok }">
              <p class="test-message">{{ tests['search.list'].message }}</p>
              <ul v-if="tests['search.list'].sample.length" class="test-sample">
                <li v-for="(line, index) in tests['search.list'].sample" :key="index">{{ line }}</li>
              </ul>
              <button class="btn btn--tertiary test-close" type="button" @click="clearTest('search.list')">
                {{ t('common.close') }}
              </button>
            </div>
          </label>

          <label class="field">
            <span class="field-label">{{ t('source.editor.searchTitle') }}</span>
            <div class="selector-row">
              <input v-model="draft.search.fields.title" class="input" type="text" placeholder="css:.title" />
              <button
                class="btn btn--tertiary"
                type="button"
                :disabled="testing['search.fields.title']"
                @click="testSelector('search.fields.title', draft.search.fields.title)"
              >
                {{ testing['search.fields.title'] ? t('source.editor.testing') : t('source.editor.test') }}
              </button>
            </div>
            <p v-for="issue in issuesFor('search.fields.title')" :key="issue" class="field-error">{{ issue }}</p>
            <div v-if="tests['search.fields.title']" class="test-result" :class="{ 'is-ok': tests['search.fields.title'].ok }">
              <p class="test-message">{{ tests['search.fields.title'].message }}</p>
              <ul v-if="tests['search.fields.title'].sample.length" class="test-sample">
                <li v-for="(line, index) in tests['search.fields.title'].sample" :key="index">{{ line }}</li>
              </ul>
            </div>
          </label>

          <label class="field">
            <span class="field-label">{{ t('source.editor.searchDetailUrl') }}</span>
            <div class="selector-row">
              <input v-model="draft.search.fields.detailUrl" class="input" type="text" placeholder="css:a@href" />
              <button
                class="btn btn--tertiary"
                type="button"
                :disabled="testing['search.fields.detailUrl']"
                @click="testSelector('search.fields.detailUrl', draft.search.fields.detailUrl)"
              >
                {{ testing['search.fields.detailUrl'] ? t('source.editor.testing') : t('source.editor.test') }}
              </button>
            </div>
            <p v-for="issue in issuesFor('search.fields.detailUrl')" :key="issue" class="field-error">{{ issue }}</p>
            <div v-if="tests['search.fields.detailUrl']" class="test-result" :class="{ 'is-ok': tests['search.fields.detailUrl'].ok }">
              <p class="test-message">{{ tests['search.fields.detailUrl'].message }}</p>
              <ul v-if="tests['search.fields.detailUrl'].sample.length" class="test-sample">
                <li v-for="(line, index) in tests['search.fields.detailUrl'].sample" :key="index">{{ line }}</li>
              </ul>
            </div>
          </label>

          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('source.editor.searchAuthor') }}</span>
              <input v-model="draft.search.fields.author" class="input" type="text" placeholder="css:.author" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('source.editor.searchCover') }}</span>
              <input v-model="draft.search.fields.cover" class="input" type="text" placeholder="css:img@src" />
            </label>
          </div>
        </section>

        <!-- detail -->
        <section class="section">
          <h2 class="section-title">{{ SECTION_LABELS.detail }}</h2>

          <label class="field">
            <span class="field-label">{{ t('source.editor.detailList') }}</span>
            <div class="selector-row">
              <input v-model="draft.detail.list" class="input" type="text" placeholder="css:.chapter-list a" />
              <button
                class="btn btn--tertiary"
                type="button"
                :disabled="testing['detail.list']"
                @click="testSelector('detail.list', draft.detail.list)"
              >
                {{ testing['detail.list'] ? t('source.editor.testing') : t('source.editor.test') }}
              </button>
            </div>
            <p v-for="issue in issuesFor('detail.list')" :key="issue" class="field-error">{{ issue }}</p>
            <div v-if="tests['detail.list']" class="test-result" :class="{ 'is-ok': tests['detail.list'].ok }">
              <p class="test-message">{{ tests['detail.list'].message }}</p>
              <ul v-if="tests['detail.list'].sample.length" class="test-sample">
                <li v-for="(line, index) in tests['detail.list'].sample" :key="index">{{ line }}</li>
              </ul>
            </div>
          </label>

          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('source.editor.detailTitle') }}</span>
              <input v-model="draft.detail.fields.title" class="input" type="text" placeholder="css:" />
              <p v-for="issue in issuesFor('detail.fields.title')" :key="issue" class="field-error">{{ issue }}</p>
            </label>
            <label class="field">
              <span class="field-label">{{ t('source.editor.detailUrl') }}</span>
              <input v-model="draft.detail.fields.url" class="input" type="text" placeholder="css:@href" />
              <p v-for="issue in issuesFor('detail.fields.url')" :key="issue" class="field-error">{{ issue }}</p>
            </label>
          </div>

          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('source.editor.bookTitle') }}</span>
              <input v-model="draft.detail.title" class="input" type="text" placeholder="css:h1" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('source.editor.bookCover') }}</span>
              <input v-model="draft.detail.cover" class="input" type="text" placeholder="css:img@src" />
            </label>
          </div>

          <label class="field">
            <span class="field-label">{{ t('source.editor.tocUrl') }}</span>
            <input v-model="draft.detail.tocUrl" class="input" type="text" placeholder="css:a.toc@href" />
            <p class="field-hint">{{ t('source.editor.tocUrlHint') }}</p>
          </label>
        </section>

        <!-- chapter -->
        <section class="section">
          <h2 class="section-title">{{ SECTION_LABELS.chapter }}</h2>

          <label class="field">
            <span class="field-label">{{ t('source.editor.chapterContent') }}</span>
            <div class="selector-row">
              <input v-model="draft.chapter.content" class="input" type="text" placeholder="css:#content p" />
              <button
                class="btn btn--tertiary"
                type="button"
                :disabled="testing['chapter.content']"
                @click="testSelector('chapter.content', draft.chapter.content)"
              >
                {{ testing['chapter.content'] ? t('source.editor.testing') : t('source.editor.test') }}
              </button>
            </div>
            <p v-for="issue in issuesFor('chapter.content')" :key="issue" class="field-error">{{ issue }}</p>
            <div v-if="tests['chapter.content']" class="test-result" :class="{ 'is-ok': tests['chapter.content'].ok }">
              <p class="test-message">{{ tests['chapter.content'].message }}</p>
              <ul v-if="tests['chapter.content'].sample.length" class="test-sample">
                <li v-for="(line, index) in tests['chapter.content'].sample" :key="index">{{ line }}</li>
              </ul>
            </div>
          </label>

          <label class="field">
            <span class="field-label">{{ t('source.editor.nextUrl') }}</span>
            <input v-model="draft.chapter.nextUrl" class="input" type="text" placeholder="css:a[rel=next]@href" />
            <p class="field-hint">{{ t('source.editor.nextUrlHint') }}</p>
          </label>
        </section>

        <p v-if="unplacedIssues.length" class="unplaced">
          <span v-for="issue in unplacedIssues" :key="`${issue.path}-${issue.message}`" class="unplaced-line">
            {{ issue.path || '（根）' }}: {{ issue.message }}
          </span>
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.editor-header {
  position: sticky;
  top: 0;
  z-index: 5;
  flex: none;
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: var(--space-4) var(--content-pad) var(--space-3);
  background: var(--surface-page);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.head-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.mode-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
}

.mode-btn {
  height: 24px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.mode-btn.is-active {
  background: var(--surface-raised);
  color: var(--ink-primary);
  box-shadow: var(--shadow-e1);
}

.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.issue-count {
  font-size: var(--text-xs);
  color: var(--tone-danger);
}

.title-line {
  font-size: var(--text-lg);
  font-weight: var(--weight-strong);
}

.save-error {
  font-size: var(--text-sm);
  color: var(--tone-danger);
}

.sandbox-host {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}

/* --- Raw mode ----------------------------------------------------------- */
.raw {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-7);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.raw-hint {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.raw-input {
  min-height: 60vh;
  padding: var(--space-4);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface-raised);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--ink-primary);
  resize: vertical;
}

.raw-input:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.raw-error {
  font-size: var(--text-sm);
  color: var(--tone-danger);
  white-space: pre-wrap;
}

/* --- Tester ------------------------------------------------------------- */
.tester {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.tester-label {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.tester-hint {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

/* --- Sections ----------------------------------------------------------- */
.sections {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-9);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.section-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--line-section);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.field-row {
  display: flex;
  gap: var(--space-3);
}

.field-row .field {
  flex: 1;
}

.field-label {
  font-size: var(--text-xs);
  color: var(--ink-secondary);
}

.field-hint {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.field-error {
  font-size: var(--text-xs);
  color: var(--tone-danger);
}

.checkbox-field {
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
}

.checkbox-field input {
  width: 15px;
  height: 15px;
  accent-color: var(--surface-ink);
}

.input {
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

.selector-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.selector-row .input {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: var(--text-xs);
}

/* --- Header table ------------------------------------------------------- */
.header-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.header-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) 0;
  font-size: var(--text-xs);
}

.header-key {
  flex: none;
  width: 120px;
  color: var(--ink-secondary);
  font-weight: var(--weight-medium);
}

.header-value {
  flex: 1;
  min-width: 0;
  color: var(--ink-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-add {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.header-add .input {
  flex: 1;
  min-width: 0;
}

/* --- Test result -------------------------------------------------------- */
.test-result {
  margin-top: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--tone-danger-surface);
}

.test-result.is-ok {
  background: var(--surface-sunken);
}

.test-message {
  font-size: var(--text-xs);
  color: var(--ink-secondary);
}

.test-sample {
  list-style: none;
  margin: var(--space-1) 0 0;
  padding: 0;
}

.test-sample li {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.test-close {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
}

.unplaced {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--tone-danger-surface);
}

.unplaced-line {
  font-size: var(--text-xs);
  color: var(--tone-danger);
}
</style>
