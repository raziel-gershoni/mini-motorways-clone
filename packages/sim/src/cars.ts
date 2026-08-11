import {
  CAR_SPEED_UNITS_PER_TICK,
  COST_UNIT_SCALE,
  DENOM,
  INTERSECTION_SPEED_MUL,
  LANE_SPEED_DEFAULT,
  ORTHO_COST,
  RIGHT_ANGLE_SPEED_MUL,
  SHARP_TURN_SPEED_MUL,
} from '@laneways/shared'
import type { GameState } from './state'
import type { WorldData } from './world'
import { DIR_COUNT, OPPOSITE, noteGhostDeparture, stepCell } from './roads'
import { canEnter, claimCell, releaseCell, isEntryGranted, noteEntryGranted, noteEntryRefused } from './blocking'
import { edgeCost, roadDegree } from './graph'
import { routeStep } from './dispatch'
import { PHASE_OUTBOUND, PHASE_RETURNING } from './buildings'

/**
 * Movement: cars advancing along the routes dispatch committed to them, out
 * and back — phase 6 of the tick order, M1c design decision 3 ("Movement
 * accumulates progress in the pathfinder's own cost units").
 *
 * **The signature is the primary defence, and it comes before any test.**
 * `runMovement` takes `state` and `world` — NO `fields`, NO `scratch`. Under
 * decision 2 a car paths once, at dispatch, and then follows its committed
 * `carRoute` whatever happens to the world underneath it; the re-pathing
 * mutation ("read `dir[carCell]` instead of the committed route") is not even
 * CONSTRUCTIBLE against this module, because there is no field here to read.
 * `cars.test.ts` pins the arity for exactly that reason. The behavioural
 * version of that mutation needs a field whose CONTENT changes mid-flight,
 * which needs dispatch and a sync, and lives in Task 6's tests — note that
 * turning is NOT the discriminator: dispatch commits `route[i] = dir[cell_i]`
 * with `cell_{i+1} = step(cell_i, route[i])`, so `dir[carCell] ===
 * route[carRouteCursor]` holds at every tick of an outbound leg by
 * construction, on a path with two turns exactly as much as on a straight
 * corridor.
 *
 * **This module DOES read road topology, as of M1d Task 7, and the promise it
 * used to make instead is written out here so the change is not silent.** Until
 * Task 7 this paragraph read *"this module also never reads the `roads` region"*, and
 * two later paragraphs named Task 7 as the change that would end it. It has.
 * The intersection multiplier needs the DEGREE of the cell a car is entering,
 * which it takes from `roadDegree` (graph.ts) — one read-only helper, one call,
 * one purpose.
 *
 * **What survives is the sentence that was doing the work, and it is now
 * narrower and exactly true: a road edit can change an in-flight car's SPEED
 * and can never change its PATH.** The route is still committed once at
 * dispatch and never re-derived; `next` is still `stepCell(carCell, dir)` with
 * `dir` read from the car's own `carRoute` nibbles; nothing below consults a
 * road bit to decide WHERE to go, only how fast to get there. A road erased
 * under an in-flight car therefore still does not touch its path — the car
 * drives the erased segment to the end of its committed route, whatever happens
 * to the world underneath it — and a road ADDED under it cannot re-route it
 * either. `cars.test.ts` enforces that BEHAVIOURALLY now rather than with the
 * source scan it used to run, because the scan would have kept passing while the
 * claim it stood for stopped being true: the degree read is one call away in
 * graph.ts, so the region name never appears in this file at all. The
 * replacement drives one committed route over two different road networks and
 * requires the same cells in the same order, with only the tick ladder moving.
 *
 * **M1c's deviation from spec §5.11 is discharged as of M1d Task 5, and this
 * paragraph used to record it as outstanding.** The refund no longer "lands
 * immediately" when a car is committed to the cell: `eraseRoad` defers it, the
 * cell becomes a ghost, and `advanceCar` below pays the debt down by one on
 * every departure from a ghost cell (`noteGhostDeparture`, roads.ts). That is a
 * write to two `Uint8` regions, keyed by CELL — it is still not a read of
 * the `roads` region, and the committed route is still never re-derived.
 *
 * **It also imports pure geometry from `roads.ts`, and that was never the same
 * claim.** `OPPOSITE`, `DIR_COUNT` and `stepCell` (M1d Task 1a) are pure grid
 * arithmetic over `DX`/`DY` — none takes a `GameState` and none can observe a
 * road bit. The paragraph above is about the `roads` buffer region, and
 * Task 7 is the change that ended it, exactly as this paragraph used to predict.
 *
 * **As of M1d Task 2 this module WRITES `state.occupancy`, and as of Task 3 it
 * READS it too.** Every other region `advanceCar` touches is indexed by the
 * car; `occupancy` is indexed by the CELL, so one car's advance writes a slot
 * another car's advance reads. Task 2's shared write was already enough to
 * retire this module's "no car can observe another" claim; Task 3's read makes
 * the observation OUTCOME-VISIBLE — a car is now stopped by another car, and
 * `runMovement`'s iteration order decides which of two contenders moves. Both
 * notes below are written to that, not to the M1c premise.
 *
 * **Blocking is still not a road read, and that is a separate claim from Task
 * 7's.** `canEnter` asks occupancy and (from Task 5) `ghostMask`, never the road
 * bits, and it has no `NO_ROAD` outcome on purpose — blocking.ts says why, and
 * the ghost roads that made it matter are now shipped: a committed car HAS to be
 * able to drive a road that has been erased, or §5.11's delayed refund could
 * never be paid at all. Task 7's degree read is about SPEED and enters nowhere
 * near PERMISSION: a car is never refused a cell because of a road bit, and a
 * ghost cell (mask 0, degree 0) is simply a plain cell as far as the multiplier
 * is concerned.
 *
 * ---------------------------------------------------------------------------
 * LANE-SPEED MULTIPLIERS ENTER MOVEMENT AND NOT ROUTING — M1d TASK 7
 * ---------------------------------------------------------------------------
 *
 * Spec §5.5's lane speeds get their first caller here, and the choice of WHERE
 * is the whole decision, so it is written down rather than implied.
 *
 * **They scale `speedUnits` into `advanceCar` and they never touch
 * `edgeCost`.** Two independent reasons, and either alone is sufficient:
 *
 *   1. **A turn multiplier is structurally inexpressible as an edge cost.** It
 *      is a property of the PAIR of edges either side of a cell, not of one
 *      edge: `edgeCost(dir)` is handed a single direction and could not see the
 *      direction the car arrived by even in principle. Dijkstra over a
 *      turn-priced graph needs (cell, incoming direction) nodes — an
 *      eight-fold larger field, per colour, per tick.
 *   2. **It would invalidate four constants that are one calibration.**
 *      `edgeCost`'s value set is `{ORTHO_COST, DIAG_COST}` = `{10, 14}`, and
 *      `NB = DIAG_COST + 1` (scratch.ts), `DISTINCT_EDGE_COSTS = 2`,
 *      `COST_UNIT_SCALE` and `CAR_SPEED_UNITS_PER_TICK` are calibrated jointly
 *      against exactly that set (see `COST_UNIT_SCALE`'s own note). A
 *      lane-speed term in the cost changes the bucket count, the distinct-cost
 *      count, the diagonal ratio and the carry arithmetic together, and moves
 *      the field golden.
 *
 * **The consequence for the flow field, stated because it is a real cost and
 * not a free win.** `dist`/`dir` keep pricing pure LENGTH, so the field routes
 * a car down the shortest path and not the fastest one: a route with two right
 * angles and a junction can now take strictly longer than a longer straight
 * one, and the field will still prefer it. Routing and movement therefore
 * disagree, on purpose. `speedUnits`'s own comment used to cite that divergence
 * as the reason M1c applied no multipliers at all; M1d accepts it, because the
 * alternative is either a turn-aware product graph (reason 1) or a recalibration
 * of the whole cost model (reason 2), and neither is an M1d-sized change.
 * **M1f's motorway tier is the next thing that touches this**, and it is a
 * cost-model change rather than a movement one. Repointed from M1e: motorways
 * are an upgrade CARD, M1e shipped only §5.10's tile grant, and the card modal
 * went to M1f with every item in the table. **The disagreement itself is not a
 * defect and must not be "fixed"** — spec §1/§6 make a congestion-free path
 * cost the game, and `flowfield.test.ts`'s congestion-blindness arms (M1e Task
 * 11) exist to fail if anyone closes it.
 *
 * The rule itself is decision 7 and it lives in `laneSpeedMul` below.
 *
 * **Progress is accumulated in the pathfinder's own cost units:**
 *
 *   progress += speedUnits(LANE_SPEED_DEFAULT)          // per tick
 *   threshold = edgeCost(currentStepDir) * COST_UNIT_SCALE
 *   if (progress >= threshold) { progress -= threshold; advance one cell }
 *
 * `progress -= threshold`, NEVER `progress = 0`. The remainder must carry, or
 * every cell loses up to `speed - 1` units — a systematic slowdown of a
 * fraction of a tick per cell, small on any one crossing and compounding over
 * a run: the classic "diverges only after thousands of ticks" failure. Same
 * bug, same treatment, as `demand.ts`'s `acc -= pinPeriodForWeek(H_WEEK)`. It is
 * observable at all only because `CAR_SPEED_UNITS_PER_TICK` divides neither
 * threshold (see that constant's own note, and `constants.test.ts`, which
 * asserts the indivisibility so a future speed change cannot silently disarm
 * every carry test).
 *
 * The carry crosses a cell boundary and it crosses the outbound -> return
 * flip (Task 6's arrivals flip the phase and leave `carProgress` alone). It
 * is reset to 0 only at trip end, when the car goes idle — a once-per-trip
 * discard of at most one tick against a trip of dozens, taken deliberately so
 * an idle car's bytes are a function of nothing but "idle".
 *
 * **At most one crossing per car per tick, and it is asserted rather than
 * looped over.** `speedUnits(LANE_SPEED_DEFAULT)` is 330 against a smallest
 * threshold of `ORTHO_COST * COST_UNIT_SCALE` = 2500, and the residual after
 * any crossing is strictly less than the speed (the pre-crossing progress is
 * below its own threshold by the same invariant), so a second crossing in one
 * tick is unreachable at these constants. A `while` loop here would be a
 * branch nothing ever exercises; `assertSingleCrossing` is a comparison that
 * turns a constants change invalidating the invariant into a named failure
 * instead of a silent per-tick speed cap.
 *
 * **Nothing here allocates.** No object literal, no array, no closure, no
 * `.map`/`.filter`/`.slice`; every value is a bare number and every buffer
 * written is the caller-owned state buffer. That is a Global Constraint this
 * milestone calls literal — zero, not "small".
 */

