/**
 * Verifies the export converters against real inputs.
 *
 * Run with: node scripts/verify-export-convert.mjs
 *
 * Covers the three conversion paths and the registry's eligibility rules. The
 * EPUB case reuses the sample book from `make-sample-epub.mjs`, so the export
 * path is exercised against the same bytes the viewer reads.
 */
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

let workDir = null

/**
 * Bundle several modules through ONE entry point.
 *
 * Bundling `registry.ts` and `builtins.ts` separately would give each its own
 * copy of the registry array, so registrations made in one would be invisible
 * in the other. A single entry that re-exports everything preserves the shared
 * module instance, which is exactly what the app has at runtime.
 */
async function loadModules(relativePaths) {
  const esbuildEntry = join(
    root,
    'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js',
  )
  const esbuild = require(esbuildEntry)

  const entryFile = join(workDir, 'entry.ts')
  const lines = relativePaths.map(
    (p) => `export * from ${JSON.stringify(join(root, p).replace(/\\/g, '/'))}`,
  )
  await writeFile(entryFile, lines.join('\n'), 'utf8')

  const outfile = join(workDir, 'bundle.mjs')
  await esbuild.build({
    entryPoints: [entryFile],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent',
    alias: { '@': join(root, 'src') },
    // pdf.js must not be bundled: its worker is resolved relative to its own
    // module location, and bundling flattens that away. Leaving it external
    // lets Node resolve the real package, worker included.
    external: ['pdfjs-dist'],
  })
  return import(pathToFileURL(outfile).href)
}

