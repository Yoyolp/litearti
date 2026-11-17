/**
 * Validates every file in `importable-sources/` with the app's own validator.
 *
 * Run with: node scripts/verify-importable-sources.mjs
 *
 * The point of the folder is that a person can import these without meeting an
 * error. So this does not check "the file parses" — it bundles the real
 * `validateSourceFile` from `src/sources/schema.ts` and runs it, which means a rule
 * that the editor would reject is rejected here too. A hand-written schema copy
 * would drift and give a false green.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = 'D:/Myproject/litearti'
const folder = join(root, 'importable-sources')
const require = createRequire(import.meta.url)

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

/** Bundle a TS module to a temp file and import it. */
async function loadModule(relativePath) {
  const esbuild = require(
    join(root, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'),
  )
  const outfile = join(root, `.tmp-importable-${Date.now()}.mjs`)
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
  const schema = await loadModule('src/sources/schema.ts')
  const files = (await readdir(folder)).filter((name) => name.endsWith('.json'))

  check('the folder has at least one source file', files.length > 0, `${files.length} files`)

  const ids = new Map()
  let total = 0

  for (const file of files.sort()) {
    const raw = await readFile(join(folder, file), 'utf8')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      check(`${file} is valid JSON`, false, String(error))
      continue
    }

    const result = schema.validateSourceFile(parsed)
    check(
      `${file} passes the real validator`,
      result.ok,
      JSON.stringify(result.issues.slice(0, 3)),
    )
    if (!result.ok) continue

    check(`${file} declares at least one source`, result.sources.length > 0)

    for (const source of result.sources) {
      total += 1
      // A duplicate id across files is the one thing a per-file check cannot see,
      // and it is exactly what happens when someone copies a template and forgets
      // to change the id.
      const previous = ids.get(source.id)
      check(
        `${file}: id "${source.id}" is unique across the folder`,
        previous === undefined,
        previous ? `also in ${previous}` : undefined,
      )
      ids.set(source.id, file)

      // Every source needs a homepage: the UI uses it for "open site", and a
      // source without one leaves that button pointing nowhere.
      check(
        `${file}: "${source.id}" has an http(s) homepage`,
        /^https?:\/\//.test(source.homepage ?? ''),
        source.homepage,
      )
    }
  }

  check('the folder holds more than a single source', total >= 2, `${total} sources`)

  // A video source without a `video` block is rejected by the validator, so this
  // is a reminder of why rather than a new rule: it means the folder is only
  // useful for video if each one declares how to play.
  console.log(`\n${files.length} file(s), ${total} source(s)`)
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
