# Laneways — Design Spec

**Date:** 2026-08-02
**Status:** Approved, ready for planning
**Research basis:** [`docs/research/2026-08-02-original-game-research-dossier.md`](../../research/2026-08-02-original-game-research-dossier.md)

---

## 1. What we are building

A traffic-routing city game in the lineage of Mini Motorways, shipped as a Telegram Mini App.

The player draws roads on a tile grid connecting coloured houses to same-coloured destinations. Cars drive themselves. Destinations accumulate waiting customers; if any single destination stays over capacity long enough, the city shuts down and the run ends. Score is completed trips. Once a week the player picks one of two upgrade cards. Difficulty ramps on the demand side only.

The design goal is that **the player is the only rerouting mechanism in the system**. Cars path once at departure and never re-route, and path cost contains no congestion term. Every traffic jam is a problem only the player can solve, by redrawing. This omission is deliberate and load-bearing; it is the game.

### 1.1 Naming

Working title **Laneways**. The name lives in one constants file plus the BotFather app config; changing it is a one-line edit and is not a blocker for any milestone. Repo and package name remain `mini-motorways-clone`.

We clone mechanics, not identity. Game rules are not copyrightable; the original's palette, iconography, typography, and name are its own. We ship our own visual identity in the same minimalist family. No asset, colour value, or string is copied from the original.

---

## 2. Scope

### 2.1 In scope for v1

- Classic mode: unbounded run, ends on first destination overcrowd, score = completed trips
- One map at launch, authored in a data format that supports many
- Portrait-native grid, expanding during a run
- Roads (8-direction, orthogonal + diagonal), bridges, tunnels, roundabouts, traffic lights, motorways
- Weekly two-card upgrade choice
- Crash-safe save and resume
- Telegram shell: Main Mini App launch, fullscreen, safe areas, haptics, `initData` auth
- Server-verified leaderboard via deterministic replay
- Debug/telemetry overlay

### 2.2 Deferred

| Deferred | Why |
|---|---|
| Expert mode | Irreversible placement on a touchscreen is a different game; cheap to add later (same sim + a lock timer + an offer-pool change) |
| Creative mode | Needs building-placement tooling the core game does not require |
| Telegram Stars / payments | No payment plumbing until we sell something. Stars is *mandatory* if we ever do — Telegram hides apps from mobile users that sell digital goods any other way |
| Rail and ferry terrain | Moving-obstacle systems; arrived years later in the original |
| Six-colour maps | Data format supports 5 or 6; v1 authors 5. The sixth hue is the hardest to distinguish at phone size |
| Endless mode | Needs an efficiency metric the original never surfaces |

---

## 3. Decisions of record

Facts below are tagged by evidence tier, matching the research dossier: **[DPC]** official developer material, **[MOD]** constants from a decompile-based mod (field names compile-verified, values possibly stale), **[FAN]** community sources, **[OURS]** our own decision where no public answer exists.

| # | Decision | Rationale |
|---|---|---|
| 1 | Faithful mechanics first; Telegram is the shell | Social and meta features are phase 2. Avoids shipping something that is neither a good clone nor a good Telegram game |
| 2 | Own visual identity, same genre | Safe to publish; better work; costs one round of art direction |
| 3 | Classic (unbounded) is the default and only v1 mode | User decision. Makes crash-safe resume a launch blocker rather than a nice-to-have — see §8 |
| 4 | Portrait-native, ~24×40 grid revealed from 14×22 | The Telegram viewport is portrait. Forced rotation is hostile on every launch and `lockOrientation` can return `UNSUPPORTED` on desktop |
| 5 | Cars path once at departure, never re-route | [FAN, corroborated by `VehicleModel.repathUrgency` existing with `NotRequired` as the normal case] |
| 6 | No congestion term in path cost | Load-bearing omission. See §1 |
| 7 | Time-weighted path cost: `length / laneSpeed` | [OURS] Unproven for the original — the dossier's verifier explicitly refuted the inference that lane-speed constants prove it. We choose it anyway because it generates "diagonals beat stairsteps" and "driveways beat junctions", which is most of the skill ceiling |
| 8 | Roundabouts keep inverted give-way (circulating yields to entrants) | [FAN] Preserves the early-strong/late-useless arc that makes a roundabout a timing decision. "Fixing" it silently rebalances the entire late game |
| 9 | Demand is destination-pull, not house-push | [DPC] Composer Rich Vreeland: *"The destinations 'request' cars."* Most clones invert this |
| 10 | 30 Hz fixed sim tick, render-interpolated | [OURS] Halves mobile CPU vs 60 Hz. Revisit after the M0 spike |
| 11 | Multi-source Dijkstra flow fields, one per colour, full rebuild on dirty | [OURS] Measured: one A\* query ≈ one whole flow field. See §5.3 |
| 12 | Canvas2D, no engine | [OURS] Measured bundle costs. See §6 |
| 13 | Integer-only simulation, seeded RNG in state | [DPC] The original is fixed-point `Fix64` and replay-deterministic by design |
| 14 | Submit inputs, not scores; server replays | [OURS] 2.4 KB per run, 127 ms to verify |
| 15 | Hard-pause the sim on Telegram `deactivated` | [OURS] Honest and battery-friendly. Must be recorded in the input log so server replay makes the same choice |
| 16 | Glyphs on buildings off by default, prominent HUD toggle | [OURS] See §7.4. Colour-only is the original's acknowledged weakest area |
| 17 | Cloudflare Workers + static assets + D1, R2 for share images | Best cold start; a Telegram webview opening on mobile data is this project's worst latency moment and the one thing that cannot be fixed later in code |
| 18 | Modifiers before extra maps | 2–3 random modifiers over 5 maps generates more variety than 20 maps |

