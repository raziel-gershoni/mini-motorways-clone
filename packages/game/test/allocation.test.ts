import { describe, it, expect } from 'vitest'
import { Session } from 'node:inspector'
import { readFileSync } from 'node:fs'
import { firstCity, parseMap, REVEALED_X0, REVEALED_Y0, REVEALED_W, REVEALED_H } from '@laneways/shared'
import {
  createState,
  createWorld,
  createScratch,
  createFlowFields,
  createFieldInputRanges,
  snapshot,
  placeHouse,
  placeDestination,
  step,
  DEST_KIND_SQUARE,
  ORIENTATION_S,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  H_SCORE,
  eraseRoad,
  type TickAction,
} from '@laneways/sim'
import { createHudRects, fitCamera, hudRects, type RenderFrame } from '@laneways/render'
import { seedStartingCity } from '../src/startingCity'
import { createFrameBuilder, createFrameDriver } from '../src/frame'
import { initCarSnapshots } from '../src/resolve'
import { createInputQueue, type InputQueue } from '../src/inputs'
import { createLoop } from '../src/loop'
import { CHECKOUT_ROOT, repoRelative } from './allocationPaths'
import {
  buildJamRig,
  jamGhostCells,
  jamQueueLength,
  JAM_STARVED_FIRST_HOUSE_Y,
  JAM_STARVED_HOUSE_COUNT,
} from './jamFixture'
import { PointerOutcome, createPointerInput, type PointerInput } from '../src/pointer'
import { SizingOutcome, bootShell, type ScalableContext, type Shell, type SizableCanvas } from '../src/shell'
import { EraseControlSurface, createEraseControl, type EraseControl } from '../src/eraseControl'

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

/**
 * **The harness must fail loudly when it resolves nothing.** A measurement
 * instrument that reports "clean" while measuring zero files is worse than no
 * instrument, and that is exactly how the worktree failure hid: two guards
 * passed vacuously and only the positive control noticed.
 *
 * Every profile of the real rig contains allocations from this test file itself
 * (`drive`, `profileAllocations`), so `packages/game/` always resolves when the
 * derivation is correct — which makes this a liveness check on the path
 * arithmetic, not on the code under test.
 */
function assertScopeResolves(all: readonly Allocator[], scope: string): void {
  if (all.some((a) => a.file.startsWith(scope))) return
  throw new Error(
    `allocation harness: nothing in the profile resolved under "${scope}", so every ` +
      'budget assertion is vacuous — the path derivation is broken, not the code. ' +
      `CHECKOUT_ROOT=${CHECKOUT_ROOT} sample files: ` +
      all.slice(0, 4).map((a) => a.file).join(' | '),
  )
}

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
      const file = repoRelative(node.callFrame.url)
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
 *
 * ---------------------------------------------------------------------------
 * THERE USED TO BE A SECOND ENTRY, AND IT IS GONE BECAUSE THE VIOLATION IS
 * ---------------------------------------------------------------------------
 *
 * M2 carried `'roads.ts': 128` here as a **known violation**, not an approval:
 * `canPlaceRoad` built a fresh `{ ok, ... }` on every call, measured at 40.6 /
 * 41.7 / 44.3 B per call by this rig and at 38.0-39.4 B/frame by the M2
 * milestone review's less dense one. The entry came with a test asserting the
 * allocation was **still present**, precisely so that fixing it would turn this
 * file red instead of leaving a dead exemption for the next reader to mistake
 * for a real constraint.
 *
 * **M1d Task 1b fixed it and that test went red, so both are deleted.**
 * `canPlaceRoad` now returns module-scope frozen singletons and measures 0.000
 * B/call. `roads.ts` is held to `NOISE_FLOOR_BYTES_PER_FRAME` like every other
 * file, by `allOffenders` — and the test below states the property positively.
 */
const BUDGETS: Readonly<Record<string, number>> = { 'loop.ts': 32 }

const GAME_SRC = 'packages/game/src/'
const GAME_PKG = 'packages/game/'

/**
 * **`packages/sim/src` was profiled by NOTHING, and that made the milestone's
 * "allocation is mechanically enforced" claim false as scoped.**
 *
 * Task 6's review measured `canPlaceRoad` at 40.3-41.4 B/frame, correctly scoped
 * it out of its own task, and handed it to *"whoever owns the perf budget"*.
 * There is no such owner. Task 7 then scoped this harness to
 * `packages/game/src`, and Task 9's draw harness to `packages/render/src` — so
 * the package doing the most work inside the frame loop fell between all three,
 * and every one of them was green about it. The M2 milestone review reproduced
 * the figure independently and this is the closure.
 *
 * Widening the scope is the whole fix. Note what it is NOT: it is not permission
 * to keep allocating in `sim`. See `BUDGETS`.
 */
const SIM_SRC = 'packages/sim/src/'

/** A shared empty action list, so a non-churn tick allocates nothing in the driver. */
const NO_TICK_ACTIONS: readonly TickAction[] = []

/** Every scope this harness holds to a budget. Widening the list is the guard. */
const PROFILED_SCOPES: readonly string[] = [GAME_SRC, SIM_SRC]

/** `offenders` over every profiled scope at once. */
function allOffenders(
  all: readonly Allocator[],
  frames: number,
  budgets: Readonly<Record<string, number>>,
): string[] {
  return PROFILED_SCOPES.flatMap((scope) => offenders(all, frames, scope, budgets)).sort()
}

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
  /** Task 8's shell, so the no-change viewport path is measured rather than reasoned about. */
  readonly shell: Shell
  /** Task 8's erase control, bound to the pointer through the native MainButton path. */
  readonly erase: EraseControl
  /** Client CSS point at the centre of the HUD clock rect, precomputed. */
  readonly clockX: number
  readonly clockY: number
  /** Client CSS point inside the HUD band but on the inert score readout. */
  readonly scoreX: number
}

/**
 * The M0 device, as `bootShell` will measure it. Identical to the metrics the
 * rig used to pass straight to `fitCamera`, so the camera — and therefore every
 * figure in this file's tables — is unchanged by the shell being added.
 */
const RIG_VIEW = {
  cssW: 406,
  cssH: 870,
  topInset: 46,
  bottomInset: 34,
  rawDpr: 3,
  performanceClass: null,
} as const

/**
 * A canvas and a context that record nothing. The shell writes six properties
 * per applied resize and this rig never changes geometry, so after boot they are
 * never written again — which is the property being measured.
 */
function stubCanvas(): SizableCanvas {
  return {
    width: 0,
    height: 0,
    style: { width: '', height: '' },
    getBoundingClientRect: () => ({ left: 11, top: 7 }),
  }
}

function stubContext(): ScalableContext {
  return { setTransform: () => undefined }
}

/** A MainButton that does the least a real one does: hold the handler. */
function installMainButton(): void {
  ;(globalThis as Record<string, unknown>).Telegram = {
    WebApp: {
      isVersionAtLeast: () => true,
      ready: () => undefined,
      expand: () => undefined,
      onEvent: () => undefined,
      MainButton: {
        setText: () => undefined,
        setParams: () => undefined,
        onClick: () => undefined,
        show: () => undefined,
      },
    },
  }
}

function buildRig(draw: (frame: RenderFrame) => void): Rig {
  const map = firstCity()
  const world = createWorld(map)
  const state = createState('m2-alloc', map)
  seedStartingCity(state, world)
  const scratch = createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map))
  const fields = createFlowFields(map.groupCount, world.cells)
  installMainButton()
  const shell = bootShell({
    canvas: stubCanvas(),
    context: stubContext(),
    reveal: { x0: REVEALED_X0, y0: REVEALED_Y0, cols: REVEALED_W, rows: REVEALED_H },
    measure: () => RIG_VIEW,
    rebuildAtlas: () => undefined,
    // The settle pass is run inline: it measures the same viewport, so it is a
    // no-op, and deferring it would leave the second pass outside the window.
    settle: (run) => {
      run()
    },
  })
  const camera = shell.camera
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
  // Precomputed OUTSIDE the profiled window: `hudRects` writes into a
  // caller-owned object, but building one per frame would charge this file's own
  // noise to the measurement it is taking.
  const rects = hudRects(camera, createHudRects())
  const erase = createEraseControl({ host: pointer, createFallback: () => null })
  if (erase.surface !== EraseControlSurface.MAIN_BUTTON) {
    throw new Error('the rig bound the erase control to the wrong surface — it is not measuring the shipped path')
  }
  return {
    loop,
    pointer,
    queue,
    camera,
    shell,
    erase,
    clockX: rects.clock.x + rects.clock.w / 2 + 11,
    clockY: rects.clock.y + rects.clock.h / 2 + 7,
    scoreX: rects.score.x + rects.score.w / 2 + 11,
  }
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
 * finger actually makes.
 *
 * ---------------------------------------------------------------------------
 * IT DRIVES EVERY BRANCH, AND THAT IS A CORRECTION FROM REVIEW
 * ---------------------------------------------------------------------------
 *
 * The first version drove `down` / `move` / `up` on the board and nothing else,
 * so the HUD, `pointercancel`, pause, the second-pointer refusal and the
 * off-grid path were never entered — **the counters below could not distinguish
 * those branches from dead code.** That is the same shape as the harness that
 * resolved zero files and reported "clean": an instrument whose scope silently
 * excludes the thing it is supposed to watch. Each of those branches is now
 * driven and counted, and every count is asserted, so deleting one turns this
 * file red rather than leaving it quietly measuring less.
 *
 * One stroke, twelve frames:
 *
 * | phase | event                                          | outcome                  |
 * |-------|------------------------------------------------|--------------------------|
 * | 0     | `up` or `cancel` (alternating) of the last drag | `DRAG_END`               |
 * | 1     | tap the HUD clock                              | `PAUSE_TOGGLED` (paused) |
 * | 2     | tap the HUD clock again, then the score readout| `PAUSE_TOGGLED`, `HUD_INERT` |
 * | 3     | `down` on the board                            | `DRAG_START`             |
 * | 4-9   | six `move`s: four (+3,+1) jumps, one repeat of  | `DRAW` x5, `IGNORED` x1  |
 * |       | the current cell, one (-12,-4) backtrack        |                          |
 * | 10    | `move` above the grid rect                     | `IGNORED`                |
 * | 11    | `down` from a second `pointerId`               | `REFUSED_SECOND_POINTER` |
 *
 * Per stroke: 3 + 3 + 3 + 3 + 0 + 12 = **24 actions**, so 3,000 profiled frames
 * enqueue 6,000 of them. At ~40 B for one small object that is ~80 B per frame
 * of signal if the pool ever leaked one — twenty times the sampling floor.
 *
 * The pause pair in phases 1 and 2 is deliberate: it exercises `setPaused` in
 * both directions AND leaves the loop running, so one frame in twelve drains no
 * ticks and the rest are unaffected.
 */
const STROKE_FRAMES = 12
/** Board rows the stroke walks through, so it stays inside the revealed rect. */
const STROKE_ROWS = 18
/** The phase at which the board `pointerdown` happens; moves run from the next. */
const PHASE_DOWN = 3
/** The phase at which the off-grid move happens (just past the last board move). */
const PHASE_OFF_GRID = PHASE_DOWN + 1 + 6
/** The phase at which a second pointer tries to take over. */
const PHASE_SECOND = PHASE_OFF_GRID + 1

