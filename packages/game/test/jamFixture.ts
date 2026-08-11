import { MAX_BLOCKED_TICKS, parseMap } from '@laneways/shared'
import {
  createFieldInputRanges,
  createFlowFields,
  createScratch,
  createState,
  createWorld,
  placeDestination,
  placeHouse,
  step,
  DEST_KIND_SQUARE,
  ORIENTATION_S,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  H_SCORE,
  type TickAction,
} from '@laneways/sim'
import { longestQueue } from '../src/queueProbe'

/**
 * **The jam fixture — M1d Task 9.** A bottleneck that genuinely jams, with its
 * geometry named in CELLS and its throughput hand-computed both with and
 * without blocking.
 *
 * ---------------------------------------------------------------------------
 * THE GEOMETRY, IN CELLS — NOT IN "LANES"
 * ---------------------------------------------------------------------------
 *
 * The plan is explicit that this must be stated in cells, because since M1d
 * "two-lane" means *one cell with two directional slots*, which is not what a
 * throughput test wants. So: a **pure vertical single-file corridor**, one cell
 * wide, on a 16 x 20 board of plains, in column `x = 8`.
 *
 *   - **destination** footprint x 8-9 / y 1-3, `ORIENTATION_S`, which puts the
 *     **carpark on cell (8, 4)** — `JAM_CARPARK`;
 *   - **the corridor** is the ten cells **(8, 4) .. (8, 13)**, placed as nine
 *     orthogonal segments;
 *   - **eight houses** standing ON the corridor at **(8, 6) .. (8, 13)**. A
 *     house cell necessarily carries a road (Decision 3), so houses on the
 *     corridor is the steady state of every house, not a fixture artefact;
 *   - `CARS_PER_HOUSE = 2`, so **16 cars**, all colour 0, all routed to the one
 *     carpark.
 *
 * Route lengths are therefore **N = 2, 3, 4, 5, 6, 7, 8, 9** cells, two cars
 * each — `JAM_ROUTE_LENS`.
 *
 * **Every cell of the corridor has road degree <= 2 and the column is straight**,
 * so no turn multiplier and no intersection multiplier ever applies and every
 * crossing runs at the plain `speedUnits(1000) = 330`. That is deliberate: it
 * keeps Task 7's multipliers out of Task 9's hand computation, and the test
 * asserts it (`popcount(roadMask)` maxes at 2) rather than assuming it.
 *
 * **Why a straight corridor rather than a funnel.** The first design was a T —
 * a feeder row joining a shared stem — and it jams so completely that **zero**
 * trips finish in 900 ticks, with a car blocked for 893 consecutive ticks. That
 * passes every anti-degeneracy guard the plan names and is still the wrong
 * fixture: Decision 6's claim is that a gridlocked city **grinds rather than
 * stops**, and a fixture that stops demonstrates the opposite of the thing this
 * milestone shipped. The straight corridor grinds.
 *
 * ---------------------------------------------------------------------------
 * THE TWO HAND-COMPUTED FIGURES
 * ---------------------------------------------------------------------------
 *
 * One crossing threshold is `ORTHO_COST * COST_UNIT_SCALE = 10 * 250 = 2,500`
 * units and a car accumulates `CAR_SPEED_UNITS_PER_TICK = 330` per tick, so
 * crossing *k* of a leg lands on relative tick `rel_k = ceil(k * 2500 / 330)` —
 * the same `rel_k` the M1c loop fixture's table is built on. A car dispatched at
 * tick `D` scores at `D + 2*rel_N - 1` and is re-dispatchable the next tick, so
 * the completion-to-completion period is **`P(N) = 2 * rel_N`**.
 *
 * **1. `JAM_UNBLOCKED_TRIPS = 204`** — what this fixture would deliver in 900
 * ticks if nothing ever blocked. With `D = 2`:
 *
 * | N | rel_N | P | first | per car | x2 |
 * |---|---|---|---|---|---|
 * | 2 | 16 | 32 | 33 | 1 + floor(867/32) = 28 | 56 |
 * | 3 | 23 | 46 | 47 | 1 + floor(853/46) = 19 | 38 |
 * | 4 | 31 | 62 | 63 | 1 + floor(837/62) = 14 | 28 |
 * | 5 | 38 | 76 | 77 | 1 + floor(823/76) = 11 | 22 |
 * | 6 | 46 | 92 | 93 | 1 + floor(807/92) = 9 | 18 |
 * | 7 | 54 | 108 | 109 | 1 + floor(791/108) = 8 | 16 |
 * | 8 | 61 | 122 | 123 | 1 + floor(777/122) = 7 | 14 |
 * | 9 | 69 | 138 | 139 | 1 + floor(761/138) = 6 | 12 |
 * | | | | | | **204** |
 *
 * **Deliberately a LOWER bound, and checked against the counterfactual.** With
 * the occupancy branch of `canEnter` neutralised, this exact fixture measures
 * **206** trips over the same 900 ticks — the hand figure is 2 low, because one
 * house's pair gets a trip a uniform `D = 2` does not predict. That is the safe
 * direction: 204 under-states the unblocked world, so `measured < 204` strictly
 * implies `measured < unblocked`. The test asserts against 204, the hand-computed
 * number, and never against the recorded 206.
 *
 * **2. `JAM_CARPARK_CAPACITY_TRIPS = 112`** — what the bottleneck can physically
 * pass, which is the figure that explains the mechanism rather than just
 * exhibiting it. Every completed trip requires its car to enter the carpark
 * cell travelling north; `LANE_OF_DIR[0] = 1`, so every such entry claims one
 * and the same slot, and the claim is released only when that car crosses off
 * the carpark, which is at least `rel_1 = 8` ticks later. So at most one car
 * enters the carpark per 8 ticks: `floor(900 / 8) = 112`.
 *
 * Measured, with blocking: **106** — 95 % of the hard capacity bound and 48 %
 * below the unblocked figure. The fixture is not merely slower with blocking on;
 * it is pinned at the capacity of its bottleneck, and that capacity follows from
 * the lane rule and the crossing arithmetic alone.
 *
 * ---------------------------------------------------------------------------
 * ALLOCATION: `drive` IS PROFILED, SO IT ALLOCATES NOTHING
 * ---------------------------------------------------------------------------
 *
 * `allocation.test.ts` profiles `step` through this rig, so everything `drive`
 * touches per tick is pre-allocated in the closure and the action list is a
 * frozen module constant that is **reassigned, never `length = 0`-and-re-pushed**
 * — that spelling right-trims a JS array's backing store and charged 33.8 B/tick
 * the one time a rig in this repo did it. The observation helpers below allocate
 * freely and are called OUTSIDE profiled windows.
 */

