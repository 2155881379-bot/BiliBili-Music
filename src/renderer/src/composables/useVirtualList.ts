import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { revealOffset, virtualWindow } from '../utils/virtual-window'

/** Fixed-height song rows. Cached/covered/hidden views retain position without retaining image elements. */
export function useVirtualList<T>(items: () => readonly T[], options: { rowHeight?: number; active?: () => boolean; resetKey?: () => unknown } = {}) {
  const rowHeight = options.rowHeight ?? 60
  const listEl = ref<HTMLElement | null>(null)
  const scrollTop = ref(0)
  const viewport = ref(600)
  const activated = ref(true)
  const visible = ref(!document.hidden)
  const windowVisible = ref(true)
  const enabled = computed(() => activated.value && visible.value && windowVisible.value && (options.active?.() ?? true))
  const range = computed(() => virtualWindow(items().length, rowHeight, scrollTop.value, viewport.value))
  const rows = computed(() => enabled.value ? items().slice(range.value.start, range.value.end).map((item, offset) => ({ item, index: range.value.start + offset })) : [])
  const top = computed(() => enabled.value ? range.value.top : 0)
  const bottom = computed(() => enabled.value ? range.value.bottom : items().length * rowHeight)
  let frame = 0
  let generation = 0
  let observer: ResizeObserver | undefined
  let bound: HTMLElement | null = null
  let offWindowVisibility: (() => void) | undefined

  function measure(): void {
    frame = 0
    if (!bound || !enabled.value) return
    // Ignore KeepAlive's detached container, whose clientHeight is zero.
    if (bound.clientHeight > 0) {
      viewport.value = bound.clientHeight
      scrollTop.value = bound.scrollTop
    }
  }
  function schedule(): void {
    if (!frame && enabled.value) frame = requestAnimationFrame(measure)
  }
  function detach(): void {
    generation += 1
    if (bound && enabled.value && bound.clientHeight > 0) scrollTop.value = bound.scrollTop
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    observer?.disconnect()
    observer = undefined
    bound?.removeEventListener('scroll', schedule)
    bound = null
  }
  async function attach(): Promise<void> {
    detach()
    const version = generation
    await nextTick()
    if (version !== generation || !enabled.value || !listEl.value) return
    bound = listEl.value
    bound.scrollTop = scrollTop.value
    bound.addEventListener('scroll', schedule, { passive: true })
    observer = new ResizeObserver(schedule)
    observer.observe(bound)
    measure()
  }
  function reset(): void {
    scrollTop.value = 0
    if (listEl.value) listEl.value.scrollTop = 0
    schedule()
  }
  async function reveal(index: number): Promise<void> {
    await nextTick()
    if (!enabled.value || !listEl.value) return
    const offset = revealOffset(index, items().length, rowHeight, scrollTop.value, listEl.value.clientHeight)
    scrollTop.value = offset
    listEl.value.scrollTop = offset
  }
  function visibilityChange(): void { visible.value = !document.hidden }

  watch([listEl, enabled], () => { if (enabled.value) void attach(); else detach() }, { flush: 'post' })
  watch(() => items().length, () => {
    const maximum = Math.max(0, items().length * rowHeight + 20 - viewport.value)
    if (scrollTop.value > maximum) {
      scrollTop.value = maximum
      if (listEl.value) listEl.value.scrollTop = maximum
    }
  })
  if (options.resetKey) watch(options.resetKey, reset)
  onMounted(() => {
    document.addEventListener('visibilitychange', visibilityChange)
    // Older preload builds still use the browser visibility event.
    const visibilityApi = window.api as typeof window.api & {
      onVisibilityChange?: (callback: (visible: boolean) => void) => () => void
      isWindowVisible?: () => Promise<boolean>
    }
    offWindowVisibility = visibilityApi.onVisibilityChange?.(value => { windowVisible.value = value })
    void visibilityApi.isWindowVisible?.().then(value => { windowVisible.value = value })
    void attach()
  })
  onActivated(() => { activated.value = true; void attach() })
  onDeactivated(() => { activated.value = false; detach() })
  onBeforeUnmount(() => { detach(); offWindowVisibility?.(); document.removeEventListener('visibilitychange', visibilityChange) })
  return { listEl, rows, top, bottom, enabled, reveal, reset }
}
