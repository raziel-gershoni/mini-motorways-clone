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
