import { describe, it, expect } from 'vitest'
import {
  firstCity,
  COST_UNIT_SCALE,
  ORTHO_COST,
  DIAG_COST,
  CAR_SPEED_UNITS_PER_TICK,
  MAX_PATH_LEN,
} from '@laneways/shared'
import {
  createState,
  createWorld,
  runMovement,
  canEnter,
  claimCell,
  EnterOutcome,
  packRouteStep,
  routeStep,
  edgeCost,
  DX,
  DY,
  OPPOSITE,
  PHASE_NONE,
  PHASE_IDLE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  type GameState,
  type WorldData,
} from '@laneways/sim'
import {
  resolveCar,
  createCarSnapshots,
  snapshotPrev,
  snapshotCurr,
  initCarSnapshots,
  lerpCar,
  type CarSnapshots,
} from '../src/resolve'

/**
 * The sub-cell position resolver and the two-snapshot lerp — plan Decision 2.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SUB-CELL TERM, AND WHY A LERP RATHER THAN AN EXTRAPOLATION
 * ---------------------------------------------------------------------------
 *
 * A car gains `speedUnits(LANE_SPEED_DEFAULT)` = 330 progress units per tick
 * against a threshold of `edgeCost(dir) * COST_UNIT_SCALE` — 2,500 orthogonal,
 * 3,500 diagonal. So `carCell` changes once every **2500/330 = 7.576 ticks**
 * orthogonally and **10.606** diagonally. A prev-cell -> curr-cell lerp renders
 * a car motionless for about 6.6 ticks and then smears a whole cell across one
 * 33 ms window: a 4 Hz strobe, worse than not interpolating at all. The sim
 * already stores the sub-cell term, so the resolver reads it.
 *
 * The frame position is a plain lerp of two RESOLVED snapshots. The
 * single-expression form `cell + dir * (progress + alpha * speed) / threshold`
 * agrees everywhere the car neither turns nor changes phase, and *extrapolates*
 * past the end of the current edge everywhere else — measured at up to 0.19
 * cells past a corner and 0.13 past the carpark at the outbound -> return flip.
 *
 * ---------------------------------------------------------------------------
 * THE UNITS ARE CELL CENTRES
 * ---------------------------------------------------------------------------
 *
 * An integer coordinate names a cell's CENTRE, matching `RenderFrame.carXY`'s
 * documented convention: a parked car resolves to `(cx, cy)` and a car half way
 * along an eastward edge to `(cx + 0.5, cy)`. `canvas.ts` draws a car centred at
 * `gridToScreen(gx, gy) + tileSize / 2`. Emitting top-left-corner units instead
 * would shift every car half a cell up and left, which reads as an art offset
 * rather than as a coordinate bug.
 */

const GRID_W = 24

// --- Hand-computed thresholds -----------------------------------------------

/** `ORTHO_COST * COST_UNIT_SCALE`. */
const ORTHO_THRESHOLD = 2500
/** `DIAG_COST * COST_UNIT_SCALE`. */
const DIAG_THRESHOLD = 3500

// --- Direction indices, hand-read off `roads.ts:92-95` ----------------------

const N = 0
const NE = 1
const E = 2
const SE = 3
const S = 4
const W = 6
const NW = 7

interface Rig {
  readonly world: WorldData
  readonly state: GameState
  readonly slots: number
}

function rig(): Rig {
  const map = firstCity()
  const world = createWorld(map)
  const state = createState('m2-resolve', map)
  return { world, state, slots: state.carPhase.length }
}

interface CarSpec {
  readonly phase: number
  readonly cell: number
  readonly progress?: number
  readonly cursor?: number
  readonly routeLen?: number
  readonly route?: readonly number[]
}

/** Writes one car slot by hand. Every field is explicit; nothing is inferred. */
function setCar(state: GameState, i: number, spec: CarSpec): void {
  state.carPhase[i] = spec.phase
  state.carCell[i] = spec.cell
  state.carProgress[i] = spec.progress ?? 0
  state.carRouteCursor[i] = spec.cursor ?? 0
  state.carRouteLen[i] = spec.routeLen ?? (spec.route?.length ?? 0)
  const route = spec.route ?? []
  for (let k = 0; k < route.length; k++) packRouteStep(state, i, k, route[k] as number)
}

