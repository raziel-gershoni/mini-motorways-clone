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
 */
function footprintWidth(orientation: number): number {
  return orientation === ORIENTATION_N || orientation === ORIENTATION_S ? 2 : 3
}
function footprintHeight(orientation: number): number {
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
  const x0 = destCell % w
  const y0 = (destCell / w) | 0
  let cx = x0
  let cy = y0
  if (orientation === ORIENTATION_N) {
    cy = y0 - 1
  } else if (orientation === ORIENTATION_S) {
    cy = y0 + 3
  } else if (orientation === ORIENTATION_E) {
    cx = x0 + 3
  } else {
    cx = x0 - 1 // ORIENTATION_W
  }
  if (cx < 0 || cx >= w || cy < 0 || cy >= h) return -1
  return cy * w + cx
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
 * All 7 cells of a destination (6 footprint + 1 carpark), or `null` if the
 * footprint's bounding box or the carpark itself does not fit on the `world`
 * grid. Allocates one 7-element array — never call this from a per-tick
 * path; it exists only for placement validity (below), which runs once per
 * placement action, not once per tick.
 */
function allSevenCells(destCell: number, orientation: number, world: WorldData): number[] | null {
  const width = footprintWidth(orientation)
  const height = footprintHeight(orientation)
  const x0 = destCell % world.w
  const y0 = (destCell / world.w) | 0
  if (x0 < 0 || x0 + width > world.w || y0 < 0 || y0 + height > world.h) return null

  const carpark = carparkCell(destCell, orientation, world.w, world.h)
  if (carpark === -1) return null

  const out: number[] = []
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      out.push((y0 + dy) * world.w + (x0 + dx))
    }
  }
  out.push(carpark)
  return out
}

/** Chebyshev (king-move) distance between two cells on a `w`-wide grid. No `Math` calls — plain comparisons, matching this codebase's existing style (roads.ts, graph.ts). */
function chebyshevDistance(aCell: number, bCell: number, w: number): number {
  const ax = aCell % w
  const ay = (aCell / w) | 0
  const bx = bCell % w
  const by = (bCell / w) | 0
  const dx = ax > bx ? ax - bx : bx - ax
  const dy = ay > by ? ay - by : by - ay
  return dx > dy ? dx : dy
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
  if (!inBounds(cell, world.cells)) return { ok: false, reason: 'out-of-bounds' }
  if (world.passable[cell] !== 1) return { ok: false, reason: 'terrain' }
  if (hasTree(state, world, cell)) return { ok: false, reason: 'tree' }
  if ((state.roads[cell] as number) !== 0) return { ok: false, reason: 'road' }
  if (cellOverlapsAnyDestination(state, world, cell) || cellOverlapsAnyHouse(state, cell)) {
    return { ok: false, reason: 'building' }
  }
  const houseCount = state.header[H_HOUSE_COUNT] as number
  if (houseCount >= world.map.maxHouses) return { ok: false, reason: 'capacity' }
  return { ok: true }
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
  validateOrientation(orientation)
  if (!inBounds(destCell, world.cells)) return { ok: false, reason: 'out-of-bounds' }

  const cells = allSevenCells(destCell, orientation, world)
  if (cells === null) return { ok: false, reason: 'out-of-bounds' }

  for (let i = 0; i < cells.length; i++) {
    if (world.passable[cells[i] as number] !== 1) return { ok: false, reason: 'terrain' }
  }
  for (let i = 0; i < cells.length; i++) {
    if (hasTree(state, world, cells[i] as number)) return { ok: false, reason: 'tree' }
  }
  for (let i = 0; i < cells.length; i++) {
    if ((state.roads[cells[i] as number] as number) !== 0) return { ok: false, reason: 'road' }
  }

  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    const otherCell = state.destCell[d] as number
    const otherOrientation = destMetaOrientation(state.destMeta[d] as number)
    // `allSevenCells` cannot return null here: every stored destination was
    // itself validated against this exact grid before it was placed.
    const otherCells = allSevenCells(otherCell, otherOrientation, world) as number[]
    for (let i = 0; i < cells.length; i++) {
      for (let j = 0; j < otherCells.length; j++) {
        if (chebyshevDistance(cells[i] as number, otherCells[j] as number, world.w) < 2) {
          return { ok: false, reason: 'spacing' }
        }
      }
    }
  }

  for (let i = 0; i < cells.length; i++) {
    if (cellOverlapsAnyHouse(state, cells[i] as number)) return { ok: false, reason: 'building' }
  }

  if (destCount >= world.map.maxDestinations) return { ok: false, reason: 'capacity' }

  return { ok: true }
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
  const check = canPlaceDestination(state, world, destCell, orientation)
  if (!check.ok) return false

  const d = state.header[H_DEST_COUNT] as number
  state.destCell[d] = destCell
  state.destMeta[d] = packDestMeta(colour, kind, orientation)
  state.destSpawnTick[d] = state.header[H_TICK] as number
  state.header[H_DEST_COUNT] = d + 1

  return true
}
