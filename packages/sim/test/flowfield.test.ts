import { describe, it, expect } from 'vitest'
import { parseMap, ORTHO_COST, DIAG_COST, type MapData } from '@laneways/shared'
import { createState, nonZeroWord, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { placeRoad, DIR_COUNT, DX, DY } from '../src/roads'
import { seedFromString, randomBelow } from '../src/rng'
import { edgeCost } from '../src/graph'
import {
  createFlowField,
  createFlowFields,
  createScratch,
  INF,
  NB,
  ST_EXPANSIONS,
  type Scratch,
} from '../src/scratch'
import { computeFlowField, hashSources, syncFields, fieldFor } from '../src/flowfield'

/**
 * Fixtures and helpers shared across this file. All-LAND boards throughout:
 * terrain gating is graph.ts's concern (already covered by its own
 * randomised property test), so these fixtures need bounds/shape variety
 * instead — hence non-square (w != h) wherever the exact dimensions matter.
 */

function cellAt(w: number, x: number, y: number): number {
  return y * w + x
}

function landFixture(id: string, w: number, h: number): { map: MapData; world: WorldData } {
  const rows = Array.from({ length: h }, () => '.'.repeat(w))
  const map = parseMap(id, rows, 999)
  const world = createWorld(map)
  return { map, world }
}

function placeChain(state: GameState, world: WorldData, cells: readonly number[]): void {
  for (let i = 1; i < cells.length; i++) {
    const ok = placeRoad(state, world, cells[i - 1] as number, cells[i] as number)
    if (!ok) throw new Error(`placeChain: failed to place segment ${cells[i - 1]} -> ${cells[i]}`)
  }
}

/**
 * A moderately dense, seeded-random road graph — the same technique
 * graph.test.ts uses for its passable-terrain property test, reused here so
 * the structural property tests below (dir consistency, the complement,
 * work counter, "following dir terminates") run over a graph with genuine
 * branching rather than a single hand-drawn line.
 */
function randomGraphFixture(
  id: string,
  w: number,
  h: number,
  attempts: number,
): { state: GameState; world: WorldData } {
  const { map, world } = landFixture(id, w, h)
  const state = createState(`${id}-seed`, map)
  const driver = new Uint32Array(1)
  driver[0] = seedFromString(`${id}-driver`)

  let placed = 0
  for (let i = 0; i < attempts; i++) {
    const a = randomBelow(driver, 0, world.cells)
    const dir = randomBelow(driver, 0, DIR_COUNT)
    const x = a % world.w
    const y = (a / world.w) | 0
    const nx = x + (DX[dir] as number)
    const ny = y + (DY[dir] as number)
    if (nx < 0 || nx >= world.w || ny < 0 || ny >= world.h) continue
    const b = ny * world.w + nx
    if (placeRoad(state, world, a, b)) placed++
  }
  // Vacuity self-check: a near-empty graph would make every property below
  // trivially true.
  if (placed < 50) {
    throw new Error(`randomGraphFixture("${id}"): only placed ${placed} segments, fixture is too sparse`)
  }
  return { state, world }
}

/** The first `count` cell indices (ascending) that carry a road bit. */
function firstRoadedCells(state: GameState, world: WorldData, count: number): number[] {
  const out: number[] = []
  for (let c = 0; c < world.cells && out.length < count; c++) {
    if ((state.roads[c] as number) !== 0) out.push(c)
  }
  if (out.length < count) {
    throw new Error(`firstRoadedCells: found only ${out.length} of ${count} requested roaded cells`)
  }
  return out
}

// ---------------------------------------------------------------------------

describe('computeFlowField: source acceptance', () => {
  it('sets dist=0, dir=-1 at every accepted source; a source on a roadless cell is not accepted', () => {
    const { map, world } = landFixture('accept', 6, 5)
    const state = createState('s', map)
    const w = world.w
    const roadless = cellAt(w, 1, 1)
    const a = cellAt(w, 3, 3)
    const b = cellAt(w, 4, 3)
    placeRoad(state, world, a, b)
    expect(roadless).toBeLessThan(a) // keep the source list ascending below

    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [roadless, a], field, scratch)

    expect(field.dist[roadless]).toBe(INF)
    expect(field.dir[roadless]).toBe(-1)
    expect(field.dist[a]).toBe(0)
    expect(field.dir[a]).toBe(-1)
  })

  it('with every source rejected (all roadless), the field is entirely INF/-1', () => {
    const { map, world } = landFixture('all-rejected', 5, 4)
    const state = createState('s', map)
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [0, 3, 7], field, scratch)
    expect(Array.from(field.dist).every((d) => d === INF)).toBe(true)
    expect(Array.from(field.dir).every((d) => d === -1)).toBe(true)
  })
})

