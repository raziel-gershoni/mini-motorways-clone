# M1b — Terrain, Roads and Flow-Field Pathfinding

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the deterministic core a board. Terrain, a road graph the player mutates, and per-colour flow fields that answer "which way from here" in one array read — with the whole thing still replaying byte-identically.

**Architecture:** Terrain is immutable per map and lives outside the snapshot, identified by a *content* hash in the header. Everything the simulation can change lives in the buffer — including which trees have been destroyed. Roads are an 8-direction bitmask per cell. Pathfinding is multi-source Dijkstra with a Dial bucket queue, writing per-colour `FlowField`s that are derived, persistent, and stale-checked against a hash of the inputs they were built from, using transient working memory that is fully overwritten on every call.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces. Zero runtime dependencies.

## Prerequisite

M1a is complete: `@laneways/shared` (integer rule constants), `@laneways/sim` (seeded RNG, single-`ArrayBuffer` state with snapshot/restore/hash, exact week/day clock, pure `step()`), and a two-mechanism determinism enforcement layer. Golden hash `917870623`.

## This plan was adversarially reviewed before execution

Three independent reviews of the previous draft returned 9 Critical, 15 Important and 10 Minor findings. Six of them changed a design decision or a published signature, so the affected sections were rewritten rather than patched. Where a decision below differs from the reviewed draft, it says so and says why — the reasoning is the deliverable, not the conclusion.

The single most valuable finding is recorded in design decision 1: the previous draft justified keeping terrain outside the snapshot on the grounds that "static data cannot change", and then had Task 3 destroy trees on road placement. That would have shipped green through all of M1b and first bitten in M1c as a spawn divergence between a fresh run and a restored one.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md`. Read §4.1 (determinism), §5.1 (board and terrain), §5.4 (pathfinding), §5.9 (spawning — it is why trees matter), §5.11 (roads).
- **Cell index convention: `index = y * w + x`.** Row-major, origin top-left, `x` fastest. Every module in this milestone — `parseMap`, `dirBetween`, `neighbours`, `computeFlowField` — depends on it, and in the reviewed draft it was implicit, which is why three separate findings exist about row-seam wrap. Decompose with `x = cell % w`, `y = (cell / w) | 0`. Recompose with `y * w + x`. Anywhere a test could pass under the transposed convention `x * h + y`, it must assert at an **asymmetric `(x, y)`** on the non-square 24×40 fixture (e.g. `(3, 7)`), never at `(k, k)`.
- **Zero runtime dependencies** in `packages/sim` and `packages/shared`.
- **Integer-only in `sim`.** The determinism scan and ESLint both enforce this and both are extended in Task 1. Rule constants are integers over a denominator of 1000, converted only in the constants file.
- **No module-level mutable state anywhere in `sim` or `shared`.** Module-scope literal data (direction tables, terrain codes, map rows) must be wrapped in `Object.freeze(... as const)` — `as const` alone is a type-level assertion with no runtime effect, and Task 1's AST rule rejects an unfrozen module-scope literal. Under `noUncheckedIndexedAccess`, indexing a frozen tuple with a `number` yields `T | undefined`; keep the existing `as number` cast convention rather than adding non-null assertions.
- **`packages/sim/test/determinism.test.ts` holds an exact `toEqual` over the scanned file list** (`determinism.test.ts:324`). Every task that adds a file under `packages/sim/src` or `packages/shared/src` must list that test as **Modified** and extend the list. The list must **never** be relaxed to a `length > 0` check — the test's own comment records that this already happened once and a whole suite ran green against the wrong package.
- **Every task mutation-tests its own tests.** This is the standing practice from M1a (`progress.md:13`). In addition to each task's named mutations:

  > For every behaviour in the coverage list, record in the task report the one-line implementation change that makes its test fail, and the observed failure. Where you cannot construct one, say so and why — a behaviour with no available mutation is either untestable at this layer or already covered elsewhere, and either answer is useful.

- Do not modify `spike/` — separate throwaway project.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```
- **Do not state expected test counts in your reports unless you ran them.** The plan deliberately does not assert counts; report the real number.

---

## Six design decisions this plan makes, and why

### 1. Terrain lives outside the snapshot — and everything the sim can change to it lives inside

`createState` currently takes only a seed. Terrain is authored per map, so it has two possible homes.

**Chosen: the terrain codes live outside the buffer, in an immutable `WorldData`; every mutation the simulation makes *to* the board lives inside the buffer.**

The invariant that matters for rollback is *"everything the simulation can change lives in the buffer"*. The reviewed draft read that as licence to exclude terrain wholesale, on the grounds that "static data cannot change" — and then Task 3 destroyed trees on placement (spec §5.1: a tree is "destroyed by any placement; exists to block spawns"). That is a write to shared immutable state. Three consequences, all invisible in M1b:

- rollback would restore the roads but not the tree;
- `WorldData` would become cross-instance mutable state shared by every `GameState` built from that map, surviving every snapshot;
- the two tests "clears the tree" and "place-then-erase restores the exact state hash" would be *simultaneously* satisfiable only because the tree is invisible to `hashState`.

Nothing in M1b reads terrain for spawning, so it stays green for a whole milestone and first bites in M1c as a spawn-placement divergence between a fresh run and a restored one — after the buffer layout is frozen.

**So: a `cleared` `Uint8Array` region of `w*h` joins the state buffer.** `placeRoad` writes it; the single reader `hasTree(state, world, cell)` is `terrain[cell] === TREE && cleared[cell] === 0`. A second byte region rather than a ninth road bit, because all eight road bits are used and stealing one costs more in reasoning than 960 bytes costs in snapshot size (spec §9.3 measures ~6× headroom).

A reviewer offered a derived alternative — "a tree is destroyed iff the cell has a road" — which needs no region. **Rejected:** erasing the road would resurrect the tree, changing spawn eligibility under §5.9, and no test in this milestone would see it.

`cleared` is monotonic within a timeline and is rolled back with the buffer, which is exactly right: rewinding to before the placement rewinds the destruction.

**The identity check that makes this safe.** Replay verification compares the map recorded in the submitted header against the map the Worker loaded. The reviewed draft hashed only the map's *id*, which means the one drift it cannot catch is a map edited between a run and its verification — same id, matching header, different board, silently scored wrong. `mapIdHash` therefore hashes the map's **content** (id, `w`, `h`, terrain, `startingTiles`), and the comparison is **not optional**: `restore(buffer, world)` performs it. `w` and `h` also get their own header slots, because 24×40, 40×24 and 20×48 are all 960 cells and a byte-length check cannot tell them apart.

**Consequence to hold onto:** the world is a *parameter*, so nothing may cache a derived view of it at module scope. Task 1's AST rule enforces that. And `WorldData.terrain` is a `Uint8Array`, whose contents `readonly` does not protect and `Object.freeze` cannot protect (freezing a typed array with elements throws). Its immutability is therefore a **tested** property, not a declared one — Task 3 pins it byte-for-byte across a place/erase sequence.

### 2. Roads are stored symmetrically

A road segment joins two cells. The bitmask could store it once (on the lower-indexed cell) or twice (both cells record the direction toward the other).

**Chosen: symmetric — both cells record it.** Traversal and rendering both ask "what leaves this cell", which a one-sided store answers only by also inspecting all eight neighbours. Symmetry costs one extra byte-write per placement and makes every read local. The cost is that the two halves can disagree if a bug writes one side only, so **symmetry is a tested invariant**, not an assumption: `assertSymmetric` walks the whole grid and asserts every set bit has its mirror.

The reviewed draft's `assertSymmetric` was self-blind: it recomputed neighbours with the same index arithmetic as `placeRoad`, and a pair that wraps the row seam *is* mirror-symmetric under that arithmetic. So `assertSymmetric` decomposes to `x`/`y` and treats a bit pointing off-grid as a violation in its own right, independently of whether it has a mirror.

### 3. Per-colour fields are derived and persistent, their staleness is derived from content, and working memory is transient and passed

Flow fields need `dist` and `dir` per colour, plus the bucket-queue working arrays. The reviewed draft put all of it in one `Scratch` object and justified it with "nothing reads scratch before writing it in the same tick". That argument is false for `dist`/`dir` **by design**: spec §5.4 rebuilds on dirty only, so on a clean tick cars read `dir[cell]` written on an earlier tick, and one `dist`/`dir` pair cannot hold five colours at once anyway.

**Chosen: two types, with two different invariants.**

- **`FlowField` — one per colour, persistent, derived.** `dist: Int32Array`, `dir: Int8Array`, plus the two input stamps below. Invariant: *fully overwritten on every rebuild, and rebuilt whenever the inputs it was built from have changed.* Not snapshotted: it is a pure function of (roads, sources), so storing 24 KB of it in every snapshot would buy nothing and would spend the §9.3 headroom.
- **`Scratch` — one, shared, transient.** `bucketHead`, `entryCell`, `entryNext`, `nbrCell`, `nbrDir`, `stats`. Invariant: *fully overwritten at entry to every call, never carries information from one call to the next.* This is the invariant the reviewed draft claimed for everything, and for these arrays it is true and testable.

Both are created once at boot and passed in. Neither goes at module scope — that is shared across state instances and survives a rollback, the exact bug Task 1's AST rule exists to prevent.

**The entry-pool cursor stays function-local.** It is the one piece of `Scratch`-shaped state that must not become a field: an implementer factoring `push` out of `computeFlowField` will reach for `scratch.top`, and a cursor that persists across calls silently exhausts the pool. If you factor it out, pass or return the cursor.

**Staleness is derived from content, not maintained as a flag. This changed after review, and it is the second-largest change in this document.**

The obvious design — and the one the reviewed draft's successor reached for — is an `H_FIELDS_DIRTY` header slot, set by every road mutation and by `restore`, cleared by the rebuild. It is worth writing down why that is wrong, because it is genuinely tempting and it *almost* works.

Three objections, in increasing order of seriousness:

1. **It is not game state.** The argument for its safety is that a rebuild is idempotent, so an over-conservative flag costs work and never correctness — which is precisely the argument for it being a cache-invalidation hint about a derived structure. Derived structures stay out of the snapshot; that is the same reasoning that keeps `FlowField` itself out.
2. **The snapshotted bit is never the value that decides.** Snapshot while dirty, restore later: the restored fields must be treated as stale — but they are stale regardless, because `restore` marks them. So the bit costs a header slot, costs the M1a round-trip invariant (`restore` would write to the buffer, so `hashState(restore(snapshot(s)))` would no longer equal `hashState(s)`), and costs two extra tests to fence the damage, in exchange for nothing that is ever read back.
3. **It relies on remembering.** Every mutation site must set it. A forgotten call site is *under*-conservative, which is the only failure mode that matters. M1c adds road-mutating paths this plan has not seen.

**Chosen: each `FlowField` records the hashes of the inputs it was built from, and staleness is a comparison against the inputs as they are now.**

```
FlowField.builtFromRoads    = nonZeroWord(hashBytes(state.roads) | 0)
FlowField.builtFromSources  = nonZeroWord(hashSources(sources) | 0)
```

- **`restore` writes nothing.** M1a's round-trip invariant survives untouched and needs no restatement.
- **Correct across rollback by construction.** This is why a monotonic version counter will not do, and the failure is concrete: build a field at version 5, restore to version 4, then place a *different* road, reaching version 5 again. The counter matches, the roads differ, and the stale field reads as fresh. A content hash cannot collide that way in any sequence, including ones nobody anticipated.
- **Nothing can be forgotten**, because there is nothing to set. A road-mutating function added in M1c inherits correct invalidation for free.

