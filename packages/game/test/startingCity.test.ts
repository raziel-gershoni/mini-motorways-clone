import { describe, it, expect } from 'vitest'
import {
  firstCity,
  TERRAIN,
  ORTHO_COST,
  DIAG_COST,
  COST_UNIT_SCALE,
  CAR_SPEED_UNITS_PER_TICK,
  PIN_PERIOD_TICKS,
  FIRST_PIN_DELAY_TICKS,
  CARS_PER_HOUSE,
  type MapData,
} from '@laneways/shared'
import {
  createState,
  createWorld,
  createScratch,
  createFlowFields,
  createFieldInputRanges,
  hashState,
  step,
  fieldFor,
  tilesLeft,
  carparkCell,
  isFootprintCell,
  destMetaColour,
  destMetaKind,
  destMetaOrientation,
  placeDestination,
  placeHouse,
  placeRoad,
  hasTree,
  DEST_KIND_SQUARE,
  DEST_KIND_CIRCLE,
  ORIENTATION_E,
  ORIENTATION_W,
  PHASE_IDLE,
  PHASE_OUTBOUND,
  H_DEST_COUNT,
  H_HOUSE_COUNT,
  H_PINS_DROPPED,
  H_ROUTES_REFUSED,
  H_SCORE,
  H_TICK,
  H_TILES,
  type FlowField,
  type GameState,
  type Scratch,
  type TickAction,
  type TickInputs,
  type WorldData,
} from '@laneways/sim'
import {
  seedStartingCity,
  STARTING_DESTINATIONS,
  STARTING_HOUSES,
  type SeedDestination,
  type SeedHouse,
} from '../src/startingCity'

/**
 * The hand-authored starting city, and the first end-to-end evidence in this
 * project that the simulation is a *game*: a car leaves a house, reaches a
 * destination, comes home, and the score reads 1.
 *
 * ---------------------------------------------------------------------------
 * EVERY LITERAL IN THIS FILE IS HAND-WRITTEN, and that is the point
 * ---------------------------------------------------------------------------
 *
 * `startingCity.ts` stores each building as an (x, y) pair and converts with
 * `y * world.w + x` at seed time. This file stores the FLAT CELL INDEX,
 * computed by hand from `firstCity`'s 24 x 40 grid, and never calls that
 * conversion. The two representations are independent derivations of the same
 * fact, so a transposed axis, an off-by-one, or a width taken from the wrong
 * map fails here rather than agreeing with itself.
 *
 * `firstCity` rows (0-indexed), for anyone re-checking a literal:
 *
 *   row 10  '............~...T.......'   river at x=12, tree at x=16
 *   row 11  '............~...........'
 *   row 13  '............~.........T.'
 *   row 14  '............~...........'
 *   row 15  '.........T..~...........'   tree at x=9
 *   row 18  '........................'   the bridgeable gap: NO river
 *   row 19  '........................'   the bridgeable gap: NO river
 *   row 24  '............~........T..'
 *
 * ---------------------------------------------------------------------------
 * THE CITY
 * ---------------------------------------------------------------------------
 *
 *              x=8   9  10  11        14  15  16  17
 *      y=10   [cp0][##][##][##]                          D0  colour 0, square
 *      y=11        [##][##][##]
 *      y=13   (H1)                                       house 1, colour 0
 *      y=14                          [##][##][##][cp2]   D2  colour 1, circle
 *      y=15                          [##][##][##]
 *      y=18   [cp1][##][##][##]                    (H2)  D1  colour 0, square
 *      y=19        [##][##][##]                          house 2, colour 1
 *      y=24   (H0)                                       house 0, colour 0
 *
 * Everything sits west of the river (column 12) except D2/H2, which sit east
 * of it; no same-colour pair is split across it, so the two-cell bridgeable
 * gap at rows 18-19 is avoided DELIBERATELY rather than by accident.
 *
 * ---------------------------------------------------------------------------
 * THE TIMELINE, hand-derived from the constants and never read back
 * ---------------------------------------------------------------------------
 *
 * `placeDestination` stamps `destSpawnTick` from `H_TICK`, which is 0 at seed
 * time, so every destination is ineligible until `tick >= 120`
 * (`FIRST_PIN_DELAY_TICKS`). From tick 120 the colour's accumulator gains
 * `slotCount` per tick and fires at `PIN_PERIOD_TICKS` = 518.
 *
 *   colour 0: two squares -> slotCount 2 -> acc = 2 * (t - 119)
 *             fires when 2 * (t - 119) >= 518, i.e. t >= 378.
 *   colour 1: one circle  -> slotCount 2 -> also t >= 378 (unserved: no road
 *             east, so it never dispatches inside this file's windows).
 *
 * Movement gains `CAR_SPEED_UNITS_PER_TICK` = 330 per tick against a threshold
 * of `edgeCost(dir) * COST_UNIT_SCALE` (2500 orthogonal, 3500 diagonal), and
 * the remainder carries across every crossing AND across the outbound->return
 * flip. So crossing k lands on the first tick whose accumulated progress
 * reaches the cumulative cost `C_k`, i.e. `n_k = ceil(C_k / 330)`, with the
 * dispatch tick itself counting as `n = 1` (dispatch is phase 5, movement
 * phase 6, same tick). Absolute tick = `dispatchTick + n_k - 1`.
 */

