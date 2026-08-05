import { describe, it, expect } from 'vitest'
import {
  DENOM, TICKS_PER_SECOND, SECONDS_PER_WEEK, DAYS_PER_WEEK,
  TICKS_PER_WEEK, TICKS_PER_DAY,
  ORTHO_COST, DIAG_COST,
  LANE_SPEED_DEFAULT, MOTORWAY_SPEED_MAX, ROUNDABOUT_SPEED_MUL,
  RIGHT_ANGLE_SPEED_MUL, INTERSECTION_SPEED_MUL, SHARP_TURN_SPEED_MUL,
  MAX_OVERCROWD_TIME_MS, OVERCROWD_RAMP, OVERCROWD_RETURN_MUL,
  ARRIVAL_KNOCKBACK_PCT, ARRIVAL_KNOCKBACK_MAX_MS, OVERCROWD_GRACE_MS,
  PIN_CAP_SQUARE_TIMER, PIN_CAP_SQUARE_HARD, PIN_CAP_CIRCLE_TIMER, PIN_CAP_CIRCLE_HARD,
  GRID_W, GRID_H, GROUP_COUNT_DEFAULT, CARS_PER_HOUSE, MOTORWAY_CAP,
  REVEALED_X0, REVEALED_Y0, REVEALED_W, REVEALED_H,
  MAX_GROUP_COUNT, MAX_PATH_LEN,
  COST_UNIT_SCALE, CAR_SPEED_UNITS_PER_TICK,
} from '../src/index'
import * as C from '../src/index'

/**
 * Derived from the module's real exports, not hand-listed. A hand-maintained
 * registry only checks the constants somebody remembered to add; this cannot
 * fall behind the source.
 */
const ALL: Record<string, number> = Object.fromEntries(
  Object.entries(C).filter(([, v]) => typeof v === 'number'),
) as Record<string, number>