/**
 * The phase at which the erase control is pressed — **twice**, so the pending
 * mode nets back to `place` and the rest of this driver's arithmetic is
 * unchanged. It is deliberately mid-stroke: that is the case `MainButton` makes
 * reachable (native chrome a second finger can hit), and the stroke's latch is
 * what keeps the actions `place`.
 */
const PHASE_ERASE_PRESS = 5
const PRESSES_PER_STROKE = 2

/**
 * Where each `pointermove` of a stroke lands, as offsets from the cell the
 * `pointerdown` took (the revealed rect's `x0`, and `row`). Four (+3, +1) jumps,
 * one repeat of the cell the drag is already on, then a (-12, -4) backtrack.
 */
const STROKE_COLS: readonly number[] = [3, 6, 9, 12, 12, 0]
const STROKE_DY: readonly number[] = [1, 2, 3, 4, 4, 0]
/** 3 + 3 + 3 + 3 + 0 + 12, by the Chebyshev distance between consecutive entries. */
const ACTIONS_PER_STROKE = 24

/**
 * Counts, so the assertions below cannot be satisfied by a driver that did
 * nothing — one per branch the driver enters, which is what makes "this branch
 * is exercised" checkable rather than assumed.
 */
interface DragCounters {
  downs: number
  draws: number
  ups: number
  cancels: number
  pauses: number
  hudInert: number
  offGrid: number
  refusedSecond: number
  actions: number
  presses: number
  unchangedResizes: number
}

function newCounters(): DragCounters {
  return {
    downs: 0,
    draws: 0,
    ups: 0,
    cancels: 0,
    pauses: 0,
    hudInert: 0,
    offGrid: 0,
    refusedSecond: 0,
    actions: 0,
    presses: 0,
    unchangedResizes: 0,
  }
}

function driveWithDrag(rig: Rig, count: number, start: number, counters: DragCounters): void {
  let now = start
  const camera = rig.camera
  const half = camera.tileSize / 2
  const p = rig.pointer
  for (let i = 0; i < count; i++) {
    const phase = i % STROKE_FRAMES
    const stroke = (i / STROKE_FRAMES) | 0
    const row = camera.y0 + (stroke % STROKE_ROWS)

    /**
     * **Task 8's no-change resize path, driven once per frame as a STRESS.**
     *
     * No client emits `viewportChanged` at 60 Hz, and the comment says so rather
     * than implying otherwise: the property under test is per EVENT, and the
     * rate is a measurement choice — 3,000 repetitions is what gives a sampling
     * profiler enough signal to see a per-event allocation at all. What it
     * catches is an `applySize()` that runs unconditionally, which builds two
     * template-literal CSS strings every time.
     *
     * `fitCamera` itself allocates one `Camera` per measurement, by design and
     * with Task 3's blessing ("it runs at boot, after the fullscreen settle, and
     * on a stable viewportChanged — never per frame"). That allocation lands in
     * `packages/render/src/camera.ts`, outside this harness's `packages/game/src`
     * scope, so it is neither measured here nor claimed to be.
     */
    if (rig.shell.viewportChanged(true) === SizingOutcome.UNCHANGED) counters.unchangedResizes++

    // Task 8's erase control, pressed mid-stroke on the native path. Twice, so
    // the pending mode nets out and every other count below is unaffected.
    if (phase === PHASE_ERASE_PRESS) {
      for (let p = 0; p < PRESSES_PER_STROKE; p++) {
        rig.erase.press()
        counters.presses++
      }
    }

    if (phase === 0) {
      // Alternating, so the `pointercancel` path is a live branch rather than
      // an untaken one. Both must leave the machine in the same state.
      if (stroke % 2 === 0) {
        if (p.up(1) === PointerOutcome.DRAG_END) counters.ups++
      } else if (p.cancel(1) === PointerOutcome.DRAG_END) {
        counters.cancels++
      }
    } else if (phase === 1) {
      if (p.down(1, rig.clockX, rig.clockY) === PointerOutcome.PAUSE_TOGGLED) counters.pauses++
    } else if (phase === 2) {
      if (p.down(1, rig.clockX, rig.clockY) === PointerOutcome.PAUSE_TOGGLED) counters.pauses++
      if (p.down(1, rig.scoreX, rig.clockY) === PointerOutcome.HUD_INERT) counters.hudInert++
    } else if (phase === PHASE_DOWN) {
      const x = camera.originX + half + 11
      const y = camera.originY + (row - camera.y0) * camera.tileSize + half + 7
      if (p.down(1, x, y) === PointerOutcome.DRAG_START) counters.downs++
    } else if (phase > PHASE_DOWN && phase < PHASE_OFF_GRID) {
      const k = phase - PHASE_DOWN - 1
      const gx = camera.x0 + (STROKE_COLS[k] as number)
      const gy = row + (STROKE_DY[k] as number)
      const x = camera.originX + (gx - camera.x0) * camera.tileSize + half + 11
      const y = camera.originY + (gy - camera.y0) * camera.tileSize + half + 7
      const before = rig.queue.length
      if (p.move(1, x, y) === PointerOutcome.DRAW) counters.draws++
      // `after - before` cannot be negative: the loop runs after the input.
      counters.actions += rig.queue.length - before
    } else if (phase === PHASE_OFF_GRID) {
      // One CSS px above the grid rect, x inside it: the `region !== GRID`
      // branch in `move`, which nothing used to enter.
      const before = rig.queue.length
      if (p.move(1, camera.originX + half + 11, camera.originY - 1 + 7) === PointerOutcome.IGNORED) {
        counters.offGrid++
      }
      counters.actions += rig.queue.length - before
    } else if (phase === PHASE_SECOND) {
      const y = camera.originY + (row - camera.y0) * camera.tileSize + half + 7
      if (p.down(2, camera.originX + half + 11, y) === PointerOutcome.REFUSED_SECOND_POINTER) {
        counters.refusedSecond++
      }
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
    // **Exactly ONE entry**, and it is a measured residual of code that
    // allocates nothing — not an allowance for code that does. M1d Task 1b
    // deleted the second (`'roads.ts': 128`, M2's carried `canPlaceRoad`
    // violation) by fixing the violation; see `BUDGETS`. A second entry
    // appearing here is the edit this test exists to make visible, and the
    // question to ask of it is "is this a residual or an allowance?".
    expect(BUDGETS).toEqual({ 'loop.ts': 32 })
    expect(NOISE_FLOOR_BYTES_PER_FRAME).toBe(4)
    expect(PROFILED_FRAMES).toBeGreaterThanOrEqual(3000)
    // The floor is only a floor if it stays far below one object per frame:
    // 37 B/frame is the smallest figure a single escaping object has measured.
    expect(NOISE_FLOOR_BYTES_PER_FRAME * 8).toBeLessThan(37)
    // The scope list is the fix for `packages/sim/src` being profiled by
    // nothing. Narrowing it back is how that recurs, so it is pinned too.
    expect([...PROFILED_SCOPES].sort()).toEqual(['packages/game/src/', 'packages/sim/src/'])
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

    // The scope must resolve something, or every assertion below is vacuous.
    assertScopeResolves(all, GAME_PKG)

    assertScopeResolves(all, SIM_SRC)
    const bad = allOffenders(all, PROFILED_FRAMES, BUDGETS)
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
    // `advanceDraw` and `drawCar` joined the list with the car-launch
    // smoothing: `advanceDraw` runs once per slot per drain and `drawCar` once
    // per live car per frame, both holding per-slot state in preallocated typed
    // arrays. `lerpCar` stays on the list even though the frame path no longer
    // calls it: it is the exact-position oracle every smoothing assertion is
    // measured against, so an allocation in it would turn the instrument red
    // rather than the code, and this file's own catalogue entry is that a name
    // drops off a list like this silently.
    for (const fn of [
      'buildFrame',
      'resolveCar',
      'lerpCar',
      'drawCar',
      'advanceDraw',
      'snapshotPrev',
      'snapshotCurr',
      'enqueue',
    ]) {
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
    const warm = newCounters()
    driveWithDrag(rig, WARMUP_FRAMES, 0, warm)

    // The pool's high-water mark is reached during warm-up; the profiled window
    // must not grow it again, or "the pool grows only past the high-water mark"
    // is not what is being measured.
    const poolAfterWarmup = rig.queue.poolSize
    const counters = newCounters()
    const all = profileAllocations(() => {
      driveWithDrag(rig, PROFILED_FRAMES, 1e6, counters)
    })

    // Vacuity, one assertion per branch the driver claims to enter. A driver
    // that quietly stopped entering one would otherwise satisfy every
    // allocation assertion below while measuring less — the same shape as a
    // harness that resolves zero files and reports "clean".
    const strokes = PROFILED_FRAMES / STROKE_FRAMES
    expect(drawn).toBe(WARMUP_FRAMES + PROFILED_FRAMES)
    expect(counters.downs, 'no drag ever started').toBe(strokes)
    // up and cancel alternate, so both end-of-drag branches are live.
    expect(counters.ups, 'the pointerup branch was never entered').toBe(strokes / 2)
    expect(counters.cancels, 'the pointercancel branch was never entered').toBe(strokes / 2)
    expect(counters.ups + counters.cancels).toBe(strokes)
    // 5 of the 6 board moves per stroke draw; the sixth re-enters its own cell.
    expect(counters.draws).toBe(strokes * 5)
    expect(counters.pauses, 'the HUD clock branch was never entered').toBe(strokes * 2)
    expect(counters.hudInert, 'the inert-HUD branch was never entered').toBe(strokes)
    expect(counters.offGrid, 'the off-grid branch was never entered').toBe(strokes)
    expect(counters.refusedSecond, 'the second-pointer branch was never entered').toBe(strokes)
    // Task 8's two paths, counted for the same reason as everything above it: a
    // driver that quietly stopped entering one would leave `shell.ts` and
    // `eraseControl.ts` measured clean while being unreachable, which is
    // indistinguishable from dead code.
    expect(counters.presses, 'the erase control was never pressed').toBe(strokes * PRESSES_PER_STROKE)
    expect(counters.unchangedResizes, 'the no-change resize path was never entered').toBe(PROFILED_FRAMES)
    // The presses must net out, or the strokes below are erasing.
    expect(rig.pointer.eraseMode).toBe(false)
    // and the pause pair must net out, or the loop stopped ticking.
    expect(rig.loop.paused).toBe(false)
    expect(counters.actions, 'the walk enqueued nothing').toBe(strokes * ACTIONS_PER_STROKE)
    expect(counters.actions).toBeGreaterThan(5000)
    expect(all.length, 'the profile was empty').toBeGreaterThan(3)
    expect(rig.queue.poolSize, 'the pool was still growing').toBe(poolAfterWarmup)
    assertScopeResolves(all, GAME_PKG)

    assertScopeResolves(all, SIM_SRC)
    const bad = allOffenders(all, PROFILED_FRAMES, BUDGETS)
    expect(bad, `unbudgeted per-frame allocation:\n${bad.join('\n')}`).toEqual([])

    expect(dirtyFiles(all, PROFILED_FRAMES), 'a game/src file allocated').toEqual([])

    const names = all
      .filter((a) => a.file.startsWith(GAME_SRC) && a.bytes / PROFILED_FRAMES > NOISE_FLOOR_BYTES_PER_FRAME)
      .map((a) => a.functionName)
    for (const fn of ['down', 'move', 'endDrag', 'enqueue', 'inRect', 'press', 'render', 'resize']) {
      expect(names, `${fn} allocated`).not.toContain(fn)
    }
  })

  /**
   * **`packages/sim/src/roads.ts` used to be a KNOWN VIOLATION carried by this
   * file, and M1d Task 1b fixed it. This is the test that replaced the
   * allowance, stating the property positively.**
   *
   * `canPlaceRoad` runs inside the tick — one call per `place` action in the
   * input log — and built a fresh `{ ok, ... }` on every one of them. Three
   * consecutive harnesses were green about it: Task 6's scoped it out and
   * handed it to an owner that did not exist, Task 7's scoped to
   * `packages/game/src`, Task 9's draw harness to `packages/render/src` — so
   * the package doing the most work in the frame loop was covered by none of
   * them. It measured 40.6 / 41.7 / 44.3 B per call in this rig before the fix
   * and **0.000 after**; it now returns module-scope frozen singletons.
   *
   * **The allowance did its job on the way out**, and that is worth recording
   * because it is the reason the entry was deleted rather than loosened: the
   * previous version of this test asserted the allocation was *still present*,
   * so the fix turned it red with its own message. `BUDGETS` lost `'roads.ts'`
   * in the same commit, which is what puts the file back under
   * `NOISE_FLOOR_BYTES_PER_FRAME` in `allOffenders` alongside every other file.
   *
   * Three assertions, and each one exists for a different reason:
   *
   * 1. **Absent under a live drag**, where it used to appear. This is the half
   *    that would have caught the original defect.
   * 2. **Pinned per CALL, not per frame.** A per-frame figure is a fact about
   *    the driver: this rig enqueues `ACTIONS_PER_STROKE / STROKE_FRAMES` = 2
   *    actions a frame and measured 81-89 B/frame before the fix, while the M2
   *    milestone review's one-action-a-frame rig measured 38.0-39.4 — the same
   *    ~40 B/call seen through two drag densities. The per-call form is the
   *    rig-independent quantity and it is what a future rig can be compared
   *    against.
   * 3. **Absent when idle**, which is how it hid for three harnesses: the frame
   *    path never touches `roads.ts`, only the input path does. Kept as a
   *    control on the *other* direction — a zero here is not evidence of
   *    anything, so the drag arm above is the one carrying the weight, and
   *    `counters.actions` is asserted so the drag arm cannot be a zero for the
   *    same uninteresting reason.
   *
   * **The floor cannot be 0** — see `NOISE_FLOOR_BYTES_PER_FRAME`. A sampling
   * profiler's smallest reportable non-zero figure over 3,000 frames is 0.17
   * B/frame, so both bounds below are the floor scaled into per-call terms
   * rather than a literal zero: at 6,000 calls the floor is
   * `4 * 3000 / 6000` = 2 B/call, against the 40+ the fix removed and the 69.9
   * B/call an injected escaping object measures. The gap between them is empty.
   */
  it('charges nothing to sim/roads.ts — canPlaceRoad allocates 0 B per call, drag and idle', () => {
    const rig = buildRig(() => undefined)
    const counters = newCounters()
    driveWithDrag(rig, WARMUP_FRAMES, 0, newCounters())
    const all = profileAllocations(() => {
      driveWithDrag(rig, PROFILED_FRAMES, 1e6, counters)
    })
    assertScopeResolves(all, SIM_SRC)
    // Vacuity: without actions `canPlaceRoad` never runs and a zero below means
    // nothing at all. This is the assertion that separates "clean" from
    // "measured nothing".
    expect(counters.actions, 'no actions, so canPlaceRoad never ran').toBeGreaterThan(5000)

    const bytes = all
      .filter((a) => a.file === 'packages/sim/src/roads.ts')
      .reduce((sum, a) => sum + a.bytes, 0)
    const perFrame = bytes / PROFILED_FRAMES
    const perCall = bytes / counters.actions
    /** The sampling floor expressed per call, for this rig's call density. */
    const floorPerCall = (NOISE_FLOOR_BYTES_PER_FRAME * PROFILED_FRAMES) / counters.actions

    // 1 and 2. Absent under a live drag, per call.
    expect(perFrame, `sim/roads.ts allocates ${perFrame.toFixed(2)} B/frame under a live drag`).toBeLessThan(
      NOISE_FLOOR_BYTES_PER_FRAME,
    )
    expect(perCall, `canPlaceRoad allocates ${perCall.toFixed(3)} B/call`).toBeLessThan(floorPerCall)
    // The floor must stay far below the thing it is watching for, or "under the
    // floor" stops meaning anything: one escaping object per call is 40-70.
    expect(floorPerCall * 8).toBeLessThan(25)

    // 3. Still absent when idle. Same rig, same frame count, no input at all.
    const idle = buildLoop(() => undefined)
    drive(idle, WARMUP_FRAMES, 0)
    const idleProfile = profileAllocations(() => {
      drive(idle, PROFILED_FRAMES, 1e6)
    })
    assertScopeResolves(idleProfile, SIM_SRC)
    const idleBytes = idleProfile
      .filter((a) => a.file === 'packages/sim/src/roads.ts')
      .reduce((sum, a) => sum + a.bytes, 0)
    expect(idleBytes / PROFILED_FRAMES, 'roads.ts allocates with an EMPTY queue').toBeLessThan(
      NOISE_FLOOR_BYTES_PER_FRAME,
    )
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

    // (b) **the scope guard, and calling it anything less is what let a Critical
    // through.** This is the only assertion in the file that requires
    // `offenders` to resolve a real repo-relative path and name it; when the
    // path derivation broke in a worktree, the two guards above passed
    // vacuously and THIS is what went red. Task 7's report downgraded it to
    // "non-discriminating" on the grounds that `loop.ts`'s residual also lands
    // on this file — true, and beside the point: it does not discriminate
    // DIRTINESS, it discriminates the harness pointing at something from the
    // harness pointing at nothing. `assertScopeResolves` now states that
    // directly at every call site; this stays as the end-to-end form of it.
    assertScopeResolves(all, GAME_PKG)
    const bad = offenders(all, PROFILED_FRAMES, GAME_PKG, BUDGETS)
    expect(bad.join('\n')).toMatch(/packages\/game\/test\/allocation\.test\.ts at \d/)
  })
})

