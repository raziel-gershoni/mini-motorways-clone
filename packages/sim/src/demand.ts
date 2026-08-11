import {
  PIN_CAP_SQUARE_HARD,
  PIN_CAP_CIRCLE_HARD,
  PIN_PERIOD_TICKS,
  FIRST_PIN_DELAY_TICKS,
  DENOM,
  SPAWN_SCALE_BASE,
  SPAWN_SCALE_PER_WEEK,
  SPAWN_SCALE_MAX,
} from '@laneways/shared'
import type { GameState } from './state'
import { H_TICK, H_WEEK, H_DEST_COUNT, H_PINS_DROPPED } from './state'
import type { Scratch } from './scratch'
import { CT_BLOCKED_PUSH_DISCARDED } from './scratch'
import { destMetaColour, destMetaKind, DEST_KIND_CIRCLE } from './buildings'

/**
 * Demand: the per-colour accumulator, the rotation, per-destination hard
 * capacity, and overflow — M1c design decision 1 ("Demand is
 * destination-pull, and the rotation is state"). Destinations REQUEST cars;
 * houses never emit them (spec §5.3, [DPC]).
 *
 * **Not wired into `step()` in this task.** Task 3's own file list is
 * `demand.ts`/`demand.test.ts` only, mirroring Task 2's `buildings.ts`,
 * which also shipped with no production caller. `runDemand` below is
 * Task 6's "phase 3" call, slotted between "apply inputs" (phase 2) and
 * "assemble sources + sync" (phase 4) per the plan's "tick order, derived"
 * table: it must run before the sync because it mutates `destPins`, which
 * decides the source set.
 *
 * **Rotation representation** (decision 1, "chosen rather than left open"):
 * `rotationCursor[c]` packs `destIndex * 2 + subSlot`, naming a destination
 * SLOT INDEX plus a sub-slot — never a position in a virtual expanded list.
 * Destinations are append-only and `H_DEST_COUNT` is the live prefix
 * length, so a destination's own index never moves once assigned; this is
 * what makes the rotation stable across a placement, not just across a
 * snapshot/restore.
 *
 * **The raw stored cursor is a SEARCH START, not a guaranteed-valid
 * position.** On the very first fire for a colour whose destinations do not
 * start at global index 0 (e.g. colour 2's first destination lands at index
 * 5 because destinations 0-4 are other colours), the zero-initialised
 * cursor does not itself name a colour-2 destination. `resolveCurrent`
 * below searches forward from the raw value (wrapping at `H_DEST_COUNT`)
 * for the first ELIGIBLE same-colour destination, so no destination ever
 * needs an explicit "cursor init" write at placement time. After the first
 * resolution for a colour, the stored cursor is always already valid —
 * eligibility is monotonic (once true for a destination it is true
 * forever: `destSpawnTick` is immutable and `tick` only increases) and
 * destinations are never removed in M1c, so a destination that was once
 * resolved as "current" stays a legitimate colour-match forever. Every
 * later call therefore resolves in one step; the search loop below only
 * ever does real work on the bootstrap call for a given colour.
 *
 * **Eligibility gate** (decision 1, fix-list #16): `tick - destSpawnTick[d]
 * >= FIRST_PIN_DELAY_TICKS`. `>=`, not `>` — a destination is due exactly
 * on the tick the delay elapses, not one tick later. This single gate
 * (`isEligible` below, the one place it is written) reconciles the
 * per-destination 4s delay with the per-colour timer: an ineligible
 * destination counts toward neither `slotCount` (so it cannot speed up the
 * colour's accumulator before it can receive anything itself) nor the
 * rotation search (so it can never become "current"), nor an overflow
 * recipient (an ineligible destination has not earned its first pin either
 * way). Every eligibility check in this file — `computeSlotCounts`,
 * `resolveCurrent`, `advanceCursor`, and the overflow walk in `fireColour`
 * — routes through this one function, so there is exactly one place a
 * `>=` -> `>` mutation can hide, and exactly one place it is caught.
 *
 * **The accumulator** (decision 1's pseudocode, implemented literally in
 * `advanceAccumulators`):
 *
 *   acc[c] += slotCount(c)                     // once per tick
 *   if (acc[c] >= P_w) { acc[c] -= P_w; fire(c) }   // P_w = pinPeriodForWeek(H_WEEK)
 *
 * `acc -= P_w`, never `acc = 0`: the remainder must carry, or a
 * `slotCount` that does not evenly divide the period drifts the
 * same way movement's per-edge progress would if a crossing dropped its
 * remainder (decision 3) — small at any one firing, compounding over the
 * run. `slotCount(c) <= 2 * maxDestinations`, which is **36** on the largest
 * map this repo ships (`demoCity`: `maxDestinations` 18, and its own comment
 * says "six rows of three, all circles, so 36 rotation slots"), and
 * `36 < P_w` (518 at week 0, 172 at the cap), so at most one threshold
 * crossing — one fire — happens per colour per tick: an invariant with its own
 * bound, stated so nobody reaches for a `while` loop that is never actually
 * exercised.
 *
 * **That figure was `<= 32` here for three milestones and it was wrong** — 32
 * is `firstCity`'s 16 destinations mistaken for a repo-wide ceiling. Nothing
 * downstream of it ever changed, but the number is now DERIVED from the shipped
 * maps in `demand.test.ts` rather than written as a literal, because a
 * derivation nobody can recompute is how a premise outlives the thing it was
 * true of.
 *
 * **The bound is still ONE under M1e's weekly ramp, and the argument is
 * EXTENDED rather than replaced.** The tick-to-tick half above is untouched:
 * the smallest period the ramp can produce is `pinPeriodForWeek(19)` = 172 and
 * `36 < 172`. What the ramp adds is a second case the old argument did not
 * cover — a period that SHRINKS between one tick and the next, which can leave
 * `acc` above the new threshold with nothing having been added to it. That case
 * is bounded too, over ADJACENT weeks:
 *
 *   - the largest adjacent drop is `518 - 466 = 52`, at the 0 -> 1 boundary,
 *     and every later drop is smaller (`pinPeriodForWeek` is convex in the
 *     week; `demand.test.ts` asserts the maximum is at week 1 over 40 weeks);
 *   - the most `acc` can carry into a boundary tick is `P_{w-1} - 1` = 517,
 *     plus at most `slotCount` = 36 added on the tick itself, so 553;
 *   - one fire leaves at most `553 - 466 = 87`, against a threshold of 466.
 *
 * **WHERE THE INVARIANT ACTUALLY ENDS, since "36 is comfortably under 466" is
 * not a bound.** Two clauses, and the binding one is not the obvious one:
 * within a week a second fire needs `slotCount >= P_w`, so `slotCount < 172`;
 * at a week change it needs `P_{w-1} - 1 + slotCount - P_w >= P_w`, so
 * `slotCount < 2*P_w - P_{w-1} + 1`, whose minimum over the ramp is **167** —
 * at the **17 -> 18** boundary (180 -> 173), not at the 0 -> 1 one, which has
 * the largest absolute drop but also the largest `P_w` to absorb it. So the
 * boundary clause binds first and the largest slot count the one-fire
 * invariant survives is **166** — `maxDestinations` 83, all circles, against 18
 * today. `demand.test.ts` computes both clauses from `pinPeriodForWeek` and
 * asserts the shipped maximum is under them, so a future map that crosses the
 * line fails there.
 *
 * **So a `while`-drain spelling of the fire branch is an EQUIVALENT MUTANT**:
 * its second iteration is unreachable at every week and every slot count this
 * game can produce. It is recorded here with its derivation for the two
 * opposite mistakes it prevents — nobody should reach for a `while` (it would
 * be a loop that cannot iterate twice, i.e. an `if` with extra syntax), and
 * nobody should delete the `if` on the strength of a mutation surviving. The
 * bound is one; the `if` is what expresses it. **That label is only good while
 * the headroom assertion above is green** — it is what stops this paragraph
 * vouching for a mutant a future map has made non-equivalent.
 *
 * **Overflow** (decision 1): if the rotation's chosen destination is at its
 * hard cap (`PIN_CAP_SQUARE_HARD`/`PIN_CAP_CIRCLE_HARD`, [OURS]; the *timer*
 * thresholds shipped in M1e Task 7 and live in `overcrowd.ts`, which reads
 * `PIN_CAP_*_TIMER` and never this file), the pin redirects to the next
 * DISTINCT
 * same-colour, eligible, uncapped destination — walking DESTINATIONS, not
 * slots (a slot-walk could hand a capped circle its own overflow via its
 * second slot), starting at the one after the chosen, wrapping at
 * `H_DEST_COUNT`, implicitly skipping other colours (the colour filter is
 * part of the same eligibility check). If every same-colour eligible
 * destination is capped, the pin is dropped and `H_PINS_DROPPED`
 * increments. Either way, the rotation cursor advances past the
 * ORIGINALLY CHOSEN slot, never past the overflow recipient — the rotation
 * is the schedule; overflow redirects one pin, it does not hand away whose
 * turn is next.
 */

