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
