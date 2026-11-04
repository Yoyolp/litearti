/**
 * Built-in viewer registrations.
 *
 * This file is the *entire* list of formats the app ships with. Adding a
 * format means adding an entry here (or calling `registerViewer` from a future
 * plugin module) — never editing the shell.
 *
 * Components are async so their engines (pdf.js in particular) are fetched
 * only when a file of that type is first opened.
 */

import { defineAsyncComponent } from 'vue'
import { registerViewer } from './registry'

const TextReader = defineAsyncComponent(() => import('./TextReader.vue'))
const PdfReader = defineAsyncComponent(() => import('./PdfReader.vue'))
const AudioPlayer = defineAsyncComponent(() => import('./AudioPlayer.vue'))
const EpubReader = defineAsyncComponent(() => import('./EpubReader.vue'))

let registered = false

/** Register every built-in viewer. Idempotent, so HMR can call it again. */
export function registerBuiltinViewers(): void {
  if (registered) return
  registered = true

  registerViewer({
    id: 'text',
    label: '文本',
    extensions: ['txt', 'md', 'log', 'text', 'csv', 'json', 'yml', 'yaml'],
    priority: 0,
    component: TextReader,
  })

  registerViewer({
    id: 'pdf',
    label: 'PDF',
    extensions: ['pdf'],
    priority: 0,
    component: PdfReader,
  })

  registerViewer({
    id: 'audio',
    label: '音频',
    extensions: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'weba'],
    priority: 0,
    component: AudioPlayer,
  })

  registerViewer({
    id: 'epub',
    label: 'EPUB',
    extensions: ['epub'],
    priority: 0,
    component: EpubReader,
  })
}