/**
 * §5.3's weekly demand ramp at `DENOM`. `H_WEEK` is zero-based and the spec's
 * `w` is one-based, so `1.0 + 0.11 * (w - 1)` is `SPAWN_SCALE_BASE +
 * SPAWN_SCALE_PER_WEEK * H_WEEK` with no adjustment — and week 0 is 1.0x, not
 * 1.11x. The cap first binds at `H_WEEK` 19: 1000 + 110*18 = 2,980 and
 * 1000 + 110*19 = 3,090.
 *
 * **`s > SPAWN_SCALE_MAX` versus `s >= SPAWN_SCALE_MAX` is a LABELLED EQUIVALENT
 * MUTANT, and this is the label — the derivation above was here without it,
 * which let it be relayed onward as "recorded at its site" when the only thing
 * recorded was the arithmetic.** The two spellings can differ only on a week
 * where `s` is exactly `SPAWN_SCALE_MAX = 3000`, and `s = 1000 + 110*w` hits
 * 3000 at `w = 18.18…`, which is not an integer: week 18 gives 2,980 and week 19
 * gives 3,090. So no reachable `H_WEEK` produces equality and the branch cannot
 * be told apart by any observer, on any board, at any run length. **The
 * condition that ends it is arithmetic, not a milestone**: it ends the moment
 * `(SPAWN_SCALE_MAX - SPAWN_SCALE_BASE)` becomes divisible by
 * `SPAWN_SCALE_PER_WEEK` — today 2000/110 — at which point `>=` and `>` differ
 * by one week of full-rate demand. `demand.test.ts` asserts the non-divisibility
 * directly, so the label fails rather than rots. **Do not manufacture a detector
 * for the comparison**; the divisibility assertion is the whole of what can be
 * checked.
 */
