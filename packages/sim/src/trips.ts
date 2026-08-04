import type { GameState } from './state'
import { H_SCORE } from './state'
import { PHASE_IDLE, PHASE_OUTBOUND, PHASE_RETURNING } from './buildings'
import { ROUTE_BYTES } from './dispatch'

/**
 * Trips: arrival, pin consumption, reservation release, scoring, and the
 * trip-end slot reset — phase 7 of the tick order, the LAST phase, and the
 * only one that mutates `destPins` after the field sync.
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
 * lengths on paper but costs a real tick per leg, and in M1d it would leave a
 * logically-finished car occupying a chunk for a tick.
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
 */
function arriveAtDestination(state: GameState, i: number): void {
  const d = state.carTargetDest[i] as number
  const pins = state.destPins[d] as number
  const reserved = state.destReserved[d] as number
  assertArrivalHonoured(pins, reserved, d, i)
  state.destPins[d] = pins - 1
  state.destReserved[d] = reserved - 1
  state.carPhase[i] = PHASE_RETURNING
}

/**
 * The return leg is over: the car is home.
 *
 * The byte set is spelled out rather than left to judgement, because Task 1g's
 * compression measurement — and through it M3's 4,096-character CloudStorage
 * budget — depends on it exactly: `carRoute` is 3,840 B of the 7,908 B state
 * buffer, and the prediction that a snapshot compresses is the prediction that
 * an idle car's route slice is a run of zeros. After this runs, the car's slot
 * is byte-identical to a freshly created car's slot, which is what
 * `trips.test.ts` and `loop.test.ts` both assert AS A SLOT.
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
 * **The phase byte is read exactly once per car**, into `phase`, which is what
 * makes the anti-double-act invariant ("at most one phase transition per car
 * per tick") structural rather than argued. Re-reading `state.carPhase[i]`
 * after the OUTBOUND branch has written it would collect a car twice in one
 * call for any route of length 0 — off the manifold, since dispatch refuses a
 * zero-length route, but the structure costs nothing and `trips.test.ts` has
 * the witness.
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
 * — the phase byte is the liveness marker (there is no `-1` sentinel anywhere
 * in this milestone's region list), and both branches are keyed on it.
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
