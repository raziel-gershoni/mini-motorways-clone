# M1f: the junction costs something, and a card fixes it — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a junction cost something a player can see — two cars may no longer cross inside one cell — and then give the player the one thing that fixes it: a weekly choice between road tiles and a roundabout they place themselves.

**Architecture:** One new rule in `canEnter` (a junction cell admits one car at a time), one new `step` phase (**the offer**, inserted at position 4, renumbering the old 4–10 to 5–11), one new `TickAction` kind per player decision (`choose-card`, `roundabout`), four new header slots, one new `Uint8` per-cell region (`roundabout`), and a full-screen modal in `render` that the shell pauses behind. Routing does not change and must not: §5.4's *"model intersection penalties as extra integer edge weight"* is **refused by amendment** in Task 1, because a junction that repels traffic is a junction the player never feels.

**Tech Stack:** TypeScript, pnpm workspaces, zero runtime dependencies, integer-only in `sim`, Vitest, Canvas2D, Cloudflare Workers.

---

## Read this paragraph before Task 1, because it is the milestone's honest shape

**The tick order is renumbered.** `step` runs ten phases today. Task 5 inserts the **offer** phase at position **4**, so the old phase 4 (spawn) becomes 5, 5 (demand) becomes 6, 6 (sources + sync) becomes 7, 7 (dispatch) becomes 8, 8 (movement) becomes 9, 9 (arrivals) becomes 10 and 10 (overcrowd) becomes 11. **Every phase number written anywhere in `packages/` and in every doc under `docs/superpowers/` that names a phase above 3 is wrong from Task 5 onward**, and Task 5 owns re-pointing all of them. The equivalent-mutant register's one surviving 0-detector row, `4 <-> 5` (spawn against demand), becomes **`5 <-> 6`** and must be re-run under its new name; a plan or report that quotes `4 <-> 5` after Task 5 is quoting a pair that no longer means what it meant.

**M1f changes nothing observable before minute seven, and that is by construction rather than by luck.** Task 2's junction rule is bit-identical to today's sim until **tick 12,780 (6:57 on a stopwatch)** on the shipped board under the greedy connect-on-sight arm, because that is the first tick on which two cars are ever co-present on one junction cell. Every minute-three figure this project owns is therefore unchanged **by construction**: 0.602 cars in flight, 0 blocked ticks, longest queue 1. Nobody should open the app after Task 2 expecting to see a difference in the first six minutes, and nobody should file its absence as a regression. What changes at 6:57 is that cars begin to queue at five specific cells; what changes at minute ten is that the player is handed a card.

**The milestone's honest acceptance criterion, and the only one that matters:** *a person who was never told where to look sees cars queue at a specific corner around minute seven, and at minute ten chooses where a roundabout goes, with a measurable difference between a good and a bad placement.*

---

## Global Constraints

Every task's requirements implicitly include this section.

- **`sim` is integer-only, allocation-free, and deterministic.** One `ArrayBuffer`; struct-of-arrays typed-array views; seeded mulberry32 held **inside** `GameState`; `hashState` is FNV-1a over the whole buffer. **Browser and Cloudflare Worker replay of identical inputs must produce BYTE-IDENTICAL state.** No `Math.random`, no `Date`, no transcendentals, no float literals, no module-scope mutable state, no iteration over `Map`/`Set`/object keys for anything sim-affecting. `packages/sim/test/determinism.test.ts`'s file list is exhaustive: **a new file in `sim/src` must be added to it in the same commit**, or it skips every rule.
- **Rule constants are integer numerators over a denominator of `DENOM` = 1000**, converted only in `packages/shared/src/constants.ts`.
- **Index conventions, now four.** `cell = y * w + x`; `occupancySlot = cell * LANE_COUNT + lane`; `zoneIndex = zy * spawnZoneW + zx` (spawn.ts only); and **new in M1f**, the roundabout block's nine cells, which are addressed only through `roundaboutCellAt(centre, k, w)` for `k` in `[0, 9)` and never by open-coded arithmetic.
- **Zero allocations per tick and per frame.** Three harnesses, and confusing them is a recurring defect: `packages/game/test/allocation.test.ts` profiles `packages/game/src` **and** `packages/sim/src` and measures **the tick**; `packages/game/test/drawAllocation.test.ts` profiles `packages/render/src` and measures **the frame** (it flakes roughly 1 run in 10 — re-run before recording a kill from it); `packages/game/test/demoAllocation.test.ts` profiles all three on the demo board. `NOISE_FLOOR_BYTES_PER_FRAME` is 4. **A green harness is a claim about the inputs it was given** — prove liveness by injecting into the **new** code, and make the injected object escape (`(globalThis as any).__sink = {…}`), never `void __sink`.
- **Every window that profiles or measures a live sim states its end tick and its margin to game over**, and asserts `expect(isGameOver(state)).toBe(false)` after its final drive. Task 2 and Task 3 move both shipped boards' death ticks; every such window must be re-derived against the moved value, not against `deathTicks.ts` as it reads today.
- **`packages/render` imports NOTHING from `packages/sim`.** Enforced by a source scan whose one real catch is a raw relative path. Every new field the modal needs arrives on `RenderFrame` as a plain number, boolean or raw typed-array view folded by `packages/game`.
- **NINE goldens.** `1058753394` state (`sim/test/determinism.test.ts`), `2312109239` road-network (`sim/test/rollback.test.ts`), `252514232` field (`sim/test/rollback.test.ts`), `1877236894` loop (`sim/test/loop.test.ts`), `968680755` seed (`game/test/startingCity.test.ts` **and** `game/test/demoLayout.test.ts`), `307910575` queue (`sim/test/loop.test.ts`), `1531344761` multipliers (`sim/test/cars.test.ts`), `3152640907` demo (`game/test/demoLayout.test.ts`), `894844668` demand-pin (`sim/test/loop.test.ts`). **Which move, in which task, and why, is tabulated below and nowhere else.** A golden that moves in a task this plan did not name is a stop-the-world event, not a re-bless. **Every re-bless is paired with hand-computed direct assertions on the changed slots in the same commit — a digest is never the only evidence.** Grep the digest; the line numbers in any ledger decay faster than the digests do.
- **Canonical test invocation, and no other:**
  ```
  pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test
  ```
  `pnpm test` bails at the first failing package; `pnpm test --no-bail` crashes vitest; `pnpm --no-bail test` also bails, because the root script is itself recursive.
- **Every task mutation-tests its own tests.** For each behaviour, record the one-line change that makes its test fail. **Every kill must be an ASSERTION FAILURE naming the behaviour, never a `ReferenceError`, `TypeError` or module-load failure.** Screen for crashes on lines that are **not vitest result lines**, and record the matched line so a discard is auditable — a test *name* containing the word `TypeError` has already produced a false positive here, and a false positive silently throws away real coverage evidence. Run the **complement check** too: per-package test totals unchanged under each mutant, or the mutant stopped collection. Anchor every mutation on a line the program runs, never on a comment. **Coverage is keyed to the unit an editor edits** — a line, not an outcome: two `return` statements yielding one outcome are two editable sites and need two detectors.
- **Commit before ANY edit you intend to revert**, whatever its size — a one-line teeth-check probe has the same cleanup step and the same failure mode as a full battery. **The report of a restore must be unreachable when the restore did not run:** chain the `git status --porcelain` check to the restore's own success in one `&&` chain, or make it assert rather than print. Diff your expected file list against `git status` before quoting a green suite; a test count cannot detect deleted assertions inside surviving tests.
- **Never run two implementers at once.** They share the main checkout; only reviewers get worktrees. Before quoting any suite-wide number, check `git status` for strays and source mtimes against your own last write.
- **A single-seed claim smaller than 2× is inside the noise.** Across eight `RUN_SEED` values with nothing else changed, baseline blocked car-ticks span 1,298–42,381 (32.7×), trips 181–1,737 (9.6×) and death tick 16,122–51,275 (3.2×). **The shipped seed `laneways-m2` is an outlier** — the quietest of the eight on blocked car-ticks and one of only two that never fire the valve. Any claim of the form "the board does X" taken on `laneways-m2` alone is a claim about `laneways-m2`, and must say so.
- Do not modify `spike/`.
- Plans do not state expected test counts, and neither do reports.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## The observability contract

M1d shipped correct, tested at 0 Critical, and deployed with the artefact verified byte-for-byte — and the user opened it and said it looked like the same demo. They were right, and every acceptance criterion M1d had was machine-side and satisfiable on a purpose-built fixture.

**So every task in this plan carries an `Observability:` line phrased as what a human will see, on the board that boots by default, at the time that task lands. Where the honest answer is "nothing", the task says so.** Five of the eleven say nothing, and they say it out loud rather than by omission.

**The milestone-level answer.** After M1f, a player opening the plain link sees the same first six minutes they see today. Around **6:57** cars begin to stack up at a handful of specific corners instead of driving through each other — the first traffic jam this game has ever shown on the board that ships. At the **week-1 boundary (2:21)** and every 2:30 after, the board dims and two cards appear: **30 ROAD TILES** or **A ROUNDABOUT + 20 TILES**. Taking the roundabout puts a chip in the HUD; tapping the chip and then the board drops a 3×3 roundabout, which the traffic then flows through instead of stopping at. Put it on the right corner and the run lasts measurably longer; put it on the wrong one and nothing happens at all — and that gap is the milestone.

---

## Scope

**In:** the junction mutual-exclusion rule and its triage; the offer phase; the two-card weekly choice with a non-consuming seeded draw; the `choose-card` input with an echo-checked replay-divergence detector; the pause, the modal, the peek button and the tap arbitration; the roundabout as a placeable 3×3 object with its own inventory chip, placement gesture, ring, speed multiplier and junction exemption; the pool's map-capability filter; the long run, the deploy and the handoff.

**Out, each with a named recipient, because "handed to whoever owns X" is a drop when nobody owns X:**

| Deferred | Owner | Why |
|---|---|---|
| **Traffic lights (§5.6)** | **M1g** | Demand-actuated with hysteresis, amber, right-on-red and an idle-time weight — six constants and a state machine, none of which exists. They are also the change that would make car positions a flow-field input **if** they price waiting as an edge weight, which Task 1 forbids by amendment; the five `regions.ts` FIELD_IRRELEVANT reasons dated *"M1f's demand-actuated lights"* are re-pointed at M1g in Task 1, and three of the five are promoted from prose to a failing assertion in the same task so the re-point is not the only thing holding them. |
| **Motorways, bridges, tunnels (§5.7, §5.1)** | **M1g** | Bridges and tunnels break a named, tested invariant in three places — `assertNoRoadOnImpassable` (`roads.ts`), `placeRoad`'s `world.passable` gate, and `graph.test.ts`'s randomised *"every neighbour has `passable === 1`"* property. The motorway is the one item in §5.10's table that changes `edgeCost`'s **value set** (the ÷3 tier), which re-opens `NB`, `DISTINCT_EDGE_COSTS` and `entryPoolCapacity` together; `scratch.ts`'s penalty-routing note is re-pointed at M1g in Task 1 and its corrected margin is quoted in this plan's trap 2. All four are absent from the offer pool by `CARD_IMPLEMENTED_MASK` (Task 10), not merely unimplemented — an offerable card with no placement mechanism is dead configuration that reads as support. |
| **Deleting a placed roundabout, and the bidirectional inventory (§2.2)** | **M1g** | §2.2's counter is bidirectional — *"deleting a placed item returns it once in-flight traffic clears"*. M1f places and never removes. The reason is the ghost ledger: un-placing means erasing eight ring segments whose cells may hold committed cars, then **un-marking** nine cells while a car is mid-crossing on one of them, which changes that car's speed and its junction rule inside a traversal. That is a new class (a mid-traversal rule change) and it wants its own task. **Consequence, stated so it is not discovered:** a roundabout placed on the wrong cell is permanent for the run. Task 11's device session asks whether that reads as a mistake the player can live with. |
| **Board expansion / a real revealed region (§5.1)** | **M1g** | Declined by M1d, by M1e, and now by M1f, so it is said out loud rather than re-pointed quietly. Unchanged reasons: `MapData` carries no per-week schedule and adding one means folding it into `mapIdHash`, which moves every whole-buffer golden a second time in a milestone that budgets exactly one shape change; `canvas.ts` needs a `clip` around the board phases; `frame.test.ts`'s two fold markers sit in **diagonal corners**, which stops working the moment the fold is 2-D over a dynamic rect — a corner is past two bounds at once, so each of the four half-plane bounds needs its own marker one cell past exactly one of them. **And the reader count is now TWO, not one:** `sim/src/spawn.ts` reads `REVEALED_X0/Y0/W/H` to bound where buildings may appear, so a dynamic rect that only the camera honours would let the spawner place buildings the player cannot see. |
| **Destination removal, and the square→circle upgrade (§5.2)** | **M1g** | Three source sites name removal as the trigger that ends an inert property — `state.ts`'s `houseAt`/`destAt` (a hole marker for a slot mid-prefix), `dispatch.ts`'s colour-order note, and `trips.ts`'s ascending-arrival-order note — plus `game/src/resolve.ts`'s slot-*reuse* class, closed today **only by reachability** because the spawner appends at the next free index. M1f removes no destination and upgrades none, so all four stay inert and all four comments keep their M1g date. The upgrade's price is already derived and carried: a circle takes two rotation slots against a trigger cap only 33 % higher, so on `firstCity` the colour-1 circle dies at **5,580** where the colour-0 square would have died at **6,330** — a difficulty lever with a known sign and a known magnitude, which is why it is worth having and worth doing properly. |
| **The round-robin / nearest-source mismatch (§15.2 of the carry-forward)** | **M1g** | The carry-forward addresses this to M1f in the imperative — *"M1f owns choosing between them"* — and **M1f declines it, deliberately and with a reason, rather than silently.** The three candidate fixes (seed the field only at the most-starved destination; weight sources by `destPins`; route the rotation to the shortest queue) are all changes to §5.3's scheduling rule and to `dispatch.ts`'s Decision 4. Landing one in the same milestone as the junction rule and the roundabout makes **both** unattributable: the scheduler decides whether a *connected* destination lives, the junction rule decides how fast the network drains, and a run that moves under both cannot tell you which. The evidence M1f leaves for it is better than the evidence M1e left: Task 11 measures delivery fraction per week on a board that now has real queues, where M1e could only measure it on a board that had none. `OvercrowdTimerCarArrivalDeceleration` (§15.6) is coupled to this and moves with it — it is measured to widen a destination's survivable arrival interval from 90 ticks to ~300, and measured to be worth **zero ticks** on both shipped boards, because both die at an arrival interval of infinity. |
| **Surfacing or bounding `MAX_PATH_LEN` = 96 (§15.3)** | **M1g** | Also addressed to M1f, also declined with a reason. The HUD gains two surfaces this milestone (the modal and the inventory chip) and a third readout competing with them is scope, not caution. The measurement that makes the deferral safe is on the tree: the longest route ever walked on the shipped seed's greedy arm is **21 steps** against the 96-step ceiling, and setting `MAX_PATH_LEN` to **24** leaves the run behaviourally unchanged — same death tick 31,456, same 747 trips, refusals still 0. **And lowering it is not free even though it changes nothing:** `ROUTE_BYTES = MAX_PATH_LEN / 2` sizes `carRoute`, so 96 → 24 shrinks `firstCity`'s buffer from 13,992 to 11,112 bytes and turns **8 of the 9 goldens** red on a behaviourally identical run. Surfacing costs nothing; changing it costs a nine-site re-bless for no behaviour. |
| **The demand ramp's three numbers, `DESTINATIONS_PER_WEEK`, `HOUSES_PER_DESTINATION`, the pin capacities, one car per lane-tile** | **M1g / tuning** | All shipped and untuned. Do **not** add a `CARS_PER_CELL` constant "for later": a constant with one possible value is a comment the type system pretends to enforce. Changing the ramp is a `rulesVersion` bump that invalidates stored replays. |
| **A real in-place restart (`resetState`), persistence, and the out-of-band seed board** | **M3** | M1f's restart is still `location.reload()`. `seedStartingCity`'s six placements still happen before tick 1 and travel in no input log, so the seed board is still not Worker-replayable; `game/src/startingCity.ts` says so at the site and M1f does not change it. **M3 must re-measure the CloudStorage budget rather than extrapolate:** Task 4 grows `firstCity`'s buffer 13,992 → **14,968 bytes** (+7.0 %), of which 960 bytes are the all-zero `roundabout` region. |
| **The perpendicular lane offset in the renderer, and the multi-tick draw divergence** | **M1g (renderer)** | Cars are still drawn on the centreline, so two cars in opposite lanes visually pass through each other. The offset is `(-DY[dir], DX[dir])` at about 0.15 cells, and the supremum M1g must re-derive is the offset table **plus** the chase bound, not the table alone. The tick-boundary divergence figure to quote is **0.9920 cells, 4.96 × `MAX_DRAW_LAG_CELLS`**, on the every-frame-drains-7-ticks schedule — quote the schedule with it, because the three rows differ by 7.5×. The **0.462 / 2.31×** pair that the M1e plan carried is SUPERSEDED and appears nowhere in `packages/`; do not reintroduce it. The deceleration half of the launch smoothing is **proved unsatisfiable** and must not be re-litigated: it can only be fixed by giving the SIM a brake, which is a `rulesVersion` change. |
| **Spawn weights** | **nobody, deliberately** | §5.9's *"ignore spawn weights after 5 consecutive failures"* governs a structure that does not exist. When weights land, the constant lands with them. |

---

## Carry-forward coverage — every item, with its task or its deferral

The catalogue's rule is that a handoff item with no home in the source is the one that evaporates, and that checking costs one grep per item against a **list of names**, never a reading of the prose. This is that list. Every section of `docs/superpowers/m1f-carry-forward.md` appears exactly once.

| Carry-forward § | Item | Where it lands |
|---|---|---|
| §1 | `regions.ts` × 5 FIELD_IRRELEVANT reasons dated M1f | **Task 1** promotes `carCell` / `occupancy` / `carBlockedTicks` from comment to failing assertion and re-dates all five to M1g |
| §1 | `scratch.ts` `NB` / `DISTINCT_EDGE_COSTS` / `entryPoolCapacity` | **Task 1** re-points to M1g's motorway tier and adds the runtime bucket-window assert trap 2 asks for |
| §1 | `cars.ts` `laneSpeedMul` as a cost-model change | **Task 9** gives it the roundabout tier — a movement multiplier, still not an edge weight |
| §1 | `roads.ts` `LANE_OF_DIR`, "the two-lane model's intersection gap" | **Task 2** — the gap *is* the junction mutual exclusion, and this comment is closed rather than re-pointed |
| §1 | `shared/constants.ts` `ROUNDABOUT_SPEED_MUL` uncalled | **Task 9** gives it its first caller. `MOTORWAY_SPEED_MAX` stays uncalled and is re-dated to M1g in Task 1 |
| §1 | `render/types.ts` `HudRects`, `game/pointer.ts` `HUD_INERT` | **Task 9** — the inventory chip row's first chip |
| §2 | Board expansion | **Deferred, M1g** (Out table) |
| §3 | Destination removal's three inert properties | **Deferred, M1g** (Out table) |
| §4 | The erase control never unsubscribes its click handler | **Task 8** — it also has to be suspended under the modal, which is the same code |
| §5 | `MAX_BLOCKED_TICKS` unreachable on the arms M1e drove | **Task 2** — the valve fires on the shipped board for the first time; `constants.ts`'s two false claims are corrected in the same commit |
| §6 | The multi-tick draw divergence | **Deferred, M1g** (Out table); **Task 7** records the paused-car settling measurement beside the pause decision |
| §7 | The equivalent-mutant register (five entries) | **Task 5** re-runs `4 <-> 5` under its new name `5 <-> 6`; **Task 9** ENDS `laneSpeedMul`'s rounding inertness and makes the choice on purpose; the other three are untouched and must not acquire a manufactured detector |
| §9 | The spawner is not connectivity-aware | **Deferred**, with the measurement that killed the obvious fix: the proposed proximity tier survives all twelve weeks **by making the board inert** — peak `destPins` 1 in 65 of 65 week-observations, four cars ever in motion, delivery fraction ~1.00 — and the *baseline* is the arm that produces the 1 → 2 → 5 → 10 gradient. Task 11 restates it in the handoff |
| §10 | M1d's headline feature is demo-only on the board that ships | **Task 2 closes it.** This is the milestone |
| §11 | The five-tile save is undiscoverable in game | **Deferred.** Task 8's modal is the first UI this game has that teaches anything, and it teaches about cards, not about where to draw. Named for M1g's tutorial surface |
| §12 | The first ten minutes are unloseable; greedy dies at 17:19.9 | **Tasks 2, 3 and 11** — the junction rule shortens the run; Task 11 re-measures on the shipped rule and states both clocks |
| §13 | The seed board is out of band | **Deferred, M3** (Out table) |
| §14 | The device checklist | **Task 11** ships an updated checklist; the five sentences and the six questions are re-derived against the M1f board |
| §15.1 | The demand ramp | **Deferred** (Out table) |
| §15.2 | The round-robin / nearest-source mismatch | **Deferred, M1g, with a reason** (Out table) |
| §15.3 | `MAX_PATH_LEN` is a silent ceiling | **Deferred, M1g, with a reason** (Out table) |
| §15.3 | `H_ROUTES_REFUSED` is not a blocking instrument | **Task 11** — it is 0 on all sixteen seed × arm runs measured and will stay 0 under every lever in this milestone. No task may quote it as evidence about traffic |
| §15.4 | `DESTINATIONS_PER_WEEK` / `HOUSES_PER_DESTINATION` | **Deferred** (Out table). Note `BOARD_FULL` is unreachable on `firstCity` and §5.3.5's redistribution fires **zero** times on the board that ships |
| §15.5 | Is 30 tiles a week right | **Task 6 changes the answer** (the card adds tiles on top) and **Task 11 re-measures** the slack |
| §15.6 | `OvercrowdTimerCarArrivalDeceleration` | **Deferred, M1g, coupled to §15.2** (Out table) |
| §15.7 | The square→circle upgrade | **Deferred, M1g** (Out table) |
| §15.8 | The pin capacities | **Deferred** (Out table) |
| §15.9 | One car per lane-tile | **Deferred; do not add `CARS_PER_CELL`** (Out table) |
| §15.10 | Frame cost under a full jam | **Task 11** — M1f is the first milestone that can produce a full jam on the shipped board, and the allocation harness says nothing at all about frame TIME. A device question, not a budget |
| §15.11 | What the restart feels like | **Task 11**, device question |
| §16 | The golden ledger, and the third class of re-bless | This plan's *"Which goldens move"* section |
| §17 | The tick order, re-measured at the final phase count | **Task 5** runs all 55 pairs at the new count; **Task 11** re-runs only the rows whose phases changed since, and proves the rest are unchanged by `git diff` rather than by assertion |

---

## The five traps

Each of these is a way this milestone can be built correctly and still be worthless, or be wrong while every assertion passes. They are not warnings; each names the task that closes it.

### Trap 1 — the riskiest thing in this milestone is Task 1, not the roundabout

Spec §5.4 line 179 says *"model intersection and traffic-light penalties as extra integer edge weight, which Dijkstra absorbs for free."* The dossier says the opposite and says it is load-bearing: *"junctions, lights and roundabouts carry no path cost, which is exactly why players observe 'the game picks the shortest path but not the fastest'"*, and *"Do not add a congestion term to path cost. The omission is load-bearing: it makes the player the only rerouting mechanism, which is the entire game."* **The shipped code follows the dossier and nothing enforces it.**

If a later hand reads L179 and prices the junction as edge weight, cars route **around** junctions and the 45,986 blocked car-ticks Task 2 creates evaporate before a single player feels one. The milestone would be correct, tested, deployed, and invisible — M1d again, and this time it could happen **after** Task 9 is built, making the roundabout worthless retroactively. So Task 1 ratifies the dossier by amending the spec with provenance, and lands an interlock that fails loudly rather than a comment that reads well.

### Trap 2 — a penalty applied inside `computeFlowField` keeps every assert green and produces wrong paths

`assertBucketCountExceedsEveryEdgeCost` inspects **only** `edgeCost(k)`. A penalty added inside `computeFlowField` — say `+2` for a cell of degree ≥ 3, read off `state.roads` — leaves that assert passing while Dial's cyclic queue aliases two distances into one bucket. Measured, by mutating only the modulus: at `d % 13` the run scores **31 detectors including the field golden**, and the failure reads like a routing regression rather than a queue bug; a push at `d + 14` lands in the bucket drained at `d + 1`, where the drain loop's staleness check **discards** it. Wrong paths, no crash.

**Correction to a claim this project has repeated, and it must not be repeated again: `NB = DIAG_COST + 1 = 15` does NOT have zero slack.** `scratch.ts:55-70` supersedes that: the bound is `M >= max edge cost`, the minimum is **14**, and the `+1` is **one bucket** of slack. What the spare bucket buys was measured too — at modulus 15, moving `bucketHead[b] = -1` from before the walk to after it is a **0-detector no-op**; at modulus 14 the same move makes `computeFlowField` **not terminate**. So at 14 correctness is a joint property of the modulus and one statement's position; at 15 it is a property of the modulus alone. **The trap is real and the margin figure was wrong.** Task 1 closes the trap with a runtime assert on the push window, not with a comment.

Note also: a **per-cell** penalty changes `edgeCost`'s signature, not its value. It makes cost depend on more than direction, so `edgeCost(dir)`, `NB`, `DISTINCT_EDGE_COSTS`, `entryPoolCapacity`, `COST_UNIT_SCALE` and `CAR_SPEED_UNITS_PER_TICK` all go structurally blind at once.

### Trap 3 — Task 2 makes the game measurably WORSE by every gate this project owns

Under the wide rule Task 2 lands, on the shipped board's greedy connect-on-sight arm:

| gate | today | after Task 2 | direction |
|---|---|---|---|
| blocked car-ticks | 2,120 | **45,986** | ×21.7 **up** |
| ticks with a blocked car | 6.2 % | **26 %** | up |
| worst `carBlockedTicks` | 32 | **1,350 (saturated)** | up |
| valve firings | 0 | **14** | up |
| run length | 17:19.9 | **11:54** | **down** |
| completed trips | 747 | **344** | **down 54 %** |
| `game` tests moved | — | **18**, plus `DEMO_DEATH_TICK` and `CITY_DEATH_TICK` | — |
| goldens moved | — | **zero of nine** | — |

**Write those numbers into the task before it executes, which this table does.** The catalogue records *"a survivability gate can be passed by deleting the difficulty"*; this is its mirror image, and a reviewer who has not been told will read it as a regression and ask for it to be reverted. It is not a regression: **a junction that costs nothing is the bug**, and 21.7× is the size of the bug. The thing that closes this gate is **Task 9's relief measurement**, not Task 2's own numbers — Task 2 is allowed to be worse, and Task 9 is required to make the spread between a good and a bad placement large.

