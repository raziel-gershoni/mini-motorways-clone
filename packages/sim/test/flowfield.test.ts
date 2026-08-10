import { describe, it, expect } from 'vitest'
import { parseMap, ORTHO_COST, DIAG_COST, type MapData } from '@laneways/shared'
import { createState, nonZeroWord, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { placeRoad, DIR_COUNT, DX, DY } from '../src/roads'
import { seedFromString, randomBelow } from '../src/rng'
import { edgeCost } from '../src/graph'
import { hashBytes } from '../src/hash'
import {
  createFlowField,
  createFlowFields,
  createScratch,
  DISTINCT_EDGE_COSTS,
  INF,
  NB,
  ST_EXPANSIONS,
  ST_PUSHES,
  type FlowField,
  type Scratch,
} from '../src/scratch'
import { computeFlowField, hashSources, hashFieldInputRegions, syncFields, fieldFor } from '../src/flowfield'
import { createFieldInputRanges } from '../src/regions'

/**
 * Fixtures and helpers shared across this file. All-LAND boards throughout:
 * terrain gating is graph.ts's concern (already covered by its own
 * randomised property test), so these fixtures need bounds/shape variety
 * instead — hence non-square (w != h) wherever the exact dimensions matter.
 *
 * M1c widened `computeFlowField`/`hashSources` to a preallocated
 * `Int32Array` plus `(offset, count)`, and `syncFields`/`fieldFor` to read
 * sources from `scratch.sourcesFlat`/`scratch.sourceCounts` (keyed by
 * `world.map.maxDestinations`) rather than taking a `readonly number[]`
 * directly. The adapters below preserve every existing test's call SHAPE
 * (an array of numbers) while translating to the new API, so each test below
 * still reads as "these are the sources" rather than "these are the bytes."
 */

function cellAt(w: number, x: number, y: number): number {
  return y * w + x
}

/**
 * `maxDestinations: 16, groupCount: 5` by default — generous enough for
 * every fixture below (max 4 sources used anywhere in this file).
 * `groupCount` is overridable: `syncFields` now asserts `fields.length ===
 * map.groupCount`, and a handful of tests below need a fixture sized to
 * exactly the number of colours they exercise (e.g. a stats assertion that
 * would otherwise be clobbered by later, unrelated colours' rebuilds).
 */
function landFixture(
  id: string,
  w: number,
  h: number,
  groupCount = 5,
): { map: MapData; world: WorldData } {
  const rows = Array.from({ length: h }, () => '.'.repeat(w))
  const map = parseMap(id, rows, 999, 40, 16, groupCount)
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
  groupCount = 5,
): { state: GameState; world: WorldData } {
  const { map, world } = landFixture(id, w, h, groupCount)
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

// --- M1c call-shape adapters --------------------------------------------

/** `createScratch`, for tests that only ever call `computeField` — groupCount/maxDestinations are irrelevant to that path. */
function scratchOnly(world: WorldData): Scratch {
  return createScratch(world.cells, 1, world.map.maxDestinations, createFieldInputRanges(world.map))
}

/** `createScratch` sized for `groupCount` colours — required for `syncFieldsFromLists`/`fieldForColour` below, whose `syncFields` asserts `sourceCounts.length === fields.length`. */
function scratchFor(world: WorldData, groupCount: number): Scratch {
  return createScratch(world.cells, groupCount, world.map.maxDestinations, createFieldInputRanges(world.map))
}

/** `computeFlowField` over a plain source array, exactly M1b's call shape. */
function computeField(
  state: GameState,
  world: WorldData,
  sources: readonly number[],
  out: FlowField,
  scratch: Scratch,
): void {
  computeFlowField(state, world, Int32Array.from(sources), 0, sources.length, out, scratch)
}

/** `hashSources` over a plain source array. */
function hashSourceList(list: readonly number[]): number {
  return hashSources(Int32Array.from(list), 0, list.length)
}

/** Writes `list` into colour `colour`'s slice of `scratch.sourcesFlat`/`sourceCounts`, keyed by `world.map.maxDestinations` — the exact layout `syncFields`/`fieldFor` read. */
function setSources(scratch: Scratch, world: WorldData, colour: number, list: readonly number[]): void {
  const maxDestinations = world.map.maxDestinations
  scratch.sourceCounts[colour] = list.length
  for (let i = 0; i < list.length; i++) {
    scratch.sourcesFlat[colour * maxDestinations + i] = list[i] as number
  }
}

/** `syncFields` over per-colour plain source arrays, exactly M1b's call shape. */
function syncFieldsFromLists(
  state: GameState,
  world: WorldData,
  sourcesByColour: readonly (readonly number[])[],
  fields: readonly FlowField[],
  scratch: Scratch,
): void {
  for (let c = 0; c < sourcesByColour.length; c++) {
    setSources(scratch, world, c, sourcesByColour[c] as readonly number[])
  }
  syncFields(state, world, fields, scratch)
}

/** `fieldFor`, reading whatever `scratch` currently holds for `colour` (no separate `sources` parameter in the M1c signature). */
function fieldForColour(
  state: GameState,
  world: WorldData,
  fields: readonly FlowField[],
  colour: number,
  scratch: Scratch,
): FlowField {
  return fieldFor(state, world, fields, colour, scratch)
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
    const scratch = scratchOnly(world)
    computeField(state, world, [roadless, a], field, scratch)

    expect(field.dist[roadless]).toBe(INF)
    expect(field.dir[roadless]).toBe(-1)
    expect(field.dist[a]).toBe(0)
    expect(field.dir[a]).toBe(-1)
  })

  it('with every source rejected (all roadless), the field is entirely INF/-1', () => {
    const { map, world } = landFixture('all-rejected', 5, 4)
    const state = createState('s', map)
    const field = createFlowField(world.cells)
    const scratch = scratchOnly(world)
    computeField(state, world, [0, 3, 7], field, scratch)
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
    const scratch = scratchOnly(world)
    computeField(state, world, [cells[0] as number], field, scratch)

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
    const scratch = scratchOnly(world)
    computeField(state, world, [cells[0] as number], field, scratch)

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
    const scratch = scratchOnly(world)
    computeField(state, world, [source], field, scratch)

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
    const scratch = scratchOnly(world)
    computeField(state, world, [source], field, scratch)

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
    const scratch = scratchOnly(world)
    computeField(state, world, [0, 4], field, scratch)
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
    const scratch = scratchOnly(world)
    computeField(state, world, [0, 4], field, scratch)
    expect(Array.from(field.dir)).toEqual([-1, 6, 6, 2, -1])
  })

  it('the descending order [4, 0] throws (sources must be strictly ascending)', () => {
    const { state, world } = buildCorridor()
    const field = createFlowField(world.cells)
    const scratch = scratchOnly(world)
    expect(() => computeField(state, world, [4, 0], field, scratch)).toThrow()
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
    computeField(state, world, [A], fieldA, scratchOnly(world))
    const fieldB = createFlowField(world.cells)
    computeField(state, world, [B], fieldB, scratchOnly(world))
    const fieldAB = createFlowField(world.cells)
    computeField(state, world, [A, B], fieldAB, scratchOnly(world))

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
    computeField(state, world, [A], fieldA, scratchOnly(world))
    const fieldB = createFlowField(world.cells)
    computeField(state, world, [B], fieldB, scratchOnly(world))
    const fieldAB = createFlowField(world.cells)
    computeField(state, world, [A, B], fieldAB, scratchOnly(world))

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
    const scratch = scratchOnly(world)
    computeField(state, world, sources, field, scratch)
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

  it('work counters: ST_EXPANSIONS equals the number of reachable cells; ST_PUSHES stays within the DERIVED push bound', () => {
    const { field, scratch, world, sources } = buildGraphAndField()
    let reachable = 0
    for (let c = 0; c < world.cells; c++) if (field.dist[c] !== INF) reachable++
    expect(scratch.stats[ST_EXPANSIONS]).toBe(reachable)
    // Converts the pool-bound claim (entryPoolCapacity's doc comment) from
    // prose into a live assertion on a genuinely branching graph, rather
    // than only ever being checked on the one hand-built unequal-arms
    // fixture above.
    //
    // Bounded against the CLAIM, not against the allocation. The earlier
    // version of this line compared with `entryPoolCapacity(world.cells)` —
    // the same formula that sizes `entryCell`/`entryNext` — and `push()`
    // already throws at `top >= cap`, so that clause held by construction
    // whenever `computeFlowField` returned at all: verified inert by
    // inflating the capacity to `cells * 1000`, which still passed. This
    // bound is derived independently of the allocation from what
    // entryPoolCapacity's comment actually claims — at most 2 pushes per
    // non-source cell (a second improvement needs a strictly smaller edge
    // cost, and there are only DISTINCT_EDGE_COSTS of them), plus one per
    // source — so a change that makes the algorithm push more often is
    // caught here even if the pool was grown to accommodate it.
    //
    // The `2` is deliberately a literal and NOT `DISTINCT_EDGE_COSTS`: a
    // third edge cost tier (M1e — M1d shipped none, see `scratch.ts`'s
    // `DISTINCT_EDGE_COSTS`) would grow both that constant and
    // `entryPoolCapacity` together and leave a constant-derived bound just
    // as inert as the capacity one. Pinning the literal makes that change
    // fail here, which is where it should be reconsidered.
    const derivedPushBound = 2 * (world.cells - sources.length) + sources.length
    expect(scratch.stats[ST_PUSHES]).toBeGreaterThan(0)
    expect(scratch.stats[ST_PUSHES]).toBeLessThanOrEqual(derivedPushBound)
  })

  it('instrumented pushes-per-cell: max(pushesPerCell) <= DISTINCT_EDGE_COSTS over the same randomised graph', () => {
    // The proof this bounds: a non-source cell is pushed at most once per
    // distinct edge-cost value it can be IMPROVED by (a second improvement
    // needs a strictly smaller edge cost than the first), plus a source
    // cell is pushed exactly once (its distance, 0, can never improve). This
    // is the test that fails when that PROOF collapses — e.g. if a future
    // penalty applied inside computeFlowField (rather than through
    // edgeCost) let a cell be relaxed more than DISTINCT_EDGE_COSTS times —
    // rather than only when someone edits a literal (scratch.ts:62's
    // `expect(DISTINCT_EDGE_COSTS).toBe(2)` and graph.test.ts:254's
    // `expect(values.size).toBe(2)` do that job; this test is additive, not
    // a replacement).
    const { world, scratch } = buildGraphAndField()
    let maxPushes = 0
    for (let c = 0; c < world.cells; c++) {
      const p = scratch.pushesPerCell[c] as number
      if (p > maxPushes) maxPushes = p
    }
    expect(maxPushes).toBeGreaterThan(0) // vacuity: something was actually pushed
    expect(maxPushes).toBeLessThanOrEqual(DISTINCT_EDGE_COSTS)
  })

  it('pushesPerCell resets to 0 per computeFlowField call, not accumulated across rebuilds', () => {
    const { state, world, sources } = (() => {
      const { state, world } = randomGraphFixture('pushes-reset', 9, 7, 250)
      return { state, world, sources: firstRoadedCells(state, world, 2) }
    })()
    const field = createFlowField(world.cells)
    const scratch = scratchOnly(world)
    computeField(state, world, sources, field, scratch)
    const firstTotal = Array.from(scratch.pushesPerCell).reduce((a, b) => a + b, 0)
    expect(firstTotal).toBeGreaterThan(0)
    computeField(state, world, sources, field, scratch)
    const secondTotal = Array.from(scratch.pushesPerCell).reduce((a, b) => a + b, 0)
    // If the reset were dropped, the second call's per-cell counts would be
    // double the first's (same graph, same sources -> identical relaxation
    // pattern) rather than equal to it.
    expect(secondTotal).toBe(firstTotal)
  })
})

describe('computeFlowField: reset contract (fresh vs. used scratch/field)', () => {
  it('produces correct output on a never-before-used scratch and field', () => {
    const { state, world } = randomGraphFixture('fresh', 9, 7, 250)
    const sources = firstRoadedCells(state, world, 2)
    const field = createFlowField(world.cells)
    const scratch = scratchOnly(world)
    computeField(state, world, sources, field, scratch)
    expect(field.dist[sources[0] as number]).toBe(0)
    expect(Array.from(field.dist).some((d) => d !== INF && d !== 0)).toBe(true)
  })

  it('reusing an already-used scratch/field for a different source set matches an independent fresh computation', () => {
    const { state, world } = randomGraphFixture('used', 9, 7, 250)
    const roaded = firstRoadedCells(state, world, 3)
    const field = createFlowField(world.cells)
    const scratch = scratchOnly(world)
    computeField(state, world, [roaded[0] as number], field, scratch) // "dirty" it first

    const secondSources = [roaded[1] as number, roaded[2] as number]
    const freshField = createFlowField(world.cells)
    const freshScratch = scratchOnly(world)
    computeField(state, world, secondSources, freshField, freshScratch)

    computeField(state, world, secondSources, field, scratch)

    expect(Array.from(field.dist)).toEqual(Array.from(freshField.dist))
    expect(Array.from(field.dir)).toEqual(Array.from(freshField.dir))
  })

  it('rebuilding over the same scratch and field twice, with the same inputs, is byte-identical', () => {
    const { state, world } = randomGraphFixture('rebuild', 9, 7, 300)
    const sources = firstRoadedCells(state, world, 3)
    const field = createFlowField(world.cells)
    const scratch = scratchOnly(world)
    computeField(state, world, sources, field, scratch)
    const dist1 = Array.from(field.dist)
    const dir1 = Array.from(field.dir)
    computeField(state, world, sources, field, scratch)
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
    const scratch = scratchOnly(world)
    expect(() => computeField(state, world, dup, field, scratch)).toThrow()
  })

  it('throws on an out-of-range source (negative or >= cells), not by reading dist[s] as undefined', () => {
    const { map, world } = landFixture('range', 6, 5)
    const state = createState('s', map)
    const field = createFlowField(world.cells)
    const scratch = scratchOnly(world)
    expect(() => computeField(state, world, [-1], field, scratch)).toThrow()
    expect(() => computeField(state, world, [world.cells], field, scratch)).toThrow()
  })

  it('a fractional source is unreachable as of M1c, and that is stated rather than hidden', () => {
    // M1b's `readonly number[]` signature could carry a genuine fractional
    // JS number this far; M1c's `Int32Array` cannot — `Int32Array.from([2.5])`
    // truncates to `[2]` via ToInt32 (the exact same coercion a direct
    // `sourcesFlat[i] = 2.5` write would apply) before `computeFlowField`
    // ever sees the value, so a fractional element cannot exist in the
    // container this signature accepts. `computeFlowField`'s own
    // `Number.isInteger(s)` guard is kept anyway (see its module comment,
    // same reasoning as `hashSources`' length fold: cheap and independently
    // correct even though currently subsumed) — this test pins that the
    // widened API's OWN typed-array coercion is what closes the case the old
    // guard used to be the only defence against, not that the guard became
    // meaningless.
    expect(Int32Array.from([2.5])[0]).toBe(2) // the coercion, demonstrated directly
  })

  it('sorting a shuffled source list gives the same dir as the already-sorted list; the shuffled list itself throws', () => {
    const { state, world } = randomGraphFixture('shuffle', 10, 8, 300)
    const sortedSources = firstRoadedCells(state, world, 4)
    const shuffled = [sortedSources[2], sortedSources[0], sortedSources[3], sortedSources[1]] as number[]
    expect([...shuffled].sort((a, b) => a - b)).toEqual(sortedSources) // sanity: same set

    const fieldSorted = createFlowField(world.cells)
    computeField(state, world, sortedSources, fieldSorted, scratchOnly(world))

    const fieldFromShuffleSorted = createFlowField(world.cells)
    const sortedFromShuffle = [...shuffled].sort((a, b) => a - b)
    computeField(state, world, sortedFromShuffle, fieldFromShuffleSorted, scratchOnly(world))

    expect(Array.from(fieldFromShuffleSorted.dir)).toEqual(Array.from(fieldSorted.dir))
    expect(Array.from(fieldFromShuffleSorted.dist)).toEqual(Array.from(fieldSorted.dist))

    expect(() => computeField(state, world, shuffled, createFlowField(world.cells), scratchOnly(world))).toThrow()
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
    const scratch = scratchOnly(world)
    computeField(state, world, [S], field, scratch)
    expect(field.dist[PA]).toBe(70)
    expect(field.dist[PB]).toBe(70)
    expect(field.dist[X]).toBe(80)
    expect(field.dir[X]).toBe(0) // North, back toward PA — see fixture comment
  })

  it('the real entry pool (cells * 3) handles this fixture without overflow', () => {
    const { state, world, S } = buildUnequalArms()
    const field = createFlowField(world.cells)
    const scratch = scratchOnly(world) // real capacity: world.cells * 3
    expect(() => computeField(state, world, [S], field, scratch)).not.toThrow()
  })

  it('work counters: ST_EXPANSIONS counts the 14 reachable cells exactly once each (not X\'s stale first entry); ST_PUSHES counts exactly the known 15; both reset on rebuild', () => {
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
    //
    // ST_PUSHES is written and otherwise never read by anything in this
    // suite except via `Math.max` inside an array-length assertion — this is
    // the only place it is checked against a known value. This exact
    // fixture needs exactly 15 pushes: one per source (1), one per distinct
    // relaxation (13 of the 14 non-source reachable cells relaxed once each),
    // plus X's second, improving relaxation (1) = 1 + 13 + 1 = 15.
    const { state, world, S } = buildUnequalArms()
    const field = createFlowField(world.cells)
    const scratch = scratchOnly(world)
    computeField(state, world, [S], field, scratch)
    let reachable = 0
    for (let c = 0; c < world.cells; c++) if (field.dist[c] !== INF) reachable++
    expect(reachable).toBe(14)
    expect(scratch.stats[ST_EXPANSIONS]).toBe(14)
    expect(scratch.stats[ST_PUSHES]).toBe(15)

    // Rebuilding over the same (now "used") scratch must reset both
    // counters, not accumulate them — deleting `stats[ST_PUSHES] = 0` (or
    // `stats[ST_EXPANSIONS] = 0`) at entry is invisible on a FRESH scratch,
    // whose default is already 0, and only visible here, on a scratch that
    // already holds a nonzero count from the call above.
    computeField(state, world, [S], field, scratch)
    expect(scratch.stats[ST_EXPANSIONS]).toBe(14)
    expect(scratch.stats[ST_PUSHES]).toBe(15)
  })

  it('a pool sized for only 14 entries overflows; this exact graph needs 15 pushes (14 relaxations + 1 source)', () => {
    const { state, world, S } = buildUnequalArms()
    const field = createFlowField(world.cells)
    const undersized: Scratch = {
      ...scratchOnly(world),
      bucketHead: new Int32Array(NB),
      entryCell: new Int32Array(14),
      entryNext: new Int32Array(14),
      nbrCell: new Int32Array(8),
      nbrDir: new Int8Array(8),
      stats: new Int32Array(2),
    }
    expect(() => computeField(state, world, [S], field, undersized)).toThrow()
  })

  it('a pool sized for exactly 15 entries is sufficient and produces the correct answer', () => {
    const { state, world, S, X } = buildUnequalArms()
    const field = createFlowField(world.cells)
    const exact: Scratch = {
      ...scratchOnly(world),
      bucketHead: new Int32Array(NB),
      entryCell: new Int32Array(15),
      entryNext: new Int32Array(15),
      nbrCell: new Int32Array(8),
      nbrDir: new Int8Array(8),
      stats: new Int32Array(2),
    }
    expect(() => computeField(state, world, [S], field, exact)).not.toThrow()
    expect(field.dist[X]).toBe(80)
  })
})

describe('syncFields: a rebuild that throws must not leave the stamps describing content the field no longer holds', () => {
  /**
   * The claim design decision 3 rests on is that a `FlowField` may live
   * outside the snapshot because it is a pure function of what is inside.
   * That holds while `computeFlowField` returns. It does not hold when it
   * throws: `computeFlowField` wipes `dist`/`dir` at entry and validates
   * afterwards, so writing the stamps only on success leaves a destroyed
   * field still advertising the PREVIOUS, correct content — the next
   * `syncFields` sees matching stamps, skips the rebuild, and `fieldFor`
   * returns the wipe with no error at all.
   *
   * Both tests below follow the same three-tick shape, differing only in
   * WHERE the throw comes from — the pre-loop source validation, and the
   * middle of the drain loop — because the fix has to hold for a throw at
   * any point after the wipe, not just for one that happens to fire before
   * a single relaxation has run:
   *
   *   tick N    good build          -> stamps (h(inputs), h(sources))
   *   tick N+1  a rebuild that throws
   *   tick N+2  back to tick N's exact inputs
   *
   * At tick N+2 the stamps from tick N still match the (unchanged) roads and
   * (restored) sources, so without the zeroing this loop skips the rebuild
   * and serves whatever the throwing tick left behind.
   */
  function buildCorridorFixture(id: string): {
    state: GameState
    world: WorldData
    fields: FlowField[]
    scratch: Scratch
  } {
    const { map, world } = landFixture(id, 6, 1)
    const state = createState('s', map)
    placeChain(state, world, [0, 1, 2, 3, 4, 5])
    return {
      state,
      world,
      // fields.length must equal map.groupCount (syncFields' new guard);
      // landFixture's maps are all groupCount: 5, and only colour 0 is
      // exercised below — colours 1-4 stay unused, harmlessly.
      fields: createFlowFields(world.map.groupCount, world.cells),
      scratch: scratchFor(world, world.map.groupCount),
    }
  }

  const GOOD_DIST = [0, 10, 20, 30, 40, 50]

  it('a duplicate source (what M1c dispatch produces from two same-colour destinations on one access cell) leaves the field never-built, not stale-and-wrong', () => {
    const { state, world, fields, scratch } = buildCorridorFixture('throw-desync-dup')

    syncFieldsFromLists(state, world, [[0]], fields, scratch)
    expect(Array.from(fieldForColour(state, world, fields, 0, scratch).dist)).toEqual(GOOD_DIST)

    // Roads are untouched throughout: the ONLY thing that changes here is the
    // source list, and it changes back again below.
    expect(() => syncFieldsFromLists(state, world, [[0, 0]], fields, scratch)).toThrow(/strictly ascending/)
    // The wipe genuinely happened — this is the state the stamps would
    // otherwise be vouching for.
    expect(Array.from((fields[0] as FlowField).dist).every((d) => d === INF)).toBe(true)

    // Reported as a failed rebuild, not as "you forgot to sync".
    expect(() => fieldForColour(state, world, fields, 0, scratch)).toThrow(/never built/)

    // Same sources, same roads as tick N. Without the stamp zeroing both
    // stamps still match, syncFields skips, and this reads back all-INF.
    syncFieldsFromLists(state, world, [[0]], fields, scratch)
    expect(Array.from(fieldForColour(state, world, fields, 0, scratch).dist)).toEqual(GOOD_DIST)
  })

  it('an entry-pool exhaustion mid-drain — where the corruption looks plausible rather than empty — is handled the same way', () => {
    const { state, world, fields, scratch } = buildCorridorFixture('throw-desync-pool')

    syncFieldsFromLists(state, world, [[0]], fields, scratch)
    expect(Array.from(fieldForColour(state, world, fields, 0, scratch).dist)).toEqual(GOOD_DIST)

    // A pool with room for 2 entries: source 1 is pushed, its expansion
    // relaxes cell 0, and the relaxation of cell 2 overflows. The throw comes
    // from the middle of the drain loop with a partly relaxed field already
    // written — an all-INF field at least LOOKS broken, whereas this one
    // reads as a short, self-consistent, entirely wrong answer.
    const tinyPool: Scratch = {
      ...scratch,
      bucketHead: new Int32Array(NB),
      entryCell: new Int32Array(2),
      entryNext: new Int32Array(2),
      nbrCell: new Int32Array(8),
      nbrDir: new Int8Array(8),
      stats: new Int32Array(2),
    }
    setSources(tinyPool, world, 0, [1])
    expect(() => syncFields(state, world, fields, tinyPool)).toThrow(/entry pool exhausted/)
    expect(Array.from((fields[0] as FlowField).dist)).toEqual([10, 0, 10, INF, INF, INF])

    expect(() => fieldForColour(state, world, fields, 0, scratch)).toThrow(/never built/)

    syncFieldsFromLists(state, world, [[0]], fields, scratch)
    expect(Array.from(fieldForColour(state, world, fields, 0, scratch).dist)).toEqual(GOOD_DIST)
  })
})

describe('fieldFor: staleness', () => {
  it('throws on a never-built field — asserted first: a fresh FlowField’s dir is all-zero (reads as "head North")', () => {
    // The message is pinned, not merely the throw. Replacing the never-built
    // condition with `false` still throws — the stamp comparison two lines
    // below catches it, since 0 never equals a real hash — so a bare
    // `.toThrow()` here cannot tell the two branches apart, and this branch
    // is now the one that reports a rebuild that threw (see the describe
    // block above), where "stale — call syncFields" is actively misleading.
    const { map, world } = landFixture('never-built', 6, 5)
    const state = createState('s', map)
    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, world.map.groupCount)
    expect(() => fieldForColour(state, world, fields, 0, scratch)).toThrow(/never built/)
  })

  it('reports never-built for a HALF-written stamp pair too, not just for both stamps at 0', () => {
    // `syncFields` is the only writer of the stamps and always moves both
    // together, so `builtFromFieldInputs !== 0 && builtFromSources === 0` is
    // unreachable through the public API — and deleting either half of the
    // `||` therefore leaves the whole suite green without this test. That is
    // exactly the shape C1 was: a stamp pair that momentarily describes
    // something the field does not hold. The stamps are plain mutable fields
    // on `FlowField`, so a future writer that sets them one at a time (or
    // fails between the two) is a real reachable edit, and it must land in
    // the never-built branch rather than be reported as "stale — call
    // syncFields before reading it this tick", which sends the reader
    // hunting for a missing sync that is not the problem.
    const { map, world } = landFixture('half-stamp', 6, 5)
    const state = createState('s', map)
    placeRoad(state, world, 0, 1)
    const scratch = scratchFor(world, world.map.groupCount)
    setSources(scratch, world, 0, [0])

    for (const zeroed of ['builtFromFieldInputs', 'builtFromSources'] as const) {
      const fields = createFlowFields(world.map.groupCount, world.cells)
      syncFields(state, world, fields, scratch)
      expect(() => fieldForColour(state, world, fields, 0, scratch)).not.toThrow() // sanity: both stamps valid
      const field = fields[0] as FlowField
      field[zeroed] = 0
      expect(() => fieldForColour(state, world, fields, 0, scratch), zeroed).toThrow(/never built/)
    }
  })

  it('the nonZeroWord guard forces 0 to 1 — the same guard hashFieldInputRegions/hashSources both rely on to never present as "never built"; proven directly, not by an unbounded search for a colliding input', () => {
    expect(nonZeroWord(0)).toBe(1)
  })

  it('hashFieldInputRegions differs between two same-cell-count, differently-shaped boards, even with byte-identical roads content', () => {
    // A roads-only hash cannot see this: two boards with the same total
    // `cells` (6x4 and 4x6) but swapped `w`/`h` can have byte-for-byte
    // identical `roads` arrays while meaning something completely
    // different geometrically. `fieldFor`'s cell-count guard (`dist.length
    // === world.cells`) is a count, not a shape, so it cannot catch this
    // either. `mapIdentity` being a FIELD_INPUT region (M1c) is what closes
    // it: `mapIdentity` folds `w`/`h`, so two boards this different produce
    // two different `mapIdentity` byte contents even though `roads` alone
    // is identical. Not reachable today — one map per session, `createWorld`/
    // `createState` always paired — but the staleness key should not
    // depend on that pairing by convention rather than by construction.
    const mapA = parseMap('geom-6x4', Array.from({ length: 4 }, () => '......'), 999, 40, 16, 5) // w=6, h=4
    const mapB = parseMap('geom-4x6', Array.from({ length: 6 }, () => '....'), 999, 40, 16, 5) // w=4, h=6
    const worldA = createWorld(mapA)
    const worldB = createWorld(mapB)
    expect(worldA.cells).toBe(worldB.cells) // both 24, the collision precondition

    const stateA = createState('s', mapA)
    const stateB = createState('s', mapB)
    for (let i = 0; i < worldA.cells; i++) {
      const v = (i * 37) % 256
      stateA.roads[i] = v
      stateB.roads[i] = v
    }
    expect(Array.from(stateA.roads)).toEqual(Array.from(stateB.roads)) // byte-identical roads

    // A roads-only hash WOULD collide here — the precondition this test
    // exists to falsify for the real stamp.
    expect(hashBytes(stateA.roads)).toBe(hashBytes(stateB.roads))
    const rangesA = createFieldInputRanges(mapA)
    const rangesB = createFieldInputRanges(mapB)
    expect(hashFieldInputRegions(stateA, rangesA)).not.toBe(hashFieldInputRegions(stateB, rangesB))
  })

  it('hashSources differs for two lists of the same length, and for the same list with one element changed', () => {
    expect(hashSourceList([1, 2, 3])).not.toBe(hashSourceList([1, 2, 4]))
    expect(hashSourceList([1, 2, 3])).not.toBe(hashSourceList([4, 5, 6]))
  })

  it('hashSources is order sensitive — an order-insensitive fold (sum/XOR) would collide on a permutation', () => {
    expect(hashSourceList([1, 2, 3])).not.toBe(hashSourceList([3, 2, 1]))
    expect(hashSourceList([1, 2, 3])).not.toBe(hashSourceList([2, 1, 3]))
  })

  it('syncFields then fieldFor returns the field', () => {
    const { state, world } = randomGraphFixture('sync-basic', 8, 6, 200)
    const sources = firstRoadedCells(state, world, 2)
    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, world.map.groupCount)
    syncFieldsFromLists(state, world, [sources], fields, scratch)
    const f = fieldForColour(state, world, fields, 0, scratch)
    expect(f.dist[sources[0] as number]).toBe(0)
  })

  it('syncFields rebuilds every colour, not just the first', () => {
    const { state, world } = randomGraphFixture('sync-multi', 9, 7, 250)
    const roaded = firstRoadedCells(state, world, 3)
    const sourcesByColour: number[][] = [[roaded[0] as number], [roaded[1] as number], [roaded[2] as number]]
    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, world.map.groupCount)
    syncFieldsFromLists(state, world, sourcesByColour, fields, scratch)
    for (let c = 0; c < 3; c++) {
      const colourSources = sourcesByColour[c] as number[]
      const f = fieldForColour(state, world, fields, c, scratch)
      expect(f.dist[colourSources[0] as number], `colour ${c}`).toBe(0)
    }
  })

  it('syncFields does not rebuild a colour whose inputs are unchanged', () => {
    // groupCount: 1 — this test's ST_EXPANSIONS assertion is a
    // last-call-wins snapshot (`computeFlowField` overwrites `stats` fully
    // on every colour it processes), so a 5-colour fixture would have
    // colours 1-4's empty-source rebuilds clobber colour 0's real one.
    const { state, world } = randomGraphFixture('sync-coalesce', 8, 6, 200, 1)
    const sources = firstRoadedCells(state, world, 2)
    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, world.map.groupCount)
    syncFieldsFromLists(state, world, [sources], fields, scratch)
    expect(scratch.stats[ST_EXPANSIONS]).toBeGreaterThan(0)
    // computeFlowField unconditionally zeroes stats at entry, so the ONLY way
    // ST_EXPANSIONS can read back 0 after the call below is if computeFlowField
    // was never invoked at all — i.e. syncFields actually skipped this colour.
    // Reset the counter to a sentinel first: leaving the first call's nonzero
    // value in place would make this assertion pass even if a rebuild simply
    // happened to visit exactly 0 cells, which is not what "did not rebuild"
    // means.
    scratch.stats[ST_EXPANSIONS] = -1
    syncFieldsFromLists(state, world, [sources], fields, scratch)
    expect(scratch.stats[ST_EXPANSIONS]).toBe(-1)
  })

  it('syncFields rebuilds after sources change alone, and again after roads change alone — not just detects staleness once', () => {
    // Every other `syncFields` test in this file syncs from a fresh field
    // exactly once; the tests that change an input afterward (the two
    // below this one) only ever call `fieldFor` again and assert it
    // THROWS — they never call `syncFields` a second time. That is real
    // coverage for `fieldFor`'s staleness check, but it leaves the loop the
    // game actually runs every tick (sources or roads change -> `syncFields`
    // -> `fieldFor`) completely unexercised: `syncFields`'s own rebuild
    // condition independently re-implements the same "inputs AND sources"
    // check `fieldFor` makes, in its own line of source, and nothing here
    // proved the two agree. Three mutations at that one line all survive a
    // green suite without this test: `&&` -> `||`, "rebuild only if inputs
    // never matched" (ignoring the source stamp), and "rebuild only once,
    // ever" (ignoring both stamps after the first build) — the last of
    // which means the game builds its fields at startup and then ignores
    // every road the player draws for the rest of the run.
    //
    // A 4-cell row, 0-1-2 connected, 2-3 not (yet):
    const { map, world } = landFixture('sync-roundtrip', 4, 1)
    const state = createState('s', map)
    placeRoad(state, world, 0, 1)
    placeRoad(state, world, 1, 2)
    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, world.map.groupCount)

    syncFieldsFromLists(state, world, [[0]], fields, scratch)
    expect(Array.from(fieldForColour(state, world, fields, 0, scratch).dist)).toEqual([0, 10, 20, INF])

    // Sources change ONLY (roads untouched) -> re-sync -> must not throw,
    // and must actually reflect the new source, not the stale one.
    syncFieldsFromLists(state, world, [[2]], fields, scratch)
    expect(() => fieldForColour(state, world, fields, 0, scratch)).not.toThrow()
    expect(Array.from(fieldForColour(state, world, fields, 0, scratch).dist)).toEqual([20, 10, 0, INF])

    // Roads change ONLY (sources untouched, still [2]) -> re-sync -> must
    // not throw, and must actually reflect the new road.
    expect(placeRoad(state, world, 2, 3)).toBe(true)
    syncFieldsFromLists(state, world, [[2]], fields, scratch)
    expect(() => fieldForColour(state, world, fields, 0, scratch)).not.toThrow()
    expect(Array.from(fieldForColour(state, world, fields, 0, scratch).dist)).toEqual([20, 10, 0, 10])
  })

  it('syncFields throws when scratch.sourceCounts is shorter than fields, rather than a raw TypeError from inside hashSources', () => {
    const { map, world } = landFixture('sync-length-guard', 5, 4)
    const state = createState('s', map)
    // fields.length matches map.groupCount (5) so the NEW groupCount guard
    // passes; scratch is deliberately sized for only 1 colour so the
    // sourceCounts-shorter-than-fields guard is what actually fires.
    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, 1) // sized for 1 colour, fields has 5
    expect(() => syncFields(state, world, fields, scratch)).toThrow(/sourceCounts/)
  })

  it('throws when the scratch was sized for a different maxDestinations than the world — the other half of the same agreement', () => {
    // `syncFields` owns this check because it is the one place that holds both
    // numbers, and it previously owned only the `groupCount` half. Under-sizing
    // used to surface as `computeFlowField: source undefined is out of range
    // for N cells` — three frames deep, naming neither the cause nor a function
    // the caller can act on, and (through `step`) after `H_EPOCH` had already
    // been poisoned.
    const { map, world } = landFixture('sync-maxdest-guard', 5, 4)
    const state = createState('s', map)
    const fields = createFlowFields(world.map.groupCount, world.cells)
    const undersized = createScratch(
      world.cells,
      world.map.groupCount,
      world.map.maxDestinations - 1,
      createFieldInputRanges(world.map),
    )
    // Vacuity: the groupCount half genuinely passes, so this is the new guard
    // firing and not the old one.
    expect(undersized.sourceCounts.length).toBe(fields.length)
    expect(undersized.sourcesFlat.length).not.toBe(world.map.groupCount * world.map.maxDestinations)
    expect(() => syncFields(state, world, fields, undersized)).toThrow(/sourcesFlat/)

    // Over-sizing is the harmless direction — the slices simply sit further
    // apart and `hashSources` folds the same values — but it is rejected too,
    // deliberately: a scratch built for another map is a caller wiring bug
    // whichever way it is wrong, and "silently correct today" is how the
    // groupCount half would have been argued away as well.
    const oversized = createScratch(
      world.cells,
      world.map.groupCount,
      world.map.maxDestinations + 1,
      createFieldInputRanges(world.map),
    )
    expect(() => syncFields(state, world, fields, oversized)).toThrow(/sourcesFlat/)

    // And the correctly-sized one does not throw, so the guard is not simply
    // rejecting everything.
    expect(() => syncFields(state, world, fields, scratchFor(world, world.map.groupCount))).not.toThrow()
  })

  it('after a road mutation, fieldFor throws — with no explicit invalidation call anywhere in this test', () => {
    const { state, world } = randomGraphFixture('sync-road-mut', 8, 6, 200)
    const sources = firstRoadedCells(state, world, 2)
    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, world.map.groupCount)
    syncFieldsFromLists(state, world, [sources], fields, scratch)
    expect(() => fieldForColour(state, world, fields, 0, scratch)).not.toThrow()

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
    expect(() => fieldForColour(state, world, fields, 0, scratch)).toThrow()
  })

  it('after a source-list change with roads untouched, fieldFor throws', () => {
    const { state, world } = randomGraphFixture('sync-source-mut', 8, 6, 200)
    const roaded = firstRoadedCells(state, world, 3)
    const sources = [roaded[0] as number]
    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, world.map.groupCount)
    syncFieldsFromLists(state, world, [sources], fields, scratch)
    expect(() => fieldForColour(state, world, fields, 0, scratch)).not.toThrow()

    setSources(scratch, world, 0, [roaded[1] as number])
    expect(() => fieldForColour(state, world, fields, 0, scratch)).toThrow()
  })

  it('fieldFor throws when handed a fields array sized for a different cell count', () => {
    // Isolates the SIZE branch specifically, rather than merely producing
    // *some* throw: a naive version of this test paired the field's world
    // with an unrelated, differently-shaped world/state, whose `state.roads`
    // inevitably hashes differently too — so the staleness branch fires
    // first, `.toThrow()` passes either way, and mutating away the size
    // check (`if (false)`, or the tautology `dist.length !== dir.length`)
    // is invisible. Here `state` and `scratch`'s sources are the EXACT ones
    // the field was built from, so both stamps still match; a `world` that
    // agrees on everything except `cells` is the only remaining way to make
    // it throw, which is exactly the branch this test exists to pin.
    const { map, world } = landFixture('wrong-size', 8, 7)
    const state = createState('s', map)
    placeRoad(state, world, 0, 1)
    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, world.map.groupCount)
    syncFieldsFromLists(state, world, [[0]], fields, scratch)
    expect(() => fieldForColour(state, world, fields, 0, scratch)).not.toThrow() // sanity: matches today

    const mismatchedWorld: WorldData = { ...world, cells: world.cells + 1 }
    expect(() => fieldForColour(state, mismatchedWorld, fields, 0, scratch)).toThrow(/dist\.length/)
  })
})
