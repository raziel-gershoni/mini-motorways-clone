import { TERRAIN } from '@laneways/shared'
import type { GameState } from './state'
import { H_TILES, H_DEST_COUNT } from './state'
import type { WorldData } from './world'
import { isFootprintCell, destMetaOrientation } from './buildings'
import { countCommittedCars } from './dispatch'

/**
 * Road placement, erasure, the tile budget, and tree clearing — spec §5.11
 * and design decisions 1, 2 and 4.
 *
 * Roads are an 8-direction bitmask per cell, stored symmetrically: a segment
 * between `a` and `b` sets one bit in `roads[a]` (the direction toward `b`)
 * and the mirrored bit in `roads[b]` (the direction toward `a`). Both bits
 * are written and cleared together by every function here; `assertSymmetric`
 * is the tested invariant that this holds, not an assumption.
 *
 * **Destroyed trees are recorded in the `cleared` region, never by writing to
 * `world.terrain`.** `WorldData.terrain` is immutable per map and shared by
 * every `GameState` built from it; mutating it here would make rollback
 * restore the road but not the tree, and would turn `WorldData` into
 * cross-instance mutable state surviving every snapshot (design decision 1).
 * `hasTree` is the single reader of `cleared`, and it is deliberately not
 * un-set by `eraseRoad`: a tree, once destroyed, stays destroyed for the
 * life of that `GameState` (design decision 1).
 *
 * **A road costs one tile per newly-occupied cell, not one per segment**
 * (spec §5.11, design decision 4). `canPlaceRoad` costs a placement as the
 * number of the two endpoint cells whose road mask is currently 0 — 2 for a
 * fresh segment in open ground, 1 when extending a run, 0 when the segment
 * already exists. `eraseRoad` refunds the number of endpoint cells whose
 * mask becomes 0 after the bit is cleared. §5.10's flat tile income is tuned
 * against this per-cell model; charging per segment instead would silently
 * change the whole tile economy.
 *
 * **Check order is bounds -> adjacency -> terrain -> cost -> budget, and the
 * order is load-bearing.** Computing cost before checking it against the
 * budget means a segment that already exists costs 0 and therefore always
 * passes the budget check, even at zero tiles left — which is exactly the
 * case M1c's drag-to-place needs: dragging back across a finished path must
 * not read as a budget error on every frame. A budget-first implementation
 * (`if (tilesLeft === 0) return budget-failure`) rejects that case wrongly.
 *
 * **Terrain is checked as a whitelist — `LAND` or `TREE` — on both
 * endpoints**, matching `world.passable`, which fails closed. A blacklist
 * (rejecting only `WATER`/`MOUNTAIN`) fails open for an out-of-range cell,
 * because `world.terrain[b]` for an off-grid `b` is `undefined`, which is
 * neither `WATER` nor `MOUNTAIN` and so passes a blacklist. Bounds are
 * validated first here regardless, so an off-grid cell never reaches the
 * terrain check at all — but the whitelist is kept anyway, both because the
 * interface promises it and because it is the check that also fails closed
 * on any future terrain code this file has not been told about.
 *
 * **`dirBetween` takes real bounds (`w` AND `h`) and validates them.**
 * Without `h`, or without validating the decomposed `x`/`y` delta, a pair
 * that wraps the row seam (e.g. `(w-1, y)` to `(0, y+1)`) is
 * indistinguishable from a genuine east neighbour under naive index-delta
 * arithmetic. An out-of-range typed-array write is a *silent no-op* in
 * JavaScript: under that bug, `roads[a]` gets the bit, the mirrored write to
 * `roads[b]` lands on the wrong cell (or the right cell but the wrong
 * direction), a tile is charged, and `placeRoad` reads the result back as
 * "already exists" on the next call rather than repairing it. `dirBetween`
 * here decomposes both `from` and `to` to `x`/`y` via `% w` and `/ w`, so a
 * wrapped pair is caught as `|dx| > 1` rather than silently accepted.
 *
 * **Erase refunds immediately ONLY when no car is committed to the cell. Spec
 * §5.11's delayed refund is live as of M1d Task 5, and this paragraph used to
 * say the opposite.** M1b wrote "there is no delayed refund here" because cars
 * did not exist; M1c inherited it and recorded the deviation as deferred to
 * M1d. It is now discharged: a deleted segment whose endpoint cell still has a
 * committed car keeps its last bit in `ghostMask`, records how many cars must
 * clear in `ghostCommitted`, and pays its one tile when the last of them
 * departs — or when a road is placed over it, whichever comes first.
 * `eraseRoad` keeps its shape (both mirrored bits cleared, refund computed per
 * endpoint whose mask becomes 0); what is new is where that refund goes.
 * **`packages/sim/test/cars.test.ts`'s "refunds immediately and does not touch
 * the car" test asserted the old behaviour on purpose and is rewritten in the
 * same commit** — see the note at its site.
 *
 * **This module now imports `dispatch.ts`, which imports it back.** A genuine
 * two-way cycle, and the same one `buildings.ts` already forms with this file:
 * safe by the invariant `state.ts` documents, because every cross-reference is
 * read inside a function body (`settleErasedCell`'s `countCommittedCars` call),
 * never at module-evaluation time, and both modules export only hoisted
 * `function` declarations plus module-scope constants that touch neither. The
 * walk lives there rather than here because `dispatch.ts` owns the `carRoute`
 * nibble codec and the meaning of a committed route; duplicating it here is the
 * `stepCell` mistake M1d Task 1a spent a task undoing.
 *
 * **Nothing here notifies the pathfinder.** Design decision 3 derives
 * per-colour flow-field staleness from a content hash of the `roads` region
 * itself, not from a dirty flag set at each mutation site. So a road
 * mutation IS invalidation, automatically, for every caller including ones
 * added after this file is written — there is no `markDirty` call to find
 * here because there is nothing for it to do.
 *
 * **The driveway rule (M1c decision 5).** `canPlaceRoad` rejects placement
 * onto any of a destination's 6 non-carpark footprint cells with reason
 * `'building'` — the house cell and the carpark cell remain placeable,
 * which is what makes `dist[houseCell]` and the carpark-seeded field
 * meaningful. This module imports `isFootprintCell`/`destMetaOrientation`
 * from `buildings.ts`, which imports `hasTree` back from here — a genuine
 * two-way cycle, safe by the same invariant `state.ts` documents for its own
 * cycles with `world.ts`/`regions.ts`: every cross-reference is read inside
 * a function body, never at module-evaluation time, and both modules export
 * only `function` declarations (hoisted before any statement runs), so
 * neither module's top level ever observes the other mid-initialisation.
 */

