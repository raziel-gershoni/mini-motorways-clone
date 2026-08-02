# Mini Motorways Clone — Engineering Dossier

**Provenance warning that applies to the whole document.** Dinosaur Polo Club publishes almost no numbers. Three evidence tiers appear below and are labelled inline:

- **[DPC]** — official Dinosaur Polo Club text, patch notes, or dev interviews. Trustworthy.
- **[MOD]** — constants from `matias-kovero/BetterMotorways`, a BepInEx mod that writes into `Motorways.GameRules._constants`. The *field names and types* are compile-verified (the mod references a publicized build of the shipped `App.dll`, so every field access must exist). The *values* are hardcoded `Config.Bind` defaults the author transcribed from a decompile circa 2021–22, game v1.4–1.6. The game is now ~1.20 and has shipped balance patches since (v1.2 reworked supply/demand, Aug 2021 changed intersection maths, v1.3 buffed traffic lights). Treat values as *reported, possibly stale*.
- **[FAN]** — community wikis (Miraheze/Fandom), Steam guides, reviews. Player inference, not spec.

Anything marked **unknown — we choose** has no public answer at any tier; a proposed value follows.

---

## 1. Game rules — implementation-precise

### 1.1 Board and terrain

Axis-aligned square tile grid, orthographic top-down. **Not isometric** — DPC only built isometric in discarded concepting [DPC]. Steam's own tag list says "Top-Down".

No public grid dimension exists. The board **expands during a run**: camera auto-zooms out revealing more buildable grid, then hard-stops. Player anecdotes (two posts, one 2021 thread, no dev reply): 39×23, ">40×25", "43×35 on Mexico City" [FAN — flagged as unverified by the verifier; the near-square 43×35 ratio is hard to reconcile with the others on a widescreen display, and all three predate the Nov 2022 update that added manual zoom].

> **Unknown — we choose.** Fully-expanded playable grid. Propose **24 W × 40 H portrait** (960 cells) for a phone-first Telegram build, revealed from an initial **14 × 22** (308 cells) in steps tied to week index. Hard-stop zoom-out at a minimum tile size of **28 CSS px**. Original's landscape ~40×25 is the wrong aspect for our target.

Five terrain types, each gating exactly one traversal upgrade [FAN, corroborated by DPC update posts]:

| Terrain | Blocks | Counter | Notes |
|---|---|---|---|
| Tree | nothing | — | destroyed by any placement; used for spawn-blocking |
| Water | road | Bridge, or Motorway (flies over) | present on all maps except Mexico City |
| Mountain | road **and motorway** | Tunnel only | the asymmetry is what makes tunnels valuable |
| Rail | nothing (periodic) | — | level crossing halts cars while a train passes; added v1.11 |
| Ferry lane | nothing (periodic) | — | water analogue of rail; added v1.18 |

Ship water + mountain + trees for v1. Rail/ferry are moving-obstacle systems that arrived years later.

### 1.2 Roads

