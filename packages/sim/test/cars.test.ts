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
import { createState, snapshot, restore, H_TILES, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFlowFields } from '../src/scratch'
import { packRouteStep, routeStep, ROUTE_BYTES } from '../src/dispatch'
import { placeRoad, eraseRoad, roadMask, tilesLeft, DX, DY, OPPOSITE } from '../src/roads'
import { PHASE_IDLE, PHASE_NONE, PHASE_OUTBOUND, PHASE_RETURNING } from '../src/buildings'
import { runMovement, advanceCar, speedUnits, assertSingleCrossing } from '../src/cars'

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
    // 85 * 1000 / 61 = 1393.44 -> 1393 at DENOM scale, against the exact 1400
    // the two thresholds imply (3500 / 2500). The 7-in-1400 gap (0.5%) is the
    // two ceilings, nothing else: the real-valued times are 20_000/330 =
    // 60.606 and 28_000/330 = 84.848, whose ratio is exactly 1.40.
    const ratioScaled = ((85 * 1000) / 61) | 0
    expect(ratioScaled).toBe(1393)
    expect(Math.abs(ratioScaled - 1400)).toBeLessThanOrEqual(14) // within 1%
    // And the two arrival ticks are genuinely different, so the ratio is not
    // 1.00 dressed up: an implementation that charges ORTHO_COST for a
    // diagonal arrives at 61 on both.
    expect(85).not.toBe(61)
  })

  it('arrives on a mixed orthogonal/diagonal path on its own hand-computed tick, not on either pure path`s', () => {
    const { state, world } = rig('mixed')
    commit(state, 0, START, MIXED_ROUTE)

    const trace = runTicks(state, world, 0, 73)

    expect(trace.crossingTicks).toEqual(MIXED_TICKS)
    expect(state.carCell[0]).toBe(130)
    // 330 * 73 - 24_000 = 24_090 - 24_000 = 90
    expect(state.carProgress[0]).toBe(90)

    // Neither pure-path answer: a per-edge-normalised offset (every cell the
    // same duration) arrives at 8 * 8 = 64, an all-ortho pricing at 61, an
    // all-diagonal pricing at 85.
    expect(73).not.toBe(64)
    expect(73).not.toBe(61)
    expect(73).not.toBe(85)

    // Vacuity: the mixed fixture really is mixed, and its steps really do
    // change direction from one to the next — a nibble swap of two EQUAL
    // directions is the identity, so without an adjacent differing pair the
    // cell trace below could not see one.
    expect(MIXED_ROUTE.filter((d) => d === E).length).toBe(4)
    expect(MIXED_ROUTE.filter((d) => d === SE).length).toBe(4)
    expect(adjacentDifferingPairs(MIXED_ROUTE)).toBe(7)
  })

  it('stands on the exact hand-computed cell on every single tick of a mixed path', () => {
    // THE ONLY BULLET THAT SEES A NIBBLE-ORDER SWAP. Swapping the order of
    // each pair of steps leaves the endpoint unchanged (displacement vectors
    // commute), leaves the total cost and therefore the arrival tick unchanged
    // (the multiset of steps is unchanged), and arrival is cursor-driven
    // rather than position-driven, so the mutant still "arrives" — standing on
    // the wrong cell for most of the trip. Only a cell-by-cell trace differs:
    // the swapped route is SE,E,SE,E,... which is at cell 42 on tick 8 where
    // the committed route is already at 43.
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
    const { state, world } = rig('no-move')
    commit(state, 0, START, ORTHO_ROUTE) // the driver

    commit(state, 1, START, ORTHO_ROUTE) // outbound but already exhausted
    state.carRouteCursor[1] = 8

    commit(state, 2, START, ORTHO_ROUTE) // a full route, but idle
    state.carPhase[2] = PHASE_IDLE

    commit(state, 3, START, ORTHO_ROUTE) // a full route, but never created
    state.carPhase[3] = PHASE_NONE

    commit(state, 4, START, ORTHO_ROUTE) // returning, already home
    state.carPhase[4] = PHASE_RETURNING
    state.carRouteCursor[4] = 0

    for (let t = 0; t < 61; t++) runMovement(state, world)

    // The driver drove.
    expect(state.carCell[0]).toBe(50)
    expect(state.carRouteCursor[0]).toBe(8)

    // Nobody else moved, and — the part a looser assertion would miss — nobody
    // else banked progress either. An exhausted car is one arrivals has not
    // collected yet; letting it accumulate would credit the next leg with time
    // it did not spend driving.
    for (const car of [1, 2, 3, 4]) {
      expect(state.carCell[car], `car ${car} moved`).toBe(START)
      expect(state.carProgress[car], `car ${car} banked progress`).toBe(0)
    }
    expect(state.carRouteCursor[1]).toBe(8)
    expect(state.carRouteCursor[2]).toBe(0)
    expect(state.carRouteCursor[3]).toBe(0)
    expect(state.carRouteCursor[4]).toBe(0)
    // Vacuity: each of those cars really did hold a live route, so "did not
    // move" is a decision about its phase/cursor and not about an empty slot.
    for (const car of [1, 2, 3, 4]) expect(state.carRouteLen[car]).toBe(8)
  })
})

