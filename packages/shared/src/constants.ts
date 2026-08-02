/**
 * Every scaled quantity in the simulation is an integer numerator over this
 * denominator. A multiplier of 0.667 is 667. The conversion lives here and
 * nowhere else — sim code never sees a decimal.
 */
export const DENOM = 1000

// --- Clock (spec §5.10) ---
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

// --- Board and agents (spec §3, §5.1, §5.2, §5.7) ---
export const GRID_W = 24
export const GRID_H = 40
export const GROUP_COUNT_DEFAULT = 5
export const CARS_PER_HOUSE = 2
export const MOTORWAY_CAP = 9
