export type PlayMode = 'order' | 'single' | 'shuffle'

/** 队列中的一首歌 = 一个视频的一个分 P */
export interface Track {
  id: string
  bvid: string
  /** 首次播放时才解析，避免导入时逐个请求 */
  cid?: number
  /** 1 起算的分 P 序号 */
  page: number
  title: string
  cover: string
  owner: string
  duration: number
}

export interface VideoInfo {
  bvid: string
  title: string
  cover: string
  duration: number
  owner: string
  pages: Array<{ cid: number; page: number; part: string; duration: number }>
}

export interface AudioStream {
  url: string
  /** 备用 CDN 线路，主线路失败时依次切换 */
  backups: string[]
}

export interface SearchPage {
  list: Track[]
  page: number
  total: number
  hasMore: boolean
}

export interface FavPage {
  info: { id: string; title: string; count: number }
  items: Track[]
  hasMore: boolean
}

export interface PersistedState {
  queue: Track[]
  currentIndex: number
  volume: number
  mode: PlayMode
  /** 上次播放到的秒数，重开时从这里继续 */
  currentTime?: number
}

/**
 * 播放进度补丁：不含 queue。
 * savePlayback 只更新这些标量，不会覆盖渲染进程维护的 queue。
 */
export interface PlaybackState {
  currentIndex: number
  volume: number
  mode: PlayMode
  currentTime?: number
}

export type PlayerCommand = 'toggle' | 'next' | 'prev'

/** 导入后长期保留的收藏夹快照 */
export interface SavedFolder {
  /** B 站收藏夹 media_id */
  id: string
  title: string
  cover: string
  updatedAt: number
  tracks: Track[]
}

export interface AppState {
  player: PersistedState | null
  folders: SavedFolder[]
  likes: Track[]
}
