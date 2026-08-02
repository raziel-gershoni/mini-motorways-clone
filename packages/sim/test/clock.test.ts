import { describe, it, expect } from 'vitest'
import { weekOfTick, dayOfWeek, tickWithinWeek } from '../src/clock'
import { TICKS_PER_WEEK, DAYS_PER_WEEK } from '@laneways/shared'

describe('weekOfTick', () => {
  it('starts at week 0', () => {
    expect(weekOfTick(0)).toBe(0)
    expect(weekOfTick(TICKS_PER_WEEK - 1)).toBe(0)
  })

  it('rolls over exactly on the boundary', () => {
    expect(weekOfTick(TICKS_PER_WEEK)).toBe(1)
    expect(weekOfTick(TICKS_PER_WEEK * 5)).toBe(5)
  })
})

describe('tickWithinWeek', () => {
  it('wraps at the week boundary', () => {
    expect(tickWithinWeek(0)).toBe(0)
    expect(tickWithinWeek(TICKS_PER_WEEK - 1)).toBe(TICKS_PER_WEEK - 1)
    expect(tickWithinWeek(TICKS_PER_WEEK)).toBe(0)
    expect(tickWithinWeek(TICKS_PER_WEEK + 7)).toBe(7)
  })
})

describe('dayOfWeek', () => {
  it('starts on day 0 and ends on day 6', () => {
    expect(dayOfWeek(0)).toBe(0)
    expect(dayOfWeek(TICKS_PER_WEEK - 1)).toBe(DAYS_PER_WEEK - 1)
  })

  it('never leaves the range across a whole week, tick by tick', () => {
    for (let t = 0; t < TICKS_PER_WEEK; t++) {
      const d = dayOfWeek(t)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(DAYS_PER_WEEK)
    }
  })

  it('is monotonic within a week and resets at the boundary', () => {
    let prev = 0
    for (let t = 1; t < TICKS_PER_WEEK; t++) {
      const d = dayOfWeek(t)
      expect(d).toBeGreaterThanOrEqual(prev)
      prev = d
    }
    expect(dayOfWeek(TICKS_PER_WEEK)).toBe(0)
  })

  it('does not drift across many weeks', () => {
    // The whole reason TICKS_PER_DAY is not a stored constant: a rounded 642
    // would put day 6 of week 20 in the wrong place. Derivation cannot drift.
    for (let w = 0; w < 50; w++) {
      expect(dayOfWeek(w * TICKS_PER_WEEK)).toBe(0)
      expect(dayOfWeek((w + 1) * TICKS_PER_WEEK - 1)).toBe(DAYS_PER_WEEK - 1)
    }
  })

  it('visits every day of the week', () => {
    const seen = new Set<number>()
    for (let t = 0; t < TICKS_PER_WEEK; t++) seen.add(dayOfWeek(t))
    expect(seen.size).toBe(DAYS_PER_WEEK)
  })
})
