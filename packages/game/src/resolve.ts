import { COST_UNIT_SCALE } from '@laneways/shared'
import {
  DX,
  DY,
  OPPOSITE,
  edgeCost,
  routeStep,
  PHASE_NONE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  type GameState,
  type WorldData,
} from '@laneways/sim'

/**
 * Sub-cell position resolution, the prev/curr snapshots, and the lerp — plan
 * Decision 2.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SUB-CELL TERM
 * ---------------------------------------------------------------------------
 *
 * A car gains 330 progress units per tick against a threshold of
 * `edgeCost(dir) * COST_UNIT_SCALE` (2,500 orthogonal, 3,500 diagonal), so
 * `carCell` changes once every 7.576 ticks orthogonally and 10.606 diagonally —
 * about 3.96 cell changes a second. Interpolating between the PREV CELL and the
 * CURR CELL therefore renders a car motionless for ~6.6 ticks and then smears a
 * whole cell across one 33 ms window: a 4 Hz strobe, and worse than not
 * interpolating at all. The sim already stores the sub-cell term in
 * `carProgress`, so this reads it.
 *
 * `(DX[dir], DY[dir])` is used RAW, not normalised. For a diagonal it is
 * `(±1, ±1)` and `f` reaches 1 exactly when the car lands on the next cell, so
 * the geometry is right for both edge types. The per-tick displacement is
 * 330/2500 = 0.132 cells orthogonally and 330/3500 * sqrt(2) = 0.1333
 * diagonally — near-constant Euclidean speed, which is what `DIAG_COST = 14 ~
 * 10*sqrt(2)` buys.
 *
 * ---------------------------------------------------------------------------
 * A LERP OF TWO RESOLVED SNAPSHOTS, NOT AN EXTRAPOLATION
 * ---------------------------------------------------------------------------
 *
 * `frameXY = prevXY + (currXY - prevXY) * alpha`, with `prevXY` resolved
 * immediately BEFORE each `step` and `currXY` immediately after.
 *
 * The single-expression form `cell + dir * (progress + alpha * speed) /
 * threshold` resolves the same position whenever the car neither turns nor
 * changes phase, and differs only where it extrapolates *past* the end of the
 * current edge: it overshoots a corner by up to 0.19 cells and overshoots the
 * carpark at the outbound -> return flip by 0.13 cells before jumping back.
 * Lerping two resolved snapshots cannot overshoot, and it makes the prev
 * snapshot a thing that can actually be stored — an `Int32Array` of cells
 * cannot hold a sub-cell position.
 *
 * ---------------------------------------------------------------------------
 * EXACTLY ONE DISCONTINUITY, RE-DERIVED AGAINST THE REAL TICK ORDER
 * ---------------------------------------------------------------------------
 *
 * `step` runs dispatch at phase 5, movement at phase 6 and arrivals at phase 7,
 * so every transition is observed across a tick boundary with the phase byte
 * already changed. Every way a car's resolved position can move between two
 * snapshots:
 *
 *   | Transition                                   | Displacement          |
 *   |----------------------------------------------|-----------------------|
 *   | Driving, no crossing                         | 0.132 / 0.1333        |
 *   | Driving, crossing straight through           | 0.132 / 0.1333        |
 *   | Driving, crossing with a turn                | <= 0.1333, chord cuts |
 *   | IDLE -> OUTBOUND (dispatch, then movement)   | 0.132 / 0.1333        |
 *   | OUTBOUND -> RETURNING (the flip)             | |330 - 2r| / threshold|
 *   | RETURNING -> IDLE (trip end)                 | (330 - r) / threshold |
 *   | IDLE -> IDLE / NONE -> NONE                  | 0                     |
 *   | **not live in prev, live in curr**           | **unbounded**         |
 *
 * `r` is the post-crossing carry, in `[0, 330)`, so the two arrival rows are
 * bounded by one tick's ordinary motion — 0.132 orthogonally, 0.1333
 * diagonally. **They are not zero**, and the flip's is signed: at a small carry
 * the car still moves forward, at a large one it steps back a fraction of a
 * cell as the reversed direction consumes the carry from the other side. Both
 * are indistinguishable from ordinary driving at frame rate.
 *
 * So the only real discontinuity is the last row, and the rule is:
 *
 *   > A car slot that was not live in the prev snapshot renders at its curr
 *   > position with no lerp. Everything else lerps unconditionally.
 *
 * plus `initCarSnapshots`, because an unwritten `Float32Array` is all-zero,
 * which is grid cell (0, 0) — a zero-initialised prev streaks every car in from
 * the top-left corner on frame 1.
 *
 * **There is deliberately NO distance guard.** A car never moves more than one
 * cell per tick (`assertSingleCrossing`, cars.ts), so a one-cell threshold is a
 * 0-detector: no on-manifold displacement can reach it, and its named must-fail
 * mutation cannot fail. A renderer drawing a streak on corrupted state is
 * cosmetic, not corrupting.
 *
 * ---------------------------------------------------------------------------
 * THE SNAPSHOTS ARE INDEXED BY CAR SLOT, NEVER BY DENSE POSITION
 * ---------------------------------------------------------------------------
 *
 * `RenderFrame.carXY` is dense — live cars packed at the front — but these
 * buffers are not. A house placed mid-run gives its cars slots
 * `[h * CARS_PER_HOUSE, ...)`, which is always past every existing house's
 * cars, so today a dense prev would only ever be appended to. That is a
 * property of `placeHouse`, not of the interpolator, and M1e's building removal
 * ends it: one freed slot would shift every later car's dense index by one and
 * lerp each of them against a DIFFERENT car's previous position. A board-wide
 * teleport with no phase transition anywhere and nothing in this file's rule to
 * catch it. Slot indexing costs `maxCars * 2` floats (640 B at `firstCity`) and
 * removes that class.
 *
 * **Scoped precisely, because the wider claim would discharge an obligation
 * that is M1e's.** Slot indexing removes the dense-*shift* class. It does NOT
 * remove the slot-*reuse* class: slot `i` owned by car A in `prev` and car B in
 * `curr`. There `prevLive[i]` reads 1, so the snap rule does not fire, there is
 * no distance guard, and the car is drawn on the segment between two different
 * houses — constructed and measured at 12.6 cells. That class is closed **today
 * only by reachability**: nothing inside `step`'s seven phases frees or creates
 * a car, and out-of-band removal-then-placement happens between frames, so the
 * next `snapshotPrev` resolves the slot as car B and the lerp is B to B.
 *
 * **An in-`step` spawner that reuses a freed slot re-opens it, and nothing here
 * will catch it.** The fix then is either a car-identity term in the snapshot
 * (`prevHome[i]`, compared before lerping) or a spawner that never reuses a
 * slot within one step. Recorded here rather than left for M1e to rediscover.
 *
 * **Nothing here allocates.** Every buffer is caller-owned and every write is
 * into a preallocated typed array.
 */

