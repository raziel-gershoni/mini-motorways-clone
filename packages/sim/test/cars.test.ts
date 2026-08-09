import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  parseMap,
  CAR_SPEED_UNITS_PER_TICK,
  COST_UNIT_SCALE,
  DIAG_COST,
  LANE_SPEED_DEFAULT,
  ORTHO_COST,
  type MapData,
} from '@laneways/shared'
import { createState, snapshot, restore, hashState, H_TILES, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFlowFields } from '../src/scratch'
import { packRouteStep, routeStep, ROUTE_BYTES } from '../src/dispatch'
import { placeRoad, eraseRoad, roadMask, tilesLeft, DX, DY, OPPOSITE } from '../src/roads'
import { PHASE_IDLE, PHASE_NONE, PHASE_OUTBOUND, PHASE_RETURNING } from '../src/buildings'
import { runMovement, advanceCar, speedUnits, assertSingleCrossing } from '../src/cars'
import { EnterOutcome, canEnter, claimCell, releaseCell } from '../src/blocking'

/**
 * Every fixture is an all-land 20 x 12 board (`W` x `H`), so a cell index is
 * `y * 20 + x` and every cell literal below was computed by hand from that.
 * Non-square deliberately: a transposed index lands off-grid or on the wrong
 * row rather than coincidentally agreeing.
 *
 * **Every expected tick in this file is hand-computed from the constants and
 * written as a literal**, never read back from the implementation and never
 * recomputed by a formula that mirrors the one under test. The arithmetic, in
 * full, once — with `SPEED` = `speedUnits(LANE_SPEED_DEFAULT)` = 330,
 * `ORTHO_T` = 10 * 250 = 2500 and `DIAG_T` = 14 * 250 = 3500:
 *
 * A car crosses its k-th cell on the first tick whose accumulated progress
 * reaches the k-th cumulative threshold, because the remainder CARRIES:
 * `t_k = ceil((C_k - carryIn) / 330)` where `C_k` is the sum of the first k
 * thresholds. Every array below is that formula evaluated by hand.
 *
 *   ORTHO (8 x 2500):    C = 2500 5000 7500 10000 12500 15000 17500 20000
 *                        t = 8 16 23 31 38 46 54 61        (arrival tick 61)
 *   DIAG  (8 x 3500):    C = 3500 7000 10500 14000 17500 21000 24500 28000
 *                        t = 11 22 32 43 54 64 75 85       (arrival tick 85)
 *   MIXED (E,SE x 4):    C = 2500 6000 8500 12000 14500 18000 20500 24000
 *                        t = 8 19 26 37 44 55 63 73        (arrival tick 73)
 *
 * The carry-dropping mutant (`progress = 0` instead of `progress -=
 * threshold`) pays `ceil(2500 / 330)` = 8 ticks for EVERY orthogonal cell and
 * arrives at 64 rather than 61 — visible only because 330 divides neither
 * 2500 nor 3500. `constants.test.ts` asserts that indivisibility so a future
 * speed change cannot silently disarm every test in this file.
 */

const W = 20
const H = 12

/** DIRS indices (roads.ts): 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW. */
const N = 0
const E = 2
const SE = 3
const S = 4
const W_DIR = 6
const NW = 7

const SPEED = 330
const ORTHO_T = 2500
const DIAG_T = 3500

function allLandRows(w: number, h: number): string[] {
  const row = '.'.repeat(w)
  return Array.from({ length: h }, () => row)
}

function fixture(id: string, startingTiles = 999): { map: MapData; world: WorldData } {
  const map = parseMap(id, allLandRows(W, H), startingTiles, 40, 16, 5)
  return { map, world: createWorld(map) }
}

function rig(id: string, startingTiles = 999): { state: GameState; world: WorldData; map: MapData } {
  const { map, world } = fixture(id, startingTiles)
  return { state: createState('cars', map), world, map }
}

/**
 * Commits a route to car `car` by hand, in exactly the shape `dispatchColour`
 * leaves behind (`carRouteLen` = step count, `carRouteCursor` = 0,
 * `carProgress` = 0, `carPhase` = `PHASE_OUTBOUND`) — writing through
 * `packRouteStep`, the one owner of the nibble layout, so this fixture cannot
 * disagree with dispatch about where a step lives.
 */
function commit(state: GameState, car: number, cell: number, route: readonly number[]): void {
  for (let i = 0; i < route.length; i++) packRouteStep(state, car, i, route[i] as number)
  state.carCell[car] = cell
  state.carRouteLen[car] = route.length
  state.carRouteCursor[car] = 0
  state.carProgress[car] = 0
  state.carTargetDest[car] = 0
  state.carPhase[car] = PHASE_OUTBOUND
}

interface Trace {
  /** `cellPerTick[t - 1]` is `carCell` after tick `t`. */
  readonly cellPerTick: number[]
  /** `progressPerTick[t - 1]` is `carProgress` after tick `t`. */
  readonly progressPerTick: number[]
  /** The tick on which the k-th cursor change happened, in order. */
  readonly crossingTicks: number[]
}

/**
 * Runs `ticks` movement ticks and records car `car`'s per-tick cell,
 * progress, and the tick of each cursor change.
 *
 * Asserts the one-crossing-per-car-per-tick invariant on EVERY tick of every
 * run in this file, rather than in one dedicated test: the cursor may move by
 * at most 1. That is the property `assertSingleCrossing` guards inside the
 * implementation, checked here from the outside as well.
 */
function runTicks(state: GameState, world: WorldData, car: number, ticks: number): Trace {
  const cellPerTick: number[] = []
  const progressPerTick: number[] = []
  const crossingTicks: number[] = []
  let previousCursor = state.carRouteCursor[car] as number
  for (let t = 1; t <= ticks; t++) {
    runMovement(state, world)
    const cursor = state.carRouteCursor[car] as number
    expect(Math.abs(cursor - previousCursor), `car crossed more than one cell on tick ${t}`).toBeLessThanOrEqual(1)
    if (cursor !== previousCursor) crossingTicks.push(t)
    previousCursor = cursor
    cellPerTick.push(state.carCell[car] as number)
    progressPerTick.push(state.carProgress[car] as number)
  }
  return { cellPerTick, progressPerTick, crossingTicks }
}

/**
 * The per-tick cell sequence implied by two HAND-WRITTEN literal arrays: the
 * cells a car stands on after each crossing, and the ticks those crossings
 * happen on. Nothing here is derived from the implementation — it is a
 * reshaping of literals into the per-tick form `runTicks` records, so that a
 * cell-by-cell comparison is legible instead of 73 spelled-out entries.
 */
function perTickCells(startCell: number, cells: readonly number[], crossingTicks: readonly number[], ticks: number): number[] {
  const out: number[] = []
  for (let t = 1; t <= ticks; t++) {
    let k = 0
    while (k < crossingTicks.length && (crossingTicks[k] as number) <= t) k++
    out.push(k === 0 ? startCell : (cells[k - 1] as number))
  }
  return out
}

/**
 * The tick on which car `car` reaches the end of its outbound route, or -1
 * within `limit` ticks. Returns a MEASURED number so a caller can assert a
 * hand-computed literal against real behaviour rather than against another
 * literal.
 */
function arrivalTick(state: GameState, world: WorldData, car: number, limit: number): number {
  const len = state.carRouteLen[car] as number
  for (let t = 1; t <= limit; t++) {
    runMovement(state, world)
    if ((state.carRouteCursor[car] as number) === len) return t
  }
  return -1
}

/** Vacuity helper: the number of adjacent pairs of route steps whose directions differ. */
function adjacentDifferingPairs(route: readonly number[]): number {
  let n = 0
  for (let i = 1; i < route.length; i++) if (route[i] !== route[i - 1]) n++
  return n
}

// The three routes, and the cells each one visits. Hand-written literals.
const ORTHO_ROUTE = [E, E, E, E, E, E, E, E]
const ORTHO_CELLS = [43, 44, 45, 46, 47, 48, 49, 50]
const ORTHO_TICKS = [8, 16, 23, 31, 38, 46, 54, 61]

const DIAG_ROUTE = [SE, SE, SE, SE, SE, SE, SE, SE]
const DIAG_CELLS = [63, 84, 105, 126, 147, 168, 189, 210]
const DIAG_TICKS = [11, 22, 32, 43, 54, 64, 75, 85]

const MIXED_ROUTE = [E, SE, E, SE, E, SE, E, SE]
const MIXED_CELLS = [43, 64, 65, 86, 87, 108, 109, 130]
const MIXED_TICKS = [8, 19, 26, 37, 44, 55, 63, 73]

/** (2, 2) on the 20-wide board: the start cell of all three routes. */
const START = 42

