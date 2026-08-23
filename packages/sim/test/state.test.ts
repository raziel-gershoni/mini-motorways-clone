import { describe, it, expect } from 'vitest'
import {
  parseMap,
  CARS_PER_HOUSE,
  MAX_PATH_LEN,
  DEST_SPAWN_PERIOD_TICKS,
  HOUSE_SPAWN_PERIOD_TICKS,
} from '@laneways/shared'
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
  H_GAME_OVER,
  H_FAILED_DEST,
  H_DEST_SPAWN_TIMER,
  H_SPAWN_COLOUR_CURSOR,
  H_OFFER_A,
  H_OFFER_B,
  H_OFFER_WEEK,
  H_INV_UPGRADES,
  H_UPGRADE_COUNT,
  offerPending,
  offerSlot,
  assertRegionNamesMatchLayout,
  HEADER_LENGTH,
  isGameOver,
  failedDestination,
  type GameState,
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
import { regionsFor } from '../src/regions'

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
    { name: 'houseSpawnTimer', ctor: Int32Array, len: MAP.groupCount },
    { name: 'destOvercrowd', ctor: Int32Array, len: MAP.maxDestinations },
    { name: 'destOverTicks', ctor: Int32Array, len: MAP.maxDestinations },
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
    // M1f Task 4. Hand-declared here rather than read from `regionsFor`, for
    // the reason this whole list exists: a fixture built from the table under
    // test agrees with any bug in that table.
    { name: 'upgradeAt', ctor: Uint8Array, len: cells },
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
      houseSpawnTimer: s.houseSpawnTimer,
      destOvercrowd: s.destOvercrowd,
      destOverTicks: s.destOverTicks,
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
      upgradeAt: s.upgradeAt,
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

  it('HEADER_LENGTH is exactly 18 — one slot per named constant, in order 0..17', () => {
    // Re-derived in M1f Task 4 (was 13, slots 0..12 at M1e Task 1; 9, slots
    // 0..8 before that). **This test MUST go red on a header change and be
    // re-derived rather than widened**: the point of it is that the header has
    // no unnamed slots and no gaps, so a header grown by bumping the length
    // without declaring a constant is bytes in every golden that nothing can
    // ever read, and the digest cannot tell you.
    expect(HEADER_LENGTH).toBe(18)
    expect([
      H_TICK, H_SCORE, H_WEEK, H_TILES, H_HOUSE_COUNT, H_DEST_COUNT, H_PINS_DROPPED,
      H_ROUTES_REFUSED, H_EPOCH, H_GAME_OVER, H_FAILED_DEST, H_DEST_SPAWN_TIMER,
      H_SPAWN_COLOUR_CURSOR, H_OFFER_A, H_OFFER_B, H_OFFER_WEEK, H_INV_UPGRADES,
      H_UPGRADE_COUNT,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
  })
})

describe('assertRegionNamesMatchLayout checks BOTH directions', () => {
  // Fed synthetic name lists, because on the real region table both directions
  // are satisfied by construction — deleting either loop scores zero detectors
  // and reads exactly like a guard nobody needed. Same construction
  // `m1eSplice.test.ts` uses for its splice guards.
  const DECLARED = ['rng', 'header', 'roads'] as const

  it('accepts a layout whose names are exactly the declared set', () => {
    // Vacuity for this block: if the well-formed case threw, both "it throws"
    // tests below would pass for the wrong reason.
    expect(() => assertRegionNamesMatchLayout(['rng', 'header', 'roads'], DECLARED)).not.toThrow()
    // Order is irrelevant — this is a set check, and a reorder is not a defect.
    expect(() => assertRegionNamesMatchLayout(['roads', 'rng', 'header'], DECLARED)).not.toThrow()
  })

  it('throws for a DECLARED name with no layout entry — the original direction', () => {
    expect(() => assertRegionNamesMatchLayout(['rng', 'header'], DECLARED)).toThrow(
      /no view constructed for region "roads"/,
    )
  })

  it('throws for a LAYOUT entry with no declared name — the direction M1f Task 4 added', () => {
    // The failure this closes: a region declared in `regions.ts` alone is laid
    // out, folded into `hashState` and copied by `snapshot`/`restore`, while its
    // `GameState` field is `undefined`. Before this loop it surfaced as a moved
    // digest with no failing assertion.
    expect(() =>
      assertRegionNamesMatchLayout(['rng', 'header', 'roads', 'upgradeAtt'], DECLARED),
    ).toThrow(/region "upgradeAtt" is laid out but is not in REGION_FIELD_NAMES/)
  })

  it('runs against the REAL table with the real declared list, and passes', () => {
    // Non-vacuity for production: the two loops above are exercised on synthetic
    // input, and this is the line that says the shipped table satisfies them.
    const names = computeLayout(regionsFor(MAP)).entries.map((e) => e.name)
    expect(names).toContain('upgradeAt')
    expect(() => assertRegionNamesMatchLayout(names)).not.toThrow()
  })
})

