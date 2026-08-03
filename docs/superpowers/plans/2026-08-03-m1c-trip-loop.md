# M1c — The Trip Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A city that plays itself. Buildings spawn, destinations request cars, houses dispatch them, cars drive the flow field, trips complete, the score goes up — all deterministic, all replayable.

**Architecture:** Buildings and cars are struct-of-arrays regions inside the state buffer. Demand is destination-pull on a per-colour round-robin. Dispatch reads the flow field the previous milestone built. Cars advance by integer sub-cell steps along `dir`. Nothing allocates per tick.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces. Zero runtime dependencies.

## Prerequisite

M1a and M1b are complete and reviewed: integer rule constants, a seeded RNG, a single-`ArrayBuffer` state container on a declarative layout, an exact clock, a pure `step()`, three determinism enforcement mechanisms, the map format with immutable terrain, a frozen buffer layout, road placement with per-cell budgeting and tree clearing, a traversable graph, and per-colour flow fields with content-derived staleness. **345 tests. Goldens: state `1073292924`, road-network `3183850973`, field `252514232`.**

Read `docs/superpowers/m1c-carry-forward.md` before starting. It records what M1b's reviews established, and Task 1 exists to act on it.

## Scope

**In:** houses, destinations, pin demand, dispatch, car movement, trip completion, score.

**Out, deliberately:**

| Deferred to | What |
|---|---|
| **M1d** | The chunk-blocking primitive — queueing, give-way, carpark queues, emergent gridlock. Cars pass through each other in M1c |
| **M1e** | Week cycle, upgrade cards, the authored spawn schedule, overcrowd failure, game over |

Blocking is its own milestone rather than a task here because it is where the game's difficulty actually lives and because it is the one part with no obvious deterministic formulation — a car's ability to advance depends on every other car's position within the tick, which makes iteration order load-bearing in a way nothing so far has been. Burying that as task seven of a seven-task plan would give it the least attention and the most dependencies.

**What "done" looks like:** a headless run over a hand-built road network where a house serves a destination repeatedly, the score increments once per completed round trip, and the whole run replays byte-identically from a mid-run snapshot.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md`. Read §5.2 buildings, §5.3 demand and dispatch, §5.5 movement, §5.9 spawning.
- Zero runtime dependencies. Integer-only in `sim`; no module-scope mutable state; module-scope literal data must be `Object.freeze(... as const)`. Three mechanisms enforce this.
- Rule constants are integers over a denominator of 1000, converted only in the constants file.
- Cell index convention is `index = y * w + x`.
- **This milestone re-blesses the goldens exactly once**, in Task 2, where the layout grows. Every later task asserts they are unchanged.
- Do not modify `spike/`.
- Do not state expected test counts. Report the real number.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## Five design decisions, and why

### 1. Demand is destination-pull, and the round-robin is state

Spec §5.3, from the original's composer: *"The destinations 'request' cars."* Most clones invert this and it changes the whole feel — house-push produces cars wandering to find work; destination-pull produces a queue that visibly backs up.

Each colour group carries its own pin timer and a **rotation cursor** naming the next destination due a pin. Both live in the state buffer, because both change and both must survive a rollback. A circle destination occupies **two consecutive slots** in the rotation, which is the mechanism behind its exact 2× rate — not a multiplier applied at request time.

**Overflow redistribution:** when the chosen destination is at its hard cap, the pin passes to the next same-colour destination in the rotation. Three lines, and it is what makes late-game collapse chain across the map rather than staying local. Implement it in M1c even though failure is M1e — the redistribution shapes demand, not just death.

### 2. Dispatch selects the house, not the destination

The naive reading is "a car picks the nearest destination". Backwards. A pin appears at a destination, and the game selects **an available car from the nearest same-colour house**, ranked by road-route cost.

This falls out of the flow field for free, and the direction matters. A field seeded from all unfilled pins of colour C gives, for every cell, the distance to the *nearest* pin of that colour. So dispatch is not "pick a pin, then search for a house" — it is: every house of colour C with a free car reads `dist[houseCell]`, the house with the smallest value dispatches, and the car follows `dir` downhill to whichever pin it reaches. One array read per house instead of a search.

**Consequence to hold onto:** the car does not know its destination when it leaves. It discovers it on arrival. That is faithful to the original's soft nearest-destination preference, and it means a pin must be **reserved at dispatch** or two cars race for it.

### 3. Car position is a cell plus an integer sub-cell offset

`cell: Int32`, `offset: Int16` in 1/256ths of the way along the current edge toward `dir`. No floats anywhere — spec §4.1 bans them and the determinism scan enforces it.

Speed is an integer in 1/256ths per tick derived from the lane-speed constants, which are themselves integers over 1000. Where the two denominators meet, the conversion happens once, in one named helper, with the rounding rule stated. Rounding is where integer sims silently diverge, so it gets its own test.

### 4. Cars pass through each other in M1c

No blocking. A car advances if its speed allows, regardless of what else is on the road.

This is a deliberate, temporary lie about the game, and it is worth stating loudly because every number this milestone produces is optimistic. Trip times are lower bounds. Throughput is an upper bound. **No balance conclusion may be drawn from M1c.** M1d makes it true.

The reason to build it this way is that dispatch, movement and trip accounting are all independently testable without blocking, and blocking is far easier to add to a working trip loop than to debug alongside one.

### 5. Buildings occupy cells; the layout is sized from the map

A house is one cell. A destination is a 2×3 footprint plus one carpark cell, per spec §5.2 — stored as its origin cell plus an orientation, not as six cell references.

Region capacities come from `MapData` (`maxHouses`, `maxDestinations`), so the buffer stays sized-from-the-map as M1b established. Cars are `2 × maxHouses` because spec §5.2 fixes two cars per house permanently, from spawn.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/sim/src/regions.ts` | *New* — the single source of truth for which regions the staleness stamp covers |
| `packages/sim/src/state.ts` | *Modified* — building, car and demand regions; header slots |
| `packages/sim/src/step.ts` | *Modified* — widened signature; the once-per-tick sync gets a production home |
| `packages/shared/src/mapFormat.ts` | *Modified* — `maxHouses`, `maxDestinations`, building spawn zones |
| `packages/sim/src/buildings.ts` | Houses and destinations: placement validity, footprint, accessors |
| `packages/sim/src/demand.ts` | Pin timers, the per-colour rotation, capacity, overflow redistribution |
| `packages/sim/src/dispatch.ts` | Pin → nearest free car, reservation |
| `packages/sim/src/cars.ts` | Position, speed conversion, advancing along `dir`, arrival |
| `packages/sim/src/trips.ts` | Pin collection, the return leg, scoring |
| `packages/sim/test/*.test.ts` | One per module, plus an end-to-end loop test |

