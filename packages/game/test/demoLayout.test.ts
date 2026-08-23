import { describe, it, expect } from 'vitest'
import {
  demoCity,
  firstCity,
  CARS_PER_HOUSE,
  DEST_SPAWN_PERIOD_TICKS,
  MAX_BLOCKED_TICKS,
  OVERCROWD_FAIL_MILLITICKS,
  PIN_PERIOD_TICKS,
  REVEALED_X0,
  REVEALED_Y0,
  REVEALED_W,
  REVEALED_H,
  TERRAIN,
} from '@laneways/shared'
import {
  createFieldInputRanges,
  createFlowFields,
  createScratch,
  createState,
  createWorld,
  canEnter,
  countCommittedCars,
  ghostCommittedOf,
  ghostMaskOf,
  hashState,
  isGameOver,
  isOverCapacity,
  placeRoad,
  roadMask,
  step,
  stepCell,
  tilesLeft,
  carparkCell,
  EnterOutcome,
  FREE,
  destMetaColour,
  destMetaKind,
  destMetaOrientation,
  DEST_KIND_CIRCLE,
  ORIENTATION_E,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  H_DEST_COUNT,
  H_DEST_SPAWN_TIMER,
  H_HOUSE_COUNT,
  H_PINS_DROPPED,
  H_SCORE,
  H_SPAWN_COLOUR_CURSOR,
  H_TICK,
  H_WEEK,
  pinPeriodForWeek,
  type GameState,
  type TickAction,
  type WorldData,
} from '@laneways/sim'
import { hashBytes } from '@laneways/sim'
// See the note on the same import in `startingCity.test.ts`: one shared M1e
// re-bless proof rather than a second copy of the splice.
import { m1eInsertedRanges, spliceM1eInsertions } from '../../sim/test/m1eSplice'
import { assertM1fShapeIsPureLayout, spliceM1fInsertions } from '../../sim/test/m1fSplice'
import {
  DEMO_DESTINATIONS,
  DEMO_HOUSES,
  DEMO_ROADS,
  DEMO_RUN_SEED,
  DEMO_WARM_START_TICKS,
  seedDemoLayout,
} from '../src/demoLayout'
import { seedStartingCity } from '../src/startingCity'
import { CITY_DEATH_TICK, DEMO_DEATH_TICK } from './deathTicks'
import { NO_CROSSING, carAheadOf, longestQueue, travelDir } from '../src/queueProbe'

/**
 * The demo layout — **the board `?startapp=demo` / `?layout=demo` opens**. It
 * held `DEFAULT_LAYOUT_ID` for M1d and for M1e Tasks 1-9 and handed it back to
 * the starting city at M1e Task 10, once the spawner made that board grow;
 * `layouts.test.ts` owns that choice and **nothing in this file depends on it**
 * — every rig here names the demo board's own map, seeder, seed and warm start,
 * which is why the flip moved not one assertion in this file.
 *
 * **What this file is really testing is an OBSERVABILITY claim, not a
 * correctness one.** M1d shipped blocking, ghost roads and lane-speed
 * multipliers, all correct and all invisible: on the shipped starting city,
 * instrumented over 200,000 ticks, `REFUSED_OCCUPIED` is 0, `ENTER_VALVE` is 0
 * and the maximum number of cars in flight is 1. So the assertions below are
 * mostly INEQUALITIES over a measured run, not equalities over a fixture —
 * the question is "would a human see this", and the only honest answer is a
 * measurement on the board a player actually opens.
 *
 * The two contrast tests are what make the inequalities mean anything: the
 * same measurement on the starting city, in the same file, in the same run,
 * scores zero.
 */

const W = 24

const cellAt = (x: number, y: number): number => y * W + x

function popcount(mask: number): number {
  let n = 0
  for (let b = 0; b < 8; b++) if (mask & (1 << b)) n++
  return n
}

interface Rig {
  readonly state: GameState
  readonly world: WorldData
  /** Measures `ticks` and asserts the drive stayed inside week 0. Every window but one uses this. */
  drive(ticks: number): Measured
  /**
   * The same measurement, for a window that DELIBERATELY leaves week 0, with
   * the week it must land in named at the call site. See the assertion at the
   * foot of the loop for why this is a stronger tripwire than `drive`'s and
   * not a weaker one.
   */
  driveIntoWeek(ticks: number, endWeek: number): Measured
  /** One tick carrying player actions — the erase path in §6. */
  tick(actions: readonly TickAction[]): void
}

interface Measured {
  /** Ticks on which some car's `carBlockedTicks` rose — i.e. `canEnter` refused. */
  refusals: number
  /** Crossings whose car was saturated on the previous tick: `ENTER_VALVE`. */
  valves: number
  /** Ticks on which at least one car was refused. */
  blockedTicks: number
  maxInFlight: number
  longestQueue: number
  trips: number
  /** Distinct cars that were ever refused — the anti-vacuity counter. */
  carsEverBlocked: number
}

const NO_ACTIONS: readonly TickAction[] = Object.freeze([])

function rigFor(seed: (state: GameState, world: WorldData) => void, map = demoCity()): Rig {
  const world = createWorld(map)
  const state = createState(DEMO_RUN_SEED, map)
  const scratch = createScratch(
    world.cells,
    map.groupCount,
    map.maxDestinations,
    createFieldInputRanges(map),
  )
  const fields = createFlowFields(map.groupCount, world.cells)
  seed(state, world)
  const carCount = state.carPhase.length
  const prevBlocked = new Int32Array(carCount)
  const prevCell = new Int32Array(carCount)
  const everBlocked = new Uint8Array(carCount)
  for (let c = 0; c < carCount; c++) {
    prevBlocked[c] = state.carBlockedTicks[c] as number
    prevCell[c] = state.carCell[c] as number
  }
  const oneTick = { actions: NO_ACTIONS }
  return {
    state,
    world,
    // One tick with a caller-supplied action list, so the erase tests below go
    // through `step`'s own action dispatch rather than calling `eraseRoad`
    // beside it. Same idiom as `jamFixture`'s `tick`.
    tick(actions: readonly TickAction[]): void {
      oneTick.actions = actions
      step(state, world, fields, scratch, oneTick)
      oneTick.actions = NO_ACTIONS
    },
    drive(ticks: number): Measured {
      return this.driveIntoWeek(ticks, 0)
    },
    driveIntoWeek(ticks: number, endWeek: number): Measured {
      const out: Measured = {
        refusals: 0,
        valves: 0,
        blockedTicks: 0,
        maxInFlight: 0,
        longestQueue: 0,
        trips: 0,
        carsEverBlocked: 0,
      }
      const scoreBefore = state.header[H_SCORE] as number
      for (let t = 0; t < ticks; t++) {
        step(state, world, fields, scratch, oneTick)
        let inFlight = 0
        let blockedThisTick = false
        for (let c = 0; c < carCount; c++) {
          const phase = state.carPhase[c] as number
          if (phase === PHASE_OUTBOUND || phase === PHASE_RETURNING) inFlight++
          const blocked = state.carBlockedTicks[c] as number
          const cell = state.carCell[c] as number
          // A refusal is exactly a rise in `carBlockedTicks` — `advanceCar` is
          // that region's only writer. Same derivation as `jamFixture.ts`.
          if (blocked > (prevBlocked[c] as number)) {
            out.refusals++
            blockedThisTick = true
            everBlocked[c] = 1
          }
          if (cell !== prevCell[c] && (prevBlocked[c] as number) >= MAX_BLOCKED_TICKS) out.valves++
          prevBlocked[c] = blocked
          prevCell[c] = cell
        }
        if (inFlight > out.maxInFlight) out.maxInFlight = inFlight
        if (blockedThisTick) out.blockedTicks++
        const q = longestQueue(state, world)
        if (q > out.longestQueue) out.longestQueue = q
      }
      out.trips = (state.header[H_SCORE] as number) - scoreBefore
      for (let c = 0; c < carCount; c++) if (everBlocked[c] === 1) out.carsEverBlocked++
      // **M1e Task 6's tripwire, and it is here rather than in one test because
      // every `drive()` in this file funnels through it.** Every measured
      // figure below was taken inside week 0, where `pinPeriodForWeek(0)` is
      // `PIN_PERIOD_TICKS` bit-for-bit and the weekly demand ramp therefore
      // cannot reach them — checked directly, not derived: neutralising the
      // ramp to the bare constant reproduces 3,235 refusals / 1,401 blocked
      // ticks / 171 trips / longest queue 7 over 3,000 ticks exactly.
      //
      // The point is what happens NEXT. Lengthening any window past 4,500
      // ticks puts the drive into week 1, the period drops to 466, and every
      // threshold below silently starts measuring a different game. This fails
      // there instead — see the 5,000-tick window at the bottom of this file,
      // which does cross the boundary and says so.
      //
      // **`drive` passes 0 and every existing caller goes through it, so the
      // tripwire is unchanged.** `driveIntoWeek` is the one door out, and it
      // makes leaving week 0 a thing a test has to ASK for by naming the week
      // it expects to land in — which is a stronger statement than the old
      // refusal, because it also fails when a window lands in week 2 by
      // accident. The only caller is the matched-pair window below.
      expect(
        state.header[H_WEEK] as number,
        `this drive was declared to end in week ${endWeek} and did not`,
      ).toBe(endWeek)
      if (endWeek === 0) {
        expect(
          pinPeriodForWeek(state.header[H_WEEK] as number),
          'this drive left week 0 — the demand ramp now reaches these figures and they must be re-measured',
        ).toBe(PIN_PERIOD_TICKS)
      }
      return out
    },
  }
}

/** The three destination-side quantities the week-1 window compares. Read, never derived. */
function sumPins(rig: Rig): number {
  let n = 0
  const dc = rig.state.header[H_DEST_COUNT] as number
  for (let d = 0; d < dc; d++) n += rig.state.destPins[d] as number
  return n
}

function destinationsOverCap(rig: Rig): number {
  let n = 0
  const dc = rig.state.header[H_DEST_COUNT] as number
  for (let d = 0; d < dc; d++) if (isOverCapacity(rig.state, d)) n++
  return n
}

function peakMeter(rig: Rig): number {
  let n = 0
  const dc = rig.state.header[H_DEST_COUNT] as number
  for (let d = 0; d < dc; d++) n = Math.max(n, rig.state.destOvercrowd[d] as number)
  return n
}

function seededRig(): Rig {
  return rigFor(seedDemoLayout)
}

// ---------------------------------------------------------------------------
// 1. The tables
// ---------------------------------------------------------------------------

