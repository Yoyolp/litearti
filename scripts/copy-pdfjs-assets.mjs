// Copies the pdf.js runtime assets that cannot be bundled by Vite into
// `public/pdfjs/` so they are served verbatim at `/pdfjs/*` in dev and copied
// into the production bundle. Idempotent: re-running only rewrites when the
// source package version changes.
import { cp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'node_modules', 'pdfjs-dist')
const dest = join(root, 'public', 'pdfjs')
const stampPath = join(dest, '.version')

/** Assets pdf.js loads at runtime by URL rather than by import. */
const DIRECTORIES = ['cmaps', 'standard_fonts', 'wasm', 'iccs']
const FILES = ['build/pdf.worker.min.mjs']

async function main() {
  let version
  try {
    const pkg = JSON.parse(await readFile(join(src, 'package.json'), 'utf8'))
    version = pkg.version
  } catch {
    console.error('[pdfjs] pdfjs-dist is not installed; run `pnpm install` first.')
    process.exit(1)
  }

  try {
    const stamp = await readFile(stampPath, 'utf8')
    if (stamp.trim() === version) {
      console.log(`[pdfjs] assets already at ${version}, skipping`)
      return
    }
  } catch {
    // no stamp yet — fall through and copy
  }

  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })

  for (const dir of DIRECTORIES) {
    const from = join(src, dir)
    try {
      await stat(from)
    } catch {
      console.warn(`[pdfjs] skipping missing directory: ${dir}`)
      continue
    }
    await cp(from, join(dest, dir), { recursive: true })
  }

  for (const file of FILES) {
    await cp(join(src, file), join(dest, file))
  }

  await writeFile(stampPath, `${version}\n`, 'utf8')
  console.log(`[pdfjs] assets ready at ${version}`)
}

main().catch((error) => {
  console.error('[pdfjs] failed:', error)
  process.exit(1)
})
