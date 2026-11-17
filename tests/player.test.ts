import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

type Listener = (e: unknown) => void

class FakeAudio {
  src = ''
  volume = 1
  currentTime = 0
  duration = 0
  readyState = 0
  preload = 'auto'
  paused = true
  private listeners: Record<string, Listener[]> = {}

  addEventListener(type: string, fn: Listener): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn)
  }
  emit(type: string, e?: unknown): void {
    ;(this.listeners[type] ?? []).forEach((fn) => fn(e ?? {}))
  }
  async play(): Promise<void> {
    this.paused = false
    this.readyState = 1
  }
  pause(): void {
    this.paused = true
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }
  load(): void {
    // no-op
  }
}

interface FakeAudioCtor {
  new (): FakeAudio
  last: FakeAudio
}

interface ApiMock {
  video: ReturnType<typeof vi.fn>
  audio: ReturnType<typeof vi.fn>
  saveState: ReturnType<typeof vi.fn>
  savePlayback: ReturnType<typeof vi.fn>
  onBeforeQuit: ReturnType<typeof vi.fn>
  ackQuit: ReturnType<typeof vi.fn>
  loadState: ReturnType<typeof vi.fn>
  onCommand: ReturnType<typeof vi.fn>
}

interface SetupResult {
  player: Awaited<ReturnType<typeof import('../src/renderer/src/stores/player')['usePlayerStore']>>
  api: ApiMock
  audioEl: FakeAudio
}

async function setup(loadState: unknown = null): Promise<SetupResult> {
  // 每个测试都重置模块：player.ts 顶层 `const audio = new Audio()` 会重建，
  // 避免上一轮注册的 loadedmetadata 回调残留并串扰本轮。
  vi.resetModules()

  const Ctor = function FakeAudioCtor(this: FakeAudio): FakeAudio {
    const inst = new FakeAudio()
    ;(Ctor as FakeAudioCtor).last = inst
    return inst
  } as unknown as FakeAudioCtor
  vi.stubGlobal('Audio', Ctor as unknown as typeof Audio)

  const api: ApiMock = {
    video: vi.fn(),
    audio: vi.fn(),
    saveState: vi.fn(),
    savePlayback: vi.fn(),
    onBeforeQuit: vi.fn(),
    ackQuit: vi.fn(),
    loadState: vi.fn().mockResolvedValue(loadState),
    onCommand: vi.fn()
  }
  vi.stubGlobal('window', { api })

  const ms = {
    metadata: null,
    setActionHandler: vi.fn(),
    setPositionState: vi.fn()
  }
  const nav =
    (globalThis as { navigator?: Record<string, unknown> }).navigator ?? {}
  try {
    Object.defineProperty(nav, 'mediaSession', {
      value: ms,
      writable: true,
      configurable: true,
      enumerable: true
    })
    vi.stubGlobal('navigator', nav)
  } catch {
    vi.stubGlobal('navigator', { ...nav, mediaSession: ms })
  }
  vi.stubGlobal(
    'MediaMetadata',
    class {
      init: unknown
      constructor(init: unknown) {
        this.init = init
      }
    }
  )

  setActivePinia(createPinia())
  const { usePlayerStore } = await import('../src/renderer/src/stores/player')
  const player = usePlayerStore()
  return { player, api, audioEl: Ctor.last }
}

import type { Track } from '../src/shared/types'

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

function fakeAudioStream(url = 'https://example.com/a.m4a'): {
  url: string
  backups: string[]
} {
  return { url, backups: ['https://example.com/b1.m4a', 'https://example.com/b2.m4a'] }
}

function fakeVideoInfo(pages = 1): {
  bvid: string
  title: string
  cover: string
  duration: number
  owner: string
  pages: Array<{ cid: number; page: number; part: string; duration: number }>
} {
  const list = Array.from({ length: pages }, (_, i) => ({
    cid: 1000 + i,
    page: i + 1,
    part: `P${i + 1}`,
    duration: 60
  }))
  return { bvid: 'BV1xxx', title: '合集', cover: 'c.jpg', duration: 600, owner: 'up', pages: list }
}

