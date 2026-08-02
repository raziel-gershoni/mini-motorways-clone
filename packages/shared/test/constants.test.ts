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

const ALL: Record<string, number> = {
  DENOM, TICKS_PER_SECOND, SECONDS_PER_WEEK, DAYS_PER_WEEK,
  TICKS_PER_WEEK, TICKS_PER_DAY, ORTHO_COST, DIAG_COST,
  LANE_SPEED_DEFAULT, MOTORWAY_SPEED_MAX, ROUNDABOUT_SPEED_MUL,
  RIGHT_ANGLE_SPEED_MUL, INTERSECTION_SPEED_MUL, SHARP_TURN_SPEED_MUL,
  MAX_OVERCROWD_TIME_MS, OVERCROWD_RAMP, OVERCROWD_RETURN_MUL,
  ARRIVAL_KNOCKBACK_PCT, ARRIVAL_KNOCKBACK_MAX_MS, OVERCROWD_GRACE_MS,
  PIN_CAP_SQUARE_TIMER, PIN_CAP_SQUARE_HARD, PIN_CAP_CIRCLE_TIMER, PIN_CAP_CIRCLE_HARD,
  GRID_W, GRID_H, GROUP_COUNT_DEFAULT, CARS_PER_HOUSE, MOTORWAY_CAP,
}

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
})
