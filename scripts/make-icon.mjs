// Draws the source icon: a monochrome "stacked pages" mark on a rounded
// square. Kept in the repo so the icon set can be regenerated without a
// design tool, which keeps the visual system honest — no hidden source file.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// SVG at 1024×1024, rasterized by the `tauri icon` command afterwards.
// Grayscale only, matching the app's near-monochrome system.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="224" fill="#fafafa"/>
  <rect x="272" y="240" width="480" height="544" rx="40" fill="#d4d4d4"/>
  <rect x="320" y="288" width="480" height="544" rx="40" fill="#e8e8e8"/>
  <rect x="368" y="336" width="480" height="544" rx="40" fill="#ffffff" stroke="#b4b4b4" stroke-width="8"/>
  <rect x="432" y="448" width="288" height="24" rx="12" fill="#3a3a3a"/>
  <rect x="432" y="536" width="352" height="24" rx="12" fill="#8a8a8a"/>
  <rect x="432" y="624" width="352" height="24" rx="12" fill="#8a8a8a"/>
  <rect x="432" y="712" width="208" height="24" rx="12" fill="#b4b4b4"/>
</svg>
`

const out = join(root, 'src-tauri', 'icons', 'source.svg')
mkdirSync(dirname(out), { recursive: true })
const { writeFileSync } = await import('node:fs')
writeFileSync(out, svg, 'utf8')
console.log('wrote', out)
