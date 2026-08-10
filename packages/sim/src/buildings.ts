import { CARS_PER_HOUSE } from '@laneways/shared'
import type { GameState } from './state'
import { H_HOUSE_COUNT, H_DEST_COUNT, H_TICK } from './state'
import { hasTree } from './roads'
import type { WorldData } from './world'

/**
 * Buildings and cars: placement validity, footprint/carpark geometry,
 * `destMeta` pack/unpack, and car creation — M1c design decision 5 and spec
 * §5.2/§5.9.
 *
 * **The one export that matters beyond this file: `carparkCell`.** It is
 * Task 4's source assembly's only way to turn a placed destination into a
 * flow-field source, once per destination per tick. Every other export here
 * exists to make placement correct; `carparkCell` is the one whose
 * correctness routes every car in the game.
 *
 * **This module and `roads.ts` import each other.** `hasTree` (below) needs
 * `roads.ts`'s reader of the `cleared` region; `roads.ts`'s driveway rule
 * needs `isFootprintCell`/`destMetaOrientation` (below) to know which cells
 * of a placed destination are footprint-only (road-blocked) versus the house
 * cell or carpark (road-legal). Safe by the same invariant `state.ts`
 * documents for its own cycles with `world.ts`/`regions.ts`: every
 * cross-reference is used inside a function body, never at module-evaluation
 * time, and both modules export only `function` declarations (hoisted before
 * any statement runs), so neither module's top level ever observes the other
 * mid-initialisation.
 *
 * **Nothing here is called from inside `step()` in this task** (Task 2's own
 * file list does not touch `step.ts`) — building placement is an explicit,
 * out-of-band call the M1e spawner will eventually drive, mirroring how
 * `placeRoad` had no production caller until M1c Task 1. The one exception,
 * `carparkCell`, IS a per-tick call site once Task 4 lands, and is written
 * allocation-free for exactly that reason: it returns a bare number, never
 * an object.
 */

// --- Orientation: names the side the carpark attaches to (decision 5) ---
export const ORIENTATION_N = 0
export const ORIENTATION_E = 1
export const ORIENTATION_S = 2
export const ORIENTATION_W = 3
export const ORIENTATION_COUNT = 4

// --- destMeta bit layout: bits 0-2 colour, bit 3 kind, bits 4-5 orientation, bits 6-7 zero ---
export const DEST_KIND_SQUARE = 0
export const DEST_KIND_CIRCLE = 1

/** Non-carpark footprint cells per destination: a 2x3 (or 3x2) rectangle minus nothing — the carpark is the 7th, separate cell. */
export const FOOTPRINT_CELL_COUNT = 6

// --- Car phases. PHASE_NONE = 0 is what makes an untouched car slot read as "does not exist" rather than "idle at cell 0". ---
export const PHASE_NONE = 0
export const PHASE_IDLE = 1
export const PHASE_OUTBOUND = 2
export const PHASE_RETURNING = 3

function inBounds(cell: number, cells: number): boolean {
  return Number.isInteger(cell) && cell >= 0 && cell < cells
}

/**
 * A building's colour must name a real colour group on THIS map.
 *
 * **This is a silent-drop guard, not tidiness.** Nothing downstream can
 * recover from an out-of-range colour, and every failure it produces is
 * silent:
 *
 *   - `houseColour` is a `Uint8Array`, so colour 256 stores as **0** and the
 *     house then serves a group it was never given — confidently wrong
 *     behaviour rather than absence.
 *   - A house at colour 6 on a 5-group map matches no iteration of
 *     `runDispatch`'s per-colour loop (`dispatch.ts`), so it is skipped
 *     forever: it never dispatches a car, there is no error, and there is
 *     nothing to point at.
 *   - A destination at colour 6 indexes `scratch.slotCounts` /
 *     `scratch.sourcesFlat` past their `groupCount`-sized ends, and an
 *     out-of-range typed-array write is a **silent no-op** — that destination
 *     never requests a car and never seeds a field.
 *
 * Both placement functions therefore check here, at the boundary: **validate
 * where the caller's mistake is made, not where its consequence surfaces.** A
 * bad colour is a caller error at placement time; discovering it later, from
 * inside a per-tick guard several phases into a tick, names the wrong function
 * and the wrong moment however that discovery is reported. The per-tick guards
 * in `demand.ts` and `dispatch.ts` stay, as defence-in-depth against a
 * hand-written or corrupted `destMeta` byte, which no placement check can see.
 *
 * Throws rather than returning a `PlaceCheck`: a bad colour is a programming
 * error, not a placement rejection, and it is the same class `packDestMeta`
 * already throws on for a colour outside its 3-bit field.
 */
