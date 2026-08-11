import { CARS_PER_HOUSE, MAX_PATH_LEN } from '@laneways/shared'
import type { GameState } from './state'
import { H_DEST_COUNT, H_HOUSE_COUNT, H_ROUTES_REFUSED } from './state'
import type { WorldData } from './world'
import { INF, type FlowField, type Scratch } from './scratch'
import { fieldFor } from './flowfield'
import { DIR_COUNT, OPPOSITE, roadMask, stepCell } from './roads'
import {
  carparkCell,
  destMetaColour,
  destMetaOrientation,
  PHASE_IDLE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
} from './buildings'

/**
 * Dispatch: source assembly (phase 4 of the tick order), house selection,
 * route commitment and reservation (phase 5) — M1c design decisions 2 and 4.
 *
 * **This module also owns the `carRoute` nibble codec.** `packRouteStep` and
 * `routeStep` are the ONLY two places in the codebase that know how a step
 * index maps to a byte and a nibble; `cars.ts` (Task 5) imports them rather
 * than re-deriving the shift. That is deliberate, and the reason is that a
 * pure nibble-order swap is invisible to every OUTCOME this milestone
 * asserts: displacement vectors commute, so the endpoint is unchanged; the
 * multiset of steps is unchanged, so the total cost and therefore the arrival
 * tick are unchanged; and arrival is cursor-driven rather than
 * position-driven, so a car standing on the wrong cell still "arrives". One
 * owner plus a literal byte assertion in `dispatch.test.ts` is what makes the
 * convention checkable at all.
 *
 * **Not wired into `step()` in this task** — Task 4's file list is
 * `dispatch.ts`/`dispatch.test.ts` only, mirroring `buildings.ts` (Task 2)
 * and `demand.ts` (Task 3), both of which shipped with no production caller.
 * `assembleSources` is phase 4's first half and must run BEFORE `syncFields`
 * (it decides the source set); `runDispatch` is phase 5 and is the whole
 * tick's only field reader.
 *
 * **Nothing here allocates.** No object literal, no array, no closure, no
 * `.map`/`.filter`/`.slice`. Every helper returns a bare number, every buffer
 * it writes is either the state buffer or `scratch`, both caller-owned. That
 * is a Global Constraint this milestone calls literal (zero, not "small"),
 * and it is the reason the dispatch loop's exclusion of already-tried houses
 * is a scalar cursor rather than a `Set` — see `dispatchColour` below.
 */

/**
 * Bytes of `carRoute` per car: one 4-bit direction per step, two per byte.
 * Derived from `MAX_PATH_LEN` by the same formula `regionsFor` (regions.ts)
 * uses to size the region — the two cannot drift because they derive from
 * one shared constant, and `dispatch.test.ts` pins the linkage directly by
 * asserting `carRoute.length === maxCars * ROUTE_BYTES` against a real state.
 */
export const ROUTE_BYTES = MAX_PATH_LEN / 2

/**
 * A step index outside `[0, MAX_PATH_LEN)` addresses the NEXT car's slice —
 * silent corruption of a live route, not an out-of-range no-op — so it is
 * validated rather than masked.
 *
 * **This is bound 3 of the three that guard `dispatchColour`'s route walk, and
 * it is the one that must NOT be relied on.** It throws, and under the plan's
 * atomicity rule a throw out of `step` leaves `H_EPOCH` non-zero and makes the
 * run unresumable — correct as a last-resort tripwire, useless as a routing
 * outcome, where decision 2 specifies a counted refusal. The other two live in
 * `dispatchColour`'s walk (the loop header and the `steps === MAX_PATH_LEN`
 * break); that comment lists all three and says why none of them may go.
 *
 * **Do not delete this on the grounds that the walk already bounds itself, and
 * do not delete both together as one cleanup.** They are independent
 * mechanisms with different outcomes that happen to derive from the same
 * constant — which is exactly what makes "these two look redundant" a tempting
 * and wrong read.
 */
function assertStepIndex(i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_PATH_LEN) {
    throw new Error(`carRoute: step index must be an integer in [0, ${MAX_PATH_LEN}), got ${i}`)
  }
}