describe('speedUnits', () => {
  /**
   * A hand-written literal table, deliberately NOT `(330 * mul / 1000) | 0`.
   * M1c applies no lane-speed multiplier: the only live call is the identity,
   * so under the movement tests alone the rounding rule and the clamp are
   * dead code and both "round instead of truncate" and "drop the clamp"
   * survive everything. This table is their only observer until M1d/M1e give
   * them a caller.
   */
  it('matches a hand-written literal table at every lane-speed multiplier the spec names', () => {
    // 330 * 333 = 109_890 -> 109.89 -> 109 (truncated, NOT 110)
    expect(speedUnits(333)).toBe(109)
    // 330 * 500 = 165_000 -> 165 exactly
    expect(speedUnits(500)).toBe(165)
    // 330 * 667 = 220_110 -> 220.11 -> 220
    expect(speedUnits(667)).toBe(220)
    // 330 * 1000 = 330_000 -> 330 exactly (the identity, M1c's only live call)
    expect(speedUnits(1000)).toBe(330)
    // 330 * 2000 -> 660, 330 * 3000 -> 990
    expect(speedUnits(2000)).toBe(660)
    expect(speedUnits(3000)).toBe(990)
  })

  it('truncates rather than rounds, at the one multiplier where the two differ by a whole unit', () => {
    // 109.89 rounds to 110 and ceilings to 110; it truncates to 109. This one
    // assertion is what kills "change the rounding direction" — 667 (220.11)
    // gives 220 under truncation AND rounding, so it cannot.
    expect(speedUnits(333)).toBe(109)
    expect(speedUnits(333)).not.toBe(110)
  })

  it('clamps to 1 so no multiplier can stall a car permanently', () => {
    // The clamp bites strictly below mul = 1000/330 = 3.03..., i.e. at mul <= 3:
    //   mul = 3 -> 330 * 3 = 990 -> 0.99 -> 0, clamped to 1
    //   mul = 0 -> 0, clamped to 1
    // and stops biting at mul = 4 -> 1320 -> 1.32 -> 1, which is already 1.
    expect(speedUnits(3)).toBe(1)
    expect(speedUnits(0)).toBe(1)
    expect(speedUnits(4)).toBe(1)
    // Vacuity: mul = 3 and mul = 4 both answer 1, but only one of them is the
    // clamp doing it. Without the clamp, mul = 3 answers 0 and mul = 4 still
    // answers 1 — so the mul = 3 case above is the one that observes it.
    expect(speedUnits(4)).toBe(speedUnits(3))
  })

  it('is the identity at LANE_SPEED_DEFAULT, which is the only multiplier M1c applies', () => {
    expect(speedUnits(LANE_SPEED_DEFAULT)).toBe(CAR_SPEED_UNITS_PER_TICK)
    expect(speedUnits(LANE_SPEED_DEFAULT)).toBe(330)
  })
})

describe('the constants this task depends on', () => {
  it('gives the two thresholds movement compares against', () => {
    expect(ORTHO_COST * COST_UNIT_SCALE).toBe(ORTHO_T)
    expect(DIAG_COST * COST_UNIT_SCALE).toBe(DIAG_T)
  })

  it('keeps a car strictly below one crossing per tick', () => {
    // The invariant `assertSingleCrossing` guards: the speed is below the
    // smallest threshold, so the residual after a crossing (which is below the
    // speed) can never itself cross.
    expect(SPEED).toBeLessThan(ORTHO_T)
  })
})

describe('outbound movement', () => {
  it('arrives over 8 orthogonal cells on tick 61, crossing each cell on its hand-computed tick', () => {
    const { state, world } = rig('ortho')
    commit(state, 0, START, ORTHO_ROUTE)

    const trace = runTicks(state, world, 0, 61)

    expect(trace.crossingTicks).toEqual(ORTHO_TICKS)
    expect(state.carRouteCursor[0]).toBe(8)
    expect(state.carCell[0]).toBe(50)
    // 330 * 61 - 20_000 = 20_130 - 20_000 = 130 units carried past the last crossing.
    expect(state.carProgress[0]).toBe(130)

    // Vacuity (fix-list #30): the cell genuinely changed, crossings genuinely
    // happened, and progress was genuinely non-zero mid-flight — without the
    // last one a teleporting implementation passes.
    expect(state.carCell[0]).not.toBe(START)
    expect(trace.crossingTicks.length).toBe(8)
    expect(trace.progressPerTick[4]).not.toBe(0)
    expect(trace.progressPerTick[4]).toBe(SPEED * 5) // 1650, five ticks of accumulation

    // The LINKAGE: movement gains `speedUnits(LANE_SPEED_DEFAULT)` per tick,
    // not a hard-coded copy of the same number. The literal 330 is asserted
    // just above and in `speedUnits`' own table; this is the separate claim
    // that the loop goes through the helper, which is what would rot the day a
    // multiplier arrives.
    expect(trace.progressPerTick[0]).toBe(speedUnits(LANE_SPEED_DEFAULT))
  })

  it('arrives over 8 diagonal cells on tick 85 — 14/10 of the orthogonal cost, not the same', () => {
    const { state, world } = rig('diag')
    commit(state, 0, START, DIAG_ROUTE)

    const trace = runTicks(state, world, 0, 85)

    expect(trace.crossingTicks).toEqual(DIAG_TICKS)
    expect(state.carCell[0]).toBe(210)
    // 330 * 85 - 28_000 = 28_050 - 28_000 = 50
    expect(state.carProgress[0]).toBe(50)
  })

  it('takes 1.40x as long on the diagonal as on the orthogonal, within the rounding the constants imply', () => {
    // The ratio is computed from two MEASURED arrival ticks, never from
    // re-typed literals. An earlier version of this test asserted `((85 * 1000)
    // / 61) | 0 === 1393` — arithmetic on constants, which passes even when
    // `runMovement`'s entire body is replaced by an early return. A test that
    // is green while movement does nothing is not covering the movement ratio.
    const orthoRig = rig('ratio-ortho')
    commit(orthoRig.state, 0, START, ORTHO_ROUTE)
    const orthoArrival = arrivalTick(orthoRig.state, orthoRig.world, 0, 200)

    const diagRig = rig('ratio-diag')
    commit(diagRig.state, 0, START, DIAG_ROUTE)
    const diagArrival = arrivalTick(diagRig.state, diagRig.world, 0, 200)

    expect(orthoArrival).toBe(61)
    expect(diagArrival).toBe(85)

    // 85 * 1000 / 61 = 1393.44 -> 1393 at DENOM scale, against the exact 1400
    // the two thresholds imply (3500 / 2500). The 7-in-1400 gap (0.5%) is the
    // two ceilings, nothing else: the real-valued times are 20_000/330 =
    // 60.606 and 28_000/330 = 84.848, whose ratio is exactly 1.40.
    const ratioScaled = ((diagArrival * 1000) / orthoArrival) | 0
    expect(ratioScaled).toBe(1393)
    expect(Math.abs(ratioScaled - 1400)).toBeLessThanOrEqual(14) // within 1%
    // And the two measured arrivals are genuinely different, so the ratio is
    // not 1.00 dressed up: an implementation that charges ORTHO_COST for a
    // diagonal arrives at 61 on both, and `ratioScaled` would read 1000.
    expect(diagArrival).not.toBe(orthoArrival)
  })

  it('arrives on a mixed orthogonal/diagonal path on its own hand-computed tick, not on either pure path`s', () => {
    const { state, world } = rig('mixed')
    commit(state, 0, START, MIXED_ROUTE)

    const trace = runTicks(state, world, 0, 73)

    expect(trace.crossingTicks).toEqual(MIXED_TICKS)
    expect(state.carCell[0]).toBe(130)
    // 330 * 73 - 24_000 = 24_090 - 24_000 = 90
    expect(state.carProgress[0]).toBe(90)

    // Neither pure-path answer, asserted against the MEASURED arrival rather
    // than against the literal 73: a per-edge-normalised offset (every cell the
    // same duration) arrives at 8 * 8 = 64, an all-ortho pricing at 61, an
    // all-diagonal pricing at 85.
    const mixedArrival = trace.crossingTicks[7] as number
    expect(mixedArrival).toBe(73)
    expect(mixedArrival).not.toBe(64)
    expect(mixedArrival).not.toBe(61)
    expect(mixedArrival).not.toBe(85)

    // Vacuity: the mixed fixture really is mixed, and its steps really do
    // change direction from one to the next — a nibble swap of two EQUAL
    // directions is the identity, so without an adjacent differing pair the
    // cell trace below could not see one.
    expect(MIXED_ROUTE.filter((d) => d === E).length).toBe(4)
    expect(MIXED_ROUTE.filter((d) => d === SE).length).toBe(4)
    expect(adjacentDifferingPairs(MIXED_ROUTE)).toBe(7)
  })

  it('stands on the exact hand-computed cell on every single tick of a mixed path', () => {
    // The nibble-order swap, stated precisely rather than as the plan and the
    // brief state it. Measured with the swap applied to `routeStep`: the
    // ENDPOINT (130), the TOTAL COST and therefore the ARRIVAL TICK (73) are
    // all unchanged — displacement vectors commute, the multiset of steps is
    // unchanged, and arrival is cursor-driven rather than position-driven, so
    // the mutant "arrives" while standing on the wrong cell for most of the
    // trip. **Any assertion restricted to those three passes the mutant.** It
    // does NOT follow that only a cell trace sees it: the swap reorders the
    // costs, so the intermediate crossing ticks move too
    // ([8,19,26,37,44,55,63,73] -> [11,19,29,37,47,55,66,73]), and Task 4's
    // codec round-trips kill a reader-only swap outright. This trace is the
    // sharpest observer, not the sole one. Note also that the mutation is not
    // constructible against `cars.ts` at all — it imports `routeStep` rather
    // than re-deriving the shift.
    const { state, world } = rig('mixed-trace')
    commit(state, 0, START, MIXED_ROUTE)

    const trace = runTicks(state, world, 0, 73)

    expect(trace.cellPerTick).toEqual(perTickCells(START, MIXED_CELLS, MIXED_TICKS, 73))
    // Spelled out for the three ticks that carry the discrimination, so the
    // comparison above cannot silently degrade into comparing two empty arrays.
    expect(trace.cellPerTick.length).toBe(73)
    expect(trace.cellPerTick[7]).toBe(43) // tick 8: crossed the first (orthogonal) step
    expect(trace.cellPerTick[10]).toBe(43) // tick 11: the swapped route would be at 63 by now
    expect(trace.cellPerTick[18]).toBe(64) // tick 19: second crossing, onto the diagonal step's cell
  })

  it('crosses on the tick progress EQUALS the threshold, not the tick after', () => {
    // The `>=` boundary, which none of the three fixtures above can see: a
    // crossing lands exactly on its threshold only when the cumulative cost is
    // a multiple of 330, and 4 diagonals + 1 orthogonal is the shortest route
    // for which that is true — 4 * 3500 + 2500 = 16_500 = 330 * 50 exactly.
    // Every other route in this file crosses strictly past its threshold, so
    // `progress > threshold` survives all of them.
    const { state, world } = rig('exact-threshold')
    const route = [SE, SE, SE, SE, E]
    commit(state, 0, START, route)

    const trace = runTicks(state, world, 0, 50)

    // 3500 7000 10_500 14_000 16_500 -> 11 22 32 43 50
    expect(trace.crossingTicks).toEqual([11, 22, 32, 43, 50])
    expect(state.carCell[0]).toBe(127) // 42 -> 63 -> 84 -> 105 -> 126 -> 127
    // Exactly on the threshold: nothing left over, the one route in this file
    // that ends on a zero carry.
    expect(state.carProgress[0]).toBe(0)
    expect(SPEED * 50).toBe(4 * DIAG_T + ORTHO_T) // 16_500, the equality itself
  })

  it('reads its route through the same nibble codec dispatch wrote it with', () => {
    // The committed fixture round-trips through `routeStep`, so "the test
    // packed it one way and movement read it another" is not a live failure
    // mode here — and both nibble positions are exercised, since the route has
    // both even and odd steps that differ.
    const { state } = rig('codec')
    commit(state, 0, START, MIXED_ROUTE)
    for (let i = 0; i < MIXED_ROUTE.length; i++) expect(routeStep(state, 0, i)).toBe(MIXED_ROUTE[i])
    expect(MIXED_ROUTE[0]).not.toBe(MIXED_ROUTE[1]) // even vs odd nibble genuinely differ
  })
})

