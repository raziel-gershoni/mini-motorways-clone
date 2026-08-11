import {
  placeDestination,
  placeHouse,
  placeRoad,
  DEST_KIND_CIRCLE,
  ORIENTATION_E,
  ORIENTATION_W,
  type GameState,
  type WorldData,
} from '@laneways/sim'
import type { SeedDestination, SeedHouse } from './startingCity'

/**
 * **The demo layout — the board that makes M1d visible.**
 *
 * M1d shipped per-(cell, lane) occupancy so cars block each other, ghost roads
 * with a delayed refund, and lane-speed multipliers. All correct, all tested,
 * all reviewed — and all **invisible**: instrumented over 200,000 ticks on the
 * exact production boot, the shipped starting city produces `REFUSED_OCCUPIED`
 * 0, `ENTER_VALVE` 0, and a maximum of **one** car in flight. Six cars, frozen.
 * The player opened it and said it looked like the same demo. They were right.
 *
 * This file is the board where all of it fires, and **it is the board a plain
 * load now opens on** — `DEFAULT_LAYOUT_ID` (`layouts.ts`). It shipped behind
 * `?startapp=demo` / `?layout=demo` first, which left the default the board
 * that demonstrates nothing; there was no reason for that and the default
 * moved. It still changes **nothing** about the starting city, which is now the
 * one behind a token (`?layout=city`): `startingCity.ts` and `firstCity.ts` are
 * untouched byte-for-byte and every golden holds.
 *
 * ---------------------------------------------------------------------------
 * THE ARITHMETIC, AND THE DRAFT THAT FAILED IT
 * ---------------------------------------------------------------------------
 *
 * Two numbers have to be balanced against each other and neither is free.
 *
 * **Demand** is `slots / PIN_PERIOD_TICKS` per tick, board-wide.
 * `PIN_PERIOD_TICKS` is 518, global, and cannot be tuned per layout — threading
 * it through `runDemand` would change `step`'s pinned 5-argument arity and move
 * the loop and blocking goldens. Slots ARE a property of the layout, though: a
 * square contributes 1 and a circle 2 (`demand.ts:computeSlotCounts`). **18
 * circles = 36 slots = one pin every 14.4 ticks.** The shipped city's four
 * slots give one pin every 129.5 ticks, against a ~60-tick round trip — service
 * 4.3x faster than demand, which is exactly why nothing ever queues there.
 *
 * **Service** is what the road network can actually pass, and it is far lower
 * than a queueing-theory estimate suggests. The FIRST DRAFT of this layout was
 * built from one: three destination columns feeding a single shared trunk, 12
 * houses, 24 cars, with the two 100 %-flow junctions computed at rho = 0.65 and
 * "a standing queue of 1-3 cars, excursions to 5" predicted. Measured, it
 * delivered **47 trips in 20,000 ticks** with 446,569 refusals and **214 valve
 * firings** — total gridlock, ground forward only by the anti-deadlock valve,
 * with every car blocked for over a thousand consecutive ticks.
 *
 * **Why the estimate was wrong, and it is worth knowing rather than
 * re-deriving:** outbound and return traverse the SAME cells (a return leg is
 * the committed route read backwards, `cars.ts`), so a corridor's two lanes are
 * not two independent servers — and at a junction there is no "do not block the
 * box" rule, so a car standing in the junction waiting to turn holds a lane
 * that a perpendicular flow needs. Utilisation per lane says nothing about
 * that; the failure is a spinlock, not a queue. The load knee for a single
 * shared trunk measured at **between 6 and 8 houses**: 12 cars gave 306 trips,
 * 16 cars gave 110.
 *
 * **What fixed it was topology, not tuning: three independent corridors, one
 * per colour.** Each colour's cars use one column and never touch the other
 * two; the only shared road is the house street. Same 24 cars, same 18
 * destinations:
 *
 * **Both columns below were measured before M1e Tasks 5 and 6 and the
 * right-hand `trips` figure is now STALE — corrected here at Task 7 rather than
 * left to be rediscovered.** On today's tree this board scores **1,464** trips
 * over 20,000 ticks, not 1,324. Task 5's §5.3.5 blocked-spawn push accounts for
 * 6 of the difference and Task 6's weekly demand ramp for the other 134: with
 * `H_DEST_SPAWN_TIMER` parked the figure is 1,460, with the ramp neutralised to
 * the bare `PIN_PERIOD_TICKS` it is 1,330, and with both it reproduces **1,324
 * exactly**. The rest of the table is a comparison against a layout that no
 * longer exists and nothing re-measures it; read it as the design record it is.
 *
 * | over 20,000 ticks      | one shared trunk | three corridors |
 * |------------------------|------------------|-----------------|
 * | trips                  | 47               | **1,324** (1,464 today) |
 * | refusals               | 446,569          | 23,092          |
 * | refusals per tick      | 22.3             | **1.15**        |
 * | ticks with a blocked car | 19,560 (98 %)  | **10,464 (52 %)** |
 * | valve firings          | 214              | **0**           |
 * | max cars in flight     | 24               | 24              |
 *
 * The right-hand column is the target, and the left-hand one is what "more
 * congestion" looks like when it goes too far: **a valve firing is a car
 * driving through another car**, which reads as a bug rather than a feature.
 * Decision 6's claim is that a gridlocked city *grinds rather than stops*; a
 * layout that stops demonstrates the opposite of the thing M1d shipped.
 *
 * ---------------------------------------------------------------------------
 * THE BOARD
 * ---------------------------------------------------------------------------
 *
 * All of it inside the revealed rect, `x` in [5, 18], `y` in [9, 30].
 *
 * ```
 *        x= 5  6  7  8  9 10 11 12 13 14 15 16 17 18
 *   y=9  [D ][D ][D ][cp]   [D ][D ][D ][cp]   [cp][D ][D ][D ]
 *   y=10 [D ][D ][D ] |     [D ][D ][D ] |      |  [D ][D ][D ]
 *   y=12 (repeat at y = 12, 15, 18, 21, 24)
 *   ...
 *   y=26                    |            |      +--+                 <- dogleg
 *   y=27           (H)------+            |(H)      |
 *   y=28 (H)(H)(H)-+--(H)(H)(H)(H)-+-(H)(H)(H)-+--(H)
 * ```
 *
 *   - **Six destination rows** at `y` = 9, 12, 15, 18, 21, 24. Each row holds
 *     one destination of each colour: colour 0 at `x` = 5 opening EAST (carpark
 *     at `x` = 8), colour 1 at `x` = 10 opening EAST (carpark at 13), colour 2
 *     at `x` = 16 opening WEST (carpark at 15). Row pitch 3 and column gaps of
 *     2 keep every pair of 7-cell sets at Chebyshev distance >= 2, which is the
 *     spacing rule `canPlaceDestination` enforces.
 *   - **Three corridors run THROUGH the carparks** — columns 8, 13 and 15, from
 *     `y` = 9 down to the street. That is deliberate and it is the whole design:
 *     each corridor serves exactly one colour, so colour 0's traffic never meets
 *     colour 1's. It also means a car parked at a carpark stands in the corridor
 *     and the next car up the column has to wait for it, which is the clearest
 *     picture of blocking on the board.
 *   - **One house street**, row 28, `x` = 5..17, with twelve houses on it (two
 *     of them one row up, on corridor cells). This is the only shared road, and
 *     it is where the cross-colour queueing happens.
 *   - **The dogleg.** Corridor C leaves column 15 at `y` = 26 and reaches the
 *     street at `x` = 16, through `(15,26) -> (16,26) -> (16,27) -> (16,28)`.
 *     Its only job is to put two PLAIN degree-2 right angles on the board: 667
 *     alone gives 220 units and **12 ticks** per cell, against **14** for the
 *     same turn at a corridor mouth (583 -> 192, averaged with the junction
 *     multiplier), **16** for a straight run through a mouth (500 -> 165) and
 *     **8** on an open corridor. Four distinct crossing speeds, all visible at
 *     once, with a follower closing up behind each.
 *
 * **Colours are assigned four houses each** so no corridor carries a double
 * share: colour 0 at (5,28), (9,28), (12,28), (17,28); colour 1 at (6,28),
 * (10,28), (14,28), (8,27); colour 2 at (7,28), (11,28), (15,28), (13,27).
 *
 * **The network is a TREE** — 71 cells, 70 segments, one component — so there
 * is exactly one path between any two cells and the flow field cannot route
 * around a queue. `demoLayout.test.ts` asserts all three numbers.
 *
 * ---------------------------------------------------------------------------
 * WHAT A HUMAN SEES, AND WHAT THEY DO NOT
 * ---------------------------------------------------------------------------
 *
 * Measured over the 900 ticks (30 s) that follow the warm start: **18.7 cars in
 * flight on average**, at least one car refused entry on **52.6 %** of ticks,
 * and a queue of three or more cars standing on **55.8 %** of ticks, longest 7.
 *
 * **The queue figures are lower than this file first claimed (69 %, longest 10
 * over 20,000 ticks) and the layout did not change — the instrument did.**
 * `queueProbe.ts` keyed occupancy by the cell alone, on a board whose second
 * headline below is that one cell carries two lanes; it disagreed with
 * `canEnter` on 15.2 % of the questions it asked here. Re-measured against the
 * slot the sim actually reads: **55.8 % over the 30 s window, 58.8 % and a
 * longest queue of 8 over 20,000 ticks.** The refusal and in-flight figures come
 * off `carBlockedTicks` and `carPhase` and never went through the probe, so they
 * are unchanged.
 *
 *   1. **Cars stopping dead behind each other** — at the three corridor mouths,
 *      and behind any car parked at a mid-corridor carpark.
 *   2. **Two lanes in opposite directions on one road** — every corridor cell
 *      carries northbound (lane 1) and southbound (lane 0) traffic at once, so
 *      a car slides *through* a standing queue in the other direction. This is
 *      `LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]`, and it is the single best
 *      picture of it.
 *   3. **Speed steps** — 8 / 12 / 14 / 16 ticks per cell, see the dogleg above.
 *   4. **Ghost roads — a conditional, and the conditional is the interesting
 *      part.** Drag-erase along a corridor. A drag samples adjacent pairs, so a
 *      stroke over N cells takes BOTH bits off the **N - 2 cells in the middle**
 *      (`mask -> 0`), which is what `eraseRoad`/`settleErasedCell` require; the
 *      two end cells keep their other bit and correctly do not ghost. Three
 *      fading cells therefore wants a FIVE-cell stroke, not a three-cell one.
 *
 *      **Whether a cleared cell fades or simply vanishes depends on the traffic
 *      at that instant.** `settleErasedCell` asks `countCommittedCars`: a cell
 *      still on some car's committed route becomes a ghost — driveable, and
 *      unrefunded until the last of those cars leaves it — and a cell on
 *      nobody's route is deleted outright with its tile refunded on the spot.
 *      Measured on the real boot path, over `(8,15)..(8,19)`:
 *
 *        - **at the first frame a player sees, all three middle cells are
 *          uncommitted**, so the stroke deletes them, pays +3 tiles at once,
 *          and nothing fades at all;
 *        - eighteen ticks later all three are committed, and the identical
 *          stroke pays nothing, ghosts all three at `ghostCommitted = 1`, and
 *          the three tiles arrive 120 ticks later as those cars clear;
 *        - across the 3,000 ticks after the warm start the three are committed
 *          on 69.8 %, 69.8 % and 89.4 % of ticks, all three at once on 68.2 %,
 *          and none of them on 10.6 %.
 *
 *      So: try it a few seconds in, and try it more than once. It is usually
 *      **one** car's commitment holding a cell rather than "every car of that
 *      colour", and on an idle corridor there is no ghost to see. Either way
 *      redrawing pays whatever the erase deferred, so the tile counter nets
 *      exactly zero. `demoLayout.test.ts` §6 is the detector for both branches.
 *   5. **Two cars crossing inside one junction cell.** It happens at the three
 *      corridor mouths, and it is a KNOWN GAP, not a feature: `roads.ts:160-167`
 *      states in source that two lanes do not model an intersection crossing and
 *      names M1e's traffic lights and roundabouts as the work. Showing it
 *      silently, on a board built to demonstrate that cars block each other, is
 *      the misleading option; naming it is not.
 *   6. **THE CITY SHUTS DOWN AT 3 MINUTES 43 SECONDS, on tick 6,703, with no
 *      player error possible — measured at M1e Task 7 on this exact boot path.**
 *      D2, the colour-2 circle at grid (16, 9), receives its last car at tick
 *      **1,549** — 349 ticks, 11.6 seconds, after the first frame a player sees
 *      — and then sits at or over its trigger cap of 8 from tick 3,314 for
 *      3,390 consecutive ticks, which is exactly what §5.8's meter needs. So a
 *      watcher gets **70 seconds of visible play** before the timer even
 *      starts, and about 113 more while it fills. It is DEPRIORITISED rather
 *      than unreachable: it is connected and it is served six times, but it is
 *      at the far end of corridor C, cars route to the nearest unfilled pin of
 *      their colour, and once the nearer colour-2 destinations are generating
 *      pins it never wins a dispatch again.
 *      Removing the arrival knockback, the unwind, or both moves the tick by
 *      **zero**. Plan Decision 7 accepts this deliberately — a board authored
 *      to be badly run should die in the milestone about badly-run cities
 *      dying — and Task 8 is what turns the meter reaching its threshold into
 *      an actual shutdown. **Until Task 8 lands, nothing visible happens at
 *      6,703 and the board keeps running.** Task 9 draws the ring that makes
 *      the last two minutes of it legible.
 *   7. **NOT the anti-deadlock valve**, by design. It fires at 1,350 consecutive
 *      blocked ticks — 45 seconds of one car being refused every single tick —
 *      and on this layout it never fires at all over 20,000 ticks. That is the
 *      correct outcome: see the table above for what a board that DOES fire it
 *      looks like.
 */

