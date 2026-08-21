import { expect } from 'vitest'
import { parseMap, COST_UNIT_SCALE, ORTHO_COST, type MapData } from '@laneways/shared'
import { createState, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFieldInputRanges } from '../src/regions'
import { createScratch, createFlowFields, type FlowField, type Scratch } from '../src/scratch'
import { LANE_OF_DIR, placeRoad } from '../src/roads'
import { claimCell } from '../src/blocking'
import { PHASE_OUTBOUND } from '../src/buildings'
import { packRouteStep } from '../src/dispatch'

/**
 * The hand-built junction fixtures for M1f Task 2's mutual-exclusion rule, in a
 * module of their own rather than inside `blocking.test.ts`.
 *
 * **They live here because Task 9 imports `twoAdjacentJunctions`** — its
 * *"an upgrade gives the head-on property back"* case is this exact fixture with
 * a junction upgrade written onto both cells — and a `.test.ts` file cannot be
 * imported without re-running its suite. The repo already keeps shared fixtures
 * this way (`m1eSplice.ts`, `retiredPlacementRef.ts`, `cityArms.ts`).
 *
 * ---------------------------------------------------------------------------
 * THE BRIEF'S FIXTURE USED (E, S) AS ITS CROSSING PAIR AND THOSE ARE THE SAME
 * LANE
 * ---------------------------------------------------------------------------
 *
 * Task 2's brief specifies the crossing fixture as *"car 0 entered heading east
 * … car 1 wants to enter heading south, which is the OTHER lane"*, with an
 * assertion `LANE_OF_DIR[DIR_E] !== LANE_OF_DIR[DIR_S]`. **That assertion is
 * false.** `roads.ts`'s frozen table is `[1, 0, 0, 0, 0, 1, 1, 1]`, so E (index
 * 2) and S (index 4) are BOTH lane 0 — the rule it can be checked against is
 * *lane 0 iff the travel vector points east, or due south when it does not point
 * east*, and both of those directions satisfy it.
 *
 * **The consequence is not cosmetic, and it is TWO failures rather than one.**
 * Written exactly as the brief gives it, the test goes **RED** — the
 * `not.toBe(LANE_OF_DIR[DIR_S])` line is itself false, so the fixture's own
 * guard fires. That guard is doing its job. The danger is what an implementer
 * does next: the natural repair is to drop or invert the assertion that "failed",
 * at which point the remaining test **passes on the pre-M1f tree**, because an
 * E/S pair is already refused by the own-lane read. So the brief pairs a vacuous
 * fixture with a guard that fires for a reason nobody would connect to vacuity,
 * and the cheapest way through it is the wrong one.
 *
 * That is the catalogue's *"a negative assertion is only meaningful if the
 * fixture disables every OTHER mechanism that produces the same observation"*,
 * in the one test the whole task is about — with the twist that the mechanism
 * meant to catch it is the thing that gets deleted.
 *
 * `roads.ts`'s own module comment names the correct pair, and it is the pair
 * used here: *"at a junction it also permits an **eastbound** car and a
 * **northbound** car to occupy the same cell simultaneously"*. **(E, N)** —
 * lanes 0 and 1 — is the crossing the two-lane model cannot see, and it is the
 * only kind of pair this rule can newly refuse.
 *
 * Every rig asserts its own degree at its call site rather than in the helper,
 * per the brief, so a fixture that silently stops being a junction fails in the
 * test that depends on it.
 */

/** Non-square on purpose: a square board cannot distinguish `w` from `h`. */
export const RIG_W = 12
export const RIG_H = 9

/** `roads.ts`'s direction indices, spelled out for readable fixtures. */
export const DIR_N = 0
export const DIR_E = 2
export const DIR_S = 4
export const DIR_W = 6

/**
 * The two lanes the crossing rule is about. Asserted here, once, so that every
 * fixture below inherits the check and a reordered `LANE_OF_DIR` cannot leave
 * the whole module quietly testing the own-lane read instead.
 */
