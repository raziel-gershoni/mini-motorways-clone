import { describe, it, expect } from 'vitest'
import {
  parseMap,
  CARS_PER_HOUSE,
  COST_UNIT_SCALE,
  LANE_SPEED_DEFAULT,
  MAX_BLOCKED_TICKS,
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
import { createScratch, createFlowFields, CT_REBUILDS, INF, type FlowField, type Scratch } from '../src/scratch'
import { LANE_COUNT, LANE_OF_DIR, DX, DY, OPPOSITE, eraseRoad, stepCell } from '../src/roads'
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
  noteEntryGranted,
  noteEntryRefused,
  assertEnterCarValid,
  assertEnterCellOnBoard,
  isEntryGranted,
  assertEnterDirValid,
  assertMaxCarsFitsOccupancy,
  assertOccupancySound,
  assertOccupancyComplete,
  assertOccupancyConsistent,
  type EnterOutcomeCode,
} from '../src/blocking'
import { runMovement, speedUnits } from '../src/cars'
import { isCommittedTo, packRouteStep, routeStep } from '../src/dispatch'
import { runArrivals } from '../src/trips'
import { step, type TickAction, type TickInputs } from '../src/step'
import { fieldFor } from '../src/flowfield'

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

    // **M1d Task 4's standing invariant, asserted on every tick of every
    // fixture that drives the real `step`: a car that is not in flight has a
    // zero blocked counter.** It holds by construction — the counter is raised
    // only at a crossing attempt, and the only ways out of flight (arrival,
    // trip end) are cursor-driven and therefore follow a crossing, which resets
    // it. It is worth a per-tick check anyway because it is what keeps this
    // task off the goldens: `determinism`, `rollback` and `startingCity` all
    // hash boards whose cars are idle, so a counter that leaked past trip end
    // would move three whole-buffer digests with no other symptom.
    for (let i = 0; i < r.state.carPhase.length; i++) {
      const p = r.state.carPhase[i] as number
      if (p === PHASE_OUTBOUND || p === PHASE_RETURNING) continue
      expect(r.state.carBlockedTicks[i], `car ${i} is not in flight on tick ${tick}`).toBe(0)
    }

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
    // **The one byte a refusal DOES write, as of Task 4**: car 1 has been
    // refused exactly once, so its consecutive-blocked-tick count is 1 — and
    // car 0, which crossed, is at 0. Asserted as the pair, because "the counter
    // moved" is also satisfied by a counter that moves for everybody.
    expect(r.state.carBlockedTicks[1]).toBe(1)
    expect(r.state.carBlockedTicks[0]).toBe(0)
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
  /**
   * `[destPins[0], SUM(destReserved), count(PHASE_OUTBOUND)]` at the end of each
   * tick.
   *
   * **The middle term is the sum over every destination, not `destReserved[0]`,
   * and the difference is invisible here on purpose.** Every fixture in this
   * file has exactly one destination, so the two coincide and no assertion
   * below can tell them apart — which is precisely why the sum is what gets
   * recorded. The invariant is `sum(destReserved) === count(PHASE_OUTBOUND)`,
   * and Task 4's ring fixture reuses this helper; a single-slot read would
   * silently stop checking the invariant the moment a fixture has two
   * destinations, with nothing in the diff to notice.
   */
  readonly reservations: [number, number, number][]
  /**
   * `carBlockedTicks` for each watched car at the END of each tick — M1d Task 4.
   *
   * Recorded per tick rather than read off `r.state` after the run for the same
   * reason `slots` is: the counter is reset by the crossing that ends the jam,
   * so a post-run read of a fixture whose valve has fired is all zeroes and
   * would silently assert nothing.
   */
  readonly blocked: number[][]
  maxCompletenessChecked: number
}

/**
 * Drives `runMovement` (plus `runArrivals` when asked) for `ticks` ticks,
 * asserting `assertOccupancyConsistent` after every one — both halves by
 * default.
 *
 * Tick numbering starts at 1 and is the loop index, not `H_TICK`: nothing here
 * runs `step`, so the clock never advances. Said out loud because every number
 * in this half of the file is a tick count rather than an absolute tick.
 *
 * **`complete: false` is Task 4's addition and it is opt-OUT, not opt-in**, so a
 * fixture has to say out loud that it is dropping the weaker half. The only
 * legitimate reason is the valve's stated residual: once the valve has
 * displaced a car, that car stands on a cell neither of whose slots names it,
 * and `assertOccupancyComplete` throws by design. The valve section drives its
 * fixtures in TWO calls for exactly this reason — the whole 1,350-tick jam with
 * completeness ON, and only the ticks from the firing onward with it off — so
 * the exemption covers the ticks that need it and not one tick more.
 */
