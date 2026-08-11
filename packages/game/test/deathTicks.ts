/**
 * **The tick each shipped board kills itself on, measured once at M1e Task 7.**
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
 * The per-board derivations, the dying destinations and the counterfactuals
 * live beside the boards themselves, in `demoLayout.test.ts` and
 * `startingCity.test.ts`. This file is deliberately only the two integers.
 */

/**
 * `demoCity` + `seedDemoLayout` + `createState('laneways-demo')` + the
 * 1,200-tick warm start, no input: **6,703** — 3 min 43 s at 30 Hz. D2, the
 * colour-2 circle at grid (16, 9).
 */
export const DEMO_DEATH_TICK = 6703

/**
 * `firstCity` + `seedStartingCity` + `createState('laneways-m2')` + the
 * 258-tick warm start, no input: **5,580** — 3 min 06 s. D2, colour 1's lone
 * circle. **Avoidable in five tiles** — see `startingCity.test.ts`.
 */
export const CITY_DEATH_TICK = 5580
