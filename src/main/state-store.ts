import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AppState,
  PlaybackState,
  PersistedState,
  SavedFolder,
  Track
} from '../shared/types'

export interface StateStoreOptions {
  /** debounce 窗口（毫秒），默认 400。设为 0 表示每次都立即入队落盘。 */
  debounceMs?: number
  /** 写盘失败时的重试次数，默认 2。 */
  maxRetries?: number
  /** 每次重试之间的间隔（毫秒），默认 50。 */
  retryDelayMs?: number
}

const DEFAULTS: Required<StateStoreOptions> = {
  debounceMs: 400,
  maxRetries: 2,
  retryDelayMs: 50
}

/**
 * 可测试的异步串行原子写状态存储。
 *
 * 设计要点：
 * - 内存缓存 AppState，读操作不碰盘。
 * - 所有写请求共用一个 drainPromise 串行链：同一 debounce 窗口内的多次更新合并成一次落盘，
 *   但「最后一次」一定落盘（in-flight 更新不丢）。
 * - 写盘用真正的异步 fs/promises：同目录 .tmp + rename 原子替换，半截文件不会被读到。
 * - flushState() 返回的 Promise 在「最后一次更新」真正落盘后 resolve，绝不提前。
 *   写失败会在内部重试，仍失败则把 dirty 置位、记录错误、不让 reject 外泄成未处理。
 */
export class StateStore {
  private readonly filePath: string
  private readonly tmpPath: string
  private readonly opts: Required<StateStoreOptions>

  private cache: AppState
  private cacheLoaded = false

  /** debounce 定时器；存在意味着有一次「待写」尚未触发。 */
  private timer: NodeJS.Timeout | null = null
  /** 串行写链：每次写都 append 到这条 promise 链尾，保证严格串行。 */
  private drainPromise: Promise<void> = Promise.resolve()
  /** 有未成功落盘的内容，需要在下一次写入时重试。 */
  private dirty = false
  private revision = 0

  constructor(filePath: string, options?: StateStoreOptions) {
    this.filePath = filePath
    this.tmpPath = `${filePath}.tmp`
    this.opts = { ...DEFAULTS, ...options }
    this.cache = { player: null, folders: [], likes: [] }
  }

  // ---------- 读取 ----------

  /** 返回当前内存中的全量状态（浅拷贝顶层结构，调用方可安全修改）。 */
  getState(): AppState {
    this.ensureLoaded()
    return this.cloneState(this.cache)
  }

  getPlayerState(): PersistedState | null {
    this.ensureLoaded()
    return this.cache.player ? this.clonePlayer(this.cache.player) : null
  }

  listFolders(): SavedFolder[] {
    this.ensureLoaded()
    return this.cache.folders.map((f) => ({ ...f, tracks: [...f.tracks] }))
  }

  listLikes(): Track[] {
    this.ensureLoaded()
    return [...this.cache.likes]
  }

  // ---------- 写入（全量 / 库 / 点赞） ----------

  /** 全量替换播放状态，含 queue。保留供渲染进程在 queue 变化时使用。 */
  setPlayerState(player: PersistedState): void {
    this.ensureLoaded()
    // 全量路径需要拷贝，避免渲染进程后续改动内存里的引用。
    this.cache.player = {
      queue: player.queue.map((t) => ({ ...t })),
      currentIndex: player.currentIndex,
      volume: player.volume,
      mode: player.mode,
      ...(player.currentTime === undefined ? {} : { currentTime: player.currentTime })
    }
    this.scheduleWrite()
  }

  /**
   * 进度补丁：只更新 player 的标量字段，绝不触碰 queue。
   * 不克隆 queue——直接复用内部已有的数组引用，标量就地替换。
   * 若尚无 player（首次启动），用空 queue 建档。
   */
  savePlayback(patch: PlaybackState): void {
    this.ensureLoaded()
    const current = this.cache.player
    if (current) {
      current.currentIndex = patch.currentIndex
      current.volume = patch.volume
      current.mode = patch.mode
      if (patch.currentTime === undefined) {
        delete current.currentTime
      } else {
        current.currentTime = patch.currentTime
      }
    } else {
      this.cache.player = {
        queue: [],
        currentIndex: patch.currentIndex,
        volume: patch.volume,
        mode: patch.mode,
        ...(patch.currentTime === undefined ? {} : { currentTime: patch.currentTime })
      }
    }
    this.scheduleWrite()
  }

  upsertFolder(folder: SavedFolder): SavedFolder[] {
    this.ensureLoaded()
    const state = this.cache
    const index = state.folders.findIndex((item) => item.id === folder.id)
    const cloned: SavedFolder = { ...folder, tracks: folder.tracks.map((t) => ({ ...t })) }
    if (index >= 0) state.folders[index] = cloned
    else state.folders.unshift(cloned)
    this.scheduleWrite()
    return this.listFolders()
  }

