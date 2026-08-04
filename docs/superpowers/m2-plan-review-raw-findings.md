## [Critical] M2-R1 — Nothing in M2 creates a house or a destination, so no car ever exists, the score never moves, and Task 6's end-to-end test asserts an unreachable state
**Section:** Task 6 ("Wire it, play it"); Scope; Goal; Task 2 fixture; Task 5 HUD score

`placeHouse` and `placeDestination` (packages/sim/src/buildings.ts:332,422) have NO production caller anywhere in packages/ — grep finds them only in packages/sim/test/{demand,dispatch,loop,trips,buildings}.test.ts. `step()` (packages/sim/src/step.ts) has seven phases and none of them is a spawner; buildings.ts's own module comment says so explicitly: "building placement is an explicit, out-of-band call the M1e spawner will eventually drive". Spec §5.9 (spawning) is unimplemented and the plan's deferral table does not mention it at all — it defers the upgrade modal and inventory row to M1e, and says nothing about who places buildings.

Consequences, all of them load-bearing for this milestone:
- Task 6's "a car is dispatched, its drawn position advances monotonically along the route, and the score increments on return" is unreachable: with H_HOUSE_COUNT=0 there are zero cars in PHASE_IDLE, so runDispatch has nothing to dispatch; with H_DEST_COUNT=0 runDemand fires no pins.
- Task 6's anti-smoke guards ("score strictly increased", "at least one car drawn at a position strictly between two cells", "drawn car position differing across at least 10 distinct frames") are all unsatisfiable.
- Task 2's vacuity self-check "the frame must contain at least one building, one car and one road cell" can only be met by a hand-built fixture, which then proves nothing about the real wiring.
- Task 5's "score and tiles-left render the sim's values" renders a permanent 0.
- The plan's own Goal — "draw a road with your finger, watch a car take it, see the score tick" — cannot happen.

This is unassigned work, not a deferral: every task assumes some other task produced buildings. The plan must either add an M2-scoped placement step (a fixed seeded starting layout, or a minimal spawner) with its own task, coverage and mutations, or restate the Goal and delete every car/score assertion in Tasks 2, 5 and 6.

**Witness:** Ran, in packages/sim, exactly the boot Task 6 describes (createWorld + createState + createScratch + createFlowFields on firstCity()) then 3,000 ticks of step with empty inputs. Result: `houses 0  dests 0  carSlots 80  liveCars 0  score 0  carSlotsSittingAtCell0 80`. Score is still 0 after 100 seconds of simulated play and no car slot ever leaves PHASE_NONE.

---

## [Critical] M2-R2 — Interpolation as specified never fires on real sim data, and where it does fire it is stationary for 6.6 of every 7.6 ticks — the plan never names carProgress, carRouteCursor or the edge threshold
**Section:** Decision 2 ("Interpolation must snap, not lerp"); Task 3 (interpolate.ts)

The plan defines interpolation entirely over prev/curr **cells** plus the frame alpha, and gates it on "interpolated distance is under one cell". Both halves fail against the real movement model.

(a) **The distance guard snaps every crossing.** advanceCar (packages/sim/src/cars.ts) moves a car by exactly one cell when it crosses. Prev-cell to curr-cell distance is therefore exactly 1.0 on an orthogonal crossing and sqrt(2)=1.414 on a diagonal one — both fail "under one cell". On every non-crossing tick prev === curr, so lerping is a no-op. Net result: the renderer is 100% snap, always, and Decision 1's entire justification ("smooth car motion is most of this genre's feel") is unrealised. Task 3's own vacuity check — "an ordinary mid-route car interpolates, strictly between prev and curr at alpha = 0.5" — is unsatisfiable from any real state; it can only be met by a hand-built array whose values the sim never produces.

(b) **Even with the guard relaxed, cell-to-cell lerp stutters.** A car gains CAR_SPEED_UNITS_PER_TICK=330 progress per tick against a threshold of ORTHO_COST*COST_UNIT_SCALE=2500, i.e. it crosses a cell every 7.576 ticks (10.606 on a diagonal). So prev===curr for ~6.6 of every 7.6 ticks and the car sits perfectly still for ~220 ms, then slides a whole cell in one 33 ms tick. That is visibly worse than not interpolating.

(c) **The data that yields a smooth position is never mentioned anywhere in the plan.** The correct sub-cell fraction is `carProgress[i] / (edgeCost(dir) * COST_UNIT_SCALE)` where `dir = routeStep(state, i, cursor)` outbound and `OPPOSITE[routeStep(state, i, cursor-1)]` returning. The plan names none of `carProgress`, `carRouteCursor`, `carRouteLen`, `routeStep`, `edgeCost`, `COST_UNIT_SCALE`, `OPPOSITE`, and never states how a step is decoded from `carRoute` (it is a nibble: `(carRoute[i*ROUTE_BYTES + (i>>1)] >> ((i&1)*4)) & 0xf`, ROUTE_BYTES = MAX_PATH_LEN/2 = 48; the cursor means "the step being taken" outbound but "cursor-1, reversed" returning). Task 3 is handed this as unspecified work. Note the fixlist's C2 fix ("game computes resolved float positions") fixes the package boundary but not this: it never says what the position is resolved *from*.

Under the correct formulation the per-tick delta is 330/2500 = 0.132 cell orthogonal and 0.133 diagonal — comfortably under one cell, which is what makes the guard in (a) work at all.

**Witness:** 10*250/330 = 7.5757… ticks per orthogonal cell; 14*250/330 = 10.606 per diagonal. Orthogonal prev→curr distance on a crossing tick = 1.0, diagonal = 1.4142; the plan's guard is "under one cell" and its mutation list implies `dist >= 1 → snap`, so both snap. 330/2500 = 0.132 cell per tick is the delta the plan never computes.

---

## [Critical] M2-R3 — Decision 2's justification is backwards against the real tick order: phase-unchanged implies a move of at most one cell, so the named mutation "snap on phase change only (must fail)" is a provable no-op
**Section:** Decision 2 ("The distance guard is the load-bearing half"); Task 3 mutations

Decision 2 states: "The distance guard is the load-bearing half — phase is unchanged on an ordinary trip-end-to-idle-to-redispatch within one tick, and a phase check alone would miss it." That case does not exist.

- step.ts runs dispatch as phase 5 and arrivals as phase 7. A car that goes PHASE_IDLE in tick T's arrivals cannot be redispatched until tick T+1's phase 5. So within one tick, trip-end-to-idle-to-redispatch is structurally impossible.
- Across the tick boundary the prev snapshot is taken before step(T+1), so prev phase = IDLE and curr phase = OUTBOUND — the phase check fires.
- Every discontinuity the sim can produce changes the phase byte: `completeTrip` always writes PHASE_IDLE, `arriveAtDestination` always writes PHASE_RETURNING (trips.ts). `advanceCar` (cars.ts) is the only other writer of `carCell` and moves at most one cell per tick (`assertSingleCrossing` guarantees it).

Therefore, on the reachable manifold, **phase-unchanged implies displacement of at most sqrt(2) cells**, and the distance guard has no reachable observer. The plan's mutation "snap on phase change only (must fail — this is the trip-end case)" is unkillable by any fixture drawn from real state; the only fixtures that kill it are the ones Task 3's own vacuity check demands be built off-manifold ("prev and curr more than one cell apart").

Relatedly, Task 3's coverage "a trip-completing car renders at its house on the arrival frame and never between the destination and the house" describes a jump the sim does not make: the return leg retraces the route and ends on the house cell, and trips.ts documents `state.carCell[i] = houseCell[carHome[i]]` as "a no-op on the reachable manifold". There is no destination-to-house teleport to observe.

Either the guard is dropped and the plan says why, or Decision 2 must state that the guard exists only to fail closed on corrupted state and that its coverage is deliberately off-manifold — which is the codebase's existing idiom (assertSingleCrossing, assertDispatchProgress) and should be written the same way.

**Witness:** packages/sim/src/step.ts: `runDispatch` (phase 5) precedes `runArrivals` (phase 7) in the same function body. packages/sim/src/trips.ts: `arriveAtDestination` sets PHASE_RETURNING unconditionally; `completeTrip` sets PHASE_IDLE unconditionally. packages/sim/src/cars.ts: `assertSingleCrossing(residual, MIN_EDGE_THRESHOLD)` proves at most one cell of movement per car per tick.

---

## [Critical] M2-R4 — Stated coverage value is arithmetically wrong: a 100 ms frame runs 2 ticks, not 3, and the natural fix is the plan's own named mutation
**Section:** Task 3, coverage: "a 100 ms frame runs exactly 3 ticks"

TICK_MS = 1000 / TICKS_PER_SECOND = 1000/30, which in IEEE-754 is 33.333333333333336 — strictly greater than 100/3. Running the plan's own accumulator on a 100 ms frame drains twice, leaving 33.33333333333332, which is *below* TICK_MS, so the loop exits at 2 ticks with alpha = 0.9999999999999996.

An implementer writing this test watches it fail and reaches for exactly one of three fixes: an epsilon on the drain comparison, flipping `>=` to `>` on the wrong side, or switching the accumulator to integer microseconds. The first two are the plan's own named mutations ("use `<=` in the accumulator drain", "let alpha reach 1.0") — so the plan's stated coverage value actively pushes the implementer toward the defect the plan says it is hunting. The third is fine but is a design change the plan does not authorise (Decision 1 mandates a real-valued accumulator and `alpha = accumulator / TICK_MS`).

Pick a frame length that is not knife-edge (e.g. 105 ms → 3 ticks, alpha ≈ 0.15), or state 2 ticks and alpha ≈ 1.0-eps and make the near-1.0 alpha the point of the test.

Secondary, same bullet list: "a 16.7 ms frame at 30 Hz sim runs 0 or 1 ticks and the alpha advances by ~0.5" is only true modulo 1 — the first frame gives alpha 0.501 and 0 ticks, the second gives alpha 0.002 and 1 tick. "Advances by ~0.5" is not an assertion an implementer can write directly.

**Witness:** node: `const T=1000/30; let acc=100,n=0; while(acc>=T){n++;acc-=T} ` → n = 2, acc = 33.33333333333332, alpha = 0.9999999999999996. (T = 33.333333333333336.)

---

## [Critical] M2-R5 — The deploy step contradicts a Global Constraint, and the only existing Worker config is the live M0 spike — repointing it destroys the deployed M0 artefact; no task creates the new config, and wrangler/vite are not in the workspace
**Section:** Task 6 ("Deploy"); Global Constraints ("Do not modify spike/"); Tech stack

Task 6's file list says "Modify: the existing Worker config to serve the game bundle". Global Constraints say "Do not modify `spike/`." There is exactly one Worker config in the repo: `spike/wrangler.jsonc` (`name: laneways-spike`, `main: worker/index.ts`, `assets.directory: ./dist`, a D1 binding to `laneways-spike-results`). So Task 6 as written is either forbidden by the plan's own constraint or it retargets the deployed M0 spike — the one the plan cites as "deployed" and whose Worker is still accepting `POST /api/result` into D1 for device measurements. Repointing `assets.directory` at the game bundle also serves the game at the spike's URL and silently breaks the spike page.

Further, nothing in the plan provisions the toolchain the deploy needs:
- `pnpm-workspace.yaml` globs are `packages/*` and `tools/*`. `spike/` is deliberately outside the workspace and carries its own `pnpm-lock.yaml` and its own devDependencies (`vite`, `vitest@4`, `wrangler`, `typescript@7`).
- The root `package.json` devDependencies are exactly `@types/node`, `eslint`, `typescript`, `typescript-eslint`, `vitest`. **Neither `vite` nor `wrangler` is available to `packages/game`.** The plan's Tech stack line names both and no task adds either.
- No task creates `packages/game/vite.config.ts`, a new `wrangler.jsonc`, or the `public/_headers` file spec §8.5 requires (`Cache-Control: no-store, must-revalidate` on `/` and `/index.html` — the spike has one at `spike/public/_headers`; without it Telegram Desktop caches the bundle in a location its cache-clear does not reach, which is the exact failure §8.5 warns about).

The plan must name the new Worker (a second Worker, or a documented cutover of the spike with the D1 binding preserved), say where its config lives, and add `vite` and `wrangler` to a task's file list.

**Witness:** `pnpm-workspace.yaml` = `packages/*`, `tools/*` — spike is not a member. `find spike -name wrangler.jsonc` → the only wrangler config in the repo; it binds `laneways-spike-results` (database_id c3d2da3a-…) and `spike/worker/index.ts` routes `/api/result` into it. Root package.json devDependencies contain no `vite` and no `wrangler`.

---

## [Important] M2-R6 — The zero-allocation frame-loop constraint collides with sim's own TickInputs/TickAction object API, and Task 3's "allocation-free across 1,000 frames" coverage is an assertion the plan elsewhere says cannot be written
**Section:** Global Constraints ("Nothing allocates inside the frame loop"); Task 3 coverage; Task 4

Two problems in one constraint.

(a) **The constraint is unachievable against the real `step` signature without a decision the plan does not make.** `step(s, world, fields, scratch, inputs)` takes `inputs: TickInputs = { readonly actions: readonly TickAction[] }`, and `TickAction = { readonly kind, readonly a, readonly b }` (packages/sim/src/step.ts). Task 4 produces `TickAction[]` from pointer events and Task 6 feeds them to `step` inside the loop. During a drag that is one fresh object per segment plus one fresh `{ actions }` wrapper per tick — dozens of allocations per second, inside the frame loop, in violation of a constraint the plan calls literal ("zero, not 'small'"). Pooling is blocked by the `readonly` field modifiers without a cast, and reuse of the array requires `length = 0` truncation. The plan must state the pooling scheme (preallocated action pool + a reused `TickInputs` wrapper + a count, or an explicit carve-out for input objects with the reason).

(b) **The coverage bullet contradicts the constraint's own stated enforcement.** Global Constraints say the rule is enforced "by construction and review; there is no allocation profiler". Task 3's coverage then demands "the loop is allocation-free across 1,000 frames" as a test. There is no mechanism in this toolchain to write that honestly — `process.memoryUsage()` deltas are non-deterministic under a GC and produce a flaky or vacuous assertion. Either name the mechanism (e.g. a spy on the object constructors the loop is allowed to touch, or a counted allocator injected into the loop) or delete the bullet and say the rule is review-enforced like the tick's.

**Witness:** packages/sim/src/step.ts:`export interface TickInputs { readonly actions: readonly TickAction[] }` and `export interface TickAction { readonly kind: TickActionKind; readonly a: number; readonly b: number }`. Global Constraints line 18 of the plan says "there is no allocation profiler"; Task 3 line 170 says "the loop is allocation-free across 1,000 frames".

---

## [Important] M2-R7 — Nothing in the plan says which car slots are live, and the liveness marker is carPhase — a renderer drawing every carCell draws 80 phantom cars stacked on cell (0,0)
**Section:** Decision 3 / RenderFrame (Task 1); Task 2 (car drawing)

Decision 3 describes the renderer's input as "`Uint8Array` of road masks, `Int32Array` of car cells". `carCell` is sized `maxHouses * CARS_PER_HOUSE` for the map and every unused slot is all-zero, i.e. cell index 0 = grid (0,0). state.ts is explicit: "there is no `-1` sentinel anywhere in this milestone's region list … unused cars are `PHASE_NONE = 0`" — the phase byte is the only liveness signal. The plan never names `carPhase` or a car count in `RenderFrame`, and no Task 2 coverage bullet or mutation touches liveness ("drop the grid-bounds check" does not catch it — cell 0 is in bounds).

At M2 this is not a corner case: combined with M2-R1, *every* slot is PHASE_NONE, so the first playable build renders a pile of 80 cars in the top-left corner and nothing else moves. Add `carPhase` (or an explicit live-car count and a compacted position array) to `RenderFrame`, add a coverage bullet that a PHASE_NONE slot is not drawn, and add the mutation "draw every car slot regardless of phase".

**Witness:** Probe run on firstCity(): `carSlots 80  liveCars 0  carSlotsSittingAtCell0 80` — all 80 entries of `state.carCell` are 0. packages/sim/src/state.ts createState comment: "unused cars are `PHASE_NONE = 0`".

---

## [Important] M2-R8 — The `cleared` region is never mentioned, so trees destroyed by road placement keep rendering as trees for the whole run
**Section:** Task 2 (terrain drawing); RenderFrame (Task 1)

Terrain lives in `world.terrain`, which roads.ts documents as never mutated: "Destroyed trees are recorded in the `cleared` region, never by writing to `world.terrain`" — a tree destroyed by a road sets `state.cleared[cell] = 1` and `world.terrain[cell]` still reads TERRAIN.TREE. The single reader is `hasTree(state, world, cell) = terrain[cell] === TREE && cleared[cell] === 0`.

The plan's `RenderFrame` sketch names road masks and car cells; `cleared` appears nowhere in the document. A renderer drawing terrain from `world.terrain` alone draws a tree under every road the player laid through a forest, permanently, for the entire run. This is directly visible in the first playthrough and no coverage bullet or mutation in Task 2 targets it.

Add `cleared: Uint8Array` to `RenderFrame`, a coverage bullet ("a cell with terrain TREE and cleared=1 draws as land, not as a tree"), and the mutation "ignore `cleared` and read terrain alone".

**Witness:** packages/sim/src/roads.ts:271 `export function hasTree(state, world, cell) { return world.terrain[cell] === TERRAIN.TREE && state.cleared[cell] === 0 }`; the module comment states terrain is never mutated. The plan (all 239 lines) contains no occurrence of "cleared".

---

## [Important] M2-R9 — "The revealed grid" does not exist as data anywhere in the codebase, and the plan's three statements about what the camera fits contradict each other
**Section:** Scope; Decision 5 ("Integer tile size, fixed camera"); Task 2 coverage; Deferral table

Three distinct claims, mutually inconsistent, all resting on a thing that is not implemented:

- Scope: "a fixed camera fitting **the revealed grid**".
- Deferral table's justification for deferring pan/zoom: "The whole **revealed** grid fits a portrait viewport at M2's fixed camera".
- Decision 5: tile size is `floor(min(cssW / GRID_W, cssH / GRID_H))` and "The whole **24x40** grid fits a portrait phone at this size".

The formula fits the *full* 24x40 grid, not a 14x22 revealed sub-rect. And there is no revealed sub-rect to fit: `MapData` has only `w`/`h` (documented as "Maximum extent. Expansion (§5.1, M1d) reveals cells"), `WorldData` has `map/w/h/cells/terrain/passable` and nothing else, and no state region records revealed cells. "revealed from 14x22" appears only as spec §2 decision-of-record row 4, which M1d owns.

Consequently Task 2's coverage bullet "only cells inside **the revealed grid** are drawn" and its mutation "drop the grid-bounds check" cannot be implemented against any existing data; the implementer will silently substitute the full grid bounds, which is a different assertion. Restate Scope and the deferral rationale in terms of the full 24x40 grid, and restate the Task 2 bullet as full-grid bounds — or, if a 14x22 reveal is genuinely wanted in M2, assign the work of introducing it (which touches `sim`, contradicting the "`sim` stays untouched" constraint).

**Witness:** `grep -rni reveal packages/sim/src packages/shared/src` returns two comments only, both saying expansion is M1d and never resizes the buffer. `WorldData` (packages/sim/src/world.ts) has no revealed-rect field. M0 findings line 39: `floor(min(406/24, 870/40)) = 16 CSS px` — the measured tile size is derived from the full 24x40 grid, confirming Decision 5's formula and contradicting Scope.

---

## [Important] M2-R10 — Both stated modifications are wrong: there is no root tsconfig.json and no project references, and pnpm-workspace.yaml already covers the new packages
**Section:** Task 1, Files: "Modify: root `pnpm-workspace.yaml`, `tsconfig.json` references"

