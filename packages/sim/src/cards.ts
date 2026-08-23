import { mixWord } from './rng'
import type { GameState } from './state'

/**
 * §5.10's card pool and its non-consuming weekly draw.
 * **The offer slots live in the header and this module is their only writer.**
 *
 * Card ids are the SIX in §5.10's table plus **one M1f adds**, declared in full
 * rather than only the two M1f can offer, because they are an enumeration of a
 * documented domain rather than speculative configuration. What keeps the five
 * unimplemented ones out of play is `CARD_IMPLEMENTED_MASK` (M1f Task 11) — a
 * scope gate with a named owner — and not their absence.
 *
 * **`CARD_ROUNDABOUT` is one of the five, and it is declared for a specific
 * reason.** M1f measured that on the shipped board five of the six cells that
 * actually jam admit no legal 3x3 roundabout centre at any tick, so the item was
 * removed from the milestone rather than from the domain. M1g owns the geometry
 * question; the id costs nothing and its absence would read as a decision nobody
 * made.
 *
 * **`CARD_TRAFFIC_LIGHTS` is another, for the same shape of reason and a
 * different measurement.** M1f built §5.6's demand-actuated light in a throwaway
 * spike and measured it against its own control: a fixed alternating light scores
 * -13 % on trips at its best seat phase and -17 % at the median, and this
 * milestone's own specified controller scores -38 %, because
 * `minimumNearbyCarsBeforeSwapping` = 2 within 2 tiles is essentially never
 * satisfied on a board carrying about eleven cars in flight. The light is
 * deferred to M1g with those numbers; `CARD_JUNCTION_UPGRADE` is what M1f ships
 * in its place.
 *
 * `CARD_NONE = 0` is load-bearing: `H_OFFER_A`/`H_OFFER_B` are zero-initialised
 * and must read as "no offer" without `createState` writing a sentinel.
 *
 * **This module's only runtime import is `mixWord`**, and its `GameState` import
 * is type-only, so `state.ts -> cards.ts` can never become a module-evaluation
 * cycle in either direction. That is deliberate: `state.ts` is imported by nearly
 * every file in this package, and M1f Task 1 already paid for a real cycle here
 * (`roads.ts -> dispatch.ts -> scratch.ts -> roads.ts`) with a module-scope mask
 * that evaluated to 0. Nothing at this module's top level reads an imported
 * value; every constant below is a literal.
 */

export const CARD_NONE = 0
export const CARD_ROAD_TILES = 1
export const CARD_BRIDGE = 2
export const CARD_TUNNEL = 3
export const CARD_ROUNDABOUT = 4
export const CARD_TRAFFIC_LIGHTS = 5
export const CARD_MOTORWAY = 6
/**
 * M1f's own item, and the only one here that is NOT a row of spec §5.10's table.
 *
 * §5.6's TRAFFIC LIGHT is id 5 above, declared and excluded by
 * `CARD_IMPLEMENTED_MASK` like the roundabout, because M1f built it, measured it
 * and deferred it (M1f plan, Amendment 2 and Decision 14: a fixed light measures
 * -13 % against its control and this plan's own demand controller -38 %, on a
 * board carrying about eleven cars in flight). A JUNCTION UPGRADE takes its place
 * in the pool and inherits its grant row — "2 items for 20 tiles", which is the
 * TRAFFIC LIGHTS row of §5.10's table specifically and not the table's general
 * rate (Tunnel, Roundabout and Motorway grant 1) — and does one thing: the
 * junction mutual-exclusion rule does not apply at its cell.
 *
 * It is a NEW id rather than a rename of 5, so §5.10's documented six-item domain
 * stays intact and the deferral reads as an interlock rather than an absence.
 */
export const CARD_JUNCTION_UPGRADE = 7
/** One past the highest card id. The pool bitmask is `CARD_COUNT` bits wide; bit 0 is never set. */
export const CARD_COUNT = 8

export const OFFER_SLOT_A = 0
export const OFFER_SLOT_B = 1

/**
 * A well-mixed word for `week`'s offer, derived from the seed **without
 * advancing it**.
 *
 * The golden-ratio odd constant decorrelates adjacent weeks before mixing, so
 * weeks 1 and 2 do not produce neighbouring inputs to a function that is only an
 * avalanche and not a stream. `week + 1` rather than `week` so week 0 — which has
 * no offer — is not the identity case.
 *
 * **Why not `nextRandom`:** measured, one draw per week boundary moves the greedy
 * arm's death tick 31,456 -> 34,088, freezes `spawn.test.ts` at 2,640,000 and
 * fails Gate C, because every downstream consumer shifts by one. `spawnScanStart`
 * (spawn.ts) reads the word the same way for the same reason.
 * `determinism.test.ts` bans the alternative outright, in both directions: a
 * source scan over every file but `rng.ts`, and a behavioural test that runs
 * 13,500 live ticks across three week boundaries and asserts the word did not
 * move.
 */
export function offerSeedFor(state: GameState, week: number): number {
  return mixWord(((state.rng[0] as number) ^ Math.imul(week + 1, 0x9e3779b1)) >>> 0)
}

/** How many cards a pool bitmask holds. */
export function popCountCards(mask: number): number {
  let n = 0
  for (let b = 0; b < CARD_COUNT; b++) if ((mask & (1 << b)) !== 0) n++
  return n
}