/**
 * The smallest threshold any edge can present, in progress units. Movement's
 * one-crossing-per-tick invariant is exactly `speedUnits(...) <
 * MIN_EDGE_THRESHOLD`, and `assertSingleCrossing` below checks the residual
 * against it.
 */
const MIN_EDGE_THRESHOLD = ORTHO_COST * COST_UNIT_SCALE

/**
 * `base` progress units scaled by a lane-speed multiplier (an integer over
 * `DENOM`): truncating integer division, clamped to at least 1 so that no
 * multiplier, however small, can stall a car permanently.
 *
 * **The single owner of the multiplier rounding rule**, extracted at M1d Task 7
 * so that `speedUnits` and `advanceCar` cannot round differently. `advanceCar`
 * scales the `speed` it was HANDED rather than re-deriving from
 * `CAR_SPEED_UNITS_PER_TICK`, which is what keeps its `speed` parameter
 * meaningful (see there); `speedUnits` scales the constant. Two callers, one
 * rounding rule.
 *
 * `scaleSpeed(base, LANE_SPEED_DEFAULT) === base` exactly, for every positive
 * integer base — `base * 1000 / 1000` is exact and the clamp does not bite — so
 * a car with no multiplier applied is bit-identical to M1c's arithmetic and no
 * pre-M1d timing moves.
 */