function assertColourInRange(colour: number, world: WorldData, who: string): void {
  const { groupCount } = world.map
  if (!Number.isInteger(colour) || colour < 0 || colour >= groupCount) {
    throw new Error(`${who}: colour must be an integer in [0, ${groupCount}) for this map, got ${colour}`)
  }
}

function validateOrientation(orientation: number): void {
  if (!Number.isInteger(orientation) || orientation < 0 || orientation >= ORIENTATION_COUNT) {
    throw new Error(`buildings: orientation must be an integer in [0, ${ORIENTATION_COUNT}), got ${orientation}`)
  }
}

/**
 * Footprint width/height in cells. Orientations N and S both use a 2-wide x
 * 3-tall box at the origin (the carpark sits above or below it,
 * respectively); E and W both use a 3-wide x 2-tall box (the carpark sits to
 * its right or left). Read off the orientation directly rather than a
 * lookup table of two entries — there are only two distinct shapes and the
 * condition IS the fact being encoded.
 *
 * **Exported since M1e Task 4** so Task 5's zone-fit check can ask for the
 * footprint's extent rather than re-deriving it. A second copy of "N and S are
 * 2x3" is the copied-constant defect this project has already paid for once in
 * `render`; there is no architectural boundary forcing one here.
 */
export function footprintWidth(orientation: number): number {
  return orientation === ORIENTATION_N || orientation === ORIENTATION_S ? 2 : 3
}
export function footprintHeight(orientation: number): number {
  return orientation === ORIENTATION_N || orientation === ORIENTATION_S ? 3 : 2
}

/**
 * Packs a destination's colour/kind/orientation into one byte. Bits 0-2
 * colour (3 bits — the map format allows up to `MAX_GROUP_COUNT` = 6 groups,
 * so 2 bits is not enough), bit 3 kind (0 square, 1 circle), bits 4-5
 * orientation, bits 6-7 always zero. The exact shift amounts are load-bearing:
 * shifting orientation by 3 instead of 4 would overlap it with the kind bit.
 *
 * Colour is validated against the full 3-bit range `[0, 7]`, not against any
 * particular map's `groupCount` — this is a generic bit-packing primitive,
 * and a caller wiring destination colours against `map.groupCount` is a
 * separate, caller-side concern.
 */
export function packDestMeta(colour: number, kind: number, orientation: number): number {
  if (!Number.isInteger(colour) || colour < 0 || colour > 7) {
    throw new Error(`packDestMeta: colour must be an integer in [0, 7], got ${colour}`)
  }
  if (kind !== DEST_KIND_SQUARE && kind !== DEST_KIND_CIRCLE) {
    throw new Error(`packDestMeta: kind must be ${DEST_KIND_SQUARE} (square) or ${DEST_KIND_CIRCLE} (circle), got ${kind}`)
  }
  validateOrientation(orientation)
  return (colour & 0x7) | ((kind & 0x1) << 3) | ((orientation & 0x3) << 4)
}

/** Bits 0-2 of a packed `destMeta` byte. Allocation-free — safe to call once per destination per tick. */
export function destMetaColour(meta: number): number {
  return meta & 0x7
}

/** Bit 3 of a packed `destMeta` byte. Allocation-free. */
export function destMetaKind(meta: number): number {
  return (meta >> 3) & 0x1
}

/** Bits 4-5 of a packed `destMeta` byte. Allocation-free — this is what `carparkCell` needs from a stored destination. */
export function destMetaOrientation(meta: number): number {
  return (meta >> 4) & 0x3
}

/**
 * The carpark cell for a destination whose footprint origin is `destCell`
 * under `orientation` — the single function Task 4's source assembly calls,
 * once per destination per tick, to seed a flow field. Returns -1 if the
 * carpark would fall outside the `w` x `h` grid (which placement validity
 * below never allows to happen for a stored destination, but this function
 * is defined for any input rather than assuming that invariant).
 *
 * **Allocation-free by construction**: no object, no array, just arithmetic
 * on primitives — this runs on the tick's hot path once Task 4 lands.
 *
 * The origin is the box's top-left corner in both orientations' box shapes
 * (`footprintWidth`/`footprintHeight`); the carpark is the lowest-index cell
 * adjacent to whichever side its orientation names. For N/S the two
 * candidate cells share a row (index rises with x, so the lower-x one
 * wins); for E/W they share a column (index rises with y, so the lower-y
 * one wins). Decomposing `destCell` to x/y via `% w` / `/ w` rather than
 * adding a raw index delta is deliberate — the same row-seam self-blindness
 * `dirBetween` (roads.ts) guards against applies here: a naive index
 * offset near the grid's right edge would silently wrap into the next row.
 */