---

## 4. Module boundaries

```
packages/
  sim/       Pure deterministic core. No DOM, no floats, no I/O, no runtime deps.
  render/    Canvas2D behind a ~10-method interface. Reads sim state, never writes.
  game/      Glue: fixed-timestep loop, input→intent, HUD, Telegram adapter.
  shared/    Map format, replay codec, rule constants. Imported by sim AND bot.
  bot/       grammY + Worker: initData validation, replay verification, D1 leaderboard.
```

Dependency direction is strictly one-way: `bot` and `game` depend on `sim` and `shared`; `sim` depends on `shared` only; `render` depends on nothing but its own interface types.

**`sim` is the whole bet.** Its contract is:

```ts
step(state: GameState, inputs: TickInputs): GameState
```

Pure, integer-only, allocation-free. It runs unchanged in the browser and in a Cloudflare Worker. That single property is what makes verified leaderboards a config flag later rather than a rewrite, and it is brutal to retrofit — hence adopted from the first commit.

### 4.1 Determinism rules, enforced by lint

Inside `packages/sim`, an ESLint rule bans:

- `Math.random`, `Date.now`, `performance.now`, any `Date` construction
- All transcendentals (`sin`, `cos`, `exp`, `pow`, `log`) — IEEE-754 `+ - * / sqrt` are spec-deterministic in ECMAScript but transcendentals are implementation-defined and genuinely differ across engine, OS, and CPU
- `Array.prototype.sort` — engine-dependent for equal keys — unless given a total-order integer comparator
- Iteration over `Map`, `Set`, or object keys for anything sim-affecting
- Float literals
- Any DOM or global access

Positions are cell index plus an `Int16` sub-cell offset in 1/256ths. Speeds, costs, and timers are integers. Floats exist only in the render layer.

Rule constants are quoted in decimal throughout this document for readability, but are **stored and computed as integer numerators over a fixed denominator of 1000**. A right-angle turn multiplier of 0.667 is `667`; an overcrowd ramp of 0.02 is `20`. The lint ban on float literals applies to sim code without exception; the conversion happens once, in the constants file.

RNG is mulberry32 with 32 bits of state seeded from an xmur3 hash, stored **inside** `GameState` so snapshots and rollback come free.

State is struct-of-arrays over typed arrays: snapshot is one `ArrayBuffer` copy, zero per-tick allocation.

---

## 5. Simulation

### 5.1 Board

Axis-aligned square tile grid, orthographic top-down. Terrain per cell is one of: land, water, mountain, tree.

| Terrain | Blocks | Counter |
|---|---|---|
| Tree | nothing | destroyed by any placement; exists to block spawns |
| Water | road | bridge, or motorway flying over |
| Mountain | road **and motorway** | tunnel only |

The mountain/motorway asymmetry is what gives tunnels their value.

Grid expands during a run on a per-map, per-week schedule (deterministic and easy to author). Camera zoom-out hard-stops at a minimum tile size of 28 CSS px.

### 5.2 Entities

**Houses.** Hold exactly 2 cars permanently from spawn; both may be out at once. No other state. A house can never cause a loss.

