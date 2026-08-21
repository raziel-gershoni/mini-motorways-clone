import { MAX_BLOCKED_TICKS } from '@laneways/shared'
import type { GameState } from './state'
import type { WorldData } from './world'
import { DIR_COUNT, LANE_COUNT, LANE_OF_DIR, otherLane } from './roads'
import { junctionAdmitsOne } from './graph'
import { PHASE_OUTBOUND, PHASE_RETURNING } from './buildings'
/**
 * Deferred import, and the same rule every cycle in this package follows: read
 * only inside a function body (`canEnter`'s ghost branch), never at module
 * evaluation time. `dispatch.ts` does not import this module, so this edge is
 * one-way and not even a cycle — the walk lives there because that module owns
 * the `carRoute` codec and the definition of a committed route.
 */
import { isCommittedTo } from './dispatch'

/**
 * Occupancy: who is standing on which (cell, lane), and the claim/release
 * protocol that keeps that true — M1d design decisions 1, 3 and 6.
 *
 * **What this module is for.** Spec §5.5 asks one blocking question: *does an
 * inbound vehicle collide with a traversing vehicle on this chunk?* M1d answers
 * it with per-(cell, lane) occupancy in the state buffer, where the lane is a
 * frozen function of the direction of travel (`LANE_OF_DIR`, `roads.ts`).
 * Queueing, carpark queues and emergent gridlock all fall out of it, with no
 * collision physics anywhere.
 *
 * **Slot arithmetic: `slot = cell * LANE_COUNT + lane`.** This is the SECOND
 * index arithmetic this codebase carries, beside `index = y * w + x`, and the
 * two must not be confused. `occupancySlot` below is the single place it is
 * written; nothing else should compute it inline.
 *
 * ---------------------------------------------------------------------------
 * THIS WAS A ONE-SECOND HESITATION UNTIL M1f TASK 2. IT IS NOW A JAM, ON THE
 * BOARD THAT SHIPS, AND THE WHOLE SECTION BELOW IS KEPT AS THE CONTROL
 * ---------------------------------------------------------------------------
 *
 * **M1f Task 2 falsified the heading this section used to carry.** It read *"on
 * the arm that draws column 8, this is a one-second hesitation and not a jam"*,
 * and every measurement under it was correct for the tree that carried it.
 * Junction mutual exclusion changed all of them, and the M1e figures are kept
 * rather than deleted because they are the control this task is measured
 * against — the same probes, run against this commit's parent, return every one
 * of them to the digit.
 *
 * ```
 *   greedy arm, starting city         M1e Task 10   M1f Task 2 (wide rule)
 *   worst carBlockedTicks                      32   1,350 (saturated)
 *   valve firings                               0   15
 *   longest queue, peak week                    4   7
 *   blocked car-ticks over the run          2,120   45,986
 *   ticks with a blocked car                 6.2 %  26.2 %
 *   most cars blocked at once                   2   10
 *   H_ROUTES_REFUSED                            0   0
 *   trips / death tick                 747/31,456   344/21,704
 * ```
 *
 * **So the answer to "does M1d's headline feature fire on the board that
 * ships?" flipped from no to yes at this commit**, and it flipped because the
 * feature acquired the case it was written for: a 2-cycle. Two cars swapping
 * across an edge with a junction at each end each need the other's cell empty
 * and each is standing in it, and only the 45-second valve clears it. See
 * `canEnter` below and `MAX_BLOCKED_TICKS`'s own note, whose evidence table was
 * re-measured in the same commit.
 *
 * **`H_ROUTES_REFUSED` is still 0, and that is not evidence of anything** — see
 * the section immediately below, which was written to stop exactly that
 * inference and is more load-bearing now than when it was written.
 *
 * ---------------------------------------------------------------------------
 * THE M1e CONTROL, KEPT VERBATIM: ON THE ARM THAT DRAWS COLUMN 8, THIS WAS A
 * ONE-SECOND HESITATION AND NOT A JAM
 * ---------------------------------------------------------------------------
 *
 * **Read the heading. It used to say "on the board that ships", and that is a
 * claim about the BOARD which the measurements below do not support** — they
 * are a claim about one arm on one seed, and both qualifiers are load-bearing.
 *
 * **Measured, not presumed, at M1e Task 10 on the PLAYED default** (the starting
 * city under the greedy connector, which is the arm where cars actually run):
 * `H_ROUTES_REFUSED` is **0 over the whole run** and the worst
 * `carBlockedTicks` is **32 against a 1,350-tick valve — 42x from firing**.
 * Cars do stand behind each other (longest queue 4, 597 blocked ticks a week
 * from week 5), but nothing is ever refused a route and the valve cannot fire.
 * All of that reproduces exactly **on the parent of the M1f Task 2 commit, and
 * on nothing after it.**
 *
 * **What it rests on is the 20-tile opening stroke, and specifically the
 * COLUMN-8 half of it.** The greedy arm draws that opening on its first tick
 * and then connects on sight; drive the identical connect-on-sight policy with
 * the opening removed and the same board, same seed, same constants reaches:
 *
 * ```
 *   opening + connect-on-sight  max carBlockedTicks    32  queue 4  valve x0
 *   column 17 link only         max carBlockedTicks 1,350  queue 8  valve x4
 *   connect-on-sight only       max carBlockedTicks 1,350  queue 9  valve x11
 *   column 8 trunk only         max carBlockedTicks    32  queue 4  valve x0
 * ```
 *
 * The first valve firing on the connect-on-sight-only arm is tick **19,957**,
 * with a car blocked on **every tick of a 3,424-tick (114 s) window** and one
 * car held for the full 45-second threshold. **The trunk is what prevents the
 * jam, not the board** — the two arms that draw column 8 are the two that never
 * block past 32 ticks, and the two that do not are the two that valve.
 *
 * **And the seed is doing the other half of the work. On the SHIPPED arm,
 * unchanged in every respect, 6 of 8 `RUN_SEED` values fire the valve** —
 * 0, 5, 2, 4, 11, 0, 13, 4 firings across `laneways-m2` and seven others, with
 * `carBlockedTicks` saturating at 1,350 on six of them. `laneways-m2` is one of
 * the two quiet ones. So "the board cannot jam under shipped constants" is
 * false, and the honest statement is **"this seed, drawn this way, does not"**.
 *
 * **So M1d's headline feature WAS demo-only on the shipped seed's played arm**,
 * because M1e Task 10 flipped the default from `demoCity` to the starting city.
 * For this module specifically the flip was a trade and it was made with that
 * stated. For the user's actual complaint the flip is not a trade — 3 houses
 * become 25, 3 destinations become 12, 747 trips, and the outcome depends on
 * what they drew. **M1f Task 2 ended the demo-only part**: the valve fires 15
 * times on the shipped seed's played arm, and the two seed-and-trunk paragraphs
 * above are now a description of how narrowly it used to avoid doing so.
 *
 * Recorded here rather than only in a report because this is the module the
 * claim is about, and because the previous milestone's post-mortem is the
 * cautionary case: M1d shipped a headline feature that could not fire on the
 * board that shipped, and nobody noticed until a human opened it. Carried to
 * M1f in these words (`docs/superpowers/m1f-carry-forward.md` §10). **Do not
 * read `MAX_BLOCKED_TICKS`'s own note as this one** — that measures the
 * NO-INPUT path, where the default has zero refusals for the different and
 * duller reason that no road exists.
 *
 * ---------------------------------------------------------------------------
 * `H_ROUTES_REFUSED` IS NOT AN INSTRUMENT FOR ANY OF THIS
 * ---------------------------------------------------------------------------
 *
 * It is quoted above, and in `m1f-carry-forward.md` §5 and §15.3, as though its
 * being 0 said something about traffic. **It does not, and it never will.**
 * `dispatch.ts` increments it in exactly one place, for three conditions that
 * are all about the route WALK and none about the road being busy: a walk past
 * `MAX_PATH_LEN`, a zero-length route, and a walk that does not terminate on a
 * colour-matching carpark. Blocking cannot reach it — a car refused entry
 * keeps its committed route and waits.
 *
 * Measured rather than argued: on the shipped seed's greedy arm the **longest
 * route ever walked is 21 steps** against a ceiling of 96, so the length arm
 * has 75 steps of headroom; and setting `MAX_PATH_LEN` to **24** left the run
 * behaviourally unchanged — tick 31,456, 747 trips, refusals still **0** (the
 * M1e figures; that experiment has not been re-run since M1f Task 2 shortened
 * the arm to 21,704 / 344, and it does not need to be — the point is the
 * headroom, and the routes did not get longer). It is 0 on all sixteen
 * seed x arm runs measured, **and it is still 0 under junction mutual
 * exclusion**, which is the sharpest illustration this counter has ever had of
 * why it says nothing about traffic: the board's throughput fell 54 % and this
 * number did not move. **It will stay 0 under every
 * traffic lever, for a reason that has nothing to do with traffic.**
 *
 * The counters that do measure blocking are the ones in this module:
 * `carBlockedTicks` (per car, saturating), the count of blocked car-ticks, the
 * longest queue, and valve firings. Every figure in the table above is one of
 * those.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE LIFECYCLE EVENTS, IN FULL — DECISION 3
 * ---------------------------------------------------------------------------
 *
 * This is the single place the protocol is written down. All of them, and no
 * others:
 *
 *   1. **Creation.** `createState` (`state.ts`) fills the `occupancy` region
 *      with `FREE = -1`. An `Int16Array` region zero-initialises, and a
 *      zero-filled occupancy region reads as *"car 0 occupies every lane of
 *      every cell"* — nothing on the board could move. This is the ONE region
 *      in the whole buffer that is not all-zero at creation, and six prose
 *      sites that used to say "a fresh state writes no -1 sentinel anywhere"
 *      were narrowed in the same commit as this fill.
 *
 *   2. **A crossing INTO a cell claims `(cell, LANE_OF_DIR[dir])`**, where
 *      `dir` is the direction of that crossing — the value `advanceCar` already
 *      computes. `claimCell` below. The write is UNCONDITIONAL, so a slot
 *      always names the most recent car to have entered it.
 *
 *   3. **A crossing OUT of a cell releases it**, guarded by identity and
 *      clearing BOTH lanes: `releaseCell` below.
 *
 *   4. **Trip end releases.** `completeTrip` (`trips.ts`) is a release site. A
 *      returning car's last crossing genuinely enters the house cell, so it
 *      holds a claim there; if `completeTrip` did not release it, the car would
 *      hold its own front door forever and its sibling would stall the full
 *      valve on EVERY return leg. That is the most common trip in the game.
 *
 *   5. **Nothing else claims.** Not dispatch, not `placeHouse`, not an idle
 *      car. `arriveAtDestination` is deliberately NOT a release site either:
 *      the car does not move, it flips phase in place on the carpark cell, and
 *      it is still standing on the cell whose slot it holds.
 *
 * **The tick-0 ruling, decided: cars stack legally at their home cell.**
 * `placeHouse` puts `CARS_PER_HOUSE = 2` cars on one cell before any tick runs,
 * and dispatch can flip both of them OUTBOUND in the same tick. A house cell
 * necessarily carries a road (the flow field propagates only over road bits, so
 * a house whose cell has no road is never dispatched from), so this is the
 * steady state of every house, not a fixture artefact. Rule 2 above does the
 * work: a car that has not yet crossed on its current leg holds nothing, and an
 * idle car holds nothing, so two, three or `CARS_PER_HOUSE` cars on a house
 * cell is representable and correct.
 *
 * Note what that is NOT: house cells are **not exempt from occupancy**. A car
 * driving THROUGH a house cell claims it exactly like any other cell.
 * Exempting the cell would put a permanent hole in the blocking primitive that
 * a player could route traffic through.
 *
 * **A house's front door does not queue; the first crossing does.** Two cars
 * dispatched from one house in one tick both leave with no claim; the
 * lower-indexed one takes the first crossing and (from Task 3) the
 * higher-indexed one is refused at it. That is correct queueing, one cell later
 * than a naive reading, and it is what keeps dispatch correct without dispatch
 * ever being refused.
 *
 * ---------------------------------------------------------------------------
 * THE RELEASE RULE IS PART OF DECISION 6, NOT AN IMPLEMENTATION DETAIL
 * ---------------------------------------------------------------------------
 *
 * **Release is guarded by identity, and clears BOTH lanes of the vacated
 * cell.** Two comparisons, and it needs no direction at all.
 *
 * Releasing *"the lane derived from the direction I am leaving by"* is wrong
 * and is the corruption case: a car that entered a cell heading E and leaves it
 * heading N claimed lane 0 and would clear lane 1, leaving lane 0 claimed by a
 * car that is not there — a cell that silently stops blocking for the rest of
 * the run. **Every turn is an instance**, which is why `blocking.test.ts`'s
 * release fixture is built around a route with a genuine 90-degree turn and
 * asserts the two lanes it touches actually differ. On a straight corridor the
 * two rules are indistinguishable.
 *
 * **Unconditional release is the natural extension of `advanceCar`'s single
 * in-place write and it is also wrong.** On the four-car ring M1d Task 4 tests,
 * with all four valves firing on one tick, it leaves three of four cells
 * reading FREE with a car standing on each — blocking silently stops working
 * for the rest of the run. Guarded release self-heals instead: processed
 * ascending, car 0 clears its own slot on c0 and overwrites c1's; car 1's
 * guarded clear on c1 now correctly FAILS (car 0 is there) and it overwrites
 * c2's; and so on, ending with every cell named by exactly the car standing on
 * it and zero holes.
 *
 * ---------------------------------------------------------------------------
 * SOUND AT ALL TIMES, COMPLETE ONLY CONDITIONALLY
 * ---------------------------------------------------------------------------
 *
 * Together, guarded release and overwriting claim make the array **sound**:
 * every slot that names a car names a car that is standing on that cell. They
 * do not make it **complete**: a cell can carry more cars than its slots name,
 * because a car that has not yet crossed on its current leg holds nothing
 * (Decision 3) and because of the valve's transient (Decision 6). So
 * `assertOccupancyConsistent` has two halves of different strength, separately
 * named, and the weaker half's exception set is spelled out at its own site
 * rather than left to be inferred.
 *
 * ---------------------------------------------------------------------------
 * THE REFUSAL, AND WHY THE ANSWER IS A CODE RATHER THAN A BOOLEAN — TASK 3
 * ---------------------------------------------------------------------------
 *
 * `canEnter` is the single question movement asks of occupancy, and it returns
 * an `EnterOutcome` code, never a boolean. That is the house pattern M2's
 * `PointerOutcome` established and it is the direct mechanical answer to this
 * project's most-repeated defect family — *"a negative assertion satisfied by
 * the wrong mechanism"*. "The car did not move" is satisfied in `advanceCar` by
 * four different things (a non-driving phase, an exhausted route, progress
 * below the threshold, and a refusal), and only the reason-in-the-return-value
 * separates the fourth from the other three for every test at once.
 *
 * The whole four-code enum is declared here even though Task 3 can only ever
 * return two of them, so that no later task WIDENS a return type a caller is
 * already switching on: `ENTER_VALVE` is wired in Task 4 and `REFUSED_GHOST` in
 * Task 5.
 *
 * **Blocking is checked at cell ENTRY, never mid-cell, and a refused car does
 * not accumulate** (Decision 5). `advanceCar` computes `progress = carProgress
 * + speed`; if that reaches the edge's threshold it asks `canEnter`, and on a
 * refusal it writes NOTHING AT ALL — not the progress, not the cell, not the
 * cursor, not occupancy. The car retries the same comparison next tick and
 * crosses on the first tick it is granted. See `cars.ts` for why "write
 * `carProgress = threshold` instead" is wrong twice over.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DO — YET
 * ---------------------------------------------------------------------------
 *
 * **Task 2 added no refusals.** It declared the whole blocking buffer shape and
 * wired claim/release so that occupancy is always correct, and nothing read it
 * to stop a car. That is what made Task 2's golden re-bless provably
 * layout-only: no car's motion could have changed, so the only difference in
 * the four whole-buffer digests was buffer SHAPE. **Task 3 adds `canEnter` and
 * refusal**; **Task 4 the valve and `carBlockedTicks`'s semantics**; **Task 5
 * the two ghost regions and `REFUSED_GHOST`**, which completes the enum — every
 * one of the four codes is now returned by the code below.
 *
 * ---------------------------------------------------------------------------
 * THE ANTI-DEADLOCK VALVE — TASK 4, DECISION 6
 * ---------------------------------------------------------------------------
 *
 * **`carBlockedTicks` is this module's second region and Task 4 is its first
 * writer.** Its whole semantics are three rules and they live in two one-line
 * functions below, so that nothing outside this module ever touches the region:
 *
 *   1. `noteEntryRefused` — **increment on a refused entry**, and SATURATE at
 *      `MAX_BLOCKED_TICKS`. The ceiling and the firing threshold are the same
 *      constant on purpose; see that function.
 *   2. `noteEntryGranted` — **reset to 0 on any successful entry, INCLUDING the
 *      valve's own**. Without the reset a car that valved once would valve at
 *      every subsequent crossing for the rest of its trip, driving straight
 *      through every car in front of it — blocking would silently stop working
 *      for that car, which is this milestone's named worst outcome.
 *   3. `canEnter` — **`ENTER_VALVE` when a `REFUSED_OCCUPIED` meets a saturated
 *      counter**, and only then. The valve releases a `REFUSED_OCCUPIED` and
 *      NOTHING ELSE: Task 5's `REFUSED_GHOST` must never be released, because a
 *      car must not drive onto a road that no longer exists merely because it
 *      waited. That is why the valve test lives INSIDE the occupied branch
 *      rather than in front of the whole function.
 *
 * **The counter is read here and written by `advanceCar`, and that split is
 * deliberate.** `canEnter` stays a pure query — it is called by tests and
 * probes as an oracle, and an oracle that advanced a counter every time
 * somebody asked it a question would make the probe change the answer.
 *
 * **A derived invariant worth knowing, because the goldens depend on it:** a
 * car that is not OUTBOUND or RETURNING always has `carBlockedTicks === 0`. The
 * counter can only be raised at a crossing attempt, and a car can only stop
 * being in flight by way of a crossing (arrival and trip end are both
 * cursor-driven), which resets it first. So no idle car ever carries a non-zero
 * counter into the digest, and a fixture that never refuses an entry has an
 * all-zero region — which is why this task moves no golden.
 *
 * **Nothing here allocates.** No object literal, no array, no closure, no
 * `.map`/`.filter`/`.slice`; every value is a bare number and the only buffer
 * written is the caller-owned state buffer. Zero, not "small" — the assertion
 * functions are the exception and they are test/diagnostic entry points, never
 * called from `step`.
 */

