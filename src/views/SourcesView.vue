<script setup lang="ts">
/**
 * Book source management.
 *
 * The entry point of the板块: list installed sources, import new ones, and be
 * told exactly what is wrong with a source that fails validation.
 *
 * The import feedback is the important part. A book source is a hand-written
 * JSON document, so the first attempt is usually wrong somewhere; the validator
 * reports every issue with a dotted field path, and this view shows them as a
 * list rather than one at a time.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSourcesStore } from '@/stores/sources'
import { t } from '@/i18n'
import { type ResourceType } from '@/sources/schema'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { onLoginFinished, readPickedTextFile } from '@/api/library'
import SourceFormFeedback from '@/components/SourceFormFeedback.vue'

const emit = defineEmits<{
  browse: [sourceId: string]
}>()

const store = useSourcesStore()
const importing = ref(false)
const showTemplate = ref(false)
/** Result of the most recent login attempt, shown until something replaces it. */
const loginMessage = ref('')
const loginError = ref(false)
let unsubscribeLogin: (() => void) | null = null

const isEmpty = computed(() => !store.loading && store.sources.length === 0)

const typeLabel = (type: ResourceType): string => t(`source.type.${type}`)

/** A minimal source skeleton, offered as a starting point. */
const TEMPLATE = `{
  "schemaVersion": 1,
  "id": "my-source",
  "name": "我的书源",
  "version": "1.0.0",
  "homepage": "https://example.com",
  "type": "novel",
  "enabled": true,
  "request": {
    "headers": { "User-Agent": "Mozilla/5.0" },
    "timeoutMs": 15000,
    "delayMs": 300
  },
  "search": {
    "url": "https://example.com/search?q={{keyword}}&page={{page}}",
    "method": "GET",
    "list": "css:.book-list li",
    "fields": {
      "title": "css:.title",
      "author": "css:.author",
      "cover": "css:img@src",
      "intro": "css:.intro",
      "detailUrl": "css:a@href"
    }
  },
  "detail": {
    "list": "css:.chapter-list a",
    "fields": { "title": "css:", "url": "css:@href" },
    "intro": "css:.book-intro"
  },
  "chapter": {
    "content": "css:#content"
  }
}`

async function handleImport(): Promise<void> {
  store.clearIssues()
  importing.value = true
  try {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: '书源 JSON', extensions: ['json'] }],
    })
    if (!selected) return
    const path = Array.isArray(selected) ? selected[0] : selected
    if (!path) return

    const text = await readPickedTextFile(path)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // A JSON syntax error is the most common first mistake; report the
      // parser's own position rather than a generic "invalid".
      store.lastIssues = [
        {
          path: '',
          message: `JSON 语法错误：${error instanceof Error ? error.message : String(error)}`,
        },
      ]
      return
    }

    const outcome = await store.importDocument(parsed)
    if (outcome.imported.length) showTemplate.value = false
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    importing.value = false
  }
}

async function copyTemplate(): Promise<void> {
  try {
    await navigator.clipboard.writeText(TEMPLATE)
    showTemplate.value = false
  } catch {
    // Clipboard can be unavailable; the text is visible either way.
  }
}

onMounted(() => {
  void store.load()
  // The login window lives outside this view, so its outcome arrives as an
  // event rather than a resolved promise.
  void onLoginFinished((event) => {
    loginError.value = !event.ok
    loginMessage.value = event.ok
      ? t('source.loginSuccess', { count: event.cookieCount })
      : event.message
    void store.finishLogin(event.sourceId)
  }).then((off) => {
    unsubscribeLogin = off
  })
})

onBeforeUnmount(() => {
  unsubscribeLogin?.()
  unsubscribeLogin = null
})
</script>