/**
 * Writes direction `dir` as step `i` of car `carIndex`.
 *
 * **The convention, stated once and owned here: step `i` occupies bits
 * `(i & 1) * 4 .. +3` of byte `carIndex * ROUTE_BYTES + (i >> 1)`** — even
 * steps in the LOW nibble, odd steps in the HIGH nibble.
 *
 * The step index is validated rather than masked: `i >= MAX_PATH_LEN` would
 * otherwise write into the NEXT car's slice, which is a silent corruption of
 * a live route rather than an out-of-range no-op.
 */
export function packRouteStep(s: GameState, carIndex: number, i: number, dir: number): void {
  assertStepIndex(i)
  if (!Number.isInteger(dir) || dir < 0 || dir >= DIR_COUNT) {
    throw new Error(`carRoute: direction must be an integer in [0, ${DIR_COUNT}), got ${dir}`)
  }
  const byteIndex = carIndex * ROUTE_BYTES + (i >> 1)
  const shift = (i & 1) * 4
  const prev = s.carRoute[byteIndex] as number
  s.carRoute[byteIndex] = (prev & ~(0xf << shift)) | (dir << shift)
}

/** Reads step `i` of car `carIndex`. The inverse of `packRouteStep`, and the only reader of the layout. */
export function routeStep(s: GameState, carIndex: number, i: number): number {
  assertStepIndex(i)
  const byteIndex = carIndex * ROUTE_BYTES + (i >> 1)
  return ((s.carRoute[byteIndex] as number) >> ((i & 1) * 4)) & 0xf
}

/**
 * **Is car `i` committed to `cell`?** — the definition M1d Decision 8 leaves to
 * this task, written down once, here, because `roads.ts` (the erase-time count)
 * and `blocking.ts` (`REFUSED_GHOST`) must not be able to disagree about it.
 *
 * **"Committed" means: `cell` is on the part of this car's committed route it
 * has yet to traverse, INCLUDING the cell it is standing on right now.**
 *
 *   - `PHASE_OUTBOUND` at cursor `j` on route `c_0..c_L`: `{c_j, ..., c_L}`.
 *   - `PHASE_RETURNING` at cursor `j`: `{c_j, ..., c_0}` — the retrace is the
 *     same route read backwards, so the remaining cells are the PREFIX.
 *   - anything else: the empty set. An idle car has no route to be committed to.
 *
 * **Occupancy cannot express this and that is the whole point of the walk.**
 * Occupancy records who is standing on a cell NOW; a committed car may be five
 * cells short of it. `dispatchColour` above commits the whole route at dispatch,
 * unreached cells included, and movement never re-paths — so keying §5.11's
 * delayed refund on occupancy would fire it immediately and the ghost would
 * vanish under an inbound committed car, which is the exact case §5.11 exists
 * for.
 *
 * **Why the cell the car is STANDING on counts, and it is not a rounding
 * choice.** `ghostCommitted` is decremented when a car DEPARTS a ghost cell.
 * A car standing on the cell at erase time will depart it, so if it were not
 * counted the departures would outnumber the count and the refund would land
 * before the last committed car cleared. Count and decrement are two halves of
 * one ledger; this is the half that keeps them balanced.
 *
 * ---------------------------------------------------------------------------
 * THE RESIDUAL, DERIVED RATHER THAN DISCOVERED — READ THIS BEFORE "FIXING" IT
 * ---------------------------------------------------------------------------
 *
 * An OUTBOUND car's committed set is the SUFFIX `{c_j..c_L}`, but its remaining
 * journey also retraces `{c_{j-1}..c_0}` afterwards. So a car can depart a cell
 * it was not counted for (a cell behind it, on the return leg), and can depart a
 * cell it WAS counted for twice (once outbound, once returning). Three
 * consequences, and only the third is a real cost:
 *
 *   1. **No underflow is possible.** `noteGhostDeparture` (roads.ts) decrements
 *      only while `ghostMask[cell] !== 0`, and reaching 0 clears the mask in the
 *      same statement — so every extra departure after the count is exhausted is
 *      a no-op on a cell that is no longer a ghost.
 *   2. **The tile budget is exact.** Exactly one refund is paid per ghosted
 *      cell, by whichever event takes the count to 0, and `placeRoad` pays the
 *      same one tile if a road lands there first. Never twice, never lost.
 *   3. **The refund can land EARLY**, in one shape: a car re-crossing the cell
 *      on its return leg spends a decrement that "belongs" to a car still
 *      inbound, so the ghost can clear while a committed car has yet to reach
 *      it. That car still drives the cell — movement never reads `roads` — and
 *      the budget is still exact; what is lost is the visual, for that one cell.
 *
 * Closing (3) needs the count to be a count of remaining DEPARTURE EVENTS
 * rather than of cars, which makes it up to `2 x maxCars` and moves the refund
 * of a single committed car from its outbound crossing to its return crossing —
 * contradicting this task's own required behaviour ("refunds on the tick that
 * car crosses off the cell, not before and not later") and the plan's stated
 * `maxCars` bound. It is written down here, with the derivation, rather than
 * silently chosen: **M1f** owns the question if ghost lifetime ever becomes
 * something a player can see going wrong. Repointed from M1e, which changed no
 * ghost semantics at all.
 *
 * Walks with `stepCell` and `routeStep`, allocating nothing: two scalar locals
 * and an indexed loop. Called once per in-flight car per erase, and once per
 * crossing into a ghost cell — both rare, and neither inside an inner loop.
 */
