import { describe, it, expect } from 'vitest'
import {
  demoCity,
  firstCity,
  CARS_PER_HOUSE,
  MAX_BLOCKED_TICKS,
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
  H_HOUSE_COUNT,
  H_SCORE,
  type GameState,
  type TickAction,
  type WorldData,
} from '@laneways/sim'
import { hashBytes } from '@laneways/sim'
// See the note on the same import in `startingCity.test.ts`: one shared M1e
// re-bless proof rather than a second copy of the splice.
import { m1eInsertedRanges, spliceM1eInsertions } from '../../sim/test/m1eSplice'
import {
  DEMO_DESTINATIONS,
  DEMO_HOUSES,
  DEMO_ROADS,
  DEMO_RUN_SEED,
  DEMO_WARM_START_TICKS,
  seedDemoLayout,
} from '../src/demoLayout'
import { seedStartingCity } from '../src/startingCity'
import { NO_CROSSING, carAheadOf, longestQueue, travelDir } from '../src/queueProbe'

/**
 * The demo layout — **the board a plain load opens**, and `?startapp=demo`
 * still names explicitly. It shipped behind the link first and became
 * `DEFAULT_LAYOUT_ID` once it was clear there was no reason for the default to
 * stay on a board that never moves a car; `layouts.test.ts` owns that choice
 * and nothing in this file depends on it.
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
  drive(ticks: number): Measured
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
      return out
    },
  }
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
    expect([m1e.aStart, m1e.aEnd, m1e.bStart, m1e.bEnd]).toEqual([52, 68, 668, 824])
    const spliced = spliceM1eInsertions(state, demoCity())
    expect(spliced.length, "the splice must land on M1d's buffer size").toBe(9720)
    expect(m1e.totalBytes).toBe(9892)
    expect(hashBytes(spliced), 'the splice must reproduce the pre-M1e digest').toBe(1039862014)
    expect(hashState(state)).toBe(3152640907)
  })

  it('differs from an unseeded demoCity — otherwise the golden pins nothing', () => {
    const map = demoCity()
    expect(hashState(rigFor(seedDemoLayout).state)).not.toBe(
      hashState(createState(DEMO_RUN_SEED, map)),
    )
  })

  it('leaves the shipped seed golden 968680755 exactly where it was', () => {
    // In the SAME file and the same run as the demo golden, deliberately: the
    // one thing a demo-board change must not do is move the CITY's number.
    // `startingCity.test.ts:237` fixes the seed this golden was blessed under;
    // it is 'm2-starting-city', NOT `RUN_SEED`, and the RNG state is inside the
    // hashed buffer, so the wrong seed here reads as a moved golden.
    //
    // Re-blessed in M1e Task 1 (was 1178110182) for the same pure-layout reason
    // as its owner in `startingCity.test.ts`. Deliberately NOT given a splice
    // proof of its own: this is a duplicate of that golden, and the proof lives
    // once, beside the assertion that owns the number.
    const map = firstCity()
    const world = createWorld(map)
    const state = createState('m2-starting-city', map)
    seedStartingCity(state, world)
    expect(hashState(state)).toBe(968680755)
  })
})

// ---------------------------------------------------------------------------
// 4. The observability claim, measured
// ---------------------------------------------------------------------------

describe('the demo layout is visibly congested, measured over 3,000 ticks', () => {
  const TICKS = 3000

  it('queues continuously: thousands of refusals, over half of all ticks blocked', () => {
    const measured = seededRig().drive(TICKS)
    // The shipped city scores 0 on every one of these — see the contrast test
    // below. The thresholds sit at roughly half the measured figures so that
    // ordinary drift does not fail them and a collapse back to the shipped city
    // does.
    //
    // **Measured on this rig, this window and this seed: 3,125 refusals, 1,350
    // blocked ticks, longest queue 7, 171 trips.** The three figures this
    // comment used to quote — 3,483 / 1,563 / 8 — are none of them reproducible
    // from it, and only the last is explained by the queue probe having been
    // lane-blind (it reads 7 here under either probe; the figure that moved is
    // the 20,000-tick one, 10 -> 8). The other two cannot have come from this
    // fixture at all: `refusals` and `blockedTicks` are read off
    // `carBlockedTicks`, which no probe touches. Re-measured rather than
    // re-derived, and quoted with the window they were taken over.
    expect(measured.refusals).toBeGreaterThan(1500)
    expect(measured.blockedTicks).toBeGreaterThan(750)
    expect(measured.longestQueue).toBeGreaterThanOrEqual(4)
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
    // shared trunk with the same 24 cars delivered 47 trips in 20,000 ticks and
    // fired the anti-deadlock valve 214 times: total gridlock, which
    // demonstrates the OPPOSITE of Decision 6's "a gridlocked city grinds
    // rather than stops" and reads to a player as a bug. Three separate
    // corridors deliver ~200 trips in 3,000.
    const measured = seededRig().drive(TICKS)
    expect(measured.trips).toBeGreaterThan(120)
    // And the valve — which is what a car driving THROUGH another looks like —
    // never fires. Measured 0 over 20,000 ticks. This is an upper bound, not a
    // feature request: if it starts firing, the layout has tipped into the
    // gridlock the trips assertion above is guarding.
    expect(measured.valves).toBe(0)
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