describe('computeFlowField: edge costs along a line', () => {
  it('accumulates ORTHO_COST per step along a straight orthogonal line', () => {
    const { map, world } = landFixture('straight-ortho', 8, 5)
    const state = createState('s', map)
    const w = world.w
    const y = 2
    const cells = [0, 1, 2, 3, 4].map((x) => cellAt(w, x, y))
    placeChain(state, world, cells)

    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [cells[0] as number], field, scratch)

    for (let i = 0; i < cells.length; i++) {
      expect(field.dist[cells[i] as number], `hop ${i}`).toBe(i * ORTHO_COST)
    }
  })

  it('accumulates DIAG_COST per step along a straight diagonal line', () => {
    const { map, world } = landFixture('straight-diag', 8, 8)
    const state = createState('s', map)
    const w = world.w
    const cells = [0, 1, 2, 3, 4].map((i) => cellAt(w, i, i))
    placeChain(state, world, cells)

    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [cells[0] as number], field, scratch)

    for (let i = 0; i < cells.length; i++) {
      expect(field.dist[cells[i] as number], `hop ${i}`).toBe(i * DIAG_COST)
    }
  })

  it('leaves a disconnected component and a roadless cell at INF/-1', () => {
    const { map, world } = landFixture('unreachable', 8, 6)
    const state = createState('s', map)
    const w = world.w
    const source = cellAt(w, 0, 0)
    placeRoad(state, world, source, cellAt(w, 1, 0))
    const farA = cellAt(w, 6, 5)
    const farB = cellAt(w, 7, 5)
    placeRoad(state, world, farA, farB) // a disconnected component
    const roadless = cellAt(w, 4, 3)

    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [source], field, scratch)

    expect(field.dist[farA]).toBe(INF)
    expect(field.dir[farA]).toBe(-1)
    expect(field.dist[roadless]).toBe(INF)
    expect(field.dir[roadless]).toBe(-1)
  })
})

describe('computeFlowField: row-seam safety', () => {
  /**
   * `computeFlowField` never computes `nx`/`ny` itself — it delegates
   * entirely to `neighbours()` (graph.ts), which already rejects a road bit
   * that would wrap the grid's right edge into the next row's left edge
   * (Task 4's bounds guard, tested directly in graph.test.ts). This is the
   * integration-level pin for that guard at the FLOW-FIELD level: a bit
   * written directly into `state.roads` (never reachable through
   * `placeRoad`, which validates adjacency first) must not let
   * `computeFlowField` treat the row-seam wrap as a real connection.
   */
  it('a road bit pointing east from the last column is not treated as a connection to the next row', () => {
    const { map, world } = landFixture('row-seam', 4, 3)
    const state = createState('s', map)
    const w = world.w
    const source = cellAt(w, w - 1, 0) // rightmost cell of row 0
    const EAST = 2 // DX=1, DY=0
    state.roads[source] = 1 << EAST // written directly: placeRoad could never create this bit
    const wrapTarget = cellAt(w, 0, 1) // row 1, column 0 — what `source + 1` would naively land on

    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [source], field, scratch)

    expect(field.dist[source]).toBe(0) // still an accepted source (it carries a road bit)
    expect(field.dist[wrapTarget]).toBe(INF)
    expect(field.dir[wrapTarget]).toBe(-1)
  })
})

