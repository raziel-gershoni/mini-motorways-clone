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
 * **The point of the indirection is that the default path stays literally
 * today's code.** `layoutFor(undefined)` returns the `city` entry, whose four
 * fields are `firstCity`, `seedStartingCity`, `RUN_SEED` and `WARM_START_TICKS`
 * — the four things `createGame` used to name inline. No golden can move
 * through this file, and `layouts.test.ts` asserts that the city entry holds
 * exactly those four values rather than trusting the reading.
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
 * What a run opens on when no layout is named — the shipped starting city.
 *
 * Changing this is changing what every player sees, and it would also change
 * which board `integration.test.ts` re-derives its 258 warm-start ticks from.
 */
export const DEFAULT_LAYOUT_ID = CITY_LAYOUT_ID

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
 * the whole reason this function exists instead of `LAYOUTS[id] ?? CITY_LAYOUT`.
 * A silent fallback means `?startapp=demoo` boots the shipped starting city and
 * looks *exactly* like the bug this layout was written to fix — the player
 * opens the link, sees six frozen cars, and reports "it looks like the same
 * demo" a second time, with nothing to point at. A named throw is the only
 * outcome a mistyped link cannot be confused with.
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
        '?startapp= link that silently boots the shipped city is indistinguishable from the ' +
        'layout not working at all.',
    )
  }
  return layout
}
