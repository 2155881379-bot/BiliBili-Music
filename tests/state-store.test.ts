import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { StateStore, runQuitFlush } from '../src/main/state-store'
import type { PersistedState, PlaybackState, Track } from '../src/shared/types'

// 测试用 track 生成器：保证字段类型合法。
const track = fc.record({
  id: fc.string({ minLength: 1 }).map((s) => `t-${s}`),
  bvid: fc.string({ minLength: 1 }).map((s) => `bv-${s}`),
  page: fc.integer({ min: 1, max: 20 }),
  title: fc.string({ minLength: 1 }),
  cover: fc.string({ minLength: 1 }),
  owner: fc.string({ minLength: 1 }),
  duration: fc.integer({ min: 0, max: 10000 })
})

const playback = fc.record({
  currentIndex: fc.integer({ min: 0, max: 100 }),
  volume: fc.float({ min: 0, max: 1, noNaN: true }),
  mode: fc.constantFrom('order', 'single', 'shuffle'),
  currentTime: fc.oneof(fc.integer({ min: 0, max: 1000 }), fc.constant(undefined))
})

function makeTrack(id: string): Track {
  return {
    id,
    bvid: 'BV1xx',
    page: 1,
    title: id,
    cover: 'c',
    owner: 'o',
    duration: 10
  }
}

function makePersisted(queueIds: string[], index: number, volume = 0.5): PersistedState {
  return { queue: queueIds.map(makeTrack), currentIndex: index, volume, mode: 'order' }
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'state-store-'))
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('StateStore: coalescing', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = freshDir()
    file = join(dir, 'state.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('同一 debounce 窗口内的多次写入只落盘最后一次', async () => {
    const store = new StateStore(file, { debounceMs: 50 })
    store.setPlayerState(makePersisted(['a'], 0, 0.1))
    store.setPlayerState(makePersisted(['b'], 1, 0.2))
    store.setPlayerState(makePersisted(['c'], 2, 0.3))
    await store.flushState()

    const onDisk = readJson(file)
    expect(onDisk.player.queue.map((t: Track) => t.id)).toEqual(['c'])
    expect(onDisk.player.currentIndex).toBe(2)
    expect(onDisk.player.volume).toBe(0.3)
  })

  it('debounce=0 时每次写入都入队（仍串行，最终全部落盘为最后一版本）', async () => {
    const store = new StateStore(file, { debounceMs: 0 })
    store.setPlayerState(makePersisted(['a'], 0))
    store.setPlayerState(makePersisted(['b'], 1))
    await store.flushState()
    const onDisk = readJson(file)
    expect(onDisk.player.queue.map((t: Track) => t.id)).toEqual(['b'])
  })
})

describe('StateStore: in-flight 更新不丢', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = freshDir()
    file = join(dir, 'state.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('写盘进行中发起的更新会在当前版本后继续落盘', async () => {
    const store = new StateStore(file, { debounceMs: 0 })
    store.setPlayerState(makePersisted(['a'], 0))
    // 不等第一次完成，立刻发第二次：必须保证 b 最终落盘。
    store.setPlayerState(makePersisted(['b'], 1))
    await store.flushState()
    const onDisk = readJson(file)
    expect(onDisk.player.queue.map((t: Track) => t.id)).toEqual(['b'])
  })

  it('连续 N 次快写后 flush 只保留最后版本', async () => {
    const store = new StateStore(file, { debounceMs: 20 })
    for (let i = 0; i < 20; i++) {
      store.setPlayerState(makePersisted([`t${i}`], i))
    }
    await store.flushState()
    const onDisk = readJson(file)
    expect(onDisk.player.queue.map((t: Track) => t.id)).toEqual(['t19'])
    expect(onDisk.player.currentIndex).toBe(19)
  })
})

describe('StateStore: flush 退出', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = freshDir()
    file = join(dir, 'state.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('flushState 等到最后一版落盘后才 resolve', async () => {
    const store = new StateStore(file, { debounceMs: 100 })
    store.setPlayerState(makePersisted(['a'], 0))
    await store.flushState()
    expect(() => statSync(file)).not.toThrow()
    expect(readJson(file).player.queue[0].id).toBe('a')
  })

  it('无 pending 时 flushState 立即 resolve', async () => {
    const store = new StateStore(file, { debounceMs: 50 })
    await expect(store.flushState()).resolves.toBeUndefined()
  })

  it('tmp 文件被 rename 成正式文件，不残留', async () => {
    const store = new StateStore(file, { debounceMs: 10 })
    store.setPlayerState(makePersisted(['a'], 0))
    await store.flushState()
    expect(() => statSync(`${file}.tmp`)).toThrow()
    expect(() => statSync(file)).not.toThrow()
  })
})

