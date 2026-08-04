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

*The four-lens adversarial review appends below.*
