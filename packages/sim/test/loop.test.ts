import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  parseMap,
  CARS_PER_HOUSE,
  MAX_PATH_LEN,
  PIN_PERIOD_TICKS,
  FIRST_PIN_DELAY_TICKS,
  ORTHO_COST,
  type MapData,
} from '@laneways/shared'
import {
  createState,
  snapshot,
  restore,
  hashState,
  H_DEST_COUNT,
  H_EPOCH,
  H_HOUSE_COUNT,
  H_PINS_DROPPED,
  H_ROUTES_REFUSED,
  H_SCORE,
  H_TICK,
  HEADER_LENGTH,
  type GameState,
} from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFieldInputRanges } from '../src/regions'
import { createScratch, createFlowFields, type FlowField, type Scratch } from '../src/scratch'
import { fieldFor, hashFieldInputRegions } from '../src/flowfield'
import { roadMask, tilesLeft } from '../src/roads'
import {
  placeHouse,
  placeDestination,
  DEST_KIND_SQUARE,
  ORIENTATION_N,
  ORIENTATION_S,
  PHASE_IDLE,
  PHASE_NONE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
} from '../src/buildings'
import { ROUTE_BYTES } from '../src/dispatch'
import { step, type TickAction, type TickInputs } from '../src/step'

/**
 * M1c's deliverable: the whole trip loop, driven through `step`, over a
 * fixture built to CATCH things rather than to smoke.
 *
 * The fixture the previous plan revision specified — one house, one
 * destination, "run until the score reaches N" — was proved toothless: it
 * cannot see dispatch always picking the same house, cannot see a wrong speed
 * in either direction (a teleporting car is merely faster and passes sooner),
 * and cannot see "return to the nearest house" at all, because on one house
 * nearest IS own. Everything below is shaped by that.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE, and the four route costs that make it discriminating
 * ---------------------------------------------------------------------------
 *
 * All-land 20 x 12 board, so `cell = y * 20 + x` and every literal below was
 * computed by hand from that. Non-square deliberately: a transposed index
 * lands off-grid or on the wrong row rather than coincidentally agreeing.
 *
 * One straight road corridor along row 5, from x = 2 to x = 16, with two
 * colour-0 destinations hanging off it and two colour-0 houses standing on
 * it:
 *
 *      x:   2      5            10               16
 *   row 5:  [d1]---H1-----------[d2]-------------H0
 *           102    105          110              116
 *
 *   d1: origin (2,2)  orientation S, carpark (2,5)  = 102, dest index 0
 *   d2: origin (10,2) orientation S, carpark (10,5) = 110, dest index 1
 *   H0: (16,5) = 116, house index 0 -> cars 0 and 1
 *   H1: (5,5)  = 105, house index 1 -> cars 2 and 3
 *
 * Every step is orthogonal, so each costs `ORTHO_COST` = 10, and the four
 * route costs are:
 *
 *   cost(H1, d1) = 3 cells  =  30      <-- H1's nearest
 *   cost(H1, d2) = 5 cells  =  50
 *   cost(H0, d2) = 6 cells  =  60      <-- H0's nearest
 *   cost(H0, d1) = 14 cells = 140
 *
 * That is exactly the `cost(H1,d1) < cost(H1,d2) < cost(H0,d2) < cost(H0,d1)`
 * matrix the plan requires, with **the nearer house at the HIGHER index**
 * (H1 = 1), which is what kills "pick the first house", "pick the lowest
 * index" and "pick the largest dist" in one fixture.
 *
 * **Why the cost matrix is the point.** Dispatch selects `argmin
 * dist[houseCell]`, and `dist` is the cost to the NEAREST PINNED destination —
 * so on the FIRST dispatch of any tick the dispatching house is provably the
 * nearest colour-0 house to whatever its walk terminates at. Adding houses
 * cannot break that. Divergence needs a LATER iteration of the same tick's
 * loop, which is what two unreserved pins on two distinct destinations buy:
 *
 *   1. dist[H1] = 30 and dist[H0] = 60, so H1 wins and commits to d1.
 *   2. H1 is re-selected (it still has a free car), walks to d1 again, finds
 *      `destPins - destReserved === 0` and is excluded (decision 4's cost).
 *   3. H0 is then selected on the strictly-greater key, walks to d2, commits.
 *
 * H0's car serves d2 and returns to H0 — while the nearest colour-0 house to
 * d2 is H1 (50 < 60). That trip is the one that makes "return to the nearest
 * house" observable, and the vacuity check below asserts it by hand, because a
 * per-colour multi-source field has no per-destination distance to rank houses
 * by.
 *
 * ---------------------------------------------------------------------------
 * THE TIMELINE, hand-computed from the movement constants and NEVER read back
 * ---------------------------------------------------------------------------
 *
 * `speedUnits(LANE_SPEED_DEFAULT)` = 330 progress units per tick; an
 * orthogonal cell costs `ORTHO_COST * COST_UNIT_SCALE` = 2500. Progress
 * carries across a cell crossing AND across the outbound -> return flip, so a
 * car makes its k-th crossing on the first tick whose accumulated progress
 * reaches `k * 2500`: `rel_k = ceil(k * 2500 / 330)`, counting the DISPATCH
 * tick itself as rel 1 (movement is phase 6, dispatch phase 5, same tick).
 *
 *   rel_k for k = 1..12:  8 16 23 31 38 46 54 61 69 76 84 91
 *
 * A 3-cell leg is 6 crossings out-and-back (rel 46); a 6-cell leg is 12
 * (rel 91). With `abs = dispatchTick + rel_k - 1`:
 *
 *   tick 1   roads placed through `step`'s input path (14 place actions)
 *   tick 1+  destPins[0] = destPins[1] = 1        (wave 1, written directly)
 *   tick 2   dispatch: car 2 (H1) -> d1, car 0 (H0) -> d2
 *   tick 24  car 2 reaches d1  (rel 23)  -> pin consumed, score still 0
 *   tick 47  car 0 reaches d2  (rel 46)  -> pin consumed
 *            car 2 reaches home (rel 46) -> SCORE 1
 *   tick 50+ destPins[0] = destPins[1] = 1        (wave 2)
 *   tick 51  dispatch: car 2 (H1) -> d1, car 1 (H0) -> d2
 *            car 0 is RETURNING and its house IS selected, so "free means
 *            carPhase !== PHASE_OUTBOUND" would pick car 0 here
 *   tick 73  car 2 reaches d1  (rel 23)
 *   tick 92  car 0 reaches home (rel 91) -> SCORE 2   <- the not-nearest trip
 *   tick 96  car 1 reaches d2  (rel 46)
 *            car 2 reaches home (rel 46) -> SCORE 3
 *   tick 130 GOLDEN taken here, with car 1 mid-flight
 *   tick 141 car 1 reaches home (rel 91) -> SCORE 4
 *
 * The pin timer is frozen for the whole window rather than driving the run:
 * both destinations spawn at tick 0, so they are ineligible until tick 120,
 * and `pinAccum` needs 518/2 = 259 further eligible ticks after that. Nothing
 * demand does can move `destPins` inside 150 ticks — asserted, not assumed.
 * The cost of freezing it is that this fixture is blind to where phase 1 sits,
 * which is why the tick advance gets its own boundary test at the bottom.
 */

