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
  canPlaceRoad,
  placeRoad,
  eraseRoad,
  roadMask,
  tilesLeft,
  hasTree,
  assertSymmetric,
  assertNoRoadOnImpassable,
} from '../src/roads'

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
  const map = parseMap(id, ROWS, startingTiles)
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
    // The specific hazard design decision 2 calls out: an implementation
    // that recomputes neighbours with the same wrap-prone arithmetic as a
    // buggy `dirBetween` would see this pair as mirror-symmetric.
    const { map, world } = fixture(50, 'assert-sym-rowseam')
    const state = createState('s', map)
    const cell = 1 * W + (W - 1) // row1, last column — LAND
    state.roads[cell] = 1 << eastDir()
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
    const map = parseMap('roads-random-seq', ROWS, startingTiles)
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