/**
 * Can an offer be drawn from this pool at all?
 *
 * **The predicate `drawOfferPair` throws on, exported so `runOffer` (M1f Task 5)
 * reads the same one rather than restating "at least two".** Two copies of a
 * threshold can disagree, and the way this one would disagree is the worst
 * available: `runOffer` guards with a condition that is subtly weaker,
 * `drawOfferPair` throws inside `step` AFTER `H_EPOCH` is written, and the buffer
 * is poisoned permanently — `restore` then refuses it. One predicate, one
 * caller for the guard and one for the assertion.
 */
export function canDrawOfferPair(pool: number): boolean {
  return popCountCards(pool) >= 2
}

/**
 * The `k`-th set bit of `mask`, counting from 0.
 *
 * Throws rather than returning -1 or 0: a caller that has already asked
 * `popCountCards` cannot legitimately be past the end, and both plausible
 * sentinels are valid card ids or read as one (`CARD_NONE`).
 */
export function nthSetBit(mask: number, k: number): number {
  let seen = 0
  for (let b = 0; b < CARD_COUNT; b++) {
    if ((mask & (1 << b)) === 0) continue
    if (seen === k) return b
    seen++
  }
  throw new Error(`cards: asked for set bit ${k} of pool ${mask}, which has only ${seen} set bits`)
}

/**
 * Fills `out[0]`/`out[1]` with two DISTINCT card ids drawn from `pool`.
 *
 * **Rejection sampling, over a bitmask, with no array.** A plain modulo
 * over-represents the low card ids whenever the pool size does not divide 2^32,
 * and a skewed offer distribution is invisible in play while quietly invalidating
 * every balance measurement built on it. `no-module-mutable-state` forbids a
 * module-scope candidate array and a local one allocates on a per-tick path, so
 * the pool IS the array and `nthSetBit` is the index.
 *
 * `out` is caller-owned and length 2. Slot A is drawn first from the whole pool;
 * slot B from the pool with A's bit cleared, which is what makes the two distinct
 * **by construction** rather than by a retry loop that could spin.
 *
 * **The `mixWord` between the two picks is a PROVABLY EQUIVALENT line, and it is
 * labelled so nobody deletes it on the strength of its own survival.** Removing
 * it scores 0 detectors over the whole suite, and unlike most 0-detector results
 * that is not a coverage hole: slot A indexes by `word % n` and slot B by
 * `word % (n - 1)`, `gcd(n, n - 1) = 1` for every `n`, so by the Chinese
 * remainder theorem the two indices are independent and all `n(n - 1)` ordered
 * pairs are reachable from a single word. Brute-forced for n = 2, 3, 4, 6, 8:
 * 2/2, 6/6, 12/12, 30/30, 56/56 pairs. **No test can distinguish the two, and
 * the axes were enumerated before that sentence was written** rather than after.
 *
 * It is kept because the equivalence is a property of "the second pool is
 * exactly one card smaller", which a third slot or a weighted pool would end —
 * and at that point the re-mix is load-bearing and its absence would be a real,
 * silent bias. One line against a whole class of future defect.
 *
 * **The `n < 2` throw is a programming-error guard and `runOffer` must never
 * reach it.** Call `canDrawOfferPair` — the same predicate — and degrade the
 * week instead. A throw inside `step` after `H_EPOCH` is written poisons the
 * buffer permanently, which is what the previous design did on a 4x4 golden
 * fixture at tick 4,500 of a 13,499-tick run.
 */
export function drawOfferPair(pool: number, seed: number, out: Int32Array): void {
  const n = popCountCards(pool)
  if (n < 2) {
    throw new Error(`cards: an offer needs at least two cards, and pool ${pool} holds ${n}`)
  }
  let word = seed >>> 0
  const a = pickFromPool(pool, n, word)
  out[0] = a
  word = mixWord(word)
  const rest = pool & ~(1 << a)
  out[1] = pickFromPool(rest, n - 1, word)
}

/**
 * One unbiased card from `pool`, which holds exactly `n` cards, starting from
 * `word`. Exported for the rejection path's own test — the bound at which
 * rejection actually happens is unreachable from `drawOfferPair`'s two- to
 * six-card pools in any realistic number of draws.
 *
 * **The loop is unbounded, and the reason it cannot hang is enumerated rather
 * than argued.** `randomBelow`'s identical-looking loop is safe because
 * `nextRandom` advances a counter by `0x6d2b79f5` and therefore walks the full
 * 2^32 period; this function has no counter, and re-mixing a word with a
 * stateless transform could in principle cycle. So the safety is established the
 * only way that settles it: the loop is entered only for `v >= limit`, there are
 * exactly `2^32 % n` such values for each `n`, and summed over every `n` this
 * module can produce (1..`CARD_COUNT`) that is **ten** starting points in total.
 * `cards.test.ts` walks all ten and asserts each escapes. An infinite loop inside
 * `step` would be worse than the throw above.
 */
export function pickFromPool(pool: number, n: number, word: number): number {
  const limit = 0x100000000 - (0x100000000 % n)
  let v = word >>> 0
  while (v >= limit) v = mixWord(v)
  return nthSetBit(pool, v % n)
}
