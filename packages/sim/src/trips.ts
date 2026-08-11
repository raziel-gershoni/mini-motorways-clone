import type { GameState } from './state'
import { H_SCORE } from './state'
import { PHASE_IDLE, PHASE_OUTBOUND, PHASE_RETURNING } from './buildings'
import { releaseCell } from './blocking'
import { noteGhostDeparture } from './roads'
import { applyArrivalKnockback } from './overcrowd'
import { ROUTE_BYTES } from './dispatch'

/**
 * Trips: arrival, pin consumption, reservation release, scoring, and the
 * trip-end slot reset — **phase 9 of ten**, and the only phase that mutates
 * `destPins` after the field sync.
 *
 * **It stopped being the LAST phase at M1e Task 7**, and the sentence that said
 * so is corrected rather than deleted because the reasoning under it is still
 * live: arrivals must come after the sync's last source-mutating phase, and
 * phase 10 (`overcrowd.ts`) is allowed to follow them precisely because it only
 * READS `destPins` and calls no field. The "why arrivals are last" paragraph
 * below is therefore now "why arrivals are last among the phases that mutate
 * the source set".
 *
 * **The signature is the primary defence, exactly as it is in `cars.ts`.**
 * `runArrivals` takes `state` and nothing else — no `world`, no `fields`, no
 * `scratch`. Two mutations the plan names are therefore not constructible
 * against this module rather than merely untested:
 *
 *   - "read a field here" — there is no field to read, which is what makes the
 *     stated residual ("the fields are stale from the arrival phase until the
 *     next tick's sync") a constraint on EXTERNAL callers only.
 *   - "return to the nearest house" — ranking houses needs a field or a
 *     geometry, and this module has neither. The return leg has no house
 *     search at all: decision 2's retrace already ends on the house cell the
 *     route started from, and `carHome[i]` is the only house index this file
 *     ever reads. `loop.test.ts` still asserts `carCell === houseCell[carHome]`
 *     at every score increment, over a fixture whose nearest same-colour house
 *     to the served destination is deliberately NOT the car's own, so the
 *     hand-applied form of that mutation has an observer.
 *
 * **Why arrivals are last** (the tick order's own derivation): they mutate
 * `destPins`, which decides the field's source set, and "no phase between the
 * sync and a field read may mutate the source set" is the one ordering rule
 * that produces a throw rather than a wrong number. Moving arrivals before
 * movement is a cyclic rotation of the same order — it produces identical trip
 * lengths on paper but costs a real tick per leg.
 *
 * **The second half of that prediction has come true, and it is stated in the
 * present tense now rather than the conditional.** This used to read "in M1d it
 * WOULD leave a logically-finished car occupying a chunk for a tick". M1d
 * shipped, and a "chunk" is now a concrete thing with a name: an `occupancy`
 * slot, `(cell, LANE_OF_DIR[dir])`. `completeTrip` below is release event 4 of
 * `blocking.ts`'s five-event lifecycle, so with arrivals moved before movement a
 * car that finished its trip on tick T holds its own house cell's slot for the
 * whole of T's movement phase — and its sibling, which is the most common thing
 * in the game to be standing behind it, is refused there. Measured at the close
 * of M1d rather than argued: transposing phases 6 and 7 is killed by **27**
 * tests across `sim` and `game`. (That transposition was caught before M1d too
 * — M1c recorded 11 of its 13 reorderings as pinned and this was one of them —
 * so 27 is a detector count at the close of M1d and NOT evidence that blocking
 * is what made it visible. The mechanism above is a reading of the code; the
 * number is not its proof.) See `step.ts` for the full re-measurement.
 *
 * **Score credits on RETURN HOME, not on pickup** — [OURS], per the dossier's
 * "Unknown - we choose" on §1.11. It matches the wiki's definition of a trip
 * and makes long trips genuinely more expensive. It is not documented
 * developer intent, and nothing in this file should be read as claiming it is.
 *
 * **Iteration is ascending car index, and unlike `runMovement`'s that is NOT a
 * provable no-op.** Two cars arriving at one destination on one tick with one
 * pin remaining: whichever the loop reaches first consumes it. Under decision
 * 4's proved `destReserved <= destPins` both cars hold reservations and both
 * find a pin, so the order is not outcome-visible today — but the invariant
 * that makes it invisible is exactly what M1e's destination removal breaks, so
 * it is pinned now, off the reachable manifold, in `trips.test.ts`.
 *
 * **Nothing here allocates.** No object literal, no array, no closure, no
 * `.map`/`.filter`/`.slice`; every value is a bare number and the only buffer
 * written is the caller-owned state buffer. Zero, not "small".
 */

