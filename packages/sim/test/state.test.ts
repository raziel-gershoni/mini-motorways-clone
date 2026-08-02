import { describe, it, expect } from 'vitest'
import {
  createState,
  snapshot,
  restore,
  hashState,
  nonZeroSeed,
  STATE_BYTES,
  H_TICK,
  H_SCORE,
  H_WEEK,
  HEADER_LENGTH,
} from '../src/state'
import { nextRandom } from '../src/rng'
import { computeLayout } from '../src/layout'

describe('createState', () => {
  it('is deterministic for a given seed', () => {
    expect(hashState(createState('abc'))).toBe(hashState(createState('abc')))
  })

  it('differs across seeds', () => {
    expect(hashState(createState('abc'))).not.toBe(hashState(createState('abd')))
  })

  it('starts at tick 0, score 0, week 0', () => {
    const s = createState('x')
    expect(s.header[H_TICK]).toBe(0)
    expect(s.header[H_SCORE]).toBe(0)
    expect(s.header[H_WEEK]).toBe(0)
  })

  it('seeds the rng non-zero', () => {
    expect(createState('x').rng[0]).not.toBe(0)
  })

})

describe('nonZeroSeed', () => {
  it('forces zero to one', () => {
    expect(nonZeroSeed(0)).toBe(1)
  })

  it('leaves every other value unchanged', () => {
    for (const v of [1, 2, 42, 1000, 0x7fffffff, 0xffffffff]) {
      expect(nonZeroSeed(v)).toBe(v)
    }
  })
})

describe('snapshot and restore', () => {
  it('throws its own guard on a too-small buffer', () => {
    // Matched against the message, not bare: `new Uint32Array(buf, 0, 1)` throws
    // a native RangeError for any byteLength below 16, so a bare `.toThrow()`
    // passes with `restore`'s own check deleted.
    expect(() => restore(new ArrayBuffer(1))).toThrow(
      new RegExp(`restore: expected ${STATE_BYTES} bytes, got 1`),
    )
  })

  it('throws on a too-large buffer', () => {
    expect(() => restore(new ArrayBuffer(STATE_BYTES + 1))).toThrow(
      new RegExp(`restore: expected ${STATE_BYTES} bytes`),
    )
  })

  it('round-trips to an identical hash', () => {
    const s = createState('round-trip')
    s.header[H_TICK] = 1234
    s.header[H_SCORE] = 56
    const before = hashState(s)
    expect(hashState(restore(snapshot(s)))).toBe(before)
  })

  it('produces a detached copy — mutating the original does not change the snapshot', () => {
    const s = createState('detach')
    const snap = snapshot(s)
    s.header[H_TICK] = 9999
    expect(hashState(restore(snap))).not.toBe(hashState(s))
  })

  it('restores the rng stream position exactly', () => {
    const s = createState('rng-restore')
    nextRandom(s.rng, 0)
    nextRandom(s.rng, 0)
    const snap = snapshot(s)
    const expected = [nextRandom(s.rng, 0), nextRandom(s.rng, 0)]
    const r = restore(snap)
    expect([nextRandom(r.rng, 0), nextRandom(r.rng, 0)]).toEqual(expected)
  })

  it('restores a snapshot taken from a restored state', () => {
    const a = createState('nested')
    a.header[H_WEEK] = 3
    const b = restore(snapshot(a))
    const c = restore(snapshot(b))
    expect(hashState(c)).toBe(hashState(a))
  })

  it('does not alias — two restores from one snapshot are independent', () => {
    const s = createState('alias')
    s.header[H_TICK] = 100
    const snap = snapshot(s)
    const a = restore(snap)
    const b = restore(snap)
    a.header[H_TICK] = 999
    expect(b.header[H_TICK]).toBe(100)
    expect(hashState(b)).not.toBe(hashState(a))
  })

  it('can restore the same snapshot again after the first restore diverges', () => {
    // The rollback case the single-buffer design exists for: checkpoint, play
    // forward, roll back to the same checkpoint. If restore aliased its input,
    // the second rollback would return the mutated state rather than the
    // checkpoint, and the run would continue from a position that never
    // existed — showing up later as an unreproducible replay divergence.
    const s = createState('rollback')
    s.header[H_TICK] = 50
    const checkpoint = snapshot(s)
    const first = restore(checkpoint)
    first.header[H_TICK] = 5000
    const second = restore(checkpoint)
    expect(second.header[H_TICK]).toBe(50)
  })
})

describe('hashState', () => {
  it('reflects a change to any header field', () => {
    for (const idx of [H_TICK, H_SCORE, H_WEEK]) {
      const s = createState('sensitivity')
      const before = hashState(s)
      s.header[idx] = (s.header[idx] as number) + 1
      expect(hashState(s), `header index ${idx} did not affect the hash`).not.toBe(before)
    }
  })

  it('reflects a change to the rng state', () => {
    const s = createState('rng-sensitivity')
    const before = hashState(s)
    nextRandom(s.rng, 0)
    expect(hashState(s)).not.toBe(before)
  })
})

describe('view layout wiring', () => {
  // `computeLayout` is exercised exhaustively in layout.test.ts — its internal
  // consistency (no overlap, no gap, correct alignment) is guaranteed by
  // construction and cannot fail here. What CAN fail is `viewsOver` wiring a
  // view to the wrong entry: an off-by-one that hands `header` the `rng`
  // entry's offset and length, say. This mirrors state.ts's own declared
  // regions (documented at the top of state.ts: rng Uint32 x1, then header
  // Int32 x HEADER_LENGTH) and recomputes their layout independently, then
  // asserts every live view against it — not just the fixed byte totals.
  const RNG_LENGTH = 1
  const REGIONS = [
    { name: 'rng', ctor: Uint32Array, len: RNG_LENGTH },
    { name: 'header', ctor: Int32Array, len: HEADER_LENGTH },
  ] as const

  it('wires every view to its own layout entry, with no gap or overlap beyond declared padding', () => {
    const { entries, totalBytes } = computeLayout(REGIONS)
    const s = createState('layout-wiring')
    const viewByName: Record<string, Uint32Array | Int32Array> = { rng: s.rng, header: s.header }

    let sumOfViewBytes = 0
    let expectedNextOffset = 0
    for (const e of entries) {
      const view = viewByName[e.name]
      expect(view, `no view for region "${e.name}"`).toBeDefined()
      expect(view!.byteOffset, `${e.name}.byteOffset`).toBe(e.offset)
      expect(view!.length, `${e.name}.length`).toBe(e.len)
      expect(e.offset, `${e.name} overlaps or precedes the previous region`).toBeGreaterThanOrEqual(
        expectedNextOffset,
      )
      expectedNextOffset = e.offset + view!.byteLength
      sumOfViewBytes += view!.byteLength
    }

    const padding = totalBytes - expectedNextOffset
    expect(sumOfViewBytes + padding, 'declared view bytes plus padding').toBe(s.buffer.byteLength)
    expect(totalBytes).toBe(STATE_BYTES)
  })
})