/** 8 directions, index 0 = N, clockwise. index = y * w + x throughout. */
export const DIR_COUNT = 8
export const DX = Object.freeze([0, 1, 1, 1, 0, -1, -1, -1] as const)
export const DY = Object.freeze([-1, -1, 0, 1, 1, 1, 0, -1] as const)
export const OPPOSITE = Object.freeze([4, 5, 6, 7, 0, 1, 2, 3] as const)

/**
 * Which of a cell's TWO occupancy lanes a car travelling in direction `d`
 * claims — M1d design decision 1. Lives here, beside `DX`/`DY`/`OPPOSITE`,
 * because this is where every other direction table already lives; the
 * claim/release protocol that consumes it is `blocking.ts`.
 *
 * Spec §5.11 line 275: a road is "Bidirectional, one lane each way." A single
 * undirected slot per cell is not a simplification of that — it makes opposing
 * traffic mutually exclusive on every shared cell, and opposing traffic is the
 * MODAL event in this game, not an edge case (the return leg is the outbound
 * route read backwards, `trips.ts` flips the phase in place on the carpark cell
 * with no dwell, and every colour's field is seeded at a single carpark cell).
 *
 * | dir | name | (DX, DY) | lane |
 * |-----|------|----------|------|
 * |  0  |  N   | ( 0, -1) |  1   |
 * |  1  |  NE  | ( 1, -1) |  0   |
 * |  2  |  E   | ( 1,  0) |  0   |
 * |  3  |  SE  | ( 1,  1) |  0   |
 * |  4  |  S   | ( 0,  1) |  0   |
 * |  5  |  SW  | (-1,  1) |  1   |
 * |  6  |  W   | (-1,  0) |  1   |
 * |  7  |  NW  | (-1, -1) |  1   |
 *
 * **A frozen table, not a computed rule**, so a reader can check all eight
 * entries at a glance. The rule it can be checked AGAINST is *lane 0 iff the
 * travel vector points east, or due south when it does not point east* —
 * `DX[d] > 0 || (DX[d] === 0 && DY[d] > 0)` — but the table is the source of
 * truth and the rule is the check, never the other way round. The mapping is
 * total: all eight directions listed, each mapping to exactly one lane, four to
 * each.
 *
 * **The one property that makes head-on structurally impossible:**
 * `LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]` for every `d`. Two cars
 * travelling in exactly opposite directions can never contend for the same
 * slot, so a head-on swap always resolves in one tick, in either index order,
 * with no valve, no give-way rule and no special case. It also means no
 * 2-cycle deadlock can exist at all — a mutual block needs each car standing on
 * the other's target, which makes their directions exact opposites, which puts
 * them in different lanes. Only cycles of length >= 3 can deadlock, which is
 * what M1d Task 4's valve is for. `roads.test.ts` asserts that property over
 * the WHOLE table rather than over sampled pairs, because it is what the entire
 * milestone rests on.
 *
 * **The model's real limit, stated plainly: two lanes do not model an
 * intersection crossing.** Two cars may share a cell whenever their directions
 * land in different lanes — on a straight corridor that means exactly "one each
 * way", but at a junction it also permits an eastbound car and a northbound car
 * to occupy the same cell simultaneously. They cross paths inside that cell and
 * nothing stops them. That is the spec's own model (§5.5 prices intersections
 * with a *speed* multiplier and a *wait*, not with mutual exclusion) and it is
 * what **M1f's** traffic lights and roundabouts are for. Repointed from M1e,
 * which shipped neither: both are §5.10 item cards and the card modal is M1f's,
 * so the gap is unchanged and still unowned by anything in the tree.
 *
 * **Also re-confirmed at the close of M1e (Task 11): `stepCell`'s `y < 0` is
 * still the verified equivalent mutant it was labelled as through either
 * caller, and it is still not to be "fixed".** Diffed across the whole
 * milestone (base `1414e33`), the only change to this file is the paragraph
 * above; `stepCell` and both callers' `next < 0` guards are byte-identical.
 * **Do not tighten either caller's `next < 0` to `next === -1`** to manufacture
 * a detector — that satisfies the label by strictly WEAKENING two guards, which
 * is a worse trade than an untestable branch.
 */