export const JAM_W = 16
export const JAM_H = 20
/** The corridor's column. */
export const JAM_X = 8
/** The carpark's row — the top of the corridor, and the bottleneck. */
export const JAM_CARPARK_Y = 4
export const JAM_CARPARK = JAM_CARPARK_Y * JAM_W + JAM_X
/** The eight house rows, `(8, 6) .. (8, 13)`. */
export const JAM_FIRST_HOUSE_Y = 6
export const JAM_HOUSE_COUNT = 8
export const JAM_BOTTOM_Y = JAM_FIRST_HOUSE_Y + JAM_HOUSE_COUNT - 1
export const JAM_CAR_COUNT = JAM_HOUSE_COUNT * 2
/** Hand-derived from the geometry: `y - JAM_CARPARK_Y` for each house row. */
export const JAM_ROUTE_LENS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9] as const)

/** The window every hand-computed figure in this module is stated over. */
export const JAM_TICKS = 900
/** See the module comment, table 1. A hand-computed LOWER bound on the unblocked figure. */
export const JAM_UNBLOCKED_TRIPS = 204
/** See the module comment, figure 2. `floor(JAM_TICKS / 8)`. */
export const JAM_CARPARK_CAPACITY_TRIPS = 112

/**
 * The **starved** variant: the same corridor with the first house moved one cell
 * up, hard against the carpark, and twelve houses instead of eight.
 *
 * It exists for one reason — **`ENTER_VALVE` is not reachable in the ordinary
 * jam.** The valve fires at `MAX_BLOCKED_TICKS = 1,350` consecutive blocked
 * ticks, and the eight-house corridor's worst blocked run over 900 ticks is 131.
 * With a house adjacent to the carpark, its cars are starved by the through
 * traffic and the counter does saturate: measured **17 valve firings over 3,000
 * ticks** at twelve houses (2 at eight). Nothing else in the repo drives the
 * valve through `runMovement` at all — `blocking.test.ts` reaches it on a
 * hand-built ring — so this is also the only place the production path fires it.
 */
export const JAM_STARVED_FIRST_HOUSE_Y = 5
export const JAM_STARVED_HOUSE_COUNT = 12

const cellAt = (x: number, y: number): number => y * JAM_W + x

