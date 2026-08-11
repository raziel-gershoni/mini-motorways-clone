import {
  DENOM,
  TICKS_PER_SECOND,
  OVERCROWD_RAMP,
  OVERCROWD_RETURN_MUL,
  OVERCROWD_RAMP_FULL_TICKS,
  ARRIVAL_KNOCKBACK_PCT,
  ARRIVAL_KNOCKBACK_MAX_MILLITICKS,
  OVERCROWD_FAIL_MILLITICKS,
  PIN_CAP_SQUARE_TIMER,
  PIN_CAP_CIRCLE_TIMER,
} from '@laneways/shared'
import type { GameState } from './state'
import { H_DEST_COUNT, H_FAILED_DEST, H_GAME_OVER } from './state'
import { destMetaKind, DEST_KIND_CIRCLE } from './buildings'

/**
 * Per-destination overcrowd — spec §5.8, the milestone's whole reason for
 * existing. M1d made a badly-built city visibly jam; this is what makes that
 * cost the run.
 *
 * **Two quantities, because the ramp and the meter answer different questions.**
 * `destOverTicks[d]` is consecutive time at or over capacity and drives the
 * ramp; it resets the moment the destination is back under. `destOvercrowd[d]`
 * is the integrated meter, reduced by arrivals and by the unwind, and it alone
 * decides failure. One quantity cannot do both: a ramp derived from the meter
 * is zero at zero and never starts.
 *
 * **This file ends the run, as of M1e Task 8 — and it does not freeze
 * anything.** `runOvercrowd` sets `H_GAME_OVER`/`H_FAILED_DEST` and returns;
 * the byte-identical no-op every later tick becomes is `step`'s early return,
 * one level up. The split is deliberate on both sides. Keeping the arithmetic
 * separable from the consequence is what lets the 3,390-tick derivation be
 * wrong loudly in a test rather than fatally in a run, and it is why
 * `overcrowd.test.ts` can drive the meter thousands of ticks past the failure
 * to measure the model. Keeping the FREEZE out of here is what stops the two
 * guards being independently sufficient, which would leave neither with a
 * detector.
 *
 * **What this model can and cannot express, measured — read plan Decision 2
 * before tuning any of it.** Hold a destination at its cap and serve it one car
 * every P ticks: the meter's fixed point is `10,000 * P`, which exists only
 * below the 900,000 point where the 90,000 knockback cap binds. So **P <= 90
 * ticks survives forever and P > 90 dies, with nothing in between** — swept and
 * confirmed exactly at a 2,000,000-tick horizon (91 dies at 163,162; 92 at
 * 84,271; at P = 90 the meter's PEAK parks on 900,000 exactly). Measured on the
 * real boot path at M1e Task 7 by driving each board 40,000 ticks with no
 * input, the demo board dies at tick **6,703** (3 min 43 s) on D2 and
 * `firstCity` at tick **5,580** (3 min 06 s), also on D2 — and removing the
 * knockback, removing the unwind, or removing both leaves both ticks unchanged,
 * measured by deleting the code rather than by modelling it.
 *
 * **Neither shipped board is anywhere near that boundary, but they are far from
 * it for DIFFERENT reasons, and one word for both hides the difference.** On
 * `firstCity`, D2 is **unreachable**: the board has no roads, it receives zero
 * cars ever, and its arrival interval is literally infinite — a five-tile road
 * to it removes the failure entirely (`startingCity.test.ts`). On the demo
 * board, D2 is **reachable and deprioritised**: six cars do reach it, the last
 * at tick 1,549, and it then loses every dispatch because cars route to the
 * nearest unfilled pin of their colour. Both end up past P = 90 by an unbounded
 * margin, so this model cannot distinguish them — but a lever that reaches one
 * (lay a road) does nothing for the other, and Task 10's gate should not treat
 * them as one case.
 *
 * **The meter reads `destPins`, not `destPins - destReserved`.** §5.8: "There
 * is no carpark immunity - a car metres from the bay does not save you. The
 * original deliberately omits it."
 *
 * **Both regions are `Int32Array`, so the `Uint8` wrap class does not apply —
 * and both decrements are still clamped at 0 with a named assertion**, because
 * a negative meter is a silent lie about how close the player is to losing, and
 * it would render as an empty ring on a destination that is about to kill them.
 * `trips.ts` carries the standing enumeration of `Uint8Array` decrement paths
 * in `packages/sim/src`; this file adds none, and that is verified there rather
 * than asserted here.
 *
 * **Nothing here allocates.** No object literal, no array, no closure; every
 * value is a bare number and the only buffer written is the caller-owned state
 * buffer. Zero, not "small".
 *
 * **Width, since both products look like overflow candidates and neither is.**
 * `overcrowdRampSpeed` computes `(20 * t) / 30` and `arrivalKnockback`
 * `(meter * 100) / 1000` — both in doubles, and `| 0` is applied to the
 * QUOTIENT, not to the product. The quotients are `2t/3` and `meter/10`, so
 * with `meter` bounded by `Int32Array`'s own range the truncation never sees a
 * value outside int32. The intermediate products (up to ~2.1e11) are exactly
 * representable as doubles.
 */