/** Resolves car `i` into a fresh two-element array. Tests only — production writes into a preallocated buffer. */
function resolveXY(state: GameState, world: WorldData, i: number): { live: boolean; x: number; y: number } {
  const out = new Float32Array(2)
  out[0] = -999
  out[1] = -999
  const live = resolveCar(state, world, i, out, 0)
  return { live, x: out[0] as number, y: out[1] as number }
}

function cellOf(x: number, y: number): number {
  return y * GRID_W + x
}

// ---------------------------------------------------------------------------
// 0. The constants the whole file rests on
// ---------------------------------------------------------------------------

describe('the movement constants this resolver reads', () => {
  it('has the two thresholds and the per-tick speed the plan hand-computed', () => {
    expect(ORTHO_COST * COST_UNIT_SCALE).toBe(ORTHO_THRESHOLD)
    expect(DIAG_COST * COST_UNIT_SCALE).toBe(DIAG_THRESHOLD)
    expect(CAR_SPEED_UNITS_PER_TICK).toBe(330)
    // 7.576 ticks per orthogonal cell, 10.606 per diagonal — the numbers that
    // make a cell-to-cell lerp a 4 Hz strobe.
    expect(ORTHO_THRESHOLD / CAR_SPEED_UNITS_PER_TICK).toBeCloseTo(7.576, 3)
    expect(DIAG_THRESHOLD / CAR_SPEED_UNITS_PER_TICK).toBeCloseTo(10.606, 3)
  })

  it('has the direction indices this file hand-writes', () => {
    expect(DX[E]).toBe(1)
    expect(DY[E]).toBe(0)
    expect(DX[SE]).toBe(1)
    expect(DY[SE]).toBe(1)
    expect(DX[NW]).toBe(-1)
    expect(DY[NW]).toBe(-1)
    expect(OPPOSITE[E]).toBe(W)
    expect(OPPOSITE[N]).toBe(S)
    expect(edgeCost(E)).toBe(ORTHO_COST)
    expect(edgeCost(SE)).toBe(DIAG_COST)
  })
})

// ---------------------------------------------------------------------------
// 1. The orthogonal resolver
// ---------------------------------------------------------------------------

describe('resolveCar on an orthogonal edge', () => {
  it('puts a car with progress 0 at its cell centre', () => {
    const { state, world } = rig()
    setCar(state, 0, { phase: PHASE_OUTBOUND, cell: cellOf(11, 12), progress: 0, cursor: 0, route: [E] })
    const r = resolveXY(state, world, 0)
    expect(r.live).toBe(true)
    expect(r.x).toBe(11)
    expect(r.y).toBe(12)
  })

  it('puts a car with progress 1250 exactly half a cell along (DX, DY)', () => {
    // 1250 / (ORTHO_COST * COST_UNIT_SCALE) = 1250 / 2500 = 0.5, and E is
    // (DX, DY) = (1, 0), so the car is at (11.5, 12).
    const { state, world } = rig()
    setCar(state, 0, { phase: PHASE_OUTBOUND, cell: cellOf(11, 12), progress: 1250, cursor: 0, route: [E] })
    const r = resolveXY(state, world, 0)
    expect(r.x).toBe(11.5)
    expect(r.y).toBe(12)
  })

  it('reads the cell as y * w + x rather than transposing it', () => {
    // (11, 12) and (12, 11) are different cells on a 24-wide board; a
    // transposed decomposition would resolve one as the other.
    const { state, world } = rig()
    setCar(state, 0, { phase: PHASE_OUTBOUND, cell: cellOf(11, 12), cursor: 0, route: [E] })
    setCar(state, 1, { phase: PHASE_OUTBOUND, cell: cellOf(12, 11), cursor: 0, route: [E] })
    expect(resolveXY(state, world, 0)).toMatchObject({ x: 11, y: 12 })
    expect(resolveXY(state, world, 1)).toMatchObject({ x: 12, y: 11 })
  })

  it('moves NORTH as negative y, not positive', () => {
    const { state, world } = rig()
    setCar(state, 0, { phase: PHASE_OUTBOUND, cell: cellOf(11, 12), progress: 1250, cursor: 0, route: [N] })
    const r = resolveXY(state, world, 0)
    expect(r.x).toBe(11)
    expect(r.y).toBe(11.5)
  })
})

