<script setup lang="ts">
/**
 * Settings.
 *
 * ## Visual language
 *
 * Two columns — categories left, one panel right — but the panel is not a form
 * dump: each group of fields is a **card**, a raised block with a 16px radius and
 * generous padding. That is the language the reference layout uses, and it earns
 * its keep here because settings are a list of unrelated concerns; without blocks,
 * "font size" and "request timeout" look equally related to each other.
 *
 * Colour stays out of it. The reference marks its blocks with green and teal, and
 * that is deliberately not copied: `docs/design-system.md` §1 has no brand colour,
 * and a screen that suddenly grew one would make every other screen look unfinished.
 * Separation comes from the surface ramp plus spacing, which is what the rest of the
 * app already does.
 *
 * Both themes are supported because the reference happens to be dark and this app
 * has light, dark, and system: only the ink/surface tokens swap, so the geometry in
 * here is theme-independent.
 *
 * ## What is not here
 *
 * Nothing on this page invents a setting. Each control reads and writes an existing
 * store or preference module; a control that changes nothing teaches people that
 * settings do nothing. Values that are reported but not editable (the proxy limits,
 * the concurrency count) are shown as labelled facts, not as disabled controls,
 * because a disabled slider implies it could be enabled.
 */
import { computed, onMounted, ref } from 'vue'
import { t } from '@/i18n'
import { useThemeStore, type ThemeChoice } from '@/stores/theme'
import {
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  MEASURE_RANGE,
  reading,
  resetReading,
  updateReading,
  type ReadingMode,
} from '@/library/readingPrefs'
import { sniffSupported } from '@/api/library'

type Category = 'appearance' | 'reading' | 'network' | 'storage' | 'about'

const CATEGORIES: readonly Category[] = ['appearance', 'reading', 'network', 'storage', 'about']

const active = ref<Category>('appearance')
const theme = useThemeStore()

/** Sniffing capability, so the network page can state a fact instead of a guess. */
const sniff = ref<{ supported: boolean; message: string | null } | null>(null)

onMounted(async () => {
  try {
    sniff.value = await sniffSupported()
  } catch {
    // A capability probe failing is not worth an error banner: the network section
    // simply omits the line.
    sniff.value = null
  }
})

const THEME_LABELS: Record<ThemeChoice, string> = {
  light: t('theme.light'),
  dark: t('theme.dark'),
  system: t('theme.system'),
}
const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system']

const MODE_LABELS: Record<ReadingMode, string> = {
  scroll: t('settings.reading.mode.scroll'),
  page: t('settings.reading.mode.page'),
}
const MODES: readonly ReadingMode[] = ['scroll', 'page']

/** The version string the app was built with, shown on the About page. */
const version = computed(() => '0.1.0')
</script>

