import { describe, it, expect } from 'vitest'
import { parseMap, TERRAIN, type MapData } from '@laneways/shared'
import { createState, hashState, snapshot, restore, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { seedFromString, randomBelow } from '../src/rng'
import { hashBytes } from '../src/hash'
import {
  DIR_COUNT,
  DX,
  DY,
  OPPOSITE,
  dirBetween,
  stepCell,
  canPlaceRoad,
  assertPlaceCost,
  type PlaceResult,
  placeRoad,
  eraseRoad,
  roadMask,
  tilesLeft,
  hasTree,
  assertSymmetric,
  assertNoRoadOnImpassable,
} from '../src/roads'
import { ORIENTATION_N, DEST_KIND_SQUARE, carparkCell, isFootprintCell, placeHouse, placeDestination } from '../src/buildings'

/**
 * Non-square (w=6, h=4) fixture containing all four terrain codes, each
 * placed directly east of a LAND cell so every ordering (land->X and
 * X->land) is one `dirBetween` step away:
 *
 *   idx 0 LAND  -- idx 1 WATER    (row 0)
 *   idx 6 LAND  -- idx 7 MOUNTAIN (row 1)
 *   idx 12 LAND -- idx 13 TREE    (row 2)
 *   row 3 is all LAND, for plain LAND<->LAND geometry and budget tests.
 *
 * Non-square deliberately, per the milestone-wide rule: a square fixture
 * cannot distinguish `w` from `h` being swapped anywhere in the geometry.
 */
const ROWS = ['.~....', '.^....', '.T....', '......']
const W = 6
const H = 4

function fixture(startingTiles: number, id: string): { map: MapData; world: WorldData } {
  const map = parseMap(id, ROWS, startingTiles, 40, 16, 5)
  const world = createWorld(map)
  return { map, world }
}

/** The direction index k with DX[k] === 1, DY[k] === 0 — computed, not assumed. */
function eastDir(): number {
  for (let k = 0; k < DIR_COUNT; k++) {
    if ((DX[k] as number) === 1 && (DY[k] as number) === 0) return k
  }
  throw new Error('eastDir: no matching direction found')
}

/**
 * Hashes the buffer with the `cleared` region zeroed out. Used only by the
 * randomised whole-grid test's "erase everything" invariant: tree
 * destruction is deliberately irreversible (design decision 1), so a byte
 * comparison that includes `cleared` would fail even when every other
 * region has correctly returned to its starting value.
 */
function hashExcludingCleared(s: GameState): number {
  const bytes = new Uint8Array(s.buffer.slice(0))
  bytes.fill(0, s.cleared.byteOffset, s.cleared.byteOffset + s.cleared.byteLength)
  return hashBytes(bytes)
}

describe('DIR_COUNT / DX / DY / OPPOSITE', () => {
  it('DIR_COUNT is 8 and every table has that length', () => {
    expect(DIR_COUNT).toBe(8)
    expect(DX.length).toBe(8)
    expect(DY.length).toBe(8)
    expect(OPPOSITE.length).toBe(8)
  })

  it('OPPOSITE is its own inverse, and DX/DY negate under it, for every direction', () => {
    for (let k = 0; k < DIR_COUNT; k++) {
      const opp = OPPOSITE[k] as number
      expect(OPPOSITE[opp]).toBe(k)
      // Summed rather than compared to a negated literal: DX[k] === 0 makes
      // `-(DX[k])` negative zero, and `toBe` uses `Object.is`, under which
      // `0` and `-0` are distinct — a false failure unrelated to this rule.
      expect((DX[opp] as number) + (DX[k] as number)).toBe(0)
      expect((DY[opp] as number) + (DY[k] as number)).toBe(0)
    }
  })
})

describe('dirBetween', () => {
  it('returns the correct index for all eight neighbours of an interior cell on a non-square grid', () => {
    const x = 2
    const y = 1
    const from = y * W + x
    for (let k = 0; k < DIR_COUNT; k++) {
      const nx = x + (DX[k] as number)
      const ny = y + (DY[k] as number)
      const to = ny * W + nx
      expect(dirBetween(from, to, W, H), `direction ${k}`).toBe(k)
    }
  })

  it('rejects the right-edge row seam: dirBetween(w-1, w, w, h) === -1', () => {
    expect(dirBetween(W - 1, W, W, H)).toBe(-1)
  })

  it('rejects negative, >= w*h, and non-integer arguments', () => {
    expect(dirBetween(-1, 0, W, H)).toBe(-1)
    expect(dirBetween(0, -1, W, H)).toBe(-1)
    expect(dirBetween(W * H, 0, W, H)).toBe(-1)
    expect(dirBetween(0, W * H, W, H)).toBe(-1)
    expect(dirBetween(1.5, 0, W, H)).toBe(-1)
    expect(dirBetween(0, 1.5, W, H)).toBe(-1)
  })

  it('rejects a cell paired with itself', () => {
    expect(dirBetween(5, 5, W, H)).toBe(-1)
  })

  it('rejects north from row 0, south from row h-1, west from x=0, east from x=w-1', () => {
    // North from an arbitrary row-0 cell: the target index is negative.
    expect(dirBetween(3, 3 - W, W, H)).toBe(-1)
    // South from an arbitrary last-row cell: the target index is >= w*h.
    const lastRow = (H - 1) * W + 2
    expect(dirBetween(lastRow, lastRow + W, W, H)).toBe(-1)
    // West from x=0, not on row 0: the target is in-range but is the
    // previous row's last column — the row-seam case, mirrored.
    const westEdge = 2 * W + 0
    expect(dirBetween(westEdge, westEdge - 1, W, H)).toBe(-1)
    // East from x=w-1, not on the last row: the target wraps to the next
    // row's first column.
    const eastEdge = 1 * W + (W - 1)
    expect(dirBetween(eastEdge, eastEdge + 1, W, H)).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// stepCell — the four bounds, called DIRECTLY (M1d Task 1a)
// ---------------------------------------------------------------------------

describe('stepCell: the one shared grid step, and each of its four bounds', () => {
  /**
   * **ONE `it()` PER BOUND, and they are direct calls.** A single merged test
   * reports only the first bound to break, so a regression in two of them reads
   * as a regression in one — and three of the four fail in genuinely different
   * ways, which is exactly the information a merged test throws away.
   *
   * These four moved here from `dispatch.test.ts` when M1d Task 1a folded
   * `cars.ts`'s private copy and `dispatch.ts`'s exported copy into the single
   * one in `roads.ts`. The history is the reason they exist at all: M1c shipped
   * the function twice, `cars.test.ts` gave one copy four tests, and the other
   * copy — **the one dispatch actually called** — had zero, with all four bounds
   * surviving the whole suite.
   *
   * Direct calls and caller-level tests are two different obligations and
   * neither subsumes the other. Direct calls observe all four bounds. Through a
   * caller only three are observable, because `y < 0` is a verified equivalent
   * mutant there — see `roads.ts`'s own comment for the derivation, and
   * `cars.test.ts` / `dispatch.test.ts` for the caller-side halves.
   *
   * **Every marker below is past exactly ONE bound and exactly one cell past
   * it.** A cell in a diagonal corner is past two bounds at once, which makes
   * extending either one reach nothing — the catalogue records seven 0-detector
   * mutants from exactly that placement. Each `it()` asserts its marker's
   * in-range companion too, so the -1 is the bound answering rather than the
   * function refusing everything.
   */
  const NORTH = 0
  const EAST = 2
  const SOUTH = 4
  const WEST = 6

  /** `y * W + x` on the fixture's 6 x 4 board — non-square, so w and h cannot be swapped silently. */
  function at(x: number, y: number): number {
    return y * W + x
  }

  it('agrees with the DIRS table it is named against, so the four literals above are the right ones', () => {
    // Vacuity for the whole block: if these indices did not mean N/E/S/W, every
    // bound below would be exercised by the wrong step and could pass for the
    // wrong reason. Derived from the shared tables rather than re-typed.
    expect([DX[NORTH], DY[NORTH]]).toEqual([0, -1])
    expect([DX[EAST], DY[EAST]]).toEqual([1, 0])
    expect([DX[SOUTH], DY[SOUTH]]).toEqual([0, 1])
    expect([DX[WEST], DY[WEST]]).toEqual([-1, 0])
    // Non-square, or a w/h swap inside `stepCell` would be invisible.
    expect(W).not.toBe(H)
  })

  it('refuses a step E off the last column, rather than wrapping onto the next row (x >= w)', () => {
    // The marker is on row 1, one column past the east bound and nowhere near
    // either y bound. Without this half of the guard the step lands on cell 12
    // = (0, 2) — a real cell no caller ever named.
    expect(at(W - 1, 1) + 1).toBe(at(0, 2))
    expect(stepCell(at(W - 1, 1), EAST, W, H)).toBe(-1)
    // Vacuity: the same step one column left is a real move.
    expect(stepCell(at(W - 2, 1), EAST, W, H)).toBe(at(W - 1, 1))
  })

  it('refuses a step W off the first column, rather than wrapping onto the previous row (x < 0)', () => {
    // The same row-seam hazard in the other direction, and the one an
    // eastern-only fixture leaves untested. Row 2, so the y bounds are slack.
    expect(at(0, 2) - 1).toBe(at(W - 1, 1))
    expect(stepCell(at(0, 2), WEST, W, H)).toBe(-1)
    expect(stepCell(at(1, 2), WEST, W, H)).toBe(at(0, 2))
  })

  it('refuses a step S off the last row, rather than indexing past the grid (y >= h)', () => {
    // Distinct from the x bounds in its failure mode: this one produces an
    // index >= cells, which every caller reads back as `undefined` rather than
    // as a wrong-but-plausible cell.
    expect(at(2, H - 1) + W).toBe(W * H + 2)
    expect(stepCell(at(2, H - 1), SOUTH, W, H)).toBe(-1)
    expect(stepCell(at(2, H - 2), SOUTH, W, H)).toBe(at(2, H - 1))
  })

  it('refuses a step N off the first row (y < 0) — observable HERE and, by derivation, only here', () => {
    expect(at(2, 0) - W).toBe(-4)
    expect(stepCell(at(2, 0), NORTH, W, H)).toBe(-1)
    expect(stepCell(at(2, 1), NORTH, W, H)).toBe(at(2, 0))
    // The bound returns the sentinel -1, not merely "some negative number" —
    // which is the whole reason this bound is observable from a direct call and
    // from nowhere else. Dropping it returns -4 here; every caller collapses
    // both to one observable. See `roads.ts` for the derivation, and DO NOT
    // tighten a caller's `next < 0` to `next === -1` to manufacture one.
    expect(stepCell(at(2, 0), NORTH, W, H)).not.toBe(at(2, 0) - W)
  })

  it('returns the real neighbour in all eight directions from an interior cell', () => {
    // The bounds tests above are all negative. This is the positive half: a
    // guard that returned -1 for everything would satisfy four of five `it()`s
    // in this block and this is what refuses it.
    const c = at(2, 1)
    for (let k = 0; k < DIR_COUNT; k++) {
      expect(stepCell(c, k, W, H)).toBe(at(2 + (DX[k] as number), 1 + (DY[k] as number)))
    }
  })
})

describe('placeRoad geometry edge cases', () => {
  it('fails and changes nothing when placing across the right-edge row seam', () => {
    const { map, world } = fixture(50, 'edge-seam')
    const state = createState('edge-seam-seed', map)
    const before = hashState(state)
    const a = 1 * W + (W - 1) // row1, last column — LAND
    const b = a + 1 // numerically row2's first column — LAND, but not adjacent
    expect(world.terrain[a]).toBe(TERRAIN.LAND)
    expect(world.terrain[b]).toBe(TERRAIN.LAND)
    expect(canPlaceRoad(state, world, a, b)).toEqual({ ok: false, reason: 'not-adjacent' })
    expect(placeRoad(state, world, a, b)).toBe(false)
    expect(hashState(state)).toBe(before)
    expect(roadMask(state, a)).toBe(0)
    expect(roadMask(state, b)).toBe(0)
  })
})

describe('bounds checking in canPlaceRoad', () => {
  it('reports out-of-bounds for a negative, overflowing, or non-integer cell index', () => {
    const { map, world } = fixture(50, 'bounds')
    const state = createState('s', map)
    expect(canPlaceRoad(state, world, -1, 0)).toEqual({ ok: false, reason: 'out-of-bounds' })
    expect(canPlaceRoad(state, world, 0, world.cells)).toEqual({ ok: false, reason: 'out-of-bounds' })
    expect(canPlaceRoad(state, world, 1.5, 0)).toEqual({ ok: false, reason: 'out-of-bounds' })
  })
})

describe('terrain whitelist — checked on both endpoints', () => {
  it('rejects land -> water', () => {
    const { map, world } = fixture(50, 'terrain-lw')
    const state = createState('s', map)
    expect(canPlaceRoad(state, world, 0, 1)).toEqual({ ok: false, reason: 'terrain' })
  })

  it('rejects water -> land (reversed ordering — catches a single-endpoint check)', () => {
    const { map, world } = fixture(50, 'terrain-wl')
    const state = createState('s', map)
    expect(canPlaceRoad(state, world, 1, 0)).toEqual({ ok: false, reason: 'terrain' })
  })

  it('rejects land -> mountain', () => {
    const { map, world } = fixture(50, 'terrain-lm')
    const state = createState('s', map)
    expect(canPlaceRoad(state, world, 6, 7)).toEqual({ ok: false, reason: 'terrain' })
  })

  it('rejects mountain -> land (reversed ordering)', () => {
    const { map, world } = fixture(50, 'terrain-ml')
    const state = createState('s', map)
    expect(canPlaceRoad(state, world, 7, 6)).toEqual({ ok: false, reason: 'terrain' })
  })

  it('never mutates state on a terrain rejection', () => {
    const { map, world } = fixture(50, 'terrain-noop')
    const state = createState('s', map)
    const before = hashState(state)
    expect(placeRoad(state, world, 0, 1)).toBe(false)
    expect(placeRoad(state, world, 6, 7)).toBe(false)
    expect(hashState(state)).toBe(before)
  })
})

describe('TREE endpoints', () => {
  it('placing onto a tree endpoint succeeds, clears only that cell, and hasTree becomes false there', () => {
    const { map, world } = fixture(50, 'tree-place')
    const state = createState('s', map)
    expect(hasTree(state, world, 13)).toBe(true)
    expect(canPlaceRoad(state, world, 12, 13)).toEqual({ ok: true, cost: 2 })
    expect(placeRoad(state, world, 12, 13)).toBe(true)
    expect(hasTree(state, world, 13)).toBe(false)
    expect(state.cleared[13]).toBe(1)
    expect(state.cleared[12]).toBe(0) // the LAND endpoint is never marked
    for (let c = 0; c < world.cells; c++) {
      if (c !== 13) expect(state.cleared[c], `cleared[${c}]`).toBe(0)
    }
  })

  it('clears a TREE that is endpoint `a`, not only one that is endpoint `b`', () => {
    // The mirror of the test above, and it is not decoration: deleting
    // `cleared[a] = 1` from `placeRoad` left the WHOLE suite green, while
    // deleting the mirrored `cleared[b] = 1` on the next line failed three
    // tests. It slipped past both the 4000-iteration randomised sequence and
    // the Task 6 golden because once a cell has been cleared via the `b`
    // path the `a` write is idempotent, and the golden fixture's three
    // tree-clears all happen to arrive via `b`.
    //
    // If that write regressed, `hasTree` would report a standing tree on a
    // cell a road runs through — and M1c's spawn placement reads `hasTree`.
    const { map, world } = fixture(50, 'tree-place-as-a')
    const state = createState('s', map)
    expect(hasTree(state, world, 13)).toBe(true)
    expect(placeRoad(state, world, 13, 12)).toBe(true) // the TREE is endpoint `a` this time
    expect(state.cleared[13]).toBe(1)
    expect(hasTree(state, world, 13)).toBe(false)
    expect(state.cleared[12]).toBe(0) // the LAND endpoint is still never marked
  })

  it('placing between two LAND cells leaves cleared entirely zero', () => {
    const { map, world } = fixture(50, 'land-land')
    const state = createState('s', map)
    expect(placeRoad(state, world, 18, 19)).toBe(true) // row 3, all LAND
    for (let c = 0; c < world.cells; c++) expect(state.cleared[c]).toBe(0)
  })
})

describe('hasTree', () => {
  it('is false for non-tree terrain, true for an uncleared tree, false after clearing', () => {
    const { map, world } = fixture(50, 'has-tree')
    const state = createState('s', map)
    expect(hasTree(state, world, 0)).toBe(false) // LAND
    expect(hasTree(state, world, 13)).toBe(true) // TREE, uncleared
    placeRoad(state, world, 12, 13)
    expect(hasTree(state, world, 13)).toBe(false)
  })
})

describe('symmetry and partial erasure', () => {
  it('place sets both mirrored bits; erase clears both', () => {
    const { map, world } = fixture(50, 'sym')
    const state = createState('s', map)
    const dir = dirBetween(2, 3, W, H)
    expect(placeRoad(state, world, 2, 3)).toBe(true)
    expect(roadMask(state, 2) & (1 << dir)).not.toBe(0)
    expect(roadMask(state, 3) & (1 << (OPPOSITE[dir] as number))).not.toBe(0)
    expect(eraseRoad(state, world, 2, 3)).toBe(true)
    expect(roadMask(state, 2)).toBe(0)
    expect(roadMask(state, 3)).toBe(0)
  })

  it("erasing one segment leaves that cell's other segments intact", () => {
    const { map, world } = fixture(50, 'partial-erase')
    const state = createState('s', map)
    // Cell 14 connects north to 8 and east to 15 — both LAND, two distinct
    // directions. `eraseRoad` doing `roads[a] = 0; roads[b] = 0` would pass
    // every symmetry check (zeroing both sides is symmetric) but fails here.
    expect(placeRoad(state, world, 14, 8)).toBe(true)
    expect(placeRoad(state, world, 14, 15)).toBe(true)
    expect(eraseRoad(state, world, 14, 8)).toBe(true)

    const dirTo15 = dirBetween(14, 15, W, H)
    expect(roadMask(state, 14) & (1 << dirTo15)).not.toBe(0)
    expect(roadMask(state, 15) & (1 << (OPPOSITE[dirTo15] as number))).not.toBe(0)

    const dirTo8 = dirBetween(14, 8, W, H)
    expect(roadMask(state, 14) & (1 << dirTo8)).toBe(0)
    expect(roadMask(state, 8)).toBe(0)
  })
})

describe('canPlaceRoad cost accounting', () => {
  it('reports cost 2 for a fresh segment, 1 when extending, 0 for a duplicate', () => {
    const { map, world } = fixture(50, 'cost-accounting')
    const state = createState('s', map)
    expect(canPlaceRoad(state, world, 2, 3)).toEqual({ ok: true, cost: 2 })
    placeRoad(state, world, 2, 3)
    expect(canPlaceRoad(state, world, 3, 4)).toEqual({ ok: true, cost: 1 })
    placeRoad(state, world, 3, 4)
    expect(canPlaceRoad(state, world, 2, 3)).toEqual({ ok: true, cost: 0 })
  })
})

// ---------------------------------------------------------------------------
// canPlaceRoad's returns are frozen module-scope singletons (M1d Task 1b)
// ---------------------------------------------------------------------------

describe('canPlaceRoad allocates nothing per call', () => {
  /**
   * **`canPlaceRoad` runs inside the tick and used to allocate a fresh
   * `{ ok, ... }` on every call**: 40.6 / 41.7 / 44.3 B per call, measured by
   * `packages/game/test/allocation.test.ts`, and 38.0-39.4 B/frame in the M2
   * milestone review's differently-dense rig. It now returns one of eight
   * module-scope frozen singletons.
   *
   * **This block exists because the profiler is in the wrong package and is a
   * sampling instrument.** The allocation harness lives in `packages/game`, it
   * estimates rather than counts, and it can only see the paths its driver
   * happens to walk — the drag driver spends its budget in the first few
   * strokes, so almost every call it makes returns `budget`. Identity is the
   * property that actually forbids the allocation, it is deterministic, and it
   * is checkable here, in the package that owns the code, for every outcome
   * rather than for the one the driver reaches. Reverting any single `return`
   * to a literal turns exactly one of these red.
   *
   * Frozen-ness is the other half and it is not decoration: a shared instance
   * that a caller can scribble on is a worse defect than the allocation was,
   * because the next caller sees the scribble. `PlaceResult` is `readonly` in
   * the type system, which stops nothing at run time.
   */
  const DW = 8
  const DH = 6

  interface Outcomes {
    readonly state: GameState
    readonly world: WorldData
    /** Every outcome `canPlaceRoad` can produce, as a zero-argument call. */
    readonly cases: ReadonlyArray<readonly [string, () => PlaceResult]>
  }

  /**
   * An 8x6 all-LAND board carrying a destination (footprint (2,1)..(3,3),
   * carpark (2,0)) and a two-segment road, so that **all eight outcomes are
   * reachable from one fixture** — five refusals and all three costs. Building
   * them from one board is what lets the "distinct outcomes are distinct
   * instances" assertion below compare them against each other.
   */
  function outcomes(id: string, startingTiles: number): Outcomes {
    const map = parseMap(id, ['........', '........', '........', '........', '........', '........'], startingTiles, 40, 16, 5)
    const world = createWorld(map)
    const state = createState(id, map)
    expect(placeDestination(state, world, 1 * DW + 2, ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    // Row 5 is clear of the footprint and of its carpark, so these are plain
    // land-to-land placements.
    const r0 = 5 * DW
    return {
      state,
      world,
      cases: [
        ['out-of-bounds', () => canPlaceRoad(state, world, -1, 0)],
        ['not-adjacent', () => canPlaceRoad(state, world, r0, r0 + 3)],
        // (2,1) is a footprint cell; (1,1) is off-footprint and 8-adjacent.
        ['building', () => canPlaceRoad(state, world, 1 * DW + 2, 1 * DW + 1)],
        ['cost 2', () => canPlaceRoad(state, world, r0, r0 + 1)],
        ['cost 1', () => canPlaceRoad(state, world, r0 + 1, r0 + 2)],
        ['cost 0', () => canPlaceRoad(state, world, r0, r0 + 1)],
      ],
    }
  }

  it('the fixture really does reach all eight outcomes, or every assertion below is about six of them', () => {
    // Vacuity first: a `cases` list whose entries silently produced the same
    // refusal would satisfy "frozen" and "stable" while proving nothing.
    const o = outcomes('outcome-cover', 50)
    const r0 = 5 * DW
    expect(o.cases[0]![1]()).toEqual({ ok: false, reason: 'out-of-bounds' })
    expect(o.cases[1]![1]()).toEqual({ ok: false, reason: 'not-adjacent' })
    expect(o.cases[2]![1]()).toEqual({ ok: false, reason: 'building' })
    expect(o.cases[3]![1]()).toEqual({ ok: true, cost: 2 })
    expect(placeRoad(o.state, o.world, r0, r0 + 1)).toBe(true)
    expect(o.cases[4]![1]()).toEqual({ ok: true, cost: 1 })
    expect(o.cases[5]![1]()).toEqual({ ok: true, cost: 0 })

    // The two outcomes the shared board cannot host at once, on their own
    // boards: `terrain` needs a non-LAND cell and `budget` needs an empty purse.
    const t = fixture(50, 'outcome-terrain')
    expect(canPlaceRoad(createState('s', t.map), t.world, 0, 1)).toEqual({ ok: false, reason: 'terrain' })
    const b = fixture(0, 'outcome-budget')
    expect(canPlaceRoad(createState('s', b.map), b.world, 2, 3)).toEqual({ ok: false, reason: 'budget' })
  })

  it('returns a FROZEN value for every outcome, so one caller cannot scribble on the next caller’s answer', () => {
    const o = outcomes('outcome-frozen', 50)
    for (const [name, call] of o.cases) {
      expect(Object.isFrozen(call()), `${name} is not frozen`).toBe(true)
    }
    const t = fixture(50, 'frozen-terrain')
    expect(Object.isFrozen(canPlaceRoad(createState('s', t.map), t.world, 0, 1))).toBe(true)
    const b = fixture(0, 'frozen-budget')
    expect(Object.isFrozen(canPlaceRoad(createState('s', b.map), b.world, 2, 3))).toBe(true)
  })

  it('returns the SAME instance for a repeated outcome — the deterministic form of "allocates nothing"', () => {
    const o = outcomes('outcome-identity', 50)
    for (const [name, call] of o.cases) {
      expect(call(), `${name} allocated a fresh object`).toBe(call())
    }
    // Across two independent states as well, which is the property a
    // per-`GameState` cache would NOT have.
    const t1 = fixture(50, 'identity-terrain-1')
    const t2 = fixture(50, 'identity-terrain-2')
    expect(canPlaceRoad(createState('s', t1.map), t1.world, 0, 1)).toBe(
      canPlaceRoad(createState('s', t2.map), t2.world, 0, 1),
    )
  })

  it('gives DIFFERENT outcomes different instances, so the singletons are not one collapsed object', () => {
    const o = outcomes('outcome-distinct', 50)
    const seen = new Set<PlaceResult>()
    for (const [, call] of o.cases.slice(0, 4)) seen.add(call())
    // 4 distinct outcomes reachable before any road is placed: out-of-bounds,
    // not-adjacent, building, cost 2. `cost 1`/`cost 0` need a placed road.
    expect(seen.size).toBe(4)
  })

  it('a caller cannot corrupt the shared instance, and a later independent call is unaffected', () => {
    const { map, world } = fixture(50, 'no-scribble')
    const state = createState('s', map)
    const first = canPlaceRoad(state, world, 2, 3)
    expect(first).toEqual({ ok: true, cost: 2 })

    /**
     * **This test repairs its own damage, and that is not tidiness.** The thing
     * it attempts is a write to a MODULE-SCOPE singleton. Under the mutation it
     * exists to catch — a missing `Object.freeze` — the write succeeds, and a
     * corrupted `{ ok: true, cost: 99 }` then leaks into every later test in
     * this file. Measured: without the restore below, dropping one
     * `Object.freeze` scored **9** failures, of which 2 were detectors and 7
     * were unrelated tests failing on poisoned state. An inflated detector count
     * is exactly as misleading as a fake one.
     */
    const before = (first as { cost: number }).cost
    let threw: unknown = null
    try {
      ;(first as { cost: number }).cost = 99
    } catch (e) {
      threw = e
    }
    if ((first as { cost: number }).cost !== before) (first as { cost: number }).cost = before

    // ESM is strict mode, so a write to a frozen property throws rather than
    // failing silently. Both halves matter: the throw, and the value after it.
    expect(threw, 'the shared result accepted a write — canPlaceRoad’s singleton is not frozen').toBeInstanceOf(
      TypeError,
    )
    expect(canPlaceRoad(state, world, 2, 3)).toEqual({ ok: true, cost: 2 })
  })

  it('names an impossible cost rather than returning undefined as a PlaceResult', () => {
    // Unreachable through `canPlaceRoad` — the cost is a sum of two ternaries
    // over {0, 1} — so it is exercised directly, on the precedent of
    // `assertSingleCrossing` and `assertDispatchProgress`. Without it, an
    // out-of-range index returns `undefined` and fails at whichever caller
    // reads `.ok` next, with no mention of `roads.ts`.
    expect(() => assertPlaceCost(-1)).toThrow(/placement cost of -1 is outside/)
    expect(() => assertPlaceCost(3)).toThrow(/placement cost of 3 is outside/)
    expect(() => assertPlaceCost(1.5)).toThrow(/placement cost of 1.5 is outside/)
    // Both directions of the bound: 0 and 2 are the two ends of the real range.
    expect(() => assertPlaceCost(0)).not.toThrow()
    expect(() => assertPlaceCost(1)).not.toThrow()
    expect(() => assertPlaceCost(2)).not.toThrow()
  })
})

describe('tile budget', () => {
  it('decrements by 2 for a fresh segment, 1 when extending, 0 for a duplicate', () => {
    const { map, world } = fixture(10, 'budget-decrement')
    const state = createState('s', map)
    expect(tilesLeft(state)).toBe(10)
    expect(placeRoad(state, world, 2, 3)).toBe(true)
    expect(tilesLeft(state)).toBe(8)
    expect(placeRoad(state, world, 3, 4)).toBe(true)
    expect(tilesLeft(state)).toBe(7)
    expect(placeRoad(state, world, 2, 3)).toBe(true)
    expect(tilesLeft(state)).toBe(7)
  })

  it('erase refunds by the same per-cell rule', () => {
    const { map, world } = fixture(10, 'budget-refund')
    const state = createState('s', map)
    placeRoad(state, world, 2, 3)
    placeRoad(state, world, 3, 4)
    expect(tilesLeft(state)).toBe(7)
    expect(eraseRoad(state, world, 2, 3)).toBe(true) // 2 empties (refund 1), 3 still holds 3-4
    expect(tilesLeft(state)).toBe(8)
    expect(eraseRoad(state, world, 3, 4)).toBe(true) // both empty now
    expect(tilesLeft(state)).toBe(10)
  })

  it('zero budget rejects a fresh placement', () => {
    const { map, world } = fixture(0, 'zero-fresh')
    const state = createState('s', map)
    const before = hashState(state)
    expect(canPlaceRoad(state, world, 2, 3)).toEqual({ ok: false, reason: 'budget' })
    expect(placeRoad(state, world, 2, 3)).toBe(false)
    expect(hashState(state)).toBe(before)
  })

  it('zero budget rejects a one-cell extension', () => {
    const { map, world } = fixture(2, 'zero-extend')
    const state = createState('s', map)
    expect(placeRoad(state, world, 2, 3)).toBe(true) // spends exactly the 2 starting tiles
    expect(tilesLeft(state)).toBe(0)
    const before = hashState(state)
    expect(canPlaceRoad(state, world, 3, 4)).toEqual({ ok: false, reason: 'budget' })
    expect(placeRoad(state, world, 3, 4)).toBe(false)
    expect(hashState(state)).toBe(before)
  })

  it('zero budget accepts a segment that is already present, at exactly { ok: true, cost: 0 }', () => {
    // Named separately from the general zero-budget tests: a budget-first
    // implementation (`if (tilesLeft === 0) return budget-failure` before
    // computing cost) rejects a fresh placement and a one-cell extension
    // for the same reason as the correct implementation, so those two tests
    // cannot distinguish it. Only a duplicate at zero budget can, because
    // the correct order (bounds -> terrain -> cost -> budget) computes
    // cost 0 first and never reaches the budget check's rejection branch.
    const { map, world } = fixture(2, 'zero-duplicate')
    const state = createState('s', map)
    expect(placeRoad(state, world, 2, 3)).toBe(true)
    expect(tilesLeft(state)).toBe(0)
    const before = hashState(state)
    expect(canPlaceRoad(state, world, 2, 3)).toEqual({ ok: true, cost: 0 })
    expect(placeRoad(state, world, 2, 3)).toBe(true)
    expect(hashState(state)).toBe(before)
    expect(tilesLeft(state)).toBe(0)
  })
})

describe('every rejection leaves the hash unchanged', () => {
  it('out-of-bounds, not-adjacent, terrain, no-op-erase, and budget all leave hashState untouched', () => {
    const { map, world } = fixture(2, 'all-rejections')
    const state = createState('s', map)

    const checkNoOp = (fn: () => unknown): void => {
      const before = hashState(state)
      fn()
      expect(hashState(state)).toBe(before)
    }

    checkNoOp(() => placeRoad(state, world, -1, 0))
    checkNoOp(() => placeRoad(state, world, 1 * W + (W - 1), 1 * W + (W - 1) + 1))
    checkNoOp(() => placeRoad(state, world, 0, 1))
    checkNoOp(() => eraseRoad(state, world, 2, 3))

    expect(placeRoad(state, world, 2, 3)).toBe(true) // spends the whole 2-tile budget
    checkNoOp(() => placeRoad(state, world, 4, 5))
  })
})

describe('no-op erase', () => {
  // Named separately from the place/erase round trip below: that test uses a
  // real erase and never reaches this path at all.
  it('erasing a segment that was never placed is a no-op and refunds nothing', () => {
    const { map, world } = fixture(50, 'no-op-erase')
    const state = createState('s', map)
    const before = hashState(state)
    const beforeTiles = tilesLeft(state)
    expect(eraseRoad(state, world, 2, 3)).toBe(false)
    expect(hashState(state)).toBe(before)
    expect(tilesLeft(state)).toBe(beforeTiles)
  })
})

describe('three-point hash round trip', () => {
  it('hash differs after place and returns to the original after erase', () => {
    const { map, world } = fixture(50, 'three-point')
    const state = createState('s', map)
    const hashBefore = hashState(state)
    expect(placeRoad(state, world, 2, 3)).toBe(true)
    const hashAfterPlace = hashState(state)
    expect(hashAfterPlace).not.toBe(hashBefore)
    expect(eraseRoad(state, world, 2, 3)).toBe(true)
    expect(hashState(state)).toBe(hashBefore)
  })
})

describe('assertSymmetric and assertNoRoadOnImpassable', () => {
  it('assertSymmetric does not throw for a state produced only through placeRoad/eraseRoad', () => {
    const { map, world } = fixture(50, 'assert-sym-pos')
    const state = createState('s', map)
    placeRoad(state, world, 2, 3)
    placeRoad(state, world, 3, 4)
    eraseRoad(state, world, 2, 3)
    expect(() => assertSymmetric(state, world)).not.toThrow()
  })

  it('assertSymmetric throws when a bit is set on only one side', () => {
    const { map, world } = fixture(50, 'assert-sym-oneside')
    const state = createState('s', map)
    const dir = dirBetween(2, 3, W, H)
    state.roads[2] = 1 << dir // deliberately corrupt: no mirror bit at 3
    expect(() => assertSymmetric(state, world)).toThrow()
  })

  it('assertSymmetric throws when a road bit points off the right edge (row-seam self-blindness)', () => {
    // What this discriminates, precisely — and why leaving out the mirror
    // write below (which looks like the obviously-simpler version of this
    // test) makes it vacuous:
    //
    // A correct `assertSymmetric` decomposes to x/y and rejects a bit
    // whose neighbour falls outside [0,w)x[0,h) BEFORE it ever looks at
    // that neighbour's mask. A self-blind implementation instead computes
    // the "neighbour" as `cell + dx + dy*w` with no bounds check at all,
    // so a bit at (w-1, y) pointing "east" lands, numerically, on
    // (0, y+1) — the very row-seam wrap this test is named for — and it
    // proceeds to compare masks with THAT cell as if it were a real
    // neighbour.
    //
    // If only `roads[cell]`'s bit were set (the tempting, "obviously
    // sufficient" version of this test), the untouched wrapped cell would
    // have an all-zero mask, so the self-blind implementation's ordinary
    // "no mirrored bit at the neighbour" branch would ALSO throw — for a
    // completely unrelated reason. `.toThrow()` would pass against BOTH
    // implementations, and this test would not be testing what its name
    // claims.
    //
    // So the mirror bit is set at the WRAPPED target too: under the
    // self-blind implementation's own (wrong) arithmetic, the pair now
    // looks perfectly mirror-symmetric, and it reports no violation at
    // all. Only the correct implementation still throws, via its
    // off-grid branch, before it ever reaches a mask comparison. That
    // gap between "throws" and "does not throw" is the actual
    // discrimination this test needs — do not "simplify" this back down
    // to a single write.
    const { map, world } = fixture(50, 'assert-sym-rowseam')
    const state = createState('s', map)
    const cell = 1 * W + (W - 1) // row1, last column — LAND
    const dir = eastDir()
    const wrappedTarget = cell + 1 // numerically row2, first column, under cell+dx+dy*w
    state.roads[cell] = 1 << dir
    state.roads[wrappedTarget] = 1 << (OPPOSITE[dir] as number)
    expect(() => assertSymmetric(state, world)).toThrow()
  })

  it('assertNoRoadOnImpassable does not throw for a state produced only through placeRoad', () => {
    const { map, world } = fixture(50, 'assert-impassable-pos')
    const state = createState('s', map)
    placeRoad(state, world, 2, 3)
    expect(() => assertNoRoadOnImpassable(state, world)).not.toThrow()
  })

  it('assertNoRoadOnImpassable throws when a road bit is forced onto water', () => {
    const { map, world } = fixture(50, 'assert-impassable-neg')
    const state = createState('s', map)
    state.roads[1] = 1 // WATER cell, corrupted directly, bypassing placeRoad
    expect(() => assertNoRoadOnImpassable(state, world)).toThrow()
  })
})

describe('design decision 1 — cleared lives in the buffer, terrain never changes', () => {
  it('world.terrain is byte-identical before and after a place/erase sequence', () => {
    const { map, world } = fixture(50, 'terrain-immutable')
    const state = createState('s', map)
    const before = Array.from(world.terrain)
    placeRoad(state, world, 12, 13) // clears the tree
    placeRoad(state, world, 2, 3)
    eraseRoad(state, world, 2, 3)
    expect(Array.from(world.terrain)).toEqual(before)
  })

  it('rolls back tree destruction via snapshot/restore', () => {
    const { map, world } = fixture(50, 'tree-rollback')
    const state = createState('s', map)

    // Snapshot BEFORE the tree is cleared — this is the checkpoint the test
    // rolls back to. Snapshotting after clearing would bake `cleared[13] = 1`
    // into the checkpoint and the tree could never come back, which would
    // defeat the entire point of this test: it is the rollback the
    // `cleared` region exists to make possible, and which was
    // architecturally impossible when the reviewed draft wrote trees
    // directly into `world.terrain`.
    const checkpoint = snapshot(state)
    expect(hasTree(state, world, 13)).toBe(true)

    expect(placeRoad(state, world, 12, 13)).toBe(true) // clears the tree
    expect(hasTree(state, world, 13)).toBe(false)
    expect(placeRoad(state, world, 2, 3)).toBe(true) // more placement, elsewhere

    const restored = restore(checkpoint, world)
    expect(hasTree(restored, world, 13)).toBe(true) // the tree is back
    expect(roadMask(restored, 12)).toBe(0) // neither road exists pre-checkpoint
    expect(roadMask(restored, 2)).toBe(0)
  })
})

describe('randomised whole-grid sequence', () => {
  it('maintains every invariant across a long seeded sequence of place/erase attempts', () => {
    const startingTiles = 1000 // ample: this test is not about the budget edge cases, those have dedicated tests above
    const map = parseMap('roads-random-seq', ROWS, startingTiles, 40, 16, 5)
    const world = createWorld(map)
    const state = createState('roads-random-seq-seed', map)

    const initialTerrain = Array.from(world.terrain)
    const initialHashExCleared = hashExcludingCleared(state)

    // A driver store independent of `state.rng`: roads.ts never touches rng
    // (there is nothing here that would — see the module comment), so using
    // `state.rng` to pick these operations would advance the real stream for
    // a reason unconnected to roads.ts, and would break the "erase
    // everything restores the initial state" check below purely because the
    // rng region no longer matches, not because anything under test failed.
    const driver = new Uint32Array(1)
    driver[0] = seedFromString('roads-random-seq-driver')

    const ITERATIONS = 4000
    let placedOk = 0
    let erasedOk = 0
    const terrainTouched = new Set<number>()
    const expectedCleared = new Set<number>()

    for (let i = 0; i < ITERATIONS; i++) {
      const a = randomBelow(driver, 0, world.cells)
      const dir = randomBelow(driver, 0, DIR_COUNT)
      const x = a % world.w
      const y = (a / world.w) | 0
      const nx = x + (DX[dir] as number)
      const ny = y + (DY[dir] as number)
      const bInGrid = nx >= 0 && nx < world.w && ny >= 0 && ny < world.h
      const b = bInGrid ? ny * world.w + nx : -1

      terrainTouched.add(world.terrain[a] as number)
      if (bInGrid) terrainTouched.add(world.terrain[b] as number)

      const wantErase = randomBelow(driver, 0, 3) === 0

      if (wantErase) {
        const before = hashState(state)
        if (eraseRoad(state, world, a, b)) {
          erasedOk++
        } else {
          expect(hashState(state)).toBe(before)
        }
      } else {
        const before = hashState(state)
        const expected = canPlaceRoad(state, world, a, b)
        const placed = placeRoad(state, world, a, b)
        expect(placed).toBe(expected.ok)
        if (placed) {
          placedOk++
          if (world.terrain[a] === TERRAIN.TREE) expectedCleared.add(a)
          if (bInGrid && world.terrain[b] === TERRAIN.TREE) expectedCleared.add(b)
        } else {
          expect(hashState(state)).toBe(before)
        }
      }

      assertSymmetric(state, world)
      assertNoRoadOnImpassable(state, world)
    }

    // Vacuity self-check (progress.md:5): a `placeRoad` that always returns
    // `false` (or one that fails on some arbitrary predicate) would make
    // every assertion below true vacuously.
    expect(placedOk).toBeGreaterThan(500)
    expect(erasedOk).toBeGreaterThan(100)
    expect(terrainTouched.size).toBe(4)

    // Design decision 1: terrain outside the buffer never changes.
    expect(Array.from(world.terrain)).toEqual(initialTerrain)

    // Conservation: the strongest single assertion available in this task —
    // it catches every budget leak, every one-sided write, and every stray
    // bit in one line.
    let roadCells = 0
    for (let c = 0; c < world.cells; c++) if (roadMask(state, c) !== 0) roadCells++
    expect(map.startingTiles - tilesLeft(state)).toBe(roadCells)

    // Erase everything that remains, one segment at a time (from the
    // lower-indexed cell's side only, so each segment is erased exactly
    // once rather than twice).
    for (let cell = 0; cell < world.cells; cell++) {
      const mask = roadMask(state, cell)
      if (mask === 0) continue
      for (let k = 0; k < DIR_COUNT; k++) {
        if ((mask & (1 << k)) === 0) continue
        const cx = cell % world.w
        const cy = (cell / world.w) | 0
        const nx2 = cx + (DX[k] as number)
        const ny2 = cy + (DY[k] as number)
        const neighbour = ny2 * world.w + nx2
        if (cell < neighbour) eraseRoad(state, world, cell, neighbour)
      }
    }

    expect(tilesLeft(state)).toBe(map.startingTiles)
    for (let c = 0; c < world.cells; c++) expect(roadMask(state, c), `roadMask(${c})`).toBe(0)

    // cleared is deliberately NOT reversible (design decision 1): assert it
    // byte-for-byte against exactly the cells a road ever touched while that
    // cell was a TREE, and exclude it from the hash comparison below.
    for (let c = 0; c < world.cells; c++) {
      expect(state.cleared[c], `cleared[${c}]`).toBe(expectedCleared.has(c) ? 1 : 0)
    }

    expect(hashExcludingCleared(state)).toBe(initialHashExCleared)
  })
})

describe('the driveway rule (M1c decision 5)', () => {
  // A dedicated, larger (w=8, h=6) all-LAND fixture: the module-level ROWS
  // fixture (6x4) is deliberately small for the terrain-code coverage above
  // and has no room left for a 2x3-or-3x2 footprint plus a carpark plus
  // spacing from the grid edge.
  const DW = 8
  const DH = 6
  const DEST_ROWS = ['........', '........', '........', '........', '........', '........']

  function driveFixture(id: string): { map: MapData; world: WorldData } {
    const map = parseMap(id, DEST_ROWS, 50, 40, 16, 5)
    return { map, world: createWorld(map) }
  }

  it('road may be placed onto a house cell', () => {
    const { map, world } = driveFixture('drive-house')
    const state = createState('s', map)
    const houseCell = 3 * DW + 5 // clear of the destination fixture below
    expect(placeHouse(state, world, houseCell, 0)).toBe(true)
    expect(canPlaceRoad(state, world, houseCell, houseCell + 1)).toMatchObject({ ok: true })
    expect(placeRoad(state, world, houseCell, houseCell + 1)).toBe(true)
  })

  it('road may be placed onto a carpark cell', () => {
    const { map, world } = driveFixture('drive-carpark')
    const state = createState('s', map)
    const destCell = 1 * DW + 2 // footprint (2,1)-(3,1)-(2,2)-(3,2)-(2,3)-(3,3), carpark (2,0)
    expect(placeDestination(state, world, destCell, ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    const cp = carparkCell(destCell, ORIENTATION_N, DW, DH)
    expect(canPlaceRoad(state, world, cp, cp + 1)).toMatchObject({ ok: true })
    expect(placeRoad(state, world, cp, cp + 1)).toBe(true)
  })

  it('road onto each of the six footprint cells is rejected with reason building, both endpoints checked', () => {
    const { map, world } = driveFixture('drive-footprint')
    const state = createState('s', map)
    const destX0 = 2
    const destCell = 1 * DW + destX0 // x0=2, y0=1 -> footprint columns {2,3}, rows {1,2,3}
    expect(placeDestination(state, world, destCell, ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)

    const footprintCells: number[] = []
    for (let c = 0; c < world.cells; c++) {
      if (isFootprintCell(destCell, ORIENTATION_N, DW, c)) footprintCells.push(c)
    }
    // Vacuity: the fixture's destination genuinely has 6 footprint cells.
    expect(footprintCells.length).toBe(6)

    // For every footprint cell, its west (if it is the footprint's west
    // column, x=2) or east (if it is the east column, x=3) neighbour is
    // guaranteed off-footprint for every row, since the footprint is
    // exactly 2 columns wide — a genuine, hand-verified 8-adjacent pair,
    // never a footprint-to-footprint pair that would pass vacuously.
    for (const fc of footprintCells) {
      const x = fc % DW
      const outside = x === destX0 ? fc - 1 : fc + 1
      expect(isFootprintCell(destCell, ORIENTATION_N, DW, outside), `outside cell ${outside} must be off-footprint`).toBe(false)

      expect(canPlaceRoad(state, world, fc, outside)).toEqual({ ok: false, reason: 'building' })
      expect(placeRoad(state, world, fc, outside)).toBe(false)
      // Reversed: the footprint cell as endpoint `b`, not just `a`.
      expect(canPlaceRoad(state, world, outside, fc)).toEqual({ ok: false, reason: 'building' })
      expect(placeRoad(state, world, outside, fc)).toBe(false)
    }

    // No tiles were spent on any of the 24 rejected attempts above.
    expect(tilesLeft(state)).toBe(map.startingTiles)
  })

  it('placeRoad inherits the rejection: the buffer is unchanged after a footprint-cell attempt', () => {
    const { map, world } = driveFixture('drive-footprint-noop')
    const state = createState('s', map)
    const destCell = 1 * DW + 2
    expect(placeDestination(state, world, destCell, ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    const before = hashState(state)
    // (2,1) [a footprint cell] to (1,1) [off-footprint, genuinely adjacent].
    expect(placeRoad(state, world, destCell, destCell - 1)).toBe(false)
    expect(hashState(state)).toBe(before)
  })
})