export function carparkCell(destCell: number, orientation: number, w: number, h: number): number {
  validateOrientation(orientation)
  const cx = carparkX(destCell, orientation, w)
  const cy = carparkY(destCell, orientation, w)
  if (cx < 0 || cx >= w || cy < 0 || cy >= h) return -1
  return cy * w + cx
}

/**
 * `carparkCell`'s arithmetic, split into its two axes — the same expression it
 * has always evaluated, hoisted so `spacingViolated` below can compare carpark
 * COORDINATES without first packing them into a cell index and unpacking them
 * again.
 *
 * **Deliberately without a bounds check and without `validateOrientation`**,
 * which is why they are private. `carparkCell` keeps both, so its contract is
 * unchanged; the one other caller is `spacingViolated`, whose two orientations
 * come from an already-validated candidate and from a stored destination that
 * was validated when it was placed. The `else` arm is W, exactly as it was, and
 * is only reachable for a validated orientation.
 */
function carparkX(destCell: number, orientation: number, w: number): number {
  const x0 = destCell % w
  if (orientation === ORIENTATION_E) return x0 + 3
  if (orientation === ORIENTATION_W) return x0 - 1
  return x0
}
function carparkY(destCell: number, orientation: number, w: number): number {
  const y0 = (destCell / w) | 0
  if (orientation === ORIENTATION_N) return y0 - 1
  if (orientation === ORIENTATION_S) return y0 + 3
  return y0
}

/**
 * True iff `cell` is one of the 6 non-carpark footprint cells of a
 * destination whose origin is `destCell` under `orientation`. Excludes the
 * carpark cell itself (it is a separate, road-legal cell — see the driveway
 * rule in `roads.ts`, the one production caller of this function outside
 * `buildings.ts` itself).
 *
 * Allocation-free, and decomposes both `destCell` and `cell` to x/y before
 * comparing, for the same row-seam reason `carparkCell` documents.
 */
export function isFootprintCell(destCell: number, orientation: number, w: number, cell: number): boolean {
  validateOrientation(orientation)
  const width = footprintWidth(orientation)
  const height = footprintHeight(orientation)
  const x0 = destCell % w
  const y0 = (destCell / w) | 0
  const cx = cell % w
  const cy = (cell / w) | 0
  return cx >= x0 && cx < x0 + width && cy >= y0 && cy < y0 + height
}

/**
 * The minimum Chebyshev (king-move) distance between two axis-aligned boxes,
 * given as inclusive `[x0, x1] x [y0, y1]`.
 *
 * `min over cells of max(|dx|, |dy|)` is `max(gapX, gapY)`, where each gap is
 * the separation along that axis or 0 if the projections overlap. Derived
 * rather than sampled, and pinned against the retired pairwise implementation
 * exhaustively in `buildings.test.ts` — a rewrite of a heavily-tested
 * predicate owes a proof, and "it passes the existing tests" is not one when
 * the existing tests were written against the other algorithm.
 *
 * No `Math` calls — plain comparisons, matching this codebase's existing style
 * (roads.ts, graph.ts), and allocation-free like everything else on this path.
 */
function boxChebyshev(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): number {
  let gx = 0
  if (bx0 > ax1) gx = bx0 - ax1
  else if (ax0 > bx1) gx = ax0 - bx1
  let gy = 0
  if (by0 > ay1) gy = by0 - ay1
  else if (ay0 > by1) gy = ay0 - by1
  return gx > gy ? gx : gy
}

