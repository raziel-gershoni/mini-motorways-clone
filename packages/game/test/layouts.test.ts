import { describe, it, expect } from 'vitest'
import { demoCity, firstCity } from '@laneways/shared'
import {
  createFieldInputRanges,
  createFlowFields,
  createScratch,
  createState,
  createWorld,
  hashState,
  isGameOver,
  step,
  H_TICK,
  type TickInputs,
} from '@laneways/sim'

/** An empty batch — the warm start's own input, which is no input at all. */
const NO_INPUT: TickInputs = { actions: [] }
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
 *
 * **Which entry the no-token path reaches is a third thing, and it has its own
 * case at the top of this file.** It is `demo`. The starting city was the
 * default until the demo board existed, is still one token away, and has its
 * own case here as well — the two are asserted separately because "the default
 * is X" and "Y is still reachable" fail for different reasons and want
 * different messages.
 */

describe('the layout registry', () => {
  it('THE DEFAULT IS THE DEMO BOARD, by name — a plain load opens `demo`', () => {
    // **The detector for one line, `DEFAULT_LAYOUT_ID` in `layouts.ts`, and it
    // is deliberately the narrowest test in the file.** Flipping that constant
    // is flipping what every player sees on a plain load, and before this case
    // existed the flip failed *diffusely*: 20 cases went red across three
    // files, 17 of them integration cases whose real complaint was "this board
    // has 24 cars and my arithmetic says 6". None of them named the cause. This
    // one does, in its title and in its message.
    //
    // The literal `'demo'` is load-bearing next to the symbolic form. Without
    // it, renaming `DEMO_LAYOUT_ID` and re-pointing the default at the city in
    // the same edit would satisfy `toBe(DEMO_LAYOUT_ID)` — the two constants
    // would agree with each other about a board neither of them is.
    expect(DEFAULT_LAYOUT_ID, 'the board a plain load opens').toBe('demo')
    expect(DEFAULT_LAYOUT_ID).toBe(DEMO_LAYOUT_ID)
    // ...and it is NOT the starting city, stated as its own assertion because
    // that is the specific flip a reader of this file is most likely to make:
    // the city was the default until the demo board existed, and the reason it
    // is not any more (six cars that never move) is not visible from here.
    expect(DEFAULT_LAYOUT_ID).not.toBe(CITY_LAYOUT_ID)
    // An id that is not a key would boot `undefined.map()`, which is the
    // failure the whole registry is shaped to make unconstructible.
    expect(LAYOUTS[DEFAULT_LAYOUT_ID]).toBeDefined()
    expect(LAYOUT_IDS).toContain(DEFAULT_LAYOUT_ID)
  })

  it('resolves an absent token to the default — no token, no city', () => {
    // `undefined` is what a launch with nothing in the URL produces, and `''`
    // is what `layoutToken` returns for a value outside Telegram's charset.
    // Both are "nobody named a board", and both must land on the SAME board —
    // asserted through `DEFAULT_LAYOUT_ID` rather than through `demo` so this
    // case is about the resolution and the case above is about the choice.
    expect(layoutFor(undefined)).toBe(LAYOUTS[DEFAULT_LAYOUT_ID])
    expect(layoutFor('')).toBe(LAYOUTS[DEFAULT_LAYOUT_ID])
    expect(layoutFor('')).toBe(layoutFor(undefined))
    // Non-vacuity: `LAYOUTS[DEFAULT_LAYOUT_ID]` would be satisfied by a
    // registry with one entry in it, and by a `layoutFor` that ignores its
    // argument entirely. The city is a different object and is still reachable.
    expect(layoutFor(undefined)).not.toBe(LAYOUTS[CITY_LAYOUT_ID])
    expect(layoutFor(CITY_LAYOUT_ID)).toBe(LAYOUTS[CITY_LAYOUT_ID])
  })

  it('keeps the starting city reachable by its own id, and unchanged', () => {
    // The board that was the default until this milestone. `?layout=city` in a
    // browser, `?startapp=city` inside Telegram. Deleting it, renaming it or
    // folding it into the demo entry all fail here.
    expect(CITY_LAYOUT_ID).toBe('city')
    expect(layoutFor('city')).toBe(LAYOUTS[CITY_LAYOUT_ID])
    expect(layoutFor('city').map().id).toBe('firstCity')
    expect(layoutFor('city').runSeed).toBe(RUN_SEED)
    expect(layoutFor('city').warmStartTicks).toBe(WARM_START_TICKS)
  })

  it('resolves the demo token to the demo layout', () => {
    expect(DEMO_LAYOUT_ID).toBe('demo')
    expect(layoutFor(DEMO_LAYOUT_ID)).toBe(LAYOUTS[DEMO_LAYOUT_ID])
    expect(layoutFor(DEMO_LAYOUT_ID)).not.toBe(LAYOUTS[CITY_LAYOUT_ID])
  })

  it('REFUSES an unknown id loudly, naming it and listing the ones that exist', () => {
    // The failure this exists to prevent, restated for the default that is
    // actually in force: `?startapp=cty` silently opening the demo board, while
    // the reader believes they are looking at the starting city and has nothing
    // to point at. It is the same lie the demo link told in the other
    // direction. A throw is the only outcome that cannot be mistaken for the
    // default board.
    expect(() => layoutFor('demoo')).toThrow(/layoutFor: unknown layout "demoo"/)
    // The whole line, which is what catches the list being dropped.
    expect(() => layoutFor('demoo')).toThrow(/the layouts that exist are city, demo/)
    // **The per-id form, on a token that cannot supply either id — and both
    // halves of that sentence were defects here until this edit.** The message
    // used to end with the prose "...silently boots the shipped city", so
    // `/city/` matched whether or not the list was ever printed; the prose says
    // "the default" now. And `/demo/` was asserted against the token `demoo`,
    // which CONTAINS it, so that half was satisfied by the quoted token
    // regardless — the catalogue's "a `toContain` over a composed message is
    // satisfied by any other part of that message", twice in one line.
    // `nope` shares no substring with either id, so these two can only be
    // satisfied by `LAYOUT_IDS`, and they are what catches a THIRD layout
    // going unlisted where the whole-line form would have to be edited anyway.
    for (const id of LAYOUT_IDS) {
      expect(() => layoutFor('nope'), `layout id ${id}`).toThrow(new RegExp(id))
    }
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
    // If any of these three drifts, the board behind `?layout=city` has quietly
    // changed and `integration.test.ts`'s re-derivation of 258 — which now runs
    // on an explicitly-named city rig — is measuring something else.
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

  it('every layout survives its OWN warm start, so no board can boot already over', () => {
    // **M1e Task 8's precondition, asserted for the registry rather than for the
    // two boards that happen to be short.** `createGame` runs `warmStartTicks`
    // bare `step` calls before the loop exists, and `onGameOver` fires on an
    // EDGE inside `advance` — so a layout whose warm start reaches its own
    // shutdown would boot terminal with the callback already missed. `main.ts`
    // handles that case explicitly (`if (isGameOver(state)) loop.end()`), and
    // this is the line that says no shipped layout needs it to.
    //
    // Driven rather than compared against a constant: `deathTicks.ts` records
    // what the two boards do today, and a THIRD layout added tomorrow would have
    // no entry there. Running the real warm start is the only check that covers
    // a layout nobody has measured.
    for (const id of LAYOUT_IDS) {
      const layout = layoutFor(id)
      const map = layout.map()
      const world = createWorld(map)
      const state = createState(layout.runSeed, map)
      const scratch = createScratch(
        world.cells,
        map.groupCount,
        map.maxDestinations,
        createFieldInputRanges(map),
      )
      const fields = createFlowFields(map.groupCount, world.cells)
      layout.seed(state, world)
      for (let t = 0; t < layout.warmStartTicks; t++) {
        step(state, world, fields, scratch, NO_INPUT)
      }
      expect(
        isGameOver(state),
        `layout "${id}" is already over after its own ${layout.warmStartTicks}-tick warm start — ` +
          'it would boot with the shutdown already missed',
      ).toBe(false)
      // Vacuity: the warm start must actually have run, or "not over" is a
      // statement about a board that never ticked.
      expect(state.header[H_TICK], `layout "${id}" ran no warm start`).toBe(layout.warmStartTicks)
      expect(layout.warmStartTicks).toBeGreaterThan(0)
    }
    // ...and the registry is not empty, or the loop above asserts nothing.
    expect(LAYOUT_IDS.length).toBeGreaterThan(1)
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
