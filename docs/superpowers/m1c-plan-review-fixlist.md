# M1c plan review — merged fix list

Three independent adversarial reviews of the M1c plan BEFORE execution (correctness / determinism / testability). Verdict: do not execute as written.

# Merged pre-execution fix list — M1c "The Trip Loop"

Convergence notation: **[3/3]** = all three lenses found it independently; **[2/3]** = two; unmarked = one lens.

---

## CRITICAL — resolve before Task 1 starts (each one changes the region list, and the region list must be complete before Task 2's re-bless)

### 1. Reservation is three mutually exclusive claims, and it deadlocks the deliverable **[3/3 — correctness C1-C3, determinism C1, testability C2]**
*Section: design decision 2, Task 4, Task 6.*

The plan asserts (a) the field is seeded from unfilled pins, (b) "the car does not know its destination when it leaves", (c) `carTargetPin: Int32`, and (d) "a reserved pin must leave the source set". (c) contradicts (b). (d) is fatal: with one destination holding one pin, dispatch empties the source set, `computeFlowField` unconditionally does `dist.fill(INF); dir.fill(-1)` (`flowfield.ts:108-110`, no early return for empty sources), Task 5's "`dir === -1` does not move" freezes the car at its house, and the score never reaches N. That is tick 1 of Task 6's fixture, not an edge case. It also forces a source-set mutation mid-tick, so the second house to call `fieldFor` that tick **throws** `"field is stale"` (`flowfield.ts:352-358`), which contradicts §5.4's one-rebuild-per-tick rule that Task 1b exists to enforce.

Testability proposed "a destination whose *every* pin is reserved leaves the source set" as the only cell-keyed-implementable form. It is implementable but still deadlocks — same one-pin fixture. Correctness's resolution is the right one.

