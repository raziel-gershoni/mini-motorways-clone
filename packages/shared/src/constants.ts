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
 * when none of the three does.
 *
 * **`ROUNDABOUT_SPEED_MUL` and `MOTORWAY_SPEED_MAX` are still uncalled, and the
 * date moves from M1f to M1g for two different reasons.** The motorway was never
 * in M1f's scope. The roundabout WAS, and it was removed after measurement: on the
 * shipped board, five of the six cells that actually jam admit ZERO legal 3x3
 * centres at every tick of the run, and the sixth admits one — the cell measured
 * as worth exactly zero. The greedy connector merges approaches at carparks and
 * houses, so degree-3 cells form against buildings by construction, and spec 5.6
 * requires a roundabout's centre plus all eight neighbours to be clear of them.
 * M1f ships a single-cell JUNCTION UPGRADE instead, which places on one junction cell and
 * therefore cannot fail to reach the jam. M1g owns the roundabout's geometry
 * question; see the M1f plan's Out table for the four options.
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

/**
 * The road degree at which a cell counts as an INTERSECTION — a third road
 * meets there. Degree 2 is a corridor cell, 1 a dead end, 0 bare ground.
 *
 * **Moved out of `sim/src/cars.ts` module scope at M1f Task 1, because it
 * acquired a second reader.** M1d used it in exactly one place, to select spec
 * §5.5's *"approaching an intersection"* speed multiplier. M1f gives the same
 * threshold two more jobs — `canEnter`'s mutual exclusion and the junction
 * upgrade's placement rule (§5.6: *"place only on an existing road junction,
 * never plain road"*) — and a private constant with three conceptual readers is a copy
 * waiting to happen. All three now go through `graph.ts`'s `isJunctionCell`.
 *
 * **It is NOT an edge weight and must never become one** — see the 2026-08-21
 * amendment to spec §5.4. `flowfield.test.ts` scans `flowfield.ts` for this
 * name for exactly that reason, with `graph.ts` as its positive control.
 */