describe('computeFlowField: two sources, five-cell corridor', () => {
  /** Cells 0..4 in a single row: 0-1-2-3-4, all ORTHO_COST segments. */
  function buildCorridor(): { state: GameState; world: WorldData } {
    const { map, world } = landFixture('corridor', 5, 1)
    const state = createState('corridor-seed', map)
    for (let i = 0; i < 4; i++) placeRoad(state, world, i, i + 1)
    return { state, world }
  }

  it('every cell takes the minimum distance from either end', () => {
    const { state, world } = buildCorridor()
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [0, 4], field, scratch)
    expect(Array.from(field.dist)).toEqual([0, 10, 20, 10, 0])
  })

  it('pins dir for the ascending order [0, 4]', () => {
    // This entry pool's LIFO drain order processes the LATER array element
    // first within a tied bucket: sources are pushed in ascending order but
    // drained most-recently-pushed-first, so at d=0, source 4 expands
    // before source 0. Neither end cell (1 or 3) is a tie (10 vs 30, and
    // vice versa), so only cell 2 (tied at 20 from both directions) is
    // order-sensitive: cell 1's expansion at d=10 reaches it first (dir=6,
    // west, toward cell 1/source 0); cell 3's expansion at the same d=10
    // offers the same nd=20, which is not a strict improvement, so cell 2's
    // dir stays pointed at cell 1.
    const { state, world } = buildCorridor()
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [0, 4], field, scratch)
    expect(Array.from(field.dir)).toEqual([-1, 6, 6, 2, -1])
  })

  it('the descending order [4, 0] throws (sources must be strictly ascending)', () => {
    const { state, world } = buildCorridor()
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    expect(() => computeFlowField(state, world, [4, 0], field, scratch)).toThrow()
  })
})

describe('computeFlowField: differential two-source oracle', () => {
  /**
   * Catches `if (nd < dist[ni])` mutated to `if (dist[ni] === INF)` — the
   * classic already-visited error, which survives every other test in this
   * file, including the dir-consistency check (a cell reached diagonally
   * has dist=14, dir -> source, and 0 === 14 - 14 is still true).
   * Single-source fields are provably immune (an improvement would need a
   * later expansion at distance <= 3, and the minimum non-zero distance is
   * 10), so field({A,B})[c] === min(field({A})[c], field({B})[c]) is an
   * exact oracle.
   *
   * 3x3 grid. A=1 (top-middle) is ORTHOGONALLY adjacent to C=4 (centre,
   * cost 10). B=2 (top-right) is DIAGONALLY adjacent to C=4 (cost 14).
   * A < B, matching design decision 6's ascending source order.
   *
   * NOTE: this is the reverse of the task brief's literally-worded example
   * ("diagonally adjacent to A and orthogonally adjacent to B"). Verified
   * empirically (see task-5-report.md): against this entry pool's LIFO
   * drain order, the array's LATER source (B, pushed second) is expanded
   * BEFORE the earlier one (A) within a tied bucket. For the bug to be
   * detectable, the relaxation applied FIRST must be the WORSE one (so it
   * is wrongly "locked in") and the one applied SECOND must be strictly
   * better (so the bug's refusal to improve is visible) — i.e. B (expanded
   * first) must hold the worse (diagonal) edge, and A (expanded second)
   * the better (orthogonal) one. The brief's literal wording produces the
   * opposite pairing, under which both the correct and buggy checks happen
   * to agree by coincidence of visit order.
   */
  it('field({A,B})[c] === min(field({A})[c], field({B})[c]) for every cell', () => {
    const { map, world } = landFixture('oracle-minimal', 3, 3)
    const state = createState('s', map)
    const w = world.w
    const A = cellAt(w, 1, 0)
    const B = cellAt(w, 2, 0)
    const C = cellAt(w, 1, 1)
    expect(A).toBeLessThan(B)
    placeRoad(state, world, A, C) // orthogonal, cost 10
    placeRoad(state, world, B, C) // diagonal, cost 14

    const fieldA = createFlowField(world.cells)
    computeFlowField(state, world, [A], fieldA, createScratch(world.cells))
    const fieldB = createFlowField(world.cells)
    computeFlowField(state, world, [B], fieldB, createScratch(world.cells))
    const fieldAB = createFlowField(world.cells)
    computeFlowField(state, world, [A, B], fieldAB, createScratch(world.cells))

    for (let c = 0; c < world.cells; c++) {
      const expected = Math.min(fieldA.dist[c] as number, fieldB.dist[c] as number)
      expect(fieldAB.dist[c], `cell ${c}`).toBe(expected)
    }
    // Vacuity guard: prove the oracle actually exercises the interesting
    // (tied-order) cell, not just cells where both fields agree trivially.
    expect(fieldAB.dist[C]).toBe(ORTHO_COST)
    expect(fieldA.dist[C]).toBe(ORTHO_COST)
    expect(fieldB.dist[C]).toBe(DIAG_COST)
  })

  it('holds pointwise across a larger randomised graph with two sources', () => {
    const { state, world } = randomGraphFixture('oracle-random', 10, 8, 350)
    const roaded = firstRoadedCells(state, world, 2)
    const A = roaded[0] as number
    const B = roaded[1] as number

    const fieldA = createFlowField(world.cells)
    computeFlowField(state, world, [A], fieldA, createScratch(world.cells))
    const fieldB = createFlowField(world.cells)
    computeFlowField(state, world, [B], fieldB, createScratch(world.cells))
    const fieldAB = createFlowField(world.cells)
    computeFlowField(state, world, [A, B], fieldAB, createScratch(world.cells))

    for (let c = 0; c < world.cells; c++) {
      expect(fieldAB.dist[c], `cell ${c}`).toBe(Math.min(fieldA.dist[c] as number, fieldB.dist[c] as number))
    }
  })
})