export function scaleSpeed(base: number, mul: number): number {
  return Math.max(1, ((base * mul) / DENOM) | 0)
}

/**
 * Progress units gained per tick at lane-speed multiplier `mul` (scaled by
 * `DENOM`), at the default car speed.
 *
 * **M1d Task 7 gave this its first non-identity caller**, and the paragraph
 * that used to be here said why M1c had none: *"if movement applied turn or
 * intersection multipliers the flow field could not see them, so the routing
 * model and the movement model would diverge by design."* That divergence is
 * now real and deliberate — the module comment above derives it in full, with
 * the two reasons a lane-speed term cannot go in `edgeCost` instead.
 *
 * `cars.test.ts` still checks this against a HAND-WRITTEN LITERAL TABLE rather
 * than against the formula, and that is still the right shape: the table pins
 * the truncation at `speedUnits(333) === 109` (round-half-up gives 110) and the
 * clamp at `speedUnits(3) === 1`, and **neither is reachable through the new
 * caller** — the six multipliers movement can produce are 333, 416, 500, 583,
 * 667 and 1000, giving 109..330, all far above the clamp, and only 333 has a
 * fractional part big enough for the rounding direction to show. The table
 * remains the only observer of both, exactly as it was; Task 7 adds an observer
 * for multiplier SELECTION, not for this function's arithmetic.
 */
export function speedUnits(mul: number): number {
  return scaleSpeed(CAR_SPEED_UNITS_PER_TICK, mul)
}

/**
 * The road degree at which the cell being ENTERED counts as an intersection
 * (M1d decision 7): a third road meets there. Degree 2 is a corridor cell, 1 a
 * dead end, 0 bare ground; a car crossing into any of those is not "approaching
 * an intersection" in spec §5.5's sense.
 */
const INTERSECTION_DEGREE = 3

/**
 * "No multiplier of this kind applies", as distinct from "a multiplier of 1.0
 * applies". **The difference is load-bearing and is the whole reason this is not
 * `LANE_SPEED_DEFAULT`:** §5.5 averages the multipliers that APPLY, so a lone
 * intersection must give 500 and not `(1000 + 500) / 2 = 750`. Zero is not a
 * legal lane-speed multiplier (it would stall a car), so it is free as a
 * sentinel.
 */
const MUL_NONE = 0

/**
 * `previousLegDir`'s answer at the first crossing of a leg, where there is no
 * in-leg predecessor and therefore no turn. Not a direction index; `turnSpeedMul`
 * is the only reader and answers `MUL_NONE` for it.
 */
export const NO_PREVIOUS_DIR = -1

/**
 * The direction of car `i`'s PREVIOUS crossing on its current leg, or
 * `NO_PREVIOUS_DIR` if this is the leg's first crossing.
 *
 * **Within a leg only, and that is decision 7's rule rather than a convenience.**
 * Outbound the cursor starts at 0 and counts up, so the previous step is
 * `cursor - 1` and there is none at cursor 0. Returning it starts at `routeLen`
 * and counts down, retracing `OPPOSITE[route[cursor - 1]]`, so the previous
 * return crossing used `cursor + 1` and there is none at `cursor === routeLen`.
 *
 * **The outbound -> return flip therefore emits no turn**, which is what makes
 * the 180-degree case unreachable rather than merely unlikely: a car arrives at
 * the carpark heading `d` and leaves heading `OPPOSITE[d]`, which is exactly the
 * reversal `turnSpeedMul` throws on. `trips.ts` flips the phase IN PLACE on the
 * carpark cell with no crossing, so the first crossing of the return leg is a
 * leg-first crossing and is never asked about a predecessor.
 */
export function previousLegDir(state: GameState, i: number, outbound: boolean, cursor: number): number {
  if (outbound) return cursor > 0 ? routeStep(state, i, cursor - 1) : NO_PREVIOUS_DIR
  return cursor < (state.carRouteLen[i] as number)
    ? (OPPOSITE[routeStep(state, i, cursor)] as number)
    : NO_PREVIOUS_DIR
}