// ---------------------------------------------------------------------------
// The TICK side — M1d Task 2
// ---------------------------------------------------------------------------

/**
 * **The frame-loop rig above cannot see the sim's movement code, and that is
 * why this section exists.**
 *
 * `buildLoop`/`buildRig` paint the pointer in the revealed rect's top-left
 * corner and never connect a house to a destination, so measured over 1,752
 * ticks **all six live cars stay `PHASE_IDLE`**. `advanceCar` never crosses a
 * cell, `completeTrip` never runs, and every branch M1d adds is profiled at
 * zero executions — clean regardless of what it does. Injecting an allocation
 * into `claimCell` leaves every test above **green**.
 *
 * That is the fourth time this harness has passed while not covering the new
 * thing: silently inert in every worktree; never run with a live drag;
 * `sim/src` unscoped entirely; and then live but blind to the tick. The pattern
 * is that **the scope never follows the code**, so this section is written to
 * be extended rather than duplicated — Task 9 widens the same rig to the jam
 * fixture, `REFUSED_OCCUPIED`, `ENTER_VALVE` and the ghost pass.
 *
 * ---------------------------------------------------------------------------
 * WHY THE INVARIANT IS PER CROSSING, NOT PER TICK
 * ---------------------------------------------------------------------------
 *
 * The catalogue's rule that a per-frame figure is a property of the driver
 * applies here with teeth. `claimCell` runs once per **crossing**, and a car
 * crosses a cell about every 7.6 ticks — so on a one-car rig an injected object
 * per claim measures **1.88 B/tick**, *under* the 4 B floor, and the guard
 * passes while the violation is real. The fix is the one `canPlaceRoad` already
 * uses: count the calls and assert per call. This rig also runs **32 cars at
 * once** so the crossing density is ~4.2/tick rather than 0.13.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLEAN WINDOW CONTAINS NO ARRIVAL
 * ---------------------------------------------------------------------------
 *
 * A flow-field rebuild allocates, in `flowfield.ts` and `roads.ts` — pre-existing,
 * unrelated to this task, and measured at 9.9 and 6.5 B/tick across a window
 * with 15 pin changes in it. Left in the window it would swamp a 4 B floor and
 * force a budget entry, which is the "raise the budget to make it pass" move
 * this file forbids. So the corridor is an **88-step snake** and the houses sit
 * at the far end of it: no car can arrive for ~550 ticks, `pinMoves === 0` is
 * asserted over the window, and the whole of `packages/sim/src` then measures
 * **absent from the profile entirely**. A second window is profiled *with*
 * arrivals so `completeTrip`'s release is covered too; there the assertion is
 * scoped to the three files this task changed rather than to `offenders`,
 * because the rebuild charge is legitimate and not mine.
 *
 * **And that split turns out to decide which of the two windows needs a
 * minimum-over-windows statistic, which is worth writing down because the
 * obvious guess is "both".** The stray `<top-level>` attributions that made the
 * completion bound flaky (see that test) ride on the rebuild allocation: they
 * are the sampler resolving a stack inside ~185 KB of `computeFlowField` work
 * to some sim module's script frame. The clean window is rebuild-free by
 * construction — `pinMoves === 0` is asserted — and measures **the whole of
 * `packages/sim/src` absent from the profile, in 12 of 12 full-suite runs under
 * load**. So it is not exposed, and it keeps its single-draw `offenders`
 * assertion. Do not "carry the fix across" without re-measuring: a minimum over
 * windows there would cost three times the profiling for no coverage.
 */

const TICK_RIG_W = 40
const TICK_RIG_H = 30
const TICK_RIG_ROW = 28
const TICK_RIG_COL = 38
/** Ticks profiled in the clean (no-arrival, no-rebuild) window. */
const PROFILED_TICKS = 400
/**
 * Ticks profiled in EACH of the completion windows.
 *
 * **Raised from 900 to 2,600 by M1d Task 3, and the reason is the milestone
 * landing rather than a loosened bound.** This rig is 32 cars on a 19-cell
 * corridor with the carpark in the middle of it, which is a jam the moment
 * `canEnter` starts refusing entries: measured throughput fell from ~630
 * completed trips per 900 ticks to **225** (four consecutive windows: 224, 226,
 * 225, 229), and crossings from ~2,600 to ~1,110. Both of that test's vacuity
 * floors — 400 completions and 2,000 crossings — are floors on the SIGNAL its
 * bound is derived from, so the honest repair is a longer window, not a smaller
 * floor. At 2,600 ticks the rig turns over 652 completions and 3,218 crossings,
 * reproducibly, for ~100 ms of driving.
 *
 * It is also why the window length is worth keeping now that the bound is a
 * rate: a longer window makes each stray sample a SMALLER per-trip figure
 * (10,144 B is 45 B/trip over 225 trips and 15.6 over 652), so the length and
 * the minimum-over-windows work in the same direction.
 */
