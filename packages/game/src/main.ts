import {
  FIRST_PIN_DELAY_TICKS,
  REVEALED_H,
  REVEALED_W,
  REVEALED_X0,
  REVEALED_Y0,
  firstCity,
} from '@laneways/shared'
import {
  createFieldInputRanges,
  createFlowFields,
  createScratch,
  createState,
  createWorld,
  step,
  type FlowField,
  type GameState,
  type Scratch,
  type WorldData,
} from '@laneways/sim'
import {
  PALETTE,
  buildAtlases,
  drawFrame,
  type Atlases,
  type AtlasSurface,
  type AtlasSurfaceFactory,
  type DrawContext,
  type ViewportMetrics,
} from '@laneways/render'
import { createFrameBuilder, createFrameDriver, type FrameBuilder } from './frame'
import { initCarSnapshots } from './resolve'
import { createInputQueue, type InputQueue } from './inputs'
import { createLoop, type Loop } from './loop'
import { PointerOutcome, createPointerInput, type PointerInput } from './pointer'
import {
  bootShell,
  measureViewport,
  rafSettle,
  type ScalableContext,
  type Shell,
  type SizableCanvas,
} from './shell'
import { createEraseControl, type EraseControl, type FallbackElementFactory } from './eraseControl'
import { seedStartingCity } from './startingCity'

/**
 * The wiring — plan Task 9. Everything the previous eight tasks built, assembled
 * into a thing you can open on a phone.
 *
 * ---------------------------------------------------------------------------
 * THE ASSEMBLY IS A FUNCTION AND THE ENTRY POINT IS FOUR LINES
 * ---------------------------------------------------------------------------
 *
 * `createGame(deps)` touches no global: the canvas, the 2D context, the atlas
 * surface factory, the erase-control fallback factory, the viewport measurement
 * and the settle scheduler are all injected, in plan Decision 8's idiom. That is
 * what lets `test/integration.test.ts` drive **the real loop** headlessly —
 * injected clock in, synthetic pointer events in, a recording context out — over
 * the same code path a phone runs, rather than over a rig that resembles it.
 *
 * `startGame()` is the part that cannot be tested in Node: it reads
 * `document`, builds the three production factories, wires the DOM events and
 * starts `requestAnimationFrame`. Everything inside it that CAN be extracted
 * has been — `attachPointerEvents` and `attachVisibility` both take a
 * structural target, so the event names and the capture calls have a detector.
 *
 * ---------------------------------------------------------------------------
 * THE BOOT ORDER, AND WHY IT IS THIS ORDER
 * ---------------------------------------------------------------------------
 *
 * ```
 * 1  world, state, scratch, fields          nothing can be seeded before state exists
 * 2  seedStartingCity                       BEFORE the shell: the frame builder sizes
 *                                           its arrays off state, and M2 has no spawner
 * 3  bootShell                              calls boot() ITSELF — see the note below —
 *                                           then measures, sizes, and builds the atlas
 * 4  createFrameBuilder                     needs a camera, which step 3 produced
 * 5  the warm start                         WARM_START_TICKS steps, see below
 * 6  initCarSnapshots                       LAST, so frame 1 lerps from the launch
 *                                           state and not from cell (0, 0). Equivalent
 *                                           to running it earlier today, and not under
 *                                           M3's restore — see the call site
 * 7  queue, loop, pointer, erase control
 * ```
 *
 * **`bootShell` calls `boot()` itself.** Calling `boot()` again from here
 * re-runs `ready`/`expand`/`requestFullscreen`, which is why this file never
 * imports it. Task 8's handoff names it first of the three things not to get
 * wrong; the other two are `rebuildAtlas` reassigning the atlases the draw path
 * actually reads (it does — `atlases` is a `let` and `draw` closes over it), and
 * the pointer reading the shell's **cached** canvas offset rather than calling
 * `getBoundingClientRect` per event (it does — `shell.canvasLeft`).
 *
 * ---------------------------------------------------------------------------
 * THE WARM START: WHAT IT IS FOR, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * See `WARM_START_TICKS`. In one line: a fresh board takes 378 ticks to show its
 * first pin, and this runs 258 of them before the first frame so the player
 * waits the sim's own designed 4 seconds instead of 12.6.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE RUNS PER FRAME EXCEPT `Game.frame`
 * ---------------------------------------------------------------------------
 *
 * `frame(now)` is `loop.frame(now)` and nothing else, and every closure it
 * reaches was built once at boot. `test/allocation.test.ts` has profiled that
 * assembly since Task 6; what Task 9 adds is the **real draw path** — until this
 * file existed the harness passed a no-op `draw`, so `render/src/canvas.ts`'s
 * own "review is the only check of this file specifically" was literally true.
 * The integration test's allocation case closes it.
 */

