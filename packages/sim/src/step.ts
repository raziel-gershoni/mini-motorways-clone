import type { GameState } from './state'
import { H_EPOCH, H_TICK, H_WEEK } from './state'
import { weekOfTick } from './clock'
import { runWeekBoundary } from './week'
import type { WorldData } from './world'
import type { FlowField, Scratch } from './scratch'
import { syncFields } from './flowfield'
import { placeRoad, eraseRoad } from './roads'
import { runDemand } from './demand'
import { assembleSources, runDispatch } from './dispatch'
import { runMovement } from './cars'
import { runArrivals } from './trips'

/**
 * A single road edit applied on one tick. `a`/`b` are the same cell-index
 * pair `placeRoad`/`eraseRoad` already take. An unknown `kind` throws (see
 * `step` below) rather than being silently skipped — a corrupted or
 * forward-incompatible input log should fail loudly, not apply a subset of
 * its actions with no signal.
 */
export type TickActionKind = 'place' | 'erase'
export interface TickAction {
  readonly kind: TickActionKind
  readonly a: number
  readonly b: number
}

/**
 * Player input applied on a single tick. `actions` widened from `readonly
 * never[]` (M1a/M1b) to `readonly TickAction[]` (M1c): road placement and
 * erasure now have a production caller (`step`, below) instead of only the
 * rollback tests wiring `placeRoad` by hand. It is a parameter rather than
 * ambient state so that a recorded input log plus a seed fully determines a
 * run, which is what makes server-side replay verification possible.
 */
export interface TickInputs {
  readonly actions: readonly TickAction[]
}

