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
 * Dial's cyclic bucket count. Correct only while NB > every edge cost. An
 * over-large weight would land in a bucket drained at the wrong d and be
 * discarded — wrong answers, no crash. `createScratch` asserts NB > edgeCost(k)
 * for every k, and `assertPushWithinBucketWindow` below asserts the same window
 * on the relaxation itself.
 *
 * **This used to open by quoting §5.4's promise of intersection and
 * traffic-light penalties "as extra integer edge weight". That clause is
 * REFUSED** — see the 2026-08-21 amendment to §5.4. Path cost is a function of
 * the DIRECTION of a step and of nothing else, so no junction or light can ever
 * be the thing that exceeds NB; only a tier on the step itself can.
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
 * **M1g's motorway tier is the live threat** — it is the one item in the §5.10
 * table that changes the value set rather than a speed multiplier. It was dated
 * M1f here and M1f shipped no motorway: the milestone spent its card slot on the
 * junction upgrade, and the motorway was never in its scope.
 *
 * **Third wrong prediction, and this one is worth counting.** This comment has
 * now named M1d, M1e and M1f as the milestone that would exceed NB, and none of
 * them did. The reason is structural rather than lucky and it is now written
 * down in the spec: junction and traffic-light cost is not edge weight
 * (amendment, 2026-08-21), so the only thing that can change the VALUE SET is a
 * tier on the step itself — the motorway's divide-by-three. Until a motorway
 * ships, `DISTINCT_EDGE_COSTS` is 2 and the set is {10, 14}. M1f Task 1 also
 * added `assertPushWithinBucketWindow`, whose SECOND arm catches an added term of
 * +1 that the modulus bound alone would accept, so a fourth wrong prediction is
 * a throw rather than a wrong path.
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
 * **2. The assert cannot see a penalty applied inside the pathfinder — and as
 * of M1f Task 1 a second one can.** `assertBucketCountExceedsEveryEdgeCost` only
 * inspects `edgeCost(k)`. If a penalty is applied INSIDE `computeFlowField`
 * rather than through the cost function, the assert keeps passing while the Dial
 * queue silently aliases two distances into one bucket — the `d % 13` row above
 * is what that looks like: wrong paths, no crash, and 31 tests that all fail for
 * reasons that read like a routing regression rather than a queue bug.
 * `assertPushWithinBucketWindow` below is the mechanism that closes it: it runs
 * on the relaxation itself, where the added term would be, and it has a second
 * arm because the modulus bound alone accepts a surcharge of +1 on a diagonal.
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
 * A bitmask with bit `c` set for every value `edgeCostOf` can return over
 * `[0, dirCount)`. `{10, 14}` today, so `(1 << 10) | (1 << 14)` = 17408.
 *
 * **Derived from `edgeCost`, never written out, for the reason `graph.ts` gives
 * about `ORTHO_COST`/`DIAG_COST`: a second copy here would be a second source of
 * truth a balance change could silently miss.** Parameterised on the same
 * precedent as `assertBucketCountExceedsEveryEdgeCost`, so the guard below is
 * testable with a doctored cost set rather than only against today's constants.
 *
 * Throws for a cost outside `[0, 30]`, because `1 << 31` is negative and
 * `1 << 32` wraps to 1 — a silent wrong answer in a membership test, which is
 * exactly the class of bug the test exists to prevent. Nothing near that is
 * reachable today (the largest cost is 14, and a motorway divide-by-three tier
 * makes costs SMALLER), but an unreachable branch that fails loudly is the house
 * pattern here.
 */
