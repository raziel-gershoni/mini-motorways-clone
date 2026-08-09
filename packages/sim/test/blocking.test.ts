import { describe, it, expect } from 'vitest'
import {
  parseMap,
  CARS_PER_HOUSE,
  COST_UNIT_SCALE,
  LANE_SPEED_DEFAULT,
  ORTHO_COST,
  type MapData,
} from '@laneways/shared'
import {
  createState,
  snapshot,
  restore,
  hashState,
  H_DEST_COUNT,
  H_HOUSE_COUNT,
  H_ROUTES_REFUSED,
  H_SCORE,
  H_TICK,
  type GameState,
} from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFieldInputRanges } from '../src/regions'
import { createScratch, createFlowFields, CT_REBUILDS, type FlowField, type Scratch } from '../src/scratch'
import { LANE_COUNT, LANE_OF_DIR, DX, DY, OPPOSITE, stepCell } from '../src/roads'
import {
  placeHouse,
  placeDestination,
  DEST_KIND_SQUARE,
  ORIENTATION_S,
  PHASE_IDLE,
  PHASE_NONE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
} from '../src/buildings'
import {
  FREE,
  OCCUPANCY_MAX_CAR_INDEX,
  EnterOutcome,
  canEnter,
  occupancySlot,
  occupantOf,
  claimCell,
  releaseCell,
  hasCrossedThisLeg,
  assertEnterCellOnBoard,
  assertMaxCarsFitsOccupancy,
  assertOccupancySound,
  assertOccupancyComplete,
  assertOccupancyConsistent,
  type EnterOutcomeCode,
} from '../src/blocking'
import { runMovement, speedUnits } from '../src/cars'
import { packRouteStep } from '../src/dispatch'
import { runArrivals } from '../src/trips'
import { step, type TickAction, type TickInputs } from '../src/step'

/**
 * M1d Task 2: the occupancy region and its claim/release lifecycle.
 *
 * **This task adds no refusals.** Every fixture here drives the REAL tick
 * through `step`, and no car's motion differs by a single tick from what M1c
 * shipped — that is the property that makes Task 2's golden re-bless provably
 * layout-only, and several assertions below exist only to hold it.
 *
 * ---------------------------------------------------------------------------
 * THE L FIXTURE, AND WHY IT HAS TO TURN
 * ---------------------------------------------------------------------------
 *
 * All-land 20 x 12 board, so `cell = y * 20 + x`, non-square deliberately (a
 * transposed index lands off-grid or on the wrong row rather than
 * coincidentally agreeing). One colour-0 house, one colour-0 destination, and
 * an **L-shaped corridor with a genuine 90-degree turn in the middle of it**:
 *
 *          x:        8   9
 *      row 0:       [dest origin (8,0), orientation S]
 *      row 1:       [ footprint 2 wide x 3 tall ]
 *      row 2:       [                          ]
 *      row 3:        K = carpark (8,3) = 68
 *      row 4:        |  88
 *      row 5:        |  108
 *      row 6:        |  128
 *      row 7:  H-----C   H = house (2,7) = 142, C = corner (8,7) = 148
 *              142 ..148
 *
 * Road segments, all orthogonal: 142-143-...-148 along row 7, then
 * 148-128-108-88-68 up column 8. There is exactly one path from the house to
 * the carpark, so the committed route is forced: **six E steps, then four N
 * steps**, 10 steps in all.
 *
 * **The turn is the whole point of this shape.** `LANE_OF_DIR[E = 2] = 0` and
 * `LANE_OF_DIR[N = 0] = 1`, so at cell 148 the car ENTERS by lane 0 and LEAVES
 * by lane 1. On a straight corridor "release the lane I entered by" and
 * "release the lane I am leaving by" are the same write and the mutation is
 * equivalent; here they are opposite writes. The return leg turns at the same
 * cell in the mirror sense (enters by S = lane 0, leaves by W = lane 1), so the
 * discriminator fires twice per trip. `LANE_COUNT` is 2, so "both lanes differ"
 * is the strongest form available and it is asserted as a vacuity check rather
 * than assumed.
 *
 * ---------------------------------------------------------------------------
 * THE TIMELINE, HAND-COMPUTED AND NEVER READ BACK
 * ---------------------------------------------------------------------------
 *
 * `speedUnits(LANE_SPEED_DEFAULT)` = 330 progress units per tick; an orthogonal
 * cell costs `ORTHO_COST * COST_UNIT_SCALE` = 2500. Progress carries across a
 * cell crossing AND across the outbound -> return flip, so a car makes its k-th
 * crossing on the first tick whose accumulated progress reaches `k * 2500`:
 * `rel_k = ceil(250k / 33)`, counting the dispatch tick itself as rel 1
 * (movement is phase 6, dispatch phase 5, same tick).
 *
 *   k:      1  2  3  4  5  6  7  8  9 10  11  12  13  14  15  16  17  18  19  20
 *   rel_k:  8 16 23 31 38 46 54 61 69 76  84  91  99 107 114 122 129 137 144 152
 *
 * Roads go in at tick 1 through `step`'s action path; the single pin is written
 * directly into `destPins` after tick 1 (exactly the byte a pin fire writes),
 * so dispatch lands on **tick 2** and `abs = 2 + rel_k - 1 = rel_k + 1`:
 *
 *   outbound   143@9  144@17 145@24 146@32 147@39 148@47 128@55 108@62 88@70 68@77
 *   return      88@85 108@92 128@100 148@108 147@115 146@123 145@130 144@138
 *              143@145 142@153
 *
 * Tick 77 is the arrival (cursor reaches routeLen, phase flips in place on the
 * carpark cell). Tick 153 is trip end: the car's LAST crossing enters the house
 * cell in phase 6 and `completeTrip` releases it in phase 7, **on the same
 * tick**, which is the strongest form of the release assertion available.
 *
 * The demand timer is frozen for the whole window and that is asserted, not
 * assumed: one square destination spawned at tick 0 is ineligible until
 * `FIRST_PIN_DELAY_TICKS` = 120 and then needs `PIN_PERIOD_TICKS` = 518 further
 * eligible ticks at one slot a tick, so the first demand-driven pin is around
 * tick 638 — far outside a 160-tick run. `runFixture` asserts no unscripted
 * `destPins` write happens anyway, because a stray pin would dispatch the
 * sibling car and quietly change everything below.
 */

const W = 20
const H = 12
const CELLS = W * H

const HOUSE_CELL = 142 // (2,7)
/**
 * A SECOND house, of a different colour, standing on the corridor at (5,7) —
 * used only by the "a house cell is not exempt" fixture. Colour 1, because a
 * colour-0 house here would be nearer to the carpark than the car's own and
 * would win the dispatch.
 */
const MID_HOUSE_CELL = 145 // (5,7)
const CORNER_CELL = 148 // (8,7) — the 90-degree turn
const CARPARK_CELL = 68 // (8,3)
const DEST_ORIGIN = 8 // (8,0), orientation S -> carpark at (8,3)

const DIR_E = 2
const DIR_N = 0
const DIR_S = 4
const DIR_W = 6

const ROUTE_LEN = 10
const DISPATCH_TICK = 2
const RUN_TICKS = 160
const STARTING_TILES = 999

/**
 * The two numbers every hand-computed tick in this file is derived from, read
 * from the constants rather than typed as literals — `constants.test.ts` pins
 * both, and a change to either must break these derivations rather than
 * silently re-time them.
 */
const SPEED = speedUnits(LANE_SPEED_DEFAULT) // 330 progress units per tick
const ORTHO_THRESHOLD = ORTHO_COST * COST_UNIT_SCALE // 2,500 per orthogonal cell

/** Hand-computed absolute ticks; see the module comment. Never read back from a run. */
const T_ENTER_CORNER_OUTBOUND = 47
const T_LEAVE_CORNER_OUTBOUND = 55
const T_ARRIVE_CARPARK = 77
const T_ENTER_CORNER_RETURN = 108
const T_LEAVE_CORNER_RETURN = 115
const T_TRIP_END = 153
const T_ENTER_MID_HOUSE = 24 // crossing k=3
const T_LEAVE_MID_HOUSE = 32 // crossing k=4
/**
 * The sibling's trip end, with two pins in the L fixture: car 1 is refused at
 * the first crossing (tick 9), takes it at tick 17 carrying car 0's own tick-9
 * residual, and is therefore car 0's whole 153-tick trip shifted by exactly 8.
 * Derived in the `both cars score` test, never read back from a run.
 */
const T_SIBLING_TRIP_END = T_TRIP_END + 8 // 161
/** A quiet mid-flight tick: a crossing happens, no road moves, no pin moves. */
const T_QUIET_CROSSING = 9
/**
 * The end of the CT_REBUILDS window, and it must be strictly AFTER a crossing,
 * not on one: `syncFields` is phase 4 and `runMovement` is phase 6, so an
 * occupancy write on tick T is first visible to the field-input hash on tick
 * T+1. Ticks 9 and 17 are the two crossings inside it.
 */
const CT_WINDOW_END = 20

function allLandRows(w: number, h: number): string[] {
  const row = '.'.repeat(w)
  return Array.from({ length: h }, () => row)
}

interface Rig {
  readonly state: GameState
  readonly world: WorldData
  readonly map: MapData
  readonly scratch: Scratch
  readonly fields: FlowField[]
}

function makeRig(id: string, seed: string): Rig {
  const map = parseMap(id, allLandRows(W, H), STARTING_TILES, 40, 16, 5)
  const world = createWorld(map)
  return {
    state: createState(seed, map),
    world,
    map,
    scratch: createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map)),
    fields: createFlowFields(map.groupCount, world.cells),
  }
}

/** The L corridor, as `step` input actions: row 7 x=2..8, then column 8 y=7..3. */
function corridorActions(): TickAction[] {
  const out: TickAction[] = []
  for (let cell = HOUSE_CELL; cell < CORNER_CELL; cell++) out.push({ kind: 'place', a: cell, b: cell + 1 })
  for (let cell = CORNER_CELL; cell > CARPARK_CELL; cell -= W) out.push({ kind: 'place', a: cell, b: cell - W })
  return out
}

const NO_ACTIONS: TickInputs = { actions: [] }

