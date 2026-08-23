import { CARD_GRANT_ITEM, CARD_GRANT_ROAD_TILES, UPGRADES_PER_CARD } from '@laneways/shared'
import { mixWord } from './rng'
import type { GameState } from './state'
import {
  offerPending,
  H_INV_UPGRADES,
  H_OFFER_A,
  H_OFFER_B,
  H_OFFER_WEEK,
  H_TILES,
  H_WEEK,
} from './state'
import type { WorldData } from './world'
import type { Scratch } from './scratch'

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
 * **This module's runtime imports are `mixWord`, three grant constants from
 * `@laneways/shared`, and SEVEN names from `state.ts` — and the `state.ts` edge
 * is ONE-WAY.** Until M1f Task 5 the only runtime import was `mixWord`; wiring
 * phase 4 made this module a writer of the header, so it took `offerPending` and
 * four slot indices, and M1f Task 6's `applyChooseCard` added `H_TILES` and
 * `H_INV_UPGRADES` plus the three §5.10 grants. `@laneways/shared` is a leaf: it
 * imports nothing from this package, so that edge cannot close a cycle at all.
 * **`state.ts` still imports nothing from here at run time and must not start** — `offerSlot` returns the
 * literal `0` rather than `CARD_NONE` precisely to keep the direction clean, and
 * `cards.test.ts` pins `CARD_NONE === 0` so the two cannot drift. `state.ts` is
 * imported by nearly every file in this package, so a back-edge would close a
 * cycle through most of it; M1f Task 1 already paid for one (`roads.ts ->
 * dispatch.ts -> scratch.ts -> roads.ts`) with a module-scope mask that evaluated
 * to 0. The `WorldData` and `Scratch` imports are TYPE-ONLY and erase.
 *
 * **Nothing at this module's top level reads an IMPORTED value, and Task 6's
 * three shared constants did not change that.** `CARD_IMPLEMENTED_MASK` is built
 * from two `const` declarations in this file; every other constant below is a
 * literal; and `CARD_GRANT_ROAD_TILES`/`CARD_GRANT_ITEM`/`UPGRADES_PER_CARD` are
 * read inside function bodies, never at module scope. That is the property the Task 1 defect
 * violated, and it is the one that has to survive this module gaining imports.
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

/**
 * The set of cards this map and this build can offer, as a bitmask.
 *
 * **Two filters with two reasons, and M1f Task 11 lands the first one.** Until
 * then this is the second filter alone: `CARD_IMPLEMENTED_MASK`, M1f's scope
 * boundary. An offerable card with no placement mechanism is dead configuration
 * that reads as support; this constant is the interlock that stops one shipping,
 * and M1g deletes bits from it.
 *
 * **Declared HERE, twelve lines under the ids it is built from, and that
 * position is the point.** M1f Task 1 shipped a module-scope mask computed from
 * an IMPORTED value inside a real cycle (`roads.ts -> dispatch.ts -> scratch.ts
 * -> roads.ts`); the import evaluated to `undefined`, the mask came out 0, and it
 * failed loudly only by luck of polarity. Both operands here are `const`
 * declarations in this same module — there is no import to be half-initialised —
 * and `cards.test.ts` asserts the value is non-zero beside the derivation anyway,
 * because "it cannot happen here" is what the other one's author would have said.
 */
export const CARD_IMPLEMENTED_MASK = (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE)

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
 *
 * ---------------------------------------------------------------------------
 * **THE `| 0` IS AN ALLOCATION FIX AND IT WAS MEASURED, NOT GUESSED — M1f
 * TASK 5.**
 * ---------------------------------------------------------------------------
 *
 * The word is a full 32 bits and the `>>> 0` makes it UNSIGNED, so for half its
 * range the value is above `2^31 - 1`, outside V8's Smi range, and **returning
 * it allocates a HeapNumber.** That cost nothing while this function had no
 * production caller. Task 5 made it phase 4, which runs on every tick of an
 * unresolved week — and `allocation.test.ts`'s Task 12 window (three 4,600-tick
 * windows from tick 6,000, 4 B/tick budget over the whole `packages/sim/src`
 * scope) went red at **15.8 / 17.8 / 10.1 B/tick charged to `cards.ts`**, in all
 * three windows, reproducibly. One 16-byte HeapNumber per tick.
 *
 * **It was bisected rather than reasoned about, and the first two hypotheses
 * were both wrong.** Returning early scores 0; `offerPending` alone scores 0;
 * the whole draw with a Smi seed — `tryDrawOfferPair`, `drawOfferPair`,
 * `pickFromPool`, `nthSetBit`, `mixWord` — also scores **0**, so none of the
 * arithmetic below allocates. Narrowing the `rng[0]` READ with a `| 0` (a
 * `Uint32Array` element is also above Smi range for half its values) leaves the
 * window red at 15.6 / 22.3 / 10.5. Only narrowing the RETURN clears it. A tight
 * `for` loop over this function measures 0.37 B/call and would have said there
 * was nothing here at all: escape analysis deletes the box when the caller is
 * inlined, which is exactly the shape of blindness the brief warns about for
 * `const __sink`.
 *
 * **The bits are unchanged and no behaviour moves with them.** `| 0`
 * reinterprets the same 32 bits as signed; the only consumer is
 * `drawOfferPair`, whose first statement is `seed >>> 0`. Every golden, every
 * pair and every distribution is identical — `cards.test.ts` asserts the
 * round trip directly rather than leaving that as a claim.
 */