---

## Task 1: Structural prep — act on the carry-forward before building on it

Ships no game logic. Everything after it depends on these three.

**Files:**
- Create: `packages/sim/src/regions.ts`, `packages/sim/test/regions.test.ts`
- Modify: `packages/sim/src/flowfield.ts`, `packages/sim/src/step.ts`, and their tests

### 1a. Invert the staleness stamp from opt-in to total-by-default

`hashRoadRegion` currently opts **in** to `roads` plus `header[H_MAP]`. That is the same shape as the dirty flag this design replaced: somebody must remember to extend it, and forgetting is silent and under-conservative.

Introduce an explicit partition of every region in the layout:

- `FIELD_INPUT_REGIONS` — regions whose contents can change what a flow field computes.
- `FIELD_IRRELEVANT_REGIONS` — regions that provably cannot, each with a one-line reason.

Hash the first set. Assert in a test that the union equals `regionsFor(map).map(r => r.name)` exactly, so **adding a region to the layout fails the build until somebody classifies it.** That is the whole point: the decision becomes forced rather than defaulted.

Task 2 adds four regions. If this is right, Task 2 cannot proceed without classifying them.

### 1b. Widen `step()` so the once-per-tick sync has a production home

Nothing in `packages/*/src` currently calls `placeRoad`, `syncFields` or `fieldFor` — the rollback tests wire them by hand. `step(s, inputs)` takes no `world`, no `fields`, no `scratch`.

Widen it. The exact shape is yours to choose, but state the reasoning: the constraint is that there must be exactly one place that syncs fields per tick, and it must be impossible for a caller to read a field without that sync having happened.

M1b's most consequential finding was that the rebuild loop the game actually runs had no coverage because it had no production home. This gives it one.

### 1c. Record the penalty-routing constraint where it will be read

`NB = DIAG_COST + 1 = 15` is the **exact minimum** — the instrumented maximum spread of pending distances is 14. `assertBucketCountExceedsEveryEdgeCost` only inspects `edgeCost(k)`.

M1c adds no penalties. But M1d's blocking and M1e's traffic lights both want them, and if a penalty is applied inside `computeFlowField` rather than through the cost function, the assert keeps passing while the Dial queue silently aliases two distances into one bucket — wrong paths, no crash.

Put the constraint in `flowfield.ts` as a comment addressed to whoever adds the first penalty, and add a test asserting `DISTINCT_EDGE_COSTS` matches the number of values `edgeCost` can actually return, so growing the set without re-deriving the pool bound fails loudly.

