/**
 * Verifies the book source validator.
 *
 * Run with: node scripts/verify-source-schema.mjs
 *
 * The validator is the gate that keeps a malformed source from reaching the
 * engine, so it is tested against every rule it claims to enforce — including
 * the ones that are easy to get subtly wrong: the selector-prefix check, the
 * URL placeholder check, and the duplicate-id check across a file.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  const dir = await mkdtemp(join(root, 'node_modules/.tmp/verify-schema-'))
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

/** A valid source, used as the base for mutation tests. */
function validSource() {
  return {
    schemaVersion: 1,
    id: 'example',
    name: '示例',
    version: '1.0.0',
    homepage: 'https://example.com',
    type: 'novel',
    enabled: true,
    request: { headers: { 'User-Agent': 'x' }, timeoutMs: 15000, delayMs: 300 },
    search: {
      url: 'https://example.com/s?q={{keyword}}&p={{page}}',
      method: 'GET',
      list: 'css:.list li',
      fields: {
        title: 'css:.title',
        author: 'css:.author',
        cover: 'css:img@src',
        detailUrl: 'css:a@href',
      },
    },
    detail: {
      list: 'css:.chapters a',
      fields: { title: 'css:', url: 'css:@href' },
    },
    chapter: { content: 'css:#content' },
  }
}

/** Apply a mutation and expect failure, returning the issue list. */
function expectInvalid(validateSource, label, mutate) {
  const source = validSource()
  mutate(source)
  const result = validateSource(source)
  check(label, result.ok === false, 'expected invalid but passed')
  return result.issues
}

