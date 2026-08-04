# M2 plan review — fix list

Findings the plan's author confirmed **by execution** before the four-lens adversarial review ran. The review will append to this; these three are already verified and are not in doubt.

---

## C1 (Critical) — the test strategy is unexecutable as written

**Verified.** The workspace has **no jsdom, no vitest config file, and no canvas dependency**. Root `package.json` devDependencies are exactly `@types/node`, `eslint`, `typescript`, `typescript-eslint`, `vitest`. Every package's test script is a bare `vitest run`, so tests execute in Node with no DOM at all.

Also verified, directly: **`node -e "typeof OffscreenCanvas"` → `undefined`.** Node 22 does not provide it.

The plan's stated stack is "Vitest + jsdom", and Tasks 1 and 2 test the atlas and the drawing path. Neither can run:

- The atlas must **create canvases and draw into them** to pre-render 256 tiles. A recording stub cannot substitute — the whole point is real ink.
- jsdom does not implement canvas rendering without the native `canvas` package, and does not provide `OffscreenCanvas` either.

**The fix is a decision the plan must make explicitly, not leave to an implementer:**

1. **Inject a canvas factory.** `buildAtlas(factory, tileSize, dpr)` where `factory(w, h)` returns something with a 2D context. Production passes `document.createElement('canvas')` or `OffscreenCanvas`; tests pass a recording stub. The atlas is then testable in bare Node with no new dependency, and the "zero runtime dependencies" constraint survives untouched.
2. Add jsdom **and** `canvas` (a native module) as devDependencies, and test real pixels.

**Option 1 is strongly preferred** and should be written into the plan as a design decision. Option 2 adds a native build dependency to a project whose entire toolchain is currently five dev packages, for pixel assertions that this project's own catalogue says are the weakest kind of test available.

Whichever is chosen, **Task 1's file list must include the vitest config and any devDependency change**, and the plan's "Tech stack" line must stop saying jsdom unless jsdom is actually adopted.

---

## C2 (Critical) — Decision 3 is not implementable as stated, and Tasks 2 and 3 contradict each other

**Verified by reading the real exports.** To place a car between two cells the renderer needs:

| Needed | Where it lives | Kind |
|---|---|---|
| `edgeCost(dir)` | `packages/sim/src/graph.ts:94` | **function** |
| `DX`, `DY`, `DIR_COUNT`, `OPPOSITE` | `packages/sim/src/roads.ts:92-95` | data (frozen) |
| `stepCell(cell, k, w, h)` | `packages/sim/src/dispatch.ts:324` | **function** |
| `routeStep` | `packages/sim/src/dispatch.ts` | **function** |

Decision 3 says `render` "takes typed arrays, not `GameState`", so that it "depends on nothing but its own interface types" (spec §4). **That cannot hold if `render` interpolates**, because interpolation needs three functions that live in `sim`.

**The plan also contradicts itself about who interpolates.** Task 3 puts `interpolate.ts` in `packages/game/` — correct. But Task 2's coverage bullet says *"a car at `alpha = 0.5` between two cells draws at the midpoint"*, which puts the interpolation inside `render`. Both cannot be true.

**Fix — make the boundary explicit, and put interpolation in `game`:**

> **Decision 3 (revised).** `game` owns interpolation. Each frame it writes **already-resolved float positions** into a preallocated `Float32Array` of `x, y` pairs in grid space, and `render` draws what it is given. `render` therefore imports nothing from `sim` — not `edgeCost`, not the direction tables — and can be tested with hand-built arrays and no sim at all. This is what makes "swapping in Pixi is a one-file change" true rather than aspirational.
>
> The cost is one preallocated array and one pass per frame, both allocation-free. The benefit is that the only module that must understand route encoding, edge costs and phase transitions is the one that already imports `sim`.

Task 2's coverage bullet must then be restated as **"a car whose resolved position is the midpoint of two cells draws at the midpoint pixel"** — a pure transform assertion, hand-computed, with no notion of alpha in `render` at all.

---

## C3 (Important, and a plan-hygiene finding) — the spec's own §4 line was the trap

Spec §4 says `render` "Reads sim state, never writes" **and** "depends on nothing but its own interface types". Those two clauses look compatible and are not, the moment anything needs a *function* from `sim` rather than a byte.

The plan inherited the tension rather than resolving it, and Decision 3 asserted the conclusion without checking the premise. Worth recording in the catalogue: **a spec sentence that has never been executed against is an assumption, not a constraint** — this one survived four milestones because nothing had tried to render yet.

---

## C4 (Important) — the two new packages would be silently unlinted, and `pnpm lint` would still pass

**Verified by reading `eslint.config.js`.** It contains exactly **one** `files:` block:

```js
files: ['packages/sim/src/**/*.{ts,mts,cts,js}', 'packages/shared/src/**/*.{ts,mts,cts,js}'],
extends: [tseslint.configs.recommended],
```

`tseslint.configs.recommended` is *inside* that block. So adding `packages/render` and `packages/game` gives them **no linting at all** — not the determinism rules, which is correct since those packages are explicitly allowed floats and DOM, but also not the recommended TypeScript rules, which they should have.

`pnpm lint` will keep exiting 0, so nothing announces the gap. This is the project's signature defect shape at the toolchain level: **a check that appears to cover something and does not.**

Separately verified: the source scan in `packages/sim/test/determinism.test.ts` is explicitly scoped to `../src` and `../../shared/src`, so it will not reach the new packages and will not produce false failures there. That half is already correct and needs no change.

**Fix — add to Task 1's file list and state it as a decision:**

> A second `eslint.config.js` block covers `packages/render/src/**` and `packages/game/src/**` with `tseslint.configs.recommended` only. The `determinism/*` rules, `no-restricted-globals` and `no-restricted-syntax` deliberately **do not** apply there: `render` and `game` are outside the determinism boundary by design (spec §4), they legitimately use floats, `document`, `performance` and `Math.random`, and `no-module-mutable-state` would forbid the atlas cache that Decision 4 requires. The boundary is enforced instead by the one-way dependency direction and by `render` importing nothing from `sim`.

Add a test asserting the new packages are actually covered by *some* config, so this cannot silently regress — `ESLint.calculateConfigForFile` on a representative file from each.

---

## C5 (Important) — Task 1's symmetry fixture violates Task 1's own vacuity check

Task 1 states the coverage as:

> a tile's ink is symmetric under the mask's own symmetry (**mask for N+S is vertically symmetric, E+W horizontally**)

and then states the vacuity condition as:

> the symmetry fixture **must use a mask that is not symmetric under both axes**, or a blank tile passes

**Both named examples are symmetric under both axes.** Verified against the real bit order (`roads.ts:92-95`, where bit *i* is direction *i*, so N=0, NE=1, E=2, SE=3, S=4, SW=5, W=6, NW=7):

- **N+S** is mask `0b00010001` = **17** — a vertical bar. Mirrored horizontally it is still a vertical bar. Symmetric under both axes.
- **E+W** is mask `0b01000100` = **68** — a horizontal bar. Symmetric under both axes.

So an implementer following the coverage bullet literally writes a fixture the vacuity check forbids, and a blank tile passes the symmetry assertion. The bullet and its own guard are in direct contradiction.

**Fix — name an asymmetric mask explicitly:**

> A tile's ink is symmetric under the mask's own symmetry, tested on **mask 5 (N+E, `0b00000101`)** — an elbow, symmetric about the NE–SW diagonal and asymmetric under *both* the horizontal and vertical axes, which is what makes a blank or centred tile fail. Assert the diagonal symmetry, and assert the horizontal and vertical asymmetry, so the fixture cannot pass by having no ink.

**The plan's other mask literals do check out**, verified against the same bit order and worth keeping: **85** = `0b01010101` = the four orthogonals, **170** = `0b10101010` = the four diagonals, **255** = all eight, **1** = N alone, **0** = empty.

---

## C6 (Critical) — Task 5 sizes the canvas once, and the spike's own code says once is not enough

**Verified against `spike/src/main.ts:19,90,95` and `spike/src/telegram.ts`.** The spike sizes the canvas as `stableHeight() - contentSafeAreaTop() - 16` and then **re-reads it a second time after the fullscreen transition settles**, with a comment explaining why:

> At module-eval time `requestFullscreen()` had only just been called and the client had not yet published the real inset.

Task 5 says the boot order ends "**only then** size the canvas", implying a single pass immediately after `boot()` returns. That is precisely the pass the spike documents as a **best guess**. The plan therefore encodes the wrong half of a lesson M0 already learned: it correctly moves sizing *after* the Telegram calls, and then stops one step short.

