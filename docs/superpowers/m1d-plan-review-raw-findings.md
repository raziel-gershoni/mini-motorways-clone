# M1d plan review — raw findings

The four-lens run hit the session limit: **124 findings raised, 75 reached a refuter (45 refuted, 30 survived), and the synthesis agent died.** Verdict-to-finding mapping was lost with it — the journal records verdicts without labels.

Treat single-lens unrefuted findings with suspicion: across this project's runs, refuters kill roughly 40-60% of what they see.

---

## [Critical] C1 — Adding two state regions moves four of the five goldens, and no task says so — execution halts at Task 2
**Section:** Task 2 + Task 5 vs Global Constraints ("All five goldens must hold unless a task says otherwise")

Task 2 adds an `Int32Array` occupancy region and Task 5 adds a `pendingErase` region. Every golden except the field golden is `hashState(...)`, i.e. FNV-1a over the WHOLE buffer (`hash.ts` `hashBytes`, `state.ts` `hashState` reads `s.bytes` = whole-buffer view). Growing the buffer by `cells` bytes changes the hash of every state, including an all-zero one. So the state golden (2413319809), the road-network golden (2790151213), the loop golden (3896659943) and the seed golden (2505371110) all move at Task 2, before any behaviour changes. The Global Constraint says "If one moves and your task did not say it would, stop and report — do not re-bless", and only Task 4 declares a move (of the loop golden, "in this task only"). The implementer of Task 2 must stop. Worse, the re-bless is a four-file edit that no task's file list mentions: `determinism.test.ts:555`, `rollback.test.ts:699`, `loop.test.ts:761`, `startingCity.test.ts:616`, plus the two literal-scan assertions at `loop.test.ts:781-782` and `:790` that exist specifically to make a quiet re-bless cost a second failure.

**Witness:** packages/sim/src/hash.ts:6-14 (hash covers every byte); packages/sim/src/state.ts:369-371; grep of the five literals: determinism.test.ts:555, rollback.test.ts:699+743, loop.test.ts:761/781/782/784/790, startingCity.test.ts:616. Occupancy at 24x40 Int32 = +3,840 bytes on a 7,908-byte buffer.

---

## [Critical] C2 — Two cars per house start on the same cell, so one-car-per-cell is violated at tick 0 and the existing loop golden fixture deadlocks
**Section:** Task 2 ("One car per cell"), Decision 1

`CARS_PER_HOUSE = 2` and `placeHouse` sets `carCell[c] = cell` and `carPhase[c] = PHASE_IDLE` for BOTH cars of a house (buildings.ts:342-347). So every house cell holds two cars at rest. The plan never says which phases occupy a cell. If idle cars occupy (the literal reading of "one entry per cell, holding the occupying car index"), the invariant is already false before a car moves, and a returning car can never re-enter its own house cell while its sibling sits there — it is blocked until the 1350-tick valve, every trip, forever. Concrete witness: loop.test.ts's fixture puts H1 at cell 105 = (5,5) with cars 2 and 3 both parked there, and the single road corridor runs along row 5 **through** 105. Car 2 dispatches 105→102, returns, and is blocked at 104 by idle car 3. `obs.scores` expects `tick=47 car=2 ...`; under Task 2 it never fires, and the loop golden is unreachable. If instead only OUTBOUND/RETURNING cars occupy, the plan must say so — and then must also say who claims the cell at dispatch (phase 5) and what happens when a returning car arrives on top of an idle sibling.

**Witness:** packages/sim/src/buildings.ts:342-347; packages/shared/src/constants.ts:62 (CARS_PER_HOUSE = 2); packages/sim/test/loop.test.ts:70-77 (H1 = 105 on row 5, cars 2 and 3), :148 (H1_CELL = 105), :688-694 (ALL_SCORES includes tick=47 car=2).

---

## [Critical] C3 — Classifying occupancy FIELD_INPUT rebuilds every flow field on nearly every tick, for identical output, and makes flowfield.ts allocate per tick
**Section:** Task 2 ("It is a field input — so it must be classified in the layout table and hashed")

`syncFields` compares `hashFieldInputRegions(state, scratch.fieldInputRanges)` against each field's stamp and rebuilds when it differs (flowfield.ts:399-412). Occupancy changes on every cell crossing — with any car in flight that is most ticks, and in Task 7's 20,000-tick jam it is effectively every tick. Nothing in the plan makes `computeFlowField` READ occupancy, so every one of those rebuilds produces byte-identical output at full multi-source Dijkstra cost per colour. Two mechanical consequences: (a) `computeFlowField` allocates one closure per call (flowfield.ts module comment, "It does allocate one closure (the `push` arrow function) per call ... harmless at the up-to-once-per-colour-per-tick rate") — that rate assumption is exactly what this breaks, and `packages/sim/src` is now under the allocation harness with a default budget of 0, so `flowfield.ts` goes red; (b) it directly contradicts the existing partition, which classifies `carCell`/`carProgress`/`carPhase` FIELD_IRRELEVANT with the dated reason "irrelevant while no edge cost depends on occupancy (dated: M1e's demand-actuated lights make car positions a field input)". Occupancy is a projection of `carCell`; classifying the projection FIELD_INPUT while its source stays FIELD_IRRELEVANT is incoherent.

**Witness:** packages/sim/src/flowfield.ts:399-412; module comment on the per-call closure; packages/sim/src/regions.ts:95-98; packages/game/test/allocation.test.ts:336-337 (`PROFILED_SCOPES = [GAME_SRC, SIM_SRC]`) and :232-242 (default budget = noise floor); canary test packages/sim/test/step.test.ts:210-220 ("placing a road increases CT_REBUILDS on that tick, not on the next idle one").

---

## [Critical] C4 — One car per cell on an undirected road makes head-on conflict structural: every follower meets the returning leader, and only the 45-second valve resolves it
**Section:** Decision 2 / Task 3, and Spec §5.5

Roads are an undirected 8-bit mask; a car's return leg retraces the same cells backwards (`cars.ts` `advanceCar`, `OPPOSITE[routeStep(...)]`). So on any single-file road to a carpark, the car that arrives immediately wants the cell occupied by the next car in the queue, and that car wants the carpark. Neither can move. This is not a badly-built city — it is the normal topology and it is what the loop fixture is. The only escape is `MAX_BLOCKED_TICKS = 1350`, i.e. 45 s per encounter, which makes Decision 3's "gridlock is a slowdown rather than a freeze" false in the common case. Spec §5.5 is directional: the chunk "tracks inbound vehicles with a committed timestamp" and density is "1 car per 0.5 tile **of lane**" — the plan collapses both directions into one slot and drops direction entirely. Decision 1 records the cost as "road capacity is half what the spec's density implies"; the actual cost is that opposing traffic blocks, which is a different and much larger claim. Nothing in Tasks 2, 3 or 7 mentions the head-on case, and Task 3's queue bullet ("three cars behind a blocked leader") is same-direction only, so no specified test can see it.

**Witness:** packages/sim/src/cars.ts:208 (return leg retraces via OPPOSITE); spec §5.5 "each tracks inbound vehicles with a committed timestamp", "1 car per 0.5 tile of lane"; loop.test.ts fixture: single corridor row 5, d1 carpark 102 at the dead end.

---

## [Critical] C5 — Task 2's file list excludes cars.ts, where every one of its own coverage bullets lives — and excludes regions.ts, where regions are actually declared
**Section:** Task 2 Files ("blocking.ts (new), state.ts (one region), blocking.test.ts")

Every Task 2 coverage bullet is about car movement: "a car entering a free cell succeeds", "the blocked car's progress is held at the threshold", "advances exactly one cell on the tick the way clears", "occupancy is released on the same tick the car leaves", "two cars contending for one cell resolve in ascending index". All of that is `advanceCar`/`runMovement` in `packages/sim/src/cars.ts`, which is not in Task 2's file list (it appears first in Task 3). As scoped, Task 2 can implement `canEnter` and a region and cannot test any of its stated behaviour. Separately, both Task 2 and Task 5 say "state.ts (one region)", but `regionsFor`, `FIELD_INPUT_REGIONS` and `FIELD_IRRELEVANT_REGIONS` live in `regions.ts` — `regions.ts` is named in no task at all — while `state.ts` owns `GameState`, `REGION_FIELD_NAMES` and `viewsOver`'s instanceof block. And an `Int32Array` region must be declared inside the 4-byte tier (before `carRouteLen`), or regions.test.ts's "descending-alignment declaration order buys zero padding" assertion fails.

**Witness:** Task 2 Files vs packages/sim/src/cars.ts:193-262; packages/sim/src/regions.ts:28-63 (regionsFor), :81, :105-123 (partition lists), :20-26 (zero-padding rule); packages/sim/src/state.ts:174-197 (REGION_FIELD_NAMES), :237-262 (instanceof block).

---

## [Critical] C6 — "-1 means free" contradicts the documented all-zero creation invariant that every golden depends on
**Section:** Task 2 ("holding the occupying car index or -1")

`createState` writes only `rng`, `mapIdentity` and `H_TILES`; state.ts:306-315 states as a load-bearing property that "A fresh `GameState` is all-zero in every region ... no `-1` sentinel is written anywhere at creation" and that this is "what makes 'a building-free state is byte-identical to a from-scratch M1c-shaped state' true, which is the property the single re-bless and every later task's unchanged-goldens assertion both depend on". An occupancy region whose free value is -1 must be filled at creation, which breaks that invariant and every argument built on it. The alternative encoding (0 = free, car index + 1) is not what the plan specifies, and the plan does not choose. Left as specified, a freshly created state reads as "car 0 occupies every cell on the board" until something initialises it — and there is no initialisation step in any task.

**Witness:** packages/sim/src/state.ts:306-327; regions default to zero via `new ArrayBuffer(stateBytesFor(map))`.

---

## [Critical] C7 — A one-slot-per-cell Int32Array cannot represent the shared-cell state the valve creates, and the release rule is undefined
**Section:** Decision 3 / Task 3 ("Two cars may briefly share a cell when the valve fires")

The occupancy region is one `Int32Array` entry per cell. When the valve fires, two cars are on one cell — a state the structure cannot hold. The plan never says what `occupancy[cell]` becomes. Both readings fail: (a) the arriving car overwrites the slot, so the resident car is no longer registered — when the arriver later leaves and writes -1, the cell reads FREE while a car still sits on it, admitting a third car and compounding; (b) the arriving car does not write, so it is unregistered — when the resident leaves and writes -1, the same hole opens from the other side. Either way the invariant Task 2's whole test battery asserts ("occupancy is released on the same tick the car leaves") becomes false the first time the valve fires, and Task 3's bullet "two cars sharing a cell after the valve is asserted as reachable" asserts the reachability of a state the data structure cannot express. Task 2's mutation list ("release occupancy a tick late / a tick early") does not touch this.

**Witness:** Task 2 "One `Int32Array` region, one entry per cell, holding the occupying car index or `-1`" vs Decision 3 and Task 3's valve.

---

## [Critical] C8 — The valve's interaction with GHOST and NO_ROAD is unspecified, and both answers break a stated guarantee
**Section:** Task 3 (the valve) vs Task 2 (`canEnter` outcome codes) vs Task 5 (ghosts)

Decision 3 states the valve "guarantees no car is ever stuck forever". Task 2 gives `canEnter` five outcomes; Task 5 adds "a ghost cell is not traversable by a car that has not already committed to it". The plan never says whether the valve overrides only `OCCUPIED` or every refusal. If it overrides everything, Task 5's ghost guard is bypassed 45 s later and the "erasing a road under traffic would be free capacity" hole it exists to close reopens on a timer; if it overrides only `OCCUPIED`, a car facing a `GHOST` or `NO_ROAD` cell is stuck forever, which falsifies the no-starvation guarantee and holds a `destReserved` slot forever, starving the destination — the exact failure Decision 3 cites as the reason the valve exists. Task 7's long-run bullet "assert no car starves" has no chance of resolving this because "starves" is never defined either.

**Witness:** Decision 3 ("It also guarantees no car is ever stuck forever, which matters because a permanently frozen car would hold a reservation and starve a destination") vs Task 5 ("A ghost cell is not traversable by a car that has not already committed to it") and Task 2's `GHOST`/`NO_ROAD` codes.

---

## [Critical] C9 — The loop fixture has no turn and no intersection, so no lane-speed multiplier applies and the loop golden does not move
**Section:** Task 4 ("the loop golden must therefore move; say so and re-bless once, in this task only")

The plan states the loop golden must move because of the multipliers. The loop fixture is a single straight road corridor along row 5 from x=2 to x=16, all steps orthogonal, with two carparks and two houses sitting ON that corridor (loop.test.ts's fixture comment). Fourteen `place` actions produce a path where every interior cell has exactly two road bits (E and W) — there is no turn (every consecutive route step is the same direction) and no cell of degree >= 3, so "right-angle turn", "sharp turn" and "approaching intersection" are all inapplicable. Plain-cell speed stays `speedUnits(1000) = 330`. The golden therefore does NOT move from Task 4. An implementer told it must will either hunt a non-existent bug in a correct implementation, or edit the fixture until it does move — silently retiring the four-route cost matrix that fixture was built around.

**Witness:** packages/sim/test/loop.test.ts:60-100 (fixture geometry: "One straight road corridor along row 5, from x = 2 to x = 16", "Every step is orthogonal"); packages/sim/src/cars.ts:99-101 (`speedUnits`).

---

## [Critical] C10 — For every combination of 667/500/333 the averaging rounding direction is invisible after speedUnits — the bullet is unsatisfiable, and the rounding rule it does exercise already has a detector
**Section:** Task 4 ("the rounding rule is exercised at a value where rounding up and down differ")

Averaging the multipliers and converting: (667+500)/2 = 583.5 -> 583 or 584; 330*583/1000 = 192.39 and 330*584/1000 = 192.72, both truncate to **192**. (500+333)/2 = 416.5 -> 416 or 417; 137.28 and 137.61, both **137**. (667+333)/2 = 500 exactly and all three average to 1500/3 = 500 exactly — no rounding at all. So no pair of the three multipliers this milestone introduces produces a value where the average's rounding direction is observable. Meanwhile the rounding rule the bullet claims is "dead code" — `speedUnits`'s truncation — already has a live detector: `cars.test.ts:216-217` asserts `speedUnits(333) === 109` and `.not.toBe(110)`. So Task 4 demands a test for a rule that is already covered, and the genuinely new rule (how to round the average) has no constructible observer. Note also that the choice is not merely a rounding direction: averaging the multipliers then converting vs converting then averaging give different answers — (667,500): 192 vs (220+165)/2 = 192.5; (667,333): 165 vs (220+109)/2 = 164.5 — and the plan never states which.

**Witness:** packages/shared/src/constants.ts:34-36 and :209 (330); packages/sim/src/cars.ts:100; packages/sim/test/cars.test.ts:216-217.

---

## [Critical] C11 — The `y < 0` bound provably has no detector from any caller, and the plan's own carry-forward records it as a verified equivalent mutant
**Section:** Task 1a Coverage ("the four bounds are each independently detected from *both* callers")

`dispatch.ts`'s own doc comment proves it: "with `x` fenced into `[0, w - 1]`, any `y <= -1` makes `y * w + x <= -1`, so the caller's own `if (next < 0) break` masks the `y < 0` bound completely. Direct calls observe all four." `cars.ts`'s caller has the same shape (it throws on `next < 0`). The m1d carry-forward's residuals list states it flatly: "`y < 0` in `stepCell` is a genuine equivalent mutant, verified exhaustively over ~1600 geometries and Int32 extremes: 56 raw differences, 0 observable. ... It survives mutation and that is correct." Task 1a demands the impossible from both callers. An implementer chasing it will either fabricate a detector (a source scan dressed as behaviour) or, worse, weaken the `x` guards so the `y` guard becomes load-bearing. The requirement should be per-bound direct calls plus a caller-refusal witness, which is what the code already documents.

**Witness:** packages/sim/src/dispatch.ts:315-318; docs/superpowers/m1d-carry-forward.md:55; packages/sim/src/cars.ts:222-233.

---

## [Critical] C12 — Neither property is achievable: DrawContext has no alpha, and road strokes are baked into the atlas at build time
**Section:** Task 6 ("a ghost cell draws at reduced opacity and a **thinner** stroke")

Roads are drawn as one `drawImage` blit per cell from a 256-tile atlas (canvas.ts `drawRoads`), and canvas.ts's own header states "the atlas bakes its stroke colour in at build time and a blit cannot re-tint its source". Stroke WIDTH is baked the same way. The `DrawContext` interface — deliberately "the slice of `CanvasRenderingContext2D` the draw path uses, and nothing more" — has `fillStyle`, `font`, `textAlign`, `textBaseline`, `fillRect`, `fillText`, `drawImage` and nothing else: there is no `globalAlpha`, no `lineWidth`, no stroke method. So "reduced opacity" requires widening `DrawContext` (and the test recorder), and "a thinner stroke" requires either a second baked ghost atlas or scaling the destination rect, which shrinks the whole tile rather than the stroke. `packages/render/src/atlas.ts` is in no task's file list, and neither is any `DrawContext` widening. This is the milestone's unassigned-work shape in its M2 form.

**Witness:** packages/render/src/canvas.ts:118-143 (DrawContext), :80-89 (baked atlas note), :492-517 (drawRoads blit); Task 6 Files = canvas.ts, types.ts, frame.ts.

---

## [Critical] C13 — Map expansion / the dynamic revealed rect is assigned to M1d in six source files and appears in neither the In scope nor the deferral table
**Section:** Scope (the "Out, and named so the gap is not read as an oversight" table)

This is the fifth instance of the milestone's recurring failure — work no task owns. Six production files name M1d as the owner of making the revealed rect dynamic: `shared/constants.ts:72-76` ("**Frozen constants, and M1d owns making them dynamic.** ... When M1d lands, the camera reads state instead of these four numbers"), `shared/mapFormat.ts:21`, `shared/maps/firstCity.ts:9`, `render/types.ts:124` ("**M1d owns making it dynamic**"), `render/canvas.ts:321,344,557`, `game/shell.ts:173` ("M2 freezes it in `shared`; M1d makes it dynamic"). The M2 plan review flagged the absence of any revealed-region state three separate times and each time deferred it to M1d by name. The M1d plan mentions it nowhere — not in Scope In, not in the deferral table (which lists lights, bridges, overcrowd, the demand ramp and persistence), not in "What this plan does not settle". It will be silently dropped, and the four comments promising it will read as satisfied.

**Witness:** packages/shared/src/constants.ts:66-94; packages/render/src/types.ts:124; packages/game/src/shell.ts:173; docs/superpowers/m2-plan-review-raw-findings.md:132,430,617,864.

---

## [Critical] C14 — "Approaching intersection" forces cars.ts to read state.roads, destroying its documented structural defence, and the routing/movement divergence is neither resolved nor named
**Section:** Task 4 Files (`cars.ts`, `graph.ts`)

Turn multipliers are derivable from the committed route alone, but "approaching an intersection" needs road degree, i.e. `state.roads`. `cars.ts`'s module comment makes never reading `roads` a load-bearing property: "This module also never reads `state.roads`. A road erased under an in-flight car therefore does not touch it" — the tested M1c deviation, with a determinism test behind it. Task 4 breaks it with no acknowledgement. Second, `cars.ts:81-97` states the reason M1c applied no multipliers at all: "if movement applied turn or intersection multipliers the flow field could not see them, so the routing model and the movement model would diverge by design". Task 4 lists `graph.ts` in its files but has no coverage bullet, no mutation and no decision about `edgeCost`. Both branches are unowned: leave `edgeCost` alone and ship the stated divergence undiscussed, or change it and trigger a chain of re-derivations no task assigns — `NB = DIAG_COST + 1` is documented as "the exact minimum, with zero slack", `DISTINCT_EDGE_COSTS`, `entryPoolCapacity`, `COST_UNIT_SCALE` and `CAR_SPEED_UNITS_PER_TICK` ("Re-derive this WITH `NB`, `DISTINCT_EDGE_COSTS` and `CAR_SPEED_UNITS_PER_TICK` when `edgeCost`'s value set changes") — plus the field golden 252514232, which Task 4 does not say will move. `scratch.ts` also warns that a per-cell penalty makes `edgeCost(dir)` "structurally blind — the signature is the thing that has to change".

**Witness:** packages/sim/src/cars.ts:29-33, :81-97; packages/sim/src/scratch.ts:24-45 (NB), :46-52 (DISTINCT_EDGE_COSTS), :110-125 (entryPoolCapacity); packages/shared/src/constants.ts:166-171.

---

## [Critical] C1 — Classifying occupancy as a FIELD_INPUT rebuilds every flow field every tick, and the premise is false
**Section:** Task 2 — Occupancy and the blocking primitive

Task 2 states the occupancy region "is a field input — a car's presence changes routing viability — so it must be classified in the layout table and hashed". Nothing in M1d makes routing depend on occupancy: M1c decision 2 commits a route once at dispatch, `runMovement` reads no field, and dispatch's downhill walk reads only `dir[cell]`. `regions.ts:95-98` already dated this exactly the other way: the car regions are FIELD_IRRELEVANT "while no edge cost depends on occupancy (dated: M1e's demand-actuated lights make car positions a field input)". Hashing occupancy has a hard mechanical consequence: `syncFields` compares `hashFieldInputRegions` against each field's stamp, and the hash changes on every tick any car moves, so `field.builtFromFieldInputs === fieldInputHash` never holds and `computeFlowField` runs for every colour on every tick, forever — the exact opposite of §5.4's "coalesce dirty rebuilds to at most one per tick", in the one milestone whose carry-forward says "M1d's blocking is the first feature whose cost scales with traffic density". The hashing cost alone is 6 passes per tick (one in `syncFields`, one per colour in `fieldFor`) over 3,840 extra bytes: today's field-input set is ~1,068 B/pass, so this is a 4.6x increase in per-tick hashing on top of 5 full Dijkstra rebuilds per tick that currently almost never run.