export interface JamObservation {
  /** Cell changes, summed over cars. */
  crossings: number
  /** Ticks on which some car's `carBlockedTicks` rose — i.e. `canEnter` refused. */
  refusals: number
  /** Crossings whose car was saturated on the previous tick: `ENTER_VALVE`. */
  valves: number
  /** IDLE -> in-flight transitions. */
  dispatched: number
  /** Trips completed, read off `H_SCORE`. */
  trips: number
  /** Whether `destPins[0]` moved — the flow-field-rebuild tripwire. */
  pinMoves: number
}

export interface JamRig {
  readonly state: ReturnType<typeof createState>
  readonly world: ReturnType<typeof createWorld>
  readonly houses: number
  /** The corridor's cells, carpark first. */
  readonly corridor: readonly number[]
  /** Advances `n` ticks. Allocates nothing per tick; returns what happened. */
  drive(n: number): JamObservation
  /** One tick with a caller-supplied action list. */
  tick(actions: readonly TickAction[]): void
}

const NO_ACTIONS: readonly TickAction[] = Object.freeze([])

export function buildJamRig(
  seed: string,
  firstHouseY: number = JAM_FIRST_HOUSE_Y,
  houseCount: number = JAM_HOUSE_COUNT,
): JamRig {
  const rows = Array.from({ length: JAM_H }, () => '.'.repeat(JAM_W))
  // **`maxDestinations` is 1, not 4 — M1e Task 8.** This rig builds exactly one
  // destination and pins it at 255 below, so the three spare slots were filled
  // by M1e Task 5's spawner with buildings no car can reach: a spawned
  // destination's carpark is road-free by construction on a board where nothing
  // ever lays another road, so it is never a flow-field source and takes zero
  // arrivals, while `destPins[0]`'s overflow feeds it pins. Under §5.8 that is
  // a board that must lose, and `integration.test.ts`'s 20,000-tick sweep froze
  // at tick 7,223 with 12,778 drives left to run — asserting safety properties
  // over a byte-identical buffer, which they all satisfy.
  //
  // **`maxHouses` stays at 16 deliberately.** Twelve are built at most, so the
  // HOUSE spawner still runs and still places one: this fixture keeps live
  // spawner coverage on the tick, it just stops being handed destination slots
  // it cannot use. Capping both would have been the larger change for no
  // additional gain.
  //
  // Measured blast radius before the change, because the first pass declined it
  // on a reading: capping this one parameter breaks **exactly one test**, the
  // long-run sweep's own death assertions. `queueProbe.test.ts`,
  // `allocation.test.ts` and every other jam case pass untouched, and nothing
  // outside `packages/game` imports this file.
  const map = parseMap('jam-rig', rows, 9999, 16, 1, 2)
  const world = createWorld(map)
  const state = createState(seed, map)
  const scratch = createScratch(
    world.cells,
    map.groupCount,
    map.maxDestinations,
    createFieldInputRanges(map),
  )
  const fields = createFlowFields(map.groupCount, world.cells)
  if (!placeDestination(state, world, cellAt(JAM_X, 1), ORIENTATION_S, 0, DEST_KIND_SQUARE)) {
    throw new Error('jam rig: the destination did not place')
  }
  const bottomY = firstHouseY + houseCount - 1
  let houses = 0
  for (let y = firstHouseY; y <= bottomY; y++) {
    if (placeHouse(state, world, cellAt(JAM_X, y), 0)) houses++
  }
  if (houses !== houseCount) {
    throw new Error(`jam rig: placed ${houses} houses, wanted ${houseCount}`)
  }
  const build: TickAction[] = []
  for (let y = JAM_CARPARK_Y; y < bottomY; y++) {
    build.push({ kind: 'place', a: cellAt(JAM_X, y), b: cellAt(JAM_X, y + 1) })
  }
  step(state, world, fields, scratch, { actions: build })
  // Written directly, exactly as a pin fire would: a big supply, so the demand
  // timer never has to be waited out and the jam is the only thing limiting
  // throughput.
  state.destPins[0] = 255

  const corridor: number[] = []
  for (let y = JAM_CARPARK_Y; y <= bottomY; y++) corridor.push(cellAt(JAM_X, y))

  const carCount = state.carPhase.length
  const prevCell = new Int32Array(carCount)
  const prevBlocked = new Int32Array(carCount)
  const wasFlying = new Uint8Array(carCount)
  for (let c = 0; c < carCount; c++) {
    prevCell[c] = state.carCell[c] as number
    prevBlocked[c] = state.carBlockedTicks[c] as number
    const p = state.carPhase[c] as number
    wasFlying[c] = p === PHASE_OUTBOUND || p === PHASE_RETURNING ? 1 : 0
  }
  // Reassigned, never mutated in place — see the module comment.
  const oneTick: { actions: readonly TickAction[] } = { actions: NO_ACTIONS }
  // Pre-allocated so `drive` allocates nothing: the returned object is the same
  // object every call, filled in place.
  const obs: JamObservation = {
    crossings: 0,
    refusals: 0,
    valves: 0,
    dispatched: 0,
    trips: 0,
    pinMoves: 0,
  }

  return {
    state,
    world,
    houses,
    corridor,
    tick(actions: readonly TickAction[]) {
      oneTick.actions = actions
      step(state, world, fields, scratch, oneTick)
    },
    drive(n: number): JamObservation {
      obs.crossings = 0
      obs.refusals = 0
      obs.valves = 0
      obs.dispatched = 0
      obs.pinMoves = 0
      const scoreBefore = state.header[H_SCORE] as number
      let lastPins = state.destPins[0] as number
      for (let t = 0; t < n; t++) {
        if ((state.destPins[0] as number) < 60) {
          state.destPins[0] = 255
          lastPins = 255
        }
        oneTick.actions = NO_ACTIONS
        step(state, world, fields, scratch, oneTick)
        for (let c = 0; c < carCount; c++) {
          const cell = state.carCell[c] as number
          const blocked = state.carBlockedTicks[c] as number
          const phase = state.carPhase[c] as number
          const flying = phase === PHASE_OUTBOUND || phase === PHASE_RETURNING ? 1 : 0
          if (flying === 1 && wasFlying[c] === 0) obs.dispatched++
          // **A refusal is exactly a rise in `carBlockedTicks`.** `advanceCar`
          // calls `noteEntryRefused` on every refused entry and nothing else
          // touches the region, so this counts `canEnter`'s refusals from
          // production behaviour rather than by re-asking the oracle at a moment
          // `runMovement` would not have asked. (It under-counts only where the
          // counter is already saturated AND the refusal repeats, which needs a
          // `REFUSED_GHOST`; this rig has no ghost and the test asserts that.)
          if (blocked > (prevBlocked[c] as number)) obs.refusals++
          if (cell !== prevCell[c]) {
            obs.crossings++
            // A crossing whose car was saturated on the previous tick was
            // granted by the valve — `canEnter` returns `ENTER_VALVE` only for a
            // saturated counter, and `noteEntryGranted` then resets it to 0.
            //
            // **`MAX_BLOCKED_TICKS`, never the literal 1,350**, and this counter
            // was written with the literal first. The mutation battery caught it:
            // "valve at 1,349" was detected by the allocation window, which is
            // the WRONG detector — the window is about allocation on the valve
            // path, not about the threshold's value, and it only fired because
            // the hardcoded 1,350 had stopped matching a counter that now
            // saturates at 1,349. That is the catalogue's over-broad-mutation
            // shape pointed at an observer: a detector that fires for a reason
            // it is not about. With the constant it correctly does not fire, and
            // the four tests that own the threshold still do.
            if ((prevBlocked[c] as number) >= MAX_BLOCKED_TICKS) obs.valves++
          }
          prevCell[c] = cell
          prevBlocked[c] = blocked
          wasFlying[c] = flying
        }
        const pins = state.destPins[0] as number
        if (pins !== lastPins) {
          obs.pinMoves++
          lastPins = pins
        }
      }
      obs.trips = (state.header[H_SCORE] as number) - scoreBefore
      return obs
    },
  }
}

/**
 * The longest queue standing on this rig, delegated to the production probe.
 *
 * **It used to be a copy of the algorithm and is now a one-line adapter**, and
 * the reason is a measured coverage hole rather than tidiness: when
 * `src/queueProbe.ts` was added for the demo layout, two mutations of it —
 * dropping the return leg's direction reversal, and counting parked cars —
 * scored **0 detectors**, because the only readers were inequality thresholds
 * loose enough to survive a wrong answer. This file's callers
 * (`integration.test.ts`, `allocation.test.ts`) assert bounds on the figure
 * against a corridor whose queue length is hand-derivable, so pointing them at
 * the same implementation is what gives it observers.
 *
 * `longestQueue` allocates two `Map`s and a `Set` per call, so this is called
 * outside profiled windows — unchanged from when the code lived here.
 */
export function jamQueueLength(rig: JamRig): number {
  return longestQueue(rig.state, rig.world)
}

/** Cells whose `ghostMask` is non-zero. */
export function jamGhostCells(rig: JamRig): number {
  let n = 0
  for (let c = 0; c < rig.world.cells; c++) if (rig.state.ghostMask[c] !== 0) n++
  return n
}