/**
 * Throws if the destination a car arrived at cannot honour the reservation
 * that car has been holding since it departed.
 *
 * **Both halves are proved invariants, not branches** (decision 4). Dispatch
 * increments `destReserved[d]` only when `destPins[d] - destReserved[d] > 0`,
 * and this file decrements the two together; nothing else writes either. So
 * `0 < destReserved[d] <= destPins[d]` holds for every destination some car is
 * outbound to, and neither arm is reachable in M1c. The plan is explicit that
 * this is asserted loudly rather than given a behaviour: the "pins consumed en
 * route" case it would represent was reachable only under the re-pathing model
 * decision 2 removes.
 *
 * **The `destReserved` arm is not in the plan's text, and it is here for a
 * reason worth stating.** `destReserved` is a `Uint8Array`, so decrementing a
 * zero would store 255 — granting the destination 255 phantom reservations,
 * which makes `destPins - destReserved <= 0` true forever and silently
 * excludes it from dispatch for the rest of the run with nothing to point at.
 * That is the same silent-wrap class the codebase already guards at every
 * other `Uint8Array` boundary, and it gets its own test rather than shipping
 * as an unobserved guard.
 *
 * ---------------------------------------------------------------------------
 * THE CLASS, NAMED, WITH ITS NEXT RECIPIENT — M1d Task 1d
 * ---------------------------------------------------------------------------
 *
 * The class is: **an unguarded `--` at 0 on a `Uint8Array` slot wraps to 255,
 * and where that slot gates eligibility it excludes something forever, because
 * the counter can never climb back above 255.** It is silent, it survives
 * snapshot/restore, and it replays identically in the Worker — so it is not
 * even a divergence, just a game that quietly stops working.
 *
 * M1d re-swept the class rather than assuming it (Task 1d). The **complete**
 * set of `Uint8Array` decrement paths in `packages/sim/src` at the start of the
 * milestone is the two lines below, `destPins` and `destReserved`, both guarded
 * here and both directly unit-tested in `trips.test.ts` — each arm separately
 * and the compound as well, so neither hides inside the other.
 *
 * **Task 9 discharged the standing obligation at the close of the milestone: the
 * set is THREE and there is no fourth.** Verified by enumerating every write to
 * every one of the ten `Uint8` regions in `packages/sim/src` — `roads`,
 * `cleared`, `houseColour`, `destMeta`, `destPins`, `destReserved`, `carPhase`,
 * `carRoute`, `ghostMask`, `ghostCommitted` — rather than by grepping for `--`,
 * which would have missed the one path M1d actually added: `noteGhostDeparture`
 * (roads.ts) spells it `const left = committed - 1` across two statements and no
 * `--`-shaped pattern matches it. The three are `destPins` and `destReserved`
 * here, and `ghostCommitted` there, guarded by `assertGhostCommittedPositive`.
 * Of the remaining writes none can lower a slot except `eraseRoad`'s
 * `roads[a] = newMaskA`, and that is a BITMASK cleared with `& ~bit`, which
 * cannot underflow — it is not a counter and the wrap class does not apply. The other six
 * `Uint8` regions take no decrement at all: `roads` clears bits with `& ~bit`,
 * `cleared` is only ever set to 1, `houseColour`/`destMeta` are written once at
 * placement, `carPhase` is assigned named constants, and `carRoute` is written
 * by nibble or zero-filled wholesale.
 *
 * **M1d's queueing adds no decrement to either slot here.** The one genuine new
 * `Uint8Array` decrement path in the milestone is **Task 5's `ghostCommitted`**
 * — the count of cars committed to a ghosted cell, decremented as each crosses
 * off it — and it carries this guard by name. **It has now landed, and the
 * recipient honoured it**: `roads.ts`'s `assertGhostCommittedPositive` is the
 * same shape as the `reserved <= 0` arm below, exercised directly, with the
 * same "wrapping to 255 excludes something forever, silently" reasoning at its
 * site. So the complete set of `Uint8Array` decrement paths in
 * `packages/sim/src` is now THREE: `destPins` and `destReserved` here, and
 * `ghostCommitted` in `roads.ts`. Task 9 verifies at the end of the milestone
 * that no fourth appeared.
 *
 * **M1e Task 7 added a decrement path and it is NOT a fourth member, which was
 * checked by reading rather than assumed.** `applyArrivalKnockback`
 * (`overcrowd.ts`), called from `arriveAtDestination` below, lowers
 * `destOvercrowd` — an `Int32Array`, so the wrap class does not apply to it at
 * all. Re-swept at that task by enumerating every write to every one of the ten
 * `Uint8` regions in `packages/sim/src`, the same method Task 9 used rather
 * than a grep for `--`: `overcrowd.ts` writes no `Uint8` region (it reads
 * `destPins` and `destMeta` and writes only the two `Int32` overcrowd
 * regions), and nothing else in the milestone's Task 7 diff touches one. The
 * set is still THREE.
 *
 * Parameterised rather than closing over `state`, on the precedent of
 * `assertBucketCountExceedsEveryEdgeCost` (scratch.ts), `assertDispatchProgress`
 * (dispatch.ts) and `assertSingleCrossing` (cars.ts): the failure path is then
 * testable directly.
 *
 * @internal Exported for testing only; `runArrivals` is the real call site.
 */