/**
 * The turn component of the lane-speed multiplier for a crossing that ARRIVED
 * at the current cell heading `dirIn` and LEAVES it heading `dirOut`, or
 * `MUL_NONE` when the turn carries no multiplier.
 *
 * **The turn is a property of the cell being LEFT** — you turn where you turn —
 * which is why it is computed from the pair of directions rather than from
 * anything about a cell. The intersection component is the mirror image: a
 * property of the cell being ENTERED. Both are charged to the SAME crossing, the
 * one out of the corner and into the junction, which is what makes the two
 * averageable at all.
 *
 * On the 8-direction lattice a turn is 45, 90, 135 or 180 degrees, and the angle
 * is `45 * min(|d|, DIR_COUNT - |d|)` for `d` the difference of the two
 * direction indices (M1d decision 7):
 *
 *   | eighths | angle | multiplier                       |
 *   |---------|-------|----------------------------------|
 *   | 0       | 0     | none — straight on                |
 *   | 1       | 45    | **none** — the lattice's gentlest turn is free |
 *   | 2       | 90    | `RIGHT_ANGLE_SPEED_MUL` = 667     |
 *   | 3       | 135   | `SHARP_TURN_SPEED_MUL` = 333, the sharpest the lattice admits |
 *   | 4       | 180   | **throws** — see below            |
 *
 * **180 degrees is asserted unreachable rather than given a behaviour**, in the
 * fail-closed idiom `assertSingleCrossing` established. Within an outbound leg
 * the route is the flow field's downhill walk and `dist` strictly decreases
 * along it, so no two consecutive steps can be exact opposites; a return leg is
 * that same sequence negated, which preserves every angle; and the flip between
 * the two legs emits no pair at all (`previousLegDir`). So a reversal here means
 * a corrupted route or a hand-built state, and the alternative to a named throw
 * is a car that silently drives backwards at some plausible speed. Exercised
 * directly in `cars.test.ts`.
 *
 * @param dirIn `NO_PREVIOUS_DIR` at the first crossing of a leg, which is the
 *              "no turn" answer and not an error.
 */
export function turnSpeedMul(dirIn: number, dirOut: number): number {
  if (dirIn === NO_PREVIOUS_DIR) return MUL_NONE
  const d = dirIn > dirOut ? dirIn - dirOut : dirOut - dirIn
  const eighths = d <= DIR_COUNT - d ? d : DIR_COUNT - d
  if (eighths === 4) {
    throw new Error(
      `cars: a car turned 180 degrees within one leg, entering a cell heading ${dirIn} and leaving it ` +
        `heading ${dirOut} — the field's downhill walk cannot produce a reversal and the outbound/return ` +
        'flip emits no in-leg pair, so this is a corrupted route rather than a manoeuvre',
    )
  }
  if (eighths === 3) return SHARP_TURN_SPEED_MUL
  if (eighths === 2) return RIGHT_ANGLE_SPEED_MUL
  return MUL_NONE
}

/**
 * The intersection component for a crossing INTO `cell`, or `MUL_NONE`.
 *
 * **The cell being entered, never the cell being left**, per decision 7: the
 * intersection is what you approach. A car LEAVING a junction is already through
 * it and is not slowed by it — which is the discriminator `cars.test.ts` builds
 * its junction fixture around, because "apply it to the cell being left" is
 * otherwise an equivalent mutant on any route whose junction is not at an end.
 */
export function intersectionSpeedMul(state: GameState, cell: number): number {
  return roadDegree(state, cell) >= INTERSECTION_DEGREE ? INTERSECTION_SPEED_MUL : MUL_NONE
}

/**
 * The lane-speed multiplier for one crossing: out of the cell the car is
 * standing on, heading `dirOut`, into `cell`, having arrived heading `dirIn`.
 *
 * **Averaged where several apply, not minimised** (spec §5.5). Exactly two
 * combinations are reachable, because a turn has one angle and a cell has one
 * degree:
 *
 *   | applicable  | average | `speedUnits` | a MINIMUM would give | orthogonal ticks |
 *   |-------------|---------|--------------|----------------------|------------------|
 *   | {667}       | 667     | 220          | —                    | 12               |
 *   | {500}       | 500     | 165          | —                    | 16               |
 *   | {333}       | 333     | 109          | —                    | 23               |
 *   | {667, 500}  | 583     | **192**      | 500 -> 165           | **14** vs 16     |
 *   | {333, 500}  | 416     | **137**      | 333 -> 109           | **19** vs 23     |
 *
 * "Take the minimum instead" is observable in both compound rows and
 * `cars.test.ts` kills it there.
 *
 * **The rounding direction of the average is a labelled INERT choice, and this
 * is the note that says when it stops being inert.** Both reachable averages are
 * half-integers — 583.5 and 416.5 — and both round to the same `speedUnits`
 * either way: 583 and 584 both give 192, 416 and 417 both give 137. That is the
 * WHOLE reachable set, not a sample, so "round the average up" is a provable
 * equivalent mutant through every behavioural observer in the repo (arrival
 * ticks, held progress, every golden). It is truncated here, matching
 * `scaleSpeed`'s own truncation, and `cars.test.ts` pins the two equivalences
 * directly so that the day `CAR_SPEED_UNITS_PER_TICK` or any of the three
 * multipliers moves, the pin fails and somebody has to make the choice on
 * purpose. Only a direct assertion on this function's return value can see the
 * direction today; nothing downstream can.
 *
 * **Re-confirmed at the close of M1e (Task 11), by reading the constants rather
 * than by re-running the equivalence.** Diffed across the whole milestone
 * (base `1414e33`), `CAR_SPEED_UNITS_PER_TICK` = 330,
 * `RIGHT_ANGLE_SPEED_MUL` = 667, `SHARP_TURN_SPEED_MUL` = 333,
 * `INTERSECTION_SPEED_MUL` = 500 and `LANE_SPEED_DEFAULT` = 1000 are all
 * byte-identical to what they were before Task 1 — none of the five has been
 * touched since M1c at the latest. So the named condition that would end the
 * inertness has not fired, and **no detector was manufactured for it**: a test
 * that could see the rounding direction today would have to be a test of this
 * function's literal return value, which the four `speedUnits` lines in
 * `cars.test.ts` already are. Adding a behavioural one would be adding a test
 * that cannot fail.
 *
 * Returns `LANE_SPEED_DEFAULT` when nothing applies — the identity, which
 * `scaleSpeed` passes through exactly.
 */