**Zero of the nine goldens move in Task 2, and that is derived rather than hoped:** every golden fixture in the repo either has no cars (`rollback.test.ts`, the state golden's 4×4 board), or runs a corridor where no cell reaches degree 3, or never puts two cars on one junction cell within its run length. Task 2 Step 4 proves it by running the suite before touching a golden literal. **If a golden moves in Task 2, stop and report — do not re-bless.**

### Trap 4 — +68 % is an exemption CEILING, not a forecast

The measurement behind this milestone's headline is an **exemption**: with the junction rule installed, exempting the cell at `(9,22)` is worth **+234 trips (+68 %) and +3:44**, while exempting `(8,21)` is worth **exactly zero** — bit-identical to placing nothing. Three cells carry 99.5 % of the refusals (`(9,22)` 10,591 and `(8,21)` 5,085 lead).

**That cell was given unlimited throughput.** A real 3×3 with four orthogonal entries keeps per-lane occupancy on every ring cell, adds four extra cells of travel to most crossings, inverts give-way (Task 9 Decision 12), and reproduces the ring's own documented failure mode — *"players report roundabouts freezing solid and ending runs"*. The real object is **strictly less** than the exemption, by an amount nobody has measured.

**So Task 11's criterion is not "+68 %".** It is: **the spread between the best and the worst placement of one roundabout exceeds 25 %**, re-measured against Task 9's actual object over an enumerated candidate set, with the arm that places nothing as the control. A criterion phrased against the exemption's number would be a criterion the shipped object cannot meet, and the response to missing it would be to weaken the object rather than to report the finding.

### Trap 5 — `destPins` and `destReserved` are `Uint8Array`

An unguarded decrement at 0 wraps to **255**, and where the slot gates eligibility it excludes that destination from dispatch **forever**, silently, surviving snapshot/restore and replaying identically in the Worker. The complete set of `Uint8Array` decrement paths in `sim/src` today is three: `destPins` and `destReserved` in `trips.ts` (guarded by `assertArrivalHonoured`) and `ghostCommitted` in `roads.ts` (guarded by `assertGhostCommittedPositive`).

M1f's new writers are: the offer phase (writes three `Int32` header slots), `choose-card` (increments `H_TILES` and `H_INV_ROUNDABOUT`, both `Int32`), and roundabout placement (writes the `Uint8` `roundabout` region **only upward**, 0 → a code, and never back; decrements `H_INV_ROUNDABOUT`, which is `Int32`). **So M1f adds no fourth `Uint8Array` decrement path** — and Task 11 verifies that the way M1d and M1e did, by **enumerating every write to every `Uint8` region** rather than grepping for `--`, because the one path M1d actually added spells it `const left = committed - 1` across two statements and no `--`-shaped pattern matches it.

---

## Which goldens move, exactly, and in which task

`hashState(s)` is FNV-1a over the **whole** buffer, sized by `computeLayout(regionsFor(map)).totalBytes`, so adding a region changes the digest even when every new byte is zero.

**Buffer shape changes in exactly ONE task, Task 4.** That is deliberate structure, copied from M1e: a standing re-bless licence is a window in which a genuine behavioural regression is absorbed as an expected hash update, and this milestone keeps the window one task wide. Every task after Task 4 appends behaviour, never shape. **The `roundabout` region is therefore declared in Task 4 and first read in Task 9**, five tasks later, exactly as M1e declared `destOvercrowd` in Task 1 and first read it in Task 7.

`firstCity` sizes: `cells` 960, `groupCount` 5, `maxHouses` 40, `maxDestinations` 16, `maxCars` 80.

| Added in Task 4 | Type | Length | Bytes |
|---|---|---|---|
| `header` grows 13 → 17 (`H_OFFER_A`, `H_OFFER_B`, `H_OFFER_WEEK`, `H_INV_ROUNDABOUT`) | `Int32` | +4 | **+16** |
| `roundabout` | `Uint8` | `cells` = 960 | **+960** |

The 4-byte tier goes **1,824 → 1,840 B**; the `Int16` tier stays 4,320; the `Uint8` tier goes **7,848 → 8,808 B**. `regionsFor` goes 29 → **30** regions and `totalBytes` goes 13,992 → **14,968** for `firstCity`. 1,840 is a multiple of 4 and 14,968 is a multiple of 4, so `computeLayout` inserts no pad byte anywhere and `regions.test.ts`'s zero-padding assertion still holds. **Verify all four of those arithmetic claims by running `computeLayout(regionsFor(firstCity()))` rather than by trusting this table.**

**One insertion, one append, and Task 4's proof depends on knowing which is which.** `header` is the **third** region in the 4-byte tier (`rng`, `mapIdentity`, `header`, …), so its four new slots go in mid-buffer and shift everything after them. `roundabout` is appended to the **end of the `Uint8` tier**, which is the end of the buffer, so it shifts nothing. Two ranges, one interior and one terminal.

| Golden | Fixture | Moves in |
|---|---|---|
| `1058753394` **state** | `determinism.test.ts`, 4×4 map, no buildings, 13,499 ticks | **Task 4** (layout), and **Task 5** — it is the only golden fixture that crosses a week boundary, so it is the only one the offer phase can reach |
| `2312109239` **road-network** | `rollback.test.ts`, never calls `step` | **Task 4** only |
| `252514232` **field** | `rollback.test.ts`, `foldedFieldsHash` over `dist`/`dir` | **NEVER.** It hashes flow fields, not the buffer — which is exactly the property that makes it the odd one out, and exactly what makes it a tripwire for trap 1. **If it moves in any task of this milestone, stop and report** |
| `1877236894` **loop** | `loop.test.ts`, 20×12, 150 ticks | **Task 4** only |
| `307910575` **queue** | `loop.test.ts`, `Q_RUN_TICKS` = 130 | **Task 4** only |
| `1531344761` **multipliers** | `cars.test.ts`, `M_GOLDEN_TICK` = 110 | **Task 4** only |
| `968680755` **seed** | `startingCity.test.ts` **and** `demoLayout.test.ts`, pre-tick | **Task 4** only. **Two sites — a re-bless must edit both** |
| `3152640907` **demo** | `demoLayout.test.ts`, pre-tick on `demoCity` | **Task 4** only |
| `894844668` **demand-pin** | `loop.test.ts`, 20×9 fixture across a week boundary | **Task 4** (layout), and **Task 5** — same reason as the state golden |

**Why only two move behaviourally, derived rather than assumed.** The offer phase writes `H_OFFER_A`/`H_OFFER_B` on every tick of a week ≥ 1 in which no choice has been made. Exactly two golden fixtures run past tick 4,500: the state golden (13,499 ticks) and the demand-pin golden (`DG_RUN_TICKS` across a boundary). Every other fixture stops inside week 0, where `runOffer` returns on its first line. Verify that claim per fixture by reading its run length before Task 5 changes any literal — do not infer it from this table.

**Both Task 5 moves carry a direct assertion on the bytes that changed, beside the digest.** The state golden's fixture is a 4×4 map whose clipped spawn zone is empty and which holds no destination, so its pool is `{CARD_ROAD_TILES}` alone once Task 10 lands and `{CARD_ROAD_TILES, CARD_ROUNDABOUT}` before it — Task 5 asserts the two offer slots' exact values at tick 13,499 by hand from `offerSeedFor` and `poolFor`, and Task 10 asserts them again after the pool narrows. **A digest is never the only evidence for a re-bless in this milestone.**

**Task 2 moves no golden, Task 3 may move `3152640907` and nothing else, Tasks 1, 6, 7, 8, 10 and 11 move none, and Task 9 moves none.** Task 3's exception is stated in its own preamble and is the only conditional entry in this table: one of its three arms edits `demoCity`'s map bytes, which is the one input `3152640907` folds. **Task 9 moves no golden and that is derived**: it adds no region (Task 4 did), and no golden fixture places a roundabout, so `state.roundabout` is all-zero in every one of them.

### The third class of re-bless applies to Task 4 and to nothing else

The ledger's rule is that a re-bless carries a behavioural claim a reviewer can check against the diff. **Task 4's carries none** — the digests move because the buffer is a different shape, and a genuine behavioural regression landing in the same commit would be absorbed with no trace. So Task 4 must state which shape change moved them **and assert the run's behavioural observables unchanged in the same commit**: death tick, trips and refusals on the greedy arm, plus the splice proof. Without both halves the re-bless is a blank cheque.

**And "bit-identical" is the wrong word for it.** The runs are *behaviourally identical with a different buffer*. A reader told "bit-identical" and then "moves 8 goldens" has been handed a contradiction and will believe whichever half suits them.

**A red golden test is not a moved digest.** Under a shape change, several golden tests abort on a buffer-length pin sitting **above** their `expect(hashState(...))` line and never reach it. Every `yes` in the table above must be re-measured **by digest**, by relaxing the pins and re-running; a `no` needs no re-check, because a green golden is the digest speaking directly.

---

## Fourteen design decisions

### 1. Routing stays congestion-blind and junction-blind; the junction's cost lives in MOVEMENT only

Ratified in Task 1 as a spec amendment with provenance, because the spec and the dossier disagree and the code follows the dossier. The amendment's text is in Task 1 Step 1. Three consequences, each enforced rather than asserted:

- `edgeCost`'s signature stays `(dir: number) => number`. A per-cell or per-pair cost is a **signature change**, and the interlock pins the signature line, not the values.
- `computeFlowField` reads no per-cell penalty region. The behavioural arms in `flowfield.test.ts` scramble every FIELD_IRRELEVANT region and cannot see a penalty derived from `roads` (which is FIELD_INPUT), so Task 1 adds the **structural** half: a scan banning `roadDegree`, `INTERSECTION_DEGREE` and `isJunctionCell` inside `flowfield.ts`, with `cars.ts` as its positive control.
- The Dial queue's aliasing is converted from "wrong paths, no crash" into a named throw by `assertPushWithinBucketWindow`.

### 2. The junction rule is MUTUAL EXCLUSION at the cell, and it is spec §5.5 taken literally

§5.5: *"One blocking primitive: does an inbound vehicle collide with a traversing vehicle on this chunk?"* The lane model already resolves the parallel and the head-on cases — `LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]` for every `d`, so two cars in exactly opposite directions never contend. What it has never resolved is the **crossing** case, and a junction is where crossings happen.

The rule Task 2 lands: **entering a cell of road degree ≥ `INTERSECTION_DEGREE` requires BOTH lanes free.** One extra `Int16Array` read on 0.35 crossings per tick, zero new state bytes, zero allocations.

**Two things this breaks that are currently written down as true, and Task 2 corrects both in the same commit:**

1. `constants.ts`'s `MAX_BLOCKED_TICKS` comment says *"Head-on is structurally impossible …, so no 2-cycle can deadlock and the valve is not the answer to opposing traffic. It is the answer to a cycle of length >= 3."* **False after Task 2.** Two cars swapping across an edge whose endpoints are both junctions each require the other's cell to be empty, and each is standing in it: a genuine 2-cycle, cleared only by the valve at 1,350 ticks. That is one of the reasons the valve goes from 0 firings to 14.
2. The same comment says *"lowering this constant is a change no shipped board can observe, and raising it is free."* **Also false after Task 2** — the valve fires on the shipped board, so both directions are observable. And `blocking.ts`'s `canEnter` doc says *"Give-way is not implemented because it does not need to be"*; after Task 2 it is implemented, as mutual exclusion, and the sentence has to say so.

**Fairness is decided explicitly, not inherited from a loop bound.** When two cars would enter one junction cell on one tick, **the lower car index wins** — the same rule `runMovement`'s ascending iteration already produces, but written down as a rule with a test rather than left as a property of a `for`. Ascending order was already outcome-visible from M1d Task 3 (killed by 11 tests when reversed); the junction rule makes it visible in more places, not in a new way.

### 3. `isJunctionCell` is ONE predicate with two readers, so the slowdown and the exclusion cannot disagree

Today `intersectionSpeedMul` decides what a junction is (`roadDegree(cell) >= INTERSECTION_DEGREE`) and `canEnter` has no opinion. After Task 2 both read `isJunctionCell(state, cell)`, exported from `graph.ts`. After Task 9 that one predicate gains the roundabout clause, and **both** behaviours change with one edit: a roundabout cell is not a junction, so it neither slows a car nor excludes one.

This is the catalogue's *"where a rule is stated twice — once as prose, once as code — a test written against the prose does not test the code"*, applied preventively: one predicate, one production path, one table of cases.

`INTERSECTION_DEGREE = 3` moves out of `cars.ts` module scope into `@laneways/shared` in Task 1, because a second module now depends on it and a private constant with two conceptual readers is a copy waiting to happen.

### 4. Task 3 is a fork resolved BEFORE the shape change, and its criterion is written before its measurement

Junction exclusion freezes the demo board inside `demoAllocation.test.ts`'s profiling window: **97,138 blocked car-ticks, longest queue 17, trips 420 → 105**, and the rig's liveness guard fires. The rig ends at tick **6,459** against a `DEMO_DEATH_TICK` of 6,703 — a 3.6 % margin, the tightest in the repo — so a demo death tick that moves below 6,459 puts three profiled windows over a corpse.

**This is a balance decision and it must not be discovered inside Task 9.** Task 3 measures three arms in one sitting and applies a criterion stated before any of them runs. The three arms and the criterion are in Task 3's preamble. **The plan's prediction is arm B**, and the prediction is written down so a disagreement is a finding: arm B is *also the more faithful reading of §5.5*, because "collides with a traversing vehicle" is about a collision and not about co-presence, and two cars crossing a junction on the same axis do not collide.

### 5. The offer is a `step` PHASE at position 4, and the card's tiles are paid by the INPUT

Phase 2 (`runWeekBoundary`) keeps `WEEKLY_TILE_GRANT` and writes `H_TILES` and nothing else. Phase 4 (`runOffer`) writes `H_OFFER_A`/`H_OFFER_B` and nothing else. **The card's tile bonus is paid inside `applyChooseCard`, in phase 3, never at the boundary** — so phases 2 and 4 are disjoint **by construction** and their transposition is inert for a reason a reader can check, not for a reason a sweep happened to find.

Position 4 is forced from both sides: **after phase 3**, because a `choose-card` action queued on the boundary tick must resolve *this* week's offer before the phase that would raise one; **before phase 5 (spawn)**, because nothing downstream may observe a half-raised offer, and putting it last would let a week's worth of ticks run before the modal exists.

**The consequence for tile income is a balance regression and it is named, not hidden.** A player now receives 30 automatic tiles plus the card's 30 (tiles) or 20 (an item), against a measured **3.4× slack** — 62 tiles spent of 210 granted on the arm that ships, with `tilesLeft` never falling below 37. The alternative — deleting phase 2's grant and making the card the only income — is spec-faithful (§5.10: every card grants tiles, so a bad draw can never softlock) and was refused for one reason: it makes tile income depend on a player action, which turns two goldens' `H_TILES` into a function of the input log and re-opens `integration.test.ts`'s whole tile ledger in the same milestone as a shape change. **Task 11 measures the new slack and hands the tile economy to M1g with the number.**

### 6. The draw does NOT advance `state.rng[0]`, and the guard lands before the hazard

Measured: **one `nextRandom` per week boundary moves the greedy arm's death tick 31,456 → 34,088**, freezes `spawn.test.ts` at 2,640,000 and fails Gate C. The spawner already reads the RNG word **without** advancing it, for the same reason and with the reason written at the site: a consumer that draws on a schedule couples every downstream draw to that schedule.

So the offer is a pure function of the word and the week:

```
offerSeedFor(state, week) = mixWord(rng[0] ^ imul(week + 1, 0x9E3779B1))
```

`mixWord` is mulberry32's output transform with the state write removed, extracted from `nextRandom` so there is **one** copy of that arithmetic rather than two. Successive words inside one draw come from re-mixing (`mixWord(w)`), so rejection sampling needs no counter and no storage.

**Selection is rejection over a `CARD_COUNT`-bit pool bitmask, with no array**: `no-module-mutable-state` forbids a module-scope one and a local one allocates on a per-tick path. `nthSetBit(mask, k)` walks the bits.

**Task 4 lands the guard before the hazard**: a `determinism.test.ts` rule banning `nextRandom(` and `randomBelow(` anywhere in `sim/src` outside `rng.ts`, plus an `rng[0]`-invariance test that drives a full multi-week run and asserts the word never changes — **both green at HEAD before the offer code exists**, so their teeth are proved against the tree that already satisfies them.

### 7. `H_OFFER_WEEK === H_WEEK` is the SINGLE mechanism for "one per week" AND "already chosen"

`H_OFFER_WEEK` holds the week whose offer has been **resolved**. Zero-initialised means 0, and week 0 has no offer, so the sentinel needs no write in `createState`.

- **Pending** iff `H_OFFER_WEEK !== H_WEEK && H_WEEK > 0`.
- `runOffer` raises an offer iff pending, and it is **idempotent**: the draw is a pure function of `(rng[0], week)`, so re-running it on every tick of the week writes the same two ids. That is what lets one flag do both jobs.
- `applyChooseCard` sets `H_OFFER_WEEK = H_WEEK`, which simultaneously ends the modal and blocks a second card this week.

**A second flag would be the catalogue's independently-sufficient-structures defect**: with both "an offer exists" and "it has been taken", neither half can have a detector of its own, and a mutation table would show two survivors that are not coverage holes.

**Two consequences, both stated rather than discovered.** A duplicate `choose-card` in the same tick's batch is a **silent no-op**, not a throw — a double tap must not brick a run, and the sim's own flag absorbs it, so `pointer.ts` needs no second guard. And if two week boundaries pass with an offer pending (only reachable from a Worker replaying a log that contains no choice), week `w+1`'s offer **replaces** week `w`'s and week `w`'s card is lost. That is deterministic, it is what "no bank, no skip" means, and it is asserted.

### 8. The echo is the replay-divergence detector, and it is the only thing that throws

`enqueue('choose-card', slot, cardId)`: `a` is the slot, `b` is **the card id the client believes it is taking**. `applyChooseCard` compares `b` against the slot's actual contents and **throws with the diagnosis** on a mismatch.

A mismatch means the browser and the sim disagree about what was offered, which can only happen if the draw is not a pure function of state — a stale frame, a divergent seed, a Worker on a different `rulesVersion`. That is precisely the failure this product's leaderboard exists to catch, and it must be loud. **A Worker that hits it returns `unverifiable`** — never a score, and never apply-anyway. Applying anyway would let a client choose a card it was not offered and have the Worker bless it.

Order inside `applyChooseCard` is load-bearing: **pending check first (silent no-op), slot validity second (throw), echo third (throw).** The pending check must precede the echo, because once a later week's offer has overwritten the slots the echo would fail for a reason that is not a divergence.

`sim` gains **no notion of pause**. Nothing in `packages/sim` knows a modal exists.

### 9. The pause is raised on the CONDITION, not on the edge — and `loop.ts` is not touched

`loop.ts` reads `paused` **above** the `while`, so a pause raised from inside `advance` does not stop the drain in progress: measured, a pause raised inside a clamped 250 ms drain still advances **7 ticks**, for both `setPaused` and `end()`. **This plan does not change that**, and the decision is made here rather than inside Task 7.

Three reasons. The 7 ticks are **invisible**: `loop.frame` renders once, after the drain, so the first frame a human sees is already the post-drain state. They are **replay-safe**: `sim` has no pause concept, the ticks are logged like any others, and `runOffer` is idempotent so the offer the player sees is the offer raised at the boundary. And re-checking `paused` inside the `while` would only **defer** the burst — `setPaused(false)` resets `lastTime` and leaves the accumulator, so the banked time drains after the modal closes instead of before it opens, which is strictly worse.

**The pause fires on the condition rather than the edge, and that is the opposite of `onGameOver`.** Game over is terminal and must announce once, so `advance` reads `wasOver` before the step. An offer is recurring and self-healing, so `advance` calls `deps.onOfferRaised()` whenever `offerPending(state)` holds after the step, and `setPaused(true)` is already idempotent. The payoff: **any path that unpauses with an offer still pending re-pauses on the next tick**, so a lost input cannot strand the modal over a live board.

The **resume** is the pointer's, on `CARD_CHOSEN`, because the tick that resolves the offer cannot run while the loop is paused. There is a one-to-two-frame window in which the modal is still drawn after the tap; the sim's duplicate no-op is what makes that harmless.

**Recorded, not fixed:** M1e measured that paused cars do **not** settle onto their sim positions — they stop 0.09–0.22 cells short, because the smoothing chase advances inside the drain and the drain has stopped. Under a modal that lasts as long as the player takes to choose, that frozen offset is visible for the first time. It is under `MAX_DRAW_LAG_CELLS` (0.2) at the top of its range and about 6 CSS px at the smallest tile size. Task 11's device session asks whether anyone notices.

### 10. Peek hides the modal; it does not resume the sim

§5.10 gives the modal a peek button and no skip, no bank, no reroll and no timer. Peek is a **`game`-side** boolean owned by `pointer.ts` beside `eraseMode` — it is UI, not simulation, and putting it in the state buffer would make a cosmetic toggle a replay input.

While peeking: the modal chrome is not drawn, the board is, the loop stays **paused**, and board input stays refused (`REFUSED_PAUSED`, which `host.paused()` already produces). Any tap returns to the modal. If peek resumed the sim it would be a free unpause with no cost, which is the one thing a no-timer modal must not offer.

### 11. The roundabout is a real 3×3 object: nine marked cells, an eight-cell ring, four orthogonal entries

Dossier §1.8 and spec §5.6. Placement at centre `c`:

1. **Validate** — all nine cells on-board and `world.passable`, none holding a house cell, a destination footprint cell or a carpark, none already marked, and `H_INV_ROUNDABOUT >= 1`.
2. **Erase** every road bit incident to any of the nine cells **except** an entry cell's bit to a cell outside the block, through `eraseRoad`, in ascending cell order then ascending direction order. Refunds and ghosts are the existing machinery's, unchanged: a car committed to an erased segment keeps driving it as a ghost and the refund is paid when the last one clears.
3. **Mark** the nine cells: `RA_CENTRE` at `c`, `RA_ENTRY` at the four orthogonal neighbours, `RA_CORNER` at the four diagonals.
4. **Lay the ring** — the eight road segments joining adjacent ring cells — at **zero tile cost**, paying any pending ghost refund on the cells it touches exactly as `placeRoad` does.
5. **Spend** one from `H_INV_ROUNDABOUT`.

**The perimeter of a 3×3 is an 8-cycle whose every edge is orthogonal**, which is why the ring needs no diagonal and every ring edge costs `ORTHO_COST`. The ring is exactly *"every legal road segment between two ring cells"*, which makes both the lay-down loop and the completeness invariant one sentence each.

**The ring is BIDIRECTIONAL, like every other road in this game, and one-way circulation is out of scope with a reason.** A direction-restricted segment is a new road concept that breaks `LANE_OF_DIR`'s symmetry, the flow field's undirected relaxation and the return leg's "same route backwards" identity all at once. What the object keeps from the real thing is the part that matters: the crossing conflict disappears and the ring can back up.

**Two standing rules, enforced in `canPlaceRoad` forever after placement:** no road may touch `RA_CENTRE`, and an `RA_CORNER` cell may join only another roundabout cell. Together those are §1.8's *"connects from the 4 orthogonal neighbours"*.

**A roundabout can disconnect the board** by erasing a corner's outward link. That is the player's problem and it is redrawable; it is named here so it is not filed as a bug.

### 12. Give-way stays INVERTED, deliberately, and it costs nothing to keep

Dossier §1.8: *"circulating traffic has no enforced right-of-way — cars already on the ring will sometimes stop to admit entering cars … the failure mode is the ring itself backing up."* And: *"Decide consciously whether to keep this inverted priority. It defines the roundabout's entire early-good/late-bad arc; 'fixing' it silently rebalances the whole difficulty curve."*

**M1f keeps it, and keeps it by adding nothing.** Contention on a ring cell resolves by the same lowest-car-index rule as everywhere else, so an entrant sometimes beats a circulator and sometimes does not — which is literally *"will sometimes stop to admit entering cars"*. A priority rule would be new code that changes the arc; the absence of one reproduces the documented behaviour for free. Task 9 asserts the failure mode exists rather than merely assuming it: a fixture that saturates a ring must show the ring refusing its own entrants.

### 13. The roundabout's speed replaces the intersection's; the ROUNDING INERTNESS ends here

`intersectionSpeedMul` becomes `junctionSpeedMul(state, cell)`: `ROUNDABOUT_SPEED_MUL` (2000) on a roundabout cell, else `INTERSECTION_SPEED_MUL` (500) on a junction, else `MUL_NONE`. A roundabout is the alternative to an intersection, not an instance of one, so the two never both apply. The turn component is untouched — a car really does turn on a ring.

**This ends a labelled-inert entry on the equivalent-mutant register, and Task 9 must make the choice on purpose rather than inherit it.** `laneSpeedMul` truncates the average of the applicable multipliers. Today's whole reachable set of compound averages is 583.5 and 416.5, and both round to the same `speedUnits` either way (583/584 → 192, 416/417 → 137), so the rounding direction is a provable equivalent mutant. The roundabout adds two more: (667 + 2000)/2 = **1333.5** and (333 + 2000)/2 = **1166.5**, and *these do not*. Truncating gives `speedUnits(1333) = 439` and `speedUnits(1166) = 384`; rounding up gives **440** and **385**. **The condition the register named has fired.** Task 9 keeps truncation, matching `scaleSpeed`'s own, extends `cars.test.ts`'s four `speedUnits` pins to cover the new values, and rewrites the inertness note to say the condition fired and what was chosen.

The one-crossing-per-tick invariant survives: `speedUnits(2000)` is 660 against `MIN_EDGE_THRESHOLD` = 2,500, so `assertSingleCrossing` cannot fire. Assert that as arithmetic, in `cars.test.ts`, rather than leaving it as a reading.

### 14. The pool has two filters with two reasons, and the shipped map exercises both arms of one of them

`poolFor(world) = capabilityMask(world) & CARD_IMPLEMENTED_MASK`.

- **`capabilityMask(world)`** is §5.10's own rule: bridge iff the map has water, tunnel iff it has mountain, roundabout iff the map has at least one all-passable 3×3 block, road tiles / lights / motorway always. It is a pure function of immutable terrain, so it is constant for a run — Task 10 asserts that it is identical at every week boundary rather than caching it.
- **`CARD_IMPLEMENTED_MASK`** is M1f's scope boundary: `CARD_ROAD_TILES | CARD_ROUNDABOUT`. An offerable card with no placement mechanism is dead configuration that reads as support, and this constant is the interlock that stops one shipping. M1g deletes bits from it.

**Both arms of the capability filter are reachable on the two shipped maps and Task 10 measures which**: `firstCity` has water (column 12) and mountain (rows 5–7), so its capability mask is all six; `demoCity` has **neither**, so bridge and tunnel are excluded there. That is the catalogue's *"measure which cases the shipped configuration can actually produce"* satisfied by the boards themselves rather than by a synthetic fixture.

**The shipped pool therefore has exactly two entries and the offer is the same pair every week.** The randomness that survives is **which slot holds which**, and that is not decoration: without it a player learns "slot A is always tiles" in two weeks and stops reading the modal. The draw's selection machinery is width-generic in `CARD_COUNT` and its rejection path is exercised by a synthetic three-and-four-card pool in `cards.test.ts`, which is stated as the reason it exists rather than left to look like over-engineering.

---

## File Structure

Two new source modules, both in `sim`, both small and single-purpose. Everything else is an edit to a file that already owns the concept.

**Created**

| File | Responsibility |
|---|---|
| `packages/sim/src/cards.ts` | The card ids, the pool masks and their two filters, the non-consuming draw (`offerSeedFor`, `nthSetBit`, `pickFromPool`), `runOffer` (phase 4), `applyChooseCard`, `cardTileGrant`. **Nothing else may own the offer slots.** |
| `packages/sim/src/roundabout.ts` | The `RA_*` cell codes, `roundaboutCellAt`, `isRoundaboutCell`, `canPlaceRoundabout`, `applyPlaceRoundabout`. Owns the block's geometry and its placement validity; delegates every `state.roads` write to `roads.ts`. |
| `packages/sim/test/cards.test.ts` | The draw, the pool, the echo, the one-per-week flag, the pool's synthetic-mask arms. |
| `packages/sim/test/roundabout.test.ts` | The geometry, the nine placement refusals, the erase-and-lay sequence, the ring's completeness, the ring-backs-up fixture. |
| `packages/sim/test/m1fSplice.ts` | Task 4's re-bless proof: the two M1f byte ranges for a given map, with every structural assumption checked rather than assumed. |
| `packages/sim/test/m1fSplice.test.ts` | The splice's own guards, fed synthetic layouts. |
| `packages/game/test/junctionCensus.ts` | The census policy — the "two cars on one junction cell" definition — as one function shared by the two drivers that use it, on `cityArms.ts`'s precedent. |
| `packages/game/test/roundaboutSweep.ts` | Task 11's candidate enumeration and per-placement scoring, shared between the sweep test and the report. |

**Modified**

| File | Change |
|---|---|
| `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md` | Task 1's §5.4 amendment, dated, with provenance |
| `packages/shared/src/constants.ts` | `INTERSECTION_DEGREE` (moved in from `cars.ts`), `CARD_GRANT_ROAD_TILES`, `CARD_GRANT_ITEM`, `ROUNDABOUT_SPAN`; two corrections to `MAX_BLOCKED_TICKS`'s comment (Task 2) |
| `packages/sim/src/rng.ts` | `mixWord` extracted from `nextRandom`; byte-identical output |
| `packages/sim/src/graph.ts` | `isJunctionCell` |
| `packages/sim/src/scratch.ts` | `assertPushWithinBucketWindow`; the penalty note re-pointed to M1g |
| `packages/sim/src/flowfield.ts` | Calls the new assert inside the relaxation's push |
| `packages/sim/src/blocking.ts` | `canEnter`'s junction clause; the give-way and head-on paragraphs corrected |
| `packages/sim/src/cars.ts` | `intersectionSpeedMul` → `junctionSpeedMul`; `INTERSECTION_DEGREE` imported; the rounding-inertness note rewritten (Task 9) |
| `packages/sim/src/roads.ts` | `canPlaceRoad`'s two roundabout refusals; `layRoundaboutRing`; the ghost refund reused |
| `packages/sim/src/state.ts` | Four header slots, `HEADER_LENGTH` 13 → 17, `offerPending`/`offerSlot` accessors |
| `packages/sim/src/regions.ts` | The `roundabout` region; five FIELD_IRRELEVANT reasons re-dated; the new region classified |
| `packages/sim/src/step.ts` | Phase 4 inserted, phases renumbered, two new action kinds dispatched |
| `packages/sim/src/index.ts` | Exports the two new modules |
| `packages/render/src/types.ts` | `RenderFrame`'s seven new fields; `HudRects.roundabout`; `OfferRects`; `Palette`'s four new colours |
| `packages/render/src/camera.ts` | `hudRects` gains the chip; `offerRects` |
| `packages/render/src/canvas.ts` | The roundabout disc; the inventory chip; phase 12, the modal |
| `packages/render/src/palette.ts` | The four new colours |
| `packages/game/src/frame.ts` | Folds the new frame fields; the driver's `onOfferRaised` |
| `packages/game/src/pointer.ts` | Modal arbitration, peek, roundabout mode, three new outcomes |
| `packages/game/src/main.ts` | Wires `onOfferRaised`, the resume, the chip's count, the erase control's suspension |
| `packages/game/src/eraseControl.ts` | `suspend`/`resume`; the `retired` guard moved into `press` |
| `packages/game/test/deathTicks.ts` | Both death ticks re-measured in Task 2 and again in Task 3 |

**Test files that must move for reasons other than their own subject** (named here so a task that turns them red knows it was expected): `sim/test/determinism.test.ts` (the file list, the new RNG rule, the state golden), `sim/test/state.test.ts` (`HEADER_LENGTH`), `sim/test/regions.test.ts` (`totalBytes`, the ordered region list, the partition), `sim/test/loop.test.ts` (three golden literals plus the cross-file literal scan), `sim/test/rollback.test.ts`, `sim/test/cars.test.ts`, `sim/test/step.test.ts` (the `TickActionKind` line-anchored pin — **twice**, in Tasks 6 and 9), `sim/test/m1eSplice.ts`, `game/test/startingCity.test.ts`, `game/test/demoLayout.test.ts`, `game/test/integration.test.ts`, `game/test/demoAllocation.test.ts`, `game/test/pointer.test.ts`, `render/test/canvas.test.ts`.

---

## Task 1: The routing decision, ratified and ENFORCED — plus the census that dates the milestone

**Observability:** nothing. This task changes no behaviour at all and it says so out loud: it moves one constant between packages, amends a document, and adds tests and one assert that cannot fire on any state the game can reach today. **No golden moves.** If one does, stop and report.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md:179`
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/sim/src/cars.ts:238` (delete the module-scope constant, import it)
- Modify: `packages/sim/src/scratch.ts` (the penalty note; `assertPushWithinBucketWindow`)
- Modify: `packages/sim/src/flowfield.ts` (call the assert in the push)
- Modify: `packages/sim/src/regions.ts` (re-date five reasons)
- Create: `packages/game/test/junctionCensus.ts`
- Test: `packages/sim/test/scratch.test.ts`, `packages/sim/test/flowfield.test.ts`, `packages/sim/test/graph.test.ts`, `packages/shared/test/constants.test.ts`, `packages/game/test/integration.test.ts`

**Interfaces:**
- Produces: `INTERSECTION_DEGREE: number` (= 3) exported from `@laneways/shared`; `assertPushWithinBucketWindow(pushed: number, draining: number, buckets: number): void` exported from `packages/sim/src/scratch.ts`; `countJunctionConflicts(state: GameState, world: WorldData, prev: Uint8Array): number` and `JUNCTION_CENSUS_CELLS: number` exported from `packages/game/test/junctionCensus.ts`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Amend the spec, with provenance**

Replace the tail of `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md:179` — the clause reading `model intersection and traffic-light penalties as extra integer edge weight, which Dijkstra absorbs for free.` — with:

```markdown
coalesce dirty rebuilds to at most one per tick.

> **AMENDMENT, 2026-08-20 (M1f Task 1). Intersection, traffic-light and roundabout
> penalties are NOT edge weight.** The sentence that stood here said to model them
> as extra integer edge weight. It contradicts the research this spec is built on
> and it contradicts the shipped code, and the research is right. Dossier §1.5:
> *"It is shortest by distance, not time — junctions, lights and roundabouts carry
> no path cost, which is exactly why players observe 'the game picks the shortest
> path but not the fastest'"*, and *"Do not add a congestion term to path cost. The
> omission is load-bearing: it makes the player the only rerouting mechanism, which
> is the entire game."* §1 of this document says the same thing in its own words.
>
> **The rule, which supersedes the clause above:** path cost is a function of the
> DIRECTION of a step and of nothing else. `edgeCost(dir: number): number` is the
> whole cost model. Junction cost lives in MOVEMENT — `laneSpeedMul`, which scales
> a car's per-tick progress — and in ENTRY — `canEnter`, which refuses a crossing.
> Neither is visible to Dijkstra, deliberately.
>
> **What it would cost to reverse this**, measured on the shipped board's greedy
> arm at M1f Task 2: junction exclusion produces 45,986 blocked car-ticks. Priced
> as edge weight instead, cars route around the junctions and the player never sees
> one. The milestone would be correct, tested, deployed and invisible.
>
> This amendment is enforced rather than recorded: see `packages/sim/src/graph.ts`
> (`edgeCost`'s signature is pinned by a line-anchored scan), `packages/sim/src/scratch.ts`
> (`assertPushWithinBucketWindow`), and `packages/sim/test/flowfield.test.ts`
> (the congestion-blindness arms and the structural scan).
```

- [ ] **Step 2: Write the failing test for the pinned signature and the structural scan**

Add to `packages/sim/test/flowfield.test.ts`:

```ts
describe('the M1f amendment: path cost is a function of direction and nothing else', () => {
  const graphSrc = readFileSync(new URL('../src/graph.ts', import.meta.url), 'utf8')
  const flowfieldSrc = readFileSync(new URL('../src/flowfield.ts', import.meta.url), 'utf8')
  const carsSrc = readFileSync(new URL('../src/cars.ts', import.meta.url), 'utf8')

  it('reads all three sources back non-empty', () => {
    expect(graphSrc.length, 'graph.ts read back empty').toBeGreaterThan(4000)
    expect(flowfieldSrc.length, 'flowfield.ts read back empty').toBeGreaterThan(4000)
    expect(carsSrc.length, 'cars.ts read back empty').toBeGreaterThan(4000)
  })

  it("pins edgeCost's signature line, because a per-cell penalty changes the signature and not the value", () => {
    expect(
      graphSrc,
      'edgeCost no longer takes exactly one direction — see the 2026-08-20 amendment to spec 5.4',
    ).toMatch(/^export function edgeCost\(dir: number\): number \{$/m)
    expect(edgeCost.length, 'edgeCost arity').toBe(1)
  })

  // The behavioural arms below scramble every FIELD_IRRELEVANT region and cannot
  // see a penalty derived from `roads`, which is FIELD_INPUT. This is the half
  // that can: the three names a junction penalty inside the pathfinder would
  // have to use.
  const PENALTY_NAMES = ['roadDegree', 'INTERSECTION_DEGREE', 'isJunctionCell']
  const nameRe = (n: string): RegExp => new RegExp(`\\b${n}\\b`)

  for (const name of PENALTY_NAMES) {
    it(`flowfield.ts does not mention ${name}`, () => {
      expect(
        flowfieldSrc,
        `flowfield.ts now uses ${name} — a junction penalty inside computeFlowField keeps ` +
          'assertBucketCountExceedsEveryEdgeCost green while Dial aliases two distances into one ' +
          'bucket. See the 2026-08-20 amendment to spec 5.4 and scratch.ts NB.',
      ).not.toMatch(nameRe(name))
    })
  }

  it('the three patterns can match something, so the guards above can fail', () => {
    // cars.ts is the positive control: it is the module that legitimately prices
    // a junction, at movement time. A typo in any pattern turns this red rather
    // than silently disarming the guard.
    for (const name of PENALTY_NAMES) {
      expect(carsSrc, `the ${name} pattern matches nothing in cars.ts — the guard cannot fail`).toMatch(
        nameRe(name),
      )
    }
  })
})
```

- [ ] **Step 3: Run it and watch the positive control fail**

Run: `pnpm --filter @laneways/sim test -- flowfield`
Expected: FAIL on the positive control — `isJunctionCell` does not exist in `cars.ts` yet (Task 2 creates it). The other assertions pass. **This is the correct first failure**: it proves the control is doing its job. Add `isJunctionCell` to `PENALTY_NAMES` only after Task 2 lands; until then the array is `['roadDegree', 'INTERSECTION_DEGREE']` and Task 2 Step 9 adds the third entry.

- [ ] **Step 4: Narrow the list to two names, re-run, and commit nothing yet**

Edit `PENALTY_NAMES` to `['roadDegree', 'INTERSECTION_DEGREE']`.
Run: `pnpm --filter @laneways/sim test -- flowfield`
Expected: PASS.

- [ ] **Step 5: Move `INTERSECTION_DEGREE` into `@laneways/shared`**

Delete `packages/sim/src/cars.ts:238`'s `const INTERSECTION_DEGREE = 3` and add to `packages/shared/src/constants.ts`, beside the lane-speed block:

```ts
/**
 * The road degree at which a cell counts as an INTERSECTION — a third road
 * meets there. Degree 2 is a corridor cell, 1 a dead end, 0 bare ground.
 *
 * **Moved out of `sim/src/cars.ts` module scope at M1f Task 1, because it
 * acquired a second reader.** M1d used it in exactly one place, to select spec
 * §5.5's *"approaching an intersection"* speed multiplier. M1f gives the same
 * threshold a second job — `canEnter`'s mutual exclusion (`blocking.ts`, via
 * `isJunctionCell` in `graph.ts`) — and a private constant with two conceptual
 * readers is a copy waiting to happen. Both readers now go through
 * `isJunctionCell`, so this constant has exactly one direct reader again; it
 * lives here because the rule it encodes is a game rule, not a movement detail.
 *
 * **It is NOT an edge weight and must never become one** — see the 2026-08-20
 * amendment to spec §5.4. `flowfield.test.ts` scans `flowfield.ts` for this
 * name for exactly that reason.
 */
export const INTERSECTION_DEGREE = 3
```

Add `INTERSECTION_DEGREE` to `cars.ts`'s existing `@laneways/shared` import list.

- [ ] **Step 6: Add it to the shared registry test and run both packages**

`packages/shared/test/constants.test.ts` has an `ALL` registry that every exported constant must appear in. Add `INTERSECTION_DEGREE` with an exact-value assertion:

```ts
    expect(INTERSECTION_DEGREE, 'a third road meeting is what makes a cell a junction').toBe(3)
```

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS everywhere. `cars.test.ts`'s junction fixtures still pass unchanged — the value did not move, only its home.

- [ ] **Step 7: Write the failing test for the bucket-window assert**

Add to `packages/sim/test/scratch.test.ts`:

```ts
describe('assertPushWithinBucketWindow — trap 2, converted from wrong paths into a named throw', () => {
  it('accepts a push exactly NB above the draining distance, which lands in the freshly-detached bucket', () => {
    expect(() => assertPushWithinBucketWindow(100 + NB, 100, NB)).not.toThrow()
  })

  it('accepts every real edge cost', () => {
    for (let k = 0; k < DIR_COUNT; k++) {
      expect(() => assertPushWithinBucketWindow(1000 + edgeCost(k), 1000, NB)).not.toThrow()
    }
  })

  it('throws, naming both distances and the modulus, one unit past the window', () => {
    expect(() => assertPushWithinBucketWindow(100 + NB + 1, 100, NB)).toThrow(
      /aliases into the bucket drained at 101.*NB=15/s,
    )
  })

  it('throws for a push BELOW the draining distance, which is a monotonicity violation', () => {
    expect(() => assertPushWithinBucketWindow(99, 100, NB)).toThrow(/below the distance being drained/)
  })
})
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm --filter @laneways/sim test -- scratch`
Expected: FAIL with "assertPushWithinBucketWindow is not defined".

- [ ] **Step 9: Implement the assert and call it from the relaxation**

Add to `packages/sim/src/scratch.ts`, below `NB`:

```ts
/**
 * Throws if a relaxation would push a distance outside the window Dial's cyclic
 * queue can represent from the bucket currently draining.
 *
 * **This is the mechanism for the trap `NB`'s note above describes and could
 * not close.** `assertBucketCountExceedsEveryEdgeCost` inspects only
 * `edgeCost(k)`, so a penalty applied INSIDE `computeFlowField` — a per-cell
 * term read off `roads`, a junction surcharge, a lights delay — leaves it green
 * while the queue silently aliases two distances into one bucket. Measured at
 * modulus 13: 31 detectors, all of which read like a routing regression rather
 * than a queue bug, because the drain loop's staleness check DISCARDS the
 * aliased entry. This turns that into a named throw at the push that causes it.
 *
 * **The bound is `pushed - draining <= buckets`, inclusive, and the inclusive
 * end is not slack.** While bucket `d` drains, `computeFlowField` has already
 * written `bucketHead[b] = -1`, so an entry at exactly `d + M` sits in a
 * freshly-emptied bucket and is drained on its next visit, at `d + M`. That is
 * the whole reason `NB = DIAG_COST + 1` rather than `DIAG_COST`: at 14 the
 * queue's correctness is a joint property of the modulus AND that statement's
 * position (measured — move the detach after the walk at 14 and the drain loop
 * does not terminate), and at 15 it is a property of the modulus alone.
 *
 * Parameterised rather than closing over `NB`, on the precedent of
 * `assertBucketCountExceedsEveryEdgeCost`, `assertSingleCrossing` (cars.ts) and
 * `assertDispatchProgress` (dispatch.ts): the failure path is then testable
 * directly, without editing a constant and rebuilding.
 *
 * Unreachable today, by construction: the only pushes are `d + edgeCost(dir)`
 * and `max(edgeCost) = DIAG_COST = NB - 1`. It is reachable the moment anybody
 * adds a term, which is the point.
 *
 * @internal `computeFlowField` is the production call site.
 */
export function assertPushWithinBucketWindow(pushed: number, draining: number, buckets: number): void {
  const delta = pushed - draining
  if (delta < 0) {
    throw new Error(
      `scratch: a relaxation pushed distance ${pushed}, below the distance being drained (${draining}) — ` +
        'Dijkstra over non-negative weights cannot do that, so this is a negative or corrupted edge cost',
    )
  }
  if (delta > buckets) {
    throw new Error(
      `scratch: a relaxation pushed distance ${pushed} while draining ${draining}, a gap of ${delta} ` +
        `against NB=${buckets} — it aliases into the bucket drained at ${draining + (delta % buckets)}, ` +
        'where the staleness check discards it: wrong paths, no crash. An edge cost above NB - 1 needs ' +
        'NB resized (see NB, and the 2026-08-20 amendment to spec 5.4)',
    )
  }
}
```

In `packages/sim/src/flowfield.ts`, in `computeFlowField`'s relaxation, immediately before the push that writes the new distance, add:

```ts
      assertPushWithinBucketWindow(nd, d, NB)
```

using the local names the loop already has for the candidate distance and the draining distance. **Do not rename them to match this snippet** — read the loop and use its own identifiers, and if it has no local for the draining distance, hoist one rather than recomputing it.

- [ ] **Step 10: Run the sim suite and confirm the field golden did not move**

Run: `pnpm --filter @laneways/sim test`
Expected: PASS, including `252514232`. A one-comparison-per-push assert changes no distance.

- [ ] **Step 11: Re-date the five FIELD_IRRELEVANT reasons and the `scratch.ts` predictions**

In `packages/sim/src/regions.ts`, the five reasons dated *"M1f's demand-actuated lights"* (`carCell`, `occupancy`, `carBlockedTicks`, `ghostMask`, `ghostCommitted`) become **M1g's**, and the paragraph gains:

```
 * **M1f did NOT make any of these a field input, and three of the five are no
 * longer resting on this comment.** `carCell`, `occupancy` and `carBlockedTicks`
 * are now pinned by `flowfield.test.ts`'s derived arm, which scrambles EVERY
 * region this list names and requires byte-identical `dist`/`dir` and an unmoved
 * `CT_REBUILDS` — so the classification is a failing assertion rather than a
 * sentence. M1f additionally amended spec 5.4 to say outright that junction cost
 * is not edge weight (2026-08-20), which is the rule these five reasons were
 * always an instance of. The date moves to M1g because demand-actuated lights
 * are the next thing that could argue with it, and the argument would have to
 * beat the amendment first.
 *
 * `roundabout` (M1f Task 4) joins them: a roundabout changes a car's SPEED and
 * its right to enter, never the distance of a step, so routing is
 * roundabout-blind for exactly the reason it is congestion-blind.
```

In `packages/sim/src/scratch.ts`, `NB`'s note and `DISTINCT_EDGE_COSTS`'s note both predict M1f's motorway tier. **M1f ships no motorway.** Re-point both to M1g, and add to `NB`'s note:

```
 * **Third wrong prediction, and this one is worth counting.** This comment has
 * now named M1d, M1e and M1f as the milestone that would exceed NB, and none of
 * them did. The reason is structural rather than lucky and it is now written
 * down in the spec: junction cost is not edge weight (amendment, 2026-08-20), so
 * the only thing that can change the VALUE SET is a tier on the step itself —
 * the motorway's divide-by-three. Until a motorway ships, `DISTINCT_EDGE_COSTS`
 * is 2 and the set is {10, 14}. M1f Task 1 also added
 * `assertPushWithinBucketWindow`, so a fourth wrong prediction is a throw rather
 * than a wrong path.
```

- [ ] **Step 12: Write the junction census, shared by two drivers**

Create `packages/game/test/junctionCensus.ts`:

```ts
import { INTERSECTION_DEGREE, LANE_COUNT } from '@laneways/shared'
import { FREE, occupancySlot, roadDegree, type GameState, type WorldData } from '@laneways/sim'

/**
 * **The census this milestone is dated from, as ONE policy shared by every
 * driver that measures it**, on `cityArms.ts`'s precedent: two drivers agreeing
 * is evidence, one driver run twice is not.
 *
 * A JUNCTION CONFLICT is a **rising edge**: a tick on which a cell of road
 * degree >= `INTERSECTION_DEGREE` holds two DIFFERENT cars in its two lanes,
 * having not held two different cars on the previous tick. Rising edges rather
 * than tick-counts, because a pair sitting together for k ticks is one conflict
 * that lasted, not k conflicts — and because the rising edge is exactly the
 * event M1f Task 2's rule makes impossible.
 *
 * **Read off `state.occupancy` and `state.roads`, never reconstructed.** The
 * queue probe's 5.7-15.2 % disagreement rate came from rebuilding a key the
 * system already stores; this reads the arrays `claimCell`/`releaseCell` write
 * and asks `roadDegree` the question `intersectionSpeedMul` already asks.
 *
 * `prev` is caller-owned, one byte per cell, and carries the previous tick's
 * answer across calls so the edge can be detected without allocating.
 */
export function countJunctionConflicts(state: GameState, world: WorldData, prev: Uint8Array): number {
  let rising = 0
  for (let cell = 0; cell < world.cells; cell++) {
    let both = 0
    if (roadDegree(state, cell) >= INTERSECTION_DEGREE) {
      const a = state.occupancy[occupancySlot(cell, 0)] as number
      const b = state.occupancy[occupancySlot(cell, LANE_COUNT - 1)] as number
      both = a !== FREE && b !== FREE && a !== b ? 1 : 0
    }
    if (both === 1 && (prev[cell] as number) === 0) rising++
    prev[cell] = both
  }
  return rising
}
```

- [ ] **Step 13: Write the census test on the production boot path**

Add to `packages/game/test/integration.test.ts`, using the existing greedy `cityArms.ts` driver and the production `createGame` boot:

```ts
  it('counts 271 junction conflicts over the greedy run, the first at tick 12,780, on five cells', () => {
    const g = bootGreedyCity()                       // the same rig integration.test.ts already uses
    const prev = new Uint8Array(g.world.cells)
    const seen = new Uint8Array(g.world.cells)
    let total = 0
    let firstTick = -1
    while (!isGameOver(g.state)) {
      driveOneGreedyTick(g)
      const n = countJunctionConflicts(g.state, g.world, prev)
      if (n > 0) {
        total += n
        if (firstTick < 0) firstTick = g.state.header[H_TICK] as number
        for (let c = 0; c < g.world.cells; c++) if ((prev[c] as number) === 1) seen[c] = 1
      }
    }
    let cells = 0
    for (let c = 0; c < g.world.cells; c++) cells += seen[c] as number

    // Vacuity first: a census over a run that ended early would report a small
    // number for the wrong reason.
    expect(g.state.header[H_TICK], 'the greedy arm still dies where it did').toBe(31456)
    expect(g.state.header[H_SCORE], 'and still scores what it did').toBe(747)

    expect(total, 'junction conflicts over the whole run').toBe(271)
    expect(firstTick, 'the first one — 6:57 on a stopwatch, (12780 - 258) / 30').toBe(12780)
    expect(cells, 'distinct cells that ever carried one').toBe(5)
  })
```

**These three figures are values to REPRODUCE, not values to fill in.** If the run disagrees, the disagreement is the finding: record the measured number **with the census definition beside it**, mark this plan's 271 superseded in the task report, and do not adjust the definition to reach 271.

- [ ] **Step 14: Run it**

Run: `pnpm --filter @laneways/game test -- integration`
Expected: PASS with 271 / 12,780 / 5, or a reported disagreement.

- [ ] **Step 15: Mutation-test this task's tests**

Apply each mutant alone, run the canonical invocation, record detectors as **assertion failures naming the behaviour**, screen non-vitest-result lines for error classes, and check per-package totals are unchanged. Commit first; chain the restore and its report in one `&&`.

| # | Mutant | Expected |
|---|---|---|
| 1 | `assertPushWithinBucketWindow`: `delta > buckets` → `delta >= buckets` | ≥ 1, in `scratch.test.ts`'s *"exactly NB above"* |
| 2 | `assertPushWithinBucketWindow`: delete the `delta < 0` arm | ≥ 1, in the monotonicity test |
| 3 | `flowfield.ts`: delete the `assertPushWithinBucketWindow` call | **0 expected, and that is the correct answer** — the assert is unreachable on every state the game can reach. Record it as a deliberately unreachable guard in the same register as `assertSingleCrossing`, and **do not manufacture a detector by weakening `NB`** |
| 4 | `INTERSECTION_DEGREE` 3 → 4 | ≥ 1, in `cars.test.ts`'s junction fixture and in `constants.test.ts` |
| 5 | The scan: `PENALTY_NAMES` → `['roadDegree']` | ≥ 1, in *"the patterns can match something"* only if the dropped name is also dropped from the control — otherwise 0, which is the honest answer for a list shortened at both ends. Instead mutate `not.toMatch` → `toMatch` on one name and require ≥ 1 |
| 6 | `countJunctionConflicts`: `a !== b` → `true` | ≥ 1, in the census test |
| 7 | `countJunctionConflicts`: drop the rising-edge test (`both === 1` alone) | ≥ 1, in the census test — the total inflates |
| 8 | `countJunctionConflicts`: `>= INTERSECTION_DEGREE` → `>= 2` | ≥ 1, in the census test |

- [ ] **Step 16: Commit**

```bash
git add docs/superpowers/specs packages/shared packages/sim packages/game
git commit -m "feat(sim): junction cost is not edge weight, ratified and interlocked

Spec 5.4's 'model intersection penalties as extra integer edge weight' is
amended: it contradicts dossier 1.5, it contradicts the shipped code, and the
dossier is right. The amendment carries its provenance and the cost of
reversing it.

Enforced rather than recorded: edgeCost's signature line is pinned,
flowfield.ts is scanned for the three names a junction penalty would need with
cars.ts as the positive control, and assertPushWithinBucketWindow converts
Dial's aliasing from wrong-paths-no-crash into a named throw. NB's note is
corrected where it has been wrong three milestones running.

INTERSECTION_DEGREE moves to @laneways/shared: it acquires a second reader in
the next task.

The junction-conflict census lands as a test on the production boot: 271
conflicts over the greedy run, first at tick 12,780 (6:57), five cells. That is
the number the next task removes.

No golden moves. No behaviour changes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8"
```

---

## Task 2: Junction mutual exclusion in `canEnter` — the wait this project shipped the ceiling for

**Read trap 3 before starting.** This task makes every gate worse: 2,120 → 45,986 blocked car-ticks, 17:19.9 → 11:54, 747 → 344 trips, 18 `game` tests moved. That is the size of the bug being fixed, not a regression. The thing that closes it is Task 9.

**Observability:** **the first traffic jam this game has ever shown on the board that ships.** At **6:57** on a stopwatch, on the default board under competent play, cars begin to stop at five specific cells instead of driving through each other; by minute nine there are visible standing queues and the anti-deadlock valve fires for the first time outside a purpose-built fixture. **Before 6:57 the board is bit-identical to today** — same cars, same trips, same everything — and that is by construction, because tick 12,780 is the first tick on which two cars are ever co-present on one junction cell (Task 1's census). Nobody should look for a difference in the first six minutes.

**Files:**
- Modify: `packages/sim/src/graph.ts` (`isJunctionCell`)
- Modify: `packages/sim/src/roads.ts` (`otherLane`, beside `LANE_OF_DIR`)
- Modify: `packages/sim/src/cars.ts` (`intersectionSpeedMul` reads the shared predicate)
- Modify: `packages/sim/src/blocking.ts` (`canEnter`; two corrected paragraphs)
- Modify: `packages/shared/src/constants.ts` (`MAX_BLOCKED_TICKS`'s two false claims)
- Modify: `packages/game/test/deathTicks.ts`
- Test: `packages/sim/test/blocking.test.ts`, `packages/sim/test/graph.test.ts`, `packages/sim/test/roads.test.ts`, `packages/game/test/integration.test.ts`

**Interfaces:**
- Consumes: `INTERSECTION_DEGREE` from `@laneways/shared` (Task 1); `countJunctionConflicts` from `packages/game/test/junctionCensus.ts` (Task 1).
- Produces: `isJunctionCell(state: GameState, cell: number): boolean` from `packages/sim/src/graph.ts`; `otherLane(lane: number): number` from `packages/sim/src/roads.ts`. Task 9 amends `isJunctionCell` and nothing else.

- [ ] **Step 1: Write the failing unit test for the rule**

Add to `packages/sim/test/blocking.test.ts`, using the file's existing hand-built board helpers:

```ts
describe('a junction cell admits ONE car at a time (spec 5.5, M1f Task 2)', () => {
  /**
   * A plus: cell C at the centre with four orthogonal arms, so `roadDegree(C)`
   * is 4. Car 0 stands on C having entered from the west (lane
   * `LANE_OF_DIR[E]`); car 1 stands on the north arm and wants to enter C
   * heading south (lane `LANE_OF_DIR[S]`), which is the OTHER lane.
   *
   * The fixture is a PLUS and not a corridor deliberately: on a degree-2 cell
   * the rule must not fire, and the sibling test below is that arm. A fixture
   * that could not tell degree 2 from degree 4 would pass either way.
   */
  it('refuses a crossing entrant while the other lane is held', () => {
    const rig = plusJunction()
    expect(roadDegree(rig.s, rig.centre), 'the fixture really is a junction').toBe(4)
    expect(LANE_OF_DIR[DIR_E], 'the two cars really are in different lanes').not.toBe(LANE_OF_DIR[DIR_S])
    claimCell(rig.s, 0, rig.centre, DIR_E)
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('admits the same entrant when the cell is a corridor rather than a junction', () => {
    const rig = straightCorridor()
    expect(roadDegree(rig.s, rig.mid), 'the fixture really is degree 2').toBe(2)
    claimCell(rig.s, 0, rig.mid, DIR_E)
    expect(canEnter(rig.s, rig.world, 1, rig.mid, DIR_S)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('still admits an entrant onto an EMPTY junction', () => {
    const rig = plusJunction()
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('refuses on the OWN lane at a junction exactly as it does on a corridor', () => {
    const rig = plusJunction()
    claimCell(rig.s, 0, rig.centre, DIR_S)
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('releases a junction refusal through the valve, and the valve is still inside the occupied family', () => {
    const rig = plusJunction()
    claimCell(rig.s, 0, rig.centre, DIR_E)
    rig.s.carBlockedTicks[1] = MAX_BLOCKED_TICKS
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.ENTER_VALVE)
  })

  it('does NOT let the valve release a junction cell that is also a ghost', () => {
    // The ghost check is an early return in FRONT of the occupancy read, so the
    // junction clause cannot reach it either. This is the conjunction the
    // catalogue records as untested for a whole milestone: BOTH clauses true at
    // once — a saturated counter AND a ghost AND a junction AND the other lane
    // held — on one fixture.
    const rig = plusJunction()
    claimCell(rig.s, 0, rig.centre, DIR_E)
    rig.s.carBlockedTicks[1] = MAX_BLOCKED_TICKS
    rig.s.ghostMask[rig.centre] = 1 << DIR_E
    expect(isCommittedTo(rig.s, rig.world, 1, rig.centre), 'the fixture is off-manifold on purpose').toBe(false)
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.REFUSED_GHOST)
  })

  it('breaks the 2-cycle that the two-lane model used to make impossible', () => {
    // Two junctions joined by one edge, one car standing on each, each wanting
    // the other's cell. Neither can move; the valve is the only way out. This
    // is the case `MAX_BLOCKED_TICKS`'s comment said could not exist, and this
    // task corrects that comment.
    const rig = twoAdjacentJunctions()
    claimCell(rig.s, 0, rig.left, DIR_E)
    claimCell(rig.s, 1, rig.right, DIR_W)
    expect(canEnter(rig.s, rig.world, 0, rig.right, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(canEnter(rig.s, rig.world, 1, rig.left, DIR_W)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })
})
```

Write `plusJunction()`, `straightCorridor()` and `twoAdjacentJunctions()` beside the file's existing rig helpers, each returning `{ s, world }` plus the named cells, and each asserting its own degree inside the test rather than in the helper.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @laneways/sim test -- blocking`
Expected: FAIL — the crossing entrant is currently `ENTER_FREE`, and `isJunctionCell` does not exist.

- [ ] **Step 3: Implement `isJunctionCell`, `otherLane`, and the rule**

`packages/sim/src/graph.ts`:

```ts
/**
 * Is `cell` an INTERSECTION — a cell where a third road meets?
 *
 * **One predicate, two readers, and that is the whole reason it exists.** Until
 * M1f, `cars.ts`'s `intersectionSpeedMul` decided what a junction was and
 * `canEnter` had no opinion. M1f gives the same threshold a second job — spec
 * §5.5's mutual exclusion — and two copies of one rule are two rules that can
 * disagree. Both now read this.
 *
 * **M1f Task 9 adds a clause HERE and nowhere else**: a roundabout cell is not
 * a junction, so it neither slows a car nor excludes one, and both behaviours
 * change with one edit.
 *
 * Counted off the MASK by `roadDegree`, which differs from `neighbours` only
 * for a bit written directly into `state.roads` — see `roadDegree`'s comment.
 * An off-board `cell` reads `undefined`, `roadDegree` answers 0, and this
 * answers `false`, which is the same answer bare ground gives. No guard, for
 * the same reason `roadDegree` has none: both callers have already proved the
 * cell on-board (`advanceCar` by throwing on `stepCell`'s -1, `canEnter` by
 * `assertEnterCellOnBoard`).
 *
 * **NOT an edge weight, and never.** See the 2026-08-20 amendment to spec §5.4;
 * `flowfield.test.ts` scans `flowfield.ts` for this name.
 */
export function isJunctionCell(state: GameState, cell: number): boolean {
  return roadDegree(state, cell) >= INTERSECTION_DEGREE
}
```

`packages/sim/src/roads.ts`, beside `LANE_OF_DIR`:

```ts
/**
 * The other of the two lanes. `LANE_COUNT` is 2 and this function is the one
 * place that assumes it, so raising `LANE_COUNT` fails here loudly rather than
 * silently returning a lane index that means something else.
 *
 * Its one production caller is `canEnter`'s junction clause: mutual exclusion
 * at a junction means the entrant's own lane AND the lane it is crossing.
 */
export function otherLane(lane: number): number {
  if (LANE_COUNT !== 2) {
    throw new Error(`roads: otherLane assumes exactly two lanes, but LANE_COUNT is ${LANE_COUNT}`)
  }
  if (lane !== 0 && lane !== 1) throw new Error(`roads: lane ${lane} is not one of the two`)
  return lane === 0 ? 1 : 0
}
```

`packages/sim/src/blocking.ts`, replacing `canEnter`'s last three lines:

```ts
  const lane = LANE_OF_DIR[dir] as number
  const own = state.occupancy[occupancySlot(cell, lane)] as number
  // ------------------------------------------------------------------------
  // THE JUNCTION'S MUTUAL EXCLUSION — M1f Task 2, spec §5.5
  // ------------------------------------------------------------------------
  //
  // §5.5's blocking primitive is *"does an inbound vehicle collide with a
  // traversing vehicle on this chunk?"*, and until M1f this function only ever
  // asked about the entrant's OWN lane. That resolves the parallel case and the
  // head-on case (`LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]`) and leaves the
  // CROSSING case unresolved — so two cars crossed inside one cell and nothing
  // stopped them. `MAX_BLOCKED_TICKS` is the datamined ceiling on the wait at an
  // intersection; this is the wait.
  //
  // **A junction cell admits one car at a time.** On a cell of degree >= 3 the
  // OTHER lane must be free too. One extra `Int16Array` read on 0.35 crossings
  // per tick, no new state, no allocation.
  //
  // **`isJunctionCell` and NOT an open-coded degree test**, because
  // `intersectionSpeedMul` (cars.ts) reads the same predicate: the cell that
  // slows a car and the cell that excludes one are the same cell BY
  // CONSTRUCTION, and M1f Task 9's roundabout exempts both with one edit.
  //
  // **It inherits `assertOccupancySound`'s valve exception and introduces no
  // new soundness question**: the other lane's slot is read exactly as the own
  // lane's is, so a stale claim left by a valve displacement is stale in both
  // and is already in that assert's exception set.
  const other = isJunctionCell(state, cell)
    ? (state.occupancy[occupancySlot(cell, otherLane(lane))] as number)
    : FREE
  if (own === FREE && other === FREE) return EnterOutcome.ENTER_FREE
  if ((state.carBlockedTicks[i] as number) >= MAX_BLOCKED_TICKS) return EnterOutcome.ENTER_VALVE
  return EnterOutcome.REFUSED_OCCUPIED
```

And in `cars.ts`, `intersectionSpeedMul` becomes:

```ts
export function intersectionSpeedMul(state: GameState, cell: number): number {
  return isJunctionCell(state, cell) ? INTERSECTION_SPEED_MUL : MUL_NONE
}
```

- [ ] **Step 4: Run the SIM suite before touching any golden literal**

Run: `pnpm --filter @laneways/sim test`
Expected: **PASS, with all seven `sim`-side goldens green.** Trap 3's derivation says no golden fixture ever puts two cars on one junction cell. **If a golden is red here, stop and report — do not re-bless.** Read the failure: if it is a `hashState` line, the derivation is wrong and this task's scope has changed; if it is a queue-length or arrival-tick assertion inside a golden's `describe`, that is a behavioural test moving, not the digest.

- [ ] **Step 5: Run the whole suite and enumerate exactly which `game` tests moved**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: RED in `packages/game`. **Write down the full failure list before changing anything** — the expectation is **18** tests plus the two death-tick constants. A count materially different from 18 is a finding: too few means the rule is not firing on the arms that should feel it, too many means it is firing somewhere the derivation did not predict.

- [ ] **Step 6: Re-measure both death ticks and update `deathTicks.ts` with the derivation**

Drive each shipped board from boot to its §5.8 death with **no input**, exactly as `deathTicks.ts`'s comment specifies, and replace both constants. Add to each doc comment the prior value, the reason it moved, and the arm:

```ts
/**
 * … **Moved at M1f Task 2** from 6,703 by junction mutual exclusion: the demo
 * board is a deliberately overloaded city and a junction that costs something
 * is what it was built to exhibit. Re-measured on the same rig this file's
 * header specifies. **Task 3 may move it again** — it is the task that decides
 * the shipped rule — and if it does, both this constant and
 * `demoAllocation.test.ts`'s margin are re-derived there.
 */
export const DEMO_DEATH_TICK = /* measured */
```

**Do not copy a number from this plan into `deathTicks.ts`.** These two are measurements, and the plan states none for them precisely because Task 3 may move them again.

- [ ] **Step 7: Repair the 18 moved `game` tests, one at a time, by re-deriving rather than by re-fitting**

For each: read what it asserts, decide whether the new value is the *correct* value for the new rule, and record the pair in the commit message. **A test whose new value cannot be derived from the rule is a test that was measuring something else** — say so rather than pasting the number in. `demoAllocation.test.ts`'s window margin is **not** repaired here; it is Task 3's, and it is allowed to stay red between these two commits. Add a one-line note at its site saying so, keyed to Task 3.

- [ ] **Step 8: Land the exemption-reconvergence test**

This is the proof that five cells are the whole story, and it is the bridge to Task 9. Add to `packages/game/test/integration.test.ts`:

```ts
  it('exempting the five conflicting cells reconverges to the pre-M1f run exactly', () => {
    // The exemption is a CEILING, not a forecast: it gives those cells unlimited
    // crossing throughput, which no real roundabout does. Its job here is to
    // show that the junction rule's whole effect on this board is carried by
    // five cells — which is what makes a 3x3 object the right shape of fix.
    const exempt = new Uint8Array(WORLD.cells)
    for (const cell of JUNCTION_CENSUS_CELLS) exempt[cell] = 1
    const arm = runGreedyCityWithJunctionExemption(exempt)
    const base = runGreedyCityPreM1f()      // the same policy with the rule disabled

    expect(arm.deathTick, 'the exempt arm dies where the pre-M1f run died').toBe(31456)
    expect(arm.trips, 'and scores what it scored').toBe(747)
    // The load-bearing assertion is the EQUALITY, not the literal. Pinning the
    // absolute digest here would mint a tenth golden-shaped number that the
    // golden ledger does not account for — a standing re-bless licence nobody
    // authorised. The two 20,000-tick jam sweeps in this file already work this
    // way and say so.
    expect(arm.hash, 'byte-identical to the pre-M1f run').toBe(base.hash)
    // The guard against comparing two copies of nothing:
    expect(arm.hash, 'and not merely equal to a fresh untouched state').not.toBe(freshHash())
  })
```

Reproduce **3331345422** as the value both arms hash to and put it in the task report; do not write it into the test.

- [ ] **Step 9: Correct the two false claims, and add the third scan name**

In `packages/shared/src/constants.ts`, `MAX_BLOCKED_TICKS`:

```
 * **M1f Task 2 falsified two sentences that stood here, and both are corrected
 * rather than deleted, because the reasoning that produced them is still worth
 * reading.**
 *
 * The first said head-on is structurally impossible, so no 2-cycle can deadlock
 * and the valve is the answer only to a cycle of length >= 3. That was true
 * while `canEnter` asked about one lane. Under junction mutual exclusion two
 * cars swapping across an edge whose endpoints are BOTH junctions each require
 * the other's cell to be empty and each is standing in it: a 2-cycle, cleared
 * only by this constant. `blocking.test.ts`'s *"breaks the 2-cycle"* test is the
 * fixture.
 *
 * The second said lowering this constant is a change no shipped board can
 * observe and raising it is free. Also true then, false now: the valve fires
 * **14 times** on the shipped board's greedy arm where it fired 0, so both
 * directions are observable and the first real tuning evidence exists.
```

In `packages/sim/src/blocking.ts`, `canEnter`'s doc: *"Give-way is not implemented because it does not need to be"* becomes a statement of what IS implemented — mutual exclusion, in whose favour it resolves (lowest car index), and that the roundabout is the only thing that lifts it.

In `packages/sim/test/flowfield.test.ts`, extend Task 1's `PENALTY_NAMES` to `['roadDegree', 'INTERSECTION_DEGREE', 'isJunctionCell']` and re-run — the positive control in `cars.ts` now hits all three.

- [ ] **Step 10: State the fairness rule and test it**

Add to `packages/sim/test/loop.test.ts`, on a fixture where two cars would enter one junction cell on one tick:

```ts
  it('gives the junction to the LOWER car index, as a rule and not as a loop bound', () => {
    const rig = junctionRace()          // cars 0 and 1, both one step from the centre, crossing axes
    step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.carCell[0], 'car 0 crossed').toBe(rig.centre)
    expect(rig.s.carCell[1], 'car 1 held its progress').not.toBe(rig.centre)
    expect(rig.s.carBlockedTicks[1], 'and was counted as blocked, not merely slow').toBe(1)
    expect(rig.s.carBlockedTicks[0], 'while the winner was not').toBe(0)
  })
```

- [ ] **Step 11: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS in every package **except** `demoAllocation.test.ts`'s window margin, which Task 3 owns and which must be the only red thing. If anything else is red, it was not predicted and is a finding.

- [ ] **Step 12: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `canEnter`: delete the junction clause (`other` always `FREE`) | high; must include `blocking.test.ts`'s crossing test **and** `integration.test.ts` |
| 2 | `canEnter`: drop `isJunctionCell` (always read the other lane) | ≥ 1, in *"admits the same entrant on a corridor"* |
| 3 | `canEnter`: read `lane` instead of `otherLane(lane)` for `other` | ≥ 1 — this is the mutant that makes the clause a duplicate of the own-lane read and it must not be an equivalent mutant |
| 4 | `canEnter`: hoist the valve above the ghost early return | ≥ 1, in *"does NOT let the valve release a ghost"* |
| 5 | `isJunctionCell`: `>= INTERSECTION_DEGREE` → `> INTERSECTION_DEGREE` | ≥ 1 |
| 6 | `otherLane`: `lane === 0 ? 1 : 0` → `lane` | ≥ 1, same set as #3 |
| 7 | `otherLane`: delete the `LANE_COUNT !== 2` throw | **0 expected** — unreachable while `LANE_COUNT` is 2. Record as a deliberately unreachable guard; do not manufacture a detector |
| 8 | `runMovement`: iterate descending | high, and it must now include the fairness test by name |

- [ ] **Step 13: Commit**

```bash
git add packages/sim packages/shared packages/game
git commit -m "feat(sim): a junction admits one car at a time

MAX_BLOCKED_TICKS is the datamined ceiling on the wait at an intersection and
this project shipped it without the wait. canEnter read one lane, so two cars
crossed inside one cell and nothing stopped them. Spec 5.5's blocking primitive
is mutual exclusion at the chunk; a cell of road degree >= 3 now admits one car.

One predicate — graph.ts's isJunctionCell — is read by both canEnter and
intersectionSpeedMul, so the cell that slows a car and the cell that excludes
one cannot disagree.

The measured cost, on the shipped board's greedy arm, stated because it reads
as a regression and is not: blocked car-ticks 2,120 -> 45,986, worst wait
32 -> 1,350 saturated, valve firings 0 -> 14, run 17:19.9 -> 11:54, trips
747 -> 344. Bit-identical to the previous commit until tick 12,780 (6:57), by
construction: that is the first tick two cars are ever co-present on a junction.
Task 9 is what makes it better again.

Zero goldens move. Two sentences in MAX_BLOCKED_TICKS's comment were falsified
by this change and are corrected: a 2-cycle CAN deadlock now, and the constant
is observable in both directions.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8"
```

---

## Task 3: Demo-board triage — a fork resolved BEFORE the shape change

**The problem, measured.** Junction exclusion freezes the demo board inside `demoAllocation.test.ts`'s profiling window: **97,138 blocked car-ticks, longest queue 17, trips 420 → 105**, and the rig's liveness guard fires. That rig ends at tick **6,459** against `DEMO_DEATH_TICK`, and its margin was already the tightest in the repo at 3.6 %.

**Observability:** depends on the arm. Under arm A or C, nothing changes on the default board and the demo board (`?startapp=demo`) gridlocks visibly. Under arm B the default board's queues get shorter than Task 2's and the demo board keeps roughly the traffic it has. **Whichever arm wins, the task states what a person sees on BOTH boards in its report.**

**Files:** depends on the arm; all three touch `packages/game/test/demoAllocation.test.ts` and `packages/game/test/deathTicks.ts`.

**Interfaces:**
- Consumes: `isJunctionCell` and `canEnter`'s junction clause (Task 2).
- Produces: nothing new under arms A and C. Under arm B, `crossesAt(state: GameState, i: number): number` exported from `packages/sim/src/blocking.ts` — the direction the occupant of a cell entered by, or `NO_PREVIOUS_DIR`.

### The three arms, written out before any of them runs

**Arm A — the wide rule everywhere, plus a demo layout change.** Keep Task 2's rule exactly. Edit `demoCity`'s map bytes or `seedDemoLayout`'s roads to give the overloaded board somewhere for its crossings to go. **Cost:** moves `3152640907` (the demo golden), which is the only golden this whole task may move; re-opens `demoLayout.test.ts`'s hand-computed figures; and the board being edited is the one board a human has ever played.

**Arm B — crossing conflicts only.** Refuse at a junction only when the occupant of the other lane is travelling on a **crossing axis**. Two cars going straight through a crossroads on the same axis do not collide, and §5.5 says *collide*, not *co-occupy*. The occupant's heading is not stored, and it is not reconstructed either: `previousLegDir` — the function `advanceCar` already uses for exactly this — returns the direction a car's last crossing used, which for a car standing on `cell` is the direction it entered by.

```ts
/**
 * The direction the car standing on a cell ENTERED it by, or `NO_PREVIOUS_DIR`
 * if it has not crossed on this leg.
 *
 * **Not a reconstruction.** `previousLegDir` (cars.ts) is the same derivation
 * `advanceCar` runs to price the turn, over the same arrays, on the same tick.
 * The queue probe's 5.7-15.2 % disagreement came from keeping a SECOND map of
 * (cell -> car); this keeps none.
 *
 * `NO_PREVIOUS_DIR` is fail-CLOSED: a car that has not crossed on its leg has
 * no axis, and a junction whose occupant's axis is unknown refuses. The two
 * reachable cases are a just-dispatched car on its house cell and a car that
 * has just flipped to RETURNING on the carpark; both are cells a crossing
 * entrant is entitled to be refused from.
 */
export function crossesAt(state: GameState, i: number): number
```

with the conflict test `d1 === NO_PREVIOUS_DIR || d2 === NO_PREVIOUS_DIR || !(d1 === d2 || d1 === (OPPOSITE[d2] as number))`. Measured: **1.85× blocked car-ticks on demo, 13.8× on city** against today. **Cost:** one exported function and a fail-closed case that needs its own two tests.

**Arm C — a relief-driven harness.** Keep the wide rule and repair `demoAllocation.test.ts` by shortening its window or by giving the demo board relief. **Cost, and it is disqualifying:** the only relief that exists is the roundabout, which is Task 9, and a Task 3 that depends on Task 9 is the fork being discovered inside Task 9 — the exact thing this task exists to prevent. Shortening the window instead trades away profiling coverage to hide a balance change, which is the catalogue's *"a harness's liveness check kept alive by the very defect it is measuring"* in reverse.

### The criterion, stated before the measurement

An arm ships iff **all five** hold. The load floors are in it precisely because a survivability criterion with no load floor is satisfiable by deleting the difficulty.

1. **The demo rig has margin.** `WARMUP_FRAMES + WINDOW_COUNT * PROFILED_FRAMES` frames of driving ends at a tick at least **10 %** below the arm's own re-measured `DEMO_DEATH_TICK`, with `isGameOver` false after the final drive. (3.6 % was already too tight; this task raises the bar it inherited.)
2. **The city board still has the problem.** Blocked car-ticks on the shipped seed's greedy arm are **at least 10×** today's 2,120.
3. **The demo board still has load.** Longest queue ≥ 4 and completed trips ≥ 200 over its run.
4. **The city board still has a bad corner.** At least three distinct cells each carry ≥ 5 % of the run's refusals — i.e. the effect is *concentrated*, which is what makes a 3×3 object the right fix. A rule that spreads refusals uniformly over forty cells cannot be relieved by one roundabout, and Task 9 would be built on sand.
5. **No golden moves except `3152640907`, and only under arm A.**

**The plan's prediction is arm B**, and it is written here so a disagreement is a finding rather than a fill-in. Two reasons: it is the more faithful reading of §5.5 (*"collides with"*, not *"is co-present with"*), and it is the only arm that leaves the one board a human has played alone. **If arm B fails criterion 2 or 4, ship arm A** — the wide rule with a demo layout change — and record the failure. **Do not ship arm C.**

- [ ] **Step 1: Commit the tree, then build the three-arm rig**

Add `packages/game/test/junctionArms.ts`, exporting one function per arm that drives the shipped city's greedy arm and the demo board's no-input arm and returns `{ deathTick, trips, blockedCarTicks, longestQueue, refusalsByCell }`. **One rig, three arms, driven in one run** — the catalogue's *"measure both variants in the same run"*, so a difference cannot be a difference between two rigs.

- [ ] **Step 2: Reproduce an inherited number before contradicting anything**

Before believing the rig about any arm, run it with the junction clause **disabled** and assert it reproduces the pre-M1f figures exactly: death 31,456, trips 747, blocked car-ticks 2,120, `H_ROUTES_REFUSED` 0.

Run: `pnpm --filter @laneways/game test -- junctionArms`
Expected: those four exactly. **A rig that disagrees with the record is more likely to be wrong than the record is** — this project has caught its own harness this way twice, both times by omitting the warm start or the opening stroke.

- [ ] **Step 3: Measure all three arms and fill the criterion table**

Record, per arm, the five criteria's five quantities plus `DEMO_DEATH_TICK`, `CITY_DEATH_TICK` and the top five cells by refusal share. Put the table in the task report.

- [ ] **Step 4: Apply the criterion, in writing, before editing anything**

State which arm passes, which criteria each arm failed, and whether the prediction held. **If the prediction did not hold, say so in the report's first line** — a prediction that is quietly replaced by its outcome is worth nothing.

- [ ] **Step 5: Implement the winning arm**

For **arm B**: add `crossesAt` to `blocking.ts` with the doc comment above, change `canEnter`'s junction clause to

```ts
  const other = isJunctionCell(state, cell)
    ? (state.occupancy[occupancySlot(cell, otherLane(lane))] as number)
    : FREE
  const blocked =
    own !== FREE || (other !== FREE && crossesDirections(dir, crossesAt(state, other)))
  if (!blocked) return EnterOutcome.ENTER_FREE
```

and add `crossesDirections(a: number, b: number): boolean` beside it, total over `[0, DIR_COUNT)` plus `NO_PREVIOUS_DIR`, fail-closed on the sentinel.

For **arm A**: edit the demo layout, re-bless `3152640907` with the prior value in a comment at **both** its assertion sites, and re-derive `demoLayout.test.ts`'s hand-computed figures rather than re-fitting them.

- [ ] **Step 6: Write the arm's own tests**

Arm B needs, at minimum: a same-axis pair admitted at a junction; a crossing pair refused; a `NO_PREVIOUS_DIR` occupant refusing (fail-closed) with the fixture's off-manifold posture asserted; `crossesDirections` tested against **all 64 ordered direction pairs plus both sentinel positions**, with the count asserted against `DIR_COUNT * DIR_COUNT` so a shortened table fails rather than passing quietly.

- [ ] **Step 7: Re-run Task 2's 18 repaired tests and Task 1's census**

The census's 271 is a property of the board, not of the rule, so it must be **unchanged** by this task. If it moved, the census is measuring the rule rather than the board and its definition is wrong.

- [ ] **Step 8: Repair `demoAllocation.test.ts` and raise its margin assertion to 10 %**

Update the three knob-mutation rows in its comment (`WINDOW_COUNT` 3 → 4, `PROFILED_FRAMES` → 2000, `PROFILED_FRAMES` → 3100) against the new numbers, by running each, not by scaling the old ones.

- [ ] **Step 9: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS everywhere, no exceptions this time.

- [ ] **Step 10: Mutation-test the winning arm**

Under arm B, at minimum: `crossesDirections` returning `true` always (≥ 1, the same-axis test); returning `false` always (≥ 1, the crossing test); the `NO_PREVIOUS_DIR` clause deleted (≥ 1, fail-closed test); `crossesAt` reading `carRouteCursor` instead of going through `previousLegDir` (≥ 1 — this is the reconstruction mutant and it must not be equivalent).

- [ ] **Step 11: Commit, naming the arm and the criteria it passed**

---

## Task 4: The buffer shape, and a draw that does not touch the RNG — the guard lands before the hazard

**This is the milestone's only shape change.** Every task after it appends behaviour, never shape.

**Observability:** nothing. Four header slots and one all-zero region; no code reads any of them until Task 5, and nothing on screen moves. **Eight of the nine goldens move for pure layout; `252514232` (field) does not, because it hashes flow fields rather than the buffer.**

**Files:**
- Modify: `packages/sim/src/state.ts`, `packages/sim/src/regions.ts`, `packages/sim/src/rng.ts`
- Create: `packages/sim/src/cards.ts`, `packages/sim/test/cards.test.ts`, `packages/sim/test/m1fSplice.ts`, `packages/sim/test/m1fSplice.test.ts`
- Modify: `packages/sim/src/index.ts`, `packages/sim/test/m1eSplice.ts`
- Test/re-bless: `packages/sim/test/determinism.test.ts`, `state.test.ts`, `regions.test.ts`, `loop.test.ts`, `rollback.test.ts`, `cars.test.ts`, `packages/game/test/startingCity.test.ts`, `demoLayout.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–3.
- Produces, all from `packages/sim`:
  - `H_OFFER_A = 13`, `H_OFFER_B = 14`, `H_OFFER_WEEK = 15`, `H_INV_ROUNDABOUT = 16`, `HEADER_LENGTH = 17` (`state.ts`)
  - `offerPending(state: GameState): boolean`, `offerSlot(state: GameState, slot: number): number` (`state.ts`)
  - a `roundabout` region, `Uint8Array` of `cells`, on `GameState` (`regions.ts`)
  - `mixWord(t: number): number` (`rng.ts`)
  - `CARD_NONE = 0`, `CARD_ROAD_TILES = 1`, `CARD_BRIDGE = 2`, `CARD_TUNNEL = 3`, `CARD_ROUNDABOUT = 4`, `CARD_TRAFFIC_LIGHTS = 5`, `CARD_MOTORWAY = 6`, `CARD_COUNT = 7`, `OFFER_SLOT_A = 0`, `OFFER_SLOT_B = 1` (`cards.ts`)
  - `offerSeedFor(state: GameState, week: number): number`, `nthSetBit(mask: number, k: number): number`, `popCountCards(mask: number): number`, `drawOfferPair(pool: number, seed: number, out: Int32Array): void` (`cards.ts`)
- Task 5 consumes `drawOfferPair` and the header slots; Task 6 consumes `offerPending`; Task 9 consumes the `roundabout` region and `H_INV_ROUNDABOUT`; Task 10 consumes `CARD_*` and the mask helpers.

- [ ] **Step 1: Land the two determinism guards FIRST, and prove them green at HEAD**

Add to `packages/sim/test/determinism.test.ts`'s `RULES` array:

```ts
  {
    name: 'RNG consumption outside rng.ts',
    // The offer draw must be a pure function of `rng[0]` and the week. Measured:
    // ONE `nextRandom` per week boundary moves the greedy arm's death tick
    // 31,456 -> 34,088, freezes `spawn.test.ts` at 2,640,000 and fails Gate C —
    // because every downstream draw shifts by one. `spawn.ts` already reads the
    // word without advancing it, for the same reason and with the reason at the
    // site. This rule makes that a property of the package rather than of two
    // people remembering.
    re: /\b(?:nextRandom|randomBelow)\s*\(/,
    why: 'a consumer that draws on a schedule couples every later draw to that schedule',
    hits: ['const v = nextRandom(state.rng, 0)', 'randomBelow (store, 0, 6)'],
    misses: ['const v = mixWord(state.rng[0] as number)', 'export function nextRandom(store, i)'],
  },
```

This rule must exempt `sim/src/rng.ts`, which defines both. Follow `flowfield.ts`'s exemption exactly: a separate `describe` with its own filtered file list, an assertion that the filter excludes **exactly** `sim/src/rng.ts` and nothing else, and an assertion that `rng.ts` itself **does** contain a hit so the exclusion is proved non-vacuous.

Add a second, behavioural guard:

```ts
  it('a full multi-week run never advances state.rng[0]', () => {
    const rig = bootCity()
    const before = rig.s.rng[0] as number
    for (let t = 0; t < TICKS_PER_WEEK * 3; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.rng[0], 'the seed word is read, never consumed').toBe(before)
    // Vacuity: a run that did nothing would satisfy this trivially.
    expect(rig.s.header[H_TICK]).toBe(TICKS_PER_WEEK * 3)
    expect(rig.s.header[H_HOUSE_COUNT], 'and the spawner really ran').toBeGreaterThan(3)
  })
```

- [ ] **Step 2: Run both guards at HEAD and confirm GREEN**

Run: `pnpm --filter @laneways/sim test -- determinism`
Expected: **PASS.** The guard is landing before the hazard, so it must be satisfied by the tree that does not yet contain the thing it guards. Then prove its teeth: temporarily add `const v = nextRandom(state.rng, 0)` to `week.ts`, re-run, watch **both** the scan and the invariance test go red, and revert (commit first; chain the restore and its report with `&&`).

- [ ] **Step 3: Commit the guards alone**

```bash
git add packages/sim/test/determinism.test.ts
git commit -m "test(sim): ban RNG consumption outside rng.ts, and pin rng[0] invariance

Landed before the code that could violate it. One nextRandom per week boundary
moves the greedy death tick 31,456 -> 34,088 and freezes spawn.test.ts at
2,640,000; the offer draw two tasks from now must be a pure function of the seed
word and the week. Both guards are green at this commit and their teeth were
proved by a reverted injection into week.ts.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8"
```

- [ ] **Step 4: Extract `mixWord` from `nextRandom` with byte-identical output**

`packages/sim/src/rng.ts`:

```ts
/**
 * mulberry32's OUTPUT TRANSFORM, with no state. `nextRandom` is exactly this
 * applied to the advanced word.
 *
 * **Extracted at M1f Task 4 so there is one copy of this arithmetic rather than
 * two.** The weekly offer needs a well-mixed value from the seed word and the
 * week WITHOUT advancing the stream — see `offerSeedFor` (cards.ts) and
 * `determinism.test.ts`'s ban on `nextRandom` outside this file. Writing the
 * three lines again there would be a second implementation of the one function
 * whose output every replay depends on.
 *
 * **The extraction is output-preserving and `rng.test.ts`'s sequence golden is
 * the proof**, not this comment: the previous body assigned the advanced word to
 * a local and applied these three statements to it in place, which is what this
 * function does to its parameter.
 */
export function mixWord(t0: number): number {
  let t = t0 >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return (t ^ (t >>> 14)) >>> 0
}

export function nextRandom(store: Uint32Array, i: number): number {
  assertStreamIndex(store, i)
  const t = (store[i] = (((store[i] as number) + 0x6d2b79f5) | 0) >>> 0)
  return mixWord(t)
}
```

Add to `packages/sim/test/rng.test.ts`:

```ts
  it('mixWord is exactly the transform nextRandom applies to its advanced word', () => {
    const store = new Uint32Array([12345])
    const advanced = ((12345 + 0x6d2b79f5) | 0) >>> 0
    expect(nextRandom(store, 0)).toBe(mixWord(advanced))
    expect(store[0], 'and nextRandom advanced the store while mixWord touched nothing').toBe(advanced)
  })
```

Run: `pnpm --filter @laneways/sim test -- rng`
Expected: PASS, including the existing sequence golden. **If the sequence golden moves, the extraction is not output-preserving — stop.**

- [ ] **Step 5: Write the failing tests for the draw**

Create `packages/sim/test/cards.test.ts`:

```ts
describe('the offer draw is a pure function of the seed word and the week', () => {
  it('does not touch rng[0]', () => {
    const s = createState('laneways-m2', firstCity())
    const before = s.rng[0] as number
    offerSeedFor(s, 1)
    offerSeedFor(s, 2)
    expect(s.rng[0]).toBe(before)
  })

  it('gives a different word for each week, and the same word for the same week', () => {
    const s = createState('laneways-m2', firstCity())
    const w1 = offerSeedFor(s, 1)
    expect(offerSeedFor(s, 1), 'idempotent').toBe(w1)
    const seen = new Set<number>()
    for (let w = 1; w <= 40; w++) seen.add(offerSeedFor(s, w))
    expect(seen.size, '40 weeks, 40 distinct words').toBe(40)
  })

  it('gives a different word for a different seed at the same week', () => {
    const a = createState('laneways-m2', firstCity())
    const b = createState('some-other-seed', firstCity())
    expect(offerSeedFor(a, 1)).not.toBe(offerSeedFor(b, 1))
  })
})

describe('nthSetBit and popCountCards', () => {
  it('agrees with a brute-force scan on every mask a CARD_COUNT-bit pool can hold', () => {
    for (let mask = 0; mask < 1 << CARD_COUNT; mask++) {
      const bits: number[] = []
      for (let b = 0; b < CARD_COUNT; b++) if ((mask & (1 << b)) !== 0) bits.push(b)
      expect(popCountCards(mask), `popcount of ${mask}`).toBe(bits.length)
      for (let k = 0; k < bits.length; k++) {
        expect(nthSetBit(mask, k), `bit ${k} of ${mask}`).toBe(bits[k])
      }
    }
  })

  it('throws rather than returning a plausible index when k is past the end', () => {
    expect(() => nthSetBit(0b0110, 2)).toThrow(/only 2 set bits/)
    expect(() => nthSetBit(0, 0)).toThrow(/only 0 set bits/)
  })
})

describe('drawOfferPair', () => {
  const out = new Int32Array(2)

  it('draws two DISTINCT cards from the pool', () => {
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_ROUNDABOUT) | (1 << CARD_BRIDGE)
    for (let seed = 0; seed < 500; seed++) {
      drawOfferPair(pool, seed, out)
      expect(out[0], `seed ${seed} slot A in pool`).not.toBe(out[1])
      expect((pool & (1 << (out[0] as number))) !== 0, `seed ${seed} slot A in pool`).toBe(true)
      expect((pool & (1 << (out[1] as number))) !== 0, `seed ${seed} slot B in pool`).toBe(true)
    }
  })

  it('reaches both orders on a two-card pool, which is the shipped case', () => {
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_ROUNDABOUT)
    let aFirst = 0
    for (let seed = 0; seed < 200; seed++) {
      drawOfferPair(pool, seed, out)
      if (out[0] === CARD_ROAD_TILES) aFirst++
    }
    // The only randomness the shipped pool has is the ORDER, and without it a
    // player learns "slot A is always tiles" in two weeks. A hard bound rather
    // than a proportion: 200 draws that all come out the same way is the defect.
    expect(aFirst, 'both orders occur').toBeGreaterThan(20)
    expect(aFirst, 'both orders occur').toBeLessThan(180)
  })

  it('covers every card of a four-card pool across enough draws', () => {
    const pool =
      (1 << CARD_ROAD_TILES) | (1 << CARD_ROUNDABOUT) | (1 << CARD_BRIDGE) | (1 << CARD_TUNNEL)
    const seen = new Set<number>()
    for (let seed = 0; seed < 400; seed++) {
      drawOfferPair(pool, seed, out)
      seen.add(out[0] as number)
      seen.add(out[1] as number)
    }
    expect(seen.size, 'the rejection path reaches every card, not just the low bits').toBe(4)
  })

  it('is deterministic: the same seed and pool give the same pair', () => {
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_ROUNDABOUT) | (1 << CARD_BRIDGE)
    drawOfferPair(pool, 987654, out)
    const first = [out[0], out[1]]
    drawOfferPair(pool, 987654, out)
    expect([out[0], out[1]]).toEqual(first)
  })

  it('throws on a pool with fewer than two cards, rather than offering one twice', () => {
    expect(() => drawOfferPair(1 << CARD_ROAD_TILES, 1, out)).toThrow(/needs at least two/)
    expect(() => drawOfferPair(0, 1, out)).toThrow(/needs at least two/)
  })

  it('allocates nothing', () => {
    // The production caller is a step phase. `out` is caller-owned for exactly
    // that reason; this pins the reason.
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_ROUNDABOUT)
    expect(drawOfferPair(pool, 1, out)).toBeUndefined()
  })
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @laneways/sim test -- cards`
Expected: FAIL, "Cannot find module '../src/cards'".

- [ ] **Step 7: Write `cards.ts`'s draw half**

```ts
import { DIR_COUNT } from './roads'
import { mixWord } from './rng'
import { H_WEEK, type GameState } from './state'

/**
 * §5.10's card pool, its non-consuming weekly draw, and the `choose-card`
 * input. **The offer slots live in the header and this module is their only
 * writer.**
 *
 * Card ids are the SIX in §5.10's table, declared in full rather than only the
 * two M1f can offer, because they are an enumeration of a documented domain
 * rather than speculative configuration. What keeps the four unimplemented ones
 * out of play is `CARD_IMPLEMENTED_MASK` (M1f Task 10) — a scope gate with a
 * named owner — and not their absence, so a card that acquires a placement
 * mechanism becomes offerable by deleting a bit rather than by re-deriving an
 * enum.
 *
 * `CARD_NONE = 0` is load-bearing: `H_OFFER_A`/`H_OFFER_B` are zero-initialised
 * and must read as "no offer" without `createState` writing a sentinel.
 */

export const CARD_NONE = 0
export const CARD_ROAD_TILES = 1
export const CARD_BRIDGE = 2
export const CARD_TUNNEL = 3
export const CARD_ROUNDABOUT = 4
export const CARD_TRAFFIC_LIGHTS = 5
export const CARD_MOTORWAY = 6
/** One past the highest card id. The pool bitmask is `CARD_COUNT` bits wide; bit 0 is never set. */
export const CARD_COUNT = 7

export const OFFER_SLOT_A = 0
export const OFFER_SLOT_B = 1

/**
 * A well-mixed word for `week`'s offer, derived from the seed **without
 * advancing it**.
 *
 * The golden-ratio odd constant decorrelates adjacent weeks before mixing, so
 * weeks 1 and 2 do not produce neighbouring inputs to a function that is only
 * an avalanche and not a stream. `week + 1` rather than `week` so week 0 —
 * which has no offer — is not the identity case.
 *
 * **Why not `nextRandom`:** measured, one draw per week boundary moves the
 * greedy arm's death tick 31,456 -> 34,088, freezes `spawn.test.ts` at
 * 2,640,000 and fails Gate C, because every downstream consumer shifts by one.
 * `spawnScanStart` (spawn.ts) reads the word the same way for the same reason.
 * `determinism.test.ts` bans the alternative outright.
 */
export function offerSeedFor(state: GameState, week: number): number {
  return mixWord(((state.rng[0] as number) ^ Math.imul(week + 1, 0x9e3779b1)) >>> 0)
}

/** How many cards a pool bitmask holds. */
export function popCountCards(mask: number): number {
  let n = 0
  for (let b = 0; b < CARD_COUNT; b++) if ((mask & (1 << b)) !== 0) n++
  return n
}

/**
 * The `k`-th set bit of `mask`, counting from 0.
 *
 * Throws rather than returning -1 or 0: a caller that has already asked
 * `popCountCards` cannot legitimately be past the end, and both plausible
 * sentinels are valid card ids or read as one (`CARD_NONE`).
 */
export function nthSetBit(mask: number, k: number): number {
  let seen = 0
  for (let b = 0; b < CARD_COUNT; b++) {
    if ((mask & (1 << b)) === 0) continue
    if (seen === k) return b
    seen++
  }
  throw new Error(`cards: asked for set bit ${k} of pool ${mask}, which has only ${seen} set bits`)
}

/**
 * Fills `out[0]`/`out[1]` with two DISTINCT card ids drawn from `pool`.
 *
 * **Rejection sampling, over a bitmask, with no array.** A plain modulo
 * over-represents the low card ids whenever the pool size does not divide 2^32,
 * and a skewed offer distribution is invisible in play while quietly
 * invalidating every balance measurement built on it — the same argument
 * `randomBelow` (rng.ts) makes, reached here without a stream. `no-module-mutable-state`
 * forbids a module-scope candidate array and a local one allocates on a per-tick
 * path, so the pool IS the array and `nthSetBit` is the index.
 *
 * Successive words come from re-mixing the previous one, so the rejection loop
 * needs no counter and no storage. The loop terminates because `mixWord` is a
 * bijection on 32 bits and at most `2^32 % n` of the inputs are rejected.
 *
 * `out` is caller-owned and length 2. Slot A is drawn first from the whole
 * pool; slot B from the pool with A's bit cleared, which is what makes the two
 * distinct **by construction** rather than by a retry loop that could spin.
 */
export function drawOfferPair(pool: number, seed: number, out: Int32Array): void {
  const n = popCountCards(pool)
  if (n < 2) {
    throw new Error(`cards: an offer needs at least two cards, and pool ${pool} holds ${n}`)
  }
  let word = seed >>> 0
  const a = pickFromPool(pool, n, word)
  out[0] = a
  word = mixWord(word)
  const rest = pool & ~(1 << a)
  out[1] = pickFromPool(rest, n - 1, word)
}

/**
 * One unbiased card from `pool`, which holds exactly `n` cards, starting from
 * `word`. Exported for the rejection path's own test — the bound at which
 * rejection actually happens is unreachable from `drawOfferPair`'s two- to
 * six-card pools in any realistic number of draws.
 */
export function pickFromPool(pool: number, n: number, word: number): number {
  const limit = 0x100000000 - (0x100000000 % n)
  let v = word >>> 0
  while (v >= limit) v = mixWord(v)
  return nthSetBit(pool, v % n)
}
```

- [ ] **Step 8: Run the card tests, then add `cards.ts` to the determinism file list**

Run: `pnpm --filter @laneways/sim test -- cards`
Expected: PASS.

Add `'sim/src/cards.ts'` to `determinism.test.ts`'s sorted file list with a comment saying why a new file must be added deliberately. Re-run the determinism suite.

- [ ] **Step 9: Declare the four header slots**

`packages/sim/src/state.ts`:

```ts
/**
 * The card offered in slot A this week, or `CARD_NONE`. Written only by
 * `runOffer` (cards.ts), read by `offerSlot` below and by nothing else.
 */
export const H_OFFER_A = 13
/** The card offered in slot B. Always a different card from `H_OFFER_A`. */
export const H_OFFER_B = 14
/**
 * The week whose offer has been RESOLVED — i.e. whose card the player took.
 *
 * **This one slot is the whole mechanism for BOTH "one card per week" and
 * "already chosen this week", and a second flag would be a defect rather than
 * a clarification.** With two flags — "an offer exists" and "it has been taken"
 * — neither half can have a detector of its own, because either alone upholds
 * the invariant; a mutation table would then show two survivors that are not
 * coverage holes. One flag, one meaning, one test.
 *
 * Zero-initialised is correct with no write in `createState`: it means week 0,
 * and week 0 has no offer, so "resolved through week 0" and "nothing resolved
 * yet" are the same statement.
 */
export const H_OFFER_WEEK = 15
/**
 * Roundabouts held and not yet placed (§2.2's inventory). `Int32`, so the
 * `Uint8Array`-decrement wrap class does not apply — and it is decremented, in
 * `applyPlaceRoundabout` (roundabout.ts, M1f Task 9).
 */
export const H_INV_ROUNDABOUT = 16
export const HEADER_LENGTH = 17
```

and the two accessors, in the idiom `isGameOver`/`failedDestination` already set:

```ts
/**
 * Is a card offer waiting for the player?
 *
 * Read by `runOffer` (to decide whether to raise one), by `applyChooseCard` (to
 * no-op a duplicate) and by `game`'s frame driver (to raise the pause). Week 0
 * is excluded because the first boundary is the START of week 1.
 */
export function offerPending(s: GameState): boolean {
  const week = s.header[H_WEEK] as number
  return week > 0 && (s.header[H_OFFER_WEEK] as number) !== week
}

/**
 * The card in slot 0 or 1, or `CARD_NONE` when no offer is pending — so no
 * caller can read a stale card off a resolved week. Same construction as
 * `failedDestination`'s -1, and for the same reason.
 */
export function offerSlot(s: GameState, slot: number): number {
  if (!offerPending(s)) return 0
  if (slot === 0) return s.header[H_OFFER_A] as number
  if (slot === 1) return s.header[H_OFFER_B] as number
  throw new Error(`state: offer slot ${slot} is not 0 or 1`)
}
```

- [ ] **Step 10: Declare the `roundabout` region**

`packages/sim/src/regions.ts`, appended to the **end** of the `Uint8` tier, after `ghostCommitted`:

```ts
    // M1f Task 4, appended to the END of the Uint8 tier so no pad byte can be
    // inserted anywhere (a 1-byte tier is a multiple of every alignment below
    // it, and 14,968 is still a multiple of 4). This is the LAST region this
    // milestone adds: "Which goldens move, exactly" fixes the shape at 30
    // regions and 14,968 B for `firstCity`, and every task after this one
    // appends behaviour, never shape.
    //
    // **An APPEND, not an insertion** — unlike the four header slots landing in
    // the same commit, which grow a mid-tier region. `m1fSplice.ts` depends on
    // knowing which is which.
    //
    // One code per cell: `RA_NONE`, `RA_ENTRY`, `RA_CORNER`, `RA_CENTRE`
    // (roundabout.ts, M1f Task 9). It is a CODE and not a boolean because the
    // four entry cells may carry a road out of the block and the four corners
    // may not, and `canPlaceRoad` has to tell them apart with one array read
    // rather than by locating the centre.
    //
    // FIELD_IRRELEVANT: a roundabout changes a car's SPEED and its right to
    // enter a cell, never the distance of a step. Routing is roundabout-blind
    // for exactly the reason it is congestion-blind — see the 2026-08-20
    // amendment to spec §5.4.
    { name: 'roundabout', ctor: Uint8Array, len: cells },
```

Add `'roundabout'` to `FIELD_IRRELEVANT_REGIONS`. `regions.test.ts`'s union assertion forces this; do not skip it and let the union test tell you.

- [ ] **Step 11: Extend the splice proof, in two directions**

Create `packages/sim/test/m1fSplice.ts`, in `m1eSplice.ts`'s shape, exporting `m1fInsertedRanges(map)` returning the two M1f ranges — block A the four new header slots (`header.offset + 13 * 4` to `header.offset + 17 * 4`), block B the `roundabout` region — with the same four structural guards (`header.len === HEADER_LENGTH`; `roundabout` is the LAST entry in the layout; both ranges non-empty, disjoint, in order, inside `totalBytes`), each throwing by name, each reachable from a synthetic layout, and each fed a violation in `m1fSplice.test.ts`.

**And repair `m1eSplice.ts`, which this task silently breaks.** Its block A is `header.offset + M1D_HEADER_LENGTH * 4 .. header.offset + HEADER_LENGTH * 4`, and `HEADER_LENGTH` is now 17, so it would splice out M1f's slots as well and "prove" the pre-M1e digest for the wrong reason. Freeze its upper bound:

```ts
/** `HEADER_LENGTH` as M1e closed it. M1f's slots are `m1fSplice.ts`'s, not this file's. */
export const M1E_HEADER_LENGTH = 13
```

and add a third block for the `roundabout` region, so the composed splice still reproduces the pre-M1e digest. Assert `M1E_HEADER_LENGTH < HEADER_LENGTH` in `m1eSplice.test.ts`, so the day a task grows the header without reading this file, it fails here.

- [ ] **Step 12: Re-bless the eight goldens, each with its splice proof and its direct assertion**

At **each** of the ten assertion sites (`968680755` has two), in one commit:

1. update the literal, with a re-bless comment naming the prior value and the reason, in the form `determinism.test.ts` already uses;
2. add `expect(hashBytes(spliceM1fInsertions(s, MAP))).toBe(<prior digest>)` beside it — **the ranges are computed from that fixture's OWN map**, because the re-blessed fixtures run on five different maps and quoting one map's offsets at another's site reads as a fabricated derivation;
3. update the cross-file literal scan in `loop.test.ts`, which reads `determinism.test.ts` and `rollback.test.ts` off disk and asserts three literals verbatim — **one of which is the field golden and must not change**;
4. update `state.test.ts`'s *"HEADER_LENGTH is exactly 13"* to 17 — this test **must** go red and be re-derived, not widened;
5. update `regions.test.ts`: `totalBytes`, the ordered region-name list, the per-region element counts and the FIELD_INPUT exact-set pin. The parameterised staleness test needs no update and is doing real work for free — it pokes one byte of **every declared region** and asserts `hashFieldInputRegions` moves iff that region is FIELD_INPUT, so `roundabout` is covered the moment it is declared;
6. update the prose sites that quote a retired digest and that no test reads: grep the whole repo for each prior digest and fix every hit. **A stale digest in a comment passes every test and reads as verified.**

- [ ] **Step 13: Assert the behavioural observables unchanged, in the same commit**

The third class of re-bless carries no behavioural claim, so it must borrow one. In `packages/game/test/integration.test.ts`, in the same commit, assert the greedy arm's death tick, trip count and `H_ROUTES_REFUSED` are **exactly** what Task 3 left them at. **Without this the re-bless is a blank cheque**: a genuine regression landing in this commit is absorbed with no trace.

- [ ] **Step 14: Re-measure the eight `yes` cells by DIGEST, not by red test**

Several golden tests abort on a buffer-length pin sitting **above** their `expect(hashState(...))` line. Relax those pins, re-run, and record the digest each fixture actually produces. **A `no` needs no re-check; every `yes` does.** Confirm `252514232` is green and untouched.

- [ ] **Step 15: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS.

- [ ] **Step 16: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `offerSeedFor`: drop `^ Math.imul(week + 1, …)` | ≥ 1, in *"40 weeks, 40 distinct words"* |
| 2 | `offerSeedFor`: `week + 1` → `week` | **0 expected** — week 0 has no offer, so the identity case is unreachable. Record as deliberate; the `+ 1` is there so the function is total, not because a caller needs it |
| 3 | `offerSeedFor`: `mixWord(...)` → the raw xor | ≥ 1, in *"a different word for a different seed"* is NOT enough — add an avalanche assertion if it survives |
| 4 | `drawOfferPair`: draw B from `pool` instead of `rest` | ≥ 1, in *"two DISTINCT cards"* |
| 5 | `drawOfferPair`: do not re-mix between A and B | ≥ 1 — with the same word both picks correlate; the two-card order test is the detector |
| 6 | `pickFromPool`: `v % n` with no rejection | **likely 0** at these pool sizes, and that is the honest answer. Record it, and note that the rejection path's justification is the bias argument rather than a detector — the same shape as `randomBelow`'s own |
| 7 | `nthSetBit`: `seen === k` → `seen >= k` | ≥ 1, in the exhaustive agreement test |
| 8 | `nthSetBit`: return -1 instead of throwing | ≥ 1, in the past-the-end test |
| 9 | `offerPending`: drop `week > 0` | ≥ 1 — a week-0 offer would raise the modal before the first boundary |
| 10 | `offerSlot`: return the slot without the pending check | ≥ 1 |
| 11 | `regions.ts`: `roundabout` declared `len: 1` | ≥ 1, in `regions.test.ts` |

- [ ] **Step 17: Commit**

```bash
git add packages/sim packages/game
git commit -m "feat(sim): the offer's four header slots, the roundabout region, and a draw that reads the seed without spending it

HEADER_LENGTH 13 -> 17 (H_OFFER_A, H_OFFER_B, H_OFFER_WEEK, H_INV_ROUNDABOUT)
and one Uint8 region, `roundabout`, sized cells. firstCity's buffer goes
13,992 -> 14,968 B and regionsFor goes 29 -> 30. This is the milestone's ONLY
shape change; every later task appends behaviour.

Eight goldens re-blessed for PURE LAYOUT, each with a splice proof over its own
map's ranges beside the digest, and the greedy arm's death tick, trips and
refusals asserted unchanged in this same commit — the third class of re-bless
carries no behavioural claim of its own, so it borrows one. 252514232 (field)
does not move: it hashes flow fields, not the buffer.

The draw is offerSeedFor(state, week) = mixWord(rng[0] ^ imul(week+1, GOLDEN)),
which reads the seed word and never advances it. mixWord is mulberry32's output
transform extracted from nextRandom so there is one copy of that arithmetic;
rng.test.ts's sequence golden is the proof it is output-preserving. Selection is
rejection over a CARD_COUNT-bit mask with no array. The two guards that make
this a rule rather than a memory landed in the previous commit, green.

H_OFFER_WEEK === H_WEEK is the SINGLE mechanism for both 'one card per week' and
'already chosen'. A second flag would leave neither half with a detector.

Prior digests: <ten pairs>.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8"
```

---

## Task 5: Phase 4 — the offer — and the eleven-phase sweep

**Observability:** nothing a player can see. The offer slots fill at every week boundary from 2:21 onward and nothing draws them until Task 8. Say so; do not let a green suite here read as a shipped feature.

**Files:**
- Modify: `packages/sim/src/cards.ts` (`runOffer`), `packages/sim/src/step.ts` (the phase and the renumbering)
- Modify: every source file and doc that names a phase number above 3
- Test: `packages/sim/test/cards.test.ts`, `step.test.ts`, `loop.test.ts`, `determinism.test.ts`

**Interfaces:**
- Consumes: `drawOfferPair`, `offerSeedFor`, `offerPending`, the four header slots (Task 4).
- Produces: `runOffer(state: GameState, world: WorldData, scratch: Scratch): void`, exported from `cards.ts`, matching `runDemand`/`runSpawn`/`runOvercrowd`'s `void` shape. It takes `scratch` for the same reason `runSpawn` does: the draw needs a caller-owned two-element `Int32Array` and `Scratch` is where per-tick scratch lives. Task 10 gives `poolFor(world)` its capability half; until then `runOffer` calls a placeholder-free two-card `poolFor` that Task 10 widens.

- [ ] **Step 1: Write the failing tests for the phase**

Add to `packages/sim/test/cards.test.ts`:

```ts
describe('runOffer — phase 4', () => {
  it('raises nothing in week 0', () => {
    const rig = bootCity()
    for (let t = 0; t < 100; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_OFFER_A]).toBe(CARD_NONE)
    expect(rig.s.header[H_OFFER_B]).toBe(CARD_NONE)
    expect(offerPending(rig.s)).toBe(false)
  })

  it('raises an offer on the first tick of week 1 and not before', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK - 1)
    expect(rig.s.header[H_OFFER_A], 'still week 0').toBe(CARD_NONE)
    step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_TICK]).toBe(TICKS_PER_WEEK)
    expect(rig.s.header[H_WEEK]).toBe(1)
    expect(offerPending(rig.s)).toBe(true)
    expect(rig.s.header[H_OFFER_A]).not.toBe(CARD_NONE)
    expect(rig.s.header[H_OFFER_B]).not.toBe(rig.s.header[H_OFFER_A])
  })

  it('matches the pair drawOfferPair gives for this seed and week, computed independently', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const out = new Int32Array(2)
    drawOfferPair(poolFor(rig.world), offerSeedFor(rig.s, 1), out)
    expect(rig.s.header[H_OFFER_A]).toBe(out[0])
    expect(rig.s.header[H_OFFER_B]).toBe(out[1])
  })

  it('is IDEMPOTENT: re-raising the same week rewrites the same pair', () => {
    // This is what lets ONE flag do both jobs. If the draw were not a pure
    // function of (seed word, week), the modal's contents would change under
    // the player between the boundary tick and the tick the pause lands on.
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const a = rig.s.header[H_OFFER_A]
    const b = rig.s.header[H_OFFER_B]
    for (let t = 0; t < 50; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_OFFER_A]).toBe(a)
    expect(rig.s.header[H_OFFER_B]).toBe(b)
  })

  it('replaces an unresolved offer at the next boundary, and the old card is lost', () => {
    // Only reachable from a Worker replaying a log with no choice in it — a
    // browser is paused. Deterministic, and it is what 'no bank, no skip' means.
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const week1 = [rig.s.header[H_OFFER_A], rig.s.header[H_OFFER_B]]
    driveTo(rig, TICKS_PER_WEEK * 2)
    expect(rig.s.header[H_WEEK]).toBe(2)
    expect(offerPending(rig.s), 'still pending, now for week 2').toBe(true)
    const out = new Int32Array(2)
    drawOfferPair(poolFor(rig.world), offerSeedFor(rig.s, 2), out)
    expect([rig.s.header[H_OFFER_A], rig.s.header[H_OFFER_B]]).toEqual([out[0], out[1]])
    expect([rig.s.header[H_OFFER_A], rig.s.header[H_OFFER_B]], 'week 1 is gone').not.toEqual(week1)
  })

  it('raises nothing after game over', () => {
    const rig = bootTerminal()
    const before = hashState(rig.s)
    for (let t = 0; t < TICKS_PER_WEEK; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(hashState(rig.s), 'step is a byte-identical no-op past the failure').toBe(before)
  })

  it('writes H_TILES never, so phases 2 and 4 are disjoint by construction', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK - 1)
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_TILES], 'the boundary granted exactly the weekly tiles').toBe(
      tiles + WEEKLY_TILE_GRANT,
    )
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @laneways/sim test -- cards`
Expected: FAIL — `runOffer` and `poolFor` do not exist.

- [ ] **Step 3: Write `runOffer` and the interim `poolFor`**

In `cards.ts`:

```ts
/**
 * The set of cards this map and this build can offer, as a bitmask.
 *
 * **Two filters with two reasons, and M1f Task 10 lands the first one.** Until
 * then this is the second filter alone: `CARD_IMPLEMENTED_MASK`, M1f's scope
 * boundary. An offerable card with no placement mechanism is dead configuration
 * that reads as support; this constant is the interlock that stops one
 * shipping, and M1g deletes bits from it.
 */