**Destinations.** 2×3 footprint plus a carpark. Square (shop) at base demand; circle (skyscraper) is an in-place upgrade with exactly 2× demand, implemented by occupying two slots in the colour's round-robin rotation. Double destinations share one carpark between two colours; cars may drive through a carpark.

### 5.3 Demand and dispatch

1. Each colour group has its own pin timer. On tick, the next destination of that colour in round-robin receives a pin.
2. First pin fires 4 s after a destination spawns [MOD].
3. Baseline ≈ 1.24 pins per in-game day for a square, 2.48 for a circle, before the weekly ramp [MOD-derived].
4. **Overflow redistribution:** if the chosen destination is at its hard pin cap, the pin redirects to the next same-colour destination. Three lines of code, and it is what makes late-game collapse chain across the map. Implement it.
5. **Blocked-spawn redistribution:** when no new destination can be placed anywhere, that scheduled demand is pushed into existing destinations instead.
6. A pin dispatches an available car from the **nearest same-colour house** by weighted route cost. The pin is reserved on departure; cars never compete.
7. The car drives to the destination, removes exactly one pin, returns to the *same* house, becomes available.

**Score credits on return home** [OURS] — matches the community definition of a trip and makes long trips genuinely more expensive, which is the intended pressure.

Weekly demand ramp [OURS]: `spawnScale(w) = 1.0 + 0.11 · (w − 1)`, capped at 3.0. This is the single most important tuning unknown in the project; the telemetry overlay (§10.3) exists primarily to calibrate it.

### 5.4 Pathfinding

**Multi-source Dijkstra flow fields, one per destination colour, full rebuild on dirty.**

Seed Dijkstra from every unfilled pin of a colour simultaneously. The resulting field encodes "route to the nearest pin of this colour", which is exactly the game's rule. Store `Int32Array dist` + `Int8Array dir` per colour. A car's per-tick pathfinding is one array read: `dir[cell]`.

Measured on a ~1,500-cell grid (Node, M-series):

| Workload | Time |
|---|---|
| Single A\* query, 8-dir | 21.5 µs |
| 8-dir weighted Dijkstra flow field, 1 source, Dial's bucket queue | 21.5 µs |
| Same, 4 sources | 31.5 µs |
| Full headless replay: 72k ticks, 200 agents, 1,200 field rebuilds | 127 ms |

One A\* query costs the same as an entire flow field for the whole map. At 200 cars, flow fields win by 25–30×, and the gap widens linearly with car count.

**Do not build D\* Lite or LPA\*.** Full recompute is 30 µs; incremental algorithms buy nothing and cost determinism clarity.

Implementation constraints: preallocate every buffer at boot; never allocate inside a tick; Dial's bucket queue backed by a preallocated `Int32Array` (integer weights bounded at 14, so ~32 buckets suffice); coalesce dirty rebuilds to at most one per tick; model intersection and traffic-light penalties as extra integer edge weight, which Dijkstra absorbs for free.

**Dispatch falls out of the field, and the direction matters.** A field seeded from all unfilled pins of colour C gives, for every cell, the distance to the *nearest* pin of that colour — not to one specific pin. So dispatch is not "pick a pin, then search for a house". It is: every house of colour C with a free car reads `dist[houseCell]`, which is its distance to the nearest unfilled pin; the house with the smallest value dispatches. The car then follows `dir[]` downhill and claims whichever pin it reaches.

This is self-consistent with the observed behaviour that cars *tend* to prefer closer destinations without it being a hard global optimum, and it costs one array read per house instead of a search.

Flow fields do not give pin reservation. Iterate cars in stable integer-id order each tick; each claims the nearest unclaimed pin by field distance. Ties break on lower integer id, never on iteration order of a `Map`.

Edge weights: orthogonal 10, diagonal 14, motorway ÷3. Diagonals cost 1 tile and span √2, so a diagonal route uses half the tiles *and* less total distance than the L-shaped equivalent — strictly better for diagonal travel, not a trade-off.

### 5.5 Movement and blocking

Lane speed multipliers [MOD, values reported and possibly stale — treat as starting points to tune]:

| Constant | Value |
|---|---|
| default lane speed | 1.0 |
| max speed on motorways | 3.0 |
| roundabout multiplier | 2.0 |
| right-angle turn | 0.667 |
| approaching intersection | 0.5 |
| sharp turn (hairpin) | 0.333 |
| max wait at intersection before proceeding anyway | 45 s |

Where multiple multipliers apply to one lane, average them rather than taking the minimum.

