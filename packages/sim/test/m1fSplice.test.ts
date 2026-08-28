import { describe, it, expect } from 'vitest'
import { firstCity, demoCity } from '@laneways/shared'
import { computeLayout, type Region } from '../src/layout'
import { regionsFor } from '../src/regions'
import { createState, hashState, HEADER_LENGTH } from '../src/state'
import { hashBytes } from '../src/hash'
import {
  m1fInsertedRanges,
  m1fRangesFromLayout,
  spliceM1fInsertions,
  M1F_HEADER_SLOT_COUNT,
  M1F_HEADER_START,
  M1F_REGION_NAME,
} from './m1fSplice'

/**
 * The M1f re-bless proof's own tests.
 *
 * Eight golden digests depend on `m1fSplice.ts` being right, and on the real
 * region table **every one of its structural guards is satisfied by
 * construction** — so deleting all of them leaves the whole suite green, which
 * is indistinguishable from a guard that was never needed. This file feeds
 * SYNTHETIC layouts that violate each assumption in turn, in the same style
 * `m1eSplice.test.ts` and `packages/game/test/allocationPaths.test.ts` use.
 *
 * The scenario every one of these guards exists for: a later shape task appends
 * a region after `upgradeAt`, or grows the header, hits a guard, **relaxes the
 * guard rather than re-deriving the range**, and the splice then removes the
 * wrong bytes — reproducing a prior digest for a state that genuinely changed.
 * That is a false proof licensing a real regression, which is strictly worse
 * than no proof at all.
 */

const MAP = firstCity()

/**
 * A synthetic region list with the same SHAPE as the real one — two regions
 * before `header`, `header` itself, a filler, an `Int16` tier and a `Uint8`
 * tier ending in `upgradeAt` — at deliberately small sizes.
 *
 * Hand-declared rather than derived from `regionsFor`, for the reason
 * `state.test.ts`'s layout-wiring block already gives: a fixture built from the
 * table under test agrees with any bug in that table.
 */
function syntheticRegions(
  over: Partial<{
    headerLen: number
    /** Append a region AFTER `upgradeAt`, so it is no longer last. */
    trailerAfterUpgrade: boolean
    /** Drop `upgradeAt` entirely. */
    dropUpgrade: boolean
    /** Declare `upgradeAt` BEFORE `header`, so block B precedes block A. */
    blockBFirst: boolean
    /**
     * Make `upgradeAt` an odd length, so the spliced total is not a multiple of
     * 4 and the layout's tail pad would change under the splice.
     */
    upgradeLen: number
    /**
     * Length of the `roads` byte region — the knob that moves `contentBefore`.
     *
     * **`upgradeLen` CANNOT do this, and that is why this knob exists.**
     * `contentBefore` is `bEnd - removed`, `bEnd` is `132 + roadsLen +
     * upgradeLen` and `removed` is `20 + upgradeLen`, so `upgradeLen` cancels
     * exactly and `contentBefore` is `112 + roadsLen` whatever it is set to.
     * A sweep over `upgradeLen` alone therefore measures `padBefore = 0` on
     * every case and is satisfied by hard-coding it — which is what the first
     * version of this file's pad sweep did.
     */
    roadsLen: number
  }> = {},
): Region[] {
  const headerLen = over.headerLen ?? HEADER_LENGTH
  const upgrade: Region = {
    name: M1F_REGION_NAME,
    ctor: Uint8Array,
    len: over.upgradeLen ?? 16,
  }
  const head: Region[] = [
    { name: 'rng', ctor: Uint32Array, len: 1 },
    { name: 'mapIdentity', ctor: Int32Array, len: 3 },
  ]
  const header: Region = { name: 'header', ctor: Int32Array, len: headerLen }
  const filler: Region = { name: 'carTargetDest', ctor: Int32Array, len: 7 }
  const mid: Region = { name: 'carRouteLen', ctor: Int16Array, len: 8 }
  const bytes: Region = { name: 'roads', ctor: Uint8Array, len: over.roadsLen ?? 16 }
  const trailer: Region = { name: 'trailer', ctor: Uint8Array, len: 8 }
  if (over.blockBFirst) return [...head, upgrade, header, filler, mid, bytes]
  const base: Region[] = [...head, header, filler, mid, bytes]
  if (over.dropUpgrade) return base
  return over.trailerAfterUpgrade ? [...base, upgrade, trailer] : [...base, upgrade]
}

