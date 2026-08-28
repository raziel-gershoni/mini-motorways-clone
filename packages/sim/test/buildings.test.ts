import { describe, it, expect } from 'vitest'
import { parseMap, CARS_PER_HOUSE, type MapData } from '@laneways/shared'
import {
  createState,
  houseAt,
  destAt,
  H_HOUSE_COUNT,
  H_DEST_COUNT,
  H_INV_UPGRADES,
  H_TICK,
  type GameState,
} from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { placeRoad, eraseRoad, hasTree } from '../src/roads'
import { fieldFor, syncFields } from '../src/flowfield'
import { createFlowFields, createScratch, INF } from '../src/scratch'
import { createFieldInputRanges } from '../src/regions'
import {
  ORIENTATION_N,
  ORIENTATION_E,
  ORIENTATION_S,
  ORIENTATION_W,
  ORIENTATION_COUNT,
  DEST_KIND_SQUARE,
  DEST_KIND_CIRCLE,
  PHASE_NONE,
  PHASE_IDLE,
  packDestMeta,
  destMetaColour,
  destMetaKind,
  destMetaOrientation,
  carparkCell,
  isFootprintCell,
  footprintWidth,
  footprintHeight,
  spacingViolated,
  canPlaceHouse,
  placeHouse,
  canPlaceDestination,
  placeDestination,
  type PlaceCheck,
} from '../src/buildings'
import { applyPlaceUpgrade, isUpgraded } from '../src/upgrades'

/**
 * Non-square (w=9, h=6) fixture, all LAND, large enough to hold several
 * spaced-out destinations plus houses without geometry running off the grid.
 * Non-square deliberately, per the milestone-wide rule and this task's own
 * requirement: a square fixture cannot distinguish w from h anywhere in the
 * footprint/carpark geometry.
 */
const W = 9
const H = 6
const ROWS = Object.freeze([
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
] as const)

function fixture(id: string, maxHouses = 40, maxDestinations = 16): { map: MapData; world: WorldData } {
  const map = parseMap(id, ROWS as unknown as string[], 50, maxHouses, maxDestinations, 5)
  const world = createWorld(map)
  return { map, world }
}

describe('orientation and destMeta packing', () => {
  it('ORIENTATION_COUNT is 4, and N/E/S/W are 0/1/2/3', () => {
    expect(ORIENTATION_COUNT).toBe(4)
    expect([ORIENTATION_N, ORIENTATION_E, ORIENTATION_S, ORIENTATION_W]).toEqual([0, 1, 2, 3])
  })

  it('packDestMeta/unpack round-trips over all 6 x 2 x 4 combinations, with bits 6-7 always zero', () => {
    let count = 0
    for (let colour = 0; colour < 6; colour++) {
      for (let kind = 0; kind <= 1; kind++) {
        for (let orientation = 0; orientation < ORIENTATION_COUNT; orientation++) {
          const packed = packDestMeta(colour, kind, orientation)
          expect(destMetaColour(packed), `colour @ (${colour},${kind},${orientation})`).toBe(colour)
          expect(destMetaKind(packed), `kind @ (${colour},${kind},${orientation})`).toBe(kind)
          expect(destMetaOrientation(packed), `orientation @ (${colour},${kind},${orientation})`).toBe(orientation)
          expect(packed & 0xc0, `bits 6-7 @ (${colour},${kind},${orientation})`).toBe(0)
          count++
        }
      }
    }
    // Vacuity: the loop actually ran all 48 combinations.
    expect(count).toBe(48)
  })

  it('DEST_KIND_SQUARE is 0 and DEST_KIND_CIRCLE is 1', () => {
    expect(DEST_KIND_SQUARE).toBe(0)
    expect(DEST_KIND_CIRCLE).toBe(1)
  })

  it('rejects an out-of-range orientation', () => {
    expect(() => packDestMeta(0, 0, 4)).toThrow()
    expect(() => packDestMeta(0, 0, -1)).toThrow()
  })

  it('rejects an invalid kind', () => {
    expect(() => packDestMeta(0, 2, 0)).toThrow()
  })

  it('rejects an out-of-range colour', () => {
    expect(() => packDestMeta(8, 0, 0)).toThrow()
    expect(() => packDestMeta(-1, 0, 0)).toThrow()
  })
})

describe('footprint and carpark geometry — non-square grid, all four orientations', () => {
  // Origin well clear of every edge so no orientation's footprint or carpark
  // runs off the grid: x0=3 (footprint width up to 3 -> occupies x in
  // [3,6), carpark at x=6 or x=2, both < 9 and >= 0), y0=1 (footprint
  // height up to 3 -> occupies y in [1,4), carpark at y=4 or y=0, both < 6
  // and >= 0).
  const x0 = 3
  const y0 = 1
  const destCell = y0 * W + x0

  function cellsInGrid(): number[] {
    const out: number[] = []
    for (let c = 0; c < W * H; c++) out.push(c)
    return out
  }

  function footprintOf(orientation: number): number[] {
    return cellsInGrid().filter((c) => isFootprintCell(destCell, orientation, W, c))
  }

  it('orientation N: 2 wide x 3 tall footprint at origin, carpark north at the lower-index adjacent cell', () => {
    const expected = [
      y0 * W + x0,
      y0 * W + x0 + 1,
      (y0 + 1) * W + x0,
      (y0 + 1) * W + x0 + 1,
      (y0 + 2) * W + x0,
      (y0 + 2) * W + x0 + 1,
    ].sort((a, b) => a - b)
    expect(footprintOf(ORIENTATION_N).sort((a, b) => a - b)).toEqual(expected)
    expect(carparkCell(destCell, ORIENTATION_N, W, H)).toBe((y0 - 1) * W + x0)
    // The OTHER adjacent cell on the same (north) side must NOT be the carpark.
    expect(carparkCell(destCell, ORIENTATION_N, W, H)).not.toBe((y0 - 1) * W + x0 + 1)
  })

  it('orientation S: 2 wide x 3 tall footprint at origin, carpark south at the lower-index adjacent cell', () => {
    const expected = [
      y0 * W + x0,
      y0 * W + x0 + 1,
      (y0 + 1) * W + x0,
      (y0 + 1) * W + x0 + 1,
      (y0 + 2) * W + x0,
      (y0 + 2) * W + x0 + 1,
    ].sort((a, b) => a - b)
    expect(footprintOf(ORIENTATION_S).sort((a, b) => a - b)).toEqual(expected)
    expect(carparkCell(destCell, ORIENTATION_S, W, H)).toBe((y0 + 3) * W + x0)
    expect(carparkCell(destCell, ORIENTATION_S, W, H)).not.toBe((y0 + 3) * W + x0 + 1)
  })

  it('orientation E: 3 wide x 2 tall footprint at origin, carpark east at the lower-index adjacent cell', () => {
    const expected = [
      y0 * W + x0,
      y0 * W + x0 + 1,
      y0 * W + x0 + 2,
      (y0 + 1) * W + x0,
      (y0 + 1) * W + x0 + 1,
      (y0 + 1) * W + x0 + 2,
    ].sort((a, b) => a - b)
    expect(footprintOf(ORIENTATION_E).sort((a, b) => a - b)).toEqual(expected)
    expect(carparkCell(destCell, ORIENTATION_E, W, H)).toBe(y0 * W + x0 + 3)
    // The OTHER adjacent cell on the same (east) side must NOT be the carpark.
    expect(carparkCell(destCell, ORIENTATION_E, W, H)).not.toBe((y0 + 1) * W + x0 + 3)
  })

  it('orientation W: 3 wide x 2 tall footprint at origin, carpark west at the lower-index adjacent cell', () => {
    const expected = [
      y0 * W + x0,
      y0 * W + x0 + 1,
      y0 * W + x0 + 2,
      (y0 + 1) * W + x0,
      (y0 + 1) * W + x0 + 1,
      (y0 + 1) * W + x0 + 2,
    ].sort((a, b) => a - b)
    expect(footprintOf(ORIENTATION_W).sort((a, b) => a - b)).toEqual(expected)
    expect(carparkCell(destCell, ORIENTATION_W, W, H)).toBe(y0 * W + (x0 - 1))
    expect(carparkCell(destCell, ORIENTATION_W, W, H)).not.toBe((y0 + 1) * W + (x0 - 1))
  })

  it('carparkCell returns -1 when the carpark would fall off the grid, for every orientation at its own edge', () => {
    // Review finding I2: only the two LOW edges (N's y=-1, W's x=-1) had
    // coverage. The two HIGH edges — E's x=w and S's y=h — are the ones a
    // dropped `cx >= w` / `cy >= h` guard silently WRAPS into a plausible,
    // wrong, in-bounds cell rather than merely producing a negative index,
    // which is the more dangerous failure mode (see the out-of-bounds
    // describe block below for the `canPlaceDestination`-level consequence).
    //
    // Origin at (0,0): orientation N's carpark is at y=-1, off-grid.
    expect(carparkCell(0, ORIENTATION_N, W, H)).toBe(-1)
    // Origin at (0,0): orientation W's carpark is at x=-1, off-grid.
    expect(carparkCell(0, ORIENTATION_W, W, H)).toBe(-1)
    // Origin (6,2), orientation E: footprint x{6,7,8} fits (w=9), but the
    // carpark needs x=9 — off the high edge.
    expect(carparkCell(destCellFor(6, 2), ORIENTATION_E, W, H)).toBe(-1)
    // Origin (3,3), orientation S: footprint y{3,4,5} fits (h=6), but the
    // carpark needs y=6 — off the high edge.
    expect(carparkCell(destCellFor(3, 3), ORIENTATION_S, W, H)).toBe(-1)
  })

  it('footprint cells never include the carpark cell, for any orientation', () => {
    for (let o = 0; o < ORIENTATION_COUNT; o++) {
      const cp = carparkCell(destCell, o, W, H)
      expect(isFootprintCell(destCell, o, W, cp)).toBe(false)
    }
  })
})