export const CARD_IMPLEMENTED_MASK = (1 << CARD_ROAD_TILES) | (1 << CARD_ROUNDABOUT)

export function poolFor(world: WorldData): number {
  return CARD_IMPLEMENTED_MASK
}

/**
 * Phase 4 of the tick order: raise this week's card offer (spec §5.10).
 *
 * **Position, and why both bounds are forced.** AFTER phase 3, because a
 * `choose-card` queued on the boundary tick must resolve THIS week's offer
 * before the phase that would raise one — otherwise the player's own choice
 * arrives one tick late and the modal flickers. BEFORE phase 5, because nothing
 * downstream may observe a half-raised offer and because putting it last would
 * let a whole tick of the new week run before the offer exists.
 *
 * **It writes the two offer slots and NOTHING else.** Phase 2 writes `H_TILES`;
 * the card's own tile bonus is paid by `applyChooseCard` in phase 3. So phases
 * 2 and 4 touch disjoint state BY CONSTRUCTION, and their transposition is
 * inert for a reason a reader can check rather than for a reason a sweep
 * happened to find.
 *
 * **Idempotent, and that is load-bearing rather than an optimisation.** The
 * draw is a pure function of `(rng[0], week)`, so re-running it on every tick of
 * an unresolved week writes the same pair. That is what lets `H_OFFER_WEEK ===
 * H_WEEK` be the single mechanism for both "one per week" and "already chosen":
 * there is no second flag saying "already raised", because raising twice is a
 * no-op. It also means the up-to-7 ticks between the boundary and the shell's
 * pause landing (see `game/src/frame.ts`) cannot change what the player is
 * shown.
 *
 * Nothing here allocates: `scratch.offerPair` is preallocated and `poolFor` is
 * a mask. **The allocation harness structurally cannot see this**, for the same
 * reason it cannot see `runWeekBoundary`'s grant — a handful of events across
 * thousands of driven frames lands under the 4 B/frame floor by construction —
 * so this is an argument, not a measurement, and it is labelled as one.
 */