describe('the demo layout tables', () => {
  it('is 18 destinations, all circles, three colours in a fixed rotation order', () => {
    expect(DEMO_DESTINATIONS.length).toBe(18)
    expect(DEMO_DESTINATIONS.length).toBe(demoCity().maxDestinations)
    for (let i = 0; i < DEMO_DESTINATIONS.length; i++) {
      const d = DEMO_DESTINATIONS[i] as (typeof DEMO_DESTINATIONS)[number]
      expect(d.kind, `destination ${i} kind`).toBe(DEST_KIND_CIRCLE)
      // Colour cycles 0, 1, 2 down the rows, so `demand.ts`'s rotation walks
      // one destination of each colour before repeating — and so the slot
      // counts are exactly equal across the three colours.
      expect(d.colour, `destination ${i} colour`).toBe(i % 3)
    }
    // ALL circles is the demand lever, and it is the only one available: a
    // square contributes 1 rotation slot and a circle 2, so 18 circles is 36
    // slots and 18 squares would be 18 — half the demand, and half the cars in
    // flight. `PIN_PERIOD_TICKS` is global and cannot be tuned per layout.
    const slots = DEMO_DESTINATIONS.reduce((n, d) => n + (d.kind === DEST_KIND_CIRCLE ? 2 : 1), 0)
    expect(slots).toBe(36)
  })

  it('is 12 houses, four of each colour, so no corridor carries a double share', () => {
    expect(DEMO_HOUSES.length).toBe(12)
    expect(DEMO_HOUSES.length).toBe(demoCity().maxHouses)
    for (let c = 0; c < 3; c++) {
      expect(DEMO_HOUSES.filter((h) => h.colour === c).length, `colour ${c} houses`).toBe(4)
    }
    expect(DEMO_HOUSES.length * CARS_PER_HOUSE).toBe(24)
  })

  it('is 70 road segments and no duplicates', () => {
    expect(DEMO_ROADS.length).toBe(70)
    const seen = new Set<string>()
    for (const r of DEMO_ROADS) {
      // Undirected: normalise so (a,b) and (b,a) collide.
      const a = cellAt(r.ax, r.ay)
      const b = cellAt(r.bx, r.by)
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      expect(seen.has(key), `duplicate segment ${key}`).toBe(false)
      seen.add(key)
    }
  })

  it('every table entry is frozen at run time, not merely `readonly`', () => {
    expect(Object.isFrozen(DEMO_DESTINATIONS)).toBe(true)
    expect(Object.isFrozen(DEMO_HOUSES)).toBe(true)
    expect(Object.isFrozen(DEMO_ROADS)).toBe(true)
    expect(Object.isFrozen(DEMO_DESTINATIONS[0])).toBe(true)
    expect(Object.isFrozen(DEMO_HOUSES[0])).toBe(true)
    expect(Object.isFrozen(DEMO_ROADS[0])).toBe(true)
  })

  it('places everything it draws inside the revealed rect', () => {
    const inside = (x: number, y: number): boolean =>
      x >= REVEALED_X0 && x < REVEALED_X0 + REVEALED_W && y >= REVEALED_Y0 && y < REVEALED_Y0 + REVEALED_H
    for (const h of DEMO_HOUSES) expect(inside(h.x, h.y), `house (${h.x}, ${h.y})`).toBe(true)
    for (const r of DEMO_ROADS) {
      expect(inside(r.ax, r.ay), `road end (${r.ax}, ${r.ay})`).toBe(true)
      expect(inside(r.bx, r.by), `road end (${r.bx}, ${r.by})`).toBe(true)
    }
    for (const d of DEMO_DESTINATIONS) {
      // The footprint is 3 wide x 2 tall for E/W, plus the carpark one cell to
      // the side. Checking the extreme corners covers all 7.
      const dx = d.orientation === ORIENTATION_E ? 3 : -1
      expect(inside(d.x, d.y), `destination origin (${d.x}, ${d.y})`).toBe(true)
      expect(inside(d.x + 2, d.y + 1), `destination corner`).toBe(true)
      expect(inside(d.x + dx, d.y), `carpark`).toBe(true)
    }
  })

  it('every road segment is orthogonal and one cell long — no accidental diagonal', () => {
    for (const r of DEMO_ROADS) {
      const dx = Math.abs(r.ax - r.bx)
      const dy = Math.abs(r.ay - r.by)
      expect(dx + dy, `segment (${r.ax},${r.ay})-(${r.bx},${r.by})`).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. The seeder
// ---------------------------------------------------------------------------

describe('seedDemoLayout', () => {
  it('places every destination, house and road — none silently refused', () => {
    const { state, world } = seededRig()
    expect(state.header[H_DEST_COUNT] as number).toBe(18)
    expect(state.header[H_HOUSE_COUNT] as number).toBe(12)
    // 70 segments over 71 cells: the seeder throws by name on any `false`
    // return, so reaching here at all means all 70 were accepted. The cell
    // count is the independent check that they are the segments intended.
    let roadCells = 0
    for (let c = 0; c < world.cells; c++) if ((state.roads[c] as number) !== 0) roadCells++
    expect(roadCells).toBe(71)
    expect(tilesLeft(state)).toBe(200 - 71)
  })

  it('stores each destination with the colour, kind, orientation and carpark the table names', () => {
    const { state, world } = seededRig()
    for (let i = 0; i < DEMO_DESTINATIONS.length; i++) {
      const d = DEMO_DESTINATIONS[i] as (typeof DEMO_DESTINATIONS)[number]
      const meta = state.destMeta[i] as number
      expect(state.destCell[i] as number, `destination ${i} cell`).toBe(cellAt(d.x, d.y))
      expect(destMetaColour(meta), `destination ${i} colour`).toBe(d.colour)
      expect(destMetaKind(meta), `destination ${i} kind`).toBe(d.kind)
      expect(destMetaOrientation(meta), `destination ${i} orientation`).toBe(d.orientation)
      // The carpark is the cell the corridor has to reach, so it is asserted
      // rather than assumed: colour 0 opens EAST onto column 8, colour 1 EAST
      // onto column 13, colour 2 WEST onto column 15.
      const carpark = carparkCell(cellAt(d.x, d.y), d.orientation, world.w, world.h)
      const expectedX = d.colour === 0 ? 8 : d.colour === 1 ? 13 : 15
      expect(carpark, `destination ${i} carpark`).toBe(cellAt(expectedX, d.y))
      // ...and the corridor really does run through it.
      expect((state.roads[carpark] as number) !== 0, `carpark ${i} is on a road`).toBe(true)
    }
  })

  it('gives every house two cars, parked on its own cell, in slot order', () => {
    const { state } = seededRig()
    for (let h = 0; h < DEMO_HOUSES.length; h++) {
      const house = DEMO_HOUSES[h] as (typeof DEMO_HOUSES)[number]
      expect(state.houseCell[h] as number).toBe(cellAt(house.x, house.y))
      expect(state.houseColour[h] as number).toBe(house.colour)
      for (let k = 0; k < CARS_PER_HOUSE; k++) {
        const car = h * CARS_PER_HOUSE + k
        expect(state.carHome[car] as number, `car ${car} home`).toBe(h)
        expect(state.carCell[car] as number, `car ${car} cell`).toBe(cellAt(house.x, house.y))
      }
    }
    expect(state.carPhase.length).toBe(24)
  })

  it('clears no tree — every seeded road avoids all ten', () => {
    // A road placed on a TREE sets `cleared[cell]`, so a tree under the network
    // would silently vanish on boot. This is the assertion that says the tree
    // table and the road table were reconciled rather than each written alone.
    const { state, world } = seededRig()
    expect(state.cleared.every((b) => b === 0)).toBe(true)
    let trees = 0
    for (let c = 0; c < world.cells; c++) {
      if (world.terrain[c] === TERRAIN.TREE) {
        trees++
        expect(state.roads[c] as number, `road on the tree at cell ${c}`).toBe(0)
      }
    }
    expect(trees).toBe(10)
  })

  it('builds a TREE: 71 cells, 70 edges, one connected component', () => {
    // A tree is what makes every route hand-derivable — exactly one path
    // between any two cells, so the flow field cannot route around the
    // bottleneck and the corridor a colour uses is decided by the geometry
    // rather than by a tie-break.
    const { state, world } = seededRig()
    const cells: number[] = []
    for (let c = 0; c < world.cells; c++) if ((state.roads[c] as number) !== 0) cells.push(c)
    expect(cells.length).toBe(71)
    let halfEdges = 0
    for (const c of cells) halfEdges += popcount(roadMask(state, c))
    expect(halfEdges % 2).toBe(0)
    expect(halfEdges / 2).toBe(70)

    // One component, by flood fill from the first road cell.
    const seen = new Set<number>()
    const stack = [cells[0] as number]
    seen.add(cells[0] as number)
    const DXS = [0, 1, 1, 1, 0, -1, -1, -1]
    const DYS = [-1, -1, 0, 1, 1, 1, 0, -1]
    while (stack.length > 0) {
      const cur = stack.pop() as number
      const mask = roadMask(state, cur)
      for (let d = 0; d < 8; d++) {
        if ((mask & (1 << d)) === 0) continue
        const nx = (cur % world.w) + (DXS[d] as number)
        const ny = ((cur / world.w) | 0) + (DYS[d] as number)
        const next = ny * world.w + nx
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    expect(seen.size).toBe(71)
  })

  it('produces the exact road degrees the multiplier showcase rests on', () => {
    const { state } = seededRig()
    const degree = (x: number, y: number): number => popcount(roadMask(state, cellAt(x, y)))

    // Three corridor mouths, degree 3: a car turning off the street into a
    // corridor takes a 90 degree turn INTO a junction. `laneSpeedMul` averages
    // 667 and 500 to 583 -> 192 units -> 14 ticks for that crossing, against 8
    // on the straight cells either side.
    expect(degree(8, 28), 'corridor A mouth').toBe(3)
    expect(degree(13, 28), 'corridor B mouth').toBe(3)
    expect(degree(16, 28), 'corridor C mouth').toBe(3)

    // The dogleg: two PLAIN degree-2 right angles, no junction confound. 667
    // alone -> 220 units -> 12 ticks. These two cells exist so the demo shows
    // the right-angle multiplier on its own, next to the same turn at a
    // junction, on one screen.
    expect(degree(15, 26), 'dogleg corner').toBe(2)
    expect(degree(16, 26), 'dogleg corner').toBe(2)

    // Straight corridor: no multiplier at all, 8 ticks per cell.
    expect(degree(8, 15), 'corridor A mid').toBe(2)
    expect(degree(13, 20), 'corridor B mid').toBe(2)

    // Dead ends: the street's two tips (both houses) and the three corridor
    // heads (all carparks).
    expect(degree(5, 28), 'street west tip').toBe(1)
    expect(degree(17, 28), 'street east tip').toBe(1)
    expect(degree(8, 9), 'corridor A head').toBe(1)
    expect(degree(13, 9), 'corridor B head').toBe(1)
    expect(degree(15, 9), 'corridor C head').toBe(1)
  })

  it('throws by name rather than shipping half a city, and a second call is refused', () => {
    const map = demoCity()
    const world = createWorld(map)
    const state = createState(DEMO_RUN_SEED, map)
    seedDemoLayout(state, world)
    // Every placement in a second pass is rejected by the rule that accepted
    // the first, which is the correct outcome and must be LOUD.
    expect(() => {
      seedDemoLayout(state, world)
    }).toThrow(/seedDemoLayout: destination 0/)
  })

  it('names the house in the message when one is refused', () => {
    // Same reason as the road case below, and it was found the same way: with
    // the throw suppressed but the placement left in, the mutant is a NO-OP on
    // the happy path — every house places, so nothing fails. A guard against a
    // rejection needs a fixture where a rejection happens.
    //
    // A road on a house cell is the way to force exactly one: `canPlaceHouse`
    // rejects a cell carrying a road, the seeder lays its own roads LAST, and
    // no destination's 7 cells reach row 28 — so the 18 destinations still
    // place and house 0 at (5, 28) is the first thing refused.
    const map = demoCity()
    const world = createWorld(map)
    const state = createState(DEMO_RUN_SEED, map)
    expect(placeRoad(state, world, cellAt(5, 28), cellAt(6, 28))).toBe(true)
    expect(() => {
      seedDemoLayout(state, world)
    }).toThrow(/seedDemoLayout: house 0 at \(5, 28\)/)
  })

  it('names the road in the message when a segment is refused', () => {
    // The seeder's third loop is the one with no other observer: destinations
    // and houses are counted above, but a refused ROAD would just leave the
    // network one segment short and every other assertion here would pass.
    const map = demoCity()
    const world = createWorld(map)
    const state = createState(DEMO_RUN_SEED, map)
    // A destination footprint cell is road-illegal (the driveway rule), so
    // occupying the whole tile budget is the way to force a refusal without
    // touching the tables: 0 tiles left refuses the very first segment.
    state.header[3] = 0
    expect(() => {
      seedDemoLayout(state, world)
    }).toThrow(/seedDemoLayout: road 0 /)
  })
})

// ---------------------------------------------------------------------------
// 3. The golden
// ---------------------------------------------------------------------------

describe('the demo-layout golden', () => {
  it('pins hashState over the whole seeded buffer', () => {
    const { state } = seededRig()
    // Guards FIRST, so this is a golden over a city and not over an empty
    // board that happened to hash to something.
    expect(state.header[H_DEST_COUNT] as number).toBe(18)
    expect(state.header[H_HOUSE_COUNT] as number).toBe(12)
    expect(state.ghostMask.every((b) => b === 0), 'the seed erases nothing').toBe(true)
    // Minted in M2's demo-board task. It is the ONLY new golden there: the
    // post-warm-start state deliberately gets none, because a demo layout gets
    // tuned and a golden re-blessed on every tune stops being a tripwire. The
    // behaviour after the warm start is pinned as inequalities below instead.
    //
    // **Re-blessed once, in M1e Task 1 (was 1039862014), and in no other task
    // of the milestone** — it is taken immediately after `seedDemoLayout`,
    // before any tick, so nothing behavioural M1e adds can reach it.
    //
    // **PURE LAYOUT, proved by an exact byte splice** (`m1eSplice.ts`).
    // Removing the two inserted ranges — 16 B of new header slots at offset 52
    // and 156 B of new regions at offset 668, both MID-BUFFER — reproduces
    // 1039862014 bit-for-bit with no slot zeroed. `createState`'s two initial
    // timer writes land inside those ranges, so there is no behavioural term.
    // Offsets are FOR `demoCity`, and this is the one fixture whose block B is
    // NOT 148 B: the demo has groupCount 3 and maxDestinations 18 against
    // `firstCity`'s 5 and 16, so `(3 + 18 + 18) * 4 = 156`. Quoting
    // `startingCity.test.ts`'s figures here would be a fabricated derivation.
    const m1e = m1eInsertedRanges(demoCity())
    expect([m1e.aStart, m1e.aEnd, m1e.bStart, m1e.bEnd]).toEqual([52, 68, 688, 844])
    const spliced = spliceM1eInsertions(state, demoCity())
    expect(spliced.length, "the splice must land on M1d's buffer size").toBe(9720)
    expect(m1e.totalBytes).toBe(10872)
    expect(hashBytes(spliced), 'the splice must reproduce the pre-M1e digest').toBe(1039862014)
    // **Re-blessed at M1f Task 4: 3152640907 -> 4178976587, PURE LAYOUT.** The
    // milestone's only shape change — `HEADER_LENGTH` 13 -> 18 and one region,
    // `upgradeAt`, one Uint8 flag per cell. `demoCity` goes 9,892 -> 10,872 B.
    //
    // **And this map is why `m1fSplice.ts` does not assert "no trailing pad".**
    // `demoCity`'s last region ends at 10,870 of 10,872 — a 2-byte tail pad,
    // present before and after — so the brief's specified guard would have
    // thrown here, on the map behind this very digest, and the splice it
    // described would have removed 962 bytes instead of 960.
    assertM1fShapeIsPureLayout(state, demoCity())
    expect(
      hashBytes(spliceM1fInsertions(state, demoCity())),
      'the M1f splice must reproduce the pre-M1f digest',
    ).toBe(3152640907)
    expect(hashState(state)).toBe(4178976587)
  })

  it('differs from an unseeded demoCity — otherwise the golden pins nothing', () => {
    const map = demoCity()
    expect(hashState(rigFor(seedDemoLayout).state)).not.toBe(
      hashState(createState(DEMO_RUN_SEED, map)),
    )
  })

  it('leaves the shipped seed golden 613441763 exactly where it was', () => {
    // In the SAME file and the same run as the demo golden, deliberately: the
    // one thing a demo-board change must not do is move the CITY's number.
    // `startingCity.test.ts:237` fixes the seed this golden was blessed under;
    // it is 'm2-starting-city', NOT `RUN_SEED`, and the RNG state is inside the
    // hashed buffer, so the wrong seed here reads as a moved golden.
    //
    // Re-blessed in M1e Task 1 (was 1178110182) and again at M1f Task 4
    // (968680755 -> 613441763), both times for the same pure-layout reason as
    // its owner in `startingCity.test.ts`. Deliberately NOT given a splice proof
    // of its own: this is a duplicate of that golden, and the proof lives once,
    // beside the assertion that owns the number.
    const map = firstCity()
    const world = createWorld(map)
    const state = createState('m2-starting-city', map)
    seedStartingCity(state, world)
    expect(hashState(state)).toBe(613441763)
  })
})

// ---------------------------------------------------------------------------
// 4. The observability claim, measured
// ---------------------------------------------------------------------------

/**
 * **The tick this board kills itself on — MEASURED at M1e Task 7, not predicted.**
 *
 * Booted exactly as `createGame` boots it (`demoCity()` + `seedDemoLayout` +
 * `createState('laneways-demo')` + the 1,200-tick warm start) and given NO
 * player input at all, the demo board reaches the overcrowd failure threshold
 * on tick **6,703** — three minutes and forty-three seconds in. **Re-measured at
 * M1f Task 2 as 5,757 (3 min 12 s); every figure in the table below is the M1e
 * one and is kept as the control, with the moved ones marked.** Task 7
 * integrates the meter and Task 8 is what makes reaching it end the run, so
 * nothing in this file can observe the shutdown yet. Plan Decision 7 accepts
 * this deliberately: the demo board is an intentionally overloaded city, and a
 * milestone whose headline is "an overloaded city dies" should kill it.
 *
 * | | |
 * |---|---|
 * | Dies at tick | **6,703** — **3 min 43 s** — **MOVED at M1f Task 2 to 5,757, 3 min 12 s** |
 * | Destination | **D2**, `DEMO_DESTINATIONS[2]`, grid (16, 9), `ORIENTATION_W`, colour 2 |
 * | Kind | **circle** — 2 rotation slots, trigger cap 8, hard cap 14 |
 * | Arrivals it received | **6**, against a median of **25.5** across the eighteen |
 * | Its last arrival | tick **1,549** — **349 ticks, 11.6 s, of VISIBLE play** |
 * | At or over its cap from | tick **3,314** — **MOVED at M1f Task 2: the FIRST destination over cap is now tick 2,278** |
 * | Next longest at-cap run | **943** (D5, from 5,761); **0** for the other sixteen |
 * | With the knockback removed / the unwind removed / both | **6,703, unchanged, all three** (M1e; not re-run at M1f Task 2 — the claim is that neither term is load-bearing, and nothing about junction exclusion touches either) |
 *
 * **It dies because it is DEPRIORITISED, not because it is unreachable — and
 * that is a different mechanism from the city board's, which the word
 * "starvation" hides.** D2 is connected and served: six cars reach it, the last
 * at tick 1,549. It then loses every subsequent dispatch, because cars route to
 * the nearest unfilled pin of their colour (§5.4) and D2 sits at the far end of
 * corridor C. Its pin count is monotone from 1,549 to the hard cap of 14, so no
 * knockback-side lever reaches it — removing the arrival knockback, the unwind,
 * or both leaves the death tick unmoved to the tick. On `firstCity` the same
 * word describes something else entirely: there D2 has **no road at all**, zero
 * arrivals ever, and an arrival interval of literal infinity. Deprioritised and
 * unreachable want different fixes, and Task 10's gate should not treat them as
 * one case.
 *
 * ---------------------------------------------------------------------------
 * **A CORRECTION, because this comment carried a fabricated one — read it
 * before trusting any figure above.**
 * ---------------------------------------------------------------------------
 *
 * An earlier version of this block said D2's last arrival was **1,274**, called
 * the plan's 1,549 stale, and attributed the move to Tasks 5 and 6. **All three
 * of those were wrong.** The 1,274 came from a measurement harness that
 * hard-coded `PHASE_OUTBOUND = 1` and `PHASE_RETURNING = 2` when the real values
 * are 2 and 3 — so it was detecting `IDLE -> OUTBOUND` and counting
 * **dispatches, not arrivals**. Two "independent" integrations agreed with each
 * other because both imported the same wrong constant from the same harness.
 *
 * Re-measured with the real constants and cross-checked against a second oracle
 * that touches no phase constant at all — a decrement of `destPins`, which is
 * written in exactly two places repo-wide (`demand.ts` adds, `trips.ts`
 * subtracts) — and against direct instrumentation of `arriveAtDestination`. All
 * three agree: D2's arrivals land on ticks **341, 384, 1,470, 1,498, 1,533,
 * 1,549**, and 1,549 is the last one **in all four counterfactual arms and with
 * the ramp neutralised**. The attribution was falsified under exactly the
 * conditions it named.
 *
 * **What IS attributable to Tasks 5 and 6, measured by neutralising them:**
 * the arrival median moved **24 -> 25.5** (the plan's 24 reproduces exactly with
 * the ramp neutralised), and D5's longest at-cap run moved **267 -> 943** (the
 * plan's 272 is within a handful of the 267 that the ramp-neutralised arm
 * gives; the residue is Task 5's spawner). The death tick, the destination, its
 * kind, its six arrivals and its last arrival are unmoved by either task.
 *
 * **And `demoLayout.ts`'s headline "1,324 trips over 20,000 ticks" is now
 * stale by the same two tasks.** On this tree the figure is **1,464**. Parking
 * the spawner alone gives 1,460; neutralising the ramp alone gives 1,330; doing
 * both reproduces **1,324 exactly**, which is what says the harness that
 * produced every number in this comment is the real board and not something
 * else.
 *
 * The integer itself lives in `deathTicks.ts`, shared with the two other files
 * that need it; everything above is this board's own derivation.
 */

describe('the demo layout is visibly congested, measured over 3,000 ticks', () => {
  const TICKS = 3000

  it('keeps this window below the tick the board kills itself on', () => {
    // See `DEMO_DEATH_TICK`. Nothing here can observe the shutdown until Task 8
    // wires it, so this is the mechanism that stops a later task lengthening
    // the window into a frozen sim and asserting over a corpse. A strict
    // inequality against an independently measured number: 6,703 came off a
    // 40,000-tick drive of the real boot path, and 3,000 is this file's own
    // choice.
    // **Re-measured twice inside M1f: 6,703 -> 5,757 (Task 2's wide rule) ->
    // 6,660 (Task 3's crossing-only rule).** The window is unchanged at 3,000
    // and the margin therefore went 55 % -> 48 % -> 55 % again. Both numbers are
    // re-derived rather than relaxed — the assertion is still an exact figure,
    // so the next move has to be made on purpose, and the margin returning to
    // its pre-M1f value is a measurement rather than a restoration.
    expect(DEMO_DEATH_TICK).toBe(6660)
    expect(TICKS).toBeLessThan(DEMO_DEATH_TICK)
    expect(Math.round((1 - TICKS / DEMO_DEATH_TICK) * 100), 'margin, as a figure').toBe(55)
  })

  it('queues continuously: thousands of refusals, over half of all ticks blocked', () => {
    const measured = seededRig().drive(TICKS)
    // The shipped city scores 0 on every one of these — see the contrast test
    // below. The thresholds sit at roughly half the measured figures so that
    // ordinary drift does not fail them and a collapse back to the shipped city
    // does.
    //
    // **Measured on this rig, this seed, and THIS 3,000-tick window.** M1f Task
    // 2 moved every one of them, in the direction junction exclusion predicts
    // and by more than any previous milestone did — and **M1f Task 3 moved them
    // most of the way back**, which is what the triage between the two rules
    // measured. Both M1f columns are kept because the choice between them is
    // only legible with both:
    //
    // ```
    //                    pre-M1f   T2 (wide)   T3 (crossing, ships)
    //   refusals           3,235      39,795      5,463   x1.69 on pre-M1f
    //   blocked ticks      1,401       2,413      1,781   (of 3,000)
    //   longest queue          7          17          8
    //   trips                171          66        168   -1.8 %
    //   valve firings          0           7          0
    //   cars ever blocked     24          24         24
    // ```
    //
    // **`longest queue` is a POST-REPAIR number.** `carAheadOf` read one lane
    // until this commit, so it reported "nothing ahead" for a car `canEnter` was
    // refusing across a junction; it now answers with the own lane first and the
    // other lane as the tie-break. Every `longestQueue` figure in this repo is a
    // measurement from after that repair — see `queueProbe.ts`. The probe/`canEnter`
    // agreement property below is what makes that checkable rather than asserted.
    //
    // Two of those four moved in M1e and neither moved for the reason a reader
    // would guess. The previous figures here — 3,125 / 1,350 / 7 / 171 — were
    // taken before **Task 5's spawner**, whose §5.3.5 blocked-spawn push adds
    // pins to a board that is already at `maxDestinations` and therefore adds
    // traffic. `longestQueue` and `trips` are unchanged. **It is NOT the weekly
    // demand ramp**, and that is a measurement rather than an inference: with
    // the ramp neutralised to the bare `PIN_PERIOD_TICKS`, this window
    // reproduces 3,235 / 1,401 / 7 / 171 exactly, because 3,000 ticks from tick
    // 0 never leave week 0 and `pinPeriodForWeek(0)` IS that constant. The
    // `drive()` helper now asserts that premise rather than leaving it here as
    // prose.
    //
    // **A figure quoted without its window is the shape that produced the
    // 3,483 / 1,563 confusion this comment used to be about.** Those two were
    // never reproducible from this fixture: `refusals` and `blockedTicks` are
    // read off `carBlockedTicks`, which no probe touches. The third of that
    // trio, a longest queue of 8, came from a **20,000-tick window measured in
    // a REVIEW — a window this file has never driven and does not drive now**
    // (its two windows are this 3,000-tick one and the 5,000-tick one at the
    // bottom of the file). Under the lane-blind probe that review's figure was
    // 10; under the current probe it is 8. Neither number says anything about
    // the 7 measured here, and neither is re-measured by anything in this file.
    expect(measured.refusals).toBeGreaterThan(1500)
    expect(measured.blockedTicks).toBeGreaterThan(750)
    expect(measured.longestQueue).toBeGreaterThanOrEqual(4)
    // Every threshold above is a FLOOR that predates M1f, and every measured
    // value is still above it under all three rules, so none of them has ever
    // been re-fitted. Stated because a block whose numbers all moved and whose
    // assertions all stayed is the shape a reader should check rather than
    // assume.
    //
    // **This last line is a PIN, not a floor, and it is last for that reason.**
    // Task 2 wrote `> 30000` here to record that refusals had gone up 12.3x;
    // under Task 3's rule they are 5,463, so a floor at 30,000 would now be
    // false. Replacing it with a floor just under 5,463 would be re-fitting a
    // threshold to a measurement, which is the thing the paragraph above says
    // this block does not do. So the move goes on the record as the exact
    // figure — it fires for any change in either direction, and the three
    // loose floors above it are what say the board is still congested.
    expect(measured.refusals, 'T3 crossing-only: 5,463 (3,235 pre-M1f, 39,795 wide)').toBe(5463)
    expect(measured.blockedTicks, 'and 1,781 of 3,000 ticks carry a blocked car').toBe(1781)
    // Not one unlucky car going round in circles: the refusals are spread over
    // most of the fleet. Without this, a single permanently-stuck car would
    // satisfy every threshold above.
    expect(measured.carsEverBlocked).toBeGreaterThanOrEqual(18)
  })

  it('puts the whole fleet on the road, where the shipped city puts one car', () => {
    const measured = seededRig().drive(TICKS)
    expect(measured.maxInFlight).toBe(24)
  })

  it('GRINDS rather than stops — throughput stays high while it queues', () => {
    // The acceptance criterion the first draft of this layout failed. A single
    // shared trunk with the same 24 cars delivered 47 trips and fired the
    // anti-deadlock valve 214 times: total gridlock, which demonstrates the
    // OPPOSITE of Decision 6's "a gridlocked city grinds rather than stops" and
    // reads to a player as a bug.
    //
    // **Both of those figures are from a 20,000-tick window measured in a
    // REVIEW, on a LAYOUT THAT NO LONGER EXISTS. Nothing in this file drives
    // 20,000 ticks and nothing here can reproduce them** — they are kept as the
    // reason the three-corridor layout is shaped the way it is, not as a
    // measurement this suite maintains. The window this test actually drives is
    // `TICKS` = 3,000, over which the shipped three-corridor layout delivers
    // **171** trips.
    //
    // -------------------------------------------------------------------
    // **M1f TASK 2 TOOK THIS BOARD FROM 171 TRIPS TO 66 AND MADE THE VALVE
    // FIRE. TASK 3 TOOK IT BACK TO 168 AND STOPPED THE VALVE AGAIN.**
    // -------------------------------------------------------------------
    //
    // The two numbers this criterion was written against belong to a
    // 20,000-tick window on a layout that no longer exists: **47 trips and 214
    // valve firings**. Normalising all three to that window so the comparison is
    // between like quantities, which is the only way the criterion means
    // anything:
    //
    // ```
    //                        trips/20k ticks   valves/20k ticks
    //   the gridlocked draft            47              214
    //   pre-M1f three-corridor       1,140                0
    //   M1f Task 2, wide rule          440               47
    //   M1f Task 3, crossing only    1,120                0
    // ```
    //
    // So the board is **23.8x better than the gridlocked draft on throughput**
    // and 1.8 % worse than it was pre-M1f. Under the wide rule it was 9.4x and
    // 2.6x respectively — degraded but not tipped, which is why that rule
    // cleared this criterion and was still refused on the demo rig's margin.
    //
    // **The valve is back to 0 and that is not the same statement it was
    // pre-M1f.** Pre-M1f a firing meant a cycle of length >= 3, because the
    // two-lane model made a 2-cycle impossible. Task 2's wide rule made
    // 2-cycles ordinary (two cars swapping across an edge with a junction at
    // each end); Task 3 admits the straight swap and so removes most of them,
    // but not the ones whose occupant TURNED. Zero here means this board never
    // produces the turning kind — not that they cannot happen, and the city arm
    // still fires 5.
    //
    // **The thresholds are re-derived against the gridlocked draft, not against
    // the new measurement.** 300 per 20,000 ticks is 6.4x the draft's 47 and 1.5x
    // below today's 440; 100 firings per 20,000 is below the draft's 214 and
    // above today's 47. Setting them just under the measurement would be the
    // catalogue's "survivability gate passed by deleting the difficulty" —
    // these are set where the criterion's own failure case sits.
    const measured = seededRig().drive(TICKS)
    const perTwentyK = (n: number): number => (n * 20000) / TICKS
    expect(perTwentyK(measured.trips), 'the gridlocked draft managed 47').toBeGreaterThan(300)
    expect(perTwentyK(measured.valves), 'the gridlocked draft fired 214').toBeLessThan(100)
    // And the two figures as measured, so the move is on the record rather than
    // hidden inside a normalisation.
    expect(measured.trips, 'T3 crossing-only: 168 (171 pre-M1f, 66 wide)').toBe(168)
    expect(measured.valves, 'and the valve is quiet again — 0 pre-M1f, 7 wide').toBe(0)
  })

  it('is not vacuous: the SHIPPED city, same rig, same ticks, scores zero', () => {
    // The catalogue's most-repeated shape, applied to a measurement rather than
    // to a guard: every threshold above is meaningless unless something fails
    // it. `seedStartingCity` on `firstCity` is the board the user actually
    // opened and called "the same demo".
    const shipped = rigFor(seedStartingCity, firstCity()).drive(TICKS)
    expect(shipped.refusals).toBe(0)
    expect(shipped.valves).toBe(0)
    expect(shipped.blockedTicks).toBe(0)
    expect(shipped.longestQueue).toBeLessThanOrEqual(1)
    expect(shipped.maxInFlight).toBeLessThanOrEqual(1)
  })

  it('the queue figures above are the SIM’s answer: the probe agrees with canEnter', () => {
    // **Every threshold in this section is a number the probe produced, so the
    // probe is part of the claim.** The first one shipped keyed occupancy by the
    // cell alone, on a board whose headline feature is two lanes per cell, and
    // was wrong on 15.2 % of the questions it asked here.
    //
    // The corridor version of this check lives in `queueProbe.test.ts`; this one
    // is on the demo board specifically, because a straight corridor has no
    // TURNS — and a turn is where the lane a car occupies stops being the lane
    // of the direction it is facing. Three corridor mouths and a dogleg are the
    // reason this board exists.
    const rig = seededRig()
    let asked = 0
    let blocked = 0
    let free = 0
    for (let t = 0; t < 600; t++) {
      rig.drive(1)
      for (let c = 0; c < rig.state.carPhase.length; c++) {
        const dir = travelDir(rig.state, c)
        if (dir === NO_CROSSING) continue
        const next = stepCell(rig.state.carCell[c] as number, dir, rig.world.w, rig.world.h)
        if (next < 0) continue
        const outcome = canEnter(rig.state, rig.world, c, next, dir)
        const simSaysBlocked =
          outcome === EnterOutcome.REFUSED_OCCUPIED || outcome === EnterOutcome.ENTER_VALVE
        expect(carAheadOf(rig.state, rig.world, c) !== FREE, `tick ${t}, car ${c}`).toBe(
          simSaysBlocked,
        )
        asked++
        if (simSaysBlocked) blocked++
        else free++
      }
    }
    // Non-vacuity in both directions — a window where nothing was asked, or
    // where every answer was the same, proves nothing.
    expect(asked).toBeGreaterThan(5000)
    expect(blocked).toBeGreaterThan(500)
    expect(free).toBeGreaterThan(500)
  })
})

// ---------------------------------------------------------------------------
// 4b. Past week 0 — the window nothing in this suite drove (M1e Task 8)
// ---------------------------------------------------------------------------

/**
 * **M1e Task 6 left this open with Task 8 as the named recipient**, and the gap
 * was bigger than the two prose figures Task 6 corrected. Every window in this
 * file before now ends inside week 0: the congestion block drives 3,000 ticks,
 * `drive()` asserts it never left, and the spawn window at the foot of the file
 * crosses the boundary but measures §5.3.5 pushes rather than the board. So
 * **since Task 5's spawner and Task 6's demand ramp landed, nothing had
 * measured what `demoCity` DOES once the period drops.**
 *
 * This is a new window, not a longer one — deliberately. Lengthening the
 * 3,000-tick block would have re-based four figures whose whole value is that
 * they are a stable week-0 baseline, and it would have hidden the comparison
 * this section exists to make inside a single aggregate.
 *
 * **The shape is a matched pair**: two adjacent windows, one ending on the
 * boundary and one starting from it, measured by the same rig on the same run.
 * `pinPeriodForWeek` goes 518 -> 466, so week 1 asks for pins 11 % faster.
 *
 * ---------------------------------------------------------------------------
 * **M1f TASK 2 SHORTENED THE WINDOW FROM 1,500 TO 1,000 AND FALSIFIED HALF OF
 * WHAT THIS BLOCK CLAIMED. TASK 3 PUT BOTH BACK, AND ALL THREE ARE WRITTEN
 * OUT.**
 * ---------------------------------------------------------------------------
 *
 * Task 2's wide rule moved `DEMO_DEATH_TICK` from 6,703 to 5,757, so the old far
 * end — 6,000 — was past the shutdown and the second window would have profiled
 * a corpse; 1,000 put it at 5,500 with 257 ticks (4.5 %) of margin. Task 3's
 * crossing-only rule puts the death tick at **6,660**, so the 1,500-tick window
 * is affordable again: 6,000 against 6,660 is **660 ticks (9.9 %)**, against
 * 703 (10.5 %) pre-M1f. **The window is restored rather than left short**,
 * because the reason it was shortened is gone and a shortened window that
 * outlives its reason is an exemption that reads as a constraint. The
 * `isGameOver` read below is the mechanical guard and is what actually protects
 * the figures; the arithmetic one is beside it.
 *
 * ```
 *                     pre-M1f, 1,500   T2 wide, 1,000    T3 ships, 1,500
 *                   3,000..    4,500..  3,500..  4,500..  3,000..    4,500..
 *                     4,500     6,000    4,500    5,500    4,500      6,000
 *   refusals          1,816     1,622   22,756   22,301    3,678      3,239
 *   ticks with block    843       738    1,000    1,000    1,034      1,008
 *   trips               101        99        6       10       97         95
 *   cars in flight       24        24       24       24       24         24
 *   longest queue         6         7       16       14       10          8
 *   valve firings         0         0       11        4        0          0
 *
 *   at tick           4,500     6,000    4,500    5,500    4,500      6,000
 *   sum of destPins      29        40      220      249       35         50
 *   dests at/over cap  1/18      2/18    18/18    18/18     1/18       3/18
 *   peak meter      469,656 1,937,000 1,383,000 2,383,000 504,300 1,980,000
 * ```
 *
 * **The fleet is the binding constraint, not the demand.** All 24 cars are in
 * flight in both windows, so faster pin arrival cannot produce more journeys —
 * it produces a longer queue at the destinations, and that is what ends the run.
 * That half survived Task 2 (throughput at the floor, 6 and 10 trips) and is
 * back to its pre-M1f form under Task 3, 97 and 95 against 101 and 99.
 *
 * **The half that did not survive Task 2 has come back, and the round trip is
 * worth more than either reading alone.** This block used to say *"the
 * 3,000-tick window cannot see any of it: at tick 3,000 no destination is over
 * its cap and every meter reads 0"*. Under the wide rule the first destination
 * went over cap at tick 2,278 with the first meter at 2,279, so the baseline
 * window saw a third of the run's overcrowd pressure and the sentence was
 * inverted. Under Task 3's rule **no destination is over cap anywhere in the
 * first 3,000 ticks and every meter reads 0 again**, measured on the same walk.
 * So the congestion block above is once more a clean week-0, pre-overcrowd
 * baseline, and `is not vacuous` below asserts that as the exact figure it is
 * rather than as a restored adjective.
 *
 * **`destinations at/over cap` is unsaturated again** — 1 of 18 at the boundary
 * and 3 of 18 at the far end, where the wide rule had 18/18 at both — so the
 * assertion that it GROWS across the boundary is reinstated rather than replaced
 * by the "and none of them recovers" form the saturation forced.
 *
 * **Stated because it limits the claim: these two windows are adjacent in TIME,
 * not a treatment and a control.** They cannot separate "week 1" from "later in
 * the run" — a queue that has been building since tick 0 would grow across this
 * boundary with no ramp at all. What the pair does establish is that the board's
 * behaviour past week 0 is now measured rather than assumed, and that the
 * quantity moving is backlog rather than throughput. Isolating the ramp itself
 * needs `pinPeriodForWeek` neutralised, which is `sim`'s to expose and no test
 * here can do.
 */
describe('the demo layout past week 0, in matched 1,500-tick windows', () => {
  const WINDOW = 1500
  const BOUNDARY = 4500
  const END = BOUNDARY + WINDOW

  it('keeps the far end of this window below the tick the board kills itself on', () => {
    // 6,000 against 6,660: **660 ticks, 9.9 %** — against 703 ticks and 10.5 %
    // pre-M1f, and against the 257 ticks and 4.5 % Task 2's wide rule forced.
    // The window was restored to 1,500 rather than left at 1,000, because the
    // board lives 2,160 ticks past the boundary again (1,257 under the wide
    // rule, 2,203 pre-M1f) and a window shortened for a reason that has expired
    // is coverage nobody gets back. The boundary itself is the week boundary and
    // is not this file's to choose. The mechanical guard is the `isGameOver`
    // read in the window below, which is structural; this is the arithmetic one
    // beside it.
    expect(END).toBeLessThan(DEMO_DEATH_TICK)
    expect(DEMO_DEATH_TICK - END, 'margin, as a figure rather than an adjective').toBe(660)
    expect(BOUNDARY, 'and the boundary really is inside the window').toBeLessThan(END)
  })

  it('moves BACKLOG rather than throughput: trips flat, refusals down, pins up 13 %', () => {
    const rig = seededRig()
    rig.drive(BOUNDARY - WINDOW)
    const before = rig.driveIntoWeek(WINDOW, 1)
    expect(rig.state.header[H_TICK], 'the first window ends exactly on the boundary').toBe(BOUNDARY)
    const pinsAtBoundary = sumPins(rig)
    const overAtBoundary = destinationsOverCap(rig)
    const meterAtBoundary = peakMeter(rig)

    const after = rig.driveIntoWeek(WINDOW, 1)
    expect(rig.state.header[H_TICK]).toBe(END)
    // **Structural, and the only assertion here that cannot go stale**: the
    // whole comparison is worthless if the sim froze part-way through the
    // second window, because a frozen board reports zero of everything and
    // "refusals went down" would be the freeze talking.
    expect(isGameOver(rig.state), 'this window must measure a LIVE sim').toBe(false)

    // The premise: week 1 really does ask faster. Read from `sim` rather than
    // restated, so a ramp change moves this rather than the prose.
    expect(pinPeriodForWeek(0)).toBe(PIN_PERIOD_TICKS)
    expect(pinPeriodForWeek(1), 'week 1 asks for a pin 11 % sooner').toBeLessThan(
      pinPeriodForWeek(0),
    )

    // Throughput does not follow it, because the fleet is already saturated.
    expect(before.maxInFlight, 'every car is already out in week 0').toBe(24)
    expect(after.maxInFlight, '...and there are no more to send').toBe(24)
    expect(after.trips, 'trips are flat across the boundary, not up').toBeGreaterThan(
      before.trips - 15,
    )
    expect(after.trips).toBeLessThan(before.trips + 15)
    expect(after.refusals, 'and the road is not busier — it is slightly quieter').toBeLessThan(
      before.refusals,
    )
    // Floors, in this file's idiom, so the two windows are not both measuring
    // an idle board and agreeing about it. **Both are the pre-M1f floors and
    // neither has ever been re-fitted.** Task 2's wide rule dropped throughput
    // to 6 and 10 trips per 1,000 ticks and the trips floor was weakened to
    // `>= 5` for the duration; Task 3's rule gives 97 and 95 per 1,500, so the
    // original `> 50` is reinstated. The refusal floor of 800 has stood
    // unchanged through all three rules.
    expect(before.refusals).toBeGreaterThan(800)
    expect(after.refusals).toBeGreaterThan(800)
    expect(after.trips, 'the board delivers, and not barely — 99 pre-M1f, 10 under the wide rule').toBeGreaterThan(50)

    // The backlog is where the pressure goes, and this is the mechanism that
    // ends the run 257 ticks later.
    expect(sumPins(rig), 'the pin backlog grows across the boundary').toBeGreaterThan(pinsAtBoundary)
    // **Over-cap is unsaturated again, so "it grows" is assertable again.** Task
    // 2's wide rule put 18 of 18 over cap at both ends of the pair, where a `>`
    // is a test that can never pass; under Task 3's rule it is 1 of 18 at the
    // boundary and 3 of 18 at the far end, which is the pre-M1f 1 -> 2 shape one
    // destination wider. Both endpoints are pinned exactly, because the CHANGE
    // is the claim and an inequality alone would have been satisfied by the
    // saturated board too.
    expect(overAtBoundary, 'one of eighteen at the boundary — 18/18 under the wide rule').toBe(1)
    expect(destinationsOverCap(rig), 'and three of eighteen at the far end').toBe(3)
    expect(destinationsOverCap(rig), 'which is a growth, not a saturation').toBeGreaterThan(
      overAtBoundary,
    )
    // The meter still climbs, by 3.93x against the 4.1x it managed pre-M1f and
    // the 1.72x the wide rule left it.
    expect(peakMeter(rig)).toBeGreaterThan(meterAtBoundary * 1.5)
    expect(peakMeter(rig), 'and it is most of the way to the shutdown').toBeGreaterThan(
      OVERCROWD_FAIL_MILLITICKS / 2,
    )
    expect(peakMeter(rig), 'but has not reached it — see the isGameOver read above').toBeLessThan(
      OVERCROWD_FAIL_MILLITICKS,
    )
  })

  it('the 3,000-tick window sees NONE of this, which it did before M1f and not during it', () => {
    // **This case has now inverted TWICE, and the round trip is the finding.**
    // Pre-M1f the baseline window was the reason a new window was needed at all:
    // over 3,000 ticks the overcrowd mechanism was completely inert — not
    // "small", zero — so every figure the congestion block measures was taken
    // before §5.8 did anything.
    //
    // Task 2's wide junction rule ended that: the first destination went over
    // its cap at tick 2,278 and the first meter at 2,279, both inside the
    // baseline window, so at tick 3,000 five of eighteen destinations were over
    // cap and the meter read 174,243. Task 3's crossing-only rule ends it again
    // in the other direction: **no destination goes over cap anywhere in the
    // first 3,000 ticks and every meter reads 0**, so the congestion block's
    // figures are a clean week-0, pre-overcrowd baseline once more.
    //
    // The assertions are exact rather than inequalities because the point is
    // the CHANGE, and an inequality in either direction would have been
    // satisfied by one of the two other rules.
    const rig = seededRig()
    rig.drive(3000)
    expect(destinationsOverCap(rig), 'none of eighteen at tick 3,000 — five under the wide rule').toBe(0)
    expect(peakMeter(rig), 'and the meter has not started — 174,243 under the wide rule').toBe(0)
    expect(isGameOver(rig.state)).toBe(false)

    // The walk, kept from the inverted version, because the reading above is a
    // single sample at tick 3,000 and this is the claim about the whole window.
    // Under the wide rule it answered 2,278; the two cannot be satisfied by one
    // accident in either direction.
    const walk = seededRig()
    let firstOver = -1
    for (let t = 1; t <= 3000; t++) {
      walk.tick(NO_ACTIONS)
      if (destinationsOverCap(walk) > 0) {
        firstOver = t
        break
      }
    }
    expect(firstOver, 'nothing goes over cap inside the baseline window — 2,278 under the wide rule').toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// 5. The warm start
// ---------------------------------------------------------------------------

describe('DEMO_WARM_START_TICKS', () => {
  it('opens the board already busy rather than empty', () => {
    // The whole point of the number. A demo that boots at tick 0 shows an empty
    // board for 163 ticks and a sparse one for a thousand more; the player who
    // said "this looks like the same demo" would say it again.
    expect(DEMO_WARM_START_TICKS).toBe(1200)
    const rig = seededRig()
    rig.drive(DEMO_WARM_START_TICKS)
    let inFlight = 0
    for (let c = 0; c < rig.state.carPhase.length; c++) {
      const p = rig.state.carPhase[c] as number
      if (p === PHASE_OUTBOUND || p === PHASE_RETURNING) inFlight++
    }
    expect(inFlight, 'cars moving on the first frame').toBeGreaterThanOrEqual(15)
    expect(longestQueue(rig.state, rig.world), 'cars queued on the first frame').toBeGreaterThanOrEqual(3)
    expect(rig.state.header[H_SCORE] as number, 'trips already scored').toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 6. The erase / ghost path, which the headline claims and nothing measured
// ---------------------------------------------------------------------------

/**
 * **`demoLayout.ts`'s fourth headline is about erasing a corridor, and until
 * this section existed no test on this board ever erased anything.**
 *
 * The sentence it replaced read as a guarantee — *"every car of that colour is
 * committed to all three, so they fade and stay driveable"* — and the behaviour
 * is conditional: `settleErasedCell` ghosts a cell only if some car's committed
 * route still runs through it, and deletes it outright otherwise. At the first
 * frame a player sees, the honest answer for this exact stroke is "no ghost at
 * all". Both branches are below, on the demo board, through `step`'s own action
 * dispatch.
 *
 * The stroke is `(8, 15)..(8, 19)` on corridor A: five cells, four segments, so
 * the three in the middle lose both bits and the two ends keep one each. That
 * geometry is asserted rather than assumed — a stroke that cleared no cell's
 * last bit would make every other assertion here vacuous.
 */
const ERASE_TOP_Y = 15
const ERASE_BOTTOM_Y = 19
const ERASE_X = 8
/** The three cells the stroke takes both bits off. */
const ERASED_CELLS = [cellAt(ERASE_X, 16), cellAt(ERASE_X, 17), cellAt(ERASE_X, 18)]

/** The stroke, as the four `erase` actions a drag over five cells produces. */
const ERASE_STROKE: readonly TickAction[] = Object.freeze(
  Array.from({ length: ERASE_BOTTOM_Y - ERASE_TOP_Y }, (_unused, i) =>
    Object.freeze({
      kind: 'erase' as const,
      a: cellAt(ERASE_X, ERASE_TOP_Y + i),
      b: cellAt(ERASE_X, ERASE_TOP_Y + i + 1),
    }),
  ),
)

function ghostCells(state: GameState): number {
  let n = 0
  for (let c = 0; c < state.ghostMask.length; c++) if ((state.ghostMask[c] as number) !== 0) n++
  return n
}

function roadCells(state: GameState, world: WorldData): number {
  let n = 0
  for (let c = 0; c < world.cells; c++) if ((state.roads[c] as number) !== 0) n++
  return n
}

/**
 * The tile ledger. M1d's whole-milestone review found `tiles + roadCells +
 * ghostCells` constant across 25,000 ticks of erase/re-place, and the
 * carry-forward names it as the invariant to assert if anyone touches
 * `settleErasedCell`, `payGhostRefund` or `noteGhostDeparture`. This is the
 * first test on the demo board that can see it.
 */
function ledger(state: GameState, world: WorldData): number {
  return tilesLeft(state) + roadCells(state, world) + ghostCells(state)
}

describe('erasing three corridor cells on the demo board', () => {
  it('deletes them outright at the first frame, because nothing is committed there yet', () => {
    const rig = seededRig()
    rig.drive(DEMO_WARM_START_TICKS)
    const total = ledger(rig.state, rig.world)

    // The branch under test is "no committed car", so that is asserted first —
    // otherwise this passes as the ghost case and nobody notices.
    for (const cell of ERASED_CELLS) {
      expect(countCommittedCars(rig.state, rig.world, cell), `cell ${cell} at the first frame`).toBe(0)
    }

    const tilesBefore = tilesLeft(rig.state)
    rig.tick(ERASE_STROKE)

    // Three cells cleared, refunded on the spot, and no ghost anywhere on the
    // board — not merely none on these three.
    expect(tilesLeft(rig.state)).toBe(tilesBefore + 3)
    expect(ghostCells(rig.state)).toBe(0)
    for (const cell of ERASED_CELLS) {
      expect(roadMask(rig.state, cell), `cell ${cell} road bits`).toBe(0)
      expect(ghostMaskOf(rig.state, cell), `cell ${cell} ghost bits`).toBe(0)
    }
    // The stroke's geometry: the two END cells keep exactly one bit each, which
    // is why a three-cell drag fades one cell and not three.
    expect(roadMask(rig.state, cellAt(ERASE_X, ERASE_TOP_Y))).not.toBe(0)
    expect(roadMask(rig.state, cellAt(ERASE_X, ERASE_BOTTOM_Y))).not.toBe(0)
    expect(ledger(rig.state, rig.world)).toBe(total)
  })

  it('ghosts them a moment later, stays driveable, and pays the refund when they clear', () => {
    const rig = seededRig()
    rig.drive(DEMO_WARM_START_TICKS)
    const total = ledger(rig.state, rig.world)

    // Wait for the traffic the first case does not have. Bounded, and the bound
    // is asserted: measured at 18 ticks, and a rig that never gets there would
    // otherwise silently skip the whole test.
    let waited = 0
    while (waited < 600) {
      let committed = 0
      for (const cell of ERASED_CELLS) {
        if (countCommittedCars(rig.state, rig.world, cell) > 0) committed++
      }
      if (committed === ERASED_CELLS.length) break
      rig.drive(1)
      waited++
    }
    expect(waited, 'no tick in 600 had all three cells committed').toBeLessThan(600)

    const tilesBefore = tilesLeft(rig.state)
    // Read BEFORE the erase: the count the ghost must record is the number of
    // cars committed at that instant. Without this the only observer of
    // `ghostCommitted` is how long the drain takes, and the drain is generous
    // enough to absorb an off-by-one — a car crosses each cell TWICE, outbound
    // and again on the way home, so a count one too high still reaches zero.
    // Measured: `ghostCommitted + 1` survives every other assertion here.
    const committedAtErase = ERASED_CELLS.map((cell) =>
      countCommittedCars(rig.state, rig.world, cell),
    )
    rig.tick(ERASE_STROKE)

    // Nothing refunded, all three fading, each holding the cars it counted.
    expect(tilesLeft(rig.state), 'a deferred refund must pay nothing yet').toBe(tilesBefore)
    expect(ghostCells(rig.state)).toBe(3)
    for (let i = 0; i < ERASED_CELLS.length; i++) {
      const cell = ERASED_CELLS[i] as number
      expect(roadMask(rig.state, cell), `cell ${cell} road bits`).toBe(0)
      expect(ghostMaskOf(rig.state, cell), `cell ${cell} ghost bits`).not.toBe(0)
      expect(committedAtErase[i], `cell ${cell} had no committed car`).toBeGreaterThan(0)
      expect(ghostCommittedOf(rig.state, cell), `cell ${cell} committed count`).toBe(
        committedAtErase[i],
      )
    }
    expect(ledger(rig.state, rig.world), 'the ledger must hold across the deferral').toBe(total)

    // **Driveable, observed rather than inferred**: a car stands on one of the
    // erased cells at some tick AFTER the road bits went. Without this the test
    // would be satisfied by three cells that ghosted and were never crossed.
    let seenOnAGhost = false
    let drained = 0
    while (drained < 2000 && ghostCells(rig.state) > 0) {
      rig.drive(1)
      drained++
      for (let c = 0; c < rig.state.carPhase.length; c++) {
        const phase = rig.state.carPhase[c] as number
        if (phase !== PHASE_OUTBOUND && phase !== PHASE_RETURNING) continue
        const cell = rig.state.carCell[c] as number
        if (ERASED_CELLS.includes(cell) && ghostMaskOf(rig.state, cell) !== 0) seenOnAGhost = true
      }
    }
    expect(seenOnAGhost, 'no car ever drove on a ghost cell — it was not driveable').toBe(true)

    // The refund arrives late rather than never, and it is exactly the three
    // tiles the erase withheld. Measured: 120 ticks.
    expect(ghostCells(rig.state), 'the ghosts never drained').toBe(0)
    expect(drained).toBeGreaterThan(0)
    expect(tilesLeft(rig.state)).toBe(tilesBefore + 3)
    expect(ledger(rig.state, rig.world)).toBe(total)
  })
})

// ---------------------------------------------------------------------------
// 7. What M1e's spawn phase does to this board, measured against a control
// ---------------------------------------------------------------------------

/**
 * Every pin this board has ever created, which is the quantity the spawner can
 * move and the pin COUNT is not.
 *
 * `runArrivals` decrements `destPins` when a car reaches its destination and
 * increments `H_SCORE` when it gets home, so a standing pin total is not
 * conserved and comparing it across two runs says nothing. The conserved
 * quantity is: pins standing, plus pins dropped, plus pins already consumed —
 * and a pin is consumed at the outbound arrival, so the consumed count is
 * `H_SCORE` (round trips finished) plus the cars currently on a return leg.
 */
function pinsEverCreated(state: GameState): number {
  let n = (state.header[H_PINS_DROPPED] as number) + (state.header[H_SCORE] as number)
  for (let d = 0; d < (state.header[H_DEST_COUNT] as number); d++) n += state.destPins[d] as number
  for (let c = 0; c < state.carPhase.length; c++) {
    if ((state.carPhase[c] as number) === PHASE_RETURNING) n++
  }
  return n
}

describe('the demo board under M1e’s spawn phase', () => {
  /**
   * **This replaces the shape the plan's first draft asked for, which asserted
   * `H_HOUSE_COUNT` and `H_DEST_COUNT` on a board that is at both caps from
   * tick 0** — the only two quantities on it that cannot move. That test passes
   * while every claim around it is false, and after Task 8 it would pass
   * *because the sim is frozen*.
   *
   * The control is the same rig with the destination timer parked past the
   * window, so its spawn phase only decrements. It is not "no spawn phase at
   * all" and does not need to be: on this board the HOUSE half is a genuine
   * no-op (`H_HOUSE_COUNT >= maxHouses` short-circuits it before the scan), so
   * parking the destination timer removes the only half that does anything.
   * That is asserted rather than assumed, below.
   */
  it('adds no BUILDING, and pushes exactly the scheduled demand it could not place', () => {
    const map = demoCity()
    const live = seededRig()
    const control = seededRig()
    // The window is capped BELOW this board's death tick with the margin
    // stated: **6,660, MEASURED at M1e Task 7 as 6,703, re-measured at M1f Task
    // 2 as 5,757 and again at M1f Task 3** — see `DEMO_DEATH_TICK` — and a
    // frozen sim is byte-identical from tick to tick, so a longer window would
    // assert over a corpse. 5,000 leaves **1,660 ticks (25 %)** of margin, back
    // from the 757 (13 %) the wide rule left and level with the 1,703 (25 %) of
    // M1e. **The window is not lengthened to spend the recovered margin**: 5,000
    // ticks is what makes the spawner's push observable, and more of them would
    // only be more of the same. The `isGameOver` assertion below is the
    // mechanical guard.
    const WINDOW = 5000
    expect(WINDOW, 'and the cap is mechanical, not a comment').toBeLessThan(DEMO_DEATH_TICK)
    expect(DEMO_DEATH_TICK - WINDOW).toBe(1660)
    for (let i = 0; i < WINDOW; i++) {
      live.tick(NO_ACTIONS)
      control.state.header[H_DEST_SPAWN_TIMER] = WINDOW + 2
      control.tick(NO_ACTIONS)
    }
    expect(isGameOver(live.state), 'this window must not reach the shutdown').toBe(false)

    // **This is the ONE window in this file that leaves week 0, and M1e Task 6
    // put a demand ramp inside it.** Past tick 4,500 the pin period drops from
    // 518 to 466, so both runs below produce more pins than they did before
    // that task: measured over this window, refusals go 5,540 -> 5,595 and
    // blocked ticks 2,499 -> 2,490 with the ramp switched on. **Not one figure
    // in this test moves for it**, and the reason is structural rather than
    // lucky: every assertion here is either relational (live against control,
    // and BOTH arms are ramped identically) or derived from
    // `DEST_SPAWN_PERIOD_TICKS`, which the ramp does not touch. The
    // ramp-sensitive figures live one section up, where `drive()` asserts that
    // its own window never gets here.
    //
    // Stated as an assertion rather than as prose so that shortening this
    // window below 4,500 — which would make the paragraph above quietly wrong —
    // fails instead.
    expect(live.state.header[H_WEEK], 'this window is expected to CROSS the week boundary').toBe(1)
    expect(control.state.header[H_WEEK]).toBe(1)

    // The buildings genuinely cannot move — but this is the SECONDARY check,
    // not the test.
    expect(live.state.header[H_HOUSE_COUNT]).toBe(map.maxHouses)
    expect(live.state.header[H_DEST_COUNT]).toBe(map.maxDestinations)
    // ...and the house half really is inert, which is what makes the control a
    // control: the two runs' house timers are identical, because neither ever
    // placed anything.
    expect(Array.from(live.state.houseSpawnTimer)).toEqual(Array.from(control.state.houseSpawnTimer))

    // The primary check: exactly the scheduled pushes, and nothing else.
    // Attempts land at DEST_SPAWN_PERIOD_TICKS and every period after — the
    // SCHEDULE, not the retry, because a full board is BOARD_FULL — so the
    // count is derivable rather than observed.
    const expectedPushes = Math.floor(WINDOW / DEST_SPAWN_PERIOD_TICKS)
    expect(expectedPushes, 'vacuity: the window must contain at least two').toBeGreaterThanOrEqual(2)
    // The scheduled half of demand is identical in both runs — `pinAccum` is
    // driven by `slotCounts`, which depends only on the destinations, and those
    // cannot move here. So the whole difference below is 5.3.5's pushes and
    // nothing else, which is what makes the equality an attribution rather than
    // a coincidence.
    expect(Array.from(live.state.pinAccum)).toEqual(Array.from(control.state.pinAccum))
    expect(pinsEverCreated(live.state)).toBe(pinsEverCreated(control.state) + expectedPushes)

    // And the pushes ROTATE rather than all landing on one colour. The cursor
    // is written from the chosen colour on every attempt, so after N attempts
    // on a 3-colour board it reads `N % 3` — 2 here, which is only reachable if
    // the cursor advanced on both of the two FAILED attempts.
    expect(live.state.header[H_SPAWN_COLOUR_CURSOR]).toBe(expectedPushes % map.groupCount)
    expect(control.state.header[H_SPAWN_COLOUR_CURSOR], 'the control attempted nothing').toBe(0)

    // A pushed pin also moves `rotationCursor`, so the schedule itself is
    // perturbed and not only the count.
    expect(Array.from(live.state.rotationCursor)).not.toEqual(
      Array.from(control.state.rotationCursor),
    )

    // The digest differs, and that is the honest statement: this board is NOT
    // inert under M1e. It is unchanged in its buildings and moved by exactly
    // its own unplaceable schedule.
    expect(hashState(live.state)).not.toBe(hashState(control.state))
  })

  it('is not vacuous: the pushes are the ONLY thing the control lacks', () => {
    // The control differs from the live run in one parked header slot, so a
    // reader is entitled to ask whether the divergence above is that slot
    // rather than the pushes. Over a window BELOW the first attempt the two
    // runs must agree on everything except that slot — which is what says the
    // parking itself changes nothing else.
    const live = seededRig()
    const control = seededRig()
    const SHORT = DEST_SPAWN_PERIOD_TICKS - 1
    for (let i = 0; i < SHORT; i++) {
      live.tick(NO_ACTIONS)
      control.state.header[H_DEST_SPAWN_TIMER] = SHORT + 2
      control.tick(NO_ACTIONS)
    }
    expect(pinsEverCreated(live.state)).toBe(pinsEverCreated(control.state))
    expect(Array.from(live.state.rotationCursor)).toEqual(Array.from(control.state.rotationCursor))
    expect(live.state.header[H_SCORE]).toBe(control.state.header[H_SCORE])
    // ...and the ONE slot that does differ is the parked timer.
    control.state.header[H_DEST_SPAWN_TIMER] = live.state.header[H_DEST_SPAWN_TIMER] as number
    expect(hashState(control.state), 'the parking changed something other than its own slot').toBe(
      hashState(live.state),
    )
  })
})

// ---------------------------------------------------------------------------
// 8. The demo board is NOT SURVIVABLE, and that is why it is not the default
// ---------------------------------------------------------------------------

/**
 * **M1e Task 10's other half, and it exists because `demoLayout.ts` makes this
 * claim in prose and nothing checked it.**
 *
 * The flip back to the starting city rests on two findings: the city grows
 * under a player's hands (`startingCity.test.ts` §8's gate), and this board
 * does not. The second was asserted in the source with no artefact behind it —
 * *"six traces were driven and the best of them equals the control"* — which is
 * this project's most reliable predictor of a claim that turns out to be wrong.
 * Two of the six are reproduced here, chosen as the two a player would actually
 * try, together with the STRUCTURAL reason no trace can do better.
 *
 * The structural reason is the load-bearing half, because it holds for traces
 * nobody ran: `H_HOUSE_COUNT` is already `maxHouses` at tick 0, so
 * `attemptHouseSpawn` short-circuits before its scan; `H_DEST_COUNT` is already
 * `maxDestinations`, so every attempt is `BOARD_FULL` and §5.3.5 pushes the
 * demand into destinations that already have too much. The fleet is therefore
 * fixed at 24 cars for the whole run while the weekly ramp shortens the pin
 * period under it. **A road is the only lever a player has, and this board's
 * problem is not a missing road** — every destination is already on a corridor.
 * `demoLayout.test.ts` §7 asserts the two population halves directly.
 */
describe('no road a player can draw saves the demo board', () => {
  /**
   * Seven traces, measured here rather than asserted in prose. Rows 11, 14, 17,
   * 20 and 23 are the five rows between destination rows, so an 8-cell stroke
   * along one joins corridors A (column 8), B (13) and C (15) — the cross-link
   * a player draws when they see cars queueing on one corridor while another is
   * idle. Column 9 is a second lane beside the busiest corridor.
   *
   * **Re-measured in full at M1f Task 2 and AGAIN at M1f Task 3**, which
   * narrowed the rule from "one car at a time" to "one axis at a time". Every
   * row moved twice, so the whole table is reprinted rather than patched, and
   * all three columns are kept because the triage between the two M1f rules is
   * only legible with both:
   *
   * ```
   *                             tiles   pre-M1f      T2 (wide)    T3 (ships)
   *   trace                             dies  trips  dies  trips  dies  trips
   *   no input (the control)        0  6,703   420  5,757   105  6,660   410
   *   parallel lane, column 9      20  6,703   418  5,494    37  6,703   403
   *   cross-link row 11             5  7,221   463  7,221   437  7,696   459  <- best
   *   cross-link row 14             5  6,142   339  5,667   276  6,142   305
   *   cross-link row 17             5  7,221   426  7,178   379  7,221   392
   *   cross-link row 20             5  5,639   186  5,639   186  5,639   207  <- worst
   *   cross-link row 23             5  6,185   187  5,667   128  7,178   292
   *   all five cross-links         25  5,667   177  5,639   134  6,660   206
   * ```
   *
   * **The count of traces that are worse than doing nothing went 4 -> 5 -> 2**,
   * and the parallel lane went neutral -> harmful (-263) -> mildly helpful
   * (+43). Under the wide rule a second lane beside the busiest corridor made
   * the board die sooner, because the lane's two ends are new junctions and a
   * junction cost a wait whichever axis a car was on; under the crossing-only
   * rule those two ends cost a wait only for traffic that actually crosses, and
   * the lane pays for itself by 43 ticks. **Which is a measurement of the rule,
   * not of the board** — the geometry is identical in all three columns.
   *
   * **"More road is worse" is back, on THROUGHPUT, and it is now the only axis
   * on which it holds.** Twenty-five tiles of cross-link deliver 206 trips
   * against the control's 410 and die on exactly the same tick, 6,660 — not
   * earlier, as pre-M1f and under the wide rule, and not later. Survival is
   * indifferent to every cross-link laid at once and throughput halves.
   *
   * One row did not move under either rule — cross-link 20 (5,639, three
   * columns to the digit) — which is worth noting rather than smoothing over:
   * that trace dies before the ticks where any junction rule bites.
   *
   * **The best buys 1,036 ticks — 34.5 seconds, 15.6 %** — where pre-M1f it
   * bought 518 ticks (17 s, 7.7 %) and under the wide rule 1,464 (48.8 s,
   * 25.4 %). The ratio goes 1.077 -> 1.254 -> 1.156. Nothing survives in any
   * column. Compare the starting city on the same instrument: five tiles remove
   * its death entirely, and a player who keeps connecting reaches 21,783
   * against 5,580 — **3.90x, not 1.156x.** (Both sides of a comparison have to
   * be the same quantity; see `demoLayout.ts`, and the ratio assertions below
   * rather than prose.)
   */
  const CROSSLINK_ROWS: readonly number[] = [11, 14, 17, 20, 23]
  const crosslink = (y: number): number[] => Array.from({ length: 8 }, (_, i) => cellAt(8 + i, y))
  /** A second lane beside corridor A, column 9 from row 9 to the street. */
  const PARALLEL_A: readonly number[] = Array.from({ length: 20 }, (_, i) => cellAt(9, 9 + i))

  function pathActions(path: readonly number[]): TickAction[] {
    const out: TickAction[] = []
    for (let i = 0; i + 1 < path.length; i++) {
      out.push({ kind: 'place', a: path[i] as number, b: path[i + 1] as number })
    }
    return out
  }

  /** Drives to the shutdown with every stroke laid on tick 1. */
  function driveTrace(strokes: readonly (readonly number[])[]): { death: number; trips: number } {
    const rig = seededRig()
    const actions: TickAction[] = []
    for (const stroke of strokes) actions.push(...pathActions(stroke))
    for (let t = 1; t <= DEMO_DEATH_TICK + 4000; t++) {
      rig.tick(t === 1 ? actions : NO_ACTIONS)
      if (isGameOver(rig.state)) break
    }
    return {
      death: isGameOver(rig.state) ? (rig.state.header[H_TICK] as number) : -1,
      trips: rig.state.header[H_SCORE] as number,
    }
  }

  it('no trace survives, and the best of seven buys a quarter of the run', () => {
    // **The artefact for `demoLayout.ts`'s "it is not survivable", and it
    // exists because that sentence shipped without one.** Its first form said
    // "six traces, and the best of them equals the control" — which the row-11
    // cross-link below refutes: that trace beats the control by 518 ticks. The
    // conclusion survives and the sentence did not, which is the whole reason a
    // prose claim needs a test under it.
    const control = driveTrace([])
    expect(control.death, 'the control must reproduce the recorded death tick').toBe(DEMO_DEATH_TICK)
    // The floor's job is only to say the control drove a LIVE board rather than
    // a frozen one. It was 300 pre-M1f (420 trips), re-derived to 60 when the
    // wide rule dropped the control to 105, and is left at 60 under Task 3's
    // 410 — **loosened once and not tightened back**, because a floor that
    // tracks the measurement is a floor that catches nothing, and what this line
    // exists to catch is a control that scores 0.
    expect(control.trips, 'and it must be a live board, not a frozen one').toBeGreaterThan(60)
    expect(control.trips, 'T3 crossing-only: 410 (420 pre-M1f, 105 wide)').toBe(410)

    // A second lane beside the busiest corridor — the obvious move on a board
    // whose visible symptom is cars queueing in corridor A. **Twenty tiles, and
    // it does not move the death tick by one.** The killer is D2 at the top of
    // corridor C, which this road does not touch, and there is no car to put in
    // the new lane: the fleet is fixed at 24.
    // **This row has now been all three things and the assertion has followed
    // it each time, which is why it is written as an exact signed figure rather
    // than as a direction.** Pre-M1f a parallel lane bought exactly zero ticks;
    // under Task 2's wide rule it COST 263, because the new lane's two ends are
    // new junctions on the corridor it was meant to relieve and a junction cost
    // a wait on every axis; under Task 3's crossing-only rule it BUYS 43,
    // because those two ends now only cost a wait to traffic that crosses. The
    // killer is D2 at the top of corridor C in all three, which this road does
    // not touch, and there is still no car to put in the new lane: the fleet is
    // fixed at 24. Twenty tiles for 1.4 seconds.
    const parallel = driveTrace([PARALLEL_A])
    expect(
      parallel.death - control.death,
      'a parallel corridor buys 43 ticks — 0 pre-M1f, -263 under the wide rule',
    ).toBe(43)
    expect(parallel.trips, 'and costs trips even so').toBeLessThan(control.trips)

    // The five cross-links, one at a time.
    const deaths = CROSSLINK_ROWS.map((y) => driveTrace([crosslink(y)]))
    for (const r of deaths) expect(r.death, 'every trace still dies').toBeGreaterThan(0)
    const best = Math.max(...deaths.map((r) => r.death))
    const worst = Math.min(...deaths.map((r) => r.death))
    // **The best one helps, and by an amount that makes the point.** Pre-M1f
    // that was 518 ticks — 17 seconds on a 223-second run; under Task 2's wide
    // rule 1,464 ticks (48.8 s); under Task 3's 1,036 ticks (34.5 s). What the
    // bound is FOR is "a road does not save this board", and the way to say that
    // without pinning a tick is as a FRACTION of the run: the best trace must
    // not buy more than a third of it. Measured 7.7 %, 25.4 % and 15.6 % across
    // the three rules, so **one bound has held through both rule changes**,
    // which a tick count could not.
    expect(best, 'the best trace must beat the control, or this is measuring nothing').toBeGreaterThan(
      control.death,
    )
    expect(
      (best - control.death) / control.death,
      'and buy less than a third of the run — 7.7 % pre-M1f, 25.4 % wide, 15.6 % shipped',
    ).toBeLessThan(1 / 3)
    // **And some of them hurt.** Two of the five single strokes die sooner than
    // doing nothing — rows 14 and 20 — which is the thing that separates this
    // board from the starting city: there, road is the lever; here it is noise.
    // **The count is 2 under the shipped rule where it was 3 pre-M1f and 4 under
    // the wide one, so the floor moves with it rather than being left where a
    // stronger measurement put it.** Row 23 is the one that changed sides:
    // 6,185 -> 5,667 -> 7,178.
    expect(worst, 'some cross-links are worse than no road at all').toBeLessThan(control.death)
    expect(
      deaths.filter((r) => r.death < control.death).length,
      'two of the five single strokes are worse than the control — 3 pre-M1f, 4 wide',
    ).toBe(2)

    // **More road is worse for THROUGHPUT and, under the shipped rule,
    // INDIFFERENT for survival — and the second half is the one that moved.**
    // All five cross-links together dies at 6,660: not before doing nothing, as
    // it did pre-M1f (5,667 against 6,703) and under the wide rule (5,639
    // against 5,757), but on **exactly the control's tick**, to the digit.
    // Twenty-five tiles buy nothing at all on the axis that ends the run.
    //
    // Throughput is where the cost shows: 206 trips against the control's 410,
    // which is the pre-M1f shape (177 against 420) after a detour through the
    // wide rule, where the sign briefly flipped (134 against 105). What kills
    // the board in every column is D2 starving at the top of corridor C, and a
    // cross-link cannot feed it.
    //
    // The equality is pinned exactly rather than written as `<=`: an inequality
    // here would be satisfied by both of the other two rules and would say
    // nothing about the one that ships.
    const all = driveTrace(CROSSLINK_ROWS.map((y) => crosslink(y)))
    expect(all.death, 'five cross-links are worse than one').toBeLessThan(best)
    expect(
      all.death,
      'and buy nothing against none — they died 1,036 and 118 ticks early under the other two rules',
    ).toBe(control.death)
    expect(
      all.trips,
      'while throughput halves — 206 against 410 (177/420 pre-M1f, 134/105 wide)',
    ).toBeLessThan(control.trips)

    // The comparison that decided the flip, in one line: the starting city's
    // greedy arm reaches 31,456 (`startingCity.test.ts` §8) against this
    // board's ceiling here.
    expect(best, "the demo board's ceiling is below the starting city's OPENING alone").toBeLessThan(
      8661,
    )

    // **Both sides of the headline comparison, as RATIOS, so the units cannot
    // drift apart again — M1e's closing sweep.** The comment above quoted 5.64x
    // for the city and 1.077x for this board; the first of those read 4.6x for
    // three commits, which is the same measurement expressed as an excess.
    expect(best / control.death, "this board's own best trace, as a ratio").toBeCloseTo(1.156, 3)
    // **Both terms re-measured at M1f Task 2 and again at Task 3.** The city's
    // greedy arm no longer reaches 31,456 — the wide rule ended it at 21,704 and
    // the crossing-only rule at 21,783 — while `CITY_DEATH_TICK` is unmoved at
    // 5,580 (derived; see `deathTicks.ts`). So the ratio goes 5.637 -> 3.890 ->
    // 3.904, and the comparison it exists to make survives with room to spare:
    // keeping up still buys the city 3.9x its no-input life, where the demo
    // board's best trace buys 1.16x.
    expect(21783 / CITY_DEATH_TICK, "and the starting city's greedy arm").toBeCloseTo(3.904, 3)
  })

  it('the spawner cannot add anything here, which is why no trace can help', () => {
    // The structural half, and the reason the seven traces above generalise to
    // traces nobody ran. Both counts are AT their caps before the first tick,
    // so `runSpawn` has nothing to place however the board is played — the
    // fleet is 24 cars for the whole run against a weekly ramp that is not.
    const map = demoCity()
    const rig = seededRig()
    expect(rig.state.header[H_HOUSE_COUNT], 'houses are at cap at tick 0').toBe(map.maxHouses)
    expect(rig.state.header[H_DEST_COUNT], 'destinations too').toBe(map.maxDestinations)
    expect(rig.state.carPhase.length).toBe(24)
    for (let t = 0; t < 4000; t++) rig.tick(NO_ACTIONS)
    expect(rig.state.header[H_HOUSE_COUNT]).toBe(map.maxHouses)
    expect(rig.state.header[H_DEST_COUNT]).toBe(map.maxDestinations)
    expect(rig.state.carPhase.length).toBe(24)
  })
})

