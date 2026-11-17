import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { StateStore, runQuitFlush } from '../src/main/state-store'
import type { PersistedState, Track } from '../src/shared/types'

/**
 * 退出/生命周期测试：直接测 runQuitFlush 真实行为与 StateStore 在退出场景的语义，
 * 不复制 index.ts 的 before-quit 编排逻辑（编排的正确性由代码审查 + 真实运行保证）。
 *
 * 重点验证：
 * - savePlayback + 全量 setPlayerState 在退出 flush 后保留 queue 与最后进度。
 * - runQuitFlush 的「先 ack 后 flush」顺序、超时、错误、ack 参数。
 * - StateStore.flushState 在 in-flight 期间不提前 resolve（真实异步）。
 */

function makeTrack(id: string): Track {
  return { id, bvid: 'BV1', page: 1, title: id, cover: 'c', owner: 'o', duration: 10 }
}
function makePersisted(ids: string[], index: number, volume = 0.5): PersistedState {
  return { queue: ids.map(makeTrack), currentIndex: index, volume, mode: 'order' }
}

describe('退出场景：savePlayback + 全量 setPlayerState 协同 flush', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quit-coop-'))
    file = join(dir, 'state.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('setPlayerState 建 queue → 多次 savePlayback 进度 → flush 保留 queue 与最后进度', async () => {
    const store = new StateStore(file, { debounceMs: 30 })
    store.setPlayerState(makePersisted(['q1', 'q2', 'q3'], 0, 0.2))
    store.savePlayback({ currentIndex: 1, volume: 0.4, mode: 'single' })
    store.savePlayback({ currentIndex: 2, volume: 0.6, mode: 'shuffle', currentTime: 12 })
    store.savePlayback({ currentIndex: 2, volume: 0.6, mode: 'shuffle', currentTime: 99 })

    await store.flushState()
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk.player.queue.map((t: Track) => t.id)).toEqual(['q1', 'q2', 'q3'])
    expect(onDisk.player.currentIndex).toBe(2)
    expect(onDisk.player.volume).toBe(0.6)
    expect(onDisk.player.mode).toBe('shuffle')
    expect(onDisk.player.currentTime).toBe(99)
  })

  it('savePlayback 不遍历 queue 条目（只替换标量，不拷贝/不读取 tracks）', async () => {
    const store = new StateStore(file, { debounceMs: 0 })
    const accesses: string[] = []
    // 用 Proxy 记录对 queue 中每个 track 字段的读取。
    const tracks = [makeTrack('a'), makeTrack('b')]
    const proxiedTracks = tracks.map((t, i) =>
      new Proxy(t, {
        get(target, key): any {
          accesses.push(`track${i}.${String(key)}`)
          return Reflect.get(target, key)
        }
      })
    )
    store.setPlayerState({
      queue: proxiedTracks as unknown as Track[],
      currentIndex: 0,
      volume: 0.2,
      mode: 'order'
    })
    accesses.length = 0
    store.savePlayback({ currentIndex: 1, volume: 0.5, mode: 'shuffle' })
    // savePlayback 只应替换标量，不应遍历或读取 queue 中任何 track 的字段。
    expect(accesses).toEqual([])
    // 内容仍保留：queue 还是那两条。
    expect(store.getPlayerState()?.queue.map((t) => t.id)).toEqual(['a', 'b'])
    expect(store.getPlayerState()?.currentIndex).toBe(1)
    await store.flushState()
  })
})

describe('runQuitFlush: 先 ack 后 flush 顺序与超时', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runquit-'))
    file = join(dir, 'state.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('先 ack 后 flush：startFlush 在 ack 完成后才被调用', async () => {
    const order: string[] = []
    await runQuitFlush(
      () => {
        order.push('flush')
        return Promise.resolve()
      },
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

  it('ack 到达后启动主进程 flush，等待真实落盘完成', async () => {
    const store = new StateStore(file, { debounceMs: 30 })
    store.setPlayerState(makePersisted(['real'], 0))
    let flushStarted = false
    await runQuitFlush(
      () => {
        flushStarted = true
        return store.flushState()
      },
      {
        onAck: () => Promise.resolve(true)
      },
      2000
    )
    expect(flushStarted).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk.player.queue[0].id).toBe('real')
  })

  it('ack 永不返回时受 timeout 上限，startFlush 仍被调用且 ack=false', async () => {
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

  it('onAck 抛错走 onError，仍放行到 startFlush（ack=false）', async () => {
    let errCalled = false
    let flushCalled = false
    let ackArg: boolean | null = null
    await runQuitFlush(
      (acked) => {
        ackArg = acked
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
    expect(ackArg).toBe(false)
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
    expect(Date.now() - start).toBeLessThan(250)
    expect(flushCalled).toBe(true)
  })

  it('startFlush 比 timeout 慢时被截断，不无限等待', async () => {
    const start = Date.now()
    await runQuitFlush(
      () => new Promise<void>(() => undefined), // 永不 resolve
      { onAck: () => Promise.resolve(true) },
      120
    )
    expect(Date.now() - start).toBeLessThan(500)
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

describe('StateStore.flushState: 真实异步 in-flight 不提前 resolve', () => {
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
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk.player.queue[0].id).toBe('b')
    expect(onDisk.player.currentIndex).toBe(1)
  })

  it('flushState resolve 后磁盘内容已是最后版本（不提前）', async () => {
    const store = new StateStore(file, { debounceMs: 0 })
    store.setPlayerState(makePersisted(['first'], 0))
    store.setPlayerState(makePersisted(['second'], 1))
    store.setPlayerState(makePersisted(['third'], 2))
    const flushP = store.flushState()
    await flushP
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk.player.queue[0].id).toBe('third')
    expect(onDisk.player.currentIndex).toBe(2)
  })
})
