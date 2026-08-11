import { describe, it, expect } from 'vitest'
import {
  firstCity,
  COST_UNIT_SCALE,
  DIAG_COST,
  LANE_SPEED_DEFAULT,
  ORTHO_COST,
  REVEALED_H,
  REVEALED_W,
  REVEALED_X0,
  REVEALED_Y0,
  RIGHT_ANGLE_SPEED_MUL,
} from '@laneways/shared'
import {
  createFieldInputRanges,
  createFlowFields,
  createScratch,
  createState,
  createWorld,
  packRouteStep,
  speedUnits,
  PHASE_IDLE,
  PHASE_NONE,
  PHASE_OUTBOUND,
  type GameState,
  type WorldData,
} from '@laneways/sim'
import { fitCamera, CAR_SIZE_FRACTION, type AtlasContext, type AtlasSurface } from '@laneways/render'
import { buildFrame, createFrameBuilder, createFrameDriver } from '../src/frame'
import {
  createCarSnapshots,
  initCarSnapshots,
  snapshotPrev,
  snapshotCurr,
  lerpCar,
  drawCar,
  DRAW_SPEED_STEP_CELLS_PER_TICK,
  MAX_DRAW_LAG_CELLS,
  MAX_SIM_CELLS_PER_TICK,
  type CarSnapshots,
} from '../src/resolve'
import { createGame, type GameContext } from '../src/main'
import { DEMO_LAYOUT_ID } from '../src/layouts'

/**
 * **The car-launch smoothing: the bound, the convergence, and the proof that it
 * cannot lie about blocking.**
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR, MEASURED BEFORE AND AFTER
 * ---------------------------------------------------------------------------
 *
 * `advanceCar` holds `carProgress` bit-identical on a refused tick, so a
 * blocked car's two snapshots agree, `lerpCar` renders it perfectly still, and
 * on the granting tick it resumes at a whole tick's `speedUnits(...)`. On the
 * demo board, 60 s at 60 fps, over 86,400 car-frames:
 *
 * | measured                                    | exact `lerpCar` | smoothed  |
 * |---------------------------------------------|-----------------|-----------|
 * | largest per-frame speed INCREASE (cells/fr)  | 0.0660          | **0.0220**|
 * | ...as an acceleration                        | 237.6 cells/s^2 | 79.2      |
 * | largest per-frame speed DECREASE (cells/fr)  | 0.0660          | 0.0880    |
 * | ...frames where the decrease exceeds 0.0660  | 0               | **1**     |
 * | 99th percentile decrease                     | 0.0660          | 0.0660    |
 * | max divergence from the sim position (cells) | 0 by definition | 0.132     |
 * | frames drawn EXACTLY at the sim position     | 100 %           | 95.4 %    |
 *
 * **The launch is 3x softer and the stop is unchanged except once a minute, and
 * both halves of that trade are deliberate.** `resolve.ts` proves that bounded
 * deceleration, zero steady-state error and never-drawing-a-car-ahead-of-itself
 * are jointly unsatisfiable, so the stop CANNOT be smoothed from here; the one
 * frame in 60 s that decelerates harder than the sim does is a car that was
 * still closing its catch-up when it was refused, and its cost is one frame in
 * 86,400 against 8,383 softened accelerations.
 *
 * ---------------------------------------------------------------------------
 * WHAT EACH SECTION IS FOR
 * ---------------------------------------------------------------------------
 *
 * 1. The chase's arithmetic, on hand-written states where every number is
 *    derivable — the mutation targets for the ramp, the cap, both clamps and
 *    both snap arms.
 * 2. The bound and the convergence, on the board that ships, over a long run.
 * 3. That it cannot lie about blocking: no pair of cars is ever drawn in the
 *    wrong order, and smoothing draws no more overlapping pairs than the exact
 *    renderer does.
 * 4. That the artifact is actually gone — a treatment/control on one run, since
 *    a smoothing that changes no measured number is the whole point being
 *    missed.
 *
 * **Sections 2-4 all read the SAME run twice**, exact and smoothed, rather than
 * comparing against figures recorded in a comment. A per-frame number is a
 * property of the driver that produced it (this repo's catalogue records that
 * twice), so every claim here is a delta measured inside one test.
 */

const GRID_W = 24
const ORTHO_THRESHOLD = ORTHO_COST * COST_UNIT_SCALE
const FULL_SPEED_UNITS = speedUnits(LANE_SPEED_DEFAULT)
/** One tick of orthogonal travel at the default lane speed: 330 / 2500. */
const ORTHO_CELLS_PER_TICK = FULL_SPEED_UNITS / ORTHO_THRESHOLD

function cellOf(x: number, y: number): number {
  return y * GRID_W + x
}

interface Fixture {
  readonly state: GameState
  readonly world: WorldData
  readonly snap: CarSnapshots
}

/**
 * One car in slot 0, outbound, heading EAST out of (11, 12) along a straight
 * four-step route, at `progress` units into the edge.
 *
 * Straight and orthogonal on purpose: every position is `11 + progress/2500`,
 * so the assertions below are arithmetic rather than fixture archaeology, and
 * the one turning case gets its own fixture in `frame.test.ts`.
 *
 * **The route is 20 steps long and only ~4 of them are ever driven**, which is
 * not slack for its own sake. At `cursor >= carRouteLen` `resolveCar` takes its
 * exhausted-route fallback and returns the CELL CENTRE, so a route that runs
 * out mid-fixture teleports the resolved position backwards by up to a cell and
 * every convergence assertion downstream reads as a smoothing defect. The first
 * draft of this file used four steps and 40 ticks, and that is exactly what it
 * looked like.
 */
