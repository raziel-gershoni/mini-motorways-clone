import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  parseMap,
  CARS_PER_HOUSE,
  DEST_SPAWN_PERIOD_TICKS,
  DEST_SPAWN_RETRY_TICKS,
  HOUSE_SPAWN_PERIOD_TICKS,
  HOUSE_SPAWN_RETRY_TICKS,
  MAX_BLOCKED_TICKS,
  MAX_PATH_LEN,
  PIN_CAP_CIRCLE_HARD,
  PIN_CAP_CIRCLE_TIMER,
  PIN_CAP_SQUARE_TIMER,
  PIN_PERIOD_TICKS,
  FIRST_PIN_DELAY_TICKS,
  ORTHO_COST,
  TICKS_PER_WEEK,
  WEEKLY_TILE_GRANT,
  type MapData,
} from '@laneways/shared'
import {
  createState,
  snapshot,
  restore,
  hashState,
  H_DEST_COUNT,
  H_DEST_SPAWN_TIMER,
  H_EPOCH,
  H_FAILED_DEST,
  H_GAME_OVER,
  H_HOUSE_COUNT,
  H_PINS_DROPPED,
  H_ROUTES_REFUSED,
  H_SCORE,
  H_SPAWN_COLOUR_CURSOR,
  H_TICK,
  H_TILES,
  H_WEEK,
  HEADER_LENGTH,
  isGameOver,
  type GameState,
} from '../src/state'
import { spawnZoneCells } from '../src/spawn'
import { createWorld, type WorldData } from '../src/world'
import { createFieldInputRanges } from '../src/regions'
import { createScratch, createFlowFields, type FlowField, type Scratch } from '../src/scratch'
import { fieldFor, hashFieldInputRegions } from '../src/flowfield'
import { roadMask, tilesLeft, dirBetween, LANE_OF_DIR, OPPOSITE, DX, DY } from '../src/roads'
import {
  canEnter,
  occupantOf,
  assertOccupancyConsistent,
  EnterOutcome,
  FREE,
} from '../src/blocking'
import {
  placeHouse,
  placeDestination,
  DEST_KIND_CIRCLE,
  DEST_KIND_SQUARE,
  ORIENTATION_N,
  ORIENTATION_S,
  PHASE_IDLE,
  PHASE_NONE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
} from '../src/buildings'
import { ROUTE_BYTES, routeStep } from '../src/dispatch'
import { step, type TickAction, type TickInputs } from '../src/step'
import { pinPeriodForWeek } from '../src/demand'
import { hashBytes } from '../src/hash'
import { m1eInsertedRanges, spliceM1eInsertions } from './m1eSplice'

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
 *
 * ---------------------------------------------------------------------------
 * THE SAME TIMELINE UNDER M1d's BLOCKING — RE-DERIVED, NOT INHERITED
 * ---------------------------------------------------------------------------
 *
 * M1d makes cell entry conditional: `canEnter` (blocking.ts) grants a crossing
 * into `cell` in direction `dir` only if the slot `(cell, LANE_OF_DIR[dir])` is
 * free. **The first revision of M1d's plan used ONE undirected slot per cell
 * and that killed this fixture** — car 0 returning east and car 1 heading west
 * would deadlock on cell 113 at tick 73, the valve would not release them until
 * tick 1,423 against `RUN_TICKS = 150`, and the four observation arrays, the
 * `scoreAfterTick` ladder, the not-nearest-house test, the mid-flight
 * `carPhase[1]` assertion, the idle-hygiene count and the golden would all
 * become physically unachievable. Under Decision 1's TWO lanes that deadlock
 * does not exist, and Task 6's job was to prove that rather than inherit it.
 * Recomputed from scratch, every value, with `abs = dispatchTick + rel_k - 1`:
 *
 *   car 0 (H0 116, dispatched 2)  out W  115@9   114@17  113@24  112@32  111@39 110@47
 *   car 0                         ret E  111@55  112@62  113@70  114@77  115@85 116@92  (SCORE)
 *   car 1 (H0 116, dispatched 51) out W  115@58  114@66  113@73  112@81  111@88 110@96
 *   car 1                         ret E  111@104 112@111 113@119 114@126 115@134 116@141 (SCORE)
 *   car 2 (H1 105, dispatched 2)  out W  104@9   103@17  102@24;  ret E 103@32 104@39 105@47 (SCORE)
 *   car 2 (dispatched 51)         out W  104@58  103@66  102@73;  ret E 103@81 104@88 105@96 (SCORE)
 *   car 3                         never dispatched, idle on 105 throughout
 *
 * A car holds the cell it crossed into from that tick until the tick it crosses
 * into the next one. Intersecting those holds pairwise over all 150 ticks gives
 * **exactly one cell on which two cars both hold a claim: cell 113, ticks 73 to
 * 76 inclusive.** Car 0 holds it EASTBOUND from tick 70 — `LANE_OF_DIR[E] = 0`
 * — and car 1 enters it WESTBOUND at tick 73 — `LANE_OF_DIR[W] = 1`. Different
 * lanes, so car 1 is granted; car 0 leaves for 114 on tick 77, which car 1
 * itself vacated on tick 73. Every other pair of holds on 110-116 is disjoint
 * (nearest miss: car 1 leaves 114 on tick 73 and car 0 enters it on tick 77),
 * cars 2 and 3 never leave 102-105, and the two ranges never meet. **Zero
 * refusals, zero blocked ticks, zero valve ticks, and not one literal above
 * moves.** All of that is asserted below, per tick, rather than left as prose:
 * `runScripted` now checks occupancy consistency and records every crossing,
 * every refusal and every shared-cell event on every tick of every run it
 * drives.
 *
 * **Two corrections to the interval rule as the plan states it**, because a
 * reader applying it literally arrives at a different answer:
 *
 *   - *"until the tick it enters the next"* omits occupancy lifecycle event 4.
 *     `completeTrip` releases the house cell on the arrival tick (blocking.ts),
 *     so car 0's hold on 116 ends at tick 92 rather than running to the end of
 *     the run. Without that release, car 1's arrival on 116 at tick 141 would
 *     read as a second shared-cell event. It is not one.
 *   - The rule says nothing about cells cars STAND on without having crossed.
 *     Cars 0 and 1 share 116 on ticks 1-8, and cars 2 and 3 share 105 for most
 *     of the run — Decision 3's tick-0 ruling, under which an idle car and a
 *     car that has not yet crossed on its current leg both hold nothing. Those
 *     are legal, unclaimed and invisible to occupancy. **"Shared-cell event"
 *     below therefore means what the occupancy array can see: two DIFFERENT
 *     cars named by the two lanes of one cell.**
 *
 * The positive case — a same-direction queue that genuinely refuses entries —
 * is a SECOND fixture at the bottom of this file, with a golden of its own.
 * Forcing a block into this corridor would retire the four-route cost matrix
 * the vacuity test above exists to protect, and would move the loop golden for
 * a third time.
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

/**
 * The two directions every route in this file travels in, derived through
 * `dirBetween` rather than written as 6 and 2, and then checked against
 * `DX`/`DY` — so a renumbering of `DIRS` moves both together instead of
 * silently turning "west" into something else.
 *
 * Both fixtures below are one-wide east-west corridors, which is what makes
 * `LANE_OF_DIR` injective over the directions they use: lane 1 is reached only
 * by W and lane 0 only by E. That is the premise the same-direction argument in
 * the queue fixture rests on, and it is asserted where it is used.
 */
const DIR_WEST = dirBetween(H0_CELL, H0_CELL - 1, W, H)
const DIR_EAST = OPPOSITE[DIR_WEST] as number

/** Cell 113, ticks 73-76: the loop fixture's one and only shared-cell event. */
const HEAD_ON_CELL = 113
const HEAD_ON_FIRST_TICK = 73
const HEAD_ON_LAST_TICK = 76

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

/**
 * **The spawn posture both goldens in this file now carry, and why they carry
 * it at all.**
 *
 * The plan's golden table (line 394) predicted that neither of these two
 * goldens moves in M1e Task 5, and its derivation was *"every other fixture
 * runs inside week 0 and below the first spawn attempt at tick 300"*. That is
 * true and it is not sufficient. `H_DEST_SPAWN_TIMER` and `houseSpawnTimer` are
 * COUNTDOWNS, not last-spawn stamps (`spawn.ts`'s `runSpawn` says why), so they
 * decrement on **every tick from tick 1**, whether or not an attempt ever fires
 * — and both are hashed bytes. A 130-tick fixture on which nothing can possibly
 * spawn therefore still moves its whole-buffer digest, by exactly two families
 * of slots and no others.
 *
 * So both goldens below were re-blessed in Task 5, and this function is what
 * makes those re-blesses non-absorbing. It asserts, by hand-computed value:
 *
 *   - the destination countdown is `DEST_SPAWN_PERIOD_TICKS - tick`;
 *   - every house countdown is `HOUSE_SPAWN_PERIOD_TICKS - tick`;
 *   - the colour cursor has NOT moved, because no attempt fired;
 *   - nothing was placed — the building counts are the fixture's own;
 *   - Task 3's two regions and Task 8's two header slots are untouched.
 *
 * Together with the splice assertion each golden already carries — which
 * reproduces the pre-M1e digest and so proves that no byte OUTSIDE Task 1's two
 * inserted ranges moved — that pins every byte the re-bless could hide.
 *
 * The vacuity guard is `tick < HOUSE_SPAWN_PERIOD_TICKS`: past the first
 * attempt these formulas stop being the arithmetic and this helper would
 * silently assert the wrong thing.
 */
function assertNoSpawnHappened(r: Rig, tick: number, houses: number, dests: number): void {
  expect(r.state.header[H_TICK], 'the fixture did not reach the tick this posture is stated at').toBe(tick)
  expect(tick, 'this helper is only correct below the first house attempt').toBeLessThan(
    HOUSE_SPAWN_PERIOD_TICKS,
  )
  // Vacuity in the other direction: the zone is NOT empty on this map, so the
  // spawner is genuinely being refused by the clock rather than structurally
  // absent the way it is on `determinism.test.ts`'s 4x4 board.
  expect(spawnZoneCells(r.world), 'a 20x12 board clips the rect to 14x3, not to nothing').toBe(42)
  expect(r.state.header[H_DEST_SPAWN_TIMER]).toBe(DEST_SPAWN_PERIOD_TICKS - tick)
  for (let c = 0; c < r.map.groupCount; c++) {
    expect(r.state.houseSpawnTimer[c], `colour ${c}`).toBe(HOUSE_SPAWN_PERIOD_TICKS - tick)
  }
  expect(r.state.header[H_SPAWN_COLOUR_CURSOR], 'no attempt fired, so no colour was chosen').toBe(0)
  // **These two cannot fail on either fixture and are kept as a statement of
  // posture, not as evidence.** Checked directly: with the house timers forced
  // to fire from tick 50, this 20x12 board still places nothing — colour 0 is
  // capped at 2 houses against 2 destinations (1 against 1 on the queue
  // fixture), and no other colour is unlocked inside week 0. **The TIMER arms
  // above are what carry the "nothing was placed" claim**; these two would only
  // start discriminating on a fixture where a spawn is possible.
  expect(r.state.header[H_HOUSE_COUNT], 'the spawner placed a house').toBe(houses)
  expect(r.state.header[H_DEST_COUNT], 'the spawner placed a destination').toBe(dests)
  expect(r.state.header[H_GAME_OVER]).toBe(0)
  expect(r.state.header[H_FAILED_DEST]).toBe(0)
  expect(r.state.destOvercrowd.every((v) => v === 0)).toBe(true)
  expect(r.state.destOverTicks.every((v) => v === 0)).toBe(true)
}

/** Header slot indices whose value differs from `before`, in ascending index order. */
function headerSlotsThatMoved(before: readonly number[], state: GameState): number[] {
  const moved: number[] = []
  for (let i = 0; i < HEADER_LENGTH; i++) {
    if ((state.header[i] as number) !== (before[i] as number)) moved.push(i)
  }
  return moved
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
  /**
   * M1d Task 6. Every cell crossing, as `tick=T car=I from->to dir=D`, with the
   * direction read back through `dirBetween` rather than through the route
   * nibbles — so this observes where the car actually WENT rather than
   * re-decoding what it was told to do.
   */
  readonly crossings: string[]
  /**
   * M1d Task 6. Every tick on which a car's `carBlockedTicks` is non-zero,
   * which is an exact detector for "this car was refused an entry on this
   * tick": `advanceCar` raises the counter on a refusal and `noteEntryGranted`
   * zeroes it on any grant, so a non-zero value after a tick means that tick.
   */
  readonly refusals: string[]
  /**
   * M1d Task 6. Every tick on which two DIFFERENT cars are named by the two
   * lanes of one cell — the only kind of shared cell the occupancy array can
   * see. Cars stacked on a house cell without having crossed hold nothing and
   * do not appear here; see this file's header for why that distinction is the
   * one that matters.
   */
  readonly sharedCells: string[]
  /**
   * M1d Task 6. `assertOccupancyConsistent`'s completeness count, per tick.
   * Recorded rather than discarded because that half holds vacuously over a
   * board where no car has crossed: a caller has to be able to show it ranged
   * over somebody.
   */
  readonly completeChecked: number[]
  /**
   * M1e Task 6. Every tick on which demand's accumulator crossed its
   * threshold, one entry per fire.
   *
   * **Counted by CONSERVATION, not by watching `destPins` rise.** One tick can
   * carry both a fire (phase 5, `destPins` +1 or `H_PINS_DROPPED` +1) and an
   * arrival (phase 9, `destPins` -1), and the net delta on such a tick is zero
   * — so a rising-edge detector would silently drop that fire, which is
   * precisely the failure a fire LADDER exists to catch. `delivered + consumed
   * + dropped` is exact whatever order the two land in, and the demand golden
   * below cross-checks the total against the end state independently.
   *
   * **The `consumed` term has a witness, because without one it is decoration
   * that reads as defence.** Measured: dropping it from the sum leaves all
   * 1,710 tests green on the fixtures that existed when it was written — no
   * tick in the demand golden or in the first four coping arms carries both
   * events. The week-10 arm does, twice, and it is in the arm list for that
   * reason and asserts it by name.
   */
  readonly fireTicks: number[]
  /**
   * M1e Task 6. `sum(destPins)` after every tick — the standing backlog, which
   * is what "the network stops coping" is a statement about. A peak read off
   * the END state cannot see it: a board that saturated and then drained looks
   * identical to one that never filled.
   */
  readonly pinsHeldAfterTick: number[]
}