describe('the return leg', () => {
  it('retraces the mixed path cell by cell, stepping the OPPOSITE of each committed step', () => {
    const { state, world } = rig('return-mixed')
    commit(state, 0, START, MIXED_ROUTE)
    runTicks(state, world, 0, 73)
    expect(state.carCell[0]).toBe(130)
    expect(state.carProgress[0]).toBe(90)

    // The flip Task 6's arrivals phase performs: phase and cursor change, and
    // `carProgress` is deliberately LEFT ALONE — the carry crosses the flip.
    state.carPhase[0] = PHASE_RETURNING
    state.carRouteCursor[0] = 8

    const back = runTicks(state, world, 0, 73)

    // Hand-computed from carry 90: t_k = ceil((C_k - 90) / 330) over the
    // REVERSED cost sequence 3500 2500 3500 2500 3500 2500 3500 2500, i.e.
    // C = 3500 6000 9500 12_000 15_500 18_000 21_500 24_000.
    expect(back.crossingTicks).toEqual([11, 18, 29, 37, 47, 55, 65, 73])
    // The cells, reversed: 130 -> 109 -> 108 -> 87 -> 86 -> 65 -> 64 -> 43 -> 42.
    expect(back.cellPerTick).toEqual(perTickCells(130, [109, 108, 87, 86, 65, 64, 43, 42], [11, 18, 29, 37, 47, 55, 65, 73], 73))
    expect(state.carRouteCursor[0]).toBe(0)
    expect(state.carCell[0]).toBe(START)
    // 90 + 330 * 73 - 24_000 = 180
    expect(state.carProgress[0]).toBe(180)
  })

  it('takes exactly as long as the outbound leg did, and the carry moves its individual crossings', () => {
    // The equal totals are `edgeCost(OPPOSITE[d]) === edgeCost(d)`; the
    // DIFFERENT intermediate ticks are the carry crossing the flip.
    //
    // THIS IS THE ONLY ASSERTION THAT KILLS "drop the carry at the flip". At
    // these constants the carry (130 units, under half a tick) does not move
    // the orthogonal round trip's total: ceil(19_870 / 330) = 61 and
    // ceil(20_000 / 330) = 61 alike. The leg LENGTH cannot see the mutation;
    // only crossings 2, 4 and 7 can.
    const { state, world } = rig('return-ortho')
    commit(state, 0, START, ORTHO_ROUTE)
    const out = runTicks(state, world, 0, 61)
    expect(out.crossingTicks).toEqual(ORTHO_TICKS)
    expect(state.carProgress[0]).toBe(130)

    state.carPhase[0] = PHASE_RETURNING
    state.carRouteCursor[0] = 8

    const back = runTicks(state, world, 0, 61)

    // t_k = ceil((2500k - 130) / 330), hand-computed:
    //   2370/330=7.18->8   4870/330=14.76->15   7370/330=22.33->23
    //   9870/330=29.90->30 12_370/330=37.48->38 14_870/330=45.06->46
    //   17_370/330=52.64->53                    19_870/330=60.21->61
    expect(back.crossingTicks).toEqual([8, 15, 23, 30, 38, 46, 53, 61])
    expect(back.crossingTicks.length).toBe(out.crossingTicks.length)
    expect(back.crossingTicks[7]).toBe(out.crossingTicks[7]) // same leg length: 61
    expect(back.crossingTicks[1]).not.toBe(out.crossingTicks[1]) // 15 vs 16: the carry, not luck
    expect(state.carCell[0]).toBe(START)
    expect(state.carRouteCursor[0]).toBe(0)
  })

  it('walks the route BACKWARDS: stepping route[cursor] forwards instead leaves the board it came from', () => {
    // A directed spelling of the `OPPOSITE[route[cursor - 1]]` rule. On the
    // all-E fixture a return that stepped `route[cursor]` would drive further
    // EAST — and `route[8]` is an unwritten nibble, decoding as 0 = N, so it
    // would drive north instead. Either way the first return cell is not 49.
    const { state, world } = rig('return-direction')
    commit(state, 0, START, ORTHO_ROUTE)
    runTicks(state, world, 0, 61)
    state.carPhase[0] = PHASE_RETURNING
    state.carRouteCursor[0] = 8

    runTicks(state, world, 0, 8)
    expect(state.carCell[0]).toBe(49) // west of 50, not 51 (further E) and not 30 (N)
    expect(state.carRouteCursor[0]).toBe(7)
    expect(OPPOSITE[E]).toBe(W_DIR) // the table the rule leans on
  })
})

