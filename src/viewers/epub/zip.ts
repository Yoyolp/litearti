/**
 * Minimal ZIP reader — no dependency.
 *
 * EPUB is a ZIP container, and the only thing the viewer needs from it is
 * "give me the bytes of this entry". Rather than pulling in a full archive
 * library (the project keeps five runtime dependencies), this reads the
 * central directory and inflates entries with the browser's built-in
 * `DecompressionStream('deflate-raw')`, which ships in Chromium 103+ and
 * therefore in the WebView2 runtime on Windows 10/11.
 *
 * Only what EPUB needs is implemented: stored and deflated entries, plus the
 * ZIP64 record so a very large archive is read correctly instead of silently
 * misreading offsets.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50

/** Compressed size / offset marker meaning "the real value is in the ZIP64 extra field". */
const ZIP64_MARKER = 0xffffffff

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

export interface ZipEntry {
  readonly name: string
  /** 0 = stored, 8 = deflate. Anything else is unsupported. */
  readonly method: number
  readonly compressedSize: number
  readonly size: number
  /** Offset of the local file header. */
  readonly offset: number
}

/** True when the runtime can inflate a deflate-raw stream. */
export function canInflate(): boolean {
  return typeof DecompressionStream !== 'undefined'
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (!canInflate()) {
    throw new ZipError('当前系统不支持解压（需要 Chromium 103 或更高版本）')
  }
  // `deflate-raw` is the bare DEFLATE stream ZIP stores, without a zlib or
  // gzip wrapper. Blob → stream → DecompressionStream keeps the whole thing
  // in the browser's native path, so no JS loop over the bytes.
  //
  // The slice is deliberate: `Uint8Array` is typed over `ArrayBufferLike`,
  // which includes `SharedArrayBuffer`, and `BlobPart` only accepts a real
  // `ArrayBuffer`. Copying into a fresh buffer both satisfies the type and
  // detaches the view from the (much larger) archive buffer.
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

export class ZipArchive {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private readonly index: Map<string, ZipEntry>
  private readonly decoder = new TextDecoder('utf-8')

  private constructor(bytes: Uint8Array, index: Map<string, ZipEntry>) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.index = index
  }

  static open(bytes: Uint8Array): ZipArchive {
    if (bytes.length < 22) throw new ZipError('文件太小，不是有效的 ZIP')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const eocd = findEocd(view)
    if (eocd < 0) throw new ZipError('找不到 ZIP 目录，文件可能已损坏')

    let count = view.getUint16(eocd + 10, true)
    let directoryOffset = view.getUint32(eocd + 16, true)
    let directorySize = view.getUint32(eocd + 12, true)

    // ZIP64: the 32-bit fields are saturated and the real values live in a
    // separate record. Large comic-style EPUBs hit this.
    if (count === 0xffff || directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER) {
      const zip64 = readZip64(view, eocd)
      if (!zip64) throw new ZipError('ZIP64 目录缺失，文件可能已损坏')
      count = zip64.count
      directoryOffset = zip64.offset
      directorySize = zip64.size
    }

    if (directoryOffset + directorySize > bytes.length) {
      throw new ZipError('ZIP 目录越界，文件可能已损坏')
    }

    const index = new Map<string, ZipEntry>()
    let cursor = directoryOffset
    for (let i = 0; i < count; i += 1) {
      if (cursor + 46 > bytes.length) throw new ZipError('ZIP 目录被截断')
      if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
        throw new ZipError('ZIP 目录项损坏')
      }
      const method = view.getUint16(cursor + 10, true)
      let compressedSize = view.getUint32(cursor + 20, true)
      let size = view.getUint32(cursor + 24, true)
      const nameLength = view.getUint16(cursor + 28, true)
      const extraLength = view.getUint16(cursor + 30, true)
      const commentLength = view.getUint16(cursor + 32, true)
      let localOffset = view.getUint32(cursor + 42, true)
      const nameStart = cursor + 46
      const name = new TextDecoder('utf-8').decode(
        bytes.subarray(nameStart, nameStart + nameLength),
      )

      // The ZIP64 extra field (id 0x0001) carries the saturated values in a
      // fixed order: uncompressed size, compressed size, local header offset.
      if (size === ZIP64_MARKER || compressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
        const extraStart = nameStart + nameLength
        const extra = readExtraField(bytes, extraStart, extraLength, 0x0001)
        if (extra) {
          let p = 0
          if (size === ZIP64_MARKER) {
            size = Number(readUint64(extra, p))
            p += 8
          }
          if (compressedSize === ZIP64_MARKER) {
            compressedSize = Number(readUint64(extra, p))
            p += 8
          }
          if (localOffset === ZIP64_MARKER) {
            localOffset = Number(readUint64(extra, p))
          }
        }
      }

      index.set(name, { name, method, compressedSize, size, offset: localOffset })
      cursor = nameStart + nameLength + extraLength + commentLength
    }

    return new ZipArchive(bytes, index)
  }

  /** Whether the archive contains this exact entry name. */
  has(name: string): boolean {
    return this.index.has(name) || this.index.has(encodeURI(name))
  }

  /** Entry names, in central-directory order. */
  names(): string[] {
    return [...this.index.keys()]
  }

  private entry(name: string): ZipEntry | null {
    return this.index.get(name) ?? this.index.get(encodeURI(name)) ?? null
  }

  /** Raw bytes of one entry. */
  async read(name: string): Promise<Uint8Array> {
    const entry = this.entry(name)
    if (!entry) throw new ZipError(`压缩包内找不到 ${name}`)

    const local = entry.offset
    if (local + 30 > this.bytes.length) throw new ZipError('条目头越界')
    if (this.view.getUint32(local, true) !== LOCAL_SIGNATURE) {
      throw new ZipError(`条目 ${name} 的文件头损坏`)
    }
    // Sizes come from the central directory, which is authoritative even when
    // the entry used a data descriptor (bit 3) and its local header is zeroed.
    const nameLength = this.view.getUint16(local + 26, true)
    const extraLength = this.view.getUint16(local + 28, true)
    const dataStart = local + 30 + nameLength + extraLength
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > this.bytes.length) throw new ZipError(`条目 ${name} 被截断`)
    const raw = this.bytes.subarray(dataStart, dataEnd)

    if (entry.method === 0) return raw.slice()
    if (entry.method === 8) return inflateRaw(raw)
    throw new ZipError(`不支持的压缩方式（${entry.method}）：${name}`)
  }

  /** One entry decoded as UTF-8 text, with a BOM stripped. */
  async text(name: string): Promise<string> {
    const bytes = await this.read(name)
    const text = this.decoder.decode(bytes)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  }
}

