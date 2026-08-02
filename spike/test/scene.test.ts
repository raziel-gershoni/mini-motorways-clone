import { describe, it, expect } from 'vitest'
import { mulberry32, makeScene, advance } from '../src/scene'

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('differs across seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })

  it('stays within [0, 1)', () => {
    const r = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('makeScene', () => {
  it('produces the requested number of sprites', () => {
    expect(makeScene(400, 300, 600, 1)).toHaveLength(400)
  })

  it('is reproducible for a given seed', () => {
    expect(makeScene(10, 300, 600, 99)).toEqual(makeScene(10, 300, 600, 99))
  })

  it('places every sprite inside the bounds', () => {
    for (const s of makeScene(200, 300, 600, 5)) {
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(300)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThanOrEqual(600)
      expect(s.group).toBeGreaterThanOrEqual(0)
      expect(s.group).toBeLessThan(5)
    }
  })
})

describe('advance', () => {
  it('moves a sprite by velocity times dt', () => {
    const s = [{ x: 10, y: 10, vx: 100, vy: 0, group: 0 }]
    advance(s, 0.1, 300, 600)
    expect(s[0]!.x).toBeCloseTo(20, 10)
  })

  it('reflects off the left wall and keeps the sprite in bounds', () => {
    const s = [{ x: 1, y: 10, vx: -100, vy: 0, group: 0 }]
    advance(s, 0.1, 300, 600)
    expect(s[0]!.x).toBe(0)
    expect(s[0]!.vx).toBe(100)
  })

  it('reflects off the bottom wall', () => {
    const s = [{ x: 10, y: 599, vx: 0, vy: 100, group: 0 }]
    advance(s, 0.1, 300, 600)
    expect(s[0]!.y).toBe(600)
    expect(s[0]!.vy).toBe(-100)
  })

  it('keeps all sprites in bounds over many steps', () => {
    const s = makeScene(100, 300, 600, 3)
    for (let i = 0; i < 500; i++) advance(s, 1 / 60, 300, 600)
    for (const sp of s) {
      expect(sp.x).toBeGreaterThanOrEqual(0)
      expect(sp.x).toBeLessThanOrEqual(300)
      expect(sp.y).toBeGreaterThanOrEqual(0)
      expect(sp.y).toBeLessThanOrEqual(600)
    }
  })
})
