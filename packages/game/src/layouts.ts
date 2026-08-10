import { demoCity, firstCity, type MapData } from '@laneways/shared'
import type { GameState, WorldData } from '@laneways/sim'
import { RUN_SEED, WARM_START_TICKS, seedStartingCity } from './startingCity'
import { DEMO_RUN_SEED, DEMO_WARM_START_TICKS, seedDemoLayout } from './demoLayout'

/**
 * **The layout registry: which board a run opens on.**
 *
 * A layout is a map, a seeder, an RNG seed and a warm start, bound together
 * under one id. `createGame` reads one entry and nothing else; `main.ts`'s
 * `layoutToken` decides which id, from a `?startapp=` link inside Telegram or
 * `?layout=` in a browser.
 *
 * **Nothing here can move a golden, and that is still true now the default has
 * changed.** Each entry names four values that live in their own file —
 * `firstCity`/`seedStartingCity`/`RUN_SEED`/`WARM_START_TICKS` for the city,
 * and the demo's four in `demoLayout.ts` — so this file rebinds which entry the
 * no-token path reaches and edits neither. Every golden is pinned to an
 * explicit board by the test that owns it (`startingCity.test.ts` holds the
 * seed golden `968680755` on `firstCity`; `demoLayout.test.ts` holds
 * `3152640907` on the demo — `1178110182` and `1039862014` respectively until
 * M1e Task 1's pure-layout re-bless), never to "whatever the default is", and
 * `layouts.test.ts` asserts each entry's four values rather than trusting the
 * reading.
 *
 * **`Object.create(null)`, not `{}`.** The id comes from a URL. A plain object
 * literal answers `'toString'`, `'constructor'` and `'__proto__'` with
 * inherited members, so `?startapp=toString` would resolve to a function, sail
 * past a `!== undefined` check, and boot a game whose `layout.map` is
 * undefined. A null-prototype table has no inherited keys at all, so the lookup
 * can only ever find something a developer put there. (An own-property check
 * would also work; the null prototype makes the whole class unconstructible
 * rather than guarded, and `layouts.test.ts` pins all three names.)
 */
export interface Layout {
  /** The token a link carries. `[A-Za-z0-9_-]`, matching Telegram's `startapp` charset. */
  readonly id: string
  /** Fresh `MapData` per call — `parseMap` allocates, so this is a function, not a value. */
  readonly map: () => MapData
  /** Runs before the first tick. Throws by name on any rejected placement. */
  readonly seed: (state: GameState, world: WorldData) => void
  /** The RNG seed for this layout's runs. Per layout, because two layouts are two runs. */
  readonly runSeed: string
  /** Ticks stepped before the first frame. See each layout's own constant. */
  readonly warmStartTicks: number
}

export const CITY_LAYOUT_ID = 'city'
export const DEMO_LAYOUT_ID = 'demo'

/**
 * What a run opens on when no layout is named — **the demo board**.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE DEMO AND NOT THE SHIPPED STARTING CITY
 * ---------------------------------------------------------------------------
 *
 * The starting city is **inert on the board that ships**. Instrumented on the
 * exact production boot over 200,000 ticks it produces `REFUSED_OCCUPIED` 0,
 * `ENTER_VALVE` 0, a maximum of one car in flight, and 1,510 dropped pins:
 * three houses feeding four destination slots at one pin per 129.5 ticks
 * against a ~60-tick round trip, with no shipped control that can add a car.
 * A player opening it sees six cars that never move. M1d's blocking, M1d's
 * ghost roads and M1d's lane speeds cannot fire there at all.
 *
 * The demo board is where all of it does: 24 cars, at least one refused entry
 * on ~59 % of ticks, and a standing queue up to 8. Putting it behind a link
 * meant the shipped default stayed the board that demonstrates nothing, and
 * "why does it have to be by a param" had no answer.
 *
 * **The starting city is not deleted and is not unreachable — it is one token
 * away**, `?layout=city` in a browser and `?startapp=city` inside Telegram, and
 * it keeps its own tests, its own RNG seed and its own seed golden
 * `968680755` (was `1178110182`; re-blessed for pure layout in M1e Task 1).
 * What changed is which id the *absent* token resolves to.
 *
 * ---------------------------------------------------------------------------
 * WHAT DEPENDS ON THIS CONSTANT
 * ---------------------------------------------------------------------------
 *
 * Everything a plain load does, and nothing else. No golden reads it: every
 * test that cares which board it is on names the id (`layouts.test.ts`'s own
 * default case is the one exception, and it exists precisely to be that
 * exception). `integration.test.ts`'s rig pins `city` explicitly for the same
 * reason — its cases were written against that board and re-derive its
 * 258-tick warm start, so they must keep measuring it however this line reads.
 *
 * Changing this line changes what every player sees, so it has a detector that
 * names the answer: `layouts.test.ts`'s *"the default is the demo board, by
 * name"*. A flip fails there first, with the id it was flipped to in the
 * message, rather than diffusely across twenty boards-worth of assertions.
 */
