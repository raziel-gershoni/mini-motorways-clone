import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  DENOM, TICKS_PER_SECOND, SECONDS_PER_WEEK, DAYS_PER_WEEK,
  TICKS_PER_WEEK, TICKS_PER_DAY,
  ORTHO_COST, DIAG_COST,
  LANE_SPEED_DEFAULT, MOTORWAY_SPEED_MAX, ROUNDABOUT_SPEED_MUL,
  RIGHT_ANGLE_SPEED_MUL, INTERSECTION_SPEED_MUL, SHARP_TURN_SPEED_MUL,
  MAX_BLOCKED_TICKS,
  MAX_OVERCROWD_TIME_MS, OVERCROWD_RAMP, OVERCROWD_RETURN_MUL,
  ARRIVAL_KNOCKBACK_PCT, ARRIVAL_KNOCKBACK_MAX_MS, OVERCROWD_GRACE_MS,
  OVERCROWD_FULL_MILLITICKS, OVERCROWD_GRACE_MILLITICKS, OVERCROWD_FAIL_MILLITICKS,
  OVERCROWD_RAMP_FULL_TICKS, ARRIVAL_KNOCKBACK_MAX_MILLITICKS,
  PIN_CAP_SQUARE_TIMER, PIN_CAP_SQUARE_HARD, PIN_CAP_CIRCLE_TIMER, PIN_CAP_CIRCLE_HARD,
  GRID_W, GRID_H, GROUP_COUNT_DEFAULT, CARS_PER_HOUSE, MOTORWAY_CAP,
  REVEALED_X0, REVEALED_Y0, REVEALED_W, REVEALED_H,
  MAX_GROUP_COUNT, MAX_PATH_LEN,
  COST_UNIT_SCALE, CAR_SPEED_UNITS_PER_TICK,
  MS_PER_SECOND, DESTINATIONS_PER_WEEK, DEST_SPAWN_PERIOD_TICKS, HOUSE_SPAWN_PERIOD_TICKS,
  WEEKLY_TILE_GRANT,
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
    // plan Decision 5 and to be made dynamic by M1f — NOT by M1d and NOT by
    // M1e, both of which declined board expansion, and this comment has now
    // named a passed milestone in the past tense twice while the four literals
    // below never moved. The
    // integer/finite/non-negative
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

  it('sets the anti-deadlock valve at the spec 45 s, derived through the clock', () => {
    // Spec §5.5: "max wait at an intersection before proceeding anyway is 45 s",
    // at TICKS_PER_SECOND. M1d Task 4.
    expect(MAX_BLOCKED_TICKS).toBe(45 * TICKS_PER_SECOND)
    expect(MAX_BLOCKED_TICKS).toBe(1350)
    // Read back as seconds, exactly — a valve that is not a whole number of
    // seconds means the clock changed under it and nobody re-derived it.
    expect(MAX_BLOCKED_TICKS % TICKS_PER_SECOND).toBe(0)
    expect(MAX_BLOCKED_TICKS / TICKS_PER_SECOND).toBe(45)
    // **The two width facts the `carBlockedTicks` region rests on**, asserted
    // here because this is where the number lives and `regions.ts` only recites
    // them. Above 255, so a Uint8 counter could never reach the threshold and
    // the valve would silently never fire; below the Int16 ceiling with room to
    // spare, so the region's element type is not marginal.
    expect(MAX_BLOCKED_TICKS).toBeGreaterThan(255)
    expect(MAX_BLOCKED_TICKS).toBeLessThan(32767)
    // 45 s is 30 % of a week, which is the price of a genuine circular wait and
    // would be an absurd one for a common event — the reason Decision 1's lane
    // rule has to make head-on structurally impossible BEFORE this exists.
    expect(MAX_BLOCKED_TICKS * 10).toBeLessThan(TICKS_PER_WEEK * 4)
  })

  it('derives the valve from the clock rather than storing the product', () => {
    // The plan asks for MAX_BLOCKED_TICKS "derived rather than written as a
    // literal", and `toBe(45 * TICKS_PER_SECOND)` above is satisfied by a bare
    // 1350 just as happily. This is the assertion that is not: the declaration
    // itself must name the clock constant. Same idiom as `loop.test.ts`'s
    // cross-file golden scan — read the source, assert the text.
    const src = readFileSync(new URL('../src/constants.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/export const MAX_BLOCKED_TICKS = 45 \* TICKS_PER_SECOND/)
    expect(src).not.toMatch(/export const MAX_BLOCKED_TICKS = 1350/)
    // Vacuity: the scan is reading the real file, not an empty string.
    expect(src).toMatch(/export const TICKS_PER_SECOND = 30/)
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

  it('converts every §5.8 constant to MILLI-TICKS exactly once, and the products are exact integers', () => {
    // M1e Task 7. A tick is 1000/30 ms, so a millisecond-denominated meter
    // cannot be exact; the meter is denominated in ticks x DENOM and the
    // conversion happens here and nowhere else. The `ALL` registry above
    // already covers integrality and non-negativity for every numeric export
    // automatically — what it cannot see is the VALUES, which is what makes
    // the spec's "~113 s" land on an integer.
    expect(OVERCROWD_FULL_MILLITICKS).toBe(2700000)
    expect(OVERCROWD_GRACE_MILLITICKS).toBe(60000)
    expect(OVERCROWD_FAIL_MILLITICKS).toBe(2640000)
    expect(OVERCROWD_RAMP_FULL_TICKS).toBe(1500)
    expect(ARRIVAL_KNOCKBACK_MAX_MILLITICKS).toBe(90000)

    // Read back through the clock, so a change to TICKS_PER_SECOND or DENOM
    // fails here rather than silently rescaling the whole failure model.
    expect(OVERCROWD_FULL_MILLITICKS / DENOM / TICKS_PER_SECOND).toBe(90)
    expect(OVERCROWD_GRACE_MILLITICKS / DENOM / TICKS_PER_SECOND).toBe(2)
    expect(OVERCROWD_FAIL_MILLITICKS / DENOM / TICKS_PER_SECOND).toBe(88)
    expect(ARRIVAL_KNOCKBACK_MAX_MILLITICKS / DENOM / TICKS_PER_SECOND).toBe(3)
    expect(OVERCROWD_RAMP_FULL_TICKS / TICKS_PER_SECOND).toBe(50)

    // **The derived death time, which is the number this milestone turns on.**
    // The ramp phase sums to 750,000 milli-ticks (hand-derived in
    // `sim/test/overcrowd.test.ts`), and the remainder accrues at DENOM per
    // tick. 1,500 + 1,890 = 3,390 ticks = 113.0 s exactly.
    const afterRamp = (OVERCROWD_FAIL_MILLITICKS - 750000) / DENOM
    expect(afterRamp).toBe(1890)
    expect(OVERCROWD_RAMP_FULL_TICKS + afterRamp).toBe(3390)
    expect((OVERCROWD_RAMP_FULL_TICKS + afterRamp) / TICKS_PER_SECOND).toBe(113)

    // The grace is what makes the ring lie: it is BELOW the full meter, so the
    // displayed fraction at the moment of death is 97.8 % and not 100 %.
    expect(OVERCROWD_FAIL_MILLITICKS).toBeLessThan(OVERCROWD_FULL_MILLITICKS)
    expect(
      Math.round((OVERCROWD_FAIL_MILLITICKS / OVERCROWD_FULL_MILLITICKS) * 1000) / 10,
    ).toBe(97.8)

    // The arrival knockback's cap binds at a meter of exactly 900,000, which is
    // why `overcrowd.test.ts` probes 899,990 and 910,000 rather than 900,000 —
    // at 900,000 a `>` and a `>=` clamp return the same number and the probe is
    // a measured 0-detector.
    expect((ARRIVAL_KNOCKBACK_MAX_MILLITICKS * DENOM) / ARRIVAL_KNOCKBACK_PCT).toBe(900000)
  })

  it('derives the milli-tick constants from the clock rather than storing the products', () => {
    // Same idiom as the MAX_BLOCKED_TICKS and spawn-cadence scans above: every
    // `toBe(2700000)` in the test one up is satisfied by a bare literal just as
    // happily, and the whole point of Decision 4 is that the conversion is
    // written once, in terms of the clock.
    const src = readFileSync(new URL('../src/constants.ts', import.meta.url), 'utf8')
    expect(src).toMatch(
      /export const OVERCROWD_FULL_MILLITICKS =\s*\n?\s*\(MAX_OVERCROWD_TIME_MS \/ MS_PER_SECOND\) \* TICKS_PER_SECOND \* DENOM/,
    )
    expect(src).toMatch(
      /export const OVERCROWD_RAMP_FULL_TICKS = \(DENOM \/ OVERCROWD_RAMP\) \* TICKS_PER_SECOND/,
    )
    expect(src).toMatch(
      /export const OVERCROWD_FAIL_MILLITICKS = OVERCROWD_FULL_MILLITICKS - OVERCROWD_GRACE_MILLITICKS/,
    )
    expect(src).not.toMatch(/export const OVERCROWD_FULL_MILLITICKS = 2700000/)
    expect(src).not.toMatch(/export const OVERCROWD_RAMP_FULL_TICKS = 1500/)
    expect(src).not.toMatch(/export const OVERCROWD_FAIL_MILLITICKS = 2640000/)
    // Vacuity: the scan is reading the real file, not an empty string.
    expect(src).toMatch(/export const OVERCROWD_RAMP = 20/)
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

  it('derives both M1e spawn cadences through the clock, at the intervals §5.9 states', () => {
    // M1e Task 1. Both are conversions, and the conversion belongs in
    // `constants.ts` and nowhere else — the same rule `FIRST_PIN_DELAY_TICKS`
    // and `MAX_BLOCKED_TICKS` already follow.
    expect(HOUSE_SPAWN_PERIOD_TICKS).toBe(10 * TICKS_PER_SECOND)
    expect(HOUSE_SPAWN_PERIOD_TICKS).toBe(300)
    expect(HOUSE_SPAWN_PERIOD_TICKS / TICKS_PER_SECOND).toBe(10) // reads back as §5.9's 10 s, exactly
    expect(DESTINATIONS_PER_WEEK).toBe(2)
    expect(DEST_SPAWN_PERIOD_TICKS).toBe(TICKS_PER_WEEK / DESTINATIONS_PER_WEEK)
    expect(DEST_SPAWN_PERIOD_TICKS).toBe(2250)
    // A period that is not a whole number of ticks would be silently truncated
    // by the countdown and drift the schedule against the week — the exact
    // failure `TICKS_PER_DAY` is 0 to prevent. `DESTINATIONS_PER_WEEK` must
    // therefore divide the week.
    expect(TICKS_PER_WEEK % DESTINATIONS_PER_WEEK).toBe(0)
    expect(Number.isInteger(DEST_SPAWN_PERIOD_TICKS)).toBe(true)
    // Both are the initial value of a countdown `createState` arms, so a zero
    // or negative period means every spawner fires on tick 1 forever.
    expect(HOUSE_SPAWN_PERIOD_TICKS).toBeGreaterThan(0)
    expect(DEST_SPAWN_PERIOD_TICKS).toBeGreaterThan(0)
    // They are different cadences and must stay so: a house attempt is 15x more
    // frequent than a destination attempt, which is what makes one a per-colour
    // trickle and the other a weekly event.
    expect(DEST_SPAWN_PERIOD_TICKS).toBeGreaterThan(HOUSE_SPAWN_PERIOD_TICKS)
  })

  it('derives both spawn cadences from the clock rather than storing the products', () => {
    // Same idiom as the MAX_BLOCKED_TICKS scan above, and for the same reason:
    // `toBe(10 * TICKS_PER_SECOND)` is satisfied by a bare 300 just as happily.
    const src = readFileSync(new URL('../src/constants.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/export const HOUSE_SPAWN_PERIOD_TICKS = 10 \* TICKS_PER_SECOND/)
    expect(src).not.toMatch(/export const HOUSE_SPAWN_PERIOD_TICKS = 300/)
    expect(src).toMatch(
      /export const DEST_SPAWN_PERIOD_TICKS = TICKS_PER_WEEK \/ DESTINATIONS_PER_WEEK/,
    )
    expect(src).not.toMatch(/export const DEST_SPAWN_PERIOD_TICKS = 2250/)
    // Vacuity: the scan is reading the real file, not an empty string.
    expect(src).toMatch(/export const TICKS_PER_WEEK = TICKS_PER_SECOND \* SECONDS_PER_WEEK/)
  })

  it('grants a FLAT weekly tile income that is never week-indexed', () => {
    // M1e Task 2, spec §5.10's Road Tiles card: the per-map constant "30 or
    // 40", 30 here. The flatness is the load-bearing half — §5.10 states "tile
    // income is flat, not week-indexed — difficulty ramps on the demand side
    // only" — and the way it is enforced is that the grant takes NO week
    // argument (`runWeekBoundary(state)`, `packages/sim/src/week.ts`), so
    // `WEEKLY_TILE_GRANT * week` is a change to production code and not a
    // configuration mistake. `sim/test/week.test.ts`'s three-week run is the
    // behavioural detector for it (60 + 90 != 90).
    //
    // One assertion, and that is the honest size of it: a bare literal has
    // exactly one property worth pinning. The integer/finite/non-negative
    // checks above already cover it automatically from the derived registry,
    // and adding `toBeGreaterThan(0)` here would be a decorative assertion
    // that reads as a load-bearing one.
    expect(WEEKLY_TILE_GRANT).toBe(30)
  })

  it('names the millisecond conversion so a /1000 cannot be misread as DENOM', () => {
    // MS_PER_SECOND and DENOM are both 1000 and mean entirely different things.
    // Asserted as equal-and-distinct on purpose: the day one of them changes,
    // every `/ 1000` in the codebase has to be re-read, and this is where that
    // is noticed.
    expect(MS_PER_SECOND).toBe(1000)
    expect(MS_PER_SECOND).toBe(DENOM) // true today, and not a definition
    expect(MAX_OVERCROWD_TIME_MS / MS_PER_SECOND).toBe(90) // spec §5.8's bare "90", read back
    expect(OVERCROWD_GRACE_MS / MS_PER_SECOND).toBe(2)
  })
})