describe('queue identity', () => {
  it('append creates independent entries with stable queueIds', async () => {
    const { player } = await setup()
    player.append([track({ id: 'a' }), track({ id: 'b' })])
    expect(player.queue).toHaveLength(2)
    const ids = player.queue.map((t) => t.queueId)
    expect(new Set(ids).size).toBe(2)
    expect(player.queue.every((t) => t.queueId.length > 0)).toBe(true)
  })

  it('allows the same track object to be enqueued multiple times', async () => {
    const { player } = await setup()
    const t = track({ id: 'a' })
    player.append([t, t, t])
    expect(player.queue).toHaveLength(3)
    expect(new Set(player.queue.map((e) => e.queueId)).size).toBe(3)
  })

  it('playNext inserts an independent copy after current', async () => {
    const { player } = await setup()
    player.replaceQueue([track({ id: 'a' }), track({ id: 'b' })])
    const original = player.queue[0]
    player.playNext(track({ id: 'a' }))
    expect(player.queue).toHaveLength(3)
    expect(player.queue[1].queueId).not.toBe(original.queueId)
  })
})

describe('move keeps the currently playing track', () => {
  it('current stays on the same song after dragging it to a new position', async () => {
    const { player, api } = await setup()
    api.video.mockResolvedValue(fakeVideoInfo(1))
    api.audio.mockResolvedValue(fakeAudioStream())
    player.replaceQueue([
      track({ id: 'a' }),
      track({ id: 'b' }),
      track({ id: 'c' }),
      track({ id: 'd' })
    ])
    await player.playAt(0)
    const before = player.queue[0]
    expect(player.current?.queueId).toBe(before.queueId)
    player.move(0, 2)
    expect(player.queue[0].id).toBe('b')
    expect(player.queue[2].id).toBe('a')
    expect(player.current?.queueId).toBe(before.queueId)
  })

  it('current stays when moving the current track itself', async () => {
    const { player, api } = await setup()
    api.video.mockResolvedValue(fakeVideoInfo(1))
    api.audio.mockResolvedValue(fakeAudioStream())
    player.replaceQueue([track({ id: 'a' }), track({ id: 'b' }), track({ id: 'c' })])
    await player.playAt(1)
    const playingId = player.current?.queueId
    player.move(1, 2)
    expect(player.current?.queueId).toBe(playingId)
    expect(player.currentIndex).toBe(2)
  })

  it('move with duplicate songs keeps current via queueId not index', async () => {
    const { player, api } = await setup()
    api.video.mockResolvedValue(fakeVideoInfo(1))
    api.audio.mockResolvedValue(fakeAudioStream())
    player.append([track({ id: 'a' }), track({ id: 'a' }), track({ id: 'a' })])
    await player.playAt(1)
    const playingId = player.current?.queueId
    player.move(0, 2)
    expect(player.current?.queueId).toBe(playingId)
  })
})

describe('removeAt adjusts index without losing current', () => {
  it('removing an earlier track decrements currentIndex', async () => {
    const { player, api } = await setup()
    api.video.mockResolvedValue(fakeVideoInfo(1))
    api.audio.mockResolvedValue(fakeAudioStream())
    player.replaceQueue([track({ id: 'a' }), track({ id: 'b' }), track({ id: 'c' })])
    await player.playAt(2)
    const playingId = player.current?.queueId
    player.removeAt(0)
    expect(player.current?.queueId).toBe(playingId)
    expect(player.currentIndex).toBe(1)
  })

  it('removing the current track advances to next', async () => {
    const { player, api } = await setup()
    api.video.mockResolvedValue(fakeVideoInfo(1))
    api.audio.mockResolvedValue(fakeAudioStream())
    player.replaceQueue([track({ id: 'a' }), track({ id: 'b' }), track({ id: 'c' })])
    await player.playAt(1)
    player.removeAt(1)
    expect(player.queue).toHaveLength(2)
    expect(player.currentIndex).toBe(1)
    expect(player.current?.id).toBe('c')
  })
})

describe('restore from persisted state', () => {
  it('hydrates plain Track[] by adding queueIds', async () => {
    const { player, api } = await setup({
      queue: [track({ id: 'a' }), track({ id: 'b' })],
      currentIndex: 1,
      volume: 0.5,
      mode: 'order',
      currentTime: 10
    })
    api.video.mockResolvedValue(fakeVideoInfo(1))
    api.audio.mockResolvedValue(fakeAudioStream())
    await player.init()
    expect(player.queue).toHaveLength(2)
    expect(player.queue.every((t) => t.queueId.length > 0)).toBe(true)
    expect(new Set(player.queue.map((t) => t.queueId)).size).toBe(2)
    expect(player.current?.id).toBe('b')
    expect(player.volume).toBe(0.5)
  })
})