describe('cars that must not move', () => {
  it('leaves an exhausted, an idle, a never-created and a home car untouched while another drives', () => {
    // One state, five cars, so this also pins that movement treats cars
    // independently and in one ascending pass.
    //
    // **The idle and never-created cars sit MID-ROUTE, at cursor 3 on cell 45,
    // and that is the whole point of them.** With cursor 0 they satisfy the
    // brief's bullet ("a car in PHASE_IDLE or PHASE_NONE does not move")
    // exactly and still cannot observe it: deleting the phase filter leaves
    // `outbound` false for them, so they take the RETURNING arm and the
    // EXHAUSTION guard (`cursor <= 0`) stops them instead — the assertion
    // passes, delivered by a different mechanism. Verified: with cursor 0,
    // deleting the phase filter is green across all 582 tests. The general
    // rule this file now stands on: a negative assertion ("X does not move")
    // is only meaningful if the fixture DISABLES EVERY OTHER MECHANISM that
    // would produce the same observation. Cursor 3 disables exhaustion, so
    // only the phase filter can be what stops them.
    const { state, world } = rig('no-move')
    commit(state, 0, START, ORTHO_ROUTE) // the driver

    commit(state, 1, START, ORTHO_ROUTE) // outbound but already exhausted
    state.carRouteCursor[1] = 8

    commit(state, 2, START, ORTHO_ROUTE) // a full route, mid-route, but idle
    state.carPhase[2] = PHASE_IDLE
    state.carRouteCursor[2] = 3
    state.carCell[2] = 45

    commit(state, 3, START, ORTHO_ROUTE) // a full route, mid-route, but never created
    state.carPhase[3] = PHASE_NONE
    state.carRouteCursor[3] = 3
    state.carCell[3] = 45

    commit(state, 4, START, ORTHO_ROUTE) // returning, already home
    state.carPhase[4] = PHASE_RETURNING
    state.carRouteCursor[4] = 0

    // Vacuity, before the run: cars 2 and 3 are strictly inside their route, so
    // neither exhaustion arm can be what holds them.
    for (const car of [2, 3]) {
      expect(state.carRouteCursor[car]).toBeGreaterThan(0)
      expect(state.carRouteCursor[car]).toBeLessThan(state.carRouteLen[car] as number)
    }

    for (let t = 0; t < 61; t++) runMovement(state, world)

    // The driver drove.
    expect(state.carCell[0]).toBe(50)
    expect(state.carRouteCursor[0]).toBe(8)

    // Nobody else moved, and — the part a looser assertion would miss — nobody
    // else banked progress either. An exhausted car is one arrivals has not
    // collected yet; letting it accumulate would credit the next leg with time
    // it did not spend driving.
    const parked: readonly (readonly [number, number, number])[] = [
      // [car, expected cell, expected cursor]
      [1, START, 8], // outbound, exhausted at the end of its route
      [2, 45, 3], // IDLE, mid-route — only the phase filter can hold it
      [3, 45, 3], // NONE, mid-route — likewise
      [4, START, 0], // returning, exhausted at the start of its route
    ]
    for (const [car, cell, cursor] of parked) {
      expect(state.carCell[car], `car ${car} moved`).toBe(cell)
      expect(state.carRouteCursor[car], `car ${car} advanced its cursor`).toBe(cursor)
      expect(state.carProgress[car], `car ${car} banked progress`).toBe(0)
      // Vacuity: each of these cars really did hold a live route, so "did not
      // move" is a decision about its phase/cursor and not about an empty slot.
      expect(state.carRouteLen[car]).toBe(8)
    }
  })

  it('is stopped by the exhaustion guard alone, on a car whose phase is unimpeachable', () => {
    // The other half of the decomposition. The test above now leans on the
    // PHASE filter for cars 2 and 3; this one leans on the EXHAUSTION guard and
    // nothing else — the car is `PHASE_OUTBOUND`, which every phase filter
    // admits, and is held only by `cursor >= routeLen`. Without the two
    // separated, "delete the exhaustion guard" and "delete the phase filter"
    // would share a single detector and a fix to one could mask the other.
    const { state, world } = rig('exhaustion-only')
    commit(state, 0, 50, ORTHO_ROUTE)
    state.carRouteCursor[0] = 8
    expect(state.carPhase[0]).toBe(PHASE_OUTBOUND) // vacuity: not held by the phase filter

    for (let t = 0; t < 20; t++) runMovement(state, world)

    expect(state.carCell[0]).toBe(50)
    expect(state.carRouteCursor[0]).toBe(8)
    expect(state.carProgress[0]).toBe(0)
  })
})

