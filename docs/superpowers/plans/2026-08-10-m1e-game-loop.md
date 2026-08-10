# M1e: the game loop — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the city grow, make demand outrun you, and make a badly-run city kill the run — so that Laneways stops being a traffic simulation you watch and becomes a game you can lose.

**Architecture:** Three new `step` phases around the six that exist — a **week boundary** that grants flat tile income (§5.10), a **spawn** phase that grows houses and destinations inside the revealed rect on an authored schedule (§5.9), and an **overcrowd** phase that integrates a per-destination timer and ends the run when one completes (§5.8) — plus a week-indexed demand ramp (§5.3) implemented as a shrinking pin period rather than a scaled accumulator, so week 0 stays byte-identical to today. The renderer gains an overcrowd ring and a game-over overlay; the default board flips back to the buildable starting city, because the spawner is exactly what retires the reason it stopped being the default.

**Tech Stack:** TypeScript, pnpm workspaces, zero runtime dependencies, integer-only in `sim`, Vitest, Canvas2D, Cloudflare Workers.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **`sim` is integer-only, allocation-free, and deterministic.** One `ArrayBuffer`; struct-of-arrays typed-array views; seeded mulberry32 held **inside** `GameState`; `hashState` is FNV-1a over the whole buffer. **Browser and Cloudflare Worker replay of identical inputs must produce BYTE-IDENTICAL state.** No `Math.random`, no `Date`, no transcendentals, no float literals, no module-scope mutable state, no iteration over `Map`/`Set`/object keys for anything sim-affecting.
- **Rule constants are integer numerators over a denominator of `DENOM` = 1000**, converted only in `packages/shared/src/constants.ts`. A ramp of 0.02 is `20`.
- **Cell index convention is `index = y * w + x`.** Occupancy slot convention is `slot = cell * 2 + lane`. **M1e adds a third index arithmetic** — the spawn-zone index, `zoneIndex = zy * spawnZoneW + zx` — and it must never be confused with either. Only `spawn.ts` converts between them.
- **Zero allocations per tick and per frame.** Three harnesses, and confusing them is a recurring defect: `packages/game/test/allocation.test.ts` profiles `packages/game/src` **and** `packages/sim/src` and measures **the tick**; `packages/game/test/drawAllocation.test.ts` profiles `packages/render/src` and measures **the frame** (it flakes roughly 1 run in 10 — re-run before recording a kill from it); `packages/game/test/demoAllocation.test.ts` profiles all three on the demo board. A green harness is a claim about the inputs it was given — prove liveness by injecting into the **new** code, and make the injected object escape (`(globalThis as any).__sink = {…}`), never `void __sink`.
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

**So every task in this plan carries an `Observability:` line phrased as what a human will see, on the board that boots by default, without being told where to look. Where the honest answer is "nothing", the task says so.**

**The milestone-level answer.** After M1e, a plain load opens the starting city. A player sees an empty board with three houses and three destinations, draws a road with their finger, and watches cars run it. Then: **new buildings appear** while they play; **the tile counter jumps by 30** every two and a half minutes; **a ring fills around any destination whose queue is over capacity**; and if a ring completes, **the city stops dead and says so**. Four things, all unprompted, all on the default board.

---

## Scope

**In:** the week boundary and flat tile income; the authored spawn schedule for houses and destinations, bounded to the revealed rect; the weekly demand ramp; blocked-spawn redistribution; the per-destination overcrowd timer with its ramp, unwind and arrival knockback; game over; the renderer surface for all of it; the default-board flip; the flow-field per-frame allocation M1d handed here by name; and the comment sweep.

**Out, each with a named recipient, because "handed to whoever owns X" is a drop when nobody owns X:**

