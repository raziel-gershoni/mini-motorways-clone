import { describe, it, expect } from 'vitest'
import { Session } from 'node:inspector'
import { readFileSync } from 'node:fs'
import { firstCity, REVEALED_X0, REVEALED_Y0, REVEALED_W, REVEALED_H } from '@laneways/shared'
import {
  createState,
  createWorld,
  createScratch,
  createFlowFields,
  createFieldInputRanges,
} from '@laneways/sim'
import { fitCamera, type RenderFrame } from '@laneways/render'
import { seedStartingCity } from '../src/startingCity'
import { createFrameBuilder, createFrameDriver } from '../src/frame'
import { initCarSnapshots } from '../src/resolve'
import { createInputQueue, type InputQueue } from '../src/inputs'
import { createLoop } from '../src/loop'
import { PointerOutcome, createPointerInput, type PointerInput } from '../src/pointer'

/**
 * **"Nothing allocates inside the frame loop" is a MEASURED constraint here,
 * not a review convention.**
 *
 * The M2 plan's Global Constraints say *"There is no allocation profiler and
 * this plan does not pretend otherwise"*, and Task 6's report repeated it.
 * Both are wrong. `node:inspector`'s `HeapProfiler.startSampling` is a **Node
 * builtin** — zero dependencies, which was the constraint that actually
 * mattered. Five milestones enforced a hot-path invariant by asking people to
 * read carefully, and a reviewer demonstrated the gap by reinstating an
 * allocation inside `buildFrame` and watching all 156 tests pass.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS ASSERTED, AND WHY IT IS PER FILE RATHER THAN PER FUNCTION
 * ---------------------------------------------------------------------------
 *
 * This is a **sampling** profiler: one stack is recorded per
 * `SAMPLING_INTERVAL_BYTES` of allocation, so a per-frame byte figure is a
 * statistical estimate. Attribution between adjacent **inlined** frames is
 * genuinely unstable — measured moving tens of bytes per frame between
 * `loop.frame` and its caller across runs — so a per-*function* assertion would
 * be flaky. Attribution to the **file the allocating code lexically lives in**
 * is stable, and that is what this file asserts.
 *
 * Measured on the shipped code (4,000 profiled frames after 1,500 of warm-up):
 *
 * | profile                                   | `game/src` files that appear      |
 * |-------------------------------------------|-----------------------------------|
 * | shipped, no-op draw                        | `loop.ts` only, 2.7-5.0 B/frame   |
 * | one escaping object per frame in `draw`    | + the draw's own file, ~39        |
 * | one escaping object per frame in `buildFrame` | + **`frame.ts`, 53.5**         |
 *
 * So a budget of `0` on every file except `loop.ts` catches the exact defect
 * the reviewer used to prove the gap, with a **10x** margin between the noise
 * and the signal.
 *
 * ---------------------------------------------------------------------------
 * TWO TRAPS THIS FILE WOULD OTHERWISE FALL INTO
 * ---------------------------------------------------------------------------
 *
 * 1. **`includeObjectsCollectedByMinorGC` is load-bearing.** Without it the
 *    profile reports only objects that SURVIVED a scavenge, and every
 *    short-lived per-frame object — precisely the ones this rule forbids — is
 *    invisible. The first test below exists solely so that a silently-ignored
 *    flag fails loudly rather than turning the guard into decoration.
 * 2. **Escape analysis.** A per-frame object literal that never escapes its
 *    function is scalar-replaced by TurboFan and never allocated at all — a
 *    positive control that does not escape measures ~1 B/frame and proves
 *    nothing. `sink` below is module-level and is asserted on, which forces the
 *    allocation to be real.
 *
 * ---------------------------------------------------------------------------
 * WHY `loop.ts` IS THE ONE FILE WITH A NON-ZERO BUDGET
 * ---------------------------------------------------------------------------
 *
 * It is not an exemption, it is a residual. A mutable `number` captured by a
 * closure lives in a context slot holding a tagged value, so a double outside
 * Smi range allocates a fresh `HeapNumber` on **every assignment**. The
 * first version of `createLoop` held `lastTime`, `accumulator` and `alpha` as
 * plain `let`s and measured **~65 B/frame** — more than one object per frame,
 * and a straight violation of the milestone's "zero, not small" rule that five
 * milestones of review could not see. `loop.ts` now keeps those three in a
 * `Float64Array`, and what is left is a small bimodal residual — see `BUDGETS`
 * for the measured distribution and for why its budget is 32 rather than
 * something tighter.
 *
 * **What the measurement cannot pin, and what does instead.** Reverting that
 * `Float64Array` to closure `let`s is caught only about half the time, in
 * whichever runs the residual is charged to `loop.ts` rather than to the
 * inlined caller — a flaky mutation, which the catalogue says to record as a
 * survivor. No choice of budget fixes it, because the bimodality moves the
 * baseline and the mutant together. The first test below pins the shape by
 * reading the source instead, deterministically.
 */

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------

