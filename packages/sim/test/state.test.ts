import { describe, it, expect } from 'vitest'
import { parseMap } from '@laneways/shared'
import {
  createState,
  snapshot,
  restore,
  hashState,
  stateBytesFor,
  nonZeroWord,
  H_TICK,
  H_SCORE,
  H_WEEK,
  H_MAP,
  H_MAP_W,
  H_MAP_H,
  H_TILES,
  HEADER_LENGTH,
} from '../src/state'
import { nextRandom } from '../src/rng'
import { computeLayout } from '../src/layout'
import { createWorld, mapIdHash } from '../src/world'

/**
 * A small non-square (w=5, h=3) fixture map, shared across this file. Not
 * shipped, not firstCity. Non-square deliberately: a square fixture cannot
 * catch `H_MAP_W`/`H_MAP_H` being swapped in `createState` — mutation-tested
 * and confirmed square would hide it.
 */
const MAP = parseMap('test-map', ['.....', '.~^..', '.T...'], 20)

/** Same dimensions as MAP, different content — the only construction that
 * reaches `restore`'s map-hash check without the byte-length guard firing
 * first (design decision 1's own justification). */
const OTHER_MAP_SAME_SIZE = parseMap('other-map', ['.....', '.....', '.....'], 20)

describe('createState', () => {
  it('is deterministic for a given seed', () => {
    expect(hashState(createState('abc', MAP))).toBe(hashState(createState('abc', MAP)))
  })

  it('differs across seeds', () => {
    expect(hashState(createState('abc', MAP))).not.toBe(hashState(createState('abd', MAP)))
  })

  it('differs across maps for the same seed', () => {
    expect(hashState(createState('same-seed', MAP))).not.toBe(
      hashState(createState('same-seed', OTHER_MAP_SAME_SIZE)),
    )
  })

  it('starts at tick 0, score 0, week 0', () => {
    const s = createState('x', MAP)
    expect(s.header[H_TICK]).toBe(0)
    expect(s.header[H_SCORE]).toBe(0)
    expect(s.header[H_WEEK]).toBe(0)
  })

  it('seeds the rng non-zero', () => {
    expect(createState('x', MAP).rng[0]).not.toBe(0)
  })

  it('writes H_MAP as the map content hash, and H_MAP_W / H_MAP_H as its dimensions', () => {
    const s = createState('map-header', MAP)
    expect(s.header[H_MAP]).toBe(mapIdHash(MAP))
    expect(s.header[H_MAP_W]).toBe(MAP.w)
    expect(s.header[H_MAP_H]).toBe(MAP.h)
  })

  it('seeds H_TILES from map.startingTiles', () => {
    const s = createState('tiles', MAP)
    expect(s.header[H_TILES]).toBe(MAP.startingTiles)
  })
})

describe('nonZeroWord', () => {
  it('forces zero to one', () => {
    expect(nonZeroWord(0)).toBe(1)
  })

  it('leaves every other value unchanged', () => {
    for (const v of [1, 2, 42, 1000, 0x7fffffff, 0xffffffff, -1, -1000]) {
      expect(nonZeroWord(v)).toBe(v)
    }
  })
})