export function isCommittedTo(state: GameState, world: WorldData, i: number, cell: number): boolean {
  const phase = state.carPhase[i] as number
  if (phase !== PHASE_OUTBOUND && phase !== PHASE_RETURNING) return false

  let c = state.carCell[i] as number
  if (c === cell) return true

  const cursor = state.carRouteCursor[i] as number
  if (phase === PHASE_OUTBOUND) {
    const len = state.carRouteLen[i] as number
    for (let k = cursor; k < len; k++) {
      c = stepCell(c, routeStep(state, i, k), world.w, world.h)
      // A corrupted route that leaves the board: stop rather than wrap the row
      // seam onto a cell the route never named. `advanceCar` is the site that
      // turns this into a named throw; a membership question must not.
      if (c < 0) return false
      if (c === cell) return true
    }
  } else {
    for (let k = cursor - 1; k >= 0; k--) {
      c = stepCell(c, OPPOSITE[routeStep(state, i, k)] as number, world.w, world.h)
      if (c < 0) return false
      if (c === cell) return true
    }
  }
  return false
}

/**
 * How many in-flight cars are committed to `cell` — the number `eraseRoad`
 * stores in `ghostCommitted` when it defers a refund.
 *
 * Every car slot is visited, including `PHASE_NONE` ones past the live prefix:
 * `isCommittedTo` returns false for every phase that is not OUTBOUND or
 * RETURNING, so the phase byte is the liveness marker here exactly as it is in
 * `runArrivals` and `runMovement`.
 *
 * **This is where "count every in-flight car rather than the committed ones"
 * would live**, and the difference is only observable on a board that HAS an
 * in-flight car that is not committed to the erased cell — which is why the
 * fixture that pins this one carries a second, unrelated car by construction.
 */
export function countCommittedCars(state: GameState, world: WorldData, cell: number): number {
  const carCount = state.carPhase.length
  let n = 0
  for (let i = 0; i < carCount; i++) {
    if (isCommittedTo(state, world, i, cell)) n++
  }
  return n
}

/** Zeroes car `k`'s WHOLE route slice — never just the prefix a walk happened to reach. */
function zeroRoute(s: GameState, k: number): void {
  const base = k * ROUTE_BYTES
  s.carRoute.fill(0, base, base + ROUTE_BYTES)
}

// ---------------------------------------------------------------------------
// 4a. Source assembly
// ---------------------------------------------------------------------------

/**
 * Rewrites `scratch.sourcesFlat`/`scratch.sourceCounts` in full from the live
 * destination prefix. Runs once per tick, immediately before `syncFields`.
 *
 * **The source cell is the destination's CARPARK, never its origin cell.**
 * `flowfield.ts`'s own source-validity note says why verbatim: "In M1c, pins
 * sit on destinations, which are exactly the cells that may have no road yet,
 * so M1c must seed sources from a destination's road-adjacent access cell,
 * not from the building cell itself."
 *
 * **A destination is included iff `destPins[d] > 0` AND its carpark carries a
 * road bit.** The road check is not decoration: `computeFlowField` silently
 * SKIPS a source with no road bit, so including an unconnected destination
 * would churn `hashSources` and force rebuilds that produce an identical
 * field. `destReserved` is deliberately NOT consulted — decision 4 keeps
 * reservations out of the source set entirely, which is what makes the
 * one-pin deadlock impossible and lets the dispatch loop below increment
 * `destReserved` mid-loop with no interaction whatsoever with the staleness
 * stamp.
 *
 * **Insertion is an explicit ascending shift, never `.sort()`.**
 * `computeFlowField` THROWS unless sources are strictly ascending, duplicates
 * included, for a documented reason: source order silently decides `dir` at
 * ties while `dist` stays identical, so two engines would agree on `dist` and
 * differ on `dir`. Destinations enumerate in SLOT order, which is not cell
 * order — a bare slot-order copy is correct on some fixtures and a hard throw
 * on others.
 *
 * **The dedupe is unreachable in M1c and that is stated rather than hidden.**
 * Two destinations can only share a carpark cell as a spec §5.2 "double
 * destination", which M1c does not place, and the Chebyshev >= 2 spacing rule
 * (buildings.ts) forbids it otherwise. It is kept because `computeFlowField`
 * throws on a duplicate and the cost is one comparison against an already
 * sorted slice.
 */