const ARRIVAL_TICKS = 2600
/**
 * Independent windows the CLEAN tick bound takes the minimum over — M1d Task 5.
 *
 * It was a single draw until Task 5 re-measured the premise that justified that;
 * see the test itself for the figures and for why the premise expired.
 */
const CLEAN_WINDOWS = 3

/** Ticks the completion-dense rig needs before every car is in flight. */
const DENSE_WARMUP = 120
/**
 * Independent profiled windows the completion bound takes the **minimum** over.
 *
 * See `THE COMPLETION WINDOW'S INSTRUMENT` below for why a minimum rather than a
 * single draw. Three, because a stray lands on any one file in about a fifth of
 * windows, so the chance of all three being hit is ~0.8%.
 */
const COMPLETION_WINDOWS = 3

/**
 * Per-completed-trip allocation a file may be charged before it counts as
 * allocating, in **bytes per trip**.
 *
 * A rate, not a total: the invariant is "one escaping object per completed trip
 * is a violation", which does not get more or less true as the window
 * lengthens. The previous absolute bound (2,048 B) silently tightened every
 * time the window grew — 652 trips would breach it at 3.1 B/trip and 1,304 at
 * 1.6 — which is a threshold that drifts toward the noise on its own.
 *
 * 8 is derived at both ends below.
 */
const COMPLETION_BUDGET_BYTES_PER_TRIP = 8
/**
 * Independent profiled windows the ghost bound takes the **minimum** over.
 *
 * Four rather than the completion bound's three, and the extra one is bought
 * with measurement rather than caution: this window is noisier than the
 * completion window because it is not rebuild-free by construction but by
 * arrangement, and across nine baseline draws at three windows the `roads.ts`
 * floor was 0.000 in eight and **2.480** in the ninth — a stray that happened to
 * land on the same file in all three. A fourth window makes that coincidence
 * rarer at a cost of ~50 ms.
 */
const GHOST_WINDOWS = 3

/**
 * Ticks profiled in each ghost window, and how often the churn segment is
 * erased and re-placed inside them.
 *
 * **Both were cut from 400/every tick after this window was measured for its
 * effect on the REST of the file.** The clean window above holds `packages/sim`
 * to an absolute 4 B/frame, which is load-sensitive: with this window at
 * 4 x 400 ticks and a churn every tick, full-suite runs put a persistent
 * 5.2-6.7 B/frame on `hash.ts` — a pure integer FNV loop that cannot allocate,
 * i.e. the sampler resolving somebody else's allocation onto whatever frame was
 * on top — and the clean window went red in 1 run of 6. With this window
 * skipped it was 0 of 6, so the cause was the profiling load rather than any
 * source change. 3 x 250 ticks with a churn every third tick keeps every
 * counter well above its vacuity floor and takes the suite back to 0 of 12.
 * That is the catalogue's "a test that reads the JIT's attribution is a test
 * another test can turn red", arriving from the direction of CPU load rather
 * than of inlining.
 */
const GHOST_TICKS = 150
const GHOST_CHURN_EVERY = 3

/**
 * Per-ghost-event allocation a file may be charged before it counts as
 * allocating, in **bytes per ghost event** — M1d Task 5.
 *
 * A rate, not a total, for the reason `COMPLETION_BUDGET_BYTES_PER_TRIP` is one,
 * and a **delta** (treatment minus matched control) rather than a raw figure —
 * the test says why a minimum could not do the job here.
 *
 * **Both ends measured on the instrument and the window size that ship**
 * (3 treatment/control pairs x 150 ticks, 1,336 ghost events per window):
 *
 *   - **above the noise.** Six baseline draws: the floor was **0.00 on every
 *     file in five of them** and 1.29 (`roads.ts`) in the sixth. Negative floors
 *     are normal and are the instrument working — they mean the per-process blob
 *     landed on the control.
 *   - **below the signal.** Three escaping injections, one per new call site,
 *     each `(globalThis as any).__sink = {...}` so the object genuinely ESCAPES
 *     — a NON-escaping local is deleted by V8's scalar replacement and reads
 *     exactly like a blind harness, which is the trap the catalogue records.
 *     Floors, three draws each: `isCommittedTo` (dispatch.ts) **166.86 / 165.20
 *     / 163.14**; `canEnter`'s ghost branch (blocking.ts) **24.35 / 24.35 /
 *     24.82**; `noteGhostDeparture` (roads.ts) **13.44 / 15.12 / 15.02** — the
 *     quietest of the three, because it fires once per departure rather than
 *     once per commitment walk, and therefore the one the margin is measured
 *     against. All three are treatment-only by construction: the control has no
 *     ghost, so none of the three sites is entered in it.
 *
 * So 4 is **3.1x above the worst baseline excursion and 3.4x below the quietest
 * signal**, with the gap between them empty.
 */
const GHOST_BUDGET_BYTES_PER_EVENT = 4

/** Enough ticks for every car to be dispatched and moving before the window opens. */
const TICK_WARMUP = 80
/** A throwaway rig driven this far first, so the clean window is not measuring first-call costs. */
const JIT_WARMUP_TICKS = 3000

const DENSE_W = 30
const DENSE_H = 20
const DENSE_ROW = 18
const DENSE_CARPARK_X = 10

interface DenseRig {
  readonly state: ReturnType<typeof createState>
  drive(n: number): { crossings: number; completions: number }
  readonly houses: number
}

interface TickRig {
  readonly state: ReturnType<typeof createState>
  /** Exposed for M1d Task 5's ghost window, which erases the corridor by hand. */
  readonly world: ReturnType<typeof createWorld>
  /** Advances `n` ticks and returns what actually happened in them. */
  drive(n: number): { crossings: number; pinMoves: number; completions: number }
  /** One tick with a caller-supplied action list — the ghost window's churn. */
  step(actions: readonly TickAction[]): void
  readonly houses: number
}

/**
 * 32 cars on one 88-step snake corridor, all colour 0, all routed to one
 * carpark. Houses stand ON the corridor (road-legal by design), at the far end,
 * so every route is 73-88 steps.
 */
function buildTickRig(seed: string): TickRig {
  const rows = Array.from({ length: TICK_RIG_H }, () => '.'.repeat(TICK_RIG_W))
  const map = parseMap('tick-alloc-rig', rows, 9999, 16, 4, 5)
  const world = createWorld(map)
  const state = createState(seed, map)
  const scratch = createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map))
  const fields = createFlowFields(map.groupCount, world.cells)
  if (!placeDestination(state, world, 1 * TICK_RIG_W + TICK_RIG_COL, ORIENTATION_S, 0, DEST_KIND_SQUARE)) {
    throw new Error('tick rig: the destination did not place')
  }
  let houses = 0
  for (let y = 1; y <= 16; y++) {
    if (placeHouse(state, world, y * TICK_RIG_W + 1, 0)) houses++
  }
  const actions: TickAction[] = []
  for (let y = 1; y < TICK_RIG_ROW; y++) {
    actions.push({ kind: 'place', a: y * TICK_RIG_W + 1, b: (y + 1) * TICK_RIG_W + 1 })
  }
  for (let x = 1; x < TICK_RIG_COL; x++) {
    actions.push({ kind: 'place', a: TICK_RIG_ROW * TICK_RIG_W + x, b: TICK_RIG_ROW * TICK_RIG_W + x + 1 })
  }
  for (let y = TICK_RIG_ROW; y > 4; y--) {
    actions.push({ kind: 'place', a: y * TICK_RIG_W + TICK_RIG_COL, b: (y - 1) * TICK_RIG_W + TICK_RIG_COL })
  }
  step(state, world, fields, scratch, { actions })
  // Written directly, exactly as a pin fire would: a big supply, so every car
  // can reserve and the demand timer never has to be waited out.
  state.destPins[0] = 200
  const noActions: { actions: TickAction[] } = { actions: [] }
  const prev = Array.from(state.carCell) as number[]
  let lastPins = state.destPins[0] as number
  let lastScore = state.header[H_SCORE] as number
  // **A mutable holder whose `actions` is REASSIGNED, never `length = 0` and
  // re-pushed.** The first draft of the ghost window did the latter and the
  // profile immediately charged 33.8 B/tick — `length = 0` right-trims a JS
  // array's backing store and the next `push` re-grows it, which is the exact
  // 152 B/clear defect the catalogue records against `inputs.ts`. The harness
  // caught it in its own driver on the first run, which is the harness working;
  // it is recorded here so the shape is not reintroduced.
  const oneTick: { actions: readonly TickAction[] } = { actions: [] }
  return {
    state,
    world,
    houses,
    step(actions: readonly TickAction[]) {
      oneTick.actions = actions
      step(state, world, fields, scratch, oneTick)
    },
    drive(n: number) {
      let crossings = 0
      let pinMoves = 0
      for (let i = 0; i < n; i++) {
        step(state, world, fields, scratch, noActions)
        for (let c = 0; c < state.carCell.length; c++) {
          if (state.carCell[c] !== prev[c]) crossings++
          prev[c] = state.carCell[c] as number
        }
        if (state.destPins[0] !== lastPins) {
          pinMoves++
          lastPins = state.destPins[0] as number
        }
      }
      const score = state.header[H_SCORE] as number
      const completions = score - lastScore
      lastScore = score
      return { crossings, pinMoves, completions }
    },
  }
}

/**
 * 32 cars on a SHORT corridor with the carpark in the middle of it, so trips
 * turn over fast — **652 completed trips per `ARRIVAL_TICKS` = 2,600**, against
 * 32 for the snake rig above. Built for `completeTrip` density and nothing else
 * — it is rebuild-heavy by construction, because every arrival consumes a pin.
 *
 * **This said "~630 completed trips per 900 ticks" until M1d Task 9, which is
 * the rig's PRE-BLOCKING figure and was contradicted by `ARRIVAL_TICKS`'s own
 * doc comment 200 lines above.** That comment records the transition correctly:
 * once `canEnter` began refusing entries in Task 3, throughput on this rig fell
 * from ~630 per 900 ticks to **225**, which is why the window was lengthened to
 * 2,600 rather than the vacuity floors being lowered. Re-measured at the close
 * of the milestone: **224 per 900 ticks and 652 per 2,600** — the same rate,
 * 0.249 vs 0.251 trips/tick.
 *
 * The stale figure cost real time, because 630 is *also* roughly what this rig
 * completes over 2,600 blocked ticks, so "630" reads as current under one window
 * and as pre-blocking under the other. Both the number and the window it is
 * measured over are stated above for that reason.
 */
