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
 * changed twice.** Each entry names four values that live in their own file —
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
 * What a run opens on when no layout is named — **the starting city**.
 *
 * ---------------------------------------------------------------------------
 * WHY IT MOVED BACK, AND WHICH OF THE OLD REASONS STOPPED BEING TRUE
 * ---------------------------------------------------------------------------
 *
 * M1d demoted this board with four clauses. **Three of them end here and one
 * does not**, and saying which is the whole content of this comment — the
 * mirror-image overclaim ("the city is alive now") would be exactly the
 * unmeasured sentence that got the board demoted in the first place.
 *
 *   - *"six cars that never move"* — **ends.** The spawner (M1e Task 5) adds
 *     houses from tick 300 and destinations every half-week, and a player who
 *     draws the opening below has cars running immediately. Measured on the
 *     real boot path with a scripted greedy-connect trace: **25 houses, 12
 *     destinations, 747 completed trips and 11 cars in flight at once** by
 *     week 6, of which **9 belong to houses the spawner placed**.
 *   - *"nothing can add a car"* — **ends.** That is the whole of Task 5.
 *   - *"M1d's blocking cannot fire there"* — **ends, LATE.** On the same trace
 *     `blockedTicks` is 0 through week 1, 99 in week 2 and 597-639 a week from
 *     week 5, with the longest standing queue reaching 4. It is a week-5
 *     property, not a first-minute one.
 *   - **`refusals` stays 0 on this board for the whole measured run**, where
 *     the demo board scores thousands. That clause did NOT stop being true and
 *     is not claimed. The starting city after M1e is a board that **loads up
 *     and eventually fails**, not a board that grinds; those are different
 *     feelings and only one of them is the demo board's.
 *
 * **THE DIFFICULTY CURVE'S SHAPE, WHICH THE GATE MEASURES AND DOES NOT JUDGE —
 * carried to M1f (`docs/superpowers/m1f-carry-forward.md` §12).** Task 10's
 * gate establishes that the curve EXISTS; it says nothing about whether it is
 * good, and two measured facts about its shape have no owner:
 *
 *   - **The first ten minutes are unloseable.** Weeks 0-3 hold every connected
 *     destination at one pin, so a competent player cannot lose in that window
 *     except by leaving a destination unconnected — which is the spawner's
 *     unreachability failure (`sim/spawn.ts`'s module comment), not a
 *     difficulty ramp.
 *   - **Under greedy play the board is dead at 17:29**, and the greedy arm is an
 *     *upper bound* on "a player who keeps up" rather than a model of one: its
 *     connector is optimal and instant. Gate A's and Gate C's figures should be
 *     read as "what is reachable", never as "what is typical".
 *
 * Both are judgements about pacing, and **the only instrument for them is a
 * human with the app open** — which is Task 12's device session, and the thing
 * in this milestone with the least evidence behind it. Note also that the gate
 * is ONE SEED (`laneways-m2`, the one that ships, which is the right choice for
 * a claim about the shipped board): three of the five seeds measured do not
 * produce the clean 1 -> 2 -> 5 -> 10 gradient, so a spawner change in M1f may
 * move the gate for reasons specific to this seed.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CHECKABLE FACTS BEHIND DECISION 13'S OPENING
 * ---------------------------------------------------------------------------
 *
 *   - **The opening is solvable for 20 of the 30 starting tiles** — 18 `place`
 *     actions, all accepted — down column 17 (`y` 14..18) and column 8
 *     (`y` 10..24). `startingCity.test.ts` drives both strokes through `step`.
 *   - **The river's two-cell land gap at rows 18-19 keeps the board connected
 *     without bridges**, so nothing the player has to build crosses water.
 *   - **The demo board keeps its id, its seed, its warm start and its golden,
 *     and is one token away** — `?layout=demo` / `?startapp=demo`. Flipping
 *     this line back is one token of source.
 *
 * **What a plain load does NOT do is survive.** With no input at all the city
 * shuts down on tick **5,580** (3 min 06 s) on D2, whose carpark carries no
 * road — so the shutdown screen reads `NOTHING CAN REACH DESTINATION 2`, which
 * is the OTHER arm from the one the demo board produced. (The line read `NO
 * ROAD REACHES DESTINATION 2` until M1f widened the predicate behind it from
 * "a road bit is on the bay" to "a car can get there"; the arm this board takes
 * did not change, only the sentence.) That change is
 * player-visible copy and it is asserted in `integration.test.ts`. Five tiles
 * on column 17 remove that death entirely (`startingCity.test.ts`), and the
 * latest draw that still saves it is tick 5,550 — 95 % of the run.
 *
 * ---------------------------------------------------------------------------
 * WHAT DEPENDS ON THIS CONSTANT
 * ---------------------------------------------------------------------------
 *
 * Everything a plain load does, and nothing else. No golden reads it: every
 * test that cares which board it is on names the id (`layouts.test.ts`'s own
 * default case is the one exception, and it exists precisely to be that
 * exception). `integration.test.ts`'s rig already pinned `city` explicitly for
 * its arithmetic cases, and its demo-board shutdown cases now pin `demo` for
 * the same reason — a case that asserts one board's death tick must not follow
 * this line.
 *
 * Changing this line changes what every player sees, so it has a detector that
 * names the answer: `layouts.test.ts`'s *"the default is the starting city, by
 * name"*. A flip fails there first, with the id it was flipped to in the
 * message, rather than diffusely across twenty boards-worth of assertions —
 * and `startingCity.test.ts`'s survivability gate boots through THIS constant,
 * so a flip back to a board that cannot pass the gate fails there too.
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
 * the whole reason this function exists instead of `LAYOUTS[id] ?? DEMO_LAYOUT`.
 * A silent fallback means a mistyped `?startapp=` link opens the default board
 * while the player believes they are looking at the one they asked for — the
 * failure that produced this registry in the first place, when `?startapp=demoo`
 * would have booted the frozen starting city and looked *exactly* like "the
 * demo link does nothing". It survives the default moving in either direction:
 * with the city as the default a typo would silently open the city instead of
 * the `demo` a reader asked for, which is the original lie with the boards
 * swapped back. A named throw is the only outcome a mistyped link cannot be
 * confused with.
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
