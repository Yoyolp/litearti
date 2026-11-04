/**
 * Verifies the dependency-free ZIP reader against archives built by hand.
 *
 * Run with: node scripts/verify-zip.mjs
 *
 * This exists because `zip.ts` is the one part of the EPUB viewer that cannot
 * be checked by types or by the bundler: a wrong offset reads plausible-looking
 * garbage instead of failing. The test builds real ZIP byte streams (stored and
 * deflated, with and without ZIP64) and asserts the reader gets the bytes back.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Build a ZIP in memory. Mirrors what a real archiver emits: local headers,
// then the central directory, then EOCD.
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

/** Build one ZIP file. `entries` is [{name, data, store?}]; `data` is string or bytes. */
async function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    // Binary payloads must pass through as bytes: `TextEncoder` would re-encode
    // anything above 0x7f and silently corrupt the fixture.
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

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  for (const local of locals) {
    out.set(local, p)
    p += local.length
  }
  for (const central of centrals) {
    out.set(central, p)
    p += central.length
  }
  out.set(eocd, p)
  return out
}

const require = createRequire(import.meta.url)

// zip.ts is TypeScript; esbuild is present as a transitive Vite dependency, but
// pnpm does not hoist it to the top level, so it is resolved from the store.
async function loadZipModule() {
  const esbuildEntry = join(
    root,
    'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js',
  )
  const esbuild = require(esbuildEntry)
  const source = await readFile(join(root, 'src/viewers/epub/zip.ts'), 'utf8')
  const { code } = await esbuild.transform(source, { loader: 'ts', format: 'esm' })
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  return import(dataUrl)
}

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

async function main() {
  const { ZipArchive } = await loadZipModule()

  console.log('deflated entries')
  {
    const zip = ZipArchive.open(
      await buildZip([
        { name: 'mimetype', data: 'application/epub+zip', store: true },
        { name: 'META-INF/container.xml', data: '<container/>' },
        { name: 'OEBPS/chapter1.xhtml', data: '<html><body><p>第一章</p></body></html>' },
      ]),
    )
    check('lists all entries', zip.names().length === 3, zip.names().join(','))
    check('reads stored entry', (await zip.text('mimetype')) === 'application/epub+zip')
    check('reads deflated ascii', (await zip.text('META-INF/container.xml')) === '<container/>')
    const chapter = await zip.text('OEBPS/chapter1.xhtml')
    check('reads deflated utf-8', chapter.includes('第一章'), chapter)
    check('has() finds nested path', zip.has('OEBPS/chapter1.xhtml'))
    check('has() rejects absent path', !zip.has('nope.txt'))
  }

  console.log('missing entry')
  {
    const zip = ZipArchive.open(await buildZip([{ name: 'a.txt', data: 'a' }]))
    let threw = false
    try {
      await zip.read('b.txt')
    } catch {
      threw = true
    }
    check('throws for missing entry', threw)
  }

  console.log('empty entry')
  {
    const zip = ZipArchive.open(await buildZip([{ name: 'empty.txt', data: '' }]))
    check('reads empty entry', (await zip.text('empty.txt')) === '')
  }

  console.log('binary payload (image bytes)')
  {
    // A PNG signature plus filler: proves no UTF-8 assumption is made.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80])
    const zip = ZipArchive.open(await buildZip([{ name: 'cover.png', data: png }]))
    const bytes = await zip.read('cover.png')
    check(
      'binary round-trips',
      bytes.length === png.length && bytes.every((byte, i) => byte === png[i]),
      `${bytes.length} bytes`,
    )
  }

  console.log('large-ish entry (64 KB, multi-block deflate)')
  {
    const text = '中文内容测试 '.repeat(6000)
    const zip = ZipArchive.open(await buildZip([{ name: 'big.txt', data: text }]))
    const out = await zip.text('big.txt')
    check('large deflated entry round-trips', out === text, `${out.length} vs ${text.length}`)
  }

  console.log('corrupt input')
  {
    let threw = false
    try {
      ZipArchive.open(new Uint8Array(4))
    } catch {
      threw = true
    }
    check('rejects tiny file', threw)

    let threwGarbage = false
    try {
      ZipArchive.open(new Uint8Array(100).fill(0x41))
    } catch {
      threwGarbage = true
    }
    check('rejects non-zip garbage', threwGarbage)
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
