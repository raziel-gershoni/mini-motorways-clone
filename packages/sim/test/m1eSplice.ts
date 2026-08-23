import type { MapData } from '@laneways/shared'
import { computeLayout, type Layout, type LayoutEntry } from '../src/layout'
import { regionsFor } from '../src/regions'
import { HEADER_LENGTH, type GameState } from '../src/state'
import { m1fRangesFromLayout, type M1fInsertion } from './m1fSplice'

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
 *
 * ---------------------------------------------------------------------------
 * M1f Task 4 (2026-08) — TWO MORE BLOCKS, and why block A had to be frozen
 * ---------------------------------------------------------------------------
 *
 * Reproducing the PRE-M1e digest means removing every byte inserted since M1e
 * opened, not only M1e's own — so when M1f Task 4 grew the header 13 -> 18 and
 * appended `upgradeAt`, this file had to grow with it or the seven digests it
 * licenses would all have gone red at once.
 *
 * Block A used to be `header.offset + M1D_HEADER_LENGTH * 4 ..
 * header.offset + HEADER_LENGTH * 4`, reading the CURRENT length. **That form
 * stays arithmetically correct as the header grows** — the pre-M1e buffer has 9
 * slots, so removing every slot at or above 9 is exactly right, whatever the
 * count. It was frozen at `M1E_HEADER_LENGTH` anyway, for a reason that is about
 * attribution rather than arithmetic: an auto-growing block A silently absorbs
 * every future milestone's slots into a range this file's own prose calls "the
 * four new header slots", and prose that quietly stops describing the code is
 * this project's dominant defect family. `M1D_HEADER_LENGTH` already exists for
 * exactly this reason; `M1E_HEADER_LENGTH` is its sibling.
 *
 * The tripwire that makes the freeze safe is in `m1eSplice.test.ts`:
 * `HEADER_LENGTH === M1E_HEADER_LENGTH + M1F_HEADER_SLOT_COUNT`, which fails by
 * name the day a task grows the header without reading this file. (`M1E_HEADER_LENGTH
 * < HEADER_LENGTH` would NOT — it is satisfied by every future growth, which is
 * the opposite of a tripwire.)
 *
 * **M1f's two ranges are IMPORTED, not restated.** `m1fRangesFromLayout`
 * (`m1fSplice.ts`) owns their derivation and every structural guard on it,
 * including the one the M1f brief got wrong — `upgradeAt` ends at its own last
 * byte and NOT at `totalBytes`, because `demoCity` carries a 2-byte tail pad.
 * A second copy here could disagree with the first, and the way it would
 * disagree is by reproducing a digest that means nothing.
 */

/** `HEADER_LENGTH` as M1d closed it. The splice's block A is the difference. */
export const M1D_HEADER_LENGTH = 9

/** `HEADER_LENGTH` as M1e closed it. M1f's slots are `m1fSplice.ts`'s, not this file's. */
export const M1E_HEADER_LENGTH = 13

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
  /**
   * The two ranges M1f Task 4 inserted, which the composed splice must remove as
   * well to reach the pre-M1e buffer. Imported rather than restated — see the
   * M1f block in this module's header.
   */
  readonly m1f: M1fInsertion
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
  const aEnd = header.offset + M1E_HEADER_LENGTH * 4

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

  // M1f's own two ranges, from the one function that derives them.
  const m1f = m1fRangesFromLayout(layout)

  // All four ranges must be non-empty, disjoint and in ascending buffer order —
  // a no-op or an overlapping splice would reproduce a digest for the wrong
  // reason. The order is: M1e's header slots, M1f's header slots (adjacent to
  // them, which is why `aEnd === m1f.aStart` rather than `<`), M1e's three
  // regions at the end of the 4-byte tier, and finally `upgradeAt` at the end of
  // the buffer.
  if (
    !(
      aStart < aEnd &&
      aEnd === m1f.aStart &&
      m1f.aStart < m1f.aEnd &&
      m1f.aEnd <= bStart &&
      bStart < bEnd &&
      bEnd <= m1f.bStart &&
      m1f.bStart < m1f.bEnd &&
      m1f.bEnd <= totalBytes
    )
  ) {
    throw new Error(
      `m1eRangesFromLayout: degenerate ranges A=[${aStart},${aEnd}) ` +
        `M1F-A=[${m1f.aStart},${m1f.aEnd}) B=[${bStart},${bEnd}) ` +
        `M1F-B=[${m1f.bStart},${m1f.bEnd}) of ${totalBytes}`,
    )
  }
  return { aStart, aEnd, bStart, bEnd, m1f, totalBytes }
}

/**
 * `s.bytes` with both inserted ranges removed. Hash this and you must get the
 * fixture's pre-M1e digest exactly.
 */
export function spliceM1eInsertions(s: GameState, map: MapData): Uint8Array {
  const { aStart, aEnd, bStart, bEnd, m1f } = m1eInsertedRanges(map)
  const src = new Uint8Array(s.buffer)
  const removed =
    aEnd - aStart + (bEnd - bStart) + (m1f.aEnd - m1f.aStart) + (m1f.bEnd - m1f.bStart)
  // **The layout's TAIL PAD is reconstructed, not copied — added at M1f Task 4
  // and it is not a refinement, it is a correction.** `m1f.bEnd` is where the
  // content ends (`upgradeAt` is the last region) and `m1f.padAfter` is the
  // 0..3 alignment bytes after it. The pre-M1e content was `removed` bytes
  // shorter, so its own pad was `(padAfter + removed) mod 4` — the same
  // arithmetic `m1fSplice.ts` documents in full.
  //
  // Copying this layout's pad instead was wrong on a REAL fixture, not a
  // hypothetical one: `rollback.test.ts`'s 6x5 golden has 30 cells, the composed
  // splice removes 16 + 20 + 40 + 30 = 106 bytes, and 106 is not a multiple of 4
  // — so the output came out 2 bytes long and the pre-M1e digest could not
  // reproduce. On `firstCity` (1,144), `demoCity` (1,152) and the 4x4 state
  // golden (92) the removal IS a multiple of 4 and this term is zero, which is
  // exactly why the defect was invisible until the 6x5 fixture ran.
  const padBefore = (m1f.padAfter + removed) % 4
  for (let i = m1f.bEnd; i < m1f.bEnd + m1f.padAfter; i++) {
    if (src[i] !== 0) {
      throw new Error(`spliceM1eInsertions: tail pad byte ${i} is ${src[i]}, not zero`)
    }
  }
  const out = new Uint8Array(m1f.bEnd - removed + padBefore)
  let w = 0
  for (let i = 0; i < m1f.bEnd; i++) {
    if (i >= aStart && i < aEnd) continue
    if (i >= m1f.aStart && i < m1f.aEnd) continue
    if (i >= bStart && i < bEnd) continue
    if (i >= m1f.bStart && i < m1f.bEnd) continue
    out[w++] = src[i] as number
  }
  // `out` is zero-initialised, so the reconstructed pad needs no write — but its
  // LENGTH is the point, and `w` must land exactly `padBefore` short.
  if (w !== out.length - padBefore) {
    throw new Error(`spliceM1eInsertions: wrote ${w} of ${out.length - padBefore} content bytes`)
  }
  return out
}
