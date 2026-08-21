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
 * The per-board derivations, the dying destinations and the counterfactuals
 * live beside the boards themselves, in `demoLayout.test.ts` and
 * `startingCity.test.ts`. This file is deliberately only the two integers.
 */

/**
 * `demoCity` + `seedDemoLayout` + `createState('laneways-demo')` + the
 * 1,200-tick warm start, no input: **5,757** — 3 min 12 s at 30 Hz. D2, the
 * colour-2 circle at grid (16, 9).
 *
 * **Moved at M1f Task 2** from 6,703 by junction mutual exclusion — 946 ticks,
 * 31.5 s, 14.1 % earlier. The demo board is a deliberately overloaded city and a
 * junction that costs something is what it was built to exhibit: over the same
 * 3,000-tick window it now takes **39,795** entry refusals against 3,235, fires
 * the anti-deadlock valve **7 times** where it fired 0, and delivers **66** trips
 * against 171. Re-measured on the rig this file's header specifies, not copied
 * from a plan — the M1f plan deliberately states no figure for it.
 *
 * **Task 3 may move it again** — it is the task that decides whether the shipped
 * rule is this wide one or the narrower crossing-only arm — and if it does, this
 * constant, `demoAllocation.test.ts`'s window margin and `demoLayout.test.ts`'s
 * matched-window block are all re-derived there.
 */
export const DEMO_DEATH_TICK = 5757

/**
 * `firstCity` + `seedStartingCity` + `createState('laneways-m2')` + the
 * 258-tick warm start, no input: **5,580** — 3 min 06 s. D2, colour 1's lone
 * circle. **Avoidable in five tiles** — see `startingCity.test.ts`.
 *
 * **Confirmed unmoved at M1f Task 2, and that is derived rather than lucky.**
 * Junction mutual exclusion can only change a run in which two cars both have
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