export function assembleSources(state: GameState, world: WorldData, scratch: Scratch): void {
  const { groupCount, maxDestinations } = world.map
  for (let c = 0; c < groupCount; c++) scratch.sourceCounts[c] = 0

  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    if ((state.destPins[d] as number) === 0) continue

    const meta = state.destMeta[d] as number
    const colour = destMetaColour(meta)
    // `packDestMeta` validates colour against the 3-bit field [0, 7], never
    // against a particular map's `groupCount`, so a colour-5 destination on a
    // 5-group map is constructible. Left unchecked it would write past the
    // end of `sourcesFlat`/`sourceCounts` — and an out-of-range typed-array
    // write is a SILENT no-op, so the destination would simply never seed a
    // field and no car would ever serve it, with nothing to point at.
    if (colour >= groupCount) {
      throw new Error(
        `assembleSources: destination ${d} has colour ${colour}, outside this map's groupCount (${groupCount})`,
      )
    }

    const carpark = carparkCell(state.destCell[d] as number, destMetaOrientation(meta), world.w, world.h)
    // Unreachable for a PLACED destination (`canPlaceDestination` rejects a
    // footprint whose carpark falls off-grid), and guarded anyway because -1
    // would read `state.roads[-1]` as `undefined`, pass the `!== 0` road test
    // below, and reach `computeFlowField` as an out-of-range source.
    if (carpark < 0) continue
    if (roadMask(state, carpark) === 0) continue

    const base = colour * maxDestinations
    const count = scratch.sourceCounts[colour] as number

    // Walk back over the (already ascending) slice to the insertion point...
    let i = count
    while (i > 0 && (scratch.sourcesFlat[base + i - 1] as number) > carpark) i--
    // ...where an equal element, if there is one, is exactly at i - 1.
    if (i > 0 && (scratch.sourcesFlat[base + i - 1] as number) === carpark) continue
    for (let j = count; j > i; j--) {
      scratch.sourcesFlat[base + j] = scratch.sourcesFlat[base + j - 1] as number
    }
    scratch.sourcesFlat[base + i] = carpark
    scratch.sourceCounts[colour] = count + 1
  }
}

// ---------------------------------------------------------------------------
// 4b. Dispatch
// ---------------------------------------------------------------------------

/** The lowest `PHASE_IDLE` car of house `h`, or -1. "Free" is `=== PHASE_IDLE`, never `!== PHASE_OUTBOUND`. */
function lowestFreeCar(state: GameState, h: number): number {
  const base = h * CARS_PER_HOUSE
  for (let i = 0; i < CARS_PER_HOUSE; i++) {
    if ((state.carPhase[base + i] as number) === PHASE_IDLE) return base + i
  }
  return -1
}

/**
 * The colour-`colour` house with a free car whose `(dist[houseCell],
 * houseIndex)` key is minimal among those STRICTLY GREATER than
 * `(lastDist, lastHouse)`, or -1 if there is none.
 *
 * The lexicographic key IS the tie rule: ties on `dist` break on the lowest
 * house index, never on iteration order. The `h < bestH` clause is currently
 * subsumed by ascending iteration and is kept anyway, on the same "cheap,
 * independently correct, currently subsumed" reasoning `hashSources`' length
 * fold and `roads.ts`'s terrain whitelist each document — the thing subsuming
 * it is a property of this loop's direction, not of the tie rule.
 */
