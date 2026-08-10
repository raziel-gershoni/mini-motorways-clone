import { describe, it, expect } from 'vitest'
import {
  demoCity,
  firstCity,
  TERRAIN,
  REVEALED_X0,
  REVEALED_Y0,
  REVEALED_W,
  REVEALED_H,
  CARS_PER_HOUSE,
  MAX_GROUP_COUNT,
} from '../src/index'

/**
 * `demoCity` is the board the `?startapp=demo` layout runs on. It is a
 * SECOND map, never an edit of `firstCity` — every one of the four
 * whole-buffer goldens folds `firstCity`'s bytes through `mapIdHash`, so
 * changing one integer field on it moves all four at once.
 *
 * These tests are about the map alone: its shape, its budget, and the fact
 * that every cell the demo layout occupies is drawable. Placement is
 * `packages/game/test/demoLayout.test.ts`'s job.
 */

const TREES: readonly (readonly [number, number])[] = [
  [6, 11],
  [17, 14],
  [5, 17],
  [18, 20],
  [7, 23],
  [18, 23],
  [11, 26],
  [6, 27],
  [12, 29],
  [10, 30],
]

describe('demoCity', () => {
  it('is 24 x 40, the same extent as firstCity — the camera constants are global', () => {
    const map = demoCity()
    expect(map.w).toBe(24)
    expect(map.h).toBe(40)
    // Not a coincidence and not free: REVEALED_X0/Y0/W/H are frozen module
    // constants that `createGame` hands the camera for EVERY layout, so a map
    // of a different extent would be drawn through the wrong rect.
    expect(map.w).toBe(firstCity().w)
    expect(map.h).toBe(firstCity().h)
    expect(map.terrain.length).toBe(24 * 40)
  })

  it('has its own id, so mapIdHash cannot collide with firstCity', () => {
    expect(demoCity().id).toBe('demoCity')
    expect(demoCity().id).not.toBe(firstCity().id)
  })

  it('carries the three limits the demo layout needs, and no more', () => {
    const map = demoCity()
    // 12 houses x CARS_PER_HOUSE is the fleet the jam measurement was taken at.
    expect(map.maxHouses).toBe(12)
    expect(map.maxHouses * CARS_PER_HOUSE).toBe(24)
    // 18 destinations, all circles, is 36 rotation slots — the demand that
    // keeps 24 cars in flight. `firstCity` allows 16, which is why the demo
    // needs a map of its own rather than a second seeder on the same board.
    expect(map.maxDestinations).toBe(18)
    expect(map.maxDestinations).toBeGreaterThan(firstCity().maxDestinations)
    expect(map.groupCount).toBe(3)
    expect(map.groupCount).toBeLessThanOrEqual(MAX_GROUP_COUNT)
  })

  it('budgets enough tiles for the seeded network AND for the player to redraw it', () => {
    // The seed lays 71 cells. A demo whose whole point is "erase the corridor
    // and watch it ghost" is useless if the erase cannot be undone, so the
    // budget leaves more than the seed spends.
    expect(demoCity().startingTiles).toBe(200)
    expect(demoCity().startingTiles).toBeGreaterThan(2 * 71)
  })

  it('places its ten trees exactly where the layout table says, and nowhere else', () => {
    const map = demoCity()
    for (const [x, y] of TREES) {
      expect(map.terrain[y * map.w + x], `tree at (${x}, ${y})`).toBe(TERRAIN.TREE)
    }
    let trees = 0
    for (let i = 0; i < map.terrain.length; i++) if (map.terrain[i] === TERRAIN.TREE) trees++
    expect(trees).toBe(TREES.length)
  })

  it('is otherwise all LAND — no water, no mountain', () => {
    // Deliberate, and stated so nobody "improves" it: a river or a mountain
    // would make the three corridors unbuildable at the coordinates the
    // seeder hard-codes, and the seeder throws rather than degrading.
    const map = demoCity()
    let land = 0
    for (let i = 0; i < map.terrain.length; i++) {
      expect(map.terrain[i] === TERRAIN.LAND || map.terrain[i] === TERRAIN.TREE).toBe(true)
      if (map.terrain[i] === TERRAIN.LAND) land++
    }
    expect(land).toBe(24 * 40 - TREES.length)
  })

  it('puts every tree INSIDE the revealed rect — an invisible tree is not decoration', () => {
    for (const [x, y] of TREES) {
      expect(x, `tree x ${x}`).toBeGreaterThanOrEqual(REVEALED_X0)
      expect(x).toBeLessThan(REVEALED_X0 + REVEALED_W)
      expect(y, `tree y ${y}`).toBeGreaterThanOrEqual(REVEALED_Y0)
      expect(y).toBeLessThan(REVEALED_Y0 + REVEALED_H)
    }
  })

  it('returns a fresh frozen MapData per call and allocates nothing at module scope', () => {
    const a = demoCity()
    const b = demoCity()
    expect(a).not.toBe(b)
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(a.terrain)).toBe(true)
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain))
  })
})