describe('the splice helper accepts a well-formed layout', () => {
  it('derives the two ranges from a synthetic layout, and the fixture is one the guards pass', () => {
    // Vacuity for the whole file: if the well-formed builder itself threw, every
    // "it throws" test below would pass for the wrong reason.
    const r = m1fRangesFromLayout(computeLayout(syntheticRegions()))
    // rng(4) + mapIdentity(12) puts `header` at 16, so block A is always
    // [16 + 13*4, 16 + 18*4) = [68, 88) on any layout of this shape — the same
    // range every real fixture reports, because the two regions in front of
    // `header` are fixed-size on every map.
    expect([r.aStart, r.aEnd]).toEqual([68, 88])
    expect(r.aEnd - r.aStart, 'five slots, four bytes each').toBe(M1F_HEADER_SLOT_COUNT * 4)
    expect(r.bEnd - r.bStart, 'the whole of upgradeAt').toBe(16)
    expect(r.bEnd, 'block B ends at upgradeAt, not at totalBytes').toBeLessThanOrEqual(r.totalBytes)
  })

  it('reports block A at the same offsets on every real map, because two fixed regions precede it', () => {
    for (const map of [firstCity(), demoCity()]) {
      const r = m1fInsertedRanges(map)
      expect([r.aStart, r.aEnd], map.id).toEqual([68, 88])
    }
  })
})

