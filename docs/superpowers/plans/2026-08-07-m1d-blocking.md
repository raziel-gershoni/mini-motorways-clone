# M1d: blocking and gridlock — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make road layout matter. Cars queue, yield, back up, and strangle a badly-built city — from one primitive, with no collision physics.

**Architecture:** Spec §5.5's single blocking question — *does an inbound vehicle collide with a traversing vehicle on this chunk?* — implemented as per-cell occupancy in the state buffer, resolved in ascending car index within one tick. Queueing, give-way, carpark queues and emergent gridlock all fall out of it. Plus lane-speed multipliers, delayed refunds, and four structural items M1c and M2 handed forward.

**Tech stack:** TypeScript, zero runtime dependencies, integer-only in `sim`, Vitest.

---

## Global Constraints

- **Zero runtime dependencies.** Integer-only arithmetic in `sim`; no module-scope mutable state; module-scope literal data `Object.freeze(... as const)`. Three mechanisms enforce this, including custom AST lint rules.
- **Rule constants are integers over a denominator of 1000**, converted only in `constants.ts`.
- Cell index convention is `index = y * w + x`.
- **Nothing allocates inside a tick or a frame.** This is now **mechanically enforced** by `packages/game/test/allocation.test.ts` (`node:inspector` `HeapProfiler.startSampling`), scoped to `game`, `render` **and `sim`**. Confirm it is live by injection before trusting a green result — it was silently inert in every worktree for two tasks of M2.
- **`render` imports nothing from `sim`.** Enforced by a source scan whose one real catch is a raw relative path.
- **All five goldens must hold** unless a task says otherwise: state `2413319809`, road-network `2790151213`, field `252514232`, loop `3896659943`, seed `2505371110`. **If one moves and your task did not say it would, stop and report — do not re-bless.**
- Do not modify `spike/`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## Scope

**In:** per-cell occupancy and the blocking check; queueing and give-way as emergent consequences; carpark queues; the anti-deadlock valve; lane-speed multipliers wired to a real caller; delayed refunds and ghost roads (§5.11); rendering queued cars and ghosts; and four inherited structural items.

**Out, and named so the gap is not read as an oversight:**

| Deferred | Owner | Why |
|---|---|---|
| Traffic lights, roundabouts, motorways | M1e | All three are upgrade *cards*. There is no card mechanism yet |
| Bridges and tunnels | M1e | Same |
| Overcrowd failure, game over | M1e | M1d makes cities strangle; M1e makes that cost you the run |
| Weekly demand ramp | M1e | Difficulty tuning needs blocking to exist first, which is why M1d is before M1e |
| Persistence | M3 | |

**M1d does not add a lose condition.** After it, a badly-built city visibly jams and throughput collapses — and nothing punishes you for it. That is deliberate: M1e's overcrowd threshold is calibrated against how much traffic a network can actually move, and tuning it against a world where cars pass through each other would mean tuning every number twice.

---

## Six design decisions

### 1. One car per cell, and the density cost is stated rather than hidden

Spec §5.5 says **1 car per 0.5 tile, minimum gap 0.35 tile** [OURS] — two cars per cell. **M1d ships one car per cell.**

The reason is that two cars per cell requires sub-cell slots, and a slot's identity depends on travel direction, which differs per car and changes at every turn. That is a second positional system alongside `carProgress`, and it would have to be deterministic, allocation-free, and correct across the outbound→return flip. One car per cell needs a single `Int32Array` and one comparison.

**The cost is real and must be recorded, not discovered later: road capacity is half what the spec's density implies.** If M1e's tuning finds throughput too tight, the fix is a genuine change with genuine tests — not a constant nudge. Do not add a `CARS_PER_CELL` constant "for later": an untested second value is dead code that reads as a supported configuration.

### 2. Contention resolves within one tick, in ascending car index — no timestamps