export function assertArrivalHonoured(pins: number, reserved: number, d: number, i: number): void {
  if (pins <= 0) {
    throw new Error(
      `trips: car ${i} arrived at destination ${d} holding a reservation, but destPins is ${pins} — ` +
        'decision 4 proves destReserved <= destPins, so this is a broken invariant, not a game state',
    )
  }
  if (reserved <= 0) {
    throw new Error(
      `trips: car ${i} arrived at destination ${d} with destReserved ${reserved} — there is no ` +
        'reservation to release, and decrementing would wrap the Uint8 slot to 255',
    )
  }
}

/**
 * The outbound leg is over: consume one pin, release one reservation, turn the
 * car around.
 *
 * `carRouteCursor` is deliberately NOT re-written to `routeLen` here. It is
 * ALREADY `routeLen` — that is the arrival test itself — so the write the plan
 * spells out ("flips to `PHASE_RETURNING` with `cursor = routeLen`") is a
 * provable no-op, and an explicit no-op write is a line no mutation can
 * falsify. `carProgress` is likewise left alone, and that one is load-bearing:
 * the carry must cross the outbound -> return flip or every trip loses up to a
 * tick at its midpoint (decision 3).
 *
 * `carRoute` and `carTargetDest` survive too — the return leg is the same
 * route read backwards, and the target is what the plan's own trip-end rule
 * clears. Only trip end zeroes bytes.
 *
 * **This is deliberately NOT an occupancy release site** (M1d Task 2,
 * `blocking.ts` lifecycle event 5). The car does not move: it flips phase in
 * place on the carpark cell, which its last outbound crossing entered and whose
 * slot it therefore holds. Releasing here would free a slot with a car standing
 * on it — a completeness hole that lasts until the next entrant overwrites it,
 * and, once Task 3 refuses entries, a cell that silently stops blocking. The
 * claim carries across the leg flip and is released by the FIRST crossing of
 * the return leg, exactly as it would be on any other cell.
 */
