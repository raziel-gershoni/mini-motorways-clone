import { PIN_CAP_SQUARE_HARD, PIN_CAP_CIRCLE_HARD, PIN_PERIOD_TICKS, FIRST_PIN_DELAY_TICKS } from '@laneways/shared'
import type { GameState } from './state'
import { H_TICK, H_DEST_COUNT, H_PINS_DROPPED } from './state'
import type { Scratch } from './scratch'
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
 *   if (acc[c] >= PIN_PERIOD_TICKS) { acc[c] -= PIN_PERIOD_TICKS; fire(c) }
 *
 * `acc -= PIN_PERIOD_TICKS`, never `acc = 0`: the remainder must carry, or a
 * `slotCount` that does not evenly divide `PIN_PERIOD_TICKS` drifts the
 * same way movement's per-edge progress would if a crossing dropped its
 * remainder (decision 3) — small at any one firing, compounding over the
 * run. `slotCount(c) <= 2 * maxDestinations <= 32 < PIN_PERIOD_TICKS`
 * (518), so at most one threshold crossing — one fire — happens per colour
 * per tick: an invariant with its own bound, stated so nobody reaches for a
 * `while` loop that is never actually exercised.
 *
 * **Overflow** (decision 1): if the rotation's chosen destination is at its
 * hard cap (`PIN_CAP_SQUARE_HARD`/`PIN_CAP_CIRCLE_HARD`, [OURS]; the *timer*
 * thresholds are M1e's problem), the pin redirects to the next DISTINCT
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
 * Throws if no eligible colour-matching destination exists. The only
 * caller, `fireColour`, is only reached from `advanceAccumulators` after
 * `acc[colour] >= PIN_PERIOD_TICKS`, which requires `slotCount(colour)` to
 * have been > 0 — and `slotCount` only counts eligible destinations of that
 * colour, so at least one must exist. A throw here means that invariant
 * broke, not a reachable game state.
 */
function resolveCurrent(
  state: GameState,
  colour: number,
  tick: number,
  cursorRaw: number,
): { destIndex: number; subSlot: number } {
  const destCount = state.header[H_DEST_COUNT] as number
  const startIndex = (cursorRaw / 2) | 0
  const startSub = cursorRaw & 1
  for (let step = 0; step < destCount; step++) {
    const d = (startIndex + step) % destCount
    if (isEligibleOfColour(state, d, colour, tick)) {
      return { destIndex: d, subSlot: d === startIndex ? startSub : 0 }
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
 * as opposed to the overflow walk's `step < destCount` in `fireColour`,
 * which must NOT revisit the chosen destination — the two loops have
 * different bounds for exactly this reason).
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
  const { destIndex, subSlot } = resolveCurrent(state, colour, tick, cursorRaw)

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
  for (let c = 0; c < groupCount; c++) {
    const slotCount = scratch.slotCounts[c] as number
    state.pinAccum[c] = (state.pinAccum[c] as number) + slotCount
    if ((state.pinAccum[c] as number) >= PIN_PERIOD_TICKS) {
      state.pinAccum[c] = (state.pinAccum[c] as number) - PIN_PERIOD_TICKS
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
