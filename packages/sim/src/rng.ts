/**
 * Seeded PRNG for the simulation.
 *
 * State lives in caller-owned storage rather than a closure, so it can sit
 * inside the snapshot buffer. Restoring a snapshot therefore restores the
 * random sequence exactly, with no separate save path.
 *
 * mulberry32: 32 bits of state, good statistical quality at this size, and
 * every operation is an integer op that ECMAScript specifies exactly — so it
 * yields identical results on any conforming engine.
 */

/** xmur3 string hash. Produces a well-mixed uint32 seed from any string. */
export function seedFromString(s: string): number {
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

/** Advances the stream at `store[i]` and returns the next uint32. */
export function nextRandom(store: Uint32Array, i: number): number {
  let t = (store[i] = (((store[i] as number) + 0x6d2b79f5) | 0) >>> 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0)
}

/**
 * Unbiased integer in [0, bound). Uses rejection sampling: a plain modulo
 * over-represents the low end whenever `bound` does not divide 2^32, and a
 * skewed spawn or choice distribution is close to invisible in play while
 * quietly invalidating every balance measurement built on it.
 */
export function randomBelow(store: Uint32Array, i: number, bound: number): number {
  if (bound <= 1) return 0
  const limit = 0x100000000 - (0x100000000 % bound)
  let v = nextRandom(store, i)
  while (v >= limit) v = nextRandom(store, i)
  return v % bound
}