export const LANE_OF_DIR = Object.freeze([1, 0, 0, 0, 0, 1, 1, 1] as const)

/** The number of occupancy lanes per cell. `LANE_OF_DIR` is total onto `[0, LANE_COUNT)`. */
export const LANE_COUNT = 2

/**
 * The other of the two lanes. `LANE_COUNT` is 2 and this function is the one
 * place that assumes it, so raising `LANE_COUNT` fails here loudly rather than
 * silently returning a lane index that means something else.
 *
 * Its one production caller is `canEnter`'s junction clause (M1f Task 2): mutual
 * exclusion at a junction means the entrant's own lane AND the lane it is
 * crossing. `game/src/queueProbe.ts`'s `carAheadOf` is the second, and reads it
 * for exactly the same reason — so the probe and the entry rule cannot disagree
 * about which slot is holding a car up.
 *
 * **The `LANE_COUNT !== 2` throw is unreachable while `LANE_COUNT` is 2 and is
 * kept anyway**, in the same register as `assertSingleCrossing` (cars.ts) and
 * `assertMaxCarsFitsOccupancy` (blocking.ts): it is a compile-time-shaped
 * assumption that only a future edit can break, and the failure without it is a
 * silent wrong lane rather than a crash. No detector was manufactured for it —
 * see the M1f Task 2 report's mutation table, row 8.
 */
export function otherLane(lane: number): number {
  if (LANE_COUNT !== 2) {
    throw new Error(`roads: otherLane assumes exactly two lanes, but LANE_COUNT is ${LANE_COUNT}`)
  }
  if (lane !== 0 && lane !== 1) throw new Error(`roads: lane ${lane} is not one of the two`)
  return lane === 0 ? 1 : 0
}

function inBounds(cell: number, cells: number): boolean {
  return Number.isInteger(cell) && cell >= 0 && cell < cells
}

/**
 * Direction index from `from` to `to`, or -1 if they are not 8-adjacent on a
 * w x h grid. Both indices are validated against `w * h` (and integrality)
 * before any arithmetic is done on them — see the module comment for why
 * skipping that validation is a silent-corruption hazard, not just a
 * cosmetic one.
 */
export function dirBetween(from: number, to: number, w: number, h: number): number {
  const cells = w * h
  if (!inBounds(from, cells) || !inBounds(to, cells)) return -1

  const dx = (to % w) - (from % w)
  const dy = ((to / w) | 0) - ((from / w) | 0)
  if (dx < -1 || dx > 1 || dy < -1 || dy > 1 || (dx === 0 && dy === 0)) return -1

  for (let k = 0; k < DIR_COUNT; k++) {
    if ((DX[k] as number) === dx && (DY[k] as number) === dy) return k
  }
  return -1
}

