/**
 * Verifies aggregate search and the engine's skipped-node diagnostics.
 *
 * Run with: node scripts/verify-source-aggregate.mjs
 *
 * Both are pure-ish: `aggregateSearch` takes an injectable `engineFor`, and the
 * engine takes an injectable `fetcher`. That is the whole reason those seams
 * exist, so this script drives every branch with fixed HTML/JSON and no network.
 *
 * What the checks are actually protecting:
 *   - a source that times out is reported as a failure, not as "no results"
 *     (that confusion is the worst one in a scraper)
 *   - one slow source does not delay the others
 *   - the concurrency cap is respected
 *   - a skipped row produces a diagnosis with its index, so an author can find
 *     the offending selector
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { installDomShim } from './dom-shim.mjs'

// Must run before the engine module is imported: `selector.ts` resolves
// `DOMParser` lazily at call time, but the engine imports modules that look it up
// during their own evaluation.
installDomShim()

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
  const dir = await mkdtemp(join(root, 'node_modules/.tmp/verify-aggregate-'))
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    entryPoints: [join(root, relativePath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    alias: { '@': join(root, 'src') },
    logLevel: 'silent',
  })
  const module_ = await import(pathToFileURL(outfile).href)
  await rm(dir, { recursive: true, force: true })
  return module_
}

/** A minimal BookSource with the given type and name. */
function source(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'src',
    name: '源',
    version: '1.0.0',
    homepage: 'https://example.com',
    type: 'novel',
    enabled: true,
    request: { headers: {}, timeoutMs: 15000, delayMs: 0 },
    search: {
      url: 'https://example.com/search?q={{keyword}}',
      method: 'GET',
      list: 'css:li',
      fields: { title: 'css:.t', detailUrl: 'css:a@href' },
    },
    detail: { list: 'css:a', fields: { title: 'css:', url: 'css:@href' } },
    chapter: { content: 'css:#c' },
    ...overrides,
  }
}

