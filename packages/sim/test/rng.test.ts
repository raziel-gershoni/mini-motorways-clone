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
    // Advance off the initial state first, so what is saved and restored is a
    // mid-stream position rather than the seed.
    for (let i = 0; i < 3; i++) nextRandom(s, 0)
    const saved = s[0] as number
    const afterSave = [nextRandom(s, 0), nextRandom(s, 0)]
    s[0] = saved
    expect([nextRandom(s, 0), nextRandom(s, 0)]).toEqual(afterSave)
  })

  it('throws on an index outside the store rather than returning 0 forever', () => {
    // `store[i]` out of range is undefined, undefined + 0x6d2b79f5 is NaN, and
    // NaN | 0 is 0 — so without the guard the stream returns 0 for every
    // subsequent call, silently, and presents as a balance mystery.
    const s = store(1)
    expect(() => nextRandom(s, 1)).toThrow(RangeError)
    expect(() => nextRandom(s, 1)).toThrow(/stream index 1 out of range \(length 1\)/)
    expect(() => nextRandom(s, -1)).toThrow(RangeError)
    expect(() => nextRandom(new Uint32Array(2), 2)).toThrow(RangeError)
  })

  it('throws on a non-integer index, which fails the same way', () => {
    expect(() => nextRandom(new Uint32Array(4), 1.5)).toThrow(RangeError)
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

  it('is unbiased at a bound chosen so naive modulo would visibly fail', () => {
    // Bound just above 2^31, where modulo bias is near maximal.
    //   B = 0xA0000000, r = 2^32 - B = 0x60000000
    // Uniform over [0, B):        P(x < r) = r/B      = 0.60
    // Naive `next() % B`:         P(x < r) = 2r/2^32  = 0.75
    // ~43 standard errors apart at N = 20000, so this cannot pass by chance.
    // The earlier version of this test used bound = 3, where 2^32 % 3 = 1 and
    // the bias touches one value in 4.29 billion — undetectable, and therefore
    // decorative. Do not lower this bound.
    const B = 0xa0000000
    const r = 0x100000000 - B
    const s = store(31337)
    const N = 20000
    let below = 0
    for (let i = 0; i < N; i++) if (randomBelow(s, 0, B) < r) below++
    const fraction = below / N
    expect(fraction).toBeGreaterThan(0.58)
    expect(fraction).toBeLessThan(0.62)
  })

  it('still respects the range at that bound', () => {
    const B = 0xa0000000
    const s = store(4242)
    for (let i = 0; i < 5000; i++) {
      const v = randomBelow(s, 0, B)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(B)
    }
  })

  it('is deterministic for a given seed', () => {
    const a = store(2024)
    const b = store(2024)
    for (let i = 0; i < 50; i++) expect(randomBelow(a, 0, 13)).toBe(randomBelow(b, 0, 13))
  })
})