**Witness:** packages/sim/src/flowfield.ts:405 `if (field.builtFromFieldInputs === fieldInputHash && field.builtFromSources === sourcesHash) continue` — with occupancy in `scratch.fieldInputRanges`, one car advancing one cell changes `fieldInputHash`, so this `continue` is never taken again. packages/sim/src/regions.ts:95-98 is the dated classification the plan contradicts without naming it.

---

## [Critical] C2 — Tasks 2 and 5 each move four of the five goldens, and the plan forbids exactly that
**Section:** Global Constraints vs Tasks 2 and 5

Global Constraints: "All five goldens must hold unless a task says otherwise... If one moves and your task did not say it would, stop and report — do not re-bless." Only Task 4 declares a move (the loop golden, "once, in this task only"). But four of the five goldens are `hashState(...)` over the whole buffer, and `hashState` is `hashBytes(s.bytes)` — an FNV walk over `byteLength`. Task 2 appends a per-cell region and Task 5 appends another, so the buffer grows and every one of state `2413319809` (determinism.test.ts:555), road-network `2790151213` (rollback.test.ts:699), loop `3896659943` (loop.test.ts:761) and seed `2505371110` (startingCity.test.ts:616) moves in Task 2, and again in Task 5. Only the field golden `252514232` (a fold of `dist`/`dir`) is immune. As written, Task 2's implementer is instructed to stop and report on a change the task itself mandates. Compounding it: the goldens are watched cross-file — `loop.test.ts:781-790` reads `determinism.test.ts` and `rollback.test.ts` off disk and asserts the literals are still present — so a re-bless requires editing a fourth file that no task's Files list mentions.

**Witness:** packages/sim/src/state.ts:369 `hashState` → `hashBytes(s.bytes)`; `s.bytes = new Uint8Array(buffer)` over the whole buffer, sized by `regionsFor`. Adding `{name:'occupancy', ctor: Int32Array, len: cells}` adds 3,840 zero/-1 bytes on `firstCity` (24x40) and changes the FNV chain. loop.test.ts:781 `expect(determinism, 'the M1c state golden moved').toContain('toBe(2413319809)')`.

---

## [Critical] C3 — Blocking deadlocks `loop.test.ts`'s own fixture head-on at tick 73; every hand-computed literal in it becomes unreachable
**Section:** Tasks 2/3 vs the existing loop fixture (no task owns it)

The loop fixture is a single straight corridor on row 5 (cells 102..116) with H0 at 116 and H1 at 105, and its timeline is hand-computed in the file's module comment. Car 0 (H0) is dispatched at tick 2, reaches the D2 carpark (110) at tick 47 and returns east; car 1 (same house) is dispatched at tick 51 and travels west along the same cells. They are on the same one-lane corridor in opposite directions from tick 51 to 92. Under one-car-per-cell they mutually block and neither moves again until the valve fires 1,350 ticks later — long after `RUN_TICKS = 150`. Consequences, all in tests no task lists as changing: `obs.scores` loses `tick=92 car=0` and `tick=141 car=1` (asserted as exact arrays at loop.test.ts:445-448 and :684-687), `H_SCORE` at GOLDEN_TICK is 2 not 3 (:739), `expect(r.state.carPhase[1]).toBe(PHASE_RETURNING)` fails (:747), and the golden hash is over a jammed board rather than "a car still in flight". This is not a re-bless — the fixture no longer demonstrates what it was built to demonstrate (a full out-and-back to a non-nearest destination), and redesigning it (a second corridor, or one car per direction) is work no task owns.

**Witness:** Hand-derived from the fixture's own crossing schedule (`rel_k = ceil(k*2500/330)` = 8,16,23,31,38,46,54,61,69,76,84,91). Car 0 cell timeline: 110@47-54, 111@55-61, 112@62-69, 113@70-76, 114@77-84. Car 1 (dispatched tick 51): 116@51-57, 115@58-65, 114@66-72, 113@73-80. At tick 73 car 1 attempts to enter 113, occupied by car 0; at tick 77 car 0 attempts 114, occupied by car 1. Deadlock at tick 73, valve at tick 1423.

---

## [Critical] C4 — The stated cost is the wrong cost: one car per cell removes the spec's second lane, so opposing traffic cannot pass at all
**Section:** Design decision 1 — "One car per cell, and the density cost is stated rather than hidden"

Decision 1 records the cost as "road capacity is half what the spec's density implies" and frames the alternative as sub-cell slots for the spec's 1-car-per-0.5-tile density. That is not what is being given up. Spec §5.11 says a road segment is "Bidirectional, one lane each way" — two lanes, one per direction. One occupancy slot per cell collapses both directions into a single lane, so an outbound car and a returning car on the same corridor block each other permanently. Because M1c's return leg retraces the outbound route cell for cell (`cars.ts:208`, `OPPOSITE[routeStep(cursor-1)]`) and the flow field gives one path per cell per colour, head-on meetings are not an edge case — they are the normal state of every corridor carrying more than one car. The anti-deadlock valve does not fix this; it converts every head-on meeting into a 45-second stall for both cars and then lets them pass through each other, which is the collision behaviour M1d exists to remove. The whole milestone goal ("make road layout matter") is met by a mechanism that makes the game's own shipped starting city grind to a halt on a road the seed's comment calls "the natural first road the player draws".

**Witness:** packages/game/src/startingCity.ts:53-58: both colour-0 carparks land on column 8, "a clear column from y=10 to y=24 ... That column is the natural first road the player draws ... and it connects both colour-0 houses to both colour-0 destinations at once." Four colour-0 cars (H0 cars 0-1 at (8,24), H1 cars 2-3 at (8,13)) share that single column in both directions. Spec line 570: "Bidirectional, one lane each way."

---

## [Critical] C5 — The valve's accepted "two cars share a cell" state is unrepresentable in Task 2's data structure, and no task defines the bookkeeping
**Section:** Design decision 3 / Task 3 — the anti-deadlock valve

Task 2 defines occupancy as "One `Int32Array` region, one entry per cell, holding the occupying car index or `-1`" — a single-valued slot. Decision 3 then states "Two cars may briefly share a cell when the valve fires. That is accepted and must be asserted as reachable." The structure cannot hold two car indices, and neither resolution is specified. If the entering car overwrites the slot, the earlier occupant's claim is lost, and when the *entering* car later leaves and writes -1, the cell is marked free while the original occupant is still on it — a second car enters and the one-car invariant is silently broken with no observer. If the entering car does not record itself, it blocks nobody while it drives, and when the original occupant leaves it writes -1 for a cell that is still occupied — same outcome. If release is guarded by "only clear if the recorded occupant is me", then the un-recorded car's cell is never cleared and becomes a permanently occupied phantom: every future car through it stalls 45 s and then punches through, forever. Task 3's coverage bullet asserts the shared state is *reachable* but nothing asserts what the occupancy array holds afterwards, so all three broken variants pass it.

**Witness:** Reachable directly from the head-on case in C3/C4: cars A@X wanting Y and B@Y wanting X both fire the valve, A moves to Y and B moves to X within one `runMovement` pass; the slots for X and Y are each written twice in one tick by two different cars in an order determined by ascending index.

---

## [Critical] C6 — The valve needs per-car persistent blocked-tick state and no task owns adding a region for it
**Section:** Task 3 — Files list

`MAX_BLOCKED_TICKS = 1350` requires a per-car counter that survives across ticks, snapshot/restore and a cold Worker replay. Task 3's Files are `blocking.ts`, `cars.ts`, `trips.ts` — no `state.ts`, no `regions.ts`. Task 2 adds "one region" (occupancy) and Task 5 adds "one region" (ghosts); nothing allocates a `carBlockedTicks` region, adds it to `REGION_FIELD_NAMES`/`viewsOver`, or classifies it in the FIELD_INPUT/FIELD_IRRELEVANT partition (whose union assertion enumerates every declared region and will fail the moment a region is added to one list and not the other). If an implementer puts the counter on `Scratch` instead, M1c's demonstrated determinism property breaks immediately: `determinism.test.ts` cold-rebuilds fields and scratch on every single tick for 900 ticks, which would reset every car's blocked counter every tick and mean the valve never fires in a replay while it does fire in a browser — the precise browser-vs-Worker divergence the project exists to prevent.

**Witness:** packages/sim/src/state.ts:174-197 `REGION_FIELD_NAMES` and :237-262 the instanceof gate; packages/sim/src/regions.ts:81/105 the two partition lists. The carry-forward, "What M1c demonstrated": "snapshot + restore with fields and scratch cold-rebuilt on every single tick for 900 ticks".

---

## [Critical] C7 — Dispatch never claims or consults occupancy, so two cars from one house occupy the house cell on the day the primitive lands
**Section:** Tasks 2/3 — no task owns dispatch's interaction with occupancy

`CARS_PER_HOUSE = 2`, and `dispatchColour` sets `carPhase[k] = PHASE_OUTBOUND` without writing `carCell[k]` — an idle car already sits on its house cell (`completeTrip` writes `carCell[i] = houseCell[carHome[i]]`). A car takes 7.576 ticks to leave a cell, so the second car of a house dispatched on any of the seven ticks after the first is placed on a cell the first car still occupies. No task's section says dispatch consults `canEnter`, refuses a dispatch onto an occupied cell, or claims occupancy at spawn. Worse, unused car slots are all `carCell = 0` (M2 established this), so a naive "occupancy = f(carCell) for every slot" implementation has every dead car claiming cell 0. And the lifecycle at the other end is equally undefined: if an idle car holds occupancy of its house cell, house 1 at (8,13) sits *on* the starting city's road spine, so two parked cars permanently block every trip between house 0 and carpark 0; if it does not, a through car and a parked car share a cell and the invariant the whole milestone rests on is violated at the fixture the game ships with.

**Witness:** packages/sim/src/dispatch.ts:541-546 (sets cursor/progress/phase, never `carCell`); packages/sim/src/trips.ts `completeTrip` → `state.carCell[i] = state.houseCell[...]`; packages/game/src/startingCity.ts:144 house 1 at (8,13), on column 8, which is also the carpark column for both colour-0 destinations.

---

## [Critical] C8 — A per-cell `pendingErase` flag cannot express a per-segment erase, cannot compute the right refund, and carries none of the bits Task 6 needs to draw the ghost
**Section:** Task 5 / Design decision 5 — "A delayed refund is a per-cell pending state"

`eraseRoad(state, world, a, b)` erases one *segment* — two mirrored direction bits — and refunds "one tile per endpoint whose mask becomes entirely 0", i.e. 0, 1 or 2 tiles depending on the other segments still attached to each endpoint. Decision 5 models the pending state as one boolean per cell. Three things then have no answer: (1) a cell where two different segments are erased on different ticks under different cars sets the same single flag, and the flag cannot say how many tiles are owed or which departure discharges which erase; (2) the refund is a property of an endpoint's *mask becoming zero*, which depends on the other segment's erase timing, so "refund on the tick the last committed car leaves" is not well defined per cell; (3) Task 6 must draw the ghost as a road shape at a thinner stroke, which requires the erased direction bits — a boolean carries none of them, so the renderer cannot know what shape to draw. Task 5's coverage bullet "the tile budget is exactly restored, never double-refunded" is stated over a model that cannot represent the quantity being restored.

**Witness:** packages/sim/src/roads.ts:244-250: `let refund = 0; if (newMaskA === 0) refund++; if (newMaskB === 0) refund++`. Fixture: cell C with segments to N and to S; erase C–N while a car is committed (mask still non-zero, refund 0 owed at C), then erase C–S (mask now 0, refund 1 owed at C) — one flag, two erases, an amount that depends on ordering.

---

## [Critical] C9 — Whether a ghost cell keeps its road bits is undecided, and both branches are broken; the coverage bullet passes either way for the wrong reason
**Section:** Task 5 / Task 2 — GHOST

Task 5 requires "a ghost cell is not traversable by a car that has not already committed to it" and Task 2 lists `GHOST` as a `canEnter` outcome, but nothing says whether `eraseRoad` still clears the mask bits immediately. If it does: the flow field loses the edge at once, dispatch commits no route through the ghost, no new car ever attempts entry, `GHOST` is unreachable production code, the "let a new car enter a ghost" mutation is a provable no-op, and Task 5's traversability test passes because the *road* is gone, not because the ghost check works — the catalogue's most-repeated family ("a negative assertion satisfied by the wrong mechanism") in its most literal form. If it does not: `canPlaceRoad` computes cost from `maskA === 0`/`maskB === 0`, so re-placing over a ghost costs **0 tiles**, and the pending refund then fires when the car clears — the player erases under a car, immediately re-draws the same segment for free, and is handed 1-2 tiles created from nothing, repeatable. The field would also route new cars into a ghost they cannot enter, and they would sit there until the valve punched through 45 s later.

**Witness:** packages/sim/src/roads.ts:174-176 `const cost = (maskA === 0 ? 1 : 0) + (maskB === 0 ? 1 : 0)` — with bits retained, an erased-then-re-placed segment is charged 0 while a refund is still pending against it. Nothing in Task 5's five coverage bullets or five mutations covers re-placement over a ghost.

---

## [Critical] C10 — A blocked car renders one full cell ahead of the cell it occupies, so a jam draws on the wrong cells and overlaps the car it is waiting for
**Section:** Task 6 — "Queued cars need no new rendering — they are cars at positions"

`resolveCar` places a car at `cell + DX[dir] * f` with `f = carProgress / (edgeCost(dir) * COST_UNIT_SCALE)`, where an integer names a cell **centre**. Decision 6 requires a blocked car to hold `carProgress` **at the threshold** so it crosses on the very tick the way clears — which makes `f = 1.0` exactly, i.e. the car is drawn at the centre of the cell it has *not* entered. A queue of three blocked cars on cells X, Y, Z is therefore drawn on cells Y, Z and W: the cell at the tail of the jam looks empty, every car looks like it is sitting inside the cell it is yielding to, and the head of the queue is drawn on top of whatever occupies the next cell (0-0.13 cells apart from it, against a 0.5-tile car sprite — a near-total overlap). Task 6 asserts no rendering work is needed and owns no fix; nothing else in the milestone renders a queue. Under the review's own lens this is what a player sees when they draw a road into a jam, and it reads as a rendering bug, not as traffic.

**Witness:** packages/game/src/resolve.ts: `const f = (state.carProgress[i] as number) / (edgeCost(dir) * COST_UNIT_SCALE)`; `out[offset] = cx + (DX[dir] as number) * f`. With `carProgress === threshold`, `f === 1` and the drawn position is exactly the next cell's centre.

---

## [Critical] C11 — Nothing in the milestone measures the cost of a jam — the M2 "handed to nobody" failure, repeated verbatim
**Section:** "What this plan does not settle" — "Frame cost under a full jam"

The plan closes with "Frame cost under a full jam. M2's only device evidence is qualitative and from a near-empty board. A hundred queued cars is the first workload whose cost scales with traffic." That sentence names no task, no milestone and no file — which is precisely the shape the catalogue records as the fourth M2 failure ("a review measured `canPlaceRoad` allocating in the frame loop, correctly scoped it out of its own task, and handed it to *whoever owns the perf budget*. There was no such owner"). Checking the task list: Task 6 asserts only that nothing *allocates* per frame; Task 7's long run asserts only correctness invariants over 20,000 ticks; no task times a tick or a frame, sets a budget, or records a number. Combined with C1 (a full multi-colour Dijkstra rebuild every tick) and the carry-forward's "M1d's blocking is the first feature whose cost scales with traffic density", the milestone will ship with its single largest known risk unmeasured and its own document saying so with no recipient.