/**
 * The value an unoccupied lane slot holds. Not 0: 0 is a valid car index, and a
 * zero-filled occupancy region would read as "car 0 occupies every lane of
 * every cell".
 */
export const FREE = -1

/**
 * The largest car index an `Int16` occupancy slot can name. `parseMap` does not
 * bound `maxCars`, so `createState` asserts it rather than trusting the map —
 * see `assertMaxCarsFitsOccupancy`.
 */
export const OCCUPANCY_MAX_CAR_INDEX = 32767

/**
 * `slot = cell * LANE_COUNT + lane`. The single owner of the occupancy index
 * arithmetic; see the module comment for why it is not inlined at call sites.
 */
export function occupancySlot(cell: number, lane: number): number {
  return cell * LANE_COUNT + lane
}

/**
 * Throws if a map's `maxCars` would produce a car index an `Int16` occupancy
 * slot cannot name.
 *
 * `parseMap` enforces no bound on `maxCars` (`CARS_PER_HOUSE * maxHouses`), and
 * the failure without this check is silent rather than loud: `Int16Array`
 * COERCES, so car 32,768 would be stored as -32,768 and car 32,769 as -32,767,
 * and no slot lookup could ever match them again. That is the same coercion
 * class as the `Int32Array` pointer-id latch in the testing catalogue — an
 * out-of-contract input must not be able to brick the thing, however
 * unreachable it looks. `firstCity`'s `maxCars` is 80.
 *
 * Unreachable through every map that ships; exercised directly in
 * `blocking.test.ts`, on the precedent of `assertSingleCrossing` (cars.ts) and
 * `assertDispatchProgress` (dispatch.ts).
 *
 * The bound is on the largest INDEX, not on the count: with
 * `OCCUPANCY_MAX_CAR_INDEX = 32767` the admissible counts are `0..32768`.
 *
 * @internal `createState` is the production call site.
 */
