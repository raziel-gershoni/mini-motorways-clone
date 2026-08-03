import { describe, it, expect } from 'vitest'
import { hashBytes, hashInt32 } from '../src/hash'

/** FNV-1a's offset basis — the seed both `hashBytes` and `hashInt32` start from. */
const FNV_OFFSET_BASIS = 0x811c9dc5

describe('hashBytes', () => {
  it('is deterministic', () => {
    const a = new Uint8Array([1, 2, 3, 4])
    expect(hashBytes(a)).toBe(hashBytes(new Uint8Array([1, 2, 3, 4])))
  })

  it('changes when any byte changes', () => {
    const base = new Uint8Array([1, 2, 3, 4])
    for (let i = 0; i < base.length; i++) {
      const m = new Uint8Array(base)
      m[i] = (m[i] as number) + 1
      expect(hashBytes(m), `byte ${i} did not affect the hash`).not.toBe(hashBytes(base))
    }
  })

  it('is order sensitive', () => {
    expect(hashBytes(new Uint8Array([1, 2]))).not.toBe(hashBytes(new Uint8Array([2, 1])))
  })

  it('handles an empty buffer without throwing', () => {
    expect(Number.isInteger(hashBytes(new Uint8Array(0)))).toBe(true)
  })

  it('returns a uint32', () => {
    const v = hashBytes(new Uint8Array([255, 254, 253]))
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('hashInt32', () => {
  /**
   * Pins `hashInt32` against `hashBytes` directly, rather than trusting that
   * two independent-looking FNV loops happen to agree: `hashInt32` seeded
   * from FNV's offset basis over a single value must equal `hashBytes` over
   * that same value's four little-endian bytes. `hashBytes` itself is never
   * refactored to call `hashInt32` (it is under the golden hash), so this is
   * the only place the two are checked against each other.
   */
  function bytesOf(v: number): Uint8Array {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, v, true)
    return bytes
  }

  it('agrees with hashBytes over the little-endian bytes of the same value', () => {
    for (const v of [0, 1, 0x12345678, 0xffffffff, 42]) {
      const viaInt32 = hashInt32(FNV_OFFSET_BASIS, v) >>> 0
      const viaBytes = hashBytes(bytesOf(v))
      expect(viaInt32, `value ${v}`).toBe(viaBytes)
    }
  })

  it('is deterministic', () => {
    expect(hashInt32(FNV_OFFSET_BASIS, 123)).toBe(hashInt32(FNV_OFFSET_BASIS, 123))
  })

  it('changes when the running state changes', () => {
    expect(hashInt32(FNV_OFFSET_BASIS, 5)).not.toBe(hashInt32(FNV_OFFSET_BASIS + 1, 5))
  })

  it('changes when the value changes', () => {
    expect(hashInt32(FNV_OFFSET_BASIS, 5)).not.toBe(hashInt32(FNV_OFFSET_BASIS, 6))
  })

  it('is order sensitive when chained: folding [a, b] differs from folding [b, a]', () => {
    const ab = hashInt32(hashInt32(FNV_OFFSET_BASIS, 1), 2)
    const ba = hashInt32(hashInt32(FNV_OFFSET_BASIS, 2), 1)
    expect(ab).not.toBe(ba)
  })
})
