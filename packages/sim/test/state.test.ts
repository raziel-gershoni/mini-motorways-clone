import { describe, it, expect } from 'vitest'
import { parseMap, CARS_PER_HOUSE, MAX_PATH_LEN } from '@laneways/shared'
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
  H_TILES,
  H_HOUSE_COUNT,
  H_DEST_COUNT,
  H_PINS_DROPPED,
  H_ROUTES_REFUSED,
  H_EPOCH,
  HEADER_LENGTH,
  MI_MAP,
  MI_MAP_W,
  MI_MAP_H,
  MAP_IDENTITY_LENGTH,
} from '../src/state'
import { nextRandom } from '../src/rng'
import { computeLayout } from '../src/layout'
import { createWorld, mapIdHash } from '../src/world'
import { LANE_COUNT } from '../src/roads'
import { FREE } from '../src/blocking'

/**
 * A small non-square (w=5, h=3) fixture map, shared across this file. Not
 * shipped, not firstCity. Non-square deliberately: a square fixture cannot
 * catch `H_MAP_W`/`H_MAP_H` being swapped in `createState` — mutation-tested
 * and confirmed square would hide it.
 */
const MAP = parseMap('test-map', ['.....', '.~^..', '.T...'], 20, 40, 16, 5)

/** Same dimensions as MAP, different content — the only construction that
 * reaches `restore`'s map-hash check without the byte-length guard firing
 * first (design decision 1's own justification). */
