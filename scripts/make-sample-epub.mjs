/**
 * Generates a small but realistic EPUB 3 file for manual testing.
 *
 * Run with: node scripts/make-sample-epub.mjs [outputPath]
 *
 * The book has what actually exercises the viewer: a nested TOC, a stylesheet
 * with an image reference, an embedded illustration, a footnote-style internal
 * link, a table, and Chinese text in both UTF-8 and a second chapter.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outPath = process.argv[2] ?? join(root, 'demo', 'sample.epub')

function crc32(bytes) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let c = i
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c
    }
  }
  let crc = -1
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  return (crc ^ -1) >>> 0
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data
    const stored = entry.store === true
    const payload = stored ? data : await deflateRaw(data)
    const nameBytes = new TextEncoder().encode(entry.name)
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length + payload.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, stored ? 0 : 8, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, payload.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(payload, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, stored ? 0 : 8, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, payload.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)
    offset += local.length
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const out = new Uint8Array(offset + centralSize + eocd.length)
  let p = 0
  for (const local of locals) { out.set(local, p); p += local.length }
  for (const central of centrals) { out.set(central, p); p += central.length }
  out.set(eocd, p)
  return out
}

/** A 1×1 dark grey PNG, used as the illustration placeholder. */
const PLACEHOLDER_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAJUlEQVR42u3OMQEAAAgDoJnc6BpjDyQgdWXm5wEECBAgQIAAAQIECBAg4G0XfAAh1pqvqQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

const CSS = `
@charset "utf-8";

body {
  font-family: "Songti SC", "SimSun", serif;
  line-height: 1.85;
  color: #2b2b2b;
  margin: 0 1.2em;
}

h1 {
  font-size: 1.6em;
  font-weight: 600;
  margin: 1.2em 0 0.6em;
  letter-spacing: 0.02em;
}

h2 {
  font-size: 1.25em;
  font-weight: 600;
  margin: 1.6em 0 0.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid #ddd;
}

p {
  text-indent: 2em;
  margin: 0 0 0.9em;
}

p.noindent { text-indent: 0; }

blockquote {
  margin: 1.2em 0;
  padding: 0.6em 1em;
  border-left: 3px solid #bbb;
  background: #f6f6f6;
  color: #555;
  font-style: italic;
}

figure { margin: 1.4em 0; text-align: center; }
figure img { max-width: 100%; }
figcaption { font-size: 0.85em; color: #888; margin-top: 0.4em; }

table {
  border-collapse: collapse;
  width: 100%;
  margin: 1.2em 0;
  font-size: 0.9em;
}
th, td { border: 1px solid #ddd; padding: 0.4em 0.6em; text-align: left; }
th { background: #f2f2f2; font-weight: 600; }

.footnote {
  font-size: 0.85em;
  color: #666;
  border-top: 1px solid #ddd;
  margin-top: 2em;
  padding-top: 0.8em;
}
`.trim()

const CHAPTER1 = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head>
  <title>第一章 什么是安静</title>
  <link rel="stylesheet" type="text/css" href="../styles/book.css"/>
</head>
<body>
  <h1>第一章　什么是安静</h1>

  <p class="noindent">阅读这件事，本来不需要被安排。你打开一个文件，往下看，看到一半关掉，下次打开还在原处——仅此而已。</p>

  <p>但大多数阅读软件并不这样想。它们会推荐、会同步、会统计你读了几分钟、会提醒你连续阅读的天数。这些功能本身没有错，只是它们都指向同一个假设：你读书需要一个系统来管理。</p>

  <blockquote>
    <p class="noindent">一个工具应该在你不需要它的时候消失。</p>
  </blockquote>

  <h2>一、三个动作</h2>

  <p>一个够用的阅读器只需要做三件事：把文件收进一个地方、用合适的方式渲染、记住你读到哪儿。其余都是加法，而加法有代价。</p>

  <figure>
    <img src="../images/illustration.png" alt="示意图"/>
    <figcaption>图 1-1　导入、渲染、记住位置</figcaption>
  </figure>

  <h2>二、代价</h2>

  <p>这个项目选择把文件<strong>复制</strong>进应用目录，而不是记住原路径。代价是占双份空间，收益是源文件移动、重命名、删除都不影响资料库<sup><a href="#fn1" id="ref1">[1]</a></sup>。</p>

  <table>
    <thead>
      <tr><th>方案</th><th>磁盘</th><th>条目可靠性</th></tr>
    </thead>
    <tbody>
      <tr><td>复制</td><td>双份</td><td>高</td></tr>
      <tr><td>引用</td><td>单份</td><td>低</td></tr>
    </tbody>
  </table>

  <div class="footnote">
    <p class="noindent" id="fn1"><a href="#ref1">[1]</a> 这是「库」这个心智模型的必要条件：如果条目会莫名失效，用户就不敢依赖它。</p>
  </div>
