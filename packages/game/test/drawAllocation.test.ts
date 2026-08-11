import { describe, it, expect } from 'vitest'
import { Session } from 'node:inspector'
import { REVEALED_X0, REVEALED_Y0 } from '@laneways/shared'
import type { AtlasContext, AtlasSurface } from '@laneways/render'
import { createGame, type GameContext } from '../src/main'
import { CITY_LAYOUT_ID } from '../src/layouts'
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
  return {
    fillStyle: '',
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    setTransform: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    drawImage: (image) => {
      if (image === surfaces.ghost) counts.ghostBlits++
      else counts.blits++
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

interface Driven {
  readonly game: ReturnType<typeof createGame>
  readonly drive: (count: number) => void
  readonly counts: DrawCounts
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
  const counts: DrawCounts = { blits: 0, ghostBlits: 0 }
  const surfaces: { ghost: unknown } = { ghost: null }
  const game = createGame({
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
      now += 16.7
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

  return { game, drive, counts }
}

describe('the real draw path allocates nothing, measured', () => {
  it('charges no packages/render/src file beyond its budget over three 3,000-frame windows', () => {
    const { drive } = drivenGame()
    drive(WARMUP_FRAMES)
    const windows: Map<string, number>[] = []
    for (let w = 0; w < WINDOW_COUNT; w++) {
      windows.push(
        profileBytesByFile(() => {
          drive(PROFILED_FRAMES)
        }),
      )
    }

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