const FIXTURE_ROUTE_LEN = 20

function eastboundFixture(progress: number): Fixture {
  const map = firstCity()
  const world = createWorld(map)
  const state = createState('car-smoothing', map)
  state.carPhase[0] = PHASE_OUTBOUND
  state.carCell[0] = cellOf(11, 12)
  state.carProgress[0] = progress
  state.carRouteCursor[0] = 0
  state.carRouteLen[0] = FIXTURE_ROUTE_LEN
  for (let k = 0; k < FIXTURE_ROUTE_LEN; k++) packRouteStep(state, 0, k, 2 /* E */)
  const snap = createCarSnapshots(state.carPhase.length)
  initCarSnapshots(snap, state, world)
  return { state, world, snap }
}

/** One tick of ordinary eastbound movement, applied exactly as `advanceCar` does. */
function driveOneTick(f: Fixture): void {
  snapshotPrev(f.snap, f.state, f.world)
  let p = (f.state.carProgress[0] as number) + FULL_SPEED_UNITS
  if (p >= ORTHO_THRESHOLD) {
    p -= ORTHO_THRESHOLD
    f.state.carCell[0] = (f.state.carCell[0] as number) + 1
    f.state.carRouteCursor[0] = (f.state.carRouteCursor[0] as number) + 1
  }
  f.state.carProgress[0] = p
  snapshotCurr(f.snap, f.state, f.world, 1)
}

/** One REFUSED tick: `advanceCar` writes nothing at all to the car's movement state. */
function blockOneTick(f: Fixture): void {
  snapshotPrev(f.snap, f.state, f.world)
  snapshotCurr(f.snap, f.state, f.world, 1)
}

function drawnAt(snap: CarSnapshots, i: number, alpha: number): [number, number] {
  const out = new Float32Array(2)
  drawCar(snap, i, alpha, out, 0)
  return [out[0] as number, out[1] as number]
}

function exactAt(snap: CarSnapshots, i: number, alpha: number): [number, number] {
  const out = new Float32Array(2)
  lerpCar(snap, i, alpha, out, 0)
  return [out[0] as number, out[1] as number]
}

/** The drawn position at the tick boundary — `drawCurrXY`, which is `drawCar` at alpha 1. */
function drawnX(snap: CarSnapshots, i: number): number {
  return snap.drawCurrXY[i * 2] as number
}

// ---------------------------------------------------------------------------
// 1. The chase's arithmetic
// ---------------------------------------------------------------------------

