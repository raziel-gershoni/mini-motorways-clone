import { expect } from 'vitest'
import type { MapData } from '@laneways/shared'
import { computeLayout, type Layout, type LayoutEntry } from '../src/layout'
import { regionsFor } from '../src/regions'
import {
  HEADER_LENGTH,
  H_INV_UPGRADES,
  H_OFFER_A,
  H_OFFER_B,
  H_OFFER_WEEK,
  H_UPGRADE_COUNT,
  type GameState,
} from '../src/state'

/**
 * The M1f Task 4 re-bless proof, in one place, imported by every one of the
 * golden sites it licenses.
 *
 * `spliceM1fInsertions` removes the two byte ranges this task INSERTED and
 * returns the remainder, which must hash to the pre-M1f digest bit-for-bit.
 * Ranges are computed from `computeLayout(regionsFor(map))` for THE FIXTURE'S
 * OWN MAP — the re-blessed fixtures run on five different maps and quoting one
 * map's offsets at another's site reads as a fabricated derivation.
 *
 * **TWO ranges, not four, and this is the sentence an implementer working from
 * a stale memory needs.** An earlier draft of this milestone sized a metered
 * traffic light here — six regions across all three tiers, so the 4-byte tier
 * and the `Int16` tier each grew a tail as well and the splice had four blocks.
 * Amendment 2 deleted every one of them. There are exactly two:
 *
 *   1. **Block A, a mid-buffer INSERTION.** `header` is the THIRD region in the
 *      4-byte tier (`rng`, `mapIdentity`, `header`, ...), so growing
 *      `HEADER_LENGTH` from 13 to 18 inserts 20 bytes *in front of* everything
 *      after it.
 *   2. **Block B, a true APPEND.** `upgradeAt` is the last region of the last
 *      tier, which is the end of the buffer.
 *
 * **Nothing is zeroed and nothing needs to be**, for the reason `m1eSplice.ts`
 * gives at length: `hashBytes` is FNV-1a, so a zero byte is `h = imul(h, prime)`
 * and NOT the identity — zeroing would break the proof on every fixture for a
 * benign change. It is also unnecessary here in the strongest possible sense:
 * `createState` writes nothing into either range, so this task's re-bless is
 * **PURE LAYOUT with no behavioural term at all**, and `upgradeAt` is all-zero
 * on every fixture because no code writes it until M1f Task 9.
 *
 * ---------------------------------------------------------------------------
 * THE TAIL PAD, and why the brief's guard for it was wrong
 * ---------------------------------------------------------------------------
 *
 * The task brief specified block B as `upgradeAt.offset .. totalBytes`, with a
 * structural guard that "the tail range runs to `totalBytes` exactly, with no
 * trailing pad". **That is false on `demoCity` and would throw there**, which
 * matters because the demo golden is one of the digests this file licenses.
 * Measured against the real `computeLayout`: `demoCity`'s last region ends at
 * 10,870 of 10,872 — a 2-byte tail pad, present both before and after this
 * change, because its 4-byte tier is 824 B and its Uint8 tier 6,042. And the
 * splice would have been wrong as well as loud: removing 962 bytes instead of
 * 960 lands on 9,890 rather than the pre-M1f total of 9,892, so the digest
 * would not reproduce.
 *
 * So block B ends at `upgradeAt`'s own last byte, and the tail pad is handled
 * explicitly rather than assumed away.
 *
 * **And it has to be handled, because a real golden fixture needs it.** The
 * first version of this file threw unless the splice removed a whole number of
 * 4-byte words — true on `firstCity` (20 + 960), on `demoCity` (20 + 960) and on
 * the 4x4 state golden (20 + 16), and **false on `rollback.test.ts`'s 6x5
 * fixture**, which has 30 cells and removes 50. There the pre-M1f layout's tail
 * pad and the post-M1f layout's are genuinely different, so no pure removal of
 * bytes can reproduce the prior buffer.
 *
 * The splice therefore reconstructs the prior tail rather than copying this
 * one's. The pad is `(-content) mod 4`, so with `content_after = bEnd` and
 * `removed` bytes taken out:
 *
 *     padBefore = (padAfter + removed) mod 4
 *
 * and the output is `bEnd - removed + padBefore` bytes. **That is exact rather
 * than approximate, and it is checked rather than argued**: pad bytes are
 * written by nothing and zero-initialised by `new ArrayBuffer`, and
 * `spliceM1fInsertions` asserts every one of them really is zero before
 * discarding it. What is still guarded by a throw is the assumption that makes
 * `content_after = bEnd` true at all — that the layout has no INTERIOR padding —
 * because interior padding would move under the splice in a way this arithmetic
 * cannot see.
 */

