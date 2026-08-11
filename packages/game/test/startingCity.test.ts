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
  PIN_CAP_CIRCLE_TIMER,
  PIN_CAP_SQUARE_TIMER,
  OVERCROWD_FAIL_MILLITICKS,
  CARS_PER_HOUSE,
  TICKS_PER_WEEK,
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
  isGameOver,
  roadMask,
  stepCell,
  destinationFitsSpawnZone,
  weekOfTick,
  DEST_KIND_SQUARE,
  DEST_KIND_CIRCLE,
  ORIENTATION_E,
  ORIENTATION_W,
  PHASE_IDLE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  H_DEST_COUNT,
  H_DEST_SPAWN_TIMER,
  H_FAILED_DEST,
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
import { hashBytes } from '@laneways/sim'
import { CITY_LAYOUT_ID, DEFAULT_LAYOUT_ID, layoutFor } from '../src/layouts'
import { longestQueue } from '../src/queueProbe'
// The M1e Task 1 re-bless proof, shared with the five `sim` golden sites. A
// relative reach into another package's test directory is unusual here and
// deliberate: the alternative is a second copy of the splice, and two copies
// of a proof drift in exactly the direction that makes the proof stop proving.
import { m1eInsertedRanges, spliceM1eInsertions } from '../../sim/test/m1eSplice'
import { CITY_DEATH_TICK } from './deathTicks'
import {
  armCarpark as gateCarpark,
  armGreedyActions as gateGreedyActions,
  armPathActions as gatePathActions,
  armTimerCap as gateTimerCap,
  firesSoFar,
  CITY_OPENING as GATE_OPENING,
  CORRIDOR,
  D2_LINK,
  GREEDY_PERIOD_TICKS,
  type CityArm,
} from './cityArms'
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

/*
 * `CORRIDOR` and `D2_LINK` — the two strokes this file's opening draws — moved
 * to `cityArms.ts` at M1e Task 12, unchanged, so `integration.test.ts` can draw
 * the SAME opening on the production boot path. Imported above.
 */

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

const SECOND_PIN_TICK = 637 // FIRST_PIN_TICK + ceil(518 / 2)
const CORRIDOR_TICK = 638
const NEAREST_SCORE_TICK = 683 // 638 + ceil(6 * 2500 / 330) - 1 = 638 + 46 - 1
const NOT_NEAREST_SCORE_TICK = 728 // 638 + ceil(12 * 2500 / 330) - 1 = 638 + 91 - 1
const SINGLE_SOURCE_TICK = 661 // the first tick on which D1's carpark is colour 0's only source
const DEMO_TICK_BOUND = 800

// ---------------------------------------------------------------------------
// THE TICK THIS BOARD KILLS ITSELF ON — measured at M1e Task 7
// ---------------------------------------------------------------------------

/**
 * **`firstCity`, booted exactly as `createGame` boots it and given NO player
 * input at all, reaches the overcrowd failure threshold on tick 5,580 — three
 * minutes and six seconds in.** Task 7 measures it; Task 8 is what makes
 * reaching it end the run. Until then nothing here can observe it, which is
 * precisely why the number is written down before it becomes fatal.
 *
 * Measured on the real boot path (`firstCity()` + `seedStartingCity` +
 * `createState('laneways-m2')` + the 258-tick warm start), driven 40,000 ticks:
 *
 * | | |
 * |---|---|
 * | Dies at tick | **5,580** — **3 min 06 s** at 30 Hz |
 * | Destination | **D2**, `STARTING_DESTINATIONS[2]`, grid (14, 14), colour 1 |
 * | Kind | **circle** — 2 rotation slots, trigger cap 8, hard cap 14 |
 * | Arrivals it received | **0**, against a median of **0**: this board has no roads |
 * | Its last arrival | **never** |
 * | At or over its cap from | tick **2,191**, unbroken for 3,390 ticks |
 * | Completed trips by tick 20,000 | **0** |
 *
 * **Derive the 5,580 rather than trusting it.** Colour 1 owns exactly one
 * destination and it is a circle, so `slotCount(1)` is 2 and the accumulator
 * fires every `ceil(518 / 2)` = 259 ticks from tick 378. D2 therefore holds its
 * 8th pin — its trigger cap — on tick `378 + 7 * 259` = **2,191**, the k-th
 * at-cap tick is `2,190 + k`, and `k = 3,390` gives 5,580.
 *
 * ---------------------------------------------------------------------------
 * **AND IT IS AVOIDABLE IN FIVE TILES. On this board, doing nothing IS doing
 * something wrong.**
 * ---------------------------------------------------------------------------
 *
 * D2's carpark is (17, 14) and its own colour-1 house is (17, 18). Column
 * x = 17, y = 14..18 is **five cells, four `place` actions, five tiles** out of
 * the 30 `firstCity` starts with. Measured on the same rig:
 *
 * | trace | first death | tiles | score @ 40,000 |
 * |---|---|---|---|
 * | no input | **5,580** (D2) | 0 | 0 |
 * | the 5-tile D2 link | **6,330** (D0) | 5 | **527** |
 *
 * With the link, **D2's overcrowd meter peaks at 0** — it never reaches its
 * trigger at any horizon, and the run then ends on D0 instead, 750 ticks later.
 *
 * **The window is not the 2,191 ticks it takes D2 to reach its cap.** Swept to
 * the tick: the link still saves D2 drawn as late as tick **5,550** and fails
 * at 5,551 — **30 ticks, one second, before the death it prevents.** A player
 * can act from tick 259 (the warm start ends at 258), so the usable window is
 * **5,292 of the run's 5,580 ticks**. It is not narrow; it is almost all of it.
 *
 * **Two things that are Task 9 / Task 10 design inputs rather than defects
 * here.** Nothing in the shipped UI tells the player any of this — there is no
 * ring yet (Task 9) and no failure yet (Task 8). And the "natural first road"
 * that this file's own seed comment documents at `startingCity.ts` — the
 * 15-tile colour-0 corridor down column x = 8 — **is the wrong move**: measured,
 * it saves D0 and D1 (both peak at meter 0) and **the run still ends at 5,580
 * on D2**, because it never touches colour 1. A player who follows the
 * documentation dies on schedule.
 *
 * **D2 dies before the lower-indexed SQUARE D0 despite the HIGHER trigger cap,
 * and the reason is the rotation, not the cap.** Colour 0 owns two squares
 * sharing `slotCount(0)` = 2, so each receives one pin per 518 ticks against
 * D2's one per 259: a circle is served twice as often and therefore fills more
 * than twice as fast, and the 8-against-6 cap does not make up the difference.
 * D0's counterfactual death tick, measured on the same run, is **6,330** — it
 * reaches its cap of 6 on tick 2,941. **Note the figure the plan carried was
 * 6,357, and both are right for their own tree**: 6,357 is the pre-Task-5
 * number, reproduced by parking `H_DEST_SPAWN_TIMER`, and the spawner's third
 * colour-0 destination is what moves D0's cap tick from 2,968 to 2,941. **D2's
 * own 2,191 is spawner-invariant**, so the death tick this comment is about is
 * the same either way.
 *
 * **Both arms are asserted, in *"is not vacuous: WITHOUT the link"* below** —
 * 2,941/6,330 live and 2,968/6,357 parked, on the same rig. Until M1e's closing
 * sweep neither was: this comment claimed the parked arm was *"reproduced
 * exactly here"* and no test in this file parked anything, and 6,357 was
 * meanwhile sitting in `integration.test.ts` as the live figure, three commits
 * after `da63dc2` retired it. A number nothing runs is a number that comes back.
 *
 * The two windows above are both far below it and this is the mechanical
 * statement of that, so a future task lengthening either one finds out here
 * rather than by asserting over a corpse.
 */

