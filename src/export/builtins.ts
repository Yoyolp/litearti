/**
 * Built-in export targets.
 *
 * This file is the *entire* list of what the app can export to. Adding a format
 * (Markdown, a custom container, an image bundle) means registering here — the
 * library view, the store, and the pipeline never change.
 *
 * Note what is deliberately absent: audio has no text target. Converting an MP3
 * to text would need speech recognition, which is a different product. Rather
 * than hiding that, the menu greys the text target out for audio entries and
 * shows `unsupportedReason`.
 */

import { registerConvertTarget } from './registry'
import { epubToText } from './converters/epub'
import { pdfToText } from './converters/pdf'
import { textToText } from './converters/text'

/** Source formats that already are, or cleanly reduce to, plain text. */
const TEXT_SOURCES = [
  'txt', 'md', 'log', 'text', 'csv', 'json', 'yml', 'yaml',
  'pdf',
  'epub',
]

let registered = false

/** Register every built-in target. Idempotent, so HMR can call it again. */
export function registerBuiltinTargets(): void {
  if (registered) return
  registered = true

  // `original` has no converter: the pipeline copies the stored bytes. Keeping
  // it in the registry means the menu, the store and the pipeline all handle it
  // through the same path as any future target.
  registerConvertTarget({
    id: 'original',
    label: '原始文件',
    extension: '',
    supports: 'all',
  })

  registerConvertTarget({
    id: 'text',
    label: '纯文本 .txt',
    extension: 'txt',
    supports: TEXT_SOURCES,
    unsupportedReason: '音频没有可导出的文本内容',
    convert: async (input) => {
      switch (input.entry.extension) {
        case 'pdf':
          return pdfToText(input)
        case 'epub':
          return epubToText(input)
        default:
          // Everything else in TEXT_SOURCES is already a text document; the
          // backend decodes it with the same rules the viewer uses.
          return textToText(input)
      }
    },
  })
}
