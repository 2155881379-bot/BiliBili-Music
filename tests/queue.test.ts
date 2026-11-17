import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  FAILURE_THRESHOLD,
  createQueueEntry,
  expandMultiPage,
  findCurrentIndex,
  moveEntry,
  nextIndex,
  toQueueEntries
} from '../src/renderer/src/utils/queue'
import type { Track, VideoInfo } from '../src/shared/types'

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 'BV1xxx-1',
    bvid: 'BV1xxx',
    page: 1,
    title: 'demo',
    cover: 'https://example.com/c.jpg',
    owner: 'up',
    duration: 120,
    ...overrides
  }
}

describe('createQueueEntry', () => {
  it('gives each entry a unique queueId', () => {
    const t = track()
    const a = createQueueEntry(t)
    const b = createQueueEntry(t)
    expect(a.queueId).not.toBe('')
    expect(a.queueId).not.toBe(b.queueId)
  })

  it('returns an independent copy so mutating one entry does not leak into the other', () => {
    const t = track({ cid: undefined })
    const a = createQueueEntry(t)
    const b = createQueueEntry(t)
    a.cid = 100
    expect(b.cid).toBeUndefined()
  })

  it('preserves all Track fields', () => {
    const t = track({ id: 'BV9-2', bvid: 'BV9', page: 2, title: 'p2', duration: 90 })
    const e = createQueueEntry(t)
    expect({ id: e.id, bvid: e.bvid, page: e.page, title: e.title, duration: e.duration }).toEqual({
      id: 'BV9-2',
      bvid: 'BV9',
      page: 2,
      title: 'p2',
      duration: 90
    })
  })
})

describe('toQueueEntries', () => {
  it('produces one entry per input with unique queueIds', () => {
    const ts = [track({ id: 'a' }), track({ id: 'b' }), track({ id: 'c' })]
    const entries = toQueueEntries(ts)
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map((e) => e.queueId)).size).toBe(3)
  })

  it('keeps duplicate references distinct (same object twice -> two entries)', () => {
    const t = track({ id: 'a' })
    const entries = toQueueEntries([t, t, t])
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map((e) => e.queueId)).size).toBe(3)
  })
})

describe('moveEntry', () => {
  it('moves an item forward without mutating the input', () => {
    const arr = ['a', 'b', 'c', 'd']
    const out = moveEntry(arr, 1, 3)
    expect(out).toEqual(['a', 'c', 'd', 'b'])
    expect(arr).toEqual(['a', 'b', 'c', 'd'])
  })

  it('moves an item backward', () => {
    expect(moveEntry(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('clamps target into bounds', () => {
    expect(moveEntry(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a'])
    expect(moveEntry(['a', 'b', 'c'], 0, -5)).toEqual(['a', 'b', 'c'])
  })

  it('returns a copy when from===target', () => {
    const arr = ['a', 'b', 'c']
    const out = moveEntry(arr, 1, 1)
    expect(out).toEqual(['a', 'b', 'c'])
    expect(out).not.toBe(arr)
  })

  it('returns a copy for out-of-range from', () => {
    const arr = ['a', 'b']
    expect(moveEntry(arr, -1, 0)).toEqual(['a', 'b'])
    expect(moveEntry(arr, 5, 0)).toEqual(['a', 'b'])
    expect(moveEntry([], 0, 0)).toEqual([])
  })

  it('fast-check: every permutation of move keeps all elements', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 12 }),
        fc.nat({ max: 11 }),
        fc.nat({ max: 11 }),
        (arr, fromRaw, toRaw) => {
          const from = arr.length ? fromRaw % arr.length : 0
          const to = arr.length ? toRaw % arr.length : 0
          const out = moveEntry(arr, from, to)
          expect(out.length).toBe(arr.length)
          expect(out.slice().sort()).toEqual(arr.slice().sort())
        }
      )
    )
  })
})

describe('findCurrentIndex', () => {
  it('locates the entry by queueId', () => {
    const entries = toQueueEntries([track({ id: 'a' }), track({ id: 'b' })])
    expect(findCurrentIndex(entries, entries[1].queueId)).toBe(1)
  })

  it('returns -1 when queueId is null or missing', () => {
    const entries = toQueueEntries([track({ id: 'a' })])
    expect(findCurrentIndex(entries, null)).toBe(-1)
    expect(findCurrentIndex(entries, 'nope')).toBe(-1)
  })

  it('fast-check: after a move, the current queueId is still findable exactly once', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.string(), label: fc.string() }), { maxLength: 14 }),
        fc.nat({ max: 13 }),
        fc.nat({ max: 13 }),
        (arr, fromRaw, toRaw) => {
          if (!arr.length) return
          const tracks = arr.map((r) => track({ id: r.id, title: r.label }))
          const entries = toQueueEntries(tracks)
          const from = fromRaw % entries.length
          const targetQueueId = entries[from].queueId
          const to = toRaw % entries.length
          const moved = moveEntry(entries, from, to)
          const idx = findCurrentIndex(moved, targetQueueId)
          expect(idx).toBeGreaterThanOrEqual(0)
          const matches = moved.filter((e) => e.queueId === targetQueueId)
          expect(matches).toHaveLength(1)
        }
      )
    )
  })
})