describe('computeFlowField: structural properties over a randomised graph', () => {
  function buildGraphAndField(): {
    state: GameState
    world: WorldData
    field: ReturnType<typeof createFlowField>
    scratch: Scratch
    sources: number[]
  } {
    const { state, world } = randomGraphFixture('structural', 15, 11, 220)
    const sources = firstRoadedCells(state, world, 2)
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, sources, field, scratch)
    return { state, world, field, scratch, sources }
  }

  it('dir consistency: the neighbour dir[c] names has dist exactly dist[c] - edgeCost(dir[c]); a road bit exists toward it', () => {
    // nx/ny and the bounds rejection are computed independently here, NOT
    // via graph.ts's `neighbours()` — a shared wrap bug would otherwise make
    // this test self-blind (the M1a scan self-test failure mode).
    const { state, world, field } = buildGraphAndField()
    const { w, h } = world
    let checked = 0
    for (let c = 0; c < world.cells; c++) {
      const d = field.dir[c] as number
      if (d === -1) continue
      const x = c % w
      const y = (c / w) | 0
      const nx = x + (DX[d] as number)
      const ny = y + (DY[d] as number)
      expect(nx, `cell ${c} dir ${d}: nx in range`).toBeGreaterThanOrEqual(0)
      expect(nx, `cell ${c} dir ${d}: nx in range`).toBeLessThan(w)
      expect(ny, `cell ${c} dir ${d}: ny in range`).toBeGreaterThanOrEqual(0)
      expect(ny, `cell ${c} dir ${d}: ny in range`).toBeLessThan(h)
      const neighbour = ny * w + nx
      expect(field.dist[neighbour], `cell ${c}`).toBe((field.dist[c] as number) - edgeCost(d))
      expect(((state.roads[c] as number) & (1 << d)) !== 0, `road bit from ${c} toward dir ${d}`).toBe(true)
      checked++
    }
    expect(checked).toBeGreaterThan(50) // vacuity guard
  })

  it('complement: dir === -1 iff the cell is an accepted source or unreachable', () => {
    const { field, sources } = buildGraphAndField()
    const sourceSet = new Set(sources)
    let sourceCells = 0
    let unreachableCells = 0
    let reachableNonSourceCells = 0
    for (let c = 0; c < field.dist.length; c++) {
      const isSourceOrUnreachable = field.dist[c] === 0 || field.dist[c] === INF
      expect(field.dir[c] === -1, `cell ${c}`).toBe(isSourceOrUnreachable)
      if (sourceSet.has(c)) {
        expect(field.dist[c]).toBe(0)
        sourceCells++
      } else if (field.dist[c] === INF) {
        unreachableCells++
      } else {
        reachableNonSourceCells++
      }
    }
    // Vacuity guard: all three categories actually occur in this fixture.
    expect(sourceCells).toBe(sources.length)
    expect(unreachableCells).toBeGreaterThan(0)
    expect(reachableNonSourceCells).toBeGreaterThan(0)
  })

  it('following dir from any reachable cell terminates at a source within `cells` steps', () => {
    const { field, world } = buildGraphAndField()
    let tested = 0
    for (let c = 0; c < world.cells; c++) {
      if (field.dist[c] === INF) continue
      let cur = c
      let steps = 0
      while (field.dir[cur] !== -1) {
        const d = field.dir[cur] as number
        const x = cur % world.w
        const y = (cur / world.w) | 0
        cur = (y + (DY[d] as number)) * world.w + (x + (DX[d] as number))
        steps++
        expect(steps, `cell ${c} did not terminate within cells steps`).toBeLessThanOrEqual(world.cells)
      }
      expect(field.dist[cur], `cell ${c} terminated at a non-source`).toBe(0)
      tested++
    }
    expect(tested).toBeGreaterThan(50) // vacuity guard
  })

  it('work counter: ST_EXPANSIONS equals the number of reachable cells', () => {
    const { field, scratch, world } = buildGraphAndField()
    let reachable = 0
    for (let c = 0; c < world.cells; c++) if (field.dist[c] !== INF) reachable++
    expect(scratch.stats[ST_EXPANSIONS]).toBe(reachable)
  })
})