/**
 * The tick on which Task 2's seeded city produces its first pin, **measured**.
 *
 * The one literal the warm start rests on, and `test/integration.test.ts`
 * re-measures it by stepping the real seeded city until a pin appears — so a
 * change to the city, to `PIN_PERIOD_TICKS` or to `FIRST_PIN_DELAY_TICKS` fails
 * loudly here instead of silently making `WARM_START_TICKS` the wrong number.
 * `packages/game/test/startingCity.test.ts` holds the same 378 as its own
 * hand-derived `FIRST_PIN_TICK`.
 *
 * How many ticks to run before the first frame is drawn.
 *
 * **Derived, not tuned.** Task 2's hand-authored city produces its first pin at
 * tick **378**, which is 12.6 s at 30 Hz — so a fresh launch shows a live board
 * with no pin, no dispatch and no moving car for twelve seconds. That is
 * spec-correct pacing and Task 2 was right not to change it, but it is a bad
 * instrument for a first playtest and an unexplained dead board gets diagnosed
 * as a rendering bug.
 *
 * 378 decomposes exactly, and only one of the two parts is a design decision:
 *
 * ```
 * 378 = FIRST_PIN_DELAY_TICKS (120)          a destination waits 4 s for its first
 *                                            customer — spec-correct, and KEPT
 *     + ceil(PIN_PERIOD_TICKS / slotCount)   the colour accumulator climbing 518 at
 *       - 1  =  ceil(518 / 2) - 1 = 258      2 slots a tick (two square colour-0
 *                                            destinations) from an EMPTY start
 * ```
 *
 * The second term is not pacing, it is the cost of the accumulator starting at
 * zero on a board that is handed three destinations at once. Running those 258
 * ticks before the first frame removes exactly that term and keeps exactly the
 * designed delay: **the first pin then lands 120 ticks — 4.00 s — after launch.**
 *
 * **It moves no golden**, and that is why it is the lever this task took. The
 * plan's own suggestion — make destination 0 a circle, `slotCount` 3, first pin
 * at tick 292 — was measured and **rejected**: it changes `destMeta[0]`, so
 * `hashState` after seeding moves from the seeded-state golden to a different
 * number, and the task's constraints say to stop and report rather than
 * re-bless. It is also the weaker lever: 292 ticks is still **9.7 s** of dead
 * board, against 4.0 s here.
 *
 * The two figures, restated at M1d Task 5 because the state buffer grew from
 * 11,908 to 13,828 bytes there (`ghostMask` + `ghostCommitted`) and both moved
 * for layout: the seeded golden is **`1178110182`** (was `3576722662` at M1d
 * Task 2, `2505371110` at M2) and the rejected circle variant is
 * **`996383454`** (was `947517150`, `4171132894`). Nothing greps this comment,
 * so it is re-derived rather than trusted whenever the buffer changes shape —
 * both numbers were re-measured here, and splicing the inserted bytes back out
 * reproduced the two Task 2 values (`3576722662` and `947517150`) exactly,
 * which is what confirms the pair still describes the same two states. That the
 * REJECTED figure reproduces as well as the accepted one is a second,
 * independent check on the splice method itself. **M1d changes the buffer shape
 * twice and no more; this is the second, so these two numbers are final for the
 * milestone.**
 *
 * **What it costs, measured:** 258 `step` calls at boot, 6.8 ms on the
 * development machine, once. Nothing visible changes across those ticks — no
 * pin, no car moves, no road, no score, and `weekOfTick(258)`/`dayOfWeek(258)`
 * are still 0/0, so the HUD reads exactly as it does at tick 0. The only state
 * that moves is `pinAccum`, which is what the wait was for. `test/integration.test.ts`
 * re-derives 258 from `FIRST_PIN_DELAY_TICKS` and a live measurement of the
 * seed's first-pin tick, so if either the city or the constants move, this
 * number fails rather than silently becoming wrong.
 *
 * **What it is not:** a substitute for M1e's authored spawn schedule. A run that
 * begins at tick 258 is still the out-of-band, non-replayable seed
 * `startingCity.ts` documents; M2 submits nothing to a leaderboard either way.
 */