/** Walk backwards for the end-of-central-directory record. */
function findEocd(view: DataView): number {
  const minRecord = 22
  const maxComment = 0xffff
  const last = view.byteLength - minRecord
  const first = Math.max(0, last - maxComment)
  for (let i = last; i >= first; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i
  }
  return -1
}

function readZip64(
  view: DataView,
  eocd: number,
): { count: number; offset: number; size: number } | null {
  const locator = eocd - 20
  if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) return null
  const recordOffset = Number(readUint64View(view, locator + 8))
  if (recordOffset + 56 > view.byteLength) return null
  if (view.getUint32(recordOffset, true) !== ZIP64_EOCD_SIGNATURE) return null
  return {
    count: Number(readUint64View(view, recordOffset + 32)),
    size: Number(readUint64View(view, recordOffset + 40)),
    offset: Number(readUint64View(view, recordOffset + 48)),
  }
}

/** Find one extra field by its header id. */
function readExtraField(
  bytes: Uint8Array,
  start: number,
  length: number,
  wanted: number,
): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = start
  const end = start + length
  while (p + 4 <= end) {
    const id = view.getUint16(p, true)
    const size = view.getUint16(p + 2, true)
    if (p + 4 + size > end) return null
    if (id === wanted) return bytes.subarray(p + 4, p + 4 + size)
    p += 4 + size
  }
  return null
}

function readUint64(bytes: Uint8Array, offset: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return readUint64View(view, offset)
}

function readUint64View(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true)
}
