import type { PlayMode, Track, VideoInfo } from '../../../shared/types'

/**
 * 队列中每一条曲目都拥有一个独立的、稳定的 queueId。
 *
 * 旧实现用 `track.id + index` 作为列表 key：拖动后 index 变化导致 key 变化，
 * Vue 会把整行销毁重建（30+ 首时肉眼可见卡顿）。同一首歌（甚至同一对象）
 * 也无法重复入队，因为 key 会冲突。queueId 在入队时一次性赋予，move/remove
 * 都不改写，从而让列表行身份稳定、重复曲目各自独立。
 */
export interface QueueEntry extends Track {
  queueId: string
}

let idCounter = 0

/**
 * 生成稳定身份。优先用 crypto.randomUUID（Electron renderer 与 node 测试环境都支持）；
 * 不可用时回退到时间戳 + 自增计数器，仍能保证单进程内唯一。
 */
function genQueueId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // 某些环境 crypto 存在但 randomUUID 抛错，落到回退分支
  }
  idCounter += 1
  return `qid-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

/**
 * 由一首 Track 创建一条独立的队列条目。
 * 浅拷贝保证：同一对象多次入队得到互不影响的实例，修改其中一条的 cid 不会污染另一条。
 */
export function createQueueEntry(track: Track): QueueEntry {
  return { ...track, queueId: genQueueId() }
}

/** 批量转成队列条目，每条都生成独立 queueId。 */
export function toQueueEntries(tracks: readonly Track[]): QueueEntry[] {
  return tracks.map((track) => createQueueEntry(track))
}

/**
 * 纯函数版的"拖动排序"：把 from 的元素移到 to 位置，返回新数组，不改入参。
 * 边界与现有 store.move 对齐：to 被 clamp 到 [0, len-1]，from===target 时原样返回。
 */
export function moveEntry<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length || arr.length === 0) return arr.slice()
  const target = Math.min(Math.max(to, 0), arr.length - 1)
  if (from === target) return arr.slice()
  const next = arr.slice()
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}

/**
 * 在新队列里按 queueId 找回当前播放条目的索引。
 * queueId 为 null 时返回 -1（无当前曲目）。
 */
export function findCurrentIndex(entries: readonly QueueEntry[], queueId: string | null): number {
  if (queueId == null) return -1
  return entries.findIndex((entry) => entry.queueId === queueId)
}

/** 连续失败多少首就停，避免无限跳。与现有 store 行为一致。 */
export const FAILURE_THRESHOLD = 3

/**
 * 多 P 展开成多条独立队列条目，逻辑与旧 ensureCid 内联实现保持一致：
 * 单 P 返回 null（由调用方就地补 cid）；多 P 返回展开后的条目数组（第一条即当前页）。
 * 这里是纯函数，不触碰任何响应式状态，便于单测。
 */
export function expandMultiPage(track: Track, info: VideoInfo): QueueEntry[] | null {
  if (info.pages.length <= 1) return null
  return info.pages.map((page) => ({
    id: `${track.bvid}-${page.page}`,
    bvid: track.bvid,
    cid: page.cid,
    page: page.page,
    title: `${info.title} · ${page.part}`,
    cover: info.cover,
    owner: info.owner,
    duration: page.duration,
    queueId: genQueueId()
  }))
}

/**
 * 计算下一首要播放的索引。纯函数，便于 fast-check 覆盖三种模式。
 * - single: 返回当前索引（由调用方决定是循环本曲还是停滞）
 * - shuffle: 在 count>1 时随机选一个不同于 current 的索引
 * - order: (current + 1) % count
 *
 * 单曲循环在调用方处理（store 里 next(auto) 对 single 模式走 audio.currentTime=0），
 * 这里对 single 直接返回 current，保持函数无副作用。
 */
export function nextIndex(
  count: number,
  current: number,
  mode: PlayMode,
  rand: () => number = Math.random
): number {
  if (count <= 0) return -1
  // 没有当前曲目（首次播放/队列刚恢复）时，从第一首开始而不是跳到第二首
  if (current < 0) return 0
  if (current >= count) current = 0
  // single 返回当前索引：auto+single 的"循环本曲"由调用方在专门分支处理，
  // 手动 next 切歌时调用方应传 'order'（见 player.next）。
  if (mode === 'shuffle') {
    if (count === 1) return 0
    let idx = current
    let guard = 0
    while (idx === current && guard < 16) {
      idx = Math.floor(rand() * count)
      guard += 1
    }
    // 极小概率仍撞同一索引时，确定性地取下一个，避免死循环
    if (idx === current) idx = (current + 1) % count
    return idx
  }
  if (mode === 'single') return current
  return (current + 1) % count
}

