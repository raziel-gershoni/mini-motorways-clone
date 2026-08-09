import { describe, it, expect } from 'vitest'
import { Session } from 'node:inspector'
import { REVEALED_X0, REVEALED_Y0 } from '@laneways/shared'
import type { AtlasContext, AtlasSurface } from '@laneways/render'
import { createGame, type GameContext } from '../src/main'
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
 * A **road on the board** (so `drawRoads` blits rather than short-circuiting on
 * every cell and `atlasSourceX`/`atlasSourceY` actually run), a **car in
 * motion** (so `drawCars` iterates a non-empty prefix and the group-colour
 * lookup runs), **three destinations with pins**, **three houses**, and a HUD
 * whose clock crosses at least one day boundary inside the profiled window (so
 * the text cache is exercised on both the hit and the miss path). The counts
 * below are asserted, so a rig that stopped driving one of them turns this red
 * rather than quietly measuring less.
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
 * The per-file budget, **measured across ten runs before it was chosen**.
 *
 * `packages/render/src/canvas.ts` reports a small residual rather than zero.
 * Ten consecutive runs of this file with the budget set to 0.01 so the figure is
 * printed:
 *
 * ```
 * 17.26  18.03  19.59  19.23  19.94  18.03  19.24  15.25  17.86  17.16
 * ```
 *
 * — mean 18.2, worst 19.94, and a per-function profile of the same rig charges
 * 13.5 of it to `drawCars` and 2.3 to `drawHud`, the two hottest loops. It is
 * not one object per frame: `test/allocation.test.ts` measured that at 37-77
 * B/frame, and the positive control below reinstates the exact object
 * `HUD_SCRATCH` exists to prevent — a `createHudRects()` per `drawHud` — at
 * **214.18 B/frame**.
 *
 * 32 is 1.6x the worst observed and 6.7x below that signal, so the gap between
 * the noise and the thing being watched for is empty. **Do not raise it to make
 * a change pass**, and do not lower it to 20 either: a threshold set inside the
 * upper cluster of a sampling profiler's own noise is a flaky test that looks
 * like a tight one, which this project has already shipped once.
 *
 * A budget of 0 is not available — see `test/allocation.test.ts`'s
 * `NOISE_FLOOR_BYTES_PER_FRAME` for why a sampling profiler cannot have one.
 */
const CANVAS_BUDGET_BYTES_PER_FRAME = 32

/** Everything else in `render/src` gets the same sampling floor the other harness uses. */
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
 * The ONE context shape this file ever creates: a plain object literal that
 * records nothing. See the module comment for what happens when a second shape
 * reaches the same call sites.
 */
function silentContext(): GameContext {
  return {
    fillStyle: '',
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    setTransform: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    drawImage: () => undefined,
  }
}

function stubSurface(widthPx: number, heightPx: number): AtlasSurface {
  const context: AtlasContext = {
    lineWidth: 0,
    lineCap: 'round',
    lineJoin: 'round',
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

interface Driven {
  readonly game: ReturnType<typeof createGame>
  readonly drive: (count: number) => void
  readonly counts: { blits: number; cars: number; pins: number; clockTexts: number }
}

/**
 * Builds the real game, draws the road, and returns a driver.
 *
 * `now` lives in the returned closure's own frame rather than being captured
 * from the caller, for the same context-slot reason `loop.ts` keeps its
 * accumulator in a `Float64Array`: a captured mutable double boxes once per
 * frame and charges the harness's own noise to the profile it is taking.
 */
function drivenGame(): Driven {
  const counts = { blits: 0, cars: 0, pins: 0, clockTexts: 0 }
  const game = createGame({
    canvas: {
      width: 0,
      height: 0,
      style: { width: '', height: '' },
      getBoundingClientRect: () => ({ left: 11, top: 7 }),
    },
    context: silentContext(),
    createSurface: stubSurface,
    createFallback: () => null,
    measure: () => M0_VIEW,
    settle: (run) => {
      run()
    },
  })

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

  return { game, drive, counts }
}

describe('the real draw path allocates nothing, measured', () => {
  it('charges no packages/render/src file beyond its budget over 3,000 real frames', () => {
    const { drive } = drivenGame()
    drive(WARMUP_FRAMES)
    const byFile = profileBytesByFile(() => {
      drive(PROFILED_FRAMES)
    })

    // **The harness must fail loudly when it resolves nothing.** A measurement
    // instrument that reports "clean" while measuring zero files is worse than
    // no instrument, and that is exactly how the worktree path bug hid for two
    // tasks. Every profile of a real frame contains allocation from `render`'s
    // own module scope, so this is a liveness check on the path arithmetic.
    const resolved = [...byFile.keys()]
    expect(
      resolved.some((file) => file.startsWith(RENDER_SRC)),
      `nothing resolved under ${RENDER_SRC} — the path derivation is broken, not the code. ` +
        `sample: ${resolved.slice(0, 4).join(' | ')}`,
    ).toBe(true)

    const offenders = [...byFile]
      .filter(([file]) => file.startsWith(RENDER_SRC))
      .map(([file, bytes]) => [file, bytes / PROFILED_FRAMES] as const)
      .filter(([file, perFrame]) =>
        file.endsWith('/canvas.ts')
          ? perFrame > CANVAS_BUDGET_BYTES_PER_FRAME
          : perFrame > NOISE_FLOOR_BYTES_PER_FRAME,
      )
      .map(([file, perFrame]) => `${file} at ${perFrame.toFixed(2)} B/frame`)
      .sort()
    expect(offenders).toEqual([])
  })

  it('is not vacuous: the rig really did draw roads, cars, pins and a changing clock', () => {
    // A green harness is a claim about the inputs it was given. Without this,
    // the budget above is satisfied by a rig that draws an empty board — which
    // is precisely how `inputs.ts`'s 152 B/clear survived a whole task.
    const { game, drive } = drivenGame()
    drive(WARMUP_FRAMES + PROFILED_FRAMES)

    let roads = 0
    for (let c = 0; c < game.world.cells; c++) if ((game.state.roads[c] as number) !== 0) roads++
    expect(roads, 'no road, so drawRoads short-circuits on every cell').toBe(4)

    const frame = game.builder.frame
    expect(frame.carCount, 'no cars, so drawCars never iterates').toBe(6)
    expect(frame.destCount).toBe(3)
    expect(frame.houseCount).toBe(3)
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
