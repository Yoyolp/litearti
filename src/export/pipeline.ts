/**
 * The export pipeline: entries in, files on disk out.
 *
 * Two phases, in this order on purpose:
 *
 *   1. **Convert everything** into memory, recording per-entry failures.
 *   2. **Write everything** in one backend call.
 *
 * The alternative — convert-and-write per entry — leaves a half-written batch
 * when entry seven throws, and the person has no way to tell which files are
 * good. Converting first means a failure is reported before anything touches
 * disk.
 *
 * Failures are collected, never thrown: one unreadable book must not cancel the
 * other nine.
 */

import * as api from '@/api/library'
import type { Entry } from '@/types/viewer'
import { outputFileName } from './naming'
import { registerBuiltinTargets } from './builtins'
import type { ConvertOutput, ConvertTarget } from './registry'

/** One converted file, ready to write. */
export interface ExportPlanItem {
  entry: Entry
  fileName: string
  bytes: Uint8Array
}

/** Why one entry was left out. */
export interface ExportSkip {
  entry: Entry
  reason: string
}

export interface ExportPlan {
  target: ConvertTarget
  items: ExportPlanItem[]
  skipped: ExportSkip[]
}

export interface ExportOutcome {
  written: number
  skipped: ExportSkip[]
  /** Absolute paths actually written, for the success message. */
  writtenNames: string[]
}

/** Encode text output as UTF-8 bytes, without a BOM. */
function encode(output: ConvertOutput): Uint8Array {
  if (typeof output === 'string') return new TextEncoder().encode(output)
  return output
}

/**
 * Build the plan for a selection.
 *
 * `onProgress` is called per entry so the UI can show "正在转换 3 / 5" — a long
 * PDF can take seconds and a frozen dialog reads as a hang.
 */
export async function buildPlan(
  entries: readonly Entry[],
  target: ConvertTarget,
  onProgress?: (done: number, total: number, entry: Entry) => void,
): Promise<ExportPlan> {
  // Registration is idempotent and must happen before any target lookup.
  registerBuiltinTargets()

  const items: ExportPlanItem[] = []
  const skipped: ExportSkip[] = []

  for (const [index, entry] of entries.entries()) {
    onProgress?.(index, entries.length, entry)

    const fileName = outputFileName(entry.title, entry.extension, target.extension)

    try {
      let bytes: Uint8Array
      if (target.id === 'original' || !target.convert) {
        // Byte copy: the stored file is exactly what was imported.
        const raw = await api.readBinary(entry.id)
        bytes = new Uint8Array(raw)
      } else {
        const output = await target.convert({
          entry,
          readBinary: () => api.readBinary(entry.id),
          readText: (encoding) => api.readText(entry.id, encoding),
        })
        bytes = encode(output)
      }

      if (bytes.byteLength === 0) {
        // An empty result almost always means "the conversion found nothing"
        // (a scanned PDF, an empty document). Writing a zero-byte file would
        // look like success, so it is reported instead.
        skipped.push({ entry, reason: '转换结果为空，可能是扫描件或不含文字' })
        continue
      }

      items.push({ entry, fileName, bytes })
    } catch (cause) {
      skipped.push({
        entry,
        reason: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  onProgress?.(entries.length, entries.length, entries[entries.length - 1] ?? ({} as Entry))

  return { target, items, skipped }
}

/**
 * Convert and write in one call.
 *
 * The directory is chosen by the caller (through the native picker) so this
 * module never has to know how a folder is picked — which is also what keeps it
 * testable without a dialog.
 */
export async function runExport(
  entries: readonly Entry[],
  target: ConvertTarget,
  directory: string,
  onProgress?: (done: number, total: number, entry: Entry) => void,
): Promise<ExportOutcome> {
  const plan = await buildPlan(entries, target, onProgress)

  if (!plan.items.length) {
    return { written: 0, skipped: plan.skipped, writtenNames: [] }
  }

  const outcome = await api.exportWrite(
    directory,
    plan.items.map((item) => ({ fileName: item.fileName, bytes: item.bytes })),
  )

  // The backend reports failures by filename; map each back to its entry so the
  // report can name the book rather than just the file.
  const byFileName = new Map(plan.items.map((item) => [item.fileName, item.entry]))

  return {
    written: outcome.written,
    skipped: [
      ...plan.skipped,
      // Files the backend refused (disk full, permissions, name collision
      // beyond the limit) belong in the same report as conversion failures.
      ...outcome.failed.map((failure) => ({
        entry: byFileName.get(failure.fileName),
        reason: failure.reason,
      })).filter((skip): skip is ExportSkip => skip.entry !== undefined),
    ],
    writtenNames: outcome.writtenNames,
  }
}