export function assertMaxCarsFitsOccupancy(maxCars: number): void {
  if (!Number.isInteger(maxCars) || maxCars < 0 || maxCars - 1 > OCCUPANCY_MAX_CAR_INDEX) {
    throw new Error(
      `blocking: maxCars ${maxCars} would produce a car index above ${OCCUPANCY_MAX_CAR_INDEX}, which an ` +
        'Int16 occupancy slot cannot name — Int16Array coerces rather than throwing, so the slot would ' +
        'silently hold a negative number no lookup could ever match',
    )
  }
}

/**
 * Event 2: car `i` has just crossed INTO `cell` travelling in direction `dir`.
 *
 * The write is unconditional — a slot always names the MOST RECENT car to have
 * entered it. That is what makes the array self-heal after the valve fires
 * (Decision 6): the displaced car's later guarded release correctly does
 * nothing, and the entrant's claim is already correct.
 *
 * `dir` is the direction of THIS crossing, which is the value `advanceCar`
 * already holds; the lane is `LANE_OF_DIR[dir]` and nothing else.
 */
export function claimCell(state: GameState, i: number, cell: number, dir: number): void {
  state.occupancy[occupancySlot(cell, LANE_OF_DIR[dir] as number)] = i
}

/**
 * Events 3 and 4: car `i` no longer stands on `cell`.
 *
 * **Guarded by identity, and clears BOTH lanes.** It takes no direction, on
 * purpose — see the module comment: releasing the lane derived from the
 * OUTGOING direction corrupts the array at every turn, and unconditional
 * release corrupts it whenever the valve has displaced somebody. Two
 * comparisons is the whole cost.
 */
