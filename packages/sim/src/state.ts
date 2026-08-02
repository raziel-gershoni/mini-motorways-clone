import type { MapData } from '@laneways/shared'
import { seedFromString } from './rng'
import { hashBytes } from './hash'
import { computeLayout, type Region, type RegionCtor } from './layout'
import { assertWorldMatches, mapIdHash, type WorldData } from './world'

/**
 * The whole simulation lives in one ArrayBuffer.
 *
 * Layout, in declaration order (see `regionsFor` below) — this is the
 * complete M1b region list, frozen once here (design decision 5) so that
 * every later task in this milestone appends behaviour, never buffer shape:
 *
 *   rng      Uint32  x 1                 M1a
 *   header   Int32   x HEADER_LENGTH     see slot table below
 *   roads    Uint8   x map.w * map.h     Task 3
 *   cleared  Uint8   x map.w * map.h     Task 3
 *
 * Fixed-size regions precede every variable-size region. If `roads` or
 * `cleared` came first, a wrong-size buffer would displace the header, and
 * `restore` would read road bytes as the map hash — corrupting the very
 * field that exists to detect the mismatch.
 *
 * Region lengths now depend on the map (`roads`/`cleared` are `map.w *
 * map.h`), so the region list can no longer be a module-scope constant the
 * way M1a's two fixed regions were — it is built fresh per call by
 * `regionsFor`, which is exactly what Task 1's AST rule requires: nothing
 * the simulation depends on may be cached at module scope. `computeLayout`
 * (layout.ts) still derives offsets from the declared list, padding each
 * region to its own alignment and rounding the total up to the widest
 * region's alignment, and still asserts rather than assumes.
 *
 * Header slots:
 *
 *   H_TICK    0  tick counter                                       M1a
 *   H_SCORE   1  score (tests only, retained per progress.md:21)     M1a
 *   H_WEEK    2  week index                                         M1a
 *   H_MAP     3  signed non-zero content hash of the map             Task 2
 *   H_MAP_W   4  map width                                          Task 2
 *   H_MAP_H   5  map height                                         Task 2
 *   H_TILES   6  road tile budget, seeded from map.startingTiles     Task 2 seeds, Task 3 spends
 *
 * There is deliberately no dirty-flag slot for the pathfinding fields —
 * design decision 3 derives staleness from content instead, so `restore`
 * stays a pure read with nothing to invalidate.
 *
 * `H_SCORE` is currently written only by tests, and is kept deliberately.
 * That is not inconsistent with dropping the `H_RNG_DRAWS` slot in the same
 * M1a review: a score is certain to exist and its slot costs four bytes,
 * whereas a draw counter was speculative — a guess at a debugging aid
 * nothing had asked for. Retain what the design already commits to; do not
 * retain what it merely might want.
 *
 * `hashState` reads the buffer as raw bytes, so the hash of a given logical
 * state is little-endian-dependent. Every realistic target — x86, ARM in its
 * normal configuration, and every WebAssembly and JavaScript engine — is
 * little-endian, so this is a statement of the assumption rather than a
 * limitation. If a big-endian replay host ever appeared, hashes would differ
 * while the simulation itself stayed identical.
 *
 * This module and `world.ts` import each other: `restore` here calls
 * `assertWorldMatches` (world.ts), and `assertWorldMatches`/`mapIdHash` read
 * `GameState`/`H_MAP*` (here). THE INVARIANT THIS DEPENDS ON: neither module
 * may reference the other at module-evaluation time — only from inside a
 * function body, where the reference isn't resolved until the function is
 * actually called, by which point both modules have finished loading. Safe
 * today by construction, not by luck: every cross-reference here (`H_MAP`,
 * `H_MAP_W`, `H_MAP_H`, `mapIdHash`, `assertWorldMatches`, the `GameState`
 * type) is read inside a function body. If a future edit hoisted one of
 * these into a module-scope initialiser (e.g. `const X = mapIdHash(...)` at
 * top level), the failure would not be silent drift — it would be a loud
 * `ReferenceError: Cannot access '...' before initialization` (TDZ) the
 * first time either module loaded, thrown at import time, not at some
 * later call site.
 */

export const H_TICK = 0
export const H_SCORE = 1
export const H_WEEK = 2
export const H_MAP = 3
export const H_MAP_W = 4
export const H_MAP_H = 5
export const H_TILES = 6
export const HEADER_LENGTH = 7

const RNG_LENGTH = 1

/**
 * Built fresh per call, not a module-scope constant: region lengths depend
 * on the map's cell count. `computeLayout` still does all the offset
 * arithmetic and alignment padding.
 */
