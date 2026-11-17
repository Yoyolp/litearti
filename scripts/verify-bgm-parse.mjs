/**
 * Verifies the Bangumi subject parser against real captured responses.
 *
 * Run with: node scripts/verify-bgm-parse.mjs
 *
 * The fixtures in `scripts/fixtures/bgm-*.json` are **real responses** from
 * `api.kazumi.fyi`, captured with `curl`/`fetch` and committed unmodified. That is
 * the point of this test: the parser makes claims about two endpoints that disagree
 * with each other (rating.count is an object on one and an array on the other, `date`
 * is absent on one), and those claims are only worth anything if they are checked
 * against data the server actually produced.
 *
 * A hand-written fixture would test that the parser parses what the parser's author
 * imagined. It would stay green forever while the real API drifted.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = 'D:/Myproject/litearti'
const fixtures = join(root, 'scripts/fixtures')
const require = createRequire(import.meta.url)

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

async function loadModule(relativePath) {
  const esbuild = require(
    join(root, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'),
  )
  const outfile = join(root, `.tmp-bgm-${Date.now()}.mjs`)
  await esbuild.build({
    entryPoints: [join(root, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  })
  const module = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`)
  await import('node:fs/promises').then((fs) => fs.rm(outfile, { force: true }))
  return module
}

async function main() {
  const subject = await loadModule('src/discover/subject.ts')

  const calendarRaw = JSON.parse(await readFile(join(fixtures, 'bgm-calendar.json'), 'utf8'))
  const popularRaw = JSON.parse(await readFile(join(fixtures, 'bgm-popular.json'), 'utf8'))

  console.log('calendar: shape')
  {
    const days = subject.parseCalendar(calendarRaw)
    check('seven days are returned', days.length === 7, `${days.length}`)
    check(
      'the weekdays are numbered 1..7',
      days.every((day, index) => day.weekday === index + 1),
      days.map((d) => d.weekday).join(','),
    )
    const total = days.reduce((sum, day) => sum + day.subjects.length, 0)
    // The real capture holds 80 subjects; asserting a range rather than the exact
    // number keeps this useful when the fixture is refreshed for a new season.
    check('subjects are parsed out', total > 50, `${total} subjects`)
    check(
      'every day has at least one subject',
      days.every((day) => day.subjects.length > 0),
      days.map((d) => d.subjects.length).join(','),
    )
  }

  console.log('calendar: a subject carries the expected fields')
  {
    const days = subject.parseCalendar(calendarRaw)
    const sample = days.flatMap((day) => day.subjects)[0]
    check('it has an id', sample.id > 0, `${sample.id}`)
    check('it has a title', !!(sample.name || sample.nameCN), JSON.stringify(sample.name))
    check('it has a date in the calendar response', !!sample.date, `${sample.date}`)
    check(
      'the date is a YYYY-MM-DD prefix',
      /^\d{4}-\d{2}-\d{2}$/.test(sample.date ?? ''),
      `${sample.date}`,
    )
    check('it has a cover URL', !!sample.images.large, `${sample.images.large}`)
    check('it has a rating block', typeof sample.rating.score === 'number')
    check('it has tags', Array.isArray(sample.tags), `${sample.tags.length}`)
    // The Chinese title is what the app searches sources with; if the endpoint ever
    // stopped sending it, matching would silently get much worse.
    const withChinese = days
      .flatMap((day) => day.subjects)
      .filter((item) => item.nameCN).length
    check('most subjects have a Chinese title', withChinese > 50, `${withChinese} of 80`)
  }

  console.log('popular: shape')
  {
    const page = subject.parsePopular(popularRaw, 24)
    check('subjects are parsed out', page.subjects.length > 15, `${page.subjects.length}`)
    check('hasMore is a boolean', typeof page.hasMore === 'boolean', `${page.hasMore}`)
    const sample = page.subjects[0]
    check('an item has an id', sample.id > 0, `${sample.id}`)
    check('an item has a Chinese title', !!sample.nameCN, JSON.stringify(sample.nameCN))
    // This is the field that differs between the two endpoints: the popular response
    // has no `date`. Parsing it as null rather than dropping the item is the whole
    // reason this test exists.
    check(
      'a missing date becomes null, not a dropped item',
      sample.date === null,
      `${sample.date}`,
    )
  }

  console.log('parser: tolerance')
  {
    // These are the shapes that made the defensive parser necessary. Each one is a
    // real possibility from one of the two endpoints.
    check('an empty object yields no subject', subject.parseSubject({}) === null)
    check('a null yields no subject', subject.parseSubject(null) === null)
    check('a subject with no title is dropped', subject.parseSubject({ id: 5 }) === null)
    check(
      'a subject with only a Chinese title survives',
      subject.parseSubject({ id: 5, name_cn: '只有中文' })?.nameCN === '只有中文',
    )
    check(
      'a subject with only the original title survives',
      subject.parseSubject({ id: 5, name: 'only romaji' })?.name === 'only romaji',
    )
    // `rating.count` is an object on the calendar endpoint and an array on the
    // popular one. Neither shape is read, so both must parse without error.
    check(
      'an object-shaped rating count is tolerated',
      subject.parseSubject({ id: 5, name: 'x', rating: { score: 7, count: { 1: 2 } } })
        ?.rating.score === 7,
    )
    check(
      'an array-shaped rating count is tolerated',
      subject.parseSubject({ id: 5, name: 'x', rating: { score: 7, count: [2, 3] } })
        ?.rating.score === 7,
    )
    check(
      'a malformed images block becomes nulls',
      subject.parseSubject({ id: 5, name: 'x', images: 'nope' })?.images.large === null,
    )
    check(
      'an empty calendar still yields seven days',
      subject.parseCalendar({}).length === 7,
    )
    check('an empty popular page yields nothing', subject.parsePopular({}, 24).subjects.length === 0)
  }

  console.log('display helpers')
  {
    const withChinese = subject.parseSubject({ id: 1, name: 'romaji', nameCN: '中文名' })
    check('the Chinese title is preferred', subject.displayName(withChinese) === '中文名')
    const withoutChinese = subject.parseSubject({ id: 1, name: 'romaji' })
    check('the original title is the fallback', subject.displayName(withoutChinese) === 'romaji')
    check(
      'an unrated subject has no score label',
      subject.scoreLabel(subject.parseSubject({ id: 1, name: 'x' })) === null,
    )
    check(
      'a rated subject shows one decimal',
      subject.scoreLabel(subject.parseSubject({ id: 1, name: 'x', rating: { score: 7.72 } })) ===
        '7.7',
    )
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
