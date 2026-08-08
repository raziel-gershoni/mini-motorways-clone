# M1d: blocking and gridlock — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make road layout matter. Cars queue, yield, back up, and strangle a badly-built city — from one primitive, with no collision physics.

**Architecture:** Spec §5.5's single blocking question — *does an inbound vehicle collide with a traversing vehicle on this chunk?* — implemented as **per-(cell, lane) occupancy** in the state buffer, where the lane is a frozen function of the direction of travel, resolved in ascending car index within one tick. Queueing, carpark queues and emergent gridlock all fall out of it. Plus lane-speed multipliers, delayed refunds and ghost roads, and the structural items M1c and M2 handed forward.

**Tech stack:** TypeScript, zero runtime dependencies, integer-only in `sim`, Vitest.

**This plan is a rewrite.** Its first revision was reviewed pre-execution and returned **do not execute**: the primitive was one undirected slot per cell, which deadlocks the project's own loop fixture at tick 73 (reproduced twice, by execution — cars 0 and 1 both on cell 113), and it classified occupancy as a flow-field input, which was measured at five whole-board Dijkstras per tick for byte-identical output. Both are fixed below, and the reasoning is stated rather than assumed so that the next reader can check it.

---

## Global Constraints

- **Zero runtime dependencies.** Integer-only arithmetic in `sim`; no module-scope mutable state; module-scope literal data `Object.freeze(... as const)`. Three mechanisms enforce this, including custom AST lint rules.
- **Rule constants are integers over a denominator of 1000**, converted only in `packages/shared/src/constants.ts`.
- Cell index convention is `index = y * w + x`. **Occupancy slot convention is `slot = cell * 2 + lane`** — stated here beside it, because it is the second index arithmetic this codebase carries and the two must not be confused.
- **Nothing allocates inside a tick or a frame. There are two harnesses, not one, and the Global Constraint used to name the wrong one.** `packages/game/test/allocation.test.ts` profiles `packages/game/src` and `packages/sim/src` — its `PROFILED_SCOPES` list is pinned at `:751`, and it passes a **no-op draw** (`:487`, `:1042`), so it cannot see `render` even if the scope were widened. `packages/game/test/drawAllocation.test.ts` profiles `packages/render/src`, with its own budget and its own rig. **A change to the draw path is measured by the second file; a change to the tick is measured by the first.** Confirm the relevant one is live by injection before trusting a green result — the first was silently inert in every worktree for two tasks of M2. And both are claims about the inputs they were given: see Task 9's tick-side profile (the shipped rig never moves a car at all) and Task 8's ghost driver.
- **`render` imports nothing from `sim`.** Enforced by a source scan whose one real catch is a raw relative path.
- **Five goldens, and they are not one kind of thing.** Four are FNV over the whole state buffer and therefore move on layout alone: state `2413319809` (`packages/sim/test/determinism.test.ts:555`), road-network `2790151213` (`packages/sim/test/rollback.test.ts:699`), loop `3896659943` (`packages/sim/test/loop.test.ts:761`), seed `2505371110` (`packages/game/test/startingCity.test.ts:616`). The fifth, field `252514232` (`packages/sim/test/rollback.test.ts:743`), is `foldedFieldsHash` over `dist`/`dir`, which live **outside** the buffer. **Exactly two tasks change buffer shape and each re-blesses the four; every other task must leave all five alone. The field golden must not move in any task — it is a tripwire, not a re-bless.** See "Why exactly two re-blesses are true" below. If a golden moves and your task did not say it would, **stop and report — do not re-bless.**
- Do not modify `spike/`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## Scope

**In:** per-(cell, lane) occupancy and the blocking check; queueing and carpark queues as emergent consequences; the anti-deadlock valve; lane-speed multipliers wired to a real caller; delayed refunds and ghost roads (§5.11); rendering ghosts; the inherited structural items; and a tick-side allocation profile that actually enters the new branches.

**Out, and named so the gap is not read as an oversight:**

| Deferred | Owner | Why |
|---|---|---|
| Traffic lights, roundabouts, motorways | M1e | All three are upgrade *cards*. There is no card mechanism yet |
| Bridges and tunnels | M1e | Same |
| Overcrowd failure, game over | M1e | M1d makes cities strangle; M1e makes that cost you the run |
| Weekly demand ramp | M1e | Difficulty tuning needs blocking to exist first, which is why M1d is before M1e |
| **Board expansion / a real revealed region (§5.1)** | **M1e** | **M2's own deferral table handed this to M1d by name** (`plans/2026-08-04-m2-playable-renderer.md:56`), and eight source files say the same thing in the imperative. M1d declines it: no M1d task needs it, and a revealed region in state would be a third change to buffer shape. **Because the comments are phrased "M1d owns making it dynamic", they read as *satisfied* the moment M1d ships. They are now wrong.** Task 9 repoints every one of them to M1e; whoever picks the work up inherits comments that name their own milestone, not a milestone that passed |
| **Drawing the two lanes** | **M1e** | The sim now models one lane each way; the renderer still draws every car on the cell centreline, so two cars in opposite lanes visually pass through each other. This is demonstrable in the project's own loop fixture: cars 0 and 1 cross at x ≈ 13.25 on row 5 between ticks 71 and 72. The fix is a perpendicular offset of about 0.15 cells in `resolve.ts` (`(-DY[dir], DX[dir])`, which flips sign with the direction and therefore agrees with the lane table for free). It is deferred because it is not free: the offset rotates at a turn and reverses at the outbound→return flip, adding rows of **0.212** and **0.30** cells to `resolve.ts:63-73`'s displacement table against its current supremum of **0.1333**, so M2's whole interpolation derivation and the tests quoting it (`resolve.test.ts:225-236`, `:550`, `frame.test.ts:1055`) must be re-derived. That is a milestone-sized change to a shipped, carefully-argued piece of rendering, not a two-line addition |
| Persistence | M3 | The state buffer grows **7,908 → 13,828 bytes** in this milestone (+74.9 %), which M3's 4,096-character CloudStorage budget depends on compressing. The added bytes are one long run of `0xFF` (occupancy at rest) and two runs of `0x00`, which is the compressible case — but M3 must **re-measure**, not assume |

**M1d does not add a lose condition.** After it, a badly-built city visibly jams and throughput collapses — and nothing punishes you for it. That is deliberate: M1e's overcrowd threshold is calibrated against how much traffic a network can actually move, and tuning it against a world where cars pass through each other would mean tuning every number twice.

---

## Eight design decisions

### 1. Occupancy is per (cell, lane), and the lane is a frozen function of the direction of travel

Spec §5.11 line 275: a road is **"Bidirectional, one lane each way."** A single undirected slot per cell is not a simplification of that — it is a different road. It makes opposing traffic **mutually exclusive on every shared cell**, and the shipped code guarantees opposing traffic is the modal event, not an edge case: `cars.ts:208` makes the return leg the outbound route read backwards, `trips.ts:114-122` flips the phase in place on the carpark cell with no dwell, `dispatch.ts:171` seeds every colour's field at a single carpark cell, and `CARS_PER_HOUSE = 2` puts two cars of one house on one route. A dead-end carpark is the tightest case and every destination is one.

**So: two slots per cell, keyed by the direction of travel.** The mapping is a **frozen table**, not a computed rule, so a reader can check all eight entries at a glance. `DIRS` is index 0 = N, clockwise (`roads.ts:91-95`).

| dir | name | `(DX, DY)` | lane |
|---|---|---|---|
| 0 | N | (0, −1) | **1** |
| 1 | NE | (1, −1) | **0** |
| 2 | E | (1, 0) | **0** |
| 3 | SE | (1, 1) | **0** |
| 4 | S | (0, 1) | **0** |
| 5 | SW | (−1, 1) | **1** |
| 6 | W | (−1, 0) | **1** |
| 7 | NW | (−1, −1) | **1** |

```ts
export const LANE_OF_DIR = Object.freeze([1, 0, 0, 0, 0, 1, 1, 1] as const)
```

Lives in `roads.ts` beside `DX`/`DY`/`OPPOSITE`, which is where every other direction table already lives. **The mapping is total**: all eight directions are listed, each maps to exactly one lane, and four map to each. The rule a reader can check it against is *lane 0 iff the travel vector points east, or due south when it does not point east* — `DX[d] > 0 || (DX[d] === 0 && DY[d] > 0)` — but the table is the source of truth and the rule is the check, not the other way round.