export function spawnScale(week: number): number {
  const s = SPAWN_SCALE_BASE + SPAWN_SCALE_PER_WEEK * week
  return s > SPAWN_SCALE_MAX ? SPAWN_SCALE_MAX : s
}

/**
 * The accumulator threshold for `week`.
 *
 * **The ramp scales the PERIOD and not the increment, and that choice is
 * load-bearing twice over.** Multiplying the increment by `scale / DENOM`
 * truncates once per TICK, which is the drift `acc -= period` exists to
 * prevent; scaling in `DENOM` units instead is exact but multiplies every
 * stored `pinAccum` by 1,000, which moves the loop, queue and multiplier
 * goldens behaviourally for no gameplay reason. Scaling the threshold
 * truncates once per WEEK, in a comparison rather than an accumulation, and at
 * week 0 it is `518000 / 1000` = 518 — bit-for-bit today's constant.
 */
export function pinPeriodForWeek(week: number): number {
  return ((PIN_PERIOD_TICKS * DENOM) / spawnScale(week)) | 0
}

/** True iff destination `d` has cleared its first-pin delay as of `tick`. The one eligibility check — see the module comment. */
function isEligible(state: GameState, d: number, tick: number): boolean {
  return tick - (state.destSpawnTick[d] as number) >= FIRST_PIN_DELAY_TICKS
}

