import { CARS_PER_HOUSE, MAX_PATH_LEN } from '@laneways/shared'
import type { GameState } from './state'
import { H_DEST_COUNT, H_HOUSE_COUNT, H_ROUTES_REFUSED } from './state'
import type { WorldData } from './world'
import { INF, type FlowField, type Scratch } from './scratch'
import { fieldFor } from './flowfield'
import { DIR_COUNT, DX, DY, roadMask } from './roads'
import { carparkCell, destMetaColour, destMetaOrientation, PHASE_IDLE, PHASE_OUTBOUND } from './buildings'

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

/** The cell one step in direction `k` from `cell`, or -1 if that leaves the grid. */
function stepCell(cell: number, k: number, w: number, h: number): number {
  const x = (cell % w) + (DX[k] as number)
  const y = ((cell / w) | 0) + (DY[k] as number)
  if (x < 0 || x >= w || y < 0 || y >= h) return -1
  return y * w + x
}

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
 * **The loop bound is the unreserved pin count.** "Lowest wins" never said
 * how many dispatches happen per tick; capping at `Sigma(destPins -
 * destReserved)` is what makes spec §5.3.6's "cars never compete" true BY
 * CONSTRUCTION rather than by hope.
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

  while (remaining > 0) {
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
    if (k < 0) {
      // Proved unreachable: `selectHouse` requires a free car, and `reselect`
      // is set only when one remained. A throw rather than a `break` because
      // silently skipping would hide a broken invariant as a missing car.
      throw new Error(`dispatch: house ${h} was selected with no free car (colour ${colour})`)
    }

    // The walk, recorded DIRECTLY into car k's carRoute slice — there is no
    // legal staging buffer (it would be a per-tick allocation), so both
    // refusal branches below must zero the slice they just wrote into.
    let cell = houseCell
    let steps = 0
    let walkFailed = false
    for (;;) {
      const kd = dirs[cell] as number
      if (kd < 0 || kd >= DIR_COUNT) break // -1 marks a source (and an unreachable cell); anything else is corrupt
      if (steps >= MAX_PATH_LEN) {
        // Also the cycle guard: `dir` is a tree toward the sources so it
        // cannot cycle, but a hand-corrupted `dir` can, and an unbounded walk
        // is a hang rather than a wrong answer.
        walkFailed = true
        break
      }
      packRouteStep(state, k, steps, kd)
      steps++
      const next = stepCell(cell, kd, world.w, world.h)
      if (next < 0) {
        walkFailed = true
        break
      }
      cell = next
    }

    const d = walkFailed ? -1 : destAtCarpark(state, world, cell, colour)
    // Three refusals, one path: over the length bound, a zero-length route
    // (the house cell IS a carpark — forbidden by placement, so a corrupted
    // state produces a named refusal rather than a car that completes a trip
    // without moving), and a walk that did not terminate on a colour-matching
    // carpark at all (only reachable off the manifold, e.g. a corrupted
    // `dir`).
    if (walkFailed || steps === 0 || d < 0) {
      state.header[H_ROUTES_REFUSED] = (state.header[H_ROUTES_REFUSED] as number) + 1
      zeroRoute(state, k)
      reselect = false
      continue
    }

    // Decision 4's stated cost: a house routed by the field to a destination
    // whose every pin is already spoken for is excluded from this tick's
    // loop, and does not reach past its nearest destination. It resumes when
    // the reserving car arrives.
    if ((state.destPins[d] as number) - (state.destReserved[d] as number) === 0) {
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