/** `HEADER_LENGTH` as M1e closed it — the first slot this task owns. */
export const M1F_HEADER_START = 13

/** The one region M1f Task 4 declares. */
export const M1F_REGION_NAME = 'upgradeAt'

/** How many header slots M1f Task 4 adds. `m1eSplice.test.ts` checks this against both lengths. */
export const M1F_HEADER_SLOT_COUNT = 5

export interface M1fInsertion {
  /** First byte of the five new header slots. */
  readonly aStart: number
  /** One past the last byte of them. */
  readonly aEnd: number
  /** First byte of `upgradeAt`. */
  readonly bStart: number
  /** One past the last byte of `upgradeAt` — NOT `totalBytes`; see the tail-pad note above. */
  readonly bEnd: number
  /** Tail pad bytes in THIS layout: `totalBytes - bEnd`, always 0..3. */
  readonly padAfter: number
  /** Tail pad bytes the PRE-M1f layout had, reconstructed by the splice. */
  readonly padBefore: number
  /** `computeLayout`'s total for this map, AFTER the change. */
  readonly totalBytes: number
}

/** The two inserted ranges for `map`, over this map's own real layout. */
export function m1fInsertedRanges(map: MapData): M1fInsertion {
  return m1fRangesFromLayout(computeLayout(regionsFor(map)))
}

/**
 * The two inserted ranges for an arbitrary layout, with every structural
 * assumption the splice rests on checked rather than assumed. Throws — loudly,
 * named — if any of them stops holding, because a splice that quietly removes
 * the wrong bytes would "prove" a digest that means nothing.
 *
 * **Split out from `m1fInsertedRanges` so the guards are reachable from a
 * SYNTHETIC layout**, which is the only way to test them: on the real region
 * table every guard is satisfied by construction, so deleting all of them scores
 * zero detectors and reads exactly like a guard that was never needed.
 * `m1fSplice.test.ts` feeds each violation and asserts the named throw.
 */
export function m1fRangesFromLayout(layout: Layout): M1fInsertion {
  const { entries, totalBytes } = layout
  const at = (name: string): LayoutEntry => {
    const e = entries.find((x) => x.name === name)
    if (e === undefined) throw new Error(`m1fRangesFromLayout: no region "${name}"`)
    return e
  }
  const bytesOf = (e: LayoutEntry): number => e.len * e.ctor.BYTES_PER_ELEMENT

  // Block A: the five header slots appended to `header`, which is mid-tier.
  const header = at('header')
  if (header.len !== HEADER_LENGTH) {
    throw new Error(`m1fRangesFromLayout: header is ${header.len} slots, expected ${HEADER_LENGTH}`)
  }
  const aStart = header.offset + M1F_HEADER_START * 4
  const aEnd = header.offset + HEADER_LENGTH * 4

  // Block B: `upgradeAt`, which must be the LAST entry of the layout. If a later
  // task appends anything after it, `bEnd` stops being the end of the appended
  // region set and the splice removes the wrong bytes.
  const upgrade = at(M1F_REGION_NAME)
  const last = entries[entries.length - 1]
  if (last === undefined || last.name !== M1F_REGION_NAME) {
    throw new Error(
      `m1fRangesFromLayout: ${M1F_REGION_NAME} must be the last region, but "${last?.name}" is`,
    )
  }
  const bStart = upgrade.offset
  const bEnd = upgrade.offset + bytesOf(upgrade)

  // Anything past `bEnd` must be the layout's own tail PAD and nothing else — at
  // most three bytes, since `computeLayout` rounds up to a 4-byte alignment.
  const padAfter = totalBytes - bEnd
  if (padAfter < 0 || padAfter >= 4) {
    throw new Error(
      `m1fRangesFromLayout: ${padAfter} bytes follow ${M1F_REGION_NAME}, which is not a tail pad`,
    )
  }

  // **The assumption the pad arithmetic rests on: no INTERIOR padding.** With
  // none, the content runs unbroken from 0 to `bEnd` and the pre-M1f content
  // length is exactly `bEnd - removed`, which is what makes `padBefore`
  // computable. An interior pad would shift under the splice in a way this
  // cannot see, so it is a throw rather than a correction term.
  let declared = 0
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as LayoutEntry
    declared += bytesOf(e)
  }
  if (declared !== bEnd) {
    throw new Error(
      `m1fRangesFromLayout: layout has ${bEnd - declared} bytes of INTERIOR padding, ` +
        'which the pre-M1f pad reconstruction cannot account for',
    )
  }

  // The pre-M1f layout's own tail pad. See the tail-pad note in this module's
  // header — `rollback.test.ts`'s 6x5 fixture removes 50 bytes and genuinely
  // needs this, which is why the first version of this guard (a throw unless
  // `removed % 4 === 0`) was wrong rather than merely strict.
  const removed = aEnd - aStart + (bEnd - bStart)
  const padBefore = (padAfter + removed) % 4

  // Both ranges must be non-empty, disjoint and in order — a no-op or an
  // overlapping splice would reproduce a digest for the wrong reason.
  if (!(aStart < aEnd && aEnd <= bStart && bStart < bEnd && bEnd <= totalBytes)) {
    throw new Error(
      `m1fRangesFromLayout: degenerate ranges A=[${aStart},${aEnd}) B=[${bStart},${bEnd}) of ${totalBytes}`,
    )
  }
  return { aStart, aEnd, bStart, bEnd, padAfter, padBefore, totalBytes }
}