// --- The board: firstCity is 24 x 40, cell = y * 24 + x ---------------------

const GRID_W = 24
const GRID_H = 40

/**
 * The revealed rect M2 draws (plan Decision 5). Task 3 freezes these as four
 * exported constants in `shared`; this task must not touch `shared`, so they
 * are hand-written here and Task 3 replaces them.
 */
const REVEALED_X0 = 5
const REVEALED_Y0 = 9
const REVEALED_X1 = 18 // inclusive
const REVEALED_Y1 = 30 // inclusive

// --- Hand-computed flat cell indices ----------------------------------------

const D0_ORIGIN = 249 // (9, 10)
const D0_CARPARK = 248 // (8, 10)
const D1_ORIGIN = 441 // (9, 18)
const D1_CARPARK = 440 // (8, 18)
const D2_ORIGIN = 350 // (14, 14)
const D2_CARPARK = 353 // (17, 14)

const H0_CELL = 584 // (8, 24)  colour 0 — the FARTHER colour-0 house
const H1_CELL = 320 // (8, 13)  colour 0 — the NEARER colour-0 house
const H2_CELL = 449 // (17, 18) colour 1

/**
 * `packDestMeta` = `colour | (kind << 3) | (orientation << 4)`, computed by
 * hand: D0/D1 are colour 0, square (0), orientation W (3) -> 3 << 4 = 48;
 * D2 is colour 1, circle (1 << 3 = 8), orientation E (1 << 4 = 16) -> 25.
 */
const D0_META = 48
const D1_META = 48
const D2_META = 25

/** Every cell the seed occupies: 3 destinations x (6 footprint + 1 carpark) + 3 houses. */
const OCCUPIED_CELLS: readonly number[] = [
  // D0 footprint (9..11, 10..11), then its carpark
  249, 250, 251, 273, 274, 275, 248,
  // D1 footprint (9..11, 18..19), then its carpark
  441, 442, 443, 465, 466, 467, 440,
  // D2 footprint (14..16, 14..15), then its carpark
  350, 351, 352, 374, 375, 376, 353,
  // houses
  584, 320, 449,
]

// --- The first trip: house 1 -> D0's carpark --------------------------------

/**
 * (8,13) -> (7,12) -> (7,11) -> (8,10). Four cells, three 8-adjacent
 * segments, deliberately NOT a straight line: it turns twice and two of its
 * three steps are diagonal, so the round-trip arithmetic below is degenerate
 * under neither "everything is orthogonal" nor "no route ever turns".
 */
const TRIP_PATH: readonly number[] = [320, 295, 271, 248]

/** Step directions the flow field must commit, hand-read off the path: NW, N, NE. */
const TRIP_ROUTE_LEN = 3

/**
 * Round trip cost, hand-summed: NW (diagonal, 14) + N (orthogonal, 10) + NE
 * (diagonal, 14) = 38 cost units out, and the return leg retraces the same
 * three edges (`edgeCost(OPPOSITE[d]) === edgeCost(d)`), so 76 in total.
 * In progress units: 76 * 250 = 19,000; at 330/tick that is
 * ceil(19000 / 330) = 58 movement ticks.
 */
const TRIP_ROUND_TRIP_COST_UNITS = 19000
const TRIP_MOVEMENT_TICKS = 58

/** 119 + ceil(518 / 2). The first tick on which colour 0's accumulator reaches 518. */
const FIRST_PIN_TICK = 378
/** `FIRST_PIN_TICK + TRIP_MOVEMENT_TICKS - 1`. */
const FIRST_SCORE_TICK = 435
/** Comfortably past `FIRST_SCORE_TICK`, and the assertion below is that it is never reached. */
const TRIP_TICK_BOUND = 500

// --- The not-nearest demonstration: the full corridor, drawn late -----------

/** Column x=8 from y=10 to y=24: 15 cells, 14 segments, 15 tiles. */
const CORRIDOR: readonly number[] = [
  248, 272, 296, 320, 344, 368, 392, 416, 440, 464, 488, 512, 536, 560, 584,
]

const SECOND_PIN_TICK = 637 // FIRST_PIN_TICK + ceil(518 / 2)
const CORRIDOR_TICK = 638
const NEAREST_SCORE_TICK = 683 // 638 + ceil(6 * 2500 / 330) - 1 = 638 + 46 - 1
const NOT_NEAREST_SCORE_TICK = 728 // 638 + ceil(12 * 2500 / 330) - 1 = 638 + 91 - 1
const SINGLE_SOURCE_TICK = 661 // the first tick on which D1's carpark is colour 0's only source
const DEMO_TICK_BOUND = 800

const NO_ACTIONS: TickInputs = { actions: [] }