describe('rule constants', () => {
  it('are every one an integer', () => {
    for (const [name, v] of Object.entries(ALL)) {
      expect(Number.isInteger(v), `${name} = ${v} is not an integer`).toBe(true)
    }
  })

  it('are every one finite and non-negative', () => {
    for (const [name, v] of Object.entries(ALL)) {
      expect(Number.isFinite(v), `${name} is not finite`).toBe(true)
      expect(v, `${name} is negative`).toBeGreaterThanOrEqual(0)
    }
  })

  it('checks every numeric export, not a hand-picked subset', () => {
    expect(Object.keys(ALL).length).toBeGreaterThanOrEqual(29)
    for (const name of ['DENOM', 'GRID_W', 'OVERCROWD_RAMP', 'MOTORWAY_CAP']) {
      expect(Object.keys(ALL)).toContain(name)
    }
  })

  it('uses a denominator of 1000 for scaled values', () => {
    expect(DENOM).toBe(1000)
    expect(LANE_SPEED_DEFAULT).toBe(DENOM)
  })

  it('encodes the reported lane-speed multipliers at that denominator', () => {
    // Spec §5.5: 3.0, 2.0, 0.667, 0.5, 0.333 against a 1.0 default.
    expect(MOTORWAY_SPEED_MAX).toBe(3000)
    expect(ROUNDABOUT_SPEED_MUL).toBe(2000)
    expect(RIGHT_ANGLE_SPEED_MUL).toBe(667)
    expect(INTERSECTION_SPEED_MUL).toBe(500)
    expect(SHARP_TURN_SPEED_MUL).toBe(333)
  })

  it('derives the clock consistently', () => {
    expect(TICKS_PER_SECOND).toBe(30)
    expect(SECONDS_PER_WEEK).toBe(150)
    expect(DAYS_PER_WEEK).toBe(7)
    expect(TICKS_PER_WEEK).toBe(TICKS_PER_SECOND * SECONDS_PER_WEEK)
    expect(TICKS_PER_WEEK).toBe(4500)
  })

  it('keeps TICKS_PER_DAY exact so days do not drift against weeks', () => {
    // 4500 / 7 is not an integer. TICKS_PER_DAY must therefore be derived per
    // day from the week boundary, not stored as a rounded constant — a rounded
    // one would accumulate 4500 - 7*642 = 6 ticks of drift every week.
    expect(TICKS_PER_DAY).toBe(0)
  })

  it('uses the 10/14 integer edge weights, which approximate 1 : sqrt(2)', () => {
    expect(ORTHO_COST).toBe(10)
    expect(DIAG_COST).toBe(14)
    expect(DIAG_COST / ORTHO_COST).toBeCloseTo(Math.SQRT2, 1)
  })

  it('sets pin caps with the timer threshold below the hard cap', () => {
    expect(PIN_CAP_SQUARE_TIMER).toBeLessThan(PIN_CAP_SQUARE_HARD)
    expect(PIN_CAP_CIRCLE_TIMER).toBeLessThan(PIN_CAP_CIRCLE_HARD)
    expect(PIN_CAP_SQUARE_TIMER).toBe(6)
    expect(PIN_CAP_SQUARE_HARD).toBe(10)
    expect(PIN_CAP_CIRCLE_TIMER).toBe(8)
    expect(PIN_CAP_CIRCLE_HARD).toBe(14)
  })

  it('matches the spec grid and agent constants', () => {
    expect(GRID_W).toBe(24)
    expect(GRID_H).toBe(40)
    expect(GROUP_COUNT_DEFAULT).toBe(5)
    expect(CARS_PER_HOUSE).toBe(2)
    expect(MOTORWAY_CAP).toBe(9)
  })

  it('reveals a 14 x 22 rect centred in the 24 x 40 board, entirely in bounds', () => {
    // Spec §3 decision row 4, "~24×40 grid revealed from 14×22", frozen by M2
    // plan Decision 5 and made dynamic by M1d. The integer/finite/non-negative
    // assertions above already cover these four automatically (the registry is
    // derived from the module's real exports); what they cannot see is the
    // three RELATIONS that make the rect meaningful — in bounds, centred, and
    // asymmetric.
    expect(REVEALED_W).toBe(14)
    expect(REVEALED_H).toBe(22)
    expect(REVEALED_X0).toBe(5)
    expect(REVEALED_Y0).toBe(9)

    // In bounds: a rect running off the board would index past the state
    // buffer's row stride and draw the next row's cells.
    expect(REVEALED_X0 + REVEALED_W).toBeLessThanOrEqual(GRID_W)
    expect(REVEALED_Y0 + REVEALED_H).toBeLessThanOrEqual(GRID_H)

    // Centred, derived rather than asserted as a second literal: this is where
    // 5 and 9 come from, and it is what keeps them right if the board resizes.
    expect(REVEALED_X0).toBe(Math.floor((GRID_W - REVEALED_W) / 2))
    expect(REVEALED_Y0).toBe(Math.floor((GRID_H - REVEALED_H) / 2))

    // Asymmetric on both axes. Load-bearing for every camera and pointer test
    // downstream: with x0 === y0, or cols === rows, a transposed axis in the
    // grid<->screen transform passes every round-trip fixture written against
    // this rect.
    expect(REVEALED_X0).not.toBe(REVEALED_Y0)
    expect(REVEALED_W).not.toBe(REVEALED_H)
  })

  it('bounds groupCount and the committed route length for M1c', () => {
    // MAX_GROUP_COUNT: destMeta packs colour in 3 bits (regions.ts), which is
    // exactly what makes a 6th group addressable — 2 bits would not.
    expect(MAX_GROUP_COUNT).toBe(6)
    // MAX_PATH_LEN: 1.5x the board's Manhattan diameter (GRID_W + GRID_H = 64).
    expect(MAX_PATH_LEN).toBe(96)
    expect(MAX_PATH_LEN).toBeGreaterThan(GRID_W + GRID_H)
    expect(MAX_PATH_LEN % 2).toBe(0) // two 4-bit directions pack per carRoute byte
  })

  it('calibrates movement so a diagonal costs exactly 1.40 of an orthogonal', () => {
    // M1c decision 3. Progress is accumulated in the pathfinder's own cost
    // units, so traversal time is proportional to the Dijkstra weight by
    // construction: the two thresholds are these products.
    expect(COST_UNIT_SCALE).toBe(250)
    expect(ORTHO_COST * COST_UNIT_SCALE).toBe(2500)
    expect(DIAG_COST * COST_UNIT_SCALE).toBe(3500)
    expect(CAR_SPEED_UNITS_PER_TICK).toBe(330)
  })

  it('keeps the car speed indivisible into BOTH thresholds, so the carry is always observable', () => {
    // Load-bearing, not cosmetic (M1c decision 3, constraint 2). If the speed
    // divided a threshold, the remainder on that edge type would always be
    // zero and the "drop the carry at a crossing" bug — a systematic slowdown
    // of a fraction of a tick per cell — would be invisible at every operating
    // point. Every exact-tick assertion in `sim/test/cars.test.ts` is
    // calibrated against the two CARRIES this leaves — 140 units on an
    // orthogonal and 130 on a diagonal, which are `speed - remainder`, not the
    // remainders themselves (190 and 200). Both forms are asserted below,
    // because the pair is easy to transpose in prose. A future speed change
    // that made either carry zero would silently disarm the whole file rather
    // than fail it. This is where it fails instead.
    // 2500 = 7 * 330 + 190, so the eighth tick overshoots by 330 - 190 = 140
    // units, which is what the car carries onto its next cell.
    expect((ORTHO_COST * COST_UNIT_SCALE) % CAR_SPEED_UNITS_PER_TICK).toBe(190)
    expect(CAR_SPEED_UNITS_PER_TICK - 190).toBe(140)
    // 3500 = 10 * 330 + 200, so the eleventh tick overshoots by 130.
    expect((DIAG_COST * COST_UNIT_SCALE) % CAR_SPEED_UNITS_PER_TICK).toBe(200)
    expect(CAR_SPEED_UNITS_PER_TICK - 200).toBe(130)
    expect(CAR_SPEED_UNITS_PER_TICK).toBeLessThan(ORTHO_COST * COST_UNIT_SCALE) // at most one crossing per tick
  })

  it('encodes the failure constants at the right scale', () => {
    // Spec §5.8. MAX_OVERCROWD_TIME_MS is the spec's bare "90" read as seconds
    // and converted to ms; OVERCROWD_RAMP and OVERCROWD_RETURN_MUL are ratios
    // scaled by DENOM; ARRIVAL_KNOCKBACK_PCT is 10% expressed the same way.
    expect(MAX_OVERCROWD_TIME_MS).toBe(90000)
    expect(OVERCROWD_RAMP).toBe(20)
    expect(OVERCROWD_RETURN_MUL).toBe(2000)
    expect(ARRIVAL_KNOCKBACK_PCT).toBe(100)
    expect(ARRIVAL_KNOCKBACK_MAX_MS).toBe(3000)
    expect(OVERCROWD_GRACE_MS).toBe(2000)
  })

  it('keeps the overcrowd ramp consistent with the derived time-to-death', () => {
    // Spec §5.8 works this through: timer speed s(t) = min(1, ramp*t), so with
    // zero arrivals the meter fills in 115 s — 50 s ramping up while
    // accumulating 25 of the 90, then 65 s at full rate. This asserts the two
    // constants still produce that, so a change to either is caught here rather
    // than discovered as a balance mystery.
    const ramp = OVERCROWD_RAMP / DENOM       // test-only: reading the scaled value
    const rampSeconds = 1 / ramp              // time to reach full speed
    const accruedWhileRamping = (rampSeconds * 1) / 2
    const remaining = MAX_OVERCROWD_TIME_MS / 1000 - accruedWhileRamping
    expect(rampSeconds).toBeCloseTo(50, 6)
    expect(accruedWhileRamping).toBeCloseTo(25, 6)
    expect(rampSeconds + remaining).toBeCloseTo(115, 6)
  })
})
