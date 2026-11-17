import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SavedFolder, Track } from '../../../shared/types'
import { usePlayerStore } from './player'

/** 接口每页最多 20 条；100 页只作为死循环兜底，正常收藏夹不会碰到 */
const MAX_PAGES = 100

export const useLibraryStore = defineStore('library', () => {
  const folders = ref<SavedFolder[]>([])
  const likes = ref<Track[]>([])
  const importing = ref(false)
  const status = ref('')

  async function init(): Promise<void> {
    folders.value = await window.api.listFolders()
    likes.value = await window.api.listLikes()
  }

  async function importFolder(raw: string): Promise<SavedFolder | null> {
    const mediaId = await window.api.parseFav(raw)
    if (!mediaId) {
      status.value = '没认出收藏夹，请粘贴收藏夹链接，或直接填 media_id'
      return null
    }
    return collect(mediaId)
  }

  async function refresh(folder: SavedFolder): Promise<void> {
    await collect(folder.id)
  }

  async function collect(mediaId: string): Promise<SavedFolder | null> {
    importing.value = true
    status.value = '正在读取收藏夹…'
    try {
      const tracks: Track[] = []
      let title = ''
      let total = 0
      for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
        const result = await window.api.favFolder(mediaId, pageNo)
        title = result.info.title
        total = result.info.count
        tracks.push(...result.items)
        status.value = `正在读取《${title}》 ${tracks.length} / ${total}`
        if (!result.hasMore) break
      }

      if (!tracks.length) {
        status.value = '这个收藏夹里没有可播放的视频'
        return null
      }

      const folder: SavedFolder = {
        id: mediaId,
        title,
        cover: tracks[0].cover,
        updatedAt: Date.now(),
        tracks: tracks.map((track) => ({ ...track }))
      }
      folders.value = await window.api.saveFolder(folder)
      status.value =
        tracks.length === total
          ? `《${title}》已保存，共 ${tracks.length} 首`
          : `《${title}》已保存 ${tracks.length} / ${total} 首，差额通常是失效视频`
      return folder
    } catch (error) {
      status.value = (error as Error).message
      return null
    } finally {
      importing.value = false
    }
  }

  async function remove(id: string): Promise<void> {
    folders.value = await window.api.removeFolder(id)
    status.value = '已删除'
  }

  function play(folder: SavedFolder, index = 0): void {
    usePlayerStore().replaceQueue(
      folder.tracks.map((track) => ({ ...track })),
      index
    )
  }

  function enqueue(folder: SavedFolder): void {
    usePlayerStore().append(folder.tracks.map((track) => ({ ...track })))
    status.value = `《${folder.title}》${folder.tracks.length} 首已加入播放队列`
  }

  function isLiked(track: Track | null): boolean {
    return !!track && likes.value.some((item) => item.id === track.id)
  }

  async function toggleLike(track: Track): Promise<void> {
    const exists = likes.value.some((item) => item.id === track.id)
    const next = exists
      ? likes.value.filter((item) => item.id !== track.id)
      : [{ ...track }, ...likes.value]
    // 响应式代理不能直接过 IPC，先转普通对象
    likes.value = await window.api.saveLikes(next.map((item) => ({ ...item })))
    status.value = exists ? '已取消收藏' : '已喜欢'
  }

  function playLikes(index = 0): void {
    if (!likes.value.length) return
    usePlayerStore().replaceQueue(
      likes.value.map((track) => ({ ...track })),
      index
    )
  }

  function enqueueLikes(): void {
    usePlayerStore().append(likes.value.map((track) => ({ ...track })))
    status.value = `${likes.value.length} 首已加入播放队列`
  }

  return {
    folders,
    likes,
    importing,
    status,
    init,
    importFolder,
    refresh,
    remove,
    play,
    enqueue,
    isLiked,
    toggleLike,
    playLikes,
    enqueueLikes
  }
})