function selectHouse(
  state: GameState,
  colour: number,
  dist: Int32Array,
  lastDist: number,
  lastHouse: number,
): number {
  const houseCount = state.header[H_HOUSE_COUNT] as number
  let bestH = -1
  let bestD = 0
  for (let h = 0; h < houseCount; h++) {
    if ((state.houseColour[h] as number) !== colour) continue
    if (lowestFreeCar(state, h) < 0) continue
    const d = dist[state.houseCell[h] as number] as number
    if (d < lastDist || (d === lastDist && h <= lastHouse)) continue // not strictly greater than lastKey
    if (bestH === -1 || d < bestD || (d === bestD && h < bestH)) {
      bestD = d
      bestH = h
    }
  }
  return bestH
}

/**
 * Throws once the dispatch loop has run more iterations than its own
 * termination argument permits.
 *
 * **This exists because a broken cursor is a HANG, not a failing test.** Three
 * separable mutations of the loop (writing `lastKey` on commit rather than at
 * selection; loosening `selectHouse`'s `h <= lastHouse` to `h < lastHouse`;
 * deleting both length bounds at once) spin forever, and `--testTimeout`
 * provably cannot interrupt a synchronous loop — a 4-second test timeout does
 * not fire, and the run continues until the CI job's global kill, naming
 * neither the test nor the line. One integer converts all three into a named
 * assertion failure.
 *
 * Takes `iterations`/`bound` as parameters rather than closing over the loop's
 * own locals, on exactly the precedent
 * `assertBucketCountExceedsEveryEdgeCost` (scratch.ts) sets: the failure path
 * is then testable directly, without editing a module constant or breaking the
 * caller. The check itself is the same "cheap, independently correct,
 * currently subsumed" shape as `hashSources`' length fold, `roads.ts`'s
 * terrain whitelist and `selectHouse`'s `h < bestH` clause below.
 *
 * @internal Exported for testing only; `dispatchColour` is the real call site.
 */
export function assertDispatchProgress(iterations: number, bound: number, colour: number): void {
  if (iterations > bound) {
    throw new Error(
      `dispatch: colour ${colour} loop exceeded its proved bound of ${bound} iterations — ` +
        'the (dist, houseIndex) cursor no longer advances monotonically',
    )
  }
}

/**
 * Throws if the dispatch loop selected a house with no free car.
 *
 * Proved unreachable: `selectHouse` requires a free car, and `reselect` is set
 * only when one remained after a commit. A throw rather than a `break` because
 * silently skipping would present a broken invariant as a missing car.
 *
 * Parameterised for the same reason as `assertDispatchProgress` above — the
 * project's precedent is to make an unreachable throw reachable from a test
 * rather than to leave it as the one branch nothing ever executes.
 *
 * @internal Exported for testing only; `dispatchColour` is the real call site.
 */
export function assertFreeCarFound(k: number, h: number, colour: number): void {
  if (k < 0) {
    throw new Error(`dispatch: house ${h} was selected with no free car (colour ${colour})`)
  }
}

/**
 * **`stepCell` used to live here, in duplicate. M1d Task 1a consolidated it
 * into `roads.ts`** — beside `DX`/`DY`/`OPPOSITE`/`dirBetween`/`inBounds`,
 * which is where every other piece of grid geometry already lives, and before
 * M1d's blocking added a third caller to a helper that existed twice.
 *
 * The duplication was not free and this comment is the receipt. `cars.ts`'s
 * copy had one `it()` per bound; **this one had none, and all four of its
 * bounds survived the whole suite** — the copy that got tested was not the copy
 * dispatch used. That gap was closed in M1c by exporting this copy and giving
 * it four direct tests; those tests now live in `roads.test.ts` against the one
 * remaining copy, and the walk's own `if (next < 0) break` refusal keeps its
 * separate witnesses in this file — the bounds and the refusal are two
 * different obligations and neither subsumes the other.
 */

/** The colour-`colour` destination whose carpark is `cell`, or -1. */
function destAtCarpark(state: GameState, world: WorldData, cell: number, colour: number): number {
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    const meta = state.destMeta[d] as number
    if (destMetaColour(meta) !== colour) continue
    if (carparkCell(state.destCell[d] as number, destMetaOrientation(meta), world.w, world.h) === cell) return d
  }
  return -1
}