export const INTERSECTION_DEGREE = 3

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
 * ---------------------------------------------------------------------------
 * **M1f TASK 2 FALSIFIED TWO SENTENCES THAT STOOD HERE, AND BOTH ARE CORRECTED
 * RATHER THAN DELETED, BECAUSE THE REASONING THAT PRODUCED THEM IS STILL WORTH
 * READING.**
 * ---------------------------------------------------------------------------
 *
 * **The first said head-on is structurally impossible, so no 2-cycle can
 * deadlock and the valve is the answer only to a cycle of length >= 3.** It read:
 *
 * > Under M1d's two lanes the valve's job is narrower than it looks. Head-on is
 * > structurally impossible (`LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]`), so
 * > no 2-cycle can deadlock and the valve is not the answer to opposing traffic.
 *
 * That was true while `canEnter` asked about one lane. Under M1f Task 2's wide
 * junction rule two cars swapping across an edge whose endpoints are BOTH
 * junctions each required the other's cell to be empty while each was standing
 * in it: a 2-cycle, cleared only by this constant.
 *
 * **M1f Task 3 narrowed the rule to CROSSING axes and gave half of that back.**
 * A junction now consults the other lane only when its occupant entered on a
 * crossing axis, so the STRAIGHT swap resolves in one tick again — the two cars
 * are opposed, which is the same axis — and only a swap whose occupant TURNED
 * into the cell still deadlocks. Measured on the shipped board's greedy arm the
 * valve therefore fires **5** times where the wide rule fired 15 and the
 * one-lane rule could not fire at all. The lane property itself is unchanged and
 * still true; what changed is what it implies at a junction.
 * `blocking.test.ts`'s *"the STRAIGHT 2-cycle Task 2 created resolves again, and
 * the TURNING one does not"* holds both halves on one fixture, and M1f Task 9's
 * junction upgrade is the relief for the rest: an upgraded cell falls back to
 * the own-lane rule and the property returns there, whole, with no phase.
 *
 * The rest of the paragraph survives: 1,350 ticks is 30 % of a 4,500-tick week —
 * an acceptable price for a genuine circular wait, and an absurd one for the
 * commonest event in the game, which is why the lane rule still comes first at
 * every cell that is not a junction.
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
 * **The second said lowering this constant is a change no shipped board can
 * observe and raising it is free.** Also true then, false now. Both directions
 * are observable on the board that ships as of M1f Task 2, and the first real
 * tuning evidence exists.
 *
 * ---------------------------------------------------------------------------
 * THE EVIDENCE TABLE, RE-MEASURED AT M1f TASK 2 AND AGAIN AT M1f TASK 3
 * ---------------------------------------------------------------------------
 *
 * **Two of the three rows moved and the conclusion is false.** Every figure is
 * a measurement on the arm named in its row; the entry-refusal column is
 * `canEnter` refusals and is NOT `H_ROUTES_REFUSED`, which is 0 everywhere and
 * measures the route WALK rather than the road (see `blocking.ts`). **Every row
 * counts from BOOT, warm start included** — which is this table's convention and
 * not the one `blocking.ts`'s and `integration.test.ts`'s tables use, and on the
 * demo board the two differ by 868-1,887 refusals depending on the rule. Two
 * quantities under one column heading is this table's own recorded defect, so
 * the window is named rather than left to be inferred.
 *
 * Struck through, as of M1e Task 12 — correct for the tree before M1f Task 2 and
 * kept because they are the control both later tasks are measured against:
 *
 * ```
 *   ~~city         5,580 ticks       0 refusals   max     0   0 valve firings~~
 *   ~~demo         6,703 ticks   7,544 refusals   max    55   0 valve firings~~
 *   ~~city, greedy 31,456 ticks  2,120 refusals   max    32   0 valve firings~~
 * ```
 *
 * Also struck through, as of M1f Task 3 — the WIDE junction rule Task 2 landed
 * and Task 3's triage replaced, kept because it is the other arm the triage
 * chose between and the choice is illegible with one column:
 *
 * ```
 *   ~~city         5,580 ticks       0 refusals   max     0    0 valve firings~~
 *   ~~demo         5,757 ticks  99,025 refusals   max 1,350   22 valve firings~~
 *   ~~city, greedy 21,704 ticks 45,986 refusals   max 1,350   15 valve firings~~
 * ```
 *
 * **That demo row read `99,017` from Task 2 until Task 3 re-measured it, and
 * the correct figure is 99,025.** Two instruments on the same tree agree — the
 * triage rig (`game/test/junctionArms.ts`) and `demoLayout.test.ts`'s own
 * `Measured` counter, which is the instrument Task 2 used elsewhere — and the
 * other three columns of that row reproduce exactly. Eight refusals in 99,025 is
 * 0.008 % and changes nothing; it is corrected because a figure nothing runs is
 * a figure that comes back, and this one had already been quoted onward.
 *
 * Current, measured at M1f Task 3 under the CROSSING-ONLY rule that ships:
 *
 * ```
 *   city          5,580 ticks       0 refusals   max     0    0 valve firings
 *   demo          6,660 ticks  13,827 refusals   max    60    0 valve firings
 *   city, greedy 21,783 ticks  29,267 refusals   max 1,350    5 valve firings
 * ```
 *
 * **The instrument reproduced the rows it was about to replace before it was
 * trusted**, which is the rule this project keeps relearning: run against a tree
 * with the junction clause reverted, the same probe returns
 * `demo 6,703 / 7,544 / 55 / 0` and `city, greedy 31,456 / 2,120 / 32 / 0` —
 * every figure in the first struck-through table, to the digit — and run against
 * the wide clause it returns the second table with the one correction noted
 * above.
 *
 * **The refusal counts INCLUDE the death tick.** The probe samples the tick the
 * run ends on; `integration.test.ts`'s per-week `blockedTicks` row does not,
 * because its driver breaks on `isGameOver` first. On the greedy arm that is
 * 45,986 against 45,976 — the ten cars blocked as the run ends — and on the
 * pre-M1f control it is 2,120 either way, because nothing was blocked there.
 *
 * **Both refusal conventions agree on this board and that is worth recording**:
 * counting a RISE in `carBlockedTicks` and counting car-ticks with the counter
 * above zero give the same number, because a refused car holds its progress and
 * re-attempts on the very next tick, so the counter rises on every blocked tick
 * until it saturates — and the tick after saturation is a valve crossing, which
 * resets it. The two only come apart if a car can be blocked without attempting,
 * which `advanceCar` does not permit.
 *
 * **`city` with no input is unmoved by BOTH M1f rules and that is derived, not
 * lucky** — a board nobody draws on has no route, so no car ever moves and no
 * junction is ever contended. A narrowing cannot change it either, because it
 * refuses a subset of what the wide rule refused. `deathTicks.ts` carries the
 * derivation.
 *
 * **Only ONE of the other two still saturates the counter, and which one moved
 * is the shape of Task 3's narrowing.** `city, greedy` is the load-bearing row:
 * 21,783 ticks of competent play, 368 trips completed, and the worst wait is
 * still the threshold itself where it used to be 32 ticks — a factor of 42
 * below. The demo board came back down from a saturated 1,350 to **60**, and
 * from 22 valve firings to **0**: on that board every 2-cycle the wide rule
 * created was a straight swap, and the narrowed rule resolves all of them.
 * `integration.test.ts` asserts the city row's death tick, trip count,
 * saturated maximum and 5 firings; `demoLayout.test.ts` asserts the demo
 * board's 3,000-tick window (5,463 refusals and 0 firings inside it, against
 * 3,235 and 0 before M1f and 39,795 and 7 under the wide rule).
 *
 * **So the valve is no longer demo-only, and this is the first firing on the
 * board that ships outside a purpose-built fixture** (`game/test/jamFixture.ts`'s
 * STARVED variant: 17 firings over 3,000 ticks at twelve houses, 2 at eight;
 * `sim/test/blocking.test.ts`'s hand-built gridlock ring, and its new
 * *"breaks the 2-cycle"* case). Lowering this constant now changes the shipped
 * board and raising it now changes how long a jam holds; neither is free.
 *
 * **A THIRD READER WAS PREDICTED AT M1f TASK 9 AND DOES NOT EXIST, and the
 * reason is worth keeping.** The prediction was that a demand-actuated traffic
 * light needing 2 cars on an approach before swapping (dossier §1.7's
 * `minimumNearbyCarsBeforeSwapping`) would starve a lone car on a quiet approach,
 * and that this constant would be its only release. M1f measured that light and
 * rejected it: on a board carrying about a dozen cars in flight the threshold is
 * essentially never met, so the light did not meter — it latched, and this
 * constant became its only release for the whole run rather than an occasional
 * one. **M1f ships a JUNCTION UPGRADE instead** — a per-cell flag that lifts the
 * mutual exclusion at its cell and changes nothing else, including the
 * intersection slowdown — which admits cars rather than refusing them and
 * therefore *reduces* the pressure on this valve. The reader count stays at two.
 * See the M1f plan's Amendment 2 and Decision 14, and
 * `docs/superpowers/m1g-carry-forward.md`. **A traffic light is deferred to
 * M1g**; any artefact saying M1f's `canEnter` obeys one is wrong.
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