/** True iff destination `d` is colour `colour` AND eligible as of `tick`. */
function isEligibleOfColour(state: GameState, d: number, colour: number, tick: number): boolean {
  return destMetaColour(state.destMeta[d] as number) === colour && isEligible(state, d, tick)
}

/** The hard pin cap for destination `d`, from its packed kind. */
function capacityOf(state: GameState, d: number): number {
  return destMetaKind(state.destMeta[d] as number) === DEST_KIND_CIRCLE ? PIN_CAP_CIRCLE_HARD : PIN_CAP_SQUARE_HARD
}

/** True iff destination `d` has room for one more pin under its hard cap. */
function hasRoom(state: GameState, d: number): boolean {
  return (state.destPins[d] as number) < capacityOf(state, d)
}

/**
 * Resolves `rotationCursor[colour]`'s raw packed value to the destination
 * slot that is actually due to fire: the first eligible colour-matching
 * destination at index >= the packed `destIndex`, wrapping at
 * `H_DEST_COUNT`. Only when the found index equals the packed `destIndex`
 * exactly is the packed `subSlot` honoured — every other hit (the
 * bootstrap/search case; see the module comment) starts at `subSlot` 0,
 * because a destination this search skipped past was never mid-rotation
 * for this colour in the first place.
 *
 * **Returns a packed `destIndex * 2 + subSlot` number, not `{destIndex,
 * subSlot}`** — this runs once per pin fire, inside the tick once Task 6
 * wires `runDemand` into `step()`, and an object literal here is exactly
 * the shape `houseAt` (`state.ts`), `colourSourceOffset` (`flowfield.ts`)
 * and `carparkCell` (`buildings.ts`) each document rejecting for the same
 * reason: "nothing allocates inside a tick" is zero, not small. The caller,
 * `fireColour`, decodes with the same `(v / 2) | 0` / `v & 1` this file
 * already uses to decode `cursorRaw` itself — no new decoding shape.
 *
 * Throws if no eligible colour-matching destination exists. The only
 * caller, `fireColour`, is only reached from `advanceAccumulators` after
 * `acc[colour] >= pinPeriodForWeek(H_WEEK)`, which requires `slotCount(colour)` to
 * have been > 0 — and `slotCount` only counts eligible destinations of that
 * colour, so at least one must exist. A throw here means that invariant
 * broke, not a reachable game state.
 */
function resolveCurrent(state: GameState, colour: number, tick: number, cursorRaw: number): number {
  const destCount = state.header[H_DEST_COUNT] as number
  const startIndex = (cursorRaw / 2) | 0
  const startSub = cursorRaw & 1
  for (let step = 0; step < destCount; step++) {
    const d = (startIndex + step) % destCount
    if (isEligibleOfColour(state, d, colour, tick)) {
      return d * 2 + (d === startIndex ? startSub : 0)
    }
  }
  throw new Error(
    `demand: resolveCurrent found no eligible destination of colour ${colour} at tick ${tick} — ` +
      'fireColour must only be called when slotCount(colour) > 0',
  )
}

