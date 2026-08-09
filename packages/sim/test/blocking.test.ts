import { describe, it, expect } from 'vitest'
import { parseMap, CARS_PER_HOUSE, type MapData } from '@laneways/shared'
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
import { LANE_COUNT, LANE_OF_DIR, DX, DY, OPPOSITE } from '../src/roads'
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
  occupancySlot,
  occupantOf,
  claimCell,
  releaseCell,
  hasCrossedThisLeg,
  assertMaxCarsFitsOccupancy,
  assertOccupancySound,
  assertOccupancyComplete,
  assertOccupancyConsistent,
} from '../src/blocking'
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

/** Hand-computed absolute ticks; see the module comment. Never read back from a run. */
const T_ENTER_CORNER_OUTBOUND = 47
const T_LEAVE_CORNER_OUTBOUND = 55
const T_ARRIVE_CARPARK = 77
const T_ENTER_CORNER_RETURN = 108
const T_LEAVE_CORNER_RETURN = 115
const T_TRIP_END = 153
const T_ENTER_MID_HOUSE = 24 // crossing k=3
const T_LEAVE_MID_HOUSE = 32 // crossing k=4
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
    // Second, independent detector for the same edit: a slot naming a
    // PHASE_IDLE car is a soundness violation by definition.
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
// 5. The Task-2-only completeness exception, made explicit
// ---------------------------------------------------------------------------

describe('the Task-2-only same-lane displacement (not in the plan\'s stated exception set)', () => {
  it('two cars crossing into one lane on one tick leave the array SOUND but not COMPLETE', () => {
    // Task 2 declares the primitive and adds no refusal, so this is reachable
    // through the ordinary path. From Task 3 `canEnter` refuses the second
    // entry outright and this whole describe block should be rewritten as a
    // refusal test — it is here so the exception is a pinned observation
    // rather than a sentence in a comment.
    //
    // It is also the first DIRECT observation that ascending car order is
    // outcome-visible: the surviving occupant is the LAST writer.
    const r = buildFixture('same-lane-displacement')
    const trace = runFixture(r, DISPATCH_TICK, 2)
    expect(trace.phaseAfterTick[DISPATCH_TICK]).toBe(PHASE_OUTBOUND)
    expect(r.state.carPhase[1]).toBe(PHASE_OUTBOUND)

    for (let tick = DISPATCH_TICK + 1; tick <= T_QUIET_CROSSING; tick++) {
      step(r.state, r.world, r.fields, r.scratch, NO_ACTIONS)
    }
    // Both cars dispatched on the same tick with the same route and the same
    // speed, so they cross together.
    expect(r.state.carCell[0]).toBe(143)
    expect(r.state.carCell[1]).toBe(143)
    expect(hasCrossedThisLeg(r.state, 0)).toBe(true)
    expect(hasCrossedThisLeg(r.state, 1)).toBe(true)
    // Ascending iteration: car 1 writes last and survives in the shared lane.
    expect(slotsOf(r.state, 143)).toEqual([1, FREE])
    // Sound — both cars really are standing on 143.
    expect(() => assertOccupancySound(r.state, r.world)).not.toThrow()
    // Not complete — car 0 has crossed and is named by nothing.
    expect(() => assertOccupancyComplete(r.state, r.world)).toThrow(/a claim went missing/)
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