/**
 * True iff a destination at `(aCell, aOrientation)` sits closer than
 * Chebyshev 2 to one at `(bCell, bOrientation)` — the §5.9 spacing rule, over
 * four box pairs instead of 49 cell pairs and **with no array**.
 *
 * This replaced `allSevenCells` plus a 49-pair loop in M1e Task 4. The old form
 * built a fresh 7-element `number[]` for the candidate and **one more per
 * existing destination** — measured at 1,888 B per `canPlaceDestination` call
 * on the demo board's 18 destinations — and its own doc comment said "never
 * call this from a per-tick path". Task 5 puts it on one, at up to
 * `SPAWN_CANDIDATE_LIMIT * ORIENTATION_COUNT` = 96 calls per attempt.
 *
 * A carpark is a 1x1 box, so all four comparisons are the same call. Both
 * directions of the footprint-vs-carpark pair are present and they are NOT
 * symmetric inputs: an earlier defect in this file survived all 366 tests
 * because a compound mutation was applied to one side of a symmetric
 * comparison only.
 *
 * @internal Exported for the exhaustive equivalence proof in `buildings.test.ts`
 * only — this is not part of the module's public surface, on the precedent of
 * `assertPlaceCost` (roads.ts).
 */
export function spacingViolated(
  aCell: number,
  aOrientation: number,
  bCell: number,
  bOrientation: number,
  w: number,
): boolean {
  const ax0 = aCell % w
  const ay0 = (aCell / w) | 0
  const ax1 = ax0 + footprintWidth(aOrientation) - 1
  const ay1 = ay0 + footprintHeight(aOrientation) - 1
  const bx0 = bCell % w
  const by0 = (bCell / w) | 0
  const bx1 = bx0 + footprintWidth(bOrientation) - 1
  const by1 = by0 + footprintHeight(bOrientation) - 1
  const acx = carparkX(aCell, aOrientation, w)
  const acy = carparkY(aCell, aOrientation, w)
  const bcx = carparkX(bCell, bOrientation, w)
  const bcy = carparkY(bCell, bOrientation, w)
  if (boxChebyshev(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) < 2) return true
  if (boxChebyshev(ax0, ay0, ax1, ay1, bcx, bcy, bcx, bcy) < 2) return true
  if (boxChebyshev(acx, acy, acx, acy, bx0, by0, bx1, by1) < 2) return true
  if (boxChebyshev(acx, acy, acx, acy, bcx, bcy, bcx, bcy) < 2) return true
  return false
}

export type BuildingPlaceFailure =
  | 'out-of-bounds'
  | 'terrain'
  | 'tree'
  | 'road'
  | 'spacing'
  | 'building'
  | 'capacity'

export type PlaceCheck = { readonly ok: true } | { readonly ok: false; readonly reason: BuildingPlaceFailure }

/**
 * Every `canPlaceDestination`/`canPlaceHouse` outcome is a module-scope frozen
 * singleton, exactly as `canPlaceRoad`'s are (`roads.ts:303-319`) and for the
 * same measured reason: the object literal these functions used to return
 * ESCAPES — both are far too large for V8 to inline, so scalar replacement
 * cannot delete it — and M1d measured the identical literal in `canPlaceRoad`
 * at 40.6-44.3 B per call, which is why that function carried a `'roads.ts':
 * 128` known-violation budget until it was fixed this way. **Measured here
 * before the fix: `canPlaceHouse` 40.0 B/call**, the same literal at the same
 * price, on the demo board.
 *
 * M1e Task 5 puts BOTH of these on a per-tick path at up to
 * `SPAWN_CANDIDATE_LIMIT * ORIENTATION_COUNT` = 96 calls per destination
 * attempt. Removing the cell arrays (`spacingViolated`, above) does not remove
 * this; it is a separate allocation with a separate fix, and reporting the
 * first as "Task 4 made placement allocation-free" without the second is how a
 * green harness comes to be a claim about the wrong thing.
 *
 * **What pins this, since the obvious answer is wrong.** No test compares a
 * `PlaceCheck` by identity by accident, and the allocation harness on the demo
 * FRAME loop cannot see either function at all — neither has a per-frame caller
 * until Task 5, measured as `buildings.ts` absent from 9 of 9 profile windows
 * with an escaping allocation injected at the top of both. The detectors are
 * `buildings.test.ts`'s frozen/identity block (deterministic, all eight
 * outcomes) and `placementAllocation.test.ts`'s per-CALL rig. Reverting any one
 * `return` below to a literal turns exactly one identity assertion red.
 *
 * `Object.freeze` does not recurse — there is one object per outcome and each
 * is frozen at its own level, which is what the `roads.ts` note means by
 * "every level".
 */
