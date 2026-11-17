<script setup lang="ts">
/**
 * Discover: trending shows and the weekly season calendar.
 *
 * ## Why two tabs in one screen
 *
 * They answer the same question — "what should I watch" — from two directions: what is
 * popular now, and what airs on a given day. Splitting them into two sidebar entries
 * would double the navigation for one idea.
 *
 * ## Opening a subject
 *
 * There is no detail endpoint behind the mirror, so the card carries everything that
 * will be shown: cover, title, score, date, summary. "Opening" therefore means
 * something different here than in the library — it does not open a page, it searches
 * the person's own sources for the title and jumps to the best match. That is the
 * only action that actually leads to watching something, and it is why the button
 * says「在源里找」rather than「打开」.
 *
 * ## Failure is expected, not exceptional
 *
 * The mirror is someone else's server, reached over a network that may not allow it.
 * Every load path has a visible error state with a retry, and the Rust side serves a
 * stale cache when the network fails. A blank tab would be indistinguishable from a
 * broken app.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { t } from '@/i18n'
import {
  currentSeason,
  loadCalendar,
  loadPopular,
  nextSeason,
  previousSeason,
  seasonLabel,
  sameSeason,
  type Season,
} from '@/discover/api'
import { displayName, type CalendarDay, type Subject } from '@/discover/subject'
import {
  COLLECT_STATUSES,
  collectTable,
  idsWithStatus,
  setStatus,
  type CollectStatus,
} from '@/discover/collect'
import { bestMatch } from '@/discover/match'
import SubjectCard from '@/components/SubjectCard.vue'
import { useSourcesStore } from '@/stores/sources'
import { SourceEngine } from '@/sources/engine'

const emit = defineEmits<{
  /** Open a source's detail page for the matched title. */
  open: [payload: { sourceId: string; detailUrl: string; title: string }]
}>()

type Tab = 'popular' | 'timeline'
type Sort = 'popularity' | 'rating'

const tab = ref<Tab>('popular')
const sources = useSourcesStore()

// --- Popular ---------------------------------------------------------------

const popular = ref<Subject[]>([])
const popularLoading = ref(false)
const popularError = ref<string | null>(null)
const popularHasMore = ref(false)
const popularOffset = ref(0)

async function loadPopularFirst(): Promise<void> {
  popularLoading.value = true
  popularError.value = null
  try {
    const page = await loadPopular(0)
    popular.value = page.subjects
    popularHasMore.value = page.hasMore
    popularOffset.value = page.subjects.length
  } catch (cause) {
    popularError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    popularLoading.value = false
  }
}

async function loadMorePopular(): Promise<void> {
  if (popularLoading.value || !popularHasMore.value) return
  popularLoading.value = true
  try {
    const page = await loadPopular(popularOffset.value)
    // Deduplicate by id: the endpoint has no stable ordering guarantee, so a paging
    // request can legitimately return an item already shown.
    const seen = new Set(popular.value.map((item) => item.id))
    popular.value = [...popular.value, ...page.subjects.filter((item) => !seen.has(item.id))]
    popularHasMore.value = page.hasMore
    popularOffset.value += page.subjects.length
  } catch (cause) {
    popularError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    popularLoading.value = false
  }
}

// --- Timeline --------------------------------------------------------------

const season = ref<Season>(currentSeason())
const calendar = ref<CalendarDay[]>([])
const calendarLoading = ref(false)
const calendarError = ref<string | null>(null)
const sort = ref<Sort>('popularity')

async function loadCalendarFor(target: Season): Promise<void> {
  calendarLoading.value = true
  calendarError.value = null
  try {
    calendar.value = await loadCalendar(target)
  } catch (cause) {
    calendarError.value = cause instanceof Error ? cause.message : String(cause)
    calendar.value = []
  } finally {
    calendarLoading.value = false
  }
}

function shiftSeason(delta: -1 | 1): void {
  season.value = delta === -1 ? previousSeason(season.value) : nextSeason(season.value)
}

const isCurrentSeason = computed(() => sameSeason(season.value, currentSeason()))

/** Today's weekday in Bangumi's numbering (Monday = 1), for highlighting. */
const todayWeekday = computed(() => {
  const day = new Date().getDay()
  return day === 0 ? 7 : day
})