export function laneSpeedMul(state: GameState, dirIn: number, dirOut: number, cell: number): number {
  const turn = turnSpeedMul(dirIn, dirOut)
  const junction = intersectionSpeedMul(state, cell)
  if (turn === MUL_NONE) return junction === MUL_NONE ? LANE_SPEED_DEFAULT : junction
  if (junction === MUL_NONE) return turn
  return ((turn + junction) / 2) | 0
}

/**
 * Throws if the progress a car carried past a crossing is itself enough to
 * cross again — i.e. if the one-crossing-per-tick invariant no longer holds.
 *
 * Not reachable at M1c's constants (see the module comment's proof) and not
 * dead either: it is reachable through `constants.ts`, which is the point.
 * Raise `CAR_SPEED_UNITS_PER_TICK` above `ORTHO_COST * COST_UNIT_SCALE` and
 * this code would silently cap every car at one cell per tick, discarding the
 * excess progress on every crossing — a slow, uniform, invisible slowdown of
 * exactly the kind decision 3 exists to prevent. This converts that into a
 * named failure at the first crossing.
 *
 * **The bound is the SMALLEST threshold, not the one just crossed.** The
 * residual has to be small enough that it cannot cross whatever edge comes
 * NEXT, and the next edge may be orthogonal even when the one just paid for
 * was diagonal. Passing `threshold` here instead would wave through a residual
 * of 2500-3499, which is a whole orthogonal cell.
 *
 * Parameterised rather than closing over the module constants, on the
 * precedent of `assertBucketCountExceedsEveryEdgeCost` (scratch.ts) and
 * `assertDispatchProgress` (dispatch.ts): the failure path is then testable
 * directly, without editing a constant and rebuilding. `advanceCar`'s own
 * `speed` parameter is what makes the CALL SITE reachable too — see there.
 *
 * @internal Exported for testing only; `advanceCar` is the real call site.
 */
export function assertSingleCrossing(residual: number, minThreshold: number): void {
  if (residual >= minThreshold) {
    throw new Error(
      `cars: a car carried ${residual} progress units past a crossing, which is not below the ` +
        `smallest edge threshold (${minThreshold}) — one crossing per car per tick is no longer ` +
        'an invariant at these constants, and movement is silently discarding the excess',
    )
  }
}

/**
 * One car's advance for one tick, by `speed` progress units.
 *
 * A car that is not `PHASE_OUTBOUND`/`PHASE_RETURNING`, or whose route is
 * already exhausted (outbound at `cursor === routeLen`, returning at `cursor
 * === 0`), is left COMPLETELY untouched — not even its progress accumulates.
 * An exhausted car is one arrivals has not collected yet; letting it bank
 * progress would credit the next leg with time it did not spend driving.
 *
 * **From M1d Task 3 there is a FOURTH way this function moves no car: the
 * entry refusal**, and the three above are exactly why the refusal's reason has
 * to be in `canEnter`'s return value rather than inferred from "the car did not
 * move". Distinguishing them from outside takes all three of: the phase is
 * driving, the cursor is in range, and `carProgress` is bit-identical to last
 * tick's. Only a refusal produces that combination — a sub-threshold tick
 * raises `carProgress` by `speed`, and the other two arms need a non-driving
 * phase or an exhausted cursor. `blocking.test.ts` states that derivation where
 * it uses it.
 *
 * **From Task 4 the refusal is also the only one of the four that writes
 * anything**: it raises `carBlockedTicks[i]` by one. The other three still
 * write literally nothing, so that region doubles as a fifth discriminator —
 * an idle or route-exhausted car's counter is 0 at every tick of every run.
 *
 * The return leg is the same route read backwards, stepping
 * `OPPOSITE[route[cursor - 1]]` and decrementing. `edgeCost(OPPOSITE[d]) ===
 * edgeCost(d)` for every `d` (the table pairs each direction with its exact
 * negation, and `edgeCost` reads orthogonality off `DX`/`DY`), so the return
 * leg's total cost is exactly the outbound leg's — which is what makes a
 * round trip's tick count hand-computable.
 *
 * **`speed` is a parameter rather than a constant read, and that is the only
 * reason the one-crossing-per-tick guard is testable at all.** At M1c's
 * constants `assertSingleCrossing` can never fire, so "delete that call"
 * survives every test that drives movement through `runMovement` — verified,
 * not assumed. Passing a speed above the smallest threshold here makes the
 * guard fire on the fifth crossing, which is what `cars.test.ts` does. The
 * precedent is `assertBucketCountExceedsEveryEdgeCost` (scratch.ts) and
 * `assertDispatchProgress` (dispatch.ts): make the unreachable branch
 * reachable from a test rather than leave it as the one thing nothing
 * executes.
 *
 * **From M1d Task 7 `speed` is the BASE speed and this function scales it, and
 * that is not what M1c's version of this paragraph predicted.** It said *"M1d,
 * where a car's speed depends on its lane, passes a real per-car value through
 * here"* — which cannot be done: the multiplier depends on the PAIR of route
 * steps either side of the current cell and on the degree of the cell being
 * entered, none of which `runMovement` has without decoding the route itself.
 * So `runMovement` still passes one number for every car and this function
 * scales it per crossing, through `scaleSpeed`. The parameter keeps its meaning
 * — `scaleSpeed(speed, LANE_SPEED_DEFAULT) === speed` exactly — so the
 * guard test above still drives the call site with the speed it chooses,
 * unchanged, on any route where no multiplier applies.
 *
 * @internal `runMovement` is the production call site; this is exported for
 * the guard test above.
 */
