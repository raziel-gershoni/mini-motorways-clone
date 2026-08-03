import { describe, it, expect } from 'vitest'
import { parseMap, ORTHO_COST, DIAG_COST, type MapData } from '@laneways/shared'
import { createState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { seedFromString, randomBelow } from '../src/rng'
import { DIR_COUNT, DX, DY, dirBetween, placeRoad } from '../src/roads'
import { neighbours, edgeCost, isConnected } from '../src/graph'

/**
 * All-LAND fixture for pure connectivity geometry. Terrain never gates
 * `neighbours`/`isConnected` (graph.ts's terrain-filtering decision — see
 * its module comment), so the shape tests below need no terrain variety of
 * their own; they need bounds variety instead, hence non-square (w != h),
 * per the milestone-wide rule that a square fixture cannot distinguish `w`
 * from `h` being swapped anywhere in the geometry.
 */
const LAND_ROWS = ['......', '......', '......', '......']
const W = 6
const H = 4

/** Mirrors roads.test.ts's mixed-terrain fixture, for the passable property test. */
const MIXED_ROWS = ['.~....', '.^....', '.T....', '......']

function landFixture(id: string): { map: MapData; world: WorldData } {
  const map = parseMap(id, LAND_ROWS, 999)
  const world = createWorld(map)
  return { map, world }
}

function mixedFixture(id: string, startingTiles: number): { map: MapData; world: WorldData } {
  const map = parseMap(id, MIXED_ROWS, startingTiles)
  const world = createWorld(map)
  return { map, world }
}

/** The direction index k with DX[k] === dx, DY[k] === dy — computed, not assumed. */
function dirFor(dx: number, dy: number): number {
  for (let k = 0; k < DIR_COUNT; k++) {
    if ((DX[k] as number) === dx && (DY[k] as number) === dy) return k
  }
  throw new Error(`dirFor: no direction matches (${dx}, ${dy})`)
}

function makeOut(): { outCell: Int32Array; outDir: Int8Array } {
  return { outCell: new Int32Array(8), outDir: new Int8Array(8) }
}

describe('neighbours: counts', () => {
  it('an isolated cell (no roads) has n === 0', () => {
    const { map, world } = landFixture('isolated')
    const state = createState('s', map)
    const { outCell, outDir } = makeOut()
    expect(neighbours(state, world, 2 * W + 2, outCell, outDir)).toBe(0)
  })

  it('a cell with one road has n === 1', () => {
    const { map, world } = landFixture('one-road')
    const state = createState('s', map)
    const cell = 2 * W + 2
    placeRoad(state, world, cell, cell + 1) // east
    const { outCell, outDir } = makeOut()
    expect(neighbours(state, world, cell, outCell, outDir)).toBe(1)
  })

  it('a fully-connected interior cell has n === 8', () => {
    const { map, world } = landFixture('full-8')
    const state = createState('s', map)
    const x = 2
    const y = 2
    const cell = y * W + x
    for (let k = 0; k < DIR_COUNT; k++) {
      const nx = x + (DX[k] as number)
      const ny = y + (DY[k] as number)
      placeRoad(state, world, cell, ny * W + nx)
    }
    const { outCell, outDir } = makeOut()
    expect(neighbours(state, world, cell, outCell, outDir)).toBe(8)
  })
})

describe('neighbours: contents and order', () => {
  it('fills outCell/outDir in ascending DIRS order, leaves the tail untouched, for a partial connection', () => {
    const { map, world } = landFixture('contents-order')
    const state = createState('s', map)
    const x = 2
    const y = 2
    const cell = y * W + x
    // Placed out of ascending order deliberately, to prove the OUTPUT order
    // comes from iterating k ascending, not from placement order.
    const placeOrder = [6, 1, 4]
    for (const k of placeOrder) {
      const nx = x + (DX[k] as number)
      const ny = y + (DY[k] as number)
      placeRoad(state, world, cell, ny * W + nx)
    }

    const SENTINEL = -7
    const outCell = new Int32Array(8).fill(SENTINEL)
    const outDir = new Int8Array(8).fill(SENTINEL)
    const n = neighbours(state, world, cell, outCell, outDir)
    expect(n).toBe(3)

    // Ascending DIRS order: 1 (NE), 4 (S), 6 (W) — not the placement order.
    const ascending = [1, 4, 6]
    for (let i = 0; i < ascending.length; i++) {
      const k = ascending[i] as number
      const nx = x + (DX[k] as number)
      const ny = y + (DY[k] as number)
      expect(outCell[i], `outCell[${i}]`).toBe(ny * W + nx)
      expect(outDir[i], `outDir[${i}]`).toBe(k)
    }
    for (let i = ascending.length; i < 8; i++) {
      expect(outCell[i], `outCell[${i}] beyond n`).toBe(SENTINEL)
      expect(outDir[i], `outDir[${i}] beyond n`).toBe(SENTINEL)
    }
  })

  it('every returned neighbour satisfies dirBetween(cell, outCell[i], w, h) === outDir[i], for all 8 directions', () => {
    // A cell with every direction connected: distinguishes a row-stride drop
    // (DY != 0 directions land on the wrong cell) from a correct
    // implementation, for every direction at once.
    const { map, world } = landFixture('dirbetween-cross-check')
    const state = createState('s', map)
    const x = 2
    const y = 2
    const cell = y * W + x
    for (let k = 0; k < DIR_COUNT; k++) {
      const nx = x + (DX[k] as number)
      const ny = y + (DY[k] as number)
      placeRoad(state, world, cell, ny * W + nx)
    }
    const { outCell, outDir } = makeOut()
    const n = neighbours(state, world, cell, outCell, outDir)
    expect(n).toBe(8)
    for (let i = 0; i < n; i++) {
      expect(dirBetween(cell, outCell[i] as number, world.w, world.h), `i=${i}`).toBe(outDir[i])
    }
  })
})

describe('neighbours: off-grid road bits are excluded (bounds guard)', () => {
  // `placeRoad` can never create an off-grid bit (it validates adjacency via
  // `dirBetween`), so these tests write the byte directly into `state.roads`
  // — the same technique roads.test.ts uses for `assertSymmetric`'s row-seam
  // case — to reach the bounds guard inside `neighbours` at all.

  it('a road bit pointing N from row 0 yields no neighbour', () => {
    const { map, world } = landFixture('bounds-n')
    const state = createState('s', map)
    const cell = 0 * W + 3 // row 0
    state.roads[cell] = 1 << dirFor(0, -1)
    const { outCell, outDir } = makeOut()
    expect(neighbours(state, world, cell, outCell, outDir)).toBe(0)
  })

  it('a road bit pointing S from row h-1 yields no neighbour', () => {
    const { map, world } = landFixture('bounds-s')
    const state = createState('s', map)
    const cell = (H - 1) * W + 3
    state.roads[cell] = 1 << dirFor(0, 1)
    const { outCell, outDir } = makeOut()
    expect(neighbours(state, world, cell, outCell, outDir)).toBe(0)
  })

  it('a road bit pointing W from x=0 yields no neighbour', () => {
    const { map, world } = landFixture('bounds-w')
    const state = createState('s', map)
    const cell = 2 * W + 0
    state.roads[cell] = 1 << dirFor(-1, 0)
    const { outCell, outDir } = makeOut()
    expect(neighbours(state, world, cell, outCell, outDir)).toBe(0)
  })

  it('a road bit pointing E from x=w-1 yields no neighbour', () => {
    const { map, world } = landFixture('bounds-e')
    const state = createState('s', map)
    const cell = 1 * W + (W - 1)
    state.roads[cell] = 1 << dirFor(1, 0)
    const { outCell, outDir } = makeOut()
    expect(neighbours(state, world, cell, outCell, outDir)).toBe(0)
  })

  it('a mixed mask with one off-grid bit and one real bit returns only the real neighbour', () => {
    // Discriminates a guard that (incorrectly) rejects the WHOLE cell once it
    // sees one bad bit from one that filters bit-by-bit, which is what the
    // interface promises (n counts only in-bounds neighbours).
    const { map, world } = landFixture('bounds-mixed')
    const state = createState('s', map)
    const cell = 0 * W + 3 // row 0: N is off-grid, E is real
    state.roads[cell] = (1 << dirFor(0, -1)) | (1 << dirFor(1, 0))
    const { outCell, outDir } = makeOut()
    const n = neighbours(state, world, cell, outCell, outDir)
    expect(n).toBe(1)
    expect(outCell[0]).toBe(cell + 1)
    expect(outDir[0]).toBe(dirFor(1, 0))
  })
})

describe('neighbours: passable-terrain property (randomised)', () => {
  it('never returns a neighbour on impassable terrain, across a large seeded random placement sequence', () => {
    // `neighbours` deliberately does NOT re-filter impassable terrain (see
    // graph.ts's module comment for why) — `placeRoad` is what enforces it.
    // This test is the honesty check for that decision: it drives placement
    // exclusively through `placeRoad` (never writing `state.roads` directly)
    // and then asserts the invariant holds anyway, over a large randomised
    // graph and every cell on the board.
    const { map, world } = mixedFixture('graph-random', 1000)
    const state = createState('graph-random-seed', map)

    const driver = new Uint32Array(1)
    driver[0] = seedFromString('graph-random-driver')

    let placedOk = 0
    for (let i = 0; i < 3000; i++) {
      const a = randomBelow(driver, 0, world.cells)
      const dir = randomBelow(driver, 0, DIR_COUNT)
      const x = a % world.w
      const y = (a / world.w) | 0
      const nx = x + (DX[dir] as number)
      const ny = y + (DY[dir] as number)
      if (nx < 0 || nx >= world.w || ny < 0 || ny >= world.h) continue
      const b = ny * world.w + nx
      if (placeRoad(state, world, a, b)) placedOk++
    }
    // Vacuity self-check: a `neighbours` that always returns 0 would make
    // the property below trivially true.
    expect(placedOk).toBeGreaterThan(100)

    let neighboursChecked = 0
    const { outCell, outDir } = makeOut()
    for (let cell = 0; cell < world.cells; cell++) {
      const n = neighbours(state, world, cell, outCell, outDir)
      for (let i = 0; i < n; i++) {
        neighboursChecked++
        const nb = outCell[i] as number
        expect(world.passable[nb], `cell ${cell} -> neighbour ${nb}`).toBe(1)
      }
    }
    expect(neighboursChecked).toBeGreaterThan(100)
  })
})

describe('edgeCost', () => {
  it('returns ORTHO_COST for the four orthogonal directions and DIAG_COST for the four diagonals', () => {
    for (let k = 0; k < DIR_COUNT; k++) {
      const isDiagonal = (DX[k] as number) !== 0 && (DY[k] as number) !== 0
      expect(edgeCost(k), `direction ${k}`).toBe(isDiagonal ? DIAG_COST : ORTHO_COST)
    }
  })

  it('yields exactly two distinct values across all eight directions', () => {
    const values = new Set<number>()
    for (let k = 0; k < DIR_COUNT; k++) values.add(edgeCost(k))
    expect(values.size).toBe(2)
  })

  it('rejects an out-of-range or non-integer direction index', () => {
    expect(() => edgeCost(-1)).toThrow()
    expect(() => edgeCost(8)).toThrow()
    expect(() => edgeCost(1.5)).toThrow()
  })
})

describe('isConnected', () => {
  it('is symmetric for every placed orthogonal segment', () => {
    const { map, world } = landFixture('sym-ortho')
    const state = createState('s', map)
    const a = 1 * W + 2
    const b = a + 1 // east
    placeRoad(state, world, a, b)
    expect(isConnected(state, world, a, b)).toBe(true)
    expect(isConnected(state, world, b, a)).toBe(true)
  })

  it('reports a diagonal connection for both cells', () => {
    const { map, world } = landFixture('diag')
    const state = createState('s', map)
    const a = 1 * W + 2
    const b = a + W + 1 // south-east
    placeRoad(state, world, a, b)
    expect(isConnected(state, world, a, b)).toBe(true)
    expect(isConnected(state, world, b, a)).toBe(true)
  })

  it('is false for two cells that both carry roads, but not to each other', () => {
    // `roadMask(a) !== 0 && roadMask(b) !== 0` is symmetric by construction
    // and would pass here: both `a` and `b` DO carry roads. The correct
    // implementation must check the specific bit toward the other cell.
    const { map, world } = landFixture('both-have-roads-not-to-each-other')
    const state = createState('s', map)
    const a = 1 * W + 2
    const b = a + 1 // adjacent to a, but never connected to it directly
    placeRoad(state, world, a, a - 1) // a's road goes west, away from b
    placeRoad(state, world, b, b + 1) // b's road goes east, away from a
    expect(isConnected(state, world, a, b)).toBe(false)
    expect(isConnected(state, world, b, a)).toBe(false)
  })

  it('is false for two non-adjacent cells', () => {
    const { map, world } = landFixture('non-adjacent')
    const state = createState('s', map)
    const a = 1 * W + 2
    const b = a + 2 // two cells east: in range, not 8-adjacent
    expect(isConnected(state, world, a, b)).toBe(false)
  })

  it('is false for a cell paired with itself', () => {
    const { map, world } = landFixture('self-pair')
    const state = createState('s', map)
    const a = 1 * W + 2
    expect(isConnected(state, world, a, a)).toBe(false)
  })
})
