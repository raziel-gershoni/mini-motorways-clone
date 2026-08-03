import { describe, it, expect } from 'vitest'
import { parseMap, CARS_PER_HOUSE, type MapData } from '@laneways/shared'
import { createState, houseAt, destAt, H_HOUSE_COUNT, H_DEST_COUNT, H_TICK } from '../src/state'
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
  canPlaceHouse,
  placeHouse,
  canPlaceDestination,
  placeDestination,
} from '../src/buildings'

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
})

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
