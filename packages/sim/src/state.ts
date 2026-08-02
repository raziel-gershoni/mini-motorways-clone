import { seedFromString } from './rng'
import { hashBytes } from './hash'
import { computeLayout, type Region, type RegionCtor } from './layout'

/**
 * The whole simulation lives in one ArrayBuffer.
 *
 * Layout, in declaration order (see `REGIONS` below):
 *   rng      Uint32  x 1
 *   header   Int32   x HEADER_LENGTH
 *
 * Offsets are no longer hand-computed. M1a's reviewer had to verify by hand
 * that these two regions did not overlap or leave a gap, and that did not
 * survive M1b's four additional regions — nor is it generally safe: alignment
 * is not automatic once a byte-length region of odd size sits before a wider
 * one. `computeLayout` (layout.ts) derives offsets from the declared region
 * list, padding each region to its own alignment and rounding the total up to
 * the widest region's alignment, and asserts rather than assumes.
 *
 * Later plans append typed-array regions for terrain, roads, buildings and
 * cars, by adding entries to `REGIONS`. The rule is that nothing the
 * simulation can change may live outside this buffer: that is what makes a
 * snapshot a single byte copy and rollback free.
 *
 * `H_SCORE` is currently written only by tests, and is kept deliberately. That
 * is not inconsistent with dropping the `H_RNG_DRAWS` slot in the same review:
 * a score is certain to exist and its slot costs four bytes, whereas a draw
 * counter was speculative — a guess at a debugging aid nothing had asked for.
 * Retain what the design already commits to; do not retain what it merely
 * might want.
 *
 * `hashState` reads the buffer as raw bytes, so the hash of a given logical
 * state is little-endian-dependent. Every realistic target — x86, ARM in its
 * normal configuration, and every WebAssembly and JavaScript engine — is
 * little-endian, so this is a statement of the assumption rather than a
 * limitation. If a big-endian replay host ever appeared, hashes would differ
 * while the simulation itself stayed identical.
 */

export const H_TICK = 0
export const H_SCORE = 1
export const H_WEEK = 2
export const HEADER_LENGTH = 3

const RNG_LENGTH = 1

// Declared, not hand-computed. Each region is frozen individually because
// `Object.freeze` is shallow — freezing only the outer array would still
// leave `{ name: 'rng', ... }` itself mutable. `no-module-mutable-state`
// (tools/eslint-rules) enforces both the outer and the per-element freeze.
const REGIONS: readonly Region[] = Object.freeze([
  Object.freeze({ name: 'rng', ctor: Uint32Array, len: RNG_LENGTH }),
  Object.freeze({ name: 'header', ctor: Int32Array, len: HEADER_LENGTH }),
])

const LAYOUT = computeLayout(REGIONS)

export const STATE_BYTES = LAYOUT.totalBytes

export interface GameState {
  readonly buffer: ArrayBuffer
  readonly rng: Uint32Array
  readonly header: Int32Array
}

function viewsOver(buffer: ArrayBuffer): GameState {
  // Built by iterating the layout table, not by re-deriving offsets: every
  // view's byteOffset and length come from the entry `computeLayout` already
  // validated, so there is exactly one place that does the arithmetic.
  const views = new Map<string, InstanceType<RegionCtor>>()
  for (const e of LAYOUT.entries) {
    views.set(e.name, new e.ctor(buffer, e.offset, e.len))
  }
  const rng = views.get('rng')
  const header = views.get('header')
  if (!(rng instanceof Uint32Array) || !(header instanceof Int32Array)) {
    throw new Error('state layout: view construction did not produce the expected region types')
  }
  return { buffer, rng, header }
}

/**
 * Forces a hashed seed away from zero, keeping every other value unchanged.
 *
 * @internal Exported for testing only; call `createState` instead.
 *
 * Exposed as its own function — not left inlined in `createState` — so the
 * zero path can be exercised directly. Hunting for a seed *string* that
 * happens to hash to 0 would mean an unbounded, non-deterministic search
 * over `seedFromString`'s 2^32 output space; testing this pure integer
 * function instead is honest and exact.
 */
export function nonZeroSeed(seeded: number): number {
  return seeded === 0 ? 1 : seeded
}

export function createState(seed: string): GameState {
  const s = viewsOver(new ArrayBuffer(STATE_BYTES))
  // Seed can hash to 0; mulberry32 tolerates it, but a zero here is also the
  // value an uninitialised buffer would hold, so force it non-zero to keep
  // "seeded" and "blank" distinguishable in a dump. Corollary: a seed string
  // that hashes to 0 and a different one that genuinely hashes to 1 now
  // produce byte-identical initial states — harmless (2 outcomes out of
  // 2^32), and each seed string still maps deterministically, which is all
  // replay needs.
  s.rng[0] = nonZeroSeed(seedFromString(seed))
  return s
}

/** A detached byte copy. Mutating the source afterwards cannot affect it. */
export function snapshot(s: GameState): ArrayBuffer {
  return s.buffer.slice(0)
}

/** Rebuilds views over a copy of `buffer`, so the restored state is independent. */
export function restore(buffer: ArrayBuffer): GameState {
  if (buffer.byteLength !== STATE_BYTES) {
    throw new Error(`restore: expected ${STATE_BYTES} bytes, got ${buffer.byteLength}`)
  }
  return viewsOver(buffer.slice(0))
}

export function hashState(s: GameState): number {
  return hashBytes(new Uint8Array(s.buffer))
}