The consequence is not cosmetic. Tile size is derived from canvas size, and **the atlas is built from tile size**, so a wrong first measurement means a full atlas rebuild on the first correction — or worse, a stale atlas if the rebuild trigger only watches resize events that never fire.

**Fix — replace Task 5's sizing sentence:**

> Size the canvas after the boot calls, then **size it again once the fullscreen transition has settled**, because at boot-return the client has not yet published the real content-safe-area inset — this is measured spike behaviour, not a precaution. Treat the first pass as provisional. Drive the atlas rebuild from *measured tile size changing*, never from a resize event, so the second pass rebuilds correctly and a no-change second pass costs nothing.
>
> **Coverage:** a boot in which the second measurement differs from the first rebuilds the atlas exactly once and leaves the first frame's tile size unused; a boot in which they agree rebuilds zero times.

That second coverage bullet is the vacuity guard — without it, "always rebuild" passes.

---

## C7 (Important) — Task 5's version-gate coverage is unsatisfiable for half the calls it names

**Verified in `spike/src/telegram.ts:82-90`.** The boot order is exact, and the gates are exactly `'7.7'` and `'8.0'` as the plan states. But `ready()` and `expand()` are **not gated at all** — they pass no `minVersion`, correctly, since both are 6.0 baseline.

Task 5 claims "**every** call version-gated with `isVersionAtLeast`" and then asks for coverage that "each version gate suppresses its call on an older reported version". For `ready` and `expand` there is no gate to suppress, so **two of the four bullets cannot be written**. An implementer either invents gates that should not exist, or quietly drops the bullets.

Three further lift hazards found in the same pass, none of which the plan mentions:

- **`atLeast()` is the exported helper; `isVersionAtLeast` is used only inside a private `webApp()` wrapper.** A recording stub must therefore stub `globalThis.Telegram.WebApp.isVersionAtLeast`, not an importable symbol — worth stating, because stubbing the wrong one produces a test that passes and proves nothing.
- **`atLeast` returns `false` when `isVersionAtLeast` is absent**, so an "old client" fixture suppresses *everything* past `expand()`. That is the correct behaviour and it makes a single old-client fixture unable to distinguish the 7.7 gate from the 8.0 gate. Each needs its own reported version.
- **`telegram.ts` imports `type { CloudLike } from './cloudProbe'`**, which is spike-only, and exports `cloudStorage()`. M2 defers persistence to M3, so the lift must **drop `cloudStorage()` and that import** rather than drag `cloudProbe.ts` into `packages/game`.
- `stableHeight()` reads `globalThis.innerHeight`, so `packages/game`'s tsconfig needs `"lib": ["DOM"]`. `sim` and `shared` have no DOM need, so confirm what `tsconfig.base.json` actually provides before assuming it is inherited.

**Fix:** restate the claim as "every call that *needs* a gate is gated, and `ready`/`expand` are 6.0 baseline and deliberately ungated", and scope the coverage to the two real gates, each with its own reported-version fixture.

---

# The four-lens adversarial review

**VERDICT: DO NOT EXECUTE AS WRITTEN.**

74 findings raised across four lenses — **24 Critical, 36 Important, 14 Minor.** 50 reached an independent refuter before the session limit stopped the run: 22 refuted, 28 survived. **24 findings never got a refuter, and the synthesis agent died**, so this section was written by hand from the run's journal. Findings below are marked where I verified them myself.

The run cost 79 agents and ~3M tokens. It was worth it: the plan cannot reach its own stated goal.

---

## The one that ends the argument

### CR1 — Nothing in M2 places a house or a destination. The board is empty forever.
**All four lenses found this independently** (M2-R1, M2R-03, M2-07, F1).

`placeHouse` and `placeDestination` (`buildings.ts:332,422`) have **no production caller anywhere in `packages/`**. The authored spawn schedule is M1e's, and this plan's Scope table defers M1e without noticing it depends on it.

So an M2 build renders terrain and roads, and nothing else. No house, no destination, no pin, no car, no score. **The Goal — "draw a road with your finger, watch a car take it, see the score tick" — is unreachable from the work the plan assigns**, and Task 6's end-to-end test asserts a state that cannot exist.

This is M2's version of M1c's "the return leg had no mechanism at all": a whole half of the deliverable with no owner, invisible because every task looked correct in isolation.

