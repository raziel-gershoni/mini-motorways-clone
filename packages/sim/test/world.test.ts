import { describe, it, expect } from 'vitest'
import { parseMap, firstCity, type MapData } from '@laneways/shared'
import { createWorld, mapIdHash } from '../src/world'
import { createState, nonZeroWord, MI_MAP } from '../src/state'

/**
 * Re-blessed alongside any change to firstCity.ts's content — see the test
 * below. Re-blessed in M1c Task 1 (was 777884973, M1b's value): `mapIdHash`
 * now folds `maxHouses`/`maxDestinations`/`groupCount`, which firstCity()
 * sets to 40/16/5.
 */
const FIRST_CITY_HASH = -914732692

/**
 * Contains all four terrain codes — the vacuity check the ledger established
 * (progress.md:4-5). Without it, deleting `createWorld`'s terrain-copy loop
 * would leave an all-LAND `world.terrain` and a self-derived `passable`
 * expectation would still pass.
 */
const ROWS = ['.^~..', '..T..', '.....']

function expectedPassable(rows: readonly string[]): number[] {
  // Derived from the SOURCE ROWS, never from `world.terrain` — deriving from
  // `world.terrain` would make the test pass even with the terrain-copy loop
  // deleted, since it would compare an all-LAND array against itself.
  const out: number[] = []
  for (const row of rows) {
    for (const ch of row) {
      out.push(ch === '.' || ch === 'T' ? 1 : 0)
    }
  }
  return out
}

describe('createWorld', () => {
  it('produces terrain and passable arrays of exactly w * h', () => {
    const map = parseMap('sizes', ROWS, 5, 40, 16, 5)
    const world = createWorld(map)
    expect(world.cells).toBe(map.w * map.h)
    expect(world.terrain.length).toBe(map.w * map.h)
    expect(world.passable.length).toBe(map.w * map.h)
  })

  it('contains all four terrain codes in its fixture (vacuity self-check)', () => {
    const codes = new Set<string>()
    for (const row of ROWS) for (const ch of row) codes.add(ch)
    expect(codes.size).toBe(4)
  })

  it('marks LAND and TREE passable, WATER and MOUNTAIN not, matching the source rows', () => {
    const map = parseMap('passable', ROWS, 5, 40, 16, 5)
    const world = createWorld(map)
    expect(Array.from(world.passable)).toEqual(expectedPassable(ROWS))
  })

  it('is byte-identical across two calls for the same MapData', () => {
    const map = parseMap('repeat', ROWS, 5, 40, 16, 5)
    const a = createWorld(map)
    const b = createWorld(map)
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain))
    expect(Array.from(a.passable)).toEqual(Array.from(b.passable))
  })
})

describe('mapIdHash', () => {
  it('is deterministic for the same map content', () => {
    const map = parseMap('det', ROWS, 5, 40, 16, 5)
    expect(mapIdHash(map)).toBe(mapIdHash(parseMap('det', ROWS, 5, 40, 16, 5)))
  })

  it('is negative for at least one map, and equals what the header round-trips', () => {
    // Found by brute-force search over the exact recipe this function
    // implements: a 1x1 LAND map with id "map4" hashes >= 2^31, so `| 0`
    // makes it negative. Re-found in M1c Task 1 ("map0" no longer collides
    // negative now that maxHouses/maxDestinations/groupCount are folded in —
    // the recipe changed, so the search was re-run rather than the
    // assertion loosened). If this ever collides with a future
    // implementation change, the failure is exactly the point: it means the
    // recipe changed.
    const map = parseMap('map4', ['.'], 30, 40, 16, 5)
    const hash = mapIdHash(map)
    expect(hash).toBeLessThan(0)
    const state = createState('seed', map)
    expect(state.mapIdentity[MI_MAP]).toBe(hash)
  })

  it('differs for two same-length ids with identical boards', () => {
    const a: MapData = parseMap('firstCitY', ROWS, 5, 40, 16, 5)
    const b: MapData = parseMap('firstCitZ', ROWS, 5, 40, 16, 5)
    expect(mapIdHash(a)).not.toBe(mapIdHash(b))
  })

  it('differs when only the terrain content changes, id/w/h/startingTiles held equal', () => {
    const a = parseMap('same-id', ['...', '...'], 7, 40, 16, 5)
    const b = parseMap('same-id', ['..~', '...'], 7, 40, 16, 5)
    expect(a.w).toBe(b.w)
    expect(a.h).toBe(b.h)
    expect(a.startingTiles).toBe(b.startingTiles)
    expect(mapIdHash(a)).not.toBe(mapIdHash(b))
  })

  it('moves when maxHouses alone changes, id/w/h/startingTiles/maxDestinations/groupCount held equal', () => {
    // The silent-corruption fix M1c's plan describes: a map re-authored
    // between a run and its server replay with maxHouses/maxDestinations
    // changed so the byte total is unchanged would, without this fold,
    // produce the same MI_MAP, the same w/h, and the same total byte count —
    // and `viewsOver` would reinterpret the whole buffer under a different
    // offset table with no throw anywhere.
    const a = parseMap('limits-houses', ROWS, 5, 40, 16, 5)
    const b = parseMap('limits-houses', ROWS, 5, 8, 16, 5)
    expect(mapIdHash(a)).not.toBe(mapIdHash(b))
  })

  it('moves when maxDestinations alone changes, everything else held equal', () => {
    const a = parseMap('limits-dest', ROWS, 5, 40, 16, 5)
    const b = parseMap('limits-dest', ROWS, 5, 40, 4, 5)
    expect(mapIdHash(a)).not.toBe(mapIdHash(b))
  })

  it('moves when groupCount alone changes, everything else held equal', () => {
    const a = parseMap('limits-group', ROWS, 5, 40, 16, 5)
    const b = parseMap('limits-group', ROWS, 5, 40, 16, 3)
    expect(mapIdHash(a)).not.toBe(mapIdHash(b))
  })

  it('is never 0', () => {
    // Testing nonZeroWord directly, not by hunting for map content that
    // happens to hash to 0 — an unbounded, non-deterministic search over a
    // 2^32 output space. This is the same approach M1a used for the seed path.
    expect(nonZeroWord(0)).toBe(1)
  })

  it("pins firstCity()'s content hash — the assertion that should fire when the shipped fixture map changes", () => {
    // A literal, not a snapshot: any edit to firstCity.ts's row data, w, h or
    // startingTiles must make this fail loudly, and re-blessing it is a
    // one-line, reviewable diff naming exactly what changed.
    expect(mapIdHash(firstCity())).toBe(FIRST_CITY_HASH)
  })
})