describe('async out-of-order loading', () => {
  it('a late-resolving loadTrack does not overwrite a newer selection', async () => {
    const { player, api } = await setup()
    let resolveFirst!: (v: unknown) => void
    api.video.mockImplementation((bvid: string) => {
      if (bvid === 'BV1xxx') {
        return new Promise((r) => {
          resolveFirst = r as (v: unknown) => void
        })
      }
      return Promise.resolve({ ...fakeVideoInfo(1), bvid })
    })
    api.audio.mockResolvedValue(fakeAudioStream())
    player.append([
      track({ id: 'a', bvid: 'BV1xxx' }),
      track({ id: 'b', bvid: 'BV2yyy' })
    ])
    void player.playAt(0)
    await vi.waitFor(() => expect(resolveFirst).toBeDefined())
    await player.playAt(1)
    expect(player.current?.id).toBe('b')
    resolveFirst(fakeVideoInfo(1))
    await Promise.resolve()
    await Promise.resolve()
    expect(player.current?.id).toBe('b')
  })

  it('late audio() resolution after a switch does not steal playback', async () => {
    const { player, api } = await setup()
    let resolveFirstAudio!: (v: unknown) => void
    api.video.mockResolvedValue(fakeVideoInfo(1))
    api.audio.mockImplementation((bvid: string) => {
      if (bvid === 'BV1xxx') {
        return new Promise((r) => {
          resolveFirstAudio = r as (v: unknown) => void
        })
      }
      return Promise.resolve(fakeAudioStream('https://example.com/b.m4a'))
    })
    player.append([
      track({ id: 'a', bvid: 'BV1xxx' }),
      track({ id: 'b', bvid: 'BV2yyy' })
    ])
    void player.playAt(0)
    await vi.waitFor(() => expect(resolveFirstAudio).toBeDefined())
    await player.playAt(1)
    expect(player.current?.id).toBe('b')
    resolveFirstAudio(fakeAudioStream('https://example.com/a.m4a'))
    await Promise.resolve()
    await Promise.resolve()
    expect(player.current?.id).toBe('b')
  })
})

describe('multi-page expansion', () => {
  it('expands a multi-P track, loads audio for the first page, keeps current on it', async () => {
    const { player, api } = await setup()
    api.video.mockResolvedValue(fakeVideoInfo(3))
    api.audio.mockResolvedValue(fakeAudioStream())
    player.append([track({ id: 'BV1xxx-1', bvid: 'BV1xxx', cid: undefined })])
    await player.playAt(0)
    expect(player.queue).toHaveLength(3)
    expect(player.queue.map((t) => t.id)).toEqual(['BV1xxx-1', 'BV1xxx-2', 'BV1xxx-3'])
    expect(new Set(player.queue.map((t) => t.queueId)).size).toBe(3)
    expect(player.current?.queueId).toBe(player.queue[0].queueId)
    expect(player.current?.cid).toBe(1000)
    expect(api.audio).toHaveBeenCalledWith('BV1xxx', 1000)
    expect(api.audio).toHaveBeenCalledTimes(1)
  })

  it('expanded entries are independent copies of the source', async () => {
    const { player, api } = await setup()
    api.video.mockResolvedValue(fakeVideoInfo(2))
    api.audio.mockResolvedValue(fakeAudioStream())
    const src = track({ id: 'BV1xxx-1', bvid: 'BV1xxx', cid: undefined })
    player.append([src])
    await player.playAt(0)
    expect(src.cid).toBeUndefined()
  })
})