const B_OK = Object.freeze({ ok: true } as const)
const B_OOB = Object.freeze({ ok: false, reason: 'out-of-bounds' } as const)
const B_TERRAIN = Object.freeze({ ok: false, reason: 'terrain' } as const)
const B_TREE = Object.freeze({ ok: false, reason: 'tree' } as const)
const B_ROAD = Object.freeze({ ok: false, reason: 'road' } as const)
const B_SPACING = Object.freeze({ ok: false, reason: 'spacing' } as const)
const B_BUILDING = Object.freeze({ ok: false, reason: 'building' } as const)
const B_CAPACITY = Object.freeze({ ok: false, reason: 'capacity' } as const)

/**
 * Whether `cell` coincides with any existing house cell or lies within any
 * existing destination's 7 cells (footprint + carpark). Shared by both
 * `canPlaceHouse` (a new house must not sit on a building) and
 * `canPlaceDestination` (a new destination must not sit on a house — its
 * destination-vs-destination case is the spacing rule instead, checked
 * separately, since houses have no spacing rule of their own).
 */
function cellOverlapsAnyHouse(state: GameState, cell: number): boolean {
  const houseCount = state.header[H_HOUSE_COUNT] as number
  for (let h = 0; h < houseCount; h++) {
    if ((state.houseCell[h] as number) === cell) return true
  }
  return false
}

function cellOverlapsAnyDestination(state: GameState, world: WorldData, cell: number): boolean {
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    const dCell = state.destCell[d] as number
    const orientation = destMetaOrientation(state.destMeta[d] as number)
    if (isFootprintCell(dCell, orientation, world.w, cell)) return true
    if (carparkCell(dCell, orientation, world.w, world.h) === cell) return true
  }
  return false
}

/**
 * Placement validity for a house (spec §5.2/§5.9): one cell, in bounds,
 * passable, no standing tree, no road, not on any destination's 7 cells, not
 * on another house cell, and `H_HOUSE_COUNT < maxHouses`. Checked in that
 * order; `placeHouse` relies on this being the single source of truth for
 * the capacity gate (no duplicate `<`/`<=` check elsewhere that could drift
 * from this one).
 */
export function canPlaceHouse(state: GameState, world: WorldData, cell: number): PlaceCheck {
  if (!inBounds(cell, world.cells)) return B_OOB
  if (world.passable[cell] !== 1) return B_TERRAIN
  if (hasTree(state, world, cell)) return B_TREE
  if ((state.roads[cell] as number) !== 0) return B_ROAD
  if (cellOverlapsAnyDestination(state, world, cell) || cellOverlapsAnyHouse(state, cell)) {
    return B_BUILDING
  }
  const houseCount = state.header[H_HOUSE_COUNT] as number
  if (houseCount >= world.map.maxHouses) return B_CAPACITY
  return B_OK
}

/**
 * Places a house at `cell` with `colour`, and creates its `CARS_PER_HOUSE`
 * cars (Task 2's job, not Task 4's — fix-list #9: nothing before this task
 * created cars at all). Returns `false` and changes nothing if
 * `canPlaceHouse` would reject it.
 *
 * The new house's car slots — `[h * CARS_PER_HOUSE, (h+1) * CARS_PER_HOUSE)`
 * — have never been written before (houses are append-only, so this range
 * is always past every previous house's cars), and every M1c region starts
 * all-zero. So only the fields that must NOT be zero are written explicitly:
 * `carHome`, `carCell`, `carPhase` (`PHASE_IDLE`, not `PHASE_NONE`), and
 * `carTargetDest` (-1, the "no destination" value — 0 would be destination
 * index 0, a real destination). `carProgress`, `carRouteLen`,
 * `carRouteCursor` and `carRoute` are left at their already-zero default.
 */
export function placeHouse(state: GameState, world: WorldData, cell: number, colour: number): boolean {
  assertColourInRange(colour, world, 'placeHouse')
  const check = canPlaceHouse(state, world, cell)
  if (!check.ok) return false

  const h = state.header[H_HOUSE_COUNT] as number
  state.houseCell[h] = cell
  state.houseColour[h] = colour
  state.header[H_HOUSE_COUNT] = h + 1

  const carBase = h * CARS_PER_HOUSE
  for (let i = 0; i < CARS_PER_HOUSE; i++) {
    const c = carBase + i
    state.carHome[c] = h
    state.carCell[c] = cell
    state.carPhase[c] = PHASE_IDLE
    state.carTargetDest[c] = -1
  }

  return true
}

