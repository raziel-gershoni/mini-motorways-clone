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

/**
 * The stream-index guard, shared by both public draws rather than written
 * twice — the two must not be able to disagree about what a valid index is.
 *
 * It is not defensive padding. Without it an out-of-range index reads
 * `undefined`, `undefined + 0x6d2b79f5` is `NaN`, `NaN | 0` is `0`, and the
 * stream returns 0 forever — `randomBelow` with it. A permanently dead
 * generator presents as a balance mystery, never as a crash, and M1c wires
 * several streams by hand-computed index. A non-integer index fails the same
 * way, so it is rejected here too.
 *
 * The message names neither caller: it is one rule with one wording, and the
 * stack trace already says which entry point hit it.
 */
function assertStreamIndex(store: Uint32Array, i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= store.length) {
    throw new RangeError(`rng: stream index ${i} out of range (length ${store.length})`)
  }
}

/**
 * mulberry32's OUTPUT TRANSFORM, with no state. `nextRandom` is exactly this
 * applied to the advanced word.
 *
 * **Extracted at M1f Task 4 so there is one copy of this arithmetic rather than
 * two.** The weekly offer needs a well-mixed value from the seed word and the
 * week WITHOUT advancing the stream — see `offerSeedFor` (cards.ts) and
 * `determinism.test.ts`'s ban on `nextRandom`/`randomBelow` outside this file.
 *
 * **The extraction is output-preserving and `rng.test.ts`'s sequence golden is
 * the proof**, not this comment: the previous body assigned the advanced word to
 * a local and applied these three statements to it in place, which is what this
 * function does to its parameter.
 *
 * **And that golden did not exist until this extraction was written.** Every
 * other test in `rng.test.ts` is self-referential — same seed, same sequence —
 * and stays green under any consistently-applied change to these three lines;
 * no whole-buffer golden covers them either, because the digests fold the
 * ADVANCED WORD, which is computed before this function runs. The literals were
 * captured at commit `2f23647`, one commit before this one.
 */
export function mixWord(t0: number): number {
  let t = t0 >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return (t ^ (t >>> 14)) >>> 0
}

/** Advances the stream at `store[i]` and returns the next uint32. */
export function nextRandom(store: Uint32Array, i: number): number {
  assertStreamIndex(store, i)
  const t = (store[i] = (((store[i] as number) + 0x6d2b79f5) | 0) >>> 0)
  return mixWord(t)
}

/**
 * Unbiased integer in [0, bound). Uses rejection sampling: a plain modulo
 * over-represents the low end whenever `bound` does not divide 2^32, and a
 * skewed spawn or choice distribution is close to invisible in play while
 * quietly invalidating every balance measurement built on it.
 *
 * **The index is validated ABOVE the `bound <= 1` early return, not left to
 * `nextRandom`.** Below it, `randomBelow(store, 999, 1)` returned 0 and never
 * reached the generator at all, so a hand-computed stream index that is
 * simply wrong stayed silent for exactly as long as the bound happened to be
 * degenerate — which is the common case at the start of a run (one
 * destination of a colour, one spawn candidate) and the point at which a
 * miswired index is cheapest to notice. M1c wires several streams by
 * hand-computed index, so the guard must not depend on the bound.
 */
export function randomBelow(store: Uint32Array, i: number, bound: number): number {
  assertStreamIndex(store, i)
  if (bound <= 1) return 0
  const limit = 0x100000000 - (0x100000000 % bound)
  let v = nextRandom(store, i)
  while (v >= limit) v = nextRandom(store, i)
  return v % bound
}