/**
 * The rotation's "advance" rule (decision 1, all five previously-open
 * questions settled there): if the just-fired slot is a circle's FIRST
 * sub-slot, move to that SAME destination's second sub-slot — the circle's
 * two slots are consecutive by construction, and this is the only branch
 * that could make them otherwise. Every other case (a square, or a
 * circle's second sub-slot) moves to sub-slot 0 of the next same-colour
 * ELIGIBLE destination in ascending index, wrapping at `H_DEST_COUNT` —
 * including wrapping back to `chosenIndex` itself when it is the only
 * eligible destination of its colour (a lone destination's rotation is a
 * self-loop; `step <= destCount` inclusive is what makes that reachable,
 * as opposed to the overflow walk's `step < destCount` in `fireColour`).
 *
 * **Corrected: the two bounds differ for clarity and cost, NOT for
 * correctness.** An earlier version of this sentence said the overflow walk
 * "must NOT revisit the chosen destination — the two loops have different
 * bounds for exactly this reason", which contradicts `fireColour`'s own inline
 * note 45 lines below, and `fireColour` is the one that was measured:
 * mutating that bound to `<=` is a checked no-op, because `hasRoom(destIndex)`
 * was already false and nothing writes `destPins[destIndex]` in between, so a
 * revisit would fail its own capacity test anyway. What actually stops a
 * capped circle receiving its own overflow is walking DESTINATIONS rather than
 * SLOTS. Two comments disagreeing about one loop is worse than either being
 * wrong alone: this one is above the other and is a doc comment, so it is the
 * one a reader reaches first.
 *
 * Takes the CHOSEN slot (the one `resolveCurrent` returned, before any
 * overflow redirection) as its `chosenIndex`/`chosenSub` parameters, never
 * the overflow recipient — decision 1 is explicit that the rotation is the
 * schedule and overflow does not hand away whose turn is next.
 */
function advanceCursor(state: GameState, colour: number, tick: number, chosenIndex: number, chosenSub: number): number {
  const kind = destMetaKind(state.destMeta[chosenIndex] as number)
  if (kind === DEST_KIND_CIRCLE && chosenSub === 0) {
    return chosenIndex * 2 + 1
  }
  const destCount = state.header[H_DEST_COUNT] as number
  for (let step = 1; step <= destCount; step++) {
    const d = (chosenIndex + step) % destCount
    if (isEligibleOfColour(state, d, colour, tick)) {
      return d * 2
    }
  }
  throw new Error(
    `demand: advanceCursor found no eligible destination of colour ${colour} at tick ${tick} — ` +
      'chosenIndex itself is eligible and colour-matching, so this loop must hit it by step = destCount',
  )
}

/**
 * One colour's demand fires: resolve the rotation's current slot, deliver
 * the pin there or, if capped, walk to the next distinct eligible
 * same-colour destination with room (or drop it, incrementing
 * `H_PINS_DROPPED`, if every one is capped), then advance the cursor past
 * the ORIGINALLY CHOSEN slot regardless of where the pin actually landed.
 */
function fireColour(state: GameState, colour: number, tick: number): void {
  const cursorRaw = state.rotationCursor[colour] as number
  const chosenPacked = resolveCurrent(state, colour, tick, cursorRaw)
  const destIndex = (chosenPacked / 2) | 0
  const subSlot = chosenPacked & 1

  let recipient = -1
  if (hasRoom(state, destIndex)) {
    recipient = destIndex
  } else {
    const destCount = state.header[H_DEST_COUNT] as number
    // Distinct destinations only, starting after the chosen one, wrapping.
    // `step < destCount` (not `<=`) never revisits `destIndex` itself, but
    // note what actually GUARANTEES distinctness: `hasRoom(state,
    // destIndex)` was already false in the branch above and nothing writes
    // `destPins[destIndex]` before this loop runs, so even a `step <=
    // destCount` bound that DID revisit `destIndex` would still fail its own
    // `hasRoom` check — checked directly: mutating this bound to `<=` is a
    // provable no-op, not merely untested (see demand.test.ts's mutation
    // table). `step < destCount` is kept for clarity/cost, not correctness.
    // What DOES stop a capped circle from being handed its own overflow
    // through its second slot is walking DESTINATIONS (this loop) rather
    // than SLOTS — a slot-walk would treat the circle's two subSlots as two
    // separate candidates. Other colours are skipped by
    // `isEligibleOfColour`'s own colour filter, not by a separate check.
    for (let step = 1; step < destCount; step++) {
      const d = (destIndex + step) % destCount
      if (isEligibleOfColour(state, d, colour, tick) && hasRoom(state, d)) {
        recipient = d
        break
      }
    }
  }

  if (recipient === -1) {
    state.header[H_PINS_DROPPED] = (state.header[H_PINS_DROPPED] as number) + 1
  } else {
    state.destPins[recipient] = (state.destPins[recipient] as number) + 1
  }

  state.rotationCursor[colour] = advanceCursor(state, colour, tick, destIndex, subSlot)
}