const OTHER_MAP_SAME_SIZE = parseMap('other-map', ['.....', '.....', '.....'], 20, 40, 16, 5)

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

  it('writes MI_MAP as the map content hash, and MI_MAP_W / MI_MAP_H as its dimensions', () => {
    const s = createState('map-header', MAP)
    expect(s.mapIdentity[MI_MAP]).toBe(mapIdHash(MAP))
    expect(s.mapIdentity[MI_MAP_W]).toBe(MAP.w)
    expect(s.mapIdentity[MI_MAP_H]).toBe(MAP.h)
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

  it('rejects a buffer whose MI_MAP disagrees with the world, at identical dimensions', () => {
    // Whenever w*h differs, the byte-length guard fires first and this
    // comparison — the entire justification for design decision 1 — is
    // never exercised. Two same-size, different-content maps are the only
    // construction that reaches it.
    const s = createState('mismatch', MAP)
    const otherWorld = createWorld(OTHER_MAP_SAME_SIZE)
    expect(() => restore(snapshot(s), otherWorld)).toThrow(/MI_MAP/)
  })

  it('rejects a buffer whose MI_MAP_W disagrees with the world, with MI_MAP itself left correct', () => {
    // Written directly into mapIdentity, not via a second map: every
    // map-based construction that changes `w` also changes `mapIdHash`'s own
    // byte recipe (it bakes `w` into the hash), so `MI_MAP` would already
    // disagree and that check alone would reject the buffer — this branch
    // would never run. A reviewer confirmed exactly this: deleting the
    // `MI_MAP_W`/`MI_MAP_H` checks entirely left the suite green, because no
    // existing test reached them independently of `MI_MAP`. Writing
    // mapIdentity directly is the only construction that does — do not
    // "improve" this into a second-map construction, which would silently
    // re-merge it with the `MI_MAP` case above and lose the isolation.
    const s = createState('bad-width', MAP)
    s.mapIdentity[MI_MAP_W] = MAP.w + 1
    expect(() => restore(snapshot(s), world)).toThrow(/MI_MAP_W/)
  })

  it('rejects a buffer whose MI_MAP_H disagrees with the world, with MI_MAP itself left correct', () => {
    const s = createState('bad-height', MAP)
    s.mapIdentity[MI_MAP_H] = MAP.h + 1
    expect(() => restore(snapshot(s), world)).toThrow(/MI_MAP_H/)
  })

  it('round-trips to an identical hash', () => {
    // Also the assertion design decision 3 (Task 5's flow fields) rests on:
    // `restore` stays a pure read of the state buffer with nothing to
    // invalidate, because per-colour flow-field staleness is derived from
    // content hashes of `roads`/sources rather than a dirty flag that would
    // need a slot here to roll back correctly. If `restore` ever gained a
    // side effect (e.g. touching a pathfinding cache), this round-trip would
    // be the first thing to catch it moving the hash.
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
  // view to the wrong entry. This INDEPENDENTLY re-declares the full M1c
  // region list (mirroring regions.ts's `regionsFor`, not importing it) and
  // recomputes their layout, then asserts every live view against it — not
  // just the fixed byte totals. Importing `regionsFor` here would make this
  // test tautological against a bug in `regionsFor` itself; hand-declaring
  // the same shape is what lets it catch `viewsOver` wiring a view to the
  // wrong entry independently of whether the table that produced the entry
  // was correct.
  const cells = MAP.w * MAP.h
  const maxCars = CARS_PER_HOUSE * MAP.maxHouses
  const routeBytes = MAX_PATH_LEN / 2
  const REGIONS = [
    { name: 'rng', ctor: Uint32Array, len: 1 },
    { name: 'mapIdentity', ctor: Int32Array, len: MAP_IDENTITY_LENGTH },
    { name: 'header', ctor: Int32Array, len: HEADER_LENGTH },
    { name: 'pinAccum', ctor: Int32Array, len: MAP.groupCount },
    { name: 'rotationCursor', ctor: Int32Array, len: MAP.groupCount },
    { name: 'houseCell', ctor: Int32Array, len: MAP.maxHouses },
    { name: 'destCell', ctor: Int32Array, len: MAP.maxDestinations },
    { name: 'destSpawnTick', ctor: Int32Array, len: MAP.maxDestinations },
    { name: 'carHome', ctor: Int32Array, len: maxCars },
    { name: 'carCell', ctor: Int32Array, len: maxCars },
    { name: 'carProgress', ctor: Int32Array, len: maxCars },
    { name: 'carTargetDest', ctor: Int32Array, len: maxCars },
    { name: 'carRouteLen', ctor: Int16Array, len: maxCars },
    { name: 'carRouteCursor', ctor: Int16Array, len: maxCars },
    { name: 'occupancy', ctor: Int16Array, len: cells * LANE_COUNT },
    { name: 'carBlockedTicks', ctor: Int16Array, len: maxCars },
    { name: 'roads', ctor: Uint8Array, len: cells },
    { name: 'cleared', ctor: Uint8Array, len: cells },
    { name: 'houseColour', ctor: Uint8Array, len: MAP.maxHouses },
    { name: 'destMeta', ctor: Uint8Array, len: MAP.maxDestinations },
    { name: 'destPins', ctor: Uint8Array, len: MAP.maxDestinations },
    { name: 'destReserved', ctor: Uint8Array, len: MAP.maxDestinations },
    { name: 'carPhase', ctor: Uint8Array, len: maxCars },
    { name: 'carRoute', ctor: Uint8Array, len: maxCars * routeBytes },
    { name: 'ghostMask', ctor: Uint8Array, len: cells },
    { name: 'ghostCommitted', ctor: Uint8Array, len: cells },
  ] as const

  it('wires every view to its own layout entry, with no gap or overlap beyond declared padding', () => {
    const { entries, totalBytes } = computeLayout(REGIONS)
    const s = createState('layout-wiring', MAP)
    const viewByName: Record<string, Uint32Array | Int32Array | Int16Array | Uint8Array> = {
      rng: s.rng,
      mapIdentity: s.mapIdentity,
      header: s.header,
      pinAccum: s.pinAccum,
      rotationCursor: s.rotationCursor,
      houseCell: s.houseCell,
      destCell: s.destCell,
      destSpawnTick: s.destSpawnTick,
      carHome: s.carHome,
      carCell: s.carCell,
      carProgress: s.carProgress,
      carTargetDest: s.carTargetDest,
      carRouteLen: s.carRouteLen,
      carRouteCursor: s.carRouteCursor,
      occupancy: s.occupancy,
      carBlockedTicks: s.carBlockedTicks,
      roads: s.roads,
      cleared: s.cleared,
      houseColour: s.houseColour,
      destMeta: s.destMeta,
      destPins: s.destPins,
      destReserved: s.destReserved,
      carPhase: s.carPhase,
      carRoute: s.carRoute,
      ghostMask: s.ghostMask,
      ghostCommitted: s.ghostCommitted,
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

  // The zero-padding claim itself (`totalBytes === sum(len *
  // BYTES_PER_ELEMENT)`) is NOT asserted against `MAP` here: `MAP` is a
  // small non-square fixture (5x3 = 15 cells) whose Uint8 tier ends at a
  // byte offset that is not itself a multiple of 4, so `computeLayout`
  // correctly appends a 2-byte TAIL pad for it (layout.ts's own documented
  // "rounds the total up to 4 even when no region is that wide" behaviour —
  // this is expected, not a defect). The plan's zero-padding claim is
  // specifically about `firstCity`'s sizes (960 cells, total exactly 13,828 B
  // after M1d Task 5's two Uint8 regions; 11,908 B after Task 2, 7,908 B at
  // M1c), and is asserted
  // against the real, exported `regionsFor(firstCity())` in `regions.test.ts`,
  // not re-derived here against an unrelated fixture.
})

describe('atomicity (H_EPOCH)', () => {
  it('a fresh state has H_EPOCH === 0', () => {
    const s = createState('epoch-fresh', MAP)
    expect(s.header[H_EPOCH]).toBe(0)
  })

  it('restore throws a named error when H_EPOCH is non-zero, even though byte length and MI_MAP all agree', () => {
    const world = createWorld(MAP)
    const s = createState('epoch-poisoned', MAP)
    s.header[H_EPOCH] = 7 // simulates a step that threw before clearing it
    expect(() => restore(snapshot(s), world)).toThrow(/H_EPOCH/)
  })

  it('restore does not throw when H_EPOCH is 0', () => {
    const world = createWorld(MAP)
    const s = createState('epoch-clean', MAP)
    expect(() => restore(snapshot(s), world)).not.toThrow()
  })
})

describe('the new M1c header slots exist and start at 0', () => {
  it('H_HOUSE_COUNT, H_DEST_COUNT, H_PINS_DROPPED, H_ROUTES_REFUSED all start at 0', () => {
    const s = createState('new-header-slots', MAP)
    expect(s.header[H_HOUSE_COUNT]).toBe(0)
    expect(s.header[H_DEST_COUNT]).toBe(0)
    expect(s.header[H_PINS_DROPPED]).toBe(0)
    expect(s.header[H_ROUTES_REFUSED]).toBe(0)
  })

  it('HEADER_LENGTH is exactly 9 — one slot per named constant, in order 0..8', () => {
    expect(HEADER_LENGTH).toBe(9)
    expect([H_TICK, H_SCORE, H_WEEK, H_TILES, H_HOUSE_COUNT, H_DEST_COUNT, H_PINS_DROPPED, H_ROUTES_REFUSED, H_EPOCH]).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ])
  })
})

describe('a building-free fresh state is all-zero outside rng/mapIdentity/header[H_TILES]/occupancy', () => {
  // The property every unchanged-goldens assertion depends on: every region is
  // zero-initialised except `occupancy`, which M1d Task 2 fills with `FREE =
  // -1` (a zero-filled occupancy region would read as "car 0 occupies every
  // lane of every cell"). The exception is named in the title and asserted
  // separately below rather than being quietly dropped from the list.
  it('every car/house/destination region reads back as all zero on a fresh state', () => {
    const s = createState('all-zero-fresh', MAP)
    const regions: readonly (Int32Array | Int16Array | Uint8Array)[] = [
      s.pinAccum,
      s.rotationCursor,
      s.houseCell,
      s.destCell,
      s.destSpawnTick,
      s.carHome,
      s.carCell,
      s.carProgress,
      s.carTargetDest,
      s.carRouteLen,
      s.carRouteCursor,
      s.carBlockedTicks,
      s.roads,
      s.cleared,
      s.houseColour,
      s.destMeta,
      s.destPins,
      s.destReserved,
      s.carPhase,
      s.carRoute,
    ]
    for (const region of regions) {
      expect(Array.from(region).every((v) => v === 0)).toBe(true)
    }
  })

  it('occupancy is the ONE exception: every slot reads FREE, and not one reads 0', () => {
    const s = createState('all-free-fresh', MAP)
    expect(s.occupancy.length).toBe(MAP.w * MAP.h * LANE_COUNT)
    expect(Array.from(s.occupancy).every((v) => v === FREE)).toBe(true)
    // Stated as its own assertion, not as a corollary: 0 is a valid CAR INDEX
    // in this region, so "zero-fill instead of -1-fill" is the mutation that
    // makes the whole board unenterable, and `every(v => v === FREE)` above is
    // the only thing standing between it and a green suite.
    expect(Array.from(s.occupancy).some((v) => v === 0)).toBe(false)
  })
})