function newObservations(): Observations {
  return {
    dispatches: [],
    pinsConsumed: [],
    scores: [],
    violations: [],
    scoreAfterTick: [],
    crossings: [],
    refusals: [],
    sharedCells: [],
    completeChecked: [],
    fireTicks: [],
    pinsHeldAfterTick: [],
  }
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
 * What a run's inputs are, as two pure functions of the tick number.
 *
 * Extracted at M1d Task 6 so the same-direction queue fixture at the bottom of
 * this file is driven through the SAME runner as the loop fixture, and
 * therefore inherits every per-tick invariant it checks — the allowed phase
 * transitions, `sum(destReserved) === count(PHASE_OUTBOUND)`, the
 * per-destination pin bound, monotone score, `H_TICK`, `H_EPOCH`, and now
 * occupancy consistency. A second copy of that loop would have been a second
 * place for one of those checks to be missing.
 */
interface Script {
  readonly actions: (tick: number) => TickInputs
  readonly pins: (state: GameState, tick: number) => void
}

const LOOP_SCRIPT: Script = { actions: actionsForTick, pins: applyScriptedPins }

/**
 * Steps `state` from tick `from + 1` through tick `to`, applying the script,
 * and records every phase transition plus the per-tick invariants.
 *
 * Violations are COLLECTED rather than asserted per car per tick: 150 ticks x
 * 80 cars is 12,000 assertions, and an empty-array comparison at the end
 * reports the first offender with its tick and car index just as precisely.
 *
 * **M1d Task 6 adds four occupancy observations and one hard assertion.**
 * `assertOccupancyConsistent` throws rather than collecting, in the house style
 * of `assertSymmetric` / `assertArrivalHonoured`: a slot naming a car that is
 * not standing on that cell is a corrupted array, not a bad outcome, and the
 * run after it is not worth continuing. Its completeness half is checked
 * unconditionally here because neither fixture in this file ever fires the
 * valve — the only source of a legitimate completeness gap (blocking.ts) — and
 * both assert that they do not.
 */
function runScripted(r: Rig, from: number, to: number, obs: Observations, script: Script = LOOP_SCRIPT): void {
  const before = new Uint8Array(r.state.carPhase.length)
  const beforeCell = new Int32Array(r.state.carCell.length)
  const beforePins = new Uint8Array(r.state.destPins.length)
  let previousScore = r.state.header[H_SCORE] as number
  for (let tick = from + 1; tick <= to; tick++) {
    before.set(r.state.carPhase)
    beforeCell.set(r.state.carCell)
    beforePins.set(r.state.destPins)
    const targetBefore = Array.from(r.state.carTargetDest)
    const droppedBefore = r.state.header[H_PINS_DROPPED] as number
    let consumedThisTick = 0

    step(r.state, r.world, r.fields, r.scratch, script.actions(tick))
    // Read the pin ledger's two step-side terms BEFORE `script.pins` runs, so
    // `fireTicks` means "the demand module fired" on every fixture in this
    // file rather than "the demand module fired, or the test wrote a pin".
    // The loop fixture's script writes two pin waves by hand; counting those
    // as fires would make this observation mean something different on each
    // of the three fixtures that share this runner.
    let deliveredByStep = 0
    for (let d = 0; d < (r.state.header[H_DEST_COUNT] as number); d++) {
      deliveredByStep += (r.state.destPins[d] as number) - (beforePins[d] as number)
    }
    const droppedByStep = (r.state.header[H_PINS_DROPPED] as number) - droppedBefore
    script.pins(r.state, tick)

    obs.completeChecked.push(assertOccupancyConsistent(r.state, r.world))
    for (let cell = 0; cell < r.world.cells; cell++) {
      const lane0 = occupantOf(r.state, cell, 0)
      const lane1 = occupantOf(r.state, cell, 1)
      if (lane0 !== FREE && lane1 !== FREE && lane0 !== lane1) {
        obs.sharedCells.push(`tick=${tick} cell=${cell} lane0=car${lane0} lane1=car${lane1}`)
      }
    }

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
        consumedThisTick++
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

      // M1d Task 6's two occupancy observations, per car per tick.
      const blocked = r.state.carBlockedTicks[i] as number
      if (blocked !== 0) {
        obs.refusals.push(`tick=${tick} car=${i} blocked=${blocked} cell=${r.state.carCell[i]}`)
      }
      const wasCell = beforeCell[i] as number
      const nowCell = r.state.carCell[i] as number
      if (nowCell !== wasCell) {
        const dir = dirBetween(wasCell, nowCell, r.world.w, r.world.h)
        obs.crossings.push(`tick=${tick} car=${i} ${wasCell}->${nowCell} dir=${dir}`)
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

    // M1e Task 6's fire ledger, by conservation — see `Observations.fireTicks`.
    const firesThisTick = deliveredByStep + consumedThisTick + droppedByStep
    for (let f = 0; f < firesThisTick; f++) obs.fireTicks.push(tick)

    let held = 0
    for (let d = 0; d < (r.state.header[H_DEST_COUNT] as number); d++) {
      held += r.state.destPins[d] as number
    }
    obs.pinsHeldAfterTick.push(held)

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

    const movedOnTheTripTick = headerSlotsThatMoved(before, r.state)
    // H_TICK and H_DEST_SPAWN_TIMER because TIME PASSED — the spawn countdown
    // decrements on every tick from tick 1 (M1e Task 5), exactly as the tick
    // counter increments, and neither is a score. H_SCORE because a trip
    // completed. Nothing else.
    expect(movedOnTheTripTick).toEqual([H_TICK, H_SCORE, H_DEST_SPAWN_TIMER])
    expect((r.state.header[H_SCORE] as number) - (before[H_SCORE] as number)).toBe(1)

    // **The claim in this test's NAME is the difference between the two sets,
    // not the first one** — and stating it that way is what keeps it as strong
    // as it was before the countdown joined the time-driven slots. On the very
    // next tick no trip completes, and exactly the two time-driven slots move.
    // So `H_SCORE` is the only header slot in the game that answers to a
    // completed trip, which is what a second score counter would break.
    const beforeQuietTick = Array.from(r.state.header)
    runScripted(r, 47, 48, obs)
    expect(
      (r.state.header[H_SCORE] as number) - (beforeQuietTick[H_SCORE] as number),
      'vacuity: tick 48 must NOT complete a trip, or the contrast says nothing',
    ).toBe(0)
    expect(headerSlotsThatMoved(beforeQuietTick, r.state)).toEqual([H_TICK, H_DEST_SPAWN_TIMER])
  })

  it('has exactly one shared-cell event in 150 ticks — cars 0 and 1 on cell 113, ticks 73-76, in opposite lanes', () => {
    // **The fixture's single most valuable property under M1d, and it was
    // unasserted until this task.** A change back to one undirected slot per
    // cell stalls this pair for `MAX_BLOCKED_TICKS` = 1,350 ticks against a
    // 150-tick run, and without this test the only signal would be a moved
    // golden — which is exactly the signal a standing re-bless licence absorbs.
    //
    // Decision 1's table is what makes it work, so it is checked here rather
    // than referred to: the two directions this corridor uses are exact
    // opposites and they land in DIFFERENT lanes.
    expect(DX[DIR_WEST]).toBe(-1)
    expect(DY[DIR_WEST]).toBe(0)
    expect(DX[DIR_EAST]).toBe(1)
    expect(DY[DIR_EAST]).toBe(0)
    expect(OPPOSITE[DIR_WEST]).toBe(DIR_EAST)
    expect(LANE_OF_DIR[DIR_EAST]).toBe(0)
    expect(LANE_OF_DIR[DIR_WEST]).toBe(1)
    expect(LANE_OF_DIR[DIR_EAST]).not.toBe(LANE_OF_DIR[DIR_WEST])

    const r = buildLoopFixture()
    const obs = newObservations()

    // One tick BEFORE the meeting: car 0 already holds 113 eastbound and car 1
    // is still one cell east of it. Without this the co-location below would be
    // satisfied by a car that had been sitting there since tick 24.
    runScripted(r, 0, HEAD_ON_FIRST_TICK - 1, obs)
    expect(r.state.carCell[0]).toBe(HEAD_ON_CELL)
    expect(r.state.carCell[1]).toBe(HEAD_ON_CELL + 1)
    expect(occupantOf(r.state, HEAD_ON_CELL, LANE_OF_DIR[DIR_EAST] as number)).toBe(0)
    expect(occupantOf(r.state, HEAD_ON_CELL, LANE_OF_DIR[DIR_WEST] as number)).toBe(FREE)

    // The meeting tick itself: both cars on cell 113, each named by the lane
    // its own direction of travel claims.
    runScripted(r, HEAD_ON_FIRST_TICK - 1, HEAD_ON_FIRST_TICK, obs)
    expect(r.state.carCell[0]).toBe(HEAD_ON_CELL)
    expect(r.state.carCell[1]).toBe(HEAD_ON_CELL)
    expect(occupantOf(r.state, HEAD_ON_CELL, LANE_OF_DIR[DIR_EAST] as number)).toBe(0)
    expect(occupantOf(r.state, HEAD_ON_CELL, LANE_OF_DIR[DIR_WEST] as number)).toBe(1)
    expect(r.state.carPhase[0]).toBe(PHASE_RETURNING) // car 0 is the one heading east
    expect(r.state.carPhase[1]).toBe(PHASE_OUTBOUND)

    runScripted(r, HEAD_ON_FIRST_TICK, RUN_TICKS, obs)
    expect(obs.violations).toEqual([])

    // The crossings that put them there, by direction, read back from where the
    // cars actually went.
    expect(obs.crossings).toContain(`tick=70 car=0 112->${HEAD_ON_CELL} dir=${DIR_EAST}`)
    expect(obs.crossings).toContain(`tick=73 car=1 114->${HEAD_ON_CELL} dir=${DIR_WEST}`)

    // ONE event, four ticks, and nothing else anywhere on the board for 150
    // ticks. Asserted as the whole list rather than as a count: a count would
    // be satisfied by four ticks on the wrong cell.
    expect(obs.sharedCells).toEqual([
      `tick=73 cell=${HEAD_ON_CELL} lane0=car0 lane1=car1`,
      `tick=74 cell=${HEAD_ON_CELL} lane0=car0 lane1=car1`,
      `tick=75 cell=${HEAD_ON_CELL} lane0=car0 lane1=car1`,
      `tick=76 cell=${HEAD_ON_CELL} lane0=car0 lane1=car1`,
    ])
    expect(HEAD_ON_LAST_TICK).toBe(76)

    // Car 0 leaves for 114 on tick 77 — a cell car 1 itself vacated on tick 73,
    // which is the nearest miss anywhere in this run and the one a one-slot
    // world would turn into the second half of the deadlock.
    expect(obs.crossings).toContain(`tick=77 car=0 ${HEAD_ON_CELL}->114 dir=${DIR_EAST}`)
    expect(obs.crossings).toContain(`tick=73 car=1 114->${HEAD_ON_CELL} dir=${DIR_WEST}`)

    // And neither car was ever refused — not on these four ticks, not on any.
    expect(obs.refusals).toEqual([])
  })

  it('runs 150 ticks without refusing a single entry, with occupancy consistent and non-vacuously complete throughout', () => {
    const r = buildLoopFixture()
    const obs = newObservations()
    runScripted(r, 0, RUN_TICKS, obs)
    expect(obs.violations).toEqual([])

    // `carBlockedTicks` is 0 for every car at every tick. `obs.refusals` is
    // populated from that region after every tick of the run, so an empty list
    // IS the per-tick claim rather than an end-state snapshot of it.
    expect(obs.refusals).toEqual([])
    for (let i = 0; i < r.state.carBlockedTicks.length; i++) {
      expect(r.state.carBlockedTicks[i], `car ${i} ended with a non-zero blocked counter`).toBe(0)
    }

    // `assertOccupancyConsistent` ran on all 150 ticks and would have thrown.
    // Its completeness half holds vacuously over a board where nobody has
    // crossed, so the count it ranged over is asserted too: three cars are in
    // flight and claim-holding at the peak (0, 1 and 2 during the second wave).
    expect(obs.completeChecked.length).toBe(RUN_TICKS)
    expect(Math.max(...obs.completeChecked)).toBe(3)
    expect(obs.completeChecked[0]).toBe(0) // and it genuinely starts empty

    // Every crossing in the run is one of the two directions the corridor
    // admits, in both of them — which is what makes the head-on above a head-on
    // rather than two cars that happened to overlap.
    const offAxis = obs.crossings.filter(
      (c) => !c.endsWith(`dir=${DIR_WEST}`) && !c.endsWith(`dir=${DIR_EAST}`),
    )
    expect(offAxis).toEqual([])
    expect(obs.crossings.some((c) => c.endsWith(`dir=${DIR_WEST}`))).toBe(true)
    expect(obs.crossings.some((c) => c.endsWith(`dir=${DIR_EAST}`))).toBe(true)
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
    // WHICH cell it is mid-flight on, recomputed for M1d Task 6 rather than
    // left as "somewhere": car 1 entered 114 on tick 126 and leaves for 115 on
    // tick 134, so tick 130 finds it on 114 with a live claim in lane 0. "A car
    // is in flight" is satisfied by a car anywhere on the corridor; this is
    // not, and it is the assertion that would fail first if a refusal appeared
    // anywhere in the run and shifted the ladder by a tick.
    expect(r.state.carCell[1]).toBe(114)
    expect(occupantOf(r.state, 114, LANE_OF_DIR[DIR_EAST] as number)).toBe(1)
    expect(r.state.carBlockedTicks[1]).toBe(0)

    // Nothing was refused or dropped, so the hash is over a clean run.
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
    expect(r.state.header[H_PINS_DROPPED]).toBe(0)

    // Blessed for the first time in M1c Task 6. This is the milestone's
    // deliverable: it moves for a change anywhere in demand, dispatch,
    // movement, arrivals, scoring, the route encoding, the tick order, or the
    // buffer layout. When a rule change makes it fail intentionally, re-bless
    // it in the same commit as the change, never separately.
    //
    // **Re-blessed in M1e Task 1 (was 2942219448 at M1d Task 5; 452702392 at
    // M1d Task 2; 3896659943 at M1c), and AGAIN in M1e Task 5 (was
    // 3806414869).**
    //
    // **The Task 5 move was NOT predicted, and the prediction's error is worth
    // more than the number.** The plan's golden table and the previous version
    // of this paragraph both said this golden moves in no other task of the
    // milestone, on the reasoning that *"the fixture runs inside week 0 and
    // below the first spawn attempt, so nothing M1e adds can fire in it"*.
    // Nothing did fire — and the digest moved anyway, because the two spawn
    // timers are COUNTDOWNS and count down on every tick from tick 1 whether an
    // attempt fires or not. The derivation asked "does anything spawn" when the
    // question a whole-buffer digest asks is "does any byte move".
    // `assertNoSpawnHappened` above pins every byte that did, by hand-computed
    // value, so this re-bless can absorb nothing.
    //
    // **PURE LAYOUT, proved by an exact byte splice** (see `m1eSplice.ts`) —
    // and **this is the fixture that proves it hardest**, because unlike the
    // four static goldens, 130 real ticks of dispatch, movement, arrivals and
    // scoring have run here with a car mid-flight. Removing the two inserted
    // ranges — 16 B of new header slots at offset 52 and 148 B of new regions
    // at offset 1,676, both MID-BUFFER — reproduces 2942219448 bit-for-bit
    // with no slot zeroed, so not one byte of any pre-existing region moved
    // across a live trip loop, occupancy included. `createState`'s two initial
    // timer writes land inside those ranges, so there is no behavioural term.
    // Offsets are FOR THIS FIXTURE: 20x12, whole buffer 8,068 -> 8,232 B. It
    // shares block B's 148 B with `firstCity` (same groupCount 5 and
    // maxDestinations 16) and shares neither offset nor buffer size with the
    // two 2-colour goldens in `determinism.test.ts` and `rollback.test.ts`.
    // Every behavioural literal above is likewise unchanged, and the field
    // golden did not move.
    //
    // The fixture never erases a road, so **both ghost regions are all-zero**
    // — asserted rather than assumed, because a golden that moved partly for
    // layout and partly for a stray ghost write would be indistinguishable
    // from one that moved purely for layout.
    expect(r.state.ghostMask.every((b) => b === 0), 'the loop fixture erases nothing').toBe(true)
    expect(r.state.ghostCommitted.every((b) => b === 0)).toBe(true)
    assertNoSpawnHappened(r, GOLDEN_TICK, 2, 2)
    const m1e = m1eInsertedRanges(r.map)
    expect([m1e.aStart, m1e.aEnd, m1e.bStart, m1e.bEnd]).toEqual([52, 68, 1676, 1824])
    const spliced = spliceM1eInsertions(r.state, r.map)
    expect(spliced.length, "the splice must land on M1d's buffer size").toBe(8068)
    expect(m1e.totalBytes).toBe(8232)
    expect(hashBytes(spliced), 'the splice must reproduce the pre-M1e digest').toBe(2942219448)
    expect(hashState(r.state)).toBe(1877236894)
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

    // **M1e Task 1 had to change the SHAPE of these three needles, not just
    // the numbers in them, and the reason is a live instance of the
    // catalogue's "a source scan matches comments, not just code".** Each of
    // those files now carries a splice proof that asserts its own PRIOR digest
    // — `expect(hashBytes(spliced), ...).toBe(340556353)` — so the old bare
    // `toContain('toBe(340556353)')` would have gone on matching after the
    // re-bless and reported the state golden unmoved while it had moved. The
    // needle is now the whole golden expression, `hashState(...)` included,
    // which the prior-digest line cannot satisfy. Do not simplify these back
    // to bare numbers.
    // **M1e Task 2 moved the state golden a second time — 3507307907 ->
    // 883875991 — and this needle is the cross-file half of that re-bless.**
    // Task 1's move was pure layout; Task 2's is the weekly tile grant, which
    // this 13,499-tick fixture takes twice.
    // **M1e Task 5 moved it a third and final time — 883875991 -> 1058753394 —
    // for the spawn timers cycling, which is the last move the plan's golden
    // table licenses in this milestone. A fourth from any task is a defect.**
    expect(determinism, 'the state golden moved').toContain('expect(hashState(s)).toBe(1058753394)')
    expect(rollback, 'the road-network golden moved').toContain(
      'expect(hashState(state)).toBe(2312109239)',
    )
    expect(rollback, 'the field golden moved — that one is a tripwire, not a re-bless').toContain(
      'expect(foldedFieldsHash(fields)).toBe(252514232)',
    )
    // Vacuity: the scan is looking at real files with real content, not at two
    // empty strings that trivially fail to contain anything else either.
    expect(determinism.length).toBeGreaterThan(1000)
    expect(rollback.length).toBeGreaterThan(1000)
    // The two files own different numbers, and the direction matters:
    // `determinism.test.ts` must not contain the ROAD-NETWORK golden, which is
    // `rollback.test.ts`'s. Asserted on the bare digest rather than on the
    // whole expression, because this arm wants to catch that number being
    // COPIED into the wrong file in any form, comment included — which is the
    // opposite requirement from the three assertions above, and the reason it
    // is spelled differently.
    expect(determinism, "the road-network golden turned up in the state golden's file").not.toContain(
      '2312109239',
    )
    // And the M1e re-bless PROOF must survive alongside the number it
    // licenses. Deleting the splice assertion is the cheapest way to make a
    // future layout re-bless unfalsifiable again, and it leaves every other
    // test in the repo green — so the retired digest's one code-level
    // occurrence in each file is pinned here, by name.
    expect(determinism, 'the M1e splice proof left determinism.test.ts').toContain(
      "expect(hashBytes(spliced), 'the splice must reproduce the pre-M1e digest').toBe(340556353)",
    )
    expect(rollback, 'the M1e splice proof left rollback.test.ts').toContain(
      "expect(hashBytes(spliced), 'the splice must reproduce the pre-M1e digest').toBe(2076760277)",
    )
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
/**
 * The outbound arrival, hand-computed — and **M1d Task 7 moved it, for a reason
 * this fixture's own geometry creates.** `RP_BRANCH` (cell 108) carries three
 * road bits (W, E and the S spur down to `RP_MID`), so it is a degree-3 cell:
 * decision 7's intersection, worth `INTERSECTION_SPEED_MUL` = 500 on the
 * crossing that ENTERS it. That is crossing 4 of the car's ten, at
 * `speedUnits(500)` = 165 rather than 330; every other crossing is a plain
 * westward step into a degree-2 corridor cell with no turn, so nothing else
 * changes. The branch exists to make the FIELD differ mid-flight, which is what
 * this section tests, and it makes the car slower as a side effect.
 *
 * Accumulating at 330 with the carry, and 165 across crossing 4, gives relative
 * ticks 8, 16, 23, 38, 46, 53, 61, 69, 76, 84 (M1c's were 8, 16, 23, 31, 38, 46,
 * 54, 61, 69, 76). Dispatch lands on tick 2 and `abs = rel + 1`, so the outbound
 * leg ends on **85**, seven ticks later than M1c's 77.
 */
const RP_ARRIVAL_TICK = 85
/**
 * Long enough to reach the arrival and short enough that the car is still
 * STANDING on the carpark when the run ends: the return leg's first crossing is
 * at tick 92 (the flip leaves `carProgress` at 245, and 2500 - 245 needs eight
 * more ticks at 330), so this has to land in [85, 91].
 */
const RP_TICKS = 90

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
    // is the assertion: 10 orthogonal cells, nine of them entered at 330 and the
    // fourth — into the degree-3 branch cell — at 165, giving rel_10 = 84 and,
    // dispatched on tick 2, an outbound leg that ends on tick 85. See
    // `RP_ARRIVAL_TICK` for the full derivation.
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

// ---------------------------------------------------------------------------
// The same-direction queue, and a blocking golden of its own — M1d Task 6
// ---------------------------------------------------------------------------

/**
 * The loop fixture above exercises M1d's blocking primitive only in the
 * NEGATIVE: its one shared-cell event is head-on, which Decision 1 makes
 * structurally free, and it never refuses an entry. This is the positive case
 * — a SAME-DIRECTION queue that genuinely blocks — and it is a second fixture
 * rather than an edit to the first because editing that corridor to force a
 * block would retire the four-route cost matrix the vacuity test at the top of
 * this file exists to protect, and would move the loop golden for a third time
 * after both of M1d's buffer changes are already behind us.
 *
 * All-land 20 x 12 again, so `cell = y * 20 + x` — but on ROW 7 and with its
 * own geometry, so no literal from the fixture above transfers to this one:
 *
 *      x:   2                                8   9
 *   row 7:  [d]------------------------------HN--HF
 *           142                              148 149
 *
 *   d:  origin (2,4) orientation S -> footprint x2..3 y4..6, carpark (2,7) = 142
 *   HF: (9,7) = 149, house index 0 -> cars 0 and 1,  cost 7 cells = 70
 *   HN: (8,7) = 148, house index 1 -> cars 2 and 3,  cost 6 cells = 60
 *
 * **The two houses are ADJACENT, and that is the whole mechanism.** HN's cars
 * stand on the cell HF's cars must cross into first. Nothing forbids it —
 * `canPlaceHouse` has no spacing rule of its own, deliberately (buildings.ts)
 * — and it is the cheapest way to build a queue deeper than one house's
 * `CARS_PER_HOUSE`. `destPins[0] = 4` on tick 1 lets all four cars dispatch on
 * tick 2: `dist[HN] = 60 < dist[HF] = 70`, so the nearer house is selected
 * first and, as in the fixture above, **the nearer house is at the HIGHER
 * index** — "pick the lowest index" is wrong here too.
 *
 * Every outbound route is a pure run of WEST steps and every return leg a pure
 * run of EAST steps. That is what makes "same-direction" CHECKABLE rather than
 * merely asserted: `LANE_OF_DIR[W] = 1` and `LANE_OF_DIR[E] = 0` are the only
 * two lanes this fixture ever claims, so on this board a same-LANE refusal is
 * necessarily a same-DIRECTION refusal. The premise is asserted (every route
 * nibble is W; every crossing in the run is W or E) rather than assumed, and
 * the conclusion is then also checked directly, by asking `canEnter` about the
 * same car, cell and tick in both directions.
 *
 * ---------------------------------------------------------------------------
 * THE LADDER, HAND-COMPUTED, AND THE THREE BLOCK WINDOWS
 * ---------------------------------------------------------------------------
 *
 * Same constants as the fixture above: 330 progress units per tick, 2,500 per
 * orthogonal cell, `rel_k = ceil(k * 2500 / 330)`. Two M1d rules do the rest.
 * **On a refusal `carProgress` is left exactly as it was** (Decision 5) — not
 * clamped to the threshold — so a blocked car's progress is frozen and the
 * ticks it waits are simply not accumulated. **`runMovement` processes cars in
 * ASCENDING index** (Decision 2), so within one tick a lower-indexed car
 * releases its cell before a higher-indexed one asks about it; every "granted
 * on the same tick the car in front left" below is that rule, and this fixture
 * is the file's first place where it is outcome-visible.
 *
 *   tick 1   7 place actions, 142-143 .. 148-149; then destPins[0] = 4
 *   tick 2   all four cars dispatched to d; destReserved = 4
 *
 *   car 2 (HN, leader)    147@9  146@17 145@24 144@32 143@39 142@47 (arrive)
 *                         143@55 144@62 145@70 146@77 147@85 148@92 (SCORE 1)
 *   car 3 (HN, follower)  147@17 146@25 145@32 144@40 143@47 142@55 (arrive)
 *                         143@63 144@70 145@78 146@85 147@93 148@100 (SCORE 2)
 *   car 0 (HF, leader)    148@9  147@26 146@33 145@41 144@48 143@56 142@64 (arrive)
 *                         143@71 144@79 145@86 146@94 147@101 148@109 149@117 (SCORE 3)
 *   car 1 (HF, follower)  148@26 147@34 146@41 145@49 144@56 143@64 142@72 (arrive)
 *                         143@79 144@87 145@94 146@102 147@109 148@117 149@125 (SCORE 4)
 *
 * Three block windows, 34 refused tick-events, every one WEST against WEST:
 *
 *   car 3, ticks  9-16 ( 8 ticks) — on 148, wanting 147, behind car 2
 *   car 1, ticks  9-25 (17 ticks) — on 149, wanting 148, behind car 0
 *   car 0, ticks 17-25 ( 9 ticks) — on 148, wanting 147, behind car 3
 *
 * Worked, because this is the part a reader has to be able to check. Every car
 * reaches 2,640 progress on tick 9 (8 x 330, `rel_1 = 8`, dispatched on tick 2).
 * Car 0 goes first and enters 148 — cars 2 and 3 are STANDING on it and hold
 * nothing, because neither has crossed yet on this leg (Decision 3's tick-0
 * ruling) — and claims lane 1. Car 1 asks for the same slot and is refused.
 * Car 2 enters 147 and claims lane 1; its `releaseCell` on 148 correctly does
 * nothing, because that slot now names car 0 and the release is guarded by
 * identity (Decision 6). Car 3 asks for 147 and is refused.
 *
 * On tick 17 car 0's held 2,450 reaches the threshold, but car 2 has not been
 * processed yet — so car 0 is refused, car 2 then leaves 147, and car 3 takes
 * the slot car 0 wanted. Car 0 waits for car 3 to leave 147 on tick 25 and
 * crosses on tick 26; car 1 takes 148 on that same tick, after seventeen
 * consecutive refusals. **Ticks 9 to 25 are a genuine two-deep queue** — two
 * cars refused on the same tick, both stationary, each behind the next.
 *
 * The largest counter reached is 17, which is 1,333 short of
 * `MAX_BLOCKED_TICKS`. **The valve is never involved and this fixture says
 * nothing about it** — asserted, because a fixture that silently valved would
 * still produce arrival ticks and still hash.
 *
 * The head-on path is exercised here too and never refuses anything: sixteen
 * (tick, cell) shared-cell events across fifteen ticks between 56 and 71 — tick
 * 63 carries two of them — as the leaders come back east through the followers
 * still heading west. All sixteen are listed and checked below.
 */

const Q_DEST_ORIGIN = 82 // (2,4)
const Q_CARPARK = 142 // (2,7)
const Q_HOUSE_FAR = 149 // (9,7) — house index 0, cars 0 and 1
const Q_HOUSE_NEAR = 148 // (8,7) — house index 1, cars 2 and 3
const Q_MERGE_CELL = 147 // the cell cars 2, 3 and 0 contend for in turn

const Q_COST_NEAR = 6 * ORTHO_COST // 60
const Q_COST_FAR = 7 * ORTHO_COST // 70

const Q_PINS = 4
const Q_DISPATCH_TICK = 2
const Q_RUN_TICKS = 130
/** Mid-jam, and the last tick of it: both block windows are at their longest. */
const Q_GOLDEN_TICK = 25
const Q_MID_JAM_TICK = 20

/**
 * The three block windows, hand-computed above. `car` is refused entry to
 * `wanted` while standing on `cell`, on every tick of `[from, to]`.
 */
const Q_BLOCK_WINDOWS = Object.freeze([
  Object.freeze({ car: 3, from: 9, to: 16, cell: Q_HOUSE_NEAR, wanted: Q_MERGE_CELL }),
  Object.freeze({ car: 1, from: 9, to: 25, cell: Q_HOUSE_FAR, wanted: Q_HOUSE_NEAR }),
  Object.freeze({ car: 0, from: 17, to: 25, cell: Q_HOUSE_NEAR, wanted: Q_MERGE_CELL }),
] as const)

/**
 * Every crossing of every car, transcribed from the ladder in the comment
 * above: `[cellEntered, tick]` in order, from each car's own house cell.
 *
 * Written as four per-car tracks rather than as 52 flat literals because that
 * is the shape a reader can check against the ladder line by line; the flat,
 * tick-ordered list the runner produces is derived from it below. The derived
 * step is pure rearrangement of hand-written data — it reads no state and
 * calls nothing under test.
 */
const Q_TRACKS = Object.freeze([
  Object.freeze({
    car: 0,
    start: Q_HOUSE_FAR,
    at: Object.freeze([
      [148, 9], [147, 26], [146, 33], [145, 41], [144, 48], [143, 56], [142, 64],
      [143, 71], [144, 79], [145, 86], [146, 94], [147, 101], [148, 109], [149, 117],
    ]),
  }),
  Object.freeze({
    car: 1,
    start: Q_HOUSE_FAR,
    at: Object.freeze([
      [148, 26], [147, 34], [146, 41], [145, 49], [144, 56], [143, 64], [142, 72],
      [143, 79], [144, 87], [145, 94], [146, 102], [147, 109], [148, 117], [149, 125],
    ]),
  }),
  Object.freeze({
    car: 2,
    start: Q_HOUSE_NEAR,
    at: Object.freeze([
      [147, 9], [146, 17], [145, 24], [144, 32], [143, 39], [142, 47],
      [143, 55], [144, 62], [145, 70], [146, 77], [147, 85], [148, 92],
    ]),
  }),
  Object.freeze({
    car: 3,
    start: Q_HOUSE_NEAR,
    at: Object.freeze([
      [147, 17], [146, 25], [145, 32], [144, 40], [143, 47], [142, 55],
      [143, 63], [144, 70], [145, 78], [146, 85], [147, 93], [148, 100],
    ]),
  }),
] as const)

/** `Q_TRACKS`, flattened into the tick-then-car order `runScripted` records in. */
function queueLadderLines(): string[] {
  const rows: { tick: number; car: number; text: string }[] = []
  for (const track of Q_TRACKS) {
    let from = track.start as number
    for (const entry of track.at) {
      const to = entry[0] as number
      const tick = entry[1] as number
      const dir = to < from ? DIR_WEST : DIR_EAST
      rows.push({ tick, car: track.car, text: `tick=${tick} car=${track.car} ${from}->${to} dir=${dir}` })
      from = to
    }
  }
  rows.sort((a, b) => a.tick - b.tick || a.car - b.car)
  return rows.map((row) => row.text)
}

/**
 * The largest `carBlockedTicks` value any car was OBSERVED to carry during a
 * run, read back out of the recorded refusals. Not derived from
 * `Q_BLOCK_WINDOWS`: the point of the comparison against `MAX_BLOCKED_TICKS` is
 * that it is about what the cars did, and a figure taken from the expected
 * table would compare the table against a constant instead.
 */
function maxBlockedSeen(obs: Observations): number {
  let max = 0
  for (const line of obs.refusals) {
    const m = /blocked=(\d+)/.exec(line)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return max
}

/** `Q_BLOCK_WINDOWS`, flattened the same way, with the counter each tick carries. */
function queueRefusalLines(): string[] {
  const rows: { tick: number; car: number; text: string }[] = []
  for (const window of Q_BLOCK_WINDOWS) {
    for (let tick = window.from; tick <= window.to; tick++) {
      const blocked = tick - window.from + 1
      rows.push({
        tick,
        car: window.car,
        text: `tick=${tick} car=${window.car} blocked=${blocked} cell=${window.cell}`,
      })
    }
  }
  rows.sort((a, b) => a.tick - b.tick || a.car - b.car)
  return rows.map((row) => row.text)
}

function buildQueueFixture(): Rig {
  const r = makeRig('queue-fixture', allLandRows(W, H), STARTING_TILES)
  expect(placeDestination(r.state, r.world, Q_DEST_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  // The FAR house first, so the nearer one lands at the higher index.
  expect(placeHouse(r.state, r.world, Q_HOUSE_FAR, 0)).toBe(true)
  expect(placeHouse(r.state, r.world, Q_HOUSE_NEAR, 0)).toBe(true)
  expect(r.state.header[H_DEST_COUNT]).toBe(1)
  expect(r.state.header[H_HOUSE_COUNT]).toBe(2)
  return r
}

/** The corridor, as `step` input actions: 142-143, 143-144, ... 148-149. */
function queueActionsForTick(tick: number): TickInputs {
  if (tick !== 1) return NO_ACTIONS
  const actions: TickAction[] = []
  for (let cell = Q_CARPARK; cell < Q_HOUSE_FAR; cell++) actions.push({ kind: 'place', a: cell, b: cell + 1 })
  return { actions }
}

/**
 * One wave of four pins on the single destination, written directly after tick
 * 1 — the same idiom, and for the same reason, as the loop fixture's two waves:
 * it is exactly the byte a pin fire writes, and it pins the demand timer
 * instead of waiting for it. Four rather than one because four cars have to
 * dispatch on one tick for the queue to exist at all.
 */
function applyQueuePins(state: GameState, tick: number): void {
  if (tick === 1) state.destPins[0] = Q_PINS
}

const QUEUE_SCRIPT: Script = { actions: queueActionsForTick, pins: applyQueuePins }

describe('a same-direction queue, end to end through step()', () => {
  it('the fixture really is a dead-end corridor with two ADJACENT houses, the nearer at the higher index, and four pure-west routes', () => {
    // Vacuity, and it must come first, exactly as it does for the loop fixture:
    // every claim below about who blocks whom rests on the four cars genuinely
    // sharing one one-wide corridor and on all four committing on one tick.
    expect(Q_HOUSE_FAR - Q_HOUSE_NEAR).toBe(1)
    expect(Q_COST_NEAR).toBeLessThan(Q_COST_FAR)

    const r = buildQueueFixture()
    const obs = newObservations()
    runScripted(r, 0, Q_DISPATCH_TICK, obs, QUEUE_SCRIPT)
    expect(obs.violations).toEqual([])

    expect(r.state.houseCell[0]).toBe(Q_HOUSE_FAR)
    expect(r.state.houseCell[1]).toBe(Q_HOUSE_NEAR) // the nearer house, at the HIGHER index

    // Safe to read here for the same reason the loop fixture's first test is:
    // no arrival happened on tick 2, so the fields are not yet stale.
    const field = fieldFor(r.state, r.world, r.fields, 0, r.scratch)
    expect(field.dist[Q_HOUSE_NEAR]).toBe(Q_COST_NEAR)
    expect(field.dist[Q_HOUSE_FAR]).toBe(Q_COST_FAR)

    // All four cars committed on tick 2, to the one destination, and every step
    // of every route is WEST. That last part is the premise the same-direction
    // argument rests on, and it is read through `routeStep` — dispatch.ts's own
    // nibble codec — rather than re-decoded here.
    expect(obs.dispatches).toEqual([
      'tick=2 car=0 home=0 dest=0',
      'tick=2 car=1 home=0 dest=0',
      'tick=2 car=2 home=1 dest=0',
      'tick=2 car=3 home=1 dest=0',
    ])
    expect(r.state.destReserved[0]).toBe(Q_PINS)
    for (let i = 0; i < 4; i++) {
      expect(r.state.carPhase[i]).toBe(PHASE_OUTBOUND)
      expect(r.state.carCell[i]).toBe(i < 2 ? Q_HOUSE_FAR : Q_HOUSE_NEAR)
      const len = r.state.carRouteLen[i] as number
      expect(len).toBe(i < 2 ? 7 : 6)
      for (let k = 0; k < len; k++) {
        expect(routeStep(r.state, i, k), `car ${i} route step ${k} is not west`).toBe(DIR_WEST)
      }
    }

    // And nobody holds anything yet: four cars, two cells, zero claims —
    // Decision 3's tick-0 ruling, which is what lets car 0 cross INTO 148 on
    // tick 9 while cars 2 and 3 are standing on it.
    expect(occupantOf(r.state, Q_HOUSE_FAR, 0)).toBe(FREE)
    expect(occupantOf(r.state, Q_HOUSE_FAR, 1)).toBe(FREE)
    expect(occupantOf(r.state, Q_HOUSE_NEAR, 0)).toBe(FREE)
    expect(occupantOf(r.state, Q_HOUSE_NEAR, 1)).toBe(FREE)
    expect(obs.refusals).toEqual([])
  })

  it('forms a two-deep same-direction queue on the hand-computed ticks, and holds each blocked car`s progress bit-for-bit', () => {
    const r = buildQueueFixture()
    const obs = newObservations()

    // Up to the tick before the first refusal. Nobody has crossed, nobody is
    // blocked, and the four progresses agree: 7 accumulating ticks x 330.
    runScripted(r, 0, 8, obs, QUEUE_SCRIPT)
    expect(obs.refusals).toEqual([])
    expect(obs.crossings).toEqual([])
    for (let i = 0; i < 4; i++) expect(r.state.carProgress[i]).toBe(7 * 330)

    // Then tick by tick through the jam, checking the frozen progress AS IT IS
    // FROZEN rather than once at the end: "held, not clamped" is a claim about
    // every tick of the wait, and a clamp to the threshold would be invisible
    // in the final value if the car crossed afterwards anyway.
    const perTickBlocked: string[] = []
    for (let tick = 9; tick <= Q_GOLDEN_TICK; tick++) {
      runScripted(r, tick - 1, tick, obs, QUEUE_SCRIPT)
      const blocked: number[] = []
      for (let i = 0; i < 4; i++) if ((r.state.carBlockedTicks[i] as number) !== 0) blocked.push(i)
      perTickBlocked.push(`tick=${tick} refused=[${blocked.join(',')}]`)

      // Car 1 never crosses in this window, so its progress is the value it
      // reached on tick 8 and nothing else, on all seventeen ticks.
      expect(r.state.carProgress[1], `car 1's held progress moved on tick ${tick}`).toBe(7 * 330)
      if (tick <= 16) {
        expect(r.state.carProgress[3], `car 3's held progress moved on tick ${tick}`).toBe(7 * 330)
      }
      if (tick >= 17) {
        // Car 0 crossed into 148 on tick 9 with a residual of 140, accumulated
        // to 140 + 7 x 330 = 2,450 by tick 16, and then froze there.
        expect(r.state.carProgress[0], `car 0's held progress moved on tick ${tick}`).toBe(2450)
      }
    }
    expect(obs.violations).toEqual([])

    // TWO cars refused on every tick of the window, and WHICH two changes
    // half way through: the queue re-forms behind a different leader when car 3
    // takes the slot car 0 was waiting for.
    const expectedBlocked: string[] = []
    for (let tick = 9; tick <= 16; tick++) expectedBlocked.push(`tick=${tick} refused=[1,3]`)
    for (let tick = 17; tick <= 25; tick++) expectedBlocked.push(`tick=${tick} refused=[0,1]`)
    expect(perTickBlocked).toEqual(expectedBlocked)

    // The refusals themselves, with the counter each tick carries — which is
    // what pins "increment by one per consecutive refused tick" rather than
    // merely "non-zero while blocked".
    expect(obs.refusals).toEqual(queueRefusalLines())

    // The middle of the jam, cell by cell: two cars moving, two stationary
    // behind them, and the occupancy array saying exactly that. Car 1 holds
    // NOTHING — it has never crossed — which is why its own house cell reads
    // FREE while it stands on it.
    const rMid = buildQueueFixture()
    const midObs = newObservations()
    runScripted(rMid, 0, Q_MID_JAM_TICK, midObs, QUEUE_SCRIPT)
    expect([0, 1, 2, 3].map((i) => rMid.state.carCell[i])).toEqual([148, 149, 146, 147])
    expect([0, 1, 2, 3].map((i) => rMid.state.carBlockedTicks[i])).toEqual([4, 12, 0, 0])
    const west = LANE_OF_DIR[DIR_WEST] as number
    const east = LANE_OF_DIR[DIR_EAST] as number
    expect(occupantOf(rMid.state, 146, west)).toBe(2)
    expect(occupantOf(rMid.state, 147, west)).toBe(3)
    expect(occupantOf(rMid.state, 148, west)).toBe(0)
    expect(occupantOf(rMid.state, 149, west)).toBe(FREE)
    for (const cell of [146, 147, 148, 149]) expect(occupantOf(rMid.state, cell, east)).toBe(FREE)
  })

  it('refuses only SAME-DIRECTION entries: the same car, cell and tick is refused westbound and granted eastbound', () => {
    // **The discriminator the plan asks for, in its sharpest available form.**
    // Asserting "the blocks are same-direction" by reading the lane back would
    // be reading the implementation's own arithmetic. Asking `canEnter` the
    // same question twice — same state, same car, same cell, same tick, one
    // direction each way — cannot be satisfied by a fixture that is quietly
    // exercising the head-on path: the westbound answer would not be a refusal.
    const r = buildQueueFixture()
    const obs = newObservations()
    runScripted(r, 0, Q_MID_JAM_TICK, obs, QUEUE_SCRIPT)

    // Car 1, standing on 149, blocked by car 0 on 148 — both westbound.
    expect(r.state.carCell[1]).toBe(Q_HOUSE_FAR)
    expect(r.state.carCell[0]).toBe(Q_HOUSE_NEAR)
    expect(occupantOf(r.state, Q_HOUSE_NEAR, LANE_OF_DIR[DIR_WEST] as number)).toBe(0)
    expect(canEnter(r.state, r.world, 1, Q_HOUSE_NEAR, DIR_WEST)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(canEnter(r.state, r.world, 1, Q_HOUSE_NEAR, DIR_EAST)).toBe(EnterOutcome.ENTER_FREE)

    // Car 0, standing on 148, blocked by car 3 on 147 — both westbound. A
    // second instance, because one pair could be an accident of one geometry.
    expect(r.state.carCell[3]).toBe(Q_MERGE_CELL)
    expect(occupantOf(r.state, Q_MERGE_CELL, LANE_OF_DIR[DIR_WEST] as number)).toBe(3)
    expect(canEnter(r.state, r.world, 0, Q_MERGE_CELL, DIR_WEST)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(canEnter(r.state, r.world, 0, Q_MERGE_CELL, DIR_EAST)).toBe(EnterOutcome.ENTER_FREE)

    // The premise that makes the two answers above generalise to the whole run:
    // on this corridor lane 1 is reached only by W and lane 0 only by E, so a
    // same-lane conflict cannot be anything but a same-direction one. Both
    // directions occur, so neither half of the filter is empty.
    runScripted(r, Q_MID_JAM_TICK, Q_RUN_TICKS, obs, QUEUE_SCRIPT)
    expect(obs.violations).toEqual([])
    const offAxis = obs.crossings.filter(
      (c) => !c.endsWith(`dir=${DIR_WEST}`) && !c.endsWith(`dir=${DIR_EAST}`),
    )
    expect(offAxis).toEqual([])
    expect(obs.crossings.some((c) => c.endsWith(`dir=${DIR_WEST}`))).toBe(true)
    expect(obs.crossings.some((c) => c.endsWith(`dir=${DIR_EAST}`))).toBe(true)

    // And the head-on path IS reachable on this board — sixteen (tick, cell)
    // events across fifteen ticks, as the leaders come back east through the
    // followers still heading west — without producing a single extra refusal.
    // That is what makes "the refusals are same-direction" a statement about
    // this fixture rather than about a board where nothing ever meets head-on.
    //
    // Listed rather than counted, because a count is the one form of this
    // assertion that a wrong cell or a wrong pair of cars would still satisfy —
    // and because the count and the tick total differ here (tick 63 carries
    // two), which is exactly the kind of thing a cardinality hides. Each line
    // is hand-checkable against the ladder: car 2 enters 143 eastbound on tick
    // 55 and car 0 enters it westbound on tick 56, so they share it until car 2
    // leaves on 62; car 2 and car 1 share 144 from 62 until car 1 leaves on 64;
    // car 3 and car 0 share 143 from 63 until car 0 leaves on 64; car 3 and car
    // 1 share it from 64 until car 3 leaves on 70; and car 0 and car 1 share it
    // for the single tick 71, before car 1 leaves on 72.
    const headOn: string[] = []
    for (let tick = 56; tick <= 61; tick++) headOn.push(`tick=${tick} cell=143 lane0=car2 lane1=car0`)
    headOn.push('tick=62 cell=144 lane0=car2 lane1=car1')
    headOn.push('tick=63 cell=143 lane0=car3 lane1=car0')
    headOn.push('tick=63 cell=144 lane0=car2 lane1=car1')
    for (let tick = 64; tick <= 69; tick++) headOn.push(`tick=${tick} cell=143 lane0=car3 lane1=car1`)
    headOn.push('tick=71 cell=143 lane0=car0 lane1=car1')
    expect(obs.sharedCells).toEqual(headOn)
    expect(obs.refusals).toEqual(queueRefusalLines())
  })

  it('clears the queue and completes all four trips on the hand-computed ticks, never touching the valve', () => {
    const r = buildQueueFixture()
    const obs = newObservations()
    runScripted(r, 0, Q_RUN_TICKS, obs, QUEUE_SCRIPT)
    expect(obs.violations).toEqual([])

    // Every crossing of every car, in tick order, against the ladder in this
    // section's header. 52 of them; a block one tick too long or too short
    // moves every line after it.
    expect(obs.crossings).toEqual(queueLadderLines())

    expect(obs.pinsConsumed).toEqual([
      'tick=47 car=2 dest=0 stillTargeting=0',
      'tick=55 car=3 dest=0 stillTargeting=0',
      'tick=64 car=0 dest=0 stillTargeting=0',
      'tick=72 car=1 dest=0 stillTargeting=0',
    ])
    expect(obs.scores).toEqual([
      `tick=92 car=2 home=1 cell=${Q_HOUSE_NEAR}`,
      `tick=100 car=3 home=1 cell=${Q_HOUSE_NEAR}`,
      `tick=117 car=0 home=0 cell=${Q_HOUSE_FAR}`,
      `tick=125 car=1 home=0 cell=${Q_HOUSE_FAR}`,
    ])
    expect(r.state.header[H_SCORE]).toBe(4)

    // Blocking DELAYED the run rather than breaking it: car 1 is the follower
    // that waited seventeen ticks and it is the last car home, 33 ticks after
    // the leader of its own house. An unblocked run of the same geometry would
    // have brought both HF cars home on tick 117.
    expect(obs.scoreAfterTick[116]).toBe(3) // after tick 117
    expect(obs.scoreAfterTick[Q_RUN_TICKS - 1]).toBe(4)

    // Nothing was refused a ROUTE, no pin was dropped, and the four pins that
    // were written are the four that were consumed.
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
    expect(r.state.header[H_PINS_DROPPED]).toBe(0)
    expect(r.state.destPins[0]).toBe(0)
    expect(r.state.destReserved[0]).toBe(0)

    // The board is clean at the end: every car home and idle, every slot FREE,
    // every counter back to 0. A queue that leaked a claim would leave a cell
    // permanently blocked and nothing else in this file would notice.
    for (let i = 0; i < 4; i++) {
      expect(r.state.carPhase[i]).toBe(PHASE_IDLE)
      expect(r.state.carBlockedTicks[i]).toBe(0)
    }
    for (let cell = 0; cell < r.world.cells; cell++) {
      expect(occupantOf(r.state, cell, 0), `cell ${cell} lane 0 still claimed`).toBe(FREE)
      expect(occupantOf(r.state, cell, 1), `cell ${cell} lane 1 still claimed`).toBe(FREE)
    }

    // The valve was never involved. Read off the run rather than off
    // `Q_BLOCK_WINDOWS`: `expect(17).toBeLessThan(MAX_BLOCKED_TICKS)` compares
    // two constants and would stay green through any change to how long cars
    // actually wait, which is the assertion-that-cannot-fail shape. The longest
    // wait any car OBSERVABLY served is the comparison worth making.
    expect(maxBlockedSeen(obs)).toBe(17)
    expect(maxBlockedSeen(obs)).toBeLessThan(MAX_BLOCKED_TICKS)
    expect(obs.completeChecked.length).toBe(Q_RUN_TICKS)
    expect(Math.max(...obs.completeChecked)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// The blocking golden — new in M1d Task 6, not a re-bless of anything
// ---------------------------------------------------------------------------

describe('golden replay: a jammed same-direction queue', () => {
  it('hashes the state mid-jam, with two cars refused, their progress held and the occupancy array contended', () => {
    const r = buildQueueFixture()
    const obs = newObservations()
    runScripted(r, 0, Q_GOLDEN_TICK, obs, QUEUE_SCRIPT)
    expect(obs.violations).toEqual([])

    // ---------------------------------------------------------------------
    // The fixture must genuinely exercise BLOCKING, and these assertions must
    // come BEFORE the hash. A golden over a fixture that does nothing is a
    // hash of nothing, and it re-blesses just as smoothly as a real one —
    // M1b's road-network golden nearly shipped that way, and the loop golden
    // above carries the same guard for the same reason. The difference here is
    // what the guards are ABOUT: this is the only golden in the repo taken
    // over a state with a non-zero `carBlockedTicks` and a contended occupancy
    // array, so its guards have to be about those two regions and not about
    // roads and scores. Every one of them was run RED on purpose before it was
    // trusted; the report for this task lists the edit that did it.
    // ---------------------------------------------------------------------

    // 1. Roads were placed, and through `step`'s input path.
    expect(tilesLeft(r.state)).toBeLessThan(STARTING_TILES)
    expect(roadMask(r.state, Q_CARPARK)).not.toBe(0)
    expect(roadMask(r.state, Q_HOUSE_FAR)).not.toBe(0)

    // 2. Entries were REFUSED — the whole point, and the one thing a golden
    //    over a free-flowing board would silently be missing. Asserted as the
    //    full list of refused tick-events, not as a count.
    expect(obs.refusals).toEqual(queueRefusalLines())
    expect(obs.refusals.length).toBe(34)

    // 3. There was a QUEUE, not one isolated block: two cars are refused on
    //    this very tick, each stationary behind the next, and both counters are
    //    in the digest below.
    expect(r.state.carBlockedTicks[0]).toBe(9)
    expect(r.state.carBlockedTicks[1]).toBe(17)
    expect(r.state.carBlockedTicks[2]).toBe(0)
    expect(r.state.carBlockedTicks[3]).toBe(0)
    expect(r.state.carCell[0]).toBe(Q_HOUSE_NEAR)
    expect(r.state.carCell[1]).toBe(Q_HOUSE_FAR)

    // 4. The refusals are SAME-DIRECTION, asked of `canEnter` directly in both
    //    directions on the same cell at this same tick. A fixture silently
    //    exercising the head-on path instead would answer ENTER_FREE westbound.
    expect(canEnter(r.state, r.world, 1, Q_HOUSE_NEAR, DIR_WEST)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(canEnter(r.state, r.world, 1, Q_HOUSE_NEAR, DIR_EAST)).toBe(EnterOutcome.ENTER_FREE)

    // 5. The occupancy array is genuinely contended: three cells claimed, all
    //    in the westbound lane, with every eastbound lane free.
    const west = LANE_OF_DIR[DIR_WEST] as number
    const east = LANE_OF_DIR[DIR_EAST] as number
    expect(occupantOf(r.state, 145, west)).toBe(2)
    expect(occupantOf(r.state, 146, west)).toBe(3)
    expect(occupantOf(r.state, Q_HOUSE_NEAR, west)).toBe(0)
    for (const cell of [145, 146, Q_MERGE_CELL, Q_HOUSE_NEAR, Q_HOUSE_FAR]) {
      expect(occupantOf(r.state, cell, east)).toBe(FREE)
    }

    // 6. The held progress is in the digest, at the exact values Decision 5's
    //    "left exactly as it was" produces. Clamping to the threshold would put
    //    2,500 in both of these and move the hash.
    expect(r.state.carProgress[0]).toBe(2450)
    expect(r.state.carProgress[1]).toBe(2310)

    // 7. Four cars are mid-trip with live routes, cursors and reservations, so
    //    the hash covers more than a stalled pair.
    for (let i = 0; i < 4; i++) {
      expect(r.state.carPhase[i]).toBe(PHASE_OUTBOUND)
      expect(routeBytesOf(r.state, i).some((b) => b !== 0)).toBe(true)
    }
    expect(r.state.destReserved[0]).toBe(Q_PINS)
    expect(r.state.header[H_SCORE]).toBe(0)

    // 8. The valve has not fired: the largest counter here is 17 against
    //    `MAX_BLOCKED_TICKS` = 1,350.
    //
    //    **Labelled SUBSUMED, not load-bearing, because it was measured to be.**
    //    This task tried to falsify it independently — `MAX_BLOCKED_TICKS = 17`,
    //    the smallest value that makes `17 < MAX_BLOCKED_TICKS` false — and
    //    guard 4 above fired first, because a saturated counter turns that same
    //    `canEnter` call from `REFUSED_OCCUPIED` into `ENTER_VALVE`. And it
    //    cannot be otherwise: guard 3 pins this counter at exactly 17, so this
    //    line can only fail when `MAX_BLOCKED_TICKS <= 17`, and every such value
    //    arms the valve at guard 4's call site. Its coverage is a strict subset
    //    of guard 4's, which is the catalogue's "decoration that reads as
    //    defence" — so it stays as the statement of the margin a reader wants,
    //    and the detector is guard 4's outcome code. That separation is only
    //    available because `canEnter` returns a REASON rather than a boolean.
    expect(r.state.carBlockedTicks[1] as number).toBeLessThan(MAX_BLOCKED_TICKS)

    // 9. Nothing was refused a route, no pin was dropped, and no road was ever
    //    erased — so both ghost regions are all-zero and cannot be contributing
    //    to the digest.
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
    expect(r.state.header[H_PINS_DROPPED]).toBe(0)
    expect(r.state.ghostMask.every((b) => b === 0), 'the queue fixture erases nothing').toBe(true)
    expect(r.state.ghostCommitted.every((b) => b === 0)).toBe(true)

    // ---------------------------------------------------------------------
    // **A NEW golden, blessed for the first time in M1d Task 6. This is not a
    // re-bless of anything** — no number changed to produce it, and none of the
    // five existing goldens moves in this task. It is deliberately taken AFTER
    // both of M1d's buffer changes (Tasks 2 and 5), so it never has to be
    // re-blessed for layout; a re-bless of a brand-new number is
    // indistinguishable from getting it wrong the first time.
    //
    // What it covers that no other golden does: `carBlockedTicks` non-zero and
    // unequal across two cars, `occupancy` contended in one lane with the other
    // free, and two cars' progress FROZEN at a sub-threshold value. It moves
    // for a change anywhere in the blocking primitive — the lane table, the
    // refusal, the held progress, the claim/release protocol, the ascending
    // iteration order — as well as for everything the loop golden already
    // covers.
    //
    // **Re-blessed in M1e Task 1 (was 294084758 at M1d Task 6) for PURE
    // LAYOUT, and AGAIN in M1e Task 5 (was 1007037587).** The layout proof
    // still holds and still says what it always said: the same exact byte
    // splice as the loop golden above (`m1eSplice.ts`) reproduces 294084758
    // bit-for-bit with no slot zeroed, so not one byte outside Task 1's two
    // inserted ranges has moved across this fixture's run. **`Q_GOLDEN_TICK`
    // ticks, which is 25 — not the 130 an earlier version of this sentence
    // claimed.** 130 is `Q_RUN_TICKS`, the window the behavioural assertions
    // above are stated over; the DIGEST is taken mid-jam at 25, which is what
    // `assertNoSpawnHappened` below is passed and what its timer arithmetic
    // (2,250 - 25 = 2,225 and 300 - 25 = 275) is computed from.
    // Same map shape as the loop fixture, so the same offsets and the same
    // 8,068 -> 8,232 B.
    //
    // **What Task 5 moved, and why the plan did not expect it**: see
    // `assertNoSpawnHappened` and the loop golden's own note. Nothing spawned
    // here either; the two spawn COUNTDOWNS ticked, and a countdown is a hashed
    // byte. Every slot that moved is asserted by hand-computed value on the
    // line below, so this re-bless can absorb nothing.
    // ---------------------------------------------------------------------
    assertNoSpawnHappened(r, Q_GOLDEN_TICK, 2, 1)
    const m1e = m1eInsertedRanges(r.map)
    expect([m1e.aStart, m1e.aEnd, m1e.bStart, m1e.bEnd]).toEqual([52, 68, 1676, 1824])
    const spliced = spliceM1eInsertions(r.state, r.map)
    expect(spliced.length, "the splice must land on M1d's buffer size").toBe(8068)
    expect(m1e.totalBytes).toBe(8232)
    expect(hashBytes(spliced), 'the splice must reproduce the pre-M1e digest').toBe(294084758)
    expect(hashState(r.state)).toBe(307910575)
  })
})

// ---------------------------------------------------------------------------
// The demand golden — new in M1e Task 6. The first fixture in the repo whose
// `destPins` the TIMER produces.
// ---------------------------------------------------------------------------

/**
 * **The gap this closes, carried forward twice since M1c**: *"no golden covers
 * demand-produced pins. The loop golden's fixture pre-pins to keep `destPins`
 * stable under assertion, so the pin timer is frozen."* Both fixtures above
 * write their pins by hand (`applyScriptedPins`, `queueScriptedPins`) precisely
 * so that the demand accumulator cannot move under their exact-tick ladders.
 * M1e's weekly ramp is the first change that makes the pin cadence a function
 * of the week, so the timer's own output is now worth a digest.
 *
 * **A SECOND fixture, not an edit to the first.** Forcing the loop fixture to
 * run past its 150 ticks would retire the four-route cost matrix its leading
 * vacuity test protects, and would move the loop golden for a fourth time.
 *
 * ---------------------------------------------------------------------------
 * THE MAP IS 20x9 AND THAT IS A REQUIREMENT, NOT A CONVENIENCE
 * ---------------------------------------------------------------------------
 *
 * `REVEALED_Y0` is 9, so `spawnZoneH(9)` is `min(9 + 22, 9) > 9 ? ... : 0` =
 * **0** and the clipped spawn zone is EMPTY: Task 5's spawner is structurally
 * absent from this board, not merely refused by the clock. That is what makes
 * the fire ladder below derivable from `pinPeriodForWeek(0)` and `(1)` alone.
 *
 * On the 20x12 shape the two fixtures above use, the clipped zone is 14x3 = 42
 * cells and the spawner is live: a destination spawns inside 5,000 ticks,
 * `slotCount(0)` goes 2 -> 3, and the cadence changes before the week boundary
 * — at which point `DG_EXPECTED_FIRE_TICKS` is not derivable at all and this
 * golden would be a digest with a story attached. `assertDemandGoldenPosture`
 * asserts the zero, BEFORE the run; it does not assume it.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE
 * ---------------------------------------------------------------------------
 *
 * All-land 20 x 9 board, so `cell = y * 20 + x`. One colour-0 square
 * destination in the top-left, one colour-0 house eight cells east of its
 * carpark, and one straight road corridor between them along row 3:
 *
 *      x:   2  3                              10
 *   row 0:  [][]                                       origin (2,0) = cell 2
 *   row 1:  [][]                                       orientation S
 *   row 2:  [][]
 *   row 3:  C---------------------------------H        C = 62, H = 70
 *
 *   d0: origin (2,0) orientation S, carpark (2,3) = 62, dest index 0
 *   H0: (10,3) = 70, house index 0 -> cars 0 and 1
 *
 * Every step is orthogonal and every corridor cell has degree <= 2, so no turn
 * and no intersection multiplier applies and the movement arithmetic is the
 * same `rel_k = ceil(k * 2500 / 330)` ladder this file's header derives.
 * `rel_8` = 61 and `rel_16` = 122, so with `abs = dispatchTick + rel_k - 1` a
 * car dispatched on tick T reaches the carpark on T + 60 and is home on
 * T + 121.
 *
 * ---------------------------------------------------------------------------
 * THE FIRE LADDER, DERIVED FROM THE TWO PERIODS AND NEVER READ BACK
 * ---------------------------------------------------------------------------
 *
 * One square of colour 0 is `slotCount(0)` = 1, and it is 0 until the
 * destination clears its own `FIRST_PIN_DELAY_TICKS` = 120 (it is placed at
 * tick 0, so it is eligible from tick 120 inclusive). So for t >= 120 the
 * accumulator is `acc(t) = (t - 119) - (periods already subtracted)`, and a
 * fire happens on the tick `acc` first reaches the current week's threshold.
 *
 *   week 0, `pinPeriodForWeek(0)` = 518:
 *     637 = 119 + 518        1155 = 637 + 518       1673 = 1155 + 518
 *    2191 = 1673 + 518       2709 = 2191 + 518      3227 = 2709 + 518
 *    3745 = 3227 + 518       4263 = 3745 + 518
 *
 *   tick 4500 opens week 1 and the threshold becomes
 *   `pinPeriodForWeek(1)` = 466. `acc` is 0 straight after the 4263 fire and
 *   237 on tick 4500 — under BOTH thresholds, so the boundary itself fires
 *   nothing and the gap that straddles it is measured against the SHORTER one:
 *
 *   week 1, 466:
 *    4729 = 4263 + 466       5195 = 4729 + 466
 *
 * The observable difference the ramp makes on this board is exactly that: the
 * gap between pins goes 518, 518, ..., 518, **466**, 466. Both cadences are
 * inside the run, which is what `DG_RUN_TICKS` = 5,250 is chosen for.
 *
 * Service is far faster than arrival here (a 121-tick round trip against a
 * 466-tick gap at the tightest), so the corridor never queues and `destPins`
 * never exceeds 1. That is deliberate: this golden is about the TIMER, and a
 * fixture whose destination sat at its hard cap would be a golden over the
 * overflow walk instead. The ramp's effect on a network that CANNOT keep up is
 * measured separately, below, as a treatment/control.
 */

const DG_W = 20
const DG_H = 9
const DG_DEST_ORIGIN = 2 // (2,0)
const DG_CARPARK = 62 // (2,3)
const DG_HOUSE = 70 // (10,3)
/** 9 cells of corridor, 62..70 inclusive: one tile per newly-occupied cell. */
const DG_ROAD_CELLS = 9
const DG_RUN_TICKS = 5250
/**
 * Inside week 0, 37 ticks past the eighth fire, with car 0 outbound mid-edge on
 * a live reservation — so the resumed segment must carry a part-filled
 * accumulator ACROSS the week boundary and change cadence on the far side.
 */
const DG_SNAPSHOT_TICK = 4300

/** Blessed for the first time in M1e Task 6. See the golden's own comment. */
const DG_GOLDEN = 894844668

/** Hand-derived above from `pinPeriodForWeek(0)` = 518 and `(1)` = 466. */
const DG_EXPECTED_FIRE_TICKS: readonly number[] = [
  637, 1155, 1673, 2191, 2709, 3227, 3745, 4263, // week 0, every 518
  4729, 5195, // week 1, every 466
]

function buildDemandGoldenRig(): Rig {
  const r = makeRig('demand-golden', allLandRows(DG_W, DG_H), STARTING_TILES)
  expect(placeDestination(r.state, r.world, DG_DEST_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeHouse(r.state, r.world, DG_HOUSE, 0)).toBe(true)
  expect(r.state.header[H_DEST_COUNT]).toBe(1)
  expect(r.state.header[H_HOUSE_COUNT]).toBe(1)
  return r
}

/** The corridor, as `step` input actions: 62-63, 63-64, ... 69-70. */
function demandGoldenActions(tick: number): TickInputs {
  if (tick !== 1) return NO_ACTIONS
  const out: TickAction[] = []
  for (let cell = DG_CARPARK; cell < DG_HOUSE; cell++) out.push({ kind: 'place', a: cell, b: cell + 1 })
  return { actions: out }
}

/**
 * **The whole point of this fixture, expressed as a function that does
 * nothing.** Both other scripts in this file write `destPins` by hand; this one
 * must not, or the golden is a digest over the test's own arithmetic. Named
 * rather than written inline as `() => {}` so that a future edit adding a pin
 * write here has to delete this comment first.
 */
function noScriptedPins(): void {
  /* deliberately empty — see above */
}

const DEMAND_GOLDEN_SCRIPT: Script = { actions: demandGoldenActions, pins: noScriptedPins }

/**
 * The spawn posture for a fixture that runs PAST the first attempt, which
 * `assertNoSpawnHappened` above refuses to describe (its guard is
 * `tick < HOUSE_SPAWN_PERIOD_TICKS`).
 *
 * **Carry 1 of this task's brief, and it is the lesson Task 5 paid for.** The
 * plan predicted that two goldens could not move in Task 5 because *"nothing
 * can spawn inside their window"*; both moved, because `H_DEST_SPAWN_TIMER` and
 * `houseSpawnTimer` are COUNTDOWNS that tick from tick 1 whether an attempt
 * fires or not, and a whole-buffer digest asks whether any BYTE moved rather
 * than whether anything spawned. This fixture inherits that property at a much
 * larger scale — the destination countdown has cycled six times and each house
 * countdown eighty-three — so every slot the cycling touches is pinned here by
 * a hand-computed literal, and the digest is never the only evidence.
 *
 * The arithmetic, for `tick` = `DG_RUN_TICKS` = 5,250:
 *
 *   - destination attempts at 2,250 + 600k (k = 0..5, the last ON tick 5,250);
 *     the timer is re-armed to `DEST_SPAWN_RETRY_TICKS` = 600 on each, because
 *     `attemptDestinationSpawn` returns `ZONE_EMPTY` on this board and only
 *     `PLACED`/`BOARD_FULL` re-arm to the schedule.
 *     600 - ((5250 - 2250) mod 600) = 600 - 0 = **600**.
 *   - house attempts at 300 + 60k (k = 0..82); 5,250 is 30 ticks past the 82nd,
 *     so 60 - ((5250 - 300) mod 60) = 60 - 30 = **30**, for every colour.
 *   - the colour cursor is **1**, not 0: every destination attempt CHOSE colour
 *     0 (the only colour holding a house) and advanced past it before hitting
 *     the empty zone. Unlike the two fixtures above — where the cursor's 0 is
 *     evidence that no attempt fired — here a moved cursor is the evidence that
 *     six of them did, and were refused for the structural reason rather than
 *     the clock.
 */
function assertDemandGoldenPosture(r: Rig, tick: number): void {
  expect(r.state.header[H_TICK], 'the fixture did not reach the tick this posture is stated at').toBe(tick)
  expect(spawnZoneCells(r.world), 'a 20x9 board clips the revealed rect to nothing').toBe(0)
  // Vacuity, in the direction `assertNoSpawnHappened` cannot claim: both
  // countdowns have genuinely cycled past their first attempt, so the literals
  // below are describing the retry cadence and not the initial arming.
  expect(tick).toBeGreaterThan(DEST_SPAWN_PERIOD_TICKS)
  expect(tick).toBeGreaterThan(HOUSE_SPAWN_PERIOD_TICKS + HOUSE_SPAWN_RETRY_TICKS)
  expect(r.state.header[H_DEST_SPAWN_TIMER], 'the destination countdown, re-armed to the RETRY').toBe(600)
  expect(DEST_SPAWN_RETRY_TICKS, 'and 600 is that retry, not a coincidence').toBe(600)
  for (let c = 0; c < r.map.groupCount; c++) {
    expect(r.state.houseSpawnTimer[c], `colour ${c}'s house countdown`).toBe(30)
  }
  expect(HOUSE_SPAWN_RETRY_TICKS).toBe(60)
  expect(r.state.header[H_SPAWN_COLOUR_CURSOR], 'six attempts chose colour 0 and advanced past it').toBe(1)
  // Nothing was placed, which on THIS board is a structural claim rather than
  // a clock one — the zone has no cells for a building to go in.
  expect(r.state.header[H_DEST_COUNT], 'the spawner placed a destination').toBe(1)
  expect(r.state.header[H_HOUSE_COUNT], 'the spawner placed a house').toBe(1)
  // Task 3's two regions and Task 8's two header slots. **Labelled as posture,
  // not as evidence**: nothing in the repo writes `destOvercrowd`,
  // `destOverTicks`, `H_GAME_OVER` or `H_FAILED_DEST` yet — the overcrowd
  // timer is a later task — so these four hold for a fixture that never
  // reaches a cap AND for one that does. They become discriminating the day
  // that task lands, and this golden will move then.
  expect(r.state.header[H_GAME_OVER]).toBe(0)
  expect(r.state.header[H_FAILED_DEST]).toBe(0)
  expect(r.state.destOvercrowd.every((v) => v === 0)).toBe(true)
  expect(r.state.destOverTicks.every((v) => v === 0)).toBe(true)
}

describe('golden replay: pins produced by the demand timer, across a week boundary', () => {
  it('produces pins from the timer alone, across a week boundary, and pins the digest', () => {
    const r = buildDemandGoldenRig()
    // Posture, asserted BEFORE the run: this board cannot spawn, so the fire
    // ladder is a function of the two periods and nothing else.
    expect(spawnZoneCells(r.world), 'a 20x9 board clips the revealed rect to nothing').toBe(0)
    const destsBefore = r.state.header[H_DEST_COUNT] as number
    const housesBefore = r.state.header[H_HOUSE_COUNT] as number

    const obs = newObservations()
    runScripted(r, 0, DG_RUN_TICKS, obs, DEMAND_GOLDEN_SCRIPT)
    expect(obs.violations).toEqual([])

    expect(r.state.header[H_DEST_COUNT], 'nothing spawned').toBe(destsBefore)
    expect(r.state.header[H_HOUSE_COUNT], 'nothing spawned').toBe(housesBefore)
    // **Trivially true today and kept anyway, labelled.** No task in the repo
    // writes `H_GAME_OVER`; the overcrowd timer that will is a later task. This
    // says "the sim is live at the digest" and it will start being able to fail
    // the day that lands.
    expect(isGameOver(r.state), 'and the sim is still live at the digest').toBe(false)

    // ---------------------------------------------------------------------
    // The ladder. Hand-derived in this section's header from
    // `pinPeriodForWeek(0)` and `(1)`, never read back from a run.
    // ---------------------------------------------------------------------
    expect(obs.fireTicks).toEqual(DG_EXPECTED_FIRE_TICKS)
    // Vacuity: the timer must genuinely have fired, and it must have fired at
    // BOTH cadences, or this is a week-0 fixture wearing a ramp's name.
    expect(obs.fireTicks.some((t) => t < TICKS_PER_WEEK)).toBe(true)
    expect(obs.fireTicks.some((t) => t >= TICKS_PER_WEEK)).toBe(true)
    // And the CADENCE changed, which is the ramp itself and the one thing a
    // week-0-only fixture cannot show. Stated as the two gap sets rather than
    // as "some gap is 466": a run that fired 466 apart everywhere would satisfy
    // that and would mean the ramp had reached week 0.
    const gaps = DG_EXPECTED_FIRE_TICKS.slice(1).map(
      (t, i) => t - (DG_EXPECTED_FIRE_TICKS[i] as number),
    )
    expect(gaps).toEqual([518, 518, 518, 518, 518, 518, 518, 466, 466])
    expect(new Set(gaps.slice(0, 7)).size, 'week 0 is one cadence').toBe(1)
    expect(gaps[0]).toBe(pinPeriodForWeek(0))
    expect(gaps[gaps.length - 1]).toBe(pinPeriodForWeek(1))
    expect(DG_EXPECTED_FIRE_TICKS[0], 'the first fire is the delay plus one whole week-0 period').toBe(
      FIRST_PIN_DELAY_TICKS - 1 + PIN_PERIOD_TICKS,
    )

    // The ledger, closed independently of the accumulator: every fire either
    // stands on a destination, was consumed by an arriving car, or was dropped.
    // If a fire had been hidden by an arrival landing on the same tick, the
    // ladder above would be one short and this identity would not close.
    expect(
      (r.state.destPins[0] as number) +
        obs.pinsConsumed.length +
        (r.state.header[H_PINS_DROPPED] as number),
    ).toBe(DG_EXPECTED_FIRE_TICKS.length)
    expect(r.state.header[H_PINS_DROPPED], 'nothing was dropped: this board never reaches a cap').toBe(0)
    expect(r.state.destPins[0], 'the tenth pin is still standing, reserved by the in-flight car').toBe(1)
    expect(r.state.destReserved[0]).toBe(1)
    expect(r.state.destPins[0]).toBeLessThan(PIN_CAP_SQUARE_TIMER)

    // ---------------------------------------------------------------------
    // The fixture genuinely ran the loop, and these assertions come BEFORE the
    // hash — a golden over a fixture that does nothing re-blesses just as
    // smoothly as a real one.
    // ---------------------------------------------------------------------
    expect(roadMask(r.state, DG_CARPARK)).not.toBe(0)
    expect(roadMask(r.state, DG_HOUSE)).not.toBe(0)
    // **The week boundary is in the digest twice over: through the ramp, and
    // through §5.10's grant** — which is why the loop fixtures' `tilesLeft <
    // STARTING_TILES` guard is the WRONG shape here and is not used. This
    // fixture ends with MORE tiles than it started with (999 - 9 + 30 =
    // 1,020), so a `<` would fail on a perfectly healthy run; the exact ledger
    // is the assertion that both proves the corridor was paid for and witnesses
    // the boundary independently of the pin cadence.
    expect(tilesLeft(r.state)).toBe(STARTING_TILES - DG_ROAD_CELLS + WEEKLY_TILE_GRANT)
    expect(tilesLeft(r.state)).toBe(1020)
    expect(r.state.header[H_WEEK]).toBe(1)
    expect(r.state.header[H_TICK]).toBe(DG_RUN_TICKS)

    // Nine of the ten pins became a completed trip; the tenth is mid-flight.
    // Dispatched on 5,195, the carpark is 60 ticks away and home 121, so at
    // 5,250 car 0 is outbound with carried progress and a live route.
    expect(r.state.header[H_SCORE]).toBe(9)
    expect(obs.dispatches.length).toBe(10)
    expect(obs.pinsConsumed.length).toBe(9)
    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(r.state.carProgress[0]).not.toBe(0)
    expect(routeBytesOf(r.state, 0).some((b) => b !== 0)).toBe(true)
    // Car 1 never left home: one pin at a time and a 121-tick round trip means
    // the house's lowest idle car is always free. Asserted so that "the loop
    // ran" cannot be satisfied by a fleet churning for the wrong reason.
    expect(r.state.carPhase[1]).toBe(PHASE_IDLE)
    expect(r.state.carCell[1]).toBe(DG_HOUSE)
    expect(obs.refusals, 'the corridor never queues at this cadence').toEqual([])
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)

    // The accumulator's own residue, hand-computed: the 5,195 fire left it at
    // 0 and 55 eligible ticks have passed since.
    expect(r.state.pinAccum[0]).toBe(DG_RUN_TICKS - 5195)
    expect(r.state.pinAccum[0]).toBe(55)
    for (let c = 1; c < r.map.groupCount; c++) {
      expect(r.state.pinAccum[c], `colour ${c} has no destination and cannot accumulate`).toBe(0)
    }

    // No road is ever erased, so both ghost regions are all-zero and cannot be
    // contributing to the digest.
    expect(r.state.ghostMask.every((b) => b === 0), 'this fixture erases nothing').toBe(true)
    expect(r.state.ghostCommitted.every((b) => b === 0)).toBe(true)

    assertDemandGoldenPosture(r, DG_RUN_TICKS)

    // ---------------------------------------------------------------------
    // **A NEW golden, blessed for the FIRST time in M1e Task 6. This is not a
    // re-bless of anything**, and it carries no splice proof for the same
    // reason: this fixture did not exist before M1e, so there is no pre-M1e
    // digest for a splice to reproduce. The buffer shape settled in Task 1 and
    // nothing after it moves the shape, which is why a new golden can be
    // blessed from Task 2 onward at all.
    //
    // What it covers that no other golden does: `destPins` written by
    // `runDemand` rather than by the test, a `pinAccum` residue produced by
    // real accrual over 5,250 ticks, and a pin CADENCE that changes at a week
    // boundary. It moves for a change anywhere in `spawnScale`,
    // `pinPeriodForWeek`, the eligibility delay, the week clock, the weekly
    // grant, or the spawn countdowns.
    //
    // **What it is BLIND to, labelled because the task brief predicted the
    // opposite and a reader would otherwise assume the coverage.** It cannot
    // see `acc -= period` become `acc = 0`: `slotCount` here is 1, so the
    // accumulator lands exactly on 518 and exactly on 466 and the two writes
    // are the same write. Measured, not reasoned: that mutation scores 0
    // detectors in this file. The detectors for it are
    // `demand.test.ts`'s pre-existing carry test and its
    // "carries the remainder ACROSS a period change" test, which uses
    // `slotCount` 3 precisely because 3 divides neither period.
    // ---------------------------------------------------------------------
    expect(hashState(r.state)).toBe(DG_GOLDEN)
  })

  it('replays byte-identically ACROSS the week boundary, from a cold Worker and from a fresh run', () => {
    // **The non-negotiable this task's change makes non-trivial.** The ramp
    // reads `H_WEEK` inside the tick, so the pin cadence is now a function of
    // the clock; a replay that resumed with the wrong week would produce the
    // same bytes for 237 ticks and then diverge silently at the next fire.
    // Both arms below therefore cross tick 4,500 rather than stopping short of
    // it, and both are compared on the WHOLE buffer.
    const r = buildDemandGoldenRig()
    const obs = newObservations()
    runScripted(r, 0, DG_SNAPSHOT_TICK, obs, DEMAND_GOLDEN_SCRIPT)

    // Vacuity BEFORE the snapshot: it is taken inside week 0, with a car
    // mid-edge on a live reservation, and with the accumulator part-way to its
    // next threshold. A snapshot on an idle board in week 1 would make every
    // claim below vacuous.
    expect(r.state.header[H_WEEK], 'the snapshot is taken INSIDE week 0').toBe(0)
    expect(DG_SNAPSHOT_TICK).toBeLessThan(TICKS_PER_WEEK)
    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(r.state.carProgress[0]).not.toBe(0)
    expect(r.state.destReserved[0]).toBe(1)
    expect(r.state.pinAccum[0], 'part-way to the next threshold, not sitting on 0').toBe(
      DG_SNAPSHOT_TICK - 4263,
    )
    expect(r.state.pinAccum[0]).toBeGreaterThan(0)
    expect(r.state.pinAccum[0]).toBeLessThan(pinPeriodForWeek(1) as number)
    const snap = snapshot(r.state)
    const firesBeforeSnapshot = obs.fireTicks.length

    runScripted(r, DG_SNAPSHOT_TICK, DG_RUN_TICKS, obs, DEMAND_GOLDEN_SCRIPT)
    expect(obs.violations).toEqual([])
    expect(hashState(r.state), 'the original timeline lands on the blessed digest').toBe(DG_GOLDEN)

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
    runScripted(cold, DG_SNAPSHOT_TICK, DG_RUN_TICKS, coldObs, DEMAND_GOLDEN_SCRIPT)
    expect(coldObs.violations).toEqual([])
    expect(hashState(cold.state)).toBe(DG_GOLDEN)
    // ...and it is the same RUN, not merely the same final bytes: the two fires
    // the resumed segment still owes are the two on the far side of the
    // boundary, at the SHORTER cadence.
    expect(coldObs.fireTicks).toEqual(DG_EXPECTED_FIRE_TICKS.slice(firesBeforeSnapshot))
    expect(coldObs.fireTicks).toEqual([4729, 5195])
    expect(coldObs.fireTicks.every((t) => t >= TICKS_PER_WEEK)).toBe(true)
    expect(cold.state.header[H_WEEK], 'the replay genuinely crossed into week 1').toBe(1)

    // And a completely independent run from tick 0 — new buffer, new world, new
    // fields, new scratch — lands on the same digest. This is the arm that
    // would catch a period cached in module scope, which the resumed arm above
    // shares with the original.
    const again = buildDemandGoldenRig()
    const againObs = newObservations()
    runScripted(again, 0, DG_RUN_TICKS, againObs, DEMAND_GOLDEN_SCRIPT)
    expect(againObs.violations).toEqual([])
    expect(againObs.fireTicks).toEqual(DG_EXPECTED_FIRE_TICKS)
    expect(hashState(again.state)).toBe(DG_GOLDEN)
  })
})

// ---------------------------------------------------------------------------
// The ramp's OWN observable — a treatment/control, because nothing else in
// this milestone can attribute anything to it
// ---------------------------------------------------------------------------

/**
 * **What a player can attribute to the weekly ramp on the board that ships:
 * nothing, and this section is what that sentence is worth instead.**
 *
 * The plan's observability line for this task was *"a player who has kept up
 * for five minutes finds that the same road network stops coping"*. That line
 * is satisfied by a build in which this task is ENTIRELY ABSENT: at five
 * minutes the board is at week 2 and `spawnScale` is 1.22x, while Task 5's
 * spawner has already added destinations and houses to the same board and
 * grown `slotCount` directly. Delete the ramp and the sentence still passes.
 * **For the whole of M1e the ramp and the spawner are confounded and no
 * observation of the shipped board separates them.**
 *
 * So the ramp gets an observable of its own, built the way the testing
 * catalogue prescribes for a correlated confound — **a treatment/control with
 * the confounder structurally absent from both arms**:
 *
 *   - one 20x9 board, where `spawnZoneCells` is 0 and the spawner therefore
 *     cannot place anything in EITHER arm (asserted, per arm);
 *   - one road network, one house, two cars, one circle destination, and the
 *     same 3,000 ticks in every arm;
 *   - `H_WEEK` as the only thing that differs, reached by warm-starting
 *     `H_TICK` to the week's first tick before anything is placed. The arms'
 *     headers then differ in exactly one slot before the run
 *     (`headerSlotsThatMoved` asserts it), and `destSpawnTick` is stamped from
 *     that same tick so `tick - destSpawnTick` — the only thing eligibility
 *     reads — is identical in all of them.
 *   - and the SPAWN side is asserted identical across arms afterwards: same
 *     countdowns, same colour cursor, same building counts. `colourUnlocked`
 *     is the other `H_WEEK` reader that can reach this fixture, and that is
 *     the measurement showing it did nothing.
 *
 * ---------------------------------------------------------------------------
 * THE BOARD, AND THE ONE NUMBER THAT DECIDES WHETHER A RAMP CAN BITE AT ALL
 * ---------------------------------------------------------------------------
 *
 * All-land 20 x 9, `cell = y * 20 + x`. A colour-0 CIRCLE — two rotation slots,
 * so `slotCount(0)` = 2 — with a 25-cell corridor to a single house:
 *
 *   row 3:  C=================================.       62 .. 79
 *   row 4:              H==================='          92 .. 99
 *
 *   d0: origin (2,0) orientation S, carpark (2,3) = 62, a CIRCLE
 *   H0: (12,4) = 92, house index 0 -> cars 0 and 1
 *
 * The round trip is **394 ticks, measured** (50 crossings at 330 units/tick
 * against a 2,500-unit orthogonal threshold is 379, plus the two right-angle
 * cells at 79 and 99 crossed twice each). With `F` = 2 cars and `s` = 2 slots,
 * a queue is stable exactly while `T < F * P / s`, i.e. while `394 < P_w`:
 *
 *   `pinPeriodForWeek(2)` = 424 > 394   stable
 *   `pinPeriodForWeek(3)` = 389 < 394   the knee — DERIVED, and the measured
 *                                       peak backlog leaves 1 at exactly week 3
 *
 * That is the whole difficulty curve in one inequality, and it says plainly why
 * the ramp cannot be seen on the board that ships: `HOUSES_PER_DESTINATION` x
 * `CARS_PER_HOUSE` is 4 cars per destination at EVERY week, so the fleet grows
 * in step with demand and only the round trip can close the gap. Here the round
 * trip is held fixed on purpose. On the shipped board it is not.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MEASURED, on this board, over 3,000 ticks, arms as below
 * ---------------------------------------------------------------------------
 *
 *   week  scale   period  peak backlog  trips  dropped
 *      0  1.00x      518             1      9        0
 *      3  1.33x      389             2     12        0
 *      8  1.88x      275             7     12        0
 *      9  1.99x      260             8     12        0     <- the timer cap
 *     10  2.10x      246             9     13        0
 *     19  3.00x      172            14     13        5     <- the hard cap
 *
 * **The ramp is real iff a connected destination reaches its timer cap by week
 * N, and on this board N is 9.** Week 8 peaks at 7 and week 9 at 8, so the
 * answer is a boundary rather than a big number, and the week-8 arm is what
 * makes it one.
 *
 * **Throughput is the honest counterweight and it is measured here too.**
 * Demand triples (518 -> 172) and completed trips go 9 -> 13, a factor of 1.44:
 * the fleet is the binding term, not demand, which is the same thing the
 * inequality above says. Growth in pins is not growth in trips.
 */

const CP_W = 20
const CP_H = 9
const CP_DEST_ORIGIN = 2 // (2,0)
const CP_CARPARK = 62 // (2,3)
const CP_ROW3_END = 79 // (19,3)
const CP_ROW4_END = 99 // (19,4)
const CP_HOUSE = 92 // (12,4)
const CP_TICKS = 3000
/** Measured on this board, both arms: 50 crossings plus two right-angle cells. */
const CP_ROUND_TRIP = 394

/** The leading `tick=N` of an observation line, as a number. Throws on a line without one. */
function tickOf(line: string): number {
  const m = /^tick=(\d+)/.exec(line)
  if (m === null) throw new Error(`tickOf: no leading tick= in "${line}"`)
  return Number(m[1])
}

/** The corridor: row 3 east to the wall, one step south, row 4 back west to the house. */
function copingCorridor(): TickAction[] {
  const out: TickAction[] = []
  for (let c = CP_CARPARK; c < CP_ROW3_END; c++) out.push({ kind: 'place', a: c, b: c + 1 })
  out.push({ kind: 'place', a: CP_ROW3_END, b: CP_ROW4_END })
  for (let c = CP_ROW4_END; c > CP_HOUSE; c--) out.push({ kind: 'place', a: c, b: c - 1 })
  return out
}

interface CopingArm {
  readonly rig: Rig
  readonly obs: Observations
  readonly peakBacklog: number
  readonly trips: number
  readonly dropped: number
  readonly fires: number
}

/**
 * One arm: the same board, warm-started into `week`, driven for `CP_TICKS`.
 *
 * The map id and the state seed are identical across arms on purpose — the
 * only construction-time difference is the `H_TICK` write, which the caller
 * asserts is the only header slot that differs.
 */
function runCopingArm(week: number): CopingArm {
  const rig = makeRig('coping-fixture', allLandRows(CP_W, CP_H), STARTING_TILES)
  const start = week * TICKS_PER_WEEK
  rig.state.header[H_TICK] = start
  expect(placeDestination(rig.state, rig.world, CP_DEST_ORIGIN, ORIENTATION_S, 0, DEST_KIND_CIRCLE)).toBe(true)
  expect(placeHouse(rig.state, rig.world, CP_HOUSE, 0)).toBe(true)
  // The confounder is structurally absent from this arm, not merely quiet.
  expect(spawnZoneCells(rig.world), 'a 20x9 board clips the revealed rect to nothing').toBe(0)
  expect(rig.state.destSpawnTick[0], 'eligibility is measured from this arm\'s own start').toBe(start)

  const script: Script = {
    actions: (tick) => (tick === start + 1 ? { actions: copingCorridor() } : NO_ACTIONS),
    pins: noScriptedPins,
  }
  const obs = newObservations()
  runScripted(rig, start, start + CP_TICKS, obs, script)
  expect(obs.violations).toEqual([])
  expect(rig.state.header[H_WEEK], `arm ${week} must stay inside its own week`).toBe(week)

  return {
    rig,
    obs,
    peakBacklog: Math.max(...obs.pinsHeldAfterTick),
    trips: rig.state.header[H_SCORE] as number,
    dropped: rig.state.header[H_PINS_DROPPED] as number,
    fires: obs.fireTicks.length,
  }
}

describe('the demand ramp, given an observable of its own: one board, one fleet, only the week differs', () => {
  it('the same road network stops coping — and the week it stops is a boundary, not a big number', () => {
    const w0 = runCopingArm(0)
    const w3 = runCopingArm(3)
    const w8 = runCopingArm(8)
    const w9 = runCopingArm(9)
    // Week 10 is in this list for a second, unrelated reason — see the
    // collision witness at the bottom of this test.
    const w10 = runCopingArm(10)
    const w19 = runCopingArm(19)
    const arms = [w0, w3, w8, w9, w10, w19]

    // -------------------------------------------------------------------
    // The control: everything except the week is the same, before and after.
    // -------------------------------------------------------------------
    // Before the run, the two extreme arms' headers differ in exactly one slot.
    // (Rebuilt rather than kept from above, because the arms have already run.)
    const freshA = makeRig('coping-fixture', allLandRows(CP_W, CP_H), STARTING_TILES)
    const freshB = makeRig('coping-fixture', allLandRows(CP_W, CP_H), STARTING_TILES)
    freshB.state.header[H_TICK] = 19 * TICKS_PER_WEEK
    expect(headerSlotsThatMoved(Array.from(freshA.state.header), freshB.state)).toEqual([H_TICK])

    // After the run, the SPAWN side is byte-for-byte the same in every arm —
    // so `colourUnlocked`, the other `H_WEEK` reader this fixture can reach,
    // provably did nothing different. Without this the contrast below would be
    // "the week changed and the board changed", which is the confound this
    // whole section exists to escape.
    for (const a of arms) {
      expect(a.rig.state.header[H_DEST_COUNT], 'no destination spawned').toBe(1)
      expect(a.rig.state.header[H_HOUSE_COUNT], 'no house spawned').toBe(1)
      expect(a.rig.state.header[H_DEST_SPAWN_TIMER]).toBe(w0.rig.state.header[H_DEST_SPAWN_TIMER])
      expect(a.rig.state.header[H_SPAWN_COLOUR_CURSOR]).toBe(w0.rig.state.header[H_SPAWN_COLOUR_CURSOR])
      expect(Array.from(a.rig.state.houseSpawnTimer)).toEqual(Array.from(w0.rig.state.houseSpawnTimer))
    }
    // Vacuity on that control: the spawner genuinely RAN and was refused — the
    // cursor moved off 0 — rather than never having been reached at all.
    expect(w0.rig.state.header[H_SPAWN_COLOUR_CURSOR]).toBe(1)

    // -------------------------------------------------------------------
    // The knee, DERIVED before it is measured: a queue is stable while the
    // round trip is under the period, at two cars and two rotation slots.
    // -------------------------------------------------------------------
    expect(CP_ROUND_TRIP).toBeLessThan(pinPeriodForWeek(2) as number) // 394 < 424
    expect(CP_ROUND_TRIP).toBeGreaterThan(pinPeriodForWeek(3) as number) // 394 > 389
    // ...and the measured backlog leaves 1 at exactly that week.
    expect(w0.peakBacklog, 'week 0: the fleet is never more than one pin behind').toBe(1)
    expect(w3.peakBacklog, 'week 3: the derived knee, measured').toBe(2)

    // -------------------------------------------------------------------
    // The headline: the destination reaches its TIMER cap at week 9 and not
    // at week 8. A boundary, so the claim is falsifiable in both directions.
    // -------------------------------------------------------------------
    expect(w8.peakBacklog).toBe(7)
    expect(w8.peakBacklog).toBeLessThan(PIN_CAP_CIRCLE_TIMER)
    expect(w9.peakBacklog).toBe(PIN_CAP_CIRCLE_TIMER)
    expect(w9.peakBacklog).toBe(8)
    // And at the ramp's own cap the destination is jammed at its HARD cap and
    // demand is being thrown away — the state no amount of week-0 play reaches.
    expect(w19.peakBacklog).toBe(PIN_CAP_CIRCLE_HARD)
    expect(w19.dropped).toBe(5)
    expect(w0.dropped).toBe(0)
    expect(w9.dropped).toBe(0)

    // The backlog is monotone in the week over the five arms — a ramp, not a
    // step at the cap.
    const peaks = arms.map((a) => a.peakBacklog)
    expect(peaks).toEqual([1, 2, 7, 8, 9, 14])
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i], `arm ${i}`).toBeGreaterThan(peaks[i - 1] as number)
    }

    // -------------------------------------------------------------------
    // The counterweight, measured rather than assumed: demand triples and
    // THROUGHPUT does not. The fleet is the binding term, which is why the
    // ramp is invisible on a board whose fleet grows with it.
    // -------------------------------------------------------------------
    expect(w0.fires).toBe(11)
    expect(w19.fires).toBe(33)
    expect(w19.fires / w0.fires).toBeGreaterThan(2.9) // demand: 3.0x
    expect(w0.trips).toBe(9)
    expect(w19.trips).toBe(13)
    expect(w19.trips / w0.trips).toBeLessThan(1.5) // throughput: 1.44x
    // Every fire is accounted for in every arm — delivered, consumed or
    // dropped — so `fires` is a ledger rather than a detector's opinion.
    for (const a of arms) {
      expect(
        (a.rig.state.destPins[0] as number) + a.obs.pinsConsumed.length + a.dropped,
      ).toBe(a.fires)
    }

    // -------------------------------------------------------------------
    // The witness for `fireTicks`' conservation term, which is otherwise
    // decoration that reads as defence.
    // -------------------------------------------------------------------
    // `fireTicks` counts a fire as `delivered + consumed + dropped` rather
    // than as a rise in `destPins`, because phase 5 and phase 9 can both touch
    // `destPins` on one tick and cancel. **Dropping the `consumed` term from
    // that sum leaves every other fixture in this file green — measured, 0
    // detectors** — because no tick in the demand golden or in the other four
    // arms carries both events. Week 10 carries two, so this is where the term
    // earns its place; without this arm the instrument would be untested and
    // would quietly lose a fire the day a fixture collided.
    const arrivalTicks = new Set(w10.obs.pinsConsumed.map(tickOf))
    const collisions = w10.obs.fireTicks.filter((t) => arrivalTicks.has(t))
    expect(collisions.length, 'week 10 is the arm that exercises the ledger').toBe(2)
    // ...and it is genuinely a property of this arm and not of all of them.
    const w0Arrivals = new Set(w0.obs.pinsConsumed.map(tickOf))
    expect(w0.obs.fireTicks.filter((t) => w0Arrivals.has(t))).toEqual([])
  })
})
