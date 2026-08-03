import { TERRAIN } from '@laneways/shared'
import type { GameState } from './state'
import { H_TILES, H_DEST_COUNT } from './state'
import type { WorldData } from './world'
import { isFootprintCell, destMetaOrientation } from './buildings'

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
 * **Erase refunds immediately. There is no delayed refund here.** Spec
 * §5.11's "ghost roads" — a deleted segment stays rendered, thinner, until
 * the last car already committed to it clears — needs cars, which do not
 * exist yet in M1b. This is M1c's problem, deliberately deferred, not
 * forgotten.
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

export type PlaceFailure = 'out-of-bounds' | 'not-adjacent' | 'terrain' | 'building' | 'budget'
export type PlaceResult =
  | { readonly ok: true; readonly cost: number } // 0, 1 or 2 tiles
  | { readonly ok: false; readonly reason: PlaceFailure }

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
    return { ok: false, reason: 'out-of-bounds' }
  }

  const dir = dirBetween(a, b, world.w, world.h)
  if (dir === -1) {
    return { ok: false, reason: 'not-adjacent' }
  }

  // Whitelist on BOTH endpoints, matching `world.passable` (LAND or TREE).
  // Bounds are already checked above, so `world.passable[a]`/`[b]` are real
  // terrain reads here, never `undefined`.
  if (world.passable[a] !== 1 || world.passable[b] !== 1) {
    return { ok: false, reason: 'terrain' }
  }

  // The driveway rule (M1c decision 5): both endpoints are checked, and a
  // destination's 6 non-carpark footprint cells are the only cells this
  // rejects — the house cell and the carpark cell stay placeable.
  if (cellIsDestinationFootprintOnly(state, world, a) || cellIsDestinationFootprintOnly(state, world, b)) {
    return { ok: false, reason: 'building' }
  }

  const maskA = state.roads[a] as number
  const maskB = state.roads[b] as number
  const cost = (maskA === 0 ? 1 : 0) + (maskB === 0 ? 1 : 0)

  // Computed AFTER cost, deliberately: a segment that already exists costs 0
  // (both masks are already non-zero, since the bit toward the other
  // endpoint is set), so this comparison passes even at zero tiles left.
  if (cost > tilesLeft(state)) {
    return { ok: false, reason: 'budget' }
  }

  return { ok: true, cost }
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

  return true
}

/**
 * Erases the road between `a` and `b`, clearing only the two mirrored bits
 * for that one segment — never the whole mask of either cell, which would
 * silently destroy that cell's other segments too. Refunds one tile per
 * endpoint whose mask becomes entirely 0 as a result. A segment that does
 * not exist is a no-op: returns `false`, refunds nothing, changes nothing.
 *
 * The refund is immediate. See the module comment for why a delayed refund
 * (spec §5.11's ghost roads) is out of scope here.
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

  let refund = 0
  if (newMaskA === 0) refund++
  if (newMaskB === 0) refund++

  state.roads[a] = newMaskA
  state.roads[b] = newMaskB
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