<template>
  <div class="sources">
    <header class="sources-header">
      <div class="heading">
        <h1 class="title">{{ t('source.title') }}</h1>
        <p class="count">
          <template v-if="!isEmpty">{{ t('source.count', { count: store.sources.length }) }}</template>
        </p>
      </div>
      <div class="actions">
        <button class="btn btn--tertiary" type="button" @click="showTemplate = !showTemplate">
          {{ t('source.template') }}
        </button>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="importing"
          @click="handleImport"
        >
          {{ importing ? t('source.importing') : t('source.import') }}
        </button>
      </div>
    </header>

    <!-- The network notice is not optional chrome: this is the one板块 that
         leaves the machine, and the app otherwise promises it never does. -->
    <div class="notice">
      <p class="notice-text">{{ t('source.networkNotice') }}</p>
    </div>

    <SourceFormFeedback :issues="store.lastIssues" @dismiss="store.clearIssues()" />

    <div v-if="store.error" class="error-wrap">
      <div class="error-strip">
        <p class="error-text">{{ store.error }}</p>
        <button class="btn btn--tertiary" type="button" @click="store.clearError()">
          {{ t('common.close') }}
        </button>
      </div>
    </div>

    <div v-if="store.loading" class="loading">{{ t('common.loading') }}</div>

    <div v-else-if="isEmpty" class="empty">
      <p class="empty-title">{{ t('source.empty.title') }}</p>
      <p class="empty-body">{{ t('source.empty.body') }}</p>
      <button class="btn btn--secondary" type="button" @click="showTemplate = true">
        {{ t('source.template') }}
      </button>
    </div>

    <ul v-else class="source-list">
      <li v-for="source in store.sources" :key="source.id" class="source-row">
        <button class="source-open" type="button" @click="emit('browse', source.id)">
          <span class="source-type">{{ typeLabel(source.type) }}</span>
          <span class="source-main">
            <span class="source-name">{{ source.name }}</span>
            <span class="source-meta">
              <span>v{{ source.version }}</span>
              <span class="dot" aria-hidden="true">·</span>
              <span>{{ source.homepage }}</span>
            </span>
          </span>
        </button>

        <label class="toggle">
          <input
            type="checkbox"
            :checked="source.enabled"
            :aria-label="t('source.enabled')"
            @change="store.setEnabled(source.id, ($event.target as HTMLInputElement).checked)"
          />
        </label>

        <!-- Login controls appear only for sources that declare `auth`. A source
             without it never receives a cookie, so offering a login button there
             would be a lie. -->
        <div v-if="source.auth" class="auth">
          <span
            class="auth-state"
            :class="{ 'is-in': store.credentialFor(source.id)?.hasCookie }"
            :title="store.credentialFor(source.id)?.host ?? source.auth.host ?? ''"
          >
            {{
              store.credentialFor(source.id)?.hasCookie
                ? t('source.loggedIn', { host: store.credentialFor(source.id)?.host ?? '' })
                : t('source.loggedOut')
            }}
          </span>
          <button
            v-if="!store.credentialFor(source.id)?.hasCookie"
            class="btn btn--tertiary"
            type="button"
            :disabled="store.loggingIn[source.id]"
            @click="store.startLogin(source.id)"
          >
            {{ store.loggingIn[source.id] ? t('source.loggingIn') : t('source.login') }}
          </button>
          <template v-else>
            <button
              class="btn btn--tertiary"
              type="button"
              @click="store.startLogin(source.id)"
            >
              {{ t('source.relogin') }}
            </button>
            <button
              class="btn btn--tertiary"
              type="button"
              @click="store.clearLogin(source.id)"
            >
              {{ t('source.logout') }}
            </button>
          </template>
        </div>

        <button
          class="source-remove btn btn--danger"
          type="button"
          :aria-label="t('source.remove')"
          @click="store.remove(source.id)"
        >
          {{ t('source.remove') }}
        </button>
      </li>
    </ul>

    <!-- Login outcome, shown where the login was started. -->
    <p v-if="loginMessage" class="login-message" :class="{ 'is-error': loginError }">
      {{ loginMessage }}
    </p>

    <!-- Template panel: shown on demand, not by default, so the empty state
         stays quiet. -->
    <div v-if="showTemplate" class="template-backdrop" @click.self="showTemplate = false">
      <div class="template" role="dialog" aria-modal="true">
        <h2 class="template-title">{{ t('source.template') }}</h2>
        <p class="template-body">{{ t('source.templateBody') }}</p>
        <pre class="template-code">{{ TEMPLATE }}</pre>
        <div class="template-actions">
          <button class="btn btn--tertiary" type="button" @click="showTemplate = false">
            {{ t('common.close') }}
          </button>
          <button class="btn btn--secondary" type="button" @click="copyTemplate">
            {{ t('source.copyTemplate') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sources {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.sources-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-5);
  padding: var(--space-7) var(--content-pad) var(--space-4);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
}

.title {
  font-size: var(--text-2xl);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}

.count {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.notice {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
}

.notice-text {
  font-size: var(--text-xs);
  color: var(--tone-warning);
  background: var(--tone-warning-surface);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  line-height: var(--leading-snug);
}

.source-list {
  list-style: none;
  margin: 0 auto;
  padding: 0 0 var(--space-7);
  max-width: var(--shell-max);
  width: 100%;
}

.source-row {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: var(--radius-md);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.source-row:hover {
  background: var(--surface-hover);
}

.source-row + .source-row::before {
  content: '';
  position: absolute;
  top: 0;
  left: var(--space-4);
  right: var(--space-4);
  height: var(--hairline);
  background: var(--line-subtle);
}

.source-open {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex: 1;
  min-width: 0;
  padding: var(--space-4);
  text-align: left;
}

/* The resource kind is a fixed-width text marker, matching the library's
   extension column — same information density, same rhythm. */
.source-type {
  flex: none;
  width: 48px;
  font-size: var(--text-xs);
  font-weight: var(--weight-strong);
  color: var(--ink-tertiary);
}

.source-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.source-name {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  min-width: 0;
}

.source-meta > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot {
  color: var(--line-strong);
}

.toggle {
  flex: none;
  padding: 0 var(--space-2);
  display: flex;
  align-items: center;
}

.toggle input {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--surface-ink);
}

.source-remove {
  flex: none;
  margin-right: var(--space-3);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}

/* --- login -------------------------------------------------------------- */

.auth {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.auth-state {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  white-space: nowrap;
}

/* A dot carries the state too, so it still reads in a narrow row. */
.auth-state::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: var(--space-2);
  border-radius: 50%;
  background: var(--ink-tertiary);
  vertical-align: middle;
}

.auth-state.is-in {
  color: var(--ink-secondary);
}

/* The palette has no success colour by design, so "logged in" is expressed by a
   solid dot against the faint one — state without introducing a new hue. */
.auth-state.is-in::before {
  background: var(--ink-secondary);
}

.login-message {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-4);
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.login-message.is-error {
  color: var(--tone-warning);
}

.source-row:hover .source-remove,
.source-remove:focus-visible {
  opacity: 1;
}

.loading,
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  flex: 1;
  padding: var(--space-9) var(--space-6);
  text-align: center;
}

.empty-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
}

.empty-body {
  max-width: 46ch;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  line-height: var(--leading-normal);
}

.error-wrap {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: 0 var(--content-pad) var(--space-3);
}

.error-strip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--tone-danger-surface);
}

.error-text {
  flex: 1;
  font-size: var(--text-sm);
  color: var(--tone-danger);
}

/* --- template panel ----------------------------------------------------- */

.template-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.24);
  z-index: 30;
}

.template {
  width: min(680px, calc(100vw - var(--space-7)));
  max-height: calc(100vh - var(--space-8));
  display: flex;
  flex-direction: column;
  padding: var(--space-5);
  background: var(--surface-raised);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-e3);
}

.template-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
}

.template-body {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.template-code {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: var(--space-4) 0 0;
  padding: var(--space-4);
  background: var(--surface-sunken);
  border-radius: var(--radius-sm);
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: var(--text-xs);
  line-height: 1.6;
  user-select: text;
}

.template-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
</style>