// --- Overcrowd, in MILLI-TICKS (spec §5.8, M1e Task 7) ---
/**
 * A tick is 1000/30 ms, which is not an integer, so a millisecond-denominated
 * meter cannot be exact. The meter is denominated in ticks x `DENOM` —
 * milli-ticks — and every §5.8 constant converts once, here.
 *
 * **EXACTLY ONE of research dossier §1.10's constants is genuinely absent from
 * this file, and it is `OvercrowdTimerCarArrivalDeceleration` = 0.5.** The
 * plan describes §5.8 as a "five-of-eight transcription", and an earlier
 * version of this comment repeated that as "the three that fell out" — but
 * that is a row-count artefact of how the dossier's table is laid out, not
 * three missing behaviours. Counted as behaviours, one is missing and it is
 * this one. Plan Decision 4 names it, measures what it would do (it widens the
 * survivable arrival interval from 90 ticks to 300, a 3.33x change), and hands
 * it to M1f with the reason. Do not add it here without reading that.
 */
export const OVERCROWD_FULL_MILLITICKS =
  (MAX_OVERCROWD_TIME_MS / MS_PER_SECOND) * TICKS_PER_SECOND * DENOM
export const OVERCROWD_GRACE_MILLITICKS =
  (OVERCROWD_GRACE_MS / MS_PER_SECOND) * TICKS_PER_SECOND * DENOM
