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
import { createInputQueue } from '../src/inputs'
import { createLoop } from '../src/loop'

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
    const budget = budgets[file.slice(file.lastIndexOf('/') + 1)] ?? 0
    if (perFrame > budget) out.push(`${file} at ${perFrame.toFixed(2)} B/frame (budget ${budget})`)
  }
  return out.sort()
}

/**
 * See the module comment. **Every other file's budget is 0, and that is the
 * assertion doing the work** — over 12 consecutive runs no `game/src` file
 * other than `loop.ts` appeared even once.
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

function buildLoop(draw: (frame: RenderFrame) => void): ReturnType<typeof createLoop> {
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
  return createLoop(
    createFrameDriver({ state, world, fields, scratch, builder, camera: () => camera, draw }),
    createInputQueue(),
  )
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
    expect(PROFILED_FRAMES).toBeGreaterThanOrEqual(3000)
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
    const files = [...new Set(all.filter((a) => a.file.startsWith(GAME_SRC)).map((a) => a.file))]
    expect(files.filter((f) => !f.endsWith('/loop.ts')), 'a game/src file allocated').toEqual([])

    // Named, because these are the functions the rule is really about.
    const names = all.filter((a) => a.file.startsWith(GAME_SRC)).map((a) => a.functionName)
    for (const fn of ['buildFrame', 'resolveCar', 'lerpCar', 'snapshotPrev', 'snapshotCurr', 'enqueue']) {
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
   */
  it('DOES report one escaping object per frame — the guard can fail', () => {
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

    // (a) the instrument sees it, by name.
    const control = all.find((a) => a.functionName === 'draw' && a.file.endsWith('allocation.test.ts'))
    expect(control, 'the deliberate per-frame allocation was not seen').toBeDefined()
    const perFrame = (control as Allocator).bytes / PROFILED_FRAMES
    // Measured at 39-42 B/frame for a two-field object. The bound is loose on
    // purpose: the claim is the order of magnitude, which is what separates
    // "an object per frame" from "a few boxed doubles".
    expect(perFrame).toBeGreaterThan(20)

    // (b) the guard's own predicate fires on it. Scope widened to the whole
    // package so the test file is in range; `loop.ts` keeps its budget, so the
    // only thing this can report is the deliberate allocator's file.
    const bad = offenders(all, PROFILED_FRAMES, GAME_PKG, BUDGETS)
    expect(bad.join('\n')).toMatch(/packages\/game\/test\/allocation\.test\.ts at \d/)
  })
})