describe('the launch ramp', () => {
  it('takes three ticks to reach the sim’s speed where the exact renderer takes one', () => {
    // A car that has been standing still and is granted entry. The exact
    // renderer's very first tick is a full 0.132-cell step; the drawn one
    // climbs by one `DRAW_SPEED_STEP` a tick — 0.044, 0.088, 0.132 — and only
    // then matches.
    const f = eastboundFixture(0)
    blockOneTick(f) // establishes a standstill: drawSpeed is 0
    expect(f.snap.drawSpeed[0] as number).toBe(0)

    const drawnSteps: number[] = []
    const exactSteps: number[] = []
    let lastDrawn = drawnX(f.snap, 0)
    let lastExact = f.snap.currXY[0] as number
    for (let t = 0; t < 4; t++) {
      driveOneTick(f)
      const d = drawnX(f.snap, 0)
      const e = f.snap.currXY[0] as number
      drawnSteps.push(d - lastDrawn)
      exactSteps.push(e - lastExact)
      lastDrawn = d
      lastExact = e
    }

    for (const step of exactSteps) expect(step).toBeCloseTo(ORTHO_CELLS_PER_TICK, 6)
    expect(drawnSteps[0]).toBeCloseTo(DRAW_SPEED_STEP_CELLS_PER_TICK, 6)
    expect(drawnSteps[1]).toBeCloseTo(2 * DRAW_SPEED_STEP_CELLS_PER_TICK, 6)
    expect(drawnSteps[2]).toBeCloseTo(3 * DRAW_SPEED_STEP_CELLS_PER_TICK, 6)
    // 3 x 0.044 = 0.132 = the sim's own step, so the fourth tick is the first
    // one that can also spend the catch-up allowance.
    expect(3 * DRAW_SPEED_STEP_CELLS_PER_TICK).toBeCloseTo(ORTHO_CELLS_PER_TICK, 6)
    expect(drawnSteps[3]).toBeCloseTo(ORTHO_CELLS_PER_TICK + DRAW_SPEED_STEP_CELLS_PER_TICK, 6)
  })

  it('never changes the drawn speed by more than one step in a tick, over a whole edge', () => {
    // The property the ramp exists to give, asserted as a property rather than
    // as the four numbers above: no tick-to-tick change in the drawn step
    // exceeds `DRAW_SPEED_STEP`, launch and catch-up included.
    const f = eastboundFixture(0)
    blockOneTick(f)
    let last = drawnX(f.snap, 0)
    let lastStep = 0
    let maxChange = 0
    for (let t = 0; t < 30; t++) {
      driveOneTick(f)
      const d = drawnX(f.snap, 0)
      const step = d - last
      maxChange = Math.max(maxChange, Math.abs(step - lastStep))
      last = d
      lastStep = step
    }
    expect(maxChange).toBeLessThanOrEqual(DRAW_SPEED_STEP_CELLS_PER_TICK + 1e-6)
    // Vacuity: the car really did get up to speed, so `maxChange` is the max of
    // something that moved rather than of a row of zeros.
    expect(lastStep).toBeCloseTo(ORTHO_CELLS_PER_TICK, 5)
  })

  it('converges to the sim position EXACTLY, and then stays there tick after tick', () => {
    const f = eastboundFixture(0)
    blockOneTick(f)
    let converged = -1
    for (let t = 0; t < 30; t++) {
      driveOneTick(f)
      if (converged < 0 && drawnX(f.snap, 0) === (f.snap.currXY[0] as number)) converged = t
    }
    // Four cells of travel, well short of the 20-step route.
    expect(f.state.carRouteCursor[0] as number).toBeLessThan(FIXTURE_ROUTE_LEN)
    // Not "within an epsilon": the step is clamped to the remaining gap, so the
    // drawn position lands on the sim position bit for bit and the divergence
    // is 0 rather than 1e-7. An asymptotic chase would never satisfy this.
    expect(converged, 'the drawn position never reached the sim position').toBeGreaterThanOrEqual(0)
    expect(converged).toBeLessThan(12)
    expect(drawnX(f.snap, 0)).toBe(f.snap.currXY[0] as number)
    expect(f.snap.drawPrevXY[0] as number).toBe(f.snap.prevXY[0] as number)
    // ...and at every alpha, not only at the tick boundary.
    for (const alpha of [0, 0.25, 0.5, 0.75, 0.999999]) {
      expect(drawnAt(f.snap, 0, alpha)).toEqual(exactAt(f.snap, 0, alpha))
    }
  })

  it('is behind the sim position while it ramps, never ahead of it', () => {
    const f = eastboundFixture(0)
    blockOneTick(f)
    let sawLag = false
    for (let t = 0; t < 30; t++) {
      driveOneTick(f)
      const lag = (f.snap.currXY[0] as number) - drawnX(f.snap, 0)
      expect(lag, `tick ${t} drew the car AHEAD of the sim`).toBeGreaterThanOrEqual(0)
      expect(lag).toBeLessThanOrEqual(MAX_DRAW_LAG_CELLS)
      if (lag > 0) sawLag = true
    }
    expect(sawLag, 'nothing ever lagged — the fixture never engaged the smoothing').toBe(true)
  })

  it('holds the car dead still while it is blocked, exactly as the sim does', () => {
    // The smoothing must not invent motion on a refused tick: the sim writes
    // nothing, and a chase that had already converged has nothing to chase.
    const f = eastboundFixture(0)
    for (let t = 0; t < 20; t++) driveOneTick(f)
    const before = drawnX(f.snap, 0)
    expect(before).toBe(f.snap.currXY[0] as number)
    for (let t = 0; t < 10; t++) {
      blockOneTick(f)
      expect(drawnX(f.snap, 0)).toBe(before)
      expect(f.snap.drawSpeed[0] as number).toBe(0)
    }
  })

  it('coasts the residual lag in when the sim stops mid-catch-up, and stops there', () => {
    // A car refused entry while still catching up: the drawn position finishes
    // the lag it owed and then holds. This is the ONLY deceleration smoothing
    // available — see `resolve.ts`'s impossibility proof — and it is worth
    // pinning because it is also where the one hard stop a minute comes from.
    const f = eastboundFixture(0)
    blockOneTick(f)
    driveOneTick(f)
    driveOneTick(f)
    const stopX = f.snap.currXY[0] as number
    const before = drawnX(f.snap, 0)
    const lagOwed = stopX - before
    expect(lagOwed).toBeGreaterThan(0.05)

    blockOneTick(f)
    const afterOne = drawnX(f.snap, 0)
    expect(afterOne, 'the drawn car did not coast in at all').toBeGreaterThan(before)
    expect(afterOne, 'the drawn car coasted PAST the position the sim stopped at').toBeLessThanOrEqual(
      stopX,
    )

    // ...and then it is still, for as long as the block lasts, at exactly the
    // position the sim stopped at rather than a fraction short of it.
    for (let t = 0; t < 10; t++) blockOneTick(f)
    expect(drawnX(f.snap, 0)).toBe(stopX)
    expect(f.snap.drawSpeed[0] as number).toBe(0)
  })
})

