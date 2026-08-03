/**
 * The map format: terrain codes plus the row-string parser that builds a
 * `MapData` from human-authored source.
 *
 * Terrain is authored as one string per row, one character per cell — `.`
 * land, `~` water, `^` mountain, `T` tree. That is human-readable in source,
 * diffs legibly, and cannot silently drift out of a rectangular shape
 * without `parseMap` noticing (a ragged row throws).
 *
 * Cell index convention, load-bearing across the whole M1b milestone:
 * `index = y * w + x` — row-major, origin top-left, `x` fastest.
 */

import { MAX_GROUP_COUNT } from './constants'

export const TERRAIN = Object.freeze({ LAND: 0, WATER: 1, MOUNTAIN: 2, TREE: 3 } as const)
export type TerrainCode = 0 | 1 | 2 | 3

export interface MapData {
  readonly id: string
  /** Maximum extent. Expansion (§5.1, M1d) reveals cells; it never resizes the buffer. */
  readonly w: number
  readonly h: number
  readonly terrain: readonly TerrainCode[] // index = y * w + x
  readonly startingTiles: number
  /**
   * The three limits M1c's buffer regions size from (`regions.ts`,
   * `sim`). Building-spawn zones are deliberately NOT here — they are the
   * M1e spawner's input, not the board's; when they land, they must be
   * folded into `mapIdHash` for the same reason these three are (below).
   */
  readonly maxHouses: number
  readonly maxDestinations: number
  /** 1 <= groupCount <= MAX_GROUP_COUNT. Per-map, not a global constant — spec §4.2. */
  readonly groupCount: number
}

/** Module-scope literal: frozen per Task 1's AST rule (`as const` alone is type-level only). */
const CODE_FOR_CHAR: Readonly<Record<string, TerrainCode>> = Object.freeze({
  '.': TERRAIN.LAND,
  '~': TERRAIN.WATER,
  '^': TERRAIN.MOUNTAIN,
  T: TERRAIN.TREE,
})

export function parseMap(
  id: string,
  rows: readonly string[],
  startingTiles: number,
  maxHouses: number,
  maxDestinations: number,
  groupCount: number,
): MapData {
  if (!Number.isInteger(startingTiles) || startingTiles < 0) {
    throw new Error(
      `parseMap("${id}"): startingTiles must be a non-negative integer, got ${startingTiles}`,
    )
  }
  if (!Number.isInteger(maxHouses) || maxHouses < 1) {
    throw new Error(`parseMap("${id}"): maxHouses must be a positive integer, got ${maxHouses}`)
  }
  if (!Number.isInteger(maxDestinations) || maxDestinations < 1) {
    throw new Error(
      `parseMap("${id}"): maxDestinations must be a positive integer, got ${maxDestinations}`,
    )
  }
  if (!Number.isInteger(groupCount) || groupCount < 1 || groupCount > MAX_GROUP_COUNT) {
    throw new Error(
      `parseMap("${id}"): groupCount must be an integer in [1, ${MAX_GROUP_COUNT}], got ${groupCount}`,
    )
  }

  // Checked explicitly, and before anything else touches `rows[0]`: on `[]`,
  // `rows[0]` is `undefined` and `.length` on it is a native TypeError, which
  // would make a bare `.toThrow()` pass even with this guard deleted. `['']`
  // throws nothing native (w=0, h=1), so it is the case that actually proves
  // this guard runs. Both are asserted against this exact message in the
  // test, not a bare `.toThrow()`.
  if (rows.length === 0 || (rows[0] as string).length === 0) {
    throw new Error(`parseMap("${id}"): map must have at least one row and one column`)
  }

  const h = rows.length
  const w = (rows[0] as string).length
  const terrain: TerrainCode[] = new Array(w * h)

  for (let y = 0; y < h; y++) {
    const row = rows[y] as string
    if (row.length !== w) {
      throw new Error(
        `parseMap("${id}"): row ${y} has length ${row.length}, expected ${w} (row 0's length)`,
      )
    }
    for (let x = 0; x < w; x++) {
      const ch = row[x] as string
      const code = CODE_FOR_CHAR[ch]
      if (code === undefined) {
        throw new Error(`parseMap("${id}"): unknown terrain character "${ch}" at (${x}, ${y})`)
      }
      terrain[y * w + x] = code
    }
  }

  return Object.freeze({
    id,
    w,
    h,
    terrain: Object.freeze(terrain),
    startingTiles,
    maxHouses,
    maxDestinations,
    groupCount,
  })
}
