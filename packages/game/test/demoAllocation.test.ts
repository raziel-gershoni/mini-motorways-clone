import { describe, it, expect } from 'vitest'
import { Session } from 'node:inspector'
import { CT_REBUILDS, isGameOver, H_TICK, PHASE_OUTBOUND, PHASE_RETURNING } from '@laneways/sim'
import type { AtlasContext, AtlasSurface } from '@laneways/render'
import { DEMO_DEATH_TICK } from './deathTicks'
import { createGame, type GameContext } from '../src/main'
import { DEMO_LAYOUT_ID } from '../src/layouts'
import { repoRelative } from './allocationPaths'

/**
 * **The allocation harness, pointed at the DEMO board.**
 *
 * The catalogue's most-repeated instrument defect: *"a green harness is a claim
 * about the inputs it was given, not about the code"* — recorded four times in
 * two milestones, every time because a new path was added and the harness's
 * scope stayed where it was. This task adds a new INPUT rather than a new path:
 * every existing allocation rig runs on `firstCity`'s starting city, which has
 * **six car slots of which at most one is ever in flight**, three destinations
 * and no road until the rig draws one.
 *
 * The demo board is the first thing in this repo to drive the frame loop with
 * **24 cars, 20+ of them moving at once, 18 destinations and 71 road cells**.
 * Nothing in the frame path is supposed to scale with any of those numbers, and
 * that sentence had never been tested.
 *
 * ---------------------------------------------------------------------------
 * IT FOUND ONE THING, AND THE EXEMPTION FOR IT IS GONE BECAUSE THE THING IS
 * ---------------------------------------------------------------------------
 *
 * On its first run this file charged `packages/sim/src/flowfield.ts` at
 * **16.8-21.8 B/frame** against the 4 B floor — a pre-existing M1b allocation
 * that only this input's rebuild frequency could expose. It carried a
 * `FLOWFIELD_ALLOWANCE_BYTES_PER_FRAME = 64` written to assert the violation
 * was STILL PRESENT rather than merely bounded. M1e Task 3 made
 * `computeFlowField`'s `push` a module-scope function (its two counters now
 * live in `scratch.cursor`), the assertion went red as designed, and the
 * allowance was **deleted, not widened** — measured at 0.00 B/frame over five
 * draws x three windows, with the file absent from every profile. `sim` is
 * back under the ordinary floor here, so do not reintroduce an exemption for
 * it: a charge on `flowfield.ts` now is a regression, not a known cost.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE
 * ---------------------------------------------------------------------------
 *
 * `drawAllocation.test.ts` documents, from measurement, that a profiler cannot
 * tell the code under test from the harness around it: adding a second context
 * SHAPE to that file moved its figures by two orders of magnitude, and adding a
 * second profiled RUN was enough for TurboFan to inline `draw` into its caller
 * and turn an unrelated control red. So this file follows the same discipline
 * it does — **exactly one context shape and exactly one profiled rig** — rather
 * than adding either to a file that already has one.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT COVER, STATED RATHER THAN IMPLIED
 * ---------------------------------------------------------------------------
 *
 * Nothing this task added runs per tick or per frame. `demoLayout.ts`,
 * `layouts.ts` and `main.ts`'s three token readers all run once, before the
 * first tick, on the same pre-tick path as `seedStartingCity`; they allocate
 * freely and are supposed to. `queueProbe.ts` allocates two `Map`s and a `Set`
 * per call and is called only from test rigs, outside profiled windows — its
 * own doc comment says so, and no production caller exists.
 *
 * What is profiled here is therefore the EXISTING frame loop under a load it
 * has never seen, which is the only new thing there is to measure.
 *
 * **AND IT CANNOT SEE BUILDING PLACEMENT — measured, because a later brief
 * assumed the opposite.** M1e Task 4's brief named this file as "the harness
 * that sees" `canPlaceDestination`/`canPlaceHouse` losing their per-call
 * allocations. It does not, and the reason is this section's own rule one level
 * on: **neither predicate has a per-FRAME caller until Task 5.** They are
 * reached once each per building, from `demoLayout.ts` and `startingCity.ts`,
 * before the first tick — `step()` imports neither. With an escaping
 * `(globalThis as ...).__sink = {...}` planted at the TOP of both predicates,
 * so it fires on every call whatever the branch, `packages/sim/src/buildings.ts`
 * was **absent from the profile in 9 of 9 windows across 3 draws**. A green
 * figure from this file about `buildings.ts` is not evidence; it is the
 * denominator being zero.
 *
 * The per-CALL rig that can see it is
 * `packages/game/test/placementAllocation.test.ts`. **Do not move it here.**
 * This file's one-rig discipline above is the reason it stays separate, and the
 * frame loop is the wrong driver for a predicate the frame loop does not call.
 * When Task 5 does put both on the tick, the arm to add here is a per-CALL rate
 * off a spawn-attempt counter, never a per-frame budget: spawn attempts fire
 * about once every 2,250 ticks, which is the rare-event case the carry-forward
 * shows no choice of denominator can rescue.
 */

interface CallFrame {
  readonly url: string
}
interface ProfileNode {
  readonly callFrame: CallFrame
  readonly selfSize: number
  readonly children?: readonly ProfileNode[]
}

const SAMPLING_INTERVAL_BYTES = 512
const PROFILED_FRAMES = 3000
const WARMUP_FRAMES = 1500
/** See the budget test: the minimum over three windows defeats the sampler's strays. */
const WINDOW_COUNT = 3

/**
 * `loop.ts`'s known bimodal residual — a boxed `HeapNumber` from a mutable
 * double captured in a closure, measured across runs at 0-18 B/frame. 32 is
 * `allocation.test.ts`'s figure, chosen there because a budget inside the noise
 * band (16) failed about one run in twenty. Copied rather than re-derived, and
 * the copy is asserted against the original below so the two cannot drift.
 */
const LOOP_BUDGET_BYTES_PER_FRAME = 32

/**
 * The default per-file budget. A sampling profiler cannot have a budget of
 * exactly 0: one sample over 3,000 frames is 512 / 3,000 = 0.17 B/frame, the
 * signature of a one-off IC transition rather than a per-frame allocation. 4 is
 * `allocation.test.ts`'s measured floor — 2x above the worst observed stray and
 * 9x below a single escaping object per frame.
 */
const NOISE_FLOOR_BYTES_PER_FRAME = 4

const PROFILED_SCOPES: readonly string[] = [
  'packages/game/src/',
  'packages/sim/src/',
  'packages/render/src/',
]

const FLOWFIELD_FILE = 'packages/sim/src/flowfield.ts'

/**
 * **A per-CALL budget for `flowfield.ts`, and it is the opposite of the
 * allowance that used to stand here — read the difference before touching it.**
 * The allowance asserted the violation was STILL PRESENT and was deleted the
 * moment it stopped being. This asserts the violation is ABSENT, at a bound
 * tight enough to see the smallest regression that could reintroduce it.
 *
 * **Why per call and not per frame, measured rather than argued.**
 * `computeFlowField` runs 0.127 times per frame on this board, so a per-frame
 * budget divides any regression by the event's rarity before comparing it to
 * the floor. Counterfactual: one escaping object per rebuild, eight draws,
 * three windows each, both statistics off the same windows.
 *
 *   - per FRAME (min over three windows): 4.96 / 4.79 / **2.67** / 4.44 /
 *     **3.37** / 4.61 / 4.44 / 4.61 against a 4 B floor. **It misses the
 *     regression outright on 2 of 8 draws**, and the six it catches it catches
 *     by 1.11-1.24x. Not a tight guard — a coin-flip one, whose natural repair
 *     when it flakes is to widen the budget, which is the exemption this task
 *     just deleted growing back.
 *   - per CALL (min over the same three windows): 39.06 / 37.69 / 20.83 /
 *     34.96 / 26.35 / 36.33 / 34.96 / 36.33. **Fires on 8 of 8**, weakest draw
 *     20.83.
 *
 * Clean, six draws: **0.00 on all eighteen windows**, the file absent from
 * every profile. One stray sample over ~381 calls would read 512/381 = 1.34
 * B/call, and the minimum-over-three-windows makes even that require a stray in
 * all three.
 *
 * So the band is empty between ~1.3 and ~20.8, and **8** sits in it: 6x above a
 * single stray, 2.6x below the weakest signal ever observed. (An earlier
 * proposal of 20 was measured too tight — draw 3's 20.83 clears it by 4%, which
 * is the same flake-red disease one level up.)
 *
 * **The condition this relies on, stated because it is what makes the arm work
 * and it does NOT generalise.** Dividing by an event count does not improve
 * signal-to-noise on its own — it divides the signal and the stray samples by
 * the same denominator, so it is a change of units. What makes this arm sound
 * is that the event fires **381-384 times per window**, which is enough draws
 * for the sampler to see it at the shipped 512 B interval at all. For a
 * genuinely RARE event — a week boundary at ~8 firings per window — no choice
 * of denominator helps, and the sampling interval has to come down instead. The
 * vacuity assertion below pins the rebuild count so this arm cannot silently
 * become the rare case.
 */
