import { CAR_SPEED_UNITS_PER_TICK, COST_UNIT_SCALE, DENOM, LANE_SPEED_DEFAULT, ORTHO_COST } from '@laneways/shared'
import type { GameState } from './state'
import type { WorldData } from './world'
import { DX, DY, OPPOSITE } from './roads'
import { edgeCost } from './graph'
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
 * This module also never reads `state.roads`. A road erased under an
 * in-flight car therefore does not touch it: the refund lands immediately
 * (`eraseRoad`) and the car drives the erased segment to the end of its
 * committed route. That is decision 6's stated, tested deviation from spec
 * §5.11's delayed "ghost lane" refund, deferred to M1d.
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
 * bug, same treatment, as `demand.ts`'s `acc -= PIN_PERIOD_TICKS`. It is
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
 * Progress units gained per tick at lane-speed multiplier `mul` (scaled by
 * `DENOM`): truncating integer division, clamped to at least 1 so that no
 * multiplier, however small, can stall a car permanently.
 *
 * **M1c applies no lane-speed multipliers at all** — `edgeCost` is pure
 * length with no lane-speed term, and if movement applied turn or
 * intersection multipliers the flow field could not see them, so the routing
 * model and the movement model would diverge by design. The only live call is
 * `speedUnits(LANE_SPEED_DEFAULT)`, the identity.
 *
 * That is precisely why `cars.test.ts` checks this against a HAND-WRITTEN
 * LITERAL TABLE rather than against the formula: with only the identity call
 * live, the rounding rule and the clamp are dead code under the movement
 * tests alone, and "round instead of truncate" or "drop the clamp" would
 * survive every one of them. The table is the only observer either has until
 * M1d/M1e give them a caller.
 */
export function speedUnits(mul: number): number {
  return Math.max(1, ((CAR_SPEED_UNITS_PER_TICK * mul) / DENOM) | 0)
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
 * The cell one step in direction `dir` from `cell`, or -1 if that leaves the
 * grid.
 *
 * The x/y round-trip is not decoration: `cell + DY * w + DX` alone wraps the
 * grid's right edge onto the next row's left edge — the same row-seam false
 * neighbour `graph.ts`'s `neighbours` guards against, and a wrong-but-plausible
 * cell rather than an out-of-range one.
 *
 * A five-line duplicate of `dispatch.ts`'s private helper of the same name.
 * Both read the SHARED `DX`/`DY` tables, so they cannot disagree about what a
 * direction means; only the bounds test is written twice. Sharing it would
 * mean widening Task 4's module surface for a helper neither module's public
 * contract mentions — recorded in this task's report rather than done
 * silently.
 */
function stepCell(cell: number, dir: number, w: number, h: number): number {
  const x = (cell % w) + (DX[dir] as number)
  const y = ((cell / w) | 0) + (DY[dir] as number)
  if (x < 0 || x >= w || y < 0 || y >= h) return -1
  return y * w + x
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
 * executes. M1d, where a car's speed depends on its lane, passes a real
 * per-car value through here.
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
  // re-derived here, because a nibble-order swap is invisible to every outcome
  // except a per-tick cell trace.
  const dir = outbound ? routeStep(state, i, cursor) : (OPPOSITE[routeStep(state, i, cursor - 1)] as number)
  // Throws for a direction outside [0, DIR_COUNT) — i.e. for a corrupted route
  // nibble, which is otherwise a plausible-looking wrong move.
  const threshold = edgeCost(dir) * COST_UNIT_SCALE

  const progress = (state.carProgress[i] as number) + speed
  if (progress < threshold) {
    state.carProgress[i] = progress
    return
  }

  const residual = progress - threshold
  assertSingleCrossing(residual, MIN_EDGE_THRESHOLD)

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

  state.carCell[i] = next
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
 * exactly once, per the anti-double-act invariant. **Iteration order is a
 * provable no-op today, not an untested choice** — `advanceCar` reads and
 * writes only car `i`'s own slots, so no car can observe another, and
 * "iterate descending" survives the whole suite (recorded, in the idiom
 * `demand.ts`'s overflow-walk bound already uses for a checked no-op).
 * Ascending is kept because M1d's blocking makes the order observable the day
 * a car can be held up by the one in front of it.
 */
export function runMovement(state: GameState, world: WorldData): void {
  const speed = speedUnits(LANE_SPEED_DEFAULT)
  const carCount = state.carPhase.length
  for (let i = 0; i < carCount; i++) advanceCar(state, world, i, speed)
}