/**
 * The cell one step in direction `dir` from `cell` on a `w` x `h` grid, or -1
 * if that step leaves the grid. The inverse of `dirBetween`, and it lives here
 * beside it, `DX`/`DY`/`OPPOSITE` and `inBounds` for that reason.
 *
 * **The x/y round-trip is not decoration.** `cell + DY[dir] * w + DX[dir]`
 * alone wraps the grid's right edge onto the next row's left edge — the same
 * row-seam false neighbour `dirBetween`, `carparkCell` and `graph.ts`'s
 * `neighbours` each carry a paragraph about. The failure is a *wrong-but-
 * plausible* cell rather than an out-of-range one, which is why every caller
 * needs the bound rather than relying on a typed-array read to fail: an
 * out-of-range typed-array read is `undefined` and an out-of-range write is a
 * silent no-op, neither of which is a signal.
 *
 * ---------------------------------------------------------------------------
 * ONE COPY, AND WHY THERE USED TO BE TWO
 * ---------------------------------------------------------------------------
 *
 * M1c shipped this function twice: private in `cars.ts`, exported from
 * `dispatch.ts`. Both read the shared `DX`/`DY`, so they could never disagree
 * about what a direction *means* — only the bounds test was written twice, and
 * only one of the two was ever tested. `cars.test.ts` gave its copy one `it()`
 * per bound; `dispatch.ts`'s copy had none, and all four of its bounds survived
 * the whole suite. **The copy that got tested was not the copy dispatch used**
 * — the catalogue's "production code with no covering test, masked by a
 * redundant sibling" in its most literal form. M1c ruled to keep the
 * duplication mid-milestone and recorded consolidating it here as the plan;
 * M1d Task 1a is that consolidation, done before a third caller is added.
 *
 * ---------------------------------------------------------------------------
 * `y < 0` IS A VERIFIED EQUIVALENT MUTANT THROUGH EITHER CALLER
 * ---------------------------------------------------------------------------
 *
 * Deleting `y < 0` from the guard below is **not observable through any
 * caller**, and that is a derivation rather than an intuition:
 *
 *   - the retained `x` guards fence `x` into `[0, w - 1]`;
 *   - so for any `y <= -1`, `y * w + x <= -w + (w - 1) = -1`;
 *   - so the function still returns a negative number, just not the literal -1;
 *   - and every caller reduces every negative to one observable — `cars.ts`
 *     throws on `next < 0` *without interpolating `next` into the message*, and
 *     `dispatch.ts`'s walk does `if (next < 0) break`.
 *
 * Re-verified exhaustively at M1d: 1,600 geometries x every in-range cell x
 * Int32 extremes x all 8 directions gave **0** differences in the sign. **The
 * raw difference COUNT is deliberately not stated** (M1d Task 2 corrected this
 * paragraph, which had cited 97,040): an independent exhaustive run gave 92,040
 * in-range and 118,640 including extremes, because the total depends entirely
 * on which extreme cells are enumerated and no prose description fixes that.
 * Only the sign result is load-bearing and only it reproduces robustly — a
 * five-digit figure that cannot be re-derived from its own description reads as
 * measurement without being any. **Do not manufacture a detector for it**,
 * and in particular **do not tighten either caller's `next < 0` to
 * `next === -1`** — that satisfies the letter of "every bound has a detector"
 * by strictly weakening two guards, in a milestone that is about to hand this
 * function a third caller. The bound is kept because the behaviour is
 * required; the direct tests in `roads.test.ts` observe it because they call
 * this function without a caller in the way, which is the whole reason it is
 * exported rather than private.
 */
export function stepCell(cell: number, dir: number, w: number, h: number): number {
  const x = (cell % w) + (DX[dir] as number)
  const y = ((cell / w) | 0) + (DY[dir] as number)
  if (x < 0 || x >= w || y < 0 || y >= h) return -1
  return y * w + x
}

export type PlaceFailure = 'out-of-bounds' | 'not-adjacent' | 'terrain' | 'building' | 'budget'
export type PlaceResult =
  | { readonly ok: true; readonly cost: number } // 0, 1 or 2 tiles
  | { readonly ok: false; readonly reason: PlaceFailure }

/**
 * **Every value `canPlaceRoad` can return, allocated once at module load.**
 *
 * `canPlaceRoad` runs inside the tick — `step`'s phase 2 calls `placeRoad` for
 * every `place` action in the input log, and a drag enqueues one per sampled
 * cell — and it used to build a fresh `{ ok, ... }` literal on every call.
 * Measured by `packages/game/test/allocation.test.ts` at **40.6 / 41.7 / 44.3
 * bytes per call** (81-89 B/frame at that rig's two actions a frame), and
 * independently by the M2 milestone review at 38.0-39.4 B/frame at one action a
 * frame. Both figures are the same code: **the invariant is per CALL**, because
 * a per-frame number encodes the driver's input density and moves about 2x
 * between rigs. It is now 0.
 *
 * The return type is unchanged, so no caller changes. It is sound because
 * `PlaceResult` is `readonly` in the type system *and* frozen at run time, so a
 * shared instance cannot be scribbled on by one caller and observed by the
 * next — a returned singleton is only safe when the value is genuinely
 * immutable, and both halves are asserted rather than assumed
 * (`roads.test.ts`).
 *
 * **Two legs, and each covers what the other cannot — measured, not asserted.**
 * The tests pin the ROWS: unfreezing any one of the eight is caught by
 * `roads.test.ts`'s frozen and no-scribble tests. They cannot pin the OUTER
 * `Object.freeze` on `ACCEPT_BY_COST` — with the rows still frozen, every
 * returned value is still frozen and every one of the 545 sim tests passes.
 * That leg belongs to the `determinism/no-module-mutable-state` lint rule,
 * which reports the unfrozen outer array by name and line. Both were run under
 * their own mutations rather than being claimed: rows → 1-2 test detectors
 * each, outer → 0 test detectors and exactly 1 lint error. `Object.freeze` does
 * not recurse, which is why the rule demands every level and why neither leg
 * alone is enough.
 */
const REFUSE_OUT_OF_BOUNDS = Object.freeze({ ok: false, reason: 'out-of-bounds' } as const)
const REFUSE_NOT_ADJACENT = Object.freeze({ ok: false, reason: 'not-adjacent' } as const)
const REFUSE_TERRAIN = Object.freeze({ ok: false, reason: 'terrain' } as const)
const REFUSE_BUILDING = Object.freeze({ ok: false, reason: 'building' } as const)
const REFUSE_BUDGET = Object.freeze({ ok: false, reason: 'budget' } as const)