const FLOWFIELD_BUDGET_BYTES_PER_CALL = 8

function profileBytesByFile(body: () => void): Map<string, number> {
  interface RawSession {
    post(method: string, cb?: (err: Error | null, result?: unknown) => void): void
    post(method: string, params: object, cb?: (err: Error | null, result?: unknown) => void): void
  }
  const session = new Session()
  session.connect()
  const raw = session as unknown as RawSession
  let profile: ProfileNode | null = null
  raw.post('HeapProfiler.enable')
  raw.post('HeapProfiler.startSampling', {
    samplingInterval: SAMPLING_INTERVAL_BYTES,
    // Without these only SURVIVORS are counted, and every short-lived per-frame
    // object — precisely the ones the rule forbids — is invisible.
    includeObjectsCollectedByMinorGC: true,
    includeObjectsCollectedByMajorGC: true,
  })
  body()
  raw.post('HeapProfiler.stopSampling', (_err, result) => {
    profile = (result as { profile?: { head: ProfileNode } } | undefined)?.profile?.head ?? null
  })
  session.disconnect()
  if (profile === null) throw new Error('the demo profiler returned no profile')

  const byFile = new Map<string, number>()
  const walk = (node: ProfileNode): void => {
    if (node.selfSize > 0) {
      const file = repoRelative(node.callFrame.url)
      byFile.set(file, (byFile.get(file) ?? 0) + node.selfSize)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(profile)
  return byFile
}

interface DrawCounts {
  blits: number
  fills: number
}

/** The ONE context shape this file ever creates. See the module comment. */
function countingContext(counts: DrawCounts): GameContext {
  return {
    fillStyle: '',
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    setTransform: () => undefined,
    fillRect: () => {
      counts.fills++
    },
    fillText: () => undefined,
    drawImage: () => {
      counts.blits++
    },
  }
}

function stubSurface(widthPx: number, heightPx: number): AtlasSurface {
  const context: AtlasContext = {
    lineWidth: 0,
    lineCap: 'round',
    lineJoin: 'round',
    globalAlpha: 1,
    strokeStyle: '',
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
  }
  return { width: widthPx, height: heightPx, getContext: () => context }
}

const M0_VIEW = {
  cssW: 406,
  cssH: 870,
  topInset: 46,
  bottomInset: 34,
  rawDpr: 3,
  performanceClass: null,
} as const

function demoRig(escapePerFrame: boolean) {
  const counts: DrawCounts = { blits: 0, fills: 0 }
  const game = createGame({
    canvas: {
      width: 0,
      height: 0,
      style: { width: '', height: '' },
      getBoundingClientRect: () => ({ left: 11, top: 7 }),
    },
    context: countingContext(counts),
    createSurface: stubSurface,
    createFallback: () => null,
    measure: () => M0_VIEW,
    settle: (run) => {
      run()
    },
    layoutId: DEMO_LAYOUT_ID,
  })
  let now = 1000
  const drive = (count: number): void => {
    for (let i = 0; i < count; i++) {
      now += 16.7
      game.frame(now)
      if (escapePerFrame) {
        // **It has to ESCAPE.** A non-escaping literal is removed by scalar
        // replacement and the control measures nothing — the catalogue's
        // "a non-escaping injection is not an injection".
        ;(globalThis as Record<string, unknown>).__demoSink = { a: i, b: now }
      }
    }
  }
  return { game, drive, counts }
}

function inFlight(game: ReturnType<typeof createGame>): number {
  let n = 0
  for (let c = 0; c < game.state.carPhase.length; c++) {
    const phase = game.state.carPhase[c] as number
    if (phase === PHASE_OUTBOUND || phase === PHASE_RETURNING) n++
  }
  return n
}

describe('the frame loop on the demo board allocates nothing, measured', () => {
  it('charges no game, sim or render source file beyond its budget, over three windows', () => {
    const { game, drive } = demoRig(false)
    drive(WARMUP_FRAMES)

    // **The minimum over three windows, which is the instrument this repo
    // already derived for independent sampling noise.** A per-frame allocation
    // appears in EVERY window; a stray sample appears in about one in five. On
    // this rig, measured across four single draws, `flowfield.ts` reported
    // 16.81 / 18.63 / 20.71 / 21.75 — present every time — while `camera.ts`
    // (8.04), `atlas.ts` (7.71) and `hash.ts` (1.4-2.6) each appeared in one
    // draw and were absent from the rest. A single draw would have failed this
    // test about half the time, on files that allocate nothing.
    // The rebuild count is captured around each window rather than in a rig of
    // its own: a second profiled RUN in this file is the thing that let
    // TurboFan inline `draw` and turned `drawAllocation`'s control red, so the
    // per-call arm below reuses these same three windows and adds no profiling.
    const windows: Map<string, number>[] = []
    const rebuildsPerWindow: number[] = []
    for (let w = 0; w < WINDOW_COUNT; w++) {
      const before = game.scratch.counters[CT_REBUILDS] as number
      windows.push(
        profileBytesByFile(() => {
          drive(PROFILED_FRAMES)
        }),
      )
      rebuildsPerWindow.push((game.scratch.counters[CT_REBUILDS] as number) - before)
    }

    // ---------------------------------------------------------------------
    // **THE LIVENESS GUARD RUNS FIRST, AND THE ORDER IS THE WHOLE POINT.**
    // ---------------------------------------------------------------------
    // These three were at the FOOT of this test and M1e Task 8 measured what
    // that cost. `WINDOW_COUNT` 3 -> 4 — the exact edit they exist to refuse,
    // and the one this file's own comments invite — failed instead on *"too few
    // rebuilds per window for a per-call rate to mean anything: expected 81 to
    // be greater than 300"*. That IS the freeze talking, but it reads as a
    // board that stopped rebuilding, and a maintainer would go looking at the
    // flow field. **An assertion placed above another can make the second
    // unreachable**, and the one that explains a failure has to run first.
    //
    // Every number below this line is a claim about a running simulation, so
    // "is it running" is the precondition, not the epilogue.
    //
    // **Proven to discriminate rather than asserted to**, which is the other
    // half of that lesson: `WINDOW_COUNT` 3 -> 4 now fails on *"must profile a
    // LIVE sim"*, while `PROFILED_FRAMES` 3000 -> 3100 — a knob change that
    // stays alive — fails only on the identity pin, with *"the measured end
    // tick is 6,459"*. Two edits, two different reds. If every edit produced
    // the same red, the later assertions would be decoration.
    //
    // The FLAG is first of the three because it is the only structural one: the
    // two `H_TICK` lines compare against a measured constant, so both go wrong
    // together the day `DEMO_DEATH_TICK` goes stale, while this one reads the
    // byte `step` actually branches on and survives someone changing the layout
    // under this rig.
    expect(
      isGameOver(game.state),
      'this window must profile a LIVE sim — every budget below was measured on a frozen board',
    ).toBe(false)
    expect(
      game.state.header[H_TICK],
      'this rig drove past the demo board’s death tick — the budgets below were measured on a corpse',
    ).toBeLessThan(DEMO_DEATH_TICK)
    expect(game.state.header[H_TICK], 'and the measured end tick is 6,459').toBe(6459)

    const files = new Set<string>()
    for (const window of windows) {
      for (const file of window.keys()) {
        if (PROFILED_SCOPES.some((scope) => file.startsWith(scope))) files.add(file)
      }
    }

    // **The harness must fail loudly when it resolves nothing.** A path
    // derivation that matches no file reports "clean" unconditionally, which is
    // exactly how the worktree bug stayed invisible for two milestones.
    expect(
      files.size,
      'nothing resolved under any profiled scope — the path derivation is broken, not the code',
    ).toBeGreaterThan(0)

    const perFrameMin = new Map<string, number>()
    for (const file of files) {
      let min = Infinity
      for (const window of windows) min = Math.min(min, (window.get(file) ?? 0) / PROFILED_FRAMES)
      perFrameMin.set(file, min)
    }

    const budgetFor = (file: string): number => {
      if (file.endsWith('/loop.ts')) return LOOP_BUDGET_BYTES_PER_FRAME
      return NOISE_FLOOR_BYTES_PER_FRAME
    }
    // ---------------------------------------------------------------------
    // `flowfield.ts` per CALL — see FLOWFIELD_BUDGET_BYTES_PER_CALL.
    // ---------------------------------------------------------------------
    // Asserted BEFORE the per-frame offenders list, deliberately: for this one
    // file the per-frame arm is a weak instrument (its event is rare per
    // frame), so if both fire the reader should get the well-separated
    // diagnostic rather than a 4.1-against-4.0 one. The two are complementary
    // rather than redundant — if a future regression's bytes land on a
    // DIFFERENT file, because V8 attributed them across an inline boundary, the
    // per-frame list below is what catches it.
    //
    // Vacuity, and the precondition from the constant's comment: enough
    // rebuilds per window for the sampler to see the event at all. 381-384 is
    // the measured figure; 300 is the floor asserted so this arm fails loudly
    // if the board ever stops rebuilding rather than quietly measuring a ratio
    // over a tiny denominator.
    for (const rebuilds of rebuildsPerWindow) {
      expect(
        rebuilds,
        'too few rebuilds per window for a per-call rate to mean anything',
      ).toBeGreaterThan(300)
    }
    const flowfieldPerCall = Math.min(
      ...windows.map((w, i) => (w.get(FLOWFIELD_FILE) ?? 0) / (rebuildsPerWindow[i] as number)),
    )
    expect(
      flowfieldPerCall,
      `flowfield.ts allocates ${flowfieldPerCall.toFixed(2)} B per computeFlowField call ` +
        `(rebuilds/window: ${rebuildsPerWindow.join('/')}) — do NOT widen this budget; ` +
        'the allocation it watches for was deleted in M1e Task 3 and a charge here is a regression',
    ).toBeLessThan(FLOWFIELD_BUDGET_BYTES_PER_CALL)

    const offenders = [...perFrameMin]
      .filter(([file, perFrame]) => perFrame > budgetFor(file))
      .map(([file, perFrame]) => `${file} at ${perFrame.toFixed(2)} B/frame`)
      .sort()
    expect(offenders).toEqual([])
  })

  it('is not vacuous: the rig really drove 24 cars, 18 destinations and 71 road cells', () => {
    // A green harness is a claim about its inputs. Every number here is the
    // reason this file exists rather than a reuse of the existing rigs, so each
    // is asserted: if the demo board ever stops being the busiest thing in the
    // repo, this test says so instead of quietly measuring the old load.
    const { game, drive, counts } = demoRig(false)
    drive(300)
    // **Every number below passes on a FROZEN board** — measured at M1e Task 7
    // by freezing the sim and re-running them: frozen cars keep their slot and
    // their phase, frozen roads keep their bits, and `loop.frame` renders
    // whether or not a tick drained, so the blit and fill counts keep rising.
    // This rig only drives 300 frames so it cannot reach the shutdown, but the
    // guard is what says that rather than the arithmetic.
    expect(isGameOver(game.state), 'the vacuity guards below are blind to a freeze').toBe(false)
    expect(game.layoutId).toBe('demo')
    expect(game.state.carPhase.length).toBe(24)
    expect(inFlight(game)).toBeGreaterThanOrEqual(15)
    expect(game.builder.frame.carCount).toBeGreaterThanOrEqual(15)
    expect(game.builder.frame.destCount).toBe(18)
    let roadCells = 0
    for (let c = 0; c < game.world.cells; c++) if ((game.state.roads[c] as number) !== 0) roadCells++
    expect(roadCells).toBe(71)
    // ...and the draw path really ran: blits are the road pass, fills are
    // terrain, buildings, cars and pins.
    expect(counts.blits).toBeGreaterThan(0)
    expect(counts.fills).toBeGreaterThan(0)
  })

  it('is not vacuous: the SAME predicate reports one escaping object per frame', () => {
    // The positive control, as a DELTA between two profiles of the same rig
    // rather than an absolute figure — the instrument is bimodal and a single
    // draw is a verdict, not a quantity.
    const clean = demoRig(false)
    clean.drive(WARMUP_FRAMES)
    const cleanProfile = profileBytesByFile(() => {
      clean.drive(PROFILED_FRAMES)
    })

    const dirty = demoRig(true)
    dirty.drive(WARMUP_FRAMES)
    const dirtyProfile = profileBytesByFile(() => {
      dirty.drive(PROFILED_FRAMES)
    })

    const inThisFile = (byFile: Map<string, number>): number => {
      let bytes = 0
      for (const [file, n] of byFile) if (file.endsWith('demoAllocation.test.ts')) bytes += n
      return bytes
    }
    const delta = (inThisFile(dirtyProfile) - inThisFile(cleanProfile)) / PROFILED_FRAMES
    expect(delta).toBeGreaterThan(NOISE_FLOOR_BYTES_PER_FRAME * 4)
  })

  it('keeps its budgets equal to the ones allocation.test.ts derived', () => {
    // Two copies of a threshold drift, and the copy is the one nobody
    // re-derives. `allocation.test.ts` owns the derivation of both numbers; this
    // asserts the copy still matches the source rather than restating the
    // reasoning.
    expect(LOOP_BUDGET_BYTES_PER_FRAME).toBe(32)
    expect(NOISE_FLOOR_BYTES_PER_FRAME).toBe(4)
    // Owned HERE, not copied from anywhere — see the constant's derivation. The
    // bound must stay clear of the signal in BOTH directions, or it is an
    // allowance wearing a budget's name. Weakest observed signal over 8 draws:
    // 20.83 B/call. Single stray sample over ~381 calls: 1.34 B/call.
    expect(FLOWFIELD_BUDGET_BYTES_PER_CALL).toBe(8)
    expect(FLOWFIELD_BUDGET_BYTES_PER_CALL * 2.5).toBeLessThan(20.83)
    expect(FLOWFIELD_BUDGET_BYTES_PER_CALL).toBeGreaterThan(1.34 * 4)
    // -----------------------------------------------------------------------
    // **AND AN UPPER BOUND, because the two lines above are lower bounds on the
    // exact knobs that would drive this rig past the tick the board dies on.**
    // -----------------------------------------------------------------------
    //
    // M1e Task 7 measured the demo board's overcrowd failure at tick **6,703**
    // (`demoLayout.test.ts`'s `DEMO_DEATH_TICK`). Task 8 makes reaching it
    // freeze the sim, after which every further tick is a byte-identical no-op.
    // This rig ends at tick **6,459** — 244 ticks, 3.6 %, under it, the
    // tightest margin in the repo — and **a fourth window would put it at
    // ~7,962, i.e. 1,259 ticks past the freeze.** The file's own comments
    // recommend more windows, so that is a likely edit and not a hypothetical.
    //
    // **Neither vacuity guard would notice**, which is what makes a mechanical
    // bound necessary rather than tidy: the "really drove 24 cars" check runs on
    // a separate rig, and the positive control measures a delta between two
    // profiles of the SAME rig, so it fires identically on a frozen board. The
    // budgets would then be measured over a sim that is not running, and report
    // clean.
    //
    // **The authoritative guard is DYNAMIC and lives in the profiling test
    // above**, which reads `H_TICK` off the rig it actually drove — an
    // arithmetic model of the frame-to-tick mapping is exactly the kind of
    // derivation that goes stale, and this one already did: a first draft
    // assumed one tick per two frames and computed 5,250 against a measured
    // 6,459, because it forgot the 1,200-tick warm start and the accumulator's
    // 16.7/33.3 ratio.
    //
    // What is worth having HERE is a cheap ceiling on the two knobs, so the
    // edit the file's own comments invite — "use more windows" — fails at the
    // knob rather than 3,000 frames later. The rate is measured, not modelled:
    // 10,500 frames carried the sim from its 1,200-tick warm start to tick
    // 6,459, i.e. 0.5009 ticks per frame.
    const framesDriven = WARMUP_FRAMES + WINDOW_COUNT * PROFILED_FRAMES
    const TICKS_PER_FRAME = (6459 - 1200) / 10500
    const framesToDeath = (DEMO_DEATH_TICK - 1200) / TICKS_PER_FRAME
    // **THE TWO BOUNDS FIRST, THE IDENTITY PIN LAST — and the pin has now
    // dominated something twice, so read this before reordering it again.**
    //
    // `expect(framesDriven).toBe(10500)` fires for ANY knob change at all, in
    // either direction. M1e Task 8 first moved it below the CEILING and left it
    // above the FLOORS, which fixed one case and left the mirror image: setting
    // `PROFILED_FRAMES` to 2,000 — the exact shrink the floor exists to catch —
    // failed on *"the measured frame count behind the 6,459: expected 7500 to
    // be 10500"* and the floor never ran. Same defect, one line down, found the
    // same way.
    //
    // The rule the ordering encodes: **a pin that fires for every edit belongs
    // after every bound that fires for one KIND of edit.** Three specific
    // guards, then the catch-all.
    //
    // Measured to discriminate, three edits and three different reds:
    //   WINDOW_COUNT 3 -> 4      -> 'past its death tick'      (the ceiling)
    //   PROFILED_FRAMES -> 2000  -> 'shrunk below the length'  (the floor)
    //   PROFILED_FRAMES -> 3100  -> 'the measured frame count' (the pin)
    expect(
      framesDriven,
      'these knobs now drive the demo rig past its death tick — see DEMO_DEATH_TICK',
    ).toBeLessThan(framesToDeath)
    // The FLOORS, second: the sampler needs enough frames and enough windows for
    // the minimum-over-three statistic to mean anything. They guard the
    // opposite direction from the ceiling and must be reachable independently
    // of it — including independently of the fourth-window premise below, which
    // ALSO goes false when the window shrinks and dominated them on the first
    // attempt at this ordering.
    expect(
      PROFILED_FRAMES,
      'the profiling window has shrunk below the length these budgets were measured over',
    ).toBeGreaterThanOrEqual(3000)
    expect(
      WINDOW_COUNT,
      'fewer than three windows and the minimum stops defeating the sampler’s strays',
    ).toBeGreaterThanOrEqual(3)
    // The ceiling's own premise, third: a fourth window is the specific edit it
    // guards, so it has to be over the line rather than merely near it. This is
    // broader than either bound above — it goes false when the window shrinks
    // too — which is exactly why it sits below them.
    expect(WARMUP_FRAMES + 4 * PROFILED_FRAMES).toBeGreaterThan(framesToDeath)
    // The catch-all, LAST.
    expect(framesDriven, 'the measured frame count behind the 6,459').toBe(10500)
    expect([...PROFILED_SCOPES].sort()).toEqual([
      'packages/game/src/',
      'packages/render/src/',
      'packages/sim/src/',
    ])
  })
})