/**
 * Advances the simulation by exactly one tick, in place.
 *
 * **Signature arity is pinned by a test**: `step(s, world, fields, scratch,
 * inputs)`, always 5 parameters. Fast-forward is two calls to `step`, never
 * a `dt` (§5.10) — there is no batched API, so replaying N ticks and
 * replaying 2*(N/2) ticks run this exact function the same number of times
 * either way.
 *
 * **The eight phases — seven until M1e Task 2 inserted the week boundary at
 * position 2. Most positions are forced by a constraint; ONE ADJACENT SWAP
 * STILL IS NOT, and this comment says which** (M1c, "The tick order,
 * derived"). An earlier version opened "each justified by the constraint that
 * forces its position rather than by preference — the order is derived; do not
 * reorder it for tidiness", and that was an overstatement in the one comment
 * that presents the whole order as derived. Under seven phases all 13
 * reorderings were run: 11 were caught by tests and **`1 <-> 2` and `2 <-> 3`
 * were 0-detector no-ops**, re-measured at the close of M1d over the complete
 * pairwise set C(7,2) = 21 with the same answer. In the eight-phase numbering
 * those two pairs are **`1 <-> 3` and `3 <-> 4`, and only the second is still
 * inert** — see the disclosure below the table. Do not read it as licence to
 * reorder.
 *
 *   1. `H_EPOCH <- tick`; advance `H_TICK`, `H_WEEK`. **The constraint is "the
 *      advance must precede every clock reader below", and as of M1e Task 2 the
 *      nearest of those is phase 2 rather than phase 4.** Until then the only
 *      in-tick `H_TICK` reader was demand's 4 s eligibility gate, which
 *      compares `H_TICK - destSpawnTick[d]` against `FIRST_PIN_DELAY_TICKS`, and
 *      this bullet recorded the slack that produced honestly: an earlier version
 *      claimed "moving this one slot later delays every first pin by exactly one
 *      tick", which was measurably false — one slot later did nothing, and it
 *      took moving past demand, two slots, before anything changed. **That slack
 *      is gone.** Phase 2 reads `H_TICK` directly, so moving the advance one
 *      slot later now misses the week boundary and pays the grant a tick late;
 *      `step.test.ts`'s "the week grant runs after the clock advance" is the
 *      detector and `week.test.ts`'s stepped three-week test is the second.
 *      Moving it past demand is still caught, by three tests: `loop.test.ts`'s
 *      120-tick boundary test, its same-tick dispatch test, and the loop golden
 *      (which does see it, through `pinAccum` — the older parenthetical "no
 *      golden can see this, they are building-free" was written before this
 *      milestone had a golden with buildings in it). `H_EPOCH` is the atomicity
 *      marker and genuinely must be written first — see state.ts's "Atomicity"
 *      note. A throw in a later phase leaves it non-zero, and both the next
 *      `step` and `restore` throw a named error rather than proceed from a
 *      buffer a throwing tick may have partly mutated.
 *   2. The week boundary — grant `WEEKLY_TILE_GRANT` road tiles (`week.ts`,
 *      spec §5.10). Reads `H_TICK`, so it must FOLLOW phase 1; and it must
 *      PRECEDE phase 3, so an action queued on the boundary tick can spend the
 *      tiles it just received — the alternative makes the boundary tick the one
 *      tick of the week a player's road is refused for budget, which is
 *      unexplainable at the screen. **This is the first phase in the game to
 *      read the clock**, and the disclosure below is about what that changes.
 *   3. Apply inputs — the only phase that changes `roads`. Must precede the
 *      field sync, or a road drawn on tick T is invisible to this tick's
 *      field.
 *   4. Demand — accumulators, pins, overflow, drops. Mutates `destPins`,
 *      which decides the source set, so it must precede the sync.
 *   5. Assemble sources, then EXACTLY ONE `syncFields`. Every source-mutating
 *      phase is now behind it, and `fieldFor` throws unless the sync ran
 *      against exactly the current sources.
 *   6. Dispatch — the whole tick's only field reader. Mutates `destReserved`
 *      and car state, never the source set: that is what decision 4 buys, and
 *      it is what makes "no phase between the sync and a field read may mutate
 *      the source set" hold with no in-tick reasoning required.
 *   7. Movement — advances committed routes and reads no field at all
 *      (decision 2). AFTER dispatch, so a car dispatched on tick T also moves
 *      on tick T; the alternative costs every trip one tick and every
 *      exact-tick assertion inherits it.
 *   8. Arrivals — consume the pin, release the reservation, credit the score,
 *      free the car. Mutates `destPins` AFTER the sync, so it must be last.
 *      **Stated residual: the fields are stale from here until the next
 *      tick's sync.** Nothing may call `fieldFor` in that window — not a
 *      renderer, not a debug hash, not a test helper. Under decision 2 the
 *      only in-tick reader is phase 6, so this binds external callers only,
 *      and `loop.test.ts` asserts the throw rather than assuming it.
 *   — `H_EPOCH <- 0` on successful exit.
 *
 * **The one remaining checked no-op, disclosed in `cars.ts`'s idiom for exactly
 * this shape, and the reason it is kept anyway.** `3 <-> 4` (inputs after
 * demand — M1c's `2 <-> 3`) is 0-detector across the whole suite, for one
 * reason: **no `TickAction` reads `H_TICK`.** `roads.ts` is the only module
 * phase 3 calls, and it reads neither the clock nor the week.
 *
 * That is a property of today's action set, not of the design. `placeDestination`
 * (`buildings.ts`) stamps `destSpawnTick[d]` from `H_TICK`, so an action that
 * placed a building would end it — and anyone adding an action that reads the
 * clock owns re-deriving this position and pinning it. **M1e does NOT add one:
 * spawning is a `step` PHASE, not a `TickAction`**, and the action set is still
 * exactly `'place' | 'erase'`.
 *
 * **`1 <-> 3` (the clock advance after input application — M1c's `1 <-> 2`) WAS
 * a 0-detector no-op for that same single reason, and M1e Task 2 ended it.**
 * M1c opened the handoff and M1d carried it, both predicting it would be
 * discharged the day building placement became an action. It was discharged by
 * a different and better route: **insertion.** Phase 2 puts a clock READER
 * between the advance and the input loop, so transposing them yields `inputs,
 * grant, advance` — the grant reads the un-advanced tick, misses the boundary
 * at 4,500 and pays a tick late. Two tests name it: `step.test.ts`'s "the week
 * grant runs after the clock advance" and `week.test.ts`'s stepped three-week
 * test. The handoff is closed, and it is closed by a test that can fail rather
 * than by a test that could not exist.
 *
 * **What was re-confirmed by reading, at M1e Task 2**: `TickActionKind` is still
 * exactly `'place' | 'erase'`, phase 3 still calls nothing but
 * `placeRoad`/`eraseRoad`, and `roads.ts` still reads neither `H_TICK` nor
 * `H_WEEK` (it imports `H_TILES` and `H_DEST_COUNT` from `state.ts` and nothing
 * else from it; the only other module it calls into, `buildings.ts`, is reached
 * through `isFootprintCell`/`destMetaOrientation`, both of which take plain
 * numbers and no `GameState`). So `3 <-> 4` is still 0-detector for the same
 * single reason, and **no test that could fail exists to be written for it** —
 * demanding one would be demanding a test that cannot exist.
 *
 * Two things follow, and they are deliberately different in kind:
 *
 *   - **The trigger has a tripwire rather than only this paragraph.**
 *     `step.test.ts` reads this file and `roads.ts` off disk and pins both
 *     halves of the condition above. It is NOT a detector for `3 <-> 4` —
 *     nothing can be, while the condition holds — it is a mechanism that makes
 *     the person who ends the condition read this comment. A handoff whose only
 *     carrier is a comment is a handoff with no recipient.
 *   - **A 0-detector claim is only ever true of the suite that measured it.**
 *     M1d's Task 9 re-ran the reorderings against the finished milestone (table
 *     below), and M1e Task 2 re-ran the four pairs its own change can reach
 *     (table below that). Measuring before the new code lands says nothing
 *     about after.
 *
 * ---------------------------------------------------------------------------
 * THE RE-MEASUREMENT, AT THE CLOSE OF M1d — TASK 9
 * ---------------------------------------------------------------------------
 *
 * **Historical, and its numbering is M1d's SEVEN-phase one.** Every `n <-> m`
 * in this block counts phases without the week boundary: M1d's `1 <-> 2` is
 * today's `1 <-> 3` and M1d's `2 <-> 3` is today's `3 <-> 4`. Read it with the
 * M1e block below, which supersedes its conclusion for the first of those.
 *
 * **The result at the time was that nothing changed: `1 <-> 2` and `2 <-> 3`
 * were still the only 0-detector transpositions, and still for the same single
 * reason.**
 *
 * **What was actually run, because the historical figure could not be
 * reproduced from its own description.** Every prior record says "all 13
 * reorderings", and the enumeration behind 13 is written down nowhere in this
 * repo — 7 phases admit 6 adjacent transpositions and 21 pairwise ones, and
 * neither is 13. Rather than guess, Task 9 ran the **complete pairwise set,
 * C(7,2) = 21**, which is unambiguous, reproducible from this sentence, and a
 * superset of whatever 13 meant. Phase 1 is the `H_TICK`/`H_WEEK` advance only:
 * the poison check, `const tick`, the `H_EPOCH` write and the `H_EPOCH` clear
 * are prologue and epilogue, because `H_EPOCH` is the atomicity marker and is
 * excluded from the ordering question by construction.
 *
 * Detectors, over `packages/sim` + `packages/game` (1,161 tests):
 *
 * ```
 *   1<->2  adj    0      2<->3  adj    0      <- the two no-ops, unchanged
 *   3<->4  adj   19      4<->5  adj   75
 *   5<->6  adj   47      6<->7  adj   27
 *   1<->3        14      1<->4        24      1<->5        69
 *   1<->6        51      1<->7        35      2<->4        23
 *   2<->5        69      2<->6        51      2<->7        32
 *   3<->5        74      3<->6        48      3<->7        31
 *   4<->6        75      4<->7        75      5<->7        54
 * ```
 *
 * **A caution on ten of those nineteen non-zero rows, recorded because the
 * complement check is the only thing that caught it.** The runs for `1<->4`,
 * `1<->5`, `2<->4`, `2<->5`, `3<->4`, `3<->5`, `4<->5`, `4<->6`, `4<->7` and
 * `5<->7` collected **1,126** tests rather than 1,161: those reorderings make
 * `step` throw during test COLLECTION, so `integration.test.ts`'s 35 tests never
 * ran at all. Their detector counts are therefore lower bounds on a partly-
 * unrun suite, not clean kill counts. They are all comfortably non-zero and
 * nothing here turns on their exact size, but a reader comparing 75 against 19
 * should know the two were not measured over the same suite. The two rows this
 * comment is actually about both collected the full 1,161.
 *
 * **And the first pass got the answer wrong, in the direction that matters.** It
 * reported **1** detector for each of `1<->2` and `2<->3`, which read as "the
 * milestone ended the inertness". It had no paired control. Re-run four times
 * each alongside four unmutated baselines: both transpositions scored 0 in 4 of
 * 4, and the **BASELINE** scored 1 in one round — the flake being
 * `allocation.test.ts`'s sampling profiler, which that file documents at length.
 * A flaky baseline reads exactly like a kill, which is the catalogue's flaky-
 * mutant entry with the flake on the other side. **Run the control as many times
 * as the mutant.**
 *
 * So at the close of M1d the trigger still had not fired, and M1e inherited
 * both swaps.
 *
 * ---------------------------------------------------------------------------
 * THE RE-MEASUREMENT, AT M1e TASK 2 — THE PHASE COUNT WENT 7 -> 8
 * ---------------------------------------------------------------------------
 *
 * PENDING: filled in by Task 2's mutation battery, in the commit that follows
 * the one introducing this phase. The prediction, stated before running so the
 * measurement can be wrong: `1 <-> 3` NON-ZERO (the discharged handoff),
 * `3 <-> 4` ZERO (still inert, same single reason), `1 <-> 2` NON-ZERO,
 * `2 <-> 3` NON-ZERO.
 *
 * Pure in the sense that matters: the result depends only on the contents of
 * `s.buffer`, `world`, `fields`/`scratch` (both re-derivable from `s.buffer`
 * and `world` per design decision 3), and `inputs`. Nothing is read from
 * outside those — no clock, no randomness that is not seeded in the buffer,
 * no globals. That property is what the determinism test enforces and what
 * lets the same module replay a run byte-identically in a Cloudflare Worker.
 */
