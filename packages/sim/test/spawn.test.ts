import { describe, it, expect } from 'vitest'
import {
  DEST_SPAWN_PERIOD_TICKS,
  DEST_SPAWN_RETRY_TICKS,
  FIRST_PIN_DELAY_TICKS,
  HOUSES_PER_DESTINATION,
  HOUSE_SPAWN_PERIOD_TICKS,
  HOUSE_SPAWN_RETRY_TICKS,
  REVEALED_X0,
  REVEALED_Y0,
  REVEALED_W,
  REVEALED_H,
  SPAWN_CANDIDATE_LIMIT,
  firstCity,
  parseMap,
  type MapData,
} from '@laneways/shared'
import {
  createState,
  hashState,
  restore,
  snapshot,
  H_DEST_COUNT,
  H_DEST_SPAWN_TIMER,
  H_HOUSE_COUNT,
  H_PINS_DROPPED,
  H_SPAWN_COLOUR_CURSOR,
  H_TICK,
  H_WEEK,
  type GameState,
} from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFieldInputRanges } from '../src/regions'
import {
  createFlowFields,
  createScratch,
  CT_BLOCKED_PUSH_DISCARDED,
  CT_REBUILDS,
  type FlowField,
  type Scratch,
} from '../src/scratch'
import { step, type TickAction, type TickInputs } from '../src/step'
import {
  DEST_KIND_SQUARE,
  ORIENTATION_COUNT,
  ORIENTATION_E,
  ORIENTATION_N,
  ORIENTATION_S,
  ORIENTATION_W,
  carparkCell,
  destMetaColour,
  placeDestination,
  placeHouse,
} from '../src/buildings'
import { hasEligibleDestinationOfColour, pushBlockedSpawnDemand } from '../src/demand'
import {
  SpawnOutcome,
  attemptDestinationSpawn,
  attemptHouseSpawn,
  colourUnlocked,
  destCountOfColour,
  destinationFitsSpawnZone,
  houseCountOfColour,
  runSpawn,
  spawnZoneW,
  spawnZoneH,
  spawnZoneCells,
  spawnZoneCellAt,
  inSpawnZone,
  spawnScanStart,
} from '../src/spawn'

const NO_INPUT: TickInputs = { actions: [] }

/**
 * All-land rows, built at call time — a test file, so the module-scope typed
 * array rule (`eslint.config.js` binds it to `sim/src` and `shared/src`) does
 * not apply here.
 */
function allLandRows(w: number, h: number): string[] {
  const row = '.'.repeat(w)
  return Array.from({ length: h }, () => row)
}

function testMap(w: number, h: number, maxHouses = 40, maxDestinations = 16, groupCount = 5): MapData {
  return parseMap(`spawn-${w}x${h}`, allLandRows(w, h), 200, maxHouses, maxDestinations, groupCount)
}

interface Rig {
  readonly map: MapData
  readonly world: WorldData
  readonly state: GameState
  readonly scratch: Scratch
  readonly fields: FlowField[]
}

/** A rig on the real `firstCity`, so the zone is the full 14 x 22 and the terrain is real. */
function rig(seed: string, map: MapData = firstCity()): Rig {
  const world = createWorld(map)
  return {
    map,
    world,
    state: createState(seed, map),
    scratch: createScratch(
      world.cells,
      map.groupCount,
      map.maxDestinations,
      createFieldInputRanges(map),
    ),
    fields: createFlowFields(map.groupCount, world.cells),
  }
}

const cellIn = (world: WorldData, x: number, y: number): number => y * world.w + x

/**
 * `firstCity` with M2's hand-authored seed placed by hand rather than through
 * `game/startingCity.ts` — `sim` may not import `game`. The three destinations
 * and three houses are the same six placements, in the same order, so the
 * colour-1 pair this file's unlock table names really is on the board.
 */