describe('StateStore: legacy 恢复', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = freshDir()
    file = join(dir, 'state.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('恢复早期裸 PersistedState（只有 queue，无 player/folders/likes）', () => {
    writeFileSync(
      file,
      JSON.stringify({ queue: [makeTrack('legacy')], currentIndex: 0, volume: 0.2, mode: 'order' }),
      'utf-8'
    )
    const store = new StateStore(file)
    expect(store.getPlayerState()?.queue.map((t) => t.id)).toEqual(['legacy'])
    expect(store.listFolders()).toEqual([])
    expect(store.listLikes()).toEqual([])
  })

  it('恢复新版 shape { player, folders, likes }', () => {
    writeFileSync(
      file,
      JSON.stringify({
        player: { queue: [makeTrack('p')], currentIndex: 1, volume: 0.7, mode: 'shuffle' },
        folders: [
          {
            id: 'fid',
            title: 'f',
            cover: 'c',
            updatedAt: 1,
            tracks: [makeTrack('ft')]
          }
        ],
        likes: [makeTrack('lk')]
      }),
      'utf-8'
    )
    const store = new StateStore(file)
    expect(store.getPlayerState()?.mode).toBe('shuffle')
    expect(store.listFolders().map((f) => f.id)).toEqual(['fid'])
    expect(store.listLikes().map((t) => t.id)).toEqual(['lk'])
  })

  it('损坏的 JSON 退回空状态，不抛出', () => {
    writeFileSync(file, '{ not valid json }}}', 'utf-8')
    const store = new StateStore(file)
    expect(store.getPlayerState()).toBeNull()
    expect(store.listFolders()).toEqual([])
    expect(store.listLikes()).toEqual([])
  })

  it('文件不存在时退回空状态', () => {
    const store = new StateStore(join(dir, 'nope.json'))
    expect(store.getPlayerState()).toBeNull()
  })

  it('player.queue 不是数组时忽略 player', () => {
    writeFileSync(file, JSON.stringify({ player: { queue: 'oops', currentIndex: 0 }, folders: [], likes: [] }), 'utf-8')
    const store = new StateStore(file)
    expect(store.getPlayerState()).toBeNull()
  })

  it('容忍残留 .tmp 文件（不影响读取，下次 rename 覆盖）', async () => {
    writeFileSync(`${file}.tmp`, 'garbage', 'utf-8')
    writeFileSync(file, JSON.stringify({ player: { queue: [makeTrack('a')], currentIndex: 0, volume: 0.1, mode: 'order' }, folders: [], likes: [] }), 'utf-8')
    const store = new StateStore(file)
    expect(store.getPlayerState()?.queue.map((t) => t.id)).toEqual(['a'])
    store.setPlayerState(makePersisted(['b'], 1))
    await store.flushState()
    expect(readJson(file).player.queue[0].id).toBe('b')
  })
})

describe('StateStore: write failure 恢复', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = freshDir()
    file = join(dir, 'state.json')
  })
  afterEach(() => {
    // Windows 上 chmod 不一定生效，但目录会被整体删除。
    rmSync(dir, { recursive: true, force: true })
  })

  it('写失败不外泄 reject，flushState 仍 resolve，dirty 置位待下次重试', async () => {
    // 指向一个不存在的上级目录，rename 会失败。
    const badFile = join(dir, 'missing-sub', 'state.json')
    const store = new StateStore(badFile, { maxRetries: 1, retryDelayMs: 5 })
    store.setPlayerState(makePersisted(['a'], 0))
    // 不应抛出未处理 rejection。
    await expect(store.flushState()).resolves.toBeUndefined()
  })

  it('写失败后目录恢复，再次 flush 能落盘', async () => {
    // 先让写入失败（只读目录）。
    const readonlyDir = join(dir, 'ro')
    const roFile = join(readonlyDir, 'state.json')
    const store = new StateStore(roFile, { maxRetries: 0, retryDelayMs: 1 })
    store.setPlayerState(makePersisted(['a'], 0))
    await store.flushState()

    // 恢复可写：换一个正常目录（新 store 实例重新加载空状态）。
    const store2 = new StateStore(file, { maxRetries: 0, retryDelayMs: 1 })
    store2.setPlayerState(makePersisted(['recovered'], 0))
    await store2.flushState()
    expect(readJson(file).player.queue[0].id).toBe('recovered')
  })
})