export function releaseCell(state: GameState, i: number, cell: number): void {
  const base = occupancySlot(cell, 0)
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    if (state.occupancy[base + lane] === i) state.occupancy[base + lane] = FREE
  }
}

/** The car standing in `(cell, lane)`, or `FREE`. */
export function occupantOf(state: GameState, cell: number, lane: number): number {
  return state.occupancy[occupancySlot(cell, lane)] as number
}

/**
 * Task 4: car `i` was refused an entry on this tick. One more consecutive
 * blocked tick, **saturating** at `MAX_BLOCKED_TICKS`.
 *
 * **The saturation ceiling and the valve's firing threshold are the SAME
 * constant, and that identity is the whole design.** A ceiling BELOW the
 * threshold makes the threshold unreachable and the valve never fires at all —
 * which is exactly what "make the counter a `Uint8`" would do (255 < 1,350),
 * expressed behaviourally rather than as a layout change. A ceiling ABOVE the
 * threshold is bytes nothing reads, since a saturated counter is released on
 * the very next tick.
 *
 * **Not production-reachable in Task 4, and that is stated rather than left to
 * be discovered.** A counter at `MAX_BLOCKED_TICKS` is answered `ENTER_VALVE`
 * on the next tick and reset by the crossing, so today the counter never gets
 * the chance to exceed the ceiling and `v + 1` unclamped would behave
 * identically through `runMovement`. The clamp is here for the case that ends
 * that: **Task 5's `REFUSED_GHOST`, which the valve is forbidden to release.** A
 * car refused by a ghost is refused while saturated, every tick, indefinitely —
 * an unclamped `Int16` counter overflows after 32,767 of them (about 18 minutes
 * of play), wraps to -32,768, and the valve is then permanently disarmed for
 * that car with no error anywhere. Saturating means no width question can ever
 * arise, at any run length, for any refusal code. Exercised by direct call in
 * `blocking.test.ts`, on the precedent of `assertSingleCrossing` (cars.ts).
 *
 * @internal `advanceCar` is the production call site.
 */
export function noteEntryRefused(state: GameState, i: number): void {
  const v = state.carBlockedTicks[i] as number
  if (v < MAX_BLOCKED_TICKS) state.carBlockedTicks[i] = v + 1
}

/**
 * Task 4: car `i` entered a cell on this tick. The consecutive-blocked-tick run
 * is over, so the counter goes back to 0.
 *
 * **Called on the valve's own crossing too**, which is the rule that keeps the
 * valve a 45-second wait rather than a permanent licence. A car that valved and
 * kept its saturated counter would be granted every subsequent entry for the
 * rest of its trip.
 *
 * Unconditional rather than `if (v !== 0)`: writing 0 over 0 moves no byte, and
 * the branch would only buy a comparison in the common case while adding a
 * second way for the reset to be wrong.
 *
 * @internal `advanceCar` is the production call site.
 */
export function noteEntryGranted(state: GameState, i: number): void {
  state.carBlockedTicks[i] = 0
}

/**
 * What `canEnter` decided, and why. Every code is **non-zero**, in
 * `PointerOutcome`'s idiom, so a caller writing `if (outcome)` cannot
 * accidentally treat one outcome as false.
 *
 * **All four were declared in Task 3; three are reachable as of Task 4 and the
 * fourth is Task 5's.** Declaring them all at once was deliberate: the
 * alternative is a later task widening a return type that `advanceCar` is
 * already switching on, and a switch that was exhaustive when it was written
 * silently stops being exhaustive.
 *
 *   - `ENTER_VALVE` — **wired in Task 4.** Returned when a `REFUSED_OCCUPIED`
 *     meets a `carBlockedTicks[i]` saturated at `MAX_BLOCKED_TICKS`. It is a
 *     GRANT, not a refusal: `advanceCar` crosses on it, and it is grouped with
 *     `ENTER_FREE` at that call site rather than being treated as a special
 *     case of the refusal.
 *   - `REFUSED_GHOST` — **wired in Task 5**, and still unreachable THROUGH
 *     `runDispatch` + `runMovement`, which is a property to record rather than a
 *     bug to fix. Returned when the cell is a ghost (its last road bit was
 *     erased with cars still committed to it) and this car is not one of the
 *     committed ones. The two halves of that conjunction cannot both hold on the
 *     reachable manifold: `eraseRoad` clears the live bits, so `dist[cell]` is
 *     INF and no route committed AFTER the erase can contain the cell, and every
 *     car committed BEFORE it is by definition committed. So it is a fail-closed
 *     guard, reachable only from a hand-built state, and it is exercised
 *     directly in `blocking.test.ts` and labelled there. Do not delete it on the
 *     strength of its own survival — the same idiom as `assertSingleCrossing`
 *     (cars.ts) and `assertDispatchProgress` (dispatch.ts). **The valve must not
 *     release it**, which is why the valve test lives inside `canEnter`'s
 *     occupied branch rather than in front of the function, and why the ghost
 *     test is an early return in front of BOTH.
 *
 * **There is deliberately no `NO_ROAD` code and no `OUT_OF_BOUNDS` code**, and
 * the omissions are load-bearing rather than an oversight — see `canEnter`.
 */