**Coverage required:** the partition is exhaustive and non-overlapping; adding an unclassified region fails; a field-input region's change invalidates and a field-irrelevant one's does not; `step` cannot be called in a way that reads an unsynced field; `DISTINCT_EDGE_COSTS` tracks `edgeCost`'s real range.

**Mutations to attempt:** move a region from input to irrelevant and confirm a staleness test fails; delete the union assertion and add an unclassified region; make `step` skip the sync.

---

## Task 2: Buildings — the regions, the layout re-bless, placement validity

**This task spends the milestone's single golden re-bless.** Every later task asserts the goldens are unchanged.

**Files:**
- Modify: `packages/shared/src/mapFormat.ts`, `packages/sim/src/state.ts`, `packages/sim/src/regions.ts`
- Create: `packages/sim/src/buildings.ts`, `packages/sim/test/buildings.test.ts`

**Regions to add**, all sized from `MapData`:

| Region | Type | Length | Holds |
|---|---|---|---|
| `houseCell` | Int32 | `maxHouses` | origin cell, or `-1` for an unused slot |
| `houseColour` | Uint8 | `maxHouses` | colour group index |
| `destCell` | Int32 | `maxDestinations` | origin cell of the 2×3 footprint |
| `destMeta` | Uint8 | `maxDestinations` | colour, kind (square/circle), orientation, packed |

Header slots: `H_HOUSE_COUNT`, `H_DEST_COUNT`.

All four are **field-irrelevant** for staleness — a building does not change what a road graph computes. Classify them explicitly in Task 1's partition and say why. (Pins *are* field-relevant, and they arrive in Task 3.)

**Placement validity**, from spec §5.2 and §5.9:
- A destination needs a clear 2×3 block plus its carpark cell, all `LAND` or cleared `TREE`
- Destinations never spawn within 1 tile of another destination
- Nothing spawns on a cell carrying road — this is the entire basis of spawn-blocking, a major skill expression, and must not be accidentally optimised away
- A house needs one free cell

**Coverage required:** a valid placement succeeds and is readable back; every rejection reason fires independently; the 2×3 footprint occupies exactly the cells it claims on a non-square grid in both orientations; a destination one tile from another is rejected; a cell carrying road is rejected; the counts track; a full building array rejects rather than overflowing.

**Mutations:** drop the road check; drop the 1-tile spacing; transpose the footprint; off-by-one the capacity bound.

---

## Task 3: Demand — pins, the rotation, capacity, overflow

**Files:**
- Create: `packages/sim/src/demand.ts`, `packages/sim/test/demand.test.ts`
- Modify: `packages/sim/src/state.ts`, `packages/sim/src/regions.ts`

**Regions:** `destPins` (Uint8, `maxDestinations`) and per-colour `pinTimer` / `rotationCursor` (Int32, `GROUP_COUNT_DEFAULT` each). **`destPins` is field-relevant** — it is the flow field's source set. Classify it that way, and confirm Task 1's union assertion forces the decision.

**Rules**, spec §5.3:
- Each colour has its own timer; on fire, the next destination in that colour's rotation receives a pin
- A circle occupies two consecutive rotation slots — the mechanism for its exact 2× rate
- First pin fires 4 s after a destination spawns
- Baseline ≈ 1.24 pins per in-game day for a square, before the weekly ramp
- **Overflow:** if the chosen destination is at its hard cap, the pin passes to the next same-colour destination. If every same-colour destination is capped, the pin is dropped and that is recorded

Capacities are `PIN_CAP_SQUARE_HARD` / `PIN_CAP_CIRCLE_HARD`, already in `@laneways/shared`. The *timer* thresholds are M1e's problem; only the hard caps matter here.

**Coverage required:** a pin lands on the rotation's current destination and advances the cursor; a circle receives two pins per full rotation where a square receives one; the cursor wraps; overflow passes to the next same-colour destination and skips other colours; all-capped drops and records; the 4 s delay holds; the rotation is stable across a snapshot/restore.

**Mutations:** drop the overflow branch; let a circle occupy one slot; advance the cursor before assigning rather than after; ignore the cap.

---

## Task 4: Dispatch — pin to nearest free car

**Files:**
- Create: `packages/sim/src/dispatch.ts`, `packages/sim/test/dispatch.test.ts`
- Modify: `packages/sim/src/state.ts`, `packages/sim/src/regions.ts`

**Regions:** `carHome` (Int32, `2 × maxHouses`), `carCell` (Int32), `carOffset` (Int16), `carPhase` (Uint8), `carTargetPin` (Int32). Cars are **field-irrelevant** — a car's position does not change the road graph.

**The mechanism**, per design decision 2. Seed the colour's field from every unfilled pin. Every house of that colour with a free car reads `dist[houseCell]`. Lowest wins; ties break on lowest house index, never on iteration order. The car enters the outbound phase; the pin is **reserved** so a second car cannot target it.