  removeFolder(id: string): SavedFolder[] {
    this.ensureLoaded()
    this.cache.folders = this.cache.folders.filter((item) => item.id !== id)
    this.scheduleWrite()
    return this.listFolders()
  }

  saveLikes(likes: Track[]): Track[] {
    this.ensureLoaded()
    this.cache.likes = likes.map((t) => ({ ...t }))
    this.scheduleWrite()
    return this.listLikes()
  }

  // ---------- flush ----------

  /**
   * 取消 debounce 等待，把「最后一次更新」落盘并等待其完成。
   * 返回的 Promise 在最后一次更新真正落盘后 resolve；写失败会被内部吞掉并记录，永远 resolve。
   */
  async flushState(): Promise<void> {
    // 取消 debounce，把 pending 写入立即推进串行链；
    // dirty（含写失败重试）也保证再落一次盘。两者最多触发一次入队。
    if (this.timer || this.dirty) {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      this.enqueueWrite()
    }
    let pending: Promise<void>
    do {
      pending = this.drainPromise
      await pending
      // A mutation can arrive while fs is in flight, before its debounce fires.
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
        this.enqueueWrite()
      }
    } while (pending !== this.drainPromise)
  }

  // ---------- 内部：debounce / 串行写 ----------

  private ensureLoaded(): void {
    if (this.cacheLoaded) return
    this.cacheLoaded = true
    this.cache = this.readFromDiskSync()
  }

  private scheduleWrite(): void {
    this.revision += 1
    this.dirty = true
    if (this.opts.debounceMs <= 0) {
      this.enqueueWrite()
      return
    }
    if (this.timer) {
      // 已有待触发版本：复用同一个 pending 写入，延后触发时间。
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.enqueueWrite()
    }, this.opts.debounceMs)
  }

  /**
   * 把一次落盘 append 到 drainPromise 链尾。
   * 关键：返回的 promise 在「该次写入（含写入期间又到来的更新）」落盘后 resolve，
   * 不会因为前序写还在进行就提前 resolve。
   */
  private enqueueWrite(): Promise<void> {
    const runOnce = async (): Promise<void> => {
      // 写开始前取消任何 pending debounce：写入期间到来的更新会并入本次快照。
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      try {
        const writtenRevision = this.revision
        await this.writeOnce()
        this.dirty = this.revision !== writtenRevision
      } catch (error) {
        // 重试已用尽：记录、置 dirty 以便下次再试，但不抛出。
        console.error('[state-store] 落盘失败，已重试仍不成功：', error)
        this.dirty = true
      }
    }

    this.dirty = true
    // append 到链尾，保证严格串行且单 drain。
    this.drainPromise = this.drainPromise.then(runOnce, runOnce)
    return this.drainPromise
  }

  /** 把当前内存状态原子写盘，带重试。 */
  private async writeOnce(): Promise<void> {
    let attempt = 0
    // 拷贝一份快照，避免异步写过程中内存被并发修改。
    const snapshot = JSON.stringify(this.cache, null, 2)
    while (true) {
      try {
        await this.atomicWrite(snapshot)
        return
      } catch (error) {
        attempt++
        if (attempt > this.opts.maxRetries) throw error
        await this.sleep(this.opts.retryDelayMs)
      }
    }
  }

  /** 真异步原子写：先写 .tmp，再 rename。失败时 .tmp 残留不覆盖旧 state.json。 */
  private async atomicWrite(content: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.tmpPath, content, 'utf-8')
    await rename(this.tmpPath, this.filePath)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // ---------- 读取与兼容 ----------

  /**
   * 从磁盘读取，兼容历史 shape；损坏/不存在退回空状态，绝不抛出。
   * 用同步 readFile 仅在首次懒加载时调用一次（之后全走内存缓存）。
   */
  private readFromDiskSync(): AppState {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch {
      return { player: null, folders: [], likes: [] }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { player: null, folders: [], likes: [] }
    }

    if (!parsed || typeof parsed !== 'object') {
      return { player: null, folders: [], likes: [] }
    }

    const obj = parsed as Record<string, any>

    // legacy：只有 queue 数组的裸 PersistedState。
    if (!('player' in obj) && Array.isArray(obj.queue)) {
      return { player: this.sanitizePlayer(obj) ?? null, folders: [], likes: [] }
    }

    const player = this.sanitizePlayer(obj.player)
    const folders = Array.isArray(obj.folders)
      ? obj.folders.filter(this.isSavedFolder).map(this.cloneFolder)
      : []
    const likes = Array.isArray(obj.likes)
      ? obj.likes.filter(this.isTrack).map(this.cloneTrack)
      : []
    return {
      player: player ?? null,
      folders,
      likes
    }
  }

  private sanitizePlayer(value: any): PersistedState | null {
    if (!value || typeof value !== 'object') return null
    if (!Array.isArray(value.queue)) return null
    return {
      queue: value.queue.filter(this.isTrack).map(this.cloneTrack),
      currentIndex: typeof value.currentIndex === 'number' ? value.currentIndex : 0,
      volume: typeof value.volume === 'number' ? value.volume : 0,
      mode: this.asPlayMode(value.mode) ?? 'order',
      ...(typeof value.currentTime === 'number' ? { currentTime: value.currentTime } : {})
    }
  }

  private isTrack = (value: any): value is Track =>
    !!value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.bvid === 'string' &&
    typeof value.page === 'number' &&
    typeof value.title === 'string' &&
    typeof value.cover === 'string' &&
    typeof value.owner === 'string' &&
    typeof value.duration === 'number'

  private isSavedFolder = (value: any): value is SavedFolder =>
    !!value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.cover === 'string' &&
    typeof value.updatedAt === 'number' &&
    Array.isArray(value.tracks)

  private cloneTrack = (t: Track): Track => ({
    ...t,
    ...(typeof t.cid === 'number' ? { cid: t.cid } : {})
  })

  private cloneFolder = (f: SavedFolder): SavedFolder => ({
    ...f,
    tracks: f.tracks.filter(this.isTrack).map(this.cloneTrack)
  })

  private asPlayMode(value: unknown): PersistedState['mode'] | null {
    if (value === 'order' || value === 'single' || value === 'shuffle') return value
    return null
  }

  private clonePlayer(p: PersistedState): PersistedState {
    return {
      queue: p.queue.map(this.cloneTrack),
      currentIndex: p.currentIndex,
      volume: p.volume,
      mode: p.mode,
      ...(p.currentTime === undefined ? {} : { currentTime: p.currentTime })
    }
  }

  private cloneState(s: AppState): AppState {
    return {
      player: s.player ? this.clonePlayer(s.player) : null,
      folders: s.folders.map(this.cloneFolder),
      likes: s.likes.map(this.cloneTrack)
    }
  }
}