/**
 * The pin count at which destination `d`'s timer starts — §5.8's 6 for a square
 * and 8 for a circle. NOT the hard cap (10 / 14), which is `demand.ts`'s
 * `capacityOf` and governs whether a pin can be added at all.
 */
export function overcrowdTriggerCap(state: GameState, d: number): number {
  return destMetaKind(state.destMeta[d] as number) === DEST_KIND_CIRCLE
    ? PIN_CAP_CIRCLE_TIMER
    : PIN_CAP_SQUARE_TIMER
}

/** True iff `d` is at or over the capacity that starts its timer. The ONE place §5.8's threshold is compared. */
export function isOverCapacity(state: GameState, d: number): boolean {
  return (state.destPins[d] as number) >= overcrowdTriggerCap(state, d)
}

/**
 * §5.8's `s(t) = min(1, 0.02t)`, in milli-ticks per tick.
 *
 * **The `> DENOM` clamp is UNREACHABLE from `runOvercrowd` today, measured, and
 * it must not be deleted on the strength of that.** `destOverTicks` saturates
 * at `OVERCROWD_RAMP_FULL_TICKS` and `overcrowdRampSpeed(1500)` is exactly
 * `DENOM`, so the comparison is false on every tick the game can produce:
 * dropping the clamp scores **1** detector across the whole suite, and it is
 * the direct table in `overcrowd.test.ts` at 15,000 ticks — not the 3,390 test,
 * which the brief predicted would catch it, and not any golden. That is the
 * catalogue's independently-sufficient shape: the saturation is what holds the
 * bound today, and the clamp is what holds it for any direct caller and for the
 * moment somebody raises the ceiling. Do not read either guard as dead code on
 * the strength of its own survival; dropping the saturation instead scores 2.
 */
export function overcrowdRampSpeed(overTicks: number): number {
  const s = ((OVERCROWD_RAMP * overTicks) / TICKS_PER_SECOND) | 0
  return s > DENOM ? DENOM : s
}

/** §5.8's "reduction on car arrival: 10% of current, clamped to [0 s, 3 s]". */
export function arrivalKnockback(meter: number): number {
  const k = ((meter * ARRIVAL_KNOCKBACK_PCT) / DENOM) | 0
  return k > ARRIVAL_KNOCKBACK_MAX_MILLITICKS ? ARRIVAL_KNOCKBACK_MAX_MILLITICKS : k
}

/**
 * Throws rather than storing a negative meter. Parameterised rather than
 * closing over `state`, on the precedent of `assertGhostCommittedPositive`
 * (roads.ts) and `assertArrivalHonoured` (trips.ts): the failure path is then
 * testable directly.
 *
 * @internal Exported for testing only; `applyArrivalKnockback` is the real call site.
 */
export function assertOvercrowdNonNegative(value: number, d: number): void {
  if (value < 0) {
    throw new Error(
      `overcrowd: destination ${d} reached a meter of ${value} — the unwind and the arrival ` +
        'knockback are both floored at 0, so a negative meter is a broken invariant, not a game state',
    )
  }
}