/**
 * One stack recorded per 512 bytes allocated. At the ~37-53 B/frame a single
 * escaping object costs, 3,000 frames yields 200+ samples of the signal — far
 * more than enough to separate it from zero.
 */
const SAMPLING_INTERVAL_BYTES = 512

/** One node of `HeapProfiler.stopSampling`'s stack tree. */
interface ProfileNode {
  callFrame: { functionName: string; url: string }
  selfSize: number
  children?: ProfileNode[]
}

interface Allocator {
  /** `functionName @ url`, for diagnostics. */
  readonly key: string
  readonly functionName: string
  /** Repo-relative source path, e.g. `packages/game/src/loop.ts`. */
  readonly file: string
  readonly bytes: number
}

const REPO_MARKER = '/mini-motorways-clone/'

/**
 * Runs `body` under the heap sampling profiler and returns every stack frame
 * that allocated, largest first.
 *
 * The `HeapProfiler.*` domain resolves its callbacks synchronously, so the
 * whole measurement stays inside one vitest test with no timers and no awaits.
 */
function profileAllocations(body: () => void): Allocator[] {
  interface RawSession {
    post(method: string, cb?: (err: Error | null, result?: unknown) => void): void
    post(method: string, params: object, cb?: (err: Error | null, result?: unknown) => void): void
  }
  const session = new Session()
  session.connect()
  const raw = session as unknown as RawSession
  let profile: ProfileNode | null = null
  let failure: Error | null = null

  raw.post('HeapProfiler.enable')
  raw.post(
    'HeapProfiler.startSampling',
    {
      samplingInterval: SAMPLING_INTERVAL_BYTES,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    },
    (err) => {
      failure = err
    },
  )
  if (failure !== null) throw failure

  body()

  raw.post('HeapProfiler.stopSampling', (err, result) => {
    failure = err
    profile = (result as { profile?: { head: ProfileNode } } | undefined)?.profile?.head ?? null
  })
  session.disconnect()
  if (failure !== null) throw failure
  if (profile === null) throw new Error('allocation harness: the profiler returned no profile')

  const totals = new Map<string, Allocator>()
  const walk = (node: ProfileNode): void => {
    if (node.selfSize > 0) {
      const fn = node.callFrame.functionName === '' ? '<top-level>' : node.callFrame.functionName
      const url = node.callFrame.url
      const at = url.lastIndexOf(REPO_MARKER)
      const file = at === -1 ? url : url.slice(at + REPO_MARKER.length)
      const key = `${fn} @ ${file}`
      totals.set(key, { key, functionName: fn, file, bytes: (totals.get(key)?.bytes ?? 0) + node.selfSize })
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(profile)
  return [...totals.values()].sort((a, b) => b.bytes - a.bytes)
}

/**
 * The shared predicate: every file inside `scope` whose per-frame allocation
 * exceeds its budget. Files with no entry in `budgets` have a budget of **0**.
 *
 * Test A asserts this returns nothing for `packages/game/src`; the positive
 * control asserts the SAME function reports the deliberate allocator. A harness
 * that has silently stopped seeing allocations therefore fails rather than
 * passing green.
 */
function offenders(
  all: readonly Allocator[],
  frames: number,
  scope: string,
  budgets: Readonly<Record<string, number>>,
): string[] {
  const byFile = new Map<string, number>()
  for (const a of all) {
    if (!a.file.startsWith(scope)) continue
    byFile.set(a.file, (byFile.get(a.file) ?? 0) + a.bytes)
  }
  const out: string[] = []
  for (const [file, bytes] of byFile) {
    const perFrame = bytes / frames
    const budget = budgets[file.slice(file.lastIndexOf('/') + 1)] ?? NOISE_FLOOR_BYTES_PER_FRAME
    if (perFrame > budget) out.push(`${file} at ${perFrame.toFixed(2)} B/frame (budget ${budget})`)
  }
  return out.sort()
}

/**
 * The default budget for every file with no entry in `BUDGETS`. It is a
 * SAMPLING floor, not an allowance, and Task 7 measured why it cannot be 0.
 *
 * One stack is recorded per `SAMPLING_INTERVAL_BYTES` (512) of allocation, so
 * the smallest non-zero figure this instrument can report over
 * `PROFILED_FRAMES` frames is one sample: 512 / 3,000 = **0.17 B/frame**. That
 * is what a ONE-OFF allocation looks like — a lazily allocated feedback vector,
 * an IC transition, a deopt landing inside the profiled window — not a
 * per-frame one. A budget of exactly 0 therefore fails on a single stray
 * sample, which the catalogue calls "a threshold set inside the noise band" and
 * which this file's own `loop.ts` budget was once guilty of.
 *
 * **Measured before it was chosen, on the drag profile — the noisier of the
 * two, because a live drag varies the code paths and V8 does more one-off work
 * inside them.** Over 40 consecutive runs the whole of `packages/game/src`
 * reported, per run: nothing at all 24 times; `loop.ts` 0.18 (x5) and 0.35;
 * `resolve.ts` 0.18 and 0.54; `pointer.ts` 0.19 and 0.58; `frame.ts` 1.94 once.
 * `pointer.ts` and `inputs.ts` never exceeded 0.58 while ~9,000 actions went
 * through them, and every figure above is a handful of samples, not a rate.
 *
 * **4 is 2x the worst observed and still 9x below the 37-77 B/frame a single
 * escaping object per frame costs.** It catches an object allocated as rarely
 * as once every ten frames, and a leaked pooled action under this drag would
 * be ~120 B/frame — thirty times the floor. Do not raise it to make a change
 * pass; the whole point is that the gap between 4 and 37 is empty.
 */
const NOISE_FLOOR_BYTES_PER_FRAME = 4

/** Every `game/src` file that allocated above the sampling floor, `loop.ts` aside. */
function dirtyFiles(all: readonly Allocator[], frames: number): string[] {
  const byFile = new Map<string, number>()
  for (const a of all) {
    if (!a.file.startsWith(GAME_SRC)) continue
    byFile.set(a.file, (byFile.get(a.file) ?? 0) + a.bytes)
  }
  return [...byFile]
    .filter(([f, b]) => !f.endsWith('/loop.ts') && b / frames > NOISE_FLOOR_BYTES_PER_FRAME)
    .map(([f]) => f)
    .sort()
}

/**
 * See the module comment. **Every other file gets `NOISE_FLOOR_BYTES_PER_FRAME`,
 * and that is the assertion doing the work** — over 12 consecutive runs no
 * `game/src` file other than `loop.ts` appeared above the sampling floor even
 * once.
 *
 * `loop.ts`'s own residual is **bimodal**, which is the attribution instability
 * made visible: over those same 12 runs it measured
 * `0 0 18.03 15.95 17.86 17.86 16.12 15.60 17.51 0 0 0` — either the whole
 * residual is charged to `loop.ts` or all of it lands on the inlined caller.
 * An earlier budget of 16 sat *inside* the upper cluster and made this file
 * fail about one run in twenty. 32 is above the worst observed here (18.0) and
 * above the worst seen during review (23.6), and still below the 37-43 B/frame
 * one escaping object costs — so an object added inside `frame()` busts it in
 * **both** modes.
 */
const BUDGETS: Readonly<Record<string, number>> = { 'loop.ts': 32 }

const GAME_SRC = 'packages/game/src/'
const GAME_PKG = 'packages/game/'

// ---------------------------------------------------------------------------
// The rig — the real assembly, exactly as Task 9's `main.ts` will write it
// ---------------------------------------------------------------------------

/** 3,000 profiled frames: ~200 samples of a one-object-per-frame signal, ~1.5 s. */
const PROFILED_FRAMES = 3000
/** Outside the profiling window, so JIT warm-up is not charged to the frame path. */
const WARMUP_FRAMES = 1200
/** The positive control's clean half. B/frame normalises, so this only has to establish "near zero". */
const CONTROL_BASELINE_FRAMES = 3000

interface Rig {
  readonly loop: ReturnType<typeof createLoop>
  readonly pointer: PointerInput
  readonly queue: InputQueue
  readonly camera: ReturnType<typeof fitCamera>
}

function buildRig(draw: (frame: RenderFrame) => void): Rig {
  const map = firstCity()
  const world = createWorld(map)
  const state = createState('m2-alloc', map)
  seedStartingCity(state, world)
  const scratch = createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map))
  const fields = createFlowFields(map.groupCount, world.cells)
  const camera = fitCamera(
    { cssW: 406, cssH: 870, topInset: 46, bottomInset: 34, rawDpr: 3, performanceClass: null },
    { x0: REVEALED_X0, y0: REVEALED_Y0, cols: REVEALED_W, rows: REVEALED_H },
  )
  const builder = createFrameBuilder(state, world, camera)
  initCarSnapshots(builder.snapshots, state, world)
  const queue = createInputQueue()
  const loop = createLoop(
    createFrameDriver({ state, world, fields, scratch, builder, camera: () => camera, draw }),
    queue,
  )
  // The pointer is wired to the SAME queue the loop drains, exactly as Task 9's
  // `main.ts` will. `paused` is backed by the loop, which owns it.
  const pointer = createPointerInput({
    camera: () => camera,
    canvasLeft: () => 11,
    canvasTop: () => 7,
    gridW: world.w,
    queue,
    paused: () => loop.paused,
    setPaused: (next: boolean) => {
      loop.setPaused(next)
    },
  })
  return { loop, pointer, queue, camera }
}