**One blocking primitive:** *does an inbound vehicle collide with a traversing vehicle on this chunk?* Roads decompose into chunks; each tracks inbound vehicles with a committed timestamp. This single mechanism yields queueing, give-way, roundabout yielding, carpark queues, and emergent gridlock with no collision physics. The original does exactly this — disabling that one method in the shipped game disables all vehicle collision.

Car density [OURS]: 1 car per 0.5 tile of lane, minimum gap 0.35 tile.

Parking bays [OURS]: reserved atomically at dispatch, round-robin over free bays. 3 bays single, up to 8 double.

### 5.6 Traffic lights and roundabouts

Lights are **demand-actuated with hysteresis**, not fixed-cycle [MOD]: 10 s minimum between changes (5 s in overtime), 2 s amber, needs ≥2 nearby cars within 2 tiles to swap, idle time weights up to a 30 s cap. Right-on-red is modelled: it skips the *stop*, not the intersection slowdown.

Lights place only on an existing road **junction**, never plain road, and cost 0 tiles.

Roundabouts are 3×3 — centre plus all 8 neighbours must be clear of buildings, motorway endpoints, lights, water, and mountain. They may overwrite existing road, which is refunded. Cost 0 tiles. Circulating traffic has no enforced right-of-way: cars on the ring will sometimes stop to admit entrants, so the failure mode is the **ring itself backing up** and jamming outward.

### 5.7 Motorways

Cost **0 road tiles** — the 10 tiles attached to the motorway card are a bundled bonus grant, not a length unit. Unlimited length; endpoints snap to grid, the curve between is off-grid and free-form. Passes over everything except mountains. Cars run at 3× and retain boosted speed ~10 tiles after exiting. **Hard cap 9 per city.** Fully reversible.

### 5.8 Failure

Per-destination overcrowd timer [MOD]:

| Constant | Value |
|---|---|
| max overcrowd time | 90 |
| ramp acceleration | 0.02 |
| unwind speed (once back under capacity) | 2× |
| reduction on car arrival | 10% of current, clamped to [0 s, 3 s] |
| hidden grace at the end | 2 s |

Timer speed `s(t) = min(1, 0.02t)`, so with zero arrivals the ring fills in ~113 s: 50 s ramping, then 65 s at full rate, minus 2 s hidden grace.

There is **no carpark immunity** — a car metres from the bay does not save you. The original deliberately omits it.

**If any single destination's timer completes, the city shuts down immediately.** No lives, no partial failure, no win condition.

Pin capacities [OURS — every source contradicts every other]: square triggers the timer at 6, hard cap 10; circle at 8, hard cap 14. **These are the primary run-length dial.** Tune them before touching anything else.

### 5.9 Spawning

Geometric rules, implemented literally because they are the advanced metagame:

- A destination needs a clear 2×3 block
- Destinations never spawn within 1 tile of another destination
- Future houses of a neighbourhood spawn within ~2 tiles of an existing same-colour house
- **Nothing ever spawns on an existing road tile.** This is the entire basis of spawn-blocking, where players lay stub roads over every free 2×3 to shape the city. It is a major skill expression and must not be accidentally optimised away.

Timing [MOD]: minimum 10 s between destination spawns, 10 s between same-group house spawns, 2 s cooldown on a failed house spawn, 20 s retry on a failed destination, ignore spawn weights after 5 consecutive failures.

### 5.10 Weekly upgrade

Fires at the end of each in-game week. Full-screen paused modal, exactly **2 options**, plus a peek button to inspect the board underneath. No skip, no bank, no reroll, no timer.

| Card | Item | Road tiles |
|---|---|---|
| Road Tiles | — | 30 or 40 (per-map constant) |
| Bridge | 1 or 2 (per-map) | 20 |
| Tunnel | 1 | 20 |
| Roundabout | 1 | 20 |
| Traffic Lights | 2 | 20 |
| Motorway | 1 | 10 |

Every card grants road tiles, so a bad draw can never softlock. **Tile income is flat, not week-indexed** — difficulty ramps on the demand side only. Pool is filtered by map capability (no tunnels without mountains, no bridges without water).

Week length [OURS]: **150 s at 1×**, 7 equal days ⇒ 21.43 s/day. Plausible range 120–180 s; tunable constant.

Fast-forward runs **2 ticks per frame, never a larger `dt`**.

### 5.11 Roads

One segment per cell in one of 8 directions. Cost 1 tile per cell, orthogonal or diagonal. Bidirectional, one lane each way. Placeable on any land cell including disconnected stubs.