/**
 * The build id `vite.config.ts` mints, or `'dev'` where there is no bundler.
 *
 * **This is what the deploy check greps the live bundle for**, and it is only
 * ever reachable through `define`: `typeof` on an undeclared identifier is safe
 * in JS, so this is `'dev'` under vitest and under `pnpm dev`, and the real id
 * in a `vite build`. It is published on `globalThis` two lines down for two
 * reasons — the assignment is a side effect, so the constant cannot be
 * tree-shaken out of the bundle the check is about to grep, and "which build is
 * this phone running" is the first question a playtest raises.
 */
declare const __LANEWAYS_BUILD_ID__: string
export const BUILD_ID: string =
  typeof __LANEWAYS_BUILD_ID__ === 'string' ? __LANEWAYS_BUILD_ID__ : 'dev'
;(globalThis as Record<string, unknown>).lanewaysBuild = BUILD_ID

export const SEED_FIRST_PIN_TICK = 378

/** See `SEED_FIRST_PIN_TICK`. 378 - 120 = 258. */
export const WARM_START_TICKS = SEED_FIRST_PIN_TICK - FIRST_PIN_DELAY_TICKS

/**
 * The RNG seed every M2 run uses.
 *
 * Fixed rather than random, deliberately: M2 submits nothing to a leaderboard
 * (`startingCity.ts` explains why), and a playtest build where every launch is
 * the same board is a better instrument than one where it is not. M3's
 * persistence is what gives a run its own seed.
 */
export const RUN_SEED = 'laneways-m2'

/** The canvas members this file needs: the shell's, plus a pointer-event target. */
export type GameCanvas = SizableCanvas

/** The context members this file needs: the shell's DPR scale, plus the draw path's. */
export type GameContext = ScalableContext & DrawContext

export interface GameDeps {
  readonly canvas: GameCanvas
  readonly context: GameContext
  /** Makes the atlas's offscreen surface. Production: `createCanvasSurface`. */
  readonly createSurface: AtlasSurfaceFactory
  /**
   * Makes the erase control's DOM fallback. Production: `createFallbackButton`.
   *
   * **Required, and Task 8 made it so on purpose**: an optional factory meant
   * `createEraseControl({ host })` compiled, reported `NONE`, and shipped a build
   * where the player can draw roads and never remove one — this milestone's
   * Critical, reopened by one omitted property in this very file.
   */
  readonly createFallback: FallbackElementFactory
  /** Production: `measureViewport`. */
  readonly measure: () => ViewportMetrics
  /** Production: `rafSettle`. */
  readonly settle: (run: () => void) => void
  readonly seed?: string
  /** Defaults to `WARM_START_TICKS`. 0 disables the warm start entirely. */
  readonly warmStartTicks?: number
  /**
   * Force the erase control's DOM fallback even where a `MainButton` exists.
   * `startGame` reads it from `?fallback=1`; see `EraseControlDeps.preferFallback`
   * for why the escape hatch is here at all.
   */
  readonly preferFallback?: boolean
}

/**
 * The assembled game. Every field is the live object, exposed so the integration
 * test can drive and observe the real thing rather than a copy of it.
 */
export interface Game {
  readonly state: GameState
  readonly world: WorldData
  readonly fields: readonly FlowField[]
  readonly scratch: Scratch
  readonly builder: FrameBuilder
  readonly shell: Shell
  readonly loop: Loop
  readonly pointer: PointerInput
  readonly queue: InputQueue
  readonly erase: EraseControl
  /**
   * The CURRENT pair of atlases — live roads and M1d Task 8's ghost layer. A
   * getter, because the shell rebuilds them on a tile-size change.
   *
   * A pair rather than two fields: both are baked at a fixed tile size and with
   * a baked palette, so refreshing one without the other is the failure
   * `render`'s `Atlases` and `assertAtlases` exist for.
   */
  readonly atlases: Atlases
  /** How many ticks ran before the first frame. See `WARM_START_TICKS`. */
  readonly warmStartTicks: number
  /** One frame. `now` is `requestAnimationFrame`'s own timestamp — there is no second clock. */
  readonly frame: (now: number) => void
}