export function runOffer(state: GameState, world: WorldData, scratch: Scratch): void {
  if (!offerPending(state)) return
  const week = state.header[H_WEEK] as number
  drawOfferPair(poolFor(world), offerSeedFor(state, week), scratch.offerPair)
  state.header[H_OFFER_A] = scratch.offerPair[0] as number
  state.header[H_OFFER_B] = scratch.offerPair[1] as number
}
```

Add `offerPair: new Int32Array(2)` to `createScratch` with a one-line comment saying it is caller-owned output for `drawOfferPair` and why the callee cannot allocate it.

- [ ] **Step 4: Insert the phase and renumber every comment**

In `step.ts`, between the input loop and `runSpawn`:

```ts
  runOffer(s, world, scratch)
```

Then renumber. `step.ts`'s phase table gains a row and every row from the old 4 down shifts by one; **and every phase number above 3 written anywhere else in the repo moves with it.** Find them:

```bash
grep -rn "phase \([4-9]\|10\)\b\|Phase \([4-9]\|10\)\b\|phases \([4-9]\|10\)" packages/ docs/superpowers/ --include=*.ts --include=*.md
```

Fix each by reading what it means, not by adding one blindly — some of them name a pair (`4 <-> 5`), some name a position, and `regions.ts`'s and `blocking.ts`'s references are to phases whose *content* did not move.

**The equivalent-mutant register's one surviving 0-detector row, `4 <-> 5` (spawn against demand), is now `5 <-> 6`.** Rename it at its site in `step.ts` with a sentence saying it was renumbered and by which task, so a reader who greps `4 <-> 5` in a later milestone finds the note rather than nothing.

- [ ] **Step 5: Re-bless the two goldens that move behaviourally, with hand-computed slot values**

The state golden (13,499 ticks, crosses two boundaries) and the demand-pin golden (crosses one) both now carry non-zero offer slots. For each, **before** touching the literal:

```ts
    // The bytes that moved, hand-computed rather than read back. `poolFor` on
    // this fixture's map is CARD_IMPLEMENTED_MASK; the seed word is this
    // fixture's own; the week is 2 at tick 13,499.
    const out = new Int32Array(2)
    drawOfferPair(poolFor(WORLD), offerSeedFor(s, 2), out)
    expect(s.header[H_OFFER_A]).toBe(out[0])
    expect(s.header[H_OFFER_B]).toBe(out[1])
    expect(s.header[H_OFFER_WEEK], 'nothing chose, so nothing resolved').toBe(0)