- **There is no root `tsconfig.json`.** The repo has `tsconfig.base.json` only, and each package has its own `tsconfig.json` that is `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`. There are no `references` anywhere — the project-references mechanism the file list assumes does not exist here. An implementer will either create a root tsconfig nobody asked for or skip the step.
- **`pnpm-workspace.yaml` needs no change.** Its globs are `packages/*` and `tools/*`, so `packages/render` and `packages/game` are already members. Likewise the root `test`/`typecheck` scripts (`pnpm -r --filter './packages/*'`) already pick them up — good, but the plan should say so rather than schedule a no-op edit.
- **What actually must change and is not listed:** `tsconfig.base.json` sets `"lib": ["ES2022"]` with no DOM. `packages/render` needs `CanvasRenderingContext2D`, `packages/game` needs `document`/`performance`/pointer events, so **both** need their own `"lib": ["ES2022", "DOM", "DOM.Iterable"]` override (the fixlist's C7 names only `game`). Also inherited and worth stating: `noUncheckedIndexedAccess: true` and `verbatimModuleSyntax: true`, both of which change how typed-array reads and type imports must be written in the new packages.

**Witness:** `ls tsconfig*` at repo root → `tsconfig.base.json` only. `cat packages/sim/tsconfig.json` → `{"extends":"../../tsconfig.base.json","include":["src","test"]}` — no `references`. `pnpm-workspace.yaml` → `packages:\n  - 'packages/*'\n  - 'tools/*'`. `tsconfig.base.json` → `"lib": ["ES2022"]`.

---

## [Important] M2-R11 — Decision 6 waves through the exact full-canvas composite cost that Decision 4 uses to kill road baking — the shadow layer's per-frame blit is 0.318 ms, three times the whole road layer, and its clear is never charged at all
**Section:** Decision 6 ("One shadow layer, composited once") vs Decision 4 ("Do not bake")

Decision 4 rejects baking with explicit pixel accounting: the bake "composites 3,178,980 device px" against the per-frame path's 995,328, "3.2x the pixels", and prices it at ~0.318 ms against a fitted ~10 Gpx/s. Decision 6 then adopts a full-canvas offscreen shadow layer and dismisses its cost as "one extra blit" — but that blit is *the same 1218x2610 full-canvas composite*, 3,178,980 px, 0.318 ms, by the plan's own arithmetic. It also needs a full-canvas clear every frame (unstated — a shadow layer that is not cleared retains last frame's shadows, a real bug with no coverage bullet), roughly doubling the un-charged cost to ~0.6 ms.

So the plan spends, unremarked, three to six times the per-frame road layer it just finished defending (995,328 px = 0.0995 ms). That does not mean the layer is wrong — spec §6 requires non-additive shadows and the alternative is N alpha compositions — but the plan must charge it honestly, and the obvious mitigation follows directly from Decision 4's own reasoning: bound the shadow surface and its composite to the **grid rect** (1152x1920 = 2,211,840 px, 0.221 ms) rather than the letterboxed canvas, since Decision 4's whole case against baking was that the bake "still blits the letterboxed area the tiles skip".

Add the pixel accounting to Decision 6, state that the layer is cleared per frame and bounded to the grid rect, and add a coverage bullet that the layer is cleared (a two-frame fixture where frame 2 has fewer shadows than frame 1).

**Witness:** 1218 x 2610 = 3,178,980 px; /10e9 * 1000 = 0.3179 ms. 432 tiles x 48x48 = 995,328 px = 0.0995 ms. 1152 x 1920 = 2,211,840 px = 0.2212 ms. All four figures are Decision 4's / M0's own (docs/research/2026-08-02-m0-spike-findings.md:38,101-109).

---

## [Important] M2-R12 — Two shadow coverage bullets demand contradictory behaviour at zero sprites
**Section:** Task 2, coverage bullets 2 and 6

Task 2 asks for both:

- "the shadow layer is composited **exactly once per frame regardless of sprite count**"
- "**zero sprites still composites zero shadow blits**, not one over an empty layer"

At sprite count 0 the first demands 1 composite and the second demands 0. An implementer cannot satisfy both; whichever they write first, the other test fails and gets quietly weakened or deleted. Restate the first as "exactly once per frame whenever at least one shadow-casting sprite is present, regardless of how many" — which is the property that actually distinguishes the composited layer from per-sprite compositing, and which the two-overlapping-shadows vacuity fixture already exercises.

**Witness:** Plan lines 153: "the shadow layer is composited exactly once per frame regardless of sprite count; … zero sprites still composites zero shadow blits, not one over an empty layer."

---

## [Important] M2-R13 — This assertion already exists inside packages/sim, is vacuous as a causal claim, and any copy in packages/game is either a cross-package filesystem reach or a no-op
**Section:** Task 6, coverage: "the sim's four goldens are unchanged by anything in `game` or `render`"

The claim is not meaningful as written, for three separate reasons:

1. **The check already exists, in sim.** `packages/sim/test/loop.test.ts:777-790` reads `determinism.test.ts` and `rollback.test.ts` off disk and asserts they still contain `toBe(2413319809)`, `toBe(2790151213)`, `toBe(252514232)`, with its own vacuity guards. `pnpm test` runs `packages/sim`'s suite, so the goldens are asserted on every run regardless of what M2 does.
2. **The causation is unfalsifiable.** `game` and `render` do not write `packages/sim/src`, and the plan forbids it. There is no code path by which either package could move a sim golden, so an assertion that they do not is a tautology — the M1c review's own "is this fixture able to observe the failure it targets" test fails here.
3. **Any implementation is wrong.** Putting it in `packages/game/test/integration.test.ts` means either re-running sim's goldens from `game` (duplicating sim's suite and inverting the one-way dependency the plan protects) or `readFileSync('../../sim/test/…')` (a cross-package filesystem reach with a relative path that breaks the moment either package moves).

Replace the bullet with something checkable: "`pnpm test` at the repo root still runs `packages/sim`'s suite and it still passes after the two new packages are added" — i.e. an assertion about the workspace filter picking up new packages without shadowing existing ones, which is a real risk and is currently unstated.

**Witness:** packages/sim/test/loop.test.ts:781 `expect(determinism, 'the M1c state golden moved').toContain('toBe(2413319809)')`, :782 and :783-785 for the other two; :787-790 are its vacuity guards. The loop golden itself is at loop.test.ts:761.

---

## [Important] M2-R14 — A fast drag samples non-adjacent tiles; `placeRoad` silently rejects the segment and drops it, and no coverage or mutation targets the gap
**Section:** Task 4 (input: "Drag lays segments cell by cell between consecutive tiles")

`TickAction` is an **edge** (`{kind, a, b}`), and `placeRoad`/`canPlaceRoad` reject any pair for which `dirBetween(a, b, w, h) === -1` (i.e. |dx|>1 or |dy|>1), returning `false` with no error and no signal. At 16 CSS px tiles, a finger moving at a normal drag speed crosses several tiles between pointermove samples, so "between consecutive tiles" as sampled is routinely a 2-4 tile jump.

The plan never specifies a line-fill (Bresenham or equivalent) between the previous and current sampled tile, so the implementer emits one action per sampled pair and the sim silently drops most of them. The visible symptom is a road with holes in it that appears only under fast drawing — the core mechanic, degrading exactly when the player is going fast. Task 4's coverage ("a drag across three tiles produces two place actions") uses an adjacent-sample fixture and cannot see it; no mutation in the list targets it.

Add: the drag emits one action per **cell entered along the segment between samples**, with a coverage bullet for a pointer jump of >= 3 tiles diagonally producing a contiguous chain of adjacent-pair actions, and the mutation "emit one action per pointer sample instead of per cell traversed". Also state what the game does with a `placeRoad` that returns `false` (budget exhausted, water, destination footprint) — Task 4 is silent on rejection feedback.

**Witness:** packages/sim/src/roads.ts `dirBetween` returns -1 unless |dx| <= 1 and |dy| <= 1; `canPlaceRoad` then returns `{ok:false, reason:'not-adjacent'}` and `placeRoad` returns `false` with no throw. packages/sim/src/step.ts applies actions with no return-value inspection: `if (action.kind === 'place') { placeRoad(...) }`.

---

## [Important] M2-R15 — M0's single largest performance lever — cap devicePixelRatio at 2 (1.5 on performanceClass LOW) — is marked "Adopt now" and the plan never adopts it
**Section:** Decision 4 / Decision 5 (DPR); "What this plan does not settle"

The M0 findings' decisions table lists, under `performanceClass`-gated degradation: "**Yes, and the lever is DPR, not sprite count.** Cap `devicePixelRatio` at **2 universally**, **1.5 on `performanceClass === 'LOW'`**", with status **"Adopt now"** and the rationale "Fill is the dominant term … ~5 ms vs ~8.5 ms at 400 sprites, the difference between clearing and blowing the budget. Zero bytes, largest single lever available."

The plan mentions DPR three times (atlas rendered "at device pixel ratio", rebuilt "when tile size or DPR changes", mutation "skip the DPR multiply") and never caps it. Meanwhile "What this plan does not settle" says the frame budget on Android is unmeasured and that Task 6's deploy is what makes it measurable — which is precisely the situation M0 said to adopt the cap for, in advance.

Note also the interaction with Decision 4's numbers: every pixel figure it quotes (1218x2610 canvas, 48 device px tiles, 3,178,980 / 995,328 px) is at the test iPhone's **uncapped DPR 3**. Capping at 2 changes the tile to 32 device px and every one of those figures; the plan should say which regime its accounting is in. Adopting the cap also means the effective DPR is a game-level decision that must reach the atlas builder, which the plan's atlas API (`tileSize, dpr`) supports but never wires.

**Witness:** docs/research/2026-08-02-m0-spike-findings.md:248 — decision row `**performanceClass**-gated degradation | **Yes, and the lever is DPR, not sprite count.** Cap devicePixelRatio at **2 universally**, **1.5 on performanceClass === 'LOW'** | … | **Adopt now**`. Spec §6 also says to read Telegram-Android's injected `performanceClass` from the User-Agent.

---

## [Important] M2-R16 — C1's preferred resolution (inject a canvas factory, test with a recording stub) cannot satisfy any of Task 1's five ink-based coverage bullets — the fixlist says so itself and then picks that option
**Section:** Task 1 coverage, in light of fixlist C1's chosen fix

Building past C1 rather than restating it: C1's own text says "The atlas must **create canvases and draw into them** to pre-render 256 tiles. **A recording stub cannot substitute — the whole point is real ink.**" It then declares option 1 (injected factory + recording stub) "strongly preferred". Both cannot be true, and Task 1's coverage is what falls in the gap. Every one of these is an assertion about pixels:

- "every one of the 256 masks produces a **distinct non-empty tile** except mask 0, which is empty"
- "a tile's **ink** is symmetric under the mask's own symmetry"
- "at least one tile must have **ink in the interior and at each of its four edges**"
- "rebuilding at a different tile size **changes the tile dimensions**"
- "a rebuild at the same size is idempotent"

Against a recording stub none of these is directly assertable. They are all *recoverable*, but only by restating them as assertions over the recorded call sequence and its coordinates — e.g. distinctness becomes "the recorded path-command sequence differs for every pair of masks", symmetry becomes "the recorded endpoint set is invariant under the coordinate reflection the mask's symmetry induces", edge-and-interior ink becomes "some recorded lineTo endpoint lies on each of the four tile edges and some path passes through the centre". Task 1 must be rewritten in those terms as part of adopting C1's fix, or the coverage silently degrades to "the builder was called 256 times", which is the smoke test the plan says it is guarding against.

**Witness:** docs/superpowers/m2-plan-review-fixlist.md:15 ("A recording stub cannot substitute — the whole point is real ink") against :23 ("Option 1 is strongly preferred"). Plan line 136 lists all five ink assertions; line 138 adds a sixth ("at least one tile must have ink in the interior and at each of its four edges").

---

## [Minor] M2-R17 — Spec §7.2's third HUD element is the inventory chip row, which this plan defers to M1e; "tiles-left" is not in §7.2 at all
**Section:** Task 5 ("HUD is exactly three elements (spec §7.2)") vs the deferral table

Spec §7.2 lists exactly: (1) week/day clock doubling as pause and speed control, (2) score (trip count), (3) **inventory chip row** at the bottom, thumb-reachable. The plan's Task 5 cites §7.2 as the authority for "week/day clock, score, and tiles-left" while its own deferral table sends "Upgrade-card modal, **inventory chip row**" to M1e with the reason "Nothing to choose or spend yet".

So the plan simultaneously claims §7.2 compliance and defers §7.2's third element, substituting a fourth thing §7.2 never names. Tiles-left is the right choice for M2 (it is the only spendable resource that exists), but say so as an M2 substitution — "§7.2's third element is the inventory chip row, deferred to M1e; M2 shows tiles-left in that slot instead" — rather than citing §7.2 for it. The plan's own §7.2 claim about the always-expanded clock is correct and verified.

**Witness:** Spec §7.2 (docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md:328-336) enumerates "1. Week/day clock … 2. Score (trip count) … 3. Inventory chip row at the bottom". Plan line 40 defers "Upgrade-card modal, inventory chip row" to M1e; line 201 claims "HUD is exactly three elements (spec §7.2): week/day clock … score, and tiles-left".

---

## [Minor] M2-R18 — The clamp deliberately produces a 7-tick burst, so the assertion's threshold is unspecified and an implementer will pick one that passes
**Section:** Task 6, coverage: "the loop survives a 2,000 ms stall without a catch-up burst"

MAX_FRAME_DT = 250 ms clamps a 2,000 ms stall, and 250 / (1000/30) = 7.4999999999999991, so the drain runs **7** ticks and leaves alpha ≈ 0.5. That is Decision 1's intended behaviour ("it exists so a backgrounded tab does not run a thousand catch-up ticks" — a thousand, not seven). But Task 6 states the outcome as "without a catch-up burst", which reads as 0 or 1. An implementer asserting `ticks <= 1` gets a failing test and loosens the clamp or the assertion until it passes; one asserting `ticks <= 7` writes the tautology. State the number: "a 2,000 ms stall runs exactly 7 ticks, not 60 — the clamp bounds catch-up, it does not eliminate it." Same applies to Task 4's "pause … resumes it without a catch-up burst", where the correct value is 0 ticks and the clamp would otherwise give 7 — that contrast is what makes the pause test discriminating and it is currently not stated.

**Witness:** 250 / (1000/30) = 7.499999999999999 → floor 7 ticks, residual accumulator 16.6667 ms, alpha 0.5. Plan line 65 states MAX_FRAME_DT = 250 ms; line 226 states the assertion.

---

## [Minor] M2-R19 — The strip option is 12,288 px wide at the measured device tile size and risks the iOS canvas dimension cap, which the plan does not name as a constraint on the choice
**Section:** Task 1 ("256 offscreen canvases (or one strip of 256 cells — the implementer chooses and states why)")

At M0's measured 48 device px tile, a 256-cell strip is 256 x 48 = **12,288 px wide**. Older iOS WebKit caps a single canvas dimension well below that (commonly cited at 4,096-8,192 for the devices in the LOW tier this project explicitly targets), and an oversized canvas fails by silently producing a blank surface — which lands squarely in spec §8.5's "iOS fails silently on asset load errors … traced as the cause of black-screen-with-working-audio". A 16x16 tile grid (768 x 768) has the same locality benefit and no dimension risk.

The plan leaves the choice to the implementer "and states why" without naming the one constraint that should decide it. Say it: any single-surface layout must be a 16x16 grid, not a strip, and its dimensions must stay under 4,096 px on both axes at the maximum supported tile size x DPR.

**Witness:** M0 findings line 39: tile = 16 CSS px = **48 device px** on the test iPhone at DPR 3. 256 x 48 = 12,288 px. Spec §8.5: "iOS fails silently on asset load errors".

---

## [Minor] M2-R20 — The HUD clock should call sim's existing exact `weekOfTick`/`dayOfWeek` rather than reimplement them; the plan names neither, and the week is already stored in the header
**Section:** Task 5 (clock coverage and mutations)

`packages/sim/src/clock.ts` exports `weekOfTick(tick)`, `tickWithinWeek(tick)` and `dayOfWeek(tick) = ((tickWithinWeek(tick) * DAYS_PER_WEEK) / TICKS_PER_WEEK) | 0`, all re-exported from `packages/sim/src/index.ts`, and `H_WEEK` in the header already holds the current week (written every tick by `step`). Task 5 says only "the clock reads the correct week and day for hand-computed tick values", which authorises an independent reimplementation in `packages/game/src/hud.ts` — a second copy of the one derivation `TICKS_PER_DAY`'s comment exists specifically to protect.

This also makes the task's own mutation "use `TICKS_PER_DAY` as a divisor (it is deliberately 0)" better than it needs to be: if the HUD simply calls `dayOfWeek`, that mutation is not constructible in `game` at all, which is the stronger outcome (the same "the signature is the primary defence" idiom cars.ts and trips.ts already use). State it: the HUD calls `dayOfWeek`/`weekOfTick` from `sim` and owns no clock arithmetic of its own; the mutation moves to "read the week from a local counter instead of `H_WEEK`/`weekOfTick`".

**Witness:** packages/sim/src/clock.ts exports all three functions; packages/sim/src/index.ts line 5 re-exports './clock'. packages/sim/src/step.ts writes `s.header[H_WEEK] = weekOfTick(tick)` every tick.

---

## [Critical] M2R-01 — The snap rule's threshold equals the sim's maximum per-tick displacement, so interpolation never runs on any frame
**Section:** Decision 2 / Task 3 (interpolation, snap rule)

Decision 2: "interpolate only when the car's carPhase is unchanged between prev and curr AND its interpolated distance is under one cell. Otherwise snap." Task 3's mutation list ("use `>` instead of `>=` on the one-cell distance guard") fixes the intended comparison as `distance >= 1 cell -> snap`.

On the reachable manifold a car's cell moves by exactly one 8-neighbour step per tick, never more: `advanceCar` (cars.ts:213-237) performs at most one crossing per tick and `assertSingleCrossing` turns a second into a named throw, and `completeTrip`'s `carCell` write is documented in trips.ts:135-139 as a provable no-op. So prev->curr distance for a moving car is exactly 1.0 (orthogonal) or exactly sqrt(2) = 1.414 (diagonal), and 0 for a stationary one.

"Under one cell" is therefore false for every single move the game ever makes. The rule snaps always; the feature is dead on frame 1. Task 3's own vacuity bullet -- "an ordinary mid-route car IS interpolated, strictly between prev and curr at alpha = 0.5" -- cannot pass against the rule the same task specifies, and Task 2's "a car at alpha = 0.5 between two cells draws at the midpoint" cannot be reached from a real frame.

Note the guard fails under its own listed mutation too: with `>` instead of `>=`, orthogonal steps survive but every diagonal step (1.414 > 1) still snaps -- and the flow field prefers diagonals by construction (DIAG_COST 14 < 2x ORTHO_COST 20, spec decision 7 "diagonals beat stairsteps"), so most steps in most routes would snap. There is no threshold in the plan's units that separates "ordinary move" from "discontinuity", because the only per-tick jumps larger than one cell are off-manifold.

Fix: the rule needs a different discriminator entirely (see M2R-02 and M2R-04 -- with a progress-resolved position there is no on-manifold discontinuity to guard at all), and the plan must state the distance in the same units the position is computed in.

**Witness:** Orthogonal step: prev=(x,y), curr=(x+1,y), Euclidean distance 1.0, `1.0 >= 1` -> snap. Diagonal step: distance 1.41421356 -> snap under both `>=` and `>`. No other per-tick displacement exists: `assertSingleCrossing(residual, 2500)` (cars.ts:129) makes two crossings a throw, so max displacement is one step per tick.

---

## [Critical] M2R-02 — The interpolation model is cell-to-cell, but a car crosses a cell every 7.58 ticks -- the sub-cell term is named nowhere and the prev snapshot cannot hold it
**Section:** Decision 1 & 2 / Task 3 (interpolate.ts)

Decision 1 justifies the whole loop as "smooth car motion is most of this genre's feel". Decision 2 and Task 3 describe interpolation entirely in terms of prev cell, curr cell and alpha, and Task 3 says "Prev car positions live in a preallocated Int32Array snapshotted before each step" -- an Int32Array of cell indices.

At the shipped constants a car takes `ORTHO_COST * COST_UNIT_SCALE / speedUnits(LANE_SPEED_DEFAULT)` = 2500/330 = 7.576 ticks to cross an orthogonal cell (10.61 for a diagonal). `carCell` therefore changes on roughly one tick in eight. A prev-cell/curr-cell lerp renders the car motionless for ~6.6 ticks (0.22 s) and then smears one whole cell across a single 33 ms tick window. That is materially worse than not interpolating; it is a 4 Hz strobe, not smooth motion.

The correct resolved position needs the sub-cell term the sim already stores: `pos = cell + dirVector * (carProgress + alpha * speed) / (edgeCost(dir) * COST_UNIT_SCALE)`. That term appears nowhere in the plan -- not in Decision 2, not in Task 3, not in the fixlist's revised Decision 3, which lists `edgeCost`, `stepCell`, `routeStep` and the direction tables but never `carProgress`, `carRouteCursor`, `carRouteLen` or `COST_UNIT_SCALE`.

Consequences that must be written into the plan, not left to an implementer:
  - The prev snapshot must carry a *resolved float position* (Float32Array of x,y pairs), or prev copies of carProgress/carRouteCursor/carPhase/route bytes. An `Int32Array` of cells cannot represent it.
  - The return leg's direction is `OPPOSITE[routeStep(state, i, cursor - 1)]`, not `routeStep(cursor)` (cars.ts:208). The plan never names `OPPOSITE` or the cursor-1 read, so the half of every trip that scoring is defined on again has no stated algorithm.
  - Task 3's snapshot-order mutation ("snapshot prev after step instead of before") is only meaningful once prev holds something that changes every tick; against a cell snapshot it is a no-op on 7 ticks out of 8, so it needs a fixture pinned to a crossing tick.

**Witness:** 2500 / 330 = 7.576 ticks per orthogonal cell = 0.2525 s; 3500/330 = 10.61 for a diagonal. At 30 Hz sim / 60 Hz display, a cell-lerp car is drawn at the identical position for ~13 consecutive frames and then traverses a full cell in 2 frames. `packages/sim/src/cars.ts:211-237` and `packages/shared/src/constants.ts` (CAR_SPEED_UNITS_PER_TICK=330, COST_UNIT_SCALE=250).

---

## [Critical] M2R-03 — Nothing places houses or destinations -- no task owns a spawner, so M2 renders an empty board and Task 6's end-to-end fixture is unconstructible
**Section:** Scope / Task 6 ("Wire it, play it, deploy it")

`step()` (step.ts:124-166) runs seven phases: clock, inputs (placeRoad/eraseRoad only), demand, sources+sync, dispatch, movement, arrivals. Building placement is not among them. `buildings.ts:29-35` states it explicitly: "Nothing here is called from inside step() in this task -- building placement is an explicit, out-of-band call the M1e spawner will eventually drive". `placeHouse`/`placeDestination` have no production caller anywhere in `packages/`.

So a run started by Task 6's `main.ts` has H_HOUSE_COUNT = 0 and H_DEST_COUNT = 0 forever: no cars are created, `runDemand` has no destination to pin, `dispatchColour` returns immediately, and H_SCORE never moves. The playable artifact is an empty 24x40 board on which you can draw at most 30 cells of road (firstCity `startingTiles = 30`, and no tile income phase exists either) and watch nothing happen.

Task 6 nevertheless requires "a full trip is visible: a road is drawn through the input path, a car is dispatched, its drawn position advances monotonically along the route, and the score increments on return", plus the anti-smoke-test guards "score strictly increased" and "at least one car drawn at a position strictly between two cells". None of that is constructible from what the plan assigns. The Out table names the deferrals it wants read as deliberate (upgrade modal, motorways, audio, persistence) and does not name this one, and "M2 is deliberately not a complete game" lists cars-pass-through-each-other and runs-never-end but not "no buildings ever appear".

This needs an explicit decision with an owner: either M2 seeds buildings out-of-band in `main.ts` (and the plan must say so, and say what it costs -- an out-of-band mutation is not in the input log, so the seed+log-determines-the-run property the leaderboard rests on is broken for M2), or M2 pulls a minimal deterministic spawner forward from M1e as its own task. Task 6 also needs its fixture length stated: the first pin cannot arrive before `FIRST_PIN_DELAY_TICKS` (120) plus `PIN_PERIOD_TICKS`/slotCount, so a round trip is several hundred ticks.

**Witness:** `grep -rn 'placeHouse\|placeDestination' packages/*/src` returns only the definitions in buildings.ts -- zero call sites outside tests. `step.ts:143-163` shows the complete phase list; the only state-mutating input path is `placeRoad`/`eraseRoad`.

---

## [Critical] M2R-04 — Both discontinuities Decision 2 is built on do not exist, so the guard it calls load-bearing is a 0-detector and one coverage bullet fails a correct renderer
**Section:** Decision 2 ("Interpolation must snap, not lerp, across discontinuities")

Decision 2 rests on two claims, both false against the shipped sim:

1. "A car that completes a trip is teleported home (carCell = houseCell[carHome])." It is not. The return leg retraces the route cell by cell and ends *on* the house cell; trips.ts:135-139 says of that exact write: "The carCell write is a no-op on the reachable manifold and is not decoration: the retrace ends on the cell the route started from, which is the house cell." There is no teleport to snap across.

2. "phase is unchanged on an ordinary trip-end-to-idle-to-redispatch within one tick, and a phase check alone would miss it." Impossible: arrivals is phase 7 and dispatch is phase 5 of the same tick (step.ts). A car set to PHASE_IDLE by `completeTrip` cannot be re-dispatched until phase 5 of the *next* tick, by which time the prev snapshot has already recorded PHASE_IDLE. Every transition visible between two snapshots -- OUTBOUND->RETURNING, RETURNING->IDLE, IDLE->OUTBOUND, NONE->IDLE for a newly created car -- carries a phase change.

Three consequences the plan states as facts and that are wrong:
  - Task 3's mutation "snap on phase change only (must fail -- this is the trip-end case)" **survives**: the trip-end case is a phase change (RETURNING -> IDLE), so a phase-only rule catches it. The plan asserts a kill for a mutation that passes.
  - The distance guard, called "the load-bearing half", has no on-manifold detector at all (see M2R-01 for why, in the opposite direction, it also fires on everything). Task 3's vacuity requirement "the snap fixtures must have prev and curr more than one cell apart" can only be met by hand-writing an off-manifold state, which contradicts the same bullets asking for the trip-end and flip cases to be observed as *frames of a real run*.
  - Task 3's bullet "a trip-completing car ... renders at its house on the arrival frame and **never between the destination and the house**" is false of a correct renderer: the car is legitimately between the destination and the house for the entire return leg, ~7.6 ticks per cell. Written literally, this test fails correct code; scoped to the arrival frame only, it is vacuous.

Worth stating in the revised decision: once positions are progress-resolved (M2R-02), the outbound->return flip is *continuous* -- `carProgress` carries across the flip (trips.ts:104-108) and the reversed direction exactly cancels the carried residual, so prev and curr resolved positions coincide. The only genuine discontinuities left are car creation (a slot going PHASE_NONE -> PHASE_IDLE with a stale prev entry) and restore-from-snapshot, neither of which the plan enumerates.

**Witness:** trips.ts:149-159 (`completeTrip`) is reached only when phase is RETURNING and cursor <= 0, which `advanceCar` produces only after stepping onto the route's first cell = the house cell. Flip continuity: last outbound tick pos = c_{n-1} + 0.944d (progress 2360/2500); after the flip, cell = c_{n-1}+d, progress 140, dir = -d, pos = c_{n-1} + d - 0.056d = c_{n-1} + 0.944d -- identical.

---

## [Critical] M2R-05 — RenderFrame carries no liveness prefixes, so the renderer draws 80 phantom cars, 40 phantom houses and 16 phantom destinations stacked on cell 0
**Section:** Decision 3 / Task 1 (RenderFrame) / Task 2

Decision 3 defines the interface as "raw views -- Uint8Array of road masks, Int32Array of car cells" plus scalars, and Task 1 says "Name every field and its type here; later tasks consume it verbatim." No task names `H_HOUSE_COUNT`, `H_DEST_COUNT` or `carPhase`.

The sim has no sentinel for unused slots. state.ts:306-315: "A fresh GameState is all-zero in every region ... no -1 sentinel is written anywhere at creation. Unused house/destination slots are simply those at index >= H_HOUSE_COUNT/H_DEST_COUNT; unused cars are PHASE_NONE = 0." Every unused `carCell`, `houseCell` and `destCell` entry is therefore **0**, which is cell (0,0) -- a real, in-bounds, drawable cell.

On firstCity (`maxHouses = 40`, `CARS_PER_HOUSE = 2`, `maxDestinations = 16`) a renderer that iterates the arrays it is handed draws 80 cars, 40 houses and 16 destinations piled on the top-left tile from frame 1. Task 2's only bounds bullet -- "only cells inside the revealed grid are drawn" -- does not catch it, because cell 0 is inside the grid.

The fix is a plan-level interface decision: `RenderFrame` must carry `houseCount`, `destCount` and either `carPhase` (the only liveness marker cars have) or a `carLiveCount`, and Task 2 needs a coverage bullet that a state with live prefixes shorter than the array lengths draws exactly the live entities. Note this also decides whether idle/parked cars are drawn at all, which the plan never says.

**Witness:** `firstCity()` = `parseMap('firstCity', ROWS, 30, 40, 16, 5)` -> maxHouses 40, maxDestinations 16 -> `carPhase.length` = 80. `createState` zeroes every region except rng/mapIdentity/H_TILES, so `carCell[i] === 0` for all 80 slots at t=0.

---

## [Important] M2R-06 — The TickAction queue lifecycle is unspecified across zero-tick frames, and the one mutation covering it is a provable no-op
**Section:** Task 4 (input) / Decision 1 (the loop)

At 60 Hz half of all frames run zero ticks (16.67 ms against TICK_MS 33.33); at 120 Hz three frames in four do. Task 4 says only "Pointer events -> tile coordinates -> TickAction[], consumed by the next step", and Decision 1's loop sketch has no queue in it at all. The plan never states (a) that actions accumulate in a buffer that survives a zero-tick frame, (b) that the buffer is cleared after the drain loop rather than per frame, or (c) which of several ticks in a catch-up burst receives the batch.

The natural wrong implementation -- build `TickInputs` from this frame's pointer events, pass it to whatever ticks run, discard -- silently drops every action produced on a zero-tick frame, i.e. half to three quarters of a drag's segments. Nothing in Task 4's coverage list would see it: every listed test is a pure `screenToTile`/action-shape test with no loop attached.

Worse, the one mutation the plan pairs with this area, Task 6's "feed input to step twice", is a **provable no-op** and so certifies nothing. `placeRoad` re-applied to the same segment is exactly idempotent: `canPlaceRoad` computes cost 0 (both masks already non-zero), the budget check passes at any tile count, the two bits are re-OR'd with themselves, `cleared` is already 1, `H_TILES -= 0` -- the buffer is byte-identical and roads.ts:194-197 documents this. `eraseRoad` re-applied returns `false` at the `(maskA & bitA) === 0` guard before touching anything. So double-feeding is undetectable by any state hash or golden.

Needed: an explicit queue contract, a coverage bullet "an action produced during a frame that ran zero ticks is applied on the next tick that runs", and a replacement mutation that is actually observable (e.g. "clear the queue before the drain loop instead of after").

**Witness:** roads.ts:199-215 and :227-238. Re-place: cost = (maskA===0)+(maskB===0) = 0, `state.roads[a] |= 1<<dir` on a bit already set, `H_TILES -= 0`. Re-erase: returns false at line 238. Frame arithmetic: 8.33 ms frames against TICK_MS 33.33 -> ticks run on 1 frame in 4.

---

## [Important] M2R-07 — Pause freezes the accumulator but nothing resets the clock reference, so unpausing produces the full 7-tick catch-up the coverage bullet forbids
**Section:** Task 4 (pause) / Task 6 (stall) / Decision 1

Task 4 requires "pause stops the accumulator and resumes it without a catch-up burst" and Task 6 requires "the loop survives a 2,000 ms stall without a catch-up burst". Decision 1's mechanism cannot deliver either as stated.

`rawDt` is `now - lastTime`. If pause only skips the accumulate-and-drain step, `lastTime` goes stale for the whole pause; the first unpaused frame sees `rawDt` = pause duration, clamps it to MAX_FRAME_DT = 250 ms, and drains `floor(250 / 33.333)` = **7 ticks in one frame** -- 233 ms of simulation, cars jumping most of a cell, in a single frame. That is precisely a catch-up burst, just a bounded one. The same 7 ticks are what Task 6's 2,000 ms stall produces; Decision 1's clamp is explicitly designed to *permit* them ("it exists so a backgrounded tab does not run a thousand catch-up ticks"), so the two Task bullets contradict the decision they are testing.

The missing mechanism is one line the plan must own: on resume (and on the first frame) set `lastTime = now` and leave the accumulator alone, so `rawDt` for the resuming frame is one frame's worth. Same for cold start -- the plan never says how `lastTime` is initialised, and `lastTime = 0` against a `performance.now()` or `Date.now()` clock makes frame 1 a 7-tick burst too.

Related: spec decision 15 requires a hard pause on Telegram `deactivated` to be recorded in the input log "so server replay makes the same choice". The plan's pause is a purely local accumulator freeze with no log entry and no mention of the `deactivated` event, which the spike's telegram adapter does not expose either.

**Witness:** MAX_FRAME_DT / TICK_MS = 250 / 33.3333 = 7.4999 -> 7 ticks drained on the resuming frame, accumulator residual 16.67 ms, alpha 0.5. Task 3's own bullet ("a 5,000 ms frame runs at most MAX_FRAME_DT / TICK_MS ticks") states the same 7 as correct behaviour that Tasks 4 and 6 then call a burst.

---

## [Important] M2R-08 — TICK_MS is never stated, 1000/30 is not an integer, and "MAX_FRAME_DT / TICK_MS ticks, hand-computed" is 7.5
**Section:** Decision 1 / Task 3 (loop.ts)

Decision 1 names MAX_FRAME_DT (250 ms) but never TICK_MS. In a codebase whose entire culture is integer-only and whose sim constants are all integers, `const TICK_MS = 33` is the natural thing to write -- and it runs the simulation 1.01% fast forever (1000/33 = 30.30 ticks/s), which silently shifts the week clock, the demand rate and every score against a Worker replay that counts ticks rather than milliseconds. The plan should state `TICK_MS = 1000 / TICKS_PER_SECOND` as a float and say why the loop is the one place a non-integer is correct (Global Constraints already permit floats outside sim, but do not say this one is required).

Task 3's coverage bullet "a 5,000 ms frame runs at most MAX_FRAME_DT / TICK_MS ticks, hand-computed" evaluates to 7.5, which is not a tick count; the hand-computed answer is `floor(7.5)` = 7 and the bullet should say so. "A 16.7 ms frame ... the alpha advances by ~0.5" is also only true of the first such frame -- the second drains a tick and alpha *drops* from 0.501 to 0.002; as written a literal reading of the bullet fails on frame 2.

**Witness:** 1000/30 = 33.3333...; 250/33.3333 = 7.4999. With TICK_MS = 33: 30 ticks consume 990 ms, so 4500 ticks (one game week, nominally 150 s) elapse in 148.5 s -- a 1.5 s/week drift against wall clock and a 1.01% inflation of every rate the sim derives from TICKS_PER_SECOND.

---

## [Important] M2R-09 — C1's preferred fix (recording-stub canvas factory) cannot satisfy a single one of Task 1's coverage bullets, all of which are pixel assertions
**Section:** Task 1 (atlas coverage) -- building past fixlist C1

The fixlist resolves C1 by injecting a canvas factory so tests can pass "a recording stub", and calls option 1 "strongly preferred". The same fixlist entry also says, correctly, that "a recording stub cannot substitute -- the whole point is real ink". Both cannot be true, and Task 1's coverage list is entirely on the ink side:

  - "every one of the 256 masks produces a distinct non-empty tile" -- needs pixel readback and 32,640 pairwise bitmap comparisons.
  - "a tile's ink is symmetric under the mask's own symmetry" (and C5's replacement, mask 5's diagonal symmetry with horizontal/vertical asymmetry) -- needs pixels.
  - "at least one tile must have ink in the interior *and* at each of its four edges" -- needs pixels.
  - The mutations "skip the DPR multiply", "use a fixed stroke width", "draw round caps as butt caps", "swap the N and S bits" -- all only observable as ink.

Only "the mask->index mapping is the identity", "rebuilding at a different tile size changes the tile dimensions" and "a rebuild at the same size is idempotent" survive a recording stub. Asserting symmetry or distinctness over a recorded *call list* instead is the catalogue's "a test that reimplements the thing it checks" -- the test would re-derive the same stroke geometry it is checking.

The plan must choose, at plan level: adopt a real pixel backend for the atlas tests (jsdom + node-canvas, or a tiny hand-rolled software rasteriser that the factory returns), or delete the ink-based coverage and replace it with something a call recorder can actually falsify. Whichever way, the coverage list and the mutation list must be rewritten together -- as they stand, five of Task 1's seven mutations have no possible detector.

**Witness:** `node -e "typeof OffscreenCanvas"` -> undefined (recorded in C1); root devDependencies contain no canvas, no jsdom. A stub whose `fillRect`/`stroke` only append to an array returns no pixel data, so `getImageData` -- the only way to compare two tiles' ink -- does not exist on it.

---

## [Important] M2R-10 — The camera contradicts itself on which grid it fits, no revealed-region state exists anywhere, and the size Decision 5 ships is below the spec's own legibility floor
**Section:** Scope / Decision 5 / Task 2 ("revealed grid")

Three statements about the camera, and no two agree:
  - Scope: "a fixed camera fitting **the revealed grid**".
  - Decision 5: `floor(min(cssW / GRID_W, cssH / GRID_H))` with GRID_W/H = 24/40 -- the **full** grid -- "The whole 24x40 grid fits a portrait phone at this size".
  - Task 2 coverage: "only cells inside the **revealed** grid are drawn."

There is no revealed region in the codebase. `MapData` has `w`, `h`, `terrain`, `startingTiles`, `maxHouses`, `maxDestinations`, `groupCount` and nothing else; `GameState` has no reveal region; grep finds "reveal" only in two comments both saying expansion is M1d. Task 2's bullet is therefore unimplementable as written -- an implementer either invents a reveal rectangle M1d will then contradict, or silently drops the bullet.

The arithmetic also says Decision 5 picked the wrong grid. On a 390x844 CSS viewport the full grid gives `floor(min(16.25, 21.1))` = 16 CSS px tiles; spec 5.1 sets a hard floor: "Camera zoom-out hard-stops at a minimum tile size of **28 CSS px**." 16 is well under half of it. Fitting the *revealed* 14x22 instead gives `floor(min(27.86, 38.4))` = 27 px -- which is what makes the spec's 28 px floor a coherent number in the first place, and confirms the reveal-sized camera was the intent. Decision 5's citation of M0's measured 16 px as justification is citing a measurement of a benchmark scene, not a legibility decision.

Shipping at 16 px puts 2x3 destinations at 32x48 CSS px with 5-6 pastel colours to distinguish on a phone -- the exact failure spec 7.4 calls the original's weakest area -- and Task 6 deploys it as the milestone's one human-observable output.

**Witness:** `floor(min(390/24, 844/40))` = 16; `floor(min(390/14, 844/22))` = 27; spec line 138: "Camera zoom-out hard-stops at a minimum tile size of 28 CSS px." `grep -rn reveal packages/` returns only mapFormat.ts:21 and firstCity.ts:9, both describing M1d.

---

## [Important] M2R-11 — The HUD is drawn on the game canvas and every canvas point maps to a tile, so tapping the clock (which is the pause control) also draws a road
**Section:** Task 4 (input) / Task 5 (HUD) -- seam between them

Task 5: "HUD is exactly three elements ... Drawn on the same canvas; no DOM overlay." Task 4: pointer events -> tile coordinates -> TickAction, with "a tap in the letterbox produces no action" as the only rejection case. The HUD is not in the letterbox -- it is drawn over the board (spec 7.2 puts the clock at the top, and spec 7.2 makes that clock the pause control, so it must be tappable).

So a tap intended for pause, score or the clock also lands in a grid cell and emits a `place`/`erase` action, and a drag started on the HUD draws a road under it. Nothing in either task owns the hit-test ordering (HUD regions consume the event before the board sees it), and neither task's coverage mentions it. Task 4's round-trip bullet -- "for every tile in the grid, screenToTile(tileToScreen(t)) === t" -- actively asserts that *every* tile is reachable from a screen point, which is the property that makes the fall-through possible.

Second, related, gap: spec 8.3 says "**The top band is dead space.** ... No interactive element, score, or pause button may live there", and requires honouring both `safeAreaInset` and `contentSafeAreaInset`. The plan puts the HUD at the top, derives the camera from bare `cssW`/`cssH` with no inset subtraction, and never mentions safe areas -- even though the code it lifts from (`spike/src/telegram.ts`) already exports `contentSafeAreaTop()` and `stableHeight()` for exactly this. Task 5's coverage has no placement assertion at all.

**Witness:** spec line 400: "The top band is dead space ... No interactive element, score, or pause button may live there." `spike/src/telegram.ts` exports `contentSafeAreaTop()` and `stableHeight()`; Decision 5's formula uses `cssW`/`cssH` and neither.

---

## [Important] M2R-12 — Task 6's deploy target is inside spike/, which Global Constraints forbid modifying, and no vite/wrangler dependency or config is in any file list
**Section:** Task 6 (deploy) vs Global Constraints

Global Constraints: "Do not modify `spike/`. Lift code from it by copying, and say so." Task 6 file list: "Modify: **the existing Worker config** to serve the game bundle."

The only Worker config in the repo is `spike/wrangler.jsonc` (`name: laneways-spike`, `main: worker/index.ts`, `assets.directory: ./dist`, plus a D1 binding for the spike's results table). Modifying it to serve the game bundle both violates the constraint and overwrites the deployed M0 measurement app at its own URL -- the artifact the M0 findings document is still the record for.

Also unassigned: `vite` is named in the Tech stack but is not a devDependency of the root or of any package (root devDeps are exactly @types/node, eslint, typescript, typescript-eslint, vitest); the spike has its own local copy. No task's file list includes `packages/game/vite.config.ts`, a `wrangler.jsonc` for the game, or the devDependency additions. Task 5 creates `index.html` with nothing configured to build it.

The plan needs to say explicitly: a new deploy target (its own wrangler config and worker entry, copied from the spike), a new vite config, and the devDependency delta -- and whether the spike deployment stays live.

**Witness:** `find . -name 'wrangler*' -not -path '*/node_modules/*'` -> only `spike/wrangler.jsonc`; `find . -name 'vite.config*'` -> only `spike/vite.config.ts`. Root package.json devDependencies contain no vite and no wrangler.

---

## [Important] M2R-13 — "Rebuild driven by measured tile size" against Telegram's continuously-changing viewport is a 256-tile rebuild per frame, and the only guard offered is an idempotence test a rebuild storm passes
**Section:** Decision 5 / Task 1 (atlas rebuild) / Task 6

Decision 5: "the rebuild must be driven by *measured* tile size rather than a resize event -- Telegram's viewport changes for reasons other than rotation (viewportStableHeight, the app bar)." Spec 8.3 says the opposite about *how* to measure: "Size against `viewportStableHeight`, never `viewportHeight` -- the latter changes continuously while the sheet is dragged and Telegram's own docs warn the refresh rate cannot follow it. **Re-layout only on `viewportChanged` where `isStateStable === true`, debounced.**"

Measuring per frame from an unstable height means the measured tile size changes on most frames of a sheet drag, and each change re-renders 256 tiles at tileSize x dpr (2.25 MiB of pixels at 16 px / DPR 3) inside the frame budget. On a LOW-tier Android -- the device class M0 explicitly could not test -- that is a multi-frame stall on the most common gesture in the client.

The plan's guards do not see it. Task 1's "a rebuild at the same size is idempotent" is *passed* by a rebuild storm (rebuilding every frame is idempotent). Task 6's "a resize rebuilds the atlas and the next frame draws at the new tile size" only tests the positive direction. Missing: "the atlas is not rebuilt when the measured size is unchanged", asserted as a rebuild *count* across N frames, plus a stated debounce/stability rule tied to `viewportStableHeight` and `isStateStable`.

**Witness:** 256 tiles x (16 x 3)^2 px x 4 B = 2.25 MiB re-rasterised per rebuild. spec line ~396 (8.3) mandates re-layout only on stable viewport events; Decision 5 mandates per-measurement rebuild; both cannot hold.

---

## [Important] M2R-14 — Two shadow coverage bullets in the same list contradict each other
**Section:** Task 2 (shadow layer coverage)

Task 2 requires both:
  - "the shadow layer is composited exactly once per frame **regardless of sprite count**", and
  - "**zero sprites still composites zero shadow blits**, not one over an empty layer".

Sprite count zero is a sprite count. One implementation satisfies the first and fails the second, the other vice versa; no implementation satisfies both. Written as tests, one of the two is red on any correct build, and an implementer resolves it silently -- which is how the plan's own catalogue describes the shape it exists to prevent.

The intended rule is presumably "at most once per frame, and zero when there are no shadow shapes"; say that, and make the assertion a *count* of composite calls at sprite counts 0, 1 and N.

Separately unstated in the same task: the shadow layer is an offscreen surface that must be cleared each frame, or shadows from previous frames persist; and the frame-order assertion ("terrain -> roads -> shadow layer -> buildings -> cars") becomes conditional the moment the zero-sprite case skips the composite, so the order test's fixture must be the one with sprites -- which the vacuity bullet already requires, but the order bullet does not reference.

**Witness:** The two bullets are adjacent in Task 2's "Coverage required" list. Sprite count = 0 satisfies "regardless of sprite count" in the first and is explicitly excluded by the second.

---

## [Important] M2R-15 — The zero-allocation-in-the-frame-loop constraint is violated by the plan's own input design, and the "render never writes sim state" enforcement it names does not exist
**Section:** Global Constraints / Task 4 / Decision 3

Two Global Constraints are stated absolutely and neither has a mechanism behind it.

(a) "**Nothing allocates inside the frame loop.** Same rule as the tick, same reason, same enforcement (construction and review; there is no allocation profiler)." But `step` takes `inputs: TickInputs` = `{ actions: readonly TickAction[] }`, and each `TickAction` is `{ kind, a, b }` -- an object literal per tile entered during a drag, plus a wrapper object and an array per tick. At 30 ticks/s an idle game allocates 60 objects/s just to say "no input" unless a shared frozen `EMPTY_INPUTS` is named, and a drag allocates per segment. The plan must either name the pooling/reuse strategy (a preallocated action pool with a mutable length, a module-level EMPTY_INPUTS) or downgrade the constraint for `game` and say why -- as written, review has no standard to enforce.

(b) "**`render` never writes sim state.** It receives readonly views and primitives. **Enforced by a source scan, not by convention.**" No task's file list contains that scan; the existing scan in `packages/sim/test/determinism.test.ts` is scoped to `../src` and `../../shared/src` (confirmed in fixlist C4) and will not reach the new packages. And `readonly Uint8Array` is not a read-only array: TypeScript's `readonly` modifier applies to the property, not the elements, and there is no `ReadonlyUint8Array` -- `frame.roads[i] = 0` type-checks and runs. So the type-level half of the guarantee is not one either. Assign the scan (import-graph check: `packages/render/src/**` imports nothing from `@laneways/sim`) to Task 1 alongside the eslint-coverage test the fixlist already added there.

**Witness:** step.ts:21-37 defines `TickAction`/`TickInputs` as object types. In TS, `interface F { readonly roads: Uint8Array }` permits `f.roads[0] = 1`; only reassignment of `f.roads` is blocked. `packages/sim/test/determinism.test.ts` scan roots are `../src` and `../../shared/src`.

---

## [Minor] M2R-16 — Two named mutations survive the coverage they are paired with, and one is no longer constructible after the C2 fix
**Section:** Task 6 (mutations) / Task 2 (mutations)

Task 6, "draw before stepping": every Task 6 assertion still passes. Positions still advance monotonically along the route, the score still increments on return, there are still >10 distinct drawn positions, and roads placed > 0. Drawing one tick early is invisible to all four. Catching it needs an assertion tying a drawn position to a tick number (e.g. the first frame after the first dispatch already shows the car off its house cell).

Task 6, "drop the interpolation alpha (pass 0 always)": caught today only by "at least one car drawn at a position strictly between two cells" -- and that detector evaporates once positions are progress-resolved per M2R-02, because a progress-resolved car is strictly between two cells on almost every tick regardless of alpha. The vacuity guard's discriminating power depends on which interpolation model is chosen, and the plan should say which assertion survives the model it picks.

Task 2, "use `carCell` directly instead of the interpolated position": after the fixlist's revised Decision 3, `render` never receives `carCell` at all -- it receives resolved float positions. The mutation is not constructible in the package it is listed against. Task 2's mutation list needs the same rewrite the fixlist already gave Task 2's coverage bullet.

**Witness:** Task 6's four listed assertions are order-invariant with respect to a one-tick render offset. With progress-resolved positions, `carProgress` is 0 only on the dispatch tick and at trip end, so `pos` is non-integral on ~7 ticks in 8 with alpha = 0.

---

## [Minor] M2R-17 — Task 1 modifies two files that do not need it or do not exist, the DOM lib is missing, and one of the two offered atlas layouts exceeds iOS canvas limits
**Section:** Task 1 (file list) / Decision 4 (atlas layout)

Four checkable toolchain facts the plan assumes wrongly:
  - "Modify: root `pnpm-workspace.yaml`" -- it already globs `packages/*`; adding `packages/render` and `packages/game` needs no edit.
  - "Modify: root `tsconfig.json` references" -- **there is no root `tsconfig.json`**. The root has `tsconfig.base.json` only, and packages do not use project references; each runs its own `tsc --noEmit`.
  - `tsconfig.base.json` sets `"lib": ["ES2022"]` with no `"DOM"`. Every `CanvasRenderingContext2D`, `HTMLCanvasElement`, `PointerEvent`, `document` and `requestAnimationFrame` reference in `render`/`game` fails `pnpm typecheck` until the new packages' tsconfigs add the DOM lib. Loud rather than silent, but it belongs in Task 1's stated file list next to the vitest-config and eslint-block additions the fixlist already put there.
  - Decision 4 offers the implementer "256 offscreen canvases (or one strip of 256 cells -- the implementer chooses and states why)" with no constraint. At the plan's own shipped size the strip is 256 x 16 x 3 = **12,288 device px wide**, past every documented iOS Safari canvas dimension limit (4,096 on older devices, 8,192 on current ones), where the result is a silently blank or downscaled backing store -- invisible to any Node-side test and visible only on the device Task 6 deploys to. If the strip stays on the menu, the plan should require a 16x16 grid layout (768 x 768) instead of a 1x256 strip.

**Witness:** `ls /Users/razielgershoni/development/mini-motorways-clone/*.json` -> `package.json`, `tsconfig.base.json` only. `pnpm-workspace.yaml` contains `- 'packages/*'`. 256 * 48 = 12,288.

---

## [Minor] M2R-18 — Three smaller mismatches: the third HUD element is not spec 7.2's third, the TICKS_PER_DAY mutation is not constructible if the HUD reuses sim's clock, and the goldens bullet cannot fail
**Section:** Task 5 (HUD) / Task 6 (goldens)

  - Task 5: "HUD is exactly three elements (spec 7.2): week/day clock, score, and tiles-left." Spec 7.2's three are clock, score and the **inventory chip row**, which the plan's Out table defers to M1e. Tiles-left is a substitution, and it should be labelled as one rather than cited to 7.2 -- the citation makes a deviation read as compliance.
  - Task 5's mutation "use `TICKS_PER_DAY` as a divisor (it is deliberately 0)" is only constructible if the HUD re-implements the clock. `dayOfWeek`/`weekOfTick`/`tickWithinWeek` already exist in `packages/sim/src/clock.ts`, are exported through the sim index, and are already covered by sim's tests. If the HUD calls them (it should), the mutation has no home in `game`; if it does not, the plan is asking for a second implementation of a tested function -- the catalogue's "a test that reimplements the thing it checks". Say which, explicitly.
  - Task 6's "the sim's four goldens are unchanged by anything in `game` or `render`" cannot fail: `sim` is untouched and the goldens are computed inside sim's own suite, which does not import either new package. It is a restatement of the Global Constraint, not a test. Harmless, but it should not be counted as coverage.
  - Not in the Out table and worth naming: a road erased under an in-flight car leaves that car visibly driving on bare terrain, because `runMovement` never reads `state.roads` (cars.ts:29-33) and M2 does not render spec 5.11's ghost lanes. That is the first visual artefact a player will find, and the deferral table is the place it should be pre-empted.

**Witness:** spec 7.2 item 3 is "Inventory chip row at the bottom"; `packages/sim/src/clock.ts:17` already implements `dayOfWeek` without any divisor; `packages/sim/src/index.ts` re-exports `./clock`.

---

## [Critical] M2-01 — The interpolation mechanism produces a frozen car that teleports one whole cell every 7.58 ticks — sub-cell progress is never mentioned
**Section:** Decision 2 ("Interpolation must snap, not lerp") + Task 3 ("Prev car positions live in a preallocated Int32Array")

Decision 1 exists because "smooth car motion is most of this genre's feel". Decision 2 then defines the only position model in the plan: prev cell vs curr cell, lerped by alpha, and Task 3 stores prev positions in an `Int32Array`, which can hold a cell index and nothing else. But a car does not move one cell per tick. `runMovement` adds `speedUnits(LANE_SPEED_DEFAULT)` = 330 progress units per tick against an orthogonal threshold of `ORTHO_COST * COST_UNIT_SCALE` = 10*250 = 2500 (diagonal 3500). A car therefore changes `carCell` on 1 tick in 7.576 (1 in 10.6 diagonally) and its cell is IDENTICAL on prev and curr for the other 86.8% of ticks. Under the plan as written, alpha does nothing on those ticks — the car is pinned to a cell centre — and then slides a full tile in the single 33 ms tick where the cell changes. That is worse-looking than not interpolating at all, and it is exactly the artefact Decision 1 was written to remove.

The missing term is `carProgress / (edgeCost(dir) * COST_UNIT_SCALE)`, the 0.132-of-a-cell-per-tick sub-cell offset. It appears nowhere in the plan. (The fix-list's C2 table implies it — it names `edgeCost`, `stepCell`, `routeStep` as needed — but C2 is about which PACKAGE interpolates, and the plan body it corrects still describes cell-to-cell lerp only.) The prev snapshot must carry prev progress, prev cursor and prev phase — or, per C2's resolution, prev RESOLVED float x,y — not an `Int32Array` of cells.

Every coverage bullet in the plan passes under the broken implementation. Worse, Task 3's own vacuity self-check actively steers implementers away from the failing case: it demands "a car whose prev and curr cells actually differ", which is precisely the 13% of ticks where cell-only interpolation happens to look right. No bullet requires the discriminating fixture: prev cell === curr cell with progress advanced.

**Witness:** Fixture: one car, PHASE_OUTBOUND, straight orthogonal route, carCell=C, carProgress 330 -> 660 across one step (verified: 330 < 2500, so `advanceCar` takes the `progress < threshold` early return and carCell is unchanged). Correct resolved position moves 0.132 of a cell between the two frames; the plan's mechanism renders both frames at the centre of C. Add: `node -e` on the constants gives 2500/330 = 7.5757 ticks per orthogonal cell.

---

## [Critical] M2-02 — Two of the loop's four hand-computed tick counts are arithmetically wrong; the 100 ms bullet is false by execution
**Section:** Task 3, Coverage required ("a 100 ms frame runs exactly 3 ticks"; "a 5,000 ms frame runs at most MAX_FRAME_DT / TICK_MS ticks, hand-computed")

TICK_MS = 1000/30 = 33.333333333333336 in IEEE-754 (the nearest double to 100/3 is ABOVE 100/3). Draining an accumulator of 100 by repeated subtraction gives 66.66666666666667, then 33.33333333333332 — which is strictly LESS than 33.333333333333336. The loop stops. **A 100 ms frame runs 2 ticks, not 3**, and leaves alpha = 0.9999999999999996. The required test fails against a correct implementation of the plan's own pseudocode, and an implementer will either report a phantom bug or "fix" the accumulator (epsilon fudge, integer accumulator, `Math.round`) to satisfy a bullet that is simply mis-derived. The plan states no accumulator representation, so this is not an implementation choice it delegated.

Second error in the same block: "at most MAX_FRAME_DT / TICK_MS ticks" = 250/33.333 = 7.5. The accumulator is carried across frames and can legitimately hold up to TICK_MS - epsilon on entry, so the real bound is floor((MAX_FRAME_DT + acc_prev)/TICK_MS) = **8**, not 7. The bullet is only true from a fresh loop, which is exactly how the test will be written, so the wrong bound ships as a verified fact and Task 6's "survives a 2,000 ms stall without a catch-up burst" inherits it (a 2,000 ms stall runs 7 ticks — the plan never says what "without a catch-up burst" asserts).

**Witness:** Executed: `node -e "const T=1000/30;let a=100,n=0;while(a>=T){a-=T;n++};console.log(n,a,a/T)"` -> `2 33.33333333333332 0.9999999999999996`. And from acc_prev=33.0: a 5,000 ms frame runs 8 ticks.

---

## [Critical] M2-03 — The stated justification for the distance guard is false against the real tick order; the mutation the plan says "must fail" is a provable no-op and its fixture is not constructible
**Section:** Decision 2 ("The distance guard is the load-bearing half — phase is unchanged on an ordinary trip-end-to-idle-to-redispatch within one tick") + Task 3 Mutations ("snap on phase change only (must fail — this is the trip-end case)")

Decision 2 asserts that a phase check alone would miss the trip-end teleport, because a car can go trip-end -> idle -> redispatch "within one tick". It cannot. `runArrivals` is phase 7 of `step` — the LAST phase — and `runDispatch` is phase 5. So within a single `step`, arrival strictly follows dispatch: a car that arrives on tick T cannot be re-dispatched until tick T+1. `trips.ts:151` writes `state.carPhase[i] = PHASE_IDLE` on arrival, and Decision 1's own loop snapshots prev immediately before every `step`, so prev is always exactly one tick behind. The observed pair across a trip end is therefore always RETURNING -> IDLE (then IDLE -> OUTBOUND a tick later). **Phase always changes.**

Consequences, all bad in the same direction: (a) the named mutation "snap on phase change only" is a 0-detector no-op, and the plan records it as one that "must fail" — the exact fake-kill shape the catalogue's last entry warns about; (b) the coverage bullet "a car that completes a trip renders at its house on the arrival frame and never between" passes with the distance guard deleted, so the guard the plan calls load-bearing has no observer at all; (c) the fixture an implementer would build to honour the plan's claim — a trip-completing car whose phase is unchanged between prev and curr — is not constructible on the reachable manifold, so they will either fabricate an off-manifold state and record a false kill, or quietly drop the bullet. The correct statement is the inverse: the phase check carries the trip-end case, and the distance guard is defensive against nothing M1c can produce (per-tick motion is 0.132 cells; the only >1-cell jump is the teleport home, which always coincides with a phase change). If it is kept, it needs a comment saying no test can exist for it — not a coverage bullet claiming one does.

**Witness:** `packages/sim/src/step.ts` phases 5 and 7 (dispatch before arrivals); `packages/sim/src/trips.ts:151-156` sets PHASE_IDLE, carCell = houseCell[carHome], carProgress = 0 in one place. Try to write Task 3's fixture: there is no sequence of `step` calls after which prev.phase === curr.phase and carCell moved from a carpark to a house.

---

## [Critical] M2-04 — M0's only "Adopt now" performance decision — cap DPR at 2 (1.5 on LOW) — is absent from the plan, and `performanceClass` is never read
**Section:** Decision 5, Decision 4 ("pre-rendered once at device pixel ratio"), Task 5, and the whole plan

M0 §7's decision table contains exactly one row marked **Adopt now**: "`performanceClass`-gated degradation: Yes, and the lever is DPR, not sprite count. Cap `devicePixelRatio` at 2 universally, 1.5 on `performanceClass === 'LOW'`", justified as "the largest single lever available" with a worked example (~5 ms vs ~8.5 ms at 400 sprites on a LOW Android, "the difference between clearing and blowing the budget"). The plan mentions `devicePixelRatio` zero times, `performanceClass` zero times, and no cap of any kind. It instead says the atlas is built "at device pixel ratio", full stop, and lists "skip the DPR multiply" as a mutation — i.e. it hard-codes the uncapped behaviour as the correct one.

On the one device M0 actually measured (DPR 3) this is 2.25x the pixels of the adopted design, on every fill, every blit and every clear, for the whole frame. It also compounds with the shadow layer (M2-05) and the atlas memory (2.25 MiB at 16 px tiles / 6.89 MiB at 28 px tiles, vs 1.0 / 3.06 MiB capped).

And it silently invalidates Decision 5's crispness claim. Decision 5 hedges with "at integral DPR" and then gives no rule for anything else — but the Android population is overwhelmingly non-integral (2.625, 2.75, 3.5). At DPR 2.75 with a 17 CSS px tile the atlas is 46.75 device px and every tile origin lands on a fraction of a device pixel, so every road tile is resampled and the joins the 256-entry atlas exists to get right are blurred. Capping DPR at 2 makes tile*dpr integral for every integer tile size, which is the same fix — the plan drops the cap and inherits the artefact with no decision point recorded.

**Witness:** grep -ic devicePixelRatio / performanceClass over the plan -> 0 / 0. M0 §7 row "performanceClass-gated degradation", status "Adopt now". Arithmetic: 406x870 CSS at DPR 3 = 3,178,980 device px vs 1,412,880 capped at 2.

---

## [Critical] M2-05 — The shadow layer re-imports the exact cost structure M0 used to delete the road bake, and its cost claim omits the per-frame full-canvas clear
**Section:** Decision 6 ("One shadow layer, composited once ... unlike the road bake it is justified: the layer adds one blit and removes N alpha compositions")

Decision 6 defends itself by contrast with the bake M0 killed. On M0's own numbers the contrast does not hold, and the accounting in the plan is short by a factor of two.

A full-canvas offscreen layer costs, per frame: one full-canvas CLEAR plus one full-canvas COMPOSITE. At the M0 device's 1218x2610 that is 2 x 3,178,980 = **6,357,960 device px per frame**, ~0.64 ms at the fitted ~10 Gpx/s. For comparison, M0 costed the entire per-frame road layer at 0.168 ms and the whole rejected bake at 0.318 ms. The plan's shadow layer is thus **~2x the cost of the thing M0 deleted and ~3.8x the entire road layer**, on the fastest mobile device anyone has measured, before Android. It also carries **+12.13 MiB** of surface memory — the identical figure M0 charged against the bake in "a memory-constrained iOS WKWebView" — and it is a second full-canvas surface and an extra code path, the other two costs M0 charged.

The claim "removes N alpha compositions" values the thing M0 measured as nearly free: a sprite is ~96% CPU path work and ~4% pixels (829 device px each), so 500 shadow sprites drawn directly are ~415 kpx of fill, ~0.04 ms — 1/15th of the layer's own overhead. The layer is still required (spec §6 wants non-additive overlap and it cannot be had otherwise), so the finding is not "drop it": it is that the plan's stated cost is wrong by 2x in the term that dominates, no task owns sizing the layer, and M0 §3.3 already named the fix nobody has made — size the surface to GRID BOUNDS, not the canvas. At 16 px tiles the grid is 1152x1920 device px, 36% of the canvas; with DPR capped at 2 (M2-04) it is 768x1280, 12% of the uncapped canvas. Neither Decision 6 nor Task 2 says a word about the layer's dimensions, its clear, or a dirty-rect bound, and no coverage bullet observes cost at all.

**Witness:** Arithmetic against M0 §3.2's own table: baked = 3,178,980 px = 0.318 ms (rejected); shadow layer = clear 3,178,980 + composite 3,178,980 = 6,357,960 px = 0.636 ms (kept, described as "one extra blit"). Memory: 1218*2610*4 = 12.13 MiB, the same number M0 §3.4 charged the bake.

---

## [Critical] M2-06 — The camera fits two different grids in two places, one of them violates spec §5.1's 28 CSS px floor, and the "revealed grid" it names does not exist in any code
**Section:** Scope ("a fixed camera fitting the revealed grid"), Deferred table ("The whole revealed grid fits a portrait viewport at M2's fixed camera"), Decision 5, Task 2 coverage ("only cells inside the revealed grid are drawn")

Three mutually exclusive readings appear in one plan. (1) Decision 5: `tileSize = floor(min(cssW / GRID_W, cssH / GRID_H))` — GRID_W/GRID_H are 24/40, the FULL grid — giving 16 CSS px on the M0 device, which the plan quotes approvingly. (2) Scope and the Deferred table: the camera fits the REVEALED grid, and that is the stated reason pan/zoom can be deferred to M2b at all. (3) Task 2 coverage: "only cells inside the revealed grid are drawn".

Reading (1) violates spec §5.1: "Camera zoom-out hard-stops at a minimum tile size of **28 CSS px**". 16 px is 57% of that floor. It is not reachable by any portrait phone either: 24 columns x 28 px = 672 CSS px of width, and phones are 390-430. So the full-grid camera can NEVER satisfy the spec's own minimum, which means the premise the pan/zoom deferral rests on is false under reading (1). Reading (2) does satisfy it — 14 x 28 = 392 <= 406 CSS px, 22 x 28 = 616 <= 870 — and yields a 29 px tile on the M0 device, nearly double reading (1)'s. This is not a cosmetic difference: it changes atlas memory 3.3x (2.25 MiB -> 6.89 MiB at DPR 3), changes the letterbox, changes every hand-computed pixel coordinate in Tasks 2, 4 and 6, and changes the input transform round-trip.

And reading (2)/(3) cannot be implemented: **the revealed region exists only in spec decision 4 ("~24x40 grid revealed from 14x22"). It has no representation anywhere in the codebase.** `MapData` has `w`/`h` only, with an explicit comment that expansion "reveals cells within this grid" — a feature scheduled for M1d. There is no revealed-bounds constant, no state field, no world field. So `RenderFrame` has no source for it, Task 2's bounds test has nothing to test against, and defining it is unassigned work that also touches `shared` (which the Global Constraints treat as frozen). At 16 px tiles the playable 14x22 area occupies 224x352 of a 406x870 screen — under a quarter of the display, with a 16 px tap target against a ~44 px fingertip, and spec §7.3's auto-zoom mitigation deferred to M2b.

**Witness:** floor(min(406/24, 870/40)) = 16; floor(min(406/14, 870/22)) = 29; spec §5.1 floor is 28. `grep -rn revealed packages/` returns two comments in `shared/src/mapFormat.ts` and `shared/src/maps/firstCity.ts`, both saying expansion is M1d; no field, no constant, no state.

---

## [Critical] M2-07 — Nothing places houses or destinations — the milestone's Goal and its end-to-end test are both unreachable from the work the plan assigns
**Section:** Task 6 ("Assemble: create the canvas, boot Telegram, build the world and state, run the loop, feed input, draw") and the Goal

The Goal is "draw a road with your finger, watch a car take it, see the score tick", and Task 6's end-to-end asserts "a car is dispatched ... the score increments on return". Both require at least one house and one same-colour destination to exist. There is no spawner in the sim: `placeHouse` (`buildings.ts:332`) and `placeDestination` (`buildings.ts:422`) are direct API calls, not `TickAction`s, and `step.ts` handles exactly two action kinds, `place` and `erase` — making building placement an action is explicitly M1e's job (step.ts's own tick-order comment says so). `createState` produces an empty board.

So "build the world and state" silently contains "author a starting city and call `placeHouse`/`placeDestination` for it" — a design task with real content (which colours, how many, where, respecting the Chebyshev spacing and driveway rules, on `firstCity`'s river-and-mountain terrain) that appears in no file list, has no coverage bullet, and is not in the deferral table that the plan says exists "so nobody reads the gap as an oversight". It is also the fixture on which every Task 6 anti-smoke guard depends: if the authored city has no reachable same-colour pair, "score strictly increased" fails and the failure will read as a renderer or loop bug.

Related silence: nothing says whether that starting city is shared between `main.ts` and the e2e fixture, or authored twice — and if it is authored twice, the e2e is testing a board the game never shows.

**Witness:** `packages/sim/src/step.ts` accepts only kinds 'place'|'erase' (throws otherwise). `grep -rn "export function spawn" packages/sim/src` -> nothing. `createState(seed, map)` writes no buildings. Run Task 6's e2e against a state built by `createState(firstCity())` alone: `runDispatch` has no sources, no car is ever dispatched, H_SCORE stays 0.

---

## [Critical] M2-08 — The HTML shell has no stated requirements — including the Telegram SDK script, without which the entire boot sequence silently no-ops and no planned test can see it
**Section:** Task 5 (Files: create `index.html`), File structure ("`packages/game/index.html` | The shell")

`index.html` is one row in a file table and one word of specification ("The shell"). Nothing in the plan says what must be in it. The one that fails silently on a phone: **`<script src="https://telegram.org/js/telegram-web-app.js">`**. The adapter being lifted (`spike/src/telegram.ts`) resolves the WebApp through `globalThis.Telegram?.WebApp` and returns `null` when it is absent; `call()` returns early on null, and `atLeast()` returns `false` when `isVersionAtLeast` is missing. So with the script tag omitted or blocked, `boot()` executes and does **nothing** — no `ready()`, no `expand()`, no `disableVerticalSwipes()`, no fullscreen — and throws no error. The game renders, so it looks like it works. Every test the plan specifies for Task 5 asserts against a recording stub installed on `globalThis.Telegram`, which is precisely the object production is missing; there is no bullet that observes the real page.

The same row silently owns four more spec-mandated items, none named anywhere in the plan: `touch-action: none` on the canvas and `overscroll-behavior: contain` (spec §8.3, and the spike's own index.html has both), the viewport meta with `viewport-fit=cover, user-scalable=no`, `height: var(--tg-viewport-stable-height, 100vh)` (spec §8.3: "plain 100vh is unreliable inside the webview"), and `Cache-Control: no-store` plus content-hashed assets (spec §8.5, because Telegram Desktop caches Mini App bundles somewhere its own cache-clear does not reach). Spec §8.5 also warns that iOS fails SILENTLY on asset load errors — a black screen with working audio traced to one font — which is the failure mode this whole row invites.

**Witness:** `spike/src/telegram.ts:20-24` (`webApp()` returns null), `:27-35` (`atLeast` false without the SDK), `:37-48` (`call` early-returns). Delete the script tag from `spike/index.html` and `boot()` completes normally with zero side effects. Then check the plan for `touch-action`, `telegram-web-app`, `no-store`: 0 occurrences each.

---

## [Important] M2-09 — Nothing is assigned to re-measure the viewport: the atlas rebuild trigger is forbidden from being an event, given no other driver, and its "settled" signal is never named
**Section:** Decision 5 ("the rebuild must be driven by *measured* tile size rather than a resize event") vs Task 6 coverage ("a resize rebuilds the atlas") and fix-list C6 ("size it again once the fullscreen transition has settled")

Decision 5 forbids the obvious trigger ("never from a resize event") because Telegram's viewport changes for reasons other than rotation. It then names no replacement. Task 5 measures at boot; C6 adds a second measurement "once the fullscreen transition has settled"; Task 6's coverage bullet says "a resize rebuilds the atlas" — reinstating the event Decision 5 banned. So across three sections there are three incompatible triggers and no owner.

The mechanism spec §8.3 actually prescribes is never mentioned in the plan: re-layout on `viewportChanged` **where `isStateStable === true`**, debounced, sizing against `viewportStableHeight`. Neither `viewportChanged` nor `isStateStable` appears anywhere. Nor does either safe-area inset system, which §8.3 says must BOTH be honoured (`safeAreaInset` and `contentSafeAreaInset`) — the lifted spike helper exposes only `contentSafeAreaInset.top`.

"Settled" is also undefined. The spike's mechanism was three `await nextFrame()` calls before re-reading the inset — adequate for a benchmark that reads a number once, and a race for a game whose atlas, camera, letterbox and input inverse all derive from that measurement. If the settle heuristic fires early, the atlas is built at the wrong tile size and, with no event-driven trigger, is never rebuilt: a permanently blurry or mis-scaled board with no error.

The remaining option — measure every frame — collides with the Global Constraint "Nothing allocates inside the frame loop": `getBoundingClientRect()` allocates a DOMRect per call, and a layout read per frame forces a reflow. The plan does not say this is allowed or forbidden.

**Witness:** Plan greps: `viewportChanged` 0, `isStateStable` 0, `safeArea`/`safe-area` 0. `spike/src/main.ts:71-95` — three rAFs, then re-read `contentSafeAreaTop()` and re-set the height, with the comment C6 cites. Construct: boot on a client where the fullscreen inset publishes on frame 5; the atlas is built at the frame-3 tile size and nothing ever rebuilds it.

---

## [Important] M2-10 — Every touch-platform hazard is absent: no touch-action policy, no pointercancel path, no multi-touch rule, and no answer for clients below 7.7
**Section:** Task 4 (Input — tile-snapping draw, erase mode, pause)

Task 4 is specified entirely as a pure function — screen coords in, `TickAction[]` out — and every coverage bullet is a coordinate assertion. Four platform behaviours that will bite on a real phone are not mentioned:

(a) **Default gestures.** The plan never says to set `touch-action: none`, never mentions `preventDefault`, and never mentions pointer capture. Without them a drag scrolls, rubber-bands, or triggers text selection, and on iOS a horizontal drag can trigger back-navigation.

(b) **Clients below 7.7.** `disableVerticalSwipes()` is 7.7+ and a silent no-op below. Task 5 correctly gates it and asserts the gate — and then nothing addresses the consequence: on a 7.6 client Telegram's vertical swipe-to-close is live, so a downward road-drawing drag can close the Mini App mid-stroke. Spec §8.3 explicitly forbids the legacy workarounds, so this needs a stated decision (accept it, or `touch-action`/`preventDefault` on the canvas only). The plan makes none.

(c) **`pointercancel`.** Telegram's swipe, an incoming call, a system gesture, or the browser taking over the pointer all fire `pointercancel`, not `pointerup`. Task 4 defines the drag state machine implicitly through `pointerdown`/`pointermove`/`pointerup`; with no cancel path the drag latches, and every subsequent `pointermove` — including the next tap's — keeps laying road from the abandoned cell. There is no coverage bullet for a cancelled drag.

(d) **Multi-touch.** Pan/zoom is deferred to M2b, so two fingers do nothing by design — but nothing says the second pointer is IGNORED. With naive per-pointer handling, a second finger opens a second concurrent drag and lays a road segment between two unrelated cells. Erase mode has the same exposure.

Spec §7.3 calls touch input "the single most important mobile UX lesson available" and the plan's own Deferred table repeats it as the reason for deferring pan/zoom — then leaves the half it kept unspecified.

**Witness:** Plan greps: touch-action 0, preventDefault 0, pointercancel 0, multi-touch 0. Construct (c): pointerdown on tile A, pointermove to B, pointercancel, pointerdown on a distant tile C — a drag-state machine with no cancel branch emits a `place` between B and C's path, or throws on a non-adjacent pair.

---

## [Important] M2-11 — Drawing while paused — the entire point of pause per spec §7.3 — has no defined behaviour
**Section:** Task 4 ("Pause is one tap and freezes the accumulator") vs Scope (In: pause) and spec §7.3

Spec §7.3: "Pause is one tap, always available, and visibly freezes everything. **Players plan while paused; on mobile that substitutes for precision.**" Planning means drawing roads while paused. Task 4 defines pause as "freezes the accumulator", which means `step` is never called, which means the `TickAction[]` the input layer produces is never consumed. The plan does not say what happens to those actions, and the three possibilities are all visibly different games:

- Queue them: the player draws twenty segments seeing no feedback (no road appears, because roads live in the sim state that pause froze), then on resume they all apply in one tick — including any that are now invalid, and including erase/place pairs that should have cancelled.
- Drop them: drawing while paused does nothing, contradicting spec §7.3 outright.
- Apply them by running a step: pause does not actually freeze the sim.

There is no coverage bullet on the interaction, no mention in Task 6's e2e, and the two features are specified in different sentences of the same task as though they were independent. Note this also interacts with the HUD: spec §7.2 makes the week/day clock double as the pause control, so the plan's "always expanded" clock and Task 4's "one tap" pause are the same widget and neither task owns it.

**Witness:** Task 4's own coverage bullet "pause stops the accumulator and resumes it without a catch-up burst" is satisfiable with an empty action queue and says nothing about pending input. Construct: pause, drag across three tiles, resume — the plan admits no answer for what the board looks like at any point in that sequence.

---

## [Important] M2-12 — A named mutation is a no-op under every fixture the plan requires, and the one fixture that would kill it (place, then erase, then keep stepping) is required nowhere
**Section:** Task 6, Mutations ("feed input to `step` twice")

`placeRoad` re-applied to an existing segment costs 0 tiles and performs only idempotent writes — `roads.ts:188-197` states this explicitly ("every write it performs is idempotent ... the buffer is unchanged and the hash does not move"), because `canPlaceRoad` computes `cost = (maskA===0) + (maskB===0)`, which is 0 once both bits are set. `eraseRoad` returns `false` and refunds nothing when the bit is already clear. So feeding the same action array to two consecutive `step` calls is byte-identical to feeding it once, and no assertion over state, score, tiles-left or drawn output can distinguish it. Task 6's e2e is place-only, so the mutation is a **provable no-op there**.

The reason this matters is that the mutation names a real and serious bug — an input queue that is never cleared. That bug IS observable, but only through a sequence no bullet requires: place segment A-B on tick T, erase it on tick T+40, then continue stepping — a stale un-cleared queue resurrects the road on tick T+41 and refunds/charges tiles in a loop. Erase is exercised only in Task 4's pure-function unit tests, which never call `step`. So the plan pairs a catastrophic bug with a mutation that cannot express it and a fixture that cannot see it — the catalogue's "a test written specifically to catch a thing can still be blind to it" shape, at plan time.

**Witness:** `packages/sim/src/roads.ts:150-215`. Apply the mutation (call `step` twice with the same `inputs`) to any place-only fixture: `hashState` is unchanged, H_TILES is unchanged, every drawn frame is unchanged. Then run place -> erase -> step with an un-cleared queue: the erased road reappears.

---

## [Important] M2-13 — Task 6's four anti-smoke guards cannot kill two of Task 6's own named mutations
**Section:** Task 6 ("Guard it against becoming a smoke test") + Mutations ("drop the interpolation alpha (pass 0 always)", "draw before stepping")

Once M2-01 is fixed and resolved positions carry sub-cell progress (they must — see that finding), all four stated guards survive `alpha = 0`:

- "roads placed > 0" — unaffected by alpha.
- "at least one car drawn at a position strictly between two cells" — with alpha pinned to 0 the car renders at the PREVIOUS TICK's resolved position, which is strictly between cells on 86.8% of ticks (per-tick advance is 0.132 of a cell). Passes.
- "score strictly increased" — unaffected.
- "the drawn car position differing across at least 10 distinct frames" — with alpha 0 the position still changes on every tick boundary, so ~20 frames at 60 Hz yield 10 distinct positions. Passes.

The assertion that kills it is not in the plan: **two frames within the same tick must render different positions.** That is the only observable that separates interpolated from tick-quantised rendering, and it is exactly the thing Decision 1 exists to buy.

"Draw before stepping" is in the same position: it produces a uniform one-tick temporal offset, which leaves monotonic advance, between-cells-ness, frame-distinctness and the final score all intact. Neither mutation has a paired observer.

**Witness:** Speed 330 / threshold 2500 = 0.132 cells per tick, so a prev-tick position is between cells for 6.58 of every 7.58 ticks. Run the e2e with `render(0)` substituted for `render(alpha)`: all four listed guards pass.

---

## [Important] M2-14 — The deploy target is inside the directory the plan forbids modifying, the toolchain to build it is unassigned, and the anti-stale check has no unique-per-build token
**Section:** Task 6 ("Modify: the existing Worker config to serve the game bundle"; "Deploy: ... verify the artifact rather than the command's exit message") vs Global Constraints ("Do not modify `spike/`")

Three separate problems in one paragraph.

(a) **Target.** The only Worker in the repository is `spike/worker/index.ts` with `spike/wrangler.jsonc` (`name: "laneways-spike"`, `assets.directory: ./dist`, plus a D1 binding for the M0 results table). Global Constraints say "Do not modify `spike/`", and `spike` is excluded from the pnpm workspace and from eslint, and pins a divergent toolchain (typescript ^7.0.2, vite ^8.2.0, vitest ^4.1.10 against the root's ^5.9.0 / ^3.0.0). "Modify the existing Worker config" is therefore either forbidden by the plan's own constraint or means creating a new Worker — which no task lists.

(b) **Toolchain, unassigned.** "Tech stack" names Vite and `wrangler`; neither is a dependency of the root workspace (devDependencies are exactly @types/node, eslint, typescript, typescript-eslint, vitest). No task's file list contains a `vite.config.ts`, a `wrangler.jsonc`, a build script, or the devDependency additions. `packages/*/tsconfig.json` files `include: ["src", "test"]` only and `tsconfig.base.json` sets `lib: ["ES2022"]` with no DOM.

(c) **The verification cannot see the failure it targets.** "Fetch the live bundle and grep it for a string from this build" — a string that also existed in the previous build passes on a stale asset, which is exactly the M0 failure being guarded against. The check needs a token that is unique per build by construction (a build id/timestamp injected at bundle time) and it needs to fetch through the same cache path a client would, since spec §8.5 requires `Cache-Control: no-store, must-revalidate` on index.html and content-hashed asset names — neither of which appears in any task.

**Witness:** `spike/wrangler.jsonc` is the only wrangler config; `ls packages/` shows only `shared` and `sim`; root package.json devDependencies contain no vite and no wrangler. For (c): grep the live bundle for `function step` — it matches every build ever deployed.

---

## [Important] M2-15 — A required coverage bullet asserts a property the plan's own constraints declare unmeasurable, with no mechanism named
**Section:** Task 3 coverage ("the loop is allocation-free across 1,000 frames") vs Global Constraints ("enforcement (construction and review; there is no allocation profiler)")

Global Constraints state the zero-allocation rule is enforced by "construction and review; there is no allocation profiler". Task 3 then requires, as coverage, "the loop is allocation-free across 1,000 frames". One of the two is wrong, and the plan does not say which. An implementer will either skip the bullet (silently removing the only stated check on the constraint) or invent a measurement — and the obvious ones are traps: `process.memoryUsage().heapUsed` deltas across 1,000 frames are dominated by GC timing and will be flaky in both directions, and a green result proves nothing because 1,000 frames of small allocations fits comfortably in a young generation.

The catalogue's closing entry is precisely about this: "a confident wrong reason for why something cannot be tested is worse than an admitted unknown ... interrogate your own 'untestable' before writing it down". Here the plan asserts both positions at once. If it is measurable, name the mechanism (`--expose-gc` plus forced collections around a large N, or a proxy on the injected clock/canvas that counts object creation) and its threshold; if not, say so where the bullet is, so nobody records a fake pass.

Related unstated hazard, since it is the frame loop's most likely real allocator: Canvas2D state assignment (`ctx.fillStyle = '#rrggbb'` allocates a string unless the palette is preallocated), `getBoundingClientRect()` (DOMRect per call), and any per-frame closure passed to `requestAnimationFrame`. None is mentioned in the Global Constraint's "this includes the sim->render adaptation" carve-out.

**Witness:** Global Constraints bullet 4 vs Task 3 coverage bullet 8, verbatim contradiction. No profiler, no `--expose-gc` flag, and no test-side mechanism appears in any task's file list.

---

## [Minor] M2-16 — The HUD has no stated position, and the position spec §7.2 implies is the one spec §8.3 forbids
**Section:** Task 5 ("HUD is exactly three elements (spec §7.2) ... Drawn on the same canvas; no DOM overlay")

Spec §7.2 puts the week/day clock at the TOP and makes it double as the pause and speed control. Spec §8.3 says: "**The top band is dead space.** Telegram's header remains drag-to-dismiss by design — their docs say so explicitly, and no CSS suppresses it — and in fullscreen the close button floats over the top-right corner. **No interactive element, score, or pause button may live there.**" The plan cites §7.2, adopts the always-expanded clock, and never mentions §8.3's prohibition, the two inset systems, or where on the canvas any of the three elements sits. Since Task 4's pause is "one tap" and §7.2 makes the clock the pause control, the plan is on track to put the game's only interactive HUD element in the band that eats taps and hosts the close button — a spec self-contradiction resolved silently, which is the M1c pattern the review process exists to catch.

Separately, the plan's three elements (clock, score, tiles-left) are not spec §7.2's three (clock, score, inventory chip row) — the substitution is defensible and is covered by the Deferred table, but the "(spec §7.2)" citation attached to the substituted list is not accurate.

**Witness:** Spec §7.2 vs §8.3, quoted above. Plan greps: safeArea/safe-area 0, and no task states an on-canvas HUD rectangle.

---

## [Minor] M2-17 — Haptics are in neither the In list nor the deferral table that claims to be exhaustive
**Section:** Scope ("Out, and named so nobody reads the gap as an oversight"), Task 4

Spec §8.4 specifies four haptic calls, two of which belong to exactly the input Task 4 builds: `impactOccurred('light')` on segment placement and `selectionChanged()` on grid-cell change while dragging. It also warns they must be guarded individually ("genuine on iOS, gaps on some Android builds, silent no-op on desktop"). The plan mentions haptics zero times, and the Deferred table — introduced with "named so nobody reads the gap as an oversight" — does not list them. This is small work with a real platform gotcha attached, and on touch it is a meaningful part of the drawing feel; it wants a row in the table either way.

**Witness:** `grep -ic haptic` over the plan -> 0. Spec §8.4 lists the two drag-time calls.

---

## [Minor] M2-18 — Task 1's two named file modifications are a no-op and a nonexistent file, while the modifications actually required are unlisted
**Section:** Task 1 ("Modify: root `pnpm-workspace.yaml`, `tsconfig.json` references")

`pnpm-workspace.yaml` already reads `packages: ['packages/*', 'tools/*']`, so `packages/render` and `packages/game` are picked up with no edit. And there is no root `tsconfig.json` — the repo has `tsconfig.base.json` only, and no package uses TypeScript project references (`packages/sim/tsconfig.json` is just `extends` + `include: ["src","test"]`). So both stated edits are wrong, and an implementer will either invent a references file or waste time looking for it.

The edits that ARE required and are not listed: `"lib": ["DOM"]` for both new packages (the base sets `lib: ["ES2022"]`, and the lifted `stableHeight()` reads `globalThis.innerHeight`), the second eslint block (fix-list C4), the vitest config and devDependency change (fix-list C1), and the vite/wrangler devDeps (M2-14).

**Witness:** `cat pnpm-workspace.yaml`, `ls /` (no tsconfig.json), `cat packages/sim/tsconfig.json`, `cat tsconfig.base.json`.

---

## [Minor] M2-19 — One of the two atlas layouts the plan offers exceeds WebKit's canvas dimension limit, and no test in the plan can observe it
**Section:** Task 1 ("256 offscreen canvases (or one strip of 256 cells — the implementer chooses and states why)")

A 1x256 strip at the plan's own 16 CSS px tile and the M0 device's DPR 3 is 48 x 12,288 device px; at the revealed-grid 28-29 px tile it is 84 x 21,504. Both exceed WebKit's maximum canvas dimension (4,096 on older iOS, 8,192-16,384 on newer), and an over-limit canvas on iOS Safari silently produces a blank or zero-sized surface rather than throwing — spec §8.5's "iOS fails silently" class. Every test in Tasks 1 and 2 runs against a stub or jsdom, so none can see it; it would first appear as an all-black board on a real phone after Task 6's deploy.

The plan offers the choice with no platform guidance at all. The 256-separate-canvases variant is what the spike actually ran on the measured device (`spike/src/roadAtlas.ts`), and a 16x16 grid layout (768x768 at 16 px / DPR 3) is safe under every limit. Either is fine; the strip should be ruled out explicitly rather than left as a coin flip whose losing side is invisible until the deploy.

**Witness:** 256 * 48 = 12,288 px and 256 * 84 = 21,504 px, against a 4,096-16,384 px WebKit maximum. `spike/src/roadAtlas.ts` builds 256 separate `document.createElement('canvas')` surfaces, which is the layout M0's numbers were actually measured on.

---

## [Minor] M2-20 — The week/day clock's formula is unstated even though the sim already exports an exact one, and the paired mutation is unconstructible if it is reused
**Section:** Task 5 (HUD clock) + Mutations ("use `TICKS_PER_DAY` as a divisor (it is deliberately `0`)")

`packages/sim/src/clock.ts` already exports `weekOfTick`, `tickWithinWeek` and `dayOfWeek`, the last with a comment explaining that it derives the day from position within the week precisely because 4500/7 is not an integer. Task 5 requires the clock to be "correct" for hand-computed ticks across a week boundary and a 6->0 wrap, but never says to call these — so a `game`-side re-derivation is the likely outcome, which is the catalogue's "a test that reimplements the thing it checks" shape, and it puts a second definition of the day boundary in a package where floats are permitted (`(t % 4500) * 7 / 4500` computed in float will disagree with the sim's `|0` at boundaries).

The paired mutation is also inert either way: if `dayOfWeek` is reused, "use `TICKS_PER_DAY` as a divisor" is not constructible in `game` at all; if it is re-derived, `(x / 0) | 0` evaluates to 0, so the mutant reports day 0 forever — killed by any single assertion, which makes it a weak mutation for the bullet it is attached to. The bullet that would actually earn its place is the one the plan does not state: the HUD's day must equal `dayOfWeek(H_TICK)` for the tick immediately before and after a week boundary, computed by the sim, not by the HUD.

**Witness:** `packages/sim/src/clock.ts:17-20`. `node -e "console.log((4499*7/0)|0)"` -> 0.

---

## [Critical] F1 — No task places a single house or destination — an M2 build has an empty board, so the milestone's stated goal and Task 6's end-to-end fixture are both unreachable
**Section:** Task 6 ("build the world and state"), Scope table, Goal

The Goal is "draw a road with your finger, watch a car take it, see the score tick", and Task 6 asserts "a car is dispatched … the score increments on return". Neither can happen. `step()` (packages/sim/src/step.ts:143-163) runs exactly seven phases — apply inputs, demand, assembleSources, syncFields, dispatch, movement, arrivals — and **none of them creates a building**. `placeHouse` and `placeDestination` (packages/sim/src/buildings.ts:332, 422) are called from nowhere in `src/`; `grep -rn 'placeHouse|placeDestination' packages/sim/src` returns only comments and the definitions themselves, and the only callers in the repo are six test files. `createState` (packages/sim/src/state.ts:306-327) documents its own result: "Unused house/destination slots are simply those at index >= H_HOUSE_COUNT/H_DEST_COUNT (**both 0 here**)". Cars exist only as a side effect of `placeHouse` (2 per house, buildings.ts:347), so zero houses means zero cars, zero demand, zero dispatch, zero score, forever. Spec §5.9 spawning is not implemented, and the plan's "Out, and named so nobody reads the gap as an oversight" table does not list building spawning — so a reader has no signal that it is missing. This is not a small omission: it is a **design decision no task owns** (who seeds buildings, how many, where, on what schedule, and whether that seeding is part of the replayable input log that M3's server-side verification depends on). Task 6's sentence "build the world and state" also silently omits `fields` and `scratch`, which `step`'s 5-arg signature requires (`createFlowFields`, `createScratch`, packages/sim/src/scratch.ts:148, 209).

**Witness:** `node -e` equivalent: create `createWorld(firstCity())` + `createState(seed, map)` and run `step` 10,000 times with empty inputs. `header[H_HOUSE_COUNT] === 0`, `header[H_DEST_COUNT] === 0`, every `carPhase[i] === PHASE_NONE`, `header[H_SCORE] === 0`. Task 6's guards "at least one car drawn at a position strictly between two cells" and "score strictly increased" fail on an empty array and a constant 0 respectively — the e2e cannot be written, let alone pass.

---

## [Critical] F2 — Interpolating between prev and curr `carCell` is strictly worse than not interpolating, and Decision 2's own one-cell guard then snaps every real cell change — making its third coverage bullet unsatisfiable
**Section:** Decision 2; Task 3 ("Prev car positions live in a preallocated `Int32Array`")

Cars do not move one cell per tick. `advanceCar` (packages/sim/src/cars.ts:213-237) accumulates `speedUnits(LANE_SPEED_DEFAULT)` = **330** units/tick against a threshold of `edgeCost(dir) * COST_UNIT_SCALE` = **2500** orthogonal / **3500** diagonal. So `carCell` changes once every **7.58 ticks** (ortho) or **10.6 ticks** (diag) — **3.96 cell changes per second**, i.e. once every 253 ms. Task 3's stated prev snapshot is "car positions … in a preallocated `Int32Array`", i.e. cells. Interpolating prevCell→currCell with alpha therefore renders a car **standing still for ~7 ticks and then crossing an entire cell inside one tick's worth of frames** — 8× true speed for 1/8 of the time. That is visibly worse than drawing `carCell` raw, and it defeats Decision 1's entire stated rationale ("smooth car motion is most of this genre's feel"). Worse, Decision 2's guard — "interpolate only when … its interpolated distance is under one cell" — then **snaps every one of those transitions**, because an orthogonal cell change is distance exactly 1.0 (not "under one") and a diagonal is 1.414. The renderer never interpolates anything, and Task 3's own vacuity bullet ("an ordinary mid-route car **is** interpolated, strictly between prev and curr at `alpha = 0.5`") is **unsatisfiable by construction**. The correct design needs the *resolved sub-cell* position — `carCell + (carProgress / (edgeCost(dir)*COST_UNIT_SCALE)) * (DX[dir], DY[dir])` with `dir = outbound ? routeStep(cursor) : OPPOSITE[routeStep(cursor-1)]` — for **both** prev and curr. Fixlist C2 gets the *current* frame right (a `Float32Array` of resolved positions in `game`) and never notices that the **prev snapshot must be the same thing**, that an `Int32Array` of cells cannot hold it, or that the formula itself is stated nowhere in the plan or the fixlist. That formula is the single most load-bearing piece of arithmetic in the milestone and it is unassigned.

**Witness:** Hand-run: a car on a straight orthogonal route, `carProgress` = 0, 330, 660, … 2310 across ticks 0-7 with `carCell` constant, then cell+1 with progress 140 at tick 8. Under Task 3 as written, prev==curr for ticks 0-7 → the car is drawn motionless for 233 ms; at tick 8 prev≠curr with distance 1.0 → the guard says snap → it teleports one cell. Alpha is never used. Every one of Task 3's three interpolation bullets is then either vacuous or unsatisfiable.

---

## [Critical] F3 — A 100 ms frame runs 2 ticks, not 3, in IEEE-754 — and the stated expectation pushes the implementer toward TICK_MS = 33, which desynchronises the game clock from the sim's 30 Hz by 1%
**Section:** Task 3, Coverage ("a 100 ms frame runs exactly 3 ticks")

`TICK_MS = 1000/30` is **33.333333333333336** as a double (the quotient rounds *up*), so `3 * TICK_MS = 100.00000000000001 > 100`. The accumulator drain `while (accumulator >= TICK_MS)` from `accumulator = 100` runs **2** ticks and leaves 33.33333333333332 — a residual that is itself a hair below `TICK_MS`. An implementer writing the plan's bullet verbatim gets a red test on correct code. The dangerous part is the repair: the only way to make "exactly 3" true is to make `TICK_MS` an integer 33, which runs the sim **1.01% fast** — `TICKS_PER_WEEK = 4500` would take 148.5 s of wall clock instead of `SECONDS_PER_WEEK = 150`, and every M0-derived timing claim shifts with it. The neighbouring bullets inherit the same fragility: after that 100 ms frame `alpha = 33.33333333333332 / 33.333333333333336 = 0.9999999999999995`, so the "alpha is always in [0, 1)" bullet passes by 5e-16 and any reordering of that division can push it to exactly 1.0 — at which point the "let alpha reach 1.0" mutation stops being a mutation and becomes the behaviour.

**Witness:** Executed: `node -e 'const T=1000/30; let a=100,n=0; while(a>=T){a-=T;n++} console.log(n,a)'` → **`2 33.33333333333332`**. Also `3*(1000/30) === 100` is `false`; it is `100.00000000000001`.

---

## [Critical] F4 — The named mutation "snap on phase change only (must fail — this is the trip-end case)" is a provable no-op: `step`'s phase order makes it impossible for a car to teleport with an unchanged phase byte
**Section:** Decision 2 ("The distance guard is the load-bearing half"); Task 3 Mutations

Decision 2 justifies its distance guard with: "phase is unchanged on an ordinary trip-end-to-idle-to-redispatch within one tick, and a phase check alone would miss it." That is false against the real tick order. `runDispatch` is **phase 5** and `runArrivals` is **phase 7** (packages/sim/src/step.ts:159-163), so a car that `completeTrip` turns to `PHASE_IDLE` in arrivals **cannot be redispatched until the next tick's phase 5**. At every tick boundary the sequence is therefore RETURNING → IDLE → OUTBOUND, i.e. the phase byte **changes across the teleport and again across the redispatch**. `completeTrip` (packages/sim/src/trips.ts:150-153) is the *only* >1-cell position discontinuity in the sim, and it writes `carPhase[i] = PHASE_IDLE` on the same tick as `carCell[i] = houseCell[carHome[i]]`. So a phase check alone catches every case the distance guard was invented for; the mutation the plan says **"must fail"** produces byte-identical rendering and cannot be killed by any fixture. Compounding it, the paired vacuity condition — "the snap fixtures must have prev and curr **more than one cell apart**" — is **unconstructible for the flip fixture**: at the OUTBOUND→RETURNING flip the car is at most `330/2500 = 0.132` cells short of the carpark on the prev tick and at most `329/3500 = 0.094` cells back from it on the curr tick, a maximum separation of **0.226 cells**. "A flipping car renders … not mirrored across [the carpark]" describes a failure mode the data cannot produce, because the return leg's offset is measured backwards from `carCell` along `OPPOSITE[route[cursor-1]]`, i.e. on the same side the car arrived from. And the third mutation, "use `>` instead of `>=` on the one-cell distance guard", is likewise a no-op: with resolved positions the per-tick delta is a fixed **0.132–0.133 cells**, so the guard's threshold is never approached from either side. Three of Task 3's seven named mutations are inert, and the plan asserts one of them must fail.

**Witness:** Trace one round trip: tick N-1 `carPhase=PHASE_RETURNING`; tick N `runArrivals` → `completeTrip` → `carPhase=PHASE_IDLE`, `carCell=houseCell`; tick N+1 `runDispatch` → `PHASE_OUTBOUND`. Prev/curr phase differs at both boundaries. Apply "snap on phase change only" to the whole M2 suite: zero detectors.

---

## [Critical] F5 — Three of Task 6's four named mutations survive every guard and every coverage bullet it pairs them with — including one that is a provable no-op against the sim's own documented idempotence
**Section:** Task 6, Mutations and "Guard it against becoming a smoke test"

The four guards are: roads placed > 0; at least one car drawn strictly between two cells; score strictly increased; drawn car position differing across ≥10 distinct frames.

(a) **"feed input to `step` twice"** is a **provable no-op**. `placeRoad`'s doc comment says it outright: "Re-placing over an existing segment (cost 0) still runs this logic, but every write it performs is idempotent — the bits are already set … so the buffer is unchanged and **the hash does not move**" (packages/sim/src/roads.ts:194-197; cost is `(maskA===0?1:0)+(maskB===0?1:0)`, roads.ts:174). `eraseRoad` is symmetric: the second call finds `(maskA & bitA) === 0` and returns `false` having changed nothing (roads.ts:237). No test that observes state, hash, tile budget, or drawn output can ever kill this mutation.

(b) **"drop the interpolation alpha (pass 0 always)"** survives all four guards. With alpha = 0 the drawn position is the *prev* resolved position, which is still strictly between two cells (guard 2 passes on `carProgress` alone, not on alpha), still advances every tick (guard 4 passes), and the score is untouched (guard 3).

(c) **"draw before stepping"** shifts the whole frame by one tick. Roads still placed, positions still between cells and still monotone, score still increases (one tick later), ≥10 frames still differ. Nothing fails.

Only "never rebuild the atlas on resize" is actually killed, by its own coverage bullet. The plan's headline claim — that these guards prevent the e2e degenerating into a smoke test — is therefore false for 3/4 of the things it lists. Separately, the coverage bullet "the sim's four goldens are unchanged by anything in `game` or `render`" **cannot fail**: those goldens are computed by `packages/sim/test` from its own fixtures with no reference to the new packages, so the bullet is a re-run of an existing suite.

**Witness:** (a) is verifiable in one line against the existing suite: call `step` twice with the same `TickInputs` containing one `place` action and compare `snapshot(state)` byte-for-byte against a single-feed run — identical. Guard 2 for (b): `carProgress` is non-zero for 7 of every 7.58 ticks, so "strictly between two cells" is satisfied by the sim, not by the renderer.

---

## [Critical] F6 — The fixed camera produces 16 CSS px tiles — 57% of spec §5.1's hard minimum of 28 CSS px — and the "revealed grid" the deferral rationale rests on does not exist anywhere in the codebase
**Section:** Decision 5 ("Integer tile size, fixed camera"); Scope table (pan/zoom deferral); Task 2 coverage

Spec §5.1 states: "Camera zoom-out hard-stops at a **minimum tile size of 28 CSS px**." Decision 5 computes `floor(min(cssW/24, cssH/40))` over the **full** 24×40 grid and cites M0's measured result of **16 CSS px** as evidence that it works. It is a direct violation of the spec's own floor, and it is not fixable by picking a better phone: 40 rows at the 28 px floor needs **1120 CSS px** of viewport height, and M0's test device had **870** (docs/research/2026-08-02-m0-spike-findings.md:39, `floor(min(406/24, 870/40))`). No portrait phone can legally display the full grid, so "no pan, no zoom in M2" is not a deferral, it is a spec breach that M2b cannot repair without changing the camera model M2 shipped.

The deferral table's justification — "The whole **revealed** grid fits a portrait viewport at M2's fixed camera" — is inconsistent with the formula above (which uses the full grid) and, more seriously, rests on a concept that does not exist: there is **no revealed/expansion state anywhere**. `WorldData` is `{ map, w, h, cells, terrain, passable }` (packages/sim/src/world.ts:18-25) with no reveal mask; `GameState` has no such region (state.ts:148-170); `mapFormat.ts:21` explicitly defers it — "Expansion (§5.1, M1d) reveals cells". Consequently Task 2's coverage bullet **"only cells inside the revealed grid are drawn"** has no data source, and its paired mutation **"drop the grid-bounds check"** is unconstructible in the natural implementation (`for (i = 0; i < cells; i++)` over the arrays render is handed has no bounds check to drop). At 16 CSS px, the fingertip problem spec §7.3 exists to solve is also live and unmitigated: a ~44 CSS px contact patch covers roughly 3×3 tiles, and auto-zoom-on-draw-start is deferred to M2b — for a milestone whose entire goal is drawing roads with a finger. Task 4's "a tap inside tile (3, 7) … produces exactly that tile, hand-computed" is exact integer arithmetic and cannot observe this failure at all.

**Witness:** `floor(min(406/24, 870/40)) = floor(min(16.9, 21.75)) = 16` (M0's own line). `28 * 40 = 1120 > 870`. `grep -rn 'reveal' packages/sim/src packages/shared/src` → one hit, mapFormat.ts:21, deferring it to M1d.

---

## [Important] F7 — The input path must allocate per drag sample to satisfy `step`'s interface, contradicting a Global Constraint, and the coverage bullet that would catch it is one the plan elsewhere says cannot be written
**Section:** Global Constraints ("Nothing allocates inside the frame loop") vs Task 4 (`TickAction[]`) and Task 3 ("allocation-free across 1,000 frames")

`step` takes `inputs: TickInputs` where `actions: readonly TickAction[]` and `TickAction` is `{ readonly kind, a, b }` (packages/sim/src/step.ts:20-37). Task 4 must produce `TickAction[]` from pointer events; a drag emits one object per tile entered, plus an array, **every frame the finger moves** — which is precisely "inside the frame loop" and precisely the interaction the game is built around. The plan states no reconciliation. The obvious pooling fix (a preallocated ring of mutable action objects) collides with `readonly` on every field and with `inputs.actions.length` being the consumed length, so it needs a real decision — a mutable pool plus an explicit count, or a widened `TickInputs`, either of which touches `sim` and the Global Constraint that says `sim` stays untouched.

The test that would surface this is Task 3's "the loop is allocation-free across 1,000 frames" — but the plan's own Global Constraints say enforcement is "construction and review; **there is no allocation profiler**". So the plan simultaneously declares the property untestable and lists a test for it. An implementer will either write a flaky `process.memoryUsage()` heap-delta assertion (which the catalogue's "an implausible detector" warning covers) or silently drop the bullet — and dropping it removes the only listed observer of the constraint.

**Witness:** Any drag of N tiles allocates N `TickAction` objects and ≥1 array per frame. Compare against `runMovement`'s module comment (cars.ts, "No object literal, no array, no closure … zero, not 'small'"), which is the standard the constraint invokes.

---

## [Important] F8 — C2's boundary fix resolves cars only — destinations, houses and terrain all need `sim`/`shared` functions or enums to draw, and no task owns their adaptation
**Section:** Decision 3 as revised by fixlist C2; Task 1 (`RenderFrame`); Task 2 (buildings, terrain)

C2 correctly moves car interpolation into `game` and hands `render` a `Float32Array` of resolved positions. The same argument applies, unresolved, to everything else Task 2 draws:

- **Destinations** are a 2×3 footprint plus a carpark, with colour/kind/orientation packed into one byte. Unpacking needs `destMetaColour`, `destMetaKind`, `destMetaOrientation`, `carparkCell(destCell, orientation, w, h)` and `isFootprintCell` — all **functions** in `packages/sim/src/buildings.ts` (133-209). `render` cannot import them under Decision 3, and `game` is not assigned to pre-resolve them.
- **Terrain** needs the `TERRAIN` enum from `@laneways/shared` to map a byte to `Palette.{land, water, mountain}`. Spec §4 says `render` "depends on nothing but its own interface types" — not "nothing but `shared`" — so either render duplicates the enum values or the boundary moves again.
- **Cleared trees** are the one piece of drawn terrain that is *state*, not world: `state.cleared[cell] = 1` when a road destroys a tree (roads.ts:208-209), while `world.terrain[cell]` still reads `TREE`. Drawing terrain from `world.terrain` alone renders every destroyed tree as if it were still there, permanently, on the exact cells the player just built on. Task 2 never mentions `cleared`, no coverage bullet mentions it, and no mutation targets it.

Task 1 is required to "name every field and its type here; later tasks consume it verbatim" — so this must be settled in Task 1 or Task 2 cannot be written.

**Witness:** `packDestMeta(colour, kind, orientation)` / `carparkCell(destCell, orientation, w, h)` are functions, not data (buildings.ts:133, 180) — the identical argument C2 makes about `edgeCost`/`routeStep`. For `cleared`: place a road across a `T` cell in `firstCity` and render; the tile is `TERRAIN.TREE` in `world.terrain` forever.

---

## [Important] F9 — No coverage for a pointer sample that skips two or more tiles — and `placeRoad` refuses non-adjacent pairs silently, so the resulting gapped road is invisible to every stated fixture
**Section:** Task 4 ("Drag lays segments cell by cell between consecutive tiles"), Coverage

`canPlaceRoad` returns `{ok:false, reason:'not-adjacent'}` whenever `dirBetween(a, b, w, h) === -1` (roads.ts:155-158), and `placeRoad` returns `false` changing nothing. `step` ignores the return value. So a drag whose consecutive pointer samples land two or more tiles apart produces **`place` actions that are silently discarded**, leaving a road with holes — and at 16 CSS px tiles with coalesced `pointermove` events, a finger moving at ordinary speed skips tiles routinely. Spec §7.3 says "one-finger drag lays segments **cell by cell**", which requires a supercover/Bresenham walk between successive samples; the plan's phrasing ("between consecutive tiles") is ambiguous and no task states the rasterisation rule.

The three stated drag bullets — three tiles, a direction change, and a re-entered tile — all sample **adjacent** tiles, so every one of them passes against an implementation with no interpolation at all. The mutation list has no entry for it either. This is the catalogue's "a fixture that meets every stated condition and still cannot observe the failure" shape, and the failure it cannot observe is the core mechanic breaking on a real phone.

**Witness:** Fixture that would catch it: pointer samples at tile (3,7) then (6,10) with nothing in between. Correct behaviour emits 3 adjacent `place` actions along the diagonal; the natural implementation emits one `{place, a:(3,7), b:(6,10)}` which `dirBetween` rejects, producing **zero** road. No stated bullet distinguishes these.

---

## [Important] F10 — Decision 6 is justified in draw-call terms by the same plan that just proved draw calls are free and pixels bind — the shadow layer composites the exact pixel count Decision 4 uses to kill road baking
**Section:** Decision 6 ("One shadow layer, composited once") vs Decision 4's pixel accounting

Decision 4 kills baking with: "Baking composites **3.2× the pixels** to draw the same roads (**3,178,980** device px against 995,328)" and "Optimise pixels, not calls." Decision 6 then adopts a full-canvas offscreen surface and justifies it as "the layer adds **one blit** and removes N alpha compositions" — a draw-call argument, unaudited against the pixel accounting two decisions earlier. Charged the same way: the shadow layer's composite is a full-canvas `drawImage` of **1218 × 2610 = 3,178,980 device px** — bit-for-bit the number Decision 4 calls disqualifying — **plus** a full-canvas clear of the offscreen every frame, **plus** the N shadow shapes drawn into it. What it removes is N small alpha compositions totalling roughly 400 × 2,304 = **921,600 px**. So the trade is a ~3.4× pixel *increase*, and at M0's own fitted ~10 Gpx/s the composite alone is ≈0.32 ms — about **twice the entire per-frame road layer** (0.168 ms). Decision 6 also re-incurs the "+12.13 MiB of surface memory in a memory-constrained iOS WKWebView" that Decision 4 lists as one of three uncharged costs against baking.

The non-additive-overlap requirement (spec §6) is real and the layer may well still be right — but the plan's stated justification is wrong, the plan already flags M2's frame budget as unmeasured, and the cheap mitigation (clip the layer to the grid's 1152×1920 = 2.21 Mpx rather than the letterboxed canvas) is not mentioned.

**Witness:** 1218 × 2610 = 3,178,980 — identical to the plan's own anti-baking figure. 432 × 2,304 = 995,328 per-frame roads; 400 × 2,304 = 921,600 sprite-shadow alpha pixels replaced.

---

## [Important] F11 — C1's chosen fix (inject a recording canvas factory) makes most of Task 1's and Task 2's coverage unexecutable — by the fixlist's own argument, two paragraphs before it recommends that fix
**Section:** Task 1 coverage vs fixlist C1's preferred resolution

Fixlist C1 states, correctly: "The atlas must **create canvases and draw into them** … A recording stub cannot substitute — **the whole point is real ink**." It then recommends Option 1, a factory whose test double is exactly a recording stub, and calls it "strongly preferred". Under Option 1, these Task 1 bullets have no observable: "every one of the 256 masks produces a **distinct non-empty tile**"; "a tile's **ink** is symmetric under the mask's own symmetry" (including C5's replacement, mask 5's diagonal symmetry with horizontal/vertical asymmetry); "at least one tile must have **ink** in the interior *and* at each of its four edges"; "a rebuild at the same size is idempotent". All four are pixel properties. Against a call recorder they degrade to "the call sequences differ", which the mutations "skip the DPR multiply", "use a fixed stroke width" and "draw round caps as butt caps" would still be caught by — but "return the same canvas for every mask" and the whole distinctness/vacuity apparatus would not, because a recorder replays whatever `moveTo`/`lineTo` arguments it was given regardless of what would rasterise.

The same collision hits Task 2: its stub "records the call sequence, because pixel assertions in jsdom are worthless", and its vacuity self-check demands "**two overlapping** shadows, since one shadow cannot distinguish composited from alpha-stacked". **Overlap is a pixel property.** Two overlapping shadows and two disjoint shadows produce identical call sequences, so the stated vacuity guard buys nothing against a recorder; what actually catches the alpha-stacking mutation is the separate `globalAlpha` bullet, which needs no overlap at all. The plan must pick: real rasterisation for the atlas (which needs a real canvas somewhere), or restate every ink bullet as a geometry-of-recorded-calls bullet.

**Witness:** Under a recording stub, `buildAtlas` returning the same recorder object for all 256 masks still yields 256 distinct recorded sequences if the recorder is keyed per call; and `strokeStyle`/`lineWidth`/path commands are identical for a shadow at (10,10) and one at (100,100) except for the coordinates, which no overlap assertion reads.

---

## [Important] F12 — The stated tick bound is non-integral and wrong by one, and the clamp-ordering mutation it is paired with is a no-op on the fixture the plan names
**Section:** Task 3, Coverage ("at most `MAX_FRAME_DT / TICK_MS` ticks") and Mutations ("clamp `rawDt` after accumulating instead of before")

`MAX_FRAME_DT / TICK_MS = 250 / 33.333333333333336 = 7.499999999999999` — not an integer, so "hand-computed" has no value to write down. From a *fresh* accumulator a 5,000 ms frame runs **7** ticks. But the accumulator carries a residual in `[0, TICK_MS)` from every previous frame, so the true worst case is **8**: 33.33 + 250 = 283.33 → 8 drains. The plan's own neighbouring bullet guarantees such a residual (its 100 ms frame leaves 33.333…32). An implementer asserting `ticks <= MAX_FRAME_DT / TICK_MS` writes a test that passes on the fixture given and fails in production, or asserts `<= 7` and pins the wrong bound.

The same fixture also disarms the paired mutation. "Clamp after accumulating" (`acc = min(acc + rawDt, MAX_FRAME_DT)`) versus "clamp before" (`acc += min(rawDt, MAX_FRAME_DT)`) differ **only when the accumulator already holds a residual**. On the plan's stated fixture — one 5,000 ms frame from a clean loop — both produce 7 ticks and the identical leftover. The mutation survives its own coverage bullet.

**Witness:** Executed. Fresh accumulator, 5,000 ms: clamp-before → `[7, 16.666666666666615]`; clamp-after → `[7, 16.666666666666615]` — identical. After one 20 ms frame first: clamp-before → **`[8, 3.333…]`**; clamp-after → **`[7, 16.666…]`**. Worst case from `acc = TICK_MS - ε`: **8** ticks.

---

## [Important] F13 — Nobody owns HUD hit-testing: Task 4 maps every screen point to a tile and its only rejection rule is the letterbox, which is exactly where the HUD has to live
**Section:** Task 4 ("pause stops the accumulator") and Task 5 (HUD drawn on the same canvas)

Task 5 puts the HUD "on the same canvas; no DOM overlay", and spec §7.2 makes the week/day clock double as the pause control — so pause is a *tap on a drawn HUD element*. Task 4 owns pointer input and defines it purely as screen → tile → `TickAction`, with one rejection rule: "a tap in the letterbox produces no action". Those two are incompatible in both directions:
- If the HUD is drawn **over the grid**, tapping pause also lays a road under it, and no stated bullet or mutation covers HUD rejection.
- If the HUD is drawn **in the letterbox** (which is where it fits — at 16 px tiles on M0's device the vertical letterbox is (870 − 640)/2 = **115 CSS px** top and bottom), then Task 4's letterbox rule **suppresses the pause tap itself**, and the coverage bullet asserting that suppression would be asserting the bug.

Neither task names the pause hit region, its coordinate space, or its precedence over the draw path. Task 4's pause bullet ("stops the accumulator and resumes it without a catch-up burst") tests the accumulator, never the routing of the tap that reaches it. Related: the spike's own note warns that the top band is dead space — "Telegram's header stays drag-to-dismiss and its close button floats over the top-right in fullscreen, so no content of ours may live there" (spike/src/main.ts:13-18) — which further constrains where the top HUD may sit and is not mentioned in Task 5.

**Witness:** 406 × 870 CSS device, tile 16 → grid 384 × 640 → letterbox 11 px horizontal, 115 px vertical. Any HUD placement is either inside the grid rect (draws roads on tap) or inside the letterbox (suppressed by Task 4's stated rule).

---

## [Important] F14 — M0's largest adopted lever — cap devicePixelRatio at 2 (1.5 on `performanceClass === 'LOW'`) — is absent from the plan, and the atlas is specified at raw DPR
**Section:** Decision 4 / Task 1 (atlas "pre-rendered once at device pixel ratio")

M0's findings table records, with status **"Adopt now"**: "`performanceClass`-gated degradation — **Yes, and the lever is DPR, not sprite count.** Cap `devicePixelRatio` at **2 universally**, **1.5 on `performanceClass === 'LOW'`** … Fill is the dominant term. A 1080p LOW device at uncapped dpr 2.625 composites 1.96× the pixels … ~5 ms vs ~8.5 ms at 400 sprites, the difference between clearing and blowing the budget. Zero bytes, largest single lever available." The M2 plan mentions DPR five times — atlas built "at device pixel ratio", rebuilt "when tile size or DPR changes", the "skip the DPR multiply" mutation, the DPR ≠ 1 fixture — and **never mentions the cap**. The M0 test device reports DPR 3, so the atlas as specified is built at 2.25× the pixel budget M0 says to use, on the milestone whose closing section already admits "frame budget on a real device is unmeasured for this workload". This is the plan importing M0's measurements while dropping M0's decision, in the same milestone that lifts M0's Telegram code.

**Witness:** docs/research/2026-08-02-m0-spike-findings.md:37 (`devicePixelRatio` = 3) and :248 (the capped-DPR recommendation, status "Adopt now"). Nothing in the plan's Decisions, Global Constraints, or Task 1 references `min(devicePixelRatio, 2)`.

---

## [Minor] F15 — Two of Task 5's mutations are unconstructible or crash-shaped, and the counter mutation needs a fixture the plan does not specify
**Section:** Task 5, Mutations ("use `TICKS_PER_DAY` as a divisor") and Coverage ("score and tiles-left render the sim's values")

(a) `dayOfWeek(tick)` **already exists** in `packages/sim/src/clock.ts:17` and already computes the day the only integer-safe way — `((tickWithinWeek(tick) * DAYS_PER_WEEK) / TICKS_PER_WEEK) | 0` — with a comment explaining why no stored ticks-per-day constant is used. So the HUD should call it, and the mutation "use `TICKS_PER_DAY` as a divisor" is then not constructible in `game` at all; constructing it requires editing `sim`, which the Global Constraints forbid. If the implementer instead re-derives the day inside `hud.ts` to make the mutation constructible, that is a second source of truth for the exact quantity `clock.ts` documents as fragile. Either way, applied literally the mutation divides by 0 → `Infinity | 0` → 0, i.e. a **crash-shaped mutant** whose failure mode is a constant day 0 rather than an off-by-one — the catalogue's "a mutation that does not run is not a caught mutation" shape, dressed as a kill.
(b) "Read the score from a local counter instead of the sim" is only killable by a fixture that sets `header[H_SCORE]` to a value no local counter would reach (e.g. poke it to 7 with no trips). If the HUD test drives real trips, a local counter incremented on the same event is indistinguishable. The plan requires the assertion ("not their own counters") without specifying the only fixture that can make it true — the catalogue's "list what else could prevent X" rule applied to a positive assertion.
(c) Minor drift: Task 5 says "HUD is exactly three elements (spec §7.2) … score, and tiles-left", but §7.2's third element is the **inventory chip row**, which the plan's own Out table defers to M1e. The substitution is defensible (`H_TILES` is real state, roads.ts:262) but it is made silently while citing §7.2 as the authority for "exactly three".

**Witness:** `clock.ts:17-19`; `TICKS_PER_DAY = 0` (shared/constants.ts:24); `H_TILES` is written by `placeRoad`/`eraseRoad` (roads.ts:212, 250) and seeded to `map.startingTiles` = 30 for `firstCity`.

---

## [Minor] F16 — Three smaller test-strength defects: a mutation that presupposes an unstated coordinate space, a self-inverse round trip that cannot see shared-transform errors, and a mutation with no paired observer
**Section:** Task 4 ("drop the DPR divide"; round-trip bullet); Task 3 ("snapshot prev after step"); Task 3/6 ("catch-up burst")

(a) **"Drop the DPR divide"** and the "DPR ≠ 1" vacuity condition presuppose that `screenToTile` consumes device pixels. Pointer events deliver **CSS** pixels (`clientX/Y`), and Decision 5 fixes tile size in **integer CSS px**, so the natural correct implementation `(clientX − rect.left − offsetX) / tileSize` contains **no DPR term at all** — the mutation is unconstructible, and the bullet actively pushes an implementer to insert a DPR divide that is a real bug on every phone (DPR 2–3). The plan never states which coordinate space `screenToTile` takes, in the one place it calls "the bug factory".
(b) The bolded round-trip guarantee **`screenToTile(tileToScreen(t)) === t` for every tile** is self-inverse: it survives any error applied consistently to a shared camera transform — swapped x/y, a dropped letterbox offset, a dropped DPR term — which is exactly how a camera is normally implemented (one `{tileSize, offsetX, offsetY}` used by both directions). Three of Task 4's seven mutations are in that class. Only the separate hand-computed `(3,7)` bullet has real power, and it constrains `screenToTile` alone; `tileToScreen` (owned by Task 2) has no independent hand-computed pin.
(c) **"Snapshot prev *after* `step` instead of before"** has no paired coverage. All three interpolation bullets live in `interpolate.test.ts` against hand-built prev/curr arrays, where the snapshot ordering does not exist; the eight loop bullets never assert anything about snapshot content. The mutation collapses prev onto curr — the car renders un-interpolated forever — and nothing listed observes it.
(d) "Without a catch-up burst" is used with two incompatible meanings and no threshold: Task 4 needs **0** ticks on unpause (which requires resetting the clock reference, a mechanism the plan never states — freezing only the accumulator still yields a clamped 250 ms → 7 ticks on resume), while Task 6 calls **7** ticks after a 2,000 ms stall "surviving without a catch-up burst".

**Witness:** (d) executed: a 2,000 ms frame clamped to 250 ms drains to `[7, 16.666666666666615]` — the same 7 ticks that Task 4's pause bullet must assert do *not* happen.

---

