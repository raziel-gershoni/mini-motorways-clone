/**
 * **The tick each shipped board kills itself on, measured once at M1e Task 7
 * and re-measured at M1f Task 2.**
 *
 * A plain module rather than a constant in whichever test file measured it,
 * because three files now need these numbers — `demoLayout.test.ts`,
 * `startingCity.test.ts` and `demoAllocation.test.ts` — and
 * `demoAllocation.test.ts`'s own budget test already says the rule out loud:
 * *"two copies of a threshold drift, and the copy is the one nobody
 * re-derives."* Task 8 wires the shutdown, Task 9 draws the ring and Task 10
 * sets the default-board gate; all three read these, so they get one home.
 *
 * **Nothing here is a bound the code enforces.** These are measurements of what
 * `step` does on the two shipped boot paths with no player input, taken by
 * driving each board 40,000 ticks and watching `destOvercrowd` reach
 * `OVERCROWD_FAIL_MILLITICKS`. Until Task 8 they have no effect on anything;
 * they exist so that a test window cannot silently grow past the point where
 * the sim freezes and every assertion after it is made over a corpse.
 *
 * **Both were re-measured at M1f Task 2 on the rig this header specifies** —
 * `step` driven directly, no input — which needs no card policy, because `sim`
 * has no pause (Decision 11). **One moved and one did not.** The previous
 * milestone's plan predicted both would move; the derivation for the one that
 * did not is below, and it is a derivation rather than luck.
 *
 * **Both were re-measured again at M1f Task 3, which narrowed the rule.** The
 * demo figure moved a second time (5,757 -> 6,660); the city figure did not
 * move either time, and the derivation below covers both narrowings for the
 * same reason — the board is dead long before any junction event.
 *
 * The per-board derivations, the dying destinations and the counterfactuals
 * live beside the boards themselves, in `demoLayout.test.ts` and
 * `startingCity.test.ts`. This file is deliberately only the two integers.
 */

/**
 * `demoCity` + `seedDemoLayout` + `createState('laneways-demo')` + the
 * 1,200-tick warm start, no input: **6,660** — 3 min 42 s at 30 Hz. D2, the
 * colour-2 circle at grid (16, 9).
 *
 * **Moved TWICE inside M1f, and the second move is most of the first one
 * undone.** Task 2's wide junction rule took it from 6,703 to **5,757** — 946
 * ticks, 31.5 s, 14.1 % earlier. Task 3 narrowed the rule to crossing axes only
 * and it came back to **6,660**, 43 ticks (1.4 s, 0.6 %) short of where it
 * started. The demo board is a deliberately overloaded city and a junction that
 * costs something is what it was built to exhibit; the wide rule cost it more
 * than the board could pay, which is what the Task 3 triage measured. Over the
 * whole run it now takes **12,364** entry refusals against 6,676 pre-M1f
 * (97,138 under the wide rule), fires the anti-deadlock valve **0** times
 * (pre-M1f 0, wide 22), and delivers **410** trips against 420 (wide 105).
 *
 * Re-measured on the rig this file's header specifies, not copied from a plan,
 * and cross-checked against `game/test/junctionArms.ts`'s independent driver,
 * which answers 6,660 / 410 / 12,364 for the same board.
 *
 * **This is the LAST task that may move it before Task 9.** Task 3 owned the
 * choice of rule; `demoAllocation.test.ts`'s window margin and
 * `demoLayout.test.ts`'s matched-window block are re-derived against this value
 * in the same commit.
 */
export const DEMO_DEATH_TICK = 6660

/**
 * `firstCity` + `seedStartingCity` + `createState('laneways-m2')` + the
 * 258-tick warm start, no input: **5,580** — 3 min 06 s. D2, colour 1's lone
 * circle. **Avoidable in five tiles** — see `startingCity.test.ts`.
 *
 * **Confirmed unmoved at M1f Task 2 and again at Task 3, and that is derived
 * rather than lucky. The derivation covers any narrowing for free: Task 3's
 * rule refuses a subset of what Task 2's did, so it can only change a run Task
 * 2's rule could already change.**
 * Junction exclusion can only change a run in which two cars both have
 * business inside one junction cell on one tick. On this board's greedy arm the
 * earliest such tick is **10,207** (`junctionCensus.ts`'s `CENSUS_RULE_VISIBLE`
 * policy; its `CENSUS_CO_PRESENCE` policy says 15,001 and is blind to the
 * same-tick swap, so the earlier of the two is the one this derivation must
 * use), and the earliest tick on which the rule actually changes a byte is
 * **12,780**, measured directly by comparing per-tick state against the previous
 * commit. **This board is dead at 5,580 with no input** — before the first
 * junction event by a factor of 1.83, and before the first divergence by 2.29 —
 * and the no-input arm is quieter still than the greedy one it is bounded
 * against. It was driven anyway and it answered 5,580.
 */
export const CITY_DEATH_TICK = 5580