/**
 * §5.8's arrival knockback, applied to one destination.
 *
 * **The floor is structural rather than clamped, and that is worth stating
 * because the assertion below looks like dead code otherwise.** The knockback
 * is `floor(m/10)` capped at 90,000, and `floor(m/10) <= m` for every
 * non-negative `m`, so `m - arrivalKnockback(m)` cannot go negative from a
 * non-negative meter. The assertion therefore fires only when the meter was
 * ALREADY negative going in.
 *
 * **Which is not the unreachable case an earlier draft of this comment called
 * it — `runOvercrowd` produces it, and that is this assertion's real job.**
 * Measured: removing the unwind's own `m > 0 ? m : 0` floor drives the meter
 * negative on every under-capacity tick, and this assertion is what notices —
 * **65 detectors, naming the invariant** ("destination 0 reached a meter of
 * -41400"), including `carSmoothing.test.ts` and `integration.test.ts`, which
 * fail at COLLECTION because their rigs drive a real board. Dropping the
 * assertion while the floor stands scores **0**, which is the expected
 * equivalence rather than a coverage hole: the floor alone upholds the
 * invariant, and the assertion exists to say so out loud the day the floor
 * goes. Neither is dead code and neither can observe its own deletion.
 */
export function applyArrivalKnockback(state: GameState, d: number): void {
  const m = state.destOvercrowd[d] as number
  const next = m - arrivalKnockback(m)
  assertOvercrowdNonNegative(next, d)
  state.destOvercrowd[d] = next
}

/**
 * Phase 10 of the tick order, and **the one place the run can end.**
 *
 * Iterates the LIVE destination prefix, `H_DEST_COUNT`, and not the whole
 * region: a slot past the prefix holds a zero `destMeta`, which decodes as a
 * square, so an unbounded loop would silently integrate a meter for a
 * destination that does not exist yet. `overcrowd.test.ts` pins that with a
 * hand-written over-cap pin count in slot 1 of a one-destination board.
 *
 * **This function has no `isGameOver` guard and must not grow one.** The freeze
 * is `step`'s early return, one level up; a second one here would be
 * independently sufficient with it, and by this repo's own catalogue two
 * independently sufficient structures leave NEITHER with a detector. It is also
 * what lets `overcrowd.test.ts` keep driving the meter past the failure to
 * measure the arithmetic, which no `step`-driven fixture could do.
 */
export function runOvercrowd(state: GameState): void {
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    if (isOverCapacity(state, d)) {
      const over = state.destOverTicks[d] as number
      const next = over < OVERCROWD_RAMP_FULL_TICKS ? over + 1 : OVERCROWD_RAMP_FULL_TICKS
      state.destOverTicks[d] = next
      state.destOvercrowd[d] = (state.destOvercrowd[d] as number) + overcrowdRampSpeed(next)
      if ((state.destOvercrowd[d] as number) >= OVERCROWD_FAIL_MILLITICKS) {
        // §5.8: "the city shuts down IMMEDIATELY. No lives, no partial
        // failure, no win condition." **Returning here rather than finishing
        // the loop is not an optimisation: it fixes WHICH destination is blamed
        // when two complete on the same tick**, at the lowest index, which is
        // the same ascending-integer tie-break every other order in this sim
        // uses. `overcrowd.test.ts`'s two-destination fixture is the detector,
        // and the assertion that sees it is the one reading destination 1's
        // meter — dropping the `return` still sets `H_GAME_OVER`.
        //
        // **The meter is left AT ITS OVERSHOOT, not clamped.** The ramp is
        // added before this test, so the stored value can exceed
        // OVERCROWD_FAIL_MILLITICKS by up to `DENOM - 1` (2,640,999), and the
        // freeze then preserves that overshoot forever. Task 12's long-run
        // bound on this region is `OVERCROWD_FAIL_MILLITICKS + DENOM - 1` for
        // exactly this reason. Clamping instead would make the ring Task 9
        // draws read exactly 97.8 % at every death rather than at most, which
        // is a cosmetic gain paid for with a lost byte of evidence about how
        // the crossing happened.
        //
        // The comparison is against the FAIL constant, not the FULL one: §5.8's
        // last 2 s are a hidden grace, and comparing against
        // OVERCROWD_FULL_MILLITICKS would give every run 60 more ticks.
        state.header[H_GAME_OVER] = 1
        state.header[H_FAILED_DEST] = d
        return
      }
    } else {
      state.destOverTicks[d] = 0
      const m = (state.destOvercrowd[d] as number) - OVERCROWD_RETURN_MUL
      state.destOvercrowd[d] = m > 0 ? m : 0
    }
  }
}
