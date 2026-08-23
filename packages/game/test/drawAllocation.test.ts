import { describe, it, expect } from 'vitest'
import { Session } from 'node:inspector'
import {
  OVERCROWD_FAIL_MILLITICKS,
  OVERCROWD_FULL_MILLITICKS,
  REVEALED_X0,
  REVEALED_Y0,
  TICKS_PER_WEEK,
} from '@laneways/shared'
import { H_TICK, isGameOver, offerPending } from '@laneways/sim'
import {
  PALETTE,
  createOfferRects,
  offerRects,
  type AtlasContext,
  type AtlasSurface,
} from '@laneways/render'
import { createGame, type GameContext } from '../src/main'
import { CITY_LAYOUT_ID } from '../src/layouts'
import { CITY_DEATH_TICK } from './deathTicks'
import { takeCardPolicy } from './cardPolicy'
import { repoRelative } from './allocationPaths'

/**
 * **`render/src/canvas.ts` under the allocation profiler — the gap the file's
 * own module comment names this task for.**
 *
 * `test/allocation.test.ts` has profiled the whole `game` assembly since Task 6
 * and it passes a **no-op `draw`**, so the one function in `render` that runs
 * sixty times a second has been held to *"review is the only check of this file
 * specifically"* — which `canvas.ts` says in as many words, twice, and which
 * Task 8 rewrote to say it would close here. Two things in that file are exactly
 * the shape that has bitten this project twice: `HUD_SCRATCH`, a module-level
 * `HudRects` that would otherwise be one object per frame, and the value-keyed
 * text cache, which exists because `'W' + week` allocates a string and the HUD
 * formats four numbers a frame. Neither is observable from a recording context —
 * two equal strings are indistinguishable however many were allocated.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE, WHICH IS A MEASUREMENT AND NOT A PREFERENCE
 * ---------------------------------------------------------------------------
 *
 * It lived in `test/integration.test.ts` first and reported
 * **~1,160 B/frame against `canvas.ts`, reproducibly, across five runs** — a
 * violation that does not exist. That file's other tests drive `drawFrame` with
 * a *recording* context, so by the time the profiled test ran, every call site
 * in the draw path had seen two receiver shapes and gone polymorphic; the same
 * draw path in a file that only ever passes one shape measures **13-16**.
 *
 * That is the catalogue's *"a test that reads the JIT's attribution is a test
 * that another test can turn red"*, arriving through a sibling test's **stub
 * shape** rather than through an added profiled run. A profiler cannot tell the
 * code under test from the harness around it, so this file has exactly one
 * context shape and exactly one profiled rig.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DRIVES, WRITTEN DOWN BECAUSE A GREEN HARNESS IS A CLAIM ABOUT ITS
 * INPUTS
 * ---------------------------------------------------------------------------
 *
 * A **road on the board** (so the road pass blits rather than short-circuiting
 * on every cell and `atlasSourceX`/`atlasSourceY` actually run), **six ghost
 * cells** (so the M1d Task 8 ghost pass does the same, from the other atlas), a
 * **car in motion** (so `drawCars` iterates a non-empty prefix and the
 * group-colour lookup runs), **three destinations with pins**, **three
 * houses**, and a HUD whose clock crosses at least one day boundary inside the
 * profiled window (so the text cache is exercised on both the hit and the miss
 * path). The counts below are asserted, so a rig that stopped driving one of
 * them turns this red rather than quietly measuring less.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GHOSTS ARE WRITTEN INTO STATE RATHER THAN ERASED INTO EXISTENCE
 * ---------------------------------------------------------------------------
 *
 * A ghost is **transient by design**: `sim` clears it the moment the last
 * committed car crosses off the cell, which on this rig's 4-cell road is a few
 * dozen ticks. The profiled window is 3,000 frames — about 1,500 ticks — and
 * the requirement is a ghost present *for the profiled frames*, not for some of
 * them. Driving a fresh erase every N frames would exercise the pointer and
 * tick paths rather than the draw path and would perturb the very budget being
 * measured; a durable ghost is what this file needs and `sim` has no
 * production event that produces one.
 *
 * So `seedGhosts` below writes the two regions an erase writes — `ghostMask`
 * (the bit `render` blits) and `ghostCommitted` (the count that keeps the
 * refund owed) — on six cells inside the revealed rect that carry no road and
 * that no car can reach, since the only road on the board is the 4-cell drag.
 * The resulting state is one `sim` can genuinely be in: six deferred refunds
 * whose committed cars have not arrived. The vacuity block asserts the bytes are
 * **still there after the whole window**, so "the sim quietly cleared them" is a
 * red test rather than a silent loss of coverage.
 *
 * What it does NOT drive, and deliberately: a viewport change. `fitCamera`
 * allocates one `Camera` per measurement by design (Task 3: *"it runs at boot,
 * after the fullscreen settle, and on a stable viewportChanged — never per
 * frame"*), and charging that to this budget would be measuring the rig.
 */

/** One stack per 512 B, matching `test/allocation.test.ts`. */
const SAMPLING_INTERVAL_BYTES = 512
const PROFILED_FRAMES = 3000
const WARMUP_FRAMES = 1500

/**
 * **Three windows, minimum taken — adopted at M1e Task 5, and adopted because
 * the single-window form measurably stopped discriminating.**
 *
 * Task 5's spawn phase grows the fleet inside `step`, so this rig's city board
 * finishes the window with 14 cars where M2 measured it with 6. `drawCars` is
 * `canvas.ts`'s hottest loop, and the file's single-window residual went from
 * a measured `15.25 .. 19.94` to `39.01 .. 58.94` over ten runs each —
 * **against a smallest-realistic-regression of one escaping object per frame,
 * which measures 78.39 .. 101.68 on this same rig.** A single-window budget
 * would have had to sit between 59 and 78: 1.15x above the noise and 1.15x
 * below the signal, which is the "threshold inside the noise band" defect this
 * project has shipped twice.
 *
 * **Two repairs were measured and only one worked.** Dropping
 * `samplingInterval` to 128 — the fix that rescued the flow-field arm — did
 * nothing here: eight runs gave `36.63 .. 63.82`, no tighter than 512's. So the
 * spread is not sampling noise, it is genuine run-to-run variation in V8's
 * attribution, and the instrument for that is the minimum over independent
 * windows. `demoAllocation.test.ts` has used exactly this since M1e Task 3 and
 * holds `canvas.ts` under a **4** B/frame floor on a board with **24** cars,
 * which is the direct evidence that the residual is stray rather than
 * per-car-systematic and that the minimum kills it.
 */
const WINDOW_COUNT = 3

/**
 * **`canvas.ts`'s per-file exemption is GONE as of M1e Task 5, and it is the
 * minimum over three windows that retired it rather than anything about the
 * code.**
 *
 * What it used to say: a single 3,000-frame window charged `canvas.ts`
 * `15.25 .. 19.94` B/frame over ten runs (mean 18.2, of which a per-function
 * profile put 13.5 on `drawCars` and 2.3 on `drawHud`), so it carried a
 * dedicated 32 B/frame budget while every other `render/src` file took the
 * 4 B/frame floor.
 *
 * Task 5 grew this rig's fleet from 6 cars to 14 and the same single-window
 * figure went to `39.01 .. 58.94` over ten runs, against a smallest-realistic
 * regression measured at `78.39 .. 101.68` on the same rig. Widening the
 * exemption to fit would have put the threshold 1.15x above the noise and 1.15x
 * below the signal — the "budget inside the noise band" defect, twice over.
 * Under `WINDOW_COUNT` windows the same rig measures `0.00 .. 0.43` clean and
 * `34.59 .. 42.23` injected, so the ordinary floor is **9.3x above the worst
 * clean draw and 8.6x below the weakest signal**, and the exemption has nothing
 * left to excuse.
 *
 * A budget of 0 is still not available — see `test/allocation.test.ts`'s
 * `NOISE_FLOOR_BYTES_PER_FRAME` for why a sampling profiler cannot have one.
 *
 * ---------------------------------------------------------------------------
 * **THE FIGURE IS WORKLOAD-SENSITIVE, AND SINCE M1e TASK 5 THE WORKLOAD IS
 * DECIDED BY THE SPAWNER. Read this before widening anything.**
 * ---------------------------------------------------------------------------
 *
 * `canvas.ts`'s residual scales with `frame.carCount`, and the fleet on this rig
 * is no longer a constant: the spawn phase places houses inside `step`, so a
 * task that changes spawn tuning changes this measurement without touching one
 * line of `render`. Measured during Task 5's mutation battery, on the canonical
 * five-package parallel run:
 *
 *   - unmutated tree, base and head: **clean on 17 of 17 runs** (6 at
 *     `88f6cdb`, 6 at head, 5 interleaved baselines).
 *   - under two mutants that genuinely change WHICH buildings spawn — dropping
 *     the scan start's tick term, and dropping `colourUnlocked`'s seeded clause
 *     — `canvas.ts` read **6.42** and **7.63** B/frame. Both runs ALSO failed
 *     the vacuity test below, i.e. the fleet really was different. Those are
 *     not strays; they are this metric answering a question about the board.
 *   - `packages/render/src/types.ts` read **5.22** and **5.75** on two mutants
 *     that change nothing on this board. Those two ARE strays, against a floor
 *     that predates Task 5.
 *
 * So if this test goes red on a file whose code nobody touched, **check the
 * vacuity test's `carCount` first**: a moved fleet is a spawn-tuning change and
 * the honest response is to re-derive the pinned counts, not to widen the
 * floor. The floor stays at 4 because the unmutated tree measures 0.00-0.43
 * (isolated, eight draws) and 0 of 17 under contention; the band it sits in is
 * empty and a wider one would give up the 8.6x separation from a real signal.
 */
const NOISE_FLOOR_BYTES_PER_FRAME = 4

const RENDER_SRC = 'packages/render/src/'

const M0_VIEW = {
  cssW: 406,
  cssH: 870,
  topInset: 46,
  bottomInset: 34,
  rawDpr: 3,
  performanceClass: null,
} as const

interface ProfileNode {
  callFrame: { functionName: string; url: string }
  selfSize: number
  children?: ProfileNode[]
}

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
    // Load-bearing: without it only SURVIVORS are counted and every short-lived
    // per-frame object — precisely the ones the rule forbids — is invisible.
    // `test/allocation.test.ts` owns the dedicated test for this flag.
    includeObjectsCollectedByMinorGC: true,
    includeObjectsCollectedByMajorGC: true,
  })
  body()
  raw.post('HeapProfiler.stopSampling', (_err, result) => {
    profile = (result as { profile?: { head: ProfileNode } } | undefined)?.profile?.head ?? null
  })
  session.disconnect()
  if (profile === null) throw new Error('the draw profiler returned no profile')

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

/**
 * What the rig proves it actually drew. **Two counters, both written and both
 * read** — the object this replaces had four fields, none of which was ever
 * assigned and none of which any test read, which is the same defect class as an
 * assertion that cannot fail wearing the costume of instrumentation.
 *
 * `cars`, `pins` and `clockTexts` are gone rather than wired: the vacuity block
 * already asserts all three from `game.state` and `builder.frame`, and counting
 * them here would mean classifying `fillRect` calls by geometry inside the
 * profiled loop — real work per call, in the hot path, duplicating
 * `render/test/canvas.test.ts`'s classifier to learn something already known.
 */
interface DrawCounts {
  /** Blits from the ROAD atlas. */
  blits: number
  /** Blits from the GHOST atlas — the M1d Task 8 pass. */
  ghostBlits: number
  /**
   * Overcrowd rings — the M1e Task 9 pass, and a counter for the same reason
   * `ghostBlits` is one: nothing else in this rig can see whether the pass ran.
   * A budget measured over a window in which no ring was drawn is vacuous for
   * that phase exactly as an idle input queue was for `inputs.ts`.
   */
  rings: number
  /**
   * Shutdown scrims. Classified by `fillStyle` identity, which is ONE pointer
   * comparison per `fillRect` — deliberately not the geometry classification
   * `:181` records as removed, because that meant real per-call work in the hot
   * path to learn something `game.state` already knew. This one is not
   * knowable from `game.state`: a frozen game whose scrim phase silently
   * stopped running looks identical from the outside.
   */
  scrimFills: number
  /**
   * §5.10's card faces — M1f Task 8, and a counter for the same reason
   * `scrimFills` is one. Phase 12 is the file's second conditional phase, so a
   * window that never raised an offer measures nothing about it and looks
   * identical to one that did. Classified by `fillStyle` identity, one pointer
   * comparison per `fillRect`, exactly as the scrim is.
   */
  cardFaceFills: number
  /**
   * §5.10's peek pill, which is the ONE thing phase 12 draws in both of its
   * arms — so it is the anchor for the peek window, where there is no card face
   * and no scrim to count and the board underneath is the city's, which seeds
   * no roads and therefore blits nothing.
   */
  peekPillFills: number
}

/**
 * The ONE context shape this file ever creates. See the module comment for what
 * happens when a second shape reaches the same call sites.
 *
 * `drawImage` separates the two layers by **source surface identity**, which is
 * the only thing that distinguishes them: the two atlases have the same size,
 * the same grid and the same tile rects, so a ghost blit and a road blit are
 * identical in every recorded number. `surfaces.ghost` is a holder rather than a
 * captured value because the atlases do not exist until `createGame` returns and
 * this object is one of its arguments; nothing draws in between.
 */
function countingContext(counts: DrawCounts, surfaces: { ghost: unknown }): GameContext {
  // Self-referential so `fillRect` can read the style the draw path just set.
  // The `const` is initialised before any frame runs, so there is no TDZ here.
  const ctx: GameContext = {
    fillStyle: '',
    strokeStyle: '',
    // **A Smi — and THIS HARNESS CANNOT TELL YOU WHETHER IT STAYS ONE.**
    //
    // `canvas.ts` rounds the ring's stroke width so this field never transitions
    // to a Double representation. An earlier version of this comment said the
    // budget below was what caught the fractional form. Measured, it is not:
    // reverting `ringWidth` to `tile * RING_WIDTH_FRACTION` leaves this file
    // **clean on 5 of 5 runs**, because the transition is a ONE-OFF (V8 mutates
    // a Double field in place afterwards) and this rig writes a ring meter
    // before every frame — so the ring draws from frame 1, the transition
    // happens inside `drive(WARMUP_FRAMES)`, and the minimum over three windows
    // never sees it. The change that made the ring budget non-vacuous is the
    // same change that hid this.
    //
    // The detector that DOES exist is
    // `render/test/canvas.test.ts > keeps the stroke width a whole CSS pixel on
    // every tile size, and never zero`. A claim about the instrument needs the
    // same scrutiny as a claim about the code, and this one did not have it.
    lineWidth: 0,
    beginPath: () => undefined,
    arc: () => {
      counts.rings++
    },
    stroke: () => undefined,
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    setTransform: () => undefined,
    fillRect: () => {
      if (ctx.fillStyle === PALETTE.scrim) counts.scrimFills++
      else if (ctx.fillStyle === PALETTE.cardFace) counts.cardFaceFills++
      else if (ctx.fillStyle === PALETTE.cardAccent) counts.peekPillFills++
    },
    fillText: () => undefined,
    drawImage: (image) => {
      if (image === surfaces.ghost) counts.ghostBlits++
      else counts.blits++
    },
  }
  return ctx
}

