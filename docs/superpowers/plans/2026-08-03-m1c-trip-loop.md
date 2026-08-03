# M1c — The Trip Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A city that plays itself once it is populated. Buildings are **placed**, destinations request cars, houses dispatch them along a route committed at departure, cars drive that route out and retrace it home, trips complete, the score goes up — all deterministic, all replayable.

> The Goal line used to say "buildings spawn". It does not now. M1c ships **placement** — the validity rules and the writes. The authored spawn *schedule* is M1e, and a milestone judged against a spawner nobody wrote fails for the wrong reason. (Fix-list #34.)

**Architecture:** Buildings and cars are struct-of-arrays regions inside the state buffer. Demand is destination-pull on a per-colour round-robin driven by a drift-free accumulator. Dispatch reads the flow field the previous milestone built, once per colour per tick, and **commits a route** into the car's own storage. Movement follows that route and never reads a field. Nothing allocates per tick.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces. Zero runtime dependencies.

---

## Prerequisite

M1a and M1b are complete and reviewed: integer rule constants, a seeded RNG, a single-`ArrayBuffer` state container on a declarative layout, an exact clock, a pure `step()`, three determinism enforcement mechanisms, the map format with immutable terrain, a frozen buffer layout, road placement with per-cell budgeting and tree clearing, a traversable graph, and per-colour flow fields with content-derived staleness. **Goldens: state `1073292924` (`determinism.test.ts:473`), road-network `3183850973` (`rollback.test.ts:622`), field `252514232` (`rollback.test.ts:658`).**

Read `docs/superpowers/m1c-carry-forward.md` before starting. It records what M1b's reviews established, and Task 1 exists to act on it.

---

## What this rewrite changes, and why

This plan was reviewed adversarially before execution by three independent lenses (correctness, determinism, testability) and returned **"do not execute as written"**: 10 Critical, 21 Important. This is a rewrite, not a patch — the region list, the task boundaries and the tick order all moved. The three findings that reshaped it:

1. **Reservation deadlocked the deliverable.** The previous version said a reserved pin must leave the field's source set. With one destination holding one pin, that empties the source set; `computeFlowField` unconditionally does `dist.fill(INF); dir.fill(-1)` with **no early return for empty sources** (`flowfield.ts:108-110`); the old Task 5's "`dir === -1` does not move" then froze the car at its house on tick 1 of the plan's own end-to-end fixture. Resolved by decision 3 below.
2. **The return leg had no mechanism.** Fields are per-colour and seeded from pins. Nothing in the previous version routed a car to a *specific* house. When the last pin of a colour is consumed the field is all-`INF` and a returning car cannot move at all. Half the trip — the half scoring is defined on — had no algorithm, no region, no coverage bullet and no mutation. Resolved by decision 2 below, which also resolves (3).
3. **The plan silently resolved a spec contradiction.** Spec §3 decision 5 says cars path once and never re-route; §1 calls that omission "deliberate and load-bearing; it is the game". §5.4 implies a per-tick `dir` read. The previous version picked re-pathing without noticing there was a choice. See "Two places the spec contradicts itself" below.

Two further structural consequences, both of which change task boundaries:

- **The old "one re-bless in Task 2" claim was false.** `hashState` is FNV over the whole buffer (`state.ts:206-208`) and `stateBytesFor` derives from the region list, so appending *zero* bytes still moves the digest. Under the old task split the goldens moved in Tasks 2, 3 and 4, under a written rule saying they must not — which is precisely the pressure that produces a quiet re-bless. **The entire M1c region list is now declared, zero-initialised, in Task 1**, and every later task writes only behaviour into it. (Fix-list #3.)
- **The tick order had no slot for input application and none for the field sync.** `fieldFor` throws unless `syncFields` ran against exactly the current sources, so misplacing the sync is a *throw*, not a wrong number. The order is now derived phase by phase, each justified by the constraint that forces it. (Fix-list #7.)

Every Critical (1-10) and Important (11-31) item is resolved in this text. Where a decision changed because of review, it says so and says why. Where I disagree with the fix list, it says that too, at the point of decision.

---

## Scope

**In:** house and destination placement, car creation, pin demand, dispatch with route commitment, car movement, the return leg, trip completion, score.

**Out, deliberately:**

| Deferred to | What |
|---|---|
| **M1d** | The chunk-blocking primitive — queueing, give-way, carpark queues, emergent gridlock. Cars pass through each other in M1c. Also: delayed refunds / ghost roads (§5.11), and lane-speed multipliers |
| **M1e** | Week cycle, upgrade cards, the **authored spawn schedule**, square→circle upgrade, overcrowd failure, game over, destination removal |

Blocking is its own milestone rather than a task here because it is where the game's difficulty actually lives and because it is the one part with no obvious deterministic formulation — a car's ability to advance depends on every other car's position within the tick, which makes iteration order load-bearing in a way nothing so far has been. Burying that as the last task of a six-task plan would give it the least attention and the most dependencies.

**What "done" looks like:** a headless run over a hand-built road network with two houses and two same-colour destinations, where the score increments once per completed round trip **on an exactly hand-computed tick**, the dispatching and returning house identities are asserted per trip, and the whole run replays byte-identically from a snapshot taken with a car mid-edge, mid-trip, holding a live reservation.

---

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md`. Read §5.2 buildings, §5.3 demand and dispatch, §5.4 pathfinding, §5.5 movement, §5.9 spawning, §9.3 snapshot size.
- Zero runtime dependencies. Integer-only in `sim`; no module-scope mutable state; module-scope literal data must be `Object.freeze(... as const)`. Three mechanisms enforce this. Note that `determinism/no-module-mutable-state` already flags an unfrozen module-scope array/object literal (`tools/eslint-rules/index.js`), so `regions.ts`'s partition lists need **no new rule** (fix-list #37).
- Rule constants are integers over a denominator of 1000, converted only in the constants file.
- Cell index convention is `index = y * w + x`.
- Nothing allocates inside a tick. This now binds three new things: source assembly, the field-input hash, and route commitment. Each says below how it stays allocation-free.
- **This milestone re-blesses the goldens exactly once, in Task 1**, and the claim is now derivable rather than asserted — see "Why one re-bless is now true" in Task 1g. Tasks 2-6 assert all three goldens are unchanged.
- The `determinism.test.ts` and `rollback.test.ts` golden fixtures stay **building-free**. That is the property that makes the single re-bless hold; it is a constraint on those fixtures, stated so nobody "improves" them by adding a house.
- Do not modify `spike/`.
- Do not state expected test counts. Report the real number.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## Two places the spec contradicts itself, and which side M1c takes

The previous version of this plan resolved both without noticing there was a choice. Recording them here is not pedantry: one of them is the difference between having a return leg and not having one.

### A. Path-once vs. per-tick re-read

| Says | Where |
|---|---|
| "Cars path once at departure, never re-route" | §3 decision 5 [FAN, corroborated by `VehicleModel.repathUrgency` with `NotRequired` as the normal case] |
| "This omission is deliberate and load-bearing; it is the game" | §1 |
| "A car's per-tick pathfinding is one array read: `dir[cell]`" | §5.4 |
| "The car then follows `dir[]` downhill and claims whichever pin it reaches" | §5.4 |

The last two *are* re-pathing: the field rebuilds on every pin fire, every arrival and every road edit, so a car reading `dir[cell]` each tick re-targets continuously.

**M1c takes the faithful side: cars path once at departure.** Three reasons, in order of weight:

1. §1 and §3 decision 5 are design statements the whole game rests on; §5.4 is an implementation note about how the field is read. When a design statement and an implementation note disagree, the note is the one that is wrong.
2. **Nothing else gives a return leg.** Fields are per-colour and seeded from pins. Following `dir` uphill reaches the *farthest* pin, not the car's own house; `createFlowFields(colours, cells)` (`scratch.ts:99`) is per-colour, not per-house; and at the moment the last pin of a colour is consumed the field is all-`INF` and a returning car cannot move even in the wrong direction. A route stored at dispatch retraces backwards for free. The return leg is therefore not an extra cost of path-once — it is the thing path-once pays for.
3. A car at mid-edge has *committed* to an edge. A rebuilt `dir[cell]` may no longer name that edge, so a re-reading car either snaps sideways mid-edge or freezes. Path-once has no such state.

**Consequence: spec §5.4 needs amending.** Specifically: the sentence "A car's per-tick pathfinding is one array read: `dir[cell]`", the sentence "The car then follows `dir[]` downhill and claims whichever pin it reaches", and the whole paragraph beginning "Flow fields do not give pin reservation". The first half of §5.4's dispatch paragraph — every house of colour C reads `dist[houseCell]`, lowest dispatches — is **retained** and is exactly what Task 4 implements. File the amendment; do not leave M1c silently diverging from the spec of record.

### B. Reserved-on-departure vs. claimed-per-tick

| Says | Where |
|---|---|
| "The pin is reserved on departure; cars never compete" | §5.3.6 |
| "Flow fields do not give pin reservation. Iterate cars in stable integer-id order each tick; each claims the nearest unclaimed pin by field distance" | §5.4 |

**M1c takes §5.3.6.** §5.4's version is unimplementable as written anyway: a multi-source field gives distance to the *nearest* pin, not per-pin distances, so "the nearest unclaimed pin by field distance" has no per-pin distance to rank by. Same amendment.

---

## Evidence tiers for every game rule this plan implements

The review found rules presented as fact that were this plan's own invention. Tiers match the dossier: **[DPC]** official developer material, **[MOD]** decompile constants (field names compile-verified, values from a 2021-22 build ~14 balance patches behind), **[FAN]** community, **[OURS]** our choice. (Fix-list #32.)

| Rule | Tier | Note |
|---|---|---|
| Demand is destination-pull, not house-push | **[DPC]** | Composer Rich Vreeland: *"The destinations 'request' cars."* Dossier §1.4 |
| A pin dispatches a car from the **nearest same-colour house** by route cost | **[FAN]** | Dossier §1.5.1. This is *not* covered by the [DPC] quote above; the two were run together in the previous version and the paragraph lent DPC authority to a FAN claim |
| Nearest-destination preference is a **tendency, not a rule** | **[FAN]** | Dossier §1.5.6, verbatim: *"do not model it as a hard global optimum"*. **A multi-source field is exactly a hard global optimum.** We deviate knowingly — see decision 4 |
| The pin is reserved on departure; cars never compete | **[FAN]** | Dossier §1.5.2 |
| Route computed once at departure; cars never re-path | **[FAN]** + **[MOD/API]** | `VehicleModel.repathUrgency : PathfindUrgency`, `NotRequired` normal. Dossier §1.5.3 |
| Car removes exactly one pin, returns to the *same* house | **[FAN]** | Dossier §1.5.5, §1.11 |
| Score = completed trips, one point each | **[FAN]** | Dossier §1.11, Miraheze verbatim |
| Score credits **on return home** rather than on pickup | **[OURS]** | Dossier §1.11 says *"Unknown — we choose"*; some write-ups say pickup. The previous version called it "the intended pressure", which invents DPC intent. Our reasoning: it matches the wiki's definition of a trip and makes long trips genuinely more expensive |
| Houses hold exactly 2 cars from spawn, both may be out | **[FAN, multiply corroborated]** | Dossier §1.3 |
| Destination footprint ≈ 2×3 plus a carpark | **[FAN]** | Dossier §1.12 notes *"some sources say 3×2"*. Our orientation model covers both — decision 5 |
| Circle = exactly 2× demand | **[MOD]** | `DemandMultiplierForBuildings = 0.8`, `DemandMultiplierForUpgradedBuildings = 1.6`. This is the **best-evidenced** form of the rule and it is a *multiplier* |
| Circle occupies **two slots** in the rotation | **[FAN]** | Dossier §1.4.1 says "two slots" and nothing more |
| Those two slots are **consecutive** | **[OURS]** | The previous version stated this as fact and additionally asserted the mechanism is "not a multiplier applied at request time" — which *denies* the [MOD]-tier evidence. See decision 1 |
| First pin fires 4 s after a destination spawns | **[MOD]** | `DelayBeforeFirstPinOfDestination`. Tag carried, per the standing rule that every [MOD] value is a starting point |
| Baseline ≈ 1.24 pins/in-game-day/square | **[MOD]-derived** | `AverageCarsPerDay = 1.55` × 0.8. Our integer realisation gives **1.2410** exactly — decision 1 |
| Overflow redistribution to the next same-colour destination | **[FAN]** | Dossier §1.4.4 |
| Pin hard caps (square 10, circle 14) | **[OURS]** | Spec §5.8: *"every source contradicts every other"* |
| Nothing ever spawns on an existing road tile | **[FAN]** | Dossier §1.12. Basis of spawn-blocking |
| Destinations never spawn within 1 tile of another destination | **[FAN]** | Dossier §1.12 |
| A standing tree blocks a spawn | **[FAN]** | Dossier §1.1, spec §5.1 |
| Lane-speed multipliers (0.333 … 3.0) | **[MOD, possibly stale]** | **None are applied in M1c** — decision 3 |
| Edge weights orthogonal 10, diagonal 14 | **[OURS]** | Spec §5.4; the ratio is what movement must honour |
| Base car speed | **[OURS]** | No public value exists. Derived in decision 3 |
| Colour group count is per-map, 5 or 6 | **[FAN, exhaustive enumeration]** | Dossier §4.2: *"do not hardcode a count"* |

---

## Six design decisions, and why

### 1. Demand is destination-pull, and the rotation is state

Spec §5.3, from the original's composer: *"The destinations 'request' cars."* [DPC] Most clones invert this and it changes the whole feel — house-push produces cars wandering to find work; destination-pull produces a queue that visibly backs up.

**The rate, and why the previous version's rate was wrong.** A single fixed-period timer per colour, firing into a rotation, divides one colour's demand across however many destinations it has: adding a destination *dilutes* demand, and the city never gets busier from growing. The original's `AverageCarsPerDay = 1.55` is per **building** [MOD], and the weekly ramp is meant to add to growth-driven pressure, not be the only source of it. (Fix-list #18.)

The fix is a **drift-free per-colour accumulator scaled by slot count**:

```
acc[c] += slotCount(c)                     // once per tick
if (acc[c] >= PIN_PERIOD_TICKS) { acc[c] -= PIN_PERIOD_TICKS; fire(c) }
```

`PIN_PERIOD_TICKS = 518` is derived, not guessed: 1.24 pins/day × 7 days = 8.68 pins/week; `TICKS_PER_WEEK = 4500`; 4500 / 8.68 = 518.4 ticks per pin per slot. `TICKS_PER_DAY` is deliberately `0` (`constants.ts:24`) and must not be used as a divisor, so the derivation goes through the week.

Three properties fall out, and each is why this form was chosen over `timer -= PERIOD` on a countdown:

- **Per-destination rate is independent of destination count.** A colour with `S` slots fires every `518/S` ticks and each slot's turn comes every `S` firings, so every slot receives a pin every 518 ticks regardless of `S`. The dilution bug is gone by construction.
- **No division and no drift.** `timer = 0` on reload drops the remainder — up to a tick per pin, compounding. `acc -= PERIOD` carries it. This is the same carry bug as the movement one in decision 3, in another costume, and it gets the same treatment.
- **The exact rate is statable.** 4500/518 = 8.68726 pins/week ⇒ **1.2410 pins/day/square**, 2.4821 for a circle. Not "≈ 1.24". (The fix list quotes 1.2413; the arithmetic gives 1.24104. Minor, but a plan that says "exact" should be.)

`acc[c]` can advance by at most `slotCount(c)` per tick and `slotCount ≤ 2 × maxDestinations = 32 < 518`, so **at most one pin fires per colour per tick.** Stated as an invariant with its bound, because the alternative (a `while` loop) is what an implementer reaches for.

**The rotation representation, chosen rather than left open.** (Fix-list #19.) The cursor names a **destination slot index plus a sub-slot**, packed as `destIndex * 2 + subSlot`, *not* a position in a virtual expanded list. That choice is forced by insertion stability: a new destination appended at slot *k* would shift every later index in a virtual list — every cursor value after it would silently name a different destination — whereas in destination-index domain nothing shifts, because destinations are append-only and `H_DEST_COUNT` is the live prefix length. The coverage bullet everyone writes is "stable across a snapshot/restore"; the load-bearing case is **"stable across a destination placement"**, and it is only stable under this representation.

Rotation semantics, all five previously-unresolved points settled:

- **Advance:** if the current destination is a circle and `subSlot === 0`, advance to `subSlot 1` of the *same* destination; otherwise advance to `subSlot 0` of the next same-colour **eligible** destination in ascending slot index, wrapping at `H_DEST_COUNT`.
- **Eligibility gate** (fix-list #16): a destination is in the rotation only once `tick - destSpawnTick[d] >= FIRST_PIN_DELAY_TICKS`. This is the *only* formulation that reconciles a per-destination 4 s delay with a per-colour timer — the previous version listed both rules side by side without noticing they conflict, and `destMeta` has no room for a per-destination countdown.
- **Overflow walk is bounded** by the number of same-colour destinations, walking **destinations, not slots**, starting at the one after the chosen. `while (capped) advance()` is an infinite loop in exactly the all-capped case Task 3 requires. Walking destinations also makes "skip to the next *distinct* destination" true by construction — with a circle in two slots, a slot-walk can hand a capped circle its own overflow.
- **All same-colour destinations capped:** the pin is dropped and `H_PINS_DROPPED` increments (fix-list #17 — "recorded" needs a slot, or a JS counter is lost on rollback; it is also §10.3 telemetry).
- **Cursor after overflow or a drop:** advances past the **originally chosen slot**, never past the recipient. The rotation is the *schedule*; overflow redirects one pin, it does not change whose turn is next. The alternative lets a capped destination repeatedly hand its turn away and skews the long-run distribution. Both directions get a mutation.

**The circle's two slots are consecutive — and that is [OURS], not evidence.** The dossier says "two slots" and nothing about ordering; the previous version asserted "consecutive" as fact and, worse, asserted the mechanism is "not a multiplier applied at request time", which contradicts the *best*-evidenced source ([MOD] `DemandMultiplierForBuildings = 0.8` / `...ForUpgradedBuildings = 1.6` — a multiplier). Both forms give the same 2× rate. We implement two consecutive slots because it produces **burstiness** a rate multiplier does not, and because it needs one cursor rather than a per-destination fractional accumulator. Interleaved (circle appears once per half-rotation) is the live alternative; the exact-sequence assertion in Task 3 is what makes the choice falsifiable later.

### 2. Dispatch selects the house, and commits the route

The naive reading is "a car picks the nearest destination". Backwards. A pin appears at a destination, and the game selects **an available car from the nearest same-colour house** [FAN], ranked by road-route cost.

This falls out of the flow field. A field seeded from all pinned destinations of colour C gives, for every cell, the distance to the *nearest* such destination. So dispatch is not "pick a pin, then search for a house" — it is: every house of colour C with a free car reads `dist[houseCell]`, the house with the smallest value wins. One array read per house instead of a search.

**Then the winner — and only the winner — walks `dir` downhill once**, recording each direction into `carRoute` and resolving the terminating carpark cell to a destination index. One walk per dispatch, not per house, so "one array read per house" survives.

**The car therefore knows its destination when it leaves.** The previous version claimed the opposite ("the car does not know its destination when it leaves; it discovers it on arrival") while simultaneously declaring a `carTargetPin` field. Those cannot both be true, and under path-once the claim is simply false. Deleted.

**Route storage.** `carRoute` holds one 4-bit direction per step, two per byte, `MAX_PATH_LEN` steps. `carRouteLen` is the step count, `carRouteCursor` the position. The return leg is the same array read backwards, stepping `OPPOSITE[route[cursor-1]]`. `edgeCost(OPPOSITE[d]) === edgeCost(d)` for every `d`, so the return leg costs exactly what the outbound leg cost — a property worth asserting, because it makes the round-trip tick count hand-computable.

Determinism's specific warning applies and is worth repeating where an implementer will read it: **the cheapest thing to reach for here is a JS array cached outside the state buffer.** It survives no snapshot, and Task 6's mid-flight snapshot test is exactly the test that catches it. The route lives in the buffer.

**`MAX_PATH_LEN = 96`, and exceeding it is a defined refusal, not a crash.** 24 + 40 = 64 is the board's Manhattan diameter; 96 gives 1.5× for detours. A route longer than that means a pathological network, and the refusal is the right answer: the dispatch does not happen, `destReserved` is not incremented, the house is excluded from this tick's dispatch loop (so the loop cannot spin), and `H_ROUTES_REFUSED` increments. The bound doubles as the walk's cycle guard — `dir` is a tree toward the sources so it cannot cycle, but a hand-corrupted `dir` can, and an unbounded walk is a hang.

**A zero-length route is refused the same way.** It would mean the house cell *is* a carpark cell, which building-on-building rejection already forbids; refusing it here means a corrupted state produces a named refusal rather than a car that completes a trip without moving.

**Cost, stated because it is the largest line item in the buffer.** At `CARS_PER_HOUSE × maxHouses` = 80 cars, `carRoute` is 80 × 48 = 3,840 B — 48.6% of the whole state buffer. Task 1 re-takes §9.3's 3,809 B snapshot measurement; see Task 1g.

### 3. Movement accumulates progress in the pathfinder's own cost units

This is the decision that changed most on review, and the previous version was wrong in two structural ways before rounding ever entered the picture. (Fix-list #8, #22, #23; adjudication item 4.)

**Problem one: there was no base speed to convert from.** `LANE_SPEED_DEFAULT = 1000` (`constants.ts:31`) is `1.0 × DENOM` — a **dimensionless multiplier**, not a speed. Nothing in `constants.ts` states cells per second or sub-cells per tick, and no task listed `constants.ts` as modified. "Speed derived from the lane-speed constants" is not derivable: a multiplier times nothing is nothing.

**Problem two: a per-edge 1/256th offset prices diagonals wrong.** If `offset` is 1/256ths *of the current edge*, a diagonal takes the same time as an orthogonal — traversal ratio 1.00 — while `edgeCost` charges 14/10 = **1.40** (`graph.ts:94-100`). Cars would take routes the field calls optimal that are in fact slower, permanently, with every measurement downstream inheriting it. Scaling the advance by 10/14 fixes the ratio but adds a second integer division *with its own carry*, and a remainder held in per-edge units silently converts a diagonal remainder into an orthogonal one when the car changes edge type.

**The fix eliminates the mismatch instead of rounding it away.** Track progress in cost units:

```
progress += speedUnits                                   // per tick
threshold = edgeCost(currentStepDir) * COST_UNIT_SCALE
if (progress >= threshold) { progress -= threshold; advance one step }
```

Traversal time is then proportional to the Dijkstra weight **by construction**, for every current and future edge cost including M1d's motorway tier, with no per-edge rounding rule at all.

**The constants, derived not guessed.** `COST_UNIT_SCALE = 250`, `CAR_SPEED_UNITS_PER_TICK = 330`, both new in `packages/shared/src/constants.ts`. Four constraints pinned them:

1. **Diagonal ratio exact.** Thresholds are 10 × 250 = 2,500 and 14 × 250 = 3,500; ratio 1.40 exactly. ✅
2. **Neither threshold is divisible by the speed.** 2500/330 = 7.576, 3500/330 = 10.606. This is not cosmetic: **if the speed divides the threshold, the carry is always zero and the carry-dropping bug is unobservable at every operating point** (fix-list #22). Under `COST_UNIT_SCALE = 250` a speed of 350 would make the *diagonal* carry identically zero; 320 would make an alternative ortho threshold exact. 330 leaves both carries large — 140 and 130 units, ~0.42 and ~0.39 ticks per cell — so the mutation is loud: over 8 orthogonal cells, correct arrival is tick `ceil(20000/330) = 61`, the carry-dropping version arrives at `8 × ceil(2500/330) = 64`.
3. **Future multiplier rounding under 1%.** The smallest multiplier is `SHARP_TURN_SPEED_MUL = 333`; `330 × 333 / 1000 = 109.89 → 109` units, so truncation error is bounded by 1/109 = 0.92%. At a plausible sub-cell-style base of 8-10 units, `B × 333/1000` is 2.66-3.00 and floor-vs-round is a 10-33% speed error — and `B < 4` floors to **0**, a permanently stalled car. That whole failure class is priced out by working in cost units.
4. **Plausible speed.** 2500/330 = 7.58 ticks per orthogonal cell ≈ 3.96 cells/second at 30 Hz.

**The conversion helper.** `speedUnits(mul) = max(1, (CAR_SPEED_UNITS_PER_TICK * mul / DENOM) | 0)` — truncating integer division, clamped to ≥ 1 so no multiplier can ever stall a car permanently. **M1c applies no lane-speed multipliers**: `edgeCost` is pure length with no lane-speed term, so §3 decision 7's time-weighted cost `length / laneSpeed` is *not* implemented, and if movement applied turn or intersection multipliers the field could not see them and the two models would diverge by design. The helper's only live call in M1c is `speedUnits(LANE_SPEED_DEFAULT)`, the identity — which is exactly why it gets a **hand-written literal expectation table** rather than a formula-derived one (fix-list #23; and see the carry-forward's "an assertion checked against the formula that produced the thing under test").

**Cross-reference to Task 1c:** when multipliers or a motorway tier arrive, `edgeCost`'s value set changes and `NB`, `DISTINCT_EDGE_COSTS`, `COST_UNIT_SCALE` and `CAR_SPEED_UNITS_PER_TICK` must all be re-derived together.

**Carry rules, stated because each is a silent-bias site.** Progress carries across a cell crossing (dropping it costs up to `speed-1` units per cell — a systematic slowdown of a fraction of a tick per cell, the classic "diverges only after thousands of ticks"). It carries across the outbound→return flip. It is **reset to 0 at trip end**, when the car goes idle; that is a once-per-trip discard of at most one tick against a trip of dozens, and it is taken deliberately so an idle car's bytes are a function of nothing but "idle".

### 4. Reservation never touches the source set

The previous version's reservation was three mutually exclusive claims and it deadlocked tick 1 of its own deliverable fixture. The resolution (fix-list #1, converged 3/3):

- **Sources** = the road-adjacent access cell of every destination with `destPins[d] > 0`.
- **Dispatch eligibility** = `destPins[d] - destReserved[d] > 0`.
- **`destReserved`** (Uint8 × `maxDestinations`) is a new region, classified field-irrelevant because it never enters `sources`.
- `carTargetPin` → **`carTargetDest`**, holding a *destination index*. `destPins` is a count; pins are not addressable entities, so `carTargetPin` had no referent under the data model this plan itself specifies.

**Why the alternative fails, recorded so nobody re-derives it.** "A reserved pin leaves the source set" empties the source set whenever one destination holds one pin. `computeFlowField` fills `dist` with `INF` and `dir` with `-1` unconditionally, with **no early return for an empty source list** (`flowfield.ts:108-110`) — deliberately, so a stale field from the previous colour can never be served. Under the previous version's re-pathing movement the in-flight car then reads `dir === -1` and freezes at its house, forever. It also forces a source-set mutation *mid-tick*, so the second house to call `fieldFor` that tick **throws** `"field is stale"` (`flowfield.ts:352-358`), contradicting §5.4's one-rebuild-per-tick rule that Task 1 exists to enforce. Testability's softer variant — "a destination whose *every* pin is reserved leaves the source set" — is implementable under a cell-keyed set but deadlocks the identical one-pin fixture for the identical reason.

**One honest caveat, because the fix list's own reasoning has a loose end.** The freeze half of that argument depends on the re-pathing model, and decision 2 removes re-pathing: an in-flight car no longer reads the field at all, so "sources = `destPins - destReserved > 0`" would not freeze anyone. I still take `destPins > 0`, for two reasons that survive path-once:

1. It keeps `destReserved` out of the source set, so the field's rebuild cadence is driven by pin *presence* alone — one rebuild per fire and one per consume, rather than additionally one per dispatch and one per release. That halves the rebuild rate.
2. It makes the source set a function of committed game state, not of transient in-tick bookkeeping. The dispatch loop can then increment `destReserved` freely mid-loop with **no interaction whatsoever** with the staleness stamp — no "hold the reference and hope" reasoning is required anywhere.

**And its cost, stated rather than discovered later.** Because a fully-reserved destination stays in the source set, a house whose nearest pinned destination is entirely spoken for is routed there by the field and finds it ineligible. **Rule: that house is excluded from this tick's dispatch loop and does not reach past its nearest destination.** It resumes when the reserving car arrives. This is a real behavioural artefact — it can block a house for one trip duration — and it is the price of one field per colour instead of one per destination. It bites only when a colour has a fully-reserved destination *and* an unreserved one *and* the nearest-house ranking prefers the reserved one; with `PIN_CAP_SQUARE_HARD = 10` and reservations bounded by cars-out, that is uncommon outside the one-pin-one-car case, where it is harmless because there is nothing else to serve. Task 4 pins the behaviour with a coverage bullet and a mutation so that changing it later is deliberate.

**Reservation is released** when the car consumes its pin at the destination (arrivals phase). The invariant that ties it together, asserted after every tick in the loop test:

```
sum(destReserved) === count(cars in PHASE_OUTBOUND)
```

That single assertion catches a leaked reservation, a double-dispatch, and a net-zero double phase transition in one line.

**`destReserved[d] <= destPins[d]` is a proved invariant, not a hoped-for one.** Dispatch increments `destReserved` only when `destPins - destReserved > 0`; arrivals decrement both together; nothing else writes either. Therefore **the "trip whose destination's pins were all consumed en route" case is unreachable in M1c** (fix-list #29). It was reachable in the previous version only because re-pathing let a car arrive at destination B holding a reservation at A, leaking `destReserved[A]` monotonically until A was permanently ineligible with no visible cause. Rather than pick one of three behaviours for a case that cannot happen, arrival **asserts** `destPins[carTargetDest] > 0` and throws a named error if not — a loud failure of a proved invariant. The mutation is "delete the dispatch eligibility check": the invariant breaks and the throw fires.

### 5. Buildings occupy cells; the driveway rule makes them part of the graph

A house is one cell. A destination is a 2×3 footprint plus one carpark cell [FAN] — stored as an origin cell plus an orientation, not as seven cell references.

**Orientation is 4 values, not 2**, and the carpark's position is part of it (fix-list #25 — "both orientations" under-counts; with a separate carpark there are at least four distinct placements). Orientation names the side the carpark attaches to:

| Orientation | Footprint | Carpark |
|---|---|---|
| 0 (N) | 2 wide × 3 tall at origin | the lowest-index cell adjacent on the north side |
| 1 (E) | 3 wide × 2 tall at origin | the lowest-index cell adjacent on the east side |
| 2 (S) | 2 wide × 3 tall at origin | the lowest-index cell adjacent on the south side |
| 3 (W) | 3 wide × 2 tall at origin | the lowest-index cell adjacent on the west side |

"Lowest-index adjacent cell on that side" is stated exactly because a mutation that places the carpark at the *other* adjacent cell must fail a test, and it is the field's source cell so the error would be a wrong route rather than a wrong pixel.

**`destMeta` bit layout, stated because the packing bug is silent.** Bits 0-2 colour (**3 bits — the map format allows 6 groups, so 2 is not enough**), bit 3 kind (0 = square, 1 = circle), bits 4-5 orientation, bits 6-7 **must be zero**. A round-trip test covers all 6 × 2 × 4 = 48 combinations, so "shift orientation by 3 bits instead of 4" bleeds kind into orientation and fails; a fixture using only colours 0 and 1 would not catch it.

**The driveway rule** (fix-list #15). Roads and buildings did not know about each other, and dispatch is unimplementable until they do: `canPlaceRoad` (`roads.ts:119`) checks bounds, adjacency, terrain and budget only — nothing stops paving straight through a destination — while `dist[houseCell]` is `INF` unless the house cell carries a road bit, because `neighbours` (`graph.ts:46`) reads `state.roads[cell]` and a road-free cell has no edges.

- The **house cell** is a road-graph node. Road may be placed on it. This is what makes `dist[houseCell]` meaningful.
- The destination's **carpark cell** is a road-graph node, and is *the* access cell the field seeds from.
- The destination's **other six cells are not**. `canPlaceRoad` rejects them with a new `PlaceFailure` reason `'building'`.

Cost: `canPlaceRoad` runs per drag-frame and now scans `H_DEST_COUNT ≤ 16` destinations for each of two endpoints. That is 32 comparisons per frame — cheap enough that an occupancy grid is not worth it, and an occupancy grid would be a second source of truth for the same fact plus another region to classify. Rejected deliberately.

**Consequence for the staleness partition:** the fix list concludes from this that `houseCell`/`destCell`/`destMeta` are all field-*input*. I agree for the destination regions and disagree for the house regions — see the region table below, where each classification carries its own reason.

### 6. Cars pass through each other in M1c

No blocking. A car advances if its progress allows, regardless of what else is on the road.

This is a deliberate, temporary lie about the game, and it is worth stating loudly because every number this milestone produces is optimistic. Trip times are lower bounds. Throughput is an upper bound. **No balance conclusion may be drawn from M1c.** M1d makes it true.

**Second temporary lie, new in this version:** a road erased under an in-flight car refunds **immediately**, while the car keeps driving the erased segment to the end of its committed route. Spec §5.11 and dossier §1.5.3 say the refund is *delayed* until the last committed car clears (the "ghost lane"), and `roads.ts`'s module comment already flags the delayed refund as "M1c's problem, deliberately deferred". It stays deferred — to M1d, alongside the ghost rendering, because a delayed refund needs per-segment committed-car counts, which is chunk bookkeeping. What M1c gets right is the *car's* behaviour: movement never reads `roads`, so a car on an erased segment simply completes its route. That is the faithful behaviour and it is also the simplest — there is no code path that could freeze. The player can briefly get a free tile; it is stated, tested, and named as a deviation.

The reason to build it this way is that dispatch, movement and trip accounting are all independently testable without blocking, and blocking is far easier to add to a working trip loop than to debug alongside one.

---

## The tick order, derived

Each phase is justified by the constraint that forces its position, not by preference. The previous version stated four phases and had no slot for input application and none for the field sync — and misplacing the sync is a **throw**, not a wrong number.

| # | Phase | The constraint that puts it here |
|---|---|---|
| 1 | `H_EPOCH ← tick`; advance `H_TICK`, `H_WEEK` | Pin timers and the 4 s eligibility gate compare against `H_TICK`. Moving this one slot later shifts the first-pin delay by one tick and moves the goldens. Stated because "advance the clock somewhere" reads as free and is not. `H_EPOCH` is the atomicity marker — see below |
| 2 | **Apply inputs** (road place / erase) | The only phase that changes `roads`. Must precede the sync, or a road drawn on tick T is invisible until T+1 |
| 3 | **Demand** — accumulators, pins, overflow, drops | Mutates `destPins`, which decides the source set. Must precede the sync |
| 4 | **Assemble sources + exactly one `syncFields`** | Every source-mutating phase is now behind it. `fieldFor` throws unless the sync ran against exactly the current sources |
| 5 | **Dispatch** — `fieldFor` once per colour, route commitment, reservation | The only field reader in the whole tick. Mutates `destReserved` and car state, never the source set |
| 6 | **Movement** — advance progress along committed routes | Reads no field at all (decision 2). Placed after dispatch so a car dispatched on tick T also moves on tick T; the alternative costs every trip one tick and every exact-tick assertion inherits it, so it is a choice, stated |
| 7 | **Arrivals** — consume pin, release reservation, credit score, free car | Mutates `destPins` *after* the sync. Must be last |
| — | `H_EPOCH ← 0` | Clears the atomicity marker on successful exit |

**The one ordering rule that is "wrong" rather than merely "different":**

> **No phase between the sync and a field read may mutate the source set.**

Everything else in this order changes trip cadence; violating that one produces a throw or a field that silently describes content it does not hold. Decision 4 is what makes it hold: dispatch mutates `destReserved`, which is not in `sources`.

**Stated residual.** Arrivals mutate `destPins` after the sync, so **the fields are stale from the arrival phase until the next tick's sync**. Nothing may call `fieldFor` in that window — not a renderer, not a debug hash, not a test helper. Under decision 2 the only in-tick reader is dispatch, so this is a constraint on external callers only.

**On the alternative the previous version offered.** It guessed the order was wrong and proposed "arrivals first, so a car that arrived last tick frees its slot before dispatch runs". That alternative is a **cyclic rotation** of the same order and produces identical trip lengths, so the stated justification was false for the specific alternative offered. Moving arrivals before movement also costs something real: the car sits on the carpark cell for a tick while logically finished, which becomes a genuine behaviour change in M1d when that car occupies a chunk. Arrivals stay last. (Adjudication item 2.)

**Anti-double-act invariant**, which phase ordering alone does not give you (fix-list #7): **at most one phase transition per car per tick.** Every phase iterates cars in ascending index and reads each car's phase byte exactly once per iteration. The reachable failure is writing `carPhase` in place inside a loop that later re-tests it. Enforced by an explicit allowed-transition table checked in tests over the before/after phase arrays, **plus** the `sum(destReserved) === count(PHASE_OUTBOUND)` conservation check, which is what catches a net-zero double act (`IDLE → OUTBOUND → IDLE` in one tick leaks a reservation and is invisible to a before/after comparison).

**Atomicity** (fix-list #11). `step` used to mutate only `H_TICK`/`H_WEEK` and could not throw. It now bumps the tick, runs demand (mutating `pinAccum`, `rotationCursor`, `destPins`), then syncs — and `computeFlowField` throws from three places, one from the middle of the drain loop with a partly-relaxed field written. The carry-forward's accepted residual ("a throw during a rebuild leaves engines able to diverge on *whether* a rebuild runs, never on *what content*") was sound because the state buffer was untouched; that reasoning does not survive a phased `step`. **Rule: a throw out of `step` poisons the run. The state is not resumable.** `H_EPOCH` is set to the tick at phase 1 and cleared at successful exit; a non-zero `H_EPOCH` makes `restore` and the next `step` throw with a named message. Silence here is how a retried tick double-applies demand.

---

## The complete M1c region list

**Declared once, in Task 1, zero-initialised. Tasks 2-6 write only behaviour into it.** This is what `state.ts`'s own module comment demands — *"frozen once here… so that every later task in this milestone appends behaviour, never buffer shape"* — and it is the only way the single-re-bless rule can be true rather than aspirational.

Sizes for `firstCity`: `cells = 960`, `groupCount = 5`, `maxHouses = 40`, `maxDestinations = 16`, `maxCars = CARS_PER_HOUSE × maxHouses = 80`, `ROUTE_BYTES = MAX_PATH_LEN / 2 = 48`.

Declared in **descending alignment** so `computeLayout` never inserts a pad byte (assertable: `totalBytes === Σ region byte lengths`), and within each tier grouped by concern. The M1b rule *"fixed-size regions precede every variable-size region"* is preserved and sharpened: `rng`, `mapIdentity` and `header` have compile-time-constant lengths and come first, so `mapIdentity` is always at offset 4 and a mis-sized buffer can never displace the identity slots that `restore` checks.

| # | Region | Type | Length | Bytes | Staleness | Reason |
|---|---|---|---|---|---|---|
| 1 | `rng` | Uint32 | 1 | 4 | **irrelevant** | The pathfinder makes no random draws |
| 2 | `mapIdentity` | Int32 | 3 | 12 | **input** | `MI_MAP` folds `w`/`h`/terrain and closes the 6×4-vs-4×6 collision that `fieldFor`'s cell-*count* guard cannot catch (`flowfield.ts:193-206`). Immutable after `createState` |
| 3 | `header` | Int32 | 9 | 36 | **irrelevant** | `H_TICK` increments every tick; hashing it rebuilds every colour every tick forever, killing §5.4's coalescing silently and with correct answers |
| 4 | `pinAccum` | Int32 | 5 | 20 | **irrelevant** | Reaches the field only by causing a `destPins` write, which is itself classified |
| 5 | `rotationCursor` | Int32 | 5 | 20 | **irrelevant** | As above |
| 6 | `houseCell` | Int32 | 40 | 160 | **irrelevant** | A house never seeds a source. It constrains where road *may* be placed; it is `roads` that records the outcome, and `roads` is hashed |
| 7 | `destCell` | Int32 | 16 | 64 | **input** | Determines the carpark cell, i.e. *where* the source is |
| 8 | `destSpawnTick` | Int32 | 16 | 64 | **irrelevant** | Rotation eligibility only |
| 9 | `carHome` | Int32 | 80 | 320 | **irrelevant** | Dated: irrelevant *while no edge cost depends on occupancy*. §5.6's demand-actuated lights make car positions a field input in M1e |
| 10 | `carCell` | Int32 | 80 | 320 | **irrelevant** | As above |
| 11 | `carProgress` | Int32 | 80 | 320 | **irrelevant** | As above |
| 12 | `carTargetDest` | Int32 | 80 | 320 | **irrelevant** | As above |
| 13 | `carRouteLen` | Int16 | 80 | 160 | **irrelevant** | As above |
| 14 | `carRouteCursor` | Int16 | 80 | 160 | **irrelevant** | As above |
| 15 | `roads` | Uint8 | 960 | 960 | **input** | The graph itself |
| 16 | `cleared` | Uint8 | 960 | 960 | **irrelevant** | Records destroyed trees. `neighbours` reads `roads`; terrain lives in immutable `world` |
| 17 | `houseColour` | Uint8 | 40 | 40 | **irrelevant** | See `houseCell` |
| 18 | `destMeta` | Uint8 | 16 | 16 | **input** | Orientation determines the carpark cell |
| 19 | `destPins` | Uint8 | 16 | 16 | **input** | Decides which destinations seed sources |
| 20 | `destReserved` | Uint8 | 16 | 16 | **irrelevant** | Never enters `sources` (decision 4). This is the classification the whole reservation fix buys |
| 21 | `carPhase` | Uint8 | 80 | 80 | **irrelevant** | As row 9 |
| 22 | `carRoute` | Uint8 | 3840 | 3840 | **irrelevant** | As row 9 |
| | | | **total** | **7,908** | | zero padding |

**Header slots.** `H_TICK 0`, `H_SCORE 1`, `H_WEEK 2`, `H_TILES 3`, `H_HOUSE_COUNT 4`, `H_DEST_COUNT 5`, `H_PINS_DROPPED 6`, `H_ROUTES_REFUSED 7`, `H_EPOCH 8`. `HEADER_LENGTH = 9`.
**`mapIdentity` slots.** `MI_MAP 0`, `MI_MAP_W 1`, `MI_MAP_H 2`.

**`H_SCORE` already exists** (`state.ts:78`, "written only by tests, and is kept deliberately"). Task 6 writes it. Its retention rationale is hereby discharged, and there is exactly one score slot. (Fix-list #33 — two score slots was a plausible outcome of a task that never named it.)

### Three notes on classifications that were argued over

**Why `header` is split from `mapIdentity`** (fix-list #4). A partition over region *names* could not classify today's `header` honestly, and both branches were wrong: `header → input` rebuilds every colour every tick because of `H_TICK`, silently, with correct answers, and nothing currently catches it (`flowfield.test.ts:911` never calls `step` between its two `syncFields` calls; `rollback.test.ts` Step 2c never advances the tick); `header → irrelevant` deletes the documented `H_MAP` protection. The likely implementation — hash `roads` plus a special-cased `header[H_MAP]` fold — makes the partition **lie** while the union assertion passes. Splitting makes every region classifiable whole.

**`H_TILES` stays in the mutable `header`, and this corrects the fix list.** Fix-list #4 puts `H_TILES` in the immutable `mapIdentity` region. It is not immutable — `placeRoad` and `eraseRoad` write it (`roads.ts:174`, `roads.ts:212`) — and it must not be a field input: M1e's upgrade cards grant tiles with no road change, which would spuriously rebuild every colour. `mapIdentity` holds exactly the three slots that are written once in `createState` and never again.

**Why the destination regions are input and the house regions are not.** Strictly, `computeFlowField` reads only `state.roads`, `world`, and the assembled `sources` — so a strict reading makes `{roads, mapIdentity}` the entire input set, and everything else reaches the field *through* `sources`, which `syncFields` already hashes separately via `hashSources` (`flowfield.ts:300`). Fix-list #28 is right about that, and the previous version's stated reason for classifying `destPins` taught the next reader something false. The partition semantics are therefore stated as: **a region is FIELD_INPUT if changing its bytes can change what the next field build produces, whether directly or by changing the assembled source set.** `destPins`, `destCell` and `destMeta` qualify; they are **defence-in-depth**, and the plan says so rather than implying the region stamp is what catches pin changes. Houses do not qualify under any reading — fix-list #15 extends its conclusion to `houseCell`/`houseColour`, and I do not follow it there, because "constrains where road may be placed in future" is not "is an input to the current field".

**The cost of the defence-in-depth**, quantified because an unquantified cost is how §5.4's coalescing dies: the field-input stamp is one value shared across colours, so a pin fire for colour 2 rebuilds all five. At ~1 pin fire plus ~1 consume every few dozen ticks that is a handful of extra 30 µs rebuilds per second. Accepted; stated.

### Why one re-bless is now true

- `hashState` is FNV over the whole buffer, so the state goldens (`1073292924`, `3183850973`) move in Task 1 when the layout grows and `mapIdHash` changes. That is the re-bless.
- Every M1c region is zero-initialised and **a building-free state is all-zero in every new region**. No `-1` sentinel is written anywhere at creation: unused house and destination slots are simply those at index ≥ `H_HOUSE_COUNT` / `H_DEST_COUNT`, and unused cars are `PHASE_NONE = 0`. (This is a change from the previous version, which gave `houseCell` a `-1` unused marker and gave the car regions none — leaving `CARS_PER_HOUSE × maxHouses` phantom cars at cell 0 in every fresh state. Fix-list #9.)
- The determinism golden is a 13,499-tick run. Once `step` owns demand, `pinAccum` would move on every tick — **except** that with no destinations, `slotCount` is 0 for every colour, so `pinAccum` never advances, `rotationCursor` never advances, no pin fires, no car exists and nothing moves. Hence the constraint above: **the golden fixtures stay building-free.**
- `H_EPOCH` is set and cleared inside `step`, so it is 0 at every point a golden is taken.
- The **field golden `252514232` must NOT move.** `foldedFieldsHash` folds only `dist` and `dir` bytes (`rollback.test.ts:128-133`), not the stamps, and Task 1's signature changes alter the source *container*, not the source *values*. If that golden moves in Task 1, the signature change altered pathfinding behaviour and that is a defect, not a re-bless. Treat it as a tripwire.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/constants.ts` | *Modified* — `COST_UNIT_SCALE`, `CAR_SPEED_UNITS_PER_TICK`, `MAX_PATH_LEN`, `PIN_PERIOD_TICKS`, `FIRST_PIN_DELAY_TICKS`, `MAX_GROUP_COUNT`. The auto-derived `ALL` registry test (`constants.test.ts:20-22`) picks up new exports and requires a finite non-negative integer, so additions are cheap and self-covering |
| `packages/shared/src/mapFormat.ts` | *Modified* — `maxHouses`, `maxDestinations`, `groupCount` on `MapData`, validated in `parseMap` |
| `packages/shared/src/maps/firstCity.ts` | *Modified* — the three new limits |
| `packages/sim/src/regions.ts` | *New* — `regionsFor` (moved and exported), the layout table, and the `FIELD_INPUT` / `FIELD_IRRELEVANT` partition with a one-line dated reason each |
| `packages/sim/src/state.ts` | *Modified* — the whole M1c region list, the `header`/`mapIdentity` split, the live-prefix accessors |
| `packages/sim/src/world.ts` | *Modified* — `mapIdHash` folds the three new `MapData` fields |
| `packages/sim/src/flowfield.ts` | *Modified* — `hashFieldInputRegions`, `Int32Array`-based source signatures, the penalty-routing note |
| `packages/sim/src/scratch.ts` | *Modified* — source buffers, slot-count buffer, field-input ranges, cross-call counters, per-cell push instrumentation |
| `packages/sim/src/roads.ts` | *Modified* — the driveway rule in `canPlaceRoad`, `'building'` rejection reason |
| `packages/sim/src/step.ts` | *Modified* — widened signature, `TickInputs.actions`, the seven-phase tick order |
| `packages/sim/src/buildings.ts` | *New* — placement validity, footprint and carpark geometry, `destMeta` pack/unpack, car creation |
| `packages/sim/src/demand.ts` | *New* — the accumulator, the rotation, eligibility, capacity, overflow, drops |
| `packages/sim/src/dispatch.ts` | *New* — source assembly, house selection, route commitment, reservation |
| `packages/sim/src/cars.ts` | *New* — progress accumulation, route following, the return leg |
| `packages/sim/src/trips.ts` | *New* — arrival, pin consumption, reservation release, scoring |
| `packages/sim/test/*.test.ts` | One per module, plus the end-to-end loop test |

---

## Task 1: Structural prep — the whole layout, every signature, and the single re-bless

Ships no game logic. **Everything after it writes behaviour into a frozen shape.** The task is large deliberately: fix-list #1, #2, #9, #16 and #17 each add regions, #4 and #10 change the layout, and all of them sit upstream of the single re-bless. Splitting them across tasks is what made the previous version re-bless three times.

**Files:**
- Create: `packages/sim/src/regions.ts`, `packages/sim/test/regions.test.ts`
- Modify: `packages/shared/src/constants.ts`, `packages/shared/src/mapFormat.ts`, `packages/shared/src/maps/firstCity.ts`, `packages/sim/src/state.ts`, `packages/sim/src/world.ts`, `packages/sim/src/flowfield.ts`, `packages/sim/src/scratch.ts`, `packages/sim/src/step.ts`, and every test that touches them

### 1a. `MapData` grows three limits, and `mapIdHash` folds them

`MapData` has only `id`, `w`, `h`, `terrain`, `startingTiles` today. Add `maxHouses`, `maxDestinations`, `groupCount`, validated in `parseMap` as positive integers with `1 <= groupCount <= MAX_GROUP_COUNT (6)`. `firstCity` gets `maxHouses: 40`, `maxDestinations: 16`, `groupCount: 5`.

**`mapIdHash` must fold all three, and this is a silent-corruption fix, not tidiness** (fix-list #10). `mapIdHash` (`world.ts:70-93`) hashes id-length, id chars, `w`, `h`, `startingTiles`, terrain — and its own doc calls content-blindness "the one drift this check exists to catch". Nine regions are about to be sized from the new fields. `restore` validates byte length, then `assertWorldMatches` checks `MI_MAP`/`MI_MAP_W`/`MI_MAP_H`. With the new fields unhashed, a map re-authored between a run and its server replay — same terrain, `maxHouses` 40→8, `maxDestinations` 16→**k** chosen so the byte total is unchanged — produces the same `MI_MAP`, the same `w`/`h`, and the same total byte count. **Both guards pass, `viewsOver` reinterprets the whole buffer under a different offset table, `carCell` bytes read as `destPins`.** Silent, total corruption of a "verified" replay, no throw anywhere.

Extend `world.test.ts`'s content-hash pin: changing each of the three fields alone must move `mapIdHash`.

**Spawn zones are deliberately not added.** The previous version listed "building spawn zones" on `MapData`. They are the spawner's input and the spawner is M1e. Note for M1e: when they land, they must be folded into `mapIdHash` for exactly the reason above.

`GROUP_COUNT_DEFAULT` keeps existing but is now **only** a default for map authoring. Every region sizes from `map.groupCount`, and one assertion ties `fields.length` to it — `syncFields` currently checks `sourcesByColour.length === fields.length` against nothing else (fix-list #26). `CARS_PER_HOUSE` (`constants.ts:62`, currently no consumer) is imported, never re-spelled as a literal `2`; this codebase rejects that pattern and says why (`scratch.ts:160-162`, `graph.ts:76-80`).

### 1b. Split `header`, declare every region, freeze the shape

Implement the region table above in `regions.ts`, with `regionsFor` **exported** — it is module-private today (`state.ts:93`, no export anywhere in `packages/`), so the union assertion the previous version specified could not have compiled (fix-list #5).

Re-index the header, split out `mapIdentity`, and update `world.ts`, `roads.ts` and every test that names a header slot.

Assert: `totalBytes === Σ (len × BYTES_PER_ELEMENT)` — zero padding, which the descending-alignment declaration order buys and which a careless reorder would silently spend.

### 1c. Drive the staleness hash from the layout table

The union assertion proves *classification*, not *hashing* (fix-list #5, the most valuable silent finding in the review). `GameState` is a fixed interface and `viewsOver` builds a name→view `Map` and throws it away, so the natural implementation of `hashFieldInputRegions` is a hand-written sequence of `hashBytes(s.roads)`, `hashBytes(s.destPins)`, … — and then adding a region to `FIELD_INPUT_REGIONS` and forgetting its hash line leaves the union test green, the layout test green, and **the field reporting fresh while its inputs changed**. That is the exact failure this mechanism exists to prevent, reintroduced one layer down.

Drive it from the table instead:

- `createFieldInputRanges(map)` walks `computeLayout(regionsFor(map)).entries` with an **indexed loop** (`determinism/no-collection-iteration` bans `for...of` over `.entries()`) and emits an `Int32Array` of `(byteOffset, byteLength)` pairs for every entry whose name is in `FIELD_INPUT_REGIONS`.
- It is built **once**, at boot, and stored alongside `Scratch`. This matters: `hashFieldInputRegions` runs once per tick and calling `computeLayout(regionsFor(map))` there would allocate ~22 objects per tick, against this plan's own "nothing allocates per tick" and §4.1's allocation-free `step`.
- `hashFieldInputRegions(state, ranges)` walks the `Int32Array` and hashes `new Uint8Array(state.buffer, offset, length)` for each. It replaces `hashRoadRegion`; the `MI_MAP` fold is subsumed because `mapIdentity` is hashed whole.

Membership lookups use a frozen array and an indexed linear scan, never a module-scope `Set` (which `no-module-mutable-state` would reject anyway).

### 1d. Widen the source plumbing to preallocated buffers

`syncFields` takes `readonly (readonly number[])[]` today, so assembling sources per tick would be ~6 JS array allocations per tick, 180/s (fix-list #6). Widen `computeFlowField`, `syncFields`, `fieldFor` and `hashSources` to take a preallocated `Int32Array` plus offset and count:

- `sourcesFlat: Int32Array(groupCount × maxDestinations)` and `sourceCounts: Int32Array(groupCount)`, allocated once alongside `Scratch`; colour `c` occupies `[c × maxDestinations, c × maxDestinations + sourceCounts[c])`.
- `slotCounts: Int32Array(groupCount)`, for Task 3's accumulator.
- `createScratch(cells, groupCount, maxDestinations, fieldInputRanges)` — **not** `createScratch(map)`, so `scratch.test.ts` can still pass a doctored huge `cells` to exercise the `cells * DIAG_COST >= INF` guard without allocating a real map.

**Task 1 owns the buffer shapes and the widened signatures, and nothing else.** The rule for *filling* those buffers — which destinations become sources, in what order — was originally written here, and that was a plan error: it needs the carpark geometry Task 2 defines and it belongs in the `dispatch.ts` this plan's own File Structure assigns to Task 4. Neither file is in Task 1's list. **The assembly rule now lives in Task 4**, and a Task 1 implementer should leave `sourcesFlat`/`sourceCounts` allocated and empty.

Nothing about the widening depends on the assembly rule, so this costs Task 1 nothing.

**Also allocation-free, not merely allocation-light.** Whatever hashes the field-input regions must not construct a view per range per call — 5 `new Uint8Array(state.buffer, offset, length)` per tick becomes 30 once Task 4's `fieldFor` calls exist, which is more per-tick allocation than the ~6/tick this subsection was written to remove. Hold one `Uint8Array` over the whole buffer where the other views are built and index into it. The global constraint is literal: **zero** allocations per tick, and Task 1 reports the measured number.

### 1e. Widen `step()`, and give the sync and `placeRoad` a production home

Nothing in `packages/*/src` currently calls `placeRoad`, `syncFields` or `fieldFor` — the rollback tests wire them by hand. `step(s, inputs)` takes no `world`, no `fields`, no `scratch`. M1b's most consequential finding was that the rebuild loop the game actually runs had no coverage because it had no production home.

- `step(s, world, fields, scratch, inputs)`.
- `TickInputs.actions` widens from `readonly never[]` to `readonly TickAction[]`, where a `TickAction` is `{ kind: 'place' | 'erase', a: number, b: number }`, iterated by index, with an unknown `kind` throwing. Without this, `placeRoad` still has no production caller after Task 1 — the other half of carry-forward item 2 — and Task 6's loop test would hand-place roads outside `step()`, leaving input-application ordering untested by the golden replay path (fix-list #27).
- **The field-read rule** (fix-list #21, carry-forward item 5): `step` calls `fieldFor` **once per colour per tick, in the dispatch phase, and holds the reference for the tick.** `fieldFor` is O(cells) FNV per call and 1c *widens* what it hashes. The safe answer is the slow one and the fast answer is `fields[c].dist[cell]` directly — which passes every test and makes the staleness guard dead code in the exact place it exists to protect. Enforce with a source scan for `fields[` outside `flowfield.ts`. Decision 2 helps here structurally: movement reads no field at all, so dispatch is the only reader and the rule is cheap to keep.
- **Fast-forward is two calls to `step`, never a `dt`** (§5.10). The previous version's bullet "movement over N ticks is identical whether taken in one call or N" asserted nothing — there is no batched API, so both arms ran the same function N times (fix-list #31). Replaced by the stated rule plus a signature arity pin.

### 1f. Instrumentation and the edge-cost tripwires

Add to `Scratch`, all outside the state buffer and outside every hash:

- `counters: Int32Array(2)` — `CT_SYNCS`, `CT_REBUILDS`, cumulative, **never reset by `computeFlowField`** (unlike `stats`, which is documented as carrying nothing between calls). These turn two previously-unwritable tests into direct positive assertions: "`syncFields` runs exactly once per `step`" and "nothing rebuilt this tick". The previous approach — poking `stats[ST_EXPANSIONS] = -1` as a sentinel — can only say "no rebuild", never "the sync ran".
- `pushesPerCell: Int32Array(cells)`, reset per `computeFlowField` call, incremented in `push`.

**Task 1c's original deliverable would have swapped a tripwire for a tautology** (fix-list #24, adjudication item 3). `graph.test.ts:251` is `expect(values.size).toBe(2)` against a literal and `scratch.test.ts:62` is `expect(DISTINCT_EDGE_COSTS).toBe(2)` against a literal; the previously-proposed test ("`DISTINCT_EDGE_COSTS` matches the number of values `edgeCost` can actually return") **passes** under the mutation that matters — a third cost tier added *and* the constant bumped — where today's literals fail. Do all three things:

1. **Keep both literals.**
2. **Add the linkage** the other two reviewers wanted: nothing ties those two literals together today.
3. **Add the test that breaks when the *proof* collapses rather than when the constant moves:** over randomised road graphs, assert `max(pushesPerCell) <= DISTINCT_EDGE_COSTS`. `scratch.ts:78-84` documents a 400-random-graph measurement already, so the fixture exists. This is the only one of the three that fails when the two-pushes-per-cell reasoning stops holding rather than when somebody edits a number. The cost is one typed-array write per push (~1.15 × cells per rebuild) and it is paid deliberately; the cheaper aggregate bound (`stats[ST_PUSHES] <= cells × DISTINCT_EDGE_COSTS + sources`) was rejected because a single cell exceeding the bound can hide inside a total.

Also in `flowfield.ts` / `scratch.ts`:

- The **penalty-routing note**, addressed to whoever adds the first penalty: `NB = DIAG_COST + 1 = 15` is the **exact minimum** — the instrumented maximum spread of pending distances is 14 — and `assertBucketCountExceedsEveryEdgeCost` only inspects `edgeCost(k)`. If a penalty is applied *inside* `computeFlowField` rather than through the cost function, the assert keeps passing while the Dial queue silently aliases two distances into one bucket: wrong paths, no crash. Note what no test can restore: a *per-cell* penalty makes cost depend on more than direction, so `edgeCost(dir)` and everything derived from it goes structurally blind — **the signature is the thing that has to change.**
- **Reconcile the stale comments** (fix-list #36): `scratch.ts:26-28` says intersection penalties "will be exceeded in M1c"; M1c adds none. Rewrite it to name M1d/M1e. `scratch.ts:35` still references "Task 4" from a previous milestone's numbering.

### 1g. Re-bless, once, and re-take the snapshot measurement

Re-bless `1073292924` and `3183850973`. **Assert `252514232` is unchanged** — if it moved, 1d changed pathfinding behaviour, which is a defect.

**Re-take §9.3's snapshot measurement.** The plan's arithmetic says **7,908 B** raw for `firstCity`, against §9.3's 3,809 B reference (measured on a *larger* 43×35 grid), and `carRoute` alone is 3,840 B of it. Measure raw bytes, gzipped bytes and base64 characters at three occupancies — empty, realistic (say 20 houses / 8 destinations with a few cars in flight), and full — and record the numbers in the plan's completion notes. §9.3's "about 6× headroom" against CloudStorage's 4,096-char cap is the claim now at risk, and M3 depends on it. `carRoute` is all-zero for every idle car, so it should compress to nearly nothing, but that is a prediction, not a measurement.

**Coverage required:** the partition is exhaustive and non-overlapping, compared as **sets** so a harmless reorder is not a spurious failure; adding an unclassified region fails a test (it fails a *test*, not "the build" — the previous version overstated this); parameterised over the whole list, poking one byte in **every** `FIELD_INPUT` region moves the stamp and in **every** `FIELD_IRRELEVANT` region does not; `createFieldInputRanges` covers exactly the input regions by count and by total bytes; the layout has zero padding; `mapIdHash` moves for each of the three new `MapData` fields independently; sync → `step()` one tick with no destinations and no inputs → `CT_REBUILDS` did not increase (the test fix-list #4 says nothing today catches); `CT_SYNCS` increments by exactly 1 per `step`; a road placed through `step(s, …, inputs)` on tick T is visible in the field read on tick T; `step` throwing leaves `H_EPOCH` non-zero and the next `step` and `restore` both throw named errors; `DISTINCT_EDGE_COSTS` literals, linkage, and the instrumented pushes-per-cell bound; the three goldens.

**Vacuity self-checks** (fix-list #30): the "input region change invalidates" test must first assert the poked bytes actually moved.

**Mutations to attempt:** move a region from input to irrelevant and confirm a staleness test fails; classify a region but omit it from the ranges array (this is the #5 mutation — it must fail); put `header` in `FIELD_INPUT` and confirm the coalescing test fails; drop one of the three new fields from `mapIdHash`; make `step` skip the sync; make `step` apply inputs after the sync; have `hashFieldInputRegions` rebuild the ranges per call — **and note the observable difference is not the allocation but which ranges table is consulted**: hand `createScratch` a doctored ranges array covering only `mapIdentity`, place a road, and assert `CT_REBUILDS` does not move.

**One mutation this subsection used to ask for is not constructible and has been dropped:** "reorder two regions so padding appears". At `firstCity`'s numbers every region's byte length is already a multiple of 4, so no reordering produces padding. The zero-padding assertion at 1b is therefore unfalsifiable on this map — keep it as a tripwire for future maps, but do not record it as covered.

---

## Task 2: Buildings and cars — placement validity, geometry, the driveway rule

Writes behaviour into regions that already exist. **Asserts all three goldens unchanged** — a state with no buildings is byte-identical to Task 1's blessed state, which is the property Task 1 was built to give.

**Files:**
- Create: `packages/sim/src/buildings.ts`, `packages/sim/test/buildings.test.ts`
- Modify: `packages/sim/src/roads.ts` (the driveway rule), `packages/sim/src/state.ts` (live-prefix accessors), and their tests

**Produces, and the one consumer that matters:** the carpark-cell derivation — `destCell` + orientation → the carpark's cell index — is exported from `buildings.ts` and consumed by **Task 4's source assembly (4a)**, which seeds every flow field from it. It is not a rendering detail. If it is wrong, every field is seeded from the wrong cell and every route is wrong, so the four-orientation coverage below is load-bearing for pathfinding rather than for pixels.

**Placement validity for a destination**, from spec §5.2, §5.9 and dossier §1.12:

- The 6 footprint cells and the carpark cell are all in bounds and all `passable` (LAND or TREE).
- **No cell carries a standing tree.** `hasTree` (`roads.ts:233`) documents itself as the function "M1c's spawn placement calls" — call it, not `world.passable` and not `world.terrain` directly, because a tree destroyed by an earlier road is no longer standing. The previous version did not mention trees at all, and the mutation "use `world.passable[c] === 1`" would have spawned a destination on a standing tree and survived every listed bullet (fix-list #25).
- **No cell carries road.** This is the entire basis of spawn-blocking, a major skill expression, and must not be accidentally optimised away.
- **Chebyshev distance ≥ 2** between any cell of the new destination's *footprint plus carpark* and any cell of any existing destination's *footprint plus carpark*. The measurement basis is stated because "within 1 tile of another destination" is ambiguous three ways and would otherwise be tested against whatever the implementation does.
- **No overlap with any house cell.** Not subsumed by the spacing rule, because houses have no spacing rule of their own. Building-on-building was entirely unconstrained in the previous version.
- Reject when `H_DEST_COUNT === maxDestinations`.

**Placement validity for a house:** one cell, in bounds, passable, no standing tree, no road, not on any destination's 7 cells, not on another house cell, and `H_HOUSE_COUNT < maxHouses`. Spec §5.9's "future houses spawn within ~2 tiles of an existing same-colour house" is a *spawner weighting*, not a validity rule — deferred to M1e, stated so it is not silently dropped.

**Car creation is Task 2's job, not Task 4's** (fix-list #9). Nothing in the previous version created cars — the car regions did not exist until Task 4, Task 4's coverage never mentioned creation, and **Task 6's end-to-end test therefore had no cars.** Placing house `h` writes, for `i` in `[h × CARS_PER_HOUSE, (h+1) × CARS_PER_HOUSE)`: `carHome[i] = h`, `carCell[i] = houseCell[h]`, `carPhase[i] = PHASE_IDLE`, `carTargetDest[i] = -1`, everything else 0. Phases: `PHASE_NONE = 0`, `PHASE_IDLE = 1`, `PHASE_OUTBOUND = 2`, `PHASE_RETURNING = 3` — `PHASE_NONE = 0` is what makes a fresh state hold zero live cars rather than 80 phantom cars parked at cell 0.

**Live-prefix accessors.** `houseAt(s, h)` and `destAt(s, d)` throw for an index ≥ the count. There is no `-1` unused marker; the count is the marker. Note for M1e: destination *removal* will need an explicit hole marker, and these two accessors are the single place that must learn about it — stated here so M1e does not invent a second convention (fix-list #26's concern, answered without shipping an untestable sentinel).

**The driveway rule in `canPlaceRoad`:** the house cell and the carpark cell are placeable; the other six destination cells return `{ ok: false, reason: 'building' }`. Both endpoints are checked. `placeRoad` inherits it by construction, since it calls `canPlaceRoad` first and re-runs the same checks in the same order.

**Coverage required:** a valid house and a valid destination succeed and read back; every rejection reason fires independently, including tree, road, spacing, house-overlap and capacity; the footprint occupies exactly the cells it claims on a **non-square** grid in all four orientations; the carpark lands on the stated cell in all four orientations, and placing it at the *other* adjacent cell on the same side fails; `destMeta` pack/unpack round-trips over all 6 × 2 × 4 combinations with bits 6-7 zero; road may be placed onto a house cell and onto a carpark cell; road onto each of the six footprint cells is rejected with `'building'`; a house placed with no road still has `dist[houseCell] === INF` and a house with a driveway does not; a fresh state has zero houses, zero destinations and **zero live cars**, and `houseAt(s, 0)` throws; placing a house creates exactly `CARS_PER_HOUSE` idle cars at the house cell with `carTargetDest === -1`; the counts track; all three goldens unchanged.

**Vacuity self-checks:** the capacity test must first assert the array is genuinely full, and must assert **both** the rejection *and* that the count did not move — an out-of-range typed-array write is a silent no-op, so `<` → `<=` partially survives otherwise.

**Mutations:** drop the road check; drop the tree check; use `world.passable` instead of `hasTree`; drop the 1-tile spacing; measure spacing from the origin cell only; drop building-on-building; transpose the footprint; place the carpark on the opposite side; shift orientation by 3 bits instead of 4; off-by-one the capacity bound; forget to create cars; create cars with `carTargetDest = 0`; let road be placed on a footprint cell.

---

## Task 3: Demand — the accumulator, the rotation, capacity, overflow

**Files:**
- Create: `packages/sim/src/demand.ts`, `packages/sim/test/demand.test.ts`

**Rules**, per decision 1. All five previously-open rotation questions are settled there; implement them, do not re-litigate them.

Capacities are `PIN_CAP_SQUARE_HARD` / `PIN_CAP_CIRCLE_HARD`, already in `@laneways/shared` [OURS]. The *timer* thresholds (`PIN_CAP_*_TIMER`) are M1e's problem; only the hard caps matter here.

**Coverage required:** a pin lands on the rotation's current destination and the cursor advances past it; a circle receives two pins in immediate succession where a square receives one, asserted as an **exact sequence over one full rotation with the cursor value after each firing** — a per-rotation *count* cannot distinguish `[circle, circle, square]` from `[circle, square, circle]`, and consecutiveness is the burstiness of demand (it is also the only assertion that kills the request-time-multiplier implementation decision 1 explicitly rejects); the cursor wraps; overflow passes to the next *distinct* same-colour destination and skips other colours; the overflow walk terminates when every same-colour destination is capped, and the pin is dropped with `H_PINS_DROPPED` incremented; a destination is excluded from the rotation until `FIRST_PIN_DELAY_TICKS` after its `destSpawnTick`, and two same-colour destinations placed at different ticks each get their own delay; **after K in-game days the pin count is exactly a hand-computed integer** derived from `PIN_PERIOD_TICKS`, over a window spanning ≥ 2 full periods; adding a second destination of a colour does **not** halve the first one's rate; at most one pin per colour per tick; the rotation is stable across a snapshot/restore **and across a destination placement**; all three goldens unchanged.

**The rate bullet is new and it is the largest previously-untested thing in the milestone.** "Baseline ≈ 1.24 pins per in-game day" appeared as a rule in the previous version and in no coverage bullet, with no constant to test against and `TICKS_PER_DAY = 0` deliberately so it could not be derived by division at a call site (fix-list #18).

**Fixture requirements, because the obvious fixture proves nothing** (fix-list #19): ≥ 3 same-colour destinations, the capped one **not** at index 0, and the cursor **not** at 0 — otherwise "start the overflow search at index 0" survives every assertion.

**Vacuity self-checks:** pins delivered `> 0`; the cursor genuinely wrapped; no destination at cap during the rotation measurement (otherwise rotation and overflow are conflated); the rate window spans ≥ 2 full periods and the predicted count is `> 0`.

**Mutations:** drop the overflow branch; let a circle occupy one slot; make the circle's two slots non-consecutive; advance the cursor before assigning rather than after; advance the cursor past the overflow *recipient* instead of the originally chosen slot; ignore the cap; `acc = 0` instead of `acc -= PIN_PERIOD_TICKS`; increment `acc` by 1 instead of `slotCount`; count ineligible destinations in `slotCount`; use `>` instead of `>=` on the eligibility gate.

---

## Task 4: Dispatch — house selection, route commitment, reservation

**Files:**
- Create: `packages/sim/src/dispatch.ts`, `packages/sim/test/dispatch.test.ts`

### 4a. Source assembly — filling the buffers Task 1 allocated

Relocated here from Task 1's 1d, which could not implement it: it needs Task 2's carpark geometry and belongs in `dispatch.ts`. Task 1 leaves `sourcesFlat` and `sourceCounts` allocated and empty; this fills them, once per tick, before the fields sync.

Stated in full because the first version of this plan left it to the implementer, and it violates four existing constraints at once. `flowfield.ts:80-86` already gives the answer verbatim: *"In M1c, pins sit on destinations, which are exactly the cells that may have no road yet, so M1c must seed sources from a destination's road-adjacent access cell, not from the building cell itself."*

- Source cell = the destination's **carpark cell**, from `destCell` + orientation (Task 2's geometry).
- Include a destination iff `destPins[d] > 0` **and** `roadMask(state, carpark) !== 0`. The road check is not decoration: `computeFlowField` silently skips a source with no road bit (`flowfield.ts:150`), so including an unconnected destination would churn `hashSources` and force rebuilds that produce an identical field. This also gives `roadMask` the production caller the carry-forward asked for.
- Insert into the colour's slice in **ascending cell order** by explicit shift (≤ `maxDestinations` elements, so ≤ 128 comparisons per colour per tick), with duplicates dropped. `computeFlowField` **throws** unless sources are strictly ascending, duplicates included (`flowfield.ts:114-121`), for a documented reason: source order silently decides `dir` at ties while `dist` stays identical, so two engines would agree on `dist` and differ on `dir`. Pins enumerate in destination-*slot* order, which is not cell order. Bare `.sort()` is banned by the source scan.
- **The dedupe is unreachable in M1c and that is stated rather than hidden.** Two destinations can only share a carpark cell as a "double destination" (spec §5.2), which M1c does not place, and building-on-building rejection (Task 2) forbids it otherwise. It is kept because `computeFlowField` throws on a duplicate and the cost is one comparison — and `flowfield.test.ts:750` exists specifically for this case. The placement rule that makes it unreachable is the thing that gets tested.

**Coverage required for 4a:** a destination with pins but no road on its carpark is excluded; the same destination becomes a source the tick a road reaches its carpark; a destination whose pins drop to zero leaves the source set; sources land in ascending cell order when pins are created in descending destination-slot order (the case a bare slot-order copy passes and this must fail); two colours fill disjoint slices; `sourceCounts` matches the number written; assembling twice in one tick is idempotent; the reserved-but-still-sourced case from 4b below.

### 4b. Dispatch

**The mechanism**, per decisions 2 and 4. Per colour `c`:

```
remaining = Σ over colour-c destinations of (destPins[d] - destReserved[d])
excluded  = ∅
while (remaining > 0) {
  h = the colour-c house, not excluded, with a free car and minimal dist[houseCell];
      ties break on the lowest house index, never on iteration order
  if (no such h, or dist[houseCell(h)] === INF) break
  d = walk dir downhill from houseCell(h), recording directions, to the terminating carpark cell
  if (walk exceeded MAX_PATH_LEN, or the route is zero-length) { H_ROUTES_REFUSED++; exclude h; continue }
  if (destPins[d] - destReserved[d] === 0) { exclude h; continue }        // decision 4's stated cost
  commit the route to the lowest free car index of h; destReserved[d]++; remaining--
}
```

**The loop bound is specified, not left to reading** (fix-list #12). "Lowest wins" never said how many dispatches happen per tick — one total, one per colour, one per house, or all eligible. Read literally it is one per colour; read as "every eligible house dispatches", a single pin pulls a car from every house on the map. It is load-bearing for trip cadence and for every exact-tick assertion Task 6 needs. Capping at the unreserved pin count is what makes §5.3.6's "cars never compete" true *by construction*.

**Reservation is written inside the loop, immediately, never after it.** Deferring reservations to after the house loop leaves the next tick perfectly correct while two houses both dispatch at one pin this tick — and that **survives every coverage bullet phrased in terms of "the next field's sources"**, which is how the previous version phrased all of them.

**Which car dispatches is pinned:** the **lowest free car index** of the winning house (fix-list #13). It changes which slot the car regions receive, therefore the buffer bytes, therefore `hashState`, therefore browser-vs-Worker byte identity.

**Coverage required:** the nearest house dispatches, not the first, with the nearest at the *higher* index; a house with both cars out is skipped; distance ties break on the lowest house index; the lowest free car index is chosen; an unreachable house (`dist === INF`) dispatches nobody; a house with no driveway dispatches nobody; two colours do not interfere; **one pin, two same-colour houses each with a free car → exactly one car dispatched that tick**; the committed route's direction sequence matches the field's downhill walk step for step, and its length equals the number of cells on that path; a route longer than `MAX_PATH_LEN` refuses, increments `H_ROUTES_REFUSED`, reserves nothing and does not spin; the decision-4 artefact — near destination fully reserved, far one with unreserved pins, one house → **no dispatch this tick**, and a dispatch to the far one after the reserving car arrives; a reserved destination is **still in the next field's sources** (the inverse of the previous version's assertion, and the thing that makes the deadlock impossible); reservation survives a snapshot/restore (fix-list #28 — the previous version asked in prose "why can it not be lost across a rollback" and had no bullet for it); `sum(destReserved) === count(PHASE_OUTBOUND)` after dispatch; all three goldens unchanged.

**Vacuity self-checks:** the two houses' `dist` values must actually differ (a fixture where they tie proves nothing about selection); the committed route must be longer than one step; the refusal fixture's route must genuinely exceed `MAX_PATH_LEN` rather than fail for another reason.

**Mutations:** break the tie rule; pick the highest free car index; apply reservations after the house loop; skip the reservation entirely; drop the `destPins - destReserved > 0` eligibility check (the arrival-phase invariant assertion must fire); use another colour's field; pick the largest `dist`; cache the route in a JS array outside the buffer (Task 6's snapshot test must fail); remove the `MAX_PATH_LEN` bound (a hand-corrupted `dir` cycle must hang, so the bound must be tested with a corrupted `dir`, not only with a long path).

---

## Task 5: Movement — progress in cost units, out and back

**Files:**
- Create: `packages/sim/src/cars.ts`, `packages/sim/test/cars.test.ts`

Per decision 3. Movement reads `carRoute`, `carRouteCursor`, `carRouteLen`, `carProgress` and `edgeCost` — **and never `roads`, never a field.**

Outbound: `progress += speedUnits(LANE_SPEED_DEFAULT)`; while `progress >= edgeCost(route[cursor]) × COST_UNIT_SCALE`, subtract, step `carCell` in `route[cursor]`, `cursor++`. Return: same, stepping `OPPOSITE[route[cursor-1]]` and decrementing. A car may cross more than one cell in a tick only if the speed exceeds a threshold, which it does not at these constants — assert that as a stated invariant rather than leaving a `while` loop whose second iteration is never exercised.

**The risk in this task is the carry, not the rounding** (fix-list #22). Dropping the remainder on a crossing (`progress = 0` instead of `progress -= threshold`) loses up to `speed - 1` units per cell — a systematic slowdown of a fraction of a tick per cell, exactly the "diverges only after thousands of ticks" failure. At the chosen constants the correct arrival over 8 orthogonal cells is tick `ceil(8 × 2500 / 330) = 61` and the carry-dropping version arrives at `8 × ceil(2500/330) = 64`. **This is only observable because 330 does not divide 2,500 or 3,500** — see decision 3.

**Coverage required:** exact arrival tick over ≥ 8 orthogonal cells, hand-computed from the constants, not read back from the implementation; the same over a diagonal-only path, and the ratio of the two is 1.40 within the integer rounding the constants imply; a mixed ortho/diagonal path arrives on its hand-computed tick (this is the case a per-edge-normalised offset gets wrong); the return leg takes exactly as long as the outbound leg from the same carry state; progress carries across a cell crossing, across the outbound→return flip, and is reset at trip end; `speedUnits` matches a **hand-written literal table** at `mul ∈ {333, 500, 667, 1000, 2000, 3000}` plus the clamp boundary, exercised as a unit test independent of the loop — deliberate, because every non-identity multiplier belongs to M1d/M1e and has no other caller yet, so under the loop test alone the rounding rule is dead code and "change the rounding direction" survives everything (fix-list #23); a car whose route is exhausted does not move; a car in `PHASE_IDLE` or `PHASE_NONE` does not move; **a road erased under an in-flight car does not affect it** — the car still arrives on the same tick and the trip completes, and the refund landed immediately (decision 6's stated deviation); all three goldens unchanged.

**Vacuity self-checks** (fix-list #30): the car's cell must have changed; ≥ 1 crossing must have occurred; `carProgress` must be non-zero on some intermediate tick, or a teleporting implementation passes; the mixed-path fixture must actually contain both edge types.

**Mutations:** `progress = 0` on crossing instead of `progress -= threshold`; use `ORTHO_COST` for a diagonal step; use a fixed threshold independent of `edgeCost`; drop the carry at the outbound→return flip; step `route[cursor]` instead of `OPPOSITE[route[cursor-1]]` on the return; change `speedUnits`'s rounding direction; remove the `max(1, …)` clamp; make movement read `dir[cell]` instead of the committed route (this is the re-pathing mutation and it must fail — the fixture must **turn**, because on a straight corridor a field read and a route read agree).

---

## Task 6: Trips, score, the tick order, and the deliverable

**Files:**
- Create: `packages/sim/src/trips.ts`, `packages/sim/test/trips.test.ts`, `packages/sim/test/loop.test.ts`
- Modify: `packages/sim/src/step.ts` (wire the seven phases)

A car whose outbound route is exhausted has arrived. It **removes exactly one pin** from `carTargetDest`, releases its reservation, flips to `PHASE_RETURNING` with `cursor = routeLen`, and retraces. A car whose return is exhausted is home: `H_SCORE++`, `PHASE_IDLE`, `carTargetDest = -1`, route and progress cleared.

**Score credits on return home, not on pickup** — [OURS], per §1.11's "Unknown — we choose". Our reasoning: it matches the wiki's definition of a trip and makes long trips genuinely more expensive. It is not documented developer intent and the previous version implied it was.

**Arrival iteration order is ascending car index** (fix-list #14). Scope defers blocking partly because iteration-order coupling "has no obvious deterministic formulation" — but the coupling already exists here: two cars arriving at one destination on one tick with one pin remaining, whichever the loop reaches first scores. The previous version pinned tie-breaks for dispatch and pinned nothing for arrivals. (Under decision 4's proved `destReserved <= destPins`, both cars actually hold reservations and both find a pin, so the order is not *outcome*-visible today — it is pinned anyway, because the invariant that makes it invisible is exactly the kind of thing M1e's destination removal breaks.)

Arrival **asserts** `destPins[carTargetDest] > 0` and throws a named error otherwise — see decision 4 for why that is a proved invariant rather than a branch.

### The end-to-end test — built to catch things, not to smoke

The previous version's fixture was one house and one destination, run until the score reaches N. On that fixture: dispatch always picking the same house is invisible; wrong speed in either direction is invisible because "run until" has no tick bound; a teleporting car is *faster* and passes sooner; "return to the nearest house" is invisible because nearest ≡ own — **the plan's own listed mutation survived the plan's own fixture**; and sync-before-demand instead of after makes every pin one tick late while the score still reaches N. (Fix-list #20, the strongest single table in the three reviews.)

The fixture:

- **≥ 2 houses at genuinely different route costs, with the nearer house at the *higher* index.**
- **≥ 2 same-colour destinations.**
- The pin timer **frozen or exactly pinned**, so `destPins` is not a moving target under the assertions.
- Roads placed **through `step(s, …, inputs)`**, not by hand, so input-application ordering is exercised by the replay path.

The assertions:

- **The exact tick of every score increment**, hand-computed from the path length and the movement constants — never read back from the implementation.
- **The identity of the dispatching house and of the returning house, per trip.**
- Score-on-return without self-reference: on the tick `destPins` decrements — an independently identifiable, strictly earlier tick — the score is still `N-1`; it becomes `N` later, on the hand-computed tick.
- Exactly one pin consumed per arrival.
- `sum(destReserved) === count(PHASE_OUTBOUND)` after **every** tick.
- Every car's (phase before, phase after) pair is in the allowed-transition table, every tick.
- The whole run replays byte-identically from a mid-flight snapshot.

**Vacuity self-checks for the loop test** (fix-list #30): the score started at 0 and some intermediate tick had score `< N`; the destination held ≥ 1 pin at some point; the two houses' route costs genuinely differ; **before the snapshot**, assert `carPhase === PHASE_OUTBOUND`, `carProgress !== 0`, `carRouteCursor` strictly between 0 and `carRouteLen`, `carCell !== houseCell`, and a live reservation; **after**, assert the abandoned timeline genuinely diverged — `rollback.test.ts` already does this with `hashRoadRegion`, so mirror it with `hashState`.

**Coverage required, beyond the loop test:** the seven-phase order holds and each phase's position is pinned by a test that fails when it moves; a field read after `step` returns on a tick where an arrival occurred throws (the stated residual, asserted rather than assumed); score credits on return, not pickup; the car returns to **its own** house on the two-house fixture; exactly one pin per arrival; arrivals iterate ascending; `H_SCORE` is the one and only score slot; all three goldens unchanged.

**Mutations:** credit on pickup; remove two pins; return to the nearest house; iterate arrivals descending; move the sync before demand; move input application after the sync; move arrivals before movement; move the tick advance after demand; skip the reservation release on arrival; leave `carTargetDest` set after the trip; write `carPhase` in place inside a loop that later re-tests it.

---

## Self-Review

**Spec coverage.** §5.2 buildings, footprints and two-cars-per-house (Task 2); §5.3 destination-pull demand, the rotation, the 4 s gate, overflow, dispatch-selects-the-house, reservation-on-departure and score-on-return (Tasks 3, 4, 6); §5.4 the flow field's dispatch role, one rebuild per tick, and source assembly from the access cell (Tasks 1, 4) — **with two sentences and one paragraph of §5.4 formally contradicted and flagged for amendment**; §5.5 movement (Task 5), explicitly *without* the lane-speed multipliers, which are named as deferred rather than dropped; §5.9 placement rules including spawn-blocking, tree-blocking and the 1-tile spacing (Task 2); §5.11's delayed refund explicitly deferred with its deviation stated; §9.3's snapshot measurement re-taken (Task 1g); §10.3 telemetry gains `H_PINS_DROPPED`, `H_ROUTES_REFUSED`, `CT_SYNCS`, `CT_REBUILDS`. Deliberately absent, with the owning milestone named in Scope: blocking, carparks and congestion (M1d); the week cycle, upgrades, the authored spawn schedule, square→circle upgrade, destination removal, overcrowd failure and game over (M1e).

**Carry-forward orphan functions, each answered rather than left open** (fix-list #35). `hasTree` — production caller in Task 2's spawn validity. `roadMask` — production caller in Task 1d's source assembly. `isConnected` — **explicitly deferred to M1d**, where chunk decomposition needs it; M1c's route walk derives its steps from `dir`, which is derived from `roads`, so calling `isConnected` there would be a second guard on the same fact. `assertSymmetric` and `assertNoRoadOnImpassable` — **declared permanently test-only by design**, not drifting: they are O(cells) whole-grid scans whose value is as property-test oracles, and running them per tick would be the dominant cost. That closes the item rather than deferring it again.

**Placeholders.** None. Tasks name required coverage rather than verbatim test code — the same choice M1b made, for the same reason: five plan-mandated defects in M1a came from blind-written tests being accepted verbatim by an implementer who could see the code. Where the review's executed analysis produced a specific assertion, a specific fixture shape or a specific vacuity check, it is written down, because those came from analysis rather than from guessing.

**Where I depart from the merged fix list, and why.**

1. **`H_TILES` is not immutable.** Fix-list #4 puts it in `mapIdentity`; `placeRoad`/`eraseRoad` write it and M1e's cards grant it. It stays in the mutable, field-irrelevant `header`. Putting it in a field-input region would rebuild every colour on every upgrade card.
2. **`houseCell`/`houseColour` stay field-irrelevant.** Fix-list #15 promotes them along with the destination regions. Constraining where road *may* be placed is not being an input to the current field; the outcome is recorded in `roads`, which is hashed. The destination regions are promoted, as defence-in-depth for the source set, and the reason is stated as such per fix-list #28.
3. **The exact baseline rate is 1.2410 pins/day/square**, not the fix list's 1.2413. 4500/518 = 8.68726 per week, ÷7 = 1.24104.
4. **Fix-list #1's justification has a loose end that #2 creates.** The "reserved pins leave the source set" deadlock argument depends on the re-pathing model, which #2 removes; under path-once that alternative would not deadlock. I still take `destPins > 0`, for two independent reasons stated in decision 4 — halved rebuild cadence, and a source set that transient in-tick bookkeeping cannot touch — and I state the artefact it costs rather than leaving it to be discovered in play.
5. **Fix-list #29's "pins consumed en route" case is unreachable** under decisions 2 and 4 together, so instead of choosing between "return empty", "re-target" and "park", the plan proves the invariant and asserts it loudly. If a reviewer can construct a reachable path to it in M1c, that is a defect in this plan and I would rather hear it than have picked a behaviour for a state that cannot occur.

**The two riskiest things left.** First, the **snapshot size**: 7,908 B is roughly double §9.3's reference measurement on a larger grid, and `carRoute` is half of it. The compression prediction is a prediction; Task 1g must measure it, and if base64 at full occupancy approaches 4,096 chars, that is an M3 finding that belongs in the plan's completion notes rather than a surprise in M3. Second, **`MAX_PATH_LEN = 96` is a judgement call.** It is 1.5× the board's Manhattan diameter, the refusal is defined and tested, and it is the sole thing standing between a corrupted `dir` and a hang — but if real play refuses routes, the constant is wrong and the symptom is a car that never leaves.

**One thing I expect to be wrong.** Decision 4's stated artefact — a house blocked from reaching past its fully-reserved nearest destination for a whole trip duration. I have argued it is uncommon and bounded, and I have pinned it with a test so a change is deliberate. I have not measured it. On a busy map with clustered destinations of one colour, it could be common enough to distort demand distribution visibly, and the fix (two-pass dispatch, or a second field seeded from unreserved destinations only) is not free. A reviewer should push on the frequency estimate, not on the mechanism.