/**
 * One colour's dispatch loop, per decisions 2 and 4.
 *
 * **There is no exclusion container, and that is deliberate.** The obvious
 * spelling of "not excluded" is a `Set`, and a `Set` allocated once per
 * colour per tick is 5/tick on `firstCity` — against a Global Constraint this
 * milestone calls literal. Every clean home for one is foreclosed:
 * module-scope mutable state is banned by `determinism/no-module-mutable-
 * state`, a sixth `step` parameter is banned by a live arity pin
 * (`step.test.ts`), and `Scratch` has no per-house member. Nothing would
 * catch it either — there is no allocation harness, and the AST rules exempt
 * a `Set` used only through `has`/`add`.
 *
 * It is not needed. Within one colour's loop `dist` is frozen, free cars only
 * decrease and exclusions only grow, so the candidate set shrinks
 * monotonically and the selected key `(dist[houseCell], houseIndex)` NEVER
 * DECREASES. "Not excluded" is therefore exactly "key strictly greater than
 * the last key, unless the last winner still has a free car" — two scalar
 * locals, zero allocations. Two details carry the argument:
 *
 *   - `lastKey` is written at SELECTION, before either refusal branch, which
 *     is what makes a refused house permanently excluded.
 *   - `reselect` is the only thing that re-admits the previous winner, which
 *     is sound because that winner held the minimal key among candidates, so
 *     no house with a smaller key was ever available.
 *
 * **The loop cannot spin by construction:** any iteration that does not
 * commit clears `reselect`, and `lastKey` already names that house, so the
 * house can never be selected again. Each house is therefore selected at most
 * (its free-car count + 1) times, and the loop is bounded by (free cars of
 * this colour) + (houses of this colour). Do not "simplify" that into
 * something that can spin.
 *
 * **A house is excluded only on refusal or on ineligibility, never after a
 * successful commit** — `excluded.add(h)` after a commit is the belt-and-
 * braces idiom that guarantees progress, and it is wrong here: a house with
 * two free cars must be able to serve two pins on one destination in one
 * tick. It decides which car slots receive route bytes, therefore the buffer
 * bytes, therefore `hashState`, therefore browser-vs-Worker byte identity.
 *
 * **The loop bound is the unreserved pin count, and it is a BOUND — it is not
 * what makes spec §5.3.6's "cars never compete" true.** An earlier version of
 * this comment reproduced the plan's claim that capping at `Sigma(destPins -
 * destReserved)` makes that property true by construction. It does not, and
 * the mutation table proves it: deleting `remaining--` entirely leaves every
 * dispatch outcome unchanged. **What actually prevents two cars competing for
 * one pin is the per-destination `destPins[d] - destReserved[d] <= 0` check
 * below, evaluated after every walk, against a `destReserved` incremented
 * inside this loop rather than after it.** `remaining` has two other jobs, one
 * of which is state-visible: it bounds the loop, and it stops the loop reaching
 * a farther house whose walk would bank an `H_ROUTES_REFUSED` increment that
 * never happened — §10.3 telemetry, so a lie about the run rather than wasted
 * work. Both halves of `remaining` (the colour filter and the decrement) have
 * their own fixture for exactly that reason.
 */