describe('the entry refusal is the FOURTH way advanceCar writes nothing (M1d Task 3)', () => {
  /**
   * One driver behind one parked car, both eastbound on row 2.
   *
   * The blocker is `PHASE_OUTBOUND` with an exhausted cursor — the arm the
   * block above isolates — so it holds its cell indefinitely without any second
   * blocking car behind it, and it is sound: an in-flight car genuinely
   * standing on the cell its slot names.
   */
  function blockedRig(seed: string, progress: number) {
    const { state, world } = rig(seed)
    commit(state, 0, START + 1, ORTHO_ROUTE)
    state.carRouteCursor[0] = 8 // exhausted: the blocker never moves
    claimCell(state, 0, START + 1, E)

    commit(state, 1, START, ORTHO_ROUTE)
    state.carRouteCursor[1] = 1
    state.carProgress[1] = progress
    claimCell(state, 1, START, E)
    return { state, world }
  }

  it('writes ONE region on a refused tick and nothing else — the rest of the buffer is byte-identical', () => {
    // **Task 3 wrote this as "the whole state buffer is byte-identical", and
    // Task 4 necessarily contradicts it.** The valve's counter has to be
    // incremented somewhere, and the refusal branch is the only place it can
    // be, so a refused tick now moves exactly two bytes: `carBlockedTicks[i]`.
    // Neither the M1d plan nor Task 4's brief names this contradiction (Task 5
    // carries an explicitly named one of the same shape, in the delayed-refund
    // block at the foot of this file — cited by NAME rather than by line,
    // because Tasks 3 and 4 both inserted above it and the brief's own
    // `:586-628` citation was two hundred lines stale by the time Task 5 read
    // it),
    // so it is called out here rather than silently re-blessed.
    //
    // The repair is the STRONGER form of the original claim, not a weakened
    // one: the counter's exact new value is pinned, then restored, and the rest
    // of the buffer is asserted byte-identical exactly as before. Every named
    // mutation on the refusal branch — accumulate, clamp to the threshold,
    // advance the cursor, claim occupancy, increment by two, increment the
    // wrong car — moves a byte this pair of assertions sees.
    const { state, world } = blockedRig('refusal-writes-nothing', 2200)
    // Vacuity: the car must genuinely reach its threshold this tick, or
    // "nothing changed" is satisfied by a car that was never going to cross.
    expect((state.carProgress[1] as number) + SPEED).toBeGreaterThanOrEqual(ORTHO_T)
    expect(state.carPhase[1]).toBe(PHASE_OUTBOUND)
    expect(canEnter(state, world, 1, START + 1, E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(state.carBlockedTicks[1]).toBe(0)

    const before = new Uint8Array(state.buffer).slice()
    const digest = hashState(state)
    runMovement(state, world)

    // The one write, by exact value and for the right car only.
    expect(state.carBlockedTicks[1]).toBe(1)
    expect(state.carBlockedTicks[0]).toBe(0)
    // And the digest MOVED, which is what says the counter is inside it and
    // therefore survives snapshot/restore into a Worker replay.
    expect(hashState(state)).not.toBe(digest)

    // Put it back, and every other byte of the buffer is where it was.
    state.carBlockedTicks[1] = 0
    expect(new Uint8Array(state.buffer)).toEqual(before)
    expect(hashState(state)).toBe(digest)
  })

  it('is not vacuous: the same rig with the slot FREE moves the car and moves the buffer', () => {
    // The control that makes the byte-identity above evidence rather than an
    // observation about a state where nothing was going to happen. One line
    // different: the blocker's claim is released.
    const { state, world } = blockedRig('refusal-control', 2200)
    releaseCell(state, 0, START + 1)
    expect(canEnter(state, world, 1, START + 1, E)).toBe(EnterOutcome.ENTER_FREE)

    const before = new Uint8Array(state.buffer).slice()
    runMovement(state, world)
    expect(new Uint8Array(state.buffer)).not.toEqual(before)
    expect(state.carCell[1]).toBe(START + 1)
    expect(state.carProgress[1]).toBe(2200 + SPEED - ORTHO_T)
    expect(state.carRouteCursor[1]).toBe(2)
  })

  it('separates the refusal from the sub-threshold arm, which also writes no cell and no cursor', () => {
    // The catalogue's most-repeated family, at its sharpest: a car short of its
    // threshold ALSO does not move, ALSO keeps its cell and ALSO keeps its
    // cursor. The two are told apart by `carProgress` — which rises by exactly
    // `speed` in one case and by exactly nothing in the other — and by the
    // outcome code, which is why the code exists.
    const { state, world } = blockedRig('refusal-vs-subthreshold', 0)
    const cells: number[] = []
    const progresses: number[] = []
    for (let t = 1; t <= 10; t++) {
      runMovement(state, world)
      cells.push(state.carCell[1] as number)
      progresses.push(state.carProgress[1] as number)
    }
    // Ticks 1-7 accumulate; from tick 8 the threshold is reached and the
    // refusal freezes it. The cell is identical on all ten ticks, so the cell
    // alone cannot tell the two apart — which is the point.
    expect(cells.every((c) => c === START)).toBe(true)
    expect(progresses).toEqual([330, 660, 990, 1320, 1650, 1980, 2310, 2310, 2310, 2310])
    // The third discriminator, and it separates the two arms in the opposite
    // direction from `carProgress`: the sub-threshold ticks are the ones that
    // move progress and NOT the counter, and the refused ticks are the ones
    // that move the counter and NOT progress. Ticks 8, 9 and 10 are refusals,
    // so the counter is 3 — not 10, which is what "count every tick the car
    // failed to move" would give.
    expect(state.carBlockedTicks[1]).toBe(3)
  })

  it('advanceCar consults the refusal directly too, not only through runMovement', () => {
    // `advanceCar` is exported and independently driven by this file's guard
    // tests, so the branch has to hold there as well — otherwise a caller that
    // bypasses `runMovement` (Task 9's profile rig, for one) would move a car
    // through an occupied cell.
    const { state, world } = blockedRig('refusal-advance-car', 2200)
    advanceCar(state, world, 1, SPEED)
    expect(state.carCell[1]).toBe(START)
    expect(state.carProgress[1]).toBe(2200)
  })

  it('still throws for a route that leaves the board, rather than refusing it quietly', () => {
    // Ordering: `canEnter` is asked AFTER `stepCell`'s bounds throw, so a
    // corrupted route stays a named, unresumable failure instead of becoming a
    // car that silently stops. If the two were swapped this would refuse.
    const { state, world } = rig('refusal-after-bounds')
    commit(state, 0, 59, ORTHO_ROUTE) // (19, 2): the last column, stepping E
    expect(() => runMovement(state, world)).not.toThrow() // sub-threshold ticks are fine
    for (let t = 0; t < 6; t++) runMovement(state, world)
    expect(() => runMovement(state, world)).toThrow(/would step off the grid/)
  })
})

describe('a road erased under an in-flight car — §5.11 delayed refunds (M1d Task 5)', () => {
  /**
   * **This block replaces a test that asserted the OPPOSITE, on purpose, and
   * that contradiction is the point of Task 5.**
   *
   * The test that stood here — "refunds immediately and does not touch the car,
   * which arrives on the same tick" — pinned `tilesLeft(state) === 991` on the
   * erase tick, and its own comment called that "decision 6's stated, deliberate
   * deviation from spec §5.11's delayed ghost-lane refund, deferred to M1d". M1d
   * Task 5 is that deferral coming due, so the assertion is now wrong by design
   * rather than by accident: the refund lands on the tick the last committed car
   * crosses off the cell, and 991 arrives late instead of early. The half of the
   * old test that was never about the refund — **the car is not touched, and
   * drives the erased segment to the end of its committed route** — is kept
   * verbatim below, because that half is still true and is still the reason
   * movement may not read `roads`.
   *
   * ---------------------------------------------------------------------------
   * THE FIXTURE, AND EVERY TICK IN IT HAND-COMPUTED
   * ---------------------------------------------------------------------------
   *
   * The corridor is cells 42..50 on row 2 — the same one the rest of this file
   * uses — and the ghost is **cell 47**, in the MIDDLE of it. That is not a
   * decoration: a mid-corridor cell carries two road bits, so it takes TWO
   * erases to take its mask to 0, and only a cell whose mask reaches 0 can
   * become a ghost (`eraseRoad`). The end cell 50 would ghost in one erase and
   * would then never be departed at all, since the route ends on it.
   *
   *   `eraseRoad(46, 47)` — 46 keeps its W bit, 47 keeps its E bit. No refund,
   *                        no ghost: neither mask reached 0.
   *   `eraseRoad(47, 48)` — 47's last bit (E, `1 << 2` = 4) goes. 48 keeps its
   *                        E bit. Cell 47's refund is due, and deferred.
   *
   * Crossing ticks are this file's `ORTHO_TICKS`, unchanged: a car starting on
   * 42 enters 43,44,45,46,47,48,49,50 at ticks 8,16,23,31,38,46,54,61. **It
   * therefore DEPARTS cell 47 on tick 46**, the tick it enters 48 — which is the
   * tick the refund must land on, not tick 38 (when it arrives on the ghost) and
   * not the erase tick.
   */
  const GHOST = 47
  /** `1 << E`: the bit `eraseRoad(47, 48)` takes off cell 47, and the last one it had. */
  const GHOST_BIT = 1 << E
  /** Tiles left after the 8-segment corridor is built: 999 - (2 + 7). */
  const AFTER_BUILD = 990

  /** The 8-segment corridor 42..50 on row 2, built by hand. */
  function corridor(state: GameState, world: WorldData): void {
    for (let c = 42; c < 50; c++) {
      expect(placeRoad(state, world, c, c + 1), `failed to place ${c}-${c + 1}`).toBe(true)
    }
    expect(tilesLeft(state)).toBe(AFTER_BUILD)
  }

  /** Takes cell 47's last two segments out. Returns the tiles refunded immediately. */
  function eraseGhostCell(state: GameState, world: WorldData): number {
    const before = tilesLeft(state)
    expect(eraseRoad(state, world, 46, 47)).toBe(true)
    expect(eraseRoad(state, world, 47, 48)).toBe(true)
    // Vacuity, twice over: the road really is gone from 47, and the two
    // NEIGHBOURS really did keep theirs — so exactly one cell's refund is in
    // play and this fixture cannot be passing because it erased more than it
    // meant to.
    expect(roadMask(state, GHOST)).toBe(0)
    expect(roadMask(state, 46)).not.toBe(0)
    expect(roadMask(state, 48)).not.toBe(0)
    return tilesLeft(state) - before
  }

  it('with NO committed car, refunds immediately and creates no ghost — exactly as before Task 5', () => {
    // The unchanged half of the old behaviour, and the control that makes every
    // "deferred" assertion below mean something: the deferral is a property of
    // there being a committed car, not of erasing at all.
    const { state, world } = rig('erase-no-car')
    corridor(state, world)
    expect(eraseGhostCell(state, world)).toBe(1)
    expect(tilesLeft(state)).toBe(AFTER_BUILD + 1)
    expect(state.ghostMask[GHOST]).toBe(0)
    expect(state.ghostCommitted[GHOST]).toBe(0)
  })

  it('defers the refund to the tick the committed car crosses OFF the cell — not before, not later', () => {
    const { state, world } = rig('erase-deferred')
    corridor(state, world)
    commit(state, 0, START, ORTHO_ROUTE)

    // **The vacuity check the brief demands, and the one an occupancy-keyed
    // implementation dies on: a SECOND in-flight car that is not committed to
    // the ghost cell.** Without it, "count the cars committed to this cell" and
    // "count every in-flight car" are the same function on this board. Car 1
    // runs along row 5 (cells 102..110) and never touches 47.
    commit(state, 1, 102, ORTHO_ROUTE)

    // Erase on tick 10, with the car FOUR CELLS SHORT of the ghost: it crossed
    // into 43 on tick 8 and does not reach 44 until tick 16. An
    // occupancy-keyed implementation sees nobody standing on 47 and refunds
    // here, which is the failure §5.11 exists to prevent.
    runTicks(state, world, 0, 10)
    expect(state.carCell[0]).toBe(43)
    expect(state.carCell[1]).toBe(103)
    expect(state.carPhase[1]).toBe(PHASE_OUTBOUND) // vacuity: car 1 really is in flight

    expect(eraseGhostCell(state, world)).toBe(0)
    expect(tilesLeft(state), 'the refund landed on the erase tick').toBe(AFTER_BUILD)
    expect(state.ghostMask[GHOST]).toBe(GHOST_BIT)
    // ONE, not two: car 1 is in flight and is not committed to 47.
    expect(state.ghostCommitted[GHOST]).toBe(1)

    // Tick by tick from 11 to 46 overall. The refund must appear exactly once
    // and exactly on tick 46 — the tick the car enters 48 and therefore leaves
    // 47. Recorded as the SET of ticks on which the budget moved, so "refunds
    // twice" and "refunds early" are different failures rather than one.
    const refundTicks: number[] = []
    let prev = tilesLeft(state)
    for (let t = 11; t <= 50; t++) {
      runMovement(state, world)
      const now = tilesLeft(state)
      if (now !== prev) refundTicks.push(t)
      prev = now
    }
    expect(refundTicks).toEqual([46])
    expect(tilesLeft(state)).toBe(AFTER_BUILD + 1)
    expect(state.ghostMask[GHOST]).toBe(0)
    expect(state.ghostCommitted[GHOST]).toBe(0)
    // And the car did what the old test's surviving half said it would: it drove
    // the erased cell without noticing, and is on the far side of it.
    expect(state.carCell[0]).toBe(48)
    expect(state.carRouteCursor[0]).toBe(6)
  })

  it('the car arrives on its M1c schedule regardless — movement never reads `roads`', () => {
    // The half of the deleted test that was never about the refund, kept
    // verbatim in substance: the same hand-computed crossing ticks, unchanged by
    // the erase. This is the observer for "make `canEnter` refuse a car whose
    // next cell has no road", which would freeze the car instead.
    const { state, world } = rig('erase-schedule')
    corridor(state, world)
    commit(state, 0, START, ORTHO_ROUTE)
    runTicks(state, world, 0, 10)
    eraseGhostCell(state, world)
    const after = runTicks(state, world, 0, 51)
    // Ticks 16, 23, 31, 38, 46, 54, 61 overall, offset by the 10 already run.
    expect(after.crossingTicks).toEqual([6, 13, 21, 28, 36, 44, 51])
    expect(state.carCell[0]).toBe(50)
    expect(state.carRouteCursor[0]).toBe(8)
    expect(state.carBlockedTicks[0], 'the ghost must not have blocked its own committed car').toBe(0)
  })

  it('with TWO committed cars, refunds on the SECOND departure — and the two clear on different ticks', () => {
    // The brief's vacuity rule, and the reason this fixture is built the way it
    // is: **if both cars cleared on the same tick, "refund on the FIRST
    // departure" would pass.** Car 1 starts two cells ahead of car 0 on the same
    // corridor, so it departs 47 on tick 31 and car 0 departs it on tick 46 —
    // fifteen ticks apart, asserted below as a measured difference and not only
    // as two literals.
    //
    // Car 1's route is six steps (44 -> 50), so its crossing ladder is the first
    // six entries of ORTHO_TICKS: 8, 16, 23, 31, 38, 46 for cells 45..50. The
    // two never contend — car 1 is always at least two cells ahead — and that is
    // asserted rather than assumed, because a blocked car would move the very
    // ticks this test is about.
    const { state, world } = rig('erase-two-cars')
    corridor(state, world)
    commit(state, 0, START, ORTHO_ROUTE)
    commit(state, 1, 44, [E, E, E, E, E, E])

    runTicks(state, world, 0, 5)
    expect(state.carCell[0]).toBe(START) // still short of its first crossing (tick 8)
    expect(state.carCell[1]).toBe(44)

    expect(eraseGhostCell(state, world)).toBe(0)
    expect(state.ghostCommitted[GHOST]).toBe(2)

    const departures: number[] = []
    const refundTicks: number[] = []
    let prevTiles = tilesLeft(state)
    let on0 = false
    let on1 = false
    for (let t = 6; t <= 50; t++) {
      runMovement(state, world)
      // A departure is "was on the ghost last tick, is not now", measured from
      // the outside rather than read out of `ghostCommitted` — which is the
      // thing under test and must not be its own oracle.
      const now0 = state.carCell[0] === GHOST
      const now1 = state.carCell[1] === GHOST
      if (on0 && !now0) departures.push(t)
      if (on1 && !now1) departures.push(t)
      on0 = now0
      on1 = now1
      const tiles = tilesLeft(state)
      if (tiles !== prevTiles) refundTicks.push(t)
      prevTiles = tiles
    }

    expect(departures, 'car 1 departs the ghost on 31, car 0 on 46').toEqual([31, 46])
    // The vacuity self-check, stated as the property rather than as a repeat of
    // the literals: the two departures MUST be on different ticks.
    expect((departures[1] as number) - (departures[0] as number)).toBeGreaterThan(0)
    // Neither car was ever blocked, so the ladder above is the unimpeded one.
    expect(state.carBlockedTicks[0]).toBe(0)
    expect(state.carBlockedTicks[1]).toBe(0)
    // And the refund landed once, on the SECOND departure.
    expect(refundTicks).toEqual([46])
    expect(tilesLeft(state)).toBe(AFTER_BUILD + 1)
  })

  it('the first departure decrements without refunding — the intermediate state is pinned, not inferred', () => {
    // Split out from the test above so that "refund on the first departure" and
    // "never decrement at all" are separate failures. Runs to tick 31 and stops.
    const { state, world } = rig('erase-two-cars-midway')
    corridor(state, world)
    commit(state, 0, START, ORTHO_ROUTE)
    commit(state, 1, 44, [E, E, E, E, E, E])
    runTicks(state, world, 0, 5)
    eraseGhostCell(state, world)
    expect(state.ghostCommitted[GHOST]).toBe(2)

    for (let t = 6; t <= 31; t++) runMovement(state, world)
    expect(state.carCell[1], 'car 1 has just left the ghost').toBe(48)
    expect(state.carCell[0], 'car 0 has not reached it').toBe(46)
    expect(state.ghostCommitted[GHOST]).toBe(1)
    expect(state.ghostMask[GHOST], 'still a ghost: one committed car to go').toBe(GHOST_BIT)
    expect(tilesLeft(state)).toBe(AFTER_BUILD)
  })

  it('a car that RE-CROSSES the ghost on its return leg neither underflows nor double-refunds', () => {
    // **The residual `isCommittedTo` (dispatch.ts) derives in full, pinned here
    // rather than left as prose.** An OUTBOUND car's committed set is the suffix
    // of its route, but its remaining journey retraces the whole thing, so the
    // same car can depart the same cell twice. The second departure finds a cell
    // that is no longer a ghost and does nothing: no second refund, no `--` at
    // 0, no throw. This is the test that would fail if the guard in
    // `noteGhostDeparture` were dropped, or if `payGhostRefund` forgot to clear
    // `ghostMask`.
    const { state, world } = rig('erase-return-leg')
    corridor(state, world)
    commit(state, 0, START, ORTHO_ROUTE)
    runTicks(state, world, 0, 10)
    eraseGhostCell(state, world)
    expect(state.ghostCommitted[GHOST]).toBe(1)

    // Out to the end of the route (tick 61 overall), then flipped by hand — this
    // file has no destination, so the flip stands in for `arriveAtDestination`,
    // which is deliberately not an occupancy or ghost event either way.
    for (let t = 11; t <= 61; t++) runMovement(state, world)
    expect(state.carCell[0]).toBe(50)
    expect(tilesLeft(state), 'refunded once, on the outbound departure at tick 46').toBe(AFTER_BUILD + 1)
    expect(state.ghostMask[GHOST]).toBe(0)

    state.carPhase[0] = PHASE_RETURNING
    // **61 ticks, hand-computed rather than "enough".** The car carries 130
    // progress units past its arrival (this file's ORTHO ladder: 61 x 330 -
    // 8 x 2500 = 130), and the retrace pays the same 8 x 2500 = 20,000, so it is
    // home on the first tick with 130 + 330t >= 20,000, i.e. t = ceil(19,870 /
    // 330) = 61. Tick 60 leaves it one cell short, on 43 — which is how this
    // literal was checked rather than chosen.
    let reCrossed = false
    expect(() => {
      for (let t = 1; t <= 61; t++) {
        runMovement(state, world)
        if (state.carCell[0] === GHOST) reCrossed = true
      }
    }).not.toThrow()
    // Vacuity: the car genuinely went back OVER the erased cell. Without this
    // the test would pass on a car that never revisited it, which is the whole
    // scenario.
    expect(reCrossed, 'the car never re-crossed the ghost cell').toBe(true)
    expect(state.carCell[0]).toBe(START)
    expect(state.carRouteCursor[0]).toBe(0)
    expect(tilesLeft(state), 'exactly one refund, ever').toBe(AFTER_BUILD + 1)
    expect(state.ghostCommitted[GHOST]).toBe(0)
  })

  it('the EARLY CLEAR: a car s return crossing spends the last count while another car is still inbound', () => {
    // **The residual `dispatch.ts` derives, built rather than described.** The
    // test above shows a re-crossing cannot underflow or double-refund with ONE
    // committed car — but with one car the count reaches 0 on the outbound
    // departure and the return crossing finds no ghost, so it cannot reach the
    // case the derivation is actually about: **a decrement spent by a car that
    // has already cleared, while a car that has not is still on its way.** That
    // needs two cars, and it is the shape a reader would want to see before
    // accepting "the budget is exact and only the timing moves".
    //
    // Car 0 starts on 46 with a two-step route (47, 48) and is turned round by
    // hand at 48; car 1 starts on 42 with a six-step route and reaches 47 much
    // later. Ticks, from this file's ORTHO ladder and the carry:
    //
    //   car 0  enters 47 @8, enters 48 @16          -> DEPARTS 47 @16 (2 -> 1)
    //          flipped to RETURNING, carrying 280 units
    //          48->47 needs (2500-280)/330 -> 7 ticks   @23
    //          47->46 needs (2500-90)/330  -> 8 ticks   @31  -> DEPARTS 47 @31 (1 -> 0, REFUND)
    //   car 1  enters 47 @38, enters 48 @46          -> DEPARTS 47 @46 (no ghost left)
    //
    // So the refund lands on tick 31, while car 1 is still four cells short of
    // the ghost. Exactly one tile is returned, which is the half that matters.
    const { state, world } = rig('erase-early-clear')
    corridor(state, world)
    commit(state, 0, 46, [E, E])
    commit(state, 1, START, [E, E, E, E, E, E])
    eraseGhostCell(state, world)
    expect(state.ghostCommitted[GHOST], 'both cars are committed to the ghost').toBe(2)

    const refundTicks: number[] = []
    const departures: number[] = []
    let prevTiles = tilesLeft(state)
    let on0 = state.carCell[0] === GHOST
    let on1 = state.carCell[1] === GHOST
    let flipped = false
    for (let t = 1; t <= 60; t++) {
      runMovement(state, world)
      // Hand-turn car 0 the tick after its route runs out; this rig has no
      // destination, so this stands in for `arriveAtDestination`, which is
      // deliberately not a ghost event either way.
      if (!flipped && state.carRouteCursor[0] === 2) {
        state.carPhase[0] = PHASE_RETURNING
        flipped = true
      }
      const now0 = state.carCell[0] === GHOST
      const now1 = state.carCell[1] === GHOST
      if (on0 && !now0) departures.push(t)
      if (on1 && !now1) departures.push(t)
      on0 = now0
      on1 = now1
      const tiles = tilesLeft(state)
      if (tiles !== prevTiles) refundTicks.push(t)
      prevTiles = tiles
    }

    // Car 0 leaves the ghost twice (16 outbound, 31 returning) and car 1 once
    // (46). Asserted so the fixture cannot silently stop re-crossing.
    expect(departures).toEqual([16, 31, 46])
    // The refund lands on car 0's SECOND departure — early, by the standard of
    // "the last committed car clears", because car 1 has not reached it yet.
    expect(refundTicks).toEqual([31])
    // Which is the point: the timing moves, the BUDGET does not. One tile,
    // once, and no throw when car 1 finally crosses off a cell that is no
    // longer a ghost.
    expect(tilesLeft(state)).toBe(AFTER_BUILD + 1)
    expect(state.ghostMask[GHOST]).toBe(0)
    expect(state.ghostCommitted[GHOST]).toBe(0)
  })

  it('placing a road over the ghost pays the pending refund and charges the placement — net zero', () => {
    // §5.11's "refunds in full", and the budget property that matters for the
    // leaderboard: erase-then-replace nets EXACTLY zero, so nothing is printed
    // and nothing is confiscated. "Cancel the refund instead of paying it"
    // charges the player twice and shows up here as 989; "refund and charge
    // nothing" prints a tile and shows up as 991.
    const { state, world } = rig('erase-replace')
    corridor(state, world)
    commit(state, 0, START, ORTHO_ROUTE)
    runTicks(state, world, 0, 10)
    const beforeErase = tilesLeft(state)
    eraseGhostCell(state, world)
    expect(state.ghostCommitted[GHOST]).toBe(1)

    // One of the two segments back. Cell 47's mask is 0, so this costs 1 tile,
    // and its pending refund of 1 is paid in the same call.
    expect(placeRoad(state, world, 47, 48)).toBe(true)
    expect(tilesLeft(state), 'charged 1, refunded 1').toBe(beforeErase)
    expect(state.ghostMask[GHOST], 'the cell is no longer a ghost').toBe(0)
    expect(state.ghostCommitted[GHOST]).toBe(0)
    expect(roadMask(state, GHOST), 'and the road is live again').not.toBe(0)

    // The committed car crosses off 47 later and must NOT refund a second time:
    // the debt was settled by the placement.
    for (let t = 11; t <= 61; t++) runMovement(state, world)
    expect(tilesLeft(state), 'H_TILES after erase -> replace -> the car clearing').toBe(beforeErase)
  })

  it('survives a repeated erase / re-place cycle with the budget exactly restored, run FOUR times', () => {
    // The brief's third vacuity rule: **run the cycle more than once**, or
    // "print one tile per cycle" is indistinguishable from an off-by-one. Four
    // cycles, with the budget asserted after each, so a drift of one tile per
    // cycle is four tiles by the end and a single stray print is one.
    const { state, world } = rig('erase-replace-cycle')
    corridor(state, world)
    commit(state, 0, START, ORTHO_ROUTE)
    runTicks(state, world, 0, 10)
    const base = tilesLeft(state)

    const perCycle: number[] = []
    for (let cycle = 0; cycle < 4; cycle++) {
      eraseGhostCell(state, world)
      // The recount happens here on cycles 1..3: the cell was re-placed (and its
      // ghost cleared) at the end of the previous cycle, so `ghostCommitted` is
      // assigned from scratch rather than accumulated. Accumulating would read 2,
      // 3, 4 here.
      expect(state.ghostCommitted[GHOST], `cycle ${cycle}: recounted, not accumulated`).toBe(1)
      expect(placeRoad(state, world, 47, 48)).toBe(true)
      expect(placeRoad(state, world, 46, 47)).toBe(true)
      perCycle.push(tilesLeft(state))
    }
    // Every cycle erases 2 segments (refunding 1 for cell 47, deferred) and
    // replaces them (charging 1 for cell 47, since 46 and 48 still carry road,
    // and paying the 1 back). Net 0, every time.
    expect(perCycle).toEqual([base, base, base, base])
    expect(roadMask(state, GHOST)).not.toBe(0)
    expect(state.ghostMask[GHOST]).toBe(0)
  })

  it('ghost state survives snapshot and restore, and a restored run refunds on the same tick', () => {
    const { state, world, map } = rig('erase-snapshot')
    corridor(state, world)
    commit(state, 0, START, ORTHO_ROUTE)
    runTicks(state, world, 0, 10)
    eraseGhostCell(state, world)

    const saved = snapshot(state)
    const restored = restore(saved, world)
    expect(restored.ghostMask[GHOST]).toBe(GHOST_BIT)
    expect(restored.ghostCommitted[GHOST]).toBe(1)
    expect(hashState(restored)).toBe(hashState(state))
    expect(map.id).toBe('erase-snapshot') // the restore validated against this map

    // And the restored buffer behaves identically: the refund lands on the same
    // absolute tick in both runs. That is the Worker-cold-start property, and
    // it is the reason the ghost lives in the buffer rather than on `Scratch`.
    const tickOf = (s: GameState): number => {
      let prev = tilesLeft(s)
      for (let t = 11; t <= 50; t++) {
        runMovement(s, world)
        if (tilesLeft(s) !== prev) return t
        prev = tilesLeft(s)
      }
      return -1
    }
    expect(tickOf(restored)).toBe(46)
    expect(tickOf(state)).toBe(46)
    expect(hashState(restored)).toBe(hashState(state))
  })
})

describe('movement cannot re-path, by signature', () => {
  /**
   * The re-pathing mutation ("read `dir[carCell]` instead of the committed
   * route") is **not constructible against this module**, and that is the
   * point of the two structural assertions here. The BEHAVIOURAL version
   * needs a field whose CONTENT changes mid-flight — a nearer same-colour
   * destination gaining a pin after dispatch — which needs `syncFields` and
   * dispatch, and belongs to Task 6. Turning is NOT the discriminator:
   * dispatch commits `route[i] = dir[cell_i]`, so `dir[carCell] ===
   * route[carRouteCursor]` at every outbound tick by construction, on a
   * turning path exactly as much as on a straight one.
   */
  it('takes no fields and no scratch parameter', () => {
    expect(runMovement.length).toBe(2) // state, world — and nothing else
  })

  it('imports neither the flow field nor the scratch module, and never reads state.roads', () => {
    // A source assertion, in the idiom `determinism.test.ts` already uses:
    // the arity pin above can be defeated by reaching for a module-level
    // import, and this cannot. Matching on the import specifier rather than a
    // bare word keeps it immune to this file's own prose.
    const source = readFileSync(fileURLToPath(new URL('../src/cars.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/from '\.\/flowfield'/)
    expect(source).not.toMatch(/from '\.\/scratch'/)
    expect(source).not.toMatch(/state\s*\.\s*roads\s*\[/)
    expect(source).not.toMatch(/\bfield\w*\s*\.\s*dir\b/)
    // Vacuity: the scan is looking at the right file.
    expect(source).toMatch(/export function runMovement/)

    // And, in the same idiom and for a reason worth stating: the loop's speed
    // comes from `speedUnits`, not from a copy of the number. That linkage has
    // NO behavioural observer — `speedUnits(LANE_SPEED_DEFAULT)` and
    // `CAR_SPEED_UNITS_PER_TICK` are equal by definition of the identity
    // multiplier, so `const speed = 330` passes every test in this file
    // (verified: it survives the suite). What it would cost is a change to
    // `CAR_SPEED_UNITS_PER_TICK` that movement silently ignores while
    // `speedUnits` reports the new value.
    expect(source).toMatch(/const speed = speedUnits\(LANE_SPEED_DEFAULT\)/)
  })

  it('follows the committed route even when a live field disagrees with it at a cell it occupies', () => {
    // The brief's in-task substitute. It is honest about what it can show:
    // `runMovement` cannot be handed the field at all, so this documents the
    // consequence of the signature rather than probing a branch. The
    // fixture's `dir` genuinely contradicts the route — a car reading it would
    // reverse on its fourth cell — and the trace is unchanged.
    const { state, world, map } = rig('field-disagrees')
    const fields = createFlowFields(map.groupCount, world.cells)
    const dir = (fields[0] as { dir: Int8Array }).dir
    for (const cell of [START, ...ORTHO_CELLS]) dir[cell] = E
    dir[45] = W_DIR // on the car's path, and the exact reverse of the route

    commit(state, 0, START, ORTHO_ROUTE)
    // Vacuity: the field really does disagree, at a cell the car really does
    // stand on.
    expect(dir[45]).not.toBe(routeStep(state, 0, 3))
    expect(ORTHO_CELLS).toContain(45)

    const trace = runTicks(state, world, 0, 61)
    expect(trace.crossingTicks).toEqual(ORTHO_TICKS)
    expect(trace.cellPerTick).toEqual(perTickCells(START, ORTHO_CELLS, ORTHO_TICKS, 61))
    expect(state.carCell[0]).toBe(50)
  })
})

describe('movement is a pure function of the state buffer', () => {
  it('resumes a mid-flight trip identically after a snapshot/restore', () => {
    // The plan's specific warning: the cheapest thing to reach for in this
    // module is a JS-side cache outside the state buffer, which survives no
    // snapshot. Here the trip is cut in half by a round trip through bytes.
    const { state, world } = rig('snapshot')
    commit(state, 0, START, MIXED_ROUTE)
    runTicks(state, world, 0, 40)
    expect(state.carRouteCursor[0]).toBe(4) // mid-flight: crossings at 8,19,26,37
    expect(state.carProgress[0]).toBe(SPEED * 40 - 12000) // 13_200 - 12_000 = 1200

    const revived = restore(snapshot(state), world)
    const rest = runTicks(revived, world, 0, 33)

    expect(rest.crossingTicks).toEqual([4, 15, 23, 33]) // ticks 44, 55, 63, 73 overall
    expect(revived.carCell[0]).toBe(130)
    expect(revived.carProgress[0]).toBe(90)
  })
})

describe('off-manifold guards', () => {
  /**
   * `stepCell`'s bounds check, ONE `it()` PER BOUND. All four in a single test
   * reports only the first to break, so a regression in two of them looks like
   * a regression in one — and three of the four fail in genuinely different
   * ways, which is exactly the information a merged test throws away.
   *
   * Off-manifold throughout: `runDispatch`'s downhill walk breaks the moment a
   * step would leave the grid and refuses the route rather than committing it,
   * so only a hand-written or corrupted route reaches these. The alternative to
   * the throw is not a crash — it is a silent wrap onto a wrong-but-plausible
   * cell.
   */
  function expectOffGrid(id: string, cell: number, dir: number): void {
    const { state, world } = rig(id)
    commit(state, 0, cell, [dir])
    expect(() => {
      for (let t = 0; t < 8; t++) runMovement(state, world)
    }).toThrow(/step off the grid/)
    expect(state.carCell[0], 'the car moved despite the throw').toBe(cell)
    expect(state.carRouteCursor[0]).toBe(0)
  }

  it('throws stepping E off the last column, rather than wrapping onto the next row (x >= w)', () => {
    expect(39 % W).toBe(19) // (19, 1): the rightmost column
    // Without this bound the car lands on cell 40 = (0, 2) — the next row's
    // first column, a real cell the route never named.
    expectOffGrid('off-grid-east', 39, E)
  })

  it('throws stepping W off the first column, rather than wrapping onto the previous row (x < 0)', () => {
    expect(40 % W).toBe(0) // (0, 2): the leftmost column
    // The same row-seam hazard in the other direction — cell 39 = (19, 1) — and
    // the one an eastern-only fixture leaves untested. It survived until the
    // review caught it.
    expectOffGrid('off-grid-west', 40, W_DIR)
  })

  it('throws stepping S off the last row, rather than indexing past the grid (y >= h)', () => {
    expect((225 / W) | 0).toBe(H - 1) // (5, 11): the last row
    expectOffGrid('off-grid-south', 225, S)
  })

  it('throws stepping N off the first row (y < 0) — kept for symmetry, and disclosed as an equivalent mutant', () => {
    expect((5 / W) | 0).toBe(0) // (5, 0): the first row
    // Dropping this half of the guard is NOT detectable, and saying so is the
    // point: the retained `x` bounds fence `x` into `[0, w - 1]`, so for any
    // `y <= -1` the product `y * w + x` is at most `-1`. `advanceCar`'s own
    // `next < 0` arm therefore rejects every northern overrun regardless. The
    // case is exercised because the behaviour is required, not because this
    // test can observe which line delivers it.
    expectOffGrid('off-grid-north', 5, N)
  })

  it('throws on a corrupted route nibble rather than driving in a direction that does not exist', () => {
    // `packRouteStep` refuses to write a direction outside [0, 8), so this
    // writes the byte directly — the only way to produce a nibble of 8..15,
    // which a corrupted or replayed-from-corrupt buffer can hold.
    const { state, world } = rig('bad-nibble')
    commit(state, 0, START, ORTHO_ROUTE)
    state.carRoute[0 * ROUTE_BYTES] = 0x0d // step 0 = direction 13
    expect(() => runMovement(state, world)).toThrow(/direction index out of range/)
    // And the car stayed where it was, for the same reason its off-grid sibling
    // asserts it: a throw that has already half-written the slot is a different
    // and worse failure than a throw that has not.
    expect(state.carCell[0]).toBe(START)
    expect(state.carRouteCursor[0]).toBe(0)
    expect(state.carProgress[0]).toBe(0)
  })

  it('names the one-crossing-per-tick invariant when the constants stop supporting it', () => {
    // Reachable only through `constants.ts`: raise the speed above the
    // smallest threshold and movement would silently cap every car at one cell
    // per tick, discarding the excess — the invisible, uniform slowdown
    // decision 3 exists to prevent. Called directly, on the precedent of
    // `assertDispatchProgress`/`assertBucketCountExceedsEveryEdgeCost`.
    expect(() => assertSingleCrossing(ORTHO_T, ORTHO_T)).toThrow(/one crossing per car per tick/)
    expect(() => assertSingleCrossing(ORTHO_T - 1, ORTHO_T)).not.toThrow()

    // And the CALL SITE, which is what a bare unit test of the function above
    // cannot reach: with `speed` a parameter of `advanceCar`, a speed above
    // the smallest threshold is drivable from here. Residuals grow 3000 - 2500
    // = 500 per crossing — 500, 1000, 1500, 2000, then 2500, which is itself a
    // whole crossing. Deleting the call inside `advanceCar` makes this pass
    // silently with the car capped at one cell per tick, which is exactly the
    // failure the guard exists to name.
    const capped = rig('two-crossings')
    commit(capped.state, 0, START, ORTHO_ROUTE)
    expect(() => {
      for (let t = 0; t < 4; t++) advanceCar(capped.state, capped.world, 0, 3000)
    }).not.toThrow()
    expect(capped.state.carProgress[0]).toBe(2000)
    expect(() => advanceCar(capped.state, capped.world, 0, 3000)).toThrow(/one crossing per car per tick/)

    // The bound is the SMALLEST threshold, not the threshold just crossed —
    // and only a diagonal fixture can tell those apart. Crossing a diagonal
    // (3500) at speed 6000 leaves a residual of 2500: enough to cross the
    // orthogonal step that may come next, so it must throw, even though it is
    // below the 3500 the car just paid.
    const diagonal = rig('two-crossings-diag')
    commit(diagonal.state, 0, START, DIAG_ROUTE)
    expect(() => advanceCar(diagonal.state, diagonal.world, 0, 6000)).toThrow(/one crossing per car per tick/)
    expect(6000 - DIAG_T).toBe(2500) // the residual in question
    expect(6000 - DIAG_T).toBeLessThan(DIAG_T) // ...which the just-crossed threshold would wave through
    expect(6000 - DIAG_T).toBeGreaterThanOrEqual(ORTHO_T) // ...and the smallest threshold catches
    // And the real call site never trips it at M1c's constants: the residual
    // after any crossing is below the speed, which is below every threshold.
    const { state, world } = rig('invariant')
    commit(state, 0, START, MIXED_ROUTE)
    const trace = runTicks(state, world, 0, 73)
    // Progress never reaches the threshold of the edge being traversed. The
    // loose bound is DIAG_T, not ORTHO_T: on a diagonal edge progress
    // legitimately climbs to just under 3500 (2780 is the observed peak here),
    // and the sharp statement of the invariant is the per-crossing one below.
    for (const p of trace.progressPerTick) expect(p).toBeLessThan(DIAG_T)
    for (let k = 0; k < trace.crossingTicks.length; k++) {
      const t = trace.crossingTicks[k] as number
      expect(trace.progressPerTick[t - 1], `residual after crossing ${k + 1}`).toBeLessThan(SPEED)
    }
  })
})

describe('the direction tables movement leans on', () => {
  it('pairs every direction with its exact negation, so a return leg costs what the outbound did', () => {
    // `edgeCost(OPPOSITE[d]) === edgeCost(d)` for every d is what makes a
    // round trip hand-computable. Checked over all eight, not just the two the
    // fixtures use.
    for (let d = 0; d < 8; d++) {
      const o = OPPOSITE[d] as number
      // Summed rather than negated: `-(0)` is `-0`, which `toBe` (Object.is)
      // does not consider equal to the `0` the table holds.
      expect((DX[o] as number) + (DX[d] as number), `DX[${o}] is not -DX[${d}]`).toBe(0)
      expect((DY[o] as number) + (DY[d] as number), `DY[${o}] is not -DY[${d}]`).toBe(0)
      // Vacuity: a table of all zeroes would satisfy the sums above.
      expect(Math.abs(DX[d] as number) + Math.abs(DY[d] as number)).toBeGreaterThan(0)
    }
    expect(OPPOSITE[SE]).toBe(NW)
    expect(OPPOSITE[N]).toBe(4)
  })
})