/**
 * Resolves car slot `i`'s position into `out[offset]`, `out[offset + 1]`, in
 * grid-cell units where an integer names a cell CENTRE.
 *
 * Returns `false` and writes nothing for a slot that is not live. The caller
 * must not read `out` in that case — a dead slot's real bytes are
 * `PHASE_NONE` with `carCell = 0`, and writing "cell 0" would be a phantom car
 * on a real, in-bounds cell rather than an absence.
 */
export function resolveCar(
  state: GameState,
  world: WorldData,
  i: number,
  out: Float32Array,
  offset: number,
): boolean {
  const phase = state.carPhase[i] as number
  if (phase === PHASE_NONE) return false

  const cell = state.carCell[i] as number
  const cx = cell % world.w
  const cy = (cell / world.w) | 0

  // PHASE_IDLE — parked at its house — and, deliberately, any phase byte this
  // module does not recognise. One arm rather than two: an explicit
  // `phase === PHASE_IDLE` branch followed by a driving fall-through would make
  // the two INDEPENDENTLY SUFFICIENT for an idle car, and neither half could
  // then have a detector.
  if (phase !== PHASE_OUTBOUND && phase !== PHASE_RETURNING) {
    out[offset] = cx
    out[offset + 1] = cy
    return true
  }

  const outbound = phase === PHASE_OUTBOUND
  const cursor = state.carRouteCursor[i] as number

  // The exhausted-route fallback is not defensive decoration: `routeStep`
  // throws on an out-of-range index (below 0, or at/past MAX_PATH_LEN) and a
  // renderer must never be the thing that crashes the game. Unreachable from a
  // post-`step` state — arrivals collects an exhausted car in the same tick
  // that exhausts it — and directly callable from a test, which is the
  // `assertSingleCrossing` idiom this codebase already uses for this shape.
  if (outbound ? cursor >= (state.carRouteLen[i] as number) : cursor <= 0) {
    out[offset] = cx
    out[offset + 1] = cy
    return true
  }

  // `cars.ts:208`, exactly. The return leg retraces step `cursor - 1`
  // backwards; half of every trip is on this branch and scoring is defined on
  // it. On a STRAIGHT route `routeStep(cursor)` gives the same answer, which is
  // why `test/resolve.test.ts`'s fixture turns.
  const dir = outbound ? routeStep(state, i, cursor) : (OPPOSITE[routeStep(state, i, cursor - 1)] as number)
  const f = (state.carProgress[i] as number) / (edgeCost(dir) * COST_UNIT_SCALE)

  out[offset] = cx + (DX[dir] as number) * f
  out[offset + 1] = cy + (DY[dir] as number) * f
  return true
}