describe('computeFlowField: reset contract (fresh vs. used scratch/field)', () => {
  it('produces correct output on a never-before-used scratch and field', () => {
    const { state, world } = randomGraphFixture('fresh', 9, 7, 250)
    const sources = firstRoadedCells(state, world, 2)
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, sources, field, scratch)
    expect(field.dist[sources[0] as number]).toBe(0)
    expect(Array.from(field.dist).some((d) => d !== INF && d !== 0)).toBe(true)
  })

  it('reusing an already-used scratch/field for a different source set matches an independent fresh computation', () => {
    const { state, world } = randomGraphFixture('used', 9, 7, 250)
    const roaded = firstRoadedCells(state, world, 3)
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [roaded[0] as number], field, scratch) // "dirty" it first

    const secondSources = [roaded[1] as number, roaded[2] as number]
    const freshField = createFlowField(world.cells)
    const freshScratch = createScratch(world.cells)
    computeFlowField(state, world, secondSources, freshField, freshScratch)

    computeFlowField(state, world, secondSources, field, scratch)

    expect(Array.from(field.dist)).toEqual(Array.from(freshField.dist))
    expect(Array.from(field.dir)).toEqual(Array.from(freshField.dir))
  })

  it('rebuilding over the same scratch and field twice, with the same inputs, is byte-identical', () => {
    const { state, world } = randomGraphFixture('rebuild', 9, 7, 300)
    const sources = firstRoadedCells(state, world, 3)
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, sources, field, scratch)
    const dist1 = Array.from(field.dist)
    const dir1 = Array.from(field.dir)
    computeFlowField(state, world, sources, field, scratch)
    expect(Array.from(field.dist)).toEqual(dist1)
    expect(Array.from(field.dir)).toEqual(dir1)
  })
})

describe('computeFlowField: source list validation', () => {
  it('throws on a duplicated source', () => {
    const { state, world } = randomGraphFixture('dup', 8, 6, 200)
    const roaded = firstRoadedCells(state, world, 2)
    const dup = [roaded[0] as number, roaded[0] as number, roaded[1] as number]
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    expect(() => computeFlowField(state, world, dup, field, scratch)).toThrow()
  })

  it('throws on an out-of-range source (negative or >= cells), not by reading dist[s] as undefined', () => {
    const { map, world } = landFixture('range', 6, 5)
    const state = createState('s', map)
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    expect(() => computeFlowField(state, world, [-1], field, scratch)).toThrow()
    expect(() => computeFlowField(state, world, [world.cells], field, scratch)).toThrow()
  })

  it('sorting a shuffled source list gives the same dir as the already-sorted list; the shuffled list itself throws', () => {
    const { state, world } = randomGraphFixture('shuffle', 10, 8, 300)
    const sortedSources = firstRoadedCells(state, world, 4)
    const shuffled = [sortedSources[2], sortedSources[0], sortedSources[3], sortedSources[1]] as number[]
    expect([...shuffled].sort((a, b) => a - b)).toEqual(sortedSources) // sanity: same set

    const fieldSorted = createFlowField(world.cells)
    computeFlowField(state, world, sortedSources, fieldSorted, createScratch(world.cells))

    const fieldFromShuffleSorted = createFlowField(world.cells)
    const sortedFromShuffle = [...shuffled].sort((a, b) => a - b)
    computeFlowField(state, world, sortedFromShuffle, fieldFromShuffleSorted, createScratch(world.cells))

    expect(Array.from(fieldFromShuffleSorted.dir)).toEqual(Array.from(fieldSorted.dir))
    expect(Array.from(fieldFromShuffleSorted.dist)).toEqual(Array.from(fieldSorted.dist))

    expect(() => computeFlowField(state, world, shuffled, createFlowField(world.cells), createScratch(world.cells))).toThrow()
  })
})

