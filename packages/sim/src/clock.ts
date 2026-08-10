import { TICKS_PER_WEEK, DAYS_PER_WEEK } from '@laneways/shared'

export function weekOfTick(tick: number): number {
  return (tick / TICKS_PER_WEEK) | 0
}

/**
 * True iff `tick` is the first tick of a new week.
 *
 * Derived from `weekOfTick(tick) !== weekOfTick(tick - 1)` rather than from a
 * stored "last granted week", so there is no second copy of the week index to
 * drift. **Tick 0 needs no guard and must not get one**: `-1 / TICKS_PER_WEEK
 * | 0` truncates toward zero, so `weekOfTick(-1)` is 0 and equals
 * `weekOfTick(0)`. An explicit `tick <= 0` branch here would be a line no
 * mutation can falsify.
 */
export function isWeekBoundary(tick: number): boolean {
  return weekOfTick(tick) !== weekOfTick(tick - 1)
}

export function tickWithinWeek(tick: number): number {
  return tick % TICKS_PER_WEEK
}

/**
 * Day 0..6, derived from position within the week rather than divided by a
 * stored ticks-per-day. 4500 / 7 is not an integer, so any stored constant
 * would drift the day counter against the week boundary. This is exact for
 * every tick by construction.
 */
export function dayOfWeek(tick: number): number {
  return ((tickWithinWeek(tick) * DAYS_PER_WEEK) / TICKS_PER_WEEK) | 0
}