export function edgeCostMask(dirCount: number, edgeCostOf: (dir: number) => number): number {
  // **`dirCount` is validated because a zero mask is a SILENT "nothing is a
  // legal cost", and this module can really be handed one.** `roads.ts` imports
  // `dispatch.ts`, which imports this file, which imports `roads.ts` — a genuine
  // cycle. A first draft of this mask was a module-scope `const`, and under that
  // cycle `DIR_COUNT` evaluated to `undefined`, the loop ran zero times, and the
  // mask came out 0. It failed loudly here only by luck of polarity (a 0 mask
  // rejects every push, so 157 tests went red at once); the same shape in a
  // guard that FAILS OPEN would have shipped. The mask is therefore built inside
  // `computeFlowField` rather than at module scope, and this guard makes the
  // module-scope spelling impossible to reintroduce quietly.
  if (!Number.isInteger(dirCount) || dirCount <= 0) {
    throw new Error(
      `edgeCostMask: dirCount must be a positive integer, got ${dirCount} — a zero or absent ` +
        'direction count yields an empty mask, which silently means "no cost is legal". If this is ' +
        '`undefined`, this function is being called at module scope inside the roads/dispatch/scratch ' +
        'import cycle; call it from inside a function instead.',
    )
  }
  let mask = 0
  for (let k = 0; k < dirCount; k++) {
    const cost = edgeCostOf(k)
    if (!Number.isInteger(cost) || cost < 0 || cost > 30) {
      throw new Error(
        `edgeCostMask: edgeCost(${k}) = ${cost} is outside [0, 30]; a cost that large cannot be ` +
          'represented as a bit in a 32-bit membership mask, and the shift would wrap silently',
      )
    }
    mask |= 1 << cost
  }
  return mask
}

/** The costs a mask names, ascending. Throw-path only; it allocates. */
function costsInMask(mask: number): readonly number[] {
  const out: number[] = []
  for (let c = 0; c <= 30; c++) {
    if (((mask >>> c) & 1) !== 0) out.push(c)
  }
  return out
}

/**
 * Throws if a relaxation would push a distance the cost model or Dial's cyclic
 * queue cannot represent from the bucket currently draining.
 *
 * **This is the mechanism for the trap `NB`'s note above describes and could
 * not close.** `assertBucketCountExceedsEveryEdgeCost` inspects only
 * `edgeCost(k)`, so a penalty applied INSIDE `computeFlowField` — a per-cell
 * term read off `roads`, a junction surcharge, a traffic-light delay — leaves it
 * green while the queue silently aliases two distances into one bucket. Measured
 * at modulus 13: 31 detectors, all of which read like a routing regression
 * rather than a queue bug, because the drain loop's staleness check DISCARDS the
 * aliased entry.
 *
 * **TWO bounds, because one is not enough and the difference is the whole
 * point.** The aliasing bound is `delta <= buckets`; the legality test is
 * MEMBERSHIP in the cost model's value set. On the shipped constants `NB` is 15
 * and `DIAG_COST` is 14, so a surcharge of `+1` on a diagonal — the SMALLEST edit
 * that could introduce one — produces `delta = 15`, which the aliasing bound
 * accepts. A guard silent on the minimal instance of the thing it guards is
 * decoration. The aliasing arm stays because it is a true and separate statement
 * about the queue: at `delta = buckets` the entry lands in a bucket
 * `computeFlowField` has already detached (`bucketHead[b] = -1`) and drains on
 * its next visit, which is exactly why `NB = DIAG_COST + 1` rather than
 * `DIAG_COST` — measured, at 14 the drain loop does not terminate if that detach
 * moves after the walk, and at 15 it is a no-op.
 *
 * **The legality arm is MEMBERSHIP and used to be `delta <= maxEdge`, which was
 * a hole a review measured rather than argued.** Because `NB = DIAG_COST + 1`
 * always and the aliasing arm is tested first, a `delta > maxEdge` bound had a
 * reachable window of *exactly* `delta === 15` — so a junction surcharge of `+2`
 * or `+3` on an ORTHOGONAL step (`delta` 12 or 13) passed all three arms in
 * silence, and a uniform `+2` on a diagonal fired the ALIASING message, blaming
 * queue sizing for a cost-model change. Membership against the real value set
 * closes both.
 *
 * **What membership still cannot see, stated because a guard's blind spot must
 * be derived and not discovered.** The only surcharge that survives is one whose
 * result lands exactly ON another legal value: with `{10, 14}` that is `+4`
 * applied to ORTHOGONAL steps ONLY, which turns 10 into 14 and is
 * indistinguishable here from a legitimate diagonal. Any surcharge that also
 * touches diagonals is caught for every `p >= 1`, because `14 + p` is never in
 * the set; and a uniform surcharge — the shape an actual junction penalty takes,
 * since a junction is a property of the CELL and not of the direction of
 * approach — is therefore always caught. Closing the last case needs the
 * DIRECTION at this call site, which would make the assert a restatement of the
 * caller's own arithmetic rather than a statement about the cost model.
 * `scratch.test.ts` pins the whole table, both the caught cases and this one.
 *
 * Parameterised rather than closing over `NB` and `LEGAL_EDGE_COST_MASK`, on the
 * precedent of `assertBucketCountExceedsEveryEdgeCost`, `assertSingleCrossing`
 * (cars.ts) and `assertDispatchProgress` (dispatch.ts): the failure path is then
 * testable directly, without editing a constant and rebuilding.
 *
 * Unreachable today, by construction: the only pushes are `d + edgeCost(dir)`
 * and every `edgeCost(dir)` is in the mask by derivation. It is reachable the
 * moment anybody adds a term, which is the point.
 *
 * @internal `computeFlowField` is the production call site.
 */