describe('the M1f Task 4 header slots and the two guarded offer readers', () => {
  it('leaves all five new slots at zero on a fresh state, which is their correct initial value', () => {
    const s = createState('m1f-shape', MAP)
    expect(s.header[H_OFFER_A], 'CARD_NONE').toBe(0)
    expect(s.header[H_OFFER_B], 'CARD_NONE').toBe(0)
    // Zero means "resolved through week 0", and week 0 has no offer — so
    // "resolved" and "nothing yet" are the same statement and `createState`
    // needs no write. That is the whole reason one slot can carry both
    // "one card per week" and "already chosen this week".
    expect(s.header[H_OFFER_WEEK]).toBe(0)
    expect(s.header[H_INV_UPGRADES]).toBe(0)
    expect(s.header[H_UPGRADE_COUNT]).toBe(0)
  })

  it('offerPending is false at week 0 and true at the first boundary', () => {
    const s = createState('m1f-shape', MAP)
    // Week 0 is excluded because the first boundary is the START of week 1; a
    // week-0 offer would raise the modal before the run has begun.
    expect(offerPending(s), 'week 0 has no offer').toBe(false)
    s.header[H_WEEK] = 1
    expect(offerPending(s), 'week 1, nothing resolved').toBe(true)
    s.header[H_OFFER_WEEK] = 1
    expect(offerPending(s), 'week 1, resolved').toBe(false)
    s.header[H_WEEK] = 2
    expect(offerPending(s), 'week 2, only week 1 resolved').toBe(true)
  })

  it('refuses a week-0 offer even when H_OFFER_WEEK disagrees — the clause a fresh state cannot exercise', () => {
    // **Added from a mutation result.** Dropping `week > 0` scored 0 detectors
    // over the whole suite, and the reason is that the test above cannot see it:
    // on a fresh state `H_WEEK` and `H_OFFER_WEEK` are BOTH 0, so
    // `week > 0 && 0 !== 0` and the bare `0 !== 0` agree at false. The clause
    // only does work where the two slots DISAGREE at week 0, and no fixture put
    // them there.
    //
    // The catalogue's rule about a negative assertion satisfied by the wrong
    // mechanism, in its most literal form: "week 0 has no offer" was passing
    // because the two slots happened to be equal, not because the guard ran.
    //
    // Unreachable in production today — `runOffer` (M1f Task 5) writes
    // `H_OFFER_WEEK` from `H_WEEK`, so they cannot disagree at 0 — and pinned
    // anyway, because the guard's whole job is to hold when a later writer makes
    // it reachable, and its failure mode is raising the modal before the run has
    // begun.
    const s = createState('m1f-shape', MAP)
    s.header[H_WEEK] = 0
    s.header[H_OFFER_WEEK] = 3
    expect(offerPending(s), 'week 0 has no offer, whatever H_OFFER_WEEK says').toBe(false)
    // Vacuity: without the `week > 0` clause this state reads as pending, so the
    // fixture really does separate the two implementations.
    expect((s.header[H_OFFER_WEEK] as number) !== (s.header[H_WEEK] as number)).toBe(true)
    // And `offerSlot` inherits the refusal rather than reading a slot.
    s.header[H_OFFER_A] = 4
    expect(offerSlot(s, 0), 'and no card leaks out through the reader').toBe(0)
  })

  it('offerSlot refuses to hand back a stale card off a RESOLVED week', () => {
    // `applyChooseCard` (M1f Task 6) deliberately does not clear the two card
    // slots, so this guard is the only thing standing between a resolved week
    // and a frame that shows last week's card forever. Same construction as
    // `failedDestination`'s -1, and for the same reason.
    const s = createState('m1f-shape', MAP)
    s.header[H_WEEK] = 3
    s.header[H_OFFER_A] = 1
    s.header[H_OFFER_B] = 7
    expect(offerSlot(s, 0)).toBe(1)
    expect(offerSlot(s, 1)).toBe(7)
    s.header[H_OFFER_WEEK] = 3
    expect(offerSlot(s, 0), 'the slot still HOLDS 1 — the guard is what hides it').toBe(0)
    expect(offerSlot(s, 1)).toBe(0)
    expect(s.header[H_OFFER_A], 'and the byte really is untouched').toBe(1)
    expect(s.header[H_OFFER_B]).toBe(7)
  })

  it('offerSlot throws on a slot index that is neither 0 nor 1', () => {
    const s = createState('m1f-shape', MAP)
    s.header[H_WEEK] = 1
    expect(() => offerSlot(s, 2)).toThrow(/offer slot 2 is not 0 or 1/)
    expect(() => offerSlot(s, -1)).toThrow(/offer slot -1 is not 0 or 1/)
  })

  it('offerSlot returns 0 for an out-of-range slot when nothing is pending, and that is the pending guard talking', () => {
    // Decomposed deliberately: the pending guard runs FIRST, so on a resolved
    // week even a bad index returns 0 rather than throwing. Recorded so nobody
    // reads the throw above as unconditional, and so the ORDER of the two
    // branches has a test that fails if they are swapped.
    const s = createState('m1f-shape', MAP)
    expect(offerPending(s)).toBe(false)
    expect(offerSlot(s, 99)).toBe(0)
  })
})

