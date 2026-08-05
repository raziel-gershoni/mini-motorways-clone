import { describe, it, expect } from 'vitest'
import {
  FOOTPRINT_CELL_COUNT,
  ORIENTATION_COUNT,
  ORIENTATION_E,
  ORIENTATION_N,
  ORIENTATION_S,
  ORIENTATION_W,
  isFootprintCell,
} from '@laneways/sim'
import { DEST_ORIENTATION_N, DEST_ORIENTATION_S, destFootprintH, destFootprintW } from '@laneways/render'

/**
 * The watcher for `render`'s **second copy of a destination's footprint
 * geometry**, and the reason it lives in `game`.
 *
 * `RenderFrame` hands `render` a destination as an anchor cell plus an
 * orientation byte (plan Decision 3 — everything that needs a *function* from
 * `sim` is called in `game`). Drawing the building therefore needs one fact that
 * did not come with the data: how big the box is. `sim/buildings.ts` keeps it in
 * a module-private `footprintWidth`/`footprintHeight` pair; `render` may not
 * import `sim` at all (spec §4, enforced by `packages/render/test/boundary.test.ts`),
 * so `packages/render/src/canvas.ts` carries its own.
 *
 * That is the third copied convention in this milestone, after `TerrainClass`
 * and the direction table, and the plan accepts a copy **on the condition that
 * it has one place to drift and one test watching it**. `render`'s own test can
 * only compare the copy against hand-written literals, which both halves of a
 * drift would pass. `game` imports both packages, so this is where the two can
 * meet — the same construction, and the same reason, as
 * `renderDirections.test.ts`.
 *
 * It compares against **`isFootprintCell`, `sim`'s own exported authority**,
 * rather than against a re-typed literal of the private pair. That is stronger
 * in two ways: it is the function `sim` itself uses to decide overlap, and
 * comparing over every cell of a board pins the **anchor convention** (the box's
 * top-left corner is the anchor) as well as the two dimensions.
 *
 * The failure mode this exists for: `sim` renumbers or reshapes an orientation,
 * `render` keeps drawing a 3x2 where the sim reserved a 2x3, and every
 * destination on screen is the wrong shape and in the wrong place relative to
 * the cells roads are refused on. Invisible in Node, and it looks like an art
 * bug.
 */

const W = 9
const H = 8
const ANCHOR_X = 3
const ANCHOR_Y = 2
const ANCHOR = ANCHOR_Y * W + ANCHOR_X

/** Every cell `sim` calls part of this destination's footprint, as "x,y" strings. */
function simFootprint(orientation: number): Set<string> {
  const cells = new Set<string>()
  for (let cell = 0; cell < W * H; cell++) {
    if (isFootprintCell(ANCHOR, orientation, W, cell)) {
      cells.add(`${cell % W},${Math.floor(cell / W)}`)
    }
  }
  return cells
}

/** Every cell `render` would paint, from its own width/height and the anchor. */
function renderFootprint(orientation: number): Set<string> {
  const cells = new Set<string>()
  for (let dy = 0; dy < destFootprintH(orientation); dy++) {
    for (let dx = 0; dx < destFootprintW(orientation); dx++) {
      cells.add(`${ANCHOR_X + dx},${ANCHOR_Y + dy}`)
    }
  }
  return cells
}

describe('render’s footprint box against sim’s isFootprintCell', () => {
  it('covers exactly the same cells, for every orientation', () => {
    expect(ORIENTATION_COUNT).toBe(4)
    for (let orientation = 0; orientation < ORIENTATION_COUNT; orientation++) {
      expect([...renderFootprint(orientation)].sort(), `orientation ${orientation}`).toEqual(
        [...simFootprint(orientation)].sort(),
      )
    }
  })

  it('compares six real cells each time, so the set equality is not two empty sets', () => {
    // Vacuity. `destFootprintW` returning 0 would make `renderFootprint` empty,
    // and an `isFootprintCell` that always refused would make the other empty —
    // and two empty sets are equal. The count is `sim`'s own constant, not a
    // literal 6 re-typed here.
    for (let orientation = 0; orientation < ORIENTATION_COUNT; orientation++) {
      expect(renderFootprint(orientation).size, `orientation ${orientation}`).toBe(
        FOOTPRINT_CELL_COUNT,
      )
      expect(simFootprint(orientation).size, `orientation ${orientation}`).toBe(
        FOOTPRINT_CELL_COUNT,
      )
    }
    expect(FOOTPRINT_CELL_COUNT).toBe(6)
  })

  it('distinguishes the two box SHAPES, so a swapped width and height is visible', () => {
    // Six cells can be 2x3 or 3x2, and the set-equality test above would catch a
    // swap only because the two shapes cover different cells at the same anchor.
    // Said directly as well, because that is the mutation the copy invites: N/S
    // are the tall pair and E/W the wide one.
    expect([destFootprintW(ORIENTATION_N), destFootprintH(ORIENTATION_N)]).toEqual([2, 3])
    expect([destFootprintW(ORIENTATION_S), destFootprintH(ORIENTATION_S)]).toEqual([2, 3])
    expect([destFootprintW(ORIENTATION_E), destFootprintH(ORIENTATION_E)]).toEqual([3, 2])
    expect([destFootprintW(ORIENTATION_W), destFootprintH(ORIENTATION_W)]).toEqual([3, 2])
    expect(destFootprintW(ORIENTATION_N)).not.toBe(destFootprintW(ORIENTATION_E))
  })

  it('agrees with sim on WHICH orientations are the tall pair', () => {
    // `render` names two orientation codes of its own — the only two it needs —
    // and if `sim` renumbered them the copy would select the wrong box for all
    // four values while still having two of each shape.
    expect(DEST_ORIENTATION_N).toBe(ORIENTATION_N)
    expect(DEST_ORIENTATION_S).toBe(ORIENTATION_S)
    expect(ORIENTATION_N).not.toBe(ORIENTATION_S)
  })

  it('anchors the box at its TOP-LEFT corner, which is what makes the cell sets line up', () => {
    // The convention `carparkCell` documents ("the origin is the box's top-left
    // corner in both orientations' box shapes"). Without this, a centred box
    // would still be six cells of the right shape and would sit a cell up and
    // left of everything sim reserved.
    for (let orientation = 0; orientation < ORIENTATION_COUNT; orientation++) {
      expect(isFootprintCell(ANCHOR, orientation, W, ANCHOR), `orientation ${orientation}`).toBe(
        true,
      )
      expect(isFootprintCell(ANCHOR, orientation, W, ANCHOR - 1)).toBe(false) // one cell left
      expect(isFootprintCell(ANCHOR, orientation, W, ANCHOR - W)).toBe(false) // one cell up
    }
  })
})
