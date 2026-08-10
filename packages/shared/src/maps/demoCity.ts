import { parseMap, type MapData } from '../mapFormat'

/**
 * The board the **demo layout** runs on — `?startapp=demo`, and
 * `?layout=demo` in a plain browser. `packages/game/src/demoLayout.ts` is the
 * seeder that fills it; `packages/game/src/layouts.ts` is the registry that
 * pairs the two.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND MAP AND NOT AN EDIT OF `firstCity`
 * ---------------------------------------------------------------------------
 *
 * `mapIdHash` (`packages/sim/src/world.ts`) folds `id`, `w`, `h`,
 * `startingTiles`, `maxHouses`, `maxDestinations`, `groupCount` and every
 * terrain byte into `mapIdentity[MI_MAP]`, which lives in the state buffer. So
 * changing ONE integer on `firstCity` moves the state golden `3507307907`, the
 * road-network golden `2312109239`, the loop golden `3806414869` and the seed
 * golden `968680755` at once — the trap
 * `docs/superpowers/plans/2026-08-04-m2-playable-renderer.md:20` records. A new
 * file, a new `id`, and `firstCity` untouched byte-for-byte is the only shape
 * that leaves all seven goldens where they are.
 *
 * (Those four were `340556353`, `2076760277`, `2942219448` and `1178110182`
 * until M1e Task 1 re-blessed every whole-buffer golden for pure layout. The
 * numbers move; the trap does not.)
 *
 * `maxDestinations` is the field that forced the issue rather than a
 * preference: the demo needs **18** circle destinations to generate enough
 * demand to keep 24 cars in flight, and `firstCity` allows 16.
 *
 * ---------------------------------------------------------------------------
 * THE THREE LIMITS, EACH DERIVED FROM THE MEASURED OPERATING POINT
 * ---------------------------------------------------------------------------
 *
 *   - **`maxHouses` 12** -> `12 * CARS_PER_HOUSE` = **24 cars**. Measured over
 *     20,000 ticks this fleet queues continuously and never gridlocks; the
 *     first draft of this layout ran 24 cars through ONE shared trunk and
 *     delivered 47 trips in 20,000 ticks — total gridlock, ground forward only
 *     by the anti-deadlock valve. See `demoLayout.ts` for that measurement and
 *     what fixed it.
 *   - **`maxDestinations` 18** — six rows of three, all circles, so 36 rotation
 *     slots. `PIN_PERIOD_TICKS` is 518, so the board pins once every
 *     `518 / 36` = **14.4 ticks**, against a measured service rate of one trip
 *     per 15.1 ticks. Demand and service are matched to within 5 %, which is
 *     what keeps every car busy without saturating a single destination.
 *   - **`groupCount` 3** — one colour per corridor. Four is not better: a
 *     fourth colour has nowhere to put its destination column inside the
 *     revealed rect without sharing a corridor, and a shared corridor is
 *     exactly what the first draft died of.
 *
 * **`startingTiles` 200** against a seeded network of 71 cells. The demo's
 * headline erase — drag over three corridor cells, watch them ghost while cars
 * still drive them — is only interesting if the player can then redraw them, so
 * the budget is deliberately more than twice what the seed spends.
 *
 * ---------------------------------------------------------------------------
 * THE TERRAIN: ALL LAND, TEN TREES, AND WHERE THEY MAY NOT GO
 * ---------------------------------------------------------------------------
 *
 * No water and no mountain, deliberately. The seeder hard-codes 70 road
 * segments at literal coordinates and throws rather than degrading, so an
 * impassable cell anywhere on a corridor is a boot failure, not a detour.
 *
 * The ten trees are decoration — they prove the terrain layer draws — and every
 * one sits inside the revealed rect (`x` in [5, 18], `y` in [9, 30]) where a
 * human can see it. Their placement is constrained on three sides at once:
 *
 *   - **Not on a destination's 7 cells.** `canPlaceDestination` rejects a
 *     standing tree outright. The destination rows are `y` in {9, 12, 15, 18,
 *     21, 24} and each footprint is 2 rows tall, so rows 9-10, 12-13, 15-16,
 *     18-19, 21-22 and 24-25 are all spoken for. Every tree is on row 11, 14,
 *     17, 20, 23, 26, 27, 29 or 30.
 *   - **Not on a road cell.** A road placed on a tree CLEARS it
 *     (`state.cleared`), so a tree under the seeded network would silently
 *     vanish on boot and take a byte of state with it. The corridors are
 *     `x` in {8, 13, 15} (and 16 below row 26) and the street is row 28; no
 *     tree is on either.
 *   - **Not on a house cell.** `canPlaceHouse` rejects a standing tree too.
 *
 *              x=5  6  7  8  9 10 11 12 13 14 15 16 17 18
 *      y=11         T
 *      y=14                                          T
 *      y=17    T
 *      y=20                                              T
 *      y=23            T                                 T
 *      y=26                          T
 *      y=27         T
 *      y=29                              T
 *      y=30                        T
 *
 * Row data is `Object.freeze([...] as const)` at module scope — Task 1's AST
 * rule — and `demoCity()` calls `parseMap` at call time, so no `MapData` and no
 * typed array is ever allocated at module scope.
 */
const ROWS = Object.freeze([
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '......T.................',
  '........................',
  '........................',
  '.................T......',
  '........................',
  '........................',
  '.....T..................',
  '........................',
  '........................',
  '..................T.....',
  '........................',
  '........................',
  '.......T..........T.....',
  '........................',
  '........................',
  '...........T............',
  '......T.................',
  '........................',
  '............T...........',
  '..........T.............',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
] as const)

export function demoCity(): MapData {
  //          id          rows  startingTiles  maxHouses  maxDestinations  groupCount
  return parseMap('demoCity', ROWS, 200, 12, 18, 3)
}