function arriveAtDestination(state: GameState, i: number): void {
  const d = state.carTargetDest[i] as number
  const pins = state.destPins[d] as number
  const reserved = state.destReserved[d] as number
  assertArrivalHonoured(pins, reserved, d, i)
  state.destPins[d] = pins - 1
  state.destReserved[d] = reserved - 1
  // §5.8's arrival knockback (M1e Task 7). Here and not in phase 10, because it
  // is an EVENT — one car arriving — and phase 10 is a per-tick integration.
  // Placed after the pin decrement so a destination that just dropped back
  // under capacity gets the knockback AND the unwind on the same tick, which is
  // the whole relief a player feels when a queue finally clears.
  //
  // **It is NOT a `Uint8Array` decrement**, which is the question the block
  // above obliges anyone adding a decrement here to answer: `destOvercrowd` is
  // `Int32Array`, so the wrap class does not apply. It is clamped at 0 anyway,
  // by `assertOvercrowdNonNegative`, for the different reason `overcrowd.ts`
  // gives — a negative meter is a silent lie about how close the player is to
  // losing.
  applyArrivalKnockback(state, d)
  state.carPhase[i] = PHASE_RETURNING
}

/**
 * The return leg is over: the car is home.
 *
 * The byte set is spelled out rather than left to judgement, because M1c Task
 * 1g's compression measurement — and through it M3's 4,096-character
 * CloudStorage budget — depends on it exactly: `carRoute` is 3,840 B of the
 * state buffer (of 7,908 B at M1c; of 11,908 B after M1d Task 2 added
 * `occupancy` and `carBlockedTicks`, and 13,828 B as of Task 5's two ghost
 * regions, which is the final M1d figure — M3 must re-measure, not extrapolate), and the prediction that a
 * snapshot compresses is the prediction that an idle car's route slice is a run
 * of zeros. After this runs, the car's own slot in every CAR region is
 * byte-identical to a freshly created car's slot, which is what
 * `trips.test.ts` and `loop.test.ts` both assert AS A SLOT. `occupancy` is not
 * a car region and is not part of that claim: it is cell-indexed, and the
 * release above returns the vacated slot to `FREE`, which is exactly its
 * freshly-created value.
 *
 * The `carCell` write is a no-op on the reachable manifold and is not
 * decoration: the retrace ends on the cell the route started from, which is
 * the house cell. It is written anyway so that an idle car's bytes are a
 * function of nothing but "idle" even when they were not — and it is the one
 * line the hand-applied "return to the nearest house" mutation edits.
 *
 * The route slice is cleared with an explicit whole-slice `fill`, never the
 * prefix `carRouteLen` happened to reach, so the result does not depend on how
 * far the car got. This is deliberately a second, independent copy of the
 * one-line fill `dispatch.ts` performs on a refused route rather than a shared
 * helper: the plan lists "skip the route zeroing on refusal" and "skip the
 * route zeroing at trip end" as two separate mutations, and a shared helper
 * would make them one, so a single test could stand in for both.
 */