/**
 * Indexed by cost, which `canPlaceRoad` computes as the number of the two
 * endpoint cells whose mask is currently 0 — so it is 0, 1 or 2 and nothing
 * else, and this table is total over that range. `assertPlaceCost` below is the
 * fail-closed guard that says so out loud rather than letting an out-of-range
 * index return `undefined` and crash at the caller's `.ok`.
 */
const ACCEPT_BY_COST = Object.freeze([
  Object.freeze({ ok: true, cost: 0 } as const),
  Object.freeze({ ok: true, cost: 1 } as const),
  Object.freeze({ ok: true, cost: 2 } as const),
] as const)

/**
 * Throws unless `cost` is one of the three the accept table covers.
 *
 * Unreachable through `canPlaceRoad` as written — `cost` is a sum of two
 * ternaries over `{0, 1}` — and exported so it is exercised directly rather
 * than being the one line nothing executes, on the precedent of
 * `assertSingleCrossing` (cars.ts) and `assertDispatchProgress` (dispatch.ts).
 * It exists because the alternative to a named throw is `undefined` returned as
 * a `PlaceResult`, which fails at whichever caller reads `.ok` next.
 *
 * **Disclosed, in `cars.ts`'s idiom for exactly this shape: deleting the CALL
 * to this function from `canPlaceRoad` is a 0-detector no-op today**, and
 * measured as one rather than assumed (M1d Task 1). The function's own bounds
 * are killed from both directions by direct calls in `roads.test.ts`; the call
 * site is not, and cannot be, while `cost` provably lies in `[0, 2]`. Unlike
 * `assertSingleCrossing` there is no parameter to drive it through — the cost
 * is computed two lines above, from the state — so making the call site
 * reachable would mean adding a seam that exists only for the test. It is kept
 * because the guard's value is entirely prospective: the day the cost model
 * changes (an endpoint count other than two, or a cell that can be half-paid
 * for), the difference is a named error here versus `undefined.ok` at a caller.
 * Do not delete it on the strength of its own survival.
 *
 * @internal
 */
export function assertPlaceCost(cost: number): void {
  if (!Number.isInteger(cost) || cost < 0 || cost >= ACCEPT_BY_COST.length) {
    throw new Error(
      `roads: a placement cost of ${cost} is outside [0, ${ACCEPT_BY_COST.length}) — the cost is the ` +
        'number of the two endpoint cells whose road mask is 0, so it cannot be anything else',
    )
  }
}

/**
 * True iff `cell` is one of the 6 non-carpark footprint cells of any
 * currently-placed destination — the driveway rule's whole basis. The house
 * cell and the carpark cell are deliberately NOT checked here: they are
 * road-legal by design (decision 5), so `canPlaceRoad` never calls this for
 * them specifically, only for the two raw endpoints `a`/`b`, which may or
 * may not happen to be a house/carpark cell.
 */
function cellIsDestinationFootprintOnly(state: GameState, world: WorldData, cell: number): boolean {
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    const destCell = state.destCell[d] as number
    const orientation = destMetaOrientation(state.destMeta[d] as number)
    if (isFootprintCell(destCell, orientation, world.w, cell)) return true
  }
  return false
}

/**
 * Whether placing a road between `a` and `b` would succeed, and at what
 * cost, without mutating anything. `placeRoad` calls this first and applies
 * the same checks in the same order, so the two can never disagree.
 */
export function canPlaceRoad(state: GameState, world: WorldData, a: number, b: number): PlaceResult {
  if (!inBounds(a, world.cells) || !inBounds(b, world.cells)) {
    return REFUSE_OUT_OF_BOUNDS
  }

  const dir = dirBetween(a, b, world.w, world.h)
  if (dir === -1) {
    return REFUSE_NOT_ADJACENT
  }

  // Whitelist on BOTH endpoints, matching `world.passable` (LAND or TREE).
  // Bounds are already checked above, so `world.passable[a]`/`[b]` are real
  // terrain reads here, never `undefined`.
  if (world.passable[a] !== 1 || world.passable[b] !== 1) {
    return REFUSE_TERRAIN
  }

  // The driveway rule (M1c decision 5): both endpoints are checked, and a
  // destination's 6 non-carpark footprint cells are the only cells this
  // rejects — the house cell and the carpark cell stay placeable.
  if (cellIsDestinationFootprintOnly(state, world, a) || cellIsDestinationFootprintOnly(state, world, b)) {
    return REFUSE_BUILDING
  }

  const maskA = state.roads[a] as number
  const maskB = state.roads[b] as number
  const cost = (maskA === 0 ? 1 : 0) + (maskB === 0 ? 1 : 0)

  // Computed AFTER cost, deliberately: a segment that already exists costs 0
  // (both masks are already non-zero, since the bit toward the other
  // endpoint is set), so this comparison passes even at zero tiles left.
  if (cost > tilesLeft(state)) {
    return REFUSE_BUDGET
  }

  // A table read, not a literal — see `ACCEPT_BY_COST`. Every return above is a
  // module-scope frozen singleton for the same reason: this function runs
  // inside the tick, once per `place` action.
  assertPlaceCost(cost)
  return ACCEPT_BY_COST[cost] as PlaceResult
}