/** A day's subjects, sorted and filtered. */
function daySubjects(day: CalendarDay): Subject[] {
  let list = [...day.subjects]

  if (onlyMarked.value) {
    const marked = markedIds.value
    list = list.filter((subject) => marked.has(subject.id))
  }

  list.sort((a, b) => {
    if (sort.value === 'rating') return b.rating.score - a.rating.score
    // Popularity is the vote count, which only the calendar response carries.
    return b.rating.total - a.rating.total
  })
  return list
}

// --- Collect filter --------------------------------------------------------

const onlyMarked = ref(false)

/** Ids of every subject that has any status. */
const markedIds = computed(() => {
  const ids = new Set<number>()
  for (const key of Object.keys(collectTable.value)) ids.add(Number(key))
  return ids
})

/** Counts per status, for the filter row. */
const statusCounts = computed(() => {
  const counts: Record<CollectStatus, number> = {
    wish: 0,
    watching: 0,
    watched: 0,
    onHold: 0,
  }
  for (const status of COLLECT_STATUSES) counts[status] = idsWithStatus(status).size
  return counts
})

const STATUS_LABELS: Record<CollectStatus, string> = {
  wish: t('discover.collect.wish'),
  watching: t('discover.collect.watching'),
  watched: t('discover.collect.watched'),
  onHold: t('discover.collect.onHold'),
}

// --- Opening a subject -----------------------------------------------------

/** Subject id currently being searched for, so its card can say so. */
const searching = ref<number | null>(null)
/** Result of the last search, shown as a strip. */
const searchNotice = ref<string | null>(null)

/**
 * Search every enabled video source for this title, then jump to the best match.
 *
 * Sequential, stopping at the first source that yields a confident match: this runs
 * on a click, and firing a dozen searches at a dozen sites to answer one question is
 * both slow and rude. Sources fail independently — one being down must not stop the
 * search.
 */
async function openSubject(subject: Subject): Promise<void> {
  if (searching.value !== null) return
  const title = displayName(subject)
  searching.value = subject.id
  searchNotice.value = null

  try {
    const candidates = sources.sources.filter(
      (source) => source.enabled && source.type === 'video',
    )
    if (!candidates.length) {
      searchNotice.value = t('discover.open.none', { title })
      return
    }

    for (const source of candidates) {
      try {
        const engine = new SourceEngine(source)
        const results = await engine.search(title)
        const match = bestMatch(
          title,
          results.map((item) => ({ title: item.title, item })),
        )
        if (match) {
          // A fuzzy hit is announced rather than silent: the person clicked a title
          // and lands on a possibly-differently-named one, and they should know why.
          searchNotice.value =
            match.score >= 1
              ? t('discover.open.found', { title: match.item.item.title })
              : t('discover.open.found', { title: match.item.item.title })
          emit('open', {
            sourceId: source.id,
            detailUrl: match.item.item.detailUrl,
            title: match.item.item.title,
          })
          return
        }
      } catch {
        // This source could not answer; the next one might.
      }
    }
    searchNotice.value = t('discover.open.none', { title })
  } finally {
    searching.value = null
  }
}

// --- Lifecycle -------------------------------------------------------------

onMounted(() => {
  void loadPopularFirst()
  void loadCalendarFor(season.value)
})

// Only fetch a season once, when the picker lands on it.
watch(season, (value) => void loadCalendarFor(value))

/** Apply a status from the timeline's filter row, for keyboard reach. */
function toggleMarkedFilter(): void {
  onlyMarked.value = !onlyMarked.value
}

// Referenced so the template can use it without a local alias.
void setStatus
</script>