interface Rig {
  readonly map: MapData
  readonly world: WorldData
  readonly state: GameState
  readonly scratch: Scratch
  readonly fields: FlowField[]
}

/**
 * The seed string is fixed because `hashState` folds `rng[0]`, so the golden
 * below is a golden over (this seed, firstCity, this city) and nothing else.
 * Production picks its own seed; that moves this hash and no behaviour.
 */
const SEED = 'm2-starting-city'

function makeRig(): Rig {
  const map = firstCity()
  const world = createWorld(map)
  return {
    map,
    world,
    state: createState(SEED, map),
    scratch: createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map)),
    fields: createFlowFields(map.groupCount, world.cells),
  }
}

function seededRig(): Rig {
  const rig = makeRig()
  seedStartingCity(rig.state, rig.world)
  return rig
}

/** `place` actions along a cell path, exactly as a drag would emit them. */
function pathActions(path: readonly number[]): TickAction[] {
  const out: TickAction[] = []
  for (let i = 0; i + 1 < path.length; i++) {
    out.push({ kind: 'place', a: path[i] as number, b: path[i + 1] as number })
  }
  return out
}

function xOf(cell: number): number {
  return cell % GRID_W
}

function yOf(cell: number): number {
  return (cell / GRID_W) | 0
}

/**
 * Every cell the SEEDED STATE actually occupies, derived through the sim's own
 * geometry rather than from this file's literals. `OCCUPIED_CELLS` above is the
 * independent hand-written derivation of the same set, and one test pins the
 * two together; the rect and terrain assertions run over this one, so a
 * building moved off the board's good ground fails them directly.
 */
function occupiedCells(state: GameState, world: WorldData): number[] {
  const out: number[] = []
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    const destCell = state.destCell[d] as number
    const orientation = destMetaOrientation(state.destMeta[d] as number)
    for (let cell = 0; cell < world.cells; cell++) {
      if (isFootprintCell(destCell, orientation, world.w, cell)) out.push(cell)
    }
    out.push(carparkCell(destCell, orientation, world.w, world.h))
  }
  const houseCount = state.header[H_HOUSE_COUNT] as number
  for (let h = 0; h < houseCount; h++) out.push(state.houseCell[h] as number)
  return out
}

// ---------------------------------------------------------------------------
// 1. The literals themselves
// ---------------------------------------------------------------------------