function buildFixture(seed: string): Rig {
  const r = makeRig('blocking-L', seed)
  expect(placeDestination(r.state, r.world, DEST_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeHouse(r.state, r.world, HOUSE_CELL, 0)).toBe(true)
  expect(r.state.header[H_DEST_COUNT]).toBe(1)
  expect(r.state.header[H_HOUSE_COUNT]).toBe(1)
  return r
}

/** The same board plus a colour-1 house standing on the corridor at `MID_HOUSE_CELL`. */
function buildFixtureWithMidHouse(seed: string): Rig {
  const r = buildFixture(seed)
  expect(placeHouse(r.state, r.world, MID_HOUSE_CELL, 1)).toBe(true)
  return r
}

/** Both of `cell`'s occupancy slots, as a plain pair, for readable assertions. */
function slotsOf(s: GameState, cell: number): [number, number] {
  return [occupantOf(s, cell, 0), occupantOf(s, cell, 1)]
}

interface Trace {
  /** `carCell[0]` at the END of each tick, indexed by tick (index 0 unused). */
  readonly cellAfterTick: number[]
  /** `[lane0, lane1]` of every cell the car ever stood on, at the end of each tick. */
  readonly slotsAfterTick: Map<number, [number, number]>[]
  readonly phaseAfterTick: number[]
  readonly rebuildsAfterTick: number[]
  readonly blockedAfterTick: number[]
  /** Peak value `assertOccupancyComplete` returned — the completeness vacuity handle. */
  maxCompletenessChecked: number
  /** Ticks on which `carCell[0]` changed. */
  readonly crossingTicks: number[]
}

/**
 * Runs the fixture for `ticks` ticks, asserting `assertOccupancyConsistent`
 * (BOTH halves) after every single one and recording enough per-tick state that
 * every assertion below is made against a hand-computed tick number rather than
 * against whatever the run happened to do.
 *
 * `pins` is written directly into `destPins` after tick 1, which is exactly the
 * byte a pin fire writes.
 */
function runFixture(r: Rig, ticks: number, pins: number): Trace {
  const watched = [HOUSE_CELL, 143, 144, 145, 146, 147, CORNER_CELL, 128, 108, 88, CARPARK_CELL]
  const trace: Trace = {
    cellAfterTick: [],
    slotsAfterTick: [],
    phaseAfterTick: [],
    rebuildsAfterTick: [],
    blockedAfterTick: [],
    maxCompletenessChecked: 0,
    crossingTicks: [],
  }
  let prevCell = r.state.carCell[0] as number
  let pinsWrittenByScript = 0
  let pinsSeenLastTick = r.state.destPins[0] as number

  for (let tick = 1; tick <= ticks; tick++) {
    step(r.state, r.world, r.fields, r.scratch, tick === 1 ? { actions: corridorActions() } : NO_ACTIONS)
    if (tick === 1) {
      r.state.destPins[0] = pins
      pinsWrittenByScript += pins
      pinsSeenLastTick = pins
    } else {
      // Guard, not an assumption: the demand timer must stay frozen for the
      // whole window. A stray pin dispatches the sibling car and silently
      // invalidates every hand-computed tick below. `destPins` may only FALL
      // here (an arrival consuming one), never rise.
      const now = r.state.destPins[0] as number
      expect(now, `destPins rose on tick ${tick} — demand fired inside the window`).toBeLessThanOrEqual(
        pinsSeenLastTick,
      )
      pinsSeenLastTick = now
    }

    trace.maxCompletenessChecked = Math.max(
      trace.maxCompletenessChecked,
      assertOccupancyConsistent(r.state, r.world),
    )

    const cell = r.state.carCell[0] as number
    trace.cellAfterTick[tick] = cell
    trace.phaseAfterTick[tick] = r.state.carPhase[0] as number
    trace.rebuildsAfterTick[tick] = r.scratch.counters[CT_REBUILDS] as number
    trace.blockedAfterTick[tick] = r.state.carBlockedTicks[0] as number
    const snap = new Map<number, [number, number]>()
    for (const c of watched) snap.set(c, slotsOf(r.state, c))
    trace.slotsAfterTick[tick] = snap
    if (cell !== prevCell) trace.crossingTicks.push(tick)
    prevCell = cell
  }
  expect(pinsWrittenByScript).toBe(pins) // vacuity: the script really wrote the pin
  return trace
}

// ---------------------------------------------------------------------------
// 1. Creation — lifecycle event 1
// ---------------------------------------------------------------------------

describe('createState fills occupancy with FREE (lifecycle event 1)', () => {
  it('every slot of a fresh state reads FREE, over 2 x cells slots', () => {
    const r = makeRig('fresh-free', 'fresh-free')
    expect(r.state.occupancy.length).toBe(CELLS * LANE_COUNT)
    for (let slot = 0; slot < r.state.occupancy.length; slot++) {
      expect(r.state.occupancy[slot], `slot ${slot}`).toBe(FREE)
    }
  })

  it('not one slot reads 0, because 0 is a valid car index — the zero-fill mutation', () => {
    // The direct observer for "zero-fill occupancy instead of -1-filling it".
    // A zero-filled region reads as "car 0 occupies every lane of every cell"
    // and nothing on the board could move once Task 3 refuses entries; in Task
    // 2 it is silent, which is exactly why it needs an assertion of its own
    // now rather than a behavioural one later.
    const r = makeRig('fresh-nonzero', 'fresh-nonzero')
    let zeroes = 0
    for (let slot = 0; slot < r.state.occupancy.length; slot++) {
      if (r.state.occupancy[slot] === 0) zeroes++
    }
    expect(zeroes).toBe(0)
  })

  it('two fresh states of the same shape are byte-identical, fill and all', () => {
    // The fill must be deterministic and unconditional, or "a building-free
    // state is byte-identical to a from-scratch state of the same shape" —
    // the property every unchanged-goldens assertion rests on — stops holding.
    const a = makeRig('twin', 'same-seed')
    const b = makeRig('twin', 'same-seed')
    expect(hashState(a.state)).toBe(hashState(b.state))
    expect(new Uint8Array(a.state.buffer)).toEqual(new Uint8Array(b.state.buffer))
  })

  it('carBlockedTicks is all zero on a fresh state — Task 4 gives it semantics, Task 2 only shape', () => {
    const r = makeRig('fresh-blocked', 'fresh-blocked')
    expect(r.state.carBlockedTicks.length).toBe(CARS_PER_HOUSE * r.map.maxHouses)
    expect(Array.from(r.state.carBlockedTicks).every((v) => v === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Slot arithmetic and the Int16 bound
// ---------------------------------------------------------------------------

describe('slot arithmetic and the Int16 car-index bound', () => {
  it('occupancySlot is cell * 2 + lane, and the two lanes of a cell are adjacent and distinct', () => {
    for (const cell of [0, 1, 17, 239]) {
      expect(occupancySlot(cell, 0)).toBe(cell * 2)
      expect(occupancySlot(cell, 1)).toBe(cell * 2 + 1)
      expect(occupancySlot(cell, 1) - occupancySlot(cell, 0)).toBe(1)
    }
    // The two index conventions must not be confused: `cell * 2 + lane` is not
    // `y * w + x`. Cell 1 lane 0 and cell 0 lane 1 are different slots.
    expect(occupancySlot(1, 0)).not.toBe(occupancySlot(0, 1))
  })

  it('assertMaxCarsFitsOccupancy accepts every admissible count and rejects the first inadmissible one', () => {
    expect(() => assertMaxCarsFitsOccupancy(0)).not.toThrow()
    expect(() => assertMaxCarsFitsOccupancy(80)).not.toThrow() // firstCity
    // The bound is on the largest INDEX, so a count of exactly
    // OCCUPANCY_MAX_CAR_INDEX + 1 = 32,768 is admissible (its highest index is
    // 32,767) and 32,769 is the first that is not.
    expect(() => assertMaxCarsFitsOccupancy(OCCUPANCY_MAX_CAR_INDEX + 1)).not.toThrow()
    expect(() => assertMaxCarsFitsOccupancy(OCCUPANCY_MAX_CAR_INDEX + 2)).toThrow(/Int16 occupancy slot/)
    expect(() => assertMaxCarsFitsOccupancy(-1)).toThrow(/Int16 occupancy slot/)
    expect(() => assertMaxCarsFitsOccupancy(1.5)).toThrow(/Int16 occupancy slot/)
  })

  it('the failure it prevents is silent COERCION, not a range error — demonstrated on a real Int16Array', () => {
    // Why the assertion has to exist at all: `Int16Array` coerces rather than
    // throwing, so without it car 32,768 would be stored as -32,768 and no
    // lookup could ever match it again. Shown here rather than asserted in
    // prose, because "an out-of-contract input must not be able to brick the
    // thing" is a claim about the engine, and the engine can be asked.
    const a = new Int16Array(1)
    a[0] = OCCUPANCY_MAX_CAR_INDEX + 1
    expect(a[0]).toBe(-(OCCUPANCY_MAX_CAR_INDEX + 1))
    expect(a[0]).not.toBe(OCCUPANCY_MAX_CAR_INDEX + 1)
  })

  it('createState runs the assertion — a map whose maxCars overflows is refused at construction', () => {
    // Reached through the real production call site, not only directly:
    // `parseMap` puts no ceiling on maxHouses, so this is the only thing
    // standing between an oversized map and a silently corrupt region.
    const maxHouses = Math.ceil((OCCUPANCY_MAX_CAR_INDEX + 2) / CARS_PER_HOUSE)
    const big = parseMap('too-many-cars', allLandRows(4, 4), 10, maxHouses, 4, 5)
    expect(() => createState('overflow', big)).toThrow(/Int16 occupancy slot/)
    // Vacuity: the same map one house smaller must be accepted, or this test
    // would pass against an assertion that rejects every map.
    const ok = parseMap('just-fits', allLandRows(4, 4), 10, maxHouses - 1, 4, 5)
    expect(() => createState('no-overflow', ok)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. The tick-0 ruling — idle cars stack legally at their house
// ---------------------------------------------------------------------------

describe('the tick-0 ruling: cars stack legally at their home cell (Decision 3)', () => {
  it('two idle cars share their house cell before any tick, and BOTH its slots read FREE', () => {
    const r = buildFixture('tick-zero')
    expect(r.state.header[H_TICK]).toBe(0)
    // Vacuity first: the ruling is about two cars on ONE cell, so the fixture
    // has to actually put them there. `placeHouse` creates CARS_PER_HOUSE cars.
    expect(CARS_PER_HOUSE).toBe(2)
    expect(r.state.carCell[0]).toBe(HOUSE_CELL)
    expect(r.state.carCell[1]).toBe(HOUSE_CELL)
    expect(r.state.carPhase[0]).toBe(PHASE_IDLE)
    expect(r.state.carPhase[1]).toBe(PHASE_IDLE)
    // The ruling itself: an idle car holds nothing, so the cell they share is
    // completely free. Not "one of them holds it" and not "the cell is exempt".
    expect(slotsOf(r.state, HOUSE_CELL)).toEqual([FREE, FREE])
    // And the state is consistent by both halves, vacuously for completeness —
    // which is exactly why the vacuity handle is asserted to be 0 here and
    // asserted to be non-zero on the driving fixture below.
    expect(assertOccupancyConsistent(r.state, r.world)).toBe(0)
  })

  it('a house dispatches BOTH its cars in one tick and neither claims the house cell', () => {
    const r = buildFixture('both-dispatch')
    const trace = runFixture(r, DISPATCH_TICK, 2) // two pins: both cars can reserve
    expect(trace.phaseAfterTick[DISPATCH_TICK]).toBe(PHASE_OUTBOUND)
    // Vacuity: BOTH cars must genuinely have been dispatched on this one tick,
    // or "neither claims the house cell" is satisfied by there being nothing
    // to claim it.
    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(r.state.carPhase[1]).toBe(PHASE_OUTBOUND)
    expect(r.state.carCell[0]).toBe(HOUSE_CELL)
    expect(r.state.carCell[1]).toBe(HOUSE_CELL)
    expect(r.state.carRouteCursor[0]).toBe(0)
    expect(r.state.carRouteCursor[1]).toBe(0)
    // The ruling: dispatch is not a claim. Neither car has crossed, so neither
    // holds anything, and the shared house cell is still completely free.
    expect(slotsOf(r.state, HOUSE_CELL)).toEqual([FREE, FREE])
    expect(hasCrossedThisLeg(r.state, 0)).toBe(false)
    expect(hasCrossedThisLeg(r.state, 1)).toBe(false)
  })

  it('a house cell is NOT exempt from occupancy — a car driving THROUGH one claims it like any other cell', () => {
    // The complement of the ruling above, and the more dangerous half: if house
    // cells were exempt, a player could route traffic through a permanent hole
    // in the blocking primitive, which is the "blocking silently stops working"
    // failure this milestone must not ship.
    //
    // **The main fixture cannot see this and that is worth saying**: its only
    // house cell is the car's own front door, entered by the LAST crossing of
    // the return leg and released by `completeTrip` in phase 7 of the very same
    // tick — so an end-of-tick observer never sees the claim at all. The
    // discriminator needs a house the car drives THROUGH, hence `MID_HOUSE_CELL`
    // and a second house of a DIFFERENT COLOUR (a colour-0 house at 145 would be
    // nearer to the carpark than the car's own and would win the dispatch,
    // retiring the whole timeline).
    const r = buildFixtureWithMidHouse('house-not-exempt')
    expect(r.state.header[H_HOUSE_COUNT]).toBe(2)
    // Vacuity: two IDLE cars are standing on the house cell the whole time, so
    // this also proves an idle car neither claims nor blocks the claim.
    expect(r.state.carCell[2]).toBe(MID_HOUSE_CELL)
    expect(r.state.carCell[3]).toBe(MID_HOUSE_CELL)

    const trace = runFixture(r, T_LEAVE_MID_HOUSE, 1)
    // The idle pair never moves and is never dispatched: colour 1 has no
    // destination, so its field is all-INF and nothing selects that house.
    expect(r.state.carPhase[2]).toBe(PHASE_IDLE)
    expect(r.state.carPhase[3]).toBe(PHASE_IDLE)
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)

    // Claimed, in the lane of the crossing, exactly like any other cell — and
    // by the driving car, not by either of the two idle cars sitting on it.
    expect(trace.cellAfterTick[T_ENTER_MID_HOUSE]).toBe(MID_HOUSE_CELL)
    expect(trace.slotsAfterTick[T_ENTER_MID_HOUSE]!.get(MID_HOUSE_CELL)).toEqual([0, FREE])
    // And released on the tick it leaves, exactly like any other cell.
    expect(trace.cellAfterTick[T_LEAVE_MID_HOUSE]).toBe(146)
    expect(trace.slotsAfterTick[T_LEAVE_MID_HOUSE]!.get(MID_HOUSE_CELL)).toEqual([FREE, FREE])
  })

  it('every cell the car crosses into is claimed at some point — no cell of the route is exempt', () => {
    const r = buildFixture('every-cell-claimed')
    const trace = runFixture(r, T_TRIP_END, 1)
    const everClaimed = new Set<number>()
    for (let tick = 1; tick <= T_TRIP_END; tick++) {
      for (const [cell, pair] of trace.slotsAfterTick[tick]!) {
        if (pair[0] === 0 || pair[1] === 0) everClaimed.add(cell)
      }
    }
    expect(everClaimed.has(CARPARK_CELL)).toBe(true)
    // Ten of the eleven watched cells. The house cell is the exception and it
    // is NOT an exemption: its claim is made and released inside one tick (see
    // the trip-end test), so an end-of-tick observer cannot see it. Stated as
    // an exact count with the one absentee named, rather than as `>= 10`.
    expect(everClaimed.has(HOUSE_CELL)).toBe(false)
    expect(everClaimed.size).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// 4. Claim and release across a real trip
// ---------------------------------------------------------------------------

describe('claim and release over the L fixture (lifecycle events 2, 3, 4)', () => {
  it('the fixture turns, and the two lanes it touches DIFFER — the vacuity check the release mutation needs', () => {
    // Without this, "release the lane derived from the outgoing direction" is
    // an equivalent mutant and every assertion below is satisfied by the wrong
    // rule. Asserted against the table, not against the run.
    expect(LANE_OF_DIR[DIR_E]).toBe(0)
    expect(LANE_OF_DIR[DIR_N]).toBe(1)
    expect(LANE_OF_DIR[DIR_E]).not.toBe(LANE_OF_DIR[DIR_N])
    expect(LANE_OF_DIR[DIR_S]).toBe(0)
    expect(LANE_OF_DIR[DIR_W]).toBe(1)
    expect(LANE_OF_DIR[DIR_S]).not.toBe(LANE_OF_DIR[DIR_W])
    // And the turn is a real 90 degrees on the lattice, not a 45: E -> N is a
    // difference of 2 direction indices, i.e. 45 x min(|2|, 8-|2|) = 90.
    expect(45 * Math.min(2, 6)).toBe(90)
    // The geometry the route depends on, from DX/DY rather than from prose.
    expect(CORNER_CELL + (DY[DIR_N] as number) * W + (DX[DIR_N] as number)).toBe(128)
    expect(HOUSE_CELL + (DX[DIR_E] as number)).toBe(143)
  })

  it('commits the forced 10-step route: six E then four N', () => {
    const r = buildFixture('route-shape')
    runFixture(r, DISPATCH_TICK, 1)
    expect(r.state.carRouteLen[0]).toBe(ROUTE_LEN)
    expect(r.state.carTargetDest[0]).toBe(0)
    // Only car 0 dispatches on one pin; car 1 stays idle for the whole run,
    // which is what keeps the completeness half free of the Task-2-only
    // same-lane displacement exception.
    expect(r.state.carPhase[1]).toBe(PHASE_IDLE)
  })

  it('claims the slot for the direction of the crossing, and leaves the OPPOSITE lane of that cell FREE', () => {
    const r = buildFixture('claim-lane')
    const trace = runFixture(r, T_ENTER_CORNER_OUTBOUND, 1)
    expect(trace.cellAfterTick[T_ENTER_CORNER_OUTBOUND]).toBe(CORNER_CELL)
    // Entered heading E, so lane 0 names the car and lane 1 — the lane a
    // westbound car would use — is untouched. "Check the opposite lane" and
    // "claim both lanes" are both caught here.
    expect(slotsOf(r.state, CORNER_CELL)).toEqual([0, FREE])
    expect(occupantOf(r.state, CORNER_CELL, LANE_OF_DIR[DIR_E] as number)).toBe(0)
    expect(occupantOf(r.state, CORNER_CELL, LANE_OF_DIR[OPPOSITE[DIR_E] as number] as number)).toBe(FREE)
  })

  it('releases the lane it ENTERED by, not the lane it leaves by, at the outbound turn', () => {
    // The corruption case, and every turn is an instance. The car entered 148
    // heading E (lane 0) and leaves heading N (lane 1). Under "release the
    // outgoing lane" the release clears lane 1 — which is already FREE — and
    // leaves lane 0 naming a car that is standing on 128: a cell that silently
    // stops blocking for the rest of the run.
    const r = buildFixture('release-entered-lane')
    const before = runFixture(r, T_LEAVE_CORNER_OUTBOUND - 1, 1)
    expect(before.cellAfterTick[T_LEAVE_CORNER_OUTBOUND - 1]).toBe(CORNER_CELL)
    expect(slotsOf(r.state, CORNER_CELL)).toEqual([0, FREE])

    step(r.state, r.world, r.fields, r.scratch, NO_ACTIONS)
    expect(r.state.header[H_TICK]).toBe(T_LEAVE_CORNER_OUTBOUND)
    expect(r.state.carCell[0]).toBe(128)
    // Both slots of the vacated cell, asserted together: lane 0 was released
    // and lane 1 was never claimed.
    expect(slotsOf(r.state, CORNER_CELL)).toEqual([FREE, FREE])
    // And the newly entered cell holds the N lane, not the E lane.
    expect(slotsOf(r.state, 128)).toEqual([FREE, 0])
    assertOccupancyConsistent(r.state, r.world)
  })

  it('releases the lane it ENTERED by at the RETURN turn too, where the lanes are the other way round', () => {
    // The mirror instance: entering 148 southbound is lane 0 and leaving
    // westbound is lane 1, so the same mutation corrupts the same cell on the
    // way home. Tested separately because the outbound case alone leaves the
    // return-leg direction arithmetic (`OPPOSITE[routeStep(...)]`) unexercised
    // against the lane table.
    const r = buildFixture('release-entered-lane-return')
    const before = runFixture(r, T_LEAVE_CORNER_RETURN - 1, 1)
    expect(before.cellAfterTick[T_ENTER_CORNER_RETURN]).toBe(CORNER_CELL)
    expect(before.cellAfterTick[T_LEAVE_CORNER_RETURN - 1]).toBe(CORNER_CELL)
    expect(before.phaseAfterTick[T_LEAVE_CORNER_RETURN - 1]).toBe(PHASE_RETURNING)
    expect(slotsOf(r.state, CORNER_CELL)).toEqual([0, FREE]) // entered by S = lane 0

    step(r.state, r.world, r.fields, r.scratch, NO_ACTIONS)
    expect(r.state.header[H_TICK]).toBe(T_LEAVE_CORNER_RETURN)
    expect(r.state.carCell[0]).toBe(147)
    expect(slotsOf(r.state, CORNER_CELL)).toEqual([FREE, FREE])
    expect(slotsOf(r.state, 147)).toEqual([FREE, 0]) // entered by W = lane 1
  })

  it('releases on exactly the tick the car leaves — not a tick early and not a tick late', () => {
    // Asserted as a three-tick window around the hand-computed departure, so
    // "release one tick early" and "release one tick late" are separately
    // falsified rather than jointly implied by a single snapshot.
    const r = buildFixture('release-timing')
    const trace = runFixture(r, T_LEAVE_CORNER_OUTBOUND + 1, 1)
    const at = (t: number) => trace.slotsAfterTick[t]!.get(CORNER_CELL)!
    expect(trace.cellAfterTick[T_LEAVE_CORNER_OUTBOUND - 1]).toBe(CORNER_CELL)
    expect(at(T_LEAVE_CORNER_OUTBOUND - 1)).toEqual([0, FREE]) // still held
    expect(trace.cellAfterTick[T_LEAVE_CORNER_OUTBOUND]).toBe(128)
    expect(at(T_LEAVE_CORNER_OUTBOUND)).toEqual([FREE, FREE]) // released, same tick
    expect(at(T_LEAVE_CORNER_OUTBOUND + 1)).toEqual([FREE, FREE]) // and stays released
    // The same for the claim on the entered cell: nothing before, held on the
    // tick of the crossing.
    expect(trace.slotsAfterTick[T_LEAVE_CORNER_OUTBOUND - 1]!.get(128)).toEqual([FREE, FREE])
    expect(trace.slotsAfterTick[T_LEAVE_CORNER_OUTBOUND]!.get(128)).toEqual([FREE, 0])
  })

  it('holds exactly one slot at every tick of the whole trip, and it is always the cell it stands on', () => {
    // The whole-run form of soundness plus completeness, enumerated rather than
    // sampled: at every one of the 153 ticks, the number of slots naming car 0
    // is 1 while it is in flight and 0 before dispatch and after trip end.
    const r = buildFixture('one-slot-always')
    const trace = runFixture(r, T_TRIP_END, 1)
    let ticksHoldingOne = 0
    for (let tick = 1; tick <= T_TRIP_END; tick++) {
      const snap = trace.slotsAfterTick[tick]!
      let held = 0
      let heldCell = -1
      for (const [cell, pair] of snap) {
        for (let lane = 0; lane < LANE_COUNT; lane++) {
          if (pair[lane] === 0) {
            held++
            heldCell = cell
          }
        }
      }
      expect(held, `tick ${tick}: car 0 holds ${held} slots`).toBeLessThanOrEqual(1)
      if (held === 1) {
        ticksHoldingOne++
        expect(heldCell, `tick ${tick}`).toBe(trace.cellAfterTick[tick])
      }
    }
    // Vacuity: the car must genuinely have held a slot for most of the run.
    // It holds nothing on ticks 1..8 (dispatched but not yet crossed) and
    // nothing after trip end, so 144 of 153 is the hand-derived figure:
    // ticks 9..152 inclusive.
    expect(ticksHoldingOne).toBe(144)
    expect(trace.crossingTicks).toEqual([
      9, 17, 24, 32, 39, 47, 55, 62, 70, 77, 85, 92, 100, 108, 115, 123, 130, 138, 145, 153,
    ])
  })

  it('arriveAtDestination is NOT a release site: the flipped car keeps its carpark claim', () => {
    // Lifecycle event 5's "nothing else claims" has a mirror — nothing else
    // RELEASES. The car does not move at the flip, so releasing here would free
    // a slot with a car standing on it.
    const r = buildFixture('flip-keeps-claim')
    const trace = runFixture(r, T_ARRIVE_CARPARK + 1, 1)
    expect(trace.phaseAfterTick[T_ARRIVE_CARPARK - 1]).toBe(PHASE_OUTBOUND)
    expect(trace.phaseAfterTick[T_ARRIVE_CARPARK]).toBe(PHASE_RETURNING)
    expect(trace.cellAfterTick[T_ARRIVE_CARPARK]).toBe(CARPARK_CELL)
    // Entered heading N, so lane 1, and it is still lane 1 after the flip.
    expect(trace.slotsAfterTick[T_ARRIVE_CARPARK]!.get(CARPARK_CELL)).toEqual([FREE, 0])
    expect(trace.slotsAfterTick[T_ARRIVE_CARPARK + 1]!.get(CARPARK_CELL)).toEqual([FREE, 0])
    // It is excluded from the completeness half at the flip tick (it has
    // crossed zero times on the return leg) and still covered by soundness,
    // which is the asymmetry `hasCrossedThisLeg` documents.
    expect(hasCrossedThisLeg(r.state, 0)).toBe(false)
    assertOccupancySound(r.state, r.world)
  })

  it('completeTrip releases the house cell on the SAME tick, asserted as both slots reading FREE', () => {
    // The most common trip in the game. Without this release the car holds its
    // own front door forever. Asserted directly on the slots — NOT as "the
    // sibling can then enter", which is unobservable in Task 2 because nothing
    // refuses anything yet; the sibling's freedom is Task 3's bullet.
    const r = buildFixture('complete-trip-release')
    const trace = runFixture(r, T_TRIP_END, 1)
    // The tick before: the car is one cell short, holding 143.
    expect(trace.cellAfterTick[T_TRIP_END - 1]).toBe(143)
    expect(trace.phaseAfterTick[T_TRIP_END - 1]).toBe(PHASE_RETURNING)
    expect(trace.slotsAfterTick[T_TRIP_END - 1]!.get(HOUSE_CELL)).toEqual([FREE, FREE])
    // On the trip-end tick the LAST crossing enters the house cell in phase 6
    // and `completeTrip` releases it in phase 7 — claim and release inside one
    // tick, which is the strongest form this assertion can take.
    expect(trace.phaseAfterTick[T_TRIP_END]).toBe(PHASE_IDLE)
    expect(r.state.header[H_SCORE]).toBe(1)
    expect(trace.slotsAfterTick[T_TRIP_END]!.get(HOUSE_CELL)).toEqual([FREE, FREE])
    // And 143, the cell it left on that same tick, is free too.
    expect(trace.slotsAfterTick[T_TRIP_END]!.get(143)).toEqual([FREE, FREE])
    // The whole board, not just the watched cells: no slot names car 0.
    for (let slot = 0; slot < r.state.occupancy.length; slot++) {
      expect(r.state.occupancy[slot], `slot ${slot} still names car 0`).not.toBe(0)
    }
  })

  it('completeTrip releases the cell the car is STANDING on, not the house cell — which only differ off the manifold', () => {
    // Mutation M12 in the task report: moving the release BELOW the `carCell`
    // repair write scored **0 detectors** across the whole suite, because on
    // the reachable manifold the retrace provably ends on the cell the route
    // started from, so the two cells are the same and the two orderings are
    // the same write. That is a real equivalence *on the manifold* — and the
    // ordering exists precisely for the case where the manifold has been left,
    // which is the same case the `carCell` write itself exists to repair
    // (`trips.ts` says so in as many words). So the detector is constructible;
    // it just has to be built off the manifold, exactly like
    // `assertSingleCrossing`'s and `stepCell`'s direct tests.
    //
    // Hand-built: a RETURNING car with an exhausted cursor, standing on a cell
    // that is NOT its house, holding that cell's slot.
    const r = buildFixture('complete-trip-off-manifold')
    const STRANDED = 108
    r.state.carPhase[0] = PHASE_RETURNING
    r.state.carRouteLen[0] = 4
    r.state.carRouteCursor[0] = 0
    r.state.carCell[0] = STRANDED
    claimCell(r.state, 0, STRANDED, DIR_N)
    // Vacuity: the two candidate cells must genuinely differ, or this fixture
    // reproduces the manifold and the mutation stays equivalent.
    expect(STRANDED).not.toBe(HOUSE_CELL)
    expect(r.state.houseCell[r.state.carHome[0] as number]).toBe(HOUSE_CELL)
    expect(slotsOf(r.state, STRANDED)).toEqual([FREE, 0])

    runArrivals(r.state)

    expect(r.state.carPhase[0]).toBe(PHASE_IDLE)
    expect(r.state.carCell[0]).toBe(HOUSE_CELL) // the repair write still happens
    // The cell it was standing on is released. Releasing the house cell instead
    // would be a no-op here and would strand a claim naming an idle car.
    expect(slotsOf(r.state, STRANDED)).toEqual([FREE, FREE])
    expect(slotsOf(r.state, HOUSE_CELL)).toEqual([FREE, FREE])
  })

  it('...and the same edit is caught a second, independent way: soundness', () => {
    // **This is a separate `it()` on purpose, and the reason is arithmetic
    // rather than style.** It used to sit at the bottom of the test above,
    // below the slot assertion — where, under the mutation it claims to catch,
    // the slot assertion throws first and this line never executes. It
    // contributed 0 detectors while its comment called it a second independent
    // detector: true of the mechanism, false of the count. Split out, it is
    // genuinely independent and the mutation scores 2.
    const r = buildFixture('complete-trip-off-manifold-soundness')
    const STRANDED = 108
    r.state.carPhase[0] = PHASE_RETURNING
    r.state.carRouteLen[0] = 4
    r.state.carRouteCursor[0] = 0
    r.state.carCell[0] = STRANDED
    claimCell(r.state, 0, STRANDED, DIR_N)
    expect(STRANDED).not.toBe(HOUSE_CELL)

    runArrivals(r.state)

    // A slot naming a PHASE_IDLE car is a soundness violation by definition, so
    // releasing the wrong cell here is caught without reading any slot value.
    expect(r.state.carPhase[0]).toBe(PHASE_IDLE)
    expect(() => assertOccupancySound(r.state, r.world)).not.toThrow()
  })

  it('the whole board is back to FREE after the trip, byte-identical to a fresh fill', () => {
    // The other half of the trip-end obligation: nothing is left behind
    // ANYWHERE, so the region is exactly its creation-time value again.
    const r = buildFixture('board-restored')
    runFixture(r, T_TRIP_END, 1)
    const fresh = makeRig('board-restored', 'x')
    expect(r.state.occupancy).toEqual(fresh.state.occupancy)
  })

  it('assertOccupancyConsistent holds at every tick of the run, and its completeness half is NOT vacuous', () => {
    const r = buildFixture('consistent-every-tick')
    const trace = runFixture(r, RUN_TICKS, 1)
    // `runFixture` already asserts both halves after every tick; this pins the
    // vacuity handle. Exactly one car is ever in flight, so the peak is 1 —
    // stated as an exact figure rather than `> 0`, because `> 0` is satisfied
    // by a single tick and the point is that the half had something to range
    // over across the flight.
    expect(trace.maxCompletenessChecked).toBe(1)
    // And the run genuinely completed a trip rather than stalling.
    expect(r.state.header[H_SCORE]).toBe(1)
    expect(r.state.carPhase[0]).toBe(PHASE_IDLE)
    // Task 2 adds no refusal, so nothing ever blocks: `carBlockedTicks` is
    // identically 0, which is also what keeps the completeness half free of
    // the valve exception.
    for (let tick = 1; tick <= RUN_TICKS; tick++) {
      expect(trace.blockedAfterTick[tick], `tick ${tick}`).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. The first crossing out of a shared house — Task 2's displacement, rewritten
// ---------------------------------------------------------------------------

/**
 * **This block replaces Task 2's `the Task-2-only same-lane displacement`, and
 * the swap is deliberate rather than incidental.** That test pinned a state
 * that Task 2 could reach and Task 3 cannot: with no refusals, two cars could
 * cross into one `(cell, lane)` on one tick and the later writer displaced the
 * earlier one's claim, leaving the array sound but not complete. `canEnter` now
 * refuses the second entry outright, so the displacement is unreachable through
 * the ordinary path and `assertOccupancyComplete`'s Task-2-only exception arm
 * is retired with it.
 *
 * It was also the **only** detector for `runMovement`'s iteration order (Task
 * 2's mutation M13, 1 detector). The replacement keeps that job and does it
 * much harder: under ascending order car 0 is granted and car 1 refused, under
 * descending order the reverse — so the surviving occupant, the refused car's
 * identity and every arrival tick downstream all move.
 */
describe('two cars dispatched from one house in one tick queue at the FIRST crossing', () => {
  it('grants the lower index, refuses the higher by REFUSED_OCCUPIED, and the loser is unmoved', () => {
    // Decision 3's tick-0 ruling says a house's front door does NOT queue: both
    // cars leave with no claim, and it is the FIRST CROSSING that separates
    // them, one cell later than a naive reading.
    const r = buildFixture('first-crossing-queue')
    const trace = runFixture(r, DISPATCH_TICK, 2)
    expect(trace.phaseAfterTick[DISPATCH_TICK]).toBe(PHASE_OUTBOUND)
    expect(r.state.carPhase[1]).toBe(PHASE_OUTBOUND)
    // Vacuity: both cars are genuinely dispatched, on one tick, from one cell,
    // onto the same forced route — so nothing but the refusal can separate them.
    expect(r.state.carCell[0]).toBe(HOUSE_CELL)
    expect(r.state.carCell[1]).toBe(HOUSE_CELL)
    expect(r.state.carRouteLen[0]).toBe(ROUTE_LEN)
    expect(r.state.carRouteLen[1]).toBe(ROUTE_LEN)
    expect(slotsOf(r.state, HOUSE_CELL)).toEqual([FREE, FREE])

    // Tick 8: one tick short of the first crossing. Both cars have identical
    // progress and the target lane is free, so the refusal has not happened yet
    // and `canEnter` says so for BOTH of them — the negative control that stops
    // this test passing against a `canEnter` that refuses everything.
    for (let tick = DISPATCH_TICK + 1; tick <= T_QUIET_CROSSING - 1; tick++) {
      step(r.state, r.world, r.fields, r.scratch, NO_ACTIONS)
    }
    expect(r.state.header[H_TICK]).toBe(T_QUIET_CROSSING - 1)
    expect(r.state.carProgress[0]).toBe(SPEED * 7)
    expect(r.state.carProgress[1]).toBe(SPEED * 7)
    expect(canEnter(r.state, r.world, 0, 143, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
    expect(canEnter(r.state, r.world, 1, 143, DIR_E)).toBe(EnterOutcome.ENTER_FREE)

    // Tick 9: the first crossing. Ascending index — car 0 is granted, claims
    // (143, lane 0), and car 1 meets an occupied slot.
    step(r.state, r.world, r.fields, r.scratch, NO_ACTIONS)
    expect(r.state.header[H_TICK]).toBe(T_QUIET_CROSSING)
    expect(r.state.carCell[0]).toBe(143)
    expect(slotsOf(r.state, 143)).toEqual([0, FREE])
    // The loser is UNMOVED, and every byte of it says so: same cell, same
    // cursor, and progress bit-identical to its value one tick earlier.
    expect(r.state.carCell[1]).toBe(HOUSE_CELL)
    expect(r.state.carRouteCursor[1]).toBe(0)
    expect(r.state.carProgress[1]).toBe(SPEED * 7)
    // And the refusal NAMES ITS REASON. This is the assertion the whole outcome
    // enum exists for: "car 1 did not move" is also satisfied by an idle phase,
    // an exhausted route and a sub-threshold tick, and this line is satisfied
    // by none of them.
    expect(canEnter(r.state, r.world, 1, 143, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(occupantOf(r.state, 143, LANE_OF_DIR[DIR_E] as number)).toBe(0)
    // Task 3 writes nothing to `carBlockedTicks`; Task 4 owns its semantics.
    expect(r.state.carBlockedTicks[1]).toBe(0)
    // The array is now sound AND complete — the Task-2-only displacement arm
    // this block replaces cannot arise any more.
    expect(assertOccupancyConsistent(r.state, r.world)).toBe(1)
  })

  it('the queue then clears on the tick the leader vacates, one cell, with the carry intact', () => {
    // The other half: a refusal is a WAIT, not a loss. Car 1 crosses on the
    // first tick it is granted and arrives carrying exactly the residual car 0
    // carried, so from here it is car 0's trip shifted by a whole 8 ticks.
    const r = buildFixture('first-crossing-clears')
    runFixture(r, 17, 2)
    expect(r.state.header[H_TICK]).toBe(17)
    // Car 0 has moved on to 144; car 1 has taken the cell it vacated, this tick.
    expect(r.state.carCell[0]).toBe(144)
    expect(r.state.carCell[1]).toBe(143)
    expect(slotsOf(r.state, 144)).toEqual([0, FREE])
    expect(slotsOf(r.state, 143)).toEqual([1, FREE])
    // ONE cell, not two: the held progress was 2,310, so the crossing consumes
    // 2,310 + 330 = 2,640 and leaves 140 — the same carry car 0 left tick 9
    // with. An accumulating implementation would be at 2,310 + 8 x 330 = 4,950
    // here and would cross again on the very next tick.
    expect(r.state.carProgress[1]).toBe(SPEED * 8 - ORTHO_THRESHOLD)
    expect(r.state.carProgress[1]).toBe(140)
    expect(r.state.carRouteCursor[1]).toBe(1)
    expect(assertOccupancyConsistent(r.state, r.world)).toBe(2)
  })

  it('carries the whole trip through: BOTH cars score, the second exactly 8 ticks behind the first', () => {
    // The emergent end-to-end consequence, and the fixture that makes the
    // `completeTrip` release observable the way Task 2's direct slot assertion
    // could not be (C6's modal failure: without it the sibling stalls the full
    // valve on every return leg — and in Task 3 there is no valve yet, so it
    // stalls FOREVER and the score never reaches 2).
    //
    // Hand-computed. Car 0 is the single-car timeline from this file's module
    // comment. Car 1 is refused at tick 9, crosses at 17 carrying 140 — car 0's
    // tick-9 carry exactly — and is therefore car 0's whole trip plus 8:
    //
    //   car 0  out 143@9 ... 68@77 (arrive)   return 88@85 ... 142@153 (score)
    //   car 1  out 143@17 ... 68@85 (arrive)  return 88@93 ... 142@161 (score)
    //
    // The two legs interleave on the shared corridor and never conflict,
    // because at every meeting the pair is exactly one cell and 8 ticks apart
    // and ascending order processes the LEAVING car first.
    const r = buildFixture('both-cars-score')
    const trace = runFixture(r, T_SIBLING_TRIP_END, 2)
    expect(r.state.header[H_SCORE]).toBe(2)
    expect(trace.crossingTicks).toEqual([
      // car 0's crossings only — `Trace` follows car 0. Identical to the
      // single-car run, which is the point: the queue costs car 0 nothing.
      9, 17, 24, 32, 39, 47, 55, 62, 70, 77, 85, 92, 100, 108, 115, 123, 130, 138, 145, 153,
    ])
    expect(trace.phaseAfterTick[T_TRIP_END]).toBe(PHASE_IDLE)
    expect(trace.phaseAfterTick[T_SIBLING_TRIP_END - 1]).toBe(PHASE_IDLE)
    // Car 1 finishes 8 ticks later, on the tick derived above and nowhere else.
    expect(r.state.carPhase[1]).toBe(PHASE_IDLE)
    expect(r.state.carCell[1]).toBe(HOUSE_CELL)
    // The board is completely clear again — both front doors released.
    expect(slotsOf(r.state, HOUSE_CELL)).toEqual([FREE, FREE])
    for (let slot = 0; slot < r.state.occupancy.length; slot++) {
      expect(r.state.occupancy[slot], `slot ${slot}`).toBe(FREE)
    }
    // Nothing was ever refused after the first crossing — the sibling's return
    // leg in particular. `H_SCORE` reaching 2 is the direct observer, and this
    // is the same fact stated as a count so a partial stall cannot hide in it.
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
  })

  it('the sibling ENTERS the front door its sibling freed, with ENTER_FREE, on the tick it needs it', () => {
    // The observer Task 2's direct slot assertion could not have, stated as an
    // outcome code rather than as "it moved". Car 0's trip ends on tick 153 and
    // `completeTrip` releases cell 142 in phase 7 of that tick; car 1's last
    // crossing needs (142, lane 1) on tick 161.
    const r = buildFixture('sibling-front-door')
    runFixture(r, T_SIBLING_TRIP_END - 1, 2)
    expect(r.state.header[H_TICK]).toBe(T_SIBLING_TRIP_END - 1)
    // Vacuity, both sides of the guard: car 0 is home and idle, car 1 is one
    // cell short of home and still returning. Without both, "the door is free"
    // is a statement about a board where nobody wants it.
    expect(r.state.carPhase[0]).toBe(PHASE_IDLE)
    expect(r.state.carCell[0]).toBe(HOUSE_CELL)
    expect(r.state.carPhase[1]).toBe(PHASE_RETURNING)
    expect(r.state.carCell[1]).toBe(143)
    expect(r.state.header[H_SCORE]).toBe(1)
    // The front door, asked directly, in the lane car 1 will enter by.
    expect(LANE_OF_DIR[DIR_W]).toBe(1)
    expect(canEnter(r.state, r.world, 1, HOUSE_CELL, DIR_W)).toBe(EnterOutcome.ENTER_FREE)

    step(r.state, r.world, r.fields, r.scratch, NO_ACTIONS)
    expect(r.state.header[H_TICK]).toBe(T_SIBLING_TRIP_END)
    expect(r.state.header[H_SCORE]).toBe(2)
    expect(r.state.carPhase[1]).toBe(PHASE_IDLE)
  })
})

// ---------------------------------------------------------------------------
// 6. The consistency assertion's own failure modes
// ---------------------------------------------------------------------------

describe('assertOccupancySound / assertOccupancyComplete fire on hand-built corruption', () => {
  function inFlightRig(seed: string): Rig {
    const r = buildFixture(seed)
    runFixture(r, T_ENTER_CORNER_OUTBOUND, 1)
    expect(r.state.carCell[0]).toBe(CORNER_CELL)
    expect(slotsOf(r.state, CORNER_CELL)).toEqual([0, FREE])
    return r
  }

  it('soundness fires when a slot names a car that has gone PHASE_IDLE — the second detector for the completeTrip release', () => {
    // Independent of the direct slot assertion in the trip-end test: a slot
    // naming an idle car is a soundness violation BY DEFINITION, so "skip the
    // release in completeTrip" is caught twice, by two different mechanisms.
    const r = inFlightRig('sound-idle')
    r.state.carPhase[0] = PHASE_IDLE
    expect(() => assertOccupancySound(r.state, r.world)).toThrow(/whose phase is/)
  })

  it('soundness fires when a slot names a car standing somewhere else', () => {
    const r = inFlightRig('sound-elsewhere')
    r.state.carCell[0] = 108
    expect(() => assertOccupancySound(r.state, r.world)).toThrow(/is standing on cell 108/)
  })

  it('soundness fires on a slot naming a value that is neither FREE nor a car index', () => {
    const r = inFlightRig('sound-garbage')
    r.state.occupancy[occupancySlot(108, 1)] = 9999
    expect(() => assertOccupancySound(r.state, r.world)).toThrow(/is not a car index/)
    const r2 = inFlightRig('sound-garbage-neg')
    r2.state.occupancy[occupancySlot(108, 1)] = -2
    expect(() => assertOccupancySound(r2.state, r2.world)).toThrow(/is not a car index/)
  })

  it('soundness fires for a PHASE_NONE car, not only an idle one', () => {
    const r = inFlightRig('sound-none')
    r.state.carPhase[0] = PHASE_NONE
    expect(() => assertOccupancySound(r.state, r.world)).toThrow(/whose phase is/)
  })

  it('completeness fires when an in-flight car that has crossed is named by neither slot', () => {
    const r = inFlightRig('complete-missing')
    // Vacuity: the car must genuinely have crossed, or the assertion ranges
    // over an empty set and passes for the wrong reason.
    expect(hasCrossedThisLeg(r.state, 0)).toBe(true)
    expect(assertOccupancyComplete(r.state, r.world)).toBe(1)
    r.state.occupancy[occupancySlot(CORNER_CELL, 0)] = FREE
    expect(() => assertOccupancyComplete(r.state, r.world)).toThrow(/a claim went missing/)
    // And soundness is blind to it, which is why the two halves are separate.
    expect(() => assertOccupancySound(r.state, r.world)).not.toThrow()
  })

  it('assertOccupancyConsistent can skip the completeness half, and says so through its return value', () => {
    const r = inFlightRig('consistent-skip')
    expect(assertOccupancyConsistent(r.state, r.world)).toBe(1)
    expect(assertOccupancyConsistent(r.state, r.world, false)).toBe(0)
    r.state.occupancy[occupancySlot(CORNER_CELL, 0)] = FREE
    // Skipping completeness must not also skip soundness.
    expect(() => assertOccupancyConsistent(r.state, r.world, false)).not.toThrow()
    r.state.occupancy[occupancySlot(CORNER_CELL, 1)] = 0
    r.state.carCell[0] = 108
    expect(() => assertOccupancyConsistent(r.state, r.world, false)).toThrow(/assertOccupancySound/)
  })

  it('hasCrossedThisLeg is false for idle and PHASE_NONE cars, and true only after a real crossing', () => {
    const r = buildFixture('has-crossed')
    expect(hasCrossedThisLeg(r.state, 0)).toBe(false) // idle
    expect(hasCrossedThisLeg(r.state, 5)).toBe(false) // PHASE_NONE, past the live prefix
    runFixture(r, DISPATCH_TICK, 1)
    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(hasCrossedThisLeg(r.state, 0)).toBe(false) // dispatched, not yet crossed
    for (let tick = DISPATCH_TICK + 1; tick <= T_QUIET_CROSSING; tick++) {
      step(r.state, r.world, r.fields, r.scratch, NO_ACTIONS)
    }
    expect(hasCrossedThisLeg(r.state, 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. claimCell / releaseCell in isolation
// ---------------------------------------------------------------------------

describe('claimCell and releaseCell, called directly', () => {
  it('claim overwrites unconditionally, so a slot names the MOST RECENT entrant', () => {
    const r = makeRig('claim-overwrite', 'claim-overwrite')
    claimCell(r.state, 3, 50, DIR_E)
    expect(slotsOf(r.state, 50)).toEqual([3, FREE])
    claimCell(r.state, 7, 50, DIR_E)
    expect(slotsOf(r.state, 50)).toEqual([7, FREE])
    // A different direction lands in the other lane and leaves the first alone.
    claimCell(r.state, 4, 50, DIR_W)
    expect(slotsOf(r.state, 50)).toEqual([7, 4])
  })

  it('release is guarded by identity: it clears only the slots naming the releasing car', () => {
    const r = makeRig('release-guarded', 'release-guarded')
    claimCell(r.state, 7, 50, DIR_E) // lane 0
    claimCell(r.state, 4, 50, DIR_W) // lane 1
    releaseCell(r.state, 4, 50)
    expect(slotsOf(r.state, 50)).toEqual([7, FREE])
    // Releasing a car that holds nothing here is a no-op, not a wipe. This is
    // the guard: unconditional release would clear car 7's live claim.
    releaseCell(r.state, 4, 50)
    expect(slotsOf(r.state, 50)).toEqual([7, FREE])
    releaseCell(r.state, 99, 50)
    expect(slotsOf(r.state, 50)).toEqual([7, FREE])
    releaseCell(r.state, 7, 50)
    expect(slotsOf(r.state, 50)).toEqual([FREE, FREE])
  })

  it('release clears BOTH lanes when the same car holds both, and needs no direction to do it', () => {
    // Off the reachable manifold (a car cannot enter one cell twice without
    // leaving), and the reason the release takes no direction argument: it
    // cannot be wrong about which lane it claimed, because it does not ask.
    const r = makeRig('release-both', 'release-both')
    claimCell(r.state, 2, 50, DIR_E)
    claimCell(r.state, 2, 50, DIR_W)
    expect(slotsOf(r.state, 50)).toEqual([2, 2])
    releaseCell(r.state, 2, 50)
    expect(slotsOf(r.state, 50)).toEqual([FREE, FREE])
  })

  it('the self-healing trace Decision 6 describes: a guarded release on a displaced slot correctly does nothing', () => {
    // A two-cell excerpt of the four-car ring Task 4 tests, run by hand here so
    // the release rule's self-healing property has an observer BEFORE the valve
    // exists to produce it. Car 0 is displaced from cell 50 by car 1; when car
    // 0 later leaves, its guarded clear must fail, leaving car 1's claim intact.
    const r = makeRig('self-heal', 'self-heal')
    claimCell(r.state, 0, 50, DIR_E)
    claimCell(r.state, 1, 50, DIR_E) // displaces car 0
    expect(slotsOf(r.state, 50)).toEqual([1, FREE])
    releaseCell(r.state, 0, 50) // car 0 moves on: guarded clear must NOT fire
    expect(slotsOf(r.state, 50)).toEqual([1, FREE])
    // Unconditional release would have left [FREE, FREE] with car 1 standing
    // there — blocking silently stops working for the rest of the run.
  })
})

// ---------------------------------------------------------------------------
// 8. Occupancy is hashed state and survives snapshot/restore
// ---------------------------------------------------------------------------

describe('occupancy is hashed state (Decision 4: in hashState AND field-irrelevant)', () => {
  it('snapshot/restore round-trips occupancy byte for byte', () => {
    const r = buildFixture('snapshot-occupancy')
    runFixture(r, T_ENTER_CORNER_OUTBOUND, 1)
    // Vacuity: the region must be non-trivial at the moment it is captured, or
    // this round-trips an all-FREE array and proves nothing.
    const claimed = Array.from(r.state.occupancy).filter((v) => v !== FREE)
    expect(claimed).toEqual([0])

    const buf = snapshot(r.state)
    const restored = restore(buf, r.world)
    expect(restored.occupancy).toEqual(r.state.occupancy)
    expect(hashState(restored)).toBe(hashState(r.state))

    // Detached, like every other region: mutating the source afterwards must
    // not reach the copy.
    r.state.occupancy[occupancySlot(CORNER_CELL, 0)] = FREE
    expect(restored.occupancy[occupancySlot(CORNER_CELL, 0)]).toBe(0)
  })

  it('a single occupancy slot moves hashState — the region is inside the digest', () => {
    const r = buildFixture('occupancy-hashed')
    const before = hashState(r.state)
    r.state.occupancy[occupancySlot(17, 1)] = 3
    expect(hashState(r.state)).not.toBe(before)
  })

  it('carBlockedTicks is inside the digest too, so Task 4\'s counter cannot drift between engines', () => {
    const r = buildFixture('blocked-hashed')
    const before = hashState(r.state)
    r.state.carBlockedTicks[1] = 7
    expect(hashState(r.state)).not.toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 9. FIELD_IRRELEVANT, behaviourally
// ---------------------------------------------------------------------------

describe('CT_REBUILDS does not move on a tick where a car crosses but nothing routing-relevant changes', () => {
  it('a crossing tick with no road edit and no pin change costs zero field rebuilds', () => {
    // The behavioural half of Decision 4, and NEW coverage rather than a
    // restatement: `step.test.ts`'s two existing CT_REBUILDS fixtures are
    // car-free, so neither can see occupancy being classified FIELD_INPUT.
    // Classifying it FIELD_INPUT runs five whole-board Dijkstras on nearly
    // every tick forever, with byte-identical output.
    const r = buildFixture('ct-rebuilds')
    const trace = runFixture(r, CT_WINDOW_END, 1)

    // Vacuity, all four clauses of the bullet, asserted rather than assumed:
    //   (a) cars really crossed cells inside the window;
    expect(trace.cellAfterTick[T_QUIET_CROSSING - 1]).toBe(HOUSE_CELL)
    expect(trace.cellAfterTick[T_QUIET_CROSSING]).toBe(143)
    expect(trace.crossingTicks).toEqual([T_QUIET_CROSSING, 17])
    //   (b) occupancy really changed as a result;
    expect(trace.slotsAfterTick[T_QUIET_CROSSING - 1]!.get(143)).toEqual([FREE, FREE])
    expect(trace.slotsAfterTick[T_QUIET_CROSSING]!.get(143)).toEqual([0, FREE])
    expect(trace.slotsAfterTick[CT_WINDOW_END]!.get(144)).toEqual([0, FREE])
    //   (c) no road was placed or erased inside the window;
    //       (the only road actions in the script are on tick 1)
    //   (d) no pin spawned or was consumed inside the window.
    expect(r.state.destPins[0]).toBe(1)
    expect(r.state.destReserved[0]).toBe(1)

    // The assertion itself, over a window that ENDS AFTER a crossing rather
    // than on one. That is not cosmetic and it was measured: `syncFields` is
    // phase 4 and `runMovement` is phase 6, so an occupancy write made on tick
    // T is first visible to the field-input hash on tick **T+1**. A window
    // closing on the crossing tick leaves the FIELD_INPUT mutation undetected
    // — this test scored 0 against it until the window was extended, which is
    // the catalogue's "a test at the wrong operating point" exactly.
    for (let tick = 4; tick <= CT_WINDOW_END; tick++) {
      expect(trace.rebuildsAfterTick[tick], `tick ${tick}`).toBe(trace.rebuildsAfterTick[3])
    }
    // Vacuity for the counter itself: it must have moved at SOME point, or a
    // counter stuck at 0 would satisfy the loop above.
    expect(trace.rebuildsAfterTick[3]).toBeGreaterThan(0)
  })

  it('and the counter is not simply frozen: a road edit on a later tick DOES rebuild', () => {
    // The control. Without it, "CT_REBUILDS does not move" is satisfied by a
    // broken `syncFields` that never rebuilds anything.
    const r = buildFixture('ct-rebuilds-control')
    const trace = runFixture(r, CT_WINDOW_END, 1)
    const before = trace.rebuildsAfterTick[CT_WINDOW_END] as number
    step(r.state, r.world, r.fields, r.scratch, { actions: [{ kind: 'place', a: 0, b: 1 }] })
    expect(r.state.roads[0]).not.toBe(0) // the road really was placed
    expect(r.scratch.counters[CT_REBUILDS]).toBeGreaterThan(before)
  })
})

// ---------------------------------------------------------------------------
// 10. The hand-built rig — the blocking primitive without dispatch in the way
// ---------------------------------------------------------------------------

/**
 * Everything from here down drives `runMovement` (and, where the fixture needs
 * the leg flip, `runArrivals`) over cars written directly into the buffer.
 *
 * **Why hand-built rather than dispatched, stated so it can be argued with.**
 * The properties under test are about the exact tick a car is refused and the
 * exact progress it holds while it waits, and both are functions of each car's
 * carry at the moment the queue forms. Dispatch commits every car with
 * `carProgress = 0` on the tick it fires, so a dispatched fixture can only ever
 * produce cars whose carries are locked together — which is precisely the case
 * in which "each car is refused on its own tick" cannot be observed at all
 * (section 5's pair is that case, and it is tested there, through the real
 * tick). Choosing the carries is the only way to build a queue whose four cars
 * join it on four DIFFERENT ticks.
 *
 * The routes are real: `packRouteStep` is dispatch's own writer, and the cars
 * are indistinguishable from cars that drove to these cells — which is asserted
 * rather than claimed, by `assertOccupancyConsistent` (both halves) after every
 * tick of every run below.
 *
 * No house, no destination and no road is placed for these fixtures, and none
 * is needed: movement reads the committed route and never `state.roads`.
 */

/** Row 5 of the 20 x 12 board is cells 100..119; `cell = y * 20 + x`. */
const ROW5_X0 = 100

interface HandCarSpec {
  readonly i: number
  readonly cell: number
  readonly progress: number
  /** The direction every step of the route points. */
  readonly step: number
  /** The lane-defining direction this car ENTERED its current cell by. */
  readonly enteredBy: number
  readonly phase?: number
  readonly routeLen?: number
  readonly cursor?: number
}

const HAND_ROUTE_LEN = 12

/**
 * Writes one car slot by hand and claims the cell it is standing on, so the
 * result is byte-indistinguishable from a car that drove there.
 *
 * `cursor` defaults to 1 rather than 0 on purpose: a cursor of 0 means "has not
 * crossed on this leg", which excludes the car from `assertOccupancyComplete`
 * and would make every completeness assertion below range over an empty set.
 */
function handCar(r: Rig, spec: HandCarSpec): void {
  const routeLen = spec.routeLen ?? HAND_ROUTE_LEN
  r.state.carPhase[spec.i] = spec.phase ?? PHASE_OUTBOUND
  r.state.carCell[spec.i] = spec.cell
  r.state.carProgress[spec.i] = spec.progress
  r.state.carRouteLen[spec.i] = routeLen
  r.state.carRouteCursor[spec.i] = spec.cursor ?? 1
  for (let k = 0; k < routeLen; k++) packRouteStep(r.state, spec.i, k, spec.step)
  claimCell(r.state, spec.i, spec.cell, spec.enteredBy)
}

/** One watched car and the direction it is travelling in. */
interface Watch {
  readonly i: number
  readonly dir: number
}

interface HandTrace {
  /** `[tick][k]` for the k-th watched car. Index 0 of each row is unused. */
  readonly cell: number[][]
  readonly progress: number[][]
  /**
   * `canEnter`'s answer for each watched car, taken immediately BEFORE the tick
   * runs. Valid as a record of what `advanceCar` saw only on ticks where
   * nothing moved — which every assertion below establishes from `cell` first.
   */
  readonly probe: EnterOutcomeCode[][]
  /**
   * `[lane0, lane1]` of each watched CELL at the end of each tick.
   *
   * Recorded rather than read back off `r.state` after the run, and that is not
   * a convenience: an earlier draft of the co-location test asserted
   * `slotsOf(state, cell)` inside a per-tick loop that ran AFTER the drive, so
   * every one of its seven assertions was reading the same final state. It
   * failed loudly here, but the same shape passes silently whenever the final
   * state happens to match.
   */
  readonly slots: Map<number, [number, number]>[]
  /** `[destPins[0], destReserved[0], count(PHASE_OUTBOUND)]` at the end of each tick. */
  readonly reservations: [number, number, number][]
  maxCompletenessChecked: number
}

/**
 * Drives `runMovement` (plus `runArrivals` when asked) for `ticks` ticks,
 * asserting BOTH halves of `assertOccupancyConsistent` after every one.
 *
 * Tick numbering starts at 1 and is the loop index, not `H_TICK`: nothing here
 * runs `step`, so the clock never advances. Said out loud because every number
 * in this half of the file is a tick count rather than an absolute tick.
 */
function driveHand(
  r: Rig,
  watch: readonly Watch[],
  ticks: number,
  options: { readonly arrivals?: boolean; readonly cells?: readonly number[] } = {},
): HandTrace {
  const cells = options.cells ?? []
  const trace: HandTrace = {
    cell: [],
    progress: [],
    probe: [],
    slots: [],
    reservations: [],
    maxCompletenessChecked: 0,
  }
  for (let tick = 1; tick <= ticks; tick++) {
    const probes: EnterOutcomeCode[] = []
    for (const w of watch) {
      const next = stepCell(r.state.carCell[w.i] as number, w.dir, r.world.w, r.world.h)
      probes.push(canEnter(r.state, r.world, w.i, next, w.dir))
    }
    trace.probe[tick] = probes

    runMovement(r.state, r.world)
    if (options.arrivals === true) runArrivals(r.state)

    trace.maxCompletenessChecked = Math.max(
      trace.maxCompletenessChecked,
      assertOccupancyConsistent(r.state, r.world),
    )
    trace.cell[tick] = watch.map((w) => r.state.carCell[w.i] as number)
    trace.progress[tick] = watch.map((w) => r.state.carProgress[w.i] as number)
    const snap = new Map<number, [number, number]>()
    for (const c of cells) snap.set(c, slotsOf(r.state, c))
    trace.slots[tick] = snap
    let outbound = 0
    for (let i = 0; i < r.state.carPhase.length; i++) {
      if (r.state.carPhase[i] === PHASE_OUTBOUND) outbound++
    }
    trace.reservations[tick] = [
      r.state.destPins[0] as number,
      r.state.destReserved[0] as number,
      outbound,
    ]
  }
  return trace
}

describe('canEnter, asked directly (Decision 8s outcome codes)', () => {
  it('answers ENTER_FREE for a free slot and REFUSED_OCCUPIED for a taken one, on the SAME cell', () => {
    // The two codes Task 3 can produce, on one cell, differing only in whether
    // the lane is held — so nothing about the cell, the direction or the car
    // can be what separates them.
    const r = makeRig('can-enter-basic', 'can-enter-basic')
    expect(canEnter(r.state, r.world, 3, 150, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
    claimCell(r.state, 7, 150, DIR_E)
    expect(canEnter(r.state, r.world, 3, 150, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    releaseCell(r.state, 7, 150)
    expect(canEnter(r.state, r.world, 3, 150, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('reads the lane of the DIRECTION, so the opposite lane of an occupied cell is still free', () => {
    // Decision 1's structural claim, asked of `canEnter` itself rather than
    // inferred from a run. This is the assertion that kills "check the opposite
    // lane": under that mutation the two expectations below swap.
    const r = makeRig('can-enter-lane', 'can-enter-lane')
    claimCell(r.state, 2, 150, DIR_E) // lane 0
    expect(LANE_OF_DIR[DIR_E]).toBe(0)
    expect(LANE_OF_DIR[DIR_W]).toBe(1)
    expect(canEnter(r.state, r.world, 5, 150, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(canEnter(r.state, r.world, 5, 150, DIR_W)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('asks about the cell being ENTERED, not the cell being left', () => {
    // "Check the lane of the current cell rather than the one being entered" is
    // a plan-named mutation, and it is invisible unless the two cells differ in
    // occupancy. Here the car's own cell is occupied (by itself) and the target
    // is free, so the two questions have opposite answers.
    const r = makeRig('can-enter-target', 'can-enter-target')
    claimCell(r.state, 4, 150, DIR_E)
    expect(canEnter(r.state, r.world, 4, 151, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
    expect(canEnter(r.state, r.world, 4, 150, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('refuses for a car OTHER than the one holding the slot, and for the holder itself', () => {
    // There is deliberately no "it is already mine" arm. On a sound array a car
    // can only hold the slot of the cell it is STANDING on, and a car never
    // enters the cell it is standing on (`stepCell` cannot return its own
    // argument), so such an arm would be unreachable code that reads as a
    // supported case.
    const r = makeRig('can-enter-self', 'can-enter-self')
    claimCell(r.state, 6, 150, DIR_E)
    expect(canEnter(r.state, r.world, 9, 150, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(canEnter(r.state, r.world, 6, 150, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('is total over all eight directions, on a cell with exactly one lane held', () => {
    // Over the whole table rather than sampled: with lane 0 held, the four
    // lane-0 directions are refused and the four lane-1 directions are free.
    // A swapped or truncated `LANE_OF_DIR` row moves one of these eight.
    const r = makeRig('can-enter-total', 'can-enter-total')
    claimCell(r.state, 1, 150, DIR_E)
    let refused = 0
    let free = 0
    for (let d = 0; d < 8; d++) {
      const outcome = canEnter(r.state, r.world, 0, 150, d)
      if (outcome === EnterOutcome.REFUSED_OCCUPIED) refused++
      else if (outcome === EnterOutcome.ENTER_FREE) free++
      expect(outcome, `dir ${d}`).toBe(
        LANE_OF_DIR[d] === 0 ? EnterOutcome.REFUSED_OCCUPIED : EnterOutcome.ENTER_FREE,
      )
    }
    expect([refused, free]).toEqual([4, 4])
  })

  it('the outcome codes are a frozen, all-non-zero enum with all four members declared now', () => {
    // Declared in full in Task 3 so that no later task WIDENS a return type a
    // caller is already switching on: `ENTER_VALVE` is Task 4's and
    // `REFUSED_GHOST` is Task 5's, and neither is reachable yet.
    expect(Object.isFrozen(EnterOutcome)).toBe(true)
    expect(EnterOutcome).toEqual({
      ENTER_FREE: 1,
      ENTER_VALVE: 2,
      REFUSED_OCCUPIED: 3,
      REFUSED_GHOST: 4,
    })
    // Non-zero in `PointerOutcome`'s idiom, so `if (outcome)` cannot read one
    // outcome as false. Asserted over the whole set rather than by inspection.
    for (const v of Object.values(EnterOutcome)) expect(v).not.toBe(0)
    expect(new Set(Object.values(EnterOutcome)).size).toBe(4)
  })

  it('throws by name for a cell that is not on the board, rather than answering "occupied"', () => {
    // The silent failure this replaces: an off-board slot read gives
    // `undefined`, `undefined === FREE` is false, and the car would sit blocked
    // forever against a slot that does not exist.
    const r = makeRig('can-enter-oob', 'can-enter-oob')
    expect(() => canEnter(r.state, r.world, 3, CELLS, DIR_E)).toThrow(/car 3 was asked whether it can enter/)
    expect(() => canEnter(r.state, r.world, 3, -1, DIR_E)).toThrow(/is not on this board/)
    // The last real cell is fine, so the bound is not off by one.
    expect(canEnter(r.state, r.world, 3, CELLS - 1, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
    // And directly, which is the only way to reach it from production code:
    // `advanceCar` throws on `stepCell`'s -1 before ever asking.
    expect(() => assertEnterCellOnBoard(9, 240, 240)).toThrow(/car 9 .*cell 240/)
    expect(() => assertEnterCellOnBoard(9, 239, 240)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 11. Held progress — Decision 5, the whole of it
// ---------------------------------------------------------------------------

describe('a refused car holds its progress and writes nothing at all (Decision 5)', () => {
  /**
   * Two cars in a line on row 5, both eastbound, the leader parked.
   *
   * The leader is OUTBOUND with an EXHAUSTED cursor, which `advanceCar` returns
   * from before it touches anything — the only way to hold a cell indefinitely
   * without a second blocking car behind it, and sound by construction (it is
   * an in-flight car genuinely standing on the cell its slot names). Nothing
   * calls `runArrivals` here, so it is never collected.
   */
  function parkedLeaderRig(seed: string, followerProgress: number): Rig {
    const r = makeRig('held-progress', seed)
    handCar(r, { i: 0, cell: ROW5_X0 + 8, progress: 0, step: DIR_E, enteredBy: DIR_E, cursor: HAND_ROUTE_LEN })
    handCar(r, { i: 1, cell: ROW5_X0 + 7, progress: followerProgress, step: DIR_E, enteredBy: DIR_E })
    // Both cars count toward completeness: the parked leader is OUTBOUND with
    // `cursor > 0`, so `hasCrossedThisLeg` is true of it too. Stated as the
    // exact figure rather than `> 0`, which a one-car fixture would satisfy.
    expect(assertOccupancyConsistent(r.state, r.world)).toBe(2)
    return r
  }

  it('is bit-identical on EVERY blocked tick to its value on the tick the block began', () => {
    // The plan's exact words. Held at the last sub-threshold value — NOT
    // clamped to the threshold and NOT accumulated — so the assertion is one
    // number repeated, and it is the number arithmetic predicts rather than
    // whatever the first blocked tick happened to leave behind.
    const r = parkedLeaderRig('held-identical', 2200)
    const trace = driveHand(r, [{ i: 1, dir: DIR_E }], 12)
    for (let tick = 1; tick <= 12; tick++) {
      expect(trace.probe[tick]![0], `tick ${tick}`).toBe(EnterOutcome.REFUSED_OCCUPIED)
      expect(trace.cell[tick]![0], `tick ${tick}`).toBe(ROW5_X0 + 7)
      expect(trace.progress[tick]![0], `tick ${tick}`).toBe(2200)
    }
    // Not the threshold, and not zero: the two wrong answers named in Decision
    // 5, excluded by value rather than by "it did not move".
    expect(2200).toBeLessThan(ORTHO_THRESHOLD)
    expect(2200).toBeGreaterThanOrEqual(ORTHO_THRESHOLD - SPEED)
    // An accumulating implementation would be here after 12 blocked ticks:
    // 2,200 + 12 x 330 = 6,160, which is 2.46 thresholds — the car drawn one
    // and a half cells past the cell it has not entered. Stated as the figure
    // the render test in `resolve.test.ts` then falsifies.
    expect(2200 + 12 * SPEED).toBe(6160)
    expect(r.state.carRouteCursor[1]).toBe(1) // the cursor never moved either
    expect(r.state.carBlockedTicks[1]).toBe(0) // Task 4 owns this region
  })

  it('reaches the threshold on the block tick and not before — the sub-threshold arm is NOT a refusal', () => {
    // The negative control the whole outcome enum exists for. A car that is
    // merely short of its threshold also "does not move", and its progress also
    // "did not reset" — the two are separated only by whether `carProgress`
    // ROSE by `speed`, and by what `canEnter` says.
    const r = parkedLeaderRig('held-not-yet', 0)
    const trace = driveHand(r, [{ i: 1, dir: DIR_E }], 10)
    // Ticks 1..7: sub-threshold. Progress rises by exactly `speed` each tick,
    // and `canEnter` already answers REFUSED — because the question is about
    // the slot, not about whether the car is ready to ask it. That is precisely
    // why the probe alone is not the discriminator and the progress is.
    for (let tick = 1; tick <= 7; tick++) {
      expect(trace.progress[tick]![0], `tick ${tick}`).toBe(SPEED * tick)
    }
    // Tick 8 is the first tick the threshold is reached (330 x 8 = 2,640), so
    // it is the first tick the refusal actually costs anything. From here the
    // progress stops moving.
    expect(SPEED * 7).toBeLessThan(ORTHO_THRESHOLD)
    expect(SPEED * 8).toBeGreaterThanOrEqual(ORTHO_THRESHOLD)
    for (let tick = 8; tick <= 10; tick++) {
      expect(trace.progress[tick]![0], `tick ${tick}`).toBe(SPEED * 7)
    }
    expect(trace.cell[10]![0]).toBe(ROW5_X0 + 7)
  })

  it('advances exactly ONE cell on the tick the way clears, not two, and keeps the carry', () => {
    // The other half of Decision 5. The way is cleared by releasing the
    // leader's claim and standing it down — the leader's own departure is
    // tested through the real tick in section 12; here the point is the
    // follower's arithmetic on the granting tick, isolated from it.
    const r = parkedLeaderRig('held-clears', 2200)
    driveHand(r, [{ i: 1, dir: DIR_E }], 12)
    expect(r.state.carProgress[1]).toBe(2200)

    releaseCell(r.state, 0, ROW5_X0 + 8)
    r.state.carPhase[0] = PHASE_IDLE
    expect(canEnter(r.state, r.world, 1, ROW5_X0 + 8, DIR_E)).toBe(EnterOutcome.ENTER_FREE)

    runMovement(r.state, r.world)
    expect(r.state.carCell[1]).toBe(ROW5_X0 + 8)
    // ONE cell: the residual is 2,200 + 330 - 2,500 = 30, which is far below
    // one whole cell, so nothing could carry it a second cell this tick or the
    // next seven. Under "accumulate while blocked" the residual here would be
    // 6,160 + 330 - 2,500 = 3,990 — more than a whole extra cell in hand.
    expect(r.state.carProgress[1]).toBe(2200 + SPEED - ORTHO_THRESHOLD)
    expect(r.state.carProgress[1]).toBe(30)
    expect(r.state.carRouteCursor[1]).toBe(2)
    // And it really does take another eight ticks to reach the next cell.
    driveHand(r, [{ i: 1, dir: DIR_E }], 7)
    expect(r.state.carCell[1]).toBe(ROW5_X0 + 8)
    driveHand(r, [{ i: 1, dir: DIR_E }], 1)
    expect(r.state.carCell[1]).toBe(ROW5_X0 + 9)
  })

  it('the refusal is the only branch that leaves a DRIVING car with unchanged progress', () => {
    // The derivation `cars.ts` states, made executable. Four things make
    // `advanceCar` write nothing; three of them are excluded here by the car's
    // own bytes, so the fourth is the only one left and "progress unchanged"
    // becomes a sound discriminator for the rest of this file.
    const r = parkedLeaderRig('held-discriminator', 2200)
    driveHand(r, [{ i: 1, dir: DIR_E }], 3)
    const i = 1
    expect(r.state.carPhase[i]).toBe(PHASE_OUTBOUND) // not the phase arm
    expect(r.state.carRouteCursor[i]).toBeLessThan(r.state.carRouteLen[i] as number) // not the exhausted arm
    expect(r.state.carProgress[i]).toBe(2200) // not the sub-threshold arm, which would have risen
    expect((r.state.carProgress[i] as number) + SPEED).toBeGreaterThanOrEqual(ORTHO_THRESHOLD)
  })
})

// ---------------------------------------------------------------------------
// 12. Queueing is not implemented — it EMERGES
// ---------------------------------------------------------------------------

/**
 * Four cars behind a blocked leader, on one eastbound lane of row 5.
 *
 * ```
 *   x:        4     5     6     7     8        9 ...
 *   cell:   104   105   106   105   107   108   109
 *   car:      3     2     1     0   (blocker 4)
 * ```
 *
 * **There is no queue in the source.** No follower list, no "who is behind me",
 * no ordering pass. Every car in this fixture is refused by the identical two
 * lines `canEnter` contains, and the shape below is what falls out of them plus
 * held progress plus ascending iteration.
 *
 * ---------------------------------------------------------------------------
 * THE LADDER, HAND-COMPUTED — every number here is arithmetic, never read back
 * ---------------------------------------------------------------------------
 *
 * `speed` = 330 units/tick, orthogonal threshold 2,500. A car reaches its
 * threshold on the first tick `progress + 330 x t >= 2,500`, and a REFUSED tick
 * leaves `progress` exactly where it was, so a blocked car's threshold tick is
 * also every subsequent tick.
 *
 * | car | starts on | progress | ceil((2500-p)/330) | joins the queue | held at |
 * |-----|-----------|----------|--------------------|-----------------|---------|
 * | 0   | 107       | 2,200    | 1                  | tick **1**      | 2,200   |
 * | 1   | 106       | 1,550    | 3                  | tick **3**      | 2,210   |
 * | 2   | 105       | 900      | 5                  | tick **5**      | 2,220   |
 * | 3   | 104       | 250      | 7                  | tick **7**      | 2,230   |
 * | 4   | 108       | 0        | 8                  | never (109 free)| —       |
 *
 * The four carries are deliberately different, so the four cars join on four
 * DIFFERENT ticks and **tick 7 is the first tick on which all four are blocked
 * at once** — with the blocker still standing on 108, which it vacates on tick
 * 8. A fixture whose cars share a carry cannot tell "the queue formed" from
 * "four cars were parked".
 *
 * "Held at" is the car's last sub-threshold value: `p + 330 x (t - 1)` for its
 * threshold tick `t`. Car 3's is the largest because it joins latest.
 *
 * **Tick 8 is the release and it takes two ticks, not one, and that is index
 * order rather than an off-by-one.** Ascending, car 0 is reached BEFORE car 4,
 * so it is refused one last time on the very tick car 4 leaves; car 4 then
 * vacates 108. Every queued car crosses on **tick 9**:
 *
 * | car | crosses  | residual = held + 330 - 2500 |
 * |-----|----------|------------------------------|
 * | 0   | 9 -> 108 | 30                           |
 * | 1   | 9 -> 107 | 40                           |
 * | 2   | 9 -> 106 | 50                           |
 * | 3   | 9 -> 105 | 60                           |
 *
 * The whole cascade is ONE tick because ascending order frees each cell just
 * before the car behind it asks. **Descending order takes four**: car 3 is
 * asked first and its cell is still occupied, so only the leader moves on each
 * tick and the four arrivals fall on ticks 9, 10, 11 and 12 instead.
 *
 * Afterwards the four are a platoon one cell apart with carries 30/40/50/60, so
 * all four cross again on **tick 17** (each needs 8 more ticks), arriving with
 * carries 170/180/190/200. Those are no longer equivalent: 170 and 180 need 8
 * more ticks, 190 and 200 need only 7. So cars **2 and 3 reach their thresholds
 * on tick 24, a tick before the cars in front of them move, and are refused
 * once each**; all four then cross on **tick 25**. That is the queue still
 * interacting a cell-and-a-half downstream of where it formed, and it is
 * asserted rather than smoothed over.
 */

const Q_CELL = [ROW5_X0 + 7, ROW5_X0 + 6, ROW5_X0 + 5, ROW5_X0 + 4] as const // cars 0..3
const Q_BLOCKER_CELL = ROW5_X0 + 8 // 108, car 4
const Q_START_PROGRESS = [2200, 1550, 900, 250] as const
const Q_JOINS_AT = [1, 3, 5, 7] as const
const Q_HELD_AT = [2200, 2210, 2220, 2230] as const
const Q_ALL_QUEUED_AT = 7
const Q_CLEARS_AT = 9
const Q_RESIDUAL = [30, 40, 50, 60] as const
const Q_WATCH: readonly Watch[] = [
  { i: 0, dir: DIR_E },
  { i: 1, dir: DIR_E },
  { i: 2, dir: DIR_E },
  { i: 3, dir: DIR_E },
  { i: 4, dir: DIR_E },
]

function queueRig(seed: string): Rig {
  const r = makeRig('queue', seed)
  for (let k = 0; k < 4; k++) {
    handCar(r, {
      i: k,
      cell: Q_CELL[k] as number,
      progress: Q_START_PROGRESS[k] as number,
      step: DIR_E,
      enteredBy: DIR_E,
    })
  }
  handCar(r, { i: 4, cell: Q_BLOCKER_CELL, progress: 0, step: DIR_E, enteredBy: DIR_E })
  return r
}

describe('three cars behind a blocked leader form a queue, and it clears in order', () => {
  it('is not blocked by GEOMETRY: every refusal names the car in front, and the leaders names car 4', () => {
    // The brief's vacuity self-check, and the whole fixture rests on it. A
    // queue whose cars are stopped by a board edge, an exhausted route or a
    // corrupt nibble would produce the same "nobody moved" trace.
    const r = queueRig('queue-vacuity')
    // Tick 7, not 8: tick 7 is the first tick all four are blocked, and the
    // blocker leaves on tick 8. Asking one tick later would find cell 108 free
    // and the leader unrefused — which is a real property of this fixture, and
    // the reason the window is stated rather than rounded.
    driveHand(r, Q_WATCH, Q_ALL_QUEUED_AT)
    // Every one of the four is standing where it started, at its threshold, and
    // the slot it wants is held by exactly the car ahead of it.
    const inFront = [4, 0, 1, 2]
    for (let k = 0; k < 4; k++) {
      const cell = Q_CELL[k] as number
      const target = cell + 1
      expect(r.state.carCell[k], `car ${k} moved`).toBe(cell)
      expect(target, `car ${k} target off board`).toBeLessThan(CELLS)
      expect(canEnter(r.state, r.world, k, target, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
      expect(occupantOf(r.state, target, LANE_OF_DIR[DIR_E] as number), `car ${k}`).toBe(inFront[k])
      // Not the route, not the phase: each car is driving with a live cursor.
      expect(r.state.carPhase[k]).toBe(PHASE_OUTBOUND)
      expect(r.state.carRouteCursor[k]).toBe(1)
      expect(r.state.carRouteLen[k]).toBe(HAND_ROUTE_LEN)
    }
    // The leader is blocked by a CAR, and that car is genuinely in flight and
    // genuinely about to move — not a wall dressed up as a car.
    expect(r.state.carPhase[4]).toBe(PHASE_OUTBOUND)
    expect(r.state.carCell[4]).toBe(Q_BLOCKER_CELL)
    // And the cell in front of the blocker is FREE the whole time, so nothing
    // upstream of this fixture is doing the blocking.
    expect(canEnter(r.state, r.world, 4, Q_BLOCKER_CELL + 1, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('joins the queue on the hand-computed tick for each car — 1, 4, 7, 8 — and not before', () => {
    // Each car is unblocked until its own threshold, which is what makes this a
    // queue that FORMS rather than four cars that were parked. Both sides of
    // each boundary are asserted: moving on the tick before, held on the tick
    // after.
    const r = queueRig('queue-joins')
    const trace = driveHand(r, Q_WATCH, 8)
    for (let k = 0; k < 4; k++) {
      const joins = Q_JOINS_AT[k] as number
      const start = Q_START_PROGRESS[k] as number
      // Before: progress rising by exactly `speed` every tick.
      for (let tick = 1; tick < joins; tick++) {
        expect(trace.progress[tick]![k], `car ${k} tick ${tick}`).toBe(start + SPEED * tick)
      }
      // From its threshold tick on: frozen, at the hand-computed value.
      for (let tick = joins; tick <= 8; tick++) {
        expect(trace.progress[tick]![k], `car ${k} tick ${tick}`).toBe(Q_HELD_AT[k] as number)
      }
      expect(Q_HELD_AT[k]).toBe(start + SPEED * (joins - 1))
      expect(trace.cell[8]![k], `car ${k}`).toBe(Q_CELL[k] as number)
    }
    // The blocker is the one car that is NOT queued: it crosses on tick 8.
    expect(trace.cell[7]![4]).toBe(Q_BLOCKER_CELL)
    expect(trace.cell[8]![4]).toBe(Q_BLOCKER_CELL + 1)
  })

  it('all four cross on tick 9 — the cascade is ONE tick under ascending index', () => {
    const r = queueRig('queue-clears')
    const trace = driveHand(r, Q_WATCH, Q_CLEARS_AT)
    for (let k = 0; k < 4; k++) {
      // Still queued on tick 8, moved on tick 9. Both halves, so "it eventually
      // moved" cannot pass for "it moved on the tick the way cleared".
      expect(trace.cell[Q_CLEARS_AT - 1]![k], `car ${k}`).toBe(Q_CELL[k] as number)
      expect(trace.cell[Q_CLEARS_AT]![k], `car ${k}`).toBe((Q_CELL[k] as number) + 1)
      // Exactly one cell, with the hand-computed carry.
      expect(trace.progress[Q_CLEARS_AT]![k], `car ${k}`).toBe(Q_RESIDUAL[k] as number)
      expect(Q_RESIDUAL[k]).toBe((Q_HELD_AT[k] as number) + SPEED - ORTHO_THRESHOLD)
      expect(r.state.carRouteCursor[k]).toBe(2)
    }
    // The occupancy array after the cascade: four cars, four consecutive cells,
    // one lane each, and the cell the queue vacated at the back is free.
    expect(slotsOf(r.state, ROW5_X0 + 8)).toEqual([0, FREE])
    expect(slotsOf(r.state, ROW5_X0 + 7)).toEqual([1, FREE])
    expect(slotsOf(r.state, ROW5_X0 + 6)).toEqual([2, FREE])
    expect(slotsOf(r.state, ROW5_X0 + 5)).toEqual([3, FREE])
    expect(slotsOf(r.state, ROW5_X0 + 4)).toEqual([FREE, FREE])
    expect(trace.maxCompletenessChecked).toBe(5)
  })

  it('then runs as a platoon: all four cross again at 17 and 25, with car 3 refused once at 24', () => {
    // The queue does not dissolve when it clears — it becomes a platoon one
    // cell apart, and the carries it inherited keep it interacting. Car 3's
    // carry after tick 17 is 280 against 150-170 for the others, so it reaches
    // its threshold a tick early and is refused exactly once more.
    const r = queueRig('queue-platoon')
    const trace = driveHand(r, Q_WATCH, 25)
    for (let k = 0; k < 4; k++) {
      expect(trace.cell[17]![k], `car ${k} at 17`).toBe((Q_CELL[k] as number) + 2)
      expect(trace.cell[25]![k], `car ${k} at 25`).toBe((Q_CELL[k] as number) + 3)
    }
    // Carries after tick 17, hand-computed as `residual + 8 x 330 - 2500`.
    // Car 4 (the blocker) is in the watch list too, and its 610 is a plain
    // accumulating tick — it crossed on 16 and is nowhere near the platoon.
    expect(trace.progress[17]).toEqual([170, 180, 190, 200, 610])
    // Cars 2 and 3 reach their thresholds on tick 24 and are refused; cars 0
    // and 1 are still short of theirs. That contrast is the discriminator
    // between "car 2 was blocked on tick 24" and "nothing happened on tick 24".
    for (const k of [2, 3]) {
      expect(trace.cell[24]![k], `car ${k}`).toBe((Q_CELL[k] as number) + 2)
      expect(trace.probe[24]![k], `car ${k}`).toBe(EnterOutcome.REFUSED_OCCUPIED)
      expect(trace.progress[24]![k], `car ${k}`).toBe((trace.progress[17]![k] as number) + SPEED * 6)
      expect(trace.progress[23]![k], `car ${k}`).toBe((trace.progress[17]![k] as number) + SPEED * 6)
    }
    for (const k of [0, 1]) {
      expect(trace.progress[24]![k], `car ${k}`).toBe((trace.progress[17]![k] as number) + SPEED * 7)
      // Still accumulating, so tick 24 cost them nothing: they were never asked.
      expect(trace.progress[24]![k], `car ${k}`).toBeLessThan(ORTHO_THRESHOLD)
    }
    // Car 2's carry on the granting tick is exactly 0: 2,170 + 330 is precisely
    // the threshold. The comparison is `>=`, so it crosses — a `>` would strand
    // it for another eight ticks, and this is the only place in the file where
    // that edge is on the reachable path.
    // Car 4 again is unrelated: it crossed on tick 23 carrying 90 and has
    // simply accumulated two ticks since (90 + 2 x 330 = 750).
    expect(trace.progress[25]).toEqual([310, 320, 0, 10, 750])
  })

  it('nothing in the buffer records a queue — the emergence claim, asserted', () => {
    // `carBlockedTicks` is the only region that could hold a queue position and
    // Task 3 never writes it. If a future change starts maintaining follower
    // state anywhere, this is the assertion that says so.
    const r = queueRig('queue-emergent')
    driveHand(r, Q_WATCH, 25)
    expect(Array.from(r.state.carBlockedTicks).every((v) => v === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 13. Head-on on a one-wide corridor — structural, not a give-way rule
// ---------------------------------------------------------------------------

/**
 * **Give-way is not implemented and does not need to be** (Decision 1). Two
 * cars travelling in exactly opposite directions can never contend for the same
 * slot, because `LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]` for every `d`.
 *
 * Both shapes of the meeting are covered here, and they are genuinely different
 * events rather than one event tested twice:
 *
 *   - **The swap.** Both cars reach their thresholds on the same tick and
 *     exchange cells in one tick. Run in BOTH index orders, because "resolves
 *     in either index order" is the claim and one order is not evidence for it.
 *   - **The co-location.** Their thresholds are staggered, so the westbound car
 *     enters the cell the eastbound car is standing on and the two share it for
 *     seven ticks. This is the shape the project's own flagship loop fixture
 *     produces at cell 113 on ticks 73-76, and it is the one that a single
 *     undirected slot per cell would deadlock.
 */
describe('a head-on meeting on a one-wide corridor: neither car is ever refused', () => {
  /**
   * `east` travels E and `west` travels W, on adjacent cells of row 5. The
   * westbound car is RETURNING, which is the only way a car travels W on a
   * route whose steps all point E — exactly as a real return leg does.
   */
  function headOnRig(seed: string, east: number, west: number, eastProgress: number): Rig {
    const r = makeRig('head-on', seed)
    handCar(r, { i: east, cell: ROW5_X0 + 6, progress: eastProgress, step: DIR_E, enteredBy: DIR_E })
    handCar(r, {
      i: west,
      cell: ROW5_X0 + 7,
      progress: 2200,
      step: DIR_E,
      enteredBy: DIR_W,
      phase: PHASE_RETURNING,
      cursor: 6,
    })
    // Vacuity: the two cars really are nose to nose, in OPPOSITE lanes, on
    // adjacent cells of one corridor.
    expect(r.state.carCell[west]).toBe((r.state.carCell[east] as number) + 1)
    expect(slotsOf(r.state, ROW5_X0 + 6)).toEqual(east === 0 ? [0, FREE] : [1, FREE])
    expect(slotsOf(r.state, ROW5_X0 + 7)).toEqual(west === 0 ? [FREE, 0] : [FREE, 1])
    expect(LANE_OF_DIR[DIR_E]).not.toBe(LANE_OF_DIR[OPPOSITE[DIR_E] as number])
    return r
  }

  it('the swap resolves in ONE tick, and in either index order — the property Decision 1 rests on', () => {
    const orders: readonly (readonly [number, number])[] = [
      [0, 1],
      [1, 0],
    ]
    for (const [east, west] of orders) {
      const r = headOnRig(`swap-${east}-${west}`, east, west, 2200)
      const trace = driveHand(
        r,
        [
          { i: east, dir: DIR_E },
          { i: west, dir: DIR_W },
        ],
        1,
        { cells: [ROW5_X0 + 6, ROW5_X0 + 7] },
      )
      // Both granted, on tick 1, by outcome code — not by "they both moved".
      expect(trace.probe[1], `order ${east}/${west}`).toEqual([
        EnterOutcome.ENTER_FREE,
        EnterOutcome.ENTER_FREE,
      ])
      expect(trace.cell[1], `order ${east}/${west}`).toEqual([ROW5_X0 + 7, ROW5_X0 + 6])
      // They passed through each other's cells and each now holds its own lane
      // of the other's old cell.
      expect(trace.slots[1]!.get(ROW5_X0 + 7), `order ${east}/${west}`).toEqual([east, FREE])
      expect(trace.slots[1]!.get(ROW5_X0 + 6), `order ${east}/${west}`).toEqual([FREE, west])
      // Neither ever waited: identical residuals, identical to an empty road.
      expect(trace.progress[1], `order ${east}/${west}`).toEqual([30, 30])
      expect(r.state.carBlockedTicks[east]).toBe(0)
      expect(r.state.carBlockedTicks[west]).toBe(0)
    }
  })

  it('shares one cell for seven ticks when the thresholds are staggered, and still refuses nothing', () => {
    // The brief's vacuity self-check: the fixture must actually put both cars
    // on the shared cell SIMULTANEOUSLY, or it proves only that nothing
    // happened. The eastbound car starts at progress 0 (leaves on tick 8) and
    // the westbound at 2,200 (arrives on tick 1), so cell 106 carries both of
    // them at the end of every tick from 1 to 7.
    const r = headOnRig('head-on-colocated', 0, 1, 0)
    const trace = driveHand(
      r,
      [
        { i: 0, dir: DIR_E },
        { i: 1, dir: DIR_W },
      ],
      9,
      { cells: [ROW5_X0 + 5, ROW5_X0 + 6, ROW5_X0 + 7] },
    )
    for (let tick = 1; tick <= 7; tick++) {
      expect(trace.cell[tick], `tick ${tick}`).toEqual([ROW5_X0 + 6, ROW5_X0 + 6])
      // Co-located, and in the two DIFFERENT lanes that make it legal. Asserted
      // as the pair, so "both cars are somewhere on this cell" cannot pass for
      // "each holds its own direction's lane".
      expect(trace.slots[tick]!.get(ROW5_X0 + 6), `tick ${tick}`).toEqual([0, 1])
      // Neither is ever refused, including on the tick the westbound car drives
      // into an occupied cell. THIS is the head-on question, answered by code.
      expect(trace.probe[tick], `tick ${tick}`).toEqual([EnterOutcome.ENTER_FREE, EnterOutcome.ENTER_FREE])
    }
    // Hand-computed departures. Eastbound: 0 + 330 x 8 = 2,640 on tick 8.
    // Westbound: it crossed on tick 1 carrying 30, so 30 + 330 x 8 = 2,670 on
    // tick 9.
    expect(trace.cell[8]).toEqual([ROW5_X0 + 7, ROW5_X0 + 6])
    expect(trace.cell[9]).toEqual([ROW5_X0 + 7, ROW5_X0 + 5])
    expect(trace.probe[8]).toEqual([EnterOutcome.ENTER_FREE, EnterOutcome.ENTER_FREE])
    expect(trace.probe[9]).toEqual([EnterOutcome.ENTER_FREE, EnterOutcome.ENTER_FREE])
    // Neither car lost a single tick to the other.
    expect(r.state.carBlockedTicks[0]).toBe(0)
    expect(r.state.carBlockedTicks[1]).toBe(0)
    expect(trace.progress[8]![0]).toBe(140) // 2,640 - 2,500
    expect(trace.progress[9]![1]).toBe(170) // 2,670 - 2,500
  })

  it('is not vacuous: the SAME geometry with both cars travelling east blocks immediately', () => {
    // The control. Everything above would also pass on a board where cars
    // simply never interact, and this is the one-character difference that
    // separates "opposite lanes" from "no contention".
    const r = makeRig('head-on-control', 'head-on-control')
    handCar(r, { i: 0, cell: ROW5_X0 + 6, progress: 0, step: DIR_E, enteredBy: DIR_E })
    // Same cell, same starting progress, same corridor as the westbound car
    // above — the ONLY difference is the direction it entered by, and therefore
    // the lane it holds. Parked (exhausted cursor) so that it is still there on
    // tick 8, which is what makes the two fixtures comparable.
    handCar(r, {
      i: 1,
      cell: ROW5_X0 + 7,
      progress: 2200,
      step: DIR_E,
      enteredBy: DIR_E,
      cursor: HAND_ROUTE_LEN,
    })
    const trace = driveHand(r, [{ i: 0, dir: DIR_E }], 8, { cells: [ROW5_X0 + 7] })
    // Car 1 entered heading E, so it holds lane 0 — the very lane car 0 needs.
    expect(trace.slots[8]!.get(ROW5_X0 + 7)).toEqual([1, FREE])
    expect(trace.probe[8]![0]).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(trace.cell[8]![0]).toBe(ROW5_X0 + 6)
  })
})

// ---------------------------------------------------------------------------
// 14. The dead-end carpark, and the pin a blocked car keeps
// ---------------------------------------------------------------------------

/**
 * A car flipping to RETURNING on carpark cell K, with a queued car on K-1.
 *
 * **This is the tightest case in the game and every destination is one**
 * (Decision 1). The board here is the L fixture's: carpark 68 at the top of
 * column 8, approached northbound from 88.
 *
 * ```
 *   68  K      car 0 — just flipped, RETURNING, will leave heading S
 *   88  K-1    car 1 — OUTBOUND, northbound, wants K
 * ```
 *
 * **Two facts, and they are different facts.**
 *
 *   1. **The returning car is never refused.** It entered K heading N (lane 1)
 *      and leaves heading S (lane 0); car 1 is standing on K-1 holding lane 1
 *      there, and lane 0 of K-1 is free. That is Decision 1 doing its whole
 *      job: under one undirected slot per cell these two deadlock, and this is
 *      the deadlock the plan's first revision shipped.
 *   2. **The queued car IS refused, for as long as the flipped car stands on
 *      K.** The flip does not move the car, so it keeps the lane-1 claim its
 *      OUTBOUND leg made — and lane 1 is exactly the lane a northbound
 *      follower needs. This is a queue, not a deadlock: it is bounded by one
 *      crossing time (at most 8 ticks at these constants), and it clears with
 *      no valve.
 *
 * Fact 2 is worth stating plainly because the natural reading of "head-on is
 * structurally resolved" is that nothing waits at a carpark, and that is not
 * true. What is true is that nothing *deadlocks* there. The final case below
 * shows the one arrangement in which nothing waits either — the two thresholds
 * coinciding, with the returning car at the lower index.
 */
const CARPARK_K = CARPARK_CELL // 68
const CARPARK_K1 = CARPARK_CELL + W // 88
const CARPARK_ROUTE_LEN = 4

function carparkRig(seed: string, queuedProgress: number): Rig {
  const r = makeRig('carpark-queue', seed)
  expect(placeDestination(r.state, r.world, DEST_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  // Car 0: just flipped on K. Cursor at routeLen is what arrivals leaves
  // behind, and it is why `hasCrossedThisLeg` is false for it — the documented
  // asymmetry: it holds a claim carried over from the outbound leg.
  handCar(r, {
    i: 0,
    cell: CARPARK_K,
    progress: 0,
    step: DIR_N,
    enteredBy: DIR_N,
    phase: PHASE_RETURNING,
    routeLen: CARPARK_ROUTE_LEN,
    cursor: CARPARK_ROUTE_LEN,
  })
  // Car 1: outbound, one crossing short of the carpark, holding the
  // reservation it has carried since dispatch.
  handCar(r, {
    i: 1,
    cell: CARPARK_K1,
    progress: queuedProgress,
    step: DIR_N,
    enteredBy: DIR_N,
    routeLen: CARPARK_ROUTE_LEN,
    cursor: CARPARK_ROUTE_LEN - 1,
  })
  r.state.carTargetDest[1] = 0
  r.state.destPins[0] = 1
  r.state.destReserved[0] = 1
  return r
}

/** `sum(destReserved)` and `count(PHASE_OUTBOUND)` — the invariant, both sides. */
function reservationBalance(r: Rig): [number, number] {
  let reserved = 0
  for (let d = 0; d < (r.state.header[H_DEST_COUNT] as number); d++) {
    reserved += r.state.destReserved[d] as number
  }
  let outbound = 0
  for (let i = 0; i < r.state.carPhase.length; i++) {
    if (r.state.carPhase[i] === PHASE_OUTBOUND) outbound++
  }
  return [reserved, outbound]
}

describe('a dead-end carpark: the returning car always leaves, the queued car waits', () => {
  it('refuses the queued car for exactly the seven ticks the flipped car stands on K', () => {
    const r = carparkRig('carpark-refused', 2200)
    expect(reservationBalance(r)).toEqual([1, 1])
    const watch: readonly Watch[] = [
      { i: 0, dir: DIR_S },
      { i: 1, dir: DIR_N },
    ]
    const trace = driveHand(r, watch, 8, { arrivals: true, cells: [CARPARK_K, CARPARK_K1] })

    for (let tick = 1; tick <= 7; tick++) {
      // The queued car: refused, by name, and standing exactly where it was.
      expect(trace.probe[tick]![1], `tick ${tick}`).toBe(EnterOutcome.REFUSED_OCCUPIED)
      expect(trace.cell[tick]![1], `tick ${tick}`).toBe(CARPARK_K1)
      expect(trace.progress[tick]![1], `tick ${tick}`).toBe(2200)
      // The returning car: never refused, on any of those ticks, even though a
      // car is standing on the only cell it can go to.
      expect(trace.probe[tick]![0], `tick ${tick}`).toBe(EnterOutcome.ENTER_FREE)
      expect(trace.cell[tick]![0], `tick ${tick}`).toBe(CARPARK_K)
      // And the refusal names the flipped car, in the lane the flip left behind:
      // lane 1 (northbound) held, lane 0 (southbound) free.
      expect(trace.slots[tick]!.get(CARPARK_K), `tick ${tick}`).toEqual([FREE, 0])
      expect(LANE_OF_DIR[DIR_N]).toBe(1)
      // **The pin is untouched while it waits.** Blocked is not arrived, and
      // the invariant `sum(destReserved) === count(PHASE_OUTBOUND)` holds on
      // every one of the blocked ticks.
      expect(trace.reservations[tick], `tick ${tick}`).toEqual([1, 1, 1])
    }

    // Tick 8: car 0 (ascending, index 0) leaves K southbound into K-1 — where
    // car 1 is still standing, in the other lane — and car 1 then takes K and
    // arrives on the same tick.
    expect(trace.cell[8]).toEqual([CARPARK_K1, CARPARK_K])
    // **The tick-8 probes are the clearest statement of why index order
    // matters, so they are asserted rather than skipped.** Both are taken
    // BEFORE the tick. Car 0's answer is what `advanceCar` sees, because
    // ascending order reaches it first and nothing has moved yet. Car 1's still
    // reads REFUSED_OCCUPIED — and car 1 crosses anyway, because K is vacated
    // between this probe and the moment car 1 is actually asked. Under
    // descending order that ordering reverses and car 1 waits another eight
    // ticks.
    expect(trace.probe[8]).toEqual([EnterOutcome.ENTER_FREE, EnterOutcome.REFUSED_OCCUPIED])
    expect(slotsOf(r.state, CARPARK_K1)).toEqual([0, FREE]) // car 0 entered heading S
    expect(slotsOf(r.state, CARPARK_K)).toEqual([FREE, 1]) // car 1 entered heading N
    // The pin is consumed exactly once, on the tick the car actually arrives.
    expect(r.state.carPhase[1]).toBe(PHASE_RETURNING)
    expect(r.state.destPins[0]).toBe(0)
    expect(r.state.destReserved[0]).toBe(0)
    expect(reservationBalance(r)).toEqual([0, 0])
  })

  it('and refuses NOTHING when the two thresholds coincide, because ascending order clears K first', () => {
    // The same geometry, one constant different: the queued car's carry now
    // matches the flipped car's, so both reach their thresholds on tick 8 and
    // the returning car — at the lower index — vacates K before the follower is
    // asked. Zero refusals, from the same code, on the same board.
    const r = carparkRig('carpark-unrefused', 0)
    const trace = driveHand(r, [{ i: 0, dir: DIR_S }, { i: 1, dir: DIR_N }], 8, { arrivals: true })
    for (let tick = 1; tick <= 8; tick++) {
      expect(trace.probe[tick]![0], `tick ${tick}`).toBe(EnterOutcome.ENTER_FREE)
    }
    // Ticks 1-7 the follower is simply short of its threshold; on tick 8 it is
    // granted. Its progress rises every tick, which is what says it was never
    // refused rather than refused-and-held.
    for (let tick = 1; tick <= 7; tick++) {
      expect(trace.progress[tick]![1], `tick ${tick}`).toBe(SPEED * tick)
    }
    expect(trace.cell[8]).toEqual([CARPARK_K1, CARPARK_K])
    expect(r.state.carBlockedTicks[0]).toBe(0)
    expect(r.state.carBlockedTicks[1]).toBe(0)
    expect(reservationBalance(r)).toEqual([0, 0])
  })

  it('is not vacuous: without the lane rule the returning car would have nowhere to go', () => {
    // The counterfactual made concrete rather than argued. The cell the
    // returning car must enter is occupied — by the very car waiting for it —
    // and the ONLY reason it is admitted is that the two directions use
    // different lanes. Asserted as the two slot values of that one cell.
    const r = carparkRig('carpark-counterfactual', 2200)
    expect(r.state.carCell[1]).toBe(CARPARK_K1)
    expect(occupantOf(r.state, CARPARK_K1, LANE_OF_DIR[DIR_N] as number)).toBe(1)
    expect(occupantOf(r.state, CARPARK_K1, LANE_OF_DIR[DIR_S] as number)).toBe(FREE)
    expect(canEnter(r.state, r.world, 0, CARPARK_K1, DIR_S)).toBe(EnterOutcome.ENTER_FREE)
    // Under one undirected slot per cell there is one answer for both, and it
    // is this one — the deadlock the plan's first revision shipped.
    expect(canEnter(r.state, r.world, 0, CARPARK_K1, DIR_N)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })
})

// ---------------------------------------------------------------------------
// 15. Two cars contending for ONE slot — ascending index decides
// ---------------------------------------------------------------------------

/**
 * The case Decision 1 says the model deliberately permits and Decision 2 says
 * the index resolves: **two cars whose directions land in the SAME lane, both
 * entering one junction cell on one tick.**
 *
 * `LANE_OF_DIR[E] = LANE_OF_DIR[S] = 0`, so an eastbound car and a southbound
 * car contend for one slot at a junction even though they are not opposed. One
 * is granted and one is refused, and which is which is `runMovement`'s
 * iteration order — outcome-visible for the first time in this milestone.
 */
const JUNCTION = 130 // (10, 6)

function junctionRig(seed: string, eastbound: number, southbound: number): Rig {
  const r = makeRig('junction', seed)
  handCar(r, { i: eastbound, cell: JUNCTION - 1, progress: 2200, step: DIR_E, enteredBy: DIR_E })
  handCar(r, { i: southbound, cell: JUNCTION - W, progress: 2200, step: DIR_S, enteredBy: DIR_S })
  // Vacuity: the two really do want the SAME slot, from different cells.
  expect(LANE_OF_DIR[DIR_E]).toBe(LANE_OF_DIR[DIR_S])
  expect(stepCell(JUNCTION - 1, DIR_E, r.world.w, r.world.h)).toBe(JUNCTION)
  expect(stepCell(JUNCTION - W, DIR_S, r.world.w, r.world.h)).toBe(JUNCTION)
  expect(slotsOf(r.state, JUNCTION)).toEqual([FREE, FREE])
  return r
}

describe('two cars contending for one slot resolve in ascending index, and the loser is unmoved', () => {
  const orders: readonly (readonly [number, number])[] = [
    [0, 1],
    [1, 0],
  ]
  for (const [eastbound, southbound] of orders) {
    it(`grants car ${Math.min(eastbound, southbound)} when eastbound is car ${eastbound}`, () => {
      const winner = Math.min(eastbound, southbound)
      const loser = Math.max(eastbound, southbound)
      const winnerCell = winner === eastbound ? JUNCTION - 1 : JUNCTION - W
      const loserCell = loser === eastbound ? JUNCTION - 1 : JUNCTION - W
      const loserDir = loser === eastbound ? DIR_E : DIR_S
      const r = junctionRig(`junction-${eastbound}-${southbound}`, eastbound, southbound)

      runMovement(r.state, r.world)

      // The lower index took the junction; the higher one is exactly where it
      // was, with progress bit-identical and its cursor untouched.
      expect(r.state.carCell[winner]).toBe(JUNCTION)
      expect(slotsOf(r.state, JUNCTION)).toEqual([winner, FREE])
      expect(r.state.carCell[loser]).toBe(loserCell)
      expect(r.state.carProgress[loser]).toBe(2200)
      expect(r.state.carRouteCursor[loser]).toBe(1)
      expect(canEnter(r.state, r.world, loser, JUNCTION, loserDir)).toBe(EnterOutcome.REFUSED_OCCUPIED)
      expect(occupantOf(r.state, JUNCTION, 0)).toBe(winner)
      // The winner really did move and really did vacate its own cell.
      expect(r.state.carProgress[winner]).toBe(30)
      expect(slotsOf(r.state, winnerCell)).toEqual([FREE, FREE])
      expect(assertOccupancyConsistent(r.state, r.world)).toBe(2)

      // And the loser takes the junction on the tick the winner leaves it —
      // tick 9, since the winner carried 30 across. Not sooner: it is refused
      // on every one of ticks 2-8.
      const trace = driveHand(r, [{ i: loser, dir: loserDir }], 8)
      for (let tick = 1; tick <= 7; tick++) {
        expect(trace.probe[tick]![0], `tick ${tick}`).toBe(EnterOutcome.REFUSED_OCCUPIED)
        expect(trace.cell[tick]![0], `tick ${tick}`).toBe(loserCell)
      }
      expect(trace.cell[8]![0]).toBe(JUNCTION)
      expect(trace.progress[8]![0]).toBe(30)
      expect(r.state.carCell[winner]).not.toBe(JUNCTION)
    })
  }
})
