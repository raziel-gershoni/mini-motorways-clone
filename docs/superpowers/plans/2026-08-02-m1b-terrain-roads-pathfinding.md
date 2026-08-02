# M1b — Terrain, Roads and Flow-Field Pathfinding

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the deterministic core a board. Terrain, a road graph the player mutates, and per-colour flow fields that answer "which way from here" in one array read — with the whole thing still replaying byte-identically.

**Architecture:** Terrain is immutable per map and lives outside the snapshot, identified by a `mapId` stored in the header. Roads are an 8-direction bitmask per cell inside the state buffer. Pathfinding is multi-source Dijkstra with a Dial bucket queue, rebuilt in full when the road graph changes, writing into preallocated scratch that is never snapshotted and never read before it is written.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces. Zero runtime dependencies.

## Prerequisite

M1a is complete: `@laneways/shared` (integer rule constants), `@laneways/sim` (seeded RNG, single-`ArrayBuffer` state with snapshot/restore/hash, exact week/day clock, pure `step()`), 109 tests, and a two-mechanism determinism enforcement layer. Golden hash `917870623`.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md`. Read §4.1 (determinism), §5.1 (board and terrain), §5.4 (pathfinding), §5.11 (roads).
- **Zero runtime dependencies** in `packages/sim` and `packages/shared`.
- **Integer-only in `sim`.** The determinism scan and ESLint both enforce this and both are extended in Task 1. Rule constants are integers over a denominator of 1000, converted only in the constants file.
- **No module-level mutable state anywhere in `sim`.** This is the invariant Task 1 hardens, and it is the one this milestone is most likely to violate — flow-field pathfinding wants a reusable scratch buffer, and the tempting place to put it is module scope. It goes in an explicitly-passed `Scratch` object instead.
- Do not modify `spike/` — separate throwaway project.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```
- **Do not state expected test counts in your reports unless you ran them.** The plan deliberately does not assert counts; report the real number.

---

## Three design decisions this plan makes, and why

### 1. Terrain lives outside the snapshot

`createState` currently takes only a seed. Terrain is static for a whole run, so it has two possible homes.

**Chosen: outside the buffer, in an immutable `WorldData`, with `mapId` in the header.** The invariant that actually matters for rollback is *"everything the simulation can **change** lives in the buffer"* — static data cannot change, so excluding it costs nothing in correctness and keeps snapshots small. Replay verification compares the `mapId` in the submitted header against the map the Worker loaded; a mismatch is a rejected submission, not a silent divergence.

The alternative — terrain in the buffer — would make the invariant "everything the sim *reads*" and remove the need for that identity check, at the cost of ~960 immutable bytes in every snapshot. Affordable (spec §9.3 has ~6× headroom), but it pays forever for a check that costs one integer comparison once.

**Consequence to hold onto:** the world is a *parameter*, so nothing may cache a derived view of it at module scope. Task 1's AST check enforces that.

### 2. Roads are stored symmetrically

A road segment joins two cells. The bitmask could store it once (on the lower-indexed cell) or twice (both cells record the direction toward the other).

**Chosen: symmetric — both cells record it.** Traversal and rendering both ask "what leaves this cell", which a one-sided store answers only by also inspecting all eight neighbours. Symmetry costs one extra byte-write per placement and makes every read local. The cost is that the two halves can disagree if a bug writes one side only, so **symmetry is a tested invariant**, not an assumption: a helper walks the whole grid and asserts every set bit has its mirror.

### 3. Scratch is passed, not owned, and is never read before written

Flow fields need `dist`, `dir`, and the bucket-queue working arrays. These are *derived* — recomputable from roads plus sources — so they are not state and must not be snapshotted. But they are also large and reallocating them per tick would violate the zero-allocation rule.