/**
 * Places a road between `a` and `b`, mirrored on both cells, spending tiles
 * per `canPlaceRoad`'s cost. Returns `false` and changes nothing if
 * `canPlaceRoad` would reject the placement.
 *
 * A `TREE` endpoint is destroyed (`cleared[cell] = 1`) the first time a road
 * touches it; a `LAND` endpoint is left alone. Re-placing over an existing
 * segment (cost 0) still runs this logic, but every write it performs is
 * idempotent — the bits are already set and `cleared` is already 1 if it was
 * ever going to be — so the buffer is unchanged and the hash does not move.
 *
 * **Placing over a GHOST cell pays that cell's pending refund and charges the
 * placement normally** (Decision 8, M1d Task 5). Not "cancels the refund":
 * cancelling charges the player twice for one cell — they paid 1 to build it, 1
 * to rebuild it, and got nothing back — and violates §5.11's "refunds in full".
 * Paying it means erase-then-replace nets **exactly zero**, repeatably, so
 * nothing is printed and nothing is confiscated. That matters more than usual
 * here: the Worker replays the identical input log, so an inflated budget would
 * verify as legitimate on the leaderboard rather than being caught.
 *
 * A ghost cell has a road mask of 0 by definition, so `canPlaceRoad` prices it
 * at 1 tile and the refund is 1 tile — the two cancel per cell, and both
 * endpoints can be ghosts at once. **One consequence, disclosed rather than
 * discovered: at exactly 0 tiles left the placement is still refused for
 * budget**, because `canPlaceRoad` is a pure predicate over `roads` and knows
 * nothing about pending refunds. That is "charges the placement normally" taken
 * literally; teaching the budget check about ghosts would make the cost model
 * depend on two regions instead of one, which is a change to the economy rather
 * than to this function.
 */
export function placeRoad(state: GameState, world: WorldData, a: number, b: number): boolean {
  const result = canPlaceRoad(state, world, a, b)
  if (!result.ok) return false

  const dir = dirBetween(a, b, world.w, world.h)
  const opp = OPPOSITE[dir] as number

  state.roads[a] = (state.roads[a] as number) | (1 << dir)
  state.roads[b] = (state.roads[b] as number) | (1 << opp)

  if (world.terrain[a] === TERRAIN.TREE) state.cleared[a] = 1
  if (world.terrain[b] === TERRAIN.TREE) state.cleared[b] = 1

  state.header[H_TILES] = (state.header[H_TILES] as number) - result.cost
  // AFTER the charge, and through the same one function `noteGhostDeparture`
  // uses, so "the pending refund is paid the moment the cell stops being a
  // ghost" has exactly one implementation. Order is arithmetically irrelevant
  // (both are unconditional adds to `H_TILES`); it is written this way so the
  // sequence reads as "you are charged for the placement, and handed back the
  // tile the erase owed you".
  if ((state.ghostMask[a] as number) !== 0) payGhostRefund(state, a)
  if ((state.ghostMask[b] as number) !== 0) payGhostRefund(state, b)

  return true
}

/**
 * The largest value a `ghostCommitted` slot can hold. It is a `Uint8Array`, and
 * `Uint8Array` COERCES rather than throwing — a count of 256 would be stored as
 * 0, which reads as "no car is committed" and pays the refund on the next
 * departure while 256 cars are still driving the ghost.
 *
 * The plan states the bound as `maxCars`, which is 80 on `firstCity`; `parseMap`
 * puts no ceiling on `maxCars` at all, so the ceiling that actually protects the
 * slot is the element type's, and that is what is checked. Same class as
 * `assertMaxCarsFitsOccupancy` (blocking.ts) and the same treatment.
 */
export const GHOST_COMMITTED_MAX = 255

/**
 * Throws if a map's car count would overflow a `ghostCommitted` slot.
 *
 * Unreachable on every map that ships (`firstCity`'s `maxCars` is 80) and
 * exercised directly, on the precedent of `assertSingleCrossing` (cars.ts) and
 * `assertMaxCarsFitsOccupancy` (blocking.ts).
 *
 * @internal `eraseRoad` is the production call site.
 */
export function assertGhostCommittedFits(count: number, cell: number): void {
  if (!Number.isInteger(count) || count < 0 || count > GHOST_COMMITTED_MAX) {
    throw new Error(
      `roads: cell ${cell} has ${count} committed cars, which a Uint8 ghostCommitted slot cannot hold ` +
        `(0..${GHOST_COMMITTED_MAX}) — Uint8Array coerces rather than throwing, so the count would wrap ` +
        'and the deferred refund would be paid under cars still driving the ghost',
    )
  }
}