export function createGame(deps: GameDeps): Game {
  const map = firstCity()
  const world = createWorld(map)
  const state = createState(deps.seed ?? RUN_SEED, map)
  const scratch = createScratch(
    world.cells,
    map.groupCount,
    map.maxDestinations,
    createFieldInputRanges(map),
  )
  const fields = createFlowFields(map.groupCount, world.cells)

  // Before anything else that reads state: `placeHouse`/`placeDestination` have
  // no other production caller and `step`'s seven phases contain no spawner, so
  // without this the build renders terrain and roads and nothing else.
  seedStartingCity(state, world)

  // `let`, and read through the `draw` closure below rather than captured by
  // value: the shell calls `rebuildAtlas` at boot AND on every device-tile
  // change, and a draw path holding the boot atlases would blit source rects of
  // the wrong size for the rest of the session.
  let atlases: Atlases | null = null

  const shell = bootShell({
    canvas: deps.canvas,
    context: deps.context,
    reveal: { x0: REVEALED_X0, y0: REVEALED_Y0, cols: REVEALED_W, rows: REVEALED_H },
    measure: deps.measure,
    settle: deps.settle,
    // BOTH layers, in one call, through the one constructor that cannot return
    // a mismatched pair. Rebuilding the road atlas alone here would leave the
    // ghost layer rasterised for the previous tile size for the rest of the
    // session, which `assertAtlases` turns from a soft resample into a throw.
    rebuildAtlas: (tileDevicePx: number): void => {
      atlases = buildAtlases(deps.createSurface, tileDevicePx, PALETTE)
    },
  })

  // `bootShell` calls `rebuildAtlas` unconditionally on its first fit, so this
  // is unreachable — and it is a named throw rather than a `!` because the
  // alternative failure is `drawFrame` reading `null.tileDevicePx` sixty times a
  // second with nothing saying why.
  if (atlases === null) {
    throw new Error(
      'createGame: bootShell returned without building an atlas — the draw path has no ' +
        'source surface, so every road would be missing. rebuildAtlas must be called at boot.',
    )
  }

  const builder = createFrameBuilder(state, world, shell.camera)
  const queue = createInputQueue()

  // The warm start (see `WARM_START_TICKS`), through `sim`'s own `step` with an
  // empty batch — byte-identical to the player having had the app open for 8.6
  // seconds longer, which is exactly what it is standing in for.
  const warmStartTicks = deps.warmStartTicks ?? WARM_START_TICKS
  for (let t = 0; t < warmStartTicks; t++) step(state, world, fields, scratch, queue.inputs)

  // Before the first frame, always: an unwritten `Float32Array` is all-zero,
  // which is grid cell (0, 0), so without this call the whole city streaks in
  // from the board's top-left corner on frame 1.
  //
  // **Placed after the warm start, and TODAY that ordering is an equivalence
  // rather than a requirement — the reason matters more than the fact.** Moving
  // this call above the warm-start loop survives every test, and the honest
  // reason is not "the snapshots are refreshed each frame" (they are, but only
  // for slots the driver resolves) — it is that **no car moves during the warm
  // start at all**. `seedStartingCity` lays no roads, so no route exists, so
  // `runDispatch` never leaves any car in `PHASE_IDLE`; the resolver returns
  // each car's own house cell on every tick of the ramp. Measured to 9,000
  // warm-start ticks: the two orderings produce byte-identical snapshots.
  //
  // **What makes it stop being equivalent, so nobody reorders it on the strength
  // of that survival.** The equivalence is a property of the STATE this function
  // is handed, not of the code: it holds exactly while every car is parked when
  // the snapshot is taken. Two things in flight break it. **M3's restore** hands
  // `createGame` a state with cars mid-route, and a snapshot taken before the
  // ramp would then lerp every one of them across up to 258 ticks of motion on
  // frame 1 — the streak this call exists to prevent, reintroduced at a
  // different scale. **M1e's in-`step` spawner** breaks it the same way, by
  // making a car appear during the ramp with no prev entry. Keep the call last.
  initCarSnapshots(builder.snapshots, state, world)

  const loop = createLoop(
    createFrameDriver({
      state,
      world,
      fields,
      scratch,
      builder,
      // A function, so a stable `viewportChanged` re-fit is picked up without
      // the driver being rebuilt.
      camera: () => shell.camera,
      draw: (frame) => {
        drawFrame(deps.context, frame, atlases as Atlases, PALETTE)
      },
    }),
    queue,
  )

  const pointer = createPointerInput({
    camera: () => shell.camera,
    // The shell's CACHED offset. `getBoundingClientRect()` allocates a `DOMRect`
    // per call, and this is read on every pointer event.
    canvasLeft: () => shell.canvasLeft,
    canvasTop: () => shell.canvasTop,
    gridW: world.w,
    queue,
    // The loop owns `paused`, because resuming has to reset its clock reference
    // (Decision 1b) and a second copy here would let the two disagree.
    paused: () => loop.paused,
    setPaused: (next: boolean) => {
      loop.setPaused(next)
    },
  })

  const erase = createEraseControl({
    host: pointer,
    createFallback: deps.createFallback,
    preferFallback: deps.preferFallback,
  })

  return {
    state,
    world,
    fields,
    scratch,
    builder,
    shell,
    loop,
    pointer,
    queue,
    erase,
    warmStartTicks,
    get atlases(): Atlases {
      return atlases as Atlases
    },
    frame: loop.frame,
  }
}