Spec §5.5 describes chunks tracking "inbound vehicles with a committed timestamp". That mechanism exists to order claims that arrive at different continuous times. **Our movement is discrete: a car either enters a cell this tick or it does not.** So a timestamp adds a field and orders nothing that ascending car index does not already order.

**Ascending car index is therefore outcome-visible for the first time**, and M1c's carry-forward predicted exactly this: *"the invariant that makes iteration order invisible is exactly what M1d's blocking will break."* Arrivals already iterate ascending and it was pinned then for this reason. Pin it here too, and **this time it is observable** — two cars contending for one cell produce different survivors under different orders.

### 3. The anti-deadlock valve is what makes gridlock a slowdown rather than a freeze

Spec §5.5: **max wait at an intersection before proceeding anyway is 45 s** — 1,350 ticks at 30 Hz. A car blocked that long moves regardless of occupancy.

This is not a safety hack, it is the mechanic: it means a gridlocked city grinds rather than stops, which is what makes the failure legible and recoverable. **It also guarantees no car is ever stuck forever**, which matters because a permanently frozen car would hold a reservation and starve a destination.

Two cars may briefly share a cell when the valve fires. That is accepted and must be **asserted as reachable**, or the valve is untested.

### 4. Lane-speed multipliers get their first caller here

`speedUnits` has been covered since M1c against a hand-written literal table at `mul ∈ {333, 500, 667, 1000, 2000, 3000}` — deliberately as a unit test, because every non-identity multiplier belonged to a later milestone. **Under the loop test alone the rounding rule is dead code and "change the rounding direction" survives everything.**

M1d wires: right-angle turn 0.667, approaching intersection 0.5, sharp turn 0.333. **Where several apply to one cell, average them** (§5.5) — not minimum. Averaging integers over `DENOM` needs a stated rounding rule and a test at a value where the two disagree.

### 5. A delayed refund is a per-cell pending state, not a queue

§5.11: deleting a road refunds in full, but the refund is **delayed while a car has committed to that segment**, and the tile renders as a thinner, lower-opacity ghost until the last committed car clears.

Model it as a per-cell `pendingErase` flag plus the existing occupancy: the refund fires on the tick the last committed car leaves. **A ghost cell is not traversable by a car that has not already committed to it** — otherwise erasing a road under traffic would be free capacity.

### 6. Blocking is checked at cell entry, never mid-cell

A car's position is `(cell, progress)`. It becomes blocked only at the instant it would cross into the next cell. A blocked car **holds its progress at the threshold** rather than accumulating — otherwise it launches a cell forward the moment the way clears, which reads as teleporting and breaks the interpolation invariant M2 established (largest ordinary gap 0.13334 cells).

---

## Task 1: The four inherited structural items

**Files:** `packages/sim/src/roads.ts`, `cars.ts`, `dispatch.ts`, `step.ts`, `packages/game/test/allocation.test.ts`, and their tests.

Do these first, before any blocking logic touches the same files.

**1a. Consolidate `stepCell` into `roads.ts`.** Two copies — private at `cars.ts:155`, exported at `dispatch.ts:324`. `roads.ts` already owns `OPPOSITE`, `dirBetween` and `inBounds`. M1c ruled to keep the duplication and paid for it: `cars.ts`'s copy had four dedicated tests and **`dispatch.ts`'s had zero, with all four bounds surviving** — the copy that got tested was not the copy dispatch used. Fold both in before adding a third caller.

**1b. Fix `canPlaceRoad`'s ~40 B per call.** Measured by the harness once M2 widened it to `sim`. **Its allowance asserts the allocation is still present, so this fix turns that test red — that is the signal to delete the allowance**, not to loosen it. The invariant is per call, not per frame: a per-frame figure encodes the driver's input density and moves ~2× between rigs.

**1c. Pin the two 0-detector phase transpositions.** `step.ts`'s `1↔2` and `2↔3` are inert for exactly one reason: no `TickAction` reads `H_TICK`. **If any task in this milestone adds one, both become real off-by-ones simultaneously with nothing to catch them.** Pin them now, before that happens.