/**
 * Throws if `ghostCommitted` is about to be decremented at 0 — **M1d Task 1d's
 * standing obligation, discharged here by name.**
 *
 * The class, restated at the site that inherits it: an unguarded `--` at 0 on a
 * `Uint8Array` slot wraps to 255, silently, and it survives snapshot/restore and
 * replays identically in the Worker. Here it would mean a cell that stays a
 * ghost for 255 more departures and pays its refund at a moment unrelated to any
 * car, i.e. a tile printed out of nothing on the leaderboard's own replay.
 *
 * **Unreachable through `runMovement` + `runArrivals`, by construction rather
 * than by luck:** `noteGhostDeparture` is the only decrement site and it returns
 * early unless `ghostMask[cell] !== 0`, and the mask is cleared in the same
 * statement that takes the count to 0. So a zero count and a non-zero mask
 * cannot coexist. Exercised directly in `roads.test.ts`.
 *
 * @internal `noteGhostDeparture` is the production call site.
 */
export function assertGhostCommittedPositive(count: number, cell: number): void {
  if (count <= 0) {
    throw new Error(
      `roads: cell ${cell} is a ghost with ghostCommitted ${count} — there is no committed car left to ` +
        'clear, and decrementing would wrap the Uint8 slot to 255',
    )
  }
}

/** The ghosted road bit of `cell`: 0 when the cell is not a ghost. */
export function ghostMaskOf(state: GameState, cell: number): number {
  return state.ghostMask[cell] as number
}

/** How many committed cars `cell` is still waiting on before its refund is paid. */
export function ghostCommittedOf(state: GameState, cell: number): number {
  return state.ghostCommitted[cell] as number
}

/**
 * A cell has stopped being a ghost: clear both regions and pay the one tile the
 * erase deferred.
 *
 * **One rule, two triggers** (Decision 8): *the pending refund is paid the
 * moment the cell stops being a ghost, and a cell stops being a ghost when its
 * committed count reaches 0 or a road is placed on it.* Both callers below go
 * through this function, so the two triggers cannot drift apart and neither can
 * pay a different amount.
 *
 * **One tile, always, and never the mask's popcount.** The erase deferred
 * exactly one tile for this cell — `eraseRoad` refunds per ENDPOINT CELL whose
 * mask becomes 0, not per bit — so paying anything else here would change the
 * whole tile economy §5.10's flat income is tuned against.
 */
function payGhostRefund(state: GameState, cell: number): void {
  state.ghostMask[cell] = 0
  state.ghostCommitted[cell] = 0
  state.header[H_TILES] = (state.header[H_TILES] as number) + 1
}

/**
 * Car `i` has just left `cell`, by crossing off it (`advanceCar`) or by ending
 * its trip on it (`completeTrip`). If the cell is a ghost, one committed car has
 * cleared; the last one to clear pays the deferred refund.
 *
 * **Takes no car index, deliberately.** Every car that can depart a ghost cell
 * is one the erase counted — a car dispatched afterwards cannot be routed
 * through it (`dist[cell]` is INF the moment `eraseRoad` clears the live bits)
 * and a non-committed car cannot even enter it (`canEnter` answers
 * `REFUSED_GHOST`). Passing `i` here would invite a per-car check that reads as
 * defence and is really a second, weaker copy of the commitment definition;
 * `isCommittedTo` (dispatch.ts) is the one copy, and its comment derives what
 * this asymmetry does and does not cost.
 *
 * @internal `advanceCar` (cars.ts) and `completeTrip` (trips.ts) are the two
 * production call sites, and there are no others: they are the only two places
 * a car stops standing on a cell.
 */
export function noteGhostDeparture(state: GameState, cell: number): void {
  if ((state.ghostMask[cell] as number) === 0) return
  const committed = state.ghostCommitted[cell] as number
  assertGhostCommittedPositive(committed, cell)
  const left = committed - 1
  state.ghostCommitted[cell] = left
  if (left === 0) payGhostRefund(state, cell)
}

/**
 * An erase has just taken `cell`'s last road bit. Either refund the tile now, or
 * defer it and make the cell a ghost.
 *
 * @returns the tiles to refund immediately: 1 with no committed car, 0 when the
 *          refund is deferred.
 */
function settleErasedCell(state: GameState, world: WorldData, cell: number, bit: number): number {
  // Deferred import (see the module comment's note on the `dispatch.ts` cycle).
  const committed = countCommittedCars(state, world, cell)
  if (committed === 0) return 1
  assertGhostCommittedFits(committed, cell)
  // Assignment, never `+=`: a later erase that re-ghosts this cell RECOUNTS
  // from scratch, because the currently-committed set is exactly the set that
  // must clear. (Reachable only via place-then-erase, since a ghost cell has no
  // road bit to erase — `placeRoad` pays the old refund on the way in, so the
  // slot this overwrites is always 0.)
  state.ghostMask[cell] = bit
  state.ghostCommitted[cell] = committed
  return 0
}