export function offerSeedFor(state: GameState, week: number): number {
  return mixWord(((state.rng[0] as number) ^ Math.imul(week + 1, 0x9e3779b1)) >>> 0) | 0
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
 * **The predicate `drawOfferPair` throws on, exported so the offer path reads the
 * same one rather than restating "at least two".** Two copies of a threshold can
 * disagree, and the way this one would disagree is the worst available: the
 * caller guards with a condition that is subtly weaker, `drawOfferPair` throws
 * inside `step` AFTER `H_EPOCH` is written, and the buffer is poisoned
 * permanently — `restore` then refuses it. One predicate, one caller for the
 * guard and one for the assertion.
 *
 * **M1f Task 5 narrowed "one caller for the guard" from a convention to a
 * structure.** Exporting the predicate made the safe path AVAILABLE; it did not
 * make it the only one, and `runOffer` was specified as a separate
 * `popCountCards(pool) < 2` test — a second copy of the threshold, in the one
 * function whose whole obligation is not to reach the throw. `tryDrawOfferPair`
 * below welds the guard to the draw, so the offer path has no threshold of its
 * own to weaken, and `cards.test.ts` scans this module to keep it that way.
 */
export function canDrawOfferPair(pool: number): boolean {
  return popCountCards(pool) >= 2
}

/**
 * Draw a pair if the pool can supply one, and say so. **The guard and the draw
 * are ONE call, which is the whole reason this function exists.**
 *
 * `canDrawOfferPair` shares the predicate `drawOfferPair` throws on, but sharing
 * it does not force its use: a caller can still write its own test, get it
 * subtly wrong, and reach a throw inside `step` after `H_EPOCH` is written. Here
 * there is no second test to get wrong — the branch and the draw are the same
 * expression, and the caller's only remaining job is to react to a boolean.
 *
 * **The refusal path clears `out` rather than leaving it alone, so the unsafe
 * use produces the safe VALUE.** A caller that ignored the return would
 * otherwise publish whatever the buffer already held, which on the second week
 * of a degraded run is last week's real cards — a plausible offer for a pool
 * that cannot make one. It writes `CARD_NONE`/`CARD_NONE` instead. This does
 * **not** make ignoring the boolean correct: the week would stay unresolved and
 * `game`'s frame driver would pause behind an empty modal forever, which is a
 * different failure and `runOfferFromPool`'s business. One failure instead of
 * two is worth one line.
 *
 * Allocates nothing: `out` is caller-owned, exactly as `drawOfferPair`'s is.
 */
export function tryDrawOfferPair(pool: number, seed: number, out: Int32Array): boolean {
  if (!canDrawOfferPair(pool)) {
    out[OFFER_SLOT_A] = CARD_NONE
    out[OFFER_SLOT_B] = CARD_NONE
    return false
  }
  drawOfferPair(pool, seed, out)
  return true
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
 * ---------------------------------------------------------------------------
 * **THE `mixWord` BETWEEN THE TWO PICKS. THIS PARAGRAPH USED TO CALL IT
 * "PROVABLY EQUIVALENT" AND THAT WAS FALSE — CORRECTED AT M1f TASK 5, BY
 * MEASUREMENT.**
 * ---------------------------------------------------------------------------
 *
 * What it said: *"Removing it scores 0 detectors over the whole suite, and
 * unlike most 0-detector results that is not a coverage hole ... No test CAN
 * distinguish the two."* Two of those three clauses were right and the load-
 * bearing one was not.
 *
 * **The line is pointwise equivalent on a TWO-card pool and on nothing else.**
 * Measured over 20,000 seeds, comparing the pair with the re-mix against the
 * pair without it:
 *
 * ```
 *   n = 2 (the shipped pool)        0 / 20,000 seeds differ
 *   n = 3                       9,954 / 20,000 differ
 *   n = 4                      13,320 / 20,000 differ
 *   n = 6                      15,896 / 20,000 differ
 * ```
 *
 * At `n = 2` slot B has exactly one candidate — `v % 1` is 0 whatever the word —
 * so the second pick cannot see its input at all. That is the whole of the
 * equivalence, and it is a property of the POOL SIZE rather than of the
 * arithmetic. The Chinese-remainder argument the old paragraph gave is still
 * true and still worth keeping, but it is a statement about REACHABILITY — all
 * `n(n - 1)` ordered pairs are reachable from a single word, brute-forced at
 * n = 2, 3, 4, 6, 8: 2/2, 6/6, 12/12, 30/30, 56/56 — and reachability of the
 * same SET is not identity of the MAPPING. Reading one as the other is how
 * "provably equivalent" got written.
 *
 * **What that changes for a reader of a moved golden.** The whole-buffer goldens
 * now fold `H_OFFER_A`/`H_OFFER_B` (M1f Task 5), so they DO see this function's
 * output — but only through `poolFor`, which is two cards, so deleting the
 * re-mix still moves no golden. `cards.test.ts` pins one `(pool, seed) -> pair`
 * on a THREE-card pool instead, which is the smallest fixture that can see the
 * line at all. Do not diagnose a moved golden as this line: on the shipped pool
 * it cannot be.
 *
 * It is kept because the equivalence expires the moment the pool grows past two
 * — which `CARD_IMPLEMENTED_MASK` is scheduled to do as M1g implements more of
 * §5.10's table — and at that point its absence is a real, silent bias in what
 * the player is offered. One line against a whole class of future defect.
 *
 * **The `n < 2` throw is a programming-error guard and `runOffer` must never
 * reach it.** It does not call this function directly at all: `tryDrawOfferPair`
 * above welds `canDrawOfferPair` to this call so there is no second threshold to
 * get wrong, and `cards.test.ts` scans this module to keep it that way. A throw
 * inside `step` after `H_EPOCH` is written poisons the buffer permanently, which
 * is what the previous design did on a 4x4 golden fixture at tick 4,500 of a
 * 13,499-tick run.
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

/**
 * The pool this map and this build can offer from, as a `CARD_COUNT`-bit mask.
 *
 * **Two filters with two reasons, and only the second exists today.** M1f Task 11
 * ANDs in `capabilityMask(world)` — the map half, "can this board seat this item
 * at all" — and the signature already takes `world` so that landing it is a body
 * change and not a call-site sweep. Until then this returns
 * `CARD_IMPLEMENTED_MASK` alone, which is M1f's scope boundary rather than a
 * property of any board.
 *
 * `world` is therefore read by nothing yet, and `void world` says so in code
 * rather than in a comment a linter cannot see. Do not delete the parameter to
 * silence it: a later widening of the signature is a change every caller has to
 * be re-read for, and the callers are the tick.
 *
 * **The contract, which Task 11 must preserve and `cards.test.ts` pins on both
 * shipped maps: the result is inside `[0, 1 << CARD_COUNT)` and holds at least
 * two cards.** The first makes `nthSetBit` total on it; the second is what keeps
 * `runOfferFromPool`'s degenerate branch unreachable on a board that ships.
 */
export function poolFor(world: WorldData): number {
  void world
  return CARD_IMPLEMENTED_MASK
}

/**
 * `runOffer`'s whole body, against a pool handed in rather than derived.
 *
 * **Exported for its FAILURE PATH, on the precedent this package already uses
 * three times** — `assertBucketCountExceedsEveryEdgeCost` and
 * `assertPushWithinBucketWindow` (scratch.ts), `assertSingleCrossing` (cars.ts),
 * `assertDispatchProgress` (dispatch.ts) — each parameterised so the branch that
 * must never be reached in production can be reached by a test without editing a
 * constant and rebuilding. Here the branch is the short pool: `poolFor` ignores
 * its `world` until Task 11, so no fixture WORLD can produce one, and the
 * alternatives were a skipped test (which is a 0-detector for the two mutants
 * that matter) or a committed-then-reverted probe (which is a measurement, not
 * coverage). This is neither: `cards.test.ts` sweeps **all nine** masks that
 * cannot offer a pair, which is a stronger statement than one stubbed world
 * because it also covers the pools Task 11's capability filter has not been
 * written yet to produce.
 *
 * **This is NOT a pool parameter on `runOffer`.** `runOffer` below keeps the
 * specified `(state, world, scratch)` shape and is the only thing `step` calls.
 */
export function runOfferFromPool(state: GameState, pool: number, scratch: Scratch): void {
  if (!offerPending(state)) return
  const week = state.header[H_WEEK] as number
  if (tryDrawOfferPair(pool, offerSeedFor(state, week), scratch.offerPair)) {
    state.header[H_OFFER_A] = scratch.offerPair[OFFER_SLOT_A] as number
    state.header[H_OFFER_B] = scratch.offerPair[OFFER_SLOT_B] as number
    return
  }
  // **A POOL OF FEWER THAN TWO RESOLVES THE WEEK AND RAISES NOTHING.** Writing
  // `H_OFFER_WEEK` rather than merely returning is deliberate: it leaves NOTHING
  // PENDING, so `game`'s frame driver never pauses the shell behind a modal that
  // has nothing to show. "Does not throw" and "does not hang the shell" are
  // different failures and a bare `return` fixes only the first.
  state.header[H_OFFER_WEEK] = week
}

/**
 * Phase 4 of the tick order: raise this week's card offer (spec §5.10).
 *
 * **Position, and why both bounds are forced.** AFTER phase 3, because a
 * `choose-card` queued on the boundary tick must resolve the offer the slots
 * ACTUALLY hold before the phase that would overwrite them. BEFORE phase 5,
 * because nothing downstream may observe a half-raised offer.
 *
 * **The lower bound HAS a detector from M1f Task 6; the upper one is still an
 * argument, and the difference is recorded rather than blurred.** Task 5
 * measured both displacements at 0 and said so, because nothing enqueued a
 * `choose-card` and nothing read the slots. Task 6 wired the action, and
 * `cards.test.ts`'s *"THROWS on the boundary tick itself"* is `3 <-> 4`'s first
 * detector: on the boundary tick the clock has advanced, so `offerPending` is
 * true while `H_OFFER_A` is still `CARD_NONE`, and the echo cannot agree — move
 * this call in front of the input loop and it does agree, and nothing throws.
 * `4 <-> 5` is still 0; **M1f Task 8's frame fold** is what makes it
 * observable, and Task 12's closing sweep is where it gets re-measured.
 *
 * **It writes the two offer slots and NOTHING else** — except in the degenerate
 * case, where it writes `H_OFFER_WEEK` and no card. Phase 2 writes `H_TILES`; the
 * card's own tile bonus is paid by `applyChooseCard` in phase 3 (Task 6, and it
 * is landed rather than scheduled). So phases 2 and 4 touch disjoint state BY
 * CONSTRUCTION.
 *
 * **That disjointness does NOT make the positional transposition `2 <-> 4`
 * inert, and reading a red row there as a refutation of it is the mistake this
 * sentence exists to prevent.** Transposing positions 2 and 4 also reverses phase
 * 2 against phase 3, and phase 3 spends `H_TILES` today through `placeRoad`:
 * `week.test.ts`'s boundary-tick placement is funded by that same tick's grant
 * and is refused for budget once the grant lands after the spend. See `step.ts`'s
 * sweep table.
 *
 * **Idempotent, and that is load-bearing rather than an optimisation.** The draw
 * is a pure function of `(rng[0], week)`, so re-running it on every tick of an
 * unresolved week writes the same pair. That is what lets `H_OFFER_WEEK ===
 * H_WEEK` be the single mechanism for both "one per week" and "already chosen".
 * It also means the up-to-7 ticks between the boundary and the shell's pause
 * landing (see `game/src/frame.ts`) cannot change what the player is shown.
 *
 * **The property idempotence actually rests on is that `rng[0]` NEVER MOVES, and
 * it is worth naming because it is not obvious and not local.** `offerSeedFor`
 * reads the seed word live. Nothing in `sim/src` calls `nextRandom` or
 * `randomBelow` at all — `determinism.test.ts` bans both outside `rng.ts`, and
 * `spawnScanStart` reads `rng[0]` WITHOUT advancing for exactly this reason — so
 * the word is written once by `createState` and never again. The day a draw
 * lands inside the tick, this phase starts reshuffling the modal under the
 * player's finger; `cards.test.ts`'s idempotence test asserts the word stood
 * still, so it fails as "the rng moved" rather than as "the pair changed".
 *
 * Nothing here allocates: `scratch.offerPair` is preallocated and `poolFor` is a
 * mask. **And unlike `runWeekBoundary`'s grant, this one IS measured.** Phase 4
 * runs its full body on every tick of an unresolved week, and **no fixture the
 * allocation harness drives resolves one** — Task 6 wired `choose-card`, but
 * enqueueing one needs a caller and the first is Task 8's pointer, so every
 * profiled tick is still an unresolved week. (The sentence here used to read
 * "no week resolves until Task 6 wires `choose-card`", which stops being true
 * the moment a rig takes a card. It then predicted: *"Task 7 gives the headless
 * rigs a card policy and this window then profiles the RESOLVED body instead,
 * which is an early return."* **That did not happen, and it must not.** Task 7's
 * policy is for FRAME-driven rigs only; this window's rig — `buildSpawnRig` and
 * `recordGreedyLog` — drives `step` directly, takes no card, and still runs this
 * function's full body on all 13,800 profiled ticks. Task 7 verified that rather
 * than asserting it, by reverting `offerSeedFor`'s `| 0` on the shipped tree and
 * watching the window go red again naming this file. Giving that rig a policy
 * would delete `cards.ts`'s only allocation coverage and turn nothing red;
 * `allocation.test.ts` says so above `recordGreedyLog`.) So from tick
 * 4,500 onward this is a per-tick path, `allocation.test.ts`'s Task 12 window (three 4,600-tick windows
 * from tick 6,000) profiles 13,800 ticks of it under a 4 B/tick budget over the
 * whole `packages/sim/src` scope, and an escaping object here turns that window
 * red naming `cards.ts`. The week gate that made `runWeekBoundary` structurally
 * unmeasurable does not apply, because the gate here is on the WEEK's resolution
 * and not on the boundary tick.
 */
export function runOffer(state: GameState, world: WorldData, scratch: Scratch): void {
  runOfferFromPool(state, poolFor(world), scratch)
}

/**
 * §5.10's tile bonus for a card. **Total over the OFFERABLE set and a throw
 * outside it**, rather than a default arm: a card with no placement mechanism
 * cannot be offered (`CARD_IMPLEMENTED_MASK`), so reaching this with one means
 * the pool and the grant table disagree, and a plausible fallback would hide
 * that. `cards.test.ts` sweeps the complement of the mask rather than a
 * hand-written list of ids, so M1g moving a bit into the mask moves the sweep
 * with it.
 */
export function cardTileGrant(cardId: number): number {
  if (cardId === CARD_ROAD_TILES) return CARD_GRANT_ROAD_TILES
  if (cardId === CARD_JUNCTION_UPGRADE) return CARD_GRANT_ITEM
  throw new Error(
    `cards: card ${cardId} has no tile grant — only the cards in CARD_IMPLEMENTED_MASK do, and a ` +
      'card that can be offered but not priced means the pool and this table disagree',
  )
}

/**
 * §5.10's ITEM count for a card: 2 for the Traffic Lights row, 0 for Road Tiles.
 * Same totality rule as `cardTileGrant`, and a separate function rather than a
 * second return value because `render` needs the number on its own, folded onto
 * the frame, so the modal's "x2" is not a string literal in `canvas.ts`.
 */
export function cardItemGrant(cardId: number): number {
  if (cardId === CARD_ROAD_TILES) return 0
  if (cardId === CARD_JUNCTION_UPGRADE) return UPGRADES_PER_CARD
  throw new Error(`cards: card ${cardId} has no item grant — see cardTileGrant`)
}

/**
 * Applies a `choose-card` action, in phase 3.
 *
 * **Three checks, and their ORDER is load-bearing.**
 *
 *   1. **Not pending -> silent no-op.** A duplicate `choose-card` in one batch is
 *      what a double tap produces, and a throw there would poison `H_EPOCH` and
 *      end the run over a UI event. `H_OFFER_WEEK === H_WEEK` absorbs it, which
 *      is why `pointer.ts` (Task 8) needs no second guard — a second guard here
 *      would be the catalogue's independently-sufficient-structures defect.
 *      **This check must come FIRST — and the reason recorded here until M1f
 *      Task 7 was the wrong one, so it is quoted and refuted rather than
 *      replaced.** It said: *"once a week is RESOLVED the slots still hold that
 *      week's real cards, so an echo evaluated first would MATCH a repeat tap
 *      and pay the card a second time — silently, with no throw to notice."*
 *      **Moving this check below the echo does NOT pay twice**: it still sits
 *      above the three writes, so the second tap returns before any grant
 *      lands. Task 6 measured exactly that — its mutant 2 (move the pending
 *      check below the echo) scored 1, and NOT in the test written for it,
 *      because nothing was ever paid twice. Double payment is what DELETING
 *      this check does (Task 6's mutant 1, 5 detectors), which is a different
 *      edit.
 *      **The real reason is the opposite polarity: with the echo first, a tap
 *      this function is supposed to IGNORE becomes a run-ending throw.** On a
 *      resolved week an echo that does not match — a duplicate carrying a card
 *      id the slots no longer hold — reaches check 3 and poisons `H_EPOCH` over
 *      a UI event, which is the "a double tap bricks the run" failure in its
 *      strongest form. `cards.test.ts`'s resolved-week-plus-wrong-echo case is
 *      the detector, and it is the one that took mutant 2 from 1 to 2.
 *      It is also not, as a still earlier draft said, that a later week's offer
 *      has overwritten the slots: a later week is PENDING again, so check 1 does
 *      not fire there at all and check 3 does the work. See the two tests named
 *      *"same resolved week"* and *"arrives WITH a later boundary"*.
 *   2. **A slot outside {0, 1} -> throw.** A malformed action, exactly like
 *      `step`'s unknown-kind throw.
 *   3. **The echo -> throw.** `b` is the card id the CLIENT believes it is
 *      taking. A mismatch means the browser and this simulation disagree about
 *      what was offered, which can only happen if the draw is not a pure
 *      function of state. **That is exactly what a verified leaderboard exists
 *      to catch**, so a Worker that hits it returns `unverifiable`: never a
 *      score, and never apply-anyway. Applying the logged card regardless is
 *      what makes a leaderboard forgeable.
 *
 * **The one honest consequence of check 3, stated because it looks like a rough
 * edge and is not.** On a week-boundary tick the clock has already advanced in
 * phase 1, so `offerPending` is TRUE while `H_OFFER_A` still holds the previous
 * week's cards — or `CARD_NONE`, at the first boundary. An action arriving on
 * that tick therefore throws unless it echoes what the slots ACTUALLY hold. A
 * client can only echo a card it was shown, and it is shown one by a frame
 * folded after a tick, so no honest log carries a `choose-card` for a pair that
 * does not exist yet. `cards.test.ts` pins both arms — the first-boundary throw
 * and the later-boundary carry-over — and the first arm is the only detector the
 * `3 <-> 4` tick-order transposition has.
 *
 * **The tile bonus is paid HERE and never at the week boundary.** Phase 2 owns
 * `H_TILES`'s weekly grant and phase 4 owns the offer slots, so the two are
 * disjoint by construction.
 *
 * **`H_OFFER_A`/`H_OFFER_B` are NOT cleared**, deliberately: `offerSlot` already
 * folds `pending ? slot : CARD_NONE`, and clearing them here would be a second
 * mechanism for the same fact. Every reader goes through `offerSlot`.
 *
 * Allocates nothing, and it is not on a per-tick path at all: it runs once per
 * `choose-card` action, of which a run produces at most one per week.
 */
export function applyChooseCard(state: GameState, slot: number, cardId: number): void {
  if (!offerPending(state)) return
  if (slot !== OFFER_SLOT_A && slot !== OFFER_SLOT_B) {
    throw new Error(`cards: choose-card slot ${slot} is not 0 or 1`)
  }
  const offered = (slot === OFFER_SLOT_A ? state.header[H_OFFER_A] : state.header[H_OFFER_B]) as number
  if (offered !== cardId) {
    throw new Error(
      `cards: the client believed slot ${slot} held card ${cardId}, and this simulation offered ` +
        `${offered} — the offer is a pure function of the seed word and the week, so the two cannot ` +
        'disagree unless the replay has diverged. A verifier must report unverifiable rather than ' +
        'apply either card.',
    )
  }
  state.header[H_TILES] = (state.header[H_TILES] as number) + cardTileGrant(cardId)
  // Unconditional, and that is the point of `cardItemGrant` returning 0 for the
  // road-tiles card: there is no `if (cardId === ...)` here to get wrong, and the
  // two grants are read from one table rather than from two branches.
  state.header[H_INV_UPGRADES] = (state.header[H_INV_UPGRADES] as number) + cardItemGrant(cardId)
  state.header[H_OFFER_WEEK] = state.header[H_WEEK] as number
}
