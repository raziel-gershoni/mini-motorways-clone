import { describe, it, expect } from 'vitest'
import { DIAG_COST, ORTHO_COST } from '@laneways/shared'
import { DIR_COUNT } from '../src/roads'
import { edgeCost } from '../src/graph'
import {
  INF,
  NB,
  DISTINCT_EDGE_COSTS,
  ST_EXPANSIONS,
  ST_PUSHES,
  CT_SYNCS,
  CT_REBUILDS,
  CUR_TOP,
  CUR_PENDING,
  createFlowField,
  createFlowFields,
  createScratch,
  entryPoolCapacity,
  assertBucketCountExceedsEveryEdgeCost,
  assertPushWithinBucketWindow,
  edgeCostMask,
} from '../src/scratch'

describe('createFlowField / createFlowFields', () => {
  it('allocates dist/dir sized to cells, starting stamps at 0', () => {
    const f = createFlowField(37)
    expect(f.dist.length).toBe(37)
    expect(f.dir.length).toBe(37)
    expect(f.dist).toBeInstanceOf(Int32Array)
    expect(f.dir).toBeInstanceOf(Int8Array)
    expect(f.builtFromFieldInputs).toBe(0)
    expect(f.builtFromSources).toBe(0)
  })

  it('createFlowFields allocates `colours` independent fields, each sized to cells', () => {
    const fields = createFlowFields(5, 12)
    expect(fields.length).toBe(5)
    for (const f of fields) {
      expect(f.dist.length).toBe(12)
      expect(f.dir.length).toBe(12)
    }
    // Independence: writing into one field's arrays must not alias another's.
    fields[0]!.dist[0] = 999
    expect(fields[1]!.dist[0]).toBe(0)
  })
})

describe('createScratch: allocation', () => {
  it('allocates bucketHead sized NB, nbrCell/nbrDir sized 8, stats sized for both counters', () => {
    const s = createScratch(10, 2, 3, new Int32Array(0))
    expect(s.bucketHead.length).toBe(NB)
    expect(s.nbrCell.length).toBe(8)
    expect(s.nbrDir.length).toBe(8)
    expect(s.nbrCell).toBeInstanceOf(Int32Array)
    expect(s.nbrDir).toBeInstanceOf(Int8Array)
    expect(s.stats.length).toBeGreaterThan(Math.max(ST_EXPANSIONS, ST_PUSHES))
  })

  it('sizes entryCell/entryNext to entryPoolCapacity(cells)', () => {
    const s = createScratch(20, 2, 3, new Int32Array(0))
    expect(s.entryCell.length).toBe(entryPoolCapacity(20))
    expect(s.entryNext.length).toBe(entryPoolCapacity(20))
  })

  it('sizes pushesPerCell to cells, reset (all zero) on a fresh scratch', () => {
    const s = createScratch(20, 2, 3, new Int32Array(0))
    expect(s.pushesPerCell.length).toBe(20)
    expect(Array.from(s.pushesPerCell).every((v) => v === 0)).toBe(true)
  })

  it('sizes sourcesFlat to groupCount * maxDestinations, sourceCounts and slotCounts to groupCount', () => {
    const s = createScratch(20, 3, 7, new Int32Array(0))
    expect(s.sourcesFlat.length).toBe(3 * 7)
    expect(s.sourceCounts.length).toBe(3)
    expect(s.slotCounts.length).toBe(3)
  })

  it('sizes counters to hold CT_SYNCS and CT_REBUILDS, both starting at 0', () => {
    const s = createScratch(20, 2, 3, new Int32Array(0))
    expect(s.counters.length).toBeGreaterThan(Math.max(CT_SYNCS, CT_REBUILDS))
    expect(s.counters[CT_SYNCS]).toBe(0)
    expect(s.counters[CT_REBUILDS]).toBe(0)
  })

  it('sizes cursor to hold CUR_TOP and CUR_PENDING, both starting at 0, and the two are DISTINCT slots', () => {
    const s = createScratch(20, 2, 3, new Int32Array(0))
    expect(s.cursor).toBeInstanceOf(Int32Array)
    expect(s.cursor.length).toBeGreaterThan(Math.max(CUR_TOP, CUR_PENDING))
    expect(s.cursor[CUR_TOP]).toBe(0)
    expect(s.cursor[CUR_PENDING]).toBe(0)
    // Asserted explicitly rather than left implied by the two reads above,
    // which are satisfied by a single slot addressed twice: `push` bumps the
    // pool's write pointer AND the drain counter, so aliasing them makes every
    // push count as a drain and the queue empties itself. Both reads are 0 on
    // a fresh scratch either way, so nothing else here can see the collapse.
    expect(CUR_TOP).not.toBe(CUR_PENDING)
  })

  it('stores fieldInputRanges as given, not recomputed', () => {
    const ranges = Int32Array.from([4, 12, 40, 4])
    const s = createScratch(20, 2, 3, ranges)
    expect(s.fieldInputRanges).toBe(ranges) // same reference: never recomputed inside createScratch
  })
})