<template>
  <div class="settings">
    <div class="settings-inner">
      <header class="settings-header">
        <h1 class="title">{{ t('settings.title') }}</h1>
        <p class="subtitle">{{ t('settings.subtitle') }}</p>
      </header>

      <div class="settings-body">
        <!-- Categories. A vertical list rather than tabs: the names are long enough
             that a tab bar would abbreviate them, and a list also makes the current
             section visible without reading the panel heading. -->
        <nav class="categories" :aria-label="t('settings.title')">
          <button
            v-for="category in CATEGORIES"
            :key="category"
            class="category"
            type="button"
            :class="{ 'is-active': active === category }"
            :aria-current="active === category ? 'page' : undefined"
            @click="active = category"
          >
            {{ t(`settings.${category}`) }}
          </button>
        </nav>

        <div class="panel">
          <!-- Appearance ------------------------------------------------ -->
          <template v-if="active === 'appearance'">
            <section class="card">
              <h2 class="card-title">{{ t('settings.appearance') }}</h2>

              <div class="row">
                <span class="row-label">{{ t('settings.appearance.theme') }}</span>
                <div
                  class="choices"
                  role="radiogroup"
                  :aria-label="t('settings.appearance.theme')"
                >
                  <button
                    v-for="choice in THEME_CHOICES"
                    :key="choice"
                    class="choice"
                    type="button"
                    role="radio"
                    :aria-checked="theme.choice === choice"
                    :class="{ 'is-active': theme.choice === choice }"
                    @click="theme.set(choice)"
                  >
                    {{ THEME_LABELS[choice] }}
                  </button>
                </div>
                <p class="row-hint">{{ t('settings.appearance.themeHint') }}</p>
              </div>
            </section>
          </template>

          <!-- Reading --------------------------------------------------- -->
          <template v-else-if="active === 'reading'">
            <section class="card">
              <h2 class="card-title">{{ t('settings.reading') }}</h2>

              <div class="row">
                <label class="row-label" for="reading-font-size">
                  {{ t('settings.reading.fontSize') }}
                </label>
                <div class="slider-row">
                  <input
                    id="reading-font-size"
                    class="slider"
                    type="range"
                    :min="FONT_SIZE_RANGE.min"
                    :max="FONT_SIZE_RANGE.max"
                    :step="FONT_SIZE_RANGE.step"
                    :value="reading.fontSize"
                    @input="
                      updateReading({
                        fontSize: Number(($event.target as HTMLInputElement).value),
                      })
                    "
                  />
                  <span class="slider-value">{{ reading.fontSize }} px</span>
                </div>
              </div>

              <div class="row">
                <label class="row-label" for="reading-line-height">
                  {{ t('settings.reading.lineHeight') }}
                </label>
                <div class="slider-row">
                  <input
                    id="reading-line-height"
                    class="slider"
                    type="range"
                    :min="LINE_HEIGHT_RANGE.min"
                    :max="LINE_HEIGHT_RANGE.max"
                    :step="LINE_HEIGHT_RANGE.step"
                    :value="reading.lineHeight"
                    @input="
                      updateReading({
                        lineHeight: Number(($event.target as HTMLInputElement).value),
                      })
                    "
                  />
                  <span class="slider-value">{{ reading.lineHeight.toFixed(1) }}</span>
                </div>
              </div>

              <div class="row">
                <label class="row-label" for="reading-measure">
                  {{ t('settings.reading.measure') }}
                </label>
                <div class="slider-row">
                  <input
                    id="reading-measure"
                    class="slider"
                    type="range"
                    :min="MEASURE_RANGE.min"
                    :max="MEASURE_RANGE.max"
                    :step="MEASURE_RANGE.step"
                    :value="reading.measure"
                    @input="
                      updateReading({ measure: Number(($event.target as HTMLInputElement).value) })
                    "
                  />
                  <span class="slider-value">{{ reading.measure }} ch</span>
                </div>
                <p class="row-hint">{{ t('settings.reading.measureHint') }}</p>
              </div>

              <div class="row">
                <span class="row-label">{{ t('settings.reading.mode') }}</span>
                <div class="choices" role="radiogroup" :aria-label="t('settings.reading.mode')">
                  <button
                    v-for="mode in MODES"
                    :key="mode"
                    class="choice"
                    type="button"
                    role="radio"
                    :aria-checked="reading.mode === mode"
                    :class="{ 'is-active': reading.mode === mode }"
                    @click="updateReading({ mode })"
                  >
                    {{ MODE_LABELS[mode] }}
                  </button>
                </div>
              </div>

              <div class="card-foot">
                <p class="row-hint">{{ t('settings.reading.hint') }}</p>
                <button class="btn btn--tertiary" type="button" @click="resetReading()">
                  {{ t('settings.reading.reset') }}
                </button>
              </div>
            </section>
          </template>

          <!-- Network --------------------------------------------------- -->
          <template v-else-if="active === 'network'">
            <section class="card">
              <h2 class="card-title">{{ t('settings.network') }}</h2>
              <p class="card-hint">{{ t('settings.network.hint') }}</p>

              <dl class="facts">
                <div class="fact">
                  <dt class="fact-label">{{ t('settings.network.timeout') }}</dt>
                  <dd class="fact-value">20 s</dd>
                </div>
                <div class="fact">
                  <dt class="fact-label">{{ t('settings.network.concurrency') }}</dt>
                  <dd class="fact-value">4</dd>
                </div>
                <div v-if="sniff" class="fact fact--wide">
                  <dt class="fact-label">{{ t('settings.network.sniff') }}</dt>
                  <dd class="fact-value">
                    {{
                      sniff.supported
                        ? t('settings.network.sniffSupported')
                        : sniff.message || t('settings.network.sniffUnsupported')
                    }}
                  </dd>
                </div>
              </dl>
            </section>

            <section class="card">
              <h2 class="card-title">{{ t('settings.network.proxy') }}</h2>
              <p class="card-hint">
                {{ t('settings.network.proxyHint', { limit: '64 MB' }) }}
              </p>
            </section>
          </template>

          <!-- Storage --------------------------------------------------- -->
          <template v-else-if="active === 'storage'">
            <section class="card">
              <h2 class="card-title">{{ t('settings.storage.dataDir') }}</h2>
              <p class="card-hint">{{ t('settings.storage.dataDirHint') }}</p>
            </section>

            <section class="card">
              <h2 class="card-title">{{ t('settings.storage.cleanup') }}</h2>
              <p class="card-hint">{{ t('settings.storage.cleanupHint') }}</p>
            </section>

            <section class="card">
              <h2 class="card-title">{{ t('settings.storage.export') }}</h2>
              <p class="card-hint">{{ t('settings.storage.exportHint') }}</p>
            </section>
          </template>

          <!-- About ----------------------------------------------------- -->
          <template v-else>
            <section class="card">
              <h2 class="card-title">{{ t('settings.about') }}</h2>

              <dl class="facts">
                <div class="fact">
                  <dt class="fact-label">{{ t('settings.about.version') }}</dt>
                  <dd class="fact-value">{{ version }}</dd>
                </div>
              </dl>

              <p class="card-hint">{{ t('settings.about.licenseBody') }}</p>
            </section>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  height: 100%;
  overflow-y: auto;
}