/** One road segment, in grid coordinates. `placeRoad` takes cells; the seeder converts. */
export interface SeedRoad {
  readonly ax: number
  readonly ay: number
  readonly bx: number
  readonly by: number
}

/**
 * The 18 destinations, in placement order — which is their slot index and
 * therefore their position in `demand.ts`'s rotation.
 *
 * Written out rather than generated, in `startingCity.ts`'s idiom: the table IS
 * the design, a generator hides an off-by-one in a loop bound, and a reader
 * checking the geometry against the diagram above wants coordinates.
 *
 * `Object.freeze` on the array AND on each entry: `readonly` is a type-level
 * assertion with no runtime effect, and this table is exported.
 */
export const DEMO_DESTINATIONS: readonly SeedDestination[] = Object.freeze([
  // Row 9
  Object.freeze({ x: 5, y: 9, orientation: ORIENTATION_E, colour: 0, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 10, y: 9, orientation: ORIENTATION_E, colour: 1, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 16, y: 9, orientation: ORIENTATION_W, colour: 2, kind: DEST_KIND_CIRCLE }),
  // Row 12
  Object.freeze({ x: 5, y: 12, orientation: ORIENTATION_E, colour: 0, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 10, y: 12, orientation: ORIENTATION_E, colour: 1, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 16, y: 12, orientation: ORIENTATION_W, colour: 2, kind: DEST_KIND_CIRCLE }),
  // Row 15
  Object.freeze({ x: 5, y: 15, orientation: ORIENTATION_E, colour: 0, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 10, y: 15, orientation: ORIENTATION_E, colour: 1, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 16, y: 15, orientation: ORIENTATION_W, colour: 2, kind: DEST_KIND_CIRCLE }),
  // Row 18
  Object.freeze({ x: 5, y: 18, orientation: ORIENTATION_E, colour: 0, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 10, y: 18, orientation: ORIENTATION_E, colour: 1, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 16, y: 18, orientation: ORIENTATION_W, colour: 2, kind: DEST_KIND_CIRCLE }),
  // Row 21
  Object.freeze({ x: 5, y: 21, orientation: ORIENTATION_E, colour: 0, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 10, y: 21, orientation: ORIENTATION_E, colour: 1, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 16, y: 21, orientation: ORIENTATION_W, colour: 2, kind: DEST_KIND_CIRCLE }),
  // Row 24
  Object.freeze({ x: 5, y: 24, orientation: ORIENTATION_E, colour: 0, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 10, y: 24, orientation: ORIENTATION_E, colour: 1, kind: DEST_KIND_CIRCLE }),
  Object.freeze({ x: 16, y: 24, orientation: ORIENTATION_W, colour: 2, kind: DEST_KIND_CIRCLE }),
])

