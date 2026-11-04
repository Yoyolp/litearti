/**
 * Verifies TXT chapter detection.
 *
 * Run with: node scripts/verify-txt-chapters.mjs
 *
 * The interesting cases are the near-misses. A detector that fires on
 * `第一节课` or `第二天，他走了` splits a novel mid-sentence, which is worse than
 * not splitting at all — so roughly half of these checks are about *not*
 * matching.
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

async function loadModule(relativePath) {
  const esbuild = require(
    join(root, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'),
  )
  const dir = await mkdtemp(join(root, 'node_modules/.tmp/verify-txt-'))
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    entryPoints: [join(root, relativePath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent',
  })
  const module_ = await import(pathToFileURL(outfile).href)
  await rm(dir, { recursive: true, force: true })
  return module_
}

async function main() {
  const { isChapterHeading, splitChapters, chapterBody, chapterAtRatio } = await loadModule(
    'src/viewers/txt/chapters.ts',
  )

  console.log('headings that must match')
  {
    const yes = [
      '第一章 少年',
      '第一章　少年',
      '第1章 开始',
      '第 12 章',
      '第一百二十三回 大结局',
      '第二节 缘起',
      '第三卷 风起云涌',
      '第十集',
      '第２章 全角数字',
      'Chapter 1',
      'chapter 12 The End',
      '第5章：标题',
      '第5章、标题',
      '第5章.标题',
    ]
    for (const line of yes) {
      check(`matches: ${line}`, isChapterHeading(line) === true, line)
    }
  }

  console.log('headings that must NOT match (prose starting with 第)')
  {
    const no = [
      '第一节课上，老师讲了很多。',
      '第二天，他走了。',
      '第三章讲的是这个道理。',
      '第一时间赶到现场',
      '第十个人',
      // Too long to be a title.
      '第一章 这是一个非常非常长的标题用来测试长度限制是否真的生效了不应该被当成章节标题',
      // Ends with sentence punctuation.
      '第一章 少年。',
      '第一章 少年！',
      // Not a heading at all.
      '他走进了房间',
      '',
      '   ',
      '第',
      '第一章',
    ]
    for (const line of no) {
      // `第一章` alone *is* a valid heading (no title text) — exclude it.
      if (line === '第一章') continue
      check(`rejects: ${JSON.stringify(line)}`, isChapterHeading(line) === false, line)
    }
    check('bare 第一章 is a heading', isChapterHeading('第一章') === true)
  }

  console.log('splitting a chaptered file')
  {
    const text = [
      '书名：测试之书',
      '作者：某人',
      '',
      '第一章 开始',
      '第一段正文。',
      '第二段正文。',
      '',
      '第二章 继续',
      '第二章的正文。',
      '',
      '第三章 结束',
      '最后一段。',
    ].join('\n')

    const chapters = splitChapters(text)
    check('found three chapters', chapters.length === 3, `${chapters.length}`)
    check('titles are the heading lines', chapters[0].title === '第一章 开始', chapters[0].title)
    check('second chapter title', chapters[1].title === '第二章 继续')
    check('third chapter title', chapters[2].title === '第三章 结束')

    const lines = text.split('\n')
    const body = chapterBody(lines, chapters[0])
    check('body excludes the heading', !body.includes('第一章 开始'), JSON.stringify(body))
    check('body has the prose', body.includes('第一段正文。'), JSON.stringify(body))
    check('body stops at the next chapter', !body.includes('第二章的正文。'), JSON.stringify(body))
  }

  console.log('front matter')
  {
    const withPreface = [
      '这是一段很长的前言，介绍了这本书的来历和写作背景，足够长到值得保留。',
      '第一章 开始',
      '正文。',
      '第二章 继续',
      '正文。',
      '第三章 结束',
      '正文。',
    ].join('\n')
    const chapters = splitChapters(withPreface)
    check('preface kept as a chapter', chapters[0].title === '前言', chapters[0]?.title)
    check('chapters follow the preface', chapters.length === 4, `${chapters.length}`)

    // A short header (title/author lines) is not worth a chapter of its own.
    const shortHeader = ['测试之书', '第一章 开始', '正文。', '第二章 继续', '正文。', '第三章 结束', '正文。'].join('\n')
    const noPreface = splitChapters(shortHeader)
    check('short header is not a chapter', noPreface[0].title === '第一章 开始', noPreface[0]?.title)
  }

  console.log('files that are not chaptered')
  {
    const prose = [
      '这是一篇没有章节的散文。',
      '它有很多段落，但没有章节标题。',
      '第三段继续。',
      '第四段继续。',
    ].join('\n')
    check('plain prose yields no chapters', splitChapters(prose).length === 0)

    // Two matches are coincidence, not structure.
    const twoOnly = ['第一章 甲', '正文。', '第二章 乙', '正文。'].join('\n')
    check('two headings is below the threshold', splitChapters(twoOnly).length === 0)

    check('empty text yields nothing', splitChapters('').length === 0)
    check('whitespace yields nothing', splitChapters('   \n\n  ').length === 0)
  }

  console.log('progress migration from a whole-file ratio')
  {
    const chapters = [
      { title: 'a', start: 0, end: 10 },
      { title: 'b', start: 10, end: 20 },
      { title: 'c', start: 20, end: 30 },
    ]
    check('ratio 0 maps to the first chapter', chapterAtRatio(chapters, 30, 0) === 0)
    check('ratio in the middle maps to the second', chapterAtRatio(chapters, 30, 0.4) === 1)
    check('ratio near the end maps to the last', chapterAtRatio(chapters, 30, 0.95) === 2)
    check('ratio 1 clamps to the last chapter', chapterAtRatio(chapters, 30, 1) === 2)
    check('no chapters returns 0', chapterAtRatio([], 30, 0.5) === 0)
  }

  console.log('CRLF input')
  {
    const text = '第一章 甲\r\n正文一\r\n第二章 乙\r\n正文二\r\n第三章 丙\r\n正文三\r\n'
    const chapters = splitChapters(text)
    check('handles CRLF line endings', chapters.length === 3, `${chapters.length}`)
    check('titles have no stray CR', chapters[0].title === '第一章 甲', JSON.stringify(chapters[0].title))
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
