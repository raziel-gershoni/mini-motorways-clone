import { describe, it, expect } from 'vitest'
import { seedFromString, mixWord, nextRandom, randomBelow } from '../src/rng'

function store(seed: number): Uint32Array {
  const s = new Uint32Array(1)
  s[0] = seed
  return s
}

/** The first `n` draws from a fresh store seeded with `seed`. */
function seqOf(seed: number, n = 8): number[] {
  const s = store(seed)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(nextRandom(s, 0))
  return out
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

/**
 * **The literal sequence golden, and it did not exist before M1f Task 4.**
 *
 * Every other test in this file is self-referential — "the same seed gives the
 * same sequence", "a different seed gives a different one", "a restored state
 * restores the sequence". All of them stay green under any change to the output
 * transform that is applied consistently, which is precisely the class of change
 * Task 4 makes when it extracts `mixWord` out of `nextRandom`. The whole-buffer
 * goldens cannot cover it either: they fold `rng[0]`, which is the ADVANCED WORD
 * and is computed before the transform runs, so breaking the transform moves no
 * digest in the repo.
 *
 * So these literals were captured from the tree at commit `41051cb`, BEFORE the
 * extraction, and they are what makes "the extraction is output-preserving" a
 * measurement rather than a claim. `randomBelow`'s row is here for the same
 * reason one layer up: it consumes `nextRandom` and its rejection loop would
 * hide a small transform change behind a modulo.
 */
describe('the sequence golden', () => {
  it('reproduces the exact uint32 sequence three seeds produced before mixWord was extracted', () => {
    expect(seqOf(12345)).toEqual([
      4207900869, 1317490944, 2079646450, 3513001552, 2187978186, 1492380277, 316786230, 3291647763,
    ])
    expect(seqOf(1)).toEqual([
      2693262067, 11749833, 2265367787, 4213581821, 4159151403, 1207330352, 2632122864, 3095568220,
    ])
    expect(seqOf(0xdeadbeef)).toEqual([
      4043151706, 1147597007, 3315858022, 1538288752, 2042435954, 3600176436, 484360372, 1362401224,
    ])
  })

  it('reproduces randomBelow(6) over the same window, so the rejection loop is pinned too', () => {
    const s = store(42)
    const out: number[] = []
    for (let i = 0; i < 12; i++) out.push(randomBelow(s, 0, 6))
    expect(out).toEqual([0, 4, 0, 5, 0, 3, 4, 5, 0, 3, 3, 1])
  })

  it('leaves the store where it left it, so the ADVANCE is pinned beside the TRANSFORM', () => {
    // The two halves of `nextRandom` fail independently: the advance is
    // `+0x6d2b79f5` on the stored word and the transform is `mixWord` on the
    // result. A golden on the returned values alone would not see the advance
    // change, and one on the store alone would not see the transform change.
    const s = store(12345)
    for (let i = 0; i < 8; i++) nextRandom(s, 0)
    expect(s[0]).toBe(1767636961)
  })
})

describe('mixWord', () => {
  it('is exactly the transform nextRandom applies to its advanced word', () => {
    const s = store(12345)
    const advanced = ((12345 + 0x6d2b79f5) | 0) >>> 0
    expect(advanced, 'the advance itself, hand-computed').toBe(1831578158)
    expect(nextRandom(s, 0)).toBe(mixWord(advanced))
    expect(s[0], 'and nextRandom advanced the store while mixWord touched nothing').toBe(advanced)
  })

  it('is a pure function of its argument: no store, no state, idempotent', () => {
    expect(mixWord(0)).toBe(mixWord(0))
    expect(mixWord(1831578158)).toBe(4207900869)
  })

  it('returns a uint32 for every input including the extremes', () => {
    for (const v of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, -1, 2 ** 32]) {
      const r = mixWord(v)
      expect(Number.isInteger(r), `mixWord(${v})`).toBe(true)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('avalanches: flipping one input bit changes many output bits', () => {
    // Not decoration — `offerSeedFor` (cards.ts, M1f Task 4) derives the whole
    // weekly offer from `mixWord(rng[0] ^ imul(week + 1, GOLDEN))`, and adjacent
    // weeks differ in few input bits. A transform that merely permuted bits
    // would satisfy every other test in this file.
    for (let bit = 0; bit < 32; bit++) {
      const a = mixWord(0x1234abcd)
      const b = mixWord((0x1234abcd ^ (1 << bit)) >>> 0)
      let x = (a ^ b) >>> 0
      let bits = 0
      while (x !== 0) {
        bits += x & 1
        x >>>= 1
      }
      expect(bits, `flipping input bit ${bit} moved only ${bits} output bits`).toBeGreaterThan(5)
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

  it('validates the stream index even at a degenerate bound, which returns before drawing', () => {
    // The `bound <= 1` early return sits above every call into `nextRandom`,
    // so with the index guard left to `nextRandom` alone this returned 0 for
    // ANY index, valid or not. A miswired hand-computed stream index would
    // then stay silent for exactly as long as the bound happened to be
    // degenerate — one destination of a colour, one spawn candidate — which
    // is the start of a run, and the cheapest moment to catch it.
    const s = store(5)
    expect(() => randomBelow(s, 999, 1)).toThrow(RangeError)
    expect(() => randomBelow(s, 999, 1)).toThrow(/stream index 999 out of range \(length 1\)/)
    expect(() => randomBelow(s, 999, 0)).toThrow(RangeError)
    expect(() => randomBelow(s, -1, 1)).toThrow(RangeError)
    expect(() => randomBelow(s, 1.5, 1)).toThrow(RangeError)
    // Still validated at a real bound, where it always was — via nextRandom
    // then, via the hoisted guard now.
    expect(() => randomBelow(s, 999, 7)).toThrow(RangeError)
    // And the valid-index path is untouched: no throw, no draw consumed.
    const before = s[0]
    expect(randomBelow(s, 0, 1)).toBe(0)
    expect(s[0]).toBe(before)
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
