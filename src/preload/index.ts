import { contextBridge, ipcRenderer } from 'electron'
import type {
  AudioStream,
  FavPage,
  PersistedState,
  PlaybackState,
  PlayerCommand,
  SavedFolder,
  SearchPage,
  Track,
  VideoInfo
} from '../shared/types'

const api = {
  search: (keyword: string, page = 1): Promise<SearchPage> =>
    ipcRenderer.invoke('bili:search', keyword, page),
  video: (bvid: string): Promise<VideoInfo> => ipcRenderer.invoke('bili:video', bvid),
  audio: (bvid: string, cid: number): Promise<AudioStream> =>
    ipcRenderer.invoke('bili:audio', bvid, cid),
  favFolder: (mediaId: string, page = 1): Promise<FavPage> =>
    ipcRenderer.invoke('bili:fav', mediaId, page),
  parseFav: (raw: string): Promise<string | null> => ipcRenderer.invoke('bili:parseFav', raw),

  listFolders: (): Promise<SavedFolder[]> => ipcRenderer.invoke('library:list'),
  saveFolder: (folder: SavedFolder): Promise<SavedFolder[]> =>
    ipcRenderer.invoke('library:save', folder),
  removeFolder: (id: string): Promise<SavedFolder[]> => ipcRenderer.invoke('library:remove', id),

  listLikes: (): Promise<Track[]> => ipcRenderer.invoke('likes:list'),
  saveLikes: (likes: Track[]): Promise<Track[]> => ipcRenderer.invoke('likes:save', likes),

  loadState: (): Promise<PersistedState | null> => ipcRenderer.invoke('state:load'),
  /** 全量保存（含 queue）：仅在 queue 变化时调用。 */
  saveState: (state: PersistedState): void => ipcRenderer.send('state:save', state),
  /**
   * 进度补丁（不含 queue）：只更新 player 标量，不会覆盖渲染进程维护的 queue。
   * 高频进度更新走这里，避免每 5 秒复制整个 queue。
   */
  savePlayback: (state: PlaybackState): void => ipcRenderer.send('state:save-playback', state),
  hideWindow: (): void => ipcRenderer.send('win:hide'),
  minimizeWindow: (): void => ipcRenderer.send('win:minimize'),
  toggleMaximize: (): void => ipcRenderer.send('win:maximize'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('win:isMaximized'),
  /** 当前窗口是否可见且未最小化（isVisible && !isMinimized）。 */
  isWindowVisible: (): Promise<boolean> => ipcRenderer.invoke('win:isVisible'),
  /** 监听可见性变化（show / hide / minimize / restore / close-to-tray）。返回取消订阅。 */
  onVisibilityChange: (callback: (visible: boolean) => void): (() => void) => {
    const listener = (_event: unknown, visible: boolean) => callback(visible)
    ipcRenderer.on('win:visible', listener)
    return () => {
      ipcRenderer.removeListener('win:visible', listener)
    }
  },
  onMaximizedChange: (callback: (maximized: boolean) => void): (() => void) => {
    const listener = (_event: unknown, maximized: boolean) => callback(maximized)
    ipcRenderer.on('win:maximized', listener)
    return () => {
      ipcRenderer.removeListener('win:maximized', listener)
    }
  },

  onCommand: (callback: (command: PlayerCommand) => void): (() => void) => {
    const listener = (_event: unknown, command: PlayerCommand) => callback(command)
    ipcRenderer.on('player:command', listener)
    return () => {
      ipcRenderer.removeListener('player:command', listener)
    }
  },

  /** 主进程退出前通知：渲染进程收到后应做最后一次 flush。 */
  onBeforeQuit: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('app:before-quit', listener)
    return () => {
      ipcRenderer.removeListener('app:before-quit', listener)
    }
  },
  /** flush 完成后回 ack，让主进程不必一直等到超时。 */
  ackQuit: (): void => ipcRenderer.send('app:flush-ack')
}

export type BiliApi = typeof api

contextBridge.exposeInMainWorld('api', api)