/**
 * Recomputes `scratch.slotCounts` from the LIVE destination prefix — fully
 * overwritten every call, not accumulated, matching `sourcesFlat`/
 * `sourceCounts`'s own "rewritten in full each tick" contract
 * (`scratch.ts`). A square contributes 1 slot, a circle 2 ([MOD]
 * `DemandMultiplierForBuildings`/`...ForUpgradedBuildings` give the same 2x
 * ratio as a request-time multiplier; decision 1 implements it as two
 * consecutive rotation slots instead, for the burstiness — see
 * `advanceCursor`'s doc comment). An INELIGIBLE destination contributes 0:
 * counting it here would let a freshly-placed, not-yet-reachable
 * destination speed up the WHOLE COLOUR's accumulator before it can
 * receive anything itself.
 *
 * Exported separately from `advanceAccumulators` so a test can drive the
 * accumulator's carry behaviour with a hand-set `slotCounts` in isolation —
 * mirroring `createScratch`'s own doctored-parameter testing pattern
 * (`scratch.ts`: "so `scratch.test.ts` can pass a doctored huge `cells`")
 * — without needing enough real destinations to reach a particular slot
 * count.
 */
export function computeSlotCounts(state: GameState, scratch: Scratch): void {
  const tick = state.header[H_TICK] as number
  const destCount = state.header[H_DEST_COUNT] as number
  const groupCount = state.pinAccum.length
  for (let c = 0; c < groupCount; c++) scratch.slotCounts[c] = 0
  for (let d = 0; d < destCount; d++) {
    if (!isEligible(state, d, tick)) continue
    const meta = state.destMeta[d] as number
    const colour = destMetaColour(meta)
    // `slotCounts` is an `Int32Array(groupCount)`, and an out-of-range
    // typed-array write is a SILENT no-op — so without this a destination
    // whose packed colour exceeds the map's group count would simply never
    // contribute demand, never take its turn in the rotation, and never
    // request a car, with no error and nothing to point at. `packDestMeta`
    // validates colour only against its 3-bit field [0, 7], never against a
    // particular map's `groupCount`. `placeDestination` (buildings.ts) now
    // rejects it at the boundary; this stays as defence-in-depth against a
    // hand-written or corrupted `destMeta` byte, mirroring the identical
    // guard in `assembleSources` (dispatch.ts).
    if (colour >= groupCount) {
      throw new Error(
        `computeSlotCounts: destination ${d} has colour ${colour}, outside this map's groupCount (${groupCount})`,
      )
    }
    const slots = destMetaKind(meta) === DEST_KIND_CIRCLE ? 2 : 1
    scratch.slotCounts[colour] = (scratch.slotCounts[colour] as number) + slots
  }
}

/**
 * The accumulator/fire loop, reading `scratch.slotCounts` AS ALREADY
 * POPULATED — it does not call `computeSlotCounts` itself (see that
 * function's own comment for why the split exists). `runDemand` below is
 * the composition every production caller (Task 6's `step`) actually
 * wants.
 */
