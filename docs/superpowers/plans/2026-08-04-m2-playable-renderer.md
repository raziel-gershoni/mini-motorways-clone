# M2: the thin playable renderer — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing simulation visible and playable on a phone — draw a road with your finger, watch a car take it, see the score tick.

**Architecture:** Two new packages. `render/` is Canvas2D behind a narrow interface that reads preallocated typed arrays and never writes sim state. `game/` is the glue: a fixed-timestep loop at 30 Hz with render interpolation, input→`TickAction`, a three-element HUD, and the Telegram adapter lifted from the M0 spike. Dependency direction stays one-way (spec §4).

**Tech stack:** TypeScript, Canvas2D, no runtime dependencies, Vite for the app bundle, Vitest + jsdom for tests, `wrangler` for deploy to the existing Worker.

---

## Global Constraints

- **Zero runtime dependencies** in `render` and `game`, as in `sim` and `shared`.
- **`render` never writes sim state.** It receives readonly views and primitives. Enforced by a source scan, not by convention.
- **`sim` stays untouched by this milestone** except where a task explicitly says otherwise. All four goldens must hold: state `2413319809`, road-network `2790151213`, field `252514232`, loop `3896659943`. **If any moves, stop and report — do not re-bless.**
- **Nothing allocates inside the frame loop.** Same rule as the tick, same reason, same enforcement (construction and review; there is no allocation profiler). This includes the sim→render adaptation: it writes into preallocated arrays.
- Integer-only applies to `sim` only. `render` and `game` may use floats — they must never feed one back into `sim`.
- Cell index convention is `index = y * w + x`.
- The sim runs at **`TICKS_PER_SECOND = 30`**; `TICKS_PER_WEEK = 4500`; `SECONDS_PER_WEEK = 150`.
- Do not modify `spike/`. Lift code from it by copying, and say so.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## Scope

**In:** the road tile atlas, terrain/road/building/car drawing, the shadow layer, a fixed camera fitting the revealed grid, tile-snapping draw and erase, pause, a three-element HUD, the fixed-timestep loop with interpolation, the Telegram boot sequence, and a deploy.

**Out, and named so nobody reads the gap as an oversight:**

| Deferred | Owner | Why |
|---|---|---|
| Pan and zoom, auto-zoom on draw start | M2b | The whole revealed grid fits a portrait viewport at M2's fixed camera. Pan/zoom is the single most dangerous input feature on touch (spec §7.3) and deserves its own task, not a corner of this one |
| Upgrade-card modal, inventory chip row | M1e | Nothing to choose or spend yet |
| Audio | Later | |
| Motorways, bridges, roundabout art | M1d/M1e | The mechanics do not exist |
| Telemetry overlay | M1e | Wanted for tuning, but tuning needs M1d's blocking first |
| Persistence (CloudStorage save/resume) | M3 | M0 established the storage design; nothing to save until a run can end |

**M2 is deliberately not a complete game.** Cars pass through each other (M1d), a run never ends (M1e), and nothing is saved (M3). It is the first build where the simulation is observable, and its job is to make the next three milestones debuggable and the balance constants tunable.

---

## Six design decisions

### 1. Fixed timestep at 30 Hz, render at display rate, interpolate positions

The sim is 30 Hz and integer. Displays are 60 Hz or 120 Hz. Rendering only on tick boundaries is visibly choppy, and smooth car motion is most of this genre's feel.

The loop is the standard accumulator:

```
accumulator += min(rawDt, MAX_FRAME_DT)
while (accumulator >= TICK_MS) { snapshotPrev(); step(...); accumulator -= TICK_MS }
alpha = accumulator / TICK_MS
render(alpha)
```

**`MAX_FRAME_DT` is 250 ms**, the same clamp the M0 spike used, and it exists so a backgrounded tab does not run a thousand catch-up ticks on resume.

**The clamp must not feed the sim.** The sim advances in whole ticks or not at all; the clamp only bounds how many. This is why the accumulator is real-valued and `step` is not — a float never crosses the boundary.

### 2. Interpolation must snap, not lerp, across discontinuities

A car that completes a trip is teleported home (`carCell = houseCell[carHome]`). A car that flips `OUTBOUND → RETURNING` reverses direction. Lerping across either draws a car streaking across the map.

**Rule: interpolate only when the car's `carPhase` is unchanged between prev and curr AND its interpolated distance is under one cell.** Otherwise snap to the current position. The distance guard is the load-bearing half — phase is unchanged on an ordinary trip-end-to-idle-to-redispatch within one tick, and a phase check alone would miss it.

