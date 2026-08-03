import { DIAG_COST } from '@laneways/shared'
import { DIR_COUNT } from './roads'
import { edgeCost } from './graph'

/**
 * Allocation and cross-run scratch for Task 5's flow fields — split from
 * `flowfield.ts` so the pure allocation/sizing concerns (this file) are
 * separable from the pathfinding algorithm and staleness logic
 * (`flowfield.ts`), which import from here.
 *
 * `createFlowField`/`createFlowFields`/`createScratch` allocate; nothing in
 * `flowfield.ts`'s `computeFlowField` does — see that file's module comment.
 */

/**
 * Unreachable marker. 0x40000000 rather than the spike's 0x7fffffff so that
 * `INF + DIAG_COST` stays a positive Int32; the spike's value overflows to
 * negative, which compares as "better" and would silently relax through
 * unreachable cells if a guard were ever dropped. Also >> any real distance:
 * `createScratch` asserts `cells * DIAG_COST < INF`.
 */
export const INF = 0x40000000

/**
 * Dial's cyclic bucket count. Correct only while NB > every edge cost; §5.4
 * promises intersection and traffic-light penalties "as extra integer edge
 * weight", so 14 will be exceeded in M1c, and an over-large weight lands in a
 * bucket drained at the wrong d and is discarded — wrong answers, no crash.
 * `createScratch` asserts NB > edgeCost(k) for every k.
 */
export const NB = DIAG_COST + 1

/**
 * Distinct values `edgeCost` can return. Sets the entry-pool bound; M1d's
 * motorway tier makes it 3. Task 4 tests that edgeCost yields exactly this
 * many distinct values, so adding a tier without updating this fails a test.
 */
export const DISTINCT_EDGE_COSTS = 2

/**
 * Per-colour, persistent, derived. Fully overwritten on every rebuild.
 *
 * The two stamps are the whole of staleness detection (design decision 3):
 * both are 0 on a fresh field and non-zero once built, and 0 can never be a
 * real stamp, so "never built" is not mistakable for "fresh". That matters
 * because a fresh field's `dir` is all-zero, which reads as "head North".
 */
export interface FlowField {
  readonly dist: Int32Array // weighted distance to the nearest source, or INF
  readonly dir: Int8Array // direction index toward a source; -1 at sources and unreachable cells
  builtFromRoads: number // nonZeroWord(hashBytes(state.roads) | 0), or 0 if never built
  builtFromSources: number // nonZeroWord(hashSources(sources) | 0), or 0 if never built
}

/** Shared, transient. Fully overwritten at entry; carries nothing between calls. */
export interface Scratch {
  readonly bucketHead: Int32Array // NB
  readonly entryCell: Int32Array // entryPoolCapacity(cells)
  readonly entryNext: Int32Array // entryPoolCapacity(cells)
  readonly nbrCell: Int32Array // 8
  readonly nbrDir: Int8Array // 8
  readonly stats: Int32Array // ST_EXPANSIONS, ST_PUSHES
}

export const ST_EXPANSIONS = 0
export const ST_PUSHES = 1
const STATS_LENGTH = 2

/**
 * `entryPoolCapacity(cells) = cells * (1 + DISTINCT_EDGE_COSTS)`: one push
 * per distinct edge-cost value a cell can be improved by, plus one source
 * insertion. Conservative by construction — a source cell can never also be
 * improvement-pushed, since its distance (0) can never improve — and it is
 * the formulation that survives M1d's motorway ÷3 tier and flags M1c's
 * intersection penalties as requiring a revisit (both change
 * `DISTINCT_EDGE_COSTS`, which this derives from rather than a literal).
 *
 * The reviewed draft's `cells * 9` bound ("8 relaxations per cell plus one
 * source insertion") was wrong in both directions: expansions occur in
 * nondecreasing distance, so a second improvement to a cell requires a
 * strictly smaller edge cost, which with two distinct cost values bounds
 * pushes at 2 per non-source cell, not 8. Measured over 400 random road
 * graphs: maximum per-cell pushes exactly 2, total peaking at 1.15x cells —
 * comfortably inside `cells * 3`.
 */
export function entryPoolCapacity(cells: number): number {
  return cells * (1 + DISTINCT_EDGE_COSTS)
}

export function createFlowField(cells: number): FlowField {
  return {
    dist: new Int32Array(cells),
    dir: new Int8Array(cells),
    builtFromRoads: 0,
    builtFromSources: 0,
  }
}

export function createFlowFields(colours: number, cells: number): FlowField[] {
  return Array.from({ length: colours }, () => createFlowField(cells))
}

/**
 * Throws unless `nb` strictly exceeds `edgeCostOf(k)` for every `k` in
 * `[0, dirCount)`. Takes `nb`/`edgeCostOf` as parameters — rather than
 * closing over `NB`/`edgeCost` directly — specifically so the failure path
 * is testable without editing a module constant: scratch.test.ts calls this
 * directly with a doctored `nb` (e.g. `DIAG_COST` itself) to prove the throw
 * actually fires, rather than only asserting that today's real `NB` happens
 * to be safe.
 *
 * @internal Exported for testing only; `createScratch` is the real call site.
 */
export function assertBucketCountExceedsEveryEdgeCost(
  nb: number,
  dirCount: number,
  edgeCostOf: (dir: number) => number,
): void {
  for (let k = 0; k < dirCount; k++) {
    const cost = edgeCostOf(k)
    if (nb <= cost) {
      throw new Error(
        `assertBucketCountExceedsEveryEdgeCost: NB (${nb}) does not exceed edgeCost(${k}) = ${cost}; ` +
          'a bucket queue with NB <= some edge cost aliases two different real distances into one bucket.',
      )
    }
  }
}

/**
 * `createFlowField`/`createScratch` allocate inside the function, sized from
 * `cells` alone — never a module-scope constant (Task 1's AST rule; a
 * reusable scratch buffer at module scope is exactly the shape this
 * milestone's determinism rules exist to forbid).
 *
 * Two invariants are asserted here, both from the module comments above,
 * both checked BEFORE any allocation so a doctored `cells` large enough to
 * trip the second one throws immediately rather than attempting a huge
 * typed-array allocation:
 *
 *   - `NB` must exceed every `edgeCost(k)`, or Dial's cyclic bucket queue
 *     aliases two different real distances into the same bucket.
 *   - `cells * DIAG_COST` must stay below `INF`, or the maximum possible
 *     real distance on this board could reach or exceed the "unreachable"
 *     marker, making a genuinely reachable cell indistinguishable from one
 *     that is not.
 */
export function createScratch(cells: number): Scratch {
  assertBucketCountExceedsEveryEdgeCost(NB, DIR_COUNT, edgeCost)
  if (cells * DIAG_COST >= INF) {
    throw new Error(
      `createScratch: cells * DIAG_COST (${cells * DIAG_COST}) must stay below INF (${INF})`,
    )
  }
  const cap = entryPoolCapacity(cells)
  return {
    bucketHead: new Int32Array(NB),
    entryCell: new Int32Array(cap),
    entryNext: new Int32Array(cap),
    nbrCell: new Int32Array(8),
    nbrDir: new Int8Array(8),
    stats: new Int32Array(STATS_LENGTH),
  }
}
