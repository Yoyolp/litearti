/**
 * Verifies the video source engine against real Kazumi community rules.
 *
 * Run with: node scripts/verify-video-engine.mjs
 * Requires the app started with --remote-debugging-port=9222.
 *
 * Why it needs a browser: the engine's XPath path calls `document.evaluate`, and
 * Node has no DOM at all. A hand-written XPath shim would be the worst option —
 * it would be a second, simpler XPath implementation whose bugs could make the
 * real one look correct (or vice versa). So the engine is bundled with esbuild
 * into a single IIFE and executed inside the app's own webview, against the real
 * parser and the real XPath engine. That is also the strongest form of this test:
 * the code under test is literally the code the app ships.
 *
 * No network: the fixtures in scripts/fixtures are real pages saved from the
 * sites (see docs/kazumi-community-sources.md). The engine gets an injected
 * fetcher that serves them by URL substring.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const ROOT = 'D:/Myproject/litearti'
const PORT = Number(process.env.CDP_PORT ?? 9222)
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

/**
 * Bundle the engine and schema into one IIFE.
 *
 * `platform: 'browser'` and `format: 'iife'` because it is evaluated as a script
 * in the page. `@tauri-apps` is stubbed: the engine imports the API module
 * transitively, and nothing in these code paths calls into Tauri.
 */