describe('the M1e Task 1 header slots and the two guarded readers', () => {
  it('a fresh state is live, names no failed destination, and arms both spawn timers', () => {
    const s = createState('m1e-shape', MAP)
    expect(isGameOver(s)).toBe(false)
    // Not `s.header[H_FAILED_DEST]`: the slot is 0, which is a real
    // destination index. The guarded reader is the only correct one.
    expect(failedDestination(s)).toBe(-1)
    expect(s.header[H_DEST_SPAWN_TIMER]).toBe(DEST_SPAWN_PERIOD_TICKS)
    expect(s.header[H_SPAWN_COLOUR_CURSOR]).toBe(0)
    expect(Array.from(s.houseSpawnTimer)).toEqual(
      new Array(MAP.groupCount).fill(HOUSE_SPAWN_PERIOD_TICKS),
    )
    // Vacuity: a timer armed to 0 is the "fire on tick 1" bug the writes exist
    // to prevent, and `toEqual([0,0,...])` would look just as deliberate.
    expect(DEST_SPAWN_PERIOD_TICKS).toBeGreaterThan(0)
    expect(HOUSE_SPAWN_PERIOD_TICKS).toBeGreaterThan(0)
    expect(s.houseSpawnTimer.length).toBe(MAP.groupCount)
    // The two meters are NOT armed — they are counters from zero, and a
    // non-zero one would mean every destination starts part-way to killing you.
    expect(Array.from(s.destOvercrowd).every((v) => v === 0)).toBe(true)
    expect(Array.from(s.destOverTicks).every((v) => v === 0)).toBe(true)
  })

  it('failedDestination reports the slot only once the run is over', () => {
    const s = createState('m1e-shape-over', MAP)
    s.header[H_FAILED_DEST] = 3
    expect(failedDestination(s), 'a live run must not answer this').toBe(-1)
    s.header[H_GAME_OVER] = 1
    expect(failedDestination(s)).toBe(3)
    expect(isGameOver(s)).toBe(true)
  })

  it('isGameOver treats any non-zero as over, not only 1', () => {
    // `!== 0`, not `=== 1`. Nothing writes anything but 1 today; the reader is
    // written so that a future writer storing a reason code cannot silently
    // turn a dead city back into a live one.
    const s = createState('m1e-shape-nonzero', MAP)
    s.header[H_GAME_OVER] = 7
    expect(isGameOver(s)).toBe(true)
    expect(failedDestination(s)).toBe(0) // the slot, unset — and now meaningful
  })
})