/** Minimal DOM, enough for the EPUB text extraction to walk a document. */
function installDomShim() {
  class Node {
    constructor(name, attrs = {}) {
      this.nodeName = name
      this.localName = name.replace(/^.*:/, '')
      this.attributes = Object.entries(attrs).map(([n, v]) => ({ name: n, value: v }))
      this.children = []
      this.childNodes = []
      this.parent = null
      this._text = ''
      this.nodeType = name === '#text' ? 3 : 1
    }
    getAttribute(n) {
      return this.attributes.find((a) => a.name === n)?.value ?? null
    }
    setAttribute(n, v) {
      const found = this.attributes.find((a) => a.name === n)
      if (found) found.value = String(v)
      else this.attributes.push({ name: n, value: String(v) })
    }
    removeAttribute(n) {
      this.attributes = this.attributes.filter((a) => a.name !== n)
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parent = this
        this.children.push(node)
        this.childNodes.push(node)
      }
    }
    replaceChildren(...nodes) {
      this.children = []
      this.childNodes = []
      this.append(...nodes)
    }
    replaceWith(...nodes) {
      const parent = this.parent
      if (!parent) return
      const index = parent.children.indexOf(this)
      if (index < 0) return
      for (const node of nodes) node.parent = parent
      parent.children.splice(index, 1, ...nodes)
    }
    remove() {
      this.replaceWith()
    }
    get isConnected() {
      let node = this
      while (node.parent) node = node.parent
      return node.localName === '#document'
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('')
    }
    set textContent(v) {
      this.children = []
      this.childNodes = []
      this._text = String(v)
    }
    querySelectorAll(sel) {
      const all = [...walk(this)]
      if (!sel || sel === '*') return all
      // Only comma-separated tag lists are used by the converter.
      const tags = sel.split(',').map((s) => s.trim().toLowerCase())
      return all.filter((n) => tags.includes(n.localName))
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null
    }
  }

  class Document extends Node {
    constructor() {
      super('#document')
      this.head = new Node('head')
      this.body = new Node('body')
      this.documentElement = new Node('html')
      this.documentElement.append(this.head, this.body)
      this.append(this.documentElement)
    }
    createElement(name) {
      return new Node(name)
    }
  }

  globalThis.Node = Node
  globalThis.DOMParser = class {
    parseFromString(source) {
      const doc = new Document()
      const text = source
        .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
      const re = /<(\/?)([A-Za-z_][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
      let stack = [doc.body]
      let last = 0
      let m
      while ((m = re.exec(text)) !== null) {
        const between = text.slice(last, m.index)
        if (between) {
          const t = new Node('#text')
          t._text = between
          stack[stack.length - 1].append(t)
        }
        last = re.lastIndex
        const [, closing, rawName, attrText, selfClosing] = m
        const local = rawName.toLowerCase().replace(/^.*:/, '')
        if (closing) {
          for (let i = stack.length - 1; i > 0; i -= 1) {
            if (stack[i].localName === local) {
              stack.length = i
              break
            }
          }
          continue
        }
        if (local === 'html') continue
        if (local === 'head') {
          stack = [doc.head]
          continue
        }
        if (local === 'body') {
          stack = [doc.body]
          continue
        }
        const attrs = {}
        const ar = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
        let am
        while ((am = ar.exec(attrText)) !== null) attrs[am[1].replace(/^.*:/, '')] = am[2] ?? am[3] ?? ''
        const node = new Node(local, attrs)
        stack[stack.length - 1].append(node)
        if (!selfClosing && !['br', 'img', 'hr'].includes(local)) stack.push(node)
      }
      return doc
    }
  }
}

function* walk(node) {
  for (const child of node.children) {
    yield child
    yield* walk(child)
  }
}

/** Build a fake entry + input pair over in-memory bytes. */
function makeInput(entry, bytes, text) {
  return {
    entry,
    readBinary: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    readText: async () => ({
      text: text ?? new TextDecoder().decode(bytes),
      encoding: 'UTF-8',
      hadBom: false,
      lossy: false,
    }),
  }
}

async function main() {
  // The bundle lives inside the project so that `external` modules (pdf.js)
  // resolve against the project's own node_modules. A temp-dir bundle cannot
  // see them.
  workDir = await mkdtemp(join(root, 'node_modules/.tmp/verify-export-'))
  installDomShim()

  // pdf.js is left external to the bundle so it resolves its own worker.
  // Under Node the `legacy` build runs the worker in-process when no worker
  // file is configured, which is what a verification script needs. The
  // production path (webview + `/pdfjs/...`) is untouched.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = ''

  // One bundle, so `registry.ts` and `builtins.ts` share a single module
  // instance exactly as they do in the app.
  const mod = await loadModules([
    'src/export/naming.ts',
    'src/export/registry.ts',
    'src/export/builtins.ts',
  ])

  const naming = mod
  const registry = mod
  const builtins = mod

  builtins.registerBuiltinTargets()

  console.log('registry')
  {
    const targets = registry.allTargets()
    check('original registered', targets.some((t) => t.id === 'original'))
    check('text registered', targets.some((t) => t.id === 'text'))

    const txt = targets.find((t) => t.id === 'text')
    check('text supports txt', registry.targetSupports(txt, 'txt'))
    check('text supports pdf', registry.targetSupports(txt, 'pdf'))
    check('text supports epub', registry.targetSupports(txt, 'epub'))
    check('text rejects mp3', !registry.targetSupports(txt, 'mp3'), 'audio should not be text-able')
    check('text rejects m4a', !registry.targetSupports(txt, 'm4a'))

    const original = targets.find((t) => t.id === 'original')
    check('original supports everything', registry.targetSupports(original, 'mp3'))
    check('targetsFor(mp3) excludes text', !registry.targetsFor('mp3').some((t) => t.id === 'text'))
    check('canConvertToText(epub)', registry.canConvertToText('epub'))
    check('canConvertToText(mp3) false', !registry.canConvertToText('mp3'))
  }

  console.log('naming')
  {
    check('illegal chars replaced', naming.sanitizeStem('a:b*c?d') === 'a_b_c_d', naming.sanitizeStem('a:b*c?d'))
    check('path separators replaced', naming.sanitizeStem('a/b\\c') === 'a_b_c', naming.sanitizeStem('a/b\\c'))
    check('trailing dots stripped', naming.sanitizeStem('name...') === 'name', naming.sanitizeStem('name...'))
    check('chinese preserved', naming.sanitizeStem('安静地读') === '安静地读')
    check('empty falls back', naming.sanitizeStem('   ') === '未命名')
    check('reserved name prefixed', naming.sanitizeStem('CON') === '_CON', naming.sanitizeStem('CON'))
    check('whitespace collapsed', naming.sanitizeStem('a   b') === 'a b', naming.sanitizeStem('a   b'))

    check('output keeps source ext for original', naming.outputFileName('书', 'pdf', '') === '书.pdf')
    check('output uses target ext', naming.outputFileName('书', 'pdf', 'txt') === '书.txt')
    check('no extension', naming.outputFileName('readme', '', '') === 'readme')

    check('suffix on name with ext', naming.withSuffix('a.txt', 2) === 'a (2).txt')
    check('suffix on name without ext', naming.withSuffix('a', 3) === 'a (3)')
    check('first attempt unchanged', naming.withSuffix('a.txt', 1) === 'a.txt')
  }

  console.log('txt conversion')
  {
    const targets = registry.allTargets()
    const text = targets.find((t) => t.id === 'text')
    const body = '第一行\n第二行\n\n第三段'
    const bytes = new TextEncoder().encode(body)
    const entry = { id: '1', title: '测试', extension: 'txt' }
    const output = await text.convert(makeInput(entry, bytes, body))
    check('txt passes through unchanged', output === body, JSON.stringify(output))
  }

  console.log('txt with BOM')
  {
    const targets = registry.allTargets()
    const text = targets.find((t) => t.id === 'text')
    // The backend strips the BOM; the converter receives already-decoded text.
    const entry = { id: '1', title: 'bom', extension: 'txt' }
    const output = await text.convert(makeInput(entry, new Uint8Array([1]), '无 BOM 文本'))
    check('bom already stripped by reader', output === '无 BOM 文本', JSON.stringify(output))
  }

  console.log('epub conversion (sample.epub)')
  {
    const targets = registry.allTargets()
    const text = targets.find((t) => t.id === 'text')
    const epubBytes = new Uint8Array(await readFile(join(root, 'demo/sample.epub')))
    const entry = { id: '2', title: '安静地读', extension: 'epub' }
    const output = await text.convert(makeInput(entry, epubBytes))

    check('epub output is a string', typeof output === 'string')
    check('contains book title', output.includes('安静地读'), output.slice(0, 120))
    check('contains chapter 1 heading', output.includes('什么是安静'), output.slice(0, 300))
    check('contains body prose', output.includes('阅读这件事'), output.slice(0, 500))
    check('contains chapter 2', output.includes('格式的归属'))
    check('has markdown heading markers', /^#{1,3} /m.test(output), 'no heading marker')
    check('no html tags leaked', !/<p>|<div>/i.test(output), 'html leaked')
    check('no script content', !output.includes('alert('))
    console.log(`       length: ${output.length} chars`)
    console.log(`       head: ${output.split('\n').slice(0, 4).join(' | ')}`)
  }

  console.log('pdf conversion (real pdf)')
  {
    const targets = registry.allTargets()
    const text = targets.find((t) => t.id === 'text')
    // Use the PDF already in the library's test fixtures if present; otherwise
    // skip rather than fail, since no PDF ships with the repo.
    const pdfPath = join(root, 'demo', 'sample.pdf')
    let pdfBytes = null
    try {
      pdfBytes = new Uint8Array(await readFile(pdfPath))
    } catch {
      console.log('  skip  no demo/sample.pdf present')
    }

    if (pdfBytes) {
      const entry = { id: '3', title: 'sample', extension: 'pdf' }
      const output = await text.convert(makeInput(entry, pdfBytes))
      check('pdf output is a string', typeof output === 'string')
      check('pdf has page marker', output.includes('第 1 页'), output.slice(0, 200))
      check('pdf extracted some text', output.replace(/── 第 \d+ 页 ──/g, '').trim().length > 20)
    }
  }

  console.log('')
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })
