# M1d carry-forward

What M1c established that M1d must act on. The SDD workspace ledgers are git-ignored scratch; this is the part that must survive them.

M1d adds the chunk-blocking primitive — queueing, give-way, carpark queues, emergent gridlock — plus delayed refunds / ghost roads (§5.11) and lane-speed multipliers. **Cars currently pass through each other.**

For how tests fail on this project, read [`testing-defect-catalogue.md`](testing-defect-catalogue.md) first. It is a checklist, and M1c's six tasks each hit at least one entry in it.

---

## Structural work M1d owns, and should do early

### 0. `canPlaceRoad` allocates ~40 B per call, in the frame loop

Measured during M2 by the allocation harness, once it was widened to cover `packages/sim/src` — which it did not, for the whole of M2, because two tasks each scoped it to their own package and the gap between them went unnoticed.

The allowance in `allocation.test.ts` asserts the allocation is **still present**, not merely under a ceiling. **So fixing it will turn that test red** — that is deliberate, and the red is your signal to delete the allowance rather than leave a dead exemption behind.

Note the invariant is **per call, not per frame**: a per-frame figure encodes the test driver's input density and moves ~2× between rigs.

### 1. Consolidate `stepCell` into `roads.ts` — this one already cost us

There are **two** copies of the cell-stepping bounds logic — private at `cars.ts:155` and exported at `dispatch.ts:324`. (M1c's note said three; M2's final review checked and it is two.) `roads.ts` is the right home because it already owns `OPPOSITE`, `dirBetween` and `inBounds`. During M1c I ruled to keep the duplication rather than refactor mid-milestone, which was defensible and had a price: the whole-milestone review found `cars.ts`'s copy had four dedicated tests and **`dispatch.ts`'s copy had zero — all four bounds survived.** The copy that got tested was not the copy dispatch used.

Fold both into `roads.ts` before adding a third caller. M1d's blocking logic will want one.

### 2. Two phase transpositions are 0-detector no-ops, and M1d/M1e will make them real

`step.ts` runs seven phases. All 13 reorderings were run: 11 are pinned by tests, but **`1↔2` and `2↔3` are inert** — for exactly one reason, that no `TickAction` reads `H_TICK`.

`placeDestination` already stamps `destSpawnTick` from `H_TICK`. **The day building placement becomes a `TickAction`, both swaps become real off-by-ones simultaneously, with nothing to catch either.** If M1d adds any action that reads the clock, pin those orderings first.

### 3. `destPins` and `destReserved` are `Uint8Array`, and the wrap is unrecoverable

An unguarded `destReserved--` at 0 wraps to 255, and the destination is then excluded from dispatch **forever**, because `destPins` is also `Uint8` and can never exceed 255. Task 6 found this in its own brief and guarded both arms.

20,000-tick runs showed `destPins` reaching 14 and holding, so normal play does not approach the range — but M1d's queueing introduces new decrement paths. Every one needs the same guard.

### 4. Iteration-order coupling is pinned but not yet outcome-visible

Arrivals iterate ascending car index. Today that is invisible: decision 4's proved `destReserved <= destPins` means two cars arriving at one destination both hold reservations and both find a pin. It is pinned anyway, because **the invariant that makes it invisible is exactly what M1d's blocking and M1e's destination removal will break.**

When a car can be blocked, "whichever the loop reaches first" becomes outcome-visible. Expect to need a deterministic formulation, and note the Scope section deferred blocking partly because one was not obvious.

### 5. Lane-speed multipliers exist but have no caller

`speedUnits` is covered against a hand-written literal table at `mul ∈ {333, 500, 667, 1000, 2000, 3000}` plus the clamp boundary, deliberately as a unit test independent of the movement loop — because every non-identity multiplier belongs to M1d/M1e. Under the loop test alone the rounding rule is dead code and "change the rounding direction" survives everything.

M1d is where the multipliers get a caller. The unit test is already there; wire to it rather than reimplementing.

---

## Known residuals, each disclosed rather than hidden

- **`y < 0` in `stepCell` is a genuine equivalent mutant**, verified exhaustively over ~1600 geometries and Int32 extremes: 56 raw differences, 0 observable. The retained `x` guards force `y*w + x ≤ -1` for any `y ≤ -1`. It survives mutation and that is correct.
- **Deleting all three route-walk bounds together still hangs.** Each is caught individually; the compound is irreducible, and all three sites carry a comment saying so. A guard cannot guard its own deletion.
- ~~**The "0 allocations per tick" claim has no test that can fail** — there is no allocation profiler in this repo.~~ **False, and corrected during M2.** `node:inspector`'s `HeapProfiler.startSampling` is a Node builtin — no dependency, nothing to install. A reviewer reinstated an allocation inside a hot-path function and measured it appearing by name at ~112 B/frame over three 30,000-frame runs, against a baseline where it never appears. The claim was repeated in every brief across five milestones and capped what anyone attempted. **M1d inherits a real harness (M2 Task 6) — use it for the tick as well as the frame.**
- **No golden covers demand-produced pins.** The loop golden's fixture pre-pins to keep `destPins` stable under assertion; the pin timer is frozen. Worth closing when M1e's authored spawn schedule lands.
- **The rollback proof is empirical over a handful of fixtures**, not topology-general.

---

## What M1c demonstrated, and what it did not

**Demonstrated, by execution:** 7 determinism comparisons byte-identical on whole buffers, including snapshot + restore with fields and scratch **cold-rebuilt on every single tick** for 900 ticks, a rollback across a throwing tick, warm-vs-cold field reuse, `2×(N/2)` fast-forward, and roads erased under in-flight cars. Plus 5 fixtures × 20,000 ticks with `sum(destReserved) === count(PHASE_OUTBOUND)` holding every tick and no counter drift.

**Not demonstrated:** anything about performance under load, and any behaviour with more than a handful of cars. M1d's blocking is the first feature whose cost scales with traffic density.

**Updated after M2:** the game now runs on a real phone in Telegram and a human reports it feels smooth — but that is one device, qualitative, with a handful of cars and no numbers. No Android, no `performanceClass: LOW`, no frame timings. Treat it as evidence the architecture is viable, not as a measured budget.
