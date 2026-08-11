import { describe, it, expect } from 'vitest'
import {
  parseMap,
  DENOM,
  TICKS_PER_SECOND,
  OVERCROWD_RAMP,
  OVERCROWD_RETURN_MUL,
  OVERCROWD_FULL_MILLITICKS,
  OVERCROWD_GRACE_MILLITICKS,
  OVERCROWD_FAIL_MILLITICKS,
  OVERCROWD_RAMP_FULL_TICKS,
  ARRIVAL_KNOCKBACK_PCT,
  ARRIVAL_KNOCKBACK_MAX_MILLITICKS,
  PIN_CAP_SQUARE_TIMER,
  PIN_CAP_SQUARE_HARD,
  PIN_CAP_CIRCLE_TIMER,
  PIN_CAP_CIRCLE_HARD,
  type MapData,
} from '@laneways/shared'
import { createState, H_DEST_COUNT, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import {
  placeDestination,
  DEST_KIND_SQUARE,
  DEST_KIND_CIRCLE,
  ORIENTATION_E,
} from '../src/buildings'
import {
  overcrowdTriggerCap,
  isOverCapacity,
  overcrowdRampSpeed,
  arrivalKnockback,
  applyArrivalKnockback,
  assertOvercrowdNonNegative,
  runOvercrowd,
} from '../src/overcrowd'

/**
 * Unit coverage for phase 10 — the per-destination overcrowd meter (spec §5.8).
 *
 * Everything here drives `runOvercrowd` and its helpers DIRECTLY rather than
 * through `step`, on `trips.test.ts`'s reasoning: a throw part-way through a
 * phase leaves `H_EPOCH` non-zero and poisons the buffer, and several fixtures
 * below deliberately hold a destination at its cap for thousands of ticks,
 * which is a state no `step`-driven fixture reaches cheaply. The wiring — that
 * `step` calls this at all, and calls it AFTER arrivals — is pinned in
 * `step.test.ts` and `trips.test.ts` instead.
 *
 * **`runOvercrowd` does not end the run.** Task 8 gives it that power; here the
 * meter can saturate and nothing happens, which is what lets the 3,390-tick
 * derivation below be wrong loudly in a test rather than fatally in a run.
 */

const OC_W = 12
const OC_H = 8

function allLandRows(w: number, h: number): string[] {
  const row = '.'.repeat(w)
  return Array.from({ length: h }, () => row)
}

function ocMap(): MapData {
  return parseMap('overcrowd', allLandRows(OC_W, OC_H), 99, 40, 16, 5)
}

interface Rig {
  readonly state: GameState
  readonly world: WorldData
}

/**
 * One destination of a chosen kind at grid (2, 2) opening EAST, with `destPins`
 * and `destReserved` written by hand.
 *
 * Hand-written rather than produced by `runDemand`, deliberately: the meter's
 * whole input is `destPins`, and a fixture that had to drive demand to reach a
 * cap could not put the two regions into the combinations §5.8's carpark rule
 * is about (`pins === reserved`, in particular, which dispatch cannot produce
 * alongside an arrival on the same tick).
 */
function overcrowdRig(opts: { kind?: number; pins?: number; reserved?: number } = {}): Rig {
  const map = ocMap()
  const world = createWorld(map)
  const state = createState('overcrowd', map)
  const kind = opts.kind ?? DEST_KIND_SQUARE
  expect(placeDestination(state, world, 2 * OC_W + 2, ORIENTATION_E, 0, kind)).toBe(true)
  expect(state.header[H_DEST_COUNT]).toBe(1)
  state.destPins[0] = opts.pins ?? 0
  state.destReserved[0] = opts.reserved ?? 0
  return { state, world }
}

describe('the overcrowd ramp, in milli-ticks', () => {
  it('ramps at min(1, 0.02t) in milli-ticks, reaching full at exactly 1,500 ticks', () => {
    expect(overcrowdRampSpeed(0)).toBe(0)
    expect(overcrowdRampSpeed(1), 'floor(2/3)').toBe(0)
    expect(overcrowdRampSpeed(3)).toBe(2)
    expect(overcrowdRampSpeed(OVERCROWD_RAMP_FULL_TICKS - 1)).toBe(999)
    expect(overcrowdRampSpeed(OVERCROWD_RAMP_FULL_TICKS)).toBe(DENOM)
    expect(overcrowdRampSpeed(OVERCROWD_RAMP_FULL_TICKS * 10), 'clamped, not linear').toBe(DENOM)
  })

  it("the ramp phase sums to exactly 750,000 milli-ticks, which is the spec's 25 s", () => {
    // Hand-derivable and worth deriving rather than measuring: writing
    // t = 3k + r, floor(2t/3) over each consecutive triple is
    // 2k + (2k+1) + (2k+2) = 6k + 3; t from 1 to 1,500 is 500 triples with
    // k = 0..499, so the sum is 6*(499*500/2) + 3*500 = 750,000.
    let sum = 0
    for (let t = 1; t <= OVERCROWD_RAMP_FULL_TICKS; t++) sum += overcrowdRampSpeed(t)
    expect(sum).toBe(750000)
    // 750,000 milli-ticks is 750 ticks is 25 s, which is §5.8's own figure for
    // what the ramp phase contributes. Read back through the clock rather than
    // asserted as a fourth literal.
    expect(sum / DENOM / TICKS_PER_SECOND).toBe(25)
  })

  it('fills on the 3,390th consecutive over-capacity tick and not the 3,389th', () => {
    // §5.8's "~113 s: 50 s ramping, then 65 s at full rate, minus 2 s hidden
    // grace" lands on an exact integer: 750,000 milli-ticks over the 1,500-tick
    // ramp, then (2,640,000 - 750,000) / 1,000 = 1,890 more at full rate.
    // 1,500 + 1,890 = 3,390 ticks = 113.0 s. The sharpest off-by-one detector
    // in this milestone, and the two shipped boards' death ticks are derived
    // from it (`demoLayout.test.ts`, `startingCity.test.ts`).
    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
    for (let i = 0; i < 3389; i++) runOvercrowd(state)
    expect(state.destOvercrowd[0], 'one tick short').toBeLessThan(OVERCROWD_FAIL_MILLITICKS)
    runOvercrowd(state)
    expect(state.destOvercrowd[0]).toBeGreaterThanOrEqual(OVERCROWD_FAIL_MILLITICKS)
    expect(state.destOvercrowd[0]).toBe(OVERCROWD_FAIL_MILLITICKS)
    // The decomposition, so a reader can see WHERE 3,390 comes from rather than
    // only that it holds: the ramp phase, then the remainder at the full rate.
    expect(OVERCROWD_RAMP_FULL_TICKS + (OVERCROWD_FAIL_MILLITICKS - 750000) / DENOM).toBe(3390)
    expect(3390 / TICKS_PER_SECOND).toBe(113)
  })
})

describe('the overcrowd trigger', () => {
  it('triggers AT the capacity, not above it, and separately for a square and a circle', () => {
    // §5.8: "square triggers the timer at 6, hard cap 10; circle at 8, hard cap
    // 14." One function, so there is exactly one place a `>=` -> `>` mutation
    // can hide and exactly one place it is caught — the idiom `isEligible`
    // already uses in demand.ts.
    const sq = overcrowdRig({ kind: DEST_KIND_SQUARE, pins: PIN_CAP_SQUARE_TIMER - 1 })
    runOvercrowd(sq.state)
    expect(sq.state.destOverTicks[0], 'one below the square trigger').toBe(0)
    sq.state.destPins[0] = PIN_CAP_SQUARE_TIMER
    runOvercrowd(sq.state)
    expect(sq.state.destOverTicks[0]).toBe(1)

    const ci = overcrowdRig({ kind: DEST_KIND_CIRCLE, pins: PIN_CAP_SQUARE_TIMER })
    runOvercrowd(ci.state)
    expect(ci.state.destOverTicks[0], "a circle is not over at a square's cap").toBe(0)
    ci.state.destPins[0] = PIN_CAP_CIRCLE_TIMER
    runOvercrowd(ci.state)
    expect(ci.state.destOverTicks[0]).toBe(1)
  })

  it('reads the TIMER cap and not the hard cap, for both kinds', () => {
    // The trigger cap and the hard cap are two different numbers per kind and
    // the pairs do not overlap, so returning the wrong one is caught here by
    // value rather than only through a behavioural knock-on.
    const sq = overcrowdRig({ kind: DEST_KIND_SQUARE })
    expect(overcrowdTriggerCap(sq.state, 0)).toBe(PIN_CAP_SQUARE_TIMER)
    expect(overcrowdTriggerCap(sq.state, 0)).not.toBe(PIN_CAP_SQUARE_HARD)
    const ci = overcrowdRig({ kind: DEST_KIND_CIRCLE })
    expect(overcrowdTriggerCap(ci.state, 0)).toBe(PIN_CAP_CIRCLE_TIMER)
    expect(overcrowdTriggerCap(ci.state, 0)).not.toBe(PIN_CAP_CIRCLE_HARD)
    // Vacuity for the two `not.toBe`s: the four caps really are four distinct
    // numbers, so a wrong-cap mutant cannot pass by coincidence.
    expect(
      new Set([PIN_CAP_SQUARE_TIMER, PIN_CAP_SQUARE_HARD, PIN_CAP_CIRCLE_TIMER, PIN_CAP_CIRCLE_HARD])
        .size,
    ).toBe(4)
  })

  it('is over capacity at the trigger and under it one pin below, for both kinds', () => {
    // `isOverCapacity` written against directly, not only through
    // `runOvercrowd`: the plan's Produces block omitted it and the first draft
    // mutation-tested it, so it gets an observer of its own.
    const sq = overcrowdRig({ kind: DEST_KIND_SQUARE, pins: PIN_CAP_SQUARE_TIMER - 1 })
    expect(isOverCapacity(sq.state, 0)).toBe(false)
    sq.state.destPins[0] = PIN_CAP_SQUARE_TIMER
    expect(isOverCapacity(sq.state, 0)).toBe(true)
    sq.state.destPins[0] = PIN_CAP_SQUARE_HARD
    expect(isOverCapacity(sq.state, 0), 'and still over at the hard cap').toBe(true)

    const ci = overcrowdRig({ kind: DEST_KIND_CIRCLE, pins: PIN_CAP_CIRCLE_TIMER - 1 })
    expect(isOverCapacity(ci.state, 0)).toBe(false)
    ci.state.destPins[0] = PIN_CAP_CIRCLE_TIMER
    expect(isOverCapacity(ci.state, 0)).toBe(true)
  })
})

describe('the overcrowd meter', () => {
  it('unwinds at 2x the full fill rate once back under capacity, and floors at zero', () => {
    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
    for (let i = 0; i < OVERCROWD_RAMP_FULL_TICKS + 100; i++) runOvercrowd(state)
    const peak = state.destOvercrowd[0] as number
    // Vacuity: the meter must have climbed past the unwind step, or "falls by
    // OVERCROWD_RETURN_MUL" is indistinguishable from "falls to 0".
    expect(peak).toBeGreaterThan(OVERCROWD_RETURN_MUL)
    state.destPins[0] = 0
    runOvercrowd(state)
    expect(state.destOvercrowd[0]).toBe(peak - OVERCROWD_RETURN_MUL)
    expect(state.destOverTicks[0], 'the ramp resets, it does not merely pause').toBe(0)
    // `ceil(peak / OVERCROWD_RETURN_MUL) + 1` ticks, not `peak` ticks: the
    // first draft ran 850,000 iterations to prove a floor at 0, which is the
    // same assertion at 400x the cost.
    const need = Math.ceil(peak / OVERCROWD_RETURN_MUL) + 1
    for (let i = 0; i < need; i++) runOvercrowd(state)
    expect(state.destOvercrowd[0], 'floored, never negative').toBe(0)
  })

  it('restarts the ramp from zero after an unwind, rather than resuming it', () => {
    // The second half of "resets, does not pause", stated as a fill RATE rather
    // than as a counter: after a long over-capacity run and one tick under, the
    // next over-capacity tick must add `overcrowdRampSpeed(1)` = 0 and not the
    // saturated 1,000. A mutant that leaves `destOverTicks` alone on the under
    // branch passes the counter assertion above only if it also resets, so this
    // is the arm that says the ramp is really being re-walked.
    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
    for (let i = 0; i < OVERCROWD_RAMP_FULL_TICKS + 100; i++) runOvercrowd(state)
    expect(state.destOverTicks[0]).toBe(OVERCROWD_RAMP_FULL_TICKS)
    state.destPins[0] = 0
    runOvercrowd(state)
    state.destPins[0] = PIN_CAP_SQUARE_TIMER
    const before = state.destOvercrowd[0] as number
    runOvercrowd(state)
    expect(state.destOverTicks[0]).toBe(1)
    expect((state.destOvercrowd[0] as number) - before, 'the first tick of a fresh ramp adds 0').toBe(
      overcrowdRampSpeed(1),
    )
  })

  it('saturates destOverTicks so no run length can overflow it', () => {
    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
    for (let i = 0; i < OVERCROWD_RAMP_FULL_TICKS * 3; i++) runOvercrowd(state)
    expect(state.destOverTicks[0]).toBe(OVERCROWD_RAMP_FULL_TICKS)
  })

  it('leaves a destination outside the live prefix alone', () => {
    // `H_DEST_COUNT` is the live prefix (destinations are append-only), and a
    // slot past it holds a zero `destMeta` — which decodes as a SQUARE, so an
    // unbounded loop would read `destPins` 0 against a trigger of 6, take the
    // under-capacity branch, and be invisible. The observable has to be a slot
    // that WOULD be over capacity if it were read.
    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
    state.destPins[1] = PIN_CAP_SQUARE_HARD
    runOvercrowd(state)
    expect(state.destOverTicks[0], 'the live one ticked').toBe(1)
    expect(state.destOverTicks[1], 'the one past H_DEST_COUNT did not').toBe(0)
    expect(state.destOvercrowd[1]).toBe(0)
  })
})

describe('the arrival knockback', () => {
  it('knocks 10% off on arrival, capped at 3 s, and reads destPins with no carpark immunity', () => {
    // §5.8: "There is no carpark immunity - a car metres from the bay does not
    // save you." So the meter reads `destPins`, NOT `destPins - destReserved`:
    // a reserved pin is still a customer waiting.
    expect(arrivalKnockback(0)).toBe(0)
    expect(arrivalKnockback(500000)).toBe(50000)
    // **900,000 is a 0-DETECTOR for the cap, and the first draft labelled it
    // "the cap binds exactly here".** ARRIVAL_KNOCKBACK_PCT is 100 over DENOM
    // 1000, so 900,000 * 100 / 1000 is exactly 90,000 and `>` and `>=` return
    // the same number there. Probe either side of it instead.
    expect(arrivalKnockback(899990), 'below the cap, uncapped').toBe(89999)
    expect(arrivalKnockback(910000), 'above it: 91,000 clamped to 90,000').toBe(
      ARRIVAL_KNOCKBACK_MAX_MILLITICKS,
    )
    expect(arrivalKnockback(OVERCROWD_FAIL_MILLITICKS)).toBe(ARRIVAL_KNOCKBACK_MAX_MILLITICKS)
    // The 0-detector is asserted rather than only described, so a future reader
    // who moves the probe back to 900,000 finds out why it was moved.
    expect((900000 * ARRIVAL_KNOCKBACK_PCT) / DENOM).toBe(ARRIVAL_KNOCKBACK_MAX_MILLITICKS)

    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER, reserved: PIN_CAP_SQUARE_TIMER })
    runOvercrowd(state)
    expect(state.destOverTicks[0], 'a fully-reserved destination is still over capacity').toBe(1)
  })

  it('applies the knockback to the stored meter, floored at zero', () => {
    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
    state.destOvercrowd[0] = 500000
    applyArrivalKnockback(state, 0)
    expect(state.destOvercrowd[0]).toBe(450000)
    // At 0 the knockback is 0, so the floor holds without a clamp — the
    // assertion below is what says so rather than a branch.
    state.destOvercrowd[0] = 0
    applyArrivalKnockback(state, 0)
    expect(state.destOvercrowd[0]).toBe(0)
  })

  it('throws by name rather than storing a negative meter', () => {
    expect(() => {
      assertOvercrowdNonNegative(-1, 7)
    }).toThrow(/destination 7 reached a meter of -1/)
    expect(() => {
      assertOvercrowdNonNegative(0, 0)
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// The survivability boundary — MEASURED, not asserted from the algebra
// ---------------------------------------------------------------------------

/** 30..600 step 10, plus 85..100 step 1 — dense across the boundary, coarse away from it. */
const SWEEP_PERIODS: readonly number[] = Object.freeze(
  Array.from(
    new Set([
      ...Array.from({ length: 58 }, (_, i) => 30 + i * 10),
      ...Array.from({ length: 16 }, (_, i) => 85 + i),
    ]),
  ).sort((a, b) => a - b),
)

/**
 * Two million ticks — **stated rather than chosen by feel**, because just past
 * the fixed point the meter grows very slowly and a SHORT horizon reports a
 * softer boundary than the true one. Measured, and asserted below rather than
 * described: at 40,000 ticks this sweep says the largest surviving period is
 * **94**; at 2,000,000 it says **90**.
 */
const SWEEP_HORIZON_TICKS = 2000000
/** The short horizon the assertion below uses to show that a short one lies. */
const SWEEP_SHORT_HORIZON_TICKS = 40000

interface Observation {
  readonly period: number
  /** The tick the meter reached `OVERCROWD_FAIL_MILLITICKS`, or -1 if it never did. */
  readonly died: number
}

/**
 * One period, driven to `horizon`, in the **production within-tick order**:
 * the arrival knockback is phase 9 and the meter integration is phase 10, so a
 * car arriving on tick T knocks the meter back BEFORE that tick's integration.
 *
 * **The order matters and it is worth exactly one arrival period, so it is a
 * named parameter of this helper rather than an incidental line order.** Run
 * the other way round — integrate, then knock back — the boundary is
 * unchanged at 90/91 (it is a property of the fixed point, not of the phasing)
 * but every illustrative death tick moves: P = 91 reads 163,253 instead of
 * 163,162 and P = 92 reads 84,362 instead of 84,271. The brief's draft of this
 * sweep had the two lines the other way, which models phase 10 running before
 * phase 9 — the exact transposition the brink test in `trips.test.ts` exists to
 * refuse. Its stated numbers were right; its code was not.
 */
function sweepPeriod(period: number, horizon: number): number {
  const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
  for (let t = 1; t <= horizon; t++) {
    if (t % period === 0) applyArrivalKnockback(state, 0)
    runOvercrowd(state)
    if ((state.destOvercrowd[0] as number) >= OVERCROWD_FAIL_MILLITICKS) return t
  }
  return -1
}

function largestSurviving(observed: readonly Observation[]): number {
  let best = -1
  for (const o of observed) if (o.died < 0 && o.period > best) best = o.period
  return best
}

function smallestDying(observed: readonly Observation[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const o of observed) if (o.died > 0 && o.period < best) best = o.period
  return best
}

/**
 * **An explicit timeout, because vitest's default 5,000 ms sits INSIDE this
 * sweep's own run-time band and that is a flaky test wearing a tight one.**
 * Measured: 3,433 ms with this file run alone, and 5,145 ms — a timeout — under
 * the parallel whole-suite run, on the first attempt. 60 s is 17x the quiet
 * figure and 12x the loaded one, which is outside the band in the direction
 * that cannot fail on noise while still catching a sweep that has become
 * quadratic.
 */
const SWEEP_TIMEOUT_MS = 60000

describe('the survivability boundary, swept', () => {
  it('a destination at its cap survives iff it is served more often than every 90 ticks, and the cliff is sharp', () => {
    // The fixed point, derived: at cap the meter fills at DENOM/tick once the
    // ramp saturates, and every arrival removes `min(meter/10, 90,000)`, so the
    // fixed point is `M = 10,000 * P` — which exists only while it is under the
    // 900,000 point where the cap binds. **P <= 90 ticks (3 s) survives; P > 90
    // grows without bound.** There is NO MIDDLE, and plan Decision 2 is built
    // on that being true, so it is swept rather than asserted from the algebra
    // (integer truncation in three places can move an exact boundary).
    //
    // Measured at this file's 2,000,000-tick horizon, in `sweepPeriod`'s stated
    // within-tick order: largest surviving P = 90; 91 dies at tick 163,162 and
    // 92 at 84,271. Note the shape of that — just past the fixed point the
    // meter grows very slowly, so a SHORT horizon reports a softer boundary
    // than the true one, which the second arm below asserts rather than
    // describes. That is why the horizon is a named constant and not chosen by
    // feel.
    const observed: Observation[] = []
    for (const period of SWEEP_PERIODS) {
      observed.push({ period, died: sweepPeriod(period, SWEEP_HORIZON_TICKS) })
    }
    expect(largestSurviving(observed)).toBe(90)
    expect(smallestDying(observed)).toBe(91)
    // Vacuity on both sides: something must survive and something must die, or
    // the sweep covers one regime and proves nothing.
    expect(
      observed.some((o) => o.died < 0),
      'something must survive',
    ).toBe(true)
    expect(
      observed.some((o) => o.died > 0),
      'something must die',
    ).toBe(true)
    // The sweep must actually straddle the boundary, or the two answers above
    // are properties of where the list stops rather than of the model.
    expect(SWEEP_PERIODS).toContain(90)
    expect(SWEEP_PERIODS).toContain(91)
    // And the cliff is SHARP: every period at or below the boundary survives
    // and every period above it dies, with nothing in between. This is the
    // assertion plan Decision 2 rests on; the two numbers above are satisfied
    // by a ragged boundary as well as by a clean one.
    for (const o of observed) {
      if (o.period <= 90) expect(o.died, `P = ${o.period} must survive`).toBe(-1)
      else expect(o.died, `P = ${o.period} must die`).toBeGreaterThan(0)
    }
    // The two ticks either side, recorded as values rather than as prose — this
    // is what "a short horizon reports a softer boundary" means concretely.
    const by = new Map(observed.map((o) => [o.period, o.died]))
    expect(by.get(91)).toBe(163162)
    expect(by.get(92)).toBe(84271)
    expect(by.get(91), 'and the slow side is the LONGER one, which is the trap').toBeGreaterThan(
      by.get(92) as number,
    )
  }, SWEEP_TIMEOUT_MS)

  it('a SHORT horizon reports a softer boundary, which is why the horizon is a named constant', () => {
    // The claim the long sweep's comment makes, turned into an assertion. At
    // 40,000 ticks — twice the length of the longest window anything in this
    // repo drives — the same sweep answers **94**, four periods past the truth.
    // Anyone shortening `SWEEP_HORIZON_TICKS` for run time is buying a wrong
    // answer, and this is where they find out.
    const observed: Observation[] = []
    for (const period of SWEEP_PERIODS) {
      observed.push({ period, died: sweepPeriod(period, SWEEP_SHORT_HORIZON_TICKS) })
    }
    expect(largestSurviving(observed), 'the short horizon lies, and this is the lie').toBe(94)
    expect(smallestDying(observed)).toBe(95)
    // Vacuity on both sides again, or "94" is a property of where the list ends.
    expect(
      observed.some((o) => o.died > 0),
      'something must die even at the short horizon',
    ).toBe(true)
    expect(SWEEP_SHORT_HORIZON_TICKS).toBeLessThan(SWEEP_HORIZON_TICKS)
    // And the two horizons genuinely disagree, which is the whole point.
    expect(largestSurviving(observed)).toBeGreaterThan(90)
  }, SWEEP_TIMEOUT_MS)

  it('the fixed point is 10,000 x the arrival period, which is why 90 is the boundary', () => {
    // The algebra behind the sweep, asserted so that a reader can check the
    // number rather than take the sweep's word for it: at P = 90 the meter's
    // PEAK parks at exactly the point where the 3 s cap starts binding.
    expect(10000 * 90).toBe((ARRIVAL_KNOCKBACK_MAX_MILLITICKS * DENOM) / ARRIVAL_KNOCKBACK_PCT)
    expect(arrivalKnockback(10000 * 90)).toBe(ARRIVAL_KNOCKBACK_MAX_MILLITICKS)
    expect(arrivalKnockback(10000 * 91), 'one period past it the knockback stops keeping up').toBe(
      ARRIVAL_KNOCKBACK_MAX_MILLITICKS,
    )
    expect(10000 * 91).toBeGreaterThan(ARRIVAL_KNOCKBACK_MAX_MILLITICKS * 10)

    // **The cycle, measured, and it is a cycle rather than a single value —
    // which the first draft of this assertion got wrong.** The meter does not
    // park AT 900,000; it oscillates, peaking at exactly 900,000 on the tick
    // before an arrival and sitting at 811,000 on the arrival tick itself —
    // 900,000 knocked back by the 90,000 cap and then given that tick's own
    // 1,000 of fill. 900,000 is where the cap starts binding, so the peak
    // sitting exactly on it is what "P = 90 is the last surviving period" means
    // physically, and the 89,000 it climbs back over the following 89 ticks is
    // what makes the cycle close.
    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
    for (let t = 1; t <= 199979; t++) {
      if (t % 90 === 0) applyArrivalKnockback(state, 0)
      runOvercrowd(state)
    }
    expect(199979 % 90, 'vacuity: the loop above must stop one tick BEFORE an arrival').toBe(89)
    expect(state.destOvercrowd[0], 'the peak, on the tick before an arrival').toBe(900000)
    for (let t = 199980; t <= 199980; t++) {
      if (t % 90 === 0) applyArrivalKnockback(state, 0)
      runOvercrowd(state)
    }
    expect(state.destOvercrowd[0], 'and the trough, on the tick of one').toBe(811000)
    expect(900000 - 811000, 'the cycle is the cap minus that tick’s own fill').toBe(
      ARRIVAL_KNOCKBACK_MAX_MILLITICKS - DENOM,
    )
    expect((900000 - 811000) / DENOM + 1, 'and it closes over exactly P ticks').toBe(90)
    expect(900000).toBeLessThan(OVERCROWD_FAIL_MILLITICKS)
  })
})

describe('the constants this file integrates', () => {
  it('converts §5.8 once, in constants.ts, and the products are the spec numbers', () => {
    expect(OVERCROWD_FULL_MILLITICKS).toBe(2700000)
    expect(OVERCROWD_GRACE_MILLITICKS).toBe(60000)
    expect(OVERCROWD_FAIL_MILLITICKS).toBe(2640000)
    expect(OVERCROWD_RAMP_FULL_TICKS).toBe(1500)
    expect(ARRIVAL_KNOCKBACK_MAX_MILLITICKS).toBe(90000)
    // The grace is HIDDEN: the ring Task 9 draws is the meter over
    // OVERCROWD_FULL_MILLITICKS, so it reads 97.8 % at the instant the city
    // dies. That ratio is the whole reason the two constants differ.
    expect(
      Math.round((OVERCROWD_FAIL_MILLITICKS / OVERCROWD_FULL_MILLITICKS) * 1000) / 10,
    ).toBe(97.8)
    // The saturation ceiling and the ramp's full point are the SAME number by
    // construction — a ceiling below it makes the ramp unreachable and one
    // above it is bytes nothing reads.
    expect(OVERCROWD_RAMP_FULL_TICKS).toBe((DENOM / OVERCROWD_RAMP) * TICKS_PER_SECOND)
  })
})
