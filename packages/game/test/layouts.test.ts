import { describe, it, expect } from 'vitest'
import { demoCity, firstCity } from '@laneways/shared'
import { createState, createWorld, hashState } from '@laneways/sim'
import {
  CITY_LAYOUT_ID,
  DEMO_LAYOUT_ID,
  DEFAULT_LAYOUT_ID,
  LAYOUTS,
  LAYOUT_IDS,
  layoutFor,
} from '../src/layouts'
import { RUN_SEED, WARM_START_TICKS } from '../src/main'
import { DEMO_RUN_SEED, DEMO_WARM_START_TICKS } from '../src/demoLayout'
import { seedStartingCity } from '../src/startingCity'

/**
 * The registry that pairs a layout id with its map, its seeder, its RNG seed
 * and its warm start. Two entries today; the shape exists so a third costs one
 * object literal rather than a branch in `createGame`.
 */

describe('the layout registry', () => {
  it('defaults to the shipped city, and the default id is a real entry', () => {
    expect(DEFAULT_LAYOUT_ID).toBe(CITY_LAYOUT_ID)
    expect(DEFAULT_LAYOUT_ID).toBe('city')
    expect(LAYOUTS[DEFAULT_LAYOUT_ID]).toBeDefined()
  })

  it('resolves an absent token to the default, so the shipped boot is unchanged', () => {
    // `undefined` is what `layoutToken` returns for no token at all, and it has
    // to land on the city: every existing golden and the whole shipped game
    // depend on that branch being today's code.
    expect(layoutFor(undefined)).toBe(LAYOUTS[CITY_LAYOUT_ID])
    expect(layoutFor('')).toBe(LAYOUTS[CITY_LAYOUT_ID])
  })

  it('resolves the demo token to the demo layout', () => {
    expect(DEMO_LAYOUT_ID).toBe('demo')
    expect(layoutFor(DEMO_LAYOUT_ID)).toBe(LAYOUTS[DEMO_LAYOUT_ID])
    expect(layoutFor(DEMO_LAYOUT_ID)).not.toBe(LAYOUTS[CITY_LAYOUT_ID])
  })

  it('REFUSES an unknown id loudly, naming it and listing the ones that exist', () => {
    // The failure this exists to prevent: `?startapp=demoo` silently boots the
    // shipped city, and the player reports "it looks like the same demo" for
    // the second time — the exact bug this whole task is fixing, reintroduced
    // by a typo with no signal. A throw is the only outcome that cannot be
    // mistaken for the default board.
    expect(() => layoutFor('demoo')).toThrow(/layoutFor: unknown layout "demoo"/)
    expect(() => layoutFor('demoo')).toThrow(/city/)
    expect(() => layoutFor('demoo')).toThrow(/demo/)
    expect(() => layoutFor('CITY')).toThrow(/unknown layout "CITY"/)
  })

  it('LAYOUT_IDS lists exactly the keys of LAYOUTS, in a stable order', () => {
    // Two sources of truth for "which layouts exist" would drift, and the one
    // the error message prints is the one nobody checks.
    expect([...LAYOUT_IDS].sort()).toEqual(Object.keys(LAYOUTS).sort())
    expect(LAYOUT_IDS).toEqual(['city', 'demo'])
  })

  it('every entry carries its own map, seeder, RNG seed and warm start', () => {
    for (const id of LAYOUT_IDS) {
      const layout = LAYOUTS[id]
      expect(layout, `layout ${id}`).toBeDefined()
      expect(layout?.id).toBe(id)
      expect(typeof layout?.map).toBe('function')
      expect(typeof layout?.seed).toBe('function')
      expect(typeof layout?.runSeed).toBe('string')
      expect(Number.isInteger(layout?.warmStartTicks)).toBe(true)
      expect(layout?.warmStartTicks).toBeGreaterThanOrEqual(0)
    }
  })

  it('the city entry is today’s three constants, unchanged', () => {
    // If any of these three drifts, the shipped boot has quietly changed and
    // `integration.test.ts`'s re-derivation of 258 is measuring something else.
    const city = LAYOUTS[CITY_LAYOUT_ID]
    expect(city?.map().id).toBe(firstCity().id)
    expect(city?.runSeed).toBe(RUN_SEED)
    expect(city?.warmStartTicks).toBe(WARM_START_TICKS)
    expect(city?.seed).toBe(seedStartingCity)
  })

  it('the demo entry is the demo map and the demo constants', () => {
    const demo = LAYOUTS[DEMO_LAYOUT_ID]
    expect(demo?.map().id).toBe(demoCity().id)
    expect(demo?.runSeed).toBe(DEMO_RUN_SEED)
    expect(demo?.warmStartTicks).toBe(DEMO_WARM_START_TICKS)
    // The demo warm start is nearly five times the city's, and deliberately:
    // it is what makes the board open already congested.
    expect(demo?.warmStartTicks).toBeGreaterThan(WARM_START_TICKS)
  })

  it('the two entries seed two different boards — the registry is not a no-op', () => {
    // Non-vacuity for the whole mechanism: without this, a registry whose two
    // entries were the same object would pass every test above.
    const hashes = LAYOUT_IDS.map((id) => {
      const layout = LAYOUTS[id]
      if (layout === undefined) throw new Error(`missing layout ${id}`)
      const map = layout.map()
      const world = createWorld(map)
      const state = createState(layout.runSeed, map)
      layout.seed(state, world)
      return hashState(state)
    })
    expect(new Set(hashes).size).toBe(LAYOUT_IDS.length)
  })

  it('is frozen, so a consumer cannot swap a layout at run time', () => {
    expect(Object.isFrozen(LAYOUTS)).toBe(true)
    expect(Object.isFrozen(LAYOUTS[CITY_LAYOUT_ID])).toBe(true)
    expect(Object.isFrozen(LAYOUTS[DEMO_LAYOUT_ID])).toBe(true)
    expect(Object.isFrozen(LAYOUT_IDS)).toBe(true)
  })

  it('does not answer for a prototype key — `layoutFor("toString")` throws', () => {
    // `LAYOUTS` is a plain object, so an id that names an `Object.prototype`
    // member would otherwise resolve to a function and boot a game with
    // `layout.map` undefined. `Object.create(null)` plus an own-property check
    // is the fix; this is the test that says which.
    expect(() => layoutFor('toString')).toThrow(/unknown layout "toString"/)
    expect(() => layoutFor('constructor')).toThrow(/unknown layout "constructor"/)
    expect(() => layoutFor('__proto__')).toThrow(/unknown layout "__proto__"/)
  })
})
