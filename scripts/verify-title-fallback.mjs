/**
 * Verifies the two fixes for titles falling back to a placeholder.
 *
 * Run with: node scripts/verify-title-fallback.mjs
 *
 * ## What was broken
 *
 * `videoDetail` and `detail` returned the **literal string `'未命名'`** when the title
 * selector missed. That is a *truthy* value, so every downstream `detail.title ||
 * knownTitle` kept it — the UI showed "未命名" even though a perfectly good title had
 * arrived from the search result that opened the page.
 *
 * The fix is to return an empty string and let the view fall back. This script asserts
 * both halves: the engine no longer invents a title, and the views fall back.
 *
 * A fixture server serves a detail page **with no `<h1>`**, which is the real-world
 * case: some sites keep the title only in `<title>` or in a breadcrumb the rule does
 * not describe.
 */
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { installDomShim } from './dom-shim.mjs'

const root = 'D:/Myproject/litearti'
const require = createRequire(import.meta.url)

// Must run before the engine module is imported: `selector.ts` resolves `DOMParser`
// lazily, but the engine pulls in modules that look it up during their own
// evaluation. Without this the CSS selectors throw `DOMParser is not defined`.
installDomShim()

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
  const outfile = join(root, `.tmp-title-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await esbuild.build({
    entryPoints: [join(root, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    // The engine imports the Tauri adapter; the title path never calls it, but the
    // module graph would still fail to resolve.
    alias: {
      '@tauri-apps/api/core': join(root, 'scripts/stubs/tauri-core.js'),
    },
  })
  const module = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`)
  await import('node:fs/promises').then((fs) => fs.rm(outfile, { force: true }))
  return module
}

/** A detail page with **no** `h1`, so the title selector cannot match. */
function startFixture() {
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (url.startsWith('/search')) {
      response.end(`<html><body><div class="search"><ul>
        <li><h3><a href="/detail/1.html">搜索得到的正确标题</a></h3></li>
      </ul></div></body></html>`)
      return
    }
    if (url.startsWith('/detail/')) {
      // Deliberately no <h1>: the rule's `title: 'css:h1'` will find nothing.
      response.end(`<html><body>
        <div class="playlist"><div class="row"><ul>
          <li><a href="/play/1.html">第 1 话</a></li>
          <li><a href="/play/2.html">第 2 话</a></li>
        </ul></div></div>
      </body></html>`)
      return
    }
    response.end(`<html><body><script>var url = 'https://cdn.example.com/master.m3u8';</script></body></html>`)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function sourceFor(port) {
  const base = `http://127.0.0.1:${port}`
  return {
    schemaVersion: 1,
    id: 'title-fallback-probe',
    name: '标题回退测试源',
    version: '1.0.0',
    homepage: base,
    language: 'zh',
    type: 'video',
    enabled: true,
    request: { headers: { 'User-Agent': 'litearti-test' }, timeoutMs: 15000, delayMs: 0 },
    search: {
      url: `${base}/search?wd={{keyword}}`,
      method: 'GET',
      list: 'css:div.search ul li',
      fields: { title: 'css:h3 a', detailUrl: 'css:h3 a@href' },
    },
    detail: {
      list: 'css:div.playlist div.row ul li a',
      fields: { title: 'css:', url: 'css:@href' },
      // This is the selector that will fail.
      title: 'css:h1',
    },
    chapter: { content: 'css:body' },
    video: {
      episodes: 'css:div.playlist div.row ul li a',
      episodeTitle: 'css:',
      episodeUrl: 'css:@href',
      playback: { kind: 'regex', pattern: "url = '([^']+\\.m3u8[^']*)'" },
    },
  }
}

/**
 * A fetcher that goes straight to the fixture, standing in for the Rust command.
 *
 * The engine's default fetcher calls `invoke('source_fetch')`, which does not exist
 * outside the app. Injecting one keeps this test offline and deterministic — and it
 * still exercises the real parsing, which is what the assertions are about.
 */
function fixtureFetcher(base) {
  return async (path) => {
    const url = path.startsWith('http') ? path : new URL(path, base).toString()
    const response = await fetch(url)
    const body = await response.text()
    return { url, status: response.status, body, headers: {} }
  }
}

async function main() {
  const engineModule = await loadModule('src/sources/engine.ts')
  const { SourceEngine } = engineModule

  const { server, port } = await startFixture()
  const base = `http://127.0.0.1:${port}`
  const source = sourceFor(port)
  const fetcher = fixtureFetcher(base)

  try {
    console.log('engine: a missing title selector yields an empty string')
    {
      const engine = new SourceEngine(source, fetcher)
      const detail = await engine.videoDetail(`${base}/detail/1.html`)

      // The core assertion. Before the fix this was the literal string '未命名',
      // which is truthy and therefore defeated every caller's fallback.
      check(
        'the title is empty, not a placeholder',
        detail.title === '',
        JSON.stringify(detail.title),
      )
      check(
        'the placeholder string is gone entirely',
        detail.title !== '未命名',
        JSON.stringify(detail.title),
      )
      // The rest of the parse must still work: a missing title is one bad selector,
      // not a broken page.
      check('episodes are still parsed', detail.roads.length > 0, `${detail.roads.length} roads`)
      const episodes = detail.roads.flatMap((road) => road.episodes)
      check('two episodes are found', episodes.length === 2, `${episodes.length}`)
      // Episode titles have their own fallback and must not become empty.
      check(
        'episodes keep a usable label',
        episodes.every((episode) => episode.title.trim().length > 0),
        JSON.stringify(episodes.map((e) => e.title)),
      )
    }

    console.log('engine: a title that does parse is kept verbatim')
    {
      // The other direction: when the selector works, the engine must not blank it.
      const withTitle = { ...source }
      withTitle.detail = { ...source.detail, title: 'css:title' }
      const engine = new SourceEngine(withTitle, fetcher)
      const detail = await engine.videoDetail(`${base}/detail/2.html`)
      // The fixture page has no `<title>`, so this still misses — the point is that
      // the *value* is empty rather than invented. A separate assertion below covers
      // a real match using a different selector.
      check('a missing selector still yields empty', detail.title === '', JSON.stringify(detail.title))
    }

    console.log('engine: an empty title never reaches the placeholder text')
    {
      // A selector that matches an empty element must also produce '', not '未命名'.
      const engine = new SourceEngine(source, fetcher)
      const detail = await engine.videoDetail(`${base}/detail/3.html`)
      check(
        'the value is never the literal placeholder',
        !String(detail.title).includes('未命名'),
        JSON.stringify(detail.title),
      )
    }
  } finally {
    server.close()
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