export const CROSSING_LANES_DIFFER = (LANE_OF_DIR[DIR_E] as number) !== (LANE_OF_DIR[DIR_N] as number)

/** One orthogonal cell of progress. */
export const ORTHO_THRESHOLD = ORTHO_COST * COST_UNIT_SCALE

export interface RigBase {
  readonly s: GameState
  readonly world: WorldData
  readonly map: MapData
  readonly scratch: Scratch
  readonly fields: FlowField[]
}

function makeRig(id: string): RigBase {
  const rows = Array.from({ length: RIG_H }, () => '.'.repeat(RIG_W))
  const map = parseMap(id, rows, 999, 40, 16, 5)
  const world = createWorld(map)
  return {
    s: createState(id, map),
    world,
    map,
    scratch: createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map)),
    fields: createFlowFields(map.groupCount, world.cells),
  }
}

const CX = 5
const CY = 4
/** The centre cell every rig below is built around: (5, 4) on a 12 x 9 board. */
const CENTRE = CY * RIG_W + CX

export interface PlusRig extends RigBase {
  readonly centre: number
  readonly north: number
  readonly south: number
  readonly east: number
  readonly west: number
}

/**
 * A plus: four orthogonal arms meeting at `centre`, so `roadDegree(centre)` is
 * **4**.
 *
 * A plus and not a T deliberately — a T is degree 3, which is the THRESHOLD, and
 * `twoAdjacentJunctions` below supplies that case. Having both is what kills
 * `>= INTERSECTION_DEGREE` -> `> INTERSECTION_DEGREE`: a degree-4 fixture alone
 * cannot see it.
 */
export function plusJunction(id = 'plus-junction'): PlusRig {
  const r = makeRig(id)
  const north = CENTRE - RIG_W
  const south = CENTRE + RIG_W
  const east = CENTRE + 1
  const west = CENTRE - 1
  for (const arm of [north, south, east, west]) {
    expect(placeRoad(r.s, r.world, CENTRE, arm), `arm toward ${arm}`).toBe(true)
  }
  return { ...r, centre: CENTRE, north, south, east, west }
}

export interface CorridorRig extends RigBase {
  readonly mid: number
  readonly west: number
  readonly east: number
}

/**
 * A straight horizontal corridor: `mid` carries a road west and a road east and
 * nothing else, so `roadDegree(mid)` is **2**.
 *
 * **The entrant this fixture admits arrives along a direction with no road bit,
 * and that is deliberate rather than sloppy.** `canEnter` has no `NO_ROAD` code
 * — its own doc explains at length why movement must not consult `roads` for
 * permission — so the direction's only job here is to name a lane. Holding the
 * two cars, their two directions and their two lanes fixed and varying ONLY the
 * centre cell's degree is what makes this the discriminator for
 * `junctionAdmitsOne`; `bentCorridor` below is the sibling where both approaches
 * do have roads, so neither reading of the fixture is the only one on file.
 */
export function straightCorridor(id = 'straight-corridor'): CorridorRig {
  const r = makeRig(id)
  const west = CENTRE - 1
  const east = CENTRE + 1
  expect(placeRoad(r.s, r.world, CENTRE, west)).toBe(true)
  expect(placeRoad(r.s, r.world, CENTRE, east)).toBe(true)
  return { ...r, mid: CENTRE, west, east }
}

export interface BentRig extends RigBase {
  readonly mid: number
  readonly west: number
  readonly south: number
}

/**
 * A degree-**2** corner: `mid` carries a road west and a road south, so a car
 * arriving eastbound and a car arriving northbound BOTH reach it along a real
 * road and still meet on a cell that is not a junction.
 *
 * This is the fixture that says the rule keys on **degree** and not on *"do both
 * approaches exist"*. Without it, `straightCorridor`'s roadless northbound
 * approach is the only negative case on file, and an implementation that
 * refused only when the entrant's approach carried a road bit would pass
 * everything.
 */