**Coverage this needs:** a car that completes a trip renders at its house on the arrival frame and never between the destination and the house; a car crossing the outbound→return flip renders at the carpark, not mirrored across it; an ordinary mid-route car *is* interpolated, at a position strictly between its prev and curr cells at `alpha = 0.5`. That third one is the vacuity check — without it "always snap" passes the first two.

### 3. The renderer takes typed arrays, not `GameState`

Spec §4 says `render` depends on nothing but its own interface types, while also reading sim state. Both hold if `render`'s API accepts the raw views — `Uint8Array` of road masks, `Int32Array` of car cells — rather than the `GameState` object.

This is what makes "swapping in Pixi is a one-file change" true rather than aspirational, it lets `render` be tested with hand-built arrays and no sim at all, and it keeps the adaptation allocation-free because there is nothing to adapt.

### 4. Draw road tiles per frame from a 256-entry atlas. Do not bake

**[M0]** — and the spec bullet telling you to bake has been struck through with its measurements, because it inverts the intuition. Baking composites **3.2× the pixels** to draw the same roads (3,178,980 device px against 995,328), crossover is at **85% road density** against our measured **45%**, and the core mechanic *is* drawing roads — so every frame of a drag would pay re-render + offscreen clear + blit, **4.8× the per-frame path**.

Pixel throughput binds at roughly **10 Gpx/s**; a `drawImage` costs about **0.16 µs**. Optimise pixels, not calls.

**The atlas stays and is the reason the per-frame path is cheap:** 256 entries keyed by the 8-bit neighbour mask, pre-rendered once at device pixel ratio, rebuilt only when tile size or DPR changes.

### 5. Integer tile size, fixed camera

Tile size is `floor(min(cssW / GRID_W, cssH / GRID_H))`, floored to an integer CSS pixel so atlas blits land on exact device pixels at integral DPR and stay crisp. The grid is centred; the leftover is letterbox.

No pan, no zoom in M2. The whole 24×40 grid fits a portrait phone at this size (M0 measured 16 CSS px tiles on the test device).

**This is why the atlas must be rebuilt on resize**, and why the rebuild must be driven by *measured* tile size rather than a resize event — Telegram's viewport changes for reasons other than rotation (`viewportStableHeight`, the app bar).

### 6. One shadow layer, composited once

All shadow shapes go into one offscreen canvas as opaque black at a fixed offset, then that whole layer composites once at 10–14% alpha. This reproduces non-additive overlap exactly for one extra blit. **Never alpha-stack per-sprite shadows** — overlapping shadows darken and the flat art reads as broken.