export function advanceAccumulators(state: GameState, scratch: Scratch): void {
  const tick = state.header[H_TICK] as number
  const groupCount = state.pinAccum.length
  // Hoisted per CALL, never per run. The period is a function of `H_WEEK`, so
  // caching it across ticks freezes the cadence at whatever week the cache was
  // filled on — a mutation the demand golden catches, because its second
  // cadence never arrives. Hoisting it out of the colour loop is free: every
  // colour on one tick is in the same week by construction.
  const period = pinPeriodForWeek(state.header[H_WEEK] as number)
  for (let c = 0; c < groupCount; c++) {
    const slotCount = scratch.slotCounts[c] as number
    state.pinAccum[c] = (state.pinAccum[c] as number) + slotCount
    if ((state.pinAccum[c] as number) >= period) {
      state.pinAccum[c] = (state.pinAccum[c] as number) - period
      fireColour(state, c, tick)
    }
  }
}

/**
 * Demand's whole per-tick job (the plan's tick-order phase 3): recompute
 * slot counts from the live destination prefix, then advance every
 * colour's accumulator and fire whichever cross their threshold. Reads
 * `H_TICK` directly off `state` — by the time this runs (after phase 1's
 * tick advance, before phase 4's field sync), it is already the current
 * tick, and demand must precede the sync because it mutates `destPins`,
 * which decides the source set.
 */
export function runDemand(state: GameState, scratch: Scratch): void {
  computeSlotCounts(state, scratch)
  advanceAccumulators(state, scratch)
}

/** True iff any destination of `colour` has cleared its first-pin delay as of `tick`. */
export function hasEligibleDestinationOfColour(state: GameState, colour: number, tick: number): boolean {
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) if (isEligibleOfColour(state, d, colour, tick)) return true
  return false
}

/**
 * Spec §5.3.5: a destination that could not be placed ANYWHERE pushes its
 * scheduled demand into the existing destinations of its colour instead.
 *
 * Routed through `fireColour`, so it inherits overflow redistribution and the
 * `H_PINS_DROPPED` fallback for free rather than reimplementing either. The
 * guard is required, not defensive: `fireColour` THROWS when no eligible
 * destination of the colour exists, and a colour whose only destinations are
 * inside their 4 s first-pin delay is an ordinary, reachable state.
 *
 * **`fireColour` also advances `rotationCursor[colour]` (see its own comment
 * above), so a blocked-spawn pin perturbs the SCHEDULE as well as the count** —
 * it permanently changes which destination of that colour is next in line for
 * every subsequent scheduled pin. That is not a bug: a pushed pin is a pin, and
 * it should take its turn like one. It is written down because the first draft
 * of the plan asserted that a saturated board was inert under this function,
 * and the count is only one of the two things it moves.
 *
 * Called from the SPAWN phase, which runs before the field sync, so the
 * `destPins` write it may produce is still ahead of phase 6 exactly as
 * `runDemand`'s is.
 */
export function pushBlockedSpawnDemand(state: GameState, colour: number, scratch: Scratch): void {
  const tick = state.header[H_TICK] as number
  if (!hasEligibleDestinationOfColour(state, colour, tick)) {
    // **Counted, because a silent discard here already hid a dead rule for
    // twenty-eight weeks.** Measured over 40 weeks on `firstCity` with the
    // 20-tile opening and the cursor frozen as the first draft wrote it, 232 of
    // 259 pushes landed on colour 4 — which ends the run with a house and NO
    // destination, so this guard swallowed every one of them and §5.3.5
    // delivered literally nothing from week 12 onward. Nothing said so. The
    // counter lives in `scratch`, not in the state buffer, so no golden can see
    // it and it costs no bytes; Task 12's per-branch assertions read it.
    scratch.counters[CT_BLOCKED_PUSH_DISCARDED] =
      (scratch.counters[CT_BLOCKED_PUSH_DISCARDED] as number) + 1
    return
  }
  fireColour(state, colour, tick)
}