function buildDenseTripRig(seed: string): DenseRig {
  const rows = Array.from({ length: DENSE_H }, () => '.'.repeat(DENSE_W))
  // groupCount 2, not 5: this rig triggers a rebuild on nearly every tick and
  // the Dijkstra cost is per colour.
  const map = parseMap('dense-trip-rig', rows, 9999, 16, 4, 2)
  const world = createWorld(map)
  const state = createState(seed, map)
  const scratch = createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map))
  const fields = createFlowFields(map.groupCount, world.cells)
  // Origin (10,15) orientation S: footprint x 10-11 / y 15-17, carpark (10,18)
  // — which sits ON the corridor, mid-way along it.
  if (!placeDestination(state, world, 15 * DENSE_W + DENSE_CARPARK_X, ORIENTATION_S, 0, DEST_KIND_SQUARE)) {
    throw new Error('dense rig: the destination did not place')
  }
  let houses = 0
  for (let x = 1; x <= 20 && houses < 16; x++) {
    if (x === DENSE_CARPARK_X) continue
    if (placeHouse(state, world, DENSE_ROW * DENSE_W + x, 0)) houses++
  }
  const actions: TickAction[] = []
  for (let x = 1; x < 20; x++) {
    actions.push({ kind: 'place', a: DENSE_ROW * DENSE_W + x, b: DENSE_ROW * DENSE_W + x + 1 })
  }
  step(state, world, fields, scratch, { actions })
  state.destPins[0] = 255
  const noActions: { actions: TickAction[] } = { actions: [] }
  const prev = Array.from(state.carCell) as number[]
  let lastScore = state.header[H_SCORE] as number
  return {
    state,
    houses,
    drive(n: number) {
      let crossings = 0
      for (let i = 0; i < n; i++) {
        // Topped up rather than waited out: `destPins` is a Uint8 and the 652
        // trips this rig turns over in an `ARRIVAL_TICKS` window would exhaust
        // any single fill several times.
        if ((state.destPins[0] as number) < 60) state.destPins[0] = 255
        step(state, world, fields, scratch, noActions)
        for (let c = 0; c < state.carCell.length; c++) {
          if (state.carCell[c] !== prev[c]) crossings++
          prev[c] = state.carCell[c] as number
        }
      }
      const score = state.header[H_SCORE] as number
      const completions = score - lastScore
      lastScore = score
      return { crossings, completions }
    },
  }
}

/** Bytes the profile charges to one `packages/sim/src` file. */
function bytesIn(all: readonly Allocator[], file: string): number {
  return all.filter((a) => a.file === `packages/sim/src/${file}`).reduce((sum, a) => sum + a.bytes, 0)
}

/**
 * The three files M1d Tasks 2 and 3 changed on the tick path.
 *
 * Task 3 added `canEnter` and the refusal branch to the first two of them, so
 * the scope already covers the new code — but "already covered" is exactly the
 * claim this harness has been wrong about four times across two milestones, so
 * liveness was re-proved by injecting into `canEnter` and into the refusal
 * branch specifically rather than inherited from Task 2's proof. See the task
 * report's allocation section for the figures.
 */
const TASK2_TICK_FILES = ['blocking.ts', 'cars.ts', 'trips.ts'] as const

/**
 * The five files M1d Task 5's ghost path runs in, and the two that are NEW to
 * this harness.
 *
 * `roads.ts` (`eraseRoad`'s deferral, `placeRoad`'s payment,
 * `noteGhostDeparture`) and `dispatch.ts` (`isCommittedTo`,
 * `countCommittedCars`) were inside `SIM_SRC` all along and therefore inside
 * `offenders`' scope — and "already covered by the scope" is precisely the
 * claim this harness has been wrong about four times in two milestones. The
 * scope was never the problem; the DRIVER was. Neither of those two functions
 * had ever been executed inside a profiled window, because no rig in this file
 * has ever erased a road, let alone erased one under a committed car. So
 * liveness is re-proved by injecting into the new code SPECIFICALLY — see the
 * task report's allocation section for the figures — and not inherited from
 * Task 2's or Task 3's proof.
 */
const TASK5_TICK_FILES = ['blocking.ts', 'cars.ts', 'trips.ts', 'roads.ts', 'dispatch.ts'] as const

