import type { GameState } from './state'
import { H_EPOCH, H_TICK, H_WEEK } from './state'
import { weekOfTick } from './clock'
import type { WorldData } from './world'
import type { FlowField, Scratch } from './scratch'
import { syncFields } from './flowfield'
import { placeRoad, eraseRoad } from './roads'

/**
 * A single road edit applied on one tick. `a`/`b` are the same cell-index
 * pair `placeRoad`/`eraseRoad` already take. An unknown `kind` throws (see
 * `step` below) rather than being silently skipped — a corrupted or
 * forward-incompatible input log should fail loudly, not apply a subset of
 * its actions with no signal.
 */
export type TickActionKind = 'place' | 'erase'
export interface TickAction {
  readonly kind: TickActionKind
  readonly a: number
  readonly b: number
}

/**
 * Player input applied on a single tick. `actions` widened from `readonly
 * never[]` (M1a/M1b) to `readonly TickAction[]` (M1c): road placement and
 * erasure now have a production caller (`step`, below) instead of only the
 * rollback tests wiring `placeRoad` by hand. It is a parameter rather than
 * ambient state so that a recorded input log plus a seed fully determines a
 * run, which is what makes server-side replay verification possible.
 */
export interface TickInputs {
  readonly actions: readonly TickAction[]
}

/**
 * Advances the simulation by exactly one tick, in place.
 *
 * **Signature arity is pinned by a test**: `step(s, world, fields, scratch,
 * inputs)`, always 5 parameters. Fast-forward is two calls to `step`, never
 * a `dt` (§5.10) — there is no batched API, so replaying N ticks and
 * replaying 2*(N/2) ticks run this exact function the same number of times
 * either way.
 *
 * Phases implemented in M1c Task 1 (structural prep — the demand, dispatch,
 * movement and arrivals phases the M1c plan's "tick order, derived" table
 * describes are Tasks 2-6's job; wiring all seven phases together is Task
 * 6's, per the plan's File Structure):
 *
 *   1. `H_EPOCH <- tick`; advance `H_TICK`, `H_WEEK` — see state.ts's
 *      "Atomicity" note. A throw in a later phase leaves `H_EPOCH` non-zero,
 *      and both the next `step` and `restore` throw a named error rather
 *      than proceed from a buffer a throwing tick may have partly mutated.
 *   2. Apply inputs — the only phase that changes `roads`. Must precede the
 *      field sync, or a road drawn on tick T is invisible to this tick's
 *      field.
 *   4. Sync fields — exactly once, from whatever `scratch.sourcesFlat`/
 *      `sourceCounts` currently hold. (Phase 3, demand, is Task 3's; phases
 *      5-7, dispatch/movement/arrivals, are Tasks 4-6's — this file has no
 *      phase between 2 and 4 yet, and the tick order's own numbering is kept
 *      so a later diff reads as insertion, not renumbering.)
 *   — `H_EPOCH <- 0` on successful exit.
 *
 * Pure in the sense that matters: the result depends only on the contents of
 * `s.buffer`, `world`, `fields`/`scratch` (both re-derivable from `s.buffer`
 * and `world` per design decision 3), and `inputs`. Nothing is read from
 * outside those — no clock, no randomness that is not seeded in the buffer,
 * no globals. That property is what the determinism test enforces and what
 * lets the same module replay a run byte-identically in a Cloudflare Worker.
 */
export function step(
  s: GameState,
  world: WorldData,
  fields: readonly FlowField[],
  scratch: Scratch,
  inputs: TickInputs,
): void {
  if ((s.header[H_EPOCH] as number) !== 0) {
    throw new Error(
      `step: state is poisoned (H_EPOCH=${s.header[H_EPOCH]}) — a previous step threw before ` +
        'clearing it, and this buffer is not resumable',
    )
  }

  const tick = (s.header[H_TICK] as number) + 1
  s.header[H_EPOCH] = tick
  s.header[H_TICK] = tick
  s.header[H_WEEK] = weekOfTick(tick)

  for (let i = 0; i < inputs.actions.length; i++) {
    const action = inputs.actions[i] as TickAction
    if (action.kind === 'place') {
      placeRoad(s, world, action.a, action.b)
    } else if (action.kind === 'erase') {
      eraseRoad(s, world, action.a, action.b)
    } else {
      throw new Error(`step: unknown action kind "${String(action.kind)}"`)
    }
  }

  syncFields(s, world, fields, scratch)

  s.header[H_EPOCH] = 0
}