**Chosen: a `Scratch` object created once at boot and passed into every call that needs it.** Not module scope (that is shared across state instances and survives a rollback — the exact bug Task 1's AST check exists to prevent).

**The danger this creates, and the test that catches it:** if any code path *reads* scratch before writing it in the same tick, scratch becomes hidden state and a restored snapshot will diverge from a fresh one. Task 5 includes a test that runs identical input through a fresh `Scratch` and a heavily-used one and asserts identical state hashes. That test is the reason this design is safe rather than merely tidy.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/sim/src/layout.ts` | Declarative buffer layout: region table → offsets, with alignment checked |
| `packages/sim/src/state.ts` | *Modified* — built from the layout table, gains road and header regions |
| `packages/shared/src/mapFormat.ts` | `MapData` type, terrain codes, `parseMap` from a string encoding |
| `packages/shared/src/maps/firstCity.ts` | The one launch map, as string data |
| `packages/sim/src/world.ts` | `WorldData` — immutable per-run context built from a `MapData` |
| `packages/sim/src/roads.ts` | 8-direction bitmask: place, erase, budget, symmetry invariant |
| `packages/sim/src/graph.ts` | Traversable-edge queries over roads + terrain |
| `packages/sim/src/flowfield.ts` | Multi-source Dijkstra, Dial buckets, into `Scratch` |
| `packages/sim/src/scratch.ts` | `Scratch` allocation, sized from the map |
| `packages/sim/test/*.test.ts` | One per module, plus `determinism.test.ts` extended |
| `tools/eslint-rules/no-module-state.js` | AST rule: module-scope mutable state, and aliasing of banned globals |

---

## Task 1: Harden enforcement, and make the buffer layout declarative

This is the carry-forward from M1a's final review. It ships no game logic and is the prerequisite for everything after it.

**Files:**
- Create: `tools/eslint-rules/no-module-state.js`, `packages/sim/src/layout.ts`, `packages/sim/test/layout.test.ts`
- Modify: `eslint.config.js`, `packages/sim/src/state.ts`, `packages/sim/test/determinism.test.ts`

**Interfaces produced:**
- `interface Region { readonly name: string; readonly ctor: Uint8ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor; readonly len: number }`
- `interface LayoutEntry extends Region { readonly offset: number }`
- `computeLayout(regions: readonly Region[]): { entries: readonly LayoutEntry[]; totalBytes: number }`

### Why an AST rule, when two mechanisms already exist

M1a's final review found a violation form that walks through both:

```ts
const m = Math
const x = m.random()
```

Verified against a real ESLint run: bracket access (`Math['random']()`) and destructuring (`const { random } = Math`) *are* caught; **variable aliasing is not**, in either mechanism. And it cannot be fixed by name-banning, because `Math.imul` and `Math.min` are load-bearing in `rng.ts`. The same trick defeats `Date.now`, `performance.now` and the transcendental bans.

The same review also confirmed the module-scope rules are evadable by indentation (indentation has no scoping effect in JS) and by a line-wrapped declaration. Both are line-regex limitations, and both dissolve under an AST check.

The regex scan stays. It catches things the AST rule will not bother with, it runs in CI with the suite, and it cannot be silenced by an inline disable. The three mechanisms cover each other's blind spots — that is the argument, and it should be stated in the config rather than assumed.

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

  it('rounds the total up so the buffer itself is 4-aligned', () => {
    const { totalBytes } = computeLayout([{ name: 'bytes', ctor: Uint8Array, len: 5 }])
    expect(totalBytes % 4).toBe(0)
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

  it('handles the 1505-cell grid the naive layout would break on', () => {
    // 24x40 = 960 is divisible by 4 by luck; the spec's own 43x35 = 1505 is
    // not, and hand-computed offsets would put the next Int32 region at 1505.
    const { entries } = computeLayout([
      { name: 'terrain', ctor: Uint8Array, len: 1505 },
      { name: 'header', ctor: Int32Array, len: 4 },
    ])
    expect(entries[1]!.offset).toBe(1508)
    expect(entries[1]!.offset % 4).toBe(0)
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
 * survive four regions. Worse, alignment worked by luck: a Uint8Array of 960
 * happens to be divisible by 4, so the Int32 region after it landed legally.
 * The spec's own 43x35 = 1505 grid would not, and the failure is a
 * `RangeError: start offset of Int32Array should be a multiple of 4` that names
 * neither the region nor the cause.
 *
 * Regions are declared; offsets are derived, padded to each region's own
 * alignment, and asserted.
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
  const seen = new Set<string>()
  const entries: LayoutEntry[] = []
  let offset = 0
  let maxAlign = 1

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

  // Round the whole buffer up to the widest alignment used, so appending a
  // region later cannot land misaligned because of the previous total.
  const tail = (maxAlign - (offset % maxAlign)) % maxAlign
  return { entries, totalBytes: offset + tail }
}
```

- [ ] **Step 4: Confirm the layout tests pass**

- [ ] **Step 5: Rebuild `state.ts` on the layout table**

Replace the hand-computed offsets in `packages/sim/src/state.ts` with a declared region list and views built by iterating it. Keep every existing export and every existing behaviour — `createState`, `snapshot`, `restore`, `hashState`, the header index constants, the non-zero seed forcing, and the length guard with its message. The M1a test suite must pass unchanged apart from the golden hash, which you will re-bless in Step 9 if and only if the layout genuinely changes.

Add one test asserting the whole layout is internally consistent — every region's offset is a multiple of its element size, and no two regions overlap.

- [ ] **Step 6: Write the AST rule**

`tools/eslint-rules/no-module-state.js`, a flat-config-compatible rule module exporting two rules:

**`no-module-mutable-state`** — reports:
- a module-scope `let` or `var` declaration
- a module-scope `const` whose initialiser is `new <TypedArray|ArrayBuffer|Map|Set|WeakMap|WeakSet>(...)` or an array/object literal that is not frozen

Indentation is irrelevant to an AST rule, and a line-wrapped declaration is one node, so both regex evasions dissolve.

**`no-aliased-globals`** — reports assigning a banned global to a variable: `const m = Math`, `const d = Date`, `const p = performance`, `let g = globalThis`, and the same via destructuring of the object itself. This closes the `const m = Math; m.random()` hole the M1a review found.

Write unit tests for both rules using ESLint's `RuleTester`, covering the valid cases too — `const x = Math.imul(a, b)` and `const TICKS = 30` must not be reported, or the rule is unusable.

- [ ] **Step 7: Wire the rule into `eslint.config.js`**

Register the local rules plugin and enable both rules for `packages/sim/src/**` and `packages/shared/src/**`. Add a comment recording *why there are now three mechanisms*: ESLint's name-based rules catch bracket access and destructuring; the AST rules catch aliasing and module-scope state; the regex scan catches float literals, `new Date`, `.sort()` and `globalThis`, runs in CI, and cannot be silenced by an inline disable. Each covers a blind spot of the others.

- [ ] **Step 8: Prove all three fire**

Plant each of these in real sim source, one at a time, confirm the expected mechanism objects, then remove:

| Violation | Expected to be caught by |
|---|---|
| `const m = Math` then `m.random()` | AST `no-aliased-globals` |
| `  let scratch = 0` at module scope, indented | AST `no-module-mutable-state` |
| `export const buf =\n  new Uint8Array(4)` line-wrapped | AST `no-module-mutable-state` |
| `Math['random']()` | ESLint `no-restricted-properties` |
| `const x = .5` | regex scan |
| `Math.random()` in `packages/shared/src` | scan and ESLint |

Record each result. **If any is not caught, say so plainly** — a mechanism that does not fire is worse than none, because it reads as coverage.

- [ ] **Step 9: Verify and commit**

`pnpm test`, `pnpm typecheck`, `pnpm lint` clean. If the layout rebuild changed `STATE_BYTES` or any offset, the golden hash changes: re-bless it in the same commit and report the old and new values.

---

## Task 2: Map format and terrain

**Files:**
- Create: `packages/shared/src/mapFormat.ts`, `packages/shared/src/maps/firstCity.ts`, `packages/shared/test/mapFormat.test.ts`
- Create: `packages/sim/src/world.ts`, `packages/sim/test/world.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces produced:**
- `enum`-like const object `TERRAIN = { LAND: 0, WATER: 1, MOUNTAIN: 2, TREE: 3 }` and `type TerrainCode = 0 | 1 | 2 | 3`
- `interface MapData { readonly id: string; readonly w: number; readonly h: number; readonly terrain: readonly TerrainCode[]; readonly startingTiles: number }`
- `parseMap(id: string, rows: readonly string[], startingTiles: number): MapData`
- `interface WorldData { readonly map: MapData; readonly terrain: Uint8Array; readonly passable: Uint8Array }`
- `createWorld(map: MapData): WorldData`
- `mapIdHash(id: string): number`

Terrain is authored as an array of strings, one per row, one character per cell — `.` land, `~` water, `^` mountain, `T` tree. It is human-readable in source, diffs legibly, and cannot drift out of shape without `parseMap` noticing.

**No module-scope typed arrays.** The map module exports string data only; `createWorld` builds the typed arrays at call time. That is what keeps Task 1's AST rule satisfiable in `shared`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/mapFormat.test.ts` must cover: a valid map parses to the right dimensions and codes; a ragged map (rows of differing length) throws naming the offending row; an unknown character throws naming the character and position; an empty map throws; `w`/`h` match the row data; every terrain code round-trips.

`packages/sim/test/world.test.ts` must cover: `createWorld` produces a `terrain` array of `w*h`; `passable` is true exactly for `LAND` and `TREE` and false for `WATER` and `MOUNTAIN` (trees are destroyed by placement, so they do not block — spec §5.1); `mapIdHash` is deterministic and differs across ids; the returned arrays are the declared length.

Write the tests first, in full, before implementing.

- [ ] **Step 2: Confirm they fail**

- [ ] **Step 3: Implement `mapFormat.ts` and the first map**

`firstCity` is a 24×40 map: mostly land, a river of `~` running roughly north-south with a two-cell gap, a small `^` mountain cluster, and scattered `T`. Keep it simple — its job is to exercise every terrain code and every placement rule, not to be good level design. Note in a comment that it is a test fixture, not the shipping map.

- [ ] **Step 4: Implement `world.ts`**

`createWorld` allocates the typed arrays *inside the function*, never at module scope. `passable` is precomputed once because it is read on every pathfinding relaxation and recomputing it per query would be the dominant cost.

- [ ] **Step 5: Store `mapId` in the state header**

Add an `H_MAP` header slot holding `mapIdHash(map.id)`, set by `createState`. `createState` therefore now takes the map. Add a check in `restore` — or a separate `assertWorldMatches(state, world)` — that throws if the header's map hash disagrees with the world being used. This is the identity check that makes terrain-outside-the-snapshot safe, and it is the whole justification for design decision 1. Test that a mismatch throws.

- [ ] **Step 6: Verify and commit**

Re-bless the golden hash (the header grew) and report both values.

---

## Task 3: Road placement, erasure and the tile budget

**Files:**
- Create: `packages/sim/src/roads.ts`, `packages/sim/test/roads.test.ts`
- Modify: `packages/sim/src/state.ts` (road region, budget header slot)

**Interfaces produced:**
- `DIRS`, `DX`, `DY`, `OPPOSITE` — 8 directions, index 0 = N, clockwise
- `dirBetween(from: number, to: number, w: number): number` — direction index, or −1 if not adjacent
- `canPlaceRoad(state, world, a: number, b: number): PlaceResult` where `PlaceResult` is a discriminated result carrying a reason on failure
- `placeRoad(state, world, a: number, b: number): boolean`
- `eraseRoad(state, a: number, b: number): boolean`
- `roadMask(state, cell: number): number`
- `assertSymmetric(state, w: number, h: number): void` — test helper, throws on any unmirrored bit

Rules, from spec §5.11:
- One segment per cell pair, adjacent orthogonally or diagonally
- Costs **1 tile** either way; diagonals are not more expensive
- Land only — `WATER` and `MOUNTAIN` reject; `TREE` is permitted and the tree is destroyed
- Erase refunds 1 tile, immediately. *Delayed refund while a car is committed is M1c's problem — there are no cars yet. Say so in a comment so nobody assumes it was forgotten.*
- Placement fails, changing nothing, when the budget is 0

- [ ] **Step 1: Write the failing tests**

Cover at minimum: place sets both mirrored bits; erase clears both; budget decrements on place and increments on erase; placing with zero budget fails and mutates nothing (assert the state hash is unchanged); placing onto water fails; onto mountain fails; onto a tree succeeds and clears the tree; placing between non-adjacent cells fails; placing the same segment twice is a no-op that does *not* charge a second tile; erasing a segment that does not exist is a no-op that does *not* refund; the symmetry invariant holds after a randomised sequence of 500 seeded place/erase operations; a place-then-erase round trip restores the exact state hash.

That last one is the strongest test in the task — it catches any asymmetric write, any budget leak, and any stray bit in one assertion.

- [ ] **Step 2: Confirm they fail**

- [ ] **Step 3: Implement**

Add a `roads` region of `w*h` bytes to the layout, and an `H_TILES` header slot. Note the road region is the first variable-size region, so its length comes from the map — `createState(seed, map)` sizes the buffer accordingly, and `restore` must therefore validate against the *expected* size for that map rather than a module constant.

- [ ] **Step 4: Verify, mutation-test, commit**

Mutations to attempt: write only one side of the pair (symmetry test must fail); refund on a no-op erase (round-trip hash test must fail); allow placement on water (terrain test must fail). Report each.

---

## Task 4: The traversable graph

**Files:**
- Create: `packages/sim/src/graph.ts`, `packages/sim/test/graph.test.ts`

**Interfaces produced:**
- `neighbours(state, world, cell, out: Int32Array): number` — fills `out` with connected neighbour cell indices, returns the count
- `edgeCost(dir: number): number` — `ORTHO_COST` (10) or `DIAG_COST` (14)
- `isConnected(state, a: number, b: number, w: number): boolean`

A cell's neighbours are exactly those it has a road bit toward *and* which are in bounds. Terrain does not need re-checking here — placement already rejected impassable cells — but assert it in a test anyway, because "already guaranteed elsewhere" is how invariants rot.

`out` is caller-provided to avoid allocating per query. It is sized 8 by every caller.

- [ ] **Step 1: Write the failing tests**

Cover: an isolated cell has no neighbours; a cell with one road has exactly one; a fully-connected cell has eight; `out` beyond the returned count is untouched; `edgeCost` returns 10 for the four orthogonals and 14 for the four diagonals; `isConnected` is symmetric for every placed segment; a diagonal connection is reported for both cells.

- [ ] **Step 2–4: Confirm failing, implement, verify and commit**

---

## Task 5: Flow-field pathfinding

**Files:**
- Create: `packages/sim/src/scratch.ts`, `packages/sim/src/flowfield.ts`
- Create: `packages/sim/test/scratch.test.ts`, `packages/sim/test/flowfield.test.ts`
- Modify: `packages/sim/test/determinism.test.ts`

**Interfaces produced:**
- `interface Scratch { readonly dist: Int32Array; readonly dir: Int8Array; readonly bucketHead: Int32Array; readonly entryCell: Int32Array; readonly entryNext: Int32Array; readonly nbr: Int32Array }`
- `createScratch(cells: number): Scratch`
- `INF`, `NB`
- `computeFlowField(state, world, sources: readonly number[], scratch: Scratch): void`

The algorithm is the one the M0 spike measured at 21–32 µs for a full field and verified against hand-computed shortest paths: multi-source Dijkstra, Dial cyclic bucket queue, **entry pool rather than a per-cell next pointer**.

**Why the entry pool, restated because it will look like needless indirection:** a cell's distance can improve while it is still linked into a higher bucket. A per-cell `next` pointer would be overwritten by the new link, corrupting the old bucket's chain — some other node still points at this cell, and draining that bucket walks into the wrong list. Allocating a fresh entry per insertion and skipping stale entries on drain (`dist[cur] !== d`) avoids it. Pool capacity is `cells * 9`: at most 8 relaxations per cell plus one source insertion, which a reviewer previously confirmed is exactly tight.

- [ ] **Step 1: Write the failing tests**

Port the spike's verified cases, adapted to run over a road graph rather than an open grid — that difference matters, because a road graph is sparse and the spike's tests assumed full connectivity:

- distance 0 at every source
- a straight line of road: costs accumulate at 10 per step
- a diagonal line: 14 per step
- unreachable cells stay at `INF` and `dir` stays −1
- with two sources, every cell takes the minimum
- `dir` at each cell points to a neighbour whose `dist` is exactly `dist[cell] − edgeCost`, for every reachable cell — this is the strongest correctness assertion available and it validates the whole field at once
- following `dir` from any reachable cell terminates at a source in at most `cells` steps
- a cell with no road has no field entry
- rebuilding over the same scratch produces identical results (no carryover)

Plus the invariant test that justifies the whole `Scratch` design:

- **fresh scratch vs. used scratch produce byte-identical state.** Run a sequence of road edits and field rebuilds against a `Scratch` used for a hundred prior computations, and against one just allocated, and assert the resulting state hashes match. If scratch ever becomes hidden state, this is what catches it.

- [ ] **Step 2: Confirm they fail**

- [ ] **Step 3: Implement `scratch.ts` then `flowfield.ts`**

`createScratch` allocates inside the function. `computeFlowField` allocates nothing.

- [ ] **Step 4: Extend the determinism scan**

Add the flow-field modules to the scanned set (the file-set assertion in `determinism.test.ts` will fail until you do, which is correct).

Add a golden test: build a fixed road network from a seeded sequence of placements, compute all fields, and pin the state hash. Report the blessed value.

- [ ] **Step 5: Mutation-test**

Attempt: remove the staleness check (`dist[cur] !== d`); shrink the entry pool to `cells * 8`; use a per-cell next pointer instead of the pool; swap `ORTHO_COST` and `DIAG_COST`. Each should fail a named test. **Report any that do not.**

- [ ] **Step 6: Verify and commit**

`pnpm test`, `pnpm typecheck`, `pnpm lint` clean.

---

## Self-Review

**Spec coverage.** §5.1 terrain types and their blocking rules (Task 2); §5.11 road placement, cost, terrain restrictions and refund (Task 3); §5.4 edge weights, multi-source fields, Dial's queue, full rebuild, preallocation, no allocation per tick (Tasks 4–5); §4.1 determinism, strengthened (Task 1). Deliberately **not** covered, belonging to M1c and M1d: bridges, tunnels, roundabouts, motorways, traffic lights, houses, destinations, pins, dispatch, cars, movement, blocking, the week cycle, upgrades, spawning, failure and scoring. Ghost roads (delayed refund) are explicitly deferred to M1c because they require cars, and the plan says so at the point where a reader would otherwise think it was missed.

**Placeholder scan.** Tasks 2–5 specify test *coverage* rather than verbatim test code, unlike M1a. That is a deliberate change: M1a's fully-written tests produced five plan-mandated defects, because a test I wrote blind was accepted verbatim by an implementer who could see the code. Naming what must be proven, and leaving the implementer to write it against the real implementation, puts the person with the most information in charge of the assertion. The mutation requirements are what keep that honest.

**Type consistency.** `Region`/`LayoutEntry`/`computeLayout` (Task 1) are consumed by `state.ts` in Tasks 1, 2 and 3. `MapData` (Task 2, in `shared`) is consumed by `createWorld` (Task 2, in `sim`) and by `createState`. `WorldData` is consumed by Tasks 3, 4 and 5. `Scratch` (Task 5) is produced and consumed only within Task 5. `DIRS`/`OPPOSITE` are defined in `roads.ts` (Task 3) and imported by `graph.ts` (Task 4) and `flowfield.ts` (Task 5) — defined once, not redeclared.

**Two risks worth naming.** `createState`'s signature changes twice (Task 2 adds the map, Task 3 adds the road region), so the golden hash is re-blessed in both — each time in the same commit as the change, never separately. And the road region is the first variable-size region, which makes `restore`'s size check map-dependent rather than constant; Task 3 calls that out, and it is the most likely place for a subtle bug in this milestone.