.settings-inner {
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
  padding: var(--space-7) var(--content-pad) var(--space-8);
}

.settings-header {
  margin-bottom: var(--space-6);
}

.title {
  font-size: var(--text-2xl);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
  letter-spacing: -0.01em;
  color: var(--ink-primary);
}

.subtitle {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

.settings-body {
  display: flex;
  gap: var(--space-6);
  align-items: flex-start;
}

/* --- Categories ---------------------------------------------------------
   Each item is a block on its own, matching the card language of the panel.
   The active one steps up a surface level and gains weight; no accent colour. */
.categories {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: none;
  width: 168px;
  position: sticky;
  top: var(--space-4);
}

.category {
  padding: var(--space-3) var(--space-4);
  text-align: left;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  border-radius: var(--radius-md);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.category:hover {
  background: var(--surface-hover);
  color: var(--ink-primary);
}

.category.is-active {
  background: var(--surface-raised);
  color: var(--ink-primary);
  font-weight: var(--weight-medium);
  box-shadow: var(--shadow-e1);
}

/* --- Panel --------------------------------------------------------------
   A vertical stack of cards. The gap is one full step larger than the padding
   inside a card, so blocks read as separate without a border. */
.panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* The raised surface alone is #ffffff on a #fafafa page — a 1.02:1 difference that
   is invisible in practice. The reference marks its blocks with saturated colour,
   which this palette refuses; the shadow is what replaces it, per the design
   system's rule that depth comes from surface plus elevation rather than borders.
   Without it the cards would not read as blocks at all. */
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-6);
  background: var(--surface-raised);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-e1);
}

.card-title {
  font-size: var(--text-md);
  font-weight: var(--weight-strong);
  color: var(--ink-primary);
}

.card-hint {
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ink-tertiary);
  max-width: 62ch;
}

/* Pushes the hint and the reset control apart from the sliders above them. */
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding-top: var(--space-1);
}

/* --- Rows ---------------------------------------------------------------
   One setting. Label above, control below: side-by-side reads worse once a
   slider is involved, because the control needs horizontal room. */
.row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.row-label {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
}

.row-hint {
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--ink-tertiary);
  max-width: 62ch;
}

/* --- Choices ------------------------------------------------------------
   Segmented control. A raised surface for the active one, a hairline for the
   rest: the active state has to be visible at a glance, and a background step
   alone is too subtle when the buttons sit inside a card that is already
   raised. */
.choices {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.choice {
  padding: var(--space-2) var(--space-5);
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius-md);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.choice:hover {
  background: var(--surface-hover);
  color: var(--ink-primary);
}

.choice.is-active {
  background: var(--surface-active);
  border-color: var(--line-strong);
  color: var(--ink-primary);
  font-weight: var(--weight-medium);
}

/* --- Sliders ------------------------------------------------------------ */
.slider-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  max-width: 460px;
}

.slider {
  flex: 1;
  accent-color: var(--surface-ink);
  cursor: pointer;
}

.slider-value {
  flex: none;
  min-width: 60px;
  font-size: var(--text-sm);
  color: var(--ink-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* --- Read-only facts ----------------------------------------------------
   Reported, not editable. A disabled control would imply it can be enabled;
   a label and a value state the fact and stop. */
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
  margin: 0;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.fact--wide {
  flex-basis: 100%;
}

.fact-label {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  letter-spacing: 0.02em;
}

.fact-value {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--ink-primary);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 760px) {
  .settings-inner {
    padding: var(--space-6) var(--space-4) var(--space-7);
  }

  .settings-body {
    flex-direction: column;
  }

  .categories {
    flex-direction: row;
    flex-wrap: wrap;
    width: auto;
    position: static;
  }

  .card {
    padding: var(--space-5);
  }
}
</style>