**Witness:** Plan lines 196-198 versus the task list: the strings "ms", "budget", "timing" and "performance" appear in no task section. Catalogue entry: "'Handed to whoever owns X' is a drop when nobody owns X ... A handoff needs a named recipient — a task, a milestone doc, a file. 'Someone' is a synonym for 'no one'."

---

## [Critical] C12 — Both tasks require code paths that disable blocking and disable the valve, and no task owns providing them
**Section:** Task 7 integration test and Task 3 vacuity self-check

Task 7: "assert throughput falls measurably below the unblocked case with hand-computed figures ... total trips strictly below the M1c baseline on the same fixture." Once Task 2 lands there is no unblocked case to compare against on the same fixture — the fixture is new to Task 7, so an M1c baseline for it does not exist and cannot be produced without a way to run `step` with blocking off. Task 3: "the gridlock ring must actually deadlock without the valve — assert that by disabling it in the test." Neither a blocking toggle nor a valve threshold parameter is specified anywhere, and decision 1 explicitly forbids adding configuration "for later" ("an untested second value is dead code that reads as a supported configuration"). The codebase's established idiom for exactly this — parameterise the constant so the branch is reachable from a test (`assertSingleCrossing(residual, minThreshold)`, `advanceCar(..., speed)`, `assertDispatchProgress`) — is not named, so an implementer will either invent an ad-hoc global, hand-write a "baseline" number with nothing behind it, or drop the assertion.

**Witness:** packages/sim/src/cars.ts:186-188: "`speed` is a parameter rather than a constant read, and that is the only reason the one-crossing-per-tick guard is testable at all." The plan asks for two equivalent parameterisations and specifies neither.

---

## [Critical] C1 — Head-on traffic deadlocks permanently: every return leg retraces the outbound route on a bidirectional road, and a single occupancy slot per cell cannot represent one lane each way
**Section:** Decision 1 / Task 2 / Task 3 — one car per cell

Spec §5.11 is explicit: roads are "Bidirectional, one lane each way." The plan's occupancy is ONE slot per cell with no direction, so an outbound car on cell X wanting X+1 and a returning car on X+1 wanting X block each other permanently — neither ever releases, and ascending-index resolution cannot break a mutual block. This is not an exotic case: `trips.ts`/`cars.ts` decision 2 makes the return leg *the same route read backwards*, so every car retraces the corridor it came out on, and `CARS_PER_HOUSE = 2` guarantees two cars per house sharing routes. On any single-corridor network — which is every network early in a run — outbound and return traffic meet head-on constantly. The only escape is the 1,350-tick valve, i.e. a 45-second freeze, after which the two cars *swap through each other*, which is precisely the "cars pass through each other" behaviour M1d exists to remove. Decision 1 records the density halving as "the cost… stated rather than hidden" but is silent on the far larger cost: losing the directional lane. No task owns a swap rule, a direction field, or a two-lane occupancy slot.

**Witness:** packages/sim/src/cars.ts:167-178 and packages/sim/src/trips.ts:104-112 (the return leg is the outbound route reversed); spec §5.11 "Bidirectional, one lane each way"; concrete trace in C2.

---

## [Critical] C2 — The project's own loop fixture deadlocks at tick 73 under the new primitive — the loop golden, the hand-computed timeline, and four assertions in loop.test.ts all break in Task 2, which says goldens must hold
**Section:** Task 2 / Task 3 (and Global Constraints, goldens)

loop.test.ts's fixture is a single corridor on row 5 (cells 102..116) with both destinations' carparks and both houses ON it. Hand-trace with the fixture's own rel_k table (rel_k = ceil(k*2500/330) = 8,16,23,31,38,46,54,61,69,76,84,91; abs = dispatchTick + rel_k − 1):

• Car 0 (H0, cell 116) dispatched tick 2 westbound to d2 (110); arrives 110 at tick 47; returns east, entering 111/112/113/114/115/116 at ticks 55/62/70/77/85/92.
• Car 1 (H0, cell 116) dispatched tick 51 westbound; enters 115/114/113/112/111/110 at ticks 58/66/73/81/88/96.

At tick 73 car 1 (on 114) tries to enter 113, which car 0 occupies from tick 70 to 77 → blocked. At tick 77 car 0 tries to enter 114, which the now-blocked car 1 still occupies → blocked. Mutual, permanent until the valve at ~tick 1423. RUN_TICKS = 150, so within the run: `car 1 reaches d2 at 96` never happens, `pinsConsumed.length` drops from 4 to 3, `carPhase[1] === PHASE_RETURNING` at the golden tick fails, `carProgress[1]`/`carRouteLen[1]` differ, SCORE 4 at 141 never happens, and `hashState(r.state)` at tick 130 moves. Task 2 introduces the primitive and its coverage says nothing about the loop fixture; only Task 4 is authorised to move the loop golden. Executing Task 2 as written hits the Global Constraint "stop and report".

**Witness:** packages/sim/test/loop.test.ts:59-146 (fixture + timeline), :121 (rel_k table), :761 (`expect(hashState(r.state)).toBe(3896659943)`), :740-755 (the mid-flight assertions on car 1).

---

## [Critical] C3 — Adding a state region moves four of the five goldens for pure layout reasons; only Task 4 authorises a move, and the cross-file golden guard is unmentioned
**Section:** Global Constraints vs Task 2 and Task 5

`hashState` is `hashBytes` over the WHOLE buffer (state.ts:369-371), and `stateBytesFor` derives from `regionsFor`. Task 2 adds an occupancy region and Task 5 adds a ghost region, so the state golden (2413319809), the road-network golden (2790151213), the loop golden (3896659943) and the seed golden (2505371110) all move on layout alone — before any behavioural change. Only the field golden (252514232) survives, because it folds `dist`/`dir`, not the buffer. The plan authorises exactly one re-bless (the loop golden, in Task 4). Worse, the goldens are cross-guarded: loop.test.ts reads determinism.test.ts and rollback.test.ts off disk and asserts the literals are unchanged, so a re-bless in one file fails a test in another, in a third package's test too (`startingCity.test.ts`). No task owns that bookkeeping, and the plan's "if one moves and your task did not say it would, stop and report" halts execution at Task 2.

**Witness:** packages/sim/src/state.ts:369-371 and :131-133; packages/sim/test/loop.test.ts:781-790 (the cross-file scan); packages/sim/test/determinism.test.ts:555; packages/sim/test/rollback.test.ts:699; packages/game/test/startingCity.test.ts:616.

---

## [Critical] C4 — Occupancy is NOT a field input in M1d, and hashing it rebuilds every colour's flow field on every tick
**Section:** Task 2 — "It is a field input … must be classified in the layout table and hashed"

The stated reason — "a car's presence changes routing viability" — is false for this milestone: no edge cost, no source, and no `dir` read depends on occupancy. `regions.ts` already classifies every car region FIELD_IRRELEVANT with a dated note saying the change lands in M1e ("irrelevant while no edge cost depends on occupancy (dated: M1e's demand-actuated lights make car positions a field input)"). Classifying occupancy FIELD_INPUT puts a region that changes on nearly every tick into `hashFieldInputRegions`, so `syncFields` finds every colour stale every tick and runs a full multi-source Dijkstra per colour per tick — 5 whole-board rebuilds at 30 Hz on a phone, in the one milestone whose cost scales with traffic. That destroys design decision 3's whole premise ("coalesce dirty rebuilds to at most one per tick") silently, with correct answers — exactly the failure mode `state.ts` documents for why `H_TICK` was moved out of a hashed region. It also contradicts the plan's own Decision 6/Task 2 mutation "omit the region from the field-input hash" being a defect. Additionally it will fail step.test.ts's "placing a road increases CT_REBUILDS on that tick, not on the next idle one" the moment a car is moving.

**Witness:** packages/sim/src/regions.ts:95-98 (dated classification), :81; packages/sim/src/flowfield.ts:399-412 (`syncFields` rebuild gate); packages/sim/src/state.ts:24-34 (the H_TICK precedent); packages/sim/test/step.test.ts:210-220.

---

## [Critical] C5 — The valve's per-car blocked-tick counter has no home: Task 3's file list contains no state region, and module-scope mutable state is banned
**Section:** Task 3 — the anti-deadlock valve

`MAX_BLOCKED_TICKS = 1350` requires a per-car counter that survives ticks, snapshot/restore and replay. Task 3's files are `blocking.ts`, `cars.ts`, `trips.ts` and their tests — no `state.ts`, no `regions.ts`. Only Tasks 2 and 5 are given "state.ts (one region)", and both spend theirs (occupancy, ghost). A Global Constraint bans module-scope mutable state and `step`'s arity is pinned at 5, so there is nowhere else it can live. This is the milestone's silently-unassigned work: without the region the valve cannot be implemented at all, and with it the goldens move a third time (see C3). It is also required by Task 7's "at least one car blocked for ≥ 10 consecutive ticks" guard, which needs blocked duration to be *readable*.

**Witness:** Plan Task 3 file list vs Task 2/Task 5 ("state.ts (one region)" each); Global Constraints ("no module-scope mutable state"); packages/sim/test/step.test.ts:99 (`expect(step.length).toBe(5)`).

---

## [Critical] C6 — The occupancy array cannot hold the state the valve creates; release-on-leave then corrupts it and lets a third and fourth car in
**Section:** Decision 3 / Task 3 — "Two cars may briefly share a cell"

One `Int32Array` slot per cell holds one car index. When car B valves into cell X occupied by A, `occupancy[X]` can record only one of them. Trace the consequences, neither of which the plan chooses between: (a) unconditional release — when A later leaves X it writes −1, erasing B's record while B is still on X, so X reads FREE and a third car enters; symmetrically in the ring case the lower-index car's move is immediately erased by the higher-index car's release, leaving a cell occupied but marked free. (b) conditional release (`if occ[X] === i`) — A's departure is a correct no-op, but B's later departure sets X free while A (if it were still there) is untracked; and the invariant "occupancy[carCell[i]] === i for every in-flight car" is permanently broken from the first valve firing onward, so one-car-per-cell silently stops holding for the rest of the run. "Briefly" is also wrong: the valve fires precisely because the jam is persistent, so the shared state lasts until the merged car can cross a threshold — at minimum 8 ticks, and in a real jam another 1,350. Task 3's coverage bullet "two cars sharing a cell after the valve is asserted as reachable" is satisfiable (via equal `carCell`) while the occupancy array is corrupt, so the test cannot distinguish right from wrong.

**Witness:** Plan Task 2 ("One Int32Array region, one entry per cell, holding the occupying car index or -1") vs Decision 3 ("Two cars may briefly share a cell"); no release rule is stated anywhere in the plan.

---

## [Critical] C7 — The occupancy invariant is violated at tick 0 of every fixture: two cars per house both stand on the house cell, and nothing assigns the claim/release points at dispatch, arrival and trip end
**Section:** Task 2 — who occupies what, and when

`placeHouse` creates `CARS_PER_HOUSE = 2` cars, both with `carCell = houseCell` and `PHASE_IDLE`. So before any tick runs, two cars share a cell — a state the occupancy array cannot represent. Unused slots are worse: every `PHASE_NONE` car has `carCell = 0`, so 80-odd phantom cars nominally occupy cell 0. The plan never says whether idle cars occupy, whether a car claims its starting cell at dispatch (dispatch.ts explicitly allows a house with two free cars to dispatch both in one tick — both would then be OUTBOUND on one cell), whether `completeTrip`'s `carCell = houseCell` write releases anything, or whether a returning car is blocked from entering its own house by an idle sibling (which would deadlock at home until the valve, since an idle car only leaves when demand dispatches it). Task 2's file list is `blocking.ts`/`state.ts`/tests — it touches neither `dispatch.ts` nor `trips.ts`, where those claims and releases must be written.

**Witness:** packages/sim/src/buildings.ts:342-349 (both cars at `cell`, PHASE_IDLE); packages/sim/src/dispatch.ts:552 (`reselect = lowestFreeCar(h) >= 0` — two dispatches from one house in one tick); packages/sim/src/trips.ts:152 (`carCell[i] = houseCell[...]` at trip end); packages/game/src/frame.ts:70-74 (unused cars are cell 0).

---

## [Critical] C8 — "Refund when the last committed car clears" is not computable from occupancy, and `canEnter(state, cell)` has no car parameter, so the ghost's traversability rule cannot be expressed
**Section:** Decision 5 / Task 5 — delayed refunds and ghosts

Decision 5 models the ghost as "a per-cell `pendingErase` flag plus the existing occupancy: the refund fires on the tick the last committed car leaves." Occupancy records only who is standing on the cell now. A car that committed to the cell at dispatch but is five cells short of it leaves occupancy at −1, so the refund fires immediately and the ghost disappears while a committed car is still inbound — the exact case §5.11 exists for. Conversely Task 5's bullet "a ghost with two committed cars refunds on the second one's departure" is not constructible under one-car-per-cell: two cars cannot be on the cell at once, so an occupancy-keyed rule refunds on the first departure and the fixture's own vacuity check ("the cars must clear on different ticks") proves the mechanism wrong rather than the test right. "Committed" is a property of a car's remaining route, which requires walking `carRoute` per in-flight car — and Task 2's declared signature `canEnter(state, cell)` takes no car index, so the rule "not traversable by a car that has not already committed to it" is structurally inexpressible in the function the plan names for it.

**Witness:** Plan Task 2 (`canEnter(state, cell)`), Decision 5, Task 5 coverage bullets 2-4; packages/sim/src/dispatch.ts:540-546 (the whole route is committed at dispatch, cells the car has not reached yet included).

---

## [Critical] C9 — Task 4 contradicts three pinned M1c invariants and never decides whether the multiplier enters routing; either answer breaks something the task's file list does not include
**Section:** Task 4 — lane-speed multipliers

Three separate collisions, none named by the task. (1) `cars.test.ts` pins the *literal source line* `const speed = speedUnits(LANE_SPEED_DEFAULT)` in `runMovement`; a per-car, per-cell speed cannot keep it, and keeping it as a dead line turns a deliberate linkage pin into decoration. (2) "approaching intersection 0.5" requires knowing a cell is a junction, i.e. reading the road mask — and the same test asserts by source scan that `cars.ts` never matches `state.roads[`. Moving the read into `blocking.ts`/`graph.ts` passes the scan while making its stated invariant ("movement never reads roads") false: a guard defeated by the natural next edit, with no failing test. (3) The task lists `graph.ts` but never says whether the multiplier enters `edgeCost`. If it does, `NB = DIAG_COST + 1` is documented as the EXACT minimum with zero slack, `DISTINCT_EDGE_COSTS = 2` sizes the entry pool, and `COST_UNIT_SCALE`/`CAR_SPEED_UNITS_PER_TICK` are "one calibration, not four independent numbers" — a wrong `NB` aliases two distances into one bucket and produces wrong paths with no crash; `scratch.ts` is not in the file list. If it does not, then the routing model and the movement model diverge exactly as `cars.ts` says they would, and the flow field routes cars down paths that are slower in practice, forever.

**Witness:** packages/sim/test/cars.test.ts:654 (`not.toMatch(/state\s*\.\s*roads\s*\[/)`) and :668 (`toMatch(/const speed = speedUnits\(LANE_SPEED_DEFAULT\)/)`); packages/sim/src/scratch.ts:29-45 (NB is the exact minimum; a penalty applied outside `edgeCost` aliases silently), :47-54; packages/shared/src/constants.ts:165-171; packages/sim/src/cars.ts:85-90.

---

## [Critical] C10 — Ascending index resolves contention but leaves queue-release order undefined; a five-car queue advances either all at once or one car per tick depending on arbitrary car indices, and Task 3's "hand-computed arrival ticks" cannot be computed as written
**Section:** Decision 2 / Task 3 — contention and release ordering

Cars are indexed by house slot (`base = h * CARS_PER_HOUSE`), which has no relationship to position along a road. For a nose-to-tail queue: if the leader's index is lower than its follower's, the leader releases its cell before the follower is visited and both move on the same tick — the whole queue shifts in one tick. If the leader's index is higher, each follower sees the leader still present and waits, so the release wave propagates one cell per tick and a five-car queue takes four extra ticks to clear. That is a factor-of-N difference in jam throughput decided by nothing the player or the designer controls, and the plan never states which behaviour is intended, nor that both are possible. Task 3's coverage requires "three cars behind a blocked leader … each advances in order when it clears, with hand-computed arrival ticks" — those ticks are not computable until the fixture's index-vs-position layout is fixed, and a fixture that happens to be ascending front-to-back proves nothing about the descending case (and vice versa). The plan's mutation "release the queue in descending order" presupposes a defined release order that does not exist.

**Witness:** packages/sim/src/cars.ts:258-262 (`runMovement` ascending, one `advanceCar` per car); packages/sim/src/buildings.ts:342 (car index = house slot, unrelated to road position); plan Decision 2 and Task 3 coverage bullet 1.

---

## [Critical] C11 — A car holding progress at the threshold renders exactly on the cell of the car blocking it: every queued car is drawn one full cell forward, stacked on its leader
**Section:** Decision 6 / Task 6 — "holds its progress at the threshold" / "Queued cars need no new rendering"

`resolveCar` computes `f = carProgress / (edgeCost(dir) * COST_UNIT_SCALE)` and places the car at `cell + DX*f`. Holding progress AT the threshold makes `f = 1.0`, i.e. the car is drawn exactly on the next cell — the occupied one. A queue of four therefore renders as four cars each superimposed on the one in front, which is the exact visual the milestone exists to replace, and it persists for the whole blockage (up to 1,350 ticks). Task 6 asserts the opposite without checking: "Queued cars need no new rendering — they are cars at positions." The fix lands in `packages/game/src/resolve.ts`, which appears in no task's file list. Decision 6 also does not say what happens to the remainder: `progress` reaches `threshold + r` with r ∈ [0, speed); clamping to `threshold` discards up to 329 units per blocking event, which is the same systematic-loss bug `cars.ts`'s carry rule exists to prevent, while storing the full value and re-adding speed next tick is the "accumulate" the plan forbids. Two implementers will produce different bytes, and therefore different hashes, from the same sentence.

**Witness:** packages/game/src/resolve.ts:184-188 (`f = progress / threshold`, position = `cx + DX[dir] * f`); plan Decision 6 and Task 6 paragraph 2.

---

## [Critical] C12 — Board expansion / the dynamic revealed rect is assigned to M1d in five places in the codebase, and the plan neither schedules it nor defers it
**Section:** Scope — the "Out" table

This is the fifth instance of the M2 pattern the plan was written to avoid: work that exists, is dated to this milestone in the source, and appears in no task and no deferral row. `shared/constants.ts` says "Frozen constants, and M1d owns making them dynamic… When M1d lands, the camera reads state instead of these four numbers"; `render/types.ts` says "M1d owns making it dynamic"; `canvas.ts` twice names what "M1d must revisit when the rect becomes dynamic" (building culling by anchor cell, and a `clip` around phases 3-7); `mapFormat.ts` and `firstCity.ts` both say "Expansion (§5.1, M1d)"; `constants.test.ts` says "made dynamic by M1d". The Scope section's Out table is explicitly "named so the gap is not read as an oversight" — expansion is not in it. Either M1d does it (a state region, a per-week schedule, camera and culling changes) or it must be moved to M1e *and those five comments repointed*, or the codebase now documents a handoff to a milestone that declined it.