export function step(
  s: GameState,
  world: WorldData,
  fields: readonly FlowField[],
  scratch: Scratch,
  inputs: TickInputs,
): void {
  if ((s.header[H_EPOCH] as number) !== 0) {
    throw new Error(
      `step: state is poisoned (H_EPOCH=${s.header[H_EPOCH]}) — a previous step threw before ` +
        'clearing it, and this buffer is not resumable',
    )
  }

  const tick = (s.header[H_TICK] as number) + 1
  s.header[H_EPOCH] = tick
  s.header[H_TICK] = tick
  s.header[H_WEEK] = weekOfTick(tick)

  runWeekBoundary(s)

  for (let i = 0; i < inputs.actions.length; i++) {
    const action = inputs.actions[i] as TickAction
    if (action.kind === 'place') {
      placeRoad(s, world, action.a, action.b)
    } else if (action.kind === 'erase') {
      eraseRoad(s, world, action.a, action.b)
    } else {
      throw new Error(`step: unknown action kind "${String(action.kind)}"`)
    }
  }

  runDemand(s, scratch)

  assembleSources(s, world, scratch)
  syncFields(s, world, fields, scratch)

  runDispatch(s, world, fields, scratch)

  runMovement(s, world)

  runArrivals(s)

  s.header[H_EPOCH] = 0
}