describe('the bound, the cap and the two snap arms', () => {
  it('puts a teleported car within MAX_DRAW_LAG_CELLS in a single drain', () => {
    // A route change, an erase under an in-flight car and a restored snapshot
    // all move `currXY` by an unbounded distance with the slot still live.
    // There is no separate teleport guard: the clamp IS one, and this is what
    // makes that claim checkable.
    const f = eastboundFixture(0)
    for (let t = 0; t < 20; t++) driveOneTick(f)
    snapshotPrev(f.snap, f.state, f.world)
    f.state.carCell[0] = cellOf(3, 29) // 19 cells away, same slot, still live
    snapshotCurr(f.snap, f.state, f.world, 1)

    const gap = Math.hypot(
      (f.snap.currXY[0] as number) - drawnX(f.snap, 0),
      (f.snap.currXY[1] as number) - (f.snap.drawCurrXY[1] as number),
    )
    expect(gap).toBeLessThanOrEqual(MAX_DRAW_LAG_CELLS + 1e-6)
    // ...and it really was a teleport, not a drift the chase could have walked.
    expect(
      Math.hypot(
        (f.snap.currXY[0] as number) - (f.snap.prevXY[0] as number),
        (f.snap.currXY[1] as number) - (f.snap.prevXY[1] as number),
      ),
    ).toBeGreaterThan(10)
  })

  it('caps the drawn speed at the sim’s own speed plus one step, not at the gap', () => {
    // Without the cap the chase would close a large lag at whatever speed the
    // ramp had reached, which is how a bounded lag turns into a visible dash.
    // With it, the fastest a car can be drawn moving is one step above the sim.
    const f = eastboundFixture(0)
    for (let t = 0; t < 20; t++) driveOneTick(f)
    // Force a lag by moving the drawn position back by the full budget.
    f.snap.drawCurrXY[0] = (f.snap.drawCurrXY[0] as number) - MAX_DRAW_LAG_CELLS
    const before = drawnX(f.snap, 0)
    driveOneTick(f)
    const step = drawnX(f.snap, 0) - before
    expect(step).toBeLessThanOrEqual(
      ORTHO_CELLS_PER_TICK + DRAW_SPEED_STEP_CELLS_PER_TICK + 1e-6,
    )
    expect(step, 'the chase did not close any of the lag').toBeGreaterThan(ORTHO_CELLS_PER_TICK)
  })

  it('snaps a slot with no drawn history, even though it has an exact prev', () => {
    // The `drawLive === 0` arm. This is the reachable one — `frame.test.ts`
    // drives it through a real out-of-band `placeHouse` — and it is repeated
    // here at the unit level so the arm has a detector that does not depend on
    // a house-placement fixture.
    const f = eastboundFixture(0)
    for (let t = 0; t < 5; t++) driveOneTick(f)
    f.snap.drawLive[0] = 0
    f.snap.drawCurrXY[0] = 0 // the unwritten-Float32Array position: grid cell (0, 0)
    f.snap.drawCurrXY[1] = 0
    snapshotPrev(f.snap, f.state, f.world)
    expect(f.snap.prevLive[0] as number).toBe(1)
    snapshotCurr(f.snap, f.state, f.world, 1)

    expect(drawnX(f.snap, 0)).toBe(f.snap.currXY[0] as number)
    expect(f.snap.drawPrevXY[0] as number).toBe(f.snap.currXY[0] as number)
    expect(f.snap.drawSpeed[0] as number).toBe(0)
  })

  it('snaps a slot that became live INSIDE a step, which nothing in step can do yet', () => {
    // The `prevLive === 0` arm. `step`'s seven phases contain no spawner, so
    // this is unreachable in production today and M1e's in-`step` spawner is
    // what will reach it. Exercised directly rather than left as the one branch
    // nothing executes — `resolve.ts`'s `assertSingleCrossing` idiom.
    const f = eastboundFixture(0)
    for (let t = 0; t < 5; t++) driveOneTick(f)
    const j = 1 // a dead slot
    expect(f.state.carPhase[j] as number).toBe(PHASE_NONE)
    snapshotPrev(f.snap, f.state, f.world)
    expect(f.snap.prevLive[j] as number).toBe(0)
    // ...with drawn history from an earlier life, so `drawLive` cannot cover it.
    f.snap.drawLive[j] = 1
    f.snap.drawCurrXY[j * 2] = 0
    f.snap.drawCurrXY[j * 2 + 1] = 0
    f.state.carPhase[j] = PHASE_IDLE
    f.state.carCell[j] = cellOf(15, 26)
    snapshotCurr(f.snap, f.state, f.world, 1)

    expect(f.snap.currLive[j] as number).toBe(1)
    expect(drawnAt(f.snap, j, 0.5)).toEqual([15, 26])
  })

  it('clears the drawn history of a slot that dies, so its next life snaps', () => {
    const f = eastboundFixture(0)
    for (let t = 0; t < 5; t++) driveOneTick(f)
    expect(f.snap.drawLive[0] as number).toBe(1)
    f.state.carPhase[0] = PHASE_NONE
    snapshotPrev(f.snap, f.state, f.world)
    snapshotCurr(f.snap, f.state, f.world, 1)
    expect(f.snap.drawLive[0] as number).toBe(0)
  })
})

describe('the chase’s clock is the sim’s, not the display’s', () => {
  it('advances by the drain’s tick count, so a 2-tick drain ramps twice as far', () => {
    // `afterDrain(ticks)` is the whole reason `snapshotCurr` takes `ticks`.
    // Passing 1 regardless would make a car's acceleration a property of the
    // frame rate: 30 ticks a second arrive in 30 drains on a 120 Hz phone and
    // in 15 on a 20 Hz one.
    // One tick of sim motion, reported as one tick and as two. Reported as one
    // the chase spends one step's allowance and lags; reported as two it spends
    // two, which is more than the motion, so it lands exactly.
    const drainOf = (ticks: number): number => {
      const f = eastboundFixture(0)
      blockOneTick(f)
      snapshotPrev(f.snap, f.state, f.world)
      f.state.carProgress[0] = FULL_SPEED_UNITS
      snapshotCurr(f.snap, f.state, f.world, ticks)
      return drawnX(f.snap, 0) - 11
    }
    expect(drainOf(1)).toBeCloseTo(DRAW_SPEED_STEP_CELLS_PER_TICK, 6)
    expect(drainOf(2)).toBeCloseTo(ORTHO_CELLS_PER_TICK, 6)
    expect(drainOf(2)).toBeGreaterThan(drainOf(1))
  })

  it('leaves no lag at all after a catch-up burst, where a per-frame chase would', () => {
    // The 7-tick burst `MAX_FRAME_DT_MS` bounds a stalled tab at. Seven ticks of
    // acceleration allowance is far more than one tick of sim motion, so the
    // drawn position lands exactly on the sim position and the tab does not
    // resume with every car trailing.
    const f = eastboundFixture(0)
    for (let t = 0; t < 20; t++) driveOneTick(f)
    snapshotPrev(f.snap, f.state, f.world)
    f.state.carProgress[0] = (f.state.carProgress[0] as number) + FULL_SPEED_UNITS
    snapshotCurr(f.snap, f.state, f.world, 7)
    expect(drawnX(f.snap, 0)).toBe(f.snap.currXY[0] as number)
  })
})