**Fix:** add a task before Task 6 that seeds a fixed, hand-authored starting city — a few houses and destinations at literal cell coordinates, placed once at startup, deterministic, no schedule. Explicitly **not** M1e's spawner. State that M1e replaces it.

---

## Criticals that change the design

### CR2 — Interpolation interpolates the wrong quantity, and is worse than not interpolating
**Four lenses** (M2-R2, M2R-01, M2R-02, M2-01, F2).

**Verified: `2500/330 = 7.576` ticks to cross an orthogonal cell, `3500/330 = 10.61` for a diagonal.** So `carCell` changes on roughly **one tick in eight**. A prev-cell→curr-cell lerp renders a car motionless for ~6.6 ticks (0.22 s) and then smears one whole cell across a single 33 ms window. **That is a 4 Hz strobe, not smooth motion** — materially worse than drawing at `carCell` and not interpolating at all.

The sim already stores the sub-cell term. The correct resolved position is:

```
pos = cell + dirVector * (carProgress + alpha * speedUnits) / (edgeCost(dir) * COST_UNIT_SCALE)
```

**`carProgress`, `carRouteCursor`, `carRouteLen` and `COST_UNIT_SCALE` appear nowhere in the plan** — not in Decision 2, not in Task 3, and not in C2's revised Decision 3 above, which lists `edgeCost`, `stepCell`, `routeStep` and the direction tables and still misses the progress term. **C2's fix was incomplete and must be reopened.**

### CR3 — Decision 2's guard makes interpolation never fire, and its "must fail" mutation is a provable no-op
**Four lenses** (M2-R3, M2R-04, M2-03, F4).

Decision 2 snaps when the interpolated distance is "under one cell" — but a car never moves more than one cell per tick, so **phase-unchanged already implies a move of at most one cell**. The guard the plan calls load-bearing is a 0-detector, and the named mutation *"snap on phase change only — must fail"* **cannot fail**. Its fixture is not constructible: `step`'s phase order makes a teleport with an unchanged phase byte impossible.

Both discontinuities Decision 2 is built on need re-deriving against the real tick order once CR2 changes what is being interpolated.

### CR4 — `RenderFrame` has no liveness prefixes: 80 phantom cars stack on cell 0
(M2R-05.) A fresh `GameState` is all-zero and **writes no `-1` sentinel** (`state.ts:306-315`). Unused slots are those at index ≥ `H_HOUSE_COUNT`/`H_DEST_COUNT`; unused cars are `PHASE_NONE = 0`. Every unused `carCell`/`houseCell`/`destCell` is therefore **0 — a real, in-bounds, drawable cell.**

On `firstCity` a renderer that iterates the arrays it is handed draws **80 cars, 40 houses and 16 destinations piled on the top-left tile from frame 1.** Task 2's "only cells inside the revealed grid are drawn" does not catch it, because cell 0 *is* inside the grid.

