/**
 * Every scaled quantity in the simulation is an integer numerator over this
 * denominator. A multiplier of 0.667 is 667. The conversion lives here and
 * nowhere else — sim code never sees a decimal.
 */
export const DENOM = 1000

// --- Clock (spec §3 decision 10, §5.10) ---
export const TICKS_PER_SECOND = 30
export const SECONDS_PER_WEEK = 150
export const DAYS_PER_WEEK = 7
export const TICKS_PER_WEEK = TICKS_PER_SECOND * SECONDS_PER_WEEK

/**
 * Deliberately 0, and deliberately not used as a divisor.
 *
 * 4500 ticks / 7 days is 642.857..., so any stored per-day tick count is wrong.
 * Rounding to 642 would drift 6 ticks per week and desynchronise the day
 * counter from the week boundary within a few weeks of play. `dayOfWeek()` in
 * the sim derives the day from the tick offset within the week instead, which
 * is exact by construction. This constant exists only so that a future reader
 * reaching for it finds this explanation rather than inventing 642.
 */
export const TICKS_PER_DAY = 0

// --- Pathfinding edge weights (spec §5.4) ---
export const ORTHO_COST = 10
export const DIAG_COST = 14

// --- Lane speeds, scaled by DENOM (spec §5.5) ---
export const LANE_SPEED_DEFAULT = 1000
export const MOTORWAY_SPEED_MAX = 3000
export const ROUNDABOUT_SPEED_MUL = 2000
export const RIGHT_ANGLE_SPEED_MUL = 667
export const INTERSECTION_SPEED_MUL = 500
export const SHARP_TURN_SPEED_MUL = 333

// --- Failure (spec §5.8) ---
/**
 * The spec states this as a bare "90" — a threshold on the integrated
 * overcrowd meter, in seconds-equivalent, not a duration by itself. Stored
 * here already converted to ms so downstream code never multiplies by 1000
 * at the call site and risks doing it twice, or not at all.
 */
export const MAX_OVERCROWD_TIME_MS = 90000
export const OVERCROWD_RAMP = 20          // 0.02 x DENOM
export const OVERCROWD_RETURN_MUL = 2000  // 2.0 x DENOM
export const ARRIVAL_KNOCKBACK_PCT = 100  // 10% x DENOM
export const ARRIVAL_KNOCKBACK_MAX_MS = 3000
export const OVERCROWD_GRACE_MS = 2000

// --- Pin capacities (spec §5.8, [OURS]) ---
export const PIN_CAP_SQUARE_TIMER = 6
export const PIN_CAP_SQUARE_HARD = 10
export const PIN_CAP_CIRCLE_TIMER = 8
export const PIN_CAP_CIRCLE_HARD = 14

// --- Board and agents (spec §2.2, §3, §5.1, §5.2, §5.7) ---
export const GRID_W = 24
export const GRID_H = 40
export const GROUP_COUNT_DEFAULT = 5
export const CARS_PER_HOUSE = 2
export const MOTORWAY_CAP = 9

/**
 * Upper bound on `MapData.groupCount` (spec §4.2's exhaustive enumeration:
 * colour group count is per-map, 5 or 6 — this is the ceiling `parseMap`
 * validates against, not a claim that 6 is typical). `destMeta`'s packed
 * colour field (roads.ts / buildings.ts, M1c) is 3 bits specifically because
 * 2 bits cannot address a 6th group.
 */
export const MAX_GROUP_COUNT = 6

/**
 * Maximum steps in a committed car route (M1c decision 2): 24 + 40 = 64 is
 * the board's Manhattan diameter (`GRID_W + GRID_H`); 96 gives 1.5x headroom
 * for detours. `ROUTE_BYTES = MAX_PATH_LEN / 2` (one 4-bit direction per
 * step, two per byte) sizes the `carRoute` state region. Exceeding this walk
 * length is a defined refusal (`H_ROUTES_REFUSED`), not a crash — it also
 * bounds a hand-corrupted `dir`'s walk, which `dir` being a tree toward the
 * sources cannot otherwise cycle through.
 */
export const MAX_PATH_LEN = 96

// --- Demand (M1c decision 1, "Demand is destination-pull, and the rotation is state") ---
/**
 * Ticks per pin, per rotation slot, for the drift-free per-colour demand
 * accumulator (`packages/sim/src/demand.ts`: `acc[c] += slotCount(c); if
 * (acc[c] >= PIN_PERIOD_TICKS) { acc[c] -= PIN_PERIOD_TICKS; fire(c) }`).
 *
 * Derived through the week, never through `TICKS_PER_DAY` (deliberately 0,
 * see above — a stored per-day tick count drifts). The original's
 * `AverageCarsPerDay = 1.55` per building [MOD] x `DemandMultiplierForBuildings
 * = 0.8` [MOD] gives a baseline of 1.24 pins/day/square; over
 * `DAYS_PER_WEEK` (7) days that is 8.68 pins/week; `TICKS_PER_WEEK` (4500) /
 * 8.68 = 518.4 ticks per pin per slot, truncated down to the integer stored
 * here — 518, not 519, because the accumulator only fires once `acc`
 * reaches the threshold, so rounding up would UNDER-deliver relative to the
 * 1.24 baseline while rounding down over-delivers by a smaller margin.
 *
 * The exact realised rate this constant produces is 4500 / 518 =
 * 8.68726.../week = 1.24104.../day/square — not the source rule's rounded
 * "1.24" (`demand.test.ts` hand-computes an exact integer pin count against
 * this constant over a multi-period window rather than testing against the
 * rounded ratio).
 */
