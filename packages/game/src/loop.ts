import { TICKS_PER_SECOND } from '@laneways/shared'
import type { TickInputs } from '@laneways/sim'
import type { InputQueue } from './inputs'

/**
 * The fixed-timestep loop — plan Decision 1.
 *
 * The sim is 30 Hz and integer; displays are 60 Hz or 120 Hz. Rendering only on
 * tick boundaries is visibly choppy and smooth car motion is most of this
 * genre's feel, so the loop accumulates real-valued wall-clock time, drains it
 * in whole ticks, and hands the leftover fraction to the renderer as `alpha`.
 *
 * ---------------------------------------------------------------------------
 * `TICK_MS` IS DERIVED. WRITING 33 IS A NAMED DEFECT
 * ---------------------------------------------------------------------------
 *
 * `1000 / TICKS_PER_SECOND` is 33.333333333333336, which rounds *above* exact.
 * At a hard-coded 33 a nominal 150-second week runs in 148.5 s: the sim counts
 * ticks and the Worker replays ticks, so nothing desynchronises against the
 * server, but every wall-clock-derived claim in the game and in M0's
 * measurements shifts by 1.01%, silently and forever.
 *
 * The reason an implementer reaches for 33 is that the correct value produces
 * surprising tick counts, so they are all hand-computed in `test/loop.test.ts`:
 * **a 100 ms frame runs 2 ticks, not 3** (three of them overshoot 100 ms by one
 * ulp), and the worst case for a single frame is **8**, not
 * `MAX_FRAME_DT_MS / TICK_MS = 7.499999999999999` — the accumulator carries a
 * residual in `[0, TICK_MS)` from the previous frame.
 *
 * ---------------------------------------------------------------------------
 * THE CLAMP NEVER FEEDS THE SIM, AND NEITHER DOES ANY OTHER FLOAT
 * ---------------------------------------------------------------------------
 *
 * `accumulator`, `alpha` and `rawDt` are floats; `step` advances in whole ticks
 * or not at all. That boundary is where a float would corrupt determinism, and
 * it is the reason this module never passes a number to `driver.advance` at
 * all. `MAX_FRAME_DT_MS = 250` is the clamp the M0 spike used: it exists so a
 * backgrounded tab does not run a thousand catch-up ticks on resume. **It does
 * not eliminate catch-up, it bounds it at 7-8 ticks.**
 *
 * The clamp is applied to `rawDt`, **not** to the accumulator. From a fresh
 * accumulator the two are indistinguishable — both give 7 ticks and the
 * identical residual — and they diverge only when a residual is carried in,
 * which is why `test/loop.test.ts` pairs a 5,000 ms frame from cold with the
 * same frame after a 20 ms one.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK REFERENCE IS RESET ON RESUME, AND THAT IS A MECHANISM
 * ---------------------------------------------------------------------------
 *
 * `rawDt = now - lastTime`. If pause froze only the accumulator, `lastTime`
 * would go stale for the whole pause and the first unpaused frame would see
 * `rawDt` = the pause duration, clamp to 250 ms and drain **7 ticks in one
 * frame** — 233 ms of simulation in one frame, every car jumping most of a
 * cell. The same applies to a cold start with `lastTime = 0`, where the first
 * frame's `rawDt` is the whole `performance.now()` reading.
 *
 * One flag fixes both: on the first frame and on every resume, set
 * `lastTime = now` and **leave the accumulator alone**. That is what makes
 * pause and stall different — a 2,000 ms pause resumes with 0 or 1 ticks, a
 * 2,000 ms stall runs exactly 7 — and neither number is discriminating on its
 * own.
 */

/** `1000 / 30 = 33.333333333333336`. Derived, never written as 33. */
export const TICK_MS = 1000 / TICKS_PER_SECOND

/** The per-frame catch-up clamp, in ms. M0's value. Bounds a burst at 7-8 ticks. */
export const MAX_FRAME_DT_MS = 250

/**
 * What the loop drives. Every method is called synchronously inside
 * `frame(now)`; none of them may allocate.
 *
 * The split into four callbacks rather than one is not decoration — it is what
 * makes the two orderings that matter assertable. `beforeStep` must run
 * *before* every `advance` (snapshotting the interpolator's prev state after
 * the step collapses `prevXY` onto `currXY` and makes the lerp constant within
 * a tick), and `afterDrain` must run once the whole burst is over rather than
 * per tick.
 */
export interface LoopDriver {
  /** Resolve the pre-step snapshot. Called immediately before each `advance`. */
  readonly beforeStep: () => void
  /** Advance the simulation by exactly one tick. Never receives a duration. */
  readonly advance: (inputs: TickInputs) => void
  /** Resolve the post-step snapshot. Called once per frame, only if `ticks > 0`. */
  readonly afterDrain: (ticks: number) => void
  /**
   * Draw one frame. `alpha` is always in `[0, 1)`.
   *
   * `paused` is passed rather than read back off the `Loop`, and that is not
   * convenience: the driver is constructed BEFORE the loop it drives, so a
   * driver reading `loop.paused` would need a mutable back-reference filled in
   * after construction. Handing it down removes the cycle and keeps
   * `frame.paused` sourced from the one place that owns it.
   */
  readonly render: (alpha: number, paused: boolean) => void
}

