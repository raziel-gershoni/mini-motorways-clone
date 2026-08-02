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