describe('expandMultiPage', () => {
  const info: VideoInfo = {
    bvid: 'BV1xx',
    title: '合集',
    cover: 'c.jpg',
    duration: 600,
    owner: 'up',
    pages: [
      { cid: 11, page: 1, part: 'P1', duration: 100 },
      { cid: 22, page: 2, part: 'P2', duration: 200 },
      { cid: 33, page: 3, part: 'P3', duration: 300 }
    ]
  }

  it('returns null for single-page videos', () => {
    expect(expandMultiPage(track(), { ...info, pages: [info.pages[0]] })).toBeNull()
  })

  it('expands multi-page into independent entries with unique queueIds', () => {
    const out = expandMultiPage(track({ bvid: 'BV1xx' }), info)
    expect(out).not.toBeNull()
    expect(out!).toHaveLength(3)
    expect(new Set(out!.map((e) => e.queueId)).size).toBe(3)
    expect(out![0]).toMatchObject({ id: 'BV1xx-1', cid: 11, page: 1, title: '合集 · P1' })
    expect(out![2]).toMatchObject({ id: 'BV1xx-3', cid: 33, page: 3, title: '合集 · P3' })
  })

  it('does not mutate the source track', () => {
    const t = track({ cid: undefined })
    expandMultiPage(t, info)
    expect(t.cid).toBeUndefined()
  })
})

describe('nextIndex', () => {
  it('order wraps around', () => {
    expect(nextIndex(3, 0, 'order')).toBe(1)
    expect(nextIndex(3, 2, 'order')).toBe(0)
    expect(nextIndex(1, 0, 'order')).toBe(0)
  })

  it('single returns the same index', () => {
    expect(nextIndex(3, 1, 'single')).toBe(1)
    expect(nextIndex(1, 0, 'single')).toBe(0)
  })

  it('shuffle never equals current when count>1', () => {
    let calls = 0
    const rand = (): number => {
      calls += 1
      return 0.5
    }
    expect(nextIndex(3, 0, 'shuffle', rand)).not.toBe(0)
    expect(calls).toBeGreaterThan(0)
  })

  it('shuffle falls back deterministically if rand always returns current', () => {
    const rand = (): number => 0
    expect(nextIndex(3, 0, 'shuffle', rand)).toBe(1)
  })

  it('shuffle with count 1 returns 0', () => {
    expect(nextIndex(1, 0, 'shuffle')).toBe(0)
  })

  it('returns -1 for empty queue', () => {
    expect(nextIndex(0, -1, 'order')).toBe(-1)
    expect(nextIndex(0, -1, 'shuffle')).toBe(-1)
    expect(nextIndex(0, -1, 'single')).toBe(-1)
  })

  it('starts at the first track when there is no current (current=-1)', () => {
    // 首次播放/队列刚恢复时不该跳过第 0 首
    expect(nextIndex(3, -1, 'order')).toBe(0)
    expect(nextIndex(3, -1, 'shuffle')).toBeGreaterThanOrEqual(0)
    expect(nextIndex(3, -1, 'shuffle')).toBeLessThan(3)
    expect(nextIndex(3, -1, 'single')).toBe(0)
  })

  it('fast-check: shuffle never returns the current index for count>1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), fc.nat({ max: 19 }), (count, curRaw) => {
        const cur = curRaw % count
        const idx = nextIndex(count, cur, 'shuffle')
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThan(count)
        expect(idx).not.toBe(cur)
      })
    )
  })

  it('fast-check: order always advances by one modulo count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), fc.nat({ max: 29 }), (count, curRaw) => {
        const cur = curRaw % count
        expect(nextIndex(count, cur, 'order')).toBe((cur + 1) % count)
      })
    )
  })
})

describe('FAILURE_THRESHOLD', () => {
  it('matches the existing store failure cutoff', () => {
    expect(FAILURE_THRESHOLD).toBe(3)
  })
})
