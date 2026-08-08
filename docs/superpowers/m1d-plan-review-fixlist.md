# M1d plan review — fix list

**Verdict: DO NOT EXECUTE AS WRITTEN.** Task 2 halts on four red goldens it does not authorise, and the primitive it introduces deadlocks the project's own loop fixture at tick 73.

Four reviewers (mechanism, determinism, coverage, scope) reviewed the plan; every finding was attacked by an independent refuter. What follows survived. Counts after dedup: **9 Critical, 6 Important, 8 Minor.**

Two of the Criticals were confirmed by *running* the code, not by reading it: the loop-fixture deadlock (two refuters independently reproduced cars 0 and 1 co-located on cell 113 at tick 73) and the allocation harness never moving a car in 1,752 ticks.

---

## Criticals

### C1. Occupancy is not a field input, and classifying it as one rebuilds every flow field on nearly every tick

**Lenses:** mechanism, determinism, coverage, scope — all four, independently.

**What breaks.** Task 2 says the occupancy region "is a **field input** — a car's presence changes routing viability — so it must be classified in the layout table and hashed." That premise is false for M1d and the consequence is severe.

Nothing in Tasks 2–5 makes any edge cost, source set, or `dir` read depend on occupancy. `edgeCost(dir)` (`graph.ts:94`) is pure length. Routes are committed once at dispatch (M1c decision 2) and `runMovement` reads no field at all. Spec §1 and design-decision row 6 state that "path cost contains no congestion term… This omission is deliberate and load-bearing; it is the game."

Meanwhile `regions.ts:95-98` already classifies every car region FIELD_IRRELEVANT with a dated reason that names the *next* milestone: *"irrelevant while no edge cost depends on occupancy (dated: M1e's demand-actuated lights make car positions a field input)."* Occupancy is the cell→car inverse of `carCell`. Classifying the projection FIELD_INPUT while its source stays FIELD_IRRELEVANT is an internal contradiction with the shipped layout.

Mechanically: `syncFields` (`flowfield.ts:399-412`) compares `hashFieldInputRegions` against each field's stamp and rebuilds every colour that disagrees. Occupancy changes on any tick any car crosses a cell, so all five colours run a full 960-cell Dijkstra every tick, forever, with byte-identical output. Measured on this Mac: 1.14 ms (mid-density) to 1.91 ms (full grid) per rebuild × 5 colours = **5.7–9.6 ms/tick at 30 Hz on a desktop core**, multiples worse on the phone M2 shipped to, and ~114 s of pure Dijkstra for Task 7's 20,000-tick run. The same cost lands in the Cloudflare Worker replay that verifies leaderboard scores.

A reviewer reproduced the mechanism by proxy: adding `carCell` to `FIELD_INPUT_REGIONS` took `CT_REBUILDS` from 35 to 125 over the 130-tick loop fixture — every colour rebuilding on essentially every tick, with two cars on the board. `hashState` was unaffected, confirming the partition side buys nothing for replay.

This is the exact failure `regions.ts:86-89` already documents for `header`: *"H_TICK increments every tick; hashing it would rebuild every colour every tick forever, silently, with correct answers."* It is item #1 on `m1c-plan-review-fixlist.md`.

**Worse: the plan locks it in.** Task 2 requires "the partition test must prove it is hashed rather than merely classified" and lists "omit the region from the field-input hash" and "classify it but do not hash it" as mutations that must be killed. Executing as written ships a §5.4 violation *with a passing test asserting the correct implementation is a defect*, so the later fix is blocked by a green suite. No existing test catches it: `step.test.ts:195` and `:210` (the only `CT_REBUILDS` coalescing guards) use car-free fixtures.

**Witness.** `packages/sim/src/regions.ts:95-98`, `:86-89`; `packages/sim/src/flowfield.ts:399-412`, `:462`; `packages/sim/src/graph.ts:94`; `packages/sim/src/state.ts:24-34` (the `H_TICK` precedent); `packages/sim/src/dispatch.ts:565-570` (the invariant "every region it writes is FIELD_IRRELEVANT, so no colour's dispatch can perturb another colour's field staleness"); `packages/sim/test/step.test.ts:195,210`.

**Change to the plan.** In Task 2, replace:

> It is a **field input** — a car's presence changes routing viability — so it must be classified in the layout table and hashed, and the partition test must prove it is hashed rather than merely classified.

with:

> It is **FIELD_IRRELEVANT**, and the layout table's dated reason must say why in the same form `regions.ts:95-98` already uses for the car regions: *occupancy — irrelevant while no edge cost depends on it (dated: M1e's demand-actuated lights make car positions a field input).* Do not hash it into the field-input set. Occupancy changes on nearly every tick, and `syncFields` rebuilds every colour whose field-input hash moved, so hashing it would run five whole-board Dijkstras per tick forever, silently, with correct answers — the failure `state.ts:24-34` records as the reason `H_TICK` was split out of a hashed region. `hashState` is FNV over the *whole* buffer (`state.ts:369-371`), so the region is covered for determinism and replay regardless of which partition it is in; the partition is the flow-field staleness key and nothing else.

Delete these two mutations from Task 2: *"omit the region from the field-input hash; classify it but do not hash it."* Replace with:

> **Mutations:** classify the occupancy region FIELD_INPUT and hash it — `CT_REBUILDS` must then rise on ticks with no road or pin change.

Add to Task 2's coverage:

> on a tick where a car moves but no road is placed or erased and no pin spawns or is consumed, `scratch.counters[CT_REBUILDS]` does not move. No existing `CT_REBUILDS` fixture has cars in it, so this is new coverage, not a restatement.

**Separately:** Task 5's `pendingErase`/ghost region genuinely *is* a field input — a ghost is not traversable by an uncommitted car, so it changes routing viability, and it changes rarely. Task 5 currently assigns it no classification at all. Give it one, and hash it. (See C7 for why the ghost's road bits must also be settled.)

---

### C2. Tasks 2 and 5 each move four of the five goldens, and the plan forbids exactly that

**Lenses:** mechanism, determinism (twice), coverage, scope — all four.

**What breaks.** `hashState(s)` is `hashBytes(s.bytes)` (`state.ts:369-371`), and `s.bytes` is `new Uint8Array(buffer)` over the **whole** buffer, sized by `computeLayout(regionsFor(map)).totalBytes`. FNV-1a walks `bytes.length`, so appending a region changes the digest even when every new byte is zero — and Task 2's occupancy region is `-1`-filled (`0xFF`), so not even that marginal case applies.

Task 2 adds one region. Task 5 adds another. Four of the five goldens move, twice:

| Golden | Site | Moves? |
|---|---|---|
| state `2413319809` | `packages/sim/test/determinism.test.ts:555` | yes |
| road-network `2790151213` | `packages/sim/test/rollback.test.ts:699` | yes |
| loop `3896659943` | `packages/sim/test/loop.test.ts:761` | yes |
| seed `2505371110` | `packages/game/test/startingCity.test.ts:616` | yes |
| field `252514232` | `packages/sim/test/rollback.test.ts:743` | **no** — `foldedFieldsHash` over `dist`/`dir`, outside the buffer |