const W = 20
const H = 12

const D1_ORIGIN = 42 // (2,2)
const D2_ORIGIN = 50 // (10,2)
const D1_CARPARK = 102 // (2,5)
const D2_CARPARK = 110 // (10,5)
const H0_CELL = 116 // (16,5)
const H1_CELL = 105 // (5,5)

const D1 = 0
const D2 = 1
const H0 = 0
const H1 = 1

/** Hand-counted cell steps along row 5, x ascending. */
const COST_H1_D1 = 3 * ORTHO_COST // 30
const COST_H1_D2 = 5 * ORTHO_COST // 50
const COST_H0_D2 = 6 * ORTHO_COST // 60
const COST_H0_D1 = 14 * ORTHO_COST // 140

const RUN_TICKS = 150
const GOLDEN_TICK = 130
const SNAPSHOT_TICK = 30
const WAVE2_TICK = 50
const STARTING_TILES = 999

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

function makeRig(id: string, rows: readonly string[], tiles: number, groupCount = 5): Rig {
  const map = parseMap(id, rows as string[], tiles, 40, 16, groupCount)
  const world = createWorld(map)
  return {
    state: createState('loop', map),
    world,
    map,
    scratch: createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map)),
    fields: createFlowFields(map.groupCount, world.cells),
  }
}

/** Fresh `fields`/`scratch` for the same map — what a Worker cold-starting a replay holds. */
function freshDerived(map: MapData, world: WorldData): { fields: FlowField[]; scratch: Scratch } {
  return {
    fields: createFlowFields(map.groupCount, world.cells),
    scratch: createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map)),
  }
}

/**
 * Buildings, placed out of band at tick 0 (the authored spawn schedule is
 * M1e). Destinations first, then houses, then the roads — road placement is
 * the only part that goes through `step`, and it has to come last because
 * `canPlaceHouse`/`canPlaceDestination` both reject a cell that already
 * carries road.
 *
 * H0 is placed FIRST so that the NEARER house lands at the HIGHER index.
 */