**Delete refunds tiles in full**, but the refund is *delayed* while a car has committed to that segment. The tile renders as a thinner, lower-opacity ghost until the last committed car clears. Tiny code, large share of why the game feels forgiving.

Bridges and tunnels consume 1 road tile per span tile on top of the item.

---

## 6. Rendering

Canvas2D, zero engine bytes, behind an interface thin enough that swapping in Pixi is a one-file change.

**Measured bundle cost** (esbuild, minified ESM, gzip -9):

| Library | gzip |
|---|---|
| Pixi 8 WebGL minimum (Renderer + Container + Sprite + Texture) | 99.5 KB |
| Pixi 8 Application + Graphics + Sprite | 140.5 KB |
| Excalibur 0.32 | 145.3 KB |
| Phaser 4.2 | 355.7 KB |
| Canvas2D | 0 KB |

Note for anyone tempted later: Pixi v8's Canvas renderer is ~7 KB gzip *larger* than its WebGL-only build for a sprite-only app, because both pull the same scene-graph machinery.

**Throughput reality check.** Reproducible benchmarks (moving rects, 8,000 boxes) put vanilla Canvas2D at ~19 FPS in Chrome — but that cliff is at 8,000 sprites. Our workload is 200–400 moving sprites over a pre-baked static layer, roughly an order of magnitude below it.

**Techniques that make this work:**

- **Roads as a 256-entry tile atlas**, not stroke paths. Per-cell 8-bit direction bitmask; each of the 256 configurations pre-rendered once into an offscreen canvas at device pixel ratio. Freehand stroking will never match the joins — the original procedurally generated exactly such an atlas.
- **Bake the road network to an offscreen canvas once per edit** (a few times a minute, not per frame) and blit it as one `drawImage`. Drops per-frame draws from ~1,500 to ~300. Without this, the sprite budget above is meaningless.
- **Shadows as one composited layer.** Draw all shadow shapes offset at a fixed angle into an offscreen canvas with opaque black, then composite the whole layer once at 10–14% alpha. Reproduces non-additive shadow overlap exactly, for one extra blit. Never alpha-stack per-sprite shadows.
- Entities are flat pastel fill + one uniform drop shadow + corner radius ~15–20% of the shape's short side. No gradients, no per-face shading.
- Road stroke width 55–65% of tile size, round caps and joins.

**Budget by frame time on a real cheap phone** — target well under 8 ms of drawing per 16.7 ms frame — not by sprite count. All the throughput evidence we have is from desktop. Read Telegram-Android's injected `performanceClass` (`LOW | AVERAGE | HIGH`) from the User-Agent and degrade on `LOW`. There is no iOS equivalent.

---

## 7. Presentation and UX

### 7.1 Art direction

Flat, unshaded pastel fills, fixed near-top-down camera, consistently-directed offset shadows that do not darken where they overlap. Reference frame is souvenir tourist cartography rather than road maps: exaggerate the few things that matter, drop everything else.

Palette theme object: `{ background, land, water, mountain, road, roadEdge, shadow, uiText, groups[5..6] }`.

Read Telegram's `themeParams` for app chrome so we do not fight the host, but **keep the playfield on our own palette** or the city loses its identity.

### 7.2 HUD

Exactly three persistent elements:

1. **Week/day clock**, top, doubling as pause and speed control. The original collapses this by default and it is a standing community complaint — **ship it always-expanded.**
2. **Score** (trip count), adjacent.
3. **Inventory chip row** at the bottom, thumb-reachable. Icon plus count; greyed with badge suppressed at zero.

One modal in the whole game: the weekly upgrade choice, as two large cards rising from the bottom, thumb-reachable, not a centred dialog.

### 7.3 Input

Tile-snapping, never free-draw. Grid symmetry guarantees that a route drawn A→B is also usable B→A.

- **Draw:** one-finger drag lays segments cell by cell
- **Delete:** explicit erase-mode toggle with a sweep gesture. Never a tap, never long-press — on touch it must be modal
- **Pan/zoom:** two-finger only, or gated behind the mode toggle. The original ships a draw-mode toggle specifically because it is otherwise easy to delete roads while trying to move the camera. This is the single most important mobile UX lesson available
- **Auto-zoom on draw start:** ease the camera in 1.3–1.5× around the touch point so the target cell exceeds the fingertip. Offset the drawing cursor slightly above the contact point so the finger does not occlude it
- **Pause is one tap, always available**, and visibly freezes everything. Players plan while paused; on mobile that substitutes for precision
- **No undo** — acceptable only because deletion refunds in full. Never ship one without the other