Computed concretely: appending 3,840 zero bytes multiplies the FNV state by `p^3840 mod 2^32 = 3425868801 ≠ 1`, giving `2413319809 → 364966529`, `2790151213 → 2925772845`, `3896659943 → 1119207`, `2505371110 → 356062694`. Mid-tier insertion (which is what `regionsFor`'s descending-alignment order produces for an `Int32Array`) moves them too, just to different values.

The Global Constraint says *"If one moves and your task did not say it would, stop and report — do not re-bless."* Only Task 4 declares a move, of the loop golden, "in this task only." **Task 2's implementer is instructed to halt on a change Task 2 itself mandates.**

Three amplifications:

1. **The re-bless is cross-guarded on purpose.** `loop.test.ts:777-790` reads `determinism.test.ts` and `rollback.test.ts` off disk and asserts the literals are unchanged, with vacuity guards. Its own comment says this exists "to make the quiet re-bless cost a second, differently-located test failure." A correct re-bless edits six literals in four files across two packages. `determinism.test.ts`, `rollback.test.ts` and `packages/game/test/startingCity.test.ts` appear in **no task's file list**; `loop.test.ts` appears only in Task 7.
2. **Task 4's authorisation is already stale by the time it runs.** The loop golden moved in Task 2 for an unrelated reason. Task 4's "re-bless once, in this task only" is false as written, and worse — Task 4 can no longer distinguish "moved because multipliers changed timings" from "moved because the buffer grew." (See C8: it does not move for multipliers at all.)
3. **Collateral pins.** `regions.test.ts:47` asserts `totalBytes === 7908`; `regions.test.ts:52-78` asserts exactly the 22 named regions in order; `state.test.ts:278-321` walks the layout table. `packages/game/src/main.ts:152` documents `2505371110` and the rejected `4171132894` in prose that no test reads, so it goes stale silently.

The repo already paid for this once, for the same reason: `determinism.test.ts:551-554` — *"Re-blessed in M1c Task 1 (was 1073292924, M1b's value): the buffer grew to the full M1c region list."* M1c's plan carried an explicit "Why one re-bless is now true" section. M1d's has none.

**Witness.** `packages/sim/src/state.ts:369-371`, `:131-133`, `:265`; `packages/sim/src/hash.ts:6-13`; `packages/sim/test/loop.test.ts:764-791`; `determinism.test.ts:551-555`; `rollback.test.ts:696-699,743`; `packages/game/test/startingCity.test.ts:616`; `packages/game/src/main.ts:152`; `packages/sim/test/regions.test.ts:47,52-78`.

**Change to the plan.** Add a new section after the six design decisions, modelled on M1c's:

> ## Why two re-blesses are true, and exactly which numbers move
>
> `hashState` is FNV-1a over the **whole** state buffer (`state.ts:369-371`). Adding a region grows the buffer, so every whole-buffer golden moves on layout alone, before any behaviour changes. Task 2 adds the occupancy region and Task 5 adds the ghost region, so it happens twice.
>
> Each of those two tasks must, **in the same commit as the region**, re-bless all four whole-buffer goldens and the cross-file scan that guards them:
>
> - `packages/sim/test/determinism.test.ts:555` — state
> - `packages/sim/test/rollback.test.ts:699` — road-network
> - `packages/sim/test/loop.test.ts:761` — loop
> - `packages/game/test/startingCity.test.ts:616` — seed
> - `packages/sim/test/loop.test.ts:781-782` — the literal scan over the first two files
>
> and update `packages/sim/test/regions.test.ts` (`totalBytes`, the ordered region-name list) and the prose figures at `packages/game/src/main.ts:152`. Record the old and new values in the commit message with the reason, in the form `determinism.test.ts:551-554` already uses.
>
> The **field golden `252514232`** is `foldedFieldsHash` over `dist`/`dir`, which live outside the buffer. It must **not** move in any task. If it does, stop and report — that one is a tripwire, not a re-bless.

Amend Task 2's Files line to:

> **Files:** `packages/sim/src/blocking.ts` (new), `regions.ts` (one region + its FIELD_IRRELEVANT classification), `state.ts` (interface, `REGION_FIELD_NAMES`, `viewsOver`, and the creation-time fill), `packages/sim/test/blocking.test.ts`, `regions.test.ts`, `determinism.test.ts`, `rollback.test.ts`, `loop.test.ts`, `packages/game/test/startingCity.test.ts`.

Amend Task 5's Files line the same way. Amend Task 4's re-bless clause per C8.

---

### C3. Head-on traffic: one undirected slot per cell cannot hold the spec's two lanes, and every return leg retraces its outbound corridor

**Lenses:** mechanism, determinism, coverage. (Scope raised a variant about the shipped starting city that was **refuted** — see §6.)

**What breaks.** Spec §5.11 line 275 is explicit: roads are *"Bidirectional, **one lane each way**."* The plan's occupancy is one slot per cell with no direction. Decision 1 records the density halving as "the cost… stated rather than hidden" but is silent on the larger cost: **the directional lane is gone, so opposing traffic on a shared cell is mutually exclusive.**

This is not exotic. `cars.ts:208` makes the return leg the outbound route read backwards (`OPPOSITE[routeStep(state, i, cursor - 1)]`, decrementing the cursor), so every car retraces the corridor it came out on. `trips.ts:114-122` flips `PHASE_RETURNING` in place with no dwell, leaving the car standing on the carpark cell. `dispatch.ts:171` seeds every colour's flow field at the destination's carpark cell, funnelling that colour's traffic through one cell in both directions. `CARS_PER_HOUSE = 2` guarantees two cars per house sharing routes.

The tightest witness is inside **Task 3's own carpark-queue feature**. Car A reaches carpark cell K and flips to RETURNING the same tick, wanting K−1. Car B — queued behind A under Task 3's rule — is on K−1 wanting K. Mutual block, in either index order; ascending resolution cannot break a head-on swap because neither car can win an entry the other occupies. Task 3 demands "three cars behind a blocked leader form a queue and each advances in order when it clears, with hand-computed arrival ticks," but the leader can only clear by driving back through the queue. Those hand-computed ticks are either wrong or 1,350 apiece.

The valve does break it, so "permanent" is too strong — but 1,350 ticks is **45 s, 30 % of a 4,500-tick week**, per encounter, against a plan that calls valve firings "brief." And the escape is worse than the disease: the two cars then pass through each other, which is precisely the behaviour M1d exists to remove.

**Nothing in the plan can observe it.** Task 3's queue fixture is same-direction. Its gridlock ring is a *cycle* — the one topology where rotation resolves and opposing conflict cannot appear. Task 7's guards ("one car blocked ≥ 10 consecutive ticks", "at least one queue of ≥ 3", "total trips strictly below the M1c baseline") are each satisfied *more strongly* by the broken behaviour. The acceptance criteria are inverted against the defect. Searching the plan, the carry-forward and the defect catalogue for head-on / opposing / oncoming / two-way / bidirectional / swap returns nothing on point. Task 2's signature `canEnter(state, cell)` has no direction and no car index.

**Witness.** `packages/sim/src/cars.ts:208`; `packages/sim/src/trips.ts:114-122`; `packages/sim/src/dispatch.ts:171`; `packages/shared/src/constants.ts:62`; spec line 275; and the empirically-confirmed trace in C4.

**Change to the plan.** Add a seventh design decision, and reword Decision 1's cost paragraph.

Decision 1, replace:

> **The cost is real and must be recorded, not discovered later: road capacity is half what the spec's density implies.**

with:

> **The cost is real and must be recorded, not discovered later, and it is larger than a density halving.** The spec's road is "bidirectional, one lane each way" (§5.11), i.e. two directional lanes per cell at 2 cars per lane-tile. A single undirected slot per cell is a quarter of that capacity, and — the part that actually bites — it makes opposing traffic **mutually exclusive** on every shared cell. Decision 7 states what M1d does about that. If M1e's tuning finds throughput too tight, the fix is a genuine change with genuine tests — not a constant nudge. Do not add a `CARS_PER_CELL` constant "for later."

New Decision 7:

> ### 7. Opposing traffic needs an explicit rule; the valve is not it
>
> Every return leg retraces its outbound cells (`cars.ts:208`), arrivals flip phase in place on the carpark cell (`trips.ts:114-122`), and each colour's field is seeded at a single carpark cell. So a returning car meeting an outbound car on a one-wide corridor is the **modal** traffic event, not an edge case. Under one undirected slot per cell neither can move, and ascending-index resolution cannot break a mutual block.
>
> Falling through to the 1,350-tick valve is not acceptable here: it is a 45-second freeze on the commonest event in the game, and it resolves by letting the two cars pass through each other — the exact behaviour this milestone exists to remove.
>
> **M1d ships one of these three, chosen and stated before Task 2 is written:**
>
> - **(a) Two directional slots per cell.** Occupancy becomes two `Int32Array` regions, or one region of `2 × cells`, indexed by the *sign of travel* along the cell's axis. This is the spec's own model and is the only option that makes opposing traffic genuinely non-interacting. Cost: one extra region, and a direction argument on `canEnter`.
> - **(b) A swap rule.** When car *i* is blocked by car *j* and *j*'s next cell is *i*'s current cell, the pair exchanges cells atomically within the tick, resolved once in ascending index. Cheapest to build; must be pinned by a dedicated fixture and by the mutation "resolve the swap in descending index."
> - **(c) A give-way rule that prefers the returning car**, with the carpark cell permitted to hold two cars for the duration of the exchange.
>
> Whichever is chosen, `canEnter`'s signature gains what it needs (a direction, or the entering car index, or both) and the Scope line "give-way falls out of the primitive" must be corrected: give-way does **not** fall out of an undirected slot.

Add to Task 3's coverage:

> a returning car and an outbound car meeting head-on on a one-wide corridor both continue, with hand-computed arrival ticks, **without the valve firing** — assert the valve's blocked-tick counter never reaches 1,350 in this fixture;
> the same at a dead-end carpark: a car flipping to RETURNING on carpark cell K, with a queued car on K−1, resolves within one crossing time.

Add to Task 3's mutations:

> delete the opposing-traffic rule and observe the head-on fixture stall for 1,350 ticks.

---

### C4. The project's own loop fixture deadlocks at tick 73 under the new primitive, and no task owns repairing it

**Lenses:** mechanism, coverage, scope. Independently reproduced by two refuters, by execution.

**What breaks.** `loop.test.ts`'s fixture is a single corridor on row 5 (cells 102..116) with both destinations' carparks and both houses on it. Hand-traced from the fixture's own `rel_k` table (`rel_k = ceil(k*2500/330)` = 8, 16, 23, 31, 38, 46, 54, 61, 69, 76, 84, 91; `abs = dispatchTick + rel_k − 1`) — every one of those twelve values recomputed and correct:

- Car 0 (H0, cell 116), dispatched tick 2, west to d2 (110), arrives tick 47, returns east entering 111/112/113/114/115/116 at ticks **55/62/70/77/85/92**.
- Car 1 (H0, cell 116), dispatched tick 51, west, entering 115/114/113/112/111/110 at ticks **58/66/73/81/88/96**.

An instrumented replica of `buildLoopFixture` printed `t=73 → cells 113,113` — both cars on cell 113 simultaneously, head-on, on a one-wide corridor. That is the event Task 2's primitive forbids. Under `canEnter`-at-entry, car 1 is blocked entering 113 at tick 73 and car 0 blocked entering 114 at tick 77; the attempts fall on **different ticks**, so no swap-in-one-tick rule rescues it either. The valve fires at tick 1,423. `RUN_TICKS = 150`.

Everything the fixture asserts becomes unreachable. Not just the hash:

| Assertion | Site | Under blocking |
|---|---|---|
| `obs.scores` exact array | `:444-449` | loses `tick=92 car=0` and `tick=141 car=1` |
| `H_SCORE === 4` | `:451` | 2 |
| `obs.pinsConsumed` | `:435-440` | loses `tick=96 car=1 dest=1` |
| `scoreAfterTick` ladder | `:464-467` | collapses |
| "returned to a NOT the nearest house" | `:470-490` | runs to tick 92; **the only test in the repo proving return-to-own-house** |
| snapshot/restore `ALL_SCORES` | `:683-692` | both arms |
| `H_SCORE`, `obs.scores.length`, `pinsConsumed.length` | `:739-742` | 2 / 2 / 3 |
| `carPhase[1] === PHASE_RETURNING` | `:747` | car 1 stuck OUTBOUND at 113 |
| idle-hygiene `idle === 4` | `:574` | 2 |
| golden `3896659943` | `:761` | hash of a jammed board |

Task 2 and Task 3 introduce the primitive; neither is authorised to move the loop golden. The Global Constraint says stop and report. Task 4's authorised re-bless covers only the hash literal and attributes the move to lane-speed multipliers — which do not apply to this fixture at all (C8). **No task in the plan owns redesigning the loop fixture for a world where cars cannot pass through each other.**

Note the coverage lens found a second, earlier death for the same fixture: H1 sits at cell 105 *on the corridor* with idle cars 2 and 3 parked on it, so if idle cars occupy (C5), car 2's first return blocks at tick 47 rather than 73. Either way the fixture is dead.

**Witness.** `packages/sim/test/loop.test.ts:59-146` (fixture + hand-computed timeline), `:121` (`rel_k`), `:232-236` (`corridorActions`), and the assertion sites tabulated above.

**Change to the plan.** Add a new task between Tasks 3 and 4, and renumber:

> ## Task 3b: Repair the loop fixture for a world with blocking
>
> **Files:** `packages/sim/test/loop.test.ts`.
>
> The M1c loop fixture is a single one-wide corridor on row 5 (cells 102..116) with both houses and both carparks on it. Under Task 2's primitive, car 0 returning east and car 1 heading west meet head-on: car 1 is blocked entering 113 at tick 73, car 0 blocked entering 114 at tick 77, and the valve does not fire until tick 1,423 against `RUN_TICKS = 150`. Every hand-computed literal in the file becomes physically unachievable — the four observation arrays, the `scoreAfterTick` ladder, the not-nearest-house test, the mid-flight `carPhase[1]` assertion, the idle-hygiene count, and the golden.
>
> **This is not a re-bless.** The fixture no longer demonstrates what it was built to demonstrate (a full out-and-back to a non-nearest destination with a car still in flight at the golden tick). Redesign it so that property survives: give the two directions separate corridors, or stagger the pin waves so the two cars are never in flight in opposite directions at once, or place H0 off the shared corridor. Whichever you pick, state the choice and the reason in the file's module comment.
>
> **Coverage required:** the file's hand-computed `rel_k` timeline is re-derived for the new geometry and every literal follows from it; the not-nearest-house property (`:470-490`) still holds and still runs to a scored return; a car is still mid-flight at the golden tick; the fixture is asserted to contain **no** head-on encounter, so that a future change that reintroduces one is a red test rather than a silent 45-second stall.
>
> **This task re-blesses the loop golden**, and states the old and new values with the reason.
>
> **Vacuity self-check:** if the redesigned fixture never blocks anything, it has lost nothing and gained nothing — assert at least one *same-direction* block occurs, so the fixture exercises the new primitive rather than routing around it.

---

### C5. The occupancy release rule is unspecified, and the natural implementation corrupts the array the first time the valve fires

**Lenses:** mechanism, determinism, coverage, scope — all four.

**What breaks.** Task 2 stores "one entry per cell, holding the occupying car index or `-1`" — a single-valued slot. Decision 3 then says "Two cars may briefly share a cell when the valve fires. That is accepted and must be asserted as reachable." The plan never states the release rule, and Task 2's two release mutations ("release occupancy a tick late; release it a tick early") describe an **unconditional** write, which is the broken branch.

Trace Task 3's *own required fixture* — "a gridlocked ring of four cars all eventually move" — under unconditional release. Cars 0–3 on c0–c3, each wanting the next, all valves fire the same tick, processed ascending:

```
car 0: occ[c0] = -1, occ[c1] = 0     (clobbers car 1's record)
car 1: occ[c1] = -1, occ[c2] = 1     (erases car 0's fresh claim)
car 2: occ[c2] = -1, occ[c3] = 2
car 3: occ[c3] = -1, occ[c0] = 3
```

End state: `occ = [3, -1, -1, -1]` with a car standing on all four cells. **Three of four cells silently stop blocking for the rest of the run**, and the ring thereafter rotates freely with cars overlapping, re-creating the holes each rotation. Cars pass through each other again.

Guarded release (`if (occ[cell] === i) occ[cell] = -1`) plus overwrite-on-entry self-heals — traced on the same ring it yields the correct `[3,0,1,2]`. So a correct implementation exists; the plan simply does not select it. A reviewer noted one residual even under the guard: if the valve car leaves the shared cell *before* the original occupant, its guarded clear succeeds and frees a cell the other car is still on. The rule therefore needs the guard **plus** hand-off, or a per-cell count with an owner, or the alternative of holding the valve car's claim on its origin cell until the target frees.

**Nothing detects any of it.** Task 3's ring bullet ("all eventually move, none starves") passes *more easily* under the corruption. Task 3's bullet "two cars sharing a cell after the valve is asserted as reachable" is satisfiable via equal `carCell` regardless of what occupancy holds. Task 7's four long-run assertions are all insensitive: the corruption is deterministic, so replay parity is untouched; `destReserved` is unaffected; nothing wraps (`-1` is the legal sentinel). And it propagates into Task 5, whose refund trigger reads this same array: a wiped entry makes a cell read vacant while a committed car is still on it, firing the refund early and falsifying Task 5's own "not before" bullet.

**Witness.** Plan Task 2 line 114 vs Decision 3 lines 70 and 132; `packages/sim/src/cars.ts:235-237` (`state.carCell[i] = next`, the single in-place write that makes `occ[old] = -1; occ[next] = i` the natural extension); `packages/sim/src/cars.ts:258-262` (ascending sweep). Spec §5.5 line 205 tracks *inbound vehicles* (plural) with committed timestamps — Decision 2 discards that structure and Decision 3 then depends on the capacity it discarded.

**Change to the plan.** In Decision 3, after "That is accepted and must be **asserted as reachable**, or the valve is untested," add:

> **The release rule is part of this decision, not an implementation detail.** A single-valued slot can carry the shared state, but only under **guarded release with hand-off**: a car clears a cell only if the slot still names it (`occ[cell] === i`), and a car that leaves a cell it shares hands the slot to the other occupant rather than writing `-1`. Unconditional release is the natural extension of `cars.ts:235`'s single in-place write and it is wrong: on the four-car ring this task already requires, four unconditional releases in one ascending sweep leave three of four cells reading FREE with a car on each, blocking silently stops working for the rest of the run, and every coverage bullet in Tasks 2, 3 and 7 stays green.

Add to Task 2's coverage:

> after any tick in which occupancy is written, the array is globally consistent: every in-flight car's cell names that car or another car physically on it, and no cell names a car that is not on it. Assert this as a helper (`assertOccupancyConsistent`) in the house style of `assertSymmetric` / `assertArrivalHonoured`, called from the blocking fixtures and from Task 7's long run.

Add to Task 2's mutations:

> release occupancy unconditionally (drop the `occ[cell] === i` guard).

Add to Task 3's coverage:

> the occupancy array's contents are asserted on the valve tick and on each subsequent departure from the shared cell — not merely that two cars have equal `carCell`.

Add to Task 3's mutations:

> release unconditionally on the four-car ring; the consistency assertion must fire.

---

### C6. No task owns the occupancy lifecycle for a car that is not moving: creation, dispatch, arrival home, and idle siblings

**Lenses:** mechanism, determinism, coverage, scope — all four.

**What breaks.** Occupancy is a claim/release protocol with four events: enter a cell, leave a cell, come into existence, cease to exist. The plan specifies the first two. Nobody owns the rest.

1. **Creation.** An `Int32Array` region zero-initialises. Unless something fills it with `-1`, every cell reads "occupied by car 0" on a fresh state and nothing can move. `createState` (`state.ts:316-327`) writes only `rng`, `mapIdentity` and `H_TILES`. No task says to add the fill. (The fill also falsifies the load-bearing prose at `state.ts:306-315` — "no `-1` sentinel is written anywhere at creation" — and its mirror at `state.test.ts:374-375`; both need updating in the same commit.)

2. **Tick 0.** `placeHouse` (`buildings.ts:342-349`) creates `CARS_PER_HOUSE = 2` cars, both with `carCell = houseCell` and `PHASE_IDLE`. Two cars on one cell before any tick runs — a state the array cannot represent. The plan never says whether idle cars occupy.

3. **Dispatch.** `dispatch.ts:552` (`reselect = lowestFreeCar(state, h) >= 0`) exists specifically so a house with two free cars serves two pins in **one tick**, putting two OUTBOUND cars on one cell simultaneously.

4. **Arriving home — the modal failure.** Read Task 2's "claim on entry / release on leave" literally: a returning car's last crossing genuinely enters the house cell (`trips.ts` module comment confirms this), so it claims `occ[houseCell]`. `completeTrip` (`trips.ts:149-159`) then flips it to `PHASE_IDLE` and it never "leaves." The claim is held indefinitely. **Its sibling, returning later, is blocked one cell short of home and stalls 1,350 ticks — 45 s — on every trip, blocking the road behind it.** Every house whose two cars both run trips hits this, every trip. And when the idle car later redispatches and drives off, it releases `occ[houseCell]`, clobbering whatever claim the sibling took via the valve.

5. **House cells are road cells, necessarily.** The flow field propagates only over road bits (`flowfield.ts:167`, `graph.ts:115`), so `dist[houseCell]` is INF and the house is never selected unless its cell carries a road. `canPlaceRoad` deliberately keeps house and carpark cells placeable (`roads.ts:169-171`). So two idle cars parked on a live road cell is the universal steady state of every house — not a fixture artefact.

Note also that Task 2's outcome-code list has no endpoint/parking code, and applied naively `NO_ROAD` would refuse entry to carparks and houses entirely. Task 3 at least implies carparks are enterable; **the house endpoint has no sentence anywhere in the plan.**

**Nothing in the plan detects it.** `sum(destReserved) === count(PHASE_OUTBOUND)` holds for returning cars. "No car starves" passes because the valve fires. Task 7's jam guard asserts "total trips strictly below the M1c baseline" as a **success** criterion, so the throughput collapse reads as the milestone working. No coverage bullet in any task mentions a car arriving home.

This is the direct analogue of M1c's "return leg with no mechanism at all."

**Witness.** `packages/sim/src/buildings.ts:342-349`, `:53` (`PHASE_NONE = 0`), `:308`, `:385`; `packages/shared/src/constants.ts:62`; `packages/sim/src/dispatch.ts:552`, `:438`; `packages/sim/src/trips.ts:149-159`; `packages/sim/src/state.ts:306-327`; `packages/sim/src/flowfield.ts:167`; `packages/sim/src/roads.ts:169-171`; `packages/game/src/frame.ts:70-74`.

**Change to the plan.** Add to Task 2, immediately after the region description:

> **Which cars occupy, and when.** Occupancy is claimed and released by these five events and no others. State them in `blocking.ts`'s module comment:
>
> 1. **Creation.** `createState` fills the region with `FREE = -1`. A zero-filled region reads as "car 0 occupies every cell" and nothing on the board can move. Update the all-zero prose at `state.ts:306-315` and its mirror at `state.test.ts:374-375` to read "no `-1` sentinel outside `occupancy`."
> 2. **Only cars in `PHASE_OUTBOUND` or `PHASE_RETURNING` occupy a cell.** `PHASE_IDLE` and `PHASE_NONE` cars do not. A house cell necessarily carries a road (the flow field only propagates over road bits, so a house with no road on its cell is never dispatched from), and every house parks up to `CARS_PER_HOUSE = 2` idle cars on it, so making idle cars occupy would wall off the front door of every house on the board.
> 3. **Dispatch** (phase 5) claims the house cell for the newly-outbound car. `dispatch.ts:552` can flip two cars of one house OUTBOUND in the same tick; the second finds the house cell occupied and is refused at its first crossing, which is correct queueing. Dispatch itself is never refused.
> 4. **Movement** (phase 6) releases the old cell under the C5 guard and claims the new one.
> 5. **Trip end.** `completeTrip` (`trips.ts:149-159`) releases the house cell as the car goes `PHASE_IDLE`. Without this the car holds its own front door forever and its sibling stalls the full valve on every return leg — the single most common trip in the game.
>
> `canEnter`'s `NO_ROAD` outcome is about cells that carry no road bits. House cells and carpark cells carry road bits and are ordinary enterable cells; do not special-case them.

Add to Task 2's coverage:

> a fresh `createState` has every occupancy entry `FREE`, and `hashState` of a building-free state is a deterministic constant (assert two fresh states are byte-identical); two idle cars share their house cell at tick 0 with the cell reading `FREE`; a house dispatches both its cars in one tick and the second queues at the first crossing rather than being refused at dispatch.

Add to Task 3's coverage:

> a car completing a trip releases its house cell on the same tick, and its sibling's later return enters the house cell without the valve firing — assert the sibling's blocked-tick counter never reaches 1,350.

Add to Task 3's mutations:

> hold the house-cell claim through `completeTrip`.

Amend Task 3's Files to include `packages/sim/src/dispatch.ts`.

---

### C7. The ghost mechanism is unbuildable as specified: "committed" is undefined, `canEnter` cannot express the rule, and re-placing over a ghost prints tiles

**Lenses:** mechanism, coverage, scope, determinism.

**What breaks.** Decision 5 models the ghost as "a per-cell `pendingErase` flag plus **the existing occupancy**: the refund fires on the tick the last committed car leaves." Three things fail.

**(a) "Committed" is never defined, and both readings break something.** Spec §5.11 uses the word without defining it; its only carrier is §5.5's "inbound vehicles with a committed timestamp," which Decision 2 explicitly discards. So the word is inherited with its meaning removed.

- *Narrow reading* (committed = currently on the cell): occupancy is the right key, but Task 5's bullet "a ghost with two committed cars refunds on the second one's departure" is **impossible** — one car per cell means the first departure empties the cell. Task 5's own vacuity check ("the cars must clear on *different* ticks") is exactly the condition under which the stated mechanism gives the wrong answer, so the self-check disproves the mechanism instead of validating the test. And bullet 3 becomes self-defeating: an entering car never already occupies the cell, so "already committed" is false for every entrant and `GHOST` refuses everyone, **including the car the ghost exists to let finish**.
- *Wide reading* (the cell is on the car's remaining route): bullets 3 and 4 become meaningful, but occupancy cannot compute it. `dispatch.ts:540-546` commits the whole route at dispatch, unreached cells included, and `cars.ts:29-33` records that movement never reads `state.roads` and never re-paths — so a car five cells short of the ghost leaves occupancy at `-1`, the refund fires immediately, and the ghost vanishes under an inbound committed car. That is the exact case §5.11 exists for. Computing it properly needs a per-cell committed-car **count** that no task declares, fixed at erase time and decremented on departure (which is also the only genuine new `Uint8Array` decrement path in the milestone — see M5).

**(b) `canEnter(state, cell)` cannot express the rule.** Task 2 declares `GHOST` as an outcome of a function with no car index, while Task 5 demands a per-car answer from it. The rule "not traversable by a car that has not already committed to it" is structurally inexpressible in the function the plan names for it.

**(c) The road bits are never settled, and both branches are broken.** Task 2 lists `GHOST` and `NO_ROAD` as *distinct* codes, which only makes sense if the bits survive the erase. Task 5 is silent.

- *Bits retained:* `roads` is FIELD_INPUT and staleness is derived from a content hash of it (`roads.ts:71-76`), so an erase that changes no bit does not invalidate the field. Dispatch keeps routing **new** cars across the ghost; they are not committed, they hit `GHOST`, and they jam for 1,350 ticks before valving through. Worse, `canPlaceRoad`'s cost is `(maskA === 0 ? 1 : 0) + (maskB === 0 ? 1 : 0)` (`roads.ts:174-176`), so re-placing the same segment while its bits are intact costs **0 tiles** and `placeRoad` is idempotent — then the deferred refund pays out for a road the player still owns. Repeat the erase/re-place cycle and it prints tiles indefinitely. Because the Worker replays the identical input log, the inflated budget and resulting score verify as legitimate on the leaderboard.
- *Bits cleared:* the flow field loses the edge at once, no new route contains the ghost, no uncommitted car ever attempts entry — `GHOST` is unreachable production code, the "let a new car enter a ghost" mutation is a provable no-op, and Task 5's traversability test passes because the *road* is gone, not because the ghost check works. And re-placing then charges 1–2 tiles which the deferred refund pays back: net-free road. If instead the implementer clears `pendingErase` on re-place, the refund never fires and the player is charged twice, violating §5.11's "refunds in full."

Task 5's coverage ("never double-refunded") and mutations ("refund twice", "forget to clear the pending flag") cover none of the re-placement paths.

**(d) A boolean flag cannot be rendered.** `canvas.ts:481-503` blits one atlas tile per road cell keyed by that cell's 8-bit mask, and documents "Mask 0 is never blitted." A ghost cell is by definition one whose mask reached 0. Task 6 requires "a ghost cell draws at reduced opacity and a **thinner** stroke," which needs the erased bits, not a flag.

**Witness.** Plan Decision 5 and Task 5 coverage bullets 2–4 vs Task 2's `canEnter(state, cell)`; `packages/sim/src/dispatch.ts:540-546`; `packages/sim/src/cars.ts:16-33`; `packages/sim/src/roads.ts:12-32`, `:148-176`, `:191-215`, `:227-253`; `packages/sim/src/regions.ts:81`; `packages/render/src/canvas.ts:481-503`, `:83-85`; spec line 277.

**Change to the plan.** Replace Decision 5 entirely:

> ### 5. A delayed refund is a per-cell ghost mask plus a committed-car count
>
> §5.11: deleting a road refunds in full, but the refund is **delayed while a car has committed to that segment**, and the tile renders as a thinner, lower-opacity ghost until the last committed car clears.
>
> **"Committed" means: at the instant of the erase, the cell appears in the car's remaining route (`carRoute[carRouteCursor..carRouteLen]`).** Occupancy cannot express this — occupancy records who is standing on a cell now, while a committed car may be five cells short of it, and movement never re-paths (`cars.ts:16-33`), so that car *will* arrive. Keying the refund on occupancy fires it immediately and the ghost vanishes under an inbound committed car, which is the exact case §5.11 exists for.
>
> The state is therefore **two per-cell regions, not one flag**:
>
> - **`ghostMask` (`Uint8Array`, one per cell)** — the road bits the erase removed. `eraseRoad` clears the live bits from `roads` as it does today, so the flow field loses the edge immediately and **no new route is ever committed across a ghost**, and moves them here. The renderer needs these bits: `canvas.ts` blits one atlas tile per mask and never blits mask 0, so a boolean cannot draw a directional stroke.
> - **`ghostCommitted` (`Uint8Array`, one per cell)** — the number of cars whose remaining route contains this cell, counted **once at erase time**. Because the live bits are gone, this count can only fall. It is decremented when a committed car crosses off the cell, and reaching 0 fires the refund (exactly 1 tile per cell, since the tile economy is per cell — `roads.ts:12-32`) and clears both regions. This is the milestone's new `Uint8Array` decrement path and Task 1d's guard applies to it directly.
>
> `canEnter` gains the entering car's index so it can answer `GHOST` correctly: a car whose remaining route contains the cell may traverse it; any other car is refused.
>
> **Re-placing a road over a ghost cell cancels the pending refund and is charged as if the cell were empty.** Without this rule the player erases under traffic, immediately redraws, and either gets the road free or is handed a tile out of nothing, repeatably — and the Worker replays the same input log, so the inflated budget verifies as legitimate. `placeRoad` over a ghost cell clears `ghostMask` and `ghostCommitted` for that cell without refunding.
>
> Classify `ghostMask` and `ghostCommitted` **FIELD_INPUT and hash them**: a ghost changes routing viability (unlike occupancy — see decision on Task 2), and both change rarely.

Rewrite Task 5's coverage:

> **Coverage required:** erasing a road with **no committed car** refunds immediately; erasing a road whose cell is on a committed car's remaining route refunds **on the tick that car crosses off the cell**, not before and not later — build the fixture with the car several cells short of the erase, so an occupancy-keyed implementation refunds early and fails; a ghost cell is traversable by a committed car and returns `GHOST` to any other; a ghost with **two** committed cars refunds on the second one's departure, with the two clearing on different ticks; **placing a road over a ghost cell cancels the pending refund and is charged as if the cell were empty** — assert `H_TILES` after erase-then-replace-then-clear equals its value before the erase, and that the road is live; the tile budget is exactly restored, never double-refunded and never lost; no route committed after the erase contains the ghost cell; ghosts survive snapshot/restore.

Add to Task 5's mutations:

> key the refund on occupancy rather than the committed count; let a re-place refund anyway; let a re-place suppress the refund permanently; decrement `ghostCommitted` at 0.

Amend Task 5's Files to `packages/sim/src/roads.ts`, `blocking.ts`, `regions.ts` (two regions), `state.ts`, `dispatch.ts` (count the committed cars at erase time), and their tests, plus the goldens listed in C2.

Add to Task 6's coverage:

> the ghost stroke is derived from `ghostMask`, so a ghost of a diagonal segment draws diagonally.

---

### C8. Task 4's "the loop golden must therefore move" is false — no multiplier applies to the loop fixture — and the standing re-bless licence will absorb a real regression

**Lenses:** coverage, determinism. Confirmed by execution.

**What breaks.** Task 4 says "a straight run through a plain cell is unchanged from M1c's timings — **and the loop golden must therefore move; say so and re-bless once, in this task only.**" The two halves do not follow, and the conclusion is false.

A reviewer rebuilt the exact golden fixture (two `placeDestination`, two `placeHouse`, the 14 `place` actions 102→116, both scripted pin waves), ran 130 ticks, and reproduced `hashState = 3896659943` — confirming it is the golden fixture. Dumped facts:

- Road-cell degrees: 102 mask=4 deg=1; 103..115 mask=68 (E|W) deg=2; 116 mask=64 deg=1. **No cell of degree ≥ 3 exists on the board**, so "approaching intersection" is inapplicable.
- Committed routes: car 0 len=6 → six W steps; car 1 len=6 → six W steps; car 2 len=3 → three W steps. **Every consecutive route step is the same direction**, so there is no 90° and no 135° turn anywhere.

Plain-cell speed stays `speedUnits(1000) = 330`. Task 4 adds no state region. **The loop golden does not move in Task 4.**

Two harms follow. The loud one: an implementer told the golden must move edits the fixture until it does, retiring the four-route cost matrix the file's leading vacuity test exists to protect. The silent and worse one: by the time Task 4 runs, the loop golden has *already* moved twice for unrelated and wrong reasons — Task 2's region (C2) and Task 3's head-on deadlock (C4) — and Task 4's standing licence tells the implementer that movement is expected and to re-bless it. That converts a genuine behavioural regression into an authorised hash update, defeating the cross-file scan at `loop.test.ts:772-790` that exists precisely to make a quiet re-bless expensive.

**Witness.** `packages/sim/test/loop.test.ts:60-100` (fixture: "One straight road corridor along row 5, from x = 2 to x = 16", "Every step is orthogonal"), `:232-236`, `:761`, `:772-790`; `packages/sim/src/cars.ts:99-101` (`speedUnits`).

**Change to the plan.** In Task 4, replace:

> a straight run through a plain cell is unchanged from M1c's timings — **and the loop golden must therefore move; say so and re-bless once, in this task only.**

with:

> a straight run through a plain cell is unchanged from M1c's timings. **The loop fixture is a single straight corridor on row 5 with no cell of degree ≥ 3 and no direction change in any committed route, so none of the three multipliers applies to it and this task must not move any golden.** If a golden moves in Task 4, stop and report: it means a multiplier is being applied where no turn or junction exists, or it is leaking into `edgeCost` and the field golden with it.
>
> The multipliers need their own fixture. Build one with a right-angle turn, a 135° turn, and a degree-≥ 3 junction, with hand-computed arrival ticks for each, and give it a new golden of its own. Leave the loop golden alone.

Add to Task 4's coverage:

> the field golden `252514232` does not move — multipliers apply to movement speed (`speedUnits` into `advanceCar`), never to `edgeCost`, so routing and the flow field are untouched. `edgeCost`'s value set stays `{10, 14}`, which is what `NB`, `DISTINCT_EDGE_COSTS`, `COST_UNIT_SCALE` and `CAR_SPEED_UNITS_PER_TICK` are jointly calibrated against (`constants.ts:166-169`).

Add to Task 4's mutations:

> apply a multiplier inside `edgeCost`; the field golden must then move.

Also state the turn classification, which the plan never defines and which two lenses flagged as ambiguous. Add after "Right-angle 0.667, approaching intersection 0.5, sharp turn 0.333":

> On the 8-direction lattice a turn is 45°, 90°, 135° or 180°. **45° carries no multiplier** (the table's default lane speed 1.0); **90° is the right angle**; **135° is the sharp turn**, the sharpest the lattice admits; **180° is unreachable** within a leg (the downhill walk cannot produce a 2-cycle) and is not emitted across the outbound→return flip, since the first step of the new leg has no in-leg predecessor. **"Approaching intersection" means the cell being entered has road degree ≥ 3**, computed by a read-only helper in `graph.ts` — that is the only change `graph.ts` takes in this task. The multiplier applies to the cell being entered and scales the threshold for crossing it.

---

### C9. The valve's per-car blocked-tick counter has no region, no width, and no home for its constant

**Lenses:** scope, determinism, coverage.

**What breaks.** `MAX_BLOCKED_TICKS = 1350` requires a per-car counter that survives across ticks, snapshot/restore, and a cold Worker replay. Task 3's Files are `blocking.ts`, `cars.ts`, `trips.ts` — no `state.ts`, no `regions.ts`, no `shared/src/constants.ts`. Tasks 2 and 5 each explicitly say "`state.ts` (one region)"; Task 3's silence reads as "this task adds no buffer shape."

It cannot live anywhere else. Decision 6 forbids the one place it could hide (`carProgress` is held at the threshold, and "accumulate progress while blocked" is a Task 2 mutation). Every existing per-car region is occupied. `Scratch` is disqualified but **quietly**: it is rebuilt per tick, so a Scratch-resident counter resets and the valve never fires in a Worker replay while it does fire in a browser — the exact browser-vs-Worker divergence the product exists to prevent. And nothing in the plan or the suite would catch it: Task 3 has no snapshot/restore coverage bullet (conspicuously, since Tasks 2 and 5 both do), Task 7's determinism budget is "two identical runs agree on `hashState`" (two *warm* runs), and the existing cold-replay arm restores at tick 30 and runs to 150 — a counter that only matters at 1,350 is invisible to it.

Width matters too: 1,350 > 255, so a `Uint8` element can never reach the threshold and the valve simply never fires. `Int16` is the minimum honest width. This is the same hazard class Task 1d exists to police.

`MAX_BLOCKED_TICKS` also has no home. The Global Constraints put rule constants in `packages/shared/src/constants.ts`, a file listed in Task 4 and not Task 3.

**Witness.** Plan Task 3 Files vs Tasks 2 and 5; `packages/sim/src/state.ts:174-197`, `:209-214`, `:237-262`; `packages/sim/src/regions.ts:28-63`, `:81`, `:105-123`; `packages/sim/test/regions.test.ts:82-95` (the union assertion), `:47`, `:52-78`; `packages/sim/test/rollback.test.ts:25`.

**Change to the plan.** Amend Task 3's Files to:

> **Files:** `packages/sim/src/blocking.ts`, `cars.ts`, `trips.ts`, `dispatch.ts`, `regions.ts` (**one region**), `state.ts`, `packages/shared/src/constants.ts`, and their tests, plus the goldens listed in "Why two re-blesses are true" — **this task adds a third region, so those four goldens move a third time and this task re-blesses them.**

Add to Task 3, under "The valve":

> The valve needs a per-car consecutive-blocked-tick counter. It is a **state-buffer region** — `Int16Array`, length `maxCars`, classified FIELD_IRRELEVANT with a dated reason alongside the other car regions. It must not live on `Scratch`: `Scratch` is rebuilt every tick, so a Scratch-resident counter resets, the valve fires in a browser and never in a Worker replay, and no test in this plan or the suite would see it. It must not be `Uint8`: 1,350 > 255, so the threshold is unreachable and the valve never fires at all.
>
> `MAX_BLOCKED_TICKS = 45 * TICKS_PER_SECOND` lives in `packages/shared/src/constants.ts` with the other rule constants, derived rather than written as a literal.
>
> The counter increments on a tick where the car's entry is refused and **resets to 0 on any successful entry, including the valve's own**. It is therefore a duration for the current blockage episode, bounded by 1,350.

Add to Task 3's coverage:

> the counter is a hashed state region: a snapshot taken mid-jam and restored produces byte-identical subsequent behaviour, and the valve fires at the same absolute tick in the restored run as in the uninterrupted one — build this with `fields` and `scratch` cold-rebuilt on the restore, as `loop.test.ts:660` does, since that is what a Worker cold-starting a replay holds.

Add to Task 3's mutations:

> put the counter on `Scratch`; make it `Uint8`; never reset it on a successful entry.

Finally, fix Task 3's vacuity self-check, which asks for a switch that does not need to exist:

> **Vacuity self-checks:** the queue fixture's cars must be genuinely blocked by each other and not by geometry; the gridlock ring must actually deadlock without the valve — **assert that by running the ring to blocked tick 1,349 and observing no movement**, which is the no-valve world by construction and needs no test-only disable seam.

---

## Importants

### I1. Decision 6 does not state the value a blocked car stores, and one reading draws every queued car a full cell forward

**Lenses:** mechanism, determinism, scope.

"Holds its progress at the threshold" admits three implementations with different bytes: (a) `carProgress := threshold`; (b) skip the `+= speed` and leave progress where it was; (c) clamp before the add, which yields residual 0 on release — the carry-dropping bug `cars.ts:41` explicitly forbids. Four independent readers produced three incompatible writes from that one sentence.

They differ observably. Reading (a): `2500 + 330 = 2830`, residual 330, next crossing in `ceil(2170/330) = 7` ticks. Reading (b): `2310 + 330 = 2640`, residual 140, next crossing in `ceil(2360/330) = 8` ticks. Same release tick, one-tick divergence on the very next crossing and every one after. Task 3's "hand-computed arrival ticks" and Task 7's "hand-computed figures" are not computable from the plan as written.

Reading (a) also has a rendering consequence no task owns. `resolve.ts:185-188` computes `f = carProgress / (edgeCost(dir) * COST_UNIT_SCALE)` and draws at `cell + DX*f`, unclamped. At `progress === threshold`, `f = 1.0` — the car is drawn at the **next** cell's centre. A standing queue therefore shifts forward exactly one cell uniformly (spacing is preserved, so the "stack of four cars" reading is wrong), but the head of every queue overlaps its moving blocker whenever that blocker is under `f = 0.5`, about the first 3.8 of its 7.6 ticks — a repeating ~40 % duty-cycle overlap with up to ~74 % area coincidence. Task 6 asserts the opposite without checking ("Queued cars need no new rendering — they are cars at positions"), and `packages/game/src/resolve.ts` appears in no task's file list.

**Change.** In Decision 6, replace "A blocked car **holds its progress at the threshold** rather than accumulating" with:

> A blocked car **does not accumulate**: on a tick where its entry is refused, `carProgress` is left exactly as it was and `speed` is not added. Do not write `carProgress = threshold`: that discards up to 329 units, and it makes the rendered `f = carProgress / (edgeCost(dir) * COST_UNIT_SCALE)` exactly 1.0, drawing the car at the centre of the cell it has *not* entered — one full cell forward, on top of the car it is waiting for. Leaving progress untouched keeps `f < 1`, needs no renderer change, and the displacement on release is the ordinary 330/2500 = 0.132 cells, inside M2's 0.13334 envelope.

Add to Task 2's coverage:

> across a multi-tick block, `carProgress` is bit-identical on every blocked tick to its value on the tick the block began; and a blocked car's resolved render position (`packages/game/src/resolve.ts`) stays strictly inside its own cell — `f < 1`.

Add `packages/game/src/resolve.ts` and its test to Task 6's Files, with the mutation "clamp a blocked car's progress to the threshold; the render position must then leave its cell."

---

### I2. The allocation harness never moves a car, so every branch M1d adds is profiled at zero executions

**Lenses:** mechanism, determinism. Both measured.

The Global Constraint calls the zero-allocation rule "mechanically enforced… scoped to `game`, `render` and `sim`." Two reviewers rebuilt `allocation.test.ts`'s rig verbatim (same seed, shell, pointer, erase control, `driveWithDrag` stroke) and instrumented it. Over 1,752 ticks:

```
{"tick":1752,"phases":{"0":74,"1":6},"routeLens":[0,0,0,0,0,0,0,0],
 "moves":0,"framesWithMoving":0,"roads":30}
maxActive = 0, totalCellCrossings = 0, carPhase = [1,1,1,1,1,1]
```

**Not one car ever moves.** All six live cars sit in `PHASE_IDLE` for the entire run. Two structural causes: the stroke paints in the revealed rect's top-left corner and never connects a house to a destination, and the 30-tile budget is exhausted within the first few strokes so every later `place` is refused — which is exactly why `canPlaceRoad` shows up (it allocates on the refusal path) while nothing downstream of it does.

So the gap is not "no jam." **The entire per-tick car-movement path in `sim` is unreached by the only harness that profiles `sim`** — which is where M1d puts all of its new code: the occupancy write/clear, `canEnter`, the blocked-hold branch, the valve, the carpark queue, the multiplier averaging, the ghost check. Every one measures clean at 0.00 B/frame no matter what it does. `assertScopeResolves(all, SIM_SRC)` returns `[]` vacuously.

`m1d-carry-forward.md:57` instructs this directly — *"M1d inherits a real harness (M2 Task 6) — use it for the tick as well as the frame"* — and no task carries it. Task 1 is the only owner of `allocation.test.ts`, and its own text says "Do these first, before any blocking logic touches the same files," so it runs before the branches exist.

**Change.** Add to Task 7:

> **Tick-side allocation profile.** Task 7 owns the carry-forward's instruction to use the harness for the tick as well as the frame. The existing rig in `packages/game/test/allocation.test.ts` never moves a car — its 30-tile budget is spent before any house is connected to a destination, and over 1,752 profiled ticks all six cars stay `PHASE_IDLE` — so every branch this milestone adds is currently profiled at zero executions and measures clean regardless of what it does.
>
> Profile `step` directly over Task 7's jam fixture with `SIM_SRC` scope (no frame loop needed), using hand-placed roads rather than pointer strokes so the network actually connects. Gate it on **per-branch entry counters asserted non-zero**, in the same style as the existing `DragCounters`: cars dispatched, `canEnter` calls, `OCCUPIED` returns, valve firings, carpark refusals, ghost cells refused, cells with a queue ≥ 3. A fixture that stops jamming must turn the harness red rather than quietly measuring less. Include a positive control: reinstate one escaping object inside the blocking path and confirm it appears by name.

---

### I3. The Global Constraint misnames its own enforcement: `render` is a different harness, and Task 6's ghost pass has no profiler that can see it

**Lenses:** coverage, scope, determinism.

`allocation.test.ts:337` sets `PROFILED_SCOPES = [GAME_SRC, SIM_SRC]` — no render — and `:751` pins that exact two-element list, so widening it is a deliberate, tested act. Render is covered by `packages/game/test/drawAllocation.test.ts` (`RENDER_SRC`, its own `CANVAS_BUDGET_BYTES_PER_FRAME = 32`). `allocation.test.ts` also passes a **no-op draw** (`:487`, `:1042`), so it could not execute `render/src` even if the scope were widened, and its own comment at `:642-643` disclaims render explicitly.

Task 6's "nothing allocates per frame" bullet targets a new ghost pass in `packages/render/src/canvas.ts`. An implementer following the Global Constraint runs `allocation.test.ts`, gets a green that is guaranteed, and ticks the bullet. The constraint's own "confirm it is live by injection" instruction makes it worse: injecting an allocation into the ghost pass leaves that file green, which reads as an inert harness.

`drawAllocation.test.ts` is not vacuous-free either — its driver is a fixed 4-cell road with 6 cars and 3 pins, count-asserted at `:283-308`, and contains no ghost cell.

**Change.** In the Global Constraints, replace the allocation bullet with:

> - **Nothing allocates inside a tick or a frame.** Two harnesses, not one: `packages/game/test/allocation.test.ts` covers `packages/game/src` and `packages/sim/src` (its `PROFILED_SCOPES` list is pinned at `:751`, and it passes a no-op draw, so it cannot see `render`), and `packages/game/test/drawAllocation.test.ts` covers `packages/render/src` with its own budget and its own rig. A change to the draw path is measured by the second file, not the first. Confirm the relevant one is live by injection before trusting a green result — the first was silently inert in every worktree for two tasks of M2. Both are claims about the inputs they were given: see Task 7's tick-side profile and Task 6's ghost driver.

Add to Task 6's Files: `packages/game/test/drawAllocation.test.ts`. Add to Task 6's coverage:

> the ghost pass is profiled by `drawAllocation.test.ts`, whose driver must contain at least one ghost cell for the profiled frames — assert that count non-zero alongside the existing road/car/pin counts, or the budget is vacuous for this task. A ghost is transient (it clears when the last committed car leaves), so the driver must hold one across the profiled window, e.g. by re-erasing under a blocked car.

---

### I4. Task 1a requires a detector that provably cannot exist for one of the four bounds

**Lenses:** mechanism, coverage, scope. Verified exhaustively.

Task 1a requires "the four bounds are each independently detected from *both* callers," and its mutation line requires "revert each `stepCell` bound, from each caller" — eight pairs. Two of the eight are provable no-ops.

With the `x` guards retained, every `y ≤ -1` yields `y*w + x ≤ -1`. Both callers collapse every negative to one observable: `cars.ts:222-233` throws on `next < 0` with a message interpolating `carCell[i]` and `dir`, never `next`; `dispatch.ts:504-505` does `if (next < 0) break`. A reviewer re-ran the exhaustive check: 1,600 geometries × all in-range cells × Int32 extremes × 8 directions gave **97,040 raw return-value differences and 0 differences in the sign** — no observable difference at either caller, on any axis.

The production source already says so (`dispatch.ts:315-322`: "the caller's own `if (next < 0) break` masks the `y < 0` bound completely. Direct calls observe all four"), as does `m1d-carry-forward.md:55`, and both existing test files already disclose it in prose. The other three bounds *are* caller-observable: `y >= h` yields `h*w + x`, positive, which `next < 0` misses — in `cars.ts` it writes a wrong cell, and in `dispatch.ts` it reaches `packRouteStep(..., undefined)` and throws (`field.dir` is `Int8Array(cells)`).

The cheapest way to satisfy the bullet as written is to tighten `if (next < 0)` to `if (next === -1)` at both call sites — behaviourally identical today, and a strict weakening of two guards this milestone is about to hand a third caller. That is a test-driven regression.

**Change.** In Task 1a's coverage, replace "the four bounds are each independently detected from *both* callers" with:

> all four `stepCell` bounds are independently detected by **direct calls**; the three caller-observable bounds (`x < 0`, `x >= w`, `y >= h`) are additionally detected **through each caller**; and `y < 0` carries a source comment recording it as a **verified equivalent mutant through either caller** — with the `x` guards retained, any `y ≤ -1` gives `y*w + x ≤ -1`, and both callers reduce every negative to one observable (`cars.ts` throws without interpolating `next`; `dispatch.ts` breaks). Do not manufacture a detector for it, and in particular do not tighten either caller's `next < 0` to `next === -1` — that would satisfy the bullet by weakening two guards.

Amend the mutation line to "revert each `stepCell` bound directly; revert the three caller-observable bounds from each caller."

---

### I5. Board expansion is assigned to M1d in nine source sites and appears in neither the scope nor the deferral table

**Lenses:** mechanism, coverage. See §7.

**Change.** Add a row to the Out table:

> | Board expansion / the dynamic revealed rect (§5.1) | M1e | M2's own deferral table handed this to M1d by name; no M1d task needs it, and a revealed region in state would move the goldens a third time. Moving it to M1e requires repointing the nine source comments that name M1d — see "Unassigned work" |

and add to Task 7's Files and coverage:

> repoint the nine M1d-tagged comments that this milestone declines: `packages/shared/src/constants.ts:72,75`, `mapFormat.ts:21`, `maps/firstCity.ts:9`, `packages/render/src/types.ts:124`, `canvas.ts:321,344,557`, `packages/game/src/shell.ts:173`, `packages/shared/test/constants.test.ts:102`, `packages/game/test/frame.test.ts:207,237-242`. A comment that names a milestone which passed is worse than no comment — it reads as satisfied.

---

### I6. `regions.ts` and `regions.test.ts` are where regions actually live, and no task names them

**Lenses:** mechanism, determinism.

Tasks 2 and 5 both say "`state.ts` (one region)." `regionsFor`, `FIELD_INPUT_REGIONS` and `FIELD_IRRELEVANT_REGIONS` are all in `packages/sim/src/regions.ts`; `state.ts` holds only the interface, `REGION_FIELD_NAMES`, and `viewsOver`'s three parallel spots. A task that edits only `state.ts` fails to type-check or throws `state layout: no view constructed for region "…"` at `state.ts:209-214`.

Four assertions in `regions.test.ts` break on any new region: the union/exhaustiveness check (`:82-95`), `totalBytes === 7908` (`:47`), the ordered 22-name list (`:52-78`), and the FIELD_INPUT exact-set pin (`:121`, which fires if occupancy *is* classified FIELD_INPUT — see C1). `regions.test.ts` is in no task's file list.

Every failure here is loud and immediate, which is why this is Important rather than Critical. Fixed by the Files-line amendments already given in C2, C7 and C9.

---

## Minors

1. **Task 5 contradicts a pinned existing test with no flag.** `packages/sim/test/cars.test.ts:586-628` asserts erasing under an in-flight car refunds **immediately** (`tilesLeft(state) === 991` on the erase tick) — M1c's stated deviation, whose own comment says "deferred to M1d." Task 5 reverses it but names neither the test nor the stale doc comments at `cars.ts:29-33` and `roads.ts:65-69`. Also, Task 5's first bullet says "erasing an **unoccupied** road refunds immediately," which collides with Task 2's `OCCUPIED` vocabulary; say "no committed car" (already fixed in C7's rewrite).
2. **`state.ts:306-315`'s all-zero prose goes stale** the moment the `-1` fill lands, along with its mirror at `state.test.ts:374-375`. Covered by C6's change; listed here so it is not dropped.
3. **`packages/game/src/main.ts:152`** documents `2505371110` and the rejected `4171132894` in prose nothing greps. Covered by C2's change.
4. **Task 3's carpark pin bullet holds by construction.** Arrival is cursor-driven (`runArrivals` gates on `cursor >= carRouteLen`) and `carRouteCursor` advances only inside `advanceCar` on an actual crossing, so a blocked car cannot consume a pin without new code. Say so in Task 3, and record the mutation "consume the pin on block" as hand-applied with its named observers (it breaks `sum(destReserved) === count(PHASE_OUTBOUND)`, and the next car's `assertArrivalHonoured` throws by name).
5. **Task 1d has no subject at the time it runs.** The only `Uint8Array` decrements today are `destPins`/`destReserved` in `arriveAtDestination`, both already guarded and already unit-tested, and Task 3's carpark rule adds none. The genuine new decrement path is Task 5's `ghostCommitted` (C7). Restate 1d as a standing obligation with a named recipient: "Task 5's `ghostCommitted` decrement carries this guard; verify at the end of the milestone that no other new decrement path exists."
6. **No occupancy/`carCell` consistency invariant is requested.** `destReserved` — the same shape, a redundant counter in the hashed buffer — has its global invariant asserted twice in this plan. Occupancy gets none. Covered by C5's `assertOccupancyConsistent`; noted here because the asymmetry is the argument.
7. **Task 4's `graph.ts` role is unstated**, and `scratch.ts:26-31` / `:47` and `constants.ts:47,167` still predict M1d motorway/chunk penalties that this plan defers to M1e. State the role (C8) and repoint those comments.
8. **Task 7's "the M1c baseline on the same fixture"** reads as a recorded run of a fixture that does not exist. It is the hand-computed unblocked figure named in the preceding clause; say so.

---

## Deduplicated across lenses

Findings two or more lenses reached independently, listed by breadth. Convergence at four lenses is the strongest signal in this review.

| # | Finding | Lenses |
|---|---|---|
| C1 | Occupancy classified FIELD_INPUT → per-tick Dijkstra storm; premise false and contradicted by a dated in-code classification | mechanism, determinism, coverage, scope |
| C2 | Two new regions move four of five goldens; no task authorises the re-bless; cross-file guard and a `packages/game` golden unowned | mechanism, determinism ×2, coverage, scope |
| C5 | Valve's shared-cell state unrepresentable in one slot; release rule unspecified; unconditional release corrupts the array | mechanism, determinism, coverage, scope |
| C6 | Occupancy lifecycle for stationary cars unowned — creation fill, dispatch, idle siblings, arriving home | mechanism, determinism, coverage, scope |
| C3 | Head-on deadlock from an undirected slot; every return leg retraces its outbound corridor | mechanism, determinism, coverage |
| C4 | The loop fixture deadlocks at tick 73; every hand-computed literal in it becomes unreachable | mechanism, coverage, scope |
| C7 | Ghost mechanism: "committed" undefined, `canEnter` cannot express it, road bits unsettled, re-place exploit | mechanism, coverage, scope, determinism |
| I1 | Decision 6 ambiguous about the stored value; `f = 1.0` renders a blocked car a cell forward; `resolve.ts` unowned | mechanism, determinism, scope |
| I4 | `y < 0` is a proven equivalent mutant; Task 1a's "both callers" bullet is unsatisfiable | mechanism, coverage, scope |
| I3 | Global Constraint misnames the allocation harness; `render` is a separate file; Task 6's bullet unverifiable | coverage, scope, determinism |
| C8 | Task 4's loop-golden claim is false; no multiplier applies to that fixture | coverage, determinism |
| I2 | Allocation harness never enters any new branch — measured, never moves a car at all | mechanism, determinism |
| I5 | Board expansion assigned to M1d in source, neither scheduled nor deferred | mechanism, coverage |
| I6 | `regions.ts` / `regions.test.ts` in no file list | mechanism, determinism |

---

## Refutations worth a second look

Three refutations were correct on their own terms but should not be read as broader than they are.

1. **scope/C4 (head-on on the shipped starting city) was refuted by measurement, and the refutation is sound but narrow.** A reviewer ran `firstCity` + `seedStartingCity` + a 14-segment column-8 road for 45,000 ticks and measured `maxActive = 1` — never two simultaneous cars on that corridor, zero adjacent-opposing events, zero swaps. That refutes the specific claim that *today's shipped city* jams, and it is worth knowing: utilisation is ~20 % with six cars and no spawner. It does **not** touch C3, whose witness is the carpark dead-end and the two-cars-of-one-house case, both reachable from a two-pin fixture. Do not let the measurement be quoted as "head-on is not a problem" — it means "head-on is not yet visible on the seeded board," which changes the day M1e's demand ramp lands.

2. **coverage/C3 was downgraded to Important on the grounds that no existing test goes red.** That is true and is exactly why it should stay Critical: the three other lenses reached the same finding, and "correct answers, dead coalescing, green suite" is this project's canonical silent failure (`state.ts:24-34` was written about it). The downgrade rests on "not a wrong result," but the plan mandates tests that lock the wrong classification in, which makes the later fix a red-test negotiation rather than an edit.

3. **mechanism/C12 (board expansion) was downgraded to Minor; coverage/C13 kept it Important.** The Minor argument is good — four of the nine sites explicitly say no work is needed there, and executing the plan yields a working M1d either way. The Important argument is better on one point the Minor missed: `plans/2026-08-04-m2-playable-renderer.md:56` is a formal **deferral-table row** reading `| Map expansion / a real revealed region | M1d | …M1d makes it dynamic |`. A table-row handoff declined in silence is the precise failure this review exists to catch, so it is filed at Important with a comment-sweep owner (I5).

Two refutations I would flag as slightly over-confident, though I accept both verdicts: **mechanism/C5** (valve counter home) was refuted as Minor plan hygiene on the argument that "an implementer would add the region anyway" — but the Scratch branch is silent, and scope/C6 reached Critical on that basis; the merged C9 above takes the stronger reading. And **scope/I13** (nobody writes the M1e carry-forward) was refuted on base rates — no prior plan owned that artifact and it got written anyway — which is correct, but it means the channel is process, not plan, so every item in "What this plan does not settle" plus the C2 re-bless record depends on that process running. Worth one line in Task 7.

---

## Unassigned work — the fifth gap

**There is a fifth instance of the M2 pattern, and it is the literal one: a formal handoff, in a deferral table, declined in silence.**

`plans/2026-08-04-m2-playable-renderer.md:56` contains the row:

> `| Map expansion / a real revealed region | M1d | Task 3 freezes the revealed rect as four constants. M1d makes it dynamic |`

restated in M2's Decision 5. Nine source sites now say the same thing in the imperative: `packages/shared/src/constants.ts:72,75` ("**Frozen constants, and M1d owns making them dynamic**… When M1d lands, the camera reads state instead of these four numbers"), `mapFormat.ts:21`, `maps/firstCity.ts:9`, `packages/render/src/types.ts:124` ("**M1d owns making it dynamic**"), `canvas.ts:321,344,557` ("the thing M1d must revisit… the fix then is a `clip` around phases 3-7"), `packages/game/src/shell.ts:173`, `packages/shared/test/constants.test.ts:102`, `packages/game/test/frame.test.ts:207,237-242`.

The M1d plan mentions it nowhere — not in Scope In, not in the Out table whose stated purpose is "named so the gap is not read as an oversight," not in "What this plan does not settle." `m1d-carry-forward.md` omits it too, so both handoff documents dropped it and the nine comments are the only surviving record. They are phrased as "M1d owns/does this," so once M1d is stamped done they read as satisfied. That is how the bot URL went stale.

Deferring is the right call — no M1d task needs it, and a revealed region in state would move the goldens a third time — but deferring silently is the failure. Fix per I5: one Out-table row, and a comment sweep owned by Task 7.

**Three more items are unowned, and each is folded into a change above rather than left to "someone":**

- **Redesigning `loop.test.ts`'s fixture** for a world where cars cannot pass through each other. The fixture dies at tick 73 in Task 2 or 3; Task 4 owns only the hash literal; Task 7 lists the file but its body is about a new jam test. → new **Task 3b** (C4).
- **The tick-side allocation profile.** `m1d-carry-forward.md:57` instructs it in as many words — "use it for the tick as well as the frame" — and no task carries it. Task 1 is the only owner of `allocation.test.ts` and runs before the branches exist. Measured: the rig never moves a car, so 100 % of M1d's new code is profiled at zero executions while the milestone claims mechanical enforcement. → **Task 7** (I2).
- **The four-golden re-bless and its cross-file guard.** Three test files across two packages, in no task's list, behind a Global Constraint that says halt. → new **"Why two re-blesses are true"** section plus Files-line amendments (C2).

One more worth a line in Task 7, since the channel is process rather than plan: **nothing writes `m1e-carry-forward.md`.** Every item in "What this plan does not settle," Decision 1's "the cost is real and must be recorded, not discovered later," the two re-bless records, and the board-expansion deferral all reach M1e only through that document. It has been written at every prior milestone close without a task owning it — but it has also never carried this much.