describe('the tick allocates nothing on the blocking path, measured', () => {
  it('charges nothing to blocking.ts, cars.ts or trips.ts — floored over three windows, 0 B per crossing', () => {
    // -----------------------------------------------------------------------
    // THIS WINDOW TOOK A SINGLE DRAW UNTIL M1d TASK 5, AND THE PREMISE THAT
    // JUSTIFIED THAT IS NO LONGER TRUE
    // -----------------------------------------------------------------------
    //
    // The completion window below adopted a **minimum over three windows**
    // because a stray sample lands on some sim module in about a fifth of
    // draws, and it explicitly told the next reader NOT to carry the fix here
    // without re-measuring: *"The clean window is rebuild-free by construction
    // — `pinMoves === 0` is asserted — and measures the whole of
    // `packages/sim/src` ABSENT FROM THE PROFILE, in 12 of 12 full-suite runs
    // under load. So it is not exposed, and it keeps its single-draw
    // `offenders` assertion."*
    //
    // **Task 5 re-measured, and that premise has expired.** Measured on this
    // file, 10-12 runs of the `game` package each:
    //
    //   - at Task 4's HEAD, pristine: **0 failures in 12**;
    //   - with Task 5's source changes and this file's new ghost window
    //     SKIPPED: **2 in 10**;
    //   - with the ghost window live: **3 in 10**.
    //
    // So it is the source change, not the new profiling. The cause is not an
    // allocation: the failures land on a DIFFERENT file every time and always
    // just over the floor — `state.ts` at 4.72, `buildings.ts` at 5.76,
    // `graph.ts` at 9.40, `dispatch.ts` at 6.12 B/frame, i.e. one to four
    // samples of 512 B across 400 ticks. **Two of those files are untouched by
    // Task 5 and one is untouched by the whole milestone**, so no diff can have
    // put an allocation in them. What changed is that the tick now does
    // slightly more work in `sim` — `canEnter` gained a guard and a `ghostMask`
    // read, `advanceCar` and `completeTrip` gained a `noteGhostDeparture` call
    // — so a sampled stack now resolves inside `packages/sim/src` sometimes
    // instead of never, and "the whole scope is absent from the profile" stops
    // being the free pass it was.
    //
    // The instrument is the one this file already derived for exactly this
    // artefact, now that its own stated precondition for not using it is gone:
    // **a file counts as an offender only if it is over budget in EVERY
    // window.** A real per-crossing allocation is present in all three; a stray
    // is present in about one. This is the catalogue's "when a harness
    // documents its own unstable axis, grep for the assertions that still
    // depend on it" — the note above was that grep, written down a task early.
    buildTickRig('tick-alloc-jit-warm').drive(JIT_WARMUP_TICKS)

    // **A fresh rig per window, not three windows on one.** The snake rig is
    // arrival-free for only about 550 ticks — after that a car reaches the
    // carpark, consumes a pin, and every colour rebuilds — so three consecutive
    // 400-tick windows would spend the last two measuring ~185 KB of legitimate
    // `flowfield.ts` work. Measured rather than reasoned: the first attempt at
    // three windows on one rig failed `pinMoves === 0` on window 1 in 12 of 12
    // runs. `rig` below is the last one built, and every assertion that reads it
    // outside the loop is about a property all three share.
    const windows: { crossings: number; pinMoves: number; completions: number }[] = []
    const profiles: Allocator[][] = []
    let rig = buildTickRig('tick-alloc-clean-0')
    for (let w = 0; w < CLEAN_WINDOWS; w++) {
      rig = buildTickRig(`tick-alloc-clean-${w}`)
      rig.drive(TICK_WARMUP)
      let window = { crossings: 0, pinMoves: 0, completions: 0 }
      profiles.push(
        profileAllocations(() => {
          window = rig.drive(PROFILED_TICKS)
        }),
      )
      windows.push(window)
    }

    // ---- Vacuity, per window, before any zero is read as evidence ----
    // The rig must genuinely be moving cars, or "nothing allocates" is a
    // statement about a board where nothing happens — which is exactly what the
    // frame-loop rig above has always been for this code.
    expect(rig.houses, 'the rig placed no houses').toBe(16)
    let inFlight = 0
    for (let c = 0; c < rig.state.carPhase.length; c++) {
      const p = rig.state.carPhase[c] as number
      if (p === PHASE_OUTBOUND || p === PHASE_RETURNING) inFlight++
    }
    expect(inFlight, 'no car is in flight, so advanceCar never crosses').toBe(32)
    for (let w = 0; w < CLEAN_WINDOWS; w++) {
      expect(
        windows[w]!.crossings,
        `window ${w}: no crossings, so claimCell/releaseCell never ran`,
      ).toBeGreaterThan(1000)
      // And every window must be rebuild-free, or the pre-existing flow-field
      // charge lands in it and the floor below stops meaning anything.
      expect(windows[w]!.pinMoves, `window ${w}: a pin moved inside the clean window`).toBe(0)
    }

    /** The sampling floor expressed per crossing, at THIS rig's crossing density. */
    const floorPerCrossing =
      (NOISE_FLOOR_BYTES_PER_FRAME * PROFILED_TICKS) / Math.min(...windows.map((w) => w.crossings))

    // ---- 1. Nothing in the whole sim scope is over its budget in EVERY window ----
    // Reported with all three windows' lists, so a failure says whether the file
    // was over budget consistently (a real allocation) or once (a stray that
    // happened to repeat).
    const perWindowOffenders = profiles.map((p) => offenders(p, PROFILED_TICKS, SIM_SRC, BUDGETS))
    const fileOf = (line: string): string => line.slice(0, line.indexOf(' at '))
    const everyWindow = perWindowOffenders[0]!
      .map(fileOf)
      .filter((f) => perWindowOffenders.every((list) => list.some((line) => fileOf(line) === f)))
    expect(
      everyWindow.join('\n'),
      `over budget in all ${CLEAN_WINDOWS} windows; per-window lists were ` +
        perWindowOffenders.map((l) => `[${l.join('; ')}]`).join(' '),
    ).toBe('')

    // ---- 2. And per CROSSING, for the three files this task changed ----
    for (const file of TASK2_TICK_FILES) {
      const draws = profiles.map((p, w) => bytesIn(p, file) / windows[w]!.crossings)
      const floor = Math.min(...draws)
      expect(
        floor,
        `sim/src/${file} floors at ${floor.toFixed(3)} B/crossing over ${CLEAN_WINDOWS} windows ` +
          `(draws ${draws.map((d) => d.toFixed(3)).join(', ')})`,
      ).toBeLessThan(floorPerCrossing)
    }
    // The floor must stay far below the thing it watches for, or "under the
    // floor" stops meaning anything: one escaping object per claim is 40-70 B.
    // Same guard, same reasoning, as the `canPlaceRoad` per-call test above.
    expect(floorPerCrossing * 8).toBeLessThan(25)
  })

  it('covers completeTrip too: 600+ trips END inside each of three windows, and the FLOOR is zero', () => {
    // The clean window above deliberately contains no arrival, so it never runs
    // `completeTrip`'s release. This one is built for the opposite property.
    //
    // -----------------------------------------------------------------------
    // THE COMPLETION WINDOW'S INSTRUMENT, AND WHY IT IS A MINIMUM
    // -----------------------------------------------------------------------
    //
    // **This assertion has now been wrong in both directions, and the second
    // failure is the one that produced the shape below.**
    //
    //   - Task 2's first version COULD NOT FAIL: it reused the long-snake rig
    //     (~32 trips per 900 ticks) and derived its allowance from the 4 B/tick
    //     frame floor, giving 112 B per completion against a ~40 B signal.
    //     Injecting an object into `completeTrip` left it green.
    //   - The rebuild that fixed that was FLAKY, at a measured ~2 failures in 12
    //     full-suite runs — and only under load, so an isolated re-run does not
    //     reproduce it. It charged `packages/sim/src/blocking.ts` up to
    //     **10,144 B** against a 2,048 B bound, and was **absent from the
    //     profile entirely** the rest of the time.
    //
    // Unfalsifiable, then flaky. Widening the bound past 10 KB would have
    // returned it to the first failure, so the bound is not the thing that was
    // wrong: the **statistic** was.
    //
    // **The charge was ruled in or out as real allocation before anything was
    // tuned, and it is not real.** Two independent lines of evidence:
    //
    //   1. **It does not scale with the window.** The same rig profiled at
    //      650 / 1,300 / 2,600 / 5,200 ticks — 162 to 1,304 completed trips, an
    //      8x range — six rounds each, charged `blocking.ts` a mean of
    //      208 / 1,073 / 451 / 996 B, non-zero in 1, 2, 2 and 2 rounds of six.
    //      A genuine 15 B/trip would have charged 2,430 / 4,905 / 9,780 /
    //      19,560 B, in every round. `cars.ts` and `trips.ts` measured exactly
    //      **0 in all 24** of those windows.
    //   2. **It is not this file's property, or any file's.** Every one of these
    //      charges is attributed to `<top-level>` — the module's script frame,
    //      not `canEnter`, `claimCell` or `completeTrip` — and across twelve
    //      full-suite runs the identical artefact landed on `roads.ts` (6/12),
    //      `hash.ts` (7/12), `scratch.ts` (4/12), `buildings.ts` (4/12),
    //      `state.ts`, `graph.ts` and `dispatch.ts`, at the SAME magnitudes.
    //      `roads.ts` was charged exactly 10,144 B in one of them — the very
    //      figure that failed this test on `blocking.ts`. It lands on whichever
    //      sim module the sampler's stack resolves to; `blocking.ts` was the
    //      least-hit of them at 1/12.
    //
    // So it is a stray sample, and the fix is a statistic that a stray sample
    // cannot move. **A per-trip allocation is present in EVERY window; a stray
    // sample is present in about a fifth of them. The minimum over three
    // windows therefore keeps the whole signal and drops the noise**, with the
    // chance of all three being hit at ~0.8%. That is the property a sampling
    // profiler actually offers: its floor is stable where any single draw is
    // not.
    //
    // Both ends of the 8 B/trip bound, measured rather than chosen:
    //
    //   - **above the noise.** The min-over-three floor measures 0.00 B/trip on
    //     every file, in every one of 12 full-suite runs. Even a SINGLE window
    //     hit by the largest stray ever observed here (10,144 B over 652 trips)
    //     is 15.6 B/trip, so 8 is not a widened allowance — it is a margin over
    //     zero, and the minimum has to be hit three times running to reach it.
    //   - **below the signal.** One escaping object per completed trip, injected
    //     into `completeTrip` itself and measured against THIS statistic, gives
    //     draws of 43.25 / 48.16 / **35.20** B/trip — so the floor is 35.20 and
    //     8 is 4.4x below it. The injection raises every window, which is the
    //     property that makes a minimum safe: the signal survives the statistic
    //     and the noise does not. (The two louder controls, one object per
    //     `canEnter` call and one per refusal, floor at 4,504 and 4,304
    //     B/trip.) Asserted at the foot of this test rather than asserted about.
    buildDenseTripRig('dense-jit-warm').drive(JIT_WARMUP_TICKS)
    const rig = buildDenseTripRig('dense-trips')
    rig.drive(DENSE_WARMUP)

    const perTrip: number[][] = []
    const completions: number[] = []
    const crossings: number[] = []
    for (let w = 0; w < COMPLETION_WINDOWS; w++) {
      let window = { crossings: 0, completions: 0 }
      const all = profileAllocations(() => {
        window = rig.drive(ARRIVAL_TICKS)
      })
      completions.push(window.completions)
      crossings.push(window.crossings)
      perTrip.push(TASK2_TICK_FILES.map((f) => bytesIn(all, f) / window.completions))
    }

    // Vacuity, per window rather than in aggregate: a single window that
    // stopped completing trips would otherwise be averaged away — and it is a
    // window with no trips in it that makes the MINIMUM trivially zero, which
    // is exactly the failure mode a minimum invites.
    expect(rig.houses).toBe(16)
    for (let w = 0; w < COMPLETION_WINDOWS; w++) {
      expect(
        completions[w],
        `window ${w}: completeTrip did not run enough to be measurable`,
      ).toBeGreaterThan(400)
      expect(crossings[w], `window ${w}`).toBeGreaterThan(2000)
    }

    // This window CANNOT use `offenders`: every arrival consumes a pin, which
    // moves the FIELD_INPUT hash, so ~650 completions mean ~650 flow-field
    // rebuild bursts and `flowfield.ts` is legitimately charged ~185 KB. That
    // is pre-existing, is not this milestone's code, and Task 9's tick profile
    // is where it gets its own look.
    for (let f = 0; f < TASK2_TICK_FILES.length; f++) {
      const draws = perTrip.map((w) => w[f] as number)
      const floor = Math.min(...draws)
      expect(
        floor,
        `sim/src/${TASK2_TICK_FILES[f]} floors at ${floor.toFixed(2)} B/trip over ` +
          `${COMPLETION_WINDOWS} windows (draws ${draws.map((d) => d.toFixed(2)).join(', ')})`,
      ).toBeLessThanOrEqual(COMPLETION_BUDGET_BYTES_PER_TRIP)
    }
    // The bound must stay far below the signal it watches for, or it is an
    // allowance rather than a floor. 35 is the measured floor under the
    // QUIETEST of the three positive controls — one escaping object per
    // completed trip in `completeTrip` — so this is the margin that matters.
    expect(COMPLETION_BUDGET_BYTES_PER_TRIP * 4).toBeLessThan(35)
  })

  it('DOES report a sim/src allocation on the same rig, same scope, same predicate — the guard can fail', () => {
    // The positive control, and it is the reason the two zeros above are
    // evidence rather than an empty list. The clean profile resolves NOTHING at
    // all under `packages/` — a genuinely allocation-free tick — so
    // `assertScopeResolves` is the wrong liveness check here and would fire on
    // success. This is the right one, and it is the delta-between-two-profiles
    // idiom the draw control was rewritten into: the same rig, the same
    // `offenders` predicate, the same `SIM_SRC` scope, plus one `snapshot()` per
    // tick — a real `sim/src` allocator on a real production seam.
    buildTickRig('tick-alloc-jit-warm-3').drive(JIT_WARMUP_TICKS)
    const rig = buildTickRig('tick-alloc-control')
    rig.drive(TICK_WARMUP)
    let crossings = 0
    const all = profileAllocations(() => {
      for (let i = 0; i < PROFILED_TICKS; i++) {
        crossings += rig.drive(1).crossings
        snapshot(rig.state)
      }
    })
    expect(crossings).toBeGreaterThan(1000)
    const bad = offenders(all, PROFILED_TICKS, SIM_SRC, BUDGETS)
    expect(bad.join('\n')).toMatch(/packages\/sim\/src\/state\.ts at \d/)
  })

  it('covers the GHOST path: erase, the committed walk, the refusal check and the refund (Task 5)', () => {
    // ---------------------------------------------------------------------
    // WHAT THIS DRIVES, AND WHY ONE ARRANGEMENT COVERS ALL OF IT
    // ---------------------------------------------------------------------
    //
    // The snake rig, with **the whole corridor erased under 32 committed cars
    // except for one segment, which is erased and re-placed every tick.** That
    // single arrangement puts every one of Task 5's new branches inside the
    // window at a high rate:
    //
    //   - **`canEnter`'s ghost branch and `isCommittedTo`** — every crossing is
    //     into a ghost cell, so the `ghostMask[cell] !== 0` test is taken and
    //     the O(remaining route) commitment walk runs behind it. On 73-88 step
    //     routes that is the most expensive new code in the milestone, and it is
    //     the one thing here that could plausibly want a scratch buffer.
    //   - **`noteGhostDeparture`** — every departure is from a ghost cell.
    //   - **`eraseRoad`'s deferral and `countCommittedCars`** — the surviving
    //     segment is erased once per tick, ghosting both endpoints, and the
    //     erase-time count walks all 32 cars' routes twice per tick (~5,600
    //     `routeStep` calls a tick).
    //   - **`placeRoad`'s refund payment** — the other half of that pair.
    //
    // **Erase-then-place of the same segment inside one action list is what
    // keeps the window rebuild-free**, and that is load-bearing rather than
    // neat: actions are phase 2 and `syncFields` is phase 4, so `roads` is
    // byte-identical by the time the field-input hash is taken and no colour
    // rebuilds. `destPins` is asserted unmoved so a window that started
    // rebuilding turns red rather than quietly measuring ~185 KB of legitimate
    // `flowfield.ts` work.
    //
    // ---------------------------------------------------------------------
    // WHY THIS WINDOW IS A DELTA AND NOT A MINIMUM
    // ---------------------------------------------------------------------
    //
    // **A minimum over windows was tried here first and it does not work, for a
    // reason worth writing down because the obvious reading is that it should.**
    // The completion window below floors a per-trip rate over three windows, on
    // the grounds that a stray sample lands in about a fifth of them. That works
    // when the artefact is INDEPENDENT per window. Here it is not: measured on
    // this rig, the blob is ~58 B per TICK and it lands on the same file for
    // every window of a given process, so it contributes a roughly CONSTANT
    // ~6 B per ghost event no matter how long the windows are or how many there
    // are. A minimum over three correlated draws is just the draw. Measured as
    // shipped-with-a-minimum: **3 failures in 24 runs**, at floors of 5.4-6.1
    // against a budget of 5, with all three windows charged 6-12.
    //
    // Lengthening cannot fix it either, and that is the same arithmetic: the
    // blob is per tick and so are the events, so the RATE is invariant. This is
    // the noise-band entry with the band sitting on top of the bound.
    //
    // **So the instrument is the other one this file already owns: a delta
    // between two profiles of the same rig**, which is what the draw control was
    // rewritten into for exactly this reason — "summed over both files the
    // residual can land in so the bimodality cancels rather than being
    // inherited". Each window profiles a TREATMENT (corridor erased under 32
    // committed cars, so every crossing is into a ghost) and a matched CONTROL
    // (identical board, identical cars, identical car motion, the same erase +
    // place actions on the same code path, and NO ghost anywhere because the
    // corridor is intact). A per-process blob appears in both and subtracts out;
    // an allocation in Task 5's code appears only in the treatment. The control
    // is asserted to contain zero ghost cells, or it would be subtracting the
    // signal rather than the noise.
    //
    // ---------------------------------------------------------------------
    // WHAT THIS DRIVES
    // ---------------------------------------------------------------------
    //
    // No rig in this file had ever erased a road, let alone erased one under a
    // committed car, so every branch Task 5 adds was at zero executions —
    // inside `SIM_SRC`'s scope the whole time, and therefore "already covered"
    // in exactly the sense this harness has been wrong about four times in two
    // milestones. The treatment puts all four inside the window at a high rate:
    //
    //   - **`canEnter`'s ghost branch and `isCommittedTo`** — every crossing is
    //     into a ghost cell, so the `ghostMask[cell] !== 0` test is taken and
    //     the O(remaining route) commitment walk runs behind it. On 73-88 step
    //     routes that is the most expensive new code in the milestone.
    //   - **`noteGhostDeparture`** — every departure is from a ghost cell.
    //   - **`eraseRoad`'s deferral and `countCommittedCars`** — the churn
    //     segment is erased every third tick, ghosting both endpoints, and the
    //     erase-time count walks all 32 cars' routes twice.
    //   - **`placeRoad`'s refund payment** — the other half of that pair.
    //
    // **One thing this window was briefly, wrongly, reported to have found, and
    // the retraction belongs here rather than only in a report.** While
    // bisecting the flakiness above I drove `step` with a non-empty action list
    // inside a profiled window — which no rig in this file had done before, the
    // tick rigs all passing `{ actions: [] }` — saw `step @ step.ts` charged
    // 11.6-14.7 KB at 200 ticks against 22.9-25.0 KB at 400, read the clean 2x
    // as scaling with the action path, and wrote it up as a pre-existing
    // ~40-60 B/tick allocation for Task 9. **It is not one.** The scaling is
    // with TICKS, not with actions: re-measured at 0, 2 and 50 actions per tick,
    // three draws each, `step.ts` is charged **0 in all nine** and 25x the
    // action count produces no proportional rise. `canPlaceRoad` returns frozen
    // singletons on every path and the action loop allocates nothing. The 2x was
    // the same per-tick blob this window's delta now subtracts, landing on
    // `step`'s frame — which my own bisect had already shown it doing with an
    // EMPTY action list, on `hash.ts`, `state.ts` and `constants.ts`. The lesson
    // is the catalogue's, in its own words: a wandering `<top-level>`-class
    // attribution is a verdict about nothing, and scaling with the window is not
    // scaling with the cause.

    // **Erase-then-place of the same segment inside one action list is what
    // keeps both windows rebuild-free**: actions are phase 2 and `syncFields` is
    // phase 4, so `roads` is byte-identical by the time the field-input hash is
    // taken. `destPins` unmoved is asserted per window, and each window gets a
    // FRESH rig — the snake is arrival-free for only ~550 ticks, and three
    // consecutive windows on one rig failed `pinMoves === 0` in 12 of 12.
        buildTickRig('ghost-alloc-jit-warm').drive(JIT_WARMUP_TICKS)

    /**
     * A warmed rig with its corridor erased under 32 committed cars, all but
     * one segment. Returns the rig and the segment left alive for the churn.
     *
     * **Each window gets its OWN rig, rather than three windows on one.** The
     * snake rig is arrival-free for only about 550 ticks — after that a car
     * reaches the carpark, consumes a pin, and every colour rebuilds — so three
     * 400-tick windows in a row would spend the last two measuring ~185 KB of
     * legitimate `flowfield.ts` work. A fresh rig per window keeps every one of
     * them inside the quiet stretch, and `destPins` is asserted unmoved for each
     * so the property is checked rather than assumed.
     */
    const ghostRig = (seed: string, ghosted: boolean): { rig: TickRig; churn: [number, number] } => {
      const rig = buildTickRig(seed)
      rig.drive(TICK_WARMUP)
      const segments: [number, number][] = []
      for (let y = 1; y < TICK_RIG_ROW; y++) {
        segments.push([y * TICK_RIG_W + 1, (y + 1) * TICK_RIG_W + 1])
      }
      for (let x = 1; x < TICK_RIG_COL; x++) {
        segments.push([TICK_RIG_ROW * TICK_RIG_W + x, TICK_RIG_ROW * TICK_RIG_W + x + 1])
      }
      for (let y = TICK_RIG_ROW; y > 4; y--) {
        segments.push([y * TICK_RIG_W + TICK_RIG_COL, (y - 1) * TICK_RIG_W + TICK_RIG_COL])
      }
      if (!ghosted) {
        // **The matched CONTROL.** Same board, same 32 cars, same warm-up, same
        // number of tick actions on the same code path — and no ghost anywhere,
        // because the corridor is left intact so the churned segment's endpoints
        // keep a road bit and `settleErasedCell` is never reached. Car motion is
        // IDENTICAL to the treatment's: movement never reads `roads`, no car
        // completes inside an arrival-free window, so no car re-dispatches.
        // The one thing that differs is Task 5's ghost code.
        return { rig, churn: segments[(segments.length / 2) | 0] as [number, number] }
      }
      for (let k = 0; k < segments.length - 1; k++) {
        const seg = segments[k] as [number, number]
        expect(eraseRoad(rig.state, rig.world, seg[0], seg[1]), `segment ${k} did not erase`).toBe(true)
      }
      // The erases moved `roads`, so ONE rebuild is due. Absorb it outside the
      // window; after this the network never changes across a tick boundary.
      rig.drive(3)
      return { rig, churn: segments[segments.length - 1] as [number, number] }
    }

    /** Drives one profiled window on `rig`, churning `churn` every third tick. */
    const driveWindow = (
      rig: TickRig,
      churn: [number, number],
      tally: { crossings: number; departures: number; created: number; paid: number } | null,
    ): Allocator[] => {
      const churnActions: readonly TickAction[] = [
        { kind: 'erase', a: churn[0], b: churn[1] },
        { kind: 'place', a: churn[0], b: churn[1] },
      ]
      const prevCell = Array.from(rig.state.carCell) as number[]
      const wasGhost = new Uint8Array(rig.world.cells)
      return profileAllocations(() => {
        for (let t = 0; t < GHOST_TICKS; t++) {
          for (let c = 0; c < rig.world.cells; c++) wasGhost[c] = rig.state.ghostMask[c] === 0 ? 0 : 1
          const churning = t % GHOST_CHURN_EVERY === 0
          rig.step(churning ? churnActions : NO_TICK_ACTIONS)
          if (tally !== null && churning) {
            tally.created += 2
            tally.paid += 2
          }
          for (let c = 0; c < rig.state.carCell.length; c++) {
            const now = rig.state.carCell[c] as number
            if (now !== prevCell[c]) {
              if (tally !== null) {
                if (wasGhost[now] === 1) tally.crossings++
                if (wasGhost[prevCell[c] as number] === 1) tally.departures++
              }
              prevCell[c] = now
            }
          }
        }
      })
    }

    // Per-branch entry counters, in the `DragCounters` style: a driver that
    // stops entering a branch must turn this RED, not quietly measure less.
    const counts = { crossings: 0, departures: 0, created: 0, paid: 0 }
    const perEventDelta: number[][] = []
    const events: number[] = []
    let ghostCellsAtOpen = 0
    let ghostCellsAtClose = 0

    for (let w = 0; w < GHOST_WINDOWS; w++) {
      const treatment = ghostRig(`ghost-alloc-${w}`, true)
      const control = ghostRig(`ghost-ctl-${w}`, false)
      const before = { ...counts }
      const pinsBefore = treatment.rig.state.destPins[0] as number
      let open = 0
      for (let c = 0; c < treatment.rig.world.cells; c++) {
        if (treatment.rig.state.ghostMask[c] !== 0) open++
      }
      ghostCellsAtOpen = open

      const tProfile = driveWindow(treatment.rig, treatment.churn, counts)
      const cProfile = driveWindow(control.rig, control.churn, null)

      const n =
        counts.crossings - before.crossings +
        (counts.departures - before.departures) +
        (counts.created - before.created) +
        (counts.paid - before.paid)
      events.push(n)
      perEventDelta.push(TASK5_TICK_FILES.map((f) => (bytesIn(tProfile, f) - bytesIn(cProfile, f)) / n))

      // Per window, not in aggregate: one window that stopped jamming, or
      // started rebuilding, would otherwise be averaged away.
      expect(treatment.rig.state.destPins[0], `window ${w}: a pin moved in the treatment`).toBe(pinsBefore)
      expect(treatment.rig.state.roads[treatment.churn[0]], `window ${w}: churn not restored`).not.toBe(0)
      expect(treatment.rig.state.ghostMask[treatment.churn[0]], `window ${w}: ghost outlived the tick`).toBe(0)
      // The control must genuinely have no ghost, or the delta subtracts the
      // very signal it is meant to isolate.
      let ctlGhosts = 0
      for (let c = 0; c < control.rig.world.cells; c++) {
        if (control.rig.state.ghostMask[c] !== 0) ctlGhosts++
      }
      expect(ctlGhosts, `window ${w}: the CONTROL produced a ghost, so it is not a control`).toBe(0)
      let close = 0
      for (let c = 0; c < treatment.rig.world.cells; c++) {
        if (treatment.rig.state.ghostMask[c] !== 0) close++
      }
      ghostCellsAtClose = close
      expect(open, `window ${w}: the erase produced no ghost`).toBeGreaterThan(50)
      expect(close, `window ${w}: every ghost was paid off before the window closed`).toBeGreaterThan(10)
      expect(n, `window ${w}: too few ghost events to divide by`).toBeGreaterThan(1000)
    }

    // ---- Vacuity, before any zero is read as evidence ----
    expect(counts.crossings, 'no car crossed INTO a ghost: canEnter s ghost branch never ran').toBeGreaterThan(
      500,
    )
    expect(counts.departures, 'no car left a ghost: noteGhostDeparture never ran').toBeGreaterThan(500)
    const churnsPerWindow = Math.ceil(GHOST_TICKS / GHOST_CHURN_EVERY)
    expect(counts.created, 'eraseRoad s deferral never ran').toBe(churnsPerWindow * GHOST_WINDOWS * 2)
    expect(counts.paid, 'placeRoad s refund payment never ran').toBe(churnsPerWindow * GHOST_WINDOWS * 2)
    expect(ghostCellsAtOpen).toBeGreaterThan(ghostCellsAtClose) // ghosts really were paid off as cars cleared

    // ---- The bound: per ghost event, floored over three windows ----
    for (let f = 0; f < TASK5_TICK_FILES.length; f++) {
      const draws = perEventDelta.map((w) => w[f] as number)
      const floor = Math.min(...draws)
      expect(
        floor,
        `sim/src/${TASK5_TICK_FILES[f]} floors at ${floor.toFixed(3)} B/ghost-event over ` +
          `${COMPLETION_WINDOWS} windows (draws ${draws.map((d) => d.toFixed(3)).join(', ')})`,
      ).toBeLessThanOrEqual(GHOST_BUDGET_BYTES_PER_EVENT)
    }
    // The bound must stay below the signal it watches for, or it is an
    // allowance rather than a floor. 13.10 is the measured floor under the
    // QUIETEST of the three positive controls — one escaping object per ghost
    // departure — so that is the margin that matters, and it is asserted here
    // rather than asserted about.
    expect(GHOST_BUDGET_BYTES_PER_EVENT * 2).toBeLessThan(10)
  })
})

