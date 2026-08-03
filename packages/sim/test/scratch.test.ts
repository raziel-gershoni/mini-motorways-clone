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
  createFlowField,
  createFlowFields,
  createScratch,
  entryPoolCapacity,
  assertBucketCountExceedsEveryEdgeCost,
} from '../src/scratch'

describe('createFlowField / createFlowFields', () => {
  it('allocates dist/dir sized to cells, starting stamps at 0', () => {
    const f = createFlowField(37)
    expect(f.dist.length).toBe(37)
    expect(f.dir.length).toBe(37)
    expect(f.dist).toBeInstanceOf(Int32Array)
    expect(f.dir).toBeInstanceOf(Int8Array)
    expect(f.builtFromRoads).toBe(0)
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
    const s = createScratch(10)
    expect(s.bucketHead.length).toBe(NB)
    expect(s.nbrCell.length).toBe(8)
    expect(s.nbrDir.length).toBe(8)
    expect(s.nbrCell).toBeInstanceOf(Int32Array)
    expect(s.nbrDir).toBeInstanceOf(Int8Array)
    expect(s.stats.length).toBeGreaterThan(Math.max(ST_EXPANSIONS, ST_PUSHES))
  })

  it('sizes entryCell/entryNext to entryPoolCapacity(cells)', () => {
    const s = createScratch(20)
    expect(s.entryCell.length).toBe(entryPoolCapacity(20))
    expect(s.entryNext.length).toBe(entryPoolCapacity(20))
  })
})

describe('entryPoolCapacity', () => {
  it('equals cells * 3 today, derived from DISTINCT_EDGE_COSTS rather than a literal', () => {
    expect(DISTINCT_EDGE_COSTS).toBe(2)
    expect(entryPoolCapacity(50)).toBe(150)
    expect(entryPoolCapacity(50)).toBe(50 * (1 + DISTINCT_EDGE_COSTS))
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
    expect(() => createScratch(hugeCells)).toThrow()
  })

  it('createScratch does not throw for a realistic board size', () => {
    expect(() => createScratch(24 * 40)).not.toThrow()
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