<template>
  <div class="discover">
    <header class="discover-header">
      <div class="heading">
        <h1 class="title">{{ t('discover.title') }}</h1>
        <p class="subtitle">{{ t('discover.subtitle') }}</p>
      </div>

      <div class="tabs" role="tablist" :aria-label="t('discover.title')">
        <button
          class="tab"
          type="button"
          role="tab"
          :aria-selected="tab === 'popular'"
          :class="{ 'is-active': tab === 'popular' }"
          @click="tab = 'popular'"
        >
          {{ t('discover.tab.popular') }}
        </button>
        <button
          class="tab"
          type="button"
          role="tab"
          :aria-selected="tab === 'timeline'"
          :class="{ 'is-active': tab === 'timeline' }"
          @click="tab = 'timeline'"
        >
          {{ t('discover.tab.timeline') }}
        </button>
      </div>
    </header>

    <!-- A persistent strip, never a toast: the result of a search has to stay
         readable while the person looks at where they landed. -->
    <div v-if="searchNotice" class="notice" role="status">
      <span class="notice-text">{{ searchNotice }}</span>
      <button
        class="notice-close"
        type="button"
        :aria-label="t('common.dismiss')"
        @click="searchNotice = null"
      >
        ×
      </button>
    </div>

    <!-- Popular ------------------------------------------------------- -->
    <section v-if="tab === 'popular'" class="panel">
      <div v-if="popularError" class="state">
        <p class="state-title">{{ t('discover.error') }}</p>
        <p class="state-body">{{ popularError }}</p>
        <button class="btn btn--tertiary" type="button" @click="loadPopularFirst()">
          {{ t('discover.retry') }}
        </button>
      </div>

      <div v-else-if="popularLoading && !popular.length" class="state">
        <p class="state-body">{{ t('discover.loading') }}</p>
      </div>

      <div v-else-if="!popular.length" class="state">
        <p class="state-body">{{ t('discover.empty') }}</p>
      </div>

      <template v-else>
        <div class="grid">
          <SubjectCard
            v-for="subject in popular"
            :key="subject.id"
            :subject="subject"
            show-collect
            @open="openSubject"
          />
        </div>

        <div class="more">
          <button
            v-if="popularHasMore"
            class="btn btn--tertiary"
            type="button"
            :disabled="popularLoading"
            @click="loadMorePopular()"
          >
            {{ popularLoading ? t('discover.loading') : t('discover.more') }}
          </button>
          <p v-else class="more-end">{{ t('discover.noMore') }}</p>
        </div>
      </template>
    </section>

    <!-- Timeline ------------------------------------------------------ -->
    <section v-else class="panel">
      <div class="timeline-bar">
        <div class="season-nav">
          <button class="btn btn--tertiary" type="button" @click="shiftSeason(-1)">
            {{ t('discover.season.prev') }}
          </button>
          <span class="season-label">{{ seasonLabel(season) }}</span>
          <button class="btn btn--tertiary" type="button" @click="shiftSeason(1)">
            {{ t('discover.season.next') }}
          </button>
          <button
            v-if="!isCurrentSeason"
            class="btn btn--tertiary"
            type="button"
            @click="season = currentSeason()"
          >
            {{ t('discover.season.current') }}
          </button>
        </div>

        <div class="timeline-controls">
          <div class="choices" role="radiogroup" :aria-label="t('discover.sort.popularity')">
            <button
              class="choice"
              type="button"
              role="radio"
              :aria-checked="sort === 'popularity'"
              :class="{ 'is-active': sort === 'popularity' }"
              @click="sort = 'popularity'"
            >
              {{ t('discover.sort.popularity') }}
            </button>
            <button
              class="choice"
              type="button"
              role="radio"
              :aria-checked="sort === 'rating'"
              :class="{ 'is-active': sort === 'rating' }"
              @click="sort = 'rating'"
            >
              {{ t('discover.sort.rating') }}
            </button>
          </div>

          <button
            class="choice"
            type="button"
            :aria-pressed="onlyMarked"
            :class="{ 'is-active': onlyMarked }"
            @click="toggleMarkedFilter()"
          >
            {{ t('discover.collect.filter') }}
          </button>
        </div>
      </div>

      <!-- Status totals. Useful even unfiltered: it is the only place the app
           shows what you have marked. -->
      <dl class="status-summary">
        <div v-for="status in COLLECT_STATUSES" :key="status" class="status-fact">
          <dt class="status-label">{{ STATUS_LABELS[status] }}</dt>
          <dd class="status-value">{{ statusCounts[status] }}</dd>
        </div>
      </dl>

      <div v-if="calendarError" class="state">
        <p class="state-title">{{ t('discover.error') }}</p>
        <p class="state-body">{{ calendarError }}</p>
        <button class="btn btn--tertiary" type="button" @click="loadCalendarFor(season)">
          {{ t('discover.retry') }}
        </button>
      </div>

      <div v-else-if="calendarLoading && !calendar.length" class="state">
        <p class="state-body">{{ t('discover.loading') }}</p>
      </div>

      <div v-else class="days">
        <section
          v-for="day in calendar"
          :key="day.weekday"
          class="day"
          :class="{ 'is-today': day.weekday === todayWeekday && isCurrentSeason }"
        >
          <header class="day-head">
            <h2 class="day-title">
              {{ t(`discover.weekday.${day.weekday}` as 'discover.weekday.1') }}
              <span
                v-if="day.weekday === todayWeekday && isCurrentSeason"
                class="day-today"
              >
                {{ t('discover.today') }}
              </span>
            </h2>
            <span class="day-count">{{ daySubjects(day).length }}</span>
          </header>

          <p v-if="!daySubjects(day).length" class="day-empty">
            {{ t('discover.empty') }}
          </p>

          <div v-else class="grid grid--day">
            <SubjectCard
              v-for="subject in daySubjects(day)"
              :key="subject.id"
              :subject="subject"
              show-collect
              @open="openSubject"
            />
          </div>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.discover {
  height: 100%;
  overflow-y: auto;
}