/**
 * The meter value that ends the run: 90 s minus §5.8's 2 s "hidden grace at the
 * end", so 88 s = 2,640,000 milli-ticks. The RING is drawn against
 * `OVERCROWD_FULL_MILLITICKS`, which is what makes the grace hidden — it reads
 * 97.8 % at the instant the city dies.
 *
 * **Nothing ends a run at M1e Task 7.** `runOvercrowd` integrates the meter and
 * this constant is the threshold `overcrowd.test.ts` measures against; Task 8
 * is what makes reaching it fatal.
 */
export const OVERCROWD_FAIL_MILLITICKS = OVERCROWD_FULL_MILLITICKS - OVERCROWD_GRACE_MILLITICKS
/**
 * Where §5.8's `s(t) = min(1, 0.02t)` reaches full: `1 / 0.02` = 50 s = 1,500
 * ticks. `destOverTicks` SATURATES here rather than growing without bound, so
 * no width question can arise at any run length — the construction
 * `carBlockedTicks` already uses against `MAX_BLOCKED_TICKS`. The saturation
 * ceiling and the ramp's full point are deliberately the SAME number: a ceiling
 * below it makes the ramp unreachable, one above it is bytes nothing reads.
 */
export const OVERCROWD_RAMP_FULL_TICKS = (DENOM / OVERCROWD_RAMP) * TICKS_PER_SECOND
export const ARRIVAL_KNOCKBACK_MAX_MILLITICKS =
  (ARRIVAL_KNOCKBACK_MAX_MS / MS_PER_SECOND) * TICKS_PER_SECOND * DENOM

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
 * **Frozen constants, and M1f owns making them dynamic — repointed from M1d at
 * the close of M1d and from M1e at the close of M1e, and BOTH declined the
 * work.** Expansion (§5.1) is a per-map, per-week schedule that still does not
 * exist: `MapData` carries `w` and `h` only, and every "reveal" mention in
 * `packages/` is still a comment deferring it. M1d's Out table declines it by
 * name, for two stated reasons — no M1d task needed it, and a revealed region
 * in state would have been a THIRD change to buffer shape in a milestone that
 * budgeted exactly two. M1e declined it for the first reason alone: its buffer
 * budget was one shape change (Task 1) and no task needed a growing rect. When
 * it lands, the camera reads state instead of these four numbers and nothing
 * else moves — `render/camera.ts` already takes the rect as a parameter
 * (`RevealedRect`) rather than importing it, because `render` imports nothing
 * from `shared` (spec §4).
 *
 * **`sim` DOES read these, and this block used to say it did not.** `spawn.ts`
 * (M1e Task 5) scans `REVEALED_X0`/`Y0`/`W`/`H` to decide where a house or a
 * destination may be placed — that is the shared spawn zone `world.ts`'s
 * `mapIdHash` note refers to. So the handoff is no longer "the camera reads
 * state instead of four constants"; it is "the camera AND the spawner read
 * state instead of four constants", and a dynamic rect that only the camera
 * honours would let the spawner place buildings the player cannot see.
 *
 * **These were drawn from and not simulated on until M1e Task 5, and that
 * sentence has now moved.** The sim's board is still the full `GRID_W ×
 * GRID_H`, and a building or road outside the rect is still legal state that is
 * simply not visible — but `sim/src/spawn.ts` READS all four, because nothing
 * may spawn where the player cannot see it and this rect is the only
 * description of what is visible. That file is the ONLY reader in `sim`, and it
 * clips the rect to the board before using it (a 4x4 fixture map misses the
 * rect entirely). M2's hand-authored starting city
 * (`game/startingCity.ts`) is placed entirely inside the rect for the same
 * visibility reason.
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

// --- The weekly demand ramp (spec §5.3, [OURS]) ---
/**
 * `spawnScale(w) = 1.0 + 0.11 * (w - 1)`, capped at 3.0, at `DENOM`. Spec §5.3
 * calls this "the single most important tuning unknown in the project"; §13
 * lists it as an open risk and names the telemetry overlay as its mitigation.
 * Treat all three numbers as a starting point.
 *
 * **What this ramp does and does not do — see plan Decision 2.** It does not
 * raise the number of pins a destination can hold, and it does not add cars.
 * It shortens the interval between pins at one rotation slot from 518 ticks to
 * 172, so the round-trip time a connected destination can survive falls by the
 * same factor. That is the difficulty curve and it is measurable as a ratio;
 * Task 10's gate measures it. Reading this constant as "demand triples" without
 * the fleet term is how the first draft of this plan came to claim a difficulty
 * curve it could not observe.
 *
 * **What a player can ATTRIBUTE to it in M1e: nothing. That is a claim about
 * attribution, not about observability, and the two are not the same.** Task
 * 5's spawner grows `slotCount` on the same board at the same time, so a player
 * — who cannot toggle the ramp — sees one board getting busier and has no way
 * to apportion it between the two causes.
 *
 * **A ramp-on/ramp-off contrast IS an observation and it separates them by a
 * lot.** Measured on the shipped `demoCity` seeded rig, 20,000 ticks, no input,
 * with `pinPeriodForWeek` neutralised to the bare `PIN_PERIOD_TICKS` as the
 * control:
 *
 *   trips                     1,464 on / 1,330 off   (1.10x)
 *   peak standing `destPins`    189 on /    52 off   (**3.63x**)
 *
 * So the shipped board is emphatically NOT ramp-insensitive, and an earlier
 * version of this paragraph said "no observation separates them" with
 * "measured" attached — a sentence made more specific in the wrong direction,
 * and scoped to the shipped board on the strength of a measurement taken on a
 * purpose-built 20x9 corridor. **Anything sizing a survivability or
 * throughput gate must run past week 0**; scoping it to a week-0 window on the
 * belief that this board is ramp-insensitive is wrong by 3.6x on backlog.
 *
 * The ramp's own effect, isolated from the spawner rather than merely
 * contrasted, is in `loop.test.ts`'s treatment/control arm — one 20x9 board
 * where the spawner is STRUCTURALLY absent, one fleet, one road network, and
 * `H_WEEK` as the only difference between the arms. That is where the
 * difficulty curve is quantified per week; the two figures above are the
 * shipped board and nothing else. Do not quote either without its board.
 */
export const SPAWN_SCALE_BASE = 1000
export const SPAWN_SCALE_PER_WEEK = 110
export const SPAWN_SCALE_MAX = 3000

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

/** §5.9's "20 s retry on a failed destination", converted here and nowhere else. */
export const DEST_SPAWN_RETRY_TICKS = 20 * TICKS_PER_SECOND
/** §5.9's "2 s cooldown on a failed house spawn". */
export const HOUSE_SPAWN_RETRY_TICKS = 2 * TICKS_PER_SECOND
/**
 * How many houses a colour may hold per same-colour destination [OURS]. House
 * growth follows destination growth rather than the clock: without this,
 * `firstCity`'s `maxHouses` of 40 fills in about 80 seconds at one attempt per
 * colour per `HOUSE_SPAWN_PERIOD_TICKS`.
 *
 * **This constant times `CARS_PER_HOUSE` is the fleet-per-destination ratio,
 * and plan Decision 2 shows it is the term that decides whether the demand ramp
 * can ever bite.** At 2 it is four cars per destination at every week, so the
 * fleet grows exactly in step with demand and only the round trip can close the
 * gap. Task 10's gate measures that ratio; do not change this number without
 * re-running it.
 */
export const HOUSES_PER_DESTINATION = 2
/** §5.9's "future houses of a neighbourhood spawn within ~2 tiles of an existing same-colour house". */
export const HOUSE_NEIGHBOURHOOD_RADIUS = 2
/**
 * Cells examined per spawn attempt [OURS]. Unbounded scanning is up to 308
 * cells x 4 orientations x `canPlaceDestination` inside one tick, which is a
 * frame-dropping spike on a phone however cheap the predicate is.
 *
 * **Note what bounding it does NOT do.** The first draft claimed it "makes
 * §5.3.5's blocked-spawn redistribution reachable rather than theoretical". It
 * does the opposite of what §5.3.5 asks: a bounded window missing is not "no
 * cell will take one anywhere", and pushing on it fires the redistribution at
 * the retry cadence rather than the schedule's. `SpawnOutcome` separates the
 * two and only the board-wide refusal pushes.
 */
export const SPAWN_CANDIDATE_LIMIT = 24

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

/**
 * Spec §5.10's Road Tiles card: the per-map constant "30 or 40" — 30 here, the
 * same value `WEEKLY_TILE_GRANT` uses, and deliberately a SEPARATE constant
 * because they are two different rules that happen to agree today. One is a
 * weekly income (`runWeekBoundary`, phase 2); this is a card's one-off bonus
 * (`applyChooseCard`, phase 3). Defining either in terms of the other would make
 * a map that grants 40 silently change the other rule too, and
 * `constants.test.ts` reads this declaration off disk to keep them apart.
 */
export const CARD_GRANT_ROAD_TILES = 30
/**
 * Spec §5.10's tile bonus on every ITEM card except the motorway, which grants
 * 10. **The motorway's number is not declared**, because the motorway is not
 * offerable in M1f (`CARD_IMPLEMENTED_MASK`) and an untested value reads as a
 * supported configuration — `cardTileGrant` throws for it instead. M1g declares
 * it with the card.
 *
 * **This is a bonus ON TOP of `WEEKLY_TILE_GRANT`, not a replacement**, and that
 * is a balance change stated rather than hidden: tile income goes from 30 a week
 * to 50 or 60, against a measured 3.4x slack — 62 tiles spent of 210 granted on
 * the arm that ships, with a WEEK-CLOSE minimum of 37. **Quote the week-close
 * qualifier or do not quote the 37**: `integration.test.ts` takes the minimum
 * over per-week-close samples, and the true running minimum is **7, at tick
 * 2,280**, in week 0 before the first grant.
 *
 * The alternative — deleting the automatic grant so the card is the only income
 * — is what §5.10 literally describes, and it is the only version in which the
 * modal's 30-vs-20 costs the player anything. It was refused for two reasons: it
 * makes two goldens' `H_TILES` a function of the input log, and `runWeekBoundary`
 * has no other body, so deleting the grant deletes a phase and forces a second
 * renumbering in a milestone that has already paid for one. **M1f Task 12
 * measures the new slack and hands the lever to M1g with the number** — and notes
 * that M1f has already paid its expensive half, because every FRAME-DRIVEN
 * headless rig acquires a card policy at Task 7. (Not *every* headless rig: the
 * `step`-driven ones take no card and must not, because `sim` has no notion of
 * pause and one of them is the only allocation instrument covering `cards.ts`.)
 *
 * **And Task 7 measured what the bonus does to the slack, which is the number
 * this lever is for.** On the greedy arm that ships — five weeks, death at
 * 21,783 — the tile ledger is granted 30 at boot plus 4 x 30 weekly = **150**
 * and ends holding 94, i.e. **56 spent, 2.7x slack**. With the card policy the
 * same arm is granted 150 + 90 = **240** for the same 56 spent, i.e. **4.3x**,
 * and not one road it lays moves: `armGreedyActions` reads the budget in exactly
 * one place and `unaffordable` is 0 across the whole run. So the modal's 30-vs-20
 * choice costs the player nothing on the board that ships today, which is the
 * strongest available argument for the lever above.
 */
export const CARD_GRANT_ITEM = 20
/**
 * Spec §5.10's grant row for the item card: **two per card, for 20 tiles.** The
 * row is headed "Traffic Lights" in §5.10 — Tunnel, Roundabout and Motorway
 * grant 1, so 2 is that ROW and not the table's rate; M1f ships a JUNCTION
 * UPGRADE in that slot and honours the grant unchanged (see the 2026-08-21
 * amendment to §5.6 and the M1f plan's Decision 14 for the measurement that made
 * the substitution).
 *
 * A named constant rather than a literal inside `cardItemGrant` because the
 * modal draws it (`RenderFrame.offerItemsA`/`offerItemsB`) and a literal in
 * `canvas.ts` is how a UI ends up lying about a rule — failure mode I6 of the
 * M1f review. `MAX_UPGRADES` below is derived from it as well.
 */
export const UPGRADES_PER_CARD = 2

/**
 * How many junction upgrades one run may place on the board.
 *
 * **Derived, not chosen.** The rate is **2 per card**, and that figure is one
 * ROW of spec §5.10's table rather than a property of the table: Traffic Lights
 * grants "2 items for 20 tiles" where Tunnel, Roundabout and Motorway grant 1
 * and Bridge grants 1 or 2. `CARD_JUNCTION_UPGRADE` is M1f's substitution for
 * the light and inherits that row, so 2 per card is right here and would be
 * wrong quoted as a general grant rate. The card is offered once per week.
 *
 * The longest death tick across the eight measured `RUN_SEED` values is 51,275
 * (M1f plan, "A single-seed claim smaller than 2x is inside the noise"), which
 * is 11 whole weeks at `TICKS_PER_WEEK` = 4,500 — so no run this project has
 * measured can be granted more than 22. 24 is that bound plus one card's worth
 * of slack. `applyPlaceUpgrade` refuses with `'capacity'` at the cap
 * rather than dropping silently, and M1f Task 12 asserts
 * `2 * maxBoundaries <= MAX_UPGRADES` on the eight-seed sweep so the derivation
 * cannot rot.
 *
 * **It sizes NOTHING, and that is new at M1f Amendment 2.** The earlier design
 * was a metered traffic light with a five-column prefix-packed table of this many
 * rows, and `lightAt` held `slot + 1` — so this constant bounded a region and
 * `MAX_LIGHTS < 255` was a real width constraint. An upgrade is one bit per cell:
 * `upgradeAt` holds 0 or 1, there is no table, and this is a **pure placement
 * cap**. The `< 255` assertion is deleted with the index it guarded, and
 * `constants.test.ts` therefore asserts the VALUE and no tier.
 *
 * **And on the board that ships it is 3x larger than anything reachable.** The
 * arm that ships dies at tick **21,783** (`MAX_BLOCKED_TICKS`'s table above), so
 * only **four** week boundaries occur before death — 4,500 / 9,000 / 13,500 /
 * 18,000 — and at most **8** upgrades can ever be granted. The 51,275 derivation
 * above is a property of the eight-seed sweep, not of the shipped arm, and the
 * two must not be conflated: the cap is kept because it is cheap and because M1g
 * may lengthen runs again, but **no task may cite it as a binding constraint.**
 *
 * **A global constant rather than a per-map layout size**, because it is a
 * property of §5.10's grant rate and the week clock and not of the board. A
 * `maxUpgrades` field on `MapData` would fold into `mapIdHash` and move every
 * whole-buffer golden a second time.
 */
export const MAX_UPGRADES = 24

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
 * `CAR_SPEED_UNITS_PER_TICK` when `edgeCost`'s value set changes** (**M1f's**
 * motorway tier, or any lane-speed term entering the cost). They are one
 * calibration, not four independent numbers.
 *
 * **M1d Task 7 was the first thing to test that sentence, and it did not fire.**
 * Lane-speed multipliers now have a live caller, and they scale movement's
 * per-tick progress rather than entering `edgeCost` — so the value set is still
 * `{10, 14}`, all four numbers stand, and the field golden does not move.
 * `graph.test.ts` pins the value set as the tripwire for the other answer.
 *
 * **M1e did not fire it either, and the milestone name is repointed rather than
 * ticked**: motorways are an item card, and M1e shipped §5.10's tile grant
 * without the card modal. `scratch.ts`'s `NB` note carries the full derivation
 * of what a new cost tier has to re-check.
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