// ---------------------------------------------------------------------------
// 2. The diagonal threshold — 3,500, not 2,500
// ---------------------------------------------------------------------------

describe('resolveCar on a diagonal edge', () => {
  it('puts a car with progress 1750 at (cx + 0.5, cy + 0.5)', () => {
    // 1750 / 3500 = 0.5. A resolver that hard-codes the orthogonal threshold
    // gives 1750 / 2500 = 0.7 and lands at (7.7, 20.7) — every orthogonal case
    // in this file passes under that mutation.
    const { state, world } = rig()
    setCar(state, 0, { phase: PHASE_OUTBOUND, cell: cellOf(7, 20), progress: 1750, cursor: 0, route: [SE] })
    const r = resolveXY(state, world, 0)
    expect(r.x).toBe(7.5)
    expect(r.y).toBe(20.5)
  })

  it('uses (DX, DY) raw rather than normalising, so f reaches 1 on the next cell', () => {
    // At progress = threshold - 1 the car is a hair short of the diagonal
    // neighbour, NOT 1/sqrt(2) of the way along it. The Euclidean per-tick
    // displacement that buys is 330/3500 * sqrt(2) = 0.1333 cells against the
    // orthogonal 330/2500 = 0.132 — near-constant speed, which is what
    // DIAG_COST = 14 ~ 10*sqrt(2) is for.
    const { state, world } = rig()
    setCar(state, 0, { phase: PHASE_OUTBOUND, cell: cellOf(7, 20), progress: 3500, cursor: 0, route: [SE] })
    const r = resolveXY(state, world, 0)
    expect(r.x).toBe(8)
    expect(r.y).toBe(21)
    const orthoStep = CAR_SPEED_UNITS_PER_TICK / ORTHO_THRESHOLD
    const diagStep = (CAR_SPEED_UNITS_PER_TICK / DIAG_THRESHOLD) * Math.SQRT2
    expect(orthoStep).toBeCloseTo(0.132, 3)
    expect(diagStep).toBeCloseTo(0.1333, 4)
  })
})

// ---------------------------------------------------------------------------
// 3. The return leg
// ---------------------------------------------------------------------------

describe('resolveCar on the return leg', () => {
  /**
   * The route TURNS, and the assertion sits at a cursor where the three
   * plausible wrong answers are all distinct from the right one:
   *
   *   route = [E, N], cursor = 1, cell = (11, 12), progress = 1250
   *
   *   right:                OPPOSITE[routeStep(0)] = OPPOSITE[E] = W  -> (10.5, 12)
   *   `routeStep(cursor)`:                          routeStep(1) = N  -> (11, 11.5)
   *   `routeStep(cursor-1)` with no OPPOSITE:                     E   -> (11.5, 12)
   *   `OPPOSITE[routeStep(cursor)]`:                OPPOSITE[N] = S   -> (11, 12.5)
   *
   * On a STRAIGHT route the outbound and return directions at the same cursor
   * are opposite anyway, so `routeStep(cursor)` would pass — which is why the
   * turn is a fixture requirement rather than a flourish.
   */
  it('steps OPPOSITE[routeStep(cursor - 1)], which a turning route separates from every alternative', () => {
    const { state, world } = rig()
    setCar(state, 0, {
      phase: PHASE_RETURNING,
      cell: cellOf(11, 12),
      progress: 1250,
      cursor: 1,
      route: [E, N],
    })
    // The fixture's own precondition: the four candidate directions differ.
    expect(routeStep(state, 0, 0)).toBe(E)
    expect(routeStep(state, 0, 1)).toBe(N)
    expect(OPPOSITE[routeStep(state, 0, 0)]).toBe(W)
    expect(OPPOSITE[routeStep(state, 0, 0)]).not.toBe(routeStep(state, 0, 1))
    expect(OPPOSITE[routeStep(state, 0, 0)]).not.toBe(routeStep(state, 0, 0))
    expect(OPPOSITE[routeStep(state, 0, 0)]).not.toBe(OPPOSITE[routeStep(state, 0, 1)])

    const r = resolveXY(state, world, 0)
    expect(r.x).toBe(10.5)
    expect(r.y).toBe(12)
  })

  it('takes the diagonal threshold from the RETURN direction, not the outbound one', () => {
    // Both directions of a return step have the same `edgeCost`
    // (`edgeCost(OPPOSITE[d]) === edgeCost(d)`), so this is a same-answer check
    // rather than a discriminator — recorded as such. It exists because
    // `edgeCost` is called on `dir` and reading the wrong `dir` would be a
    // silent threshold change on the half of every trip that scores.
    const { state, world } = rig()
    setCar(state, 0, {
      phase: PHASE_RETURNING,
      cell: cellOf(7, 20),
      progress: 1750,
      cursor: 1,
      route: [NE, E],
    })
    expect(edgeCost(OPPOSITE[routeStep(state, 0, 0)] as number)).toBe(DIAG_COST)
    const r = resolveXY(state, world, 0)
    // OPPOSITE[NE] = SW = (-1, +1), f = 1750/3500 = 0.5.
    expect(r.x).toBe(6.5)
    expect(r.y).toBe(20.5)
  })
})