describe('snapshot and restore', () => {
  const world = createWorld(MAP)

  it('throws its own guard on a too-small buffer, naming the map id and both sizes', () => {
    // Matched against the message, not bare: `new Uint32Array(buf, 0, 1)`
    // throws a native RangeError for a too-small byteLength, so a bare
    // `.toThrow()` passes with `restore`'s own check deleted.
    const expected = stateBytesFor(MAP)
    expect(() => restore(new ArrayBuffer(1), world)).toThrow(
      new RegExp(`restore: map "${MAP.id}" expects ${expected} bytes, got 1`),
    )
  })

  it('throws on a too-large buffer', () => {
    const expected = stateBytesFor(MAP)
    expect(() => restore(new ArrayBuffer(expected + 1), world)).toThrow(
      new RegExp(`restore: map "${MAP.id}" expects ${expected} bytes, got ${expected + 1}`),
    )
  })

  it('does not throw for a buffer whose header matches the world', () => {
    // Without this, `assertWorldMatches = () => { throw new Error() }` would
    // still pass every other assertion in this file.
    const s = createState('matching', MAP)
    expect(() => restore(snapshot(s), world)).not.toThrow()
  })

  it('rejects a buffer whose H_MAP disagrees with the world, at identical dimensions', () => {
    // Whenever w*h differs, the byte-length guard fires first and this
    // comparison — the entire justification for design decision 1 — is
    // never exercised. Two same-size, different-content maps are the only
    // construction that reaches it.
    const s = createState('mismatch', MAP)
    const otherWorld = createWorld(OTHER_MAP_SAME_SIZE)
    expect(() => restore(snapshot(s), otherWorld)).toThrow(/H_MAP/)
  })

  it('rejects a buffer whose H_MAP_W disagrees with the world, with H_MAP itself left correct', () => {
    // Written directly into the header, not via a second map: every
    // map-based construction that changes `w` also changes `mapIdHash`'s own
    // byte recipe (it bakes `w` into the hash), so `H_MAP` would already
    // disagree and that check alone would reject the buffer — this branch
    // would never run. A reviewer confirmed exactly this: deleting the
    // `H_MAP_W`/`H_MAP_H` checks entirely left the suite green, because no
    // existing test reached them independently of `H_MAP`. Writing the
    // header directly is the only construction that does — do not "improve"
    // this into a second-map construction, which would silently re-merge it
    // with the `H_MAP` case above and lose the isolation.
    const s = createState('bad-width', MAP)
    s.header[H_MAP_W] = MAP.w + 1
    expect(() => restore(snapshot(s), world)).toThrow(/H_MAP_W/)
  })

  it('rejects a buffer whose H_MAP_H disagrees with the world, with H_MAP itself left correct', () => {
    const s = createState('bad-height', MAP)
    s.header[H_MAP_H] = MAP.h + 1
    expect(() => restore(snapshot(s), world)).toThrow(/H_MAP_H/)
  })

  it('round-trips to an identical hash', () => {
    const s = createState('round-trip', MAP)
    s.header[H_TICK] = 1234
    s.header[H_SCORE] = 56
    const before = hashState(s)
    expect(hashState(restore(snapshot(s), world))).toBe(before)
  })

  it('produces a detached copy — mutating the original does not change the snapshot', () => {
    const s = createState('detach', MAP)
    const snap = snapshot(s)
    s.header[H_TICK] = 9999
    expect(hashState(restore(snap, world))).not.toBe(hashState(s))
  })

  it('restores the rng stream position exactly', () => {
    const s = createState('rng-restore', MAP)
    nextRandom(s.rng, 0)
    nextRandom(s.rng, 0)
    const snap = snapshot(s)
    const expected = [nextRandom(s.rng, 0), nextRandom(s.rng, 0)]
    const r = restore(snap, world)
    expect([nextRandom(r.rng, 0), nextRandom(r.rng, 0)]).toEqual(expected)
  })

  it('restores a snapshot taken from a restored state', () => {
    const a = createState('nested', MAP)
    a.header[H_WEEK] = 3
    const b = restore(snapshot(a), world)
    const c = restore(snapshot(b), world)
    expect(hashState(c)).toBe(hashState(a))
  })

  it('does not alias — two restores from one snapshot are independent', () => {
    const s = createState('alias', MAP)
    s.header[H_TICK] = 100
    const snap = snapshot(s)
    const a = restore(snap, world)
    const b = restore(snap, world)
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
    const s = createState('rollback', MAP)
    s.header[H_TICK] = 50
    const checkpoint = snapshot(s)
    const first = restore(checkpoint, world)
    first.header[H_TICK] = 5000
    const second = restore(checkpoint, world)
    expect(second.header[H_TICK]).toBe(50)
  })
})

describe('hashState', () => {
  it('reflects a change to any header field', () => {
    for (const idx of [H_TICK, H_SCORE, H_WEEK]) {
      const s = createState('sensitivity', MAP)
      const before = hashState(s)
      s.header[idx] = (s.header[idx] as number) + 1
      expect(hashState(s), `header index ${idx} did not affect the hash`).not.toBe(before)
    }
  })

  it('reflects a change to the rng state', () => {
    const s = createState('rng-sensitivity', MAP)
    const before = hashState(s)
    nextRandom(s.rng, 0)
    expect(hashState(s)).not.toBe(before)
  })
})

describe('view layout wiring', () => {
  // `computeLayout` is exercised exhaustively in layout.test.ts — its internal
  // consistency (no overlap, no gap, correct alignment) is guaranteed by
  // construction and cannot fail here. What CAN fail is `viewsOver` wiring a
  // view to the wrong entry. This mirrors state.ts's own declared regions
  // (documented at the top of state.ts: rng, header, roads, cleared) and
  // recomputes their layout independently, then asserts every live view
  // against it — not just the fixed byte totals.
  const RNG_LENGTH = 1
  const cells = MAP.w * MAP.h
  const REGIONS = [
    { name: 'rng', ctor: Uint32Array, len: RNG_LENGTH },
    { name: 'header', ctor: Int32Array, len: HEADER_LENGTH },
    { name: 'roads', ctor: Uint8Array, len: cells },
    { name: 'cleared', ctor: Uint8Array, len: cells },
  ] as const

  it('wires every view to its own layout entry, with no gap or overlap beyond declared padding', () => {
    const { entries, totalBytes } = computeLayout(REGIONS)
    const s = createState('layout-wiring', MAP)
    const viewByName: Record<string, Uint32Array | Int32Array | Uint8Array> = {
      rng: s.rng,
      header: s.header,
      roads: s.roads,
      cleared: s.cleared,
    }

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
    expect(totalBytes).toBe(stateBytesFor(MAP))
  })
})