**Witness:** packages/shared/src/constants.ts:72-76; packages/render/src/types.ts:124; packages/render/src/canvas.ts:321,344,557; packages/shared/src/mapFormat.ts:21; packages/shared/src/maps/firstCity.ts:9; packages/shared/test/constants.test.ts:102.

---

## [Critical] C13 — The delayed refund contradicts a pinned existing test, and the task's own first coverage bullet describes the wrong rule
**Section:** Task 5 — "erasing an unoccupied road refunds immediately"

`cars.test.ts` has a dedicated describe block asserting that erasing a road under an in-flight car refunds IMMEDIATELY (`tilesLeft` 991 on the erase tick) and leaves the car's crossing ticks and arrival identical — M1c's stated, tested deviation from §5.11. Task 5 reverses that behaviour but its file list says only "roads.ts, blocking.ts, state.ts, tests", and nothing flags that this specific existing test must change. Worse, the bullet as written — "erasing an unoccupied road refunds immediately" — is exactly wrong for that fixture: cell 50 is unoccupied at the moment of the erase and is on a committed route, so under §5.11 it must NOT refund immediately. The task's stated acceptance criterion and the rule it is implementing disagree.

**Witness:** packages/sim/test/cars.test.ts:586-628 ("refunds immediately and does not touch the car, which arrives on the same tick", `expect(tilesLeft(state)).toBe(991)`); packages/sim/src/cars.ts:29-33; packages/sim/src/roads.ts:65-69.

---

## [Critical] C1 — Classifying occupancy FIELD_INPUT rebuilds every colour's flow field every tick, and it is not a field input by the partition's own definition
**Section:** Task 2 — "It is a field input"

The stated reason ("a car's presence changes routing viability") is untrue in M1d. computeFlowField reads only state.roads, world and the source slice; edgeCost(dir) (graph.ts:94) is pure length with no occupancy term. regions.ts:95-98 already classifies carCell/carProgress/carPhase FIELD_IRRELEVANT with the dated reason "while no edge cost depends on occupancy (dated: M1e's demand-actuated lights make car positions a field input)". Occupancy is derived from exactly those regions and belongs on the same side. The plan conflates two hashes: determinism needs occupancy in hashState, and hashState(s) = hashBytes(s.bytes) (state.ts:369-371) hashes the WHOLE buffer, so every declared region is in it automatically regardless of partition side. FIELD_INPUT is the flow-field staleness key (hashFieldInputRegions, flowfield.ts:241) and buys nothing for replay. Cost of getting it wrong: (a) syncFields (flowfield.ts:399-412) computes fieldInputHash once per tick and rebuilds every colour whose stamp disagrees; occupancy bytes change on every tick any car crosses a cell, so all groupCount=5 colours run a full 960-cell Dijkstra every tick, forever, at 30 Hz. Today CT_REBUILDS only moves on a road edit or a pin change. (b) If anything claims occupancy during phase 5 (see C4 — a car spawning at its house cell), fieldFor for the NEXT colour recomputes hashFieldInputRegions, disagrees with the stamp syncFields just wrote, and throws 'field is stale — call syncFields before reading it this tick' from inside step, poisoning H_EPOCH and making the run unresumable. Fix: classify occupancy FIELD_IRRELEVANT, state the dated reason, and note that hashState already covers it.

**Witness:** Add 'occupancy' to FIELD_INPUT_REGIONS and run loop.test.ts's 900-tick fixture: scratch.counters[CT_REBUILDS] goes from a handful to ~900*groupCount. Separately, have dispatch write occupancy[houseCell] on commit and colour 1's fieldFor throws in the same tick colour 0 dispatched.

---

## [Critical] C2 — Adding any state region moves four of the five goldens; only Task 4 is authorised to re-bless, and it re-blesses a different one
**Section:** Global Constraints vs Task 2 and Task 5 ("state.ts (one region)")

hashState hashes the whole ArrayBuffer, so appending a region changes the hash even when the new bytes are all zero. Task 2 adds an occupancy region and Task 5 adds a pendingErase region; neither says a golden moves. Global Constraints say "If one moves and your task did not say it would, stop and report — do not re-bless." Executing the plan as written therefore halts at Task 2 with four red goldens: determinism.test.ts:555 (2413319809), rollback.test.ts:699 (2790151213), loop.test.ts:761 (3896659943) and startingCity.test.ts:616 (2505371110). Two more things break with them: loop.test.ts:781-790 is a cross-file source scan asserting the first three literals still appear verbatim in the other files, and game/src/main.ts:152 documents 2505371110 and 4171132894 in prose. Only the field golden 252514232 (foldedFieldsHash, rollback.test.ts:743) is unaffected, since it hashes dist/dir rather than the buffer. Each region-adding task must state exactly which goldens move and re-bless in the same commit, and one task must own the loop.test.ts scan and main.ts.

**Witness:** node: FNV-1a over a 100-byte zero buffer is 3846586517; over a 100+960*4-byte zero buffer it is 230362261. Same logical content, different hash.

---

## [Critical] C3 — The region table lives in regions.ts, not state.ts — and the valve's per-car counter is given no region at all
**Section:** Task 2 / Task 3 / Task 5 file lists

Three separate problems in one place. (1) Drift: 'state.ts (one region)' is wrong. regionsFor moved to regions.ts in M1c (state.ts:14-21, regions.ts:28). Adding a region requires edits in BOTH: regionsFor's list plus FIELD_INPUT_REGIONS or FIELD_IRRELEVANT_REGIONS in regions.ts, and the GameState interface, REGION_FIELD_NAMES, the views.get block, the instanceof block and the return literal in state.ts. regions.ts is named by no task in the plan. (2) regions.test.ts:121 pins FIELD_INPUT_REGIONS to EXACTLY {mapIdentity,destCell,roads,destMeta,destPins} and :202 pins inputEntries.length against it — Task 2's classification breaks both, unmentioned. (3) The anti-deadlock valve needs a per-car blocked-tick counter that survives snapshot/restore and must be in hashState, so it must be a buffer region. Task 3's file list is blocking.ts, cars.ts, trips.ts — no state.ts, no regions.ts, no shared/constants.ts. Nothing in the plan creates that region, sizes it (maxCars, and Uint8 wraps at 255 well below 1350 so it must be Int16/Int32), or classifies it. The review lens asks 'where does the valve counter live, is it in the hash, does it survive restore' — the plan answers none of the three.

**Witness:** regions.test.ts:95 (union === declaredNames) and :121 fail the moment a region is declared without being classified; no task's file list opens the file that would fix them.

---

## [Critical] C4 — The silently unassigned work: nothing claims occupancy when a car is dispatched or releases it at trip end — and one car per cell is already violated at tick 0
**Section:** Tasks 2, 3, 5 — no task owns dispatch.ts after Task 1

Occupancy is a claim/release protocol with four events: enter a cell, leave a cell, come into existence, cease to exist. The plan specifies the first two (Task 2) and no task owns the last two. dispatch.ts appears in no task after Task 1's refactor, and trips.ts appears only for the carpark pin. Worse, the initial state already contradicts the primitive: buildings.ts:342-347 gives every house CARS_PER_HOUSE = 2 cars and writes carCell[c] = cell for BOTH, phase PHASE_IDLE — two cars on one cell for every house on the shipped starting city, before anything moves. completeTrip (trips.ts:152) writes carCell back to the house cell, so two cars can be home at once. dispatch.ts:552 (reselect = lowestFreeCar(h) >= 0) exists specifically so a house with two free cars serves two pins in ONE tick, putting two outbound cars on the house cell simultaneously. And unused car slots have carCell = 0 with PHASE_NONE, so a naive scan over state.carPhase.length claims cell 0 forever — the same 'dead slots at cell 0' shape the catalogue records from M2. The plan must state, per task, which cars occupy a cell (in-flight only? idle too?), what happens at the house cell, and who writes it.

**Witness:** buildings.ts:342-347 places 2 idle cars on one cell; dispatch.ts:552 commits both in one tick; cars.ts:260 iterates all state.carPhase.length slots, of which the unused ones sit at carCell 0.

---

## [Critical] C5 — The valve's accepted outcome is not representable in a one-slot-per-cell Int32Array, and the natural release protocol corrupts occupancy permanently
**Section:** Design decision 3 / Task 3 — "Two cars may briefly share a cell when the valve fires"

The region holds one car index or -1 per cell. When car A's valve fires into cell X occupied by B, occupancy[X] can record only one of them. Whichever release protocol the implementer picks is wrong: (a) unconditional release — B later leaves X and writes occupancy[X] = -1, wiping A's claim; X now reads FREE while A stands on it, so car C enters, and when A leaves it wipes C. The corruption cascades and the cell count of live cars silently exceeds capacity forever. (b) guarded release (only clear if occupancy[X] === me) — B's departure is a no-op, A's claim stands, and the state is consistent, but only if EVERY release site is guarded. The plan specifies neither, and Task 2's coverage bullet 'occupancy is released on the same tick the car leaves' plus the mutation 'release occupancy a tick late/early' point squarely at the unconditional form. Meanwhile Task 3 requires 'two cars sharing a cell after the valve is asserted as reachable' — a test that would pass while the buffer is in the corrupt state. Either specify the guarded release explicitly, or make the region a per-cell count plus an owner, or hold the valve car's claim on its ORIGIN cell until the target frees.

**Witness:** Sequence: occupancy[X]=B; A valve-fires, occupancy[X]=A; B moves to Y and clears occupancy[X]=-1; A is on X with X reading FREE; C enters X. Three cars, one cell, no error anywhere.

---

## [Critical] C6 — A returning car and its queued follower deadlock head-on on any single-lane approach; every dead-end destination becomes 45 s per car
**Section:** Task 3 — carpark queues

The return leg retraces the outbound route exactly: advanceCar (cars.ts:208) steps OPPOSITE[routeStep(cursor-1)] and decrements. arriveAtDestination (trips.ts:114-122) flips the phase in place and leaves the car standing ON the carpark cell K. So on the next tick the returning car must enter K-1, which is precisely the cell the queued follower occupies, while the follower wants K. Neither can move. This is not an exotic fixture — it is the shape of every destination reached by a one-lane road, which is the common case and exactly the case Task 3's own 'three cars behind a blocked leader' fixture builds. The valve makes it a 1350-tick stall per car rather than a permanent freeze, which means a normally-built city crawls at one carpark service per 45 seconds. The plan never mentions bidirectional conflict at all: 'queueing emerges from Task 2' is true for same-direction flow and false for opposing flow on a shared cell. M1d needs a stated answer (a give-way rule that prefers the returning car, letting the carpark cell hold two, or a swap rule) and a coverage bullet for it.

**Witness:** Cells ...K-2,K-1,K with dest carpark at K. Car A arrives at K on tick T and flips to PHASE_RETURNING; car B sits at K-1 outbound to the same dest. On T+1 A->K-1 is OCCUPIED and B->K is OCCUPIED, in either index order. Nothing moves until tick T+1350.

---

## [Critical] C7 — "Committed" is never defined, canEnter's signature cannot express the ghost rule, and the refund trigger has no mechanism
**Section:** Design decision 5 and Task 5 — ghost roads