// ---------------------------------------------------------------------------
// 4. Phases and liveness
// ---------------------------------------------------------------------------

describe('phases', () => {
  /**
   * The IDLE fixture deliberately carries a cursor and a route that the
   * EXHAUSTION guard would not stop.
   *
   * The catalogue's most mechanical trap is here: "a PHASE_IDLE car resolves to
   * its cell" is satisfied for free by a car with `cursor = 0` and
   * `routeLen = 0`, which is exactly what a real idle car looks like — the
   * exhaustion guard stops it and the phase test is never exercised. So this
   * fixture is off the reachable manifold on purpose: cursor 1 of a 2-step
   * route, with progress, so ONLY the phase check can produce the cell.
   */
  it('resolves a PHASE_IDLE car to its cell even when its route would move it', () => {
    const { state, world } = rig()
    setCar(state, 0, {
      phase: PHASE_IDLE,
      cell: cellOf(11, 12),
      progress: 1250,
      cursor: 1,
      route: [E, SE],
    })
    const r = resolveXY(state, world, 0)
    expect(r.live).toBe(true)
    expect(r.x).toBe(11)
    expect(r.y).toBe(12)
  })

  /**
   * The other half of that single arm, and it had no detector until this case
   * existed: narrowing `phase !== PHASE_OUTBOUND && phase !== PHASE_RETURNING`
   * to `phase === PHASE_IDLE` — so an unrecognised byte falls through into the
   * driving path — survived the whole suite.
   *
   * The extra behaviour is fail-safe and it is not hypothetical. Under the
   * shipped form an unknown phase parks the car; under the narrowed form it runs
   * `routeStep` on a route that may mean nothing.
   *
   * **The reason this comment used to give was wrong, and M1d Task 3 corrected
   * it rather than marking it satisfied.** It said "M1d adds a blocking phase".
   * M1d adds no phase byte at all: blocking is a per-tick refusal with no state
   * of its own, a blocked car stays `PHASE_OUTBOUND`/`PHASE_RETURNING`, and
   * `carPhase`'s four values are unchanged since M1c. The arm is still worth
   * keeping and still needs this test — an unrecognised byte is reachable from a
   * corrupted or forward-version buffer, which is the same fail-closed idiom
   * `advanceCar` and `runArrivals` use — but the justification had to be one
   * that is true. See `describe('a blocked car resolves strictly inside its own
   * cell')` at the foot of this file for what M1d Task 3 actually needed from
   * this module, which is nothing: held progress keeps `f < 1`.
   */
  it('parks a car whose phase byte this module does not recognise', () => {
    const { state, world } = rig()
    setCar(state, 0, { phase: 99, cell: cellOf(11, 12), progress: 1250, cursor: 1, route: [E, SE] })
    const r = resolveXY(state, world, 0)
    // Driving it would give (10.5, 12) via OPPOSITE[routeStep(0)] = W.
    expect(r).toMatchObject({ live: true, x: 11, y: 12 })
  })

  it('reports a PHASE_NONE slot as not live and writes nothing', () => {
    const { state, world } = rig()
    // A dead slot's real bytes: PHASE_NONE with carCell 0. The `out` sentinel
    // is what proves the resolver did not write, rather than wrote a zero.
    setCar(state, 0, { phase: PHASE_NONE, cell: 0 })
    const r = resolveXY(state, world, 0)
    expect(r.live).toBe(false)
    expect(r.x).toBe(-999)
    expect(r.y).toBe(-999)
  })

  it('reports a dead slot as not live even when its cell is a real, in-rect cell', () => {
    // The revealed rect starts at (5, 9), so a dead slot parked at cell 0 is
    // outside the drawn region and `canvas.ts`'s bounds check would hide it —
    // a liveness test built on cell 0 passes for the wrong reason. This one
    // parks the dead slot well inside the rect.
    const { state, world } = rig()
    setCar(state, 0, { phase: PHASE_NONE, cell: cellOf(11, 20) })
    expect(resolveXY(state, world, 0).live).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. The exhausted-route fallback, both arms
// ---------------------------------------------------------------------------

describe('an exhausted route', () => {
  /**
   * `routeStep` throws on an out-of-range step index, and a renderer must never
   * be the thing that crashes the game. The fallback is unreachable from a
   * post-`step` state — arrivals collects an exhausted car in the same tick
   * that exhausts it — and it is directly callable from here, which is the
   * `assertSingleCrossing` idiom this codebase already uses for this shape.
   *
   * The guard is `outbound ? cursor >= routeLen : cursor <= 0`, two arms, and
   * each gets its own case: dropping one while keeping the other is a mutation
   * a single fixture cannot see.
   */
  it('resolves an OUTBOUND car whose cursor has reached routeLen to its cell', () => {
    const { state, world } = rig()
    // Step 2 of the route is a real direction, so without the guard the car
    // would resolve half a cell south-east of where it is.
    setCar(state, 0, {
      phase: PHASE_OUTBOUND,
      cell: cellOf(11, 12),
      progress: 1750,
      cursor: 2,
      routeLen: 2,
      route: [E, E, SE],
    })
    expect(routeStep(state, 0, 2)).toBe(SE)
    const r = resolveXY(state, world, 0)
    expect(r.live).toBe(true)
    expect(r.x).toBe(11)
    expect(r.y).toBe(12)
  })

  it('does not throw when an OUTBOUND cursor sits at MAX_PATH_LEN', () => {
    // `routeStep` calls `assertStepIndex`, which throws for `i >= MAX_PATH_LEN`.
    // This is the arm where the fallback prevents a crash rather than a wrong
    // position.
    const { state, world } = rig()
    setCar(state, 0, {
      phase: PHASE_OUTBOUND,
      cell: cellOf(11, 12),
      progress: 900,
      cursor: MAX_PATH_LEN,
      routeLen: MAX_PATH_LEN,
    })
    expect(() => routeStep(state, 0, MAX_PATH_LEN)).toThrow()
    let r: { live: boolean; x: number; y: number } | null = null
    expect(() => {
      r = resolveXY(state, world, 0)
    }).not.toThrow()
    expect(r).toMatchObject({ live: true, x: 11, y: 12 })
  })

  it('does not throw when a RETURNING cursor sits at 0', () => {
    // `routeStep(state, i, -1)` throws too, so this arm is also a crash guard.
    const { state, world } = rig()
    setCar(state, 0, {
      phase: PHASE_RETURNING,
      cell: cellOf(11, 12),
      progress: 900,
      cursor: 0,
      routeLen: 3,
      route: [E, E, E],
    })
    expect(() => routeStep(state, 0, -1)).toThrow()
    let r: { live: boolean; x: number; y: number } | null = null
    expect(() => {
      r = resolveXY(state, world, 0)
    }).not.toThrow()
    expect(r).toMatchObject({ live: true, x: 11, y: 12 })
  })
})

// ---------------------------------------------------------------------------
// 6. Snapshots
// ---------------------------------------------------------------------------

describe('the prev/curr snapshots', () => {
  function snapAt(snap: CarSnapshots, which: 'prev' | 'curr', i: number): [number, number] {
    const xy = which === 'prev' ? snap.prevXY : snap.currXY
    return [xy[i * 2] as number, xy[i * 2 + 1] as number]
  }

  it('resolves every slot, indexed by SLOT and not by dense position', () => {
    // Slot indexing is load-bearing. If prev/curr were densified, placing a
    // house would shift every later car's index by two and lerp each of them
    // against a different car's previous position — a board-wide teleport with
    // no phase transition anywhere.
    const { state, world, slots } = rig()
    const snap = createCarSnapshots(slots)
    setCar(state, 0, { phase: PHASE_NONE, cell: 0 })
    setCar(state, 1, { phase: PHASE_IDLE, cell: cellOf(11, 12) })
    setCar(state, 2, { phase: PHASE_OUTBOUND, cell: cellOf(7, 20), progress: 1250, route: [E] })
    snapshotCurr(snap, state, world)
    expect(snap.currLive[0]).toBe(0)
    expect(snap.currLive[1]).toBe(1)
    expect(snap.currLive[2]).toBe(1)
    expect(snapAt(snap, 'curr', 1)).toEqual([11, 12])
    expect(snapAt(snap, 'curr', 2)).toEqual([7.5, 20])
    expect(snap.prevLive[1]).toBe(0) // untouched by snapshotCurr
  })

  it('initCarSnapshots fills BOTH, so frame 1 does not lerp from grid cell (0, 0)', () => {
    const { state, world, slots } = rig()
    const snap = createCarSnapshots(slots)
    setCar(state, 3, { phase: PHASE_IDLE, cell: cellOf(11, 20) })
    initCarSnapshots(snap, state, world)
    expect(snapAt(snap, 'prev', 3)).toEqual([11, 20])
    expect(snapAt(snap, 'curr', 3)).toEqual([11, 20])
    expect(snap.prevLive[3]).toBe(1)
  })

  it('snapshotPrev reads the state at the moment it is called, not the last curr', () => {
    const { state, world, slots } = rig()
    const snap = createCarSnapshots(slots)
    setCar(state, 0, { phase: PHASE_OUTBOUND, cell: cellOf(11, 12), progress: 0, route: [E] })
    snapshotPrev(snap, state, world)
    state.carProgress[0] = 1250
    snapshotCurr(snap, state, world)
    expect(snapAt(snap, 'prev', 0)).toEqual([11, 12])
    expect(snapAt(snap, 'curr', 0)).toEqual([11.5, 12])
  })
})

// ---------------------------------------------------------------------------
// 7. The lerp, and its one snap case
// ---------------------------------------------------------------------------

describe('lerpCar', () => {
  function lerped(snap: CarSnapshots, i: number, alpha: number): [number, number] {
    const out = new Float32Array(2)
    lerpCar(snap, i, alpha, out, 0)
    return [out[0] as number, out[1] as number]
  }

  function put(snap: CarSnapshots, i: number, prev: [number, number] | null, curr: [number, number]): void {
    if (prev !== null) {
      snap.prevXY[i * 2] = prev[0]
      snap.prevXY[i * 2 + 1] = prev[1]
      snap.prevLive[i] = 1
    } else {
      snap.prevLive[i] = 0
    }
    snap.currXY[i * 2] = curr[0]
    snap.currXY[i * 2 + 1] = curr[1]
    snap.currLive[i] = 1
  }

  it('returns prev at alpha 0 and curr at alpha 1', () => {
    const snap = createCarSnapshots(4)
    put(snap, 1, [11, 12], [11.5, 12.25])
    expect(lerped(snap, 1, 0)).toEqual([11, 12])
    expect(lerped(snap, 1, 1)).toEqual([11.5, 12.25])
  })

  it('returns the exact midpoint at alpha 0.5', () => {
    const snap = createCarSnapshots(4)
    put(snap, 1, [11, 12], [11.5, 12.5])
    expect(lerped(snap, 1, 0.5)).toEqual([11.25, 12.25])
  })

  it('interpolates x and y independently — a shared axis would hide a swap', () => {
    const snap = createCarSnapshots(4)
    put(snap, 2, [4, 30], [8, 10])
    expect(lerped(snap, 2, 0.25)).toEqual([5, 25])
  })

  /**
   * The ONE discontinuity. A slot that was not live in prev holds a stale value
   * — or an unwritten zero, which is grid cell (0, 0) — so lerping it streaks a
   * brand-new car in from the top-left corner of the board.
   *
   * There is deliberately no distance guard alongside it. No on-manifold
   * displacement exceeds 0.1333 cells per tick, and a car never moves more than
   * one cell per tick at all, so a one-cell threshold would have nothing to
   * detect: it would be a 0-detector guard whose named must-fail mutation
   * cannot fail.
   */
  it('snaps a slot that was not live in prev straight to curr', () => {
    const snap = createCarSnapshots(4)
    put(snap, 3, null, [8, 24])
    // The stale prev is as far from the answer as the board allows.
    snap.prevXY[6] = 0
    snap.prevXY[7] = 0
    expect(lerped(snap, 3, 0.5)).toEqual([8, 24])
    expect(lerped(snap, 3, 0)).toEqual([8, 24])
  })

  it('still lerps a slot that WAS live in prev, at the same alpha', () => {
    // The negative case's partner: without it, "always snap" passes above.
    const snap = createCarSnapshots(4)
    put(snap, 3, [0, 0], [8, 24])
    expect(lerped(snap, 3, 0.5)).toEqual([4, 12])
  })
})

// ---------------------------------------------------------------------------
// 8. A blocked car stays inside its own cell — M1d Task 3, Decision 5
// ---------------------------------------------------------------------------

/**
 * **This is the renderer half of the held-progress rule, and it is the reason
 * the rule is "leave `carProgress` alone" rather than "clamp it to the
 * threshold".** `f = carProgress / (edgeCost(dir) * COST_UNIT_SCALE)` is
 * UNCLAMPED here on purpose (`resolve.ts`), so whatever the sim writes while a
 * car waits is drawn literally:
 *
 *   - held (shipped): `f = 2200 / 2500 = 0.88` — inside its own cell;
 *   - clamped to the threshold: `f = 1.0` exactly — the centre of the cell it
 *     has NOT entered, i.e. drawn on top of the car it is waiting for;
 *   - accumulated: `f` grows without bound — 2.46 after twelve blocked ticks,
 *     one and a half cells past the car in front.
 *
 * So `resolve.ts` needs no change for queued cars, and this file is where that
 * is established rather than assumed. Nothing here is hand-set: the blocked
 * car's progress comes out of a real `runMovement`, which is what makes the
 * assertion a statement about the sim and the renderer together.
 */
describe('a blocked car resolves strictly inside its own cell', () => {
  const BLOCKED_CELL_X = 11
  const BLOCKED_CELL_Y = 12
  const HELD_PROGRESS = 2200
  const BLOCKED_TICKS = 12

  /** Car 1 eastbound behind car 0, which is parked (outbound, exhausted cursor). */
  function blockedRig(): Rig {
    const r = rig()
    const cell = cellOf(BLOCKED_CELL_X, BLOCKED_CELL_Y)
    setCar(r.state, 0, { phase: PHASE_OUTBOUND, cell: cell + 1, cursor: 4, routeLen: 4, route: [E, E, E, E] })
    claimCell(r.state, 0, cell + 1, E)
    setCar(r.state, 1, {
      phase: PHASE_OUTBOUND,
      cell,
      progress: HELD_PROGRESS,
      cursor: 1,
      routeLen: 4,
      route: [E, E, E, E],
    })
    claimCell(r.state, 1, cell, E)
    return r
  }

  it('holds f = 0.88 for twelve blocked ticks and never reaches the next cell centre', () => {
    const r = blockedRig()
    const cell = cellOf(BLOCKED_CELL_X, BLOCKED_CELL_Y)
    // Vacuity: the car really is refused, by name, and really is at its
    // threshold — not merely short of it.
    expect(canEnter(r.state, r.world, 1, cell + 1, E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(HELD_PROGRESS + CAR_SPEED_UNITS_PER_TICK).toBeGreaterThanOrEqual(ORTHO_THRESHOLD)

    for (let t = 0; t < BLOCKED_TICKS; t++) {
      runMovement(r.state, r.world)
      const blocked = resolveXY(r.state, r.world, 1)
      const f = (r.state.carProgress[1] as number) / ORTHO_THRESHOLD
      expect(f, `tick ${t + 1}`).toBe(0.88)
      expect(f, `tick ${t + 1}`).toBeLessThan(1)
      // Strictly inside its own cell: past the centre, short of the boundary.
      // `toBeCloseTo` at 5 places, not `toBe`: the resolver writes into a
      // `Float32Array` and 0.88 is not exactly representable there (11.88
      // stores as 11.880000114440918). Every exact `toBe` elsewhere in this
      // file uses a value that IS — 0.5, 0.25 — and copying that idiom here
      // was the first version's mistake.
      expect(blocked.x, `tick ${t + 1}`).toBeCloseTo(BLOCKED_CELL_X + 0.88, 5)
      expect(blocked.y, `tick ${t + 1}`).toBe(BLOCKED_CELL_Y)
      expect(blocked.x, `tick ${t + 1}`).toBeLessThan(BLOCKED_CELL_X + 1)
      // And, said the way it matters on screen: it is NOT drawn on top of the
      // car it is waiting for. Under `carProgress = threshold` these two are
      // the same point, to the float.
      const blocker = resolveXY(r.state, r.world, 0)
      expect(blocker.x, `tick ${t + 1}`).toBe(BLOCKED_CELL_X + 1)
      expect(blocked.x, `tick ${t + 1}`).not.toBe(blocker.x)
      expect(blocker.x - blocked.x, `tick ${t + 1}`).toBeCloseTo(0.12, 5)
    }
  })

  it('is not vacuous: the same car on a clear road passes 1.0 and reaches the next cell', () => {
    // The control. Without it, "f stays below 1" is satisfied by a resolver
    // that cannot produce a large f at all, and by a car that was never moving.
    const r = blockedRig()
    const cell = cellOf(BLOCKED_CELL_X, BLOCKED_CELL_Y)
    r.state.carPhase[0] = PHASE_NONE
    r.state.occupancy[(cell + 1) * 2] = -1
    expect(canEnter(r.state, r.world, 1, cell + 1, E)).toBe(EnterOutcome.ENTER_FREE)

    runMovement(r.state, r.world)
    // It crossed, so it is now inside the NEXT cell, with the carry the sim
    // computed: (2200 + 330 - 2500) / 2500 = 0.012.
    expect(r.state.carCell[1]).toBe(cell + 1)
    const moved = resolveXY(r.state, r.world, 1)
    expect(moved.x).toBeCloseTo(BLOCKED_CELL_X + 1 + 0.012, 5)
    expect(moved.x).toBeGreaterThan(BLOCKED_CELL_X + 1)
  })

  it('the interpolated frame position of a blocked car does not move at all', () => {
    // The rule reaches the frame, not only the resolved snapshot: prev and curr
    // are identical while the car waits, so every alpha lerps to the same
    // point. A car that jitters in place while queued would be the visible
    // symptom of a sim that writes to `carProgress` on a refused tick.
    const r = blockedRig()
    const snap = createCarSnapshots(r.slots)
    initCarSnapshots(snap, r.state, r.world)
    for (let t = 0; t < 4; t++) {
      snapshotPrev(snap, r.state, r.world)
      runMovement(r.state, r.world)
      snapshotCurr(snap, r.state, r.world)
      for (const alpha of [0, 0.25, 0.5, 0.99]) {
        const out = new Float32Array(2)
        lerpCar(snap, 1, alpha, out, 0)
        expect(out[0], `tick ${t + 1} alpha ${alpha}`).toBeCloseTo(BLOCKED_CELL_X + 0.88, 5)
        expect(out[1], `tick ${t + 1} alpha ${alpha}`).toBe(BLOCKED_CELL_Y)
      }
    }
  })
})
