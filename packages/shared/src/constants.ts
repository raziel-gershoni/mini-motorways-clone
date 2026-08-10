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

/** Milliseconds per second. Named so a `/ 1000` that means "ms to s" cannot be misread as DENOM. */
export const MS_PER_SECOND = 1000

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
/**
 * **Three of these six got their first caller in M1d Task 7**, and which three
 * is worth knowing here rather than only at the call site.
 * `RIGHT_ANGLE_SPEED_MUL`, `SHARP_TURN_SPEED_MUL` and `INTERSECTION_SPEED_MUL`
 * are selected per crossing by `laneSpeedMul` (`packages/sim/src/cars.ts`) and
 * scale a car's per-tick progress; `LANE_SPEED_DEFAULT` is the identity, applied
 * when none of the three does. `MOTORWAY_SPEED_MAX` and `ROUNDABOUT_SPEED_MUL`
 * are still uncalled — both are M1e upgrade cards, and there is no card
 * mechanism yet.
 *
 * **They are applied in MOVEMENT and never in `edgeCost`.** A turn multiplier is
 * a property of the pair of edges either side of a cell and cannot be expressed
 * as a cost on one edge; and a lane-speed term inside `edgeCost` would change
 * the value set that `COST_UNIT_SCALE`, `CAR_SPEED_UNITS_PER_TICK`, `NB` and
 * `DISTINCT_EDGE_COSTS` are jointly calibrated against. The consequence, which
 * is real and deliberate: the flow field prices LENGTH, so a route it calls
 * optimal may not be the fastest one. `cars.ts`'s module comment derives it.
 *
 * **Two of the three are averaged where both apply, and the averaging is the
 * only place a value not in this list can appear**: (667 + 500) / 2 = 583 and
 * (333 + 500) / 2 = 416, both truncated from a half-integer. That rounding
 * direction is invisible after `speedUnits` at these six numbers and at
 * `CAR_SPEED_UNITS_PER_TICK` = 330 — 583 and 584 both give 192, 416 and 417 both
 * give 137 — and `cars.test.ts` pins the equivalence so that changing any of
 * them turns the choice back into a real one.
 */
export const LANE_SPEED_DEFAULT = 1000
export const MOTORWAY_SPEED_MAX = 3000
export const ROUNDABOUT_SPEED_MUL = 2000
export const RIGHT_ANGLE_SPEED_MUL = 667
export const INTERSECTION_SPEED_MUL = 500
export const SHARP_TURN_SPEED_MUL = 333

// --- Blocking and the anti-deadlock valve (spec §5.5, M1d decision 6) ---
/**
 * How long a car may be refused entry to the next cell before it proceeds
 * anyway — spec §5.5's *"max wait at an intersection before proceeding anyway
 * is 45 s"*, at `TICKS_PER_SECOND` (30): 45 * 30 = 1,350 ticks.
 *
 * **Derived, never written as the literal 1,350.** The conversion from the
 * spec's seconds belongs in this file and nowhere else, and writing the product
 * out would let the clock change under it silently — the same rule
 * `FIRST_PIN_DELAY_TICKS` above already follows.
 *
 * **This is a game mechanic, not a safety hack.** A gridlocked city GRINDS
 * rather than stops, which is what makes the failure legible and recoverable.
 * It also guarantees no car is ever stuck forever, which matters because a
 * permanently frozen car holds an occupancy claim and a destination
 * reservation, and would starve that destination for the rest of the run.
 *
 * **Under M1d's two lanes the valve's job is narrower than it looks.** Head-on
 * is structurally impossible (`LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]`,
 * `packages/sim/src/roads.ts`), so no 2-cycle can deadlock and the valve is not
 * the answer to opposing traffic. It is the answer to a **cycle of length >= 3**
 * in which every car is same-lane-blocked by the next. 1,350 ticks is 30 % of a
 * 4,500-tick week — an acceptable price for a genuine circular wait, and an
 * absurd one for the commonest event in the game, which is why the lane rule
 * has to come first.
 *
 * **Two width facts this number carries, both load-bearing:**
 *
 *   1. **1,350 > 255**, so the `carBlockedTicks` counter cannot be a `Uint8`:
 *      the threshold would be unreachable and the valve would simply never
 *      fire. It is `Int16` (`packages/sim/src/regions.ts`).
 *   2. **The counter SATURATES at exactly this value** rather than growing
 *      without bound (`noteEntryRefused`, `packages/sim/src/blocking.ts`), so
 *      no overflow question can arise at any run length. The saturation ceiling
 *      and the firing threshold are deliberately the SAME constant: a ceiling
 *      below the threshold makes the valve unreachable, and a ceiling above it
 *      is bytes nothing reads.
 *
 * Whether 45 s is the right wait is unvalidated in play — it is the spec's
 * number, and under two lanes it fires far less often than it would have under
 * one undirected slot per cell. M1e's tuning is the first real evidence.
 */
export const MAX_BLOCKED_TICKS = 45 * TICKS_PER_SECOND

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