describe('seekWhenReady resume path', () => {
  it('restores resume position once metadata is ready for the loaded track', async () => {
    const { player, api, audioEl } = await setup({
      queue: [track({ id: 'a' })],
      currentIndex: 0,
      volume: 0.8,
      mode: 'order',
      currentTime: 42
    })
    api.video.mockResolvedValue(fakeVideoInfo(1))
    api.audio.mockResolvedValue(fakeAudioStream())
    audioEl.readyState = 0
    await player.init()
    audioEl.emit('loadedmetadata')
    expect(audioEl.currentTime).toBe(42)
  })

  it('does not apply the stale resume seek when a different track was selected during init', async () => {
    const { player, api, audioEl } = await setup({
      queue: [track({ id: 'a', bvid: 'BV1xxx' }), track({ id: 'b', bvid: 'BV2yyy' })],
      currentIndex: 0,
      volume: 0.8,
      mode: 'order',
      currentTime: 42
    })
    let resolveInitAudio!: (v: unknown) => void
    api.video.mockResolvedValue(fakeVideoInfo(1))
    api.audio.mockImplementation((bvid: string) => {
      if (bvid === 'BV1xxx') {
        return new Promise((r) => {
          resolveInitAudio = r as (v: unknown) => void
        })
      }
      return Promise.resolve(fakeAudioStream('https://example.com/b.m4a'))
    })
    audioEl.readyState = 0
    const initP = player.init()
    await vi.waitFor(() => expect(resolveInitAudio).toBeDefined())
    await player.playAt(1)
    expect(player.current?.id).toBe('b')
    resolveInitAudio(fakeAudioStream('https://example.com/a.m4a'))
    await initP
    await Promise.resolve()
    audioEl.emit('loadedmetadata')
    expect(player.current?.id).toBe('b')
    expect(audioEl.currentTime).not.toBe(42)
  })
})

describe('removeAt/clear cancel in-flight loads', () => {
  it('removeAt(current) cancels a pending audio() so the deleted track never plays', async () => {
    const { player, api } = await setup()
    api.video.mockResolvedValue(fakeVideoInfo(1))
    let resolveAudio!: (v: unknown) => void
    api.audio.mockReturnValue(
      new Promise((r) => {
        resolveAudio = r as (v: unknown) => void
      })
    )
    player.append([track({ id: 'a' }), track({ id: 'b' })])
    void player.playAt(0)
    await vi.waitFor(() => expect(resolveAudio).toBeDefined())
    player.removeAt(0)
    resolveAudio(fakeAudioStream('https://example.com/a.m4a'))
    await Promise.resolve()
    await Promise.resolve()
    expect(player.queue.map((t) => t.id)).toEqual(['b'])
    expect(player.current?.id).not.toBe('a')
  })

  it('clear cancels pending audio() so no deleted track plays after clearing', async () => {
    const { player, api, audioEl } = await setup()
    api.video.mockResolvedValue(fakeVideoInfo(1))
    let resolveAudio!: (v: unknown) => void
    api.audio.mockReturnValue(
      new Promise((r) => {
        resolveAudio = r as (v: unknown) => void
      })
    )
    player.append([track({ id: 'a' }), track({ id: 'b' })])
    void player.playAt(0)
    await vi.waitFor(() => expect(resolveAudio).toBeDefined())
    player.clear()
    resolveAudio(fakeAudioStream('https://example.com/a.m4a'))
    await Promise.resolve()
    await Promise.resolve()
    expect(player.queue).toHaveLength(0)
    expect(player.currentIndex).toBe(-1)
    expect(audioEl.src).not.toBe('https://example.com/a.m4a')
  })
})

describe('saveState structure stays compatible', () => {
  it('persists queue as plain objects (Track[] shape, queueId tolerated) via public actions', async () => {
    const { player, api } = await setup()
    api.video.mockResolvedValue(fakeVideoInfo(1))
    api.audio.mockResolvedValue(fakeAudioStream())
    vi.useFakeTimers()
    player.replaceQueue([track({ id: 'a' }), track({ id: 'b' })])
    await player.playAt(0)
    api.saveState.mockClear()
    player.setVolume(0.3)
    await vi.advanceTimersByTimeAsync(600)
    expect(api.saveState).toHaveBeenCalled()
    const payload = api.saveState.mock.calls[api.saveState.mock.calls.length - 1][0]
    expect(payload.queue).toHaveLength(2)
    expect(payload.queue[0]).toMatchObject({ id: 'a', bvid: 'BV1xxx', page: 1 })
    expect(payload.currentIndex).toBe(0)
    expect(payload.volume).toBe(0.3)
    vi.useRealTimers()
  })
})