- One road segment per cell, one of **8 directions**: N, E, S, W, NE, SE, SW, NW [FAN, verbatim from WaffleMike's guide]. Renderer smooths clusters into a blob; internally every road is one of those 8 per tile.
- **Cost: 1 tile per cell, orthogonal or diagonal.** A diagonal spans √2 ≈ 1.414 cells. Confirmed structurally by the existence of challenge modifiers `Get It Straight` (diagonals cost double) and `The Long and Winding Road` (straights cost double) — both meaningless unless base cost is 1:1 [FAN].
  - Framing correction from the verifier: the *per-tile* penalty is +41% distance, but for a diagonal journey the diagonal route uses **half the tiles and less total distance** (1.41n vs 2n for the L-shaped route). Diagonals are strictly better for diagonal travel, not a trade-off.
- Bidirectional, one lane each way [FAN].
- Placeable on any land cell including disconnected stubs. Trees destroyed on placement.
- **Delete refunds tiles in full** (Classic/Endless). Refund is *delayed* while a car has committed to that segment — the tile renders as a thinner "ghost"/mothballed lane until the last committed car clears, often 1–2 min [FAN + DPC patch note referencing "mothballed lane"].
- Bridges and tunnels **consume 1 road tile per span tile** on top of the item [FAN, confirmed by modifiers `Bridge the Gap` / `Tunnel Vision` = "do not require road tiles"]. Motorways consume **zero**.

### 1.3 Buildings

Two classes, each in one of the map's colour groups.

**Houses.** Hold exactly **2 cars**, permanently, from spawn; both can be out simultaneously [FAN, multiply corroborated — Miraheze Gameplay: "Houses always contain two cars that can be sent at the same time"]. A newly connected house immediately dispatches both if pins are waiting. Houses have no other state. Houses can **never** cause a loss.

**Destinations.** Footprint ≈ **2×3 tiles** plus a carpark. Two forms:
- **Square (shop)** — base demand.
- **Circle (skyscraper)** — an in-place upgrade of a square; exactly **2× demand**, not 2× capacity [MOD: `DemandMultiplierForBuildings = 0.8`, `DemandMultiplierForUpgradedBuildings = 1.6`]. Modifiers `Skyscrapers` (all circles) and `Small Town Charm` (no circles) exist, confirming the upgrade is a run-time transition.
- **Double destinations** — two buildings of different colours sharing one carpark; cars may legally drive through the carpark.
- **Train stations / dock** — map-specific, capacity 5, demand pulses on train arrival [FAN, both wiki pages are stubs].

### 1.4 Demand (pins)

**Destination-pull, not house-push.** This is the single most important rule. Composer Rich Vreeland, describing the sim he hooked audio into: *"The destinations 'request' cars."* [DPC].

1. Each colour group has its own pin timer. On tick, the next destination of that colour in a round-robin receives a pin. Circle destinations occupy **two slots** in the rotation, which is the mechanism behind their exact 2× rate [FAN].
2. `DelayBeforeFirstPinOfDestination = 4 s` after spawn [MOD].
3. `AverageCarsPerDay = 1.55` [MOD]. Derived baseline: square ≈ 1.55 × 0.8 = **1.24 pins/in-game-day**, circle ≈ **2.48**, before the weekly ramp.
4. **Overflow redistribution.** If the chosen destination is at its hard pin cap, the pin is redirected to the next same-colour destination [FAN]. Consequence: a saturated skyscraper on one side of the map inflates demand at a healthy shop on the other. Three lines of code; it is what makes late-game collapse chain across the map. Implement it.
5. **Blocked-spawn redistribution.** When no new destination can be placed anywhere, that scheduled demand is pushed into existing destinations instead [FAN]. This is why late game ramps steeply once the map fills.

### 1.5 Cars and trips

Dispatch and routing, corrected per the verifier (the naive "car picks nearest store" framing is backwards):

1. A pin spawns. The game selects an **available car from the nearest same-colour house**, ranked by road-route cost. If nearby houses' cars are all out, it reaches further [FAN].
2. The pin is **reserved on departure**. Cars never compete for a pin.
3. The route is computed **once, at departure**. Cars **never re-path** — not for congestion, not for deleted roads. `VehicleModel.repathUrgency : PathfindUrgency` exists with `NotRequired` as the normal case, so repath is an explicit exceptional event [MOD/API]. Deleting a road under a committed car produces the ghost lane.
4. Path cost is a **weighted** shortest path, not raw tile count. Motorway tiles are discounted heavily (at least one player concluded motorway length is treated as ~0 in dispatch selection). It is shortest by **distance, not time** — junctions, lights and roundabouts carry no path cost, which is exactly why players observe "the game picks the shortest path but not the fastest" [FAN + DPC patch note Nov 2022 fixing a case where "cars weren't always taking what appeared to be the shortest path"].
5. Car enters the carpark, **removes exactly one pin**, drives back to the *same* house, becomes available.
6. Nearest-destination preference is a **tendency, not a rule** — WaffleMike's own hedge is "they will tend to prefer stores that are closer". Do not model it as a hard global optimum.

**Do not add a congestion term to path cost.** The omission is load-bearing: it makes the player the only rerouting mechanism, which is the entire game.

### 1.6 Speed and throughput

Throughput, not distance, is the designed constraint. DPC: *"capacity becomes the primary issue because cars occupy physical space… the more routes that pass through a road, the more cars use it, and the more intersections they'll pass through resulting in lower overall throughput."* [DPC]

Reported lane constants [MOD — field names compile-verified, values reported]:

| Constant | Value |
|---|---|
| `defaultLaneSpeed` | 1.0 |
| `maxSpeedOnMotorways` | 3.0 |
| `roundaboutSpeedMultiplier` | 2.0 |
| `rightAngleTurnSpeedMultiplier` | 0.6667 (2/3) |
| `intersectionSpeedMultiplier` | 0.5 (approaching an intersection) |
| `sharpTurnSpeedMultiplier` | 0.3333 (1/3, hairpin) |
| `useAverageLaneSpeedRatherThanMin` | true |
| `maxAcceleration` | 0.6 |
| `roundaboutAcceleration` | 1.0 |
| `controlledIntersectionAcceleration` | 0.6 |
| `decelerationFactorAtIntersections` | 0 (range 0–2; "0 means they slow a lot") |
| `MaximumTimeToWaitAtIntersection` | 45 s — then the car just goes (deadlock breaker) |

**Correction flagged.** The research claimed these prove path cost is time-weighted. The verifier refuted the inference: these sit among pure driving-physics params, the source contains zero references to pathfinding, and `useAverageLaneSpeedRatherThanMin` says *lane*, not *route* — it is per-lane aggregation of multiple applicable multipliers (e.g. a right-angle turn that also approaches an intersection: avg(0.667, 0.5) = 0.583 vs min 0.5). Time-weighted routing is a plausible hypothesis, **not established**.

Community frame-estimates, explicitly eyeballed [FAN, low confidence]: max speed 1.0, **driveway 0.9**, **junction 0.25**, ~5 uninterrupted tiles needed to reach max speed. Driveways are *not* junctions — this is why chaining house driveways onto one through-road beats creating junctions.

Blocking primitive: `RoadChunkModel.InboundVehicleCollidesWithTraversingVehicle(InboundVehicle)`. Roads decompose into chunks; each keeps `inboundVehicles` with a `committedTimestamp`. Disabling this one method disables all vehicle collision [MOD, compile-verified]. This single mechanism yields queueing, give-way, roundabout yielding, carpark queues and emergent gridlock with no collision physics.

### 1.7 Traffic lights

Demand-actuated with hysteresis, not fixed-cycle [MOD]:

| Constant | Value |
|---|---|
| `changeDelay` | 10 s minimum between changes |
| `overtimeChangeDelay` | 5 s when "in overtime" |
| `amberDelay` | 2 s |
| `minimumNearbyCarsBeforeSwapping` | 2 |
| `distanceToCountForNearbyCars` | 2 tiles |
| `MaximumIdleTimeAtTrafficLightBeforeMaxWeight` | 30 s |
| `IdleTimeAtTrafficLightWeightMultiplier` | 1.0 |
| `americanRedLightRules`, `greenLightsIgnoreCollisions` | booleans |

**Right-on-red is real and modelled.** DPC patch note, 24 Aug 2021: *"Cars that observe the American red light right hand turn rules no longer effect traffic light change decisions."* Never reverted.

Two corrections flagged:
- Right-on-red skips the **stop**, not the intersection **slowdown**. The same patch made three-way intersections apply the slowdown ("The fact that they did not before was a bug"), partly offset by "Increased base intersection speed slightly."
- The popular player line "cars sail straight through if going straight or taking a right on red **without losing speed**" is one Steam user's characterisation. The "going straight" half is unsupported and contradicted by the wiki ("When it is a red light, it stops cars from moving"). The 3-way-good / 4-way-weak conclusion is a plausible inference, not a sourced causal chain.

### 1.8 Roundabouts

3×3 footprint. Centre + all 8 neighbours must be free of houses, destinations, motorway endpoints, traffic lights, water, mountains. **May** be placed over existing roads, which are deleted and refunded [FAN]. Connects from the 4 orthogonal neighbours.

**Corrected behaviour** (verifier softened the original claim): circulating traffic has **no enforced right-of-way** — cars already on the ring will *sometimes* stop to admit entering cars. The failure mode is not "queueing at every entrance"; it is the **ring itself backing up** (circulating cars stop to admit entrants, can't reach exits, jam propagates outward). Players report roundabouts freezing solid and ending runs.

Strong early/mid (cleanest way to let two colours cross), weak late. **Corrected**: "never need more than ~2 per run" is one guide author's rule of thumb, **not community consensus**. The widely-repeated rule is about *load per roundabout* — keep each to ~2 colours.

Decide consciously whether to keep this inverted priority. It defines the roundabout's entire early-good/late-bad arc; "fixing" it silently rebalances the whole difficulty curve.

### 1.9 Motorways

- Consume **0 road tiles**. The "10 road tiles" attached to the motorway card is a **bundled bonus grant, not a length unit** — flagged correction; the original research inverted this. Proof: the modifier `Maybe Motorways — Motorways require road tiles` exists, which is only meaningful if they're free by default [FAN].
- Unlimited length. Endpoints snap to grid cells; the curve between is **off-grid, free-form**. Drag the mid-badge to reshape without moving endpoints.
- Passes over everything — buildings, roads, water, other motorways — **except mountains**.
- Cars run at 3× base speed and (known quirk) retain boosted speed ~10 tiles after exiting.
- **Hard cap 9** per city in Classic and Expert; unlimited in Endless [FAN, quadruply corroborated].
- Fully reversible: delete returns it to inventory once traffic clears.
- Known trap: connecting a motorway directly to a destination driveway jams the carpark; road + motorway on the same driveway is a documented permanent-jam bug.

### 1.10 Failure

Per-destination overcrowd timer. Reported constants [MOD]:

| Constant | Value |
|---|---|
| `MaxOvercrowdTime` | 90 (virtualised seconds) |
| `GracePeriodTime` | 2 s — "the chunk of time at the end… that is not displayed" |
| `OvercrowdTimerAcceleration` | 0.02 |
| `MinimumOvercrowdTimerSpeed` / `Maximum` | 0 / 1 |
| `OvercrowdTimerReturnSpeed` | 2 (unwinds 2× as fast, only once back under capacity) |
| `PercentageToReduceTimerOnCarArrival` | 10 % of current timer |
| `Min/MaxAmountToReduceTimerOnCarArrival` | 0 s / 3 s |
| `OvercrowdTimerCarArrivalDeceleration` | 0.5 |

**Derived** (mine, from the constants): timer speed s(t) = min(1, 0.02t), so with zero arrivals the ring fills in ~113 s — 50 s ramping (accumulating 25 of 90) then 65 s at full rate, minus 2 s hidden grace. This reconciles the datamined 90 with the reviewer's impression of *"about a minute"*: real runs always get partial arrivals.

There is **no carpark immunity** — the original deliberately omits it, and players complain about dying with a car metres from the bay.

**If any single destination's timer completes, the whole city shuts down immediately.** No lives, no partial failure, no win condition. Every Classic/Expert run ends this way.

Pin capacities are **disputed across every source**:

| Source | Square | Circle | Train station |
|---|---|---|---|
| Wikipedia (uncited; its own ref contains no numbers) | 7 triggers timer | 10 triggers timer | — |
| Draco18s, Steam | timer at 6, **full at 10** | — | — |
| namu.wiki (via snippets) | 6 waiting space | 8 (doubles) | 6 |
| Other fan sources | 6 waiting | 8 | 5 |

The real structure is probably **two numbers per building**: a *timer-trigger* threshold and a higher *hard cap* beyond which pins redirect. No source nails both.

> **Unknown — we choose.** Square: timer at **6**, hard cap **10**. Circle: timer at **8**, hard cap **14**. Train station: timer at **5**, hard cap **8**. Overcrowd: `MaxOvercrowdTime = 90`, ramp 0.02, return 2×, arrival knockback 10% clamped to 3 s, hidden grace 2 s. Tune the pin caps first when adjusting run length — they are the cleanest single dial.

### 1.11 Score

**Score = completed trips, one integer point per trip.** A trip is the full loop: leave house → reach same-colour destination → collect one pin → return to the *same* house [FAN, Miraheze Gameplay verbatim]. Internally `ScoreModel.Score` / `AddScore()` plus an unsurfaced `EfficiencyScore` [MOD/API].

Open at the frame level: whether the point credits on pickup or on return. Wiki says the trip is the full loop; some write-ups say the pin "gets added to your score" on pickup.

> **Unknown — we choose.** Credit on **return home**. It matches the wiki's definition and makes long trips genuinely more expensive, which is the intended pressure.

No combos, no multipliers.

### 1.12 Spawning

DPC: *"Our designers paint each map with weighted areas for the different types of house and destination… combined with a schedule of destinations to spawn throughout the game… encouraging houses to appear next to others of the same color in order to create neighborhoods, alongside providing more houses if a neighborhood is far away from a destination."* [DPC]

Internal: `CityPlanModel.scheduledBuildings[]`, each with `.time (Fix64)`, `.type (CityTileType.Supply=house | Demand=destination)`, `.groupIndex`, evaluated against `ClockModel.ExpansionTime`. `DestinationModel` exposes `contributedSupply`, `RequiredSupply`, `IsSupplySufficient`, `TotalDemand`, `IsScheduledToBeUpgraded`, `demandLevelUpTime` [MOD/API, compile-verified].

Reported constants [MOD]: `MinimumTimeBetweenDestinationSpawns = 10 s`; `DelayBetweenSameGroupHouseSpawns = 10 s`; `FailedHouseSpawnCooldown = 2 s`; `FailedDestinationRetryDelay = 20 s`; `MaxFailedBuildingSpawnsBeforeIgnoringWeights = 5`; `MaxFailedDoubleCarparkSpawnsBeforeConvertingToSingle = 10`; suburb sizing `MinimumSuburbCountScale 0.7 / exp 1.2`, `MaximumSuburbCountScale 0.4 / exp 1.4`.

Geometric rules that must be implemented literally, because they are the advanced metagame:
- Destination needs a clear ~2×3 (some sources say 3×2) block.
- Destinations will not spawn within 1 tile of another destination (modifier `High Density` removes this).
- Future houses of a neighbourhood spawn within ~2 tiles of an existing same-colour house.
- **Nothing ever spawns on an existing road tile** in Classic. This is the entire basis of **spawn-blocking** — players lay stub roads over every free 2×3 to shape the city. Expert Mode disables it.

---

## 2. Progression and upgrades

### 2.1 Weekly "Budget Increase"

Fires at the end of each in-game week (Sunday night). The screen is a paused, full-screen modal: *"Week N — Which upgrade would you like for your network?"* with exactly **2 options** and a **peek/eye button** (added v1.8) to inspect the board underneath. **No skip, no bank, no reroll, no timer.** You must pick one to dismiss it [FAN, verified against the wiki screenshot].

The complete pool — 6 card types, every one of which also grants road tiles, so a bad draw can never softlock you:

| Card | Item | Road tiles |
|---|---|---|
| Road Tiles | — | **30 or 40** (per-map constant) |
| Bridge | 1 or 2 (per-map) | 20 |
| Tunnel | 1 | 20 |
| Roundabout | 1 | 20 |
| Traffic Lights | 2 | 20 |
| Motorway | 1 | **10** |

**Corrected**: tile income is **flat**, not week-indexed. Verified three ways (Miraheze, Fandom, an independent Korean player writeup) plus a grep of all 58 Miraheze pages finding no week-indexed formula. Difficulty ramps on the **demand** side only.

Pool is filtered by map capability: tunnels only on mountain maps, bridges absent on Mexico City (only water-free map), roundabouts/lights/motorways everywhere.

### 2.2 Inventory

Persistent HUD strip. Each item type is a chip: **solid dark icon + numeric badge** when held, **grey outline, badge suppressed** at zero (verified against official Steam screenshots). Items sit unplaced indefinitely. The counter is **bidirectional**: deleting a placed item returns it once in-flight traffic clears. Experts deliberately bank a spare motorway as an emergency valve — *"try to reserve a spare motorway (similar to a 'ghost line' from Mini Metro)."*

### 2.3 Starting resources — corrected full table

**Two generalizations in the raw research were refuted**: the range is 25/30/35/40 (not 25–30), and mountain maps do **not** uniformly start with a tunnel (Mexico City starts with a roundabout, Vancouver with a motorway). Starting upgrades are also not limited to bridge/tunnel/roundabout. Source is the Miraheze fan wiki only; no independent corroboration exists.

| Map | Tiles | Starting upgrades |
|---|---|---|
| Los Angeles | 25 | 1 bridge |
| Tokyo | 25 | 2 bridges |
| Dar es Salaam | 25 | 1 roundabout |
| Moscow | 25 | 1 bridge |
| Manila | 25 | 2 bridges |
| Beijing | 30 | 1 bridge |
| London | 30 | 2 bridges |
| Munich | 30 | 2 bridges |
| Mumbai | 30 | 1 bridge |
| Dubai | 30 | 2 bridges |
| Warsaw | 30 | 2 bridges |
| Busan | 30 | 2 bridges |
| Copenhagen | 30 | 2 bridges |
| Zurich | 30 | 1 bridge + 1 tunnel |
| Rio de Janeiro | 30 | 1 bridge + 1 tunnel |
| Cairns | 30 | 1 bridge + 1 tunnel |
| Lisbon | 30 | **2 traffic lights** |
| Reykjavik | 30 | **2 traffic lights** |
| Vancouver | 30 | **1 motorway** |
| Chiang Mai | 35 | 3 bridges |
| Istanbul | 35 | 1 bridge |
| Cape Town | 35 | 1 tunnel |
| New York City | 40 | 2 bridges |
| Mexico City | 40 | **1 roundabout** (mountain map, no water) |
| Wellington | 40 | 1 tunnel |
| Hong Kong | 40 | 1 motorway + 1 bridge |

### 2.4 Item spec

| Item | Footprint | Tile cost | Cap | Placement constraints |
|---|---|---|---|---|
| Road | 1 cell | 1/cell | budget | land only; no water/mountain |
| Bridge | span | **1/span tile** | inventory | over water; cannot intersect, branch, or join another bridge; must touch land ≥1 side; houses cannot connect directly |
| Tunnel | span | **1/span tile** | inventory | mountains only; same non-intersect rules; the *only* way through a mountain |
| Roundabout | 3×3 | **0** | inventory | centre + 8 neighbours clear of buildings/motorway ends/lights/water/mountain; may overwrite road (refunded) |
| Traffic light | 0 | **0** | inventory | only on an existing road **junction**, not plain road |
| Motorway | endpoints only | **0** | **9** | over everything except mountains; free-form curve; re-orientable via mid-badge |

### 2.5 Meta-progression (trip thresholds)

Five-tier lattice, not a linear chain. Scoring the threshold on **any** map of a tier unlocks the **whole** next tier:

| Tier | Maps | Unlock requirement |
|---|---|---|
| 1 | Los Angeles, Beijing, Tokyo, Dar es Salaam, London | start |
| 2 | Moscow, Munich, Zurich, Manila, Rio de Janeiro | ≥200 trips on any tier-1 map |
| 3 | Dubai, Mexico City, Wellington, Warsaw, Chiang Mai | ≥250 on any tier-2 |
| 4 | Lisbon, Busan, Reykjavik, Vancouver, Cairns | ≥300 on any tier-3 |
| 5 | Copenhagen, Hong Kong, Cape Town, Istanbul | ≥350 on any tier-4 |
| side branch | Mumbai ← London ≥300; New York City ← Mumbai ≥400 | |

Other gates [DPC]: **City Challenges** unlock at **1000 trips** on that map (1–3 per map, 44 documented). **Expert Mode** unlocks at **600+ on a City Challenge** — DPC verbatim: *"Players must score 1000+ on a map to unlock City Challenges, then achieve 600+ on a City Challenge to unlock Expert Mode."* Achievements tier at 200/300/400 (Tourist), 1000 (Commuter), 2000 (Driver) per city, plus 50,000 lifetime.

### 2.6 Modifiers — the content engine

~62 named modifiers, each a one-line override on an existing system. This is effectively a published spec of *every* knob DPC made data-driven. Categories and examples:

- **Tiles**: `Pave Paradise` ×2 · `Less is More` ×½ · `Limitless Potential` ∞ · `All Up Front` 150 then none · `Get It Straight` diagonals ×2 cost · `The Long and Winding Road` straights ×2 cost
- **Per-item free/costly**: `Bridge the Gap` / `Tunnel Vision` / `Over Hill and Dale` (free) · `Bridge to Bankruptcy` / `Tunnel of Taxes` (×2) · `Maybe Motorways` (motorways now cost tiles)
- **Starting stock**: `Mega Motorways` all 9 · `Bounty of Bridges` 4 · `Tons of Tunnels` 4 · `Trove of Traffic Lights` 4 · `Loop-de-Loop` ×4
- **Speed**: `License to Thrill` / `Slow With the Flow` (bridges) · `Go Kart or Go Home` / `Ebb and Slow` (tunnels)
- **Choice screen**: `Buy One Get One Free` (both cards doubled) · `Can't Be Choosers` (one card) · `Mini Mysteries` (hidden) · `Just You and the Road` (tiles only) · `Only One Of Everything`
- **Destinations/spawning**: `Rush Hour` (much busier) · `Skyscrapers` (all circles) · `Small Town Charm` (no circles) · `Double Trouble` · `High Density` (no destination spacing) · `Unzoned` (anywhere) · `Wood You Kindly` (more, indestructible trees) · `Extra for Experts` (Expert rules)

Model as `{tileMultiplier, itemAwardMultiplier, startingStock, costOverride, speedLimit, choiceCount, hidden, destinationDistribution, spawnZoning}` applied to a config object at run start. Build this **before** building extra maps — 2–3 random modifiers over 5 maps generates more variety than 20 maps.

---

## 3. Simulation model — and what we must decide

### 3.1 Confirmed architecture

- **Deterministic and replayable by design.** Peter Curry (DPC co-founder): *"we built the simulation so every game can be recorded and deterministically played back in the Unity editor. When a beta tester encounters a bug… they can submit the record of their session to us from inside the game."* [DPC]
- **Fixed-point, not float.** Ships `FixedMath.dll`; every sim quantity is `FixMath.Fix64` [MOD, compile-verified].
- **Discrete Process systems with `Step(Fix64 deltaTime)`**: `VehicleMovementProcess`, `TrafficLightAlternatingProcess`, `ParkVehiclesProcess` [MOD, AOB-scan verified].
- **Model/view split with frame snapshots**: models expose `CurrentFrame` structs (`vehicle.CurrentFrame.speed`, `dest.CurrentFrame.OvercrowdingTime`).
- **Agent scale**: DPC/composer — *"hundreds of active cars can be in a Motorways city"*; per-car audio was abandoned because 100+ sources was too expensive.
- Roads decompose into `RoadChunkModel`; vehicles occupy `LaneModel`; `CarparkModel` tracks `vehiclesEntering` / `vehiclesDrivingThrough` and has `AddDestination()` for doubles.

### 3.2 What is genuinely unknown

| Question | Best evidence | **Our decision** |
|---|---|---|
| Sim tick rate / fixed timestep | `Step(Fix64 dt)` confirmed; value unknown | **30 Hz fixed** (33.33 ms), render interpolated at rAF. 60 Hz if profiling allows. Fast-forward = 2 ticks/frame, **not** a larger dt |
| `ClockModel.SecondsPerWeek` | one reviewer's "about two and a half minutes" | **150 s/week at 1×**, 7 equal days ⇒ **21.43 s/day**. Tunable constant, plausible real range 120–180 s |
| Per-week demand ramp | `DemandModel.spawnScale` / `extraDemand` / `SpawnRampMultiplier` exist; curve undocumented | **`spawnScale(w) = 1.0 + 0.11·(w−1)`**, capped at 3.0 (≈ +11%/week, doubling by week 10). Plus square→circle conversions on the authored schedule. This is the single most important tuning unknown — build a telemetry overlay for it on day one |
| Path cost function | time-weighted vs tile-count is **unproven** (verifier flagged the inference) | **Time-weighted**: cost(lane) = length / laneSpeed, with orthogonal 10, diagonal 14, motorway ÷3. It reproduces "diagonals beat stairsteps" and "driveways beat junctions" for free, which is most of the depth |
| Dispatch metric vs drive metric | guides say "number of road tiles" for selection; drive is weighted | Use the **same** weighted metric for both. Simpler, and the alternative explains no observation we can verify |
| Pin capacities | 6 vs 7 square, 8 vs 10 circle, 5 vs 6 station | See §1.10 table |
| Overcrowd duration | 90 (mod) vs "about a minute" (reviewer); derived ~113 s to death | 90 with the ramp, as derived |
| Road chunk capacity / car following gap | a mod flags >4 cars/lane as congestion; real constant unknown | **1 car per 0.5 tile of lane**, min gap 0.35 tile, i.e. ~2 cars/tile |
| Parking bay assignment | players observe cars driving past empty bays; "assigned at trip request" | **Reserve the bay atomically at dispatch**, round-robin over free bays. 3 bays single, up to 8 double |
| Map expansion trigger | unknown (timer? week? destination count? score?) | **Per week index**, on a per-map schedule. Deterministic and easy to author |
| `EfficiencyScore` formula | field exists, never surfaced in UI | Not needed for v1. If we build Endless, define it ourselves as trips/minute over a 60 s window |
| Driveway orientation semantics | guides say "turn the driveway toward where cars need to go" but never say how | **Implicit**: driveway faces whichever of the 8 neighbours you first connect a road to; re-orientable by connecting a different side |

### 3.3 Measured performance envelope (our own benchmarks, Node 20, M-series)

These decide the pathfinding architecture outright.

| Workload (1,505-cell grid) | Time |
|---|---|
| Multi-source BFS full flow field, 4-dir uniform, typed arrays | **1.3 µs** |
| 8-dir **weighted** Dijkstra (10/14), Dial's bucket queue, flat typed arrays, 1 source | **21.5 µs** |
| Same, 4 sources | **31.5 µs** |
| Single **A\*** query, 8-dir Chebyshev, linear-scan open list | **21.5 µs** |
| Dial's with array-of-arrays buckets (bad) | 36.6 µs + GC pressure |
| Full headless replay: 72,000 ticks @ 60 Hz, 200 agents, 1,200 field rebuilds | **127 ms** (1.76 µs/tick, ~9,450× real time) |

**One A\* query costs the same as an entire single-source flow field for the whole map.** 200 cars each A\*-ing once per second = ~4.3 ms; rebuilding 5–6 colour flow fields = ~160–190 µs. Flow fields win by 25–30×, and the gap widens linearly with car count.

**Architecture: multi-source flow fields, one per destination colour, full rebuild on dirty.** Seed Dijkstra from all unfilled pins of a colour simultaneously; the field then encodes "route to the nearest pin of this colour", which is exactly the game's rule. Store `Int32Array dist` + `Int8Array dir` per colour. A car's per-tick pathfinding is one array read: `dir[cell]`.

**Do not build D\* Lite or LPA\*.** Full recompute is 30 µs. Incremental algorithms buy nothing and cost determinism clarity.

Implementation constraints: preallocate every buffer at boot; **never allocate inside a tick**; use Dial's bucket queue (integer weights bounded at 14, so ~32 buckets suffice) backed by a preallocated `Int32Array`; coalesce dirty rebuilds to at most one per tick; model intersection/light penalties as extra integer edge weight, which Dijkstra absorbs for free.

The one thing flow fields don't give you is **pin reservation**. Iterate cars in stable integer-id order each tick and let each claim the nearest unclaimed pin by field distance.

### 3.4 Determinism rules (non-negotiable)

- **Integer-only simulation.** Positions as cell index + `Int16` sub-cell offset in 1/256ths. Speeds, costs, timers all integers. Floats confined to the render layer.
- This sidesteps the entire float-determinism problem class. IEEE-754 `+ - * / sqrt` are spec-deterministic in ECMAScript, but **transcendentals (`sin`, `cos`, `exp`, `pow`, `log`) are implementation-defined and genuinely differ across engine/OS/CPU**. Rune's production fix was wrapping 32 `Math.*` functions in `Math.fround()`; we avoid needing it by never calling one inside the sim.
- **Seeded PRNG in state.** mulberry32, 32 bits of state, seeded from an xmur3 hash. Lives inside the game state so it snapshots and rolls back for free:
  ```
  let t = (s += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  ```
  (splitmix32 is ~30–60% faster if the draw count ever matters; bryc rates sfc32 and mulberry32 as the best small-state options, and flags xoshiro128** for poor low bits.)
- **Ban `Math.random()`, `Date.now()`, `performance.now()`, and DOM access inside `step()`.** Signature is `step(state, inputsForThisTick) -> state`, pure.
- **Ban `Array.prototype.sort` in the sim** (engine-dependent for equal keys) or wrap it with a total-order integer comparator.
- Never iterate a `Map`/`Set`/object for anything sim-affecting. Iterate dense typed arrays or explicitly sorted integer-id arrays.
- **Fixed-timestep loop**: accumulate `performance.now()` deltas, clamp any single delta to 250 ms before accumulating, drain in whole steps, hard-cap ~5 substeps/frame (accept slowdown, never lockup), render with `alpha = accumulator / dt` interpolation.
- **Backgrounding is a determinism hazard.** On Telegram `deactivated`, either pause the sim or fast-forward a *bounded, recorded* number of ticks. Whichever you choose must be written into the input log so the server replay makes the same choice.

### 3.5 Anti-cheat: replay verification

Submit **inputs, not scores**: `(seed, mapId, rulesVersion, [{tick, actionType, x, y, arg}])` at 8 bytes/action ≈ 2.4 KB for 300 actions. Server replays with the identical isomorphic sim module and computes the score itself. 127 ms for a 20-minute run.

Store `rulesVersion` on every leaderboard row and keep old sim versions importable — a balance change invalidates old replays.

Caveat worth designing for now: deterministic replay proves a score is *reachable under the rules*, not that a *human* produced it. If bot-farming matters, capture input timing distributions in the log format from v1, because you cannot add them retroactively.

---

## 4. Maps, modes, session length

### 4.1 Map data format

Per-map distinctiveness requires **zero per-map code**. A map is:

```
{ terrainGrid: Uint8Array,        // land | water | mountain | tree | rail | ferry
  spawnZones: Uint8Array,         // weighted mask per building type
  startingTiles: int,             // 25 | 30 | 35 | 40
  startingItems: {bridge,tunnel,roundabout,light,motorway},
  obtainableUpgrades: bitmask,
  palette: { theme, groups[5..6] },
  expansionSchedule: [{week, revealRect}],
  buildingSchedule: [{time, type, groupIndex}] }
```

Mexico City proves the point: memorable purely because it is the only water-free map, so bridges are unobtainable and everything routes through tunnels.

### 4.2 Colour groups — corrected

**Refuted claim**: "every map uses exactly 5 colours." Enumerating all 26 Miraheze map pages: **24 maps list 5, two list 6** (Mexico City and Wellington). Confirmed against the wiki's own in-game screenshots by pixel-sampling — six distinct hues visible in each. The five-map sample that produced the original error was exactly the five starting maps, all 5-colour.

Note a **source conflict**: a separate research pass claimed Dubai, Vancouver, Hong Kong, Cape Town and Istanbul have only 4. The verifier's exhaustive enumeration contradicts this. Treat palette size as **per-map data, 5 or 6**; do not hardcode a count.

Hex values are **community eyedropper readings, not published constants**. Pixel-sampling the wiki's own screenshots disagrees with its own listed values by 1–2/255 on most LA/Tokyo entries and up to ~21/255 on some Mexico City entries. Each house renders as a light top band over a darker shadow-tinted lower band (LA yellow `#f8c86a` over `#e3856c`); the published hex is the top band only.

Confirmed palettes for the five starting maps:

| Map | Theme | Groups |
|---|---|---|
| Los Angeles | `#ffdc94` yellow | `#faca6a` `#f04c61` `#76d0e5` `#4c70a2` `#64ce86` |
| Beijing | `#719ea4` bluish-grey | `#e74b4b` `#f8c86a` `#23d5fd` `#b1b1b1` `#3daf73` |
| Tokyo | `#f8b6b5` pink | `#73d7f1` `#fc6a9c` `#f8c86a` `#dac5ca` `#6187be` |
| London | `#cddbd9` grey | `#fe4a66` `#3f81af` `#ffc255` `#63cc86` `#76cfe5` |
| Dar es Salaam | `#cae3a9` light green | `#eb4b6e` `#2f6f8e` `#ffb83b` `#74cee5` `#bf48b5` |
| Mexico City (6) | `#fc93b9` pink | `#28c7c0` `#e74594` `#fcb950` `#ae7be1` `#ee6343` `#dac9b7` |
| Wellington (6) | `#77bfb0` blue-green | `#f7b239` `#54ddfd` `#61cb85` `#6086be` `#d7c6b4` `#fe4a66` |

Colours never change mid-run. All of a map's colours are in play from early on. The audio system's harmony formula uses `MaxGroups − 1` common tones, which is independent evidence that group count is a per-map constant.

### 4.3 Modes

| Mode | Score | Game over | Motorway cap | Editing | Leaderboard |
|---|---|---|---|---|---|
| **Classic** | trip count | yes | 9 | fully reversible | yes |
| **Endless** | none (efficiency bar) | **no** | unlimited | fully reversible | no ("designed to be non-competitive") |
| **Expert** | trip count | yes | 9 | **placements lock shortly after** | separate |
| **Creative** (v1.17, Aug 2025) | none | no | unlimited | place/move/pivot/recolour/delete buildings | no |

Expert Mode, DPC verbatim: *"Shortly after being placed, road tiles and upgrades will become permanent"* and *"the full library of upgrades will be offered for the first eight weeks, but the same upgrade cannot be selected two weeks in a row and after the first eight weeks, only road tiles will be offered."* Expert also **disables spawn-blocking** — buildings can spawn on unused roads.

Endless and Creative are both enterable from the Game Over screen to continue that city.

### 4.4 Daily / Weekly challenges

| | Daily | Weekly |
|---|---|---|
| Reset | 00:00 GMT | Sunday 00:00 GMT |
| Attempts that score | **first only** | unlimited, best counts |
| Map + modifiers + seed | globally shared | globally shared |
| Locked maps playable | yes | yes |

This asymmetry is the entire retention design: daily creates a one-visit-per-day habit with no grind ceiling; weekly absorbs the grinders. Telegram makes it stronger than the original — bot push at reset, leaderboard posted into a group chat.

> **Unverified**: whether the shared seed determines only map+modifiers or the full spawn sequence. Asserted by reviews, never confirmed by DPC. For us it must be the **full sequence**, or replay validation and leaderboard comparability both collapse.

### 4.5 Session length — corrected

**Refuted**: "recommended session band cited by review aggregators is 15 minutes to 2 hours." Neither Metacritic nor Steam publishes session-length data for any game; the verifier fetched both pages. The "15 min or 2 hours" line traces to a single Medium essay, and its actual meaning is that session length is *unconstrained* — nearly the opposite of a recommended band. Also drop "reviewers repeatedly frame it as" — the "30 minute time waster" phrase is one review (Gaming Nexus), and the "10 or so minutes" quote is truncated; in full it reads *"…or play for hours trying to beat your high score."*

What survives:

| Band | Length | Source quality |
|---|---|---|
| Casual Classic run | **10–30 min** | screenwiseapp, verbatim |
| Serious 2000+ attempt | **~1 hour** upper bound; abandon a bad map in the first 10 min | Frostilyte, an achievement-hunter's blog (not a top/competitive player, correcting the raw research) |
| 1000 trips (City Challenge gate) | **~10:32** speedrun WR at 2×; **25–45 min** for a normal player | speedrun.com, verified |
| Total game | ~7 h main / ~12 h +extras / ~45 h completionist; 165 Steam achievements | HowLongToBeat |

**This is the biggest product-fit problem.** A 10–30 minute run is wrong for a Telegram tap-and-go session. Two mitigations:

1. **Aggressive autosave-and-resume on every state change.** Telegram webviews get backgrounded and killed constantly.
2. **Ship a short mode the original lacks.** Propose **"Commute": a fixed 12-week run (~15 min at 1×, ~7.5 min at 2×) with a hard end and a leaderboard.** Tighten pin caps by 1 to compress it further if needed.

Do **not** make the 1000-trip City Challenge gate the primary progression hook — at 25–45 min per attempt that is a multi-week ask from a chat-app player.

---

## 5. Aesthetic and UX spec

### 5.1 Art direction thesis

DPC's stated reference is **not road maps but souvenir cartography**: *"novelty tourist maps, with bright colours and a scale that highlights the important roads and buildings."* Exaggerate the few things that matter; drop everything else. Art Director Blake Wood single-authored all in-game assets, colour schemes and UI, which is why it reads as one system. Original artist Poppy on the cost: *"They're just as complicated, and the amount of careful design that goes into each art asset is mind-boggling sometimes."*

### 5.2 Rendering model — corrected

**Refuted**: the claim that "the game is a real 3D Unity scene lit by a directional light" with a quoted review sentence. The quote does not exist anywhere on the web; "directional light" is unsourced inference; "every object" and "soft" are unverified.

Defensible version: **flat, unshaded pastel colour fills on simple 3D geometry under a fixed near-top-down camera, with buildings and cars casting consistently-directed offset shadows that do not darken where they overlap.** Confirmed: Unity (Wikipedia infobox); genuine 3D geometry, not sprites (Vamers: *"Although the game looks two dimensional, the elements are rendered in three dimensions… complete with shadows"*); shadows consistently south-east; non-additive compositing (a Unity forum observer: *"the shadows are not changing in darkness and blend smoothly when a cars shadow is moving on 'top' of another shadow"*).

**Our implementation:**

- **Roads as a tile atlas, not a stroke path.** Per-cell 8-bit direction bitmask; pre-render each of the 256 configurations once into an offscreen canvas at DPR. DPC procedurally generated exactly such an atlas *"to ensure each tile can connect smoothly to another."* Freehand stroking will never match the joins.
- Road stroke width **55–65% of tile size**, `lineCap: 'round'`, `lineJoin: 'round'`, near-white over a tinted background. Same width for diagonals — the atlas is what makes this work.
- **Shadows as one composited layer.** Draw all shadow shapes offset ~2–4 px at a fixed angle into an offscreen canvas with opaque black, then composite the whole layer once at **10–14% alpha**. This reproduces the non-additive property exactly and costs one extra blit. Do not alpha-stack per-sprite shadows.
- Entities = flat pastel fill + one uniform drop shadow + corner radius ~15–20% of the shape's short side. No gradients, no per-face shading.
- **Redraw budget**: bake the road network into an offscreen canvas once per *edit* (a few times per minute, not per frame) and blit it as one `drawImage`. Only cars, buildings, pins and HUD redraw per frame. Drops per-frame draws from ~1,500 to ~300.

### 5.3 Palette modes

Three independent full palettes, chosen in the **tutorial**, not buried in settings. DPC's Cole: *"even small changes can make a big difference"* — the tutorial now prompts all players to pick a colour mode.

1. **Day** (map-themed) — the map's signature palette.
2. **Night** — darkened; cars switch on headlights (added 11 May 2022 "Night Lights").
3. **Colourblind** — user-configurable which colours it substitutes.

**Colourblind is the original's acknowledged weak point.** DPC: *"In Mini Motorways this has been more of a challenge… We aren't able to use shapes in as simple a form and additionally we have terrain that requires a more detailed background."* Real protanopes report yellow and light green being indistinguishable in **both** modes. A third-party mod (`ds5678/MiniNumberedHouses`) exists purely to number the houses.

**This is a free differentiator.** Ship **numerals or glyphs on houses and destinations as a first-class toggle, not a colourblind-only mode**, plus long-press-to-highlight-all-of-colour-X. On a phone-sized Telegram viewport, discriminating 5–6 similar pastels is materially harder than on desktop. Differentiate by lightness as well as hue, and run every group palette through a deuteranopia/protanopia simulator.

Palette theme object: `{background, land, water, mountain, road, roadEdge, shadow, uiText, groups[5..6]}`.

### 5.4 Typography and chrome

Helvetica across logo and interfaces, deliberately continuous with Mini Metro. Reviewers describe the UI as *"influenced by Apple Maps,"* app-like rather than game-like: *"the buttons and interface elements squish and skeuomorph in a satisfying way like it's an app."*

Use `-apple-system / Roboto / system-ui` at small sizes, tight tracking, **tabular numerals**. Read Telegram's `themeParams` for chrome so it doesn't fight the host app — but keep the **playfield on our own palette**, or the city loses its identity.

### 5.5 HUD

Exactly three persistent elements, nothing else:

1. **Week/day clock** — top, doubles as pause/speed control. Note the original's is **collapsed by default**; you tap it to reveal three buttons. That's a standing community complaint. **We should ship it always-expanded.**
2. **Score** (trip count) adjacent to the clock.
3. **Inventory chip row** at the bottom, thumb-reachable: icon + count, greyed with badge suppressed at zero. A DPC patch specifically improved *"the counter on upgrades in HUD… to show more clearly when you have 1 remaining."*

**One modal in the whole game**: the weekly upgrade choice. Two large tappable cards rising from the bottom (thumb-reachable, not a centred dialog), plus a peek button.

### 5.6 Input — the make-or-break area

The original abandoned free-draw for tile-snapping specifically because it *"was the perfect balance between precision and ease-of-use"* and because grid symmetry guarantees A→B implies B→A.

- **Draw**: one-finger drag lays segments cell by cell.
- **Delete**: an explicit **erase mode toggle** with a sweep gesture. Never a tap on a tile, never long-press. Desktop uses right-click-drag or Ctrl+click; Switch uses hold-B-and-sweep. On touch it must be modal.
- **Pan/zoom**: two-finger only, or gated behind the mode toggle. The original ships a **"Draw Mode Toggle"** option precisely because *"it is easy to accidentally delete or draw new roads when trying to move the camera around."* This is the single most important mobile UX lesson from the original.
- **Auto-zoom on draw start**: ease the camera in 1.3–1.5× around the touch point so the target cell exceeds the fingertip. Offset the drawing cursor slightly above the contact point so the finger doesn't occlude it.
- **No undo** — and that's acceptable *only* because deletion refunds in full. Never ship no-undo without the refund.
- **Ghost roads**: keep drawing a deleted-but-occupied segment as a thinner, lower-opacity line until the car clears. Tiny code, large share of why the game feels forgiving.
- **Pause is one tap, always available**, and visibly freezes everything. Players plan while paused; on mobile that substitutes for precision.

### 5.7 Audio

Fully generative, by Rich Vreeland (Disasterpeace). Core principle: *"The gameplay essentially serves as the music's conductor and, in that way, it does most of the work."* Inverted philosophy from Mini Metro: **"Success is the Absence of Sound… You don't want to hear cars honking or warnings ticking away — just the wash of many cars moving fluidly."**

Reproduce these five, in priority order:

1. **One scalar drives density**: the count of active destination requests. Ambient pads → pulsing tones as it rises. *"The more requests there are, the busier the city and the less ambient the music gets."*
2. **Per-colour-group voice**, panned by the group's average map position, volume dropping as the city grows.
3. **Quantised chunky click on road placement**, with **wobbly pitch slide while dragging** — the original does this purely to make fiddling pleasurable.
4. **Beat-quantised, slightly detuned car horns as the only congestion warning**. *"Musical but dissonant enough to communicate that something negative is happening."* Each driver has a random generosity score; never honk when stopped 8+ s, tailgating, parked, at full speed, or near destination.
5. **Night mode = global pitch-shift up by 27/16** (Pythagorean major sixth) plus a delay send. One `playbackRate` multiplier and one delay node; makes the visual toggle audible.

Harmony detail if we want it: a "Common Tone Chord Network" picking each new chord from a bucket sharing ≥ `MaxGroups − 1` common tones with the current scale, using *fewer* common tones later in a run "to reflect a sense of activity." Rhythm uses non-uniform step arrays (Rio's clave literally `[0.5, 0.75, 0.5, 1.0, 0.5, 0.75]`).

Also ship an **audio-intensity setting** separate from volume — the original's Options → Soundscape (Full / Minimal / Off).

WebAudio starts **suspended**; unlock on the first tap of the main menu. No Telegram exemption exists. Expect the iOS hardware mute switch to silence Web Audio regardless.

### 5.8 Accolades — do not overclaim

**Mini Motorways did not win an Apple Design Award.** Its real credentials: IGF 2022 Audience Award; IGF 2022 Finalist, Excellence in Audio; IGF 2022 Honorable Mention, Excellence in Design; IndieCade Choice Award 2020; NZ Game Awards 2020 Grand Prize; GDCA 2020 Honorable Mention, Best Mobile Game.

---

## 6. Telegram Mini Apps — hard constraints and required plumbing

Current platform: **Bot API 9.6** as of the 3 Apr 2026 doc revision. Client at `https://telegram.org/js/telegram-web-app.js?63`. Gate every feature at runtime with `Telegram.WebApp.isVersionAtLeast('8.0')` — **the user's client version, not your deploy, determines availability.**

### 6.1 Launch method — this decision is forced

| Method | initData | `query_id` | Verdict |
|---|---|---|---|
| Keyboard button | **none at all** | no | **Unusable** — cannot authenticate |
| Inline button | signed | **yes** | works; `answerWebAppQuery` available |
| Chat menu button | signed | **yes** | identical to inline |
| **Direct link** `t.me/<bot>/<app>` | signed + `start_param`, `chat_type`, `chat_instance` | **no** | **Ship this** |
| **Main Mini App** (8.0+) | as direct link | no | **Ship this** — opens full-height by default |
| Inline mode result | signed | yes | secondary |
| Attachment menu | signed + `receiver`/`chat` | yes | *"only available for major advertisers"* in production |

**Ship as a Main Mini App / direct link. Do not pass `mode=compact`** — Main Mini Apps open at full-screen height by default and the user cannot drag them to half-height. Opening at half then calling `expand()` causes a visible reflow and canvas resize on the first frame.

Consequence: **no `query_id`**, so `answerWebAppQuery` and `sendData` are unavailable. Plan all sharing around `savePreparedInlineMessage` + `shareMessage` and `shareToStory`.

Launch parameters arrive in the **URL hash fragment**, not the query string: `tgWebAppData`, `tgWebAppVersion`, `tgWebAppPlatform`, `tgWebAppThemeParams`, `tgWebAppStartParam`, `tgWebAppFullscreen`, `tgWebAppShowSettings`. Capture and persist them to `sessionStorage` on first load — a hash-routing app destroys them.

`tgWebAppPlatform` ∈ `android | ios | macos | tdesktop | weba | web` (sometimes `unigram`). All clients are developed separately and **do** differ.

### 6.2 Boot sequence (exact order)

```
WebApp.ready()                       // dismisses the BotFather splash — call first
WebApp.expand()                      // no-op on desktop, safe everywhere
WebApp.disableVerticalSwipes()       // 7.7+
if (isVersionAtLeast('8.0')) {
  WebApp.requestFullscreen()         // handle fullscreenFailed / UNSUPPORTED
  WebApp.lockOrientation()           // locks to CURRENT orientation
}
// only now: size the canvas
```

### 6.3 Viewport — the sizing rule

- `viewportHeight` changes continuously while the sheet is dragged. DPC-equivalent warning in Telegram's own docs: *"the refresh rate is not sufficient to smoothly follow the lower border of the window."* **Never bind canvas sizing to it.**
- **`viewportStableHeight`** is the value to size against. *"does not change as the position of the Mini App changes."*
- Re-layout only on `viewportChanged` where `isStateStable === true`, debounced.
- CSS: `height: var(--tg-viewport-stable-height, 100vh)`. **`100vh` is unreliable inside the webview.**
- On desktop/web the app opens maximized in a medium window and `expand()` has no effect.

### 6.4 Safe areas — two independent systems

Both must be honoured (8.0+):

| | Covers | CSS vars | Event |
|---|---|---|---|
| `safeAreaInset` | OS chrome: notch, home indicator, nav bar | `--tg-safe-area-inset-{top,bottom,left,right}` | `safeAreaChanged` |
| `contentSafeAreaInset` | **Telegram's own overlaid UI** — the floating close/menu buttons in fullscreen | `--tg-content-safe-area-inset-*` | `contentSafeAreaChanged` |

In fullscreen the Telegram close button floats over the **top-right corner**. No interactive game element, no score, no pause button may live there. In fullscreen the header goes transparent and overlays your content — set the header colour explicitly.

### 6.5 Swipe-to-close — corrected

**Refuted**: the claim that `disableVerticalSwipes()` is "empirically insufficient on iOS" per Telegram-iOS issue #1447. The verifier established that #1447 was filed **7 July 2024 — the same day Bot API 7.7 shipped**, when no client supported the method. The issue documents the failure of the *pre-API CSS/JS hack* (body `marginTop` + inflated height + `window.scrollTo`), and the thread points at `disableVerticalSwipes` as the *forthcoming fix* (*"a new api 7.7 could sovle this… it is said 7.7 is not supported yet"*). TapSwap's breakage was fixed within a day. `dev.to/nimaxin`, also cited, explicitly deprecates its own hack in favour of the API.

**Corrected guidance.** `disableVerticalSwipes()` is the correct, officially supported primary mechanism, not a known-broken one. The genuine reasons it may not be sufficient on its own:

1. It requires **7.7+** and is a silent no-op on older clients. Version-gate with a fallback.
2. **The Mini App header remains drag-to-dismiss by design.** Telegram's docs, verbatim: *"In any case, users will still be able to minimize and close the Mini App by swiping the Mini App's header."* No CSS suppresses this. **Reserve the top `contentSafeAreaInset` band as dead space** with no game content.
3. A non-expanded viewport is still draggable — always call `expand()`.

Defensive hardening (community practice from one blog, not established requirement): `touch-action: none` on the canvas, `touch-action: pan-y` on real scrollers, `overscroll-behavior: contain` on scroll containers. **Drop `-webkit-overflow-scrolling: touch`** — deprecated, a no-op since iOS 13. Treat `position: fixed` body and blanket `preventDefault` on `touchmove` as **legacy pre-7.7 workarounds**; they are the approach #1447 reports as broken and they break legitimate scrolling.

### 6.6 Lifecycle and persistence

Telegram adds its own signals on top of the web ones. **`isActive` + the `activated` / `deactivated` events (8.0+) are the correct pause signal**, not `visibilitychange` alone — Telegram's minimize-to-app-bar does not consistently drive the web event.

On the web side: **you cannot rely on `pagehide`, `beforeunload`, or `unload` on mobile.** `visibilitychange` is the only reliable one, and even Safari sometimes fails to dispatch it. Listen to `document.visibilitychange` **and** `window.pagehide` **and** Telegram's `deactivated`, all routed through one debounced, dirty-flagged save.

Storage tiers:

| API | Limit | Sync? | Scope |
|---|---|---|---|
| `localStorage` | MBs | **synchronous** | local, per-origin |
| **CloudStorage** (6.9+) | **1024 keys × 4096 chars** ≈ 4 MiB; key 1–128 chars, charset `A-Za-z0-9_-` only | async | **syncs across devices** |
| **DeviceStorage** (9.0+) | 5 MB | async | local only |
| **SecureStorage** (9.0+) | **10 items** | async | Keychain/Keystore |

**CloudStorage transport reality** (verified in the shipped `telegram-web-app.js`, lines 1519–1553 and 2656): every op goes `invokeCustomMethod` → `postEvent('web_app_invoke_custom_method')` → MTProto `bots.invokeWebViewCustomMethod` → Telegram servers → `custom_method_invoked`. **No local cache, no batching, no write coalescing.** Reads and deletes *can* batch (`getItems(keys)` / `removeItems(keys)` = one request for N keys); **writes cannot** — `saveStorageValue` carries one key/value, so N keys = N round trips. Design the save format as **one key**. No rate limit is documented, but treat undocumented throttling as a live risk.

**Measured save-state sizes** (our benchmark): full binary snapshot of a 43×35 road byte-grid + 60 buildings (4 B) + 250 cars (8 B) + 64 B header = **3,809 B raw → 492 B gzipped → 656 base64 chars**. Fits one CloudStorage value with 6× headroom. An input log of 300 actions at 8 B = 2,400 B → 3,200 b64 chars, fits one value but only to ~380 actions before chunking.

**Save architecture:**
- **Tier 1, crash safety**: synchronous binary write to `localStorage` every ~2 s of sim time and on `visibilitychange`. It is the **only** storage API that can complete inside a teardown handler.
- **Tier 2, cross-device**: mirror to CloudStorage on `visibilitychange` and `deactivated`.
- **Do not compress inside a teardown handler.** `CompressionStream` is stream-based and async. Either keep a pre-compressed snapshot ready on a timer, or just write the 3.8 KB raw (localStorage has megabytes).
- Save the **input log** alongside the snapshot. On resume you restore the snapshot for instant play, but the leaderboard submission needs the log from tick 0. A session resumed without its log is **unranked**.
- `enableClosingConfirmation()` during an active run — but note it does not give you an awaitable `beforeunload`, so persist continuously, not on close.

### 6.7 initData validation (mandatory, exact)

**Never trust `initDataUnsafe`.** Telegram's own warning: *"Data from this field should not be trusted. You should only use data from initData on the bot's server and only after it has been validated."*

Send the **raw** `Telegram.WebApp.initData` string verbatim to your backend, conventionally as `Authorization: tma <raw>`.

**HMAC path (you hold the bot token):**
1. Parse as query params; remove `hash`, remember its value.
2. `data_check_string` = remaining `key=value` pairs sorted **alphabetically by key**, joined by `\n` (0x0A). Values are URL-**decoded**; the `user` value stays a JSON string.
3. `secret_key = HMAC_SHA256(key="WebAppData", message=<bot_token>)` — **note the reversed argument order versus the Login Widget**: the literal string is the KEY, the token is the MESSAGE.
4. Compare `hex(HMAC_SHA256(key=secret_key, message=data_check_string))` to `hash`, **constant-time**.

**Ed25519 path (8.0+, verifier has no bot token):**
1. Remove `hash` **and** `signature`; re-pad the base64url signature with `=`.
2. `data_check_string = "<bot_id>:WebAppData\n" + sorted pairs joined by \n`.
3. Verify against production public key `e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d` (test: `40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec`).

**`auth_date` — corrected.** Telegram prescribes **no window**. Its bot-side wording is permissive (*"you **can** additionally check the auth_date field"*); only the third-party section says "should". The raw research's "24-hour maximum" is wrong: **24 h is the SDK default, not a cap** — `@telegram-apps/init-data-node` defaults `expiresIn = 86400`, and `expiresIn: 0` disables the check entirely; aiogram checks nothing at all. The official docs' own examples use **1 h**.

The raw research also asserted "validate once then issue your own JWT" as the *documented* standard. **It is not** — the cited `docs.telegram-mini-apps.com` guide is built around middleware that **re-validates raw initData on every request** with a 1 h window; the words JWT/session/cookie never appear. The JWT-exchange pattern is a real and widely used third-party convention, and it exists precisely because per-request validation with a 1 h window breaks sessions that outlive the window. initData **never refreshes mid-session** — a new `auth_date` appears only on a fresh launch, and there is no bridge method to request one.

> **Our decision**: validate once at boot with `expiresIn = 3600`, then mint our own 12-hour JWT. State it as our convention, not as Telegram guidance.

`user.id` is documented as **"up to 52 significant bits"** — store as a 64-bit integer / BigInt, never a naive JS number in a DB column.

### 6.8 Payments — Telegram Stars are mandatory

DPC-equivalent official text: *"Payments for digital goods and services must be carried out exclusively in Telegram Stars."* This exists to satisfy Google Play Payment Policies 1/2/4 and App Store Guidelines 3.1.1, 3.1.1(a), 3.1.3(b). Telegram states it **"cannot display your bot or mini-app to mobile users"** if you sell digital goods any other way.

Flow: backend `createInvoiceLink(currency='XTR', provider_token omitted, prices=[{amount: <stars>}])` → `WebApp.openInvoice(url, cb)` → native sheet → `invoiceClosed` with status `paid | cancelled | failed | pending`. Backend must answer `pre_checkout_query` **within 10 seconds**, then grant entitlement only on `successful_payment`, keyed idempotently on `telegram_payment_charge_id`. Refunds via `refundStarPayment`. Star subscriptions landed in 9.0.

### 6.9 Sharing and virality

- **`shareToStory(media_url, params)`** (7.8+) — `media_url` must be an **HTTPS URL Telegram fetches server-side**. `text` 0–200 chars (2048 Premium); `widget_link` is **Premium-only**, so put the deep link **in the image and the caption**, not the widget. Render the run summary to an offscreen canvas, upload, hand Telegram the URL. This is the highest-leverage primitive on a score screen.
- **Prepared inline messages** (8.0+) — bot calls `savePreparedInlineMessage(user_id, result, allow_*_chats)` → `{id, expiration_date}` → app calls `WebApp.shareMessage(msg_id, cb)` → native chat picker. Events `shareMessageSent` / `shareMessageFailed`. **Works from direct-link launches**, unlike `answerWebAppQuery`.
- **Referrals** — `t.me/<bot>/<app>?startapp=ref_<unpadded base64url(referrerId)>`. Constraints: **512 chars max**, regex `/^[\w-]{0,512}$/` — **strip `=` padding or the link breaks**. Telegram strips all other query params from `t.me` links, so pack multiple values into that one param with a delimiter. The `t.me/<bot>?start=` fallback is capped at **64** chars. When building a share URL, encode spaces as **`%20`, not `+`** — the SDK carries an explicit comment that plus signs work incorrectly in Telegram.
  - **Refuted**: "attribution only works against a real HTTPS production domain, not a tunnel." Telegram's only requirement is HTTPS with a **CA-trusted certificate**, which ngrok and localtunnel provide; Telegram's own docs recommend tunnels for dev. What actually fails on mobile is **self-signed certs** (`@vitejs/plugin-basic-ssl`, mkcert-on-localhost). Attribution has **no domain dependency** — it is purely `start_param` riding inside the HMAC'd initData.
  - A valid HMAC proves Telegram issued the payload unmodified for that user. It does **not** make the referral honest — the invitee chose which link to click. Enforce no-self-referral, first-write-wins one-attribution-per-user, `auth_date` freshness (initData is replayable), and rate limits separately.
- **`addToHomeScreen()`** + `checkHomeScreenStatus()` (8.0+) — offer after the player's 2nd or 3rd session. Closest thing to an install with no store review.

### 6.10 Native chrome to use instead of building your own

- **BackButton** (6.1+) for pause/menu navigation.
- **BottomButton** (7.10+, `main` | `secondary`) for the primary end-of-run action.
- **SettingsButton** (7.0+) for the options entry inside Telegram's ⋮ menu.
- **HapticFeedback** (6.1+): `impactOccurred('light'|'medium'|'heavy'|'rigid'|'soft')`, `notificationOccurred('error'|'success'|'warning')`, `selectionChanged()` — docs say use the last *only when the selection changes*, not on every tap. Genuine taptic on iOS; known gaps on some Android builds; silent no-op on desktop/web. **Guard every call.**

Our mapping: `impactOccurred('light')` on segment placement · `selectionChanged()` on grid-cell change while dragging · `notificationOccurred('warning')` when a destination overflows · `notificationOccurred('error')` on game over.

### 6.11 Webview engines and hazards

| Client | Engine |
|---|---|
| iOS / macOS | WKWebView (WebKit) |
| Android | Android System WebView (Chromium; version tracks the user's updatable WebView, **not a fixed target**) |
| Desktop Windows | WebView2 (Edge-Chromium) |
| Desktop Linux | WebKitGTK (separate flatpak extension) |
| Web A / Web K | **iframe** in the user's own browser, `window.parent.postMessage` |

Documented hazards:
- **The DOM Fullscreen API does not work inside the webview.** Use Telegram's `requestFullscreen()`.
- **iOS fails silently on asset load errors.** A reported Unity WebGL "black screen with working audio" traced to a **web font that failed to load** breaking the init pipeline. **Self-host and preload every font and atlas. Never depend on a cross-origin font CDN.**
- The iOS on-screen keyboard does not reposition content correctly (Android does).
- SSR is impractical — the Telegram API needs `window`.
- **Telegram Desktop caches Mini App bundles in `~/.local/share/TelegramDesktop/tdata/user_data/wvbots/cache`, and clearing Telegram's normal cache does not clear it** (open request tdesktop #30127). initData is also cached on desktop (#28303). **Mitigation: content-hash every asset filename and serve `index.html` with `Cache-Control: no-store, must-revalidate`.**
- **Android exposes a device-capability signal**: Telegram-Android injects OS version, app version, SDK, manufacturer/model and **`performanceClass` ∈ `LOW | AVERAGE | HIGH`** into the User-Agent, explicitly so Mini Apps can downgrade. No iOS equivalent. Telegram's own framing: apps can *"automatically adjust settings to provide the smoothest experience."*

Telegram's design guidance: mobile-first responsive, mimic native components, target 60 fps, accessibility labels, react to dynamic theme colours, respect both inset systems, and *"adjust for the device's performance class"* on Android.

### 6.12 Bot-side minimum

A Mini App **cannot exist standalone** — Telegram's platform docs call it *"an add-on for Telegram Bots"*. Required:

1. Bot via `/newbot`, app via `/newapp` → `t.me/<bot>/<app>`. Configure Main Mini App + splash screen (custom icon + colours, shown before your bundle paints) under `/mybots → Bot Settings → Configure Mini App`.
2. `POST /api/score` — validates raw initData, replays the input log, writes to the leaderboard. **Store the user id from validated initData; never trust one in the request body.**
3. `GET /api/leaderboard`.
4. If monetizing: `createInvoiceLink` + webhook handlers for `pre_checkout_query` (10 s) and `successful_payment`.

**No app store review gate** — the app goes live the moment you save the URL. Telegram does run a discoverability "Mini App Store" and enforces content/payment policy post-hoc, and can *"restrict, suspend, or remove"* non-compliant apps. (A report that all post-Nov-2025 submissions route through a review queue could not be verified against any primary source — treat as unconfirmed.)

**Skip the legacy Telegram Games platform** (`/newgame`, `sendGame`, `setGameScore`, `TelegramGameProxy`). Its only real advantage is free in-chat leaderboards. It has no initData identity model, no CloudStorage, no Stars, no fullscreen, no safe-area APIs. Telegram's own games doc points developers at Web Apps.

---

## 7. Technical stack — recommendation and reasoning

### 7.1 The stack

| Layer | Choice | Reasoning |
|---|---|---|
| Language | TypeScript | isomorphic sim module shared client/server is the whole anti-cheat design |
| Build | **Vite 8** (Rolldown + Oxc + Lightning CSS) | shipped 2026-03-12; single Rust pipeline replacing the esbuild-dev/Rollup-prod split |
| Renderer | **Hand-written Canvas2D behind a ~10-method interface** | see below |
| Loop | bespoke fixed-timestep, ~200 lines | no framework earns its bytes here |
| State | flat struct-of-arrays typed arrays | snapshots with one `ArrayBuffer` copy; zero per-tick allocation; rolls back free |
| RNG | mulberry32, 32-bit state **inside** game state | snapshot/rollback for free |
| Pathfinding | multi-source Dijkstra flow fields, Dial's bucket queue | 21–32 µs full field vs 21.5 µs per A\* query |
| Bot | grammY (26 KB gzip) | official Cloudflare Workers deployment guide, `bot.webhookCallback` |
| Hosting | Cloudflare Workers + static assets | one deploy serves bundle + API, no CORS, global edge |
| DB | Cloudflare D1 | see limits below |

### 7.2 Renderer: Canvas2D, with a Pixi escape hatch

**Measured bundle costs** (esbuild `--bundle --minify --format=esm --target=es2022`, gzip -9):

| Import | min | gzip |
|---|---|---|
| Pixi 8.19 WebGLRenderer + Container + Sprite + Texture | 350,928 B | **99,523 B** |
| Pixi 8.19 Application + Graphics + Sprite | 486,145 B | **140,532 B** |
| Pixi 8.19 `import * as PIXI` | 876,589 B | 251,784 B |
| Pixi 8.19 **CanvasRenderer** + Container + Sprite | 358,498 B | **106,867 B** |
| Phaser 4.2.1 (bundlephobia) | 1,370,217 B | 355,684 B |
| Excalibur 0.32.0 | 570,819 B | 145,295 B |
| Kontra 10.0.2 | 39,291 B | 13,680 B |
| bitECS 0.4 | 16,043 B | 5,739 B |

**Notable finding contradicting marketing**: Pixi v8's new Canvas2D renderer is **~7 KB gzip *larger*** than the WebGL-only build for a sprite-only app, because both pull the same scene-graph/texture machinery. The 8.16 release blog claims it "produces a smaller build" and publishes no numbers.

**Corrected throughput evidence.** The raw research's "1,000-sprite stress test: WebGL 60 FPS vs Canvas2D ~20 FPS" was **fabricated** — it appears nowhere in the cited source, and it contradicts that source's own "1,000–3,000 draws at 60 fps" rule of thumb. Real reproducible data (`slaylines/canvas-engines-comparison`, moving rects, MacBook Pro 2019, **8,000 boxes**):

| Renderer | Chrome / Firefox / Safari |
|---|---|
| Vanilla Canvas2D | 19 / 19 / 39 FPS |
| Scrawl-canvas (optimized Canvas2D) | 56 / 60 / 40 |
| PixiJS WebGL | 60 / 48 / 24 |
| Hand-written WebGL | 60–120 FPS at **1,000,000** boxes |

So naive Canvas2D does hit ~20 FPS — **at ~8,000 sprites, not 1,000**. Our workload is **200–400 moving sprites plus a pre-baked static road layer**, roughly an order of magnitude below the cliff. Also note the "WebGL 50,000+" figure is *instanced primitives*, typically **one** draw call — not 50,000 draw calls, which is unachievable at 60 Hz in any renderer.

**Decision: Canvas2D.** It costs 0 KB of bundle. Pixi's minimum realistic cost is ~140 KB gzip, which on a Telegram cold start over mobile data is roughly 0.5–1.5 s of extra time-to-first-frame for zero gameplay benefit at this sprite count. Structure the renderer behind a ~10-method interface (`drawSprite`, `drawLine`, `setTransform`, …) so swapping in Pixi later is a one-file change.

**Explicitly reject Phaser (356 KB gzip) and Excalibur (145 KB).** Both bring scene managers, physics, tweens, input abstractions and asset loaders we will not use. This game has no physics and one scene.

**Two caveats before relying on the Canvas2D numbers**: (a) the road layer must live on its own offscreen canvas or the sprite budget above is meaningless; (b) these are 2019-laptop numbers, and Telegram's target is mid/low-end Android WebViews at high DPR. Budget by **frame time on a real cheap device** — aim for well under 8 ms of drawing per 16.7 ms frame — not by sprite count. Read `performanceClass` on Android and drop to a 30 Hz sim tick with interpolation on `LOW`.

### 7.3 Hosting economics

**Cloudflare Workers, free plan:** 10 ms CPU/request · 100,000 req/day · 3 MB compressed bundle · 50 subrequests · 128 MB memory · static assets 20,000 files @ 25 MiB max.
**Paid ($5/mo):** 30 s CPU default (to 5 min) · unlimited requests · 10 MB bundle · 10,000 subrequests · 100,000 files.

**Hard constraint: our 127 ms replay does not fit in the free 10 ms CPU budget.** Three options:

1. **Workers Paid at $5/mo** — simplest, correct answer once there are users.
2. Free-tier Worker accepts and queues the submission; a Durable Object or Queue consumer verifies asynchronously and promotes the score. Accept an "unverified" badge for a few seconds.
3. API on a small Node/Bun host (Fly/Railway/Render), static bundle on Cloudflare.

**Recommendation: (2) while prototyping, (1) the moment the game has users.**

**Cloudflare D1, free:** 5M rows read/day · **100,000 rows written/day** · 5 GB · 500 MB/DB · 50 queries per invocation · 7-day Time Travel. A leaderboard writes once per run, so the write cap is ~100k runs/day — ample.

**Do not use Workers KV for the leaderboard: 1,000 writes/day on free is far too low.**

### 7.4 Bundle target

**Under 100 KB gzip total**, including all code and the sprite atlas. Achievable only by skipping Pixi/Phaser. Content-hash every asset; `Cache-Control: no-store` on `index.html`; configure a BotFather splash so the pre-paint gap looks intentional.

### 7.5 Vite 8 — corrected notes

- Shipped **2026-03-12** (npm publish 13:59 UTC, git tag 13:57 UTC). 8.1 on 2026-06-23; **current latest is 8.2 — target 8.2.x, not 8.0.0.**
- Speed: official wording is *"It matches esbuild's performance level and is 10–30× faster than Rollup"* — **with no module-count qualifier**. The "500+ modules / 2–5x under 100 modules" thresholds in the raw research are **fabricated**; a GitHub code search across the rolldown org for those phrases returns zero hits. Rolldown's own benchmark is 19k modules (1.61 s vs esbuild 1.70 s vs Rollup+esbuild 40.10 s). Real per-project numbers: Linear 46 s → 6 s, Ramp −57%, Mercedes-Benz.io −38%, Beehiiv −64%, dev-server start ~3× faster.
- Breaking changes: `build.rollupOptions` → `build.rolldownOptions` is a **deprecation with a working alias**, not a removal (`optimizeDeps.esbuildOptions` → `optimizeDeps.rolldownOptions` likewise). CJS interop changed (default import is now the importee's `module.exports`; `require` of externals is preserved rather than rewritten; `legacy.inconsistentCjsInterop: true` restores old behaviour). esbuild is **demoted to a deprecated optional dependency**, not removed — install it yourself if a plugin needs it. **Install size grows ~15 MB** over Vite 7 (~10 MB Lightning CSS, ~5 MB Rolldown) — relevant to CI images.
- **Yarn PnP is NOT a Vite 8 breaking change.** Refuted: it appears nowhere in the migration guide, and it is not a technical incompatibility — `oxc_resolver` ships PnP support and rolldown #9302 was closed as *completed* on 2026-05-21. What happened is a **post-8.0 support-policy deprecation** (vite PR #21906, opened 5 days after 8.0, merged 2026-06-02): *"Using Yarn PnP with Vite is discouraged and PnP-specific bugs will no longer be actively worked on."* Rationale is maintenance overhead, not Rust. If on PnP, set `nodeLinker: node-modules` — a support-risk decision, not an upgrade blocker.
- Migration: DPC-equivalent official wording — *"For larger or more complex projects, we recommend the gradual migration path: first switch from `vite` to the `rolldown-vite` package on Vite 7… then upgrade to Vite 8."* Small projects go straight to 8. Our bundle is small enough that staying on Vite 7 + esbuild costs nothing if a plugin breaks.

### 7.6 Prior art — budget almost zero reading time

- **No high-quality open-source Mini Motorways clone exists.** GitHub search returns exactly 3 repos, all 0 stars: `Aripander088e2/mini-motorways-clone` (3 commits, abandoned Jan 2023), `Laosing/mini-motorways-clone` (~25 commits, agent-written), and ours. Skip both.
- **`burntcustard/tiny-yurts`** — js13kGames 2023, 4th place; the only finished, well-crafted Mini Motorways-alike on the web. Kontra.js (modified), **SVG + CSS transitions, no canvas, no asset files**, Vite + Terser + custom max-minification plugin + Roadroller + advzip, entire game under 13,312 zipped bytes. Karplus-Strong audio via WebAudio. **Read it for architecture and the minification pipeline; deliberately ignore its pathfinding** — `find-route.js` is an object-allocating BFS with a visited array that records orthogonal/diagonal costs but never uses them to order traversal (so it does not return true shortest weighted paths) and rebuilds the whole graph on every change.
- **`matias-kovero/BetterMotorways`** — the closest thing to ground truth on the original's internals. Read `Main.cs` and `Patches/Simulation.cs`.
- **`roobuni/MiniMotorwaysModLoader`** — the API reference in the README plus `Mods/RunINFO/RunINFO.cs` enumerate the real model surface (`VehicleModel.behaviorState`, `DestinationModel.TotalDemand`, `CityPlanModel.scheduledBuildings`, `ClockModel.SecondsPerWeek`, …).
- Adjacent, non-web but with real sims: `KTK-Jadoo/mini_motorways_rl` (C++17 + OpenGL RL env), `utilForever/infinity-motorways` (Rust).
- Mini Metro clone prior art is mostly non-web; osgameclones lists only TransLines (Pascal/Lazarus, CC0) as playable.

### 7.7 Instrumentation to ship behind a debug overlay

You will not balance this game without them: per-destination `TotalDemand` / `totalServicedPins` / overcrowd time · per-lane vehicle counts · count of cars below a speed threshold for >3 s (gridlock detector) · average committed-wait at chunks · average path length at journey start · carpark entry-queue depth · pins/minute per colour vs week index.

---

## 8. Open design decisions — a human must choose

Each of these is a real fork where the evidence does not decide for us.

1. **Roundabout priority: keep the original's inverted give-way (circulating traffic yields to entrants, ring can gridlock) — or fix it to real-world priority?** Keeping it preserves the early-strong/late-useless arc that makes the roundabout a *timing* decision. Fixing it silently rebalances the entire late game and makes roundabouts strictly better than traffic lights.

2. **Path cost: time-weighted (length ÷ laneSpeed, so diagonals and driveways win) — or raw tile count with tie-breaks?** Time-weighting is unproven for the original but is what produces "diagonals beat stairsteps" and "driveways beat junctions", i.e. most of the skill ceiling. Tile-count is trivially cheaper and easier to explain to players.

3. **Session length: keep the original's 10–30 minute Classic as the default mode — or make a 12-week / ~15-minute "Commute" the default and relegate Classic to a secondary "Marathon"?** Classic-as-default is faithful and hostile to a chat-app context. Commute-as-default is the honest Telegram answer and changes what the leaderboard means.

4. **Aspect ratio: portrait-native ~24×40 grid — or landscape ~40×25 ported from the original with forced rotation?** Portrait costs us the original's readable city sprawl but is the actual Telegram viewport. Landscape + `lockOrientation` is faithful but adds a rotation prompt on every launch and breaks on desktop where fullscreen may return `UNSUPPORTED`.

5. **Colour disambiguation: numerals/glyphs on every house and destination by default — or colour-only with an opt-in accessibility toggle?** Default glyphs fix the original's acknowledged weakest area and help everyone on a 5-inch screen, but they visibly break the "souvenir map" minimalism that is the entire art thesis.

6. **Palette size: fix at 5 groups on every map — or allow per-map 5-or-6 as the original does?** Six is a real difficulty lever the original uses on exactly two maps, but the sixth hue is the hardest to distinguish at phone size and it breaks the audio harmony formula's `MaxGroups − 1` assumption.

7. **Anti-cheat: replay-verify every submission (needs Workers Paid, $5/mo, or an async queue) — or trust client scores on a friends-only leaderboard and skip verification entirely?** Verification is architecturally cheap (127 ms) but forces the isomorphic-sim constraint on every future gameplay change and invalidates old replays on every balance patch.

8. **Backgrounding: hard-pause the sim on `deactivated` — or fast-forward a bounded number of ticks on `activated`?** Pausing is honest and battery-friendly but lets a player freeze a doomed city indefinitely to think. Fast-forwarding preserves pressure but must be recorded in the input log and can kill a run while the player was answering a message.

9. **Expert Mode's permanence: ship it as mode 3 — or never, because irreversible placement on a touch screen with fat fingers is a different game than it is with a mouse?** Expert is cheap (same sim + a lock timer + an offer-pool change) and is the endgame gate, but the original's own mobile guidance leans on reversibility as the thing that makes touch input survivable.

10. **Monetization: Telegram Stars for cosmetic map skins and extra cities — or fully free with no Stars integration at all?** Stars is mandatory *if* we sell anything digital, and non-compliance means Telegram hides the app from mobile users entirely. Free means no payment plumbing, no `pre_checkout_query` 10 s SLA, no refund flow — and no revenue.

11. **Storage of record: DeviceStorage/localStorage as the hot path with periodic CloudStorage sync — or CloudStorage as the single source of truth?** CloudStorage is the only cross-device store, but every write is one server round-trip per key with no documented rate limit. localStorage is the only synchronous API and therefore the only one usable in a teardown handler — but we have no verified answer to whether Telegram's iOS WKWebView persists it across sessions. **Test this on a real iPhone before committing; the whole tier-1 design depends on it.**

12. **Daily challenge as the primary retention hook (one blind scoring attempt, bot push at 00:00 UTC, leaderboard posted into group chats) — or the 5-tier map-unlock lattice?** The daily fits Telegram's social surface perfectly and needs no map content. The lattice is the original's proven long-arc progression but gates content behind 200–350-trip runs a casual player may never reach.

13. **Ship a Creative Mode / screenshot exporter in v1 — or defer it?** It is a shareable-image engine, which is exactly what a chat platform rewards, and `shareToStory` is the single highest-leverage virality primitive we have. But it needs building-placement tooling the core game does not otherwise require.

14. **Renderer: commit to Canvas2D — or spend a day building a throwaway spike that renders 400 animated sprites in Telegram's Android WebView on a `performanceClass: LOW` device and let the measurement decide?** All the throughput evidence we have is desktop. This is the cheapest de-risking available and it should probably happen before the first line of renderer code.

15. **Sim tick: 30 Hz with render interpolation — or 60 Hz?** 30 Hz halves the mobile CPU budget and makes `LOW`-class Android viable, but doubles the sub-tick error in car spacing and chunk-entry timing, which is exactly where the game's queueing feel lives.