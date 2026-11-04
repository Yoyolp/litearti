/**
 * Book source storage and the store that owns it.
 *
 * Sources live in their own files under `sources/`, never in `library.json`.
 * The separation is deliberate:
 *
 * - a source is configuration, not library content; deleting a source must not
 *   touch anything the person imported;
 * - `library.json` has a versioned schema the reader depends on, and mixing
 *   foreign data into it would make every future migration harder;
 * - reading progress for source content is tracked separately too, because it
 *   refers to URLs that may disappear, unlike imported files.
 *
 * Persistence goes through Tauri's own file access (via the same `invoke`
 * boundary as everything else) rather than adding a new plugin.
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/library'
import { validateSourceFile, type BookSource, type ValidationIssue } from '@/sources/schema'

/** Reading progress for one source chapter, keyed by source id + chapter url. */
export interface SourceProgress {
  sourceId: string
  chapterUrl: string
  chapterTitle: string
  /** Scroll ratio within the chapter, same convention as the local viewers. */
  ratio: number
  updatedAt: number
}

export interface ImportOutcome {
  imported: BookSource[]
  issues: ValidationIssue[]
}

export const useSourcesStore = defineStore('sources', () => {
  const sources = ref<BookSource[]>([])
  const progress = ref<Record<string, SourceProgress>>({})
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** Issues from the most recent import, for the feedback strip. */
  const lastIssues = ref<ValidationIssue[]>([])
  /**
   * Which sources have a login, keyed by source id.
   *
   * Only metadata: the cookie itself stays in the backend and is never sent to
   * the renderer, so this is safe to hold in the store or log.
   */
  const credentials = ref<Record<string, api.CredentialStatus>>({})
  /** Sources whose login window is currently open. */
  const loggingIn = ref<Record<string, boolean>>({})

  const enabled = computed(() => sources.value.filter((source) => source.enabled))

  function byId(id: string): BookSource | undefined {
    return sources.value.find((source) => source.id === id)
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const raw = await api.sourcesLoad()
      // Storage is trusted (we wrote it), but a hand-edited file should not
      // crash the app: fall back to an empty list and say so.
      const parsed = validateSourceFile(raw ?? [])
      sources.value = parsed.sources
      // A file that fails validation used to vanish silently — the list simply
      // came up empty with no explanation. Say which field is wrong instead.
      if (!parsed.ok) {
        lastIssues.value = parsed.issues
        const first = parsed.issues[0]
        error.value = first
          ? `有 ${parsed.issues.length} 个书源字段不合法，已跳过：${first.path} ${first.message}`
          : '书源文件不合法，已跳过'
      }
      // The progress file is a plain map; coerce rather than trust its shape,
      // since it is written by us but can be hand-edited.
      const storedProgress = (await api.sourceProgressLoad()) ?? {}
      progress.value = storedProgress as Record<string, SourceProgress>
      await loadCredentials()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  /** Refresh the login status map. Cheap; called after any login attempt. */
  async function loadCredentials(): Promise<void> {
    try {
      credentials.value = (await api.credentialsStatus()) ?? {}
    } catch {
      // A missing credential file is a normal first run, not an error worth
      // interrupting the sources screen for.
      credentials.value = {}
    }
  }

  function credentialFor(sourceId: string): api.CredentialStatus | undefined {
    return credentials.value[sourceId]
  }

  /** Open the login window for one source. Resolves when the window is up. */
  async function startLogin(sourceId: string): Promise<void> {
    loggingIn.value = { ...loggingIn.value, [sourceId]: true }
    try {
      await api.sourceLoginStart(sourceId)
    } catch (cause) {
      loggingIn.value = { ...loggingIn.value, [sourceId]: false }
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  /** Record the outcome of a login attempt that the event reported. */
  async function finishLogin(sourceId: string): Promise<void> {
    loggingIn.value = { ...loggingIn.value, [sourceId]: false }
    await loadCredentials()
  }

  async function clearLogin(sourceId: string): Promise<void> {
    try {
      await api.credentialsClear(sourceId)
      await loadCredentials()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  /** Import one or more sources from a parsed JSON document. */
  async function importDocument(document_: unknown): Promise<ImportOutcome> {
    const result = validateSourceFile(document_)
    lastIssues.value = result.issues
    if (!result.ok) {
      return { imported: [], issues: result.issues }
    }

    // Merge by id: re-importing an updated source replaces it in place rather
    // than creating a duplicate, which is what "update this source" means.
    const merged = new Map(sources.value.map((source) => [source.id, source]))
    for (const source of result.sources) merged.set(source.id, source)
    sources.value = [...merged.values()]

    await persist()
    return { imported: result.sources, issues: [] }
  }

  async function remove(id: string): Promise<void> {
    sources.value = sources.value.filter((source) => source.id !== id)
    // Drop its progress too: the URLs are meaningless without the source.
    const next: Record<string, SourceProgress> = {}
    for (const [key, value] of Object.entries(progress.value)) {
      if (value.sourceId !== id) next[key] = value
    }
    progress.value = next
    await persist()
  }

  async function setEnabled(id: string, value: boolean): Promise<void> {
    const source = byId(id)
    if (!source) return
    source.enabled = value
    await persist()
  }

  async function persist(): Promise<void> {
    try {
      await api.sourcesSave(sources.value)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function progressKey(sourceId: string, chapterUrl: string): string {
    return `${sourceId}::${chapterUrl}`
  }

  function getProgress(sourceId: string, chapterUrl: string): SourceProgress | undefined {
    return progress.value[progressKey(sourceId, chapterUrl)]
  }

  async function saveProgress(entry: SourceProgress): Promise<void> {
    progress.value = {
      ...progress.value,
      [progressKey(entry.sourceId, entry.chapterUrl)]: entry,
    }
    try {
      await api.sourceProgressSave(progress.value)
    } catch {
      // Progress is best-effort, same contract as the local viewers.
    }
  }

  function clearIssues(): void {
    lastIssues.value = []
  }

  function clearError(): void {
    error.value = null
  }

  return {
    sources,
    enabled,
    progress,
    loading,
    error,
    lastIssues,
    credentials,
    loggingIn,
    byId,
    load,
    loadCredentials,
    credentialFor,
    startLogin,
    finishLogin,
    clearLogin,
    importDocument,
    remove,
    setEnabled,
    getProgress,
    saveProgress,
    clearIssues,
    clearError,
  }
})
