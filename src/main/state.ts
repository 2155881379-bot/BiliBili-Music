import { app } from 'electron'
import { join } from 'node:path'
import { StateStore } from './state-store'
import type { PersistedState, SavedFolder, Track } from '../shared/types'

// 单例：主进程内共享同一份内存缓存与串行写队列。
const stateFile = () => join(app.getPath('userData'), 'state.json')
let store: StateStore | null = null

function getStore(): StateStore {
  if (!store) store = new StateStore(stateFile())
  return store
}

export function getPlayerState(): PersistedState | null {
  return getStore().getPlayerState()
}

/** 全量替换播放状态（含 queue）。保留给渲染进程在 queue 变化时使用。 */
export function setPlayerState(player: PersistedState): void {
  getStore().setPlayerState(player)
}

/**
 * 进度补丁：只更新 player 标量，不覆盖 queue。
 * 渲染进程在播放进度变化时可高频调用，不会丢失渲染进程自己维护的 queue。
 */
export function savePlayback(player: Omit<PersistedState, 'queue'>): void {
  getStore().savePlayback(player)
}

export function listFolders(): SavedFolder[] {
  return getStore().listFolders()
}

export function upsertFolder(folder: SavedFolder): SavedFolder[] {
  return getStore().upsertFolder(folder)
}

export function removeFolder(id: string): SavedFolder[] {
  return getStore().removeFolder(id)
}

export function listLikes(): Track[] {
  return getStore().listLikes()
}

export function saveLikes(likes: Track[]): Track[] {
  return getStore().saveLikes(likes)
}

/**
 * 退出前阻塞等待最后一次落盘完成。
 * 内部已吞掉写错误，永远 resolve；调用方在 before-quit 里 await 它。
 */
export function flushState(): Promise<void> {
  return getStore().flushState()
}