/**
 * The 12 houses, in placement order — which is their slot index, and which
 * decides their car slots (`[h * CARS_PER_HOUSE, (h+1) * CARS_PER_HOUSE)`).
 *
 * Ten on the street and two one row up on a corridor cell. A house cell
 * necessarily carries a road, so a house on a corridor is not a special case —
 * it is what every house on the street already is.
 */
export const DEMO_HOUSES: readonly SeedHouse[] = Object.freeze([
  Object.freeze({ x: 5, y: 28, colour: 0 }), // cars 0, 1
  Object.freeze({ x: 6, y: 28, colour: 1 }), // cars 2, 3
  Object.freeze({ x: 7, y: 28, colour: 2 }), // cars 4, 5
  Object.freeze({ x: 9, y: 28, colour: 0 }), // cars 6, 7
  Object.freeze({ x: 10, y: 28, colour: 1 }), // cars 8, 9
  Object.freeze({ x: 11, y: 28, colour: 2 }), // cars 10, 11
  Object.freeze({ x: 12, y: 28, colour: 0 }), // cars 12, 13
  Object.freeze({ x: 14, y: 28, colour: 1 }), // cars 14, 15
  Object.freeze({ x: 15, y: 28, colour: 2 }), // cars 16, 17
  Object.freeze({ x: 17, y: 28, colour: 0 }), // cars 18, 19
  Object.freeze({ x: 8, y: 27, colour: 1 }), // cars 20, 21 — on corridor A
  Object.freeze({ x: 13, y: 27, colour: 2 }), // cars 22, 23 — on corridor B
])