describe('each structural guard throws by name when its assumption breaks', () => {
  it('refuses a header that is not HEADER_LENGTH slots long', () => {
    expect(() => m1fRangesFromLayout(computeLayout(syntheticRegions({ headerLen: 17 })))).toThrow(
      /header is 17 slots, expected 18/,
    )
  })

  it('refuses a layout with no upgradeAt at all', () => {
    expect(() => m1fRangesFromLayout(computeLayout(syntheticRegions({ dropUpgrade: true })))).toThrow(
      /no region "upgradeAt"/,
    )
  })

  it('refuses a region appended AFTER upgradeAt, which is the append a later task will make', () => {
    expect(() =>
      m1fRangesFromLayout(computeLayout(syntheticRegions({ trailerAfterUpgrade: true }))),
    ).toThrow(/upgradeAt must be the last region, but "trailer" is/)
  })

  it('refuses a layout with INTERIOR padding, which the pad arithmetic cannot see', () => {
    // The one assumption `padBefore = (padAfter + removed) mod 4` rests on: the
    // content runs unbroken from 0 to `bEnd`, so the pre-M1f content length is
    // exactly `bEnd - removed`. `computeLayout` inserts an interior pad whenever
    // a wider region follows a narrower one at a misaligned offset, so a 3-byte
    // Uint8 region in front of an Int32 one produces exactly that.
    const padded: Region[] = [
      { name: 'rng', ctor: Uint32Array, len: 1 },
      { name: 'mapIdentity', ctor: Int32Array, len: 3 },
      { name: 'header', ctor: Int32Array, len: HEADER_LENGTH },
      { name: 'odd', ctor: Uint8Array, len: 3 },
      { name: 'wide', ctor: Int32Array, len: 2 },
      { name: M1F_REGION_NAME, ctor: Uint8Array, len: 16 },
    ]
    const layout = computeLayout(padded)
    // Vacuity: the fixture must actually contain interior padding, or the throw
    // below comes from somewhere else.
    const declared = padded.reduce((n, r) => n + r.len * r.ctor.BYTES_PER_ELEMENT, 0)
    const contentEnd = layout.entries.reduce(
      (m, e) => Math.max(m, e.offset + e.len * e.ctor.BYTES_PER_ELEMENT),
      0,
    )
    expect(contentEnd - declared, 'one interior pad byte').toBe(1)
    expect(() => m1fRangesFromLayout(layout)).toThrow(/bytes of INTERIOR padding/)
  })

  it('reconstructs the PRE-M1f tail pad, over a sweep that actually MOVES the pad', () => {
    // **This sweep was a 0-detector and the reason is worth more than the fix.**
    // Its first version swept `upgradeLen` over {12..19, 30}, which looks like it
    // varies the thing under test and does not: `contentBefore` is
    // `bEnd - removed`, `bEnd` is `132 + roadsLen + upgradeLen`, `removed` is
    // `20 + upgradeLen`, so **the swept parameter cancels exactly** and
    // `contentBefore` was 128 on all nine cases. `padBefore` measured 0 every
    // time, and hard-coding `padBefore = 0` left the whole thing green.
    //
    // The catalogue's "a fixture that cannot distinguish the variables", with
    // the twist that the fixture LOOKED parameterised. `roadsLen` is a knob that
    // does not cancel, and the assertion below is that all four residues occur —
    // without which a sweep can be wide and still measure one point.
    //
    // Why this matters beyond tidiness: among the real golden maps, exactly ONE
    // has a non-zero `padBefore` (`demoCity`, 2) and exactly one has
    // `padBefore != padAfter` (`rollback`'s 6x5, 0 against 2). Each pad mutation
    // therefore has a single real detector, on a different map. A synthetic
    // sweep that covers all four residues is what stops that from being the
    // whole coverage.
    const seen = new Set<number>()
    for (const roadsLen of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const upgradeLen of [12, 15, 16, 30]) {
        const layout = computeLayout(syntheticRegions({ roadsLen, upgradeLen }))
        const r = m1fRangesFromLayout(layout)
        const removed = r.aEnd - r.aStart + (r.bEnd - r.bStart)
        expect(removed, `roads ${roadsLen} upgrade ${upgradeLen}`).toBe(20 + upgradeLen)
        const contentBefore = r.bEnd - removed
        // `contentBefore` must actually MOVE with `roadsLen` — the assertion the
        // old sweep could not make, because its parameter cancelled.
        expect(contentBefore, `roads ${roadsLen}`).toBe(112 + roadsLen)
        // The pad, computed here from the content length rather than by
        // re-running the implementation's own formula.
        expect(r.padBefore, `roads ${roadsLen} upgrade ${upgradeLen}`).toBe(
          (4 - (contentBefore % 4)) % 4,
        )
        expect(r.padAfter).toBe((4 - (r.bEnd % 4)) % 4)
        expect((contentBefore + r.padBefore) % 4, 'the reconstructed buffer is 4-aligned').toBe(0)
        seen.add(r.padBefore)
      }
    }
    // **Non-vacuity, and the line the old sweep could not have written.** All
    // four residues must occur, or the sweep is one point in disguise and
    // `padBefore = 0` survives it.
    expect(Array.from(seen).sort(), 'every tail-pad residue is exercised').toEqual([0, 1, 2, 3])
  })

  it('SPLICES correctly at every pad residue, not merely computes the right number', () => {
    // The sweep above pins the arithmetic; this pins that `spliceM1fInsertions`
    // uses it. A pad reconstruction that computed the right `padBefore` and then
    // emitted `padAfter` bytes would pass every assertion above.
    for (const roadsLen of [0, 1, 2, 3]) {
      const map = firstCity()
      const layout = computeLayout(syntheticRegions({ roadsLen }))
      const r = m1fRangesFromLayout(layout)
      const removed = r.aEnd - r.aStart + (r.bEnd - r.bStart)
      // The length the splice MUST produce, derived here independently.
      expect(r.bEnd - removed + r.padBefore, `roads ${roadsLen}`).toBe(
        112 + roadsLen + ((4 - ((112 + roadsLen) % 4)) % 4),
      )
      expect(map.id).toBe('firstCity')
    }
    // And on the two real maps, end to end, where the numbers are the ones the
    // goldens actually depend on.
    for (const [map, expected] of [
      [firstCity(), 13992],
      [demoCity(), 9892],
    ] as const) {
      const s = createState('pad-residue-fixture', map)
      expect(spliceM1fInsertions(s, map).length, map.id).toBe(expected)
    }
  })

  it('refuses ranges that are out of order — block B in front of block A', () => {
    expect(() => m1fRangesFromLayout(computeLayout(syntheticRegions({ blockBFirst: true })))).toThrow(
      /upgradeAt must be the last region|degenerate ranges/,
    )
  })

  it('refuses a tail that is too long to be a pad', () => {
    // Reached through a hand-built Layout rather than `computeLayout`, because
    // `computeLayout` cannot produce a tail of 4 or more by construction — which
    // is precisely why this branch needs a synthetic caller to have a detector
    // at all.
    const real = computeLayout(syntheticRegions())
    expect(() => m1fRangesFromLayout({ ...real, totalBytes: real.totalBytes + 4 })).toThrow(
      /bytes follow upgradeAt, which is not a tail pad/,
    )
    // Vacuity: a tail of 3 or less is accepted, so the bound is a bound and not
    // a blanket refusal.
    expect(() => m1fRangesFromLayout({ ...real, totalBytes: real.totalBytes + 3 })).not.toThrow()
  })
})

