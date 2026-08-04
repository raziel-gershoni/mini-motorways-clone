# M1c carry-forward

Durable record of what M1b's reviews established that M1c must act on. The SDD workspace ledgers are git-ignored scratch; this is the part that must survive them.

M1c adds houses, destinations, pins, dispatch, car movement and the chunk-blocking primitive on top of M1b.

---

## Structural changes to make early, not during

### 1. Invert the staleness stamp from opt-in to total-by-default

`hashRoadRegion` currently opts **in** to `roads` plus `header[H_MAP]`. That is the same shape as the dirty flag this design replaced: somebody has to remember to extend it.

Hash **every mutable buffer region except a named exclusion list**, with a test asserting `included ∪ excluded === regionsFor(map).map(r => r.name)`. Adding a region to the layout then *forces* a decision instead of defaulting to silence.

Without this, the M1c region carrying cars or pins will not be in the stamp, and the scheme reverts to exactly the failure it was chosen to prevent — a field that reports fresh while its inputs have changed.

### 2. `step()` cannot reach the pathfinder, and there is no production home for the once-per-tick sync

Nothing in `packages/*/src` calls `placeRoad`, `syncFields` or `fieldFor`. `step(s, inputs)` takes no `world`, no `fields`, no `scratch`, so there is no single place that enforces "sync once per tick" — the rollback tests do it by hand.

Widen `step`'s signature early. The once-per-tick sync is the invariant M1b's most consequential finding was about, and it currently has no production home.

### 3. Route every edge-cost penalty through one cost function

`NB = DIAG_COST + 1 = 15` is the **exact minimum** with zero slack — the instrumented maximum spread of pending distances is 14, not the 4 an earlier comment claimed. `assertBucketCountExceedsEveryEdgeCost` only inspects `edgeCost(k)`.

If intersection or traffic-light penalties are applied **inside** `computeFlowField` rather than through the cost function, the assert keeps passing while the Dial queue silently aliases two real distances into one bucket. Wrong paths, no crash.

### 4. The entry-pool bound will need re-deriving, not re-tuning

`entryPoolCapacity` derives from `DISTINCT_EDGE_COSTS = 2`, and the two-pushes-per-cell proof rests on "a second improvement to a cell requires a strictly smaller edge cost". Per-cell penalties make the distinct-cost set large and that proof collapses. The `graph.test.ts` assertion that exactly two distinct costs exist is the tripwire.

### 5. `fieldFor` is O(cells) per call

Each call runs a full FNV over the roads region plus `hashSources`. Once per colour per tick, free. Once per car per tick on a phone, not. Either document "hold the returned reference for the tick" or cache the tick's roads hash.

---

## Known residuals, each pinned by a test that names the gap

- **Determinism rules catch accidents, not adversaries.** Declined and documented: a doubly-nested IIFE, an untraced alias, a `Set` arriving as a function parameter. Before extending any rule, ask whether the form is something a colleague would write by mistake.
- **`randomBelow`'s index guard** is now hoisted above the `bound <= 1` early return. M1c wires several streams by hand-computed index; that was the trigger.
- **A throw during a rebuild** leaves engines able to diverge on *whether* a rebuild runs next tick, never on *what content* is served. Acceptable, because a rebuild from identical inputs is byte-identical and the only difference is `scratch.stats`, excluded from every hash.
- **`assertSymmetric`, `assertNoRoadOnImpassable`, `hasTree`, `isConnected`, `roadMask` have no production caller yet.** Expected with no game loop. Confirm they get one in M1c rather than drifting into permanently test-only code.
- **The rollback proof is empirical over three fixtures**, not topology-general.

---

## Process

Plan first, then **adversarially review the plan before executing it**. M0 and M1a ran plan → execute → review, and every substantive defect in both was a plan defect. M1b's pre-execution review returned 9 Critical for the cost of one review — two of which produce green tests and execution would never have caught.

Every task mutation-tests its own tests. Sixteen findings on this project have been defects in tests or in untested code that looked covered; every one passed a green suite. For each behaviour, record the one-line change that makes its test fail, and where you cannot construct one, say so — that answer is useful.