export function advanceCar(state: GameState, world: WorldData, i: number, speed: number): void {
  const phase = state.carPhase[i] as number
  if (phase !== PHASE_OUTBOUND && phase !== PHASE_RETURNING) return

  const outbound = phase === PHASE_OUTBOUND
  const cursor = state.carRouteCursor[i] as number
  if (outbound ? cursor >= (state.carRouteLen[i] as number) : cursor <= 0) return

  // The committed route, never a field and never `roads`. On the return leg
  // the car retraces step `cursor - 1` backwards; `routeStep` (dispatch.ts) is
  // the single owner of the nibble layout and is imported rather than
  // re-derived here — which is what makes a nibble-order swap unconstructible
  // in this module rather than merely unlikely. Such a swap leaves the
  // endpoint, the total cost and the arrival tick all unchanged (measured, not
  // argued), so any assertion restricted to those three would pass it.
  const dir = outbound ? routeStep(state, i, cursor) : (OPPOSITE[routeStep(state, i, cursor - 1)] as number)
  // Throws for a direction outside [0, DIR_COUNT) — i.e. for a corrupted route
  // nibble, which is otherwise a plausible-looking wrong move.
  const threshold = edgeCost(dir) * COST_UNIT_SCALE

  // **Hoisted above the progress accumulation at M1d Task 7**, because the
  // lane-speed multiplier needs the DEGREE of the cell being entered and the car
  // accumulates toward that cell on every tick of the traversal, not only on the
  // tick it crosses. Two consequences worth stating rather than discovering:
  //
  //   - A corrupted route that walks off the grid now throws on the FIRST tick
  //     of the doomed crossing instead of the tick it would have completed on.
  //     Strictly earlier, same error, same untouched car — `cars.test.ts`'s four
  //     bounds tests assert the car did not move and still do.
  //   - It runs once per driving car per tick rather than once per crossing.
  //     `stepCell` is three comparisons and an add; it allocates nothing.
  const next = stepCell(state.carCell[i] as number, dir, world.w, world.h)
  if (next < 0) {
    // Unreachable through `runDispatch`: its downhill walk breaks the moment a
    // step would leave the grid, and the route is then refused rather than
    // committed. Reachable through a hand-written or corrupted route, where
    // the alternative is not a crash but a silent row-seam wrap onto a cell
    // the route never named. Exercised directly in `cars.test.ts`.
    throw new Error(
      `cars: car ${i} would step off the grid from cell ${state.carCell[i]} in direction ${dir} — ` +
        'its committed route leaves the board, which dispatch refuses to produce',
    )
  }

  // ------------------------------------------------------------------------
  // THE LANE-SPEED MULTIPLIER — M1d Task 7, decision 7
  // ------------------------------------------------------------------------
  //
  // The turn is charged at the cell being LEFT (from the pair of in-leg
  // directions) and the intersection at the cell being ENTERED (`next`'s
  // degree); both are charged to THIS crossing and averaged where both apply.
  // `laneSpeedMul` owns the rule; the module comment owns why it lives here and
  // not in `edgeCost`.
  //
  // **Constant for the whole traversal, which is why it may be recomputed every
  // tick without changing anything.** `dirIn`, `dir` and `next` are all fixed
  // from the moment the car lands on this cell until it leaves, so a car that
  // spends 23 ticks crossing one cell gains exactly 109 units on each of them.
  // Recomputing beats caching: a cached per-car speed would be a second piece of
  // movement state to snapshot, and Decision 5's refusal path would have to
  // decide whether to keep it.
  const dirIn = previousLegDir(state, i, outbound, cursor)
  const tickSpeed = scaleSpeed(speed, laneSpeedMul(state, dirIn, dir, next))

  const progress = (state.carProgress[i] as number) + tickSpeed
  if (progress < threshold) {
    state.carProgress[i] = progress
    return
  }

  const residual = progress - threshold
  assertSingleCrossing(residual, MIN_EDGE_THRESHOLD)

  // ------------------------------------------------------------------------
  // THE BLOCKING QUESTION — M1d Task 3, Decision 5. Asked HERE and nowhere
  // else, because this is the only place a car changes cell.
  // ------------------------------------------------------------------------
  //
  // **Checked at cell ENTRY, never mid-cell.** The car is at
  // `(carCell, carProgress)` and becomes blocked only at the instant it would
  // cross. Everything above this line has already happened on a refused tick —
  // the threshold comparison, the residual, the single-crossing guard, the
  // `stepCell` bounds throw — and none of it writes anything.
  //
  // **Placed AFTER the `next < 0` throw on purpose.** A corrupted route that
  // walks off the grid must stay a named, unresumable failure; asking
  // `canEnter` first would need `canEnter` to re-derive `next` itself, and a
  // refusal there would silently convert the corruption into a car that stops.
  //
  // **On a refusal this writes exactly ONE byte pair and no others.** Not
  // `carProgress`, not `carCell`, not `carRouteCursor`, not occupancy — only
  // `carBlockedTicks[i]`, which Task 4 added and which is the whole difference
  // from Task 3's "writes nothing at all". `cars.test.ts`'s buffer-identity
  // assertion was narrowed to exactly that one region in the same commit, and
  // it is the STRONGER form of the original: it pins both the write that must
  // happen and the absence of every write that must not. Two consequences of
  // holding the progress, both load-bearing:
  //
  //   - **The progress is HELD, not clamped.** `carProgress` keeps the value it
  //     had before this tick's `speed` was notionally added, which is in
  //     `[threshold - speed, threshold)`. Writing `carProgress = threshold`
  //     instead would discard up to `speed - 1` units — the carry-dropping bug
  //     the module comment above forbids — and would make the renderer's
  //     `f = carProgress / threshold` exactly 1.0, drawing the car at the
  //     centre of the cell it has NOT entered, on top of the car it is waiting
  //     for. Holding keeps `f < 1` and needs no renderer change at all.
  //     Accumulating instead (writing `progress`) is worse again: the car
  //     launches a whole cell forward the moment the way clears, and the
  //     displacement grows without bound while it waits.
  //   - **It advances exactly one cell when the way clears, never two.** On the
  //     granting tick `progress` is in `[threshold, threshold + speed)`, so the
  //     residual is below `speed`, which is below `MIN_EDGE_THRESHOLD`. By
  //     construction, not by a clamp.
  //
  // **A blocked car cannot consume its pin, and that holds BY CONSTRUCTION
  // rather than by a check here.** Arrival is cursor-driven: `runArrivals`
  // (trips.ts) fires on `cursor >= carRouteLen`, and `carRouteCursor` is
  // written in exactly one place — the crossing block below. A refused car
  // therefore keeps its reservation and its destination's pin until it actually
  // reaches the carpark, and letting it consume one early would take new code,
  // not a missing guard. That matters because `destReserved` is what stops a
  // second car being dispatched to a pin this one is still holding: consuming
  // early breaks `sum(destReserved) === count(PHASE_OUTBOUND)` and the next
  // car's `assertArrivalHonoured` throws by name.
  //
  // ------------------------------------------------------------------------
  // THE ANTI-DEADLOCK VALVE'S COUNTER — M1d Task 4, Decision 6
  // ------------------------------------------------------------------------
  //
  // `carBlockedTicks[i]` is the number of CONSECUTIVE ticks car `i` has been
  // refused this entry, and this is its only writer. It goes up by one on a
  // refusal (saturating) and back to 0 on any grant, `ENTER_VALVE` included;
  // `blocking.ts` owns all three rules and both writes are one call each, so no
  // caller can implement half the protocol.
  //
  // **The two calls sit on opposite sides of the same branch, and the reset is
  // the half that is easy to lose.** Dropping `noteEntryGranted` leaves a car
  // that valved once with a saturated counter forever: every later crossing is
  // answered `ENTER_VALVE` and it drives through every car in front of it for
  // the rest of its trip. The counter is a WAIT, not a permit.
  //
  // **`ENTER_VALVE` is grouped with `ENTER_FREE` here, not special-cased.**
  // Everything below this line — release, claim, cursor, carry — is identical
  // for the two, and that is the point: a valved crossing is an ordinary
  // crossing that happened to be granted for a different reason. The only place
  // the two differ at all is that the valve's claim can DISPLACE the slot's
  // current holder, which `claimCell`'s unconditional write and `releaseCell`'s
  // identity guard between them make sound (blocking.ts's Decision 6 trace).
  //
  // **The grant set is `isEntryGranted` (blocking.ts) and is deliberately NOT
  // spelled out here, and Task 5 is why.** Tasks 3 and 4 both recorded the
  // fail-open spelling — `if (outcome === EnterOutcome.REFUSED_OCCUPIED) {
  // noteEntryRefused(state, i); return }` — as a measured 0-detector mutant and
  // both named Task 5, which adds `REFUSED_GHOST`, as the task that would kill
  // it. **Task 5 landed and it did not, and the reason is a proof rather than a
  // missing fixture:** the only cell this function ever asks about is `next`,
  // the next cell of its OWN committed route, and `isCommittedTo` answers `true`
  // for that cell by construction — so `canEnter` cannot return `REFUSED_GHOST`
  // to this call site, ever, for any car, on any board. Enumerated as well as
  // argued: 131,930 in-flight shapes, zero exceptions (blocking.ts).
  //
  // So the branch stays unfalsifiable no matter what fixture is written, and the
  // repair is to move the RULE somewhere it can be tested rather than to
  // manufacture a fixture that cannot exist. `isEntryGranted` is a pure function
  // of one enum value with a test against all four codes by name; the fail-open
  // spelling applied THERE dies immediately. Do not re-inline it here.
  //
  // **A `REFUSED_GHOST` would feed `noteEntryRefused`, and that is a decision
  // rather than a fall-through** — it is the same wait as any other refusal from
  // the car's point of view, and the saturating ceiling is what keeps it
  // harmless. It is also, for the same reason as above, not something
  // `runMovement` can produce; `noteEntryRefused`'s clamp therefore remains
  // production-unreachable after Task 5, contrary to what Task 4's own comment
  // predicted. Its direct test in `blocking.test.ts` is still its only observer.
  const outcome = canEnter(state, world, i, next, dir)
  if (!isEntryGranted(outcome)) {
    noteEntryRefused(state, i)
    return
  }
  noteEntryGranted(state, i)

  // Occupancy, lifecycle events 3 then 2 (blocking.ts). This is the ONE
  // crossing site in the codebase, so it is the one place both events fire.
  //
  // Release BEFORE the `carCell` write, because `releaseCell` is about the cell
  // the car is standing on and that write is what stops it standing there. The
  // two cells are always distinct (`stepCell` never returns its own argument —
  // no direction has `DX === 0 && DY === 0`), so the order is not load-bearing
  // for correctness; it is written this way so it reads as "leave, then enter".
  //
  // `releaseCell` is guarded by identity and clears BOTH lanes, and takes no
  // direction at all: releasing the lane derived from the OUTGOING direction is
  // wrong at every turn, which is decision 6's corruption case. `claimCell`
  // overwrites unconditionally with the lane of THIS crossing's direction.
  //
  // Reached only on a GRANT, and from Task 4 that is two codes rather than one.
  // On `ENTER_FREE` the slot is known free and the claim displaces nobody. On
  // `ENTER_VALVE` the slot is known TAKEN and the claim deliberately displaces
  // its holder — the one displacement path in the codebase, which is why
  // `assertOccupancyComplete`'s exception set names the valve and nothing else.
  // The two lines below are the same for both, and Decision 6's self-healing
  // rests on that: the displaced car's own later `releaseCell` finds a slot
  // naming somebody else and correctly does nothing.
  releaseCell(state, i, state.carCell[i] as number)
  // Occupancy lifecycle event 3 has a SECOND consumer as of Task 5, and it is
  // deliberately not folded into `releaseCell`: a lane slot and a deferred
  // refund are two different ledgers over the same event, one keyed by (cell,
  // lane) and one by cell alone, and the release is guarded by car identity
  // while this one is not. Read from `carCell[i]` BEFORE the write below, for
  // the same reason `releaseCell` is: the cell the car is standing on is the
  // cell whose ghost it is clearing. `noteGhostDeparture` returns immediately
  // for the overwhelmingly common case of a cell that is not a ghost.
  noteGhostDeparture(state, state.carCell[i] as number)
  state.carCell[i] = next
  claimCell(state, i, next, dir)
  state.carRouteCursor[i] = outbound ? cursor + 1 : cursor - 1
  state.carProgress[i] = residual
}