function completeTrip(state: GameState, i: number): void {
  state.header[H_SCORE] = (state.header[H_SCORE] as number) + 1
  state.carPhase[i] = PHASE_IDLE
  // Occupancy lifecycle event 4 (blocking.ts). A returning car's last crossing
  // genuinely ENTERS the house cell, so it holds a claim there; without this
  // release the car holds its own front door forever, and its sibling stalls
  // the full 1,350-tick valve on every return leg — the most common trip in the
  // game. It is also caught a second, independent way: a slot naming a car that
  // has gone PHASE_IDLE is an `assertOccupancySound` violation by definition.
  //
  // Released from `state.carCell[i]` read BEFORE the write below, not from the
  // house cell. On the reachable manifold they are the same cell (the retrace
  // ends where the route started), but the cell the car is STANDING on is the
  // cell whose slot it claimed, and that is the one the protocol is about.
  // Reading the house cell instead would silently release the wrong cell under
  // exactly the corruption the `carCell` write below exists to repair.
  //
  // **Measured, because "the ordering matters" is the kind of claim that turns
  // out to be decoration.** Moving this call BELOW the `carCell` write scored
  // **0 detectors** across the whole suite on its first run — a genuine
  // equivalence *on the manifold*, and exactly the shape the catalogue warns
  // reads as coverage. It is not an equivalent mutant off the manifold, and the
  // detector was constructible: `blocking.test.ts` hand-builds a RETURNING car
  // with an exhausted cursor standing on a cell that is not its house, and the
  // wrong ordering then strands a claim naming a PHASE_IDLE car. Do not
  // "simplify" this to read the house cell on the strength of the manifold
  // argument; the manifold argument is what the `carCell` write below already
  // declines to trust.
  releaseCell(state, i, state.carCell[i] as number)
  // M1d Task 5: trip end is a ghost DEPARTURE as well as an occupancy release —
  // the two events coincide because both are "this car has stopped standing on
  // this cell". Without it, a ghost whose last committed car's route ENDS on it
  // would never reach 0 and its tile would be confiscated for the rest of the
  // run, which is the mirror of the double-refund and just as silent. The house
  // cell is a road cell like any other (roads.ts keeps house cells placeable),
  // so this is not an exotic case: it is every trip whose house cell is erased.
  //
  // Read from `carCell[i]` before the write below, on exactly the reasoning the
  // release above already carries.
  noteGhostDeparture(state, state.carCell[i] as number)
  state.carCell[i] = state.houseCell[state.carHome[i] as number] as number
  state.carTargetDest[i] = -1
  state.carProgress[i] = 0
  state.carRouteLen[i] = 0
  state.carRouteCursor[i] = 0
  const base = i * ROUTE_BYTES
  state.carRoute.fill(0, base, base + ROUTE_BYTES)
}

/**
 * Phase 7 of the tick order: collect every car whose leg ran out this tick.
 *
 * **The anti-double-act invariant ("at most one phase transition per car per
 * tick") rests on TWO structures here, and either one alone is enough.** An
 * earlier version of this paragraph claimed only the first and called it "what
 * makes the invariant structural", which overstated by exactly one guard:
 *
 *   1. The phase byte is read once per car, into `phase`, so the second branch
 *      cannot see a write the first branch made.
 *   2. The `else if` chain, so the second branch is not evaluated at all once
 *      the first has fired.
 *
 * Measured, not argued: removing (1) alone and removing (2) alone are each a
 * **0-detector no-op** against the whole suite, because each is individually
 * sufficient. Only removing BOTH collects a car twice in one call — and only
 * for a route of length 0, which is off the manifold since dispatch refuses
 * one. `trips.test.ts` carries that witness. Note the consequence for anyone
 * mutating this file: the usual rule is "decompose a compound mutation,
 * because a compound being caught does not mean each half is". Here the
 * inverse holds and it has to be stated — neither half has an observer or
 * could have one, and the compound is the only meaningful mutation. Do not
 * read either guard as dead code on the strength of its own survival.
 *
 * The cursor tests are `>=` / `<=` rather than `===`, on the same fail-closed
 * reasoning as `dispatch.ts`'s `destPins - destReserved <= 0`: on the manifold
 * a cursor can never pass its bound, because `advanceCar` stops at exactly it.
 * Off the manifold, `===` would read a cursor that HAD overshot as "still
 * driving" and strand the car outbound forever, holding its reservation and
 * blocking its destination; `>=` collects it and leaves the corruption where
 * it is.
 *
 * Every car slot is visited, including `PHASE_NONE` ones past the live prefix
 * — the phase byte is the liveness marker (no CAR region uses a `-1` sentinel;
 * narrowed at M1d Task 2, which added `occupancy`'s `FREE = -1`, a cell-indexed
 * region with no liveness prefix and no car slot in it), and both branches are
 * keyed on it.
 */
export function runArrivals(state: GameState): void {
  const carCount = state.carPhase.length
  for (let i = 0; i < carCount; i++) {
    const phase = state.carPhase[i] as number
    const cursor = state.carRouteCursor[i] as number
    if (phase === PHASE_OUTBOUND && cursor >= (state.carRouteLen[i] as number)) {
      arriveAtDestination(state, i)
    } else if (phase === PHASE_RETURNING && cursor <= 0) {
      completeTrip(state, i)
    }
  }
}