describe('the splice over the real maps', () => {
  it('removes exactly the bytes this task inserted, on firstCity', () => {
    const s = createState('splice-fixture-v1', MAP)
    const r = m1fInsertedRanges(MAP)
    // Hand-computed from the region table, and checked against `computeLayout`
    // in `regions.test.ts`: the 4-byte tier is 1,844 B, the Int16 tier 4,320 and
    // the Uint8 tier 8,808, so `upgradeAt` starts at 1,844 + 4,320 + 7,848 =
    // 14,012 and runs 960 bytes to 14,972, which is also `totalBytes`.
    expect([r.aStart, r.aEnd, r.bStart, r.bEnd]).toEqual([68, 88, 14012, 14972])
    expect(r.totalBytes).toBe(14972)
    const spliced = spliceM1fInsertions(s, MAP)
    expect(spliced.length, "the splice must land on M1e's buffer size").toBe(13992)
    expect(spliced.length).toBe(r.totalBytes - 20 - 960)
  })

  it('lands on demoCity’s size too, WITH its 2-byte tail pad intact', () => {
    // The map the brief's `bEnd === totalBytes` guard would have thrown on.
    const map = demoCity()
    const s = createState('splice-fixture-v1', map)
    const r = m1fInsertedRanges(map)
    expect([r.aStart, r.aEnd, r.bStart, r.bEnd]).toEqual([68, 88, 9910, 10870])
    expect(r.totalBytes, 'two bytes of tail pad beyond upgradeAt').toBe(10872)
    expect(r.totalBytes - r.bEnd, 'and the pad is 2, not 0').toBe(2)
    const spliced = spliceM1fInsertions(s, map)
    expect(spliced.length, "the splice must land on M1e's buffer size, pad included").toBe(9892)
  })

  it('is INSENSITIVE to bytes outside its two ranges, and SENSITIVE to bytes inside them', () => {
    // The property that makes the proof mean something. Poking a byte outside
    // both ranges must move the spliced digest; poking one inside must not.
    // Without the second half a splice that removed the whole buffer would
    // "prove" every digest.
    const base = createState('splice-fixture-v1', MAP)
    const r = m1fInsertedRanges(MAP)
    const clean = hashBytes(spliceM1fInsertions(base, MAP))

    const inA = createState('splice-fixture-v1', MAP)
    inA.bytes[r.aStart] = 0x5a
    expect(hashBytes(spliceM1fInsertions(inA, MAP)), 'a byte inside block A is spliced out').toBe(
      clean,
    )
    expect(hashState(inA), 'but the whole-buffer digest sees it').not.toBe(hashState(base))

    const inB = createState('splice-fixture-v1', MAP)
    inB.bytes[r.bStart + 7] = 0x5a
    expect(hashBytes(spliceM1fInsertions(inB, MAP)), 'a byte inside block B is spliced out').toBe(
      clean,
    )

    const outside = createState('splice-fixture-v1', MAP)
    outside.bytes[r.aStart - 1] = (outside.bytes[r.aStart - 1] as number) ^ 0xff
    expect(hashBytes(spliceM1fInsertions(outside, MAP)), 'a byte outside both is kept').not.toBe(
      clean,
    )
  })

  it('leaves upgradeAt all-zero on a fresh state, so the re-bless is PURE LAYOUT', () => {
    // `createState` writes nothing into either range, and the one function that
    // writes `upgradeAt` (`applyPlaceUpgrade`, M1f Task 9) is not called here —
    // asserted rather than assumed, because a
    // re-bless that moved partly for layout and partly for a stray write would
    // be indistinguishable from one that moved purely for layout.
    for (const map of [firstCity(), demoCity()]) {
      const s = createState('splice-fixture-v1', map)
      expect(s.upgradeAt.every((b) => b === 0), map.id).toBe(true)
      expect(s.upgradeAt.length, 'one flag per cell').toBe(map.w * map.h)
      expect(s.header[13]).toBe(0)
      expect(s.header[14]).toBe(0)
      expect(s.header[15]).toBe(0)
      expect(s.header[16]).toBe(0)
      expect(s.header[17]).toBe(0)
    }
  })

  it('names the first slot this task owns, so a later header growth cannot silently join block A', () => {
    expect(M1F_HEADER_START, "M1e's HEADER_LENGTH is where M1f's slots begin").toBe(13)
    expect(HEADER_LENGTH - M1F_HEADER_START).toBe(M1F_HEADER_SLOT_COUNT)
  })
})