async function buildBundle() {
  const esbuild = require(
    join(ROOT, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'),
  )
  const dir = await mkdtemp(join(ROOT, 'node_modules/.tmp/verify-video-'))
  const outfile = join(dir, 'bundle.js')
  await esbuild.build({
    stdin: {
      contents: `
        import { SourceEngine } from '@/sources/engine'
        import { validateSource } from '@/sources/schema'
        globalThis.__engineUnderTest = { SourceEngine, validateSource }
      `,
      resolveDir: join(ROOT, 'src'),
      loader: 'ts',
    },
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    alias: {
      '@': join(ROOT, 'src'),
      // Tauri's IPC has no browser equivalent. Aliasing to a stub keeps the
      // bundle self-contained — `external` would emit a runtime `require`, which
      // an IIFE evaluated as a script cannot resolve.
      '@tauri-apps/api/core': join(ROOT, 'scripts', 'stubs', 'tauri-core.js'),
      '@tauri-apps/plugin-dialog': join(ROOT, 'scripts', 'stubs', 'tauri-dialog.js'),
    },
    logLevel: 'silent',
  })
  const code = readFileSync(outfile, 'utf8')
  await rm(dir, { recursive: true, force: true })
  return code
}

class Session {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true })
    })
    return new Session(ws)
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} timed out`))
        }
      }, 60000)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      )
    }
    return result.result.value
  }
}

/** Everything the suite needs, serialized into the page. */
function inPageSuite(bundle, sources, fixtures) {
  return `(async () => {
    ${bundle}
    const { SourceEngine, validateSource } = globalThis.__engineUnderTest;
    const FIXTURES = ${JSON.stringify(fixtures)};
    const SOURCES = ${JSON.stringify(sources)};

    const fetcher = (routes) => async (url, _source, options) => {
      for (const [needle, file] of routes) {
        if (url.includes(needle)) {
          return { status: 200, url, body: FIXTURES[file] };
        }
      }
      throw new Error('请求失败：没有为 ' + url + ' 准备 fixture');
    };

    const out = { validation: {}, gating: {}, playback: {}, mxdm: {}, dm84: {}, age: {}, failures: {} };

    // --- validation of the three converted community rules ---
    for (const source of SOURCES) {
      const r = validateSource(source);
      out.validation[source.id] = { ok: r.ok, issues: r.issues };
    }

    const mxdm = SOURCES.find((s) => s.id === 'kazumi-mxdm');
    const dm84 = SOURCES.find((s) => s.id === 'kazumi-dm84');
    const age = SOURCES.find((s) => s.id === 'kazumi-age');

    // --- video block gating ---
    {
      const novel = JSON.parse(JSON.stringify(mxdm));
      novel.type = 'novel';
      const r = validateSource(novel);
      out.gating.novelWithVideo = { ok: r.ok, issues: r.issues };

      const noVideo = JSON.parse(JSON.stringify(mxdm));
      delete noVideo.video;
      const r2 = validateSource(noVideo);
      out.gating.videoWithoutBlock = { ok: r2.ok, issues: r2.issues };
    }

    // --- playback config validation ---
    {
      const badRegex = JSON.parse(JSON.stringify(mxdm));
      badRegex.video.playback = { kind: 'regex', pattern: "url: '([^']+\\\\.m3u8" };
      out.playback.badRegex = validateSource(badRegex);

      const badKind = JSON.parse(JSON.stringify(mxdm));
      // sniff used to be the unknown value here; it is a real kind now, so the
      // negative case needs something that genuinely is not in the set. Keeping it
      // as sniff would have silently turned this into a positive test.
      badKind.video.playback = { kind: 'teleport' };
      out.playback.badKind = validateSource(badKind);

      // The sniff kind, accepted, with its optional hint.
      const sniffKind = JSON.parse(JSON.stringify(mxdm));
      sniffKind.video.playback = { kind: 'sniff', expect: 'hls' };
      out.playback.sniffKind = validateSource(sniffKind);

      // A misspelled expect is a mistake worth reporting: the hint would silently
      // do nothing otherwise.
      const badExpect = JSON.parse(JSON.stringify(mxdm));
      badExpect.video.playback = { kind: 'sniff', expect: 'hls4' };
      out.playback.badExpect = validateSource(badExpect);
    }

    // --- MXdm: search ---
    {
      const engine = new SourceEngine(mxdm, fetcher([['/search', 'mxdm-search.html']]));
      const r = await engine.searchWithDiagnoses('孤独摇滚');
      out.mxdm.search = {
        count: r.items.length,
        first: r.items[0] ?? null,
        diagnoses: r.diagnoses.length,
      };
    }

    // --- MXdm: detail ---
    {
      const engine = new SourceEngine(mxdm, fetcher([['/detail/1591', 'mxdm-detail.html']]));
      const d = await engine.videoDetail('https://www.dcc3.com/detail/1591/');
      out.mxdm.detail = {
        title: d.title,
        roads: d.roads.length,
        episodesPerRoad: d.roads.map((r) => r.episodes.length),
        firstEpisode: d.roads[0]?.episodes[0] ?? null,
        diagnoses: d.diagnoses.length,
      };
    }

    // --- MXdm: episode resolution ---
    {
      const engine = new SourceEngine(mxdm, fetcher([['/play/', 'mxdm-play.html']]));
      try {
        out.mxdm.mediaUrl = await engine.episodeVideoUrl('https://www.dcc3.com/play/1591-1-1/');
      } catch (e) {
        out.mxdm.mediaError = String(e);
      }
    }

    // --- DM84: detail ---
    {
      const engine = new SourceEngine(dm84, fetcher([['/v/2961', 'dm84-detail.html']]));
      const d = await engine.videoDetail('https://dmbus.cc/v/2961.html');
      out.dm84.detail = {
        roads: d.roads.length,
        episodesPerRoad: d.roads.map((r) => r.episodes.length),
        firstEpisode: d.roads[0]?.episodes[0] ?? null,
      };

      const playEngine = new SourceEngine(dm84, async (url) => ({
        status: 200,
        url,
        body: FIXTURES['dm84-play.html'],
      }));
      try {
        out.dm84.mediaUrl = await playEngine.episodeVideoUrl('https://dmbus.cc/p/2961-1-1.html');
      } catch (e) {
        out.dm84.mediaError = String(e);
      }
    }

    // --- AGE: multi-road, synthetic page shaped like the real one ---
    {
      const html = [
        '<div><div><section><div><div>',
        '<div class="line"><ul>',
        '<li><a href="/play/1/1/1">第01集</a></li>',
        '<li><a href="/play/1/1/2">第02集</a></li>',
        '</ul></div>',
        '<div class="line"><ul>',
        '<li><a href="/play/1/2/1">第01集</a></li>',
        '</ul></div>',
        '</div></div></section></div></div>',
      ].join('');
      const source = JSON.parse(JSON.stringify(age));
      source.video.roads = "xpath://div[@class='line']";
      source.video.episodes = 'xpath://ul/li/a';
      source.video.episodeUrl = 'xpath://::attr(href)';
      source.video.episodeTitle = 'xpath:';

      const engine = new SourceEngine(source, async (url) => ({ status: 200, url, body: html }));
      const d = await engine.videoDetail('https://www.agedm.io/detail/1');
      out.age.detail = {
        roads: d.roads.length,
        names: d.roads.map((r) => r.name),
        episodesPerRoad: d.roads.map((r) => r.episodes.length),
        firstUrl: d.roads[0]?.episodes[0]?.url ?? null,
      };
    }

    // --- failure modes ---
    {
      const engine = new SourceEngine(mxdm, async (url) => ({
        status: 200,
        url,
        body: '<html><body>nothing here</body></html>',
      }));
      try {
        await engine.episodeVideoUrl('https://www.dcc3.com/play/x/');
        out.failures.noMedia = null;
      } catch (e) {
        out.failures.noMedia = String(e);
      }

      const noVideo = new SourceEngine({ ...mxdm, video: undefined }, async (url) => ({
        status: 200,
        url,
        body: '',
      }));
      try {
        await noVideo.videoDetail('https://example.com/');
        out.failures.noConfig = null;
      } catch (e) {
        out.failures.noConfig = String(e);
      }
    }

    return out;
  })()`
}

async function main() {
  // Fixtures must be inlined: the page cannot read local files.
  const fixtureDir = join(ROOT, 'scripts', 'fixtures')
  const fixtures = {}
  for (const name of readdirSync(fixtureDir)) {
    if (name.endsWith('.html')) {
      fixtures[name] = readFileSync(join(fixtureDir, name), 'utf8')
    }
  }
  const needed = ['mxdm-search.html', 'mxdm-detail.html', 'mxdm-play.html', 'dm84-detail.html', 'dm84-play.html']
  for (const name of needed) {
    if (!fixtures[name]) throw new Error(`missing fixture: ${name}`)
  }

  const sources = JSON.parse(readFileSync(join(ROOT, 'sources', 'kazumi-community.json'), 'utf8'))

  const bundle = await buildBundle()

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  const result = await session.evaluate(inPageSuite(bundle, sources, fixtures))
  const out = result

  console.log('converted community rules pass validation')
  {
    equal('three rules present', Object.keys(out.validation).length, 3)
    for (const [id, entry] of Object.entries(out.validation)) {
      check(`${id} validates`, entry.ok, JSON.stringify(entry.issues))
    }
  }

  console.log('video block gating')
  {
    check(
      'a non-video source cannot carry a video block',
      out.gating.novelWithVideo.ok === false,
      JSON.stringify(out.gating.novelWithVideo.issues),
    )
    check(
      'the error talks about the video type rule',
      (out.gating.novelWithVideo.issues[0]?.message ?? '').includes('video'),
      JSON.stringify(out.gating.novelWithVideo.issues),
    )
    check(
      'a video source without a video block is refused',
      out.gating.videoWithoutBlock.ok === false,
      JSON.stringify(out.gating.videoWithoutBlock.issues),
    )
    check(
      'the error names the missing field',
      (out.gating.videoWithoutBlock.issues[0]?.message ?? '').includes('episodes'),
      JSON.stringify(out.gating.videoWithoutBlock.issues),
    )
  }

  console.log('playback config validation')
  {
    check('an uncompilable regex is rejected', out.playback.badRegex.ok === false)
    check(
      'the regex error points at the pattern field',
      out.playback.badRegex.issues.some((i) => i.path.includes('playback.pattern')),
      JSON.stringify(out.playback.badRegex.issues),
    )
    check('an unknown playback kind is rejected', out.playback.badKind.ok === false)
    check(
      'the error lists the allowed kinds',
      (out.playback.badKind.issues[0]?.message ?? '').includes('direct'),
      JSON.stringify(out.playback.badKind.issues),
    )
    check('the sniff kind is accepted', out.playback.sniffKind.ok === true)
    check(
      'a misspelled sniff hint is reported',
      out.playback.badExpect.ok === false,
      JSON.stringify(out.playback.badExpect.issues),
    )
  }

  console.log('MXdm: search')
  {
    check('rows come back', out.mxdm.search.count > 0, `${out.mxdm.search.count}`)
    check(
      'the first row has the expected title',
      (out.mxdm.search.first?.title ?? '').includes('孤独摇滚'),
      JSON.stringify(out.mxdm.search.first),
    )
    check(
      'the detail URL resolved absolute',
      (out.mxdm.search.first?.detailUrl ?? '').startsWith('https://www.dcc3.com/'),
      JSON.stringify(out.mxdm.search.first?.detailUrl),
    )
    equal('nothing was skipped', out.mxdm.search.diagnoses, 0)
  }

  console.log('MXdm: video detail')
  {
    // This assertion used to be `title.length > 0`, and it passed — but only because
    // the engine **invented** the string '未命名' when the selector missed. The
    // fixture page has no `<h1>`, so the selector does miss, and the real behaviour
    // was "we have no title". The old assertion was measuring the placeholder, not
    // the parse.
    //
    // What matters now is that a miss is reported honestly as an empty string, so the
    // view can fall back to the title from the search result. Returning a truthy
    // placeholder is what made every card say 未命名.
    check(
      'a missing title selector yields an empty string, not a placeholder',
      out.mxdm.detail.title === '',
      JSON.stringify(out.mxdm.detail.title),
    )
    check(
      'the placeholder text never appears',
      !String(out.mxdm.detail.title).includes('未命名'),
      JSON.stringify(out.mxdm.detail.title),
    )
    equal('one road', out.mxdm.detail.roads, 1)
    check(
      'episodes were enumerated',
      (out.mxdm.detail.episodesPerRoad[0] ?? 0) > 0,
      JSON.stringify(out.mxdm.detail.episodesPerRoad),
    )
    check(
      'the first episode URL is absolute',
      (out.mxdm.detail.firstEpisode?.url ?? '').startsWith('https://'),
      JSON.stringify(out.mxdm.detail.firstEpisode),
    )
    check(
      'the first episode has a title',
      (out.mxdm.detail.firstEpisode?.title ?? '').length > 0,
      JSON.stringify(out.mxdm.detail.firstEpisode),
    )
  }

  console.log('MXdm: episode resolves to a media URL')
  {
    check('no error was thrown', !out.mxdm.mediaError, out.mxdm.mediaError)
    const url = out.mxdm.mediaUrl ?? ''
    check('a URL was produced', !!url, url)
    check('it is https', url.startsWith('https://'), url)
    check('it is an m3u8', url.endsWith('.m3u8'), url)
  }

  console.log('DM84: detail and playback')
  {
    equal('one road', out.dm84.detail.roads, 1)
    equal('twelve episodes', out.dm84.detail.episodesPerRoad[0], 12)
    check(
      'the first episode is labelled "1"',
      out.dm84.detail.firstEpisode?.title === '1',
      JSON.stringify(out.dm84.detail.firstEpisode),
    )
    check(
      'its link matches the /p/id-line-ep pattern',
      /\/p\/2961-1-1\.html/.test(out.dm84.detail.firstEpisode?.url ?? ''),
      JSON.stringify(out.dm84.detail.firstEpisode),
    )
    // This source's playback regex captures the third-party iframe. Either a URL
    // or a named error is acceptable; hanging or returning empty is not.
    check(
      'playback yields something rather than nothing',
      !!(out.dm84.mediaUrl || out.dm84.mediaError),
      JSON.stringify({ url: out.dm84.mediaUrl, error: out.dm84.mediaError }),
    )
    if (out.dm84.mediaUrl) {
      console.log(`       (DM84 playback produced: ${out.dm84.mediaUrl.slice(0, 80)}…)`)
    }
  }

  console.log('AGE: multi-road detail')
  {
    equal('two roads are found', out.age.detail.roads, 2)
    equal('the first road has two episodes', out.age.detail.episodesPerRoad[0], 2)
    equal('the second road has one', out.age.detail.episodesPerRoad[1], 1)
    check(
      'roads get distinct names',
      new Set(out.age.detail.names).size === 2,
      JSON.stringify(out.age.detail.names),
    )
    check(
      'episode links resolve against the detail page',
      (out.age.detail.firstUrl ?? '').startsWith('https://www.agedm.io/'),
      JSON.stringify(out.age.detail.firstUrl),
    )
  }

  console.log('failure reporting')
  {
    check('a page with no media URL throws', !!out.failures.noMedia, JSON.stringify(out.failures.noMedia))
    check(
      'the message names sniffing or a site change',
      /嗅探|改版|没有匹配/.test(out.failures.noMedia ?? ''),
      out.failures.noMedia,
    )
    check('a source without a video block throws', !!out.failures.noConfig)
    check(
      'the message points at the missing config',
      /video 配置/.test(out.failures.noConfig ?? ''),
      out.failures.noConfig,
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