Three unspecified decision points on the critical path of Task 5. (1) 'A ghost cell is not traversable by a car that has not already committed to it' requires knowing WHICH car is asking, but the plan's signature is canEnter(state, cell) with no car index — the GHOST code is returned identically to the committed car and to a stranger, so the rule cannot be implemented against it. (2) 'Committed' is undefined. Does it mean the car currently stands on the cell, or that the cell appears anywhere in its carRoute? The second reading holds a ghost for a car 40 cells away for its whole journey, and determining 'the last committed car' then costs an O(cars x MAX_PATH_LEN) route scan per tick or a per-cell committed-count region nobody has declared. (3) Does eraseRoad clear the road bits immediately? If yes, routing already excludes the cell and the GHOST traversal rule is redundant; if no, the ghost is still routable and pendingErase becomes a genuine field input with all of C1's consequences. The plan says nothing, and every downstream coverage bullet ('refunds on the tick that car clears', 'a ghost with two committed cars refunds on the second one's departure') depends on the answer.

**Witness:** Task 2 fixes canEnter(state, cell); Task 5 requires a per-car answer from it. The two tasks cannot both be executed as written.

---

## [Critical] C8 — Putting a lane-speed term in edgeCost is structurally impossible for turn multipliers and invalidates NB, DISTINCT_EDGE_COSTS, COST_UNIT_SCALE and CAR_SPEED_UNITS_PER_TICK together
**Section:** Task 4 — Lane-speed multipliers, files include graph.ts

Task 4 lists graph.ts (edgeCost's only home) but says nothing about what changes there, and both possible readings are broken. (a) If the multipliers enter edgeCost: a right-angle or sharp turn is a property of the (incoming, outgoing) direction PAIR, not of one edge, and Dijkstra over cells cannot price it without expanding the state to (cell, incoming dir) — the signature edgeCost(dir) is structurally blind, exactly as scratch.ts:38-42 warns. It would also break the Dial queue: scratch.ts:33-44 states NB = DIAG_COST + 1 = 15 is 'the exact minimum, with zero slack' against an instrumented maximum spread of 14, so any larger edge weight aliases two distances into one bucket — wrong paths, no crash, and assertBucketCountExceedsEveryEdgeCost keeps passing. constants.ts:166-169 says COST_UNIT_SCALE must be re-derived WITH NB, DISTINCT_EDGE_COSTS and CAR_SPEED_UNITS_PER_TICK when edgeCost's value set changes — 'one calibration, not four independent numbers'. The plan re-derives none of them, and would also move the field golden 252514232, which Task 4 does not authorise. (b) If the multipliers apply in movement only: that is the divergence cars.ts:85-89 explicitly warns against ('the routing model and the movement model would diverge by design'), it is the correct pragmatic choice, and the plan must say so and say why graph.ts is in its file list at all.

**Witness:** scratch.ts:44 NB = DIAG_COST + 1; flowfield.ts:46-54 measures the true pending spread at 14, i.e. zero headroom. constants.ts:166-169 names the four-constant re-derivation obligation Task 4 drops.

---

## [Critical] C9 — Determinism coverage regresses in the milestone that first makes iteration order outcome-visible; determinism.test.ts and rollback.test.ts are owned by no task
**Section:** Task 7 — Long-run

M1c proved byte-identity with 7 comparisons including snapshot + restore with fields and scratch cold-rebuilt on EVERY tick for 900 ticks, a rollback across a throwing tick, warm-vs-cold field reuse, 2x(N/2) fast-forward, and roads erased under in-flight cars. M1d's entire determinism budget is one bullet in Task 7: 'two identical runs agree on hashState'. Two runs of the same code on the same machine is the weakest possible check — it cannot detect anything a browser/Worker split would, and it certainly cannot detect the failure this milestone actually introduces. No task's file list contains determinism.test.ts or rollback.test.ts, so the 7 existing comparisons are neither extended to a jammed fixture nor re-run under one. The lens question 'a restored mid-jam state has cars blocked, progress held at thresholds, ghosts pending — does the plan say enough to reconstruct that exactly?' has no owner: Task 2's 'a snapshot/restore round-trips occupancy' is a byte round-trip, not a resume-and-compare. What is needed and missing: a mid-jam snapshot, restore, and N further ticks compared byte-for-byte against the uninterrupted run, with fields and scratch cold-rebuilt each tick, on a fixture where at least one car is blocked and one ghost is pending at the snapshot instant.

**Witness:** grep for determinism.test.ts / rollback.test.ts across the plan: zero hits. Task 7's file list is loop.test.ts, integration.test.ts and the deploy.

---

## [Important] I1 — The signature cannot compute two of its own five outcome codes
**Section:** Task 2 (`canEnter(state, cell)`)

`NO_ROAD` is meaningless per-cell: roads are directed bits, and the question is whether a road leaves the car's CURRENT cell toward the target — `isConnected(state, world, a, b)` needs both endpoints. A cell that carries roads in other directions would pass a `roads[cell] !== 0` test while being unreachable from where the car actually is. `OUT_OF_BOUNDS` needs `world.w/h` (or at least `world.cells`), which the signature does not have. Also unresolved: `advanceCar` already THROWS on `next < 0` (cars.ts:229-233), so if `canEnter` returns `OUT_OF_BOUNDS` the plan has two contradictory behaviours for the same condition and does not say which wins. The house pattern the plan invokes is right; the signature has to be `canEnter(state, world, from, to)` for the codes to be computable.

**Witness:** packages/sim/src/graph.ts:112-116 (isConnected takes both endpoints); packages/sim/src/cars.ts:222-233.

---

## [Important] I2 — A named mutation that is not constructible by design
**Section:** Task 2 Mutations ("classify it but do not hash it")

`createFieldInputRanges` is table-driven off `isFieldInputRegion` over the layout entries, and regions.ts says why in as many words: "the alternative — a hand-written sequence of `hashBytes(s.roads)`, `hashBytes(s.destPins)`, ... — lets a region be classified FIELD_INPUT and then silently not hashed, which is exactly the failure this table-driven form exists to make impossible." Classifying a region therefore hashes it, mechanically. To apply the mutation an implementer has to first rewrite `createFieldInputRanges` into the hand-written form the design forbids — at which point the mutation tests the rewrite, not the code. Either drop the mutation and cite the structure, or (per the catalogue's "when you cite a structural defence as a reason not to mutate something, pin the structure first") require a test that the ranges are derived from the classification.

**Witness:** packages/sim/src/regions.ts:155-163.

---

## [Important] I3 — The accumulate-while-blocked mutation throws rather than overshooting, so the vacuity rule targets a behaviour that cannot occur
**Section:** Task 2 Vacuity self-check ("the held-progress fixture must run enough ticks that an accumulating implementation would visibly overshoot")

If a blocked car keeps adding `speed`, then after N blocked ticks `progress = threshold + 330N`, and on release `residual = 330N`. `advanceCar` calls `assertSingleCrossing(residual, MIN_EDGE_THRESHOLD = 2500)`, which throws once `residual >= 2500`, i.e. at N = 8 (330*8 = 2640). So a fixture that runs "enough ticks" gets a thrown Error out of `step` — which also poisons `H_EPOCH` and makes the run unresumable — not a visible overshoot. Per the catalogue, that is a crash reading as a kill: the failures will be `cars: a car carried ... progress units past a crossing`, not an assertion naming held progress. It also means Decision 6's stated rationale ("otherwise it launches a cell forward the moment the way clears, which reads as teleporting and breaks the interpolation invariant") is false — the guard fires first. An overstated justification used to settle a design decision is the catalogue's own defect class.

**Witness:** packages/sim/src/cars.ts:79 (MIN_EDGE_THRESHOLD = 2500), :129-137, :219-220; 330 * 8 = 2640 >= 2500.

---

## [Important] I4 — Two incompatible readings of "held at the threshold", both outcome-visible, and the plan picks neither
**Section:** Decision 6 ("holds its progress at the threshold rather than accumulating")

Reading A: clamp `carProgress = threshold`. Reading B: skip the `+= speed` entirely, leaving `carProgress` at whatever it was. They differ observably. Under A the car sits at progress/threshold = 1.0 (rendered flush against the next cell's edge) and on release carries `residual = speed = 330`; under B it sits below 1.0 and on release carries the natural 140 (orthogonal) or 130 (diagonal). Since the residual crosses into the NEXT cell's budget, A and B produce different arrival ticks downstream of every block — so Task 3's "hand-computed arrival ticks" are not computable from the plan. There is a third question neither reading answers: is a car whose progress is still below threshold, sitting behind a stopped car, "blocked" for the valve's counter?

**Witness:** packages/sim/src/cars.ts:213-220; packages/shared/src/constants.ts:186-189 (carries are 140 and 130, remainders 190 and 200).

---

## [Important] I5 — The pin behaviour holds by construction with no code to mutate, so the bullet cannot distinguish anything
**Section:** Task 3 (carpark queues) and Task 3 Mutations ("consume the pin on block rather than on entry")

Arrival is cursor-driven, not position-driven: `runArrivals` fires on `phase === PHASE_OUTBOUND && cursor >= carRouteLen`, and `carRouteCursor` advances only inside `advanceCar` when the car actually crosses. A blocked car does not advance its cursor, so it does not arrive, so it does not consume a pin. There is nothing to write and nothing to mutate — to apply "consume the pin on block rather than on entry" an implementer must first ADD a pin-consumption path at the block site. A test written on this bullet passes against correct code and against every plausible implementation, which is the catalogue's "a negative assertion satisfied by a different mechanism" in its purest form: the observable is produced by the cursor, not by any carpark guard.

**Witness:** packages/sim/src/trips.ts:197-208; packages/sim/src/cars.ts:235-237.

---

## [Important] I6 — No later task introduces a Uint8Array decrement path, and Task 1 is scheduled before any of them anyway
**Section:** Task 1d ("M1d's queueing introduces new decrement paths") and its coverage bullet

Task 1 says "Do these first, before any blocking logic touches the same files." Task 1d then requires "a fresh decrement path at 0 throws rather than wrapping" — but the only `destPins`/`destReserved` decrements are in `arriveAtDestination`, both already guarded by `assertArrivalHonoured`, and no later task in this plan describes a new one: Task 3's carpark rule explicitly says the pin is NOT consumed on block, and nothing else touches either counter. So at the time Task 1 runs there is no fresh path to guard, and the coverage bullet has no subject. Either name the path (and say which task creates it), or restate 1d as a standing rule for Tasks 3 and 5 with a check at the end of the milestone.

**Witness:** packages/sim/src/trips.ts:83-96, :114-122 (the only two decrements, both guarded); Task 3's own carpark rule.

---

## [Important] I7 — The valve needs per-car state no task adds, has an unstated off-by-one convention, and cannot be disabled the way the vacuity check requires
**Section:** Task 3 ("the valve fires at exactly tick 1350 of blockage and not 1349") and its vacuity self-check

Three gaps. (a) A per-car blocked-tick counter is new state that must live in the buffer to survive snapshot/restore and be hashed — Task 3's file list is `blocking.ts`, `cars.ts`, `trips.ts`, with no `state.ts` and no `regions.ts`, so the region is unassigned (and adding it moves the goldens again, see C1). (b) "Fires at exactly tick 1350 and not 1349" does not fix the convention: increment-then-test-`>= 1350` fires on the 1350th blocked tick, test-then-increment fires on the 1351st, and both satisfy the sentence's plain reading. The reset rule is also unstated — is the counter consecutive-only, and is it cleared on a successful crossing, on becoming unblocked, or at trip end (where `completeTrip` zeroes the slot so an idle car's bytes are a function of nothing but "idle")? (c) "the gridlock ring must actually deadlock without the valve — assert that by disabling it in the test" is not possible against a module-scope constant. The project's own precedent for exactly this is a parameter (`advanceCar`'s `speed`, `assertSingleCrossing`'s `minThreshold`, `assertDispatchProgress`), and the plan does not ask for one. Also unassigned: `MAX_BLOCKED_TICKS` is a rule constant and the Global Constraints put those in `packages/shared/src/constants.ts`, which is in Task 4's file list and not Task 3's.

**Witness:** packages/sim/src/cars.ts:180-192 (the speed-as-parameter precedent); packages/sim/src/trips.ts:149-159 (completeTrip's byte-exact idle slot); Task 3 Files.

---

## [Important] I8 — Queue timing depends on car index versus position along the route, which the plan never pins — the hand-computed ticks are not derivable
**Section:** Decision 2 / Task 3 ("three cars behind a blocked leader form a queue and each advances in order when it clears, with hand-computed arrival ticks")

"Resolved in ascending car index within one tick" implies a single ascending sweep with immediate release. Then whether a queue advances as a unit in one tick or unzips at one cell per tick depends entirely on whether indices ascend or descend along the direction of travel: if the leader has the lower index it moves first and the follower walks into the vacated cell the same tick; if the follower has the lower index it sees the cell still occupied and waits. The plan never states whether occupancy is single-buffered (leader's release visible to later indices this tick) or double-buffered (cell stays claimed for the whole tick), and the two give different arrival ticks for the same fixture. A natural fixture assigns indices in dispatch order, which is one of the two cases, so it will confirm whichever behaviour the implementer wrote. The catalogue's "a fixture that met every stated condition and could not observe the bug" applies directly: the fixture must contain both index orderings or it proves nothing about the rule.

**Witness:** Decision 2; packages/sim/src/cars.ts:258-262 (runMovement's ascending loop); packages/sim/src/dispatch.ts:571 note that ascending is kept for M1d.

---

## [Important] I9 — Erase is per-segment and the refund is per-endpoint-that-becomes-empty; a per-cell flag cannot represent it, and "committed" is never defined
**Section:** Decision 5 / Task 5 ("a per-cell `pendingErase` flag")

`eraseRoad(state, world, a, b)` clears exactly two mirrored bits and refunds 0, 1 or 2 tiles depending on which endpoint masks become 0 (roads.ts:227-253). A cell can carry up to eight bits, so "this cell is a ghost" cannot say which segment was deleted, cannot say how much refund is pending, and cannot represent two pending erases at one cell. Second, "a car that has already committed to that segment" is never defined: does commitment mean occupying the cell now, or holding a route whose remaining steps cross it (dispatch commits the whole route at once)? The two readings give opposite answers to "which cars keep the ghost alive" and to whether a car five cells back gets stuck. Third, nothing handles re-placement: if the bits are cleared immediately with the refund pending, the player can re-place the same segment (paying again) and then receive the deferred refund — a free tile, and precisely the "never double-refunded" bullet, arriving by a path the plan does not consider. If instead the bits are NOT cleared, the flow field keeps routing new cars onto the ghost and it never clears.

**Witness:** packages/sim/src/roads.ts:227-253; packages/sim/src/dispatch.ts (route committed in full at dispatch).

---

## [Important] I10 — The deferred refund has no position in the tick order and step.ts is in no task's file list
**Section:** Task 5 Files (`roads.ts`, `blocking.ts`, `state.ts`, tests)

"The refund fires on the tick the last committed car leaves" is a per-tick sweep or a hook fired from movement, and it mutates `H_TILES`. `step.ts` runs seven phases in a documented, mutation-tested order, and nothing in Task 5 says where the ghost-clear runs relative to inputs (phase 2, the only phase that writes `roads`), the field sync (phase 4) or movement (phase 6). Placing it after the sync but before dispatch, for instance, would clear road bits after the field was built from them — the one ordering rule step.ts says "produces a throw rather than a wrong number". Task 2 has the same gap for occupancy maintenance. `step.ts` appears in Task 1's file list (for 1c) and in no other task's, so wiring either feature into the tick is unowned.

**Witness:** packages/sim/src/step.ts:48-98 (the seven phases and their constraints), :124-166.

---

## [Important] I11 — That harness is scoped to game and sim only; render is covered by a different file, and Task 6 points at the wrong one
**Section:** Global Constraints ("mechanically enforced by `packages/game/test/allocation.test.ts` ... scoped to `game`, `render` and `sim`")

`allocation.test.ts` declares `const PROFILED_SCOPES: readonly string[] = [GAME_SRC, SIM_SRC]` — no render. Render's frame allocation is measured by a separate harness, `packages/game/test/drawAllocation.test.ts`. The Global Constraint as written would let an implementer add the ghost draw pass, run `allocation.test.ts`, see green, and conclude Task 6's "nothing allocates per frame" bullet is satisfied — while the harness that actually watches `packages/render/src` was never run with a ghost cell in the frame. This is the same two-harnesses-and-a-gap shape the file's own comment documents as the reason `canPlaceRoad` went unnoticed for a whole milestone, restated in the Global Constraints as if it had been closed.

**Witness:** packages/game/test/allocation.test.ts:334-337; packages/game/test/drawAllocation.test.ts; allocation.test.ts:323-331 ("Task 7 then scoped this harness to `packages/game/src`, and Task 9's draw harness to `packages/render/src`").

---

## [Important] I12 — The idle-profile half is vacuous, and the fix changes an exported type whose consumers are outside Task 1's file list
**Section:** Task 1b Coverage ("`canPlaceRoad` is absent from an idle profile and from a dragging profile")

In an idle profile `canPlaceRoad` is never called, so its absence from the offender list is satisfied whether or not the allocation was fixed — a test that cannot fail, next to one that can. The existing harness makes exactly this point by asserting `counters.actions > 5000` before measuring ("no actions, so canPlaceRoad never ran"); the plan's bullet drops that guard. Separately, the ~40 B is the returned object literal (`{ ok: true, cost }` / `{ ok: false, reason }`), so fixing it changes the exported `PlaceResult`/`PlaceFailure` contract. Consumers outside `packages/sim` read it — `packages/game/src/pointer.ts` reasons about `not-adjacent`, and `roads.test.ts` asserts the object shape with `toEqual` in at least eight places. Task 1's file list is `sim` plus `allocation.test.ts`; the `game` side of the change is unassigned.

**Witness:** packages/game/test/allocation.test.ts:930 (the actions>5000 guard), :942-950; packages/sim/src/roads.ts:122-125, :150-186; packages/game/src/pointer.ts:111; packages/sim/test/roads.test.ts:145-291.

---

## [Important] I13 — No mechanism exists to pin them: the transpositions are inert precisely because no TickAction reads H_TICK, and the action kind union is closed
**Section:** Task 1c ("Pin the two 0-detector phase transpositions")

step.ts states the swaps are 0-detector "for one reason: no `TickAction` currently reads `H_TICK`", and that the change which ends it is M1e making building placement an action. `TickActionKind` is `'place' | 'erase'` and `step` throws on anything else, so a test cannot introduce a clock-reading action without widening the production type — which is M1e's job, not M1d's. That leaves only a structural/source assertion, which the catalogue warns "reads as verified and is not", or widening the type speculatively, which the plan does not authorise. Task 1c also asserts "If any task in this milestone adds one, both become real off-by-ones" — no task in this plan adds one, so the stated urgency is not this milestone's, and the coverage bullet "the phase transpositions each fail a named test" has no constructible test behind it as scoped.

**Witness:** packages/sim/src/step.ts:100-115, :20-25 (closed TickActionKind), :149-151 (throw on unknown kind).

---

## [Important] I14 — There are no lanes in the model, and the guard thresholds are not defined against anything the sim exposes
**Section:** Task 7 ("build a two-lane bottleneck")

Roads are an undirected 8-bit mask per cell and Decision 1 ships one car per cell — there is no lane concept to make a bottleneck "two-lane". An implementer will build two parallel corridors, which is a different thing (and, given C4, both corridors deadlock head-on at their carparks regardless of width). The degeneracy guards are also unmeasurable as stated: "at least one car blocked for >= 10 consecutive ticks" and "at least one queue of >= 3" both need instrumentation the plan does not specify (blocked-tick counters exposed to tests, and a definition of "queue"), and "total trips strictly below the M1c baseline on the same fixture" has no M1c baseline for a fixture M1d invents. Note also that under C2 the loop fixture — the only real M1c baseline — no longer completes trips at all.

**Witness:** packages/sim/src/roads.ts:91-95 (undirected mask); Decision 1; Task 7's four guard clauses.

---

## [Important] I15 — Half of the catalogue's own lesson is carried across and half is dropped
**Section:** Task 6 Coverage ("the ghost layer respects the revealed rect **in both directions**")

The catalogue entry this bullet is written from has two halves. The first — write over- and under-approximation tests as a pair — is carried. The second is not: "Closing the under-iteration half left **seven more 0-detector mutants** in the over-iteration half, because both out-of-rect markers sat in **diagonal corners**. A corner is past *two* bounds at once ... **A marker must sit past exactly one bound, exactly one cell past it** — assert that of the fixture." The bullet says only "content at the far edge is drawn, content outside is not", which a corner marker satisfies while disabling the test. The third half is also missing: the same entry records two survivors from a parity accident ("the fixture's grid top and width were both even, so two of four device-pixel snaps had no detector"). Task 6's mutation "shrink the far bound" is exactly the mutant those two omissions let through last time.

**Witness:** docs/superpowers/testing-defect-catalogue.md:50-52.

---

## [Important] I1 — "The four bounds are each independently detected from both callers" is unsatisfiable: `y < 0` is a proven equivalent mutant
**Section:** Task 1a — coverage required

Task 1a's coverage requires that after consolidation "the four bounds are each independently detected from *both* callers". The carry-forward this plan is written against states the opposite for one of them, with evidence: "`y < 0` in `stepCell` is a genuine equivalent mutant, verified exhaustively over ~1600 geometries and Int32 extremes: 56 raw differences, 0 observable. The retained `x` guards force `y*w + x <= -1` for any `y <= -1`. It survives mutation and that is correct." An implementer holding both documents will either burn the task hunting a detector that provably cannot exist, or manufacture one by asserting on an intermediate the production code does not expose. The bullet should require three detectors plus the recorded, cited equivalence for the fourth — the catalogue's own prescribed response to a survivor that is unobservable because another guard is sufficient.

**Witness:** docs/superpowers/m1d-carry-forward.md, "Known residuals", first bullet, versus plan line 104.

---

## [Important] I2 — "The phase transpositions each fail a named test" has no behavioural detector by construction, and the plan supplies no mechanism
**Section:** Task 1c — "Pin the two 0-detector phase transpositions"

Both swaps are 0-detector for a stated structural reason: no `TickAction` reads `H_TICK`, and `roads.ts` reads neither the clock nor the week. Nothing in M1d adds a clock-reading action (the delayed refund is triggered by a car's departure, not a tick stamp), so the condition that makes them observable does not arrive in this milestone. The task nevertheless requires a named failing test for each, with no hint of how. There *are* constructible detectors, and the plan should name one, because the obvious alternative an implementer will reach for — a source-order scan of `step.ts` — is decoration by the catalogue's own standard. Constructive: both swaps are observable through the atomicity path. For 1↔2, drive `step` with `actions = [valid place, {kind:'bogus'}]`; today the throw leaves `H_EPOCH` non-zero and `H_TICK` advanced, so the buffer is correctly poisoned, while under the swap the road is applied, the throw happens before `H_EPOCH` is written, and the buffer is left resumable with a mutation in it. For 2↔3, assert `pinAccum`/`destPins` are unchanged in the poisoned buffer after the same throwing tick; under the swap demand has already run.

**Witness:** packages/sim/src/step.ts:100-115 states the reason both are inert; packages/sim/src/step.ts:131-141 (epoch write before the action loop) is what the suggested detector exercises.

---

## [Important] I3 — The stated signature cannot produce its own stated outcome set
**Section:** Task 2 — `canEnter(state, cell)`

`canEnter(state, cell)` is given five outcomes including `OUT_OF_BOUNDS`, `NO_ROAD` and `GHOST`. It has no `world`, so it cannot decompose a cell to x/y or know `w`/`h` (the row-seam distinction this codebase treats as load-bearing everywhere else); it has no direction, so `NO_ROAD` can only mean "mask is 0", not "no road *toward* this cell", which is the check `isConnected` exists to make; and it has no entering-car index, so it cannot answer either of the two questions GHOST actually needs — is this car already committed to the ghost, and is the recorded occupant this same car. The house pattern the task correctly invokes (outcome code, not boolean) is undermined if the signature cannot compute the codes.

**Witness:** packages/sim/src/graph.ts:112-116 `isConnected(state, world, a, b)` — the existing, direction-aware form of the same question, which takes both `world` and both endpoints.

---

## [Important] I4 — `NO_ROAD` blocking a committed car silently reverses M1c's tested erased-road behaviour; neither it nor `OUT_OF_BOUNDS` has a coverage bullet
**Section:** Task 2 — outcome codes with no coverage and no caller behaviour

Task 2 names five outcomes and then covers only `FREE` and `OCCUPIED`. Nothing says what `advanceCar` does with `NO_ROAD` or `OUT_OF_BOUNDS`, and the choice is behaviour-changing: M1c's documented and tested rule is that a road erased under an in-flight car does not touch it — "the car drives the erased segment to the end of its committed route" — which is one of the seven byte-identical determinism comparisons the carry-forward lists as demonstrated. If `NO_ROAD` blocks, that rule silently inverts and the car freezes for 1,350 ticks; if it does not block, `NO_ROAD` is unreachable from production and its mutation is a no-op. `OUT_OF_BOUNDS` has the same problem against `advanceCar`'s existing named throw for a route that leaves the board — turning that throw into a silent block would remove a tripwire the module comment calls load-bearing.

**Witness:** packages/sim/src/cars.ts:29-33 ("A road erased under an in-flight car therefore does not touch it ... the car drives the erased segment to the end of its committed route") and :222-233 (the off-grid throw). Task 2's coverage list contains no bullet naming either code.

---

## [Important] I5 — The carry after an unblocked crossing is unspecified — the exact systematic-slowdown class M1c's decision 3 exists to prevent
**Section:** Design decision 6 / Task 2 coverage

"Holds its progress at the threshold" fixes the value while blocked but says nothing about the residual after the release crossing. Two readings differ observably: clamp-before-add (progress stays at `threshold`, so the crossing yields residual 0) loses up to one tick of progress on every block, which over a jammed run is a per-block uniform slowdown of exactly the kind `cars.ts` spends 15 lines warning about ("`progress -= threshold`, NEVER `progress = 0` ... the classic 'diverges only after thousands of ticks' failure"); add-then-clamp-after-crossing preserves the carry. Task 2's coverage bullet stops at "advances exactly one cell on the tick the way clears — not two", which both readings satisfy. Whichever is chosen also changes every golden and every hand-computed arrival tick in Task 3's queue test, so it must be decided before, not during.

**Witness:** packages/sim/src/cars.ts:40-49 (the carry rationale) versus plan lines 86 and 118, neither of which names `carProgress`'s value on the release tick.

---

## [Important] I6 — "Classify it but do not hash it" is not a constructible mutation; the codebase was restructured specifically to make it impossible
**Section:** Task 2 — Mutations

`createFieldInputRanges` walks the layout table and emits a range for every region `isFieldInputRegion` accepts, and `hashFieldInputRegions` walks those ranges. Classification *is* what gets hashed. To apply the named mutation an implementer must first rewrite `hashFieldInputRegions` into the hand-written form that structure was introduced to replace — at which point the mutation tests the rewrite, not the code. A mutation that cannot be applied to the shipped code is not a survivor and not a kill; per the catalogue it must be recorded as unconstructible with the reason, or the table inflates.

**Witness:** packages/sim/src/regions.ts:156-162: "the alternative — a hand-written sequence of `hashBytes(s.roads)`, `hashBytes(s.destPins)`, ... — lets a region be classified FIELD_INPUT and then silently not hashed, which is exactly the failure this table-driven form exists to make impossible."

---

## [Important] I7 — The allocation constraint misnames its own enforcement, and Task 6's per-frame assertion needs a driver that has never seen a ghost
**Section:** Global Constraints / Task 6

The Global Constraint says the rule is enforced by `packages/game/test/allocation.test.ts` "scoped to `game`, `render` **and `sim`**". That file's own pinned scope list is two entries: `expect([...PROFILED_SCOPES].sort()).toEqual(['packages/game/src/', 'packages/sim/src/'])`. `render` is covered by a *different* file, `drawAllocation.test.ts`, with its own `RENDER_SRC` scope and its own `CANVAS_BUDGET_BYTES_PER_FRAME`. A Task 6 implementer following the Global Constraint will look in the wrong file, find render absent, and either add a duplicate scope or conclude the ghost pass is covered when it has not been measured. Separately, Task 6's "nothing allocates per frame" bullet does not require the profiling driver to contain any ghost cells — the catalogue's own most recent lesson ("a driver that never enters a branch makes that branch indistinguishable from dead code, and the counters will not say so"; "one counter per branch the driver claims to enter, and an assertion on each").

**Witness:** packages/game/test/allocation.test.ts:751 and :334-336 (`SIM_SRC`, `PROFILED_SCOPES`); packages/game/test/drawAllocation.test.ts:97 `const RENDER_SRC = 'packages/render/src/'`.

---

## [Important] I8 — A thinner, lower-opacity ghost is not drawable through the existing `DrawContext` or the baked atlas, and `atlas.ts` is in no task's file list
**Section:** Task 6 — Files and coverage

Roads are drawn as one `drawImage` per cell from a 256-tile atlas baked at a fixed `lineWidth = ROAD_STROKE_FRACTION * tileDevicePx`. Stroke width is therefore not a draw-time property at all: the only ways to get a thinner ghost are a second atlas baked at a narrower width (that is `atlas.ts`, plus `Atlas.strokeWidthPx`, plus the palette assertion `assertAtlasPalette`, plus memory — 256 more tiles) or scaling the destination rect, which shrinks the whole tile and breaks alignment at every cell seam. Opacity is equally unavailable: `DrawContext` declares exactly `fillStyle`, `font`, `textAlign`, `textBaseline`, `fillRect`, `fillText`, `drawImage` — no `globalAlpha`, no `save`/`restore`, and the interface's minimality is described as deliberate. Task 6's files are `canvas.ts`, `types.ts`, `frame.ts`; `atlas.ts` appears in no task. The coverage bullet asks for both properties to be "asserted against recorded state, both properties independently", which cannot be satisfied by a recorder that never sees a width or an alpha.

**Witness:** packages/render/src/canvas.ts:117-144 (`DrawContext`, seven members) and :503-510 (one `drawImage` per road cell); packages/render/src/atlas.ts:325-327 (`ctx.lineWidth = strokeWidthPx` set once, before the mask loop, at bake time).

---

## [Important] I9 — The deploy check does not say it fetches the URL the bot actually opens, which is the exact M2 failure it cites
**Section:** Task 7 — Deploy

The plan correctly records that the Mini App URL is not settable through the Bot API — but then leaves the consequence hanging: "if the URL changes, that is a human action" names no owner, no step, and no check. The M2 failure was not that someone set the wrong URL; it was that the milestone verified a deploy against the deployment target while the bot pointed somewhere else, and the user found it afterwards. The fix that closes it is one sentence the plan does not contain: state whether M1d's deploy changes the served URL (it should not — same Worker), and require the build-token grep to be run against **the URL configured in @BotFather**, not against the deploy output URL, with the two asserted equal. As written, a green Task 7 proves the bundle is live at some address.

**Witness:** Catalogue: "nothing repointed the bot" listed among the three M2 gaps that "existed because *no task was assigned the work*"; and "Verify the artifact, not the command's exit message" — which the plan applies to the bundle but not to the address.

---

## [Important] I10 — The refund must fire from `cars.ts` (phase 6), which Task 5 does not list, and creates a fourth undocumented module cycle
**Section:** Task 5 — Files

"The refund fires on the tick the last committed car leaves" — departures happen inside `advanceCar`, in `cars.ts`, phase 6. Task 5's files are `roads.ts`, `blocking.ts`, `state.ts`. Two consequences no task owns: (1) `H_TILES` becomes mutable from phase 6, which the tick-order comment currently describes as "the only phase that changes `roads`" being phase 2, and `cars.ts`'s module comment states as a signature-level invariant that it "never reads `state.roads`"; (2) `roads.ts` will need to consult occupancy from `blocking.ts` while `blocking.ts` needs `stepCell`/`dirBetween` from `roads.ts`, creating a fourth cross-module cycle. The three existing cycles (state↔world, state↔regions, roads↔buildings) each carry an explicit, tested "no module-evaluation-time reference" invariant; nothing in the plan requires the fourth to get one.

**Witness:** packages/sim/src/cars.ts:29-33 and :68-70; packages/sim/src/roads.ts:79-88 (the roads↔buildings cycle invariant, the template a fourth cycle would need).

---

## [Important] I11 — Parking bays (§5.5) are silently reduced to one cell — in neither a task nor the deferred table
**Section:** Scope / Task 3 — carpark queues

Task 3 asserts "a destination's carpark is one cell, so arriving cars queue behind it on the road" as a given. The spec says otherwise: "Parking bays [OURS]: reserved atomically at dispatch, round-robin over free bays. 3 bays single, up to 8 double." The deferral table lists lights/roundabouts/motorways, bridges/tunnels, overcrowd, weekly ramp and persistence — parking bays are absent from it and from every task. This is a real capacity decision (a destination serves one car at a time instead of three), it directly determines how quickly a queue forms and therefore how M1e's overcrowd threshold will be tuned, and the plan's own stated rule is that out-of-scope items are "named so the gap is not read as an oversight". Note the plan is otherwise correct that lights, roundabouts, motorways, bridges and tunnels are all §5.10 upgrade cards and that no card mechanism exists — that deferral checks out.

**Witness:** Spec §5.5, line 209: "Parking bays [OURS]: reserved atomically at dispatch, round-robin over free bays. 3 bays single, up to 8 double." versus the plan's Out table (lines 36-42).

---

## [Important] I12 — `game`'s hand-computed tick literals are not acknowledged as changing either
**Section:** Task 7 / no task

The plan treats golden movement as a `sim` concern. `packages/game/test/integration.test.ts` pins `SCORE_TICK = 435`, `DISPATCH_TICK`, a per-frame car position derived by hand at ticks 382/383 (`carProgress = 5 x 330 = 1650, f = 1650/3500`), and `LIVE_CARS = 6` on the starting city — the same six cars that share column 8 in both directions (C4). Any blocking event before tick 435 moves all of them, and the one assertion the file calls "the only assertion that a uniform one-tick offset cannot satisfy" is exactly the kind that fails opaquely. Task 7 lists the file but only to add a jam test; nothing tells its implementer these literals are expected to move or that they must be re-derived rather than re-fitted.

**Witness:** packages/game/test/integration.test.ts:356-357 (`SCORE_TICK = 435`), :368-369 (the hand-derived f), :384-386.

---

## [Important] I13 — No task writes the M1e carry-forward or updates the defect catalogue
**Section:** Whole plan — no task owns the handoff out

M1d exists in the form it does because `m1d-carry-forward.md` was written and because the defect catalogue was maintained ("Roughly a third was written during M2"). No task in this plan writes an `m1e-carry-forward.md`, and no task appends M1d's new defect shapes to `testing-defect-catalogue.md`. The plan's closing section lists three unsettled items — whether one car per cell feels right, whether 1,350 ticks is the right valve, frame cost under a jam — each phrased as something M1e's tuning will discover, with no file for M1e to discover it in. The deferral table hands four features to M1e with reasons but no document. This is the catalogue's own named failure shape applied to the plan's own outputs.

**Witness:** docs/superpowers/m1d-carry-forward.md line 3: "The SDD workspace ledgers are git-ignored scratch; this is the part that must survive them." Nothing in this plan produces the equivalent artifact.

---

## [Important] I14 — Whether `edgeCost` learns about lane speed is undecided, and both branches break something the plan asserts
**Section:** Task 4 — Files include `graph.ts`, with no statement of what changes there

Task 4 lists `graph.ts` among its files and says nothing about it. The two possibilities are both broken as written. If `edgeCost` gains a lane-speed term so the field sees it: `edgeCost(dir)` takes only a direction, but a right-angle/sharp-turn multiplier is a function of the *incoming and outgoing* directions and an intersection multiplier is a function of the target cell's road mask — neither is expressible without changing the signature and turning the flow field into a search over (cell, direction) states; and it moves the field golden `252514232`, which Task 4 does not declare and which the M1c plan installed as "a tripwire, not a re-bless"; and it double-counts, because `advanceCar` already derives its threshold from `edgeCost(dir) * COST_UNIT_SCALE` while progress per tick would also be multiplied. If `edgeCost` does not change: routing and movement diverge, which `cars.ts` documents as a deliberate design refusal, and `graph.ts` has no business being in the file list.

**Witness:** packages/sim/src/cars.ts:86-90: "`edgeCost` is pure length with no lane-speed term, and if movement applied turn or intersection multipliers the flow field could not see them, so the routing model and the movement model would diverge by design." packages/sim/src/graph.ts:94 `edgeCost(dir: number)`. loop.test.ts:783-785 pins the field golden as a tripwire.

---

## [Important] I15 — Detecting an intersection requires `state.roads`, which `cars.ts` documents as a load-bearing thing it never reads; and "intersection" is never defined
**Section:** Task 4 — "approaching intersection 0.5"

The intersection multiplier is a property of a cell's connectivity, so movement must read `state.roads` (or a derived degree). `cars.ts`'s module comment makes "this module also never reads `state.roads`" the stated reason a road erased under an in-flight car cannot affect it — a claim two determinism tests rest on. Task 4 must retire or rewrite that invariant and nobody is told to. Separately, the plan never defines "intersection" (degree >= 3? a junction as §5.6 uses the word? does a carpark cell count? does the cell being *entered* or the cell being *left* decide?), nor which cell's multiplier applies when a car is mid-edge between a plain cell and a junction — and the coverage bullet "apply the intersection multiplier to a non-intersection" as a mutation presupposes a definition that does not exist.

**Witness:** packages/sim/src/cars.ts:29-33; spec §5.6 line 219: "Lights place only on an existing road **junction**, never plain road" — the spec's own word for the concept, used nowhere in the plan.

---

## [Important] I1 — A "thinner stroke" is impossible from the baked atlas, the ghost needs a per-cell mask rather than a flag, and `atlas.ts` is in no file list
**Section:** Task 5 / Task 6 — ghost rendering

Road stroke width and colour are rasterised into the 256-tile atlas at build time and drawing is a pure `drawImage` blit — `assertAtlasPalette` exists precisely because "a blit cannot re-tint". A thinner ghost stroke therefore needs a SECOND atlas baked at a smaller `ROAD_STROKE_FRACTION` (256 more tiles, a second surface, and iOS canvas-memory exposure the atlas builder already calls out), or a scaled destination rect, which shrinks the whole tile and breaks grid alignment. `atlas.ts` appears in no task's file list. Reduced opacity needs `globalAlpha`, which `DrawContext` deliberately does not expose. And indexing any atlas requires a per-cell ghost MASK, not the per-cell `pendingErase` flag Decision 5 specifies — Task 5's "one region" is undersized for what Task 6 must draw, and it must additionally remember the refund amount (`eraseRoad` refunds per endpoint whose mask becomes 0).

**Witness:** packages/render/src/atlas.ts:325-329 (stroke baked once) and :296-302; packages/render/src/canvas.ts:118-142 (`DrawContext`, no `globalAlpha`, no `save`/`restore`), :492-510 (`drawRoads` is one blit per cell indexed by `frame.roads[...]`); packages/sim/src/roads.ts:244-250 (refund arithmetic).

---

## [Important] I2 — Under the natural reading (average the multipliers, then convert) the rounding rule is a provable no-op for every reachable combination, so the required test cannot exist
**Section:** Task 4 — "Averaging integers over DENOM needs a stated rounding rule and a test at a value where the two disagree"

The three multipliers are 667, 500, 333. Every non-empty subset averages to 667, 500, 333, 583.5, 500, 416.5 or 500. The only fractional cases are 583.5 and 416.5, and `speedUnits` truncates `330*mul/1000`: 583→192 and 584→192; 416→137 and 417→137. So "change the rounding direction" is a 0-detector on every value the game can produce, and Task 4's coverage bullet "the rounding rule is exercised at a value where rounding up and down differ" is unconstructible — an implementer will satisfy it by calling a helper with a hand-picked input the production path can never present, which is the catalogue's "a test that pins a property nothing depends on". If instead the intent is to average the *converted speeds* (220, 165, 109), rounding does matter (avg(220,165) = 192.5). The plan does not say which order, and the two produce different bytes and therefore different hashes.

**Witness:** packages/shared/src/constants.ts:33-36 (667/500/333) and packages/sim/src/cars.ts:99-101 (`Math.max(1, ((330 * mul) / 1000) | 0)`); arithmetic above.

---

## [Important] I3 — Two test-only "disable it" switches are required and no task provides a mechanism, against a pinned arity and a ban on module-scope state
**Section:** Task 3 vacuity check / Task 7 baseline

Task 3 requires "the gridlock ring must actually deadlock without the valve — assert that by disabling it in the test". Task 7 requires throughput "measurably below the unblocked case", which needs blocking disabled to produce the unblocked figure. Both need a switch. `step.length === 5`, `runMovement.length === 2` and `runArrivals.length === 1` are all pinned by tests, module-scope mutable state is banned by a lint rule, and `Scratch` is not part of the hashed state. There is no assigned home for either switch, and the obvious implementations (a sixth `step` parameter, a third `runMovement` parameter, a module flag) each break something the plan lists as a constraint.

**Witness:** packages/sim/test/step.test.ts:99; packages/sim/test/cars.test.ts:643; packages/sim/test/trips.test.ts:149; Global Constraints ("no module-scope mutable state").

---

## [Important] I4 — `regions.ts` is where regions and the FIELD_INPUT/FIELD_IRRELEVANT partition actually live, and neither task lists it
**Section:** Task 2 and Task 5 file lists

Both tasks say "`state.ts` (one region)". `state.ts` holds only `REGION_FIELD_NAMES` and the view wiring; `regionsFor`, `FIELD_INPUT_REGIONS`, `FIELD_IRRELEVANT_REGIONS` and the union assertion the plan's own coverage bullet targets ("the region is in the field-input partition and hashed") are all in `packages/sim/src/regions.ts`, with `regions.test.ts` asserting the union and the zero-padding property that constrains where in the declaration order a new region may go (descending alignment tiers). A task that edits only `state.ts` throws at view construction.

**Witness:** packages/sim/src/regions.ts:28-63 (`regionsFor`), :81, :105-123, :20-27 (declaration-order/padding rule); packages/sim/src/state.ts:174-197, :209-214 (throws for a missing view).

---

## [Important] I5 — A −1-filled Int32 region breaks the documented "a fresh state is all-zero" invariant, needs an unassigned `createState` write, and is 4× larger than necessary against M3's snapshot budget
**Section:** Task 2 — the occupancy region's type and initial value

`createState` documents that a fresh state is all-zero except `rng`, `mapIdentity` and `H_TILES`, and that this is what makes "a building-free state is byte-identical to a from-scratch state" true — the property every unchanged-goldens assertion rests on. An occupancy region whose empty value is −1 must be filled at creation (an unassigned change), and if it is left at zero instead, every fresh state claims car 0 occupies cell 0 — where every `PHASE_NONE` slot also sits. Sizing: max car index is `2 * maxHouses` (80 on `firstCity`), so `Int8Array`/`Int16Array` suffice; `Int32Array` adds 3,840 B to a 7,908 B buffer (≈ +49%), against the 4,096-character CloudStorage budget `trips.ts` says the byte layout is chosen for.

**Witness:** packages/sim/src/state.ts:306-315 (the all-zero invariant), :316-327; packages/sim/src/trips.ts:124-133 (the compression/CloudStorage argument); packages/sim/src/regions.ts:33 (`maxCars = CARS_PER_HOUSE * maxHouses`).

---

## [Important] I6 — No task points the allocation harness at a jam, a valve firing, or a ghost — the branches this milestone adds are the ones its driver never enters
**Section:** Global Constraints (allocation) vs Tasks 2, 3, 5, 7

The harness is live for `packages/sim/src`, but it drives a 3,000-frame place-drag over the seeded starting city. Nothing in that rig produces a blocked car, a valve firing, a ghost cell or a queue, so every new branch will measure clean while being unreachable from the driver — the catalogue's own two-part lesson ("a green harness is a claim about the inputs it was given" and "a driver that never enters a branch makes that branch indistinguishable from dead code, and the counters will not say so", whose prescribed fix is one counter per branch plus an assertion on each). Only Task 6 mentions allocation, and only for the per-frame ghost pass. Assign the tick-side profile, with entry counters, to a named task.

**Witness:** packages/game/test/allocation.test.ts:334 (`SIM_SRC`), :425-429 (rig = `seedStartingCity` + drag), :880-895; catalogue entries on harness scope and unentered branches.

---

## [Important] I7 — No behavioural observer for these swaps can exist today, and the plan does not say what the pin is instead
**Section:** Task 1c — "Pin the two 0-detector phase transpositions" / "the phase transpositions each fail a named test"

The carry-forward's own analysis is that `1↔2` and `2↔3` are inert *for exactly one reason*: no `TickAction` reads `H_TICK`, and phase 2 calls only `roads.ts`, which reads neither the clock nor the week. So a test that fails under the swap must either scan `step.ts`'s source (a test that reimplements the thing it checks — a catalogue shape) or introduce an action that reads the clock, which no task in this milestone does. Task 1c demands "each fail a named test" without saying which of those it means. Worth noting the natural fix is inside this milestone's reach: if the delayed refund stamped the erase tick, phase 2 would read `H_TICK` and both swaps would become genuinely observable — but Task 5 does not specify that and Task 1c runs before it.

**Witness:** packages/sim/src/step.ts:100-115; docs/superpowers/m1d-carry-forward.md §2; packages/sim/src/roads.ts (no `H_TICK` read).

---

## [Important] I8 — M1d as designed introduces no new `destPins`/`destReserved` decrement, so the required coverage names a thing that may not exist
**Section:** Task 1d — "a fresh decrement path at 0 throws rather than wrapping"

Task 3's own rule is that a blocked car does NOT consume its pin, and arrival is cursor-driven: `runArrivals` fires exactly when `cursor >= routeLen`, which happens only when movement actually placed the car on the carpark. So the existing pair of decrements in `arriveAtDestination` remains the only one, both already guarded. A coverage bullet demanding "a fresh decrement path" invites an implementer to invent one to satisfy it. State instead that the obligation is conditional — if M1d adds no new decrement, record that as the answer.

**Witness:** packages/sim/src/trips.ts:114-122 and :197-208; packages/sim/src/dispatch.ts:550; plan Task 3 ("A car that cannot enter the carpark must not consume its pin").

---

## [Important] I9 — The spec gives a destination three parking bays; the plan silently ships one cell, and the deviation it does record (density) is the smaller one
**Section:** Task 3 — carpark queues

Spec §5.5: "Parking bays [OURS]: reserved atomically at dispatch, round-robin over free bays. 3 bays single, up to 8 double." The plan says "a destination's carpark is one cell, so arriving cars queue behind it on the road" and does not name this as a deviation, while Decision 1 makes a point of naming the density halving. It is directly load-bearing for this task: three bays are what keeps an arriving car off the approach road, and with one bay every second arrival stalls on the corridor — which on a dead-end driveway meets the returning car head-on (C1). Record it in the same form as Decision 1, or the carpark queue is being tuned against a geometry the spec does not have.

**Witness:** spec §5.5 ("3 bays single, up to 8 double"); packages/sim/src/buildings.ts:180-197 (`carparkCell` returns one cell); plan Task 3 paragraph 3.

---

## [Important] I10 — Whether movement blocks on `NO_ROAD` is undecided, and either answer breaks something stated elsewhere
**Section:** Task 2 — the `NO_ROAD` outcome code

`canEnter` is specified to return `NO_ROAD`, but nothing says whether `advanceCar` honours it. If it does, a road erased under an in-flight car strands that car (its committed route is the only route it has) until the valve — a 45-second stall added to every erase-under-traffic, contradicting both the M1c behaviour and Decision 5's premise that a committed car may traverse a ghost. If it does not, `NO_ROAD` is test-only scaffolding in a return type the plan presents as "the direct mechanical answer to this project's most-repeated defect family". Either way, the read moves the roads lookup into the movement path — see C9(2) for why the existing source-scan guard will not notice.

**Witness:** plan Task 2 (outcome codes) vs Decision 5; packages/sim/src/cars.ts:29-33; packages/sim/test/cars.test.ts:586-628.

---

## [Important] I11 — Starvation has no definition and no telemetry; the valve makes 45-second stalls routine and nothing counts them
**Section:** Task 3 / Task 7 — "none starves", "no car starves"

With the valve, "stuck forever" is impossible by construction, so "no car starves" is trivially true and the assertion cannot fail — it is a negative assertion satisfied by a different mechanism, the catalogue's most-repeated family. The quantity that matters is how often the valve fires and for how long a car was held, and neither is recorded: there is no counter (the natural one, an `H_VALVE_FIRES` header slot, is in no task), and Task 7's own guard "at least one car blocked for ≥ 10 consecutive ticks" needs the per-car blocked counter of C5. Note also the valve bounds a car at 1,350 ticks *per cell*, not per journey: a car six cells from home in a persistent jam takes 8,100 ticks to get there, which is inside Task 7's 20,000-tick run and would read as "eventually moved".

**Witness:** plan Decision 3, Task 3 coverage bullet 5, Task 7 long-run bullet; packages/sim/src/state.ts:106-115 (header slots — no valve counter).

---

## [Important] I12 — One of the four bounds is a verified equivalent mutant through either caller, so the stated coverage is unachievable as written
**Section:** Task 1a — "the four bounds are each independently detected from both callers"

The carry-forward records `y < 0` in `stepCell` as "a genuine equivalent mutant, verified exhaustively over ~1600 geometries and Int32 extremes: 56 raw differences, 0 observable", because the retained `x` guards force `y*w + x <= -1` for any `y <= -1` and both callers treat any negative result identically (`cars.ts` throws, `dispatchColour` breaks). Only a DIRECT call comparing against exactly −1 observes it. Demanding it be "independently detected from both callers" sends an implementer after a test that cannot exist, and the catalogue is explicit that this case wants a comment explaining why, not a fixture. The other three (`x < 0`, `x >= w`, `y >= h`) are observable — `y >= h` produces a positive out-of-range cell that `next < 0` does not catch.

**Witness:** docs/superpowers/m1d-carry-forward.md, "Known residuals" bullet 1; packages/sim/src/dispatch.ts:315-322; packages/sim/src/cars.ts:222-233.

---

## [Important] I1 — That coverage bullet is unsatisfiable at the three multipliers the plan specifies — every averaging rounding direction produces the same speed
**Section:** Task 4 — "the rounding rule is exercised at a value where rounding up and down differ"

speedUnits(m) = max(1, floor(330*m/1000)). The three pairwise averages of {667, 500, 333} are: (667+500)/2 = 583.5 -> floor 583 gives 192, ceil 584 gives 192; (500+333)/2 = 416.5 -> floor 416 gives 137, ceil 417 gives 137; (667+333)/2 = 500 exactly, no rounding; and all three together average to exactly 500. So the averaging rounding rule is a PROVABLE NO-OP at every value reachable from the plan's own multiplier set, and the named mutation 'change the rounding direction' cannot be killed. This directly falsifies Task 4's stated purpose ('until now the rounding rule has been dead code') — it stays dead. The only place truncation is observable at all is a lone sharp turn: speedUnits(333) = 109 truncated vs 110 rounded, and even there the first four cell crossings agree (ceil(2500k/109) = ceil(2500k/110) for k = 1,2,3; they first differ at k = 4, 92 vs 91 ticks). The plan needs either a stated worked fixture that reaches that operating point, or an honest statement that the averaging rounding has no constructible mutation at these constants.

**Witness:** node: floor(330*583/1000)=192, floor(330*584/1000)=192; floor(330*416/1000)=137, floor(330*417/1000)=137; floor(330*500/1000)=165 exactly.

---

## [Important] I2 — Queue drain rate depends entirely on whether car indices ascend or descend along the direction of travel, and the natural fixture picks the case that observes nothing
**Section:** Design decision 2 and Task 3 — "three cars behind a blocked leader form a queue… with hand-computed arrival ticks"

Resolving contention in ascending car index within one tick makes a queue's throughput a function of index arrangement, not geometry. If the leading car has the LOWEST index, it releases its cell before the follower is processed, the follower releases before the next, and a three-car queue drains completely in one tick. If the leading car has the HIGHEST index, only the leader moves and the release wave propagates backwards at exactly one cell per tick. Same road, same cars, 3x difference in drain time. This is deterministic (so replay is safe) but it is arbitrary and un-physical, and the plan's decision 2 does not acknowledge it — it argues only about two cars contending for one cell, which is a different and much narrower case. Concretely for Task 3: a fixture built the natural way (dispatch commits cars in ascending index, and cars ahead were dispatched earlier, hence lower index) lands in the instant-drain case, where 'each advances in order when it clears' is trivially true and the mutation 'release the queue in descending order' has nothing to bite on. The plan needs both arrangements in the fixture set, and a stated position on whether the instant-drain behaviour is intended.

**Witness:** Cars at cells c1<c2<c3 travelling toward increasing cell. Indices (1,3,5) ascending along travel: all three advance on one tick. Indices (5,3,1): only the leader advances, then one per tick.

---

## [Important] I3 — Already guaranteed by existing code; the named mutation is not constructible without first inventing the bug
**Section:** Task 3 — "A car that cannot enter the carpark must not consume its pin"

runArrivals (trips.ts:202) fires arriveAtDestination only when carPhase === PHASE_OUTBOUND && cursor >= carRouteLen, and the carpark cell IS the route's last cell (dispatch seeds sources from carparkCell, dispatch.ts:171). A car blocked from entering the carpark has cursor < routeLen, so arrivals does not touch it and no pin is consumed — automatically, by the existing cursor test, with no new code. The plan's mutation 'consume the pin on block rather than on entry' therefore has no production site to apply to. This is the catalogue's most-repeated family in a new dress: a negative assertion ('does not consume its pin') satisfied by a mechanism other than the one under test. Either state that this is a checked no-op inherited from M1c and say what the coverage bullet is really guarding, or name the code that would have to exist for it to be falsifiable.

**Witness:** trips.ts:202 — the cursor >= routeLen test is the arrival condition; blocking necessarily leaves cursor short of routeLen.

---

## [Important] I4 — A car held at the threshold renders exactly on top of the car blocking it
**Section:** Task 6 — "Queued cars need no new rendering — they are cars at positions"

resolve.ts:185 computes f = carProgress / (edgeCost(dir) * COST_UNIT_SCALE) and draws the car at cell + dir * f in cell-centre units. Decision 6 holds a blocked car's progress AT the threshold, i.e. f = 1.0, which places it at the centre of the NEXT cell — the cell whose occupant is the reason it is blocked. So every queued car is drawn superimposed on its leader, and a three-car queue renders as one car. The visual failure grows with queue depth, which is exactly the thing M1d exists to make legible. Task 6's claim that queued cars need no rendering work is the one sentence that would stop anyone looking. Either the renderer must clamp a blocked car's drawn fraction below 1, or decision 6 must hold progress just below the threshold and say so, or Task 6 needs a coverage bullet asserting two queued cars draw at distinct positions.

**Witness:** resolve.ts:185; f = 1.0 => position = cell + 1*dir = the leader's cell centre.

---

## [Important] I5 — Ambiguous at a decision point: clamp-to-threshold and do-not-accumulate give different carries out of the block and different arrival ticks
**Section:** Design decision 6 — "holds its progress at the threshold"

Two readings. (a) Clamp: on the blocked tick write carProgress = threshold. The next tick's progress is threshold + speed, so the carry out of the crossing is the full speed (330) instead of the natural 140 orthogonal / 130 diagonal that constants.ts:186-189 pins as load-bearing. (b) Do not add speed at all: carProgress keeps its pre-block value, and the carry is the ordinary one. These give different arrival ticks for every car that was ever blocked, so every hand-computed figure in Tasks 3 and 7 depends on which is chosen, and so does the state hash. The plan states the property (do not accumulate, do not teleport) without stating the write. Pick one and write the assignment down.

**Witness:** constants.ts:181-199 pins the two carries (140 and 130) precisely because a zero or wrong carry is the classic diverges-after-thousands-of-ticks bug; reading (a) replaces both with 330 for any car that was blocked.

---

## [Important] I6 — Asks for a test that by construction cannot exist today, and names no mechanism
**Section:** Task 1c — "Pin the two 0-detector phase transpositions"

step.ts:100-115 records that 1<->2 and 2<->3 are 0-detector for exactly one reason: no TickAction reads H_TICK. Nothing in M1d's scope adds one (place, erase and the new blocking machinery all read no clock), so after Task 1c the transpositions are still unobservable and no behavioural test can fail under them. The two mechanisms actually available are (i) a source-order or structural assertion, which is the catalogue's 'a test that reimplements the thing it checks', and (ii) adding a clock-reading action, which is M1e's job and is out of scope here. The plan says 'pin them now, before that happens' and 'the phase transpositions each fail a named test' without saying how either is possible. Either name the mechanism and accept its known weakness explicitly, or move the obligation to the M1e carry-forward with a named recipient rather than leaving an implementer to invent a test that cannot fail and record it as a kill.

**Witness:** step.ts:104-115 states the transpositions are inert for one reason; M1d adds no TickAction that reads H_TICK, so the reason still holds after Task 1c.

---

## [Important] I7 — The blocked-counter reset rule is unspecified, and the two possible answers are opposite shipping behaviours
**Section:** Task 3 — the valve

The plan says a car blocked for MAX_BLOCKED_TICKS = 1350 proceeds regardless, and specifies the fire condition down to 1350-not-1349, but never says what happens to the counter afterwards. If it is not reset, the condition stays true on tick 1351 and every tick after, so blocking is permanently disabled for that car — a jammed city un-jams itself 45 seconds in and the whole mechanic evaporates. If it is reset to 0, a car in persistent gridlock advances one cell per 45 s. Also unspecified: is the counter reset when the car moves normally (it must be, or every car accumulates blocked ticks across its whole life and eventually valves through traffic for no reason), and is it incremented on the tick blocking is first detected or the tick after (which is what decides 1350-vs-1349). Three unstated rules behind one stated threshold.

**Witness:** Task 3's coverage says 'the valve fires at exactly tick 1350 of blockage and not 1349' — under a no-reset implementation it also fires at 1351, 1352, ... and that test still passes.

---

## [Important] I8 — Re-placing a road over a pending-erase cell is unhandled in both the coverage list and the mutation list; the player gets free tiles either way
**Section:** Task 5 — delayed refunds

eraseRoad currently refunds immediately (roads.ts:244-250) and canPlaceRoad charges 1 tile per endpoint whose mask is 0 (roads.ts:176). Under a delayed refund, a player who erases a segment under a committed car and immediately redraws it either (a) pays 1-2 tiles for a cell whose bits were cleared, and then receives the deferred refund when the car clears — net free road; or (b) if the bits were not cleared, pays 0 (cost is 0 for an existing segment) and still receives the deferred refund — a free tile out of nothing. H_TILES is player-visible and gates every placement, so either outcome is a real economy bug. Task 5's coverage says 'the tile budget is exactly restored, never double-refunded' and its mutations name 'refund twice' and 'forget to clear the pending flag', none of which reaches the re-place path. Add: 'placing a road over a pending-erase cell cancels the pending refund and is charged as if the cell were live', with its own fixture.

**Witness:** roads.ts:176 (cost = masks-zero count) and roads.ts:244-250 (refund on masks-become-zero) are the two halves that double-count once the refund is deferred.

---

## [Important] I9 — NO_ROAD contradicts M1c's documented and determinism-tested behaviour that movement never reads roads, and makes the ghost mechanism self-contradictory
**Section:** Task 2 — canEnter's NO_ROAD outcome

cars.ts:30-34 states as a design property that runMovement never reads state.roads, so a road erased under an in-flight car does not touch it and the car drives the erased segment to the end of its committed route; 'roads erased under in-flight cars' is one of M1c's seven determinism comparisons. Adding NO_ROAD to the entry check reverses that: an erased cell becomes impassable and the committed car stalls until its valve fires. It also makes Task 5 incoherent — the entire point of the ghost is that the committed car CAN finish, but if NO_ROAD already stops it, the ghost is either redundant (bits cleared, car stuck anyway) or unreachable (bits retained, so the road check never fires). The plan must state whether movement now reads roads, and if so, which M1c comparison it re-blesses.

**Witness:** cars.ts:30-34 documents the no-roads-read property; Task 2's outcome enum introduces a roads read into the same code path.

---

## [Important] I10 — No task extends the allocation driver to a jam, so the new per-car-per-tick blocking path is profiled by inputs that may never block
**Section:** Global Constraints — "mechanically enforced" allocation harness

allocation.test.ts drives pointer strokes over the starting city (driveWithDrag) and asserts one counter per branch it claims to enter. Nothing in it produces a queue, a ghost, or a valve fire, and no task in the plan adds anything to it — Task 2, 3 and 5 do not mention the harness at all, and Task 6's 'nothing allocates per frame' is the separate render harness (drawAllocation.test.ts). This is the catalogue's own most-repeated instrument failure: 'a green harness is a claim about the inputs it was given', which has already produced two live violations on this project under an already-green harness. Blocking is the milestone's hot path and the first workload whose cost scales with traffic. A named task must add a jammed-board driver with per-branch counters (blocked, valve fired, ghost traversed) and assert each is non-zero, or the milestone's zero-allocation claim is false as scoped for the third consecutive time.

**Witness:** allocation.test.ts:337 PROFILED_SCOPES = [packages/game/src/, packages/sim/src/]; driveWithDrag's counters cover pointer branches only. No plan task opens the file except Task 1b, which only deletes an allowance.

---

## [Important] I11 — The constant has no home: Task 3's file list omits packages/shared/src/constants.ts, and the seconds-to-ticks conversion is required to live there
**Section:** Task 3 — "MAX_BLOCKED_TICKS = 1350"

Global Constraints say rule constants are integers converted only in constants.ts, and the file's own precedent is explicit: FIRST_PIN_DELAY_TICKS = 4 * TICKS_PER_SECOND (constants.ts:148) with a comment saying 'the conversion belongs in this file and nowhere else'. 1350 is 45 * TICKS_PER_SECOND and must be derived, not literal. Task 3's files are blocking.ts, cars.ts, trips.ts. Only Task 4 lists constants.ts, and Task 4 is about lane speeds. A literal 1350 in blocking.ts also silently decouples the valve from TICKS_PER_SECOND, so a future tick-rate change would move the valve to the wrong wall-clock duration with nothing to catch it.

**Witness:** constants.ts:140-148 sets the precedent verbatim; Task 3's file list does not include the file.

---

## [Important] I12 — The gridlock vacuity check needs a test seam the plan does not create
**Section:** Task 3 — "assert that by disabling it in the test and observing no movement"

Disabling the valve from a test requires either a parameter or an injectable threshold. A module-level MAX_BLOCKED_TICKS cannot be varied — Global Constraints ban module-scope mutable state, and step's arity is pinned by step.test.ts so a sixth parameter is not available either. The project already has the right idiom for exactly this and the plan does not invoke it: assertSingleCrossing takes minThreshold as a parameter, advanceCar takes speed as a parameter, assertDispatchProgress takes its bound, assertBucketCountExceedsEveryEdgeCost takes its inputs — all four with a comment saying the reason is that the failure path becomes testable directly. The valve's threshold must be a parameter of whatever blocking.ts function decides it, with runMovement passing the constant, or the plan's own vacuity requirement is unexecutable.

**Witness:** cars.ts:170-188 states the parameterisation precedent explicitly ('make the unreachable branch reachable from a test'); Task 3 asks for the outcome without asking for the seam.

---

## [Important] I13 — Task 2's region addition breaks a game-package golden and a prose figure in main.ts that no task in the plan opens
**Section:** Task 2 / Task 5 vs packages/game

startingCity.test.ts:616 asserts hashState(state) === 2505371110 and game/src/main.ts:152 documents both 2505371110 and the rejected alternative 4171132894 in a paragraph explaining why a task refused to re-bless. Both move the instant a region is added. The plan's task file lists reach packages/game only for allocation.test.ts (Task 1b), frame.ts (Task 6) and integration.test.ts (Task 7). Nobody owns the seed golden or the main.ts prose, so the implementer of Task 2 will hit a red test in a package their brief never mentions — which historically is where a quiet re-bless happens. Name the recipient.

**Witness:** packages/game/test/startingCity.test.ts:616 and packages/game/src/main.ts:152.

---

## [Important] I14 — Non-sequitur: if straight runs are unchanged, whether the loop golden moves depends on whether the loop fixture turns at all
**Section:** Task 4 — "a straight run through a plain cell is unchanged… and the loop golden must therefore move"

The two halves do not follow from each other. The loop golden's in-flight car has carRouteLen 6 (loop.test.ts:748); whether any of those six steps is a right-angle turn, a sharp turn, or approaches an intersection is not stated anywhere in the plan. If none is, the golden does not move and 'say so and re-bless once, in this task only' is unfulfillable — and an implementer told the golden must move will look for a way to make it move. Task 4 should state which cells of the loop fixture carry which multiplier and what the new hand-computed arrival tick is, so that a golden that does NOT move is a red flag rather than a puzzle. (Independently, the loop golden will already have moved in Task 2 for an unrelated reason — see C2 — so 'once, in this task only' is false as written.)

**Witness:** loop.test.ts:748 carRouteLen === 6; the plan never characterises the fixture's geometry.

---

## [Minor] M1 — A 0-detector against every multiplier the milestone introduces, already killed by a pre-existing test
**Section:** Task 4 Mutations ("drop the `max(1, …)` clamp")

The clamp fires only when `(330 * mul / 1000) | 0 === 0`, i.e. `mul <= 3`. The three multipliers M1d wires produce 220, 165 and 109, and every pairwise average produces 192 or 137 — none reaches the clamp. So no test Task 4 writes can observe the mutation; it is killed only by the existing unit table at `speedUnits(0) = speedUnits(3) = speedUnits(4) = 1`. Listing it as a Task 4 mutation invites the implementer to record a kill and attribute it to Task 4's new coverage — the catalogue's "a check whose coverage is a strict subset of another check's is worth nothing" and "sanity-check the detector *set* against what the mutation can actually reach".

**Witness:** packages/sim/test/cars.test.ts:225-231; packages/sim/src/cars.ts:100.

---

## [Minor] M2 — Dead car slots all sit at cell 0, and the plan's fixtures cannot see the phantom occupancy they would create
**Section:** Task 2 (occupancy population) and Task 6 (rendering)

`PHASE_NONE` slots past the live prefix have `carCell = 0` (state.ts:306-315: no `-1` sentinel anywhere, unused cars are `PHASE_NONE = 0`). If occupancy is populated by walking every car slot, every dead slot claims cell 0 and that cell is permanently blocked. Cell 0 is the board corner; the loop fixture's corridor is row 5 and the starting city is placed inside the revealed rect, so no existing fixture has a road at cell 0 and none would notice. This is the M2 review's "80 phantom cars stacked on the top-left tile" one layer down, and the same lesson applies: the fixture must place a road at cell 0, or the phase filter is untested and the bounds of the board do the work instead.

**Witness:** packages/sim/src/state.ts:306-315; docs/superpowers/testing-defect-catalogue.md:60.

---

## [Minor] M3 — A second undeclared deviation from §5.5's density model
**Section:** Task 3 ("a destination's carpark is one cell") vs Spec §5.5

Spec §5.5 says "Parking bays [OURS]: reserved atomically at dispatch, round-robin over free bays. 3 bays single, up to 8 double." M1c implemented a single `carparkCell`, and Task 3 builds the queueing model on it as a stated fact. Decision 1 goes to some length to record the one-car-per-cell density deviation "rather than hidden", but says nothing about parking bays — so the milestone that first makes carpark capacity matter ships a 1-bay carpark against a spec that names 3 to 8, with no entry in the deferral table and no note for M1e's tuning, which is the milestone that will calibrate against it.

**Witness:** spec §5.5 "Parking bays [OURS] ... 3 bays single, up to 8 double"; packages/sim/src/buildings.ts `carparkCell`; Decision 1.

---

## [Minor] M4 — Stale premise: M2 already closed the coverage half
**Section:** Task 1a ("`dispatch.ts`'s had zero, with all four bounds surviving")

`dispatch.ts`'s `stepCell` is now exported and directly tested — its own doc comment says so: "Consolidating the three copies into `roads.ts` beside `DX`/`DY`/`dirBetween` remains the recorded plan (M1d); this closes the coverage half of it now, because coverage is what was actually missing." Task 1a's motivation reads as if the gap were still open. It does not change what the task should do (consolidation is still right), but it does change what the mutation battery will show, and an implementer expecting four surviving bounds from the dispatch copy will read the existing kills as evidence their refactor introduced coverage it did not.

**Witness:** packages/sim/src/dispatch.ts:305-322.

---

## [Minor] M5 — The cited figure is the diagonal per-tick displacement, not an interpolation gap bound, and it is not what blocking would violate
**Section:** Decision 6 ("breaks the interpolation invariant M2 established (largest ordinary gap 0.13334 cells)")

0.13334 is `330 * sqrt(2) / 3500` — the per-tick displacement of a car crossing a diagonal, asserted as a supremum on how far a car moves between two resolved snapshots. It is a statement about the sim's speed constants, not about an interpolation invariant that a blocking rule could break, and it is unaffected by whether a blocked car clamps or accumulates (see I3: accumulation throws). Citing it as the reason for Decision 6 is the catalogue's "a comment that overstates its case is the same defect class as a test that cannot fail" — the decision is right, the justification is falsifiable, and it will be re-cited.

**Witness:** packages/game/test/integration.test.ts:848-853; packages/game/test/resolve.test.ts:225-236; packages/game/test/frame.test.ts:1055.

---

## [Minor] M1 — "A snapshot/restore round-trips occupancy" and "ghosts survive snapshot/restore" are 0-detector once the data is in the buffer
**Section:** Task 2 and Task 5 coverage

`snapshot` is `s.buffer.slice(0)` and `restore` is `viewsOver(buffer.slice(0), map)` — a whole-buffer byte copy. Any region declared in `regionsFor` round-trips by construction; no mutation of `blocking.ts` or `roads.ts` can make it fail. Both bullets read as coverage and can only fail if the region is *not* in the buffer, which is a different assertion (and the one worth making — see C6, where the valve counter risks landing on `Scratch`). Restate as "the blocked-tick counter and the ghost state are inside the hashed buffer, asserted by name against `REGION_FIELD_NAMES`, and a cold-rebuilt `Scratch` does not change them."

**Witness:** packages/sim/src/state.ts:330-332 and :351-367.

---

## [Minor] M2 — The buffer grows ~60% and nothing re-checks M3's 4,096-character CloudStorage budget
**Section:** Tasks 2 and 5 — region sizing

On `firstCity` (24x40), an `Int32Array` occupancy region is 3,840 B and a per-cell ghost region at least 960 B, against a current 7,908 B buffer — a 61% increase. `trips.ts` records that the exact byte composition of that buffer is what M3's 4,096-character CloudStorage save budget was computed against, and that the compression prediction rests on specific regions being runs of zeros. An occupancy region initialised to -1 is a run of `FF` (compresses well); one initialised to 0 collides with "car 0 occupies cell 0", which is a real car on a real cell. Neither the sizing choice (Int32 per cell, where Int16 covers every car index since `maxCars = 2 * maxHouses`) nor the budget re-check is owned. Also note `createState`'s documented "a fresh GameState is all-zero in every region except rng and mapIdentity" becomes false and must be updated with it.

**Witness:** packages/sim/src/trips.ts, `completeTrip` comment: "`carRoute` is 3,840 B of the 7,908 B state buffer, and the prediction that a snapshot compresses is the prediction that an idle car's route slice is a run of zeros." packages/sim/src/state.ts:306-315.

---

## [Minor] M3 — Occupancy duplicates `carCell`/`carPhase` inside the hashed buffer with no consistency assertion
**Section:** Task 2 — occupancy as stored derived state

Occupancy is derivable from every live car's `carCell`, and M1b design decision 3's whole premise is that derived state lives *outside* the snapshot precisely because it can go stale. Putting it inside the hashed buffer means any disagreement between occupancy and `carCell` is a permanent, silently-wrong state that two engines will agree on byte for byte — determinism is preserved while the game is wrong, which is the worst combination for this project. The codebase's idiom for this is a named assert reachable from a test (`assertSymmetric`, `assertNoRoadOnImpassable`, `assertArrivalHonoured`); no task asks for `assertOccupancyConsistent`, and Task 7's long run has no bullet for it.

**Witness:** packages/sim/src/roads.ts:284-317 (`assertSymmetric` / `assertNoRoadOnImpassable`) — the established shape for exactly this kind of cross-region invariant.

---

## [Minor] M4 — The integration fixture is described in a unit the milestone does not have
**Section:** Task 7 — "a two-lane bottleneck"

Under one car per cell there is no lane concept — a cell is a cell. "Build a two-lane bottleneck" cannot be executed as written, and the ambiguity matters because the throughput figures are supposed to be hand-computed: two parallel one-cell corridors and one corridor two cells wide give different numbers, and a corridor "two lanes wide" in the spec's sense (§5.11, one lane each way) is a single cell that M1d cannot represent. Name the geometry in cells.

**Witness:** Plan line 186 versus decision 1 ("M1d ships one car per cell") and spec line 570.

---

## [Minor] M5 — The valve is claimed to guarantee no car is ever stuck forever; it only overrides occupancy
**Section:** Design decision 3 / Task 7 "no car starves"

Decision 3 asserts the valve "guarantees no car is ever stuck forever ... which matters because a permanently frozen car would hold a reservation and starve a destination", and Task 7 asserts "no car starves" over 20,000 ticks. Task 3 defines the valve as "a car blocked for `MAX_BLOCKED_TICKS = 1350` proceeds regardless" — regardless of *occupancy*. A car held by `GHOST` (Task 5, a ghost the car has not committed to) or by `NO_ROAD` is outside that override under a literal reading, and starves forever while holding `destReserved`, which then excludes its destination from dispatch for the rest of the run. State which outcome codes the valve overrides; if it overrides all of them, say so and note that it then also overrides the off-grid throw, which is a tripwire that should not be overridden.

**Witness:** Plan lines 66-70 versus lines 132 and 116 (the five-code outcome set).

---

## [Minor] M1 — The off-by-one is stated as a test without stating the rule it tests
**Section:** Task 3 — "the valve fires at exactly tick 1350 of blockage and not 1349"

Whether the counter is incremented before or after the comparison decides whether the car moves on its 1,350th blocked tick or its 1,351st, and both readings satisfy the sentence. Since this is one of the four named mutations (valve at 1349/1351), the rule needs to be written down once — "a car whose blocked counter reaches MAX_BLOCKED_TICKS at the start of phase 6 moves regardless" — or the mutation and the test are defined against each other.

**Witness:** plan Task 3 coverage bullet 3 and mutation list.

---

## [Minor] M2 — The number is a per-tick displacement bound, not an interpolation invariant, and the orthogonal figure differs
**Section:** Decision 6 — "the interpolation invariant M2 established (largest ordinary gap 0.13334 cells)"

0.13334 is `330 * sqrt(2) / 3500`, the diagonal per-tick displacement supremum used as a drift bound in an integration test; the orthogonal per-tick step is `330 / 2500 = 0.132`. Citing it as "the interpolation invariant" overstates what M2 established — the actual invariant is that frame positions are lerped between two resolved snapshots rather than extrapolated. The catalogue's own rule applies: a justification that reads as verified and is loosely stated is the same defect class as a test that cannot fail.

**Witness:** packages/game/test/integration.test.ts:848-853; packages/game/test/resolve.test.ts:225-236; packages/game/src/resolve.ts:259-280.

---

## [Minor] M3 — The spec's 45 s is scoped to an intersection; the plan applies it to every blocking event
**Section:** Decision 3 — the 45 s valve

Spec §5.5's table row is "max wait at intersection before proceeding anyway — 45 s". The plan generalises it to any blocked car anywhere, which is defensible (there are no intersections as objects yet) but is a [OURS] widening of a [MOD] number and should be recorded as such, in the same idiom Decision 1 uses for density — otherwise M1e tunes against a constant whose scope quietly changed.

**Witness:** spec §5.5 lane-speed table, final row; plan Decision 3.

---

## [Minor] M4 — There is no M1c baseline for a fixture this task invents
**Section:** Task 7 — "total trips strictly below the M1c baseline on the same fixture"

The bottleneck fixture is new in Task 7, so "the M1c baseline on the same fixture" does not exist; it can only mean "the same fixture with blocking disabled", which needs the switch of I3. If it instead means the loop fixture, that fixture's trip count changes for the layout reasons of C3 and the deadlock of C2, so the comparison would be measuring three changes at once.

**Witness:** plan Task 7 paragraph 1; packages/sim/test/loop.test.ts:59-146.

---

## [Minor] M1 — The architecture already makes classify-without-hashing structurally impossible; the mutation requires editing the derivation, not the classification
**Section:** Task 2 — "the partition test must prove it is hashed rather than merely classified"; mutation "classify it but do not hash it"

createFieldInputRanges (regions.ts:172-182) builds the hashed byte ranges BY FILTERING the layout table through isFieldInputRegion, and hashFieldInputRegions walks those ranges. regions.ts:157-163 and flowfield.ts:215-222 both say in terms that this shape exists precisely so classification and hashing cannot diverge. The named mutation is only constructible by adding a special-case skip inside createFieldInputRanges, which is a different edit from the one the mutation describes. Not wrong to ask for the test, but the plan should say what it catches that the existing table-driven derivation does not — otherwise it is the catalogue's 'a check whose coverage is a strict subset of another's'.

**Witness:** regions.ts:172-182 derives ranges from isFieldInputRegion; regions.test.ts:202 already pins inputEntries.length === FIELD_INPUT_REGIONS.length.

---

## [Minor] M2 — "Sharp turn" is never defined as an angle class, and the spec says only "hairpin"
**Section:** Task 4 / Six design decisions 4 — "sharp turn 0.333"

Spec 5.5 lists 'sharp turn (hairpin)' with no angle. With eight directions the turn classes available between consecutive route steps are 45, 90, 135 and 180 degrees. The plan assigns 0.667 to 'right-angle' (presumably 90) and 0.333 to 'sharp', without saying whether sharp means 135 only, 135 and 180, or something else — and 180 is unreachable on a dispatch-committed route since dir is a tree toward the sources. 45 degrees is assigned nothing, so it silently gets 1.0. Every hand-computed arrival tick in Task 4 depends on the mapping, and 'apply the intersection multiplier to a non-intersection' is the only mutation in the list that touches classification at all.

**Witness:** Spec 5.5 table row 'sharp turn (hairpin) | 0.333'; roads.ts:93-95 gives eight directions, hence four turn magnitudes.

---

## [Minor] M3 — Slight drift: there are two harnesses, and PROFILED_SCOPES covers only game and sim
**Section:** Global Constraints — "scoped to game, render and sim"

allocation.test.ts:337 sets PROFILED_SCOPES = ['packages/game/src/', 'packages/sim/src/'] and :751 pins that list exactly. render is covered by a separate file, drawAllocation.test.ts, against packages/render/src. Reading the Global Constraint as 'one harness covers all three' would make an implementer look for render coverage in the wrong file, and the pinned list at :751 means widening it is a deliberate, tested act rather than an edit.

**Witness:** allocation.test.ts:337 and :751; drawAllocation.test.ts is the render harness.

---

## [Minor] M4 — The -1 sentinel contradicts createState's documented all-zero invariant and forces a fill; a 0-means-empty encoding avoids it and is not considered
**Section:** Task 2 — "holding the occupying car index or -1"

state.ts:306-315 states that a fresh GameState is all-zero everywhere except rng, mapIdentity and H_TILES, that 'no -1 sentinel is written anywhere at creation', and that this is what makes 'a building-free state is byte-identical to a from-scratch state' true — a property later tasks' unchanged-goldens assertions depend on. An occupancy region of -1 requires createState to fill it, breaking that paragraph and forcing it to be rewritten. Storing carIndex + 1 with 0 = empty keeps the invariant intact at no cost and makes the freshly-created buffer genuinely blank. The plan should pick one and update state.ts's comment either way; silently leaving the comment as-is is the catalogue's overstated-comment shape.

**Witness:** state.ts:306-315.

---

## [Minor] M5 — canEnter(state, cell) has no world parameter, so the bounds check must re-derive dimensions from mapIdentity — a second source of truth beside world.cells
**Section:** Task 2 — canEnter's OUT_OF_BOUNDS code

Every other bounds-checking function in sim takes real dimensions and validates them: dirBetween(from, to, w, h), stepCell(cell, dir, w, h), inBounds(cell, cells), neighbours(state, world, ...). roads.ts:53-63 devotes a paragraph to why passing real w AND h matters (the row-seam wrap). Deriving them from state.mapIdentity[MI_MAP_W/H] instead introduces a second dimension source that restore validates but nothing else cross-checks. Give canEnter the world, as the rest of the module family does.

**Witness:** roads.ts:53-63 and roads.ts:108-120; dispatch.ts:295-329 both argue the point for their own copies.

---

## [Minor] M6 — The blocked-tick counter is a fifth counter with a wrap risk the plan's Task 1d guard does not cover
**Section:** Task 7 — Long-run "no counter wraps"

Task 1d is scoped to Uint8Array decrements (destPins, destReserved). The valve counter is an increment, not a decrement, and must reach at least 1350 — so a Uint8 slot is wrong by a factor of 5 and an Int16/Uint16 slot wraps at ~32k/65k ticks, well inside Task 7's own 20,000-tick run if a car is blocked continuously and the counter is never reset (see I7). 'no counter wraps' in Task 7 is the right assertion; nothing in Tasks 1-3 sizes the region so that it holds.

**Witness:** Task 3 sets MAX_BLOCKED_TICKS = 1350, above Uint8's 255; Task 7 runs 20,000 ticks; no task declares the region or its element type.

---