.discover-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-5);
  flex-wrap: wrap;
  padding: var(--space-7) var(--content-pad) var(--space-4);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
}

.title {
  font-size: var(--text-2xl);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
  letter-spacing: -0.01em;
}

.subtitle {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
}

/* --- Tabs ---------------------------------------------------------------
   Two words, no underline slider: the active one steps up to full ink and a
   surface level. A moving underline would imply an animated indicator that this
   app does not otherwise have. */
.tabs {
  display: flex;
  gap: var(--space-1);
}

.tab {
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
  border-radius: var(--radius-md);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.tab:hover {
  color: var(--ink-secondary);
  background: var(--surface-hover);
}

.tab.is-active {
  background: var(--surface-active);
  color: var(--ink-primary);
  font-weight: var(--weight-medium);
}

/* --- Notice ------------------------------------------------------------- */
.notice {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 var(--content-pad) var(--space-3);
  padding: var(--space-2) var(--space-4);
  max-width: calc(var(--shell-max) - var(--content-pad) * 2);
  margin-inline: auto;
  background: var(--surface-sunken);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--ink-secondary);
}

.notice-text {
  flex: 1;
  min-width: 0;
}

.notice-close {
  flex: none;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-tertiary);
  border-radius: var(--radius-sm);
}

.notice-close:hover {
  background: var(--surface-hover);
  color: var(--ink-primary);
}

/* --- Panels ------------------------------------------------------------- */
.panel {
  padding: 0 var(--content-pad) var(--space-7);
  max-width: var(--shell-max);
  width: 100%;
  margin: 0 auto;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--card-min-width), 1fr));
  gap: var(--grid-gap);
}

/* A day holds a handful of shows; a denser grid keeps the column short. */
.grid--day {
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: var(--space-3);
}

.more {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0 0;
}

.more-end {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

/* --- Timeline ----------------------------------------------------------- */
.timeline-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
}

.season-nav {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.season-label {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  font-variant-numeric: tabular-nums;
  min-width: 92px;
  text-align: center;
}

.timeline-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.choices {
  display: flex;
  gap: var(--space-1);
}

.choice {
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  border-radius: var(--radius-sm);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.choice:hover {
  background: var(--surface-hover);
  color: var(--ink-secondary);
}

.choice.is-active {
  background: var(--surface-active);
  color: var(--ink-primary);
  font-weight: var(--weight-medium);
}

.status-summary {
  display: flex;
  gap: var(--space-5);
  margin: 0 0 var(--space-5);
}

.status-fact {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.status-label {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.status-value {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
  font-variant-numeric: tabular-nums;
}

/* --- Days ---------------------------------------------------------------
   Seven blocks, separated by spacing rather than rules. Today gets a surface
   step, which is the only emphasis the design system allows without hue. */
.days {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.day {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
}

.day.is-today {
  background: var(--surface-sunken);
}

.day-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}

.day-title {
  font-size: var(--text-md);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
}

.day-today {
  margin-left: var(--space-2);
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

.day-count {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
  font-variant-numeric: tabular-nums;
}

.day-empty {
  font-size: var(--text-xs);
  color: var(--ink-tertiary);
}

/* --- States ------------------------------------------------------------- */
.state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-6) 0;
}

.state-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--ink-primary);
}

.state-body {
  font-size: var(--text-sm);
  color: var(--ink-tertiary);
  max-width: 60ch;
}

@media (max-width: 700px) {
  .discover-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
