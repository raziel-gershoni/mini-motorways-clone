# M2: the thin playable renderer — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing simulation visible and playable on a phone — draw a road with your finger, watch a car take it, see the score tick.

**Architecture:** Two new packages. `render/` is Canvas2D behind a narrow interface that reads preallocated arrays of already-resolved numbers and never writes sim state. `game/` is the glue: a fixed-timestep loop at 30 Hz with render interpolation, input→`TickAction`, a three-element HUD, a hand-authored starting city, and the Telegram adapter lifted from the M0 spike. Dependency direction stays one-way (spec §4).

**Tech stack:** TypeScript, Canvas2D, no runtime dependencies, **no new test dependencies** — every test in this milestone runs in bare Node under the existing Vitest. `vite` and `wrangler` are added as devDependencies of `packages/game` for build and deploy only.

> **This plan is a rewrite.** The first version was rejected by a four-lens adversarial review (74 findings, 24 Critical) as *DO NOT EXECUTE AS WRITTEN*. Every arithmetic value below has been recomputed by execution, and the closures of the Criticals are visible in the text rather than implied. The record of what changed and why is in `docs/superpowers/m2-plan-review-fixlist.md` and `docs/superpowers/m2-plan-review-raw-findings.md`.

---

## Global Constraints

- **Zero runtime dependencies** in `render` and `game`, as in `sim` and `shared`.
- **`render` imports nothing from `sim` and nothing from `shared`** — spec §4: "`render` depends on nothing but its own interface types". Enforced by a source scan Task 1 owns, because the existing scan in `packages/sim/test/determinism.test.ts` is rooted at `../src` and `../../shared/src` and cannot reach the new packages.
- **`render` never writes sim state.** Note that `readonly` in TypeScript applies to the *property*, not the elements: `frame.roads[i] = 0` type-checks. The real guarantee is the import ban above plus review, and this plan does not claim more than that.
- **`sim` stays untouched by this milestone.** All four goldens must hold: state `2413319809`, road-network `2790151213`, field `252514232`, loop `3896659943`. **If any moves, stop and report — do not re-bless.** `shared` gains exactly four integer constants (Task 3) and nothing else; they are new exports, they change no behaviour, and `MapData` is deliberately *not* touched because `mapIdHash` folds its fields into `mapIdentity[MI_MAP]` and would move every golden at once.
- **Nothing allocates inside the frame loop**, and unlike the first draft this plan says what that means against `step`'s real object API — see Decision 9. Enforcement is construction, review, and one identity-based test (Task 6). There is no allocation profiler and this plan does not pretend otherwise.
- Integer-only applies to `sim` only. `render` and `game` may use floats — they must never feed one back into `sim`.
- Cell index convention is `index = y * w + x`.
- The sim runs at **`TICKS_PER_SECOND = 30`**; `TICKS_PER_WEEK = 4500`; `SECONDS_PER_WEEK = 150`. **`TICK_MS` is derived in code as `1000 / TICKS_PER_SECOND`, never written as `33`** — see Decision 1.
- Do not modify `spike/`. Lift code from it by copying, and say so. The deployed M0 spike and its D1 binding stay live and untouched (Decision 10).
- Both new packages inherit `noUncheckedIndexedAccess: true` and `verbatimModuleSyntax: true` from `tsconfig.base.json`. Typed-array reads need `as number`; type imports need `import type`. This is not new style, it is what already compiles here.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## Scope

**In:** a hand-authored starting city, the road tile atlas, terrain/road/building/car drawing, a fixed camera fitting the revealed grid, tile-snapping draw and erase, pause, a three-element HUD, the fixed-timestep loop with sub-cell interpolation, the Telegram boot sequence, and a deploy to a new Worker of our own.

**Out, and named so nobody reads the gap as an oversight:**

| Deferred | Owner | Why |
|---|---|---|
| **Shadows of any kind** | Art pass | Cut from M2 entirely. See Decision 7 for the pixel accounting, kept here so nobody reintroduces a full-canvas layer without redoing it |
| Pan and zoom; auto-zoom on draw start (spec §7.3) | M2b | The revealed grid fits a portrait viewport at M2's fixed camera (Decision 5). Pan/zoom is the single most dangerous input feature on touch and deserves its own task |
| **Drawing while paused** (spec §7.3's "players plan while paused") | M2b | Roads live in sim state, which pause freezes, so the player would draw twenty segments and see nothing. Doing it properly needs a pending-action overlay in `render`. M2's pause therefore **rejects board input while paused**, stated rather than discovered |
| Haptics (spec §8.4: `impactOccurred('light')` on placement, `selectionChanged()` on cell change) | M2b | Small work, real platform gotcha (gaps on some Android builds), and it belongs with the rest of the drag feel |
| Rejection feedback — a `placeRoad` refused for budget, water or a destination footprint is silent | M2b | `placeRoad` returns `false` and `step` ignores it. In M2 the road simply does not appear. Named because it will read as a bug |
| Ghost lanes: a road erased under an in-flight car leaves the car driving on bare terrain | M1d | `runMovement` never reads `state.roads` (cars.ts's own module comment). This is the first visual artefact a player will find |
| Glyph toggle on buildings (§7.4), long-press colour highlight | M1e | Needs the HUD toggle row that does not exist yet |
| Speed control — spec §7.2's clock doubles as pause **and** speed, and §5.10's fast-forward runs 2 ticks per frame | M2b | M2's clock is pause only. Fast-forward needs a second drain path and its own tick-count arithmetic |
| Upgrade-card modal, inventory chip row (spec §7.2's actual third element) | M1e | Nothing to choose or spend yet. M2 shows tiles-left in that slot — a substitution, not §7.2 compliance |
| **The authored building-spawn schedule** | M1e | Task 2's fixed seed is a stand-in and M1e replaces it. Naming this is the whole point of CR1: the first draft deferred M1e without noticing the milestone depended on it |
| Map expansion / a real revealed region | M1d | Task 3 freezes the revealed rect as four constants. M1d makes it dynamic |
| Motorways, bridges, roundabout art | M1d/M1e | The mechanics do not exist |
| Telemetry overlay | M1e | Wanted for tuning, but tuning needs M1d's blocking first |
| Persistence, the input log, and the `deactivated` hard pause (spec §3 decision 15) | M3 | M0 established the storage design. See "What this plan does not settle" for what the out-of-band seed costs here |
| Stacked static canvas under the sprite canvas (M0 §3.5 item 5) | Perf pass | M0 recommends it as "separately worth doing, and orthogonal". It is a second surface and a second code path for a frame this plan models at well under a millisecond. Recorded so it does not read as missed |
| Audio | Later | |

**M2 is deliberately not a complete game.** Cars pass through each other (M1d), a run never ends (M1e), buildings never spawn after tick 0 (M1e), and nothing is saved (M3). It is the first build where the simulation is observable, and its job is to make the next three milestones debuggable and the balance constants tunable.

---

## Design decisions

### 1. Fixed timestep at 30 Hz, render at display rate, and `TICK_MS` is derived

The sim is 30 Hz and integer. Displays are 60 Hz or 120 Hz. Rendering only on tick boundaries is visibly choppy, and smooth car motion is most of this genre's feel.

```
const TICK_MS = 1000 / TICKS_PER_SECOND     // 33.333333333333336 — never 33
const MAX_FRAME_DT = 250

onFrame(now):
  if (resuming || firstFrame) lastTime = now      // Decision 1b, below
  rawDt = now - lastTime; lastTime = now
  if (!paused) {
    accumulator += min(rawDt, MAX_FRAME_DT)
    while (accumulator >= TICK_MS) { snapshotPrev(); step(...); accumulator -= TICK_MS }
    clearActionQueue()                            // after the drain, never before — Decision 9
  }
  alpha = accumulator / TICK_MS
  render(alpha)
```

**`TICK_MS` is `1000 / TICKS_PER_SECOND`, imported from `shared`, and writing `33` is a defect this plan names in advance.** At 33 ms a nominal 150-second week runs in 148.5 s — the sim counts ticks and the Worker replays ticks, so nothing goes out of sync with the server, but every wall-clock-derived claim in the game and in M0's measurements shifts by 1.01%, silently and forever. The reason an implementer reaches for 33 is that the correct value produces surprising tick counts, which is why every count below is given exactly.

**Hand-computed, all verified by execution at `TICK_MS = 33.333333333333336`:**

| Frame | Ticks | Accumulator after | alpha |
|---|---|---|---|
| 100 ms, fresh accumulator | **2** | 33.33333333333332 | 0.9999999999999996 |
| 105 ms, fresh accumulator | 3 | 4.999999999999986 | 0.14999999999999955 |
| 16.7 ms ×4 from cold | **0, 1, 0, 1** | — | 0.501, 0.002, 0.503, 0.004 |
| 2,000 ms, fresh (clamped to 250) | **7** | 16.666666666666615 | 0.4999999999999984 |
| 5,000 ms, fresh (clamped to 250) | 7 | 16.666666666666615 | 0.4999999999999984 |
| 5,000 ms with a 33.0 ms residual carried in | **8** | 16.33333333333327 | 0.49999999999999 |

The 100 ms case is the one the first draft got wrong: it asserted 3. `1000/30` rounds *above* exact, so `3 × TICK_MS = 100.00000000000001` and the third subtraction fails by one ulp. **The worst-case tick count for one frame is 8, not `MAX_FRAME_DT / TICK_MS = 7.4999999999999991`** — the accumulator carries a residual in `[0, TICK_MS)` from the previous frame, so the bound is `floor((MAX_FRAME_DT + TICK_MS - ε) / TICK_MS)`. Any bullet stating 7 must say "from a fresh accumulator".

**The clamp must not feed the sim.** The sim advances in whole ticks or not at all; the clamp only bounds how many. This is why the accumulator is real-valued and `step` is not — a float never crosses the boundary. `MAX_FRAME_DT = 250` is the clamp the M0 spike used, and it exists so a backgrounded tab does not run a thousand catch-up ticks on resume. **It does not eliminate catch-up, it bounds it at 7–8 ticks**, and the first draft's "survives a stall without a catch-up burst" was two incompatible claims in one phrase.

**1b. The clock reference is reset on resume and on the first frame, and that is a mechanism, not a precaution.** `rawDt = now - lastTime`. If pause freezes only the accumulator, `lastTime` goes stale for the whole pause, and the first unpaused frame sees `rawDt` = the pause duration, clamps to 250 ms and drains **7 ticks in one frame** — 233 ms of simulation in one frame, cars jumping most of a cell. Same for a cold start with `lastTime = 0`. One line fixes both: on resume and on the first frame, set `lastTime = now` and leave the accumulator alone.

This is what makes pause and stall *different*: a 2,000 ms **pause** must resume with 0 or 1 ticks; a 2,000 ms **stall** runs exactly 7. Neither number is discriminating on its own.

### 2. Interpolate the sub-cell-resolved position, and there is exactly one discontinuity

**The first draft interpolated the wrong quantity.** A car gains `speedUnits(LANE_SPEED_DEFAULT) = 330` progress per tick against a threshold of `edgeCost(dir) * COST_UNIT_SCALE` — 2,500 orthogonal, 3,500 diagonal. So `carCell` changes once every **2500/330 = 7.576 ticks** orthogonally and **3500/330 = 10.606** diagonally: about **3.96 cell changes per second**. A prev-cell→curr-cell lerp renders a car motionless for ~6.6 ticks (220 ms) and then smears a whole cell across one 33 ms window. That is a 4 Hz strobe and it is worse than not interpolating.

**The sim already stores the sub-cell term.** The resolver, in `game`, is:

```
resolve(state, world, i) -> (x, y) in grid-cell units
  phase = carPhase[i]
  if (phase === PHASE_NONE)  -> not live, not drawn
  if (phase === PHASE_IDLE)  -> (cx, cy) of carCell[i]            // parked at its house
  cursor = carRouteCursor[i]
  outbound = phase === PHASE_OUTBOUND
  if (outbound ? cursor >= carRouteLen[i] : cursor <= 0)
      -> (cx, cy) of carCell[i]                                    // exhausted route; see below
  dir = outbound ? routeStep(state, i, cursor)
                 : OPPOSITE[routeStep(state, i, cursor - 1)]       // cars.ts:208, exactly
  f = carProgress[i] / (edgeCost(dir) * COST_UNIT_SCALE)
  return (cx + DX[dir] * f, cy + DY[dir] * f)
```

Four things this pins that the first draft and the fix list both missed: **`carProgress`**, **`carRouteCursor`**, **`COST_UNIT_SCALE`**, and **the return leg's `OPPOSITE[routeStep(cursor - 1)]`** — half of every trip, and scoring is defined on it. `(DX[dir], DY[dir])` is used raw, not normalised: for a diagonal it is `(±1, ±1)`, and `f` reaches 1 exactly when the car lands on the next cell, so the geometry is correct for both. The per-tick displacement is `330/2500 = 0.132` cells orthogonally and `330/3500 × √2 = 0.1333` cells diagonally — near-constant Euclidean speed, which is what `DIAG_COST = 14 ≈ 10√2` buys.

The exhausted-route fallback is not defensive decoration: `routeStep` throws on an out-of-range index, and a renderer must never be the thing that crashes the game. It is unreachable from a post-`step` state (arrivals collects an exhausted car in the same tick that exhausts it) and it is directly callable from a test, which is the `assertSingleCrossing` idiom this codebase already uses for exactly this shape.

**The frame position is a plain lerp of two resolved snapshots**, not an extrapolation:

```
prevXY  <- resolve(...) for every slot, immediately before each step()
currXY  <- resolve(...) for every slot, immediately after
frameXY  = prevXY + (currXY - prevXY) * alpha
```

The single-expression form `cell + dirVector * (carProgress + alpha * speedUnits) / threshold` resolves the same position whenever the car neither turns nor changes phase, and differs only where it extrapolates *past* the end of the current edge: it overshoots a corner by up to 0.19 cells and overshoots the carpark at the outbound→return flip by 0.13 cells before jumping back. Lerping two resolved snapshots cannot overshoot, costs one preallocated `Float32Array`, and makes the prev snapshot a thing that can actually be stored — an `Int32Array` of cells cannot hold a sub-cell position.

**Now the snap rule, re-derived from scratch against the real tick order rather than patched.** `step` runs dispatch at phase 5 and arrivals at phase 7, so every transition is observed across a tick boundary with the phase byte already changed. Enumerating every way a car's resolved position can move between two snapshots:

| Transition | Displacement | Continuous? |
|---|---|---|
| Driving, no crossing | 0.132–0.1333 cells | Yes |
| Driving, crossing straight through | 0.132 cells | Yes |
| Driving, crossing with a turn | ≤0.132 cells along the path; the chord cuts the corner by ≤0.09 cells | Yes, with a sub-pixel corner cut |
| `PHASE_IDLE` → `PHASE_OUTBOUND` (dispatch, phase 5, then movement phase 6 in the same tick) | 0.132 cells from the house cell | Yes |
| `PHASE_OUTBOUND` → `PHASE_RETURNING` (the flip) | `2 × carProgress / threshold` ≤ 0.076 cells, *backwards* — the carry crosses the flip (trips.ts) and the reversed direction consumes it from the other side | Yes; the car turns around a fraction of a cell short of the carpark |
| `PHASE_RETURNING` → `PHASE_IDLE` (trip end) | Zero. `completeTrip`'s `carCell = houseCell[carHome]` is documented in trips.ts as a no-op on the reachable manifold: the retrace ends *on* the house cell | Yes |
| **A slot that was not live in prev becomes live in curr** | Unbounded — prev holds a stale value, or zero, which is grid cell (0, 0) | **No** |

**So the first draft's "car teleported home" discontinuity does not exist, its "phase unchanged within one tick" case is structurally impossible, and its distance guard was a 0-detector whose named must-fail mutation could not fail.** All three are deleted rather than repaired. The one real discontinuity is the last row, and the rule is:

> **A car slot that was not live in the prev snapshot renders at its curr position with no lerp. Everything else lerps unconditionally.** And `prevXY` is initialised by resolving the initial state once before the first frame — an unwritten `Float32Array` is all-zero, which is grid cell (0, 0), so a zero-initialised prev streaks every car in from the top-left corner on frame 1.

That rule has a constructible fixture (place a house mid-run — out-of-band placement is exactly what M1e does) and a fixture for the initialisation half (frame 1 at `alpha = 0.5`). A distance guard is deliberately **absent**: there is no on-manifold displacement above 0.14 cells, so any threshold between "ordinary move" and "discontinuity" would have no observer, and a renderer drawing a streak on corrupted state is cosmetic, not corrupting.

**One interaction worth stating, because it would quietly disarm the liveness test.** At M2's camera the revealed rect starts at cell (5, 9), so a phantom car at cell 0 lands *outside* the drawn region and the bounds check hides it. The liveness tests must therefore put the dead slots' cell **inside** the revealed rect, which means a hand-built frame — legitimate, and precisely what Decision 3 exists to permit.

### 3. `render` takes resolved numbers, and `game` owns every function that lives in `sim`

Spec §4 says `render` "depends on nothing but its own interface types" while also reading sim state. Those two clauses are compatible only for *bytes*, and they stop being compatible the moment anything needs a *function*. Interpolation needs `routeStep`, `edgeCost` and `OPPOSITE`; destinations need `destMetaColour`, `destMetaKind`, `destMetaOrientation`, `carparkCell` and `isFootprintCell`; terrain needs the `TERRAIN` enum from `shared`; the clock needs `weekOfTick` and `dayOfWeek`.

**Every one of those calls happens in `game`, which writes the results into a preallocated `RenderFrame`.** `render` receives numbers it can draw without asking anything. This is what makes "swapping in Pixi is a one-file change" true rather than aspirational, and it lets `render` be tested with hand-built arrays and no sim at all.

Two consequences the first draft did not carry:

- **Liveness prefixes are part of the interface.** A fresh `GameState` writes no `-1` sentinel (state.ts): unused house/destination slots are those at index ≥ `H_HOUSE_COUNT`/`H_DEST_COUNT`, and unused cars are `PHASE_NONE = 0` with `carCell = 0`. `render` is handed `houseCount`, `destCount`, and a **dense** car array with `carCount`, so a phantom is not representable at the boundary rather than merely not drawn.
- **`cleared` is part of the interface, indirectly.** `world.terrain` is never mutated; a tree destroyed by a road sets `state.cleared[cell] = 1` (roads.ts's `hasTree`). A renderer reading `world.terrain` alone draws a tree under every road the player lays through a forest, permanently. `game` therefore writes a `terrainClass` byte per cell — the fold of terrain and `cleared` — and `render` never sees either input.

`terrainClass` uses `render`'s own constants, which happen to share `shared`'s `TERRAIN` numbering (LAND 0, WATER 1, MOUNTAIN 2, TREE 3). That is a second copy of a numbering and it is deliberate: the alternative is `render` importing `shared`, which spec §4 forbids. The mapping is a `game`-side function with its own test, so the copy has one place to drift and one test watching it.

### 4. Draw road tiles per frame from a 256-entry atlas. Do not bake, and do not clear

**[M0]** — the spec bullet telling you to bake has been struck through with its measurements, because it inverts the intuition. Baking composites **3.2× the pixels** to draw the same roads (3,178,980 device px against 995,328 at M0's regime), crossover is at **85% road density** against our measured **45%**, and the core mechanic *is* drawing roads — so every frame of a drag would pay re-render + offscreen clear + blit, **4.8× the per-frame path**.

Pixel throughput binds at roughly **10 Gpx/s**; a `drawImage` costs about **0.16 µs**. M0's cost model is `calls × 0.16 µs + pixels / 10 Gpx/s`, and it reproduces M0's own road-layer figures exactly (432 × 0.16 µs + 995,328 px = 0.069 + 0.100 = 0.168 ms). Every number in this plan uses that model, in **M2's own regime** — revealed grid, capped DPR — not M0's.

**The atlas stays and is the reason the per-frame path is cheap:** 256 entries keyed by the 8-bit neighbour mask, pre-rendered once at the effective device pixel ratio, rebuilt only when the tile's device size changes.

**M2 issues no `clearRect`.** Three opaque fills cover the canvas exactly once — the top band, the grid rect in the land colour, the HUD band — and everything else draws on top. A `clearRect` plus a land fill covers it twice. At M2's regime on the M0 device that is a saved full-canvas pass: **1,412,880 device px, ~0.141 ms — more than the entire road layer.** The rule this creates: *every* pixel of the canvas must be covered by one of those three fills each frame, or the previous frame ghosts.

Frame model at M2's regime (M0 device, 406×870 CSS, DPR capped to 2, 29 CSS px tiles, 14×22 revealed):

| Pass | Calls | Device px | ms |
|---|---|---|---|
| Top band + grid land fill + HUD band | 3 | 1,412,880 | 0.141 |
| Non-land terrain (river + trees inside the rect, ~30 cells) | ~30 | ~100,920 | 0.015 |
| Roads at 45% of 308 cells (58×58 px tiles) | 139 | 467,596 | 0.069 |
| Buildings + cars, Task 2's seed | ~30 | small | ~0.01 |
| **Total** | | | **~0.24 ms** |

That is a model, not a measurement. Task 9's deploy is what measures it, and M0's fitted 10 Gpx/s is explicitly not a hardware ratio to carry to Android.

### 5. The camera fits the revealed 14×22 rect, with the insets and the HUD band subtracted first

The first draft contained three mutually exclusive cameras — Decision 5 fit the full 24×40 grid, Scope fit "the revealed grid", Task 2's coverage tested "the revealed grid". The full grid is unreachable: `floor(min(406/24, 870/40)) = 16` CSS px against spec §5.1's hard floor of **28 CSS px**, and 40 rows at 28 px needs 1,120 CSS px of height that no phone has. The premise the pan/zoom deferral rests on is false under that reading.

**M2 fits the revealed 14×22 rect** (spec §3 decision row 4, "~24×40 grid revealed from 14×22"). It has no representation in any code — `MapData` has `w`/`h` only and every "reveal" mention in `packages/` is a comment deferring it — so Task 3 freezes it as four integer constants in `shared`, centred: `REVEALED_X0 = 5`, `REVEALED_Y0 = 9`, `REVEALED_W = 14`, `REVEALED_H = 22`. **M1d owns making it dynamic**; when it does, the camera reads state instead of the constants and nothing else moves.

Worth knowing before authoring anything against it: on `firstCity` the revealed rect `x ∈ [5, 18]`, `y ∈ [9, 30]` contains the river (column 12, every row but 18 and 19, which are the bridgeable gap) and about eight trees, and **excludes the mountain cluster entirely** (rows 5–7, columns 3–4). So `TerrainClass.MOUNTAIN` is never exercised by a real M2 frame and is covered only by hand-built ones — a fact, not a defect, and one that would otherwise read as coverage.

```
availableW = cssW
availableH = cssH - topInset - HUD_BAND_CSS - bottomInset
tileSize   = floor(min(availableW / REVEALED_W, availableH / REVEALED_H))     // integer CSS px
```

- `topInset = max(contentSafeAreaInset.top, safeAreaInset.top)`, `bottomInset = safeAreaInset.bottom` — spec §8.3 requires **both** inset systems, and the lifted spike helper exposes only `contentSafeAreaInset.top`, so the lift gains a `safeAreaInset` reader.
- **The HUD band is subtracted before the fit, which is what makes the HUD non-overlapping by construction** rather than by hoping the letterbox is big enough. `HUD_BAND_CSS = 72`; the art pass may change the number, not the rule.
- The grid rect is centred horizontally and centred in what is left vertically. The leftover is background.

On the M0 device this gives **29 CSS px tiles** (width binds: `floor(406/14) = 29`), a 406×638 CSS grid rect. **On a 390 CSS px viewport it gives 27** — one below spec §5.1's floor, and this plan takes that rather than clamping to 28 and letting the outer columns overflow a viewport with no pan to reach them. §5.1's floor governs the zoom-out control that M2b ships; recording the 1 px shortfall is the honest reading, and M2b's zoom is what fixes it.

**One camera module owns both directions.** `screenToGrid` is the exact inverse of `gridToScreen`, they live in the same file in `render`, and `game/pointer.ts` imports the inverse rather than writing a second one. `game` already depends on `render`, so this inverts nothing.

**`screenToGrid` consumes CSS pixels and contains no DPR term.** Pointer events deliver CSS px in `clientX`/`clientY`, the tile size is an integer CSS px, and the canvas backing store is scaled once with `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` so all drawing is in CSS units too. The first draft's "drop the DPR divide" mutation was therefore not constructible against a correct implementation, and the bullet actively pushed an implementer to insert a DPR divide that is a real bug on every phone.

**The atlas rebuild is driven by measured tile size, and measurement is event-driven.** Spec §8.3: size against `viewportStableHeight`, re-layout only on `viewportChanged` where `isStateStable === true`, debounced. Measuring per frame is both a spec violation and a rebuild storm — 256 tiles re-rasterised on most frames of a sheet drag — and `getBoundingClientRect()` allocates a `DOMRect` per call, inside a loop this plan says allocates nothing. So: measure at boot, after the fullscreen settle, on stable `viewportChanged`, and on orientation change; cache the result; **rebuild only when the tile's device size actually differs from the atlas's.** A measurement that agrees costs nothing.

### 6. Cap the device pixel ratio at 2, and at 1.5 on `performanceClass === 'LOW'`

M0 §7's decision table has exactly one row marked **Adopt now**, and the first draft adopted none of it. It is this: *"the lever is DPR, not sprite count. Cap `devicePixelRatio` at 2 universally, 1.5 on `performanceClass === 'LOW'`"* — "~5 ms vs ~8.5 ms at 400 sprites, the difference between clearing and blowing the budget. Zero bytes, largest single lever available."

```
effectiveDpr(rawDpr, performanceClass) = min(rawDpr, performanceClass === 'LOW' ? 1.5 : 2)
```

On the one device M0 measured (DPR 3) the cap removes **55% of every fill, blit and clear** and takes the atlas from 7.75 MiB to 3.44 MiB at a 29 px tile. `performanceClass` is Android-only and is read from the **User-Agent, not a JS API** — `spike/src/deviceInfo.ts` already has `performanceClass(ua)` and the function is lifted. On iOS it is `null` and the universal cap of 2 applies. M0's own note is worth carrying: `LOW` means Exynos 850 tier, a much narrower population than "cheap phone", so the universal cap is the one doing most of the work.

**The cap is not free of consequence and the plan says so.** At DPR 2 a tile's device size `29 × 2 = 58` is an integer, so blits land on exact device pixels. At 1.5 it is 43.5, so the atlas is built at `floor(tileSize × dpr)` and blitted into a `tileSize` CSS-px destination rect — a resample, slightly soft, on the class of device that needs the pixels back. That trade is stated rather than discovered.

### 7. No shadows in M2 — and the accounting, so nobody puts them back by reflex

Spec §6 asks for one composited shadow layer, and the first draft defended it by explicit contrast with the road bake M0 deleted: *"unlike the road bake it is justified"*. **That contrast is backwards.** A full-canvas offscreen layer costs, per frame, one full-canvas **clear** plus one full-canvas **composite** — the clear was never charged at all.

| | Device px per frame | ms at 10 Gpx/s |
|---|---|---|
| M0's rejected road bake | 3,178,980 | 0.318 |
| Shadow layer, M0's regime (DPR 3, full grid) | 6,357,960 | 0.636 |
| Shadow layer, **M2's regime** (DPR 2, 406×870 CSS) | 2,825,760 | 0.283 |
| Shadow layer bounded to the grid rect, M2's regime | 2,072,224 | 0.207 |
| M2's **entire road layer** at 45% density | 467,596 | 0.069 |

The layer is **twice the cost of the thing M0 deleted** and, even bounded to the grid rect, **three times M2's whole road layer**, plus a second full-canvas surface (+12.13 MiB at M0's regime, +5.4 MiB at M2's) in a memory-constrained iOS WKWebView. The defence — "removes N alpha compositions" — prices as nearly free the thing M0 measured as nearly free: 500 shadow sprites drawn directly are ~415 kpx, ~0.04 ms, one fifteenth of the layer's own overhead.

Shadows are art-direction polish (spec §7.1), the art pass is already deferred, and this milestone's question is *"is this a game"*, not *"does it look right"*. So: **no shadow layer, and no per-sprite shadows either.** The deferred table owns them, this table is why, and reintroducing a full-canvas layer means redoing this arithmetic first.

### 8. Canvas access is injected, and the tests run in bare Node

The workspace has no jsdom, no `canvas`, and no vitest config file; every package's test script is a bare `vitest run` in Node, where `OffscreenCanvas` is `undefined`. The first draft's "Vitest + jsdom" stack does not exist and neither task that depended on it could run.

**`buildAtlas(createSurface, tileDevicePx)` takes a factory.** Production passes `document.createElement('canvas')`; tests pass a recording surface whose 2D context appends every path command and every state assignment to an array. `drawFrame(ctx, frame, atlas, palette)` likewise takes its context. Zero new dependencies, and the atlas is testable in bare Node.

**The fix list called this option "strongly preferred" two paragraphs after arguing that a recording stub cannot substitute because "the whole point is real ink". Three review lenses caught the contradiction, and they were right — so this plan drops "ink" as the abstraction, rather than keeping bullets a recorder cannot see.**

The atlas's decision content is *which segments it strokes for each mask, and with what stroke state* — and a recorder observes all of it directly: `moveTo`/`lineTo` coordinates, `lineWidth`, `lineCap`, `lineJoin`, the surface's width and height. A hand-written literal segment list for a handful of masks is a stronger assertion than "the ink is symmetric" and is not a reimplementation of anything. What a recorder genuinely cannot see is whether a browser rasterises those segments the way we expect — that is a browser property, not ours, and Task 9's deploy is the only check on it. Said here so nobody records it as covered.

### 9. Input is a pooled queue, drained after the tick loop

`step` takes `inputs: TickInputs = { readonly actions: readonly TickAction[] }` and `TickAction = { readonly kind, readonly a, readonly b }` — object types, in a loop this plan says allocates nothing. A drag allocates one object per tile entered plus a wrapper per tick unless something is done about it.

**Nothing in `sim` changes.** `game` owns a module-level pool of mutable action objects typed as `{ kind: TickActionKind; a: number; b: number }`, a module-level `actions` array, and one module-level `inputs: TickInputs = { actions }` — a mutable array is assignable to `readonly T[]`, and the `readonly` field modifiers do not stop the owner mutating through its own mutable-typed references, so no cast is needed. Enqueueing writes into a pooled object and pushes it; the pool grows only when a single tick's action count exceeds the high-water mark, which a drag bounds. An idle tick passes the same `inputs` object with `actions.length === 0`.

**The queue survives a zero-tick frame.** At 60 Hz half of all frames run zero ticks; at 120 Hz three in four do. The natural wrong implementation — build the actions from this frame's pointer events, pass them to whatever ticks run, discard — drops half to three quarters of a drag's segments. So: actions accumulate across frames; the queue is cleared **after** the drain loop, and only if at least one tick ran; within a catch-up burst the batch goes to the first tick and the remaining ticks run empty.

**The mutation "feed input to `step` twice" is a provable no-op and this plan does not use it.** `placeRoad` re-applied to an existing segment costs 0 tiles and performs only idempotent writes — roads.ts says so explicitly, and `canPlaceRoad` computes `cost = (maskA === 0) + (maskB === 0)`, which is 0 once both bits are set. `eraseRoad` re-applied returns `false` at the `(maskA & bitA) === 0` guard. The buffer is byte-identical, so no state hash, tile count or drawn frame can distinguish it. The mutations that *are* observable are named in Task 6.

### 10. A new Worker of our own, outside `spike/`

There is exactly one Worker config in the repo — `spike/wrangler.jsonc`, `name: laneways-spike`, with a D1 binding still accepting `POST /api/result` — and the Global Constraints forbid touching `spike/`. "Modify the existing Worker config" was therefore either forbidden by this plan's own rule or a repoint of the deployed M0 artefact.

`packages/game` owns its own `wrangler.jsonc` with its own name (`laneways`), its own `assets.directory`, **no `main` and no D1 binding** — it is a static-asset deploy; there is nothing to store until M3. `spike/` stays untouched and the deployed M0 artefact stays live at its own URL. `vite` and `wrangler` become devDependencies of `packages/game` (the root has neither; `spike/` is deliberately outside the workspace with its own lockfile), and both appear in Task 9's file list.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/render/src/types.ts` | `RenderFrame`, `Camera`, `Palette`, `TerrainClass`. **No imports at all** |
| `packages/render/src/camera.ts` | `fitCamera`, `gridToScreen`, `screenToGrid`, `hudRects`, `effectiveDpr` |
| `packages/render/src/palette.ts` | The theme object, frozen |
| `packages/render/src/atlas.ts` | 256-entry road tile atlas on one 16×16 surface; build, lookup, the dimension guard |
| `packages/render/src/canvas.ts` | `drawFrame` — terrain, roads, destinations, houses, cars, HUD |
| `packages/game/src/startingCity.ts` | The hand-authored seed. **M1e replaces this** |
| `packages/game/src/resolve.ts` | Sub-cell position resolver, prev/curr snapshots, the lerp and its one snap case |
| `packages/game/src/frame.ts` | Builds the `RenderFrame` each frame: terrain fold, building unpack, dense car array, HUD scalars |
| `packages/game/src/loop.ts` | Accumulator, clock reference, pause |
| `packages/game/src/inputs.ts` | The `TickAction` pool and the reused `TickInputs` |
| `packages/game/src/pointer.ts` | Pointer events → tiles → queued actions; drag walk, erase mode, cancel, HUD hit-test |
| `packages/game/src/telegram.ts` | Boot and viewport, lifted from `spike/src/telegram.ts` |
| `packages/game/src/deviceInfo.ts` | `performanceClass(ua)`, lifted from `spike/src/deviceInfo.ts` |
| `packages/game/src/main.ts` | Wiring, canvas creation, the entry point |
| `packages/game/index.html` | The shell — see Task 8 for what must be in it |
| `packages/game/vite.config.ts`, `wrangler.jsonc`, `public/_headers` | Build and deploy |

---

## Task 1: Two packages that are actually linted, typechecked, tested, and bounded

**Files:**
- Create: `packages/render/{package.json,tsconfig.json}`, `packages/game/{package.json,tsconfig.json}`, `packages/render/test/boundary.test.ts` (the import scan), `packages/game/test/toolchain.test.ts` (the eslint-coverage check for both packages), `packages/render/src/{index.ts,types.ts}` and `packages/game/src/index.ts` (stubs — later tasks fill them; both packages resolve through `"main": "./src/index.ts"`, as `sim` and `shared` already do)
- Modify: `eslint.config.js`

**No vitest config file is needed and none is added.** Vitest's defaults — Node environment, `**/*.test.ts` — are what `sim` and `shared` already run on, and Decision 8's injected factory is what keeps that true for a renderer. The first draft's "Vitest + jsdom" was a stack that does not exist in this workspace.

**What must NOT be done, verified:** there is no root `tsconfig.json` (only `tsconfig.base.json`) and no project references anywhere. `pnpm-workspace.yaml` already globs `packages/*`, so it needs no edit. The first draft scheduled both as modifications; one is a no-op and the other is a file that does not exist.

**What must be done and was unlisted:** `tsconfig.base.json` sets `"lib": ["ES2022"]` with no DOM. **Both** new packages override it with `"lib": ["ES2022", "DOM", "DOM.Iterable"]` — `render` needs `CanvasRenderingContext2D`, `game` needs `document`, `performance`, pointer events and `globalThis.innerHeight`. Both need `test` and `typecheck` scripts, because the root scripts run `pnpm -r --filter './packages/*'`.

**The eslint gap, verified by reading the config:** it contains exactly one `files:` block, scoped to `packages/sim/src/**` and `packages/shared/src/**`, and `tseslint.configs.recommended` is *inside* it. Adding two packages gives them **no linting at all**, and `pnpm lint` keeps exiting 0. That is this project's signature defect shape at the toolchain level: a check that appears to cover something and does not.

> A second `eslint.config.js` block covers `packages/render/src/**`, `packages/render/test/**`, `packages/game/src/**` and `packages/game/test/**` with `tseslint.configs.recommended` only. The `determinism/*` rules, `no-restricted-globals`, `no-restricted-properties` and `no-restricted-syntax` deliberately **do not** apply there: these packages are outside the determinism boundary by design (spec §4), they legitimately use floats, `document`, `performance` and `devicePixelRatio`, and `no-module-mutable-state` would forbid both the atlas cache Decision 4 requires and the action pool Decision 9 requires. The boundary is enforced instead by the one-way dependency direction and by the import scan below.

**Coverage required:**
- `ESLint.calculateConfigForFile` on one source file from each new package reports a config that includes the recommended TypeScript rules. *What else could make this pass:* the default config applying anyway — so also assert that the same call on a `packages/sim/src` file reports the `determinism/*` rules and the call on a `packages/render/src` file does **not**, which distinguishes "covered by the right block" from "covered by anything".
- A source scan over `packages/render/src/**` finds no import of `@laneways/sim` or `@laneways/shared`, matching `from '...'`, `import(...)` and `require(...)`. *Vacuity:* the scan must be shown to fail on a file that does import one — a fixture string, not a real file — and must assert it read a non-zero number of files, or an empty file list passes.

**Mutations:** point the new eslint block at a path that matches nothing; scope the import scan to a directory that does not exist; drop the DOM lib from one package's tsconfig (caught by `pnpm typecheck` once Task 3 lands, and stated here as the reason the DOM lib is in this task's file list rather than discovered in Task 3); omit the `test` script from a new package (caught by the root `test` script reaching it).

---

## Task 2: The hand-authored starting city

**Files:**
- Create: `packages/game/src/startingCity.ts`, `packages/game/test/startingCity.test.ts`

**Why this task exists, and why it is second.** `placeHouse` and `placeDestination` (buildings.ts:332, 422) have **no production caller anywhere in `packages/`**; buildings.ts's own module comment says building placement is "an explicit, out-of-band call the M1e spawner will eventually drive", and `step`'s seven phases contain no spawner. All four review lenses found this independently. Without it an M2 build renders terrain and roads and nothing else — no house, no destination, no pin, no car, no score — and the milestone's Goal is unreachable from the work the first draft assigned. It is second, not last, because it needs only `sim`, and every later task's fixtures get a real board instead of a hand-built one.

**What it is:** `seedStartingCity(state, world)` — a few houses and destinations at **hand-written literal cell coordinates**, placed once at startup, fully deterministic, no schedule and no RNG. **It is explicitly not M1e's authored spawner, and M1e replaces it.**

**The constraints the literals must satisfy**, all of them checkable and all of them enforced by `canPlaceHouse`/`canPlaceDestination` returning false rather than throwing:

- Every cell inside the revealed rect `x ∈ [5, 18]`, `y ∈ [9, 30]` — outside it, the building is invisible and the seed is a lie.
- Passable terrain (LAND or TREE is passable, but a standing tree rejects placement, so: LAND), no road, no overlap with another building.
- A destination's 6 footprint cells **and** its carpark must all be in bounds and passable; Chebyshev distance ≥ 2 between every cell of any two destinations' 7-cell sets.
- `firstCity`'s river runs down column 12 for every row except **18 and 19**, which are the two-cell bridgeable gap. A same-colour pair split across the river is only connectable through those two cells — a good thing to exercise deliberately, or to avoid deliberately, but not by accident.
- **At least one house and one destination of the same colour, connectable within `startingTiles = 30`.** A road path of N cells costs about N tiles (`cost = (maskA === 0) + (maskB === 0)`), so the pair must be within roughly 25 cells of path.
- `colour < world.map.groupCount` (5 for `firstCity`) — `placeHouse` asserts it.

**Coverage required:**
- Every `placeHouse`/`placeDestination` call returns `true`, asserted per call, not in aggregate. A silent `false` is exactly how a seed ends up half-placed.
- `H_HOUSE_COUNT` and `H_DEST_COUNT` equal hand-written expected values, and `hashState` after seeding is a **new golden** blessed in this task. It moves if the literals move, which is the point.
- **The end-to-end proof that the milestone's Goal is reachable, in `sim` alone:** seed, apply a hand-written list of `place` actions along a specific path from the house cell to the carpark, then `step` until `H_SCORE` increments, with a stated tick bound. Assert the score reached 1 and the bound was not hit.
- The tick bound is hand-derived, not guessed: the first pin cannot fire before `FIRST_PIN_DELAY_TICKS = 120` (`tick - destSpawnTick[d] >= 120`, and `destSpawnTick` is stamped at placement with `H_TICK = 0`), plus the pin accumulator reaching `PIN_PERIOD_TICKS = 518` at `slotCount` per tick, plus a round trip of `2 × Σ edgeCost(dir) × COST_UNIT_SCALE / 330` ticks — 7.576 ticks per orthogonal cell, 10.606 per diagonal.
- Re-running the seed on a fresh state produces an identical `hashState`. *What else could make this pass:* both runs failing identically — so this must be paired with the per-call `true` assertions above, which is why they are separate bullets.

**Vacuity self-checks:** the road path in the trip test must be one the *player* could draw — 8-adjacent pairs, within budget — or the test proves a trip is possible on a board the game cannot reach. Assert `tilesLeft(state) >= 0` after placement and that the number of `place` actions is ≤ `startingTiles`.

**Mutations:** move one house one cell so it lands on a destination footprint (`placeHouse` returns `false`; the per-call assertion is the only thing that sees it); give the house and the destination different colours (dispatch finds no route, the score stays 0); place the destination so its carpark is on water; shorten the tick bound below 120 + the accumulator delay.

**State in the module comment:** this seed is out-of-band and therefore **not in the input log**, so an M2 run is not replayable by a Worker. M2 submits nothing to a leaderboard, and M1e's in-`step` spawner is what restores replayability before M3 needs it. Recording it here is the difference between a known limitation and a discovered one.

---

## Task 3: The render interface, the palette, the camera, and the DPR cap

**Files:**
- Create: `packages/render/src/types.ts`, `src/palette.ts`, `src/camera.ts`, `test/camera.test.ts`
- Modify: `packages/shared/src/constants.ts` (the four revealed-rect integers, and nothing else)

`packages/shared/test/constants.test.ts` derives its registry from the module's real exports (`import * as C`, filtered to numbers), so four non-negative integers need no test edit and are automatically covered by its integer/finite/non-negative assertions. `MapData` is deliberately not touched: `mapIdHash` folds its fields into `mapIdentity[MI_MAP]`, so a new field there moves all four goldens at once.

**The interface, defined before anything draws.** Name every field and its type here; later tasks consume it verbatim.

```
RenderFrame:
  camera        Camera            tileSize (int CSS px), originX, originY, x0, y0, cols, rows, dpr
  gridW         number            board width, for y*w+x indexing into the board-indexed arrays
  roads         Uint8Array        board-indexed; the raw state.roads view
  terrainClass  Uint8Array        board-indexed; game's fold of world.terrain and state.cleared
  houseCount    number
  houseCell     Int32Array        raw view; only [0, houseCount) is read
  houseColour   Uint8Array        raw view
  destCount     number
  destCell      Int32Array        raw view
  destColour, destKind, destOrientation, destPins   Uint8Array   game-unpacked, dense
  destCarpark   Int32Array        game-computed via carparkCell, dense
  carCount      number            live cars only
  carXY         Float32Array      DENSE, 2 floats per live car, in grid-cell units
  carColour     Uint8Array        dense
  week, day, score, tilesLeft     number
  paused        boolean
```

Every array is preallocated once and rewritten in place. `render` reads `[0, count)` and nothing beyond it, which is what makes a phantom unrepresentable rather than merely undrawn.

**The palette** is spec §7.1's object — `{ background, land, water, mountain, tree, road, roadEdge, uiText, groups[] }` — frozen, with `tree` added (§7.1's list omits it) and `shadow` removed (Decision 7). Colours are preallocated strings, because `ctx.fillStyle = '#' + something` allocates a string inside the frame loop.

**The camera** is Decision 5's arithmetic, plus `gridToScreen`, `screenToGrid`, `hudRects` and `effectiveDpr`. This is the bug factory and it is tested with hand-computed literals in **both** directions.

**Coverage required:**
- `fitCamera` against hand-computed literals for at least: the M0 device (406×870 CSS, insets 46/34, HUD 72 → `tileSize = 29`, grid rect 406×638, originX 0), a 390×844 device (→ 27), and a case where **height binds instead of width** (a short wide viewport), or the `min` is untested in one of its two arms.
- `gridToScreen` for at least three hand-computed cells including `(x0, y0)` and `(x0 + cols - 1, y0 + rows - 1)`.
- `screenToGrid` for hand-computed CSS points: the centre of a known tile, and a point one CSS pixel inside each of that tile's four edges.
- A point above the grid rect, below it, and inside the HUD band each return "not a grid cell", distinguishably from each other where the caller needs to know.
- `hudRects` returns rects entirely inside the HUD band and entirely below the grid rect.
- `effectiveDpr`: `(3, null) → 2`, `(3, 'LOW') → 1.5`, `(1, null) → 1`, `(2.625, 'LOW') → 1.5`, `(1.25, 'LOW') → 1.25` — hand-written literals, including the case where the raw ratio is already below the cap.
- Round-trip `screenToGrid(gridToScreen(cell)) === cell` for every cell in the revealed rect. This is kept as a cheap extra and **explicitly not relied on**: it is self-inverse and survives any error applied consistently to a shared transform — a swapped axis, a dropped origin, a dropped `x0`. The hand-computed literals above are what actually constrain it.

**Vacuity self-checks:** the camera fixture must be non-square, must have `originX ≠ originY`, must have a non-zero canvas offset (`rect.left`/`rect.top`), and `REVEALED_X0 ≠ REVEALED_Y0` (5 vs 9, which they are) — otherwise a transposed axis, a dropped canvas offset or a dropped reveal origin all pass.

**Mutations:** drop the `x0`/`y0` reveal offset; drop the canvas `rect.left`; swap x and y; `round` instead of `floor` on the tile index; fit `REVEALED_W`×`REVEALED_H` as `h`×`w`; forget to subtract the HUD band before the fit (caught by the M0-device literal: 870 − 46 − 34 = 790, 790/22 = 35, and the tile would still be 29 because width binds — **so the height-binds fixture is the only one that can see it**, which is why it is required above); cap DPR at 2 unconditionally, ignoring `'LOW'`; use `Math.max` instead of `Math.min` in `effectiveDpr`.

---

## Task 4: The atlas

**Files:**
- Create: `packages/render/src/atlas.ts`, `test/atlas.test.ts`

`buildAtlas(createSurface, tileDevicePx)` renders 256 tiles keyed by the 8-bit neighbour mask onto **one 16×16 grid surface**, at `16 × tileDevicePx` on each axis. Stroke width 55–65% of the tile, round caps and joins (spec §6).

**The 1×256 strip is ruled out rather than left as a coin flip.** At M2's 58 device px tile a strip is 14,848 px wide, past every documented WebKit canvas dimension limit (4,096 on older iOS, 8,192–16,384 on current), where the result is a silently blank or downscaled backing store — spec §8.5's "iOS fails silently" class, invisible to every Node-side test and first visible as a black board after Task 9's deploy. A 16×16 grid is 928×928 at the same tile size. `buildAtlas` **throws a named error** if either dimension would exceed 4,096, converting a silent device-only failure into a loud one, in the idiom `assertSingleCrossing` and `assertDispatchProgress` already use here.

**Coverage required**, all against the recording surface of Decision 8, all over recorded commands and recorded state — not over ink:
- The recorded segment list for masks **0, 1, 5, 85, 170, 255** matches hand-written literal coordinates at a stated `tileDevicePx`. Mask 0 records no segments; mask 1 (N) records exactly one, centre to the top edge midpoint; mask 5 (N+E) records exactly two; 85 (`0b01010101`, the four orthogonals) four; 170 the four diagonals; 255 all eight. Verified against the real bit order (roads.ts:92-95 — bit *i* is direction *i*: N=0, NE=1, E=2, SE=3, S=4, SW=5, W=6, NW=7).
- All 256 recorded segment sets are pairwise distinct.
- `lineWidth` is between 55% and 65% of the tile size, and **changes when `tileDevicePx` changes** — a fixed width passes a single-size test.
- `lineCap` and `lineJoin` are both `'round'`, read off the recorded state assignments.
- The surface's width and height are both `16 × tileDevicePx`, and the tile at index *m* is written at `(m % 16, floor(m / 16))` in tile units — asserted for at least masks 0, 1, 16, 17, 255.
- A build at 4,096/16 + 1 px per tile throws the named dimension error; a build at exactly 4,096/16 does not. *What else could prevent the throw:* nothing else in the builder can fail at that size, but assert the error message names the dimension, so a different throw is not mistaken for this one.
- Two builds at the same `tileDevicePx` record identical command sequences.

**Deleted from the first draft, and why:** the symmetry bullet and its vacuity check contradicted each other — both of the masks it named (N+S = 17, E+W = 68) are symmetric under *both* axes, so an implementer following the coverage bullet literally writes a fixture the vacuity check forbids, and a blank tile passes. Rather than replace the example, the bullet is gone: symmetry was a proxy for "the right spokes are drawn", and the hand-written literal segment list says that directly, with no proxy and no vacuity condition to get wrong.

**Mutations:** return the same tile offset for every mask; ignore the mask's diagonal bits; swap the N and S bits; off-by-one the tile index within the grid; skip the `tileDevicePx` scale (caught by the surface-dimension bullet *and* the `lineWidth`-varies bullet, which are independent); use a fixed stroke width; use butt caps; drop the dimension guard.

---

## Task 5: Drawing

**Files:**
- Create: `packages/render/src/canvas.ts`, `test/canvas.test.ts`

`drawFrame(ctx, frame, atlas, palette)` implements Decision 4 against a recording context. It reads `frame` and nothing else — no globals, no `sim`, no `shared`.

**Draw order is load-bearing and must be asserted:** top band fill → grid land fill → non-land terrain → roads → destination footprints and carparks → houses → cars → HUD band fill → HUD content. Buildings above roads, because a road is legal on a house cell and on a carpark cell and would otherwise cover them. Cars above buildings, because a car drives onto the carpark.

**Coverage required:**
- The recorded call sequence matches the stated order.
- **No `clearRect` is issued anywhere** (Decision 4), and the three opaque fills together cover the canvas exactly: their rects tile the full backing store with no gap and no overlap, asserted arithmetically against the camera.
- A car at grid position `(x0 + 3.5, y0 + 7.25)` draws at a hand-computed CSS pixel coordinate. This is a pure transform assertion with **no notion of alpha in `render` at all** — `game` resolved the position before the frame was handed over.
- A frame with `carCount = 2` but a `carXY` array sized for 8 draws exactly 2 cars, and draws nothing at the pixel corresponding to grid cell `(x0, y0)` where the dead slots' coordinates were deliberately placed. Same shape for `houseCount` and `destCount`. **The dead slots must sit *inside* the revealed rect**, because the sim's real dead value is cell 0, which is outside it, and the bounds check would otherwise be what makes the test pass.
- A cell with `terrainClass = LAND` draws the land colour and no tree; the same cell with `TREE` draws a tree. (The fold itself is Task 6's — this is the drawing half.)
- Only cells inside the revealed rect are drawn: a road mask set on a cell outside it produces no atlas blit. *What else could prevent the blit:* an empty mask — so the fixture must set a **non-zero** mask on the out-of-rect cell and a non-zero mask on an in-rect cell, and assert the count of blits is exactly one.
- The HUD renders `week`, `day`, `score` and `tilesLeft` from the frame, in `hudRects`' rectangles.

**Vacuity self-checks:** the frame must contain at least one house, one destination, one car and one road cell, or the order assertion is vacuous. The road cell's mask must be non-zero. At least two distinct `terrainClass` values must appear.

**Mutations:** draw cars before roads; draw houses before destinations; issue a `clearRect` (caught by the no-`clearRect` bullet, which exists because the mutation is *free* — it looks like defensive hygiene and costs a full canvas pass); iterate `carXY.length / 2` instead of `carCount`; iterate the whole board instead of the revealed rect; read `terrainClass` with the wrong stride; drop the HUD band fill (caught by the coverage-tiling bullet).

---

## Task 6: The loop, position resolution, interpolation, and the input pool

**Files:**
- Create: `packages/game/src/loop.ts`, `src/resolve.ts`, `src/inputs.ts`, `src/frame.ts`, `test/loop.test.ts`, `test/resolve.test.ts`, `test/frame.test.ts`

**The loop** is Decision 1's accumulator, driven by an injected clock so tests control time exactly. It never calls `step` with a fractional argument, resets `lastTime` on the first frame and on resume, and clears the action queue after the drain.

**Resolution and interpolation** are Decision 2. `resolve.ts` owns the sub-cell resolver, the `prevXY`/`currXY`/`prevLive` snapshots, and the lerp.

**`frame.ts`** is Decision 3's adaptation: the terrain fold, the destination unpack, the dense car array, and `week = weekOfTick(H_TICK)` / `day = dayOfWeek(H_TICK)` **called from `sim`**. The HUD owns no clock arithmetic of its own — `clock.ts` already derives the day from position within the week precisely because 4500/7 is not an integer, and a second float-permitted copy in `game` would disagree at boundaries. This also retires the first draft's `TICKS_PER_DAY` mutation, which is not constructible once the sim's function is called and, applied literally, divides by 0 to produce a constant day 0 — a crash-shaped mutant, not an off-by-one.

The terrain fold and the building unpack are recomputed **every frame**: 960 byte writes and ≤56 building unpacks, allocation-free, and they cannot go stale. A dirty-flag scheme would be cheaper and would have a staleness bug waiting for the first mid-run building change; the cost is not worth the class of defect.

**Coverage required — the loop:**
- The tick counts and alphas of Decision 1's table, each as its own case, including the 100 ms → **2** case with `alpha ≈ 0.9999999999999996` and the 16.7 ms → `0, 1, 0, 1` alternation with its four hand-computed alphas. The near-1 alpha is the point of the 100 ms case, not an accident of it.
- A 5,000 ms frame from a fresh accumulator runs 7 ticks; **the same frame after a 20 ms frame runs 8.** This pair is the only fixture that distinguishes clamping `rawDt` from clamping the accumulator: from a fresh loop both produce 7 ticks and an identical residual (verified by execution), so the first draft's fixture disarmed its own mutation.
- `alpha ∈ [0, 1)` after every frame in a long randomised-durations run, with the near-1 case in the table as the one that would break first.
- The first frame after start runs 0 ticks (the clock reference is initialised, not left at 0).
- A 2,000 ms **pause** resumes with 0 or 1 ticks; a 2,000 ms **stall** runs exactly 7. Neither alone is discriminating: freezing the accumulator without resetting the clock reference passes the stall bullet and fails the pause bullet, which is the whole point of stating both.
- An action queued during a frame that ran **zero** ticks is applied on the next tick that runs — observed as the road existing in `state.roads` and `H_TILES` decremented exactly once.
- **Allocation, stated as what it actually is:** across 1,000 frames with a live drag, the `TickInputs` object passed to `step` is identity-equal every time, and every `TickAction` in it is identity-equal to one previously seen. This kills "allocate a fresh action per event" and "allocate a fresh wrapper per tick" — the two allocations that exist here — and it does **not** prove global allocation-freedom. There is no allocation profiler in this toolchain and a `process.memoryUsage()` delta across 1,000 frames is dominated by GC timing; the first draft asserted the property was unmeasurable in one section and required a test for it in another.

**Coverage required — resolution:**
- A car with `carProgress = 0` and one with `carProgress = 1250` on the same orthogonal edge resolve to the cell centre and to exactly half a cell along `(DX, DY)`. Hand-computed.
- A car on a **diagonal** edge with `carProgress = 1750` resolves to `(cx + 0.5, cy + 0.5)`: threshold 3,500, not 2,500. A resolver that hard-codes the orthogonal threshold passes every orthogonal case.
- A `PHASE_RETURNING` car resolves using `OPPOSITE[routeStep(cursor - 1)]`. *What else could produce the right answer:* on a straight route the outbound and return directions at the same cursor are opposite anyway, so the fixture's route must **turn**, and the assertion must be at a cursor where `routeStep(cursor)` and `OPPOSITE[routeStep(cursor - 1)]` genuinely differ. Without that, `routeStep(cursor)` passes.
- A `PHASE_IDLE` car resolves to its cell; a `PHASE_NONE` slot is not live.
- An exhausted-cursor car (`cursor === routeLen` outbound, `cursor === 0` returning) resolves to its cell and does **not** throw.

**Coverage required — interpolation:**
- **Two frames within the same tick render different positions.** This is the only observable that separates interpolated rendering from tick-quantised rendering, and it is the only one that kills "pass `alpha = 0` always" — with progress-resolved positions a car is strictly between two cells on roughly seven ticks in eight regardless of alpha, so "drawn between two cells" and "≥10 distinct positions" both survive that mutation. It is also the only observer of "snapshot prev *after* `step`", which collapses `prevXY` onto `currXY` and makes the lerp constant within a tick.
- A car mid-route at `alpha = 0.5` renders at the exact midpoint of its prev and curr resolved positions, hand-computed, on a tick where `carCell` did **not** change. That is the 86.8% case the first draft's vacuity check steered away from by demanding prev and curr cells differ.
- A car crossing a cell boundary within the tick renders continuously: at `alpha = 0` it is at prev, at `alpha → 1` at curr, and the path between them crosses the boundary once.
- **Frame 1 with a properly initialised `prevXY` draws each car at its house**, not partway to grid cell (0, 0). *What else could make this pass:* a house that happens to be near (0, 0) — so the seeded city's houses must all be well inside the revealed rect, which Task 2 already requires.
- A house placed mid-run: its new cars render at the house on the very next frame at `alpha = 0.5`, not lerping in from a stale prev.
- A round trip driven through the real sim (Task 2's seed): the resolved position sequence has no gap larger than 0.14 cells between consecutive ticks, across dispatch, the flip and trip end. This is the assertion that would have caught the first draft's imaginary teleports, and it is the one that keeps Decision 2's table honest if a constant changes.

**Mutations:** write `TICK_MS = 33`; clamp `rawDt` after accumulating instead of before; `>` instead of `>=` in the drain; let alpha reach 1.0; reset the accumulator instead of the clock reference on resume; leave `lastTime = 0` at start; snapshot prev *after* `step`; use the outbound direction on the return leg; use the orthogonal threshold for diagonals; lerp a slot that was not live in prev; leave `prevXY` zero-initialised; clear the action queue before the drain rather than after; **never clear the action queue at all** — observable only through place-at-tick-T, erase-at-tick-T+40, keep stepping: the stale place action resurrects the road at T+41. A place-only fixture cannot see it, because re-placing is byte-identical (Decision 9).

---

## Task 7: Input — drag, erase mode, pause, and the HUD hit-test

**Files:**
- Create: `packages/game/src/pointer.ts`, `test/pointer.test.ts`

Pointer events → tile coordinates (via `render`'s `screenToGrid`, Decision 5) → queued `TickAction`s (via Decision 9's pool). Erase is a **mode toggle**, never a tap or long-press (spec §7.3 — the most important mobile lesson available). Pause is one tap on the HUD clock.

**The hit-test order is a decision, not a detail.** The HUD is drawn on the same canvas, and every canvas point maps to a tile, so without an ordering a tap on pause also lays a road. Order: HUD rects first, then the grid rect, then nothing. Decision 5's fit puts the HUD band entirely outside the grid rect, so the two never overlap — but the ordering is asserted anyway, because the *reason* they do not overlap lives in `fitCamera` and a change there must not silently make the board eat pause taps.

**Spec §7.2 puts the clock at the top; spec §8.3 forbids any interactive element in the top band.** M2 resolves that contradiction toward §8.3, because it is a platform fact and §7.2 is a preference: all three HUD elements live in the **bottom** band, thumb-reachable, and the top band gets nothing at all. The clock is still always-expanded and still doubles as pause.

**A fast drag skips tiles, and `placeRoad` drops non-adjacent segments silently.** `canPlaceRoad` returns `not-adjacent` whenever `dirBetween(a, b, w, h) === -1` — any pair more than one cell apart on either axis — and `step` ignores the return value. At 27–29 CSS px tiles a finger at ordinary speed crosses several tiles between `pointermove` samples, so the visible symptom is a road with holes that appears only when the player draws fast: the core mechanic degrading exactly when it matters. **The drag emits one action per cell entered along an 8-connected walk between consecutive samples** (step by `sign(dx)`, `sign(dy)` toward the target until it is reached), so every emitted pair is adjacent by construction.

**Platform behaviours, none of which the first draft mentioned:** `touch-action: none` and pointer capture on the canvas (Task 8 owns the CSS); a `pointercancel` path, because Telegram's swipe, an incoming call or a system gesture fires cancel rather than up, and a drag state machine with no cancel branch latches and keeps laying road from an abandoned cell on the next tap; and a single-pointer rule — the first pointer down owns the drag and every other `pointerId` is ignored until it ends, because pan/zoom is deferred and a naive per-pointer handler opens a second concurrent drag.

**On a client below 7.7, `disableVerticalSwipes()` is a silent no-op and Telegram's swipe-to-close stays live**, so a downward road-drawing drag can dismiss the Mini App mid-stroke. Spec §8.3 explicitly forbids the legacy workarounds (fixed body, blanket `preventDefault` on `touchmove`) — they are the approach reported broken and they break legitimate scrolling. M2's answer is `touch-action: none` plus pointer capture **on the canvas only**, which is the supported mechanism, and on a 7.6 client that is the whole of the mitigation. Stated rather than left as a surprise.

**Coverage required:**
- A tap at a hand-computed CSS point inside tile `(8, 14)` on a letterboxed canvas with a non-zero `rect.left` produces exactly that tile.
- A tap above the grid rect produces no action; a tap in the HUD band produces the HUD action and no board action.
- A drag across three adjacent tiles produces two `place` actions with the right endpoints, in order.
- A drag that re-enters the tile it is already on produces no duplicate action.
- **A pointer jump of (+3, +1) tiles produces three actions whose cells form a contiguous 8-adjacent chain from the previous cell to the new one**, and every action's pair satisfies `|dx| ≤ 1 && |dy| ≤ 1`. *Vacuity:* the jump must be neither purely orthogonal nor purely diagonal, or an axis-swapped or diagonal-only walk passes.
- Erase mode produces `erase` actions and never `place`; toggling back produces `place` again.
- A `pointercancel` mid-drag ends it: the next `pointermove` at a distant tile produces no action. *What else could prevent the action:* the pointer being up — so the fixture must send a `pointermove` with no intervening `pointerdown`, and separately assert that the same `pointermove` after a `pointerdown` *does* produce one.
- A second `pointerId` during an active drag produces nothing, and releasing it leaves the first drag working.
- Pause: tapping the clock rect toggles `paused`; board input while paused produces no action (the deferred-table decision, asserted so it is a rule rather than an accident).

**Vacuity self-checks:** the canvas fixture must be non-square, letterboxed on both axes with `originX ≠ originY`, and offset from the viewport origin. The drag fixture must change direction at least once, or a transposed axis passes.

**Mutations:** drop the canvas `rect.left`; drop the reveal origin; swap x and y; `round` instead of `floor`; emit one action per pointer sample instead of per cell entered; let erase mode emit `place`; skip the grid-bounds clamp; hit-test the board before the HUD; drop the `pointercancel` branch; drop the single-pointer rule; accept board input while paused.

---

## Task 8: The Telegram shell — boot, the HTML, sizing, and the rebuild trigger

**Files:**
- Create: `packages/game/src/telegram.ts`, `src/deviceInfo.ts`, `index.html`, `test/telegram.test.ts`
- Copy from (do not modify): `spike/src/telegram.ts`, `spike/src/deviceInfo.ts`, `spike/index.html`

**The boot order is exact and was established by M0** (spec §8.2): `ready()` → `expand()` → `disableVerticalSwipes()` (7.7+) → `requestFullscreen()` + `lockOrientation()` (8.0+) → only then size the canvas.

**Two of the four calls have no version gate, correctly, and the first draft asked for coverage that cannot be written.** Verified in `spike/src/telegram.ts:82-90`: `ready()` and `expand()` pass no `minVersion` because both are 6.0 baseline. The claim is therefore "every call that *needs* a gate is gated", and the gate coverage scopes to the two real gates.

**Three lift hazards, all verified:**
- **`atLeast()` is the exported helper; `isVersionAtLeast` is only reachable inside the private `webApp()` wrapper.** A test stub must install `globalThis.Telegram.WebApp.isVersionAtLeast`, not stub an importable symbol — stubbing the wrong one produces a test that passes and proves nothing.
- **`atLeast` returns `false` when `isVersionAtLeast` is absent**, so a single "old client" fixture suppresses everything past `expand()` and cannot distinguish the 7.7 gate from the 8.0 gate. Each gate needs its own reported version.
- **`telegram.ts` imports `type { CloudLike } from './cloudProbe'` and exports `cloudStorage()`.** M2 defers persistence to M3, so the lift drops both rather than dragging `cloudProbe.ts` into `packages/game`. The lift **adds** a `safeAreaInset` reader (spec §8.3 requires both inset systems and the spike exposes only `contentSafeAreaInset.top`) and an `onViewportChanged(handler)` subscription.

**Sizing is two passes, and the second is measured spike behaviour rather than a precaution.** `spike/src/main.ts` sets a placeholder height at module eval and re-reads `contentSafeAreaTop()` only after three `requestAnimationFrame`s, with a comment saying why: at that point `requestFullscreen()` had only just been called and the client had not yet published the real inset. So: size provisionally right after `boot()` returns, treat it as a guess, and re-measure after the settle. Then keep measuring on stable viewport events (Decision 5) — never per frame, never on a raw resize event, and never against `viewportHeight`.

**The atlas rebuild is driven by the tile's device size changing**, so a re-measure that agrees costs nothing and a rebuild storm cannot happen. "Rebuild at the same size is idempotent" is **not** the guard for this — a storm is idempotent too. The guard is a rebuild *count*.

**The HTML shell is not "the shell".** It owns, and each of these fails silently without it:
- `<script src="https://telegram.org/js/telegram-web-app.js">`. Without it `globalThis.Telegram` is undefined, `atLeast()` returns `false`, `call()` early-returns, and **the entire boot sequence no-ops with no error** — the game still renders, so it looks like it works, and every planned test stubs the very object production is missing.
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">`.
- `touch-action: none` on the canvas, `overscroll-behavior: contain` (spec §8.3), `height: var(--tg-viewport-stable-height, 100vh)` because plain `100vh` is unreliable in the webview.
- The background colour, so the letterbox is not white while the board is dark.
- All assets self-hosted and no cross-origin CDN beyond the Telegram SDK itself (spec §8.5: iOS fails silently on asset load errors).

**Coverage required:**
- The boot sequence calls in exactly the stated order, on a recording stub installed at `globalThis.Telegram.WebApp`.
- The 7.7 gate: `disableVerticalSwipes` is called on a client reporting 7.7 and not on one reporting 7.6. The 8.0 gate: `requestFullscreen` and `lockOrientation` on 8.0, neither on 7.9. Four cases, two fixtures each with its own reported version.
- `boot()` on a client with **no** `Telegram` object at all completes without throwing and calls nothing.
- Canvas sizing happens after the last boot call, and a second measurement happens after the settle.
- **A boot where the second measurement differs from the first rebuilds the atlas exactly once; a boot where they agree rebuilds zero times.** The second is the vacuity guard — without it, "always rebuild" passes.
- Ten stable viewport events reporting the same height rebuild the atlas zero times; one reporting a height that changes the tile size rebuilds it once. Asserted as a **count**.
- A `viewportChanged` with `isStateStable === false` triggers no re-measure.
- The shipped `index.html` contains the Telegram SDK script tag, the viewport meta, `touch-action: none` and `overscroll-behavior: contain` — a text assertion on the real file, in the idiom `loop.test.ts` already uses to pin the goldens. *Vacuity:* assert the file's length is non-trivial, or an empty file trivially fails to contain anything else either.

**Mutations:** size the canvas before `expand()`; drop the second measurement; drop the 7.7 gate; call `disableVerticalSwipes` unconditionally; rebuild the atlas on every measurement; rebuild on `isStateStable === false`; drop the SDK script tag from `index.html`; read only `contentSafeAreaInset` and ignore `safeAreaInset`.

---

## Task 9: Wire it, play it, deploy it

**Files:**
- Create: `packages/game/src/main.ts`, `test/integration.test.ts`, `vite.config.ts`, `wrangler.jsonc`, `public/_headers`
- Modify: `packages/game/package.json` (add `vite` and `wrangler` devDependencies, and `build`/`deploy` scripts)

Assemble: create the canvas, boot Telegram, size, build the world and state (`createWorld`, `createState`, `createScratch`, `createFlowFields` — `step` takes five arguments), **seed the starting city (Task 2)**, build the atlas, run the loop, feed input, draw.

**The end-to-end test drives the real loop headlessly** — an injected clock, synthetic pointer events in, a recording context out — over Task 2's seeded city, and asserts a full trip is visible.

**Guard it against becoming a smoke test**, the way M1b's golden nearly was and M1c's brief caught. The first draft's four guards were checked against its own mutation list and **three of the four mutations survive all of them**, so the guards are rewritten around what each mutation can actually change:

- Roads placed > 0, and `H_TILES` decreased by the expected amount.
- Score strictly increased.
- **One frame's drawn car position asserted against a hand-computed absolute value** — the tick, the alpha and the resolved endpoints all named. Every property-shaped assertion (monotone advance, strictly between two cells, ≥10 distinct positions) survives a uniform one-tick offset, which is exactly what "draw before stepping" produces. An absolute value does not.
- **Two frames rendered between the same pair of ticks draw the car at different positions** — the only guard that kills `alpha = 0` (Task 6 states why).
- The drawn car position advances monotonically along the route, and ≥10 frames differ. Kept, and explicitly labelled as the weak pair: they exclude a frozen renderer and nothing else.

**Coverage required:** the above; a 2,000 ms stall runs 7 ticks and the run continues correctly afterwards; a viewport change that alters the tile size rebuilds the atlas and the next frame draws at the new tile size; `pnpm test`, `pnpm typecheck` and `pnpm lint` at the repo root all reach both new packages and pass.

**Deleted from the first draft:** "the sim's four goldens are unchanged by anything in `game` or `render`". `packages/sim/test/loop.test.ts:777-790` already reads `determinism.test.ts` and `rollback.test.ts` off disk and asserts the literals, with its own vacuity guards, on every `pnpm test` run. There is no code path by which the new packages could move a sim golden, so the assertion cannot fail — and any implementation of it in `game` is either a duplicate of sim's suite or a cross-package `readFileSync` with a relative path. The Global Constraint stands; it is not coverage. What replaces it is the workspace bullet above: the root scripts pick up two new packages **without shadowing the existing ones**, which is a real risk and was unstated.

**Mutations:** never rebuild the atlas on a tile-size change; draw before stepping; pass `alpha = 0`; skip `seedStartingCity`; pass the same action batch to every tick of a catch-up burst. **Not used:** "feed input to `step` twice" — Decision 9 shows it is byte-identical by `placeRoad`'s documented idempotence, and recording it as a kill would be the catalogue's fake-kill shape.

**Deploy.** `packages/game/wrangler.jsonc` is a new Worker, `name: laneways`, static assets only, no `main`, no D1. `spike/` is not touched and `laneways-spike` stays live. `public/_headers` carries `Cache-Control: no-store, must-revalidate` on `/` and `/index.html` (spec §8.5 — Telegram Desktop caches Mini App bundles somewhere its own cache-clear does not reach), and Vite content-hashes the asset filenames.

**Verify the artefact, not the command's exit message.** The check needs a token that is unique **by construction**: Vite injects a build id at bundle time, and the deploy step fetches the live URL through the same path a client would and asserts that exact id is present. Grepping for "a string from this build" is not a check — a string that also existed in the previous build passes on a stale asset, which is the failure being guarded against. (The first draft attributed this practice to an M0 incident; that incident is not recorded anywhere in the M0 findings, so the practice is kept and the anecdote is dropped.)

---

## What this plan does not settle, deliberately

- **Frame budget on a real device is unmeasured for this workload.** Decision 4's ~0.24 ms is a model built on M0's fitted 10 Gpx/s and 0.16 µs/call — a fit for one iPhone's workload, which M0 explicitly says is not a hardware ratio to carry to Android. Task 9's deploy is what makes it measurable; expect a tuning pass.
- **`performanceClass` is Android-only and reads `null` on every iOS device**, so the 1.5 cap is untested on hardware and will stay untested until someone runs the deploy on a `LOW` Android. M0 could not obtain one either. The universal cap of 2 is the part that is doing the work.
- **The palette is a placeholder.** Art direction (spec §7.1) is a separate exercise, and spec §7.4's colour-accessibility work — separating groups on lightness as well as hue, running the palette through deuteranopia and protanopia simulators as a build step — is not in M2. M2 ships legible pastels and a `Palette` object to replace.
- **The starting city is out-of-band and therefore not replayable.** M2 submits nothing to a leaderboard. M1e's in-`step` spawner is what makes a run reproducible from `(seed, mapId, actions)` again, and M3 depends on it having happened.
- **Nothing here is tested on a real phone until Task 9 deploys.** The tests pin call sequences, recorded geometry and resolved coordinates, not pixels — and no Node-side test can see a canvas that a WebKit build silently refuses to allocate. Task 4's dimension guard is the one place that failure mode is converted into something loud.