export const EnterOutcome = Object.freeze({
  /** The slot is free. The crossing happens. */
  ENTER_FREE: 1,
  /** The slot is taken and the blocked counter reached `MAX_BLOCKED_TICKS` (Task 4). */
  ENTER_VALVE: 2,
  /** The slot is taken. The car holds its progress and retries next tick. */
  REFUSED_OCCUPIED: 3,
  /** The cell is a ghost and this car is not committed to it (Task 5). */
  REFUSED_GHOST: 4,
} as const)

/** An `EnterOutcome` value, derived from the const rather than hand-written. */
export type EnterOutcomeCode = (typeof EnterOutcome)[keyof typeof EnterOutcome]

/**
 * **Is this outcome a GRANT?** — the one place the grant set is written down.
 *
 * `ENTER_FREE` and `ENTER_VALVE` are grants; `REFUSED_OCCUPIED` and
 * `REFUSED_GHOST` are not. `advanceCar` (cars.ts) crosses iff this says so, and
 * it delegates rather than testing the codes itself for a reason that is worth
 * stating, because the obvious reading is that this function is a wrapper around
 * one comparison.
 *
 * **The reason is that `advanceCar`'s own branch is not testable and this
 * is.** Tasks 3 and 4 both recorded the fail-open spelling — `if (outcome ===
 * REFUSED_OCCUPIED) return` — as a measured 0-detector mutant, and both named
 * Task 5 as the task whose `REFUSED_GHOST` would kill it. **It does not, and the
 * reason is a proof rather than a missing fixture.** `advanceCar` asks
 * `canEnter` about exactly one cell: `next = stepCell(carCell, dir)`, where
 * `dir` is the current step of its own committed route. `isCommittedTo`
 * (dispatch.ts) walks that same route from that same cell with that same step,
 * so `next` is the FIRST cell it visits and the answer is `true` — for every
 * car, on every tick, ghost or no ghost, corrupt route or not. Verified by
 * enumeration as well as by reading: 131,930 in-flight shapes (both phases,
 * every cursor, seven start cells, 2,000 random routes) gave **zero**
 * non-committed next cells. So `advanceCar` can never observe a
 * `REFUSED_GHOST`, and no fixture built on `runMovement` can tell the two
 * spellings apart.
 *
 * Moving the decision here does not make the branch reachable — nothing can —
 * but it moves the RULE to a pure function of one enum value, where
 * `blocking.test.ts` tests it against all four codes by name and the fail-open
 * spelling dies immediately. That is the difference between a rule nobody can
 * check and a rule with one owner and one test. **Do not re-inline it at the
 * call site**: the inlined form is provably unfalsifiable, which is the state
 * this function exists to leave behind.
 *
 * Total over `EnterOutcome` by construction — it names the two grants and
 * refuses everything else, so a fifth code added later is a refusal until
 * somebody decides otherwise. Fail-closed, which for this predicate means "a
 * car that the code does not recognise does not move".
 */
export function isEntryGranted(outcome: EnterOutcomeCode): boolean {
  return outcome === EnterOutcome.ENTER_FREE || outcome === EnterOutcome.ENTER_VALVE
}


/**
 * Throws if `canEnter` is asked about a cell that is not on the board.
 *
 * **The failure without this is silent and wrong, not loud.** `occupancySlot`
 * on an off-board cell indexes past the end of the `occupancy` view, a typed
 * array returns `undefined` there, `undefined === FREE` is false — so an
 * out-of-range question would be answered `REFUSED_OCCUPIED` by a slot that
 * does not exist. A car would sit blocked forever against nothing, which is the
 * hardest possible thing to trace back to here. Same class as the `Int16Array`
 * coercion `assertMaxCarsFitsOccupancy` guards, and the same treatment.
 *
 * Unreachable through `advanceCar`: `stepCell` returns -1 for every off-board
 * step and `advanceCar` throws on that by name BEFORE it asks this question, so
 * this guard exists for a hand-built or corrupted call. Exercised directly in
 * `blocking.test.ts`, on the precedent of `assertSingleCrossing` (cars.ts) and
 * `assertDispatchProgress` (dispatch.ts).
 *
 * `i` is in the message rather than in the condition: this is the only place
 * that can say WHICH car asked, and a bare "cell 4821 is off the board" from
 * inside a tick names nothing a reader can act on.
 *
 * @internal `canEnter` is the production call site.
 */
export function assertEnterCellOnBoard(i: number, cell: number, cells: number): void {
  if (cell < 0 || cell >= cells) {
    throw new Error(
      `blocking: car ${i} was asked whether it can enter cell ${cell}, which is not on this board ` +
        `(0..${cells - 1}) — an off-board slot read returns undefined and would answer "occupied" ` +
        'from a slot that does not exist',
    )
  }
}

/**
 * Throws if `canEnter` is asked about a direction that is not one of the eight.
 *
 * **The sibling of `assertEnterCellOnBoard`, and it exists because the guard
 * next to it did not cover its own stated failure mode.** That comment says an
 * out-of-range question must not be "answered `REFUSED_OCCUPIED` by a slot that
 * does not exist" — and until this function was added, `canEnter(state, world,
 * 0, aFreeCell, 8)` did exactly that through the OTHER parameter:
 * `LANE_OF_DIR[8]` is `undefined`, `cell * 2 + undefined` is `NaN`,
 * `occupancy[NaN]` is `undefined`, `undefined === FREE` is false, and the answer
 * is a refusal indistinguishable from a real one. The cell was guarded and the
 * direction was not; the reasoning that justified the first applies verbatim to
 * the second, which is the catalogue's "a lesson applied where it was learned
 * and not carried to its sibling case".
 *
 * Unreachable through `advanceCar` today — `edgeCost(dir)` throws on a bad
 * nibble several lines earlier — which is exactly the unreachability the cell
 * guard already accepts as a reason to guard anyway. It stops being an argument
 * at all as more callers arrive: Tasks 4, 5 and 7 each add code that reads these
 * parameters.
 *
 * @internal `canEnter` is the production call site.
 */
export function assertEnterDirValid(i: number, cell: number, dir: number): void {
  if (!Number.isInteger(dir) || dir < 0 || dir >= DIR_COUNT) {
    throw new Error(
      `blocking: car ${i} was asked whether it can enter cell ${cell} in direction ${dir}, which is ` +
        `not one of the eight (0..${DIR_COUNT - 1}) — LANE_OF_DIR would be undefined, the slot index ` +
        'NaN, and the answer a refusal from a slot that does not exist',
    )
  }
}