describe('the seed table', () => {
  it('holds exactly three destinations and three houses, in the documented order', () => {
    expect(STARTING_DESTINATIONS.length).toBe(3)
    expect(STARTING_HOUSES.length).toBe(3)
  })

  it('places every building at the hand-computed (x, y) — the seed side of the two derivations', () => {
    // Asserted against literals rather than against `y * w + x` of anything,
    // so this file and `startingCity.ts` can only agree by both being right.
    expect(STARTING_DESTINATIONS[0]).toEqual({
      x: 9,
      y: 10,
      orientation: ORIENTATION_W,
      colour: 0,
      kind: DEST_KIND_SQUARE,
    })
    expect(STARTING_DESTINATIONS[1]).toEqual({
      x: 9,
      y: 18,
      orientation: ORIENTATION_W,
      colour: 0,
      kind: DEST_KIND_SQUARE,
    })
    expect(STARTING_DESTINATIONS[2]).toEqual({
      x: 14,
      y: 14,
      orientation: ORIENTATION_E,
      colour: 1,
      kind: DEST_KIND_CIRCLE,
    })
    expect(STARTING_HOUSES[0]).toEqual({ x: 8, y: 24, colour: 0 })
    expect(STARTING_HOUSES[1]).toEqual({ x: 8, y: 13, colour: 0 })
    expect(STARTING_HOUSES[2]).toEqual({ x: 17, y: 18, colour: 1 })
  })

  it('uses only colours this map actually has (placeHouse THROWS on an out-of-range colour)', () => {
    const { groupCount } = firstCity()
    expect(groupCount).toBe(5)
    for (let i = 0; i < STARTING_DESTINATIONS.length; i++) {
      expect((STARTING_DESTINATIONS[i] as { colour: number }).colour).toBeLessThan(groupCount)
    }
    for (let i = 0; i < STARTING_HOUSES.length; i++) {
      expect((STARTING_HOUSES[i] as { colour: number }).colour).toBeLessThan(groupCount)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Every placement call succeeds — asserted PER CALL, not in aggregate
// ---------------------------------------------------------------------------

describe('every placement the seed makes is accepted', () => {
  /**
   * The brief's requirement, spelled the way it is meant: one `toBe(true)` per
   * call. A silent `false` is exactly how a seed ends up half-placed, and an
   * aggregate count assertion cannot say WHICH building was dropped.
   *
   * The literals here are this file's own flat cell indices, applied in the
   * seed's own order (destinations first, so `canPlaceHouse`'s
   * destination-overlap check has something to reject against). Running them
   * against a fresh state rather than reading `seedStartingCity`'s internals
   * is what makes each call's return value visible at all.
   */
  it('placeDestination returns true for each of the three destinations, in order', () => {
    const { state, world } = makeRig()
    expect(placeDestination(state, world, D0_ORIGIN, ORIENTATION_W, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(state, world, D1_ORIGIN, ORIENTATION_W, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(state, world, D2_ORIGIN, ORIENTATION_E, 1, DEST_KIND_CIRCLE)).toBe(true)
    expect(state.header[H_DEST_COUNT] as number).toBe(3)
  })

  it('placeHouse returns true for each of the three houses, in order, after the destinations', () => {
    const { state, world } = makeRig()
    expect(placeDestination(state, world, D0_ORIGIN, ORIENTATION_W, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(state, world, D1_ORIGIN, ORIENTATION_W, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(state, world, D2_ORIGIN, ORIENTATION_E, 1, DEST_KIND_CIRCLE)).toBe(true)
    expect(placeHouse(state, world, H0_CELL, 0)).toBe(true)
    expect(placeHouse(state, world, H1_CELL, 0)).toBe(true)
    expect(placeHouse(state, world, H2_CELL, 1)).toBe(true)
    expect(state.header[H_HOUSE_COUNT] as number).toBe(3)
  })

  /**
   * **The two `false`-return guards need one test each, and this is why.**
   * `seedStartingCity` places destinations first, so on any input that would
   * reject both, the DESTINATION guard throws first and the house guard is
   * never reached — deleting the house-side check alone then has zero
   * detectors while the compound stays caught. That is the catalogue's "a
   * caught compound does not mean each half is", and it matters here because
   * Task 9 calls this function. So: one fixture that can only fail on a
   * destination, one that can only fail on a house.
   */
  it('throws naming the DESTINATION when a destination is what fails', () => {
    // Seeding twice: the second pass hits its own destinations' spacing rule
    // before it ever reaches a house. The point is the FAILURE MODE — a
    // rejected placement is loud, not a silent `false` nobody reads.
    const { state, world } = seededRig()
    expect(() => seedStartingCity(state, world)).toThrow(/destination 0 at \(9, 10\)/)
  })

  it('throws naming the HOUSE when a house is what fails — reached only when every destination places', () => {
    // A road across house 0's cell, laid before the seed runs. `canPlaceHouse`
    // rejects it with 'road'; every destination still places cleanly, because
    // neither road cell — (8,23) and (8,24) — touches any destination's 7
    // cells. So this fixture reaches the house guard and nothing else.
    const { state, world } = makeRig()
    expect(placeRoad(state, world, 560, H0_CELL)).toBe(true)
    expect(() => seedStartingCity(state, world)).toThrow(/house 0 at \(8, 24\)/)
  })

  it('freezes both tables at runtime, so a consumer cannot edit the city in place', () => {
    // `readonly` on the exported type is a type-level assertion with no
    // runtime effect. `Object.freeze` on the arrays AND on each entry is the
    // half that actually holds, and it needs an observer of its own or the
    // comment claiming it is load-bearing is the only thing asserting it.
    expect(Object.isFrozen(STARTING_DESTINATIONS)).toBe(true)
    expect(Object.isFrozen(STARTING_HOUSES)).toBe(true)
    expect(Object.isFrozen(STARTING_DESTINATIONS[0] as SeedDestination)).toBe(true)
    expect(Object.isFrozen(STARTING_HOUSES[0] as SeedHouse)).toBe(true)
    // Test modules are ESM and therefore strict, so the write throws rather
    // than failing silently — and the value is unchanged either way.
    expect(() => {
      ;(STARTING_HOUSES[0] as { x: number }).x = 99
    }).toThrow(TypeError)
    expect((STARTING_HOUSES[0] as SeedHouse).x).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// 3. What the seed actually wrote into state
// ---------------------------------------------------------------------------

describe('the seeded state', () => {
  it('reports exactly three houses and three destinations', () => {
    const { state } = seededRig()
    expect(state.header[H_HOUSE_COUNT] as number).toBe(3)
    expect(state.header[H_DEST_COUNT] as number).toBe(3)
  })

  it('stores each destination at the hand-computed flat cell, with the hand-computed packed meta', () => {
    const { state } = seededRig()
    expect(state.destCell[0] as number).toBe(D0_ORIGIN)
    expect(state.destCell[1] as number).toBe(D1_ORIGIN)
    expect(state.destCell[2] as number).toBe(D2_ORIGIN)
    expect(state.destMeta[0] as number).toBe(D0_META)
    expect(state.destMeta[1] as number).toBe(D1_META)
    expect(state.destMeta[2] as number).toBe(D2_META)
  })

  it('unpacks that meta back to the colours, kinds and orientations the city intends', () => {
    const { state } = seededRig()
    expect(destMetaColour(state.destMeta[0] as number)).toBe(0)
    expect(destMetaColour(state.destMeta[1] as number)).toBe(0)
    expect(destMetaColour(state.destMeta[2] as number)).toBe(1)
    expect(destMetaKind(state.destMeta[0] as number)).toBe(DEST_KIND_SQUARE)
    expect(destMetaKind(state.destMeta[1] as number)).toBe(DEST_KIND_SQUARE)
    expect(destMetaKind(state.destMeta[2] as number)).toBe(DEST_KIND_CIRCLE)
    expect(destMetaOrientation(state.destMeta[0] as number)).toBe(ORIENTATION_W)
    expect(destMetaOrientation(state.destMeta[1] as number)).toBe(ORIENTATION_W)
    expect(destMetaOrientation(state.destMeta[2] as number)).toBe(ORIENTATION_E)
  })

  it('puts each carpark exactly where the hand-written literal says', () => {
    const { state, world } = seededRig()
    expect(carparkCell(state.destCell[0] as number, ORIENTATION_W, world.w, world.h)).toBe(D0_CARPARK)
    expect(carparkCell(state.destCell[1] as number, ORIENTATION_W, world.w, world.h)).toBe(D1_CARPARK)
    expect(carparkCell(state.destCell[2] as number, ORIENTATION_E, world.w, world.h)).toBe(D2_CARPARK)
  })

  it('stores each house at the hand-computed flat cell, with its colour', () => {
    const { state } = seededRig()
    expect(state.houseCell[0] as number).toBe(H0_CELL)
    expect(state.houseCell[1] as number).toBe(H1_CELL)
    expect(state.houseCell[2] as number).toBe(H2_CELL)
    expect(state.houseColour[0] as number).toBe(0)
    expect(state.houseColour[1] as number).toBe(0)
    expect(state.houseColour[2] as number).toBe(1)
  })

  it('creates CARS_PER_HOUSE idle cars per house and no others', () => {
    const { state } = seededRig()
    expect(CARS_PER_HOUSE).toBe(2)
    for (let h = 0; h < 3; h++) {
      for (let i = 0; i < CARS_PER_HOUSE; i++) {
        const c = h * CARS_PER_HOUSE + i
        expect(state.carPhase[c] as number).toBe(PHASE_IDLE)
        expect(state.carHome[c] as number).toBe(h)
        expect(state.carTargetDest[c] as number).toBe(-1)
      }
    }
    // Slot 6 is the first past the live prefix and must still read "does not exist".
    expect(state.carPhase[6] as number).toBe(0)
  })

  it('stamps destSpawnTick at 0, which is what puts the first pin at tick 378 and not earlier', () => {
    const { state } = seededRig()
    expect(state.header[H_TICK] as number).toBe(0)
    expect(state.destSpawnTick[0] as number).toBe(0)
    expect(state.destSpawnTick[1] as number).toBe(0)
    expect(state.destSpawnTick[2] as number).toBe(0)
  })

  it('spends no tiles and lays no road — the seed is buildings only', () => {
    const { state, map } = seededRig()
    expect(map.startingTiles).toBe(30)
    expect(tilesLeft(state)).toBe(30)
    expect(state.header[H_TILES] as number).toBe(30)
    let roadCells = 0
    for (let cell = 0; cell < state.roads.length; cell++) {
      if ((state.roads[cell] as number) !== 0) roadCells++
    }
    expect(roadCells).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. The constraints the literals had to satisfy
// ---------------------------------------------------------------------------

describe('the constraints on the literals', () => {
  it('occupies 24 distinct cells — 3 x (6 footprint + 1 carpark) + 3 houses', () => {
    const { state, world } = seededRig()
    const occupied = occupiedCells(state, world)
    expect(occupied.length).toBe(24)
    expect(new Set(occupied).size).toBe(24)
    expect(OCCUPIED_CELLS.length).toBe(24)
    expect(new Set(OCCUPIED_CELLS).size).toBe(24)
  })

  it('agrees with the sim about which cells those are', () => {
    // The literal list is one derivation and `isFootprintCell`/`carparkCell`/
    // `houseCell` over the real seeded state is another. This is the test that
    // pins them to each other; the two below then run over the STATE-derived
    // list, so a building moved out of the rect (or onto water) fails them
    // directly rather than only through this one.
    const { state, world } = seededRig()
    expect(occupiedCells(state, world).slice().sort((a, b) => a - b)).toEqual(
      OCCUPIED_CELLS.slice().sort((a, b) => a - b),
    )
  })

  it('keeps every occupied cell inside the revealed rect — outside it the seed is a lie', () => {
    const { state, world } = seededRig()
    const occupied = occupiedCells(state, world)
    expect(occupied.length).toBe(24)
    for (let i = 0; i < occupied.length; i++) {
      const cell = occupied[i] as number
      expect(xOf(cell), `cell ${cell} x`).toBeGreaterThanOrEqual(REVEALED_X0)
      expect(xOf(cell), `cell ${cell} x`).toBeLessThanOrEqual(REVEALED_X1)
      expect(yOf(cell), `cell ${cell} y`).toBeGreaterThanOrEqual(REVEALED_Y0)
      expect(yOf(cell), `cell ${cell} y`).toBeLessThanOrEqual(REVEALED_Y1)
    }
  })

  /**
   * **The river-column half of this has a real detector, and it is the one
   * that is not subsumed.** Flipping D1 from `ORIENTATION_W` to
   * `ORIENTATION_E` moves its carpark to (12, 18) — column 12, but on one of
   * the two rows (18 and 19) where the river has its bridgeable gap, so the
   * cell is LAND and `canPlaceDestination` ACCEPTS it. Nothing else in this
   * file sees that: the counts are right, the placements all return `true`,
   * and only `expect(xOf(cell)).not.toBe(12)` fires. A building parked in the
   * river's column is exactly the accident the "avoid the river deliberately"
   * decision exists to prevent.
   *
   * The `TERRAIN.LAND` and `hasTree` halves ARE subsumed and are disclosed as
   * such: `canPlaceHouse`/`canPlaceDestination` already reject a non-passable
   * cell and a standing tree, and the seed lays no road, so `cleared` is
   * all-zero and nothing can have been felled. They are kept on the same
   * "cheap, independently correct, currently subsumed" reasoning `roads.ts`'s
   * terrain whitelist documents — the thing subsuming them is a property of
   * `buildings.ts`, not of this seed.
   */
  it('keeps every occupied cell on LAND with no standing tree, and off the river column', () => {
    const { state, world } = seededRig()
    const occupied = occupiedCells(state, world)
    expect(occupied.length).toBe(24)
    for (let i = 0; i < occupied.length; i++) {
      const cell = occupied[i] as number
      expect(world.terrain[cell] as number, `cell ${cell} terrain`).toBe(TERRAIN.LAND)
      expect(world.passable[cell] as number, `cell ${cell} passable`).toBe(1)
      expect(hasTree(state, world, cell), `cell ${cell} tree`).toBe(false)
      expect(xOf(cell), `cell ${cell} is in the river column`).not.toBe(12)
    }
  })

  it('is a board the fixture literals actually match: firstCity is 24 x 40 with 5 colour groups', () => {
    // Every flat literal in this file is `y * 24 + x`. If the map ever changes
    // width, this fails here rather than silently addressing other cells.
    const map = firstCity()
    expect(map.w).toBe(GRID_W)
    expect(map.h).toBe(GRID_H)
    expect(map.groupCount).toBe(5)
    expect(map.maxHouses).toBeGreaterThanOrEqual(3)
    expect(map.maxDestinations).toBeGreaterThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// 5. The golden
// ---------------------------------------------------------------------------

describe('the seeded-state golden', () => {
  it('pins hashState over the whole seeded buffer', () => {
    const { state } = seededRig()
    // Guards FIRST, so this is a golden over a city and not over an empty
    // board that happened to hash to something (M1b's road-network golden
    // nearly shipped that way).
    expect(state.header[H_HOUSE_COUNT] as number).toBe(3)
    expect(state.header[H_DEST_COUNT] as number).toBe(3)
    expect(state.destCell[2] as number).toBe(D2_ORIGIN)
    expect(state.houseCell[2] as number).toBe(H2_CELL)
    // Blessed in M2 Task 2. It moves if any literal in the city moves, which
    // is the point: this is the only assertion that sees a change nobody
    // wrote a named test for.
    //
    // **Re-blessed in M1d Task 5 (was 3576722662 at Task 2; 2505371110 at M2)
    // — the second and last re-bless of this number in M1d.** The state buffer
    // grew from 11,908 to 13,828 bytes with `ghostMask` and `ghostCommitted`,
    // one `Uint8` per cell each. **Layout only, derived**: splicing the 1,920
    // inserted bytes back out of this buffer reproduces 3576722662 exactly.
    // 1,920 is `firstCity`'s figure specifically (960 cells x 2 regions x 1 B)
    // and this is the only one of the four re-blessed goldens that runs on
    // `firstCity`; the other three splice 32, 60 and 480 bytes on their own
    // maps. This golden is taken immediately after `seedStartingCity`, before
    // any tick, so it cannot move for a behavioural reason in this milestone —
    // and with no tick there is no car in flight and nothing erased, so both
    // ghost regions are all-zero.
    expect(state.ghostMask.every((b) => b === 0), 'the seed erases nothing').toBe(true)
    expect(state.ghostCommitted.every((b) => b === 0)).toBe(true)
    expect(hashState(state)).toBe(1178110182)
  })

  it('differs from the unseeded state — otherwise the golden pins nothing', () => {
    expect(hashState(seededRig().state)).not.toBe(hashState(makeRig().state))
  })

  it('is reproducible: two fresh states seeded independently hash identically', () => {
    // On its own this passes if BOTH runs fail identically, which is why the
    // per-call `toBe(true)` assertions above are separate tests rather than
    // folded in here.
    expect(hashState(seededRig().state)).toBe(hashState(seededRig().state))
  })
})

// ---------------------------------------------------------------------------
// 6. The end-to-end proof: a car goes out, arrives, comes home, and scores
// ---------------------------------------------------------------------------

describe('a full scored trip on the seeded city, driven through step()', () => {
  it('is a path the player could actually draw: 8-adjacent, inside budget', () => {
    const actions = pathActions(TRIP_PATH)
    expect(actions.length).toBe(3)
    expect(actions.length).toBeLessThanOrEqual(firstCity().startingTiles)
    for (let i = 0; i + 1 < TRIP_PATH.length; i++) {
      const a = TRIP_PATH[i] as number
      const b = TRIP_PATH[i + 1] as number
      const dx = xOf(b) - xOf(a)
      const dy = yOf(b) - yOf(a)
      expect(Math.abs(dx), `segment ${i} dx`).toBeLessThanOrEqual(1)
      expect(Math.abs(dy), `segment ${i} dy`).toBeLessThanOrEqual(1)
      expect(dx === 0 && dy === 0, `segment ${i} is degenerate`).toBe(false)
    }
  })

  it('has the tick bound the constants force, re-derived here rather than guessed', () => {
    expect(FIRST_PIN_DELAY_TICKS).toBe(120)
    expect(PIN_PERIOD_TICKS).toBe(518)
    expect(CAR_SPEED_UNITS_PER_TICK).toBe(330)
    expect(COST_UNIT_SCALE).toBe(250)
    // colour 0 has two square destinations, so slotCount is 2.
    expect(FIRST_PIN_TICK).toBe(FIRST_PIN_DELAY_TICKS - 1 + Math.ceil(PIN_PERIOD_TICKS / 2))
    // 2 x (DIAG + ORTHO + DIAG) x COST_UNIT_SCALE.
    expect(TRIP_ROUND_TRIP_COST_UNITS).toBe(2 * (DIAG_COST + ORTHO_COST + DIAG_COST) * COST_UNIT_SCALE)
    expect(TRIP_MOVEMENT_TICKS).toBe(Math.ceil(TRIP_ROUND_TRIP_COST_UNITS / CAR_SPEED_UNITS_PER_TICK))
    expect(FIRST_SCORE_TICK).toBe(FIRST_PIN_TICK + TRIP_MOVEMENT_TICKS - 1)
    expect(TRIP_TICK_BOUND).toBeGreaterThan(FIRST_SCORE_TICK)
  })

  it('scores exactly once, at tick 435, without reaching the bound', () => {
    const { state, world, fields, scratch, map } = seededRig()
    const actions = pathActions(TRIP_PATH)
    expect(actions.length).toBeLessThanOrEqual(map.startingTiles)

    let scoreTick = -1
    let dispatchObserved = false
    for (let t = 1; t <= TRIP_TICK_BOUND; t++) {
      step(state, world, fields, scratch, t === 1 ? { actions } : NO_ACTIONS)

      if (t === 1) {
        // Four newly-occupied cells at one tile each; a drag re-entering a
        // finished cell costs nothing, so this is the real spend.
        expect(tilesLeft(state)).toBe(26)
      }
      if (t === FIRST_PIN_TICK - 1) {
        // Nothing has fired yet: the eligibility gate plus the accumulator,
        // observed one tick before they elapse.
        expect(state.destPins[0] as number).toBe(0)
        expect(state.carPhase[2] as number).toBe(PHASE_IDLE)
      }
      if (t === FIRST_PIN_TICK) {
        // Demand fires (phase 3), dispatch commits (phase 5) and movement runs
        // (phase 6) all on this one tick.
        dispatchObserved = true
        expect(state.carPhase[2] as number).toBe(PHASE_OUTBOUND)
        expect(state.carTargetDest[2] as number).toBe(0)
        expect(state.carRouteLen[2] as number).toBe(TRIP_ROUTE_LEN)
        expect(state.destReserved[0] as number).toBe(1)
      }
      if ((state.header[H_SCORE] as number) > 0) {
        scoreTick = t
        break
      }
    }

    expect(dispatchObserved, 'the car was never dispatched').toBe(true)
    expect(scoreTick, 'the tick bound was hit without a score').not.toBe(-1)
    expect(scoreTick).toBe(FIRST_SCORE_TICK)
    expect(state.header[H_TICK] as number).toBe(FIRST_SCORE_TICK)
    expect(state.header[H_SCORE] as number).toBe(1)

    // The car that scored is house 1's first car, and it is home and idle.
    expect(state.carPhase[2] as number).toBe(PHASE_IDLE)
    expect(state.carCell[2] as number).toBe(H1_CELL)
    expect(state.carHome[2] as number).toBe(1)
    expect(state.carTargetDest[2] as number).toBe(-1)

    // Nothing went sideways on the way: no refused walk, no dropped pin, and
    // the pin the trip consumed is gone.
    expect(state.header[H_ROUTES_REFUSED] as number).toBe(0)
    expect(state.header[H_PINS_DROPPED] as number).toBe(0)
    expect(state.destPins[0] as number).toBe(0)
    expect(state.destReserved[0] as number).toBe(0)
    expect(tilesLeft(state)).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// 7. The city supports a scored trip from a house that is NOT nearest
// ---------------------------------------------------------------------------

describe('a scored trip from the house that is NOT nearest to its own destination', () => {
  /**
   * Dispatch selects `argmin dist[houseCell]`, so on the FIRST iteration of a
   * tick's loop the dispatching house is provably the nearest one. Divergence
   * needs a LATER iteration, which needs two unreserved pins on two distinct
   * same-colour destinations at once.
   *
   * M2 gets that for free and without a scripted pin: the board starts with no
   * road at all, so the pin colour 0 fires at tick 378 cannot be served and is
   * still sitting on D0 when the second one lands on D1 at tick 637. The
   * player then draws the corridor, and on the very next tick:
   *
   *   1. house 1 (dist 30 to D0) wins, commits car 2 to D0;
   *   2. house 1 is re-selected, walks to D0 again, finds every pin reserved,
   *      and is excluded;
   *   3. house 0 (dist 60) is selected on the strictly-greater key, walks to
   *      D1 and commits car 0 — while the nearest colour-0 house to D1 is
   *      house 1, at road distance 50 against house 0's 60.
   */
  it('accumulates two unserved pins, then dispatches the FAR house to the second one', () => {
    const { state, world, fields, scratch } = seededRig()
    const corridorActions = pathActions(CORRIDOR)
    expect(corridorActions.length).toBe(14)
    expect(corridorActions.length).toBeLessThanOrEqual(firstCity().startingTiles)

    let nearestScoreTick = -1
    let notNearestScoreTick = -1
    let twoPinsObserved = false
    let distToD1FromNear = -1
    let distToD1FromFar = -1

    for (let t = 1; t <= DEMO_TICK_BOUND; t++) {
      step(state, world, fields, scratch, t === CORRIDOR_TICK ? { actions: corridorActions } : NO_ACTIONS)

      if (t === SECOND_PIN_TICK) {
        // Both pins alive and unreserved, because nothing could serve either.
        twoPinsObserved = true
        expect(state.destPins[0] as number).toBe(1)
        expect(state.destPins[1] as number).toBe(1)
        expect(state.destReserved[0] as number).toBe(0)
        expect(state.destReserved[1] as number).toBe(0)
      }

      if (t === CORRIDOR_TICK) {
        expect(tilesLeft(state)).toBe(15)
        // House 1 (the NEAR house) took D0 — its own nearest.
        expect(state.carPhase[2] as number).toBe(PHASE_OUTBOUND)
        expect(state.carTargetDest[2] as number).toBe(0)
        expect(state.carRouteLen[2] as number).toBe(3)
        // House 0 (the FAR house) took D1 on a later iteration of the same
        // tick's loop, and it is 6 cells away.
        expect(state.carHome[0] as number).toBe(0)
        expect(state.carPhase[0] as number).toBe(PHASE_OUTBOUND)
        expect(state.carTargetDest[0] as number).toBe(1)
        expect(state.carRouteLen[0] as number).toBe(6)
        // ...and the NEARER house still had an idle car sitting at home. This
        // is the whole claim: the trip to D1 did not go to the nearest house
        // because that house was busy, it went there because the exclusion
        // rule handed D1 to the farther house.
        expect(state.carPhase[3] as number).toBe(PHASE_IDLE)
        expect(state.carCell[3] as number).toBe(H1_CELL)
      }

      if (t === SINGLE_SOURCE_TICK) {
        // D0's pin was consumed on tick 660, so colour 0's only source now is
        // D1's carpark and the field is a plain single-source distance to it.
        // Read straight off the sim rather than re-derived here.
        expect(state.destPins[0] as number).toBe(0)
        expect(state.destPins[1] as number).toBe(1)
        const field = fieldFor(state, world, fields, 0, scratch)
        distToD1FromNear = field.dist[H1_CELL] as number
        distToD1FromFar = field.dist[H0_CELL] as number
      }

      const score = state.header[H_SCORE] as number
      if (score === 1 && nearestScoreTick < 0) nearestScoreTick = t
      if (score === 2 && notNearestScoreTick < 0) {
        notNearestScoreTick = t
        break
      }
    }

    expect(twoPinsObserved).toBe(true)
    expect(nearestScoreTick).toBe(NEAREST_SCORE_TICK)
    expect(notNearestScoreTick).toBe(NOT_NEAREST_SCORE_TICK)

    // 5 corridor cells from (8,13) to (8,18); 6 from (8,24). Hand-computed
    // against ORTHO_COST, and the sim's own field agrees.
    expect(distToD1FromNear).toBe(5 * ORTHO_COST)
    expect(distToD1FromFar).toBe(6 * ORTHO_COST)
    expect(distToD1FromNear).toBeLessThan(distToD1FromFar)

    // The second score belongs to house 0's car, which is home again.
    expect(state.header[H_SCORE] as number).toBe(2)
    expect(state.carHome[0] as number).toBe(0)
    expect(state.carPhase[0] as number).toBe(PHASE_IDLE)
    expect(state.carCell[0] as number).toBe(H0_CELL)
    expect(state.header[H_ROUTES_REFUSED] as number).toBe(0)
    expect(state.header[H_PINS_DROPPED] as number).toBe(0)
  })
})