describe('entryPoolCapacity', () => {
  it('equals cells * 3 today, derived from DISTINCT_EDGE_COSTS rather than a literal', () => {
    expect(DISTINCT_EDGE_COSTS).toBe(2)
    expect(entryPoolCapacity(50)).toBe(150)
    expect(entryPoolCapacity(50)).toBe(50 * (1 + DISTINCT_EDGE_COSTS))
  })
})

describe('DISTINCT_EDGE_COSTS linkage', () => {
  // Neither `graph.test.ts`'s `expect(values.size).toBe(2)` nor this file's
  // own `expect(DISTINCT_EDGE_COSTS).toBe(2)` above ties the two literals
  // TOGETHER — both pass unchanged if a third edge-cost tier is added and
  // only ONE of the two literals is bumped. This test computes the real
  // distinct-value count from `edgeCost` itself and compares it against the
  // constant directly, so "add a tier, forget to bump DISTINCT_EDGE_COSTS"
  // fails here even though it would leave both literal-pinned tests green.
  it('DISTINCT_EDGE_COSTS equals the number of distinct values edgeCost(k) actually returns', () => {
    const values = new Set<number>()
    for (let k = 0; k < DIR_COUNT; k++) values.add(edgeCost(k))
    expect(DISTINCT_EDGE_COSTS).toBe(values.size)
  })
})

describe('createScratch: invariant guards', () => {
  // Proven with a doctored input, not by asserting today's real NB/DIAG_COST
  // happen to be safe — see assertBucketCountExceedsEveryEdgeCost's own
  // comment for why the check is exposed as a separate parameterised
  // function rather than only reachable by mutating a module constant.
  it('assertBucketCountExceedsEveryEdgeCost throws when nb does not exceed some edgeCost(k)', () => {
    // DIAG_COST is itself edgeCost's maximum return value, so nb === DIAG_COST
    // must fail the "nb > edgeCost(k)" invariant at the diagonal directions.
    expect(() => assertBucketCountExceedsEveryEdgeCost(DIAG_COST, DIR_COUNT, edgeCost)).toThrow()
  })

  it('assertBucketCountExceedsEveryEdgeCost does not throw for the real NB', () => {
    expect(() => assertBucketCountExceedsEveryEdgeCost(NB, DIR_COUNT, edgeCost)).not.toThrow()
  })

  it('NB is exactly one more than the largest real edge cost (DIAG_COST)', () => {
    // Pins NB's relationship to the real constants, so a mutation to either
    // NB or DIAG_COST that breaks "NB === DIAG_COST + 1" is caught here even
    // though both individually still satisfy "NB > every edgeCost(k)".
    expect(NB).toBe(DIAG_COST + 1)
    expect(NB).toBeGreaterThan(ORTHO_COST)
  })

  it('createScratch throws when cells * DIAG_COST >= INF, proven with a doctored (huge) cells rather than trusting realistic boards are safe', () => {
    // The smallest `cells` for which cells * DIAG_COST >= INF. The guard
    // must fire before any allocation, so this must not attempt to build
    // arrays of this size — createScratch is expected to throw immediately.
    const hugeCells = Math.ceil(INF / DIAG_COST)
    expect(hugeCells * DIAG_COST).toBeGreaterThanOrEqual(INF)
    expect(() => createScratch(hugeCells, 2, 3, new Int32Array(0))).toThrow()
  })

  it('createScratch does not throw for a realistic board size', () => {
    expect(() => createScratch(24 * 40, 5, 16, new Int32Array(0))).not.toThrow()
  })
})

describe('INF', () => {
  it('INF + DIAG_COST is a positive Int32', () => {
    const v = (INF + DIAG_COST) | 0
    expect(v).toBe(INF + DIAG_COST)
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThanOrEqual(0x7fffffff)
  })
})

/**
 * The mask `computeFlowField` builds on every rebuild. Computed here the same
 * way it is computed there — from `edgeCost`, inside a function — rather than
 * imported as a constant, because a module-scope derivation reads `DIR_COUNT` as
 * `undefined` through the roads/dispatch/scratch import cycle. See
 * `edgeCostMask`'s own comment; the guard for that is asserted below.
 */