// ---------------------------------------------------------------------------
// The tick-side profile over the JAM fixture — M1d Task 9
// ---------------------------------------------------------------------------

/**
 * **What was actually missing here, stated first, because the plan's
 * description of it is out of date and reading it as written would produce the
 * wrong work.**
 *
 * The plan (and Task 9's brief) say the tick-side allocation profile "is the
 * last unowned item" and that *"the shipped rig in `allocation.test.ts` never
 * moves a car — measured over 1,752 ticks, all six live cars stay
 * `PHASE_IDLE`"*. **That was true when the plan was written and is false at
 * HEAD.** It describes the FRAME-loop rig above, which drives pointer strokes;
 * the TICK side has been profiled since Task 2 by `buildTickRig` (32 cars on an
 * 88-step snake) and extended by Tasks 3 and 5. Measured on the shipped clean
 * window at HEAD — 400 ticks after an 80-tick warm-up — it produces **1,265
 * crossings and 3,051 refusals**, with a longest blocked run of 188 ticks. So
 * `canEnter` and `REFUSED_OCCUPIED` are not at zero executions at all.
 *
 * **The real gap is that none of it is ASSERTED**, which is the half of the
 * plan's requirement that still bites: *"a fixture that stops jamming must turn
 * the harness RED, not quietly measure less."* The clean window counts crossings
 * and asserts them; it counts no refusals, no dispatches, no queue depth, and no
 * valve firings, so every one of those could fall to zero tomorrow and the
 * window would go on reporting a clean floor over a rig that had stopped
 * exercising the branch. That is the same shape as the four scope failures this
 * harness has already had, one level in: the instrument is live, the driver is
 * live, and the CLAIM about which branches the driver enters is unchecked.
 *
 * And one branch genuinely is at zero executions everywhere: **`ENTER_VALVE`.**
 * Measured across every profiled window in this file, the valve fires **0**
 * times. `blocking.test.ts` reaches it on a hand-built ring; nothing profiles it
 * on the production path. This window does.
 *
 * ---------------------------------------------------------------------------
 * THE SIX COUNTERS, AND THE ONE THIS WINDOW DELEGATES
 * ---------------------------------------------------------------------------
 *
 * The plan names six branch counters. Five are asserted below —
 * `carsDispatched`, `canEnterCalls`, `REFUSED_OCCUPIED`, `ENTER_VALVE`, and a
 * queue of >= 3. The sixth, **ghost cells present, is deliberately delegated**
 * to the ghost window above rather than duplicated: that window already asserts
 * `open > 50` ghost cells with a matched treatment/control delta, and this rig
 * has no erase in it at all (asserted zero here, because a ghost would add a
 * `REFUSED_GHOST` that the refusal counter's derivation below does not model).
 * Saying so is the point — an omission that is not written down is
 * indistinguishable from an oversight.
 *
 * ---------------------------------------------------------------------------
 * WHY A MINIMUM AND NOT A DELTA, WHICH IS THE OPPOSITE OF THE GHOST WINDOW
 * ---------------------------------------------------------------------------
 *
 * The ghost window above uses a treatment/control delta and says a minimum
 * cannot work there, because its artefact is ~58 B/tick **correlated on one file
 * per process** — a constant per-event charge no window count dilutes. That
 * reasoning is about that rig, and it does not transfer: measured here over
 * three rounds of three windows, the floor is **0.0000 B/refusal on all three
 * files in 9 of 9 windows**, with a single independent excursion of 5.543
 * B/refusal on `blocking.ts` in one window that the minimum dropped. That is the
 * INDEPENDENT case, so the minimum is the right instrument, and the catalogue's
 * rule — know which kind of noise you have before reaching for either — is what
 * decides it rather than which sibling window was read last.
 *
 * The denominator helps too, and it is worth saying why this window can afford a
 * minimum where the ghost window could not: there are ~10,000 refusals per
 * 500-tick window here against ~1,336 ghost events, so a per-process blob is
 * divided by 7.5x more events before it reaches the rate.
 *
 * **This window cannot use `offenders` over the whole `SIM_SRC` scope**, for the
 * reason the completion window cannot: the starved corridor completes ~30 trips
 * per window, every arrival consumes a pin, and `flowfield.ts` is therefore
 * legitimately charged for real rebuild work. The bound is per file, on the
 * three files the blocking path lives in.
 */