**The road region is not the whole input, and hashing only it would reintroduce the bug in a new place.** A field is a pure function of *(roads, sources, w, h)*. §5.4 seeds from "every unfilled pin of a colour", and pins change on every dispatch and every demand tick — far more often than roads do. A roads-only hash reports "fresh" across a completely changed source set, which is the same under-conservative failure as a forgotten call site, arrived at by a different route. So both hashes are stamped and both are checked. They are kept as two fields rather than one folded value because on a divergence investigation, knowing *which* input moved is exactly the attribution the ledger prizes (`progress.md:22`).

Terrain is deliberately absent from that list: `neighbours` does not filter terrain (Task 4) and source validity is decided by road bits, so terrain cannot affect a field. `w`/`h` are covered by `restore`'s map-identity check plus a `dist.length === world.cells` assertion in the accessor.

**Zero is reserved for "never built".** A freshly allocated `FlowField` has `builtFromRoads = 0`, all-zero `dist` and all-zero `dir` — which reads as "distance 0 everywhere, head North". FNV-1a can return 0 for some input, so if a real hash could ever be 0 a never-built field would read as fresh and send every car north. Both stamps are therefore forced non-zero through the same `nonZeroWord` that already guards the seed and the map hash. This is item 8(c)'s defect, one layer out.

**On hash collisions, since this project has rejected a probabilistic argument before.** A false "fresh" needs two distinct input states hashing equal — about 2⁻³² per check. Unlike the modulo bias, this **cannot cause a replay divergence**: the hash is a deterministic function of deterministic state, so a browser and a Worker replaying the same inputs collide at the same tick and use the same stale field, producing the same result. It is a rare deterministic gameplay glitch, not a verification failure, and its rate is far below that of the alternative's failure mode (a human forgetting a call site). Record the reasoning in the source comment; a reader who finds a hash where they expected a flag deserves it.

**Two functions, with deliberately different jobs.** `syncFields` is the once-per-tick rebuild point and is allowed to do work; `fieldFor` is the read accessor and **throws** if either stamp mismatches or the field was never built. `fieldFor` does not rebuild: a throw means "you read a field without syncing this tick", which is a bug worth surfacing rather than papering over with a per-car rebuild storm. §5.4's "coalesce dirty rebuilds to at most one per tick" is satisfied because `syncFields` is the only rebuild site.

`fieldFor` recomputes the road-region hash on each call — 1920 bytes of FNV at 24×40, called about once per colour per tick. If M1c's profile ever objects, the fix is to compute the road hash once at the top of the tick and pass it down. It is **never** to memoise it across ticks or across a restore, which would resurrect the version-counter collision above in a new disguise.

### 4. A road costs one tile per cell, per spec §5.11 — this is a change

The reviewed draft charged **1 tile per segment** and did not declare it. Spec §5.11 says: "One segment per cell in one of 8 directions. **Cost 1 tile per cell**." A straight run of N cells costs N−1 under the draft and N under the spec, and §5.10's flat tile income is tuned against the spec's model. An undeclared divergence in the whole tile economy is not something to discover during balance work.

**Chosen: per cell.** `canPlaceRoad` costs a placement as *the number of endpoint cells whose road mask is currently 0* — so 2 for a fresh segment in open ground, 1 when extending a run, 0 when the segment already exists. `eraseRoad` refunds *the number of endpoint cells whose mask becomes 0 after clearing the bit*.

This settles three questions the reviewed draft left open:

- **"Already present" is `ok` with `cost: 0`.** `placeRoad` writes nothing and charges nothing, and returns `true`. Making it a failure would have M1c's drag-to-place return `false` on every cell of an existing path.
- **Order of checks: bounds and adjacency → terrain → cost → budget.** The order is load-bearing, not incidental. A segment that is already present **while the budget is 0** returns `{ ok: true, cost: 0 }` — the budget test is `cost > tilesLeft`, evaluated after the cost is known, so a zero-cost operation passes on an empty budget. The natural implementation checks the budget first (`if (tilesLeft === 0) return budget-failure`) and rejects it, and M1c drags across existing road constantly, so that reads as an error in the HUD on every frame of a drag over a finished path. Both the test list and the mutation list below name this case explicitly.
- **The conservation invariant becomes an exact count.** `map.startingTiles − H_TILES === (number of cells whose road mask is non-zero)`. One assertion catching every budget leak and every stray bit. (The reviewed draft's proposed `popcount(all bits) / 2` was the per-segment form of the same idea; under per-cell costing it is no longer the budget invariant, but "total popcount is even and every bit is mirrored" remains covered by `assertSymmetric`.)

### 5. The buffer layout is frozen once, in Task 2

The reviewed draft grew the buffer across three tasks — a header slot in Task 2, a region in Task 3 — which meant three golden re-blessings, three revisions of `restore`'s size check, and a window in which `restore` validated against a constant that Task 3 would delete.

**Chosen: Task 2 declares the complete M1b region list and every header slot,** with a table recording which task gives each slot meaning. `H_TILES` is initialised to `map.startingTiles`, which Task 2 does own; Task 3 spends it. Exactly one golden re-bless in this milestone, in Task 2.

This is consistent with the M1a ruling that retained `H_SCORE` and dropped `H_RNG_DRAWS` (`progress.md:21`): retain what the design already commits to, not what it merely might want. Every slot below is written by a named task in *this* plan — which is also why there is no `H_FIELDS_DIRTY`: design decision 3 derives staleness from content instead, so no slot is needed and `restore` stays a pure read.

**Fixed-size regions precede every variable-size region.** `rng` and `header` first, then `roads` and `cleared`. If a variable region came first, a wrong-size buffer would displace the header and `restore` would read road bytes as the map hash — the mismatch would corrupt the very field that exists to detect it.

**Regions are sized for the map's maximum extent from tick 0.** Spec §5.1 expands the grid mid-run on a per-map schedule. If expansion resized the buffer, a pre-expansion snapshot could not restore into a post-expansion buffer and the state container would need rewriting in M1d. So `MapData.w`/`h` *are* the map's final extent; expansion (M1d) reveals cells, it does not resize anything.

### 6. Source lists are canonically ordered, and `computeFlowField` enforces it

At a tie, which of two equal-cost neighbours `dir` points to is decided by push order, and push order is source order. Verified on a five-cell corridor with sources at both ends: `[0, 4]` gives `dir [-1, 6, 6, 2, -1]` and `[4, 0]` gives `dir [-1, 6, 2, 2, -1]`. `dist` is byte-identical both ways, and `dir` is not in the state hash, so nothing in the reviewed draft could see it.

§5.4 seeds a field from "every unfilled pin of a colour". The moment that list comes from iterating a `Map` or a `Set`, the browser and the Worker disagree about `dir`, cars take different routes, and score verification rejects an honest run.

**Chosen: `sources` is a strictly ascending list of cell indices, and `computeFlowField` throws if it is not.** Strictly ascending gives canonical order and de-duplication in one contract — and de-duplication is load-bearing, because up to 14 pins can sit on one destination cell (§5.8), so a pin-derived list is duplicate-heavy by construction. Callers dedupe; the field cares about the cell set, not the pin count. Ties on pin id are resolved upstream when pins are mapped to cells, in M1c.

---

## File Structure

| File | Responsibility |
|---|---|
| `tools/eslint-rules/index.js` | Local ESLint plugin: three AST rules |
| `tools/eslint-rules/package.json` | Makes the rules a workspace package so their tests actually run |
| `tools/eslint-rules/test/rules.test.js` | `RuleTester` cases, valid and invalid |
| `packages/sim/src/layout.ts` | Declarative buffer layout: region table → offsets, with alignment checked |
| `packages/sim/src/state.ts` | *Modified* — built from the layout table; road, cleared and header regions |
| `packages/shared/src/mapFormat.ts` | `MapData`, terrain codes, `parseMap` from a string encoding |
| `packages/shared/src/maps/firstCity.ts` | The one launch map, as frozen string data |
| `packages/sim/src/world.ts` | `WorldData` — immutable per-run context built from a `MapData`; `mapIdHash` |
| `packages/sim/src/roads.ts` | 8-direction bitmask: place, erase, budget, tree clearing, symmetry invariant |
| `packages/sim/src/graph.ts` | Traversable-edge queries over roads |
| `packages/sim/src/scratch.ts` | `Scratch` and `FlowField` allocation, sized from the map |
| `packages/sim/src/flowfield.ts` | Multi-source Dijkstra, Dial buckets, content-derived staleness |
| `packages/sim/test/*.test.ts` | One per module, plus `determinism.test.ts` extended in every task that adds a source file |

---

## Task 1: Harden enforcement, and make the buffer layout declarative

This is the carry-forward from M1a's final review (`progress.md:38-44`). It ships no game logic and is the prerequisite for everything after it.

**Files:**
- Create: `tools/eslint-rules/index.js`, `tools/eslint-rules/package.json`, `tools/eslint-rules/test/rules.test.js`
- Create: `packages/sim/src/layout.ts`, `packages/sim/test/layout.test.ts`
- Modify: `eslint.config.js`, `package.json` (root test/typecheck scripts), `pnpm-workspace.yaml`, `packages/sim/src/state.ts`, `packages/sim/test/state.test.ts`, `packages/sim/test/determinism.test.ts` (adds `sim/src/layout.ts` to the scanned file list)

**Interfaces produced:**

```ts
export type RegionCtor =
  | Uint8ArrayConstructor
  | Int8ArrayConstructor
  | Uint16ArrayConstructor
  | Int16ArrayConstructor
  | Uint32ArrayConstructor
  | Int32ArrayConstructor

export interface Region { readonly name: string; readonly ctor: RegionCtor; readonly len: number }
export interface LayoutEntry extends Region { readonly offset: number }
export interface Layout { readonly entries: readonly LayoutEntry[]; readonly totalBytes: number }
export function computeLayout(regions: readonly Region[]): Layout
```

`state.ts` keeps every existing export **for the duration of this task** — `createState(seed)`, `snapshot`, `restore(buffer)`, `hashState`, `STATE_BYTES`, `nonZeroSeed`, the header index constants. Task 2 replaces `STATE_BYTES` with `stateBytesFor(map)` and changes both signatures; do not anticipate that here.

### Why an AST rule, when two mechanisms already exist

M1a's final review found a violation form that walks through both:

```ts
const m = Math
const x = m.random()
```

Verified against a real ESLint run: bracket access (`Math['random']()`) and destructuring (`const { random } = Math`) *are* caught; **variable aliasing is not**, in either mechanism. And it cannot be fixed by name-banning, because `Math.imul` and `Math.min` are load-bearing in `rng.ts`. The same trick defeats `Date.now`, `performance.now` and the transcendental bans.

The same review also confirmed the module-scope rules are evadable by indentation (indentation has no scoping effect in JS) and by a line-wrapped declaration. Both are line-regex limitations, and both dissolve under an AST check.

The regex scan stays. It catches things the AST rules will not bother with, it runs in CI with the suite, and it cannot be silenced by an inline disable. The three mechanisms cover each other's blind spots — that is the argument, and it should be stated in the config rather than assumed.

- [ ] **Step 1: Write the failing test for the layout**

`packages/sim/test/layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeLayout } from '../src/layout'

describe('computeLayout', () => {
  it('places the first region at offset 0', () => {
    const { entries } = computeLayout([{ name: 'a', ctor: Int32Array, len: 2 }])
    expect(entries[0]!.offset).toBe(0)
  })

  it('packs regions consecutively when alignment allows', () => {
    const { entries, totalBytes } = computeLayout([
      { name: 'a', ctor: Int32Array, len: 2 },
      { name: 'b', ctor: Int32Array, len: 1 },
    ])
    expect(entries[0]!.offset).toBe(0)
    expect(entries[1]!.offset).toBe(8)
    expect(totalBytes).toBe(12)
  })

  it('pads so every region starts on its own alignment boundary', () => {
    // A 3-byte Uint8Array followed by an Int32Array: without padding the Int32
    // would start at 3 and throw "start offset should be a multiple of 4" at
    // construction, naming none of the causes.
    const { entries, totalBytes } = computeLayout([
      { name: 'bytes', ctor: Uint8Array, len: 3 },
      { name: 'ints', ctor: Int32Array, len: 1 },
    ])
    expect(entries[0]!.offset).toBe(0)
    expect(entries[1]!.offset).toBe(4)
    expect(totalBytes).toBe(8)
  })

  it('rounds the total up to 4 even when no region is that wide', () => {
    // This is the case that made the reviewed draft red at Step 4: a maxAlign
    // starting at 1 and rising only to the widest *declared* region gives
    // totalBytes 5 here. The buffer's byteLength must be a whole multiple of
    // the widest element any view over it will use, or that view is not
    // constructible at all.
    const { totalBytes } = computeLayout([{ name: 'bytes', ctor: Uint8Array, len: 5 }])
    expect(totalBytes).toBe(8)
  })

  it('every entry offset is a multiple of its element size', () => {
    const { entries } = computeLayout([
      { name: 'a', ctor: Uint8Array, len: 960 },
      { name: 'b', ctor: Int32Array, len: 3 },
      { name: 'c', ctor: Uint8Array, len: 1 },
      { name: 'd', ctor: Uint32Array, len: 1 },
    ])
    for (const e of entries) {
      expect(e.offset % e.ctor.BYTES_PER_ELEMENT, `${e.name} misaligned at ${e.offset}`).toBe(0)
    }
  })

  it('handles the 1505-cell grid the naive layout would break on, fixed regions first', () => {
    // 24x40 = 960 is divisible by 4; the spec's own 43x35 = 1505 is not, and
    // hand-computed offsets would put whatever follows it at 1521.
    //
    // Note the ordering: the fixed-size header comes FIRST. Design decision 5
    // requires that of the real layout, because a wrong-size buffer must not be
    // able to displace the header that `restore` reads to detect the mismatch.
    // The exemplar follows the same rule so it cannot teach the wrong shape.
    const { entries, totalBytes } = computeLayout([
      { name: 'header', ctor: Int32Array, len: 4 },
      { name: 'terrain', ctor: Uint8Array, len: 1505 },
      { name: 'trailing', ctor: Int32Array, len: 1 },
    ])
    expect(entries[0]!.offset).toBe(0)
    expect(entries[1]!.offset).toBe(16)
    expect(entries[2]!.offset).toBe(1524) // 16 + 1505 = 1521, padded to 1524
    expect(totalBytes).toBe(1528)
  })

  it('carries name, ctor and len through unchanged', () => {
    // `{ name, ctor, len: 0, offset }` would satisfy every offset assertion
    // above and produce a zero-length view over the right address.
    const { entries } = computeLayout([{ name: 'roads', ctor: Uint8Array, len: 960 }])
    expect(entries[0]).toEqual({ name: 'roads', ctor: Uint8Array, len: 960, offset: 0 })
  })

  it('rejects duplicate region names', () => {
    expect(() => computeLayout([
      { name: 'a', ctor: Int32Array, len: 1 },
      { name: 'a', ctor: Int32Array, len: 1 },
    ])).toThrow(/duplicate/i)
  })

  it('rejects a negative or non-integer length', () => {
    expect(() => computeLayout([{ name: 'a', ctor: Int32Array, len: -1 }])).toThrow()
    expect(() => computeLayout([{ name: 'a', ctor: Int32Array, len: 1.5 }])).toThrow()
  })

  it('accepts an empty region list', () => {
    expect(computeLayout([]).totalBytes).toBe(0)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

`pnpm --filter @laneways/sim test layout` — cannot resolve `../src/layout`.

- [ ] **Step 3: Implement the layout**

`packages/sim/src/layout.ts`:

```ts
/**
 * Declarative buffer layout.
 *
 * The state buffer grew hand-computed offsets in M1a, and a reviewer had to
 * verify by hand that two regions did not overlap or leave a gap. That does not
 * survive four regions.
 *
 * The hazard is alignment. Today's layout is [rng Uint32 x 1 @0, header Int32
 * x 3 @4] and is legal because both regions are 4-byte-aligned by construction.
 * The moment a byte region of odd length sits before a wider one it stops being
 * legal: the spec's own 43x35 = 1505 grid would put the next Int32 region at
 * 1521 and throw `RangeError: start offset of Int32Array should be a multiple
 * of 4`, naming neither the region nor the cause.
 *
 * Regions are declared; offsets are derived, padded to each region's own
 * alignment, and asserted.
 *
 * Padding lands INSIDE the hashed range, which M1a's reviewer certified was
 * free of dead bytes. That certification is superseded deliberately, not
 * accidentally: pad bytes are zero-initialised by `new ArrayBuffer`, copied
 * verbatim by `snapshot` and `restore`, and written by nothing, so they are
 * deterministic in every engine and contribute a constant to every hash.
 */

export type RegionCtor =
  | Uint8ArrayConstructor
  | Int8ArrayConstructor
  | Uint16ArrayConstructor
  | Int16ArrayConstructor
  | Uint32ArrayConstructor
  | Int32ArrayConstructor

export interface Region {
  readonly name: string
  readonly ctor: RegionCtor
  readonly len: number
}

export interface LayoutEntry extends Region {
  readonly offset: number
}

export interface Layout {
  readonly entries: readonly LayoutEntry[]
  readonly totalBytes: number
}

export function computeLayout(regions: readonly Region[]): Layout {
  // Membership only — never iterated, so spec §4.1's ban on Map/Set iteration
  // does not apply. Task 1's `no-collection-iteration` rule permits `has`/`add`
  // for exactly this reason, and would report a `for (const n of seen)`.
  const seen = new Set<string>()
  const entries: LayoutEntry[] = []
  let offset = 0
  // Starts at 4, not 1. Per-region padding already guarantees each region's own
  // alignment, so the tail is not about later appends — it is about the whole
  // buffer: `byteLength` must be a whole multiple of the widest element size
  // any view over it will use, or that view cannot be constructed. Every state
  // buffer carries at least one 4-byte region.
  let maxAlign = 4

  for (const r of regions) {
    if (seen.has(r.name)) throw new Error(`computeLayout: duplicate region name "${r.name}"`)
    seen.add(r.name)
    if (!Number.isInteger(r.len) || r.len < 0) {
      throw new Error(`computeLayout: region "${r.name}" has invalid length ${r.len}`)
    }
    const align = r.ctor.BYTES_PER_ELEMENT
    if (align > maxAlign) maxAlign = align
    const pad = (align - (offset % align)) % align
    offset += pad
    entries.push({ ...r, offset })
    offset += r.len * align
  }

  const tail = (maxAlign - (offset % maxAlign)) % maxAlign
  return { entries, totalBytes: offset + tail }
}
```

The object spread `{ ...r, offset }` is deterministic: ECMAScript specifies own-property enumeration order for string keys, so the resulting object is identical on every engine. It is not the "iteration over object keys" §4.1 bans, which is about *sim-affecting* order-dependent reads.

- [ ] **Step 4: Confirm the layout tests pass**

- [ ] **Step 5: Rebuild `state.ts` on the layout table**

Replace the hand-computed offsets with a declared region list and views built by iterating it. The declared list must reproduce today's layout exactly — `rng` Uint32×1 at 0, `header` Int32×3 at 4, `STATE_BYTES` 16.

**The golden hash must not change in this task.** If it does, the rebuild altered something, and that is a finding to report, not a value to re-bless.

Add a test asserting the **views**, not the table. The table's internal consistency is what `computeLayout` guarantees by construction and cannot fail; what can fail is `viewsOver` wiring a view to the wrong entry. Assert that every view's `byteOffset` and `length` equal its entry's `offset` and `len`, that the views tile the buffer with no overlap, and that the sum of view byte lengths plus padding equals `buffer.byteLength`.

- [ ] **Step 6: Write the AST rules**

`tools/eslint-rules/index.js`, a flat-config-compatible plugin exporting three rules.

**`no-module-mutable-state`** — reports, at module scope only:
- a `let` or `var` declaration;
- a `const` whose initialiser is `new <TypedArray|ArrayBuffer|SharedArrayBuffer|Map|Set|WeakMap|WeakSet>(...)`;
- a `const` whose initialiser contains an array or object literal that is **not the direct argument of `Object.freeze(...)`**, looking through `TSAsExpression` so that `Object.freeze([0, 1] as const)` is accepted and `[0, 1] as const` alone is not.

The "anywhere in the initialiser" formulation is what handles nesting: `Object.freeze` is shallow, so `Object.freeze([[1], [2]])` leaves the inner arrays mutable and must be reported.

Indentation is irrelevant to an AST rule, and a line-wrapped declaration is one node, so both of M1a's disclosed regex evasions dissolve.

This rule is the reason design decision 3's data tables are frozen. Tasks 2 and 3 must write `TERRAIN`, `DX`, `DY`, `OPPOSITE` and the map rows at module scope; without the `Object.freeze` carve-out the rule would make Task 3 unimplementable, which is exactly what the reviewed draft specified.

**`no-aliased-globals`** — reports any reference to `Math`, `Date`, `performance`, `globalThis`, `self`, `window` or `document` as an identifier in a value position **other than** the object of a member expression. That catches `const m = Math`, `f(Math)`, `[Math][0]`, `{ m: Math }` and `const { ...rest } = Math`, while leaving `Math.imul(a, b)` and `Math.min(a, b)` alone. This closes the `const m = Math; m.random()` hole M1a's re-review found (`progress.md:39`).

**`no-collection-iteration`** — the ledger's carry item 5 (`progress.md:43`), which spec §4.1 requires and neither existing mechanism enforces. Reports `Object.keys`, `Object.values`, `Object.entries`, `Object.getOwnPropertyNames`, any `for...in`, and any `for...of` whose right-hand side is a `.keys()` / `.values()` / `.entries()` call. Permits `Set`/`Map` used only through `has`, `add`, `get`, `set` and `delete` — membership is order-free and `computeLayout`'s duplicate-name check is exactly that. Record the exemption and its reasoning in the rule's own doc comment, because a reader who finds a `Set` in the first file the rule guards will otherwise assume the rule is broken.

**`RuleTester` cases.** The valid cases matter as much as the invalid ones — a rule that reports the code the next two tasks must write is unusable, and that is the defect this replaces:

| Rule | Valid (must NOT report) | Invalid (must report) |
|---|---|---|
| `no-module-mutable-state` | `Object.freeze([0,1,1,1,0,-1,-1,-1] as const)`; `Object.freeze({ LAND: 0 } as const)`; `export const DENOM = 1000`; `const x = Math.imul(a, b)`; `function f() { let i = 0; const a = new Uint8Array(4) }` | `const DX = [0,1]`; `const DX = [0,1] as const`; `const T = { LAND: 0 }`; `let x = 0`; `var y`; `export let c = 0`; `const m = new Map()`; `export const buf =\n  new Uint8Array(4)` (line-wrapped); `  let s = 0` (indented, module scope); `Object.freeze([[1],[2]])` (inner literals unfrozen) |
| `no-aliased-globals` | `Math.imul(a, b)`; `Math.min(a, b)`; `const x = 1` | `const m = Math`; `let d = Date`; `const p = performance`; `const g = globalThis`; `f(Math)`; `const { ...rest } = Math` |
| `no-collection-iteration` | `s.has(x)`; `s.add(x)`; `m.get(k)`; `for (const c of arr)`; `{ ...r, offset }` | `Object.keys(o)`; `Object.entries(o)`; `for (const k in o) {}`; `for (const [k, v] of m.entries()) {}` |

- [ ] **Step 7: Make the rules' own tests run, and wire the plugin in**

`pnpm test` is `pnpm -r --filter './packages/*' test`. `tools/eslint-rules/` is outside that filter, so without this step the safety net's own tests sit unexecuted in CI — this project's signature failure mode, one level up.

Add `tools/*` to `pnpm-workspace.yaml`, give `tools/eslint-rules` a `package.json` with a real `test` script, and extend the root `test` and `typecheck` scripts to cover it. Keeping the rules under `tools/` rather than `packages/` is deliberate: they are not shipped sim code, and the determinism scan's roots must not grow to include them.

Register the plugin in `eslint.config.js` and enable all three rules for `packages/sim/src/**` and `packages/shared/src/**`. Add a comment recording *why there are now three mechanisms*: ESLint's name-based rules catch bracket access and destructuring; the AST rules catch aliasing, module-scope state and collection iteration; the regex scan catches float literals, `new Date`, `.sort()` and `globalThis`, runs in CI with the suite, and cannot be silenced by an inline disable. Each covers a blind spot of the others.

- [ ] **Step 8: Prove every mechanism fires**

Plant each of these in real sim source, one at a time, confirm the expected mechanism objects, then remove:

| Violation | Expected to be caught by |
|---|---|
| `const m = Math` then `m.random()` | AST `no-aliased-globals` |
| `  let scratch = 0` at module scope, indented | AST `no-module-mutable-state` |
| `export const buf =\n  new Uint8Array(4)` line-wrapped | AST `no-module-mutable-state` |
| `const DX = [0, 1] as const` at module scope | AST `no-module-mutable-state` |
| `for (const k in obj)` in sim source | AST `no-collection-iteration` |
| `Math['random']()` | ESLint `no-restricted-properties` |
| `const x = .5` | regex scan |
| `Math.random()` in `packages/shared/src` | scan and ESLint |

Then run all three rules over the **existing tree** and confirm it is clean — a rule that only ever ran against its own fixtures has not been tested against reality.

Report the runner output line showing `tools/eslint-rules`' tests actually executing, not just that `pnpm test` was green. Record each row's result. **If any is not caught, say so plainly** — a mechanism that does not fire is worse than none, because it reads as coverage.

- [ ] **Step 9: Mutation-test**

Named mutations: delete the `Object.freeze` carve-out from `no-module-mutable-state` (the valid-case RuleTester tests must fail); change `maxAlign` back to `1` (the round-up-to-4 test must fail); make `computeLayout` return `{ name, ctor, len: 0, offset }` (the carry-through test must fail); wire `viewsOver`'s second view to the first entry (the view-tiling test must fail).

Plus the standing per-behaviour obligation from Global Constraints.

- [ ] **Step 10: Verify and commit**

`pnpm test`, `pnpm typecheck`, `pnpm lint` clean. Confirm and report that the golden hash is unchanged at `917870623`.

---

## Task 2: Map format, terrain, and the frozen buffer layout

This task owns the whole buffer shape for M1b (design decision 5) and is the only task in this milestone that re-blesses the golden hash.

**Files:**
- Create: `packages/shared/src/mapFormat.ts`, `packages/shared/src/maps/firstCity.ts`, `packages/shared/test/mapFormat.test.ts`
- Create: `packages/sim/src/world.ts`, `packages/sim/test/world.test.ts`
- Modify: `packages/shared/src/index.ts`, `packages/sim/src/index.ts`, `packages/sim/src/state.ts`
- Modify: `packages/sim/test/state.test.ts`, `packages/sim/test/step.test.ts` (both call `createState(seed)`, which gains a map)
- Modify: `packages/sim/test/determinism.test.ts` — adds `shared/src/mapFormat.ts`, `shared/src/maps/firstCity.ts` and `sim/src/world.ts` to the scanned file list, and re-blesses the golden

**Interfaces produced:**

```ts
// @laneways/shared
export const TERRAIN = Object.freeze({ LAND: 0, WATER: 1, MOUNTAIN: 2, TREE: 3 } as const)
export type TerrainCode = 0 | 1 | 2 | 3

export interface MapData {
  readonly id: string
  /** Maximum extent. Expansion (§5.1, M1d) reveals cells; it never resizes the buffer. */
  readonly w: number
  readonly h: number
  readonly terrain: readonly TerrainCode[]   // index = y * w + x
  readonly startingTiles: number
}