describe('a road erased under an in-flight car', () => {
  it('refunds immediately and does not touch the car, which arrives on the same tick', () => {
    // Decision 6's stated, deliberate deviation from spec §5.11's delayed
    // "ghost lane" refund: the player briefly gets a free tile, and the car
    // completes its committed route regardless. Movement never reads `roads`.
    const { state, world } = rig('erase')
    // The corridor the route runs along: cells 42..50 on row 2.
    for (let x = 2; x < 10; x++) {
      const ok = placeRoad(state, world, 42 + (x - 2), 43 + (x - 2))
      expect(ok, `failed to place ${x}`).toBe(true)
    }
    // 2 tiles for the first segment (both endpoints new), 1 for each of the
    // other seven: 999 - 9 = 990.
    expect(tilesLeft(state)).toBe(990)
    expect(roadMask(state, 50)).not.toBe(0)

    commit(state, 0, START, ORTHO_ROUTE)

    const before = runTicks(state, world, 0, 30)
    // Vacuity: at tick 30 the car has crossed three cells (ticks 8, 16, 23 —
    // the fourth is tick 31) and stands on 45, so the segment erased next is
    // genuinely ahead of it and genuinely still unvisited.
    expect(before.crossingTicks).toEqual([8, 16, 23])
    expect(state.carCell[0]).toBe(45)

    const tilesBefore = state.header[H_TILES] as number
    expect(eraseRoad(state, world, 49, 50)).toBe(true)
    // The refund landed on the erase itself, not on the car's arrival: cell 50
    // has no road bits left, so one tile comes back immediately.
    expect(state.header[H_TILES]).toBe(tilesBefore + 1)
    expect(tilesLeft(state)).toBe(991)
    expect(roadMask(state, 50)).toBe(0) // vacuity: the road really is gone
    expect(roadMask(state, 49)).not.toBe(0)

    const after = runTicks(state, world, 0, 31)
    // Unchanged: the same hand-computed crossing ticks, offset by the 30 ticks
    // already run, and the same arrival cell.
    expect(after.crossingTicks).toEqual([1, 8, 16, 24, 31]) // ticks 31, 38, 46, 54, 61 overall
    expect(state.carCell[0]).toBe(50)
    expect(state.carRouteCursor[0]).toBe(8)
    expect(state.carProgress[0]).toBe(130)
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
  it('throws rather than wrapping the row seam when a hand-written route leaves the board', () => {
    // Unreachable through `runDispatch` — its downhill walk breaks the moment
    // a step would leave the grid and the route is refused, never committed.
    // Reachable through a hand-written or corrupted route, where the
    // alternative is not a crash but a silent wrap onto the next row.
    const { state, world } = rig('off-grid')
    commit(state, 0, 39, [E]) // (19, 1): the rightmost column
    expect(39 % W).toBe(19)
    expect(() => {
      for (let t = 0; t < 8; t++) runMovement(state, world)
    }).toThrow(/step off the grid/)
    expect(state.carCell[0]).toBe(39) // and it did not move onto cell 40 = (0, 2)
  })

  it('throws on a corrupted route nibble rather than driving in a direction that does not exist', () => {
    // `packRouteStep` refuses to write a direction outside [0, 8), so this
    // writes the byte directly — the only way to produce a nibble of 8..15,
    // which a corrupted or replayed-from-corrupt buffer can hold.
    const { state, world } = rig('bad-nibble')
    commit(state, 0, START, ORTHO_ROUTE)
    state.carRoute[0 * ROUTE_BYTES] = 0x0d // step 0 = direction 13
    expect(() => runMovement(state, world)).toThrow(/direction index out of range/)
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