/**
 * The loop. Every field but `frame`/`setPaused` is a getter over the live
 * accumulator state, so a test reads what the next frame will actually use
 * rather than a copy taken at some earlier moment.
 */
export interface Loop {
  /**
   * Run one frame. `now` is the injected clock reading in ms — production
   * passes `requestAnimationFrame`'s own timestamp, so there is no second clock
   * anywhere, and tests pass literals.
   */
  readonly frame: (now: number) => void
  /** Pause or resume. Resuming resets the clock reference on the next frame. */
  readonly setPaused: (paused: boolean) => void
  readonly paused: boolean
  /** The render interpolation fraction, always in `[0, 1)`. */
  readonly alpha: number
  /** Unspent wall-clock time, always in `[0, TICK_MS)` after a frame. */
  readonly accumulator: number
  readonly ticksLastFrame: number
  readonly totalTicks: number
}

/**
 * The loop's three real-valued slots, held in a `Float64Array` rather than as
 * closure variables — and this is a measured requirement, not a style.
 *
 * A mutable `number` captured by a closure lives in a context slot, which holds
 * a tagged value; a double outside Smi range therefore allocates a fresh
 * `HeapNumber` on **every assignment**. `lastTime`, `accumulator` and `alpha`
 * are assigned once each per frame, so the plain-closure form allocates three
 * boxed doubles per frame — measured at **~65 B/frame**, which is *more than
 * one object per frame* and a straight violation of the milestone's "zero, not
 * small" rule. `test/allocation.test.ts` is what made it visible; before that
 * it was invisible to five milestones of review.
 *
 * `paused`, `resetClock`, `ticksLastFrame` and `totalTicks` stay as closure
 * variables deliberately: booleans are singletons and small integers are Smis,
 * so none of them boxes.
 *
 * Named slot indices into a typed array is this codebase's own idiom for
 * exactly this trade (`H_TICK`, `H_SCORE`, … in `sim/state.ts`).
 */
const L_LAST_TIME = 0
const L_ACCUMULATOR = 1
const L_ALPHA = 2
const LOOP_SLOT_COUNT = 3

export function createLoop(driver: LoopDriver, queue: InputQueue): Loop {
  const slots = new Float64Array(LOOP_SLOT_COUNT)
  let paused = false
  let ticksLastFrame = 0
  let totalTicks = 0
  /** True before the first frame and after every resume. Decision 1b. */
  let resetClock = true

  function frame(now: number): void {
    if (resetClock) {
      slots[L_LAST_TIME] = now
      resetClock = false
    }
    // `Math.max(..., 0)`: a clock that goes backwards would otherwise push the
    // accumulator negative and take `alpha` below 0. `requestAnimationFrame`'s
    // timestamp is monotonic, so this is a boundary guard rather than a live
    // branch — and it is exercised directly in `test/loop.test.ts` rather than
    // shipped unobserved.
    const rawDt = Math.max(now - (slots[L_LAST_TIME] as number), 0)
    slots[L_LAST_TIME] = now

    let ticks = 0
    // Read once into a local and written back once: a local double lives in a
    // register, so the drain loop's `accumulator -= TICK_MS` costs nothing even
    // when it runs eight times.
    let accumulator = slots[L_ACCUMULATOR] as number
    if (!paused) {
      // Clamped HERE, before accumulating — see the module comment.
      accumulator += Math.min(rawDt, MAX_FRAME_DT_MS)
      while (accumulator >= TICK_MS) {
        driver.beforeStep()
        driver.advance(queue.inputs)
        // Cleared once a tick has actually consumed the batch, and never
        // before the drain: at 60 Hz half of all frames run zero ticks, and
        // clearing on those would drop half of a drag's segments.
        //
        // Clearing here rather than after the whole `while` is what lets the
        // batch reach the FIRST tick of a catch-up burst and no other, while
        // still handing `step` one identity-stable `TickInputs` object. The
        // alternative — clear after the loop, pass a second, empty
        // `TickInputs` to ticks 2..N — is behaviourally identical from `step`'s
        // side and costs a second wrapper object, which is exactly what
        // Decision 9 exists to avoid.
        if (ticks === 0) queue.clear()
        accumulator -= TICK_MS
        ticks++
      }
      if (ticks > 0) driver.afterDrain(ticks)
    }
    slots[L_ACCUMULATOR] = accumulator

    // AFTER the drain: computing it before would let `alpha` reach 7.5.
    const alpha = accumulator / TICK_MS
    slots[L_ALPHA] = alpha
    ticksLastFrame = ticks
    totalTicks += ticks
    driver.render(alpha, paused)
  }

  return {
    frame,

    setPaused(next: boolean): void {
      // Guarded, so a redundant `setPaused(false)` mid-run cannot reset the
      // clock reference and silently swallow a frame's worth of time.
      if (next === paused) return
      paused = next
      if (!next) resetClock = true
    },

    get paused(): boolean {
      return paused
    },
    get alpha(): number {
      return slots[L_ALPHA] as number
    },
    get accumulator(): number {
      return slots[L_ACCUMULATOR] as number
    },
    get ticksLastFrame(): number {
      return ticksLastFrame
    },
    get totalTicks(): number {
      return totalTicks
    },
  }
}