/**
 * Throws if `canEnter` is asked on behalf of a car index that is not a car.
 *
 * **The third guard in this signature, and the reason it exists now is the
 * reason the second one existed then.** `assertEnterDirValid` was added after a
 * review found `cell` guarded and `dir` not — an out-of-range direction read a
 * `NaN` slot and returned a plausible `REFUSED_OCCUPIED`. `i` was the remaining
 * unguarded parameter of the same signature, and it had already stopped being
 * decorative at Task 4: `carBlockedTicks[i]` for an out-of-range `i` is
 * `undefined`, `undefined >= MAX_BLOCKED_TICKS` is false, and the valve silently
 * never fires for that car. **Task 5 makes it worse in exactly the way the
 * catalogue predicts**: the ghost branch below reads `carPhase[i]`,
 * `carCell[i]`, `carRouteCursor[i]`, `carRouteLen[i]` and car `i`'s `carRoute`
 * nibbles, and an out-of-range `i` reads `undefined` from each — `carRoute`'s
 * `undefined >> 0 & 0xf` is **0**, a perfectly plausible direction N — so the
 * commitment walk would follow a fabricated route and answer `REFUSED_GHOST` or
 * `ENTER_FREE` from a car that does not exist.
 *
 * So: guard every argument in the signature, or write down why they differ.
 * There is nothing left to differ here.
 *
 * Unreachable through `advanceCar`, which is driven by `runMovement`'s
 * `i < state.carPhase.length` loop. Exercised directly in `blocking.test.ts`.
 *
 * @internal `canEnter` is the production call site.
 */
export function assertEnterCarValid(i: number, carCount: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= carCount) {
    throw new Error(
      `blocking: car ${i} is not a car index on this board (0..${carCount - 1}) — every car-indexed ` +
        'read would return undefined, and the answer would be a refusal (or a grant) derived from a ' +
        'car that does not exist',
    )
  }
}

/**
 * **The single blocking question**, spec §5.5: does an inbound vehicle collide
 * with a traversing vehicle on this chunk? Answered as per-(cell, lane)
 * occupancy — car `i` may enter `cell` travelling in direction `dir` iff the
 * lane that direction uses is free, **and, at a junction, iff the other lane is
 * free too**.
 *
 * The lane is `LANE_OF_DIR[dir]` and nothing else. Two properties of that table
 * do all the work and neither is re-derived here:
 *
 *   - **It is the lane of the cell being ENTERED, keyed by the direction of
 *     THIS crossing.** Not the cell being left (which the car is releasing) and
 *     not the opposite lane (which is the lane oncoming traffic uses, and is
 *     exactly the slot that must stay free for a head-on to resolve).
 *   - **`LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]` for every `d`** (Decision
 *     1). Two cars travelling in exactly opposite directions can never contend
 *     for the same slot, so a head-on swap resolves in one tick in either index
 *     order, with no give-way rule and no valve — **at every cell that is not a
 *     junction. M1f Task 2 is what added that qualifier.**
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IMPLEMENTED AT A JUNCTION, IN WHOSE FAVOUR IT RESOLVES, AND WHAT IT
 * COSTS — M1f TASK 2
 * ---------------------------------------------------------------------------
 *
 * **This paragraph replaces *"give-way is not implemented because it does not
 * need to be"*, which was true and is not.** What is implemented is not
 * give-way and not priority: it is **mutual exclusion**. A cell of
 * `roadDegree >= INTERSECTION_DEGREE` admits ONE car at a time, whichever axis
 * it is on, and the second car waits. There is no rule about who has right of
 * way, because there is no rule that depends on where the two cars came from.
 *
 * **It resolves in favour of the LOWEST CAR INDEX, and that is a decision taken
 * here rather than a consequence of a loop bound.** `runMovement` iterates
 * ascending (`cars.ts`, Decision 2), so on a tick where two cars would both
 * enter one junction cell, the lower index takes it and the higher is answered
 * `REFUSED_OCCUPIED` and counted as blocked. Nothing about the geometry — not
 * the approach, not the turn, not who has waited longer — enters into it.
 * `loop.test.ts`'s *"gives the junction to the LOWER car index, as a rule and
 * not as a loop bound"* pins it on a fixture where the descending order gives
 * the opposite answer, so reversing `runMovement`'s loop fails by name.
 *
 * **THE COST IS THE HEAD-ON PROPERTY, AT JUNCTIONS ONLY.** Two cars swapping
 * across an edge whose endpoints are both junctions each require the other's
 * cell to be empty and each is standing in it. That is a 2-cycle, the case
 * `MAX_BLOCKED_TICKS`'s comment used to say could not exist, and only the valve
 * clears it — 45 seconds. Measured on the shipped board's greedy arm, the valve
 * goes from 0 firings to 15 and the worst wait from 32 ticks to the saturated
 * 1,350. **The only thing that lifts it is a junction upgrade** (M1f Task 9,
 * §5.6): `junctionAdmitsOne` returns false at an upgraded cell, this clause
 * reduces to the pre-M1f own-lane rule there, and the head-on property comes
 * back whole, at that cell, with no phase and no timer. A traffic light would do
 * the same job by refusing cars instead of admitting them; M1f measured one and
 * rejected it, and it is deferred to M1g.
 *
 * **Queueing is not implemented — it emerges.** There is no queue structure, no
 * follower list and no "who is behind me" anywhere in this milestone. A car
 * refused at the back of three others is refused for exactly the same reason
 * the first one was, and the order they leave in is the order `runMovement`
 * happens to reach them: ascending car index (Decision 2), which is
 * outcome-visible for the first time in this task.
 *
 * ---------------------------------------------------------------------------
 * TWO CODES THAT DELIBERATELY DO NOT EXIST
 * ---------------------------------------------------------------------------
 *
 * **`NO_ROAD`.** Movement must not consult `roads` for permission. A car
 * committed to a route drives it whatever happens to the world underneath —
 * that is M1c's decision 2, it is what makes replay tractable, and from Task 5
 * it is also the whole ghost-road feature (a committed car HAS to be able to
 * drive a road that has been erased, or §5.11's delayed refund can never be
 * paid). A `NO_ROAD` refusal would make an erase under an in-flight car freeze
 * it instead.
 *
 * **`OUT_OF_BOUNDS`.** `stepCell` already returns -1 for a step off the grid
 * and `advanceCar` already throws on it by name. Turning that into a refusal
 * would convert a corrupted route — a loud, named, unresumable failure — into a
 * car that quietly stops moving, which is the one outcome that looks like
 * ordinary traffic. `assertEnterCellOnBoard` and `assertEnterDirValid` above
 * keep the loud form for both of the ways this function can be handed nonsense:
 * an off-board cell and a direction outside the eight. **Both**, and the second
 * exists only because the first was written alone — see its comment.
 *
 * ---------------------------------------------------------------------------
 * THE VALVE, AND WHY IT IS INSIDE THE OCCUPIED BRANCH — TASK 4
 * ---------------------------------------------------------------------------
 *
 * A car whose `carBlockedTicks` has reached `MAX_BLOCKED_TICKS` (45 s, spec
 * §5.5) is granted `ENTER_VALVE` instead of `REFUSED_OCCUPIED`, and moves
 * regardless of the occupant. Three things about where that test sits:
 *
 *   - **Inside the `occupant !== FREE` branch, not in front of the function.**
 *     The valve releases a `REFUSED_OCCUPIED` and nothing else. Task 5 adds
 *     `REFUSED_GHOST` and the rule that the valve must NOT release it — a car
 *     must never drive onto a road that no longer exists merely because it
 *     waited — and a valve test hoisted to the top of the function would
 *     release both. Adding the ghost check as a separate early return in front
 *     of this one is therefore the shape Task 5 needs.
 *   - **A free slot is `ENTER_FREE` even for a saturated car.** The valve is not
 *     a state a car enters, it is an answer to a question about one slot; a
 *     saturated car that finds its way clear crosses ordinarily and its counter
 *     is reset by the same `noteEntryGranted` as any other crossing. This is
 *     visible in the four-car ring: the first valve to fire vacates a cell, and
 *     the car behind that cell is then granted `ENTER_FREE` on the same tick
 *     with an UNSATURATED counter.
 *   - **`>=`, not `===`, and the difference is observable NOW.** It is easy to
 *     write this off as future-proofing on the grounds that the counter
 *     saturates at exactly the threshold, so `advanceCar` can never present a
 *     larger value — that much is true, and it is a statement about
 *     `runMovement`, not about this function. **`canEnter` is a public query
 *     with its own contract**, called directly by tests, by probes and (from
 *     Task 5) by more of the tick than today; it answers whatever counter it is
 *     handed. `blocking.test.ts`'s edge table hands it 1,351 and 32,767 and
 *     requires `ENTER_VALVE` for both, so `===` is killed by this file's own
 *     tests rather than by a hypothetical future. The future-proofing is real
 *     as well — a raised ceiling under `===` gives a valve that silently never
 *     fires — but it is the second reason, not the first.
 *
 * @param i    the car asking. Read by `assertEnterCellOnBoard`'s message, and —
 *             from Task 4 — by the valve, which is per car: `carBlockedTicks[i]`
 *             is the ASKING car's wait, never the occupant's. Task 5 reads the
 *             ghost commitment through it too.
 * @param cell the cell being ENTERED, not the one being left.
 * @param dir  the direction of THIS crossing.
 */
