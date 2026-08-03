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