const LEGAL_EDGE_COST_MASK = edgeCostMask(DIR_COUNT, edgeCost)

describe('edgeCostMask', () => {
  it('is derived from edgeCost, not written out: {10, 14} today', () => {
    expect(LEGAL_EDGE_COST_MASK).toBe((1 << ORTHO_COST) | (1 << DIAG_COST))
    // Spelled out once, so a tier added to `edgeCost` without a thought about
    // this mask fails here rather than widening the membership test silently.
    expect(LEGAL_EDGE_COST_MASK).toBe(17408)
  })

  it('sets one bit per DISTINCT cost, so the mask and DISTINCT_EDGE_COSTS agree', () => {
    let bits = 0
    for (let c = 0; c <= 30; c++) bits += (LEGAL_EDGE_COST_MASK >>> c) & 1
    expect(bits).toBe(DISTINCT_EDGE_COSTS)
  })

  it('throws on an absent dirCount, so the import cycle cannot produce an empty mask', () => {
    // The regression this guard exists for: a module-scope `const mask =
    // edgeCostMask(DIR_COUNT, edgeCost)` inside the roads -> dispatch -> scratch
    // cycle read `DIR_COUNT` as `undefined` and returned 0, which means "no cost
    // is legal". Asserted with the value the cycle actually produced.
    expect(() => edgeCostMask(undefined as unknown as number, edgeCost)).toThrow(
      /dirCount must be a positive integer/,
    )
    expect(() => edgeCostMask(0, edgeCost)).toThrow(/dirCount must be a positive integer/)
    expect(edgeCostMask(DIR_COUNT, edgeCost), 'and a real one is never 0').not.toBe(0)
  })

  it('throws for a cost that cannot be a bit, rather than wrapping the shift silently', () => {
    // 31 is the first cost whose `1 << c` is negative; 32 wraps to 1 and would
    // make cost 32 test as "legal" because cost 0 happens to be. Proven with a
    // doctored cost function rather than by trusting today's 14.
    expect(() => edgeCostMask(1, () => 31)).toThrow(/outside \[0, 30\]/)
    expect(() => edgeCostMask(1, () => 32)).toThrow(/outside \[0, 30\]/)
    expect(() => edgeCostMask(1, () => -1)).toThrow(/outside \[0, 30\]/)
    expect(() => edgeCostMask(1, () => 30)).not.toThrow()
  })
})