### 7.4 Colour accessibility

Distinguishing 5–6 similar pastels is materially harder on a 5-inch screen than on desktop, and it is the original's acknowledged weakest area — real protanopes report yellow and light green being indistinguishable in *both* of its colour modes.

Our approach:

- Separate group palettes on **lightness as well as hue**, and run every palette through deuteranopia and protanopia simulators as a build step
- Glyphs (numerals or shapes) on houses and destinations as a **first-class toggle in the HUD, not buried in settings** — default off, because default-on visibly breaks the minimalist thesis
- Long-press to highlight all buildings of one colour

### 7.5 Audio

Deferred to M5, but the architecture should not preclude it. The design principle worth preserving is inverted from most games: *success is the absence of sound*. One scalar — the count of active destination requests — drives density from ambient pads to pulsing tones. Beat-quantised, slightly detuned car horns are the only congestion warning.

WebAudio starts suspended; unlock on the first tap of the main menu. No Telegram exemption exists. Expect the iOS hardware mute switch to silence Web Audio regardless.

---

## 8. Telegram integration

Gate every feature at runtime with `isVersionAtLeast()`. **The user's client version, not our deploy, determines availability.**

### 8.1 Launch

Ship as a **Main Mini App / direct link** (`t.me/<bot>/<app>`). This is forced: keyboard-button launches provide no `initData` at all and cannot authenticate. Main Mini Apps open full-height by default; do not pass `mode=compact`, since opening at half height and calling `expand()` causes a visible reflow and canvas resize on the first frame.

Consequence: **no `query_id`**, so `answerWebAppQuery` and `sendData` are unavailable. All sharing goes through `savePreparedInlineMessage` + `shareMessage`, and `shareToStory`.

Launch parameters arrive in the **URL hash fragment**, not the query string. Capture and persist them to `sessionStorage` on first load — a hash-routing app destroys them.

### 8.2 Boot sequence

Exact order:

```
WebApp.ready()                       // dismisses the BotFather splash — first
WebApp.expand()                      // no-op on desktop, safe everywhere
WebApp.disableVerticalSwipes()       // 7.7+
if (isVersionAtLeast('8.0')) {
  WebApp.requestFullscreen()         // handle fullscreenFailed / UNSUPPORTED
  WebApp.lockOrientation()
}
// only now: size the canvas
```

### 8.3 Viewport and safe areas

Size against **`viewportStableHeight`**, never `viewportHeight` — the latter changes continuously while the sheet is dragged and Telegram's own docs warn the refresh rate cannot follow it. Re-layout only on `viewportChanged` where `isStateStable === true`, debounced. Use `height: var(--tg-viewport-stable-height, 100vh)`; plain `100vh` is unreliable inside the webview.

