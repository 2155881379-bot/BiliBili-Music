import { net, session } from 'electron'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const REFERER = 'https://www.bilibili.com/'

export class BiliError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message)
    this.name = 'BiliError'
  }
}

const MIN_INTERVAL = 300
let lastRequestAt = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 全局限速，避免短时间内大量请求触发 412 */
async function throttle() {
  const wait = MIN_INTERVAL - (Date.now() - lastRequestAt)
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

export async function biliJson<T>(url: string): Promise<T> {
  await throttle()
  const res = await net.fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: REFERER
    },
    credentials: 'include'
  })
  if (res.status === 412) throw new BiliError(-412, 'B 站风控拦截，请稍后再试')
  if (!res.ok) throw new BiliError(res.status, `请求失败（HTTP ${res.status}）`)
  const body = (await res.json()) as { code: number; message: string; data: T }
  if (body.code !== 0) throw new BiliError(body.code, body.message || '接口返回异常')
  return body.data
}

let warmed = false

/** 预热：拿 buvid3 等匿名 cookie，降低风控概率。不涉及任何账号凭证。 */
export async function warmUp(): Promise<void> {
  if (warmed) return
  warmed = true
  try {
    await net.fetch(REFERER, {
      headers: { 'User-Agent': UA, Referer: REFERER },
      credentials: 'include'
    })
  } catch {
    // 预热失败不影响后续请求，真出错时会在具体接口上暴露
  }
}

/**
 * 渲染进程发出的音频/封面请求由 Chromium 直连 CDN，
 * 这里统一补上 Referer 与 UA，否则会被拒绝。
 */
export function installHeaderRules(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.bilivideo.com/*',
        '*://*.bilivideo.cn/*',
        '*://*.hdslb.com/*',
        '*://*.bilibili.com/*'
      ]
    },
    (details, callback) => {
      const requestHeaders = {
        ...details.requestHeaders,
        Referer: REFERER,
        'User-Agent': UA
      }
      callback({ requestHeaders })
    }
  )
}
