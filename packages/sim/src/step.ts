import type { GameState } from './state'
import { isGameOver, H_EPOCH, H_TICK, H_WEEK } from './state'
import { weekOfTick } from './clock'
import { runWeekBoundary } from './week'
import type { WorldData } from './world'
import type { FlowField, Scratch } from './scratch'
import { syncFields } from './flowfield'
import { placeRoad, eraseRoad } from './roads'
import { runDemand } from './demand'
import { runSpawn } from './spawn'
import { assembleSources, runDispatch } from './dispatch'
import { runMovement } from './cars'
import { runArrivals } from './trips'
import { runOvercrowd } from './overcrowd'

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
 * **The ten phases — seven until M1e Task 2 inserted the week boundary at
 * position 2, eight until M1e Task 5 inserted the spawn phase at position 4,
 * and nine until M1e Task 7 APPENDED the overcrowd meter at position 10. Most
 * positions are forced by a constraint; ONE ADJACENT SWAP STILL IS NOT,
 * and this comment says which** (M1c, "The tick order,
 * derived"). An earlier version opened "each justified by the constraint that
 * forces its position rather than by preference — the order is derived; do not
 * reorder it for tidiness", and that was an overstatement in the one comment
 * that presents the whole order as derived. Under seven phases all 13
 * reorderings were run: 11 were caught by tests and **`1 <-> 2` and `2 <-> 3`
 * were 0-detector no-ops**, re-measured at the close of M1d over the complete
 * pairwise set C(7,2) = 21 with the same answer. In the eight-phase numbering
 * those two pairs were `1 <-> 3` and `3 <-> 4`, and only the second was still
 * inert. **In the NINE-phase numbering — which phases 1..9 still carry, since
 * Task 7 appended rather than inserted — there are TWO inert pairs, not one:
 * `3 <-> 5` (inputs versus demand, inherited) and `4 <-> 5` (spawn versus
 * demand, new in Task 5 and predicted by its brief to have a detector).**
 * `3 <-> 4` now names *inputs versus spawn*, which is a different pair and does
 * have one (`spawn.test.ts`'s paving test). Both no-ops are decomposed below,
 * and they are inert for DIFFERENT reasons. Do not read any of this as licence
 * to reorder.
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
 *   4. Spawn (`spawn.ts`, M1e Task 5) — the destination timer and the
 *      per-colour house timers, and whatever they place. AFTER phase 3,
 *      because §5.9's "nothing spawns on an existing road tile" must see the
 *      road the player laid THIS tick — that is the whole of spawn-blocking,
 *      which §5.9 calls a skill expression. BEFORE phase 5, so a destination
 *      placed on tick T is inside `H_DEST_COUNT` for tick T's rotation, and
 *      before the sync for the ordinary reason: it writes `destCell`/`destMeta`
 *      (both FIELD_INPUT) and, through §5.3.5's redistribution, `destPins`.
 *      It reads `H_TICK` (through `placeDestination`'s `destSpawnTick` stamp)
 *      and `H_WEEK` (colour unlocks), so its position against phase 1 is an
 *      off-by-one with a detector.
 *   5. Demand — accumulators, pins, overflow, drops. Mutates `destPins`,
 *      which decides the source set, so it must precede the sync.
 *   6. Assemble sources, then EXACTLY ONE `syncFields`. Every source-mutating
 *      phase is now behind it, and `fieldFor` throws unless the sync ran
 *      against exactly the current sources.
 *   7. Dispatch — the whole tick's only field reader. Mutates `destReserved`
 *      and car state, never the source set: that is what decision 4 buys, and
 *      it is what makes "no phase between the sync and a field read may mutate
 *      the source set" hold with no in-tick reasoning required.
 *   8. Movement — advances committed routes and reads no field at all
 *      (decision 2). AFTER dispatch, so a car dispatched on tick T also moves
 *      on tick T; the alternative costs every trip one tick and every
 *      exact-tick assertion inherits it.
 *   9. Arrivals — consume the pin, release the reservation, credit the score,
 *      free the car, and apply §5.8's arrival KNOCKBACK to the overcrowd meter.
 *      Mutates `destPins` AFTER the sync, so it must be the last phase that
 *      does. **Stated residual: the fields are stale from here until the next
 *      tick's sync.** Nothing may call `fieldFor` in that window — not a
 *      renderer, not a debug hash, not a test helper. Under decision 2 the
 *      only in-tick reader is phase 7, so this binds external callers only,
 *      and `loop.test.ts` asserts the throw rather than assuming it. Phase 10
 *      below sits inside that window and is allowed to, because it reads no
 *      field.
 *  10. Overcrowd (`overcrowd.ts`, M1e Task 7, spec §5.8) — integrate each
 *      destination's meter against its timer capacity. AFTER phase 9, and that
 *      is a real constraint rather than a tail position: the meter reads
 *      `destPins`, so running it first charges a destination for the tick a car
 *      had already earned back, and a player who cleared a queue on tick T
 *      would still take T's damage. `trips.test.ts`'s brink fixture is the
 *      detector. It reads `destPins`/`destMeta` and writes only
 *      `destOvercrowd`/`destOverTicks`, both `FIELD_IRRELEVANT`
 *      (`regions.ts`), so it cannot stale a field and nothing after it needs
 *      re-syncing. **It does not end the run** — Task 8 is what reads
 *      `OVERCROWD_FAIL_MILLITICKS` and shuts the city down.
 *   — `H_EPOCH <- 0` on successful exit.
 *
 * **The phase count went 9 -> 10 at M1e Task 7 and phases 1..9 kept their
 * numbers, so every `n <-> m` recorded below still names the pair it named.**
 * The complete pairwise set is now C(10,2) = 45 and Task 7 did not re-run it;
 * what it did measure is the one new ADJACENT pair, `9 <-> 10`, which is
 * non-zero — see the M1e Task 7 block at the foot of this comment. Read the
 * two inert pairs below as "still inert as of the nine-phase sweep", not as a
 * claim about the ten-phase set.
 *
 * **The one remaining checked no-op, disclosed in `cars.ts`'s idiom for exactly
 * this shape — and the reason recorded for it for three milestones was the
 * WRONG ONE.** `3 <-> 5` (inputs after demand — M1c's `2 <-> 3`, M1e Task 2's
 * `3 <-> 4`) is 0-detector across the whole suite. Every prior version of this
 * comment said that was
 * because **no `TickAction` reads `H_TICK`**, and M1e Task 2's review measured
 * that claim directly: with the trigger SATISFIED — `roads.ts` reading `H_TICK`
 * in a live branch — transposing the pair still scores **0**. The clock has
 * nothing to do with it.
 *
 * **Task 5's insertion does NOT discharge it, and that is worth saying because
 * the previous insertion did.** Phase 2 discharged `1 <-> 3` by putting a clock
 * reader between two phases whose only relationship was the clock. Phase 4 sits
 * between inputs and demand, so `3 <-> 5` is no longer an ADJACENT
 * transposition — but the pair still commutes for the disjointness reason
 * below, and a transposition of two commuting phases is inert however many
 * phases sit between them.
 *
 * **And the insertion ADDED a second checked no-op rather than only removing
 * one. `4 <-> 5` — spawn versus demand — is also 0-detector, measured over the
 * whole 1,693-test suite, and Task 5's brief predicted it would have a
 * detector.** Of the two new adjacent pairs, only `3 <-> 4` (inputs versus
 * spawn) has one: `spawn.test.ts`'s paving test, 1 detector.
 *
 * **`4 <-> 5` has no business commuting and does anyway, for TWO reasons, both
 * needed.** Spawn writes `destCell`, `destMeta`, `destSpawnTick`,
 * `H_DEST_COUNT` and — through §5.3.5's push — `destPins`, `rotationCursor` and
 * `H_PINS_DROPPED`, every one of which demand reads. So this is NOT the
 * disjointness of `3 <-> 5`; it is:
 *
 *   1. **A destination placed on tick T is INELIGIBLE on tick T.** The gate is
 *      `tick - destSpawnTick >= FIRST_PIN_DELAY_TICKS` and `placeDestination`
 *      stamps `destSpawnTick = tick`, so `computeSlotCounts`, `resolveCurrent`,
 *      `advanceCursor` and the overflow walk all skip it whichever side of
 *      demand it was placed on — including the wrap moduli, which change with
 *      `H_DEST_COUNT` but only ever skip past the new index.
 *   2. **The push routes through `fireColour`, exactly as a scheduled pin
 *      does.** On the rare tick both fire for one colour, the two calls compose
 *      in either order: same cursor, same overflow walk, same recipient.
 *
 * Reason 1 ends if `FIRST_PIN_DELAY_TICKS` reaches 0 or anything backdates a
 * spawned `destSpawnTick`; reason 2 ends if §5.3.5's push stops going through
 * `fireColour`. **Both have a tripwire rather than only this paragraph**:
 * `spawn.test.ts`'s *"a destination is INELIGIBLE on its own spawn tick"* pins
 * reason 1 at both boundaries of the inequality, and `demand.ts`'s
 * `pushBlockedSpawnDemand` is one line whose whole body is the `fireColour`
 * call reason 2 names.
 *
 * **The operative reason is DISJOINTNESS.** `runDemand` writes `destPins`,
 * `pinAccum`, `rotationCursor` and `H_PINS_DROPPED`, and reads those plus
 * `destMeta`, `destSpawnTick`, `H_TICK` and `H_DEST_COUNT`. Phase 3 writes
 * `roads`, `cleared`, `ghostMask`, `ghostCommitted` and `H_TILES`. **Neither
 * set intersects the other's reads** — the only name both touch is
 * `H_DEST_COUNT`, which both READ and neither writes. Two phases over disjoint
 * state commute, and no clock reader can change that.
 *
 * How the wrong reason survived: it was true of `1 <-> 2`, which the same
 * paragraph used to cover, and it rode along harmlessly on the pair it never
 * explained. Task 2 gave `1 <-> 2` a detector and removed it from the
 * paragraph, which left the borrowed reason standing alone on the inputs/demand
 * pair.
 *
 * **The failure this enables, named because it is scheduled.** M1f adds §5.9's
 * connectivity rule to `placeRoad`/`eraseRoad`: erasing a road that disconnects
 * a destination drops its pending pins. That gains `roads.ts` no `H_TICK` at
 * all — so the clock-shaped tripwire stays green — while making phase 3 write
 * `destPins`, which phase 5 reads. `3 <-> 5` becomes a real one-tick
 * pin-accumulation error on every tick a road is drawn or erased, at 0
 * detectors.
 *
 * **So the tripwire watches the disjointness, not the clock.** `step.test.ts`
 * now scans `roads.ts` for the four names `runDemand` writes, plus
 * `destSpawnTick`. **What it cannot see, stated rather than left to be
 * discovered:** an INDIRECT write — phase 3 calling a helper exported from
 * `demand.ts` or elsewhere that mutates those regions on its behalf. The scan
 * is a mechanism for the direct case and a prompt for the rest; it is not a
 * proof of commutativity.
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
 * exactly `'place' | 'erase'`, and phase 3 still calls nothing but
 * `placeRoad`/`eraseRoad`. `roads.ts` imports `H_TILES` and `H_DEST_COUNT` from
 * `state.ts` and nothing else from it, and reaches **two** other modules —
 * `buildings.ts` through `isFootprintCell`/`destMetaOrientation`, and
 * `dispatch.ts` through `countCommittedCars` (`roads.ts:6`). An earlier version
 * of this sentence, labelled "re-confirmed by reading", said `buildings.ts` was
 * the only one; the conclusion held but the recipe a future reader copies
 * checked one module too few. None of the three takes a `GameState` and returns
 * anything demand writes.
 *
 * Two things follow, and they are deliberately different in kind:
 *
 *   - **The condition has a tripwire rather than only this paragraph.**
 *     `step.test.ts` reads this file and `roads.ts` off disk and pins the action
 *     set, the clock-freedom of `roads.ts`, and the disjointness above. It is
 *     NOT a detector for `3 <-> 4` — nothing can be, while the phases commute —
 *     it is a mechanism that makes the person who ends the condition read this
 *     comment. A handoff whose only carrier is a comment is a handoff with no
 *     recipient.
 *   - **A 0-detector claim is only ever true of the suite that measured it, and
 *     a RECORDED REASON is only ever true of the argument that produced it.**
 *     M1d's Task 9 re-ran the reorderings against the finished milestone (table
 *     below); M1e Task 2 re-ran the four pairs its own change can reach (table
 *     below that); and Task 2's review re-ran the complete pairwise set
 *     C(8,2) = 28 with ten interleaved baselines, confirming that **all seven
 *     newly-possible swaps involving phase 2 are non-zero** and that no new
 *     0-detector reordering exists. The number was re-measured three times and
 *     the *reason* attached to it was wrong the whole way through — which is why
 *     the paragraph above leads with the mutation that falsified it.
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
 * **The phase count went from 7 to 8, and `1 <-> 3` is no longer a member of
 * the inert set. `3 <-> 4` still is.**
 *
 * **This block's numbering is M1e Task 2's EIGHT-phase one, which is NO LONGER
 * this file's — Task 5 has now made the insertion the note below predicted.**
 * Task 5 inserted the spawn phase at position 4, so Task 2's `3 <-> 4` (inputs
 * vs demand) is today's `3 <-> 5`, and today's `3 <-> 4` names *inputs vs
 * spawn* — a different pair with a real detector. Every `n <-> m` in the block
 * below counts phases as Task 2's version of this file listed them; add one to
 * any index of 4 or above to reach today's numbering. Re-label, do not
 * re-interpret.
 *
 * **The predictions were written into the task brief BEFORE the battery ran**,
 * which is the only thing that makes the numbers evidence: a measurement with
 * no prediction cannot be wrong. All four held.
 *
 * Detectors over the canonical whole-suite invocation (1,643 tests: shared 47,
 * render 223, eslint-rules 69, sim 759, game 545), against four unmutated
 * baselines run alongside:
 *
 * ```
 *   baselines           1, 0, 0, 0   <- the 1 is allocation.test.ts's ghost
 *                                       window; see the caution below
 *   1<->2  adj    3   predicted non-zero   grant before the advance
 *   2<->3  adj    1   predicted non-zero   grant after the input loop
 *   1<->3         3   predicted NON-ZERO   THE DISCHARGED HANDOFF
 *   3<->4         0   predicted zero       still inert, same single reason
 * ```
 *
 * Every mutant collected exactly 1,643 tests, so none of these is a crash count
 * wearing a kill count's clothes, and the crash screen matched nothing.
 *
 * **`1 <-> 2` and `1 <-> 3` produce the SAME detector set**, which is not a
 * coincidence and is the reason one test covers both: both orderings put the
 * grant in front of the advance, so the grant reads `tick - 1` either way.
 *
 * **The state golden is NOT a detector for either of them, and that is why
 * `step.test.ts`'s ordering test has to exist.** Reading the un-advanced tick
 * moves the boundaries from 4,500/9,000 to 4,501/9,001 — still exactly two
 * grants inside the fixture's 13,499 ticks, so the digest is unmoved and the
 * final `H_TILES` is identical. A golden that folds a whole buffer looks like it
 * must catch an off-by-one in the clock, and here it does not.
 *
 * **The caution from M1d's block still applies and fired again.** One of the
 * four baselines scored 1: `allocation.test.ts`'s ghost window, a sampling
 * profiler charging `sim/src/roads.ts` 4.24 B/ghost-event against a bound of 4.
 * A flaky baseline reads exactly like a kill. **Not one of the four rows above
 * took a kill from any allocation file** — checked per row rather than assumed,
 * because that check is the only thing that separates the two. Run the control
 * as many times as the mutant, every time.
 *
 * ---------------------------------------------------------------------------
 * M1e TASK 7 — THE PHASE COUNT WENT 9 -> 10, BY APPENDING
 * ---------------------------------------------------------------------------
 *
 * **Phase 10 (`runOvercrowd`) was APPENDED, not inserted, so every index above
 * is unchanged and every `n <-> m` recorded above still names its own pair.**
 * Task 7 did not re-run the complete pairwise set — which is now C(10,2) = 45 —
 * and says so rather than implying it did. What it measured is the one new
 * ADJACENT pair plus the deletion, over the canonical whole-suite invocation
 * (1,739 tests: shared 49, render 223, eslint-rules 69, sim 838, game 560),
 * against **three** unmutated baselines run in the same battery:
 *
 * ```
 *   baselines            0, 0, 0   <- no flake in this round, unlike M1d's and
 *                                     Task 2's; the allocation windows were quiet
 *   9<->10  adj    1   predicted non-zero   the meter charges a tick the arrival cleared
 *   delete 10      1   predicted non-zero   nothing integrates the meter at all
 * ```
 *
 * Every mutant collected exactly 1,739 tests, so neither is a crash count
 * wearing a kill count's clothes, and the crash screen matched nothing.
 *
 * **One detector each, and the two are DIFFERENT tests with different messages
 * — checked, because a pair of assertions that both fire on every mutation is
 * decoration.** The transposition dies in `trips.test.ts`'s *"integrates the
 * meter AFTER arrivals"* with `expected 1 to be +0`; the deletion dies in its
 * sibling *"is not vacuous: with no arrival, the SAME board charges the tick"*
 * with `so the tick IS charged: expected +0 to be 1`. Neither mutant touches
 * the other's test.
 *
 * **No golden sees either**, and that is derivable rather than surprising:
 * every golden fixture in the repo holds at most one pin per destination, five
 * short of the square trigger, so phase 10 writes zeroes on every tick of every
 * one of them whichever side of phase 9 it runs. That pair of tests is
 * therefore the only thing standing between this ordering and a silent
 * regression, which is why they are written as a pair rather than as one test
 * with two assertions.
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

  // §5.8's shutdown, and it lives here rather than in the caller for one
  // reason: **server-side replay.** A Worker replaying an input log that runs
  // past the failure must compute the same score as the browser that produced
  // it, whatever the log's length — so every post-failure tick has to be a
  // byte-identical no-op in `sim` itself, not merely a tick the game loop chose
  // not to run. `game`'s `onGameOver`/`loop.end()` is a FOLLOWER of this line,
  // not the authority; it exists to stop the loop burning 30 steps a second on
  // nothing.
  //
  // **After the poison check and before the `H_EPOCH` write, both
  // deliberately.** A poisoned buffer must still refuse loudly whether or not
  // the run also ended, so the epoch guard stays first. And a frozen state must
  // stay restorable: an epoch left set on every frozen tick would make
  // `restore` refuse the save M3 is about to write, so the run would end in the
  // one state a leaderboard cannot accept. `step.test.ts` pins both orderings.
  //
  // Nothing below this line runs again for the life of the buffer — not the
  // clock, not the input loop, not phase 10 itself.
  if (isGameOver(s)) return

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

  runSpawn(s, world, scratch)

  runDemand(s, scratch)

  assembleSources(s, world, scratch)
  syncFields(s, world, fields, scratch)

  runDispatch(s, world, fields, scratch)

  runMovement(s, world)

  runArrivals(s)

  runOvercrowd(s)

  s.header[H_EPOCH] = 0
}
