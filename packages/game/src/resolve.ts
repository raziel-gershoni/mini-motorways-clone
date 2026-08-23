import {
  COST_UNIT_SCALE,
  DIAG_COST,
  LANE_SPEED_DEFAULT,
  ORTHO_COST,
  RIGHT_ANGLE_SPEED_MUL,
} from '@laneways/shared'
import {
  DX,
  DY,
  OPPOSITE,
  edgeCost,
  routeStep,
  speedUnits,
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
 * `step` runs dispatch at phase 8, movement at phase 9 and arrivals at phase 10,
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
 * property of `placeHouse`, not of the interpolator, and **M1f's** building
 * removal ends it (repointed from M1e, which adds buildings and removes none —
 * `spawn.ts` appends and §5.8's failure ends the run rather than freeing a
 * slot): one freed slot would shift every later car's dense index by one and
 * lerp each of them against a DIFFERENT car's previous position. A board-wide
 * teleport with no phase transition anywhere and nothing in this file's rule to
 * catch it. Slot indexing costs `maxCars * 2` floats (640 B at `firstCity`) and
 * removes that class.
 *
 * **Scoped precisely, because the wider claim would discharge an obligation
 * that is M1f's.** Slot indexing removes the dense-*shift* class. It does NOT
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
 * slot within one step. **M1e shipped the in-`step` spawner and did NOT reopen
 * it**, for a reason worth naming rather than leaving to luck: `spawn.ts` only
 * ever appends a house at the next free index, so slot `i`'s owner never
 * changes for the life of the buffer. It is removal, not spawning, that reuses
 * a slot — so this stays open and belongs to M1f with the rest of it.
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

// ---------------------------------------------------------------------------
// THE DRAWN POSITION, WHICH IS NOT THE SIM POSITION
// ---------------------------------------------------------------------------
//
// Everything above this line resolves where the sim says a car IS. Everything
// below decides where to DRAW it, and the two are deliberately allowed to
// differ by a bounded amount for a bounded time. The rest of this comment is
// why, and what the bound buys.
//
// ---------------------------------------------------------------------------
// THE DEFECT: A BLOCKED CAR LAUNCHES AT FULL SPEED IN ONE FRAME
// ---------------------------------------------------------------------------
//
// `advanceCar` (`sim/cars.ts`) holds `carProgress` BIT-IDENTICAL on a refused
// tick — deliberately, and the alternatives are worse (its own comment derives
// both). So `prevXY` and `currXY` agree for every tick of a block, `lerpCar`
// renders the car perfectly still, and on the granting tick `carProgress`
// advances by a whole tick's `speedUnits(LANE_SPEED_DEFAULT)`. Measured on the
// demo board over 60 s at 60 fps, before this code existed:
//
//   - drawn speed is 0 or 0.066 cells/frame with **nothing in between** across
//     a block boundary — 3.96 cells/s reached in a single 16.7 ms frame;
//   - the per-frame speed step at such a boundary is 0.066 cells/frame, i.e.
//     **237.6 cells/s^2** treated as an acceleration, which is another way of
//     saying it is not one;
//   - it happens **7.0 times a second** across 24 cars (422 stop->go events in
//     60 s), plus 6.2 go->stop events a second.
//
// A human called it robotic, on hardware, and they were right.
//
// ---------------------------------------------------------------------------
// WHAT CANNOT BE FIXED HERE, PROVED RATHER THAN ASSERTED
// ---------------------------------------------------------------------------
//
// **The launch is fixable. The stop is not.** Write `s(t)` for the sim's
// along-path distance and `d(t)` for the drawn one, and take the three
// properties this renderer must not give up:
//
//   (i)   `d <= s` always — a drawn car must never be further along its route
//         than the sim car, or a car refused entry is drawn INSIDE the cell it
//         was refused, on top of the car it is waiting for. That is a lie about
//         the one thing M1d exists to show.
//   (ii)  `d = s` once the car has held a steady speed — no permanent offset,
//         so the drawn position is the sim position except during a transient.
//   (iii) `|d''| <= A` — bounded acceleration, which is the whole request.
//
// The sim can go from a constant `v` to a dead stop between two ticks. Let
// `t0` be that instant. By (ii), `d(t0) = s(t0)` and `d'(t0) = v`. For
// `t > t0`, `s` is the constant `s(t0)`, so (i) requires `d(t) <= s(t0)`. But
// (iii) gives `d(t) >= s(t0) + v(t - t0) - A(t - t0)^2 / 2`, which is strictly
// greater than `s(t0)` for small positive `t - t0`. Contradiction. **The three
// are jointly unsatisfiable, so smoothing a deceleration requires either
// drawing the car ahead of itself or lagging it permanently.**
//
// Nothing about that proof is specific to this code: it is why braking has to
// be anticipated, and a renderer that only learns a car stopped after it
// stopped cannot anticipate. The two escapes were both considered and both
// rejected:
//
//   - **A permanent speed-proportional lag** (`d = s - v * delta`) smooths both
//     ends and gives up (ii). It also moves a car BACKWARDS relative to its
//     neighbours exactly when it accelerates, which is the one direction that
//     can inverse two cars' drawn order.
//   - **Reading `state.occupancy` to brake early** keeps (i) and (ii) and gives
//     up causality-honesty instead: in a moving platoon the next cell is
//     occupied almost all the time, so every car would brake for a leader that
//     is not stopping. Distinguishing "occupied" from "occupied by a car that
//     is itself blocked" means re-deriving `canEnter` in the renderer, which is
//     the reconstruction `queueProbe.ts` already got wrong once.
//
// So this module smooths the LAUNCH and leaves the STOP alone, and that is a
// designed limit rather than an oversight. It is also the half the player named.
//
// ---------------------------------------------------------------------------
// THE MECHANISM: A SPEED-LIMITED CHASE, ADVANCED ONCE PER TICK
// ---------------------------------------------------------------------------
//
// `drawCurrXY` chases `currXY`. Per tick the drawn speed may change by at most
// `DRAW_SPEED_STEP_CELLS_PER_TICK` and may exceed the sim's own current speed
// by at most the same amount, and the step is clamped so the drawn position can
// neither pass `currXY` nor fall further behind it than `MAX_DRAW_LAG_CELLS`.
//
// **It is advanced in `snapshotCurr`, once per drain, by the drain's tick
// count — never per frame.** Three consequences, all of them the reason:
//
//   - The drawn motion is **frame-rate independent**. 30 Hz, 60 Hz and 120 Hz
//     produce the identical sequence of tick-boundary positions, because the
//     chase's clock is the sim's clock. A per-frame chase would make the car's
//     acceleration a property of the display.
//   - `buildFrame` stays a pure function of `(snapshots, alpha)` — it lerps
//     `drawPrevXY -> drawCurrXY` exactly as it used to lerp
//     `prevXY -> currXY`, with no new parameter and no per-frame state.
//   - Advancing it is not a call a caller can forget: it is inside the function
//     that writes `currXY`, in `blocking.ts`'s idiom of putting both halves of
//     a protocol behind one call.
//
// **`prevXY`/`currXY` keep resolving the exact sim position and are not
// touched.** They are what the drawn position is measured AGAINST — the
// divergence bound below is a test, not an argument, and it needs both numbers.
//
// ---------------------------------------------------------------------------
// WHAT THE BOUND BUYS, AND WHY 0.2 CELLS
// ---------------------------------------------------------------------------
//
// `MAX_DRAW_LAG_CELLS` is enforced by a clamp on every tick, so the maximum
// divergence between the drawn and the sim position is a property of the code
// rather than of the tuning: **at a TICK BOUNDARY, no car is ever drawn more
// than 0.2 cells from where the sim says it is, on any board, at any frame
// rate, through any discontinuity.** The free ramp only ever needs 0.135 of
// that (see `MAX_DRAW_LAG_CELLS`), so the clamp is a floor under the proof and
// not part of the normal path.
//
// **That sentence used to have no "at a tick boundary" in it, and the missing
// scope made it false of what is actually on screen.**
//
// THE ENUMERATION, because two adjacent quantities here differ by 33% and a
// review already conflated them: demo layout, after its warm start; one
// `snapshotPrev` per tick and one `snapshotCurr` per frame, exactly as
// `createFrameDriver` does it; alpha swept on a 21-point grid `g / 20`; the max
// taken over every (car, frame) with `currLive === 1`; the frame-to-frame
// columns gated on the same car having been live in the previous frame.
//
// ```
//   schedule                        A: max|drawCar-lerpCar|   B: at alpha 1   C: drawn step
//   1 tick per frame, 3,000 frames        0.1320 (0.66x)        0.132002         0.1760
//   one 7-tick drain in ten, 3,000        0.9240 (4.62x)        0.200010         1.0560
//   every frame drains 7 ticks, 800       0.9920 (4.96x)        0.200010         1.1240
// ```
//
// **A, B and C are three different things and only A is the divergence.**
// A is `drawCar` against `lerpCar` at the same alpha, over alpha < 1. B is the
// same pair at alpha 1, which is the clamp doing its job — it reaches 0.200010,
// which IS `MAX_DRAW_LAG_CELLS`, and never exceeds it. **C is not a divergence
// at all**: it is how far the drawn car moves between one frame and the next,
// which is also exactly `drawCar(1) - drawCar(0)` within one frame (measured
// equal in all three rows). Row 1's A is 0.1320 and its C is 0.1760; quoting C
// as A overstates the divergence by a third.
//
// So the claim is: the clamp holds at alpha 1 on every row, and the mid-frame
// divergence reaches **4.96x** it.
//
// **The mechanism, which is in `frame.ts` rather than here.** `beforeStep` runs
// `snapshotPrev` per TICK, so `prevXY -> currXY` spans only the LAST tick of a
// drain; `afterDrain` runs `snapshotCurr` once, so `drawPrevXY -> drawCurrXY`
// spans the WHOLE drain. The two interpolants therefore cover different
// intervals and coincide only at alpha 1 — and alpha 1 is the one value the
// loop never passes (`alpha = accumulator / TICK_MS` is in `[0, 1)`), so the
// reachable worst case is the near-alpha-0 end, not the endpoint the clamp
// bounds. `carSmoothing.test.ts`'s 30 s survey cannot see any of this because
// at 60 fps against a 30 Hz tick every drain is 0 or 1 tick, and at one tick
// per frame the two interpolants span the same interval.
//
// **This is a documentation fix and not a regression**, and the reason is worth
// stating so nobody "fixes" it: a multi-tick drain means the tab was starved,
// the car really did move that far, and the chase adds at most its own
// outstanding lag on top of that. Measured as a per-(car, frame) EXCESS —
// drawn step minus exact step on the same car and the same frame, which is the
// quantity the sentence is about — the worst is **0.2000** on the sustained
// 7-tick schedule, 0.1320 on the burst one and 0.0440 at one tick per frame.
//
// Note the first of those lands on `MAX_DRAW_LAG_CELLS` to four decimals, and
// that is disclosed rather than hidden: it is what the clamp predicts, so it is
// a measurement AGREEING with arithmetic and not a substitute for one. An
// earlier draft of this paragraph quoted the two column-C figures instead
// (1.1240 against 0.9240) — whose difference is that same 0.2000 — which reads
// as measurement and is really the bound restated. The excess is the honest
// form because it is maximised independently, over the same 18,888 car-frames,
// and could have come back larger.
//
// Three things the bound is what makes safe. **All three are stated at a tick
// boundary and inherit the scope above** — in particular, over a multi-tick
// drain the drawn car lerps along a chord spanning the whole drain, so the
// "never leaves the road" argument's corner case is wider than 0.2 cells.
// That widening is NOT measured here and should not be quoted as if it were;
// the reproduction is the table above with a route that turns inside one
// drain.
//
//   - **The drawn car never leaves the road.** It is within 0.2 cells of a
//     point on the route's centreline, and a cell's half-width is 0.5. At a
//     corner the chase cuts the chord rather than following the elbow, and the
//     cut is bounded by the same 0.2.
//   - **Two cars cannot be drawn in the wrong order** unless the sim itself is
//     already drawing them within `2 * MAX_DRAW_LAG_CELLS` = 0.4 cells of each
//     other. Writing `u` for the exact separation of a pair and `v` for the
//     drawn one, `v = u + (lag_B - lag_A)` and each lag is at most 0.2, so
//     `dot(u, v) >= |u|^2 - 0.4|u| > 0` whenever `|u| > 0.4`. Measured on the
//     demo board, no pair ever inverts (`test/carSmoothing.test.ts`), and the
//     pairs that get inside 0.4 cells at all are the opposite-lane ones the sim
//     ALREADY draws on top of each other — a known gap (M1f's; `roads.ts`'s
//     `LANE_OF_DIR` note owns it) that this code neither creates nor widens.
//   - **A discontinuity self-heals in one tick.** A route change, an erase
//     under an in-flight car or a restored snapshot moves `currXY` by an
//     unbounded distance; the clamp puts `drawCurrXY` within 0.2 cells of the
//     new position on the very next drain, with no special case and nothing to
//     forget. There is no separate teleport guard because the clamp IS one.
//
// ---------------------------------------------------------------------------
// A PAUSED CAR DOES NOT SETTLE, AND M1f GIVES THAT ITS FIRST LONG-LIVED
// AUDIENCE
// ---------------------------------------------------------------------------
//
// The chase advances inside `afterDrain`, and `loop.ts` skips the whole drain
// while paused — so **a paused car stops wherever the chase had got to, short
// of its sim position, and stays there.** It does not converge; there is no
// frame on which it could.
//
// **The reference frame matters, because two different divergence figures live
// in this repo and they are not comparable.** This one is the gap between the
// DRAWN position and the SIM position at the moment the pause lands. It is NOT
// the mid-frame `drawCar`-against-`lerpCar` divergence in the table above
// (0.9920 cells, 4.96x `MAX_DRAW_LAG_CELLS`, on the every-frame-drains-7-ticks
// schedule), which is a different quantity and must not be quoted here.
//
// Measured, on the demo board with 15+ cars in flight, at the two cadences the
// repo drives: **0.0886 cells on even 33.4 ms frames and 0.2200 through
// `integration.test.ts`'s mixed-length rig.**
//
// **0.2200 is ABOVE `MAX_DRAW_LAG_CELLS`, and a bound of 0.2 here would be
// wrong** — that clamp holds between `drawCurrXY` and the sim position at a
// DRAIN, and a frozen frame is a lerp at the frozen `alpha` between
// `drawPrevXY` and `drawCurrXY`, so the residual depends on the frame cadence
// at the instant of the pause. The bound that holds for both readings is
// `MAX_DRAW_LAG_CELLS + MAX_SIM_CELLS_PER_TICK` = **0.3333** — one lag plus one
// tick of travel — and it is asserted rather than argued at two sites in
// `integration.test.ts` (the shutdown freeze, and M1f Task 7's offer pause).
//
// **Until M1f the only pauses were a HUD-clock tap and the terminal freeze;
// from M1f Task 7 the weekly card modal holds one for as long as the player
// takes to choose — four times on a run that reaches week 4.** So a frozen
// offset of up to 0.22 cells, about 6 CSS px at the smallest tile size
// `fitCamera` produces, is on screen for seconds at a time rather than for a
// frame.
//
// **Not fixed here, and the reason is a property this file would have to give
// up.** Converging while paused means advancing the chase with `ticks = 0`,
// which is a drawn position moving while the sim's does not — and that gives
// up "a drawn car is never ahead of its sim car", which is what the clamp and
// the ordering guarantees above are for. What makes it acceptable meanwhile is
// measured rather than assumed: 0.22 is well inside a cell's half-width of
// 0.5, so **every frozen car is still drawn on its own road**, which is the
// assertion the two sites carry beside the band. Task 12's device session is
// the instrument for whether it reads as a stop or as a stutter.
//
// **Nothing here allocates.** Three more caller-owned typed arrays, sized at
// boot, written in place forever after.

/**
 * The largest distance, in cells, any car can cover in one tick.
 *
 * Derived from the sim rather than copied: a car gains at most
 * `speedUnits(LANE_SPEED_DEFAULT)` = 330 progress units per tick against a
 * threshold of `edgeCost(dir) * COST_UNIT_SCALE`, and the DIAGONAL edge is the
 * faster of the two in Euclidean terms — 330/3500 of a `(1, 1)` step is
 * 0.13333 cells against 330/2500 = 0.132 orthogonally. Both appear below and
 * the maximum is the one the bound has to survive.
 */
export const MAX_SIM_CELLS_PER_TICK = Math.max(
  speedUnits(LANE_SPEED_DEFAULT) / (ORTHO_COST * COST_UNIT_SCALE),
  (speedUnits(LANE_SPEED_DEFAULT) * Math.SQRT2) / (DIAG_COST * COST_UNIT_SCALE),
)

/**
 * How much the DRAWN speed may change in one tick, in cells per tick.
 *
 * **Derived from a speed step the board already shows, which is the whole
 * calibration argument.** `laneSpeedMul` drops a car from
 * `speedUnits(LANE_SPEED_DEFAULT)` = 330 to `speedUnits(RIGHT_ANGLE_SPEED_MUL)`
 * = 220 units the moment it enters a plain right-angle cell, and that 110-unit
 * step — 0.044 cells/tick, 1.32 cells/s — lands on the demo board's dogleg
 * several times a second today with nobody remarking on it. Smoothing that
 * produces velocity changes no larger than one the sim already produces cannot
 * introduce a new kind of jerk; it can only remove one.
 *
 * It is used for both halves of the chase — the acceleration limit and the
 * catch-up overspeed allowance — deliberately, and not to save a constant. The
 * catch-up ENDS with the drawn speed dropping back to the sim's, and that drop
 * is a velocity step like any other: allowing an overspeed larger than the
 * acceleration limit would smooth the launch and then re-introduce the jerk at
 * the far end of the same transient.
 */
export const DRAW_SPEED_STEP_CELLS_PER_TICK =
  (speedUnits(LANE_SPEED_DEFAULT) - speedUnits(RIGHT_ANGLE_SPEED_MUL)) / (ORTHO_COST * COST_UNIT_SCALE)

/**
 * The hard ceiling on how far behind the sim position a car may be drawn, in
 * cells. Clamped every tick, so it bounds the divergence unconditionally.
 *
 * **One and a half ticks of travel at the game's top speed — 0.2000 cells — and
 * the factor is chosen against the free ramp's own peak.** Accelerating from
 * rest at `DRAW_SPEED_STEP` per tick against `v = MAX_SIM_CELLS_PER_TICK`, the
 * drawn speed goes 0.044, 0.088, 0.132, 0.177 and the shortfall accumulates to
 * **0.13602 cells** on the third tick before the catch-up allowance turns it
 * around. (The continuous estimate `v^2 / 2a` gives 0.198 and the "discrete
 * saves v/2" correction gives 0.135; neither is the number, because the cap is
 * `v + step` rather than `v`. `test/carSmoothing.test.ts` replays the rule
 * itself rather than any of the three closed forms.) A ceiling BELOW the peak
 * would truncate every launch — the car would ramp for two ticks and then jump,
 * which is the defect again with extra steps. A ceiling far above it would make
 * the clamp unfalsifiable, since nothing on the manifold would ever reach it.
 * 1.5 ticks is 1.47x the ramp's own peak: the clamp fires only on a
 * discontinuity, and it fires there on the first tick.
 *
 * It is also 0.4x a car sprite (`CAR_SIZE_FRACTION` = 0.5) and 0.23x the
 * smallest gap two queued cars can have (a refused car holds `carProgress` in
 * `[threshold - speed, threshold)`, so two cars stopped nose to tail are at
 * least `1 - 330/2500 = 0.868` cells apart).
 */
export const MAX_DRAW_LAG_CELLS = 1.5 * MAX_SIM_CELLS_PER_TICK

/**
 * The two resolved snapshots the frame lerps between, indexed by CAR SLOT.
 *
 * `prevXY`/`currXY` hold the EXACT sim position, 2 floats per slot;
 * `prevLive`/`currLive` hold one byte per slot. `prevLive` is the whole of the
 * snap rule — see the module comment.
 *
 * `drawPrevXY`/`drawCurrXY`/`drawSpeed` are the smoothed position the frame
 * actually draws and the drawn speed that produced it, in cells per tick. They
 * are advanced by `snapshotCurr` and read by `drawCar`; nothing else writes
 * them.
 *
 * **`drawLive` is not a duplicate of `currLive`, and the difference is one
 * drain wide.** `prevLive`/`currLive` are resolved from `state` on every
 * `snapshotPrev`/`snapshotCurr`; `drawLive` records whether the slot had a
 * drawn position at the END of the previous drain, which is the only history
 * the chase can start from. A house placed BETWEEN two frames is live in both
 * of the next drain's snapshots — `prevLive` reads 1 — while its drawn slot has
 * never been written, and chasing from an unwritten `Float32Array` streaks the
 * new car in from grid cell (0, 0). That is `initCarSnapshots`'s defect
 * reappearing for every car placed after boot, and it is what this byte is for.
 */
export interface CarSnapshots {
  readonly slots: number
  readonly prevXY: Float32Array
  readonly currXY: Float32Array
  readonly prevLive: Uint8Array
  readonly currLive: Uint8Array
  readonly drawPrevXY: Float32Array
  readonly drawCurrXY: Float32Array
  readonly drawSpeed: Float32Array
  readonly drawLive: Uint8Array
}

/** Allocates the snapshot buffers once, at boot. `slots` is `state.carPhase.length`. */
export function createCarSnapshots(slots: number): CarSnapshots {
  return {
    slots,
    prevXY: new Float32Array(slots * 2),
    currXY: new Float32Array(slots * 2),
    prevLive: new Uint8Array(slots),
    currLive: new Uint8Array(slots),
    drawPrevXY: new Float32Array(slots * 2),
    drawCurrXY: new Float32Array(slots * 2),
    drawSpeed: new Float32Array(slots),
    drawLive: new Uint8Array(slots),
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

/**
 * Advances every live slot's DRAWN position one drain's worth toward its
 * freshly-resolved sim position. `ticks` is how many ticks the drain ran, which
 * is this function's whole clock — see the module comment for why it is the
 * sim's and not the display's.
 *
 * Four rules, in the order the code applies them:
 *
 *   1. **A slot with no drawn history, or no exact prev, snaps.** Both arms are
 *      needed and each has a case the other misses. `drawLive === 0` is the
 *      reachable one — a house placed between two frames (`frame.test.ts` drives
 *      it), where `prevLive` reads 1 and the drawn slot has never been written.
 *      `prevLive === 0` is the slot that became live INSIDE a `step`.
 *      **REACHED: M1e Task 5's spawner produces it, measured at tick 360 on
 *      `firstCity`** — this used to read "which `step`'s seven phases cannot
 *      produce today and M1e's in-`step` spawner will". The branch was already
 *      written and already correct (it snaps), and `resolve.test.ts` still
 *      drives it by direct call because that is the sharper test. What changed
 *      is that it stopped being a defensive branch and became a PRODUCTION
 *      path: nobody may delete it on the strength of its own survival, and a
 *      mutation of it now has a real player-visible consequence — a car
 *      streaking in from wherever the slot's unwritten float happened to be.
 *      The rule lives HERE rather than in `drawCar` so there is exactly one
 *      copy of it with exactly one mutation target.
 *   2. **The drawn speed moves by at most one step per tick, and may exceed the
 *      sim's own speed by at most one step.** `vs` is read as the length of the
 *      last tick's sim displacement rather than recomputed from `carProgress`
 *      and a lane multiplier: the snapshots already hold it, and re-deriving it
 *      would be a second copy of `advanceCar`'s arithmetic in the renderer.
 *   3. **The step never passes the sim position.** This is what makes the lag
 *      one-sided, and it is also what makes the convergence exact rather than
 *      asymptotic: the moment the drawn car can reach `currXY` within the tick,
 *      it lands on it and the divergence is 0, not 1e-6.
 *   4. **The step never leaves more than `MAX_DRAW_LAG_CELLS` behind.** The
 *      unconditional bound, and the only thing standing between a teleport and
 *      a car sliding across the board.
 */
function advanceDraw(snap: CarSnapshots, ticks: number): void {
  const slots = snap.slots
  const step = DRAW_SPEED_STEP_CELLS_PER_TICK * ticks
  for (let i = 0; i < slots; i++) {
    if ((snap.currLive[i] as number) === 0) {
      snap.drawLive[i] = 0
      continue
    }
    const j = i * 2
    const sx = snap.currXY[j] as number
    const sy = snap.currXY[j + 1] as number
    const hadHistory = (snap.drawLive[i] as number) === 1
    snap.drawLive[i] = 1

    if (!hadHistory || (snap.prevLive[i] as number) === 0) {
      snap.drawPrevXY[j] = sx
      snap.drawPrevXY[j + 1] = sy
      snap.drawCurrXY[j] = sx
      snap.drawCurrXY[j + 1] = sy
      snap.drawSpeed[i] = 0
      continue
    }

    const dx = snap.drawCurrXY[j] as number
    const dy = snap.drawCurrXY[j + 1] as number
    snap.drawPrevXY[j] = dx
    snap.drawPrevXY[j + 1] = dy

    const px = snap.prevXY[j] as number
    const py = snap.prevXY[j + 1] as number
    const simDx = sx - px
    const simDy = sy - py
    const simSpeed = Math.sqrt(simDx * simDx + simDy * simDy)

    const ex = sx - dx
    const ey = sy - dy
    const gap = Math.sqrt(ex * ex + ey * ey)

    // `step` is the allowance for the WHOLE drain and `cap` is a speed, so only
    // the first scales with `ticks`. Dropping the `* ticks` from `step` makes a
    // seven-tick catch-up burst accelerate as gently as a one-tick frame and
    // leaves every car trailing on resume; scaling `cap` instead would let the
    // drawn car outrun the sim by seven steps.
    const cap = simSpeed + DRAW_SPEED_STEP_CELLS_PER_TICK
    let speed = (snap.drawSpeed[i] as number) + step
    if (speed > cap) speed = cap
    let travel = speed * ticks
    if (travel > gap) travel = gap
    else if (gap - travel > MAX_DRAW_LAG_CELLS) travel = gap - MAX_DRAW_LAG_CELLS
    snap.drawSpeed[i] = travel / ticks

    if (gap > 0) {
      const k = travel / gap
      snap.drawCurrXY[j] = dx + ex * k
      snap.drawCurrXY[j + 1] = dy + ey * k
    }
  }
}

/**
 * Resolves the post-step snapshot and advances the drawn position with it.
 * Called once after a drain that ran `ticks >= 1` ticks.
 *
 * **The two halves are one call on purpose.** The drawn position must advance
 * exactly once per drain, by exactly the drain's tick count, against exactly
 * the `currXY` this call just wrote; a separate `advanceCarDraw(snap, ticks)`
 * would be three ways for a caller to get that wrong and no compile error for
 * any of them. `blocking.ts`'s `noteEntryRefused`/`noteEntryGranted` pair is
 * this codebase's precedent for the shape.
 */
export function snapshotCurr(
  snap: CarSnapshots,
  state: GameState,
  world: WorldData,
  ticks: number,
): void {
  snapshotInto(state, world, snap.slots, snap.currXY, snap.currLive)
  advanceDraw(snap, ticks)
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
  snapshotCurr(snap, state, world, 1)
  // **The drawn state needs no seeding of its own, and the first draft's
  // seeding loop was a measured 0-detector.** `createCarSnapshots` leaves
  // `drawLive` all zero, so the `advanceDraw` inside the `snapshotCurr` above
  // takes its no-history arm for every live slot and writes exactly what a
  // seeding loop would: both drawn snapshots at the resolved position, drawn
  // speed 0. Adding a second copy on top made the two INDEPENDENTLY SUFFICIENT,
  // and neither could then have a detector — `for (let i = 0; i < 0; i++)`
  // applied to the loop passed all 544 tests. One rule, one place.
}

/**
 * Writes car slot `i`'s EXACT interpolated sim position into `out[offset]`,
 * `out[offset + 1]`.
 *
 * The caller has already established that the slot is live in `curr`; a slot
 * that is not live in `prev` snaps, everything else lerps.
 *
 * **This stopped being the frame path when the launch smoothing landed, and it
 * is deliberately still here.** `buildFrame` draws `drawCar`; what this
 * function returns is where the sim says the car is, which is the thing the
 * drawn position is bounded against, converges to, and is compared with in
 * every assertion in `test/carSmoothing.test.ts`. An oracle with no production
 * caller is worth keeping when the production code's whole contract is stated
 * relative to it — and it is a handful of arithmetic that Vite tree-shakes out
 * of the bundle.
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

/**
 * Writes car slot `i`'s DRAWN frame position into `out[offset]`,
 * `out[offset + 1]` — the position `buildFrame` puts in `RenderFrame.carXY`.
 *
 * The same lerp as `lerpCar`, over the smoothed pair instead of the exact one,
 * so that everything Decision 2 established about interpolating between two
 * resolved samples — convexity, no overshoot, a corner cut rather than a
 * corner miss — still holds of the thing on screen.
 *
 * **There is deliberately no `prevLive` branch here, and it is not an
 * omission.** `advanceDraw` writes `drawPrevXY = drawCurrXY` for exactly the
 * slots `lerpCar` would snap, so the branch would be a second, independently
 * sufficient copy of a rule that already has a home — and by this repo's own
 * catalogue, two independently sufficient structures leave NEITHER with a
 * detector. One rule, one place, one mutation target.
 */
export function drawCar(
  snap: CarSnapshots,
  i: number,
  alpha: number,
  out: Float32Array,
  offset: number,
): void {
  const j = i * 2
  const px = snap.drawPrevXY[j] as number
  const py = snap.drawPrevXY[j + 1] as number
  out[offset] = px + ((snap.drawCurrXY[j] as number) - px) * alpha
  out[offset + 1] = py + ((snap.drawCurrXY[j + 1] as number) - py) * alpha
}