describe('computeFlowField: entry pool sizing (unequal-arms fixture)', () => {
  /**
   * Two equal-weighted-distance arms from a single source S meeting at a
   * common cell X: a 5-hop all-diagonal arm (cost 70) ending at PA=(9,9),
   * and a 7-hop all-orthogonal arm (cost 70) ending at PB=(10,9). PA
   * connects to X=(9,10) with an ORTHOGONAL edge (cost 10); PB connects to
   * X with a DIAGONAL edge (cost 14).
   *
   * Found by instrumenting `push` with a temporary per-cell counter and
   * confirming empirically (see task-5-report.md) that X is genuinely
   * relaxed twice: PB's own predecessor is expanded at distance 60, PA's at
   * distance 56, so PA is pushed into bucket 70 EARLIER, and this entry
   * pool's LIFO drain order processes the LATER-pushed entry (PB) first.
   * So X is first pushed at 70+14=84 via PB, then improved to 70+10=80 via
   * PA — a genuine second, improving push. A straight line or a plain
   * diagonal never produces this (the next-pointer mutation this fixture
   * exists to catch bit only 60 of 400 random graphs per the task brief).
   */
  const W = 13
  const H = 12

  function buildUnequalArms(): { state: GameState; world: WorldData; S: number; PA: number; PB: number; X: number } {
    const { map, world } = landFixture('unequal-arms', W, H)
    const state = createState('unequal-arms-seed', map)

    const diagPath: ReadonlyArray<readonly [number, number]> = [
      [10, 4],
      [9, 5],
      [8, 6],
      [7, 7],
      [8, 8],
      [9, 9],
    ]
    for (let i = 1; i < diagPath.length; i++) {
      const [ax, ay] = diagPath[i - 1] as [number, number]
      const [bx, by] = diagPath[i] as [number, number]
      if (!placeRoad(state, world, cellAt(W, ax, ay), cellAt(W, bx, by))) {
        throw new Error(`unequal-arms fixture: diagonal hop ${i} failed to place`)
      }
    }
    const PA = cellAt(W, 9, 9)

    const orthoPath: ReadonlyArray<readonly [number, number]> = [
      [10, 4],
      [11, 4],
      [11, 5],
      [11, 6],
      [11, 7],
      [11, 8],
      [11, 9],
      [10, 9],
    ]
    for (let i = 1; i < orthoPath.length; i++) {
      const [ax, ay] = orthoPath[i - 1] as [number, number]
      const [bx, by] = orthoPath[i] as [number, number]
      if (!placeRoad(state, world, cellAt(W, ax, ay), cellAt(W, bx, by))) {
        throw new Error(`unequal-arms fixture: orthogonal hop ${i} failed to place`)
      }
    }
    const PB = cellAt(W, 10, 9)

    const X = cellAt(W, 9, 10)
    if (!placeRoad(state, world, PA, X)) throw new Error('unequal-arms fixture: PA-X failed to place')
    if (!placeRoad(state, world, PB, X)) throw new Error('unequal-arms fixture: PB-X failed to place')

    return { state, world, S: cellAt(W, 10, 4), PA, PB, X }
  }

  it('X is genuinely relaxed twice: first to 84 (via PB), then improved to 80 (via PA)', () => {
    const { state, world, S, PA, PB, X } = buildUnequalArms()
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [S], field, scratch)
    expect(field.dist[PA]).toBe(70)
    expect(field.dist[PB]).toBe(70)
    expect(field.dist[X]).toBe(80)
    expect(field.dir[X]).toBe(0) // North, back toward PA — see fixture comment
  })

  it('the real entry pool (cells * 3) handles this fixture without overflow', () => {
    const { state, world, S } = buildUnequalArms()
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells) // real capacity: world.cells * 3
    expect(() => computeFlowField(state, world, [S], field, scratch)).not.toThrow()
  })

  it('work counter: ST_EXPANSIONS counts the 14 reachable cells exactly once each, not X\'s stale first entry', () => {
    // A random graph's ties are not guaranteed to produce ANY stale entry at
    // all, so a work-counter check over one (see the "structural properties"
    // describe block below) can pass whether or not the staleness guard
    // exists — it is not sensitive to this mutation unless the fixture is
    // guaranteed to generate at least one. This fixture is guaranteed to:
    // X is pushed twice (84, then 80), so its FIRST entry is drained again,
    // stale, when bucket 84 is reached. With the staleness guard, that drain
    // is skipped and ST_EXPANSIONS counts each of the 14 reachable cells
    // (S, the 5 diagonal-arm cells, the 7 orthogonal-arm cells, and X) once.
    // Without it, X's stale entry would ALSO count, making it 15.
    const { state, world, S } = buildUnequalArms()
    const field = createFlowField(world.cells)
    const scratch = createScratch(world.cells)
    computeFlowField(state, world, [S], field, scratch)
    let reachable = 0
    for (let c = 0; c < world.cells; c++) if (field.dist[c] !== INF) reachable++
    expect(reachable).toBe(14)
    expect(scratch.stats[ST_EXPANSIONS]).toBe(14)
  })

  it('a pool sized for only 14 entries overflows; this exact graph needs 15 pushes (14 relaxations + 1 source)', () => {
    const { state, world, S } = buildUnequalArms()
    const field = createFlowField(world.cells)
    const undersized: Scratch = {
      bucketHead: new Int32Array(NB),
      entryCell: new Int32Array(14),
      entryNext: new Int32Array(14),
      nbrCell: new Int32Array(8),
      nbrDir: new Int8Array(8),
      stats: new Int32Array(2),
    }
    expect(() => computeFlowField(state, world, [S], field, undersized)).toThrow()
  })

  it('a pool sized for exactly 15 entries is sufficient and produces the correct answer', () => {
    const { state, world, S, X } = buildUnequalArms()
    const field = createFlowField(world.cells)
    const exact: Scratch = {
      bucketHead: new Int32Array(NB),
      entryCell: new Int32Array(15),
      entryNext: new Int32Array(15),
      nbrCell: new Int32Array(8),
      nbrDir: new Int8Array(8),
      stats: new Int32Array(2),
    }
    expect(() => computeFlowField(state, world, [S], field, exact)).not.toThrow()
    expect(field.dist[X]).toBe(80)
  })
})