describe('StateStore: savePlayback 不丢 queue', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = freshDir()
    file = join(dir, 'state.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('savePlayback 只更新标量，queue 保持不变', async () => {
    const store = new StateStore(file, { debounceMs: 10 })
    // 先全量设置一个有 queue 的 player。
    store.setPlayerState(makePersisted(['a', 'b', 'c'], 0, 0.3))
    await store.flushState()

    // 再用进度补丁更新，不动 queue。
    const patch: PlaybackState = { currentIndex: 2, volume: 0.9, mode: 'single', currentTime: 42 }
    store.savePlayback(patch)
    await store.flushState()

    const onDisk = readJson(file)
    expect(onDisk.player.queue.map((t: Track) => t.id)).toEqual(['a', 'b', 'c'])
    expect(onDisk.player.currentIndex).toBe(2)
    expect(onDisk.player.volume).toBe(0.9)
    expect(onDisk.player.mode).toBe('single')
    expect(onDisk.player.currentTime).toBe(42)
  })

  it('无 player 时 savePlayback 用空 queue 建档', async () => {
    const store = new StateStore(file, { debounceMs: 10 })
    store.savePlayback({ currentIndex: 0, volume: 0.5, mode: 'order' })
    await store.flushState()
    const onDisk = readJson(file)
    expect(onDisk.player.queue).toEqual([])
    expect(onDisk.player.volume).toBe(0.5)
  })

  it('savePlayback 后再 setPlayerState 全量仍生效（两接口共存）', async () => {
    const store = new StateStore(file, { debounceMs: 10 })
    store.setPlayerState(makePersisted(['x', 'y'], 0))
    store.savePlayback({ currentIndex: 1, volume: 0.5, mode: 'shuffle' })
    store.setPlayerState(makePersisted(['z'], 0))
    await store.flushState()
    const onDisk = readJson(file)
    expect(onDisk.player.queue.map((t: Track) => t.id)).toEqual(['z'])
  })

  it('savePlayback 不改 folders / likes', async () => {
    const store = new StateStore(file, { debounceMs: 10 })
    store.setPlayerState(makePersisted(['a'], 0))
    store.upsertFolder({ id: 'f1', title: 'F', cover: 'c', updatedAt: 1, tracks: [makeTrack('ft')] })
    store.saveLikes([makeTrack('lk')])
    store.savePlayback({ currentIndex: 3, volume: 0.1, mode: 'order' })
    await store.flushState()
    const onDisk = readJson(file)
    expect(onDisk.folders.map((f: any) => f.id)).toEqual(['f1'])
    expect(onDisk.likes.map((t: Track) => t.id)).toEqual(['lk'])
    expect(onDisk.player.currentIndex).toBe(3)
  })

  it('属性：savePlayback 任意 patch 后 queue 恒等于 setPlayerState 设置的 queue', async () => {
    await fc.assert(
      fc.asyncProperty(track, fc.array(track, { maxLength: 5 }), playback, async (t, queue, patch) => {
        const d = mkdtempSync(join(tmpdir(), 'prop-'))
        const f = join(d, 'state.json')
        try {
          const store = new StateStore(f, { debounceMs: 0 })
          const persisted: PersistedState = {
            queue: [...queue, t],
            currentIndex: 0,
            volume: 0.3,
            mode: 'order'
          }
          store.setPlayerState(persisted)
          await store.flushState()
          store.savePlayback(patch)
          await store.flushState()
          const onDisk = readJson(f)
          expect(onDisk.player.queue.map((x: Track) => x.id)).toEqual([...queue, t].map((x) => x.id))
          expect(onDisk.player.currentIndex).toBe(patch.currentIndex)
          expect(onDisk.player.volume).toBe(patch.volume)
          expect(onDisk.player.mode).toBe(patch.mode)
        } finally {
          rmSync(d, { recursive: true, force: true })
        }
      }),
      { numRuns: 30 }
    )
  })
})

