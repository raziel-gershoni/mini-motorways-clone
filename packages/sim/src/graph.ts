import { ORTHO_COST, DIAG_COST, INTERSECTION_DEGREE } from '@laneways/shared'
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
 *
 * **Disclosed, so it does not read as an oversight: that table-derived
 * orthogonality test has no constructible mutation today.** Replacing
 * `DX[dir] === 0 || DY[dir] === 0` with `dir % 2 === 0` leaves every test
 * green, because the two are equivalent for the current DIRS table (index 0
 * = N, clockwise, so the orthogonals land on the even indices). That
 * equivalence is a property of this one table's ordering, not of the
 * direction concept, and it is precisely what a reordered or extended table
 * would break — silently, inside the cost function every relaxation calls.
 * Reading it off the table is deliberate future-proofing, per the paragraph
 * above, not redundancy that could be dropped.
 */
export function edgeCost(dir: number): number {
  if (!Number.isInteger(dir) || dir < 0 || dir >= DIR_COUNT) {
    throw new Error(`edgeCost: direction index out of range, got ${dir}`)
  }
  const isOrthogonal = (DX[dir] as number) === 0 || (DY[dir] as number) === 0
  return isOrthogonal ? ORTHO_COST : DIAG_COST
}

/**
 * The road DEGREE of `cell`: how many of the eight direction bits its road mask
 * carries. **The only change M1d Task 7 makes to this module**, and read-only
 * like everything else here.
 *
 * Spec §5.5 prices *"approaching an intersection"* with a speed multiplier, and
 * M1d decision 7 defines an intersection as **a cell of degree >=
 * `INTERSECTION_DEGREE`** — a cell where a third road meets, as opposed to a
 * corridor cell (2), a dead end (1) or bare ground (0).
 *
 * **Its only caller as of M1f Task 2 is `isJunctionCell` below, and that is the
 * point of the split.** `cars.ts`'s `intersectionSpeedMul` used to read this
 * directly; it now goes through the predicate, so the threshold is applied in
 * ONE place and `canEnter`'s exclusion and §5.6's upgrade can be given their own
 * reader without a third copy of `>= INTERSECTION_DEGREE` appearing anywhere.
 *
 * **`INTERSECTION_DEGREE` is `@laneways/shared`'s as of M1f Task 1, not
 * `cars.ts`'s private constant, and the threshold is named here rather than
 * spelled `3` for a reason that outlived the tidy-up.** The degree acquired its
 * two further readers at Task 2 — `canEnter`'s mutual exclusion, via
 * `junctionAdmitsOne`, and the slowdown, via `isJunctionCell` — and `graph.ts`
 * is the module all three go through. **It is a
 * threshold on a cell's SHAPE and never an edge weight**: `edgeCost(dir)` above
 * takes a direction and nothing else, and the 2026-08-21 amendment to spec §5.4
 * refuses the clause that said to price junctions as extra integer edge weight.
 * `flowfield.test.ts` scans `flowfield.ts` for both `roadDegree` and
 * `INTERSECTION_DEGREE` and uses THIS FILE as the positive control for that
 * scan, which is why the name appears here.
 *
 * **Counted off the MASK, and that differs from `neighbours` in exactly one
 * case, stated here rather than left to be found.** `neighbours` additionally
 * drops any bit whose target is off the grid, because it is about to WALK to
 * that target and the row seam would hand it a cell on the wrong row. This
 * function walks nowhere, so it counts the bit. The two therefore agree for
 * every state the game can reach — `placeRoad` validates adjacency through
 * `dirBetween` before it writes any bit, so no reachable mask has an off-grid
 * bit at all, and `graph.test.ts` asserts the agreement over a randomised
 * placement sequence rather than leaving it as a reading. They disagree only
 * for a bit written DIRECTLY into `state.roads`, and the consequence there is
 * bounded by construction: a degree feeds a car's SPEED and never its path
 * (`cars.ts`), so the worst a corrupted mask can do here is make one car
 * traverse one cell at the wrong speed — never send it somewhere its committed
 * route does not name.
 *
 * An off-board `cell` reads `undefined` from the typed array and answers 0,
 * which is the same answer bare ground gives. No guard, deliberately: every
 * production path passes a cell that has already been proved on-board —
 * `advanceCar` throws on `stepCell`'s -1, and `canEnter` runs
 * `assertEnterCellOnBoard` before it asks anything — so a guard here would be a
 * second owner of that check. `graph.test.ts` asserts the `undefined` answer
 * directly, for `roadDegree` and for both predicates below.
 */
export function roadDegree(state: GameState, cell: number): number {
  const mask = state.roads[cell] as number
  let n = 0
  for (let k = 0; k < DIR_COUNT; k++) {
    if ((mask & (1 << k)) !== 0) n++
  }
  return n
}

/**
 * Is `cell` an INTERSECTION — a cell where a third road meets?
 *
 * **This is the SLOWDOWN's predicate and it is deliberately NOT the
 * EXCLUSION's.** See `junctionAdmitsOne` below. A cell carrying a junction
 * upgrade is still an intersection for the purposes of `intersectionSpeedMul` —
 * M1f's upgrade lifts the mutual exclusion and changes nothing else about the
 * cell — while no longer being governed by the default rule. Keeping the two
 * apart puts each rule's edit in exactly one place and turns the divergence into
 * a table in `graph.test.ts` rather than a branch inside a caller.
 *
 * Counted off the MASK by `roadDegree`, which differs from `neighbours` only for
 * a bit written directly into `state.roads`. An off-board `cell` reads
 * `undefined`, `roadDegree` answers 0, and this answers `false` — the same answer
 * bare ground gives. No guard, for the same reason `roadDegree` has none.
 *
 * **NOT an edge weight, and never.** See the 2026-08-21 amendment to spec §5.4.
 */
export function isJunctionCell(state: GameState, cell: number): boolean {
  return roadDegree(state, cell) >= INTERSECTION_DEGREE
}

/**
 * Does the DEFAULT junction rule — spec §5.5's mutual exclusion, one car at a
 * time — govern `cell`?
 *
 * **`canEnter`'s exclusion clause is this function's only production reader** —
 * with one deliberate second reader in test-adjacent code, `carAheadOf`
 * (`game/src/queueProbe.ts`), which reads the same predicate precisely so the
 * probe and the entry rule cannot disagree. It exists as a separate name from
 * `isJunctionCell` so that M1f Task 9 can add its upgrade clause HERE and nowhere
 * else. An upgraded junction is still an intersection (it slows cars) and is no
 * longer under the default rule (nothing replaces it; the rule is simply lifted).
 * `graph.test.ts` holds the table over both shapes and over a whole board, so the
 * two cannot drift into agreement — and the whole-board case is the assertion
 * Task 9 has to EDIT rather than delete.
 *
 * Identical to `isJunctionCell` at this task. That is not redundancy; it is the
 * seam, named before it is needed, in the one commit where both readers are still
 * asking the same question. **Forcing one predicate false instead of splitting
 * them would remove the slowdown as well as the exclusion**, and a pre-M1f
 * identical control — which is what Task 9 measures its relief against — could
 * not then be built at all.
 */
export function junctionAdmitsOne(state: GameState, cell: number): boolean {
  return isJunctionCell(state, cell)
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