describe('a building-free fresh state is all-zero outside rng/mapIdentity/header/occupancy/houseSpawnTimer', () => {
  // The property every unchanged-goldens assertion depends on: every region is
  // zero-initialised except `occupancy`, which M1d Task 2 fills with `FREE =
  // -1` (a zero-filled occupancy region would read as "car 0 occupies every
  // lane of every cell"), and `houseSpawnTimer`, which M1e Task 1 arms with
  // `HOUSE_SPAWN_PERIOD_TICKS` (a zero countdown means "fire on tick 1"). Both
  // exceptions are named in the title and asserted separately below rather
  // than being quietly dropped from the list.

  /**
   * Every region `createState` deliberately does NOT leave zero. Five, and the
   * count is in the describe title above so a sixth cannot be added silently.
   */
  const ARMED_REGIONS = Object.freeze([
    'rng',
    'mapIdentity',
    'header',
    'occupancy',
    'houseSpawnTimer',
  ] as const)

  /**
   * Every region that must read back all zero. Hand-written **by name**, so
   * the completeness test at the end of this block can check the LIST rather
   * than only the property: a list is the thing that rots, and
   * `ARMED_REGIONS union MUST_BE_ZERO === every declared region` is what stops
   * it. The first version of this block derived the partition from the layout
   * table instead, which checked the property perfectly and left the list
   * unpinned — deleting an entry kept the file green while the title claimed
   * otherwise.
   */
  const MUST_BE_ZERO = Object.freeze([
    'pinAccum',
    'rotationCursor',
    'houseCell',
    'destCell',
    'destSpawnTick',
    'carHome',
    'carCell',
    'carProgress',
    'carTargetDest',
    // M1e Task 1: the two meters start at zero. `houseSpawnTimer` is the third
    // new region and is deliberately ARMED, not here.
    'destOvercrowd',
    'destOverTicks',
    'carRouteLen',
    'carRouteCursor',
    'carBlockedTicks',
    'roads',
    'cleared',
    'houseColour',
    'destMeta',
    'destPins',
    'destReserved',
    'carPhase',
    'carRoute',
    'ghostMask',
    'ghostCommitted',
    // M1f Task 4: one flag per cell, and 0 — "the junction rule DOES apply
    // here" — is the correct initial value, so `createState` writes nothing.
    // It is in this list and not the armed one, which is the whole claim.
    'upgradeAt',
  ] as const)

  /** The live views, by region name, so both tests below index the same way. */
  function viewsByName(
    s: GameState,
  ): Record<string, Int32Array | Int16Array | Uint8Array | Uint32Array> {
    return s as unknown as Record<string, Int32Array | Int16Array | Uint8Array | Uint32Array>
  }

  it('every car/house/destination region reads back as all zero on a fresh state', () => {
    const s = createState('all-zero-fresh', MAP)
    const views = viewsByName(s)
    for (const name of MUST_BE_ZERO) {
      const region = views[name]
      expect(region, `no view for region "${name}"`).toBeDefined()
      expect(Array.from(region!).every((v) => v === 0), `region "${name}" is not zero`).toBe(true)
      // Vacuity per region: a zero-LENGTH view satisfies `.every` trivially, so
      // an empty or mis-wired view would otherwise pass this loop silently.
      expect(region!.length, `region "${name}" has no elements to check`).toBeGreaterThan(0)
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

  it('houseSpawnTimer is the OTHER exception: every slot is armed and not one reads 0', () => {
    const s = createState('all-armed-fresh', MAP)
    expect(s.houseSpawnTimer.length).toBe(MAP.groupCount)
    expect(Array.from(s.houseSpawnTimer).every((v) => v === HOUSE_SPAWN_PERIOD_TICKS)).toBe(true)
    // Same construction as `occupancy`'s second assertion: 0 is a MEANINGFUL
    // value in this region ("fire this tick"), so "not zero-filled" is its own
    // claim rather than a corollary of the one above.
    expect(Array.from(s.houseSpawnTimer).some((v) => v === 0)).toBe(false)
  })

  it('the two lists above partition every declared region — exhaustive, and non-overlapping', () => {
    // The catalogue's "a hand-maintained registry only checks what somebody
    // remembered to add". Both lists above are hand-written; this is what pins
    // them. Compared as SETS against the real region table, so a harmless
    // reorder passes and a genuine omission — a new region declared and left
    // out of both, or moved to the wrong list — does not.
    const declared = new Set(regionsFor(MAP).map((r) => r.name))
    const armed = new Set<string>(ARMED_REGIONS)
    const zero = new Set<string>(MUST_BE_ZERO)
    for (const n of armed) {
      expect(zero.has(n), `"${n}" is in BOTH lists`).toBe(false)
    }
    expect(new Set<string>([...armed, ...zero])).toEqual(declared)
    expect(armed.size + zero.size, 'the two lists must not double-count').toBe(declared.size)
  })

})
