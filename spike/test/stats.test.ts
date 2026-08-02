import { describe, it, expect } from 'vitest'
import { percentiles, Sampler } from '../src/stats'

const ONE_TO_100 = Array.from({ length: 100 }, (_, i) => i + 1)

describe('percentiles', () => {
  it('throws on an empty sample set', () => {
    expect(() => percentiles([])).toThrow()
  })

  it('handles a single sample', () => {
    const s = percentiles([7])
    expect(s).toEqual({ count: 1, mean: 7, p50: 7, p95: 7, p99: 7, max: 7 })
  })

  it('computes nearest-rank percentiles over 1..100', () => {
    const s = percentiles(ONE_TO_100)
    expect(s.count).toBe(100)
    expect(s.mean).toBeCloseTo(50.5, 10)
    expect(s.p50).toBe(51)
    expect(s.p95).toBe(96)
    expect(s.p99).toBe(100)
    expect(s.max).toBe(100)
  })

  it('is order independent', () => {
    const shuffled = [...ONE_TO_100].reverse()
    expect(percentiles(shuffled)).toEqual(percentiles(ONE_TO_100))
  })

  it('sorts numerically, not lexicographically', () => {
    // Array.prototype.sort would order these as 10, 2, 9.
    const s = percentiles([9, 10, 2])
    expect(s.max).toBe(10)
    expect(s.p50).toBe(9)
  })

  it('does not mutate the input', () => {
    const input = [3, 1, 2]
    percentiles(input)
    expect(input).toEqual([3, 1, 2])
  })
})

describe('Sampler', () => {
  it('starts empty and rejects stats with no samples', () => {
    const s = new Sampler(4)
    expect(s.length).toBe(0)
    expect(() => s.stats()).toThrow()
  })

  it('accumulates up to capacity and then stops growing', () => {
    const s = new Sampler(3)
    s.push(1); s.push(2); s.push(3); s.push(4)
    expect(s.length).toBe(3)
    expect(s.stats().max).toBe(3)
  })

  it('reset clears accumulated samples', () => {
    const s = new Sampler(4)
    s.push(1)
    s.reset()
    expect(s.length).toBe(0)
  })
})