function driveHand(
  r: Rig,
  watch: readonly Watch[],
  ticks: number,
  options: {
    readonly arrivals?: boolean
    readonly cells?: readonly number[]
    readonly complete?: boolean
  } = {},
): HandTrace {
  const cells = options.cells ?? []
  const checkComplete = options.complete ?? true
  const trace: HandTrace = {
    cell: [],
    progress: [],
    probe: [],
    slots: [],
    reservations: [],
    blocked: [],
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
      assertOccupancyConsistent(r.state, r.world, checkComplete),
    )
    trace.cell[tick] = watch.map((w) => r.state.carCell[w.i] as number)
    trace.progress[tick] = watch.map((w) => r.state.carProgress[w.i] as number)
    trace.blocked[tick] = watch.map((w) => r.state.carBlockedTicks[w.i] as number)
    const snap = new Map<number, [number, number]>()
    for (const c of cells) snap.set(c, slotsOf(r.state, c))
    trace.slots[tick] = snap
    let outbound = 0
    for (let i = 0; i < r.state.carPhase.length; i++) {
      if (r.state.carPhase[i] === PHASE_OUTBOUND) outbound++
    }
    let reserved = 0
    for (let d = 0; d < (r.state.header[H_DEST_COUNT] as number); d++) {
      reserved += r.state.destReserved[d] as number
    }
    trace.reservations[tick] = [r.state.destPins[0] as number, reserved, outbound]
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
    // caller is already switching on. **All four are now returned by `canEnter`:**
    // `ENTER_VALVE` was wired in Task 4 and `REFUSED_GHOST` in Task 5, which is
    // what the ghost section at the foot of this file exercises.
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

  it('throws by name for a DIRECTION that is not one of the eight, rather than answering "occupied"', () => {
    // The sibling of the cell guard, and it was missing until review round 2.
    // `LANE_OF_DIR[8]` is `undefined`, so `cell * 2 + undefined` is `NaN`,
    // `occupancy[NaN]` is `undefined`, `undefined === FREE` is false — and the
    // answer was `REFUSED_OCCUPIED` from a slot that does not exist, on a cell
    // that is completely free. That is the exact failure the cell guard's own
    // comment exists to prevent, reached through the other parameter.
    const r = makeRig('can-enter-bad-dir', 'can-enter-bad-dir')
    expect(slotsOf(r.state, 150)).toEqual([FREE, FREE]) // the cell really is free
    expect(() => canEnter(r.state, r.world, 0, 150, 8)).toThrow(/direction 8, which is not one of the eight/)
    expect(() => canEnter(r.state, r.world, 0, 150, -1)).toThrow(/not one of the eight/)
    expect(() => canEnter(r.state, r.world, 0, 150, 1.5)).toThrow(/not one of the eight/)
    // Both ends of the bound, so it is not off by one: 7 is a direction and 8
    // is not. Every valid direction answers ENTER_FREE on a free cell.
    for (let d = 0; d < 8; d++) {
      expect(canEnter(r.state, r.world, 0, 150, d), `dir ${d}`).toBe(EnterOutcome.ENTER_FREE)
    }
    // And directly, on the precedent of the cell guard beside it.
    expect(() => assertEnterDirValid(3, 150, 8)).toThrow(/car 3 .*cell 150 in direction 8/)
    expect(() => assertEnterDirValid(3, 150, 7)).not.toThrow()
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
    // The counter, and it is the ONE thing a refusal writes (Task 4): twelve
    // blocked ticks, twelve increments, still 1,338 short of the valve.
    expect(r.state.carBlockedTicks[1]).toBe(12)
    expect(r.state.carBlockedTicks[1]).toBeLessThan(MAX_BLOCKED_TICKS)
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
 *   x:        4     5     6     7     8     9 ...
 *   cell:   104   105   106   107   108   109
 *   car:      3     2     1     0     4    (free — car 4 leaves into it)
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

  it('joins the queue on the hand-computed tick for each car — 1, 3, 5, 7 — and not before', () => {
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
    // cell apart, and the carries it inherited keep it interacting. After tick
    // 17 the four carry 170 / 180 / 190 / 200: the first two need eight more
    // ticks and the last two need only seven, so cars 2 and 3 reach their
    // thresholds on tick 24, a tick before the cars in front of them move, and
    // are refused exactly once each.
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

  it('nothing in the buffer records a queue POSITION — the emergence claim, asserted', () => {
    // `carBlockedTicks` is the only region that could hold follower state, and
    // as of Task 4 it is written — so the emergence claim has to be made against
    // what it holds rather than against it being empty.
    //
    // **It holds a per-car DURATION, not a position in a line.** On tick 7 all
    // four are queued, having joined on ticks 1, 3, 5 and 7, so the counters
    // read 7, 5, 3, 1 — each car's own wait, descending with its place in the
    // queue purely because the car in front started waiting sooner. A queue
    // position would read 0, 1, 2, 3 and would be the same on every tick; these
    // numbers are different on every tick and are hand-derived from the join
    // ladder above, not read back.
    const r = queueRig('queue-emergent')
    const trace = driveHand(r, Q_WATCH, 25)
    for (let k = 0; k < 4; k++) {
      const joins = Q_JOINS_AT[k] as number
      expect(trace.blocked[Q_ALL_QUEUED_AT]![k], `car ${k}`).toBe(Q_ALL_QUEUED_AT - joins + 1)
    }
    expect(trace.blocked[Q_ALL_QUEUED_AT]!.slice(0, 4)).toEqual([7, 5, 3, 1])
    // The blocker never waited for anything, so its counter never left 0 —
    // which is what says the region is not simply "ticks alive".
    expect(trace.blocked[Q_ALL_QUEUED_AT]![4]).toBe(0)
    // And the cascade clears every one of them: a crossing resets the counter,
    // so after tick 9 the whole region is back to zero and stays there apart
    // from the platoon's single refused tick at 24 — which the platoon test
    // above attributes to cars 2 AND 3, both of which reach their thresholds a
    // tick before the cars in front of them move.
    expect(trace.blocked[Q_CLEARS_AT]!).toEqual([0, 0, 0, 0, 0])
    expect(trace.blocked[24]!).toEqual([0, 0, 1, 1, 0])
    expect(trace.blocked[25]!).toEqual([0, 0, 0, 0, 0])
    expect(Array.from(r.state.carBlockedTicks).every((v) => v === 0)).toBe(true)
    // Nobody came anywhere near the valve, which is what makes this a queue
    // rather than a jam.
    expect(Q_ALL_QUEUED_AT).toBeLessThan(MAX_BLOCKED_TICKS)
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

// ---------------------------------------------------------------------------
// 16. The anti-deadlock valve — M1d Task 4, Decision 6
// ---------------------------------------------------------------------------

/**
 * **The valve is a game mechanic, not a safety hack.** A car refused entry for
 * `MAX_BLOCKED_TICKS` = 45 s x 30 Hz = **1,350 consecutive ticks** moves anyway,
 * regardless of the occupant. That is what makes a gridlocked city GRIND rather
 * than freeze — legible and recoverable — and it is what guarantees no car is
 * ever stuck forever, which matters because a frozen car holds an occupancy
 * claim and a destination reservation and would starve that destination for the
 * rest of the run.
 *
 * ---------------------------------------------------------------------------
 * THE TICK ARITHMETIC, ONCE, AND EVERY NUMBER BELOW COMES FROM IT
 * ---------------------------------------------------------------------------
 *
 * `carBlockedTicks[i]` is the number of consecutive ticks car `i` HAS ALREADY
 * been refused. `canEnter` reads it BEFORE this tick's refusal is recorded, so
 * on the k-th refused tick it reads `k - 1`. Therefore:
 *
 *   tick 1 .. 1,350   counter reads 0 .. 1,349   -> REFUSED_OCCUPIED
 *   tick 1,351        counter reads 1,350        -> ENTER_VALVE
 *
 * for a car that reaches its threshold on tick 1. **The car waits exactly 1,350
 * ticks — exactly 45 s — and crosses on the next one.** "Blocked tick 1,350" in
 * the brief is the counter VALUE the valve fires at; the tick it fires on is
 * `MAX_BLOCKED_TICKS + 1` relative to the first refusal, and the two are written
 * as separate constants below so neither can be mistaken for the other.
 *
 * A car at `AT_THRESHOLD` = 2,500 - 330 = **2,170** progress units reaches its
 * threshold on tick 1 (2,170 + 330 = 2,500) and so has its first refusal there.
 * A car at 0 reaches it on tick 8 (330 x 8 = 2,640), seven ticks later — which
 * is how every staggered fixture here is built, because the stagger is a
 * property of the carry and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RING NEEDS NO TEST-ONLY DISABLE SEAM — AND WHY THERE IS ONE ANYWAY
 * ---------------------------------------------------------------------------
 *
 * **Ticks 1 to 1,350 of every fixture here ARE the no-valve world**, byte for
 * byte: the valve's only effect is at the comparison `counter >= 1,350`, which
 * is false throughout. So "the ring genuinely deadlocks without the valve" is
 * asserted by running it to the last refused tick and observing that not one
 * car, not one progress unit and not one occupancy slot has moved — no
 * production seam, no test-only flag, nothing that could rot.
 *
 * That argument is sound for 1,350 ticks and silent about 1,351 onward, so
 * there is a second arm that answers the stronger question — *is this deadlock
 * permanent, or merely long?* — by zeroing `carBlockedTicks` after every tick,
 * which is precisely the world a counter that did not persist would produce. It
 * runs 3,000 ticks and nothing moves. Both arms are test-side only; neither
 * adds a branch to `sim`.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RING CANNOT SHOW, AND WHY THERE IS A SECOND JAM FIXTURE
 * ---------------------------------------------------------------------------
 *
 * Decision 6's stated residual is *"the valve fires for car i into a slot held
 * by car j, and j does not move that tick"*. **A four-car ring cannot hold that
 * state open**: the first valve to fire vacates a cell, which breaks the cycle,
 * and every remaining car is granted within a tick or two. In the synchronised
 * ring the residual does not arise at all — the array is complete at the end of
 * the valve tick, with zero holes, exactly as Decision 6's trace predicts.
 *
 * So the persistent shared cell has its own fixture, and it needs a head car
 * that genuinely cannot move. There are only two immovable heads in this model:
 * a cycle (which self-heals) and a car whose route cursor is exhausted (which
 * `advanceCar` returns from before touching anything). The second is what
 * `sharedCellRig` uses, on the same precedent `parkedLeaderRig` above already
 * sets — it is a real in-flight car, standing on the cell its slot names, that
 * `runArrivals` has not been called to collect.
 */

/** The counter value the valve fires at — the spec's 45 s, from the constant. */
const VALVE_AT = MAX_BLOCKED_TICKS // 1,350
/** The tick it fires ON, for a car whose first refusal is tick 1. */
const VALVE_TICK = MAX_BLOCKED_TICKS + 1 // 1,351
/** The progress that puts a car exactly one tick short of an orthogonal crossing. */
const AT_THRESHOLD = ORTHO_THRESHOLD - SPEED // 2,170
/** Long enough that a valve-less world would have fired twice over. */
const NO_VALVE_TICKS = 3000

describe('MAX_BLOCKED_TICKS is the spec 45 s, and canEnter fires at exactly that value', () => {
  it('is derived from the clock and lands between the Uint8 trap and the Int16 ceiling', () => {
    expect(MAX_BLOCKED_TICKS).toBe(1350)
    // The two facts the region's width rests on, asserted rather than recited:
    // a Uint8 counter could never reach it, and an Int16 one has room to spare
    // even before the saturation makes overflow impossible.
    expect(MAX_BLOCKED_TICKS).toBeGreaterThan(255)
    expect(MAX_BLOCKED_TICKS).toBeLessThan(OCCUPANCY_MAX_CAR_INDEX)
    expect(VALVE_TICK).toBe(1351)
  })

  it('returns REFUSED_OCCUPIED at 1,349 and ENTER_VALVE at 1,350 — both sides of the exact edge', () => {
    // The whole exact-1,350 claim, asked of `canEnter` directly so nothing about
    // a drive can be what separates the two answers: one cell, one direction,
    // one occupant, and the counter as the only variable.
    //
    // This is the assertion that kills "valve at 1,349" (1,349 would answer
    // ENTER_VALVE) and "valve at 1,351" (1,350 would answer REFUSED_OCCUPIED).
    const r = makeRig('valve-edge', 'valve-edge')
    claimCell(r.state, 7, 150, DIR_E)
    for (const v of [0, 1, VALVE_AT - 2, VALVE_AT - 1]) {
      r.state.carBlockedTicks[3] = v
      expect(canEnter(r.state, r.world, 3, 150, DIR_E), `counter ${v}`).toBe(EnterOutcome.REFUSED_OCCUPIED)
    }
    for (const v of [VALVE_AT, VALVE_AT + 1, OCCUPANCY_MAX_CAR_INDEX]) {
      r.state.carBlockedTicks[3] = v
      expect(canEnter(r.state, r.world, 3, 150, DIR_E), `counter ${v}`).toBe(EnterOutcome.ENTER_VALVE)
    }
    // `>=`, not `===`: a counter above the threshold still fires. Unreachable
    // through `advanceCar` because the counter saturates, and pinned anyway so
    // that a future ceiling change cannot turn the valve off silently.
    expect(VALVE_AT + 1).toBeGreaterThan(VALVE_AT)
  })

  it('says ENTER_FREE, not ENTER_VALVE, when the slot is free — the valve is not a car state', () => {
    // The negative control the whole outcome enum exists for. A saturated
    // counter is not a licence to move; it is an answer about ONE slot. Under
    // "return ENTER_VALVE whenever the counter is saturated" this line flips,
    // and every ordinary crossing a jammed car makes afterwards would be
    // reported as a valve firing.
    const r = makeRig('valve-free-slot', 'valve-free-slot')
    r.state.carBlockedTicks[3] = VALVE_AT
    expect(canEnter(r.state, r.world, 3, 150, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
    claimCell(r.state, 7, 150, DIR_E)
    expect(canEnter(r.state, r.world, 3, 150, DIR_E)).toBe(EnterOutcome.ENTER_VALVE)
  })

  it('reads the ASKING car counter, not the occupant one — the valve is per car', () => {
    // Two cars asking the same question about the same slot, differing only in
    // whose counter is saturated. Kills "read carBlockedTicks[occupant]" and
    // every form of a single shared counter.
    const r = makeRig('valve-per-car', 'valve-per-car')
    claimCell(r.state, 7, 150, DIR_E)
    r.state.carBlockedTicks[3] = VALVE_AT
    r.state.carBlockedTicks[5] = 0
    r.state.carBlockedTicks[7] = 0
    expect(canEnter(r.state, r.world, 3, 150, DIR_E)).toBe(EnterOutcome.ENTER_VALVE)
    expect(canEnter(r.state, r.world, 5, 150, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    // And saturating the OCCUPANT does nothing for the asker.
    r.state.carBlockedTicks[7] = VALVE_AT
    expect(canEnter(r.state, r.world, 5, 150, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('is a pure query: asking does not advance the counter it reads', () => {
    // `driveHand`'s probe calls `canEnter` once per watched car per tick, so an
    // implementation that counted inside the query would double every figure in
    // this file — and the probe would change the answer it is there to record.
    const r = makeRig('valve-pure', 'valve-pure')
    claimCell(r.state, 7, 150, DIR_E)
    r.state.carBlockedTicks[3] = 41
    for (let k = 0; k < 5; k++) canEnter(r.state, r.world, 3, 150, DIR_E)
    expect(r.state.carBlockedTicks[3]).toBe(41)
  })
})

describe('the counter itself: one per refusal, saturating, cleared by any grant', () => {
  it('increments by exactly one and saturates AT the firing threshold, never above it', () => {
    // Called directly, on the precedent of `assertSingleCrossing` (cars.ts) and
    // the guards above: the ceiling is NOT production-reachable through
    // `runMovement`, because a counter that reaches 1,350 is answered
    // ENTER_VALVE on the very next tick and reset by the crossing.
    //
    // **Task 4 predicted that Task 5's `REFUSED_GHOST` would make it reachable
    // — a car refused by a ghost being refused while saturated, forever. Task 5
    // has landed and the prediction was wrong**, so it is corrected here rather
    // than left standing. `advanceCar` only ever asks `canEnter` about the next
    // cell of its own committed route, and `isCommittedTo` answers `true` for
    // that cell by construction (enumerated: 131,930 in-flight shapes, zero
    // exceptions — see the ghost section at the foot of this file), so
    // `runMovement` cannot produce a `REFUSED_GHOST` at all and no car can be
    // refused while saturated. The clamp stays a fail-closed guard whose only
    // observer is this direct call, and it stays for the reason it was written:
    // an unclamped Int16 counter would wrap negative after 32,767 consecutive
    // refusals and disarm the valve for that car forever, and nothing about the
    // present unreachability is guaranteed by anything a future task cannot
    // change.
    const r = makeRig('valve-counter', 'valve-counter')
    for (let k = 1; k <= 5; k++) {
      noteEntryRefused(r.state, 2)
      expect(r.state.carBlockedTicks[2]).toBe(k)
    }
    // Nobody else moved: the write is indexed by the car.
    expect(r.state.carBlockedTicks[1]).toBe(0)
    expect(r.state.carBlockedTicks[3]).toBe(0)

    r.state.carBlockedTicks[2] = VALVE_AT - 1
    noteEntryRefused(r.state, 2)
    expect(r.state.carBlockedTicks[2]).toBe(VALVE_AT)
    for (let k = 0; k < 10; k++) noteEntryRefused(r.state, 2)
    expect(r.state.carBlockedTicks[2]).toBe(VALVE_AT)
    // The ceiling and the firing threshold are the SAME constant, and that is
    // the property "lower the ceiling to 255" breaks: a ceiling below the
    // threshold makes the threshold unreachable and the valve never fires.
    expect(r.state.carBlockedTicks[2]).toBe(MAX_BLOCKED_TICKS)
  })

  it('is cleared by a grant, from any value, including a saturated one', () => {
    const r = makeRig('valve-reset', 'valve-reset')
    for (const v of [1, 7, VALVE_AT - 1, VALVE_AT]) {
      r.state.carBlockedTicks[4] = v
      noteEntryGranted(r.state, 4)
      expect(r.state.carBlockedTicks[4], `from ${v}`).toBe(0)
    }
    expect(r.state.carBlockedTicks[3]).toBe(0)
  })
})

// --- The exact firing tick, through a real drive -----------------------------

/** Row 5 cells the two jam fixtures below stand on. */
const V_HEAD = ROW5_X0 + 8 // 108 — the immovable head
const V_MID = ROW5_X0 + 7 // 107
const V_TAIL = ROW5_X0 + 6 // 106

/**
 * Two cars: a head with an EXHAUSTED cursor (which `advanceCar` returns from
 * before it touches anything, so it holds `V_HEAD` indefinitely) and a follower
 * one tick short of its threshold. The follower's first refusal is tick 1, so
 * its valve fires on tick `VALVE_TICK`.
 */
function valvePairRig(seed: string): Rig {
  const r = makeRig('valve-pair', seed)
  handCar(r, { i: 0, cell: V_HEAD, progress: 0, step: DIR_E, enteredBy: DIR_E, cursor: HAND_ROUTE_LEN })
  handCar(r, { i: 1, cell: V_MID, progress: AT_THRESHOLD, step: DIR_E, enteredBy: DIR_E })
  // Vacuity, before a single tick runs: the block is real, same-lane, and the
  // head is held by its CURSOR rather than by geometry — the cell in front of
  // it is free the whole time.
  expect(canEnter(r.state, r.world, 1, V_HEAD, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  expect(occupantOf(r.state, V_HEAD, LANE_OF_DIR[DIR_E] as number)).toBe(0)
  expect(canEnter(r.state, r.world, 0, V_HEAD + 1, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
  expect(r.state.carRouteCursor[0]).toBe(HAND_ROUTE_LEN)
  expect(assertOccupancyConsistent(r.state, r.world)).toBe(2)
  return r
}

const V_WATCH: readonly Watch[] = [
  { i: 0, dir: DIR_E },
  { i: 1, dir: DIR_E },
]

describe('the valve fires on the tick the counter reaches 1,350, and not one tick earlier', () => {
  it('is refused on all 1,350 ticks, with the counter equal to the tick number on every one', () => {
    const r = valvePairRig('valve-exact-jam')
    const jam = driveHand(r, V_WATCH, VALVE_AT, { cells: [V_MID, V_HEAD] })
    for (let tick = 1; tick <= VALVE_AT; tick++) {
      expect(jam.probe[tick]![1], `tick ${tick}`).toBe(EnterOutcome.REFUSED_OCCUPIED)
      expect(jam.cell[tick]![1], `tick ${tick}`).toBe(V_MID)
      expect(jam.progress[tick]![1], `tick ${tick}`).toBe(AT_THRESHOLD)
      expect(jam.blocked[tick]![1], `tick ${tick}`).toBe(tick)
      // The head never moves and never waits for anything.
      expect(jam.cell[tick]![0], `tick ${tick}`).toBe(V_HEAD)
      expect(jam.blocked[tick]![0], `tick ${tick}`).toBe(0)
    }
    // The last refused tick, stated as the two numbers that must differ: the
    // counter has REACHED the threshold and the car has still not moved,
    // because the counter is read before the refusal is recorded.
    expect(jam.blocked[VALVE_AT]![1]).toBe(VALVE_AT)
    expect(jam.cell[VALVE_AT]![1]).toBe(V_MID)
    // Occupancy is fully consistent for the whole jam — both cars, every tick.
    // The completeness half only lapses when the valve DISPLACES somebody.
    expect(jam.maxCompletenessChecked).toBe(2)
  })

  it('crosses on tick 1,351 with the outcome code ENTER_VALVE, not ENTER_FREE', () => {
    const r = valvePairRig('valve-exact-fire')
    driveHand(r, V_WATCH, VALVE_AT, { cells: [V_MID, V_HEAD] })
    // One more tick, and the completeness half comes off for it and it alone —
    // the valve is about to put two cars on one cell.
    const fire = driveHand(r, V_WATCH, 1, { cells: [V_MID, V_HEAD], complete: false })

    // **The outcome code, and it is the whole point of the enum.** The probe is
    // taken immediately before the tick and is exactly what `advanceCar` saw:
    // the head is immovable, so nothing can have changed between the two.
    expect(fire.probe[1]![1]).toBe(EnterOutcome.ENTER_VALVE)
    expect(fire.probe[1]![1]).not.toBe(EnterOutcome.ENTER_FREE)
    // ...and the slot really was still taken when it fired, so this is a
    // release-in-spite-of-an-occupant rather than a cell that quietly freed up.
    expect(fire.probe[1]![0]).toBe(EnterOutcome.ENTER_FREE) // the head, unrelated
    expect(r.state.carCell[0]).toBe(V_HEAD)

    // The crossing itself is an ORDINARY crossing: one cell, the hand-computed
    // carry, the cursor advanced by one, and the counter cleared.
    expect(fire.cell[1]![1]).toBe(V_HEAD)
    expect(fire.progress[1]![1]).toBe(AT_THRESHOLD + SPEED - ORTHO_THRESHOLD)
    expect(fire.progress[1]![1]).toBe(0)
    expect(r.state.carRouteCursor[1]).toBe(2)
    expect(fire.blocked[1]![1]).toBe(0)
  })

  it('is not vacuous: one tick short of the threshold the same car is still refused', () => {
    // The other side of the edge, driven rather than asked. Identical fixture,
    // one tick less: the counter reads 1,349 when `canEnter` is asked, and the
    // car is exactly where it started. Under "valve at 1,349" this fails.
    const r = valvePairRig('valve-one-short')
    const jam = driveHand(r, V_WATCH, VALVE_AT - 1, { cells: [V_MID] })
    expect(jam.blocked[VALVE_AT - 1]![1]).toBe(VALVE_AT - 1)
    expect(canEnter(r.state, r.world, 1, V_HEAD, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    const one = driveHand(r, V_WATCH, 1, { cells: [V_MID] })
    expect(one.probe[1]![1]).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(one.cell[1]![1]).toBe(V_MID)
    expect(one.blocked[1]![1]).toBe(VALVE_AT)
  })

  it('resets the wait: a car that valved is refused again at its very next crossing', () => {
    // The `noteEntryGranted` observer, and it is behavioural rather than a
    // counter read. Without the reset the car keeps its saturated counter and
    // the valve releases every subsequent crossing, so it would drive straight
    // through the head car eight ticks later instead of queueing behind it.
    const r = valvePairRig('valve-resets')
    driveHand(r, V_WATCH, VALVE_TICK, { complete: false })
    expect(r.state.carCell[1]).toBe(V_HEAD) // it valved onto the head cell
    // Eight more ticks: it reaches its next threshold and asks about V_HEAD + 1,
    // which is free — so park a car there to make the question a refusal.
    handCar(r, { i: 2, cell: V_HEAD + 1, progress: 0, step: DIR_E, enteredBy: DIR_E, cursor: HAND_ROUTE_LEN })
    const after = driveHand(r, V_WATCH, 8, { complete: false })
    expect(after.probe[8]![1]).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(after.cell[8]![1]).toBe(V_HEAD)
    expect(after.blocked[8]![1]).toBe(1)
  })
})

// --- The shared cell: Decision 6's residual, asserted as reachable -----------

/**
 * Three cars in a line, all eastbound, all same-lane:
 *
 *   car 0 @ 106, carry 2,170  -> first refusal tick 1,     valve tick 1,351
 *   car 1 @ 107, carry 0      -> first refusal tick 8,     valve tick 1,358
 *   car 2 @ 108, cursor spent -> never moves at all
 *
 * The seven-tick stagger is the carry and nothing else, and it is what makes
 * the residual observable: car 0's valve fires while car 1 is still standing on
 * the cell it enters, and car 1 is still blocked for another seven ticks after
 * that.
 */
function sharedCellRig(seed: string): Rig {
  const r = makeRig('valve-shared', seed)
  handCar(r, { i: 0, cell: V_TAIL, progress: AT_THRESHOLD, step: DIR_E, enteredBy: DIR_E })
  handCar(r, { i: 1, cell: V_MID, progress: 0, step: DIR_E, enteredBy: DIR_E })
  handCar(r, { i: 2, cell: V_HEAD, progress: 0, step: DIR_E, enteredBy: DIR_E, cursor: HAND_ROUTE_LEN })
  // Both blocks are SAME-LANE, which is the only kind the valve exists for: a
  // head-on pair resolves by Decision 1 and would prove nothing.
  expect(LANE_OF_DIR[DIR_E]).toBe(0)
  expect(occupantOf(r.state, V_MID, LANE_OF_DIR[DIR_E] as number)).toBe(1)
  expect(occupantOf(r.state, V_HEAD, LANE_OF_DIR[DIR_E] as number)).toBe(2)
  expect(assertOccupancyConsistent(r.state, r.world)).toBe(3)
  return r
}

const SC_WATCH: readonly Watch[] = [
  { i: 0, dir: DIR_E },
  { i: 1, dir: DIR_E },
  { i: 2, dir: DIR_E },
]
const SC_CELLS = [V_TAIL, V_MID, V_HEAD, V_HEAD + 1] as const
/** Car 1's carry is 0, so its threshold is tick 8 and its valve is seven later. */
const SC_SECOND_VALVE = 8
/** Car 1 crosses off the shared head cell eight ticks after valving onto it. */
const SC_GAP_AT = SC_SECOND_VALVE + 8 // 16, i.e. absolute 1,366
/** Car 0 takes the vacated head cell on the next tick. */
const SC_REFILL_AT = SC_GAP_AT + 1 // 17, i.e. absolute 1,367

describe('two cars share a cell after the valve, and the array stays SOUND throughout', () => {
  it('puts the valve car and the car it displaced on one cell, with the slot naming the ENTRANT', () => {
    const r = sharedCellRig('shared-valve-tick')
    const jam = driveHand(r, SC_WATCH, VALVE_AT, { cells: SC_CELLS })
    // Nothing has shared anything yet: completeness held on all 1,350 ticks.
    expect(jam.maxCompletenessChecked).toBe(3)
    expect(jam.blocked[VALVE_AT]).toEqual([VALVE_AT, VALVE_AT - 7, 0])

    const fire = driveHand(r, SC_WATCH, 1, { cells: SC_CELLS, complete: false })

    // **Two cars on one cell — REACHABLE, and this is the assertion that says
    // so.** Not "they have equal carCell and something is odd": the exact
    // contents of all three cells are pinned.
    expect(r.state.carCell[0]).toBe(V_MID)
    expect(r.state.carCell[1]).toBe(V_MID)
    expect(fire.slots[1]!.get(V_MID)).toEqual([0, FREE])
    expect(fire.slots[1]!.get(V_TAIL)).toEqual([FREE, FREE])
    expect(fire.slots[1]!.get(V_HEAD)).toEqual([2, FREE])
    // The slot names the MOST RECENT entrant, because `claimCell` overwrites
    // unconditionally. That is the whole of what the array can say: it holds one
    // car per (cell, lane) and there are now two cars in one (cell, lane).
    expect(occupantOf(r.state, V_MID, 0)).toBe(0)
    expect(occupantOf(r.state, V_MID, 1)).toBe(FREE)

    // SOUNDNESS holds — the slot names a car that IS standing there.
    assertOccupancySound(r.state, r.world)
    // COMPLETENESS does not, for the displaced car and only for it. Asserted by
    // the throw and by its message, so "something threw" cannot pass for "the
    // documented residual happened to the documented car".
    expect(() => assertOccupancyComplete(r.state, r.world)).toThrow(
      /car 1 has crossed on its current leg and stands on cell 107/,
    )
    expect(hasCrossedThisLeg(r.state, 1)).toBe(true)
    // And car 1 is not merely unnamed, it is still genuinely BLOCKED: its own
    // valve is seven ticks away.
    expect(fire.probe[1]![1]).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(fire.blocked[1]![1]).toBe(VALVE_AT - 6)
  })

  it('leaves the array correct when the DISPLACED car departs — the guarded release does nothing', () => {
    // The first of the two departures from a shared cell, and it is the
    // self-healing one Decision 6 traces. Car 1's valve fires on relative tick
    // 8; it releases `V_MID`, whose lane 0 names car 0 — so the guard fails,
    // correctly, and car 0 keeps the slot it is standing on.
    //
    // Under UNCONDITIONAL release this is where the array corrupts: `V_MID`
    // would read FREE with car 0 standing on it, and the cell would stop
    // blocking for the rest of the run.
    const r = sharedCellRig('shared-displaced-departs')
    driveHand(r, SC_WATCH, VALVE_AT, { cells: SC_CELLS })
    const after = driveHand(r, SC_WATCH, SC_SECOND_VALVE, { cells: SC_CELLS, complete: false })

    expect(after.probe[SC_SECOND_VALVE]![1]).toBe(EnterOutcome.ENTER_VALVE)
    expect(r.state.carCell[0]).toBe(V_MID)
    expect(r.state.carCell[1]).toBe(V_HEAD)
    // `V_MID` still names car 0, which is still standing on it: no hole.
    expect(after.slots[SC_SECOND_VALVE]!.get(V_MID)).toEqual([0, FREE])
    // And the residual has simply MOVED one cell along: cars 1 and 2 now share
    // the head cell, with the slot naming the entrant again.
    expect(r.state.carCell[2]).toBe(V_HEAD)
    expect(after.slots[SC_SECOND_VALVE]!.get(V_HEAD)).toEqual([1, FREE])
    assertOccupancySound(r.state, r.world)
    expect(() => assertOccupancyComplete(r.state, r.world)).toThrow(
      /car 2 has crossed on its current leg and stands on cell 108/,
    )
  })

  it('opens a transient hole when the DISPLACING car departs, and the next entrant closes it', () => {
    // The second departure, and the one that costs something. Car 1 crosses off
    // the head cell on relative tick 16; its guarded release SUCCEEDS this time
    // (the slot names it), so cell 108 reads FREE with car 2 standing on it.
    //
    // **That is the documented price of one car per (cell, lane), and it is a
    // completeness gap, never a soundness violation.** Stated in both
    // directions: nothing false is recorded, and one true thing is missing.
    const r = sharedCellRig('shared-displacer-departs')
    driveHand(r, SC_WATCH, VALVE_AT, { cells: SC_CELLS })
    const after = driveHand(r, SC_WATCH, SC_REFILL_AT, { cells: SC_CELLS, complete: false })

    // Car 0 was refused on every tick between its own valve and this one — the
    // reset really did put it back at the end of the queue.
    expect(after.blocked[SC_GAP_AT]![0]).toBe(8)
    expect(after.cell[SC_GAP_AT]![1]).toBe(V_HEAD + 1)
    expect(after.cell[SC_GAP_AT]![2]).toBe(V_HEAD)
    // THE HOLE: both slots free, a car standing on the cell.
    expect(after.slots[SC_GAP_AT]!.get(V_HEAD)).toEqual([FREE, FREE])
    // ...which is observable as the cell answering ENTER_FREE with car 2 on it.
    // This is the honest statement of the cost: for these ticks that cell does
    // not block. It is bounded by the next entry, which is the very next tick.
    expect(after.probe[SC_REFILL_AT]![0]).toBe(EnterOutcome.ENTER_FREE)

    // THE CLOSE: car 0 enters and the slot names a car that is there again.
    expect(after.cell[SC_REFILL_AT]![0]).toBe(V_HEAD)
    expect(after.slots[SC_REFILL_AT]!.get(V_HEAD)).toEqual([0, FREE])
    assertOccupancySound(r.state, r.world)
    // Car 2 is still unnamed, and that is the part Decision 6's "the next
    // entrant overwrites it back into a correct state" does not cover: the SLOT
    // recovers, the displaced car's namedness does not, until it crosses again.
    // It never will here — its cursor is spent — so the throw is permanent for
    // this fixture and is asserted as such rather than waited out.
    expect(() => assertOccupancyComplete(r.state, r.world)).toThrow(
      /car 2 has crossed on its current leg and stands on cell 108/,
    )
  })
})

// --- The four-car gridlock ring ---------------------------------------------

/**
 * **The cycle of length 4 the valve actually exists for.** Four cells in a 2x2
 * square, four cars, each one blocked by the next, all four blocks SAME-LANE:
 *
 *      110 --E--> 111          car 0 on 110 heading E, entered by N (lane 1)
 *       ^          |           car 1 on 111 heading S, entered by E (lane 0)
 *       N          S           car 2 on 131 heading W, entered by S (lane 0)
 *       |          v           car 3 on 130 heading N, entered by W (lane 1)
 *      130 <--W-- 131
 *
 * Each car entered its cell by the step of the car BEHIND it, which is what a
 * convoy that has closed a loop looks like — so the geometry is a real one, not
 * four cars posed in a square.
 *
 * **Same-lane, and no pair of it is head-on.** `LANE_OF_DIR` is 0 for E and S
 * and 1 for W and N, so each car wants exactly the lane the car in front is
 * holding: E into a cell held by an E-entrant, S into an S-entrant, W into a
 * W-entrant, N into an N-entrant. And no car's direction of travel is the
 * OPPOSITE of its blocker's — the two opposed directions in the ring, E and W,
 * belong to cars 0 and 2, which are diagonally across the square and never ask
 * each other anything. A ring with a head-on pair in it resolves by Decision 1
 * in one tick and would prove nothing; both facts are asserted below rather
 * than read off this diagram.
 *
 * **The routes are only three steps long.** Each car has two crossings left,
 * which is enough to leave the ring and prove it was not starved, and stops it
 * walking to the board edge later in the run where `stepCell` would throw.
 *
 * **Two destinations, and that is deliberate.** The invariant
 * `sum(destReserved) === count(PHASE_OUTBOUND)` must hold throughout the jam,
 * and with one destination the sum and `destReserved[0]` coincide so a
 * single-slot read would look identical. Here they differ — 2 against 4 — which
 * is asserted, so the helper's sum is doing work a slot read could not.
 */
const RING_CELL = [110, 111, 131, 130] as const
const RING_DIR = [DIR_E, DIR_S, DIR_W, DIR_N] as const
const RING_ENTERED = [DIR_N, DIR_E, DIR_S, DIR_W] as const
const RING_ROUTE_LEN = 3
/** The second destination's origin: (2,0), orientation S, carpark (2,3). */
const RING_DEST2_ORIGIN = 2
const RING_WATCH: readonly Watch[] = [
  { i: 0, dir: DIR_E },
  { i: 1, dir: DIR_S },
  { i: 2, dir: DIR_W },
  { i: 3, dir: DIR_N },
]
/** Where each car stands after its first crossing, and after its second. */
const RING_AFTER_1 = [111, 131, 130, 110] as const
const RING_AFTER_2 = [112, 151, 129, 90] as const
/** Eight ticks after a crossing with carry 0, the next threshold is reached. */
const RING_SECOND_CROSSING = 8

function ringRig(seed: string, progresses: readonly number[]): Rig {
  const r = makeRig('valve-ring', seed)
  expect(placeDestination(r.state, r.world, DEST_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeDestination(r.state, r.world, RING_DEST2_ORIGIN, ORIENTATION_S, 1, DEST_KIND_SQUARE)).toBe(true)
  expect(r.state.header[H_DEST_COUNT]).toBe(2)
  for (let k = 0; k < 4; k++) {
    handCar(r, {
      i: k,
      cell: RING_CELL[k] as number,
      progress: progresses[k] as number,
      step: RING_DIR[k] as number,
      enteredBy: RING_ENTERED[k] as number,
      routeLen: RING_ROUTE_LEN,
    })
    r.state.carTargetDest[k] = k < 2 ? 0 : 1
  }
  // Two cars reserved against each destination, so the SUM is 4 and neither
  // slot alone is.
  r.state.destReserved[0] = 2
  r.state.destReserved[1] = 2
  return r
}

/** `[sum(destReserved), count(PHASE_OUTBOUND)]`, the invariant's two sides. */
const RING_BALANCE: readonly [number, number, number] = [0, 4, 4]

describe('a gridlocked ring of four cars: same-lane, no head-on pair, genuinely circular', () => {
  it('is a real 4-cycle in which every car wants exactly the lane the next one holds', () => {
    // The brief's vacuity self-check, and the fixture rests entirely on it.
    const r = ringRig('ring-shape', [AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD])
    for (let k = 0; k < 4; k++) {
      const next = (k + 1) % 4
      // The step really lands on the next car's cell.
      expect(stepCell(RING_CELL[k] as number, RING_DIR[k] as number, r.world.w, r.world.h), `car ${k}`).toBe(
        RING_CELL[next] as number,
      )
      // ...and the lane it wants there is the lane that car is holding. This is
      // the SAME-LANE assertion: it is what makes the block real rather than
      // two cars that merely happen to be adjacent.
      const wantedLane = LANE_OF_DIR[RING_DIR[k] as number] as number
      expect(occupantOf(r.state, RING_CELL[next] as number, wantedLane), `car ${k}`).toBe(next)
      expect(LANE_OF_DIR[RING_ENTERED[next] as number]).toBe(wantedLane)
      // No block in this ring is a head-on: a head-on pair resolves in one tick
      // by Decision 1 and the ring would never deadlock at all.
      expect(RING_DIR[k], `car ${k} is head-on with its blocker`).not.toBe(
        OPPOSITE[RING_DIR[next] as number] as number,
      )
      // ...and it is refused, right now, with a cold counter.
      expect(r.state.carBlockedTicks[k]).toBe(0)
      expect(canEnter(r.state, r.world, k, RING_CELL[next] as number, RING_DIR[k] as number)).toBe(
        EnterOutcome.REFUSED_OCCUPIED,
      )
    }
    // Both lanes are represented, so the ring is not accidentally a
    // single-lane corridor bent into a square.
    expect(RING_DIR.map((d) => LANE_OF_DIR[d] as number)).toEqual([0, 0, 1, 1])
    expect(new Set(RING_CELL).size).toBe(4)
    expect(assertOccupancyConsistent(r.state, r.world)).toBe(4)
    // The reservation invariant, and the proof that the SUM is load-bearing
    // here: `destReserved[0]` alone is 2 against 4 outbound cars.
    expect(reservationBalance(r)).toEqual([4, 4])
    expect(r.state.destReserved[0]).toBe(2)
    expect(r.state.destReserved[0]).not.toBe(4)
  })

  it('deadlocks for all 1,350 ticks, and the byte-identity proves it deadlocks FOREVER', () => {
    // **This IS the no-valve world**, byte for byte: the valve's only effect is
    // the comparison `counter >= 1,350`, which is false on every one of these
    // ticks. No test-only disable seam is needed to establish it.
    //
    // **And the byte-identity below is not a restatement of the per-tick
    // assertions — it is the inductive step.** The per-tick loop says nothing
    // moved during the window; the buffer comparison says the state at the end
    // of tick 1,350 is IDENTICAL to the state before tick 1, once the four
    // counters are set aside. Those counters are write-only in the no-valve
    // world — nothing reads `carBlockedTicks` except the valve comparison — and
    // `runMovement` is a pure function of the buffer. So tick 1,351 of a
    // valve-less world would be handed exactly the input tick 1 was handed and
    // would produce exactly the same output, and so on without end. **The ring
    // deadlocks permanently, and this one assertion is the whole proof.**
    //
    // The 3,000-tick arm below is therefore CORROBORATION, not the load-bearing
    // evidence, and it is worth keeping for what an induction cannot give: it
    // exercises the real `runMovement` over a window three times longer than
    // this one and would catch any way the premise is false — a hidden reader
    // of the counter, an accumulator elsewhere in the buffer, a non-determinism
    // in the loop — rather than assuming the premise.
    const r = ringRig('ring-deadlock', [AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD])
    const before = new Uint8Array(r.state.buffer).slice()
    const jam = driveHand(r, RING_WATCH, VALVE_AT, { cells: RING_CELL })

    for (let tick = 1; tick <= VALVE_AT; tick++) {
      expect(jam.cell[tick], `tick ${tick}`).toEqual([...RING_CELL])
      expect(jam.progress[tick], `tick ${tick}`).toEqual([AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD])
      expect(jam.probe[tick], `tick ${tick}`).toEqual([
        EnterOutcome.REFUSED_OCCUPIED,
        EnterOutcome.REFUSED_OCCUPIED,
        EnterOutcome.REFUSED_OCCUPIED,
        EnterOutcome.REFUSED_OCCUPIED,
      ])
      expect(jam.blocked[tick], `tick ${tick}`).toEqual([tick, tick, tick, tick])
      // Nothing anywhere consumed a pin or a reservation while the jam ran.
      expect(jam.reservations[tick], `tick ${tick}`).toEqual([...RING_BALANCE])
    }
    // Occupancy is fully consistent throughout — the jam itself never displaces
    // anybody, so both halves hold on all 1,350 ticks.
    expect(jam.maxCompletenessChecked).toBe(4)

    // **THE INDUCTIVE STEP: the whole buffer is byte-identical apart from the
    // four counters.** 1,350 ticks of a four-car gridlock cost exactly eight
    // bytes of state, and the state `runMovement` would be handed on tick 1,351
    // of a valve-less world is bit-for-bit the state it was handed on tick 1.
    r.state.carBlockedTicks.fill(0)
    expect(new Uint8Array(r.state.buffer)).toEqual(before)
    // The premise the induction rests on, asserted rather than assumed: the
    // counter is the ONLY region that moved, so it is the only thing that could
    // carry information out of the window.
    expect(jam.blocked[VALVE_AT]).toEqual([VALVE_AT, VALVE_AT, VALVE_AT, VALVE_AT])
  })

  it('corroborates that permanence over 3,000 real ticks with the counter held cold', () => {
    // The induction above is the proof; this is the arm that would catch its
    // PREMISE being false — a hidden reader of the counter, an accumulator
    // elsewhere in the buffer, a non-determinism in the loop — by driving the
    // real `runMovement` over a window more than twice the valve period rather
    // than reasoning about it.
    //
    // Zeroing the counter after every tick is exactly the world a counter that
    // did not persist would produce, which is also why this doubles as the
    // behavioural form of "put the counter on Scratch". Test-side only: no
    // branch is added to `sim` and there is nothing here that can rot into
    // production.
    const r = ringRig('ring-no-valve', [AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD])
    const before = new Uint8Array(r.state.buffer).slice()
    for (let tick = 1; tick <= NO_VALVE_TICKS; tick++) {
      runMovement(r.state, r.world)
      r.state.carBlockedTicks.fill(0)
      assertOccupancySound(r.state, r.world)
    }
    expect(Array.from(r.state.carCell.subarray(0, 4))).toEqual([...RING_CELL])
    expect(new Uint8Array(r.state.buffer)).toEqual(before)
    // Two full valve periods and then some, so "it would have fired by now" is
    // not a matter of opinion.
    expect(NO_VALVE_TICKS).toBeGreaterThan(2 * VALVE_TICK)
  })

  it('releases all four on tick 1,351, and the array self-heals with ZERO holes', () => {
    // Decision 6's traced end state, executed. Processed ascending: car 0
    // clears its own slot on 110 and overwrites 111's; car 1's guarded clear on
    // 111 now correctly FAILS and it overwrites 131's; and so on. The last car
    // finds 110 already free, because car 0 vacated it earlier in this same
    // tick — so it crosses on ENTER_FREE, not on the valve.
    //
    // **Completeness is asserted straight through the firing**, which is the
    // sharpest statement available that this ring never produces the residual:
    // no `complete: false` anywhere in this test.
    const r = ringRig('ring-fires', [AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD])
    const jam = driveHand(r, RING_WATCH, VALVE_AT, { cells: RING_CELL })
    expect(jam.blocked[VALVE_AT]).toEqual([VALVE_AT, VALVE_AT, VALVE_AT, VALVE_AT])
    const fire = driveHand(r, RING_WATCH, 1, { cells: RING_CELL })

    // All four were saturated when the tick began, so all four were entitled.
    expect(fire.probe[1]).toEqual([
      EnterOutcome.ENTER_VALVE,
      EnterOutcome.ENTER_VALVE,
      EnterOutcome.ENTER_VALVE,
      EnterOutcome.ENTER_VALVE,
    ])
    // **None starves**: every one of the four moved, on the same tick.
    expect(fire.cell[1]).toEqual([...RING_AFTER_1])
    expect(fire.progress[1]).toEqual([0, 0, 0, 0])
    expect(fire.blocked[1]).toEqual([0, 0, 0, 0])
    for (let k = 0; k < 4; k++) expect(r.state.carRouteCursor[k], `car ${k}`).toBe(2)

    // **Every cell named by exactly the car standing on it, zero holes.** The
    // lane each car now holds is the lane of the direction it TRAVELLED, which
    // is why 110 and 130 name their cars in lane 1 and 111 and 131 in lane 0.
    expect(fire.slots[1]!.get(110)).toEqual([FREE, 3])
    expect(fire.slots[1]!.get(111)).toEqual([0, FREE])
    expect(fire.slots[1]!.get(131)).toEqual([1, FREE])
    expect(fire.slots[1]!.get(130)).toEqual([FREE, 2])
    expect(fire.maxCompletenessChecked).toBe(4)
    // Under UNCONDITIONAL release this is the test that fires: three of the
    // four cells would read FREE with a car standing on each, and the
    // completeness half would throw on the same tick.
    expect(fire.reservations[1]).toEqual([...RING_BALANCE])

    // The ring dissolves rather than re-forming: eight ticks later all four
    // cross again, onto four cells none of them shares.
    const on = driveHand(r, RING_WATCH, RING_SECOND_CROSSING, { cells: RING_CELL })
    expect(on.cell[RING_SECOND_CROSSING]).toEqual([...RING_AFTER_2])
    expect(on.maxCompletenessChecked).toBe(4)
    for (let k = 0; k < 4; k++) expect(r.state.carBlockedTicks[k], `car ${k}`).toBe(0)
  })

  it('needs only ONE valve to unwind: the car behind the vacated cell crosses on ENTER_FREE', () => {
    // The same ring with the other three cars one tick behind car 0, so on the
    // firing tick their counters read 1,349 — one short. Car 3 crosses anyway,
    // because car 0 vacated cell 110 earlier in the same tick.
    //
    // **This is the direct observation that `ENTER_VALVE` and `ENTER_FREE` are
    // different answers rather than one answer with two names**: car 3 moved
    // with an UNSATURATED counter, which the valve cannot explain.
    const r = ringRig('ring-one-valve', [AT_THRESHOLD, 1840, 1840, 1840])
    // The stagger, derived: 1,840 + 330 x 2 = 2,500, so their first refusal is
    // tick 2 and their counters run one behind car 0's for the whole jam.
    expect(1840 + 2 * SPEED).toBe(ORTHO_THRESHOLD)
    const jam = driveHand(r, RING_WATCH, VALVE_AT, { cells: RING_CELL })
    expect(jam.blocked[VALVE_AT]).toEqual([VALVE_AT, VALVE_AT - 1, VALVE_AT - 1, VALVE_AT - 1])
    expect(jam.cell[VALVE_AT]).toEqual([...RING_CELL])

    // Tick 1,351. Car 0 valves; car 3 follows it through the cell it vacated.
    // Cars 1 and 2 are still blocked, so car 0 lands on top of car 1 and the
    // residual appears for one tick.
    const fire = driveHand(r, RING_WATCH, 1, { cells: RING_CELL, complete: false })
    expect(fire.cell[1]).toEqual([111, 111, 131, 110])
    expect(jam.blocked[VALVE_AT]![3]).toBeLessThan(MAX_BLOCKED_TICKS)
    expect(fire.blocked[1]![3]).toBe(0) // it crossed, so its wait was cleared
    expect(fire.slots[1]!.get(110)).toEqual([FREE, 3])
    expect(fire.slots[1]!.get(111)).toEqual([0, FREE])
    // Cars 1 and 2 did not move and their counters ticked on to saturation.
    expect(fire.blocked[1]![1]).toBe(VALVE_AT)
    expect(fire.blocked[1]![2]).toBe(VALVE_AT)
    assertOccupancySound(r.state, r.world)
    expect(() => assertOccupancyComplete(r.state, r.world)).toThrow(
      /car 1 has crossed on its current leg and stands on cell 111/,
    )

    // Tick 1,352: car 1 valves out of the shared cell and car 2 follows into
    // the cell car 3 vacated. The residual closes on the very next tick and
    // completeness is asserted ON to say so.
    const rest = driveHand(r, RING_WATCH, 1, { cells: RING_CELL })
    expect(rest.cell[1]).toEqual([...RING_AFTER_1])
    expect(rest.maxCompletenessChecked).toBe(4)
    expect(rest.slots[1]!.get(111)).toEqual([0, FREE])
    // **None starves**: all four have moved within two ticks of the first valve.
    for (let k = 0; k < 4; k++) expect(r.state.carRouteCursor[k], `car ${k}`).toBe(2)
  })
})

// --- The counter is hashed state: a mid-jam snapshot replays identically -----

/** The tick the mid-jam snapshot is taken on — deep inside the jam, well before the valve. */
const SNAP_TICK = 700
/** Ticks driven after the snapshot, in both the original and the replay. */
const REPLAY_TICKS = 660
/** The valve's tick, counted from the snapshot rather than from tick 1. */
const REPLAY_VALVE_AT = VALVE_TICK - SNAP_TICK // 651

describe('carBlockedTicks is buffer state, so a Worker cold-starting a replay valves identically', () => {
  it('reproduces the run byte for byte, and fires the valve on the same ABSOLUTE tick', () => {
    // The divergence this product exists to prevent, in its exact shape: a
    // counter that did not survive the snapshot would fire in the browser and
    // not in the Worker, and nothing else in the suite would see it.
    //
    // Built with `fields` and `scratch` COLD-REBUILT on the restore, as
    // `loop.test.ts` does, because that is what a Worker cold-starting a replay
    // actually holds.
    const r = ringRig('ring-snapshot', [AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD])
    driveHand(r, RING_WATCH, SNAP_TICK, { cells: RING_CELL })

    // Vacuity BEFORE: the snapshot is genuinely mid-jam, with a counter that is
    // neither cold nor saturated. Snapshotting a fixture at rest would prove
    // nothing about the counter at all.
    expect(Array.from(r.state.carBlockedTicks.subarray(0, 4))).toEqual([
      SNAP_TICK,
      SNAP_TICK,
      SNAP_TICK,
      SNAP_TICK,
    ])
    expect(SNAP_TICK).toBeGreaterThan(0)
    expect(SNAP_TICK).toBeLessThan(VALVE_AT)
    const hashAtSnapshot = hashState(r.state)
    const snap = snapshot(r.state)

    // The uninterrupted run, through the valve and out the other side.
    const original = driveHand(r, RING_WATCH, REPLAY_TICKS, { cells: RING_CELL })
    const finalHash = hashState(r.state)
    const finalCells = Array.from(r.state.carCell.subarray(0, 4))
    expect(original.cell[REPLAY_VALVE_AT - 1]).toEqual([...RING_CELL]) // still jammed
    expect(original.cell[REPLAY_VALVE_AT]).toEqual([...RING_AFTER_1]) // fired here
    expect(SNAP_TICK + REPLAY_VALVE_AT).toBe(VALVE_TICK)
    // Vacuity AFTER: the timeline genuinely moved on from the snapshot.
    expect(finalHash).not.toBe(hashAtSnapshot)

    // The cold start: a fresh state over the snapshotted bytes, and derived
    // state rebuilt from nothing.
    const cold: Rig = {
      state: restore(snap, r.world),
      world: r.world,
      map: r.map,
      scratch: createScratch(
        r.world.cells,
        r.map.groupCount,
        r.map.maxDestinations,
        createFieldInputRanges(r.map),
      ),
      fields: createFlowFields(r.map.groupCount, r.world.cells),
    }
    expect(cold.scratch).not.toBe(r.scratch) // the rebuild really is a rebuild
    expect(cold.fields).not.toBe(r.fields)
    expect(hashState(cold.state)).toBe(hashAtSnapshot)

    const replay = driveHand(cold, RING_WATCH, REPLAY_TICKS, { cells: RING_CELL })
    expect(hashState(cold.state)).toBe(finalHash)
    expect(Array.from(cold.state.carCell.subarray(0, 4))).toEqual(finalCells)
    // **The same ABSOLUTE tick, not merely the same final bytes.** The valve
    // fires 651 ticks after the restore, which is tick 1,351 of the run.
    expect(replay.cell[REPLAY_VALVE_AT - 1]).toEqual([...RING_CELL])
    expect(replay.cell[REPLAY_VALVE_AT]).toEqual([...RING_AFTER_1])
    expect(replay.blocked[REPLAY_VALVE_AT - 1]).toEqual([VALVE_AT, VALVE_AT, VALVE_AT, VALVE_AT])
  })

  it('is not vacuous: a replay that LOSES the counter stays jammed past the valve tick', () => {
    // The counterfactual, and it is the arm that makes the test above evidence
    // rather than an observation about a run that would have matched anyway.
    // Zeroing `carBlockedTicks` immediately after the restore is exactly what a
    // Scratch-resident or otherwise off-buffer counter hands a cold-starting
    // Worker — `runMovement` takes no `scratch` argument and module-scope
    // mutable state is banned by lint, so this is the only constructible form
    // of that mutation, and it is test-side.
    const r = ringRig('ring-snapshot-lost', [AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD, AT_THRESHOLD])
    driveHand(r, RING_WATCH, SNAP_TICK, { cells: RING_CELL })
    const snap = snapshot(r.state)
    driveHand(r, RING_WATCH, REPLAY_TICKS, { cells: RING_CELL })
    const finalHash = hashState(r.state)

    const lost: Rig = {
      state: restore(snap, r.world),
      world: r.world,
      map: r.map,
      scratch: createScratch(
        r.world.cells,
        r.map.groupCount,
        r.map.maxDestinations,
        createFieldInputRanges(r.map),
      ),
      fields: createFlowFields(r.map.groupCount, r.world.cells),
    }
    lost.state.carBlockedTicks.fill(0)

    const replay = driveHand(lost, RING_WATCH, REPLAY_TICKS, { cells: RING_CELL })
    // Still jammed on the tick the real run valved on, and still jammed at the
    // end of the window: its counters restarted from zero and are 660 short.
    expect(replay.cell[REPLAY_VALVE_AT]).toEqual([...RING_CELL])
    expect(replay.cell[REPLAY_TICKS]).toEqual([...RING_CELL])
    expect(Array.from(lost.state.carBlockedTicks.subarray(0, 4))).toEqual([
      REPLAY_TICKS,
      REPLAY_TICKS,
      REPLAY_TICKS,
      REPLAY_TICKS,
    ])
    expect(hashState(lost.state)).not.toBe(finalHash)
  })
})

// ---------------------------------------------------------------------------
// M1d TASK 5 — REFUSED_GHOST
// ---------------------------------------------------------------------------

/**
 * **`REFUSED_GHOST` is not reachable through `runDispatch` + `runMovement`, and
 * that is a property of the design rather than a gap in these fixtures.**
 *
 * The two halves of its condition cannot both hold on the reachable manifold.
 * `eraseRoad` clears the live road bits before it ghosts the cell, so
 * `dist[cell]` is INF and **no route committed after the erase can contain it**
 * (asserted below, directly, against a real flow field); and every car
 * committed BEFORE the erase is by definition committed, so `canEnter` grants
 * it. A car that is on a ghost cell's doorstep and NOT committed to it therefore
 * has to be built by hand.
 *
 * That is the same idiom as `assertSingleCrossing` (cars.ts),
 * `assertDispatchProgress` (dispatch.ts) and `assertPlaceCost` (roads.ts): the
 * branch is exercised directly and labelled unreachable **so nobody deletes it
 * on the strength of its own survival.** What it buys is stated rather than
 * implied — without it, erasing a road under traffic would be free capacity,
 * because any car could then drive the erased cell, and §5.11's ghost would be
 * a road that still works.
 */
describe('REFUSED_GHOST: a ghost is not traversable by a car that has not committed to it (Task 5)', () => {
  const GHOST_CELL = 150
  const GHOST_BIT = 1 << DIR_E

  /** Marks `cell` a ghost by hand, exactly as `eraseRoad` would. */
  function ghost(r: Rig, cell: number, committed: number): void {
    r.state.ghostMask[cell] = GHOST_BIT
    r.state.ghostCommitted[cell] = committed
  }

  it('refuses a car whose committed route does not contain the cell', () => {
    const r = makeRig('ghost-refused', 'ghost-refused')
    // Car 0 stands on 149 with a route running WEST, away from 150 — so 150 is
    // on neither its remaining route nor its current cell.
    handCar(r, { i: 0, cell: 149, progress: 0, step: DIR_W, enteredBy: DIR_W })
    ghost(r, GHOST_CELL, 1)
    expect(isCommittedTo(r.state, r.world, 0, GHOST_CELL), 'fixture: car 0 must NOT be committed').toBe(
      false,
    )
    // The slot is FREE, so without the ghost branch this is ENTER_FREE — which
    // is the whole discriminator, and it is asserted as the control below.
    expect(slotsOf(r.state, GHOST_CELL)).toEqual([FREE, FREE])
    expect(canEnter(r.state, r.world, 0, GHOST_CELL, DIR_E)).toBe(EnterOutcome.REFUSED_GHOST)
  })

  it('grants ENTER_FREE to a car that IS committed to the same ghost cell — the discriminator', () => {
    // Identical board, one thing different: the car's route runs EAST, through
    // 150. If this said REFUSED_GHOST the feature would be inverted and a
    // committed car could never clear the ghost, so the refund could never be
    // paid at all.
    const r = makeRig('ghost-committed', 'ghost-committed')
    handCar(r, { i: 0, cell: 149, progress: 0, step: DIR_E, enteredBy: DIR_E })
    ghost(r, GHOST_CELL, 1)
    expect(isCommittedTo(r.state, r.world, 0, GHOST_CELL)).toBe(true)
    expect(canEnter(r.state, r.world, 0, GHOST_CELL, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('the control: with the ghost cleared, the very same non-committed car is granted', () => {
    // The catalogue's most-repeated family, closed for this branch: "the car was
    // refused" must be satisfied only by the ghost. Same rig, same car, same
    // direction, `ghostMask` back to 0.
    const r = makeRig('ghost-control', 'ghost-control')
    handCar(r, { i: 0, cell: 149, progress: 0, step: DIR_W, enteredBy: DIR_W })
    ghost(r, GHOST_CELL, 1)
    expect(canEnter(r.state, r.world, 0, GHOST_CELL, DIR_E)).toBe(EnterOutcome.REFUSED_GHOST)
    r.state.ghostMask[GHOST_CELL] = 0
    expect(canEnter(r.state, r.world, 0, GHOST_CELL, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('the ghost test sits IN FRONT of the occupancy test: an occupied ghost still says GHOST', () => {
    // Ordering, asserted rather than read off the source. A cell that is both a
    // ghost and occupied has two possible refusals, and the ghost must win —
    // otherwise the valve, which lives inside the occupied branch, gets to see
    // it. This is the assertion that fails if the ghost check is moved below
    // the occupancy read.
    const r = makeRig('ghost-before-occupied', 'ghost-before-occupied')
    handCar(r, { i: 0, cell: 149, progress: 0, step: DIR_W, enteredBy: DIR_W })
    claimCell(r.state, 1, GHOST_CELL, DIR_E)
    ghost(r, GHOST_CELL, 1)
    expect(occupantOf(r.state, GHOST_CELL, LANE_OF_DIR[DIR_E] as number)).toBe(1)
    expect(canEnter(r.state, r.world, 0, GHOST_CELL, DIR_E)).toBe(EnterOutcome.REFUSED_GHOST)
  })

  it('THE VALVE DOES NOT RELEASE IT: a saturated counter on a ghost is still REFUSED_GHOST', () => {
    // Decision 8's rule, and the milestone's named worst outcome if it were
    // wrong: *a car must never drive onto a road that no longer exists merely
    // because it waited.* The same saturated counter on an OCCUPIED cell is
    // released — asserted here as the control, on the same rig — so this is a
    // statement about the ghost and not about a counter that failed to saturate.
    const r = makeRig('ghost-vs-valve', 'ghost-vs-valve')
    handCar(r, { i: 0, cell: 149, progress: 0, step: DIR_W, enteredBy: DIR_W })
    r.state.carBlockedTicks[0] = MAX_BLOCKED_TICKS
    ghost(r, GHOST_CELL, 1)
    expect(canEnter(r.state, r.world, 0, GHOST_CELL, DIR_E)).toBe(EnterOutcome.REFUSED_GHOST)
    // Well past the ceiling, too: the answer is not a threshold artefact.
    r.state.carBlockedTicks[0] = 32767
    expect(canEnter(r.state, r.world, 0, GHOST_CELL, DIR_E)).toBe(EnterOutcome.REFUSED_GHOST)
    // Control: the identical saturated counter DOES release an occupied cell.
    r.state.ghostMask[GHOST_CELL] = 0
    claimCell(r.state, 1, GHOST_CELL, DIR_E)
    expect(canEnter(r.state, r.world, 0, GHOST_CELL, DIR_E)).toBe(EnterOutcome.ENTER_VALVE)
  })

  it('runMovement CANNOT produce a REFUSED_GHOST, and that is enumerated rather than argued', () => {
    // **The finding that corrects this milestone's own instructions.** Tasks 3
    // and 4 each recorded a labelled-inert mutant in `cars.ts` and named Task 5
    // as the task whose `REFUSED_GHOST` would kill it; the M1d plan says the
    // code is "reachable only from a hand-built state" but attributes that to
    // `dist[cell]` being INF, which is a statement about DISPATCH. The stronger
    // and simpler fact is about MOVEMENT: `advanceCar` asks `canEnter` about
    // exactly one cell — `next = stepCell(carCell, dir)`, where `dir` is the
    // current step of its own committed route — and `isCommittedTo` walks that
    // same route from that same cell with that same step, so `next` is the first
    // cell it visits and the answer is always `true`.
    //
    // Enumerated here rather than left as a reading of two functions: both
    // phases x every cursor x seven start cells x 500 pseudo-random routes, and
    // the count of exceptions must be **zero**. Any change that makes it
    // non-zero — a different commitment definition, a route the cursor does not
    // track — turns this red and hands the next reader the case that reopens the
    // branch.
    const r = makeRig('ghost-unreachable', 'ghost-unreachable')
    const routeLen = 6
    let checked = 0
    let notCommitted = 0
    for (const phase of [PHASE_OUTBOUND, PHASE_RETURNING]) {
      for (let seed = 1; seed <= 500; seed++) {
        let x = (seed * 2654435761) % 4294967296
        for (let k = 0; k < routeLen; k++) {
          x = (x * 1103515245 + 12345) % 2147483648
          packRouteStep(r.state, 0, k, x % 8)
        }
        r.state.carRouteLen[0] = routeLen
        r.state.carPhase[0] = phase
        for (let cursor = 0; cursor <= routeLen; cursor++) {
          for (const cell of [23, 45, 150, 151, 88, 106, 199]) {
            const outbound = phase === PHASE_OUTBOUND
            if (outbound ? cursor >= routeLen : cursor <= 0) continue
            r.state.carRouteCursor[0] = cursor
            r.state.carCell[0] = cell
            const dir = outbound
              ? routeStep(r.state, 0, cursor)
              : (OPPOSITE[routeStep(r.state, 0, cursor - 1)] as number)
            const next = stepCell(cell, dir, r.world.w, r.world.h)
            if (next < 0) continue // `advanceCar` throws on this before it asks
            checked++
            if (!isCommittedTo(r.state, r.world, 0, next)) notCommitted++
          }
        }
      }
    }
    expect(checked, 'vacuity: the enumeration must actually range over something').toBeGreaterThan(10000)
    expect(notCommitted, 'a car can be refused at a ghost it is committed to').toBe(0)
  })

  it('isEntryGranted names the two grants and refuses the two refusals — including the ghost', () => {
    // **The detector `cars.ts`'s labelled-inert mutant never got, relocated to
    // where it can exist.** The mutant is "treat `REFUSED_GHOST` as a grant",
    // and at `advanceCar`'s call site it is unfalsifiable (the test above proves
    // why). As a property of the outcome code it is one line and four
    // assertions, and the fail-open spelling — `return outcome !==
    // REFUSED_OCCUPIED` — fails on the third of them.
    expect(isEntryGranted(EnterOutcome.ENTER_FREE)).toBe(true)
    expect(isEntryGranted(EnterOutcome.ENTER_VALVE)).toBe(true)
    expect(isEntryGranted(EnterOutcome.REFUSED_OCCUPIED)).toBe(false)
    expect(isEntryGranted(EnterOutcome.REFUSED_GHOST)).toBe(false)
    // Total over the declared enum, so a fifth code cannot be added and quietly
    // fall on the grant side of a comparison nobody updated.
    let grants = 0
    for (const v of Object.values(EnterOutcome)) if (isEntryGranted(v)) grants++
    expect(grants).toBe(2)
  })

  it('a committed car crosses a ghost it is standing next to, and is never refused or blocked', () => {
    // The production-shaped statement of the rule: the ghost does not stop the
    // cars it is waiting for. This is the arm that would fail if the ghost check
    // were inverted, or if `isCommittedTo` did not count the cell the car is
    // standing on.
    const r = makeRig('ghost-committed-drives', 'ghost-committed-drives')
    handCar(r, { i: 0, cell: 149, progress: ORTHO_THRESHOLD - SPEED, step: DIR_E, enteredBy: DIR_E })
    r.state.ghostMask[GHOST_CELL] = GHOST_BIT
    r.state.ghostCommitted[GHOST_CELL] = 1
    expect(canEnter(r.state, r.world, 0, GHOST_CELL, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
    runMovement(r.state, r.world)
    expect(r.state.carCell[0], 'the committed car drove its ghost').toBe(GHOST_CELL)
    expect(r.state.carBlockedTicks[0]).toBe(0)
  })

  it('no route committed AFTER the erase contains the ghost cell: dist[ghostCell] is INF', () => {
    // The load-bearing half of "REFUSED_GHOST is production-unreachable", and it
    // is asserted against a real flow field rather than argued. `eraseRoad`
    // clears the live bits, so the cell has no edges and the Dijkstra cannot
    // reach it — which is what makes the erase-time count SOUND, since every car
    // that ever departs the cell afterwards is one of the cars counted.
    const r = buildFixture('ghost-dist-inf')
    step(r.state, r.world, r.fields, r.scratch, { actions: corridorActions() })
    r.state.destPins[0] = 2
    step(r.state, r.world, r.fields, r.scratch, NO_ACTIONS)
    const mid = 145 // (5,7), mid-corridor: two road bits, so two erases
    const before = fieldFor(r.state, r.world, r.fields, 0, r.scratch)
    expect(before.dist[mid], 'vacuity: the cell is reachable BEFORE the erase').toBeLessThan(INF)

    // A car is committed to it, so this ghosts rather than refunding.
    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(isCommittedTo(r.state, r.world, 0, mid)).toBe(true)
    expect(eraseRoad(r.state, r.world, mid - 1, mid)).toBe(true)
    expect(eraseRoad(r.state, r.world, mid, mid + 1)).toBe(true)
    expect(r.state.ghostMask[mid]).not.toBe(0)

    step(r.state, r.world, r.fields, r.scratch, NO_ACTIONS)
    const after = fieldFor(r.state, r.world, r.fields, 0, r.scratch)
    expect(after.dist[mid], 'a ghost cell is unreachable, so no later route can contain it').toBe(INF)
  })
})

describe('assertEnterCarValid: the third parameter of canEnter s signature, guarded like the other two', () => {
  it('throws by name for a car index that is not a car, rather than answering from undefined', () => {
    // The catalogue entry this closes is verbatim: *"a guard that fail-closes on
    // one parameter and not its sibling is worse than no guard, because the
    // unguarded path returns a PLAUSIBLE answer."* `assertEnterDirValid` was
    // added when review found `cell` guarded and `dir` not. `i` was the third,
    // and Task 5 is what made it load-bearing: the ghost branch reads five
    // car-indexed regions through it, and `carRoute`'s `undefined >> 0 & 0xf` is
    // **0** — direction N — so an out-of-range car would walk a fabricated route
    // and get a confident answer.
    const r = makeRig('enter-car-guard', 'enter-car-guard')
    const carCount = r.state.carPhase.length
    expect(() => assertEnterCarValid(carCount, carCount)).toThrow(/is not a car index/)
    expect(() => assertEnterCarValid(-1, carCount)).toThrow(/is not a car index/)
    expect(() => assertEnterCarValid(1.5, carCount)).toThrow(/is not a car index/)
    // Both ends of the real range are fine, so the guard is not merely refusing
    // everything.
    expect(() => assertEnterCarValid(0, carCount)).not.toThrow()
    expect(() => assertEnterCarValid(carCount - 1, carCount)).not.toThrow()
  })

  it('canEnter itself throws for it, on a cell and direction that are both perfectly valid', () => {
    // Aimed so that only the car index can be the cause: cell 150 is on the
    // board and DIR_E is one of the eight, so the other two guards pass.
    const r = makeRig('enter-car-guard-live', 'enter-car-guard-live')
    const carCount = r.state.carPhase.length
    expect(() => canEnter(r.state, r.world, carCount, 150, DIR_E)).toThrow(/is not a car index/)
    expect(() => canEnter(r.state, r.world, 0, 150, DIR_E)).not.toThrow()
  })
})
