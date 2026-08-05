import {
  placeDestination,
  placeHouse,
  DEST_KIND_CIRCLE,
  DEST_KIND_SQUARE,
  ORIENTATION_E,
  ORIENTATION_W,
  type GameState,
  type WorldData,
} from '@laneways/sim'

/**
 * The hand-authored starting city: a few houses and destinations at literal
 * cell coordinates, placed once at startup, fully deterministic, no schedule
 * and no RNG.
 *
 * **M1e REPLACES THIS FILE.** It is not M1e's authored spawn schedule and it
 * must not grow into one. `placeHouse`/`placeDestination` (`buildings.ts`) had
 * no production caller anywhere in `packages/` before this file existed, and
 * `step`'s seven phases contain no spawner: without a seed an M2 build renders
 * terrain and roads and nothing else — no house, no destination, no pin, no
 * car, no score — and M2's Goal is unreachable. This is the smallest thing
 * that makes the Goal reachable, and nothing more.
 *
 * **The seed is out of band, so an M2 run is NOT replayable by a Worker.**
 * Server-side verification replays `(seed, mapId, actions)` through `step`,
 * and these placements travel through none of those: they are a direct call
 * before the first tick, invisible to the input log. M2 therefore submits
 * nothing to a leaderboard. M1e's in-`step` spawner is what restores
 * replayability, and M3's persistence depends on that having happened. This
 * paragraph is the difference between a known limitation and a discovered one.
 *
 * ---------------------------------------------------------------------------
 * THE CITY, and why each building sits where it does
 * ---------------------------------------------------------------------------
 *
 * `firstCity` is 24 x 40 with `groupCount` 5 and `startingTiles` 30. M2 draws
 * the revealed rect `x` in [5, 18], `y` in [9, 30] (plan Decision 5), and a
 * building outside it is invisible — so every one of the 24 cells this seed
 * occupies is inside it. The river runs down column 12 on every row except 18
 * and 19, which are the two-cell bridgeable gap.
 *
 *              x=8   9  10  11        14  15  16  17
 *      y=10   [cp0][##][##][##]                          D0  colour 0, square
 *      y=11        [##][##][##]
 *      y=13   (H1)                                       house 1, colour 0
 *      y=14                          [##][##][##][cp2]   D2  colour 1, circle
 *      y=15                          [##][##][##]
 *      y=18   [cp1][##][##][##]                    (H2)  D1  colour 0, square
 *      y=19        [##][##][##]                          house 2, colour 1
 *      y=24   (H0)                                       house 0, colour 0
 *
 *   - **Both colour-0 destinations open WEST** (`ORIENTATION_W`, carpark at
 *     `(x0 - 1, y0)`), so their carparks land on column 8 — a clear column
 *     from y=10 to y=24 with no tree, no river and no other building on it.
 *     That column is the natural first road the player draws, 15 cells for 15
 *     of the 30 starting tiles, and it connects both colour-0 houses to both
 *     colour-0 destinations at once.
 *   - **House 0 is the FARTHER colour-0 house and house 1 the nearer**, so the
 *     nearer house sits at the HIGHER index. Along that column the four road
 *     costs are 30 / 50 / 60 / 140 (house1->D0, house1->D1, house0->D1,
 *     house0->D0), which is the strict ordering that makes "pick the first
 *     house", "pick the lowest index" and "pick the largest dist" all
 *     distinguishable, and which lets a scored trip depart from and return to
 *     a house that is NOT nearest to its own destination — see the note below.
 *   - **Two colour-0 destinations, not one.** With a single pinned
 *     destination the flow field is single-source, so `argmin dist[houseCell]`
 *     is always the nearest house and no later dispatch iteration can differ.
 *     The second destination is what gives every later task a board on which
 *     dispatch's exclusion rule is observable at all.
 *   - **D2 is a CIRCLE and the other two are SQUARES**, so a real frame
 *     exercises both destination kinds rather than leaving one to a hand-built
 *     fixture. It is also the only colour-1 building pair, and it sits east of
 *     the river with its house, so no same-colour pair is split across the
 *     bridgeable gap. The river is avoided DELIBERATELY, not by accident: a
 *     split pair would be connectable only through rows 18-19 and could not be
 *     wired inside 30 tiles alongside anything else.
 *   - Every cell is `TERRAIN.LAND`. `TREE` is passable but a standing tree
 *     rejects placement outright, and the eight trees inside the revealed rect
 *     — (6,9), (16,10), (9,15), (5,20), (17,21), (10,26), (15,28), (7,30) —
 *     are all clear of this layout.
 *   - Chebyshev spacing between any two destinations' 7-cell sets is 3, 3 and
 *     7 — all at or above the required 2.
 *
 * **Destinations are placed before houses.** `canPlaceHouse` rejects a cell
 * that lies inside any placed destination's 7 cells, and `canPlaceDestination`
 * rejects one that covers a placed house — so the order decides which function
 * reports an overlap, not whether one is caught. Destinations first also means
 * destination indices are 0, 1, 2 in the order above, which is the order
 * `demand.ts`'s rotation walks.
 *
 * **A rejected placement throws, naming the building.** Both `place*`
 * functions return `false` rather than throwing when the cell is unusable, and
 * a seed that ignores that return ships a half-built city: a missing house is
 * simply a colour that never dispatches, with nothing to point at. There is no
 * fallback position to try — the whole point of a hand-authored seed is that
 * the positions are decided in advance — so the only honest response is to
 * fail loudly at startup.
 */

