import { describe, it, expect } from 'vitest'
import { TICKS_PER_SECOND, firstCity, type MapData } from '@laneways/shared'
import {
  createState,
  createWorld,
  createScratch,
  createFlowFields,
  createFieldInputRanges,
  step,
  tilesLeft,
  H_TICK,
  H_TILES,
  type FlowField,
  type GameState,
  type Scratch,
  type TickAction,
  type TickInputs,
  type WorldData,
} from '@laneways/sim'
import { createInputQueue, type InputQueue } from '../src/inputs'
import { createLoop, MAX_FRAME_DT_MS, TICK_MS, type Loop, type LoopDriver } from '../src/loop'

/**
 * The fixed-timestep loop (plan Decision 1) and the pooled input queue
 * (Decision 9).
 *
 * ---------------------------------------------------------------------------
 * EVERY TICK COUNT AND EVERY ALPHA IN THIS FILE IS HAND-COMPUTED
 * ---------------------------------------------------------------------------
 *
 * `TICK_MS = 1000 / 30 = 33.333333333333336`, which rounds *above* exact. That
 * one bit is why the counts below are surprising, and it is why the plan names
 * `TICK_MS = 33` as a defect in advance: at 33 a nominal 150-second week runs
 * in 148.5 s and every wall-clock claim in the game shifts by 1.01% forever.
 *
 *   100 ms from cold  -> 2 ticks, NOT 3. The mechanism is repeated
 *                        SUBTRACTION: 100 - TICK_MS - TICK_MS leaves
 *                        33.33333333333332, one ulp short of a third tick, so
 *                        the drain stops at 2 and alpha is 0.9999999999999996.
 *                        **The plan and an earlier version of this comment both
 *                        said `3 * TICK_MS = 100.00000000000001`. That is wrong
 *                        and has no derivation** — verified at 21 digits, BOTH
 *                        the product `3 * TICK_MS` and repeated addition
 *                        `TICK_MS + TICK_MS + TICK_MS` are exactly 100, which is
 *                        asserted below. A comment that contradicts the test
 *                        three lines away is the same defect class as a test
 *                        that cannot fail.
 *   105 ms from cold  -> 3 ticks, residual 4.999999999999986.
 *   16.7 ms x4        -> 0, 1, 0, 1 — a 60 Hz display runs zero ticks on half
 *                        its frames, which is the whole reason the queue must
 *                        survive a zero-tick frame.
 *   2,000 ms fresh    -> 7 (clamped to 250 ms first).
 *   5,000 ms fresh    -> 7, identically.
 *   20 ms then 5,000  -> 0 then **8**. The residual the 20 ms frame leaves is
 *                        carried, so the worst case for one frame is 8, not
 *                        `MAX_FRAME_DT_MS / TICK_MS = 7.499999999999999`.
 *
 * The last pair is the only fixture in this file that distinguishes clamping
 * `rawDt` from clamping the accumulator: from a *fresh* loop both produce 7
 * ticks and the identical residual 16.666666666666615.
 *
 * ---------------------------------------------------------------------------
 * THE DRIVER IS INJECTED, AND SO IS THE CLOCK
 * ---------------------------------------------------------------------------
 *
 * `loop.frame(now)` takes the wall-clock reading; production passes
 * `requestAnimationFrame`'s own timestamp and these tests pass literals, so
 * there is no second clock anywhere and no timer to wait on.
 */

// ---------------------------------------------------------------------------
// Hand-computed constants, written as literals and checked against the
// derivation rather than derived from it.
// ---------------------------------------------------------------------------

/** `1000 / 30`, to the full precision a double can hold. */
const TICK_MS_LITERAL = 33.333333333333336

/** The residual a 250 ms clamped frame leaves from cold: `250 - 7 * TICK_MS`. */
const CLAMPED_RESIDUAL = 16.666666666666615

/** `CLAMPED_RESIDUAL / TICK_MS`. */
const CLAMPED_ALPHA = 0.4999999999999984

// ---------------------------------------------------------------------------
// A recording driver. Nothing here allocates per frame except the recording
// arrays themselves, which exist only in tests.
// ---------------------------------------------------------------------------

interface Recorder {
  readonly driver: LoopDriver
  readonly calls: string[]
  readonly renderAlphas: number[]
  readonly inputsSeen: TickInputs[]
  readonly actionsSeen: TickAction[]
  readonly actionCountPerTick: number[]
  readonly drainTicks: number[]
  readonly renderPaused: boolean[]
  beforeStepCount: number
  advanceCount: number
}