function buildLoopFixture(): Rig {
  const r = makeRig('loop-fixture', allLandRows(W, H), STARTING_TILES)
  expect(placeDestination(r.state, r.world, D1_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeDestination(r.state, r.world, D2_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeHouse(r.state, r.world, H0_CELL, 0)).toBe(true)
  expect(placeHouse(r.state, r.world, H1_CELL, 0)).toBe(true)
  expect(r.state.header[H_DEST_COUNT]).toBe(2)
  expect(r.state.header[H_HOUSE_COUNT]).toBe(2)
  return r
}

/** The corridor, as `step` input actions: 102-103, 103-104, ... 115-116. */
function corridorActions(): TickAction[] {
  const out: TickAction[] = []
  for (let cell = D1_CARPARK; cell < H0_CELL; cell++) out.push({ kind: 'place', a: cell, b: cell + 1 })
  return out
}

const NO_ACTIONS: TickInputs = { actions: [] }

/**
 * The scripted run, as a pure function of the tick number, so that the
 * original timeline and every replay of it are driven by the same script and
 * cannot silently diverge in their inputs.
 *
 * Road edits travel as `TickAction`s through `step`. The two pin waves are
 * written directly into `destPins` AFTER the tick they follow — that is
 * exactly the byte a pin fire writes, and it is how the fixture pins the
 * demand timer instead of waiting 379 ticks for it.
 */
function actionsForTick(tick: number): TickInputs {
  return tick === 1 ? { actions: corridorActions() } : NO_ACTIONS
}

function applyScriptedPins(state: GameState, tick: number): void {
  if (tick === 1 || tick === WAVE2_TICK) {
    state.destPins[D1] = 1
    state.destPins[D2] = 1
  }
}

interface Observations {
  readonly dispatches: string[]
  readonly pinsConsumed: string[]
  readonly scores: string[]
  readonly violations: string[]
  readonly scoreAfterTick: number[]
}

function newObservations(): Observations {
  return { dispatches: [], pinsConsumed: [], scores: [], violations: [], scoreAfterTick: [] }
}

/**
 * Every (before, after) phase pair a car may show across one tick.
 *
 * `RETURNING -> OUTBOUND` is absent on purpose and is the one that matters:
 * arrivals (phase 7) run AFTER dispatch (phase 5), so a car freed this tick
 * cannot be dispatched until the next one, and a dispatch that treated
 * `carPhase !== PHASE_OUTBOUND` as "free" would produce exactly this pair.
 * `OUTBOUND -> IDLE` is absent for the same family of reasons: a trip ends
 * only through RETURNING.
 */
const ALLOWED_TRANSITIONS: readonly string[] = [
  `${PHASE_NONE}->${PHASE_NONE}`,
  `${PHASE_IDLE}->${PHASE_IDLE}`,
  `${PHASE_IDLE}->${PHASE_OUTBOUND}`,
  `${PHASE_OUTBOUND}->${PHASE_OUTBOUND}`,
  `${PHASE_OUTBOUND}->${PHASE_RETURNING}`,
  `${PHASE_RETURNING}->${PHASE_RETURNING}`,
  `${PHASE_RETURNING}->${PHASE_IDLE}`,
]

function sumReserved(s: GameState): number {
  let sum = 0
  for (let d = 0; d < (s.header[H_DEST_COUNT] as number); d++) sum += s.destReserved[d] as number
  return sum
}

function countInPhase(s: GameState, phase: number): number {
  let n = 0
  for (let i = 0; i < s.carPhase.length; i++) if ((s.carPhase[i] as number) === phase) n++
  return n
}

/**
 * Steps `state` from tick `from + 1` through tick `to`, applying the script,
 * and records every phase transition plus the per-tick invariants.
 *
 * Violations are COLLECTED rather than asserted per car per tick: 150 ticks x
 * 80 cars is 12,000 assertions, and an empty-array comparison at the end
 * reports the first offender with its tick and car index just as precisely.
 */
function runScripted(r: Rig, from: number, to: number, obs: Observations): void {
  const before = new Uint8Array(r.state.carPhase.length)
  const beforePins = new Uint8Array(r.state.destPins.length)
  let previousScore = r.state.header[H_SCORE] as number
  for (let tick = from + 1; tick <= to; tick++) {
    before.set(r.state.carPhase)
    beforePins.set(r.state.destPins)
    const targetBefore = Array.from(r.state.carTargetDest)

    step(r.state, r.world, r.fields, r.scratch, actionsForTick(tick))
    applyScriptedPins(r.state, tick)

    if ((r.state.header[H_TICK] as number) !== tick) {
      obs.violations.push(`tick ${tick}: H_TICK is ${r.state.header[H_TICK]}`)
    }
    if ((r.state.header[H_EPOCH] as number) !== 0) {
      obs.violations.push(`tick ${tick}: H_EPOCH left non-zero`)
    }

    for (let i = 0; i < r.state.carPhase.length; i++) {
      const wasPhase = before[i] as number
      const nowPhase = r.state.carPhase[i] as number
      const pair = `${wasPhase}->${nowPhase}`
      if (!ALLOWED_TRANSITIONS.includes(pair)) {
        obs.violations.push(`tick ${tick}: car ${i} made a forbidden transition ${pair}`)
      }
      if (wasPhase === PHASE_IDLE && nowPhase === PHASE_OUTBOUND) {
        obs.dispatches.push(
          `tick=${tick} car=${i} home=${r.state.carHome[i]} dest=${r.state.carTargetDest[i]}`,
        )
      }
      if (wasPhase === PHASE_OUTBOUND && nowPhase === PHASE_RETURNING) {
        // Read the target from BEFORE the tick as well as after: arrivals must
        // not clear it (only trip end does), and reading only the post-tick
        // value would not notice if they did.
        obs.pinsConsumed.push(
          `tick=${tick} car=${i} dest=${targetBefore[i]} stillTargeting=${r.state.carTargetDest[i]}`,
        )
      }
      if (wasPhase === PHASE_RETURNING && nowPhase === PHASE_IDLE) {
        obs.scores.push(
          `tick=${tick} car=${i} home=${r.state.carHome[i]} cell=${r.state.carCell[i]}`,
        )
      }
    }

    // Decision 4's two invariants, checked as a PAIR because each is blind to
    // the other: conservation cannot see over-reservation on one destination
    // (2 === 2 either way), and the per-destination bound cannot see a leaked
    // reservation on a destination nobody dispatched to.
    const reserved = sumReserved(r.state)
    const outbound = countInPhase(r.state, PHASE_OUTBOUND)
    if (reserved !== outbound) {
      obs.violations.push(`tick ${tick}: sum(destReserved)=${reserved} != outbound cars=${outbound}`)
    }
    for (let d = 0; d < (r.state.header[H_DEST_COUNT] as number); d++) {
      if ((r.state.destReserved[d] as number) > (r.state.destPins[d] as number)) {
        obs.violations.push(`tick ${tick}: destReserved[${d}] > destPins[${d}]`)
      }
      const drop = (beforePins[d] as number) - (r.state.destPins[d] as number)
      if (drop > 1) {
        obs.violations.push(`tick ${tick}: destPins[${d}] fell by ${drop}, not 0 or 1`)
      }
    }

    const score = r.state.header[H_SCORE] as number
    if (score < previousScore) obs.violations.push(`tick ${tick}: score went backwards`)
    previousScore = score
    obs.scoreAfterTick.push(score)
  }
}

/** Every byte of car `i`'s `ROUTE_BYTES` slice. */
function routeBytesOf(s: GameState, i: number): number[] {
  const out: number[] = []
  for (let b = 0; b < ROUTE_BYTES; b++) out.push(s.carRoute[i * ROUTE_BYTES + b] as number)
  return out
}

// ---------------------------------------------------------------------------
// The end-to-end loop
// ---------------------------------------------------------------------------

describe('the trip loop, end to end through step()', () => {
  it('the fixture really has the four route costs the assertions below depend on', () => {
    // Vacuity, and it must come first: every claim in this file about WHICH
    // house dispatches rests on the two houses' costs genuinely differing, and
    // on the ordering of the four-cost matrix. Hand-counted cell steps, then
    // corroborated against the field the dispatch phase actually read.
    expect(COST_H1_D1).toBeLessThan(COST_H1_D2)
    expect(COST_H1_D2).toBeLessThan(COST_H0_D2)
    expect(COST_H0_D2).toBeLessThan(COST_H0_D1)

    const r = buildLoopFixture()
    const obs = newObservations()
    runScripted(r, 0, 2, obs)

    // Safe to read here: no arrival happened on tick 2, so the fields are not
    // yet stale (see the dedicated test for the tick where one does).
    const field = fieldFor(r.state, r.world, r.fields, 0, r.scratch)
    expect(field.dist[H1_CELL]).toBe(COST_H1_D1) // H1's nearest pinned destination is d1
    expect(field.dist[H0_CELL]).toBe(COST_H0_D2) // H0's is d2
    expect(field.dist[H1_CELL]).not.toBe(field.dist[H0_CELL])
  })

  it('dispatches, consumes pins and scores on exactly the hand-computed ticks, from and to the right houses', () => {
    const r = buildLoopFixture()
    const obs = newObservations()
    runScripted(r, 0, RUN_TICKS, obs)

    expect(obs.violations).toEqual([])

    // Hand-written literals throughout — the tick numbers come from the
    // rel_k table in this file's header, the car and house indices from the
    // dispatch trace, and none of them was read back from a run.
    expect(obs.dispatches).toEqual([
      'tick=2 car=0 home=0 dest=1',
      'tick=2 car=2 home=1 dest=0',
      'tick=51 car=1 home=0 dest=1',
      'tick=51 car=2 home=1 dest=0',
    ])

    expect(obs.pinsConsumed).toEqual([
      'tick=24 car=2 dest=0 stillTargeting=0',
      'tick=47 car=0 dest=1 stillTargeting=1',
      'tick=73 car=2 dest=0 stillTargeting=0',
      'tick=96 car=1 dest=1 stillTargeting=1',
    ])

    // Each score names the car, its OWN home, and the cell it ended on —
    // `houseCell[carHome]`, never the nearest house's cell.
    expect(obs.scores).toEqual([
      `tick=47 car=2 home=1 cell=${H1_CELL}`,
      `tick=92 car=0 home=0 cell=${H0_CELL}`,
      `tick=96 car=2 home=1 cell=${H1_CELL}`,
      `tick=141 car=1 home=0 cell=${H0_CELL}`,
    ])

    expect(r.state.header[H_SCORE]).toBe(4)
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
    expect(r.state.header[H_PINS_DROPPED]).toBe(0)

    // The brief's "the score started at 0 and some intermediate tick had score
    // < N" vacuity, read off the per-tick record rather than inferred. The
    // record used to be written and never read — dead scaffolding that looked
    // like coverage. This is what it was collected for.
    expect(obs.scoreAfterTick.length).toBe(RUN_TICKS)
    expect(obs.scoreAfterTick[0]).toBe(0) // score 0 after tick 1
    expect(obs.scoreAfterTick[RUN_TICKS - 1]).toBe(4)
    // It rose through every intermediate value rather than jumping: a run that
    // scored all four on one tick would satisfy "started at 0, ended at 4".
    expect(obs.scoreAfterTick[46]).toBe(1) // after tick 47
    expect(obs.scoreAfterTick[91]).toBe(2) // after tick 92
    expect(obs.scoreAfterTick[95]).toBe(3) // after tick 96
    expect(obs.scoreAfterTick[139]).toBe(3) // after tick 140 — still N-1
  })

  it('at least one scored trip returned to a house that is NOT the nearest one to the destination it served', () => {
    // The vacuity check the plan requires, and the reason the four-cost matrix
    // exists at all. Hand-computed: a per-colour multi-source field gives the
    // distance to a house's NEAREST pinned destination, never its distance to
    // a SPECIFIC one, so there is nothing in the implementation to read this
    // off. Car 0 serves d2 and belongs to H0 (cost 60), while the nearest
    // colour-0 house to d2 is H1 (cost 50).
    expect(COST_H1_D2).toBeLessThan(COST_H0_D2)
    const nearestHouseToD2 = H1

    const r = buildLoopFixture()
    const obs = newObservations()
    runScripted(r, 0, 92, obs)

    expect(obs.violations).toEqual([])
    expect(r.state.carTargetDest[0]).toBe(-1) // car 0's trip is over by tick 92
    expect(obs.scores).toContain(`tick=92 car=0 home=0 cell=${H0_CELL}`)
    expect(r.state.carHome[0]).toBe(H0)
    expect(r.state.carHome[0]).not.toBe(nearestHouseToD2)
    expect(r.state.carCell[0]).toBe(H0_CELL)
    expect(r.state.carCell[0]).not.toBe(H1_CELL)
  })

  it('credits the score on RETURN, not on pickup: the pin decrement is a strictly earlier, independently identifiable tick', () => {
    const r = buildLoopFixture()
    const obs = newObservations()

    // Tick 24 is car 2's arrival AT d1 — identified by the pin decrement, not
    // by anything the score does.
    runScripted(r, 0, 24, obs)
    expect(r.state.destPins[D1]).toBe(0)
    expect(r.state.destReserved[D1]).toBe(0)
    expect(r.state.carPhase[2]).toBe(PHASE_RETURNING)
    expect(r.state.header[H_SCORE]).toBe(0) // N - 1, with N = 1

    // ...and the score becomes 1 only 23 ticks later, when the car is home.
    runScripted(r, 24, 46, obs)
    expect(r.state.header[H_SCORE]).toBe(0)
    runScripted(r, 46, 47, obs)
    expect(r.state.header[H_SCORE]).toBe(1)
    expect(obs.violations).toEqual([])
  })

  it('leaves a completed car byte-identical to a freshly created one, slot for slot', () => {
    const r = buildLoopFixture()
    const obs = newObservations()
    runScripted(r, 0, 47, obs) // the first score increment
    expect(obs.violations).toEqual([])
    expect(r.state.header[H_SCORE]).toBe(1)

    // Car 3 is H1's other car: same home, never dispatched, so it IS the
    // freshly created slot — taken from this fixture rather than described by
    // a literal. Asserted as a SLOT because nothing else in the milestone
    // reads `carTargetDest` or the route bytes after a trip: the goldens are
    // building-free, and the mid-flight replay below compares a mutant against
    // itself. Without this, "leave carTargetDest set" and "skip the route
    // zeroing" have a mutation and no observer.
    expect(r.state.carPhase[3]).toBe(PHASE_IDLE) // vacuity: car 3 is genuinely live and fresh
    expect(r.state.carHome[3]).toBe(r.state.carHome[2])
    const fresh = {
      carHome: r.state.carHome[3] as number,
      carCell: r.state.carCell[3] as number,
      carProgress: r.state.carProgress[3] as number,
      carTargetDest: r.state.carTargetDest[3] as number,
      carRouteLen: r.state.carRouteLen[3] as number,
      carRouteCursor: r.state.carRouteCursor[3] as number,
      carPhase: r.state.carPhase[3] as number,
      carRoute: routeBytesOf(r.state, 3),
    }
    expect(fresh.carTargetDest).toBe(-1)
    expect(fresh.carRoute).toEqual(new Array(ROUTE_BYTES).fill(0))

    expect({
      carHome: r.state.carHome[2] as number,
      carCell: r.state.carCell[2] as number,
      carProgress: r.state.carProgress[2] as number,
      carTargetDest: r.state.carTargetDest[2] as number,
      carRouteLen: r.state.carRouteLen[2] as number,
      carRouteCursor: r.state.carRouteCursor[2] as number,
      carPhase: r.state.carPhase[2] as number,
      carRoute: routeBytesOf(r.state, 2),
    }).toEqual(fresh)
  })

  it('leaves every IDLE car with a zeroed route slice, length and cursor at the end of the run', () => {
    const r = buildLoopFixture()
    const obs = newObservations()
    runScripted(r, 0, RUN_TICKS, obs)
    expect(obs.violations).toEqual([])

    const liveCars = (r.state.header[H_HOUSE_COUNT] as number) * CARS_PER_HOUSE
    let idle = 0
    const dirty: string[] = []
    for (let i = 0; i < liveCars; i++) {
      if ((r.state.carPhase[i] as number) !== PHASE_IDLE) continue
      idle++
      if ((r.state.carRouteLen[i] as number) !== 0) dirty.push(`car ${i} routeLen`)
      if ((r.state.carRouteCursor[i] as number) !== 0) dirty.push(`car ${i} cursor`)
      if (routeBytesOf(r.state, i).some((b) => b !== 0)) dirty.push(`car ${i} route bytes`)
    }
    // Vacuity: car 3 is idle having had a walk written into its slice and then
    // excluded on tick 51 (decision 4's cost), and cars 0/1/2 are idle having
    // completed trips — so this is four cars that reached IDLE by three
    // different paths, not four cars that never moved.
    expect(idle).toBe(4)
    expect(dirty).toEqual([])
  })

  it('the fields are stale from the arrivals phase until the next sync — a field read after a tick with an arrival throws', () => {
    const r = buildLoopFixture()
    const obs = newObservations()

    // Tick 23: movement only, nothing touched `destPins`. The read succeeds,
    // which is what makes the throw below a statement about arrivals rather
    // than about `fieldFor` throwing generally.
    runScripted(r, 0, 23, obs)
    expect(() => fieldFor(r.state, r.world, r.fields, 0, r.scratch)).not.toThrow()

    // Tick 24: car 2 arrives and consumes a pin AFTER the sync ran.
    runScripted(r, 23, 24, obs)
    expect(r.state.destPins[D1]).toBe(0) // vacuity: the arrival genuinely happened
    expect(() => fieldFor(r.state, r.world, r.fields, 0, r.scratch)).toThrow(/stale/)
    expect(obs.violations).toEqual([])
  })

  it('H_SCORE is the one and only score slot — no other header slot tracks completed trips', () => {
    const r = buildLoopFixture()
    const obs = newObservations()
    runScripted(r, 0, 46, obs)
    const before = Array.from(r.state.header)
    runScripted(r, 46, 47, obs) // the tick a trip completes

    const moved: number[] = []
    for (let i = 0; i < HEADER_LENGTH; i++) {
      if ((r.state.header[i] as number) !== (before[i] as number)) moved.push(i)
    }
    // H_TICK because time passed; H_SCORE because a trip completed. Nothing
    // else — a second score counter anywhere in the header shows up here.
    expect(moved).toEqual([H_TICK, H_SCORE])
    expect((r.state.header[H_SCORE] as number) - (before[H_SCORE] as number)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Mid-flight snapshot and replay — the browser-vs-Worker property
// ---------------------------------------------------------------------------

describe('the run replays byte-identically from a mid-flight snapshot', () => {
  it('resumes from a snapshot taken with a car mid-edge, mid-trip, holding a live reservation', () => {
    const r = buildLoopFixture()
    const obs = newObservations()
    runScripted(r, 0, SNAPSHOT_TICK, obs)

    // Vacuity BEFORE the snapshot: the snapshot must genuinely capture a car
    // in flight, or "replays identically" is a statement about an idle board.
    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(r.state.carProgress[0]).not.toBe(0)
    expect(r.state.carRouteCursor[0]).toBeGreaterThan(0)
    expect(r.state.carRouteCursor[0]).toBeLessThan(r.state.carRouteLen[0] as number)
    expect(r.state.carCell[0]).not.toBe(H0_CELL)
    expect(r.state.destReserved[D2]).toBe(1) // a live reservation
    // ...and the other car is mid-flight on the RETURN leg, so both legs are
    // represented in the snapshotted bytes.
    expect(r.state.carPhase[2]).toBe(PHASE_RETURNING)
    expect(r.state.carProgress[2]).not.toBe(0)

    const hashAtSnapshot = hashState(r.state)
    const inputsAtSnapshot = hashFieldInputRegions(r.state, r.scratch.fieldInputRanges)
    const snap = snapshot(r.state)

    runScripted(r, SNAPSHOT_TICK, RUN_TICKS, obs)
    const expectedFinal = hashState(r.state)
    expect(obs.violations).toEqual([])

    // Vacuity AFTER: the abandoned timeline genuinely diverged from the
    // snapshot. Both hashes, and the second is the one that matters.
    //
    // `hashState` moving proves only that SOMETHING moved — `carProgress`
    // alone would do it — and under that alone the warm-fields arm below could
    // be trivially satisfiable, because reusing a stale field is only a real
    // test when the FIELD-INPUT regions differ between the snapshot and the
    // point the reused fields were built at. `rollback.test.ts:489` uses
    // `hashInputsFor` for exactly this reason; the brief authorised `hashState`
    // here, so this asserts both rather than swapping one for the other. It is
    // true today (`destPins` is [0,1] at tick 30 and [0,0] at tick 150) and
    // this is what makes it a fact the test enforces rather than one a reader
    // has to derive.
    expect(expectedFinal).not.toBe(hashAtSnapshot)
    expect(hashFieldInputRegions(r.state, r.scratch.fieldInputRanges)).not.toBe(inputsAtSnapshot)

    // A Worker cold-starts with fresh derived state: no fields, no scratch,
    // just the buffer and the input log.
    const coldDerived = freshDerived(r.map, r.world)
    const cold: Rig = {
      state: restore(snap, r.world),
      world: r.world,
      map: r.map,
      scratch: coldDerived.scratch,
      fields: coldDerived.fields,
    }
    const coldObs = newObservations()
    runScripted(cold, SNAPSHOT_TICK, RUN_TICKS, coldObs)
    expect(coldObs.violations).toEqual([])
    expect(hashState(cold.state)).toBe(expectedFinal)
    // And it is the same RUN, not just the same final bytes.
    //
    // Asserted against hand-written literals rather than against
    // `obs.scores.filter(s => !s.startsWith('tick=2 '))`, which is what the
    // first version of this line did: no score event begins `tick=2 ` (they are
    // at 47, 92, 96 and 141), so that filter removed nothing while READING as
    // if it were compensating for a real difference between the original and
    // the replayed timeline. A predicate that silently discards nothing today
    // silently discards a divergence tomorrow.
    const ALL_SCORES = [
      `tick=47 car=2 home=1 cell=${H1_CELL}`,
      `tick=92 car=0 home=0 cell=${H0_CELL}`,
      `tick=96 car=2 home=1 cell=${H1_CELL}`,
      `tick=141 car=1 home=0 cell=${H0_CELL}`,
    ]
    expect(coldObs.scores).toEqual(ALL_SCORES)
    // ...and the replay is expected to reproduce ALL of them only because the
    // snapshot precedes every one. Asserted, so moving `SNAPSHOT_TICK` past a
    // score fails here rather than silently comparing a truncated list.
    expect(obs.scores).toEqual(ALL_SCORES)
    expect(SNAPSHOT_TICK).toBeLessThan(47)

    // The harder arm: reuse the fields/scratch that at this moment hold the
    // ABANDONED timeline's tick-150 field, built from field-input bytes that
    // do not match the restored tick-30 buffer. Nothing tells them so.
    const warm: Rig = {
      state: restore(snap, r.world),
      world: r.world,
      map: r.map,
      scratch: r.scratch,
      fields: r.fields,
    }
    const warmObs = newObservations()
    runScripted(warm, SNAPSHOT_TICK, RUN_TICKS, warmObs)
    expect(warmObs.violations).toEqual([])
    expect(hashState(warm.state)).toBe(expectedFinal)
  })
})

// ---------------------------------------------------------------------------
// The golden
// ---------------------------------------------------------------------------

describe('golden replay: the whole trip loop', () => {
  it('hashes the state after a scripted trip-loop run, with a car still in flight', () => {
    const r = buildLoopFixture()
    const obs = newObservations()
    runScripted(r, 0, GOLDEN_TICK, obs)
    expect(obs.violations).toEqual([])

    // ---------------------------------------------------------------------
    // The fixture must genuinely exercise the loop, and these assertions must
    // come BEFORE the hash. A golden over a fixture that does nothing is a
    // hash of nothing, and it re-blesses just as smoothly as a real one —
    // M1b's road-network golden nearly shipped that way, which is why its own
    // "a tree was destroyed / tiles were spent" guards exist.
    // ---------------------------------------------------------------------

    // Roads were placed, and through `step`'s input path rather than by hand.
    expect(tilesLeft(r.state)).toBeLessThan(STARTING_TILES)
    expect(roadMask(r.state, D1_CARPARK)).not.toBe(0)
    expect(roadMask(r.state, D2_CARPARK)).not.toBe(0)
    expect(roadMask(r.state, H1_CELL)).not.toBe(0)

    // Trips completed, and at least one was a full out-and-back: three score
    // increments, each of which required an outbound arrival first.
    expect(r.state.header[H_SCORE]).toBe(3)
    expect(obs.scores.length).toBe(3)
    expect(obs.pinsConsumed.length).toBe(4)
    expect(obs.dispatches.length).toBe(4)

    // A car is still in flight, so the hash covers a live route, a live
    // cursor and carried progress — not just an all-idle board.
    expect(r.state.carPhase[1]).toBe(PHASE_RETURNING)
    expect(r.state.carRouteLen[1]).toBe(6)
    expect(r.state.carProgress[1]).not.toBe(0)
    expect(routeBytesOf(r.state, 1).some((b) => b !== 0)).toBe(true)

    // Nothing was refused or dropped, so the hash is over a clean run.
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
    expect(r.state.header[H_PINS_DROPPED]).toBe(0)

    // Blessed for the first time in M1c Task 6. This is the milestone's
    // deliverable: it moves for a change anywhere in demand, dispatch,
    // movement, arrivals, scoring, the route encoding, the tick order, or the
    // buffer layout. When a rule change makes it fail intentionally, re-bless
    // it in the same commit as the change, never separately.
    expect(hashState(r.state)).toBe(3896659943)
  })

  it('leaves the three existing goldens alone — this task adds a golden, it does not move one', () => {
    // "All three goldens unchanged" is a per-task obligation of this
    // milestone, and the failure mode it exists to prevent is a QUIET
    // re-bless: a task edits its own module, one of the three numbers in
    // somebody else's file moves, the number is updated in the same commit,
    // and the suite is green again with nobody the wiser.
    //
    // Asserting `[a, b, c]).toEqual([a, b, c])` here would be a test that
    // cannot fail. Scanning the two files that own the numbers CAN fail — it
    // fails the moment either literal is edited — which makes the quiet
    // re-bless cost a second, differently-located test failure that has to be
    // explained rather than absorbed. Same idiom as `determinism.test.ts`'s
    // source scans.
    const here = fileURLToPath(new URL('.', import.meta.url))
    const determinism = readFileSync(`${here}determinism.test.ts`, 'utf8')
    const rollback = readFileSync(`${here}rollback.test.ts`, 'utf8')

    expect(determinism, 'the M1c state golden moved').toContain('toBe(2413319809)')
    expect(rollback, 'the road-network golden moved').toContain('toBe(2790151213)')
    expect(rollback, 'the field golden moved — that one is a tripwire, not a re-bless').toContain(
      'toBe(252514232)',
    )
    // Vacuity: the scan is looking at real files with real content, not at two
    // empty strings that trivially fail to contain anything else either.
    expect(determinism.length).toBeGreaterThan(1000)
    expect(rollback.length).toBeGreaterThan(1000)
    expect(determinism).not.toContain('toBe(2790151213)') // the two files own different numbers
  })
})

// ---------------------------------------------------------------------------
// Re-pathing: a field whose CONTENT changes mid-flight
// ---------------------------------------------------------------------------

/**
 * The discriminator for "movement reads `dir[cell]` instead of the committed
 * route" is NOT a path that turns, and this deserves saying because an earlier
 * plan revision claimed it was. Dispatch commits `route[i] = dir[cell_i]` with
 * `cell_{i+1} = step(cell_i, route[i])`, so `dir[carCell] ===
 * route[carRouteCursor]` holds at every tick of an outbound leg BY
 * CONSTRUCTION, on a path with two turns exactly as much as on a straight
 * corridor. The discriminator is a field whose CONTENT changes mid-flight.
 *
 * This test therefore cannot live in `cars.test.ts` (no field exists there) and
 * cannot live inside the loop test above (that fixture freezes its pin timer,
 * so `destPins` is deliberately not a moving target — putting it there would
 * produce a test that cannot observe what it claims).
 *
 * The fixture, all-land 20 x 12, `cell = y * 20 + x`:
 *
 *      x:   2                 8       12
 *   row 5:  [d1]--------------+-------H0        102 .. 112, branch at 108
 *                             |
 *   row 6:                    |                 128
 *   row 7:                   [dA]                148
 *
 *   d1: origin (2,2)  orientation S, carpark (2,5) = 102, dest index 0
 *   dA: origin (8,8)  orientation N, carpark (8,7) = 148, dest index 1
 *   H0: (12,5) = 112
 *
 * Run A pins only d1. Run B pins d1, then gives dA a pin on the tick AFTER the
 * car departs — writing `destPins` directly, which is exactly the byte a pin
 * fire writes, and which makes `syncFields` rebuild with different `dir`
 * content along the in-flight car's own path: cell 108 points WEST in run A
 * and SOUTH in run B, and 108 is a cell the car stands on.
 */
const RP_D1_ORIGIN = 42 // (2,2)
const RP_DA_ORIGIN = 168 // (8,8)
const RP_D1_CARPARK = 102 // (2,5)
const RP_DA_CARPARK = 148 // (8,7)
const RP_HOUSE = 112 // (12,5)
const RP_BRANCH = 108 // (8,5) — where run B's dir turns south and run A's does not
const RP_MID = 128 // (8,6)
const RP_PIN_TICK = 3
const RP_ARRIVAL_TICK = 77 // rel_10 = 76, dispatched on tick 2
const RP_TICKS = 80

function buildRepathRig(id: string): Rig {
  const r = makeRig(id, allLandRows(W, H), STARTING_TILES)
  expect(placeDestination(r.state, r.world, RP_D1_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeDestination(r.state, r.world, RP_DA_ORIGIN, ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeHouse(r.state, r.world, RP_HOUSE, 0)).toBe(true)
  return r
}

function repathActions(tick: number): TickInputs {
  if (tick !== 1) return NO_ACTIONS
  const actions: TickAction[] = []
  for (let cell = RP_D1_CARPARK; cell < RP_HOUSE; cell++) actions.push({ kind: 'place', a: cell, b: cell + 1 })
  actions.push({ kind: 'place', a: RP_BRANCH, b: RP_MID })
  actions.push({ kind: 'place', a: RP_MID, b: RP_DA_CARPARK })
  return { actions }
}

describe('a car paths once at departure and does not re-target when the field changes under it', () => {
  it('follows its committed route cell for cell even when a nearer same-colour destination gains a pin mid-flight', () => {
    const a = buildRepathRig('repath-a')
    const b = buildRepathRig('repath-b')

    let dirDifferedAt = -1
    const cellsOccupied: number[] = []

    for (let tick = 1; tick <= RP_TICKS; tick++) {
      step(a.state, a.world, a.fields, a.scratch, repathActions(tick))
      step(b.state, b.world, b.fields, b.scratch, repathActions(tick))
      if (tick === 1) {
        a.state.destPins[0] = 1
        b.state.destPins[0] = 1
      }
      if (tick === RP_PIN_TICK) {
        // Run B only: the nearer destination gains a pin, one tick after the
        // car departed. `destPins` is a FIELD_INPUT region, so the next sync
        // rebuilds — and the rebuild changes `dir` under the car.
        b.state.destPins[1] = 1
      }

      // Compared INSIDE the loop, not collected and diffed at the end: a
      // re-pathing car eventually walks onto a source cell where `dir` is -1
      // and `edgeCost` throws, and a throw would abort a trailing comparison
      // before it ever ran. Failing on the divergence TICK is the point.
      expect(b.state.carCell[0], `carCell diverged on tick ${tick}`).toBe(a.state.carCell[0] as number)
      expect(b.state.carRouteCursor[0], `cursor diverged on tick ${tick}`).toBe(
        a.state.carRouteCursor[0] as number,
      )
      const cell = a.state.carCell[0] as number
      if (!cellsOccupied.includes(cell)) cellsOccupied.push(cell)

      if (tick === RP_PIN_TICK + 1) {
        // Vacuity: without this the whole test is a tautology — if the second
        // pin changed no `dir` byte on the car's path, "the traces agree" says
        // nothing at all.
        //
        // Read one tick AFTER the pin is written, not on the same tick: the
        // write lands after `step` returns, so the tick-3 field was built from
        // `destPins[1] = 0` and `fieldFor` would (correctly) call it stale.
        // Tick 4 is the first sync that sees the new pin.
        const fa = fieldFor(a.state, a.world, a.fields, 0, a.scratch)
        const fb = fieldFor(b.state, b.world, b.fields, 0, b.scratch)
        expect(fa.dir[RP_BRANCH]).toBe(6) // W: run A's only source is d1, to the west
        expect(fb.dir[RP_BRANCH]).toBe(4) // S: run B's nearer source is dA, down the branch
        if ((fa.dir[RP_BRANCH] as number) !== (fb.dir[RP_BRANCH] as number)) dirDifferedAt = RP_BRANCH
      }
    }

    expect(dirDifferedAt, 'the second pin must genuinely change dir on the car`s path').toBe(RP_BRANCH)
    expect(cellsOccupied).toContain(RP_BRANCH)

    // Same arrival tick, same destination, standing on its carpark.
    expect(a.state.carTargetDest[0]).toBe(0)
    expect(b.state.carTargetDest[0]).toBe(0)
    expect(a.state.carCell[0]).toBe(RP_D1_CARPARK)
    expect(b.state.carCell[0]).toBe(RP_D1_CARPARK)
    expect(a.state.carPhase[0]).toBe(PHASE_RETURNING)
    expect(b.state.carPhase[0]).toBe(PHASE_RETURNING)

    // And the second pin was not inert: run B dispatched a SECOND car to the
    // new destination off the rebuilt field, which is what proves the field
    // really was live and really did point at dA.
    expect(a.state.carPhase[1]).toBe(PHASE_IDLE)
    expect(b.state.carTargetDest[1]).toBe(1)
  })

  it('arrives on the hand-computed tick in both runs, not merely on the same one', () => {
    // "The same tick" is satisfied by two identically-wrong runs. The literal
    // is the assertion: 10 orthogonal cells, rel_10 = ceil(10 * 2500 / 330) =
    // 76, dispatched on tick 2, so the outbound leg ends on tick 77.
    const a = buildRepathRig('repath-tick-a')
    const b = buildRepathRig('repath-tick-b')
    let arrivalA = -1
    let arrivalB = -1
    for (let tick = 1; tick <= RP_TICKS; tick++) {
      step(a.state, a.world, a.fields, a.scratch, repathActions(tick))
      step(b.state, b.world, b.fields, b.scratch, repathActions(tick))
      if (tick === 1) {
        a.state.destPins[0] = 1
        b.state.destPins[0] = 1
      }
      if (tick === RP_PIN_TICK) b.state.destPins[1] = 1
      if (arrivalA < 0 && (a.state.carPhase[0] as number) === PHASE_RETURNING) arrivalA = tick
      if (arrivalB < 0 && (b.state.carPhase[0] as number) === PHASE_RETURNING) arrivalB = tick
    }
    expect(arrivalA).toBe(RP_ARRIVAL_TICK)
    expect(arrivalB).toBe(RP_ARRIVAL_TICK)
    // Vacuity: a 10-step route is genuinely what was committed, so the tick
    // above is the arithmetic this file's header derives and not a coincidence.
    expect(a.state.carRouteLen[0]).toBe(10)
    expect(a.state.carRouteLen[0]).toBeLessThan(MAX_PATH_LEN)
  })
})

// ---------------------------------------------------------------------------
// Phase 1 and phase 3: the two positions the loop fixture is blind to
// ---------------------------------------------------------------------------

/**
 * The loop fixture freezes its pin timer, which buys stable `destPins` under
 * every assertion above and costs it all sight of where phase 1 sits: `H_TICK`
 * is read inside a tick by exactly one thing — demand's eligibility gate — and
 * a frozen timer pushes `destSpawnTick` out of reach so the gate never changes
 * state. Only a run that CROSSES the 120-tick boundary can see it.
 *
 * Task 3's demand tests cannot substitute: they call `runDemand` directly,
 * never through `step`, so they see no phase order at all.
 *
 * The fixture, 8 x 8 all-land, `cell = y * 8 + x`:
 *
 *   destination origin (0,0) orientation S -> footprint x0..1 y0..2,
 *   carpark (0,3) = 24; house (3,3) = 27; road 27-26-25-24.
 */
const BD_DEST_ORIGIN = 0
const BD_CARPARK = 24 // (0,3)
const BD_HOUSE = 27 // (3,3)

function buildBoundaryRig(id: string): Rig {
  const r = makeRig(id, allLandRows(8, 8), 99, 2)
  expect(placeDestination(r.state, r.world, BD_DEST_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeHouse(r.state, r.world, BD_HOUSE, 0)).toBe(true)
  expect(r.state.destSpawnTick[0]).toBe(0)
  // One square = one rotation slot, so the accumulator needs exactly one
  // eligible tick to cross. `PIN_PERIOD_TICKS - slotCount`.
  r.state.pinAccum[0] = PIN_PERIOD_TICKS - 1
  return r
}

function boundaryActions(tick: number): TickInputs {
  if (tick !== 1) return NO_ACTIONS
  return {
    actions: [
      { kind: 'place', a: BD_HOUSE, b: 26 },
      { kind: 'place', a: 26, b: 25 },
      { kind: 'place', a: 25, b: BD_CARPARK },
    ],
  }
}

function runBoundary(r: Rig, from: number, to: number): void {
  for (let tick = from + 1; tick <= to; tick++) {
    step(r.state, r.world, r.fields, r.scratch, boundaryActions(tick))
  }
}

describe('phase 1 sits before demand: the first-pin delay is measured against the tick this tick advanced to', () => {
  it('fires the first pin on tick 120 exactly — not 119, and not 121', () => {
    expect(FIRST_PIN_DELAY_TICKS).toBe(120) // vacuity: the boundary really is at 120
    const r = buildBoundaryRig('boundary')

    runBoundary(r, 0, FIRST_PIN_DELAY_TICKS - 1)
    expect(r.state.header[H_TICK]).toBe(119)
    expect(r.state.destPins[0]).toBe(0)
    // Vacuity: the accumulator genuinely did not advance while the
    // destination was ineligible, so "0 pins" is the gate holding rather than
    // the accumulator being nowhere near its threshold.
    expect(r.state.pinAccum[0]).toBe(PIN_PERIOD_TICKS - 1)

    runBoundary(r, FIRST_PIN_DELAY_TICKS - 1, FIRST_PIN_DELAY_TICKS)
    expect(r.state.header[H_TICK]).toBe(120)
    expect(r.state.destPins[0]).toBe(1)
    expect(r.state.pinAccum[0]).toBe(0)
  })
})

describe('phase 3 sits before phase 4: a pin fired by demand is served by dispatch on the SAME tick', () => {
  it('dispatches a car on tick 120, the tick the pin fires, with no stale-field throw in between', () => {
    const r = buildBoundaryRig('same-tick')
    runBoundary(r, 0, FIRST_PIN_DELAY_TICKS - 1)
    expect(r.state.destPins[0]).toBe(0) // vacuity: nothing to serve yet
    expect(r.state.carPhase[0]).toBe(PHASE_IDLE)

    // demand (3) -> assemble + sync (4) -> dispatch (5), all inside one tick.
    // Syncing BEFORE demand leaves the field built from `destPins = 0` while
    // dispatch reads it with `destPins = 1`, and `destPins` is a FIELD_INPUT
    // region — so that ordering does not produce a wrong number here, it
    // produces `fieldFor`'s named staleness throw, which is what the plan
    // means by "misplacing the sync is a throw, not a wrong number". Asserted
    // as `not.toThrow` rather than left to surface as an uncaught error, so
    // the failure names the ordering rather than the symptom.
    expect(() => runBoundary(r, FIRST_PIN_DELAY_TICKS - 1, FIRST_PIN_DELAY_TICKS)).not.toThrow()

    expect(r.state.destPins[0]).toBe(1)
    // Assembly ran AFTER demand, so the pin that fired this tick is already a
    // source this tick. This is the arm that fails as a plain 1-vs-0.
    expect(r.scratch.sourceCounts[0]).toBe(1)
    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(r.state.carTargetDest[0]).toBe(0)
    expect(r.state.destReserved[0]).toBe(1)
    expect(r.state.carRouteLen[0]).toBe(3) // 27 -> 26 -> 25 -> 24
  })
})