// ---------------------------------------------------------------------------
// The DOM edge, extracted so it has a detector
// ---------------------------------------------------------------------------

/** The three fields the pointer machine reads off a `PointerEvent`. */
export interface PointerEventLike {
  readonly pointerId: number
  readonly clientX: number
  readonly clientY: number
}

/**
 * The slice of `HTMLCanvasElement` the event wiring uses. Structural, so
 * `test/integration.test.ts` can drive every branch with a stub — a real canvas
 * satisfies it, pinned at the bottom of this file.
 */
export interface PointerEventTarget {
  addEventListener(type: string, handler: (event: PointerEventLike) => void): void
  setPointerCapture(pointerId: number): void
  releasePointerCapture(pointerId: number): void
}

/**
 * Wires the five pointer events to the state machine, and pointer capture to the
 * two outcomes that ask for it.
 *
 * **Capture is why `pointermove` keeps arriving once a finger leaves the
 * canvas**, which on a drag-to-draw surface is most of a stroke's second half.
 * `DRAG_START` and `DRAG_END` are the only two `PointerOutcome` codes production
 * consumes, and that is the whole reason the enum has them.
 *
 * **`lostpointercapture` is wired to `cancel`, not to `up`**, and the
 * `releasePointerCapture` call is guarded. The browser fires
 * `lostpointercapture` *after* it has already dropped the capture, so releasing
 * again throws `InvalidPointerId` on a conforming implementation — an exception
 * out of an event handler, on the happy path, once per stroke. `try`/`catch` is
 * the honest shape here: `hasPointerCapture` is not on every target this
 * interface accepts, and the failure being swallowed is precisely "it was
 * already released".
 */
export function attachPointerEvents(target: PointerEventTarget, pointer: PointerInput): void {
  const release = (pointerId: number): void => {
    try {
      target.releasePointerCapture(pointerId)
    } catch {
      // Already released — `lostpointercapture` is exactly this case.
    }
  }

  target.addEventListener('pointerdown', (event) => {
    if (pointer.down(event.pointerId, event.clientX, event.clientY) === PointerOutcome.DRAG_START) {
      target.setPointerCapture(event.pointerId)
    }
  })
  target.addEventListener('pointermove', (event) => {
    pointer.move(event.pointerId, event.clientX, event.clientY)
  })
  target.addEventListener('pointerup', (event) => {
    if (pointer.up(event.pointerId) === PointerOutcome.DRAG_END) release(event.pointerId)
  })
  target.addEventListener('pointercancel', (event) => {
    if (pointer.cancel(event.pointerId) === PointerOutcome.DRAG_END) release(event.pointerId)
  })
  target.addEventListener('lostpointercapture', (event) => {
    pointer.cancel(event.pointerId)
  })
}

/**
 * The slice of `window` the viewport wiring uses.
 *
 * Two event names rather than one, and which of them is wired depends on
 * `shell.subscribed` — see `attachViewport`.
 */
export interface ViewportEventTarget {
  addEventListener(type: 'orientationchange' | 'resize', handler: () => void): void
}

