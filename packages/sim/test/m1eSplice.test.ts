import { describe, it, expect } from 'vitest'
import { firstCity } from '@laneways/shared'
import { computeLayout, type Region } from '../src/layout'
import { regionsFor } from '../src/regions'
import { createState, hashState, HEADER_LENGTH } from '../src/state'
import { hashBytes } from '../src/hash'
import {
  m1eInsertedRanges,
  m1eRangesFromLayout,
  spliceM1eInsertions,
  M1D_HEADER_LENGTH,
  M1E_HEADER_LENGTH,
  M1E_REGION_NAMES,
} from './m1eSplice'
import { M1F_HEADER_SLOT_COUNT, M1F_REGION_NAME } from './m1fSplice'

/**
 * The re-bless proof's own tests.
 *
 * Seven golden sites depend on `m1eSplice.ts` being right, and on the real
 * region table **every one of its structural guards is satisfied by
 * construction** — so deleting all four leaves the whole 1,600-test suite
 * green, which is indistinguishable from a guard that was never needed. This
 * file feeds SYNTHETIC layouts that violate each assumption in turn, in the
 * same style `packages/game/test/allocationPaths.test.ts` uses to pin path
 * arithmetic against synthetic checkout roots rather than only the one it
 * happens to run in.
 *
 * The scenario every one of these guards exists for: a later shape task
 * declares a region between two of M1e's three, hits a guard, **relaxes the
 * guard rather than re-deriving `bEnd`**, and the splice then removes the
 * interloper's bytes as well — reproducing a prior digest for a state that
 * genuinely changed. That is a false proof licensing a real regression, which
 * is strictly worse than no proof at all.
 */

const MAP = firstCity()

/**
 * A synthetic region list with the same SHAPE as the real one — the two
 * regions before `header`, `header` itself, one filler in between, then M1e's
 * three contiguous, then a following region — at deliberately small sizes.
 *
 * Hand-declared rather than derived from `regionsFor`, for the reason
 * `state.test.ts`'s layout-wiring block already gives: a fixture built from
 * the table under test agrees with any bug in that table.
 */
function syntheticRegions(over: Partial<{
  headerLen: number
  /** Inserted between `houseSpawnTimer` and `destOvercrowd`. */
  interloperBeforeMeter: boolean
  /** Inserted between `destOvercrowd` and `destOverTicks`. */
  interloperBeforeOverTicks: boolean
  /** Drop `houseSpawnTimer` entirely. */
  dropTimer: boolean
  /** Declare M1e's three BEFORE `header`, so block B precedes block A. */
  blockBFirst: boolean
}> = {}): Region[] {
  const headerLen = over.headerLen ?? HEADER_LENGTH
  const three: Region[] = [
    { name: 'houseSpawnTimer', ctor: Int32Array, len: 5 },
    ...(over.interloperBeforeMeter
      ? [{ name: 'interloperA', ctor: Int32Array, len: 3 } as Region]
      : []),
    { name: 'destOvercrowd', ctor: Int32Array, len: 16 },
    ...(over.interloperBeforeOverTicks
      ? [{ name: 'interloperB', ctor: Int32Array, len: 3 } as Region]
      : []),
    { name: 'destOverTicks', ctor: Int32Array, len: 16 },
  ]
  const kept = over.dropTimer ? three.filter((r) => r.name !== 'houseSpawnTimer') : three
  const head: Region[] = [
    { name: 'rng', ctor: Uint32Array, len: 1 },
    { name: 'mapIdentity', ctor: Int32Array, len: 3 },
  ]
  const header: Region = { name: 'header', ctor: Int32Array, len: headerLen }
  const filler: Region = { name: 'carTargetDest', ctor: Int32Array, len: 7 }
  const tail: Region = { name: 'carRouteLen', ctor: Int16Array, len: 7 }
  // **M1f Task 4: the synthetic layout has to carry `upgradeAt` too**, because
  // `m1eRangesFromLayout` now composes `m1fRangesFromLayout` rather than
  // restating M1f's two ranges. Length 12 so the composed splice removes
  // 16 + 20 + 148 + 12 = 196 bytes, a multiple of 4 — the condition
  // `m1fSplice.ts` guards and `m1fSplice.test.ts` feeds a violation of.
  const upgrade: Region = { name: M1F_REGION_NAME, ctor: Uint8Array, len: 12 }
  return over.blockBFirst
    ? [...head, ...kept, header, filler, tail, upgrade]
    : [...head, header, filler, ...kept, tail, upgrade]
}