function zeroCounts(): DrawCounts {
  return { blits: 0, ghostBlits: 0, rings: 0, scrimFills: 0, cardFaceFills: 0, peekPillFills: 0 }
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

/** `(8, 13) -> (7, 12) -> (7, 11) -> (8, 10)`: Task 2's own trip path. */
const PATH: readonly (readonly [number, number])[] = [
  [8, 13],
  [7, 12],
  [7, 11],
  [8, 10],
]

const BOARD_W = 24

/**
 * Six cells at row 27, columns 8-13 — a straight run whose refund is owed.
 *
 * Inside the M0 revealed rect (`x in [5, 19)`, `y in [9, 31)`) so the ghost pass
 * is not culled, and **unreachable by any car**: the only road on this board is
 * the 4-cell drag above, so no route can contain row 27 and nothing will ever
 * call `noteGhostDeparture` on these cells. Six rather than one so the pass is a
 * measurable workload and the positive control below has a signal to move.
 *
 * Six DIFFERENT single-bit masks, which is the shape a real erase leaves — the
 * bit that went — and which makes the pass read six different atlas tiles across
 * two different rows of the grid rather than one tile six times.
 */
const GHOST_CELLS: readonly (readonly [number, number])[] = [
  [8, 27, 1], // N
  [9, 27, 2], // NE — a diagonal tile
  [10, 27, 4], // E
  [11, 27, 8], // SE
  [12, 27, 16], // S
  [13, 27, 64], // W
].map(([x, y, mask]) => [(y as number) * BOARD_W + (x as number), mask as number] as const)

/** Writes the two regions a deferred refund writes. See the module comment. */
function seedGhosts(game: ReturnType<typeof createGame>): void {
  for (const [cell, mask] of GHOST_CELLS) {
    game.state.ghostMask[cell] = mask
    // Non-zero, so the state is one `sim` can genuinely be in: a refund still
    // owed to a committed car that has not arrived. Zero here would be a ghost
    // with nothing to wait for, which no erase produces.
    game.state.ghostCommitted[cell] = 1
  }
}

/**
 * Half of §5.8's FULL meter, so destination 0's ring is half-drawn on every
 * profiled frame. Far below `OVERCROWD_FAIL_MILLITICKS`, so writing it can
 * never end the run this rig is measuring.
 */
const RING_METER = OVERCROWD_FULL_MILLITICKS / 2

interface Driven {
  readonly game: ReturnType<typeof createGame>
  readonly drive: (count: number) => void
  readonly counts: DrawCounts
  /** Weekly card offers this rig resolved — M1f Task 7. See `cardPolicy.ts`. */
  readonly cardsTaken: number
}

/**
 * The same board, **already dead at boot** — the only rig in this repo that
 * profiles `drawShutdown`.
 *
 * A `warmStartTicks` past `CITY_DEATH_TICK` rather than a poked header, so the
 * shutdown is reached through the production path: `runOvercrowd` sets the
 * flag, `step` freezes, `createGame`'s own `if (isGameOver(state)) loop.end()`
 * ends the loop — and the loop keeps DRAWING, which is the whole property the
 * shutdown screen depends on and the thing this rig therefore measures.
 *
 * No pointer drag: `down()` on a dead board asks for a new run, and the
 * injected `restart` throws so that a rig which accidentally taps says so. The
 * ghosts are still seeded, so the workload is the live rig's minus the ticks.
 */
function deadGame(): Driven {
  const counts = zeroCounts()
  const surfaces: { ghost: unknown } = { ghost: null }
  const game = createGame({
    restart: () => {
      throw new Error('the dead draw rig tapped the board — it must only DRAW')
    },
    layoutId: CITY_LAYOUT_ID,
    warmStartTicks: CITY_DEATH_TICK,
    canvas: {
      width: 0,
      height: 0,
      style: { width: '', height: '' },
      getBoundingClientRect: () => ({ left: 11, top: 7 }),
    },
    context: countingContext(counts, surfaces),
    createSurface: stubSurface,
    createFallback: () => null,
    measure: () => M0_VIEW,
    settle: (run) => {
      run()
    },
  })
  surfaces.ghost = game.atlases.ghost.surface
  seedGhosts(game)

  let now = 1000
  const drive = (count: number): void => {
    for (let i = 0; i < count; i++) {
      now += 16.7
      game.frame(now)
    }
  }
  // **No card policy here, deliberately, and it is not an omission.** This rig
  // is already terminal at boot: `createGame` called `loop.end()`, `setPaused`
  // is refused for the rest of the run and `advance` never runs again, so no
  // offer can be raised and none can be resolved. `takeCardPolicy` would return
  // false on every call — its own `over` guard — and enqueue nothing. See
  // `cardPolicy.ts` for why that guard exists rather than being left to this
  // call site.
  return { game, drive, counts, cardsTaken: 0 }
}

/**
 * **A board stopped at §5.10's modal, drawing phase 12 on EVERY profiled
 * frame — M1f Task 8.**
 *
 * Without this rig the modal's per-frame allocation is covered only NOMINALLY,
 * and the distinction is the whole reason the rig exists. `drivenGame` above
 * crosses the week-1 boundary inside its last window, so `drawOffer` runs on
 * roughly **two frames of three thousand** — far below a 512-byte sampling
 * profiler's floor, by construction, exactly as Task 7 measured for
 * `applyChooseCard`. A window that green-lights a phase it sampled twice is
 * this catalogue's *"instrument that reports clean while measuring nothing"*,
 * and it is worse than no instrument because it reads as coverage.
 *
 * Here the offer is up before the first frame, so the modal draws 3,000 times
 * per window: the card faces, the four memoised number->string caches
 * (`grantTextA`/`grantTextB`/`itemsText` and the title's own constants), the
 * peek pill, and `offerRects` writing into `canvas.ts`'s module scratch.
 *
 * **How it gets there without poking a header.** `warmStartTicks =
 * TICKS_PER_WEEK` drives `step` directly 4,500 times, which is what
 * `createGame` already does at boot — so phase 1 advances `H_WEEK` to 1 and
 * phase 4 raises a real pair from the real seed. `sim` has no notion of pause,
 * so the warm start crosses the boundary without stopping; the FIRST frame then
 * drains one tick, `onOfferRaised` fires, and the loop is paused for every
 * frame after it. 4,500 is comfortably inside `CITY_DEATH_TICK` (5,580), so the
 * board is alive and the shutdown phase never runs — asserted below, because a
 * dead board would draw a scrim instead and the counter would not say which.
 *
 * `peek` drives the peek arm instead, which draws strictly less: the pill and
 * its label, no scrim and no faces.
 */
function modalGame(options: { peek?: boolean } = {}): Driven {
  const counts = zeroCounts()
  const surfaces: { ghost: unknown } = { ghost: null }
  const game = createGame({
    restart: () => {
      throw new Error('the modal draw rig tapped a dead board — it must be paused at an OFFER')
    },
    layoutId: CITY_LAYOUT_ID,
    // Exactly the boundary: `step` raises the offer on this tick and `sim` has
    // no pause, so the warm start walks straight through it.
    warmStartTicks: TICKS_PER_WEEK,
    canvas: {
      width: 0,
      height: 0,
      style: { width: '', height: '' },
      getBoundingClientRect: () => ({ left: 11, top: 7 }),
    },
    context: countingContext(counts, surfaces),
    createSurface: stubSurface,
    createFallback: () => null,
    measure: () => M0_VIEW,
    settle: (run) => {
      run()
    },
  })
  surfaces.ghost = game.atlases.ghost.surface
  seedGhosts(game)

  let now = 1000
  const drive = (count: number): void => {
    for (let i = 0; i < count; i++) {
      now += 16.7
      game.frame(now)
    }
  }

  // **Driven until the pause arms, rather than a frame count, because the
  // count is three and the reason is two separate facts about `loop.ts`.** The
  // first `frame(now)` assigns the clock reference and drains ZERO ticks
  // whatever its length, so `advance` never runs and nothing can arm the pause;
  // and these frames are 16.7 ms against a 33.3 ms tick, so the second one only
  // fills half the accumulator. The third drains the tick that fires
  // `onOfferRaised`. A literal `drive(3)` would be right today and silently
  // wrong the day either number moves. **No card policy here, and that is the
  // point of the rig**: the offer must stay up.
  for (let i = 0; i < 20 && !game.loop.paused; i++) drive(1)
  if (!game.loop.paused || !offerPending(game.state)) {
    throw new Error(
      `the modal rig did not stop at an offer: paused=${String(game.loop.paused)} ` +
        `pending=${String(offerPending(game.state))} tick=${String(game.state.header[H_TICK])}`,
    )
  }
  if (options.peek === true) {
    const camera = game.shell.camera
    const rects = offerRects(camera, createOfferRects())
    game.pointer.down(1, 11 + rects.peek.x + rects.peek.w / 2, 7 + rects.peek.y + rects.peek.h / 2)
  }

  return { game, drive, counts, cardsTaken: 0 }
}

/**
 * Builds the real game, draws the road, seeds the ghosts, and returns a driver.
 *
 * `now` lives in the returned closure's own frame rather than being captured
 * from the caller, for the same context-slot reason `loop.ts` keeps its
 * accumulator in a `Float64Array`: a captured mutable double boxes once per
 * frame and charges the harness's own noise to the profile it is taking.
 */
function drivenGame(): Driven {
  const counts = zeroCounts()
  let cardsTaken = 0
  const surfaces: { ghost: unknown } = { ghost: null }
  const game = createGame({
    // Never called: this rig's board dies at tick 5,580 and the window ends at
    // ~2,512. A throw rather than a counter, so a future rig that quietly
    // outlived its board says so instead of profiling a restart.
    restart: () => {
      throw new Error('the live draw rig reached a shutdown tap — it is no longer measuring a live board')
    },
    // **`city`, named rather than defaulted.** `PATH` below is a hand-drawn
    // stroke down `firstCity`'s clear column 8 and the ghost seeding erases
    // cells out of it; the default board is the demo, whose 71 seeded road
    // cells and 24 cars make every one of those coordinates mean something
    // else. `demoAllocation.test.ts` is the demo board's own profile — this
    // file's budgets were measured on the city and stay on it.
    layoutId: CITY_LAYOUT_ID,
    canvas: {
      width: 0,
      height: 0,
      style: { width: '', height: '' },
      getBoundingClientRect: () => ({ left: 11, top: 7 }),
    },
    context: countingContext(counts, surfaces),
    createSurface: stubSurface,
    createFallback: () => null,
    measure: () => M0_VIEW,
    settle: (run) => {
      run()
    },
  })
  // Before the first `drive`, and `createGame` itself never draws.
  surfaces.ghost = game.atlases.ghost.surface

  let now = 1000
  const drive = (count: number): void => {
    for (let i = 0; i < count; i++) {
      // **The ring's meter, rewritten before every frame — `seedGhosts`' twin,
      // and it exists for the same reason.**
      //
      // The meter is TRANSIENT by design: `runOvercrowd` integrates it while a
      // destination is over its pin capacity and unwinds it at 2,000
      // milli-ticks a tick while it is not, so a value written once is gone in
      // a few hundred ticks. Measured on this rig without the write, the ring
      // pass runs at **0.096 / 1.482 / 2.046 arcs per frame across the three
      // windows** — and the budget is a MINIMUM over those windows, so the
      // first one decides it and a ring allocation would be diluted twentyfold.
      //
      // One `Int32Array` store per frame, allocation-free, and inert to
      // everything else in the sim: nothing but `runOvercrowd`'s own threshold
      // test reads this region, and `RING_METER` is half of FULL, far below the
      // value that would end the run.
      game.state.destOvercrowd[0] = RING_METER
      now += 16.7
      // M1f Task 7's card policy. This rig drives `WARMUP_FRAMES + WINDOW_COUNT
      // * PROFILED_FRAMES` = 10,500 frames at ~0.5 ticks a frame from a
      // 258-tick warm start, so it crosses `TICKS_PER_WEEK` (4,500) inside its
      // LAST window; without the policy that window profiles a stopped board
      // and every budget in this file passes while measuring nothing. See
      // `cardPolicy.ts`.
      if (takeCardPolicy(game, 0)) cardsTaken++
      game.frame(now)
    }
  }

  drive(1)
  const camera = game.shell.camera
  const px = (gx: number): number => 11 + camera.originX + (gx - camera.x0) * camera.tileSize + camera.tileSize / 2
  const py = (gy: number): number => 7 + camera.originY + (gy - camera.y0) * camera.tileSize + camera.tileSize / 2
  const start = PATH[0] as readonly [number, number]
  game.pointer.down(1, px(start[0]), py(start[1]))
  for (let i = 1; i < PATH.length; i++) {
    const cell = PATH[i] as readonly [number, number]
    game.pointer.move(1, px(cell[0]), py(cell[1]))
  }
  game.pointer.up(1)
  seedGhosts(game)

  return {
    game,
    drive,
    counts,
    get cardsTaken(): number {
      return cardsTaken
    },
  }
}

describe('the real draw path allocates nothing, measured', () => {
  it('charges no packages/render/src file beyond its budget over three 3,000-frame windows', () => {
    const rig = drivenGame()
    const { drive, game } = rig
    drive(WARMUP_FRAMES)
    const windows: Map<string, number>[] = []
    for (let w = 0; w < WINDOW_COUNT; w++) {
      windows.push(
        profileBytesByFile(() => {
          drive(PROFILED_FRAMES)
        }),
      )
    }

    // ---------------------------------------------------------------------
    // **LIVENESS FIRST, because every budget below is a claim about a running
    // board** — the order `demoAllocation.test.ts` had to learn.
    // ---------------------------------------------------------------------
    //
    // M1f Task 7 pauses the loop at each week boundary. This rig crosses the
    // first one inside its last window, so without the card policy in `drive`
    // the third of three profiles would be taken over a frozen sim and every
    // offender list would be empty for the wrong reason.
    // **AND THE MARGIN IS 63 TICKS, WHICH IS A STANDING HAZARD RATHER THAN A
    // COMFORT — 1.1 %, against the 10 % criterion M1f Task 3 set for the demo
    // rig after that one drove past its own death tick.** It is PRE-EXISTING:
    // 10,500 frames x 16.7 ms / TICK_MS = 5,260.5 ticks on top of the 258-tick
    // warm start is 5,518, and this task's card policy costs the one frame a
    // resume eats (16.7 ms, half a tick), so the figure moved 5,518 -> 5,517.
    // Any balance change that pulls `CITY_DEATH_TICK` in by 2 % puts these
    // windows on a corpse. Until this task there was **no liveness guard on
    // this test at all**, so that would have been silent; now it is red.
    expect(isGameOver(game.state), 'the city dies at 5,580 and this rig must stop short').toBe(false)
    expect(game.state.header[H_TICK], 'the measured end tick').toBe(5517)
    expect(game.state.header[H_TICK]).toBeLessThan(CITY_DEATH_TICK)
    expect(CITY_DEATH_TICK - 5517, 'the margin, in ticks — 2.1 s, and it is thin').toBe(63)
    expect(rig.cardsTaken, 'the week-1 offer was raised inside window 3 and resolved').toBe(1)

    // **The harness must fail loudly when it resolves nothing.** A measurement
    // instrument that reports "clean" while measuring zero files is worse than
    // no instrument, and that is exactly how the worktree path bug hid for two
    // tasks. Every profile of a real frame contains allocation from `render`'s
    // own module scope, so this is a liveness check on the path arithmetic.
    const resolved = [...new Set(windows.flatMap((w) => [...w.keys()]))]
    expect(
      resolved.some((file) => file.startsWith(RENDER_SRC)),
      `nothing resolved under ${RENDER_SRC} — the path derivation is broken, not the code. ` +
        `sample: ${resolved.slice(0, 4).join(' | ')}`,
    ).toBe(true)

    // The MINIMUM over the three windows, per file — see `WINDOW_COUNT`.
    const perFrameMin = new Map<string, number>()
    for (const file of resolved) {
      if (!file.startsWith(RENDER_SRC)) continue
      let min = Infinity
      for (const window of windows) min = Math.min(min, (window.get(file) ?? 0) / PROFILED_FRAMES)
      perFrameMin.set(file, min)
    }

    const offenders = [...perFrameMin]
      .filter(([, perFrame]) => perFrame > NOISE_FLOOR_BYTES_PER_FRAME)
      .map(([file, perFrame]) => `${file} at ${perFrame.toFixed(2)} B/frame`)
      .sort()
    expect(offenders).toEqual([])
  })

  it('the instrument still separates a clean draw from one escaping object, by the measured margin', () => {
    // **The pair of numbers the floor above was chosen from, asserted so the
    // derivation cannot rot into an accident** — the same shape
    // `demoAllocation.test.ts` uses for its own per-call budget. `0.43` is the
    // worst clean minimum over eight runs of `WINDOW_COUNT` windows and `34.59`
    // the weakest injected one over four; both are stated in
    // `NOISE_FLOOR_BYTES_PER_FRAME`'s comment with how they were taken.
    //
    // Strict inequalities against numbers from a DIFFERENT measurement than the
    // budget itself, so this can distinguish the two quantities rather than
    // restating one of them — a margin that holds at exact equality is not a
    // margin.
    expect(NOISE_FLOOR_BYTES_PER_FRAME).toBe(4)
    expect(WINDOW_COUNT).toBe(3)
    // **Both sides are the FLOOR ITSELF, not a multiple of it — the first form
    // of this line read `0.43 * 9 < NOISE_FLOOR * 10`, which is `3.87 < 40` and
    // encodes ~90x rather than the 9.3x its own comment claimed.** The failure
    // that matters is not that it was loose: a later task chasing a red could
    // lower the floor to 1, update the `toBe` pin, and BOTH arms would still
    // pass while the floor sat 2.3x above the worst measured clean draw —
    // inside the flake band this file was rewritten to escape. Same class as
    // commit 88f6cdb's "an equality is not a margin", one iteration later.
    expect(0.43 * 9, 'the floor must sit well above the worst clean draw').toBeLessThan(
      NOISE_FLOOR_BYTES_PER_FRAME,
    )
    expect(NOISE_FLOOR_BYTES_PER_FRAME * 8, 'and well below the weakest signal').toBeLessThan(34.59)
  })

  it('is not vacuous: the rig really did draw roads, ghosts, cars, pins and a changing clock', () => {
    // A green harness is a claim about the inputs it was given. Without this,
    // the budget above is satisfied by a rig that draws an empty board — which
    // is precisely how `inputs.ts`'s 152 B/clear survived a whole task.
    const { game, drive, counts } = drivenGame()
    const frames = WARMUP_FRAMES + PROFILED_FRAMES
    drive(frames)

    let roads = 0
    for (let c = 0; c < game.world.cells; c++) if ((game.state.roads[c] as number) !== 0) roads++
    expect(roads, 'no road, so the road pass short-circuits on every cell').toBe(4)

    const frame = game.builder.frame
    // **14, not the seed's 6, and the number is the workload this budget is
    // measured against** — M1e Task 5's spawn phase places houses inside
    // `step`, so a 4,500-frame window on the city board finishes with 7 houses
    // and 14 cars. `drawCars` is the hottest loop in `canvas.ts` and the file
    // budget below scales with it, which is why this is pinned here rather than
    // written as `> 0`: a fleet that stops growing quietly halves the workload
    // the budget was chosen for.
    expect(frame.carCount, 'no cars, so drawCars never iterates').toBe(14)
    expect(frame.houseCount, 'four houses spawned inside the window').toBe(7)
    // The destination spawner's first attempt lands at tick 2,250 and this
    // window reaches ~2,512, so exactly one destination is placed inside it —
    // the seeded three plus one. `frame.destCount` reaching 4 is also what
    // makes the pin loop below non-vacuous on a board that would otherwise
    // never gain a demand source.
    expect(frame.destCount, 'the spawner placed one destination inside the window').toBe(4)
    let pins = 0
    for (let d = 0; d < frame.destCount; d++) pins += frame.destPins[d] as number
    expect(pins, 'no pins, so the pin loop never runs').toBeGreaterThan(0)
    expect(game.state.header[3] as number, 'H_TILES: the drag really cost tiles').toBe(26)
    // The clock crossed a day boundary inside the window, so the HUD text cache
    // was exercised on the MISS path and not only on the hit path.
    expect(frame.day, 'the clock never advanced, so the text cache never missed').toBeGreaterThan(0)
    // ...and the camera really is the M0 one, so the revealed rect is a strict
    // sub-rect of the board and the draw loops have something to cull.
    expect([frame.camera.x0, frame.camera.y0]).toEqual([REVEALED_X0, REVEALED_Y0])

    // ---- the ghost pass, M1d Task 8 ----------------------------------------
    //
    // **Counted from the recorded draw, not from state**, and that is the
    // difference between "a ghost byte exists" and "the ghost pass ran". A
    // budget measured over a window in which the pass never executed is
    // vacuous for this task exactly as an idle input queue was for `inputs.ts`.
    expect(counts.ghostBlits, 'the ghost pass never blitted — the budget is vacuous').toBe(
      GHOST_CELLS.length * frames,
    )
    // Per frame, not merely non-zero: a ghost drawn on the first frame and gone
    // by the second satisfies `> 0` while leaving the profiled window empty.
    expect(counts.ghostBlits / frames).toBe(GHOST_CELLS.length)
    // The road layer is still doing its own work, so `ghostBlits` is not the
    // road count wearing a new name.
    //
    // `frames - 1` and not `frames`, and the difference is a real property
    // rather than a fudge: `drivenGame` seeds the ghosts by writing state, which
    // is visible on the very next frame, while it lays the road through the
    // POINTER, whose actions are drained by the following tick. So the first
    // frame of this window draws six ghosts and no road. Measured 17,996 =
    // 4 x 4,499; a rig that stopped lagging would fail here, which is the point
    // of writing the arithmetic down instead of loosening the comparison.
    expect(counts.blits).toBe(roads * (frames - 1))

    // The seeded ghosts survived 4,500 frames of real ticks. If `sim` ever
    // starts clearing them — a car routed over row 27, a refund paid — this
    // goes red rather than quietly measuring a frame with no ghost in it.
    for (const [cell, mask] of GHOST_CELLS) {
      expect(game.state.ghostMask[cell] as number, `ghost at cell ${cell}`).toBe(mask)
      expect(game.state.ghostCommitted[cell] as number).toBe(1)
      expect(game.state.roads[cell] as number, 'a ghost cell must carry no live road').toBe(0)
      // Inside the revealed rect, or the pass would cull every one of them and
      // `ghostBlits` above would be 0 for a reason that is not about the pass.
      const x = cell % BOARD_W
      const y = Math.floor(cell / BOARD_W)
      expect(x >= frame.camera.x0 && x < frame.camera.x0 + frame.camera.cols).toBe(true)
      expect(y >= frame.camera.y0 && y < frame.camera.y0 + frame.camera.rows).toBe(true)
    }
    // Distinct masks across two atlas rows, so the pass reads more than one tile.
    expect(new Set(GHOST_CELLS.map(([, m]) => m)).size).toBe(GHOST_CELLS.length)

    // ---- the overcrowd ring, M1e Task 9 ------------------------------------
    //
    // **Per frame, not merely non-zero, and the per-frame form is the whole
    // point.** The budget is a minimum over three windows, so a ring drawn in
    // two of them and not the third leaves the third deciding — and the third
    // is the one with no ring in it. `>= frames` is what makes "the ring pass
    // ran on every profiled frame" a red test rather than a quiet measurement
    // of less.
    expect(counts.rings, 'the ring pass never ran — the budget is vacuous').toBeGreaterThanOrEqual(
      frames,
    )
    // ...and destination 0's meter really is the one holding it up, rather than
    // the natural rings this board grows late in the run.
    expect(frame.destOvercrowd[0] as number, 'the driven meter folds to a drawn ring').toBe(127)
    expect(RING_METER).toBeLessThan(OVERCROWD_FAIL_MILLITICKS)
    // This rig is LIVE, so the shutdown phase must never have run in it. Without
    // this the scrim counter could be reading a board that quietly died.
    expect(counts.scrimFills, 'the live rig must draw no scrim').toBe(0)
    expect(frame.gameOver).toBe(false)
    expect(game.loop.over).toBe(false)
  })

  it('charges no packages/render/src file beyond its budget on a board that is ALREADY DEAD', () => {
    // **The shutdown phase's own budget, and the only place it is measured.**
    // `drawShutdown` is gated on `frame.gameOver`, so every window above runs
    // with it switched off — a conditional phase is unconstrained by every
    // fixture that does not set its gate, which is exactly how a trial version
    // of this scrim left the whole render suite green.
    const { drive, counts } = deadGame()
    drive(WARMUP_FRAMES)
    const windows: Map<string, number>[] = []
    const before = counts.scrimFills
    for (let w = 0; w < WINDOW_COUNT; w++) {
      windows.push(
        profileBytesByFile(() => {
          drive(PROFILED_FRAMES)
        }),
      )
    }

    // **This rig CANNOT use the live budget's liveness anchor, and the reason
    // is the catalogue's worst polarity: that guard is satisfied by
    // ALLOCATION — "every profile of a real frame contains allocation from
    // `render`'s own module scope" — and a frozen board is allocation-free by
    // construction. Measured: `packages/render/src/` appeared in some runs and
    // not others, so the guard flaked green exactly when there was nothing to
    // complain about.
    //
    // So the anchor here is the DRAW COUNTER, which cannot be absent: it says
    // the profiled window really did run the shutdown phase, which is the risk
    // this test exists for. The path arithmetic itself is pinned where it
    // belongs — `allocationPaths.test.ts`, against synthetic roots including a
    // worktree-shaped one — and the live budget above still carries the
    // in-profile anchor.
    expect(
      counts.scrimFills - before,
      'the profiled windows drew no shutdown at all — this budget measures nothing',
    ).toBe(WINDOW_COUNT * PROFILED_FRAMES)

    const resolved = [...new Set(windows.flatMap((w) => [...w.keys()]))]
    const offenders: string[] = []
    for (const file of resolved) {
      if (!file.startsWith(RENDER_SRC)) continue
      let min = Infinity
      for (const window of windows) min = Math.min(min, (window.get(file) ?? 0) / PROFILED_FRAMES)
      if (min > NOISE_FLOOR_BYTES_PER_FRAME) offenders.push(`${file} at ${min.toFixed(2)} B/frame`)
    }
    expect(offenders.sort()).toEqual([])
  })

  it('charges no packages/render/src file beyond its budget with §5.10\'s MODAL up', () => {
    // **Phase 12's own budget, and the only place it is measured on real
    // frames.** `drivenGame` above crosses the week boundary inside its last
    // window and therefore samples `drawOffer` on about TWO frames of three
    // thousand — nominal coverage, below a 512-byte profiler's floor by
    // construction. Here it runs on every one of them.
    const { drive, counts } = modalGame()
    drive(WARMUP_FRAMES)
    const before = counts.cardFaceFills
    const windows: Map<string, number>[] = []
    for (let w = 0; w < WINDOW_COUNT; w++) {
      windows.push(
        profileBytesByFile(() => {
          drive(PROFILED_FRAMES)
        }),
      )
    }

    // The anchor, in the dead rig's idiom and for its reason: a frozen board is
    // allocation-free, so "something from `render` appeared in the profile"
    // flakes green exactly when there is nothing to complain about. The DRAW
    // COUNTER cannot be absent. Two faces per frame.
    expect(
      counts.cardFaceFills - before,
      'the profiled windows drew no modal at all — this budget measures nothing',
    ).toBe(2 * WINDOW_COUNT * PROFILED_FRAMES)

    const resolved = [...new Set(windows.flatMap((w) => [...w.keys()]))]
    const offenders: string[] = []
    for (const file of resolved) {
      if (!file.startsWith(RENDER_SRC)) continue
      let min = Infinity
      for (const window of windows) min = Math.min(min, (window.get(file) ?? 0) / PROFILED_FRAMES)
      if (min > NOISE_FLOOR_BYTES_PER_FRAME) offenders.push(`${file} at ${min.toFixed(2)} B/frame`)
    }
    expect(offenders.sort()).toEqual([])
  })

  it('charges nothing while PEEKING either, which draws a different subset', () => {
    // Peek suppresses the scrim and both faces and keeps the pill, so it is a
    // different set of calls rather than fewer of the same ones — and it is the
    // arm a player holds for as long as they like.
    const { drive, counts } = modalGame({ peek: true })
    drive(WARMUP_FRAMES)
    const facesBefore = counts.cardFaceFills
    const scrimsBefore = counts.scrimFills
    const pillsBefore = counts.peekPillFills
    const windows: Map<string, number>[] = []
    for (let w = 0; w < WINDOW_COUNT; w++) {
      windows.push(
        profileBytesByFile(() => {
          drive(PROFILED_FRAMES)
        }),
      )
    }
    expect(counts.cardFaceFills - facesBefore, 'peek drew a card face').toBe(0)
    expect(counts.scrimFills - scrimsBefore, 'peek dimmed the board').toBe(0)
    // **The pill is the anchor**, because it is the one thing phase 12 draws in
    // both arms — and because the board underneath cannot be one here: this is
    // the starting city, which seeds no roads, so the road layer blits nothing
    // and a `blits > 0` anchor would be a 0-detector that reads as coverage.
    // The ghost layer is what `seedGhosts` put there and it says the board ran.
    expect(counts.peekPillFills - pillsBefore, 'phase 12 never ran at all').toBe(
      WINDOW_COUNT * PROFILED_FRAMES,
    )
    expect(counts.ghostBlits, 'and the board under it was drawn').toBeGreaterThan(0)

    const resolved = [...new Set(windows.flatMap((w) => [...w.keys()]))]
    const offenders: string[] = []
    for (const file of resolved) {
      if (!file.startsWith(RENDER_SRC)) continue
      let min = Infinity
      for (const window of windows) min = Math.min(min, (window.get(file) ?? 0) / PROFILED_FRAMES)
      if (min > NOISE_FLOOR_BYTES_PER_FRAME) offenders.push(`${file} at ${min.toFixed(2)} B/frame`)
    }
    expect(offenders.sort()).toEqual([])
  })

  it('is not vacuous: the modal rig really is stopped at an offer, on a LIVE board', () => {
    // A green budget on a rig that stopped drawing is the catalogue's
    // "instrument that reports clean while measuring nothing"; a rig that
    // quietly died would draw a shutdown screen instead and the file's other
    // counter would not say which phase ran.
    const { game, drive, counts } = modalGame()
    expect(game.state.header[H_TICK], 'one tick past the boundary').toBe(TICKS_PER_WEEK + 1)
    // Non-vacuous on the drive loop above: it really did take more than one
    // frame, and the reason is `loop.ts`'s clock reference plus a 16.7 ms frame
    // against a 33.3 ms tick.
    expect(offerPending(game.state), 'the offer is up').toBe(true)
    expect(game.loop.paused, 'and the loop stopped for it').toBe(true)
    expect(isGameOver(game.state), 'on a board that is ALIVE').toBe(false)
    expect(TICKS_PER_WEEK).toBeLessThan(CITY_DEATH_TICK)

    const frames = 200
    const before = {
      faces: counts.cardFaceFills,
      scrims: counts.scrimFills,
      pills: counts.peekPillFills,
      ghosts: counts.ghostBlits,
    }
    drive(frames)
    expect(counts.cardFaceFills - before.faces, 'two card faces every frame').toBe(2 * frames)
    expect(counts.scrimFills - before.scrims, 'and one scrim').toBe(frames)
    expect(counts.peekPillFills - before.pills, 'and one peek pill').toBe(frames)
    expect(
      counts.ghostBlits - before.ghosts,
      'over a board that is still drawn under it',
    ).toBeGreaterThan(0)
    // Frozen: the modal pause holds for every one of those frames.
    expect(game.state.header[H_TICK]).toBe(TICKS_PER_WEEK + 1)
    expect(game.loop.ticksLastFrame).toBe(0)
    // And the two cards are real, so the memoised grant caches were exercised
    // with two DIFFERENT numbers rather than one value twice.
    const frame = game.builder.frame
    expect(new Set([frame.offerA, frame.offerB]).size).toBe(2)
    expect(frame.offerGrantA).not.toBe(frame.offerGrantB)
  })

  it('is not vacuous: the dead rig really is frozen, and really does draw the shutdown', () => {
    // A green budget on a rig that stopped drawing is the catalogue's
    // "instrument that reports clean while measuring nothing", and a frozen
    // board is the easiest possible way to stop drawing.
    const { game, drive, counts } = deadGame()
    expect(isGameOver(game.state), 'the warm start must have killed it').toBe(true)
    expect(game.state.header[H_TICK]).toBe(CITY_DEATH_TICK)
    expect(game.loop.over, 'and createGame must have ended the loop').toBe(true)

    const frames = WARMUP_FRAMES + PROFILED_FRAMES
    drive(frames)

    // Every frame, exactly one scrim. A shutdown screen drawn once and then
    // dropped satisfies `> 0` while leaving every profiled window empty.
    expect(counts.scrimFills, 'the scrim phase never ran — its budget is vacuous').toBe(frames)
    // The board underneath is still being drawn, which is what makes the
    // translucent scrim mean anything at all.
    expect(counts.ghostBlits / frames).toBe(GHOST_CELLS.length)
    // The killer's ring is drawn under the scrim on every frame — §5.8's hidden
    // grace means it is at 249/255, never 255.
    const frame = game.builder.frame
    const failed = frame.failedDest
    expect(failed, 'the frame must name the destination that did it').toBeGreaterThanOrEqual(0)
    expect(frame.destOvercrowd[failed] as number).toBe(249)
    expect(counts.rings, 'the ring under the scrim').toBeGreaterThanOrEqual(frames)
    // Frozen: not one tick ran across 4,500 frames, so every byte above is the
    // same byte it was at boot.
    expect(game.state.header[H_TICK], 'a tick ran on a dead board').toBe(CITY_DEATH_TICK)
    expect(game.loop.ticksLastFrame).toBe(0)
  })

  /**
   * **This test carries an explicit `testTimeout` and that is not padding.**
   * It profiles the rig TWICE — a delta between two 3,000-frame runs — so it is
   * inherently ~2x the cost of every other test in this file, and it measured
   * **5,134 ms** under parallel load against vitest's 5,000 ms default. A
   * threshold set inside the noise band is a flaky test whichever dimension the
   * noise is in, and here the dimension is time: it is 6/6 green at a clean
   * head and fails as a timeout the moment the machine is busy, which reads as
   * a real allocation regression rather than as a scheduling accident. 30,000 ms
   * is ~6x the observed worst case, far outside the band, and still bounds a
   * genuine hang.
   */
  it('is not vacuous: the SAME predicate reports one escaping object per frame', () => {
    // The positive control, and it is a **delta between two profiles of the same
    // rig** rather than a search for a named allocator — `test/allocation.test.ts`
    // learned that one the hard way when TurboFan inlined its control's function
    // into the caller and the assertion went red on its own.
    //
    // The object must ESCAPE: a per-frame literal that does not is
    // scalar-replaced and measures ~1 B/frame, which would make a control pass
    // while proving nothing.
    const clean = drivenGame()
    clean.drive(WARMUP_FRAMES)
    const before = profileBytesByFile(() => {
      clean.drive(PROFILED_FRAMES)
    })

    const dirty = drivenGame()
    const sink: { a: number }[] = []
    const escape = (): void => {
      sink.length = 0
      sink.push({ a: sink.length })
    }
    const driveDirty = (count: number): void => {
      for (let i = 0; i < count; i++) {
        dirty.drive(1)
        escape()
      }
    }
    driveDirty(WARMUP_FRAMES)
    const after = profileBytesByFile(() => {
      driveDirty(PROFILED_FRAMES)
    })

    const here = (m: Map<string, number>): number =>
      [...m].filter(([f]) => f.endsWith('drawAllocation.test.ts')).reduce((s, [, b]) => s + b, 0) /
      PROFILED_FRAMES
    expect(sink.length).toBe(1)
    expect(
      here(after) - here(before),
      'the profiler cannot see one escaping object per frame — every budget above is vacuous',
    ).toBeGreaterThan(NOISE_FLOOR_BYTES_PER_FRAME * 4)
  }, 30_000)
})
