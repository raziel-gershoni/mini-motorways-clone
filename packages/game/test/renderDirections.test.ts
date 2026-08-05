import { describe, it, expect } from 'vitest'
import { DIR_COUNT, DX, DY } from '@laneways/sim'
import { ROAD_DIR_COUNT, ROAD_DIR_DX, ROAD_DIR_DY } from '@laneways/render'

/**
 * The one test that can exist for `render`'s copy of the direction table, and
 * the reason it lives in `game`.
 *
 * `packages/render/src/atlas.ts` keeps its own `ROAD_DIR_DX`/`ROAD_DIR_DY`
 * because spec §4 forbids `render` importing `sim` and
 * `packages/render/test/boundary.test.ts` enforces that with a source scan. So
 * the atlas's understanding of "bit *i* means direction *i*" is a **second copy
 * of a numbering** — the same shape as `TerrainClass` vs `shared`'s `TERRAIN`,
 * which the plan accepts on the condition that the copy has *one place to
 * drift and one test watching it*.
 *
 * `TerrainClass` gets that watcher from `game`'s terrain fold (Task 6). The
 * direction table had none: `render`'s own test can only assert the copy
 * against hand-written literals, which is a check that both halves would pass
 * happily after `sim` renumbered its directions. The failure mode is not
 * subtle and it is not visible in Node — every diagonal road tile drawn with
 * its spokes on the wrong corners, first seen on a device.
 *
 * `game` depends on both packages, so this is where the two copies can be
 * compared. That is the whole test. It imports through the package specifiers
 * rather than relative paths, so it also pins that both tables are exported
 * from their packages' public surfaces.
 *
 * **Task 4 added this file** — it is not in the brief's file list. The brief
 * required "verified against the real bit order (roads.ts:92-95)" and a
 * verification that only a human re-reads is the catalogue's "a comment that
 * overstates its case" shape.
 */

describe('render’s direction table against sim’s', () => {
  it('agrees element by element, so the two copies cannot drift', () => {
    expect(ROAD_DIR_COUNT).toBe(DIR_COUNT)
    for (let dir = 0; dir < DIR_COUNT; dir++) {
      expect(ROAD_DIR_DX[dir], `dx[${dir}]`).toBe(DX[dir])
      expect(ROAD_DIR_DY[dir], `dy[${dir}]`).toBe(DY[dir])
    }
  })

  it('compares tables that are long enough to have something to disagree about', () => {
    // Vacuity: a zero-length table, or a `DIR_COUNT` of 0, makes the loop above
    // assert nothing at all. Both lengths are checked directly rather than
    // through the loop bound they also control.
    expect(ROAD_DIR_DX.length).toBe(8)
    expect(ROAD_DIR_DY.length).toBe(8)
    expect(DX.length).toBe(8)
    expect(DY.length).toBe(8)
  })

  it('is a table of 8 DISTINCT unit steps, N first and clockwise', () => {
    // The pairwise check above passes if both tables are (0,0) eight times.
    // This is the independent statement of what a direction table IS, written
    // against `render`'s copy because that is the one under test here.
    const steps = new Set<string>()
    for (let dir = 0; dir < ROAD_DIR_COUNT; dir++) {
      const dx = ROAD_DIR_DX[dir] as number
      const dy = ROAD_DIR_DY[dir] as number
      expect(Math.abs(dx)).toBeLessThanOrEqual(1)
      expect(Math.abs(dy)).toBeLessThanOrEqual(1)
      expect(dx === 0 && dy === 0, `dir ${dir} is not a step`).toBe(false)
      steps.add(`${dx},${dy}`)
    }
    expect(steps.size).toBe(8)
    // N is index 0 and E is index 2 — the two the atlas's literals depend on.
    expect([ROAD_DIR_DX[0], ROAD_DIR_DY[0]]).toEqual([0, -1])
    expect([ROAD_DIR_DX[2], ROAD_DIR_DY[2]]).toEqual([1, 0])
  })
})