// ---------- 退出 flush ----------

export interface QuitFlushHooks {
  /** 通知渲染进程做最后一次 flush（发 before-quit）。 */
  notifyRenderer?: () => void
  /** 等待渲染进程回 ack。返回 true 表示收到；超时由调用方在 onAck 内自行处理。 */
  onAck?: () => Promise<boolean>
  /** 错误记录钩子。 */
  onError?: (error: unknown) => void
}

/**
 * 退出流程的统一 flush：先通知渲染进程、等 ack，ack 后再调用 startFlush() 触发主进程落盘，
 * 这样「渲染进程最后一次保存」一定在主进程 flush 之前完成、会被等待落盘。
 * 整体受 timeoutMs 限制，超时不再继续等、直接返回，避免退出卡死。
 * 任何错误都走 onError 记录，不会抛出。
 *
 * startFlush 设计为 (acked: boolean) => Promise<void>：只在 ack 完成后才真正启动主进程 flush，
 * 保证「先 ack 后 flush」的顺序。
 */
export async function runQuitFlush(
  startFlush: (acked: boolean) => Promise<void>,
  hooks: QuitFlushHooks = {},
  timeoutMs = 2000
): Promise<void> {
  const until = Date.now() + timeoutMs
  const timers: Array<NodeJS.Timeout> = []
  const clearTimers = (): void => {
    for (const t of timers) clearTimeout(t)
  }

  // 1) 通知渲染进程。
  try {
    hooks.notifyRenderer?.()
  } catch (error) {
    hooks.onError?.(error)
  }

  try {
    // 2) 等 ack（带剩余超时）。
    let acked = false
    if (hooks.onAck) {
      // Reserve time for writing even when a renderer has crashed or never acks.
      const remaining = Math.max(0, Math.min(timeoutMs / 4, until - Date.now()))
      const ackTimeout = new Promise<boolean>((resolve) => {
        timers.push(setTimeout(() => resolve(false), remaining))
      })
      try {
        acked = await Promise.race([hooks.onAck(), ackTimeout])
      } catch (error) {
        hooks.onError?.(error)
        acked = false
      }
    }

    // 3) ack 后再启动主进程 flush（渲染进程的最后保存先到达）。
    const remaining = Math.max(0, until - Date.now())
    const flushTimeout = new Promise<void>((resolve) => {
      timers.push(setTimeout(resolve, remaining))
    })
    await Promise.race([
      startFlush(acked).catch((error) => {
        hooks.onError?.(error)
      }),
      flushTimeout
    ])
  } catch (error) {
    hooks.onError?.(error)
  } finally {
    // 清理残留 timer，避免 2 秒后还有定时器挂在事件循环上。
    clearTimers()
  }
}
