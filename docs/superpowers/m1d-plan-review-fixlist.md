# M1d plan review — **DO NOT EXECUTE. THE CORE PRIMITIVE IS WRONG.**

Four lenses, **124 findings: 48 Critical, 56 Important, 20 Minor.** 75 reached a refuter (45 refuted, 30 survived) before the session limit killed the remaining 49 and the synthesis agent. This list was written by hand from the run's journal; the raw findings are in [`m1d-plan-review-raw-findings.md`](m1d-plan-review-raw-findings.md).

**Verdict-to-finding mapping was lost.** Everything promoted below was found by **two or more lenses independently**, which is the strongest signal available without the refuters.

---

## The plan does not need fixing. Decision 1 needs replacing.

### CR1 — One car per cell cannot represent a bidirectional road. Every trip deadlocks head-on.
**All four lenses, independently.**

Spec §5.11: a road segment is **bidirectional, one lane each way**. A single occupancy slot per cell represents *one* lane, not two. And M1c commits routes at dispatch and **retraces the same route on the return leg** — so a returning car meets its own follower head-on on a shared single-lane cell.

This is not an edge case. **It is every trip on every dead-end approach**, which is every destination carpark. The 45 s valve is the only thing that resolves it, so the steady state is one car per 45 seconds per approach — a game that does not function.

**The fix is a redesign, not an edit.** The options, none of which the plan considered:
- **Occupancy per (cell, direction-of-travel)** — two slots per cell, keyed by whether the car is heading "outbound-ish" or "return-ish". Restores the spec's two lanes and makes head-on structurally impossible.
- **Occupancy per (cell, lane)** where lane is derived from travel direction — the same thing, stated in the spec's own vocabulary.
- Keep one slot and make roads one-way — a different game.

Whichever is chosen, **Decision 1's stated cost is also wrong**: the plan said "half the spec's road capacity". The real cost is that opposing traffic cannot pass **at all**.

### CR2 — The invariant is violated at tick 0, before anything moves.
**Four lenses.** `CARS_PER_HOUSE = 2` and both cars are created at `houseCell`. One car per cell is false in the seeded state of every existing fixture. **And nothing in the plan claims or releases occupancy at dispatch, arrival or trip end** — Task 2 defines `canEnter` and no task defines who calls it or when.

### CR3 — The existing loop fixture deadlocks at tick 73.
**Three lenses.** `loop.test.ts`'s hand-computed timeline, its four assertions and the loop golden all become unreachable in **Task 2**, which says goldens must hold.

### CR4 — Occupancy is not a field input, and classifying it as one rebuilds every flow field every tick.
**All four lenses.** I flagged this as a suspicion when dispatching the review and every lens confirmed it independently: the plan's own partition definition excludes it, and hashing it would make `syncFields` rebuild all five colours on nearly every tick for byte-identical output — **and make `flowfield.ts` allocate per tick**, against a now-mechanically-enforced constraint.

### CR5 — Adding any state region moves four of the five goldens, and no task authorises it.
**Four lenses.** Task 2 adds a region and says goldens must hold; Task 5 adds another; only Task 4 authorises a re-bless, and it authorises a *different* golden. Execution halts at Task 2.

### CR6 — The valve's accepted outcome is unrepresentable, and the natural release rule corrupts the array.
**Four lenses.** Decision 3 accepts two cars briefly sharing a cell. A one-slot `Int32Array` cannot hold that. Worse, release-on-leave then clears the slot when the *first* car departs, admitting a third and a fourth — permanent corruption, not a transient.

### CR7 — The valve's per-car blocked-tick counter has no region, and module-scope state is banned.
**Three lenses.** Task 3's file list contains no state region. The counter must be in the buffer to survive snapshot/restore, and nothing puts it there.

### CR8 — Lane-speed multipliers cannot live in `edgeCost`.
**Three lenses.** Turn multipliers depend on the *pair* of edges, not one edge, so they are structurally inexpressible there — and putting them there invalidates `NB`, `DISTINCT_EDGE_COSTS`, `COST_UNIT_SCALE` and `CAR_SPEED_UNITS_PER_TICK` together. Task 4 also never decides whether the multiplier enters **routing** or only **movement**; either answer breaks something its file list excludes.

### CR9 — Queued cars render one cell ahead, stacked on the car they are waiting for.
**Two lenses.** Decision 6 holds progress at the threshold — and M2 resolves a position as `cell + dir × progress/threshold`, so progress-at-threshold renders at **the next cell**: exactly where the blocking car is. A jam would draw as overlapping cars on the wrong cells.

### CR10 — Ghost rendering is not achievable as specified.
**Two lenses.** `DrawContext` has no alpha, and road strokes are **baked into the atlas at build time** — so "thinner, lower-opacity" is expressible in neither property Task 6 names.

---

## The fifth unowned gap — and it was found

**Board expansion / the dynamic revealed rect is assigned to M1d in five or six source files**, and appears in neither the In-scope list nor the deferral table. M2 hard-coded the revealed rect as a frozen constant and wrote "M1e owns making it dynamic"; the code says M1d. Nobody owns it.

**A sixth, of the same family:** *nothing in the milestone measures the cost of a jam.* One lens called it "the M2 'handed to nobody' failure, repeated verbatim" — M2's frame budget was qualitatively confirmed on a near-empty board, and a hundred queued cars is the first workload whose cost scales with traffic.

**A seventh:** `determinism.test.ts` and `rollback.test.ts` are owned by no task, in the milestone that first makes iteration order outcome-visible.

---

## Also flagged, not yet triaged

Twelve further Criticals and 56 Importants are in the raw file, including: `-1 means free` contradicting the all-zero creation invariant every golden depends on; Task 2's file list excluding `cars.ts`, where all its own coverage bullets live, and `regions.ts`, where regions are actually declared; the loop fixture having no turn and no intersection so **no multiplier applies and Task 4's golden does not move**; the averaging rounding direction being invisible after `speedUnits` for every combination of 667/500/333; and both Tasks 3 and 7 requiring code paths that disable blocking, which no task provides.

**Caution:** 49 findings never faced a refuter, and the refuters that ran killed **45 of 75 — 60%**. Treat anything single-lens and unrefuted in the raw file as unvetted.