Plans do not state expected test counts. The author got them wrong five times.

### The shapes that keep recurring

- A test aimed slightly off-target — `snapshot()` already detaching masked `restore()`'s missing copy.
- A test at the wrong operating point — `bound = 3`, where modulo bias touches one value in 4.29 billion.
- A test that reimplements the thing it checks — a scan self-test re-typing its own regex.
- A fixture that cannot distinguish the variables — a square map hiding a width/height swap.
- Production code with no covering test, masked by a redundant sibling — `H_MAP_W`, and `placeRoad`'s `cleared[a]`.
- A test guarding a failure mode while exhibiting it — the row-seam self-blindness test.
- **Testing that a guard refuses bad input is not testing that the feature does its job.** `syncFields` — the once-per-tick rebuild the game actually runs — had three mutations survive a green 232-test suite, including one where the game builds fields at startup and then ignores every road the player draws.
- An assertion checked against the formula that produced the thing under test — the `ST_PUSHES` bound against its own allocation.
- **The inverse also happens: when two structures are INDEPENDENTLY SUFFICIENT, neither half can have an observer and the compound is the only meaningful mutation.** Task 6 found both halves of an arrival guard to be 0-detector no-ops — dropping the `else` while keeping the single read is as inert as the reverse — because either structure alone upholds the invariant. Demanding a per-half detector there would be demanding a test that cannot exist. **Decompose first; then ask whether a surviving half is unobservable because coverage is missing, or because the other half is sufficient.** Those look identical in a mutation table and want opposite responses: write the test, versus write the comment explaining why no test can exist so nobody deletes either guard on the strength of its own survival.
- **A compound mutation being caught does not mean each half is.** "Drop the carpark from the spacing comparison" applied as one edit is caught; applied to only the *existing* destination's side it survives all 366 tests. The fixture guarded one direction of a symmetric comparison. When a mutation touches two symmetric code paths, mutate them separately — otherwise one live mutant hides inside a caught one.
- **"A guard cannot guard its own deletion" is true in general and can be wrong in a specific case — check whether the code invites the compound edit.** Task 4 had two independent walk bounds; deleting either was caught, deleting both hung. That was accepted as an unrealistic compound edit, on the correct general principle that defending against guard-deletion regresses infinitely. It was still the wrong call: both bounds derive from the same constant, and **each one's doc comment cited the other as "why this looks redundant"** — so the code itself invites a single coherent cleanup PR removing both. One edit, one person, following the comments as written. Before dismissing a compound mutation as unrealistic, look for whether something in the code makes it the natural next edit.
- **A comment that overstates its case is the same defect class as a test that cannot fail** — it reads as verified and is not. A guard was justified by an `H_EPOCH`-poisoning argument that could not be true yet, since none of the implicated functions were wired into `step()`. The guard was right; the reason was falsifiable. Prefer a justification that does not depend on wiring that does not exist: validate at the boundary where the caller's mistake is made, not where its consequence surfaces.
- **A test written specifically to catch a thing can still be blind to it, when the code collapses several causes into one observable.** M1c's final reviewer wrote a seam test, ran it under its own target mutation, and it passed — `dispatchColour` funnels three distinct refusal reasons into a single branch, so the observable could not distinguish them. Writing the test for the right reason does not make it able to see. Always run it under the mutation it was written for.
- **"Derived" is a claim about the code that needs its own evidence.** `step.ts` presented its seven-phase tick order as fully derived. Running all 13 reorderings: **two of the six adjacent transpositions are 0-detector no-ops**, and phase 1's stated justification — "moving this one slot later delays every first pin by exactly one tick" — is measurably false, since it takes moving *two* slots. Harmless today and not tomorrow: `placeDestination` stamps `destSpawnTick` from `H_TICK`, so when M1e makes building placement a `TickAction`, both swaps become real off-by-ones at once with nothing to catch them. When a comment says an ordering is derived, mutate the ordering.
- **An overstated comment that DISCHARGES AN OBLIGATION is worse than one that merely decorates.** `trips.ts` claimed its parameter-free signature was "the primary defence, exactly as it is in `cars.ts`", and the report cited that to justify not running two plan-named mutations. Unlike `cars.ts`, nothing pinned it — adding a `fields` parameter and wiring `step` to pass it passed all 520 tests. A decorative overstatement is cheap; one used as grounds for skipping a test silently *removes* coverage rather than failing to add it. **When you cite a structural defence as a reason not to mutate something, pin the structure first.**
- **A mutation that does not compile or does not load is NOT a caught mutation — and its crash count reads exactly like a kill count.** Task 5's report recorded both halves of a phase filter as "killed by 17 tests". The 17 was a `ReferenceError: PHASE_NONE is not defined` count: `cars.ts` imports only `PHASE_OUTBOUND` and `PHASE_RETURNING`, so the mutant never ran and the suite went red on module load. Applied validly, each half is killed by **1** test — claimed coverage was inflated 17×. This is mutation testing's own failure mode, and it is invisible unless you look at *why* the suite is red. **Before recording a kill, confirm the mutant executed:** the failures must be assertion failures naming the behaviour, not `ReferenceError`, `TypeError`, or a module-load error. Referencing a symbol the module does not import is the most common way to produce one. **The same artifact inverted a survivor into a kill — and that survivor was exactly the coverage hole the review later found.** A fake kill does not merely inflate a number; it conceals the gap it is standing on.

  The cheap heuristic, from the implementer who wrote the bad evidence: **an implausible detector count is a crash signature.** Seventeen tests failing for a change that only affects idle cars should have been read as "this did not run", not as strong coverage. Sanity-check the detector *set* against what the mutation can actually reach, not just its size.