function dispatchColour(
  state: GameState,
  world: WorldData,
  fields: readonly FlowField[],
  scratch: Scratch,
  colour: number,
): void {
  const destCount = state.header[H_DEST_COUNT] as number
  let remaining = 0
  for (let d = 0; d < destCount; d++) {
    if (destMetaColour(state.destMeta[d] as number) !== colour) continue
    remaining += (state.destPins[d] as number) - (state.destReserved[d] as number)
  }
  // Nothing to serve: the field is not read at all. `fieldFor` is O(cells)
  // FNV per call, and "once per colour per tick" is an upper bound on reads,
  // not a requirement to read.
  if (remaining <= 0) return

  const field = fieldFor(state, world, fields, colour, scratch)
  const dist = field.dist
  const dirs = field.dir

  let lastDist: number = -1 // the (dist, houseIndex) key of the previous selection
  let lastHouse: number = -1
  let reselect = false // true iff the previous winner may be picked again

  // The termination argument, turned from prose into a runtime check. Each
  // iteration either decrements `remaining` (at most `remaining` times) or
  // clears `reselect`, and a `reselect === false` iteration must draw a key
  // strictly greater than `lastKey` — at most `houseCount` distinct keys — so
  // the loop cannot exceed `remaining + houseCount + 1` iterations including
  // the terminal break. See `assertDispatchProgress` for why this is checked
  // rather than merely argued.
  const maxIterations = remaining + (state.header[H_HOUSE_COUNT] as number) + 1
  let iterations = 0

  while (remaining > 0) {
    assertDispatchProgress(++iterations, maxIterations, colour)
    // All three annotated because `lastHouse` is assigned from `h`, which is
    // initialised from `lastHouse`: TypeScript's control-flow analysis cannot
    // infer through that cycle (TS7022) and falls back to implicit `any`.
    const h: number = reselect ? lastHouse : selectHouse(state, colour, dist, lastDist, lastHouse)
    if (h < 0) break
    const houseCell = state.houseCell[h] as number
    const houseDist = dist[houseCell] as number
    // Every remaining candidate's key is >= this one and keys compare on
    // `dist` first, so an INF winner means every candidate is unreachable.
    if (houseDist === INF) break

    // Written at SELECTION, before either refusal branch below.
    lastDist = houseDist
    lastHouse = h

    const k = lowestFreeCar(state, h)
    assertFreeCarFound(k, h, colour)

    // The walk, recorded DIRECTLY into car k's carRoute slice — there is no
    // legal staging buffer (it would be a per-tick allocation), so both
    // refusal branches below must zero the slice they just wrote into.
    let cell = houseCell
    let steps = 0
    // `walkTerminated` is the POSITIVE fact — "the walk reached a cell with no
    // outgoing `dir`" — deliberately, so that EVERY other way out of this loop
    // is a refusal by default rather than by an exit branch somebody could
    // remove. See the header's bound below for why the default matters.
    let walkTerminated = false

    // ------------------------------------------------------------------
    // THREE INDEPENDENT BOUNDS GUARD THIS WALK. Do not remove any of them,
    // and in particular do not remove them TOGETHER as a "cleanup" on the
    // grounds that each looks redundant next to the others. They are not
    // interchangeable, and only one of them is a graceful outcome:
    //
    //   1. This loop header (`steps <= MAX_PATH_LEN`). STRUCTURAL — the walk
    //      cannot run more than MAX_PATH_LEN + 1 iterations whatever the
    //      `dir` graph looks like, because `steps` rises by one on every
    //      non-breaking path. It is the backstop that makes deleting 2 and 3
    //      together a bounded, refused walk instead of an infinite loop, and
    //      it is why `walkTerminated` defaults to false: exiting through the
    //      header means the walk never reached a terminating cell, so it must
    //      read as a refusal regardless of which cell it stopped on.
    //   2. The `steps === MAX_PATH_LEN` break below. The GRACEFUL bound, and
    //      the only one that produces the outcome decision 2 specifies: a
    //      counted refusal (`H_ROUTES_REFUSED`, car left idle, tick
    //      completes).
    //   3. `assertStepIndex` inside `packRouteStep`. A THROW, which under the
    //      plan's atomicity rule leaves `H_EPOCH` non-zero and makes the run
    //      unresumable — correct as a last-resort tripwire, useless as a
    //      routing outcome.
    //
    // `dir` is a tree toward the sources, so on the reachable manifold it
    // cannot cycle at all; every one of these exists for a hand-corrupted or
    // replayed-from-corrupt `dir`, where an unbounded walk is a hang rather
    // than a wrong answer.
    // ------------------------------------------------------------------
    while (steps <= MAX_PATH_LEN) {
      const kd = dirs[cell] as number
      if (kd < 0 || kd >= DIR_COUNT) {
        // -1 marks a source (and an unreachable cell); anything else is corrupt.
        walkTerminated = true
        break
      }
      // Bound 2. Checked AFTER the terminator above, which is what lets a
      // route of exactly MAX_PATH_LEN steps be accepted rather than refused.
      if (steps === MAX_PATH_LEN) break
      packRouteStep(state, k, steps, kd)
      steps++
      const next = stepCell(cell, kd, world.w, world.h)
      if (next < 0) break // walked off the grid; `walkTerminated` stays false
      cell = next
    }

    const d = walkTerminated ? destAtCarpark(state, world, cell, colour) : -1
    // Three refusals, one path: over the length bound, a zero-length route
    // (the house cell IS a carpark — forbidden by placement, so a corrupted
    // state produces a named refusal rather than a car that completes a trip
    // without moving), and a walk that did not terminate on a colour-matching
    // carpark at all (only reachable off the manifold, e.g. a corrupted
    // `dir`).
    if (!walkTerminated || steps === 0 || d < 0) {
      state.header[H_ROUTES_REFUSED] = (state.header[H_ROUTES_REFUSED] as number) + 1
      zeroRoute(state, k)
      reselect = false
      continue
    }

    // Decision 4's stated cost: a house routed by the field to a destination
    // whose every pin is already spoken for is excluded from this tick's
    // loop, and does not reach past its nearest destination. It resumes when
    // the reserving car arrives.
    //
    // `<= 0`, not `=== 0`. The plan proves `destReserved <= destPins`, so a
    // negative difference is unreachable on the manifold — but `=== 0` reads
    // an already-broken invariant as "eligible" and makes it worse by
    // committing another car, where `<= 0` refuses and leaves the corruption
    // where it is. One character; the same fail-closed reasoning as
    // `roads.ts`'s terrain whitelist.
    if ((state.destPins[d] as number) - (state.destReserved[d] as number) <= 0) {
      zeroRoute(state, k)
      reselect = false
      continue
    }

    state.carRouteLen[k] = steps
    state.carRouteCursor[k] = 0
    state.carTargetDest[k] = d
    state.carProgress[k] = 0
    // Written in place, and it must be: `reselect` otherwise hands the next
    // iteration the same car.
    state.carPhase[k] = PHASE_OUTBOUND
    // Immediately, never after the loop — a deferred reservation lets two
    // cars both dispatch at one pin this tick while leaving the NEXT tick
    // perfectly correct.
    state.destReserved[d] = (state.destReserved[d] as number) + 1
    remaining--
    reselect = lowestFreeCar(state, h) >= 0
  }
}