const JAM_WINDOWS = 3
const JAM_WINDOW_TICKS = 500
/** Long enough for `carBlockedTicks` to approach `MAX_BLOCKED_TICKS = 1,350` before window 0 opens. */
const JAM_VALVE_WARMUP = 1200

/**
 * Per-refusal allocation a blocking-path file may be charged, in **bytes per
 * `REFUSED_OCCUPIED`** — a rate, for the reason every other bound in this file
 * is one.
 *
 * **Both ends measured on the instrument and the window size that ship.**
 *
 *   - **above the noise.** Three rounds of three 250-tick windows and six
 *     further 500-tick windows: the min-over-three floor was **0.0000 on all
 *     three files in every round**. The largest single-window excursion seen at
 *     all was 5.543 B/refusal (`blocking.ts`, one window of nine), and the
 *     minimum dropped it to zero — which is the statistic doing exactly the job
 *     it is here for.
 *   - **below the signal.** One escaping object per refusal, injected into
 *     `noteEntryRefused` as `(globalThis as any).__sink = {...}` so it genuinely
 *     ESCAPES — a non-escaping local is deleted by V8's scalar replacement and
 *     reads exactly like a blind harness — gives draws of **40.3618 / 42.3551 /
 *     41.3675**, so a floor of **40.3618 B/refusal**.
 *
 * So 4 is above a floor that has never been non-zero and **10.1x below the
 * signal**, with the gap between them empty.
 *
 * **One thing the positive control showed that is worth recording, because this
 * file makes a claim about it.** The injection went into `noteEntryRefused`,
 * which lives in `blocking.ts` — and the charge appeared on **`cars.ts`**, the
 * caller's file, because V8 inlines the one-line counter bump into `advanceCar`.
 * This file's header says per-FUNCTION attribution is unstable and per-FILE
 * attribution is stable; that is true of a function big enough not to be
 * inlined, and it is not true across an inline boundary. The bound below is
 * therefore applied to each of the three files SEPARATELY and the guard fires
 * whichever one the charge lands on — which is what makes it robust to the
 * question rather than dependent on the answer.
 */
const JAM_BUDGET_BYTES_PER_REFUSAL = 4

/** The files the blocking path lives in. Same three as the clean window. */
const JAM_TICK_FILES = TASK2_TICK_FILES

interface JamBranchCounters {
  crossings: number
  refusals: number
  carsDispatched: number
  valves: number
  longestQueue: number
  ghostCells: number
}

describe('the tick allocates nothing on the JAM path, with every branch counted (Task 9)', () => {
  it('enters all five counted branches and floors at 0 B per refusal over three windows', () => {
    buildJamRig('jam-alloc-jit').drive(JIT_WARMUP_TICKS)

    const rig = buildJamRig('jam-alloc', JAM_STARVED_FIRST_HOUSE_Y, JAM_STARVED_HOUSE_COUNT)
    rig.drive(JAM_VALVE_WARMUP)

    const counts: JamBranchCounters = {
      crossings: 0,
      refusals: 0,
      carsDispatched: 0,
      valves: 0,
      longestQueue: 0,
      ghostCells: 0,
    }
    const perRefusal: number[][] = []
    const refusalsPerWindow: number[] = []

    for (let w = 0; w < JAM_WINDOWS; w++) {
      const window = { crossings: 0, refusals: 0, valves: 0, dispatched: 0, trips: 0, pinMoves: 0 }
      const all = profileAllocations(() => {
        const o = rig.drive(JAM_WINDOW_TICKS)
        // Copied field by field rather than spread: a spread inside the profiled
        // window allocates an object per window, in the harness rather than in
        // the code under test, and this file has already been bitten once by a
        // driver charging its own bookkeeping to `sim`.
        window.crossings = o.crossings
        window.refusals = o.refusals
        window.valves = o.valves
        window.dispatched = o.dispatched
        window.pinMoves = o.pinMoves
      })
      counts.crossings += window.crossings
      counts.refusals += window.refusals
      counts.carsDispatched += window.dispatched
      counts.valves += window.valves
      refusalsPerWindow.push(window.refusals)
      perRefusal.push(JAM_TICK_FILES.map((f) => bytesIn(all, f) / window.refusals))
      // Outside the profiled window on purpose: `jamQueueLength` builds two Maps
      // and a Set per call.
      const q = jamQueueLength(rig)
      if (q > counts.longestQueue) counts.longestQueue = q
      counts.ghostCells += jamGhostCells(rig)
      expect(window.refusals, `window ${w}: the corridor stopped refusing entries`).toBeGreaterThan(5000)
    }

    // ---- The five branch counters, asserted before any zero is read ----
    // A driver that stops entering one of these must turn this test RED rather
    // than quietly measure less, which is the whole reason they are here.
    expect(counts.crossings, 'no crossing: claimCell/releaseCell never ran').toBeGreaterThan(300)
    expect(counts.refusals, 'no refusal: canEnter never returned REFUSED_OCCUPIED').toBeGreaterThan(20000)
    // `advanceCar` asks `canEnter` exactly once per car per tick whose progress
    // reached the threshold, and the answer is either a grant (a crossing) or a
    // refusal (a counter rise) — so the call count is their sum, derived from
    // production behaviour rather than by re-asking the oracle.
    expect(counts.crossings + counts.refusals, 'canEnter was never called').toBeGreaterThan(20000)
    expect(counts.carsDispatched, 'no car was dispatched inside the windows').toBeGreaterThan(100)
    // The one branch that is at zero executions in EVERY other profiled window
    // in this file.
    expect(counts.valves, 'ENTER_VALVE never fired, so the valve branch is unprofiled').toBeGreaterThan(0)
    expect(counts.longestQueue, 'no queue of 3 formed').toBeGreaterThanOrEqual(3)
    // ...and the one this window delegates rather than covers.
    expect(counts.ghostCells, 'this rig must have no ghost — see the block comment').toBe(0)

    // ---- The bound: per refusal, floored over three windows ----
    for (let f = 0; f < JAM_TICK_FILES.length; f++) {
      const draws = perRefusal.map((w) => w[f] as number)
      const floor = Math.min(...draws)
      expect(
        floor,
        `sim/src/${JAM_TICK_FILES[f]} floors at ${floor.toFixed(4)} B/refusal over ${JAM_WINDOWS} ` +
          `windows (draws ${draws.map((d) => d.toFixed(4)).join(', ')}; refusals ` +
          `${refusalsPerWindow.join(', ')})`,
      ).toBeLessThanOrEqual(JAM_BUDGET_BYTES_PER_REFUSAL)
    }
    // The bound must stay far below the signal it watches for, or it is an
    // allowance rather than a floor. 40.36 is the MEASURED floor under one
    // escaping object per refusal in `noteEntryRefused`; the assertion is
    // written against 40 so it does not depend on the last decimal place.
    expect(JAM_BUDGET_BYTES_PER_REFUSAL * 8).toBeLessThan(40)
  })
})
