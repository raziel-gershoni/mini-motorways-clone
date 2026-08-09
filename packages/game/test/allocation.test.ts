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
  type TickAction,
} from '@laneways/sim'
import { createHudRects, fitCamera, hudRects, type RenderFrame } from '@laneways/render'
import { seedStartingCity } from '../src/startingCity'
import { createFrameBuilder, createFrameDriver } from '../src/frame'
import { initCarSnapshots } from '../src/resolve'
import { createInputQueue, type InputQueue } from '../src/inputs'
import { createLoop } from '../src/loop'
import { CHECKOUT_ROOT, repoRelative } from './allocationPaths'
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
 */

const TICK_RIG_W = 40
const TICK_RIG_H = 30
const TICK_RIG_ROW = 28
const TICK_RIG_COL = 38
/** Ticks profiled in the clean (no-arrival, no-rebuild) window. */
const PROFILED_TICKS = 400
/** Ticks profiled in the window that contains trip completions. */
const ARRIVAL_TICKS = 900
/** Ticks the completion-dense rig needs before every car is in flight. */
const DENSE_WARMUP = 120
/**
 * How many stray samples a file may be charged before it counts as allocating.
 *
 * The completion window cannot use a per-tick budget (see that test), so its
 * bound is expressed in the instrument's own unit: one recorded stack per
 * `SAMPLING_INTERVAL_BYTES`. Four samples is 2,048 B — comfortably above the
 * one-or-two-sample strays this file's noise-floor derivation measured, and 12x
 * below what one escaping object per completed trip costs at this rig's
 * density.
 */
const ALLOWED_STRAY_SAMPLES = 4
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
  /** Advances `n` ticks and returns what actually happened in them. */
  drive(n: number): { crossings: number; pinMoves: number; completions: number }
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
  return {
    state,
    houses,
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
 * turn over fast: ~630 completed trips per 900 ticks, against 32 for the snake
 * rig above. Built for `completeTrip` density and nothing else — it is
 * rebuild-heavy by construction, because every arrival consumes a pin.
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
        // Topped up rather than waited out: `destPins` is a Uint8 and 630 trips
        // would exhaust any single fill.
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

/** The three files M1d Task 2 changed on the tick path. */
const TASK2_TICK_FILES = ['blocking.ts', 'cars.ts', 'trips.ts'] as const

describe('the tick allocates nothing on the blocking path, measured', () => {
  it('charges nothing to blocking.ts, cars.ts or trips.ts — claim and release are 0 B per crossing', () => {
    // JIT warm-up on a THROWAWAY rig, driven far enough to include arrivals and
    // rebuilds. Without it the profiled window measures first-call costs and
    // charges 15.6 B/tick to `buildings.ts` and 11.7 to `clock.ts` — two files
    // of pure integer arithmetic that cannot allocate per tick at all.
    buildTickRig('tick-alloc-jit-warm').drive(JIT_WARMUP_TICKS)

    const rig = buildTickRig('tick-alloc-clean')
    rig.drive(TICK_WARMUP)
    let window = { crossings: 0, pinMoves: 0, completions: 0 }
    const all = profileAllocations(() => {
      window = rig.drive(PROFILED_TICKS)
    })

    // ---- Vacuity, before any zero is read as evidence ----
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
    expect(window.crossings, 'no crossings, so claimCell/releaseCell never ran').toBeGreaterThan(1000)
    // And the window must be rebuild-free, or the pre-existing flow-field
    // charge lands in it and the floor below stops meaning anything.
    expect(window.pinMoves, 'a pin moved inside the clean window').toBe(0)

    /** The sampling floor expressed per crossing, at THIS rig's crossing density. */
    const floorPerCrossing = (NOISE_FLOOR_BYTES_PER_FRAME * PROFILED_TICKS) / window.crossings

    // ---- 1. Nothing in the whole sim scope is over its budget ----
    expect(offenders(all, PROFILED_TICKS, SIM_SRC, BUDGETS).join('\n')).toBe('')

    // ---- 2. And per CROSSING, for the three files this task changed ----
    for (const file of TASK2_TICK_FILES) {
      const perCrossing = bytesIn(all, file) / window.crossings
      expect(perCrossing, `sim/src/${file} allocates ${perCrossing.toFixed(3)} B/crossing`).toBeLessThan(
        floorPerCrossing,
      )
    }
    // The floor must stay far below the thing it watches for, or "under the
    // floor" stops meaning anything: one escaping object per claim is 40-70 B.
    // Same guard, same reasoning, as the `canPlaceRoad` per-call test above.
    expect(floorPerCrossing * 8).toBeLessThan(25)
  })

  it('covers completeTrip too: 600+ trips END inside the window and the three files still charge nothing', () => {
    // The clean window above deliberately contains no arrival, so it never runs
    // `completeTrip`'s release. This one is built for the opposite property.
    //
    // **The first version of this test could not fail and that is worth
    // recording.** It reused the long-snake rig, which completes ~32 trips in
    // 900 ticks, and derived its bound from the 4 B/tick frame floor — giving
    // an allowance of 112 B per completion against a signal of ~40. Injecting
    // an object into `completeTrip` left it **green**. Same defect as the
    // per-tick-vs-per-crossing trap one level down: a RARE event needs a bound
    // derived from the instrument, not from a per-tick budget.
    //
    // So: a short corridor with the carpark in the middle of it and 16 houses
    // along it, which turns over **~630 completed trips in 900 ticks** (0.70 a
    // tick, against 0.036 before), and a bound expressed in SAMPLES.
    buildDenseTripRig('dense-jit-warm').drive(JIT_WARMUP_TICKS)
    const rig = buildDenseTripRig('dense-trips')
    rig.drive(DENSE_WARMUP)
    let window = { crossings: 0, completions: 0 }
    const all = profileAllocations(() => {
      window = rig.drive(ARRIVAL_TICKS)
    })

    // Vacuity: trips must actually have ENDED inside the profiled window, in
    // bulk. `completions` is read off `H_SCORE`, which only `completeTrip`
    // writes, so this is a direct count of the calls under test.
    expect(rig.houses).toBe(16)
    expect(window.completions, 'completeTrip did not run enough to be measurable').toBeGreaterThan(400)
    expect(window.crossings).toBeGreaterThan(2000)

    // This window CANNOT use `offenders`: every arrival consumes a pin, which
    // moves the FIELD_INPUT hash, so 630 completions mean 630 flow-field
    // rebuild bursts and `flowfield.ts` is legitimately charged ~46 KB. That is
    // pre-existing, is not this task's code, and Task 9's tick profile is where
    // it gets its own look. The three files below are held to the instrument's
    // own resolution instead.
    const bound = SAMPLING_INTERVAL_BYTES * ALLOWED_STRAY_SAMPLES
    for (const file of TASK2_TICK_FILES) {
      const bytes = bytesIn(all, file)
      const perCompletion = bytes / window.completions
      expect(
        bytes,
        `sim/src/${file} allocated ${bytes} B (${perCompletion.toFixed(2)} B/trip) over ${window.completions} trips`,
      ).toBeLessThanOrEqual(bound)
    }
    // The bound must stay far below the signal it watches for, or it is an
    // allowance rather than a floor: one escaping object per completed trip is
    // 40-70 B, so at this density the signal is 25,000-44,000 B against a bound
    // of 2,048 — a 12x margin at the low end. Asserted, not asserted-about.
    expect(bound * 12).toBeLessThan(40 * window.completions)
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
})
