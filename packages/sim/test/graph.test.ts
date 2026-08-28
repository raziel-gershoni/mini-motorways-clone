import { describe, it, expect } from 'vitest'
import { parseMap, ORTHO_COST, DIAG_COST, INTERSECTION_DEGREE, type MapData } from '@laneways/shared'
import { createState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { seedFromString, randomBelow } from '../src/rng'
import { DIR_COUNT, DX, DY, dirBetween, placeRoad } from '../src/roads'
import { neighbours, edgeCost, isConnected, roadDegree, isJunctionCell, junctionAdmitsOne } from '../src/graph'
import { applyPlaceUpgrade, isUpgraded } from '../src/upgrades'
import { H_INV_UPGRADES } from '../src/state'
import {
  plusJunction,
  straightCorridor,
  twoAdjacentJunctions,
  upgradedJunction,
  upgradedThenErased,
} from './junctionRigs'

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
  const map = parseMap(id, LAND_ROWS, 999, 40, 16, 5)
  const world = createWorld(map)
  return { map, world }
}

function mixedFixture(id: string, startingTiles: number): { map: MapData; world: WorldData } {
  const map = parseMap(id, MIXED_ROWS, startingTiles, 40, 16, 5)
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

describe('roadDegree (M1d Task 7)', () => {
  it('counts 0 for bare ground, 1 for a dead end, 2 for a corridor and 3 at a junction', () => {
    // The four values the intersection rule cares about, one fixture, one cell
    // growing a bit at a time — so the threshold has a value on each side of it
    // rather than being asserted from one direction only.
    const { map, world } = landFixture('degree-ladder')
    const state = createState('s', map)
    const cell = 1 * W + 2 // (2,1), interior on a 6x4 board
    expect(roadDegree(state, cell)).toBe(0)
    placeRoad(state, world, cell, cell + 1) // E
    expect(roadDegree(state, cell)).toBe(1)
    placeRoad(state, world, cell, cell - 1) // W — a straight corridor cell
    expect(roadDegree(state, cell)).toBe(2)
    placeRoad(state, world, cell, cell - W) // N — the third road: a junction
    expect(roadDegree(state, cell)).toBe(3)
    placeRoad(state, world, cell, cell + W) // S — a crossroads
    expect(roadDegree(state, cell)).toBe(4)
  })

  it('counts a bend as 2, so a cell where the road turns is not an intersection', () => {
    // The discriminator between "degree" and "the road does something here".
    // `cars.ts` charges a turn and a junction separately and averages them, so a
    // degree helper that reported a bend as 3 would double-charge every corner.
    const { map, world } = landFixture('degree-bend')
    const state = createState('s', map)
    const cell = 1 * W + 2
    placeRoad(state, world, cell, cell - 1) // W
    placeRoad(state, world, cell, cell + W) // S — an L, not a T
    expect(roadDegree(state, cell)).toBe(2)
  })

  it('counts diagonal bits too, and every one of the eight independently', () => {
    // Eight separate cells, each carrying exactly one of the eight bits, so a
    // helper that counted only the orthogonal nibble (a plausible popcount over
    // 4 bits rather than 8) is caught on the four diagonals.
    const { map, world } = landFixture('degree-all-eight')
    const state = createState('s', map)
    const x = 2
    const y = 1
    const cell = y * W + x
    for (let k = 0; k < DIR_COUNT; k++) {
      const fresh = createState(`degree-bit-${k}`, map)
      const nb = (y + (DY[k] as number)) * W + (x + (DX[k] as number))
      placeRoad(fresh, world, cell, nb)
      expect(roadDegree(fresh, cell), `direction ${k} alone`).toBe(1)
      expect(roadDegree(fresh, nb), `direction ${k}, the far end`).toBe(1)
      placeRoad(state, world, cell, nb)
    }
    expect(roadDegree(state, cell)).toBe(DIR_COUNT)
  })

  it('agrees with `neighbours` cell for cell across a large seeded random placement sequence', () => {
    // graph.ts states the one case where the two can differ — a bit whose target
    // is off the grid, which `neighbours` drops and this counts — and claims no
    // REACHABLE state has one, because `placeRoad` validates adjacency before it
    // writes. This is that claim's honesty check, in the idiom of the passable
    // property test above: placement goes exclusively through `placeRoad`, and
    // the two are then compared on every cell of the board including the edges
    // and corners, which are the only cells where an off-grid bit could exist.
    const { map, world } = mixedFixture('degree-vs-neighbours', 1000)
    const state = createState('degree-vs-neighbours-seed', map)
    const driver = new Uint32Array(1)
    driver[0] = seedFromString('degree-driver')

    let placedOk = 0
    for (let i = 0; i < 3000; i++) {
      const a = randomBelow(driver, 0, world.cells)
      const dir = randomBelow(driver, 0, DIR_COUNT)
      const x = a % world.w
      const y = (a / world.w) | 0
      const nx = x + (DX[dir] as number)
      const ny = y + (DY[dir] as number)
      if (nx < 0 || nx >= world.w || ny < 0 || ny >= world.h) continue
      if (placeRoad(state, world, a, ny * world.w + nx)) placedOk++
    }
    expect(placedOk).toBeGreaterThan(100)

    // Vacuity, both directions: the comparison must range over cells of degree
    // >= 3 AND over cells on the board edge, or it says nothing about either the
    // intersection threshold or the off-grid case it exists for.
    const { outCell, outDir } = makeOut()
    let junctions = 0
    let edgeCellsWithRoad = 0
    for (let cell = 0; cell < world.cells; cell++) {
      const degree = roadDegree(state, cell)
      expect(degree, `cell ${cell}`).toBe(neighbours(state, world, cell, outCell, outDir))
      if (degree >= 3) junctions++
      const x = cell % world.w
      const y = (cell / world.w) | 0
      const onEdge = x === 0 || y === 0 || x === world.w - 1 || y === world.h - 1
      if (onEdge && degree > 0) edgeCellsWithRoad++
    }
    expect(junctions).toBeGreaterThan(0)
    expect(edgeCellsWithRoad).toBeGreaterThan(0)
  })

  it('reports the off-grid bit `neighbours` drops, when one is written directly', () => {
    // The disclosed disagreement, exercised rather than asserted in prose. A bit
    // pointing N from row 0 cannot be produced by `placeRoad`, so this writes the
    // byte directly — the same technique the bounds-guard tests above use, and
    // for the same reason. `neighbours` answers 0 because it is about to WALK
    // there; `roadDegree` answers 1 because it is counting roads. Recorded so a
    // future reader does not "fix" one to match the other without deciding which
    // is right: for the intersection multiplier, over-counting a corrupted mask
    // costs one car one wrong SPEED on one cell and can never move it off its
    // committed route.
    const { map, world } = landFixture('degree-off-grid')
    const state = createState('s', map)
    const topRow = 3 // (3,0)
    state.roads[topRow] = 1 << dirFor(0, -1) // N, off the board
    const { outCell, outDir } = makeOut()
    expect(neighbours(state, world, topRow, outCell, outDir)).toBe(0)
    expect(roadDegree(state, topRow)).toBe(1)
  })

  it('is read-only: asking about every cell of a placed network moves no byte of the buffer', () => {
    const { map, world } = landFixture('degree-readonly')
    const state = createState('s', map)
    for (let cell = 0; cell < world.cells - 1; cell += 2) {
      if ((cell + 1) % W !== 0) placeRoad(state, world, cell, cell + 1)
    }
    const before = new Uint8Array(state.buffer).slice()
    for (let cell = 0; cell < world.cells; cell++) roadDegree(state, cell)
    expect(new Uint8Array(state.buffer)).toEqual(before)
  })
})

describe("edgeCost's value set is what four other constants are calibrated against (M1d Task 7)", () => {
  it('is exactly {10, 14} — the tripwire for a lane-speed term leaking into routing', () => {
    // M1d Task 7 gives lane-speed multipliers their first caller and puts them in
    // `advanceCar`, NOT here. `NB = DIAG_COST + 1` (scratch.ts), the bucket
    // count, `DISTINCT_EDGE_COSTS = 2`, `COST_UNIT_SCALE` = 250 and
    // `CAR_SPEED_UNITS_PER_TICK` = 330 are one calibration against exactly this
    // set, and a multiplier applied here would change all of them at once — and
    // would move the field golden, which is `rollback.test.ts`'s independent
    // detector for the same mutation. Written as the literal pair rather than as
    // "two distinct values", because 667 and 933 are also two distinct values.
    const values: number[] = []
    for (let k = 0; k < DIR_COUNT; k++) {
      const c = edgeCost(k)
      if (!values.includes(c)) values.push(c)
    }
    values.sort((a, b) => a - b)
    expect(values).toEqual([10, 14])
    expect(values).toEqual([ORTHO_COST, DIAG_COST].sort((a, b) => a - b))
  })

  it('does not depend on the road network: the same direction costs the same at a junction', () => {
    // The directed form of "the multiplier is not in here". `edgeCost` takes a
    // direction and nothing else, so a junction cannot change it — but the
    // mutation the plan names is "apply a multiplier inside `edgeCost`", which
    // would have to reach the state to know about the junction. This pins the
    // arity that makes that unconstructible, beside the value set it would move.
    expect(edgeCost.length).toBe(1)
    const { map, world } = landFixture('edgecost-junction')
    const state = createState('s', map)
    const cell = 1 * W + 2
    placeRoad(state, world, cell, cell + 1)
    placeRoad(state, world, cell, cell - 1)
    placeRoad(state, world, cell, cell - W)
    expect(roadDegree(state, cell)).toBe(3)
    for (let k = 0; k < DIR_COUNT; k++) {
      const isDiagonal = (DX[k] as number) !== 0 && (DY[k] as number) !== 0
      expect(edgeCost(k)).toBe(isDiagonal ? DIAG_COST : ORTHO_COST)
    }
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

describe('isJunctionCell and junctionAdmitsOne are TWO predicates with two jobs', () => {
  // They agree at Task 2 and diverge at Task 9, when an UPGRADED junction keeps
  // the SLOWDOWN (INTERSECTION_SPEED_MUL still applies; spec 5.6's right-on-red
  // clause protects the same property) and loses the DEFAULT EXCLUSION. This
  // table is what stops them silently collapsing back into one.
  //
  // **Both a degree-4 and a degree-3 fixture, because 3 IS the threshold.** A
  // degree-4 case alone cannot see `>= INTERSECTION_DEGREE` widened to
  // `> INTERSECTION_DEGREE`; `twoAdjacentJunctions`'s endpoints are exactly 3 and
  // that mutant dies on them.
  it('a degree-4 cell is a junction, and the default exclusion applies', () => {
    const rig = plusJunction('pred-plus')
    expect(roadDegree(rig.s, rig.centre)).toBe(4)
    expect(isJunctionCell(rig.s, rig.centre)).toBe(true)
    expect(junctionAdmitsOne(rig.s, rig.centre)).toBe(true)
  })

  it('a degree-3 cell — exactly INTERSECTION_DEGREE — is a junction too', () => {
    const rig = twoAdjacentJunctions('pred-threshold')
    expect(roadDegree(rig.s, rig.left)).toBe(INTERSECTION_DEGREE)
    expect(isJunctionCell(rig.s, rig.left)).toBe(true)
    expect(junctionAdmitsOne(rig.s, rig.left)).toBe(true)
  })

  it('a degree-2 cell is neither', () => {
    const rig = straightCorridor('pred-corridor')
    expect(roadDegree(rig.s, rig.mid)).toBe(2)
    expect(isJunctionCell(rig.s, rig.mid)).toBe(false)
    expect(junctionAdmitsOne(rig.s, rig.mid)).toBe(false)
  })

  it('bare ground and a dead end are neither', () => {
    const rig = straightCorridor('pred-bare')
    expect(roadDegree(rig.s, rig.west), 'the corridor end is a dead end').toBe(1)
    expect(isJunctionCell(rig.s, rig.west)).toBe(false)
    expect(junctionAdmitsOne(rig.s, rig.west)).toBe(false)
    const bare = 0
    expect(roadDegree(rig.s, bare)).toBe(0)
    expect(isJunctionCell(rig.s, bare)).toBe(false)
    expect(junctionAdmitsOne(rig.s, bare)).toBe(false)
  })

  it('an off-board index answers false from both, with no guard, exactly as roadDegree does', () => {
    const rig = plusJunction('pred-offboard')
    expect(roadDegree(rig.s, rig.world.cells + 5)).toBe(0)
    expect(isJunctionCell(rig.s, rig.world.cells + 5)).toBe(false)
    expect(junctionAdmitsOne(rig.s, rig.world.cells + 5)).toBe(false)
  })

  it('an upgraded junction keeps isJunctionCell and loses junctionAdmitsOne', () => {
    // **The divergence, as one line.** M1f Task 9's upgrade lifts the DEFAULT
    // exclusion and leaves the cell an intersection for every other purpose —
    // `intersectionSpeedMul` still slows every car crossing here, which is
    // 5.6's *"skips the stop, not the intersection slowdown"* honoured by a
    // different route.
    const rig = upgradedJunction('pred-upgraded')
    expect(roadDegree(rig.s, rig.centre)).toBe(4)
    expect(isJunctionCell(rig.s, rig.centre)).toBe(true)
    expect(junctionAdmitsOne(rig.s, rig.centre)).toBe(false)
  })

  it('an upgraded CORRIDOR — reachable only by erasing a road — is neither', () => {
    // The flag persists through an erase, so this combination is a state a player
    // can reach. It answers false from both, and from `junctionAdmitsOne` it does
    // so for two independent reasons, which is why the fourth row exists.
    const rig = upgradedThenErased('pred-upgraded-corridor')
    expect(roadDegree(rig.s, rig.centre), 'the erase really cut it to a corridor').toBe(2)
    expect(isJunctionCell(rig.s, rig.centre)).toBe(false)
    expect(junctionAdmitsOne(rig.s, rig.centre)).toBe(false)
  })

  it('the two agree on every cell of a mixed board EXCEPT the upgraded ones', () => {
    // The table above is per-shape; this is the whole-board statement, and it is
    // **the assertion Task 9 EDITED rather than deleted**. Until Task 9 it read
    // "the two answer the same thing on every cell"; an upgraded cell is now the
    // one place they disagree, and the loop below is what says it is the ONLY
    // place — a clause that answered `false` one cell wide of its flag would
    // pass every per-shape case above and fail here.
    const rig = twoAdjacentJunctions('pred-whole-board')
    rig.s.header[H_INV_UPGRADES] = 1
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.left)).toBe(true)
    let junctions = 0
    let diverged = 0
    for (let cell = 0; cell < rig.world.cells; cell++) {
      const a = isJunctionCell(rig.s, cell)
      const b = junctionAdmitsOne(rig.s, cell)
      if (isUpgraded(rig.s, cell)) {
        expect(b, `upgraded cell ${cell} is not under the default rule`).toBe(false)
        if (a !== b) diverged++
      } else {
        expect(b, `cell ${cell}`).toBe(a)
      }
      if (a) junctions++
    }
    expect(junctions, 'non-vacuous: the board really does carry junctions').toBe(2)
    expect(diverged, 'exactly one cell diverges, and it is the upgraded one').toBe(1)
  })
})