export function bentCorridor(id = 'bent-corridor'): BentRig {
  const r = makeRig(id)
  const west = CENTRE - 1
  const south = CENTRE + RIG_W
  expect(placeRoad(r.s, r.world, CENTRE, west)).toBe(true)
  expect(placeRoad(r.s, r.world, CENTRE, south)).toBe(true)
  return { ...r, mid: CENTRE, west, south }
}

export interface TwoJunctionRig extends RigBase {
  readonly left: number
  readonly right: number
}

/**
 * Two **degree-3** junctions joined by one edge — the 2-cycle fixture.
 *
 * `left` carries roads north, south and east; `right` carries roads north, south
 * and west. Each is exactly at `INTERSECTION_DEGREE`, so this rig is also the
 * boundary case for `isJunctionCell`'s `>=`.
 *
 * **Task 9 Step 7 reuses this fixture** to show that a junction upgrade written
 * onto both cells gives the head-on property back with nothing hand-written into
 * state, which is why it lives in a module and not in a `.test.ts`.
 */
export function twoAdjacentJunctions(id = 'two-adjacent-junctions'): TwoJunctionRig {
  const r = makeRig(id)
  const left = CENTRE - 1
  const right = CENTRE
  expect(placeRoad(r.s, r.world, left, right)).toBe(true)
  expect(placeRoad(r.s, r.world, left, left - RIG_W)).toBe(true)
  expect(placeRoad(r.s, r.world, left, left + RIG_W)).toBe(true)
  expect(placeRoad(r.s, r.world, right, right - RIG_W)).toBe(true)
  expect(placeRoad(r.s, r.world, right, right + RIG_W)).toBe(true)
  return { ...r, left, right }
}

export interface RaceRig extends PlusRig {
  /** The progress each racer carries into the tick. */
  readonly progress: number
}

/** How many route steps each hand-built racer carries. */
const RACE_ROUTE_LEN = 8

/**
 * Two cars one step from a degree-4 centre on **crossing axes**, both of which
 * would cross into it on the very next tick.
 *
 * Car 0 stands on the west arm heading east (lane 0); car 1 stands on the south
 * arm heading north (lane 1). Before this task both crossed on the same tick and
 * shared the cell. After it exactly one may have it, and **which one is a rule**
 * — `runMovement` ascends the car index, so car 0 takes it — rather than
 * something inherited from a loop bound. `loop.test.ts`'s fairness case is
 * written so that the descending order fails it.
 *
 * **The progress is derived, not tuned.** Both cars enter a degree-4 cell going
 * straight on, so the only multiplier that applies is `INTERSECTION_SPEED_MUL`
 * (500) and each gains `speedUnits(500)` = 165 units on the tick. The crossing
 * needs `progress + 165 >= ORTHO_THRESHOLD` = 2,500, so 2,400 crosses with a
 * residual of 65 and 2,300 would not cross at all. The test asserts the residual
 * rather than trusting the arithmetic.
 */
export function junctionRace(id = 'junction-race'): RaceRig {
  const rig = plusJunction(id)
  const progress = 2400

  // Car 0: on the west arm, whole route heading east, arrived heading east.
  handRacer(rig.s, 0, rig.west, DIR_E, progress)
  // Car 1: on the south arm, whole route heading north, arrived heading north.
  handRacer(rig.s, 1, rig.south, DIR_N, progress)

  return { ...rig, progress }
}

/** How many route steps a hand-built OCCUPANT carries. */
const OCCUPANT_ROUTE_LEN = 4

