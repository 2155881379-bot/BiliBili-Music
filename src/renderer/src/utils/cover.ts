export interface CoverImageOptions {
  /** CSS pixels occupied by the image on screen. */
  displayWidth: number
  /** Device pixel ratio. Values outside the safe range are clamped. */
  dpr?: number
}

export const COVER_MIN_DPR = 1
export const COVER_MAX_DPR = 3
export const COVER_MIN_OUTPUT_WIDTH = 32
export const COVER_MAX_OUTPUT_WIDTH = 1024

const SUPPORTED_IMAGE_EXTENSION = /\.(?:avif|jpe?g|png|webp)$/i
const SIGNED_QUERY_PARAMETER =
  /^(?:auth_key|deadline|expires?|key|sig|sign|signature|token|w_rid|wts|x-bili-.*)$/i

function fallbackDpr(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio
}

function boundedDpr(value: number): number {
  if (!Number.isFinite(value)) return COVER_MIN_DPR
  return Math.min(COVER_MAX_DPR, Math.max(COVER_MIN_DPR, value))
}

function isTrustedBilibiliHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'hdslb.com' || host.endsWith('.hdslb.com')
}

function hasSignedQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (SIGNED_QUERY_PARAMETER.test(key)) return true
  }
  return false
}

function hasExistingTransform(pathname: string): boolean {
  const lastSlash = pathname.lastIndexOf('/')
  return pathname.slice(lastSlash + 1).includes('@')
}

function hasSupportedImageExtension(pathname: string): boolean {
  return SUPPORTED_IMAGE_EXTENSION.test(pathname)
}

function insertPathTransform(source: string, transform: string): string {
  const queryIndex = source.indexOf('?')
  const hashIndex = source.indexOf('#')
  const suffixIndexes = [queryIndex, hashIndex].filter((index) => index >= 0)
  const insertAt = suffixIndexes.length ? Math.min(...suffixIndexes) : source.length
  return `${source.slice(0, insertAt)}${transform}${source.slice(insertAt)}`
}

/**
 * Returns a width-only Bilibili CDN image URL. The missing height and crop
 * arguments keep the source aspect ratio intact.
 *
 * Unknown hosts, signed URLs, unsupported files, and URLs that already carry
 * a CDN transform are returned unchanged.
 */
export function getCoverImageUrl(source: string, options: CoverImageOptions): string {
  if (!source || !Number.isFinite(options.displayWidth) || options.displayWidth <= 0) {
    return source
  }

  const normalized =
    source.startsWith('//')
      ? `https:${source}`
      : source.replace(/^http:\/\//i, (scheme) => `${scheme.slice(0, -3)}s://`)

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    return source
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !isTrustedBilibiliHost(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return source
  }

  if (hasSignedQuery(url) || hasExistingTransform(url.pathname)) return source
  if (!hasSupportedImageExtension(url.pathname)) return source

  const requestedWidth = Math.round(options.displayWidth * boundedDpr(options.dpr ?? fallbackDpr()))
  const outputWidth = Math.min(
    COVER_MAX_OUTPUT_WIDTH,
    Math.max(COVER_MIN_OUTPUT_WIDTH, requestedWidth)
  )

  return insertPathTransform(normalized, `@${outputWidth}w.webp`)
}