function recorder(onAdvance?: (inputs: TickInputs) => void): Recorder {
  const rec: Recorder = {
    calls: [],
    renderAlphas: [],
    inputsSeen: [],
    actionsSeen: [],
    actionCountPerTick: [],
    drainTicks: [],
    renderPaused: [],
    beforeStepCount: 0,
    advanceCount: 0,
    driver: {
      beforeStep(): void {
        rec.calls.push('beforeStep')
        rec.beforeStepCount++
      },
      advance(inputs: TickInputs): void {
        rec.calls.push('advance')
        rec.advanceCount++
        rec.inputsSeen.push(inputs)
        // Read synchronously: the queue is cleared inside the drain, so a
        // deferred read would see the cleared array and every count would be 0.
        rec.actionCountPerTick.push(inputs.actions.length)
        for (let i = 0; i < inputs.actions.length; i++) {
          rec.actionsSeen.push(inputs.actions[i] as TickAction)
        }
        onAdvance?.(inputs)
      },
      afterDrain(ticks: number): void {
        rec.calls.push('afterDrain')
        rec.drainTicks.push(ticks)
      },
      render(alpha: number, paused: boolean): void {
        rec.calls.push('render')
        rec.renderAlphas.push(alpha)
        rec.renderPaused.push(paused)
      },
    },
  }
  return rec
}

interface Rig {
  readonly loop: Loop
  readonly queue: InputQueue
  readonly rec: Recorder
}

function rig(onAdvance?: (inputs: TickInputs) => void): Rig {
  const rec = recorder(onAdvance)
  const queue = createInputQueue()
  return { loop: createLoop(rec.driver, queue), queue, rec }
}

/** Runs `durations` back to back from a cold loop, returning the per-frame tick counts. */
function runFrames(loop: Loop, durations: readonly number[], start = 1000): number[] {
  const out: number[] = []
  let now = start
  // The first frame only establishes the clock reference; the caller's
  // durations start from there.
  loop.frame(now)
  out.push(loop.ticksLastFrame)
  for (let i = 0; i < durations.length; i++) {
    now += durations[i] as number
    loop.frame(now)
    out.push(loop.ticksLastFrame)
  }
  return out
}

// ---------------------------------------------------------------------------
// The sim rig, for the queue bullets that need real state.
// ---------------------------------------------------------------------------

interface SimRig {
  readonly map: MapData
  readonly world: WorldData
  readonly state: GameState
  readonly scratch: Scratch
  readonly fields: FlowField[]
}

function simRig(): SimRig {
  const map = firstCity()
  const world = createWorld(map)
  return {
    map,
    world,
    state: createState('m2-loop', map),
    scratch: createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map)),
    fields: createFlowFields(map.groupCount, world.cells),
  }
}

function simDriver(sim: SimRig): LoopDriver {
  return {
    beforeStep(): void {},
    advance(inputs: TickInputs): void {
      step(sim.state, sim.world, sim.fields, sim.scratch, inputs)
    },
    afterDrain(): void {},
    render(): void {},
  }
}

// ---------------------------------------------------------------------------
// 1. TICK_MS is derived, and the arithmetic that follows from it
// ---------------------------------------------------------------------------

describe('TICK_MS', () => {
  it('is 1000 / TICKS_PER_SECOND to the last bit, and is not 33', () => {
    expect(TICK_MS).toBe(1000 / TICKS_PER_SECOND)
    expect(TICK_MS).toBe(TICK_MS_LITERAL)
    expect(TICK_MS).not.toBe(33)
    // The one bit the whole file rests on, and it is subtler than "three of
    // them exceed 100": BOTH the product and repeated addition round back to
    // exactly 100, which is precisely why the "a 100 ms frame runs 3 ticks"
    // intuition is so easy to hold. The drain neither multiplies nor adds — it
    // SUBTRACTS, and repeated subtraction leaves 33.33333333333332, one ulp
    // short of a third tick.
    expect(3 * TICK_MS).toBe(100)
    expect(TICK_MS + TICK_MS + TICK_MS).toBe(100)
    expect(100 - TICK_MS - TICK_MS).toBe(33.33333333333332)
    expect(100 - TICK_MS - TICK_MS).toBeLessThan(TICK_MS)
  })

  it('makes a nominal week 150 s, which TICK_MS = 33 would shorten by 1.01%', () => {
    // 4500 ticks per week. This is the wall-clock claim the mutation breaks.
    expect(4500 * TICK_MS).toBe(150000)
    expect(4500 * 33).toBe(148500)
  })

  it('bounds one frame at 8 ticks, not at MAX_FRAME_DT_MS / TICK_MS', () => {
    expect(MAX_FRAME_DT_MS).toBe(250)
    expect(MAX_FRAME_DT_MS / TICK_MS).toBe(7.499999999999999)
  })
})