describe('house placement validity', () => {
  it('a valid house succeeds and reads back through houseAt', () => {
    const { map, world } = fixture('house-valid')
    const state = createState('s', map)
    expect(placeHouse(state, world, 10, 2)).toBe(true)
    expect(state.header[H_HOUSE_COUNT]).toBe(1)
    expect(houseAt(state, 0)).toBe(10)
    expect(state.houseColour[0]).toBe(2)
  })

  it('rejects a non-passable cell with reason terrain', () => {
    const map = parseMap('house-terrain', ['.~.......', '.........', '.........', '.........', '.........', '.........'], 50, 40, 16, 5)
    const world = createWorld(map)
    const state = createState('s', map)
    expect(canPlaceHouse(state, world, 1)).toEqual({ ok: false, reason: 'terrain' })
    expect(placeHouse(state, world, 1, 0)).toBe(false)
    expect(state.header[H_HOUSE_COUNT]).toBe(0)
  })

  it('rejects a standing tree with reason tree, using hasTree (not world.passable)', () => {
    const map = parseMap('house-tree', ['.T.......', '.........', '.........', '.........', '.........', '.........'], 50, 40, 16, 5)
    const world = createWorld(map)
    const state = createState('s', map)
    expect(hasTree(state, world, 1)).toBe(true)
    expect(canPlaceHouse(state, world, 1)).toEqual({ ok: false, reason: 'tree' })
    // Clear the tree with a road, then ERASE the road again (as
    // roads.test.ts's own "design decision 1" tests do): tree destruction is
    // irreversible but the road bit itself is not, so this isolates "was a
    // tree" from "carries a road" as two independently-testable conditions.
    // The SAME cell must then become placeable: this is the discriminator
    // between `hasTree` and a raw `world.terrain[cell] === TREE` check,
    // which would still see TREE and reject forever.
    expect(placeRoad(state, world, 1, 0)).toBe(true)
    expect(hasTree(state, world, 1)).toBe(false)
    expect(eraseRoad(state, world, 1, 0)).toBe(true)
    expect(canPlaceHouse(state, world, 1)).toEqual({ ok: true })
  })

  it('rejects a cell carrying a road with reason road', () => {
    const { map, world } = fixture('house-road')
    const state = createState('s', map)
    expect(placeRoad(state, world, 10, 11)).toBe(true)
    expect(canPlaceHouse(state, world, 10)).toEqual({ ok: false, reason: 'road' })
  })

  it('rejects a cell on another house, with reason building', () => {
    const { map, world } = fixture('house-vs-house')
    const state = createState('s', map)
    expect(placeHouse(state, world, 10, 0)).toBe(true)
    expect(canPlaceHouse(state, world, 10)).toEqual({ ok: false, reason: 'building' })
    expect(placeHouse(state, world, 10, 1)).toBe(false)
    expect(state.header[H_HOUSE_COUNT]).toBe(1)
  })

  it('rejects a cell on an existing destination\'s footprint, with reason building', () => {
    const { map, world } = fixture('house-vs-dest-footprint')
    const state = createState('s', map)
    expect(placeDestination(state, world, destCellFor(3, 1), ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(canPlaceHouse(state, world, destCellFor(4, 2))).toEqual({ ok: false, reason: 'building' })
  })

  it('rejects a cell on an existing destination\'s carpark, with reason building', () => {
    const { map, world } = fixture('house-vs-dest-carpark')
    const state = createState('s', map)
    expect(placeDestination(state, world, destCellFor(3, 1), ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    const cp = carparkCell(destCellFor(3, 1), ORIENTATION_N, W, H)
    expect(canPlaceHouse(state, world, cp)).toEqual({ ok: false, reason: 'building' })
  })

  it('rejects placement once H_HOUSE_COUNT === maxHouses, and does not move the count', () => {
    const { map, world } = fixture('house-capacity', 2, 16)
    const state = createState('s', map)
    expect(placeHouse(state, world, 0, 0)).toBe(true)
    expect(placeHouse(state, world, 1, 0)).toBe(true)
    // Vacuity: the fixture genuinely reached capacity before the rejection below.
    expect(state.header[H_HOUSE_COUNT]).toBe(2)
    expect(map.maxHouses).toBe(2)

    const before = state.header[H_HOUSE_COUNT]
    expect(canPlaceHouse(state, world, 2)).toEqual({ ok: false, reason: 'capacity' })
    expect(placeHouse(state, world, 2, 0)).toBe(false)
    // Both must hold: rejection AND the count did not move — an out-of-range
    // typed-array write into houseCell/houseColour is a silent no-op, so a
    // `<` -> `<=` capacity bug would still leave houseCell/houseColour
    // looking untouched while H_HOUSE_COUNT itself crept past maxHouses.
    expect(state.header[H_HOUSE_COUNT]).toBe(before)
  })

  /**
   * A building's colour is validated at the placement boundary against THIS
   * map's `groupCount` (M1c Task 4 review, I-1). Every downstream failure of
   * an out-of-range colour is silent, so none of them can be relied on:
   *
   *   - `houseColour` is a `Uint8Array`, so 256 stores as 0 and the house
   *     serves a group it was never given — confidently wrong, not absent.
   *   - A colour-6 house on a 5-group map matches no iteration of
   *     `runDispatch`'s per-colour loop and is skipped forever, with no error.
   *   - A colour-6 destination indexes `slotCounts`/`sourcesFlat` past their
   *     ends, and an out-of-range typed-array write is a silent no-op.
   *
   * Checked here rather than left to the per-tick guards in `demand.ts` and
   * `dispatch.ts`: those throw from inside `step`, which poisons the run
   * (`H_EPOCH`) for what is a caller error at placement time.
   */
  it('throws for a house colour outside this map’s group count, and places nothing', () => {
    const { map, world } = fixture('house-colour-range')
    const state = createState('s', map)
    expect(map.groupCount).toBe(5)

    expect(() => placeHouse(state, world, 0, 5)).toThrow(/colour must be an integer in \[0, 5\)/)
    expect(() => placeHouse(state, world, 0, -1)).toThrow(/colour must be an integer in \[0, 5\)/)
    // 256 is the witness that matters: a Uint8Array stores it as 0, so without
    // this guard the house silently ALIASES to colour 0 and serves it.
    expect(() => placeHouse(state, world, 0, 256)).toThrow(/colour must be an integer in \[0, 5\)/)
    expect(state.header[H_HOUSE_COUNT]).toBe(0)

    // Vacuity: the boundary value itself is accepted, so the guard is not
    // simply rejecting everything.
    expect(placeHouse(state, world, 0, 4)).toBe(true)
    expect(state.houseColour[0]).toBe(4)
  })
})


/**
 * Builds a degree-3 junction at `cell`, places a junction upgrade on it, then
 * erases every arm — leaving bare ground with an upgrade flag still on it.
 *
 * **The whole fixture is the reachable path, driven through production calls.**
 * An upgrade can only ever be placed on a junction, so `upgradeAt[cell] = 1` on
 * an empty cell is a state no player produces; the erase is what produces it,
 * and it is the exact sequence §5.9's *"nothing spawns on an existing road
 * tile"* does not cover. Writing the byte directly would have tested the same
 * branch and proved nothing about whether a player can reach it.
 *
 * `arms` are the three neighbours, so a caller can keep the junction clear of
 * whatever else its board carries.
 */
function upgradedBareCell(
  state: GameState,
  world: WorldData,
  cell: number,
  arms: readonly number[],
): void {
  expect(arms.length, 'a junction needs three arms').toBe(3)
  for (const arm of arms) expect(placeRoad(state, world, cell, arm), `arm ${arm}`).toBe(true)
  state.header[H_INV_UPGRADES] = 1
  expect(applyPlaceUpgrade(state, world, cell), 'the upgrade seated').toBe(true)
  for (const arm of arms) expect(eraseRoad(state, world, cell, arm), `erase ${arm}`).toBe(true)
  expect(state.roads[cell], 'and the cell is bare ground again').toBe(0)
  expect(isUpgraded(state, cell), 'with the flag still on it').toBe(true)
}

/** Cell index helper for the W=9 fixture grid above. */
function destCellFor(x: number, y: number): number {
  return y * W + x
}

describe('destination placement validity', () => {
  it('a valid destination succeeds and reads back through destAt', () => {
    const { map, world } = fixture('dest-valid')
    const state = createState('s', map)
    const cell = destCellFor(3, 1)
    expect(placeDestination(state, world, cell, ORIENTATION_N, 2, DEST_KIND_CIRCLE)).toBe(true)
    expect(state.header[H_DEST_COUNT]).toBe(1)
    expect(destAt(state, 0)).toBe(cell)
    expect(destMetaColour(state.destMeta[0] as number)).toBe(2)
    expect(destMetaKind(state.destMeta[0] as number)).toBe(DEST_KIND_CIRCLE)
    expect(destMetaOrientation(state.destMeta[0] as number)).toBe(ORIENTATION_N)
  })

  it('stamps destSpawnTick from H_TICK at the moment of placement', () => {
    const { map, world } = fixture('dest-spawn-tick')
    const state = createState('s', map)
    state.header[H_TICK] = 777
    expect(placeDestination(state, world, destCellFor(3, 1), ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(state.destSpawnTick[0]).toBe(777)
  })

  it('rejects a footprint cell that is not passable, with reason terrain', () => {
    const map = parseMap(
      'dest-terrain',
      ['.........', '.........', '....~....', '.........', '.........', '.........'],
      50,
      40,
      16,
      5,
    )
    const world = createWorld(map)
    const state = createState('s', map)
    expect(canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'terrain',
    })
  })

  it('rejects a footprint cell carrying a standing tree, with reason tree, using hasTree', () => {
    const map = parseMap(
      'dest-tree',
      ['.........', '.........', '....T....', '.........', '.........', '.........'],
      50,
      40,
      16,
      5,
    )
    const world = createWorld(map)
    const state = createState('s', map)
    const cell = destCellFor(3, 1)
    expect(hasTree(state, world, destCellFor(4, 2))).toBe(true)
    expect(canPlaceDestination(state, world, cell, ORIENTATION_N)).toEqual({ ok: false, reason: 'tree' })
    // Clear it with a road, then ERASE the road again — tree destruction is
    // irreversible but the road bit is not (design decision 1) — leaving
    // `hasTree` false and `roads` back to zero. This is the discriminator
    // fix-list #25 names explicitly: a raw `world.terrain[cell] === TREE`
    // check (ignoring `cleared`) would still see TREE here and reject
    // forever, exactly as it would on a standing tree, so ONLY calling
    // `hasTree` makes the placement succeed at this point.
    expect(placeRoad(state, world, destCellFor(4, 2), destCellFor(4, 1))).toBe(true)
    expect(hasTree(state, world, destCellFor(4, 2))).toBe(false)
    expect(eraseRoad(state, world, destCellFor(4, 2), destCellFor(4, 1))).toBe(true)
    expect(canPlaceDestination(state, world, cell, ORIENTATION_N)).toEqual({ ok: true })
  })

  it('rejects a footprint cell carrying a road, with reason road', () => {
    const { map, world } = fixture('dest-road')
    const state = createState('s', map)
    expect(placeRoad(state, world, destCellFor(4, 2), destCellFor(4, 1))).toBe(true)
    expect(canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'road',
    })
  })

  it('rejects the carpark cell carrying a road, with reason road (both endpoints of the 7 matter)', () => {
    const { map, world } = fixture('dest-road-carpark')
    const state = createState('s', map)
    const cp = carparkCell(destCellFor(3, 1), ORIENTATION_N, W, H)
    expect(placeRoad(state, world, cp, cp + 1)).toBe(true)
    expect(canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'road',
    })
  })

  it('rejects a second destination within Chebyshev distance 1 of an existing one, with reason spacing', () => {
    const { map, world } = fixture('dest-spacing-reject')
    const state = createState('s', map)
    expect(placeDestination(state, world, destCellFor(3, 1), ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    // First destination's 7 cells: footprint (3,1),(4,1),(3,2),(4,2),(3,3),
    // (4,3), carpark (3,0). A second destination at x0=5 has its west-most
    // footprint column at x=5, exactly Chebyshev distance 1 from the first's
    // east-most footprint column at x=4 on the same rows (e.g. (4,1) vs
    // (5,1)) — too close, computed by hand, not assumed.
    expect(canPlaceDestination(state, world, destCellFor(5, 1), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'spacing',
    })
  })

  it('accepts a second destination at exactly Chebyshev distance 2 from an existing one (the boundary)', () => {
    const { map, world } = fixture('dest-spacing-boundary')
    const state = createState('s', map)
    expect(placeDestination(state, world, destCellFor(3, 1), ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    // x0=6: the closest pair across both destinations' full 7-cell sets is
    // (4,1)-(6,1) [and (4,2)-(6,2), (4,3)-(6,3)], each Chebyshev distance
    // exactly 2 — the boundary itself, not a comfortable margin above it.
    // Every other pair (e.g. the two carparks (3,0)-(6,0), distance 3) is
    // farther, so this pair is the true minimum, computed by hand.
    const secondOrigin = destCellFor(6, 1)
    expect(canPlaceDestination(state, world, secondOrigin, ORIENTATION_N)).toEqual({ ok: true })
  })

  it('rejects a diagonal violation where the carpark is the closer cell, over Chebyshev not Manhattan', () => {
    // Review finding I1: the two existing spacing fixtures are both
    // horizontal and both have footprint-to-footprint as the closest pair —
    // neither the carpark's participation nor the Chebyshev-vs-Manhattan
    // distinction is exercised. This fixture isolates both at once.
    const { map, world } = fixture('dest-spacing-diagonal-carpark')
    const state = createState('s', map)
    // A: origin (0,1), orientation N -> footprint (0,1),(1,1),(0,2),(1,2),
    // (0,3),(1,3); carpark (0,0).
    expect(placeDestination(state, world, destCellFor(0, 1), ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    // B: origin (3,0), orientation W -> footprint (3,0),(4,0),(5,0),(3,1),
    // (4,1),(5,1); carpark (2,0).
    // The closest pair across the two destinations' full 7-cell sets is A's
    // footprint cell (1,1) to B's CARPARK (2,0): dx=1, dy=1, Chebyshev=1
    // (rejected), Manhattan=2 (NOT rejected). Every footprint-to-footprint
    // pair is at Chebyshev/Manhattan >= 2 (checked by hand: (1,1)-(3,0) is
    // dx=2,dy=1; (1,1)-(3,1) is dx=2,dy=0) — so a footprint-only comparison
    // also finds no violation and would wrongly accept this placement.
    expect(canPlaceDestination(state, world, destCellFor(3, 0), ORIENTATION_W)).toEqual({
      ok: false,
      reason: 'spacing',
    })
  })

  it('rejects the mirrored diagonal violation, where the EXISTING destination\'s carpark is the closer cell', () => {
    // Re-review finding: the fixture above places A first (so A's cells
    // become `otherCells` in the spacing loop) and tests candidate B (whose
    // cells are `cells`) — its one violating pair needs index 6 (the
    // carpark) only on the `cells` side. A compound mutation dropping the
    // carpark from BOTH `cells` and `otherCells` is caught through that
    // `cells` half alone; decomposed, `j < otherCells.length - 1` (dropping
    // only the EXISTING destination's carpark) survives, because that
    // fixture's violating `otherCells` index was never 6. This is the exact
    // geometry above with the two destinations' roles swapped, forcing the
    // violating pair's `otherCells` index to be the carpark instead.
    const { map, world } = fixture('dest-spacing-diagonal-carpark-mirrored')
    const state = createState('s', map)
    // Existing (placed first, becomes `otherCells`): origin (3,0),
    // orientation W -> carpark (2,0).
    expect(placeDestination(state, world, destCellFor(3, 0), ORIENTATION_W, 0, DEST_KIND_SQUARE)).toBe(true)
    // Candidate (becomes `cells`): origin (0,1), orientation N -> footprint
    // includes (1,1). Closest pair: candidate's FOOTPRINT (1,1) to
    // existing's CARPARK (2,0) — Chebyshev 1 (rejected). Candidate's own
    // carpark (0,0) is at distance 2 from every existing cell (checked by
    // hand: (0,0)-(2,0) is dx=2; (0,0)-(3,0) is dx=3), so this violation
    // cannot be found without comparing against the EXISTING destination's
    // carpark specifically.
    expect(canPlaceDestination(state, world, destCellFor(0, 1), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'spacing',
    })
  })

  it('accepts a vertically-separated destination sharing a column, where an x-only metric would wrongly reject', () => {
    const { map, world } = fixture('dest-spacing-vertical-accept')
    const state = createState('s', map)
    // A: origin (0,0), orientation E -> footprint (0,0),(1,0),(2,0),(0,1),
    // (1,1),(2,1); carpark (3,0). Occupies rows 0-1.
    expect(placeDestination(state, world, destCellFor(0, 0), ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    // B: origin (0,4), orientation E -> footprint rows 4-5, same columns
    // 0-2 as A. Every same-column pair (e.g. A's (0,1) to B's (0,4)) has
    // dx=0, so an x-only distance metric reports 0 (< 2) and would reject
    // this — but the true Chebyshev minimum is dy=4-1=3 (A's max row is 1,
    // B's min row is 4), so the real rule correctly accepts it.
    expect(canPlaceDestination(state, world, destCellFor(0, 4), ORIENTATION_E)).toEqual({ ok: true })
  })

  it('rejects a footprint cell on an existing house, with reason building', () => {
    const { map, world } = fixture('dest-vs-house')
    const state = createState('s', map)
    expect(placeHouse(state, world, destCellFor(4, 2), 0)).toBe(true)
    expect(canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'building',
    })
  })

  /**
   * **A house sitting on the CANDIDATE's carpark, which is the asymmetric half
   * of the house-overlap check and had no test.**
   *
   * Two tests look like they cover this and neither does: "rejects a footprint
   * cell on an existing house" puts the house on a FOOTPRINT cell, and "rejects
   * a cell on an existing destination's carpark" is `canPlaceHouse` asking the
   * question in the other direction. Nothing asked whether
   * `canPlaceDestination` looks at its own carpark for a house.
   *
   * Found by this task's own mutation battery: dropping
   * `cellOverlapsAnyHouse(state, carpark)` survived all 1,661 tests, and the
   * consequence is not a wrong reason code — the placement is **accepted**, and
   * a destination is built with its carpark on top of a house. Same shape as
   * the `carparkCell` defect this file already carries two tests for, and the
   * catalogue's "a compound mutation being caught does not mean each half is":
   * the retired implementation checked all 7 cells in one loop, so the gap is
   * older than the rewrite and the rewrite is what exposed it.
   */
  it('rejects a house sitting on the candidate\'s own CARPARK cell, with reason building', () => {
    const { map, world } = fixture('dest-vs-house-on-carpark')
    const state = createState('s', map)
    const cp = carparkCell(destCellFor(3, 1), ORIENTATION_N, W, H)
    expect(cp).toBe(destCellFor(3, 0))
    expect(placeHouse(state, world, cp, 0)).toBe(true)
    // Vacuity: every FOOTPRINT cell is clear, so only the carpark comparison
    // can produce this answer — without it the placement is accepted outright.
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        expect(canPlaceHouse(state, world, destCellFor(3 + dx, 1 + dy)), `footprint (${3 + dx},${1 + dy})`).toEqual({
          ok: true,
        })
      }
    }
    expect(canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'building',
    })
    expect(placeDestination(state, world, destCellFor(3, 1), ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(false)
    expect(state.header[H_DEST_COUNT]).toBe(0)
  })

  /**
   * **The carpark's participation in EVERY cell pass, as a class rather than
   * one case at a time.**
   *
   * `canPlaceDestination` walks seven cells four times over — terrain, tree,
   * road, house-overlap — and the carpark is the seventh cell in all four. The
   * retired implementation got that for free: `allSevenCells` put the carpark
   * at index 6 and every pass was one loop over the array. The rewrite gives
   * each pass its own explicit `carpark` line, which is faster and clearer and
   * means **four separate lines can now be deleted independently**.
   *
   * This task's mutation battery deleted all four. `road` was killed by the
   * pre-existing test two blocks up; `building` by the test above, which this
   * task added. **`terrain` and `tree` both SURVIVED all 1,663 tests**, and
   * neither is a wrong reason code — the placement is accepted, and a
   * destination is built with its carpark on open water or under a standing
   * tree. Note that `passable` is 1 for TREE, so the terrain pass cannot stand
   * in for the tree pass or vice versa.
   *
   * Deliberately overlapping with the two single-case tests, and that is the
   * point: the catalogue's "when you fix an instance, name the class and search
   * for its siblings". The single cases document their own defect history; this
   * one fails if a FIFTH pass is ever added without carpark coverage. Do not
   * delete either on the strength of the other.
   */
  it('checks the CARPARK cell in every pass, not only the footprint — terrain, tree, road, building', () => {
    const origin = destCellFor(3, 1) // N: footprint x{3,4} y{1,2,3}
    const cp = destCellFor(3, 0)
    expect(carparkCell(origin, ORIENTATION_N, W, H), 'the fixture geometry').toBe(cp)
    const holed = (id: string, ch: string) => {
      const out: string[] = ROWS.map((r) => r as string)
      out[0] = (out[0] as string).slice(0, 3) + ch + (out[0] as string).slice(4)
      const map = parseMap(id, out, 50, 40, 16, 5)
      const world = createWorld(map)
      return { world, state: createState('s', map) }
    }

    const water = holed('carpark-pass-terrain', '~')
    expect(water.world.passable[cp], 'the carpark really is impassable').toBe(0)
    expect(canPlaceDestination(water.state, water.world, origin, ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'terrain',
    })

    const tree = holed('carpark-pass-tree', 'T')
    // The discriminator against "the terrain pass already covers it": a TREE
    // cell is passable, so `world.passable[carpark]` is 1 here and only the
    // tree pass can reject this.
    expect(tree.world.passable[cp], 'a tree cell is PASSABLE').toBe(1)
    expect(hasTree(tree.state, tree.world, cp)).toBe(true)
    expect(canPlaceDestination(tree.state, tree.world, origin, ORIENTATION_N)).toEqual({ ok: false, reason: 'tree' })

    const road = fixture('carpark-pass-road')
    const roadState = createState('s', road.map)
    expect(placeRoad(roadState, road.world, cp, cp + 1)).toBe(true)
    expect(canPlaceDestination(roadState, road.world, origin, ORIENTATION_N)).toEqual({ ok: false, reason: 'road' })

    const house = fixture('carpark-pass-building')
    const houseState = createState('s', house.map)
    expect(placeHouse(houseState, house.world, cp, 0)).toBe(true)
    expect(canPlaceDestination(houseState, house.world, origin, ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'building',
    })

    // Vacuity: with the carpark clear and nothing else changed, the SAME origin
    // is accepted — so each rejection above is the carpark cell talking and not
    // some property of the fixture.
    const clean = fixture('carpark-pass-control')
    expect(canPlaceDestination(createState('s', clean.map), clean.world, origin, ORIENTATION_N)).toEqual({ ok: true })
  })

  /**
   * **The rejection ORDER, pinned where two reasons hold at once — which is the
   * only place it is observable.**
   *
   * `canPlaceDestination` documents its order as out-of-bounds, terrain, tree,
   * road, spacing, building, capacity, and Task 4's rewrite had to preserve it.
   * Every pre-existing test arranges exactly ONE defect, so every one of them
   * is order-blind: swapping the terrain and tree passes survived all 1,661
   * tests, found by this task's mutation battery.
   *
   * Note why per-CELL reasoning is not enough here, because it is the trap:
   * `world.passable` is 1 for LAND *and* TREE, so no single cell can be both
   * non-passable and treed, and the two conditions look mutually exclusive.
   * They are — per cell. The passes run over a **set** of seven cells, so water
   * in one and a tree in another is reachable, and that is what makes the order
   * observable at all.
   *
   * Each pair is asserted twice: the composite fixture, where both conditions
   * hold and the higher-priority reason must win, and a control with only the
   * lower one, so a composite that silently lost its lower condition cannot
   * pass for the wrong reason.
   */
  it('returns the FIRST applicable reason when several apply — terrain, tree, road, spacing, building, capacity', () => {
    const origin = destCellFor(3, 1) // N: footprint x{3,4} y{1,2,3}, carpark (3,0)
    const rows = (edits: ReadonlyArray<readonly [number, number, string]>): string[] => {
      const out: string[] = ROWS.map((r) => r as string)
      for (const [x, y, ch] of edits) out[y] = (out[y] as string).slice(0, x) + ch + (out[y] as string).slice(x + 1)
      return out
    }
    const at = (id: string, edits: ReadonlyArray<readonly [number, number, string]>, maxDest = 16) => {
      const map = parseMap(id, rows(edits), 50, 40, maxDest, 5)
      const world = createWorld(map)
      return { map, world, state: createState('s', map) }
    }

    // terrain BEFORE tree: water at (4,3), tree at (3,2) — different cells of
    // the same footprint, which is the only way both can hold.
    const a = at('order-terrain-tree', [
      [4, 3, '~'],
      [3, 2, 'T'],
    ])
    expect(hasTree(a.state, a.world, destCellFor(3, 2)), 'the tree really is there').toBe(true)
    expect(canPlaceDestination(a.state, a.world, origin, ORIENTATION_N), 'terrain must win over tree').toEqual({
      ok: false,
      reason: 'terrain',
    })
    const aCtl = at('order-tree-only', [[3, 2, 'T']])
    expect(canPlaceDestination(aCtl.state, aCtl.world, origin, ORIENTATION_N), 'control: tree alone').toEqual({
      ok: false,
      reason: 'tree',
    })

    // tree BEFORE road: tree at (3,2), road on (4,1).
    const b = at('order-tree-road', [[3, 2, 'T']])
    expect(placeRoad(b.state, b.world, destCellFor(4, 1), destCellFor(4, 0))).toBe(true)
    expect(canPlaceDestination(b.state, b.world, origin, ORIENTATION_N), 'tree must win over road').toEqual({
      ok: false,
      reason: 'tree',
    })
    const bCtl = at('order-road-only', [])
    expect(placeRoad(bCtl.state, bCtl.world, destCellFor(4, 1), destCellFor(4, 0))).toBe(true)
    expect(canPlaceDestination(bCtl.state, bCtl.world, origin, ORIENTATION_N), 'control: road alone').toEqual({
      ok: false,
      reason: 'road',
    })

    // road BEFORE spacing: an incumbent at (3,1) puts (5,1) at Chebyshev 1, and
    // a road inside (5,1)'s own footprint.
    const second = destCellFor(5, 1)
    const c = at('order-road-spacing', [])
    expect(placeDestination(c.state, c.world, origin, ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeRoad(c.state, c.world, destCellFor(5, 3), destCellFor(6, 3))).toBe(true)
    expect(canPlaceDestination(c.state, c.world, second, ORIENTATION_N), 'road must win over spacing').toEqual({
      ok: false,
      reason: 'road',
    })
    const cCtl = at('order-spacing-only', [])
    expect(placeDestination(cCtl.state, cCtl.world, origin, ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(canPlaceDestination(cCtl.state, cCtl.world, second, ORIENTATION_N), 'control: spacing alone').toEqual({
      ok: false,
      reason: 'spacing',
    })

    // spacing BEFORE building: the same too-close candidate, with a house
    // inside its footprint.
    const d = at('order-spacing-building', [])
    expect(placeDestination(d.state, d.world, origin, ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeHouse(d.state, d.world, destCellFor(5, 2), 0)).toBe(true)
    expect(canPlaceDestination(d.state, d.world, second, ORIENTATION_N), 'spacing must win over building').toEqual({
      ok: false,
      reason: 'spacing',
    })
    const dCtl = at('order-building-only', [])
    expect(placeHouse(dCtl.state, dCtl.world, destCellFor(5, 2), 0)).toBe(true)
    expect(canPlaceDestination(dCtl.state, dCtl.world, second, ORIENTATION_N), 'control: building alone').toEqual({
      ok: false,
      reason: 'building',
    })

    // building BEFORE capacity: a full board AND a house in the footprint.
    const e = at('order-building-capacity', [], 1)
    expect(placeDestination(e.state, e.world, destCellFor(0, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(e.state.header[H_DEST_COUNT]).toBe(e.map.maxDestinations)
    expect(placeHouse(e.state, e.world, destCellFor(4, 3), 0)).toBe(true)
    expect(canPlaceDestination(e.state, e.world, destCellFor(3, 3), ORIENTATION_N), 'building beats capacity').toEqual({
      ok: false,
      reason: 'building',
    })
    const eCtl = at('order-capacity-only', [], 1)
    expect(placeDestination(eCtl.state, eCtl.world, destCellFor(0, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(canPlaceDestination(eCtl.state, eCtl.world, destCellFor(3, 3), ORIENTATION_N), 'control: capacity').toEqual({
      ok: false,
      reason: 'capacity',
    })
  })

  it('rejects placement once H_DEST_COUNT === maxDestinations, and does not move the count', () => {
    const { map, world } = fixture('dest-capacity', 40, 2)
    const state = createState('s', map)
    expect(placeDestination(state, world, destCellFor(0, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(state, world, destCellFor(6, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    // Vacuity: genuinely full before the rejection below.
    expect(state.header[H_DEST_COUNT]).toBe(2)
    expect(map.maxDestinations).toBe(2)

    const before = state.header[H_DEST_COUNT]
    // origin (3,3), orientation N: footprint (3,3),(4,3),(3,4),(4,4),(3,5),
    // (4,5), carpark (3,2). Minimum Chebyshev distance to the first
    // destination's 7 cells (max x=1, e.g. (1,2)) is 2 (e.g. (1,2)-(3,2) or
    // (1,2)-(3,3)); to the second's 7 cells (min x=6, e.g. (6,2)) is also 2
    // (e.g. (6,2)-(4,3) or (6,2)-(4,4)) — both computed by hand, both
    // spatially valid (>= 2), so only capacity can reject this placement.
    expect(canPlaceDestination(state, world, destCellFor(3, 3), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'capacity',
    })
    expect(placeDestination(state, world, destCellFor(3, 3), ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(false)
    expect(state.header[H_DEST_COUNT]).toBe(before)
  })

  it('throws for a destination colour outside this map’s group count, and places nothing', () => {
    // The mirror of the house guard above. `packDestMeta` validates colour
    // only against its 3-bit field [0, 7], so colours 5-7 pass it on a 5-group
    // map and would then be dropped in silence by `computeSlotCounts` and
    // `assembleSources` — an out-of-range typed-array write is a no-op, so
    // that destination would never request a car and never seed a field.
    const { map, world } = fixture('dest-colour-range')
    const state = createState('s', map)
    expect(map.groupCount).toBe(5)

    expect(() => placeDestination(state, world, destCellFor(0, 0), ORIENTATION_S, 5, DEST_KIND_SQUARE)).toThrow(
      /colour must be an integer in \[0, 5\)/,
    )
    expect(() => placeDestination(state, world, destCellFor(0, 0), ORIENTATION_S, 8, DEST_KIND_SQUARE)).toThrow(
      /colour must be an integer in \[0, 5\)/,
    )
    expect(state.header[H_DEST_COUNT]).toBe(0)

    // Vacuity: the boundary value itself is accepted.
    expect(placeDestination(state, world, destCellFor(0, 0), ORIENTATION_S, 4, DEST_KIND_SQUARE)).toBe(true)
    expect(destMetaColour(state.destMeta[0] as number)).toBe(4)
  })
})

describe('grid-edge bounds guards (review finding I2)', () => {
  // The brief's own validity list opens with "all in bounds", but no test
  // exercised `reason: 'out-of-bounds'` at all before this block. Two of the
  // mutations below are real escapes, not just wrong reason codes: dropping
  // `cx >= w` from `carparkCell` (or the x-box test in `allSevenCells`) lets
  // `canPlaceDestination` ACCEPT a destination whose carpark silently wraps
  // to the next row — exactly the row-seam self-blindness `carparkCell`'s
  // own doc comment says it guards against.

  it('rejects out-of-bounds when the CARPARK alone falls off the grid, one case per orientation', () => {
    const { map, world } = fixture('bounds-carpark-only')
    const state = createState('s', map)
    // N: origin (2,0) -> footprint y{0,1,2} fits (h=6); carpark y=-1 does not.
    expect(canPlaceDestination(state, world, destCellFor(2, 0), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    })
    // S: origin (3,3) -> footprint y{3,4,5} fits (h=6); carpark y=6 does not.
    expect(canPlaceDestination(state, world, destCellFor(3, 3), ORIENTATION_S)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    })
    // E: origin (6,2) -> footprint x{6,7,8} fits (w=9); carpark x=9 does not.
    expect(canPlaceDestination(state, world, destCellFor(6, 2), ORIENTATION_E)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    })
    // W: origin (0,2) -> footprint x{0,1,2} fits (w=9); carpark x=-1 does not.
    expect(canPlaceDestination(state, world, destCellFor(0, 2), ORIENTATION_W)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    })
  })

  it('rejects out-of-bounds when the FOOTPRINT BOX itself would overhang the grid, in x and in y', () => {
    const { map, world } = fixture('bounds-footprint-overhang')
    const state = createState('s', map)
    // N at x0=8 (w=9): footprint needs columns {8,9} — column 9 does not
    // exist. This is the mutation the review calls a real escape: without
    // this box test, 3 of the 6 footprint cells silently wrap to column 0
    // of the next row instead of being rejected.
    expect(canPlaceDestination(state, world, destCellFor(8, 1), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    })
    // E at y0=5 (h=6): footprint needs rows {5,6} — row 6 does not exist.
    expect(canPlaceDestination(state, world, destCellFor(0, 5), ORIENTATION_E)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    })
  })

  it('rejects out-of-bounds at cell === world.cells, not "terrain" (inBounds must use < , not <=)', () => {
    const { map, world } = fixture('bounds-inclusive-upper')
    const state = createState('s', map)
    // One past the very last valid cell index. Under an `inBounds` that used
    // `cell <= cells`, this would fall through to a `world.passable[cells]`
    // read (`undefined`), reporting 'terrain' instead of 'out-of-bounds'.
    expect(canPlaceHouse(state, world, world.cells)).toEqual({ ok: false, reason: 'out-of-bounds' })
    expect(canPlaceDestination(state, world, world.cells, ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    })
  })

  /**
   * **`validateOrientation` is the FIRST statement of `canPlaceDestination`,
   * before the `destCell` bounds check, and the second half of this test is the
   * only thing that says so.**
   *
   * Nothing exercised an invalid orientation through `canPlaceDestination` at
   * all before M1e Task 4 (only `packDestMeta` had one). And the obvious test —
   * a valid cell with a bad orientation — cannot pin the prologue, because
   * `carparkCell` validates too and throws the *same message* a few lines
   * later: deleting the prologue leaves it green. The discriminator is an
   * out-of-bounds `destCell` with a bad orientation, where the two orders give
   * different answers — a throw if the orientation is checked first, a returned
   * `out-of-bounds` if the cell is. Same shape as the catalogue's "a negative
   * assertion satisfied by the wrong mechanism", applied to a throw.
   */
  it('checks the orientation BEFORE the cell, so a bad orientation throws even for an out-of-bounds cell', () => {
    const { map, world } = fixture('bounds-orientation-prologue')
    const state = createState('s', map)
    // A valid cell: caught by the prologue, and also by `carparkCell` if the
    // prologue were removed — so this half alone proves nothing about order.
    expect(() => canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_COUNT)).toThrow(
      /orientation must be an integer in \[0, 4\)/,
    )
    expect(() => canPlaceDestination(state, world, destCellFor(3, 1), -1)).toThrow(/orientation must be an integer/)
    expect(() => canPlaceDestination(state, world, destCellFor(3, 1), 1.5)).toThrow(/orientation must be an integer/)
    // The discriminator: the cell is out of bounds AND the orientation is
    // invalid. With the prologue this throws; without it, `inBounds` returns
    // first and the caller gets a plausible `out-of-bounds` for a call that is
    // a programming error.
    expect(() => canPlaceDestination(state, world, world.cells, ORIENTATION_COUNT)).toThrow(
      /orientation must be an integer/,
    )
    expect(() => canPlaceDestination(state, world, -1, 7)).toThrow(/orientation must be an integer/)
  })
})

// ---------------------------------------------------------------------------
// M1e Task 4: the §5.9 spacing rule became box arithmetic, and this is its proof
// ---------------------------------------------------------------------------

/**
 * The pre-M1e implementation, kept HERE and only here, as a one-off migration
 * proof for Task 4's box-arithmetic rewrite. **It is not coverage** — a test
 * that reimplements the thing it checks is a listed defect, and the real
 * coverage is every other `canPlaceDestination` test in this file, all of
 * which are unchanged. Delete this and its one test when the rewrite has been
 * on main for a milestone.
 *
 * **What it deliberately SHARES with the code under test, and why.** It calls
 * the real `footprintWidth`/`footprintHeight`/`carparkCell`, because those are
 * not what Task 4 changed: the rewrite replaced *the comparison* (49 cell pairs
 * against 4 box pairs), not the geometry. Sharing the geometry is what isolates
 * the algorithm change — and it is also why swapping `footprintWidth`'s two
 * shapes is **invisible to this test** (both sides move together) and is killed
 * instead by the four orientation tests above. Measured, not assumed; see the
 * task report's mutation table.
 */
function referenceSevenCells(destCell: number, orientation: number, world: WorldData): number[] | null {
  const width = footprintWidth(orientation)
  const height = footprintHeight(orientation)
  const x0 = destCell % world.w
  const y0 = (destCell / world.w) | 0
  if (x0 < 0 || x0 + width > world.w || y0 < 0 || y0 + height > world.h) return null

  const carpark = carparkCell(destCell, orientation, world.w, world.h)
  if (carpark === -1) return null

  const out: number[] = []
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      out.push((y0 + dy) * world.w + (x0 + dx))
    }
  }
  out.push(carpark)
  return out
}

/** The retired pairwise rule: 49 cell pairs, Chebyshev, reject below 2. */
function referenceSpacingViolated(a: readonly number[], b: readonly number[], w: number): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const ax = (a[i] as number) % w
      const ay = ((a[i] as number) / w) | 0
      const bx = (b[j] as number) % w
      const by = ((b[j] as number) / w) | 0
      const dx = ax > bx ? ax - bx : bx - ax
      const dy = ay > by ? ay - by : by - ay
      if ((dx > dy ? dx : dy) < 2) return true
    }
  }
  return false
}

describe('the box-arithmetic spacing rule is equivalent to the retired pairwise one', () => {
  it('agrees with the retired pairwise implementation, exhaustively, on a non-square grid', () => {
    // Every (origin, orientation) pair on a small non-square grid against every
    // (origin, orientation) incumbent — 4 orientations both sides, which is what
    // an earlier `carparkCell` defect showed a non-square fixture alone does not
    // cover: for E the carpark is `cell + 3` and for W it is `cell - 1`, so `w`
    // vanishes entirely and only N and S read it.
    //
    // 9x7 rather than this file's 9x6: a different height from the rest of the
    // file, so a rewrite that accidentally reads a captured `H` cannot ride on
    // the fixture agreeing with it.
    const map = parseMap(
      'spacing-equivalence',
      ['.........', '.........', '.........', '.........', '.........', '.........', '.........'],
      50,
      40,
      16,
      5,
    )
    const world = createWorld(map)
    expect([world.w, world.h]).toEqual([9, 7])

    let compared = 0
    let violated = 0
    for (let ac = 0; ac < world.cells; ac++) {
      for (let ao = 0; ao < ORIENTATION_COUNT; ao++) {
        const a = referenceSevenCells(ac, ao, world)
        if (a === null) continue
        for (let bc = 0; bc < world.cells; bc++) {
          for (let bo = 0; bo < ORIENTATION_COUNT; bo++) {
            const b = referenceSevenCells(bc, bo, world)
            if (b === null) continue
            compared++
            const expected = referenceSpacingViolated(a, b, world.w)
            if (expected) violated++
            expect(
              spacingViolated(ac, ao, bc, bo, world.w),
              `origins ${ac}/${ao} vs ${bc}/${bo}`,
            ).toBe(expected)
          }
        }
      }
    }
    // Vacuity: the loops must actually have compared something, and both answers
    // must occur — an enumeration where every pair is "violated" proves nothing.
    expect(compared).toBeGreaterThan(1000)
    expect(violated).toBeGreaterThan(0)
    expect(violated).toBeLessThan(compared)
  })
})

// ---------------------------------------------------------------------------
// M1e Task 4: both predicates return module-scope frozen singletons
// ---------------------------------------------------------------------------

interface PlaceCase {
  readonly name: string
  readonly expected: PlaceCheck
  readonly call: () => PlaceCheck
}

/**
 * Every `return` SITE both predicates have, as a zero-argument call — **21 of
 * them, not 15, and the difference is the whole point.**
 *
 * The list was first written per *reason*: eight outcomes from
 * `canPlaceDestination`, seven from `canPlaceHouse`. That is the right list for
 * asserting behaviour and the wrong one for asserting allocation, because the
 * unit an editor can revert to a literal is a **`return` statement**, and six
 * statements were reachable only through a case this list did not have. Task
 * 4's reviewer swept all 21 one at a time: 15 turned something red and **six
 * did not — five of them the carpark line of a cell pass, and the sixth a
 * second `B_OOB` site.** Every miss was the same class this file had already
 * found and closed for behaviour two blocks up, carried across with `toEqual`,
 * which cannot see identity.
 *
 * So the naming is deliberate: `dest terrain` and `dest terrain (carpark)` are
 * the same outcome from different statements, and a list keyed on outcomes
 * cannot express that. **If a rejection reason ever gains another `return`,
 * add a case here or that statement is unpinned.**
 *
 * Each case owns its fixture. `roads.test.ts` builds most of its eight from one
 * board; that is not available here, because `capacity` needs a full board and
 * `ok` needs a board with room, and the two cannot be the same state.
 */
function everyPlaceOutcome(): PlaceCase[] {
  const cases: PlaceCase[] = []
  const add = (name: string, expected: PlaceCheck, call: () => PlaceCheck): void => {
    cases.push({ name, expected, call })
  }
  const holed = (id: string, ch: string, row: number, col: number) => {
    const rows = ROWS.map((r, y) => (y === row ? r.slice(0, col) + ch + r.slice(col + 1) : r))
    const map = parseMap(id, rows as string[], 50, 40, 16, 5)
    return { map, world: createWorld(map) }
  }

  // --- canPlaceDestination, all eight ---
  {
    const { map, world } = fixture('sgl-dest-ok')
    const state = createState('s', map)
    add('dest ok', { ok: true }, () => canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N))
    add('dest out-of-bounds', { ok: false, reason: 'out-of-bounds' }, () =>
      canPlaceDestination(state, world, world.cells, ORIENTATION_N),
    )
    // **Per SITE, not per reason** — see the block comment below. `B_OOB` is
    // returned from three different lines and the case above reaches only the
    // first: origin (8,1) overhangs the grid in x with an in-range `destCell`,
    // and origin (2,0) fits its box but wants a carpark at y = -1.
    add('dest out-of-bounds (footprint overhang)', { ok: false, reason: 'out-of-bounds' }, () =>
      canPlaceDestination(state, world, destCellFor(8, 1), ORIENTATION_N),
    )
    add('dest out-of-bounds (carpark off grid)', { ok: false, reason: 'out-of-bounds' }, () =>
      canPlaceDestination(state, world, destCellFor(2, 0), ORIENTATION_N),
    )
  }
  // The carpark half of each cell pass. Same four fixtures as the carpark sweep
  // test above, asked the other question: that test uses `toEqual`, which
  // cannot see identity, so it carried the class across for BEHAVIOUR and left
  // these four `return` sites unpinned for allocation.
  {
    const { map, world } = holed('sgl-dest-terrain-carpark', '~', 0, 3)
    const state = createState('s', map)
    add('dest terrain (carpark)', { ok: false, reason: 'terrain' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N),
    )
  }
  {
    const { map, world } = holed('sgl-dest-tree-carpark', 'T', 0, 3)
    const state = createState('s', map)
    add('dest tree (carpark)', { ok: false, reason: 'tree' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N),
    )
  }
  {
    const { map, world } = fixture('sgl-dest-road-carpark')
    const state = createState('s', map)
    expect(placeRoad(state, world, destCellFor(3, 0), destCellFor(4, 0))).toBe(true)
    add('dest road (carpark)', { ok: false, reason: 'road' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N),
    )
  }
  {
    const { map, world } = fixture('sgl-dest-building-carpark')
    const state = createState('s', map)
    expect(placeHouse(state, world, destCellFor(3, 0), 0)).toBe(true)
    add('dest building (carpark)', { ok: false, reason: 'building' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N),
    )
  }
  {
    const { map, world } = holed('sgl-dest-terrain', '~', 2, 4)
    const state = createState('s', map)
    add('dest terrain', { ok: false, reason: 'terrain' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N),
    )
  }
  {
    const { map, world } = holed('sgl-dest-tree', 'T', 2, 4)
    const state = createState('s', map)
    add('dest tree', { ok: false, reason: 'tree' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N),
    )
  }
  {
    const { map, world } = fixture('sgl-dest-road')
    const state = createState('s', map)
    expect(placeRoad(state, world, destCellFor(4, 2), destCellFor(4, 1))).toBe(true)
    add('dest road', { ok: false, reason: 'road' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N),
    )
  }
  {
    const { map, world } = fixture('sgl-dest-spacing')
    const state = createState('s', map)
    expect(placeDestination(state, world, destCellFor(3, 1), ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    add('dest spacing', { ok: false, reason: 'spacing' }, () =>
      canPlaceDestination(state, world, destCellFor(5, 1), ORIENTATION_N),
    )
  }
  {
    const { map, world } = fixture('sgl-dest-building')
    const state = createState('s', map)
    expect(placeHouse(state, world, destCellFor(4, 2), 0)).toBe(true)
    add('dest building', { ok: false, reason: 'building' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N),
    )
  }
  {
    const { map, world } = fixture('sgl-dest-capacity', 40, 2)
    const state = createState('s', map)
    expect(placeDestination(state, world, destCellFor(0, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(state, world, destCellFor(6, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    add('dest capacity', { ok: false, reason: 'capacity' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 3), ORIENTATION_N),
    )
  }

  // --- canPlaceHouse, all seven (it has no spacing rule of its own) ---
  {
    const { map, world } = fixture('sgl-house-ok')
    const state = createState('s', map)
    add('house ok', { ok: true }, () => canPlaceHouse(state, world, 10))
    add('house out-of-bounds', { ok: false, reason: 'out-of-bounds' }, () =>
      canPlaceHouse(state, world, world.cells),
    )
  }
  {
    const { map, world } = holed('sgl-house-terrain', '~', 0, 1)
    const state = createState('s', map)
    add('house terrain', { ok: false, reason: 'terrain' }, () => canPlaceHouse(state, world, 1))
  }
  {
    const { map, world } = holed('sgl-house-tree', 'T', 0, 1)
    const state = createState('s', map)
    add('house tree', { ok: false, reason: 'tree' }, () => canPlaceHouse(state, world, 1))
  }
  {
    const { map, world } = fixture('sgl-house-road')
    const state = createState('s', map)
    expect(placeRoad(state, world, 10, 11)).toBe(true)
    add('house road', { ok: false, reason: 'road' }, () => canPlaceHouse(state, world, 10))
  }
  {
    const { map, world } = fixture('sgl-house-building')
    const state = createState('s', map)
    expect(placeHouse(state, world, 10, 0)).toBe(true)
    add('house building', { ok: false, reason: 'building' }, () => canPlaceHouse(state, world, 10))
  }
  {
    const { map, world } = fixture('sgl-house-capacity', 2, 16)
    const state = createState('s', map)
    expect(placeHouse(state, world, 0, 0)).toBe(true)
    expect(placeHouse(state, world, 1, 0)).toBe(true)
    add('house capacity', { ok: false, reason: 'capacity' }, () => canPlaceHouse(state, world, 2))
  }

  // --- the M1f Task 9 refusal: three sites, one per `return B_UPGRADE` ---
  {
    const { map, world } = fixture('sgl-house-upgrade')
    const state = createState('s', map)
    upgradedBareCell(state, world, 10, [9, 11, 1])
    add('house upgrade', { ok: false, reason: 'upgrade' }, () => canPlaceHouse(state, world, 10))
  }
  {
    // **A NON-CENTRE footprint cell, deliberately.** The origin of this
    // destination is (3,1) and the upgrade goes on (4,3) — the far corner of the
    // 2x3 footprint — so a check that reads `destCell` alone, or reads only the
    // first cell of the pass, scores a detector here rather than nowhere.
    const { map, world } = fixture('sgl-dest-upgrade')
    const state = createState('s', map)
    const corner = destCellFor(4, 3)
    upgradedBareCell(state, world, corner, [corner - 1, corner + 1, corner - W])
    add('dest upgrade', { ok: false, reason: 'upgrade' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N),
    )
  }
  {
    // The carpark half, on the same precedent as the four carpark cases above:
    // it is a separate `return` site and the footprint pass never visits it.
    const { map, world } = fixture('sgl-dest-upgrade-carpark')
    const state = createState('s', map)
    const cp = carparkCell(destCellFor(3, 1), ORIENTATION_N, W, H)
    expect(cp, 'the fixture has a carpark on the grid').toBeGreaterThanOrEqual(0)
    upgradedBareCell(state, world, cp, [cp - 1, cp + 1, cp + W])
    add('dest upgrade (carpark)', { ok: false, reason: 'upgrade' }, () =>
      canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N),
    )
  }
  return cases
}


// ---------------------------------------------------------------------------
// Nothing is built on an upgraded cell — M1f Task 9, spec 5.9
// ---------------------------------------------------------------------------

/**
 * **The reachable path is narrow and real, and the fixture drives all of it.**
 * An upgrade's cell has road at placement time and §5.9 says nothing spawns on
 * road, so for as long as the road stands the road check already refuses. What
 * the player can do is erase every road at the cell — at which point the spawner
 * sees bare ground with an upgrade on it, and a house under an upgrade would be
 * undrawable and unexplainable.
 *
 * `B_UPGRADE` and not `B_BUILDING`: the previous draft of this task reused the
 * building code, which is this module's own *"a function with more than two ways
 * to decline puts the reason in the signature"* broken at the site that states
 * it. A caller that logs "there is a building here" about an empty cell sends the
 * next reader to the wrong file.
 */
describe('a cell carrying a junction upgrade is not buildable (M1f Task 9)', () => {
  it('refuses a HOUSE on bare ground that still carries the flag', () => {
    const { map, world } = fixture('up-house')
    const state = createState('s', map)
    upgradedBareCell(state, world, 10, [9, 11, 1])
    expect(canPlaceHouse(state, world, 10)).toEqual({ ok: false, reason: 'upgrade' })
    expect(placeHouse(state, world, 10, 0), 'and the placement itself refuses').toBe(false)
    expect(state.header[H_HOUSE_COUNT]).toBe(0)
  })

  it('refuses a DESTINATION whose FOOTPRINT covers one, at a cell that is not its origin', () => {
    const { map, world } = fixture('up-dest-footprint')
    const state = createState('s', map)
    const corner = destCellFor(4, 3)
    upgradedBareCell(state, world, corner, [corner - 1, corner + 1, corner - W])
    expect(canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'upgrade',
    })
    expect(
      placeDestination(state, world, destCellFor(3, 1), ORIENTATION_N, 0, DEST_KIND_SQUARE),
    ).toBe(false)
    expect(state.header[H_DEST_COUNT]).toBe(0)
  })

  it('refuses a DESTINATION whose CARPARK covers one — the seventh cell, which the footprint pass never visits', () => {
    const { map, world } = fixture('up-dest-carpark')
    const state = createState('s', map)
    const cp = carparkCell(destCellFor(3, 1), ORIENTATION_N, W, H)
    upgradedBareCell(state, world, cp, [cp - 1, cp + 1, cp + W])
    expect(canPlaceDestination(state, world, destCellFor(3, 1), ORIENTATION_N)).toEqual({
      ok: false,
      reason: 'upgrade',
    })
  })

  it('still names ROAD, not the upgrade, while the junction is still standing', () => {
    // The truthful reason at the moment a player asks. An upgraded cell that
    // still has its roads is refused by the road check first, which is right:
    // *the road* is what a player would have to remove, and it is the reason
    // §5.9 gives. This is the case that says the new check sits BEHIND the road
    // check rather than in front of it.
    const { map, world } = fixture('up-still-roaded')
    const state = createState('s', map)
    for (const arm of [9, 11, 1]) expect(placeRoad(state, world, 10, arm)).toBe(true)
    state.header[H_INV_UPGRADES] = 1
    expect(applyPlaceUpgrade(state, world, 10)).toBe(true)
    expect(canPlaceHouse(state, world, 10)).toEqual({ ok: false, reason: 'road' })
  })

  it('leaves every OTHER cell buildable — the refusal is per cell, not per board', () => {
    // A board with an upgrade on it is not a board nothing can be built on. The
    // mutant this exists for reads `H_UPGRADE_COUNT` rather than the cell's flag.
    const { map, world } = fixture('up-elsewhere')
    const state = createState('s', map)
    upgradedBareCell(state, world, 10, [9, 11, 1])
    expect(canPlaceHouse(state, world, 40)).toEqual({ ok: true })
    expect(placeHouse(state, world, 40, 0)).toBe(true)
  })
})

/**
 * **`canPlaceDestination` and `canPlaceHouse` return module-scope frozen
 * singletons, and THIS is what pins them — not the allocation profiler.**
 *
 * The task brief said the singleton half of Task 4 has
 * `packages/game/test/demoAllocation.test.ts` as its only detector, "because no
 * existing test compares a `PlaceCheck` by identity". The first clause was
 * true and the conclusion did not follow: the in-repo precedent the brief cites
 * for the *fix* (`roads.ts:303-319`) also has a precedent for the *test*
 * (`roads.test.ts`, "canPlaceRoad allocates nothing per call"), and it is
 * strictly better than a profiler for this property. Identity is deterministic,
 * it is checkable in the package that owns the code, and it covers all eight
 * outcomes rather than the ones some driver happens to reach. Reverting any
 * single `return` to an object literal turns exactly one of these red.
 *
 * It is also the only detector that WORKS. Measured on this tree: with an
 * escaping allocation injected at the top of both predicates, `buildings.ts` is
 * **absent from the demo frame profile in 9 of 9 windows** — neither function
 * has a per-frame caller until Task 5, so the harness the brief named cannot
 * see this change at all. See the task report, and
 * `packages/game/test/placementAllocation.test.ts` for the per-call rig that
 * can.
 *
 * Frozen-ness is the other half and it is not decoration: a shared instance a
 * caller can scribble on is a worse defect than the allocation was, because the
 * next caller sees the scribble. `PlaceCheck` is `readonly` in the type system,
 * which stops nothing at run time.
 */
describe('placement validity allocates nothing per call — frozen singletons', () => {
  it('the case list really does reach all eight outcomes, or every assertion below is about a subset', () => {
    // Vacuity first: a `cases` list whose entries silently produced the same
    // refusal would satisfy "frozen" and "stable" while proving nothing.
    const cases = everyPlaceOutcome()
    for (const { name, expected, call } of cases) {
      expect(call(), name).toEqual(expected)
    }
    // One case per `return` statement in the two predicates. Counted, because
    // the list being SHORTER than the code is exactly how six sites went
    // unpinned: `grep -c 'return B_' packages/sim/src/buildings.ts` is 21.
    // 21 until M1f Task 9, which adds three `return B_UPGRADE` sites: one in
    // `canPlaceHouse` and two in `canPlaceDestination` (the footprint pass and
    // the carpark).
    expect(cases.length, 'one case per return SITE — see the block comment').toBe(24)
    expect(new Set(cases.map((c) => (c.expected.ok ? 'ok' : c.expected.reason))).size).toBe(9)
  })

  it('returns a FROZEN value for every outcome, so one caller cannot scribble on the next caller’s answer', () => {
    for (const { name, call } of everyPlaceOutcome()) {
      expect(Object.isFrozen(call()), `${name} is not frozen`).toBe(true)
    }
  })

  it('returns the SAME instance for a repeated outcome — the deterministic form of "allocates nothing"', () => {
    for (const { name, call } of everyPlaceOutcome()) {
      expect(call(), `${name} allocated a fresh object`).toBe(call())
    }
  })

  it('gives DIFFERENT outcomes different instances, and the two predicates SHARE them', () => {
    const cases = everyPlaceOutcome()
    const seen = new Set<PlaceCheck>()
    for (const { call } of cases) seen.add(call())
    // Exactly 9 distinct instances across 24 calls: the singletons are neither
    // one collapsed object (which would be 1) nor per-call literals (24), and
    // `canPlaceHouse` and `canPlaceDestination` return the same instance for
    // the same reason rather than keeping two parallel tables that can drift.
    // 8 until M1f Task 9 added `B_UPGRADE`, which both predicates share — and
    // the sharing is asserted below rather than assumed.
    expect(seen.size).toBe(9)
    const byName = new Map(cases.map((c) => [c.name, c.call]))
    for (const reason of ['ok', 'out-of-bounds', 'terrain', 'tree', 'road', 'building', 'capacity', 'upgrade']) {
      expect(byName.get(`dest ${reason}`)!(), `dest/house ${reason} are different instances`).toBe(
        byName.get(`house ${reason}`)!(),
      )
    }
  })

  it('a caller cannot corrupt the shared instance, and a later independent call is unaffected', () => {
    const { map, world } = fixture('sgl-no-scribble')
    const state = createState('s', map)
    const first = canPlaceDestination(state, world, world.cells, ORIENTATION_N)
    expect(first).toEqual({ ok: false, reason: 'out-of-bounds' })

    /**
     * **This test repairs its own damage, and that is not tidiness.** The thing
     * it attempts is a write to a MODULE-SCOPE singleton. Under the mutation it
     * exists to catch — a missing `Object.freeze` — the write succeeds, and a
     * corrupted value then leaks into every later test in this file, inflating
     * the detector count with unrelated failures. `roads.test.ts` measured that
     * exact effect at 9 failures of which only 2 were detectors.
     */
    const before = (first as { reason: string }).reason
    let threw: unknown = null
    try {
      ;(first as { reason: string }).reason = 'terrain'
    } catch (e) {
      threw = e
    }
    if ((first as { reason: string }).reason !== before) (first as { reason: string }).reason = before

    // ESM is strict mode, so a write to a frozen property throws rather than
    // failing silently. Both halves matter: the throw, and the value after it.
    expect(threw, 'the shared result accepted a write — the singleton is not frozen').toBeInstanceOf(TypeError)
    expect(canPlaceHouse(state, world, world.cells)).toEqual({ ok: false, reason: 'out-of-bounds' })
  })
})

describe('car creation on house placement (Task 2\'s job, not Task 4\'s)', () => {
  it('a fresh state has zero houses, zero destinations and zero live cars', () => {
    const { map } = fixture('fresh-zero')
    const state = createState('s', map)
    expect(state.header[H_HOUSE_COUNT]).toBe(0)
    expect(state.header[H_DEST_COUNT]).toBe(0)
    expect(Array.from(state.carPhase).every((p) => p === PHASE_NONE)).toBe(true)
    expect(() => houseAt(state, 0)).toThrow()
    expect(() => destAt(state, 0)).toThrow()
  })

  it('placing a house creates exactly CARS_PER_HOUSE idle cars at the house cell with carTargetDest === -1', () => {
    const { map, world } = fixture('car-creation')
    const state = createState('s', map)
    const cell = 10
    expect(placeHouse(state, world, cell, 3)).toBe(true)
    for (let i = 0; i < CARS_PER_HOUSE; i++) {
      expect(state.carHome[i], `carHome[${i}]`).toBe(0)
      expect(state.carCell[i], `carCell[${i}]`).toBe(cell)
      expect(state.carPhase[i], `carPhase[${i}]`).toBe(PHASE_IDLE)
      expect(state.carTargetDest[i], `carTargetDest[${i}]`).toBe(-1)
      expect(state.carProgress[i], `carProgress[${i}]`).toBe(0)
      expect(state.carRouteLen[i], `carRouteLen[${i}]`).toBe(0)
      expect(state.carRouteCursor[i], `carRouteCursor[${i}]`).toBe(0)
    }
    // No phantom cars beyond this house's slots.
    for (let i = CARS_PER_HOUSE; i < state.carPhase.length; i++) {
      expect(state.carPhase[i], `carPhase[${i}]`).toBe(PHASE_NONE)
    }
  })

  it('a second house gets its own car slots, offset by CARS_PER_HOUSE, and counts track', () => {
    const { map, world } = fixture('car-creation-second-house')
    const state = createState('s', map)
    expect(placeHouse(state, world, 0, 0)).toBe(true)
    expect(placeHouse(state, world, 1, 1)).toBe(true)
    expect(state.header[H_HOUSE_COUNT]).toBe(2)
    expect(houseAt(state, 0)).toBe(0)
    expect(houseAt(state, 1)).toBe(1)
    for (let i = CARS_PER_HOUSE; i < 2 * CARS_PER_HOUSE; i++) {
      expect(state.carHome[i]).toBe(1)
      expect(state.carCell[i]).toBe(1)
      expect(state.carPhase[i]).toBe(PHASE_IDLE)
      expect(state.carTargetDest[i]).toBe(-1)
    }
  })
})

describe('houseAt / destAt live-prefix accessors', () => {
  it('throw for an index >= the live count, even when the underlying array slot exists and is zero', () => {
    const { map, world } = fixture('accessors-throw')
    const state = createState('s', map)
    expect(placeHouse(state, world, 5, 0)).toBe(true)
    expect(houseAt(state, 0)).toBe(5)
    expect(() => houseAt(state, 1)).toThrow(/H_HOUSE_COUNT/)
    expect(() => houseAt(state, -1)).toThrow()

    expect(placeDestination(state, world, destCellFor(3, 1), ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(destAt(state, 0)).toBe(destCellFor(3, 1))
    expect(() => destAt(state, 1)).toThrow(/H_DEST_COUNT/)
    expect(() => destAt(state, -1)).toThrow()
  })
})

describe('the driveway rule — dist[houseCell] reflects whether the house has a road', () => {
  function buildFieldRig(map: MapData, world: WorldData) {
    const fields = createFlowFields(map.groupCount, world.cells)
    const scratch = createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map))
    return { fields, scratch }
  }

  it('a house placed with no road has dist[houseCell] === INF; wiring a driveway makes it finite', () => {
    const { map, world } = fixture('dist-driveway')
    const state = createState('s', map)

    const destCell = destCellFor(0, 0)
    expect(placeDestination(state, world, destCell, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    const cp = carparkCell(destCell, ORIENTATION_S, W, H)
    // Connect the carpark to a small road stub so it is a valid Dijkstra
    // source (`computeFlowField` only accepts a source that carries a road
    // bit) and give it somewhere to expand from besides the house.
    expect(placeRoad(state, world, cp, cp + 1)).toBe(true)

    const houseCell = destCellFor(8, 5) // far corner, untouched by any road yet
    expect(placeHouse(state, world, houseCell, 0)).toBe(true)

    const { fields, scratch } = buildFieldRig(map, world)
    // Manually assemble the one source Task 4 will assemble automatically —
    // this IS "the one consumer that matters" from the task brief, exercised
    // directly rather than through Task 4's not-yet-written dispatch.ts.
    scratch.sourcesFlat[0] = cp
    scratch.sourceCounts[0] = 1
    syncFields(state, world, fields, scratch)
    const field = fieldFor(state, world, fields, 0, scratch)
    expect(field.dist[houseCell]).toBe(INF)

    // Now wire an actual driveway ALL the way from the house cell into the
    // carpark's own network — a partial chain that never reaches a source
    // would still be INF for a reason unrelated to "does the house have a
    // driveway", so this must be a genuine connected path, not merely "the
    // house cell carries some road bit somewhere".
    // Row 5 west from col 8 to col 0, then north along col 0 to row 3 (cp).
    for (let x = 8; x > 0; x--) {
      expect(placeRoad(state, world, destCellFor(x, 5), destCellFor(x - 1, 5))).toBe(true)
    }
    expect(placeRoad(state, world, destCellFor(0, 5), destCellFor(0, 4))).toBe(true)
    expect(placeRoad(state, world, destCellFor(0, 4), destCellFor(0, 3))).toBe(true)
    expect(destCellFor(0, 3)).toBe(cp) // the chain's other end IS the carpark

    syncFields(state, world, fields, scratch) // re-sync: roads changed (a FIELD_INPUT region)
    const field2 = fieldFor(state, world, fields, 0, scratch)
    expect(field2.dist[houseCell]).not.toBe(INF)
  })
})