/**
 * Phase 5 of the tick order: the whole tick's only field reader. Mutates
 * `destReserved` and car state, never the source set — which is exactly what
 * makes "no phase between the sync and a field read may mutate the source
 * set" hold.
 *
 * **Colour iteration order is a checked no-op, and it is disclosed here rather
 * than left silent** — the idiom `runMovement` (cars.ts) and `demand.ts`'s
 * overflow-walk bound already use. `for (c = groupCount - 1; c >= 0; c--)`
 * survives the whole suite, and it is provably a no-op by reading: colours
 * partition destinations, houses and cars; `dispatchColour` reads and writes
 * only its own colour's slots plus `H_ROUTES_REFUSED` (a commutative counter);
 * and every region it writes is FIELD_IRRELEVANT, so no colour's dispatch can
 * perturb another colour's field staleness.
 *
 * **This paragraph used to end "ascending is kept because M1d's blocking gives
 * cars a shared resource, at which point colour order BECOMES outcome-visible".
 * M1d shipped and it did not.** Re-measured at the close of the milestone
 * against the finished code: descending is killed by **0** tests across `sim`
 * and `game` (1,161 passing either way). The prediction was wrong about where
 * the shared resource is read, and the correction is worth more than the
 * repoint would have been: **blocking lives in MOVEMENT, not in dispatch.**
 * `runMovement` iterates by car index and `canEnter` is asked there; dispatch
 * claims no occupancy slot at all (`blocking.ts` lifecycle event 5 — "nothing
 * else claims. Not dispatch"). So colour order still decides only the order in
 * which the same set of cars is committed to the same set of routes, and the
 * cell contention that M1d made outcome-visible is resolved later, in an order
 * this loop does not influence.
 *
 * **What WOULD end it**, stated so the next reader has a real trigger rather
 * than a milestone name — and the trigger is the load-bearing half, not the
 * date: **a dispatch-time read of a shared, non-commutative resource.**
 * Destination removal is one instance and it is now M1f's (M1e appends
 * destinations and frees none); any rule that lets one colour's dispatch refuse
 * another's is another, and it needs no removal to arrive. Ascending is kept anyway, because it is the
 * specified order and free. The finding this paragraph closes was the SILENCE,
 * not the order: without it the next reader has no record that anyone checked.
 */
export function runDispatch(
  state: GameState,
  world: WorldData,
  fields: readonly FlowField[],
  scratch: Scratch,
): void {
  const groupCount = world.map.groupCount
  for (let c = 0; c < groupCount; c++) {
    dispatchColour(state, world, fields, scratch, c)
  }
}