function seededCityState(seed = 'spawn-city'): Rig {
  const r = rig(seed)
  const w = r.world
  expect(placeDestination(r.state, w, cellIn(w, 9, 10), ORIENTATION_W, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeDestination(r.state, w, cellIn(w, 9, 18), ORIENTATION_W, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeDestination(r.state, w, cellIn(w, 14, 14), ORIENTATION_E, 1, DEST_KIND_SQUARE)).toBe(true)
  expect(placeHouse(r.state, w, cellIn(w, 8, 24), 0)).toBe(true)
  expect(placeHouse(r.state, w, cellIn(w, 8, 13), 0)).toBe(true)
  expect(placeHouse(r.state, w, cellIn(w, 17, 18), 1)).toBe(true)
  return r
}

/** Total pins standing on the board, plus the ones that were dropped. */
function pinsCreated(state: GameState): number {
  let n = state.header[H_PINS_DROPPED] as number
  for (let d = 0; d < (state.header[H_DEST_COUNT] as number); d++) n += state.destPins[d] as number
  return n
}

describe('the spawn zone is the revealed rect, clipped to the board', () => {
  it('clips the revealed rect to the board, and answers zero cells when they do not intersect', () => {
    // `determinism.test.ts` runs on a 4x4 map and the rect starts at x = 5, so
    // an unclipped zone would index cells that do not exist. An unguarded
    // `% 0` in the scan start yields NaN, and a NaN index into a typed array
    // is a SILENT no-op — the quietest failure available.
    const tiny = createWorld(testMap(4, 4))
    expect(spawnZoneW(tiny.w)).toBe(0)
    expect(spawnZoneH(tiny.h)).toBe(0)
    expect(spawnZoneCells(tiny)).toBe(0)

    // 20x9 is Task 6's demand-golden shape and it must clip to nothing on the
    // Y axis alone, with a non-zero width — the two bounds are separate code
    // and a fixture that zeroes both cannot tell them apart.
    const flat = createWorld(testMap(20, 9))
    expect(spawnZoneW(flat.w)).toBe(REVEALED_W)
    expect(spawnZoneH(flat.h)).toBe(0)
    expect(spawnZoneCells(flat)).toBe(0)

    const loopish = createWorld(testMap(20, 12))
    expect(spawnZoneW(loopish.w)).toBe(REVEALED_W) // 5 + 14 = 19 <= 20
    expect(spawnZoneH(loopish.h)).toBe(3) // 9 + 22 = 31 clipped to 12
    expect(spawnZoneCells(loopish)).toBe(REVEALED_W * 3)

    const full = createWorld(firstCity())
    expect(spawnZoneCells(full)).toBe(REVEALED_W * REVEALED_H)
  })

  it('maps every zone index to a distinct in-zone cell and back', () => {
    const world = createWorld(firstCity())
    const seen = new Set<number>()
    for (let i = 0; i < spawnZoneCells(world); i++) {
      const cell = spawnZoneCellAt(i, world)
      expect(inSpawnZone(cell, world), `zone index ${i} -> cell ${cell}`).toBe(true)
      seen.add(cell)
    }
    expect(seen.size).toBe(spawnZoneCells(world))
    // The far corner is load-bearing: a fixture whose content sits in the
    // top-left corner cannot see a shrunk end bound.
    expect(
      seen.has((REVEALED_Y0 + REVEALED_H - 1) * world.w + REVEALED_X0 + REVEALED_W - 1),
    ).toBe(true)
    expect(inSpawnZone(0, world), 'cell 0 is outside the rect').toBe(false)
  })

  it('varies the scan start by seed and by tick, and consumes no RNG draw', () => {
    const a: GameState = createState('seed-a', firstCity())
    const b: GameState = createState('seed-b', firstCity())
    const world = createWorld(firstCity())
    const cells = spawnZoneCells(world)
    expect(spawnScanStart(a, cells)).not.toBe(spawnScanStart(b, cells))
    const before = a.rng[0] as number
    a.header[H_TICK] = 1
    const first = spawnScanStart(a, cells)
    a.header[H_TICK] = 2
    expect(spawnScanStart(a, cells)).not.toBe(first)
    expect(a.rng[0], 'the scan start must not advance the RNG').toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 2. Colour eligibility, and the founding exemption
// ---------------------------------------------------------------------------

describe('which colours may receive buildings', () => {
  it('unlocks a colour at its week OR the moment the map has already seeded it', () => {
    // **The first draft's RED and GREEN contradicted each other here.** Its
    // table asserted `colourUnlocked(1, 0) === true` "because firstCity seeds
    // colours 0 and 1", and its implementation was `return week >= colour`,
    // which is `0 >= 1` = false. The seeder and the rule disagreed about when
    // a colour exists, and the one-character repair (`week + 1 >= colour`)
    // unlocks colours 2, 3 and 4 a WEEK EARLY and shifts every measurement in
    // Task 10 with nothing to catch it.
    //
    // The rule adopted instead is "already on the board OR the week has come",
    // which is what `firstCity`'s seeded colour-1 pair implies and which is
    // robust to any future map's seed rather than to this one's.
    const empty = createState('unlock-empty', testMap(4, 4)) // no seeded buildings
    expect(colourUnlocked(empty, 0, 0)).toBe(true)
    expect(colourUnlocked(empty, 1, 0), 'nothing seeded, week 0: not yet').toBe(false)
    expect(colourUnlocked(empty, 1, 1)).toBe(true)
    expect(colourUnlocked(empty, 2, 1)).toBe(false)
    expect(colourUnlocked(empty, 2, 2)).toBe(true)
    expect(colourUnlocked(empty, 4, 4)).toBe(true)

    // The seeded clause, on the real board and named by colour and week — this
    // is the assertion the mutation table targets specifically.
    const city = seededCityState().state
    expect(colourUnlocked(city, 1, 0), 'firstCity seeds a colour-1 pair at week 0').toBe(true)
    expect(colourUnlocked(city, 2, 0), 'colour 2 is not seeded and week 0 has not reached it').toBe(false)
  })

  it('counts houses and destinations per colour off the live prefixes', () => {
    // The two counters the unlock rule and the cap both read. Asserted directly
    // because every rule below is stated in terms of them, and because the
    // seeded clause has TWO arms — a house or a destination — and a fixture
    // where both are present for the same colour cannot separate them.
    const r = seededCityState()
    expect(houseCountOfColour(r.state, 0)).toBe(2)
    expect(destCountOfColour(r.state, 0)).toBe(2)
    expect(houseCountOfColour(r.state, 1)).toBe(1)
    expect(destCountOfColour(r.state, 1)).toBe(1)
    expect(houseCountOfColour(r.state, 4)).toBe(0)
    expect(destCountOfColour(r.state, 4)).toBe(0)

    // Each arm of the seeded clause ALONE, on boards that hold one and not the
    // other — the compound fixture above cannot tell them apart.
    const houseOnly = rig('unlock-house-only')
    expect(placeHouse(houseOnly.state, houseOnly.world, cellIn(houseOnly.world, 8, 13), 3)).toBe(true)
    expect(colourUnlocked(houseOnly.state, 3, 0), 'a house alone unlocks').toBe(true)
    const destOnly = rig('unlock-dest-only')
    expect(
      placeDestination(destOnly.state, destOnly.world, cellIn(destOnly.world, 9, 10), ORIENTATION_W, 3, DEST_KIND_SQUARE),
    ).toBe(true)
    expect(colourUnlocked(destOnly.state, 3, 0), 'a destination alone unlocks').toBe(true)
  })

  it('founds a colour with no destination, and then caps it at two houses per destination', () => {
    // The deadlock this exemption exists to break: the cap refuses a colour
    // with zero destinations, and a destination refuses a colour with zero
    // houses. Without the founding exemption colours 2, 3 and 4 of `firstCity`
    // never appear at all, silently, for the whole run.
    const r = rig('found')
    const c = 2
    r.state.header[H_WEEK] = 2
    expect(houseCountOfColour(r.state, c)).toBe(0)
    expect(destCountOfColour(r.state, c)).toBe(0)
    expect(attemptHouseSpawn(r.state, r.world, c), 'the FIRST house is exempt').toBe(true)
    expect(houseCountOfColour(r.state, c)).toBe(1)
    expect(attemptHouseSpawn(r.state, r.world, c), 'the second is not, with no destination').toBe(false)
  })

  it('lets the cap open again once the colour gains a destination, at exactly two per', () => {
    // The other side of the same rule, and the reason `HOUSES_PER_DESTINATION`
    // is a constant rather than a `> 0` test: the cap must BIND at 2 and RELEASE
    // at 3, and a fixture that only ever shows it binding cannot see the
    // difference between 2 and any larger number.
    const r = rig('cap')
    const c = 2
    r.state.header[H_WEEK] = 2
    // The founding house is placed DIRECTLY rather than through the spawner, so
    // its neighbourhood is a known 5x5 of clear land and the negative arm below
    // cannot be satisfied by "the bounded window happened to miss".
    // (6..10, 18..22) on `firstCity` holds no tree, no river cell and no
    // building; the founding exemption itself has its own test above.
    expect(placeHouse(r.state, r.world, cellIn(r.world, 8, 20), c)).toBe(true)
    expect(
      placeDestination(r.state, r.world, cellIn(r.world, 14, 26), ORIENTATION_E, c, DEST_KIND_SQUARE),
    ).toBe(true)
    expect(destCountOfColour(r.state, c)).toBe(1)
    expect(houseCountOfColour(r.state, c)).toBe(1)
    // One destination allows HOUSES_PER_DESTINATION houses, so the second is
    // permitted and the third is not. The scan is bounded, so a refusal could
    // also be "the window missed"; the loop retries across enough ticks that
    // the 24-cell window has walked the whole 308-cell zone twice over.
    let placed = false
    for (let t = 1; t <= 700 && !placed; t++) {
      r.state.header[H_TICK] = t
      placed = attemptHouseSpawn(r.state, r.world, c)
    }
    expect(placed, 'the second house was never placed in 700 windows').toBe(true)
    expect(houseCountOfColour(r.state, c)).toBe(HOUSES_PER_DESTINATION)
    for (let t = 701; t <= 1400; t++) {
      r.state.header[H_TICK] = t
      expect(attemptHouseSpawn(r.state, r.world, c), `tick ${t}: the cap did not bind`).toBe(false)
    }
    expect(houseCountOfColour(r.state, c)).toBe(HOUSES_PER_DESTINATION)
    // ...and the cap RELEASES when a second destination arrives, which is what
    // makes it two-per rather than a bare "more than none" test.
    expect(
      placeDestination(r.state, r.world, cellIn(r.world, 5, 11), ORIENTATION_E, c, DEST_KIND_SQUARE),
    ).toBe(true)
    let third = false
    for (let t = 1401; t <= 2100 && !third; t++) {
      r.state.header[H_TICK] = t
      third = attemptHouseSpawn(r.state, r.world, c)
    }
    expect(third, 'a second destination did not raise the cap').toBe(true)
    expect(houseCountOfColour(r.state, c)).toBe(3)
  })

  it('keeps every spawned house within two tiles of a same-colour one', () => {
    // §5.9's neighbourhood rule, and the exemption's other half: only the FIRST
    // house of a colour may go anywhere. Driven over 400 windows so the bounded
    // scan has visited most of the zone, which is what makes "every one of them"
    // mean something.
    const r = rig('radius')
    r.state.header[H_WEEK] = 4
    const colour = 3
    // Three well-spaced destinations, each asserted, so the cap is 6 and cannot
    // be what stops the third and later houses. Hand-picked clear of
    // `firstCity`'s trees and of its column-12 river.
    for (const y of [11, 16, 22]) {
      expect(
        placeDestination(r.state, r.world, cellIn(r.world, 5, y), ORIENTATION_E, colour, DEST_KIND_SQUARE),
        `destination at (5, ${y})`,
      ).toBe(true)
    }
    expect(destCountOfColour(r.state, colour)).toBe(3)
    for (let t = 1; t <= 1400; t++) {
      r.state.header[H_TICK] = t
      attemptHouseSpawn(r.state, r.world, colour)
    }
    const cells: number[] = []
    for (let h = 0; h < (r.state.header[H_HOUSE_COUNT] as number); h++) {
      if ((r.state.houseColour[h] as number) === colour) cells.push(r.state.houseCell[h] as number)
    }
    expect(cells.length, 'no house spawned at all — the rule below is vacuous').toBeGreaterThan(2)
    for (let i = 1; i < cells.length; i++) {
      const x = (cells[i] as number) % r.world.w
      const y = ((cells[i] as number) / r.world.w) | 0
      let nearest = Infinity
      for (let j = 0; j < i; j++) {
        const ox = (cells[j] as number) % r.world.w
        const oy = ((cells[j] as number) / r.world.w) | 0
        const cheb = Math.max(Math.abs(ox - x), Math.abs(oy - y))
        if (cheb < nearest) nearest = cheb
      }
      expect(nearest, `house ${i} at (${x}, ${y}) is ${nearest} from every earlier one`).toBeLessThanOrEqual(2)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. The zone fit, including the row seam
// ---------------------------------------------------------------------------

describe('destinationFitsSpawnZone', () => {
  it('the row-seam guard the brief specified is UNREACHABLE, and here is the sweep that says so', () => {
    // **This test records a NEGATIVE result and it is deliberately not deleted.**
    // The task brief required a `x1 >= world.w || y1 >= world.h` guard in front
    // of the far-corner check, and a fixture on which the naive composed index
    // `y1 * world.w + x1` wraps into an IN-ZONE cell on the next row. No such
    // fixture exists while `REVEALED_X0` is 5: `x1 <= x0 + 2` and `x0 < w`, so a
    // wrapped `x1 - w` is 0 or 1, always below 5, and `inSpawnZone` refuses it
    // for the ordinary reason. The guard therefore cannot be distinguished from
    // its own deletion by any input.
    //
    // `spawn.ts` responded by composing no index at all rather than keeping an
    // unpinnable guard. This is the sweep that licenses that: the two forms
    // agree on every board shape, zone cell and footprint shape below, so the
    // change is a refactor and the wrap is unconstructible rather than merely
    // unobserved. It is also the tripwire for the change that would make it
    // reachable — drop `REVEALED_X0` to 1 and this test's own `disagree` count
    // becomes non-zero, which is the moment `destinationFitsSpawnZone`'s
    // coordinate form starts earning its keep.
    let checked = 0
    let disagree = 0
    for (let w = 6; w <= 26; w++) {
      for (let h = 10; h <= 34; h += 3) {
        const world = createWorld(testMap(w, h))
        for (let zi = 0; zi < spawnZoneCells(world); zi++) {
          const cell = spawnZoneCellAt(zi, world)
          const x0 = cell % w
          const y0 = (cell / w) | 0
          for (let o = 0; o < ORIENTATION_COUNT; o++) {
            const fw = o === ORIENTATION_E || o === ORIENTATION_W ? 3 : 2
            const fh = o === ORIENTATION_E || o === ORIENTATION_W ? 2 : 3
            const x1 = x0 + fw - 1
            const y1 = y0 + fh - 1
            const naive = inSpawnZone(y1 * w + x1, world)
            const coord =
              x1 >= REVEALED_X0 &&
              x1 < REVEALED_X0 + spawnZoneW(w) &&
              y1 >= REVEALED_Y0 &&
              y1 < REVEALED_Y0 + spawnZoneH(h)
            checked++
            if (naive !== coord) disagree++
          }
        }
      }
    }
    expect(checked, 'the sweep must actually sweep something').toBeGreaterThan(20000)
    expect(disagree, 'the composed and coordinate forms must agree on every reachable case').toBe(0)
    // The property that MAKES them agree, stated separately so a reader does not
    // have to rediscover the arithmetic: the clipped zone is a subset of the
    // board on both axes, on every shape above.
    for (let w = 6; w <= 26; w++) {
      expect(REVEALED_X0 + spawnZoneW(w), `zone right edge on w=${w}`).toBeLessThanOrEqual(w)
    }
    for (let h = 10; h <= 34; h++) {
      expect(REVEALED_Y0 + spawnZoneH(h), `zone bottom edge on h=${h}`).toBeLessThanOrEqual(h)
    }
    // ...and the overhang a footprint can add is 2, strictly below `REVEALED_X0`,
    // which is the inequality the whole unreachability argument turns on.
    expect(2, 'a footprint overhangs its origin by at most 2').toBeLessThan(REVEALED_X0)
  })

  it('refuses a footprint that is on the board but sticks out of the zone, in each direction', () => {
    // The ordinary half of the same rule, on `firstCity`, where the zone is a
    // strict sub-rect of the board so a candidate can be legal board state and
    // still half-invisible. One case per bound so a single widened comparison
    // cannot be hidden by a corner.
    const world = createWorld(firstCity())
    // Right edge: the zone ends at x = 18 inclusive, so a 3-wide E footprint
    // at x = 17 reaches x = 19 — on the board, outside the zone.
    expect(destinationFitsSpawnZone(cellIn(world, 17, 12), ORIENTATION_E, world)).toBe(false)
    // Bottom edge: the zone ends at y = 30 inclusive; a 3-tall N footprint at
    // y = 29 reaches y = 31.
    expect(destinationFitsSpawnZone(cellIn(world, 8, 29), ORIENTATION_N, world)).toBe(false)
    // Left edge: the zone starts at x = 5 and a W carpark sits at x0 - 1.
    expect(destinationFitsSpawnZone(cellIn(world, 5, 12), ORIENTATION_W, world)).toBe(false)
    // Top edge: the zone starts at y = 9 and an N carpark sits at y0 - 1.
    expect(destinationFitsSpawnZone(cellIn(world, 8, 9), ORIENTATION_N, world)).toBe(false)
    // ...and one that fits, so the four refusals above are not vacuous.
    expect(destinationFitsSpawnZone(cellIn(world, 8, 12), ORIENTATION_E, world)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Where phase 4 sits in the tick, and what a spawn costs
// ---------------------------------------------------------------------------

/**
 * Arms the destination timer so the NEXT `step` runs an attempt: `runSpawn`
 * attempts when `timer - 1 <= 0`, so 1 is the value that fires on the next tick
 * and 2 is the value that does not.
 */
function armDestinationTimerForNextTick(state: GameState): void {
  state.header[H_DEST_SPAWN_TIMER] = 1
}

function armHouseTimerForNextTick(state: GameState, colour: number): void {
  state.houseSpawnTimer[colour] = 1
}

/** Parks every spawn timer past `ticks`, so a control run's spawn phase only decrements. */
function parkSpawnTimers(state: GameState, ticks: number): void {
  state.header[H_DEST_SPAWN_TIMER] = ticks + 2
  state.houseSpawnTimer.fill(ticks + 2)
}

/**
 * The zone cells the NEXT tick's scan window will visit, in order. Used to build
 * a fixture that paves exactly the reachable window and nothing else.
 */
function scanWindowCells(state: GameState, world: WorldData, nextTick: number): number[] {
  const zoneCells = spawnZoneCells(world)
  const saved = state.header[H_TICK] as number
  state.header[H_TICK] = nextTick
  const start = spawnScanStart(state, zoneCells)
  state.header[H_TICK] = saved
  const limit = SPAWN_CANDIDATE_LIMIT < zoneCells ? SPAWN_CANDIDATE_LIMIT : zoneCells
  const out: number[] = []
  for (let k = 0; k < limit; k++) out.push(spawnZoneCellAt((start + k) % zoneCells, world))
  return out
}

describe('the spawn phase inside step', () => {
  it('will not spawn on a road the player laid this tick', () => {
    // The detector for transposing phases 3 and 4 — the pair that was inert
    // when it was "inputs vs demand" and is not inert now. The fixture paves
    // every cell the scan can reach on this tick, so the two orderings differ
    // by exactly one destination.
    //
    // A destination needs all seven of its cells road-free, and its footprint
    // reaches two cells past its origin — so paving the window's own cells is
    // enough to refuse every candidate whose ORIGIN is in the window, which is
    // every candidate the scan considers.
    const r = seededCityState('spawn-after-inputs')
    armDestinationTimerForNextTick(r.state)
    const nextTick = (r.state.header[H_TICK] as number) + 1
    const window = scanWindowCells(r.state, r.world, nextTick)
    const actions: TickAction[] = []
    for (const cell of window) {
      // One-cell strokes are not a thing; pave each window cell by joining it
      // to its eastern neighbour, which is inside the board on this zone.
      actions.push({ kind: 'place', a: cell, b: cell + 1 })
    }
    const before = r.state.header[H_DEST_COUNT] as number

    // The control FIRST, so "no destination appeared" is measured against a run
    // that produces one. Same seed, same tick, no actions.
    const control = seededCityState('spawn-after-inputs')
    armDestinationTimerForNextTick(control.state)
    step(control.state, control.world, control.fields, control.scratch, NO_INPUT)
    expect(
      control.state.header[H_DEST_COUNT],
      'vacuity: with the window clear, this tick MUST place a destination',
    ).toBe(before + 1)

    step(r.state, r.world, r.fields, r.scratch, { actions })
    expect(r.state.header[H_DEST_COUNT], 'a paved cell must refuse a destination').toBe(before)
  })

  it('stamps destSpawnTick from THIS tick, not the previous one', () => {
    // The detector for transposing phases 1 and 4: the off-by-one the M1d
    // handoff warned about, in every destination's first-pin delay at once.
    const r = seededCityState('spawn-stamp')
    armDestinationTimerForNextTick(r.state)
    const tickBefore = r.state.header[H_TICK] as number
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    const d = (r.state.header[H_DEST_COUNT] as number) - 1
    expect(d, 'vacuity: nothing spawned, so there is no stamp to check').toBeGreaterThan(2)
    expect(r.state.destSpawnTick[d]).toBe(tickBefore + 1)
  })

  it('a destination is INELIGIBLE on its own spawn tick, which is why 4 <-> 5 is inert', () => {
    // **This test was written as "the detector for transposing phases 4 and 5"
    // and it is not one — the transposition scores 0 detectors across the whole
    // 1,693-test suite, measured.** Rather than rename it and move on, it now
    // pins the property that MAKES the pair commute, so the day that property
    // stops holding this is the test that says so.
    //
    // Spawn writes `destCell`, `destMeta`, `destSpawnTick`, `H_DEST_COUNT` and —
    // through 5.3.5's push — `destPins`, `rotationCursor` and `H_PINS_DROPPED`,
    // every one of which demand reads. The sets overlap heavily, so the two
    // phases have no business commuting. They do anyway, for two reasons and
    // both are needed:
    //
    //   1. **A destination placed on tick T is ineligible on tick T** — the 4 s
    //      first-pin delay is `tick - destSpawnTick >= FIRST_PIN_DELAY_TICKS`
    //      and the stamp IS `tick` — so `computeSlotCounts`, `resolveCurrent`,
    //      `advanceCursor` and the overflow walk all skip it whichever side of
    //      demand it was placed on. That is what this test pins.
    //   2. **The push routes through `fireColour`, exactly as a scheduled pin
    //      does**, so on the rare tick both fire for one colour the two calls
    //      compose in either order: the same cursor advances the same way and
    //      the same pin lands on the same destination.
    //
    // Reason 1 dies the moment `FIRST_PIN_DELAY_TICKS` reaches 0, or the moment
    // anything backdates a spawned `destSpawnTick`. Reason 2 dies the moment
    // 5.3.5's push stops going through `fireColour`.
    // A board whose ONLY colour-3 building is one house, so the destination the
    // spawner places is the only colour-3 destination and
    // `hasEligibleDestinationOfColour(_, 3, _)` is a question about it alone.
    const r = rig('spawn-before-demand')
    r.state.header[H_WEEK] = 3
    expect(placeHouse(r.state, r.world, cellIn(r.world, 8, 20), 3)).toBe(true)
    expect(destCountOfColour(r.state, 3)).toBe(0)
    armDestinationTimerForNextTick(r.state)
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(destCountOfColour(r.state, 3), 'no colour-3 destination spawned').toBe(1)
    const d = (r.state.header[H_DEST_COUNT] as number) - 1
    const spawnTick = r.state.destSpawnTick[d] as number
    const tick = r.state.header[H_TICK] as number
    expect(spawnTick, 'the stamp is this tick').toBe(tick)
    expect(destMetaColour(r.state.destMeta[d] as number)).toBe(3)
    // Ineligible now, and eligible exactly FIRST_PIN_DELAY_TICKS later — the
    // inequality reason 1 rests on, at both of its boundaries.
    expect(FIRST_PIN_DELAY_TICKS, 'a zero delay ends the inertness').toBeGreaterThan(0)
    expect(hasEligibleDestinationOfColour(r.state, 3, spawnTick), 'eligible on its own spawn tick').toBe(false)
    expect(
      hasEligibleDestinationOfColour(r.state, 3, spawnTick + FIRST_PIN_DELAY_TICKS - 1),
      'eligible one tick early',
    ).toBe(false)
    expect(
      hasEligibleDestinationOfColour(r.state, 3, spawnTick + FIRST_PIN_DELAY_TICKS),
      'not eligible when the delay elapses',
    ).toBe(true)
  })

  it("spawning a destination rebuilds EVERY colour's field, because the staleness stamp is a byte hash", () => {
    // **The first draft asserted the opposite and called it "Derived, and
    // asserted so the derivation cannot rot into an accident."** It was derived
    // from the wrong model. `FIELD_INPUT_REGIONS` (regions.ts) is
    // ['mapIdentity', 'destCell', 'roads', 'destMeta', 'destPins'] — `destCell`
    // AND `destMeta`, both written by `placeDestination` — and `syncFields`
    // computes ONE global field-input hash and compares it against every
    // colour's `builtFromFieldInputs`. The stamp is a deliberately conservative
    // whole-region byte hash, not a semantic source-set question, so a
    // destination with no pin still invalidates all five colours.
    const r = seededCityState('spawn-rebuild')
    // Settle first: the seeded board rebuilds on its own for the first few
    // ticks, and a delta taken across that is the seed's, not the spawner's.
    parkSpawnTimers(r.state, 40)
    for (let i = 0; i < 40; i++) step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    const quiet = r.scratch.counters[CT_REBUILDS] as number
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    const perQuietTick = (r.scratch.counters[CT_REBUILDS] as number) - quiet

    armDestinationTimerForNextTick(r.state)
    const before = r.scratch.counters[CT_REBUILDS] as number
    const destsBefore = r.state.header[H_DEST_COUNT] as number
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(r.state.header[H_DEST_COUNT], 'vacuity: something must have spawned').toBe(destsBefore + 1)
    expect(r.scratch.counters[CT_REBUILDS], 'one per colour, not one').toBe(
      before + r.world.map.groupCount,
    )
    expect(perQuietTick, 'a quiet tick must NOT rebuild, or the delta above says nothing').toBe(0)

    // A HOUSE is not a field input: houseCell and houseColour are both
    // FIELD_IRRELEVANT, so this is the negative half of the same claim.
    const beforeHouse = r.scratch.counters[CT_REBUILDS] as number
    const housesBefore = r.state.header[H_HOUSE_COUNT] as number
    parkSpawnTimers(r.state, 10)
    armHouseTimerForNextTick(r.state, 0)
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(r.state.header[H_HOUSE_COUNT], 'vacuity: a house must have spawned').toBe(housesBefore + 1)
    expect(r.scratch.counters[CT_REBUILDS], 'a house rebuilds nothing').toBe(beforeHouse)
  })
})

// ---------------------------------------------------------------------------
// 5. Spec 5.3.5 — the blocked-spawn redistribution
// ---------------------------------------------------------------------------

/**
 * A board AT `maxDestinations`, with one house of every colour, past the
 * first-pin delay — the state `attemptDestinationSpawn` answers `BOARD_FULL`
 * from and the only state in which 5.3.5's push fires.
 *
 * All-land 24 x 40 rather than `firstCity`, because `firstCity`'s river runs
 * down column 12 through the middle of the zone and its trees are scattered
 * through it, so a hand-laid capacity grid there tops out at 6 of the 16
 * destinations and the fixture silently stops being full. Every placement is
 * asserted, and so is the resulting count.
 *
 * Three columns of `ORIENTATION_E` destinations at x = 5 / 11 / 17: each
 * occupies `x0 .. x0 + 3` (3-wide footprint plus the carpark), so the gaps are
 * 3 and the Chebyshev-2 spacing rule is satisfied by construction rather than
 * by trial. Rows at pitch 3 from y = 9. The houses sit at x = 22, clear of
 * every box.
 */
function fullBoardRig(seed: string): Rig {
  const r = rig(seed, testMap(24, 40))
  outer: for (let y = 9; y <= 29; y += 3) {
    for (const x of [5, 11, 17]) {
      if ((r.state.header[H_DEST_COUNT] as number) >= r.map.maxDestinations) break outer
      expect(
        placeDestination(r.state, r.world, cellIn(r.world, x, y), ORIENTATION_E, 0, DEST_KIND_SQUARE),
        `destination at (${x}, ${y})`,
      ).toBe(true)
    }
  }
  expect(r.state.header[H_DEST_COUNT], 'the fixture did not reach capacity').toBe(r.map.maxDestinations)
  // Every colour needs a house, or `attemptDestinationSpawn` returns
  // NO_ELIGIBLE_COLOUR and never reaches the capacity branch at all.
  for (let c = 0; c < r.map.groupCount; c++) {
    expect(placeHouse(r.state, r.world, cellIn(r.world, 22, 10 + c * 2), c), `house for colour ${c}`).toBe(true)
  }
  r.state.header[H_WEEK] = r.map.groupCount
  // Past the first-pin delay, so the push is delivered rather than discarded.
  r.state.header[H_TICK] = FIRST_PIN_DELAY_TICKS + 1
  return r
}

describe('the blocked-spawn redistribution (5.3.5)', () => {
  it('pushes a pin only when NOTHING will fit anywhere, not when the window missed', () => {
    // The two arms are the whole point of `SpawnOutcome`, and they must be
    // separable: a bounded scan missing on a board with room is the ordinary
    // case and must be silent, or 5.3.5 fires at the retry cadence.
    const roomy = seededCityState('scan-miss')
    roomy.state.header[H_TICK] = FIRST_PIN_DELAY_TICKS + 1
    // Pave every cell the window can reach, exactly as the phase-order test
    // does — room on the board, none in the window.
    const window = scanWindowCells(roomy.state, roomy.world, roomy.state.header[H_TICK] as number)
    for (const cell of window) placeRoadPair(roomy, cell)
    const before = pinsCreated(roomy.state)
    expect(attemptDestinationSpawn(roomy.state, roomy.world, roomy.scratch)).toBe(
      SpawnOutcome.SCAN_EXHAUSTED,
    )
    expect(pinsCreated(roomy.state), 'a missed window must not push').toBe(before)

    const full = fullBoardRig('board-full')
    const total = pinsCreated(full.state)
    expect(attemptDestinationSpawn(full.state, full.world, full.scratch)).toBe(SpawnOutcome.BOARD_FULL)
    expect(pinsCreated(full.state)).toBe(total + 1)
  })

  it('advances the colour cursor on a FAILED attempt too, so redistribution rotates', () => {
    // Without this, a saturated board pushes 100% of 5.3.5's demand into one
    // neighbourhood forever. Measured on the demo board before the fix: every
    // pushed pin went to colour 0.
    const full = fullBoardRig('board-full-rotate')
    const seen: number[] = []
    for (let i = 0; i < 6; i++) {
      const before = full.state.header[H_SPAWN_COLOUR_CURSOR] as number
      attemptDestinationSpawn(full.state, full.world, full.scratch)
      seen.push(before)
    }
    expect(new Set(seen).size, 'the cursor must visit more than one colour').toBeGreaterThan(1)
    // ...and it walks EVERY colour rather than alternating between two, which a
    // `(colour + 1) % 2` would satisfy.
    expect(new Set(seen).size).toBe(full.map.groupCount)
  })

  it('a pushed pin moves the rotation cursor as well as the pin count', () => {
    // `fireColour` advances `rotationCursor[colour]`, so 5.3.5's push changes
    // whose turn is next. Asserted rather than discovered.
    const full = fullBoardRig('board-full-rotation-cursor')
    const before = full.state.rotationCursor[0] as number
    attemptDestinationSpawn(full.state, full.world, full.scratch)
    expect(full.state.rotationCursor[0]).not.toBe(before)
  })

  it('counts a push it had to discard, and does not throw when it does', () => {
    // The `hasEligibleDestinationOfColour` guard is required, not defensive:
    // `fireColour` THROWS when no eligible destination of the colour exists, and
    // a colour whose only destinations are inside their 4 s first-pin delay is
    // an ordinary, reachable state.
    //
    // **This fixture is the one the counter needs and the brief said to write:**
    // a colour with a HOUSE (so it is chosen) and no ELIGIBLE destination (so
    // the push is discarded). Without it the counter is a decoration that reads
    // as defence.
    const r = seededCityState('discard')
    expect(placeHouse(r.state, r.world, cellIn(r.world, 18, 12), 2)).toBe(true)
    r.state.header[H_WEEK] = 2
    r.state.header[H_TICK] = 5 // every destination is inside its first-pin delay
    expect(hasEligibleDestinationOfColour(r.state, 2, 5), 'colour 2 has no destination at all').toBe(false)
    const before = r.scratch.counters[CT_BLOCKED_PUSH_DISCARDED] as number
    const pins = pinsCreated(r.state)
    expect(() => {
      pushBlockedSpawnDemand(r.state, 2, r.scratch)
    }, 'the guard must swallow this rather than let fireColour throw').not.toThrow()
    expect(r.scratch.counters[CT_BLOCKED_PUSH_DISCARDED]).toBe(before + 1)
    expect(pinsCreated(r.state), 'a discarded push must deliver nothing').toBe(pins)

    // The other side of the guard, so the counter is not simply always
    // incremented: a colour WITH an eligible destination delivers and does not
    // count a discard.
    r.state.header[H_TICK] = FIRST_PIN_DELAY_TICKS + 1
    expect(hasEligibleDestinationOfColour(r.state, 0, r.state.header[H_TICK] as number)).toBe(true)
    pushBlockedSpawnDemand(r.state, 0, r.scratch)
    expect(r.scratch.counters[CT_BLOCKED_PUSH_DISCARDED], 'a delivered push must not count').toBe(before + 1)
    expect(pinsCreated(r.state)).toBe(pins + 1)
  })

  it('refuses a colour that has no house, so no destination collects unservable pins', () => {
    // `attemptDestinationSpawn`'s `houseCountOfColour > 0` filter. On a board
    // where only colour 0 has a house, every destination the spawner places must
    // be colour 0 however many weeks have unlocked the others.
    const r = rig('no-house-colours')
    r.state.header[H_WEEK] = 4
    expect(placeHouse(r.state, r.world, cellIn(r.world, 8, 20), 0)).toBe(true)
    for (let t = 1; t <= 60; t++) {
      r.state.header[H_TICK] = t
      attemptDestinationSpawn(r.state, r.world, r.scratch)
    }
    const placedCount = r.state.header[H_DEST_COUNT] as number
    expect(placedCount, 'nothing spawned, so the colour claim is vacuous').toBeGreaterThan(0)
    for (let d = 0; d < placedCount; d++) {
      expect(destMetaColour(r.state.destMeta[d] as number), `destination ${d}`).toBe(0)
    }
    // ...and the cursor did NOT stick: it is written from the chosen colour, so
    // with only colour 0 eligible it is parked at 1 rather than wandering.
    expect(r.state.header[H_SPAWN_COLOUR_CURSOR]).toBe(1)
  })
})

/** Paves `cell` by joining it to its eastern neighbour — enough to refuse a destination there. */
function placeRoadPair(r: Rig, cell: number): void {
  const actions: TickAction[] = [{ kind: 'place', a: cell, b: cell + 1 }]
  const tick = r.state.header[H_TICK] as number
  step(r.state, r.world, r.fields, r.scratch, { actions })
  r.state.header[H_TICK] = tick
}

// ---------------------------------------------------------------------------
// 6. The timer ladder: which reset each outcome takes
// ---------------------------------------------------------------------------

describe('runSpawn timer resets', () => {
  it('takes the SCHEDULE on a placement and on a full board, and the RETRY on everything else', () => {
    // **The one line that decides 5.3.5's fire rate.** A full board is not going
    // to become un-full in 20 seconds, so resetting to the retry there fires the
    // redistribution every 600 ticks — 7.5 pushes a week against a schedule of
    // DESTINATIONS_PER_WEEK = 2. Each of the four reachable outcomes is driven
    // to its own reset and the value asserted, so the mutation cannot hide in
    // whichever arm the fixture happens not to reach.

    // PLACED -> the schedule.
    const placed = seededCityState('reset-placed')
    const destsBefore = placed.state.header[H_DEST_COUNT] as number
    placed.state.header[H_DEST_SPAWN_TIMER] = 1
    runSpawn(placed.state, placed.world, placed.scratch)
    expect(placed.state.header[H_DEST_COUNT], 'vacuity: nothing was placed').toBe(destsBefore + 1)
    expect(placed.state.header[H_DEST_SPAWN_TIMER]).toBe(DEST_SPAWN_PERIOD_TICKS)

    // BOARD_FULL -> the schedule, and that is the arm the mutation targets.
    const full = fullBoardRig('reset-full')
    full.state.header[H_DEST_SPAWN_TIMER] = 1
    runSpawn(full.state, full.world, full.scratch)
    expect(full.state.header[H_DEST_SPAWN_TIMER]).toBe(DEST_SPAWN_PERIOD_TICKS)
    expect(DEST_SPAWN_PERIOD_TICKS).not.toBe(DEST_SPAWN_RETRY_TICKS) // ...or the arms coincide

    // NO_ELIGIBLE_COLOUR -> the retry. An empty board has no house.
    const bare = rig('reset-no-colour')
    bare.state.header[H_DEST_SPAWN_TIMER] = 1
    runSpawn(bare.state, bare.world, bare.scratch)
    expect(bare.state.header[H_SPAWN_COLOUR_CURSOR], 'no colour was chosen').toBe(0)
    expect(bare.state.header[H_DEST_SPAWN_TIMER]).toBe(DEST_SPAWN_RETRY_TICKS)

    // ZONE_EMPTY -> the retry. A 4x4 board, with a house so a colour IS chosen
    // and the ZONE_EMPTY return is reached rather than NO_ELIGIBLE_COLOUR.
    const tiny = rig('reset-zone-empty', testMap(4, 4, 8, 4, 2))
    expect(placeHouse(tiny.state, tiny.world, 0, 0)).toBe(true)
    tiny.state.header[H_DEST_SPAWN_TIMER] = 1
    expect(spawnZoneCells(tiny.world)).toBe(0)
    expect(attemptDestinationSpawn(tiny.state, tiny.world, tiny.scratch)).toBe(SpawnOutcome.ZONE_EMPTY)
    expect(tiny.state.header[H_SPAWN_COLOUR_CURSOR], 'the cursor advances before the ZONE_EMPTY return').toBe(1)
    tiny.state.header[H_SPAWN_COLOUR_CURSOR] = 0
    runSpawn(tiny.state, tiny.world, tiny.scratch)
    expect(tiny.state.header[H_DEST_SPAWN_TIMER]).toBe(DEST_SPAWN_RETRY_TICKS)

    // SCAN_EXHAUSTED -> the retry.
    const missed = seededCityState('reset-scan-miss')
    missed.state.header[H_TICK] = FIRST_PIN_DELAY_TICKS + 1
    for (const cell of scanWindowCells(missed.state, missed.world, missed.state.header[H_TICK] as number)) {
      placeRoadPair(missed, cell)
    }
    missed.state.header[H_DEST_SPAWN_TIMER] = 1
    const dests = missed.state.header[H_DEST_COUNT] as number
    runSpawn(missed.state, missed.world, missed.scratch)
    expect(missed.state.header[H_DEST_COUNT], 'the window was supposed to miss').toBe(dests)
    expect(missed.state.header[H_DEST_SPAWN_TIMER]).toBe(DEST_SPAWN_RETRY_TICKS)
  })

  it('runs the house ladder per COLOUR, at the period on success and the retry on failure', () => {
    // §5.9's interval is "between same-group house spawns", so five colours
    // carry five independent countdowns. A single shared timer passes any test
    // that only ever watches one colour.
    const r = seededCityState('house-ladder')
    r.state.houseSpawnTimer.fill(50)
    r.state.houseSpawnTimer[1] = 1
    runSpawn(r.state, r.world, r.scratch)
    for (let c = 0; c < r.map.groupCount; c++) {
      if (c === 1) continue
      expect(r.state.houseSpawnTimer[c], `colour ${c} shares colour 1's timer`).toBe(49)
    }
    // Colour 1 took one of the two resets, and which one is decided by whether
    // its attempt placed anything.
    const placedForOne = (r.state.houseSpawnTimer[1] as number) === HOUSE_SPAWN_PERIOD_TICKS
    expect(
      r.state.houseSpawnTimer[1],
      'colour 1 took neither the period nor the retry',
    ).toBe(placedForOne ? HOUSE_SPAWN_PERIOD_TICKS : HOUSE_SPAWN_RETRY_TICKS)

    // Both arms, driven deliberately. A colour that cannot spawn (locked, no
    // house, week 0) always takes the retry; a colour whose founding house
    // lands always takes the period.
    const retry = rig('house-retry')
    retry.state.houseSpawnTimer[4] = 1
    runSpawn(retry.state, retry.world, retry.scratch)
    expect(retry.state.header[H_HOUSE_COUNT], 'colour 4 is locked at week 0').toBe(0)
    expect(retry.state.houseSpawnTimer[4]).toBe(HOUSE_SPAWN_RETRY_TICKS)

    const success = rig('house-period')
    success.state.header[H_WEEK] = 4
    success.state.houseSpawnTimer[4] = 1
    runSpawn(success.state, success.world, success.scratch)
    expect(success.state.header[H_HOUSE_COUNT], "colour 4's founding house").toBe(1)
    expect(success.state.houseSpawnTimer[4]).toBe(HOUSE_SPAWN_PERIOD_TICKS)
    expect(HOUSE_SPAWN_PERIOD_TICKS).not.toBe(HOUSE_SPAWN_RETRY_TICKS)
  })
})

// ---------------------------------------------------------------------------
// 7. Determinism, over the WHOLE buffer, with a spawner in the tick
// ---------------------------------------------------------------------------

describe('the spawner is deterministic over the whole buffer', () => {
  /** Drives `n` ticks and returns the whole-buffer digest. */
  function driveDigest(r: Rig, n: number): number {
    for (let i = 0; i < n; i++) step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    return hashState(r.state)
  }

  const RUN = 3000

  it('replays byte-identically from the same seed, and DIFFERENTLY from another', () => {
    // The spawner is the first thing in the game to introduce new randomness
    // and a new iteration order, so this is the highest-risk determinism claim
    // in the milestone and it is asserted over the whole buffer rather than
    // over a count.
    const a = seededCityState('determinism-a')
    const b = seededCityState('determinism-a')
    const digestA = driveDigest(a, RUN)
    expect(driveDigest(b, RUN)).toBe(digestA)
    // Vacuity in both directions: the run must have DONE something, and a
    // different seed must reach a different board — otherwise `toBe` above is
    // comparing two copies of nothing and the scan start is seed-blind.
    expect(a.state.header[H_HOUSE_COUNT], 'nothing spawned in 3,000 ticks').toBeGreaterThan(3)
    expect(digestA).not.toBe(hashState(seededCityState('determinism-a').state))
    const other = seededCityState('determinism-z')
    expect(driveDigest(other, RUN), 'two seeds produced the same board').not.toBe(digestA)
  })

  it('survives a snapshot and a restore into a COLD world, byte for byte', () => {
    // A Worker verifying a replay holds no `fields` and no `scratch` — both are
    // re-derivable from the buffer by design decision 3 — so the restored run
    // must agree with the live one from a cold start. The spawner reads
    // `state.rng[0]` and `H_TICK` and nothing else outside the buffer, and this
    // is what says so.
    const live = seededCityState('determinism-snapshot')
    driveDigest(live, 1200)
    const image = snapshot(live.state)

    const coldWorld = createWorld(firstCity())
    const cold: Rig = {
      map: live.map,
      world: coldWorld,
      state: restore(image, coldWorld),
      scratch: createScratch(
        coldWorld.cells,
        live.map.groupCount,
        live.map.maxDestinations,
        createFieldInputRanges(live.map),
      ),
      fields: createFlowFields(live.map.groupCount, coldWorld.cells),
    }
    expect(hashState(cold.state), 'the restore itself moved a byte').toBe(hashState(live.state))

    const before = live.state.header[H_HOUSE_COUNT] as number
    const liveDigest = driveDigest(live, 1800)
    expect(driveDigest(cold, 1800), 'a cold replay diverged from the live run').toBe(liveDigest)
    expect(
      live.state.header[H_HOUSE_COUNT],
      'the continued run spawned nothing, so it proves nothing about the spawner',
    ).toBeGreaterThan(before)
  })

  it('rolls back to an earlier snapshot and re-runs to the same bytes', () => {
    // The rollback half: a buffer captured mid-run, replayed forward twice,
    // must land on the same bytes both times — including the spawn timers, the
    // colour cursor and every building the spawner placed on the way.
    const r = seededCityState('determinism-rollback')
    driveDigest(r, 900)
    const image = snapshot(r.state)
    const first = driveDigest(r, 900)

    const again: Rig = {
      map: r.map,
      world: r.world,
      state: restore(image, r.world),
      scratch: createScratch(
        r.world.cells,
        r.map.groupCount,
        r.map.maxDestinations,
        createFieldInputRanges(r.map),
      ),
      fields: createFlowFields(r.map.groupCount, r.world.cells),
    }
    expect(driveDigest(again, 900)).toBe(first)
    expect(again.state.header[H_DEST_SPAWN_TIMER]).toBe(r.state.header[H_DEST_SPAWN_TIMER])
    expect(again.state.header[H_SPAWN_COLOUR_CURSOR]).toBe(r.state.header[H_SPAWN_COLOUR_CURSOR])
    expect(Array.from(again.state.houseSpawnTimer)).toEqual(Array.from(r.state.houseSpawnTimer))
  })

  it('never spawns a building outside the clipped revealed rect', () => {
    // The player cannot see outside the rect, and `canvas.ts` culls a building
    // by its ANCHOR cell — so a building placed half outside is both illegal
    // and half-invisible. Asserted over a long run rather than over one
    // placement, and over every cell of every destination rather than its
    // origin.
    const r = seededCityState('inside-rect')
    for (let i = 0; i < 6000; i++) step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    const houses = r.state.header[H_HOUSE_COUNT] as number
    const dests = r.state.header[H_DEST_COUNT] as number
    expect(houses, 'no house spawned').toBeGreaterThan(3)
    expect(dests, 'no destination spawned').toBeGreaterThan(3)
    // The three seeded houses and three seeded destinations are inside the rect
    // too (M2 placed them there deliberately), so every index can be checked.
    for (let h = 0; h < houses; h++) {
      expect(inSpawnZone(r.state.houseCell[h] as number, r.world), `house ${h}`).toBe(true)
    }
    for (let d = 0; d < dests; d++) {
      expect(
        destinationFitsSpawnZone(
          r.state.destCell[d] as number,
          (r.state.destMeta[d] as number) >> 4 & 0x3,
          r.world,
        ),
        `destination ${d} is not wholly inside the rect`,
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Packing the zone: the two properties a single spawn cannot show
// ---------------------------------------------------------------------------

describe('packing the whole zone with the spawner', () => {
  /**
   * **Two mutants survived a suite that only ever watched two or three
   * spawns**, and this block exists because of them. Dropping the
   * `destinationFitsSpawnZone` call entirely, and dropping the per-zone-index
   * ORIENTATION ROTATION, both scored 0 detectors: `firstCity` produces about
   * two spawns in 6,000 ticks, which is far too small a sample for either
   * property to be visible. (The rotation's one apparent kill came from
   * `drawAllocation.test.ts`'s sampling profiler, which has no path to this
   * code at all — the catalogue's "a flaky test inflates a kill count exactly
   * as a crashing mutant does", caught by re-running.)
   *
   * The fixture drives `attemptDestinationSpawn` DIRECTLY across many ticks so
   * the bounded window walks the whole zone, on an all-land board with room for
   * enough destinations that the packing reaches the zone's own edges.
   */
  function packedRig(): Rig {
    const r = rig('packing', testMap(24, 40, 40, 24, 5))
    // One house, so colour 0 is the only eligible colour and every placement is
    // attributable. Outside the zone, so it cannot itself block a candidate.
    expect(placeHouse(r.state, r.world, cellIn(r.world, 1, 1), 0)).toBe(true)
    for (let t = 1; t <= 4000; t++) {
      r.state.header[H_TICK] = t
      attemptDestinationSpawn(r.state, r.world, r.scratch)
    }
    return r
  }

  it('never places a destination whose seven cells leave the revealed rect', () => {
    const r = packedRig()
    const count = r.state.header[H_DEST_COUNT] as number
    // A big enough sample that a right- or bottom-edge candidate really was
    // offered: the zone is 308 cells and 4,000 windows walk it many times over.
    expect(count, 'the fixture must pack the zone, not place two destinations').toBeGreaterThanOrEqual(12)
    for (let d = 0; d < count; d++) {
      const cell = r.state.destCell[d] as number
      const orientation = (r.state.destMeta[d] as number) >> 4 & 0x3
      expect(
        destinationFitsSpawnZone(cell, orientation, r.world),
        `destination ${d} at cell ${cell} (x=${cell % r.world.w}, y=${(cell / r.world.w) | 0}), orientation ${orientation}`,
      ).toBe(true)
      // Spelled out per cell as well, because `destinationFitsSpawnZone` is the
      // function under test and asserting a predicate against itself proves
      // nothing on its own.
      const x0 = cell % r.world.w
      const y0 = (cell / r.world.w) | 0
      const fw = orientation === ORIENTATION_E || orientation === ORIENTATION_W ? 3 : 2
      const fh = orientation === ORIENTATION_E || orientation === ORIENTATION_W ? 2 : 3
      for (let dy = 0; dy < fh; dy++) {
        for (let dx = 0; dx < fw; dx++) {
          expect(
            inSpawnZone((y0 + dy) * r.world.w + (x0 + dx), r.world),
            `destination ${d} footprint cell (${x0 + dx}, ${y0 + dy})`,
          ).toBe(true)
        }
      }
      expect(
        inSpawnZone(carparkCell(cell, orientation, r.world.w, r.world.h), r.world),
        `destination ${d} carpark`,
      ).toBe(true)
    }
    // Vacuity in the direction that matters: the packing really does reach the
    // zone's far edges, so a candidate that WOULD have stuck out was offered.
    let maxX = 0
    let maxY = 0
    for (let d = 0; d < count; d++) {
      const cell = r.state.destCell[d] as number
      const orientation = (r.state.destMeta[d] as number) >> 4 & 0x3
      const fw = orientation === ORIENTATION_E || orientation === ORIENTATION_W ? 3 : 2
      const fh = orientation === ORIENTATION_E || orientation === ORIENTATION_W ? 2 : 3
      maxX = Math.max(maxX, (cell % r.world.w) + fw - 1)
      maxY = Math.max(maxY, ((cell / r.world.w) | 0) + fh - 1)
    }
    expect(maxX, 'nothing reached the right half of the zone').toBeGreaterThanOrEqual(REVEALED_X0 + REVEALED_W - 4)
    expect(maxY, 'nothing reached the bottom half of the zone').toBeGreaterThanOrEqual(REVEALED_Y0 + REVEALED_H - 4)
  })

  it('rotates the orientation by zone index, so the board does not fill with one facing', () => {
    // The orientation decides which side the driveway is on, which is most of
    // whether a destination is servable at all. Without the rotation the scan
    // tries N first every time and the board fills with north-facing carparks.
    const r = packedRig()
    const count = r.state.header[H_DEST_COUNT] as number
    const used = new Set<number>()
    for (let d = 0; d < count; d++) used.add((r.state.destMeta[d] as number) >> 4 & 0x3)
    expect(count).toBeGreaterThanOrEqual(12)
    expect(
      used.size,
      `every spawned destination faces the same way (${[...used].join(', ')})`,
    ).toBeGreaterThan(1)
    // Not merely "more than one": no single facing may take more than three
    // quarters of the board, which is the shape "N first, always" produces.
    for (const o of used) {
      let n = 0
      for (let d = 0; d < count; d++) if (((r.state.destMeta[d] as number) >> 4 & 0x3) === o) n++
      expect(n / count, `orientation ${o} took ${n} of ${count}`).toBeLessThan(0.75)
    }
  })
})