/** One destination's literal placement. `x`/`y` are grid coordinates, never a flat cell index. */
export interface SeedDestination {
  readonly x: number
  readonly y: number
  readonly orientation: number
  readonly colour: number
  readonly kind: number
}

/** One house's literal placement. */
export interface SeedHouse {
  readonly x: number
  readonly y: number
  readonly colour: number
}

/**
 * The destinations, in placement order — which is also their slot index and
 * therefore their position in `demand.ts`'s rotation.
 *
 * `Object.freeze` on the array AND on each entry: `readonly` is a type-level
 * assertion with no runtime effect, and this table is exported, so a consumer
 * could otherwise edit the city in place.
 */
export const STARTING_DESTINATIONS: readonly SeedDestination[] = Object.freeze([
  // D0 — colour 0, square. Footprint (9..11, 10..11), carpark (8, 10).
  Object.freeze({ x: 9, y: 10, orientation: ORIENTATION_W, colour: 0, kind: DEST_KIND_SQUARE }),
  // D1 — colour 0, square. Footprint (9..11, 18..19), carpark (8, 18).
  Object.freeze({ x: 9, y: 18, orientation: ORIENTATION_W, colour: 0, kind: DEST_KIND_SQUARE }),
  // D2 — colour 1, circle. Footprint (14..16, 14..15), carpark (17, 14).
  Object.freeze({ x: 14, y: 14, orientation: ORIENTATION_E, colour: 1, kind: DEST_KIND_CIRCLE }),
])

/**
 * The houses, in placement order — which is also their slot index, and which
 * decides their car slots (`[h * CARS_PER_HOUSE, (h+1) * CARS_PER_HOUSE)`).
 *
 * House 0 is the farther colour-0 house and house 1 the nearer one: the nearer
 * house deliberately holds the HIGHER index, so a dispatch that picked the
 * first or lowest-index house rather than the closest one is visible.
 */
export const STARTING_HOUSES: readonly SeedHouse[] = Object.freeze([
  Object.freeze({ x: 8, y: 24, colour: 0 }), // house 0 — cars 0, 1
  Object.freeze({ x: 8, y: 13, colour: 0 }), // house 1 — cars 2, 3
  Object.freeze({ x: 17, y: 18, colour: 1 }), // house 2 — cars 4, 5
])

/**
 * Places the whole city into `state`, once, before the first tick.
 *
 * Call this exactly once on a fresh `GameState`. Calling it twice throws:
 * every placement in the second pass is rejected by the rule that placed the
 * first one, which is the correct outcome rather than a silently doubled city.
 *
 * `cell = y * world.w + x` is computed here, from the map the caller actually
 * holds, so the table above never hard-codes a width.
 */
export function seedStartingCity(state: GameState, world: WorldData): void {
  for (let i = 0; i < STARTING_DESTINATIONS.length; i++) {
    const d = STARTING_DESTINATIONS[i] as SeedDestination
    const cell = d.y * world.w + d.x
    if (!placeDestination(state, world, cell, d.orientation, d.colour, d.kind)) {
      throw new Error(
        `seedStartingCity: destination ${i} at (${d.x}, ${d.y}) [cell ${cell}] was rejected — ` +
          'the seed is hand-authored and has no fallback position, so a rejected placement would ' +
          'ship a half-built city instead of a failure',
      )
    }
  }

  for (let i = 0; i < STARTING_HOUSES.length; i++) {
    const h = STARTING_HOUSES[i] as SeedHouse
    const cell = h.y * world.w + h.x
    if (!placeHouse(state, world, cell, h.colour)) {
      throw new Error(
        `seedStartingCity: house ${i} at (${h.x}, ${h.y}) [cell ${cell}] was rejected — ` +
          'the seed is hand-authored and has no fallback position, so a rejected placement would ' +
          'ship a half-built city instead of a failure',
      )
    }
  }
}
