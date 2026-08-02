import { describe, it, expect } from 'vitest'
import { DIRS, dirsOf, randomRoadMasks } from '../src/roadAtlas'

describe('DIRS', () => {
  it('has 8 unit directions starting at north, going clockwise', () => {
    expect(DIRS).toHaveLength(8)
    expect(DIRS[0]).toEqual([0, -1])
    expect(DIRS[2]).toEqual([1, 0])
    expect(DIRS[4]).toEqual([0, 1])
    expect(DIRS[6]).toEqual([-1, 0])
  })

  it('contains only unit components', () => {
    for (const [dx, dy] of DIRS) {
      expect(Math.abs(dx)).toBeLessThanOrEqual(1)
      expect(Math.abs(dy)).toBeLessThanOrEqual(1)
      expect(dx === 0 && dy === 0).toBe(false)
    }
  })
})

describe('dirsOf', () => {
  it('returns nothing for an empty mask', () => {
    expect(dirsOf(0)).toHaveLength(0)
  })

  it('returns all 8 for a full mask', () => {
    expect(dirsOf(0xff)).toHaveLength(8)
  })

  it('returns north only for bit 0', () => {
    expect(dirsOf(0b0000_0001)).toEqual([[0, -1]])
  })

  it('returns east and west for a straight horizontal tile', () => {
    expect(dirsOf(0b0100_0100)).toEqual([[1, 0], [-1, 0]])
  })

  it('has popcount(mask) entries for every one of the 256 masks', () => {
    for (let m = 0; m < 256; m++) {
      let bits = 0
      for (let b = 0; b < 8; b++) if (m & (1 << b)) bits++
      expect(dirsOf(m)).toHaveLength(bits)
    }
  })
})

describe('randomRoadMasks', () => {
  it('returns one byte per cell', () => {
    expect(randomRoadMasks(960, 1)).toHaveLength(960)
  })

  it('is reproducible for a given seed', () => {
    expect(Array.from(randomRoadMasks(50, 4))).toEqual(Array.from(randomRoadMasks(50, 4)))
  })

  it('produces at least some non-empty tiles', () => {
    const masks = randomRoadMasks(500, 8)
    expect(masks.some((m) => m !== 0)).toBe(true)
  })
})
