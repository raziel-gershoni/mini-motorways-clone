# M1e: the game loop — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the city grow, make a badly-run city kill the run, and make the run something you can start again — so that Laneways stops being a traffic simulation you watch and becomes a game you can lose.

**Architecture:** Three new `step` phases around the six that exist — a **week boundary** that grants flat tile income (§5.10), a **spawn** phase that grows houses and destinations inside the revealed rect on an authored schedule (§5.9), and an **overcrowd** phase that integrates a per-destination timer and ends the run when one completes (§5.8) — plus a week-indexed demand ramp (§5.3) implemented as a shrinking pin period rather than a scaled accumulator, so week 0 stays byte-identical to today. The renderer gains an overcrowd ring, a shutdown screen and a tap-to-restart. The default board flips back to the buildable starting city **last, in its own task, gated on a survivability run that can only be measured once overcrowd and game over exist.**

**Tech Stack:** TypeScript, pnpm workspaces, zero runtime dependencies, integer-only in `sim`, Vitest, Canvas2D, Cloudflare Workers.

---

## What changed in this revision, and why you are reading a rewrite

An adversarial pre-execution review of the first draft returned **DO NOT EXECUTE**, on two findings. Both are now load-bearing structure in this document rather than fixed typos, and an implementer who does not know them will re-introduce them.

1. **The first draft asserted, at five sites, that "the demo board is inert under all of this, by construction and not by luck."** It is not. With the overcrowd meter and game over landed, the shipped demo board — the only board a human has ever played on this project — shuts itself down partway through the fourth minute, with no player error possible. Three independent integrations of the plan's own arithmetic agreed to within one tick. **This revision does not suppress that. It reframes it: the demo board is a deliberately overloaded city, so a milestone whose headline is "an overloaded city dies" SHOULD kill it, and the honest plan says the tick out loud, caps every measured window below it with the margin named, and ships the restart that makes a terminal state playable.** See Decision 7.
2. **The test written to protect the false claim asserted the only two quantities that could not move** (`H_HOUSE_COUNT` and `H_DEST_COUNT` on a board at both caps). It passed while the claim was false, and after game over it would have passed *because the sim was frozen* for two thirds of its window. That is M1d's failure shape verbatim, inside the milestone written to correct M1d. Every "nothing changed" assertion in this revision names a quantity that **can** move and carries `expect(isGameOver(state)).toBe(false)` as its vacuity guard.

The review's third finding is the one that reshaped the task list: **difficulty and loss were measured to come from two different places, neither of which the plan's acceptance gates could see.** Decision 2 states the model, derives the numbers, and names the one gate that can fail. The default-board flip moved from Task 5 to Task 10 so that gate can exist before the flip depends on it.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **`sim` is integer-only, allocation-free, and deterministic.** One `ArrayBuffer`; struct-of-arrays typed-array views; seeded mulberry32 held **inside** `GameState`; `hashState` is FNV-1a over the whole buffer. **Browser and Cloudflare Worker replay of identical inputs must produce BYTE-IDENTICAL state.** No `Math.random`, no `Date`, no transcendentals, no float literals, no module-scope mutable state, no iteration over `Map`/`Set`/object keys for anything sim-affecting.
- **Rule constants are integer numerators over a denominator of `DENOM` = 1000**, converted only in `packages/shared/src/constants.ts`. A ramp of 0.02 is `20`.
- **Cell index convention is `index = y * w + x`.** Occupancy slot convention is `slot = cell * 2 + lane`. **M1e adds a third index arithmetic** — the spawn-zone index, `zoneIndex = zy * spawnZoneW + zx` — and it must never be confused with either. Only `spawn.ts` converts between them.
- **Zero allocations per tick and per frame.** Three harnesses, and confusing them is a recurring defect: `packages/game/test/allocation.test.ts` profiles `packages/game/src` **and** `packages/sim/src` and measures **the tick**; `packages/game/test/drawAllocation.test.ts` profiles `packages/render/src` and measures **the frame** (it flakes roughly 1 run in 10 — re-run before recording a kill from it); `packages/game/test/demoAllocation.test.ts` profiles all three on the demo board. `NOISE_FLOOR_BYTES_PER_FRAME` is 4. A green harness is a claim about the inputs it was given — prove liveness by injecting into the **new** code, and make the injected object escape (`(globalThis as any).__sink = {…}`), never `void __sink`.
- **Every window that profiles or measures a live sim states its end tick and its margin to game over**, and asserts `expect(isGameOver(state)).toBe(false)` after its final drive. This is new in this revision and it is not optional: `demoAllocation.test.ts`'s final window ends within a few percent of the demo board's death tick, and every vacuity guard it has (car count, destination count, road count) passes on a frozen board, because frozen cars keep their phase and frozen roads keep their bits.
- **`packages/render` imports NOTHING from `packages/sim`.** Enforced by a source scan whose one real catch is a raw relative path.
- **EIGHT goldens.** Seven are `hashState` over the whole buffer: `340556353` (`packages/sim/test/determinism.test.ts:577`), `2076760277` (`packages/sim/test/rollback.test.ts:709`), `2942219448` (`packages/sim/test/loop.test.ts:1073`), `294084758` (`packages/sim/test/loop.test.ts:2010`), `3113654132` (`packages/sim/test/cars.test.ts:1790`), `1178110182` (`packages/game/test/startingCity.test.ts:631`), `1039862014` (`packages/game/test/demoLayout.test.ts:474`). The eighth, `252514232` (`packages/sim/test/rollback.test.ts:753`), is `foldedFieldsHash` over `dist`/`dir`, which live **outside** the buffer — **it is a tripwire, not a golden, and it must not move in any task of this milestone.** Any task that moves a golden must say so in advance, say why, and record the prior value in a re-bless comment at the site and in the commit message. **If a golden moves and your task did not say it would, stop and report — do not re-bless.**
- **Canonical test invocation.** Plain `pnpm test` BAILS at the first failing package and hides every later one; `pnpm test --no-bail` crashes vitest; `pnpm --no-bail test` also bails, because the root script is itself recursive. Only this reaches everything:
  ```
  pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test
  ```
- **Every task mutation-tests its own tests.** For each behaviour, record the one-line change that makes its test fail. **Every kill must be an ASSERTION FAILURE naming the behaviour, never a `ReferenceError`, `TypeError` or module-load failure** — a crash count reads exactly like a kill count. Screen on the **error-class line**, not anywhere in the output (a test *name* containing the word `TypeError` has already produced a false positive here, and a false positive silently discards a valid mutant). Run the **complement check** too: per-package test totals must be unchanged under each mutant, or the mutant stopped collection. Anchor every mutation on a line the program runs, never on a comment.
- **Never run two implementers at once.** They share the main checkout; only reviewers get worktrees. Before quoting any suite-wide number, check `git status` for strays and source mtimes against your own last write.
- Do not modify `spike/`.
- Plans do not state expected test counts, and neither do reports.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## The observability contract

M1d shipped correct, tested at 0 Critical, and deployed with the artefact verified byte-for-byte — and the user opened it and said it looked like the same demo. They were right: `PIN_PERIOD_TICKS` with two rotation slots gave one pin per colour per 259 ticks against a ~60-tick round trip, so the milestone's headline feature could not fire on the board that shipped. Every acceptance criterion it had was machine-side and satisfiable on a purpose-built fixture.

**So every task in this plan carries an `Observability:` line phrased as what a human will see, on the board that boots by default at the time that task lands. Where the honest answer is "nothing", the task says so.**

**That clause — "at the time that task lands" — is doing real work in this revision.** The default board is the **demo board** for Tasks 1 through 9 and the **starting city** from Task 10 onward, because Task 10 is where the flip happens and Task 10 needs Tasks 7–9 to exist before its gate can be measured. That is not a weakening: the demo board is 24 cars at 18 destinations with a car refused entry on 53 % of ticks, which is the *best* board in the repo on which to watch a ring fill and a city shut down. Tasks 7, 8 and 9 have stronger observability lines on the demo board than they would have had on an empty starting city.

**The milestone-level answer.** After M1e, a plain load opens the starting city. A player sees a nearly-empty board with three houses and three destinations, draws a road with their finger, and watches cars run it. Then: **new buildings appear** while they play; **the tile counter jumps by 30** every two and a half minutes; **a ring fills around any destination whose queue is over capacity**; if a ring completes, **the city stops dead and says which destination did it**; and **a tap starts a new run.** Five things, all unprompted, all on the default board.

---

## Scope

**In:** the week boundary and flat tile income; the authored spawn schedule for houses and destinations, bounded to the revealed rect; the weekly demand ramp; blocked-spawn redistribution; the per-destination overcrowd timer with its ramp, unwind and arrival knockback; game over, made terminal; the restart; the renderer surface for all of it; the default-board flip behind a measured survivability gate; two per-tick allocations M1d handed here by name; and the comment sweep.

**Out, each with a named recipient, because "handed to whoever owns X" is a drop when nobody owns X:**

| Deferred | Owner | Why |
|---|---|---|
| **The two-card upgrade modal and the card pool (§5.10)** | **M1f** | Every card in §5.10's table but Road Tiles grants an **item** — bridge, tunnel, roundabout, traffic lights, motorway — and **none of them has a placement mechanism yet.** A pool with one offerable entry is a menu with one item, and a modal that offers the same card twice is worse than no modal. Shipping the pool with five unofferable entries would be dead code that reads as a supported configuration, which is the exact thing M1d's decision 1 forbids (`CARS_PER_CELL`). So M1e ships §5.10's **load-bearing half** — *"Tile income is flat, not week-indexed; difficulty ramps on the demand side only"* — as an automatic weekly grant of `WEEKLY_TILE_GRANT` = 30, and M1f ships the choice on the day there is something to choose between. **The first thing M1f must decide is which item comes first; the cheapest by a wide margin is the bridge/tunnel pair, because they need no new input surface at all — a bridge is spent by dragging a road across water with the gesture that already exists.** |
| **Traffic lights and roundabouts (§5.6)** | **M1f** | Both are upgrade cards, so they are behind the modal above. Lights are additionally the change that would make car positions a **flow-field input** — every `FIELD_IRRELEVANT` reason in `regions.ts` is currently dated *"M1e's demand-actuated lights"*, and M1e must repoint all of them (Task 11). Roundabouts additionally overwrite road with a refund, which composes with ghost cells and needs its own tests. |
| **Motorways, bridges, tunnels (§5.7, §5.1)** | **M1f** | Same modal dependency. Bridges and tunnels additionally break a named, tested invariant in three places — `assertNoRoadOnImpassable` (`roads.ts`), `placeRoad`'s `world.passable` gate, and `graph.test.ts`'s randomised *"every neighbour has `passable === 1`"* property — so they are a task of their own, not a branch. **Note that `firstCity`'s river has a natural two-cell land gap at rows 18–19**, so the default board is fully connectable without a single bridge; the gap is a choke point, which is good level design rather than a workaround. |
| **Board expansion / a real revealed region (§5.1)** | **M1f** | **This is the item most likely to be missed: it was addressed to M1d in the imperative in eight files, M1d declined it, and M1e declines it too — so say it out loud rather than repointing quietly.** The reasons are unchanged and one is new. Unchanged: expansion is a per-map, per-week schedule that `MapData` does not carry, and adding it means folding it into `mapIdHash` (`world.ts` says so explicitly), which moves every whole-buffer golden a **second** time in a milestone that budgets exactly one shape change; plus `canvas.ts`'s culling note needs a `clip` around draw phases 3–8; plus `frame.test.ts`'s two fold markers sit in **diagonal corners**, which stops working the moment the fold is 2-D over a dynamic rect (a corner is past two bounds at once, so extending any single bound reaches nothing — each of the four half-plane bounds needs its own marker one cell past exactly one of them). **New: M1e makes this work strictly larger**, because `packages/sim/src/spawn.ts` now reads `REVEALED_X0/Y0/W/H` from `@laneways/shared` to bound where buildings may appear. When the rect becomes state, the spawn zone must move with it. Task 11 repoints every site to M1f. |
| **Drawing the two lanes** | **M1f (renderer)** | **The other half of this row — the stop/start snap — SHIPPED on 2026-08-10 in `76cffb5` and is no longer deferred.** `resolve.ts` now chases the sim position: per tick the drawn speed changes by at most one `DRAW_SPEED_STEP` (0.044 cells/tick, derived as the step the sim itself applies at a right-angle cell), clamped so the drawn position can neither pass the sim position nor fall more than `MAX_DRAW_LAG_CELLS` = 0.2 behind it. Measured: **329 standing starts per 60 s → 0**, largest per-frame acceleration 3.0× softer, divergence from the sim bounded at 0.132 cells. `packages/game/test/carSmoothing.test.ts` is the coverage. **The deceleration half was proven jointly unsatisfiable** with "never drawn ahead of the sim" and zero steady-state error, and is deliberately left alone; the proof is in `resolve.ts`. What remains deferred is the perpendicular lane offset — the renderer still draws every car on the centreline, so two cars in opposite lanes visually pass through each other (cars 0 and 1 cross at x ≈ 13.25 on row 5 between ticks 71 and 72 of the loop fixture). It is `(-DY[dir], DX[dir])` at about 0.15 cells, and it adds rows of **0.212** and **0.30** cells to `resolve.ts`'s displacement table. **That re-derivation now has an extra term it did not have when this row was first written**: the chase can exceed the sim's own speed by one `DRAW_SPEED_STEP`, so the supremum M1f must re-derive is the offset table *plus* the chase bound, not the offset table alone. |
| **Destination removal, and the square→circle upgrade (§5.2)** | **M1f** | Three source sites name *"M1e's destination removal"* as the trigger that ends an inert property — `state.ts:460` (a hole marker for a slot in the middle of a live prefix), `dispatch.ts:688` (what would make `runDispatch`'s colour order outcome-visible) and `trips.ts:63` (what would make arrival order outcome-visible). **M1e removes no destination and upgrades none**, so all three stay inert and all three comments must be repointed rather than left reading as satisfied. Every destination M1e spawns is a `DEST_KIND_SQUARE`. **This is also the deferral that costs the most in play**, and Decision 2 says why: a circle carries two rotation slots and a trigger cap of 8, so the square→circle upgrade is the only mechanism in the spec that raises one destination's demand without adding a destination. Without it, M1e's demand pressure per destination is flat. |
| **A real in-place restart (`resetState`)** | **M3** | M1e's restart is `location.reload()` behind an injected `deps.reload`, which re-runs the whole boot path and is correct by construction. A *seamless* restart needs an in-place `resetState(state, seed, map)` — `createState` allocates the buffer, and `state` is captured by reference in `createFrameBuilder`, `createFrameDriver` and `createPointerInput`, so returning a new object would leave three consumers on the old one. That is a `sim` API addition with golden implications, and **M3 has to answer the harder half of the same question anyway**: what a saved game-over state means on resume. Named recipient, one file, one function. |
| **Persistence and the compression re-measurement** | **M3** | The state buffer grows **13,828 → 13,992 bytes** here (+1.2 %, against +74.9 % in M1d). The added bytes are three all-zero Int32 regions and four header slots, two of which are initialised non-zero. M3 must **re-measure** against the 4,096-character CloudStorage budget, not extrapolate. |
| **Spawn weights** | **nobody, deliberately** | §5.9's *"ignore spawn weights after 5 consecutive failures"* governs a structure that does not exist: there are no per-zone spawn weights. **Do not add the constant "for later"** — an untested value reads as a supported configuration. When weights land, the constant lands with them. |

---
## Thirteen design decisions

### 1. Ten phases, and the inherited transposition is discharged by insertion rather than by a test that cannot exist

`step.ts` runs seven phases today. Two adjacent transpositions — the clock advance after input application, and inputs after demand — are **0-detector no-ops**, re-measured at the close of M1d over the complete pairwise set C(7,2) = 21, scoring 0 in 4 of 4 rounds against 19–75 for every other pair. They are inert **for exactly one reason: no `TickAction` reads `H_TICK`.** `step.test.ts` carries a tripwire on that *condition* — it reads `step.ts` and `roads.ts` off disk and pins both halves — precisely so the person who ends the condition gets a red test rather than a paragraph.

**The recorded danger is that M1e makes building placement a `TickAction`, at which point both swaps become real off-by-ones in every destination's first-pin delay at once, with nothing to catch either.** This plan does not do that.

**Spawning is a `step` PHASE, not a `TickAction`.** `TickActionKind` stays exactly `'place' | 'erase'`, phase 3 still calls nothing but `placeRoad`/`eraseRoad`, and `roads.ts` still reads neither `H_TICK` nor `H_WEEK`. So the tripwire's condition holds unchanged.

**What discharges the handoff is that the insertion puts a clock READER between the two inert phases, and the first draft of this plan got that backwards.** The new order is:

| # | Phase | The constraint that forces its position |
|---|---|---|
| 1 | `H_EPOCH ← tick`; advance `H_TICK`, `H_WEEK` | Atomicity marker first. The advance must precede every clock reader below. |
| **2** | **Week boundary — grant `WEEKLY_TILE_GRANT` tiles** | Reads `H_TICK`. **Before phase 3**, so an action queued on the boundary tick can spend the tiles it just received. |
| 3 | Apply inputs — the only phase that changes `roads` | Must precede the field sync, or a road drawn on tick T is invisible to this tick's field. |
| **4** | **Spawn — houses, then destinations** | Reads `H_TICK` (via `placeDestination`'s `destSpawnTick` stamp) and `H_WEEK` (colour unlocks). **After phase 3**, because *"nothing ever spawns on an existing road tile"* must see the road the player laid this tick. **Before phase 5**, so a destination placed on tick T is in the rotation's `H_DEST_COUNT` prefix for tick T. |
| 5 | Demand — accumulators, pins, overflow, drops | Mutates `destPins`, which decides the source set, so it precedes the sync. Now reads `H_WEEK` for the ramped period. |
| 6 | Assemble sources, then EXACTLY ONE `syncFields` | Every source-mutating phase is behind it. |
| 7 | Dispatch — the tick's only field reader | — |
| 8 | Movement | After dispatch, so a car dispatched on tick T also moves on tick T. |
| 9 | Arrivals — consume the pin, credit the score, apply the arrival knockback | Mutates `destPins` after the sync, so it must be last of the trip phases. |
| **10** | **Overcrowd — integrate the timer, fire game over** | **After phase 9**, so the meter and the knockback both see the tick's final `destPins`. Nothing after it, so a run that ends this tick ends on a fully-settled state. |

**Which pairs are now live, and the correction that matters.** The old "clock advance ↔ inputs" pair is now **`1↔3`**, and it is **no longer inert** — transposing them yields `inputs, grant, advance`, so `runWeekBoundary` reads the un-advanced tick, misses the boundary at 4,500 and grants a tick late. **Task 2 Step 8's test is its detector and Task 2 Step 9 must PREDICT non-zero for that row.** The first draft predicted it would stay 0-detector and reserved the surprise for whoever ran the measurement; an implementer who measures ≥ 1 against a plan that says 0 will hunt a bug that does not exist, or "fix" the only detector for the thing this milestone claims to discharge.

The old "inputs ↔ demand" pair is now **`3↔5`** and **is predicted to stay 0-detector**, for the same single unchanged reason. That is the row that carries the tripwire's claim.

Two new pairs get real detectors too: **`3↔4`** (inputs ↔ spawn) is not inert — swapping them lets a destination spawn on a cell the player paved this tick, which `canPlaceDestination`'s road check exists to forbid — and **`1↔4`** stamps `destSpawnTick` one tick early. Tasks 2, 5 and 7 write four detectors between them and Task 12 Step 3 runs all 45 pairs.

### 2. Where difficulty comes from, derived — and what the demand ramp can and cannot do

**This decision exists because the first draft of this plan did not have it, and an adversarial review measured that the milestone's stated difficulty curve was invisible while its actual loss mode was something else entirely.** Everything below is arithmetic over constants that already exist, plus measurements named at each figure. It is the frame for Decision 13's gate and for Task 6's and Task 10's observability lines.

**The demand a destination receives does not depend on how many destinations there are.** `advanceAccumulators` adds `slotCount(c)` per tick and fires when the accumulator reaches `period`, so colour `c` fires every `period / slotCount(c)` ticks and each fire lands on one rotation slot. **A square carries one rotation slot and a circle two** — `computeSlotCounts`, `demand.ts:294`: `const slots = destMetaKind(meta) === DEST_KIND_CIRCLE ? 2 : 1`. So **each slot receives one pin per `period` ticks regardless of the colour's size**: a square gets one per 518 at week 0 and one per 172 at week 19; a circle gets two.

**The fleet grows exactly in step with the board.** `HOUSES_PER_DESTINATION` = 2 and `CARS_PER_HOUSE` = 2 give **four cars per destination at every week**. So the fleet-to-demand ratio is a constant and only one term can close it: the round trip.

**Two thresholds follow, and they are what the difficulty curve actually is.**

- **The queue-growth threshold.** A destination's queue only grows if service is slower than arrival: with four cars on a round trip of `T` ticks against one pin per `period`, the queue grows iff **`T > 4 · period`**. Week 0: `T > 2,072` ticks (69 s). Week 19: `T > 688` ticks (23 s).
- **The death threshold, given it is at cap.** Swept and confirmed exactly (Task 7 Step 5): a destination pinned at its **hard** cap survives iff it is served better than once every **90 ticks (3 s)**, because the meter's fixed point is `10,000 · P` and that only exists below the 900,000 point where the 90,000 knockback cap binds. At exactly P = 90 the fixed point coincides with the knee, so the meter **parks at 900,000 — 34 % of the failure threshold — forever**; **91 is the first lethal interval (163,163 ticks) and 95 the first that kills inside 40,000.** A destination sitting at its *trigger* cap rather than its hard cap dips under after each arrival and unwinds at 2,000/tick, which moves the boundary to **P ∈ [541, 870]** depending on how long it spends under. **So the honest boundary is a band from 90 to 870 ticks, not the single number the review found**, and where in that band a destination sits is a function of queue depth.

The binding one is the first. **So the ramp is not decoration: it lowers the round trip a connected destination can survive from about 69 seconds to about 23, a 3× tightening.** Measured directly, on a single house and a single square joined by a boustrophedon corridor with nothing else on the board:

| corridor cells | mean round trip | ramp ON | ramp OFF |
|---|---|---|---|
| 41 | 662 | **dies at tick 43,377 (week 9)** | survives 60,000; peak pins **1**, meter **0** |
| 53 | 870 | **dies at 28,071 (week 6)** | survives; peak pins 1, meter 0 |
| 65 | 1,082 | dies at 18,597 (week 4) | survives; peak pins 6, meter peaks 79,707 |
| 89 | 1,506 | dies at 11,657 (week 2) | — |

**Identical topology, identical everything: the ramp is the entire difference between a city that lives forever and one that dies at week 9.** So *"the demand ramp is decoration"* is true of the shipped board and false as a design claim, and the plan must not assert either half without the other.

**Why it is invisible on the shipped board.** Measured over twelve weeks on `firstCity` with the 20-tile opening, the mean round trip is **55–60 ticks at every week**, against `4 · period` falling from 2,072 to 936. The ratio `meanT / (4 · pinPeriodForWeek(w))` runs **0.029 → 0.059** and **misses the threshold by 12–34×**; even at the week-19 ceiling it is 0.080. Turning the ramp off entirely changes the no-input death tick by **87 ticks out of 8,661 — 2.9 seconds in 289, a 1.0 % difference** — and changes peak `destPins` on connected destinations, longest queue, refusals and blocked ticks by **zero**. What it does change is throughput: 269 pins and 192 trips at week 11 against 122 and 87, a 2.2× on both.

**That ratio is the difficulty curve and Task 10's gate measures it per week.** Under Task 10's lever it reaches 0.156 by week 11 rather than 0.059 — still short of 1, and the gate is therefore written on the *shape* of `destPins` rather than on the ratio crossing a threshold it does not cross.

**Four things that are NOT the difficulty curve, each named so nobody reaches for them:**

- **The overcrowd knockback and unwind.** Measured on both shipped boards: removing the arrival knockback, removing the unwind, or removing both changes the death tick by **zero ticks**. Both boards die of a destination that stops being served *entirely* — the demo board's D2 receives its last arrival at tick 1,549 and its pin count is monotone from there to the hard cap. **No knockback-side lever reaches a starved destination**, and that includes dossier §1.10's `OvercrowdTimerCarArrivalDeceleration` (Decision 4).
- **`HOUSES_PER_DESTINATION`.** The obvious lever, and it is not one. Measured at 1, 2 and 3 on the connected board: **the death tick is 8,661 in all three, connected destinations peak at 1, 1 and 2 pins in all three, their meters are 0 in all three, and the round trips are identical.** The seeded destinations are over-served roughly 16× at the shipped value; halving the fleet leaves 8×. It would need to fall to about 0.25 houses per destination to bind, which is not a configuration. **This is where measuring beat asserting**: the derivation above says the fleet term is what closes the gap, and it is right, and the constant is nowhere near the range where it does.
- **`DESTINATIONS_PER_WEEK`.** It is a schedule, not a delivery rate. Measured over 40 weeks with no input on `firstCity`, it delivers **0.275** destinations a week, and the board tops out at **14**, not the declared `maxDestinations` of 16, with the last placement in **week 10** — after which every attempt returns `BOARD_FULL` forever. **On the board a player actually opens it is worse: 13, saturated at week 8**, because the player's own road removes candidate cells. The cause is geometric, not scheduling: a destination needs seven contiguous free cells at Chebyshev ≥ 2 from every other destination, inside a 308-cell rect that also carries a river column, eight trees, 27 houses and the player's roads.
- **The tile grant.** 30 starting plus 30 a week is ~270 tiles by week 8 against roughly 280 placeable cells in the 308-cell rect. Measured, it is not close: the **entire twelve-week destination-connection bill is 41–57 tiles against 390 granted**, the median connection costs **3 tiles**, and a scripted greedy-connect policy ends with 61–332 unspent across three seeds with **zero unaffordable events in fifteen runs.** Tiles stop binding around week 3 and were never the difficulty.

**What loss actually comes from, and it is neither demand nor tiles: a destination that is never SERVED, which is not the same as never connected.** `advanceAccumulators` round-robins pins **evenly** across a colour's rotation slots, while `assembleSources` seeds the colour's flow field at every carpark with pins and cars flow to the **nearest** one. `dispatch.ts:624-627` already names this — *"Decision 4's stated cost: a house routed by the field to a destination whose every pin is already spoken for … does not reach past its nearest destination."* Measured on a fully-connected greedily-played board at twelve weeks, within one colour: **297 trips to one destination, 10 to another, 0 to a third**, against a 2:1 demand ratio. And §5.9's own rule compounds it — new houses spawn within Chebyshev 2 of an existing same-colour house, so a colour's houses **cluster** and permanently pin which of its destinations is nearest.

**So a destination that spawns far from its colour's houses cannot be saved by any road the player builds.** That is loss-by-omission one level below where the review found it, and it is invisible to every test the first draft had. Decision 13's lever is the cheap half of the fix and M1f owns the rest.

### 3. The demand ramp scales the PERIOD, not the accumulator — which is why week 0 is byte-identical to today

§5.3: `spawnScale(w) = 1.0 + 0.11 · (w − 1)`, capped at 3.0. `H_WEEK` is 0-based, so `w = H_WEEK + 1` and the integer form is `min(3000, 1000 + 110 · H_WEEK)`.

The obvious implementation multiplies the accumulator's increment, `acc[c] += slotCount(c) · scale / 1000`. **That truncates once per tick**, which is precisely the drift `demand.ts`'s `acc -= PIN_PERIOD_TICKS` carry exists to prevent. Scaling in units of `DENOM` instead (`acc += slotCount · scale`, threshold `PIN_PERIOD_TICKS · DENOM`) is exact — and it changes `pinAccum`'s stored bytes by 1000×, moving the loop, queue and multiplier goldens **behaviourally** in a milestone that should move them for nothing.

**So scale the threshold.** `pinPeriodForWeek(week) = (PIN_PERIOD_TICKS · DENOM) / spawnScale(week) | 0`. The accumulator, its increment and its carry are untouched; only the comparison target moves, once per week, and it is truncated once per tick as a comparison rather than accumulated. At `H_WEEK = 0` it is `518000 / 1000 = 518` — **exactly today's constant**, so no golden fixture inside week 0 can move.

| `H_WEEK` | `spawnScale` | period | vs 518 |
|---|---|---|---|
| 0 | 1000 | **518** | 1.00× |
| 1 | 1110 | 466 | 1.11× |
| 5 | 1550 | 334 | 1.55× |
| 18 | 2980 | 173 | 2.99× |
| **19** | **3000 (capped)** | **172** | 3.01× |

The cap first binds at `H_WEEK` = 19, because `1000 + 110·18 = 2980` and `1000 + 110·19 = 3090`.

**The one-fire invariant survives the ramp, and the first draft of this plan weakened it when it should have EXTENDED it.** `demand.ts`'s module comment claims *"at most one threshold crossing — one fire — happens per colour per tick"*, resting on `slotCount ≤ 32 < PIN_PERIOD_TICKS`. The first draft said a period reduction at a week boundary can leave a backlog draining over `floor((maxPreviousPeriod − 1) / minPeriod)` = `floor(517 / 172)` = **3** ticks, and wrote a test asserting `≤ 3`. That derivation pairs week 0's period with week 19's, and **`H_WEEK` cannot cross 19 boundaries in one tick.** The real bound is over *adjacent* weeks:

- The largest adjacent period drop is week 0 → 1: `518 − 466 = 52`. Every later drop is smaller (1 → 2 is `466 − 424 = 42`, and it shrinks monotonically).
- On the boundary tick, `acc ≤ P_w − 1` carried in, plus `slotCount ≤ 32`, so `acc ≤ 549`. One fire leaves `acc ≤ 549 − 466 = 83`, which is far under 466.

**So the bound is exactly ONE fire on a boundary tick — the same bound as every other tick — and there is no backlog to drain at all.** The module comment gets the boundary argument added to it, not a weaker claim substituted for it. And the honest consequence: **the `while`-drain mutant this bound is supposed to guard against is an EQUIVALENT MUTANT**, because a `while` loop that can never iterate twice is a `for` loop. Record it as equivalent with the derivation beside it rather than writing `toBeLessThanOrEqual(3)`, which every implementation satisfies including the mutant. Task 6's test asserts `toBe(1)` on the boundary tick and `toBe(0)` on the three after it, which is a sharp detector for `acc = 0` (loses the residue and delays the next fire) and for hoisting the period out of the per-tick call.

### 4. The overcrowd meter is integrated in MILLI-TICKS, the spec's ~113 s is an exact integer, and the EIGHTH constant is named, measured and deferred

A tick is 1000/30 ms, which is not an integer, so a millisecond-denominated meter cannot be exact. Denominate it in **ticks scaled by `DENOM`** — milli-ticks — and every spec constant converts once, in `constants.ts`.

Two per-destination quantities, because the ramp is a function of elapsed time over capacity while the meter is reduced by arrivals and by the unwind:

- **`destOverTicks[d]`** — consecutive ticks at or over the timer capacity. Resets to 0 the moment the destination is back under. **Saturates** at `OVERCROWD_RAMP_FULL_TICKS`, exactly as `carBlockedTicks` saturates at `MAX_BLOCKED_TICKS`, so no width question can arise at any run length.
- **`destOvercrowd[d]`** — the integrated meter, in milli-ticks. Only this one decides failure.

Spec §5.8: speed `s(t) = min(1, 0.02·t)` with `t` in seconds, max overcrowd time 90, hidden grace 2 s. So:

- `s` reaches full at `t = 1/0.02 = 50` s → `OVERCROWD_RAMP_FULL_TICKS = (DENOM / OVERCROWD_RAMP) · TICKS_PER_SECOND` = **1,500**.
- Failure fires when the meter reaches `90 − 2 = 88` s → `OVERCROWD_FAIL_MILLITICKS = OVERCROWD_FULL_MILLITICKS − OVERCROWD_GRACE_MILLITICKS` = 2,700,000 − 60,000 = **2,640,000**. The *displayed* ring is the meter against `OVERCROWD_FULL_MILLITICKS` (2,700,000), which is what makes the grace **hidden**: the ring shows 97.8 % at the instant the city dies.
- Per-tick increment is `min(DENOM, (OVERCROWD_RAMP · destOverTicks) / TICKS_PER_SECOND | 0)` = `min(1000, floor(2·overTicks/3))`.

**The ramp phase sums to exactly 750,000 milli-ticks, and this is hand-derivable rather than measured.** Writing `t = 3k + r`, `floor(2t/3)` over each consecutive triple is `2k + (2k+1) + (2k+2) = 6k + 3`; `t` from 1 to 1,500 is 500 triples with `k = 0…499`, so the sum is `6·(499·500/2) + 3·500 = 748,500 + 1,500 = 750,000`. The remaining `2,640,000 − 750,000 = 1,890,000` accrues at 1,000/tick over **1,890** ticks. **Total: 1,500 + 1,890 = 3,390 ticks = 113.0 s exactly**, which is the spec's own "~113 s" landing on the nose. `3,389` must not fire and `3,390` must — the sharpest off-by-one detector this milestone has.

Two more rules:

- **Unwind**, once back under capacity: the meter falls by `OVERCROWD_RETURN_MUL` (2,000) milli-ticks per tick — 2× the full fill rate of 1,000 — floored at 0.
- **Arrival knockback**: on every car arrival at destination `d`, `min(meter · ARRIVAL_KNOCKBACK_PCT / DENOM, ARRIVAL_KNOCKBACK_MAX_MILLITICKS)`, i.e. 10 % of current capped at 3 s (90,000 milli-ticks). The spec's lower clamp of 0 s is satisfied by construction because the meter is never negative. **Note where the cap actually binds, because the first draft mislabelled it:** `ARRIVAL_KNOCKBACK_PCT` is 100 over `DENOM` 1000, so `arrivalKnockback(900000)` is exactly 90,000 and `>` and `>=` return the same value there. 900,000 is therefore a **0-detector probe** for the cap. The boundary must be tested at 910,000 (capped 90,000, uncapped 91,000) against 899,990 (89,999 either way).

**The eighth constant: named, measured, and deferred to M1f with the measurement.** The dossier's §1.10 table lists **eight** constants and spec §5.8 transcribes **five**; `OvercrowdTimerCarArrivalDeceleration = 0.5` was dropped by the spec, not by a decision anyone made. Its semantics are inferred — the dossier gives a name and a value and nothing else — and the inference is that an arrival decelerates the timer's **ramp** as well as knocking back the meter, i.e. `destOverTicks[d] = destOverTicks[d] · 500 / DENOM | 0`.

**Measured, both with and without, by sweeping the arrival interval to a 2,000,000-tick horizon:**

| | largest surviving arrival interval | first lethal | first lethal inside 40,000 ticks |
|---|---|---|---|
| as shipped | **P = 90** (the meter's PEAK parks on 900,000; the trough is 811,000) | 91, at tick **163,162** [corrected at Task 7: this table said 163,163, contradicting Task 7's own Step 5 comment two sections down, which is right] | 95 |
| with the deceleration | **P = 300** | 301, at tick 1,325,302 | 328 |

A 3.33× widening, and it is exactly the widening the algebra predicts. It would turn "you are fine or you are dead" into "you fell behind and you can climb back", which is what §5.8's unwind and knockback are evidently for.

**And it is deferred anyway, because it is measured to be a no-op on every board that exists.** The demo board's dying destination receives **six arrivals in 6,703 ticks and none at all after tick 1,549**; `firstCity`'s receives **zero, ever**, because with no roads `applyArrivalKnockback` has no call site. Both die at an arrival interval of infinity, which is past both boundaries by an unbounded margin — and measured directly, the death tick is **unchanged to the tick** with the deceleration added. It is a lever on the *recoverable* failure mode and neither shipped board is in it.

So implementing it here would add a constant, a code path and a test for behaviour no player and no board can distinguish — which is the catalogue's *"do not add a constant for later; an untested value reads as a supported configuration"* with a test attached, which is not much better. **M1f is the named recipient, alongside the square→circle upgrade, because those two together are what a graded failure model needs and neither is worth having alone.** Task 12 Step 9 carries the measurement, not just the name.

**What M1e ships instead of a middle is a measurement of where the middle is**: Task 7 Step 5 sweeps the arrival interval and pins the boundary at 90, with vacuity on both sides. Decision 2 records that a destination at its *trigger* cap rather than its *hard* cap sits at a boundary of 541–870 instead, so the middle is wider than the single number suggests — and Task 10's lever produces one on the board that ships.

**The meter reads `destPins`, not `destPins − destReserved`, and that is the spec speaking:** §5.8, *"There is no carpark immunity — a car metres from the bay does not save you."* A reserved pin is still a customer waiting.

`destOvercrowd` and `destOverTicks` are `Int32Array`, so the `Uint8` wrap class does not apply — but **both decrement paths are still clamped at 0 with a named assertion**, because a negative meter is a silent lie about how close the player is to losing.

### 5. Game over freezes the sim from `step`'s first line, is TERMINAL, and has exactly one way out

§5.8: *"If any single destination's timer completes, the city shuts down immediately. No lives, no partial failure, no win condition."*

Two header slots: `H_GAME_OVER` (0 alive, 1 over) and `H_FAILED_DEST` (the destination index, meaningful only when `H_GAME_OVER` is 1). **Two plain flags rather than one packed `failedDest + 1`**, because zero-initialisation must mean "alive" without `createState` writing a sentinel, and a packed encoding reads badly at every call site. Both are reached through `isGameOver(s)` and `failedDestination(s)`, and the second returns `-1` unless the first is true, so no caller can read a stale index.

**`step` returns immediately when `H_GAME_OVER` is set — after the poison check, before `H_EPOCH` is written.** Every subsequent tick is then a byte-identical no-op, which is what the leaderboard needs: a Worker replaying an input log that runs past the failure computes the same score as the browser that produced it, whatever the log's length. `H_TICK` stops advancing, so the HUD clock visibly freezes.

The frame loop stops too, but **as a follower, not as the authority**: `createFrameDriver` calls a **required** `onGameOver` callback the first time `isGameOver(state)` becomes true, and `main.ts` pauses the loop from it. Required, not optional — an optional dependency is how M2's erase control shipped a compiling `createEraseControl({ host })` that left the player with no way to erase.

**And pausing the loop is not enough, which the first draft of this plan missed entirely.** `pointer.ts:385` runs `host.setPaused(!host.paused())` on a clock tap **unconditionally**, `main.ts` forwards it to `loop.setPaused`, and `loop.ts` sets `resetClock` on resume. So after `onGameOver: () => loop.setPaused(true)`, one tap on the clock:

- resumes rAF at 30 Hz on a dead sim — `snapshotPrev`/`snapshotCurr`, the 960-cell terrain fold and `drawFrame` all run at full rate;
- flips `frame.paused` false, so the pause bars vanish while the scrim stays;
- **re-opens `HitRegion.GRID`** — which is refused *while paused* (`REFUSED_PAUSED`) and nothing else — so the player draws roads that never appear, spend no tiles, and produce no message;
- and `advance` guards on `!wasOver`, so `onGameOver` never re-fires and nothing re-pauses.

**So game over is made terminal at the input boundary, not at the loop.** `PointerHost` gains `gameOver: () => boolean`, and `down()` gains **one early return above the HUD test**:

```ts
    if (host.gameOver()) {
      host.restart()
      return PointerOutcome.RESTART_REQUESTED
    }
```

One branch, one mutation target, and it cannot be half-applied: the clock toggle and the grid drag both become unreachable while it holds, by construction rather than by two separate guards that could disagree.

**A terminal state obliges a recovery path, and the guard that protects it is usually the thing blocking recovery** — the catalogue's own rule, learned from the pointer latch that could only be cleared by reloading the app. Making game over terminal *removes* the accidental escape hatch (unpause) and would leave the player with nothing at all, which is strictly worse than today. So the recovery ships in the same task as the guard.

**The recovery is `location.reload()`, injected as `deps.restart`, and that choice is deliberate rather than lazy.** A seamless in-place restart needs a `resetState(state, seed, map)` in `sim`, because `createState` allocates the buffer and `state` is captured by reference in `createFrameBuilder`, `createFrameDriver` and `createPointerInput` — a new object would leave three consumers holding the old one. A reload re-runs `startGame` from the top, which is the one path in this codebase that is known to produce a correct boot, preserves `location.hash` (so `?startapp=demo` survives), and costs one warm start. It is injected rather than called directly so it has a Node-side detector; `main.ts` passes `() => { location.reload() }`, which is the same irreducible-DOM-call shape `createFallbackButton` already has. The in-place version is deferred to **M3** with a named recipient, because M3's resume path has to decide what a saved game-over state means anyway.

**One accepted cost, stated rather than discovered:** any tap restarts, so a player who taps immediately loses the score line before reading it. A dedicated "play again" rect with its own hit test is the alternative and it costs a `hudRects`-shaped geometry addition; it is not worth it in M1e, and M1f owns it if the device session says otherwise.

### 6. The spawn zone is the revealed rect, clipped to the board, and it may legally be empty

Nothing may spawn where the player cannot see it. `sim` therefore reads `REVEALED_X0/Y0/W/H` from `@laneways/shared` — permitted (`sim` depends on `shared`), and it makes `constants.ts`'s claim that *"nothing in `sim` reads these"* false, so that comment moves in the same commit.

**The rect must be clipped to the world**, because `sim`'s test fixtures are small: `determinism.test.ts`'s golden map is 4×4 and `loop.test.ts`'s is 20×12, against a rect of `x ∈ [5, 19)`, `y ∈ [9, 31)`. On the 4×4 the clipped zone is **empty**; on the 20×12 it is 14×3. So every zone consumer takes a possibly-zero cell count and **`spawnScanStart` guards against `% 0` before it is ever evaluated** — an unguarded modulo by zero yields `NaN`, and a `NaN` index into a typed array is a silent no-op, which is the quietest possible failure.

**Candidate scanning is bounded at `SPAWN_CANDIDATE_LIMIT` = 24 cells per attempt.** Unbounded scanning is up to 308 cells × 4 orientations × `canPlaceDestination`, which is a spike inside one tick on a phone.

**The scan start is `((rng[0] >>> 0) + H_TICK) % zoneCells`, reading the RNG word without advancing it.** Three properties, all wanted: it varies by seed (so `RUN_SEED` means something), it varies by tick (so the board does not fill from the top-left corner), and it **consumes no draws** — a spawner that advanced the RNG on every failed attempt would couple every downstream draw to how many times a spawn failed, which is deterministic and brutally fragile for hand-computed fixtures.

**A destination spawn costs a full multi-colour flow-field rebuild, and that is priced here rather than discovered in Task 5.** `FIELD_INPUT_REGIONS` (`regions.ts:121`) is `['mapIdentity', 'destCell', 'roads', 'destMeta', 'destPins']` — `destCell` **and** `destMeta` are both in it, `placeDestination` writes both, and `flowfield.ts:399` computes **one global** `fieldInputHash` and compares it against every colour's `builtFromFieldInputs`. So placing one destination invalidates **every** colour's field, not just its own, and `CT_REBUILDS` rises by exactly `groupCount` on the spawn tick. That is not a bug: the staleness stamp is a deliberately conservative byte hash over whole regions, not a semantic source-set question, and making it per-colour would mean `groupCount` hashes per tick against one.

The cost is accepted in writing: on `firstCity`, `groupCount` = 5 rebuilds on roughly two ticks a week, against a measured 21.5–31.5 µs per field on a 1,500-cell grid (§5.4) — well under a frame at 30 Hz, and far smaller than the 96 `canPlaceDestination` calls that `SPAWN_CANDIDATE_LIMIT` exists to bound. **A colour with no pinned destination pays a `cells`-wide fill rather than a search**, so the five rebuilds are not five searches. Task 12 Step 4 counts rebuilds on spawn ticks as one of its per-branch counters, so the figure is measured rather than assumed.

### 7. What the demo board is after M1e: it dies at 3 minutes 43 seconds, and that is the milestone working

**The first draft of this plan said, at five sites, that the demo board was "inert under all of this, by construction and not by luck… That is asserted, not assumed" and that "the demo board is unaffected." Every one of those sentences is false.** Three independent integrations of this plan's own arithmetic, and then a fourth on the shipped boot path, agree:

| | |
|---|---|
| Dies at tick | **6,703** — **3 min 43 s** at 30 Hz |
| Destination | **D2**, `DEMO_DESTINATIONS[2]`, grid (16,9), `ORIENTATION_W`, colour 2 |
| Kind | **circle** — 2 rotation slots, trigger cap 8, hard cap 14 |
| Arrivals it received | **6**, against a median of **24** across the eighteen |
| Its last arrival | tick **1,549** — after which its pin count is monotone to the hard cap |
| Consecutive at-or-over-cap ticks | **3,390** unbroken (from 3,314). Next highest is **272** (D5); the other sixteen are **0** |
| With the knockback removed / the unwind removed / both | **6,703, unchanged, all three** |

**It dies of starvation, not of a losing race**, and that distinction is the reason for the decision below. Cars route to the *nearest* unfilled pin of their colour (§5.4), D2 sits at the far end of corridor C, and once the nearer colour-2 destinations are generating pins it never wins a dispatch again.

The review offered three ways out: accept it, retune the demo layout, or exempt the demo map behind a flag. **Accept it — and stop calling it inertness, because reframing it is most of the value.**

- The demo board is a **deliberately overloaded city**, authored to make M1d's blocking visible: 24 cars, 18 destinations, a car refused entry on 53 % of ticks. M1e's headline is *"a badly-run city kills the run."* A milestone that adds that and then exempts the one board built to be badly run has exempted its own demonstration. After this milestone the demo board demonstrates **two** milestones instead of one, unprompted, in under four minutes.
- **Retuning is the option that costs the most and buys the least.** It means re-authoring the layout so no destination sits above its cap for 3,390 consecutive ticks, which moves the demo seed golden `1039862014`, invalidates every measured figure in `demoLayout.test.ts`, and ends with a demo board that no longer shows the thing this milestone added.
- **A map flag is the worst of the three** and the review said so: it makes the demo board stop demonstrating the milestone, and it adds a per-map exemption to `sim` that nothing else needs.

**Four consequences, all of which are steps somewhere in this plan rather than paragraphs here:**

1. **Every demo-board window is capped below 6,703 with its end tick and its margin stated at the site, and asserts `isGameOver(state) === false` after its final drive.** This is not belt-and-braces. `demoAllocation.test.ts`'s final profiling window ends at tick **6,459** — a margin of **244 ticks, 3.6 %** — and **every vacuity guard it has passes on a frozen board**: measured by freezing the sim and re-running them, `layoutId`, `carPhase.length` 24, `inFlight` 21, `frame.carCount` 24, `frame.destCount` 18, `roadCells` 71 and non-zero blit and fill counts all still pass, and the draw counters keep rising because `loop.frame` renders whether or not a tick drained. `demoLayout.test.ts`'s only measured window is 3,000 ticks from tick 0, which has 55 % margin. Task 8 Step 6 writes the guards.
2. **Task 7 Step 9 measures the death tick on the shipped boot path and records it**, rather than this plan being the carrier. Everything downstream reads that number.
3. **Task 12's device session plans around it** and deliberately exercises the restart, because a demo board that ends is a demo board a person has to be able to start again.
4. **`demoLayout.ts`'s playtester headlines gain the shutdown**, because those headlines are what a person is told to look for and one of them being silently wrong has already happened once in this file.

**Two things recorded so a future tuner does not rediscover them the hard way.** No overcrowd-side constant reaches this board: `ARRIVAL_KNOCKBACK_PCT` at 100 %, `ARRIVAL_KNOCKBACK_MAX_MS` at 10⁹ and `OVERCROWD_RETURN_MUL` at 10⁹ all still die at 6,703. And if the demo board is ever wanted to survive 20,000 ticks, the smallest single-constant change measured is **`PIN_PERIOD_TICKS` 518 → 573 (+10.6 %)** — which is a change to the whole game, not to this board — or `OVERCROWD_RAMP` 20 → 3 among the overcrowd constants proper. Note that the `PIN_PERIOD_TICKS` sweep is **non-monotone** (569 dies at 8,155, 571 at 6,459, 572 at 12,136, 573 and 574 survive), so 573 is "the smallest surviving value found at this seed", not a proven infimum. **Do not quote it as one.**

**One thing the first draft got wrong in the other direction, and it is not cosmetic:** the demo board's *house* spawner is a genuine no-op — it short-circuits on `H_HOUSE_COUNT >= maxHouses` — but its **destination spawner is not.** The board is at 18/18 with zero legal placements in its zone, so every attempt returns `BOARD_FULL` and pushes a pin through §5.3.5. Task 5 Step 10 asserts exactly that, against a spawner-free control, over a window with a stated margin — replacing a test that asserted `H_HOUSE_COUNT` and `H_DEST_COUNT`, the only two quantities on that board that cannot move.

---
### 8. Houses follow destinations, a colour is founded before it is served, and §5.3.5 fires on a board-wide refusal only

§5.9 gives geometry and minimum intervals but no rate. The rate is authored here, and marked [OURS]:

- **Destinations: `DESTINATIONS_PER_WEEK` = 2**, so `DEST_SPAWN_PERIOD_TICKS = TICKS_PER_WEEK / DESTINATIONS_PER_WEEK` = 2,250 ticks (75 s). A failed attempt retries after `DEST_SPAWN_RETRY_TICKS` = 600 (§5.9's 20 s), which comfortably clears §5.9's 10 s minimum between destination spawns. **It is a schedule and not a delivery rate — measured, it delivers 0.275 a week; see Decision 2.**
- **Houses: one attempt per colour per `HOUSE_SPAWN_PERIOD_TICKS` = 300** (§5.9's 10 s between same-group house spawns), retrying after `HOUSE_SPAWN_RETRY_TICKS` = 60 (§5.9's 2 s cooldown on a failed house spawn).
- **`HOUSES_PER_DESTINATION` = 2** caps a colour's houses at twice its destinations, so house growth is driven by destination growth rather than by the clock. Without it, `maxHouses` = 40 on `firstCity` would fill in about 80 seconds. **It is not a difficulty lever — measured at 1, 2 and 3 the death tick and every connected destination's peak are identical (Decision 2).**

**The founding exception, and it is load-bearing.** §5.9 says future houses spawn within ~2 tiles of an existing same-colour house — which cannot place the *first* one, and the cap `houses ≥ dests · 2` refuses a colour with zero destinations. Together those two rules deadlock every colour that starts empty: no house, so no destination; no destination, so no house. `firstCity` seeds colours 0 and 1 and declares `groupCount` 5, so colours 2, 3 and 4 are exactly that case. **So a colour's first house is exempt from both rules and may be placed anywhere legal in the zone**, and a destination spawns only for a colour that already has a house.

**A colour is unlocked once the board already holds one of its buildings OR `H_WEEK` reaches its index** [OURS] — `houseCountOfColour(c) > 0 || destCountOfColour(c) > 0 || week >= colour`. **The first draft's RED and GREEN contradicted each other on this**: its table asserted `colourUnlocked(1, 0) === true` "because firstCity seeds colours 0 and 1", and its implementation was `return week >= colour`, which is `0 >= 1` = false. `firstCity` really does seed a colour-1 house and a colour-1 destination at tick 0 (`startingCity.ts:140`, `:154`), so a pure clock rule says colour 1 does not exist for the first two and a half minutes of a run in which the player can already see it and drive cars to it. **And the one-character repair is worse than the bug**: `week + 1 >= colour` unlocks colours 2, 3 and 4 a full week early and shifts every measurement in Task 10, with nothing to catch it. Reading the board is what makes the rule correct for any future map rather than for this one. Both clauses get their own mutation row and the seeded one must be killed by a test naming **colour 1 at week 0**.

**§5.3.5's blocked-spawn redistribution fires on a board-wide refusal and nothing else, and getting that wrong three ways is what the first draft did.** The spec sentence is *"when no new destination can be placed **anywhere**, that **scheduled** demand is pushed into existing destinations instead."*

1. **A bounded scan missing is not "anywhere".** `SPAWN_CANDIDATE_LIMIT` = 24 over a 308-cell zone means most failures are window misses, not board-wide refusals. The refusal reason therefore goes in the **return type** — `SpawnOutcome`, with `SCAN_EXHAUSTED` and `BOARD_FULL` as distinct codes — which is the house pattern this project already adopted for `PointerOutcome` and for `canPlaceRoad`: *if a function has more than two ways to decline, the reason belongs in the signature.* Only `BOARD_FULL` pushes.
2. **The cadence must be the schedule's, not the retry's.** A failed attempt resets the timer to 600 ticks, so pushing on every attempt fires 7.5 times a week against a `DESTINATIONS_PER_WEEK` of 2 — a **~275 % surcharge** on the pushed colour. The fix is one line and needs no second accumulator: **a `BOARD_FULL` result resets the timer to `DEST_SPAWN_PERIOD_TICKS`, not to `DEST_SPAWN_RETRY_TICKS`.** §5.9's 20 s retry means "this attempt missed, try again soon"; a board at `maxDestinations` will not become un-full in twenty seconds.
3. **The colour cursor must advance on failure.** The first draft wrote `H_SPAWN_COLOUR_CURSOR` inside `if (placeDestination(...))`, so once a board saturates there is never another success and the selection loop returns the same colour forever. Measured over 40 weeks on `firstCity` with the 20-tile opening: **232 of 259 pushes — 89.6 % — land on colour 4**, the colour the cursor froze on after the last success. With the cursor advancing on failure they spread 53/49/52/53/52.

**And the frozen cursor has a second consequence that is worse than the surcharge, because it is silent.** On that same run colour 4 ends with a house and **no destination**, so `pushBlockedSpawnDemand`'s `hasEligibleDestinationOfColour` guard discards every one of its 232 pushes: **§5.3.5 delivers literally nothing from week 12 to the end of the run**, and no counter, test or assertion says so. The frozen cursor selects precisely the colour whose pushes the guard swallows. Task 5 therefore adds `CT_BLOCKED_PUSH_DISCARDED` to `scratch.counters` beside `CT_SYNCS` and `CT_REBUILDS` — scratch, so no golden can see it — and Task 12's per-branch counters assert it. **A redistribution rule that silently delivers zero for twenty-eight weeks is exactly the defect class this plan is otherwise careful about**, and the magnitude is small either way (8 pushes a week against 250–262 pins, **3.1 %**), which is what makes it the kind of thing that survives a milestone.

**Finally, `fireColour` advances `rotationCursor[colour]` (`demand.ts:247`), so a pushed pin perturbs the SCHEDULE as well as the count** — it permanently changes which destination of that colour is next in line. That is correct behaviour (a pushed pin is a pin and should take its turn), and it is written down because the first draft asserted that a saturated board was inert under this function and the count is only one of the two things it moves.

---
### 9. Timers count DOWN, are initialised in `createState`, and the shape task's re-bless is therefore PURE LAYOUT

A countdown timer that fires at zero and resets to a period is the plainest form, but it needs a non-zero initial value or every spawner fires on tick 1. `createState` writes them, exactly as it already writes `H_TILES` from `map.startingTiles` and fills `occupancy` with `FREE`:

```ts
s.header[H_DEST_SPAWN_TIMER] = DEST_SPAWN_PERIOD_TICKS
s.houseSpawnTimer.fill(HOUSE_SPAWN_PERIOD_TICKS)
```

The first draft called Task 1's re-bless *"layout plus two named initial writes"* and proposed proving it by splicing the inserted bytes out **and zeroing** the two slots. Both halves were wrong, and the correction makes the proof strictly stronger:

- **Zeroing is not removal.** `hashBytes` is FNV-1a: `h ^= b; h = imul(h, prime)`. With `b = 0` the step is `h = imul(h, prime)`, **not the identity**. A zeroed byte still multiplies. The proof would have failed on all seven fixtures even for a completely benign change, and the implementer's only remaining option would have been to hand-bless seven goldens with no proof at all.
- **No slot needs zeroing anyway.** `H_DEST_SPAWN_TIMER` is one of the four new header slots and `houseSpawnTimer` is one of the three new regions, so **both initialised values land inside the bytes the splice removes.** There is no behavioural term.

So Task 1's re-bless is **pure layout**, provable by removing exactly two byte ranges and reproducing each prior digest bit-for-bit. Both ranges are **mid-buffer**, which is the other thing the first draft got wrong: `header` is the *third* region in the 4-byte tier (`rng`, `mapIdentity`, `header`, …), so growing it inserts 16 bytes before everything after it; and `computeLayout` emits the 4-byte tier, then the 2-byte tier, then the 1-byte tier, so 148 bytes appended to the end of the 4-byte tier sit in front of `carRouteLen`. Neither insertion is an append and the splice must handle both.

A re-bless whose proof is "the shape changed" absorbs any behavioural regression that lands in the same commit. A re-bless whose proof is an exact byte splice absorbs nothing.

### 10. Placement validity stops allocating — TWICE, and the second one is the one that was missed

`canPlaceDestination` calls `allSevenCells`, which returns a fresh `number[]` — once for the candidate and once **per existing destination**. Its own doc comment says *"never call this from a per-tick path"*, and Task 5 puts it on one at up to `SPAWN_CANDIDATE_LIMIT × ORIENTATION_COUNT` = 96 calls per attempt.

**The fix is to stop materialising the cells, not to thread a scratch buffer through `Layout.seed`.** Two changes, both in `buildings.ts`:

- The bounds/terrain/tree/road checks become a `dy`/`dx` double loop over the footprint box plus the carpark cell. Identical checks, identical order, no array.
- The spacing check becomes **box arithmetic**. The minimum Chebyshev distance between two axis-aligned boxes is `max(gapX, gapY)` with `gapX = max(0, B.x0 − A.x1, A.x0 − B.x1)` and likewise for `y`; a carpark is a 1×1 box. Four box-pairs per existing destination replace 49 cell-pairs.

The second is an **algorithm rewrite of a heavily-tested predicate**, so it carries a migration proof: the retired pairwise implementation is transcribed once into the test file as a reference and compared exhaustively over every `(destCell, orientation)` pair on a small grid against every stored incumbent. That is deliberately a one-off equivalence proof and **not** the coverage — the existing `canPlaceDestination` tests stay exactly as they are and remain the coverage, because a test that reimplements the thing it checks is a listed defect.

**And there is a third allocation the first draft did not name: the return value.** `return { ok: false, reason: 'terrain' }` is a fresh object literal, and `canPlaceDestination` is far too large for V8 to inline, so it **escapes and is really allocated**. Removing the arrays leaves it. **The in-repo precedent is exact:** `canPlaceRoad`'s identical literal measured 40.6–44.3 B per call, carried a `'roads.ts': 128` known-violation budget, and was fixed in M1d with module-scope frozen singletons (`roads.ts:303-319`, plus the `ACCEPT_BY_COST` table and `assertPlaceCost` as its fail-closed index guard). Task 4 copies that for **both** `canPlaceDestination` and `canPlaceHouse`.

`canPlaceHouse` is included on purpose. Two reviewers measured it and disagreed — one found it dominant on the demo board at 667 calls per 6,000 ticks, the other found it scalar-replaced to 0.25 B/call *through `placeHouse`*. They were measuring different call shapes and both were right about their own; Task 5 introduces a third, `attemptHouseSpawn`'s direct loop, which neither measured. Six lines settle it. **No existing test compares a `PlaceCheck` by identity**, so this change has `demoAllocation.test.ts` as its only detector — which is why Task 4 carries a mutation row that says exactly that.

### 11. Routing stays congestion-blind, and that is a spec requirement rather than a deferral

`flowfield.ts` contains zero references to `occupancy`, `carBlockedTicks` or blocking of any kind, so a jam does not repel traffic — it attracts it. M1d handed that here as an open disagreement. **The decision is that M1e does not fix it, because there is nothing to fix.** Spec §1: *"path cost contains no congestion term… This omission is deliberate and load-bearing; it is the game."* Decision row 5, *"cars path once at departure, never re-route"*; decision row 6, *"no congestion term in path cost"*. The player is the only rerouting mechanism.

**What M1e owes is a detector, because the property is currently unprotected on the boards that matter.** The field golden `252514232` runs on `rollback.test.ts`'s fixture, which **has no cars**, so an occupancy-dependent edge cost would leave it green. So Task 11 adds a property test on a board mid-jam: snapshot `dist`/`dir` for every colour, arbitrarily rewrite `occupancy` and `carBlockedTicks`, re-run `syncFields`, and assert **byte-identical fields and an unmoved `CT_REBUILDS`**. That kills both an occupancy term in the cost and a FIELD_INPUT misclassification, on a real board, with no source scan.

**And the trap is recorded rather than sprung.** `scratch.ts:43-49`: `NB = DIAG_COST + 1 = 15` is the **exact** minimum with zero slack — an earlier comment read the spread as 4 and instrumenting 200 seeded random graphs measured the true maximum at 14, the full interval, a 3.5× overestimate of headroom that does not exist. `assertBucketCountExceedsEveryEdgeCost` inspects only `edgeCost(k)`, so **a penalty applied inside `computeFlowField` rather than through the cost function keeps the assert passing while the Dial queue aliases two distances into one bucket: wrong paths, no crash**, in the component whose golden is a tripwire. A *per-cell* penalty additionally makes cost depend on more than direction, so `edgeCost(dir)` and everything derived from it goes structurally blind — the signature has to change, not just the value. M1d's intersection penalty set no precedent here: it is a `laneSpeedMul` applied at movement time and left `NB` untouched. **The first thing that will actually change the value set is M1f's motorway ÷3 tier**, and Task 11 repoints the comment there.

### 12. `Uint8Array` decrements: M1e adds none, and that is verified rather than assumed

An unguarded `--` at 0 on a `Uint8Array` wraps to 255, and where the slot gates eligibility it excludes something **forever**, silently, surviving snapshot/restore and replaying identically in the Worker. The complete set of `Uint8Array` decrement paths in `packages/sim/src` at the start of this milestone is **three**: `destPins` and `destReserved` in `trips.ts` (guarded by `assertArrivalHonoured`) and `ghostCommitted` in `roads.ts` (guarded by `assertGhostCommittedPositive`).

M1e's new writers are: overcrowd (writes `destOvercrowd`/`destOverTicks`, both `Int32`), the week grant (increments `H_TILES`, `Int32`), spawning (appends to `destCell`/`destMeta`/`houseCell`/`houseColour` and increments counts — no decrement), and blocked-spawn redistribution (**increments** `destPins`). **So M1e adds no fourth `Uint8Array` decrement path.**

That is verified the way M1d verified it, and the method matters: **enumerate every write to every `Uint8` region rather than grepping for `--`**, because the one path M1d actually added spells it `const left = committed - 1` across two statements and no `--`-shaped pattern matches it. Task 12 does the enumeration and records the set.

---
### 13. The default board flips back to the starting city — LAST, in its own task, behind a gate that could not exist earlier

The demo board became the default because the starting city was **inert**: instrumented over 200,000 ticks on the exact production boot it produced `REFUSED_OCCUPIED` 0, `ENTER_VALVE` 0, a maximum of one car in flight and 1,510 dropped pins — three houses feeding four rotation slots at one pin per 129.5 ticks against a ~60-tick round trip, with no shipped control that could add a car. A player opening it saw six cars that never moved.

**M1e is the shipped control that adds cars, and the first draft stopped there.** It put the flip in Task 5 and wrote *"Every clause of that paragraph stops being true."* Three of the four clauses do. **`refusals` does not**, and measured on the flipped board with the plan's own 20-tile opening it is **0 for the whole twelve-week run** — one of the four numbers that demoted this board, unchanged after the milestone. Shipping the mirror-image overclaim of the sentence being replaced is not an improvement on it.

**So the flip moves to Task 10, after game over exists, and it is gated.** The reason is structural rather than cautious: the only question worth asking about this flip is *"is the board playable and losable"*, and that question is about a meter that does not exist until Task 7 and a run length that does not exist until Task 8. A gate written in Task 5 can only ask machine-side questions — "does it reach four colours", "does it place anything" — and **those are precisely the criteria M1d passed while shipping a milestone nobody could see.** Measured against the first draft's own build: colours founded at weeks 2/3/4, 22 houses, 11 destinations, 0 out-of-rect. Neither clause of its gate could fire.

Three things make the flip safe, and each is checkable before it lands:

- **The opening is solvable, and cheaply, and this was verified rather than reasoned.** `firstCity` grants 30 starting tiles. Column 8 rows 10–24 (15 cells) reaches D0's carpark at (8,10), house 1 at (8,13), D1's carpark at (8,18) and house 0 at (8,24); column 17 rows 14–18 (5 cells) reaches D2's carpark at (17,14) and house 2 at (17,18). **Driven as 18 `place` actions, all accepted, costing exactly 20 tiles, with all three seeded destinations road-connected from tick 1.** The entire seeded city is connectable for 20 of 30.
- **The board is not cut in half.** The river runs down `x = 12` for the whole revealed rect except **rows 18 and 19, which are land** — `firstCity.ts`'s own comment calls it *"a river with a bridgeable two-cell gap"*. Cross-river traffic funnels through two cells, which is a choke point rather than a wall, and bridges stay deferred without stranding anything.
- **The demo board keeps everything and stays one token away.** `?layout=demo` in a browser, `?startapp=demo` inside Telegram; its own map, seeder, RNG seed, warm start and golden `1039862014`. **It is not unaffected** — Decision 7 — but nothing about it changes here.

**And the flip carries a lever, chosen by measurement over the one the review recommended.** Task 10's gate found that tiles run 6–8× slack and that the road-proximity bias makes the board *worse*; the change that ships instead biases the destination scan toward the **spawning colour's own houses**, which is measured to turn peak `destPins` on connected destinations from a step into a gradient. Task 10 states all of it in advance, measures both arms in the same run, and ships the baseline if the lever fails its own gate.

**One thing the flip does not fix, stated here so it is not discovered on a phone.** For the first eight weeks — twenty minutes — the only way to lose this board is to leave a destination unconnected, and a competent player will not. The board is easy for twenty minutes and then it is not. Task 12's device session asks whether that is a good opening or a boring one, and it is the question with the least evidence behind it in this milestone.

---
## Which goldens move, exactly, and in which task

`hashState(s)` is FNV-1a over the **whole** buffer, sized by `computeLayout(regionsFor(map)).totalBytes`, so adding a region changes the digest even when every new byte is zero.

**Buffer shape changes in exactly ONE task, Task 1.** That is deliberate structure: a standing re-bless licence is a window in which a genuine behavioural regression is absorbed as an expected hash update, and this milestone keeps the window one task wide. Every task after Task 1 appends behaviour, never shape.

`firstCity` sizes: `cells` 960, `groupCount` 5, `maxHouses` 40, `maxDestinations` 16, `maxCars` 80.

| Added in Task 1 | Type | Length | Bytes |
|---|---|---|---|
| `header` grows 9 → 13 (`H_GAME_OVER`, `H_FAILED_DEST`, `H_DEST_SPAWN_TIMER`, `H_SPAWN_COLOUR_CURSOR`) | `Int32` | +4 | **+16** |
| `houseSpawnTimer` | `Int32` | `groupCount` = 5 | **20** |
| `destOvercrowd` | `Int32` | `maxDestinations` = 16 | **64** |
| `destOverTicks` | `Int32` | `maxDestinations` = 16 | **64** |

All four land in the 4-byte tier, which goes **1,660 → 1,824 B**; the `Int16` tier stays 4,320 and the `Uint8` tier stays 7,848. `regionsFor` goes 26 → **29** regions and `totalBytes` goes 13,828 → **13,992** for `firstCity`. 1,824 is a multiple of 4 and 13,992 is a multiple of 4, so `computeLayout` inserts no pad byte anywhere and `regions.test.ts`'s zero-padding assertion still holds.

**Neither insertion is an append, and Task 1's proof depends on knowing that.** `header` is the **third** region in the 4-byte tier (`rng`, `mapIdentity`, `header`, …), so its four new slots go in mid-buffer and shift everything after them; and `computeLayout` emits the 4-byte tier, then the 2-byte tier, then the 1-byte tier, so the three new regions sit in front of `carRouteLen` rather than at the end of the buffer. **Two ranges, both interior.** See Decision 9.

**Every whole-buffer golden moves once in Task 1, for PURE LAYOUT. One of them moves twice more, and only one.**

| Golden | Fixture | Ticks it runs | Moves in |
|---|---|---|---|
| `340556353` state | `determinism.test.ts`, 4×4 map, no buildings | **`TICKS_PER_WEEK * 3 - 1` = 13,499** | **Tasks 1, 2, 5** |
| `2076760277` road-network | `rollback.test.ts` | never calls `step` | Task 1 only |
| `2942219448` loop | `loop.test.ts`, 20×12 | 150 | Task 1 only |
| `294084758` queue | `loop.test.ts`, `Q_RUN_TICKS` | 130 | Task 1 only |
| `3113654132` multiplier | `cars.test.ts`, `M_GOLDEN_TICK` | 110 | Task 1 only |
| `1178110182` seed | `startingCity.test.ts` | pre-tick | Task 1 only |
| `1039862014` demo seed | `demoLayout.test.ts` | pre-tick | Task 1 only |
| `252514232` field | `rollback.test.ts`, `foldedFieldsHash` | — | **never** |
| **NEW: the demand-pin golden** | `loop.test.ts`, a **20×9** fixture, `DG_RUN_TICKS` across a week boundary | — | **blessed once, in Task 6** |

**Why only the state golden moves behaviourally, derived rather than assumed.** It is the only fixture that crosses a week boundary (13,499 ticks spans the boundaries at 4,500 and 9,000, and stops short of 13,500), so it is the only one Task 2's grant can reach, and the only one whose spawn timers cycle far enough to matter. It is on a 4×4 map whose clipped spawn zone is **empty**, so Task 5 places no building in it — only the three timer families cycle, and the colour cursor does not move either, because no colour is eligible without a house. Every other fixture runs inside week 0 and below the first spawn attempt at tick 300.

**Both of those moves carry a direct assertion on the bytes that changed, beside the digest.** Task 2 asserts `H_TILES === startingTiles + 2 * WEEKLY_TILE_GRANT`; Task 5 asserts each timer slot's hand-computed value at tick 13,499 (`H_DEST_SPAWN_TIMER` = 151, every `houseSpawnTimer[c]` = 1, `H_SPAWN_COLOUR_CURSOR` = 0). **A digest is never the only evidence for a re-bless in this milestone.**

**The new golden is blessed rather than re-blessed, and its fixture's map shape is a requirement.** A 20×9 board clips the revealed rect to zero cells on the Y axis (`REVEALED_Y0` is 9), so the spawner is structurally absent from it and the fire ladder is derivable from `pinPeriodForWeek(0)` and `(1)` alone. On `loop.test.ts`'s existing 20×12 shape the clipped zone is 14×3 = 42 cells and a destination spawns at tick 2,250, taking `slotCount(0)` from 2 to 3 and changing the cadence 1,250 ticks before the week boundary — at which point the ladder is not derivable and the golden is a digest with a story attached. Task 6 asserts `spawnZoneCells(world) === 0` as the fixture's posture, before the run.

**Task 10 moves no golden**, and that is derived: it changes which cell a destination lands on, and the only fixtures with a non-empty clipped zone are ones that hold no golden.

Each of the three re-blessing tasks must, in the same commit:

- update the literal at its site with a re-bless comment naming the prior value and the reason, in the form `determinism.test.ts` already uses;
- update the **cross-file literal scan** at `packages/sim/test/loop.test.ts:1089-1102`, which reads `determinism.test.ts` and `rollback.test.ts` off disk and asserts three literals verbatim — one of which is the **field** golden, which must not change;
- (Task 1 only) update `packages/sim/test/regions.test.ts`: `totalBytes`, the ordered region-name list, the per-region element-count assertions, and the FIELD_INPUT exact-set pin; and `packages/sim/test/state.test.ts:377`, whose *"HEADER_LENGTH is exactly 9"* test **must go red and be re-derived to 13** — the first draft listed that file's expectation as "Expected: PASS". Note what needs **no** update and is doing real work for free: the parameterised staleness test pokes one byte of **every declared region** and asserts `hashFieldInputRegions` moves iff that region is FIELD_INPUT, so each new region is covered the moment it is declared;
- (Task 1 only) update the **prose sites that quote a retired literal**, none of which any test reads: `packages/shared/src/maps/demoCity.ts:16-18`, `packages/game/src/startingCity.ts:22` and `:253`, `packages/game/src/layouts.ts:20-21` and `:73`, `packages/game/src/main.ts:152`. A stale digest in a comment passes every test in the repo and reads as verified;
- record old and new values in the commit message, with the reason.

---

## Task 1: The buffer shape — four header slots, three regions, seven goldens, one commit

**Files:**
- Modify: `packages/sim/src/state.ts` (header keys, `HEADER_LENGTH`, `GameState`, `REGION_FIELD_NAMES`, `viewsOver`, `createState`, `isGameOver`, `failedDestination`)
- Modify: `packages/sim/src/regions.ts` (three regions, both partitions, dated reasons)
- Modify: `packages/shared/src/constants.ts` (`HOUSE_SPAWN_PERIOD_TICKS`, `DEST_SPAWN_PERIOD_TICKS`, `DESTINATIONS_PER_WEEK`, `MS_PER_SECOND`)
- Test: `packages/sim/test/regions.test.ts`, `packages/sim/test/state.test.ts` (**including `:377`, `'HEADER_LENGTH is exactly 9 — one slot per named constant, in order 0..8'`, which MUST go red and be re-derived to 13**), `packages/sim/test/determinism.test.ts`, `packages/sim/test/rollback.test.ts`, `packages/sim/test/loop.test.ts`, `packages/sim/test/cars.test.ts`, `packages/game/test/startingCity.test.ts`, `packages/game/test/demoLayout.test.ts`, `packages/shared/test/constants.test.ts`
- Modify, for the retired golden LITERALS quoted in prose — **these are the sites Task 1's first draft missed, and a stale digest in a comment is the "reads as satisfied" defect in its cheapest form**: `packages/shared/src/maps/demoCity.ts:16-18` (names `340556353` and `1178110182` in one sentence), `packages/game/src/startingCity.ts:22` and `:253`, `packages/game/src/layouts.ts:20-21` and `:73`, `packages/game/src/main.ts:152`

**Interfaces:**
- Produces: `H_GAME_OVER = 9`, `H_FAILED_DEST = 10`, `H_DEST_SPAWN_TIMER = 11`, `H_SPAWN_COLOUR_CURSOR = 12`, `HEADER_LENGTH = 13`; `GameState.houseSpawnTimer: Int32Array`, `GameState.destOvercrowd: Int32Array`, `GameState.destOverTicks: Int32Array`; `isGameOver(s: GameState): boolean`; `failedDestination(s: GameState): number`; constants `MS_PER_SECOND = 1000`, `DESTINATIONS_PER_WEEK = 2`, `DEST_SPAWN_PERIOD_TICKS = TICKS_PER_WEEK / DESTINATIONS_PER_WEEK`, `HOUSE_SPAWN_PERIOD_TICKS = 10 * TICKS_PER_SECOND`.
- Consumes: nothing from a later task. **This task adds no behaviour** — nothing reads the new regions or slots.

- [ ] **Step 1: Write the failing shape test**

In `packages/sim/test/regions.test.ts`, replace the `totalBytes` test's expectation and the region-name list, and add the element-count test for the three new regions:

```ts
  it('totals exactly 13,992 bytes for firstCity, per the M1e region table', () => {
    // M1d closed at 13,828 B over 26 regions. M1e Task 1 appends three Int32
    // regions to the END of the 4-byte tier and grows `header` from 9 to 13
    // slots: +16 (header) + 20 (houseSpawnTimer) + 64 (destOvercrowd) + 64
    // (destOverTicks) = +164. The 4-byte tier goes 1,660 -> 1,824, which is a
    // multiple of 4, so no pad byte is inserted anywhere.
    const { totalBytes } = computeLayout(regionsFor(MAP))
    expect(totalBytes).toBe(13992)
  })

  it('the three M1e Task 1 regions have the exact element counts and byte sizes the plan predicts', () => {
    // Spelled out separately from the total, because a total is satisfied by
    // any three regions summing to 148 B — including a `Uint8` overcrowd meter
    // (which cannot hold 2,640,000) or a per-CELL timer (which is not what a
    // per-COLOUR house cadence means).
    const byName = new Map(regionsFor(MAP).map((r) => [r.name, r]))
    const houseTimer = byName.get('houseSpawnTimer')!
    const meter = byName.get('destOvercrowd')!
    const over = byName.get('destOverTicks')!
    expect(houseTimer.ctor).toBe(Int32Array)
    expect(houseTimer.len).toBe(MAP.groupCount)
    expect(meter.ctor).toBe(Int32Array)
    expect(meter.len).toBe(MAP.maxDestinations)
    expect(over.ctor).toBe(Int32Array)
    expect(over.len).toBe(MAP.maxDestinations)
  })
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm -r --no-bail --filter './packages/sim' test -- regions`
Expected: FAIL — `expected 13828 to be 13992`, and `byName.get('houseSpawnTimer')` is `undefined`.

- [ ] **Step 3: Add the four constants**

In `packages/shared/src/constants.ts`, beside the clock block:

```ts
/** Milliseconds per second. Named so a `/ 1000` that means "ms to s" cannot be misread as DENOM. */
export const MS_PER_SECOND = 1000
```

and a new spawning block:

```ts
// --- Spawning (spec §5.9; the RATE is [OURS], the intervals are [MOD]) ---
/**
 * §5.9 gives geometry and MINIMUM intervals but no rate, so the rate is
 * authored here. **This is a SCHEDULE, not a delivery rate** — measured on
 * `firstCity` with no player input, the schedule delivers well under two a
 * week because most attempts are refused by the Chebyshev-2 spacing rule; the
 * plan's "What this plan does not settle" records the measured figure and the
 * ceiling. Do not read this constant as "the board gains two destinations a
 * week".
 */
export const DESTINATIONS_PER_WEEK = 2
export const DEST_SPAWN_PERIOD_TICKS = TICKS_PER_WEEK / DESTINATIONS_PER_WEEK
/** §5.9's "10 s between same-group house spawns", converted here and nowhere else. */
export const HOUSE_SPAWN_PERIOD_TICKS = 10 * TICKS_PER_SECOND
```

- [ ] **Step 4: Declare the header slots and the accessors**

In `packages/sim/src/state.ts`, after `H_EPOCH`:

```ts
/** 0 while the run is live; 1 once a destination's overcrowd timer completed (spec §5.8). */
export const H_GAME_OVER = 9
/**
 * The destination whose timer completed. Meaningful ONLY when `H_GAME_OVER` is
 * 1, which is why every reader goes through `failedDestination` below rather
 * than reading the slot: zero-initialised, this names destination 0, and a
 * live run must not be able to answer "which destination killed you".
 */
export const H_FAILED_DEST = 10
/** Ticks until the next destination spawn attempt (spawn.ts). Initialised in `createState`. */
export const H_DEST_SPAWN_TIMER = 11
/** Round-robin cursor over colours for destination spawning (spawn.ts). */
export const H_SPAWN_COLOUR_CURSOR = 12
export const HEADER_LENGTH = 13
```

and the two accessors:

```ts
/** True once a destination's overcrowd timer completed. `step` returns immediately while it holds. */
export function isGameOver(s: GameState): boolean {
  return (s.header[H_GAME_OVER] as number) !== 0
}

/**
 * The destination that ended the run, or -1 while it is live. Guarded rather
 * than exposed raw: `H_FAILED_DEST` is zero-initialised, so an unguarded read
 * during a live run names destination 0 with total confidence.
 */
export function failedDestination(s: GameState): number {
  return isGameOver(s) ? (s.header[H_FAILED_DEST] as number) : -1
}
```

- [ ] **Step 5: Declare the three regions**

In `packages/sim/src/regions.ts`, at the END of the 4-byte tier, after `carTargetDest`:

```ts
    // M1e Task 1. All three are Int32 and all three append to the END of the
    // 4-byte tier, so the tier's cumulative length stays a multiple of 4 and
    // `computeLayout` inserts no pad byte. These are the LAST regions this
    // milestone adds: "Which goldens move, exactly" fixes the shape at 29
    // regions and 13,992 B for `firstCity`, and every task after this one
    // appends behaviour, never shape.
    //
    // Ticks until the next house-spawn attempt for each colour, counting DOWN
    // from `HOUSE_SPAWN_PERIOD_TICKS` (written by `createState`). Per COLOUR
    // and not per house: §5.9's interval is "between same-group house spawns".
    { name: 'houseSpawnTimer', ctor: Int32Array, len: groupCount },
    // The integrated overcrowd meter, in MILLI-TICKS (ticks x DENOM) — spec
    // §5.8. Int32 and not Uint8/Int16 by arithmetic, not by taste:
    // `OVERCROWD_FAIL_MILLITICKS` is 2,640,000.
    { name: 'destOvercrowd', ctor: Int32Array, len: maxDestinations },
    // Consecutive ticks at or over the timer capacity, driving §5.8's
    // `s(t) = min(1, 0.02t)` ramp. SATURATES at `OVERCROWD_RAMP_FULL_TICKS`
    // (1,500), so no width question can arise at any run length — the same
    // construction `carBlockedTicks` uses against `MAX_BLOCKED_TICKS`.
    { name: 'destOverTicks', ctor: Int32Array, len: maxDestinations },
```

Add all three to `FIELD_IRRELEVANT_REGIONS` and give each a dated reason in the existing form:

```
 *   - houseSpawnTimer: a per-colour countdown nothing in routing reads. It
 *                      moves every tick, so classifying it FIELD_INPUT is the
 *                      `H_TICK` failure a fourth time: rebuild every colour
 *                      every tick forever, silently, with correct answers.
 *                      Dated: never — a spawn cadence cannot become an edge cost.
 *   - destOvercrowd:   the failure meter. It moves on nearly every tick any
 *                      destination is over capacity, and no edge cost, source
 *                      set or `dir` read depends on it. Dated: never.
 *   - destOverTicks:   as above, and MORE so — it moves on every tick a
 *                      destination is over capacity. Dated: never.
```

- [ ] **Step 6: Add the views and the initial writes**

In `packages/sim/src/state.ts`, add the three fields to `GameState` and to `REGION_FIELD_NAMES`/`viewsOver` in declaration order, then in `createState`, after the occupancy fill:

```ts
  // M1e Decision 9. A zero timer means "fire now", so without these the very
  // first tick of every run attempts a destination spawn and one house spawn
  // per colour. Written here beside `H_TILES` for the same reason: these are
  // the initial values of the declared shape, not behaviour.
  //
  // **Both writes land INSIDE the bytes this task inserts** — `H_DEST_SPAWN_TIMER`
  // is one of the four new header slots and `houseSpawnTimer` is one of the
  // three new regions — which is what makes Step 8's re-bless proof an exact
  // byte splice with no correction term. See Decision 9.
  s.header[H_DEST_SPAWN_TIMER] = DEST_SPAWN_PERIOD_TICKS
  s.houseSpawnTimer.fill(HOUSE_SPAWN_PERIOD_TICKS)
```

- [ ] **Step 7: Write the accessor and initial-value tests, and re-derive the header-length test**

In `packages/sim/test/state.test.ts`:

```ts
  it('a fresh state is live, names no failed destination, and arms both spawn timers', () => {
    const s = createState('m1e-shape', firstCity())
    expect(isGameOver(s)).toBe(false)
    // Not `s.header[H_FAILED_DEST]`: the slot is 0, which is a real
    // destination index. The guarded reader is the only correct one.
    expect(failedDestination(s)).toBe(-1)
    expect(s.header[H_DEST_SPAWN_TIMER]).toBe(DEST_SPAWN_PERIOD_TICKS)
    expect(Array.from(s.houseSpawnTimer)).toEqual(new Array(firstCity().groupCount).fill(HOUSE_SPAWN_PERIOD_TICKS))
    expect(Array.from(s.destOvercrowd).every((v) => v === 0)).toBe(true)
    expect(Array.from(s.destOverTicks).every((v) => v === 0)).toBe(true)
  })

  it('failedDestination reports the slot only once the run is over', () => {
    const s = createState('m1e-shape-over', firstCity())
    s.header[H_FAILED_DEST] = 3
    expect(failedDestination(s), 'a live run must not answer this').toBe(-1)
    s.header[H_GAME_OVER] = 1
    expect(failedDestination(s)).toBe(3)
  })
```

and **re-derive `state.test.ts:377` rather than deleting it.** It reads today:

```ts
  it('HEADER_LENGTH is exactly 9 — one slot per named constant, in order 0..8', () => {
    expect(HEADER_LENGTH).toBe(9)
    expect([H_TICK, H_SCORE, H_WEEK, H_TILES, H_HOUSE_COUNT, H_DEST_COUNT, H_PINS_DROPPED, H_ROUTES_REFUSED, H_EPOCH]).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ])
  })
```

It becomes:

```ts
  it('HEADER_LENGTH is exactly 13 — one slot per named constant, in order 0..12', () => {
    // Re-derived in M1e Task 1 (was 9, slots 0..8). The point of this test is
    // that the header has no unnamed slots and no gaps: a header grown by
    // bumping the length without declaring a constant is bytes in every
    // golden that nothing can ever read, and the digest cannot tell you.
    expect(HEADER_LENGTH).toBe(13)
    expect([
      H_TICK, H_SCORE, H_WEEK, H_TILES, H_HOUSE_COUNT, H_DEST_COUNT, H_PINS_DROPPED,
      H_ROUTES_REFUSED, H_EPOCH, H_GAME_OVER, H_FAILED_DEST, H_DEST_SPAWN_TIMER,
      H_SPAWN_COLOUR_CURSOR,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })
```

- [ ] **Step 8: Prove the re-bless by an EXACT byte splice, before writing any new number**

**The proof is a splice of two contiguous byte blocks and NOTHING else — no zeroing, no correction term.** Two things make that true and both must be checked rather than assumed:

1. **`header` is the THIRD region in the 4-byte tier** (`regions.ts`: `rng`, `mapIdentity`, `header`, …), so growing `HEADER_LENGTH` from 9 to 13 inserts 16 bytes **mid-buffer** and shifts everything after it. **It is not an append.** The first draft of this plan said "splice the inserted bytes out **and zero** those slots"; `hashBytes` is FNV-1a — `h ^= b; h = imul(h, prime)` — so a zero byte is `h = imul(h, prime)`, which is **not the identity**. Zeroing removes the value and leaves the multiply. It cannot reproduce the prior digest on any fixture, however benign the change.
2. **The three new regions also land mid-buffer**, because `computeLayout` emits the 4-byte tier, then the 2-byte tier, then the 1-byte tier — so 148 bytes appended to the *end of the 4-byte tier* sit in front of `carRouteLen`.

So there are exactly **two inserted ranges**, and the splice removes both:

```ts
/**
 * The M1e Task 1 re-bless proof, kept beside the digests it licenses.
 *
 * Removes the two byte ranges this task INSERTED and hashes the remainder,
 * which must reproduce the pre-M1e digest bit-for-bit. Ranges are computed
 * from `computeLayout(regionsFor(map))` for THE FIXTURE'S OWN MAP — the four
 * re-blessed fixtures run on four different maps and quoting one map's
 * offsets at another's site reads as a fabricated derivation.
 *
 * **No slot is zeroed and none needs to be**: `createState`'s two initial
 * writes (`H_DEST_SPAWN_TIMER`, `houseSpawnTimer`) both land inside the
 * spliced ranges by construction, so this task's re-bless is PURE LAYOUT.
 * That is a stronger claim than "layout plus two named writes" and it is the
 * one to make — a re-bless with a behavioural term in it is a window a
 * regression can land in.
 */
function spliceM1eInsertions(s: GameState, map: MapData): Uint8Array {
  const layout = computeLayout(regionsFor(map))
  const at = (name: string) => layout.regions.find((r) => r.name === name)!
  // Block A: the four header slots appended to `header`, which is mid-tier.
  const headerRegion = at('header')
  const aStart = headerRegion.byteOffset + 9 * 4
  const aEnd = headerRegion.byteOffset + HEADER_LENGTH * 4
  // Block B: the three new regions, contiguous at the end of the 4-byte tier.
  const bStart = at('houseSpawnTimer').byteOffset
  const bEnd = at('destOverTicks').byteOffset + at('destOverTicks').byteLength
  const src = new Uint8Array(s.bytes)
  const out = new Uint8Array(src.length - (aEnd - aStart) - (bEnd - bStart))
  let w = 0
  for (let i = 0; i < src.length; i++) {
    if (i >= aStart && i < aEnd) continue
    if (i >= bStart && i < bEnd) continue
    out[w++] = src[i] as number
  }
  return out
}

it('the M1e Task 1 re-bless is pure layout: splicing the inserted bytes out reproduces every prior digest', () => {
  // Vacuity first: the splice must actually have removed something, and the
  // two blocks must be disjoint and correctly sized, or a no-op splice would
  // "prove" a digest that never moved.
  for (const f of ALL_SEVEN_REBLESSED_FIXTURES) {
    const spliced = spliceM1eInsertions(f.state, f.map)
    expect(spliced.length, f.name).toBe(f.priorTotalBytes)
    expect(hashBytes(spliced), `${f.name}: the splice must reproduce the pre-M1e digest`).toBe(f.priorDigest)
  }
})
```

Record each fixture's `(aStart, aEnd, bStart, bEnd)` and prior `totalBytes` in the test's own table. **If any fixture fails this, stop and report — the change is not pure layout and the re-bless has no proof.**

- [ ] **Step 9: Re-bless the seven, each with its own comment**

At each site, in the form the file already uses. For example, in `packages/sim/test/determinism.test.ts`:

```ts
    // **Re-blessed in M1e Task 1 (was 340556353 at M1d Task 5; 1729791425 at
    // M1d Task 2; 2413319809 at M1c; 1073292924 at M1b). This is the ONLY
    // shape change in M1e** — the plan's "Which goldens move, exactly" fixes
    // the buffer at 29 regions and 13,992 B for `firstCity`, and every later
    // task appends behaviour, never shape.
    //
    // **PURE LAYOUT, proved by an exact byte splice** (see
    // `spliceM1eInsertions`): removing the two inserted ranges — 16 B of new
    // header slots at offset <A> and 148 B of new regions at offset <B>, both
    // MID-BUFFER — reproduces 340556353 bit-for-bit with no slot zeroed.
    // `createState`'s two initial timer writes land inside those ranges, so
    // there is no behavioural term in this re-bless at all. Offsets are FOR
    // THIS FIXTURE — GOLDEN_MAP is 4x4, so its region lengths are not
    // `firstCity`'s.
    //
    // This number moves TWICE MORE in this milestone and in no other task:
    // Task 2 (the weekly tile grant, which this 13,499-tick fixture crosses
    // twice) and Task 5 (the spawn timers cycling). Both carry a direct
    // assertion on the changed slots beside the digest.
    expect(hashState(s)).toBe(/* new value */)
```

Then update the cross-file scan at `packages/sim/test/loop.test.ts:1093-1094`, the prose at `packages/game/src/main.ts:152`, and **the four prose sites that quote a retired literal**: `packages/shared/src/maps/demoCity.ts:16-18`, `packages/game/src/startingCity.ts:22` and `:253`, `packages/game/src/layouts.ts:20-21` and `:73`.

- [ ] **Step 10: Run the whole suite, then grep for surviving retired literals**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`

Expected: PASS, with `252514232` untouched. If it moved, a new region was misclassified FIELD_INPUT — stop and report.

Then, because a stale digest in a comment passes every test in the repo:

```bash
grep -rn "340556353\|2076760277\|2942219448\|294084758\|3113654132\|1178110182\|1039862014" packages/ --include="*.ts"
```

Every surviving hit must be inside a re-bless comment that explicitly labels it as a **prior** value. A bare occurrence is a stale claim.

- [ ] **Step 11: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `houseSpawnTimer` length `groupCount` → `maxDestinations` | `regions.test.ts` element-count assertion; `totalBytes` |
| `destOvercrowd` ctor `Int32Array` → `Uint8Array` | `regions.test.ts` element-count; `totalBytes`; zero-padding |
| Drop the `createState` timer writes | the fresh-state test, by name — **and NOT the splice proof, which is blind to them by construction**; record that, because it looks like a hole and is the point |
| `failedDestination` returns the slot unguarded | the second accessor test, by name |
| Classify any new region FIELD_INPUT | the exact-set pin **and** the parameterised staleness test |
| Declare a new region in the `Int16` tier instead | the zero-padding assertion |
| `HEADER_LENGTH` 13 → 14 with no constant declared | Step 7's re-derived header test |
| `spliceM1eInsertions`: omit block A (the header bytes) | its own vacuity assertion (`spliced.length`), then the digest |

Every kill must be an assertion failure. Confirm per-package totals are unchanged under each mutant.

- [ ] **Step 12: Commit**

```bash
git add packages/sim/src/state.ts packages/sim/src/regions.ts packages/shared/src/constants.ts packages/sim/test packages/game/test packages/shared/test packages/game/src packages/shared/src/maps/demoCity.ts
git commit -F - <<'EOF'
feat(sim): the M1e buffer shape, and the milestone's only re-bless

Three Int32 regions (houseSpawnTimer, destOvercrowd, destOverTicks) and four
header slots (H_GAME_OVER, H_FAILED_DEST, H_DEST_SPAWN_TIMER,
H_SPAWN_COLOUR_CURSOR). 26 -> 29 regions, 13,828 -> 13,992 B for firstCity, no
pad byte. No behaviour: nothing reads any of them yet.

Seven whole-buffer goldens re-blessed for PURE LAYOUT. `header` is the third
region in the 4-byte tier and the three new regions precede the Int16 tier, so
both insertions are MID-BUFFER; the proof splices those two ranges out and
reproduces each prior digest exactly. Nothing is zeroed and nothing needs to be
— createState's two initial timer writes land inside the spliced ranges.

  determinism state    340556353  -> <new>
  rollback road-net   2076760277  -> <new>
  loop                2942219448  -> <new>
  loop queue           294084758  -> <new>
  cars multiplier     3113654132  -> <new>
  startingCity seed   1178110182  -> <new>
  demoLayout seed     1039862014  -> <new>

The field golden 252514232 did not move; it is a tripwire, not a re-bless.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
```

**Observability:** nothing. This task adds no behaviour and a player cannot distinguish the build before it from the build after it. Said out loud at plan time rather than discovered by the user.

---

## Task 2: The week boundary, the tile grant, and the transposition handoff discharged

**Files:**
- Create: `packages/sim/src/week.ts`
- Modify: `packages/sim/src/clock.ts` (`isWeekBoundary`), `packages/sim/src/step.ts` (phase 2), `packages/shared/src/constants.ts` (`WEEKLY_TILE_GRANT`), `packages/sim/src/index.ts`
- Test: `packages/sim/test/week.test.ts` (new), `packages/sim/test/clock.test.ts`, `packages/sim/test/step.test.ts`, `packages/sim/test/determinism.test.ts`, `packages/shared/test/constants.test.ts`

**Interfaces:**
- Consumes: `H_TILES`, `H_TICK` (Task 1's file, unchanged slots); `weekOfTick(tick: number): number` from `clock.ts`.
- Produces: `isWeekBoundary(tick: number): boolean`; `runWeekBoundary(state: GameState): void`; `WEEKLY_TILE_GRANT = 30`. `step` now has eight phases, with the week boundary at position 2.

**One consequence this task creates and Task 12 must assert:** the tile ledger stops being a conservation law and becomes a conservation law **with a source term**. `tilesLeft + roadCells + ghostCells` was constant at 9,999 across M1d's 25,000-tick review run; from this commit it steps by `WEEKLY_TILE_GRANT` at every boundary. Task 12 Step 2 asserts the corrected identity, and it is named here because this task is what breaks the old one.

- [ ] **Step 1: Write the failing boundary tests**

`packages/sim/test/clock.test.ts`:

```ts
  it('marks exactly the first tick of each week, and never tick 0', () => {
    expect(isWeekBoundary(0), 'tick 0 is never stepped and never grants').toBe(false)
    expect(isWeekBoundary(1)).toBe(false)
    expect(isWeekBoundary(TICKS_PER_WEEK - 1)).toBe(false)
    expect(isWeekBoundary(TICKS_PER_WEEK)).toBe(true)
    expect(isWeekBoundary(TICKS_PER_WEEK + 1)).toBe(false)
    expect(isWeekBoundary(TICKS_PER_WEEK * 2)).toBe(true)
    expect(isWeekBoundary(TICKS_PER_WEEK * 3)).toBe(true)
  })
```

`packages/sim/test/week.test.ts`:

```ts
  it('grants exactly WEEKLY_TILE_GRANT on a boundary tick and nothing on any other', () => {
    const { state } = rig('week-grant')
    const before = state.header[H_TILES] as number
    state.header[H_TICK] = TICKS_PER_WEEK - 1
    runWeekBoundary(state)
    expect(state.header[H_TILES], 'the tick before a boundary grants nothing').toBe(before)
    state.header[H_TICK] = TICKS_PER_WEEK
    runWeekBoundary(state)
    expect(state.header[H_TILES]).toBe(before + WEEKLY_TILE_GRANT)
    state.header[H_TICK] = TICKS_PER_WEEK + 1
    runWeekBoundary(state)
    expect(state.header[H_TILES], 'the tick after a boundary grants nothing').toBe(before + WEEKLY_TILE_GRANT)
  })

  it('grants once per week over three weeks driven through step, not through the helper', () => {
    // Driven through `step` so the PHASE is exercised, not only the function:
    // a phase that is never called is indistinguishable from dead code, and
    // the counters will not say so.
    const r = rig('week-grant-stepped')
    const before = r.state.header[H_TILES] as number
    for (let i = 0; i < TICKS_PER_WEEK * 3; i++) step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(r.state.header[H_TILES]).toBe(before + 3 * WEEKLY_TILE_GRANT)
  })

  it('grants before inputs are applied, so a boundary-tick placement can spend the new tiles', () => {
    // The fixture is built so the placement is affordable ONLY with the grant:
    // tiles are drained to zero first, then one road is queued on the exact
    // boundary tick. Without the ordering the placement is refused for budget.
    //
    // The residue is 28, not 29: `canPlaceRoad` (roads.ts:404) prices a
    // segment as the number of its two endpoint cells whose mask is currently
    // 0, so the FIRST segment on a fresh board costs **2**. The rig lays one
    // segment on virgin cells, so 30 - 2 = 28. Getting this wrong by one is
    // how a test passes for the wrong reason: at `- 1` the assertion is
    // satisfied by no implementation at all and the test is simply red, which
    // is the benign direction — but the same slip in the other direction
    // (pre-roading one endpoint without saying so) would make it green while
    // measuring a 1-tile segment.
    const r = rig('week-grant-order')
    r.state.header[H_TILES] = 0
    r.state.header[H_TICK] = TICKS_PER_WEEK - 1
    step(r.state, r.world, r.fields, r.scratch, { actions: [{ kind: 'place', a: BOUNDARY_A, b: BOUNDARY_B }] })
    expect(r.state.header[H_TICK]).toBe(TICKS_PER_WEEK)
    expect(roadMask(r.state, BOUNDARY_A), 'the boundary-tick placement must have landed').not.toBe(0)
    expect(r.state.header[H_TILES]).toBe(WEEKLY_TILE_GRANT - 2)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -r --no-bail --filter './packages/sim' test -- week clock`
Expected: FAIL with `isWeekBoundary is not defined` and `runWeekBoundary is not defined`.

- [ ] **Step 3: Add the constant**

```ts
// --- The weekly grant (spec §5.10) ---
/**
 * Spec §5.10's Road Tiles card, per-map constant "30 or 40" — 30 here.
 *
 * **This is the load-bearing half of §5.10 and M1e ships only this half.** The
 * other half is the two-card CHOICE, and every card in the table but this one
 * grants an ITEM — bridge, tunnel, roundabout, traffic lights, motorway — none
 * of which has a placement mechanism yet. A pool with one offerable entry is a
 * menu with one item, so the modal is M1f's, along with the first item that
 * makes it a choice. What §5.10 says about THIS number is honoured exactly:
 * "Tile income is flat, not week-indexed — difficulty ramps on the demand side
 * only." It is not multiplied by the week and it must not become so.
 *
 * **Known and recorded rather than tuned here:** 30 starting plus 30 a week is
 * ~270 tiles by week 8 against roughly 280 placeable cells in the 308-cell
 * revealed rect, so tiles stop being the binding constraint somewhere around
 * week 3. Task 10's greedy-connect arm measures where, and the plan's "What
 * this plan does not settle" carries it.
 */
export const WEEKLY_TILE_GRANT = 30
```

- [ ] **Step 4: Add `isWeekBoundary`**

In `packages/sim/src/clock.ts`:

```ts
/**
 * True iff `tick` is the first tick of a new week.
 *
 * Derived from `weekOfTick(tick) !== weekOfTick(tick - 1)` rather than from a
 * stored "last granted week", so there is no second copy of the week index to
 * drift. **Tick 0 needs no guard and must not get one**: `-1 / TICKS_PER_WEEK
 * | 0` truncates toward zero, so `weekOfTick(-1)` is 0 and equals
 * `weekOfTick(0)`. An explicit `tick <= 0` branch here would be a line no
 * mutation can falsify.
 */
export function isWeekBoundary(tick: number): boolean {
  return weekOfTick(tick) !== weekOfTick(tick - 1)
}
```

- [ ] **Step 5: Write `runWeekBoundary`**

`packages/sim/src/week.ts`:

```ts
import { WEEKLY_TILE_GRANT } from '@laneways/shared'
import type { GameState } from './state'
import { H_TICK, H_TILES } from './state'
import { isWeekBoundary } from './clock'

/**
 * Phase 2 of the tick order: the weekly grant (spec §5.10).
 *
 * **Position, and why it is not decoration.** It reads `H_TICK`, so it must
 * follow phase 1's advance — swapping 1 and 2 grants against the previous
 * tick's week and moves every grant one tick early. And it must PRECEDE phase
 * 3, so an action queued on the boundary tick can spend the tiles it just
 * received; the alternative makes the boundary tick the one tick of the week a
 * player's road is refused for budget, which is unexplainable at the screen.
 *
 * This is the first phase in the game to read the clock. `step.ts`'s comment
 * records why that matters: the two inherited 0-detector transpositions were
 * inert because **no `TickAction` reads `H_TICK`**, and this phase does not
 * change that — `TickActionKind` is still `'place' | 'erase'`. What it does is
 * put a clock reader BETWEEN the advance and the input loop, which ends the
 * inertness of that pair for a different and better reason: the two phases now
 * have something observable between them.
 *
 * **This function is also the source term in the tile ledger.** `tilesLeft +
 * roadCells + ghostCells` was an exact conservation law across 25,000 ticks at
 * the close of M1d; from here it is conserved BETWEEN boundaries and stepped by
 * `WEEKLY_TILE_GRANT` at each one. The long-run assertion must carry the term
 * explicitly rather than loosening to a range — the point of the invariant is
 * that the refund path conserves, and a range hides a leaking refund.
 *
 * Nothing here allocates: two reads, one comparison, one write.
 */
export function runWeekBoundary(state: GameState): void {
  if (!isWeekBoundary(state.header[H_TICK] as number)) return
  state.header[H_TILES] = (state.header[H_TILES] as number) + WEEKLY_TILE_GRANT
}
```

- [ ] **Step 6: Wire phase 2 into `step`**

In `packages/sim/src/step.ts`, between the clock advance and the input loop:

```ts
  runWeekBoundary(s)
```

and rewrite the phase table in the module comment to eight entries, moving the old phases 2–7 down by one and adding the "Position, and why" paragraph above.

- [ ] **Step 7: Re-bless the state golden with its behavioural assertion beside it**

In `packages/sim/test/determinism.test.ts`, immediately above the digest:

```ts
    // M1e Task 2 moves this number, and the plan said so in advance. This
    // fixture runs `TICKS_PER_WEEK * 3 - 1` = 13,499 ticks, which crosses the
    // boundaries at 4,500 and 9,000 and stops short of 13,500 — so it takes
    // exactly two grants. **Asserted directly, so the digest is not the only
    // evidence**: a re-bless whose sole proof is "the digest moved" absorbs any
    // regression that lands in the same commit.
    expect(s.header[H_TILES]).toBe(GOLDEN_MAP.startingTiles + 2 * WEEKLY_TILE_GRANT)
```

Re-bless the literal with a comment naming the prior value and this reason, and update the cross-file scan at `loop.test.ts:1093`.

- [ ] **Step 8: Pin the two positions**

Add to `packages/sim/test/step.test.ts`:

```ts
  it('the week grant runs after the clock advance — moving it earlier grants against last tick', () => {
    // The detector for transposing phases 1 and 2, AND — see Step 9 — the
    // detector for transposing 1 and 3, because both orderings put the grant
    // in front of the advance.
    const r = rig('phase-1-2')
    const before = r.state.header[H_TILES] as number
    r.state.header[H_TICK] = TICKS_PER_WEEK - 2
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT) // -> 4499, no grant
    expect(r.state.header[H_TILES]).toBe(before)
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT) // -> 4500, one grant
    expect(r.state.header[H_TILES]).toBe(before + WEEKLY_TILE_GRANT)
  })
```

The "grant before inputs" position is pinned by Step 1's third test.

- [ ] **Step 9: Re-measure the two inherited transpositions, and PREDICT the result before running**

The two pairs the M1d handoff is about are, in the new eight-phase numbering, **`1↔3`** (the clock advance against the input loop) and **`3↔4`** (the input loop against demand). State the prediction first, because a measurement with no prediction cannot be wrong:

- **`3↔4` — predicted 0 detectors, for the same single unchanged reason.** No `TickAction` reads `H_TICK`; `TickActionKind` is still `'place' | 'erase'`; `roads.ts` reads neither `H_TICK` nor `H_WEEK`. `step.test.ts`'s tripwire on that condition still holds. Record it as still inert.
- **`1↔3` — predicted NON-ZERO, and this task is what ends its inertness.** Transposing them yields `inputs, grant, advance`, so `runWeekBoundary` now reads the tick **before** it is advanced, misses the boundary at 4,500 and grants a tick late. **Step 8's test is the named expected detector**, and Step 1's stepped three-week test is the second. **An implementer who measures ≥ 1 here and trusts a "still inert" prediction will hunt a bug that does not exist, or worse, "fix" the only detector for the thing this milestone claims to discharge.** If it scores 0, Step 8's test does not work and this task is wrong — report that rather than recording the zero.

Then run the new adjacent pair `1↔2` (clock ↔ week grant), predicted non-zero with Step 8 as the detector, and `2↔3` (week grant ↔ inputs), predicted non-zero with Step 1's third test.

**Run four unmutated baselines alongside**, because a flaky baseline reads exactly like a kill: `allocation.test.ts`'s sampling profiler has produced one, and `drawAllocation.test.ts` flakes roughly 1 run in 10 with no path to the mutated module at all. Record the result in `step.ts`'s comment, replacing M1d's re-measurement block with an M1e one that states the phase count changed from 7 to 8 and that `1↔3` is no longer a member of the inert set.

- [ ] **Step 10: Run the suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. **Only `340556353`'s successor may have moved.** Confirm by digest, not by "a test in that describe block failed" — a red golden test proves only that something in it failed.

- [ ] **Step 11: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `isWeekBoundary`: `!==` → `===` | boundary test, by name; the stepped three-week test |
| `isWeekBoundary`: `tick - 1` → `tick` | boundary test (never true) |
| `runWeekBoundary`: grant `WEEKLY_TILE_GRANT * week` | the three-week test (60 + 90 ≠ 90) |
| Drop the `runWeekBoundary` call from `step` | the stepped test; the state golden |
| Move phase 2 after the input loop | the boundary-tick placement test |
| Move phase 2 before the clock advance | Step 8's test |
| Transpose phases 1 and 3 | Step 8's test — **this row is the discharged handoff and its count must be non-zero** |

- [ ] **Step 12: Commit**

```bash
git add packages/sim/src/week.ts packages/sim/src/clock.ts packages/sim/src/step.ts packages/sim/src/index.ts packages/shared/src/constants.ts packages/sim/test packages/shared/test
git commit -m "$(cat <<'EOF'
feat(sim): the week boundary grants tiles, and a clock reader lands where it can fail

Phase 2 of eight. WEEKLY_TILE_GRANT = 30, flat and never week-indexed (§5.10).

This discharges M1d's transposition handoff, and not by the route the first
draft claimed. Spawning and granting are PHASES, not TickActions, so 3<->4
(inputs vs demand) stays inert for the same single reason. But 1<->3 (the clock
advance vs the input loop) STOPS being inert here, because a clock READER now
sits between them: transposed, the grant reads the un-advanced tick and misses
the boundary. Two tests name that, and the re-measurement predicts non-zero for
that row rather than recording a surprise.

This also turns the tile ledger from a conservation law into one with a source
term; Task 12's long run asserts the corrected identity.

State golden re-blessed (<old> -> <new>): this fixture runs 13,499 ticks and
takes exactly two grants, asserted directly beside the digest.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** on the demo board, which is still the default at this point and stays the default until Task 10, the tiles readout jumps from 200 to 230 at 2:30 of play and by 30 again every 2:30 after. That is visible without being told where to look — the HUD already draws `tilesLeft` — but it is the weakest observability line in this milestone, and it is honest to say so: nothing else on the board changes.

---

## Task 3: The flow-field per-frame allocation, and the allowance that must die with it

**Files:**
- Modify: `packages/sim/src/flowfield.ts` (`computeFlowField`'s `push`), `packages/sim/src/scratch.ts` (`Scratch.cursor`, `CUR_TOP`, `CUR_PENDING`, `createScratch`)
- Test: `packages/game/test/demoAllocation.test.ts` (**delete the allowance**), `packages/sim/test/scratch.test.ts`, `packages/sim/test/flowfield.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2. This task is independent of the rest of the milestone and may be reviewed on its own.
- Produces: `Scratch.cursor: Int32Array` (length 2), `CUR_TOP = 0`, `CUR_PENDING = 1`. `computeFlowField`'s signature, output and complexity are unchanged.

**M1d handed this here by name, and the recipient is this task rather than "whoever owns the perf budget"** — a handoff with no named recipient is a drop, three times over on M2 alone. The evidence: `packages/sim/src/flowfield.ts` charges **16.8–21.8 B/frame** on the demo board across four draws — present in every draw, so a signal and not a stray — against **1.5–1.8 B/frame** on the shipped starting city under the identical rig, which is below the 4 B noise floor and is why every other harness is green. The difference is rebuild frequency: 18 destinations move `destPins` almost every tick, so `syncFields` re-runs `computeFlowField`; the starting city (one pin per 129 ticks) almost never does. It is **pre-existing, not introduced** — no `sim` file was touched by the demo layout, the code is M1b's and only the input is new.

**The hypothesis is that `push` is a closure over the mutable `top` and `pending`, which V8 boxes into a `Context` — the same shape `loop.ts`'s known residual has.** It is written down as a hypothesis because **function-level profiler attribution is documented unstable in this repo**, and this task must therefore measure before and after rather than assume. If the charge does not fall, revert and report; do not layer a second guess on top of the first.

- [ ] **Step 1: Measure the baseline, as a range over stated draws**

Run `demoAllocation.test.ts` five times and record the `flowfield.ts` per-frame figure from each. **Report it as a range over five draws, never as a point** — this instrument has already produced 109.20 and 119.00 in one report and 50.60 on a re-run.

- [ ] **Step 2: Write the positive control and confirm the harness can see this file**

Inject an **escaping** allocation into `computeFlowField`'s relaxation loop and confirm the charge rises:

```ts
      ;(globalThis as { __sink?: unknown }).__sink = { ni, k, nd }
```

`const __sink = {…}; void __sink` is deleted by V8's scalar replacement and reads exactly like a blind harness. Remove the injection before proceeding.

- [ ] **Step 3: Add the cursor slots to `Scratch`**

In `packages/sim/src/scratch.ts`:

```ts
export const CUR_TOP = 0
export const CUR_PENDING = 1
const CURSOR_LENGTH = 2
```

Add `readonly cursor: Int32Array // CUR_TOP, CUR_PENDING — computeFlowField's queue cursor, overwritten at every call entry` to the interface beside `stats`, allocate it in `createScratch`, and document it in the lifetime split as pathfinding scratch that carries nothing between calls.

- [ ] **Step 4: Replace the closure with a module-scope function**

In `packages/sim/src/flowfield.ts`, above `computeFlowField`:

```ts
/**
 * Pushes a `(cell, d)` entry into bucket `d % NB`. Throws on overflow rather
 * than writing out of range: an out-of-range typed-array write is a silent
 * no-op that would corrupt the pool's bucket chains (`entryCell[e]` reads
 * `undefined`, `entryNext[e]` reads 0), turning a capacity bug into a silent
 * wrong answer or an infinite drain loop instead of a stack trace.
 *
 * **Module-scope, not a closure, and that is the whole of M1e Task 3.** The
 * previous spelling captured the mutable `top` and `pending` from
 * `computeFlowField`'s body, which V8 boxes into a `Context` object — measured
 * at 16.8-21.8 B/frame on the demo board, against a 4 B floor, where 18
 * destinations rebuild the field on nearly every tick. The two counters live in
 * `scratch.cursor` instead, which is preallocated at boot like every other
 * buffer here.
 */
function push(scratch: Scratch, cell: number, d: number): void {
  const { entryCell, entryNext, bucketHead, stats, pushesPerCell, cursor } = scratch
  const top = cursor[CUR_TOP] as number
  if (top >= entryCell.length) {
    throw new Error(`computeFlowField: entry pool exhausted (capacity ${entryCell.length})`)
  }
  const b = d % NB
  entryCell[top] = cell
  entryNext[top] = bucketHead[b] as number
  bucketHead[b] = top
  cursor[CUR_TOP] = top + 1
  cursor[CUR_PENDING] = (cursor[CUR_PENDING] as number) + 1
  stats[ST_PUSHES] = (stats[ST_PUSHES] as number) + 1
  pushesPerCell[cell] = (pushesPerCell[cell] as number) + 1
}
```

In `computeFlowField`, delete `const cap`, `let top`, `let pending` and the inline `push`; reset `cursor[CUR_TOP] = 0` and `cursor[CUR_PENDING] = 0` alongside the other entry-point fills; call `push(scratch, s, 0)` and `push(scratch, ni, nd)`; and drive the drain loop off `cursor`:

```ts
  for (let d = 0; (scratch.cursor[CUR_PENDING] as number) > 0; d++) {
    const b = d % NB
    let e = bucketHead[b] as number
    bucketHead[b] = -1
    while (e >= 0) {
      const cur = entryCell[e] as number
      e = entryNext[e] as number
      scratch.cursor[CUR_PENDING] = (scratch.cursor[CUR_PENDING] as number) - 1
```

- [ ] **Step 5: Confirm the field golden did not move**

Run: `pnpm -r --no-bail --filter './packages/sim' test`
Expected: PASS, and `252514232` unmoved. **This is the one task in the milestone where the field tripwire is the primary correctness evidence** — the rewrite touches the algorithm's queue and nothing else, so byte-identical `dist`/`dir` over the rollback fixture is exactly the claim.

- [ ] **Step 6: Re-measure, five draws, and delete the allowance**

Run `demoAllocation.test.ts` five times again. The `flowfield.ts` figure must fall below the 4 B floor in every draw. **`FLOWFIELD_ALLOWANCE_BYTES_PER_FRAME` asserts the violation is STILL PRESENT as well as bounded, so this fix turns that test RED — that is the signal to delete the allowance, not to loosen it.** A dead exemption outliving the problem it documented is the failure the allowance was shaped to prevent.

- [ ] **Step 7: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `cursor[CUR_TOP] = top + 1` → `= top` | entry-pool tests: chains overwrite and the field is wrong |
| Drop the `cursor` reset at call entry | second `computeFlowField` call on the same scratch throws pool-exhausted |
| Swap `CUR_TOP` and `CUR_PENDING` | drain loop never terminates or exits immediately; `flowfield.test.ts` reachability tests |
| `d % NB` → `d % (NB - 1)` | the field golden `252514232` — this is the aliasing failure `scratch.ts:43-49` describes, and it must be shown to be caught |

- [ ] **Step 8: Commit**

```bash
git add packages/sim/src/flowfield.ts packages/sim/src/scratch.ts packages/sim/test packages/game/test/demoAllocation.test.ts
git commit -m "$(cat <<'EOF'
perf(sim): computeFlowField's push stops boxing, and its allowance is deleted

M1d measured flowfield.ts at 16.8-21.8 B/frame on the demo board against a 4 B
floor and handed it to M1e by name. `push` closed over the mutable `top` and
`pending`; both now live in `scratch.cursor` and `push` is module-scope.

Measured over five draws before and after. FLOWFIELD_ALLOWANCE_BYTES_PER_FRAME
asserted the violation was still present, so the fix turned it red and it is
deleted rather than loosened.

Field golden 252514232 unmoved: the queue changed, the field did not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** nothing. 20 B/frame is four orders of magnitude below anything a player can perceive, and the human who ran the demo board on hardware reported it smooth throughout at this density. This task exists because an unfixed allocation compounds with every later feature that rebuilds a field, not because anyone can see it.

---

## Task 4: Placement validity stops allocating — the loops AND the return value

**Files:**
- Modify: `packages/sim/src/buildings.ts` (delete `allSevenCells`; rewrite `canPlaceDestination`'s cell loops and spacing rule; export `footprintWidth`/`footprintHeight`; **add eight module-scope frozen result singletons and return them from BOTH `canPlaceDestination` and `canPlaceHouse`**)
- Test: `packages/sim/test/buildings.test.ts`, `packages/game/test/demoAllocation.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–3.
- Produces: `footprintWidth(orientation: number): number` and `footprintHeight(orientation: number): number`, now exported (Task 5's zone-fit check needs them and must not re-derive them). `canPlaceDestination(state, world, destCell, orientation): PlaceCheck` and `canPlaceHouse(state, world, cell): PlaceCheck` — **signature, return type, rejection order and every `BuildingPlaceFailure` reason unchanged.**

Decision 10 in full. There are **two** allocations here and the first draft of this plan only removed one.

1. **The cell arrays.** `canPlaceDestination` calls `allSevenCells`, which returns a fresh `number[]` — once for the candidate and once **per existing destination**. Its own doc comment says *"never call this from a per-tick path"*, and Task 5 puts it on one at up to `SPAWN_CANDIDATE_LIMIT × ORIENTATION_COUNT` = 96 calls per attempt.
2. **The result object.** `return { ok: false, reason: 'terrain' }` and its six siblings are fresh object literals on every call, and `canPlaceDestination` is far too large for V8 to inline, so the literal **escapes and is really allocated**. Removing the arrays does not remove this. **The in-repo precedent is exact and this plan's first draft cited it nowhere:** `canPlaceRoad`'s identical literal was measured at 40.6/41.7/44.3 B per call, carried a `'roads.ts': 128` known-violation budget, and was fixed in M1d by module-scope frozen singletons — `roads.ts:303-319`, `REFUSE_OUT_OF_BOUNDS` … `REFUSE_BUDGET` plus the `ACCEPT_BY_COST` table, with `assertPlaceCost` as the fail-closed guard on the table index. Copy that, including the doc comment's reasoning.

**`canPlaceHouse` gets the same treatment in the same commit.** Two reviewers disagreed about whether it matters — one measured it dominant on the demo board at 667 calls per 6,000 ticks, the other measured it scalar-replaced to 0.25 B/call through `placeHouse`. They were measuring different call shapes and both are right about their own. Task 5 introduces a **third** shape, `attemptHouseSpawn`'s direct loop, which neither measured. The fix costs six lines and settles it.

- [ ] **Step 1: Write the migration equivalence proof first**

In `packages/sim/test/buildings.test.ts`, transcribe the retired pairwise implementation once, as a reference:

```ts
/**
 * The pre-M1e implementation, kept HERE and only here, as a one-off migration
 * proof for Task 4's box-arithmetic rewrite. **It is not coverage** — a test
 * that reimplements the thing it checks is a listed defect, and the real
 * coverage is every other `canPlaceDestination` test in this file, all of
 * which are unchanged. Delete this and its one test when the rewrite has been
 * on main for a milestone.
 */
function referenceSpacingViolated(a: readonly number[], b: readonly number[], w: number): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const ax = (a[i] as number) % w
      const ay = ((a[i] as number) / w) | 0
      const bx = (b[j] as number) % w
      const by = ((b[j] as number) / w) | 0
      const dx = ax > bx ? ax - bx : bx - ax
      const dy = ay > by ? ay - by : by - ay
      if ((dx > dy ? dx : dy) < 2) return true
    }
  }
  return false
}

it('the box-arithmetic spacing rule agrees with the retired pairwise one, exhaustively', () => {
  // Every (origin, orientation) pair on a small non-square grid against every
  // (origin, orientation) incumbent — 4 orientations both sides, which is what
  // an earlier `carparkCell` defect showed a non-square fixture alone does not
  // cover: for E the carpark is `cell + 3` and for W it is `cell - 1`, so `w`
  // vanishes entirely and only N and S read it.
  const world = createWorld(testMap(9, 7))
  let compared = 0
  let violated = 0
  for (let ac = 0; ac < world.cells; ac++) {
    for (let ao = 0; ao < ORIENTATION_COUNT; ao++) {
      const a = referenceSevenCells(ac, ao, world)
      if (a === null) continue
      for (let bc = 0; bc < world.cells; bc++) {
        for (let bo = 0; bo < ORIENTATION_COUNT; bo++) {
          const b = referenceSevenCells(bc, bo, world)
          if (b === null) continue
          compared++
          const expected = referenceSpacingViolated(a, b, world.w)
          if (expected) violated++
          expect(
            spacingViolated(ac, ao, bc, bo, world.w),
            `origins ${ac}/${ao} vs ${bc}/${bo}`,
          ).toBe(expected)
        }
      }
    }
  }
  // Vacuity: the loops must actually have compared something, and both answers
  // must occur — an enumeration where every pair is "violated" proves nothing.
  expect(compared).toBeGreaterThan(1000)
  expect(violated).toBeGreaterThan(0)
  expect(violated).toBeLessThan(compared)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -r --no-bail --filter './packages/sim' test -- buildings`
Expected: FAIL with `spacingViolated is not defined`.

- [ ] **Step 3: Write the box arithmetic**

In `packages/sim/src/buildings.ts`:

```ts
/**
 * The minimum Chebyshev (king-move) distance between two axis-aligned boxes,
 * given as inclusive `[x0, x1] x [y0, y1]`.
 *
 * `min over cells of max(|dx|, |dy|)` is `max(gapX, gapY)`, where each gap is
 * the separation along that axis or 0 if the projections overlap. Derived
 * rather than sampled, and pinned against the retired pairwise implementation
 * exhaustively in `buildings.test.ts` — a rewrite of a heavily-tested
 * predicate owes a proof, and "it passes the existing tests" is not one when
 * the existing tests were written against the other algorithm.
 */
function boxChebyshev(
  ax0: number, ay0: number, ax1: number, ay1: number,
  bx0: number, by0: number, bx1: number, by1: number,
): number {
  let gx = 0
  if (bx0 > ax1) gx = bx0 - ax1
  else if (ax0 > bx1) gx = ax0 - bx1
  let gy = 0
  if (by0 > ay1) gy = by0 - ay1
  else if (ay0 > by1) gy = ay0 - by1
  return gx > gy ? gx : gy
}

/**
 * True iff a destination at `(aCell, aOrientation)` sits closer than
 * Chebyshev 2 to one at `(bCell, bOrientation)` — the §5.9 spacing rule, over
 * four box pairs instead of 49 cell pairs and with no array.
 *
 * A carpark is a 1x1 box, so all four comparisons are the same call. Both
 * directions of the footprint-vs-carpark pair are present and they are NOT
 * symmetric inputs: an earlier defect in this file survived all 366 tests
 * because a compound mutation was applied to one side of a symmetric
 * comparison only.
 */
function spacingViolated(
  aCell: number, aOrientation: number, bCell: number, bOrientation: number, w: number,
): boolean {
  const ax0 = aCell % w
  const ay0 = (aCell / w) | 0
  const ax1 = ax0 + footprintWidth(aOrientation) - 1
  const ay1 = ay0 + footprintHeight(aOrientation) - 1
  const bx0 = bCell % w
  const by0 = (bCell / w) | 0
  const bx1 = bx0 + footprintWidth(bOrientation) - 1
  const by1 = by0 + footprintHeight(bOrientation) - 1
  const acx = carparkX(aCell, aOrientation, w)
  const acy = carparkY(aCell, aOrientation, w)
  const bcx = carparkX(bCell, bOrientation, w)
  const bcy = carparkY(bCell, bOrientation, w)
  if (boxChebyshev(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) < 2) return true
  if (boxChebyshev(ax0, ay0, ax1, ay1, bcx, bcy, bcx, bcy) < 2) return true
  if (boxChebyshev(acx, acy, acx, acy, bx0, by0, bx1, by1) < 2) return true
  if (boxChebyshev(acx, acy, acx, acy, bcx, bcy, bcx, bcy) < 2) return true
  return false
}
```

`carparkX`/`carparkY` are `carparkCell`'s existing arithmetic split into its two axes, so `carparkCell` keeps its exact behaviour and becomes `cy * w + cx` over them plus its bounds check. Export `footprintWidth`/`footprintHeight`.

- [ ] **Step 4: Add the eight frozen result singletons**

At module scope in `buildings.ts`, in the exact form `roads.ts:303-319` already uses:

```ts
/**
 * Every `canPlaceDestination`/`canPlaceHouse` outcome is a module-scope frozen
 * singleton, exactly as `canPlaceRoad`'s are (`roads.ts:303-319`) and for the
 * same measured reason: the object literal these functions used to return
 * ESCAPES — both are far too large for V8 to inline, so scalar replacement
 * cannot delete it — and M1d measured the identical literal in `canPlaceRoad`
 * at 40.6-44.3 B per call, which is why that function carried a `'roads.ts':
 * 128` known-violation budget until it was fixed this way.
 *
 * M1e Task 5 puts BOTH of these on a per-tick path at up to
 * `SPAWN_CANDIDATE_LIMIT * ORIENTATION_COUNT` = 96 calls per destination
 * attempt. Removing the cell arrays (Step 3) does not remove this; it is a
 * separate allocation with a separate fix, and reporting the first as "Task 4
 * made placement allocation-free" without the second is how a green harness
 * comes to be a claim about the wrong thing.
 *
 * `Object.freeze` does not recurse — there is one object per outcome and each
 * is frozen at its own level, which is what the `roads.ts` note means by
 * "every level".
 */
const B_OK = Object.freeze({ ok: true } as const)
const B_OOB = Object.freeze({ ok: false, reason: 'out-of-bounds' } as const)
const B_TERRAIN = Object.freeze({ ok: false, reason: 'terrain' } as const)
const B_TREE = Object.freeze({ ok: false, reason: 'tree' } as const)
const B_ROAD = Object.freeze({ ok: false, reason: 'road' } as const)
const B_SPACING = Object.freeze({ ok: false, reason: 'spacing' } as const)
const B_BUILDING = Object.freeze({ ok: false, reason: 'building' } as const)
const B_CAPACITY = Object.freeze({ ok: false, reason: 'capacity' } as const)
```

Replace every `return { ok: … }` in both functions with the matching singleton. **`canPlaceHouse` has six returns and `canPlaceDestination` has eight; change all fourteen.** No reason string, no rejection order and no branch structure changes.

- [ ] **Step 5: Rewrite the cell loops without the array, keeping the prologue**

Replace `allSevenCells` and the three 7-cell loops in `canPlaceDestination` with an explicit box walk plus the carpark, **preserving the rejection order exactly** (`out-of-bounds`, `terrain`, `tree`, `road`, `spacing`, `building`, `capacity`) **and preserving the prologue** — `validateOrientation(orientation)` followed by `inBounds(destCell, world.cells)` is the only `Number.isInteger` check on `destCell` in the codebase and it must stay the first two statements:

```ts
  validateOrientation(orientation)
  if (!inBounds(destCell, world.cells)) return B_OOB

  const width = footprintWidth(orientation)
  const height = footprintHeight(orientation)
  const x0 = destCell % world.w
  const y0 = (destCell / world.w) | 0
  if (x0 < 0 || x0 + width > world.w || y0 < 0 || y0 + height > world.h) return B_OOB
  const carpark = carparkCell(destCell, orientation, world.w, world.h)
  if (carpark === -1) return B_OOB

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (world.passable[(y0 + dy) * world.w + (x0 + dx)] !== 1) return B_TERRAIN
    }
  }
  if (world.passable[carpark] !== 1) return B_TERRAIN
```

and likewise for the tree and road passes, then the spacing pass over `spacingViolated`, then the existing house-overlap and capacity checks.

- [ ] **Step 6: Run the whole `sim` suite**

Run: `pnpm -r --no-bail --filter './packages/sim' test`
Expected: PASS with **every pre-existing `canPlaceDestination` and `canPlaceHouse` test unchanged and untouched.** If any of them needed editing, the rewrite changed behaviour and is wrong. Note that `PlaceCheck` is compared by `.ok` and `.reason` everywhere, never by identity, so returning a shared object is invisible to every existing assertion — **which is exactly why it needs its own measurement in Step 7 and its own mutation row in Step 9.**

- [ ] **Step 7: Measure per-call allocation, before and after, on the demo board**

`packages/game/test/demoAllocation.test.ts` is the harness that sees this — it profiles `sim` on a board with 18 destinations and 12 houses, where `attemptHouseSpawn`'s scan will run every 60 ticks forever (Task 5). Run it five times before this task and five times after, and record `buildings.ts`'s per-frame figure as **a range over five draws, never a point** — this instrument has produced 109.20 and 119.00 in one report and 50.60 on a re-run.

Expected after: below `NOISE_FLOOR_BYTES_PER_FRAME` = 4 in every draw.

**Prove the harness can see this file before believing the green**, by injecting an escaping allocation into `canPlaceDestination`'s spacing loop specifically:

```ts
      ;(globalThis as { __sink?: unknown }).__sink = { d, ax0, ay0 }
```

`const __sink = {…}; void __sink` is deleted by V8's scalar replacement and reads exactly like a blind harness. Remove the injection before proceeding.

- [ ] **Step 8: Diff the test-block count, not the line count**

```bash
git diff HEAD -- packages/sim/test/buildings.test.ts | grep -cE '^-\s*(it|describe)\('
git diff HEAD -- packages/sim/test/buildings.test.ts | grep -cE '^\+\s*(it|describe)\('
```

Expected: 0 removed, 1 added. A file that grows in lines says nothing about coverage — eleven pre-existing tests once left this repo inside a commit whose stat line read `337 insertions, 240 deletions`. Diff the **names**, not the counts, if the numbers disagree.

- [ ] **Step 9: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `boxChebyshev`: `gx > gy ? gx : gy` → `gx < gy ? gx : gy` | the exhaustive equivalence test |
| `spacingViolated`: drop the footprint-vs-**incumbent-carpark** pair only | the equivalence test (this is the asymmetric half that survived once before) |
| `spacingViolated`: drop the **candidate-carpark**-vs-footprint pair only | as above, separately |
| `footprintWidth`: swap the N/S and E/W shapes | the equivalence test and the existing orientation tests |
| `< 2` → `< 1` in `spacingViolated` | the equivalence test and the existing spacing test |
| `x0 + width > world.w` → `>= ` | the existing out-of-bounds tests |
| Delete the `validateOrientation` prologue | the existing invalid-orientation test — **check it exists; if it does not, this task adds it** |
| **Replace `B_TERRAIN` with a fresh `{ ok: false, reason: 'terrain' }` literal at one site** | `demoAllocation.test.ts` — and nothing else, because no existing test compares by identity. If it stays green, Step 7's measurement is not live and the fix is unproven |
| **Same, in `canPlaceHouse`** | as above, separately — mutate the two functions separately, a compound being caught does not mean each half is |

Mutate the four box-pair lines **separately**: a compound being caught does not mean each half is.

- [ ] **Step 10: Commit**

```bash
git add packages/sim/src/buildings.ts packages/sim/test/buildings.test.ts packages/game/test/demoAllocation.test.ts
git commit -m "$(cat <<'EOF'
refactor(sim): building placement validity stops allocating, both halves

Two allocations, not one. `allSevenCells` returned a fresh array for the
candidate AND one per existing destination: the cell checks become a box walk
and the §5.9 spacing rule becomes four box-pair Chebyshev comparisons. And the
`{ ok, reason }` result literal ESCAPES — both predicates are too large to
inline — so both now return module-scope frozen singletons, exactly as
canPlaceRoad has since M1d for the same measured reason.

canPlaceHouse gets the same treatment: Task 5 introduces a third call shape
(attemptHouseSpawn's direct loop) that neither prior measurement covered.

Signature, return type, rejection order and every failure reason unchanged, and
every pre-existing test is untouched. The rewrite carries an exhaustive
equivalence proof against the retired pairwise implementation, labelled at its
site as a migration artefact rather than as coverage. No existing test compares
a PlaceCheck by identity, so the singleton change has demoAllocation as its
only detector and a mutation row that says so.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** nothing. This is the enabling refactor for Task 5 and a player cannot tell it happened. Stated rather than dressed up.

---

## Task 5: The spawn phase — the city grows

**Files:**
- Create: `packages/sim/src/spawn.ts`, `packages/sim/test/spawn.test.ts`
- Modify: `packages/sim/src/step.ts` (phase 4), `packages/sim/src/demand.ts` (`pushBlockedSpawnDemand`, `hasEligibleDestinationOfColour`), `packages/sim/src/index.ts`, `packages/shared/src/constants.ts`
- Test, all of which this task PREDICTS will move — see Step 13: `packages/sim/test/determinism.test.ts` (re-bless + timer assertions), `packages/sim/test/step.test.ts`, `packages/sim/test/demand.test.ts`, `packages/game/test/integration.test.ts`, `packages/game/test/frame.test.ts`, `packages/game/test/demoLayout.test.ts`, `packages/game/test/demoAllocation.test.ts`, `packages/game/test/allocation.test.ts`, `packages/game/test/drawAllocation.test.ts`, `packages/game/test/jamFixture.ts`

**Interfaces:**
- Consumes: `H_DEST_SPAWN_TIMER`, `H_SPAWN_COLOUR_CURSOR`, `houseSpawnTimer` (Task 1); `footprintWidth`/`footprintHeight`, allocation-free `canPlaceDestination`/`canPlaceHouse` (Task 4); `placeHouse(state, world, cell, colour): boolean` and `placeDestination(state, world, destCell, orientation, colour, kind): boolean` (existing).
- Produces: `runSpawn(state: GameState, world: WorldData, scratch: Scratch): void`; `SpawnOutcome` (a frozen code object) and `SpawnOutcomeCode`; `attemptDestinationSpawn(state, world, scratch): SpawnOutcomeCode`; `attemptHouseSpawn(state, world, colour): boolean`; `spawnZoneW(w: number): number`, `spawnZoneH(h: number): number`, `spawnZoneCells(world: WorldData): number`, `spawnZoneCellAt(zoneIndex: number, world: WorldData): number`, `inSpawnZone(cell: number, world: WorldData): boolean`, `spawnScanStart(state: GameState, zoneCells: number): number`, `colourUnlocked(state: GameState, colour: number, week: number): boolean`, `houseCountOfColour(state, colour): number`, `destCountOfColour(state, colour): number`; and from `demand.ts`, `hasEligibleDestinationOfColour(state, colour, tick): boolean` and `pushBlockedSpawnDemand(state: GameState, colour: number, scratch: Scratch): void`; `CT_BLOCKED_PUSH_DISCARDED = 2` in `scratch.ts`.
- **Deliberately NOT produced:** `spawnZoneX0()` / `spawnZoneY0()`. The first draft listed both and no code in it consumed either; `REVEALED_X0`/`REVEALED_Y0` are already exported from `shared` and a second name for the same constant is a second thing to keep in sync.

- [ ] **Step 1: Write the failing zone tests, including the empty case**

`packages/sim/test/spawn.test.ts`:

```ts
  it('clips the revealed rect to the board, and answers zero cells when they do not intersect', () => {
    // `determinism.test.ts` runs on a 4x4 map and the rect starts at x = 5, so
    // an unclipped zone would index cells that do not exist. An unguarded
    // `% 0` in the scan start yields NaN, and a NaN index into a typed array
    // is a SILENT no-op — the quietest failure available.
    const tiny = createWorld(testMap(4, 4))
    expect(spawnZoneW(tiny.w)).toBe(0)
    expect(spawnZoneH(tiny.h)).toBe(0)
    expect(spawnZoneCells(tiny)).toBe(0)

    // 20x9 is Task 6's demand-golden shape and it must clip to nothing on the
    // Y axis alone, with a non-zero width — the two bounds are separate code
    // and a fixture that zeroes both cannot tell them apart.
    const flat = createWorld(testMap(20, 9))
    expect(spawnZoneW(flat.w)).toBe(REVEALED_W)
    expect(spawnZoneH(flat.h)).toBe(0)
    expect(spawnZoneCells(flat)).toBe(0)

    const loopish = createWorld(testMap(20, 12))
    expect(spawnZoneW(loopish.w)).toBe(REVEALED_W) // 5 + 14 = 19 <= 20
    expect(spawnZoneH(loopish.h)).toBe(3)          // 9 + 22 = 31 clipped to 12
    expect(spawnZoneCells(loopish)).toBe(REVEALED_W * 3)

    const full = createWorld(firstCity())
    expect(spawnZoneCells(full)).toBe(REVEALED_W * REVEALED_H)
  })

  it('maps every zone index to a distinct in-zone cell and back', () => {
    const world = createWorld(firstCity())
    const seen = new Set<number>()
    for (let i = 0; i < spawnZoneCells(world); i++) {
      const cell = spawnZoneCellAt(i, world)
      expect(inSpawnZone(cell, world), `zone index ${i} -> cell ${cell}`).toBe(true)
      seen.add(cell)
    }
    expect(seen.size).toBe(spawnZoneCells(world))
    // The far corner is load-bearing: a fixture whose content sits in the
    // top-left corner cannot see a shrunk end bound.
    expect(seen.has((REVEALED_Y0 + REVEALED_H - 1) * world.w + REVEALED_X0 + REVEALED_W - 1)).toBe(true)
    expect(inSpawnZone(0, world), 'cell 0 is outside the rect').toBe(false)
  })

  it('varies the scan start by seed and by tick, and consumes no RNG draw', () => {
    const a = createState('seed-a', firstCity())
    const b = createState('seed-b', firstCity())
    const world = createWorld(firstCity())
    const cells = spawnZoneCells(world)
    expect(spawnScanStart(a, cells)).not.toBe(spawnScanStart(b, cells))
    const before = a.rng[0] as number
    a.header[H_TICK] = 1
    const first = spawnScanStart(a, cells)
    a.header[H_TICK] = 2
    expect(spawnScanStart(a, cells)).not.toBe(first)
    expect(a.rng[0], 'the scan start must not advance the RNG').toBe(before)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -r --no-bail --filter './packages/sim' test -- spawn`
Expected: FAIL with `spawnZoneW is not defined`.

- [ ] **Step 3: Add the spawning constants**

In `packages/shared/src/constants.ts`, extending the block Task 1 opened:

```ts
/** §5.9's "20 s retry on a failed destination", converted here and nowhere else. */
export const DEST_SPAWN_RETRY_TICKS = 20 * TICKS_PER_SECOND
/** §5.9's "2 s cooldown on a failed house spawn". */
export const HOUSE_SPAWN_RETRY_TICKS = 2 * TICKS_PER_SECOND
/**
 * How many houses a colour may hold per same-colour destination [OURS]. House
 * growth follows destination growth rather than the clock: without this,
 * `firstCity`'s `maxHouses` of 40 fills in about 80 seconds at one attempt per
 * colour per `HOUSE_SPAWN_PERIOD_TICKS`.
 *
 * **This constant times `CARS_PER_HOUSE` is the fleet-per-destination ratio,
 * and plan Decision 2 shows it is the term that decides whether the demand ramp
 * can ever bite.** At 2 it is four cars per destination at every week, so the
 * fleet grows exactly in step with demand and only the round trip can close the
 * gap. Task 10's gate measures that ratio; do not change this number without
 * re-running it.
 */
export const HOUSES_PER_DESTINATION = 2
/** §5.9's "future houses of a neighbourhood spawn within ~2 tiles of an existing same-colour house". */
export const HOUSE_NEIGHBOURHOOD_RADIUS = 2
/**
 * Cells examined per spawn attempt [OURS]. Unbounded scanning is up to 308
 * cells x 4 orientations x `canPlaceDestination` inside one tick, which is a
 * frame-dropping spike on a phone however cheap the predicate is.
 *
 * **Note what bounding it does NOT do.** The first draft claimed it "makes
 * §5.3.5's blocked-spawn redistribution reachable rather than theoretical". It
 * does the opposite of what §5.3.5 asks: a bounded window missing is not "no
 * cell will take one anywhere", and pushing on it fires the redistribution at
 * the retry cadence rather than the schedule's. `SpawnOutcome` separates the
 * two and only the board-wide refusal pushes.
 */
export const SPAWN_CANDIDATE_LIMIT = 24
```

**Note what is deliberately absent**: §5.9's *"ignore spawn weights after 5 consecutive failures"*. There are no spawn weights. Do not add the constant.

- [ ] **Step 4: Write the zone helpers**

`packages/sim/src/spawn.ts`, opening with the module comment that owns the third index arithmetic:

```ts
/**
 * The spawn phase — phase 4 of the tick order. Houses and destinations appear
 * over time, inside the revealed rect, on an authored schedule (spec §5.9).
 *
 * **This module carries the codebase's THIRD index arithmetic and it must not
 * be confused with the other two.** `index = y * w + x` is the cell index;
 * `slot = cell * 2 + lane` is the occupancy slot; and `zoneIndex = zy *
 * spawnZoneW + zx` is a position inside the clipped revealed rect. This file
 * is the only place that converts between the first and the third, through
 * `spawnZoneCellAt`, and no other module may index the zone.
 *
 * **Why `sim` reads `REVEALED_*` at all.** Nothing may spawn where the player
 * cannot see it, and the rect is the only description of what is visible. The
 * import is legal (`sim` depends on `shared`) and it makes `constants.ts`'s
 * claim that "nothing in `sim` reads these" false — that comment moves in the
 * same commit. When board expansion lands (M1f) the rect becomes state and the
 * zone must move with it; this file is the one place that changes.
 *
 * **The rect is CLIPPED to the world, and the clipped zone may be empty.**
 * `determinism.test.ts` runs on a 4x4 map, which the rect misses entirely, and
 * Task 6's demand golden runs on a 20x9 one, which misses it on Y alone. Every
 * entry point therefore tests the cell count before any modulo: `% 0` is NaN,
 * and a NaN index into a typed array is a silent no-op.
 *
 * **A destination spawn costs `groupCount` flow-field rebuilds, not one.** See
 * plan Decision 6: `destCell` and `destMeta` are both FIELD_INPUT and the
 * staleness stamp is one global byte hash, so placing any destination
 * invalidates every colour. Priced and accepted; counted in Task 12 Step 4.
 */
export function spawnZoneW(w: number): number {
  const x1 = REVEALED_X0 + REVEALED_W < w ? REVEALED_X0 + REVEALED_W : w
  return x1 > REVEALED_X0 ? x1 - REVEALED_X0 : 0
}

export function spawnZoneH(h: number): number {
  const y1 = REVEALED_Y0 + REVEALED_H < h ? REVEALED_Y0 + REVEALED_H : h
  return y1 > REVEALED_Y0 ? y1 - REVEALED_Y0 : 0
}

export function spawnZoneCells(world: WorldData): number {
  return spawnZoneW(world.w) * spawnZoneH(world.h)
}

export function spawnZoneCellAt(zoneIndex: number, world: WorldData): number {
  const zw = spawnZoneW(world.w)
  const zx = zoneIndex % zw
  const zy = (zoneIndex / zw) | 0
  return (REVEALED_Y0 + zy) * world.w + (REVEALED_X0 + zx)
}

export function inSpawnZone(cell: number, world: WorldData): boolean {
  const x = cell % world.w
  const y = (cell / world.w) | 0
  return (
    x >= REVEALED_X0 && x < REVEALED_X0 + spawnZoneW(world.w) &&
    y >= REVEALED_Y0 && y < REVEALED_Y0 + spawnZoneH(world.h)
  )
}

/**
 * Where this attempt starts scanning the zone.
 *
 * Reads the RNG word WITHOUT advancing it, deliberately. It must vary by seed
 * (or `RUN_SEED` means nothing and every run spawns identically) and by tick
 * (or the board fills from the top-left corner) — but a spawner that consumed
 * a draw on every failed attempt would couple every downstream draw to how
 * many times a spawn failed. That is still deterministic and it makes every
 * hand-computed fixture in the suite hostage to the spawner's failure count.
 *
 * The caller has already established `zoneCells > 0`.
 */
export function spawnScanStart(state: GameState, zoneCells: number): number {
  return (((state.rng[0] as number) >>> 0) + (state.header[H_TICK] as number)) % zoneCells
}
```

- [ ] **Step 5: Write the failing colour-eligibility tests**

```ts
  it('unlocks a colour at its week OR the moment the map has already seeded it', () => {
    // **The first draft's RED and GREEN contradicted each other here.** Its
    // table asserted `colourUnlocked(1, 0) === true` "because firstCity seeds
    // colours 0 and 1", and its implementation was `return week >= colour`,
    // which is `0 >= 1` = false. The seeder and the rule disagreed about when
    // a colour exists, and the one-character repair (`week + 1 >= colour`)
    // unlocks colours 2, 3 and 4 a WEEK EARLY and shifts every measurement in
    // Task 10 with nothing to catch it.
    //
    // The rule adopted instead is "already on the board OR the week has come",
    // which is what `firstCity`'s seeded colour-1 pair implies and which is
    // robust to any future map's seed rather than to this one's.
    const empty = createState('unlock-empty', testMap(4, 4))   // no seeded buildings
    expect(colourUnlocked(empty, 0, 0)).toBe(true)
    expect(colourUnlocked(empty, 1, 0), 'nothing seeded, week 0: not yet').toBe(false)
    expect(colourUnlocked(empty, 1, 1)).toBe(true)
    expect(colourUnlocked(empty, 2, 1)).toBe(false)
    expect(colourUnlocked(empty, 2, 2)).toBe(true)
    expect(colourUnlocked(empty, 4, 4)).toBe(true)

    // The seeded clause, on the real board and named by colour and week — this
    // is the assertion the mutation table below targets specifically.
    const city = seededCityState()
    expect(colourUnlocked(city, 1, 0), 'firstCity seeds a colour-1 pair at week 0').toBe(true)
    expect(colourUnlocked(city, 2, 0), 'colour 2 is not seeded and week 0 has not reached it').toBe(false)
  })

  it('founds a colour with no destination, and then caps it at two houses per destination', () => {
    // The deadlock this exemption exists to break: the cap refuses a colour
    // with zero destinations, and a destination refuses a colour with zero
    // houses. Without the founding exemption colours 2, 3 and 4 of `firstCity`
    // never appear at all, silently, for the whole run.
    const r = rig('found')
    const c = 2
    r.state.header[H_WEEK] = 2
    expect(houseCountOfColour(r.state, c)).toBe(0)
    expect(destCountOfColour(r.state, c)).toBe(0)
    expect(attemptHouseSpawn(r.state, r.world, c), 'the FIRST house is exempt').toBe(true)
    expect(houseCountOfColour(r.state, c)).toBe(1)
    expect(attemptHouseSpawn(r.state, r.world, c), 'the second is not, with no destination').toBe(false)
  })
```

- [ ] **Step 6: Write the spawners, with the refusal reason in the return type**

```ts
/**
 * Why a destination-spawn attempt did not place one. **The reason is in the
 * return value and not in a boolean**, because §5.3.5's redistribution fires on
 * exactly one of these and the first draft fired it on all of them.
 *
 * `SCAN_EXHAUSTED` and `BOARD_FULL` are the pair that matters. §5.3.5 says the
 * push happens "when no new destination can be placed ANYWHERE"; a
 * `SPAWN_CANDIDATE_LIMIT`-bounded window over a 308-cell zone missing is not
 * that, and treating it as that fires the redistribution at the 600-tick retry
 * cadence — 7.5 pushes a week against a schedule of `DESTINATIONS_PER_WEEK` = 2.
 */
export const SpawnOutcome = Object.freeze({
  /** A destination was placed. */
  PLACED: 1,
  /** No colour is both unlocked and already holding a house. */
  NO_ELIGIBLE_COLOUR: 2,
  /** The clipped revealed rect has no cells on this map. */
  ZONE_EMPTY: 3,
  /** The bounded scan window found nothing. The board may still have room elsewhere. */
  SCAN_EXHAUSTED: 4,
  /** Nothing will fit ANYWHERE: `H_DEST_COUNT` is at `maxDestinations`, or the scan covered the whole zone. */
  BOARD_FULL: 5,
} as const)
export type SpawnOutcomeCode = (typeof SpawnOutcome)[keyof typeof SpawnOutcome]

/**
 * A colour may receive buildings once the map has already seeded one for it, OR
 * once `H_WEEK` reaches its index [OURS].
 *
 * **The seeded clause is not a convenience.** `firstCity` seeds a colour-1
 * house and a colour-1 destination at tick 0 (`startingCity.ts`), so a pure
 * `week >= colour` rule says colour 1 does not exist for the first two and a
 * half minutes of a run in which the player can already see it and drive cars
 * to it. Making the rule read the board instead of only the clock is also what
 * makes it correct for any future map, rather than for this one.
 */
export function colourUnlocked(state: GameState, colour: number, week: number): boolean {
  if (week >= colour) return true
  return houseCountOfColour(state, colour) > 0 || destCountOfColour(state, colour) > 0
}

/**
 * One house-spawn attempt for `colour`. Returns whether a house was placed.
 *
 * **The founding exemption is load-bearing, not a convenience.** §5.9's "within
 * ~2 tiles of an existing same-colour house" cannot place the first one, and
 * the `HOUSES_PER_DESTINATION` cap refuses a colour with no destination —
 * while `attemptDestinationSpawn` refuses a colour with no house. Those three
 * rules together deadlock every colour that starts empty, which on `firstCity`
 * is colours 2, 3 and 4 out of 5. So a colour's FIRST house is exempt from both
 * the radius rule and the cap, and may go anywhere legal in the zone.
 *
 * **The `maxHouses` short-circuit is explicit, and that is a measured fix.** On
 * `demoCity` a colour holds 4 houses against 6 destinations, so `houses >=
 * dests * HOUSES_PER_DESTINATION` is `4 >= 12` — FALSE — and without the line
 * below every colour runs a full 24-cell scan every retry period forever on a
 * board that has been at `maxHouses` since tick 0, failing only at
 * `placeHouse`'s own capacity check 24 calls later.
 */
export function attemptHouseSpawn(state: GameState, world: WorldData, colour: number): boolean {
  const week = state.header[H_WEEK] as number
  if (!colourUnlocked(state, colour, week)) return false
  if ((state.header[H_HOUSE_COUNT] as number) >= world.map.maxHouses) return false
  const zoneCells = spawnZoneCells(world)
  if (zoneCells <= 0) return false
  const houses = houseCountOfColour(state, colour)
  if (houses > 0 && houses >= destCountOfColour(state, colour) * HOUSES_PER_DESTINATION) return false

  const start = spawnScanStart(state, zoneCells)
  const limit = SPAWN_CANDIDATE_LIMIT < zoneCells ? SPAWN_CANDIDATE_LIMIT : zoneCells
  for (let k = 0; k < limit; k++) {
    const cell = spawnZoneCellAt((start + k) % zoneCells, world)
    if (houses > 0 && !nearSameColourHouse(state, world, cell, colour)) continue
    if (placeHouse(state, world, cell, colour)) return true
  }
  return false
}

/**
 * One destination-spawn attempt.
 *
 * The colour is round-robin over eligible colours from `H_SPAWN_COLOUR_CURSOR`
 * — deterministic, balanced across colours, and no RNG draw. Eligible means
 * unlocked AND already holding at least one house: a destination whose colour
 * has no house accumulates pins no car can ever serve, which under Task 7 is a
 * guaranteed loss the player could not have prevented.
 *
 * **The cursor advances on FAILURE as well as on success**, which the first
 * draft did not do — it wrote the cursor inside `if (placeDestination(...))`.
 * Once a board saturates there is never another success, so the selection loop
 * returns the same colour forever and 100 % of §5.3.5's redistribution lands on
 * one frozen neighbourhood. Measured on the demo board: every pushed pin went
 * to colour 0. A failed attempt still consumed a turn.
 *
 * Every spawned destination is a `DEST_KIND_SQUARE`. The circle is §5.2's
 * in-place upgrade and M1f owns it — which matters more than it looks, because
 * a circle carries TWO rotation slots and a trigger cap of 8, so it is the only
 * mechanism in the spec that raises one destination's demand without adding a
 * destination (plan Decision 2).
 */
export function attemptDestinationSpawn(state: GameState, world: WorldData, scratch: Scratch): SpawnOutcomeCode {
  const groupCount = state.pinAccum.length
  const week = state.header[H_WEEK] as number
  const cursor = state.header[H_SPAWN_COLOUR_CURSOR] as number
  let colour = -1
  for (let k = 0; k < groupCount; k++) {
    const c = (cursor + k) % groupCount
    if (colourUnlocked(state, c, week) && houseCountOfColour(state, c) > 0) { colour = c; break }
  }
  if (colour === -1) return SpawnOutcome.NO_ELIGIBLE_COLOUR

  // Advanced here, once, on EVERY attempt that chose a colour — before any
  // early return below can skip it.
  state.header[H_SPAWN_COLOUR_CURSOR] = (colour + 1) % groupCount

  const zoneCells = spawnZoneCells(world)
  if (zoneCells <= 0) return SpawnOutcome.ZONE_EMPTY
  if ((state.header[H_DEST_COUNT] as number) >= world.map.maxDestinations) {
    pushBlockedSpawnDemand(state, colour, scratch)
    return SpawnOutcome.BOARD_FULL
  }

  const start = spawnScanStart(state, zoneCells)
  const limit = SPAWN_CANDIDATE_LIMIT < zoneCells ? SPAWN_CANDIDATE_LIMIT : zoneCells
  for (let k = 0; k < limit; k++) {
    const zoneIndex = (start + k) % zoneCells
    const cell = spawnZoneCellAt(zoneIndex, world)
    for (let o = 0; o < ORIENTATION_COUNT; o++) {
      // Rotated by the zone index so the board does not fill with
      // north-facing carparks: the orientation decides which side the driveway
      // is on, which is most of whether a destination is servable at all.
      const orientation = (zoneIndex + o) % ORIENTATION_COUNT
      if (!destinationFitsSpawnZone(cell, orientation, world)) continue
      if (placeDestination(state, world, cell, orientation, colour, DEST_KIND_SQUARE)) {
        return SpawnOutcome.PLACED
      }
    }
  }
  // A full-zone scan that found nothing IS "nowhere on the board", so it counts
  // as full. A bounded one is not, and does not.
  if (limit >= zoneCells) {
    pushBlockedSpawnDemand(state, colour, scratch)
    return SpawnOutcome.BOARD_FULL
  }
  return SpawnOutcome.SCAN_EXHAUSTED
}

/**
 * All seven cells of a candidate destination lie inside the clipped zone.
 *
 * `canPlaceDestination` checks the GRID, which is not the same thing: a 3-wide
 * footprint whose origin is one cell inside the rect's right edge is legal
 * board state and half-invisible, and `canvas.ts` culls a building by its
 * ANCHOR cell, so the visible half would not be drawn either.
 */
function destinationFitsSpawnZone(destCell: number, orientation: number, world: WorldData): boolean {
  const x0 = destCell % world.w
  const y0 = (destCell / world.w) | 0
  const x1 = x0 + footprintWidth(orientation) - 1
  const y1 = y0 + footprintHeight(orientation) - 1
  // **This guard comes FIRST and it is not defensive.** The far-corner check
  // below composes `y1 * world.w + x1` into a cell index, and for an origin
  // near the right edge `x1 >= world.w` wraps into the NEXT ROW — which may be
  // a perfectly legal in-zone cell, so `inSpawnZone` would answer `true` about
  // a footprint that leaves the board. It is the row-seam class, in the one
  // place this milestone composes an index from two independently-derived
  // coordinates. Found by an implementer transcribing this function, not by a
  // test.
  if (x1 >= world.w || y1 >= world.h) return false
  const carpark = carparkCell(destCell, orientation, world.w, world.h)
  if (carpark === -1) return false
  return (
    inSpawnZone(destCell, world) &&
    inSpawnZone(y1 * world.w + x1, world) &&
    inSpawnZone(carpark, world)
  )
}
```

Add a test for that guard specifically, on a fixture whose right-edge origin wraps to an in-zone cell — `destinationFitsSpawnZone` must answer `false` where the naive composition answers `true`, and the mutation table below carries the row.

`nearSameColourHouse` is a `HOUSE_NEIGHBOURHOOD_RADIUS` Chebyshev test against every same-colour house, and `houseCountOfColour`/`destCountOfColour` are indexed scans over the live prefixes. All three are allocation-free.

- [ ] **Step 7: Write `runSpawn` and wire phase 4**

```ts
/**
 * Phase 4 of the tick order. Countdown timers, not last-spawn stamps: a
 * countdown resets to a different value on success and on failure, which is
 * exactly what §5.9's separate interval and retry constants describe.
 *
 * **A full board resets to the SCHEDULE, not to the retry.** §5.9's 20 s retry
 * is for "this attempt missed, try again soon"; a board at `maxDestinations` is
 * not going to become un-full in 20 seconds, and resetting to the retry there
 * makes §5.3.5's redistribution fire every 600 ticks — 7.5 pushes a week
 * against a schedule of two. One line, and the push rate then matches
 * `DESTINATIONS_PER_WEEK` by construction rather than by a second accumulator.
 *
 * **Position.** AFTER phase 3, because "nothing ever spawns on an existing road
 * tile" must see the road the player laid this tick — that is the entire basis
 * of spawn-blocking, which §5.9 calls a major skill expression that must not be
 * accidentally optimised away. BEFORE phase 5, so a destination placed on tick
 * T is inside `H_DEST_COUNT` for tick T's rotation. It reads `H_TICK`
 * (through `placeDestination`'s `destSpawnTick` stamp) and `H_WEEK` (colour
 * unlocks), so its position against phase 1 is an off-by-one with a detector.
 */
export function runSpawn(state: GameState, world: WorldData, scratch: Scratch): void {
  const dt = (state.header[H_DEST_SPAWN_TIMER] as number) - 1
  if (dt > 0) {
    state.header[H_DEST_SPAWN_TIMER] = dt
  } else {
    const outcome = attemptDestinationSpawn(state, world, scratch)
    state.header[H_DEST_SPAWN_TIMER] =
      outcome === SpawnOutcome.PLACED || outcome === SpawnOutcome.BOARD_FULL
        ? DEST_SPAWN_PERIOD_TICKS
        : DEST_SPAWN_RETRY_TICKS
  }
  const groupCount = state.houseSpawnTimer.length
  for (let c = 0; c < groupCount; c++) {
    const ht = (state.houseSpawnTimer[c] as number) - 1
    if (ht > 0) {
      state.houseSpawnTimer[c] = ht
      continue
    }
    state.houseSpawnTimer[c] = attemptHouseSpawn(state, world, c)
      ? HOUSE_SPAWN_PERIOD_TICKS
      : HOUSE_SPAWN_RETRY_TICKS
  }
}
```

`state.houseSpawnTimer.length` and `state.pinAccum.length` are two spellings of `groupCount` in one file; **use `state.pinAccum.length` in `attemptDestinationSpawn` and `state.houseSpawnTimer.length` in `runSpawn` only if they are the same region length by declaration — they are, both `groupCount` — and say so once in the module comment rather than leaving a reader to check.**

Call `runSpawn(s, world, scratch)` in `step` between the input loop and `runDemand`, and extend the phase table to nine entries.

- [ ] **Step 8: Add blocked-spawn redistribution to `demand.ts`**

```ts
/** True iff any destination of `colour` has cleared its first-pin delay as of `tick`. */
export function hasEligibleDestinationOfColour(state: GameState, colour: number, tick: number): boolean {
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) if (isEligibleOfColour(state, d, colour, tick)) return true
  return false
}

/**
 * Spec §5.3.5: a destination that could not be placed ANYWHERE pushes its
 * scheduled demand into the existing destinations of its colour instead.
 *
 * Routed through `fireColour`, so it inherits overflow redistribution and the
 * `H_PINS_DROPPED` fallback for free rather than reimplementing either. The
 * guard is required, not defensive: `fireColour` THROWS when no eligible
 * destination of the colour exists, and a colour whose only destinations are
 * inside their 4 s first-pin delay is an ordinary, reachable state.
 *
 * **`fireColour` also advances `rotationCursor[colour]` (demand.ts:247), so a
 * blocked-spawn pin perturbs the SCHEDULE as well as the count** — it
 * permanently changes which destination of that colour is next in line for
 * every subsequent scheduled pin. That is not a bug: a pushed pin is a pin, and
 * it should take its turn like one. It is written down because the first draft
 * of this plan asserted that a saturated board was inert under this function,
 * and the count is only one of the two things it moves.
 *
 * Called from the SPAWN phase, which runs before the field sync, so the
 * `destPins` write it may produce is still ahead of phase 6 exactly as
 * `runDemand`'s is.
 */
export function pushBlockedSpawnDemand(state: GameState, colour: number, scratch: Scratch): void {
  const tick = state.header[H_TICK] as number
  if (!hasEligibleDestinationOfColour(state, colour, tick)) {
    // **Counted, because a silent discard here already hid a dead rule for
    // twenty-eight weeks.** Measured over 40 weeks on `firstCity` with the
    // 20-tile opening and the cursor frozen as the first draft wrote it, 232 of
    // 259 pushes landed on colour 4 — which ends the run with a house and NO
    // destination, so this guard swallowed every one of them and §5.3.5
    // delivered literally nothing from week 12 onward. Nothing said so. The
    // counter lives in `scratch`, not in the state buffer, so no golden can see
    // it and it costs no bytes; Task 12's per-branch assertions read it.
    scratch.counters[CT_BLOCKED_PUSH_DISCARDED] =
      (scratch.counters[CT_BLOCKED_PUSH_DISCARDED] as number) + 1
    return
  }
  fireColour(state, colour, tick)
}
```

Add `CT_BLOCKED_PUSH_DISCARDED = 2` to `packages/sim/src/scratch.ts` beside `CT_SYNCS = 0` and `CT_REBUILDS = 1`, and widen the counters array by one. `runSpawn` therefore takes `scratch` as a third parameter and `step` passes it — a signature change stated here rather than discovered, and the only one this task makes.

- [ ] **Step 9: Write the phase-position and behaviour tests**

```ts
  it('will not spawn on a road the player laid this tick', () => {
    // The detector for transposing phases 3 and 4 — the pair that was inert
    // when it was "inputs vs demand" and is not inert now. The fixture paves
    // the ONLY cell the scan can reach on this tick, so the two orderings
    // differ by exactly one destination.
    const r = rig('spawn-after-inputs')
    armDestinationTimerForNextTick(r.state)
    const before = r.state.header[H_DEST_COUNT] as number
    step(r.state, r.world, r.fields, r.scratch, { actions: pavingActionsOverScanWindow(r) })
    expect(r.state.header[H_DEST_COUNT], 'a paved cell must refuse a destination').toBe(before)
  })

  it('stamps destSpawnTick from THIS tick, not the previous one', () => {
    // The detector for transposing phases 1 and 4: the off-by-one the M1d
    // handoff warned about, in every destination's first-pin delay at once.
    const r = rig('spawn-stamp')
    armDestinationTimerForNextTick(r.state)
    const tickBefore = r.state.header[H_TICK] as number
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    const d = (r.state.header[H_DEST_COUNT] as number) - 1
    expect(r.state.destSpawnTick[d]).toBe(tickBefore + 1)
  })

  it('pushes a pin only when NOTHING will fit anywhere, not when the window missed', () => {
    // The two arms are the whole point of `SpawnOutcome`, and they must be
    // separable: a bounded scan missing on a board with room is the ordinary
    // case and must be silent, or §5.3.5 fires at the retry cadence.
    const roomy = rig('scan-miss')          // room on the board, none in the window
    blockEveryCellInTheScanWindow(roomy)
    const before = sumPins(roomy.state) + (roomy.state.header[H_PINS_DROPPED] as number)
    expect(attemptDestinationSpawn(roomy.state, roomy.world, roomy.scratch)).toBe(SpawnOutcome.SCAN_EXHAUSTED)
    expect(sumPins(roomy.state) + (roomy.state.header[H_PINS_DROPPED] as number),
      'a missed window must not push').toBe(before)

    const full = rig('board-full')
    fillToMaxDestinations(full)
    const total = sumPins(full.state) + (full.state.header[H_PINS_DROPPED] as number)
    expect(attemptDestinationSpawn(full.state, full.world, full.scratch)).toBe(SpawnOutcome.BOARD_FULL)
    expect(sumPins(full.state) + (full.state.header[H_PINS_DROPPED] as number)).toBe(total + 1)
  })

  it('advances the colour cursor on a FAILED attempt too, so redistribution rotates', () => {
    // Without this, a saturated board pushes 100% of §5.3.5's demand into one
    // neighbourhood forever. Measured on the demo board before the fix: every
    // pushed pin went to colour 0.
    const full = rig('board-full-rotate')
    fillToMaxDestinations(full)
    const seen: number[] = []
    for (let i = 0; i < 6; i++) {
      const before = full.state.header[H_SPAWN_COLOUR_CURSOR] as number
      attemptDestinationSpawn(full.state, full.world, full.scratch)
      seen.push(before)
    }
    expect(new Set(seen).size, 'the cursor must visit more than one colour')
      .toBeGreaterThan(1)
  })

  it('a pushed pin moves the rotation cursor as well as the pin count', () => {
    // `fireColour` advances `rotationCursor[colour]`, so §5.3.5's push changes
    // whose turn is next. Asserted rather than discovered.
    const full = rig('board-full-rotation-cursor')
    fillToMaxDestinations(full)
    const before = full.state.rotationCursor[0] as number
    attemptDestinationSpawn(full.state, full.world, full.scratch)
    expect(full.state.rotationCursor[0]).not.toBe(before)
  })

  it('spawning a destination rebuilds EVERY colour\'s field, because the staleness stamp is a byte hash', () => {
    // **The first draft asserted the opposite and called it "Derived, and
    // asserted so the derivation cannot rot into an accident."** It was derived
    // from the wrong model. `FIELD_INPUT_REGIONS` (regions.ts:121) is
    // ['mapIdentity', 'destCell', 'roads', 'destMeta', 'destPins'] — `destCell`
    // AND `destMeta`, both written by `placeDestination` — and flowfield.ts:399
    // computes ONE global `fieldInputHash` and compares it against every
    // colour's `builtFromFieldInputs`. The stamp is a deliberately conservative
    // whole-region byte hash, not a semantic source-set question, so a
    // destination with no pin still invalidates all five colours. Measured on
    // `firstCity`: `expected 10 to be 5`.
    const r = rig('spawn-rebuild')
    armDestinationTimerForNextTick(r.state)
    const before = r.scratch.counters[CT_REBUILDS] as number
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(r.state.header[H_DEST_COUNT], 'vacuity: something must have spawned').toBeGreaterThan(0)
    expect(r.scratch.counters[CT_REBUILDS], 'one per colour, not one').toBe(before + r.world.map.groupCount)
    // A HOUSE is not a field input: houseCell and houseColour are both
    // FIELD_IRRELEVANT, so this is the negative half of the same claim.
    const beforeHouse = r.scratch.counters[CT_REBUILDS] as number
    armHouseTimerForNextTick(r.state, 0)
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(r.state.header[H_HOUSE_COUNT], 'vacuity: a house must have spawned').toBeGreaterThan(0)
    expect(r.scratch.counters[CT_REBUILDS], 'a house rebuilds nothing').toBe(beforeHouse)
  })
```

- [ ] **Step 10: Assert what the demo board actually does under the spawner — including the parts that move**

**This step replaces the first draft's inertness test, which asserted `H_HOUSE_COUNT` and `H_DEST_COUNT` on a board that is at both caps from tick 0 — the only two quantities on it that cannot move.** That test passes while every claim around it is false, and it is the M1d shape verbatim.

Measured facts this test is built on, all reproduced in Step 12: the demo board is at 12/12 houses and 18/18 destinations from tick 0 and there are **zero** legal destination placements in its spawn zone; the house spawner is therefore a genuine no-op (`H_HOUSE_COUNT >= maxHouses` short-circuits it, Step 6); and the **destination spawner is not** — it returns `BOARD_FULL` and pushes a pin every `DEST_SPAWN_PERIOD_TICKS`.

In `packages/game/test/demoLayout.test.ts`:

```ts
  it('adds no BUILDING, and pushes exactly the scheduled demand it could not place', () => {
    // Against a spawner-free control, because "nothing changed" is only
    // meaningful against something that would have changed. The quantities
    // asserted are the ones that CAN move: H_PINS_DROPPED, the pin total, the
    // rotation cursors and the whole-buffer digest.
    const map = demoCity()
    const live = seededDemo()
    const control = seededDemo({ spawner: false })
    // The window is capped BELOW this board's death tick with the margin
    // stated: it dies at 6,703 under Tasks 7+8 (Decision 7), and a frozen sim
    // is byte-identical from tick to tick, so a longer window would assert
    // over a corpse. 5,000 leaves 1,703 ticks (25 %) of margin.
    const WINDOW = 5000
    for (let i = 0; i < WINDOW; i++) {
      step(live.state, live.world, live.fields, live.scratch, NO_INPUT)
      step(control.state, control.world, control.fields, control.scratch, NO_INPUT)
    }
    expect(isGameOver(live.state), 'this window must not reach the shutdown').toBe(false)

    // The buildings genuinely cannot move — but this is the SECONDARY check,
    // not the test.
    expect(live.state.header[H_HOUSE_COUNT]).toBe(map.maxHouses)
    expect(live.state.header[H_DEST_COUNT]).toBe(map.maxDestinations)

    // The primary check: exactly the scheduled pushes, and nothing else.
    // Attempts land at DEST_SPAWN_PERIOD_TICKS and every period after, so the
    // count is derivable rather than observed.
    const expectedPushes = Math.floor(WINDOW / DEST_SPAWN_PERIOD_TICKS)
    expect(expectedPushes, 'vacuity: the window must contain at least two').toBeGreaterThanOrEqual(2)
    expect(totalPins(live.state) + (live.state.header[H_PINS_DROPPED] as number))
      .toBe(totalPins(control.state) + (control.state.header[H_PINS_DROPPED] as number) + expectedPushes)
    // And the pushes rotate rather than all landing on one colour.
    expect(new Set(pushedColours(live)).size).toBeGreaterThan(1)
    // The digest differs, and that is the honest statement: this board is NOT
    // inert under M1e. It is unchanged in its buildings and moved by exactly
    // its own unplaceable schedule.
    expect(hashState(live.state)).not.toBe(hashState(control.state))
  })
```

- [ ] **Step 11: Re-bless the state golden with its timer assertions beside it**

The `determinism.test.ts` fixture is 4×4, so its clipped zone is empty and **no building is placed and no colour is ever chosen** — `attemptDestinationSpawn` returns `ZONE_EMPTY` after the cursor write, and `attemptHouseSpawn` returns before the scan. Hand-compute and assert each moved slot before the digest:

```ts
    // M1e Task 5 moves this number, and the plan said so in advance. This
    // fixture's clipped spawn zone is EMPTY (4x4 board against a rect at
    // x >= 5), so no building is placed and the ONLY bytes that moved are the
    // spawn timers and the colour cursor. Hand-computed and asserted, so the
    // digest is not the only evidence: the destination timer is armed at 2,250,
    // fires and fails at tick 2,250, and re-fires every DEST_SPAWN_RETRY_TICKS
    // = 600 ticks after that (ZONE_EMPTY is not BOARD_FULL, so it takes the
    // retry); the last attempt at or before tick 13,499 is 13,050, so 13,499
    // finds it at 600 - (13,499 - 13,050) = 151.
    expect(s.header[H_DEST_COUNT], 'an empty zone places nothing').toBe(0)
    expect(s.header[H_HOUSE_COUNT]).toBe(0)
    expect(s.header[H_DEST_SPAWN_TIMER]).toBe(151)
    // The cursor is written before the ZONE_EMPTY return, but only when a
    // colour was chosen — and a colour needs a house, of which this board has
    // none. So it must NOT have moved, and that is a real assertion rather
    // than a restatement of zero.
    expect(s.header[H_SPAWN_COLOUR_CURSOR], 'no colour is eligible with no houses').toBe(0)
    for (let c = 0; c < GOLDEN_MAP.groupCount; c++) {
      // Hand-computed: the first attempt is at tick 300 and every failure
      // takes HOUSE_SPAWN_RETRY_TICKS = 60, so the last attempt at or before
      // 13,499 is 13,440 and the timer reads 60 - (13,499 - 13,440) = **1**.
      expect(s.houseSpawnTimer[c], `colour ${c}`).toBe(1)
    }
```

Re-derive the house figure from `HOUSE_SPAWN_PERIOD_TICKS` = 300 and `HOUSE_SPAWN_RETRY_TICKS` = 60 rather than copying it; if the arithmetic disagrees with the run, the arithmetic is the thing to fix.

- [ ] **Step 12: Contain `jamFixture`, and say which of the two containments you chose**

`packages/game/test/jamFixture.ts` is `parseMap('jam-rig', rows, 9999, 16, 4, 2)` on a 16×20 board — **maxHouses 16, maxDestinations 4, and `destCount` 1 after the build.** Its clipped spawn zone is 11 × 11 = **121 cells** with **261 legal `(cell, orientation)` destination placements over 89 distinct cells**, so a 24-cell scan cannot miss. Measured, with the spawner live: destinations spawn at ticks **2,250 / 4,500 / 6,750**, `destCount` then hits 4, and every later attempt returns `BOARD_FULL` and pushes a pin at the schedule cadence. Houses spawn too, at **4,500** and **6,780** (colour 1's founding house at its week-1 unlock, then its second once colour 1 has a destination); colour 0 never spawns one, because 8 ≥ `destCountOfColour(0) × 2`.

This fixture's job is `integration.test.ts:1843`'s 20,000-tick invariant sweep, which Task 12 extends to 25,000. **Choose one containment and write down which:**

- **(a) Let it spawn and re-derive.** The invariant sweep then exercises the spawner over a long horizon, which is coverage this milestone otherwise has nowhere. Cost: re-derive its four exact assertions (`valves 98`, `minCompletions 2`, `maxReserved 24`, `maxBlocked`) and state old → new for each.
- **(b) Bring `maxDestinations` and `maxHouses` down to the built counts** so both spawners short-circuit on capacity. Cost: the long-horizon sweep never sees a spawn, **and it still is not inert** — a `BOARD_FULL` result pushes a pin at the schedule cadence, so the four figures move anyway, by less.

**Take (a).** (b) buys a smaller re-derivation and gives up the only long-horizon invariant coverage the spawner will ever get, and it does not even buy inertness. Record the four old → new values in the commit message.

- [ ] **Step 13: The blast radius, enumerated with a prediction for every entry**

**The first draft's Step 14 reasoned only about goldens, and the measured failing set was six files.** The rule is: enumerate **every fixture that steps a map intersecting the clipped `REVEALED_*` rect past tick 300** — the first house attempt — not the goldens, and not the warm starts.

Write the prediction **before** running, one line each, then run and record the outcome beside it:

| Site | Prediction |
|---|---|
| `integration.test.ts` `runTrip` (records ticks 259–435) | **MOVES.** The first draft's safety argument reasoned about where this test *warms* (258), not where it *runs*. Colour 0 holds 2 houses against 2 destinations, so the cap does not bind: measured on `RUN_SEED='laneways-m2'`, **house 3 spawns at tick 360 at (6,14) and house 4 at tick 660 at (5,13)**, and `LIVE_CAR_SLOTS` goes **6 → 8**. Re-derive `frames.length` (177), `DISPATCH_TICK` (378) and `SCORE_TICK` (435) rather than assuming they hold. |
| `integration.test.ts:1020`, `:1095`, `:1133`, `:1473` | **MOVES.** All live past tick 300; `:1095` carries `SEED_FIRST_PIN_TICK` 378. Re-derive each. |
| `integration.test.ts:1843` (the 20,000-tick jam sweep) | **MOVES**, per Step 12(a). Re-derive `valves`, `minCompletions`, `maxReserved`, `maxBlocked`. |
| `frame.test.ts:1020` *"never changes a car slot's liveness inside step"* | **FAILS, and the failure is correct.** A spawned house creates `CARS_PER_HOUSE` cars inside `step`, which is exactly what this test forbids. It must be **re-derived, not deleted**: the property it was pinning is real for the interpolator (`resolve.ts`'s rule 1 handles `prevLive === 0` by snapping, and `resolve.test.ts` exercises it by direct call). Restate it as "liveness only ever grows, and only in the spawn phase", and assert the snap. |
| `demoLayout.test.ts` erase tests | **MOVES.** A pushed pin changes the board state the erase tests read: measured, suppressing only `pushBlockedSpawnDemand` turns the file from red to 26/26 green, and the injected pin breaks *'erasing three corridor cells… deletes them outright at the first frame'* with `cell 392: expected 3 to be +0`. Re-derive against the new cadence — with the corrected schedule the first push is at tick 2,250, not 600, so several of these may now be clear of it. |
| `demoLayout.test.ts:556` (`firstCity` 3,000-tick vacuity arm) | **MOVES.** It drives the city board 3,000 ticks from tick 0, past the first house attempt at 300. Its assertions are `toBe(0)` on refusals, valves and blocked ticks and `<= 1` on the longest queue; a spawned house adds two cars with no road, so they may hold — **check, do not assume.** |
| `demoAllocation.test.ts` | **MOVES** in figures and must be re-measured over five draws. Its final window ends at tick **6,459**; see Task 8 Step 6 for the margin guard. |
| `allocation.test.ts`, `drawAllocation.test.ts` | **PREDICTED to move** in figures. Both were in the measured failing set. Re-measure as ranges over five draws, and if either does **not** move, say so and say why — an unexplained non-move is as much a finding as a move. |
| `startingCity.test.ts` | **UNCHANGED.** Its golden is hashed pre-tick and it drives nothing past 258. One review lens named it and was refuted; do not "fix" it. |
| `loop.test.ts` (both existing goldens) | **UNCHANGED.** 150 and 130 ticks, both below 300. |
| `cars.test.ts` (multiplier golden) | **UNCHANGED.** 110 ticks. |
| `determinism.test.ts` | **MOVES**, by Step 11, and only in the three timer families and the cursor. |

- [ ] **Step 14: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: the state golden moved and **only** the state golden. Every other change is a re-derived non-golden figure named in Step 13. **If a file moves that Step 13 does not name, stop and report** — that is the whole point of writing the table first.

- [ ] **Step 15: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `spawnZoneW`: drop the clip to `w` | the 4×4 zone test; the state golden |
| `spawnZoneH`: drop the clip to `h` | the 20×9 zone test — **mutate the two axes separately** |
| `spawnScanStart`: drop the `zoneCells <= 0` guard at both call sites | the 4×4 attempt tests (NaN index, silent no-op) |
| `spawnScanStart`: use `nextRandom` instead of reading `rng[0]` | the "consumes no draw" assertion |
| `spawnScanStart`: drop the `H_TICK` term | the per-tick variation assertion |
| `colourUnlocked`: drop the `week >= colour` clause | the unlock table at colour 2, week 2 |
| `colourUnlocked`: **drop the already-seeded clause** | the seeded assertion, naming **colour 1 at week 0** on `firstCity` — mutate the two clauses **separately** |
| Drop the founding exemption (`houses > 0 &&` on the cap) | the founding test |
| Drop the founding exemption on the radius rule only | the founding test — separately |
| Drop `attemptHouseSpawn`'s `maxHouses` short-circuit | no behavioural detector (`placeHouse` refuses anyway) — **`demoAllocation.test.ts` is the only detector, via 24 wasted `canPlaceHouse` calls per retry period.** If it does not fire, record the mutant as surviving and say so |
| `attemptDestinationSpawn`: drop the `houseCountOfColour > 0` filter | a colour with no house accumulates pins; assert it in the eligibility test |
| `attemptDestinationSpawn`: advance the cursor only on success | the cursor-rotation test |
| `attemptDestinationSpawn`: push on `SCAN_EXHAUSTED` too | the "only when nothing will fit anywhere" test, first arm |
| `runSpawn`: reset to `DEST_SPAWN_RETRY_TICKS` on `BOARD_FULL` | Step 10's `expectedPushes` count (3.75× too many) |
| `destinationFitsSpawnZone`: check the origin only | the far-corner assertion in the zone test |
| `destinationFitsSpawnZone`: drop the `x1 >= world.w \|\| y1 >= world.h` guard | the row-seam test — a right-edge origin whose `y1 * w + x1` wraps into an in-zone cell on the next row |
| `pushBlockedSpawnDemand`: drop the `CT_BLOCKED_PUSH_DISCARDED` increment | the discarded-push assertion, on a fixture whose colour has a house and no eligible destination — **write that fixture; without it this counter is a decoration that reads as defence** |
| Move phase 4 before phase 3 | Step 9's paving test |
| Move phase 4 before phase 1 | Step 9's `destSpawnTick` test |
| Drop `pushBlockedSpawnDemand` entirely | Step 9's board-full arm; Step 10's push count |
| `pushBlockedSpawnDemand`: drop the `hasEligibleDestinationOfColour` guard | a colour inside its first-pin delay throws from `fireColour` — **this is a CRASH, not an assertion failure; record it as such rather than as a kill**, and add a test that calls it in that state and expects no throw |

- [ ] **Step 16: Commit**

```bash
git add packages/sim/src/spawn.ts packages/sim/src/step.ts packages/sim/src/demand.ts packages/sim/src/index.ts packages/shared/src/constants.ts packages/sim/test packages/game/test
git commit -F - <<'EOF'
feat(sim): the city grows — phase 4 of nine

Houses and destinations spawn inside the clipped revealed rect on an authored
schedule (§5.9): two destinations a week, houses capped at two per same-colour
destination, and a colour's first house exempt from both the radius rule and
the cap so a colour that starts empty is not deadlocked.

A colour is unlocked once the map has ALREADY SEEDED one for it or once H_WEEK
reaches its index. The seeded clause is required, not decorative: firstCity
seeds a colour-1 pair at tick 0, so a pure `week >= colour` rule denies the
existence of a colour the player can already see.

§5.3.5's redistribution fires on a BOARD-WIDE refusal only. The refusal reason
is in the return type (SpawnOutcome), because a SPAWN_CANDIDATE_LIMIT-bounded
window missing over a 308-cell zone is not "no cell will take one anywhere" —
pushing on it fires the redistribution 3.75x more often than the schedule. A
full board also resets the timer to the SCHEDULE rather than the 20 s retry, so
the push rate equals DESTINATIONS_PER_WEEK by construction. The colour cursor
advances on failure as well as success, or a saturated board dumps 100 % of the
redistribution into one frozen neighbourhood forever.

Spawning is a PHASE and not a TickAction, so M1d's remaining inherited
0-detector transposition stays inert for the same single reason — and the
insertion gives the clock reader two more positions that now have detectors.

Recorded rather than assumed: a destination spawn rebuilds EVERY colour's flow
field (destCell and destMeta are both FIELD_INPUT and the staleness stamp is
one global byte hash), and a pushed pin advances rotationCursor as well as
destPins. The demo board is NOT inert under this: it adds no building, and it
pushes exactly its own unplaceable schedule, asserted against a spawner-free
control over a window capped 25 % below that board's shutdown tick.

Blast radius predicted before running and recorded per site: integration.test
(runTrip, four inner sites, the 20,000-tick jam sweep), frame.test's liveness
property, demoLayout's erase tests and its firstCity arm, and three allocation
harnesses. jamFixture is left free to spawn and its four exact figures
re-derived, because that sweep is the only long-horizon invariant coverage the
spawner gets.

State golden re-blessed (<old> -> <new>): its 4x4 board clips the zone to
empty, so no building is placed and only the spawn timers moved — each one
hand-computed and asserted beside the digest.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
```

**Observability:** on the demo board — still the default until Task 10 — **nothing a player sees**, and that is the honest answer rather than a disappointment: the board is at both caps from tick 0, so no building appears, and the only change is a handful of extra pin dots over four minutes that nobody can attribute. **The first draft placed the default-board flip in this task and claimed "the board is different every time they look up"; that claim now belongs to Task 10 and cannot be made until Task 10's gate has been measured.** The visible half of this task ships with the flip, and separating them is what lets the flip be refused on evidence.

---

## Task 6: The weekly demand ramp, and the golden nobody has ever had over demand-produced pins

**Files:**
- Modify: `packages/sim/src/demand.ts` (`spawnScale`, `pinPeriodForWeek`, `advanceAccumulators`, the module comment's one-fire invariant), `packages/shared/src/constants.ts`
- Test: `packages/sim/test/demand.test.ts`, `packages/sim/test/loop.test.ts` (a **new** golden), `packages/game/test/demoLayout.test.ts` (**three stale prose references corrected; no measured figure moves**)

**Interfaces:**
- Consumes: `H_WEEK` (existing), `PIN_PERIOD_TICKS`, `DENOM`.
- Produces: `spawnScale(week: number): number`, `pinPeriodForWeek(week: number): number`, and constants `SPAWN_SCALE_BASE = 1000`, `SPAWN_SCALE_PER_WEEK = 110`, `SPAWN_SCALE_MAX = 3000`.

Decision 3 in full: **the ramp scales the PERIOD, not the accumulator**, so week 0 is byte-identical to today and no golden fixture inside week 0 can move.

- [ ] **Step 1: Write the failing ramp tests**

```ts
  it('is the spec ramp at DENOM, one-based in the spec and zero-based in H_WEEK', () => {
    // §5.3: spawnScale(w) = 1.0 + 0.11 * (w - 1), capped at 3.0, with w
    // ONE-based. `H_WEEK` is zero-based, so w = H_WEEK + 1 and the +0.11 term
    // multiplies H_WEEK directly. Off-by-one here scales week 0 to 1.11x and
    // every measured figure in the repo inherits it.
    expect(spawnScale(0)).toBe(SPAWN_SCALE_BASE)
    expect(spawnScale(1)).toBe(1110)
    expect(spawnScale(5)).toBe(1550)
    expect(spawnScale(18)).toBe(2980)
    expect(spawnScale(19), 'the cap first binds here, not at 18').toBe(SPAWN_SCALE_MAX)
    expect(spawnScale(200)).toBe(SPAWN_SCALE_MAX)
  })

  it('week 0 leaves the pin period EXACTLY at PIN_PERIOD_TICKS', () => {
    // This is what makes the ramp golden-neutral: every golden fixture in the
    // repo runs inside week 0 (the longest is 13,499 ticks with no
    // destinations), so an implementation that scaled the accumulator instead
    // would move three of them for nothing.
    expect(pinPeriodForWeek(0)).toBe(PIN_PERIOD_TICKS)
    expect(pinPeriodForWeek(1)).toBe(466)
    expect(pinPeriodForWeek(19)).toBe(172)
  })

  it('fires exactly ONCE on a week boundary and leaves no backlog behind it', () => {
    // The one-fire invariant SURVIVES the ramp, and the first draft of this
    // plan weakened it when it should have extended it. That draft asserted
    // `fires <= 3` from `floor((maxPeriod - 1) / minPeriod)` = floor(517/172) —
    // which pairs week 0's period with week 19's, and `H_WEEK` cannot cross 19
    // boundaries in one tick.
    //
    // The real bound is over ADJACENT weeks. The largest adjacent drop is
    // 0 -> 1: 518 - 466 = 52, and every later drop is smaller. Carrying in at
    // most `P_w - 1` = 517 plus `slotCount <= 32` gives 549; one fire leaves
    // 549 - 466 = 83, far under 466. **So the bound is ONE, the same as every
    // other tick, and there is no backlog to drain.**
    //
    // Consequence, recorded rather than papered over: the `while`-drain mutant
    // this test was originally written to catch is an EQUIVALENT MUTANT — a
    // `while` that can never iterate twice is a `for`. `fires <= 3` is
    // satisfied by every implementation including that mutant, which is a test
    // that cannot fail wearing a bound's clothes.
    const { state, scratch } = accumulatorRig()          // slotCount(0) = 2
    state.header[H_WEEK] = 0
    state.pinAccum[0] = pinPeriodForWeek(0) - 1          // 517, maximal carry-in
    state.header[H_WEEK] = 1
    const fires: number[] = []
    for (let i = 0; i < 4; i++) {
      const before = sumPins(state)
      advanceAccumulators(state, scratch)
      fires.push(sumPins(state) - before)
    }
    expect(fires[0], 'the boundary tick fires once').toBe(1)
    expect(fires.slice(1), 'and there is nothing queued behind it').toEqual([0, 0, 0])
    // Vacuity: the carry must genuinely have survived the period change, or
    // this is a test about an accumulator that was reset.
    expect(state.pinAccum[0], 'the remainder carried').toBe(517 + 2 - 466 + 2 + 2 + 2)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -r --no-bail --filter './packages/sim' test -- demand`
Expected: FAIL with `spawnScale is not defined`.

- [ ] **Step 3: Add the constants**

```ts
// --- The weekly demand ramp (spec §5.3, [OURS]) ---
/**
 * `spawnScale(w) = 1.0 + 0.11 * (w - 1)`, capped at 3.0, at `DENOM`. Spec §5.3
 * calls this "the single most important tuning unknown in the project"; §13
 * lists it as an open risk and names the telemetry overlay as its mitigation.
 * Treat all three numbers as a starting point.
 *
 * **What this ramp does and does not do — see plan Decision 2.** It does not
 * raise the number of pins a destination can hold, and it does not add cars.
 * It shortens the interval between pins at one rotation slot from 518 ticks to
 * 172, so the round-trip time a connected destination can survive falls by the
 * same factor. That is the difficulty curve and it is measurable as a ratio;
 * Task 10's gate measures it. Reading this constant as "demand triples" without
 * the fleet term is how the first draft of this plan came to claim a difficulty
 * curve it could not observe.
 */
export const SPAWN_SCALE_BASE = 1000
export const SPAWN_SCALE_PER_WEEK = 110
export const SPAWN_SCALE_MAX = 3000
```

- [ ] **Step 4: Implement the two functions**

In `packages/sim/src/demand.ts`:

```ts
/**
 * §5.3's weekly demand ramp at `DENOM`. `H_WEEK` is zero-based and the spec's
 * `w` is one-based, so `1.0 + 0.11 * (w - 1)` is `SPAWN_SCALE_BASE +
 * SPAWN_SCALE_PER_WEEK * H_WEEK` with no adjustment — and week 0 is 1.0x, not
 * 1.11x. The cap first binds at `H_WEEK` 19: 1000 + 110*18 = 2,980 and
 * 1000 + 110*19 = 3,090.
 */
export function spawnScale(week: number): number {
  const s = SPAWN_SCALE_BASE + SPAWN_SCALE_PER_WEEK * week
  return s > SPAWN_SCALE_MAX ? SPAWN_SCALE_MAX : s
}

/**
 * The accumulator threshold for `week`.
 *
 * **The ramp scales the PERIOD and not the increment, and that choice is
 * load-bearing twice over.** Multiplying the increment by `scale / DENOM`
 * truncates once per TICK, which is the drift `acc -= period` exists to
 * prevent; scaling in `DENOM` units instead is exact but multiplies every
 * stored `pinAccum` by 1,000, which moves the loop, queue and multiplier
 * goldens behaviourally for no gameplay reason. Scaling the threshold
 * truncates once per WEEK, in a comparison rather than an accumulation, and at
 * week 0 it is `518000 / 1000` = 518 — bit-for-bit today's constant.
 */
export function pinPeriodForWeek(week: number): number {
  return ((PIN_PERIOD_TICKS * DENOM) / spawnScale(week)) | 0
}
```

and in `advanceAccumulators`, hoist the period once per call:

```ts
  const period = pinPeriodForWeek(state.header[H_WEEK] as number)
  for (let c = 0; c < groupCount; c++) {
    const slotCount = scratch.slotCounts[c] as number
    state.pinAccum[c] = (state.pinAccum[c] as number) + slotCount
    if ((state.pinAccum[c] as number) >= period) {
      state.pinAccum[c] = (state.pinAccum[c] as number) - period
      fireColour(state, c, tick)
    }
  }
```

- [ ] **Step 5: EXTEND the module comment's invariant rather than weakening it**

`demand.ts` claims *"at most one threshold crossing — one fire — happens per colour per tick: an invariant with its own bound"*, resting on `slotCount ≤ 32 < PIN_PERIOD_TICKS`. Under the ramp the smallest period is 172 and `32 < 172` still holds, so the tick-to-tick argument is intact. **Add the boundary case rather than replacing the claim:** a period reduction at a week boundary can leave `acc` above the new threshold, but the largest adjacent reduction is `518 − 466 = 52` and the carry-in is at most `P_w − 1`, so after one fire the residue is at most 83 against a threshold of 466. **The bound stays one.**

Record, in the same comment, that this makes the `while`-drain spelling an **equivalent mutant** — with the derivation, so nobody reaches for a `while` loop *and* nobody deletes the `if` on the strength of a survived mutation.

- [ ] **Step 6: Bless a NEW golden over demand-produced pins, on a fixture that CANNOT spawn**

This has been carried forward twice: *"No golden covers demand-produced pins. The loop golden's fixture pre-pins to keep `destPins` stable under assertion, so the pin timer is frozen."* Close it here, because the ramp is the first change that makes the pin timer's behaviour week-dependent.

Add a **second fixture in `loop.test.ts` with its own golden**, rather than editing the existing one — editing it would retire the four-route cost matrix its leading vacuity test protects, and would move the loop golden for a fourth time.

**The fixture's map is 20×9, and that is a requirement rather than a convenience.** `loop.test.ts`'s existing 20×12 map has a clipped spawn zone of 14×3 = 42 cells, so Task 5's spawner is live inside it: measured on that shape, a destination spawns at tick 2,250 and takes `slotCount(0)` from 2 to 3, which changes the pin cadence 1,250 ticks *before* the week boundary. `DG_EXPECTED_FIRE_TICKS` would then not be derivable from `pinPeriodForWeek(0)` and `(1)` at all, and a golden over a ladder nobody can derive is a digest with a story attached. `spawnZoneH(9)` is `min(9 + 22, 9) > 9 ? … : 0` = **0**, so a 20×9 board has an empty clipped zone and the spawner is structurally absent. **Assert that, do not assume it.**

```ts
  it('produces pins from the timer alone, across a week boundary, and pins the digest', () => {
    // The first fixture in the repo whose `destPins` are produced by
    // `runDemand` rather than written by the test. Carried forward from M1c
    // twice; the ramp is what finally makes it worth having, because the pin
    // cadence is now a function of the week.
    const r = demandGoldenRig()                       // 20x9 — see below
    // Posture, asserted BEFORE the run: this board cannot spawn, so the fire
    // ladder is a function of the two periods and nothing else.
    expect(spawnZoneCells(r.world), 'a 20x9 board clips the revealed rect to nothing').toBe(0)
    const destsBefore = r.state.header[H_DEST_COUNT] as number
    const housesBefore = r.state.header[H_HOUSE_COUNT] as number

    for (let i = 0; i < DG_RUN_TICKS; i++) step(r.state, r.world, r.fields, r.scratch, NO_INPUT)

    expect(r.state.header[H_DEST_COUNT], 'nothing spawned').toBe(destsBefore)
    expect(r.state.header[H_HOUSE_COUNT], 'nothing spawned').toBe(housesBefore)
    expect(isGameOver(r.state), 'and the sim is still live at the digest').toBe(false)
    // Vacuity: the timer must genuinely have fired, and it must have fired at
    // BOTH cadences, or this is a week-0 fixture wearing a ramp's name.
    expect(r.observed.fireTicks).toEqual(DG_EXPECTED_FIRE_TICKS)
    expect(r.observed.fireTicks.some((t) => t < TICKS_PER_WEEK)).toBe(true)
    expect(r.observed.fireTicks.some((t) => t >= TICKS_PER_WEEK)).toBe(true)
    // Blessed for the FIRST time here. This is a new number, not a re-bless:
    // the buffer shape settled in Task 1 and nothing after it moves the shape,
    // which is why a new golden can be blessed at all from Task 2 onward.
    expect(hashState(r.state)).toBe(/* new value */)
  })
```

`DG_EXPECTED_FIRE_TICKS` is derived from `pinPeriodForWeek(0)` = 518 and `(1)` = 466 against the fixture's `slotCount`, written out as an explicit ladder in the test file with the arithmetic beside it, and **re-derived rather than copied from the run** — if the arithmetic disagrees with the run, the arithmetic is the thing to fix first.

- [ ] **Step 7: Correct `demoLayout.test.ts`'s three stale references, and assert that nothing in it moves**

**The first draft of this plan ordered a re-measurement of a window that does not exist.** `demoLayout.test.ts`'s only measured window is `const TICKS = 3000` (`:503`) driven from tick 0 by `seededRig().drive(TICKS)` — `rigFor` does not warm-start. There is **no 900-tick window** and **no 20,000-tick window**: the "20,000-tick figures" are prose in comments at `:517`, `:537` and `:545` recording measurements taken in a review. `grep -c 20000 packages/game/test/demoLayout.test.ts` returns 0.

So the correct step is the opposite of a re-measurement:

- **Assert that no figure in that file moves under Task 6**, with the reason: 3,000 ticks from tick 0 is entirely inside week 0 (`TICKS_PER_WEEK` = 4,500), so `pinPeriodForWeek` returns 518 throughout and the ramp cannot reach it. Add `expect(pinPeriodForWeek(state.header[H_WEEK])).toBe(PIN_PERIOD_TICKS)` at the end of the drive so a future window extension fails here rather than silently re-measuring.
- **Correct the three prose references** at `:517`, `:537`, `:545` to say that those figures were measured in a review over a window this file does not drive, and give each the window it was actually taken over. A figure quoted without its window is the shape that produced 3,483/1,563 in this same file and cost a milestone's worth of confusion.
- **Do not touch the measured figures**, and do not write a commit message claiming they were re-measured. The first draft's supplied message — *"demoLayout's 20,000-tick figures re-measured… its 3,000- and 900-tick figures asserted unchanged"* — would have been a false git record naming two windows that have never existed.

The demo board's figures **do** move in this milestone, in **Task 5**, from the blocked-spawn push. That re-measurement lands there, with its cause, and is re-confirmed after Task 8.

- [ ] **Step 8: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS, **with no golden moved and one new golden blessed.** The state golden's fixture has no destinations, so `slotCounts` are 0, `pinAccum` never advances and no fire can occur however the period is scaled. If it moves, the ramp reached somewhere this plan says it cannot.

- [ ] **Step 9: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `spawnScale`: `* week` → `* (week - 1)` | the scale table, at week 0 |
| `spawnScale`: drop the cap | the scale table at week 200 |
| `spawnScale`: cap at `>=` instead of `>` | nothing — **record as an equivalent mutant**, since 3,000 is not reachable except through the cap |
| `pinPeriodForWeek`: `* DENOM` dropped | week-0 test (period 0, then a fire every tick) |
| `advanceAccumulators`: `acc = 0` instead of `acc -= period` | the boundary test's carry assertion and the new golden |
| Hoist `period` outside the per-tick call and cache it for the run | the new golden (the second cadence never arrives) |
| `>= period` → `> period` | the new golden's fire ladder, by exact tick |
| `if` → `while` in the fire branch | nothing — **record as an equivalent mutant with Step 5's derivation**, because the residue after one fire is provably under the threshold |
| The demand-golden fixture's map 20×9 → 20×12 | the `spawnZoneCells === 0` posture assertion, and the fire ladder |

- [ ] **Step 10: Commit**

```bash
git add packages/sim/src/demand.ts packages/shared/src/constants.ts packages/sim/test packages/game/test/demoLayout.test.ts
git commit -m "$(cat <<'EOF'
feat(sim): demand ramps weekly, by shrinking the period rather than scaling the accumulator

spawnScale(w) = 1.0 + 0.11*(w-1) capped at 3.0 (§5.3), applied to the
accumulator's THRESHOLD. Week 0 is 518 ticks, bit-for-bit today's constant, so
no golden fixture — all of which run inside week 0 — moves.

The one-fire invariant is EXTENDED, not weakened. The largest adjacent period
drop is 518 -> 466, so a maximal carry-in plus slotCount leaves 83 against a
threshold of 466 after one fire: the bound stays one and there is no backlog.
The `while`-drain spelling is therefore an equivalent mutant, recorded as one
with its derivation rather than guarded by a `<= 3` that every implementation
satisfies.

Closes a gap carried forward twice: a new golden over pins produced by the timer
rather than written by the test, across a week boundary so both cadences are
exercised. Its fixture is 20x9 so the clipped revealed rect is EMPTY and Task
5's spawner is structurally absent — on the 20x12 shape a destination spawns at
tick 2,250 and moves slotCount, and the fire ladder stops being derivable.

demoLayout.test.ts: no measured figure moves. Its only window is 3,000 ticks
from tick 0, entirely inside week 0, and that is now asserted rather than
observed. Three stale prose references to a 20,000-tick window this file does
not drive are corrected and given the window they were actually measured over.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability: nothing a player can attribute to this task, and saying otherwise would be the same class of claim as "the demo board is inert."** The first draft's line — *"a player who has kept up for five minutes finds that the same road network stops coping"* — is satisfied by a build in which this task is **entirely absent**: at five minutes the board is at week 2 and `spawnScale` is 1.22×, while Task 5 has already added destinations and houses to the same board and grown `slotCount` directly. Delete Task 6 and that sentence still passes.

The honest statement is that **the ramp's effect is confounded with the spawner's for the whole of M1e and a player cannot separate them.** What the ramp actually does is measurable and it is a ratio rather than a sight: it lowers the round trip a connected destination can survive by up to 3×, and Task 10's gate measures `meanT / (4 · pinPeriodForWeek(week))` per week. **On this board that ratio runs 0.029 at week 0 to 0.059 at week 11 and misses 1 by 12–34×**, so the honest thing to say is that the ramp is correctly implemented, measurably real — on a 41-cell corridor it is the entire difference between surviving 60,000 ticks and dying at week 9 (Decision 2) — and **cannot be seen on the board that ships.** Turning it off changes the no-input death tick by 1.0 %, and changes peak `destPins`, longest queue, refusals and blocked ticks by zero. It changes throughput: 2.2× more pins and 2.2× more trips by week 11. A player will see more cars; they will not see the network stop coping, and this line does not claim they will.

---

## Task 7: The overcrowd meter — the ramp, the unwind, the knockback, and the two boards' death ticks

**Files:**
- Create: `packages/sim/src/overcrowd.ts`, `packages/sim/test/overcrowd.test.ts`
- Modify: `packages/sim/src/step.ts` (phase 10), `packages/sim/src/trips.ts` (the arrival knockback), `packages/sim/src/index.ts`, `packages/shared/src/constants.ts`
- Test: `packages/sim/test/trips.test.ts`, `packages/shared/test/constants.test.ts`

**Interfaces:**
- Consumes: `destOvercrowd`, `destOverTicks` (Task 1); `destPins`, `destMeta`, `H_DEST_COUNT` (existing).
- Produces: `overcrowdTriggerCap(state: GameState, d: number): number`; **`isOverCapacity(state: GameState, d: number): boolean`** (written and mutation-tested in the first draft but absent from its Produces block); `overcrowdRampSpeed(overTicks: number): number`; `arrivalKnockback(meter: number): number`; `applyArrivalKnockback(state: GameState, d: number): void`; `runOvercrowd(state: GameState): void`; `assertOvercrowdNonNegative(value: number, d: number): void`. **`runOvercrowd` does not end the run — Task 8 adds that**, so this task's meter can saturate and nothing happens.

- [ ] **Step 1: Write the failing arithmetic tests, including the 3,390 derivation**

```ts
  it('ramps at min(1, 0.02t) in milli-ticks, reaching full at exactly 1,500 ticks', () => {
    expect(overcrowdRampSpeed(0)).toBe(0)
    expect(overcrowdRampSpeed(1), 'floor(2/3)').toBe(0)
    expect(overcrowdRampSpeed(3)).toBe(2)
    expect(overcrowdRampSpeed(OVERCROWD_RAMP_FULL_TICKS - 1)).toBe(999)
    expect(overcrowdRampSpeed(OVERCROWD_RAMP_FULL_TICKS)).toBe(DENOM)
    expect(overcrowdRampSpeed(OVERCROWD_RAMP_FULL_TICKS * 10), 'clamped, not linear').toBe(DENOM)
  })

  it('the ramp phase sums to exactly 750,000 milli-ticks, which is the spec\'s 25 s', () => {
    // Hand-derivable and worth deriving rather than measuring: writing
    // t = 3k + r, floor(2t/3) over each consecutive triple is
    // 2k + (2k+1) + (2k+2) = 6k + 3; t from 1 to 1,500 is 500 triples with
    // k = 0..499, so the sum is 6*(499*500/2) + 3*500 = 750,000.
    let sum = 0
    for (let t = 1; t <= OVERCROWD_RAMP_FULL_TICKS; t++) sum += overcrowdRampSpeed(t)
    expect(sum).toBe(750000)
  })

  it('fills on the 3,390th consecutive over-capacity tick and not the 3,389th', () => {
    // §5.8's "~113 s: 50 s ramping, then 65 s at full rate, minus 2 s hidden
    // grace" lands on an exact integer: 750,000 milli-ticks over the 1,500-tick
    // ramp, then (2,640,000 - 750,000) / 1,000 = 1,890 more at full rate.
    // 1,500 + 1,890 = 3,390 ticks = 113.0 s. The sharpest off-by-one detector
    // in this milestone, and Step 9's two board death ticks are derived from it.
    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
    for (let i = 0; i < 3389; i++) runOvercrowd(state)
    expect(state.destOvercrowd[0], 'one tick short').toBeLessThan(OVERCROWD_FAIL_MILLITICKS)
    runOvercrowd(state)
    expect(state.destOvercrowd[0]).toBeGreaterThanOrEqual(OVERCROWD_FAIL_MILLITICKS)
    expect(state.destOvercrowd[0]).toBe(OVERCROWD_FAIL_MILLITICKS)
  })

  it('triggers AT the capacity, not above it, and separately for a square and a circle', () => {
    // §5.8: "square triggers the timer at 6, hard cap 10; circle at 8, hard cap
    // 14." One function, so there is exactly one place a `>=` -> `>` mutation
    // can hide and exactly one place it is caught — the idiom `isEligible`
    // already uses in demand.ts.
    const sq = overcrowdRig({ kind: DEST_KIND_SQUARE, pins: PIN_CAP_SQUARE_TIMER - 1 })
    runOvercrowd(sq.state)
    expect(sq.state.destOverTicks[0], 'one below the square trigger').toBe(0)
    sq.state.destPins[0] = PIN_CAP_SQUARE_TIMER
    runOvercrowd(sq.state)
    expect(sq.state.destOverTicks[0]).toBe(1)

    const ci = overcrowdRig({ kind: DEST_KIND_CIRCLE, pins: PIN_CAP_SQUARE_TIMER })
    runOvercrowd(ci.state)
    expect(ci.state.destOverTicks[0], 'a circle is not over at a square\'s cap').toBe(0)
    ci.state.destPins[0] = PIN_CAP_CIRCLE_TIMER
    runOvercrowd(ci.state)
    expect(ci.state.destOverTicks[0]).toBe(1)
  })

  it('unwinds at 2x the full fill rate once back under capacity, and floors at zero', () => {
    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
    for (let i = 0; i < OVERCROWD_RAMP_FULL_TICKS + 100; i++) runOvercrowd(state)
    const peak = state.destOvercrowd[0] as number
    state.destPins[0] = 0
    runOvercrowd(state)
    expect(state.destOvercrowd[0]).toBe(peak - OVERCROWD_RETURN_MUL)
    expect(state.destOverTicks[0], 'the ramp resets, it does not merely pause').toBe(0)
    // `ceil(peak / OVERCROWD_RETURN_MUL) + 1` ticks, not `peak` ticks: the
    // first draft ran 850,000 iterations to prove a floor at 0, which is the
    // same assertion at 400x the cost.
    const need = Math.ceil(peak / OVERCROWD_RETURN_MUL) + 1
    for (let i = 0; i < need; i++) runOvercrowd(state)
    expect(state.destOvercrowd[0], 'floored, never negative').toBe(0)
  })

  it('saturates destOverTicks so no run length can overflow it', () => {
    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
    for (let i = 0; i < OVERCROWD_RAMP_FULL_TICKS * 3; i++) runOvercrowd(state)
    expect(state.destOverTicks[0]).toBe(OVERCROWD_RAMP_FULL_TICKS)
  })

  it('knocks 10% off on arrival, capped at 3 s, and reads destPins with no carpark immunity', () => {
    // §5.8: "There is no carpark immunity - a car metres from the bay does not
    // save you." So the meter reads `destPins`, NOT `destPins - destReserved`:
    // a reserved pin is still a customer waiting.
    expect(arrivalKnockback(0)).toBe(0)
    expect(arrivalKnockback(500000)).toBe(50000)
    // **900,000 is a 0-DETECTOR for the cap, and the first draft labelled it
    // "the cap binds exactly here".** ARRIVAL_KNOCKBACK_PCT is 100 over DENOM
    // 1000, so 900,000 * 100 / 1000 is exactly 90,000 and `>` and `>=` return
    // the same number there. Probe either side of it instead.
    expect(arrivalKnockback(899990), 'below the cap, uncapped').toBe(89999)
    expect(arrivalKnockback(910000), 'above it: 91,000 clamped to 90,000')
      .toBe(ARRIVAL_KNOCKBACK_MAX_MILLITICKS)
    expect(arrivalKnockback(OVERCROWD_FAIL_MILLITICKS)).toBe(ARRIVAL_KNOCKBACK_MAX_MILLITICKS)

    const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER, reserved: PIN_CAP_SQUARE_TIMER })
    runOvercrowd(state)
    expect(state.destOverTicks[0], 'a fully-reserved destination is still over capacity').toBe(1)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -r --no-bail --filter './packages/sim' test -- overcrowd`
Expected: FAIL with `overcrowdRampSpeed is not defined`.

- [ ] **Step 3: Add the derived constants**

```ts
// --- Overcrowd, in MILLI-TICKS (spec §5.8) ---
/**
 * A tick is 1000/30 ms, which is not an integer, so a millisecond-denominated
 * meter cannot be exact. The meter is denominated in ticks x `DENOM` —
 * milli-ticks — and every §5.8 constant converts once, here.
 *
 * **§5.8 is a FIVE-OF-EIGHT transcription of research dossier §1.10, and the
 * three that fell out fell out by transcription rather than by anyone's
 * decision.** The one that matters is `OvercrowdTimerCarArrivalDeceleration`
 * = 0.5; plan Decision 4 names it, measures what it would do, and hands it to
 * M1f with the reason. Do not add it here without reading that.
 */
export const OVERCROWD_FULL_MILLITICKS = (MAX_OVERCROWD_TIME_MS / MS_PER_SECOND) * TICKS_PER_SECOND * DENOM
export const OVERCROWD_GRACE_MILLITICKS = (OVERCROWD_GRACE_MS / MS_PER_SECOND) * TICKS_PER_SECOND * DENOM
/**
 * The meter value that ends the run: 90 s minus §5.8's 2 s "hidden grace at the
 * end", so 88 s = 2,640,000 milli-ticks. The RING is drawn against
 * `OVERCROWD_FULL_MILLITICKS`, which is what makes the grace hidden — it reads
 * 97.8 % at the instant the city dies.
 */
export const OVERCROWD_FAIL_MILLITICKS = OVERCROWD_FULL_MILLITICKS - OVERCROWD_GRACE_MILLITICKS
/**
 * Where §5.8's `s(t) = min(1, 0.02t)` reaches full: `1 / 0.02` = 50 s = 1,500
 * ticks. `destOverTicks` SATURATES here rather than growing without bound, so
 * no width question can arise at any run length — the construction
 * `carBlockedTicks` already uses against `MAX_BLOCKED_TICKS`. The saturation
 * ceiling and the ramp's full point are deliberately the SAME number: a ceiling
 * below it makes the ramp unreachable, one above it is bytes nothing reads.
 */
export const OVERCROWD_RAMP_FULL_TICKS = (DENOM / OVERCROWD_RAMP) * TICKS_PER_SECOND
export const ARRIVAL_KNOCKBACK_MAX_MILLITICKS =
  (ARRIVAL_KNOCKBACK_MAX_MS / MS_PER_SECOND) * TICKS_PER_SECOND * DENOM
```

Add to `packages/shared/test/constants.test.ts` a derivation test asserting `OVERCROWD_FULL_MILLITICKS` is 2,700,000, `OVERCROWD_FAIL_MILLITICKS` is 2,640,000 and `OVERCROWD_RAMP_FULL_TICKS` is 1,500 — the `ALL` registry already covers integrality and non-negativity for every numeric export automatically, so this adds the values, not the hygiene.

- [ ] **Step 4: Write `overcrowd.ts`**

```ts
/**
 * Per-destination overcrowd — spec §5.8, the milestone's whole reason for
 * existing. M1d made a badly-built city visibly jam; this is what makes that
 * cost the run.
 *
 * **Two quantities, because the ramp and the meter answer different questions.**
 * `destOverTicks[d]` is consecutive time at or over capacity and drives the
 * ramp; it resets the moment the destination is back under. `destOvercrowd[d]`
 * is the integrated meter, reduced by arrivals and by the unwind, and it alone
 * decides failure. One quantity cannot do both: a ramp derived from the meter
 * is zero at zero and never starts.
 *
 * **What this model can and cannot express, measured — read plan Decision 2
 * before tuning any of it.** Hold a destination at its cap and serve it one car
 * every P ticks: the meter's fixed point is `10,000 * P`, which exists only
 * below the 900,000 point where the 90,000 knockback cap binds. So **P <= 90
 * ticks survives forever and P > 90 dies, with nothing in between** — swept and
 * confirmed exactly at a 2,000,000-tick horizon (91 dies at 163,162; 92 at
 * 84,271). Neither shipped board is anywhere near that boundary: both die of a
 * destination that stops being served ENTIRELY, at P = infinity.
 *
 * **The meter reads `destPins`, not `destPins - destReserved`.** §5.8: "There
 * is no carpark immunity - a car metres from the bay does not save you. The
 * original deliberately omits it."
 *
 * **Both regions are `Int32Array`, so the `Uint8` wrap class does not apply —
 * and both decrements are still clamped at 0 with a named assertion**, because
 * a negative meter is a silent lie about how close the player is to losing, and
 * it would render as an empty ring on a destination that is about to kill them.
 */
export function overcrowdTriggerCap(state: GameState, d: number): number {
  return destMetaKind(state.destMeta[d] as number) === DEST_KIND_CIRCLE
    ? PIN_CAP_CIRCLE_TIMER
    : PIN_CAP_SQUARE_TIMER
}

/** True iff `d` is at or over the capacity that starts its timer. The ONE place §5.8's threshold is compared. */
export function isOverCapacity(state: GameState, d: number): boolean {
  return (state.destPins[d] as number) >= overcrowdTriggerCap(state, d)
}

/** §5.8's `s(t) = min(1, 0.02t)`, in milli-ticks per tick. */
export function overcrowdRampSpeed(overTicks: number): number {
  const s = ((OVERCROWD_RAMP * overTicks) / TICKS_PER_SECOND) | 0
  return s > DENOM ? DENOM : s
}

/** §5.8's "reduction on car arrival: 10% of current, clamped to [0 s, 3 s]". */
export function arrivalKnockback(meter: number): number {
  const k = ((meter * ARRIVAL_KNOCKBACK_PCT) / DENOM) | 0
  return k > ARRIVAL_KNOCKBACK_MAX_MILLITICKS ? ARRIVAL_KNOCKBACK_MAX_MILLITICKS : k
}

/**
 * Throws rather than storing a negative meter. Parameterised rather than
 * closing over `state`, on the precedent of `assertGhostCommittedPositive`
 * (roads.ts) and `assertArrivalHonoured` (trips.ts): the failure path is then
 * testable directly.
 */
export function assertOvercrowdNonNegative(value: number, d: number): void {
  if (value < 0) {
    throw new Error(
      `overcrowd: destination ${d} reached a meter of ${value} — the unwind and the arrival ` +
        'knockback are both floored at 0, so a negative meter is a broken invariant, not a game state',
    )
  }
}

export function applyArrivalKnockback(state: GameState, d: number): void {
  const m = state.destOvercrowd[d] as number
  const next = m - arrivalKnockback(m)
  assertOvercrowdNonNegative(next, d)
  state.destOvercrowd[d] = next
}

/** Phase 10 of the tick order. Task 8 gives it the power to end the run. */
export function runOvercrowd(state: GameState): void {
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    if (isOverCapacity(state, d)) {
      const over = state.destOverTicks[d] as number
      const next = over < OVERCROWD_RAMP_FULL_TICKS ? over + 1 : OVERCROWD_RAMP_FULL_TICKS
      state.destOverTicks[d] = next
      state.destOvercrowd[d] = (state.destOvercrowd[d] as number) + overcrowdRampSpeed(next)
    } else {
      state.destOverTicks[d] = 0
      const m = (state.destOvercrowd[d] as number) - OVERCROWD_RETURN_MUL
      state.destOvercrowd[d] = m > 0 ? m : 0
    }
  }
}
```

- [ ] **Step 5: MEASURE the survivability boundary by sweeping the arrival interval**

The whole failure model reduces to one number — how often a destination held at its cap must be served to survive — and until this plan's review nobody on the project had measured it. Derive it, sweep it, and put the measured boundary in the test's own comment.

```ts
  it('a destination at its cap survives iff it is served more often than every 90 ticks, and the cliff is sharp', () => {
    // The fixed point, derived: at cap the meter fills at DENOM/tick once the
    // ramp saturates, and every arrival removes `min(meter/10, 90,000)`, so the
    // fixed point is `M = 10,000 * P` — which exists only while it is under the
    // 900,000 point where the cap binds. **P <= 90 ticks (3 s) survives; P > 90
    // grows without bound.** There is NO MIDDLE, and plan Decision 2 is built
    // on that being true, so it is swept rather than asserted from the algebra
    // (integer truncation in three places can move an exact boundary).
    //
    // Measured at a 2,000,000-tick horizon: largest surviving P = 90; 91 dies
    // at tick 163,162 and 92 at 84,271. Note the shape of that — just past the
    // fixed point the meter grows very slowly, so a SHORT horizon reports a
    // softer boundary than the true one (at 40,000 ticks the sweep says 94).
    // That is why the horizon is stated in the constant and not chosen by feel.
    for (const period of SWEEP_PERIODS) {   // 30..600 step 10, plus 85..100 step 1
      const { state } = overcrowdRig({ pins: PIN_CAP_SQUARE_TIMER })
      let died = -1
      for (let t = 1; t <= SWEEP_HORIZON_TICKS && died < 0; t++) {
        runOvercrowd(state)
        if (t % period === 0) applyArrivalKnockback(state, 0)
        if ((state.destOvercrowd[0] as number) >= OVERCROWD_FAIL_MILLITICKS) died = t
      }
      observed.push({ period, died })
    }
    expect(largestSurviving(observed)).toBe(90)
    expect(smallestDying(observed)).toBe(91)
    // Vacuity on both sides: something must survive and something must die, or
    // the sweep covers one regime and proves nothing.
    expect(observed.some((o) => o.died < 0), 'something must survive').toBe(true)
    expect(observed.some((o) => o.died > 0), 'something must die').toBe(true)
  })
```

- [ ] **Step 6: Wire the knockback into arrivals and phase 10 into `step`**

In `trips.ts`'s `arriveAtDestination`, after the pin and reservation decrements:

```ts
  // §5.8's arrival knockback. Here and not in phase 10, because it is an EVENT
  // — one car arriving — and phase 10 is a per-tick integration. Placed after
  // the pin decrement so a destination that just dropped back under capacity
  // gets the knockback AND the unwind on the same tick, which is the whole
  // relief a player feels when a queue finally clears.
  applyArrivalKnockback(state, d)
```

`runArrivals(state)` keeps its one-parameter signature, which `trips.ts`'s module comment calls "the primary defence" — no `world`, no `fields`, no `scratch`. Add `runOvercrowd(s)` as the last call in `step`, after `runArrivals(s)`, and extend the phase table to ten entries.

- [ ] **Step 7: Pin phase 10's position**

```ts
  it('integrates the meter AFTER arrivals, so a serviced destination is not charged for the tick it cleared', () => {
    // The detector for transposing phases 9 and 10. The fixture is built so a
    // car arrives on the exact tick the destination would otherwise be at
    // capacity: with arrivals first the pin count drops below the trigger and
    // `destOverTicks` stays 0; with overcrowd first it charges a tick the
    // player had already earned back.
    const r = arrivalOnTheBrinkRig()
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(r.state.destPins[D_BRINK], 'vacuity: the arrival must have happened').toBe(PIN_CAP_SQUARE_TIMER - 1)
    expect(r.state.destOverTicks[D_BRINK]).toBe(0)
  })
```

- [ ] **Step 8: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS, **with no golden moved.** Derived, and then confirmed by instrumenting every pin fire across the whole suite rather than by reading: `determinism.test.ts`, `rollback.test.ts` and `cars.test.ts` fire **no pin at all**; sim `loop.test.ts` peaks at **1**; the two seed goldens are hashed pre-tick, so `destPins` is identically 0 at the hashed moment. **Note what that instrumentation also shows, because it is a live trap for a future task:** `startingCity.test.ts` reaches 2 and `demoLayout.test.ts` reaches **11** elsewhere in those *files*, and 11 is above the circle trigger cap of 8 — so a golden blessed over any *driven* window on the demo board would sit on a live meter. The suite-wide maximum is 14, in `demoAllocation.test.ts`, which holds no golden.

- [ ] **Step 9: Drive both shipped boards to their conclusion and RECORD the death ticks**

This is the step the first draft did not have, and its absence is what let five sites in that draft assert that the demo board was inert. **Nothing here changes code. It produces the numbers Decision 7, Task 8 Step 6, Task 10's gate and Task 12 Step 1 all depend on**, under the *shipped* boot path rather than a fixture.

For each of the two layouts — `demo` (`demoLayout.ts` + `demoCity`, `createState('laneways-demo')`, 1,200-tick warm start) and `city` (`startingCity.ts` + `firstCity`, `createState('laneways-m2')`, 258-tick warm start) — reproduce `createGame`'s exact sequence and drive 40,000 ticks with no player input. **Verify the harness is the real board before recording anything from it**: with failure disabled the demo board must score exactly **1,324 trips over 20,000 ticks**, the figure `demoLayout.ts` documents. A harness that does not reproduce that is measuring something else.

Record, for each board: the death tick; the destination, **with its kind and rotation-slot count** (`computeSlotCounts`, `demand.ts:294` — `const slots = destMetaKind(meta) === DEST_KIND_CIRCLE ? 2 : 1`); arrivals received by it versus the median destination; the longest consecutive at-or-over-cap run per destination; and the tick of its **last arrival**.

The figures this plan was written against, to be reproduced rather than trusted:

| board | dies at | destination | kind | arrivals (it / median) | last arrival | longest at-cap run |
|---|---|---|---|---|---|---|
| **demo** (`?startapp=demo`) | **6,703** (3 min 43 s) | **D2**, grid (16,9), `ORIENTATION_W`, colour 2 | **circle**, 2 slots, trigger 8 | **6 / 24** | **1,549** | 3,390 (D2); next highest **272** (D5); **0** for the other sixteen |
| **city** (`firstCity`, no roads) | **5,580** | **D2**, colour 1 | **circle**, 2 slots, trigger 8 | 0 / 0 | never | 3,390 |

Two things in that table matter more than the ticks and must be checked, because both were wrong in earlier derivations:

- **The city board's death tick is 5,580, not 5,579**, and the counterfactual for the lower-indexed square D0 is **6,357, not 6,358** — the two errors go in opposite directions, so it is not one convention offset. Derive it: D2 is at cap from tick 2,191, the k-th at-cap tick is `2,190 + k`, and `k = 3,390` gives 5,580.
- **D2 dies before D0 despite the HIGHER trigger cap**, and the reason is the rotation, not the cap. Colour 1 owns exactly one destination and it is a circle, so both of `slotCount(1) = 2`'s slots are D2's and it receives a pin every 259 ticks; colour 0 owns two squares sharing `slotCount(0) = 2`, so each gets one per 518. **A circle is served twice as often and therefore fills more than twice as fast, and the 8-vs-6 cap does not make up the difference.** Nothing in the first draft of this plan stated that squares carry one rotation slot and circles two, and two separate derivations in it depended on it.

**Also record the demo board's death tick with the knockback removed, with the unwind removed, and with both removed.** All three are expected to be **unchanged at 6,703**, and that is the single most important fact about this board: D2's last arrival is tick 1,549 and its pin count is monotone from there to the hard cap, so **it dies of total starvation, not of a losing race.** No knockback-side lever reaches it. Task 10's gate and Decision 2 both turn on that distinction, and a run that finds it changed has found something this plan did not know.

Put every figure in the commit message and beside the windows they bound in `demoLayout.test.ts` and `startingCity.test.ts`.

- [ ] **Step 10: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `isOverCapacity`: `>=` → `>` | the trigger test, both kinds |
| `overcrowdTriggerCap`: return the HARD cap instead of the timer cap | the trigger test, both kinds |
| `overcrowdRampSpeed`: drop the `> DENOM` clamp | the ramp table at 15,000 ticks; the 3,390 test |
| `overcrowdRampSpeed`: `/ TICKS_PER_SECOND` → `/ DENOM` | the ramp table and the 750,000 sum |
| `runOvercrowd`: drop the saturation | the saturation test |
| `runOvercrowd`: unwind by `DENOM` instead of `OVERCROWD_RETURN_MUL` | the unwind test |
| `runOvercrowd`: do not reset `destOverTicks` on the under-capacity branch | the unwind test's second assertion |
| `arrivalKnockback`: drop the cap | the knockback table at 910,000 — **not at 900,000, which is a measured 0-detector** |
| `isOverCapacity`: read `destPins - destReserved` | the carpark-immunity test |
| `applyArrivalKnockback`: drop the call from `arriveAtDestination` | the Step 5 sweep, at every surviving period |
| Move phase 10 before phase 9 | Step 7's brink test |

- [ ] **Step 11: Commit**

```bash
git add packages/sim/src/overcrowd.ts packages/sim/src/step.ts packages/sim/src/trips.ts packages/sim/src/index.ts packages/shared/src/constants.ts packages/sim/test packages/shared/test packages/game/test
git commit -m "$(cat <<'EOF'
feat(sim): the per-destination overcrowd meter (§5.8), and both boards' death ticks

Phase 10 of ten. Two Int32 quantities per destination: consecutive ticks over
capacity, saturating at the 1,500-tick point where §5.8's ramp reaches full;
and the integrated meter in milli-ticks, unwound at 2x when back under and
knocked back 10% (capped at 3 s) on every arrival.

The spec's "~113 s" is exact: the ramp sums to 750,000 milli-ticks, the
remaining 1,890,000 accrues at 1,000/tick, and a starved destination fills on
the 3,390th consecutive over-capacity tick and not the 3,389th.

Swept rather than asserted: a destination held at its cap survives iff it is
served better than once every 90 ticks, and above that the meter grows without
bound. There is no middle. 91 dies at tick 163,162 and 92 at 84,271, so a short
horizon reports a softer boundary than the real one — the horizon is a named
constant for that reason.

Both shipped boards driven 40,000 ticks with no input, on their real boot paths,
and their death ticks recorded rather than assumed: demo at 6,703 (3:43) on D2,
a colour-2 circle that received 6 arrivals against a median of 24 and its last
at tick 1,549; city at 5,580 on D2, colour 1's lone circle. Removing the
knockback, the unwind or both changes neither: these boards die of starvation,
not of a losing race. D2 beats the lower-indexed square D0 (6,357) because a
circle carries TWO rotation slots and is therefore served twice as often.

No golden moved.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** nothing yet, and deliberately so. The meter runs and no pixel reads it — Task 9 draws the ring and Task 8 makes it fatal. Splitting the arithmetic from the consequence is what lets the 3,390-tick derivation be wrong loudly in a test rather than fatally in a run. **Step 9 is where a person first learns what this milestone does to the two boards that exist**, and it delivers that as two integers in a commit message rather than as a surprise in Task 12 or, worse, on a phone.

---

## Task 8: Game over, and the loop that cannot be talked out of it

**Files:**
- Modify: `packages/sim/src/overcrowd.ts` (fire the flag), `packages/sim/src/step.ts` (the early return), `packages/game/src/frame.ts` (`onGameOver`), `packages/game/src/loop.ts` (`end()`, `over`), `packages/game/src/main.ts` (call `loop.end()` from it)
- Test: `packages/sim/test/overcrowd.test.ts`, `packages/sim/test/step.test.ts`, `packages/sim/test/rollback.test.ts`, `packages/game/test/frame.test.ts`, `packages/game/test/loop.test.ts`, `packages/game/test/integration.test.ts`, **`packages/game/test/demoAllocation.test.ts` (the margin guard)**

**Interfaces:**
- Consumes: `isGameOver`, `failedDestination`, `H_GAME_OVER`, `H_FAILED_DEST` (Task 1); `runOvercrowd` (Task 7).
- Produces: `FrameDriverDeps.onGameOver: () => void` — **required, not optional**; `Loop.end(): void` and `Loop.over: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
  it('ends the run on the tick the meter completes, naming the destination', () => {
    const r = starvedDestinationRig()
    for (let i = 0; i < 3389; i++) step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(isGameOver(r.state), 'one tick short').toBe(false)
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(isGameOver(r.state)).toBe(true)
    expect(failedDestination(r.state)).toBe(D_STARVED)
  })

  it('freezes the whole buffer: every later step is a byte-identical no-op', () => {
    // What the leaderboard needs. A Worker replaying an input log that runs
    // past the failure must compute the same score as the browser that
    // produced it, whatever the log's length — so the freeze lives in `step`,
    // not in the caller.
    const r = runToGameOver()
    const frozen = new Uint8Array(snapshot(r.state))
    for (let i = 0; i < 500; i++) {
      step(r.state, r.world, r.fields, r.scratch, { actions: [{ kind: 'place', a: FREE_A, b: FREE_B }] })
    }
    expect(new Uint8Array(snapshot(r.state))).toEqual(frozen)
    expect(r.state.header[H_TICK], 'even the clock stops').toBe(frozen_tick)
  })

  it('does not poison the buffer on the frozen ticks', () => {
    // The early return is BEFORE `H_EPOCH` is written, so a frozen state stays
    // restorable. If it were after, every post-failure tick would leave the
    // atomicity marker set and `restore` would refuse the save.
    const r = runToGameOver()
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(r.state.header[H_EPOCH]).toBe(0)
    expect(() => restore(snapshot(r.state), r.world)).not.toThrow()
  })

  it('the loop pauses through a REQUIRED callback, not an optional one', () => {
    // Required, and the type system says so. M2's erase control took an
    // OPTIONAL factory, so `createEraseControl({ host })` compiled and left the
    // player with no way to erase — a Critical reinstated by an omission with
    // no compile error and no test failure.
    let calls = 0
    const driver = createFrameDriver({ ...deps, onGameOver: () => { calls++ } })
    driveToGameOver(driver)
    expect(calls, 'exactly once, not once per frozen tick').toBe(1)
  })

  it('a loop that has ended cannot be resumed by anyone, including main.ts', () => {
    // `loop.setPaused` had no stickiness, and it is reachable from OUTSIDE this
    // module: `Game.setPaused` (main.ts) forwards to it and is exported. The
    // clock tap is the only production caller today, and Task 9 takes that one
    // away — but a guard that only closes the one caller that exists is a guard
    // that re-opens with the next one. `end()` makes it a property of the loop.
    const l = loopRig()
    l.end()
    expect(l.paused).toBe(true)
    expect(l.over).toBe(true)
    l.setPaused(false)
    expect(l.paused, 'setPaused(false) after end() must do nothing').toBe(true)
    const ticksBefore = l.ticksAdvanced
    for (let f = 0; f < 30; f++) l.frame(nextFrameTime())
    expect(l.ticksAdvanced, 'and no tick may run').toBe(ticksBefore)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -r --no-bail --filter './packages/sim' test -- overcrowd step`
Expected: FAIL — `isGameOver` stays false, and `FrameDriverDeps` has no `onGameOver`.

- [ ] **Step 3: Fire the flag**

In `runOvercrowd`, inside the over-capacity branch after the meter write:

```ts
      if ((state.destOvercrowd[d] as number) >= OVERCROWD_FAIL_MILLITICKS) {
        // §5.8: "the city shuts down IMMEDIATELY. No lives, no partial
        // failure, no win condition." Returning here rather than finishing the
        // loop is not an optimisation: it fixes WHICH destination is blamed
        // when two complete on the same tick, at the lowest index, which is
        // the same ascending-integer tie-break every other order in this sim
        // uses.
        //
        // The meter is left AT ITS OVERSHOOT, not clamped: the ramp was added
        // before this test, so the stored value can exceed
        // OVERCROWD_FAIL_MILLITICKS by up to `DENOM - 1`, and the freeze then
        // preserves that overshoot forever. Task 12's long-run bound is
        // `OVERCROWD_FAIL_MILLITICKS + DENOM - 1` for exactly this reason.
        state.header[H_GAME_OVER] = 1
        state.header[H_FAILED_DEST] = d
        return
      }
```

- [ ] **Step 4: Freeze `step`**

In `packages/sim/src/step.ts`, immediately after the poison check and **before** the `H_EPOCH` write:

```ts
  // §5.8's shutdown, and it lives here rather than in the caller for one
  // reason: server-side replay. A Worker replaying an input log that runs past
  // the failure must compute the same score as the browser that produced it,
  // whatever the log's length — so every post-failure tick has to be a
  // byte-identical no-op in `sim` itself, not merely a tick the game loop
  // chose not to run.
  //
  // Before the `H_EPOCH` write, deliberately: a frozen state must stay
  // restorable, and an epoch left set on every frozen tick would make
  // `restore` refuse the save M3 is about to write.
  if (isGameOver(s)) return
```

- [ ] **Step 5: Wire the loop to follow, and to stay followed**

In `packages/game/src/frame.ts`, add to `FrameDriverDeps`:

```ts
  /**
   * Called ONCE, on the tick `isGameOver(state)` first becomes true. `main.ts`
   * ends the loop from it.
   *
   * **Required, not optional, and the type says so.** `sim` is the authority —
   * `step` is already a no-op past the failure — so this callback is a
   * follower: it exists to stop the loop burning 30 steps a second on nothing
   * and to let the shell react. An optional dependency here would compile
   * without it and quietly leave a dead loop running behind a game-over
   * screen, which is exactly the shape of M2's erase-control Critical.
   */
  readonly onGameOver: () => void
```

and in `advance`:

```ts
    advance(inputs: TickInputs): void {
      const wasOver = isGameOver(state)
      step(state, world, fields, scratch, inputs)
      if (!wasOver && isGameOver(state)) deps.onGameOver()
    },
```

In `packages/game/src/loop.ts`, four edits:

```ts
// in the `Loop` interface
  /**
   * Ends the run: pauses, and refuses every later `setPaused`. **Sticky, and
   * that is the whole point.** `setPaused` is reachable from outside this
   * module through `Game.setPaused`, and until M1e a tap on the HUD clock
   * resumed rAF on a dead sim — the frame driver kept snapshotting, the pause
   * bars vanished while the shutdown scrim stayed, and `HitRegion.GRID`
   * re-opened so the player drew roads that never appeared. Guarding the one
   * caller that exists is a guard that re-opens with the next one.
   *
   * Note what this does NOT do: rAF is never cancelled. `onFrame` re-arms
   * unconditionally in `main.ts` and pause is a branch inside `frame`, so
   * "stop the loop" is not a thing this codebase can do without restructuring
   * the entry point — and it does not need to, because the branch already
   * skips the drain.
   */
  readonly end: () => void
  /** True once `end()` has been called. `pointer.ts` reads it as `gameOver`. */
  readonly over: boolean
```

```ts
  let over = false
```

```ts
  setPaused(next: boolean): void {
    if (over) return
    // … existing body unchanged
  },
  end(): void {
    over = true
    paused = true
  },
```

In `main.ts`, pass `onGameOver: () => { loop.end() }`.

- [ ] **Step 6: Add the margin guard to every window that profiles a live sim**

**This step exists because the first draft of this plan did not have it and the numbers say it must.** `demoAllocation.test.ts` drives the demo board to a tick a few percent short of that board's death tick (Decision 7 records both figures). Every vacuity guard the file has — 24 cars, 18 destinations, 71 road cells — **passes on a frozen board**, because frozen cars keep their slot and their phase and frozen roads keep their bits. So any future change to `WINDOW_COUNT`, `PROFILED_FRAMES`, `WARMUP_FRAMES` or the frame `dt` would tip a profiling window into byte-identically measuring a dead sim, and every assertion in the file would stay green.

Add, after the final drive in `demoAllocation.test.ts` and in `integration.test.ts`'s long run:

```ts
    // **The margin guard.** This window ends at tick 6,459 against a game over
    // at tick 6,703 on this board — a margin of 244 ticks, 3.6 %. A frozen sim
    // is byte-identical from tick to tick, so a profiler measures 0 and every
    // count in this file still passes: frozen cars keep their phase and frozen
    // roads keep their bits. Extend the window and this fails loudly instead of
    // silently profiling a corpse.
    //
    // 6,459 is derivable and should be re-derived rather than observed:
    // `createGame` runs 1,200 warm-start ticks; the loop's first frame sets
    // `lastTime = now` and drains 0; each 3,000-frame window at 16.7 ms is
    // 50,100 ms = exactly 1,503 ticks at TICK_MS = 1000/30; and 1,500 warmup
    // frames give floor(16.7 * 1,499 / TICK_MS) = 750. So
    // 1,200 + 750 + 3 * 1,503 = 6,459.
    expect(isGameOver(state), 'this window must profile a LIVE sim').toBe(false)
```

**Re-measure both ticks in this commit rather than copying them.** Task 7 Step 9 records the death tick and this step reads it; the figures above are what this plan was written against and a disagreement is a finding, not a typo. Apply the same guard, with its own two figures, to `integration.test.ts`'s long run.

- [ ] **Step 7: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS, no golden moved. Derived and then **confirmed by measurement**: no golden fixture reaches a meter of 2,640,000, because the highest `destPins` in any of them is 1 against a trigger of 6. Measure it; do not read it.

- [ ] **Step 8: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `>= OVERCROWD_FAIL_MILLITICKS` → `> ` | the 3,390 test (fires at 3,391) |
| Compare against `OVERCROWD_FULL_MILLITICKS` (drop the grace) | the 3,390 test |
| Drop the `return` after setting the flag | the "names the destination" test, with two destinations completing together |
| Move the `isGameOver` early return **after** the `H_EPOCH` write | the poison test |
| Delete the early return entirely | the byte-identical freeze test |
| Call `onGameOver` on every frozen tick | the "exactly once" assertion |
| `end()` sets `over` but not `paused` | the loop test's first `expect(l.paused)` |
| `setPaused`'s `if (over) return` deleted | the loop test's resume assertion |
| Make `onGameOver` optional in the type | **no runtime detector — this is a TYPE-level guard**, and `frame.test.ts` pins it with a `@ts-expect-error` construction missing the field |
| Extend `demoAllocation`'s final window past the death tick | Step 6's margin guard — **run this one, it is the whole reason the guard exists** |

- [ ] **Step 9: Commit**

```bash
git add packages/sim/src/overcrowd.ts packages/sim/src/step.ts packages/game/src packages/sim/test packages/game/test
git commit -m "$(cat <<'EOF'
feat(sim): the city shuts down (§5.8), and the loop cannot be talked out of it

A completed meter sets H_GAME_OVER and H_FAILED_DEST, and `step` returns
immediately on every later tick — before the H_EPOCH write, so the frozen state
stays restorable. The freeze is in `sim` and not in the caller because a Worker
replaying a log that runs past the failure must score identically to the browser
that produced it.

The frame loop follows through a REQUIRED onGameOver callback, fired once, which
calls the new `loop.end()`. That is sticky: `setPaused` is reachable from
outside the module through the exported `Game.setPaused`, and a loop that can be
resumed on a dead sim is a loop that draws roads which never appear. Task 9 adds
the input-side half and the way back out.

Every window that profiles a live sim now asserts `isGameOver(state) === false`
after its final drive, with its end tick and its margin to game over stated at
the site. demoAllocation ends within a few percent of the demo board's death
tick, and all three of its vacuity guards pass on a frozen board.

No golden moved: measured, the highest destPins in any golden fixture is 1,
against a trigger of 6.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** the run can now end, and on the demo board — still the default at this point — it will, unprompted, partway through the fourth minute. With no overlay yet, what a player sees is the board **stopping dead**: cars frozen mid-cell, the week/day clock stuck, taps doing nothing at all. That is unmistakable, it is also indistinguishable from a crash, **and after this commit there is no way back except closing the app** — which is strictly worse than the build before it. That is why Task 9 is the next commit and not an optional follow-up, and why the two are adjacent rather than separated by the sweep.

One thing a player will see on the drawn board and should not be alarmed by: the frozen cars settle onto their exact sim positions rather than stopping mid-stride. `resolve.ts`'s speed-limited chase (`76cffb5`) can never pass the sim position, so with the sim frozen the drawn position converges to it monotonically and exactly — measured at three ticks from the worst-case 0.132-cell lag, bit-identical thereafter, no overshoot and no oscillation. The freeze is safe for the smoothing.

---

## Task 9: The overcrowd ring, the shutdown screen, and the tap that starts a new run

**Files:**
- Modify: `packages/render/src/types.ts` (`RenderFrame`, `Palette`, **`DrawContext` grows five members**), `packages/render/src/canvas.ts` (the ring, the scrim, the shutdown text, a fourth memoised label), `packages/render/src/palette.ts`, `packages/game/src/frame.ts` (the fold), `packages/game/src/pointer.ts` (`PointerHost.gameOver`/`restart`, `PointerOutcome.RESTART_REQUESTED`, the early return), `packages/game/src/main.ts` (palette entries, `deps.restart`, the host wiring)
- Test: `packages/render/test/canvas.test.ts`, `packages/render/test/interface.test.ts`, `packages/game/test/frame.test.ts`, `packages/game/test/pointer.test.ts`, `packages/game/test/drawAllocation.test.ts`, `packages/game/test/integration.test.ts`
- Modify, because they implement `DrawContext` and will not compile without the five new members: `packages/render/test/canvas.test.ts:123` (`class RecordingContext implements DrawContext`), `packages/game/test/shell.test.ts:548`, `packages/game/test/drawAllocation.test.ts:206`, `packages/game/test/carSmoothing.test.ts:596`, `packages/game/test/demoAllocation.test.ts:163`, `packages/game/test/integration.test.ts:291`. **`interface.test.ts` does NOT implement `DrawContext`** — it breaks instead on `RenderFrame.gameOver` (`:103`) and on `PALETTE`'s literal nine-name key array (`:309-319`, with hex and uniqueness checks at `:328` and `:346`), which goes to eleven.

**Interfaces:**
- Consumes: `state.destOvercrowd` (Task 1/7), `isGameOver`/`failedDestination` (Task 1/8), `OVERCROWD_FULL_MILLITICKS` (Task 7), `Loop.over` (Task 8).
- Produces: `RenderFrame.destOvercrowd: Uint8Array` (0–255 per destination), `RenderFrame.gameOver: boolean`, `RenderFrame.failedDest: number` (−1 when live); `Palette.overcrowd: string`, `Palette.scrim: string`; `DrawContext.strokeStyle: string`, `DrawContext.lineWidth: number`, `DrawContext.beginPath(): void`, `DrawContext.arc(x, y, r, start, end): void`, `DrawContext.stroke(): void`; `PointerHost.gameOver: () => boolean`, `PointerHost.restart: () => void`, `PointerOutcome.RESTART_REQUESTED = 9`; `GameDeps.restart?: () => void`.

**`render` imports nothing from `sim`**, so the fold happens in `game`'s `buildFrame` and the renderer receives numbers it can draw without asking anything — the same rule that already routes `weekOfTick`, `carparkCell` and `destMetaColour` through that file.

**Read this before writing a test in this task.** A trial implementation of the scrim as a new final phase, gated on `frame.gameOver`, was added to `canvas.ts` and **the entire 231-test render suite stayed green** — because `frameA()` and `frameB()` never set `gameOver`, so it reads `undefined`, so the phase never runs. **A new conditional draw phase is unconstrained by every test this repo currently has.** That is the "fixture too permissive to exercise its own guard" entry in the catalogue, and it means every fixture in this task must set `gameOver` explicitly on both sides, and the live-frame negative is not optional decoration.

- [ ] **Step 1: Write the failing fold tests**

`packages/game/test/frame.test.ts`:

```ts
  it('folds the meter against the FULL 90 s, not the 88 s that kills you', () => {
    // §5.8's "hidden grace at the end": the ring is drawn against
    // OVERCROWD_FULL_MILLITICKS while failure fires at
    // OVERCROWD_FAIL_MILLITICKS, so it reads 97.8 % at the instant the city
    // dies. Folding against the fail value instead would show a full ring two
    // seconds early, every time, and delete the grace the spec asks for.
    const { builder, state, world, camera } = frameRig()
    state.header[H_DEST_COUNT] = 2
    state.destOvercrowd[0] = 0
    state.destOvercrowd[1] = OVERCROWD_FAIL_MILLITICKS
    const f = buildFrame(builder, state, world, camera, 0, false)
    expect(f.destOvercrowd[0]).toBe(0)
    expect(f.destOvercrowd[1]).toBe(249) // floor(2_640_000 * 255 / 2_700_000)
    expect(f.destOvercrowd[1], 'the ring is not full when the run ends').toBeLessThan(255)
  })

  it('reports game over and the destination that caused it, and -1 while live', () => {
    const { builder, state, world, camera } = frameRig()
    expect(buildFrame(builder, state, world, camera, 0, false).gameOver).toBe(false)
    expect(buildFrame(builder, state, world, camera, 0, false).failedDest).toBe(-1)
    state.header[H_GAME_OVER] = 1
    state.header[H_FAILED_DEST] = 1
    const f = buildFrame(builder, state, world, camera, 0, false)
    expect(f.gameOver).toBe(true)
    expect(f.failedDest).toBe(1)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -r --no-bail --filter './packages/game' test -- frame`
Expected: FAIL — `f.destOvercrowd` is `undefined`.

- [ ] **Step 3: Add the frame fields and the fold**

In `packages/render/src/types.ts`, add to `RenderFrame`:

```ts
  /**
   * Per destination, `0..255`, the overcrowd meter scaled against §5.8's FULL
   * 90 s rather than the 88 s at which the run ends — so a full ring is
   * unreachable and the spec's 2 s "hidden grace" is what the player does not
   * see. `render` never learns the milli-tick figures; `game` folds them.
   */
  readonly destOvercrowd: Uint8Array
  /** True once a destination's timer completed (§5.8). The board is frozen behind the scrim. */
  readonly gameOver: boolean
  /** The destination that ended the run, or -1 while it is live. */
  readonly failedDest: number
```

and to `Palette`, `readonly overcrowd: string` and `readonly scrim: string`.

In `packages/game/src/frame.ts`, allocate `destOvercrowd: new Uint8Array(maxDest)` in `createFrameBuilder`, and inside `buildFrame`'s destination loop:

```ts
    // Integer arithmetic is not required here — `game` is not `sim` — but it
    // is used anyway so the fold cannot introduce a value `render` has to
    // round differently on two engines. 255 * 2,700,000 fits an Int32.
    const scaled = (((state.destOvercrowd[d] as number) * 255) / OVERCROWD_FULL_MILLITICKS) | 0
    frame.destOvercrowd[d] = scaled > 255 ? 255 : scaled
```

with `frame.gameOver = isGameOver(state)` and `frame.failedDest = failedDestination(state)` in the HUD block.

- [ ] **Step 4: Grow `DrawContext` by the five members a stroked arc needs**

`arc` alone paints nothing — it appends to the current path. `canvas.ts:134-159`'s complete member set today is the properties `fillStyle`, `font`, `textAlign`, `textBaseline` and the methods `fillRect`, `fillText`, `drawImage`; `clearRect` is deliberately absent and stays absent. A stroked ring needs **five** additions:

```ts
  /** M1e Task 9: the overcrowd ring. `arc` alone appends to a path and paints
   *  nothing, so the stroke half of the pair comes with it. `clearRect` stays
   *  out — see the note above; nothing here ever clears. */
  strokeStyle: string
  lineWidth: number
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  stroke(): void
```

Production `main.ts` needs no change — `GameContext = ScalableContext & DrawContext` (`main.ts:147`) and a real `CanvasRenderingContext2D` satisfies the wider interface structurally, which `_RealContextIsADrawContext` (`canvas.ts:910`) pins. **Six test doubles must grow the members or the packages do not compile**, and they are listed in this task's Files block. Add them all in this step, before any behaviour, and run `tsc --noEmit` across the workspace to confirm the list is complete rather than trusting it.

- [ ] **Step 5: Write the failing draw tests, in CSS px, above the HUD**

`packages/render/test/canvas.test.ts`:

```ts
  it('draws a ring only for a destination whose meter is non-zero, sized from the value', () => {
    // Two destinations, one at 0 and one part-filled, so "draws a ring" and
    // "draws it for the right one" are separable. A single-destination fixture
    // cannot tell them apart.
    const rec = drawWith(frameWithOvercrowd([0, 128]))
    const arcs = rec.commands.filter((c) => c.op === 'arc')
    expect(arcs.length).toBe(1)
    expect(arcs[0].endAngle - arcs[0].startAngle).toBeCloseTo((128 / 255) * Math.PI * 2, 5)
  })

  it('draws the ring at the destination it belongs to, not at index 0', () => {
    // The bug this catches is indexing the ring loop by draw order rather than
    // by destination index once a destination is culled by the revealed rect.
    const rec = drawWith(frameWithOvercrowd([0, 200]))
    const arc = rec.commands.find((c) => c.op === 'arc')!
    expect(arc.x).toBeCloseTo(expectedCentreX(1), 5)
    expect(arc.y).toBeCloseTo(expectedCentreY(1), 5)
  })

  it('respects the revealed rect in BOTH directions', () => {
    // Under- and over-approximation as a pair, with each out-of-rect marker
    // placed past EXACTLY ONE bound and exactly one cell past it. A marker in
    // a diagonal corner sits past two bounds at once, so extending any single
    // bound reaches nothing — that placement produced seven 0-detector mutants
    // on M2 Task 5 and it must not be repeated here.
    for (const marker of oneCellPastEachOfFourBounds()) {
      expect(ringsDrawnFor(marker.outside)).toBe(0)
      expect(ringsDrawnFor(marker.inside), 'the far edge must still draw').toBe(1)
    }
  })

  it('draws the shutdown scrim over the whole board and never into the HUD band', () => {
    // **Unit: CSS px, snapped by `deviceEdge`** (canvas.ts:463 is
    // `Math.round(cssValue * dpr) / dpr`, which divides back into CSS), which
    // is what every other geometry assertion in this file is in. An earlier
    // draft asserted `camera.cssH * camera.dpr`, i.e. device px, which on
    // cameraA demands a rect ending at 1740 on an 870 px canvas.
    //
    // **`hudTop` is the top edge of the BOTTOM band.** camera.ts:164 is
    // `hudTop = max(originY + gridHeight, cssH - bottomInset - HUD_BAND_CSS)`,
    // so the board is [originY, hudTop) and the HUD is below it. The earlier
    // draft's `scrim.y >= hudTop + hudHeight` covers ZERO board pixels: on
    // cameraA it is the 34 px bottom inset (836..870), and on the 320x568
    // fixture, where bottomInset is 0, `hudTop + hudHeight === cssH === 568`
    // and the rect must have zero height. It fails on the correct
    // implementation AND on the mutant it was written to catch.
    const camera = cameraB
    const rec = drawWith(gameOverFrame({ camera }))
    const scrim = rec.commands.find((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)!
    const gridBottom = camera.originY + camera.rows * camera.tileSize
    expect(scrim.y, 'the scrim starts at or above the board top').toBeLessThanOrEqual(camera.originY)
    expect(scrim.y + scrim.h, 'the scrim covers the board bottom').toBeGreaterThanOrEqual(gridBottom)
    expect(scrim.y + scrim.h, 'the scrim must not run into the HUD band').toBeLessThanOrEqual(camera.hudTop)
  })

  it('scrims every board corner and no HUD rect', () => {
    // The rect assertion above is satisfiable by a rect of the right EXTENT in
    // the wrong place on x. Point probes close that, and they are the idiom
    // `canvas.test.ts` already uses for the playfield fill.
    const camera = cameraB
    const rec = drawWith(gameOverFrame({ camera }))
    const scrim = rec.commands.find((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)!
    for (const [gx, gy] of fourBoardCorners(camera)) {
      expect(rectCoversGridCell(scrim, camera, gx, gy), `corner ${gx},${gy}`).toBe(true)
    }
    const rects = hudRects(camera, createHudRects())
    for (const name of ['clock', 'score', 'tiles'] as const) {
      expect(rectsOverlap(scrim, rects[name]), `${name} must stay legible`).toBe(false)
    }
  })

  it('names the score on the SHUTDOWN screen, not merely somewhere on the frame', () => {
    // `drawHud` is the last statement of `drawFrame` (canvas.ts:454) and draws
    // `scoreText(frame.score)` = "47 TRIPS" (canvas.ts:748) UNCONDITIONALLY.
    // So `expect(texts).toContain('47 TRIPS')` over the whole frame is a
    // 0-DETECTOR: measured, it passes on a game-over frame whose shutdown
    // phase draws nothing at all, and it passes identically on a live frame.
    // The scrim is the phase boundary, so slice after it — the index idiom
    // `painted()`/`indexOfRect()` already exists for the draw-order tests.
    const log = draw(gameOverFrame({ score: 47 }))
    const scrimIndex = log.findIndex((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)
    expect(scrimIndex, 'no scrim was drawn at all').toBeGreaterThan(-1)
    const shutdownTexts = log.slice(scrimIndex + 1).filter((c) => c.op === 'fillText').map((c) => c.text)
    expect(shutdownTexts).toContain('47 TRIPS')
    // Vacuity, and the half that makes the slice mean something: the HUD's own
    // copy is always at a LOWER index, so there must be exactly two.
    expect(log.filter((c) => c.op === 'fillText' && c.text === '47 TRIPS').length).toBe(2)
  })

  it('names the destination that shut the city down, as a whole line', () => {
    const log = draw(gameOverFrame({ failedDest: 2 }))
    const scrimIndex = log.findIndex((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)
    const shutdownTexts = log.slice(scrimIndex + 1).filter((c) => c.op === 'fillText').map((c) => c.text)
    expect(shutdownTexts).toContain('DESTINATION 2 OVERCROWDED')
    // The index is what varies, so vary it — a fixture on one value cannot
    // tell the label apart from a constant string.
    const other = draw(gameOverFrame({ failedDest: 7 }))
    const oi = other.findIndex((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)
    expect(other.slice(oi + 1).filter((c) => c.op === 'fillText').map((c) => c.text))
      .toContain('DESTINATION 7 OVERCROWDED')
  })

  it('tells the player how to start again', () => {
    const log = draw(gameOverFrame({}))
    const scrimIndex = log.findIndex((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)
    expect(log.slice(scrimIndex + 1).filter((c) => c.op === 'fillText').map((c) => c.text))
      .toContain('TAP TO PLAY AGAIN')
  })

  it('draws nothing of the shutdown when the run is live', () => {
    // Explicit `gameOver: false`, not an absent field. A trial scrim phase left
    // the whole 231-test render suite green precisely because `frameA()` and
    // `frameB()` never set the flag and `undefined` is falsy.
    const rec = drawWith(liveFrame({ gameOver: false }))
    expect(rec.commands.some((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)).toBe(false)
    expect(rec.commands.some((c) => c.op === 'arc')).toBe(false)
  })
```

- [ ] **Step 6: Implement the ring, the scrim and the three shutdown lines**

Add the ring inside the existing destination phase, so it inherits that phase's culling and its `destCarpark` sentinel handling rather than growing a second copy. Add the scrim plus three text lines as a new final phase after the HUD, gated on `frame.gameOver`.

**Two of the three lines are preallocated constants** (`'TAP TO PLAY AGAIN'`, and the fixed tail of the destination line). The two that carry a number use **the memo pattern `canvas.ts:281-304` already has three instances of** — `clockText`, `scoreText`, `tilesText`, each a single-slot value-keyed cache over `cachedWeek`/`cachedDay`/`cachedClockText`/`cachedScore`/`cachedScoreText`/`cachedTiles`/`cachedTilesText`:

```ts
let cachedFailedDest = -2
let cachedFailedText = ''
/**
 * "DESTINATION 3 OVERCROWDED", memoised on the index — the fourth instance of
 * this file's single-slot cache, and by a wide margin the cheapest. `scoreText`
 * rebuilds whenever the score moves; **`failedDest` changes at most once per
 * run**, so after the first shutdown frame this is one integer comparison and
 * nothing else, forever. The sentinel is -2 rather than -1 because -1 is the
 * live value and must produce a cache miss on the first shutdown frame.
 *
 * This is what makes `RenderFrame.failedDest` a field with a consumer. An
 * earlier draft added the field, folded it, and drew nothing with it, while
 * promising in its Observability line that the screen "tells them which
 * destination shut the city down". A field nothing reads is dead weight in
 * every frame's type and a false claim in the plan.
 */
function failedText(d: number): string {
  if (d !== cachedFailedDest) {
    cachedFailedDest = d
    cachedFailedText = `DESTINATION ${d} OVERCROWDED`
  }
  return cachedFailedText
}
```

The score line reuses `scoreText(frame.score)` unchanged, which is why the whole-frame `toContain` in Step 5 asserts **two** occurrences.

- [ ] **Step 7: Make game over terminal at the input boundary, and give it the one way out**

Three edits, and they are separated so each has its own mutation target.

**(a) `packages/game/src/pointer.ts` — the outcome code and the host members.**

```ts
  /** A tap while the run is over; a new run was requested. */
  RESTART_REQUESTED: 9,
```

```ts
  /**
   * True once the run has ended (§5.8). Read from the loop rather than from
   * `sim`, because `pointer` is in `game` and must not grow a `sim` import for
   * one boolean — and because the loop is already the authority on `paused`
   * for the same reason.
   */
  readonly gameOver: () => boolean
  /**
   * Starts a new run. Injected, and `main.ts` passes `() => { location.reload() }`.
   * See Decision 5: a seamless in-place restart needs a `resetState` in `sim`
   * that M3 owns, and a reload is the one path in this codebase known to
   * produce a correct boot. It is a dependency rather than a direct call so
   * that this branch has a Node-side detector.
   */
  readonly restart: () => void
```

**(b) `packages/game/src/pointer.ts` — one early return in `down()`, ABOVE the HUD test.**

```ts
    // §5.8's shutdown is terminal, and this is the only branch that says so.
    // ONE early return rather than a guard on the clock toggle plus a guard on
    // the grid: two guards can disagree, and the clock guard alone would still
    // leave `Game.setPaused` — exported, and forwarded from `main.ts` — able to
    // resume a dead sim from outside this module.
    //
    // A terminal state obliges a recovery path, and the guard is what removes
    // the accidental one: before this branch, a clock tap un-paused the loop
    // and re-opened `HitRegion.GRID`, so the player drew roads that never
    // appeared, spent no tiles and got no message. Measured, all four clauses.
    if (host.gameOver()) {
      host.restart()
      return PointerOutcome.RESTART_REQUESTED
    }
```

**(c) `packages/game/src/main.ts`** — pass `gameOver: () => loop.over` and `restart: deps.restart ?? (() => { location.reload() })` into `createPointerInput`, and add `restart?: () => void` to `GameDeps`. The `location.reload()` call itself is the same irreducible two-DOM-calls-with-no-Node-detector shape `createFallbackButton` already has, and it is isolated to one arrow function for that reason.

Tests, in `packages/game/test/pointer.test.ts`:

```ts
  it('a tap anywhere starts a new run once the city has shut down', () => {
    const h = hostRig({ gameOver: true })
    expect(h.pointer.down(1, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.RESTART_REQUESTED)
    expect(h.pointer.down(2, BOARD_X, BOARD_Y)).toBe(PointerOutcome.RESTART_REQUESTED)
    expect(h.restarts).toBe(2)
    // The negative that matters: the clock tap must not ALSO have toggled pause.
    expect(h.setPausedCalls, 'the clock toggle must be unreachable').toBe(0)
    expect(h.queue.inputs.actions.length, 'and no road may be queued').toBe(0)
  })

  it('is inert before the run is over — pause still toggles and the board still draws', () => {
    // The other side of the guard. Without this the early return is
    // indistinguishable from `down()` returning RESTART_REQUESTED always.
    const h = hostRig({ gameOver: false })
    expect(h.pointer.down(1, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.PAUSE_TOGGLED)
    expect(h.restarts).toBe(0)
  })
```

- [ ] **Step 8: Give `drawAllocation.test.ts` a ring count and a scrim count, and assert both**

The driver is a fixed 4-cell road with 6 cars and 3 pins and contains **no over-capacity destination and no game over**, so without new counters the budget is vacuous for this task and injecting an allocation into either new phase leaves it green.

`DrawCounts` (`drawAllocation.test.ts:187-192`) is today **exactly** `{ blits, ghostBlits }` — the first draft of this plan described it as `{ blits, cars, pins, clockTexts, ghostBlits }`, which is the object that was **deliberately deleted**, with the reason recorded on `:181`: the vacuity block already asserts those three from `game.state` and `builder.frame`, and counting them here would mean classifying `fillRect` calls by geometry inside the profiled loop. **Do not re-add those three.** Add `rings` and `scrimFills`, which are not classifiable from `game.state` and have no other observer: increment `rings` in the recorder's `arc`, and `scrimFills` in `fillRect` when `fillStyle === PALETTE.scrim`. Drive a part-filled meter across the profiled window, and drive a **second** rig that is in game over. **A fixture that stops drawing rings must turn the harness RED, not quietly measure less.**

- [ ] **Step 9: Prove the harness is live by injecting into the NEW code**

Inject an escaping allocation into the ring phase specifically — not into something already covered — and confirm `drawAllocation.test.ts` goes red. A green harness plus a red injection somewhere else is not evidence about the thing you just wrote. **Re-run before believing either result**: this file has been measured flaking roughly 1 run in 10, and the figure lives in the catalogue rather than in the file, so do not go looking for a `retry:` — there is none.

- [ ] **Step 10: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. No golden moves — `render` and the draw path are outside the state buffer, and `pointer.ts`/`loop.ts` do not call `step`.

- [ ] **Step 11: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| Fold against `OVERCROWD_FAIL_MILLITICKS` | the hidden-grace fold test |
| Fold with no `> 255` clamp | the fold test at a hand-set over-max meter |
| Draw a ring for every destination, including zeroes | the "only for non-zero" test |
| Index the ring by draw order rather than destination index | the "at the destination it belongs to" test |
| Shrink the ring loop's far bound | the both-directions test's inside half |
| Draw the scrim over the whole canvas including the HUD | the scrim geometry test's `<= camera.hudTop` clause **and** the corner/HUD probe |
| Draw the scrim over the HUD band only (the first draft's own geometry) | the `>= gridBottom` clause |
| Draw the scrim while live | the "nothing when live" test |
| Draw the shutdown text but not the scrim | the score test's `scrimIndex > -1` assertion |
| Print the score without its unit | the phase-scoped score test — **and NOT the whole-frame `toContain`, which is a measured 0-detector** |
| `failedText`: return a constant string | the two-value destination test |
| `failedText`: sentinel `-1` instead of `-2` | the destination test on the first shutdown frame (cache hit on the live value) |
| Drop the `host.gameOver()` early return | both pointer tests |
| Early return without calling `host.restart()` | the restart-count assertion |
| Early return that runs while live | the "inert before the run is over" test |

- [ ] **Step 12: Commit**

```bash
git add packages/render/src packages/render/test packages/game/src packages/game/test
git commit -m "$(cat <<'EOF'
feat(render): the overcrowd ring, the screen that says the city shut down, and the tap that starts over

A ring around every destination whose meter is non-zero, folded in `game`
against §5.8's FULL 90 s rather than the 88 s that ends the run — so the ring is
never full at the moment it kills you, which is what the spec's 2 s hidden grace
means. `DrawContext` grows the five members a stroked arc needs (`arc` alone
appends to a path and paints nothing); six test doubles grow with it.

The scrim covers the BOARD, in CSS px snapped by deviceEdge. `hudTop` is the top
edge of the BOTTOM band, so a rect below it covers zero board pixels and on a
zero-bottom-inset viewport has zero height.

Game over is terminal at the input boundary: one early return in `down()` above
the HUD test, because a clock tap previously un-paused a dead sim and re-opened
the grid, and because a terminal state obliges a recovery path. That path is
`location.reload()` behind an injected `deps.restart`; the seamless in-place
version needs a `resetState` in `sim` and is M3's.

The shutdown score line is asserted on the SHUTDOWN PHASE, sliced after the
scrim, because `drawHud` draws "47 TRIPS" unconditionally as drawFrame's last
statement and a whole-frame toContain passes on a frame that draws no shutdown
screen at all — measured, on both a live and a dead frame.

drawAllocation gains `rings` and `scrimFills` (NOT the three counters :181
records as deliberately removed) and asserts both; liveness was proved by
injecting into the ring phase specifically.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** this is the task the milestone is for, and at this point the board that boots by default is still the demo board — which is the best board in the repo to see it on. A player opens `?startapp=demo`, watches queues form as they already do, and now sees **a ring fill around a destination that is falling behind, and drain when a car finally arrives**. Partway through the fourth minute the board **goes dark and says which destination shut the city down and how many trips they made** — and a tap starts it again. Nothing here needs to be pointed at, and the whole sequence is reachable without the player doing anything at all.

---

## Task 10: The default board flips, behind a measured survivability gate

**Files:**
- Modify: `packages/sim/src/spawn.ts` (the house-proximity scan), `packages/game/src/layouts.ts` (`DEFAULT_LAYOUT_ID` and the paragraph arguing the old one), `packages/game/src/startingCity.ts` (`:18`, `:26`), `packages/game/src/demoLayout.ts` (the headline, plus the shutdown line Decision 7 owes it), `packages/game/src/main.ts` (prose)
- Test: `packages/sim/test/spawn.test.ts`, `packages/game/test/layouts.test.ts`, `packages/game/test/startingCity.test.ts`, `packages/game/test/demoLayout.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9. The gate cannot be measured before Task 8, because "does a connected destination ever reach its timer cap" is a question about a meter that does not exist until Task 7 and a run length that does not exist until Task 8. **That is why this task is here and not inside Task 5**, where the first draft put it.
- Produces: `nearestSameColourHouseChebyshev(state, world, cell, colour): number`; `DEST_SPAWN_HOUSE_TIERS` (a frozen `Int32Array` of radii). No signature changes.

### The decision this task makes, stated before it is measured

**M1e's difficulty does not come from demand, and the review's recommended lever does not work.** Both halves are measured, and this task ships the lever that does.

**What was measured, on `firstCity` with Decision 13's 20-tile opening and a scripted greedy-connect policy, three seeds, twelve weeks:**

- **Tiles are not the constraint and were never close to it.** The entire twelve-week destination-connection bill is **41–57 tiles against 390 granted**; the greedy policy spends **47–64** and ends with 61–332 unspent. **Zero unaffordable events in fifteen runs.** The median connection costs **3 tiles**. So *"the game reduces to did you reach the new destination in time against 30 tiles a week"* is false: reaching is free.
- **Biasing `spawnScanStart` toward existing ROAD — the review's first-choice lever — does nothing, three ways.** Mean connect cost **4.6 → 4.6 tiles** (median 4 → 3). Mean greedy survival **6.0 weeks → 4.3–5.0**, i.e. *worse*. And it *lengthens* the mean round trip rather than shortening it (week 4: **767 ticks against a baseline 169**). The reason is geometric: a destination needs seven road-free cells at Chebyshev ≥ 2 from every other destination, which does not exist one or two cells from a road, so every tight tier falls through to the unfiltered pass.
- **The actual mechanism is a mismatch between how demand is scheduled and how service is routed, and `dispatch.ts` already names it.** `advanceAccumulators` round-robins pins **evenly** across a colour's rotation slots, while `assembleSources` seeds the colour's flow field at *every* carpark with pins and cars flow to the **nearest** one — `dispatch.ts:624-627`, *"Decision 4's stated cost: a house routed by the field to a destination whose every pin is already spoken for … does not reach past its nearest destination."* Measured on the greedy baseline at twelve weeks, one colour: destination 2 took **297 trips**, destination 6 took **10**, destination 10 took **0** — a 30× service imbalance against a 2:1 demand ratio. **And §5.9's own rule compounds it**: new houses spawn within Chebyshev 2 of an existing same-colour house, so a colour's houses cluster and permanently pin which of its destinations is "nearest". A destination that spawns far from your houses **cannot be saved by any road you build.**
- **So the lever is the other half of the same file: bias the destination scan toward the spawning colour's OWN HOUSES.** Measured: mean greedy survival **6.0 → 7.7 weeks**; mean round trip at week 11 **360 → 153 ticks** (ratio to `4 · pinPeriodForWeek` 0.365 → 0.156); dropped pins **85 a week by week 10 → 0 for the whole run**; and — the part that matters most — peak `destPins` on **connected** destinations goes **1 → 2 → 10 across nine weeks** where the baseline goes straight from 1 to the hard cap. **That is a gradient where the baseline is a step, and a gradient is what a difficulty curve is.**

**And the residual is named rather than hidden.** Even under the lever, one colour's cluster still starves (four of thirteen destinations on the measured seed). The real fix is to close the round-robin-versus-nearest mismatch — seed a colour's field only at its most-starved destination, or weight by `destPins`, or route the rotation to the shortest queue instead of the next slot. **That is a change to §5.3's stated scheduling rule and to `dispatch.ts`'s Decision 4, and it is M1f's**, carried with this measurement. M1e ships the cheap half that lives entirely inside `spawn.ts`.

- [ ] **Step 1: Write the failing scan test**

```ts
  it('prefers a cell near the spawning colour\'s own houses, and falls through when none fits', () => {
    // Vacuity in both directions: there must be a near cell that is chosen and
    // a far cell that is chosen only when nothing near fits. A fixture where
    // every cell qualifies cannot see the tiering, and one where none does
    // cannot see that the fallback works.
    const r = rig('house-tier')
    placeHouseAt(r, HOUSE_CELL, 0)
    armDestinationTimerForNextTick(r.state)
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    const placed = lastDestination(r.state)
    expect(nearestSameColourHouseChebyshev(r.state, r.world, placed.cell, 0))
      .toBeLessThanOrEqual(DEST_SPAWN_HOUSE_TIERS[DEST_SPAWN_HOUSE_TIERS.length - 2] as number)

    // The fallback: block every cell within every finite tier and confirm a
    // destination still spawns rather than the colour silently starving.
    const far = rig('house-tier-fallback')
    placeHouseAt(far, HOUSE_CELL, 0)
    blockEveryCellWithinTier(far, HOUSE_CELL, LAST_FINITE_TIER)
    armDestinationTimerForNextTick(far.state)
    step(far.state, far.world, far.fields, far.scratch, NO_INPUT)
    expect(far.state.header[H_DEST_COUNT], 'the unfiltered pass must still place one')
      .toBe(1 + destsBefore)
  })

  it('spends at most SPAWN_CANDIDATE_LIMIT placement tests across ALL tiers', () => {
    // The tiers make the CHEAP test (one Chebyshev per same-colour house) run
    // over the whole zone, which is fine; the expensive one
    // (`canPlaceDestination` x 4 orientations, each walking every incumbent)
    // stays bounded by the same budget it had before, shared across tiers and
    // not renewed per tier. Without this the worst case is 6 x 24 x 4 calls in
    // one tick.
    const r = rig('house-tier-budget')
    const before = countPlaceChecks(r)
    attemptDestinationSpawn(r.state, r.world)
    expect(countPlaceChecks(r) - before).toBeLessThanOrEqual(SPAWN_CANDIDATE_LIMIT * ORIENTATION_COUNT)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -r --no-bail --filter './packages/sim' test -- spawn`
Expected: FAIL with `nearestSameColourHouseChebyshev is not defined`.

- [ ] **Step 3: Implement the tiered scan**

In `packages/sim/src/spawn.ts`:

```ts
/**
 * Radii for the destination scan's tiers, in Chebyshev cells, ending in a
 * sentinel that admits every cell.
 *
 * **Ring-expanding around the SPAWNING COLOUR'S OWN HOUSES, not around road**,
 * and that distinction is the whole of plan Task 10's measurement. A road bias
 * changes the connect cost by nothing (mean 4.6 -> 4.6 tiles), lengthens the
 * mean round trip (169 -> 767 ticks at week 4) and shortens greedy survival
 * (6.0 -> 4.3 weeks); a house bias shortens the round trip 2.4x, takes dropped
 * pins to zero and turns peak `destPins` on connected destinations from a step
 * into a gradient. The failure this addresses is not "the player cannot afford
 * to reach it" — tiles run 6-8x slack — it is "cars route to the NEAREST
 * unfilled pin (§5.4) while demand round-robins EVENLY, so a destination far
 * from its colour's houses is never served and no road the player builds can
 * change that."
 *
 * A frozen `Int32Array` at module scope, not a literal array in the function:
 * this file runs inside the tick.
 */
const DEST_SPAWN_HOUSE_TIERS = new Int32Array([1, 2, 3, 5, 8, 0x7fffffff])

/**
 * The smallest Chebyshev distance from `cell` to any house of `colour`, or
 * `0x7fffffff` when the colour has none. Allocation-free; the caller has
 * already established the colour has at least one house, so the sentinel is
 * unreachable through `attemptDestinationSpawn` and is a fail-open value rather
 * than a state.
 */
export function nearestSameColourHouseChebyshev(
  state: GameState, world: WorldData, cell: number, colour: number,
): number {
  const x = cell % world.w
  const y = (cell / world.w) | 0
  const houseCount = state.header[H_HOUSE_COUNT] as number
  let best = 0x7fffffff
  for (let h = 0; h < houseCount; h++) {
    if ((state.houseColour[h] as number) !== colour) continue
    const hc = state.houseCell[h] as number
    const dx = Math.abs((hc % world.w) - x)
    const dy = Math.abs(((hc / world.w) | 0) - y)
    const d = dx > dy ? dx : dy
    if (d < best) best = d
  }
  return best
}
```

and replace `attemptDestinationSpawn`'s single scan loop with the tiered one, keeping everything else — the colour selection, the cursor advance, the `BOARD_FULL` handling, the orientation rotation — byte-for-byte as Task 5 wrote it:

```ts
  const start = spawnScanStart(state, zoneCells)
  let budget = SPAWN_CANDIDATE_LIMIT < zoneCells ? SPAWN_CANDIDATE_LIMIT : zoneCells
  for (let t = 0; t < DEST_SPAWN_HOUSE_TIERS.length && budget > 0; t++) {
    const radius = DEST_SPAWN_HOUSE_TIERS[t] as number
    for (let k = 0; k < zoneCells && budget > 0; k++) {
      const zoneIndex = (start + k) % zoneCells
      const cell = spawnZoneCellAt(zoneIndex, world)
      if (nearestSameColourHouseChebyshev(state, world, cell, colour) > radius) continue
      budget--
      for (let o = 0; o < ORIENTATION_COUNT; o++) {
        const orientation = (zoneIndex + o) % ORIENTATION_COUNT
        if (!destinationFitsSpawnZone(cell, orientation, world)) continue
        if (placeDestination(state, world, cell, orientation, colour, DEST_KIND_SQUARE)) {
          return SpawnOutcome.PLACED
        }
      }
    }
  }
```

**The budget is shared across tiers and is not renewed**, so the expensive test runs at most `SPAWN_CANDIDATE_LIMIT × ORIENTATION_COUNT` times per attempt exactly as before. The cheap proximity test runs at most `zoneCells × tiers` times, which is 308 × 6 integer comparisons times the colour's house count, once every 2,250 ticks.

**The full-zone-scan branch of `BOARD_FULL` changes meaning and must move.** Task 5 returned `BOARD_FULL` when `limit >= zoneCells`, i.e. when the scan had covered everything. The tiered scan's last tier is unfiltered, so it covers the whole zone whenever the budget allows — replace that condition with `budget > 0 after the last tier`, which is the same claim ("we looked everywhere and nothing fits") stated against the new loop.

- [ ] **Step 4: Flip the default board**

In `packages/game/src/layouts.ts`:

```ts
export const DEFAULT_LAYOUT_ID = CITY_LAYOUT_ID
```

and rewrite the comment above it. It currently argues the demo is the default because *"the starting city is inert on the board that ships… A player opening it sees six cars that never move. M1d's blocking, M1d's ghost roads and M1d's lane speeds cannot fire there at all."*

**Do not replace it with the mirror-image overclaim.** Three of those four clauses stop being true and one does not, and the replacement must say which:

- *"six cars that never move"* — **ends.** The spawner adds houses and destinations from tick 300, and a player who draws the 20-tile opening has cars running immediately.
- *"M1d's blocking cannot fire there"* — **ends, late.** Measured on the greedy arm: `blockedTicks` is 0 through week 5, 889 at week 8 and 14,199 at week 11, and the longest queue reaches 4. It is a week-9 property, not a first-minute one.
- *"nothing can add a car"* — **ends.** That is the whole of Task 5.
- **`refusals` stays 0 on this board for the whole measured run**, where the demo board scores thousands. Say so. The starting city after M1e is a board that **loads up and eventually fails**, not a board that grinds; those are different feelings and only one of them is the demo board's.

Give the replacement the three checkable facts from Decision 13: the opening is solvable for **20 of 30** tiles (18 `place` actions, all accepted — verified) down columns 8 and 17; the river's two-cell land gap at rows 18–19 keeps the board connected without bridges; and the demo board keeps its id, its seed, its warm start and its golden and is one token away.

Repoint the same claim in `packages/game/src/demoLayout.ts` (*"it is the board a plain load now opens on"*), in `packages/game/src/main.ts`, and at `packages/game/src/startingCity.ts:18` and `:26` — **`:26` says "M1e REPLACES THIS FILE", which is false: M1e spawns around this seed, it does not replace it.**

**And `demoLayout.ts`'s playtester headlines gain a fifth line** (Decision 7): the demo city shuts down at 3 minutes 43 seconds, on the destination at the top of corridor C, and a tap starts it again. Those headlines are what a person is told to look for, and this file has shipped a wrong one before.

Update `packages/game/test/layouts.test.ts`'s detector — *"the default is the demo board, by name"* — to name the city, keeping it a **named** assertion so a flip fails there first with the id in the message rather than diffusely across twenty boards' worth of assertions.

- [ ] **Step 5: Write the gate, with its pass numbers stated BEFORE the run**

**This replaces the first draft's Step 13, whose gate was *"if the board never reaches four colours, or if the no-input run places nothing"* — measured against the first draft's own build, colours founded at weeks 2/3/4, 22 houses, 11 destinations, 0 out-of-rect. Neither clause could fire.**

Three arms, **five seeds** each, twelve weeks, on the real boot path:

1. **No input.** Nothing but the seed.
2. **The 20-tile opening**, then nothing.
3. **Greedy-connect**: every 30 ticks, find the lowest-index destination not joined by road to a same-colour house and buy the cheapest path joining the carpark's road component to any same-colour house's component, if affordable. Scripted, deterministic, replayable as an input log.

Record per week, per arm: destinations placed and connected; houses per colour; the week each of colours 2–4 was founded; `maxInFlight`; `longestQueue`; `refusals`; `blockedTicks`; dropped pins; trips; tiles spent and remaining; **peak `destPins` and peak `destOvercrowd` split into road-connected and not**; mean and p90 round trip; and the ratio `meanT / (4 · pinPeriodForWeek(week))`. Also: whether any spawn ever landed outside the revealed rect (it must not).

**The gate, in three parts. Each is a stop-and-report if it does not hold.**

- **GATE A — the board is not inert.** On the greedy arm, peak `destPins` on **road-connected** destinations must show a **gradient**: at least one week at 1, a later week at ≥ 2, and a later week at the hard cap. *If no connected destination ever reaches its timer cap over ten weeks, the schedule constants are wrong and are fixed here, not in Task 12.* Measured under the lever on the reference seed: **1 through week 8, 10 from week 9**, with peak `destOvercrowd` on connected destinations **0 through week 8**.
- **GATE B — the board is not doomed by something the player cannot control.** Dropped pins must be **0** for the first eight weeks (measured: 0 for the whole run under the lever, against 85 a week by week 10 without it), and `tilesLeft` must be > 0 at every connect decision in every seed (measured: 61–332 unspent at the end, zero unaffordable events in fifteen runs).
- **GATE C — the flip is an improvement on the thing that demoted this board.** The four figures that demoted it were `maxInFlight` 1, `refusals` 0, `ENTER_VALVE` 0 and a maximum of one car in flight. Require `maxInFlight ≥ 3` and `longestQueue ≥ 4` and `blockedTicks > 10,000` by week 11 (measured under the lever: 3, 4 and 14,199). **`refusals` is expected to stay 0 and is reported rather than gated** — see Step 4; this board loads up, it does not grind.

**Survival in weeks is REPORTED, not gated, and that is deliberate.** Three seeds gave 3 / 11 / 4 weeks without the lever and 10 / 6 / 7 with it — a mean of 6.0 against 7.7, on a spread wide enough that a survival threshold at n = 3 would be a coin flip. **The gate is on the shape (Gate A) and on the absence of unplayable failure (Gate B), because those reproduced across every seed and survival did not.** Report all five seeds' survival weeks in the commit message so M1f inherits the distribution rather than a mean.

**Both the lever and the baseline are measured, in the same run.** If the baseline passes Gate A and the lever does not, ship the baseline and say so.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`

Expected: **no golden moves.** The scan change alters which cell a destination lands on, but the only golden fixture whose zone is non-empty is Task 6's demand golden, whose 20×9 board clips the zone to nothing, and the state golden's 4×4 does the same. `layouts.test.ts` and any test that asserts on `DEFAULT_LAYOUT_ID` move by name. **`integration.test.ts` pins `city` explicitly and is unaffected by the flip itself** — it was already on this board — but it IS affected by the scan change, so re-derive anything Task 5 already re-derived that names a specific spawned cell.

- [ ] **Step 7: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `DEST_SPAWN_HOUSE_TIERS`: drop every finite tier, leaving the sentinel | the near-cell assertion in Step 1 — this is the baseline, so it must be distinguishable |
| `DEST_SPAWN_HOUSE_TIERS`: drop the sentinel | the fallback arm (the colour never places a destination) |
| Renew the budget per tier | Step 1's budget assertion |
| `nearestSameColourHouseChebyshev`: `dx + dy` instead of `max(dx, dy)` | the near-cell assertion, with a fixture offset diagonally so the two metrics disagree |
| `nearestSameColourHouseChebyshev`: drop the colour filter | a fixture with two colours' houses, asserting the chosen cell is near the SPAWNING colour's |
| `DEFAULT_LAYOUT_ID` back to demo | `layouts.test.ts`'s named default assertion |
| Bias toward road instead of houses | **no unit-test detector — this is what Step 5's gate is for.** Record it as the mutation the gate exists to catch, and run it: Gate A's gradient is what separates them |

- [ ] **Step 8: Commit**

```bash
git add packages/sim/src/spawn.ts packages/sim/test/spawn.test.ts packages/game/src packages/game/test
git commit -F - <<'EOF'
feat(game): the board a plain load opens is the one where something happens

DEFAULT_LAYOUT_ID flips back to `city`, behind a gate that could only be
measured once overcrowd and game over existed — which is why this is its own
task and not part of the spawner.

The gate found that the difficulty this milestone thought it was shipping is not
where it thought. Measured over five seeds and twelve weeks with a scripted
greedy-connect arm: tiles are 6-8x slack (the whole connection bill is 41-57 of
390 granted, median connection 3 tiles, zero unaffordable events), so "did you
reach it in time" is not the game. The real term is a mismatch dispatch.ts
already names as Decision 4's stated cost — demand round-robins EVENLY across a
colour's rotation slots while cars flow to the NEAREST unfilled pin, so a
destination far from its colour's houses is never served and no road the player
builds can change that. One colour measured 297 trips to one destination, 10 to
another and 0 to a third, against a 2:1 demand ratio.

So the spawn scan is tiered by proximity to the spawning colour's OWN HOUSES,
not to existing road. The road bias the review proposed was measured and
rejected: connect cost 4.6 -> 4.6 tiles, mean round trip 169 -> 767, greedy
survival 6.0 -> 4.3 weeks. The house bias gives round trip 360 -> 153 at week
11, dropped pins 85/week -> 0, and peak destPins on CONNECTED destinations
1 -> 2 -> 10 across nine weeks where the baseline steps straight to the cap.
A gradient is what a difficulty curve is.

The residual is carried to M1f rather than hidden: closing the round-robin /
nearest-source mismatch is a change to §5.3's scheduling rule and to
dispatch.ts's Decision 4, and it is the term that still starves one clustered
colour even under the lever.

Survival weeks are reported per seed and not gated — three seeds gave 3/11/4
without the lever and 10/6/7 with it, and a threshold on that spread would be a
coin flip. The gate is on the gradient and on the absence of dropped pins, which
reproduced everywhere.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
```

**Observability:** this is the flip, and from here the board a plain load opens is the starting city. A player sees a nearly-empty board with three houses and three destinations, draws a road with their finger, and watches cars run it. Then, without being told: **new houses appear next to the ones they already know**; at around 1:15 **a new destination appears somewhere they have no road to**; at week 2 **a colour they have never seen founds a house**; the tile counter jumps by 30 every 2:30; and from about week 9 **the network they built stops keeping up** — queues of four, cars standing, and a ring filling on a destination they thought they had covered.

**The honest limit, stated here rather than found by the user:** for the first eight weeks — the first twenty minutes — the only way to lose is to leave a destination unconnected, and a competent player will not. **The board is easy for twenty minutes and then it is not.** Whether that is a good opening or a boring one is exactly what Task 12's device session asks, and it is the question with the least evidence behind it in this milestone.

---

## Task 11: Routing stays congestion-blind, and the comment sweep

**Files:**
- Create: the congestion-blindness property test in `packages/sim/test/flowfield.test.ts`
- Modify: whatever `grep -rn "M1e" packages/ --include="*.ts"` returns, which at the time of writing is **63 hits across 30 files**, plus the three overstated or stale claims named in Step 4.

**Interfaces:**
- Consumes: everything landed so far. Produces no new API. **This task is independent of Tasks 3–10 in code and must run after them in time**, so the sweep sees the final source.

- [ ] **Step 1: Write the property test that the field cannot see traffic**

```ts
  it('the field is byte-identical under any occupancy, on a board that is actually jammed', () => {
    // Spec §1: "path cost contains no congestion term... This omission is
    // deliberate and load-bearing; it is the game." M1e does not fix the
    // routing/movement disagreement M1d recorded, because there is nothing to
    // fix — what it owes is a DETECTOR, because the field golden runs on a
    // fixture with NO CARS and an occupancy-dependent edge cost would leave it
    // green.
    const r = jammedRig()
    for (let i = 0; i < JAM_TICKS; i++) step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    // Vacuity: there must genuinely be a jam, or this asserts over an empty
    // board and proves nothing.
    expect(refusalsIn(r)).toBeGreaterThan(0)
    expect(longestQueueIn(r)).toBeGreaterThanOrEqual(3)
    // And the sim must be live, or "byte-identical under any occupancy" is
    // trivially true of a frozen buffer.
    expect(isGameOver(r.state)).toBe(false)

    const before = foldedFieldsHash(r.fields)
    const rebuildsBefore = r.scratch.counters[CT_REBUILDS] as number
    for (let c = 0; c < r.state.occupancy.length; c++) r.state.occupancy[c] = (c % 7) - 1
    for (let i = 0; i < r.state.carBlockedTicks.length; i++) r.state.carBlockedTicks[i] = MAX_BLOCKED_TICKS
    assembleSources(r.state, r.world, r.scratch)
    syncFields(r.state, r.world, r.fields, r.scratch)
    expect(foldedFieldsHash(r.fields), 'occupancy must not change a single distance').toBe(before)
    expect(r.scratch.counters[CT_REBUILDS], 'and must not even trigger a rebuild').toBe(rebuildsBefore)
  })
```

Run it, confirm it fails under a deliberately-added occupancy term in `edgeCost`, and remove the term. **Writing the test for the right reason does not make it able to see** — run it under the mutation it was written for.

- [ ] **Step 2: Record the `NB` trap where the next person will hit it**

Rewrite `scratch.ts`'s penalty-routing note so it names M1f's motorway tier as the live threat rather than M1e's upgrades, and keep every load-bearing sentence: `NB = DIAG_COST + 1 = 15` is the **exact** minimum with zero slack (an earlier comment read the spread as 4 and instrumenting 200 seeded random graphs measured the true maximum at 14 — a 3.5× overestimate of headroom that does not exist); `assertBucketCountExceedsEveryEdgeCost` inspects only `edgeCost(k)`, so a penalty applied **inside** `computeFlowField` rather than through the cost function keeps the assert passing while the Dial queue aliases two distances into one bucket — **wrong paths, no crash**; and a *per-cell* penalty makes cost depend on more than direction, so `edgeCost(dir)` and everything derived from it goes structurally blind and the **signature** is what has to change. Add that M1e changed no edge cost, so `DISTINCT_EDGE_COSTS` is still 2 and the value set is still `{10, 14}`.

- [ ] **Step 3: Repoint every comment that names M1e**

**A comment that names a milestone which passed is worse than no comment — it reads as satisfied.** That is how the bot URL went stale and how board expansion survived a milestone. **Do not work from this list alone; Step 4 is the authority.** The list is here so the non-obvious calls are decided in advance rather than by whoever is holding the grep.

- **`regions.ts`** — six dated reasons say *"M1e's demand-actuated lights make car positions a field input"* (the car regions, `occupancy`, `carBlockedTicks`, and both ghost regions' "dated: M1e, with occupancy"). M1e ships no lights: repoint all six to **M1f** and say why the date moved.
- **`scratch.ts:34,40,57,59,136`** — the motorway/third-edge-cost-tier predictions. Repoint to **M1f**, and correct rather than repoint where the prediction was wrong about the mechanism, in the form the file already uses for M1d.
- **`state.ts:460`**, **`dispatch.ts:688`**, **`trips.ts:63`** — *"M1e's destination removal"*. M1e removes no destination; all three properties are still inert. Repoint to **M1f** and, at `dispatch.ts:688`, keep the sharpened trigger ("a dispatch-time read of a shared, non-commutative resource") rather than only the milestone name.
- **`cars.ts:129`** — *"M1e's motorway tier is the next thing that touches this"*. Repoint to **M1f**.
- **`buildings.ts:31`** — *"building placement is an explicit, out-of-band call the M1e spawner will eventually drive"*. **Mark satisfied**: `spawn.ts` is the caller, and both predicates are now on a per-tick path — which that comment explicitly warned against — so the warning is replaced by the fact that Task 4 made them allocation-free, singletons included.
- **`roads.ts:167`**, **`shared/constants.ts:38`** — *"what M1e's traffic lights and roundabouts are for"*. Repoint to **M1f**.
- **`shared/constants.ts:104`** — *"M1e's tuning is the first real evidence"* about the 1,350-tick valve. **Mark answered with a number** from Task 12's long run, or repoint if that run does not fire the valve.
- **`shared/constants.ts:142,148`**, **`mapFormat.ts:21,29`**, **`maps/firstCity.ts:9`**, **`render/types.ts:124`**, **`canvas.ts:372`**, **`game/shell.ts:173`**, **`shared/test/constants.test.ts:102`**, **`game/test/frame.test.ts` (three sites)** — the board-expansion handoff. Repoint to **M1f**, and at `constants.ts`'s `REVEALED_*` block **delete the false claim that "nothing in `sim` reads these"** and name `spawn.ts`, which does. At `frame.test.ts`, keep the diagonal-corner warning intact: it is the thing that will bite whoever finally makes the fold 2-D.
- **`world.ts:75`** — *"building spawn zones are the M1e spawner's input… when they land, they must be folded into `mapIdHash`"*. **Amend rather than repoint**: they landed, and they are **not** on `MapData` — the zone is the shared revealed rect, so nothing needed folding. State that, and state that a **per-map** zone still would.
- **`render/types.ts:197`** — *"There is nothing to spend until M1e"*, about the tiles readout standing in for §7.2's inventory chip row. **Partly satisfied**: there is now a weekly grant to spend, and still no inventory. Say both.
- **`pointer.ts:391`** — *"there is nothing to spend or choose until M1e"*, on the `HUD_INERT` return. **Same split**: there is now something to spend and still nothing to choose. The card modal is M1f's; repoint that half.
- **`game/src/resolve.ts:476-478`** — *"`prevLive === 0` is the slot that became live INSIDE a `step`, which `step`'s seven phases cannot produce today and M1e's in-`step` spawner will"*. **Mark reached**: `spawn.ts` produces it, measured at tick 360 on `firstCity`. The branch was already written and already correct (it snaps, and `resolve.test.ts` drives it by direct call); what changes is that it stops being a defensive branch and becomes a production path, so nobody deletes it on the strength of its own survival. Same edit at `carSmoothing.test.ts:387`.
- **`game/src/main.ts:309`** — the `initCarSnapshots` ordering note, which predicts *"M1e's in-`step` spawner makes a car appear during the ramp with no prev entry"*. **Mark reached** and keep the rule ("keep the call last").
- **`game/src/startingCity.ts:18` and `:26`** — *"no longer the board a plain load opens on"* and *"M1e REPLACES THIS FILE"*. Both become false in Task 10 and this file appears in no other task's Files list. Repoint `:18` to the fact and delete `:26`'s claim: M1e does not replace it, it spawns *around* it.
- **`sim/demand.ts:76`**, **`sim/dispatch.ts:168`**, **`sim/state.ts:56`**, **`sim/step.ts:110` and `:194`**, **`render/canvas.ts:349` and `:609`**, **`shared/constants.ts:241`**, **`game/test/loop.test.ts`**, **`carSmoothing.test.ts:776`**, and the four `sim/test/*` files the grep names — resolve each against what actually shipped.
- **`demoLayout.ts`** — the headline calling the demo *"the board a plain load now opens on"*, corrected by Task 10; verify it, since this is the file whose fourth headline was wrong once before.

- [ ] **Step 4: Make the sweep a grep, not a hand-list**

```bash
grep -rn "M1e" packages/ --include="*.ts" | sed 's/\(.*\.ts:[0-9]*\).*/\1/' | sort
```

**Resolve every hit.** Step 3's list covered roughly half of the 63 when it was written, and a hand-list is exactly the artefact that let board expansion survive a milestone addressed to it in eight files. Every surviving hit must be one this task deliberately kept — a satisfied-and-recorded note — and the grep is what says so, not a reading of the diff. **Check by grep per item, not by reading**: a handoff document once passed a reading with two of its eight items simply absent.

- [ ] **Step 5: Correct three claims that are stale or overstated, none of which mentions M1e**

The grep cannot find these and each is the catalogue's *"a comment that overstates its case is the same defect class as a test that cannot fail"*.

1. **`game/src/resolve.ts:303-309`** claims *"no car is ever drawn more than 0.2 cells from where the sim says it is, on any board, at any frame rate, through any discontinuity."* Measured: that is true of `drawCurrXY` against `currXY` **at tick boundaries**, and false of what is on screen during a **multi-tick drain**. `drawPrevXY → drawCurrXY` spans the whole drain while `prevXY → currXY` spans only the last tick, so after a 7-tick burst the mid-frame divergence `lerpCar − drawCar` reaches **0.462 cells, 2.31 × `MAX_DRAW_LAG_CELLS`**, while the tick-boundary gap is exactly 0. `carSmoothing.test.ts`'s 30 s survey cannot see it because at 60 fps every drain is 0 or 1 tick. Restate the bound with its scope, add the measured multi-tick figure, and record the reproduction (a 2,000 ms stall moves the drawn car 0.616 cells in one frame against a steady 0.066 — still better than the exact renderer's 0.990, which is why this is a documentation fix and not a regression).
2. **`game/src/pointer.ts:288-290` and `:425-426`** both say `main.ts` calls `setPaused` on a Telegram `deactivated` event or on `visibilitychange`. **Neither exists.** `visibilitychange` (`main.ts:521-525`) calls only `pointer.abort()`, and there is no `deactivated` handler anywhere. Until Task 9 the HUD clock tap was the only production caller of `setPaused`; after Task 9 there is none from the pointer at all and `loop.end()` is the only writer. Correct both, and keep the *rule* they were justifying ("no board input while paused", not "no board taps while paused") — the rule is right, its stated caller was not.
3. **`game/src/eraseControl.ts`** — the control stays visible with `is_active: true` after the run ends, and `offClick` (declared at `telegram.ts:76`) is never called anywhere. A live "ERASE ROADS" bar on a dead game is cosmetic — board input is refused and Task 9's early return sends every canvas tap to `restart` — but it is wrong, and it is one line of a `hide` API this control does not have. **Record it in the source and in `m1f-carry-forward.md` with M1f as the recipient**; do not add the API here.

- [ ] **Step 6: Confirm the two labelled-inert equivalent mutants are still inert**

Both were carried forward as *correct as labelled, and must not be "fixed" by adding a test that cannot fail*, each with a named condition that ends it:

1. **The rounding direction of the lane-speed multiplier average** (`cars.ts`, `laneSpeedMul`) is inert because `speedUnits` maps each of 583/584 to 192 and each of 416/417 to 137 — *"over the whole reachable set, not over a sample"* — and it **stops being inert the moment `CAR_SPEED_UNITS_PER_TICK` or any multiplier constant changes**. M1e changed neither: assert that by reading the constants, record it in `cars.ts`, and **do not manufacture a detector**.
2. **`y < 0` in `stepCell`** (`roads.ts`) is a verified equivalent mutant through either caller. Untouched by this milestone. **Do not tighten either caller's `next < 0` to `next === -1`** to manufacture one — that satisfies the bullet by strictly weakening two guards.

M1e adds two more to the register, both with derivations rather than assertions, and both recorded at their sites in Tasks 6 and 7: the `while`-drain spelling in `advanceAccumulators`, and `spawnScale`'s `>=`-vs-`>` cap comparison.

- [ ] **Step 7: Run the suite and commit**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`

```bash
git add packages
git commit -m "$(cat <<'EOF'
docs+test(sim): routing is congestion-blind on purpose, and it finally has a detector

The field golden runs on a fixture with no cars, so an occupancy-dependent edge
cost would leave it green. A property test on a genuinely jammed board now
rewrites occupancy and carBlockedTicks arbitrarily and asserts byte-identical
fields and an unmoved CT_REBUILDS — with a liveness guard, because that property
is trivially true of a frozen buffer.

Plus the comment sweep, driven by grep rather than by a hand-list: every "M1e"
in packages/ is now satisfied-and-recorded or repointed to a real recipient. Six
FIELD_IRRELEVANT dates, three destination-removal triggers, the whole
board-expansion handoff, the false claim that nothing in `sim` reads REVEALED_*
(spawn.ts does), and two predictions that came TRUE and must stop reading as
warnings — resolve.ts's `prevLive === 0` branch is now produced by the spawner
at tick 360, and main.ts's initCarSnapshots ordering is now a requirement rather
than an equivalence.

Three stale or overstated claims the grep cannot find, each corrected with a
measurement: resolve.ts's 0.2-cell divergence bound is a tick-boundary bound and
reaches 0.462 cells mid-frame during a multi-tick drain; pointer.ts names two
setPaused callers in main.ts that do not exist; and the erase control stays
visible after game over, recorded for M1f.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** nothing, and this task is the clearest case in the milestone of work that is worth doing anyway. A player cannot see a comment. What they will see, one milestone from now, is whether the person who adds the first congestion penalty finds the `NB` trap written down before they hit it or after — and whether the person who finally smooths a deceleration finds `resolve.ts`'s bound stated with its scope or stated absolutely and wrong.

---

## Task 12: Integration, the long run, the tick order re-measured, the deploy, and the handoff

**Files:**
- Modify: `packages/game/test/integration.test.ts`, `packages/sim/test/loop.test.ts` (the long run), `packages/game/test/allocation.test.ts`, `packages/sim/src/step.ts` (the re-measurement record), `packages/game/src/main.ts` (`?startapp=fallback`)
- Create: `docs/superpowers/m1f-carry-forward.md`

**Interfaces:** consumes everything. Produces no new API.

- [ ] **Step 1: The end-to-end test asserts the NUMBERS Task 10 measured, not a comparison**

Task 10's gate already established what this board does; this step is where it becomes a test in the suite rather than a figure in a commit message. **The first draft's gate here was *"survives strictly longer and scores strictly more"*, which is not a gate**: it is satisfied by 8,660 > 5,579 and 70 > 0, i.e. by a run that is unwinnable after four minutes.

Drive the **city layout through its real boot path**, three arms, and assert Task 10's recorded figures with a stated tolerance rather than an inequality:

1. **No input.** The run ends; `H_SCORE` is 0; `failedDestination` is **D2 specifically** — not merely "a destination that was never connected", which on a board with no roads is every destination and therefore an assertion about nothing; and the end tick is **5,580**, hand-derived in the test comment rather than recorded from the run.

   The derivation, which is the whole content of this arm: **D2 is colour 1's lone circle**, so both of `slotCount(1) = 2`'s rotation slots are its own and it receives a pin every 259 ticks where colour 0's two squares get one per 518 each. First pin at 378, at its trigger cap of 8 at tick 2,191, and the k-th at-cap tick is `2,190 + k`, so `k = 3,390` gives **5,580**. **The lower-indexed square D0 would die at 6,357** — stating which of the two dies, and why the higher trigger cap does not save the circle, is what makes this a derivation rather than a recorded number. **A circle carries two rotation slots and a square one** (`computeSlotCounts`, `demand.ts:294`).

   **And the derivation is robust to the spawner, which is worth stating because it looks like it should not be.** Task 5 adds destinations to this board even with no input, and a new colour-1 destination changes `slotCount(1)` — but **each rotation slot still receives one pin per `period` regardless of how many destinations the colour has**, so D2's own rate is untouched and 5,580 holds. Any destination the spawner adds gets its first pin 120 ticks after spawning and cannot complete a meter before roughly tick 8,300, which is after D2.
2. **The 20-tile opening.** Assert the per-week `maxInFlight`, `longestQueue`, `refusals`, `blockedTicks`, peak `destPins` and peak `destOvercrowd` figures Task 10 recorded, and the run length. Guard against degeneration: cars dispatched > 0, score > 0.
3. **The greedy-connect arm.** The scripted policy Task 10 wrote, replayed. Assert the survival week Task 10 recorded, and that the binding constraint is the one Task 10 named.

- [ ] **Step 2: Fold the erase/re-place cycle into the long run, and assert the CORRECTED tile ledger**

Carried forward: *"The shipped long-run test never erases a road, so the ghost path has no long-horizon coverage in the suite — the 25,000-tick evidence lives in a review, not in a test. A finding whose only carrier is a report is the shape this project keeps getting bitten by."*

Extend the long run to ≥ 25,000 ticks with an erase/re-place cycle every 700 ticks, and assert every tick:

```ts
      // **The refund ledger is BUDGET-EXACT, and from M1e it is a conservation
      // law WITH A SOURCE TERM.** The whole-milestone review measured
      // `tiles + roadCells + ghostCells` constant at 9,999 across 25,000 ticks;
      // Task 2's `runWeekBoundary` now injects WEEKLY_TILE_GRANT at each
      // boundary, so the identity gains a term rather than a tolerance.
      //
      // Written as an explicit term and NOT as a loosened range, because the
      // point of the invariant is that place/erase/refund CONSERVE — a range
      // wide enough to absorb a grant is wide enough to absorb a leaking
      // refund. `grantsSoFar` comes from the clock, never from a counter the
      // grant itself writes, or the assertion would be checking the grant
      // against itself.
      const grantsSoFar = weekOfTick(state.header[H_TICK] as number)
      expect(tilesLeft(state) + roadCellCount(state) + ghostCellCount(state))
        .toBe(LEDGER_TOTAL + WEEKLY_TILE_GRANT * grantsSoFar)
      assertOccupancySound(state, world)
      expect(sumReserved(state)).toBe(countPhase(state, PHASE_OUTBOUND))
```

`assertOccupancyComplete` is asserted **only on the ticks where the valve has not fired** — its exception set is real (a car that has not crossed on its current leg, and a car displaced by the valve), and asserting it unconditionally would be asserting something known false.

Also assert, every tick: no counter wraps; `destOvercrowd[d]` is in **`[0, OVERCROWD_FAIL_MILLITICKS + DENOM - 1]`** — **not `[0, OVERCROWD_FAIL_MILLITICKS]`**, because `runOvercrowd` adds the ramp *before* the fail test, so the stored value can overshoot by up to `DENOM - 1` and `step`'s freeze then preserves the overshoot forever; two identical runs agree on `hashState`; and no car starves.

**And the guard that decides whether this test is measuring anything:**

```ts
      expect(isGameOver(state), 'a 25,000-tick invariant sweep over a FROZEN buffer proves nothing').toBe(false)
```

**If that fires, the fixture is what changes, not the assertion.** `jamFixture` is deliberately starved and Task 5 leaves its spawner live, so a destination reaching 3,390 consecutive at-cap ticks inside 25,000 is entirely plausible. The named remedy, in order: give the starved colour a second house so its far destination is served (a fixture change that preserves the jam this rig exists for), and only if that fails, split the sweep at the death tick and assert the freeze separately. **Do not shorten the window to duck it** — a long-horizon invariant sweep that stops before the interesting part is the window-margin defect wearing a different coat.

- [ ] **Step 3: Re-measure the tick order over ten phases**

M1d ran the complete pairwise set C(7,2) = 21 and recorded it in `step.ts` because *"the historical figure of 13 reorderings is written down nowhere and cannot be reproduced from its own description"*. There are now **ten** phases: run **C(10,2) = 45**, stated as an enumeration so it reproduces from this sentence. Record the table in `step.ts`, replacing M1d's.

Four things this must get right:

- **Run the control as many times as the mutant.** M1d's first pass reported 1 detector for each inert swap, which read as "the milestone ended the inertness"; re-run four times each alongside four unmutated baselines, **the baseline itself scored 1 in one round**, and the flake was `allocation.test.ts`'s sampling profiler. A flaky baseline reads exactly like a kill, and `drawAllocation.test.ts` flakes about 1 run in 10 while importing none of these modules.
- **Use the complement check.** Ten of M1d's nineteen non-zero rows collected fewer tests than baseline because those reorderings made `step` throw during test **collection**, so a whole file never ran. Their counts were lower bounds on a partly-unrun suite. Record which rows collected a short suite.
- **State the expected result before running.** Six pairs have a named detector written in Tasks 2, 5 and 7: **`1↔2`** (clock ↔ week grant, Task 2 Step 8), **`1↔3`** (clock ↔ inputs, Task 2 Step 8 — see below), **`1↔4`** (clock ↔ spawn, Task 5 Step 9's stamp test), **`2↔3`** (grant ↔ inputs, Task 2 Step 1's third test), **`3↔4`** (inputs ↔ spawn, Task 5 Step 9's paving test) and **`9↔10`** (arrivals ↔ overcrowd, Task 7 Step 7). **If any of the six scores 0, the detector does not work and the task that wrote it was wrong** — report that rather than recording the zero.
- **`1↔3` is the discharged handoff and it must score NON-ZERO.** M1d's carry-forward records it (in the old numbering, "the clock advance after input application") as a 0-detector no-op in 4 of 4 rounds. It stops being one here, and not because a `TickAction` learned to read `H_TICK` — `TickActionKind` is still `'place' | 'erase'` and `step.test.ts`'s tripwire on that condition still holds. It stops because **a clock reader now sits between the two**: transposed, `runWeekBoundary` reads the un-advanced tick and misses the boundary. Record that reasoning in `step.ts` beside the number, because a future reader who finds a non-zero on a row M1d called inert will otherwise go looking for the wrong cause. **`3↔4` in the OLD sense — inputs against demand, now `3↔5` — is predicted to remain 0.**

- [ ] **Step 4: Extend the tick-side allocation profile to the three new phases**

`allocation.test.ts` profiles `packages/game/src` **and** `packages/sim/src` and measures the tick. Its rig must now enter the new branches, gated on **per-branch entry counters asserted non-zero** in the style of the existing `DragCounters`: week boundaries crossed; house spawns attempted **and** succeeded; destination spawns attempted **and** succeeded; `SpawnOutcome.BOARD_FULL` results and blocked-spawn pushes; **flow-field rebuilds on a spawn tick** (Decision 6 prices a spawn at `groupCount` rebuilds and this is where the price is measured rather than accepted); destinations over capacity; and arrival knockbacks applied. **A fixture that stops spawning must turn the harness RED, not quietly measure less.**

The destination-spawn path is the one with a real risk: it was allocating in two separate ways before Task 4 and it runs up to 96 `canPlaceDestination` calls on a failing attempt. **Reinstate BOTH pre-Task-4 allocations as positive controls, separately** — the `allSevenCells` array and one fresh `{ ok, reason }` literal — confirm the harness charges each, and remove them. A control that reinstates only the array leaves the singleton fix unproven, which is the shape that let a harness be "live and provably blind to the task that had just shipped". Report the figures as a **range over stated draws**, never as a point.

Add the margin guard here too: `expect(isGameOver(state)).toBe(false)` after the final drive, with the end tick and the margin stated.

- [ ] **Step 5: Verify no fourth `Uint8Array` decrement path appeared**

Enumerate every write to every `Uint8` region in `packages/sim/src` — `roads`, `cleared`, `houseColour`, `destMeta`, `destPins`, `destReserved`, `carPhase`, `carRoute`, `ghostMask`, `ghostCommitted`. **Enumerate the writes; do not grep for `--`**: the one path M1d added spells it `const left = committed - 1` across two statements and no `--`-shaped pattern matches it.

The set must still be exactly three (`destPins`, `destReserved`, `ghostCommitted`), and M1e's two new decrements (`destOvercrowd`'s unwind and its arrival knockback) must both be on `Int32` regions and both floored. Note the one new `Uint8` **writer** M1e adds and confirm it only increments: `pushBlockedSpawnDemand` reaches `destPins` through `fireColour`, which adds. Record the result in `trips.ts`'s standing note.

- [ ] **Step 6: Revive `?startapp=fallback`**

Carried forward: *"`?fallback=1`, this project's documented recovery hatch for 'MainButton reported but never rendered', is unreachable on a phone today"* — a Telegram webview has no address bar and the SDK reads `location.hash`, never `location.search`. `layoutToken` (`main.ts`) already reads three sources; wire `?startapp=fallback` into `preferFallback` for the cost of one line, and give it a test that the token reaches the flag. **This is the erase control's recovery hatch**, and without it a client that reports a `MainButton` and never renders one leaves the player unable to erase, with no way to say so.

- [ ] **Step 7: Build, deploy, verify the ARTEFACT**

**Sequencing matters and the order is not negotiable: run the suite, then `pnpm build`, then deploy, then verify — and re-verify rather than re-build if it reports a mismatch.**

`wrangler deploy` can print `Success! Uploaded N files` while the deployment never activates and the previous asset hash keeps being served. `packages/game/scripts/verify-deploy.js` makes **two** fetches: `GET /` must carry `<meta name="laneways-build" content="…">` with the id from `.build-id`, and **the module script the served document actually names** must contain it too — a fresh document pointing at a stale bundle is a blank board and the first check cannot see it.

**A mismatch has three causes, not two.** The artefact is stale; the deployment did not activate; or **the expectation is stale**. The third was blamed on a person for a milestone: vitest loads `packages/game/vite.config.ts` as its own config, so the build-id plugin ran on every `vitest run` and `closeBundle` wrote a fresh id at the end of the test run — including the run immediately before a deploy. `apply: 'build'` fixed it and `test/toolchain.test.ts` pins it. Confirm `.build-id` is untouched by a full suite run before trusting a mismatch.

**The Telegram Mini App URL is set in @BotFather and is NOT settable through the Bot API** — `setChatMenuButton` returns `ok: true` and changes nothing. If the URL must change, say so and stop; it is a human action.

- [ ] **Step 8: One human, one phone, four questions**

The last time a person looked at this game was the demo board on 2026-08-10. Fold every open visual question into one session, because none has any other route to an answer.

**Read this before scheduling it: the demo board now shuts itself down at 3 minutes 43 seconds.** That is by design (Decision 7) and it is also a constraint on the session — question 3's ghost-art check must be done inside that window, or after a restart, and the session should deliberately do one of each so the restart is exercised by a person rather than only by a test.

1. **The new default board.** Open a plain link. Is the nearly-empty starting city legible as *"draw a road here"*, or does it read as a broken load? Does the first spawned building read as an event, or does it just appear?
2. **The overcrowd ring and the shutdown screen.** Let a destination die on purpose. Is the ring readable at phone size against the pin dots already drawn there — they occupy the same few pixels? Does the shutdown screen say what happened, and is the destination it names findable on the frozen board?
3. **The ghost art, which is tested and has never been LOOKED AT.** 182 assertions across three render test files, and zero human minutes. Two pure aesthetic judgements sit inside them: the ghost stroke is **half** the live road's width (`atlas.ts:112`), and spec §6's 55–65 % width band was **deliberately ruled not to apply** (`atlas.ts:120`) on the reasoning that the band governs roads and *"a ghost is the absence of one."* That reasoning is sound and unvalidated. A half-width dashed ghost may read as an elegant fade or as a rendering glitch, and **only a person looking at a phone can tell those apart.** Do this on `?startapp=demo`, where the erase headline needs a **five-cell** stroke to fade three cells (a drag samples adjacent pairs, so a stroke over N cells clears both bits off only the N − 2 in the middle), and whether a cleared cell ghosts at all depends on the traffic at that instant.
4. **Does the run have an ending?** Die, tap, and answer three things: does the tap start a new run at all; does it read as *"tap to play again"* or as *"the app crashed and reloaded"*; and does losing a four-minute run and being returned to an empty board feel like a game or like being thrown out. **This is the question with the least evidence behind it in the whole milestone** — the restart is `location.reload()` and it is correct, and correct is not the same as good.

Record the answers with the words "one device, qualitative" attached, exactly as the 2026-08-10 session did. **It is evidence that the architecture holds, not a measured budget.**

- [ ] **Step 9: Write `docs/superpowers/m1f-carry-forward.md`**

Nothing else does, and it has never been owned by a task — it got written at every prior milestone close anyway, which is a base rate, not a mechanism. **Check it against a checklist of names, not by reading it**: M1d's carry-forward had eleven well-organised sections and 336 lines and two of its eight items were simply absent, and both survivors were the ones with no code artefact to anchor them.

Everything in "What this plan does not settle", every row of the Out table, the golden ledger, the tick-order re-measurement, the equivalent-mutant register and the device answers reach M1f only through this file. Three items are the ones most likely to evaporate, because none has a code artefact:

- **`OvercrowdTimerCarArrivalDeceleration = 0.5`** — dossier §1.10's eighth constant, named and measured in Decision 4 and deliberately not implemented. Carry the measurement with it: it widens the survivable arrival interval for a destination held at its cap from **90 ticks to roughly 300**, and it is a no-op on both shipped boards because both die at an arrival interval of infinity. It becomes worth having the moment a board exists on which a dying destination is still being served.
- **The square→circle upgrade (§5.2)** — the only mechanism in the spec that raises one destination's demand without adding a destination, and therefore the missing half of a graded difficulty model. Carry Decision 2's arithmetic with it.
- **`resolve.ts`'s divergence bound**, corrected in Task 11 Step 5, and the fact that the deceleration half of the smoothing remains jointly unsatisfiable.

- [ ] **Step 10: Commit**

```bash
git add packages docs/superpowers/m1f-carry-forward.md
git commit -m "$(cat <<'EOF'
test(game): the run can be lost end to end, and the milestone hands off

Three arms on the board that ships, each asserting the figures Task 10 measured
rather than an inequality: an unplayed city dies at a hand-derived tick with a
score of 0, naming D2 — colour 1's lone CIRCLE, which carries two rotation slots
and is therefore served twice as often as the lower-indexed square that would
otherwise have died first; the 20-tile opening hits its recorded per-week
figures; and the greedy-connect arm survives its recorded week against its
named binding constraint.

The long run is 25,000 ticks with an erase/re-place cycle every 700 and asserts
the tile-ledger identity every tick — evidence that until now lived only in a
review. The identity now carries an explicit grant term rather than a loosened
range, because a range wide enough to absorb a weekly grant is wide enough to
absorb a leaking refund. destOvercrowd is bounded at FAIL + DENOM - 1, not FAIL:
the ramp is added before the fail test and the freeze preserves the overshoot.
And the sweep asserts the sim is live, because a 25,000-tick invariant check
over a frozen buffer proves nothing.

Tick order re-measured over C(10,2) = 45 pairwise transpositions, with four
baselines per mutant and the complement check on every row. Six pairs were
predicted non-zero with a named detector each, including 1<->3, which M1d
recorded as a 0-detector no-op in 4 of 4 rounds and which this milestone ends by
putting a clock reader between the two.

?startapp=fallback revives the erase-control recovery hatch. Deploy verified
against the served artefact, both fetches. One human, one phone, four questions
— the ghost art, which had 182 assertions and zero human minutes, and whether
the run having an ending feels like a game or like being thrown out.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** the whole milestone, on a phone, held by a person. A plain link opens a board where buildings appear, tiles arrive every two and a half minutes, rings fill on destinations you have not reached, the city eventually shuts down and tells you which destination did it and how many trips you made, and a tap starts you again. If that session does not produce those five sentences unprompted, the milestone missed — and this is the step where that is found out, not the user.

---
## Sequencing: what can be reviewed apart, and where the real dependencies are

- **Task 1 blocks everything.** It is the milestone's only shape change and every later task assumes the regions exist.
- **Tasks 3 and 4 are independent of the rest and of each other.** Task 3 (the flow-field allocation) touches only `flowfield.ts`/`scratch.ts` and is provable by the field tripwire; Task 4 (allocation-free placement validity) touches only `buildings.ts` and is provable by its equivalence run and its allocation measurement. Either could be reviewed by someone with no context on the game loop, and both could run before Task 2 if a reviewer's schedule wanted it.
- **Task 2 must precede Tasks 5–8**, not for code reasons but for the handoff: it is the task that puts a clock reader in a falsifiable position, and doing it after the spawner would mean the spawner lands while the transposition question is still open.
- **Task 5 depends on Tasks 1, 2 and 4** and is the milestone's largest. **Task 4 must land before it** — that is the one ordering in this plan that is a correctness requirement rather than a convenience, because otherwise the spawner puts two allocating predicates on a per-tick path and the allocation harness reports it as a regression Task 5 did not introduce.
- **Task 6 depends only on Task 1** and could be reviewed in parallel with Task 5 by a second reviewer.
- **Task 7 depends only on Task 1. Task 8 depends on Task 7** and is deliberately split from it, so the 3,390-tick arithmetic can be wrong in a test before it can be wrong in a run.
- **Task 9 depends on Tasks 7 and 8, and must be adjacent to Task 8.** Task 8 makes the run terminal and unrecoverable; Task 9 is what gives it a screen and a way out. Between those two commits the build is strictly worse than the one before them, and nothing else may be inserted there.
- **Task 10 depends on Tasks 1–9 and cannot be moved earlier.** Its gate asks whether a *connected* destination ever reaches its timer cap, which is a question about a meter that does not exist until Task 7 and a run length that does not exist until Task 8. **The first draft put this task's content inside Task 5, where the only gate that can be written is machine-side — and machine-side gates on a purpose-built posture are exactly what M1d passed.**
- **Task 11 is independent of Tasks 3–10** in code and must run after them in time, so the sweep sees the final source.
- **Task 12 depends on everything.**

---

## What this plan does not settle

- **Whether the demand ramp's three numbers are right.** Spec §5.3 calls `spawnScale` *"the single most important tuning unknown in the project"* and §13 lists it as an open risk whose mitigation is the telemetry overlay. Measured here: on the shipped board the ramp changes the no-input death tick by **1.0 %** and changes peak `destPins`, longest queue, refusals and blocked ticks by **zero** — while on a 41-cell corridor it is the entire difference between surviving 60,000 ticks and dying at week 9. So it is correctly implemented and its effect is a function of round-trip length, which M1e's board does not produce. Changing it is a `rulesVersion` bump that invalidates stored replays.
- **Whether the round-robin/nearest-source mismatch should be fixed, and how.** This is the biggest single thing M1e leaves open, and it is the term that actually decides whether a connected destination lives. `advanceAccumulators` distributes pins **evenly** across a colour's rotation slots while `assembleSources` routes cars to the **nearest** unfilled pin, so within one colour a measured **297 / 10 / 0** trip split against a 2:1 demand ratio is an ordinary outcome. §5.9's house-clustering rule compounds it. Task 10's lever is the cheap half; the real fix is to seed the field only at the most-starved destination, or weight sources by `destPins`, or route the rotation to the shortest queue — **all three are changes to §5.3's stated scheduling rule and to `dispatch.ts`'s Decision 4, and M1f owns choosing between them.**
- **`MAX_PATH_LEN` = 96 is a hard ceiling on how far a house may be from a carpark, and nothing in the game says so.** Measured: on a 101-cell corridor every dispatch is refused, and a **fully connected** destination is unservable and dies with or without the ramp. On a 14×22 rect a sensible road never approaches 96 steps, but a winding one can, and the failure is silent — `H_ROUTES_REFUSED` rises and nothing else. M1f should either surface it or bound it.
- **Whether `DESTINATIONS_PER_WEEK` = 2 and `HOUSES_PER_DESTINATION` = 2 pace the city well.** Both are [OURS] with no source. Measured over 40 weeks: the schedule delivers **0.275 destinations a week**, the board seats **14** rather than the declared `maxDestinations` of 16 with the last placement in **week 10**, and on the played board it is **13 by week 8** because the player's own road removes candidate cells. After that the spawner is in permanent `BOARD_FULL` for the rest of the run. The cause is geometric — seven contiguous free cells at Chebyshev ≥ 2 from every other destination inside a 308-cell rect carrying a river, eight trees, 27 houses and the player's roads. `HOUSES_PER_DESTINATION` is measured not to be a lever at 1, 2 or 3.
- **Whether 30 tiles a week is right for a 308-cell rect.** It is §5.10's Road Tiles rate on a board a tenth of the original's, and it is measured to be **6–8× slack**: the whole twelve-week destination-connection bill is 41–57 tiles against 390 granted, the median connection is 3 tiles, and there were **zero unaffordable events in fifteen runs**. Tiles stop binding around week 3, and after the colour unlocks end at week 4 the weekly boundary carries nothing but the destination timer — which does not need a week concept at all. **That is the honest cost of deferring the card modal**, and it belongs beside the ramp rather than inside the Out table's argument for the deferral.
- **`OvercrowdTimerCarArrivalDeceleration` = 0.5**, dossier §1.10's eighth constant, dropped by spec §5.8's transcription. Named, measured (it widens the survivable arrival interval for a destination at its hard cap from **90 ticks to 300**) and deferred to M1f, because both shipped boards die at an arrival interval of infinity and its measured effect on each is **zero ticks**. Decision 4.
- **Whether the pin capacities are the right run-length dial.** §5.8 says they are — *"square triggers the timer at 6, hard cap 10; circle at 8, hard cap 14. These are the primary run-length dial. Tune them before touching anything else."* M1e implements them and tunes nothing. Note the asymmetry it discovered: **a circle carries two rotation slots, so it receives pins twice as fast as a square and its higher cap does not compensate** — on `firstCity` the colour-1 circle dies at 5,580 where the colour-0 square would have died at 6,357.
- **Whether one car per lane-tile feels right.** Still **half** the spec's density, on the spec's own two-lane road. Two cars per lane-tile needs sub-cell slots whose identity changes at every turn. **Do not add a `CARS_PER_CELL` constant "for later."**
- **Whether 1,350 ticks is the right valve.** It is the spec's 45 s at 30 Hz, unvalidated in play. At the close of M1d it fired 98 times in 20,000 ticks on a deliberately starved corridor and **never** on the shipped starting city. Task 12's long run on the new default is the first honest count.
- **Frame cost under a full jam, with numbers.** A human reported the demo board smooth throughout at 24 cars — one device, qualitative, no Android, no `performanceClass: LOW`. That retires the fear of a latent cliff at that density; it is not a budget, and the new default board's car count grows without bound as the city fills.
- **`resolve.ts`'s divergence bound is a TICK-BOUNDARY bound, and its comment says otherwise.** Corrected in Task 11 Step 5, and the underlying question is open: during a multi-tick drain the on-screen divergence `lerpCar − drawCar` reaches **0.462 cells, 2.31 × `MAX_DRAW_LAG_CELLS`**, because the drawn interpolant spans the whole drain while the sim interpolant spans only the last tick. At 60 fps every drain is 0 or 1 tick, so `carSmoothing.test.ts` cannot see it; a dropped-frame phone can. It is still better than the exact renderer, which is why this is not a regression, and M1f owns deciding whether it matters.
- **The erase control stays visible and active after the run ends.** Cosmetic — board input is refused and every canvas tap restarts — but wrong, and `offClick` is declared in `telegram.ts` and never called anywhere. Recorded for M1f rather than fixed here.
- **What the restart feels like.** M1e's restart is `location.reload()`: correct by construction, preserves `?startapp=demo`, costs one warm start. It is also a full page reload, and nobody has seen one. Task 12's fourth device question is the only evidence there will be, and a seamless in-place restart (`resetState` in `sim`) is M3's.
- **Whether the opening twenty minutes are good.** Measured: for the first eight weeks the only way to lose the flipped board is to leave a destination unconnected, and a competent player will not. **The board is easy for twenty minutes and then it is not.** This plan makes that statement true and measured rather than unknown; it does not make it good.

---

## Self-review

**1. Spec coverage.** §5.3's demand ramp → Task 6; the destination-pull rotation is unchanged, and Decision 2 records that its *even* distribution against `assembleSources`'s *nearest* routing is the milestone's largest open question. §5.3.5's blocked-spawn redistribution → Task 5, fired on a board-wide refusal only and counted when discarded. §5.8's overcrowd constants, ramp, unwind, knockback, hidden grace, no carpark immunity and immediate shutdown → Tasks 7 and 8; pin capacities were already in `constants.ts` and get their first reader in Task 7; the eighth dossier constant is named and deferred in Decision 4. §5.9's geometric rules → Task 5 (the road rule and the 2×3 clearance were already in `canPlaceDestination`; the neighbourhood radius and the timing constants are new); its spawn weights are declined explicitly. §5.10's week length and flat tile income → Task 2; its card table is deferred to M1f with a full argument, and the measured cost of that deferral is in "does not settle". §5.1's board expansion → deferred to M1f with a full argument. §5.6's lights and roundabouts → deferred to M1f. §5.2's square→circle upgrade → deferred to M1f, with Decision 2's arithmetic attached because it is the missing half of a graded difficulty model. §7.2's HUD → the tiles readout already exists and now has something to report; the inventory chip row waits on items. §11's testing spine — determinism, goldens, property tests — is in Global Constraints and in every task.

**Gap found and closed while reviewing:** §5.9's *"destinations never spawn within 1 tile of another destination"* is the Chebyshev ≥ 2 rule `canPlaceDestination` already enforces, and Task 4's rewrite is the only thing that touches it — which is why Task 4 carries an exhaustive equivalence proof rather than trusting the existing tests, written as they were against the other algorithm.

**Second gap found and closed:** the spawner needed a rule preventing a destination in a colour with no houses, and the first draft of Decision 8 did not have one — colours 2, 3 and 4 of `firstCity` would have deadlocked silently, and under Task 7 a destination nobody can serve is a guaranteed loss the player could not prevent. The founding exemption and the house filter are both in Task 5, both tested, and both mutated separately.

**Third gap, found by the review and closed structurally rather than by a fix:** §5.8's failure model has no observable middle on either shipped board, and every acceptance criterion the first draft had was satisfied by a build in which that was true. The response is Decision 2 (the arithmetic, with both thresholds measured), Task 7 Step 5 (the boundary swept rather than asserted), Task 10's Gate A (the gradient), and Task 6's observability line saying plainly that the ramp's effect is confounded with the spawner's and cannot be attributed by a player.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N", no "write tests for the above". Every code step carries real code. **Three deliberate blanks remain, and each is a value that can only be produced by running the code**: the seven re-blessed digests (Task 1 Step 9), the new demand-pin golden (Task 6 Step 6), and the two per-fixture splice offsets in Task 1's re-bless comments — which must come from `computeLayout(regionsFor(map))` for each fixture's own map, since the four re-blessed fixtures run on four different maps. **Everything else that looks like a blank is a figure this plan states as the value to reproduce**, so that a disagreement is a finding rather than a fill-in: Task 5 Step 11's `houseSpawnTimer` is **1** and `H_DEST_SPAWN_TIMER` is **151**, Task 7 Step 9's two death ticks are **6,703** and **5,580**, Task 8 Step 6's margin is **6,459 against 6,703**, and Task 10 Step 5's gate figures are tabulated in its own preamble. Each is required to be re-derived rather than copied.

**3. Type consistency.** `runWeekBoundary(state)`, `runSpawn(state, world, scratch)`, `runOvercrowd(state)` all return `void` and match `runDemand`/`runMovement`/`runArrivals`'s shape; `runSpawn` is the one that takes `scratch`, and Task 5 says why in the same paragraph that introduces `CT_BLOCKED_PUSH_DISCARDED`. `isGameOver`/`failedDestination` are defined in Task 1 and used in Tasks 8, 9, 11 and 12 under those exact names. `spawnZoneCells(world)`, `spawnZoneCellAt(zoneIndex, world)` and `inSpawnZone(cell, world)` all take `WorldData` — an earlier draft had two of them taking `w: number` and the third taking `world`, which is exactly the `clearLayers`/`clearFullLayers` bug this check exists for; `spawnZoneW`/`spawnZoneH` take a scalar because they are the axis primitives the other three are built from, and that split is stated in Task 5's Produces block. `colourUnlocked` takes `(state, colour, week)` in Tasks 5, 10 and 11 — **the first draft's `(colour, week)` could not express the seeded clause, which is why the signature changed and why Decision 8 states it.** `footprintWidth`/`footprintHeight` are exported in Task 4 and consumed in Task 5. `SpawnOutcome`/`SpawnOutcomeCode` are produced in Task 5 and consumed in Tasks 5, 10 and 12. `OVERCROWD_FULL_MILLITICKS` is used in Task 7 (the constant) and Task 9 (the fold) and nowhere else; `OVERCROWD_FAIL_MILLITICKS` decides failure and is never drawn. `pinPeriodForWeek` is defined in Task 6 and consumed in Tasks 6, 10 and 12. `FrameDriverDeps.onGameOver` is declared required in Task 8 and passed in `main.ts` in the same task; `Loop.end`/`Loop.over` are produced in Task 8 and consumed by `PointerHost.gameOver` in Task 9. `PointerHost.gameOver`/`restart` and `PointerOutcome.RESTART_REQUESTED` are all Task 9's and appear nowhere earlier.
