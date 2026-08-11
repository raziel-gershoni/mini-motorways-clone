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
 * weight" — M1c adds none, so 14 is not exceeded here, and an over-large weight
 * would land in a bucket drained at the wrong d and be discarded — wrong
 * answers, no crash. `createScratch` asserts NB > edgeCost(k) for every k.
 *
 * **This comment predicted M1d would exceed it, and M1d did not — corrected
 * rather than repointed, because the prediction was wrong about the MECHANISM
 * and not merely about the milestone.** It read "M1d (chunk/intersection
 * penalties) or M1e (upgrades) will exceed it". M1d Task 7 shipped the
 * intersection penalty and it is **not an edge weight**: `laneSpeedMul`
 * (cars.ts) scales a car's per-tick movement progress and `edgeCost` is
 * untouched, so the value set is still `{10, 14}` and NB was never approached.
 * That was a deliberate choice with its reasons written out in `cars.ts` — a
 * turn penalty is a property of a DIRECTION PAIR, which `edgeCost(dir)` is
 * structurally unable to price. **M1e's upgrade cards remain the live threat**,
 * and a motorway tier is the one that would actually change the value set.
 *
 * **Penalty-routing note, for whoever adds the first penalty.** `NB =
 * DIAG_COST + 1 = 15` is the exact minimum — the instrumented maximum spread
 * of pending distances is 14 (see `computeFlowField`'s module comment) — and
 * `assertBucketCountExceedsEveryEdgeCost` only inspects `edgeCost(k)`. If a
 * penalty is applied INSIDE `computeFlowField` rather than through the cost
 * function, the assert keeps passing while the Dial queue silently aliases
 * two distances into one bucket: wrong paths, no crash. A *per-cell* penalty
 * makes cost depend on more than direction, so `edgeCost(dir)` and
 * everything derived from it (including this constant) goes structurally
 * blind — the signature is the thing that has to change, not just the value.
 */
export const NB = DIAG_COST + 1

/**
 * Distinct values `edgeCost` can return. Sets the entry-pool bound; **M1e's
 * motorway tier makes it 3 — this said M1d's, and M1d shipped without one.**
 * M1d's Out table defers motorways to M1e (they are upgrade CARDS and there is
 * no card mechanism yet), and M1d Task 7's lane-speed multipliers went into
 * movement rather than into `edgeCost`, so this constant is still 2 and the
 * value set is still `{10, 14}`. `graph.test.ts` and `scratch.test.ts` both pin
 * this against `edgeCost`'s real output (see the linkage test in
 * `scratch.test.ts`, added M1c), so adding a cost tier without updating this
 * constant fails a test rather than silently under-sizing the pool.
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
  builtFromFieldInputs: number // nonZeroWord(hashFieldInputRegions(state, ranges) | 0), or 0 if never built
  builtFromSources: number // nonZeroWord(hashSources(sourcesFlat, offset, count) | 0), or 0 if never built
}

/**
 * Allocation and cross-call state for pathfinding, source assembly and
 * instrumentation, all deliberately OUTSIDE the state buffer and outside
 * every hash — none of this is replay state; it is all re-derivable from
 * `state`/`world` alone (design decision 3, M1b).
 *
 * Members split by lifetime, since M1c mixes two shapes that used to be one:
 *
 *   - Pathfinding scratch (`bucketHead` ... `stats`, `cursor`,
 *     `pushesPerCell`): fully overwritten at the entry of every
 *     `computeFlowField` call; carries nothing between calls. `cursor` is the
 *     newest member and the one whose reset is load-bearing rather than
 *     hygienic: it holds the queue's own bump pointer and undrained count, so
 *     a value carried in from a previous call (which a rebuild that THREW
 *     mid-drain really does leave behind — see `syncFields`) would corrupt the
 *     next call's queue rather than merely misreport it.
 *   - Source buffers (`sourcesFlat`, `sourceCounts`, `slotCounts`): rewritten
 *     in full by whatever assembles sources each tick (M1c Task 4's
 *     dispatch); NOT reset by `computeFlowField` itself, since they are its
 *     input, not its scratch.
 *   - `counters` (`CT_SYNCS`, `CT_REBUILDS`, `CT_BLOCKED_PUSH_DISCARDED`):
 *     cumulative across the whole run,
 *     never reset by anything — unlike `stats`, which is documented as
 *     carrying nothing between calls, these exist specifically to answer
 *     "did a sync happen this tick" and "did anything rebuild this tick" as
 *     direct positive assertions.
 *   - `fieldInputRanges`: built ONCE, at boot (`createFieldInputRanges`,
 *     regions.ts), and never rewritten — the layout-derived staleness key
 *     `hashFieldInputRegions` walks every tick.
 */
export interface Scratch {
  readonly bucketHead: Int32Array // NB
  readonly entryCell: Int32Array // entryPoolCapacity(cells)
  readonly entryNext: Int32Array // entryPoolCapacity(cells)
  readonly nbrCell: Int32Array // DIR_COUNT
  readonly nbrDir: Int8Array // DIR_COUNT
  readonly stats: Int32Array // ST_EXPANSIONS, ST_PUSHES
  readonly cursor: Int32Array // CUR_TOP, CUR_PENDING — computeFlowField's queue cursor, overwritten at every call entry
  readonly pushesPerCell: Int32Array // cells; reset per computeFlowField call, incremented in push
  readonly sourcesFlat: Int32Array // groupCount * maxDestinations; colour c occupies [c*maxDestinations, c*maxDestinations + sourceCounts[c])
  readonly sourceCounts: Int32Array // groupCount
  readonly slotCounts: Int32Array // groupCount; Task 3's accumulator input
  readonly counters: Int32Array // CT_SYNCS, CT_REBUILDS, CT_BLOCKED_PUSH_DISCARDED — cumulative, never reset
  readonly fieldInputRanges: Int32Array // (byteOffset, byteLength) pairs, one per FIELD_INPUT region
}

export const ST_EXPANSIONS = 0
export const ST_PUSHES = 1
const STATS_LENGTH = 2

export const CT_SYNCS = 0
export const CT_REBUILDS = 1
/**
 * §5.3.5 pushes that found no eligible destination of their colour and were
 * therefore DISCARDED (`pushBlockedSpawnDemand`, demand.ts). In `scratch` and
 * not in the state buffer deliberately: no golden can see it, it costs no
 * replay bytes, and it is a counter about a rule rather than about the game.
 */
export const CT_BLOCKED_PUSH_DISCARDED = 2
const COUNTERS_LENGTH = 3

/**
 * `computeFlowField`'s queue cursor: `CUR_TOP` is the entry pool's bump
 * pointer, `CUR_PENDING` the number of entries pushed but not yet drained.
 *
 * **Two slots, never one.** `push` advances both, and the drain loop reads only
 * `CUR_PENDING`; aliasing them to one index makes every push count as a drain
 * and the queue empties itself while the pool never grows.
 */
export const CUR_TOP = 0
export const CUR_PENDING = 1
const CURSOR_LENGTH = 2

/**
 * `entryPoolCapacity(cells) = cells * (1 + DISTINCT_EDGE_COSTS)`: one push
 * per distinct edge-cost value a cell can be improved by, plus one source
 * insertion. Conservative by construction — a source cell can never also be
 * improvement-pushed, since its distance (0) can never improve — and it is
 * the formulation that survives M1e's motorway ÷3 tier and flags M1e's
 * traffic-light penalties as requiring a revisit (both change
 * `DISTINCT_EDGE_COSTS`, which this derives from rather than a literal). M1c
 * adds neither, and **M1d added neither either** — its intersection penalty is a
 * movement multiplier rather than an edge weight, so the value set never moved.
 * See `NB` above, where the same prediction was made and is now refuted.
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
    builtFromFieldInputs: 0,
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
/**
 * `cells`, `groupCount` and `maxDestinations` size the source buffers;
 * `fieldInputRanges` (built once, at boot, by `createFieldInputRanges` —
 * regions.ts) is stored as-is, never recomputed here or on any later call —
 * see that function's own comment for why recomputing it per tick would
 * violate "nothing allocates inside a tick".
 *
 * Deliberately `createScratch(cells, groupCount, maxDestinations,
 * fieldInputRanges)`, not `createScratch(map)`: this keeps `scratch.test.ts`
 * free to pass a doctored huge `cells` to exercise the `cells * DIAG_COST >=
 * INF` guard without allocating a real `MapData`.
 */
export function createScratch(
  cells: number,
  groupCount: number,
  maxDestinations: number,
  fieldInputRanges: Int32Array,
): Scratch {
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
    // Sized from `DIR_COUNT` (roads.ts owns that count), not a literal `8` —
    // a second hardcoded copy of the direction count is exactly how the two
    // would silently drift if `DIR_COUNT` ever changed.
    nbrCell: new Int32Array(DIR_COUNT),
    nbrDir: new Int8Array(DIR_COUNT),
    stats: new Int32Array(STATS_LENGTH),
    cursor: new Int32Array(CURSOR_LENGTH),
    pushesPerCell: new Int32Array(cells),
    sourcesFlat: new Int32Array(groupCount * maxDestinations),
    sourceCounts: new Int32Array(groupCount),
    slotCounts: new Int32Array(groupCount),
    counters: new Int32Array(COUNTERS_LENGTH),
    fieldInputRanges,
  }
}