/**
 * Placement validity for a destination (spec §5.2/§5.9, dossier §1.12): the
 * 6 footprint cells and the carpark cell all in bounds and passable
 * (LAND or TREE), no standing tree on any of the 7, no road on any of the 7,
 * Chebyshev distance >= 2 from every cell of this destination's 7 to every
 * cell of every existing destination's 7, no overlap with any house cell,
 * and `H_DEST_COUNT < maxDestinations`.
 *
 * Destination-vs-destination overlap has no separate check: two footprints
 * sharing a cell means some pair of cells is at Chebyshev distance 0, which
 * the spacing rule (>= 2) already rejects.
 */
export function canPlaceDestination(
  state: GameState,
  world: WorldData,
  destCell: number,
  orientation: number,
): PlaceCheck {
  // **The prologue, in this order, and it is load-bearing.**
  // `validateOrientation` first: a bad orientation is a programming error and
  // must throw rather than be reported as a placement rejection, including when
  // the cell is ALSO bad — which is the only case that can tell the two orders
  // apart, and is what `buildings.test.ts`'s prologue test asserts.
  // `inBounds` second: it is the only `Number.isInteger` check on `destCell` in
  // the codebase, and everything below indexes typed arrays with it.
  validateOrientation(orientation)
  if (!inBounds(destCell, world.cells)) return B_OOB

  const width = footprintWidth(orientation)
  const height = footprintHeight(orientation)
  const x0 = destCell % world.w
  const y0 = (destCell / world.w) | 0
  if (x0 < 0 || x0 + width > world.w || y0 < 0 || y0 + height > world.h) return B_OOB
  const carpark = carparkCell(destCell, orientation, world.w, world.h)
  if (carpark === -1) return B_OOB

  // Three passes over the same 7 cells, in the same order as the retired
  // `allSevenCells` walk (footprint row-major, then the carpark) — though the
  // order inside a pass cannot be observed, since every cell in one pass
  // yields the same reason. The PASSES' order is what is observable, and it is
  // unchanged: terrain, then tree, then road.
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (world.passable[(y0 + dy) * world.w + (x0 + dx)] !== 1) return B_TERRAIN
    }
  }
  if (world.passable[carpark] !== 1) return B_TERRAIN

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (hasTree(state, world, (y0 + dy) * world.w + (x0 + dx))) return B_TREE
    }
  }
  if (hasTree(state, world, carpark)) return B_TREE

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if ((state.roads[(y0 + dy) * world.w + (x0 + dx)] as number) !== 0) return B_ROAD
    }
  }
  if ((state.roads[carpark] as number) !== 0) return B_ROAD

  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    const otherCell = state.destCell[d] as number
    const otherOrientation = destMetaOrientation(state.destMeta[d] as number)
    // No bounds check on the incumbent: every stored destination was itself
    // validated against this exact grid before it was placed, which is the same
    // invariant the retired `allSevenCells(...) as number[]` cast relied on.
    if (spacingViolated(destCell, orientation, otherCell, otherOrientation, world.w)) return B_SPACING
  }

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (cellOverlapsAnyHouse(state, (y0 + dy) * world.w + (x0 + dx))) return B_BUILDING
    }
  }
  if (cellOverlapsAnyHouse(state, carpark)) return B_BUILDING

  if (destCount >= world.map.maxDestinations) return B_CAPACITY

  return B_OK
}

/**
 * Places a destination at `destCell`/`orientation` with `colour`/`kind`.
 * Returns `false` and changes nothing if `canPlaceDestination` would reject
 * it. `destSpawnTick` is stamped from the CURRENT `H_TICK` — Task 3's
 * rotation eligibility gate compares against it.
 *
 * `destPins`/`destReserved` are left at their already-zero default: a
 * freshly placed destination starts with no pins and no reservations.
 */
export function placeDestination(
  state: GameState,
  world: WorldData,
  destCell: number,
  orientation: number,
  colour: number,
  kind: number,
): boolean {
  assertColourInRange(colour, world, 'placeDestination')
  const check = canPlaceDestination(state, world, destCell, orientation)
  if (!check.ok) return false

  const d = state.header[H_DEST_COUNT] as number
  state.destCell[d] = destCell
  state.destMeta[d] = packDestMeta(colour, kind, orientation)
  state.destSpawnTick[d] = state.header[H_TICK] as number
  state.header[H_DEST_COUNT] = d + 1

  return true
}
