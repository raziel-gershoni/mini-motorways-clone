import { ORTHO_COST, DIAG_COST } from '@laneways/shared'
import type { GameState } from './state'
import type { WorldData } from './world'
import { DIR_COUNT, DX, DY, dirBetween } from './roads'

/**
 * A thin, read-only layer over the roads Task 3 writes: neighbour queries
 * and edge costs. Task 5's flow field is the sole consumer. Nothing here
 * mutates `state` or `world`, and nothing here allocates — `neighbours`
 * fills caller-provided `Int32Array`/`Int8Array` scratch so a flow-field
 * relaxation loop (one run per colour per tick, per design decision 3) never
 * allocates per neighbour query.
 *
 * **`neighbours` does not re-filter impassable terrain — a deliberate
 * decision, not an oversight.** `placeRoad` (roads.ts) already checks
 * `world.passable` on both endpoints before it ever sets a bit, so a road
 * bit can only ever point at a cell that was passable at placement time (and
 * terrain never changes after — `world.terrain` is immutable per map, see
 * world.ts). Re-checking `passable` here would be a second guard for the
 * same invariant `placeRoad` already owns: if it ever failed, silently
 * dropping the bad neighbour here would hide a road-placement bug behind a
 * pathfinding no-op instead of surfacing it where it actually happened.
 * Instead, the invariant is asserted directly and honestly, in
 * graph.test.ts's randomised property test: every neighbour `neighbours`
 * ever returns, across a large seeded placement sequence driven exclusively
 * through `placeRoad`, has `passable === 1`. That is the cheap way to keep
 * "already guaranteed elsewhere" from rotting into "was never true", without
 * paying for a second guard on every relaxation.
 */

/**
 * Fills `outCell[0..n)` with connected neighbour cell indices and `outDir[0..n)`
 * with the direction index taken to reach each, both in ascending DIRS order.
 * Returns n. Both arrays are caller-provided and sized 8.
 *
 * A road bit is only followed if its target is in `x` AND `y` bounds — never
 * `0 <= ni < cells`, which would admit the row seam (the grid's right edge
 * wrapping to the next row's left edge) as a false neighbour. Every bit
 * `placeRoad` ever creates already satisfies this (it validates adjacency
 * via `dirBetween` before writing), but a bit written directly into
 * `state.roads` — bypassing `placeRoad`, as a corrupted or hand-built state
 * might — must still not be walked off the grid. The bounds guard below is
 * reachable only through that direct-write path; see graph.test.ts's "bounds
 * guard" tests, which write the byte directly for exactly this reason.
 */
export function neighbours(
  state: GameState,
  world: WorldData,
  cell: number,
  outCell: Int32Array,
  outDir: Int8Array,
): number {
  const { w, h } = world
  const x = cell % w
  const y = (cell / w) | 0
  const mask = state.roads[cell] as number

  let n = 0
  for (let k = 0; k < DIR_COUNT; k++) {
    if ((mask & (1 << k)) === 0) continue
    const nx = x + (DX[k] as number)
    const ny = y + (DY[k] as number)
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
    outCell[n] = ny * w + nx
    outDir[n] = k
    n++
  }
  return n
}

/**
 * ORTHO_COST for the four orthogonals, DIAG_COST for the four diagonals.
 * Throws for anything outside `[0, DIR_COUNT)`, including non-integers.
 *
 * Orthogonal vs diagonal is read off the direction table itself — exactly
 * one of `DX[dir]`/`DY[dir]` is 0 for an orthogonal, neither is 0 for a
 * diagonal — rather than assumed from DIRS happening to alternate by parity
 * of `dir`. `ORTHO_COST`/`DIAG_COST` are imported from `@laneways/shared`,
 * never redeclared: they are already covered by that package's `ALL`
 * registry test, and a second copy here would be a second source of truth a
 * balance change could silently miss.
 */
export function edgeCost(dir: number): number {
  if (!Number.isInteger(dir) || dir < 0 || dir >= DIR_COUNT) {
    throw new Error(`edgeCost: direction index out of range, got ${dir}`)
  }
  const isOrthogonal = (DX[dir] as number) === 0 || (DY[dir] as number) === 0
  return isOrthogonal ? ORTHO_COST : DIAG_COST
}

/**
 * Whether `a` carries a road bit specifically toward `b` — not merely
 * whether both cells carry roads toward *something*.
 * `roadMask(a) !== 0 && roadMask(b) !== 0` is symmetric by construction and
 * would misreport two cells as connected merely because each happens to
 * have an unrelated road elsewhere; this checks the one bit that actually
 * means "a road leaves a toward b." `dirBetween` returning -1 (not adjacent,
 * out of bounds, or `a === b`) short-circuits to `false` before any bit is
 * read.
 */
export function isConnected(state: GameState, world: WorldData, a: number, b: number): boolean {
  const dir = dirBetween(a, b, world.w, world.h)
  if (dir === -1) return false
  return ((state.roads[a] as number) & (1 << dir)) !== 0
}