Honour **both** inset systems: `safeAreaInset` (OS chrome — notch, home indicator) and `contentSafeAreaInset` (Telegram's own overlaid UI).

**The top band is dead space.** Telegram's header remains drag-to-dismiss by design — their docs say so explicitly, and no CSS suppresses it — and in fullscreen the close button floats over the top-right corner. No interactive element, score, or pause button may live there.

`disableVerticalSwipes()` is the correct primary mechanism and is officially supported; it is a silent no-op below 7.7, so version-gate it. Add `touch-action: none` on the canvas and `overscroll-behavior: contain` on scrollers. Do **not** use the legacy pre-7.7 hacks (fixed body, blanket `preventDefault` on `touchmove`) — they are the approach that was reported broken and they break legitimate scrolling.

### 8.4 Haptics

`impactOccurred('light')` on segment placement · `selectionChanged()` on grid-cell change while dragging · `notificationOccurred('warning')` on destination overflow · `notificationOccurred('error')` on game over. Guard every call: genuine on iOS, gaps on some Android builds, silent no-op on desktop.

### 8.5 Webview hazards

- The DOM Fullscreen API does not work inside the webview. Use Telegram's `requestFullscreen()`
- **iOS fails silently on asset load errors** — a web font that fails to load has been traced as the cause of black-screen-with-working-audio. Self-host and preload every font and atlas; never depend on a cross-origin CDN
- Telegram Desktop caches Mini App bundles in a location its normal cache-clear does not reach. **Content-hash every asset filename and serve `index.html` with `Cache-Control: no-store, must-revalidate`**
- SSR is impractical — the Telegram API needs `window`
- Clients differ. `tgWebAppPlatform` ∈ `android | ios | macos | tdesktop | weba | web`, each developed separately

---

## 9. Persistence

Because Classic runs are unbounded and a Telegram webview is backgrounded and killed constantly, **crash-safe resume is a launch blocker, not a nice-to-have.**

Measured snapshot size: full binary state of a 43×35 road grid + 60 buildings + 250 cars + header = **3,809 B raw**, 492 B gzipped. That grid is larger than our 24×40, so treat it as an upper bound.

**Tier 1 — crash safety.** Synchronous binary write to `localStorage` every ~2 s of sim time and on `visibilitychange`. It is the only storage API that can complete inside a teardown handler.

**Tier 2 — cross-device.** Mirror to CloudStorage on `visibilitychange` and `deactivated`. **Design the save as one key**: CloudStorage writes are one MTProto round-trip per key with no local cache, no batching, and no write coalescing. Reads and deletes can batch; writes cannot. Limits are 1024 keys × 4096 chars, key charset `A-Za-z0-9_-` only.

**Triggers.** Listen to `document.visibilitychange`, `window.pagehide`, **and** Telegram's `deactivated`, all routed through one debounced, dirty-flagged save. You cannot rely on `beforeunload` or `unload` on mobile, and even `visibilitychange` occasionally fails to fire on Safari. `isActive` plus the `activated`/`deactivated` events are the correct pause signal — Telegram's minimize-to-app-bar does not consistently drive the web visibility event.

**Never compress in a teardown handler** — `CompressionStream` is stream-based and async. Write the raw 3.8 KB; localStorage has megabytes.

**Save the input log alongside the snapshot.** Resume restores the snapshot for instant play, but a leaderboard submission needs the log from tick 0. A session resumed without its log is **unranked**, and the UI must say so rather than silently dropping the score.

Use `enableClosingConfirmation()` during an active run, but note it does not give an awaitable `beforeunload` — persist continuously, not on close.

> **Open risk, blocking.** Nobody could verify whether Telegram's iOS WKWebView persists `localStorage` across sessions. The entire tier-1 design depends on it. **This is tested on a real iPhone in M0, before anything is built on top of it.** If it fails, tier 1 becomes an IndexedDB write with a synchronous localStorage fallback for the teardown path only, and the save cadence tightens.

---

## 10. Backend and infrastructure

### 10.1 Cloudflare

One Worker serves the static bundle and the API from a single origin — no CORS, one deploy.

| Product | Role |
|---|---|
| Workers | API + bot webhook |
| Workers Static Assets | game bundle; unmetered, does not count against the request cap |
| D1 | leaderboard |
| R2 (already in use) | rendered share images for `shareToStory`, which requires an HTTPS URL Telegram fetches server-side |

Free tier carries the whole build. The one thing that forces the $5/mo upgrade is replay verification: 127 ms of CPU does not fit the free tier's 10 ms per-request limit. Until then the Worker accepts submissions and verifies asynchronously, promoting the score a few seconds later.

Do **not** use Workers KV for the leaderboard — 1,000 writes/day on free is far too low. D1's free tier allows 100k row-writes/day, roughly 100k runs/day.

Hostname starts on `*.workers.dev` and can move to a custom domain on the existing zone later; attaching one to a Worker creates the DNS record automatically.

Dev loop: `wrangler dev` with local D1. For in-Telegram testing, `cloudflared tunnel` (free, CA-trusted cert) or a preview Worker. **Self-signed certs fail on Telegram mobile** — no `mkcert`, no `@vitejs/plugin-basic-ssl`.

### 10.2 Auth and anti-cheat

**Never trust `initDataUnsafe`.** Send the raw `initData` string verbatim to the backend as `Authorization: tma <raw>`.

HMAC validation, exactly:

1. Parse as query params; remove `hash`, remember its value
2. `data_check_string` = remaining `key=value` pairs sorted alphabetically by key, joined by `\n`. Values URL-decoded; the `user` value stays a JSON string
3. `secret_key = HMAC_SHA256(key="WebAppData", message=<bot_token>)` — **note the reversed argument order versus the Login Widget**: the literal string is the key, the token is the message
4. Constant-time compare `hex(HMAC_SHA256(key=secret_key, message=data_check_string))` against `hash`

Telegram prescribes no `auth_date` window; 24 h is a common SDK default, not a cap. **Our convention** (stated as ours, not as Telegram guidance): validate once at boot with a 1 h window, then mint our own 12 h JWT. `initData` never refreshes mid-session, which is precisely why per-request re-validation breaks long sessions.

`user.id` is documented as up to 52 significant bits — store as a 64-bit integer, never a naive JS number in a DB column.

**Leaderboard submissions carry inputs, not scores:** `(seed, mapId, rulesVersion, actions[])` at 8 B per action ≈ 2.4 KB for 300 actions. The Worker replays with the identical `sim` module and computes the score itself. Store `rulesVersion` on every row and keep old sim versions importable — a balance change invalidates old replays.

Store the user id from validated `initData`; **never** trust one in a request body.

Known limit worth designing around now: deterministic replay proves a score is *reachable under the rules*, not that a human produced it. If bot-farming ever matters, input timing distributions must be in the log format from v1 — they cannot be added retroactively.

### 10.3 Telemetry overlay

Ship behind a debug flag from M1. Balancing is impossible without: per-destination demand, serviced pins, and overcrowd time · per-lane vehicle counts · count of cars below a speed threshold for >3 s (gridlock detector) · average committed wait at chunks · average path length at journey start · carpark queue depth · pins per minute per colour against week index.

### 10.4 What the human must provide

1. `wrangler login` — interactive browser OAuth, one time
2. `@BotFather` → `/newbot`, then `/newapp`. Token goes to `wrangler secret put BOT_TOKEN`, never the repo
3. Chosen hostname
4. A low-end Android device and an iPhone for M0

---

## 11. Testing

**The determinism test is the spine.** Run N seeded sessions headless and assert byte-identical final state hashes across Node and browser. Any drift fails CI. A 20-minute run replays in 127 ms, so hundreds fit in a normal test run.

- **Golden replays:** recorded input logs plus expected scores, re-run on every sim change. Intentional balance changes bump `rulesVersion` and re-bless the goldens
- **Property tests** on invariants: tile budget never negative; delete always refunds in full; no car occupies two chunks; no pin serviced twice; no car routes onto water or mountain
- **Sim tests need no rendering.** M1 is fully testable without a single pixel, which is why it comes before the renderer
- **Telegram surface:** every `WebApp.*` call wrapped and version-gated; unit-test the wrapper's fallback behaviour with a mocked absent/old client
- **initData validation:** test vectors including a tampered hash, a stale `auth_date`, and a reordered param string

---

## 12. Milestones

Each milestone gets its own implementation plan. This spec is the design of record for all of them.

| | Deliverable | Exit criteria |
|---|---|---|
| **M0** | De-risking spike | 400 animated sprites measured in Telegram's Android WebView on a `performanceClass: LOW` device; `localStorage` persistence across sessions verified on a real iPhone. **Decides renderer and tick rate.** Throwaway code |
| **M1** | Headless `sim` + `shared` | Full rule set, no rendering. Determinism test green across Node and browser. Telemetry overlay data available |
| **M2** | Playable in a browser | Canvas2D renderer, input, HUD, one map, Classic mode, weekly upgrade modal |
| **M3** | Playable in Telegram | Boot sequence, viewport and safe areas, both persistence tiers, haptics, `initData` auth |
| **M4** | Leaderboard | Worker + D1, replay verification, submission flow, unranked-resume handling |
| **M5** | Content and polish | More maps, modifiers, generative audio, share cards, daily challenge |

M0 is genuinely first. Both questions it answers — renderer viability and whether tier-1 saves work at all — invalidate downstream design if answered wrong, and both are cheap to test.

---

## 13. Open risks

| Risk | Mitigation |
|---|---|
| iOS WKWebView may not persist `localStorage` across Telegram sessions | M0 tests it on real hardware before anything depends on it. Fallback: IndexedDB primary, localStorage for teardown only |
| All renderer throughput evidence is from desktop | M0 measures on a real low-end Android |
| The weekly demand ramp is our invention and unvalidated | Telemetry overlay from M1; expect several tuning passes |
| `[MOD]` constants are from a 2021–22 decompile of a game now several balance patches ahead | Treat every one as a starting point, not truth. They are all in one constants file for exactly this reason |
| Classic's unbounded run length is hostile to a chat-app session | Accepted deliberately. Persistence tier is the mitigation, which is why it is a launch blocker |
| CloudStorage has no documented rate limit | One key, debounced writes, and treat undocumented throttling as live |
| A balance patch invalidates every stored replay | `rulesVersion` on every row; keep old sim versions importable |