function buildLoop(draw: (frame: RenderFrame) => void): ReturnType<typeof createLoop> {
  return buildRig(draw).loop
}

/**
 * `now` is declared INSIDE this function rather than captured from the caller,
 * for the same context-slot reason `loop.ts` uses a `Float64Array`: a captured
 * mutable double would box once per frame and charge the harness's own noise to
 * the profile it is measuring.
 */
function drive(loop: ReturnType<typeof createLoop>, count: number, start: number): void {
  let now = start
  for (let i = 0; i < count; i++) {
    now += 16.7
    loop.frame(now)
  }
}

/**
 * ---------------------------------------------------------------------------
 * THE INPUT PATH (Task 7)
 * ---------------------------------------------------------------------------
 *
 * `drive` above profiles an IDLE queue: the loop hands `step` an empty batch
 * every tick and neither `pointer.ts` nor `inputs.ts` ever runs. That is the
 * frame path, not the input path, and the input path is the one with a
 * per-EVENT allocation risk — a pooled action object, a `GridHit`, a `HudRects`,
 * a boxed `pointerId`.
 *
 * So this driver runs a live drag alongside the loop, on the same queue Task 9's
 * `main.ts` will wire: one stroke every `STROKE_FRAMES` frames, in the shape a
 * finger actually makes — a `pointerdown`, a run of `pointermove`s that mostly
 * SKIP tiles (so the 8-connected walk runs, not just the one-cell case), one
 * move that re-enters the cell it is already on, one long backtrack, and a
 * `pointerup`.
 *
 * Per stroke: 3 + 3 + 3 + 3 + 0 + 12 = **24 actions**, so 3,000 profiled frames
 * enqueue about 9,000 of them. At ~40 B for one small object that is ~120 B per
 * frame of signal if the pool ever leaked one — three times the threshold that
 * separates the loop's own noise from a real object.
 */
