import { parseMap, type MapData } from '@laneways/shared'

/**
 * **The two golden fixtures' maps, hoisted here so a guard in another file can
 * name them** — M1f Task 11's *"the pool leaves at least two cards on every map
 * any test drives past a week boundary"*.
 *
 * Both were declared inline in the file that runs them: `GOLDEN_MAP` inside a
 * `describe` in `determinism.test.ts`, and the demand-pin golden's board built
 * on the fly by `makeRig` in `loop.test.ts`. Neither was importable, and
 * **`GOLDEN_MAP` is the map that produced the milestone's Critical 2** — the
 * 4x4 board on which a short pool made `drawOfferPair` throw inside `step`
 * after `H_EPOCH` had been written, poisoning the buffer for the remaining
 * 9,000 ticks. A guard that cannot name the fixture that broke is a guard that
 * covers the wrong maps: the previous draft's iterated the two SHIPPED maps,
 * neither of which is driven past tick 4,500 by anything.
 *
 * **Why a module and not an `export` on the test file, measured rather than
 * assumed.** Importing `./zzprobeA.test` from `./zzprobeB.test` was run on this
 * repo: vitest reported `zzprobeB.test.ts (2 tests)` — the exporting file's
 * suites are re-collected inside the importing one, so `cards.test.ts`
 * importing `loop.test.ts` would have run the whole loop suite a second time.
 * `m1eSplice.ts`, `m1fSplice.ts`, `junctionRigs.ts` and `retiredPlacementRef.ts`
 * are the same shape and the same reason.
 *
 * **There is exactly ONE definition of each map, which is what makes this safe.**
 * A second `parseMap` call with the same arguments would be a copy with a
 * staleness question; `determinism.test.ts` and `loop.test.ts` now read these.
 * Their own digests are the watcher either way — `mapIdHash` folds `id`, the
 * dimensions, the three limits and every terrain byte into the state buffer, so
 * an edit here moves the state golden and the demand-pin golden immediately.
 *
 * These are **read-only fixtures**: nothing in `sim/src` writes `map.terrain`
 * (`roads.ts` reads it and writes `state.cleared` instead), so sharing one
 * `MapData` across the callers inside a file is safe, and vitest isolates
 * files from one another anyway.
 */

/** `h` rows of `w` land cells. The same three lines eight test files declare privately. */
export function allLandRows(w: number, h: number): string[] {
  const row = '.'.repeat(w)
  return Array.from({ length: h }, () => row)
}

/**
 * The state golden's board (`determinism.test.ts`), verbatim from where it was
 * declared: 4x4, **water at (1,1) and mountain at (2,1)**, a tree at (1,2), and
 * `maxHouses`/`maxDestinations`/`groupCount` frozen at 8/4/2 since M1c.
 *
 * Building-free by constraint — no house or destination is ever placed on it —
 * which is what makes M1c Task 1 the only task that re-blesses its digest.
 *
 * **It carries both terrain codes, so `capabilityMask` returns all seven bits
 * here and the M1f pool is unnarrowed.** That is not a coincidence to rely on:
 * the two cards M1f can offer are capable on every map, water or none.
 *
 * (`rollback.test.ts` has an unrelated local `GOLDEN_MAP` of its own — a 12x12
 * road-network fixture. Different map, same name, no relation.)
 */
export const GOLDEN_MAP: MapData = parseMap(
  'golden-fixture-v1',
  ['....', '.~^.', '.T..', '....'],
  12,
  8,
  4,
  2,
)

/**
 * The demand-pin golden's board (`loop.test.ts`): **20x9, every cell land**, so
 * neither conditional capability bit is set on it. Built with exactly the
 * arguments `makeRig('demand-golden', allLandRows(20, 9), 999)` used to pass —
 * `40`/`16` are `makeRig`'s fixed `maxHouses`/`maxDestinations` and `5` its
 * default `groupCount`.
 *
 * It is the **only golden fixture besides the state golden that crosses a week
 * boundary** (`DG_RUN_TICKS` = 5,250 against a boundary at 4,500), which is why
 * it is in Task 11's non-emptiness guard and why its offer slots are asserted
 * by hand at that site.
 */
export const DEMAND_PIN_MAP: MapData = parseMap('demand-golden', allLandRows(20, 9), 999, 40, 16, 5)
