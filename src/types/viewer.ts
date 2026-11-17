/**
 * The contract between the app shell and a content viewer.
 *
 * Everything a format needs to plug into litearti lives here. The shell never
 * knows what a TXT or a PDF is: it asks the registry which viewer claims an
 * extension, mounts that viewer, and hands it an entry. Adding a format —
 * including a user-defined container format — means registering a descriptor,
 * not editing the shell.
 *
 * See `docs/viewer-contract.md` for the authoring guide and a worked example.
 */

import type { Component } from 'vue'

/**
 * What a library entry points at.
 *
 * One shelf, two shapes. A person does not think of "files I imported" and "titles I
 * added from a source" as separate places — they think "things I can open" — so the
 * list holds both and filters separate them. The unused fields are empty rather than
 * absent, which is what lets an old `library.json` load unchanged.
 */
export type EntryKind = 'file' | 'online'

/** Where an online entry came from. */
export interface EntryRef {
  sourceId: string
  /**
   * The source's display name when the entry was added.
   *
   * Kept even after the source is deleted, so the UI can say "这个源已删除（MXdm）"
   * instead of showing an id nobody recognises.
   */
  sourceName?: string | null
  /** The title's detail page on that source. */
  detailUrl: string
  cover?: string | null
  episodeCount?: number | null
  /**
   * Set when the source was found missing or disabled; cleared when a lookup
   * succeeds. Never a reason to delete the entry — that is the person's record.
   */
  invalid: boolean
}

/** A library entry as the backend stores it. */
export interface Entry {
  id: string
  /** What this points at. Defaults to `file` for libraries written before this existed. */
  kind: EntryKind
  title: string
  /** Lowercase extension without the dot; empty string when there is none, and always empty for online entries. */
  extension: string
  size: number
  sourcePath: string
  storedName: string
  addedAt: number
  lastOpenedAt: number | null
  /**
   * A display name the person typed over `title`.
   *
   * Kept separate from `title` rather than overwriting it: the imported name is
   * still the only link back to the original file, and clearing the rename is
   * the undo.
   */
  rename?: string | null
  /**
   * The group this entry belongs to, e.g. the source it was downloaded from.
   * Absent for hand-imported files, which is the common case.
   */
  group?: string | null
  /** Where an online entry came from. Absent for files. */
  reference?: EntryRef | null
  /**
   * Viewer-owned resume state. Shape is defined by the viewer, not the shell.
   *
   * For online entries this is the only playback position. There is deliberately no
   * second copy in localStorage: two stores for one fact is how the library ends up
   * saying "episode 3" while the player says "episode 5".
   */
  progress: unknown
}

/** Whether an entry is a managed file rather than a reference to a source. */
export function isFileEntry(entry: Entry): boolean {
  return entry.kind !== 'online'
}

/** Whether an entry is a reference that currently cannot be opened. */
export function isBrokenRef(entry: Entry): boolean {
  return entry.kind === 'online' && entry.reference?.invalid === true
}

/**
 * What a viewer may do through the shell.
 *
 * This is deliberately the *whole* surface: no viewer gets direct access to
 * the filesystem, the library, or Tauri. That keeps a future plugin boundary
 * cheap to enforce, and keeps viewers portable to Android where the file
 * access model differs.
 */
export interface ViewerHost {
  /** Read the entry's bytes. Resolves to an ArrayBuffer. */
  readBinary(entryId: string): Promise<ArrayBuffer>
  /** Read the entry's bytes decoded as text, optionally forcing an encoding. */
  readText(entryId: string, encoding?: string): Promise<DecodedText>
  /** Absolute path of the stored copy. Only meaningful on desktop. */
  entryPath(entryId: string): Promise<string>
  /**
   * A URL the webview can load for the entry's bytes (e.g. an `<audio src>`).
   * Prefer this over `entryPath`: a raw filesystem path is not loadable from
   * the webview, and the URL form is the one that survives an Android port.
   */
  entryUrl(entryId: string): Promise<string>
  /** Persist resume state. The shell stores it opaquely. */
  saveProgress(entryId: string, progress: unknown): Promise<void>
}

export interface DecodedText {
  text: string
  encoding: string
  hadBom: boolean
  lossy: boolean
}

/** Props every viewer component receives. */
export interface ViewerProps {
  entry: Entry
  host: ViewerHost
}

/**
 * One viewer registration.
 *
 * `extensions` is the routing key. `probe` is an optional escape hatch for
 * formats that share an extension (or have none) and need to inspect bytes
 * before claiming a file.
 */
export interface ViewerDescriptor {
  /** Stable identifier, used in logs and for the "open with" override. */
  id: string
  /** Human label shown in menus and the library's type hint. */
  label: string
  /** Extensions this viewer claims, lowercase and without dots. */
  extensions: string[]
  /**
   * Higher wins when several viewers claim the same extension. Built-ins sit
   * at 0; a user-supplied viewer can claim an extension by outranking them.
   */
  priority?: number
  /**
   * Optional byte-level check for ambiguous extensions. Returning `false`
   * passes the file to the next candidate. Keep it cheap — it runs before
   * the viewer mounts.
   */
  probe?: (bytes: ArrayBuffer, entry: Entry) => boolean | Promise<boolean>
  /**
   * The component to mount. Use `defineAsyncComponent` so heavy engines
   * (pdf.js, an unzip library) load only when a file of that type is opened.
   */
  component: Component
}