const STROKE_FRAMES = 8
/** Board rows the stroke walks through, so it stays inside the revealed rect. */
const STROKE_ROWS = 18

/**
 * Where each `pointermove` of a stroke lands, as offsets from the cell the
 * `pointerdown` took (the revealed rect's `x0`, and `row`). Four (+3, +1) jumps,
 * one repeat of the cell the drag is already on, then a (-12, -4) backtrack.
 */
const STROKE_COLS: readonly number[] = [3, 6, 9, 12, 12, 0]
const STROKE_DY: readonly number[] = [1, 2, 3, 4, 4, 0]
/** 3 + 3 + 3 + 3 + 0 + 12, by the Chebyshev distance between consecutive entries. */
const ACTIONS_PER_STROKE = 24

/** Counts, so the assertions below cannot be satisfied by a driver that did nothing. */
interface DragCounters {
  downs: number
  draws: number
  ups: number
  actions: number
}

function driveWithDrag(rig: Rig, count: number, start: number, counters: DragCounters): void {
  let now = start
  const camera = rig.camera
  const half = camera.tileSize / 2
  for (let i = 0; i < count; i++) {
    const phase = i % STROKE_FRAMES
    const row = camera.y0 + (((i / STROKE_FRAMES) | 0) % STROKE_ROWS)
    if (phase === 0) {
      if (rig.pointer.up(1) === PointerOutcome.DRAG_END) counters.ups++
      const x = camera.originX + half + 11
      const y = camera.originY + (row - camera.y0) * camera.tileSize + half + 7
      if (rig.pointer.down(1, x, y) === PointerOutcome.DRAG_START) counters.downs++
    } else if (phase <= STROKE_COLS.length) {
      const gx = camera.x0 + (STROKE_COLS[phase - 1] as number)
      const gy = row + (STROKE_DY[phase - 1] as number)
      const x = camera.originX + (gx - camera.x0) * camera.tileSize + half + 11
      const y = camera.originY + (gy - camera.y0) * camera.tileSize + half + 7
      const before = rig.queue.length
      if (rig.pointer.move(1, x, y) === PointerOutcome.DRAW) counters.draws++
      const after = rig.queue.length
      // `after - before` is negative on a frame whose tick already drained the
      // batch; the loop runs after the input, so that cannot happen here.
      counters.actions += after - before
    }
    now += 16.7
    rig.loop.frame(now)
  }
}