async function main() {
  const { aggregateSearch, sourcesForType, DEFAULT_TIMEOUT_MS } = await loadModule(
    'src/sources/aggregate.ts',
  )
  const { SourceEngine } = await loadModule('src/sources/engine.ts')

  // --- engine diagnostics --------------------------------------------------
  console.log('engine diagnostics')
  {
    // Four list rows, three of which must be skipped for three distinct reasons.
    // Written out deliberately so each diagnosis is unambiguous:
    //   0 good
    //   1 no href attribute at all      → link diagnosis
    //   2 href is an empty string       → link diagnosis (resolves to nothing)
    //   3 no element matching `.t`      → title diagnosis
    // The `href=""` case is worth having: a placeholder link is extremely common
    // on listing pages, and treating it as valid would send the reader to the
    // search page itself.
    const html = `
      <ul>
        <li><a class="t" href="/b/1">Good One</a></li>
        <li><a class="t">No Link</a></li>
        <li><a class="t" href="">Empty Link</a></li>
        <li><span class="other">No Title Here</span></li>
        <li><a class="t" href="/b/2">Good Two</a></li>
      </ul>`
    const engine = new SourceEngine(source(), async () => ({
      status: 200,
      url: 'https://example.com/search?q=x',
      body: html,
    }))
    const result = await engine.searchWithDiagnoses('x')

    equal('two rows parsed', result.items.length, 2)
    equal('three rows diagnosed', result.diagnoses.length, 3)
    check(
      'diagnoses name the missing title',
      result.diagnoses.some((d) => d.reason.includes('标题')),
      JSON.stringify(result.diagnoses),
    )
    check(
      'diagnoses name the bad links',
      result.diagnoses.filter((d) => d.reason.includes('地址')).length === 2,
      JSON.stringify(result.diagnoses),
    )
    // Index 1 is "No Link" and index 2 is "Empty Link".
    check(
      'a diagnosis carries the row index',
      result.diagnoses.some((d) => d.index === 1) && result.diagnoses.some((d) => d.index === 2),
      JSON.stringify(result.diagnoses.map((d) => d.index)),
    )
    check(
      'a diagnosis carries an excerpt so the row is recognisable',
      result.diagnoses.some((d) => (d.excerpt ?? '').includes('No Link')),
      JSON.stringify(result.diagnoses.map((d) => d.excerpt)),
    )
    equal(
      'every diagnosis is tagged with its stage',
      [...new Set(result.diagnoses.map((d) => d.stage))],
      ['search'],
    )

    // The plain `search` must still work and drop the diagnostics.
    const legacy = await new SourceEngine(source(), async () => ({
      status: 200,
      url: 'https://example.com/search?q=x',
      body: html,
    })).search('x')
    equal('the plain search API is unchanged', legacy.length, 2)

    // A clean page yields no diagnoses.
    const clean = await new SourceEngine(source(), async () => ({
      status: 200,
      url: 'https://example.com/',
      body: '<ul><li><a class="t" href="/a">A</a></li></ul>',
    })).searchWithDiagnoses('x')
    equal('a clean parse has no diagnoses', clean.diagnoses, [])
  }

  console.log('detail diagnostics')
  {
    const engine = new SourceEngine(source(), async () => ({
      status: 200,
      url: 'https://example.com/b/1',
      body: `<div><a href="/c/1">Chapter 1</a><a>No Link</a><a href="/c/2">Chapter 2</a></div>`,
    }))
    const detail = await engine.detail('https://example.com/b/1')
    equal('two chapters parsed', detail.chapters.length, 2)
    equal('one chapter diagnosed', detail.diagnoses.length, 1)
    check(
      'the chapter diagnosis is tagged detail',
      detail.diagnoses[0]?.stage === 'detail',
      JSON.stringify(detail.diagnoses),
    )
  }

  // --- aggregate: success and failure mixed --------------------------------
  console.log('aggregate: per-source outcomes')
  {
    const good = source({ id: 'good', name: '好源' })
    const bad = source({ id: 'bad', name: '坏源' })

    const fakeEngine = (src) => ({
      searchWithDiagnoses: async () => {
        if (src.id === 'bad') throw new Error('请求失败：连接被拒绝')
        return {
          items: [
            {
              title: '书',
              author: null,
              cover: null,
              intro: null,
              type: 'novel',
              detailUrl: 'https://example.com/b/1',
            },
          ],
          diagnoses: [{ stage: 'search', index: 0, reason: '缺少标题', excerpt: '' }],
        }
      },
      dispose: () => {},
    })

    const settled = []
    const outcomes = await aggregateSearch({
      keyword: 'x',
      sources: [good, bad],
      engineFor: fakeEngine,
      onSettled: (o) => settled.push(o),
    })

    equal('one outcome per source', outcomes.length, 2)
    equal('onSettled fires once per source', settled.length, 2)

    const ok = outcomes.find((o) => o.kind === 'ok')
    const err = outcomes.find((o) => o.kind === 'error')
    check('the good source is ok', !!ok, JSON.stringify(outcomes))
    check('the bad source is an error, not an empty result', !!err, JSON.stringify(outcomes))
    equal('the ok outcome carries its items', ok?.items.length, 1)
    equal('the ok outcome counts skipped rows', ok?.skipped, 1)
    check(
      'the error outcome carries a readable message',
      typeof err?.message === 'string' && err.message.length > 0,
      JSON.stringify(err),
    )
  }

  // --- timeouts ------------------------------------------------------------
  console.log('aggregate: timeout behaviour')
  {
    const slow = source({ id: 'slow', name: '慢源' })
    const fast = source({ id: 'fast', name: '快源' })

    const times = []
    const outcomes = await aggregateSearch({
      keyword: 'x',
      sources: [slow, fast],
      timeoutMs: 120,
      engineFor: (src) => ({
        searchWithDiagnoses: async () => {
          if (src.id === 'slow') {
            // Longer than the deadline on purpose.
            await new Promise((resolve) => setTimeout(resolve, 400))
          }
          times.push({ id: src.id, at: Date.now() })
          return { items: [], diagnoses: [] }
        },
        dispose: () => {},
      }),
    })

    equal('both sources settle', outcomes.length, 2)
    const slowOutcome = outcomes.find((o) => o.sourceId === 'slow')
    check('the slow source is a timeout error', slowOutcome?.kind === 'error', JSON.stringify(slowOutcome))
    check(
      'the timeout message mentions the deadline',
      /秒|超时/.test(slowOutcome?.message ?? ''),
      JSON.stringify(slowOutcome),
    )
    const fastOutcome = outcomes.find((o) => o.sourceId === 'fast')
    check('the fast source still succeeds', fastOutcome?.kind === 'ok', JSON.stringify(fastOutcome))
    check(
      'the fast source finished before the slow one gave up',
      times.length >= 1 && times[0].id === 'fast',
      JSON.stringify(times),
    )
  }

  // --- concurrency ---------------------------------------------------------
  console.log('aggregate: concurrency cap')
  {
    let inFlight = 0
    let peak = 0
    const many = Array.from({ length: 10 }, (_, i) => source({ id: `s${i}`, name: `源${i}` }))

    await aggregateSearch({
      keyword: 'x',
      sources: many,
      concurrency: 3,
      engineFor: () => ({
        searchWithDiagnoses: async () => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 30))
          inFlight -= 1
          return { items: [], diagnoses: [] }
        },
        dispose: () => {},
      }),
    })

    check(`never exceeds the cap (peak ${peak})`, peak <= 3, `peak ${peak}`)
    check('actually uses the allowance', peak >= 2, `peak ${peak}`)
  }

  // --- cancellation --------------------------------------------------------
  console.log('aggregate: cancellation')
  {
    const many = Array.from({ length: 8 }, (_, i) => source({ id: `s${i}`, name: `源${i}` }))
    const signal = { cancelled: false }
    let started = 0

    const run = aggregateSearch({
      keyword: 'x',
      sources: many,
      concurrency: 1,
      signal,
      engineFor: () => ({
        searchWithDiagnoses: async () => {
          started += 1
          signal.cancelled = true // cancel as soon as the first one runs
          return { items: [], diagnoses: [] }
        },
        dispose: () => {},
      }),
    })
    const outcomes = await run

    check('cancelling stops further sources', started <= 2, `started ${started}`)
    check('a cancelled run reports few outcomes', outcomes.length <= 2, `${outcomes.length}`)
  }

  // --- dispose is always called -------------------------------------------
  console.log('aggregate: cleanup')
  {
    let disposed = 0
    await aggregateSearch({
      keyword: 'x',
      sources: [source({ id: 'a' }), source({ id: 'b', name: 'b' })],
      engineFor: () => ({
        searchWithDiagnoses: async () => {
          throw new Error('请求失败')
        },
        dispose: () => {
          disposed += 1
        },
      }),
    })
    equal('engines are disposed even when they throw', disposed, 2)
  }

  // --- source selection ----------------------------------------------------
  console.log('sourcesForType')
  {
    const list = [
      source({ id: 'n1', type: 'novel' }),
      source({ id: 'v1', type: 'video' }),
      source({ id: 'v2', type: 'video' }),
      source({ id: 'off', type: 'video', enabled: false }),
    ]
    equal('filters by type and enabled', sourcesForType(list, 'video').map((s) => s.id), ['v1', 'v2'])
    equal(
      'null type keeps every enabled source',
      sourcesForType(list, null).map((s) => s.id),
      ['n1', 'v1', 'v2'],
    )
  }

  // --- defaults ------------------------------------------------------------
  console.log('defaults')
  {
    check('a sane default timeout exists', DEFAULT_TIMEOUT_MS >= 5000, `${DEFAULT_TIMEOUT_MS}`)
    const none = await aggregateSearch({ keyword: '', sources: [source()] })
    equal('an empty keyword asks nobody', none, [])
    const noSources = await aggregateSearch({ keyword: 'x', sources: [] })
    equal('no sources means no outcomes', noSources, [])
  }

  console.log('')
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
