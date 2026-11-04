/** Byte size in a compact, honest form: 1.2 MB, 840 KB, 12 B. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** Seconds as m:ss, or h:mm:ss past an hour. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * Relative time, coarse on purpose.
 *
 * A library list does not need second-level precision, and coarse wording
 * reads calmer than a timestamp.
 */
export function formatRelative(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))} 周前`

  const date = new Date(timestamp)
  const sameYear = new Date(now).getFullYear() === date.getFullYear()
  const month = date.getMonth() + 1
  const dayOfMonth = date.getDate()
  return sameYear ? `${month} 月 ${dayOfMonth} 日` : `${date.getFullYear()} 年 ${month} 月`
}

/** Uppercase extension label, or an em dash when there is none. */
export function extensionLabel(extension: string): string {
  return extension ? extension.toUpperCase() : '—'
}

/** Clamp a number into a range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 0–1 ratio → integer percent, guarding divide-by-zero. */
export function toPercent(part: number, whole: number): number {
  if (!whole) return 0
  return clamp(Math.round((part / whole) * 100), 0, 100)
}