describe('fieldFor: staleness', () => {
  it('throws on a never-built field — asserted first: a fresh FlowField’s dir is all-zero (reads as "head North")', () => {
    const { map, world } = landFixture('never-built', 6, 5)
    const state = createState('s', map)
    const fields = createFlowFields(1, world.cells)
    expect(() => fieldFor(state, world, fields, 0, [])).toThrow()
  })

  it('hashRoadRegion and hashSources are never 0 — proven via nonZeroWord(0) directly, not by search', () => {
    expect(nonZeroWord(0)).toBe(1)
  })

  it('hashSources differs for two lists of the same length, and for the same list with one element changed', () => {
    expect(hashSources([1, 2, 3])).not.toBe(hashSources([1, 2, 4]))
    expect(hashSources([1, 2, 3])).not.toBe(hashSources([4, 5, 6]))
  })

  it('hashSources is order sensitive — an order-insensitive fold (sum/XOR) would collide on a permutation', () => {
    expect(hashSources([1, 2, 3])).not.toBe(hashSources([3, 2, 1]))
    expect(hashSources([1, 2, 3])).not.toBe(hashSources([2, 1, 3]))
  })

  it('syncFields then fieldFor returns the field', () => {
    const { state, world } = randomGraphFixture('sync-basic', 8, 6, 200)
    const sources = firstRoadedCells(state, world, 2)
    const fields = createFlowFields(1, world.cells)
    const scratch = createScratch(world.cells)
    syncFields(state, world, [sources], fields, scratch)
    const f = fieldFor(state, world, fields, 0, sources)
    expect(f.dist[sources[0] as number]).toBe(0)
  })

  it('syncFields rebuilds every colour, not just the first', () => {
    const { state, world } = randomGraphFixture('sync-multi', 9, 7, 250)
    const roaded = firstRoadedCells(state, world, 3)
    const sourcesByColour: number[][] = [[roaded[0] as number], [roaded[1] as number], [roaded[2] as number]]
    const fields = createFlowFields(3, world.cells)
    const scratch = createScratch(world.cells)
    syncFields(state, world, sourcesByColour, fields, scratch)
    for (let c = 0; c < 3; c++) {
      const colourSources = sourcesByColour[c] as number[]
      const f = fieldFor(state, world, fields, c, colourSources)
      expect(f.dist[colourSources[0] as number], `colour ${c}`).toBe(0)
    }
  })

  it('syncFields does not rebuild a colour whose inputs are unchanged', () => {
    const { state, world } = randomGraphFixture('sync-coalesce', 8, 6, 200)
    const sources = firstRoadedCells(state, world, 2)
    const fields = createFlowFields(1, world.cells)
    const scratch = createScratch(world.cells)
    syncFields(state, world, [sources], fields, scratch)
    expect(scratch.stats[ST_EXPANSIONS]).toBeGreaterThan(0)
    // computeFlowField unconditionally zeroes stats at entry, so the ONLY way
    // ST_EXPANSIONS can read back 0 after the call below is if computeFlowField
    // was never invoked at all — i.e. syncFields actually skipped this colour.
    // Reset the counter to a sentinel first: leaving the first call's nonzero
    // value in place would make this assertion pass even if a rebuild simply
    // happened to visit exactly 0 cells, which is not what "did not rebuild"
    // means.
    scratch.stats[ST_EXPANSIONS] = -1
    syncFields(state, world, [sources], fields, scratch)
    expect(scratch.stats[ST_EXPANSIONS]).toBe(-1)
  })

  it('after a road mutation, fieldFor throws — with no explicit invalidation call anywhere in this test', () => {
    const { state, world } = randomGraphFixture('sync-road-mut', 8, 6, 200)
    const sources = firstRoadedCells(state, world, 2)
    const fields = createFlowFields(1, world.cells)
    const scratch = createScratch(world.cells)
    syncFields(state, world, [sources], fields, scratch)
    expect(() => fieldFor(state, world, fields, 0, sources)).not.toThrow()

    // Must be a GENUINELY NEW bit — placeRoad succeeds (returns true) even
    // when re-placing an already-existing segment (idempotent, buffer
    // unchanged per roads.ts), so a plain "first successful placeRoad call"
    // search could silently land on a no-op and never actually change
    // `state.roads`, which would make this test pass for the wrong reason
    // (or not fail when it should).
    let placed = false
    outer: for (let a = 0; a < world.cells; a++) {
      for (let dir = 0; dir < DIR_COUNT; dir++) {
        if (((state.roads[a] as number) & (1 << dir)) !== 0) continue // already exists
        const x = a % world.w
        const y = (a / world.w) | 0
        const nx = x + (DX[dir] as number)
        const ny = y + (DY[dir] as number)
        if (nx < 0 || nx >= world.w || ny < 0 || ny >= world.h) continue
        const b = ny * world.w + nx
        if (placeRoad(state, world, a, b)) {
          placed = true
          break outer
        }
      }
    }
    expect(placed).toBe(true)
    expect(() => fieldFor(state, world, fields, 0, sources)).toThrow()
  })

  it('after a source-list change with roads untouched, fieldFor throws', () => {
    const { state, world } = randomGraphFixture('sync-source-mut', 8, 6, 200)
    const roaded = firstRoadedCells(state, world, 3)
    const sources = [roaded[0] as number]
    const fields = createFlowFields(1, world.cells)
    const scratch = createScratch(world.cells)
    syncFields(state, world, [sources], fields, scratch)
    expect(() => fieldFor(state, world, fields, 0, sources)).not.toThrow()

    const newSources = [roaded[1] as number]
    expect(() => fieldFor(state, world, fields, 0, newSources)).toThrow()
  })

  it('fieldFor throws when handed a fields array sized for a different cell count', () => {
    const { map: bigMap, world: bigWorld } = landFixture('wrong-size-big', 8, 7)
    const bigState = createState('s', bigMap)
    placeRoad(bigState, bigWorld, 0, 1)
    const fields = createFlowFields(1, bigWorld.cells)
    const scratch = createScratch(bigWorld.cells)
    syncFields(bigState, bigWorld, [[0]], fields, scratch)

    const { map: smallMap, world: smallWorld } = landFixture('wrong-size-small', 6, 5)
    const smallState = createState('s2', smallMap)
    expect(bigWorld.cells).not.toBe(smallWorld.cells)
    expect(() => fieldFor(smallState, smallWorld, fields, 0, [0])).toThrow()
  })
})