describe('the frame path actually draws the smoothed position', () => {
  /**
   * **Without this, reverting `buildFrame` to `lerpCar` is nearly a no-op to the
   * suite.** Every assertion above reads `drawCar` directly, and the drawn and
   * the exact position agree on 95 % of frames, so most fixtures cannot tell
   * them apart. This one lands on a frame where they provably differ.
   */
  it('emits drawCar’s output in RenderFrame.carXY, not lerpCar’s', () => {
    const map = firstCity()
    const world = createWorld(map)
    const state = createState('car-smoothing-frame', map)
    const camera = fitCamera(M0_VIEW, {
      x0: REVEALED_X0,
      y0: REVEALED_Y0,
      cols: REVEALED_W,
      rows: REVEALED_H,
    })
    state.carPhase[0] = PHASE_OUTBOUND
    state.carCell[0] = cellOf(11, 12)
    state.carProgress[0] = 0
    state.carRouteCursor[0] = 0
    state.carRouteLen[0] = FIXTURE_ROUTE_LEN
    for (let k = 0; k < FIXTURE_ROUTE_LEN; k++) packRouteStep(state, 0, k, 2 /* E */)

    const builder = createFrameBuilder(state, world, camera)
    initCarSnapshots(builder.snapshots, state, world)
    const snap = builder.snapshots
    // One standstill tick, then one moving tick: mid-ramp, so the two differ.
    snapshotPrev(snap, state, world)
    snapshotCurr(snap, state, world, 1)
    snapshotPrev(snap, state, world)
    state.carProgress[0] = FULL_SPEED_UNITS
    snapshotCurr(snap, state, world, 1)

    const frame = buildFrame(builder, state, world, camera, 1, false)
    expect(frame.carCount).toBe(1)
    const drawn = drawnAt(snap, 0, 1)
    const exact = exactAt(snap, 0, 1)
    expect(exact[0]).not.toBeCloseTo(drawn[0], 6)
    expect(frame.carXY[0] as number).toBeCloseTo(drawn[0], 6)
    expect(frame.carXY[1] as number).toBeCloseTo(drawn[1], 6)
  })

  it('forwards the drain’s tick count from afterDrain into the chase', () => {
    // `createFrameDriver`'s `afterDrain(ticks)` is the only place the drain
    // length reaches `snapshotCurr`. Ignoring the parameter and passing 1
    // compiles, passes every unit test that calls `snapshotCurr` itself, and
    // makes a car's acceleration a property of the display's frame rate.
    const advanceWith = (ticks: number): number => {
      const map = firstCity()
      const world = createWorld(map)
      const state = createState('car-smoothing-driver', map)
      const camera = fitCamera(M0_VIEW, {
        x0: REVEALED_X0,
        y0: REVEALED_Y0,
        cols: REVEALED_W,
        rows: REVEALED_H,
      })
      state.carPhase[0] = PHASE_OUTBOUND
      state.carCell[0] = cellOf(11, 12)
      state.carProgress[0] = 0
      state.carRouteCursor[0] = 0
      state.carRouteLen[0] = FIXTURE_ROUTE_LEN
      for (let k = 0; k < FIXTURE_ROUTE_LEN; k++) packRouteStep(state, 0, k, 2 /* E */)
      const builder = createFrameBuilder(state, world, camera)
      initCarSnapshots(builder.snapshots, state, world)
      const scratch = createScratch(
        world.cells,
        map.groupCount,
        map.maxDestinations,
        createFieldInputRanges(map),
      )
      const driver = createFrameDriver({
        state,
        world,
        fields: createFlowFields(map.groupCount, world.cells),
        scratch,
        builder,
        camera: () => camera,
        draw: () => undefined,
        onGameOver: (): void => {
          throw new Error('the smoothing rig reached game over — the chase would then be measured frozen')
        },
      })
      driver.beforeStep()
      // The sim moves one tick's worth; the DRAIN is declared as `ticks`.
      state.carProgress[0] = FULL_SPEED_UNITS
      driver.afterDrain(ticks)
      return (builder.snapshots.drawCurrXY[0] as number) - 11
    }
    expect(advanceWith(1)).toBeCloseTo(DRAW_SPEED_STEP_CELLS_PER_TICK, 6)
    expect(advanceWith(2)).toBeCloseTo(ORTHO_CELLS_PER_TICK, 6)
  })
})

