/**
 * Theme preference: light, dark, or follow the system.
 *
 * The resolved theme is written to `<html data-theme>`; every color token in
 * `tokens.css` keys off that attribute, so switching theme never touches a
 * component. Nothing else in the app reads `prefers-color-scheme`.
 *
 * The choice persists in `localStorage`. It is a UI preference, not library
 * data: it must not live in `library.json`, which belongs to the backend and
 * would then need a migration whenever the theme list changes.
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'litearti.theme'

/** Read the stored choice, defaulting to following the system. */
function readStoredChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // Storage can be unavailable (private mode, locked profile). A missing
    // preference is not an error; the default is fine.
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

export const useThemeStore = defineStore('theme', () => {
  const choice = ref<ThemeChoice>(readStoredChoice())
  /** Tracks the OS setting live, so "system" follows it without a reload. */
  const systemDark = ref(systemPrefersDark())

  const resolved = computed<ResolvedTheme>(() => {
    if (choice.value === 'system') return systemDark.value ? 'dark' : 'light'
    return choice.value
  })

  /** Apply the resolved theme to the document root. */
  function apply(): void {
    const root = document.documentElement
    root.dataset.theme = resolved.value
    // `color-scheme` makes native widgets (scrollbars, form controls, the
    // webview's own background) match; without it dark mode shows white
    // scrollbar tracks and a white flash on load.
    root.style.colorScheme = resolved.value
  }

  function set(next: ThemeChoice): void {
    choice.value = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Persisting is best-effort; the in-memory choice still applies.
    }
  }

  /** Cycle light → dark → system, for a single-button toggle. */
  function cycle(): void {
    const order: ThemeChoice[] = ['light', 'dark', 'system']
    const index = order.indexOf(choice.value)
    set(order[(index + 1) % order.length]!)
  }

  /** Start listening for OS theme changes. Safe to call more than once. */
  function init(): void {
    apply()
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => {
      systemDark.value = event.matches
    }
    // `addEventListener` is the modern form; older WebViews only have
    // `addListener`, so fall back rather than throwing.
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange)
    } else if (typeof query.addListener === 'function') {
      query.addListener(onChange)
    }
  }

  // Re-apply whenever the resolved value changes (including OS-driven change).
  watch(resolved, apply, { immediate: true })

  return { choice, resolved, set, cycle, init }
})