/**
 * Routes the viewport sources `bootShell` cannot subscribe to itself at
 * `shell.viewportChanged`.
 *
 * **`Shell.subscribed` was a diagnostic no caller read, and that made a real gap
 * invisible.** `bootShell` subscribes to Telegram's `viewportChanged` and returns
 * whether the subscription was actually installed; nothing ever looked. On a
 * client with no `Telegram` object — `pnpm dev` in a browser, and any client
 * where the SDK script failed to load, which spec §8.5 says fails silently on
 * iOS — that subscription does not exist, so **the canvas never resizes for the
 * life of the session**: rotate the device and the board keeps the old camera
 * while every pointer event is transformed through it. Reading the flag is what
 * turns that from a silent degradation into a wired fallback.
 *
 * **`orientationchange` is wired unconditionally**, because plan Decision 5 lists
 * it alongside boot, the fullscreen settle and stable `viewportChanged` as a
 * measurement trigger, and because a rotation is the one viewport change that
 * always moves the tile size. **`resize` is wired only when the Telegram
 * subscription is absent**, and that condition is the whole of spec §8.3's
 * compliance: on a real client `resize` fires continuously through a keyboard
 * animation and would re-measure against the transient height, which is exactly
 * what §8.3 forbids and what `stableHeight()` exists to avoid. Where there is no
 * Telegram there is no transient height and no stable event to prefer.
 *
 * Both go through `settle` rather than measuring inline: `orientationchange`
 * fires before the new viewport metrics are published on every browser this
 * targets. An early read is self-correcting — a measurement that agrees costs
 * nothing (`SizingOutcome.UNCHANGED` does not touch the canvas) and a later
 * event fixes it if it does not — but paying three animation frames is cheaper
 * than a guaranteed-wrong camera.
 *
 * Returns the event names it wired, so a test asserts a list rather than a
 * property and dropping one is visible.
 */
export function attachViewport(
  target: ViewportEventTarget,
  shell: Pick<Shell, 'viewportChanged' | 'subscribed'>,
  settle: (run: () => void) => void,
): string[] {
  const wired: string[] = ['orientationchange']
  target.addEventListener('orientationchange', () => {
    settle(() => {
      shell.viewportChanged(true)
    })
  })
  if (!shell.subscribed) {
    wired.push('resize')
    target.addEventListener('resize', () => {
      settle(() => {
        shell.viewportChanged(true)
      })
    })
  }
  return wired
}

/** The slice of `document` the visibility wiring uses. */
export interface VisibilityTarget {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', handler: () => void): void
}

/**
 * Ends any drag in progress when the webview is backgrounded.
 *
 * A hidden webview may never deliver the `pointerup`, and a drag with no end
 * event latches: the single-pointer rule then refuses every subsequent
 * `pointerdown`, including the owner's, and input is dead for the rest of the
 * session. `pointer.abort()` is the out-of-band recovery path Task 7 added for
 * exactly this, and this is its production caller.
 */
export function attachVisibility(target: VisibilityTarget, pointer: PointerInput): void {
  target.addEventListener('visibilitychange', () => {
    if (target.visibilityState === 'hidden') pointer.abort()
  })
}

// ---------------------------------------------------------------------------
// The production factories — the only three `document` references in `game`
// ---------------------------------------------------------------------------

/** `buildAtlases`'s surface factory. Three lines, and `atlas.ts` prescribes them. */
export function createCanvasSurface(widthPx: number, heightPx: number): AtlasSurface {
  const surface = document.createElement('canvas')
  surface.width = widthPx
  surface.height = heightPx
  return surface
}

/**
 * The erase control's DOM fallback: development outside Telegram, and clients
 * below the `MainButton` gate. `eraseControl.ts` owns the styling and the
 * placement derivation; this only has to exist and be attached.
 */