Reservation needs care: the field is seeded from *unfilled* pins, so a reserved pin must leave the source set or the next dispatch routes a second car to it. State how reservation is represented and why it cannot be lost across a rollback.

**Coverage required:** the nearest house dispatches, not the first; a house with both cars out is skipped; ties break deterministically; a reserved pin is excluded from the next field's sources; no free car anywhere is a no-op; an unreachable pin (`dist === INF`) dispatches nobody; two colours do not interfere.

**Mutations:** break the tie rule; skip the reservation; use the house's own colour field for another colour; pick the largest `dist` rather than the smallest.

---

## Task 5: Movement — advancing along the field

**Files:**
- Create: `packages/sim/src/cars.ts`, `packages/sim/test/cars.test.ts`

Cars advance by integer sub-cell steps along `dir`. **The speed conversion is the risk in this task**, not the movement: lane speeds are integers over 1000, positions are 1/256ths, and the two denominators meet in one place. Put the conversion in one named helper, state the rounding rule, and test it at the boundaries — a rounding difference is exactly the kind of thing that diverges between engines only after thousands of ticks.

A car crossing into a new cell re-reads `dir` for its current field. A car whose `dir` is `-1` — unreachable, or standing on a source — does not move. A car reaching a pin's destination transitions phase; Task 6 handles what that means.

**Coverage required:** a car advances by exactly its speed per tick; the sub-cell offset wraps into a cell transition at the right threshold; a diagonal step covers the right distance relative to an orthogonal one; a car on `dir === -1` does not move; a car re-reads `dir` after crossing; movement over N ticks is identical whether taken in one call or N; the conversion helper rounds identically at every boundary value.

**Mutations:** change the rounding direction; skip the re-read on cell entry; let a `dir === -1` car drift; use the orthogonal cost for a diagonal step.

---

## Task 6: Trips and score — closing the loop

**Files:**
- Create: `packages/sim/src/trips.ts`, `packages/sim/test/trips.test.ts`, `packages/sim/test/loop.test.ts`
- Modify: `packages/sim/src/step.ts`

A car arriving at its reserved pin's destination **removes exactly one pin**, then returns to the *same* house it left. Score credits **on return home**, not on pickup — spec §5.3, and it makes long trips genuinely more expensive, which is the intended pressure.

`step()` gains the tick order, and **the order is load-bearing**: demand, then dispatch, then movement, then arrivals. State it and test it, because a different order changes how many ticks a trip takes and every later balance measurement inherits that.

**The end-to-end test is the deliverable.** A hand-built network, one house, one destination, run until the score reaches N. Assert: the score is exactly N; each increment coincides with a car reaching home, not a pin; pins are consumed one per trip; and the whole run replays byte-identically from a snapshot taken mid-trip — with a car in flight, not between trips, because a car in flight is the state most likely to be held somewhere it shouldn't.

**Coverage required:** score credits on return, not pickup; exactly one pin per arrival; the car returns to its own house, not the nearest; a trip whose destination's pins were all consumed en route is handled and the behaviour is stated; the tick order holds; the loop test above.

**Mutations:** credit on pickup; remove two pins; return to the nearest house; reorder the tick phases.

---

## Self-Review

**Spec coverage.** §5.2 buildings and their footprints (Task 2); §5.3 destination-pull demand, the rotation, overflow, dispatch-selects-the-house, and score-on-return (Tasks 3, 4, 6); §5.5 movement and the speed model (Task 5); §5.9 spawn placement rules including spawn-blocking (Task 2). Deliberately absent, with the milestone that owns each named in Scope: blocking, carparks and congestion (M1d); the week cycle, upgrades, the authored spawn schedule, overcrowd failure and game over (M1e).

**Placeholders.** None. Tasks name required coverage rather than verbatim test code — the same choice M1b made, for the same reason: five plan-mandated defects in M1a came from blind-written tests being accepted verbatim by an implementer who could see the code. The mutation lists are what keep that honest.

**The two riskiest things in this plan.** Task 4's pin reservation interacts with the flow field's source set in a way I have specified but not proven — a reserved pin must leave the sources, and the plan says so without saying how. And Task 5's speed conversion is the single most likely place for an integer-rounding divergence in the whole project. Both are called out in their tasks; both deserve a reviewer's attention before implementation.

**One thing I expect to be wrong.** The tick order in Task 6 is stated as demand → dispatch → movement → arrivals. That is the order that seems right, but I have not derived it, and the alternative — arrivals first, so a car that arrived last tick frees its slot before dispatch runs — produces a measurably different trip cadence. A reviewer should push on it.