**The one property that makes head-on structurally impossible:** `LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]` for every `d`. Two cars travelling in exactly opposite directions can never contend for the same slot, so a head-on swap always resolves in one tick, in either index order, with no valve, no give-way rule and no special case. Verify the four opposite pairs against the table above: 0↔4 is 1/0, 1↔5 is 0/1, 2↔6 is 0/1, 3↔7 is 0/1. **This restores the spec's two lanes.** It also means no 2-cycle deadlock can exist at all — a mutual block needs each car standing on the other's target, which makes their directions exact opposites, which puts them in different lanes. Only cycles of length ≥ 3 can deadlock, which is what the valve is for.

**What it costs, and it is not a density halving.** One car per lane-tile against the spec's 1 car per 0.5 tile is still **half** the spec's density, and that must be recorded rather than discovered later. Two cars per lane-tile requires sub-cell slots whose identity changes at every turn — a second positional system alongside `carProgress` that would have to be deterministic, allocation-free and correct across the outbound→return flip. Do not add a `CARS_PER_CELL` constant "for later": an untested second value is dead code that reads as a supported configuration. If M1e's tuning finds throughput too tight, the fix is a genuine change with genuine tests.

**And the model's real limit, stated plainly: two lanes do not model an intersection crossing.** Two cars may share a cell whenever their directions land in different lanes — which on a straight corridor means exactly "one each way", but at a junction also permits an eastbound car and a northbound car to occupy the same cell simultaneously. They cross paths inside that cell and nothing stops them. That is the spec's own model (§5.5 prices intersections with a *speed* multiplier and a *wait*, not with mutual exclusion) and it is what M1e's traffic lights and roundabouts are for. Same-lane entry is refused, which covers every same-direction conflict and every perpendicular pair that happens to share a lane.

### 2. Contention resolves within one tick, in ascending car index — no timestamps

Spec §5.5 describes chunks tracking "inbound vehicles with a committed timestamp". That mechanism exists to order claims arriving at different continuous times. **Our movement is discrete: a car either enters a cell this tick or it does not.** A timestamp adds a field and orders nothing that ascending car index does not already order.

**Ascending car index becomes outcome-visible for the first time**, and M1c predicted exactly this: *"the invariant that makes iteration order invisible is exactly what M1d's blocking will break"* (`cars.ts:255`, `dispatch.ts:571`). It was pinned then for this reason. Pin it here too, and **this time it is observable** — two cars contending for one slot produce different survivors under different orders.

### 3. Only a crossing claims a cell. Idle cars, and a car that has not yet crossed, stack legally at their house

Occupancy is a claim/release protocol with more events than "enter" and "leave", and the first revision of this plan specified only those two. All of them, and no others:

1. **Creation.** `createState` (`state.ts:316-327`) fills the occupancy region with `FREE = -1`. An `Int16Array` region zero-initialises, and a zero-filled occupancy region reads as *"car 0 occupies every lane of every cell"* — nothing on the board could move.
2. **A crossing into a cell claims `(cell, LANE_OF_DIR[dir])`**, where `dir` is the direction of that crossing — the value `advanceCar` already computes at `cars.ts:208`.
3. **A crossing out of a cell releases it**, guarded (below).
4. **Trip end releases.** `completeTrip` (`trips.ts:149-159`) is a release site. A returning car's last crossing genuinely enters the house cell, so it holds a claim there; if `completeTrip` does not release it, the car holds its own front door forever and its sibling stalls the full valve on **every** return leg. That is the most common trip in the game.
5. **Nothing else claims.** Not dispatch, not `placeHouse`, not an idle car.

**The tick-0 question, decided.** `placeHouse` (`buildings.ts:342-349`) puts `CARS_PER_HOUSE = 2` cars on one cell before any tick runs, and `dispatch.ts:552` can flip both of them OUTBOUND in the same tick. A house cell necessarily carries a road (the flow field propagates only over road bits, so a house whose cell has no road is never dispatched from, and `roads.ts:167-172` deliberately keeps house and carpark cells placeable), so this is the steady state of every house, not a fixture artefact. **The ruling is: cars stack legally at their home cell.** Rule 2 above does the work — a car that has not yet crossed on its current leg holds nothing, and an idle car holds nothing, so two, three or `CARS_PER_HOUSE` cars on a house cell is representable and correct.

Note what this is *not*: house cells are **not exempt from occupancy**. A car driving *through* a house cell claims it exactly like any other cell. Exempting the cell would put a permanent hole in the blocking primitive that a player could route traffic through, which is the "blocking silently stops working" failure this milestone must not ship.

**What it costs, stated so it is not discovered later:**

- **Occupancy is sound but not complete.** A cell can carry more cars than its slots name. The consistency assertion therefore has two halves of different strength — see Decision 6 — and the weaker half's exception set must be written down rather than inferred.
- **A house's front door does not queue; the first crossing does.** Two cars dispatched from one house in one tick both leave with no claim; the lower-indexed one takes the first crossing and the higher-indexed one is refused at it. That is correct queueing, one cell later than a naive reading, and it is what keeps `dispatch.ts:552` correct without dispatch ever being refused.
- **Two cars are drawn on one cell.** Already true today — `resolve.ts:159-162` draws an idle car at its cell centre — so M1d adds no new artefact here. Worth saying, because "cars no longer overlap" is the natural and false reading of this milestone.
- **Six prose sites go stale**, all of which assert a fresh state writes no `-1` sentinel: `state.ts:306-315`, `state.test.ts:374-375`, `trips.ts:194`, `frame.ts:70`, `render/src/types.ts:251`, `render/test/interface.test.ts:43`. The last three are about the regions `render` reads and can be *narrowed* rather than rewritten; the first three must name `occupancy` as the exception. All six in the same commit as the fill.

### 4. Occupancy lives in the buffer and in `hashState`, and it is `FIELD_IRRELEVANT`. Both, at once

This reads as a contradiction until you know what the partition is for, so: **the FIELD_INPUT / FIELD_IRRELEVANT partition is the flow-field staleness key and nothing else.** It is not a statement about which bytes matter for determinism.

- **`hashState` is FNV over the *whole* buffer** (`state.ts:369-371`), and `snapshot`/`restore` copy the whole buffer. So occupancy is covered for determinism, replay and rollback **whatever partition it is in**. It needs no help from the partition to survive a Worker cold start.
- **`syncFields` (`flowfield.ts:399-412`) rebuilds every colour whose FIELD_INPUT hash moved.** Occupancy changes on any tick any car crosses a cell. Classifying it FIELD_INPUT therefore runs a full 960-cell Dijkstra for all five colours on nearly every tick, forever, **with byte-identical output**. Measured: 1.14 ms (mid-density) to 1.91 ms (full grid) per rebuild × 5 colours = **5.7–9.6 ms/tick on a desktop core**, multiples worse on the phone M2 shipped to, and roughly **114 s of pure Dijkstra** for Task 9's 20,000-tick run — landing equally in the Cloudflare Worker that verifies leaderboard scores. Reproduced by proxy: adding `carCell` to `FIELD_INPUT_REGIONS` took `CT_REBUILDS` from 35 to 125 over the 130-tick loop fixture, with two cars on the board, and left `hashState` unmoved.

Nothing in this milestone makes an edge cost, a source set or a `dir` read depend on occupancy. `edgeCost` (`graph.ts:94`) is pure length; routes are committed once at dispatch and never re-pathed. Spec §1 and M1c's decision row 6 say the omission of a congestion term is *"deliberate and load-bearing; it is the game."*

This is the exact failure `state.ts:24-34` and `regions.ts:86-89` already record as the reason `H_TICK` was split out of a hashed region: *"hashing it would rebuild every colour every tick forever, silently, with correct answers."* And `regions.ts:95-98` already classifies every car region FIELD_IRRELEVANT with a dated reason that names the milestone that ends it — *"irrelevant while no edge cost depends on occupancy (dated: M1e's demand-actuated lights make car positions a field input)"*. Occupancy is the cell→car inverse of `carCell`. Classifying the projection FIELD_INPUT while its source stays FIELD_IRRELEVANT would be an internal contradiction with the shipped layout.

**Every region this milestone adds is `FIELD_IRRELEVANT`, and each gets a dated reason in the same form.** That includes the two ghost regions, and Decision 8 says why — the ghost's effect on routing is already carried by `roads`.

### 5. Blocking is checked at cell entry, never mid-cell, and a refused car does not accumulate

A car's position is `(cell, progress)`. It becomes blocked only at the instant it would cross into the next cell.

**On a tick where entry is refused, `carProgress` is left exactly as it was and `speed` is not added.** Not "clamped to the threshold" — the first revision said "holds its progress at the threshold", and four independent readers produced three incompatible writes from it, differing by a full tick on the next crossing and every one after. Two reasons the untouched form is the right one:

- **`carProgress = threshold` discards up to 329 units** every time, which is the carry-dropping bug `cars.ts:41` exists to forbid.
- It makes the rendered `f = carProgress / (edgeCost(dir) * COST_UNIT_SCALE)` exactly **1.0** (`resolve.ts:185`, unclamped), which draws the car at the centre of the cell it has *not* entered — one full cell forward, on top of the car it is waiting for. Leaving progress untouched keeps `f < 1`, needs **no renderer change**, and the displacement on release is the ordinary 330/2500 = 0.132 cells, inside M2's 0.13334 envelope.

Mechanically this is one branch: compute `progress = carProgress + speed`; if it reaches the threshold, ask `canEnter`; if refused, write nothing at all and return. The car retries the same comparison next tick and crosses on the first tick it is granted — which is also why "advances exactly one cell when the way clears, not two" holds by construction: the residual after a crossing is still strictly below the speed.

### 6. The valve, and the release rule that keeps the array sound

Spec §5.5: **max wait at an intersection before proceeding anyway is 45 s** — `MAX_BLOCKED_TICKS = 45 * TICKS_PER_SECOND` = **1,350** ticks, derived in `constants.ts`, never written as a literal. A car blocked that long moves regardless of occupancy.

This is not a safety hack, it is the mechanic: a gridlocked city grinds rather than stops, which is what makes the failure legible and recoverable. **It also guarantees no car is ever stuck forever**, which matters because a permanently frozen car holds a claim and starves a destination.

**Under two lanes the valve's job shrinks to what it is actually for.** Head-on is structurally resolved (Decision 1) and no 2-cycle can deadlock, so the valve is not the answer to opposing traffic — it is the answer to a **cycle of length ≥ 3**, where every car is same-lane-blocked by the next. 1,350 ticks is 45 s, **30 % of a 4,500-tick week**; that is an acceptable price for a genuine circular wait and would have been an absurd one for the commonest event in the game.

**The release rule is part of this decision, not an implementation detail.** Two rules together:

- **Release is guarded by identity, and clears *both* lanes of the vacated cell:** `if (occ[c*2] === i) occ[c*2] = -1; if (occ[c*2+1] === i) occ[c*2+1] = -1`. Two comparisons, and it needs no direction. **Releasing "the lane derived from the direction I am leaving by" is wrong and is the corruption case**: a car that entered a cell heading E and leaves it heading N claimed lane 0 and would clear lane 1, leaving lane 0 claimed by a car that is not there — a cell that silently stops blocking for the rest of the run. Every turn is an instance.
- **Claim overwrites.** A crossing writes `occ[slot] = i` unconditionally, so a slot always names the most recent car to have entered it.

Together these make the array **sound at all times** — every slot that names a car names a car that is standing on that cell — and they self-heal. Trace the four-car ring this milestone tests, all four valves firing on one tick, processed ascending: car 0 clears its own slot on c0 and overwrites c1's; car 1's guarded clear on c1 now fails (correctly — car 0 is there) and it overwrites c2's; and so on. End state: every cell named by exactly the car standing on it, zero holes. **Unconditional release is the natural extension of `cars.ts:235`'s single in-place write and it is wrong**: on the same ring it leaves three of four cells reading FREE with a car on each, blocking silently stops working for the rest of the run, and it propagates into Decision 8's refund trigger.

**The one residual, stated because it is real.** When the valve fires for car *i* into a slot held by car *j*, and *j* does not move that tick, both are on the cell and the slot names *i*. If *i* leaves first, its guarded clear succeeds and frees a slot *j* is still standing on. That is a **transient completeness gap, never a soundness violation**, and the next entrant overwrites it back into a correct state. So the consistency assertion is written as two halves of different strength: soundness holds unconditionally and is asserted unconditionally; completeness holds for every car that has crossed at least once on its current leg **and has not been displaced by a valve firing**, and is asserted on fixtures where the valve has not fired.

**The counter is state-buffer state, and its width is load-bearing.** A per-car consecutive-blocked-tick counter, `Int16Array` of length `maxCars`, in the region list. It must **not** live on `Scratch`: `Scratch` is rebuilt every tick, so a Scratch-resident counter resets, the valve fires in a browser and never in a Worker replay — the exact divergence this product exists to prevent — and nothing in the existing suite would see it. It must **not** be `Uint8`: 1,350 > 255, so the threshold is unreachable and the valve simply never fires. It **saturates** at `MAX_BLOCKED_TICKS` rather than incrementing without bound, so no width question can ever arise, and it resets to 0 on any successful entry **including the valve's own**.

### 7. Lane-speed multipliers get their first caller — and movement starts reading `roads`

`speedUnits` (`cars.ts:99-101`) has been covered since M1c against a hand-written literal table at `mul ∈ {333, 500, 667, 1000, 2000, 3000}`, deliberately as a unit test, because every non-identity multiplier belonged to a later milestone. M1d gives it a caller.

**The turn classification, which the first revision never defined.** On the 8-direction lattice a turn is 45°, 90°, 135° or 180°, and the angle is `45° × min(|d|, 8 − |d|)` where `d` is the difference of two direction indices:

- **45° carries no multiplier** — the table's default lane speed, 1.0.
- **90° is the right angle**: `RIGHT_ANGLE_SPEED_MUL` = 667.
- **135° is the sharp turn**, the sharpest the lattice admits: `SHARP_TURN_SPEED_MUL` = 333.
- **180° is unreachable within a leg** — the field's downhill walk cannot produce a 2-cycle, since `dist` strictly decreases along it — and is **not emitted across the outbound→return flip either, because the turn angle is computed within a leg only** and the first crossing of a leg has no in-leg predecessor. Assert it in the fail-closed idiom `assertSingleCrossing` established, rather than giving it a behaviour.
- **"Approaching an intersection" means the cell being *entered* has road degree ≥ 3**: `INTERSECTION_SPEED_MUL` = 500. The turn happens where you turn (the cell you are leaving); the intersection is what you approach (the cell you are entering). Degree is `popcount(roads[cell])`, from a new read-only helper in `graph.ts` — the only change `graph.ts` takes.

**Averaged where several apply** (§5.5), not minimised. Exactly two combinations are reachable — a right angle at a junction and a sharp turn at a junction — because a turn has one angle:

| applicable | average `mul` | `speedUnits` | minimum instead | ticks for one orthogonal cell |
|---|---|---|---|---|
| {667} | 667 | 220 | — | 12 |
| {500} | 500 | 165 | — | 16 |
| {333} | 333 | 109 | — | 23 |
| {667, 500} | 583.5 | **192** | 165 | 14 vs 16 |
| {333, 500} | 416.5 | **137** | 109 | 19 vs 23 |