export function createFallbackButton(): HTMLButtonElement {
  const button = document.createElement('button')
  document.body.appendChild(button)
  return button
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/** The canvas `index.html` ships. Task 8's shell test pins that the two agree. */
export const CANVAS_ELEMENT_ID = 'board'

/**
 * Whether the player asked for the DOM erase button instead of the native one.
 *
 * **The recovery path for Task 8's F5, and a URL rather than a redeploy.**
 * `mainButton()` is the one Telegram surface in this build that has never run on
 * a phone, it is what closes this milestone's Critical, and if a client reports
 * one and then does not render it there is otherwise no way back — the fallback
 * is never created and `EraseControl` exposes no rebind. Opening the Mini App
 * with `?fallback=1` binds the DOM pill instead.
 *
 * A parameter rather than a read of `location`, so both branches have a
 * detector; `startGame` passes `location.search`.
 */
export function prefersFallback(search: string): boolean {
  return new URLSearchParams(search).get('fallback') === '1'
}

/**
 * Whether this module should start the game on import.
 *
 * A predicate rather than an inline `typeof document !== 'undefined'`, so the
 * guard has a detector: under vitest's default Node environment `document` is
 * undefined and importing this file must be inert, and a future switch to a DOM
 * environment must not silently boot a game inside every test file. Both
 * directions are asserted in `test/integration.test.ts`.
 */
export function shouldAutoStart(scope: { document?: unknown } = globalThis): boolean {
  return typeof scope.document !== 'undefined'
}

/**
 * Reads the DOM, builds the production dependencies, and starts the frame loop.
 *
 * Both lookups throw rather than degrade. A missing canvas or a refused 2D
 * context is a build or a platform failure that no amount of continuing makes
 * better — and on iOS a refused context is how the platform reports having run
 * out of canvas memory (spec §8.5), which is the failure mode that is otherwise
 * completely silent.
 */
export function startGame(): Game {
  const canvas = document.getElementById(CANVAS_ELEMENT_ID)
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error(
      `startGame: no <canvas id="${CANVAS_ELEMENT_ID}"> in the document — index.html and ` +
        'CANVAS_ELEMENT_ID have diverged, and the board would never appear',
    )
  }
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error(
      'startGame: the canvas returned no 2D context — on iOS this is how the platform reports ' +
        'having run out of canvas memory, and nothing would ever be drawn',
    )
  }

  const game = createGame({
    canvas,
    context,
    createSurface: createCanvasSurface,
    createFallback: createFallbackButton,
    measure: measureViewport,
    settle: rafSettle,
    preferFallback: prefersFallback(location.search),
  })

  wireGame(game, canvas, document, requestAnimationFrame, window, rafSettle)
  return game
}

/**
 * Wires a built game to its three event sources and starts the frame loop.
 *
 * **Extracted from `startGame` so that it has a detector.** `startGame` reads
 * `document` and cannot run under vitest's Node environment at all, so every
 * call it made was untestable by construction — deleting the `attachVisibility`
 * line from it scored **0 detectors** across the whole 1,236-test suite, which
 * is the catalogue's "a driver that never enters a branch makes that branch
 * indistinguishable from dead code" applied to the production entry point.
 * Every parameter here is structural, so `test/integration.test.ts` drives all
 * three with stubs.
 *
 * What is left in `startGame` and still has no Node-side detector is the two DOM
 * lookups and their two throws, which is genuinely irreducible: there is no
 * `document` to look anything up in.
 */
export function wireGame(
  game: Game,
  canvas: PointerEventTarget,
  doc: VisibilityTarget,
  raf: (callback: (now: number) => void) => unknown,
  viewport: ViewportEventTarget,
  settle: (run: () => void) => void,
): void {
  attachPointerEvents(canvas, game.pointer)
  attachVisibility(doc, game.pointer)
  attachViewport(viewport, game.shell, settle)

  // `requestAnimationFrame`'s own timestamp is the loop's clock — plan Decision
  // 1: there is no second clock anywhere, so `performance.now()` never appears.
  const onFrame = (now: number): void => {
    game.frame(now)
    raf(onFrame)
  }
  raf(onFrame)
}

if (shouldAutoStart()) startGame()

/**
 * Compile-time pins for the three DOM-touching wirings above, in the idiom
 * `atlas.ts`, `shell.ts` and `eraseControl.ts` already use: a real canvas is a
 * `GameCanvas` and a `PointerEventTarget`, a real 2D context is a `GameContext`,
 * and a real `Document` is a `VisibilityTarget`.
 *
 * The `Assert<T extends true>` wrapper is load-bearing — `type X = A extends B ?
 * true : never` pins nothing, because `never` is a perfectly good type.
 */
type Assert<T extends true> = T
export type _RealCanvasIsAGameCanvas = Assert<HTMLCanvasElement extends GameCanvas ? true : false>
export type _RealCanvasIsAPointerTarget = Assert<
  HTMLCanvasElement extends PointerEventTarget ? true : false
>
export type _RealContextIsAGameContext = Assert<
  CanvasRenderingContext2D extends GameContext ? true : false
>
export type _RealDocumentIsAVisibilityTarget = Assert<Document extends VisibilityTarget ? true : false>
export type _RealPointerEventIsPointerEventLike = Assert<
  PointerEvent extends PointerEventLike ? true : false
>