/**
 * Erases the road between `a` and `b`, clearing only the two mirrored bits
 * for that one segment — never the whole mask of either cell, which would
 * silently destroy that cell's other segments too. Refunds one tile per
 * endpoint whose mask becomes entirely 0 as a result. A segment that does
 * not exist is a no-op: returns `false`, refunds nothing, changes nothing.
 *
 * **The refund is DEFERRED for an endpoint that still has a car committed to it
 * — spec §5.11's ghost roads, M1d Task 5.** The shape of this function is
 * unchanged: it still clears both mirrored bits, and it still computes the
 * refund per endpoint whose mask becomes 0. What changed is that such an
 * endpoint now asks `countCommittedCars` first, and a non-zero answer moves the
 * cell's last bit into `ghostMask`, records the count in `ghostCommitted`, and
 * pays nothing until the last of those cars clears.
 *
 * **The scope of the ghost is exactly "the cell whose last bit went", and that
 * is what makes the count SOUND rather than arbitrary.** With the live bits
 * gone, `dist[cell]` is INF and no route committed after the erase can contain
 * the cell, so every car that ever crosses off it afterwards is one of the cars
 * counted here. Ghost a cell whose other bits survive and that identity breaks:
 * a car dispatched later could be routed through it and would decrement a count
 * it was never part of.
 */
export function eraseRoad(state: GameState, world: WorldData, a: number, b: number): boolean {
  if (!inBounds(a, world.cells) || !inBounds(b, world.cells)) return false

  const dir = dirBetween(a, b, world.w, world.h)
  if (dir === -1) return false

  const opp = OPPOSITE[dir] as number
  const bitA = 1 << dir
  const bitB = 1 << opp

  const maskA = state.roads[a] as number
  if ((maskA & bitA) === 0) return false // no-op: this segment does not exist

  const maskB = state.roads[b] as number
  const newMaskA = maskA & ~bitA
  const newMaskB = maskB & ~bitB

  // Written BEFORE the endpoints are settled, so that `dist[cell]` is already
  // INF for anything that looks at the board from inside `settleErasedCell` —
  // and so that the bit `ghostMask` receives is provably the cell's LAST one,
  // rather than a bit some later reader could mistake for a live road.
  state.roads[a] = newMaskA
  state.roads[b] = newMaskB

  let refund = 0
  if (newMaskA === 0) refund += settleErasedCell(state, world, a, bitA)
  if (newMaskB === 0) refund += settleErasedCell(state, world, b, bitB)
  state.header[H_TILES] = (state.header[H_TILES] as number) + refund

  return true
}

/** The raw 8-bit road mask for `cell`: bit `k` set means a segment leaves toward direction `k`. */
export function roadMask(state: GameState, cell: number): number {
  return state.roads[cell] as number
}

/** Tiles remaining to spend on new road. */
export function tilesLeft(state: GameState): number {
  return state.header[H_TILES] as number
}

/**
 * Whether `cell` still has a standing, unbroken tree. The single reader of
 * `cleared` — M1c's spawn placement calls this, not `world.terrain`
 * directly, because `terrain[cell] === TREE` alone does not know whether
 * that tree has since been destroyed by a road.
 */
export function hasTree(state: GameState, world: WorldData, cell: number): boolean {
  return world.terrain[cell] === TERRAIN.TREE && state.cleared[cell] === 0
}

/**
 * Walks the whole grid and throws on the first road bit that either (a)
 * points off-grid, or (b) has no mirrored bit at the neighbour it points to.
 * Case (a) matters on its own, independently of (b): a bit that wraps the
 * row seam under naive index arithmetic can be mirror-symmetric under that
 * *same* arithmetic (the exact self-blind failure mode this function must
 * not have), so neighbours are computed by decomposing to `x`/`y`, never by
 * `cell + delta`.
 */
export function assertSymmetric(state: GameState, world: WorldData): void {
  const { w, h, cells } = world
  for (let cell = 0; cell < cells; cell++) {
    const mask = state.roads[cell] as number
    if (mask === 0) continue
    const x = cell % w
    const y = (cell / w) | 0
    for (let k = 0; k < DIR_COUNT; k++) {
      if ((mask & (1 << k)) === 0) continue
      const nx = x + (DX[k] as number)
      const ny = y + (DY[k] as number)
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
        throw new Error(`assertSymmetric: cell ${cell} has a road bit in direction ${k} that points off-grid`)
      }
      const neighbour = ny * w + nx
      const oppBit = 1 << (OPPOSITE[k] as number)
      const neighbourMask = state.roads[neighbour] as number
      if ((neighbourMask & oppBit) === 0) {
        throw new Error(
          `assertSymmetric: cell ${cell} has a road toward cell ${neighbour} (direction ${k}) with no mirrored bit there`,
        )
      }
    }
  }
}

/** Throws if any cell with a non-zero road mask sits on impassable terrain. */
export function assertNoRoadOnImpassable(state: GameState, world: WorldData): void {
  for (let cell = 0; cell < world.cells; cell++) {
    if ((state.roads[cell] as number) !== 0 && world.passable[cell] !== 1) {
      throw new Error(`assertNoRoadOnImpassable: cell ${cell} has a road bit set on impassable terrain`)
    }
  }
}