function regionsFor(map: MapData): readonly Region[] {
  const cells = map.w * map.h
  return [
    { name: 'rng', ctor: Uint32Array, len: RNG_LENGTH },
    { name: 'header', ctor: Int32Array, len: HEADER_LENGTH },
    { name: 'roads', ctor: Uint8Array, len: cells },
    { name: 'cleared', ctor: Uint8Array, len: cells },
  ]
}

/** Total buffer size for a given map. Replaces the M1a constant `STATE_BYTES`, which is deleted. */
export function stateBytesFor(map: MapData): number {
  return computeLayout(regionsFor(map)).totalBytes
}

export interface GameState {
  readonly buffer: ArrayBuffer
  readonly rng: Uint32Array
  readonly header: Int32Array
  readonly roads: Uint8Array
  readonly cleared: Uint8Array
}

function viewsOver(buffer: ArrayBuffer, map: MapData): GameState {
  // Built by iterating the layout table, not by re-deriving offsets: every
  // view's byteOffset and length come from the entry `computeLayout` already
  // validated, so there is exactly one place that does the arithmetic.
  const views = new Map<string, InstanceType<RegionCtor>>()
  for (const e of computeLayout(regionsFor(map)).entries) {
    views.set(e.name, new e.ctor(buffer, e.offset, e.len))
  }
  const rng = views.get('rng')
  const header = views.get('header')
  const roads = views.get('roads')
  const cleared = views.get('cleared')
  if (
    !(rng instanceof Uint32Array) ||
    !(header instanceof Int32Array) ||
    !(roads instanceof Uint8Array) ||
    !(cleared instanceof Uint8Array)
  ) {
    throw new Error('state layout: view construction did not produce the expected region types')
  }
  return { buffer, rng, header, roads, cleared }
}

/**
 * Forces a hashed word away from zero, keeping every other value unchanged.
 *
 * @internal Exported for testing only; call `createState` or `mapIdHash` instead.
 *
 * Exposed as its own function — not left inlined at each call site — so the
 * zero path can be exercised directly. Hunting for a seed *string* (or map
 * content) that happens to hash to 0 would mean an unbounded,
 * non-deterministic search over a 2^32 output space; testing this pure
 * integer function instead is honest and exact.
 *
 * Renamed from `nonZeroSeed` in M1b: it now guards two distinct "0 is what a
 * blank buffer holds" slots — the rng seed (M1a) and the map content hash
 * (`mapIdHash`, world.ts) — and one shared pure function is better than two
 * identical ones.
 */
export function nonZeroWord(v: number): number {
  return v === 0 ? 1 : v
}

export function createState(seed: string, map: MapData): GameState {
  const s = viewsOver(new ArrayBuffer(stateBytesFor(map)), map)
  // Seed can hash to 0; mulberry32 tolerates it, but a zero here is also the
  // value an uninitialised buffer would hold, so force it non-zero to keep
  // "seeded" and "blank" distinguishable in a dump. Corollary: a seed string
  // that hashes to 0 and a different one that genuinely hashes to 1 now
  // produce byte-identical initial states — harmless (2 outcomes out of
  // 2^32), and each seed string still maps deterministically, which is all
  // replay needs.
  s.rng[0] = nonZeroWord(seedFromString(seed))
  s.header[H_MAP] = mapIdHash(map)
  s.header[H_MAP_W] = map.w
  s.header[H_MAP_H] = map.h
  s.header[H_TILES] = map.startingTiles
  return s
}

/** A detached byte copy. Mutating the source afterwards cannot affect it. */
export function snapshot(s: GameState): ArrayBuffer {
  return s.buffer.slice(0)
}

/**
 * Rebuilds views over a copy of `buffer`, so the restored state is
 * independent, then validates it against `world` in two steps:
 *
 *   1. Byte length, against `stateBytesFor(world.map)` — this must run
 *      first, because a wrong `w`/`h` changes the region lengths themselves,
 *      and a mis-sized buffer would displace the header before any header
 *      field could be compared at all.
 *   2. `assertWorldMatches`, which compares `H_MAP`, `H_MAP_W` and `H_MAP_H`
 *      against `world` and throws naming the mismatched slot and both
 *      values. This is the check that catches a same-cell-count board swap
 *      (24x40 vs 40x24 vs 20x48) that step 1 cannot.
 */
export function restore(buffer: ArrayBuffer, world: WorldData): GameState {
  const expected = stateBytesFor(world.map)
  if (buffer.byteLength !== expected) {
    throw new Error(
      `restore: map "${world.map.id}" expects ${expected} bytes, got ${buffer.byteLength}`,
    )
  }
  const s = viewsOver(buffer.slice(0), world.map)
  assertWorldMatches(s, world)
  return s
}

export function hashState(s: GameState): number {
  return hashBytes(new Uint8Array(s.buffer))
}
