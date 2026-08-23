import { mixWord } from './rng'
import type { GameState } from './state'
import { offerPending, H_OFFER_A, H_OFFER_B, H_OFFER_WEEK, H_WEEK } from './state'
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
 * **This module's runtime imports are `mixWord` and five names from `state.ts`,
 * and the edge is ONE-WAY.** Until M1f Task 5 the only runtime import was
 * `mixWord`; wiring phase 4 made this module a writer of the header, so it now
 * imports `offerPending` and four slot indices. **`state.ts` still imports
 * nothing from here at run time and must not start** — `offerSlot` returns the
 * literal `0` rather than `CARD_NONE` precisely to keep the direction clean, and
 * `cards.test.ts` pins `CARD_NONE === 0` so the two cannot drift. `state.ts` is
 * imported by nearly every file in this package, so a back-edge would close a
 * cycle through most of it; M1f Task 1 already paid for one (`roads.ts ->
 * dispatch.ts -> scratch.ts -> roads.ts`) with a module-scope mask that evaluated
 * to 0. The `WorldData` and `Scratch` imports are TYPE-ONLY and erase.
 *
 * **Nothing at this module's top level reads an IMPORTED value.**
 * `CARD_IMPLEMENTED_MASK` is built from two `const` declarations in this file;
 * every other constant below is a literal. That is the property the Task 1 defect
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
 * `choose-card` queued on the boundary tick must resolve THIS week's offer before
 * the phase that would raise one. BEFORE phase 5, because nothing downstream may
 * observe a half-raised offer.
 *
 * **Both bounds are arguments and neither has a detector in M1f Task 5, which is
 * recorded rather than implied.** Nothing enqueues a `choose-card` until Task 6
 * and nothing reads the offer slots until Task 8, so moving this call to either
 * side of its neighbours scored 0 in this task's own mutation battery. The
 * positions are right for the reasons above; the evidence for them arrives with
 * the tasks that make them observable.
 *
 * **It writes the two offer slots and NOTHING else** — except in the degenerate
 * case, where it writes `H_OFFER_WEEK` and no card. Phase 2 writes `H_TILES`; the
 * card's own tile bonus is paid by `applyChooseCard` in phase 3 (Task 6). So
 * phases 2 and 4 touch disjoint state BY CONSTRUCTION.
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
 * runs its full body on every tick of an unresolved week, and no week resolves
 * until Task 6 wires `choose-card` — so from tick 4,500 onward this is a
 * per-tick path, `allocation.test.ts`'s Task 12 window (three 4,600-tick windows
 * from tick 6,000) profiles 13,800 ticks of it under a 4 B/tick budget over the
 * whole `packages/sim/src` scope, and an escaping object here turns that window
 * red naming `cards.ts`. The week gate that made `runWeekBoundary` structurally
 * unmeasurable does not apply, because the gate here is on the WEEK's resolution
 * and not on the boundary tick.
 */
export function runOffer(state: GameState, world: WorldData, scratch: Scratch): void {
  runOfferFromPool(state, poolFor(world), scratch)
}
