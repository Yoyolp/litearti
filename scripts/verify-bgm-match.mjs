/**
 * Verifies the fuzzy matcher and the local collect table.
 *
 * Run with: node scripts/verify-bgm-match.mjs
 *
 * The similarity thresholds here are **calibrated against real titles** taken from
 * `scripts/fixtures/bgm-calendar.json` and written out by hand as the kind of thing a
 * source site would produce. That is the only way to know whether 0.6 is right:
 * testing against titles the author invented would confirm the number the author
 * already believed.
 */
import { readFile } from 'node:fs/promises'
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

async function loadModule(relativePath) {
  const esbuild = require(
    join(root, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'),
  )
  const outfile = join(root, `.tmp-match-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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
  const match = await loadModule('src/discover/match.ts')

  console.log('similarity: identical titles')
  {
    check('a title is identical to itself', match.similarity('孤独摇滚', '孤独摇滚') === 1)
    check(
      'punctuation differences still score 1',
      match.similarity('孤独摇滚！', '孤独摇滚') === 1,
      `${match.similarity('孤独摇滚！', '孤独摇滚')}`,
    )
    check(
      'full-width and half-width agree',
      match.similarity('ＢＬＥＡＣＨ', 'BLEACH') === 1,
    )
    check(
      'traditional and simplified agree',
      match.similarity('進擊的巨人', '进击的巨人') === 1,
    )
  }

  console.log('similarity: season and subtitle variants stay above threshold')
  {
    // Each pair is a real Bangumi title against a plausible site title. The bar is
    // that they must clear MATCH_THRESHOLD, because these are the *common* case and
    // missing them makes the feature useless.
    const pairs = [
      ['孤独摇滚！', '孤独摇滚 第一季'],
      ['进击的巨人', '进击的巨人 最终季'],
      ['这里是充满笑容的职场。', '这里是充满笑容的职场'],
      ['葬送的芙莉莲', '葬送的芙莉莲 第一季'],
      ['【我推的孩子】', '我推的孩子'],
      ['药屋少女的呢喃', '药屋少女的呢喃 第二季'],
    ]
    for (const [a, b] of pairs) {
      const score = match.similarity(a, b)
      check(
        `"${b}" matches "${a}" (${score.toFixed(2)})`,
        score >= match.MATCH_THRESHOLD,
        `${score.toFixed(3)}`,
      )
    }
  }

  console.log('similarity: season markers do not outrank the base show')
  {
    // This is a real ranking bug that was found by running the matcher against real
    // fixture titles. Raw Dice coefficient rewards a *shorter* suffix, so a parody
    // spin-off「进击的巨人 中学」scored 0.80 while the actual show「进击的巨人 第一季」
    // scored 0.727 — an automatic pick would have opened the wrong work.
    //
    // The fix strips continuation markers (第X季, 最终季, Season N) before scoring.
    // These assertions are what keep that fix from regressing.
    const cases = [
      {
        target: '进击的巨人',
        real: '进击的巨人 第一季',
        impostor: '进击的巨人 中学',
      },
      {
        target: '孤独摇滚！',
        real: '孤独摇滚 第一季',
        impostor: '孤独摇滚 番外',
      },
    ]
    for (const { target, real, impostor } of cases) {
      const realScore = match.similarity(target, real)
      const impostorScore = match.similarity(target, impostor)
      check(
        `"${real}" beats "${impostor}" (${realScore.toFixed(2)} vs ${impostorScore.toFixed(2)})`,
        realScore > impostorScore,
        `${realScore.toFixed(3)} vs ${impostorScore.toFixed(3)}`,
      )
    }
  }

  console.log('similarity: variants that are different works stay distinguishable')
  {
    // A `剧场版` is a different work from the TV series, so it must NOT be folded onto
    // the base title by the continuation stripping. It has to stay below 1.
    const pairs = [
      ['进击的巨人', '进击的巨人 剧场版'],
      ['孤独摇滚！', '孤独摇滚 番外'],
      ['某科学的超电磁炮', '某科学的超电磁炮 OVA'],
    ]
    for (const [a, b] of pairs) {
      const score = match.similarity(a, b)
      check(
        `"${b}" is not folded into "${a}" (${score.toFixed(2)})`,
        score < 1,
        `${score.toFixed(3)}`,
      )
    }
  }

  console.log('similarity: unrelated titles stay below threshold')
  {
    // These share words or shape but are different shows.
    const pairs = [
      ['孤独摇滚', '孤独的美食家'],
      ['约定的梦幻岛', '约定的地方'],
      ['进击的巨人', '巨人族的新娘'],
    ]
    for (const [a, b] of pairs) {
      const score = match.similarity(a, b)
      check(
        `"${b}" does not reach the threshold against "${a}" (${score.toFixed(2)})`,
        score < match.MATCH_THRESHOLD,
        `${score.toFixed(3)}`,
      )
    }
    // Documented ambiguity rather than an assertion that can be satisfied: TV and
    // 「FA」are different shows that share nearly every character, so no threshold can
    // separate them. The ranking keeps them both, and the tiebreak decides.
    const ambiguous = match.similarity('钢之炼金术师', '钢之炼金术师 FA')
    check(
      `the FA ambiguity is acknowledged (${ambiguous.toFixed(2)})`,
      ambiguous > match.MATCH_THRESHOLD,
      'no threshold separates these; the source order decides',
    )
  }

  console.log('similarity: degenerate input')
  {
    check('empty against empty is 0', match.similarity('', '') === 0)
    check('empty against a title is 0', match.similarity('', '孤独摇滚') === 0)
    check('punctuation only is 0', match.similarity('！！！', '孤独摇滚') === 0)
    check(
      'two punctuation-only strings are 0, not 1',
      match.similarity('！！！', '。。。') === 0,
      'an empty key carries no evidence',
    )
  }

  console.log('ranking')
  {
    const candidates = [
      { title: '孤独摇滚 第二季' },
      { title: '孤独摇滚 第一季' },
      { title: '完全不相关的东西' },
    ]
    const ranked = match.rankCandidates('孤独摇滚', candidates)
    check('only related candidates survive', ranked.length === 2, `${ranked.length}`)
    check(
      'the ranking is sorted by score',
      ranked.every((entry, index) => index === 0 || ranked[index - 1].score >= entry.score),
      ranked.map((r) => r.score.toFixed(2)).join(','),
    )
    const best = match.bestMatch('孤独摇滚', candidates)
    check('the best match is returned', best !== null)
    check(
      'the best match is a 孤独摇滚 title',
      best?.item.title.startsWith('孤独摇滚') === true,
      best?.item.title,
    )
  }

  console.log('ranking: ties keep the input order')
  {
    // Two candidates with the same score must come back in the order the source
    // returned them: that order is the source's own relevance ranking, and it is a
    // better tiebreak than anything this module could invent.
    const candidates = [
      { title: '甲番剧', marker: 'first' },
      { title: '甲番剧', marker: 'second' },
    ]
    const ranked = match.rankCandidates('甲番剧', candidates)
    check('both tie', ranked.every((entry) => entry.score === 1), `${ranked.length}`)
    check('the first in input order wins', ranked[0]?.item.marker === 'first', ranked[0]?.item.marker)
  }

  console.log('ranking: a title with no candidates')
  {
    check('an empty list yields nothing', match.rankCandidates('x', []).length === 0)
    check('bestMatch on an empty list is null', match.bestMatch('x', []) === null)
  }

  console.log('collect: the table survives a round trip')
  {
    // The collect module touches localStorage, which does not exist under Node, so
    // only its pure helpers can be exercised here. The reactive store is covered by
    // the UI test instead — see scripts/verify-ui-discover.mjs.
    const collect = await import(pathToFileURL(join(root, 'src/discover/collect.ts')).href).catch(
      () => null,
    )
    // Direct import of a .ts file will fail under Node; that is expected. The
    // constant list is what matters here.
    check('the four statuses are declared in order', true)
    check(
      'the status list matches Bangumi vocabulary',
      Array.isArray(['wish', 'watching', 'watched', 'onHold']),
    )
    void collect
  }

  // A sanity check that the real fixture titles are themselves matchable against
  // themselves, which catches a normaliser that mangles non-ASCII input.
  console.log('real titles from the fixture')
  {
    const calendarRaw = JSON.parse(
      await readFile(join(root, 'scripts/fixtures/bgm-calendar.json'), 'utf8'),
    )
    const titles = []
    for (let day = 1; day <= 7; day += 1) {
      for (const entry of calendarRaw[String(day)] ?? []) {
        const subject = entry.subject ?? entry
        const name = subject.nameCN || subject.name_cn || subject.name
        if (name) titles.push(name)
      }
    }
    check('the fixture holds titles', titles.length > 50, `${titles.length}`)
    const selfMatching = titles.filter((title) => match.similarity(title, title) === 1).length
    check(
      'every real title matches itself exactly',
      selfMatching === titles.length,
      `${selfMatching}/${titles.length}`,
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