**1d. Guard every new `Uint8Array` decrement.** `destPins` and `destReserved` are `Uint8`; an unguarded `--` at 0 wraps to 255 and excludes a destination from dispatch **forever**, because the counter can never exceed 255. M1c guarded both arms it had. M1d's queueing introduces new decrement paths.

**Coverage required:** both former `stepCell` call sites use the shared one and the four bounds are each independently detected from *both* callers; `canPlaceRoad` is absent from an idle profile and from a dragging profile; the phase transpositions each fail a named test; a fresh decrement path at 0 throws rather than wrapping. **The goldens must not move** — this task is a refactor plus tests.

**Mutations:** revert each `stepCell` bound, from each caller; reintroduce the `canPlaceRoad` allocation; swap phases 1↔2 and 2↔3; decrement a counter at 0.

---

## Task 2: Occupancy and the blocking primitive

**Files:** `packages/sim/src/blocking.ts` (new), `state.ts` (one region), `packages/sim/test/blocking.test.ts`.

One `Int32Array` region, one entry per cell, holding the occupying car index or `-1`. It is a **field input** — a car's presence changes routing viability — so it must be classified in the layout table and hashed, and the partition test must prove it is hashed rather than merely classified.

`canEnter(state, cell)` returns an **outcome code, not a boolean** — the house pattern established in M2, and the direct mechanical answer to this project's most-repeated defect family. At minimum: `FREE`, `OCCUPIED`, `GHOST`, `OUT_OF_BOUNDS`, `NO_ROAD`. A negative assertion satisfied by the wrong mechanism is impossible when the mechanism is in the return value.

**Coverage required:** a car entering a free cell succeeds; the same car entering an occupied cell returns `OCCUPIED` and does not move; the blocked car's progress is **held at the threshold**, not accumulated, and it advances exactly one cell on the tick the way clears — not two; occupancy is released on the same tick the car leaves; two cars contending for one cell resolve in ascending index and the loser is unmoved; the region is in the field-input partition **and hashed**; a snapshot/restore round-trips occupancy.

**Vacuity self-checks:** the contention fixture must have both cars genuinely able to enter — if one is blocked for another reason the order proves nothing; the held-progress fixture must run enough ticks that an accumulating implementation would visibly overshoot.

**Mutations:** return `FREE` unconditionally; release occupancy a tick late; release it a tick early; accumulate progress while blocked; resolve contention in descending index; omit the region from the field-input hash; classify it but do not hash it.

---

## Task 3: Queueing, carpark queues, and the anti-deadlock valve

**Files:** `packages/sim/src/blocking.ts`, `cars.ts`, `trips.ts`, and their tests.

Queueing is not implemented — it **emerges** from Task 2. This task proves that, adds the valve, and handles the carpark.

**The valve:** a car blocked for `MAX_BLOCKED_TICKS = 1350` proceeds regardless. Two cars then briefly share a cell, which is accepted.

**Carpark queues:** a destination's carpark is one cell, so arriving cars queue behind it on the road. **A car that cannot enter the carpark must not consume its pin** — the reservation is already held from dispatch, and consuming early would let a second car arrive at a destination with no pin left.

**Coverage required:** three cars behind a blocked leader form a queue and each advances in order when it clears, with hand-computed arrival ticks; a car blocked at a carpark holds its pin and consumes it only on entry; **the valve fires at exactly tick 1350 of blockage and not 1349**; two cars sharing a cell after the valve is asserted as reachable; a gridlocked ring of four cars all eventually move, none starves; `sum(destReserved) === count(PHASE_OUTBOUND)` holds throughout a jam.

**Vacuity self-checks:** the queue fixture's cars must be genuinely blocked by each other and not by geometry; the gridlock ring must actually deadlock without the valve — assert that by disabling it in the test and observing no movement.