```

Then update the digest with a re-bless comment naming the prior value and the reason, and update `loop.test.ts`'s cross-file literal scan. **Verify by reading each fixture's run length that no OTHER golden crosses a boundary** — do not take this plan's table for it.

- [ ] **Step 6: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS.

- [ ] **Step 7: Run the complete C(11,2) = 55-pair transposition sweep**

Positional transpositions, with the poison check, `const tick` and both `H_EPOCH` writes excluded as prologue and epilogue. **Four unmutated baselines first, all 0.** Then each of the 55, one at a time, under the canonical invocation.

Three rules this project has learned and one that is new here:

- **Run the CONTROL as many times as the mutant.** The allocation harnesses flake ~10–17 %, and a mutant credited with a kill from `drawAllocation.test.ts` — a file that may not even import the mutated module — is a flake recorded as coverage.
- **Screen crash-vs-kill on lines that are NOT vitest result lines**, and record the matched line so a discard is auditable. Matching an error-class name anywhere in the output has already flagged a valid mutant here, because a test *name* contained the word `TypeError`.
- **Run the complement check**: per-package totals unchanged, or the mutant stopped collection. Sixteen rows collected a short suite last time; a short suite's counts are lower bounds and must be marked as such.
- **A positional transposition at distance ≥ 2 is NOT a swap of two adjacent phases.** It reverses phase `i` against everything between as well. `3 <-> 5` scored 1 in M1e for exactly that reason while the two phases still commuted. Expect non-zero rows that are not commutativity findings, and do not read them as one.

- [ ] **Step 8: Write the table into `step.ts` and predict two rows before running them**

Predict, in writing, before Step 7's results are read:

- **`2 <-> 4`** (week grant against offer) — **predicted 0 detectors**, and the reason is Decision 5's disjointness: phase 2 writes `H_TILES` and reads `H_TICK`; phase 4 writes the two offer slots and reads `H_WEEK` and `rng[0]`. Both are gated on the boundary and neither reads what the other writes. **If it is non-zero, the disjointness claim is false and the tile-bonus placement has to be re-derived.**
- **`3 <-> 4`** (inputs against offer) — **predicted non-zero from Task 6 onward and 0 in THIS task**, because nothing yet enqueues a `choose-card`. Record the 0 here and expect Task 6 to change it; a reader who finds 0 in this table and assumes it still holds after Task 6 has the wrong answer.
- **`5 <-> 6`** (the old `4 <-> 5`) — **predicted 0**, unchanged, and it stays on the equivalent-mutant register with both of its commutation reasons and both tripwires. **Do not manufacture a detector for it**: the only edits that produce one are backdating `destSpawnTick` or routing §5.3.5's push around `fireColour`, and both are the changes the tripwires exist to catch.

- [ ] **Step 9: Mutation-test this task's own tests**

| # | Mutant | Expected |
|---|---|---|
| 1 | `runOffer`: drop the `offerPending` early return | ≥ 1 — a week-0 offer, caught by *"raises nothing in week 0"* |
| 2 | `runOffer`: write `H_OFFER_B` from `offerPair[0]` | ≥ 1, in *"B is not A"* |
| 3 | `runOffer`: pass `week - 1` to `offerSeedFor` | ≥ 1, in the independent-computation test |
| 4 | `runOffer`: also write `H_OFFER_WEEK = week` | ≥ 1 — it would resolve its own offer; caught by *"replaces an unresolved offer"* and by `offerPending` |
| 5 | `step.ts`: call `runOffer` before the input loop | ≥ 1 from Task 6 onward; **0 here**, and record it as such rather than as coverage |
| 6 | `step.ts`: call `runOffer` after `runSpawn` | **0 expected here.** Record it: nothing between them reads the offer slots yet. Task 8's frame fold is what makes the position observable, and Task 11's sweep re-runs it |

- [ ] **Step 10: Commit**

---

## Task 6: `choose-card` as an input, with the echo that detects a divergent replay

**Observability:** nothing yet — no UI enqueues the action. A test can choose a card; a person cannot. Task 8 is what makes it reachable, and this task ships two commits before it deliberately, so the input's semantics can be wrong in a test before they can be wrong on a screen.

**Files:**
- Modify: `packages/sim/src/step.ts` (`TickActionKind`, the dispatch), `packages/sim/src/cards.ts` (`applyChooseCard`, `cardTileGrant`), `packages/shared/src/constants.ts` (the two grants)
- Modify: `packages/game/src/inputs.ts` (nothing structural — `enqueue` already takes a kind and two numbers; confirm and pin)
- Test: `packages/sim/test/cards.test.ts`, `step.test.ts`

**Interfaces:**
- Consumes: `offerPending`, `H_OFFER_*`, `H_INV_ROUNDABOUT`, `CARD_*`, `OFFER_SLOT_A`/`OFFER_SLOT_B` (Task 4); `runOffer` (Task 5).
- Produces: `TickActionKind = 'place' | 'erase' | 'choose-card'`; `applyChooseCard(state: GameState, slot: number, cardId: number): void`; `cardTileGrant(cardId: number): number`; `CARD_GRANT_ROAD_TILES = 30` and `CARD_GRANT_ITEM = 20` in `@laneways/shared`. Task 8's pointer calls `queue.enqueue('choose-card', slot, cardId)`; Task 9 adds a fourth kind.

- [ ] **Step 1: Write the failing tests**

```ts
describe('applyChooseCard — the echo is the replay-divergence detector', () => {
  it('grants the card tiles, sets H_OFFER_WEEK, and ends the offer', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const tiles = rig.s.header[H_TILES] as number
    const card = rig.s.header[H_OFFER_A] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, card))
    expect(rig.s.header[H_TILES]).toBe(tiles + cardTileGrant(card))
    expect(rig.s.header[H_OFFER_WEEK]).toBe(1)
    expect(offerPending(rig.s)).toBe(false)
  })

  it('adds a roundabout to the inventory when that is the card, and not otherwise', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const slot = rig.s.header[H_OFFER_A] === CARD_ROUNDABOUT ? OFFER_SLOT_A : OFFER_SLOT_B
    const card = slot === OFFER_SLOT_A ? rig.s.header[H_OFFER_A] : rig.s.header[H_OFFER_B]
    expect(card, 'the shipped pool always offers it').toBe(CARD_ROUNDABOUT)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(slot, card as number))
    expect(rig.s.header[H_INV_ROUNDABOUT]).toBe(1)
  })

  it('raises no new offer for the rest of the week', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, rig.s.header[H_OFFER_A] as number))
    const after = hashState(rig.s)
    for (let t = 0; t < 100; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_OFFER_WEEK], 'still resolved').toBe(1)
    expect(offerPending(rig.s)).toBe(false)
    expect(hashState(rig.s), 'and the run went on').not.toBe(after)
  })

  it('offers again at the NEXT boundary', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, rig.s.header[H_OFFER_A] as number))
    driveTo(rig, TICKS_PER_WEEK * 2)
    expect(offerPending(rig.s)).toBe(true)
  })

  it('is a SILENT NO-OP for a second choice in the same batch — a double tap must not brick a run', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const a = rig.s.header[H_OFFER_A] as number
    const b = rig.s.header[H_OFFER_B] as number
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, {
      actions: [
        { kind: 'choose-card', a: OFFER_SLOT_A, b: a },
        { kind: 'choose-card', a: OFFER_SLOT_B, b: b },
      ],
    })
    expect(rig.s.header[H_TILES], 'only the first was paid').toBe(tiles + cardTileGrant(a))
    expect(rig.s.header[H_EPOCH], 'and nothing threw').toBe(0)
  })

  it('is a SILENT NO-OP in week 0, where no offer exists', () => {
    const rig = bootCity()
    const before = hashState(rig.s)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, CARD_ROAD_TILES))
    expect(rig.s.header[H_EPOCH]).toBe(0)
    expect(rig.s.header[H_OFFER_WEEK]).toBe(0)
    expect(hashState(rig.s), 'the tick still ran').not.toBe(before)
  })

  it('THROWS, naming both cards, when the echo disagrees with the slot', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const wrong = (rig.s.header[H_OFFER_A] as number) === CARD_ROAD_TILES ? CARD_ROUNDABOUT : CARD_ROAD_TILES
    expect(() =>
      step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, wrong)),
    ).toThrow(/believed slot 0 held card \d+.*this simulation offered \d+.*replay/s)
  })

  it('THROWS for a slot that is neither 0 nor 1', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    expect(() => step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(2, CARD_ROAD_TILES))).toThrow(
      /slot 2 is not 0 or 1/,
    )
  })

  it('checks PENDING before the echo, so a stale choice after a new week is a no-op and not a throw', () => {
    // Reachable from a Worker replaying a log whose choose-card lands a week
    // late. The slots hold week 2's offer by then, so an echo check first would
    // report a divergence that is not one.
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const week1A = rig.s.header[H_OFFER_A] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, week1A))
    driveTo(rig, TICKS_PER_WEEK + 10)
    expect(() =>
      step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, week1A)),
    ).not.toThrow()
  })
})

