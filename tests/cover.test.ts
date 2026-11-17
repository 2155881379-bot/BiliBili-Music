import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  COVER_MAX_DPR,
  COVER_MAX_OUTPUT_WIDTH,
  COVER_MIN_DPR,
  COVER_MIN_OUTPUT_WIDTH,
  getCoverImageUrl
} from '../src/renderer/src/utils/cover'

const trustedHost = fc.constantFrom('i0.hdslb.com', 'i1.hdslb.com', 'archive.hdslb.com')
const imageName = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,30}$/)
const extension = fc.constantFrom('jpg', 'jpeg', 'png', 'webp', 'avif')
const displayWidth = fc.integer({ min: 1, max: 2000 })
const finiteDpr = fc.double({
  min: -10,
  max: 10,
  noNaN: true,
  noDefaultInfinity: true
})
const dpr = fc.oneof(
  finiteDpr,
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY)
)

function processedWidth(url: string): number {
  const match = new URL(url).pathname.match(/@(\d+)w\.webp$/)
  if (!match) throw new Error(`URL has no resize suffix: ${url}`)
  return Number(match[1])
}

function expectedWidth(width: number, ratio: number): number {
  const safeDpr = Number.isFinite(ratio)
    ? Math.min(COVER_MAX_DPR, Math.max(COVER_MIN_DPR, ratio))
    : COVER_MIN_DPR
  return Math.min(
    COVER_MAX_OUTPUT_WIDTH,
    Math.max(COVER_MIN_OUTPUT_WIDTH, Math.round(width * safeDpr))
  )
}

describe('getCoverImageUrl', () => {
  it('adds a width-only transform to trusted Bilibili image URLs', () => {
    fc.assert(
      fc.property(trustedHost, imageName, extension, displayWidth, dpr, (host, name, ext, width, ratio) => {
        const source = `https://${host}/bfs/archive/${name}.${ext}`
        const result = getCoverImageUrl(source, { displayWidth: width, dpr: ratio })
        const parsed = new URL(result)

        expect(parsed.hostname).toBe(host)
        expect(processedWidth(result)).toBe(expectedWidth(width, ratio))
        expect(parsed.pathname.endsWith('_1c.webp')).toBe(false)
        expect(parsed.search).toBe('')
      }),
      { numRuns: 100 }
    )
  })

  it('leaves malformed, unknown, and untrusted URLs unchanged', () => {
    const untouched = fc.constantFrom(
      '',
      'not a URL',
      '/local/cover.jpg',
      'https://example.com/cover.jpg',
      'https://evil-hdslb.com/cover.jpg',
      'https://hdslb.com.evil.example/cover.jpg',
      'https://i0.hdslb.com/bfs/archive/cover.svg',
      'data:image/png;base64,AAAA'
    )

    fc.assert(
      fc.property(untouched, (source) => {
        expect(getCoverImageUrl(source, { displayWidth: 248, dpr: 2 })).toBe(source)
      }),
      { numRuns: 50 }
    )
  })

  it('clamps DPR and total output pixels to safe boundaries', () => {
    const source = 'https://i0.hdslb.com/bfs/archive/cover.jpg'

    expect(getCoverImageUrl(source, { displayWidth: 44, dpr: 0 })).toMatch(/@44w\.webp$/)
    expect(getCoverImageUrl(source, { displayWidth: 44, dpr: Number.NaN })).toMatch(
      /@44w\.webp$/
    )
    expect(
      getCoverImageUrl(source, { displayWidth: 44, dpr: Number.POSITIVE_INFINITY })
    ).toMatch(/@44w\.webp$/)
    expect(getCoverImageUrl(source, { displayWidth: 44, dpr: 100 })).toMatch(/@132w\.webp$/)
    expect(getCoverImageUrl(source, { displayWidth: 2000, dpr: 3 })).toMatch(/@1024w\.webp$/)
  })

  it('is idempotent after a transform has been added', () => {
    fc.assert(
      fc.property(trustedHost, imageName, extension, displayWidth, dpr, (host, name, ext, width, ratio) => {
        const source = `https://${host}/bfs/archive/${name}.${ext}`
        const once = getCoverImageUrl(source, { displayWidth: width, dpr: ratio })
        const twice = getCoverImageUrl(once, { displayWidth: width + 100, dpr: 3 })
        expect(twice).toBe(once)
      }),
      { numRuns: 75 }
    )
  })

  it('preserves an unsigned query exactly while adding the transform', () => {
    const queryValue = fc.stringMatching(/^[a-zA-Z0-9_-]{0,20}$/)

    fc.assert(
      fc.property(imageName, queryValue, (name, value) => {
        const source = `https://i0.hdslb.com/bfs/archive/${name}.jpg?cache=${value}&empty=`
        const result = getCoverImageUrl(source, { displayWidth: 248, dpr: 2 })

        expect(new URL(result).search).toBe(new URL(source).search)
        expect(result).toContain(`.jpg@496w.webp?cache=${value}&empty=`)
      }),
      { numRuns: 75 }
    )
  })

  it('keeps signed URLs byte-for-byte unchanged', () => {
    const signedKey = fc.constantFrom('sign', 'token', 'auth_key', 'w_rid')
    const signedValue = fc.stringMatching(/^[a-zA-Z0-9_-]{1,24}$/)

    fc.assert(
      fc.property(signedKey, signedValue, (key, value) => {
        const source = `https://i0.hdslb.com/bfs/archive/cover.jpg?${key}=${value}`
        expect(getCoverImageUrl(source, { displayWidth: 248, dpr: 2 })).toBe(source)
      }),
      { numRuns: 50 }
    )
  })

  it('normalizes protocol-relative trusted URLs to HTTPS', () => {
    expect(
      getCoverImageUrl('//i0.hdslb.com/bfs/archive/cover.jpg?frame=1', {
        displayWidth: 44,
        dpr: 2
      })
    ).toBe('https://i0.hdslb.com/bfs/archive/cover.jpg@88w.webp?frame=1')
  })

  it('preserves an existing CDN transform', () => {
    const source = 'https://i0.hdslb.com/bfs/archive/cover.jpg@640w_360h_1c.webp?frame=1'
    expect(getCoverImageUrl(source, { displayWidth: 248, dpr: 2 })).toBe(source)
  })
})
