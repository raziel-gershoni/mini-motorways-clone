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

*The four-lens adversarial review appends below.*
