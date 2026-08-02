import type { GameState } from './state'
import { H_TICK, H_WEEK } from './state'
import { weekOfTick } from './clock'

/**
 * Player input applied on a single tick. Empty for now; M1b onwards fills it
 * with road draws, deletions and upgrade placements. It is a parameter rather
 * than ambient state so that a recorded input log plus a seed fully determines
 * a run, which is what makes server-side replay verification possible.
 */
export interface TickInputs {
  readonly actions: readonly never[]
}

/**
 * Advances the simulation by exactly one tick, in place.
 *
 * Pure in the sense that matters: the result depends only on the contents of
 * `s.buffer` and on `inputs`. Nothing is read from outside the buffer — no
 * clock, no randomness that is not seeded in the buffer, no globals. That
 * property is what the determinism test enforces and what lets the same module
 * replay a run byte-identically in a Cloudflare Worker.
 */
export function step(s: GameState, inputs: TickInputs): void {
  void inputs
  const tick = (s.header[H_TICK] as number) + 1
  s.header[H_TICK] = tick
  s.header[H_WEEK] = weekOfTick(tick)
}