export const PIN_PERIOD_TICKS = 518

/**
 * Ticks after a destination's `destSpawnTick` before it joins the demand
 * rotation (`packages/sim/src/demand.ts`'s eligibility gate: `tick -
 * destSpawnTick[d] >= FIRST_PIN_DELAY_TICKS`). [MOD]
 * `DelayBeforeFirstPinOfDestination` = 4 seconds, converted here — the
 * conversion belongs in this file and nowhere else — at `TICKS_PER_SECOND`
 * (30): 4 * 30 = 120.
 */
export const FIRST_PIN_DELAY_TICKS = 4 * TICKS_PER_SECOND

// --- Movement (M1c decision 3, "Movement accumulates progress in the pathfinder's own cost units") ---
/**
 * Progress units per unit of pathfinder edge weight. A car's threshold to
 * leave the cell it is on is `edgeCost(dir) * COST_UNIT_SCALE`
 * (`packages/sim/src/cars.ts`), so traversal time is proportional to the
 * Dijkstra weight BY CONSTRUCTION — for `ORTHO_COST`/`DIAG_COST` today and
 * for every future edge cost, with no per-edge rounding rule anywhere.
 *
 * The alternative M1c rejected was a per-edge fractional offset, which prices
 * a diagonal at traversal ratio 1.00 while `edgeCost` charges 14/10: cars
 * would take routes the field calls optimal that are in fact slower, forever,
 * with every measurement downstream inheriting it.
 *
 * 250 is chosen with `CAR_SPEED_UNITS_PER_TICK` below, not separately — see
 * that constant for the two constraints that pin the pair.
 *
 * **Re-derive this WITH `NB`, `DISTINCT_EDGE_COSTS` and
 * `CAR_SPEED_UNITS_PER_TICK` when `edgeCost`'s value set changes** (M1d's
 * motorway tier, or any lane-speed term entering the cost). They are one
 * calibration, not four independent numbers.
 */
export const COST_UNIT_SCALE = 250

/**
 * A car's progress gain per tick at the default lane speed, in the same
 * `COST_UNIT_SCALE` units. `speedUnits(mul)` (`packages/sim/src/cars.ts`)
 * scales it by a lane-speed multiplier; M1c applies none, so the only live
 * call is the identity `speedUnits(LANE_SPEED_DEFAULT)`.
 *
 * Four constraints pin 330 against `COST_UNIT_SCALE` = 250:
 *
 *   1. **Diagonal ratio exact.** The two thresholds are 10 * 250 = 2500 and
 *      14 * 250 = 3500 — ratio 1.40, the same figure `edgeCost` charges.
 *   2. **Neither threshold is divisible by the speed.** 2500 = 7 * 330 + 190
 *      and 3500 = 10 * 330 + 200, so a car OVERSHOOTS each threshold and
 *      carries the excess onto its next cell: 330 - 190 = **140 units on an
 *      orthogonal** (about 0.42 of a tick) and 330 - 200 = **130 units on a
 *      diagonal** (about 0.39). Note the two quantities and keep them apart —
 *      the *remainders* are 190 and 200, the *carries* are 140 and 130, and
 *      only the carries are what movement holds.
 *
 *      This is load-bearing, not cosmetic: IF THE SPEED DIVIDED A THRESHOLD,
 *      THE CARRY WOULD ALWAYS BE ZERO ON THAT EDGE TYPE and the "drop the
 *      remainder at a crossing" bug — a systematic slowdown of a fraction of a
 *      tick per cell, the classic diverges-only-after-thousands-of-ticks
 *      failure — would be unobservable at every operating point. Under
 *      `COST_UNIT_SCALE` = 250 a speed of 350 would divide 3500 exactly ten
 *      times and make the diagonal carry identically zero. `constants.test.ts`
 *      asserts both remainders and both carries directly, so a future speed
 *      change cannot silently disarm every carry test in `cars.test.ts`.
 *   3. **Future multiplier rounding under 1%.** The smallest multiplier is
 *      `SHARP_TURN_SPEED_MUL` = 333, and 330 * 333 / 1000 truncates to 109
 *      units — an error bounded by 1 in 109. At a sub-cell-style base of 8-10
 *      units the same multiplier would be a 10-33% speed error, and a base
 *      below 4 would truncate to 0, stalling a car permanently. Working in
 *      cost units prices that whole failure class out.
 *   4. **Plausible speed.** 2500 / 330 is about 7.58 ticks per orthogonal
 *      cell, which at `TICKS_PER_SECOND` (30) is about 3.96 cells/second.
 */
export const CAR_SPEED_UNITS_PER_TICK = 330
