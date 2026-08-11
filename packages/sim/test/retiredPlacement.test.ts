import { describe, it, expect } from 'vitest'
import { parseMap } from '@laneways/shared'
import { createState } from '../src/state'
import { createWorld } from '../src/world'
import { placeRoad } from '../src/roads'
import {
  ORIENTATION_COUNT, DEST_KIND_SQUARE, DEST_KIND_CIRCLE,
  canPlaceDestination, canPlaceHouse, placeDestination, placeHouse, type PlaceCheck,
} from '../src/buildings'
import { retiredCanPlaceDestination, retiredCanPlaceHouse } from './retiredPlacementRef'

/** xorshift32, so the boards are reproducible without touching the sim RNG. */
function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s }
}

const CHARS = ['.', '.', '.', '.', '~', 'T', '.', '.']

/**
 * **The migration differential: the rewritten predicates against the retired
 * ones, compared on their actual RETURN VALUES over ~35,000 cases.**
 *
 * `buildings.test.ts`'s exhaustive equivalence proof covers the §5.9 spacing
 * rule — the one piece of arithmetic Task 4 replaced. This covers the rest of
 * the rewrite: the prologue, the box walk that replaced `allSevenCells`, all
 * four cell passes, the carpark in each of them, the rejection ORDER when
 * several reasons apply, and the eight frozen singletons' values (not their
 * identity — `retiredPlacementRef.ts` returns literals, so this compares by
 * deep value and says nothing about allocation).
 *
 * **This is a migration artefact, not coverage.** It reimplements nothing — the
 * reference is the real retired code, copied whole — but it can only ever say
 * "unchanged", never "correct". Every behavioural claim about placement lives
 * in `buildings.test.ts`. **Delete this and `retiredPlacementRef.ts` when the
 * rewrite has been on main for a milestone.**
 *
 * Half the boards are deliberately CLEAN with a tiny destination cap. The first
 * version of this differential used cluttered boards only and reached
 * `capacity` exactly **zero** times — terrain or spacing always answered first
 * — so the outcome tally is asserted rather than printed. A differential that
 * never reaches an outcome says nothing about it, and looks identical to one
 * that does.
 */
describe('the rewritten placement predicates are behaviourally identical to the retired ones', () => {
  it('returns the same PlaceCheck value for every (board, cell, orientation), all 15 outcomes reached', () => {
    let compared = 0
    const diffs: string[] = []
    const outcomeTally = new Map<string, number>()
    // 12 board shapes x 8 seeds: non-square in both directions, sizes that make
    // the 2x3 / 3x2 footprints straddle the edges differently.
    const shapes: Array<[number, number]> = [
      [9, 6], [6, 9], [7, 7], [12, 5], [5, 12], [4, 4],
      [3, 8], [8, 3], [10, 11], [11, 10], [24, 6], [6, 24],
    ]
    for (const [w, h] of shapes) {
      for (let seed = 1; seed <= 8; seed++) {
        const r = rng(seed * 7919 + w * 131 + h)
        const rows: string[] = []
        for (let y = 0; y < h; y++) {
          let row = ''
          for (let x = 0; x < w; x++) row += CHARS[r() % CHARS.length] as string
          rows.push(row)
        }
        // Every other seed uses a CLEAN all-land board with a tiny destination
        // cap, so the `capacity` outcome — which needs a full board AND a
        // spatially valid candidate — is actually reached. On the cluttered
        // boards it never is: terrain or spacing answers first.
        const clean = seed % 2 === 0
        const rows2 = clean ? rows.map((r) => '.'.repeat(r.length)) : rows
        const map = parseMap(`diff-${w}x${h}-${seed}`, rows2, 200, clean ? 3 : 8, clean ? 2 : 6, 5)
        const world = createWorld(map)
        const state = createState('s', map)
        void rows2
        // Sprinkle roads, destinations and houses so the deep branches differ
        // between boards rather than every board being empty.
        for (let i = 0; i < (clean ? 4 : 30); i++) {
          const a = r() % world.cells
          const b = a + ((r() % 2) === 0 ? 1 : world.w)
          if (b < world.cells) placeRoad(state, world, a, b)
        }
        for (let i = 0; i < (clean ? 40 : 25); i++) {
          placeDestination(state, world, r() % world.cells, r() % ORIENTATION_COUNT, r() % 5,
            (r() % 2) === 0 ? DEST_KIND_SQUARE : DEST_KIND_CIRCLE)
        }
        for (let i = 0; i < (clean ? 3 : 25); i++) placeHouse(state, world, r() % world.cells, r() % 5)

        const key = (p: PlaceCheck) => (p.ok ? 'ok' : p.reason)
        // Every in-range cell, one past each end, and every orientation.
        for (let cell = -1; cell <= world.cells; cell++) {
          const gotH = canPlaceHouse(state, world, cell)
          const wantH = retiredCanPlaceHouse(state, world, cell)
          compared++
          outcomeTally.set('h:' + key(gotH), (outcomeTally.get('h:' + key(gotH)) ?? 0) + 1)
          if (JSON.stringify(gotH) !== JSON.stringify(wantH)) {
            diffs.push(`house ${w}x${h}/${seed} cell=${cell}: new=${JSON.stringify(gotH)} old=${JSON.stringify(wantH)}`)
          }
          for (let o = 0; o < ORIENTATION_COUNT; o++) {
            const got = canPlaceDestination(state, world, cell, o)
            const want = retiredCanPlaceDestination(state, world, cell, o)
            compared++
            outcomeTally.set('d:' + key(got), (outcomeTally.get('d:' + key(got)) ?? 0) + 1)
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              diffs.push(`dest ${w}x${h}/${seed} cell=${cell} o=${o}: new=${JSON.stringify(got)} old=${JSON.stringify(want)}`)
            }
          }
        }
      }
    }
    expect(diffs.slice(0, 20), `${diffs.length} of ${compared} comparisons differ`).toEqual([])
    expect(compared, 'the enumeration collapsed').toBeGreaterThan(30000)
    // Vacuity, and the half that the first version of this test got wrong: every
    // outcome of both predicates must actually OCCUR, or the differential is
    // silent about it. `d:` is canPlaceDestination, `h:` is canPlaceHouse — which
    // has no spacing rule of its own, hence 8 and 7.
    expect([...outcomeTally.keys()].sort()).toEqual([
      'd:building', 'd:capacity', 'd:ok', 'd:out-of-bounds', 'd:road', 'd:spacing', 'd:terrain', 'd:tree',
      'h:building', 'h:capacity', 'h:ok', 'h:out-of-bounds', 'h:road', 'h:terrain', 'h:tree',
    ])
    for (const [k, n] of outcomeTally) expect(n, `${k} is too rare to mean anything`).toBeGreaterThan(50)
  }, 300000)
})