/**
 * The two resolved snapshots the frame lerps between, indexed by CAR SLOT.
 *
 * `prevXY`/`currXY` hold 2 floats per slot; `prevLive`/`currLive` hold one byte
 * per slot. `prevLive` is the whole of the snap rule — see the module comment.
 */
export interface CarSnapshots {
  readonly slots: number
  readonly prevXY: Float32Array
  readonly currXY: Float32Array
  readonly prevLive: Uint8Array
  readonly currLive: Uint8Array
}

/** Allocates the snapshot buffers once, at boot. `slots` is `state.carPhase.length`. */
export function createCarSnapshots(slots: number): CarSnapshots {
  return {
    slots,
    prevXY: new Float32Array(slots * 2),
    currXY: new Float32Array(slots * 2),
    prevLive: new Uint8Array(slots),
    currLive: new Uint8Array(slots),
  }
}

function snapshotInto(
  state: GameState,
  world: WorldData,
  slots: number,
  xy: Float32Array,
  live: Uint8Array,
): void {
  for (let i = 0; i < slots; i++) {
    live[i] = resolveCar(state, world, i, xy, i * 2) ? 1 : 0
  }
}

/** Resolves the pre-step snapshot. Called immediately BEFORE every `step`. */
export function snapshotPrev(snap: CarSnapshots, state: GameState, world: WorldData): void {
  snapshotInto(state, world, snap.slots, snap.prevXY, snap.prevLive)
}

/** Resolves the post-step snapshot. Called once after a drain that ran at least one tick. */
export function snapshotCurr(snap: CarSnapshots, state: GameState, world: WorldData): void {
  snapshotInto(state, world, snap.slots, snap.currXY, snap.currLive)
}

/**
 * Fills both snapshots from the initial state, once, before the first frame.
 *
 * Without this, frame 1 lerps every car from an unwritten `Float32Array` — all
 * zero, which is grid cell (0, 0) — and the whole city streaks in from the
 * board's top-left corner. The snap rule alone does not cover it: a car placed
 * by `seedStartingCity` IS live in prev the moment prev is resolved at all, so
 * the defect is a missing call, not a missing branch.
 */
export function initCarSnapshots(snap: CarSnapshots, state: GameState, world: WorldData): void {
  snapshotPrev(snap, state, world)
  snapshotCurr(snap, state, world)
}

/**
 * Writes car slot `i`'s frame position into `out[offset]`, `out[offset + 1]`.
 *
 * The caller has already established that the slot is live in `curr`; a slot
 * that is not live in `prev` snaps, everything else lerps.
 */
export function lerpCar(
  snap: CarSnapshots,
  i: number,
  alpha: number,
  out: Float32Array,
  offset: number,
): void {
  const j = i * 2
  const cx = snap.currXY[j] as number
  const cy = snap.currXY[j + 1] as number
  if ((snap.prevLive[i] as number) === 0) {
    out[offset] = cx
    out[offset + 1] = cy
    return
  }
  const px = snap.prevXY[j] as number
  const py = snap.prevXY[j + 1] as number
  out[offset] = px + (cx - px) * alpha
  out[offset + 1] = py + (cy - py) * alpha
}
