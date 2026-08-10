import type { MapData } from '@laneways/shared'
import { computeLayout, type Layout, type LayoutEntry } from '../src/layout'
import { regionsFor } from '../src/regions'
import { HEADER_LENGTH, type GameState } from '../src/state'

/**
 * The M1e Task 1 re-bless proof, in one place, imported by every one of the
 * seven golden sites it licenses.
 *
 * `spliceM1eInsertions` removes the two byte ranges this task INSERTED and
 * returns the remainder, which must hash to the pre-M1e digest bit-for-bit.
 * Ranges are computed from `computeLayout(regionsFor(map))` for THE FIXTURE'S
 * OWN MAP — the seven re-blessed fixtures run on five different maps and
 * quoting one map's offsets at another's site reads as a fabricated
 * derivation.
 *
 * **Two ranges, both MID-BUFFER, and knowing that is the whole proof.**
 *
 *   1. `header` is the THIRD region in the 4-byte tier (`rng`, `mapIdentity`,
 *      `header`, ...), so growing `HEADER_LENGTH` from 9 to 13 inserts 16
 *      bytes *in front of* everything after it. It is not an append.
 *   2. `computeLayout` emits the 4-byte tier, then the 2-byte tier, then the
 *      1-byte tier, so the three new regions — appended to the end of the
 *      4-byte tier — sit in front of `carRouteLen`, not at the end of the
 *      buffer.
 *
 * **Nothing is zeroed and nothing needs to be.** The plan's first draft
 * proposed splicing the inserted bytes out *and zeroing* the two initialised
 * timer slots. `hashBytes` is FNV-1a — `h ^= b; h = imul(h, prime)` — so a
 * zero byte is `h = imul(h, prime)`, which is **not the identity**: zeroing
 * removes the value and leaves the multiply, and the proof would have failed
 * on every fixture for a completely benign change. It is also unnecessary:
 * `createState`'s two initial writes (`H_DEST_SPAWN_TIMER`,
 * `houseSpawnTimer`) both land INSIDE the spliced ranges by construction, so
 * this task's re-bless is **PURE LAYOUT** with no behavioural term at all.
 * That is a stronger claim than "layout plus two named writes", and it is why
 * the splice is blind to those two writes — see the mutation table in the
 * task report: dropping them is caught by `state.test.ts` and NOT here, and
 * that is the point rather than a hole.
 */

/** `HEADER_LENGTH` as M1d closed it. The splice's block A is the difference. */
export const M1D_HEADER_LENGTH = 9

/** The three regions M1e Task 1 declares, in declaration order. */
export const M1E_REGION_NAMES = Object.freeze([
  'houseSpawnTimer',
  'destOvercrowd',
  'destOverTicks',
] as const)

export interface M1eInsertion {
  /** First byte of the four new header slots. */
  readonly aStart: number
  /** One past the last byte of them. */
  readonly aEnd: number
  /** First byte of `houseSpawnTimer`. */
  readonly bStart: number
  /** One past the last byte of `destOverTicks`. */
  readonly bEnd: number
  /** `computeLayout`'s total for this map, AFTER the change. */
  readonly totalBytes: number
}

/**
 * The two inserted ranges for `map` — `m1eRangesFromLayout` over this map's
 * own real layout.
 */
export function m1eInsertedRanges(map: MapData): M1eInsertion {
  return m1eRangesFromLayout(computeLayout(regionsFor(map)))
}

/**
 * The two inserted ranges for an arbitrary layout, with every structural
 * assumption the splice rests on checked rather than assumed. Throws — loudly,
 * named — if any of them stops holding, because a splice that quietly removes
 * the wrong bytes would "prove" a digest that means nothing.
 *
 * **Split out from `m1eInsertedRanges` so the guards are reachable from a
 * SYNTHETIC layout**, which is the only way to test them: on the real region
 * table every guard is satisfied by construction, so deleting all four scores
 * zero detectors and reads exactly like a guard that was never needed. Same
 * construction `packages/game/test/allocationPaths.test.ts` uses to pin its
 * path arithmetic against synthetic checkout roots rather than only against
 * the one it happens to run in. `m1eSplice.test.ts` feeds each violation and
 * asserts the named throw.
 *
 * The scenario the guards exist for, spelled out because it is the one a
 * future shape task will actually reach: a later task declares a region
 * BETWEEN `destOvercrowd` and `destOverTicks`. Block B is derived as
 * `destOverTicks.end - houseSpawnTimer.start`, so it would silently grow to
 * cover the interloper's bytes too, and the splice would then reproduce a
 * prior digest for a state that genuinely changed. The contiguity guard is
 * what turns that into a stop rather than a false proof — and the correct
 * response to it firing is to re-derive `bEnd`, never to relax the guard.
 */
export function m1eRangesFromLayout(layout: Layout): M1eInsertion {
  const { entries, totalBytes } = layout
  const at = (name: string): LayoutEntry => {
    const e = entries.find((x) => x.name === name)
    if (e === undefined) throw new Error(`m1eRangesFromLayout: no region "${name}"`)
    return e
  }
  const bytesOf = (e: LayoutEntry): number => e.len * e.ctor.BYTES_PER_ELEMENT

  // Block A: the four header slots appended to `header`, which is mid-tier.
  const header = at('header')
  if (header.len !== HEADER_LENGTH) {
    throw new Error(`m1eRangesFromLayout: header is ${header.len} slots, expected ${HEADER_LENGTH}`)
  }
  const aStart = header.offset + M1D_HEADER_LENGTH * 4
  const aEnd = header.offset + HEADER_LENGTH * 4

  // Block B: the three new regions, which must be CONTIGUOUS. If a later task
  // ever declares something between them, splicing `bStart..bEnd` would remove
  // that region's bytes too and the proof would be silently wrong.
  const timer = at('houseSpawnTimer')
  const meter = at('destOvercrowd')
  const over = at('destOverTicks')
  if (meter.offset !== timer.offset + bytesOf(timer)) {
    throw new Error('m1eRangesFromLayout: destOvercrowd does not immediately follow houseSpawnTimer')
  }
  if (over.offset !== meter.offset + bytesOf(meter)) {
    throw new Error('m1eRangesFromLayout: destOverTicks does not immediately follow destOvercrowd')
  }
  const bStart = timer.offset
  const bEnd = over.offset + bytesOf(over)

  // Both ranges must be non-empty, disjoint and in order — a no-op or an
  // overlapping splice would reproduce a digest for the wrong reason.
  if (!(aStart < aEnd && aEnd <= bStart && bStart < bEnd && bEnd <= totalBytes)) {
    throw new Error(
      `m1eRangesFromLayout: degenerate ranges A=[${aStart},${aEnd}) B=[${bStart},${bEnd}) of ${totalBytes}`,
    )
  }
  return { aStart, aEnd, bStart, bEnd, totalBytes }
}

/**
 * `s.bytes` with both inserted ranges removed. Hash this and you must get the
 * fixture's pre-M1e digest exactly.
 */
export function spliceM1eInsertions(s: GameState, map: MapData): Uint8Array {
  const { aStart, aEnd, bStart, bEnd } = m1eInsertedRanges(map)
  const src = new Uint8Array(s.buffer)
  const out = new Uint8Array(src.length - (aEnd - aStart) - (bEnd - bStart))
  let w = 0
  for (let i = 0; i < src.length; i++) {
    if (i >= aStart && i < aEnd) continue
    if (i >= bStart && i < bEnd) continue
    out[w++] = src[i] as number
  }
  if (w !== out.length) {
    throw new Error(`spliceM1eInsertions: wrote ${w} of ${out.length} bytes`)
  }
  return out
}