export const DEFAULT_LAYOUT_ID = DEMO_LAYOUT_ID

const CITY_LAYOUT: Layout = Object.freeze({
  id: CITY_LAYOUT_ID,
  map: firstCity,
  seed: seedStartingCity,
  runSeed: RUN_SEED,
  warmStartTicks: WARM_START_TICKS,
})

const DEMO_LAYOUT: Layout = Object.freeze({
  id: DEMO_LAYOUT_ID,
  map: demoCity,
  seed: seedDemoLayout,
  runSeed: DEMO_RUN_SEED,
  warmStartTicks: DEMO_WARM_START_TICKS,
})

/**
 * Every layout, by id. Null-prototype and frozen — see the module comment for
 * why the prototype matters when the key comes from a URL.
 */
export const LAYOUTS: Readonly<Record<string, Layout>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Layout>, {
    [CITY_LAYOUT_ID]: CITY_LAYOUT,
    [DEMO_LAYOUT_ID]: DEMO_LAYOUT,
  }),
)

/**
 * The ids, in a stable order, for the error message below and for a test that
 * wants to iterate. Derived from `LAYOUTS` rather than written twice: two
 * sources of truth for "which layouts exist" drift, and the one that only
 * appears inside an error string is the one nobody checks.
 */
export const LAYOUT_IDS: readonly string[] = Object.freeze(Object.keys(LAYOUTS).sort())

/**
 * The layout for `id`, or the default when there is no token at all.
 *
 * **An unknown id THROWS rather than falling back to the default**, and that is
 * the whole reason this function exists instead of `LAYOUTS[id] ?? DEMO_LAYOUT`.
 * A silent fallback means a mistyped `?startapp=` link opens the default board
 * while the player believes they are looking at the one they asked for — the
 * failure that produced this registry in the first place, when `?startapp=demoo`
 * would have booted the frozen starting city and looked *exactly* like "the
 * demo link does nothing". It survives the default moving: today a typo would
 * silently open the demo instead of the `city` a reader asked for, which is the
 * same lie with the boards swapped. A named throw is the only outcome a
 * mistyped link cannot be confused with.
 *
 * `''` and `undefined` both mean "no token was supplied" — `layoutToken`
 * (`main.ts`) returns the empty string for a value outside Telegram's
 * `startapp` charset, which is not a typo but a value that did not come from a
 * Telegram link at all.
 */
export function layoutFor(id: string | undefined): Layout {
  if (id === undefined || id === '') return LAYOUTS[DEFAULT_LAYOUT_ID] as Layout
  const layout = LAYOUTS[id]
  if (layout === undefined) {
    throw new Error(
      `layoutFor: unknown layout "${id}" — the layouts that exist are ${LAYOUT_IDS.join(', ')}. ` +
        'This throws rather than falling back to the default board, because a mistyped ' +
        '?startapp= link that silently opens the default is indistinguishable from the ' +
        'layout not working at all.',
    )
  }
  return layout
}