This is the one offscreen surface M2 keeps, and unlike the road bake it is justified: shadows are drawn per sprite either way, so the layer adds one blit and removes N alpha compositions.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/render/src/types.ts` | The interface: `RenderFrame`, `Camera`, `Palette`. No imports from `sim` |
| `packages/render/src/atlas.ts` | 256-entry road tile atlas; build, rebuild, lookup |
| `packages/render/src/canvas.ts` | The Canvas2D renderer implementing the interface |
| `packages/render/src/shadow.ts` | The composited shadow layer |
| `packages/render/src/palette.ts` | The theme object, frozen |
| `packages/game/src/loop.ts` | Fixed-timestep accumulator, interpolation alpha |
| `packages/game/src/interpolate.ts` | Prev/curr car snapshots and the snap rule |
| `packages/game/src/input.ts` | Pointer events → tile coords → `TickAction[]` |
| `packages/game/src/hud.ts` | Week/day clock, score, tiles-left |
| `packages/game/src/telegram.ts` | Boot sequence, lifted from `spike/src/telegram.ts` |
| `packages/game/src/main.ts` | Wiring, canvas creation, the entry point |
| `packages/game/index.html` | The shell |

---

## Task 1: The render package, its interface, and the atlas

**Files:**
- Create: `packages/render/` (package.json, tsconfig, vitest config), `src/types.ts`, `src/palette.ts`, `src/atlas.ts`, `test/atlas.test.ts`
- Modify: root `pnpm-workspace.yaml`, `tsconfig.json` references

**The interface, defined before anything draws.** `RenderFrame` carries only preallocated readonly typed arrays plus scalars — no `GameState`, no objects per frame. Name every field and its type here; later tasks consume it verbatim.

**The atlas:** 256 offscreen canvases (or one strip of 256 cells — the implementer chooses and states why), keyed by the 8-bit neighbour mask, drawn at `tileSize × dpr`. Stroke width 55–65% of tile size, round caps and joins.

**Coverage required:** every one of the 256 masks produces a distinct non-empty tile except mask 0, which is empty; a tile's ink is symmetric under the mask's own symmetry (mask for N+S is vertically symmetric, E+W horizontally); rebuilding at a different tile size changes the tile dimensions and leaves the mask→index mapping unchanged; the mask→index mapping is the identity, asserted against hand-written literals for at least masks 0, 1, 5, 85, 170, 255; a rebuild at the same size is idempotent.

**Vacuity self-checks:** at least one tile must have ink in the interior *and* at each of its four edges, or "draw a centred dot for every mask" passes the distinctness check; the symmetry fixture must use a mask that is not symmetric under *both* axes, or a blank tile passes.

**Mutations:** return the same canvas for every mask; ignore the mask's diagonal bits; swap the N and S bits; off-by-one the atlas index; skip the DPR multiply; use a fixed stroke width independent of tile size; draw round caps as butt caps.

---

## Task 2: Drawing — terrain, roads, buildings, cars, and the shadow layer

**Files:**
- Create: `packages/render/src/canvas.ts`, `src/shadow.ts`, `test/canvas.test.ts`, `test/shadow.test.ts`

Implements the interface from Task 1 against a real `CanvasRenderingContext2D`. Tests run in jsdom against a stub context that **records the call sequence**, because pixel assertions in jsdom are worthless.

**Draw order is load-bearing and must be asserted:** terrain → roads → shadow layer → buildings → cars. Buildings and cars draw *above* the shadow layer, or every sprite sits under its own shadow.

**Coverage required:** the call sequence matches the stated order; the shadow layer is composited exactly once per frame regardless of sprite count; shadow shapes are drawn opaque and the *layer* carries the alpha, asserted by reading the recorded `globalAlpha` at each call; a car at `alpha = 0.5` between two cells draws at the midpoint, against hand-computed pixel coordinates; only cells inside the revealed grid are drawn; zero sprites still composites zero shadow blits, not one over an empty layer.

**Vacuity self-checks:** the frame must contain at least one building, one car and one road cell, or the order assertion is vacuous; the shadow test must contain **two overlapping** shadows, since one shadow cannot distinguish composited from alpha-stacked.

**Mutations:** draw shadows after buildings; composite the shadow layer per sprite; set alpha on each shadow shape instead of the layer; draw cars before roads; use `carCell` directly instead of the interpolated position; drop the grid-bounds check.

---

## Task 3: The fixed-timestep loop and interpolation

**Files:**
- Create: `packages/game/` (package.json, tsconfig, vitest config), `src/loop.ts`, `src/interpolate.ts`, `test/loop.test.ts`, `test/interpolate.test.ts`

**The loop** is decision 1's accumulator, driven by an injected clock so tests control time exactly. It must never call `step` with a fractional argument and never allocate per frame.

**Interpolation** is decision 2. Prev car positions live in a preallocated `Int32Array` snapshotted before each `step`.

**Coverage required:** a 16.7 ms frame at 30 Hz sim runs 0 or 1 ticks and the alpha advances by ~0.5; a 100 ms frame runs exactly 3 ticks; a 5,000 ms frame runs at most `MAX_FRAME_DT / TICK_MS` ticks, hand-computed; alpha is always in `[0, 1)`; **a trip-completing car snaps** — it renders at its house on the arrival frame and never between; **a flipping car snaps at the carpark**; **an ordinary mid-route car interpolates**, strictly between prev and curr at `alpha = 0.5`; the loop is allocation-free across 1,000 frames.

**Vacuity self-checks:** the interpolation fixture must contain a car whose prev and curr cells actually differ, or every interpolation test passes trivially; the snap fixtures must have prev and curr more than one cell apart, or the distance guard is never exercised.

**Mutations:** clamp `rawDt` after accumulating instead of before; use `<=` in the accumulator drain; let alpha reach 1.0; snap on phase change only (must fail — this is the trip-end case); interpolate unconditionally; snapshot prev *after* `step` instead of before; use `>` instead of `>=` on the one-cell distance guard.

---

## Task 4: Input — tile-snapping draw, erase mode, pause

**Files:**
- Create: `packages/game/src/input.ts`, `test/input.test.ts`

Pointer events → tile coordinates → `TickAction[]`, consumed by the next `step`. Drag lays segments cell by cell between consecutive tiles. Erase is a **mode toggle**, never a tap or long-press (spec §7.3 — the most important mobile lesson available). Pause is one tap and freezes the accumulator.

**The camera transform is inverted here, and it is the bug factory.** Screen → tile must be the exact inverse of Task 2's tile → screen, including the letterbox offset and DPR.

**Coverage required:** a tap inside tile `(3, 7)` on a letterboxed non-square canvas produces exactly that tile, hand-computed; a tap in the letterbox produces no action; a drag across three tiles produces two `place` actions with the right endpoints, in order; a drag that re-enters the tile it is already on produces no duplicate action; erase mode produces `erase` actions and never `place`; pause stops the accumulator and resumes it without a catch-up burst; **round-trip: for every tile in the grid, `screenToTile(tileToScreen(t)) === t`.**

**Vacuity self-checks:** the canvas fixture must be non-square *and* letterboxed *and* at DPR ≠ 1, or a wrong transform passes; the drag fixture must change direction at least once, or a transposed axis passes.

**Mutations:** drop the letterbox offset; drop the DPR divide; swap x and y; use `round` instead of `floor` on the tile index; emit an action per pointer event rather than per tile entered; let erase mode emit `place`; forget to clamp to grid bounds.

---

## Task 5: HUD, palette, and the Telegram shell

**Files:**
- Create: `packages/game/src/hud.ts`, `src/telegram.ts`, `src/main.ts`, `index.html`, `test/hud.test.ts`
- Copy from (do not modify) `spike/src/telegram.ts`

**HUD is exactly three elements** (spec §7.2): week/day clock **always expanded** — the collapsed default is a standing community complaint — score, and tiles-left. Drawn on the same canvas; no DOM overlay.

**The Telegram boot order is exact and was established by M0:** `ready()` → `expand()` → `disableVerticalSwipes()` (7.7+) → `requestFullscreen()` + `lockOrientation()` (8.0+) → **only then size the canvas.** Every call version-gated with `isVersionAtLeast`. Sizing before the chrome settles gives a canvas that is wrong for the first frames.

**Coverage required:** the clock reads the correct week and day for hand-computed tick values including the week boundary and day 6→0 wrap; score and tiles-left render the sim's values, not their own counters; the boot sequence calls in exactly the stated order, asserted on a recording stub; each version gate suppresses its call on an older reported version and permits it on a newer one; **canvas sizing happens after the last boot call**.

**Vacuity self-checks:** the version-gate fixture must test both sides of each gate, or "never call it" passes; the clock fixture must span a week boundary, or `dayOfWeek` truncation passes.

**Mutations:** size the canvas before `expand()`; drop a version gate; call `disableVerticalSwipes` unconditionally; use `TICKS_PER_DAY` as a divisor (it is deliberately `0`); read the score from a local counter instead of the sim.

---

## Task 6: Wire it, play it, deploy it

**Files:**
- Modify: `packages/game/src/main.ts`
- Create: `packages/game/test/integration.test.ts`
- Modify: the existing Worker config to serve the game bundle

Assemble: create the canvas, boot Telegram, build the world and state, run the loop, feed input, draw.

**The end-to-end test drives the real loop headlessly** — synthetic pointer events in, recorded draw calls out — and asserts a full trip is visible: a road is drawn through the input path, a car is dispatched, its drawn position advances monotonically along the route, and the score increments on return.

**Guard it against becoming a smoke test**, the way M1b's golden nearly was and M1c's brief caught: assert the fixture actually exercises what it claims — roads placed > 0, at least one car drawn at a position strictly between two cells, score strictly increased, and the drawn car position differing across at least 10 distinct frames.

**Coverage required:** the above; the loop survives a 2,000 ms stall without a catch-up burst; a resize rebuilds the atlas and the next frame draws at the new tile size; the sim's four goldens are unchanged by anything in `game` or `render`.

**Mutations:** never rebuild the atlas on resize; feed input to `step` twice; draw before stepping; drop the interpolation alpha (pass 0 always).

**Deploy:** build, deploy to the existing Worker, and **verify the artifact rather than the command's exit message** — fetch the live bundle and grep it for a string from this build. M0 lost an afternoon to a deploy that printed "Success!" and served the previous asset hash.

---

## What this plan does not settle, deliberately

- **Frame budget on a real device is unmeasured for this workload.** M0 measured 400 sprites on one iPhone at 1.6 ms. This draws roads, buildings, cars, shadows and a HUD, and has never run on Android. Task 6's deploy is what makes that measurable; expect a tuning pass, and do not treat M0's number as a budget for this frame.
- **The palette is a placeholder.** Art direction (spec §7.1) is a separate exercise; M2 ships legible pastels and a `Palette` object to replace.
- **Nothing here is tested on a real phone until Task 6 deploys.** jsdom tests the call sequences, not the pixels.