describe('StateStore: 原子性（tmp + rename）', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = freshDir()
    file = join(dir, 'state.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('落盘后正式文件是完整 JSON，tmp 不残留', async () => {
    const store = new StateStore(file, { debounceMs: 10 })
    store.setPlayerState(makePersisted(['a', 'b'], 1, 0.5))
    await store.flushState()
    // 正式文件可正常解析。
    expect(() => readJson(file)).not.toThrow()
    // tmp 不残留。
    expect(() => statSync(`${file}.tmp`)).toThrow()
  })
})

describe('runQuitFlush', () => {
  it('先 ack 后 flush：startFlush 在 ack 完成后才被调用', async () => {
    const order: string[] = []
    await runQuitFlush(
      (_acked) =>
        new Promise<void>((resolve) => {
          order.push('flush')
          resolve()
        }),
      {
        notifyRenderer: () => {
          order.push('notify')
        },
        onAck: () =>
          new Promise<boolean>((resolve) => {
            setTimeout(() => {
              order.push('ack')
              resolve(true)
            }, 10)
          })
      },
      2000
    )
    expect(order).toEqual(['notify', 'ack', 'flush'])
  })

  it('ack 永不返回时受 timeout 上限，startFlush 仍会被调用（ack=false）', async () => {
    const start = Date.now()
    let flushCalled = false
    let ackArg: boolean | null = null
    await runQuitFlush(
      (acked) => {
        ackArg = acked
        flushCalled = true
        return Promise.resolve()
      },
      {
        onAck: () => new Promise<boolean>(() => undefined) // 永不 ack
      },
      150
    )
    expect(Date.now() - start).toBeLessThan(400)
    expect(flushCalled).toBe(true)
    expect(ackArg).toBe(false)
  })

  it('onAck 抛错走 onError，仍放行到 startFlush', async () => {
    let errCalled = false
    let flushCalled = false
    await runQuitFlush(
      () => {
        flushCalled = true
        return Promise.resolve()
      },
      {
        onAck: () => Promise.reject(new Error('ack boom')),
        onError: () => {
          errCalled = true
        }
      },
      500
    )
    expect(errCalled).toBe(true)
    expect(flushCalled).toBe(true)
  })

  it('无 onAck 时直接调用 startFlush（受 timeout 上限）', async () => {
    let flushCalled = false
    const start = Date.now()
    await runQuitFlush(
      () => {
        flushCalled = true
        return new Promise<void>((resolve) => setTimeout(resolve, 20))
      },
      {},
      1000
    )
    expect(Date.now() - start).toBeLessThan(200)
    expect(flushCalled).toBe(true)
  })

  it('startFlush 比 timeout 慢时被截断，不无限等待', async () => {
    const start = Date.now()
    await runQuitFlush(
      () => new Promise<void>(() => undefined), // 永不 resolve
      { onAck: () => Promise.resolve(true) },
      120
    )
    expect(Date.now() - start).toBeLessThan(400)
  })

  it('startFlush 抛错走 onError，不阻断退出', async () => {
    let errCalled = false
    await runQuitFlush(
      () => Promise.reject(new Error('flush boom')),
      {
        onError: () => {
          errCalled = true
        }
      },
      500
    )
    expect(errCalled).toBe(true)
  })
})

describe('StateStore: flush 不过早 resolve（真实异步 in-flight 证明）', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inflight-'))
    file = join(dir, 'state.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('flush 期间到来的更新必须落盘后 flush 才 resolve', async () => {
    const store = new StateStore(file, { debounceMs: 0 })
    store.setPlayerState(makePersisted(['a'], 0))
    // 不等第一次，立即在 in-flight 期间第二次写入。
    store.setPlayerState(makePersisted(['b'], 1))
    await store.flushState()
    // 此时落盘的必须是最后一次内容，且 flush 没有在 b 落盘前就 resolve。
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk.player.queue[0].id).toBe('b')
    expect(onDisk.player.currentIndex).toBe(1)
  })

  it('flushState 返回的 promise resolve 后磁盘内容已是最后版本（不提前）', async () => {
    const store = new StateStore(file, { debounceMs: 0 })
    store.setPlayerState(makePersisted(['first'], 0))
    store.setPlayerState(makePersisted(['second'], 1))
    store.setPlayerState(makePersisted(['third'], 2))
    const flushP = store.flushState()
    // flush resolve 后立即读盘，内容必须已是 third。
    await flushP
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk.player.queue[0].id).toBe('third')
    expect(onDisk.player.currentIndex).toBe(2)
  })
})