export function canEnter(
  state: GameState,
  world: WorldData,
  i: number,
  cell: number,
  dir: number,
): EnterOutcomeCode {
  assertEnterCellOnBoard(i, cell, world.cells)
  assertEnterDirValid(i, cell, dir)
  assertEnterCarValid(i, state.carPhase.length)
  // The ghost check is a SEPARATE EARLY RETURN IN FRONT of the occupancy read,
  // and Task 4's comment above predicted this shape for exactly one reason: the
  // valve lives inside the occupied branch, so it can never see — and therefore
  // can never release — a `REFUSED_GHOST`. A car that has waited 45 seconds
  // still may not drive onto a road that no longer exists.
  //
  // `ghostMask[cell] !== 0` is the cheap half and it is checked first: a ghost
  // is rare, and the commitment walk behind it is O(remaining route). On a board
  // with no ghost this costs one `Uint8Array` read per crossing.
  if ((state.ghostMask[cell] as number) !== 0 && !isCommittedTo(state, world, i, cell)) {
    return EnterOutcome.REFUSED_GHOST
  }
  const lane = LANE_OF_DIR[dir] as number
  const own = state.occupancy[occupancySlot(cell, lane)] as number
  // ------------------------------------------------------------------------
  // THE JUNCTION'S MUTUAL EXCLUSION — M1f Task 2, spec §5.5
  // ------------------------------------------------------------------------
  //
  // §5.5's blocking primitive is *"does an inbound vehicle collide with a
  // traversing vehicle on this chunk?"*, and until M1f this function only ever
  // asked about the entrant's OWN lane. That resolves the parallel case and the
  // head-on case (`LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]`) and leaves the
  // CROSSING case unresolved — so two cars crossed inside one cell and nothing
  // stopped them. `MAX_BLOCKED_TICKS` is the datamined ceiling on the wait at an
  // intersection; this is the wait.
  //
  // **A junction cell admits one car at a time.** On a cell of degree >=
  // `INTERSECTION_DEGREE` the OTHER lane must be free too. One extra
  // `Int16Array` read on the crossings that reach a junction, no new state, no
  // allocation.
  //
  // **The crossing pair is (E, N) and NOT (E, S).** `LANE_OF_DIR` is
  // `[1, 0, 0, 0, 0, 1, 1, 1]`, so E and S are the SAME lane and the own-lane
  // read already refused that pair before this task existed. Written down here
  // because the plan's fixture had it the other way round, which would have made
  // the headline test green before the rule shipped.
  //
  // **THIS BREAKS THE HEAD-ON PROPERTY AT JUNCTIONS, AND THAT IS THE COST.** Two
  // cars swapping across an edge whose endpoints are both junctions each require
  // the other's cell to be empty and each is standing in it — a 2-cycle, which
  // `MAX_BLOCKED_TICKS`'s own comment used to say could not exist. M1f Task 9's
  // JUNCTION UPGRADE is what gives the property back — whole, at one cell, with
  // no phase — which is dossier §1.7's `greenLightsIgnoreCollisions` applied to
  // every axis at once.
  //
  // **`junctionAdmitsOne` and NOT `isJunctionCell`**, because the two diverge at
  // Task 9: an upgraded junction keeps the intersection SLOWDOWN and loses this
  // rule. See `graph.ts`.
  //
  // **It inherits `assertOccupancySound`'s valve exception and introduces no new
  // soundness question**: the other lane's slot is read exactly as the own lane's
  // is, so a stale claim left by a valve displacement is stale in both and is
  // already in that assert's exception set.
  const other = junctionAdmitsOne(state, cell)
    ? (state.occupancy[occupancySlot(cell, otherLane(lane))] as number)
    : FREE
  if (own === FREE && other === FREE) return EnterOutcome.ENTER_FREE
  if ((state.carBlockedTicks[i] as number) >= MAX_BLOCKED_TICKS) return EnterOutcome.ENTER_VALVE
  return EnterOutcome.REFUSED_OCCUPIED
}

/**
 * True iff car `i` has crossed at least once on its CURRENT leg, and therefore
 * holds a claim on the cell it is standing on.
 *
 * Outbound the cursor starts at 0 and increments, so a crossing has happened
 * iff `cursor > 0`. Returning the cursor starts at `routeLen` and decrements,
 * so a crossing has happened iff `cursor < routeLen`. Exported because
 * `assertOccupancyConsistent`'s completeness half is defined in terms of it and
 * `blocking.test.ts` asserts the fixtures it runs on are non-vacuous by it.
 *
 * Note the asymmetry this predicate deliberately does NOT capture: a car that
 * has just flipped to RETURNING on the carpark cell has crossed zero times on
 * its current leg and yet still holds a claim, carried over from the outbound
 * leg's last crossing. Completeness is a one-way implication ("crossed =>
 * named"), so a car named without having crossed is permitted; soundness
 * covers that car instead, and does so correctly, because it IS standing on the
 * cell its slot names.
 */