export function parseMap(id: string, rows: readonly string[], startingTiles: number): MapData
export function firstCity(): MapData         // builds from frozen row data at call time

// @laneways/sim
export interface WorldData {
  readonly map: MapData
  readonly w: number
  readonly h: number
  readonly cells: number
  /** Immutable by contract; pinned by test, because a Uint8Array cannot be frozen. */
  readonly terrain: Uint8Array
  /** 1 for LAND and TREE, 0 for WATER and MOUNTAIN. */
  readonly passable: Uint8Array
}

export function createWorld(map: MapData): WorldData
/** Signed, non-zero, content-derived. */
export function mapIdHash(map: MapData): number
export function assertWorldMatches(state: GameState, world: WorldData): void

// @laneways/sim — state.ts, changed signatures
export function stateBytesFor(map: MapData): number   // replaces STATE_BYTES, which is deleted
export function createState(seed: string, map: MapData): GameState   // no default for `map`
export function restore(buffer: ArrayBuffer, world: WorldData): GameState   // `world` mandatory
export function nonZeroWord(v: number): number        // renamed from nonZeroSeed; two callers now

export interface GameState {
  readonly buffer: ArrayBuffer
  readonly rng: Uint32Array
  readonly header: Int32Array
  readonly roads: Uint8Array     // written from Task 3
  readonly cleared: Uint8Array   // written from Task 3
}
```

**The frozen layout.** Fixed-size regions first (design decision 5):

| Region | Type | Length | Written by |
|---|---|---|---|
| `rng` | `Uint32Array` | 1 | M1a |
| `header` | `Int32Array` | `HEADER_LENGTH` | see below |
| `roads` | `Uint8Array` | `w * h` | Task 3 |
| `cleared` | `Uint8Array` | `w * h` | Task 3 |

| Slot | Index | Meaning | Written by |
|---|---|---|---|
| `H_TICK` | 0 | tick counter | M1a |
| `H_SCORE` | 1 | score | M1a (tests only, retained per `progress.md:21`) |
| `H_WEEK` | 2 | week index | M1a |
| `H_MAP` | 3 | signed non-zero content hash of the map | Task 2 |
| `H_MAP_W` | 4 | map width | Task 2 |
| `H_MAP_H` | 5 | map height | Task 2 |
| `H_TILES` | 6 | road tile budget, initialised to `map.startingTiles` | Task 2 initialises, Task 3 spends |
| `HEADER_LENGTH` | 7 | | |

There is deliberately no dirty-flag slot; see design decision 3.

**Do not give `map` a default value on `createState`.** Existing test files call `createState(seed)`; a default is the path of least resistance and would make the board implicit while `H_MAP` records whatever the default happened to be that day. Update the call sites instead.

**`mapIdHash` hashes content, returns signed, and is forced non-zero.** Three separate defects in the reviewed draft, each found by a different reviewer:

- *Signedness.* `seedFromString` returns `>>> 0` (`rng.ts:22`) and `hashBytes` likewise (`hash.ts:12`), but the header is an `Int32Array`, so the read comes back negative and `header[H_MAP] !== mapIdHash(map)` **false-rejects a valid replay** for every map hashing ≥ 2³¹ — including the launch map. A test worded "deterministic and differs across ids" passes anyway.
- *Content-blindness.* Hashing the id alone cannot detect a map edited between a run and its verification, which voids the "one integer comparison" purchase that justifies design decision 1.
- *Zero.* Nothing forced it away from 0, which is what a blank header holds.

The recipe, stated exactly because two engines must agree on it: build a `Uint8Array` holding the id's length as 4 bytes little-endian, then each `charCodeAt(i)` as 2 bytes little-endian, then `w`, `h`, `startingTiles` as 4 bytes little-endian each, then one byte per terrain code in cell-index order. Feed it to the existing `hashBytes`, then `nonZeroWord(hash | 0)`. The length prefix is not decoration: without it, a boundary between a variable-length id and the fixed fields is ambiguous and two different maps can produce the same byte stream.

`nonZeroSeed` is renamed `nonZeroWord`. It now guards two distinct "0 is what a blank buffer holds" slots and one shared pure function is better than two identical ones; the M1a comment explaining why it is exported rather than inlined still applies and should be extended to mention the second caller.

Terrain is authored as an array of strings, one per row, one character per cell — `.` land, `~` water, `^` mountain, `T` tree. It is human-readable in source, diffs legibly, and cannot drift out of shape without `parseMap` noticing.

**No module-scope typed arrays and no module-scope `MapData`.** The map module exports frozen row strings plus a builder function; `createWorld` and `parseMap` allocate at call time. That is what keeps Task 1's AST rules satisfiable in `shared`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/mapFormat.test.ts` must cover:

- a valid map parses to the right `w`, `h` and codes. Assert at an **asymmetric `(x, y)`** on a non-square fixture — `terrain[y * w + x]` and `terrain[x * h + y]` agree at every `(k, k)`, and a transposed `parseMap` would pass otherwise.
- each of `.`, `~`, `^`, `T` maps to `LAND`, `WATER`, `MOUNTAIN`, `TREE` **by exact value**. There is no inverse function, so "round-trips" is not a testable claim; a `MOUNTAIN`/`TREE` transposition inverts `passable` and must be caught here.
- a ragged map (rows of differing length) throws, and the message names the offending row index.
- an unknown character throws, and the message names the character and its `(x, y)`.
- `parseMap(id, [], n)` throws **matched against its own message regex**, and so does `parseMap(id, [''], n)`. `[]` alone is not enough: `rows[0].length` on `[]` is a native `TypeError`, so a bare `.toThrow()` passes with the guard deleted — this is `state.test.ts:50-57` again, which already carries the comment explaining why. `['']` gives `w = 0, h = 1` and throws nothing native, so it is the case that actually exercises the guard.
- a negative or non-integer `startingTiles` throws.
- the returned `MapData` and its `terrain` array are frozen (mutation attempts throw in the module's strict-mode context).

`packages/sim/test/world.test.ts` must cover:

- `createWorld` produces `terrain` and `passable` arrays of exactly `w * h`.
- `passable` is 1 exactly for `LAND` and `TREE`, 0 for `WATER` and `MOUNTAIN` (trees are destroyed by placement, so they do not block roads — spec §5.1). **Derive the expectation from `map.terrain` or from the source rows, never from `world.terrain`** — deleting the terrain copy loop in `createWorld` leaves an all-`LAND` array and a self-derived test still passes. Add the vacuity self-check the ledger established at `progress.md:4-5`: assert the fixture actually contains all four codes.
- the same `MapData` yields byte-identical `WorldData` across two calls.
- `mapIdHash` is deterministic, and **negative for at least one map** — pick or construct a map whose content hashes ≥ 2³¹ and assert the value is `< 0` and equals what the header round-trips.
- `mapIdHash` differs for two same-length ids with identical boards (`'firstCity'` / `'firstCitz'`).
- `mapIdHash` differs when only the **terrain content** changes, with the id, `w`, `h` and `startingTiles` held equal.
- `mapIdHash` is never 0: call `nonZeroWord(0)` directly and assert 1, the way M1a made the zero-seed path testable.

`packages/sim/test/state.test.ts` gains:

- `createState` writes `H_MAP`, `H_MAP_W`, `H_MAP_H` and seeds `H_TILES` from `map.startingTiles` — assert each slot's exact value.
- two states with the **same seed and different maps** hash differently.
- `restore` rejects a buffer whose `H_MAP` disagrees with the world, using **two distinct maps with identical dimensions**. This is the only construction that reaches the check: whenever `w * h` differs, the byte-length guard fires first and the map-hash comparison — the entire justification for design decision 1 — is never exercised by its own test.
- `restore` **does not** throw for a matching world. Without this, `assertWorldMatches = () => { throw new Error() }` passes every other assertion in the file.
- the byte-length guard's message names the map id and both sizes.
- the guard message tests are updated from `STATE_BYTES` to `stateBytesFor(map)`.

- [ ] **Step 2: Confirm they fail**

- [ ] **Step 3: Implement `mapFormat.ts` and the first map**

`firstCity` is a 24×40 map: mostly land, a river of `~` running roughly north-south with a two-cell gap, a small `^` mountain cluster, and scattered `T`. Keep it simple — its job is to exercise every terrain code and every placement rule, not to be good level design. Note in a comment that it is a fixture, not the shipping map, and that its `w`/`h` are the map's *final* extent per design decision 5.

Row data is `Object.freeze([...] as const)`; `firstCity()` calls `parseMap` at call time.

- [ ] **Step 4: Implement `world.ts`**

`createWorld` allocates the typed arrays *inside the function*, never at module scope. `passable` is precomputed once because it is read on every pathfinding relaxation and recomputing it per query would be the dominant cost.

- [ ] **Step 5: Rebuild `state.ts` on the frozen layout**

Declare the full region list and all eight header slots. Implement `stateBytesFor(map)` and delete `STATE_BYTES`. Change `createState` and `restore` to their new signatures and update every call site.

`restore` validates in this order — byte length (message naming the map id, the expected size and the actual), then `assertWorldMatches`, which compares `H_MAP`, `H_MAP_W` and `H_MAP_H` and throws naming the mismatched slot and both values.

- [ ] **Step 6: Mutation-test**

Named mutations: return `hashBytes(...)` from `mapIdHash` without `| 0` (the negative-hash test must fail); hash only `map.id` (the content-change test must fail); delete `nonZeroWord`'s ternary (the zero-path test must fail); make `assertWorldMatches` throw unconditionally (the positive-case test must fail); delete the terrain copy loop in `createWorld` (the `passable` test must fail — if it does not, the test is deriving its expectation from `world.terrain` and must be rewritten); swap `MOUNTAIN` and `TREE`'s codes (the exact-value test must fail); write `terrain[x * h + y]` in `parseMap` (the asymmetric-cell test must fail).

Plus the standing per-behaviour obligation.

- [ ] **Step 7: Verify and commit**

Re-bless the golden hash and report the old and new values in the same commit as the change. The golden replay now also pins the map's content hash and dimensions, which is worth saying in its comment.

Use a small dedicated fixture map defined in `determinism.test.ts` for the golden replay, not `firstCity()`. Otherwise every future level-design edit churns the golden. Pin `firstCity()`'s content hash in a separate one-line test instead — that is the assertion that *should* fire when the map changes.

---

## Task 3: Road placement, erasure, the tile budget, and tree clearing

**Files:**
- Create: `packages/sim/src/roads.ts`, `packages/sim/test/roads.test.ts`
- Modify: `packages/sim/src/index.ts`
- Modify: `packages/sim/test/determinism.test.ts` — adds `sim/src/roads.ts` to the scanned file list

No layout change: `roads`, `cleared` and `H_TILES` were declared in Task 2. **The golden hash must not change in this task.**

**Interfaces produced:**

```ts
/** 8 directions, index 0 = N, clockwise. index = y * w + x throughout. */
export const DIR_COUNT = 8
export const DX = Object.freeze([0, 1, 1, 1, 0, -1, -1, -1] as const)
export const DY = Object.freeze([-1, -1, 0, 1, 1, 1, 0, -1] as const)
export const OPPOSITE = Object.freeze([4, 5, 6, 7, 0, 1, 2, 3] as const)

/** Direction index from `from` to `to`, or -1 if they are not 8-adjacent on a w x h grid. */
export function dirBetween(from: number, to: number, w: number, h: number): number

export type PlaceFailure = 'out-of-bounds' | 'not-adjacent' | 'terrain' | 'budget'
export type PlaceResult =
  | { readonly ok: true; readonly cost: number }        // 0, 1 or 2 tiles
  | { readonly ok: false; readonly reason: PlaceFailure }

export function canPlaceRoad(state: GameState, world: WorldData, a: number, b: number): PlaceResult
export function placeRoad(state: GameState, world: WorldData, a: number, b: number): boolean
export function eraseRoad(state: GameState, world: WorldData, a: number, b: number): boolean
export function roadMask(state: GameState, cell: number): number
export function tilesLeft(state: GameState): number
/** The single reader of `cleared`. M1c's spawn placement calls this, not `terrain`. */
export function hasTree(state: GameState, world: WorldData, cell: number): boolean

// test helpers, exported from src so they are type-checked and linted like real code
export function assertSymmetric(state: GameState, world: WorldData): void
export function assertNoRoadOnImpassable(state: GameState, world: WorldData): void
```

`eraseRoad` gains `world`. In the reviewed draft it had neither `w` nor `world` and therefore could not compute the direction between its two arguments at all.

Rules, from spec §5.11 and design decision 4:

- One segment per cell pair, adjacent orthogonally or diagonally.
- **Cost 1 tile per newly-occupied cell** — 2 for a fresh segment, 1 when extending, 0 for a duplicate. Erase refunds 1 per newly-vacated cell.
- **Land only, checked as a whitelist on both endpoints.** `LAND` or `TREE` — matching `passable`, which fails closed. The reviewed draft blacklisted `WATER` and `MOUNTAIN`, so `world.terrain[b] === undefined` for an off-grid `b` was *accepted*. A single-endpoint check also passes every otherwise-named test; only a land→water *ordering* catches it.
- `TREE` is permitted, and the placement sets `cleared[cell] = 1` **for a `TREE` endpoint only**, so `cleared` means exactly "a tree stood here and was destroyed". Erasing the road does not resurrect it (design decision 1).
- Placement fails, changing nothing, when the budget is short.
- Erase refunds immediately. *Delayed refund while a car is committed (§5.11's ghost roads) is M1c's problem — there are no cars yet. Say so in a comment so nobody assumes it was forgotten.*
- **Nothing here notifies the pathfinder.** Field staleness is derived from the road region's content (design decision 3), so a road mutation is invalidation. Say so in a comment at the top of the module, because the absence of a `markDirty` call is the kind of thing a reader assumes was forgotten.

**`dirBetween` needs `h`, and validating the range is the whole point.** Verified against the reviewed draft's signature: an `x`/`y` implementation returns `0` (North) for `dirBetween(0, -24, 24)`, and an index-delta implementation returns `2` (East) for `dirBetween(23, 24, 24)` — the row seam. The named test "placing between non-adjacent cells fails" passes against both. So:

```
dirBetween(from, to, w, h):
  reject unless 0 <= from < w*h and 0 <= to < w*h and both are integers
  dx = (to % w) - (from % w)
  dy = ((to / w) | 0) - ((from / w) | 0)
  reject unless |dx| <= 1 and |dy| <= 1 and not (dx === 0 && dy === 0)
  return the index k with DX[k] === dx and DY[k] === dy
```

Why this matters more than it looks: an out-of-range typed-array write is a **silent no-op**. Under the draft's arithmetic a wrapped pair yields a half-present segment — `roads[a]` gets the bit, the mirror never lands, and a tile is charged. `placeRoad` then reads "already exists" and does not repair it; `eraseRoad` refunds and leaves the orphan bit forever. And `assertSymmetric` using the same arithmetic is self-blind, because a wrapped pair *is* mirror-symmetric under it.

- [ ] **Step 1: Write the failing tests**

Cover at minimum:

*Geometry and bounds*
- `dirBetween` returns the right index for all eight neighbours of an interior cell, on a **non-square** grid.
- `dirBetween(w - 1, w, w, h) === -1` — the right-edge row seam.
- `dirBetween` rejects negative, `>= w*h`, and non-integer arguments.
- `placeRoad` across the right edge (`x = w-1` to `x = 0` of the next row) fails and changes nothing.
- North from row 0, south from row `h-1`, west from `x = 0`, east from `x = w-1` all fail.
- `dirBetween(c, c, w, h) === -1`.
- `OPPOSITE[OPPOSITE[k]] === k`, `DX[OPPOSITE[k]] === -DX[k]`, `DY[OPPOSITE[k]] === -DY[k]` for all `k`.

*Terrain*
- Both endpoint orderings rejected for `WATER` and for `MOUNTAIN` — land→water, water→land, land→mountain, mountain→land. A single-endpoint check must fail at least one of these.
- Placing onto a `TREE` endpoint succeeds, sets `cleared` for that cell only, and `hasTree` becomes false there.
- Placing between two `LAND` cells leaves `cleared` entirely zero.

*Budget and mutation*
- Place sets both mirrored bits; erase clears both.
- **Erasing one segment leaves that cell's other segments intact.** `eraseRoad` doing `roads[a] = 0; roads[b] = 0` survives every other named test, symmetry included — zeroing both sides is symmetric.
- Budget decrements by 2 on a fresh segment, by 1 when extending a run, by 0 on a duplicate.
- Erase refunds by the same rule.
- **Any call returning `false` leaves `hashState` unchanged.** One assertion over every rejection path, not just the zero-budget one — the natural implementation error is charging before the last validation.
- Zero budget rejects a fresh placement, and rejects a one-cell extension.
- **Zero budget accepts a segment that is already present:** `canPlaceRoad` returns exactly `{ ok: true, cost: 0 }` and `placeRoad` returns `true`, leaving the hash unchanged. Assert the returned object, not just the boolean — `{ ok: true, cost: 1 }` would pass a truthiness check and silently overcharge everywhere else. This is the case a budget-first implementation rejects, and M1c drags across existing road constantly.
- Erasing a segment that does not exist is a no-op that does not refund.
- `placeRoad` returns `true` **iff** `canPlaceRoad` reports `ok`, over the whole randomised sequence below.

*Whole-grid invariants, after a randomised sequence of seeded place/erase operations*
- **A three-point hash assertion, not two.** Hash before, hash after place, hash after erase: assert the middle one **differs** and the last one returns. `placeRoad` returning `true` while writing and charging nothing gives all three equal, and the reviewed draft called the two-point version "the strongest test in the task".
- **Conservation:** `map.startingTiles − tilesLeft(state) === (count of cells whose road mask is non-zero)`. This is the strongest assertion available here: it catches every budget leak, every one-sided write and every stray bit in one line.
- **Erase everything, assert the hash equals the initial hash** — with `cleared` excepted, since tree destruction is deliberately not reversible. State that exception in the test, and assert the `cleared` bytes separately.
- `assertSymmetric` and `assertNoRoadOnImpassable` hold throughout.
- **Vacuity self-check** (`progress.md:5`): assert the sequence produced at least N successful placements *and* at least N successful erasures, and that a placement was attempted against every terrain type. A `placeRoad` that returns `false` when `(a + b) % 7 === 0` makes the whole sequence near-vacuous otherwise.

*Design decision 1*
- **`world.terrain` is byte-identical before and after the entire sequence.** This is the assertion that would have caught the tree-destruction defect, and it is the only thing standing between `WorldData` and cross-instance mutable state.
- Place on a tree, snapshot, place more, restore, and assert the tree is back — the rollback the `cleared` region exists to make possible, and which was architecturally impossible in the reviewed draft.

- [ ] **Step 2: Confirm they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Mutation-test**

Named mutations, each paired with the test that must catch it — the mapping *is* the deliverable, and the reviewed draft's mapping was wrong:

| Mutation | Test that must fail |
|---|---|
| Write only one side of the pair | `assertSymmetric` in the randomised sequence |
| Refund on a no-op erase | the dedicated no-op-erase test — **not** the place/erase round trip, which uses a *real* erase and never reaches the no-op path |
| Allow placement on water | the both-orderings terrain tests |
| Check terrain on one endpoint only | the reversed-ordering terrain test |
| `dirBetween` without the row-seam check | the right-edge wrap test |
| `eraseRoad` zeroing the whole mask | erasing one segment leaves the others intact |
| `placeRoad` writing nothing but returning `true` | the three-point hash assertion |
| Charge 1 tile per segment instead of per cell | the conservation invariant |
| Skip `cleared[cell] = 1` | the tree rollback test and `hasTree` |
| Check the budget before computing the cost (`if (tilesLeft === 0) return budget-failure`) | the zero-budget duplicate test — **and nothing else**, which is why that test is named separately from the general zero-budget one |

Plus the standing per-behaviour obligation.

- [ ] **Step 5: Verify and commit**

`pnpm test`, `pnpm typecheck`, `pnpm lint` clean. Confirm and report that the golden hash is unchanged from Task 2's blessed value.

---

## Task 4: The traversable graph

**Files:**
- Create: `packages/sim/src/graph.ts`, `packages/sim/test/graph.test.ts`
- Modify: `packages/sim/src/index.ts`
- Modify: `packages/sim/test/determinism.test.ts` — adds `sim/src/graph.ts` to the scanned file list

**Interfaces produced:**

```ts
import { ORTHO_COST, DIAG_COST } from '@laneways/shared'

/**
 * Fills `outCell[0..n)` with connected neighbour cell indices and `outDir[0..n)`
 * with the direction index taken to reach each, both in ascending DIRS order.
 * Returns n. Both arrays are caller-provided and sized 8.
 */
export function neighbours(
  state: GameState,
  world: WorldData,
  cell: number,
  outCell: Int32Array,
  outDir: Int8Array,
): number

/** ORTHO_COST for the four orthogonals, DIAG_COST for the four diagonals. */
export function edgeCost(dir: number): number

export function isConnected(state: GameState, world: WorldData, a: number, b: number): boolean
```

**`neighbours` returns the direction, not just the cell.** In the reviewed draft it returned cells only, and `computeFlowField` needs `k` for both `dir[ni] = OPPOSITE[k]` and `edgeCost(k)` — so Task 4 would have shipped a module with no sim call site while the hot loop re-derived the direction per relaxation. The parallel `outDir` array (and the matching `Scratch` fields in Task 5) means there is one traversal implementation, not two that can drift.

**`ORTHO_COST` and `DIAG_COST` are imported, not redeclared.** They already exist in `packages/shared/src/constants.ts:27-28` and are covered by the `ALL` registry test. Two sources of truth for a rule constant means a balance change silently misses the pathfinder.

**A cell's neighbours are exactly those it has a road bit toward and which are in `x` **and** `y` bounds.** Not `0 <= ni < cells` — that admits the row seam, which is the whole of finding 9.

**`neighbours` does not filter impassable terrain, and that is a decision.** Placement already rejects impassable endpoints, and re-filtering here would hide a placement bug behind a second guard rather than surfacing it. The property is asserted directly instead, over a randomised graph: every returned neighbour has `passable === 1`. "Already guaranteed elsewhere" is how invariants rot; a test is the cheap way to keep the guarantee honest without doubling the guard.

**The bounds guard is reachable, and the test reaches it directly.** `placeRoad` can never create an off-grid bit, so a test driving only through `placeRoad` would leave the guard as dead code. `GameState.roads` is a view on the buffer, so the test writes the byte itself — set the N bit on a cell in row 0 and assert `neighbours` returns nothing for it. M1a solved the same problem by exposing `nonZeroSeed`.

- [ ] **Step 1: Write the failing tests**

Cover:

- An isolated cell has `n === 0`.
- A cell with one road has `n === 1`; a fully-connected interior cell has `n === 8`.
- **Assert the *contents* of `outCell[0..n)` and `outDir[0..n)`, not just `n`.** `outCell[n++] = cell + DX[k] + DY[k]` (row stride dropped) leaves every count correct and every index wrong.
- **Assert the contents are in ascending `DIRS` order.** Iterating `k` from 7 down to 0 changes nothing observable in a count-only test — and it flips `dir` tie-breaks throughout the flow field, which Task 6's golden would then bless permanently.
- `outCell` and `outDir` beyond the returned count are untouched.
- Every returned neighbour `outCell[i]` satisfies `dirBetween(cell, outCell[i], w, h) === outDir[i]`.
- Every returned neighbour has `world.passable === 1`, over a randomised graph.
- A road bit pointing off-grid, **written directly into `state.roads`**, yields no neighbour: N from row 0, S from row `h-1`, W from `x = 0`, E from `x = w-1`.
- `edgeCost` returns `ORTHO_COST` for the four orthogonals and `DIAG_COST` for the four diagonals; `edgeCost` over all eight directions yields exactly two distinct values (Task 5 depends on that count).
- `edgeCost` rejects an out-of-range direction index.
- `isConnected` is symmetric for every placed segment.
- **`isConnected` is `false` for two cells that both carry roads but not to each other.** `roadMask(a) !== 0 && roadMask(b) !== 0` is symmetric by construction and passes every other named test.
- `isConnected` is `false` for two non-adjacent cells, and for a cell with itself.
- A diagonal connection is reported for both cells.

- [ ] **Step 2: Confirm they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Mutation-test**

Named mutations: drop the row stride in the neighbour index (the contents assertion must fail); iterate `k` from 7 down to 0 (the DIRS-order assertion must fail); replace the `x`/`y` bounds test with `0 <= ni < cells` (the row-seam tests must fail); implement `isConnected` as `roadMask(a) !== 0 && roadMask(b) !== 0` (the both-have-roads-but-not-to-each-other test must fail); swap `ORTHO_COST` and `DIAG_COST` in `edgeCost` (the exact-value test must fail); re-declare the costs as local literals (nothing fails — record that, and note the `ALL` registry test in `shared` is what covers their values).

Plus the standing per-behaviour obligation.

- [ ] **Step 5: Verify and commit**

---

## Task 5: Flow fields

**Files:**
- Create: `packages/sim/src/scratch.ts`, `packages/sim/src/flowfield.ts`
- Create: `packages/sim/test/scratch.test.ts`, `packages/sim/test/flowfield.test.ts`
- Modify: `packages/sim/src/hash.ts` (adds `hashInt32`), `packages/sim/test/hash.test.ts`, `packages/sim/src/index.ts`
- Modify: `packages/sim/test/determinism.test.ts` — adds `sim/src/scratch.ts` and `sim/src/flowfield.ts` to the scanned file list

**No layout change and no header change.** Design decision 3 derives field staleness from content, so nothing here touches the state buffer at all — this task is the first in the milestone that adds no writer to it. **The golden hash must not change in this task.**

`hashInt32(h, v)` folds a 32-bit value into a running FNV-1a state, four little-endian bytes at a time. It exists so that `hashSources` shares one FNV implementation with `hashBytes` rather than growing a second. **Do not refactor `hashBytes` to call it** — `hashBytes` is under the golden hash and its output must not move. Pin the two against each other instead: `hashInt32` seeded from FNV's offset basis must equal `hashBytes` over that value's four little-endian bytes.

**Interfaces produced:**

```ts
import { ORTHO_COST, DIAG_COST } from '@laneways/shared'

/**
 * Unreachable marker. 0x40000000 rather than the spike's 0x7fffffff so that
 * INF + DIAG_COST stays a positive Int32; the spike's value overflows to
 * negative, which compares as "better" and would silently relax through
 * unreachable cells if a guard were ever dropped. Also >> any real distance:
 * `createScratch` asserts cells * DIAG_COST < INF.
 */
export const INF = 0x40000000

/**
 * Dial's cyclic bucket count. Correct only while NB > every edge cost; §5.4
 * promises intersection and traffic-light penalties "as extra integer edge
 * weight", so 14 will be exceeded in M1c, and an over-large weight lands in a
 * bucket drained at the wrong d and is discarded — wrong answers, no crash.
 * `createScratch` asserts NB > edgeCost(k) for every k.
 */
export const NB = DIAG_COST + 1

/**
 * Distinct values `edgeCost` can return. Sets the entry-pool bound; M1d's
 * motorway tier makes it 3. Task 4 tests that edgeCost yields exactly this many
 * distinct values, so adding a tier without updating this fails a test.
 */
export const DISTINCT_EDGE_COSTS = 2

/**
 * Per-colour, persistent, derived. Fully overwritten on every rebuild.
 *
 * The two stamps are the whole of staleness detection (design decision 3):
 * both are 0 on a fresh field and non-zero once built, and 0 can never be a
 * real stamp, so "never built" is not mistakable for "fresh". That matters
 * because a fresh field's `dir` is all-zero, which reads as "head North".
 */
export interface FlowField {
  readonly dist: Int32Array   // weighted distance to the nearest source, or INF
  readonly dir: Int8Array     // direction index toward a source; -1 at sources and unreachable cells
  builtFromRoads: number      // nonZeroWord(hashBytes(state.roads) | 0), or 0 if never built
  builtFromSources: number    // nonZeroWord(hashSources(sources) | 0), or 0 if never built
}

/** Shared, transient. Fully overwritten at entry; carries nothing between calls. */
export interface Scratch {
  readonly bucketHead: Int32Array   // NB
  readonly entryCell: Int32Array    // entryPoolCapacity(cells)
  readonly entryNext: Int32Array    // entryPoolCapacity(cells)
  readonly nbrCell: Int32Array      // 8
  readonly nbrDir: Int8Array        // 8
  readonly stats: Int32Array        // ST_EXPANSIONS, ST_PUSHES
}

export const ST_EXPANSIONS = 0
export const ST_PUSHES = 1

export function createFlowField(cells: number): FlowField
export function createFlowFields(colours: number, cells: number): FlowField[]
export function createScratch(cells: number): Scratch
export function entryPoolCapacity(cells: number): number

/** `sources` must be strictly ascending cell indices; throws otherwise. */
export function computeFlowField(
  state: GameState,
  world: WorldData,
  sources: readonly number[],
  out: FlowField,
  scratch: Scratch,
): void

/** nonZeroWord(hashBytes(state.roads) | 0). */
export function hashRoadRegion(state: GameState): number
/** nonZeroWord over the length and each element, via hashInt32. Order-sensitive by design. */
export function hashSources(sources: readonly number[]): number

/**
 * The once-per-tick rebuild point, and the only writer of the stamps. Computes
 * the road hash once, rebuilds every colour whose stamps disagree with its
 * current inputs, and leaves the rest untouched — that is §5.4's "coalesce
 * dirty rebuilds to at most one per tick".
 */
export function syncFields(
  state: GameState,
  world: WorldData,
  sourcesByColour: readonly (readonly number[])[],
  fields: readonly FlowField[],
  scratch: Scratch,
): void

/**
 * The read accessor, and the only one. Throws if either stamp disagrees with
 * the inputs as they are now, if the field was never built, or if
 * `dist.length !== world.cells`. Never rebuilds: a throw here means the caller
 * read a field without syncing this tick, which is a bug worth surfacing.
 */
export function fieldFor(
  state: GameState,
  world: WorldData,
  fields: readonly FlowField[],
  colour: number,
  sources: readonly number[],
): FlowField
```

The algorithm is the one the M0 spike measured at 21–32 µs for a full field and verified against hand-computed shortest paths: multi-source Dijkstra, Dial cyclic bucket queue, **entry pool rather than a per-cell next pointer** — adapted to traverse *roads* rather than passable terrain, which is the one substitution most likely to be lost in a literal port.

**Why the entry pool, restated because it will look like needless indirection:** a cell's distance can improve while it is still linked into a higher bucket. A per-cell `next` pointer would be overwritten by the new link, corrupting the old bucket's chain — some other node still points at this cell, and draining that bucket walks into the wrong list. Allocating a fresh entry per insertion and skipping stale entries on drain avoids it.

**The pool bound, corrected.** The reviewed draft said `cells * 9`, "at most 8 relaxations per cell plus one source insertion, which a reviewer previously confirmed is exactly tight". That is false in both directions. Expansions occur in nondecreasing `d`, so a second improvement to a cell requires a strictly smaller edge cost; with two cost values a non-source cell is pushed at most twice, and a source cell exactly once (distance 0 can never improve). Measured over 400 random road graphs: maximum per-cell pushes exactly 2, total peaking at 1.15 × cells. So `cells * 8` cannot overflow on any input, and a mutation shrinking the pool to it is guaranteed to be reported as "no test failed".

```
entryPoolCapacity(cells) = cells * (1 + DISTINCT_EDGE_COSTS)
```

One push per distinct edge-cost value, plus one source insertion. Conservative by construction — a source cell can never also be improvement-pushed — and it is the formulation that survives M1d's motorway ÷3 tier and flags M1c's intersection penalties as requiring a revisit.

**`push` throws on overflow.** An out-of-range pool write throws nothing on its own: it corrupts the bucket chains silently, `entryCell[e]` reads `undefined`, `entryNext[e]` reads 0, and the drain can loop. An explicit `if (top >= cap) throw` converts a silent wrong answer into a stack trace.

**The staleness check is a performance guard, not a correctness one — say so in the comment.** Pushes happen only on strict improvement, so a stale entry always drains after the cell's final `dist` was applied and every relaxation from it fails `nd < dist[ni]`; a reviewer verified bit-identical output across 400/400 graphs with the check removed. Bucket aliasing does not rescue it either — pending entries differ by at most 4, never by `NB`. It stays because it saves work, and because the work-counter assertion below makes its removal visible.

**Source validity, stated once.** A source is accepted iff it is in range **and carries at least one road bit**. A pin on a cell with no road is not a source and gets no field entry — this settles the reviewed draft's collision between "distance 0 at every source" and "a cell with no road has no field entry", which would have contradicted each other depending on the fixture. In M1c, pins sit on destinations, which are exactly the cells that may have no road yet, so the consequence must be stated in the source comment: **M1c seeds from a destination's road-adjacent access cell, not from the building cell.** With all sources rejected, the field is entirely `INF`/`-1`, which is the correct answer.

**The reset contract, stated once, because design decision 3 rests on it.** At entry, `computeFlowField` fully overwrites `out.dist`, `out.dir` and `scratch.bucketHead`, and zeroes `scratch.stats` — **unconditionally, with no early return for an empty source list**. A natural `if (sources.length === 0) return` guard leaves the previous colour's field live for this one, and a reviewer executed the case: the fresh-vs-used test passes with byte-identical `dist` **and** `dir`. The pool cursor is function-local; see design decision 3.

- [ ] **Step 1: Write the failing tests**

*Allocation and constants (`scratch.test.ts`)*
- `createScratch` and `createFlowField(s)` allocate inside the function; array lengths match the declared sizes.
- `entryPoolCapacity(cells) === cells * 3` today, and is derived from `DISTINCT_EDGE_COSTS` rather than a literal.
- `createScratch` throws if `NB <= edgeCost(k)` for any `k`, and if `cells * DIAG_COST >= INF`. Prove both by calling with a doctored input rather than asserting the current values are fine.
- `INF + DIAG_COST` is a positive Int32.

*Correctness (`flowfield.test.ts`)*
- Distance 0 at every **accepted** source; a source on a roadless cell is not accepted and stays `INF`/`-1`.
- A straight line of road: costs accumulate at `ORTHO_COST` per step. A diagonal line: `DIAG_COST` per step.
- Unreachable cells stay at `INF` with `dir === -1`; a cell with no road has no field entry.
- With two sources, every cell takes the minimum.
- **`dir` consistency, for every reachable cell with `dir !== -1`:** the neighbour it names has `dist` exactly `dist[cell] − edgeCost(dir[cell])`. The `dir !== -1` qualifier is not pedantry — sources have `dist = 0` and `dir = -1`, and a literal implementation indexes `DX[-1]`.
- **The complement: `dir === -1` iff the cell is an accepted source or is unreachable.**
- **A road bit exists between the cell and the neighbour `dir` names.** The likeliest implementation error is porting the spike literally, and the spike traverses `passable` terrain, not roads.
- **The consistency test derives `nx = cell % w + DX[k]`, `ny = ((cell / w) | 0) + DY[k]` with its own bounds rejection — not via `neighbours()`.** A shared wrap bug otherwise makes the test self-blind, which is the M1a scan self-test failure exactly.
- Following `dir` from any reachable cell terminates at a source in at most `cells` steps.
- **The differential two-source oracle:** for every cell `c`, `field({A, B})[c] === min(field({A})[c], field({B})[c])`. This is the test that catches the single most likely real bug in this task — `if (nd < dist[ni])` written as `if (dist[ni] === INF)`, the classic already-visited error, which survives *every other* named test here including the consistency assertion (a cell reached diagonally has `dist = 14`, `dir` → source, and `0 === 14 − 14`). Single-source fields are provably immune to that bug: an improvement would need a later expansion at distance ≤ 3, and the minimum non-zero distance is 10. So they are a valid oracle and the mismatch is exact. **The fixture must place a cell diagonally adjacent to A and orthogonally adjacent to B, with A the lower cell index** (sources are ascending, so that is what "A inserted first" means).
- **Work counter:** `scratch.stats[ST_EXPANSIONS]` equals the number of reachable cells. Removing the staleness check breaks this and nothing else.
- Rebuilding over the same scratch and the same `FlowField` produces identical results.

*Canonical source order*
- **Two permutations of the same source set yield byte-identical `dir`.** Since `computeFlowField` throws on an unsorted list, this is expressed as: sorting a shuffled list and computing gives the same `dir` as the already-sorted list; and passing the shuffled list throws. Verified on a five-cell corridor with sources at both ends: `[0, 4]` gives `dir [-1, 6, 6, 2, -1]` and `[4, 0]` gives `dir [-1, 6, 2, 2, -1]`, with `dist` identical.
- A duplicated source throws.
- An out-of-range source throws — do not rely on the staleness check absorbing it, which it currently does by reading `dist[s]` as `undefined`.

*Staleness*
- `fieldFor` throws on a never-built field. Assert this **before** anything else in the group: it is the case a fresh `FlowField` presents, and its `dir` is all-zero, so passing it through would send every car North.
- `hashRoadRegion` and `hashSources` are never 0. Prove the guard the way M1a proved the seed guard — call `nonZeroWord(0)` directly and assert 1 — because searching for an input that hashes to 0 is an unbounded search.
- `hashSources` differs for two source lists of the same length, and for the same list with one element changed. It need not be order-sensitive in practice, since design decision 6 makes every list ascending, but assert that it *is* — an order-insensitive fold (a sum, an XOR) is the tempting implementation and it collides on permutations.
- `syncFields` then `fieldFor` returns the field.
- **`syncFields` rebuilds every colour, not just the first.** Give the colours different source sets and assert each field independently.
- **`syncFields` does not rebuild a colour whose inputs are unchanged.** Assert via `scratch.stats[ST_EXPANSIONS]` being 0 after a second immediate call — an implementation that rebuilds unconditionally is correct but silently discards §5.4's coalescing, and no output assertion can see the difference.
- **After a road mutation, `fieldFor` throws with no explicit invalidation call anywhere in the test.** This is the assertion the flag design could not make, because it would have been testing that somebody remembered to call something.
- **After a source-list change with the roads untouched, `fieldFor` throws.** The road hash matches here, so this is the case a roads-only stamp would let through — and in M1c, pins change far more often than roads do.
- `fieldFor` throws when handed a `fields` array sized for a different cell count.
- `restore` writes nothing: `hashState(restore(snapshot(s), world)) === hashState(s)`, unchanged from M1a. Keep the existing test and add a comment naming what it now also protects.

- [ ] **Step 2: Confirm they fail**

- [ ] **Step 3: Implement `scratch.ts` then `flowfield.ts`**

`createScratch` and `createFlowField` allocate inside the function. `computeFlowField` allocates nothing.

- [ ] **Step 4: Mutation-test**

| Mutation | Test that must fail |
|---|---|
| `nd < dist[ni]` → `dist[ni] === INF` | the differential two-source oracle (and only it) |
| Delete `bucketHead.fill(-1)` | see the note below |
| Delete `dist.fill(INF)` / `dir.fill(-1)` | the fresh-vs-used poison-fill test in Task 6 |
| Add `if (sources.length === 0) return` | the differing-inputs arm in Task 6 |
| Drop the `nx < 0 \|\| nx >= w` rejection | the row-seam field tests |
| Remove the staleness check | the work-counter assertion |
| Shrink the pool to `cells * 1` | needs the `unequalArms` fixture — see below |
| Use a per-cell `next` pointer instead of the pool | needs the same fixture |
| `NB = DIAG_COST` | the `createScratch` assertion test |
| Sort `sources` internally instead of throwing | the shuffled-list-throws test |
| Skip the source road-bit check | the roadless-source test |
| Stamp only `builtFromRoads`, dropping the source stamp | the source-changed-roads-unchanged test |
| Initialise the stamps to something other than 0, or drop `nonZeroWord` | the never-built test |
| Implement `hashSources` as a sum or XOR of the elements | the permutation test |
| Make `syncFields` rebuild unconditionally | the `ST_EXPANSIONS === 0` coalescing test |
| Make `fieldFor` rebuild instead of throwing | the after-a-road-mutation test |

**The `bucketHead.fill(-1)` asymmetry is worth naming.** Deleting it is invisible on a *used* scratch, whose buckets already drained to −1, and fails only on a *freshly allocated* one, whose buckets are 0. That is the exact inverse of the fresh-vs-used test's intent, so **both directions must be asserted**: fresh-then-used and used-then-fresh.

**The `unequalArms` fixture, and why two mutations need it.** Both the pool-shrink and the per-cell-next-pointer mutations only bite on a graph where some cell is genuinely relaxed twice — reached first by a diagonal edge from a cell at distance *d*, then improved by an orthogonal edge from a different cell at the same *d* expanded later in the same bucket. (The distances must be equal: with costs 10 and 14, an improvement needs `dB + 10 < dA + 14` with `dB >= dA`, and no reachable pair of sums differs by 2.) A straight line or a plain diagonal can never produce it — the next-pointer mutation bit in only 60 of 400 random graphs.

The shape is two equal-length arms from one source meeting at a common cell, one arriving diagonally and one orthogonally. Which arm expands first depends on `DIRS` order and on LIFO order within a bucket, so **do not hand-derive the cells: instrument `push` with a temporary per-cell counter, search a small seeded family of road graphs until one shows a per-cell count of 2, then pin that graph as a literal fixture** with a comment recording the improving cell and both distances, and remove the temporary instrument. A fixture that does not demonstrate a count of 2 is vacuous, and the search is the self-check that it is not.

Plus the standing per-behaviour obligation.

- [ ] **Step 5: Verify and commit**

`pnpm test`, `pnpm typecheck`, `pnpm lint` clean. Confirm and report that the golden hash is unchanged.

---

## Task 6: Prove the derived-state design, and bless the goldens

Everything in this task exists to test the one thing M1b cannot demonstrate by construction: that state living outside the snapshot — the per-colour fields and the transient scratch — cannot make a restored run diverge from a fresh one. It is separated from Task 5 because it needs every other piece to exist, and because "make Dijkstra correct" and "prove rollback is safe" are different work with different failure modes.

**Files:**
- Create: `packages/sim/test/rollback.test.ts`
- Modify: `packages/sim/test/determinism.test.ts`

**No new source files.** If this task needs one, that is a finding: it means a behaviour it is meant to test has no reachable call site.

### Why the reviewed draft's version of this could not fail

Both of its flagship tests asserted on `hashState`. `computeFlowField` returns `void` and writes only outside the buffer, `hashState` hashes only `s.buffer`, and no M1b code path copies a field value into it. So the fresh-vs-used test's two hashes were equal **by construction** — green with `dist.fill(INF)` and `dir.fill(-1)` deleted, and green with the entire body of `computeFlowField` deleted. The "compute all fields, pin the state hash" golden pinned the road placements and nothing else. Those were the plan's stated justification for its scratch design.

Two consequences, both applied below: the field golden hashes the **field's own bytes**, and the fresh-vs-used test compares `dist`/`dir` directly rather than through the state hash.

- [ ] **Step 1: The fresh-vs-used invariant, in three arms**

All three, because a reviewer demonstrated a survivor of each pair.

**(a) Poison fill.** Before the measured call, fill every array of a used `Scratch` with each of: all `0x7f` bytes, all `-1`, all `0`, and a seeded garbage pattern. Require byte-identical `dist` and `dir` against a freshly allocated `Scratch`, for the same inputs, for every fill. This tests read-before-write *structurally*, independent of graph topology, and it is the only arm that catches a reset the algorithm quietly depends on.

**(b) Differing inputs.** Same-input reruns are idempotent, so residue created *inside* the measured sequence is identical in both arms and invisible. So: on the used scratch, run computation A and then computation B; on the fresh scratch, run B alone; compare B's field. A reviewer executed the surviving case — an `if (sources.length === 0) return` guard leaves colour A's field live for colour B and the poison-fill arm alone does not see it.

**(c) Both directions.** Fresh-then-used *and* used-then-fresh, per the `bucketHead.fill(-1)` asymmetry named in Task 5.

- [ ] **Step 2: The snapshot-and-replay arm**

This is the rollback the whole design exists to serve, and nothing in the reviewed draft tested it.

Run a scripted sequence of road edits and `syncFields` calls to tick T, recording a trace of `(stateHash, fieldHash per colour)` at the end of every tick. Snapshot at T. Continue to T+N, extending the trace. Then `restore(buffer, world)`, **reuse the same `Scratch` and the same `FlowField` objects**, replay the identical edits from T, and assert the trace matches entry for entry.

Reusing the same `FlowField` objects is the point of the arm, not an optimisation: at the moment of the restore they hold the abandoned timeline's field over the restored timeline's roads, with a road stamp that does not match. Nothing in the test tells them so.

Record the trace at end-of-tick, after `syncFields`, so every trace point is taken from a synced state in both arms.

Assert the trace has the length you expect before comparing it — an empty trace compares equal to an empty trace.

- [ ] **Step 2b: The invalidation nobody triggered**

Build a field, snapshot, mutate the roads, restore, and assert `fieldFor` **throws** — with no explicit invalidation call anywhere in the test, and no `syncFields` between the restore and the read.

This is the assertion the header-flag design could not make. Under a flag, the equivalent test asserts that `restore` remembered to set a bit, which tests the test author's memory rather than the design. Here there is nothing to remember: the road region's content moved, so the stamp cannot match. Then call `syncFields` and assert the read succeeds and the field matches a from-scratch rebuild over a separate `FlowField`.

- [ ] **Step 3: Bless two goldens, labelled for what each actually pins**

**The road-network golden.** Build a fixed road network from a seeded placement sequence over the test's own fixture map, and pin `hashState`. Its comment must say what it covers — the buffer layout and byte order, the road and cleared regions, the tile budget, the map identity slots — and what it does not: it contains no field data of any kind.

**The field golden.** Pin `hashBytes` over each colour's `dist` and `dir` bytes, folded together. Take the byte views as `new Uint8Array(f.dist.buffer, f.dist.byteOffset, f.dist.byteLength)` — `f.dist.buffer` alone is correct only while the field owns its buffer, and that is not a property worth depending on silently.

Bless the two separately and report both values. When a rule change makes either fail intentionally, re-bless in the same commit as the change, never separately.

- [ ] **Step 4: Finish the determinism scan's file list**

Confirm the exact `toEqual` list in `determinism.test.ts` names every source file M1b added, in sorted label order, and that the test fails when one is removed. Report the final list.

- [ ] **Step 5: Mutation-test**

Named mutations: delete `dist.fill(INF)` (arm (a) must fail); add `if (sources.length === 0) return` (arm (b) must fail); delete `bucketHead.fill(-1)` (one direction of arm (c) must fail — report which); make `syncFields` compare only `builtFromSources` (Step 2b must fail); make `syncFields` rebuild only colour 0 (the snapshot-replay arm and the field golden must both fail); make `fieldFor` skip the stamp comparison entirely (Step 2b must fail, and if the snapshot-replay arm stays green, say so — it means the replay never reads a stale field, which is worth knowing about the fixture).

Plus the standing per-behaviour obligation.

- [ ] **Step 6: Verify and commit**

`pnpm test`, `pnpm typecheck`, `pnpm lint` clean. Report the real test count.

---

## Self-Review

**Spec coverage.** §5.1 terrain types, their blocking rules, and tree destruction as a *state* change (Tasks 2–3); §5.11 road placement, per-cell cost, terrain restrictions and refund (Task 3); §5.4 edge weights, multi-source fields, one field per colour, Dial's queue, full rebuild on dirty, preallocation, no allocation per tick (Tasks 4–5); §4.1 determinism, strengthened, including the Map/Set/object-key iteration ban that M1a's ledger carried forward (Task 1); §9.3's snapshot-size budget, respected by keeping fields out of the buffer (design decision 3).

Deliberately **not** covered, belonging to M1c and M1d: bridges, tunnels, roundabouts, motorways, traffic lights, houses, destinations, pins, dispatch, cars, movement, blocking, the week cycle, upgrades, spawning, failure and scoring. Two things are deferred with a named consequence rather than silently: ghost roads (§5.11's delayed refund) need cars, and grid expansion (§5.1) needs no layout change because design decision 5 sizes every region for the map's final extent from tick 0.

**Placeholder scan.** Tasks 2–6 specify test *coverage* rather than verbatim test code, unlike M1a. That is deliberate: M1a's fully-written tests produced five plan-mandated defects, because a test written blind was accepted verbatim by an implementer who could see the code. Naming what must be proven, and leaving the implementer to write it against the real implementation, puts the person with the most information in charge of the assertion. Task 1's layout test is the exception — it is a pure function with no context to discover.

Where the review derived a specific assertion from an executed experiment, that assertion is written out rather than described: the corridor `dir` values, the `dirBetween` row-seam cases, the differential oracle's fixture shape, the poison-fill patterns, the `bucketHead` asymmetry. Those were measured, not reasoned, and paraphrasing them would lose the part that bites.

**Type consistency.** `Region`/`LayoutEntry`/`RegionCtor`/`computeLayout` (Task 1) are consumed by `state.ts` in Tasks 1 and 2 — one six-member `RegionCtor` union, declared once. `MapData` and `TERRAIN` (Task 2, `shared`) are consumed by `createWorld`, `createState` and `stateBytesFor`. `WorldData` is consumed by Tasks 3, 4, 5 and 6, and appears in `restore`'s signature. `DX`/`DY`/`OPPOSITE`/`dirBetween` are defined in `roads.ts` (Task 3) and imported by `graph.ts` and the flow-field tests — defined once, not redeclared. `ORTHO_COST`/`DIAG_COST` are imported from `shared`, not restated. `FlowField` and `Scratch` (Task 5) are consumed by Task 6. `edgeCost`'s distinct-value count (Task 4) is what `DISTINCT_EDGE_COSTS` (Task 5) claims, and a Task 4 test pins the number. `nonZeroWord` ends the milestone with three callers — the rng seed (M1a), `mapIdHash` (Task 2) and both `FlowField` stamps (Task 5) — all guarding the same hazard, that 0 is what an uninitialised slot holds; one function, three tests, no copies. `hashBytes` stays the single FNV implementation, with `hashInt32` (Task 5) pinned against it rather than reimplementing it.

**Where this plan is most likely to be wrong.** Three places, named so a reviewer knows where to push.

1. *Staleness rests on a 32-bit hash.* Design decision 3 argues a collision cannot cause a replay divergence, because both hosts collide identically and therefore use the same stale field. That argument holds only while the stamped inputs are the *complete* input set. Today a field is `f(roads, sources, w, h)` and all four are covered. **The moment anything else enters `computeFlowField` — M1c's intersection penalties are the obvious candidate, since §5.4 models them as extra edge weight derived from something that is not the road bitmask — the stamp set must grow with it, or the scheme silently reverts to the under-conservative failure it was chosen to prevent.** Put that sentence in `flowfield.ts`, next to the stamps, not only here.
2. *Freezing the layout in Task 2* means Task 2 declares two regions and two header slots that nothing writes until Tasks 3 and 5. That is speculative-looking, and the ledger's `H_RNG_DRAWS` ruling is against speculative slots. The distinction is that every slot here is written by a named task in this same plan, and the alternative is three golden re-blessings and three revisions of `restore`'s size check.
3. *`neighbours` not filtering impassable terrain* trades defence in depth for a bug that surfaces at its source. If a placement bug ever does ship, the failure will be a car on water rather than a car quietly routed around it — which is the right way round, but it is a choice and not an obvious one.
