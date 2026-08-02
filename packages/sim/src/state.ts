import { seedFromString } from './rng'
import { hashBytes } from './hash'

/**
 * The whole simulation lives in one ArrayBuffer.
 *
 * Layout, in order:
 *   [0]                        rng      Uint32  x 1
 *   [RNG_BYTES ...]            header   Int32   x HEADER_LENGTH
 *
 * Later plans append typed-array regions for roads, buildings and cars. The
 * rule is that nothing the simulation can change may live outside this buffer:
 * that is what makes a snapshot a single byte copy and rollback free.
 */

export const H_TICK = 0
export const H_SCORE = 1
export const H_WEEK = 2
export const H_RNG_DRAWS = 3
export const HEADER_LENGTH = 4

const RNG_LENGTH = 1
const RNG_BYTES = RNG_LENGTH * 4
const HEADER_BYTES = HEADER_LENGTH * 4
export const STATE_BYTES = RNG_BYTES + HEADER_BYTES

export interface GameState {
  readonly buffer: ArrayBuffer
  readonly rng: Uint32Array
  readonly header: Int32Array
}

function viewsOver(buffer: ArrayBuffer): GameState {
  return {
    buffer,
    rng: new Uint32Array(buffer, 0, RNG_LENGTH),
    header: new Int32Array(buffer, RNG_BYTES, HEADER_LENGTH),
  }
}

export function createState(seed: string): GameState {
  const s = viewsOver(new ArrayBuffer(STATE_BYTES))
  // Seed can hash to 0; mulberry32 tolerates it, but a zero here is also the
  // value an uninitialised buffer would hold, so force it non-zero to keep
  // "seeded" and "blank" distinguishable in a dump.
  const seeded = seedFromString(seed)
  s.rng[0] = seeded === 0 ? 1 : seeded
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
