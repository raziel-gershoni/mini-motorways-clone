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
 * structurally unable to price. **M1e did not exceed it either, and this
 * comment has now made the same wrong prediction twice**: the upgrade CARDS it
 * named need a card mechanism, and M1e shipped only §5.10's tile grant (see
 * `WEEKLY_TILE_GRANT` in `shared/constants.ts` for why the modal is M1f's). So
 * `DISTINCT_EDGE_COSTS` is still 2 and the value set is still `{10, 14}`.
 * **M1f's motorway tier is the live threat** — it is the one item in the §5.10
 * table that changes the value set rather than a speed multiplier, and it
 * arrives with the card mechanism that makes any of them placeable.
 *
 * ---------------------------------------------------------------------------
 * PENALTY-ROUTING NOTE, FOR WHOEVER ADDS THE FIRST PENALTY
 * ---------------------------------------------------------------------------
 *
 * Three things, and the first one is a correction.
 *
 * **1. `NB = DIAG_COST + 1 = 15` is NOT the exact minimum. The minimum is
 * `DIAG_COST = 14`, and the `+ 1` is one bucket of slack in the safe
 * direction.** An earlier version of this note said "the exact minimum, with
 * zero slack — not a comfortable margin", which was itself a correction of a
 * worse claim (that pending distances "differ by at most `DIAG_COST -
 * ORTHO_COST` (4)", a 3.5x overestimate of headroom). The 14 is right and the
 * conclusion drawn from it was off by one. The bound is
 * `M >= max edge cost`, derived rather than measured: while bucket `d` drains,
 * every push has distance `x` in `[d, d + DIAG_COST]`, and bucket `x % M` must
 * next be drained at iteration exactly `x`. The next iteration `>= d` congruent
 * to `x` is `d + ((x - d) mod M)`, so the requirement is `x - d <= M`, not
 * `x - d < M` — because `x - d = M` lands in the CURRENT bucket, which
 * `computeFlowField` has already detached (`bucketHead[b] = -1` is written
 * before the walk, so the entry sits in a freshly-emptied bucket and is drained
 * on its next visit, at `d + M = x`).
 *
 * Measured over the canonical whole-suite invocation (1,833 tests), mutating
 * only the modulus and leaving `NB` alone so `createScratch`'s assert does not
 * pre-empt the queue:
 *
 * ```
 *   d % 14   0 detectors                 a genuine equivalent mutant
 *   d % 13   31, incl. the field golden  the first modulus that aliases
 *   d % 16   1, and it is `createScratch allocates bucketHead sized NB`
 *   NB = 16  1, and it is `NB is exactly one more than the largest edge cost`
 * ```
 *
 * i.e. **everything at or above 14 is behaviourally inert, and the only things
 * that notice 16 are a structural pin and a constant pin.** 13 aliases exactly
 * as this note's second paragraph describes: a push at `d + 14` lands in the
 * bucket drained at `d + 1`, where the drain loop's `dist[cur] !== d` staleness
 * check DISCARDS it and decrements `CUR_PENDING` — wrong paths, no crash.
 *
 * **What the spare bucket actually buys, since "slack" on its own is not a
 * reason to keep it: independence from the detach ordering, and that was
 * measured too.** Move `bucketHead[b] = -1` from before the walk to after it
 * and at modulus 15 it is a **0-detector no-op across all 1,833 tests** — no
 * push during `d`'s own walk can target `d % 15` at all. Do the same at modulus
 * 14 and `computeFlowField` **does not terminate**: the `d + 14` pushes land in
 * the bucket the trailing clear then discards, `CUR_PENDING` never falls to 0,
 * and the drain loop spins (`flowfield.test.ts` alone, which normally finishes
 * in 0.55 s, produced no output in 70 s and had to be killed). So at 14 the
 * queue's correctness is a joint property of the modulus AND one statement's
 * position; at 15 it is a property of the modulus alone. **Keep the `+ 1`, and
 * size any future NB as `maxEdgeCost + 1` for the same reason** — not because
 * `maxEdgeCost` would be wrong, but because it would be correct for a reason
 * nobody re-derives when they touch the drain loop.
 *
 * **2. The assert cannot see a penalty applied inside the pathfinder.**
 * `assertBucketCountExceedsEveryEdgeCost` only inspects `edgeCost(k)`. If a
 * penalty is applied INSIDE `computeFlowField` rather than through the cost
 * function, the assert keeps passing while the Dial queue silently aliases two
 * distances into one bucket — the `d % 13` row above is what that looks like:
 * wrong paths, no crash, and 31 tests that all fail for reasons that read like
 * a routing regression rather than a queue bug.
 *
 * **3. A per-CELL penalty changes the signature, not the value.** It makes cost
 * depend on more than direction, so `edgeCost(dir)` and everything derived from
 * it (this constant, `DISTINCT_EDGE_COSTS`, `entryPoolCapacity`,
 * `COST_UNIT_SCALE`, `CAR_SPEED_UNITS_PER_TICK`) goes structurally blind. And
 * note what else it would break, which is the whole of Task 11's detector: a
 * per-cell penalty keyed on OCCUPANCY is forbidden outright by spec §1/§6, and
 * `flowfield.test.ts`'s congestion-blindness arms exist to fail loudly if one
 * is ever added.
 */
export const NB = DIAG_COST + 1

/**
 * Distinct values `edgeCost` can return. Sets the entry-pool bound; **M1f's
 * motorway tier makes it 3 — this said M1d's, then M1e's, and neither shipped
 * one.** M1d's Out table deferred motorways to M1e because they are upgrade
 * CARDS with no card mechanism; M1e shipped §5.10's tile grant and left the
 * two-card choice — and therefore every item card — to M1f, so the deferral
 * moved with it rather than being discharged. M1d Task 7's lane-speed
 * multipliers and M1e Task 7's overcrowd meter both went somewhere other than
 * `edgeCost`, so this constant is still 2 and the value set is still
 * `{10, 14}`. `graph.test.ts` and `scratch.test.ts` both pin this against
 * `edgeCost`'s real output (see the linkage test in `scratch.test.ts`, added
 * M1c), so adding a cost tier without updating this constant fails a test
 * rather than silently under-sizing the pool.
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
 * the formulation that survives M1f's motorway ÷3 tier and flags M1f's
 * traffic-light penalties as requiring a revisit (both change
 * `DISTINCT_EDGE_COSTS`, which this derives from rather than a literal). M1c
 * added neither, **M1d added neither** — its intersection penalty is a movement
 * multiplier rather than an edge weight — and **M1e added neither**, because
 * both items are cards and the card modal is M1f's. See `NB` above, where the
 * same prediction has now been made and refuted twice.
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