describe('the splice helper accepts a well-formed layout', () => {
  it('derives the two ranges from a synthetic layout, and the fixture is one the guards pass', () => {
    // Vacuity for the whole file: if the well-formed builder itself threw,
    // every "it throws" test below would pass for the wrong reason.
    const r = m1eRangesFromLayout(computeLayout(syntheticRegions()))
    // rng(4) + mapIdentity(12) puts `header` at 16, so block A is always
    // [16 + 9*4, 16 + 13*4) = [52, 68) on any layout of this shape — the same
    // range every one of the seven real fixtures reports.
    expect([r.aStart, r.aEnd]).toEqual([52, 68])
    // Block B: header is now 18 slots and ends at 88, filler is 7 Int32 = 28 B,
    // so B starts at 116 and runs 5 + 16 + 16 = 37 Int32 = 148 B. **The +20 is
    // M1f Task 4's five header slots**, which sit between block A and block B
    // and are removed by `m1f.a` rather than by either of M1e's own ranges.
    expect([r.bStart, r.bEnd]).toEqual([116, 264])
    expect(r.bEnd - r.bStart).toBe(148)
    // M1f's two, imported rather than restated. Its block A is ADJACENT to
    // M1e's — [52, 68) then [68, 88) — which is why the ordering guard demands
    // `aEnd === m1f.aStart` rather than merely `<=`.
    expect([r.m1f.aStart, r.m1f.aEnd]).toEqual([68, 88])
    expect(r.m1f.aStart, 'the two header blocks are contiguous').toBe(r.aEnd)
    expect(r.m1f.bEnd - r.m1f.bStart, 'the whole of upgradeAt').toBe(12)
  })

  it('names the M1D header length and the three regions as constants, not as inline literals', () => {
    // `M1D_HEADER_LENGTH` is what makes block A a DIFFERENCE rather than a
    // guess. If it ever equalled `HEADER_LENGTH` the block would be empty and
    // the degenerate-range guard is what would catch it (below).
    expect(M1D_HEADER_LENGTH).toBe(9)
    expect(M1E_HEADER_LENGTH).toBe(13)
    expect(HEADER_LENGTH).toBe(18)
    expect(M1D_HEADER_LENGTH).toBeLessThan(M1E_HEADER_LENGTH)
    // **The tripwire that makes freezing block A's upper bound safe, and it is
    // an EQUALITY on purpose.** M1f Task 4 grew the header 13 -> 18 and block A
    // was frozen at `M1E_HEADER_LENGTH` so this file's prose keeps describing
    // what it removes; the composed splice then relies on M1f's own block
    // covering slots 13..18. The brief proposed `M1E_HEADER_LENGTH <
    // HEADER_LENGTH` for this job — which is satisfied by EVERY future growth
    // and is therefore not a tripwire at all. This one fails by name the day a
    // task adds a slot without adding a block.
    expect(
      M1E_HEADER_LENGTH + M1F_HEADER_SLOT_COUNT,
      'a task grew HEADER_LENGTH without giving its slots a splice block',
    ).toBe(HEADER_LENGTH)
    expect(Array.from(M1E_REGION_NAMES)).toEqual([
      'houseSpawnTimer',
      'destOvercrowd',
      'destOverTicks',
    ])
  })
})

describe('the splice helper refuses a layout its arithmetic would silently misread', () => {
  it('throws when `header` is not HEADER_LENGTH slots', () => {
    // Both directions: a header still at M1d's 9 slots (the change never
    // landed) and a header grown past 13 (a later task added a slot and did
    // not re-derive block A). Under a short header, block A would run PAST the
    // region and eat the next one's bytes.
    expect(() => m1eRangesFromLayout(computeLayout(syntheticRegions({ headerLen: 9 })))).toThrow(
      /header is 9 slots, expected 18/,
    )
    expect(() => m1eRangesFromLayout(computeLayout(syntheticRegions({ headerLen: 19 })))).toThrow(
      /header is 19 slots, expected 18/,
    )
  })

  it('throws when a region is declared between houseSpawnTimer and destOvercrowd', () => {
    expect(() =>
      m1eRangesFromLayout(computeLayout(syntheticRegions({ interloperBeforeMeter: true }))),
    ).toThrow(/destOvercrowd does not immediately follow houseSpawnTimer/)
  })

  it('throws when a region is declared between destOvercrowd and destOverTicks', () => {
    expect(() =>
      m1eRangesFromLayout(computeLayout(syntheticRegions({ interloperBeforeOverTicks: true }))),
    ).toThrow(/destOverTicks does not immediately follow destOvercrowd/)
  })

  it('the contiguity guard is load-bearing: without it block B would over-remove by exactly the interloper', () => {
    // The guard's VALUE, not just its presence. `bEnd - bStart` is derived as
    // `destOverTicks.end - houseSpawnTimer.start`, so an interloper inside that
    // span is swept up silently. This computes what the relaxed splice would
    // have removed and shows it exceeds the three regions' own bytes — which
    // is the difference between "reproduces the prior digest" and "reproduces
    // a digest for a state that genuinely changed".
    const layout = computeLayout(syntheticRegions({ interloperBeforeOverTicks: true }))
    const at = (n: string) => layout.entries.find((e) => e.name === n)!
    const naiveStart = at('houseSpawnTimer').offset
    const naiveEnd = at('destOverTicks').offset + 16 * 4
    const ownBytes = (5 + 16 + 16) * 4
    expect(naiveEnd - naiveStart).toBe(ownBytes + 3 * 4) // the interloper, swept up
    expect(naiveEnd - naiveStart).toBeGreaterThan(ownBytes)
  })

  it('throws when one of the three regions is missing entirely', () => {
    expect(() => m1eRangesFromLayout(computeLayout(syntheticRegions({ dropTimer: true })))).toThrow(
      /no region "houseSpawnTimer"/,
    )
  })

  it('throws when block B precedes block A instead of following it', () => {
    // The three regions declared BEFORE `header`, which pushes `header` to
    // offset 164 and block A to [200, 216) while block B stays at [16, 164).
    // Both ranges are individually well-formed and the copy loop would run
    // happily; the ORDER is the only thing wrong, and the loop assumes A first.
    expect(() => m1eRangesFromLayout(computeLayout(syntheticRegions({ blockBFirst: true })))).toThrow(
      /degenerate ranges A=\[200,216\) M1F-A=\[216,236\) B=\[16,164\)/,
    )
  })
})