/**
 * When the saveability tests draw. Any tick from 1 to **5,550** works — swept —
 * so this is an ordinary early draw and not a tuned one.
 */
const D2_LINK_TICK = 300

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
    // **Re-blessed in M1e Task 1 (was 1178110182 at M1d Task 5; 3576722662 at
    // M1d Task 2; 2505371110 at M2). Task 1 is the ONLY shape change in M1e**
    // and this golden moves in no other task of the milestone: it is taken
    // immediately after `seedStartingCity`, before any tick, so nothing
    // behavioural M1e adds can reach it.
    //
    // **PURE LAYOUT, proved by an exact byte splice** (`m1eSplice.ts`, in
    // `sim`'s test directory — this is the only cross-package import in this
    // file and it exists so the seven re-blessed sites share one proof rather
    // than seven transcriptions of it). Removing the two inserted ranges — 16 B
    // of new header slots at offset 52 and 148 B of new regions at offset 1,676,
    // both MID-BUFFER, neither an append — reproduces 1178110182 bit-for-bit
    // with no slot zeroed. `createState`'s two initial timer writes land inside
    // those ranges, so there is no behavioural term in this re-bless at all.
    // The buffer goes 13,828 -> 13,992 B; this and `demoLayout.test.ts` are the
    // only two goldens on a shipped map, and the demo's is a different one.
    //
    // With no tick there is no car in flight and nothing erased, so both ghost
    // regions are all-zero.
    expect(state.ghostMask.every((b) => b === 0), 'the seed erases nothing').toBe(true)
    expect(state.ghostCommitted.every((b) => b === 0)).toBe(true)
    const m1e = m1eInsertedRanges(firstCity())
    expect([m1e.aStart, m1e.aEnd, m1e.bStart, m1e.bEnd]).toEqual([52, 68, 1676, 1824])
    const spliced = spliceM1eInsertions(state, firstCity())
    // Vacuity: the splice must land on M1d's own total for `firstCity`.
    expect(spliced.length, "the splice must land on M1d's buffer size").toBe(13828)
    expect(m1e.totalBytes).toBe(13992)
    expect(hashBytes(spliced), 'the splice must reproduce the pre-M1e digest').toBe(1178110182)
    expect(hashState(state)).toBe(968680755)
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

  it('is SAVEABLE: five tiles to D2 and its meter never leaves zero', () => {
    // **The load-bearing claim for Task 10's gate, as a test rather than as a
    // comment** — an earlier version of this task's report asserted in prose
    // that neither board's failure was reachable by a player's skill, and this
    // board's is, in four `place` actions.
    //
    // Driven to just past the no-input death tick, so a regression that
    // re-broke the link shows up as D2's meter climbing rather than as a
    // distant tick moving.
    const { state, world, fields, scratch } = seededRig()
    const linkActions = pathActions(D2_LINK)
    expect(linkActions.length, 'four segments, five cells, five tiles').toBe(4)
    expect(linkActions.length + 1).toBeLessThanOrEqual(firstCity().startingTiles)

    let d2Peak = 0
    let d0Peak = 0
    for (let t = 1; t <= CITY_DEATH_TICK + 20; t++) {
      step(state, world, fields, scratch, t === D2_LINK_TICK ? { actions: linkActions } : NO_ACTIONS)
      d2Peak = Math.max(d2Peak, state.destOvercrowd[2] as number)
      d0Peak = Math.max(d0Peak, state.destOvercrowd[0] as number)
    }

    // Vacuity first: the link must actually have been laid and actually used,
    // or "the meter stayed at 0" is satisfied by a board where nothing happened.
    expect(state.header[H_SCORE], 'cars must really be serving D2').toBeGreaterThan(0)
    expect(state.destPins[2] as number, 'and D2 must not be sitting at its cap').toBeLessThan(
      PIN_CAP_CIRCLE_TIMER,
    )
    // The claim: D2's timer never starts at all.
    expect(d2Peak, 'D2 never accrues a single milli-tick with the link drawn').toBe(0)
    // And the contrast, on the same run: the UNLINKED colour-0 square does
    // accrue, so a meter of 0 is a property of the link and not of the rig.
    expect(d0Peak, 'D0 is still unlinked, and it is dying on schedule').toBeGreaterThan(0)
  })

  it('is not vacuous: WITHOUT the link, the same rig kills D2 on schedule', () => {
    // The other side of the pair. Without this, the test above passes on a rig
    // whose meter never moves for some unrelated reason.
    const { state, world, fields, scratch } = seededRig()
    let d2Peak = 0
    // D0's first at-cap tick, recorded on the same run — see below.
    let d0CapTick = -1
    for (let t = 1; t <= CITY_DEATH_TICK; t++) {
      step(state, world, fields, scratch, NO_ACTIONS)
      d2Peak = Math.max(d2Peak, state.destOvercrowd[2] as number)
      if (d0CapTick < 0 && (state.destPins[0] as number) >= PIN_CAP_SQUARE_TIMER) d0CapTick = t
    }
    expect(state.header[H_SCORE], 'no roads, so no trip is possible').toBe(0)
    expect(d2Peak, 'and D2 reaches the failure threshold exactly on CITY_DEATH_TICK').toBe(
      OVERCROWD_FAIL_MILLITICKS,
    )

    // **D0's COUNTERFACTUAL, pinned rather than described — M1e's closing sweep.**
    //
    // Three files carry "the lower-indexed square D0 would die at N" as the
    // sentence that makes 5,580 a derivation rather than a recorded number, and
    // until now not one of them had an assertion under it. Two different values
    // were in the tree at once: 6,330 here and in `startingCity.ts`, 6,357 in
    // `integration.test.ts`. **6,357 is the number this board produces with the
    // spawner parked** — D0's pins at 378, 896, 1414, 1932, 2450, 2968, first
    // at-cap tick 2,968. On the live tree Task 5's spawner adds a third colour-0
    // destination, `slotCount(0)` changes, and the cap tick moves to 2,941.
    //
    // A prose figure with no tripwire is how 6,357 came back three commits after
    // it was corrected, so the derivation is asserted in both halves: the cap
    // tick the run actually produces, and the meter arithmetic applied to it.
    expect(d0CapTick, "D0 reaches its square trigger cap here, with the spawner live").toBe(2941)
    expect(d0CapTick - 1 + 3390, "so D0's counterfactual death tick is 6,330").toBe(6330)

    // **And the other arm, because "both are right for their own tree" was a
    // claim with nothing under it.** This file's header comment said 6,357 was
    // *"reproduced exactly here by parking `H_DEST_SPAWN_TIMER`"*; no test in
    // this file parked anything. The parking was an ad-hoc measurement in
    // `da63dc2` that never became an artefact — which is exactly why the number
    // it retired could reappear elsewhere three commits later and look correct.
    const parked = seededRig()
    let parkedCapTick = -1
    for (let t = 1; t <= CITY_DEATH_TICK; t++) {
      parked.state.header[H_DEST_SPAWN_TIMER] = 1_000_000
      step(parked.state, parked.world, parked.fields, parked.scratch, NO_ACTIONS)
      if (parkedCapTick < 0 && (parked.state.destPins[0] as number) >= PIN_CAP_SQUARE_TIMER) {
        parkedCapTick = t
      }
    }
    expect(
      parked.state.header[H_DEST_COUNT] as number,
      'vacuity: parking the timer must really stop the destination spawner',
    ).toBe(3)
    expect(parkedCapTick, 'parked, D0 reaches its cap on the pre-spawner tick').toBe(2968)
    expect(parkedCapTick - 1 + 3390, 'which is where 6,357 comes from').toBe(6357)
    expect(d0CapTick, 'and the two trees genuinely disagree').not.toBe(parkedCapTick)
  })

  it('the DOCUMENTED first road is the wrong move: it saves D0 and D1 and D2 still dies', () => {
    // `startingCity.ts` calls column x=8 "the natural first road the player
    // draws". It is 15 tiles, it connects both colour-0 destinations to both
    // colour-0 houses — and it never touches colour 1, so the run ends on
    // schedule anyway. A player who follows the documentation dies at 5,580.
    const { state, world, fields, scratch } = seededRig()
    const corridorActions = pathActions(CORRIDOR)
    let d2Peak = 0
    let d0Peak = 0
    for (let t = 1; t <= CITY_DEATH_TICK; t++) {
      step(state, world, fields, scratch, t === D2_LINK_TICK ? { actions: corridorActions } : NO_ACTIONS)
      d2Peak = Math.max(d2Peak, state.destOvercrowd[2] as number)
      d0Peak = Math.max(d0Peak, state.destOvercrowd[0] as number)
    }
    expect(state.header[H_SCORE], 'vacuity: the corridor really is carrying traffic').toBeGreaterThan(0)
    expect(d0Peak, 'the corridor DOES save the two colour-0 squares').toBe(0)
    expect(d2Peak, 'and D2 dies anyway, on the same tick as with no road at all').toBe(
      OVERCROWD_FAIL_MILLITICKS,
    )
  })

  it('keeps the two hand-derived windows below the tick this board kills itself on', () => {
    // M1e Task 7, and see `CITY_DEATH_TICK`'s own comment for the measurement.
    // This is the mechanism that stops a later task lengthening one of the two
    // HAND-DERIVED windows into a frozen sim and asserting over a corpse. It is
    // a STRICT inequality against a measured number, not a restatement of one:
    // 5,580 came off a 40,000-tick drive of the real boot path, and the two
    // bounds came off the pin ladder.
    //
    // **It is deliberately about those two constants and not about "every
    // window in this file", which is what it used to be called.** §8's
    // survivability gate drives 12 weeks and runs THROUGH the shutdown on
    // purpose — the freeze is part of what it measures — and its assertions are
    // aggregates taken while the run was live, not readings taken at the end.
    expect(CITY_DEATH_TICK).toBe(5580)
    expect(TRIP_TICK_BOUND, 'the trip window has 91 % margin').toBeLessThan(CITY_DEATH_TICK)
    expect(DEMO_TICK_BOUND, 'the not-nearest window has 86 % margin').toBeLessThan(CITY_DEATH_TICK)
    // The margins, as the figures the sentences above claim — so a reader can
    // check the adjective rather than take it.
    expect(Math.round((1 - TRIP_TICK_BOUND / CITY_DEATH_TICK) * 100)).toBe(91)
    expect(Math.round((1 - DEMO_TICK_BOUND / CITY_DEATH_TICK) * 100)).toBe(86)
    // And the derivation, so a change to the pin cadence or the trigger cap
    // moves this constant loudly rather than leaving it a stale literal:
    // colour 1's lone CIRCLE fires every ceil(518 / 2) = 259 ticks from 378, so
    // its 8th pin lands on 2,191 and the 3,390th at-cap tick after that is
    // 5,580.
    const capTick = FIRST_PIN_TICK + (PIN_CAP_CIRCLE_TIMER - 1) * Math.ceil(PIN_PERIOD_TICKS / 2)
    expect(capTick, 'D2 reaches its trigger cap here').toBe(2191)
    // 3,390 is not re-derived here — `sim/test/overcrowd.test.ts` derives it
    // from the ramp sum and `shared/test/constants.test.ts` derives it from the
    // constants. This asserts the RELATION between the three numbers, which is
    // what would break if the pin cadence or the trigger cap moved.
    expect(CITY_DEATH_TICK - capTick + 1, 'and dies 3,390 at-cap ticks later').toBe(3390)
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

// ---------------------------------------------------------------------------
// 8. THE SURVIVABILITY GATE — the measurement `DEFAULT_LAYOUT_ID` is behind
// ---------------------------------------------------------------------------

/**
 * **M1e Task 10. The flip back to this board is behind this block, and what it
 * gates on is deliberately none of the three things that would have passed on
 * the build M1d shipped.**
 *
 * Not **weeks survived**: that is satisfiable by a build in which nothing ever
 * writes `H_GAME_OVER`, which is the identical hole M1d shipped, in the
 * milestone written to correct M1d. Not **entity counts**: M1e Task 5 reached
 * 22 houses and 10 destinations with **exactly one spawned car in motion**, and
 * `spawn.test.ts` carries that measurement in its own source. Growth in
 * population is not growth in traffic.
 *
 * So this gates on three quantities, on the board that ships, under scripted
 * input traces a player could actually produce:
 *
 *   **(a)** completed **trips** and **cars in motion** — including cars in
 *   motion that belong to houses the SPAWNER placed, which is the clause Task
 *   5's rig would have failed;
 *   **(b)** the **delivery fraction** `trips / fires`, one number for what the
 *   weekly demand ramp does to a fixed network;
 *   **(c)** peak `destPins` on ROAD-CONNECTED destinations against
 *   **`PIN_CAP_*_TIMER`** — the timer cap, not the hard cap, because
 *   `overcrowdTriggerCap` is what the meter actually reads.
 *
 * ---------------------------------------------------------------------------
 * THE THREE TRACES, AND WHY THE THIRD ONE HAS TO EXIST
 * ---------------------------------------------------------------------------
 *
 * | trace | tiles spent | dies | killer | its carpark | trips |
 * |---|---|---|---|---|---|
 * | no input | 0 | **5,580** | D2 | bare | 0 |
 * | the 20-tile opening, then nothing | 20 | **8,661** | D3 | bare | 71 |
 * | greedy-connect | 62 | **31,456** | D6 | **on the network** | **747** |
 *
 * The first two reproduce `CITY_DEATH_TICK` and `startingCity.ts`'s own
 * four-row table bit-for-bit, which is what says this rig is measuring the
 * shipped boot path and not a lookalike. The third is the only one that reaches
 * the regime the gate is about: a player who keeps connecting is the player
 * whose city is allowed to get busy, and a gate measured on a board nobody
 * maintains measures the seed, not the game.
 *
 * **Greedy-connect is scripted, deterministic and replayable as an input log.**
 * Every 30 ticks it finds the lowest-index destination whose carpark is not in
 * the same road component as a same-colour house and buys the cheapest path
 * joining them, if it can afford it. Nothing here reads a flow field, a pin or
 * a car: it is a policy over `roads`, `houseCell` and `destCell`, which is
 * exactly what a person looking at the screen has.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE GATE FOUND, AND THE PART THAT IS NOT THE ANSWER IT EXPECTED
 * ---------------------------------------------------------------------------
 *
 * **Plan Task 10 Step 3 proposed a spawner change — tiering the destination
 * scan by proximity to the spawning colour's own houses — and this gate
 * REJECTED it.** Both variants were driven through this rig, five seeds, twelve
 * weeks, in one sitting. Measured on the shipped seed:
 *
 * ```
 *                              baseline (shipped)     house-proximity tiers
 *   peak destPins, connected   1 1 1 1 2 5 10         1, in all twelve weeks
 *   longest queue              1 1 2 3 3 4 4          1, in all twelve weeks
 *   ticks with a blocked car   0 0 99 298 287 639 597 0, in all twelve weeks
 *   peak cars in flight        11                     4
 *   delivery fraction, weekly  0.95 .. 0.95           0.95 .. 1.03
 *   mean round trip, ticks     57 -> 205              59 -> 51
 *   destinations by week 11    12                     10
 *   dies                       31,456 (D6, connected) never, in 12 weeks
 * ```
 *
 * The lever does improve survival — it survives everything, on all five seeds.
 * It does it by making the board **inert**: destinations spawn beside their own
 * colour's houses, round trips fall to ~51 ticks, every pin is served the tick
 * it fires, and the meter never leaves 1. That is M1d's *"service is 4.3x
 * faster than arrival"* reproduced by the mechanism proposed to fix it. Plan
 * Step 5 says in as many words: *"if the baseline passes Gate A and the lever
 * does not, ship the baseline and say so."* The baseline passes and the lever
 * does not. `spawn.ts` is unchanged by Task 10.
 *
 * **The plan's stated reasons for the lever also did not reproduce on this
 * tree.** It cited dropped pins running at 85 a week under the baseline and
 * destinations the greedy policy could not reach. Measured here, on the
 * baseline, five seeds:
 *
 *   - **dropped pins are 0 in every week of the shipped seed's run** and 0 for
 *     all twelve weeks of one other seed; on the remaining three they are 6, 13
 *     and 16, and every one of them lands in the week the run dies — i.e. after
 *     the network was already losing, not before it;
 *   - **at most ONE destination stands unconnected at any week boundary** on
 *     the shipped seed (two on the others), and it is always one placed inside
 *     that week;
 *   - `tilesLeft` never falls below **37**, and the connect bill is **62 tiles
 *     of the 210 granted** by the time the shipped seed dies. Unaffordable
 *     connect decisions are **0 on two seeds and 75 on three**, and all 75 fall
 *     in the half-week immediately after the 20-tile opening, while the spend
 *     is being re-granted — never later, and never with the budget at 0.
 *
 * Tiles are not the constraint on any seed, which is the plan's own finding and
 * the one part of Step 3's derivation that does reproduce.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST LIMIT, stated here rather than found by a player
 * ---------------------------------------------------------------------------
 *
 * **On this board the delivery fraction is a weak instrument, and (b) is
 * reported as much as it is gated.** Under greedy play the network delivers
 * **97.5 %** of everything demand fires, right up to the tick it dies — because
 * the failure is not a throughput failure. It is `dispatch.ts`'s Decision 4
 * cost: demand round-robins EVENLY across a colour's rotation slots while cars
 * flow to the NEAREST unfilled pin, so one destination starves while the board
 * looks healthy. **The fraction only collapses when the player STOPS keeping
 * up**, which is the second trace: 0.84 in week 0 and 0.71 in week 1, on a
 * network that stopped growing. That pair is what (b) gates on, and it is the
 * shape the same measurement takes on the demo board (0.82 falling to 0.39).
 *
 * Closing the round-robin/nearest mismatch is a change to §5.3's scheduling
 * rule and to `dispatch.ts`, and it is M1f's, carried with this measurement.
 */

/** Twelve weeks, which is 54,000 ticks — long enough for every arm to end. */
const GATE_WEEKS = 12

/*
 * `GATE_OPENING` and `GREEDY_PERIOD_TICKS` moved to `cityArms.ts` at M1e Task
 * 12, as `CITY_OPENING` and under the same name — see that file's header for
 * why the POLICY is shared and the two DRIVERS are not. **Both strokes are
 * asserted accepted rather than assumed** — see the first case in this block.
 */

interface GateWeek {
  readonly week: number
  readonly dests: number
  readonly connected: number
  readonly houses: number
  readonly trips: number
  readonly fires: number
  readonly frac: number
  readonly maxInFlight: number
  readonly longestQueue: number
  readonly blockedTicks: number
  readonly dropped: number
  readonly refusals: number
  readonly tilesLeft: number
  /** Peak `destPins` over destinations whose carpark carries a road, this week. */
  readonly peakPinsConnected: number
  /** Peak `destPins` over destinations whose carpark does NOT, this week. */
  readonly peakPinsRoadless: number
  /** Peak of the board-wide sum of `destPins`, this week. */
  readonly peakSumPins: number
  /** Did any ROAD-CONNECTED destination stand at or above its own timer cap? */
  readonly capReachedConnected: boolean
}

interface GateRun {
  readonly weeks: readonly GateWeek[]
  readonly deathTick: number
  readonly failedDest: number
  readonly failedDestConnected: boolean
  readonly trips: number
  readonly fires: number
  readonly maxInFlight: number
  readonly maxSpawnedInFlight: number
  readonly unaffordable: number
  readonly outsideRect: number
}

/*
 * `firesSoFar`, the timer-cap reader, the carpark reader, the footprint
 * predicate, the road-component flood fill, the 0-1 cheapest-path search, the
 * path-to-actions helper and the greedy policy itself all moved to
 * `cityArms.ts` at M1e Task 12, byte-unchanged. Imported at the top of this
 * file. The reason is in that file's header: `integration.test.ts` now drives
 * the same three arms through `createGame`, and two drivers agreeing is
 * evidence where one driver run twice is not.
 */

/* `CityArm` is `CityArm`, imported above — the two drivers must not be able to
 * disagree about which arms exist. */

/**
 * Boots **through `DEFAULT_LAYOUT_ID`**, not through `firstCity()` directly.
 *
 * That coupling is the point: the gate is a claim about *the board a plain load
 * opens*, so flipping the default to a board that cannot pass it fails here as
 * well as in `layouts.test.ts`. The named assertion below is what keeps the
 * failure legible rather than arriving as "expected 747 to be at least 400".
 */
function gateBoot(): Rig {
  const layout = layoutFor(DEFAULT_LAYOUT_ID)
  const map = layout.map()
  const world = createWorld(map)
  const state = createState(layout.runSeed, map)
  const scratch = createScratch(
    world.cells,
    map.groupCount,
    map.maxDestinations,
    createFieldInputRanges(map),
  )
  const fields = createFlowFields(map.groupCount, world.cells)
  layout.seed(state, world)
  for (let t = 0; t < layout.warmStartTicks; t++) step(state, world, fields, scratch, NO_ACTIONS)
  return { map, world, state, scratch, fields }
}

function driveGate(arm: CityArm): GateRun {
  const { state, world, fields, scratch } = gateBoot()
  const startTick = state.header[H_TICK] as number
  const endTick = startTick + GATE_WEEKS * TICKS_PER_WEEK
  const seededCars = (state.header[H_HOUSE_COUNT] as number) * CARS_PER_HOUSE
  const tally = { unaffordable: 0 }
  const weeks: GateWeek[] = []

  const openingActions: TickAction[] = []
  for (const stroke of GATE_OPENING) openingActions.push(...gatePathActions(stroke))

  let deathTick = -1
  let outsideRect = 0
  let maxInFlight = 0
  let maxSpawnedInFlight = 0

  let week = weekOfTick(startTick)
  let weekTrips = state.header[H_SCORE] as number
  let weekFires = firesSoFar(state)
  let weekDropped = state.header[H_PINS_DROPPED] as number
  let weekRefusals = state.header[H_ROUTES_REFUSED] as number
  let wkInFlight = 0
  let wkQueue = 0
  let wkBlocked = 0
  let wkPinsConnected = 0
  let wkPinsRoadless = 0
  let wkSumPins = 0
  let wkCapConnected = false

  const closeWeek = (): void => {
    const destCount = state.header[H_DEST_COUNT] as number
    let connected = 0
    for (let d = 0; d < destCount; d++) {
      const cp = gateCarpark(state, world, d)
      if (cp >= 0 && roadMask(state, cp) !== 0) connected++
    }
    const trips = (state.header[H_SCORE] as number) - weekTrips
    const fires = firesSoFar(state) - weekFires
    weeks.push({
      week,
      dests: destCount,
      connected,
      houses: state.header[H_HOUSE_COUNT] as number,
      trips,
      fires,
      frac: fires === 0 ? 0 : trips / fires,
      maxInFlight: wkInFlight,
      longestQueue: wkQueue,
      blockedTicks: wkBlocked,
      dropped: (state.header[H_PINS_DROPPED] as number) - weekDropped,
      refusals: (state.header[H_ROUTES_REFUSED] as number) - weekRefusals,
      tilesLeft: tilesLeft(state),
      peakPinsConnected: wkPinsConnected,
      peakPinsRoadless: wkPinsRoadless,
      peakSumPins: wkSumPins,
      capReachedConnected: wkCapConnected,
    })
    weekTrips = state.header[H_SCORE] as number
    weekFires = firesSoFar(state)
    weekDropped = state.header[H_PINS_DROPPED] as number
    weekRefusals = state.header[H_ROUTES_REFUSED] as number
    wkInFlight = 0
    wkQueue = 0
    wkBlocked = 0
    wkPinsConnected = 0
    wkPinsRoadless = 0
    wkSumPins = 0
    wkCapConnected = false
  }

  for (let tick = startTick + 1; tick <= endTick; tick++) {
    let actions: TickAction[] | undefined
    if (arm !== 'no-input' && tick === startTick + 1) actions = openingActions
    else if (arm === 'greedy' && tick % GREEDY_PERIOD_TICKS === 0) {
      actions = gateGreedyActions(state, world, tally)
    }
    step(state, world, fields, scratch, actions === undefined ? NO_ACTIONS : { actions })

    if (isGameOver(state)) {
      deathTick = state.header[H_TICK] as number
      closeWeek()
      break
    }

    let inFlight = 0
    let spawnedInFlight = 0
    let blocked = false
    for (let c = 0; c < state.carPhase.length; c++) {
      const phase = state.carPhase[c] as number
      if (phase === PHASE_OUTBOUND || phase === PHASE_RETURNING) {
        inFlight++
        if (c >= seededCars) spawnedInFlight++
      }
      if ((state.carBlockedTicks[c] as number) > 0) blocked = true
    }
    if (inFlight > wkInFlight) wkInFlight = inFlight
    if (inFlight > maxInFlight) maxInFlight = inFlight
    if (spawnedInFlight > maxSpawnedInFlight) maxSpawnedInFlight = spawnedInFlight
    if (blocked) wkBlocked++
    // `longestQueue` allocates a `Map` and a `Set` per call, so it is sampled
    // rather than run every tick — this is a measurement rig, not a frame path,
    // and a queue that stands for one tick in thirty is not a queue.
    if (tick % 10 === 0) {
      const q = longestQueue(state, world)
      if (q > wkQueue) wkQueue = q
    }

    const destCount = state.header[H_DEST_COUNT] as number
    let sumPins = 0
    for (let d = 0; d < destCount; d++) {
      const cp = gateCarpark(state, world, d)
      const pins = state.destPins[d] as number
      sumPins += pins
      if (cp >= 0 && roadMask(state, cp) !== 0) {
        if (pins > wkPinsConnected) wkPinsConnected = pins
        if (pins >= gateTimerCap(state, d)) wkCapConnected = true
      } else if (pins > wkPinsRoadless) {
        wkPinsRoadless = pins
      }
      if (!destinationFitsSpawnZone(state.destCell[d] as number, destMetaOrientation(state.destMeta[d] as number), world)) {
        outsideRect++
      }
    }
    if (sumPins > wkSumPins) wkSumPins = sumPins

    const w = weekOfTick(tick)
    if (w !== week) {
      closeWeek()
      week = w
    }
  }
  if (deathTick < 0) closeWeek()

  const failedDest = state.header[H_FAILED_DEST] as number
  const failedCarpark =
    failedDest >= 0 && failedDest < (state.header[H_DEST_COUNT] as number)
      ? gateCarpark(state, world, failedDest)
      : -1
  return {
    weeks,
    deathTick,
    failedDest,
    failedDestConnected: failedCarpark >= 0 && roadMask(state, failedCarpark) !== 0,
    trips: state.header[H_SCORE] as number,
    fires: firesSoFar(state),
    maxInFlight,
    maxSpawnedInFlight,
    unaffordable: tally.unaffordable,
    outsideRect,
  }
}

/**
 * Gate C's gradient predicate, over the per-week peaks: the index of an early
 * week at exactly 1, of a strictly later week above 1 that reaches no cap, and
 * of a strictly later week still that does. `-1` for "no such week".
 *
 * A function rather than three inline `findIndex` calls so that the synthetic
 * series in `rejects a one-week jump...` exercise the SAME code Gate C runs,
 * rather than a second copy of it that could agree with the comment while the
 * gate disagrees with both.
 */
function gradientIndices(
  weeks: readonly Pick<GateWeek, 'peakPinsConnected' | 'capReachedConnected'>[],
): { flat: number; risen: number; capped: number } {
  const flat = weeks.findIndex((w) => w.peakPinsConnected === 1)
  const risen =
    flat < 0
      ? -1
      : weeks.findIndex((w, i) => i > flat && w.peakPinsConnected >= 2 && !w.capReachedConnected)
  const capped = risen < 0 ? -1 : weeks.findIndex((w, i) => i > risen && w.capReachedConnected)
  return { flat, risen, capped }
}

/**
 * Driven once and shared, because three arms x twelve weeks is 100,000-odd
 * `step` calls and each case below reads a different projection of the same
 * run. The sim is deterministic, so this is memoisation and not sampling.
 */
const gateRuns = new Map<CityArm, GateRun>()
function gateRun(arm: CityArm): GateRun {
  const cached = gateRuns.get(arm)
  if (cached !== undefined) return cached
  const fresh = driveGate(arm)
  gateRuns.set(arm, fresh)
  return fresh
}

describe('the survivability gate the default board is flipped behind', () => {
  it('is measuring the board a plain load opens, on the real boot path', () => {
    // **The named assertion, first, so a flip of `DEFAULT_LAYOUT_ID` fails here
    // with the id in the message rather than as an arithmetic surprise three
    // cases down.** Everything below boots through `layoutFor`, so without this
    // the whole block would silently re-point at whatever board the default
    // names next.
    //
    // **"First" is REPORTING ORDER, not an interlock, and the difference
    // matters.** The three arms are memoised at module scope and vitest runs
    // the cases in file order, so this one reports first — but Gates A, B and C
    // still execute if it fails, which is what happened under the frozen-ramp
    // mutation. So it buys a legible failure, not a short circuit, and one
    // `it.only` or one reorder takes even that away. If a real interlock is
    // ever wanted, it has to be inside `driveGate`, not in a sibling case.
    expect(DEFAULT_LAYOUT_ID, 'the gate is about the board a plain load opens').toBe(
      CITY_LAYOUT_ID,
    )
    const layout = layoutFor(DEFAULT_LAYOUT_ID)
    expect(layout.map().id).toBe('firstCity')
    expect(layout.runSeed).toBe('laneways-m2')
    expect(layout.warmStartTicks).toBe(258)

    // The rig reproduces the two inherited death ticks EXACTLY, which is what
    // says it is driving the shipped boot and not a lookalike. Both came off a
    // 40,000-tick drive at M1e Tasks 7 and 9, by a different rig, in a
    // different file.
    expect(gateRun('no-input').deathTick, 'the no-input death tick').toBe(CITY_DEATH_TICK)
    expect(gateRun('no-input').deathTick).toBe(5580)
    expect(gateRun('opening').deathTick, "the 20-tile opening's death tick").toBe(8661)

    // And the opening really is 18 accepted `place` actions for 20 tiles, out
    // of the 30 the board starts with — Decision 13's first checkable fact.
    let actions = 0
    for (const stroke of GATE_OPENING) actions += gatePathActions(stroke).length
    expect(actions, '4 on column 17 + 14 on column 8').toBe(18)
    const { state, world, fields, scratch } = gateBoot()
    const opening: TickAction[] = []
    for (const stroke of GATE_OPENING) opening.push(...gatePathActions(stroke))
    step(state, world, fields, scratch, { actions: opening })
    expect(tilesLeft(state), '20 of 30 tiles, and every action accepted').toBe(10)
    for (const stroke of GATE_OPENING) {
      for (const cell of stroke) {
        expect(roadMask(state, cell), `opening cell ${cell} was refused`).not.toBe(0)
      }
    }
  })

  it("the river's two-cell land gap keeps the board connected without a bridge", () => {
    // **Decision 13's second checkable fact, asserted rather than listed.**
    // `layouts.ts` states it as one of the three facts behind the opening and,
    // until the Task 10 review, nothing in the repo checked it — the one fact
    // of the three with no artefact behind it, which is this project's most
    // reliable predictor of a claim that turns out to be wrong.
    //
    // Two halves, and the second is the one that could actually fail. The
    // river is column 12 and rows 18 and 19 are LAND; and the revealed rect's
    // passable cells are ONE 8-connected component, so a player can reach the
    // east bank from the west bank without a bridge, over land, using only the
    // gap. `roads.ts` refuses a road on an impassable cell, so a component walk
    // over `world.passable` is exactly the reachability a road can express.
    const { world } = gateBoot()
    const at = (x: number, y: number): number => y * GRID_W + x

    // The gap itself, and the river either side of it — so "there is a gap" is
    // a statement about a hole in something rather than about open ground.
    expect(world.terrain[at(12, 18)], 'row 18 is the gap').toBe(TERRAIN.LAND)
    expect(world.terrain[at(12, 19)], 'row 19 is the gap').toBe(TERRAIN.LAND)
    let riverRows = 0
    for (let y = REVEALED_Y0; y <= REVEALED_Y1; y++) {
      if (y === 18 || y === 19) continue
      expect(world.passable[at(12, y)], `column 12 row ${y} must be river`).toBe(0)
      riverRows++
    }
    expect(riverRows, 'the river must actually run the height of the rect').toBe(20)

    // One component over the rect's passable cells.
    const inRect = (x: number, y: number): boolean =>
      x >= REVEALED_X0 && x <= REVEALED_X1 && y >= REVEALED_Y0 && y <= REVEALED_Y1
    const walk = (from: number): Set<number> => {
      const seen = new Set<number>([from])
      const stack = [from]
      while (stack.length > 0) {
        const c = stack.pop() as number
        for (let dir = 0; dir < 8; dir++) {
          const n = stepCell(c, dir, world.w, world.h)
          if (n < 0 || seen.has(n)) continue
          if (!inRect(n % GRID_W, (n / GRID_W) | 0)) continue
          if (world.passable[n] !== 1) continue
          seen.add(n)
          stack.push(n)
        }
      }
      return seen
    }
    // From D2's carpark on the east bank (17, 14) to D0's on the west (8, 10).
    const east = walk(D2_CARPARK)
    expect(east.has(D0_CARPARK), 'the two banks are not one component').toBe(true)
    expect(east.has(H0_CELL), 'and every seeded building is in it').toBe(true)
    let passableInRect = 0
    for (let y = REVEALED_Y0; y <= REVEALED_Y1; y++) {
      for (let x = REVEALED_X0; x <= REVEALED_X1; x++) {
        if (world.passable[at(x, y)] === 1) passableInRect++
      }
    }
    expect(east.size, 'the rect is one component, not two joined by a corner').toBe(passableInRect)

    // **Non-vacuity, and it is the whole test:** fill the gap and the two banks
    // separate. Without this, "one component" is satisfied by a board with no
    // river at all. Mutating `world.passable` is safe — this rig is discarded.
    world.passable[at(12, 18)] = 0
    world.passable[at(12, 19)] = 0
    const severed = walk(D2_CARPARK)
    expect(severed.has(D0_CARPARK), 'with the gap closed the banks MUST separate').toBe(false)
    expect(severed.size).toBeLessThan(east.size)
  })

  it('GATE A — trips and CARS IN MOTION, including cars the spawner put there', () => {
    // **The clause M1d failed and the clause Task 5 failed, in one case.**
    // M1d's shipped board measured `maxInFlight` 1 over 200,000 ticks; Task 5's
    // spawner rig reached 22 houses and 10 destinations with exactly one
    // spawned car in motion. Both thresholds below are set against those
    // numbers rather than just under the measurement, so passing them means
    // something specific rather than "better than today".
    const greedy = gateRun('greedy')
    // Measured: 747 trips, 11 cars in flight at once, 9 of them from spawned
    // houses, 25 houses and 12 destinations by week 6.
    //
    // **Ordered narrowest-first, deliberately.** `trips` moves for almost any
    // regression in the sim, so a broad bound above a specific one would make
    // the specific one dead and hand the maintainer the wrong diagnosis —
    // measured: with the house spawner disabled, this case reported *"completed
    // trips: expected 339 to be >= 400"* while the assertion that actually
    // names the cause sat below it and never ran.
    expect(
      greedy.maxSpawnedInFlight,
      'peak cars in motion from SPAWNER-placed houses — Task 5 measured 1',
    ).toBeGreaterThanOrEqual(4)
    expect(greedy.maxInFlight, 'peak cars in motion — M1d measured 1').toBeGreaterThanOrEqual(6)
    expect(greedy.trips, 'completed trips').toBeGreaterThanOrEqual(400)

    // **The discrimination, on the same board and the same boot.** Every
    // threshold above is satisfiable by a busier fixture; none of them is
    // satisfiable by this board with no player input, which is what the
    // demotion was about.
    const idle = gateRun('no-input')
    expect(idle.trips, 'no input, no road, no trip').toBe(0)
    expect(idle.maxInFlight, 'and not one car ever leaves a driveway').toBe(0)

    // Growth in population is NOT what is being asserted — it is reported, as
    // the input to the thing above rather than as evidence of it.
    const last = greedy.weeks[greedy.weeks.length - 1] as GateWeek
    expect(last.houses, 'reported, not gated').toBeGreaterThan(3)
    expect(last.dests, 'reported, not gated').toBeGreaterThan(3)
    // Nothing may ever spawn where the player cannot see it — **and this is
    // LABELLED NEAR-TAUTOLOGICAL rather than counted as coverage.** It is
    // computed with `destinationFitsSpawnZone`, which is the same predicate
    // `attemptDestinationSpawn` consults before placing, so for a SPAWNED
    // destination the two agree by construction and no spawner bug can turn it
    // red. What it does cover is the seeded board and any future path that
    // places a destination without consulting that predicate. The real version
    // — a sweep over every footprint cell and the carpark, in coordinates,
    // against a packing rig that reaches the zone's far edges — is
    // `spawn.test.ts`'s, and it is where a regression here would actually be
    // caught. Kept because it costs nothing on a run that is happening anyway;
    // do not read its passing as evidence about the spawner.
    expect(greedy.outsideRect, 'a building spawned outside the revealed rect').toBe(0)
    expect(idle.outsideRect).toBe(0)
  })

  it('GATE B — the delivery fraction falls when the player stops keeping up', () => {
    // **`trips / fires`, and the two arms say different things on purpose.**
    //
    // The gated half is the FIXED network: a player who draws the 20-tile
    // opening and then stops. Demand grows against a road network that does
    // not, and one number says so. Measured: 32/38 = 0.842 in week 0, 39/55 =
    // 0.709 in week 1 — the same shape the demo board's corridor gives (0.82
    // falling to 0.39 by week 19).
    //
    // **Which term of "demand grows" this actually catches was measured rather
    // than assumed, and it is not the one the sentence above would suggest.**
    // Freezing the weekly ramp (`pinPeriodForWeek(0)`) leaves this case GREEN;
    // freezing the destination spawner takes week 1 to **1.05** and turns it
    // red. So the fall is dominated by the rotation slots each new destination
    // adds, with §5.3's ramp as a second, smaller term — and the detector this
    // case really owns is *"demand outgrew a network the player stopped
    // growing"*, whichever half of demand did the growing.
    const opening = gateRun('opening')
    expect(opening.weeks.length, 'the opening arm must reach a second week').toBeGreaterThanOrEqual(2)
    const w0 = opening.weeks[0] as GateWeek
    const w1 = opening.weeks[1] as GateWeek
    expect(w0.fires, 'vacuity: demand must actually have fired').toBeGreaterThan(20)
    expect(w1.fires, 'and again in week 1').toBeGreaterThan(20)
    expect(w0.frac, 'week 0 delivers most of what fires').toBeGreaterThanOrEqual(0.8)
    expect(w1.frac, 'and week 1 does not').toBeLessThanOrEqual(0.75)
    expect(w0.frac - w1.frac, 'the ramp costs at least 5 points in one week').toBeGreaterThanOrEqual(
      0.05,
    )
    // The denominator is the ramp, not the network shrinking: MORE fired in
    // week 1 than in week 0, and fewer of them landed.
    expect(w1.fires, 'demand grew').toBeGreaterThan(w0.fires)

    // **The reported half, and it is the finding rather than the threshold.**
    // Under greedy play this board delivers 97.5 % of everything demand fires
    // and still dies, because the failure is distributional rather than a
    // throughput collapse. A gate that demanded a falling fraction here would
    // be demanding the wrong failure mode.
    const greedy = gateRun('greedy')
    const cumulative = greedy.trips / greedy.fires
    expect(cumulative, 'the network keeps up almost perfectly').toBeGreaterThanOrEqual(0.9)
    expect(cumulative, 'and not completely — some demand is always in flight').toBeLessThan(1)
    // ...and it keeps up without ever dropping a pin, which is the other half
    // of "the player was not beaten by something they could not control". Both
    // clauses are per-week rather than in aggregate: a single week of dropped
    // pins is demand the player could not have served however they played, and
    // a total would let a late collapse hide behind an early surplus.
    //
    // **Both are properties of THIS seed and are stated as such.** Across the
    // five seeds measured at Task 10 the other four drop 0, 6, 13 and 16 pins,
    // every one of them in the week the run dies; `tilesLeft` bottoms out at 37
    // here and at 38-40 elsewhere, and never at 0.
    for (const wk of greedy.weeks) {
      expect(wk.dropped, `week ${wk.week} dropped pins`).toBe(0)
      expect(wk.tilesLeft, `week ${wk.week} ran out of tiles`).toBeGreaterThan(0)
    }
    expect(greedy.unaffordable, 'no connect decision was unaffordable on this seed').toBe(0)
  })

  it('GATE C — peak destPins on a CONNECTED destination climbs to its timer cap', () => {
    // **The shape, not the level.** A board where a connected destination sits
    // at 1 pin forever is a board where service outruns demand — M1d's hole,
    // and measured, exactly what plan Step 3's proposed spawner lever produces
    // (1 in every one of twelve weeks). A board that steps straight from 1 to
    // the cap has no difficulty curve either. What a curve looks like is a
    // gradient, so that is what this asserts — in THREE weeks, not two:
    //
    //   1. an early week whose peak over connected destinations is exactly 1;
    //   2. a strictly later week that is **above 1 and still below every
    //      connected destination's own timer cap** — the intermediate step;
    //   3. a strictly later week still at or above one of those caps.
    //
    // `PIN_CAP_*_TIMER`, the TIMER cap, because `overcrowdTriggerCap` is what
    // the meter reads — not the hard cap `hasRoom` reads. Clause 2 is expressed
    // as "at least 2 pins AND no connected destination reached its own cap this
    // week", which is the per-destination form of "strictly between": the cap
    // is 6 for a square and 8 for a circle and the board carries both.
    //
    // **Clause 2 was missing until the Task 10 review, and its absence was the
    // exact defect this comment claimed to guard against.** Run over synthetic
    // series against a square cap of 6, the two-clause predicate PASSED
    // `[1, 1, 1, 6, 6]` and `[1, 1, 1, 14, 14]` — a one-week jump from 1 to the
    // cap, held one more week — while the comment above it said a step was
    // rejected. With clause 2 both fail, and so do `[1, 1, 1, 10]` (no
    // intermediate week) and `[1, 2, 2, 2, 2]` (never reaches a cap). The flat
    // series the lever produces, `[1] * 13`, fails on clause 2 as it did on the
    // old clause 2 — that half was always genuinely caught.
    //
    // Measured on the shipped seed: 1, 1, 1, 1, 2, 5, 10 across weeks 0-6,
    // against a square timer cap of 6 and a hard cap of 10. Clause 2 is
    // satisfied twice over, at weeks 4 (peak 2) and 5 (peak 5), neither of
    // which reaches a cap.
    const greedy = gateRun('greedy')
    const peaks = greedy.weeks.map((w) => w.peakPinsConnected)
    const { flat, risen, capped } = gradientIndices(greedy.weeks)
    expect(flat, 'no week where a connected destination held exactly one pin').toBeGreaterThanOrEqual(0)
    expect(
      risen,
      `no later week strictly between 1 and the timer cap — peaks were ${peaks.join(', ')}`,
    ).toBeGreaterThan(flat)
    expect(
      capped,
      `no connected destination ever reached its own timer cap — peaks were ${peaks.join(', ')}`,
    ).toBeGreaterThan(risen)

    // The board-wide sum climbs with it, which is the same claim read the other
    // way: it is not one destination's spike on an otherwise idle board.
    // Measured 2 -> 18.
    const sums = greedy.weeks.map((w) => w.peakSumPins)
    expect(Math.max(...sums), 'peak sum(destPins)').toBeGreaterThanOrEqual(8)
    expect(Math.max(...sums)).toBeGreaterThan(sums[0] as number)

    // **And the run ends on a destination the player HAD connected.** That is
    // what makes the loss legible as "you did not keep up" rather than "the
    // spawner put a building somewhere you could not reach" — the failure shape
    // that killed three fixtures at Task 8. It is also the arm of Task 9's
    // shutdown copy that a competent player gets: `WENT UNSERVED`, not
    // `NO ROAD REACHES`.
    expect(greedy.deathTick, 'the greedy arm must actually end within the window').toBeGreaterThan(0)
    expect(greedy.failedDest, 'and name a destination').toBeGreaterThanOrEqual(0)
    expect(
      greedy.failedDestConnected,
      `destination ${greedy.failedDest} killed the run and had no road`,
    ).toBe(true)

    // The contrast, same board, no input: the killer is ROADLESS, its pins run
    // far past any timer cap, and no connected destination ever climbs at all.
    const idle = gateRun('no-input')
    expect(idle.failedDestConnected, 'with no roads, the killer cannot be connected').toBe(false)
    for (const wk of idle.weeks) {
      expect(wk.peakPinsConnected, `week ${wk.week}: nothing is connected`).toBe(0)
    }
    expect(Math.max(...idle.weeks.map((w) => w.peakPinsRoadless))).toBeGreaterThan(
      PIN_CAP_CIRCLE_TIMER,
    )
  })

  it('rejects a one-week jump from 1 to the cap, which the two-clause form did not', () => {
    // **The artefact for the paragraph above, and it exists because the
    // paragraph was WRONG before the Task 10 review.** Gate C's comment claimed
    // a step straight from 1 to the cap was rejected; the predicate it
    // described — a week at 1, a later week >= 2, a later week at the cap — is
    // satisfied by exactly that step, because the capped week is also a week
    // above 1. The reviewer found it by running synthetic series.
    //
    // These run `gradientIndices`, the SAME function Gate C runs, so the
    // comment cannot drift away from the assertion the way it just did.
    const series = (
      peaks: readonly number[],
      cap = PIN_CAP_SQUARE_TIMER,
    ): { peakPinsConnected: number; capReachedConnected: boolean }[] =>
      peaks.map((p) => ({ peakPinsConnected: p, capReachedConnected: p >= cap }))

    const passes = (peaks: readonly number[]): boolean => {
      const g = gradientIndices(series(peaks))
      return g.flat >= 0 && g.risen > g.flat && g.capped > g.risen
    }

    // Rejected: a one-week jump, held for a second week. Both of these PASSED
    // the two-clause form.
    expect(passes([1, 1, 1, 6, 6]), 'a jump from 1 to the cap is not a gradient').toBe(false)
    expect(passes([1, 1, 1, 14, 14]), 'nor is a jump straight past it').toBe(false)
    // Rejected for the two reasons the old form did catch, so the new clause is
    // an addition rather than a replacement.
    expect(passes([1, 1, 1, 10]), 'no intermediate week at all').toBe(false)
    expect(passes([1, 2, 2, 2, 2]), 'never reaches a cap').toBe(false)
    expect(passes([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), "the lever's flat 1").toBe(false)
    // Accepted: the shape the shipped board actually produces, and the minimum
    // shape that counts — so this is not a predicate that rejects everything.
    expect(passes([1, 1, 1, 1, 2, 5, 10]), 'the measured series must still pass').toBe(true)
    expect(passes([1, 2, 6]), 'three weeks is the smallest gradient there is').toBe(true)
    // ...and the ORDER is load-bearing: the same three values out of order are
    // not a curve.
    expect(passes([6, 2, 1]), 'a falling series is not a difficulty curve').toBe(false)
  })

  it('reports what the gate does NOT gate on, so the numbers outlive this task', () => {
    // **Survival in weeks is reported and not gated, and that is deliberate.**
    //
    // ---------------------------------------------------------------------
    // THE FIVE COMPARISON RUNS, BY SEED — the enumeration, not the summary
    // ---------------------------------------------------------------------
    // Everything below was driven through THIS rig, greedy arm, twelve weeks,
    // at M1e Task 10. The seed strings are written out because the catalogue's
    // rule is "state the enumeration or drop the figure": without them, a
    // future task that turns one of the assertions in this block red cannot
    // tell "the game broke" from "that seed's dying week moved", because the
    // comparison runs cannot be re-derived.
    //
    // ```
    //   seed          dies    wk  killer  trips  cumFrac  inFl  drop  unaff  minTiles
    //   laneways-m2   31,456   6  D6 (c)    747    0.975    11     0      0        37
    //   gate-b        never   12+ —       1,916    0.994    10     0     75        40
    //   gate-c        32,895   7  D10 (c)   829    0.933    16     6     75        40
    //   gate-d        49,279  10  D11 (c) 1,376    0.932    17    16      0        38
    //   gate-e        14,588   3  D2 (c)    150    0.694     9    13     75        40
    //
    //   peak destPins on connected destinations, per week:
    //   laneways-m2   1 1 1 1 2 5 10
    //   gate-b        1 4 1 1 1 1 1 1 1 1 1 2 2
    //   gate-c        1 4 1 1 1 1 10 10
    //   gate-d        1 1 1 1 1 1 1 1 1 2 10
    //   gate-e        1 4 14 14
    // ```
    //
    // `(c)` is "the killer's carpark was on the road network". Every seed dies
    // on a connected destination or does not die at all. **`unaff` is the count
    // of greedy decisions refused for budget, and all 75 on each of the three
    // seeds that have any fall in the half-week straight after the 20-tile
    // opening**, while the spend is being re-granted — never later, and never
    // with the budget at 0.
    //
    // **What this block's own assertions would do on the other four seeds, so
    // nobody reads them as universal:** Gate B's per-week `dropped === 0` and
    // `unaffordable === 0` would FAIL on three of the five, and Gate C's
    // strengthened gradient would fail on `gate-b` — the seed that never dies,
    // so nothing ever reaches a cap inside the window. The gate is gated on the
    // seed that SHIPS, which is the right scope for a claim about the board a
    // plain load opens, and the spread is here so the scope is visible.
    //
    // A survival threshold on 6 / 12+ / 7 / 10 / 3 at n = 1 would be a coin
    // flip, and the shipped seed is not the median. The gate is on the shape
    // (C) and on the absence of an unplayable failure (B).
    //
    // ---------------------------------------------------------------------
    // TWO OF PLAN STEP 5'S PASS NUMBERS WERE RELAXED, AND HERE IS WHICH
    // ---------------------------------------------------------------------
    // Plan Task 10 Step 5's Gate C required `maxInFlight >= 3` (**kept**, and
    // raised to 6 in Gate A above), `longestQueue >= 4` and
    // `blockedTicks > 10,000 by week 11`. Shipped: **>= 3** and **> 1,000**.
    // Both were relaxed deliberately and neither quietly:
    //
    //   - the plan's 4 and 14,199 are measurements of the LEVER's build at week
    //     11, and Task 10 measured that build to be unreproducible in every
    //     other respect — on this tree the lever gives longest queue 1 and zero
    //     blocked ticks, so its week-11 figures cannot be a floor for anything;
    //   - the shipped board's greedy arm **ends in week 6**, so "by week 11"
    //     names a week this board does not reach. A clause that can never be
    //     evaluated is not a gate.
    //
    // Measured here: longest queue **4** against a floor of 3, and **1,920**
    // blocked ticks against a floor of 1,000. The floors sit under the
    // measurement rather than under the plan's number, and the plan's number is
    // recorded above so the deviation is a decision rather than a drift.
    //
    // `refusals` is reported for the same reason and a different one: it stays
    // 0 on this board for the whole measured run, where the demo board scores
    // thousands. That is the one clause of M1d's demotion that did NOT stop
    // being true, and `layouts.ts` says so rather than claiming otherwise.
    const greedy = gateRun('greedy')
    let refusals = 0
    let blocked = 0
    let longest = 0
    for (const wk of greedy.weeks) {
      refusals += wk.refusals
      blocked += wk.blockedTicks
      longest = Math.max(longest, wk.longestQueue)
    }
    expect(refusals, 'this board loads up; it does not grind').toBe(0)
    // Blocking DOES fire here, late — 0 through week 1, then hundreds of ticks
    // a week from week 2. Asserted as a floor only, because the week it starts
    // is a spawn-placement property and pinning it would make every tuning
    // change a failure that says nothing about blocking.
    expect(blocked, 'M1d blocking never fired on this board at all').toBeGreaterThan(1000)
    expect(longest, 'and cars really do stand behind each other').toBeGreaterThanOrEqual(3)
    expect(greedy.weeks[0]?.blockedTicks, 'but not in the first week — it is a late property').toBe(0)
  })
})