/**
 * Phase 6 of the tick order: advance every in-flight car along its committed
 * route, outbound or returning.
 *
 * Placed AFTER dispatch, so a car dispatched on tick T also moves on tick T —
 * the alternative costs every trip one tick and every exact-tick assertion
 * inherits it. Placed BEFORE arrivals, so a car that finishes its route this
 * tick is collected this tick rather than sitting a tick on the carpark cell.
 *
 * Cars are iterated in ascending index and each car's phase byte is read
 * exactly once, per the anti-double-act invariant.
 *
 * **Iteration order stopped being a PROVABLE no-op at M1d Task 2, and at Task 3
 * it became outcome-visible in the strong sense.** Until Task 2, `advanceCar`
 * read and wrote only car `i`'s own slots, so no car could observe another and
 * "iterate descending" was a no-op by reading. Task 2 made it write
 * `state.occupancy`, which is cell-indexed and shared. Task 3 makes it READ
 * that region: when two cars would cross into the same `(cell, lane)` on one
 * tick, the one the loop reaches first is granted and the other is REFUSED —
 * different survivors, different arrival ticks, for the rest of the run.
 *
 * Measured, not assumed. `for (let i = carCount - 1; i >= 0; i--)`:
 *
 *   - at Task 2, killed by exactly **one** test (the same-lane displacement
 *     fixture, which could only exist while nothing refused anything);
 *   - at Task 3, killed by **11**, and the breakdown is transcribed from the
 *     failure list rather than estimated — an earlier version of this paragraph
 *     said 8 and mis-attributed two of them, which is the same "a figure a
 *     reader is meant to check" defect the test file's own derivation carries a
 *     note about:
 *       - **4** in `two cars dispatched from one house … at the FIRST crossing`
 *         (ascending grants car 0 and refuses car 1; descending the reverse, and
 *         the sibling's whole 161-tick trip moves with it);
 *       - **3** in `three cars behind a blocked leader …`, whose cascade clears
 *         in ONE tick ascending and takes FOUR descending, so every arrival tick
 *         in its hand-computed ladder moves;
 *       - **2** in `a dead-end carpark …`, where ascending vacates the carpark
 *         before the follower is asked and descending does not;
 *       - **2** in `two cars contending for one slot …`, one per index order.
 *
 * Ascending is the specified order (Decision 2), chosen over spec §5.5's
 * "committed timestamp" because movement is discrete — a car either enters a
 * cell this tick or it does not, and a timestamp orders nothing the index does
 * not already order.
 */
export function runMovement(state: GameState, world: WorldData): void {
  const speed = speedUnits(LANE_SPEED_DEFAULT)
  const carCount = state.carPhase.length
  for (let i = 0; i < carCount; i++) advanceCar(state, world, i, speed)
}
