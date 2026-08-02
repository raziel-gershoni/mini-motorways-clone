import { TICKS_PER_WEEK, DAYS_PER_WEEK } from '@laneways/shared'

export function weekOfTick(tick: number): number {
  return (tick / TICKS_PER_WEEK) | 0
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