// --- The revealed rect (spec §3 decision 4, M2 plan Decision 5) ---
/**
 * The rectangle of the board that is revealed, and therefore drawn, at the
 * start of a run: `x ∈ [5, 19)`, `y ∈ [9, 31)` — spec §3 decision row 4,
 * *"portrait-native, ~24×40 grid revealed from 14×22"*, centred in the 24×40
 * board (`(24 - 14) / 2 = 5`, `(40 - 22) / 2 = 9`).
 *
 * **Frozen constants, and M1e owns making them dynamic — repointed from M1d at
 * the close of M1d, which DECLINED the work.** Expansion (§5.1) is a per-map,
 * per-week schedule that still does not exist: `MapData` carries `w` and `h`
 * only, and every "reveal" mention in `packages/` is still a comment deferring
 * it. M1d's Out table declines it by name, for two stated reasons — no M1d task
 * needed it, and a revealed region in state would have been a THIRD change to
 * buffer shape in a milestone that budgeted exactly two. When M1e lands it, the
 * camera reads state instead of these four numbers and nothing else moves —
 * `render/camera.ts` already takes the rect as a parameter (`RevealedRect`)
 * rather than importing it, because `render` imports nothing from `shared`
 * (spec §4).
 *
 * **These are drawn from, not simulated on.** The sim's board is the full
 * `GRID_W × GRID_H`; nothing in `sim` reads these, and a building or road
 * outside the rect is legal state that is simply not visible. M2's
 * hand-authored starting city (`game/startingCity.ts`) is placed entirely
 * inside it for that reason.
 *
 * Why the rect and not the full grid: fitting 24×40 into the measured M0
 * viewport gives `floor(min(406/24, 870/40))` = **16 CSS px** against spec
 * §5.1's hard floor of 28, and 40 rows at 28 px needs 1,120 CSS px of height
 * that no phone has. The revealed rect gives 29 CSS px on that device.
 */
export const REVEALED_X0 = 5
export const REVEALED_Y0 = 9
export const REVEALED_W = 14
export const REVEALED_H = 22

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

// --- Spawning (spec §5.9; the RATE is [OURS], the intervals are [MOD]) ---
/**
 * §5.9 gives geometry and MINIMUM intervals but no rate, so the rate is
 * authored here. **This is a SCHEDULE, not a delivery rate** — measured on
 * `firstCity` with no player input, the schedule delivers well under two a
 * week because most attempts are refused by the Chebyshev-2 spacing rule; the
 * M1e plan's "What this plan does not settle" records the measured figure and
 * the ceiling. Do not read this constant as "the board gains two destinations
 * a week".
 *
 * **Declared in M1e Task 1 with the buffer shape and consumed by Task 5.**
 * Nothing reads it yet beyond `DEST_SPAWN_PERIOD_TICKS` below, which
 * `createState` uses to arm `H_DEST_SPAWN_TIMER`.
 */
export const DESTINATIONS_PER_WEEK = 2
export const DEST_SPAWN_PERIOD_TICKS = TICKS_PER_WEEK / DESTINATIONS_PER_WEEK
/** §5.9's "10 s between same-group house spawns", converted here and nowhere else. */
export const HOUSE_SPAWN_PERIOD_TICKS = 10 * TICKS_PER_SECOND

// --- The weekly grant (spec §5.10) ---
/**
 * Spec §5.10's Road Tiles card, per-map constant "30 or 40" — 30 here.
 *
 * **This is the load-bearing half of §5.10 and M1e ships only this half.** The
 * other half is the two-card CHOICE, and every card in the table but this one
 * grants an ITEM — bridge, tunnel, roundabout, traffic lights, motorway — none
 * of which has a placement mechanism yet. A pool with one offerable entry is a
 * menu with one item, so the modal is M1f's, along with the first item that
 * makes it a choice. What §5.10 says about THIS number is honoured exactly:
 * "Tile income is flat, not week-indexed — difficulty ramps on the demand side
 * only." It is not multiplied by the week and it must not become so.
 *
 * **Known and recorded rather than tuned here:** 30 starting plus 30 a week is
 * ~270 tiles by week 8 against roughly 280 placeable cells in the 308-cell
 * revealed rect, so tiles stop being the binding constraint somewhere around
 * week 3. Task 10's greedy-connect arm measures where, and the plan's "What
 * this plan does not settle" carries it.
 */
export const WEEKLY_TILE_GRANT = 30

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
 * `CAR_SPEED_UNITS_PER_TICK` when `edgeCost`'s value set changes** (M1e's
 * motorway tier, or any lane-speed term entering the cost). They are one
 * calibration, not four independent numbers.
 *
 * **M1d Task 7 was the first thing to test that sentence, and it did not fire.**
 * Lane-speed multipliers now have a live caller, and they scale movement's
 * per-tick progress rather than entering `edgeCost` — so the value set is still
 * `{10, 14}`, all four numbers stand, and the field golden does not move.
 * `graph.test.ts` pins the value set as the tripwire for the other answer.
 */
export const COST_UNIT_SCALE = 250

/**
 * A car's progress gain per tick at the default lane speed, in the same
 * `COST_UNIT_SCALE` units. `speedUnits(mul)` (`packages/sim/src/cars.ts`)
 * scales it by a lane-speed multiplier.
 *
 * **M1c applied none and M1d Task 7 applies three**, so this is no longer the
 * speed every car moves at — it is the speed a car moves at when no turn and no
 * junction applies. The six values movement can produce are 109, 137, 165, 192,
 * 220 and 330, and constraint 3 below is the one that made 330 the right base
 * for them.
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
 *   3. **Multiplier rounding under 1% — live as of M1d Task 7, not future.**
 *      The smallest multiplier is
 *      `SHARP_TURN_SPEED_MUL` = 333, and 330 * 333 / 1000 truncates to 109
 *      units — an error bounded by 1 in 109. At a sub-cell-style base of 8-10
 *      units the same multiplier would be a 10-33% speed error, and a base
 *      below 4 would truncate to 0, stalling a car permanently. Working in
 *      cost units prices that whole failure class out.
 *   4. **Plausible speed.** 2500 / 330 is about 7.58 ticks per orthogonal
 *      cell, which at `TICKS_PER_SECOND` (30) is about 3.96 cells/second.
 */
export const CAR_SPEED_UNITS_PER_TICK = 330
