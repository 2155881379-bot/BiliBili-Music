import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import type { PlaybackState, PlayMode, Track } from '../../../shared/types'

import {
  type QueueEntry,
  FAILURE_THRESHOLD,
  createQueueEntry,
  expandMultiPage,
  findCurrentIndex,
  nextIndex,
  toQueueEntries
} from '../utils/queue'

import { getCoverImageUrl } from '../utils/cover'

const audio = new Audio()
audio.preload = 'auto'

const MODE_ORDER: PlayMode[] = ['order', 'single', 'shuffle']

export const usePlayerStore = defineStore('player', () => {
  const queue = ref<QueueEntry[]>([])
  const currentIndex = ref(-1)
  const playing = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(0.8)
  const mode = ref<PlayMode>('order')
  const loading = ref(false)
  const error = ref('')
  const notice = ref('')

  const current = computed<QueueEntry | null>(() => queue.value[currentIndex.value] ?? null)
  const currentQueueId = computed<string | null>(() => current.value?.queueId ?? null)

  audio.volume = volume.value

  let lastPersistAt = 0
  audio.addEventListener('timeupdate', () => {
    currentTime.value = audio.currentTime
    syncPositionState()
    if (!audio.paused && Date.now() - lastPersistAt > 5000) {
      lastPersistAt = Date.now()
      persist()
    }
  })
  audio.addEventListener('loadedmetadata', () => {
    duration.value = Number.isFinite(audio.duration) ? audio.duration : 0
  })
  audio.addEventListener('play', () => {
    playing.value = true
  })
  audio.addEventListener('pause', () => {
    playing.value = false
    persist()
  })
  audio.addEventListener('ended', () => next(true))

  let fallbackUrls: string[] = []
  audio.addEventListener('error', () => {
    if (!audio.src) return
    const backup = fallbackUrls.shift()
    if (backup) {
      audio.src = backup
      void audio.play().catch(() => {})
      return
    }
    handleFailure('音频加载失败')
  })

  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let skipTimer: ReturnType<typeof setTimeout> | null = null
  let failedCount = 0
  let failing = false

  let loadToken = 0

  function flash(message: string): void {
    notice.value = message
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => {
      notice.value = ''
    }, 4000)
  }

  function handleFailure(reason: string): void {
    if (failing) return
    failing = true

    if (!queue.value.length) {
      error.value = reason
      return
    }

    failedCount += 1
    if (failedCount >= Math.min(FAILURE_THRESHOLD, queue.value.length)) {
      error.value = '连续几首都没能播起来，先停一下检查网络'
      failedCount = 0
      audio.pause()
      return
    }

    const failedTitle = current.value?.title ?? '这一首'
    flash(`${reason}，「${failedTitle}」已跳过`)
    skipTimer = setTimeout(() => {
      skipTimer = null
      next()
    }, 700)
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let queueDirty = false
  function playbackState(): PlaybackState {
    return {
      currentIndex: currentIndex.value,
      volume: volume.value,
      mode: mode.value,
      currentTime: currentTime.value
    }
  }

  function flushPersist(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    if (queueDirty) {
      window.api.saveState({ ...playbackState(), queue: queue.value.map(track => ({ ...track })) })
      queueDirty = false
    } else {
      window.api.savePlayback(playbackState())
    }
  }

  function persist(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushPersist, 500)
  }

  function persistQueue(): void {
    queueDirty = true
    persist()
  }
  // Queue mutations are tracked by the actions below, avoiding a deep walk
  // when only selection, volume, or playback progress changes.
  watch([currentIndex, volume, mode], persist)
  let offBeforeQuit: (() => void) | undefined
  let offCommand: (() => void) | undefined
  onScopeDispose(() => {
    offBeforeQuit?.()
    offCommand?.()
    if (saveTimer) clearTimeout(saveTimer)
    if (skipTimer) clearTimeout(skipTimer)
    if (noticeTimer) clearTimeout(noticeTimer)
  })

  async function ensureCid(entry: QueueEntry, token: number): Promise<QueueEntry | null> {
    if (entry.cid) return entry

    const info = await window.api.video(entry.bvid)
    if (token !== loadToken) return null

    const expanded = expandMultiPage(entry, info)
    if (expanded) {
      const pos = findCurrentIndex(queue.value, entry.queueId)
      if (pos < 0 || token !== loadToken) return null
      queue.value.splice(pos, 1, ...expanded)
      persistQueue()
      return expanded[0] ?? null
    }

    const first = info.pages[0]
    if (!first) throw new Error('无法获取播放分区')
    const pos = findCurrentIndex(queue.value, entry.queueId)
    if (pos < 0 || token !== loadToken) return null
    queue.value[pos] = { ...queue.value[pos], cid: first.cid }
    persistQueue()
    return queue.value[pos]
  }

  async function loadTrack(index: number, autoplay = true): Promise<QueueEntry | null> {
    const track = queue.value[index]
    if (!track) return null

    failing = false
    if (skipTimer) {
      clearTimeout(skipTimer)
      skipTimer = null
    }

    const token = ++loadToken
    currentIndex.value = index
    loading.value = true
    error.value = ''
    try {
      const ready = await ensureCid(track, token)
      if (token !== loadToken || !ready) return null
      // 多 P 展开后原 entry 已被新条目替换，targetQueueId 已不在队列里。
      // 用 ready.queueId（展开后第一条的新身份，或单 P 原条目）重新定位。
      const freshIndex = findCurrentIndex(queue.value, ready.queueId)
      if (freshIndex < 0 || token !== loadToken) return null
      currentIndex.value = freshIndex
      if (!ready.cid) throw new Error('拿不到播放分区')

      const stream = await window.api.audio(ready.bvid, ready.cid)
      if (token !== loadToken) return null
      fallbackUrls = stream.backups
      audio.src = stream.url
      audio.volume = volume.value
      currentTime.value = 0
      if (autoplay) await audio.play()
      if (token !== loadToken) return null
      failedCount = 0
      updateMetadata()
      persist()
      return ready
    } catch (err) {
      const name = (err as Error)?.name
      if (name === 'AbortError') return null
      if (name === 'NotAllowedError') {
        if (token !== loadToken) return null
        error.value = '自动播放被拦截，点一下播放键即可'
        return null
      }
      if (token !== loadToken) return null
      handleFailure(`播放失败：${(err as Error).message}`)
      return null
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  async function toggle(): Promise<void> {
    if (!audio.src) {
      const index = currentIndex.value >= 0 ? currentIndex.value : 0
      if (queue.value.length) await loadTrack(index)
      return
    }
    if (audio.paused) await audio.play()
    else audio.pause()
  }

  function next(auto = false): void {
    if (!queue.value.length) return

    if (auto && mode.value === 'single') {
      audio.currentTime = 0
      void audio.play()
      return
    }

    // auto+single 已在上面循环本曲；手动 next 在单曲模式下要跳下一首，
    // 所以把 single 当 order 处理。
    const effectiveMode = mode.value === 'single' ? 'order' : mode.value
    const index = nextIndex(queue.value.length, currentIndex.value, effectiveMode)
    void loadTrack(index)
  }

  function prev(): void {
    if (!queue.value.length) return
    if (audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    const index = currentIndex.value <= 0 ? queue.value.length - 1 : currentIndex.value - 1
    void loadTrack(index)
  }

  function seek(seconds: number): void {
    if (!Number.isFinite(seconds)) return
    audio.currentTime = seconds
    currentTime.value = seconds
  }

  function seekWhenReady(
    seconds: number,
    token = loadToken,
    queueId = currentQueueId.value
  ): void {
    const apply = (): void => {
      if (token === loadToken && currentQueueId.value === queueId) seek(seconds)
    }
    if (audio.readyState >= 1) {
      apply()
      return
    }
    audio.addEventListener('loadedmetadata', apply, { once: true })
  }

  function setVolume(value: number): void {
    const next = Math.min(1, Math.max(0, value))
    volume.value = next
    audio.volume = next
  }

  function cycleMode(): void {
    const index = MODE_ORDER.indexOf(mode.value)
    mode.value = MODE_ORDER[(index + 1) % MODE_ORDER.length]
  }

  function append(tracks: Track[]): void {
    if (!tracks.length) return
    queue.value.push(...toQueueEntries(tracks))
    persistQueue()
  }

  function playNext(track: Track): void {
    const at = currentIndex.value + 1
    queue.value.splice(at, 0, createQueueEntry(track))
    persistQueue()
    flash(`「${track.title}」已排到下一首`)
    if (queue.value.length === 1) void loadTrack(0)
  }

  function move(from: number, to: number): void {
    const item = queue.value[from]
    if (!item) return
    const target = Math.min(Math.max(to, 0), queue.value.length - 1)
    if (from === target) return

    const playingId = currentQueueId.value
    queue.value.splice(from, 1)
    queue.value.splice(target, 0, item)
    persistQueue()

    if (playingId) {
      const found = findCurrentIndex(queue.value, playingId)
      if (found >= 0) currentIndex.value = found
    }
  }

  function replaceQueue(tracks: Track[], startIndex = 0): void {
    if (!tracks.length) return
    queue.value = toQueueEntries(tracks)
    persistQueue()
    void loadTrack(Math.min(Math.max(startIndex, 0), tracks.length - 1))
  }

  function removeAt(index: number): void {
    if (index < 0 || index >= queue.value.length) return
    const isCurrent = index === currentIndex.value
    queue.value.splice(index, 1)
    persistQueue()

    if (index < currentIndex.value) {
      currentIndex.value -= 1
    } else if (isCurrent) {
      // 当前曲目被删：自增 token 让正在进行的旧加载作废，
      // 否则晚到的 audio() 回来仍会播这条已删条目。
      loadToken += 1
      loading.value = false
      if (skipTimer) clearTimeout(skipTimer)
      skipTimer = null
      fallbackUrls = []
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      currentTime.value = 0
      duration.value = 0
      currentIndex.value = queue.value.length ? Math.min(index, queue.value.length - 1) : -1
    }
  }

  function clear(): void {
    // 整队清空：任何在途加载都必须作废，避免清空后旧 audio() 把已删条目播出来
    loadToken += 1
    loading.value = false
    if (skipTimer) clearTimeout(skipTimer)
    skipTimer = null
    fallbackUrls = []
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    queue.value = []
    persistQueue()
    currentIndex.value = -1
    currentTime.value = 0
    duration.value = 0
    error.value = ''
  }

  function updateMetadata(): void {
    const track = current.value
    if (!track || !('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.owner,
      album: 'BiliBili Music',
      // width-only 变换不是正方形也不是 jpeg，去掉谎报的 sizes/type，
      // 只给 src 让系统按实际解码结果判断。
      artwork: track.cover
        ? [{ src: getCoverImageUrl(track.cover, { displayWidth: 512, dpr: 1 }) }]
        : []
    })
  }

  function syncPositionState(): void {
    if (!('mediaSession' in navigator) || !duration.value) return
    try {
      navigator.mediaSession.setPositionState({
        duration: duration.value,
        position: Math.min(audio.currentTime, duration.value),
        playbackRate: 1
      })
    } catch {
      // 某些状态下 Chromium 会拒绝更新，忽略即可
    }
  }

  function bindMediaSession(): void {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.setActionHandler('play', () => void toggle())
    navigator.mediaSession.setActionHandler('pause', () => audio.pause())
    navigator.mediaSession.setActionHandler('previoustrack', () => prev())
    navigator.mediaSession.setActionHandler('nexttrack', () => next())
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') seek(details.seekTime)
    })
  }

  let initialized = false
  async function init(): Promise<void> {
    if (initialized) return
    initialized = true

    bindMediaSession()
    offCommand = window.api.onCommand((command) => {
      if (command === 'toggle') void toggle()
      else if (command === 'next') next()
      else if (command === 'prev') prev()
    })
    offBeforeQuit = window.api.onBeforeQuit(() => {
      flushPersist()
      window.api.ackQuit()
    })

    const state = await window.api.loadState()
    if (!state?.queue?.length) return

    queue.value = toQueueEntries(state.queue)
    persistQueue()
    volume.value = state.volume ?? 0.8
    mode.value = state.mode ?? 'order'
    audio.volume = volume.value

    const index = state.currentIndex ?? -1
    if (index >= 0 && index < queue.value.length) {
      const loaded = await loadTrack(index, false)
      const resumeAt = state.currentTime ?? 0
      // 续播 seek 必须绑定本次加载的 token + queueId：若用户在 init 期间切了
      // 别的歌，loaded 为 null 或 currentQueueId 已变，seekWhenReady 回调会因
      // 校验不符而放弃，不会把旧 resume 打到新曲上。
      if (resumeAt > 1 && loaded) {
        seekWhenReady(resumeAt, loadToken, loaded.queueId)
      }
    }
  }

  return {
    queue,
    currentIndex,
    current,
    playing,
    currentTime,
    duration,
    volume,
    mode,
    loading,
    error,
    notice,
    init,
    playAt: loadTrack,
    toggle,
    next,
    prev,
    seek,
    setVolume,
    cycleMode,
    append,
    playNext,
    move,
    replaceQueue,
    removeAt,
    clear
  }
})
