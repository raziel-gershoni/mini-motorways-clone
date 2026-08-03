/**
 * FNV-1a over raw bytes. Chosen for being trivially portable and exactly
 * specified in integer arithmetic — the point is that two engines agree, not
 * that collisions are rare. Used to compare whole simulation states.
 */
export function hashBytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] as number
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Folds one 32-bit value into a running FNV-1a state, four little-endian
 * bytes at a time — i.e. the same per-byte step `hashBytes` runs, applied to
 * `v`'s LE byte decomposition instead of an actual byte array. Exists so
 * `hashSources` (flowfield.ts) can share one FNV implementation for
 * multi-word input rather than growing a second, independent one.
 *
 * Deliberately NOT used to refactor `hashBytes` into calling this per byte:
 * `hashBytes` is under the golden hash and its output must not move for any
 * reason, including a refactor that would produce byte-identical results.
 * Instead the two are pinned against each other directly in hash.test.ts:
 * `hashInt32` seeded from FNV's offset basis (0x811c9dc5) must equal
 * `hashBytes` over that same value's four little-endian bytes.
 *
 * Returns the raw running state (not `>>> 0`-finalised), exactly like
 * `hashBytes`'s loop body before its own final `>>> 0` — so callers can chain
 * multiple values before finalising once at the end.
 */
export function hashInt32(h: number, v: number): number {
  let acc = h
  acc ^= v & 0xff
  acc = Math.imul(acc, 0x01000193)
  acc ^= (v >>> 8) & 0xff
  acc = Math.imul(acc, 0x01000193)
  acc ^= (v >>> 16) & 0xff
  acc = Math.imul(acc, 0x01000193)
  acc ^= (v >>> 24) & 0xff
  acc = Math.imul(acc, 0x01000193)
  return acc
}
