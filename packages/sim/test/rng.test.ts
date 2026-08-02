import { describe, it, expect } from 'vitest'
import { seedFromString, nextRandom, randomBelow } from '../src/rng'

function store(seed: number): Uint32Array {
  const s = new Uint32Array(1)
  s[0] = seed
  return s
}

describe('seedFromString', () => {
  it('is deterministic', () => {
    expect(seedFromString('laneways')).toBe(seedFromString('laneways'))
  })

  it('differs for different strings', () => {
    expect(seedFromString('a')).not.toBe(seedFromString('b'))
  })

  it('returns a uint32', () => {
    for (const s of ['', 'a', 'laneways', 'a much longer seed string 12345']) {
      const v = seedFromString(s)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffffffff)
    }
  })
})

describe('nextRandom', () => {
  it('produces the same sequence for the same seed', () => {
    const a = store(12345)
    const b = store(12345)
    for (let i = 0; i < 100; i++) expect(nextRandom(a, 0)).toBe(nextRandom(b, 0))
  })

  it('produces different sequences for different seeds', () => {
    expect(nextRandom(store(1), 0)).not.toBe(nextRandom(store(2), 0))
  })

  it('advances the caller-owned state', () => {
    const s = store(999)
    const before = s[0]
    nextRandom(s, 0)
    expect(s[0]).not.toBe(before)
  })

  it('restores its sequence when the state is restored', () => {
    const s = store(777)
    const first = [nextRandom(s, 0), nextRandom(s, 0), nextRandom(s, 0)]
    const saved = s[0] as number
    const afterSave = [nextRandom(s, 0), nextRandom(s, 0)]
    s[0] = saved
    expect([nextRandom(s, 0), nextRandom(s, 0)]).toEqual(afterSave)
    expect(first).toHaveLength(3)
  })

  it('always returns a uint32', () => {
    const s = store(42)
    for (let i = 0; i < 1000; i++) {
      const v = nextRandom(s, 0)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('honours the index so several independent streams can share one array', () => {
    const s = new Uint32Array([1000, 2000])
    const a0 = nextRandom(s, 0)
    const b0 = nextRandom(s, 1)
    expect(a0).not.toBe(b0)
    const s2 = new Uint32Array([1000, 2000])
    expect(nextRandom(s2, 1)).toBe(b0)
  })
})

describe('randomBelow', () => {
  it('stays within range', () => {
    const s = store(5)
    for (let i = 0; i < 2000; i++) {
      const v = randomBelow(s, 0, 7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
    }
  })

  it('returns 0 for a bound of 1 without consuming randomness', () => {
    const s = store(5)
    const before = s[0]
    expect(randomBelow(s, 0, 1)).toBe(0)
    expect(s[0]).toBe(before)
  })

  it('returns 0 for a bound of 0 rather than NaN or a throw', () => {
    const s = store(5)
    expect(randomBelow(s, 0, 0)).toBe(0)
  })

  it('is unbiased across a bound that does not divide 2^32', () => {
    // 2^32 % 3 !== 0, so a naive `next() % 3` over-represents 0 and 1.
    // With 60000 draws the expected count per bucket is 20000; a naive modulo
    // would not shift this enough to fail at 5%, so this test is a smoke check
    // on gross skew, not a proof. The rejection loop is the actual guarantee.
    const s = store(31337)
    const counts = [0, 0, 0]
    const N = 60000
    for (let i = 0; i < N; i++) counts[randomBelow(s, 0, 3)]!++
    for (const c of counts) {
      expect(c).toBeGreaterThan(N / 3 * 0.95)
      expect(c).toBeLessThan(N / 3 * 1.05)
    }
  })

  it('is deterministic for a given seed', () => {
    const a = store(2024)
    const b = store(2024)
    for (let i = 0; i < 50; i++) expect(randomBelow(a, 0, 13)).toBe(randomBelow(b, 0, 13))
  })
})