| Deferred | Owner | Why |
|---|---|---|
| **The two-card upgrade modal and the card pool (§5.10)** | **M1f** | Every card in §5.10's table but Road Tiles grants an **item** — bridge, tunnel, roundabout, traffic lights, motorway — and **none of them has a placement mechanism yet.** A pool with one offerable entry is a menu with one item, and a modal that offers the same card twice is worse than no modal. Shipping the pool with five unofferable entries would be dead code that reads as a supported configuration, which is the exact thing M1d's decision 1 forbids (`CARS_PER_CELL`). So M1e ships §5.10's **load-bearing half** — *"Tile income is flat, not week-indexed; difficulty ramps on the demand side only"* — as an automatic weekly grant of `WEEKLY_TILE_GRANT` = 30, and M1f ships the choice on the day there is something to choose between. **The first thing M1f must decide is which item comes first; the cheapest by a wide margin is the bridge/tunnel pair, because they need no new input surface at all — a bridge is spent by dragging a road across water with the gesture that already exists.** |
| **Traffic lights and roundabouts (§5.6)** | **M1f** | Both are upgrade cards, so they are behind the modal above. Lights are additionally the change that would make car positions a **flow-field input** — every `FIELD_IRRELEVANT` reason in `regions.ts` is currently dated *"M1e's demand-actuated lights"*, and M1e must repoint all of them (Task 10). Roundabouts additionally overwrite road with a refund, which composes with ghost cells and needs its own tests. |
| **Motorways, bridges, tunnels (§5.7, §5.1)** | **M1f** | Same modal dependency. Bridges and tunnels additionally break a named, tested invariant in three places — `assertNoRoadOnImpassable` (`roads.ts`), `placeRoad`'s `world.passable` gate, and `graph.test.ts`'s randomised *"every neighbour has `passable === 1`"* property — so they are a task of their own, not a branch. **Note that `firstCity`'s river has a natural two-cell land gap at rows 18–19**, so the default board is fully connectable without a single bridge; the gap is a choke point, which is good level design rather than a workaround. |
| **Board expansion / a real revealed region (§5.1)** | **M1f** | **This is the item most likely to be missed: it was addressed to M1d in the imperative in eight files, M1d declined it, and M1e declines it too — so say it out loud rather than repointing quietly.** The reasons are unchanged and one is new. Unchanged: expansion is a per-map, per-week schedule that `MapData` does not carry, and adding it means folding it into `mapIdHash` (`world.ts` says so explicitly), which moves every whole-buffer golden a **second** time in a milestone that budgets exactly one shape change; plus `canvas.ts`'s culling note needs a `clip` around draw phases 3–8; plus `frame.test.ts`'s two fold markers sit in **diagonal corners**, which stops working the moment the fold is 2-D over a dynamic rect (a corner is past two bounds at once, so extending any single bound reaches nothing — each of the four half-plane bounds needs its own marker one cell past exactly one of them). **New: M1e makes this work strictly larger**, because `packages/sim/src/spawn.ts` now reads `REVEALED_X0/Y0/W/H` from `@laneways/shared` to bound where buildings may appear. When the rect becomes state, the spawn zone must move with it. Task 10 repoints every site to M1f. |
| **Drawing the two lanes, and the stop/start snap** | **M1f (renderer)** | Two deferrals that are cheaper together than apart, because **both are re-derivations of the same table.** The renderer draws every car on the cell centreline, so two cars in opposite lanes visually pass through each other (demonstrable in the loop fixture: cars 0 and 1 cross at x ≈ 13.25 on row 5 between ticks 71 and 72); the fix is a perpendicular offset of about 0.15 cells in `resolve.ts` (`(-DY[dir], DX[dir])`), which adds rows of **0.212** and **0.30** cells to `resolve.ts`'s displacement table against its current supremum of **0.1333**. Separately, a human on hardware confirmed the **stop/start snap is robotic**: a blocked car holds `carProgress` bit-identical and then resumes at the full 330 units/tick, 0 to 3.96 cells/s across one frame. That is a **renderer** concern — the sim's step function is spec-correct (§5.5 prices speed by geometry) and fixing it in `sim` would move goldens and buy nothing a player can see — and easing the rendered speed is a change to the same displacement derivation. Do both in one milestone, re-deriving `resolve.test.ts:225-236`, `:550` and `frame.test.ts:1055` once. |
| **Destination removal, and the square→circle upgrade (§5.2)** | **M1f** | Three source sites name *"M1e's destination removal"* as the trigger that ends an inert property — `state.ts:460` (a hole marker for a slot in the middle of a live prefix), `dispatch.ts:688` (what would make `runDispatch`'s colour order outcome-visible) and `trips.ts:63` (what would make arrival order outcome-visible). **M1e removes no destination and upgrades none**, so all three stay inert and all three comments must be repointed rather than left reading as satisfied. Every destination M1e spawns is a `DEST_KIND_SQUARE`. |
| **Persistence and the compression re-measurement** | **M3** | The state buffer grows **13,828 → 13,992 bytes** here (+1.2 %, against +74.9 % in M1d). The added bytes are three all-zero Int32 regions and four header slots, two of which are initialised non-zero. M3 must **re-measure** against the 4,096-character CloudStorage budget, not extrapolate. |
| **Spawn weights** | **nobody, deliberately** | §5.9's *"ignore spawn weights after 5 consecutive failures"* governs a structure that does not exist: there are no per-zone spawn weights. **Do not add the constant "for later"** — an untested value reads as a supported configuration. When weights land, the constant lands with them. |

---

## Eleven design decisions

### 1. Ten phases, and the two inherited transpositions are discharged by insertion rather than by a test that cannot exist

`step.ts` runs seven phases today. Two adjacent transpositions — `1↔2` (the clock advance after input application) and `2↔3` (inputs after demand) — are **0-detector no-ops**, re-measured at the close of M1d over the complete pairwise set C(7,2) = 21, scoring 0 in 4 of 4 rounds against 19–75 for every other pair. They are inert **for exactly one reason: no `TickAction` reads `H_TICK`.** `step.test.ts` carries a tripwire on that *condition* — it reads `step.ts` and `roads.ts` off disk and pins both halves — precisely so the person who ends the condition gets a red test rather than a paragraph.

**The recorded danger is that M1e makes building placement a `TickAction`, at which point both swaps become real off-by-ones in every destination's first-pin delay at once, with nothing to catch either.** This plan does not do that.

**Spawning is a `step` PHASE, not a `TickAction`.** `TickActionKind` stays exactly `'place' | 'erase'`, phase 3 still calls nothing but `placeRoad`/`eraseRoad`, and `roads.ts` still reads neither `H_TICK` nor `H_WEEK`. So the tripwire's condition holds unchanged and both inherited swaps stay inert for the same single reason.

**What actually discharges the handoff is that the insertion converts the dangerous adjacency into a live one.** The new order is:

| # | Phase | The constraint that forces its position |
|---|---|---|
| 1 | `H_EPOCH ← tick`; advance `H_TICK`, `H_WEEK` | Atomicity marker first. The advance must precede every clock reader below. |
| **2** | **Week boundary — grant `WEEKLY_TILE_GRANT` tiles** | Reads `H_TICK`. **Before phase 3**, so an action queued on the boundary tick can spend the tiles it just received. Swapping 1↔2 grants on the wrong tick — the off-by-one the handoff warned about, arriving here **with a detector**. |
| 3 | Apply inputs — the only phase that changes `roads` | Must precede the field sync, or a road drawn on tick T is invisible to this tick's field. |
| **4** | **Spawn — houses, then destinations** | Reads `H_TICK` (via `placeDestination`'s `destSpawnTick` stamp) and `H_WEEK` (colour unlocks). **After phase 3**, because *"nothing ever spawns on an existing road tile"* must see the road the player laid this tick. **Before phase 5**, so a destination placed on tick T is in the rotation's `H_DEST_COUNT` prefix for tick T. |
| 5 | Demand — accumulators, pins, overflow, drops | Mutates `destPins`, which decides the source set, so it precedes the sync. Now reads `H_WEEK` for the ramped period. |
| 6 | Assemble sources, then EXACTLY ONE `syncFields` | Every source-mutating phase is behind it. |
| 7 | Dispatch — the tick's only field reader | — |
| 8 | Movement | After dispatch, so a car dispatched on tick T also moves on tick T. |
| 9 | Arrivals — consume the pin, credit the score, apply the arrival knockback | Mutates `destPins` after the sync, so it must be last of the trip phases. |
| **10** | **Overcrowd — integrate the timer, fire game over** | **After phase 9**, so the meter and the knockback both see the tick's final `destPins`. Nothing after it, so a run that ends this tick ends on a fully-settled state. |

**The old `2↔3` pair is now "inputs ↔ spawn", and it is NOT inert**: swapping them lets a destination spawn on a cell the player paved this tick, which `canPlaceDestination`'s road check exists to forbid. The new `1↔4` pair is not inert either: it stamps `destSpawnTick` one tick early. Both get real detectors (Tasks 2 and 5). **That is the handoff discharged — not by manufacturing a test for an inert swap, but by inserting the clock reader where its position can fail.**

### 2. The demand ramp scales the PERIOD, not the accumulator — which is why week 0 is byte-identical to today

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

**One stated consequence.** `demand.ts`'s module comment claims *"at most one threshold crossing — one fire — happens per colour per tick"*, resting on `slotCount ≤ 32 < PIN_PERIOD_TICKS`. That still holds tick-to-tick (`32 < 172`), but **a period reduction at a week boundary can leave `acc` already above the new threshold**, and the loop fires once per tick, so a backlog drains over the following ticks. The bound is `floor((maxPreviousPeriod − 1) / minPeriod)` = `floor(517 / 172)` = **3 catch-up ticks, worst case, once per week boundary, per colour.** The comment must be amended to say exactly that rather than left overstating.

### 3. The overcrowd meter is integrated in MILLI-TICKS, and the spec's ~113 s is an exact integer

A tick is 1000/30 ms, which is not an integer, so a millisecond-denominated meter cannot be exact. Denominate it in **ticks scaled by `DENOM`** — milli-ticks — and every spec constant converts once, in `constants.ts`.

Two per-destination quantities, because the ramp is a function of elapsed time over capacity while the meter is reduced by arrivals and by the unwind:

- **`destOverTicks[d]`** — consecutive ticks at or over the timer capacity. Resets to 0 the moment the destination is back under. **Saturates** at `OVERCROWD_RAMP_FULL_TICKS`, exactly as `carBlockedTicks` saturates at `MAX_BLOCKED_TICKS`, so no width question can arise at any run length.
- **`destOvercrowd[d]`** — the integrated meter, in milli-ticks. Only this one decides failure.

Spec §5.8: speed `s(t) = min(1, 0.02·t)` with `t` in seconds, max overcrowd time 90, hidden grace 2 s. So:

- `s` reaches full at `t = 1/0.02 = 50` s → `OVERCROWD_RAMP_FULL_TICKS = (DENOM / OVERCROWD_RAMP) · TICKS_PER_SECOND` = **1,500**.
- Failure fires when the meter reaches `90 − 2 = 88` s → `OVERCROWD_FAIL_MILLITICKS = OVERCROWD_FULL_MILLITICKS − OVERCROWD_GRACE_MILLITICKS` = 2,700,000 − 60,000 = **2,640,000**. The *displayed* ring is the meter against `OVERCROWD_FULL_MILLITICKS` (2,700,000), which is what makes the grace **hidden**: the ring shows 97.8 % at the instant the city dies.
- Per-tick increment is `min(DENOM, (OVERCROWD_RAMP · destOverTicks) / TICKS_PER_SECOND | 0)` = `min(1000, floor(2·overTicks/3))`.

**The ramp phase sums to exactly 750,000 milli-ticks, and this is hand-derivable rather than measured.** Writing `t = 3k + r`, `floor(2t/3)` over each consecutive triple is `2k + (2k+1) + (2k+2) = 6k + 3`; `t` from 1 to 1,500 is 500 triples with `k = 0…499`, so the sum is `6·(499·500/2) + 3·500 = 748,500 + 1,500 = 750,000`. The remaining `2,640,000 − 750,000 = 1,890,000` accrues at 1,000/tick over **1,890** ticks. **Total: 1,500 + 1,890 = 3,390 ticks = 113.0 s exactly**, which is the spec's own "~113 s" landing on the nose. `3,389` must not fire and `3,390` must — the sharpest off-by-one detector this milestone has.

Two more rules, both one line:

- **Unwind**, once back under capacity: the meter falls by `OVERCROWD_RETURN_MUL` (2,000) milli-ticks per tick — 2× the full fill rate of 1,000 — floored at 0.
- **Arrival knockback**: on every car arrival at destination `d`, `min(meter · ARRIVAL_KNOCKBACK_PCT / DENOM, ARRIVAL_KNOCKBACK_MAX_MILLITICKS)`, i.e. 10 % of current capped at 3 s (90,000 milli-ticks). The cap binds above a meter of 900,000. The spec's lower clamp of 0 s is satisfied by construction because the meter is never negative.

**The meter reads `destPins`, not `destPins − destReserved`, and that is the spec speaking:** §5.8, *"There is no carpark immunity — a car metres from the bay does not save you."* A reserved pin is still a customer waiting.

`destOvercrowd` and `destOverTicks` are `Int32Array`, so the `Uint8` wrap class does not apply — but **both decrement paths are still clamped at 0 with a named assertion**, because a negative meter is a silent lie about how close the player is to losing.

### 4. Game over freezes the sim from `step`'s first line, and the loop follows rather than leads

§5.8: *"If any single destination's timer completes, the city shuts down immediately. No lives, no partial failure, no win condition."*

Two header slots: `H_GAME_OVER` (0 alive, 1 over) and `H_FAILED_DEST` (the destination index, meaningful only when `H_GAME_OVER` is 1). **Two plain flags rather than one packed `failedDest + 1`**, because zero-initialisation must mean "alive" without `createState` writing a sentinel, and a packed encoding reads badly at every call site. Both are reached through `isGameOver(s)` and `failedDestination(s)`, and the second returns `-1` unless the first is true, so no caller can read a stale index.

**`step` returns immediately when `H_GAME_OVER` is set — after the poison check, before `H_EPOCH` is written.** Every subsequent tick is then a byte-identical no-op, which is what the leaderboard needs: a Worker replaying an input log that runs past the failure computes the same score as the browser that produced it, whatever the log's length. `H_TICK` stops advancing, so the HUD clock visibly freezes, which is the "city shuts down" feel for free.

The frame loop stops too, but **as a follower, not as the authority**: `createFrameDriver` calls a **required** `onGameOver` callback the first time `isGameOver(state)` becomes true, and `main.ts` pauses the loop from it. Required, not optional — an optional dependency is how M2's erase control shipped a compiling `createEraseControl({ host })` that left the player with no way to erase.

### 5. The spawn zone is the revealed rect, clipped to the board, and it may legally be empty

Nothing may spawn where the player cannot see it. `sim` therefore reads `REVEALED_X0/Y0/W/H` from `@laneways/shared` — permitted (`sim` depends on `shared`), and it makes `constants.ts`'s claim that *"nothing in `sim` reads these"* false, so that comment moves in the same commit.

**The rect must be clipped to the world**, because `sim`'s test fixtures are small: `determinism.test.ts`'s golden map is 4×4 and `loop.test.ts`'s is 20×12, against a rect of `x ∈ [5, 19)`, `y ∈ [9, 31)`. On the 4×4 the clipped zone is **empty**; on the 20×12 it is 14×3. So every zone consumer takes a possibly-zero cell count and **`spawnScanStart` guards against `% 0` before it is ever evaluated** — an unguarded modulo by zero yields `NaN`, and a `NaN` index into a typed array is a silent no-op, which is the quietest possible failure.

**Candidate scanning is bounded at `SPAWN_CANDIDATE_LIMIT` = 24 cells per attempt.** Unbounded scanning is up to 308 cells × 4 orientations × `canPlaceDestination`, which is a spike inside one tick on a phone. Bounding it also makes §5.3.5's blocked-spawn redistribution reachable rather than theoretical.

**The scan start is `((rng[0] >>> 0) + H_TICK) % zoneCells`, reading the RNG word without advancing it.** Three properties, all wanted: it varies by seed (so `RUN_SEED` means something), it varies by tick (so the board does not fill from the top-left corner), and it **consumes no draws** — a spawner that advanced the RNG on every failed attempt would couple every downstream draw to how many times a spawn failed, which is deterministic and brutally fragile for hand-computed fixtures.

### 6. Houses follow destinations, destinations follow the week, and a colour is founded before it is served

§5.9 gives geometry and minimum intervals but no rate. The rate is authored here, and marked [OURS]:

- **Destinations: `DESTINATIONS_PER_WEEK` = 2**, so `DEST_SPAWN_PERIOD_TICKS = TICKS_PER_WEEK / DESTINATIONS_PER_WEEK` = 2,250 ticks (75 s). A failed attempt retries after `DEST_SPAWN_RETRY_TICKS` = 600 (§5.9's 20 s), which comfortably clears §5.9's 10 s minimum between destination spawns.
- **Houses: one attempt per colour per `HOUSE_SPAWN_PERIOD_TICKS` = 300** (§5.9's 10 s between same-group house spawns), retrying after `HOUSE_SPAWN_RETRY_TICKS` = 60 (§5.9's 2 s cooldown on a failed house spawn).
- **`HOUSES_PER_DESTINATION` = 2** caps a colour's houses at twice its destinations, so house growth is driven by destination growth rather than by the clock. Without it, `maxHouses` = 40 on `firstCity` would fill in about 80 seconds.

**The founding exception, and it is load-bearing.** §5.9 says future houses spawn within ~2 tiles of an existing same-colour house — which cannot place the *first* one, and the cap `houses ≥ dests · 2` refuses a colour with zero destinations. Together those two rules deadlock every colour that starts empty: no house, so no destination; no destination, so no house. `firstCity` seeds colours 0 and 1 and declares `groupCount` 5, so colours 2, 3 and 4 are exactly that case. **So a colour's first house is exempt from both rules and may be placed anywhere legal in the zone**, and a destination spawns only for a colour that already has a house. Colours unlock on `H_WEEK >= colourIndex` [OURS], which paces `firstCity` to a new neighbourhood at weeks 2, 3 and 4.

**The demo board is inert under all of this, by construction and not by luck.** `demoCity` declares `maxHouses` 12 and `maxDestinations` 18 and its seeder places exactly 12 and 18, so both spawners are at capacity from tick 0 and every attempt fails. That is asserted, not assumed — it is what protects M1d's measured demo figures.

### 7. Timers count DOWN and are initialised in `createState`, which makes the shape task's re-bless provable rather than merely stated

A countdown timer that fires at zero and resets to a period is the plainest form, but it needs a non-zero initial value or every spawner fires on tick 1. `createState` writes them, exactly as it already writes `H_TILES` from `map.startingTiles` and fills `occupancy` with `FREE`:

```ts
s.header[H_DEST_SPAWN_TIMER] = DEST_SPAWN_PERIOD_TICKS
s.houseSpawnTimer.fill(HOUSE_SPAWN_PERIOD_TICKS)
```

So Task 1's golden move is **layout plus two named initial writes**, and the re-bless is proved rather than asserted: splice the inserted bytes out of the buffer **and** zero those two slots, and the previous digest reproduces bit-for-bit. That is M1d's splice technique with one extra term, and stating the extra term is the whole point — a re-bless whose proof is "the shape changed" absorbs any behavioural regression that happens to land in the same commit.

### 8. Placement validity stops allocating, and the algorithm does not change

`canPlaceDestination` calls `allSevenCells`, which returns a fresh `number[]` — once for the candidate and once **per existing destination**. Today that is fine: it runs once per hand-authored placement, and its own doc comment says *"never call this from a per-tick path"*. Task 5 puts it on one.

At `SPAWN_CANDIDATE_LIMIT` × `ORIENTATION_COUNT` = 96 calls per attempt, each allocating `1 + destCount` arrays, a full board that refuses every attempt allocates roughly 1,600 arrays every 600 ticks — which `allocation.test.ts` measures as a per-tick average and will report against `SIM_SRC`.

**The fix is to stop materialising the cells, not to thread a scratch buffer through `Layout.seed`.** Two changes, both in `buildings.ts`:

- The bounds/terrain/tree/road checks become a `dy`/`dx` double loop over the footprint box plus the carpark cell. Identical checks, identical order, no array.
- The spacing check becomes **box arithmetic**. The minimum Chebyshev distance between two axis-aligned boxes is `max(gapX, gapY)` with `gapX = max(0, B.x0 − A.x1, A.x0 − B.x1)` and likewise for `y`; a carpark is a 1×1 box. Four box-pairs per existing destination replace 49 cell-pairs.

The second is an **algorithm rewrite of a heavily-tested predicate**, so it carries a migration proof: the retired pairwise implementation is transcribed once into the test file as a reference and compared exhaustively over every `(destCell, orientation)` pair on a small grid against every stored incumbent. That is deliberately a one-off equivalence proof and **not** the coverage — the existing `canPlaceDestination` tests stay exactly as they are and remain the coverage, because a test that reimplements the thing it checks is a listed defect and only earns its place as a migration artefact.

### 9. Routing stays congestion-blind, and that is a spec requirement rather than a deferral

`flowfield.ts` contains zero references to `occupancy`, `carBlockedTicks` or blocking of any kind, so a jam does not repel traffic — it attracts it. M1d handed that here as an open disagreement. **The decision is that M1e does not fix it, because there is nothing to fix.** Spec §1: *"path cost contains no congestion term… This omission is deliberate and load-bearing; it is the game."* Decision row 5, *"cars path once at departure, never re-route"*; decision row 6, *"no congestion term in path cost"*. The player is the only rerouting mechanism, and M1e's demand ramp is what finally makes that a demand on the player rather than a curiosity.

**What M1e owes is a detector, because the property is currently unprotected on the boards that matter.** The field golden `252514232` runs on `rollback.test.ts`'s fixture, which **has no cars**, so an occupancy-dependent edge cost would leave it green. So Task 10 adds a property test on a board mid-jam: snapshot `dist`/`dir` for every colour, arbitrarily rewrite `occupancy` and `carBlockedTicks`, re-run `syncFields`, and assert **byte-identical fields and an unmoved `CT_REBUILDS`**. That kills both an occupancy term in the cost and a FIELD_INPUT misclassification, on a real board, with no source scan — and a source scan here would be decoration, because it catches nothing `tsc` and the property test do not.

**And the trap is recorded rather than sprung.** `scratch.ts:43-49`: `NB = DIAG_COST + 1 = 15` is the **exact** minimum with zero slack — an earlier comment read the spread as 4 and instrumenting 200 seeded random graphs measured the true maximum at 14, the full interval, a 3.5× overestimate of headroom that does not exist. `assertBucketCountExceedsEveryEdgeCost` inspects only `edgeCost(k)`, so **a penalty applied inside `computeFlowField` rather than through the cost function keeps the assert passing while the Dial queue aliases two distances into one bucket: wrong paths, no crash**, in the component whose golden is a tripwire. A *per-cell* penalty additionally makes cost depend on more than direction, so `edgeCost(dir)` and everything derived from it goes structurally blind — the signature has to change, not just the value. M1d's intersection penalty set no precedent here: it is a `laneSpeedMul` applied at movement time and left `NB` untouched. **The first thing that will actually change the value set is M1f's motorway ÷3 tier**, and Task 10 repoints the comment there.

### 10. `Uint8Array` decrements: M1e adds none, and that is verified rather than assumed

An unguarded `--` at 0 on a `Uint8Array` wraps to 255, and where the slot gates eligibility it excludes something **forever**, silently, surviving snapshot/restore and replaying identically in the Worker. The complete set of `Uint8Array` decrement paths in `packages/sim/src` at the start of this milestone is **three**: `destPins` and `destReserved` in `trips.ts` (guarded by `assertArrivalHonoured`) and `ghostCommitted` in `roads.ts` (guarded by `assertGhostCommittedPositive`).

M1e's new writers are: overcrowd (writes `destOvercrowd`/`destOverTicks`, both `Int32`), the week grant (increments `H_TILES`, `Int32`), spawning (appends to `destCell`/`destMeta`/`houseCell`/`houseColour` and increments counts — no decrement), and blocked-spawn redistribution (**increments** `destPins`). **So M1e adds no fourth `Uint8Array` decrement path.**

That is verified the way M1d verified it, and the method matters: **enumerate every write to every `Uint8` region rather than grepping for `--`**, because the one path M1d actually added spells it `const left = committed - 1` across two statements and no `--`-shaped pattern matches it. Task 11 does the enumeration and records the set.

### 11. The default board flips back to the starting city, because M1e retires the reason it stopped being the default

The demo board became the default because the starting city was **inert**: instrumented over 200,000 ticks on the exact production boot it produced `REFUSED_OCCUPIED` 0, `ENTER_VALVE` 0, a maximum of one car in flight and 1,510 dropped pins — three houses feeding four rotation slots at one pin per 129.5 ticks against a ~60-tick round trip, with no shipped control that could add a car. A player opening it saw six cars that never moved.

**M1e is the shipped control that adds cars.** The spawner grows the board, the ramp raises demand, overcrowd punishes falling behind, and the weekly grant pays for keeping up. Every clause of that paragraph stops being true.

Three things make the flip safe, and each is checkable before it lands:

- **The opening is solvable, and cheaply.** `firstCity` grants 30 starting tiles. House 0 at (8, 24), house 1 at (8, 13), D0's carpark at (8, 10) and D1's carpark at (8, 18) all sit on **column 8**, and rows 10–24 of column 8 are unbroken land. One 15-cell vertical stroke costs 15 tiles and connects both colour-0 houses to both colour-0 destinations. House 2 at (17, 18) and D2's carpark at (17, 14) sit on column 17, five cells apart, for 5 more. **The entire seeded city is connectable for 20 of 30 tiles.**
- **The board is not cut in half.** The river runs down `x = 12` for the whole revealed rect except **rows 18 and 19, which are land** — `firstCity.ts`'s own comment calls it *"a river with a bridgeable two-cell gap"*. Cross-river traffic funnels through two cells, which is a choke point rather than a wall, and bridges stay deferred without stranding anything.
- **The demo board is unaffected and stays one token away.** `?layout=demo` in a browser, `?startapp=demo` inside Telegram; its own map, seeder, RNG seed, warm start and golden `1039862014`; and both its spawners are capped from tick 0.

The flip lands in **Task 5**, with the spawner, because that is the task that makes the sentence true — and every task after it is then judged against the board a player actually opens. Task 11 re-measures with overcrowd live and on hardware.

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

**Every whole-buffer golden moves once in Task 1, for layout plus the two initialised timer slots (Decision 7). One of them moves twice more, and only one.**

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

**Why only the state golden moves behaviourally, derived rather than assumed.** It is the only fixture that crosses a week boundary (13,499 ticks spans the boundaries at 4,500 and 9,000, and stops short of 13,500), so it is the only one Task 2's grant can reach, and the only one whose spawn timers cycle far enough to matter. It is on a 4×4 map whose clipped spawn zone is **empty**, so Task 5 places no building in it — only the three timer families cycle. Every other fixture runs inside week 0 and below the first spawn attempt at tick 300.

**Both of those moves carry a direct assertion on the bytes that changed, beside the digest.** Task 2 asserts `H_TILES === startingTiles + 2 * WEEKLY_TILE_GRANT`; Task 5 asserts each timer slot's hand-computed value at tick 13,499. **A digest is never the only evidence for a re-bless in this milestone.**

Each of the three re-blessing tasks must, in the same commit:

- update the literal at its site with a re-bless comment naming the prior value and the reason, in the form `determinism.test.ts` already uses;
- update the **cross-file literal scan** at `packages/sim/test/loop.test.ts:1089-1102`, which reads `determinism.test.ts` and `rollback.test.ts` off disk and asserts three literals verbatim — one of which is the **field** golden, which must not change;
- (Task 1 only) update `packages/sim/test/regions.test.ts`: `totalBytes`, the ordered region-name list, the per-region element-count assertions, and the FIELD_INPUT exact-set pin. Note what needs **no** update and is doing real work for free: the parameterised staleness test pokes one byte of **every declared region** and asserts `hashFieldInputRegions` moves iff that region is FIELD_INPUT, so each new region is covered the moment it is declared;
- record old and new values in the commit message, with the reason.

---

## Task 1: The buffer shape — four header slots, three regions, seven goldens, one commit

**Files:**
- Modify: `packages/sim/src/state.ts` (header keys, `HEADER_LENGTH`, `GameState`, `REGION_FIELD_NAMES`, `viewsOver`, `createState`, `isGameOver`, `failedDestination`)
- Modify: `packages/sim/src/regions.ts` (three regions, both partitions, dated reasons)
- Modify: `packages/shared/src/constants.ts` (`HOUSE_SPAWN_PERIOD_TICKS`, `DEST_SPAWN_PERIOD_TICKS`, `DESTINATIONS_PER_WEEK`, `MS_PER_SECOND`)
- Test: `packages/sim/test/regions.test.ts`, `packages/sim/test/state.test.ts`, `packages/sim/test/determinism.test.ts`, `packages/sim/test/rollback.test.ts`, `packages/sim/test/loop.test.ts`, `packages/sim/test/cars.test.ts`, `packages/game/test/startingCity.test.ts`, `packages/game/test/demoLayout.test.ts`, `packages/shared/test/constants.test.ts`
- Modify: `packages/game/src/main.ts` (the prose figures at the seed-golden comment)

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
 * authored here. Two destinations per week paces `firstCity` (16 slots, 3
 * seeded) to a full board around week 7.
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
  // M1e Decision 7. A zero timer means "fire now", so without these the very
  // first tick of every run attempts a destination spawn and one house spawn
  // per colour. Written here beside `H_TILES` for the same reason: these are
  // the initial values of the declared shape, not behaviour, and stating them
  // is what makes this milestone's one re-bless PROVABLE — splice the inserted
  // bytes out AND zero these slots, and the previous digest reproduces.
  s.header[H_DEST_SPAWN_TIMER] = DEST_SPAWN_PERIOD_TICKS
  s.houseSpawnTimer.fill(HOUSE_SPAWN_PERIOD_TICKS)
```

- [ ] **Step 7: Write the accessor and initial-value tests**

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

- [ ] **Step 8: Prove the re-bless before writing any new number**

For each of the seven whole-buffer goldens, run its fixture, splice the three new regions' byte ranges out of `s.bytes`, zero the four new header slots, and hash the remainder — it must reproduce the pre-Task-1 digest bit-for-bit. Record each splice's `(offset, length)` **for that fixture's own map**, never `firstCity`'s: the four re-blessed fixtures run on four different maps and quoting one map's figure at another's site reads as a fabricated derivation.

- [ ] **Step 9: Re-bless the seven, each with its own comment**

At each site, in the form the file already uses. For example, in `packages/sim/test/determinism.test.ts`:

```ts
    // **Re-blessed in M1e Task 1 (was 340556353 at M1d Task 5; 1729791425 at
    // M1d Task 2; 2413319809 at M1c; 1073292924 at M1b). This is the ONLY
    // shape change in M1e** — the plan's "Which goldens move, exactly" fixes
    // the buffer at 29 regions and 13,992 B for `firstCity`, and every later
    // task appends behaviour, never shape.
    //
    // Layout PLUS two named initial writes (`H_DEST_SPAWN_TIMER` and
    // `houseSpawnTimer`), derived rather than assumed: splicing the three
    // inserted regions out of this buffer AND zeroing the four new header
    // slots reproduces 340556353 exactly. The splice is <N> bytes at offset
    // <O> FOR THIS FIXTURE — GOLDEN_MAP is 4x4, so its region lengths are not
    // `firstCity`'s.
    //
    // This number moves TWICE MORE in this milestone and in no other task:
    // Task 2 (the weekly tile grant, which this 13,499-tick fixture crosses
    // twice) and Task 5 (the spawn timers cycling). Both carry a direct
    // assertion on the changed slots beside the digest.
    expect(hashState(s)).toBe(/* new value */)
```

Then update the cross-file scan at `packages/sim/test/loop.test.ts:1093-1094` and the prose figures at `packages/game/src/main.ts:152`.

- [ ] **Step 10: Run the whole suite and confirm the field golden did not move**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS, with `252514232` untouched. If it moved, a new region was misclassified FIELD_INPUT — stop and report.

- [ ] **Step 11: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `houseSpawnTimer` length `groupCount` → `maxDestinations` | `regions.test.ts` element-count assertion; `totalBytes` |
| `destOvercrowd` ctor `Int32Array` → `Uint8Array` | `regions.test.ts` element-count; `totalBytes`; zero-padding |
| Drop the `createState` timer writes | the fresh-state test, by name |
| `failedDestination` returns the slot unguarded | the second accessor test, by name |
| Classify any new region FIELD_INPUT | the exact-set pin **and** the parameterised staleness test |
| Declare a new region in the `Int16` tier instead | the zero-padding assertion |

Every kill must be an assertion failure. Confirm per-package totals are unchanged under each mutant.

- [ ] **Step 12: Commit**

```bash
git add packages/sim/src/state.ts packages/sim/src/regions.ts packages/shared/src/constants.ts packages/sim/test packages/game/test packages/shared/test packages/game/src/main.ts
git commit -F - <<'EOF'
feat(sim): the M1e buffer shape, and the milestone's only re-bless

Three Int32 regions (houseSpawnTimer, destOvercrowd, destOverTicks) and four
header slots (H_GAME_OVER, H_FAILED_DEST, H_DEST_SPAWN_TIMER,
H_SPAWN_COLOUR_CURSOR). 26 -> 29 regions, 13,828 -> 13,992 B for firstCity, no
pad byte. No behaviour: nothing reads any of them yet.

Seven whole-buffer goldens re-blessed for layout plus two initial timer writes,
each proved by splicing the inserted bytes out and reproducing the prior digest:

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
    const r = rig('week-grant-order')
    r.state.header[H_TILES] = 0
    r.state.header[H_TICK] = TICKS_PER_WEEK - 1
    step(r.state, r.world, r.fields, r.scratch, { actions: [{ kind: 'place', a: BOUNDARY_A, b: BOUNDARY_B }] })
    expect(r.state.header[H_TICK]).toBe(TICKS_PER_WEEK)
    expect(roadMask(r.state, BOUNDARY_A), 'the boundary-tick placement must have landed').not.toBe(0)
    expect(r.state.header[H_TILES]).toBe(WEEKLY_TILE_GRANT - 1)
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
 * put a clock reader where its POSITION can fail, which is the handoff
 * discharged rather than deferred again.
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
    // The detector for transposing phases 1 and 2. Built at the boundary minus
    // one so the two orderings differ by exactly one grant.
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

- [ ] **Step 9: Re-measure the two inherited transpositions in the new eight-phase order**

Apply `1↔2` (clock ↔ week grant) and `2↔3` (week grant ↔ inputs) and record detector counts; then apply the two the handoff is about — the clock advance against the input loop, and the input loop against demand — and confirm they are **still 0-detector for the same single reason**. **Run four unmutated baselines alongside**, because a flaky baseline reads exactly like a kill: `allocation.test.ts`'s sampling profiler has produced one. Record the result in `step.ts`'s comment, replacing M1d's re-measurement block with an M1e one that states the phase count changed from 7 to 8.

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

- [ ] **Step 12: Commit**

```bash
git add packages/sim/src/week.ts packages/sim/src/clock.ts packages/sim/src/step.ts packages/sim/src/index.ts packages/shared/src/constants.ts packages/sim/test packages/shared/test
git commit -m "$(cat <<'EOF'
feat(sim): the week boundary grants tiles, and a clock reader lands where it can fail

Phase 2 of eight. WEEKLY_TILE_GRANT = 30, flat and never week-indexed (§5.10).

This discharges M1d's transposition handoff without manufacturing a test that
cannot exist: spawning and granting are PHASES, not TickActions, so the two
inherited 0-detector swaps stay inert for the same single reason — and the
insertion puts a clock reader in a position that two new tests can falsify.

State golden re-blessed (<old> -> <new>): this fixture runs 13,499 ticks and
takes exactly two grants, asserted directly beside the digest.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** on the demo board, which is still the default at this point, the tiles readout jumps from 200 to 230 at 2:30 of play and by 30 again every 2:30 after. That is visible without being told where to look — the HUD already draws `tilesLeft` — but it is the weakest observability line in this milestone, and it is honest to say so: nothing else on the board changes.

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

## Task 4: Placement validity stops allocating, before anything calls it per tick

**Files:**
- Modify: `packages/sim/src/buildings.ts` (delete `allSevenCells`; rewrite `canPlaceDestination`; export `footprintWidth`/`footprintHeight`)
- Test: `packages/sim/test/buildings.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–3.
- Produces: `footprintWidth(orientation: number): number` and `footprintHeight(orientation: number): number`, now exported (Task 5's zone-fit check needs them and must not re-derive them). `canPlaceDestination(state, world, destCell, orientation): PlaceCheck` — **signature, return type, rejection order and every `BuildingPlaceFailure` reason unchanged.**

Decision 8 in full. `canPlaceDestination` allocates one `number[]` for the candidate and **one per existing destination**; its own doc comment says *"never call this from a per-tick path"*, and Task 5 puts it on one at up to `SPAWN_CANDIDATE_LIMIT × ORIENTATION_COUNT` = 96 calls per attempt.

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
  for (let ac = 0; ac < world.cells; ac++) {
    for (let ao = 0; ao < ORIENTATION_COUNT; ao++) {
      const a = referenceSevenCells(ac, ao, world)
      if (a === null) continue
      for (let bc = 0; bc < world.cells; bc++) {
        for (let bo = 0; bo < ORIENTATION_COUNT; bo++) {
          const b = referenceSevenCells(bc, bo, world)
          if (b === null) continue
          compared++
          expect(
            spacingViolated(ac, ao, bc, bo, world.w),
            `origins ${ac}/${ao} vs ${bc}/${bo}`,
          ).toBe(referenceSpacingViolated(a, b, world.w))
        }
      }
    }
  }
  // Vacuity: the loops must actually have compared something, and both answers
  // must occur — an enumeration where every pair is "violated" proves nothing.
  expect(compared).toBeGreaterThan(1000)
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

- [ ] **Step 4: Rewrite the cell loops without the array**

Replace `allSevenCells` and the three 7-cell loops in `canPlaceDestination` with an explicit box walk plus the carpark, **preserving the rejection order exactly** (`out-of-bounds`, `terrain`, `tree`, `road`, `spacing`, `building`, `capacity`):

```ts
  const width = footprintWidth(orientation)
  const height = footprintHeight(orientation)
  const x0 = destCell % world.w
  const y0 = (destCell / world.w) | 0
  if (x0 < 0 || x0 + width > world.w || y0 < 0 || y0 + height > world.h) {
    return { ok: false, reason: 'out-of-bounds' }
  }
  const carpark = carparkCell(destCell, orientation, world.w, world.h)
  if (carpark === -1) return { ok: false, reason: 'out-of-bounds' }

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (world.passable[(y0 + dy) * world.w + (x0 + dx)] !== 1) return { ok: false, reason: 'terrain' }
    }
  }
  if (world.passable[carpark] !== 1) return { ok: false, reason: 'terrain' }
```

and likewise for the tree and road passes, then the spacing pass over `spacingViolated`, then the existing house-overlap and capacity checks.

- [ ] **Step 5: Run the whole `sim` suite**

Run: `pnpm -r --no-bail --filter './packages/sim' test`
Expected: PASS with **every pre-existing `canPlaceDestination` test unchanged and untouched.** If any of them needed editing, the rewrite changed behaviour and is wrong.

- [ ] **Step 6: Diff the test-block count, not the line count**

```bash
git diff HEAD -- packages/sim/test/buildings.test.ts | grep -cE '^-\s*(it|describe)\('
git diff HEAD -- packages/sim/test/buildings.test.ts | grep -cE '^\+\s*(it|describe)\('
```

Expected: 0 removed, 1 added. A file that grows in lines says nothing about coverage — eleven pre-existing tests once left this repo inside a commit whose stat line read `337 insertions, 240 deletions`. Diff the **names**, not the counts, if the numbers disagree.

- [ ] **Step 7: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `boxChebyshev`: `gx > gy ? gx : gy` → `gx < gy ? gx : gy` | the exhaustive equivalence test |
| `spacingViolated`: drop the footprint-vs-**incumbent-carpark** pair only | the equivalence test (this is the asymmetric half that survived once before) |
| `spacingViolated`: drop the **candidate-carpark**-vs-footprint pair only | as above, separately |
| `footprintWidth`: swap the N/S and E/W shapes | the equivalence test and the existing orientation tests |
| `< 2` → `< 1` in `spacingViolated` | the equivalence test and the existing spacing test |
| `x0 + width > world.w` → `>= ` | the existing out-of-bounds tests |

Mutate the four box-pair lines **separately**: a compound being caught does not mean each half is.

- [ ] **Step 8: Commit**

```bash
git add packages/sim/src/buildings.ts packages/sim/test/buildings.test.ts
git commit -m "$(cat <<'EOF'
refactor(sim): destination placement validity stops allocating

`allSevenCells` returned a fresh array for the candidate AND one per existing
destination. Task 5 puts `canPlaceDestination` on a per-tick path at up to 96
calls per spawn attempt, so the arrays go: the cell checks become a box walk
and the §5.9 spacing rule becomes four box-pair Chebyshev comparisons.

Signature, return type, rejection order and every failure reason unchanged, and
every pre-existing test is untouched. The rewrite carries an exhaustive
equivalence proof against the retired pairwise implementation, labelled at its
site as a migration artefact rather than as coverage.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** nothing. This is the enabling refactor for Task 5 and a player cannot tell it happened. Stated rather than dressed up.

---

## Task 5: The spawn phase — the city grows, and the default board flips back to it

**Files:**
- Create: `packages/sim/src/spawn.ts`, `packages/sim/test/spawn.test.ts`
- Modify: `packages/sim/src/step.ts` (phase 4), `packages/sim/src/demand.ts` (`pushBlockedSpawnDemand`, `hasEligibleDestinationOfColour`), `packages/sim/src/index.ts`, `packages/shared/src/constants.ts`, `packages/game/src/layouts.ts` (`DEFAULT_LAYOUT_ID`), `packages/game/src/demoLayout.ts` (prose), `packages/game/src/main.ts` (prose)
- Test: `packages/sim/test/determinism.test.ts` (re-bless + timer assertions), `packages/sim/test/step.test.ts`, `packages/sim/test/demand.test.ts`, `packages/game/test/layouts.test.ts`, `packages/game/test/demoLayout.test.ts` (the inertness assertion)

**Interfaces:**
- Consumes: `H_DEST_SPAWN_TIMER`, `H_SPAWN_COLOUR_CURSOR`, `houseSpawnTimer` (Task 1); `footprintWidth`/`footprintHeight`, allocation-free `canPlaceDestination` (Task 4); `placeHouse(state, world, cell, colour): boolean` and `placeDestination(state, world, destCell, orientation, colour, kind): boolean` (existing).
- Produces: `runSpawn(state: GameState, world: WorldData): void`; `spawnZoneX0(): number`, `spawnZoneY0(): number`, `spawnZoneW(w: number): number`, `spawnZoneH(h: number): number`, `spawnZoneCells(world: WorldData): number`, `spawnZoneCellAt(zoneIndex: number, world: WorldData): number`, `inSpawnZone(cell: number, world: WorldData): boolean`, `spawnScanStart(state: GameState, zoneCells: number): number`, `colourUnlocked(colour: number, week: number): boolean`, `houseCountOfColour(state, colour): number`, `destCountOfColour(state, colour): number`; and from `demand.ts`, `pushBlockedSpawnDemand(state: GameState, colour: number): void`.

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
 */
export const HOUSES_PER_DESTINATION = 2
/** §5.9's "future houses of a neighbourhood spawn within ~2 tiles of an existing same-colour house". */
export const HOUSE_NEIGHBOURHOOD_RADIUS = 2
/**
 * Cells examined per spawn attempt [OURS]. Unbounded scanning is up to 308
 * cells x 4 orientations x `canPlaceDestination` inside one tick, which is a
 * frame-dropping spike on a phone however cheap the predicate is. Bounding it
 * also makes §5.3.5's blocked-spawn redistribution reachable rather than
 * theoretical: a crowded board fails an attempt long before it has proved no
 * cell anywhere would work.
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
 * `determinism.test.ts` runs on a 4x4 map, which the rect misses entirely.
 * Every entry point therefore tests the cell count before any modulo: `% 0` is
 * NaN, and a NaN index into a typed array is a silent no-op.
 */
export function spawnZoneX0(): number { return REVEALED_X0 }
export function spawnZoneY0(): number { return REVEALED_Y0 }

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
  it('unlocks colour c at week c, so a five-group map founds a neighbourhood a week', () => {
    expect(colourUnlocked(0, 0)).toBe(true)
    expect(colourUnlocked(1, 0)).toBe(true)   // firstCity seeds colours 0 and 1
    expect(colourUnlocked(2, 1)).toBe(false)
    expect(colourUnlocked(2, 2)).toBe(true)
    expect(colourUnlocked(4, 4)).toBe(true)
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

- [ ] **Step 6: Write the spawners**

```ts
/** A colour joins the city at the week matching its index [OURS] — see the plan's Decision 6. */
export function colourUnlocked(colour: number, week: number): boolean {
  return week >= colour
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
 */
export function attemptHouseSpawn(state: GameState, world: WorldData, colour: number): boolean {
  const week = state.header[H_WEEK] as number
  if (!colourUnlocked(colour, week)) return false
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
 * One destination-spawn attempt. Returns whether a destination was placed.
 *
 * The colour is round-robin over eligible colours from `H_SPAWN_COLOUR_CURSOR`
 * — deterministic, balanced across colours, and no RNG draw. Eligible means
 * unlocked AND already holding at least one house: a destination whose colour
 * has no house accumulates pins no car can ever serve, which under Task 7 is a
 * guaranteed loss the player could not have prevented.
 *
 * Every spawned destination is a `DEST_KIND_SQUARE`. The circle is §5.2's
 * in-place upgrade and M1f owns it.
 */
export function attemptDestinationSpawn(state: GameState, world: WorldData): boolean {
  const groupCount = state.pinAccum.length
  const week = state.header[H_WEEK] as number
  const cursor = state.header[H_SPAWN_COLOUR_CURSOR] as number
  let colour = -1
  for (let k = 0; k < groupCount; k++) {
    const c = (cursor + k) % groupCount
    if (colourUnlocked(c, week) && houseCountOfColour(state, c) > 0) { colour = c; break }
  }
  if (colour === -1) return false

  const zoneCells = spawnZoneCells(world)
  if (zoneCells <= 0) return false
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
        state.header[H_SPAWN_COLOUR_CURSOR] = (colour + 1) % groupCount
        return true
      }
    }
  }
  // §5.3.5: "when no new destination can be placed anywhere, that scheduled
  // demand is pushed into existing destinations instead." Three lines, and it
  // is what makes late-game collapse chain across the map.
  pushBlockedSpawnDemand(state, colour)
  return false
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
  const carpark = carparkCell(destCell, orientation, world.w, world.h)
  if (carpark === -1) return false
  return (
    inSpawnZone(destCell, world) &&
    inSpawnZone(y1 * world.w + x1, world) &&
    inSpawnZone(carpark, world)
  )
}
```

`nearSameColourHouse` is a `HOUSE_NEIGHBOURHOOD_RADIUS` Chebyshev test against every same-colour house, and `houseCountOfColour`/`destCountOfColour` are indexed scans over the live prefixes. All three are allocation-free.

- [ ] **Step 7: Write `runSpawn` and wire phase 4**

```ts
/**
 * Phase 4 of the tick order. Countdown timers, not last-spawn stamps: a
 * countdown resets to a different value on success and on failure, which is
 * exactly what §5.9's separate interval and retry constants describe.
 *
 * **Position.** AFTER phase 3, because "nothing ever spawns on an existing road
 * tile" must see the road the player laid this tick — that is the entire basis
 * of spawn-blocking, which §5.9 calls a major skill expression that must not be
 * accidentally optimised away. BEFORE phase 5, so a destination placed on tick
 * T is inside `H_DEST_COUNT` for tick T's rotation. It reads `H_TICK`
 * (through `placeDestination`'s `destSpawnTick` stamp) and `H_WEEK` (colour
 * unlocks), so its position against phase 1 is an off-by-one with a detector.
 */
export function runSpawn(state: GameState, world: WorldData): void {
  const dt = (state.header[H_DEST_SPAWN_TIMER] as number) - 1
  if (dt > 0) {
    state.header[H_DEST_SPAWN_TIMER] = dt
  } else {
    state.header[H_DEST_SPAWN_TIMER] = attemptDestinationSpawn(state, world)
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

Call `runSpawn(s, world)` in `step` between the input loop and `runDemand`, and extend the phase table to nine entries.

- [ ] **Step 8: Add blocked-spawn redistribution to `demand.ts`**

```ts
/** True iff any destination of `colour` has cleared its first-pin delay as of `tick`. */
export function hasEligibleDestinationOfColour(state: GameState, colour: number, tick: number): boolean {
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) if (isEligibleOfColour(state, d, colour, tick)) return true
  return false
}

/**
 * Spec §5.3.5: a destination that could not be placed pushes its scheduled
 * demand into the existing destinations of its colour instead.
 *
 * Routed through `fireColour`, so it inherits overflow redistribution and the
 * `H_PINS_DROPPED` fallback for free rather than reimplementing either. The
 * guard is required, not defensive: `fireColour` THROWS when no eligible
 * destination of the colour exists, and a colour whose only destinations are
 * inside their 4 s first-pin delay is an ordinary, reachable state.
 *
 * Called from the SPAWN phase, which runs before the field sync, so the
 * `destPins` write it may produce is still ahead of phase 6 exactly as
 * `runDemand`'s is.
 */
export function pushBlockedSpawnDemand(state: GameState, colour: number): void {
  const tick = state.header[H_TICK] as number
  if (!hasEligibleDestinationOfColour(state, colour, tick)) return
  fireColour(state, colour, tick)
}
```

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

  it('pushes the blocked pin into an existing destination when no cell will take one', () => {
    // Vacuity first: the board must genuinely refuse every candidate, and a
    // same-colour eligible destination must genuinely exist to receive it.
    const r = rig('blocked-spawn')
    fillEverySpawnCandidate(r)
    expect(attemptDestinationSpawn(r.state, r.world)).toBe(false)
    const total = sumPins(r.state)
    attemptDestinationSpawn(r.state, r.world)
    expect(sumPins(r.state) + (r.state.header[H_PINS_DROPPED] as number)).toBe(total + 1)
  })

  it('spawning a destination does NOT rebuild a field; its first pin does', () => {
    // A destination with no pin seeds no source, so the field genuinely does
    // not need rebuilding until it receives one — and that pin is a `destPins`
    // write, which IS FIELD_INPUT. Derived, and asserted so the derivation
    // cannot rot into an accident of `destCell` happening to be non-zero.
    const r = rig('spawn-rebuild')
    armDestinationTimerForNextTick(r.state)
    const before = r.scratch.counters[CT_REBUILDS] as number
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(r.scratch.counters[CT_REBUILDS], 'the spawn tick').toBe(before)
    const d = (r.state.header[H_DEST_COUNT] as number) - 1
    r.state.destPins[d] = 1
    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
    expect(r.scratch.counters[CT_REBUILDS], 'the first-pin tick').toBeGreaterThan(before)
  })
```

- [ ] **Step 10: Assert the demo board is inert under the spawner**

In `packages/game/test/demoLayout.test.ts`:

```ts
  it('is at both spawn caps from tick 0, so M1e adds no building to it', () => {
    // Not a coincidence to be enjoyed — an assertion, because it is what
    // protects every measured figure in this file from the spawner.
    const map = demoCity()
    const { state, world } = seededDemo()
    expect(state.header[H_HOUSE_COUNT]).toBe(map.maxHouses)
    expect(state.header[H_DEST_COUNT]).toBe(map.maxDestinations)
    const houses = state.header[H_HOUSE_COUNT] as number
    const dests = state.header[H_DEST_COUNT] as number
    for (let i = 0; i < 20000; i++) step(state, world, fields, scratch, NO_INPUT)
    expect(state.header[H_HOUSE_COUNT]).toBe(houses)
    expect(state.header[H_DEST_COUNT]).toBe(dests)
  })
```

- [ ] **Step 11: Re-bless the state golden with its timer assertions beside it**

The `determinism.test.ts` fixture is 4×4, so its clipped zone is empty and **no building is placed** — only the timers cycle. Hand-compute and assert each before the digest:

```ts
    // M1e Task 5 moves this number, and the plan said so in advance. This
    // fixture's clipped spawn zone is EMPTY (4x4 board against a rect at
    // x >= 5), so no building is placed and the ONLY bytes that moved are the
    // spawn timers. Hand-computed and asserted, so the digest is not the only
    // evidence: the destination timer is armed at 2,250, fires and fails at
    // tick 2,250, and re-fires every `DEST_SPAWN_RETRY_TICKS` = 600 ticks
    // after that; the last attempt at or before tick 13,499 is 13,050, so
    // 13,499 finds it at 600 - (13,499 - 13,050) = 151.
    expect(s.header[H_DEST_COUNT], 'an empty zone places nothing').toBe(0)
    expect(s.header[H_HOUSE_COUNT]).toBe(0)
    expect(s.header[H_DEST_SPAWN_TIMER]).toBe(151)
    for (let c = 0; c < GOLDEN_MAP.groupCount; c++) {
      expect(s.houseSpawnTimer[c], `colour ${c}`).toBe(/* hand-computed, period 300 then 60 */)
    }
```

Re-derive the house figure from `HOUSE_SPAWN_PERIOD_TICKS` = 300 and `HOUSE_SPAWN_RETRY_TICKS` = 60 rather than copying it; if the arithmetic disagrees with the run, the arithmetic is the thing to fix.

- [ ] **Step 12: Flip the default board**

In `packages/game/src/layouts.ts`:

```ts
export const DEFAULT_LAYOUT_ID = CITY_LAYOUT_ID
```

and rewrite the comment above it. It currently argues the demo is the default because *"the starting city is inert on the board that ships… A player opening it sees six cars that never move. M1d's blocking, M1d's ghost roads and M1d's lane speeds cannot fire there at all."* **Every clause of that stops being true in this commit** and the replacement must say why, with the three checkable facts from Decision 11: the opening is solvable for 20 of 30 tiles down columns 8 and 17; the river's two-cell land gap at rows 18–19 keeps the board connected without bridges; and the demo board keeps its id, its seed, its warm start and its golden. Repoint the same claim where it is repeated in `packages/game/src/demoLayout.ts` (*"it is the board a plain load now opens on"*) and in `packages/game/src/main.ts`.

Update `packages/game/test/layouts.test.ts`'s detector — *"the default is the demo board, by name"* — to name the city, keeping it a **named** assertion so a flip fails there first with the id in the message rather than diffusely across twenty boards' worth of assertions.

- [ ] **Step 13: Measure the flipped board before believing it**

Drive the city layout headless for `TICKS_PER_WEEK * 8` with **no player input** and record: destinations placed, houses placed per colour, the week each of colours 2–4 was founded, dropped pins, and whether any spawn attempt ever succeeded outside the revealed rect (it must not). Then repeat with a hand-played input log that lays the 20-tile opening described in Decision 11 and record trips completed. **Both runs go in the commit message.** If the board never reaches four colours, or if the no-input run places nothing, the schedule constants are wrong — fix them here, not in Task 11.

- [ ] **Step 14: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. Only the state golden moved. `integration.test.ts` pins `city` explicitly and re-derives a 258-tick warm start; **that is below the first house attempt at tick 300, below the first destination attempt at 2,250 and below the first week boundary, so none of its derivations may move** — if one does, the schedule reaches earlier than this plan claims.

- [ ] **Step 15: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `spawnZoneW`: drop the clip to `w` | the 4×4 zone test; the state golden |
| `spawnScanStart`: drop the `zoneCells <= 0` guard at both call sites | the 4×4 attempt tests (NaN index, silent no-op) |
| `spawnScanStart`: use `nextRandom` instead of reading `rng[0]` | the "consumes no draw" assertion |
| `spawnScanStart`: drop the `H_TICK` term | the per-tick variation assertion |
| `colourUnlocked`: `>=` → `>` | the unlock test |
| Drop the founding exemption (`houses > 0 &&` on the cap) | the founding test; the 8-week measurement never reaches colour 2 |
| Drop the founding exemption on the radius rule only | the founding test — mutate the two clauses **separately** |
| `attemptDestinationSpawn`: drop the `houseCountOfColour > 0` filter | a colour with no house accumulates pins; assert it in the eligibility test |
| `destinationFitsSpawnZone`: check the origin only | the far-corner assertion in the zone test |
| Move phase 4 before phase 3 | Step 9's paving test |
| Move phase 4 before phase 1 | Step 9's `destSpawnTick` test |
| Drop `pushBlockedSpawnDemand` | Step 9's blocked-spawn test |
| `H_SPAWN_COLOUR_CURSOR` never advances | the 8-week measurement: one colour takes every destination |

- [ ] **Step 16: Commit**

```bash
git add packages/sim/src/spawn.ts packages/sim/src/step.ts packages/sim/src/demand.ts packages/sim/src/index.ts packages/shared/src/constants.ts packages/sim/test packages/game/src packages/game/test
git commit -F - <<'EOF'
feat(sim): the city grows, and the board a plain load opens is the one that does

Phase 4 of nine: houses and destinations spawn inside the clipped revealed
rect on an authored schedule (§5.9) — two destinations a week, houses capped at
two per same-colour destination, a colour founded at the week matching its
index, and §5.3.5's blocked-spawn redistribution when nothing will fit.

Spawning is a PHASE and not a TickAction, so M1d's two inherited 0-detector
transpositions stay inert for the same single reason — and the insertion gives
the clock reader two positions that now have detectors.

DEFAULT_LAYOUT_ID flips back to `city`. The demo board became the default
because the starting city was inert; the spawner is what retires that. Measured
over 8 weeks with no input and with the 20-tile opening: <figures>. The demo
board is at both spawn caps from tick 0 and is asserted unchanged over 20,000
ticks.

State golden re-blessed (<old> -> <new>): its 4x4 board clips the zone to
empty, so no building is placed and only the spawn timers moved — each one
hand-computed and asserted beside the digest.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
```

**Observability:** this is the milestone's first strongly visible change, and it is on the board a plain load now opens. A player draws a road between the three seeded buildings, plays for a minute, and **new houses appear next to the ones they already know**; at 1:15 a **new destination appears somewhere they have no road to**; and at week 2 a **colour they have never seen founds a house**. None of it needs pointing out — the board is different every time they look up.

---

## Task 6: The weekly demand ramp, and the golden nobody has ever had over demand-produced pins

**Files:**
- Modify: `packages/sim/src/demand.ts` (`spawnScale`, `pinPeriodForWeek`, `advanceAccumulators`, the module comment's one-fire invariant), `packages/shared/src/constants.ts`
- Test: `packages/sim/test/demand.test.ts`, `packages/sim/test/loop.test.ts` (a **new** golden), `packages/game/test/demoLayout.test.ts` (re-measured 20,000-tick figures)

**Interfaces:**
- Consumes: `H_WEEK` (existing), `PIN_PERIOD_TICKS`, `DENOM`.
- Produces: `spawnScale(week: number): number`, `pinPeriodForWeek(week: number): number`, and constants `SPAWN_SCALE_BASE = 1000`, `SPAWN_SCALE_PER_WEEK = 110`, `SPAWN_SCALE_MAX = 3000`.

Decision 2 in full: **the ramp scales the PERIOD, not the accumulator**, so week 0 is byte-identical to today and no golden fixture inside week 0 can move.

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

  it('carries the accumulator remainder across a period change, and drains at most three catch-up ticks', () => {
    // The accumulator's `acc -= period` carry is what keeps demand drift-free.
    // A period that SHRINKS at a week boundary can leave `acc` already past
    // the new threshold, and the loop fires once per tick — so the module's
    // "at most one fire per colour per tick" claim needs its bound stated.
    // floor((maxPreviousPeriod - 1) / minPeriod) = floor(517 / 172) = 3.
    const { state, scratch } = accumulatorRig()
    state.header[H_WEEK] = 18
    state.pinAccum[0] = pinPeriodForWeek(18) - 1
    state.header[H_WEEK] = 19
    let fires = 0
    for (let i = 0; i < 4; i++) {
      const before = sumPins(state)
      advanceAccumulators(state, scratch)
      if (sumPins(state) > before) fires++
    }
    expect(fires).toBeLessThanOrEqual(3)
    expect(fires, 'vacuity: a backlog must genuinely have existed').toBeGreaterThan(0)
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

- [ ] **Step 5: Amend the module comment's overstated invariant**

`demand.ts` currently claims *"at most one threshold crossing — one fire — happens per colour per tick: an invariant with its own bound"*, resting on `slotCount ≤ 32 < PIN_PERIOD_TICKS`. That is still true tick-to-tick (`32 < 172`) and it is no longer the whole story. Replace it with the bounded form: a period reduction at a week boundary can leave `acc` above the new threshold, the loop still fires once per tick, and the backlog drains over at most `floor(517 / 172)` = **3** following ticks. **An overstated comment is the same defect class as a test that cannot fail** — it reads as verified and is not.

- [ ] **Step 6: Bless a NEW golden over demand-produced pins**

This has been carried forward twice: *"No golden covers demand-produced pins. The loop golden's fixture pre-pins to keep `destPins` stable under assertion, so the pin timer is frozen."* Close it here, because the ramp is the first change that makes the pin timer's behaviour week-dependent.

Add a **second fixture in `loop.test.ts` with its own golden**, rather than editing the existing one — editing it would retire the four-route cost matrix its leading vacuity test protects, and would move the loop golden for a fourth time. The new fixture: buildings placed out of band, **no direct `destPins` writes at all**, run across a week boundary so both periods are exercised, with a hand-computed ladder of pin-arrival ticks derived from `pinPeriodForWeek(0)` = 518 and `pinPeriodForWeek(1)` = 466.

```ts
  it('produces pins from the timer alone, across a week boundary, and pins the digest', () => {
    // The first fixture in the repo whose `destPins` are produced by
    // `runDemand` rather than written by the test. Carried forward from M1c
    // twice; the ramp is what finally makes it worth having, because the pin
    // cadence is now a function of the week.
    const r = demandGoldenRig()
    for (let i = 0; i < DG_RUN_TICKS; i++) step(r.state, r.world, r.fields, r.scratch, NO_INPUT)
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

- [ ] **Step 7: Re-measure the demo board's 20,000-tick figures**

`demoLayout.test.ts` quotes figures over a 20,000-tick window after a 1,200-tick warm start. That window spans weeks 0 through 4, so the ramp is live inside it and those figures **will move**. The 3,000-tick and 900-tick windows end at ticks 4,200 and 2,100, both inside week 0, and **must not move** — assert that explicitly rather than observing it.

Re-measure and record old → new for each 20,000-tick row (longest queue, ticks with queue ≥ 3). Read them through `queueProbe.ts`'s `travelDir`/`carAheadOf` exactly as they are: **do not "simplify" the probe back to deriving the lane from the car's direction of travel** — a car occupies the lane it ENTERED by, that variant disagrees with `canEnter` on 5.9–10.0 % of questions, and on a starved corridor it read a longest queue of 11 against a true 16.

- [ ] **Step 8: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS, **with no golden moved.** The state golden's fixture has no destinations, so `slotCounts` are 0, `pinAccum` never advances and no fire can occur however the period is scaled. If it moves, the ramp reached somewhere this plan says it cannot.

- [ ] **Step 9: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `spawnScale`: `* week` → `* (week - 1)` | the scale table, at week 0 |
| `spawnScale`: drop the cap | the scale table at week 200 |
| `spawnScale`: cap at `>=` instead of `>` | nothing — **record as an equivalent mutant**, since 3,000 is not reachable except through the cap |
| `pinPeriodForWeek`: `* DENOM` dropped | week-0 test (period 0, then a fire every tick) |
| `advanceAccumulators`: `acc = 0` instead of `acc -= period` | the carry test and the new golden |
| Hoist `period` outside the per-tick call and cache it for the run | the new golden (the second cadence never arrives) |
| `>= period` → `> period` | the new golden's fire ladder, by exact tick |

- [ ] **Step 10: Commit**

```bash
git add packages/sim/src/demand.ts packages/shared/src/constants.ts packages/sim/test packages/game/test/demoLayout.test.ts
git commit -m "$(cat <<'EOF'
feat(sim): demand ramps weekly, by shrinking the period rather than scaling the accumulator

spawnScale(w) = 1.0 + 0.11*(w-1) capped at 3.0 (§5.3), applied to the
accumulator's THRESHOLD. Week 0 is 518 ticks, bit-for-bit today's constant, so
no golden fixture — all of which run inside week 0 — moves.

Closes a gap carried forward twice: a new golden over pins produced by the
timer rather than written by the test, across a week boundary so both cadences
are exercised.

demoLayout's 20,000-tick figures re-measured (they span weeks 0-4); its 3,000-
and 900-tick figures are asserted unchanged, both windows ending inside week 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** on the default board, a player who has kept up for five minutes finds that the same road network stops coping. Cars queue where they did not, and the pin dots under destinations stop clearing between arrivals. It is the first thing in the milestone that makes the player's own network feel like it is being outgrown — and it is deliberately not announced, because a difficulty ramp that needs a caption is not a difficulty ramp.

---

## Task 7: The overcrowd meter — the ramp, the unwind, the knockback

**Files:**
- Create: `packages/sim/src/overcrowd.ts`, `packages/sim/test/overcrowd.test.ts`
- Modify: `packages/sim/src/step.ts` (phase 10), `packages/sim/src/trips.ts` (the arrival knockback), `packages/sim/src/index.ts`, `packages/shared/src/constants.ts`
- Test: `packages/sim/test/trips.test.ts`, `packages/shared/test/constants.test.ts`

**Interfaces:**
- Consumes: `destOvercrowd`, `destOverTicks` (Task 1); `destPins`, `destMeta`, `H_DEST_COUNT` (existing).
- Produces: `overcrowdTriggerCap(state: GameState, d: number): number`; `overcrowdRampSpeed(overTicks: number): number`; `arrivalKnockback(meter: number): number`; `applyArrivalKnockback(state: GameState, d: number): void`; `runOvercrowd(state: GameState): void`; `assertOvercrowdNonNegative(value: number, d: number): void`. **`runOvercrowd` does not end the run — Task 8 adds that**, so this task's meter can saturate and nothing happens.

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
    // in this milestone.
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
    for (let i = 0; i < peak; i++) runOvercrowd(state)
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
    expect(arrivalKnockback(900000), 'the cap binds exactly here').toBe(ARRIVAL_KNOCKBACK_MAX_MILLITICKS)
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

- [ ] **Step 5: Wire the knockback into arrivals and phase 10 into `step`**

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

- [ ] **Step 6: Pin phase 10's position**

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

- [ ] **Step 7: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS, **with no golden moved.** Derived: the state golden's fixture has no destinations; the loop fixture's `destPins` never exceeds 1 against a trigger of 6; the queue and multiplier fixtures run 130 and 110 ticks; the two seed goldens are pre-tick. **Confirm the loop fixture's maximum `destPins` by measurement, not by reading** — it is the only one where the margin is a number rather than a structural zero.

- [ ] **Step 8: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `isOverCapacity`: `>=` → `>` | the trigger test, both kinds |
| `overcrowdTriggerCap`: return the HARD cap instead of the timer cap | the trigger test, both kinds |
| `overcrowdRampSpeed`: drop the `> DENOM` clamp | the ramp table at 15,000 ticks; the 3,390 test |
| `overcrowdRampSpeed`: `/ TICKS_PER_SECOND` → `/ DENOM` | the ramp table and the 750,000 sum |
| `runOvercrowd`: drop the saturation | the saturation test |
| `runOvercrowd`: unwind by `DENOM` instead of `OVERCROWD_RETURN_MUL` | the unwind test |
| `runOvercrowd`: do not reset `destOverTicks` on the under-capacity branch | the unwind test's second assertion |
| `arrivalKnockback`: drop the cap | the knockback table at the fail value |
| `isOverCapacity`: read `destPins - destReserved` | the carpark-immunity test |
| Move phase 10 before phase 9 | Step 6's brink test |

- [ ] **Step 9: Commit**

```bash
git add packages/sim/src/overcrowd.ts packages/sim/src/step.ts packages/sim/src/trips.ts packages/sim/src/index.ts packages/shared/src/constants.ts packages/sim/test packages/shared/test
git commit -m "$(cat <<'EOF'
feat(sim): the per-destination overcrowd meter (§5.8)

Phase 10 of ten. Two Int32 quantities per destination: consecutive ticks over
capacity, saturating at the 1,500-tick point where §5.8's ramp reaches full;
and the integrated meter in milli-ticks, unwound at 2x when back under and
knocked back 10% (capped at 3 s) on every arrival.

The spec's "~113 s" is exact: the ramp sums to 750,000 milli-ticks, the
remaining 1,890,000 accrues at 1,000/tick, and a starved destination fills on
the 3,390th consecutive over-capacity tick and not the 3,389th.

Nothing ends the run yet — that is the next commit, deliberately, so the meter
can be wrong loudly before it can be wrong fatally.

No golden moved.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** nothing yet, and deliberately so. The meter runs and no pixel reads it — Task 9 draws the ring and Task 8 makes it fatal. Splitting the arithmetic from the consequence is what lets the 3,390-tick derivation be wrong loudly in a test rather than fatally in a run.

---

## Task 8: Game over

**Files:**
- Modify: `packages/sim/src/overcrowd.ts` (fire the flag), `packages/sim/src/step.ts` (the early return), `packages/game/src/frame.ts` (`onGameOver`), `packages/game/src/main.ts` (pause on it)
- Test: `packages/sim/test/overcrowd.test.ts`, `packages/sim/test/step.test.ts`, `packages/sim/test/rollback.test.ts`, `packages/game/test/frame.test.ts`, `packages/game/test/integration.test.ts`

**Interfaces:**
- Consumes: `isGameOver`, `failedDestination`, `H_GAME_OVER`, `H_FAILED_DEST` (Task 1); `runOvercrowd` (Task 7).
- Produces: `FrameDriverDeps.onGameOver: () => void` — **required, not optional.**

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

- [ ] **Step 5: Wire the loop to follow**

In `packages/game/src/frame.ts`, add to `FrameDriverDeps`:

```ts
  /**
   * Called ONCE, on the tick `isGameOver(state)` first becomes true. `main.ts`
   * pauses the loop from it.
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

In `main.ts`, pass `onGameOver: () => { loop.setPaused(true) }`.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS, no golden moved (no golden fixture reaches a meter of 2,640,000 — the highest `destPins` in any of them is 1).

- [ ] **Step 7: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| `>= OVERCROWD_FAIL_MILLITICKS` → `> ` | the 3,390 test (fires at 3,391) |
| Compare against `OVERCROWD_FULL_MILLITICKS` (drop the grace) | the 3,390 test |
| Drop the `return` after setting the flag | the "names the destination" test, with two destinations completing together |
| Move the `isGameOver` early return **after** the `H_EPOCH` write | the poison test |
| Delete the early return entirely | the byte-identical freeze test |
| Call `onGameOver` on every frozen tick | the "exactly once" assertion |
| Make `onGameOver` optional in the type | **no runtime detector — this is a TYPE-level guard**, and `frame.test.ts` pins it with a `@ts-expect-error` construction missing the field |

- [ ] **Step 8: Commit**

```bash
git add packages/sim/src/overcrowd.ts packages/sim/src/step.ts packages/game/src packages/sim/test packages/game/test
git commit -m "$(cat <<'EOF'
feat(sim): the city shuts down (§5.8)

A completed meter sets H_GAME_OVER and H_FAILED_DEST, and `step` returns
immediately on every later tick — before the H_EPOCH write, so the frozen state
stays restorable. The freeze is in `sim` and not in the caller because a Worker
replaying a log that runs past the failure must score identically to the
browser that produced it.

The frame loop follows through a REQUIRED onGameOver callback, fired once.

No golden moved: the highest destPins in any golden fixture is 1, against a
trigger of 6.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** the run can now end — but with no overlay yet, what a player sees is the board **stopping dead**: cars frozen mid-cell, the week/day clock stuck, taps doing nothing. That is unmistakable and it is also indistinguishable from a crash, which is precisely why Task 9 is not optional and must ship in the same milestone.

---

## Task 9: The overcrowd ring and the shutdown screen

**Files:**
- Modify: `packages/render/src/types.ts` (`RenderFrame`, `Palette`), `packages/render/src/canvas.ts` (the ring, the scrim), `packages/render/src/palette.ts`, `packages/game/src/frame.ts` (the fold), `packages/game/src/main.ts` (palette entries)
- Test: `packages/render/test/canvas.test.ts`, `packages/render/test/interface.test.ts`, `packages/game/test/frame.test.ts`, `packages/game/test/drawAllocation.test.ts`

**Interfaces:**
- Consumes: `state.destOvercrowd` (Task 1/7), `isGameOver`/`failedDestination` (Task 1/8), `OVERCROWD_FULL_MILLITICKS` (Task 7).
- Produces: `RenderFrame.destOvercrowd: Uint8Array` (0–255 per destination), `RenderFrame.gameOver: boolean`, `RenderFrame.failedDest: number` (−1 when live); `Palette.overcrowd: string`, `Palette.scrim: string`.

**`render` imports nothing from `sim`**, so the fold happens in `game`'s `buildFrame` and the renderer receives numbers it can draw without asking anything — the same rule that already routes `weekOfTick`, `carparkCell` and `destMetaColour` through that file.

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

- [ ] **Step 4: Write the failing draw tests**

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

  it('draws the shutdown scrim over the board and never over the HUD band', () => {
    const rec = drawWith(gameOverFrame())
    const scrim = rec.commands.find((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)!
    expect(scrim.y).toBeGreaterThanOrEqual(camera.hudTop + camera.hudHeight)
    expect(scrim.y + scrim.h).toBeCloseTo(camera.cssH * camera.dpr, 5)
  })

  it('names the score on the shutdown screen, as a whole line', () => {
    // Asserted as the WHOLE line, not `toContain(String(score))`: a substring
    // assertion over a composed message is satisfied by any other part of it,
    // and a boot-failure panel in this repo already scored 0 detectors that way.
    const rec = drawWith(gameOverFrame({ score: 47 }))
    const texts = rec.commands.filter((c) => c.op === 'fillText').map((c) => c.text)
    expect(texts).toContain('47 TRIPS')
  })

  it('draws nothing of the shutdown when the run is live', () => {
    const rec = drawWith(liveFrame())
    expect(rec.commands.some((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)).toBe(false)
  })
```

- [ ] **Step 5: Implement the two draw phases**

Add the ring inside the existing destination phase (so it inherits that phase's culling and its `destCarpark` sentinel handling rather than growing a second copy), and the scrim plus two text lines as a new final phase after the HUD. Both are preallocated-constant strings — **no template literals per frame**; the score line is built with the same digit-writing helper the HUD score already uses, because `canvas.ts`'s module comment records that this file does no string concatenation for exactly this reason.

- [ ] **Step 6: Give `drawAllocation.test.ts` a ring count and a scrim count, and assert both**

The driver is a fixed 4-cell road with 6 cars and 3 pins and contains **no over-capacity destination and no game over**, so without new counters the budget is vacuous for this task and injecting an allocation into either new phase leaves it green — which reads as an inert harness. The driver already builds a `{ blits, cars, pins, clockTexts, ghostBlits }` object and asserts it; add `rings` and `scrimFills`, drive a part-filled meter across the profiled window, and drive a **second** rig that is in game over. **A fixture that stops drawing rings must turn the harness RED, not quietly measure less.**

- [ ] **Step 7: Prove the harness is live by injecting into the NEW code**

Inject an escaping allocation into the ring phase specifically — not into something already covered — and confirm `drawAllocation.test.ts` goes red. A green harness plus a red injection somewhere else is not evidence about the thing you just wrote. **Re-run before believing either result**: this file flakes roughly 1 run in 10.

- [ ] **Step 8: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. No golden moves — `render` and the draw path are outside the state buffer.

- [ ] **Step 9: Mutation-test this task**

| Mutation | Expected detector |
|---|---|
| Fold against `OVERCROWD_FAIL_MILLITICKS` | the hidden-grace fold test |
| Fold with no `> 255` clamp | the fold test at a hand-set over-max meter |
| Draw a ring for every destination, including zeroes | the "only for non-zero" test |
| Index the ring by draw order rather than destination index | the "at the destination it belongs to" test |
| Shrink the ring loop's far bound | the both-directions test's inside half |
| Draw the scrim over the whole canvas including the HUD | the scrim geometry test |
| Draw the scrim while live | the "nothing when live" test |
| Print the score without its unit | the whole-line text test |

- [ ] **Step 10: Commit**

```bash
git add packages/render/src packages/render/test packages/game/src/frame.ts packages/game/src/main.ts packages/game/test
git commit -m "$(cat <<'EOF'
feat(render): the overcrowd ring, and the screen that says the city shut down

A ring around every destination whose meter is non-zero, folded in `game`
against §5.8's FULL 90 s rather than the 88 s that ends the run — so the ring
is never full at the moment it kills you, which is what the spec's 2 s hidden
grace means. Plus a scrim over the board, the reason, and the score.

drawAllocation gains `rings` and `scrimFills` counters and asserts both, and
liveness was proved by injecting into the new phases specifically.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** this is the task the milestone is for. On the default board, a destination the player has not connected grows a **ring that visibly fills**, and they can watch it drain when a car finally arrives. If they ignore it, the board goes dark and tells them **which destination shut the city down and how many trips they made**. Nothing here needs to be pointed at.

---

## Task 10: Routing stays congestion-blind, and the comment sweep

**Files:**
- Create: the congestion-blindness property test in `packages/sim/test/flowfield.test.ts`
- Modify: `packages/sim/src/regions.ts`, `scratch.ts`, `state.ts`, `dispatch.ts`, `trips.ts`, `cars.ts`, `buildings.ts`, `roads.ts`, `world.ts`, `step.ts`; `packages/shared/src/constants.ts`, `mapFormat.ts`, `maps/firstCity.ts`; `packages/render/src/types.ts`, `canvas.ts`; `packages/game/src/shell.ts`, `demoLayout.ts`; `packages/shared/test/constants.test.ts`, `packages/game/test/frame.test.ts`, `packages/sim/test/flowfield.test.ts`, `cars.test.ts`, `loop.test.ts`, `step.test.ts`

**Interfaces:**
- Consumes: everything landed so far. Produces no new API. **This task is independent of Tasks 3–9 and can be reviewed on its own**, though it must run after them so the sweep sees the final source.

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
    // board and proves nothing about congestion.
    expect(refusalsIn(r)).toBeGreaterThan(0)
    expect(longestQueueIn(r)).toBeGreaterThanOrEqual(3)

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

**A comment that names a milestone which passed is worse than no comment — it reads as satisfied.** That is how the bot URL went stale and how board expansion survived a milestone. Sweep every site and route each to a real recipient:

- **`regions.ts`** — six dated reasons say *"M1e's demand-actuated lights make car positions a field input"* (the car regions, `occupancy`, `carBlockedTicks`, and both ghost regions' "dated: M1e, with occupancy"). M1e ships no lights: repoint all six to **M1f** and say why the date moved.
- **`scratch.ts:34,40,57,59,136`** — the motorway/third-edge-cost-tier predictions. Repoint to **M1f**, and correct rather than repoint where the prediction was wrong about the mechanism, in the form the file already uses for M1d.
- **`state.ts:460`**, **`dispatch.ts:688`**, **`trips.ts:63`** — *"M1e's destination removal"*. M1e removes no destination; all three properties are still inert. Repoint to **M1f** and, at `dispatch.ts:688`, keep the sharpened trigger ("a dispatch-time read of a shared, non-commutative resource") rather than only the milestone name.
- **`cars.ts:129`** — *"M1e's motorway tier is the next thing that touches this"*. Repoint to **M1f**.
- **`buildings.ts:31`** — *"building placement is an explicit, out-of-band call the M1e spawner will eventually drive"*. **Mark satisfied**: `spawn.ts` is the caller, and `canPlaceDestination` is now on a per-tick path, which that comment explicitly warned against — so the warning must be replaced with the fact that Task 4 made it allocation-free.
- **`roads.ts:167`**, **`shared/constants.ts:38`** — *"what M1e's traffic lights and roundabouts are for"*. Repoint to **M1f**.
- **`shared/constants.ts:104`** — *"M1e's tuning is the first real evidence"* about the 1,350-tick valve. **Mark answered with a number** from Task 11's long run, or repoint if that run does not fire the valve.
- **`shared/constants.ts:142,148`**, **`mapFormat.ts:21,29`**, **`maps/firstCity.ts:9`**, **`render/types.ts:124`**, **`canvas.ts:372`**, **`game/shell.ts:173`**, **`shared/test/constants.test.ts:102`**, **`game/test/frame.test.ts` (three sites)** — the board-expansion handoff. Repoint to **M1f**, and at `constants.ts`'s `REVEALED_*` block **delete the false claim that "nothing in `sim` reads these"** and name `spawn.ts`, which does. At `frame.test.ts`, keep the diagonal-corner warning intact: it is the thing that will bite whoever finally makes the fold 2-D.
- **`world.ts:75`** — *"building spawn zones are the M1e spawner's input… when they land, they must be folded into `mapIdHash`"*. **Amend rather than repoint**: they landed, and they are **not** on `MapData` — the zone is the shared revealed rect, so nothing needed folding. State that, and state that a **per-map** zone still would.
- **`render/types.ts:197`** — *"There is nothing to spend until M1e"*, about the tiles readout standing in for §7.2's inventory chip row. **Partly satisfied**: there is now a weekly grant to spend, and still no inventory. Say both.
- **`demoLayout.ts`** — the headline calling the demo *"the board a plain load now opens on"*, already corrected by Task 5; verify it, since this is the file whose fourth headline was wrong once before.

- [ ] **Step 4: Verify the sweep by name, not by reading**

```bash
grep -rn "M1e" packages/ --include="*.ts" | sed 's/\(.*\.ts:[0-9]*\).*/\1/' | sort
```

Every surviving hit must be one this task deliberately kept (a satisfied-and-recorded note), and every entry in Step 3's list must be gone or changed. **Check by grep per item against the list, not by reading the diff** — a handoff document once passed a reading with two of its eight items simply absent.

- [ ] **Step 5: Confirm the two labelled-inert equivalent mutants are still inert**

Both were carried forward as *correct as labelled, and must not be "fixed" by adding a test that cannot fail*, each with a named condition that ends it:

1. **The rounding direction of the lane-speed multiplier average** (`cars.ts`, `laneSpeedMul`) is inert because `speedUnits` maps each of 583/584 to 192 and each of 416/417 to 137 — *"over the whole reachable set, not over a sample"* — and it **stops being inert the moment `CAR_SPEED_UNITS_PER_TICK` or any multiplier constant changes**. M1e changed neither: assert that by reading the constants, record it in `cars.ts`, and **do not manufacture a detector**.
2. **`y < 0` in `stepCell`** (`roads.ts`) is a verified equivalent mutant through either caller. Untouched by this milestone. **Do not tighten either caller's `next < 0` to `next === -1`** to manufacture one — that satisfies the bullet by strictly weakening two guards.

- [ ] **Step 6: Run the suite and commit**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`

```bash
git add packages
git commit -m "$(cat <<'EOF'
docs+test(sim): routing is congestion-blind on purpose, and it finally has a detector

The field golden runs on a fixture with no cars, so an occupancy-dependent edge
cost would leave it green. A property test on a genuinely jammed board now
rewrites occupancy and carBlockedTicks arbitrarily and asserts byte-identical
fields and an unmoved CT_REBUILDS.

Plus the comment sweep: every "M1e" in packages/ is now satisfied-and-recorded
or repointed to a real recipient. Six FIELD_IRRELEVANT dates, three
destination-removal triggers, the whole board-expansion handoff, and the false
claim that nothing in `sim` reads REVEALED_* — which `spawn.ts` now does.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** nothing, and this task is the clearest case in the milestone of work that is worth doing anyway. A player cannot see a comment. What they will see, one milestone from now, is whether the person who adds the first congestion penalty finds the `NB` trap written down before they hit it or after.

---

## Task 11: Integration, the long run, the tick order re-measured, the deploy, and the handoff

**Files:**
- Modify: `packages/game/test/integration.test.ts`, `packages/sim/test/loop.test.ts` (the long run), `packages/game/test/allocation.test.ts`, `packages/sim/src/step.ts` (the re-measurement record), `packages/game/src/main.ts` (`?startapp=fallback`)
- Create: `docs/superpowers/m1f-carry-forward.md`

**Interfaces:** consumes everything. Produces no new API.

- [ ] **Step 1: The end-to-end test must show a LOSS, on the board that ships**

Not merely that a meter moves. Drive the **city layout through its real boot path** with no player input and assert: the run ends; `failedDestination` names a destination that was never connected to a road; `H_SCORE` is 0; and the tick it ends on is within a hand-derived window from the first destination's first pin plus its capacity fill plus 3,390. Then drive the same layout with a hand-played input log that lays the 20-tile opening from Decision 11 and assert it **survives strictly longer and scores strictly more**. **The comparison is against the hand-computed figure named in the same clause, not against a recorded run of a fixture that does not exist.**

Guard both arms against degenerating: cars dispatched > 0 in the played arm, at least one destination over capacity in the unplayed arm, and the played arm's score strictly above zero.

- [ ] **Step 2: Fold the erase/re-place cycle into the long run, and assert the tile ledger**

Carried forward: *"The shipped long-run test never erases a road, so the ghost path has no long-horizon coverage in the suite — the 25,000-tick evidence lives in a review, not in a test. A finding whose only carrier is a report is the shape this project keeps getting bitten by."*

Extend the long run to ≥ 25,000 ticks with an erase/re-place cycle every 700 ticks, and assert every tick:

```ts
      // The refund ledger is BUDGET-EXACT — the whole-milestone review measured
      // `tiles + roadCells + ghostCells` constant at 9,999 across 25,000 ticks
      // with an erase/re-place cycle every 700. Only the TIMING of a deferred
      // refund can be early or late, never the amount. This is the invariant to
      // assert if anyone touches `settleErasedCell`, `payGhostRefund` or
      // `noteGhostDeparture`, and until now it lived only in a report.
      expect(tilesLeft(state) + roadCellCount(state) + ghostCellCount(state)).toBe(LEDGER_TOTAL)
      assertOccupancySound(state, world)
      expect(sumReserved(state)).toBe(countPhase(state, PHASE_OUTBOUND))
```

`assertOccupancyComplete` is asserted **only on the ticks where the valve has not fired** — its exception set is real (a car that has not crossed on its current leg, and a car displaced by the valve), and asserting it unconditionally would be asserting something known false.

Also assert: no counter wraps; every `destOvercrowd` is in `[0, OVERCROWD_FAIL_MILLITICKS]`; two identical runs agree on `hashState`; and no car starves.

- [ ] **Step 3: Re-measure the tick order over ten phases**

M1d ran the complete pairwise set C(7,2) = 21 and recorded it in `step.ts` because *"the historical figure of 13 reorderings is written down nowhere and cannot be reproduced from its own description"*. There are now **ten** phases: run **C(10,2) = 45**, stated as an enumeration so it reproduces from this sentence. Record the table in `step.ts`, replacing M1d's.

Three things this must get right:

- **Run the control as many times as the mutant.** M1d's first pass reported 1 detector for each inert swap, which read as "the milestone ended the inertness"; re-run four times each alongside four unmutated baselines, **the baseline itself scored 1 in one round**, and the flake was `allocation.test.ts`'s sampling profiler. A flaky baseline reads exactly like a kill.
- **Use the complement check.** Ten of M1d's nineteen non-zero rows collected fewer tests than baseline because those reorderings made `step` throw during test **collection**, so a whole file never ran. Their counts were lower bounds on a partly-unrun suite. Record which rows collected a short suite.
- **State the expected result before running.** `1↔2` (clock ↔ week grant) and `1↔4` (clock ↔ spawn) and `3↔4` (inputs ↔ spawn) and `9↔10` (arrivals ↔ overcrowd) each have a named detector written in Tasks 2, 5 and 7. **If any of the four scores 0, the detector does not work and the task that wrote it was wrong** — report that rather than recording the zero.

- [ ] **Step 4: Extend the tick-side allocation profile to the three new phases**

`allocation.test.ts` profiles `packages/game/src` **and** `packages/sim/src` and measures the tick. Its rig must now enter the new branches, gated on **per-branch entry counters asserted non-zero** in the style of the existing `DragCounters`: week boundaries crossed, house spawns attempted **and** succeeded, destination spawns attempted **and** succeeded, blocked-spawn redistributions fired, destinations over capacity, and arrival knockbacks applied. **A fixture that stops spawning must turn the harness RED, not quietly measure less.**

The destination-spawn path is the one with a real risk: it was allocating before Task 4 and it runs 96 `canPlaceDestination` calls on a failing attempt. **Reinstate the pre-Task-4 `allSevenCells` as a positive control**, confirm the harness charges it, and remove it. Report the figures as a **range over stated draws**, never as a point — this instrument has a 2.6× spread between draws on its clean window.

- [ ] **Step 5: Verify no fourth `Uint8Array` decrement path appeared**

Enumerate every write to every `Uint8` region in `packages/sim/src` — `roads`, `cleared`, `houseColour`, `destMeta`, `destPins`, `destReserved`, `carPhase`, `carRoute`, `ghostMask`, `ghostCommitted`. **Enumerate the writes; do not grep for `--`**: the one path M1d added spells it `const left = committed - 1` across two statements and no `--`-shaped pattern matches it. The set must still be exactly three (`destPins`, `destReserved`, `ghostCommitted`), and M1e's two new decrements (`destOvercrowd`'s unwind and knockback) must both be on `Int32` regions and both floored. Record the result in `trips.ts`'s standing note.

- [ ] **Step 6: Revive `?startapp=fallback`**

Carried forward: *"`?fallback=1`, this project's documented recovery hatch for 'MainButton reported but never rendered', is unreachable on a phone today"* — a Telegram webview has no address bar and the SDK reads `location.hash`, never `location.search`. `layoutToken` (`main.ts`) already reads three sources; wire `?startapp=fallback` into `preferFallback` for the cost of one line, and give it a test that the token reaches the flag. **This is the erase control's recovery hatch**, and without it a client that reports a `MainButton` and never renders one leaves the player unable to erase, with no way to say so.

- [ ] **Step 7: Build, deploy, verify the ARTEFACT**

**Sequencing matters and the order is not negotiable: run the suite, then `pnpm build`, then deploy, then verify — and re-verify rather than re-build if it reports a mismatch.**

`wrangler deploy` can print `Success! Uploaded N files` while the deployment never activates and the previous asset hash keeps being served. `packages/game/scripts/verify-deploy.js` makes **two** fetches: `GET /` must carry `<meta name="laneways-build" content="…">` with the id from `.build-id`, and **the module script the served document actually names** must contain it too — a fresh document pointing at a stale bundle is a blank board and the first check cannot see it.

**A mismatch has three causes, not two.** The artefact is stale; the deployment did not activate; or **the expectation is stale**. The third was blamed on a person for a milestone: vitest loads `packages/game/vite.config.ts` as its own config, so the build-id plugin ran on every `vitest run` and `closeBundle` wrote a fresh id at the end of the test run — including the run immediately before a deploy. `apply: 'build'` fixed it and `test/toolchain.test.ts` pins it. Confirm `.build-id` is untouched by a full suite run before trusting a mismatch.

**The Telegram Mini App URL is set in @BotFather and is NOT settable through the Bot API** — `setChatMenuButton` returns `ok: true` and changes nothing. If the URL must change, say so and stop; it is a human action.

- [ ] **Step 8: One human, one phone, three questions**

The last time a person looked at this game was the demo board on 2026-08-10. Fold all three open visual questions into one session, because none has any other route to an answer:

1. **The new default board.** Open a plain link. Is the empty starting city legible as *"draw a road here"*, or does it read as a broken load? Does the first spawned building read as an event?
2. **The overcrowd ring and the shutdown screen.** Let a destination die on purpose. Is the ring readable at phone size against the pin dots already drawn there? Does the shutdown screen say what happened?
3. **The ghost art, which is tested and has never been LOOKED AT.** 182 assertions across three render test files, and zero human minutes. Two pure aesthetic judgements sit inside them: the ghost stroke is **half** the live road's width (`atlas.ts:112`), and spec §6's 55–65 % width band was **deliberately ruled not to apply** (`atlas.ts:120`) on the reasoning that the band governs roads and *"a ghost is the absence of one."* That reasoning is sound and unvalidated. A half-width dashed ghost may read as an elegant fade or as a rendering glitch, and **only a person looking at a phone can tell those apart.** Note that the demo board is now behind `?startapp=demo`, and the erase headline needs a **five-cell** stroke to fade three cells (a drag samples adjacent pairs, so a stroke over N cells clears both bits off only the N − 2 in the middle), and whether a cleared cell ghosts at all depends on the traffic at that instant.

Record the answers with the word "one device, qualitative" attached, exactly as the 2026-08-10 session did. **It is evidence that the architecture holds, not a measured budget.**

- [ ] **Step 9: Write `docs/superpowers/m1f-carry-forward.md`**

Nothing else does, and it has never been owned by a task — it got written at every prior milestone close anyway, which is a base rate, not a mechanism. **Check it against a checklist of names, not by reading it**: M1d's carry-forward had eleven well-organised sections and 336 lines and two of its eight items were simply absent, and both survivors were the ones with no code artefact to anchor them. Everything in "What this plan does not settle", every row of the Out table, the golden ledger, the re-measurement record and the device answers reach M1f only through this file.

- [ ] **Step 10: Commit**

```bash
git add packages docs/superpowers/m1f-carry-forward.md
git commit -m "$(cat <<'EOF'
test(game): the run can be lost end to end, and the milestone hands off

An unplayed city dies at a hand-derived tick with a score of 0; the same city
with a 20-tile opening survives longer and scores more. The long run is 25,000
ticks with an erase/re-place cycle every 700 and asserts the tile-ledger
identity every tick — evidence that until now lived only in a review.

Tick order re-measured over C(10,2) = 45 pairwise transpositions, with four
baselines per mutant and the complement check on every row.

?startapp=fallback revives the erase-control recovery hatch. Deploy verified
against the served artefact, both fetches. One human, one phone, three
questions — including the ghost art, which had 182 assertions and zero human
minutes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
EOF
)"
```

**Observability:** the whole milestone, on a phone, held by a person. A plain link opens a board where buildings appear, tiles arrive every two and a half minutes, rings fill on destinations you have not reached, and the city eventually shuts down and tells you your score. If that session does not produce those four sentences unprompted, the milestone missed — and this is the step where that is found out, not the user.

---

## Sequencing: what can be reviewed apart, and where the real dependencies are

- **Task 1 blocks everything.** It is the milestone's only shape change and every later task assumes the regions exist.
- **Tasks 3 and 4 are independent of the rest and of each other.** Task 3 (the flow-field allocation) touches only `flowfield.ts`/`scratch.ts` and is provable by the field tripwire; Task 4 (allocation-free placement validity) touches only `buildings.ts` and is provable by its equivalence run. Either could be reviewed by someone with no context on the game loop, and both could run before Task 2 if a reviewer's schedule wanted it.
- **Task 2 must precede Tasks 5–8**, not for code reasons but for the handoff: it is the task that puts a clock reader in a falsifiable position, and doing it after the spawner would mean the spawner lands while the transposition question is still open.
- **Task 5 depends on Tasks 1, 2 and 4** and is the milestone's largest. Its default-board flip is the one step whose failure mode is player-visible, and it carries its own measurement gate.
- **Task 6 depends only on Task 1** and could be reviewed in parallel with Task 5 by a second reviewer; its only coupling to the spawner is that the two together decide the difficulty curve, which Task 11 measures.
- **Task 7 depends only on Task 1. Task 8 depends on Task 7** and is deliberately split from it, so the 3,390-tick arithmetic can be wrong in a test before it can be wrong in a run.
- **Task 9 depends on Tasks 7 and 8** and touches no `sim` file, so it is the natural task for a renderer-focused reviewer.
- **Task 10 is independent of Tasks 3–9** in code and must run after them in time, so the sweep sees the final source.
- **Task 11 depends on everything.**

The one ordering that is a correctness requirement rather than a convenience: **Task 4 must land before Task 5**, or the spawner puts an allocating predicate on a per-tick path and the allocation harness reports it as a regression Task 5 did not introduce.

---

## What this plan does not settle

- **Whether the demand ramp's three numbers are right.** Spec §5.3 calls `spawnScale` *"the single most important tuning unknown in the project"* and §13 lists it as an open risk whose mitigation is the telemetry overlay. M1e is the first milestone in which it can be wrong in a way anyone notices. Expect several passes, and note that changing it is a `rulesVersion` bump that invalidates stored replays.
- **Whether `DESTINATIONS_PER_WEEK` = 2 and `HOUSES_PER_DESTINATION` = 2 pace the city well.** Both are [OURS] with no source at all. The 8-week measurement in Task 5 says the board fills; it does not say the filling feels good.
- **Whether the pin capacities are the right run-length dial.** §5.8 says they are — *"square triggers the timer at 6, hard cap 10; circle at 8, hard cap 14. These are the primary run-length dial. Tune them before touching anything else."* M1e implements them and tunes nothing.
- **Whether one car per lane-tile feels right.** Still **half** the spec's density, on the spec's own two-lane road. M1e's demand ramp is the first workload that pushes it; two cars per lane-tile needs sub-cell slots whose identity changes at every turn. **Do not add a `CARS_PER_CELL` constant "for later."**
- **Whether 1,350 ticks is the right valve.** It is the spec's 45 s at 30 Hz, unvalidated in play. At the close of M1d it fired 98 times in 20,000 ticks on a deliberately starved corridor and **never** on the shipped starting city. Task 11's long run on the new default is the first honest count.
- **Frame cost under a full jam, with numbers.** A human reported the demo board smooth throughout at 24 cars — one device, qualitative, no Android, no `performanceClass: LOW`. That retires the fear of a latent cliff at that density; it is not a budget, and the new default board's car count grows without bound as the city fills.
- **Whether the two-cell river gap is a good choke point or a cruel one.** It is the only crossing on the default board and bridges are M1f's. Task 11's device session is the first look.
- **What happens after the run ends.** There is no restart control. The player closes the app. A restart button is trivial and belongs with M3's resume path, which has to decide what a saved game-over state even means.

---

## Self-review

**1. Spec coverage.** §5.3's demand ramp → Task 6; the destination-pull rotation is unchanged. §5.3.5's blocked-spawn redistribution → Task 5. §5.8's overcrowd constants, ramp, unwind, knockback, hidden grace, no carpark immunity and immediate shutdown → Tasks 7 and 8; pin capacities were already in `constants.ts` and get their first reader in Task 7. §5.9's geometric rules → Task 5 (the road rule and the 2×3 clearance were already in `canPlaceDestination`; the neighbourhood radius and the timing constants are new); its spawn weights are declined explicitly. §5.10's week length and flat tile income → Task 2; its card table is deferred to M1f with a full argument. §5.1's board expansion → deferred to M1f with a full argument. §5.6's lights and roundabouts → deferred to M1f. §7.2's HUD → the tiles readout already exists and now has something to report; the inventory chip row waits on items. §11's testing spine — determinism, goldens, property tests — is in Global Constraints and in every task.

**Gap found and closed while reviewing:** §5.9's *"destinations never spawn within 1 tile of another destination"* is the Chebyshev ≥ 2 rule `canPlaceDestination` already enforces, and Task 4's rewrite is the only thing that touches it — which is why Task 4 carries an exhaustive equivalence proof rather than trusting the existing tests, written as they were against the other algorithm.

**Second gap found and closed:** the spawner needed a rule preventing a destination in a colour with no houses, and the first draft of Decision 6 did not have one — colours 2, 3 and 4 of `firstCity` would have deadlocked silently, and under Task 7 a destination nobody can serve is a guaranteed loss the player could not prevent. The founding exemption and the house filter are both in Task 5, both tested, and both mutated separately.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N", no "write tests for the above". Every code step carries real code. Three deliberate blanks remain and each is a value that can only be produced by running the code: the seven re-blessed digests, the new demand-pin golden, and the hand-computed `houseSpawnTimer` figure in Task 5 Step 11 — each marked at its site with the derivation that produces it, and Task 5's is explicitly required to be re-derived rather than copied from the run.

**3. Type consistency.** `runWeekBoundary`, `runSpawn`, `runOvercrowd` all take `(state)` or `(state, world)` and return `void`, matching `runDemand`/`runMovement`/`runArrivals`. `isGameOver`/`failedDestination` are defined in Task 1 and used in Tasks 8 and 9 under those exact names. `spawnZoneCells(world)`, `spawnZoneCellAt(zoneIndex, world)` and `inSpawnZone(cell, world)` all take `WorldData` — an earlier draft had two of them taking `w: number` and the third taking `world`, which is exactly the `clearLayers`/`clearFullLayers` bug this check exists for. `footprintWidth`/`footprintHeight` are exported in Task 4 and consumed in Task 5. `OVERCROWD_FULL_MILLITICKS` is used in Task 7 (the constant), Task 9 (the fold) and nowhere else; `OVERCROWD_FAIL_MILLITICKS` decides failure and is never drawn. `pinPeriodForWeek` is defined and consumed only in Task 6. `FrameDriverDeps.onGameOver` is declared required in Task 8 and passed in `main.ts` in the same task.

