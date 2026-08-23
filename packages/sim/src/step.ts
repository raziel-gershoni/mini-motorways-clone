import type { GameState } from './state'
import { isGameOver, H_EPOCH, H_TICK, H_WEEK } from './state'
import { weekOfTick } from './clock'
import { runWeekBoundary } from './week'
import type { WorldData } from './world'
import type { FlowField, Scratch } from './scratch'
import { syncFields } from './flowfield'
import { placeRoad, eraseRoad } from './roads'
import { runDemand } from './demand'
import { runOffer } from './cards'
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
 * **THE PHASE COUNT IS FINAL AT ELEVEN AND NO LATER TASK ADDS ONE.** Say that
 * first, because the next reader has exactly two failure modes here:
 * renumbering a second time by reflex, and leaving a gap for a phase that never
 * arrives. An earlier draft of M1f appended a TWELFTH phase at Task 9 to advance
 * a traffic light's controller once per tick; Amendment 2 deleted the
 * controller, and M1f's relief object is a flag `canEnter` reads — there is
 * nothing to advance. Tasks 6 and 9 add ACTION KINDS, which the input loop
 * dispatches inside phase 3; they add no phase. Eleven.
 *
 * **The eleven phases — seven until M1e Task 2 inserted the week boundary at
 * position 2, eight until M1e Task 5 inserted the spawn phase at what was then
 * position 4, nine until M1e Task 7 APPENDED the overcrowd meter, ten until M1f
 * Task 5 inserted the CARD OFFER at position 4. Most positions are forced by a
 * constraint; ONE ADJACENT SWAP STILL IS NOT, and this comment says which**
 * (M1c, "The tick order, derived"). An earlier version opened "each justified by
 * the constraint that forces its position rather than by preference — the order
 * is derived; do not reorder it for tidiness", and that was an overstatement in
 * the one comment that presents the whole order as derived. Under seven phases
 * all 13 reorderings were run: 11 were caught by tests and **`1 <-> 2` and
 * `2 <-> 3` were 0-detector no-ops**, re-measured at the close of M1d over the
 * complete pairwise set C(7,2) = 21 with the same answer. In the eight-phase
 * numbering those two pairs were `1 <-> 3` and `3 <-> 4`, and only the second
 * was still inert.
 *
 * **In today's ELEVEN-phase numbering there is ONE inert pair and it is
 * `5 <-> 6` — spawn versus demand.** It was `4 <-> 5` for the whole of M1e and
 * is renumbered here by M1f Task 5's insertion at position 4; a later reader
 * grepping `4 <-> 5` should land on this sentence rather than on nothing. The
 * other pair M1e carried, `3 <-> 5` (inputs versus demand), is `3 <-> 6` today
 * and is NOT inert — for a positional reason set out at length below, which has
 * nothing to do with the property it used to be inert about. `3 <-> 4` now names
 * *inputs versus the offer*, which is a THIRD new pair with no detector in M1f
 * Task 5 and one from Task 6 onward. All three are decomposed below. Do not read
 * any of this as licence to reorder.
 *
 *   1. `H_EPOCH <- tick`; advance `H_TICK`, `H_WEEK`. **The constraint is "the
 *      advance must precede every clock reader below", and as of M1e Task 2 the
 *      nearest of those is phase 2 rather than phase 6.** Until then the only
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
 *   4. The card offer (`cards.ts`, M1f Task 5, spec §5.10) — raise this week's
 *      pair into `H_OFFER_A`/`H_OFFER_B`. AFTER phase 3, because a `choose-card`
 *      queued on the boundary tick (Task 6) must resolve THIS week's offer before
 *      the phase that would raise one. BEFORE phase 5, because nothing
 *      downstream may observe a half-raised offer. **Both bounds are arguments
 *      and NEITHER HAS A DETECTOR IN M1f TASK 5** — nothing enqueues a
 *      `choose-card` yet and nothing reads the slots until Task 8, so both
 *      displacements scored 0 in Task 5's own battery and are recorded there as
 *      0 rather than as coverage. It reads `H_WEEK` and `rng[0]`; it writes the
 *      two offer slots and, on a pool of fewer than two cards, `H_OFFER_WEEK`.
 *      It writes **no** `H_TILES`: the card's tile bonus is paid by
 *      `applyChooseCard` in phase 3, so phases 2 and 4 are disjoint BY
 *      CONSTRUCTION — see the `2 <-> 4` row of Task 5's table for why that does
 *      not make the positional transposition inert.
 *   5. Spawn (`spawn.ts`, M1e Task 5) — the destination timer and the
 *      per-colour house timers, and whatever they place. AFTER phase 3,
 *      because §5.9's "nothing spawns on an existing road tile" must see the
 *      road the player laid THIS tick — that is the whole of spawn-blocking,
 *      which §5.9 calls a skill expression. BEFORE phase 6, so a destination
 *      placed on tick T is inside `H_DEST_COUNT` for tick T's rotation, and
 *      before the sync for the ordinary reason: it writes `destCell`/`destMeta`
 *      (both FIELD_INPUT) and, through §5.3.5's redistribution, `destPins`.
 *      It reads `H_TICK` (through `placeDestination`'s `destSpawnTick` stamp)
 *      and `H_WEEK` (colour unlocks), so its position against phase 1 is an
 *      off-by-one with a detector.
 *   6. Demand — accumulators, pins, overflow, drops. Mutates `destPins`,
 *      which decides the source set, so it must precede the sync.
 *   7. Assemble sources, then EXACTLY ONE `syncFields`. Every source-mutating
 *      phase is now behind it, and `fieldFor` throws unless the sync ran
 *      against exactly the current sources.
 *   8. Dispatch — the whole tick's only field reader. Mutates `destReserved`
 *      and car state, never the source set: that is what decision 4 buys, and
 *      it is what makes "no phase between the sync and a field read may mutate
 *      the source set" hold with no in-tick reasoning required.
 *   9. Movement — advances committed routes and reads no field at all
 *      (decision 2). AFTER dispatch, so a car dispatched on tick T also moves
 *      on tick T; the alternative costs every trip one tick and every
 *      exact-tick assertion inherits it.
 *  10. Arrivals — consume the pin, release the reservation, credit the score,
 *      free the car, and apply §5.8's arrival KNOCKBACK to the overcrowd meter.
 *      Mutates `destPins` AFTER the sync, so it must be the last phase that
 *      does. **Stated residual: the fields are stale from here until the next
 *      tick's sync.** Nothing may call `fieldFor` in that window — not a
 *      renderer, not a debug hash, not a test helper. Under decision 2 the
 *      only in-tick reader is phase 8, so this binds external callers only,
 *      and `loop.test.ts` asserts the throw rather than assuming it. Phase 11
 *      below sits inside that window and is allowed to, because it reads no
 *      field.
 *  11. Overcrowd (`overcrowd.ts`, M1e Task 7, spec §5.8) — integrate each
 *      destination's meter against its timer capacity. AFTER phase 10, and that
 *      is a real constraint rather than a tail position: the meter reads
 *      `destPins`, so running it first charges a destination for the tick a car
 *      had already earned back, and a player who cleared a queue on tick T
 *      would still take T's damage. `trips.test.ts`'s brink fixture is the
 *      detector. It reads `destPins`/`destMeta` and writes only
 *      `destOvercrowd`/`destOverTicks`, both `FIELD_IRRELEVANT`
 *      (`regions.ts`), so it cannot stale a field and nothing after it needs
 *      re-syncing. **It does not end the run** — M1e Task 8 is what reads
 *      `OVERCROWD_FAIL_MILLITICKS` and shuts the city down. **It is the LAST
 *      phase and stays the last one: the count is final at eleven.**
 *   — `H_EPOCH <- 0` on successful exit.
 *
 * **The phase count went 10 -> 11 at M1f Task 5 by INSERTING at position 4, so
 * every index of 4 or above in every historical block below has moved by one.**
 * Each block states its own numbering; add one to any index of 4 or above to
 * reach today's. Re-label, do not re-interpret — the pairs those blocks measured
 * are the pairs they measured, and rewriting a measurement to agree with today's
 * labels is how a table stops being evidence.
 *
 * The complete pairwise set is C(11,2) = 55 and **M1f Task 5 ran all of it** —
 * the table is at the foot of this comment and it supersedes every earlier
 * count. **One pair is 0-detector and it is `5 <-> 6`** (spawn versus demand;
 * M1e's `4 <-> 5`, renumbered by Task 5's insertion — a later reader grepping
 * `4 <-> 5` should find this sentence). `3 <-> 6` (inputs versus demand, M1e's
 * `3 <-> 5`) is NOT inert, and the reason is positional rather than a change in
 * the code; the paragraph below carries the correction.
 *
 * **The one remaining checked no-op, disclosed in `cars.ts`'s idiom for exactly
 * this shape — and the reason recorded for it for three milestones was the
 * WRONG ONE.** `3 <-> 6` (inputs after demand — M1c's `2 <-> 3`, M1e Task 2's
 * `3 <-> 4`, M1e Task 5's `3 <-> 5`) was 0-detector across the whole suite while
 * the two phases were adjacent. Every prior version of this comment said that was
 * because **no `TickAction` reads `H_TICK`**, and M1e Task 2's review measured
 * that claim directly: with the trigger SATISFIED — `roads.ts` reading `H_TICK`
 * in a live branch — transposing the pair still scores **0**. The clock has
 * nothing to do with it.
 *
 * **Neither insertion between them discharges it, and that is worth saying
 * because the FIRST insertion — phase 2 — did discharge a different pair.** Phase
 * 2 discharged `1 <-> 3` by putting a clock reader between two phases whose only
 * relationship was the clock. The spawn phase and now the offer phase sit
 * BETWEEN inputs and demand, so the pair is no longer an ADJACENT transposition
 * — but the two phases still commute with each other, for the disjointness
 * reason below.
 *
 * **AND THE SENTENCE THAT USED TO FOLLOW WAS WRONG. It read: *"a transposition
 * of two commuting phases is inert however many phases sit between them."*
 * M1e Task 12's full pairwise sweep measured the pair at 1 detector, stably, in
 * 4 of 4 rounds against 4 clean baselines, and M1f Task 5's re-sweep at the
 * eleven-phase numbering measures `3 <-> 6` at 1 for the same reason.**
 *
 * Nothing about the code changed; the sentence was false as written. **A
 * POSITIONAL transposition of phases `i` and `j` with `j > i + 1` is not a swap
 * of two adjacent items** — it also reverses phase `i` against everything
 * between them, and everything between them against phase `j`. Transposing
 * positions 3 and 6 yields `clock, grant, DEMAND, offer, spawn, INPUTS, sync,
 * ...`, so the player's road is now applied AFTER the spawner has run:
 * `spawn.test.ts`'s *"will not spawn on a road the player laid this tick"* dies
 * with *"a paved cell must refuse a destination"*. That is `3 <-> 5`'s detector
 * firing inside `3 <-> 6`'s mutant, exactly as it should.
 *
 * **So the claim that survives is narrower and still true: the input loop and
 * demand commute WITH EACH OTHER**, which is why the pair was inert while they
 * were adjacent and why swapping them still cannot produce a pin-accumulation
 * error. What ends that is a write, not a distance — see the scheduled failure
 * below.
 *
 * **M1e Task 5's insertion ADDED a checked no-op rather than only removing one.
 * `5 <-> 6` — spawn versus demand, M1e's `4 <-> 5` — is 0-detector, and M1e Task
 * 5's brief predicted it would have a detector.** Of the adjacent pairs around
 * the spawn phase, `3 <-> 5` (inputs versus spawn) has one — `spawn.test.ts`'s
 * paving test, 1 detector — and `4 <-> 5` (the offer versus spawn) does not, in
 * this task, because nothing between them reads the offer slots yet.
 *
 * **Four measurements of spawn-versus-demand, at four suite sizes, all zero.**
 * M1e Task 5 measured it over the suite as it stood at **1,693** tests; M1e Task
 * 12's complete pairwise sweep re-ran it over **1,843** against four fresh
 * baselines; M1e's closing sweep re-applied the transposition alone at **1,843**;
 * and M1f Task 5's 55-pair sweep re-ran it as `5 <-> 6` over **2,044** against
 * four fresh baselines — green every time, no crash-screen match, and the
 * collection count unchanged, so the mutant ran. The suite size is quoted because
 * a bare *"the whole suite"* in a durable comment reads as *"the suite you
 * have"*, and this one has grown by 351 tests since the sentence was written.
 *
 * **Spawn versus demand has no business commuting and does anyway, for TWO
 * reasons, both needed.** Spawn writes `destCell`, `destMeta`, `destSpawnTick`,
 * `H_DEST_COUNT` and — through §5.3.5's push — `destPins`, `rotationCursor` and
 * `H_PINS_DROPPED`, every one of which demand reads. So this is NOT the
 * disjointness of inputs-versus-demand; it is:
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
 * `destPins`, which phase 6 reads. `3 <-> 6` becomes a real one-tick
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
 *     NOT a detector for `3 <-> 6` — nothing can be, while the phases commute —
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
 * in this block counts phases without the week boundary, the spawn phase or the
 * offer: M1d's `1 <-> 2` is today's `1 <-> 3` and M1d's `2 <-> 3` is today's
 * `3 <-> 6`. Read it with the M1e block below, which supersedes its conclusion
 * for the first of those.
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
 * the inert set. `3 <-> 4` — inputs vs demand, today's `3 <-> 6` — still was.**
 *
 * **This block's numbering is M1e Task 2's EIGHT-phase one, which is NO LONGER
 * this file's — TWO insertions have landed at position 4 since.** M1e Task 5
 * inserted the spawn phase there and M1f Task 5 inserted the card offer there,
 * so Task 2's `3 <-> 4` (inputs vs demand) is today's `3 <-> 6`, and today's
 * `3 <-> 4` names *inputs vs the offer* — a different pair again. Every
 * `n <-> m` in the block below counts phases as Task 2's version of this file
 * listed them; add TWO to any index of 4 or above to reach today's numbering.
 * Re-label, do not re-interpret.
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
 * was unchanged at the time and every `n <-> m` recorded above still named its
 * own pair.** It is phase **11** today: M1f Task 5 inserted the card offer at
 * position 4, so this block's `9 <-> 10` is today's `10 <-> 11`. Task 7 did not
 * re-run the complete pairwise set — which was C(10,2) = 45 then and is
 * C(11,2) = 55 now — and says so rather than implying it did. What it measured
 * is the one new ADJACENT pair plus the deletion, over the canonical invocation
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
 * short of the square trigger, so the meter writes zeroes on every tick of every
 * one of them whichever side of arrivals it runs. That pair of tests is
 * therefore the only thing standing between this ordering and a silent
 * regression, which is why they are written as a pair rather than as one test
 * with two assertions.
 *
 * ---------------------------------------------------------------------------
 * THE RE-MEASUREMENT, AT THE CLOSE OF M1e — TASK 12, AT THE FINAL PHASE COUNT
 * ---------------------------------------------------------------------------
 *
 * **Historical, and its numbering is M1e's TEN-phase one. Add one to any index
 * of 4 or above to reach today's** — M1f Task 5 inserted the card offer at
 * position 4 and re-ran the whole set at eleven phases; that table is the live
 * one and sits at the foot of this comment. This block's `4 <-> 5` is today's
 * `5 <-> 6` and its `3 <-> 5` is today's `3 <-> 6`.
 *
 * **The complete pairwise set over TEN phases, C(10,2) = 45, stated as an
 * enumeration so it reproduces from this sentence: every unordered pair
 * `{i, j}` with `1 <= i < j <= 10`, applied as a POSITIONAL transposition of
 * the two statement blocks, with the poison check, `const tick`, the `H_EPOCH`
 * write and the `H_EPOCH` clear excluded as prologue and epilogue exactly as
 * M1d's sweep excluded them.**
 *
 * Canonical whole-suite invocation, 1,843 tests (shared 49, render 252,
 * eslint-rules 69, sim 852, game 621), against **four** unmutated baselines run
 * in the same battery. Baselines: `0, 0, 0, 0` — no flake in this round.
 *
 * ```
 *          j=2   j=3   j=4   j=5   j=6*  j=7*  j=8   j=9   j=10
 *   i=1      6     6    12    39    84*  129*   80    64    41
 *   i=2            1     2     1    79*  123*   57    34    17
 *   i=3                  1     2#   79*  124*   61    39    23
 *   i=4                        0    74*  129*   58    36    18
 *   i=5                             73*  134*   57    38    28
 *   i=6                                  135*  135*  135*  135*
 *   i=7                                         56    97*   97*
 *   i=8                                                36    37
 *   i=9                                                       2
 * ```
 *
 * **`#` marks the one cell whose sweep value is NOT its stable value.**
 * `3 <-> 5` reads 2 here and is **1**: re-run four times against four fresh
 * baselines it scored `1, 1, 1, 1`, always `spawn.test.ts`'s paving test, and
 * the sweep's second detector was `allocation.test.ts`'s Task 12 window — a
 * sampling artefact in a file the mutant cannot reach. The raw figure is left
 * in the table and corrected here rather than quietly replaced, because a
 * table that has been edited to agree with its prose is not a measurement.
 *
 * **`*` marks the sixteen rows that collected a SHORT suite — 1,751 tests
 * rather than 1,843.** Those reorderings make `step` throw during test
 * COLLECTION, so `carSmoothing.test.ts` (27 tests) and `integration.test.ts`
 * (65 tests) never ran at all: 92 tests missing, in exactly the sixteen rows
 * marked. **Their counts are lower bounds on a partly-unrun suite, not clean
 * kill counts**, and a reader comparing 135 against 56 should know the two were
 * not measured over the same suite. Every unmarked row collected the full
 * 1,843. All sixteen involve phase 6 or 7 — the sync and the dispatch — which
 * is the pair that makes `fieldFor` throw *"colour 0 field is stale"* out of a
 * rig's module scope.
 *
 * **The crash screen matched nothing, and its FALSE POSITIVE is recorded rather
 * than swallowed.** Screening for the error-class names anywhere on a line
 * matched one line in ten of the runs — and it was a vitest PASS line whose
 * test NAME contains the word `TypeError` (`syncFields throws ... rather than a
 * raw TypeError from inside hashSources`). That is this repo's own catalogued
 * false positive, reproduced. Re-screened on lines that are not vitest result
 * lines, **0 matches on all 45**, so no mutant failed at module load and every
 * non-zero row above is a kill count rather than a crash count.
 *
 * **The six pairs with a NAMED detector, predicted non-zero BEFORE the battery
 * ran, and all six held:**
 *
 * ```
 *   1<->2    6   clock vs week grant   step.test x1, week.test x2, integration x3
 *   1<->3    6   clock vs inputs       the SAME three files, same counts
 *   1<->4   12   clock vs spawn        + spawn.test x4 (Task 5's destSpawnTick stamp)
 *                                       (one of the 12 is allocation.test.ts and is NOT
 *                                        discounted: this mutant moves the spawn phase,
 *                                        which that window profiles, so a causal path
 *                                        exists and "flake" would be a guess)
 *   2<->3    1   grant vs inputs       week.test x1 (Task 2 Step 1's third test)
 *   3<->4    1   inputs vs spawn       spawn.test x1 (Task 5 Step 9's paving test)
 *   9<->10   2   arrivals vs overcrowd trips.test x1 + integration x1
 * ```
 *
 * **`1 <-> 2` and `1 <-> 3` produce the identical detector SET again**, three
 * files and the same counts in each, which is the same non-coincidence recorded
 * for the eight-phase sweep: both orderings put the grant in front of the
 * advance, so the grant reads `tick - 1` either way.
 *
 * **`9 <-> 10` gained a second detector in this milestone.** Task 7 measured it
 * at 1 (`trips.test.ts`'s brink pair). Task 12's end-to-end arm adds the other:
 * transposing the two moves the greedy arm's death from 31,456 to **31,457**,
 * and `integration.test.ts` fails with `expected 31457 to be 31456`. A
 * one-tick error in the meter is now visible as a one-tick error in the run.
 *
 * **ONE 0-detector row, and it is `4 <-> 5`** — spawn versus demand, the pair
 * M1e Task 5's brief predicted would have a detector and which has never had
 * one.
 *
 * **RENAMED: `4 <-> 5` IS `5 <-> 6` FROM M1f TASK 5 ONWARD.** That task inserted
 * the card offer at position 4, so the register entry (M1f carry-forward §7) and
 * every future reference to this row use the new label. It is the same pair,
 * with the same two commutation reasons and the same two tripwires, re-measured
 * at 0 over 2,044 tests in Task 5's own 55-pair sweep — the fourth independent
 * zero. A reader grepping `4 <-> 5` in a later milestone lands here rather than
 * on nothing, which is the whole reason this paragraph keeps the old label in
 * its first line. **Do not manufacture a detector for it.**
 * Re-run **four times against four fresh baselines**: `0, 0, 0` and one round
 * at **1**, which was `allocation.test.ts`'s own Task 12 window charging
 * `sim/src/buildings.ts` 5.16-5.52 B/tick against a 4 B floor — a sampling
 * artefact in a file the mutant cannot reach, discounted with the reason and
 * recorded here because M1d's sweep was misled by exactly this and its lesson
 * is *run the control as many times as the mutant*. The four baselines in that
 * battery scored 0, as did all four in the main sweep, and six clean canonical
 * runs at head scored 0 — so the flake rate on that window is under 1 in 10 and
 * it is stated rather than hidden.
 *
 * **`3 <-> 5` is no longer inert and the code did not change.** 1 detector,
 * stably, in 4 of 4 rounds — `spawn.test.ts`'s paving test, for the positional
 * reason set out at length above. The two phases still commute with each other.
 *
 * **The two rows that were inert in the nine-phase numbering are therefore now
 * ONE.** Do not read that as progress: `3 <-> 5` acquired a detector for a
 * reason that has nothing to do with the property it was inert about, and
 * `demand.ts`'s scheduled failure — M1f adding a `destPins` write to
 * `placeRoad`/`eraseRoad` — is still a real one-tick pin-accumulation error
 * with no detector for the pair that matters. `step.test.ts`'s disjointness
 * scan is still the only tripwire for it.
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

  runOffer(s, world, scratch)

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
