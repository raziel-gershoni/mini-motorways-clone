import { describe, it, expect } from 'vitest'
import { parseMap, TERRAIN } from '../src/mapFormat'
import { firstCity } from '../src/maps/firstCity'

/**
 * Non-square (w=5, h=3) so that `terrain[y * w + x]` and the transposed
 * `terrain[x * h + y]` disagree everywhere except the diagonal. Index 8
 * (x=3, y=1) holds TREE under the correct convention; a transposed writer
 * would instead land it at index 10 (x=3*h+y=10), which — under the correct
 * *reader* — is (x=0, y=2), a LAND cell. So reading at (3, 1) catches a
 * transposed writer regardless of which side of the bug the reader is on.
 *
 * Row layout (y, then x):
 *   y=0: . ^ . . .
 *   y=1: . . ~ T .
 *   y=2: . . . . .
 * Contains all four terrain codes, so the exact-value assertions below are
 * not vacuously true against an all-LAND array.
 */
const ROWS = ['.^...', '..~T.', '.....']

describe('parseMap', () => {
  it('parses width, height and codes at an asymmetric (x, y)', () => {
    const map = parseMap('fixture', ROWS, 5)
    expect(map.w).toBe(5)
    expect(map.h).toBe(3)
    // (x=3, y=1) -> TREE. Under x*h+y it would read index 10 (LAND) instead.
    expect(map.terrain[1 * map.w + 3]).toBe(3)
  })

  it('maps each character to its terrain code by exact value', () => {
    const map = parseMap('fixture', ROWS, 5)
    // Literal expected values, not TERRAIN.* — a MOUNTAIN/TREE code swap in
    // the TERRAIN table itself would move both sides of a symbolic
    // comparison together and this test must still catch it.
    expect(map.terrain[0 * map.w + 0]).toBe(0) // '.' -> LAND
    expect(map.terrain[0 * map.w + 1]).toBe(2) // '^' -> MOUNTAIN
    expect(map.terrain[1 * map.w + 2]).toBe(1) // '~' -> WATER
    expect(map.terrain[1 * map.w + 3]).toBe(3) // 'T' -> TREE
    expect(TERRAIN.LAND).toBe(0)
    expect(TERRAIN.WATER).toBe(1)
    expect(TERRAIN.MOUNTAIN).toBe(2)
    expect(TERRAIN.TREE).toBe(3)
  })

  it('throws on a ragged map, naming the offending row index', () => {
    expect(() => parseMap('ragged', ['...', '..', '...'], 5)).toThrow(/row 1/)
  })

  it('throws on an unknown character, naming the character and its (x, y)', () => {
    expect(() => parseMap('bad-char', ['..X..'], 5)).toThrow(/"X".*\(2, 0\)/)
  })

  it('throws on an empty row list, matched against its own message', () => {
    // A bare `.toThrow()` would also pass with parseMap's own guard deleted:
    // `rows[0]` is `undefined` on `[]`, and `.length` on `undefined` is a
    // native TypeError. Matching the message proves parseMap's own guard —
    // not that native fallback — is what fired.
    expect(() => parseMap('empty-rows', [], 5)).toThrow(/parseMap.*at least one row and one column/)
  })

  it('throws on a single empty-string row, matched against the same message', () => {
    // `['']` gives w=0, h=1 — no native TypeError anywhere in the parse path,
    // so this is the case that actually exercises the guard rather than
    // riding along on `[]`'s native crash.
    expect(() => parseMap('empty-row', [''], 5)).toThrow(/parseMap.*at least one row and one column/)
  })

  it('throws on a negative startingTiles, naming the offending value', () => {
    // Message-matched for consistency with the rest of this file, though not
    // for masking safety here: the reviewer confirmed that without the
    // guard, a negative or non-integer `startingTiles` returns successfully
    // rather than throwing natively, so a bare `.toThrow()` would not be
    // silently satisfied by a native error either way.
    expect(() => parseMap('neg-tiles', ROWS, -1)).toThrow(
      /startingTiles must be a non-negative integer, got -1/,
    )
  })

  it('throws on a non-integer startingTiles, naming the offending value', () => {
    expect(() => parseMap('float-tiles', ROWS, 1.5)).toThrow(
      /startingTiles must be a non-negative integer, got 1\.5/,
    )
  })

  it('freezes the returned MapData', () => {
    const map = parseMap('frozen', ROWS, 5)
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(map as any).id = 'mutated'
    }).toThrow()
  })

  it('freezes the returned terrain array', () => {
    const map = parseMap('frozen-terrain', ROWS, 5)
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(map.terrain as any)[0] = 99
    }).toThrow()
  })
})

describe('firstCity', () => {
  it('parses to a 24x40 map with a non-zero starting tile budget', () => {
    const map = firstCity()
    expect(map.w).toBe(24)
    expect(map.h).toBe(40)
    expect(map.terrain.length).toBe(24 * 40)
    expect(map.startingTiles).toBeGreaterThan(0)
  })
})