export function assertPushWithinBucketWindow(
  pushed: number,
  draining: number,
  buckets: number,
  legalCostMask: number,
): void {
  const delta = pushed - draining
  if (delta < 0) {
    throw new Error(
      `scratch: a relaxation pushed distance ${pushed}, below the distance being drained (${draining}) — ` +
        'Dijkstra over non-negative weights cannot do that, so this is a negative or corrupted edge cost',
    )
  }
  if (delta > buckets) {
    throw new Error(
      `scratch: a relaxation pushed distance ${pushed} while draining ${draining}, a gap of ${delta} ` +
        `against NB=${buckets} — it aliases into the bucket drained at ${draining + (delta % buckets)}, ` +
        'where the staleness check discards it: wrong paths, no crash. An edge cost above NB - 1 needs ' +
        'NB resized (see NB, and the 2026-08-21 amendment to spec 5.4)',
    )
  }
  if (((legalCostMask >>> delta) & 1) === 0) {
    throw new Error(
      `scratch: a relaxation advanced the distance by ${delta}, which is not a legal edge cost ` +
        `(the cost model produces only {${costsInMask(legalCostMask).join(', ')}}). Path cost is a ` +
        'function of the DIRECTION of a step and of nothing else — a junction, traffic-light or ' +
        'congestion term inside computeFlowField is exactly what this catches. See the 2026-08-21 ' +
        'amendment to spec 5.4.',
    )
  }
}

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
 * the formulation that survives the motorway ÷3 tier, which changes
 * `DISTINCT_EDGE_COSTS` and which this derives from rather than a literal. M1c
 * added no tier, **M1d added none** — its intersection penalty is a movement
 * multiplier rather than an edge weight — **M1e added none**, because both items
 * are cards and the card modal was deferred, and **M1f added none**: it shipped
 * the card modal and spent it on the junction upgrade.
 *
 * **This sentence used to name M1f's traffic-light penalties as a second thing
 * requiring a revisit here, and that half is now refuted rather than merely
 * re-dated.** A traffic light does not change `DISTINCT_EDGE_COSTS`, because it
 * is not an edge cost: the 2026-08-21 amendment to spec §5.4 makes path cost a
 * function of the DIRECTION of a step and of nothing else, and M1f's junction
 * rule lives in `canEnter`. The motorway is the only remaining candidate, and it
 * is M1g's. See `NB` above, where the same prediction has now been made and
 * refuted three times.
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