**Mutations:** valve at 1349 / 1351; valve never fires; consume the pin on block rather than on entry; release the queue in descending order; let a blocked car skip a cell when the way clears.

---

## Task 4: Lane-speed multipliers

**Files:** `packages/sim/src/cars.ts`, `graph.ts`, `packages/shared/src/constants.ts`, tests.

Right-angle 0.667, approaching intersection 0.5, sharp turn 0.333. **Average where several apply**, not minimum (§5.5).

**This is `speedUnits`'s first production caller.** Until now the rounding rule has been dead code under the loop test.

**Coverage required:** each multiplier applied alone changes the arrival tick by a hand-computed amount; two applying together produce the **average**, tested at a value where average and minimum differ; the rounding rule is exercised at a value where rounding up and down differ; a straight run through a plain cell is unchanged from M1c's timings — **and the loop golden must therefore move; say so and re-bless once, in this task only.**

**Mutations:** take the minimum instead of the average; change the rounding direction; apply the intersection multiplier to a non-intersection; drop the `max(1, …)` clamp.

---

## Task 5: Delayed refunds and ghost roads

**Files:** `packages/sim/src/roads.ts`, `blocking.ts`, `state.ts` (one region), tests.

**Coverage required:** erasing an unoccupied road refunds immediately; erasing a road with a committed car refunds **on the tick that car clears**, not before and not later; a ghost cell is **not** traversable by a car that has not already committed to it; a ghost with two committed cars refunds on the second one's departure; the tile budget is exactly restored, never double-refunded; ghosts survive snapshot/restore.

**Vacuity self-checks:** the two-car ghost fixture must have the cars clear on *different* ticks, or "refund on the first departure" passes.

**Mutations:** refund immediately regardless; refund twice; never refund; let a new car enter a ghost; forget to clear the pending flag after refunding.

---

## Task 6: Rendering queues and ghosts

**Files:** `packages/render/src/canvas.ts`, `types.ts`, `packages/game/src/frame.ts`, tests.

`RenderFrame` gains ghost-cell state. Queued cars need no new rendering — they are cars at positions.

**Coverage required:** a ghost cell draws at reduced opacity and a **thinner** stroke than a live road, asserted against recorded state, both properties independently; a live road adjacent to a ghost is unaffected; the ghost layer respects the revealed rect **in both directions** — content at the far edge is drawn, content outside is not; nothing allocates per frame.

**Mutations:** draw ghosts at full opacity; at full width; skip the ghost pass; shrink the far bound.

---

## Task 7: Integration, golden, deploy

**Files:** `packages/sim/test/loop.test.ts`, `packages/game/test/integration.test.ts`, and the deploy.

**The end-to-end test must show a jam**, not merely that cars still arrive: build a two-lane bottleneck, saturate it, and assert throughput falls measurably below the unblocked case with hand-computed figures. **Guard it against degenerating** — cars dispatched > 0, at least one car blocked for ≥ 10 consecutive ticks, at least one queue of ≥ 3, and total trips strictly below the M1c baseline on the same fixture.

**Long-run:** ≥ 20,000 ticks with a deliberately bad network. Assert no car starves, `sum(destReserved) === count(PHASE_OUTBOUND)` every tick, no counter wraps, and two identical runs agree on `hashState`.

**Deploy:** verify the artifact, not the exit message — fetch the served bundle and grep a build-unique token, in both the HTML meta tag and the module script name, with both halves proven able to fail. **The Telegram Mini App URL is not settable through the Bot API** when the bot is configured via @BotFather; if the URL changes, that is a human action.

---

## What this plan does not settle

- **Whether one car per cell feels right.** It halves the spec's density. M1e's tuning is the first real evidence, and changing it is a change, not a constant.
- **Whether 1,350 ticks is the right valve.** It is the spec's 45 s at 30 Hz, unvalidated in play.
- **Frame cost under a full jam.** M2's only device evidence is qualitative and from a near-empty board. A hundred queued cars is the first workload whose cost scales with traffic.