describe('assertPushWithinBucketWindow — trap 2, converted from wrong paths into a named throw', () => {
  it('accepts every real edge cost', () => {
    for (let k = 0; k < DIR_COUNT; k++) {
      expect(() =>
        assertPushWithinBucketWindow(1000 + edgeCost(k), 1000, NB, LEGAL_EDGE_COST_MASK),
      ).not.toThrow()
    }
  })

  it('accepts a push exactly at the maximum legal edge cost', () => {
    expect(() =>
      assertPushWithinBucketWindow(100 + DIAG_COST, 100, NB, LEGAL_EDGE_COST_MASK),
    ).not.toThrow()
  })

  it('THE ARM THE PREVIOUS DRAFT DID NOT HAVE: throws on the SMALLEST possible added term', () => {
    // A junction surcharge of +1 on a diagonal is `d + 15`. Under a single
    // aliasing bound of `delta <= NB` that is ACCEPTED, because NB is 15 — so the
    // guard would have been silent on precisely the mutation it exists to catch.
    expect(() =>
      assertPushWithinBucketWindow(100 + DIAG_COST + 1, 100, NB, LEGAL_EDGE_COST_MASK),
    ).toThrow(/is not a legal edge cost.*\{10, 14\}/s)
  })

  /**
   * **The window a `delta <= maxEdge` bound left open, and the one membership
   * still cannot see — as a table, because a guard's blind spot has to be
   * derived rather than discovered.**
   *
   * The legality arm used to be `delta > maxEdge`. Since `NB = DIAG_COST + 1`
   * always and the aliasing arm runs first, its reachable window was exactly
   * `delta === 15`: every surcharge below that passed in silence. The rows below
   * are every surcharge `p` in 1..5 applied to each kind of step.
   *
   * `caught: false` appears exactly once, and it is derivable rather than
   * incidental: `10 + 4 === DIAG_COST`, so an orthogonal-only `+4` produces a
   * value the cost model genuinely emits. Any surcharge touching a DIAGONAL is
   * caught for every `p >= 1`, which is what matters — a junction penalty is a
   * property of the CELL, so it applies to whichever direction enters it, and a
   * uniform surcharge always trips the diagonal row.
   */
  const SURCHARGES: readonly (readonly [number, number, boolean])[] = [
    // [base cost, surcharge, caught?]
    [ORTHO_COST, 1, true], //  11 — not in {10, 14}
    [ORTHO_COST, 2, true], //  12 — the old bound accepted this
    [ORTHO_COST, 3, true], //  13 — and this
    [ORTHO_COST, 4, false], // 14 — collides with a legal diagonal. The one hole.
    [ORTHO_COST, 5, true], //  15
    [DIAG_COST, 1, true], //   15
    [DIAG_COST, 2, true], //   16 — over NB, so the ALIASING arm answers
    [DIAG_COST, 3, true], //   17
    [DIAG_COST, 4, true], //   18
    [DIAG_COST, 5, true], //   19
  ]

  for (const [base, p, caught] of SURCHARGES) {
    it(`${caught ? 'catches' : 'CANNOT see'} a +${p} surcharge on a ${base === ORTHO_COST ? 'orthogonal' : 'diagonal'} step (delta ${base + p})`, () => {
      const call = (): void =>
        assertPushWithinBucketWindow(100 + base + p, 100, NB, LEGAL_EDGE_COST_MASK)
      if (caught) expect(call).toThrow()
      else expect(call).not.toThrow()
    })
  }

  it('is not vacuous: the table really does contain both answers, and exactly one hole', () => {
    // Guards the table against becoming all-`true` (which would make the loop a
    // restatement of the arm above) or all-`false`.
    expect(SURCHARGES.filter(([, , c]) => c).length).toBe(9)
    expect(SURCHARGES.filter(([, , c]) => !c)).toEqual([[ORTHO_COST, 4, false]])
    expect(ORTHO_COST + 4, 'the hole exists because 10 + 4 IS a legal cost').toBe(DIAG_COST)
  })

  it('names the COST MODEL and not queue sizing for an in-window illegal cost', () => {
    // The misattribution a review found: under the old bound a uniform +2 on a
    // diagonal fired the aliasing message — "an edge cost above NB - 1 needs NB
    // resized" — sending the reader to the queue for a cost-model change. A +2 on
    // an ORTHOGONAL is inside the window, so membership answers, and the message
    // must say cost model.
    expect(() =>
      assertPushWithinBucketWindow(100 + ORTHO_COST + 2, 100, NB, LEGAL_EDGE_COST_MASK),
    ).toThrow(/is not a legal edge cost/)
    expect(() =>
      assertPushWithinBucketWindow(100 + ORTHO_COST + 2, 100, NB, LEGAL_EDGE_COST_MASK),
    ).not.toThrow(/needs\s+NB resized/)
  })

  it('throws with the ALIASING message when the gap also exceeds the modulus', () => {
    // The mask deliberately CONTAINS 16, so the membership arm cannot fire and
    // this case pins the aliasing arm alone. delta = 16 against 15 buckets, so
    // the entry lands in the bucket drained at 100 + (16 % 15) = 101 — the
    // arithmetic is the content, and it is what makes this a statement about
    // Dial's queue rather than about the cost model.
    //
    // **The two clauses are asserted in the order the MESSAGE has, not the
    // order the plan's snippet had.** The plan paired this message with
    // `/aliases into the bucket drained at 101.*NB=15/s`, which cannot match:
    // the message reports the modulus first ("a gap of 16 against NB=15") and
    // the aliased bucket second. Measured — that regex fails against the exact
    // message the plan also specifies. The message is the artefact somebody
    // reads at 3am, so the regex moved rather than the message.
    expect(() => assertPushWithinBucketWindow(100 + NB + 1, 100, NB, 1 << (NB + 1))).toThrow(
      /NB=15.*aliases into the bucket drained at 101/s,
    )
  })

  it('accepts a push exactly NB above the draining distance, which lands in the freshly-detached bucket', () => {
    // Kept as a separate case from the cost-model arm: it is a statement about
    // Dial's queue, and the two bounds are independent. The mask therefore says
    // 15 is a legal cost, so ONLY the aliasing arm can answer here — which is
    // what makes this pin `delta > buckets` rather than `>=`.
    expect(() => assertPushWithinBucketWindow(100 + NB, 100, NB, 1 << NB)).not.toThrow()
  })

  it('throws for a push BELOW the draining distance, which is a monotonicity violation', () => {
    expect(() => assertPushWithinBucketWindow(99, 100, NB, LEGAL_EDGE_COST_MASK)).toThrow(
      /below the distance being drained/,
    )
  })
})