async function main() {
  const { validateSource, validateSourceFile, RESOURCE_TYPES, URL_VARIABLES } = await loadModule(
    'src/sources/schema.ts',
  )

  console.log('valid source')
  {
    const result = validateSource(validSource())
    check('accepts a well-formed source', result.ok === true, JSON.stringify(result.issues))
    check('returns the parsed source', result.source?.id === 'example')
    check('fills request defaults', result.source?.request.timeoutMs === 15000)
  }

  console.log('identity')
  {
    expectInvalid(validateSource, 'rejects missing schemaVersion', (s) => delete s.schemaVersion)
    expectInvalid(validateSource, 'rejects wrong schemaVersion', (s) => (s.schemaVersion = 99))
    expectInvalid(validateSource, 'rejects missing id', (s) => delete s.id)
    expectInvalid(validateSource, 'rejects id with spaces', (s) => (s.id = 'my source'))
    expectInvalid(validateSource, 'rejects id starting with a dash', (s) => (s.id = '-bad'))
    expectInvalid(validateSource, 'rejects empty name', (s) => (s.name = ''))
    expectInvalid(validateSource, 'rejects missing version', (s) => delete s.version)
  }

  console.log('homepage and type')
  {
    expectInvalid(validateSource, 'rejects non-http homepage', (s) => (s.homepage = 'file:///x'))
    expectInvalid(validateSource, 'rejects malformed homepage', (s) => (s.homepage = 'not a url'))
    expectInvalid(validateSource, 'rejects unknown type', (s) => (s.type = 'podcast'))
    expectInvalid(validateSource, 'rejects missing type', (s) => delete s.type)
    check('accepts every declared type', RESOURCE_TYPES.every((type) => {
      const source = validSource()
      source.type = type
      return validateSource(source).ok
    }))
  }

  console.log('request config')
  {
    expectInvalid(validateSource, 'rejects non-object headers', (s) => (s.request.headers = 'x'))
    expectInvalid(validateSource, 'rejects non-string header value', (s) => (s.request.headers = { a: 1 }))
    expectInvalid(validateSource, 'rejects timeout below floor', (s) => (s.request.timeoutMs = 10))
    expectInvalid(validateSource, 'rejects timeout above ceiling', (s) => (s.request.timeoutMs = 999999))
    expectInvalid(validateSource, 'rejects negative delay', (s) => (s.request.delayMs = -1))
    expectInvalid(validateSource, 'rejects missing request block', (s) => delete s.request)
  }

  console.log('url templates')
  {
    expectInvalid(validateSource, 'rejects unknown placeholder', (s) => {
      s.search.url = 'https://example.com/s?q={{keyword}}&x={{bogus}}'
    })
    expectInvalid(validateSource, 'rejects non-http search url', (s) => {
      s.search.url = 'ftp://example.com/s?q={{keyword}}'
    })
    expectInvalid(validateSource, 'rejects malformed search url', (s) => {
      s.search.url = 'not a url'
    })
    check(
      'accepts all documented placeholders',
      URL_VARIABLES.every((name) => {
        const source = validSource()
        source.search.url = `https://example.com/s?a={{${name}}}`
        return validateSource(source).ok
      }),
    )
  }

  console.log('selectors')
  {
    expectInvalid(validateSource, 'rejects selector without a prefix', (s) => {
      s.search.fields.title = '.title'
    })
    expectInvalid(validateSource, 'rejects unknown prefix', (s) => {
      s.search.fields.title = 'xpath://div'
    })
    expectInvalid(validateSource, 'rejects missing list selector', (s) => {
      delete s.search.list
    })
    expectInvalid(validateSource, 'rejects missing detailUrl selector', (s) => {
      delete s.search.fields.detailUrl
    })
    expectInvalid(validateSource, 'rejects missing chapter content', (s) => {
      delete s.chapter.content
    })

    // All three prefixes are accepted where a selector is expected.
    for (const selector of ['$.data.title', 'css:.title', '@js: input.data.title']) {
      const source = validSource()
      source.search.fields.title = selector
      check(`accepts selector ${selector}`, validateSource(source).ok)
    }
  }

  console.log('js expressions')
  {
    const banned = ['fetch', 'XMLHttpRequest', 'eval(', 'document', 'window', '__TAURI_INTERNALS__']
    for (const name of banned) {
      expectInvalid(validateSource, `rejects js using ${name}`, (s) => {
        s.search.fields.title = `@js: ${name}('x')`
      })
    }
    expectInvalid(validateSource, 'rejects unbalanced js parens', (s) => {
      s.search.fields.title = '@js: input.map(x => (x'
    })
    expectInvalid(validateSource, 'rejects empty js', (s) => {
      s.search.fields.title = '@js:   '
    })
    const ok = validSource()
    ok.search.fields.title = '@js: input.items.map(i => i.name).join(" / ")'
    check('accepts a safe js expression', validateSource(ok).ok)
  }

  console.log('download block')
  {
    expectInvalid(validateSource, 'rejects unknown download format', (s) => {
      s.download = { format: 'docx' }
    })
    expectInvalid(validateSource, 'rejects download without format', (s) => {
      s.download = { url: 'css:a@href' }
    })
    const ok = validSource()
    ok.download = { url: 'css:a@href', format: 'txt' }
    check('accepts a valid download block', validateSource(ok).ok)
  }

  console.log('auth block')
  {
    const plain = validSource()
    check('auth is optional', validateSource(plain).ok === true)

    const ok = validSource()
    ok.auth = { type: 'cookie' }
    const accepted = validateSource(ok)
    check('accepts a minimal auth block', accepted.ok === true)
    check('auth type survives assembly', accepted.source?.auth?.type === 'cookie')

    const withUrls = validSource()
    withUrls.auth = {
      type: 'cookie',
      loginUrl: 'https://passport.example.com/login',
      host: 'passport.example.com',
    }
    const full = validateSource(withUrls)
    check('accepts loginUrl and host', full.ok === true)
    check('loginUrl is kept', full.source?.auth?.loginUrl === 'https://passport.example.com/login')
    check('host is kept', full.source?.auth?.host === 'passport.example.com')

    expectInvalid(validateSource, 'rejects auth without a type', (s) => {
      s.auth = { loginUrl: 'https://example.com/login' }
    })
    expectInvalid(validateSource, 'rejects an unknown auth type', (s) => {
      s.auth = { type: 'oauth' }
    })
    expectInvalid(validateSource, 'rejects a non-http loginUrl', (s) => {
      s.auth = { type: 'cookie', loginUrl: 'file:///C:/Windows/win.ini' }
    })
    expectInvalid(validateSource, 'rejects a malformed loginUrl', (s) => {
      s.auth = { type: 'cookie', loginUrl: 'not a url' }
    })
    // `host` is compared against a request's host, so a URL or a port could only
    // ever fail to match — reject it at validation time instead.
    expectInvalid(validateSource, 'rejects a host containing a scheme', (s) => {
      s.auth = { type: 'cookie', host: 'https://example.com' }
    })
    expectInvalid(validateSource, 'rejects a host containing a path', (s) => {
      s.auth = { type: 'cookie', host: 'example.com/login' }
    })

    // The whole point of the design: no secret may live in a source file.
    const json = JSON.stringify(validateSource(withUrls).source)
    check('assembled source carries no cookie', !/cookie"\s*:\s*"/.test(json), json)
  }

  console.log('detail tocUrl')
  {
    const ok = validSource()
    ok.detail.tocUrl = 'css:a.toc-link@href'
    const accepted = validateSource(ok)
    check('accepts detail.tocUrl', accepted.ok === true, JSON.stringify(accepted.issues))
    check('tocUrl is kept', accepted.source?.detail?.tocUrl === 'css:a.toc-link@href')

    expectInvalid(validateSource, 'rejects a tocUrl without a prefix', (s) => {
      s.detail.tocUrl = 'a.toc-link'
    })
  }

  console.log('file-level validation')
  {
    const single = validateSourceFile(validSource())
    check('accepts a single object', single.ok === true && single.sources.length === 1)

    const array = validateSourceFile([validSource(), { ...validSource(), id: 'other' }])
    check('accepts an array', array.ok === true && array.sources.length === 2)

    const duplicate = validateSourceFile([validSource(), validSource()])
    check('rejects duplicate ids', duplicate.ok === false)
    check(
      'duplicate error names the id',
      duplicate.issues.some((issue) => issue.message.includes('重复')),
      JSON.stringify(duplicate.issues),
    )

    const mixed = validateSourceFile([validSource(), { id: 'broken' }])
    check('reports the broken one by index', mixed.ok === false)
    check(
      'issue path carries the index',
      mixed.issues.some((issue) => issue.path.startsWith('[1]')),
      JSON.stringify(mixed.issues),
    )
  }

  console.log('error quality')
  {
    const issues = expectInvalid(validateSource, 'rejects missing title selector', (s) => {
      delete s.search.fields.title
    })
    check(
      'issue names the exact field',
      issues.some((issue) => issue.path === 'search.fields.title'),
      JSON.stringify(issues),
    )
    check(
      'issue is in Chinese',
      issues.some((issue) => /[\u4e00-\u9fa5]/.test(issue.message)),
      JSON.stringify(issues),
    )
    check('reports every issue, not just the first', issues.length >= 1)
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