/** Corridors A, B and C, then the house street — see `DEMO_ROADS`. */
function demoRoadSegments(): SeedRoad[] {
  const out: SeedRoad[] = []
  for (const x of [8, 13]) {
    for (let y = 9; y < 28; y++) out.push({ ax: x, ay: y, bx: x, by: y + 1 })
  }
  // Corridor C (colour 2): column 15 down to row 26, then the dogleg east.
  for (let y = 9; y < 26; y++) out.push({ ax: 15, ay: y, bx: 15, by: y + 1 })
  out.push({ ax: 15, ay: 26, bx: 16, by: 26 })
  out.push({ ax: 16, ay: 26, bx: 16, by: 27 })
  out.push({ ax: 16, ay: 27, bx: 16, by: 28 })
  // The house street.
  for (let x = 5; x < 17; x++) out.push({ ax: x, ay: 28, bx: x + 1, by: 28 })
  return out
}

/**
 * The 70 road segments, in placement order.
 *
 * **Generated at module load and frozen, unlike the two tables above**, and the
 * asymmetry is deliberate. A destination or a house is a design decision per
 * entry — a colour, an orientation, a rotation position — and writing 18 of
 * them out is how a reader checks them. A corridor is a RANGE: 19 identical
 * segments whose only content is "column 8, row 9 to row 28", and spelling that
 * out 19 times invites exactly the transcription error the loop cannot make.
 * The tests assert the count, the absence of duplicates, that every segment is
 * one orthogonal cell long, and the resulting degree at nine named cells.
 *
 * A plain array of frozen objects, frozen itself, built by a function called
 * once — no typed array and no `MapData` at module scope, per Task 1's AST rule.
 */