describe('the constants are derived from the sim, not chosen', () => {
  it('reads the speed step off the right-angle multiplier the board already shows', () => {
    expect(speedUnits(LANE_SPEED_DEFAULT)).toBe(330)
    expect(speedUnits(RIGHT_ANGLE_SPEED_MUL)).toBe(220)
    expect(DRAW_SPEED_STEP_CELLS_PER_TICK).toBeCloseTo(110 / 2500, 12)
    expect(DRAW_SPEED_STEP_CELLS_PER_TICK).toBeCloseTo(0.044, 12)
  })

  it('takes the top speed from the DIAGONAL edge, which is the faster of the two', () => {
    const ortho = 330 / (ORTHO_COST * COST_UNIT_SCALE)
    const diag = (330 * Math.SQRT2) / (DIAG_COST * COST_UNIT_SCALE)
    expect(diag).toBeGreaterThan(ortho)
    expect(MAX_SIM_CELLS_PER_TICK).toBe(diag)
    expect(MAX_SIM_CELLS_PER_TICK).toBeCloseTo(0.13334, 5)
  })

  it('sets the lag ceiling above the free ramp’s own peak, and says by how much', () => {
    // The discrete ramp's peak, replayed with the chase's OWN rule rather than
    // with the continuous `v^2 / 2a` estimate: speed rises by one step a tick,
    // capped at the sim's speed plus one step, and the lag is the shortfall.
    let peak = 0
    let speed = 0
    let lag = 0
    for (let n = 0; n < 20; n++) {
      speed = Math.min(
        speed + DRAW_SPEED_STEP_CELLS_PER_TICK,
        MAX_SIM_CELLS_PER_TICK + DRAW_SPEED_STEP_CELLS_PER_TICK,
      )
      lag = Math.max(0, lag + MAX_SIM_CELLS_PER_TICK - speed)
      peak = Math.max(peak, lag)
    }
    expect(peak).toBeCloseTo(0.136, 3)
    expect(MAX_DRAW_LAG_CELLS).toBeGreaterThan(peak)
    // Above the ramp so the clamp never truncates a launch, and not so far
    // above that nothing on the manifold could ever reach it.
    expect(MAX_DRAW_LAG_CELLS / peak).toBeCloseTo(1.47, 2)
    expect(MAX_DRAW_LAG_CELLS).toBeCloseTo(0.2, 4)
    // Smaller than a car sprite, and far smaller than the smallest gap two
    // queued cars can have (1 - 330/2500 = 0.868 cells).
    expect(MAX_DRAW_LAG_CELLS).toBeLessThan(CAR_SIZE_FRACTION)
    expect(MAX_DRAW_LAG_CELLS).toBeLessThan(1 - ORTHO_CELLS_PER_TICK)
  })
})

// ---------------------------------------------------------------------------
// 2-4. The demo board, exact and smoothed, measured in one run
// ---------------------------------------------------------------------------

function stubContext(): GameContext {
  return {
    fillStyle: '',
    // M1e Task 9's five: `DrawContext` grew what a stroked arc needs. Inert
    // here — this stub records nothing — but the five must EXIST or the package
    // does not compile.
    strokeStyle: '',
    lineWidth: 0,
    beginPath: () => undefined,
    arc: () => undefined,
    stroke: () => undefined,
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    setTransform: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    drawImage: () => undefined,
  }
}

function stubSurface(widthPx: number, heightPx: number): AtlasSurface {
  const context: AtlasContext = {
    lineWidth: 0,
    lineCap: 'round',
    lineJoin: 'round',
    globalAlpha: 1,
    strokeStyle: '',
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
  }
  return { width: widthPx, height: heightPx, getContext: () => context }
}

const M0_VIEW = {
  cssW: 406,
  cssH: 870,
  topInset: 46,
  bottomInset: 34,
  rawDpr: 3,
  performanceClass: null,
} as const

function demoGame(): ReturnType<typeof createGame> {
  return createGame({
    canvas: {
      width: 0,
      height: 0,
      style: { width: '', height: '' },
      getBoundingClientRect: () => ({ left: 11, top: 7 }),
    },
    context: stubContext(),
    createSurface: stubSurface,
    createFallback: () => null,
    measure: () => M0_VIEW,
    settle: (run: () => void) => {
      run()
    },
    layoutId: DEMO_LAYOUT_ID,
  })
}

const FPS = 60
const FRAME_MS = 1000 / FPS
/** 30 s of the busiest board in the repo, at 60 fps. */
const RUN_FRAMES = FPS * 30

interface Survey {
  /** Largest |drawn - exact| over every live car on every frame, in cells. */
  maxDivergence: number
  /** Fraction of car-frames drawn at exactly the sim position. */
  exactFraction: number
  /** Largest per-frame INCREASE in a car's drawn speed, cells/frame. */
  maxSpeedUp: number
  /** Largest per-frame DECREASE, cells/frame. */
  maxSpeedDown: number
  /** Largest per-frame drawn displacement, cells/frame. */
  maxSpeed: number
  /** Frames where a car went from a dead stop to more than half top speed in one frame. */
  standingStarts: number
  /** Pairs whose drawn order is reversed relative to the exact one. */
  inversions: number
  /** ...of those, the ones in different cells whose travel is codirectional. */
  queueInversions: number
  /** Largest exact separation at which any inversion happened, in cells. */
  maxInversionSeparation: number
  /** Pair-frames drawn closer together than one car sprite. */
  overlaps: number
  /** Pair-frames sampled, and live car-frames sampled. */
  pairSamples: number
  carSamples: number
  /** Pair-frames in different cells, codirectional, closer than one sprite. */
  nearQueuePairs: number
}

/**
 * Drives the demo board once and measures the exact and the smoothed renderer
 * side by side, on the identical frames.
 *
 * Both are read off the SAME `game`: `lerpCar` and `drawCar` are two views of
 * one set of snapshots, so there is no second run to drift and no chance of the
 * control and the treatment seeing different traffic.
 */