export function hasCrossedThisLeg(state: GameState, i: number): boolean {
  const phase = state.carPhase[i] as number
  const cursor = state.carRouteCursor[i] as number
  if (phase === PHASE_OUTBOUND) return cursor > 0
  if (phase === PHASE_RETURNING) return cursor < (state.carRouteLen[i] as number)
  return false
}

/**
 * SOUNDNESS: every slot that names a car names a car that is OUTBOUND or
 * RETURNING and standing on that cell.
 *
 * **Asserted unconditionally** — it holds at every tick of every run, including
 * across a valve firing, and there is no exception set. It is the half that
 * catches the two release mutations directly and by a second, independent
 * route: a slot naming a car that has gone `PHASE_IDLE` is a soundness
 * violation BY DEFINITION, so "skip the release in `completeTrip`" is caught
 * here as well as by the direct slot assertion.
 *
 * Split out from the completeness half rather than folded into one function, in
 * the house style of `assertSymmetric` (roads.ts) and `assertArrivalHonoured`
 * (trips.ts), so a caller that can only legitimately assert the weaker half
 * still asserts the stronger one, and so a failure names WHICH half broke.
 */
export function assertOccupancySound(state: GameState, world: WorldData): void {
  const cells = world.cells
  for (let cell = 0; cell < cells; cell++) {
    const base = occupancySlot(cell, 0)
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const i = state.occupancy[base + lane] as number
      if (i === FREE) continue
      if (i < 0 || i >= state.carPhase.length) {
        throw new Error(
          `assertOccupancySound: cell ${cell} lane ${lane} names car ${i}, which is not a car index ` +
            `(0..${state.carPhase.length - 1}) and is not FREE (${FREE})`,
        )
      }
      const phase = state.carPhase[i] as number
      if (phase !== PHASE_OUTBOUND && phase !== PHASE_RETURNING) {
        throw new Error(
          `assertOccupancySound: cell ${cell} lane ${lane} names car ${i}, whose phase is ${phase} — ` +
            'only an OUTBOUND or RETURNING car may hold a slot, so a claim outlived its car',
        )
      }
      if ((state.carCell[i] as number) !== cell) {
        throw new Error(
          `assertOccupancySound: cell ${cell} lane ${lane} names car ${i}, which is standing on cell ` +
            `${state.carCell[i]} — the slot names a car that is not there`,
        )
      }
    }
  }
}

/**
 * COMPLETENESS: every car that has crossed at least once on its current leg is
 * named by one of its cell's two slots.
 *
 * **Weaker than soundness, and its exception set is spelled out here rather
 * than inferred.** The property does NOT hold for:
 *
 *   - a car that has not crossed on its current leg (Decision 3's tick-0
 *     ruling: an idle car holds nothing, and a just-dispatched car holds
 *     nothing until its first crossing) — excluded by `hasCrossedThisLeg`, and
 *     that exclusion is the rule, not an exception;
 *   - **a car displaced by the anti-deadlock valve — live as of Task 4, and the
 *     only source of displacement there is.** When the valve fires for car *i*
 *     into a slot held by car *j* and *j* does not move that tick, both are on
 *     the cell and the slot names *i* (claim overwrites); if *i* then leaves
 *     first, its guarded clear frees a slot *j* is still standing on. So this
 *     half is asserted only on fixtures where the valve has not fired, and
 *     `blocking.test.ts`'s valve section asserts BOTH shapes of the residual
 *     directly rather than merely skipping the check.
 *
 *     Two things Decision 6's wording compresses, separated here because a
 *     reader checking the claim needs both. **The SLOT recovers**: the next car
 *     to enter overwrites it, and from that moment the cell blocks again. **The
 *     DISPLACED CAR does not** — nothing renames *j* until *j* itself crosses,
 *     so completeness stays false for *j* for as long as it stands there, and
 *     in the meantime that cell answers `ENTER_FREE` to a third car with *j*
 *     standing on it. Both are consequences of the same one-car-per-slot array
 *     and neither is a soundness violation: every slot that names a car still
 *     names a car that is there. This is the density cost Decision 1 already
 *     records, surfacing for one cell at a time;
 *   - **a car displaced by an ordinary same-lane crossing, which is reachable
 *     in TASK 2 ONLY and is not in the plan's stated exception set.** Task 2
 *     declares the primitive and adds no refusal, so two cars may cross into
 *     the same `(cell, lane)` and the later writer's unconditional claim
 *     displaces the earlier car's. Both are standing on the cell, so soundness
 *     holds; completeness does not, for the displaced one. From Task 3 onward
 *     `canEnter` refuses the second entry outright and this arm disappears,
 *     leaving the valve as the only source of displacement — which is why the
 *     plan lists only the valve. Task 2's own fixtures are built so it does not
 *     arise and assert that it did not, rather than relying on it not arising.
 *
 * **Vacuity.** Over a board with no car that has crossed, this holds over an
 * empty set and proves nothing. `blocking.test.ts` therefore asserts a non-zero
 * count of qualifying cars wherever it calls this — and the count is returned
 * rather than merely counted internally, so the caller can make that assertion
 * against the same enumeration this function used rather than against a
 * re-implementation of it.
 *
 * @returns the number of cars the assertion actually ranged over.
 */
export function assertOccupancyComplete(state: GameState, world: WorldData): number {
  const carCount = state.carPhase.length
  let checked = 0
  for (let i = 0; i < carCount; i++) {
    if (!hasCrossedThisLeg(state, i)) continue
    checked++
    const cell = state.carCell[i] as number
    if (cell < 0 || cell >= world.cells) {
      throw new Error(`assertOccupancyComplete: car ${i} is on cell ${cell}, which is off the board`)
    }
    const base = occupancySlot(cell, 0)
    let named = false
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      if (state.occupancy[base + lane] === i) named = true
    }
    if (!named) {
      throw new Error(
        `assertOccupancyComplete: car ${i} has crossed on its current leg and stands on cell ${cell}, ` +
          `but neither of that cell's slots names it (they hold ${state.occupancy[base]}, ` +
          `${state.occupancy[base + 1]}) — a claim went missing`,
      )
    }
  }
  return checked
}

/**
 * Both halves, in the house style of `assertSymmetric` / `assertArrivalHonoured`.
 *
 * Called from every blocking fixture and from Task 9's long run. Soundness is
 * unconditional; completeness is opt-in via `checkComplete`, because from Task
 * 4 onward a fixture in which the valve has fired may legitimately carry a
 * transient completeness gap (see `assertOccupancyComplete`). It defaults to
 * ON, so a caller has to say out loud that it is skipping the weaker half.
 *
 * @returns the number of cars the completeness half ranged over, or 0 when it
 *          was skipped — the caller's vacuity handle.
 */
export function assertOccupancyConsistent(
  state: GameState,
  world: WorldData,
  checkComplete = true,
): number {
  assertOccupancySound(state, world)
  return checkComplete ? assertOccupancyComplete(state, world) : 0
}