export const DEMO_ROADS: readonly SeedRoad[] = Object.freeze(
  demoRoadSegments().map((r) => Object.freeze(r)),
)

/**
 * The RNG seed the demo layout runs under.
 *
 * Its own, not `RUN_SEED`: the two layouts are two different runs and a shared
 * seed would make "which board am I on" depend on the map alone. Fixed rather
 * than random for the same reason `RUN_SEED` is — a playtest build where every
 * launch is the same board is a better instrument than one where it is not.
 */
export const DEMO_RUN_SEED = 'laneways-demo'

/**
 * How many ticks to run before the first frame is drawn on the demo layout.
 *
 * **The single most important number for "the first 30 seconds", and it is
 * measured rather than chosen.** The demo has to open ALREADY CONGESTED: a
 * board that starts empty and fills up over 40 seconds is the frozen six-car
 * board again for the first half of a playtest.
 *
 * The board's first pin lands at tick **163** — `FIRST_PIN_DELAY_TICKS` (120)
 * plus `ceil(PIN_PERIOD_TICKS / slotCount) - 1` = `ceil(518 / 12) - 1` = 43,
 * where 12 is one colour's slot count (six circles, two slots each). The first
 * car moves at tick 178. At tick 1,200, measured: **21 of 24 cars in flight, a
 * seven-car queue standing, 49 trips already scored.** That is the picture the
 * first frame should open on.
 *
 * **What it costs, measured:** 1,200 `step` calls at boot, about 40 ms on the
 * development machine — against 258 calls and 6.8 ms for the shipped city's
 * `WARM_START_TICKS`. One frame at 30 Hz is 33 ms, so this is roughly one
 * dropped frame's worth of work, once, before anything is drawn.
 */