**Fix:** `RenderFrame` carries `houseCount`, `destCount`, and `carPhase` (cars' only liveness marker). Task 2 needs a bullet that a state with live prefixes shorter than the array length draws exactly the live ones.

### CR5 — The camera fits two different grids, and one of them violates spec §5.1
**Two lenses** (M2-06, F6). Three mutually exclusive readings appear in one plan: Decision 5 fits the **full** 24×40 grid; Scope and the Deferred table fit the **revealed** grid; Task 2's coverage says "only cells inside the revealed grid".

Reading 1 gives **16 CSS px tiles — 57% of spec §5.1's hard 28 CSS px floor** — and is unreachable on any phone (24 × 28 = 672 CSS px against 390–430 available). **The premise the pan/zoom deferral rests on is false under reading 1.** Reading 2 satisfies the spec (14 × 28 = 392 ≤ 406) and yields ~29 px tiles. It also changes atlas memory 3.3×.

Also: **"revealed grid" exists in no code.** Nothing tracks reveal state; that is M1e's. Pick reading 2, define the revealed rect as a constant for now, and say so.

### CR6 — M0's only "Adopt now" performance decision is absent
(M2-04.) M0 §7's decision table has exactly one **Adopt now** row: **cap `devicePixelRatio` at 2 universally, 1.5 on `performanceClass === 'LOW'`** — "the largest single lever available", worked at ~5 ms vs ~8.5 ms on a LOW Android.

The plan mentions `devicePixelRatio` zero times and `performanceClass` zero times, builds the atlas "at device pixel ratio, full stop", and lists "skip the DPR multiply" as a mutation — **hard-coding the uncapped behaviour as correct.** On the one device M0 measured (DPR 3) that is 2.25× the pixels on every fill, blit and clear.

### CR7 — The shadow layer re-imports the exact cost structure M0 used to delete the road bake
(M2-05.) **This one is mine, and it is embarrassing:** Decision 6 defends the shadow layer by explicit contrast with the bake M0 killed — *"unlike the road bake it is justified"* — and on M0's own numbers the contrast does not hold.

A full-canvas offscreen layer costs **one full-canvas clear plus one full-canvas composite** per frame: 2 × 3,178,980 = **6,357,960 device px, ~0.64 ms**. M0 costed the entire per-frame road layer at 0.168 ms and the whole *rejected* bake at 0.318 ms. **The shadow layer is ~2× the cost of the thing M0 deleted and ~3.8× the entire road layer** — on the fastest mobile device anyone has measured. It carries the same **+12.13 MiB** M0 charged against the bake, and my accounting omitted the clear entirely.

"Removes N alpha compositions" values the thing M0 measured as nearly free: 500 shadow sprites drawn directly are ~415 kpx, ~0.04 ms — **1/15th of the layer's own overhead.**

**Fix:** draw shadows directly per sprite and accept the overlap darkening for M2, or clear/composite only the grid bounds rather than the full canvas. Either way, re-derive it from M0's pixel model rather than from the spec bullet.

### CR8 — The deploy destroys the live M0 artefact, and the toolchain does not exist
(M2-R5.) There is exactly one Worker config: `spike/wrangler.jsonc`. Task 6 says "modify the existing Worker config"; Global Constraints say "do not modify `spike/`". So Task 6 is either forbidden by the plan's own rule or it **repoints the deployed M0 spike**, serving the game at the spike's URL and breaking the page still accepting `POST /api/result` into D1.

Worse: **neither `vite` nor `wrangler` is in the workspace.** Root devDependencies are exactly `@types/node`, `eslint`, `typescript`, `typescript-eslint`, `vitest`; `spike/` is deliberately *outside* the workspace with its own lockfile. No task provisions them.

### CR9 — Two hand-computed tick counts are wrong, and the natural fix desynchronises the clock
**Three lenses** (M2-R4, M2-02, F3). **I verified this by execution:**

```
TICK_MS = 1000/30 = 33.333333333333335702
100 ms frame -> 2 ticks, remainder 33.33333333333332, alpha = 0.9999999999999996
16.7 ms frame -> 0 ticks
250 / TICK_MS = 7.499999999999999
```

The plan asserts "a 100 ms frame runs **exactly 3 ticks**". It runs **2**, because `1000/30` rounds *above* exact so the third subtraction fails by one ulp. The plan's "0 or 1 ticks" for 16.7 ms is also wrong on a cold first frame.

The trap: an implementer who "fixes" this by writing `TICK_MS = 33` **desynchronises the game clock from the sim's 30 Hz by 1%** — a week runs 148.5 s instead of 150.

### CR10 — The HTML shell has no stated requirements, including the Telegram SDK script
(M2-08.) Without `telegram-web-app.js`, `globalThis.Telegram` is undefined, `atLeast()` returns false, and **the entire boot sequence silently no-ops** — no error, no test failure, because every planned test stubs the API. Also unspecified: viewport meta, `touch-action`, overscroll behaviour, and background colour.

---

## Importants worth naming here

- **Three of Task 6's four named mutations survive every guard it pairs them with** (F5), including one that is a provable no-op against the sim's documented idempotence.
- 36 Importants total; the full text of every finding is in the run journal at
  `subagents/workflows/wf_b5e17f7a-6f6/journal.jsonl`.

---

## Honest limits of this review

- **24 of 74 findings never faced a refuter**, and the refuted/survived mapping was lost when the synthesis died — the journal records verdicts without finding labels. Everything above is either multi-lens, or verified by me directly, or both. Treat single-lens unrefuted findings in the journal as unvetted.
- The refuters that did run **refuted 22 of 50**, a 44% rate consistent with earlier runs — so a meaningful fraction of the unrefuted 24 are probably wrong too.