function survey(): { exact: Survey; smoothed: Survey } {
  const game = demoGame()
  const snap = game.builder.snapshots
  const slots = snap.slots
  const pos = [new Float32Array(slots * 2), new Float32Array(slots * 2)]
  const last = [new Float32Array(slots * 2), new Float32Array(slots * 2)]
  const lastSpeed = [new Float64Array(slots), new Float64Array(slots)]
  const tracked = new Uint8Array(slots)
  const blank = (): Survey => ({
    maxDivergence: 0,
    exactFraction: 0,
    maxSpeedUp: 0,
    maxSpeedDown: 0,
    maxSpeed: 0,
    standingStarts: 0,
    inversions: 0,
    queueInversions: 0,
    maxInversionSeparation: 0,
    overlaps: 0,
    pairSamples: 0,
    carSamples: 0,
    nearQueuePairs: 0,
  })
  const out: Survey[] = [blank(), blank()]
  let exactFrames = 0

  for (let f = 0; f < RUN_FRAMES; f++) {
    game.frame(1000 + (f + 1) * FRAME_MS)
    const alpha = game.loop.alpha

    for (let i = 0; i < slots; i++) {
      if ((snap.currLive[i] as number) === 0) {
        tracked[i] = 0
        continue
      }
      lerpCar(snap, i, alpha, pos[0] as Float32Array, i * 2)
      drawCar(snap, i, alpha, pos[1] as Float32Array, i * 2)
      const ex = pos[0] as Float32Array
      const dr = pos[1] as Float32Array
      const div = Math.hypot(
        (ex[i * 2] as number) - (dr[i * 2] as number),
        (ex[i * 2 + 1] as number) - (dr[i * 2 + 1] as number),
      )
      if (div > (out[1] as Survey).maxDivergence) (out[1] as Survey).maxDivergence = div
      if (div === 0) exactFrames++
      for (const v of [0, 1]) {
        const s = out[v] as Survey
        const p = pos[v] as Float32Array
        const l = last[v] as Float32Array
        s.carSamples++
        if ((tracked[i] as number) === 1) {
          const speed = Math.hypot(
            (p[i * 2] as number) - (l[i * 2] as number),
            (p[i * 2 + 1] as number) - (l[i * 2 + 1] as number),
          )
          const prev = (lastSpeed[v] as Float64Array)[i] as number
          s.maxSpeed = Math.max(s.maxSpeed, speed)
          if (speed > prev) s.maxSpeedUp = Math.max(s.maxSpeedUp, speed - prev)
          else s.maxSpeedDown = Math.max(s.maxSpeedDown, prev - speed)
          if (prev === 0 && speed > ORTHO_CELLS_PER_TICK / 4) s.standingStarts++
          ;(lastSpeed[v] as Float64Array)[i] = speed
        }
        l[i * 2] = p[i * 2] as number
        l[i * 2 + 1] = p[i * 2 + 1] as number
      }
      tracked[i] = 1
    }

    for (let i = 0; i < slots; i++) {
      if ((snap.currLive[i] as number) === 0) continue
      for (let k = i + 1; k < slots; k++) {
        if ((snap.currLive[k] as number) === 0) continue
        const ex = pos[0] as Float32Array
        const dr = pos[1] as Float32Array
        const ux = (ex[i * 2] as number) - (ex[k * 2] as number)
        const uy = (ex[i * 2 + 1] as number) - (ex[k * 2 + 1] as number)
        const vx = (dr[i * 2] as number) - (dr[k * 2] as number)
        const vy = (dr[i * 2 + 1] as number) - (dr[k * 2 + 1] as number)
        const sep = Math.hypot(ux, uy)
        // Two cars in the SAME cell in opposite lanes are drawn on top of each
        // other by the sim itself — the M1e gap `demoLayout.ts` §5 names. A
        // "queue pair" is the case ordering means anything for: different
        // cells, travelling the same way.
        const sameCell = (game.state.carCell[i] as number) === (game.state.carCell[k] as number)
        const codir =
          ((snap.currXY[i * 2] as number) - (snap.prevXY[i * 2] as number)) *
            ((snap.currXY[k * 2] as number) - (snap.prevXY[k * 2] as number)) +
            ((snap.currXY[i * 2 + 1] as number) - (snap.prevXY[i * 2 + 1] as number)) *
              ((snap.currXY[k * 2 + 1] as number) - (snap.prevXY[k * 2 + 1] as number)) >
          0
        const queuePair = !sameCell && codir
        ;(out[0] as Survey).pairSamples++
        ;(out[1] as Survey).pairSamples++
        if (sep < CAR_SIZE_FRACTION) (out[0] as Survey).overlaps++
        if (Math.hypot(vx, vy) < CAR_SIZE_FRACTION) (out[1] as Survey).overlaps++
        if (queuePair && sep < CAR_SIZE_FRACTION) (out[1] as Survey).nearQueuePairs++
        if (sep === 0) continue
        if (ux * vx + uy * vy < 0) {
          const s = out[1] as Survey
          s.inversions++
          if (queuePair) s.queueInversions++
          s.maxInversionSeparation = Math.max(s.maxInversionSeparation, sep)
        }
      }
    }
  }
  ;(out[1] as Survey).exactFraction = exactFrames / (out[1] as Survey).carSamples
  ;(out[0] as Survey).exactFraction = 1
  return { exact: out[0] as Survey, smoothed: out[1] as Survey }
}

const measured = survey()