export const DEMO_WARM_START_TICKS = 1200

/**
 * Places the whole demo layout into `state`, once, before the first tick.
 *
 * **The order is destinations, then houses, then roads, and it is forced.**
 * `canPlaceHouse` rejects a cell carrying a road AND a cell inside any
 * destination's 7 cells; `canPlaceDestination` rejects any of its 7 cells
 * carrying a road. So roads must come last, and destinations must precede
 * houses — otherwise a house on the street would be sitting under a road bit
 * before it is placed. Destinations first also fixes destination indices as
 * 0..17 in table order, which is the order `demand.ts`'s rotation walks.
 *
 * **A rejected placement throws, naming the building or the segment.** Both
 * `place*` functions and `placeRoad` return `false` rather than throwing when
 * the cell is unusable, and a seed that ignores that ships a half-built city:
 * a missing house is a colour that never dispatches and a missing road segment
 * is a corridor that silently dead-ends, with nothing to point at either way.
 * There is no fallback position to try — the whole point of a hand-authored
 * layout is that the positions are decided in advance.
 *
 * `cell = y * world.w + x` is computed here, from the map the caller holds, so
 * the tables never hard-code a width.
 *
 * **This allocates** — three loops over frozen literals. That is fine and it is
 * stated rather than assumed: this runs once, before tick 1, on the same
 * pre-tick path as `seedStartingCity`. Nothing here is on the tick or frame
 * path, and `allocation.test.ts` profiles neither.
 *
 * The clause that used to end that sentence — "plus whatever
 * `canPlaceDestination` allocates for its 7-cell arrays" — was true until M1e
 * Task 4 and is now false: those arrays are gone, and both placement predicates
 * measure 0.0000 B per call (`packages/game/test/placementAllocation.test.ts`).
 * The conclusion is unchanged and the reason is not, which is worth the two
 * lines because this is the file Task 5 extends.
 */
export function seedDemoLayout(state: GameState, world: WorldData): void {
  for (let i = 0; i < DEMO_DESTINATIONS.length; i++) {
    const d = DEMO_DESTINATIONS[i] as SeedDestination
    const cell = d.y * world.w + d.x
    if (!placeDestination(state, world, cell, d.orientation, d.colour, d.kind)) {
      throw new Error(
        `seedDemoLayout: destination ${i} at (${d.x}, ${d.y}) [cell ${cell}] was rejected — ` +
          'the layout is hand-authored and has no fallback position, so a rejected placement ' +
          'would ship a half-built city instead of a failure',
      )
    }
  }

  for (let i = 0; i < DEMO_HOUSES.length; i++) {
    const h = DEMO_HOUSES[i] as SeedHouse
    const cell = h.y * world.w + h.x
    if (!placeHouse(state, world, cell, h.colour)) {
      throw new Error(
        `seedDemoLayout: house ${i} at (${h.x}, ${h.y}) [cell ${cell}] was rejected — ` +
          'the layout is hand-authored and has no fallback position, so a rejected placement ' +
          'would ship a colour that never dispatches instead of a failure',
      )
    }
  }

  for (let i = 0; i < DEMO_ROADS.length; i++) {
    const r = DEMO_ROADS[i] as SeedRoad
    const a = r.ay * world.w + r.ax
    const b = r.by * world.w + r.bx
    if (!placeRoad(state, world, a, b)) {
      throw new Error(
        `seedDemoLayout: road ${i} (${r.ax}, ${r.ay})-(${r.bx}, ${r.by}) [cells ${a}-${b}] was ` +
          'rejected — the corridor would silently dead-end, so this fails loudly instead',
      )
    }
  }
}