// ---------------------------------------------------------------------------
// 2. Decision 1's table, each row its own case
// ---------------------------------------------------------------------------

describe('the accumulator table', () => {
  it('runs 0 ticks on the first frame — the clock reference is initialised, not left at 0', () => {
    const { loop } = rig()
    loop.frame(123456)
    expect(loop.ticksLastFrame).toBe(0)
    expect(loop.accumulator).toBe(0)
    expect(loop.alpha).toBe(0)
  })

  it('runs 2 ticks on a 100 ms frame, with alpha 0.9999999999999996', () => {
    const { loop } = rig()
    expect(runFrames(loop, [100])).toEqual([0, 2])
    expect(loop.accumulator).toBe(33.33333333333332)
    expect(loop.alpha).toBe(0.9999999999999996)
    // The near-1 alpha IS the case, not an accident of it: it is the value
    // that breaks first if the drain ever lets alpha reach 1.
    expect(loop.alpha).toBeLessThan(1)
    // `totalTicks` is a public accessor Task 9's integration test is told to
    // use, and it had no assertion anywhere until this line: `totalTicks += 0`
    // survived the whole suite. Pinned here because this is the one case whose
    // per-frame count (2) differs from `ticksLastFrame` on the frame before it.
    expect(loop.totalTicks).toBe(2)
    expect(loop.ticksLastFrame).toBe(2)
  })

  it('accumulates totalTicks across frames while ticksLastFrame reports only the last', () => {
    // 50 ms -> 1 tick (residual 16.67); 10 ms -> 0 ticks (26.67, still under
    // one tick); 105 ms -> 3 ticks. So `ticksLastFrame` is 3 and the running
    // total is 4, and the middle frame proves the total is not simply the
    // frame count.
    const { loop } = rig()
    expect(runFrames(loop, [50, 10, 105])).toEqual([0, 1, 0, 3])
    expect(loop.ticksLastFrame).toBe(3)
    expect(loop.totalTicks).toBe(4)
  })

  it('runs 3 ticks on a 105 ms frame, with alpha 0.14999999999999955', () => {
    const { loop } = rig()
    expect(runFrames(loop, [105])).toEqual([0, 3])
    expect(loop.accumulator).toBe(4.999999999999986)
    expect(loop.alpha).toBe(0.14999999999999955)
  })

  it('alternates 0, 1, 0, 1 across four 16.7 ms frames, with four hand-computed alphas', () => {
    const { loop } = rig()
    const alphas: number[] = []
    const ticks: number[] = []
    let now = 1000
    loop.frame(now)
    for (let i = 0; i < 4; i++) {
      now += 16.7
      loop.frame(now)
      ticks.push(loop.ticksLastFrame)
      alphas.push(loop.alpha)
    }
    // A 60 Hz display runs zero ticks on half its frames. This is the whole
    // reason the input queue survives a zero-tick frame.
    expect(ticks).toEqual([0, 1, 0, 1])
    // The plan's four hand-computed alphas, to twelve places rather than to the
    // last bit — and the reason is a property of `rawDt = now - lastTime`, not
    // of the loop. 16.7 is not exactly representable and the timestamps are
    // absolute, so `1016.7 - 1000` is 16.699999999999932 while `33.4 - 16.7` is
    // 16.700000000000003: the low bits of every alpha depend on the clock's
    // ORIGIN. Production reads `requestAnimationFrame`'s timestamp, which is
    // arbitrary, so a last-bit assertion here would pin an accident.
    //
    // Twelve places is far tighter than any real defect: `TICK_MS = 33` puts
    // the first alpha at 16.7/33 = 0.50606..., five parts in a thousand away.
    // Two cases in this file DO pin alpha to the last bit — 100 ms and 105 ms,
    // whose `rawDt` is exact at any origin.
    const expected = [0.501, 0.002, 0.503, 0.004]
    for (let i = 0; i < 4; i++) {
      expect(alphas[i] as number, `alpha ${i}`).toBeCloseTo(expected[i] as number, 12)
    }
  })

  it('runs exactly 1 tick on a frame of exactly TICK_MS, leaving alpha at exactly 0', () => {
    // Both directions of the drain's bound, at the only operating point where
    // `>=` and `>` differ: the accumulator lands EXACTLY on TICK_MS. The clock
    // origin is 0 so that `rawDt` is TICK_MS to the last bit — from an origin
    // of 1000 the subtraction gives 33.3333333333332575, which is BELOW the
    // bound, and the fixture would then agree with the mutant for the wrong
    // reason.
    const { loop } = rig()
    expect(runFrames(loop, [TICK_MS], 0)).toEqual([0, 1])
    expect(loop.accumulator).toBe(0)
    expect(loop.alpha).toBe(0)
  })

  it('runs 0 ticks on a frame one ulp below TICK_MS — the other side of the same bound', () => {
    const below = TICK_MS - Number.EPSILON * TICK_MS
    expect(below).toBeLessThan(TICK_MS)
    expect(below + Number.EPSILON * TICK_MS).toBe(TICK_MS) // exactly one ulp, not two
    const { loop } = rig()
    expect(runFrames(loop, [below], 0)).toEqual([0, 0])
    expect(loop.alpha).toBeLessThan(1)
    expect(loop.alpha).toBeGreaterThan(0.99)
  })

  it('clamps a 2,000 ms frame to 7 ticks from a fresh accumulator', () => {
    const { loop } = rig()
    expect(runFrames(loop, [2000])).toEqual([0, 7])
    expect(loop.accumulator).toBe(CLAMPED_RESIDUAL)
    expect(loop.alpha).toBe(CLAMPED_ALPHA)
  })

  it('clamps a 5,000 ms frame to the same 7 ticks and the same residual', () => {
    const { loop } = rig()
    expect(runFrames(loop, [5000])).toEqual([0, 7])
    expect(loop.accumulator).toBe(CLAMPED_RESIDUAL)
    expect(loop.alpha).toBe(CLAMPED_ALPHA)
  })

  it('runs 8 ticks on a 5,000 ms frame that FOLLOWS a 20 ms frame', () => {
    // The clamp is on `rawDt`, not on the accumulator. Clamping the
    // accumulator would give 7 here and an identical 7 above, so this pair is
    // the only thing in the file that separates them.
    const { loop } = rig()
    expect(runFrames(loop, [20, 5000])).toEqual([0, 0, 8])
    expect(loop.accumulator).toBe(3.3333333333332718)
    expect(loop.alpha).toBe(0.09999999999999815)
  })

  it('never lets alpha leave [0, 1) across a long randomised run', () => {
    const { loop } = rig()
    // A fixed LCG, so a failure is reproducible. Durations span the whole
    // interesting range: sub-tick, multi-tick, and past the clamp.
    let seed = 0x2f6e2b1
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    let now = 1000
    loop.frame(now)
    let sawNearOne = false
    for (let i = 0; i < 5000; i++) {
      now += next() * 400
      loop.frame(now)
      expect(loop.alpha, `frame ${i}`).toBeGreaterThanOrEqual(0)
      expect(loop.alpha, `frame ${i}`).toBeLessThan(1)
      if (loop.alpha > 0.99) sawNearOne = true
    }
    // Vacuity: the run must actually visit the top of the range, or "< 1" is
    // asserted only where it is comfortably true.
    expect(sawNearOne, 'the randomised run never approached alpha = 1').toBe(true)
  })

  it('treats a backwards clock as a zero-length frame rather than a negative one', () => {
    const { loop } = rig()
    loop.frame(1000)
    loop.frame(1050)
    const accAfter = loop.accumulator
    loop.frame(1010)
    expect(loop.ticksLastFrame).toBe(0)
    expect(loop.accumulator).toBe(accAfter)
    expect(loop.alpha).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// 3. The shape of a frame: snapshot, step, drain, render
// ---------------------------------------------------------------------------

describe('the frame’s call order', () => {
  it('snapshots before every step, drains, then renders exactly once', () => {
    const { loop, rec } = rig()
    runFrames(loop, [100])
    expect(rec.calls).toEqual([
      'render', // frame 1: clock reference only
      'beforeStep',
      'advance',
      'beforeStep',
      'advance',
      'afterDrain',
      'render',
    ])
    expect(rec.drainTicks).toEqual([2])
  })

  it('renders on a zero-tick frame and does not call afterDrain', () => {
    const { loop, rec } = rig()
    runFrames(loop, [10])
    expect(rec.calls).toEqual(['render', 'render'])
    expect(rec.beforeStepCount).toBe(0)
    expect(rec.drainTicks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. Pause and stall — different mechanisms, and neither number alone says so
// ---------------------------------------------------------------------------

describe('pause and stall', () => {
  it('resumes a 2,000 ms pause with 0 or 1 ticks', () => {
    const { loop } = rig()
    loop.frame(1000)
    loop.frame(1016)
    loop.setPaused(true)
    // No frames at all for two seconds — a paused game whose rAF loop is idle,
    // or a backgrounded tab. `lastTime` is stale by 2,000 ms.
    loop.setPaused(false)
    loop.frame(3016)
    expect(loop.ticksLastFrame).toBeLessThanOrEqual(1)
    // Exactly 0 at this implementation: the clock reference is reset and the
    // accumulator (16 ms) is below one tick.
    expect(loop.ticksLastFrame).toBe(0)
  })

  it('does not discard the accumulator across a pause', () => {
    const { loop } = rig()
    loop.frame(1000)
    loop.frame(1030) // accumulator 30, below one tick
    expect(loop.accumulator).toBe(30)
    loop.setPaused(true)
    loop.setPaused(false)
    loop.frame(3030)
    // The 30 ms is still there; only the clock reference moved.
    expect(loop.accumulator).toBe(30)
  })

  it('runs exactly 7 ticks after a 2,000 ms STALL with no pause', () => {
    const { loop } = rig()
    loop.frame(1000)
    loop.frame(3000)
    expect(loop.ticksLastFrame).toBe(7)
  })

  it('runs no ticks while paused, however long the frame', () => {
    const { loop, rec } = rig()
    loop.frame(1000)
    loop.setPaused(true)
    loop.frame(1200)
    loop.frame(1400)
    expect(loop.ticksLastFrame).toBe(0)
    expect(rec.advanceCount).toBe(0)
    // Still renders: a paused game is still drawn.
    expect(rec.renderAlphas.length).toBe(3)
    // And it is told it is paused, so the HUD can say so.
    expect(rec.renderPaused).toEqual([false, true, true])
  })

  it('ignores a redundant setPaused(false) — it must not reset the clock mid-run', () => {
    const { loop } = rig()
    loop.frame(1000)
    loop.setPaused(false) // already running
    loop.frame(1100)
    expect(loop.ticksLastFrame).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 4b. end(): terminal, and reachable from outside this module — M1e Task 8
// ---------------------------------------------------------------------------

describe('end(): a loop that has ended cannot be resumed by anyone', () => {
  it('pauses, refuses every later setPaused, and runs no tick', () => {
    // **`setPaused` is reachable from OUTSIDE this module**: `main.ts` gives
    // `createPointerInput` a `setPaused` that forwards straight to it, and the
    // HUD clock tap is its production caller. Until Task 8 one tap resumed rAF
    // on a dead sim — the frame driver kept snapshotting, the pause bars
    // vanished while nothing else changed, and `HitRegion.GRID` re-opened so
    // the player drew roads that never appeared. Guarding the one caller that
    // exists is a guard that re-opens with the next one, so the stickiness is a
    // property of the loop.
    const { loop, rec } = rig()
    loop.frame(1000)
    loop.frame(1100)
    expect(loop.totalTicks, 'vacuity: it was running').toBe(2)
    expect(loop.over).toBe(false)

    loop.end()
    expect(loop.paused, 'end() pauses as well as ending').toBe(true)
    expect(loop.over).toBe(true)

    loop.setPaused(false)
    expect(loop.paused, 'setPaused(false) after end() must do nothing').toBe(true)
    expect(loop.over).toBe(true)

    const ticksBefore = loop.totalTicks
    const advancesBefore = rec.advanceCount
    for (let f = 0; f < 30; f++) loop.frame(1100 + (f + 1) * 100)
    expect(loop.ticksLastFrame).toBe(0)
    expect(loop.totalTicks, 'and no tick may run').toBe(ticksBefore)
    expect(rec.advanceCount, 'nor any advance').toBe(advancesBefore)
  })

  it('is not vacuous: the same 30 frames on a merely PAUSED loop resume and drain', () => {
    // The negative assertion above is only worth something if `setPaused(false)`
    // is otherwise capable of restarting this exact rig. Same frames, same
    // durations, one call short of `end()`.
    const { loop, rec } = rig()
    loop.frame(1000)
    loop.frame(1100)
    loop.setPaused(true)
    loop.setPaused(false)
    for (let f = 0; f < 30; f++) loop.frame(1100 + (f + 1) * 100)
    expect(loop.totalTicks, 'a merely paused loop comes back').toBeGreaterThan(2)
    expect(rec.advanceCount).toBeGreaterThan(2)
  })

  it('still RENDERS, because rAF is never cancelled and pause is a branch inside frame', () => {
    // Stated because "stop the loop" is not a thing this codebase can do
    // without restructuring the entry point: `wireGame`'s `onFrame` re-arms
    // `requestAnimationFrame` unconditionally, and `end()` does not reach it.
    // What `end()` buys is that the branch skips the drain — the frame still
    // draws, which is what lets Task 9 put a shutdown screen on it.
    const { loop, rec } = rig()
    loop.frame(1000)
    loop.end()
    const rendersBefore = rec.renderAlphas.length
    loop.frame(1100)
    loop.frame(1200)
    expect(rec.renderAlphas.length, 'the frame path is still live').toBe(rendersBefore + 2)
    expect(rec.renderPaused.slice(-2), 'and it renders as paused').toEqual([true, true])
    expect(rec.advanceCount).toBe(0)
  })

  it('is idempotent, and ending an already-paused loop leaves it paused', () => {
    const { loop } = rig()
    loop.frame(1000)
    loop.setPaused(true)
    loop.end()
    loop.end()
    expect(loop.paused).toBe(true)
    expect(loop.over).toBe(true)
    loop.setPaused(false)
    expect(loop.paused).toBe(true)
  })

  it('refuses setPaused(true) after end() too, so `over` cannot be laundered into a resume', () => {
    // `setPaused`'s existing early return is `if (next === paused) return`, so a
    // guard written as "refuse only un-pausing" would let `setPaused(true)`
    // through, do nothing visible, and then let a following `setPaused(false)`
    // see a state change it should not. One unconditional refusal, not two
    // conditional ones.
    const { loop } = rig()
    loop.frame(1000)
    loop.end()
    loop.setPaused(true)
    loop.setPaused(false)
    expect(loop.paused).toBe(true)
    loop.frame(1100)
    expect(loop.ticksLastFrame).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. The pooled input queue
// ---------------------------------------------------------------------------

describe('the input queue', () => {
  it('hands step one TickInputs object whose actions array carries the enqueued actions', () => {
    const queue = createInputQueue()
    expect(queue.inputs.actions.length).toBe(0)
    queue.enqueue('place', 10, 11)
    queue.enqueue('erase', 11, 12)
    expect(queue.inputs.actions.length).toBe(2)
    expect(queue.inputs.actions[0]).toEqual({ kind: 'place', a: 10, b: 11 })
    expect(queue.inputs.actions[1]).toEqual({ kind: 'erase', a: 11, b: 12 })
  })

  it('reuses the same TickInputs object across clears', () => {
    const queue = createInputQueue()
    const first = queue.inputs
    queue.enqueue('place', 1, 2)
    queue.clear()
    queue.enqueue('place', 3, 4)
    expect(queue.inputs).toBe(first)
    expect(queue.inputs.actions.length).toBe(1)
  })

  it('reuses the pooled action objects rather than allocating one per event', () => {
    const queue = createInputQueue(4)
    queue.enqueue('place', 1, 2)
    const pooled = queue.inputs.actions[0] as TickAction
    queue.clear()
    queue.enqueue('erase', 7, 8)
    expect(queue.inputs.actions[0]).toBe(pooled)
    expect(queue.inputs.actions[0]).toEqual({ kind: 'erase', a: 7, b: 8 })
  })

  it('grows the pool only past its high-water mark', () => {
    const queue = createInputQueue(2)
    expect(queue.poolSize).toBe(2)
    queue.enqueue('place', 1, 2)
    queue.enqueue('place', 2, 3)
    expect(queue.poolSize).toBe(2)
    queue.enqueue('place', 3, 4)
    expect(queue.poolSize).toBe(3)
    queue.clear()
    for (let i = 0; i < 3; i++) queue.enqueue('place', i, i + 1)
    // Back inside the high-water mark: no further growth.
    expect(queue.poolSize).toBe(3)
  })

  it('carries a choose-card with NO structural change to the queue, because a kind and two numbers is all it is', () => {
    // **M1f Task 6's confirm-and-pin.** `enqueue(kind, a, b)` already takes a
    // `TickActionKind`, so the third action kind needed no edit here at all —
    // and that is the property worth a test rather than a sentence, because the
    // natural wrong move when a new kind arrives is a per-kind payload, which
    // is exactly what would end this module's allocation-freedom (one reused
    // object shape, `pool[n]`, forever).
    //
    // **`a` is the offer SLOT and `b` is the ECHOED CARD ID** — the card the
    // client believes that slot holds. Task 8's `pointer.ts` calls
    // `queue.enqueue('choose-card', slot, cardId)`; `sim`'s `applyChooseCard`
    // throws when `b` disagrees with what it offered, which is the whole
    // replay-divergence mechanism, so a queue that dropped or transposed the two
    // numbers would turn every honest replay into an `unverifiable` verdict.
    const queue = createInputQueue(2)
    queue.enqueue('place', 10, 11)
    queue.enqueue('choose-card', 1, 7)
    expect(queue.inputs.actions.length).toBe(2)
    expect(queue.inputs.actions[1]).toEqual({ kind: 'choose-card', a: 1, b: 7 })
    expect(queue.poolSize, 'and it took no extra pooled object').toBe(2)

    // The pooled object is REUSED ACROSS KINDS — slot 0 held a `'place'` a moment
    // ago and holds a `'choose-card'` now, same object, rewritten in place. That
    // is the half a per-kind payload would fail.
    const pooled = queue.inputs.actions[0] as TickAction
    expect(pooled.kind, 'slot 0 is the place action').toBe('place')
    queue.clear()
    queue.enqueue('choose-card', 0, 1)
    expect(queue.inputs.actions[0]).toBe(pooled)
    expect(queue.inputs.actions[0]).toEqual({ kind: 'choose-card', a: 0, b: 1 })
    expect(queue.poolSize, 'and still no growth').toBe(2)
  })

  it('clears to length 0 and leaves the array reusable', () => {
    const queue = createInputQueue()
    queue.enqueue('place', 1, 2)
    queue.clear()
    expect(queue.inputs.actions.length).toBe(0)
    expect(queue.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. The queue against the loop
// ---------------------------------------------------------------------------

describe('the queue across frames', () => {
  it('survives a zero-tick frame and reaches the next tick that runs', () => {
    const sim = simRig()
    const queue = createInputQueue()
    const loop = createLoop(simDriver(sim), queue)
    const before = tilesLeft(sim.state)

    loop.frame(1000)
    // A 16.7 ms frame at 60 Hz: zero ticks. This is half of all frames.
    queue.enqueue('place', 10 * 24 + 8, 10 * 24 + 9)
    loop.frame(1016.7)
    expect(loop.ticksLastFrame).toBe(0)
    expect(sim.state.roads[10 * 24 + 8] as number).toBe(0)
    expect(tilesLeft(sim.state)).toBe(before)

    loop.frame(1033.4)
    expect(loop.ticksLastFrame).toBe(1)
    // The road exists and the budget moved exactly once.
    expect(sim.state.roads[10 * 24 + 8] as number).not.toBe(0)
    expect(sim.state.roads[10 * 24 + 9] as number).not.toBe(0)
    expect(tilesLeft(sim.state)).toBe(before - 2)

    // ...and only once: several more ticks must not re-spend.
    loop.frame(1200)
    expect(tilesLeft(sim.state)).toBe(before - 2)
  })

  it('gives the batch to the FIRST tick of a catch-up burst and runs the rest empty', () => {
    const { loop, queue, rec } = rig()
    loop.frame(1000)
    queue.enqueue('place', 1, 2)
    queue.enqueue('place', 2, 3)
    loop.frame(1100) // 2 ticks
    expect(rec.actionCountPerTick).toEqual([2, 0])
  })

  it('does not clear the queue before the drain', () => {
    const { loop, queue, rec } = rig()
    loop.frame(1000)
    queue.enqueue('place', 5, 6)
    loop.frame(1040)
    expect(rec.actionCountPerTick).toEqual([1])
  })

  it('clears the queue once a tick has consumed it, so no tick sees a stale action', () => {
    const { loop, queue, rec } = rig()
    loop.frame(1000)
    queue.enqueue('place', 5, 6)
    loop.frame(1040) // 1 tick
    loop.frame(1080) // 1 tick
    loop.frame(1120) // 1 tick
    expect(rec.actionCountPerTick).toEqual([1, 0, 0])
  })

  it('does not clear a queue no tick has consumed', () => {
    const { loop, queue } = rig()
    loop.frame(1000)
    queue.enqueue('place', 5, 6)
    loop.frame(1010)
    loop.frame(1020)
    expect(queue.length).toBe(1)
  })

  /**
   * The state-visible half of "never clear the queue at all", and neither the
   * brief's fixture nor this file's first attempt at one could see it.
   *
   * **The brief's fixture is blind.** It prescribes place at T, erase at T+40,
   * "the stale place action resurrects the road at T+41". A never-cleared queue
   * holds `[place, erase]` in enqueue order and runs *both* on every later
   * tick: the place re-creates the segment and the erase removes it again,
   * inside the same phase-2 loop, before `syncFields` or anything else can
   * observe it. Verified by comparing `hashState` at the end of every tick —
   * byte-identical throughout. It is the same last-write-wins argument
   * Decision 9 uses to reject "feed input to `step` twice", and it applies to
   * every place/erase pair.
   *
   * What is NOT idempotent is a placement **refused for budget** that later
   * becomes affordable: the stale action retries every tick, and the first tick
   * on which the budget covers it, it lands. A road the player's finger never
   * drew appears seconds after they lifted it.
   *
   * **The trap this fixture originally fell into, recorded because it is
   * subtle.** The first version laid X-Y *through the queue*. That put a stale
   * `place X-Y` at the FRONT of the never-cleared batch, so on every later tick
   * it re-spent the two tiles the erase had just refunded — before the stale
   * `place A-B` was reached — and A-B was never affordable. The fixture's own
   * first action defeated its last assertion, and it was a 0-detector for the
   * mutation it was written for. The catalogue's exact shape: *"a test written
   * specifically to catch a thing can still be blind to it… always run it under
   * the mutation it was written for."*
   *
   * So X-Y is laid **out of band**, and the budget is granted out of band too —
   * which is not a contrivance: `H_TILES` is deliberately in the mutable header
   * rather than in `mapIdentity` precisely because a grant moves tiles with no
   * road change (`sim/state.ts`), and M1e made that real — `runWeekBoundary`
   * lands `WEEKLY_TILE_GRANT` tiles at every week boundary.
   */
  it('does not resurrect a budget-refused placement once tiles are granted later', () => {
    const sim = simRig()
    const queue = createInputQueue()
    const loop = createLoop(simDriver(sim), queue)

    const A = 20 * 24 + 8
    const B = 20 * 24 + 9

    loop.frame(1000)

    // Tick 1: two fresh cells cost 2, and the player has 1 tile. Refused.
    sim.state.header[H_TILES] = 1
    queue.enqueue('place', A, B)
    loop.frame(1040)
    expect(sim.state.header[H_TICK] as number).toBe(1)
    expect(sim.state.roads[A] as number, 'the refused placement must not have landed').toBe(0)
    expect(tilesLeft(sim.state)).toBe(1)

    // Between frames, out of band: the budget grows to 3.
    sim.state.header[H_TILES] = 3

    // Ticks 2..5: the queue is empty, so nothing happens. A queue that was
    // never cleared retries the stale `place A-B` here — now affordable — and
    // lays a road nobody asked for.
    loop.frame(1080)
    loop.frame(1120)
    loop.frame(1160)
    loop.frame(1200)
    expect(sim.state.header[H_TICK] as number).toBeGreaterThanOrEqual(5)
    expect(sim.state.roads[A] as number, 'a stale place action resurrected itself').toBe(0)
    expect(sim.state.roads[B] as number).toBe(0)
    expect(tilesLeft(sim.state)).toBe(3)
  })

  /**
   * The other half of the same rule, and the reason the clear is unconditional
   * rather than "clear the actions that succeeded".
   *
   * A refused action is CONSUMED, not retried. Without this, "clear only what
   * `step` acted on" reads like a reasonable refinement and reintroduces
   * exactly the defect above.
   */
  it('consumes an action the sim refused, rather than holding it for a later tick', () => {
    const sim = simRig()
    const queue = createInputQueue()
    const loop = createLoop(simDriver(sim), queue)
    loop.frame(1000)
    sim.state.header[H_TILES] = 1
    queue.enqueue('place', 20 * 24 + 8, 20 * 24 + 9)
    loop.frame(1040)
    expect(queue.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 7. Allocation, stated as exactly what it is
// ---------------------------------------------------------------------------

describe('allocation across a long drag', () => {
  /**
   * This kills the two allocations that exist on this path — "a fresh action
   * object per pointer event" and "a fresh `TickInputs` wrapper per tick" —
   * and it proves nothing about global allocation-freedom. A
   * `process.memoryUsage()` delta across 1,000 frames would be dominated by GC
   * timing rather than by anything this code does.
   *
   * **The rest of the enforcement is not "construction and review", which is
   * what this comment used to say.** `test/allocation.test.ts` is a real
   * sampling profile of 3,000 frames — with a live drag through `pointer.ts`
   * since Task 7 — and it is what caught `clear()` allocating 152 bytes a tick
   * on a path this identity test walks straight past: the pool is respected
   * exactly as asserted below, and the ARRAY holding it was being re-grown.
   */
  it('passes an identity-equal TickInputs and only ever previously-seen actions', () => {
    const { loop, queue, rec } = rig()
    loop.frame(1000)
    let now = 1000
    for (let i = 0; i < 1000; i++) {
      // A live drag: one or two cells entered per frame.
      queue.enqueue('place', i, i + 1)
      if (i % 3 === 0) queue.enqueue('place', i + 1, i + 2)
      now += 16.7
      loop.frame(now)
    }

    expect(rec.advanceCount).toBeGreaterThan(400)
    const inputsIdentities = new Set(rec.inputsSeen)
    expect(inputsIdentities.size, 'more than one TickInputs object reached step').toBe(1)

    const actionIdentities = new Set(rec.actionsSeen)
    expect(rec.actionsSeen.length).toBeGreaterThan(600)
    // Bounded by the pool's high-water mark, which a drag bounds — NOT by the
    // number of events.
    expect(actionIdentities.size).toBeLessThanOrEqual(queue.poolSize)
    expect(actionIdentities.size).toBeLessThan(12)
  })
})
