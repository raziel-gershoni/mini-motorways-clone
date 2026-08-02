import { describe, it, expect } from 'vitest'
import { hashBytes } from '../src/hash'

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