describe('cardTileGrant', () => {
  it('pays 30 for road tiles and 20 for an item, per spec 5.10', () => {
    expect(cardTileGrant(CARD_ROAD_TILES)).toBe(30)
    expect(cardTileGrant(CARD_ROUNDABOUT)).toBe(20)
  })

  it('THROWS for a card with no placement mechanism, rather than inventing a grant', () => {
    for (const id of [CARD_BRIDGE, CARD_TUNNEL, CARD_TRAFFIC_LIGHTS, CARD_MOTORWAY, CARD_NONE]) {
      expect(() => cardTileGrant(id)).toThrow(/has no tile grant/)
    }
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @laneways/sim test -- cards`
Expected: FAIL — `applyChooseCard`, `cardTileGrant` and the `'choose-card'` kind do not exist.

- [ ] **Step 3: Add the two grant constants**

`packages/shared/src/constants.ts`:

```ts
/**
 * Spec §5.10's Road Tiles card: the per-map constant "30 or 40" — 30 here, the
 * same value `WEEKLY_TILE_GRANT` uses, and deliberately a separate constant
 * because they are two different rules that happen to agree today.
 */
export const CARD_GRANT_ROAD_TILES = 30
/**
 * Spec §5.10's tile bonus on every ITEM card except the motorway, which grants
 * 10. **The motorway's number is not declared**, because the motorway is not
 * offerable in M1f and an untested value reads as a supported configuration —
 * `cardTileGrant` throws for it instead. M1g declares it with the card.
 *
 * **This is a bonus ON TOP of `WEEKLY_TILE_GRANT`, not a replacement**, and
 * that is a balance change stated rather than hidden: tile income goes from 30
 * a week to 50 or 60, against a measured 3.4x slack (62 tiles spent of 210
 * granted on the arm that ships, `tilesLeft` never below 37). The alternative —
 * deleting the automatic grant so the card is the only income — is what §5.10
 * literally describes and was refused for one reason: it makes two goldens'
 * `H_TILES` a function of the input log and re-opens the whole tile ledger in
 * the same milestone as a shape change. **M1f Task 11 measures the new slack
 * and hands the tile economy to M1g with the number.**
 */
export const CARD_GRANT_ITEM = 20
```

Add both to `constants.test.ts`'s `ALL` registry with exact-value assertions.

- [ ] **Step 4: Implement `cardTileGrant` and `applyChooseCard`**

```ts
/**
 * §5.10's tile bonus for a card. **Total over the OFFERABLE set and a throw
 * outside it**, rather than a default arm: a card with no placement mechanism
 * cannot be offered (`CARD_IMPLEMENTED_MASK`), so reaching this with one means
 * the pool and the grant table disagree, and a plausible fallback would hide
 * that. Fail-closed, and the throw is reachable from a test.
 */
export function cardTileGrant(cardId: number): number {
  if (cardId === CARD_ROAD_TILES) return CARD_GRANT_ROAD_TILES
  if (cardId === CARD_ROUNDABOUT) return CARD_GRANT_ITEM
  throw new Error(
    `cards: card ${cardId} has no tile grant — only the cards in CARD_IMPLEMENTED_MASK do, and a ` +
      'card that can be offered but not priced means the pool and this table disagree',
  )
}

/**
 * Applies a `choose-card` action, in phase 3.
 *
 * **Three checks, and their ORDER is load-bearing.**
 *
 *   1. **Not pending -> silent no-op.** A duplicate `choose-card` in one batch
 *      is what a double tap produces, and a throw there would poison `H_EPOCH`
 *      and end the run over a UI event. `H_OFFER_WEEK === H_WEEK` absorbs it,
 *      which is why `pointer.ts` needs no second guard — a second guard here
 *      would be the catalogue's independently-sufficient-structures defect.
 *      This check must come FIRST: after a later week's offer has overwritten
 *      the slots, an echo check would report a divergence that is not one.
 *   2. **A slot outside {0, 1} -> throw.** A malformed action, exactly like
 *      `step`'s unknown-kind throw, and for the same reason: a corrupted or
 *      forward-incompatible input log must fail loudly rather than apply a
 *      subset of itself.
 *   3. **The echo -> throw.** `b` is the card id the CLIENT believes it is
 *      taking. A mismatch means the browser and this simulation disagree about
 *      what was offered, which can only happen if the draw is not a pure
 *      function of state — a stale frame, a divergent seed, a Worker on another
 *      `rulesVersion`. **That is exactly what a verified leaderboard exists to
 *      catch**, so a Worker that hits it returns `unverifiable`: never a score,
 *      and never apply-anyway. Applying anyway would let a client take a card it
 *      was not offered and have the Worker bless it.
 *
 * **The tile bonus is paid HERE and never at the week boundary.** Phase 2 owns
 * `H_TILES`'s weekly grant and phase 4 owns the offer slots, so the two are
 * disjoint by construction; putting the bonus in either would couple them.
 */
export function applyChooseCard(state: GameState, slot: number, cardId: number): void {
  if (!offerPending(state)) return
  if (slot !== OFFER_SLOT_A && slot !== OFFER_SLOT_B) {
    throw new Error(`cards: choose-card slot ${slot} is not 0 or 1`)
  }
  const offered = (slot === OFFER_SLOT_A ? state.header[H_OFFER_A] : state.header[H_OFFER_B]) as number
  if (offered !== cardId) {
    throw new Error(
      `cards: the client believed slot ${slot} held card ${cardId}, and this simulation offered ` +
        `${offered} — the offer is a pure function of the seed word and the week, so the two cannot ` +
        'disagree unless the replay has diverged. A verifier must report unverifiable rather than ' +
        'apply either card.',
    )
  }
  state.header[H_TILES] = (state.header[H_TILES] as number) + cardTileGrant(cardId)
  if (cardId === CARD_ROUNDABOUT) {
    state.header[H_INV_ROUNDABOUT] = (state.header[H_INV_ROUNDABOUT] as number) + 1
  }
  state.header[H_OFFER_WEEK] = state.header[H_WEEK] as number
}
```

In `step.ts`'s input loop, add the third arm **before** the `else throw`:

```ts
    } else if (action.kind === 'choose-card') {
      applyChooseCard(s, action.a, action.b)
```

- [ ] **Step 5: Re-derive `step.test.ts`'s `TickActionKind` tripwire — do not widen it**

The line-anchored pin `/^export type TickActionKind = 'place' \| 'erase'$/m` goes red. **This is the tripwire working**, and its comment is what a reader is meant to arrive at, so the comment is re-derived rather than the regex retyped. Three things it must now say:

1. The pin becomes `/^export type TickActionKind = 'place' \| 'erase' \| 'choose-card'$/m`, still line-anchored, because `toContain` scored 0 detectors against a widened union last time.
2. **Half 2 of the tripwire — "`roads.ts` cannot observe the clock" — still holds and is still meaningful**, because `applyChooseCard` lives in `cards.ts`, not in `roads.ts`. Say so explicitly: the new action kind was deliberately given its own module so this guard keeps its subject.
3. **A `TickAction` now reads the clock**, which is the condition M1c and M1d recorded as keeping two transpositions inert. `applyChooseCard` reads `H_WEEK` and writes `H_TILES`, so **phase 3 is no longer clock-blind**. Add a fourth half to the tripwire: a scan of `cards.ts` for the demand-state names `runDemand` reads, with `demand.ts` as its positive control, exactly as half 3 does for `roads.ts` — because the pair that matters now is phase 3 against phase 6, and a `destPins` write from a card handler would be the same one-tick pin error at 0 detectors.

- [ ] **Step 6: Re-run the affected transposition rows**

Rows `1 <-> 3`, `2 <-> 3`, `3 <-> 4` and `3 <-> 6` change meaning under a clock-reading, tile-writing action. Run those four now, record them, and note in `step.ts` that the other 51 are Task 5's and are re-run in Task 11.

- [ ] **Step 7: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. **No golden moves**: no golden fixture enqueues an action, so `H_OFFER_WEEK` stays 0 in all of them and the header bytes are the ones Task 5 already blessed.

- [ ] **Step 8: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `applyChooseCard`: drop the pending check | ≥ 1, in the double-tap test **and** the week-0 test |
| 2 | Move the pending check below the echo | ≥ 1, in the stale-choice test |
| 3 | Drop the echo check | ≥ 1, in the mismatch test |
| 4 | Echo compares against the OTHER slot | ≥ 1, in the mismatch test |
| 5 | `H_OFFER_WEEK = week + 1` | ≥ 1, in *"offers again at the next boundary"* |
| 6 | Drop the `H_INV_ROUNDABOUT` increment | ≥ 1 |
| 7 | `cardTileGrant`: swap the two grants | ≥ 1 |
| 8 | `cardTileGrant`: return 0 instead of throwing | ≥ 1, in the throw test |
| 9 | `step.ts`: put the `choose-card` arm after the `else throw` | must not compile; discard and replace with "dispatch `choose-card` to `placeRoad`" (≥ 1) |

- [ ] **Step 9: Commit**

---

## Task 7: The pause — raised on the condition, resumed by the choice, and `loop.ts` is not touched

**Observability:** at **2:21** on a stopwatch — the week-1 boundary — the board stops. Cars freeze mid-road, the pause bars appear, and nothing says why, because the modal is Task 8's. **This task ships a build in which the default board hangs at the first week boundary with no way out, and that is knowingly a bad intermediate state.** It is mitigated the way M1e mitigated the same shape: with a **deliberately failing test** that Task 8 deletes as its first act, keyed on something Task 8 must structurally change. Tasks 7 and 8 must be adjacent, with nothing between them.

**Files:**
- Modify: `packages/game/src/frame.ts` (`FrameDriverDeps.onOfferRaised`, the driver's call, the frame fold's four new fields)
- Modify: `packages/game/src/main.ts` (the wiring)
- Modify: `packages/render/src/types.ts` (`RenderFrame`'s four offer fields)
- Create: `packages/game/test/offerInterlock.test.ts` — the deliberately failing test
- Test: `packages/game/test/frame.test.ts`, `loop.test.ts`, `integration.test.ts`

**Interfaces:**
- Consumes: `offerPending`, `offerSlot` (Task 4); `runOffer` (Task 5).
- Produces: `FrameDriverDeps.onOfferRaised: () => void` (**required**, not optional); `RenderFrame.offerPending: boolean`, `RenderFrame.offerA: number`, `RenderFrame.offerB: number`, `RenderFrame.offerPeek: boolean`. Task 8 draws all four and adds the peek toggle that writes the fourth.

- [ ] **Step 1: Write the failing interlock test FIRST**

Create `packages/game/test/offerInterlock.test.ts`:

```ts
/**
 * **A deliberately failing test, and Task 8 deletes this file as its first act.**
 *
 * Task 7 pauses the loop when a card offer is raised and ships no modal, so
 * between this commit and the next the default board freezes at 2:21 with no
 * message and no way out — indistinguishable from a crash. Correct sequencing,
 * disclosed, and **nothing in the tree would prevent a deploy landing here**;
 * this project has shipped that exact intermediate state once already and the
 * mitigation that worked was a red test rather than a promise.
 *
 * **The key is structural, not a guess about the next task's shape.** `render`
 * imports nothing from `sim`, so a modal cannot be drawn without new fields on
 * `RenderFrame` AND a hit-test the pointer can reach. This test asserts the
 * pointer can produce `PointerOutcome.CARD_CHOSEN`, which no cosmetic change can
 * satisfy: the outcome does not exist until Task 8 declares it, and it cannot be
 * produced without the rects, the arbitration and the enqueue.
 *
 * Its worst failure mode is that Task 8 deletes a file it was going to delete
 * anyway.
 */
it('FAILS UNTIL TASK 8: a tap can choose a card', () => {
  expect(
    Object.keys(PointerOutcome),
    'the offer modal is unreachable — see this file for why it exists',
  ).toContain('CARD_CHOSEN')
})
```

Run: `pnpm --filter @laneways/game test -- offerInterlock`
Expected: **FAIL.** That is the deliverable.

- [ ] **Step 2: Write the failing tests for the pause behaviour**

Add to `packages/game/test/loop.test.ts` and `integration.test.ts`:

```ts
  it('pauses the loop the frame a card offer is raised', () => {
    const g = bootGame()                       // production createGame, city layout
    driveFramesTo(g, TICKS_PER_WEEK)
    expect(offerPending(g.state), 'the sim raised one').toBe(true)
    expect(g.loop.paused, 'and the shell followed').toBe(true)
  })

  it('advances up to 7 more ticks after the pause is raised, because the drain does not re-check', () => {
    // MEASURED, and this plan decided not to change it. `loop.ts` reads `paused`
    // ABOVE the `while`, so a pause raised from inside `advance` does not stop
    // the drain in progress. The ticks are invisible (the frame renders once,
    // after the drain), replay-safe (`sim` has no pause concept and the ticks
    // are logged like any others) and idempotent-safe (`runOffer` rewrites the
    // same pair). Re-checking inside the `while` would only DEFER the burst:
    // `setPaused(false)` resets `lastTime` and leaves the accumulator, so the
    // banked time would drain after the modal closed instead of before it
    // opened, which is worse.
    const g = bootGame()
    driveFramesToJustBefore(g, TICKS_PER_WEEK)
    const before = g.state.header[H_TICK] as number
    g.frame(nowAfterA250msGap())
    const after = g.state.header[H_TICK] as number
    expect(after - before, 'the clamped drain ran to completion').toBeGreaterThan(1)
    expect(after - before, 'and no further than the clamp allows').toBeLessThanOrEqual(8)
    expect(g.loop.paused).toBe(true)
    // The offer the player will see is the offer raised at the boundary:
    expect(g.state.header[H_OFFER_A]).toBe(offerSlotAAt(g, 1))
  })

  it('re-pauses on the next tick if something unpauses with an offer still pending', () => {
    // The pause fires on the CONDITION, not the edge — the opposite of
    // onGameOver, which is terminal and must announce once. This is what makes
    // a lost `choose-card` action unable to strand the modal over a live board.
    const g = bootGame()
    driveFramesTo(g, TICKS_PER_WEEK)
    g.loop.setPaused(false)
    g.frame(nowPlusOneTick())
    expect(g.loop.paused, 'the condition re-armed it').toBe(true)
  })

  it('does not pause when no offer is pending', () => {
    const g = bootGame()
    driveFramesTo(g, TICKS_PER_WEEK - 10)
    expect(g.loop.paused).toBe(false)
  })

  it('carries the offer onto the render frame', () => {
    const g = bootGame()
    driveFramesTo(g, TICKS_PER_WEEK)
    const f = lastFrame(g)
    expect(f.offerPending).toBe(true)
    expect(f.offerA).toBe(g.state.header[H_OFFER_A])
    expect(f.offerB).toBe(g.state.header[H_OFFER_B])
    expect(f.offerPeek, 'peek is off until a person asks for it').toBe(false)
  })

  it('reports no offer on the frame once the week is resolved', () => {
    const g = bootGame()
    driveFramesTo(g, TICKS_PER_WEEK)
    g.queue.enqueue('choose-card', 0, g.state.header[H_OFFER_A] as number)
    g.loop.setPaused(false)
    g.frame(nowPlusOneTick())
    g.frame(nowPlusTwoTicks())
    const f = lastFrame(g)
    expect(f.offerPending).toBe(false)
    expect(f.offerA, 'and the slots read as no offer, not as a stale card').toBe(CARD_NONE)
  })
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @laneways/game test -- loop integration`
Expected: FAIL — `onOfferRaised` and the four frame fields do not exist.

- [ ] **Step 4: Add the four `RenderFrame` fields**

```ts
  /**
   * True while §5.10's weekly card offer is waiting to be taken. The board
   * behind the modal is frozen because the shell paused the loop; `sim` has no
   * notion of pause and never will.
   */
  readonly offerPending: boolean
  /** The card id in slot A, or `CARD_NONE` when nothing is pending. A plain number: `render` imports nothing from `sim`. */
  readonly offerA: number
  /** The card id in slot B. */
  readonly offerB: number
  /**
   * True while the player is holding the peek button, so the modal chrome is
   * suppressed and the board underneath is visible. **`game`-side state, not
   * `sim`'s** — peek is UI, and a cosmetic toggle in the state buffer would be
   * a replay input.
   */
  readonly offerPeek: boolean
```

- [ ] **Step 5: Fold them in `buildFrame`, and wire the driver**

`buildFrame`, in the HUD block, through `sim`'s own guards rather than off the header — `offerSlot` returns `CARD_NONE` unless an offer is pending, which is why an unguarded read of `H_OFFER_A` would show last week's card on every live frame:

```ts
  frame.offerPending = offerPending(state)
  frame.offerA = offerSlot(state, 0)
  frame.offerB = offerSlot(state, 1)
  frame.offerPeek = peek
```

`peek` arrives as a new parameter on `buildFrame` and on `FrameDriverDeps` as `peeking: () => boolean`, in the same idiom as `camera`. `createFrameDriver`'s `advance`:

```ts
    advance(inputs: TickInputs): void {
      const wasOver = isGameOver(state)
      step(state, world, fields, scratch, inputs)
      if (!wasOver && isGameOver(state)) deps.onGameOver()
      // **On the CONDITION, not the edge, and the contrast with the line above
      // is the point.** Game over is terminal and must announce once, so it
      // reads `wasOver` first. An offer is recurring and self-healing: firing
      // whenever it holds means any path that unpauses with an offer still
      // pending re-pauses on the next tick, so a lost `choose-card` cannot
      // strand a modal over a live board. `setPaused(true)` is already
      // idempotent, so the repetition costs one boolean read per tick.
      if (offerPending(state)) deps.onOfferRaised()
    },
```

`main.ts`:

```ts
      // Required, not optional: an optional dependency is how M2's erase control
      // shipped a compiling `createEraseControl({ host })` that left the player
      // with no way to erase. A game whose offer cannot pause the loop is a game
      // whose modal is drawn over a running sim.
      onOfferRaised: () => {
        loop.setPaused(true)
      },
```

- [ ] **Step 6: Run the game suite**

Run: `pnpm --filter @laneways/game test`
Expected: PASS on the six new tests; `offerInterlock.test.ts` still red, by design; **no golden moves**, because none of this is in `sim`.

- [ ] **Step 7: Record the paused-car settling measurement where it now matters**

Add to `packages/game/src/resolve.ts`'s existing table:

```
 * **M1f gives this its first long-lived audience.** Paused cars do NOT settle
 * onto their sim positions — measured at 0.09-0.22 cells short, because the
 * chase advances inside the drain and the drain has stopped. Until M1f the only
 * pause was a HUD-clock tap; from M1f the weekly modal holds a pause for as long
 * as the player takes to choose, so a frozen offset of up to 0.22 cells is on
 * screen for seconds at a time. It is at the top of `MAX_DRAW_LAG_CELLS`'s
 * range (0.2) and about 6 CSS px at the smallest tile size `fitCamera`
 * produces. **Not fixed here**: converging while paused means advancing the
 * chase with `ticks = 0`, which is a drawn position moving while the sim's does
 * not, and that gives up the property that a drawn car is never ahead of its
 * sim car. Task 11's device session is the instrument.
```

- [ ] **Step 8: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `advance`: fire `onOfferRaised` on the EDGE (`!wasPending && offerPending`) | ≥ 1, in the re-pause test |
| 2 | Delete the `onOfferRaised` call | ≥ 1, in the pause test |
| 3 | `buildFrame`: read `state.header[H_OFFER_A]` directly instead of `offerSlot` | ≥ 1, in *"reads as no offer, not as a stale card"* |
| 4 | `main.ts`: `setPaused(false)` in `onOfferRaised` | ≥ 1 |
| 5 | Make `onOfferRaised` optional in `FrameDriverDeps` | must fail `tsc`; if it compiles, the type is wrong and that is the finding |

- [ ] **Step 9: Commit, disclosing the intermediate state in the message**

The commit message must say, in its own words, that this build freezes at 2:21 with no way out, that `offerInterlock.test.ts` is red on purpose, and that Task 8 deletes it.

---

## Task 8: The modal, the peek button, the tap arbitration — and the erase control that has to get out of the way

**Observability: this is the task the milestone's second half is for.** At **2:21** the board dims and two cards appear: **30 ROAD TILES** and **A ROUNDABOUT · 20 TILES**. Tapping one dismisses the modal and the board runs again, with the tile counter jumping. Holding the eye button shows the frozen board underneath without resuming it. The erase control disappears while the modal is up and comes back after.

**Files:**
- Modify: `packages/render/src/types.ts` (`OfferRects`, `Palette`'s new colours), `camera.ts` (`offerRects`), `canvas.ts` (phase 12), `palette.ts`
- Modify: `packages/game/src/pointer.ts` (arbitration, peek, three outcomes), `main.ts`, `eraseControl.ts`
- Delete: `packages/game/test/offerInterlock.test.ts`
- Test: `packages/render/test/canvas.test.ts`, `camera.test.ts`, `packages/game/test/pointer.test.ts`, `eraseControl.test.ts`

**Interfaces:**
- Consumes: `RenderFrame.offerPending`/`offerA`/`offerB`/`offerPeek` (Task 7); `queue.enqueue('choose-card', slot, cardId)` (Task 6).
- Produces: `OfferRects { readonly cardA: Rect; readonly cardB: Rect; readonly peek: Rect }` and `offerRects(camera: Camera, out: OfferRects): OfferRects` from `packages/render`; `PointerOutcome.CARD_CHOSEN = 10`, `PEEK_TOGGLED = 11`, `REFUSED_OFFER_MODAL = 12`; `PointerInput.peeking: boolean`; `PointerHost.cardLabel` is **not** added — `render` owns every string it draws. `EraseControl.suspend(): void` / `resume(): void`.

- [ ] **Step 1: Delete the interlock test as the first act**

```bash
git rm packages/game/test/offerInterlock.test.ts
```

- [ ] **Step 2: Write the failing render tests**

Add to `packages/render/test/canvas.test.ts`, against the existing command-recording stub:

```ts
describe('phase 12: the offer modal', () => {
  it('draws NOTHING when no offer is pending', () => {
    const cmds = draw(frameWith({ offerPending: false }))
    expect(cmds.filter((c) => c.text !== undefined).map((c) => c.text)).not.toContain(CARD_A_LABEL)
  })

  it('covers the whole canvas, not just the board, so the HUD cannot read as live', () => {
    // The shutdown scrim stops at the grid rect's bottom edge so the HUD keeps
    // its contrast. The modal is the opposite case and deliberately so: the HUD
    // clock is a PAUSE TOGGLE, and a legible pause toggle under a modal that
    // forbids skipping is an invitation to a control that does nothing.
    const cmds = draw(frameWith({ offerPending: true }))
    const scrim = cmds.find((c) => c.fillStyle === PALETTE.scrim && c.rect !== undefined)
    expect(scrim?.rect).toEqual({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H })
  })

  it('draws both card faces, their labels and their tile lines', () => {
    const cmds = draw(frameWith({ offerPending: true, offerA: CARD_ROAD_TILES, offerB: CARD_ROUNDABOUT }))
    const texts = cmds.filter((c) => c.text !== undefined).map((c) => c.text)
    expect(texts).toContain('30 ROAD TILES')
    expect(texts).toContain('ROUNDABOUT')
    expect(texts).toContain('+20 TILES')
  })

  it('draws the two faces at exactly the rects offerRects reports, so the hit test cannot drift', () => {
    const rects = offerRects(CAMERA, freshOfferRects())
    const cmds = draw(frameWith({ offerPending: true }))
    const faces = cmds.filter((c) => c.fillStyle === PALETTE.cardFace && c.rect !== undefined)
    expect(faces.map((c) => c.rect)).toEqual([rects.cardA, rects.cardB])
  })

  it('suppresses the chrome and keeps the scrim off while peeking', () => {
    const cmds = draw(frameWith({ offerPending: true, offerPeek: true }))
    const texts = cmds.filter((c) => c.text !== undefined).map((c) => c.text)
    expect(texts).not.toContain('30 ROAD TILES')
    expect(cmds.some((c) => c.fillStyle === PALETTE.scrim), 'the board is visible').toBe(false)
    expect(texts, 'and the way back is still on screen').toContain(PEEK_RETURN_TEXT)
  })

  it('draws the modal ABOVE the shutdown screen when both are somehow true', () => {
    // Unreachable in production — `step` freezes past the failure so no boundary
    // can be crossed — and drawn in a defined order anyway, because a scrim over
    // a modal over a scrim is the one composition nobody can debug from a
    // screenshot.
    const cmds = draw(frameWith({ offerPending: true, gameOver: true }))
    const lastScrim = cmds.map((c) => c.fillStyle).lastIndexOf(PALETTE.scrim)
    const lastText = cmds.map((c) => c.text).lastIndexOf('30 ROAD TILES')
    expect(lastText).toBeGreaterThan(lastScrim)
  })

  it('allocates nothing per frame', () => {
    // Every label is a module-scope constant or a memoised cache, exactly like
    // the HUD's `failedText`/`scoreText`. A template literal per card per frame
    // is 60 strings a second.
    expect(CARD_LABELS.length, 'one label per card id, frozen at module scope').toBe(CARD_COUNT)
  })
})
```

Add to `packages/render/test/camera.test.ts`: `offerRects` gives two non-overlapping rects inside the canvas at three viewport sizes including the degenerate clamps `fitCamera` produces; the peek rect overlaps neither; the whole set is inside `[0, cssW] x [0, cssH]`; and it fills a caller-owned object and returns it, allocating nothing.

- [ ] **Step 3: Run to verify they fail; then implement the render side**

`palette.ts` gains `cardFace`, `cardText`, `cardAccent` and `roundabout` (Task 9 uses the fourth). `canvas.ts` gains phase 12, **after** phase 11's shutdown for the reason the test names. Labels are a frozen module-scope array indexed by card id, one entry per id including the four unofferable ones — the array's length is asserted against `CARD_COUNT` so a seventh card fails here rather than drawing `undefined`.

- [ ] **Step 4: Write the failing pointer tests**

```ts
describe('the offer modal owns every tap while it is up', () => {
  it('queues a choose-card with the slot and the card id it believes it is taking', () => {
    const h = host({ offerPending: true, offerA: CARD_ROAD_TILES, offerB: CARD_ROUNDABOUT })
    const p = createPointerInput(h)
    expect(p.down(1, ...centreOf(offerRects(h.camera(), r).cardB))).toBe(PointerOutcome.CARD_CHOSEN)
    expect(h.queue.length).toBe(1)
    expect(lastAction(h.queue)).toEqual({ kind: 'choose-card', a: 1, b: CARD_ROUNDABOUT })
  })

  it('resumes the loop on the choice, because the tick that resolves the offer cannot run while paused', () => {
    const h = host({ offerPending: true })
    createPointerInput(h).down(1, ...centreOf(offerRects(h.camera(), r).cardA))
    expect(h.setPausedCalls).toEqual([false])
  })

  it('refuses a tap that misses both cards, and names the guard that refused it', () => {
    const h = host({ offerPending: true })
    expect(createPointerInput(h).down(1, ...aPointInNoRect())).toBe(PointerOutcome.REFUSED_OFFER_MODAL)
    expect(h.queue.length).toBe(0)
  })

  it('refuses a HUD-CLOCK tap while the modal is up — a pause toggle would resume a dead board', () => {
    const h = host({ offerPending: true })
    expect(createPointerInput(h).down(1, ...centreOf(hudRects(h.camera(), hr).clock))).toBe(
      PointerOutcome.REFUSED_OFFER_MODAL,
    )
    expect(h.setPausedCalls, 'and the clock did not toggle').toEqual([])
  })

  it('refuses a GRID tap while the modal is up', () => {
    const h = host({ offerPending: true, paused: true })
    expect(createPointerInput(h).down(1, ...aGridPoint())).toBe(PointerOutcome.REFUSED_OFFER_MODAL)
  })

  it('toggles peek, and a tap anywhere returns from it', () => {
    const h = host({ offerPending: true })
    const p = createPointerInput(h)
    expect(p.down(1, ...centreOf(offerRects(h.camera(), r).peek))).toBe(PointerOutcome.PEEK_TOGGLED)
    expect(p.peeking).toBe(true)
    expect(p.down(2, ...aGridPoint())).toBe(PointerOutcome.PEEK_TOGGLED)
    expect(p.peeking).toBe(false)
  })

  it('does NOT resume the loop while peeking — peek inspects, it does not skip', () => {
    const h = host({ offerPending: true })
    const p = createPointerInput(h)
    p.down(1, ...centreOf(offerRects(h.camera(), r).peek))
    expect(h.setPausedCalls).toEqual([])
  })

  it('is BELOW the game-over branch, so a city that dies mid-modal still restarts', () => {
    // Unreachable today (`step` freezes past the failure, so no boundary can be
    // crossed) and ordered anyway, because the alternative is a dead board with
    // a modal on it and no way out.
    const h = host({ offerPending: true, gameOver: true })
    expect(createPointerInput(h).down(1, ...aGridPoint())).toBe(PointerOutcome.RESTART_REQUESTED)
  })

  it('leaves every existing path alone when no offer is pending', () => {
    const h = host({ offerPending: false })
    const p = createPointerInput(h)
    expect(p.down(1, ...aGridPoint())).toBe(PointerOutcome.DRAG_START)
    expect(p.down(2, ...centreOf(hudRects(h.camera(), hr).clock))).toBe(PointerOutcome.REFUSED_SECOND_POINTER)
  })
})
```

- [ ] **Step 5: Implement the arbitration, in a stated order**

In `down()`, immediately **below** the `host.gameOver()` early return and **above** the `dragging` block:

```ts
    // **The modal owns every tap while it is up, and it is ONE branch rather
    // than a guard on each of the paths below.** Two guards can disagree; and
    // the HUD clock in particular is a pause TOGGLE, which under a no-skip modal
    // would resume the sim from outside this decision entirely.
    //
    // **Below the game-over branch** for the same reason that branch is first:
    // a city that died with a modal up must still offer the restart, and a
    // player facing TAP TO PLAY AGAIN must not be handed a card instead.
    //
    // **Above the `dragging` block**, so a modal raised mid-stroke — the run
    // crosses a week boundary while a finger owns the drag — does not answer the
    // next tap REFUSED_SECOND_POINTER in front of a screen asking for a choice.
    //
    // `move`, `up` and `cancel` need no companion guard and must not grow one:
    // the loop is paused, `move` already refuses every board sample while
    // paused, and `up`/`cancel` must stay live so a captured pointer can be
    // released. A second independently sufficient structure would leave neither
    // half with a detector.
    if (host.offerPending()) {
      if (peek) {
        peek = false
        return PointerOutcome.PEEK_TOGGLED
      }
      offerRects(host.camera(), offerRectScratch)
      const cssX = clientX - host.canvasLeft()
      const cssY = clientY - host.canvasTop()
      if (inRect(offerRectScratch.peek, cssX, cssY)) {
        peek = true
        return PointerOutcome.PEEK_TOGGLED
      }
      if (inRect(offerRectScratch.cardA, cssX, cssY)) return chooseCard(OFFER_SLOT_A, host.offerA())
      if (inRect(offerRectScratch.cardB, cssX, cssY)) return chooseCard(OFFER_SLOT_B, host.offerB())
      return PointerOutcome.REFUSED_OFFER_MODAL
    }
```

with

```ts
  function chooseCard(slot: number, cardId: number): PointerOutcomeCode {
    // The echo: the card id THIS CLIENT believes the slot holds, read from the
    // same frame the player tapped. `applyChooseCard` throws on a mismatch, and
    // that throw is the replay-divergence detector — so this must pass on what
    // it saw, never re-derive it.
    host.queue.enqueue('choose-card', slot, cardId)
    // The resume is here because the tick that resolves the offer cannot run
    // while the loop is paused. The 1-2 frame window in which the modal is still
    // drawn after the tap is harmless: a second tap enqueues a second
    // `choose-card` and `sim` no-ops it against `H_OFFER_WEEK === H_WEEK`.
    host.setPaused(false)
    return PointerOutcome.CARD_CHOSEN
  }
```

`PointerHost` gains `offerPending: () => boolean`, `offerA: () => number`, `offerB: () => number`, supplied by `main.ts` from `offerPending(state)` / `offerSlot(state, 0)` / `offerSlot(state, 1)` — `pointer.ts` must not grow a `sim` import. `PointerInput` gains `peeking: boolean`, which `main.ts` hands `createFrameDriver` as `peeking: () => pointer.peeking`.

- [ ] **Step 6: Suspend the erase control under the modal, and fix its unsubscribe while there**

Carry-forward §4: `retire()` hides the control and refuses every later render, but never unsubscribes — `offClick` is declared on the `MainButton` shape and called nowhere, and the DOM fallback's listener is never removed. Unreachable on every client this ships to, and the specific wrongness worth fixing is that **`press()` calls `host.toggleEraseMode()` BEFORE `render()`'s terminal guard runs**, so a press that did arrive would flip erase mode with no label to show it.

Two changes, and the second closes §4 by the cheaper of its two options:

```ts
  /** Hidden while a modal owns the screen; `resume` puts it back exactly as it was. */
  readonly suspend: () => void
  readonly resume: () => void
```

and **move the `retired` guard into `press` itself**, so the mode cannot flip without a label, and record at the site that the alternative — holding the handler reference and widening `mainButton()`'s shape re-check to cover `offClick` — was refused as the more invasive of the two for a consequence that is bounded and cosmetic.

`main.ts` calls `erase.suspend()` from `onOfferRaised` and `erase.resume()` when a frame reports the offer resolved. **A full-width bright button reading ERASE ROADS under a modal asking for a choice is the same defect `onGameOver`'s `erase.retire()` already exists to prevent**, arrived at through a different door.

- [ ] **Step 7: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. No golden moves — nothing here is in `sim`.

- [ ] **Step 8: Drive the real thing once, headless, and assert the whole loop end to end**

In `integration.test.ts`, on the production boot: drive to 2:21, assert paused and `offerPending`; synthesise a tap at the roundabout card's rect through `createPointerInput`; drive two more frames; assert `H_INV_ROUNDABOUT === 1`, `H_TILES` up by `CARD_GRANT_ITEM`, the loop unpaused, and the frame's `offerPending` false. **This is the first test in the repo that exercises a player decision from a screen coordinate to a header slot**, and it is the one that would catch a rect/draw mismatch that both sides' own tests miss.

- [ ] **Step 9: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | Move the offer branch above the `gameOver` branch | ≥ 1, in the dead-board test |
| 2 | Move the offer branch below the `dragging` block | ≥ 1 — add the mid-stroke fixture if it survives; that is the case the ordering exists for |
| 3 | Delete the `return REFUSED_OFFER_MODAL` fallthrough | ≥ 1, in the clock and grid tests |
| 4 | `chooseCard`: enqueue `host.offerB()` for slot A | ≥ 1, in the enqueue test — and note this is the mutant the sim's echo throw exists for |
| 5 | `chooseCard`: drop `setPaused(false)` | ≥ 1, in the resume test |
| 6 | Peek: also call `setPaused(false)` | ≥ 1, in *"peek inspects, it does not skip"* |
| 7 | `offerRects`: swap `cardA` and `cardB` | ≥ 1, in the draw/hit-test agreement test |
| 8 | `canvas.ts`: draw phase 12 before phase 11 | ≥ 1, in the ordering test |
| 9 | `eraseControl`: make `suspend` a no-op | ≥ 1 — write the test if it survives |

- [ ] **Step 10: Commit**

---

## Task 9: The roundabout — nine cells, an eight-cell ring, four entries, and the first thing that makes the junction cheap again

**The largest task in this milestone, larger than anything in M1e.** It is five deliverables that cannot be split without shipping a half-object: the geometry and its placement validity, the ring's road writes, the movement rules, the inventory chip and its gesture, and the render.

**Observability:** the payoff. A player who took the roundabout card sees a **chip in the HUD with a badge reading 1**. Tapping it highlights the board; tapping a cell drops a 3×3 roundabout there, drawn as a disc with a ring of road around it. Traffic that was stopping dead at that corner from 6:57 now flows through it at double speed. **Put it on the right corner and the run lasts measurably longer; put it one cell over and nothing changes at all** — and the size of that gap is what Task 11 measures.

**Files:**
- Create: `packages/sim/src/roundabout.ts`, `packages/sim/test/roundabout.test.ts`
- Modify: `packages/sim/src/graph.ts` (`isJunctionCell`'s roundabout clause), `cars.ts` (`junctionSpeedMul`, the rounding note), `roads.ts` (`canPlaceRoad`'s two refusals, `layRoundaboutRing`), `step.ts` (the fourth action kind), `index.ts`
- Modify: `packages/shared/src/constants.ts` (`ROUNDABOUT_SPAN`)
- Modify: `packages/render/src/types.ts` (`HudRects.roundabout`, `RenderFrame.roundabouts`/`invRoundabout`/`roundaboutMode`), `camera.ts`, `canvas.ts`, `palette.ts`
- Modify: `packages/game/src/frame.ts`, `pointer.ts`, `main.ts`
- Test: `packages/sim/test/cars.test.ts`, `roads.test.ts`, `graph.test.ts`, `step.test.ts`, `packages/render/test/canvas.test.ts`, `camera.test.ts`, `packages/game/test/pointer.test.ts`, `integration.test.ts`

**Interfaces:**
- Consumes: the `roundabout` region and `H_INV_ROUNDABOUT` (Task 4); `isJunctionCell` (Task 2); `CARD_ROUNDABOUT` (Task 4).
- Produces:
  - `RA_NONE = 0`, `RA_ENTRY = 1`, `RA_CORNER = 2`, `RA_CENTRE = 3` (`roundabout.ts`)
  - `ROUNDABOUT_SPAN = 3`, `ROUNDABOUT_BLOCK_CELLS = 9` (`@laneways/shared` and `roundabout.ts`)
  - `roundaboutCellAt(centre: number, k: number, w: number): number` — the `k`-th of the nine block cells, `k` in `[0, 9)`, in ascending `(dy, dx)` order with `k = 4` the centre
  - `roundaboutCodeAt(k: number): number` — the code the `k`-th cell takes
  - `isRoundaboutCell(state: GameState, cell: number): boolean`
  - `canPlaceRoundabout(state, world, centre): RoundaboutPlaceResult`
  - `applyPlaceRoundabout(state, world, centre): boolean`
  - `layRoundaboutRing(state: GameState, world: WorldData, centre: number): void` (`roads.ts`)
  - `TickActionKind` gains `'roundabout'`; `PointerOutcome.ROUNDABOUT_ARMED = 13`, `ROUNDABOUT_PLACED = 14`; `PointerInput.roundaboutMode: boolean`; `PointerHost.roundaboutsHeld: () => number`
- Task 10 consumes `ROUNDABOUT_SPAN` for the capability filter; Task 11 consumes `applyPlaceRoundabout` for the sweep.

### The geometry, written once

`roundaboutCellAt(centre, k, w)` walks the 3×3 in ascending `(dy, dx)`:

| k | offset | code |
|---|---|---|
| 0 | (-1, -1) | `RA_CORNER` |
| 1 | (0, -1) | `RA_ENTRY` |
| 2 | (+1, -1) | `RA_CORNER` |
| 3 | (-1, 0) | `RA_ENTRY` |
| 4 | (0, 0) | `RA_CENTRE` |
| 5 | (+1, 0) | `RA_ENTRY` |
| 6 | (-1, +1) | `RA_CORNER` |
| 7 | (0, +1) | `RA_ENTRY` |
| 8 | (+1, +1) | `RA_CORNER` |

**The eight ring cells form an 8-cycle whose every edge is orthogonal** — walking the perimeter, consecutive cells differ by exactly one in exactly one axis. So the ring is precisely *"every legal road segment between two ring cells"*, no diagonal is involved, and every ring edge costs `ORTHO_COST`. Corner-to-centre pairs are diagonal and are excluded by the centre's own rule, so they never arise.

- [ ] **Step 1: Write the failing geometry tests**

```ts
describe('the roundabout block', () => {
  it('names nine distinct on-board cells, centred', () => {
    const seen = new Set<number>()
    for (let k = 0; k < ROUNDABOUT_BLOCK_CELLS; k++) seen.add(roundaboutCellAt(CENTRE, k, W))
    expect(seen.size).toBe(9)
    expect(roundaboutCellAt(CENTRE, 4, W), 'k=4 is the centre').toBe(CENTRE)
  })

  it('assigns four entries, four corners and one centre', () => {
    const codes = [...Array(9).keys()].map(roundaboutCodeAt)
    expect(codes.filter((c) => c === RA_ENTRY).length).toBe(4)
    expect(codes.filter((c) => c === RA_CORNER).length).toBe(4)
    expect(codes.filter((c) => c === RA_CENTRE).length).toBe(1)
  })

  it('gives the four ENTRY cells the orthogonal offsets and the four CORNERS the diagonals', () => {
    for (let k = 0; k < 9; k++) {
      const cell = roundaboutCellAt(CENTRE, k, W)
      const dx = (cell % W) - (CENTRE % W)
      const dy = ((cell / W) | 0) - ((CENTRE / W) | 0)
      const orth = (dx === 0) !== (dy === 0)
      if (roundaboutCodeAt(k) === RA_ENTRY) expect(orth, `k=${k}`).toBe(true)
      if (roundaboutCodeAt(k) === RA_CORNER) expect(dx !== 0 && dy !== 0, `k=${k}`).toBe(true)
    }
  })

  it('the eight ring cells form an 8-cycle of ORTHOGONAL edges — no diagonal is ever a ring edge', () => {
    let edges = 0
    for (let a = 0; a < 9; a++) {
      if (roundaboutCodeAt(a) === RA_CENTRE) continue
      for (let b = a + 1; b < 9; b++) {
        if (roundaboutCodeAt(b) === RA_CENTRE) continue
        const dir = dirBetween(roundaboutCellAt(CENTRE, a, W), roundaboutCellAt(CENTRE, b, W), W, H)
        if (dir === -1) continue
        edges++
        expect(edgeCost(dir), `ring edge ${a}-${b} is orthogonal`).toBe(ORTHO_COST)
      }
    }
    expect(edges, 'an 8-cycle has 8 edges').toBe(8)
  })

  it('walks the block in a fixed order, so two callers cannot disagree about which cell is k', () => {
    // A hand-written expectation, not a loop over the same formula: a test that
    // recomputes the thing it checks agrees with the mutant.
    expect([...Array(9).keys()].map((k) => roundaboutCellAt(100, k, 10))).toEqual([
      89, 90, 91, 99, 100, 101, 109, 110, 111,
    ])
  })
})
```

- [ ] **Step 2: Run to verify; implement the geometry and the codes**

Codes carry their reasons at the declaration:

```ts
/** No roundabout here. Zero, so a fresh buffer means "none" with no write in `createState`. */
export const RA_NONE = 0
/**
 * One of the four ORTHOGONAL neighbours of the centre. **The only cells of the
 * block that may carry a road out of it** — dossier §1.8's *"connects from the
 * 4 orthogonal neighbours"*, enforced in `canPlaceRoad`.
 */
export const RA_ENTRY = 1
/** One of the four diagonal cells. Ring traffic only; a road to a cell outside the block is refused. */
export const RA_CORNER = 2
/** The middle. **Never carries road at all**, which is what makes the ring a ring rather than a crossroads with a hat. */
export const RA_CENTRE = 3
```

- [ ] **Step 3: Write the failing placement-validity tests — one per refusal**

Nine refusals, each with its own fixture and its own outcome code, because *"a function with more than two ways to decline puts the reason in the signature"*:

```ts
export type RoundaboutRefusal =
  | 'no-inventory'
  | 'off-board'
  | 'terrain'
  | 'building'
  | 'overlap'
export type RoundaboutPlaceResult = { readonly ok: true } | { readonly ok: false; readonly reason: RoundaboutRefusal }
```

```ts
describe('canPlaceRoundabout', () => {
  it('accepts a clear 3x3 on land with a roundabout in hand', () => { … expect(r).toEqual({ ok: true }) })
  it('refuses with none in hand', () => expect(reason(inv0)).toBe('no-inventory'))
  it('refuses a centre on the board edge, in all four directions', () => { /* x=0, x=w-1, y=0, y=h-1 */ })
  it('refuses when any of the nine is WATER', () => { /* one per k, nine sub-cases */ })
  it('refuses when any of the nine is MOUNTAIN', () => { /* one per k */ })
  it('ACCEPTS when one of the nine is a TREE, and clears it', () => { /* trees are destroyed by any placement, §5.1 */ })
  it('refuses when any of the nine holds a house cell', () => { /* one per k */ })
  it('refuses when any of the nine is inside a destination footprint', () => { /* one per k */ })
  it('refuses when any of the nine is a destination CARPARK', () => { /* one per k */ })
  it('refuses when any of the nine already carries a roundabout code', () => { /* one per k */ })
  it('checks all NINE cells and not just the centre', () => {
    // The nine sub-cases above are the point: a validity check that only looked
    // at the centre passes a single-cell fixture, and this is the shape the
    // catalogue records as a fixture too weak to tell the right answer from the
    // wrong one. Assert the count so a shortened loop fails here.
    expect(BLOCKED_SUBCASES.length).toBe(ROUNDABOUT_BLOCK_CELLS)
  })
})
```

**Every `one per k` above is nine sub-cases, not one.** A refusal loop that checks only `k = 4` passes a centre-only fixture, and the catalogue's *"a fixture can satisfy every stated condition and still defeat its purpose"* is exactly this shape.

- [ ] **Step 4: Implement `canPlaceRoundabout`**

Order the checks cheapest-first and **return the reason, never a boolean**: `no-inventory`, then `off-board` (the centre must be at least one cell from every edge — check with coordinates, never `0 <= cell < cells`, or the row seam admits a wrapped block), then a single pass over the nine cells testing `world.passable`, then buildings, then `roundabout[cell] !== RA_NONE`.

`cellHoldsBuilding(state, world, cell)` is a private helper: any live house cell equal to `cell`; any live destination whose footprint contains `cell` (`isFootprintCell`); any live destination whose `carparkCell` equals `cell`. O(houses + destinations) per cell against 9 cells on a rare input action — state that as the reason it is a scan and not an index.

- [ ] **Step 5: Write the failing tests for the erase-and-lay sequence**

```ts
describe('applyPlaceRoundabout', () => {
  it('marks all nine cells with their codes and leaves the tenth alone', () => { … })

  it('lays exactly the eight ring segments, and every ring cell ends at degree >= 2', () => {
    applyPlaceRoundabout(s, world, CENTRE)
    let segments = 0
    for (let k = 0; k < 9; k++) {
      if (roundaboutCodeAt(k) === RA_CENTRE) continue
      const cell = roundaboutCellAt(CENTRE, k, world.w)
      expect(roadDegree(s, cell), `ring cell k=${k}`).toBeGreaterThanOrEqual(2)
      segments += roadDegree(s, cell)
    }
    expect(segments / 2, 'each segment counted from both ends').toBe(8)
  })

  it('leaves the CENTRE with no road at all', () => {
    applyPlaceRoundabout(s, world, CENTRE)
    expect(roadMask(s, CENTRE)).toBe(0)
  })

  it('costs ZERO tiles for the ring', () => {
    const tiles = tilesLeft(s)
    applyPlaceRoundabout(s, world, CENTRE)
    expect(tilesLeft(s)).toBe(tiles)
  })

  it('REFUNDS a road it erases, in full', () => {
    // Four pre-existing segments crossing the block, drawn through placeRoad so
    // the ledger is real. Eight cells paid for, eight refunded, ring free.
    const paid = drawCrossroadsThrough(s, world, CENTRE)
    const tiles = tilesLeft(s)
    applyPlaceRoundabout(s, world, CENTRE)
    expect(tilesLeft(s), 'every erased cell came back').toBe(tiles + paid.cellsInsideBlock)
  })

  it('KEEPS an entry cell road that leaves the block, and ERASES a corner road that leaves it', () => {
    const north = roundaboutCellAt(CENTRE, 1, world.w)
    const nw = roundaboutCellAt(CENTRE, 0, world.w)
    placeRoad(s, world, north, north - world.w)     // an approach from outside, on an ENTRY
    placeRoad(s, world, nw, nw - world.w)           // an approach from outside, on a CORNER
    applyPlaceRoundabout(s, world, CENTRE)
    expect(isConnected(s, world, north, north - world.w), 'the entry keeps its approach').toBe(true)
    expect(isConnected(s, world, nw, nw - world.w), 'the corner loses its approach').toBe(false)
  })

  it('spends exactly one from the inventory', () => { … expect(s.header[H_INV_ROUNDABOUT]).toBe(before - 1) })

  it('returns false and changes NOTHING when validity refuses', () => {
    const before = hashState(s)
    expect(applyPlaceRoundabout(s, world, waterCentre)).toBe(false)
    expect(hashState(s)).toBe(before)
  })

  it('ghosts an erased segment that a car is committed to, and pays its refund when the car clears', () => {
    // The existing machinery, unchanged: a car committed to a segment the
    // roundabout erased keeps driving it, and the refund arrives on departure.
    // This test exists because `layRoundaboutRing` writes `state.roads`
    // directly, and a writer that bypassed `payGhostRefund` would strand the
    // tile.
    … expect(ghostMaskOf(s, cell)).not.toBe(0)
    … expect(tilesLeft(s)).toBe(afterDeparture)
  })

  it('is deterministic in its erase order, so two replays agree', () => {
    // Ascending cell, then ascending direction. A Set or an object-key walk here
    // would be a determinism-rule violation the lint catches; this asserts the
    // ORDER, which the lint cannot see.
    expect(eraseOrderOf(s, world, CENTRE)).toEqual(expectedAscendingOrder)
  })
})
```

- [ ] **Step 6: Implement `applyPlaceRoundabout` and `layRoundaboutRing`**

`applyPlaceRoundabout` lives in `roundabout.ts` and owns the sequence; **every `state.roads` write goes through `roads.ts`**, which owns that region:

1. `canPlaceRoundabout`; return `false` on a refusal, having written nothing.
2. For `k` ascending over the nine cells, for `dir` ascending over the eight directions: if the bit is set, and the neighbour is inside the block **or** the block cell is not an `RA_ENTRY`, call `eraseRoad(cell, neighbour)`. Ascending on both axes, stated as the determinism requirement it is.
3. Write the nine codes.
4. `layRoundaboutRing(state, world, centre)`.
5. `state.header[H_INV_ROUNDABOUT] -= 1`.

The codes are written **before** the ring so `canPlaceRoad`'s new refusals do not have to be bypassed — but `layRoundaboutRing` does not call `canPlaceRoad` at all, because the ring is free and `canPlaceRoad` would price it. Say that at the site, and say what `layRoundaboutRing` therefore has to do for itself: clear a tree on each endpoint, and pay any pending ghost refund on a cell it re-roads, through the same `payGhostRefund` `placeRoad` uses. **Not a second implementation of `placeRoad` — a sibling that shares its two side-effect helpers and skips its pricing**, and the comment must say which of `placeRoad`'s five responsibilities it deliberately does not have (validity, pricing, budget) and which it must not skip (tree clearing, ghost refund).

- [ ] **Step 7: Write and land `canPlaceRoad`'s two standing refusals**

```ts
  // **The roundabout's two standing rules — M1f Task 9.** Placement erased the
  // roads that violated them; these are what stop a player drawing them back.
  //
  //   - No road may touch a roundabout's CENTRE. The centre is the middle of a
  //     ring, not a crossroads with a decoration on it, and a road through it is
  //     a shortcut that makes the ring pointless.
  //   - A CORNER may join only another roundabout cell. That is dossier §1.8's
  //     "connects from the 4 orthogonal neighbours", and it is what stops a
  //     player wiring four extra approaches into a 3x3.
  //
  // Two array reads on a path that already reads four. `REFUSE_ROUNDABOUT` is a
  // frozen module-scope singleton like every other return in this function.
  const raA = state.roundabout[a] as number
  const raB = state.roundabout[b] as number
  if (raA === RA_CENTRE || raB === RA_CENTRE) return REFUSE_ROUNDABOUT
  if ((raA === RA_CORNER && raB === RA_NONE) || (raB === RA_CORNER && raA === RA_NONE)) {
    return REFUSE_ROUNDABOUT
  }
```

`PlaceFailure` gains `'roundabout'`. Test both refusals in both argument orders — **a compound mutation applied to one side of a symmetric comparison is the shape that hides a live mutant inside a caught one**, and this comparison is symmetric twice over.

- [ ] **Step 8: Write the failing movement tests, then land the two movement rules**

```ts
describe('a roundabout cell is not a junction, and it is fast', () => {
  it('isJunctionCell is FALSE on a ring cell of degree 3', () => {
    const rig = roundaboutWithOneApproach()
    expect(roadDegree(rig.s, rig.entry), 'the fixture really is degree 3').toBe(3)
    expect(isJunctionCell(rig.s, rig.entry)).toBe(false)
  })

  it('so canEnter admits a crossing entrant that a bare junction would refuse', () => {
    const rig = roundaboutWithOneApproach()
    claimCell(rig.s, 0, rig.entry, DIR_E)
    expect(canEnter(rig.s, rig.world, 1, rig.entry, DIR_S)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('and the SAME geometry without the marking refuses it — the marking is what changed', () => {
    const rig = roundaboutWithOneApproach()
    rig.s.roundabout.fill(RA_NONE)
    claimCell(rig.s, 0, rig.entry, DIR_E)
    expect(canEnter(rig.s, rig.world, 1, rig.entry, DIR_S)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('still refuses on the OWN lane — the ring has capacity, not immunity', () => {
    const rig = roundaboutWithOneApproach()
    claimCell(rig.s, 0, rig.entry, DIR_S)
    expect(canEnter(rig.s, rig.world, 1, rig.entry, DIR_S)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('junctionSpeedMul gives ROUNDABOUT_SPEED_MUL, and never averages it with the intersection', () => {
    const rig = roundaboutWithOneApproach()
    expect(junctionSpeedMul(rig.s, rig.entry)).toBe(ROUNDABOUT_SPEED_MUL)
  })

  it('averages the roundabout with a TURN, because a car really does turn on a ring', () => {
    expect(laneSpeedMul(s, DIR_N, DIR_E, ringCorner)).toBe(1333)   // (667 + 2000) / 2, truncated
    expect(laneSpeedMul(s, DIR_N, DIR_SE, ringCorner)).toBe(1166)  // (333 + 2000) / 2, truncated
    expect(laneSpeedMul(s, DIR_N, DIR_N, ringCell)).toBe(ROUNDABOUT_SPEED_MUL)
  })

  it('THE ROUNDING DIRECTION IS NO LONGER INERT, and these are the four values that prove it', () => {
    // The equivalent-mutant register's `laneSpeedMul` entry named its own end
    // condition: it holds while every reachable compound average rounds to the
    // same `speedUnits` either way. The roundabout adds two that do not.
    expect(speedUnits(1333)).toBe(439)
    expect(speedUnits(1334)).toBe(440)
    expect(speedUnits(1166)).toBe(384)
    expect(speedUnits(1167)).toBe(385)
  })

  it('keeps the one-crossing-per-tick invariant with room to spare', () => {
    expect(speedUnits(ROUNDABOUT_SPEED_MUL)).toBe(660)
    expect(speedUnits(ROUNDABOUT_SPEED_MUL)).toBeLessThan(MIN_EDGE_THRESHOLD)
  })
})
```

Then land the two rules:

```ts
export function isJunctionCell(state: GameState, cell: number): boolean {
  // **A roundabout is the ALTERNATIVE to a junction, not an instance of one** —
  // M1f Task 9. This one clause lifts both of the junction's costs at once: the
  // mutual exclusion in `canEnter` and the slowdown in `junctionSpeedMul`, which
  // are the predicate's only two readers. That is the whole reason the predicate
  // exists rather than two open-coded degree tests.
  if ((state.roundabout[cell] as number) !== RA_NONE) return false
  return roadDegree(state, cell) >= INTERSECTION_DEGREE
}
```

```ts
/**
 * The junction component of the lane-speed multiplier for a crossing INTO
 * `cell`: `ROUNDABOUT_SPEED_MUL` on a roundabout, `INTERSECTION_SPEED_MUL` on a
 * junction, `MUL_NONE` otherwise.
 *
 * **Renamed from `intersectionSpeedMul` at M1f Task 9, because it now returns a
 * SPEED-UP as well as a slow-down** and a name that says "intersection" would be
 * wrong on the arm that matters. The two are mutually exclusive by construction:
 * `isJunctionCell` returns false on a roundabout cell, so no cell can produce
 * both and §5.5's averaging never sees them together.
 */
export function junctionSpeedMul(state: GameState, cell: number): number {
  if ((state.roundabout[cell] as number) !== RA_NONE) return ROUNDABOUT_SPEED_MUL
  return isJunctionCell(state, cell) ? INTERSECTION_SPEED_MUL : MUL_NONE
}
```

- [ ] **Step 9: Rewrite the rounding-inertness note — the register entry is CLOSED, not carried**

`laneSpeedMul`'s doc says the truncation is a provable equivalent mutant over the whole reachable set, and names its end condition. **The condition has fired.** Replace that paragraph with: the new reachable set (2000, 1333, 1166 added), the two averages whose rounding is now observable, the four `speedUnits` values that pin it, the choice made (truncate, matching `scaleSpeed`'s own truncation, so the two cannot round differently), and a sentence saying the entry has left the equivalent-mutant register. Update the table of reachable combinations in the same comment. **Do not leave the old sentence beside the new one** — a comment that says a thing is inert next to a test proving it is not is this project's dominant defect family.

- [ ] **Step 10: Write the failing test for the ring's own failure mode, and assert it exists**

```ts
  it('the RING BACKS UP: a saturated ring refuses its own entrants', () => {
    // Dossier §1.8: "the failure mode is the ring itself backing up (circulating
    // cars stop to admit entrants, can't reach exits, jam propagates outward).
    // Players report roundabouts freezing solid and ending runs."
    //
    // **Asserted rather than assumed.** A roundabout that could never jam would
    // be a strictly better junction with no cost, which is not the object the
    // dossier describes and not a mechanic with a decision in it.
    const rig = saturatedRing()          // a car on every ring cell, one waiting at an entry
    expect(canEnter(rig.s, rig.world, rig.waiting, rig.entry, rig.dir)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('gives no priority to circulating traffic — an entrant sometimes wins, by car index', () => {
    // Dossier §1.8's inverted give-way, kept by adding NOTHING: contention on a
    // ring cell resolves by the same lowest-index rule as everywhere else, so an
    // entrant sometimes beats a circulator. A priority rule would be new code
    // that changes the roundabout's entire early-good/late-bad arc.
    const lowEntrant = ringRace({ entrantIndex: 0, circulatorIndex: 1 })
    const highEntrant = ringRace({ entrantIndex: 1, circulatorIndex: 0 })
    expect(winnerOf(lowEntrant)).toBe(0)
    expect(winnerOf(highEntrant)).toBe(0)
  })
```

- [ ] **Step 11: Add the fourth action kind and re-derive the tripwire a second time**

`TickActionKind = 'place' | 'erase' | 'choose-card' | 'roundabout'`, dispatched in `step.ts`'s input loop to `applyPlaceRoundabout(s, world, action.a)`. The line-anchored pin in `step.test.ts` goes red **again**; re-derive its comment **again**, and add `roundabout.ts` to the fourth half's scan set (it must not touch demand state either). Add `'sim/src/roundabout.ts'` to `determinism.test.ts`'s file list.

- [ ] **Step 12: Write the failing tests for the chip and the gesture**

```ts
describe('the roundabout chip and its placement gesture', () => {
  it('arms the mode when the chip is tapped and the badge is non-zero', () => {
    const h = host({ roundaboutsHeld: 1 })
    const p = createPointerInput(h)
    expect(p.down(1, ...centreOf(hudRects(h.camera(), hr).roundabout))).toBe(PointerOutcome.ROUNDABOUT_ARMED)
    expect(p.roundaboutMode).toBe(true)
  })

  it('refuses to arm at zero held, and HUD_INERT is the honest answer there', () => {
    const h = host({ roundaboutsHeld: 0 })
    expect(createPointerInput(h).down(1, ...centreOf(hudRects(h.camera(), hr).roundabout))).toBe(
      PointerOutcome.HUD_INERT,
    )
  })

  it('queues a roundabout action at the tapped cell and DISARMS', () => {
    const h = host({ roundaboutsHeld: 1 })
    const p = createPointerInput(h)
    p.down(1, ...centreOf(hudRects(h.camera(), hr).roundabout))
    expect(p.down(2, ...pointOnCell(CENTRE))).toBe(PointerOutcome.ROUNDABOUT_PLACED)
    expect(lastAction(h.queue)).toEqual({ kind: 'roundabout', a: CENTRE, b: 0 })
    expect(p.roundaboutMode, 'one tap, one attempt').toBe(false)
  })

  it('disarms on a REFUSED placement too, and the badge is the feedback', () => {
    // `pointer.ts` cannot know whether `sim` accepted — it is in `game` and must
    // not grow a `sim` import. One tap, one attempt, and a badge that did not
    // decrement is what tells the player it was refused. The alternative — a
    // latch that watches the count — is a second piece of state that can
    // disagree with the first.
    const h = host({ roundaboutsHeld: 1 })
    const p = createPointerInput(h)
    p.down(1, ...centreOf(hudRects(h.camera(), hr).roundabout))
    p.down(2, ...pointOnCell(WATER_CELL))
    expect(p.roundaboutMode).toBe(false)
  })

  it('does NOT start a drag while armed', () => {
    const h = host({ roundaboutsHeld: 1 })
    const p = createPointerInput(h)
    p.down(1, ...centreOf(hudRects(h.camera(), hr).roundabout))
    p.down(2, ...pointOnCell(CENTRE))
    expect(p.dragging).toBe(false)
    expect(h.queue.length, 'exactly one action, and it is not a road').toBe(1)
  })

  it('a second chip tap cancels', () => { … expect(p.roundaboutMode).toBe(false) })

  it('is below the offer modal and below game over', () => {
    const h = host({ roundaboutsHeld: 1, offerPending: true })
    expect(createPointerInput(h).down(1, ...centreOf(hudRects(h.camera(), hr).roundabout))).toBe(
      PointerOutcome.REFUSED_OFFER_MODAL,
    )
  })
})
```

- [ ] **Step 13: Land the chip, the mode and the render**

`HudRects` gains `roundabout: Rect` — this is §7.2's inventory chip row, arriving with its first chip and closing the carry-forward item that has been waiting for something to hold. `hudRects` re-lays the band from three rects to four; **every existing `hudRects` test's geometry moves**, so re-derive them rather than nudging the numbers, and keep the degenerate-viewport clamps covered.

`RenderFrame` gains `roundabouts: Uint8Array` (a raw view of `state.roundabout`, exactly like `roads` and `ghosts` — not a per-frame fold, because `sim` already stores it in the shape `render` wants), `invRoundabout: number` and `roundaboutMode: boolean`.

`canvas.ts` draws the disc **before** the road mask layers, so the ring's road art sits on top of it, and the chip inside `drawHud` with the badge suppressed at zero per §2.2's *"grey outline, badge suppressed"*. While `roundaboutMode` is true the chip is drawn in the accent colour — **the mode must be visible, or a player who armed it by accident has no way to know why their next tap did not draw a road.**

- [ ] **Step 14: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. **No golden moves, and that is derived**: this task adds no region (Task 4 did), and no golden fixture places a roundabout, so `state.roundabout` is all-zero in every one of them and `isJunctionCell`'s new clause is the identity there. **If a golden moves, stop and report** — the most likely cause is `junctionSpeedMul` returning something other than `MUL_NONE` on a bare cell, which would move `1531344761` and every arrival tick behind it.

- [ ] **Step 15: Prove the whole loop end to end, on the production boot**

In `integration.test.ts`: drive to the week-1 boundary, tap the roundabout card, tap the chip, tap a cell measured to matter, and assert — `H_INV_ROUNDABOUT` back to 0, nine cells marked, eight ring segments, the centre road-free, `tilesLeft` unchanged by the ring, and **the run's blocked car-ticks strictly lower than the same run without the placement**. That last clause is the only assertion in this task that says the object does its job.

- [ ] **Step 16: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `isJunctionCell`: delete the roundabout clause | high; must include the crossing-entrant test **and** `junctionSpeedMul`'s |
| 2 | `junctionSpeedMul`: average the two instead of choosing | ≥ 1, in the multiplier test |
| 3 | `junctionSpeedMul`: return `INTERSECTION_SPEED_MUL` on a roundabout | ≥ 1 |
| 4 | `laneSpeedMul`: round the average up | ≥ 1 — **and this is the mutant that was an equivalent mutant until this task**; if it scores 0 the four `speedUnits` pins were not added |
| 5 | `roundaboutCellAt`: swap `dx` and `dy` | ≥ 1, in the hand-written order test |
| 6 | `roundaboutCodeAt`: give the corners `RA_ENTRY` | ≥ 1, in the corner-approach test and in `canPlaceRoad`'s |
| 7 | `applyPlaceRoundabout`: erase the entries' outward bits too | ≥ 1, in the keep/erase test |
| 8 | `applyPlaceRoundabout`: skip the inventory decrement | ≥ 1 |
| 9 | `applyPlaceRoundabout`: mark the cells before erasing | ≥ 1 if the erase path consults the codes; if 0, say so and record that the two orders are equivalent **with the reason**, rather than leaving a bare 0 |
| 10 | `layRoundaboutRing`: skip `payGhostRefund` | ≥ 1, in the ghost test |
| 11 | `layRoundaboutRing`: lay 7 segments | ≥ 1, in the 8-cycle test |
| 12 | `canPlaceRoad`: drop the corner refusal for `a` only | ≥ 1 — **mutate each side of the symmetric comparison separately**; a compound edit is caught while one side alone may not be |
| 13 | `pointer.ts`: keep `roundaboutMode` armed after a placement | ≥ 1, in the disarm test |
| 14 | `pointer.ts`: arm the mode at zero held | ≥ 1 |

- [ ] **Step 17: Commit**

---

## Task 10: The pool filter by map capability

**Observability:** nothing on the default board — `firstCity` has water, mountain and plenty of clear 3×3 land, so its capability mask is all six and the shipped pool is unchanged. **Say that out loud rather than letting a green suite read as a feature.** What the task buys is that a map without a 3×3 site cannot offer a roundabout the player could never place, and a map with no water can never offer a bridge — which is the rule that lets M1g add the other four cards by deleting bits.

**Files:**
- Modify: `packages/sim/src/cards.ts` (`capabilityMask`, `poolFor`)
- Test: `packages/sim/test/cards.test.ts`

**Interfaces:**
- Consumes: `CARD_*`, `CARD_IMPLEMENTED_MASK`, `poolFor` (Tasks 4–5); `ROUNDABOUT_SPAN`, `roundaboutCellAt` (Task 9).
- Produces: `capabilityMask(world: WorldData): number`; `poolFor(world)` becomes `capabilityMask(world) & CARD_IMPLEMENTED_MASK`.

- [ ] **Step 1: Write the failing tests, on the two SHIPPED maps first**

```ts
describe('capabilityMask — spec 5.10, "the pool is filtered by map capability"', () => {
  it('firstCity has water and mountain, so bridge and tunnel are capable there', () => {
    const m = capabilityMask(createWorld(firstCity()))
    expect((m & (1 << CARD_BRIDGE)) !== 0, 'the river at column 12').toBe(true)
    expect((m & (1 << CARD_TUNNEL)) !== 0, 'the mountain at rows 5-7').toBe(true)
  })

  it('demoCity has NEITHER, so both are excluded there', () => {
    // **Both arms of this filter are reachable on the two boards that ship**,
    // which is the catalogue's "measure which cases the shipped configuration
    // can actually produce" satisfied by the game rather than by a fixture. A
    // filter whose false arm only exists in a synthetic map is dead copy that
    // reads as coverage.
    const m = capabilityMask(createWorld(demoCity()))
    expect((m & (1 << CARD_BRIDGE)) !== 0).toBe(false)
    expect((m & (1 << CARD_TUNNEL)) !== 0).toBe(false)
  })

  it('both shipped maps can seat a roundabout', () => {
    expect((capabilityMask(createWorld(firstCity())) & (1 << CARD_ROUNDABOUT)) !== 0).toBe(true)
    expect((capabilityMask(createWorld(demoCity())) & (1 << CARD_ROUNDABOUT)) !== 0).toBe(true)
  })

  it('a map with no clear 3x3 anywhere cannot offer a roundabout', () => {
    // Every row alternates land and water, so no 3x3 is all-passable while every
    // single cell is buildable — the fixture has to distinguish "no space" from
    // "no land", or it is testing the wrong thing.
    const striped = createWorld(parseMap('striped', STRIPED_ROWS, 30, 8, 4, 2))
    expect((capabilityMask(striped) & (1 << CARD_ROUNDABOUT)) !== 0).toBe(false)
    expect(striped.passable.reduce((a, b) => a + b, 0), 'and it is not simply barren').toBeGreaterThan(50)
  })

  it('road tiles, lights and motorways are capable everywhere', () => {
    for (const w of [createWorld(firstCity()), createWorld(demoCity()), createWorld(barren())]) {
      for (const id of [CARD_ROAD_TILES, CARD_TRAFFIC_LIGHTS, CARD_MOTORWAY]) {
        expect((capabilityMask(w) & (1 << id)) !== 0, `card ${id}`).toBe(true)
      }
    }
  })

  it('is a pure function of terrain, so it cannot change during a run', () => {
    // Asserted rather than cached: a cached mask is a second copy of a derived
    // value, and this one is cheap enough that recomputing at each boundary is
    // the honest form.
    const rig = bootCity()
    const at0 = capabilityMask(rig.world)
    for (let w = 1; w <= 6; w++) {
      driveTo(rig, TICKS_PER_WEEK * w)
      chooseWhateverIsOffered(rig)
      expect(capabilityMask(rig.world), `week ${w}`).toBe(at0)
    }
  })
})

describe('poolFor is the two filters, with two reasons', () => {
  it('is the capability mask AND the implemented mask', () => {
    const w = createWorld(firstCity())
    expect(poolFor(w)).toBe(capabilityMask(w) & CARD_IMPLEMENTED_MASK)
  })

  it('excludes the four cards with no placement mechanism even where the map is capable', () => {
    const m = poolFor(createWorld(firstCity()))
    for (const id of [CARD_BRIDGE, CARD_TUNNEL, CARD_TRAFFIC_LIGHTS, CARD_MOTORWAY]) {
      expect((m & (1 << id)) !== 0, `card ${id} is offerable with nothing to place`).toBe(false)
    }
  })

  it('always leaves at least two cards on both shipped maps, or the offer would throw', () => {
    for (const w of [createWorld(firstCity()), createWorld(demoCity())]) {
      expect(popCountCards(poolFor(w))).toBeGreaterThanOrEqual(2)
    }
  })

  it('and every card it admits has a tile grant', () => {
    // The pool and the grant table must not be able to disagree; `cardTileGrant`
    // throws outside the offerable set, and this is what proves the two agree
    // rather than that the throw is unreachable.
    const m = poolFor(createWorld(firstCity()))
    for (let id = 0; id < CARD_COUNT; id++) {
      if ((m & (1 << id)) !== 0) expect(() => cardTileGrant(id)).not.toThrow()
    }
  })
})
```

- [ ] **Step 2: Run to verify they fail; implement**

```ts
/**
 * The cards this MAP could ever offer — spec §5.10's *"pool is filtered by map
 * capability (no tunnels without mountains, no bridges without water)"*.
 *
 * **A pure function of immutable terrain, and deliberately not cached.** A
 * cached mask is a second copy of a derived value with a staleness question
 * attached; recomputing it at each week boundary is a scan of `world.passable`
 * once every 4,500 ticks, which is nothing, and `cards.test.ts` asserts the
 * answer is identical at six consecutive boundaries rather than trusting the
 * word "immutable".
 *
 * The roundabout's capability is *"the map has at least one all-passable 3x3
 * block"*, which is the same shape of question as water and mountain and not a
 * different kind of rule: it asks what the TERRAIN permits, never what the
 * current board holds. A map whose only 3x3 sites are later covered in
 * buildings still offers the card; `canPlaceRoundabout` is what refuses the
 * placement, and it refuses with a reason.
 */
export function capabilityMask(world: WorldData): number {
  let mask = (1 << CARD_ROAD_TILES) | (1 << CARD_TRAFFIC_LIGHTS) | (1 << CARD_MOTORWAY)
  let water = 0
  let mountain = 0
  for (let c = 0; c < world.cells; c++) {
    const t = world.terrain[c] as number
    if (t === TERRAIN.WATER) water = 1
    else if (t === TERRAIN.MOUNTAIN) mountain = 1
  }
  if (water === 1) mask |= 1 << CARD_BRIDGE
  if (mountain === 1) mask |= 1 << CARD_TUNNEL
  if (hasRoundaboutSite(world)) mask |= 1 << CARD_ROUNDABOUT
  return mask
}

/** True iff some 3x3 block of `world` is entirely passable. Allocation-free; early-exits. */
function hasRoundaboutSite(world: WorldData): boolean {
  const half = (ROUNDABOUT_SPAN / 2) | 0
  for (let y = half; y < world.h - half; y++) {
    for (let x = half; x < world.w - half; x++) {
      const centre = y * world.w + x
      let ok = 1
      for (let k = 0; k < ROUNDABOUT_BLOCK_CELLS; k++) {
        if ((world.passable[roundaboutCellAt(centre, k, world.w)] as number) !== 1) {
          ok = 0
          break
        }
      }
      if (ok === 1) return true
    }
  }
  return false
}

export function poolFor(world: WorldData): number {
  return capabilityMask(world) & CARD_IMPLEMENTED_MASK
}
```

- [ ] **Step 3: Re-assert the two moved goldens' offer slots against the narrowed pool**

Task 5 asserted the state golden's and the demand-pin golden's offer slots by hand from `poolFor`. **`poolFor` has changed**, so re-derive both. On both fixtures' maps the answer is the same two cards, so the digests should NOT move — **verify that by running, not by arguing**, and if either moves, the narrowing changed a draw and the re-bless belongs to this task with its own derivation.

- [ ] **Step 4: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS, no goldens moved.

- [ ] **Step 5: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `capabilityMask`: set the bridge bit unconditionally | ≥ 1, on `demoCity` |
| 2 | `capabilityMask`: set the tunnel bit unconditionally | ≥ 1, on `demoCity` |
| 3 | `capabilityMask`: swap the water and mountain arms | ≥ 1, on `demoCity`; **if 0, the fixture cannot distinguish them and a map with water but no mountain is needed** |
| 4 | `hasRoundaboutSite`: check only the centre | ≥ 1, on the striped map |
| 5 | `hasRoundaboutSite`: iterate `y` from 0 | ≥ 1 — the block would run off the top edge; add an edge-hugging fixture if it survives |
| 6 | `poolFor`: return `capabilityMask` alone | ≥ 1, in the four-unimplemented-cards test |
| 7 | `poolFor`: return `CARD_IMPLEMENTED_MASK` alone | **0 expected on both shipped maps**, because both are roundabout-capable. Record it, and note that the striped-map test is what covers it — a mutant that is invisible on every shipped board is exactly why that fixture exists |

- [ ] **Step 6: Commit**

---

## Task 11: Integration, the long run, the sweep, the deploy, the handoff

**Observability:** the whole milestone, checked by a person. This task's deliverable is not code; it is evidence, and the one thing it must not do is report a figure it did not measure.

**Files:**
- Create: `packages/game/test/roundaboutSweep.ts`, `docs/superpowers/m1g-carry-forward.md`
- Modify: `packages/game/test/integration.test.ts`, `packages/sim/src/step.ts` (the sweep table), and every durable artefact whose figures this milestone moved

**Interfaces:**
- Consumes: everything Tasks 1–10 produce. Specifically `countJunctionConflicts` (Task 1), the arm predicate Task 3 shipped — which must be a **single named function**, so Step 1 can revert it cleanly — `applyPlaceRoundabout` and `canPlaceRoundabout` (Task 9), and `poolFor` (Task 10).
- Produces: `sweepRoundaboutPlacements(): readonly RoundaboutSweepRow[]` from `packages/game/test/roundaboutSweep.ts`, where `RoundaboutSweepRow = { readonly centre: number; readonly deathTick: number; readonly trips: number; readonly blockedCarTicks: number }`; and `docs/superpowers/m1g-carry-forward.md`, whose named recipients are the next milestone's inputs.

- [ ] **Step 1: Reproduce an inherited number before contradicting anything**

Before this task believes its own rig about anything, drive the greedy arm with **Task 3's shipped rule reverted** and assert it reproduces the pre-M1f record exactly: **31,456 / 747 / 0 refusals / 2,120 blocked car-ticks**. This project's closing sweep has caught its own harness twice this way — once for omitting the warm start, once for omitting the opening stroke — and both times every conclusion drawn from the bad rig would have been *a confident correction of a correct figure*.

- [ ] **Step 2: Re-run the 17 transposition rows whose phases changed, and PROVE the other 38 did not**

Tasks 6 and 9 changed phase 3's content (two new action kinds, a clock read, a `H_TILES` write) and Task 2 changed phase 9's (movement). Re-run every pair involving **3** or **9** — 9 + 9 − 1 = **17 rows** — plus four fresh unmutated baselines.

For the other 38, **prove rather than assume**: `git diff <Task-5-commit>..HEAD --stat` over the files each of those phases calls must be empty for the phases involved, and the proof goes in the report as the command and its output. *"One row is not the sweep"* cuts both ways — a claim that 38 rows still hold is a claim, and a `git diff` is the cheapest honest evidence for it.

Run the control as many times as each mutant; screen crashes on non-vitest-result lines and record every matched line; run the complement check.

- [ ] **Step 3: The roundabout placement sweep — trap 4's criterion, against the real object**

Create `packages/game/test/roundaboutSweep.ts`: enumerate every centre cell at which `canPlaceRoundabout` accepts on the shipped board at the week-2 boundary of the greedy arm; for each, run the greedy arm to death with that one placement; record death tick, trips and blocked car-ticks. The control is the same arm with the card taken and **nothing placed**.

```ts
  it('the spread between the best and the worst placement of one roundabout exceeds 25 %', () => {
    const results = sweepRoundaboutPlacements()
    expect(results.length, 'the sweep is not vacuous').toBeGreaterThan(10)
    const best = Math.max(...results.map((r) => r.trips))
    const worst = Math.min(...results.map((r) => r.trips))
    // **NOT +68 %.** That figure came from EXEMPTING a cell — giving it
    // unlimited crossing throughput — and it is a ceiling, not a forecast. A
    // real 3x3 keeps per-lane occupancy on every ring cell, adds up to four
    // cells of travel to a crossing, gives circulating traffic no priority, and
    // can freeze solid. The claim worth making is that WHERE the player puts it
    // matters, and 25 % is the threshold at which a placement is a decision
    // rather than a formality.
    expect((best - worst) / worst, `best ${best} worst ${worst}`).toBeGreaterThan(0.25)
    // The load floor, so this cannot be passed by a board with no traffic:
    expect(results.every((r) => r.blockedCarTicks > 10000), 'every arm still has jams').toBe(true)
  })
```

**If the spread is below 25 %, that is the milestone's headline finding and it goes in the report's first line.** Do not weaken the criterion; do not tune the object to reach it. Report the measured spread, the best and worst cells, and what the exemption ceiling was for the same cells, so M1g inherits the gap.

- [ ] **Step 4: The long run, on the production boot, across a seed set**

Drive `createGame` with its own `InputQueue` and frame loop, greedy connector plus a card policy that always takes the roundabout, across the **eight** `RUN_SEED` values the carry-forward enumerates (`laneways-m2`, `s1`…`s7`). Record per seed: death tick, trips, blocked car-ticks, longest queue, valve firings, peak `destPins` per week, delivery fraction per week, `tilesLeft` minimum, unaffordable events, roundabouts placed.

**Report distributions, not runs.** A single-seed claim below 2× is inside the noise, and **the shipped seed is an outlier** — the quietest of the eight on blocked car-ticks and one of only two that never valved before this milestone. Every headline figure gets both: the shipped seed's value, and the eight-seed range.

State both clocks for every time: `tick / 30`, and the stopwatch figure `(tick − warmStart) / 30` with `warmStart` 258 for `city` and 1,200 for `demo`. **Two counters, one sentence — say which counter each is.**

- [ ] **Step 5: The invariants, over the longest run, with a LIVENESS assertion beside them**

Occupancy soundness and completeness, the reservation invariant, no counter wrap, the tile ledger **with its new roundabout-ring term**, and `assertNoRoadOnImpassable`. **Every safety property is trivially true of a frozen system**, and this milestone freezes on game over — so the sweep asserts off the **peak overcrowd meter** and off cars-in-motion rather than off the terminal flag, because a meter that climbs and unwinds never sets the flag and it is the tick *before* the flag that says the margin is gone.

- [ ] **Step 6: Enumerate every `Uint8Array` write, and confirm M1f added no decrement path**

By **enumeration of the writes**, never by grepping for `--`: the one path M1d actually added spells it `const left = committed - 1` across two statements. The expected answer is three paths, unchanged: `destPins` and `destReserved` in `trips.ts`, `ghostCommitted` in `roads.ts`. `roundabout` is written **only upward** and `H_INV_ROUNDABOUT` is `Int32`. Record the enumeration in the report.

- [ ] **Step 7: Re-measure the four carry-forward figures this milestone moved**

- **§15.5's tile slack.** It was 62 tiles spent of 210 granted on a six-week run. Income is now 30 + the card's 20 or 30 and the run is shorter. Give the new pair, the new `tilesLeft` minimum, and the new unaffordable count, and hand the tile economy to M1g with the number rather than with an adjective.
- **§12's run length.** 17:19.9 on the stopwatch before this milestone; give the new figure on the shipped rule, with and without a roundabout taken.
- **§10 / §5's valve.** It fired 0 times on the shipped board. Give the new count, the worst wait, and the first firing tick.
- **§15.10's frame cost.** M1f is the first milestone that can produce a real jam on the shipped board. The allocation harness says **nothing at all** about frame time; this is a device question, not a budget, and it must be labelled *"one device, qualitative"* if a person answers it.

- [ ] **Step 8: Sweep every durable artefact against the tree, deliberately, as a step**

The three artefact classes that cannot be corrected in place or that everything downstream reads: **the final commit message, the handoff, and the testing defect catalogue.** For each figure in each, check it against the tree, and mark it **confirmed** (with the assertion or constant that pins it), **corrected** (with the measured value and the rig beside it), or **UNVERIFIED** (could not be reproduced on any arm this tree can drive — *not known to be wrong, known to be unchecked*, which is a different and more useful thing to say).

The mechanism to look for is **decay, not carelessness**: a figure that was right for its own task and wrong two tasks later. Every one of them passes the review that ships it. And **the correction is where the danger concentrates** — a corrected figure reads as verified in a way the original never did, and this project has produced four wrong corrections. Where a figure matters, the repair is not to edit it a second time but to **assert it**, on a rig, so it cannot come back.

Specific known hazards in this milestone: the phase numbers (every one above 3 moved in Task 5); `4 <-> 5` (renamed to `5 <-> 6`); the two death ticks (moved twice, in Tasks 2 and 3); `271` (a census figure that must NOT have moved and must be re-checked to prove it); the nine golden digests and their assertion sites; `NB`'s corrected margin (14, not "zero slack").

- [ ] **Step 9: Deploy, and verify the ARTEFACT rather than the command's exit message**

`wrangler deploy` has printed `Success! Uploaded 2 files` while the served HTML still referenced the previous asset hash — the upload succeeded and the deployment never activated. **Fetch the live artefact and grep it for a build-unique token.** And note that `vitest` loads `vite.config.ts` as its own config, so a test run immediately before a deploy can mint a fresh `.build-id`; confirm `apply: 'build'` is still on the build-id plugin before trusting `verify-deploy.js`.

- [ ] **Step 10: Write the device checklist — six questions, one phone, one sitting**

Ordered by what is most likely to be wrong, each with the expected observation and the moment it happens, each answer recorded with the words **"one device, qualitative"** attached. The M1f-specific ones, in order of risk:

1. **The modal at 2:21.** Does a board that stops dead and shows two cards read as a choice, or as a freeze? It is the first time this game has ever interrupted the player. *Watch for: the up-to-7 ticks of drain before the pause lands, which should be invisible; and the paused cars sitting 0.09–0.22 cells short of their sim positions, about 6 CSS px, frozen for as long as the player takes.*
2. **The two cards.** Is "30 ROAD TILES" against "ROUNDABOUT · +20 TILES" a decision, or is one of them obviously right every time? **The honest measured answer from Task 11 Step 7 goes beside whatever the person says.**
3. **The peek button.** Does it read as "look underneath", and does the way back read as a way back?
4. **The chip and the gesture.** Tap the chip, tap the board. Does the mode read as armed? Does a refused placement read as refused — the badge is the only feedback, and it does not move.
5. **The jam at 6:57.** Play normally and watch for the first queue. Does a car stopping at a corner read as traffic, or as a bug? *This is the question M1d's failure makes mandatory: the feature has to be visible to somebody who was not told where to look.*
6. **The roundabout working.** Place one on the corner the sweep names as best. Does traffic visibly flow through it? Then, on a fresh run, place one on the cell the sweep names as worthless. **Can the person tell the difference?** If not, the 25 % is a number in a test and not a mechanic.

Keep the existing six questions too — the empty opening, the ring's legibility, the shutdown copy, the ghost art, the restart, the first ten minutes — and re-derive every clock time in them against the M1f board rather than copying them forward. Several will have moved: the run is shorter, the ring appears at a different tick under a different rule, and the shutdown arrives sooner.

- [ ] **Step 11: Write `docs/superpowers/m1g-carry-forward.md`**

Every item gets a **named recipient** — a task, a milestone doc, or a file — because *"someone" is a synonym for "no one"*. Every figure gets its rig, and the document opens with the same vintage warning this one inherited: a figure in it is evidence about the commit it was measured at and about nothing after it.

It must contain, at minimum: everything in this plan's Out table with its measurement; the roundabout deletion path and the mid-traversal rule change it implies; the tile economy with Step 7's number; `CARD_IMPLEMENTED_MASK` and the four cards behind it; the round-robin/nearest mismatch with the better evidence a queued board now gives it; the equivalent-mutant register at its M1f state (`laneSpeedMul`'s entry **closed**, `5 <-> 6` **open**, the other three unchanged); the golden ledger at nine digests with their new values; and the census's 271 with the definition that produced it.

**And carry the CONTENT, not the cardinality.** *"The five open items"* with none of their text is the same defect as a count without its items, and the recipient cannot distinguish present-and-empty from absent. Check the finished document with **one grep per item against a list of names**, not by reading it — this project's last handoff read as thorough from every angle except that one, and two of eight items were absent.

- [ ] **Step 12: Final commit, with the report and the commit message checked against each other**

**When a task's report and its commit message disagree, the report is usually right and the commit message is what ships.** Check the durable artefacts against the measurements last, deliberately, as a step — not as a side effect of writing them. A vague sentence sharpened into a specific claim *after* the evidence and pointing away from it is how this project's dominant defect family works.

---

## Sequencing: what can be reviewed apart, and where the real dependencies are

- **Task 1 blocks Task 2** and nothing else, but it must be first in time regardless: it is the task that decides whether the junction's cost can be routed around, and trap 1 is that Task 1 can make Task 9 worthless **after** Task 9 is built. A milestone that lands the interlock last has spent nine tasks on a feature the tenth could delete.
- **Task 2 blocks Task 3, and Task 3 must land before Task 4.** This is the one ordering in the plan that is a correctness requirement rather than a convenience: Task 3 decides the shipped junction rule, and every death tick, every profiling window and every gate figure in Tasks 4–11 is measured against it. **A Task 3 discovered inside Task 9 is the balance decision arriving after the object built on it.**
- **Task 4 blocks everything after it.** It is the milestone's only shape change and every later task assumes the header slots and the region exist. It also lands the two RNG guards **before** Task 5's draw can violate them, which is the whole reason its first three steps are a separate commit.
- **Task 5 depends on Task 4** and owns the renumbering. Nothing may be inserted between Task 5 and the repointing of every phase number in the repo, because a half-renumbered tree has two conventions in it and no way to tell which a given comment uses.
- **Task 6 depends on Tasks 4 and 5** and is deliberately two commits ahead of the UI, so `choose-card`'s semantics can be wrong in a test before they can be wrong on a screen.
- **Tasks 7 and 8 must be ADJACENT, with nothing between them.** Task 7 ships a build in which the default board freezes at 2:21 with no way out; Task 8 is what gives it a screen and a choice. Between those two commits the build is strictly worse than the one before them, and `offerInterlock.test.ts` is red for exactly that span.
- **Task 9 depends on Tasks 2, 4 and 8** — on Task 2 for the junction rule it relieves, on Task 4 for the region, and on Task 8 because a roundabout nobody can be granted is a mechanic with no way in. It does **not** depend on Task 10.
- **Task 10 depends on Tasks 4, 5 and 9** (it needs `roundaboutCellAt` for the site test) and could be reviewed in parallel with Task 9's second half by a second reviewer.
- **Task 11 depends on everything**, and its Step 1 depends on being able to revert Task 3's rule cleanly — so Task 3's arm must be implemented behind a single, named predicate rather than smeared across `canEnter`, or the reproduce-before-you-contradict step cannot be run.

**Two tasks could be reviewed by someone with no context on the game**: Task 1 (a spec amendment, a constant move, one assert and two scans) and Task 10 (a pure function of terrain). Everything else needs the milestone in its head.

---

## What this plan does not settle

- **Whether the shipped pool being exactly two cards is enough of a choice.** The offer is the same pair every week and only the order varies. Measured: tiles are 3.4× slack before this milestone and looser after it, so ROAD_TILES is the weak card until the board tightens — while the roundabout's value is measured to fall off fast, since the second one has nowhere as good as the first to go. That makes the choice real for the first two or three weeks and thin afterwards. **Task 11 Step 7 gives the number; M1g owns whether the answer is more cards, fewer tiles, or a tile cost on the roundabout.**
- **Whether the junction rule's shipped arm is the right one.** Task 3 picks between three with a criterion written before the measurement, and the criterion is about instruments and load floors rather than about feel. The arm that survives may still be too harsh or too weak for a player; the only instrument for that is Task 11's device session.
- **What the roundabout is worth against the exemption ceiling.** +68 % was the ceiling for one cell with unlimited throughput. The real object is strictly less by an amount nobody has measured, and Task 11 measures the **spread** rather than the absolute. If the spread misses 25 %, the roundabout is a formality rather than a decision and M1g inherits a mechanic that needs re-pricing, not a bug.
- **Whether one roundabout per week is the right rate**, and whether the inventory should be spendable later rather than immediately. §2.2 says items sit unplaced indefinitely and experts bank one as an emergency valve; M1f honours that (the chip persists) and measures nothing about it.
- **Deleting a placed roundabout.** Out, with a reason: un-marking nine cells while a car is mid-crossing on one of them changes that car's speed and its junction rule inside a traversal, which is a new class. **A roundabout placed on the wrong cell is permanent for the run**, and the device session asks whether that reads as a mistake a player can live with.
- **Whether the ring should be one-way.** Out, with a reason: a direction-restricted segment breaks `LANE_OF_DIR`'s symmetry, the flow field's undirected relaxation and the return leg's "same route backwards" identity at once. What is kept is the part that matters — the crossing conflict disappears and the ring can back up.
- **Whether tile income should have moved to the card entirely.** Decision 5 states the refusal and its reason. §5.10 literally says every card grants tiles *so a bad draw can never softlock*; M1f satisfies the purpose through the automatic grant and adds the card's bonus on top, which is a balance change, named, with a measurement and a recipient.
- **The scheduler.** §15.2's round-robin/nearest mismatch is the term that actually decides whether a *connected* destination lives, and M1f declines it deliberately so that the junction rule and the roundabout stay attributable. It is the largest thing this milestone leaves open, exactly as it was the largest thing M1e left open — and the evidence for it is better now, because there are queues to measure.
- **Frame time under a real jam.** M1f is the first milestone that can produce one on the board that ships. The allocation harness measures allocation and says nothing about time. One device, qualitative, or nothing.

---

## Self-review

**1. Spec coverage.**

§5.5's *"one blocking primitive: does an inbound vehicle collide with a traversing vehicle on this chunk"* → Task 2, with Task 3 deciding between the co-presence and the collision readings against a written criterion. §5.5's *"max wait at intersection before proceeding anyway = 45 s"* → already shipped as `MAX_BLOCKED_TICKS`; Task 2 is the first thing that makes it fire on a shipped board, and it corrects the two sentences in its comment that Task 2 falsifies. §5.5's lane-speed table — `roundabout multiplier 2.0` → Task 9's `junctionSpeedMul`, the first caller `ROUNDABOUT_SPEED_MUL` has ever had; *"where multiple multipliers apply, average them"* → Task 9 extends the existing average and its rounding note.

§5.6's roundabout — 3×3, centre plus all 8 neighbours clear of buildings, water and mountain; may overwrite road, refunded; cost 0 tiles; connects from the 4 orthogonal neighbours; no enforced right-of-way; the ring backs up → Task 9, clause by clause, with Decision 12 keeping the inverted give-way by adding nothing. §5.6's **traffic lights** → deferred to M1g in the Out table with their six constants named.

§5.10's *"fires at the end of each in-game week, full-screen paused modal, exactly 2 options, plus a peek button, no skip, no bank, no reroll, no timer"* → Tasks 5–8. *"Every card grants road tiles, so a bad draw can never softlock"* → Task 6's `cardTileGrant`, with Decision 5 recording that the purpose is met by the automatic grant plus the bonus rather than by the card alone, and that the deviation is a balance change with a measurement and a recipient. *"Pool is filtered by map capability"* → Task 10. The card table's Bridge / Tunnel / Traffic Lights / Motorway rows → out, behind `CARD_IMPLEMENTED_MASK`, which is an interlock rather than an absence.

§5.4's *"model intersection and traffic-light penalties as extra integer edge weight"* → **refused by amendment** in Task 1, with provenance, an interlock, and the cost of reversing it written into the amendment itself. §5.4's Dial's-bucket-queue constraint → Task 1's `assertPushWithinBucketWindow`, and `NB`'s corrected margin quoted rather than the wrong one this project has repeated.

§7.2's inventory chip row → Task 9's first chip, with §2.2's *"solid dark icon + numeric badge when held, grey outline and badge suppressed at zero"*. §7.3's input → Task 8's arbitration and Task 9's gesture, both with a full outcome enum so a negative assertion can name which guard refused.

§4.1's determinism rules → Global Constraints, plus two new enforcement points: the RNG-consumption ban and the `rng[0]`-invariance test, both landed green before the code that could violate them. §11's testing spine → Global Constraints and every task's mutation table.

**Gap found and closed while reviewing:** the plan originally left `runOffer`'s pool as `CARD_IMPLEMENTED_MASK` and Task 10 as the capability filter, which would have made Task 10 **vacuous on both shipped maps** — the exact "a branch no board reaches is dead copy that reads as coverage" defect. It is closed by making the roundabout's capability *"the map has an all-passable 3×3"*, which `demoCity` and `firstCity` both satisfy while the striped fixture does not, **and** by checking bridge/tunnel against the two shipped maps, which genuinely differ: `firstCity` has water and mountain, `demoCity` has neither. Task 10 Step 5's mutant #7 records the one mutant that is invisible on both shipped boards and names the fixture that covers it.

**Second gap, found and closed structurally:** Task 7 ships a build that freezes at the first week boundary with no way out. The plan's first draft disclosed it in prose. Disclosure is what M1e's Task 8 did and *"nothing in the tree prevented a deploy landing there"*; the mitigation that worked was a deliberately failing test keyed on something the next task must structurally change. `offerInterlock.test.ts` is that test, keyed on `PointerOutcome.CARD_CHOSEN` — an outcome that cannot exist without the rects, the arbitration and the enqueue, so no cosmetic change satisfies it.

**Third gap, found by re-reading the carry-forward's own instruction:** §15.2 and §15.3 are both addressed to M1f *in the imperative* — "M1f owns choosing between them", "M1f should either surface it or bound it". Silence would have been a drop. Both are now explicit refusals with reasons and named recipients, and both carry the measurement that makes the refusal safe.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N", no "write tests for the above". Every code step carries real code, and every function, constant and type used in a later task is defined in an earlier one's Produces block.

**Deliberate blanks, and each is a value only running the code can produce:** the eight re-blessed digests and their ten sites (Task 4 Step 12); the two re-blessed digests in Task 5 Step 5; both death ticks (Task 2 Step 6 and Task 3, which is why no number for them appears anywhere in this plan); Task 3's three-arm measurement table; Task 11's sweep, seed distributions and device answers.

**Everything else that looks like a blank is a figure this plan states as the value to REPRODUCE**, so a disagreement is a finding rather than a fill-in: the census's **271 / 12,780 / 5 cells** (Task 1 Step 13, with the definition beside it); the exemption arm's **31,456 / 747** and its hash equality (Task 2 Step 8); trap 3's seven gate figures; the four `speedUnits` values **439 / 440 / 384 / 385** (Task 9 Step 8); `speedUnits(2000) = 660` against `MIN_EDGE_THRESHOLD` 2,500; the buffer arithmetic **1,840 / 4,320 / 8,808 / 14,968** and **30 regions**, which Task 4 is told to verify by running `computeLayout` rather than by trusting the table.

**3. Type consistency.** `runOffer(state, world, scratch)` returns `void` and matches `runDemand`/`runSpawn`/`runOvercrowd`'s shape; it takes `scratch` for `offerPair`, and Task 5's Produces block says so in the same paragraph that introduces it. `offerPending(s)` and `offerSlot(s, slot)` are defined in Task 4 and used under those exact names in Tasks 5, 6, 7 and 8. `poolFor(world)` is defined in Task 5 as the implemented mask alone and **redefined in Task 10** as `capabilityMask(world) & CARD_IMPLEMENTED_MASK` — the signature does not change, and Task 10 Step 3 re-derives the two golden assertions that read it, which is the one place a signature-stable redefinition could have gone unnoticed. `drawOfferPair(pool, seed, out)` writes a caller-owned `Int32Array` in Tasks 4, 5 and both golden re-blesses. `cardTileGrant(cardId)` is Task 6's and is consumed by Task 10's agreement test. `isJunctionCell(state, cell)` is Task 2's and is **amended, not replaced,** in Task 9 — same name, same signature, one added clause, two readers. `intersectionSpeedMul` is renamed to `junctionSpeedMul` in Task 9 and the rename is stated in that task's Produces block, because a `clearLayers`/`clearFullLayers` split is exactly what this check exists for. `roundaboutCellAt(centre, k, w)` takes a scalar width, matching `carparkCell`'s and `stepCell`'s convention, while `canPlaceRoundabout(state, world, centre)` and `applyPlaceRoundabout(state, world, centre)` take `WorldData` — the same split M1e drew between `spawnZoneW`/`spawnZoneH` (scalars, the axis primitives) and `spawnZoneCells`/`inSpawnZone` (`WorldData`), and it is stated rather than left to be inferred. `layRoundaboutRing(state, world, centre)` lives in `roads.ts` and is called from `roundabout.ts`, never the other way round, so `roads.ts` keeps sole ownership of `state.roads`. `PointerOutcome` gains 10–14 in two tasks (`CARD_CHOSEN`, `PEEK_TOGGLED`, `REFUSED_OFFER_MODAL` in Task 8; `ROUNDABOUT_ARMED`, `ROUNDABOUT_PLACED` in Task 9) and no value is reused. `FrameDriverDeps.onOfferRaised` and `peeking` are declared **required** in Task 7 and passed in `main.ts` in the same task. `EraseControl.suspend`/`resume` are Task 8's and are called from `main.ts` in the same task.
