import type { AudioStream, FavPage, SearchPage, Track, VideoInfo } from '../../shared/types'
import { biliJson } from './client'

const API = 'https://api.bilibili.com'

const stripTags = (text = '') => text.replace(/<[^>]+>/g, '')
const normalizeImage = (url = '') => {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  return url.replace(/^http:/, 'https:')
}

/** "12:34" / "1:02:03" / 秒数 统一转成秒 */
export function parseDuration(value: string | number | undefined): number {
  if (typeof value === 'number') return value
  if (!value) return 0
  return value.split(':').reduce((acc, part) => acc * 60 + Number(part || 0), 0)
}

export async function searchVideo(keyword: string, page = 1): Promise<SearchPage> {
  const data = await biliJson<{
    result?: Array<Record<string, any>>
    numResults?: number
    numPages?: number
  }>(
    `${API}/x/web-interface/search/type?search_type=video&page=${page}&keyword=${encodeURIComponent(keyword)}`
  )

  const list: Track[] = (data.result ?? [])
    .filter((item) => item.type === 'video' && item.bvid)
    .map((item) => ({
      id: `${item.bvid}-1`,
      bvid: item.bvid,
      page: 1,
      title: stripTags(item.title),
      cover: normalizeImage(item.pic),
      owner: item.author ?? '',
      duration: parseDuration(item.duration)
    }))

  return {
    list,
    page,
    total: data.numResults ?? 0,
    hasMore: (data.numPages ?? 0) > page
  }
}

export async function getVideo(bvid: string): Promise<VideoInfo> {
  const data = await biliJson<any>(`${API}/x/web-interface/view?bvid=${bvid}`)
  return {
    bvid: data.bvid,
    title: data.title,
    cover: normalizeImage(data.pic),
    duration: data.duration ?? 0,
    owner: data.owner?.name ?? '',
    pages: (data.pages ?? []).map((p: any) => ({
      cid: p.cid,
      page: p.page,
      part: p.part ?? `P${p.page}`,
      duration: p.duration ?? 0
    }))
  }
}

/** 取音质最好的纯音频流（匿名最高 30280，约 192kbps） */
export async function getAudio(bvid: string, cid: number): Promise<AudioStream> {
  const data = await biliJson<any>(
    `${API}/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=1`
  )

  const audios: any[] = data.dash?.audio ?? []
  if (audios.length) {
    const best = [...audios].sort((a, b) => b.bandwidth - a.bandwidth)[0]
    return {
      url: best.baseUrl,
      backups: best.backupUrl ?? []
    }
  }

  // 少数老视频没有 dash，退回 durl 的混合流
  const durl = data.durl?.[0]
  if (durl?.url) {
    return {
      url: durl.url,
      backups: durl.backup_url ?? []
    }
  }

  throw new Error('这个视频没有可用的音频流')
}

export async function getFavFolder(mediaId: string, page = 1): Promise<FavPage> {
  const data = await biliJson<any>(
    `${API}/x/v3/fav/resource/list?media_id=${mediaId}&pn=${page}&ps=20&platform=web`
  )
  const info = data.info
  if (!info) throw new Error('收藏夹不存在，或者不是公开收藏夹')

  const items: Track[] = (data.medias ?? [])
    .filter((media: any) => media.bvid || media.bv_id)
    .map((media: any) => {
      const bvid: string = media.bvid ?? media.bv_id
      return {
        id: `${bvid}-1`,
        bvid,
        page: 1,
        title: media.title ?? '',
        cover: normalizeImage(media.cover),
        owner: media.upper?.name ?? '',
        duration: media.duration ?? 0
      }
    })

  return {
    info: { id: String(info.id), title: info.title, count: info.media_count ?? 0 },
    items,
    hasMore: Boolean(data.has_more)
  }
}

/** 支持收藏夹链接、medialist 链接、纯 media_id 数字 */
export function parseFavMediaId(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  const fid = text.match(/[?&]fid=(\d+)/)
  if (fid) return fid[1]
  const ml = text.match(/\/ml(\d+)/)
  if (ml) return ml[1]
  const detail = text.match(/media_id=(\d+)/)
  if (detail) return detail[1]
  if (/^\d{4,}$/.test(text)) return text
  return null
}
