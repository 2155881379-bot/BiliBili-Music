export interface VirtualWindow {
  start: number
  end: number
  top: number
  bottom: number
}

/** The end is exclusive; spacers plus rows always occupy the complete list height. */
export function virtualWindow(count: number, rowHeight: number, scrollTop: number, viewport: number, overscan = 5): VirtualWindow {
  const length = Math.max(0, Math.floor(count))
  const height = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 60
  const extra = Math.max(0, Math.floor(overscan))
  const visibleHeight = Math.max(0, Number.isFinite(viewport) ? viewport : 0)
  const offset = Math.min(Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0), Math.max(0, length * height - visibleHeight))
  const start = Math.max(0, Math.floor(offset / height) - extra)
  const end = Math.min(length, Math.ceil((offset + visibleHeight) / height) + extra)
  return { start, end, top: start * height, bottom: (length - end) * height }
}

/** Only move when the row cannot already be seen. */
export function revealOffset(index: number, count: number, height: number, scrollTop: number, viewport: number): number {
  if (index < 0 || index >= count || viewport <= 0) return scrollTop
  const top = index * height
  if (top >= scrollTop && top + height <= scrollTop + viewport) return scrollTop
  return Math.min(Math.max(0, top - (viewport - height) / 2), Math.max(0, count * height - viewport))
}