</body>
</html>`

const CHAPTER2 = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head>
  <title>第二章 格式的归属</title>
  <link rel="stylesheet" type="text/css" href="../styles/book.css"/>
</head>
<body>
  <h1>第二章　格式的归属</h1>

  <p class="noindent">后端只知道一个字符串：扩展名。它不知道什么是 PDF，也不维护任何格式表。</p>

  <p>哪个扩展名归哪个查看器，完全由前端的注册表决定。这条设计带来三个直接好处：加格式不改外壳、安卓移植不用动 Rust、用户可以覆盖内置行为。</p>

  <h2>一、注册一个描述符</h2>

  <p>加一种格式，只需要调用一次 <code>registerViewer()</code>，然后把组件放进 <code>defineAsyncComponent</code> 里，让它按需加载。</p>

  <pre><code>registerViewer({
  id: 'my-format',
  label: '我的格式',
  extensions: ['myf'],
  component: defineAsyncComponent(() => import('./MyViewer.vue')),
})</code></pre>

  <h2>二、查看器能做什么</h2>

  <p>它只拿到两个 prop：条目元数据和能力接口。拿不到文件系统，拿不到 Tauri，拿不到库。这个边界是刻意的，因为它是将来做插件隔离的前提。</p>

  <p>回到<a href="ch1.xhtml#fn1">第一章的注脚</a>，那里说明了为什么可靠性值得付出磁盘代价。</p>
</body>
</html>`

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="text/ch1.xhtml">第一章　什么是安静</a>
        <ol>
          <li><a href="text/ch1.xhtml#sec1-1">一、三个动作</a></li>
          <li><a href="text/ch1.xhtml#sec1-2">二、代价</a></li>
        </ol>
      </li>
      <li><a href="text/ch2.xhtml">第二章　格式的归属</a>
        <ol>
          <li><a href="text/ch2.xhtml#sec2-1">一、注册一个描述符</a></li>
          <li><a href="text/ch2.xhtml#sec2-2">二、查看器能做什么</a></li>
        </ol>
      </li>
    </ol>
  </nav>
</body>
</html>`

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:6f1c2a90-0000-4000-8000-000000000001</dc:identifier>
    <dc:title>安静地读：一个阅读器的设计笔记</dc:title>
    <dc:creator>litearti</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:description>用于测试 EPUB 查看器的示例文档。</dc:description>
    <meta property="dcterms:modified">2026-10-29T00:00:00Z</meta>
    <meta property="rendition:layout">reflowable</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="images/illustration.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

async function main() {
  // `mimetype` must be the first entry and stored uncompressed: that is what
  // makes a ZIP recognisable as an EPUB by other readers.
  const bytes = await buildZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/nav.xhtml', data: NAV },
    { name: 'OEBPS/styles/book.css', data: CSS },
    { name: 'OEBPS/text/ch1.xhtml', data: CHAPTER1 },
    { name: 'OEBPS/text/ch2.xhtml', data: CHAPTER2 },
    { name: 'OEBPS/images/illustration.png', data: PLACEHOLDER_PNG },
  ])

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, bytes)
  console.log(`wrote ${outPath} (${(bytes.length / 1024).toFixed(1)} KB)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