describe('incremental playback persistence', () => {
  it('time updates and volume changes send scalar patches after the initial queue save', async () => {
    const { player, api, audioEl } = await setup()
    vi.useFakeTimers()
    try {
      player.append([track({ cid: 1 })])
      await vi.advanceTimersByTimeAsync(600)
      expect(api.saveState).toHaveBeenCalledTimes(1)
      api.saveState.mockClear()
      player.setVolume(0.3)
      await nextTick()
      await vi.advanceTimersByTimeAsync(600)
      expect(api.savePlayback).toHaveBeenLastCalledWith(expect.objectContaining({ volume: 0.3 }))
      audioEl.paused = false
      audioEl.currentTime = 24
      audioEl.emit('timeupdate')
      await vi.advanceTimersByTimeAsync(600)
      expect(api.savePlayback).toHaveBeenLastCalledWith(expect.objectContaining({ currentTime: 24 }))
      expect(api.savePlayback.mock.calls.every(([state]) => !('queue' in state))).toBe(true)
      expect(api.saveState).not.toHaveBeenCalled()
    } finally {
      player.$dispose()
      vi.useRealTimers()
    }
  })

  it('quit flushes an unsaved queue before acknowledgement and cleans its timer', async () => {
    const { player, api } = await setup()
    await player.init()
    vi.useFakeTimers()
    try {
      player.append([track({ cid: 1 })])
      const notifyQuit = api.onBeforeQuit.mock.calls[0][0]
      notifyQuit()
      expect(api.saveState).toHaveBeenCalledOnce()
      expect(api.saveState.mock.calls[0][0].queue).toHaveLength(1)
      expect(api.saveState.mock.invocationCallOrder[0]).toBeLessThan(api.ackQuit.mock.invocationCallOrder[0])
      await vi.advanceTimersByTimeAsync(600)
      expect(api.saveState).toHaveBeenCalledOnce()
    } finally {
      player.$dispose()
      vi.useRealTimers()
    }
  })
})

describe('store property: random action sequence keeps current identity', () => {
  // 固定 seed 让序列可复现；30 步操作 × 100 轮覆盖足够多的 move/remove/append 组合。
  it('current.queueId stays stable and queueIds stay unique across random moves/removes/appends', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 8 }), { minLength: 2, maxLength: 8 }),
        fc.array(
          fc.record({
            op: fc.constantFrom('move', 'remove', 'append', 'playNext'),
            a: fc.nat({ max: 20 }),
            b: fc.nat({ max: 20 })
          }),
          { minLength: 5, maxLength: 30 }
        ),
        async (seedCounts, ops) => {
          const { player, api } = await setup()
          api.video.mockResolvedValue(fakeVideoInfo(1))
          api.audio.mockResolvedValue(fakeAudioStream())

          // 用 seedCounts 生成一批互不相同的初始曲目（同 id 也允许，靠 queueId 区分）
          const initial = seedCounts.map((n, i) =>
            track({ id: `s${n}-${i}`, bvid: `BV${n}`, title: `t${n}` })
          )
          player.append(initial)
          await player.playAt(0)
          const playingId = player.current?.queueId
          expect(playingId).toBeTruthy()

          for (const { op, a, b } of ops) {
            const len = player.queue.length
            if (len === 0) break

            // 不变量 A：每一步开始前 queueId 全唯一
            const ids = player.queue.map((t) => t.queueId)
            expect(new Set(ids).size).toBe(ids.length)

            if (op === 'move') {
              const from = a % len
              const to = b % len
              // 只移动非当前条目，避免 move current 后 current 变化引入额外复杂度
              if (from === player.currentIndex) continue
              player.move(from, to)
            } else if (op === 'remove') {
              const idx = a % len
              // 只删非当前条目，保证 current 不被移除
              if (idx === player.currentIndex) continue
              player.removeAt(idx)
            } else if (op === 'append') {
              player.append([track({ id: `app-${a}`, bvid: `BV${a}` })])
            } else {
              // playNext 插到 current 后面，不影响 current 身份
              player.playNext(track({ id: `pn-${a}`, bvid: `BV${a}` }))
            }

            // 不变量 B：非 current 的 move/remove/append/playNext 后，
            // current 的 queueId 必须保持不变（仍是当初 playAt 的那条）
            expect(player.current?.queueId).toBe(playingId)
            // 不变量 C：current 仍能在队列里按 queueId 找到且唯一
            const curMatches = player.queue.filter((t) => t.queueId === playingId)
            expect(curMatches).toHaveLength(1)
            // 不变量 D：currentIndex 指向那条
            expect(player.queue[player.currentIndex]?.queueId).toBe(playingId)
          }
        }
      ),
      { numRuns: 100, seed: 20261117 }
    )
  })
})