**"Take the minimum instead of the average" is observable in both rows.** **"Change the rounding direction of the average" is not, and that must be stated rather than tested for.** `speedUnits(583) = ⌊330·583/1000⌋ = ⌊192.39⌋ = 192` and `speedUnits(584) = ⌊192.72⌋ = 192`; `speedUnits(416) = ⌊137.28⌋ = 137` and `speedUnits(417) = ⌊137.61⌋ = 137`. Both reachable averages are equivalent mutants at this constant set — over the *whole* reachable set, not a sample. Fix the direction in code (truncate, matching `speedUnits`'s own truncation), label it inert, and note that it stops being inert the moment `CAR_SPEED_UNITS_PER_TICK` or any multiplier changes. That is the same "one calibration, not four independent numbers" obligation `constants.ts:166-169` already carries.

Separately: **`speedUnits`'s own truncation already has an observer** — `cars.test.ts`'s literal table pins `speedUnits(333) === 109` against 110 for round-half-up. Do not add a second one and call it new coverage. What M1d adds is a caller, which makes multiplier *selection* observable for the first time.

**This decision makes `cars.ts` read `state.roads`, and that invariant is currently written down as a promise.** `cars.ts:29-33` says *"This module also never reads `state.roads`"*, and it is load-bearing for the erase-under-traffic story. It is now false: the intersection multiplier needs the degree of the cell being entered. **The route is still never re-derived** — a road edit under an in-flight car can change its *speed* and can never change its *path* — and the module comment must be amended to say exactly that, in the same commit, rather than left as a promise the code has stopped keeping.

### 8. A delayed refund is a ghost mask plus a committed-car count, and re-placing pays the debt

§5.11: deleting a road refunds in full, but the refund is **delayed while a car has committed to that segment**, and the tile renders as a thinner, lower-opacity ghost until the last committed car clears. The word "committed" is used without definition in the spec, and its only carrier — §5.5's "inbound vehicles with a committed timestamp" — is the structure Decision 2 discards. So it is defined here.

**"Committed" means: at the instant of the erase, the cell appears in the car's remaining route.** Occupancy cannot express this. Occupancy records who is standing on a cell *now*, while a committed car may be five cells short of it — and `dispatch.ts:540-546` commits the whole route at dispatch, unreached cells included, and movement never re-paths. Keying the refund on occupancy fires it immediately and the ghost vanishes under an inbound committed car, which is the exact case §5.11 exists for.

**A cell becomes a ghost only when the erase takes its last road bit** — i.e. exactly when `eraseRoad` would refund a tile for it (`roads.ts:244-250`) — **and at least one car is committed to it.** That scope is not arbitrary; it is what makes the count sound. With the cell's live bits gone, `dist[cell]` is INF and no route committed after the erase can contain it, so **every car that ever crosses off that cell afterwards is one of the cars counted at erase time**. Ghost the cell whose bits survive and that identity breaks: a car dispatched later could be routed through it and would decrement a count it was never part of.

Two regions, not one flag:

- **`ghostMask` (`Uint8Array`, one per cell)** — the road bit the erase removed. `eraseRoad` clears the live bit from `roads` as it does today, so the flow field loses the edge immediately and **no new route is ever committed across a ghost**; the bit moves here. The renderer needs the bit, not a boolean: `canvas.ts:492` blits one atlas tile per cell keyed by that cell's 8-bit mask and documents *"Mask 0 is never blitted"*, and a ghost cell is by definition one whose live mask reached 0.
- **`ghostCommitted` (`Uint8Array`, one per cell)** — the number of in-flight cars whose remaining route contains this cell, counted **once, at erase time**, by walking each in-flight car's remaining route with `stepCell`. It can only fall. It is decremented, guarded, when a committed car crosses off the cell or ends its trip there; reaching 0 clears both regions and pays the refund. This is the milestone's genuine new `Uint8Array` decrement path, and it is what Task 1's standing guard is for. Its bound is `maxCars`, which is 80 on `firstCity` and is not bounded by `parseMap`, so the counting site carries a named assertion in the `assertSingleCrossing` idiom rather than trusting the map.

**Re-placing a road over a ghost cell pays the pending refund and charges the placement normally.** Not "cancels the refund": cancelling charges the player twice for one cell (they paid 1 to build it, 1 to rebuild it, and got nothing back) and violates §5.11's "refunds in full". Paying it means erase-then-replace nets exactly zero, repeatably, so nothing prints and nothing is confiscated — which matters more than usual here, because the Worker replays the identical input log and an inflated budget would verify as legitimate on the leaderboard. Stated as one rule: **the pending refund is paid the moment the cell stops being a ghost, and a cell stops being a ghost when its committed count reaches 0 or a road is placed on it.**

**`canEnter` gains the entering car's index**, so it can answer per-car. It returns four outcome codes, not a boolean — the house pattern M2 established, and the direct mechanical answer to this project's most-repeated defect family, "a negative assertion satisfied by the wrong mechanism":

| code | meaning |
|---|---|
| `ENTER_FREE` | the slot is free |
| `ENTER_VALVE` | the slot is taken and the blocked counter reached `MAX_BLOCKED_TICKS` |
| `REFUSED_OCCUPIED` | the slot is taken |
| `REFUSED_GHOST` | the cell is a ghost and this car is not committed to it |

Two things about that set, both stated rather than left to be discovered:

- **There is no `NO_ROAD` code, deliberately.** Movement must not consult `roads` for permission: a committed car has to be able to drive a ghost, which is the whole feature, and M1c's "movement follows its committed route whatever happens to the world underneath it" is the invariant that makes replay tractable. `OUT_OF_BOUNDS` is likewise absent — `stepCell` returns −1 and `advanceCar` already throws on it by name.
- **`REFUSED_GHOST` is unreachable in production, and that is a property to record, not a bug to fix.** With the live bits cleared, no route committed after the erase can contain the cell, and every car committed before it *is* committed. So the code exists as a fail-closed guard, reachable only from a hand-built state — exactly the idiom `cars.ts:223-233`, `assertSingleCrossing` and `assertDispatchProgress` already use. Exercise it directly and say in the source that it is unreachable through `runDispatch` + `runMovement`, so nobody deletes it on the strength of its own survival. **The valve does not release a `REFUSED_GHOST`**: a car must never drive onto a road that no longer exists merely because it waited.

---

## Why exactly two re-blesses are true, and exactly which numbers move

`hashState(s)` is `hashBytes(s.bytes)` (`state.ts:369-371`) and `s.bytes` is a `Uint8Array` over the **whole** buffer, sized by `computeLayout(regionsFor(map)).totalBytes`. FNV-1a walks `bytes.length`, so **adding a region changes the digest even when every new byte is zero** — and occupancy is `-1`-filled, so not even that marginal case applies. Four of the five goldens therefore move on layout alone, before any behaviour changes.

**This milestone changes buffer shape in exactly two tasks, and no others.** That is a deliberate structure, not an accident of ordering: every standing re-bless licence is a window in which a genuine behavioural regression gets absorbed as an expected hash update, which is precisely how the first revision of this plan would have shipped a deadlock. It follows the convention the repo already documents at `state.ts:10-13` — the region list is settled early so later tasks append behaviour, never shape.

| Task | Regions added | `regionsFor` count | `totalBytes` (firstCity) |
|---|---|---|---|
| — | — | 22 | 7,908 |
| **Task 2** | `occupancy` (`Int16`, `2 × cells` = 1,920 elements, **3,840 B**), `carBlockedTicks` (`Int16`, `maxCars` = 80, **160 B**) | 24 | **11,908** |
| **Task 5** | `ghostMask` (`Uint8`, `cells` = 960 B), `ghostCommitted` (`Uint8`, `cells` = 960 B) | 26 | **13,828** |

Both `Int16` regions append to the end of the `Int16` tier (after `carRouteCursor`); both `Uint8` regions append to the end of the `Uint8` tier (after `carRoute`). **`regions.test.ts`'s zero-padding assertion still holds at every step** — recomputed: the 4-byte tier is 1,660 B, the `Int16` tier becomes 4,320 B and then stays, the `Uint8` tier becomes 7,848 B, and 11,908 and 13,828 are both multiples of 4, so `computeLayout` inserts no pad byte anywhere.

**Each of those two tasks must, in the same commit as the region:**

- re-bless `packages/sim/test/determinism.test.ts:555` (state), `packages/sim/test/rollback.test.ts:699` (road-network), `packages/sim/test/loop.test.ts:761` (loop), `packages/game/test/startingCity.test.ts:616` (seed);
- re-bless the **cross-file literal scan** at `packages/sim/test/loop.test.ts:772-790`, which reads `determinism.test.ts` and `rollback.test.ts` off disk and asserts their literals verbatim. Its own comment says it exists *"to make the quiet re-bless cost a second, differently-located test failure"*. It pins **three** literals, at `:781`, `:782` and `:784` — and `:784` is the **field** golden, which must not change;
- update `packages/sim/test/regions.test.ts`: `totalBytes` at `:47`, the ordered region-name list at `:52-78`, and the FIELD_INPUT exact-set pin at `:120-125` (which fires if any new region is misclassified — see Decision 4). Note what does **not** need updating and is doing real work for free: the parameterised staleness test below it (`:128` onward) pokes one byte of **every declared region** and asserts `hashFieldInputRegions` moves iff that region is FIELD_INPUT, so each new region is covered by it the moment it is declared;
- update the prose figures at `packages/game/src/main.ts:152`, which document `2505371110` and the rejected `4171132894` in a comment nothing greps;
- record old and new values **in the commit message, with the reason**, in the form `determinism.test.ts:551-554` already uses for M1c's single re-bless.

**Three of the four are pure layout tripwires for every task after Task 2, and this is worth knowing because it makes them sharper than the loop golden.** `determinism.test.ts`'s fixture places no building and therefore has no car (`:556-566`); `rollback.test.ts`'s road-network fixture never calls `step` at all; `startingCity.test.ts`'s golden is taken immediately after `seedStartingCity`, before any tick. **None of them can move for a behavioural reason in this milestone.** After Task 2 re-blesses them, any movement in those three before Task 5 means the buffer shape changed when nobody said it would.

**This milestone also *adds* two goldens, which is not the same thing as moving one.** Task 6 blesses a new same-direction queue fixture and Task 7 a new multiplier fixture, both **after** the last buffer change, so neither is ever re-blessed. That ordering is why the ghost regions land in Task 5 rather than at the end: a golden blessed before a region is added would have to be re-blessed with it, and a re-bless of a brand-new number is indistinguishable from getting it wrong the first time.

**The field golden `252514232` must not move in any task.** It is `foldedFieldsHash` over `dist`/`dir`, which live outside the buffer. If it moves, a lane-speed multiplier has leaked into `edgeCost`, or occupancy has been classified FIELD_INPUT. Stop and report.

---

## Task 1: The inherited structural items

**Files:** `packages/sim/src/roads.ts`, `cars.ts`, `dispatch.ts`, `step.ts`, `packages/game/test/allocation.test.ts`, and their tests.

Do these first, before any blocking logic touches the same files. **This task adds no region and moves no golden.**

**1a. Consolidate `stepCell` into `roads.ts`.** Two copies — private at `cars.ts:155`, exported at `dispatch.ts:324`. `roads.ts` already owns `OPPOSITE`, `dirBetween` and `inBounds`, and is about to own `LANE_OF_DIR` too. M1c ruled to keep the duplication and paid for it: `cars.ts`'s copy had four dedicated tests and **`dispatch.ts`'s had zero, with all four bounds surviving** — the copy that got tested was not the copy dispatch used. Fold both in before adding a third caller.

**1b. Fix `canPlaceRoad`'s ~40 B per call.** Measured by the harness once M2 widened it to `sim`. **Its allowance (`allocation.test.ts:895-942`) asserts the allocation is still *present*, so this fix turns that test red — that is the signal to delete the allowance**, not to loosen it. The invariant is per call, not per frame: a per-frame figure encodes the driver's input density and moves ~2× between rigs.

**1c. Record the two 0-detector phase transpositions; do not manufacture a detector for them.** `step.ts`'s `1↔2` and `2↔3` are inert for exactly one reason: no `TickAction` reads `H_TICK`. The first revision of this plan said "pin them now, before that happens" — **but M1d adds no `TickAction` and no clock-reading action, so the trigger does not fire and no test that could fail exists to be written.** Demanding one here would be demanding a test that cannot exist, which this project has a catalogue entry about. What this task owns instead: confirm by reading that the action set is still `place`/`erase` and that `roads.ts` reads neither `H_TICK` nor `H_WEEK`, and record in `step.ts`'s comment that M1d checked the trigger and it did not fire. **The re-measurement of all 13 reorderings belongs in Task 9**, after M1d's branches exist — measuring 0-detector-ness before the new code lands says nothing about after.

**1d. The `Uint8Array` decrement guard is a standing obligation with a named recipient.** An unguarded `--` at 0 on a `Uint8` wraps to 255, and for `destPins`/`destReserved` that excludes a destination from dispatch **forever**, because the counter can never exceed 255. Both existing arms are already guarded and already unit-tested, and this milestone's queueing adds no decrement to them. **The one genuine new decrement path in M1d is Task 5's `ghostCommitted`**, and it carries this guard by name. At the end of the milestone, Task 9 verifies no other new decrement path exists.

**Coverage required:** both former `stepCell` call sites use the shared one; all four `stepCell` bounds are independently detected by **direct** calls; the three caller-observable bounds (`x < 0`, `x >= w`, `y >= h`) are additionally detected **through each caller**; `y < 0` carries a source comment recording it as a **verified equivalent mutant through either caller** — with the `x` guards retained, any `y ≤ −1` gives `y*w + x ≤ −1`, and both callers reduce every negative to one observable (`cars.ts` throws without interpolating `next`; `dispatch.ts:504-505` breaks). Re-verified exhaustively: 1,600 geometries × all in-range cells × Int32 extremes × 8 directions gave 97,040 raw return-value differences and **0** differences in the sign. **Do not manufacture a detector for it, and in particular do not tighten either caller's `next < 0` to `next === -1`** — that satisfies the bullet by strictly weakening two guards this milestone is about to hand a third caller. Also: `canPlaceRoad` is absent from an idle profile and from a dragging profile.

**Mutations:** revert each `stepCell` bound directly; revert the three caller-observable bounds from each caller; reintroduce the `canPlaceRoad` allocation.

---

## Task 2: Occupancy — the lane rule, the region list, and the claim/release lifecycle

**Files:** `packages/sim/src/blocking.ts` (new), `roads.ts` (`LANE_OF_DIR`), `regions.ts` (**two regions** and their FIELD_IRRELEVANT classifications with dated reasons), `state.ts` (interface, `REGION_FIELD_NAMES`, `viewsOver`, and the creation-time fill), `cars.ts`, `trips.ts`, `packages/sim/test/blocking.test.ts` (new), `regions.test.ts`, `state.test.ts`, `determinism.test.ts`, `rollback.test.ts`, `loop.test.ts`, `packages/game/test/startingCity.test.ts`, `packages/game/src/main.ts`, `packages/game/src/frame.ts`, `packages/render/src/types.ts`, `packages/render/test/interface.test.ts`.

**This task adds no refusals.** It declares the whole blocking buffer shape and wires claim/release so that occupancy is always correct — and nothing yet reads it to stop a car. That is the point: **the re-bless this task performs is then provably layout-only**, because no car's motion can have changed. Any behavioural literal that moves in this task is a defect in the lifecycle, not a consequence of blocking.

Two regions, per "Why exactly two re-blesses are true": `occupancy` (`Int16Array`, `2 × cells`, slot `cell * 2 + lane`, `FREE = -1`) and `carBlockedTicks` (`Int16Array`, `maxCars`, written by Task 4, declared here). `Int16` for occupancy bounds `maxCars` at 32,767, which `parseMap` does not enforce, so `createState` carries a named assertion for it.

The five lifecycle events of Decision 3 go in `blocking.ts`'s module comment, in full, as the single place the protocol is written down.

**Coverage required.** `LANE_OF_DIR` has exactly 8 entries, each 0 or 1, four of each, and **`LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]` for every `d`** — the one property Decision 1 rests on, asserted over the whole table rather than sampled. A fresh `createState` has every occupancy slot `FREE`, and two fresh states are byte-identical. A car crossing into a cell claims the slot for the direction of that crossing, and the *opposite* lane of the same cell stays `FREE`. A car crossing out releases, and **a car that turns releases the lane it entered by, not the lane it leaves by** — the fixture's route must contain a 90° turn or the two are indistinguishable. Occupancy is released on the same tick the car leaves, not a tick early or late. **`completeTrip` releases the house cell on the same tick, asserted as both of that cell's slots reading `FREE`** — and *not* by "the sibling can then enter", which is unobservable in this task because nothing refuses anything yet; the sibling's freedom is Task 3's bullet. `assertOccupancyConsistent`'s soundness half is a second, independent detector for the same mutation: a slot naming a car that has gone `PHASE_IDLE` is a soundness violation by definition. Two idle cars share their house cell at tick 0 with both its slots `FREE`. A house dispatches both its cars in one tick and neither claims the house cell. A snapshot/restore round-trips occupancy byte-for-byte. **`assertOccupancyConsistent`** — in the house style of `assertSymmetric` / `assertArrivalHonoured`, called from every blocking fixture and from Task 9's long run — with its two halves separately named: **soundness** (every slot naming a car names one that is OUTBOUND or RETURNING and standing on that cell) asserted unconditionally, and **completeness** (every car that has crossed at least once on its current leg is named by one of its cell's two slots) asserted with its exception set spelled out. **`scratch.counters[CT_REBUILDS]` does not move on a tick where a car crosses a cell but no road is placed or erased and no pin spawns or is consumed** — no existing `CT_REBUILDS` fixture has a car in it (`step.test.ts:195`, `:210` are car-free), so this is new coverage, not a restatement.

**Vacuity self-checks:** the turn fixture must actually turn, and the two lanes it touches must differ, or "release the outgoing lane" is an equivalent mutant. The completeness assertion must be run on a fixture where at least one car has crossed, or it holds over an empty set.

**Goldens:** the four whole-buffer goldens move here, once, for layout. **Every behavioural literal in `loop.test.ts` must be unchanged** — the four observation arrays, the `scoreAfterTick` ladder, `H_SCORE`, the mid-flight `carPhase[1]`, the idle-hygiene count. If one of them moves, the lifecycle is writing something it should not; stop and report. The field golden must not move.

**Mutations:** zero-fill occupancy instead of `-1`-filling it; release unconditionally (drop the `occ[slot] === i` guard); release the lane derived from the outgoing direction; skip the release in `completeTrip`; claim on dispatch as well; make an idle car claim; swap two rows of `LANE_OF_DIR` so some direction shares a lane with its opposite; classify either new region FIELD_INPUT and hash it — `CT_REBUILDS` must then rise on ticks with no road or pin change.

---

## Task 3: The blocking primitive — `canEnter`, refusal, held progress

**Files:** `packages/sim/src/blocking.ts`, `cars.ts`, `packages/sim/test/blocking.test.ts`, `cars.test.ts`, `packages/game/test/resolve.test.ts`, `packages/game/test/integration.test.ts`.

`canEnter(state, world, i, cell, dir)` returns the outcome codes of Decision 8. Two of the four are declared here and wired later — `ENTER_VALVE` in Task 4, `REFUSED_GHOST` in Task 5 — and until then `canEnter` can only return the other two. Declare the whole enum now anyway, so no task widens a return type that a caller is already switching on. `advanceCar` consults it at the crossing and, on refusal, writes nothing at all.

Queueing is not implemented — it **emerges**. Give-way in the head-on sense is not implemented either, and does not need to be: Decision 1 makes it structural.

**Coverage required:** a car entering a free slot succeeds; the same car entering an occupied slot gets `REFUSED_OCCUPIED` and does not move; **a returning car and an outbound car meeting head-on on a one-wide corridor both continue with hand-computed arrival ticks and neither is ever refused** — assert the outcome code, not merely that they moved, and assert `carBlockedTicks` stays 0 for both; the same at a dead-end carpark, with a car flipping to RETURNING on carpark cell K and a queued car on K−1; three cars behind a blocked leader form a queue and each advances in order when it clears, with hand-computed ticks; the blocked car's `carProgress` is **bit-identical on every blocked tick** to its value on the tick the block began, and it advances exactly one cell on the tick the way clears, not two; a blocked car's resolved render position (`resolve.ts`) stays strictly inside its own cell, `f < 1`; two cars contending for one slot resolve in ascending index and the loser is unmoved; two cars dispatched from one house in one tick queue at the **first crossing**, and the second's refusal names `REFUSED_OCCUPIED`; **a car completing a trip frees its own front door — its sibling's later return enters the house cell with `ENTER_FREE` and is never refused**, which is the observer Task 2's direct slot assertion could not have (C6's modal failure: without the `completeTrip` release the sibling stalls the full valve on every return leg); a car blocked at a carpark still holds its pin.

**The carpark pin bullet holds by construction, and that is the finding, not the test.** Arrival is cursor-driven (`runArrivals` gates on `cursor >= carRouteLen`) and `carRouteCursor` advances only inside `advanceCar` on an actual crossing, so a blocked car cannot consume a pin without new code being written to let it. Say so in the source. Record "consume the pin on block" as a **hand-applied** mutation with its named observers: it breaks `sum(destReserved) === count(PHASE_OUTBOUND)`, and the next car's `assertArrivalHonoured` throws by name.

**Vacuity self-checks:** the queue fixture's cars must be genuinely blocked by each other and not by geometry — assert the leader is blocked and the followers' refusals name the car in front. The head-on fixture must actually place both cars on the shared cell simultaneously; assert the co-location, or it proves only that nothing happened.

**Goldens:** **none may move.** Derived: `determinism.test.ts` and `rollback.test.ts` have no cars, `startingCity.test.ts`'s golden is pre-tick, and the loop fixture contains exactly one shared-cell event and zero refusals — **that derivation is written out in full in Task 6 and is available to you now; read it before you start.** If a golden moves here, the derivation is wrong. Stop and report, and fix the derivation rather than the number.

**Mutations:** return `ENTER_FREE` unconditionally; check the opposite lane; check the lane of the *current* cell rather than the one being entered; accumulate progress while blocked; write `carProgress = threshold` while blocked (the render position must then leave its cell); resolve contention in descending index; let a blocked car skip a cell when the way clears.

---

## Task 4: The anti-deadlock valve

**Files:** `packages/sim/src/blocking.ts`, `cars.ts`, `packages/shared/src/constants.ts`, `packages/sim/test/blocking.test.ts`, `packages/shared/test/constants.test.ts`.

`MAX_BLOCKED_TICKS = 45 * TICKS_PER_SECOND` lives in `packages/shared/src/constants.ts` with the other rule constants, **derived rather than written as a literal**. The counter region was declared in Task 2; this task gives it semantics: increment on a refused entry, **saturate** at the threshold, reset to 0 on any successful entry **including the valve's own**. `canEnter` returns `ENTER_VALVE` when a `REFUSED_OCCUPIED` meets a saturated counter. The valve releases **only** a `REFUSED_OCCUPIED`; Task 5 adds the second refusal and the rule that the valve does not release it.

**Coverage required:** the valve fires at exactly blocked tick 1,350 and not 1,349, and the outcome code says `ENTER_VALVE` rather than `ENTER_FREE`; a gridlocked ring of four cars — same-lane blocked, hand-built so that each is blocked by the next — all eventually move and none starves; **the occupancy array's contents are asserted on the valve tick and on each subsequent departure from the shared cell**, not merely that two cars have equal `carCell`; `assertOccupancyConsistent`'s soundness half holds across the valve firing and every tick after it; two cars sharing a cell after the valve is asserted as **reachable**; the counter **saturates** rather than growing, so no width question can arise; the counter is hashed state — a snapshot taken mid-jam and restored produces byte-identical subsequent behaviour **and the valve fires at the same absolute tick in the restored run as in the uninterrupted one**, built with `fields` and `scratch` cold-rebuilt on the restore as `loop.test.ts:660` does, since that is what a Worker cold-starting a replay holds; `sum(destReserved) === count(PHASE_OUTBOUND)` holds throughout the jam.

**Vacuity self-checks:** the ring must genuinely deadlock without the valve — **assert that by running it to blocked tick 1,349 and observing no movement**, which is the no-valve world by construction and needs no test-only disable seam. And assert the ring's four blocks are **same-lane**: a ring built with a head-on pair in it resolves by Decision 1 and proves nothing.

**Goldens:** none may move. The loop fixture never reaches a blocked tick at all, per the derivation written out in Task 6.

**Mutations:** valve at 1,349 / 1,351; valve never fires; put the counter on `Scratch` (the restored-run arm must then diverge); **lower the saturation ceiling to 255** — the behavioural form of "make the counter `Uint8`", which must be mutated this way rather than by editing `regionsFor`, since changing the element type moves `totalBytes` and the mutant is then killed by the layout goldens without the valve ever being consulted; never reset it on a successful entry; release unconditionally on the four-car ring — the consistency assertion must fire.

---

## Task 5: Delayed refunds and ghost roads

**Files:** `packages/sim/src/roads.ts`, `blocking.ts`, `cars.ts`, `trips.ts`, `regions.ts` (**two regions**), `state.ts`, `dispatch.ts` (the committed-car walk at erase time), and their tests, plus every golden site listed in "Why exactly two re-blesses are true".

Decision 8 in full. `eraseRoad` keeps its shape: it still clears both mirrored bits and still computes the refund per endpoint whose mask becomes 0. What changes is that a refund due for a cell with at least one committed car is **deferred**, the cell's last bit moves to `ghostMask`, and `ghostCommitted` is counted (and **recounted from scratch** on any later erase that re-ghosts the same cell — the currently-committed set is exactly the set that must clear).

**This task contradicts a pinned existing test, deliberately, and must say so at the site.** `packages/sim/test/cars.test.ts:586-628` asserts that erasing under an in-flight car refunds **immediately** (`tilesLeft(state) === 991` on the erase tick) — M1c's stated deviation, whose own comment says "deferred to M1d". Rewrite it, and repoint the doc comments at `cars.ts:29-33` and `roads.ts:65-69` that describe the deviation as outstanding.

**Coverage required:** erasing a road with **no committed car** refunds immediately, exactly as today; erasing a road whose cell is on a committed car's remaining route refunds **on the tick that car crosses off the cell**, not before and not later — build the fixture with the car **several cells short** of the erase, so an occupancy-keyed implementation refunds early and fails; a ghost with **two** committed cars refunds on the second one's departure, with the two clearing on **different** ticks; a committed car traverses the ghost and `canEnter` says `ENTER_FREE`, while a hand-built non-committed car gets `REFUSED_GHOST` (the production-unreachable branch, exercised directly and labelled as such); **no route committed after the erase contains the ghost cell** — assert `dist[ghostCell] === INF`; **placing a road over a ghost cell pays the pending refund and charges the placement**, so `H_TILES` after erase → replace → the committed cars clearing equals its value before the erase, and the road is live; the tile budget is exactly restored, never double-refunded and never lost, across a repeated erase/re-place cycle; a trip ending on a ghost cell decrements it; `ghostCommitted`'s decrement at 0 throws rather than wrapping; ghosts survive snapshot/restore.

**Vacuity self-checks:** the two-car ghost fixture's cars must clear on different ticks, or "refund on the first departure" passes. The committed-car fixture must have at least one *non*-committed in-flight car on the board at erase time, or "count every in-flight car" is an equivalent mutant. The erase/re-place cycle must be run more than once, or "print one tile per cycle" is indistinguishable from an off-by-one.

**Goldens:** the four whole-buffer goldens move here, for layout, for the second and last time. The field golden must not move: `eraseRoad` already writes `roads`, which is already FIELD_INPUT, so the field's view of the world is unchanged by the two new regions — which is also why both are FIELD_IRRELEVANT (Decision 4), and `ghostCommitted` especially so, since it changes on car crossings.

**Mutations:** key the refund on occupancy rather than the committed count; refund immediately regardless; refund twice; never refund; let a re-place cancel the refund instead of paying it (the player must then be visibly charged twice); let a re-place refund *and* charge nothing; forget to clear `ghostMask` after refunding; count every in-flight car rather than the committed ones; decrement `ghostCommitted` at 0; **let the valve release a `REFUSED_GHOST`** — a car driving onto a road that no longer exists because it waited long enough; classify either ghost region FIELD_INPUT and hash it.

---

## Task 6: The loop fixture, re-derived — and a blocking golden of its own

**Files:** `packages/sim/test/loop.test.ts`.

The M1c loop fixture is the project's flagship integration fixture and every literal in it is hand-computed: a single one-wide corridor on row 5 of a 20×12 board (cells 102..116) with both houses and both carparks standing on it. **The first revision of this plan killed it** — under one undirected slot per cell, car 0 returning east and car 1 heading west deadlock at cell 113 on tick 73, the valve does not fire until tick 1,423 against `RUN_TICKS = 150`, and the four observation arrays, the `scoreAfterTick` ladder, the not-nearest-house test, the mid-flight `carPhase[1]` assertion, the idle-hygiene count and the golden all become physically unachievable.

**Under Decision 1 that deadlock does not exist, and this task's job is to prove it rather than assume it.** The derivation, from the fixture's own `rel_k = ceil(k·2500/330)` = 8, 16, 23, 31, 38, 46, 54, 61, 69, 76, 84, 91 and `abs = dispatchTick + rel_k − 1` — every value recomputed here:

| car | leg | cell entered @ tick |
|---|---|---|
| 0 (H0 116, dispatched 2) | out, 6 W steps | 115@9, 114@17, 113@24, 112@32, 111@39, 110@47 |
| 0 | return, E | 111@55, 112@62, 113@70, 114@77, 115@85, 116@92 (score) |
| 1 (H0 116, dispatched 51) | out, W | 115@58, 114@66, 113@73, 112@81, 111@88, 110@96 |
| 1 | return, E | 111@104, 112@111, 113@119, 114@126, 115@134, 116@141 (score) |
| 2 (H1 105, dispatched 2) | out, 3 W steps | 104@9, 103@17, 102@24; return 103@32, 104@39, 105@47 (score) |
| 2 (dispatched 51) | out | 104@58, 103@66, 102@73; return 103@81, 104@88, 105@96 (score) |
| 3 | never dispatched | idle on 105 throughout |

A car holds a cell from the tick it enters it until the tick it enters the next. Intersecting those intervals pairwise over the whole 150-tick run gives **exactly one shared-cell event: cell 113, ticks 73 to 76 inclusive.** Car 0 holds it eastbound (lane 0) from tick 70; car 1 enters it westbound (lane 1) at tick 73. Different lanes, so car 1 is granted, and at tick 77 car 0 enters 114 — which car 1 released at tick 73. Every other pair of intervals on cells 110–116 is disjoint, cars 2 and 3 never leave 102–105, and the two ranges do not meet. **Zero refusals, zero valve ticks, and no literal in the file moves.**

**So this is not a repair. It is a re-derivation plus the two things the fixture is now missing:**

1. **The head-on crossing is now the fixture's single most valuable property and it is currently unasserted.** Assert it directly: cars 0 and 1 are both on cell 113 on tick 73, in opposite lanes, and neither is ever refused. A future change back to one slot per cell would stall this pair for 1,350 ticks, and without this assertion the only signal would be a moved golden — which is exactly the signal a standing re-bless licence absorbs.
2. **The fixture contains no same-direction block, so it exercises the new primitive only in the negative.** Add a **second fixture in the same file with its own golden** — a same-direction queue that genuinely blocks — rather than editing this one. Editing the corridor to force a block would retire the four-route cost matrix the file's leading vacuity test exists to protect (`cost(H1,d1) < cost(H1,d2) < cost(H0,d2) < cost(H0,d1)`, with the nearer house at the higher index) and would move the loop golden for a third time.

**Coverage required:** the `rel_k` timeline above is re-derived in the file's module comment and every existing literal is shown to follow from it unchanged; the cell-113 co-location is asserted, with the lane of each car named; `carBlockedTicks` is 0 for every car at every tick of the run; the not-nearest-house property (`:470-490`) still runs to a scored return; a car is still mid-flight at the golden tick (car 1 is on cell 114 at tick 130 — recomputed); the new queue fixture blocks at least one car for at least one tick, with a hand-computed arrival ladder and its own golden; the new fixture's blocks are **same-direction**, asserted, so it is not silently exercising the head-on path instead.

**Vacuity self-check:** if the new fixture never actually refuses an entry it has gained nothing — assert a non-zero `REFUSED_OCCUPIED` count, not merely that arrival ticks differ from an unblocked run.

**Goldens:** the loop golden **must not move** — it was re-blessed for layout in Tasks 2 and 5, both buffer changes are behind us, and this task changes no behaviour in that fixture. The new fixture's golden is blessed here for the first time; state that it is a new number, not a re-bless. No other golden moves.

---

## Task 7: Lane-speed multipliers

**Files:** `packages/sim/src/cars.ts`, `graph.ts`, `packages/shared/src/constants.ts` (comments only), `packages/sim/test/cars.test.ts`, `graph.test.ts`.

Decision 7 in full: 45° none, 90° 667, 135° 333, degree ≥ 3 on the cell being entered 500, averaged where two apply, truncating, turn angle computed within a leg only, 180° asserted unreachable. `graph.ts` gains one read-only degree helper and nothing else.

**Build the multipliers their own fixture** — a route with a right-angle turn, a 135° turn, a degree-≥3 junction, and one cell that is both a turn and a junction — with hand-computed arrival ticks from the table in Decision 7, and give it a **new golden of its own**.

**The loop fixture is not that fixture, and the first revision's claim that "the loop golden must therefore move" was false.** Confirmed by execution: on that board, cell 102 has mask 4 (degree 1), cells 103–115 have mask 68 = E|W (degree 2), cell 116 has mask 64 (degree 1) — **no cell of degree ≥ 3 exists**; and every consecutive step of all three committed routes is the same direction — **no 90° and no 135° turn anywhere.** Plain-cell speed stays `speedUnits(1000) = 330`. **This task must not move any golden.** If one moves, a multiplier is being applied where no turn or junction exists, or it has leaked into `edgeCost`.

**Coverage required:** each multiplier applied alone changes the arrival tick by the hand-computed amount (12, 16, 23 ticks for the first orthogonal crossing at 220/165/109 against 8 at 330); a cell that is both a right angle and a junction gives **192**, and the same cell under "take the minimum" would give 165 — a 14-tick vs 16-tick first crossing; the sharp-turn-at-a-junction case gives **137** against a minimum's 109, 19 ticks vs 23; the 180° assertion fires when called directly; `edgeCost`'s value set is still `{10, 14}`, which `NB`, `DISTINCT_EDGE_COSTS`, `COST_UNIT_SCALE` and `CAR_SPEED_UNITS_PER_TICK` are jointly calibrated against (`constants.ts:166-169`); **the field golden `252514232` does not move** — multipliers scale `speedUnits` into `advanceCar` and never `edgeCost`, so routing is untouched; a straight run through a plain degree-2 cell is unchanged from M1c's timings.

**Two things this task must state rather than test.** The **rounding direction of the multiplier average is a provable equivalent mutant** over both reachable averages at this constant set — 583/584 both give 192, 416/417 both give 137 — so fix it, label it inert, and record that it stops being inert the moment a multiplier or `CAR_SPEED_UNITS_PER_TICK` changes. And `speedUnits`'s own truncation is **already** killed by `cars.test.ts`'s literal table (333 → 109, not 110); do not re-test it and call it new coverage.

**Vacuity self-check:** the multiplier fixture's junction must be the cell the car *enters*, not the one it leaves, or "apply the intersection multiplier to the cell being left" survives. Place the junction and the turn on **different** cells for the single-multiplier cases, or the two cannot be separated.

**Mutations:** take the minimum instead of the average; apply the intersection multiplier to a non-intersection; apply it to the cell being left; classify 45° as a right angle; classify 135° as 90°; drop the `max(1, …)` clamp; apply a multiplier inside `edgeCost` — the field golden must then move.

---

## Task 8: Rendering ghosts

**Files:** `packages/render/src/canvas.ts`, `atlas.ts`, `types.ts`, `palette.ts`, `packages/game/src/frame.ts`, `packages/game/test/drawAllocation.test.ts`, and their tests.

`RenderFrame` gains a per-cell ghost mask, folded from `state.ghostMask` alongside `frame.roads`. **Queued cars need no new rendering** — Decision 5 keeps a blocked car's `f < 1`, so it stays inside its own cell and `resolve.ts` is untouched. Cars in opposite lanes still draw on the centreline; that is the deferral named in the Out table, and this task must not quietly half-implement it.

**The ghost is a second atlas, not a per-frame context change.** `canvas.ts:492` blits one pre-rendered tile per mask, so "thinner and lower-opacity" is a property of a surface, not of a draw call: build a second 256-tile atlas at boot with a smaller stroke fraction and a faded stroke colour. Both properties are then independently assertable against the recorded atlas-build commands, no per-frame `globalAlpha` juggling exists to leak, and the ghost pass is one more `drawImage` per ghost cell. A boolean flag could not do this at all — mask 0 is never blitted, and a ghost cell is by definition one whose live mask reached 0.

**Coverage required:** a ghost cell draws at reduced opacity **and** a thinner stroke than a live road, asserted as two independent properties against recorded state; the ghost stroke is derived from `ghostMask`, so a ghost of a diagonal segment draws diagonally; a live road adjacent to a ghost is unaffected; the ghost layer respects the revealed rect **in both directions** — content at the far edge is drawn and content outside is not, with each out-of-rect marker placed past **exactly one** bound and exactly one cell past it; the ghost pass is profiled by **`drawAllocation.test.ts`**, whose driver must contain at least one ghost cell **for the profiled frames**, asserted non-zero alongside its existing road/car/pin counts — a ghost is transient, so the driver has to hold one across the window, e.g. by re-erasing under a blocked car.

**Vacuity self-check:** `drawAllocation.test.ts`'s driver is a fixed 4-cell road with 6 cars and 3 pins, count-asserted at `:283-308`, and contains no ghost cell today. Without a ghost count the budget is vacuous for this task, and injecting an allocation into the ghost pass leaves it green — which reads as an inert harness. There is already a home for the count and it is currently dead: the driver builds a `{ blits, cars, pins, clockTexts }` object (`:198`, `:210`), returns it (`:247`), and **no test ever reads it** — the vacuity block derives its numbers from `game.state` and `frame` instead. Add a `ghostBlits` field and assert it, and either assert the other four or delete them; instrumentation nothing reads is the same defect class as an assertion that cannot fail.

**Goldens:** none. `render` and the draw path are outside the state buffer.

**Mutations:** draw ghosts at full opacity; at full width; from a boolean rather than the mask; skip the ghost pass; shrink the far bound of the ghost loop.

---

## Task 9: Integration, the tick-side allocation profile, the comment sweep, deploy

**Files:** `packages/sim/test/loop.test.ts`, `packages/game/test/integration.test.ts`, `packages/game/test/allocation.test.ts`, `packages/sim/src/step.ts`, the comment-sweep sites below, `docs/superpowers/m1e-carry-forward.md`, and the deploy.

**The end-to-end test must show a jam**, not merely that cars still arrive. Build a bottleneck and **name its geometry in cells, not in "lanes"** — "two-lane" now means one cell with two directional slots, which is not what a throughput test wants. Saturate it and assert throughput falls measurably below the unblocked case with hand-computed figures. **The comparison is against the hand-computed unblocked figure named in the same clause, not against a recorded run of a fixture that does not exist.** Guard it against degenerating: cars dispatched > 0, at least one car blocked for ≥ 10 consecutive ticks, at least one queue of ≥ 3, and total trips strictly below the hand-computed unblocked figure.

**Tick-side allocation profile.** `m1d-carry-forward.md:57` instructs this in as many words — *"use it for the tick as well as the frame"* — and it is the last unowned item. It is not optional polish: the shipped rig in `allocation.test.ts` **never moves a car**. Measured over 1,752 ticks, all six live cars stay `PHASE_IDLE` — the pointer stroke paints in the revealed rect's top-left corner and never connects a house to a destination, and the 30-tile budget is spent within the first few strokes so every later `place` is refused (which is exactly why `canPlaceRoad` shows up while nothing downstream of it does). So **every branch this milestone adds is currently profiled at zero executions and measures clean regardless of what it does**, and `assertScopeResolves(all, SIM_SRC)` returns `[]` vacuously. Profile `step` directly over the jam fixture with `SIM_SRC` scope, using hand-placed roads rather than pointer strokes so the network actually connects, and gate it on **per-branch entry counters asserted non-zero** in the style of the existing `DragCounters`: cars dispatched, `canEnter` calls, `REFUSED_OCCUPIED` returns, `ENTER_VALVE` returns, ghost cells present, cells with a queue ≥ 3. A fixture that stops jamming must turn the harness **red**, not quietly measure less. Include a positive control: reinstate one escaping object inside the blocking path and confirm it appears by name.

**Long-run:** ≥ 20,000 ticks with a deliberately bad network. Assert no car starves, `assertOccupancyConsistent`'s soundness half every tick, `sum(destReserved) === count(PHASE_OUTBOUND)` every tick, no counter wraps, and two identical runs agree on `hashState`.

**Re-measure the tick order now that the branches exist.** Task 1c recorded that `1↔2` and `2↔3` were still inert *before* M1d's code landed, which says nothing about after. Re-run all 13 reorderings against the finished milestone and record the result in `step.ts`. Note one that has already changed in kind: `trips.ts:33` predicted that moving arrivals before movement *"would leave a logically-finished car occupying a chunk for a tick"* — that prediction is now true rather than hypothetical, and the comment should say so.

**The comment sweep, and it has two halves.** A comment that names a milestone which passed is worse than no comment — it reads as satisfied. That is how the bot URL went stale.

- **Repoint to M1e** the board-expansion handoff M1d declines, in **eight files**: `packages/shared/src/constants.ts:72,75`, `packages/shared/src/mapFormat.ts:21`, `packages/shared/src/maps/firstCity.ts:9`, `packages/render/src/types.ts:124`, `packages/render/src/canvas.ts:321,344,557`, `packages/game/src/shell.ts:173`, `packages/shared/test/constants.test.ts:102`, `packages/game/test/frame.test.ts:207,210,237,242`. Also repoint the motorway/third-edge-cost-tier predictions this plan defers: `packages/sim/src/scratch.ts:27,47,122`, `packages/shared/src/constants.ts:167`, `packages/sim/test/flowfield.test.ts:532`.
- **Mark satisfied** the M1d-tagged comments this milestone actually discharged: `packages/sim/src/dispatch.ts:321` (Task 1a), `packages/game/test/allocation.test.ts:274,287,293,895,906,938,942` (Task 1b — the allowance should be gone entirely), `packages/sim/src/cars.ts:255` and `dispatch.ts:571` (Task 3), `packages/sim/src/cars.ts:97,187` and `packages/sim/test/cars.test.ts:195` (Task 7), `packages/sim/src/cars.ts:33` (Task 5), `packages/game/test/resolve.test.ts:341` (Task 3).
- Verify no new `Uint8Array` decrement path exists beyond `ghostCommitted` (Task 1d's standing obligation).

**Write `docs/superpowers/m1e-carry-forward.md`.** Nothing else does, and it has never been owned by a task — it got written at every prior milestone close anyway, which is a base rate, not a mechanism. Everything in "What this plan does not settle", both re-bless records, the board-expansion deferral, the lane-drawing deferral, the two labelled-inert equivalent mutants, and M3's compression re-measurement reach M1e only through it.

**Deploy:** verify the artifact, not the exit message — fetch the served bundle and grep a build-unique token, in both the HTML meta tag and the module script name, with both halves proven able to fail. **The Telegram Mini App URL is not settable through the Bot API** when the bot is configured via @BotFather; if the URL changes, that is a human action.

---

## What this plan does not settle

- **Whether one car per lane-tile feels right.** It is half the spec's density, on the spec's own two-lane road. M1e's tuning is the first real evidence, and changing it is a change, not a constant.
- **Whether 1,350 ticks is the right valve.** It is the spec's 45 s at 30 Hz, unvalidated in play — and under two lanes it now fires far less often than the first revision assumed, which means play has even less evidence about it than before.
- **Intersection crossing conflicts.** Two cars in opposite lanes may occupy one junction cell and cross paths inside it. That is the spec's model until traffic lights and roundabouts exist.
- **Frame cost under a full jam.** M2's only device evidence is qualitative, from a near-empty board. A hundred queued cars is the first workload whose cost scales with traffic — and the state buffer is now 75 % larger, which touches `hashState`, `snapshot` and every rollback.
- **Whether the shipped starting city ever jams.** Measured on today's board: 45,000 ticks over a 14-segment column-8 road gave `maxActive = 1` and zero adjacent-opposing events — utilisation is about 20 % with six cars and no spawner. That is "head-on is not yet visible on the seeded board", not "head-on is not a problem". It changes the day M1e's demand ramp lands.
