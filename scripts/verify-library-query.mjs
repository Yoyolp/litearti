/**
 * Verifies the library query model and the progress readers.
 *
 * Run with: node scripts/verify-library-query.mjs
 *
 * These two modules are pure: no Pinia, no DOM, no Tauri. That is the whole
 * point of pulling them out of `LibraryView.vue`, so this script is the payoff —
 * it can drive every branch with plain objects.
 *
 * The checks that matter most are the two "no regressions" ones at the bottom:
 *   - the default query must reproduce the old recency ordering exactly, or the
 *     library looks reordered for no stated reason;
 *   - a progress payload of the wrong shape must produce "nothing", never a
 *     throw, because one bad entry must not blank the list.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = 'D:/Myproject/litearti'
const require = createRequire(import.meta.url)

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

function equal(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(label, a === e, `expected ${e}, got ${a}`)
}

async function loadModule(relativePath) {
  const esbuild = require(
    join(root, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'),
  )
  const dir = await mkdtemp(join(root, 'node_modules/.tmp/verify-query-'))
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    entryPoints: [join(root, relativePath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    // The `@` alias is a Vite concern; esbuild needs it spelled out.
    alias: { '@': join(root, 'src') },
    logLevel: 'silent',
  })
  const module_ = await import(pathToFileURL(outfile).href)
  await rm(dir, { recursive: true, force: true })
  return module_
}

// --- Fixtures --------------------------------------------------------------

let nextId = 0
function entry(overrides = {}) {
  nextId += 1
  return {
    id: `e${String(nextId).padStart(3, '0')}`,
    title: `条目 ${nextId}`,
    extension: 'txt',
    size: 1024 * nextId,
    sourcePath: `/tmp/x${nextId}.txt`,
    storedName: `x${nextId}.txt`,
    addedAt: 1_700_000_000_000 + nextId * 1000,
    lastOpenedAt: null,
    progress: null,
    ...overrides,
  }
}

async function main() {
  const q = await loadModule('src/library/query.ts')
  const progress = await loadModule('src/library/progress.ts')
  const builtin = await loadModule('src/library/builtinProgress.ts')

  // --- format buckets ------------------------------------------------------
  console.log('format buckets')
  {
    equal('txt is text', q.formatGroupOf('txt'), 'text')
    equal('MD with a dot still resolves', q.formatGroupOf('.md'), 'text')
    equal('PDF is pdf', q.formatGroupOf('pdf'), 'pdf')
    equal('EPUB is epub', q.formatGroupOf('EPUB'), 'epub')
    equal('flac is audio', q.formatGroupOf('flac'), 'audio')
    equal('an unknown container is other', q.formatGroupOf('cbz'), 'other')
    equal('no extension is other', q.formatGroupOf(''), 'other')
  }

  // --- read status ---------------------------------------------------------
  console.log('read status')
  {
    equal('no payload is unread', q.readStatusOf(entry()), 'unread')
    equal('null payload is unread', q.readStatusOf(entry({ progress: null })), 'unread')
    equal(
      'a ratio near 1 is finished',
      q.readStatusOf(entry({ progress: { version: 1, ratio: 0.99 } })),
      'finished',
    )
    equal(
      'a ratio below the threshold is reading',
      q.readStatusOf(entry({ progress: { version: 1, ratio: 0.5 } })),
      'reading',
    )
    equal(
      'a PDF page past the first is reading',
      q.readStatusOf(entry({ extension: 'pdf', progress: { version: 1, page: 12 } })),
      'reading',
    )
    equal(
      'a PDF still on page 1 is reading, not unread',
      q.readStatusOf(entry({ extension: 'pdf', progress: { version: 1, page: 1 } })),
      'reading',
    )
    equal(
      'audio with elapsed time is reading',
      q.readStatusOf(entry({ extension: 'mp3', progress: { version: 1, time: 30 } })),
      'reading',
    )
    equal(
      'a non-object payload is reading, not a crash',
      q.readStatusOf(entry({ progress: 'garbage' })),
      'reading',
    )
    equal(
      'an EPUB chapter 0 is reading',
      q.readStatusOf(entry({ extension: 'epub', progress: { version: 1, chapter: 0 } })),
      'reading',
    )
  }

  // --- text matching -------------------------------------------------------
  console.log('text matching')
  {
    const items = [
      entry({ title: '线性代数及其应用' }),
      entry({ title: 'Linear Algebra Done Right' }),
      entry({ title: '线性代数习题册', extension: 'pdf' }),
    ]
    const byTitle = q.applyQuery(items, { ...q.DEFAULT_QUERY, text: '线性' })
    check('one term matches a substring', byTitle.length === 2, `${byTitle.length}`)

    const twoTerms = q.applyQuery(items, { ...q.DEFAULT_QUERY, text: '线性 习题' })
    equal('two terms are AND, not OR', twoTerms.length, 1)

    const caseInsensitive = q.applyQuery(items, { ...q.DEFAULT_QUERY, text: 'linear' })
    equal('matching is case-insensitive', caseInsensitive.length, 1)

    const byExtension = q.applyQuery(items, { ...q.DEFAULT_QUERY, text: 'pdf' })
    equal('the extension is searchable too', byExtension.length, 1)

    const padded = q.applyQuery(items, { ...q.DEFAULT_QUERY, text: '  线性  ' })
    equal('surrounding whitespace is ignored', padded.length, 2)

    const nothing = q.applyQuery(items, { ...q.DEFAULT_QUERY, text: 'zzz' })
    equal('a miss returns nothing', nothing.length, 0)

    const empty = q.applyQuery(items, { ...q.DEFAULT_QUERY, text: '' })
    equal('an empty query keeps everything', empty.length, 3)
  }

  // --- rename --------------------------------------------------------------
  console.log('display title')
  {
    const a = entry({ title: '原文件名', rename: '改过的名字' })
    equal('a rename wins', q.displayTitle(a), '改过的名字')
    const b = entry({ title: '原文件名', rename: '   ' })
    equal('a blank rename falls back', q.displayTitle(b), '原文件名')
    const c = entry({ title: '原文件名', rename: null })
    equal('a null rename falls back', q.displayTitle(c), '原文件名')

    const items = [entry({ title: '原名', rename: '关键字' })]
    equal(
      'search finds the renamed title',
      q.applyQuery(items, { ...q.DEFAULT_QUERY, text: '关键字' }).length,
      1,
    )
  }

  // --- filters -------------------------------------------------------------
  console.log('filters')
  {
    const items = [
      entry({ extension: 'txt', progress: null }),
      entry({ extension: 'pdf', progress: { version: 1, page: 5 } }),
      entry({ extension: 'mp3', progress: { version: 1, time: 60 } }),
      entry({ extension: 'txt', progress: { version: 1, ratio: 0.99 } }),
    ]
    equal(
      'format filter narrows',
      q.applyQuery(items, { ...q.DEFAULT_QUERY, format: 'pdf' }).length,
      1,
    )
    equal(
      'status filter narrows',
      q.applyQuery(items, { ...q.DEFAULT_QUERY, status: 'unread' }).length,
      1,
    )
    equal(
      'status finished finds the ratio-0.99 entry',
      q.applyQuery(items, { ...q.DEFAULT_QUERY, status: 'finished' }).length,
      1,
    )
    equal(
      'filters compose',
      q.applyQuery(items, { ...q.DEFAULT_QUERY, format: 'text', status: 'unread' }).length,
      1,
    )
    equal(
      'group filter is exact',
      q.applyQuery(
        [entry({ group: 'a' }), entry({ group: 'b' }), entry({ group: null })],
        { ...q.DEFAULT_QUERY, group: 'a' },
      ).length,
      1,
    )
    equal(
      'a null group filter keeps everything',
      q.applyQuery([entry({ group: 'a' }), entry({ group: null })], q.DEFAULT_QUERY).length,
      2,
    )
  }

  // --- counts --------------------------------------------------------------
  console.log('counts')
  {
    const items = [
      entry({ extension: 'txt' }),
      entry({ extension: 'md' }),
      entry({ extension: 'pdf', progress: { version: 1, page: 3 } }),
      entry({ extension: 'cbz' }),
    ]
    const formats = q.countsByFormat(items)
    equal('text counts both txt and md', formats.text, 2)
    equal('pdf counts', formats.pdf, 1)
    equal('unknown lands in other', formats.other, 1)
    equal('empty buckets are zero', formats.epub, 0)
    check(
      'every bucket is present even when zero',
      ['text', 'pdf', 'epub', 'audio', 'other'].every((k) => typeof formats[k] === 'number'),
    )

    const statuses = q.countsByStatus(items)
    equal('three unopened entries', statuses.unread, 3)
    equal('one opened entry', statuses.reading, 1)

    equal('distinct groups, sorted', q.distinctGroups([
      entry({ group: 'b' }),
      entry({ group: 'a' }),
      entry({ group: null }),
      entry({ group: 'a' }),
      entry({ group: '  ' }),
    ]), ['a', 'b'])
  }

  // --- sorting -------------------------------------------------------------
  console.log('sorting')
  {
    const items = [
      entry({ title: 'b', size: 20, addedAt: 2000 }),
      entry({ title: 'a', size: 30, addedAt: 1000 }),
      entry({ title: 'c', size: 10, addedAt: 3000 }),
    ]
    equal(
      'title asc',
      q.applyQuery(items, { ...q.DEFAULT_QUERY, sort: 'title', direction: 'asc' }).map(
        (e) => e.title,
      ),
      ['a', 'b', 'c'],
    )
    equal(
      'title desc',
      q.applyQuery(items, { ...q.DEFAULT_QUERY, sort: 'title', direction: 'desc' }).map(
        (e) => e.title,
      ),
      ['c', 'b', 'a'],
    )
    equal(
      'size asc',
      q.applyQuery(items, { ...q.DEFAULT_QUERY, sort: 'size', direction: 'asc' }).map(
        (e) => e.size,
      ),
      [10, 20, 30],
    )
    equal(
      'added desc is newest first',
      q.applyQuery(items, { ...q.DEFAULT_QUERY, sort: 'added', direction: 'desc' }).map(
        (e) => e.addedAt,
      ),
      [3000, 2000, 1000],
    )

    // `progress` sort: no payload sorts as -1, so ascending puts untouched
    // entries first and a real ratio last.
    const withProgress = [
      entry({ title: 'none', progress: null }),
      entry({ title: 'half', progress: { version: 1, ratio: 0.5 } }),
      entry({ title: 'chapterOnly', progress: { version: 1, chapter: 2 } }),
    ]
    equal(
      'progress asc puts the untouched first',
      q.applyQuery(withProgress, {
        ...q.DEFAULT_QUERY,
        sort: 'progress',
        direction: 'asc',
      }).map((e) => e.title),
      ['none', 'chapterOnly', 'half'],
    )
  }

  // --- regression: the default query ----------------------------------------
  console.log('regression: default ordering')
  {
    // The previous store sorted by max(lastOpenedAt, addedAt) descending. If the
    // new model does not reproduce that, the library silently reorders for
    // everyone on upgrade.
    const items = [
      entry({ title: 'imported only', addedAt: 1000, lastOpenedAt: null }),
      entry({ title: 'opened recently', addedAt: 2000, lastOpenedAt: 5000 }),
      entry({ title: 'newest import', addedAt: 4000, lastOpenedAt: null }),
      entry({ title: 'opened earlier', addedAt: 1500, lastOpenedAt: 3000 }),
    ]
    const sorted = q.applyQuery(items, q.DEFAULT_QUERY).map((e) => e.title)
    equal('most recent activity first', sorted, [
      'opened recently',
      'newest import',
      'opened earlier',
      'imported only',
    ])

    check('the default query reports itself as default', q.isDefaultQuery(q.DEFAULT_QUERY))
    check(
      'a changed sort is not default',
      !q.isDefaultQuery({ ...q.DEFAULT_QUERY, sort: 'title' }),
    )
    check(
      'text alone is not default',
      !q.isDefaultQuery({ ...q.DEFAULT_QUERY, text: 'x' }),
    )
    check(
      'whitespace-only text is still default',
      q.isDefaultQuery({ ...q.DEFAULT_QUERY, text: '   ' }),
    )
  }

  // --- ties are stable -----------------------------------------------------
  console.log('stable ordering')
  {
    // Same activity time on four entries: the tiebreak must be total, or the
    // list reshuffles on every render.
    const items = Array.from({ length: 4 }, (_, i) =>
      entry({ title: `tie${i}`, addedAt: 5000, lastOpenedAt: null }),
    )
    const once = q.applyQuery(items, q.DEFAULT_QUERY).map((e) => e.id)
    const twice = q.applyQuery([...items].reverse(), q.DEFAULT_QUERY).map((e) => e.id)
    equal('a tiebreak makes the order independent of input order', once, twice)
  }

  // --- progress readers ----------------------------------------------------
  console.log('progress readers')
  {
    const { registerProgressReader, readProgress } = progress
    builtin.registerBuiltinProgressReaders(registerProgressReader)

    function read(extension, payload) {
      return readProgress(entry({ extension, progress: payload }))
    }

    // text
    equal('text ratio becomes a bar and a percent', read('txt', { version: 1, ratio: 0.42 }), {
      ratio: 0.42,
      label: '已读 42%',
    })
    equal('text below 1% says nothing', read('txt', { version: 1, ratio: 0.004 }), {
      ratio: 0.004,
      label: null,
    })
    equal(
      'text with a chapter prefers the chapter label',
      read('txt', { version: 1, ratio: 0.42, chapter: 4 }),
      { ratio: 0.42, label: '第 5 章' },
    )

    // pdf
    equal('pdf page 1 says nothing', read('pdf', { version: 1, page: 1 }), {
      ratio: null,
      label: null,
    })
    equal('pdf page 12 names the page', read('pdf', { version: 1, page: 12 }), {
      ratio: null,
      label: '第 12 页',
    })
    equal('pdf page 0 is not a page', read('pdf', { version: 1, page: 0 }), {
      ratio: null,
      label: null,
    })

    // epub
    equal(
      'epub names the chapter, using a 1-based label',
      read('epub', { version: 1, chapter: 2, ratio: 0.3 }),
      { ratio: 0.3, label: '第 3 章' },
    )
    equal(
      'epub fixed-layout has no ratio',
      read('epub', { version: 1, chapter: 0 }),
      { ratio: null, label: '第 1 章' },
    )

    // audio
    equal('audio under 5s says nothing', read('mp3', { version: 1, time: 2 }), {
      ratio: null,
      label: null,
    })
    equal('audio reports elapsed time', read('mp3', { version: 1, time: 204 }), {
      ratio: null,
      label: '听到 3:24',
    })
    equal('audio past an hour', read('flac', { version: 1, time: 3725 }), {
      ratio: null,
      label: '听到 1:02:05',
    })

    // degradation
    equal('an unknown extension has no reader', read('cbz', { version: 1, page: 3 }), {
      ratio: null,
      label: null,
    })
    equal('a null payload is empty', read('txt', null), { ratio: null, label: null })
    equal('a string payload is empty', read('txt', 'nonsense'), { ratio: null, label: null })
    equal('a missing field is empty', read('txt', { version: 1 }), {
      ratio: null,
      label: null,
    })
    equal(
      'an out-of-range ratio is rejected rather than drawn',
      read('txt', { version: 1, ratio: 42 }),
      { ratio: null, label: null },
    )

    // A reader that throws must not escape.
    registerProgressReader(['boom'], () => {
      throw new Error('reader exploded')
    })
    equal('a throwing reader degrades to nothing', read('boom', {}), {
      ratio: null,
      label: null,
    })
  }

  console.log('')
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