- **A negative assertion is only meaningful if the fixture disables every OTHER mechanism that produces the same observation.** "A car in `PHASE_IDLE` does not move" was satisfied exactly — by cars whose `cursor = 0`, so the *exhaustion* guard stopped them and the phase filter was never exercised. Deleting the phase filter left all 582 tests green. You had tested that something stopped the car, not that the guard did. **This is the most mechanical instance of the family to check for:** for every "X does not happen" bullet, list what else could prevent X, and build the fixture so only the guard under test can. Six instances of this family on M1c alone.
- **A stated fixture condition can be met exactly and still be too weak.** 4a's brief required "at least one same-colour pair with `carparkCell(d1) > carparkCell(d2)`" to pin the ascending insertion. The fixture met it exactly — and a *pair* cannot separate a full shift from a one-element shift, so replacing the shift loop with a single-element shift survived all 51 tests, on a mutation that produces a hard throw during ordinary play. When a rule is about a *span*, the fixture needs a span, not an instance. Ask what the smallest input is that the rule's failure mode needs, not what the brief happened to name.
- **A fixture can satisfy every stated condition of a requirement and still defeat its purpose.** The overflow fixture met fix-list #19 exactly — ≥ 3 same-colour destinations, the capped one off index 0, the cursor off 0 — and then capped two of the three, leaving one destination with room. Every possible walk order reaches the same recipient, so `d = step % destCount`, the precise mutation the requirement exists to kill, passed all 381 tests. **Stated conditions are necessary, not sufficient.** The question is never "does my fixture meet the spec" but "can my fixture tell the right answer from the wrong one" — for a search-order rule, that means two valid candidates must remain reachable so the orders actually differ.
- **A confident wrong reason for why something cannot be tested is worse than an admitted unknown**, because it ends the search. A gap was reported as needing an allocation profiler the repo does not have; the real observable difference was which table the code consulted, and the test took twenty lines using a parameter already exposed. Interrogate your own "untestable" before writing it down.

### One thing that went right, worth repeating

An implementer inferred that destination-vs-destination overlap is *subsumed* by the Chebyshev spacing rule rather than needing its own check, stated the inference plainly, and flagged it. The reviewer checked all 4×4 orientation pairings and it held. Stating a load-bearing inference so someone can check it costs a sentence; the recurring failure is the same inference left silent. Cheap insurance, not distrust.