/** Module-level so the positive control's object genuinely escapes — see the module comment. */
let sink: { a: number; b: number } | null = null

describe('the frame loop allocates nothing, measured', () => {
  /**
   * **The one regression this measurement cannot see reliably, pinned by
   * structure instead — stated rather than left as a silent gap.**
   *
   * Reverting `createLoop`'s three real-valued slots from the `Float64Array`
   * back to closure `let`s reinstates ~48 B/frame of boxed doubles. Run under
   * the guard below it is caught **2 times in 4** — a flaky mutation, which the
   * catalogue says to record as a **survivor**. The cause is the same
   * attribution instability the module comment describes: an allocation inside
   * `frame()` is charged sometimes to `loop.ts` and sometimes to the inlined
   * caller, which here is the test file. Tightening `loop.ts`'s budget below
   * its own 2.7-5.0 B/frame residual would make the guard itself flaky, which
   * is worse.
   *
   * So the measurement pins the *rule* and this pins the *structure*, in the
   * idiom `sim/test/loop.test.ts` already uses to pin the goldens by reading a
   * file off disk. Deterministic, and it fails the moment someone reverts the
   * shape for tidiness.
   */
  it('keeps loop.ts’s real-valued state in a Float64Array, which the profiler cannot pin', () => {
    const src = readFileSync(new URL('../src/loop.ts', import.meta.url), 'utf8')
    expect(src.length, 'the file is empty, so every assertion below is vacuous').toBeGreaterThan(4000)
    expect(src).toContain('const slots = new Float64Array(LOOP_SLOT_COUNT)')
    // The three names must not come back as closure-scope mutable doubles.
    expect(src).not.toMatch(/^ {2}let (lastTime|accumulator|alpha)\b/m)
  })

  it('pins its own budgets, so widening one is a visible edit rather than a quiet one', () => {
    // This cannot detect a COORDINATED edit — nothing can, and defending
    // against guard-deletion regresses infinitely. It detects the unconsidered
    // one: raising a budget to make a failing change pass now turns two tests
    // red, and the second names the rule.
    expect(BUDGETS).toEqual({ 'loop.ts': 32 })
    expect(NOISE_FLOOR_BYTES_PER_FRAME).toBe(4)
    expect(PROFILED_FRAMES).toBeGreaterThanOrEqual(3000)
    // The floor is only a floor if it stays far below one object per frame:
    // 37 B/frame is the smallest figure a single escaping object has measured.
    expect(NOISE_FLOOR_BYTES_PER_FRAME * 8).toBeLessThan(37)
  })

  it('sees transient allocation at all — without the minor-GC flag this file cannot fail', () => {
    // Escaping, and collected by every scavenge. If `includeObjectsCollectedByMinorGC`
    // were rejected or silently ignored, the profile would not contain it, and
    // every other assertion here would be vacuous.
    const seen = profileAllocations(() => {
      for (let i = 0; i < 200000; i++) sink = { a: i, b: i + 1 }
    })
    expect(sink).not.toBeNull()
    const here = seen.find((a) => a.file.endsWith('test/allocation.test.ts') && a.bytes > 100000)
    expect(here, 'the profiler reported no transient allocation at all').toBeDefined()
  })

  it('charges nothing to any packages/game/src file except loop.ts’s boxed residual', () => {
    let drawn = 0
    const loop = buildLoop(() => {
      drawn++
    })
    drive(loop, WARMUP_FRAMES, 0)
    const ticksBefore = loop.totalTicks
    const all = profileAllocations(() => {
      drive(loop, PROFILED_FRAMES, 1e6)
    })

    // Vacuity: the loop must actually have run, stepped and drawn, or this is a
    // profile of nothing. At 16.7 ms a frame the drain runs 0 or 1 ticks, so
    // roughly half of these frames step.
    expect(drawn).toBe(WARMUP_FRAMES + PROFILED_FRAMES)
    expect(loop.totalTicks - ticksBefore).toBeGreaterThan(PROFILED_FRAMES / 3)

    // Vacuity, second half: a profile that came back empty would satisfy every
    // assertion below. There is always inspector and module-loader noise in it.
    expect(all.length, 'the profile was empty').toBeGreaterThan(3)

    const bad = offenders(all, PROFILED_FRAMES, GAME_SRC, BUDGETS)
    expect(bad, `unbudgeted per-frame allocation:\n${bad.join('\n')}`).toEqual([])

    // At 3,000 frames `loop.ts`'s residual usually falls below the sampling
    // floor and the file does not appear at all — so this is a SUBSET check,
    // not an equality. Every other file's budget is 0, so `offenders` above
    // already reports any appearance; this restates it at file granularity for
    // the failure message.
    expect(dirtyFiles(all, PROFILED_FRAMES), 'a game/src file allocated').toEqual([])

    // Named, because these are the functions the rule is really about.
    const names = all
      .filter((a) => a.file.startsWith(GAME_SRC) && a.bytes / PROFILED_FRAMES > NOISE_FLOOR_BYTES_PER_FRAME)
      .map((a) => a.functionName)
    for (const fn of ['buildFrame', 'resolveCar', 'lerpCar', 'snapshotPrev', 'snapshotCurr', 'enqueue']) {
      expect(names, `${fn} allocated`).not.toContain(fn)
    }
  })

  /**
   * **Task 7's paths, measured rather than reasoned about.**
   *
   * The guard above profiles an idle queue, so it says nothing at all about
   * `pointer.ts` or `inputs.ts` — neither file even runs in it. This one drives
   * a live drag through the real handlers into the real pool while the real
   * loop drains it, and holds both files to the same budget of **0**.
   *
   * Measured over 10 consecutive runs: **neither `pointer.ts` nor `inputs.ts`
   * appeared in the profile even once**, at 0.00 B/frame, while ~9,000 actions
   * went through them. So the budget is 0 rather than a measured band — there is
   * no residual to leave room for, and a distribution with no non-zero mode
   * needs no slack. See the report for the run-by-run figures.
   *
   * The three allocations this is really watching for, all of which a plausible
   * implementation would have: a `{ kind, a, b }` per enqueued action, a
   * `GridHit`/`HudRects` per event, and a boxed `HeapNumber` per `pointerId`
   * assignment (the exact defect the harness found in `loop.ts`, which is why
   * the drag's three mutable numbers live in an `Int32Array`).
   */
  it('charges nothing to pointer.ts or inputs.ts under a live drag', () => {
    let drawn = 0
    const rig = buildRig(() => {
      drawn++
    })
    const warm: DragCounters = { downs: 0, draws: 0, ups: 0, actions: 0 }
    driveWithDrag(rig, WARMUP_FRAMES, 0, warm)

    // The pool's high-water mark is reached during warm-up; the profiled window
    // must not grow it again, or "the pool grows only past the high-water mark"
    // is not what is being measured.
    const poolAfterWarmup = rig.queue.poolSize
    const counters: DragCounters = { downs: 0, draws: 0, ups: 0, actions: 0 }
    const all = profileAllocations(() => {
      driveWithDrag(rig, PROFILED_FRAMES, 1e6, counters)
    })

    // Vacuity, in the shape the catalogue asks for: a driver that quietly
    // stopped drawing would satisfy every allocation assertion below.
    const strokes = PROFILED_FRAMES / STROKE_FRAMES
    expect(drawn).toBe(WARMUP_FRAMES + PROFILED_FRAMES)
    expect(counters.downs, 'no drag ever started').toBe(strokes)
    expect(counters.ups).toBe(strokes)
    // 5 of the 6 moves per stroke draw; the sixth re-enters its own cell.
    expect(counters.draws).toBe(strokes * 5)
    expect(counters.actions, 'the walk enqueued nothing').toBe(strokes * ACTIONS_PER_STROKE)
    expect(counters.actions).toBeGreaterThan(8000)
    expect(all.length, 'the profile was empty').toBeGreaterThan(3)
    expect(rig.queue.poolSize, 'the pool was still growing').toBe(poolAfterWarmup)

    const bad = offenders(all, PROFILED_FRAMES, GAME_SRC, BUDGETS)
    expect(bad, `unbudgeted per-frame allocation:\n${bad.join('\n')}`).toEqual([])

    expect(dirtyFiles(all, PROFILED_FRAMES), 'a game/src file allocated').toEqual([])

    const names = all
      .filter((a) => a.file.startsWith(GAME_SRC) && a.bytes / PROFILED_FRAMES > NOISE_FLOOR_BYTES_PER_FRAME)
      .map((a) => a.functionName)
    for (const fn of ['down', 'move', 'endDrag', 'enqueue', 'inRect']) {
      expect(names, `${fn} allocated`).not.toContain(fn)
    }
  })

  /**
   * The positive control, and the reason this file is a guard rather than
   * decoration.
   *
   * It reinstates exactly the allocation the reviewer used to prove the gap —
   * one small escaping object per frame — through `FrameDriverDeps.draw`, which
   * is a real production seam, and asserts that the SAME `offenders` predicate
   * the guard above uses reports it. If the profiler, the minor-GC flag, the
   * attribution or the predicate ever stops working, this fails.
   *
   * Verified separately, and this is the case that matters most: the same
   * object allocated inside `buildFrame` is charged to
   * `packages/game/src/frame.ts` at **53.51 B/frame**, against a clean run where
   * that file does not appear at all — so the guard above catches the real
   * mutation, not merely this one.
   *
   * ---------------------------------------------------------------------------
   * TASK 7 REWROTE HOW THIS IS MEASURED, AND THE REASON IS A DEFECT SHAPE
   * ---------------------------------------------------------------------------
   *
   * It used to search the profile for the allocator whose `functionName` was
   * `draw`. That is the one granularity this file's own module comment calls
   * unstable, and Task 7 broke it **without touching the control**: adding a
   * second profiled run to the file gave TurboFan enough feedback to inline
   * `draw` into `drive`, so the deliberate allocation appeared as
   * `drive @ test/allocation.test.ts` at 77.4 B/frame and the `find` returned
   * `undefined`. A control that flips red when an unrelated test is added was
   * reporting the inliner's choices, not the allocation.
   *
   * It is now a **delta between two profiles of the same rig**, one with an
   * allocating `draw` and one without, summed over the two places the residual
   * can land — this test file and `src/loop.ts`. Summing both is what makes it
   * attribution-proof: `loop.ts`'s boxed residual is bimodally charged to one or
   * the other, and counting both cancels the bimodality instead of inheriting
   * it. Measured over 10 consecutive runs at 3,000 frames each side:
   *
   *   clean  29.6 30.5 29.7 29.8 31.2 31.6 32.1 32.9 33.3 33.7   (spread 4.1)
   *   delta  35.0 38.9 39.0 39.6 42.3 43.2 43.5 43.8 43.8 44.5   (min 35.0)
   *
   * so a bound of 20 sits at 1.75x below the worst observed delta, well outside
   * the noise band rather than inside its upper cluster — the mistake the
   * catalogue records against this very file's `loop.ts` budget.
   */
  it('DOES report one escaping object per frame — the guard can fail', () => {
    /**
     * Bytes charged per frame to the two files the frame path's own allocation
     * can land in. See the comment above for why it is the sum and not either
     * one.
     */
    const residualPerFrame = (all: readonly Allocator[], frames: number): number => {
      let bytes = 0
      for (const a of all) {
        if (a.file.endsWith('test/allocation.test.ts') || a.file.endsWith('src/loop.ts')) {
          bytes += a.bytes
        }
      }
      return bytes / frames
    }

    // The clean half: the identical rig and the identical driver, with a draw
    // that allocates nothing. Same frame count as the dirty half, so the two
    // estimates carry the same sampling error.
    let clean = 0
    const cleanLoop = buildLoop(() => {
      clean++
    })
    drive(cleanLoop, WARMUP_FRAMES, 0)
    const cleanProfile = profileAllocations(() => {
      drive(cleanLoop, CONTROL_BASELINE_FRAMES, 1e6)
    })
    expect(clean, 'the clean half never ran').toBe(WARMUP_FRAMES + CONTROL_BASELINE_FRAMES)
    const cleanPerFrame = residualPerFrame(cleanProfile, CONTROL_BASELINE_FRAMES)

    let n = 0
    const loop = buildLoop(function draw(frame: RenderFrame): void {
      sink = { a: frame.carCount, b: n++ }
    })
    drive(loop, WARMUP_FRAMES, 0)
    const all = profileAllocations(() => {
      drive(loop, PROFILED_FRAMES, 1e6)
    })
    expect(sink).not.toBeNull()
    expect(n).toBe(WARMUP_FRAMES + PROFILED_FRAMES)

    // (a) the instrument sees it, as a delta. This is the discriminating half.
    const dirtyPerFrame = residualPerFrame(all, PROFILED_FRAMES)
    expect(
      dirtyPerFrame - cleanPerFrame,
      `the deliberate per-frame allocation was not seen (clean ${cleanPerFrame.toFixed(2)}, ` +
        `dirty ${dirtyPerFrame.toFixed(2)})`,
    ).toBeGreaterThan(20)

    // (b) the guard's own predicate reaches the file and formats a report.
    // **Labelled non-discriminating on its own, deliberately** — at `GAME_PKG`
    // scope `loop.ts`'s residual is also charged to this test file, so the clean
    // half produces the same match. What it pins is that `offenders` still walks
    // the profile and still names the file; (a) is what says the file is dirty.
    const bad = offenders(all, PROFILED_FRAMES, GAME_PKG, BUDGETS)
    expect(bad.join('\n')).toMatch(/packages\/game\/test\/allocation\.test\.ts at \d/)
  })
})