/**
 * A car STANDING on `cell`, having entered it heading `enteredBy` and about to
 * leave heading `exitBy` — byte-indistinguishable from a car that drove there.
 *
 * **M1f Task 3 needs this and Task 2 did not, and the difference is the whole
 * reason it exists.** Task 2's rule read only the occupancy slot, so its
 * fixtures could hand-`claimCell` an occupant with no phase and no route and
 * still exercise the rule exactly. Task 3's rule asks the occupant which AXIS it
 * is on, through `crossesAt` -> `previousLegDir`, and a car with no route
 * answers `NO_PREVIOUS_DIR` — which `crossesDirections` fail-closes on. So under
 * the narrowed rule a bare `claimCell` occupant refuses **every** entrant, and
 * every one of Task 2's junction cases would have stayed green by way of the
 * fail-closed branch rather than by the rule they name. That is the catalogue's
 * *"a negative assertion is only meaningful if the fixture disables every OTHER
 * mechanism that produces the same observation"*, arriving one task later
 * through a rule change rather than through a fixture mistake.
 *
 * `cursor` is 1, so `previousLegDir(outbound, 1)` reads step 0 — `enteredBy` —
 * and `travelDir` reads step 1, `exitBy`. Those differ for a turning occupant,
 * which is what makes "read the entry direction, not the direction of travel"
 * an observable choice rather than an equivalent one.
 */
export function handOccupant(
  s: GameState,
  i: number,
  cell: number,
  enteredBy: number,
  exitBy: number = enteredBy,
): void {
  s.carPhase[i] = PHASE_OUTBOUND
  s.carCell[i] = cell
  s.carRouteLen[i] = OCCUPANT_ROUTE_LEN
  s.carRouteCursor[i] = 1
  packRouteStep(s, i, 0, enteredBy)
  for (let k = 1; k < OCCUPANT_ROUTE_LEN; k++) packRouteStep(s, i, k, exitBy)
  claimCell(s, i, cell, enteredBy)
}

/**
 * An occupant that holds a slot and has NOT crossed on its current leg, so
 * `crossesAt` answers `NO_PREVIOUS_DIR`.
 *
 * **Off the reachable manifold on purpose, and the caller asserts that.**
 * Decision 3 says a car that has not crossed on its leg holds nothing, so the
 * combination of "names a slot" and "cursor 0" cannot arise through
 * `runMovement`. The one shape that DOES reach `crossesAt`'s sentinel in
 * production is a car that has just flipped to `PHASE_RETURNING` on a carpark —
 * `hasCrossedThisLeg` is false there while the outbound leg's last claim still
 * stands — and that is a state this rig cannot build without a real trip, so the
 * fail-closed branch is exercised here through the cheaper posture and labelled.
 */
export function handAxislessOccupant(s: GameState, i: number, cell: number, lane: number): void {
  s.carPhase[i] = PHASE_OUTBOUND
  s.carCell[i] = cell
  s.carRouteLen[i] = OCCUPANT_ROUTE_LEN
  s.carRouteCursor[i] = 0
  for (let k = 0; k < OCCUPANT_ROUTE_LEN; k++) packRouteStep(s, i, k, DIR_E)
  s.occupancy[cell * 2 + lane] = i
}

/**
 * One hand-written car slot, byte-indistinguishable from a car that drove here.
 *
 * `cursor` is 1 rather than 0 so `previousLegDir` answers `dir` rather than
 * `NO_PREVIOUS_DIR`: the racer is going straight on, which is the only turn
 * angle that leaves `INTERSECTION_SPEED_MUL` as the sole multiplier, and a
 * cursor of 0 would additionally mean "has not crossed on this leg" and exclude
 * the car from `assertOccupancyComplete`.
 */
function handRacer(s: GameState, i: number, cell: number, dir: number, progress: number): void {
  s.carPhase[i] = PHASE_OUTBOUND
  s.carCell[i] = cell
  s.carProgress[i] = progress
  s.carRouteLen[i] = RACE_ROUTE_LEN
  s.carRouteCursor[i] = 1
  for (let k = 0; k < RACE_ROUTE_LEN; k++) packRouteStep(s, i, k, dir)
  claimCell(s, i, cell, dir)
}
