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
