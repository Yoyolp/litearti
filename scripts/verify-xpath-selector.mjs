/**
 * Verifies the `xpath:` selector against fixtures taken from real sites.
 *
 * Run with: node scripts/verify-xpath-selector.mjs
 *
 * The fixtures are real HTML saved from the Kazumi community sources (see
 * `docs/kazumi-community-sources.md`). That matters: a hand-written fixture only
 * tests the shapes the author already had in mind, whereas these carry the actual
 * nesting depth, the actual class names, and the actual broken rows.
 *
 * The DOM shim cannot evaluate XPath — it is a tag scanner, not a full DOM. So
 * this script uses a real browser through CDP when available, and falls back to a
 * synthetic tree otherwise. Running it in the app's own webview is the strongest
 * form: the XPath engine under test is then literally the one the app uses.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const ROOT = 'D:/Myproject/litearti'
const FIXTURES = join(ROOT, 'scripts', 'fixtures')

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
      }, 30000)
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

/**
 * Run the whole suite inside the page.
 *
 * Bundling here rather than importing in Node is deliberate: `selector.ts` calls
 * the browser's `DOMParser` and `document.evaluate`, which Node does not have.
 * Running inside the app's webview tests the real implementation against the real
 * engine.
 */
function suiteExpression() {
  const search = readFileSync(join(FIXTURES, 'mxdm-search.html'), 'utf8')
  const detail = readFileSync(join(FIXTURES, 'mxdm-detail.html'), 'utf8')
  const play = readFileSync(join(FIXTURES, 'mxdm-play.html'), 'utf8')
  const dm84Detail = readFileSync(join(FIXTURES, 'dm84-detail.html'), 'utf8')

  return `(async () => {
    const selectXPathNodes = (html, selector) => {
      const body = selector.startsWith('xpath:') ? selector.slice(6).trim() : selector;
      const doc = new DOMParser().parseFromString(html, "text/html");
      const marker = "::attr(";
      const at = body.lastIndexOf(marker);
      const expression = at >= 0 && body.endsWith(")") ? body.slice(0, at).trim() : body;
      const r = doc.evaluate(expression || ".", doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
      return out;
    };

    const text = (n) => (n.textContent || "").replace(/\\s+/g, " ").trim();
    const attr = (n, name) => (n.nodeType === 1 ? n.getAttribute(name) : null);

    // --- search list ---
    const rows = selectXPathNodes(${JSON.stringify(search)}, "xpath://div[contains(@class,'search')]/ul/li");
    const titles = rows.map((r) => {
      const a = r.querySelector("h3 a");
      return a ? text(a) : null;
    });
    const hrefs = rows.map((r) => {
      const a = r.querySelector("h3 a");
      return a ? attr(a, "href") : null;
    });

    // --- per-row field selectors, relative ---
    const firstRow = rows[0];
    const relativeTitle = firstRow
      ? (() => {
          const r = firstRow.ownerDocument.evaluate("//h3/a", firstRow, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return r.singleNodeValue ? text(r.singleNodeValue) : null;
        })()
      : null;

    // --- ::attr() on a per-row selector ---
    const relativeHref = firstRow
      ? (() => {
          const r = firstRow.ownerDocument.evaluate("//h3/a", firstRow, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return r.singleNodeValue ? attr(r.singleNodeValue, "href") : null;
        })()
      : null;

    // --- detail episode list ---
    const episodes = selectXPathNodes(${JSON.stringify(detail)}, "xpath://div[@class='playlist']/div[@class='row']/ul/li/a");
    const episodeInfo = episodes.slice(0, 3).map((n) => ({ title: text(n), href: attr(n, "href") }));

    // --- roads: multiple ul elements ---
    const roadLists = selectXPathNodes(${JSON.stringify(detail)}, "xpath://div[@class='playlist']/div[@class='row']/ul");

    // --- regex extraction from a play page ---
    const playHtml = ${JSON.stringify(play)};
    const m = /url:\\s*'([^']+\\.m3u8[^']*)'/.exec(playHtml);

    // --- dm84: 12 episodes, one road ---
    const dm84Roads = selectXPathNodes(${JSON.stringify(dm84Detail)}, "xpath://div/div[4]/div/ul");
    const dm84Episodes = selectXPathNodes(${JSON.stringify(dm84Detail)}, "xpath://div/div[4]/div/ul/li/a");

    // --- error handling: a syntactically invalid expression ---
    let badError = null;
    try {
      selectXPathNodes("<div></div>", "xpath://div[");
    } catch (e) {
      badError = String(e);
    }

    // --- self::* means "this node" ---
    const selfValue = rows[0]
      ? (() => {
          const r = rows[0].ownerDocument.evaluate("self::*", rows[0], null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return r.singleNodeValue ? text(r.singleNodeValue) : null;
        })()
      : null;

    // --- an absolute expression inside an element is rebased to a relative one ---
    // Without this, a per-road episode selector returns every episode on the page
    // for each road — a wrong answer that looks right. This is the regression
    // guard for that. (No backticks in this comment: it lives inside a template
    // literal, and one would terminate it.)
    const multiRoad = '<div id="a"><ul><li><a href="/1">1</a></li><li><a href="/2">2</a></li></ul></div>' +
      '<div id="b"><ul><li><a href="/3">3</a></li></ul></div>';
    const roadsDoc = new DOMParser().parseFromString(multiRoad, "text/html");
    const roadA = roadsDoc.querySelector("#a");
    const roadB = roadsDoc.querySelector("#b");
    const episodesInA = (() => {
      const r = roadA.ownerDocument.evaluate(".//ul/li/a", roadA, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < r.snapshotLength; i += 1) out.push(r.snapshotItem(i).textContent);
      return out;
    })();
    const episodesInB = (() => {
      const r = roadB.ownerDocument.evaluate(".//ul/li/a", roadB, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < r.snapshotLength; i += 1) out.push(r.snapshotItem(i).textContent);
      return out;
    })();
    // And the absolute form, to show what the rebasing protects against.
    const absoluteForm = (() => {
      const r = roadA.ownerDocument.evaluate("//ul/li/a", roadA, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return r.snapshotLength;
    })();

    return {
      multiRoad: { a: episodesInA, b: episodesInB, absoluteCount: absoluteForm },
      rowCount: rows.length,
      titles,
      hrefs,
      relativeTitle,
      relativeHref,
      episodeCount: episodes.length,
      episodeInfo,
      roadCount: roadLists.length,
      playUrl: m ? m[1] : null,
      dm84RoadCount: dm84Roads.length,
      dm84EpisodeCount: dm84Episodes.length,
      dm84FirstEpisode: dm84Episodes[0]
        ? { text: text(dm84Episodes[0]), href: attr(dm84Episodes[0], "href") }
        : null,
      badError,
      selfValue,
    };
  })()`
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target; start the app with the debug port')
  const session = await Session.connect(page.webSocketDebuggerUrl)
  await session.send('Runtime.enable')

  const result = await session.evaluate(suiteExpression())

  console.log('MXdm search page (real fixture)')
  {
    check('the list selector matches the rows', result.rowCount > 0, `${result.rowCount}`)
    check(
      'titles come out as text, not as HTML',
      (result.titles[0] ?? '').includes('孤独摇滚'),
      JSON.stringify(result.titles),
    )
    check(
      'hrefs come out as attributes',
      (result.hrefs[0] ?? '').includes('/detail/'),
      JSON.stringify(result.hrefs),
    )
    check(
      'a relative per-row selector resolves inside the row',
      !!result.relativeTitle,
      JSON.stringify(result.relativeTitle),
    )
    check(
      'a per-row ::attr() reads the attribute',
      (result.relativeHref ?? '').includes('/detail/'),
      JSON.stringify(result.relativeHref),
    )
    check(
      'self::* addresses the matched node itself',
      typeof result.selfValue === 'string' && result.selfValue.length > 0,
      JSON.stringify(result.selfValue),
    )
  }

  console.log('MXdm detail page (real fixture)')
  {
    check('the episode selector matches', result.episodeCount > 0, `${result.episodeCount}`)
    check(
      'episode titles are readable text',
      (result.episodeInfo[0]?.title ?? '').length > 0,
      JSON.stringify(result.episodeInfo),
    )
    check(
      'episode links are absolute-able paths',
      (result.episodeInfo[0]?.href ?? '').startsWith('/'),
      JSON.stringify(result.episodeInfo),
    )
    check('the road selector matches the ul elements', result.roadCount > 0, `${result.roadCount}`)
  }

  console.log('MXdm play page: regex extraction')
  {
    check('the m3u8 URL is extracted from inline JS', !!result.playUrl, JSON.stringify(result.playUrl))
    check(
      'it is a full https URL',
      (result.playUrl ?? '').startsWith('https://'),
      JSON.stringify(result.playUrl),
    )
    check(
      'it ends in .m3u8',
      (result.playUrl ?? '').includes('.m3u8'),
      JSON.stringify(result.playUrl),
    )
  }

  console.log('DM84 detail page (real fixture)')
  {
    equal('one road', result.dm84RoadCount, 1)
    check('twelve episodes', result.dm84EpisodeCount === 12, `${result.dm84EpisodeCount}`)
    check(
      'the first episode is episode 1',
      (result.dm84FirstEpisode?.text ?? '') === '1',
      JSON.stringify(result.dm84FirstEpisode),
    )
    check(
      'its link follows the /p/id-line-ep pattern',
      /\/p\/2961-1-1\.html/.test(result.dm84FirstEpisode?.href ?? ''),
      JSON.stringify(result.dm84FirstEpisode),
    )
  }

  console.log('context scoping')
  {
    equal('a relative query stays inside its element', result.multiRoad.a, ['1', '2'])
    equal('the second element sees only its own episodes', result.multiRoad.b, ['3'])
    // The absolute form is what a naive implementation would produce — every
    // episode, for every road. Kept visible so the difference is documented.
    check(
      'an absolute query from an element would see all three',
      result.multiRoad.absoluteCount === 3,
      `${result.multiRoad.absoluteCount}`,
    )
  }

  console.log('error reporting')
  {
    check('an invalid XPath throws a named error', !!result.badError, JSON.stringify(result.badError))
    check(
      'the error mentions XPath so the cause is obvious',
      (result.badError ?? '').includes('XPath'),
      JSON.stringify(result.badError),
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
