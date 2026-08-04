import type { GameState } from './state'
import { H_EPOCH, H_TICK, H_WEEK } from './state'
import { weekOfTick } from './clock'
import type { WorldData } from './world'
import type { FlowField, Scratch } from './scratch'
import { syncFields } from './flowfield'
import { placeRoad, eraseRoad } from './roads'
import { runDemand } from './demand'
import { assembleSources, runDispatch } from './dispatch'
import { runMovement } from './cars'
import { runArrivals } from './trips'

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
 * **The seven phases, each justified by the constraint that forces its
 * position rather than by preference** (M1c, "The tick order, derived"). The
 * order is derived; do not reorder it for tidiness.
 *
 *   1. `H_EPOCH <- tick`; advance `H_TICK`, `H_WEEK` — demand's 4 s
 *      eligibility gate compares `H_TICK - destSpawnTick[d]` against
 *      `FIRST_PIN_DELAY_TICKS`, and it is the ONLY thing inside a tick that
 *      reads `H_TICK` at all. Moving this one slot later delays every first
 *      pin by exactly one tick, which no golden can see (they are
 *      building-free) and only a run that CROSSES the 120-tick boundary can:
 *      `loop.test.ts` has that boundary test. `H_EPOCH` is the atomicity
 *      marker — see state.ts's "Atomicity" note. A throw in a later phase
 *      leaves it non-zero, and both the next `step` and `restore` throw a
 *      named error rather than proceed from a buffer a throwing tick may
 *      have partly mutated.
 *   2. Apply inputs — the only phase that changes `roads`. Must precede the
 *      field sync, or a road drawn on tick T is invisible to this tick's
 *      field.
 *   3. Demand — accumulators, pins, overflow, drops. Mutates `destPins`,
 *      which decides the source set, so it must precede the sync.
 *   4. Assemble sources, then EXACTLY ONE `syncFields`. Every source-mutating
 *      phase is now behind it, and `fieldFor` throws unless the sync ran
 *      against exactly the current sources.
 *   5. Dispatch — the whole tick's only field reader. Mutates `destReserved`
 *      and car state, never the source set: that is what decision 4 buys, and
 *      it is what makes "no phase between the sync and a field read may mutate
 *      the source set" hold with no in-tick reasoning required.
 *   6. Movement — advances committed routes and reads no field at all
 *      (decision 2). AFTER dispatch, so a car dispatched on tick T also moves
 *      on tick T; the alternative costs every trip one tick and every
 *      exact-tick assertion inherits it.
 *   7. Arrivals — consume the pin, release the reservation, credit the score,
 *      free the car. Mutates `destPins` AFTER the sync, so it must be last.
 *      **Stated residual: the fields are stale from here until the next
 *      tick's sync.** Nothing may call `fieldFor` in that window — not a
 *      renderer, not a debug hash, not a test helper. Under decision 2 the
 *      only in-tick reader is phase 5, so this binds external callers only,
 *      and `loop.test.ts` asserts the throw rather than assuming it.
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

  runDemand(s, scratch)

  assembleSources(s, world, scratch)
  syncFields(s, world, fields, scratch)

  runDispatch(s, world, fields, scratch)

  runMovement(s, world)

  runArrivals(s)

  s.header[H_EPOCH] = 0
}