/**
 * `s.bytes` with both inserted ranges removed. Hash this and you must get the
 * fixture's pre-M1f digest exactly.
 */
export function spliceM1fInsertions(s: GameState, map: MapData): Uint8Array {
  const { aStart, aEnd, bStart, bEnd, padAfter, padBefore } = m1fInsertedRanges(map)
  const src = new Uint8Array(s.buffer)
  // This layout's own tail pad is DISCARDED and the prior one reconstructed —
  // and the discard is checked rather than assumed. Pad bytes are written by
  // nothing and zero-initialised by `new ArrayBuffer`, so a non-zero one means
  // some region is longer than the layout says and real state is about to be
  // thrown away.
  for (let i = bEnd; i < bEnd + padAfter; i++) {
    if (src[i] !== 0) {
      throw new Error(`spliceM1fInsertions: tail pad byte ${i} is ${src[i]}, not zero`)
    }
  }
  const removed = aEnd - aStart + (bEnd - bStart)
  const out = new Uint8Array(bEnd - removed + padBefore)
  let w = 0
  for (let i = 0; i < bEnd; i++) {
    if (i >= aStart && i < aEnd) continue
    if (i >= bStart && i < bEnd) continue
    out[w++] = src[i] as number
  }
  // `out` is zero-initialised, so the reconstructed pad needs no write — but its
  // LENGTH is the whole point, and `w` must land exactly `padBefore` short.
  if (w !== out.length - padBefore) {
    throw new Error(`spliceM1fInsertions: wrote ${w} of ${out.length - padBefore} content bytes`)
  }
  return out
}

/**
 * The DIRECT assertions every M1f re-bless site carries beside its digest.
 *
 * **A digest is never the only evidence on this project**, and for a PURE LAYOUT
 * move the evidence has a precise shape: the six things this task inserted must
 * all be at their zero-initialised values, and everything else must be
 * byte-identical to before — which is what the splice proof beside this call
 * establishes. Together they say "the buffer grew by exactly these bytes, those
 * bytes are all zero, and not one pre-existing byte moved in value".
 *
 * **One function with nine callers rather than nine copies**, for the reason the
 * catalogue gives about a rule stated twice: nine hand-written copies can
 * disagree with each other and with the shape they check, and the way they would
 * disagree is by one site quietly dropping the slot a regression landed in.
 *
 * It takes `map` rather than reading `s.upgradeAt.length`, so a state built on
 * the wrong map fails here rather than passing a self-consistent check.
 */
export function assertM1fShapeIsPureLayout(s: GameState, map: MapData): void {
  // The five header slots. Zero is `CARD_NONE` for the two card slots, "resolved
  // through week 0" for `H_OFFER_WEEK`, and an empty hand and an empty board for
  // the two upgrade counters — so `createState` writes none of them.
  expect(s.header[H_OFFER_A], 'H_OFFER_A must be CARD_NONE').toBe(0)
  expect(s.header[H_OFFER_B], 'H_OFFER_B must be CARD_NONE').toBe(0)
  expect(s.header[H_OFFER_WEEK], 'H_OFFER_WEEK must be week 0').toBe(0)
  expect(s.header[H_INV_UPGRADES], 'no upgrade is held yet').toBe(0)
  expect(s.header[H_UPGRADE_COUNT], 'and none is placed').toBe(0)
  expect(s.header.length, 'the header is HEADER_LENGTH slots wide').toBe(HEADER_LENGTH)
  // The one region: one FLAG per cell, all clear. Length against the MAP, so a
  // per-lane or `MAX_UPGRADES`-long region fails here and not only in the digest.
  expect(s.upgradeAt.length, 'one flag per cell').toBe(map.w * map.h)
  expect(
    s.upgradeAt.every((b) => b === 0),
    'every cell still under the junction mutual-exclusion rule',
  ).toBe(true)
  // And the buffer really is the size the region table says, on THIS map — the
  // check that catches a view built over a stale layout.
  expect(s.buffer.byteLength).toBe(computeLayout(regionsFor(map)).totalBytes)
}