describe('the bound, on the board that ships', () => {
  it('never draws a car further than MAX_DRAW_LAG_CELLS from where the sim says it is', () => {
    expect(measured.smoothed.maxDivergence).toBeLessThanOrEqual(MAX_DRAW_LAG_CELLS)
    // ...and the smoothing really engaged, or the bound is a bound on nothing.
    expect(measured.smoothed.maxDivergence).toBeGreaterThan(0.1)
    expect(measured.smoothed.carSamples).toBeGreaterThan(30_000)
  })

  it('draws the overwhelming majority of car-frames at exactly the sim position', () => {
    // Convergence is exact and it happens constantly: the divergence is not a
    // standing offset that the bound merely caps, it is a transient the chase
    // spends most of its time at zero of.
    expect(measured.smoothed.exactFraction).toBeGreaterThan(0.9)
    expect(measured.smoothed.exactFraction).toBeLessThan(1)
  })
})

describe('it cannot lie about blocking', () => {
  it('never reverses the drawn order of two cars queueing behind each other', () => {
    // The failure this rules out: a leader that has just been granted entry is
    // drawn behind its own follower because its launch lag pulled it back.
    // Zero over 30 s of the busiest board in the repo.
    expect(measured.smoothed.queueInversions).toBe(0)
    // Vacuity: there were plenty of pairs close enough for it to matter.
    expect(measured.smoothed.nearQueuePairs).toBeGreaterThan(100)
  })

  it('only ever reorders cars the sim itself is already drawing on top of each other', () => {
    // Some pairs DO reorder — two cars passing in opposite lanes of one cell,
    // where "which is in front" is not a fact about the world. The analytic
    // bound is that no pair separated by more than `2 * MAX_DRAW_LAG_CELLS`
    // can reorder at all, since each car moves by at most the lag; measured,
    // nothing beyond 0.12 cells does, which is well inside a car sprite.
    expect(measured.smoothed.maxInversionSeparation).toBeLessThan(2 * MAX_DRAW_LAG_CELLS)
    expect(measured.smoothed.maxInversionSeparation).toBeLessThan(CAR_SIZE_FRACTION)
  })

  it('draws no more overlapping pairs than the exact renderer does', () => {
    // The treatment/control that matters: 1.7 % of live pairs are already drawn
    // inside one sprite of each other by the exact renderer (opposite lanes of
    // one cell, and a follower entering the cell its leader just left). The
    // question is only whether smoothing adds to that. It does not — it removes
    // a few, because a lagging car is a car further from the one in front.
    expect(measured.smoothed.overlaps).toBeLessThanOrEqual(measured.exact.overlaps)
    expect(measured.exact.overlaps, 'no overlapping pairs at all — the fixture is too quiet')
      .toBeGreaterThan(1000)
  })
})

describe('the artifact is measurably gone', () => {
  it('cuts the largest per-frame acceleration by 3x against the exact renderer', () => {
    // THE headline. The exact renderer's worst per-frame speed increase is a
    // whole tick of top-speed travel appearing in one frame; the smoothed one's
    // is one `DRAW_SPEED_STEP`, which is the step the sim itself applies when a
    // car enters a right-angle cell.
    expect(measured.exact.maxSpeedUp).toBeCloseTo(ORTHO_CELLS_PER_TICK / 2, 4)
    expect(measured.smoothed.maxSpeedUp).toBeCloseTo(DRAW_SPEED_STEP_CELLS_PER_TICK / 2, 4)
    expect(measured.exact.maxSpeedUp / measured.smoothed.maxSpeedUp).toBeCloseTo(3, 1)
  })

  it('removes every standing start, where the exact renderer has hundreds', () => {
    // "Zero to full in one frame", counted. A car whose drawn speed goes from
    // exactly 0 to more than a quarter of top speed inside one frame.
    expect(measured.exact.standingStarts).toBeGreaterThan(100)
    expect(measured.smoothed.standingStarts).toBe(0)
  })

  it('leaves the worst deceleration where it was, which is the half that cannot be fixed', () => {
    // `resolve.ts` proves the stop cannot be smoothed without either drawing a
    // car ahead of itself or lagging it forever. What this pins is that it did
    // not get materially WORSE: the catch-up allowance lets a car be moving one
    // step above the sim's speed when it is refused, so the worst case rises by
    // exactly one step and nothing else does.
    expect(measured.exact.maxSpeedDown).toBeCloseTo(ORTHO_CELLS_PER_TICK / 2, 4)
    expect(measured.smoothed.maxSpeedDown).toBeLessThanOrEqual(
      (ORTHO_CELLS_PER_TICK + DRAW_SPEED_STEP_CELLS_PER_TICK) / 2 + 1e-6,
    )
  })

  it('never draws a car moving faster than the sim’s own speed plus one step', () => {
    // The cap, on a real board rather than on a hand-built lag. Without it the
    // chase closes a lag at whatever speed the ramp has reached, and a car that
    // was behind arrives in a visible dash.
    expect(measured.exact.maxSpeed).toBeCloseTo(ORTHO_CELLS_PER_TICK / 2, 4)
    expect(measured.smoothed.maxSpeed).toBeLessThanOrEqual(
      (MAX_SIM_CELLS_PER_TICK + DRAW_SPEED_STEP_CELLS_PER_TICK) / 2 + 1e-6,
    )
    // ...and the allowance is really spent, or the ceiling is a ceiling on
    // nothing: some car somewhere does exceed the sim's own top speed.
    expect(measured.smoothed.maxSpeed).toBeGreaterThan(measured.exact.maxSpeed)
  })
})
