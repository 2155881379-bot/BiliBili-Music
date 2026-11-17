import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { revealOffset, virtualWindow } from '../src/renderer/src/utils/virtual-window'

describe('virtual song window', () => {
  it('bounds rendered rows independently of list length and covers the viewport', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 1, max: 150 }),
      fc.integer({ min: 0, max: 20000000 }), fc.integer({ min: 1, max: 2000 }),
      (count, height, offset, viewport) => {
        const window = virtualWindow(count, height, offset, viewport)
        expect(window.start).toBeGreaterThanOrEqual(0)
        expect(window.end).toBeLessThanOrEqual(count)
        expect(window.end).toBeGreaterThanOrEqual(window.start)
        expect(window.top + (window.end - window.start) * height + window.bottom).toBe(count * height)
        expect(window.end - window.start).toBeLessThanOrEqual(Math.ceil(viewport / height) + 11)
        const clamped = Math.min(offset, Math.max(0, count * height - viewport))
        expect(window.top).toBeLessThanOrEqual(clamped)
        expect(window.end * height).toBeGreaterThanOrEqual(Math.min(count * height, clamped + viewport))
      }
    ), { seed: 20261117, numRuns: 1000 })
  })
  it('does not move a currently visible song on route activation', () => {
    expect(revealOffset(3, 437, 60, 100, 527)).toBe(100)
    expect(revealOffset(-1, 437, 60, 100, 527)).toBe(100)
    expect(revealOffset(400, 437, 60, 100, 527)).toBe(23766.5)
  })
  it('can reveal every song without overshooting either end', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 1000 }), (count, seed) => {
      const index = seed % count
      const next = revealOffset(index, count, 60, 0, 527)
      expect(next).toBeGreaterThanOrEqual(0)
      expect(next).toBeLessThanOrEqual(Math.max(0, count * 60 - 527))
      expect(next).toBeLessThanOrEqual(index * 60)
      expect(next + 527).toBeGreaterThanOrEqual((index + 1) * 60)
    }), { seed: 20261117, numRuns: 500 })
  })
})
