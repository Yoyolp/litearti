/**
 * The viewer registry.
 *
 * Registration is plain and synchronous at startup, which keeps routing
 * deterministic: by the time the shell renders, the registry is complete.
 * Later extension points (a plugin folder, a manifest in a custom container)
 * register into the same object, so the shell never learns a second mechanism.
 */

import type { ViewerDescriptor } from '@/types/viewer'

const registry: ViewerDescriptor[] = []

/** Register one viewer. Later registrations with equal priority win, so a
 *  user-supplied viewer can override a built-in by registering after it. */
export function registerViewer(descriptor: ViewerDescriptor): void {
  if (!descriptor.id) throw new Error('viewer descriptor needs an id')
  if (!descriptor.extensions.length && !descriptor.probe) {
    throw new Error(`viewer "${descriptor.id}" claims no extension and has no probe`)
  }
  registry.push({ ...descriptor, priority: descriptor.priority ?? 0 })
}

/** Every registered viewer, highest priority first. */
export function allViewers(): ViewerDescriptor[] {
  return [...registry].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
}

/** Viewers that claim an extension, best candidate first. */
export function viewersFor(extension: string): ViewerDescriptor[] {
  const ext = extension.toLowerCase().replace(/^\./, '')
  return allViewers().filter((v) => v.extensions.includes(ext))
}

/**
 * Resolve the viewer for an entry.
 *
 * Ambiguity is resolved by priority, then by `probe` in order. A file nobody
 * claims returns `null`; the shell turns that into an explanatory empty state
 * rather than an error, because an unknown format is a normal thing to have.
 */
export async function resolveViewer(
  entry: { extension: string },
  readBytes: () => Promise<ArrayBuffer>,
): Promise<ViewerDescriptor | null> {
  const candidates = viewersFor(entry.extension)
  if (!candidates.length) return null

  let bytes: ArrayBuffer | null = null
  for (const candidate of candidates) {
    if (!candidate.probe) return candidate
    bytes ??= await readBytes()
    try {
      if (await candidate.probe(bytes, entry as never)) return candidate
    } catch {
      // A probe that throws simply doesn't claim the file; another viewer may.
    }
  }
  return null
}