describe('spliceM1eInsertions removes exactly the two ranges and nothing else', () => {
  it('produces the bytes outside both ranges, in order, on a real state', () => {
    const s = createState('m1e-splice-selftest', MAP)
    const r = m1eInsertedRanges(MAP)
    const src = new Uint8Array(s.buffer)
    const out = spliceM1eInsertions(s, MAP)

    // **FOUR ranges as of M1f Task 4**, in ascending buffer order: M1e's header
    // slots, M1f's header slots (adjacent), M1e's three regions, and
    // `upgradeAt` at the very end. 16 + 20 + 148 + 960 = 1,144.
    const removed =
      r.aEnd - r.aStart + (r.m1f.aEnd - r.m1f.aStart) + (r.bEnd - r.bStart) + (r.m1f.bEnd - r.m1f.bStart)
    expect(removed).toBe(1144)
    expect(out.length).toBe(src.length - removed)
    expect(out.length).toBe(13828) // M1d's own total for firstCity

    // Rebuilt independently of the helper's copy loop, by concatenating the
    // surviving spans — so a loop that dropped or duplicated a byte at a
    // boundary fails here rather than only showing up as a wrong digest.
    const spans: Array<[number, number]> = [
      [0, r.aStart],
      [r.m1f.aEnd, r.bStart],
      [r.bEnd, r.m1f.bStart],
      [r.m1f.bEnd, src.length],
    ]
    const expected = new Uint8Array(out.length)
    let w = 0
    for (const [from, to] of spans) {
      expected.set(src.subarray(from, to), w)
      w += to - from
    }
    expect(w, 'the four surviving spans account for every kept byte').toBe(out.length)
    expect(Array.from(out)).toEqual(Array.from(expected))

    // The boundary byte named directly: position `aStart` in the output must be
    // whatever followed the two adjacent header blocks in the source.
    expect(out[r.aStart]).toBe(src[r.m1f.aEnd])
  })

  it('is blind to the two initial timer writes, and that is what makes the re-bless PURE LAYOUT', () => {
    // The most important property in this file, and the one that looks like a
    // hole. `createState` arms `H_DEST_SPAWN_TIMER` and `houseSpawnTimer`, and
    // BOTH land inside the spliced ranges — so the splice cannot see them, and
    // the pre-M1e digest it reproduces carries no behavioural term at all.
    // Dropping those two writes is caught by `state.test.ts`'s fresh-state
    // test, by name, and deliberately not here. Recorded as a test so nobody
    // "fixes" the blindness later.
    const armed = createState('m1e-splice-armed', MAP)
    const bare = createState('m1e-splice-armed', MAP)
    bare.header[11] = 0 // H_DEST_SPAWN_TIMER, zeroed by hand
    bare.houseSpawnTimer.fill(0)

    expect(hashState(armed), 'the two states differ in the full buffer').not.toBe(hashState(bare))
    expect(
      hashBytes(spliceM1eInsertions(armed, MAP)),
      'and are identical once the inserted ranges are removed',
    ).toBe(hashBytes(spliceM1eInsertions(bare, MAP)))
  })

  it('reports the real firstCity ranges, which are what the golden sites quote', () => {
    const r = m1eInsertedRanges(MAP)
    // **Re-derived at M1f Task 4: block B moved 1,676 -> 1,696 and the total
    // 13,992 -> 14,972**, both for M1f's own insertions and neither for anything
    // M1e did. Block A is unmoved because `header` still starts at 16.
    expect([r.aStart, r.aEnd, r.bStart, r.bEnd]).toEqual([52, 68, 1696, 1844])
    expect([r.m1f.aStart, r.m1f.aEnd, r.m1f.bStart, r.m1f.bEnd]).toEqual([68, 88, 14012, 14972])
    expect(r.totalBytes).toBe(14972)
    // Block B is sized by colours and destinations, never by cells — which is
    // why `demoCity` splices 156 B and the two 2-colour fixtures splice 40.
    expect(r.bEnd - r.bStart).toBe((MAP.groupCount + 2 * MAP.maxDestinations) * 4)
    expect(computeLayout(regionsFor(MAP)).totalBytes).toBe(r.totalBytes)
  })
})