**Fix:** reservation never touches the source set.
- Sources = access cells of destinations where `destPins > 0`.
- Dispatch eligibility = `destPins[d] - destReserved[d] > 0`.
- Add region `destReserved` (Uint8 × `maxDestinations`), classified **field-irrelevant** (it never enters `sources`).
- Rename `carTargetPin` → `carTargetDest`; it holds a destination index, because `destPins` is a *count* and pins are not addressable entities — `carTargetPin` has no referent under Task 3's data model.
- Dispatch resolves the destination by walking `dir` downhill from the winning house once (one walk for the winner, not per house — decision 2's "one array read per house" survives), then increments `destReserved`.
- **Delete claim (b).** The car knows its destination at dispatch.
- State the release rule for arrival-elsewhere and for a destination whose pins were consumed en route (see #2 and #16).
- Record in the plan that spec §5.3.6 ("reserved on departure; cars never compete") and §5.4 ("flow fields do not give pin reservation; each car claims the nearest unclaimed pin per tick") are contradictory, that M1c takes §5.3.6, and that §5.4's version is unimplementable as written anyway — the field gives distance to the *nearest* pin, not per-pin distances.

### 2. Cars re-path every tick, which contradicts the spec's load-bearing thesis — and the return leg has no mechanism at all **[3/3 — correctness C4/M11, determinism C6/H1, testability C3]**
*Section: Task 5 ("re-reads `dir` for its current field"), Task 6 ("returns to the same house it left").*

One decision answers both. Task 5's per-cell `dir` re-read *is* re-pathing: the field rebuilds on every pin fire, arrival and road edit, so an in-flight car re-targets continuously and can arrive at destination B holding a reservation at A — `destReserved[A]` then leaks monotonically until A is permanently ineligible, with no visible cause. Spec §3 decision 5 says "cars path once at departure, never re-route", and §1 calls the absence of auto-rerouting "deliberate and load-bearing; it is the game."

Separately, nothing in the plan routes a car to a *specific* house. Fields are per-colour and seeded from pins; following `dir` uphill reaches the farthest pin; `createFlowFields(colours, cells)` (`scratch.ts:99`) is per-colour, not per-house; and Task 6's own listed mutation ("return to the nearest house") is the only thing a house-seeded field could produce. At the moment the last pin of a colour is consumed, the field is all-`INF` and the returning car cannot move even in the wrong direction. Half the trip — the half scoring is defined on — has no algorithm, no region, no coverage bullet and no mutation.

**Fix (recommended):** store the route at dispatch. Add a per-car direction list (4 bits/step) plus a cursor and a length, retraced backwards for the return leg. This simultaneously: honours spec decision 5; gives the return leg a mechanism; and supplies the `carDir` that determinism H1 shows is needed anyway (a car at `offset=140` has committed to an edge that a rebuilt `dir[cell]` may no longer name — it snaps sideways mid-edge or freezes forever).
- Add `MAX_PATH_LEN` and a **defined refusal** when a route exceeds it.
- At 2×`maxHouses` cars this is the largest region in the buffer — re-take §9.3's 3,809 B snapshot measurement.
- If you instead keep re-pathing, say so in the same voice as decision 4's "deliberate, temporary lie", name the spec contradiction, name the milestone that fixes it, and pick one of the other two return-leg options (per-house fields outside the snapshot; or drop same-house, which contradicts the plan's own mutation list and dossier §1.5.5).
- Determinism's specific warning applies to any choice: the cheapest thing an implementer reaches for is a JS array cached outside the state buffer. It survives no snapshot, and Task 6's mid-flight snapshot test is exactly the test that catches it.

### 3. "Exactly one golden re-bless, in Task 2" is false — Tasks 3 and 4 both move the goldens **[3/3 — correctness C10, determinism C5, testability C1]**
*Section: Global Constraints, Tasks 3 and 4.*

`hashState` is FNV over the whole buffer (`state.ts:206-208`) and `stateBytesFor` derives from the region list. Task 3 adds three regions, Task 4 adds five; both list `state.ts` under Modify. Appending zero bytes still moves an FNV digest. So `1073292924` (`determinism.test.ts:472`) and `3183850973` (`rollback.test.ts:622`) move three times, not once. An implementer told "every later task asserts they are unchanged" arrives at Task 3 with a red golden and a written rule saying it must be green — that is the pressure that produces a quiet re-bless, which is how a determinism golden loses its teeth.

**Fix:** declare the **entire** M1c region list in Task 2, zero-initialised — buildings, demand, cars, `destReserved`, `destSpawnTick`, route storage (#2), dropped-pin slot (#17) — and have Tasks 3-6 write only behaviour into them. This is what `state.ts`'s own module comment demands ("frozen once here… so that every later task in this milestone appends behaviour, never buffer shape"). Note the determinism golden also moves for a second reason once `step` owns demand: 13,499 ticks with `pinTimer` incrementing.

### 4. Task 1a's partition cannot classify `header` honestly, and the wrong branch is the silent one **[3/3 — correctness C9, determinism C2, testability C4]**
*Section: Task 1a.*

`hashRoadRegion` hashes `state.roads` **plus the single slot `header[H_MAP]`** (`flowfield.ts:207`), and `flowfield.ts:193-206` spends a paragraph establishing that the H_MAP fold is load-bearing (it closes the 6×4-vs-4×6 collision `fieldFor`'s cell-*count* guard cannot catch). A partition over region *names* has two options and both are wrong:
- `header` → FIELD_INPUT: `H_TICK` increments every tick (`step.ts:26-27`), so every colour rebuilds every tick forever. §5.4's coalescing is dead, silently, with correct answers. Testability checked whether anything catches this: **nothing does.** `flowfield.test.ts:911` never calls `step` between its two `syncFields` calls; `rollback.test.ts` Step 2c never advances the tick; `TraceEntry` records no `ST_EXPANSIONS`. It also makes Step 2c ("accept-and-reuse across a restore") unwritable.
- `header` → FIELD_IRRELEVANT: the documented H_MAP protection is deleted (loud — `flowfield.test.ts:847` fails).

The likely implementation (hash `roads` + `destPins`, keep a special-cased `header[H_MAP]` fold) makes the partition **lie** while the union assertion passes.

**Fix:** split `header` into an immutable `mapIdentity` region (`H_MAP`, `H_MAP_W`, `H_MAP_H`, `H_TILES`) and a mutable `header` (`H_TICK`, `H_SCORE`, `H_WEEK`, counts), so every region is classifiable whole. The split changes offsets — it must land in Task 2, inside the single re-bless (see #3). Add the missing test: sync → `step()` one tick with nothing else changed → set `scratch.stats[ST_EXPANSIONS] = -1` → sync → assert `-1` survives.

### 5. The union assertion proves *classification*, not *hashing* — a classified region can be silently unhashed **[determinism C3, unique; testability C4 adjacent]**
*Section: Task 1a.*

`GameState` (`state.ts:108-114`) is a fixed interface; `viewsOver` builds a name→view `Map` and discards it (`state.ts:120-136`). So `hashFieldInputRegions` will be a hand-written sequence of `hashBytes(s.roads)`, `hashBytes(s.destPins)`, … Add `destReserved`, put it in `FIELD_INPUT_REGIONS`, forget the hash line: union test green, layout test green, field reports fresh while its inputs changed. That is the exact failure Task 1a exists to prevent, reintroduced one layer down — the carry-forward's "test aimed slightly off-target" shape, inside the mechanism written to prevent it.

**Fix:**
- Drive the hash from the layout table: walk `computeLayout(regionsFor(map)).entries`, and for each entry whose name is in `FIELD_INPUT_REGIONS`, hash `new Uint8Array(s.buffer, e.offset, e.len * e.ctor.BYTES_PER_ELEMENT)`.
- Use an **indexed loop over the `entries` array** — `determinism/no-collection-iteration` bans `for...of` over a Map/Set and over `.entries()`/`.keys()`/`.values()`.
- `regionsFor` is **module-private** (`state.ts:93`, verified: no export anywhere in `packages/`). The union assertion as written cannot compile. Export it or export `regionNames(map)`.
- Parameterise coverage over the whole list, not one example: for *every* name in `FIELD_INPUT_REGIONS`, poking one byte moves the stamp; for *every* name in `FIELD_IRRELEVANT_REGIONS`, it does not. Compare the union as **sets**, not arrays, so a harmless reorder is not a spurious failure.

### 6. Source-list assembly is unspecified and violates four existing constraints at once **[3/3 — correctness M8/M10, determinism H5/C9, testability C5/#3/#15]**
*Section: Task 3 ("`destPins` is the flow field's source set"), Task 4, Architecture line.*

`flowfield.ts:80-86` already tells the plan the answer verbatim and the plan ignores it: *"In M1c, pins sit on destinations, which are exactly the cells that may have no road yet, so M1c must seed sources from a destination's **road-adjacent access cell**, not from the building cell itself."* No task names that cell. Then:
- `computeFlowField` **throws** unless sources are strictly ascending, duplicates included (`flowfield.ts:114-121`), for a documented reason (source order silently decides `dir` at ties, so two engines agree on `dist` and differ on `dir`). Pins enumerate in destination-*slot* order, which is not cell order.
- Two same-colour destinations can resolve to the same access cell — also a throw. `flowfield.test.ts:750` exists specifically for "a duplicate source (what M1c dispatch produces from two same-colour destinations on one access cell)".
- `syncFields` takes `readonly (readonly number[])[]` (`flowfield.ts:282`), so building it per tick is ~6 JS array allocations/tick, 180/s — against the plan's own "Nothing allocates per tick" and §4.1's allocation-free `step`. Bare `.sort()` is banned by the source scan (`eslint.config.js:21-25`).
- `computeFlowField` silently skips a source with `roads[s] === 0` (`flowfield.ts:150`), so an unroaded destination is simply absent — correct, but it makes the whole source set a function of `destCell` + orientation.

**Fix, in Task 1b:** widen `syncFields`/`fieldFor`/`hashSources` to take a preallocated `Int32Array` plus a per-colour count, allocated once alongside `Scratch`. State the assembly rule: define the carpark cell as *the* access cell, and either scan cells ascending once per tick bucketing by colour, or keep destinations sorted by cell at placement. Add explicit dedupe. This is a signature change to three exported functions and their tests, and it is not currently in Task 1's scope.

### 7. The stated tick order has no slot for input application or for the field sync **[3/3 — correctness C6, determinism C8a, testability "tick order is not a test as stated"]**
*Section: Task 6.*

"demand → dispatch → movement → arrivals" is four phases. `fieldFor` throws unless `syncFields` ran against exactly the current sources; road placement from `inputs` changes `roads`, invalidating every field. Neither appears. Put the sync anywhere but between demand and dispatch and the symptom is a **throw**, not a wrong number.

**Fix — state this derived order, each step justified by a constraint:**
1. `H_TICK`/`H_WEEK` advance (state it explicitly: pin timers compare against tick, so this position shifts the 4 s delay by one tick and moves the goldens).
2. **Apply inputs** (road place/erase) — the only phase that changes `roads`.
3. **Demand** — timers, pins, overflow.
4. **Assemble sources + exactly one `syncFields`** — every source-mutating phase is now behind it.
5. **Dispatch** — reads `fieldFor`; must not mutate the source set (#1).
6. **Movement** — holds the field reference obtained at 4.
7. **Arrivals** — consume pin, credit score, free car.

Add the invariant that is the only "wrong rather than different" ordering constraint in the milestone and which the plan never states: **no phase between the sync and a field read may mutate the source set.** Add the residual, stated: arrivals mutate `destPins` after the sync, so any field read between the end of a tick and the next sync throws — a renderer or debug hash must not call `fieldFor` there.

Also add the anti-double-act invariant, which is *not* reachable by phase ordering but is reachable by writing `carPhase` in place inside a loop that later re-tests it: at most one phase transition per car per tick; every phase iterates cars in ascending index over a snapshot of the phase byte.

### 8. Task 5 has no base speed to convert *from*, and a uniform per-edge offset makes diagonals 40 % cheaper than the pathfinder prices them **[3/3 — correctness C7/C8, determinism M1/M5, testability C6]**
*Section: design decision 3, Task 5.*

`LANE_SPEED_DEFAULT = 1000` (`constants.ts:31`) is `1.0 × DENOM` — a **dimensionless multiplier**, not a speed. Nothing in `constants.ts` states cells per second or sub-cells per tick. "Speed is an integer in 1/256ths per tick derived from the lane-speed constants" is not derivable: a multiplier times nothing is nothing. And `constants.ts` is not listed as modified by any task.

Separately, decision 3 defines `offset` as 1/256ths *of the current edge* — normalised per edge, not per unit distance. Traversal-time ratio diagonal:orthogonal = 1.00; `edgeCost` ratio = 14/10 = 1.40 (`graph.ts:94-100`). Cars take routes the field calls optimal that are in fact slower. The plan's coverage line ("a diagonal step covers the right distance relative to an orthogonal one") is too vague to catch it and its mutation tests the wrong direction. Scaling by 10/14 introduces a second integer division with its own rounding *and its own carry*, and a remainder carried in per-edge 1/256ths silently converts a diagonal remainder into an orthogonal one.

**Fix — eliminate the mismatch rather than round it away:**
- Add a base-speed constant to `packages/shared/src/constants.ts`, and list that file in the File Structure table (it is also missing for the pin period and the 4 s delay). The auto-derived `ALL` registry test (`constants.test.ts:20`) picks up new exports and requires a non-negative integer, so additions are cheap.
- Track progress in the **pathfinder's own cost units**: per-car `progress: Int32`, accumulate `speed` per tick, transition when `progress >= edgeCost(dir) × K`, carry `progress -= edgeCost(dir) × K`. Traversal time is then proportional to the Dijkstra weight *by construction*, for every current and future edge cost including M1d's motorway ÷3, with no per-edge rounding rule at all.
- Choose `K` so the smallest multiplier (`SHARP_TURN_SPEED_MUL = 333`) yields ≥100 units, putting multiplier rounding under 1 %. State the rule as truncating integer division with a clamp to ≥1.
- Naive alternatives fail: matching diagonals exactly needs `B ≡ 0 (mod 7)`; applying multipliers exactly needs `B ≡ 0 (mod 1000)`. At a plausible `B ≈ 8-10` sub-cells/tick, `B × 333/1000` is 2.66-3.00 — floor-vs-round is a 10-33 % speed error, and `B < 4` floors to **0**, a permanently stalled car.
- State that M1c applies **no** lane-speed multipliers: `edgeCost` is pure length with no lane-speed term, so §3 decision 7's "time-weighted cost `length / laneSpeed`" is not implemented. If Task 5 applies turn/intersection multipliers to movement while the field cannot see them, the models diverge by design. Cross-reference Task 1c: when multipliers arrive, `NB` and `DISTINCT_EDGE_COSTS` must be re-derived.

### 9. Nothing creates cars, and a zero-filled car array reads as live cars **[correctness C12/C13, unique]**
*Section: Task 2, Task 4.*

Spec §5.2 and the plan both say two cars per house from spawn. Task 2 places houses but the car regions do not exist until Task 4; Task 4's coverage never mentions car creation; no task owns "placing a house creates two idle cars at its cell." **Task 6's end-to-end test has no cars.** Separately, `carCell` defaults to 0 (= cell 0) and `carPhase` to 0, so unless phase 0 is *defined* as empty, `CARS_PER_HOUSE × maxHouses` phantom cars sit at cell 0 in every fresh state — `houseCell` gets a `-1` sentinel, the car regions get none.

**Fix:** fold car initialisation into Task 2's house placement (which #3 already makes possible). Define `PHASE_NONE = 0`, `PHASE_IDLE = 1`. Test that a fresh state has zero live cars.

### 10. `mapIdHash` does not fold the new `MapData` fields, and a compensating pair silently corrupts a "verified" replay **[3/3 — correctness M13, determinism C7, testability]**
*Section: Task 2.*

Task 2 adds `maxHouses`/`maxDestinations` to `MapData` (verified absent today — `mapFormat.ts` has only `id`, `w`, `h`, `terrain`, `startingTiles`) and sizes nine regions from them. `mapIdHash` (`world.ts:70-93`) hashes id-length, id chars, `w`, `h`, `startingTiles`, terrain — nothing else — and its own doc calls content-blindness "the one drift this check exists to catch". Task 2's file list names `mapFormat.ts` but **not** `world.ts`.

`restore` validates byte length, then `assertWorldMatches` checks H_MAP/H_MAP_W/H_MAP_H. With the new fields unhashed, a map re-authored between a run and its server replay — same terrain, `maxHouses` 10→4, `maxDestinations` 0→35 — produces the same `H_MAP`, the same `w`/`h`, and (35 B per house × 6 = 6 B per destination × 35) the **same total byte count**. Both guards pass; `viewsOver` reinterprets the whole buffer under a different offset table; `carCell` bytes read as `destPins`. Silent, total corruption, no throw anywhere.

**Fix:** add `maxHouses`, `maxDestinations` and the spawn zones to `mapIdHash`'s byte recipe in Task 2 (inside the single re-bless), add `packages/sim/src/world.ts` to Task 2's file list, and extend `world.test.ts`'s content-hash pin.

---

## IMPORTANT

### 11. A throw out of `step` now leaves the tick half-applied **[determinism C8b, unique]**
*Section: Task 1b, Task 6.*
Today `step` mutates only `H_TICK`/`H_WEEK` and cannot throw. After 1b it bumps the tick, runs demand (mutating `pinTimer`/`rotationCursor`/`destPins`), then syncs. `computeFlowField` throws from three places, one from the middle of the drain loop with a partly relaxed field written. The carry-forward's accepted residual ("a throw during a rebuild leaves engines able to diverge on *whether* a rebuild runs, never on *what content*… the only difference is `scratch.stats`") was sound because the state buffer was untouched. That reasoning does not survive a phased `step`.
**Fix:** state the atomicity rule — either "a throw out of `step` poisons the run; the state is not resumable", enforced by a header epoch slot set at phase entry and cleared at exit; or "phases that can throw run before any buffer mutation." Silence here is how a retried tick double-applies demand.

### 12. Dispatch's loop bound is unspecified, and intra-tick double dispatch survives every listed test **[2/3 — correctness M2, testability Task 4 table]**
*Section: Task 4.*
"Lowest wins" never says how many dispatches happen per tick — one total, one per colour, one per house, or all eligible. Read literally it is one per colour; read as "every eligible house dispatches", a single pin pulls a car from every house on the map. It is load-bearing for trip cadence and for every exact-tick assertion Task 6 needs. Worse, reservation is described only in terms of "the *next* field's sources", so moving the reservation write to after the house loop leaves the next tick perfectly correct while two houses both dispatch at one pin this tick — **survives everything in Task 4's coverage list.**
**Fix:** specify `while (unreservedPins(colour) > 0 && a free car exists) { dispatch the lowest-dist house; reserve }`, capped at the unreserved pin count — that is what makes "cars never compete" true by construction. Add the coverage: one pin, two same-colour houses each with a free car → exactly one car dispatched that tick. Add the mutation: apply reservations after the loop.

### 13. Which of a house's two cars dispatches is unpinned **[2/3 — correctness M3, determinism H3]**
*Section: Task 4.* It changes which slot the car regions receive, therefore the buffer bytes, therefore `hashState` and browser-vs-Worker byte identity. **Fix:** "the lowest free car index of the winning house", tested, with the mutation "pick the highest".

### 14. Arrival iteration order is unpinned, and it is already load-bearing in M1c **[determinism H2]**
*Section: Task 6, Scope.* Scope defers blocking partly because iteration-order coupling "has no obvious deterministic formulation" — but Task 6's own coverage admits the coupling exists: two cars arriving at one destination on one tick with one pin remaining, whichever the loop reaches first scores. The plan pins tie-breaks for *dispatch* and pins nothing for arrivals.
**Fix:** iterate arrivals in ascending car index; add the mutation "iterate descending".

### 15. Roads and buildings do not know about each other, and dispatch is unimplementable until they do **[2/3 — correctness M8, testability "roads over building cells"; determinism H5 adjacent]**
*Section: Task 2, Task 4.*
`canPlaceRoad` (`roads.ts:119`, verified) checks bounds, adjacency, terrain and budget only — nothing stops paving straight through a house or a destination footprint, and `roads.ts` is in no task's modify list. Conversely `dist[houseCell]` is `INF` unless the house cell carries a road bit, because `neighbours` (`graph.ts:46`) reads `state.roads[cell]` and a road-free cell has no edges. Task 2 forbids buildings spawning *on* road; it never says whether road may be drawn *onto* a building, and dispatch cannot work unless it can.
**Fix, all at once:** state the driveway rule — the house cell and the destination's carpark cell **are** road-graph nodes; the other six destination cells are **not** (add them to `canPlaceRoad`'s rejection set). Then pin source = carpark cell (#6), `dist[houseCell]` is meaningful, and **Task 2's classification of the building regions becomes false**: they now constrain the graph, so `houseCell`/`destCell`/`destMeta` are FIELD_INPUT. The plan's stated reason ("a building does not change what a road graph computes") holds only under the assumption that buildings don't constrain roads, which is itself the defect. If you add an occupancy grid (Uint8 × cells) because `canPlaceRoad` runs per drag-frame, it is a FIELD_INPUT region too.

### 16. The 4 s first-pin delay is incoherent with a per-colour timer and has nowhere to live **[3/3 — correctness C11, determinism H1, testability]**
*Section: Task 3.* The delay is per-destination; `pinTimer` is `Int32 × GROUP_COUNT_DEFAULT`, per-colour. Two destinations of colour C spawning at ticks 0 and 100 cannot each get their own 4 s from one timer. `destMeta` (Uint8, colour+kind+orientation) has no room. A JS `Map<destIndex, tick>` is lost on restore and diverges on replay.
**Fix:** add `destSpawnTick` (Int32 × `maxDestinations`) **in Task 2**, and restate the rule as an *eligibility gate*: a destination is excluded from the rotation until `tick - destSpawnTick >= 4 × TICKS_PER_SECOND`. That is the only formulation that reconciles the two rules the plan currently lists side by side without noticing they conflict.

### 17. "The pin is dropped and that is recorded" — recorded where **[3/3]**
*Section: Task 3.* No header slot, no region, therefore no assertion target, and a JS counter is lost on rollback. **Fix:** add `H_PINS_DROPPED` (it is also §10.3 telemetry) or delete the clause.

### 18. The pin period is the largest untested thing in the milestone, and demand does not grow as the city grows **[2/3 — correctness M6/M7, testability]**
*Section: Task 3.*
- "Baseline ≈ 1.24 pins per in-game day" appears as a rule and in **no coverage bullet**. No constant exists, and `TICKS_PER_DAY = 0` deliberately (`constants.ts:24`) so it cannot be derived by division at a call site.
- With one fixed-period timer per colour, per-destination rate = colourRate / slotCount, so **adding destinations dilutes demand**. The original's `AverageCarsPerDay = 1.55` is per building; the weekly ramp is meant to add to growth-driven pressure, not be the only source of it. As specified the city never gets busier from growing.
- The reload rule is the Task-5 carry bug in another costume: `timer -= PERIOD` carries the remainder, `timer = 0` drops it — up to a tick per pin, compounding.

**Fix:** re-express against `TICKS_PER_WEEK = 4500`: 1.24 × 7 = 8.68 pins/week ⇒ 518.4 ticks/pin. Add one integer constant `PIN_PERIOD_TICKS = 518` and a drift-free per-colour accumulator: `acc += slotCount; if (acc >= PIN_PERIOD_TICKS) { acc -= PIN_PERIOD_TICKS; fire }` — exact, no division, no drift, rolls back cleanly, and the period now scales with slot count. State the exact resulting rate (1.2413 pins/day/square), not "≈ 1.24". Add coverage: after K in-game days the pin count is exactly a hand-computed integer derived from the constant, over a window spanning ≥2 full periods.

### 19. The rotation is a virtual list with unspecified semantics, and the overflow walk is unbounded **[3/3 — correctness M14, determinism H4, testability]**
*Section: decision 1, Task 3.* Five unresolved questions, each of which changes the long-run distribution and is invisible in a one- or two-destination test:
- **Cursor domain**: destination slots or virtual rotation slots? Wrap is over `destCount` in one case, expanded slot count in the other. The test cannot be written before the representation is chosen, and the representation *is* the mechanism.
- **Insertion**: a new destination appended at slot *k* inserts into the middle of the colour's expanded rotation; every later index names a different destination. Same for an M1e square→circle upgrade. The coverage bullet says "stable across a snapshot/restore"; the load-bearing case is "stable across a destination spawn".
- **Overflow walk must be bounded** by the expanded rotation length — `while (capped) advance()` is an infinite loop precisely in the all-capped case Task 3 requires.
- **Overflow must skip to the next *distinct* destination**: with a circle in two slots, "the next same-colour destination" can be the same one.
- **Cursor after overflow**: advanced past the originally-chosen slot, or past the recipient? Add the mutation both ways. Same for a dropped pin.

**Coverage fix:** the fixture needs ≥3 same-colour destinations, the capped one **not** at index 0, the cursor **not** at 0 — otherwise "start the overflow search at index 0" survives. Assert the exact pin *sequence* over one full rotation and the cursor value after each firing; a per-rotation count cannot distinguish `[circle, circle, square]` from `[circle, square, circle]`, and consecutiveness is the burstiness of demand. That sequence assertion also kills the request-time-multiplier implementation decision 1 explicitly rejects — currently untestable as stated.

### 20. Task 6's fixture is a smoke test, not the deliverable it is billed as **[testability, unique — with the strongest single table in the three reviews]**
*Section: Task 6.* On one house / one destination, run-until-score-N catches almost nothing:

| Wrong implementation | Caught? |
|---|---|
| dispatch always picks the same house | No — one house; every Task-4 selection mutation is invisible |
| wrong speed, either direction | No — "run until" has no tick bound; only the wall clock changes |
| a car that teleports | No — it is *faster*, so it passes sooner |
| return to the nearest house | No — one house: nearest ≡ own. **The plan's own listed mutation survives the plan's own fixture** |
| sync runs before demand instead of after | No — every pin is one tick late; the score still reaches N |
| a pin never removed | Only loosely, and a live timer makes `destPins` a moving target |

**Fix:** ≥2 houses at genuinely different route costs with the nearest at the *higher* index; ≥2 same-colour destinations; a frozen or exactly-pinned pin timer; **assert the exact tick of every score increment**, hand-computed from path length and the speed constant, not read back from the implementation; assert the identity of the dispatching house and the returning house per trip. For score-on-return, avoid self-reference: assert the score is still `N-1` on the tick `destPins` decrements (an independently identifiable, strictly earlier tick) and becomes `N` later.

### 21. Every field read must go through `fieldFor`, and the fast path silently kills the guard **[3/3 — correctness M15, determinism M3, testability "the mutation the mutation list omits"]**
*Section: Task 1b, Task 4, carry-forward item 5.* Task 1 says it exists to act on the carry-forward and covers items 1-3, not 5. `fieldFor` is O(cells) FNV per call, and Task 1a *widens* what it hashes. Dispatch reads `dist[houseCell]` per house; movement re-reads per car per tick. At ~200 cars that is ~200 × 960-byte hashes per tick at 30 Hz. **The safe answer is the slow one and the fast answer is `fields[c].dist[cell]` directly — which passes every listed test and makes the staleness guard dead code in the exact place it exists to protect.** The plan's only listed mutation ("make step skip the sync") is the loud one.
**Fix:** state the rule in 1b — `step` calls `fieldFor` once per colour per tick and holds the reference for the tick. Enforce it: a source scan for `fields[` outside `flowfield.ts`, or zero a stamp post-sync and assert the tick throws. Add the coverage testability proposes in place of the unfalsifiable "step cannot be called in a way that reads an unsynced field": (i) after `step()` returns, `fieldFor` does not throw for any colour; (ii) `syncFields` runs exactly once per `step` (sentinel `stats[ST_EXPANSIONS] = -1`); (iii) a road drawn through `step(s, inputs)` on tick T is visible in the field read on tick T.

### 22. The carry across a cell crossing is the real rounding bug, and it is unobservable at the wrong operating point **[testability, unique]**
*Section: Task 5.* Dropping the remainder on a crossing (`offset = 0` instead of `offset -= 256`) loses up to `speed-1` sub-units per cell — a systematic slowdown of ~1 tick per cell, exactly the "diverges only after thousands of ticks" failure the task names. There is no coverage bullet and no mutation for it. **And if the chosen speed divides 256 (32, 64, 128) the carry is always zero and the mutation is unobservable at every operating point.**
**Fix:** pin a default speed that does not divide 256 and assert an exact arrival tick over ≥8 cells. Worked example: at speed 100, 256/100 = 2.56 ticks/cell, correct arrival after 8 cells is tick 21, the carry-dropping version arrives at 24. Under #8's cost-unit model the same test applies to `progress -= edgeCost × K`.

### 23. The rounding helper's only live input in M1c is the identity case **[2/3 — correctness C7 arithmetic, testability]**
*Section: Task 5.* Every non-1.0 multiplier (667, 500, 333, 2000, 3000) belongs to M1d/M1e. Under the loop test the helper is only ever called with `LANE_SPEED_DEFAULT = 1000`, where the division is exact and the rounding rule is dead code — "change the rounding direction" survives everything. And "rounds identically at every boundary value" is checked *against what*? If the expected value is recomputed by the same integer expression, that is the carry-forward's "assertion checked against the formula that produced the thing under test", i.e. the `ST_PUSHES` bound repeated.
**Fix:** a hand-written literal table of `(multiplier → expected units)` at `mul ∈ {333, 500, 667, 1000, 2000, 3000}` plus the clamp boundary, exercised as a unit test independent of the loop, and say in the plan that this is deliberate because the deferred multipliers have no other caller yet.

### 24. Task 1c would swap a tripwire for a tautology **[testability, unique — and it contradicts the other two reviewers; see adjudication]**
*Section: Task 1c.* Verified: `graph.test.ts:251` is `expect(values.size).toBe(2)` against a literal; `scratch.test.ts:62` is `expect(DISTINCT_EDGE_COSTS).toBe(2)` against a literal. The plan's proposed test ("`DISTINCT_EDGE_COSTS` matches the number of values `edgeCost` can actually return") **passes** under the mutation that matters — a third cost tier added *and* the constant bumped to 3, with `entryPoolCapacity`'s two-pushes-per-cell proof untouched — where today's literals fail. Also, 1c's other deliverable ("put the constraint in `flowfield.ts` as a comment") ships nothing falsifiable; the module comment at `flowfield.ts:45-59` already says it at length.
**Fix:** keep both literals, add the linkage assertion the other two reviewers wanted (nothing ties them today), and add the test that breaks when the *proof* collapses rather than when the constant moves: instrument maximum pushes-per-cell over randomised graphs and assert it is `<= DISTINCT_EDGE_COSTS`. `scratch.ts:78-84` documents a 400-random-graph measurement already, so the fixture exists. Note in the comment what the test *cannot* restore: a per-cell penalty makes cost depend on more than direction, so `edgeCost(dir)` and everything derived from it goes structurally blind — the **signature** is the thing that has to change.

### 25. Task 2's placement coverage lets four real bugs through **[testability, unique]**
*Section: Task 2.*
- **Trees are not mentioned at all.** Spec §5.1: a tree "exists to block spawns". `hasTree` (`roads.ts:233`) documents itself as the function "M1c's spawn placement calls". Mutation: use `world.passable[c] === 1` instead of `!hasTree(...)` → a destination spawns on a standing tree → survives every listed bullet.
- **Building-on-building** is unconstrained: a house on a destination footprint or carpark, a house on a house, a destination overlapping a house all pass LAND-and-no-road. No rule, no test, no mutation.
- **`destMeta` pack/unpack** has no round-trip test over all combinations. Mutation: shift orientation by 3 bits instead of 4 → colour bleeds into orientation → survives if the fixture uses only colours 0 and 1. Note the map format allows 6 groups, so colour needs **3** bits, not 2 (3 colour + 1 kind + 3 orientation = 7, workable, but state the layout).
- **Carpark position** has no bullet, and it is the field's source cell (#6). Mutation "place the carpark on the opposite side" survives.
- Two spacing ambiguities: is "within 1 tile of another destination" measured from the origin cell, the 2×3, or the 2×3 plus carpark? "Both orientations" under-counts — with a separate carpark there are at least four distinct placements. Both will otherwise be tested against whatever the implementation does.
- The capacity bullet needs to assert **both** the rejection and that the count did not move: an out-of-range typed-array write is a silent no-op, so `<` → `<=` partially survives.

### 26. Task 2 layout decisions that must be settled *before* the single re-bless **[2/3 — correctness M12/m4, determinism LOW/M7]**
*Section: Task 2, decision 5.*
- `pinTimer`/`rotationCursor` sized by `GROUP_COUNT_DEFAULT` contradicts decision 5's "region capacities come from `MapData`" and dossier §4.2 (group count is per-map, 5 or 6, "do not hardcode a count"). Add `groupCount` to `MapData` in Task 2. Add one assertion tying `fields.length` to it, since `syncFields` checks `sourcesByColour.length === fields.length` against nothing else.
- `state.ts:20-23`: "Fixed-size regions precede every variable-size region." Every new region table in the plan is unordered. `pinTimer`/`rotationCursor` must be declared immediately after `header`, before `roads`. Ordering changes offsets, therefore the golden.
- "Cars are `2 × maxHouses`" hardcodes a second copy of `CARS_PER_HOUSE = 2` (`constants.ts:62`, verified, currently no consumer). This codebase rejects exactly that pattern and says why (`scratch.ts:160-162`, `graph.ts:76-80`).
- **No values are proposed for `maxHouses`/`maxDestinations` on `firstCity`.** They set the buffer size and therefore the goldens.
- `destCell` has no unused-slot marker while `houseCell` uses `-1`. Append-only works today; it bites when M1e removes a destination.

### 27. `TickInputs.actions` stays `readonly never[]` **[2/3 — correctness m1, testability]**
*Section: Task 1b.* Verified in `step.ts`. No task widens it, so `placeRoad` still has no production caller after Task 1b — the other half of carry-forward item 2 — and Task 6's loop test hand-places roads outside `step()`, leaving input-application ordering untested by the golden replay path. **Fix:** either widen it in 1b (recommended — the tick order in #7 has a phase for it) or state explicitly that "a city that plays itself" excludes player input in M1c.

### 28. Task 3 does not classify `pinTimer`/`rotationCursor`; Task 4 has no snapshot bullet **[2/3 — determinism M6, testability]**
Under 1a's union assertion Task 3 cannot compile without classifying all three regions; it classifies only `destPins`. And Task 4 asks in prose "why [reservation] cannot be lost across a rollback" but has no coverage bullet for it, where Task 3 does. **Fix:** classify all three with stated reasons; add a snapshot/restore bullet to Task 4.

Also correct the reason attached to `destPins`: `computeFlowField` never reads it — it reads the assembled `sources` array, which `syncFields` hashes separately via `hashSources` (`flowfield.ts:300`). Pin changes are already caught there. Keep the classification as defence-in-depth, but say so; as written it teaches the next reader that the region stamp is what catches pin changes, and it isn't.

### 29. Two more behaviours that must be *decided in the plan*, not by the implementer
- **"A trip whose destination's pins were all consumed en route is handled and the behaviour is stated"** — the behaviour is not stated anywhere. A coverage bullet whose expected result is "whatever the implementer decides" cannot be written before the implementation and will be written to match it. Under #1's per-destination counter this case is *guaranteed* to occur. Decide: return empty with no score, re-target, or park. **[2/3 — correctness C4, testability]**
- **A road erased under an in-flight car** becomes reachable for the first time in M1c, once 1b gives `eraseRoad` a production home. A car mid-edge on an erased segment has an offset along an edge that no longer exists. Deterministic either way; it needs a stated rule and a test. Task 5's coverage has nothing for it. **[determinism M4]**

### 30. Vacuity self-checks each randomised / multi-tick test needs **[testability, unique]**
- Task 1 — the "input region change invalidates" test must first assert the bytes actually moved.
- Task 3 rotation — pins delivered `> 0`; the cursor genuinely wrapped; no destination at cap during the measurement (otherwise rotation and overflow are conflated).
- Task 3 rate — window spans ≥2 full periods; predicted count `> 0`.
- Task 5 — the car's cell changed; ≥1 crossing occurred; offset non-zero on some intermediate tick (otherwise a teleporting implementation passes).
- Task 5 `dir` re-read — the fixture must **turn**; on a straight corridor the mutation "cache `dir` at dispatch" is invisible.
- Task 6 — score started at 0; some intermediate tick had score `< N`; the destination held ≥1 pin at some point; before the snapshot assert `carPhase === outbound`, `carOffset !== 0`, `carCell !== houseCell` and a live reservation; after, assert the abandoned timeline genuinely diverged (`rollback.test.ts` already does this with `hashRoadRegion`; mirror it with `hashState`).
- Task 2 capacity — the array is genuinely full before the rejecting call, and the count does not move on rejection.

### 31. "Movement over N ticks is identical whether taken in one call or N" asserts nothing **[2/3 — determinism M2, testability]**
*Section: Task 5.* There is no batched movement API; both arms run the same per-tick function N times. It is the carry-forward's "fixture that cannot distinguish the variables". **Fix:** if the intent is §5.10's fast-forward ("2 ticks per frame, never a larger `dt`"), say that and test the absence of a `dt=2` path. Otherwise delete the bullet.

---

## MINOR

32. **Four fidelity claims are over-tiered and four justifications are inverted** *(correctness Q4/section C, unique)*. (a) Decision 1's "not a multiplier applied at request time" is a [FAN]-tier inference stated as fact, and it *denies* the best-evidenced source — §1.3 [MOD, compile-verified] `DemandMultiplierForBuildings = 0.8` / `DemandMultiplierForUpgradedBuildings = 1.6`; "consecutive" is the plan's own addition, the dossier says only "two slots". (b) "Faithful to the original's soft nearest-destination preference" is **backwards** — dossier §1.5.6 says nearest-destination is "a tendency, not a rule — do not model it as a hard global optimum", and a multi-source field is exactly a hard global optimum. Keep the behaviour, fix the justification. (c) The [DPC] composer quote supports destination-*pull* only; nearest-house-by-route-cost is [FAN] (§1.5.1) and the paragraph structure lends DPC authority to it. (d) Score-on-return is [OURS] (§1.11, "Unknown — we choose"; some write-ups say score credits on pickup) — "which is the intended pressure" invents DPC intent. (e) The 4 s delay is [MOD] from a 2021-22 decompile ~14 balance patches behind; spec §5.3 carries the tag, the plan drops it.
33. **`H_SCORE` already exists** (`state.ts:78`, verified, "written only by tests, and is kept deliberately"). Task 6 never says it writes it — two score slots is a plausible outcome. Name it, and note its retention rationale is now discharged. *[2/3]*
34. **The Goal line says "Buildings spawn"** but Scope defers the authored spawn schedule to M1e. M1c ships *placement*, not spawning. Fix the Goal or the milestone will be judged against a spawner nobody wrote.
35. **Carry-forward orphan functions.** The carry-forward asks that `assertSymmetric`, `assertNoRoadOnImpassable`, `hasTree`, `isConnected`, `roadMask` "get a production caller in M1c rather than drifting into permanently test-only code." Only `hasTree` is implied (#25), and only if trees get a coverage bullet. The other four are unmentioned. Confirm or explicitly defer each. *[3/3, all as a residual]*
36. **`scratch.ts:26-28` says intersection penalties will exceed 14 "in M1c"**; the plan says M1c adds no penalties. One of them is stale — reconcile, since `NB = 15` is the exact minimum. Related: `scratch.ts:35` still references "Task 4" from a previous milestone's numbering.
37. **One thing the plan gets right and should keep:** `determinism/no-module-mutable-state` already flags an unfrozen module-scope array/object literal (`tools/eslint-rules/index.js`), so `regions.ts`'s partition lists are covered by an existing mechanism — no new rule needed. Also: "fails the build" overstates 1a's tripwire — it fails a *test*, which is fine, but say so.

---

## Disagreements between reviewers, adjudicated

**1. Does reservation remove the destination from the source set?** Testability C2 says the only implementable form is "a destination whose every pin is reserved leaves the source set"; correctness C2 says reservation must not touch the source set at all. **Correctness wins.** Testability's diagnosis is right (a cell-keyed set cannot exclude one of a destination's two pins, so reservation must be a per-destination count) but its conclusion still deadlocks the one-pin fixture, for the same reason the original does: the destination leaves, the field empties, the in-flight car freezes. Sources must be `destPins > 0`; reservation is only an eligibility filter on dispatch.

**2. Tick order.** Correctness M1 proves that "arrivals first" is a *cyclic rotation* of the plan's own order and produces identical trip lengths — so the plan's stated justification is false for the specific alternative it offers. Determinism M8 nonetheless recommends `arrivals → demand → sync → dispatch → movement`, arguing that arrivals consume pins and a car can be dispatched toward a pin another car removes later in the same tick. **Correctness's placement wins (arrivals last), and determinism's motivation dissolves under fix #1:** a pin that a car is about to arrive at is already reserved, so `destPins - destReserved > 0` already excludes it from dispatch. Moving arrivals before movement also costs something real that determinism did not price — correctness M1 identifies it: the car sits on the carpark cell for a tick while logically finished, which is a genuine behaviour change in M1d when that car occupies a chunk. Determinism's residual concern (C8a) is real and survives as a *stated rule*: fields are stale from the arrival phase until the next tick's sync, and nothing may read a field in that window.

**3. Task 1c's `DISTINCT_EDGE_COSTS` test.** Correctness ("worth adding") and determinism ("correct and genuinely new") vs testability ("removes a tripwire, swaps it for a tautology"). **Testability wins on the specific mutation and I verified it:** `graph.test.ts:251` and `scratch.test.ts:62` are both literal `2`s, and a third tier added *with* the constant bumped fails today and passes under the plan's proposed test. But correctness and determinism are right that nothing links the two literals. Do all three: keep the literals, add the linkage, add the instrumented pushes-per-cell bound (#24) — that last one is the only test that breaks when the *proof* collapses rather than when the constant moves.

**4. The diagonal fix.** Determinism M1 and testability propose scaling the per-tick advance by `ORTHO/DIAG = 10/14`; correctness C8 proposes accumulating progress in the pathfinder's own cost units. **Correctness wins decisively.** The 10/14 scale adds a second integer division with its own rounding *and its own carry*, and testability's own observation is the argument against it: a remainder carried in per-edge 1/256ths silently converts a diagonal remainder into an orthogonal one when the car changes edge type. Cost-unit progress has no per-edge rounding rule at all and survives M1d's motorway ÷3 unchanged.

**5. Are the car regions field-relevant?** Correctness M9 says the contradiction resolves once reservation is a counter; determinism C4 says they are field inputs *today* under the plan's representation; testability C4 says promoting them causes rebuild-every-tick. **All three describe different branches of the same defect and all are correct.** The resolution is #1: with `destReserved` a separate region, car regions are genuinely field-irrelevant, `destReserved` is field-irrelevant (it never enters `sources`), and `destPins` is field-input. Determinism's forward-looking amendment stands regardless: the one-line reason must be *dated* ("irrelevant while no edge cost depends on occupancy"), not stated as a proof — §5.6's demand-actuated lights make car positions a field input in M1e.

No other substantive conflicts. Where the three overlap they agree, which is the strongest signal in this merge: **items 1, 3, 4, 6, 8, 10, 16, 17 and 19 were each found independently by all three lenses.**

---

## The plan's three self-flagged risks

**Pin reservation** — flagged as "specified but not proven". It is worse than that: it is *self-contradictory and deadlocks the deliverable fixture on tick 1*. All three reviewers reached this independently from three different angles. **Resolved:** per-destination `destReserved` counter, sources seeded from `destPins > 0`, eligibility `destPins - destReserved > 0`, `carTargetPin` → `carTargetDest`, explicit release on arrival-elsewhere. Item #1.

**Tick order** — the plan expected this to be wrong and it is, but not for the reason it guessed. The alternative it offers (arrivals first) is a cyclic rotation and changes nothing about trip length; correctness M1 disproves the plan's own justification. What is actually wrong is that the order has **no slot for input application and no slot for `syncFields`**, and the real constraint — no source-mutating phase between the sync and a field read — is the only "wrong rather than different" ordering rule in the milestone and is nowhere stated. **Resolved:** the seven-phase order in #7.

**Speed conversion** — flagged as "the single most likely place for an integer-rounding divergence". It is not primarily a rounding problem; it is two structural problems wearing a rounding costume. (i) The conversion's input constant **does not exist** — `LANE_SPEED_DEFAULT = 1000` is a dimensionless multiplier, and no task adds a base speed or lists `constants.ts` as modified. (ii) A per-edge offset makes diagonal traversal 1.00× orthogonal while the pathfinder charges 1.40×, so cars take "optimal" routes that are slower. **Resolved:** add the base-speed constant and accumulate progress in cost units. The genuine rounding risk the plan was reaching for turns out to be the *carry across a cell crossing* (#22), which the plan has no bullet and no mutation for, and which is unobservable entirely if the chosen speed happens to divide 256.

---

## Single most valuable finding

**#1 — the reservation deadlock**, found independently by all three reviewers.

It would have cost most because of *where* the cost lands, not how loud it is. The failure is loud (a hang in Task 6's end-to-end test), but by then five tasks are built on it, and the fix changes the **region list** — `destReserved`, `carTargetDest` instead of `carTargetPin`, and the route storage that #2 attaches to the same decision. The region list must be complete before Task 2's single golden re-bless (#3), which is task two of six. So discovering this at Task 6 means re-opening the buffer layout, re-blessing goldens for a second and third time under a written rule forbidding it, and re-deriving every tick-count assertion downstream. Every other Critical item is either a local edit or catches a defect at the task that introduces it.

Runner-up, and the most valuable *silent* finding: **#5** (determinism C3) — the union assertion proves that somebody added a string to a list, not that the hash reads those bytes. It is the only finding where the mechanism this milestone builds specifically to make staleness bugs impossible is itself silently defeatable, one layer down, by a forgotten line. It would never have failed a test.

---

## Ready to execute?

**Yes, after Critical (1-10) and Important (11-31) are applied — but the six Criticals are not independent: #1 decides the region list, #2 and #9 and #16 and #17 add to it, #4 and #10 change the layout, and all of them are upstream of Task 2's single re-bless, so they must be resolved in the plan in that order before Task 1 begins.**