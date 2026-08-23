import { REVEALED_H, REVEALED_W, REVEALED_X0, REVEALED_Y0 } from '@laneways/shared'
import {
  createFieldInputRanges,
  createFlowFields,
  createScratch,
  createState,
  createWorld,
  isGameOver,
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
import { LAYOUT_IDS, layoutFor } from './layouts'
import { startParam } from './telegram'

/**
 * The city layout's three run constants live in `startingCity.ts` and are
 * re-exported here, unchanged, so every existing importer keeps working.
 *
 * They moved when the layout registry landed: `layouts.ts` binds them into the
 * `city` entry at module scope, and leaving them here would have made
 * `layouts.ts` import `main.ts` back. See the note above them in
 * `startingCity.ts` for why that cycle fails in production and passes in tests.
 */
export { RUN_SEED, SEED_FIRST_PIN_TICK, WARM_START_TICKS } from './startingCity'

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
 * 0  layoutFor(deps.layoutId)               which board — see `layouts.ts`
 * 1  world, state, scratch, fields          nothing can be seeded before state exists
 * 2  layout.seed                            BEFORE the shell: the frame builder sizes
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
 * **Per layout, not global** — `layout.warmStartTicks`, overridable by
 * `deps.warmStartTicks`. `WARM_START_TICKS` is the city's **258**: a fresh
 * board takes 378 ticks to show its first pin, so running 258 of them first
 * makes the player wait the sim's own designed 4 seconds instead of 12.6.
 * `DEMO_WARM_START_TICKS` is **1,200**, and its job is different in kind — the
 * demo board is the default, and a default that starts empty and fills up over
 * forty seconds is the frozen-city problem again for the first half of a
 * playtest. See each constant.
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
  /** Defaults to the layout's own `warmStartTicks`. 0 disables the warm start entirely. */
  readonly warmStartTicks?: number
  /**
   * Which board to open on — a key of `LAYOUTS` (`layouts.ts`).
   *
   * `undefined` (and `''`) mean `DEFAULT_LAYOUT_ID`, which is what every launch
   * that names nothing gets — **the starting city**, since M1e Task 5's spawner
   * ended the "a plain load never moves a car" clause that demoted it and Task
   * 10's gate measured that it did. `'demo'` opens the demo board. An id that
   * is not in the table THROWS; see `layoutFor`. `startGame` reads it from
   * `layoutToken(location.hash, location.search, startParam())`.
   */
  readonly layoutId?: string
  /**
   * Force the erase control's DOM fallback even where a `MainButton` exists.
   * `startGame` reads it from `?fallback=1`; see `EraseControlDeps.preferFallback`
   * for why the escape hatch is here at all.
   */
  readonly preferFallback?: boolean
  /**
   * Starts a new run after §5.8's shutdown. Defaults to
   * `() => { location.reload() }`, which IS the production path — so unlike
   * M2's `createFallback`, omitting this degrades to the correct behaviour
   * rather than to none, and optional is the honest shape.
   *
   * It exists as a dependency at all so the restart branch has a Node-side
   * detector: `location.reload()` is the same irreducible
   * one-DOM-call-with-no-detector shape `createFallbackButton` has, isolated to
   * one arrow function for that reason.
   *
   * **A test that boots a game, reaches game over and taps MUST pass this.**
   * There is no `location` in Node, so the default throws a `ReferenceError`
   * there — loudly, which is the right failure for a test that meant to
   * exercise the restart and forgot to inject one.
   */
  readonly restart?: () => void
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
  /** How many ticks ran before the first frame. See the layout's own constant. */
  readonly warmStartTicks: number
  /** The layout this game opened on — `DEFAULT_LAYOUT_ID` unless a link named another. */
  readonly layoutId: string
  /** One frame. `now` is `requestAnimationFrame`'s own timestamp — there is no second clock. */
  readonly frame: (now: number) => void
}

export function createGame(deps: GameDeps): Game {
  // The ONE line that decides which board this run opens on. With no token
  // `layoutFor` returns `DEFAULT_LAYOUT_ID`'s entry — the starting city, which
  // M1e's spawner grows and M1e Task 10's gate measures; `?layout=demo` still
  // opens the demo board. Nothing here reads a map, a seed or a warm start directly,
  // so no golden can move through this function whichever entry it gets. An
  // unknown token throws by name rather than falling back; `layouts.ts` says
  // why that matters more than it looks.
  const layout = layoutFor(deps.layoutId)
  const map = layout.map()
  const world = createWorld(map)
  const state = createState(deps.seed ?? layout.runSeed, map)
  const scratch = createScratch(
    world.cells,
    map.groupCount,
    map.maxDestinations,
    createFieldInputRanges(map),
  )
  const fields = createFlowFields(map.groupCount, world.cells)

  // Before anything else that reads state: `placeHouse`/`placeDestination` have
  // no other production caller and `step`'s seven phases contain no spawner, so
  // without this the build renders terrain and roads and nothing else. The
  // seeder throws by name on any rejected placement rather than shipping half a
  // city — both layouts, same rule.
  layout.seed(state, world)

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
  const warmStartTicks = deps.warmStartTicks ?? layout.warmStartTicks
  for (let t = 0; t < warmStartTicks; t++) step(state, world, fields, scratch, queue.inputs)

  // Before the first frame, always: an unwritten `Float32Array` is all-zero,
  // which is grid cell (0, 0), so without this call the whole city streaks in
  // from the board's top-left corner on frame 1.
  //
  // **Placed after the warm start, and that ordering is now a REQUIREMENT
  // rather than an equivalence. The demo layout is the change that ended it,
  // exactly as the paragraph below predicted.** On the shipped city the two
  // orderings are byte-identical to 9,000 warm-start ticks, because
  // `seedStartingCity` lays no roads, so no route exists, so no car ever leaves
  // `PHASE_IDLE` and the resolver returns each car's own house cell on every
  // tick of the ramp. **The demo layout seeds 70 road segments**, so its cars
  // are dispatched, routed and moving from tick 178 of a 1,200-tick ramp:
  // snapshotting before the ramp would lerp 24 cars across a thousand ticks of
  // motion on frame 1 — the streak this call exists to prevent, at the worst
  // possible scale. No code moves; the reason it may not move is now a live
  // one. `layouts.test.ts` and `demoLayout.test.ts` are the observers.
  //
  // **The general rule, which the demo layout is only the first instance of.**
  // The equivalence was a property of the STATE this function is handed, not of
  // the code: it holds exactly while every car is parked when the snapshot is
  // taken. **The second instance has now REACHED, and this comment predicted
  // it:** M1e Task 5's in-`step` spawner makes a car appear during the ramp with
  // no prev entry, measured at tick 360 on `firstCity` — well inside the
  // 258-tick warm start's successor runs and inside the demo's 1,200. One more
  // is still in flight: **M3's restore** hands `createGame` a state with cars
  // mid-route. **Keep the call last** — that is the rule, and it is now a
  // requirement on two counts rather than a prediction on one.
  initCarSnapshots(builder.snapshots, state, world)

  // **Annotated, and that is load-bearing rather than style.** `onGameOver`
  // closes over `loop`, so the initialiser references the binding it is
  // initialising; without the annotation TypeScript refuses to infer the type
  // through that cycle. The call itself is safe — `onGameOver` only ever runs
  // from inside `advance`, which cannot happen before `createLoop` returns.
  const loop: Loop = createLoop(
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
      // §5.8's shutdown reaching the shell. `sim` is the authority — `step` is
      // already a no-op past the failure — so this is a follower: it stops the
      // loop draining 30 ticks a second into a frozen buffer, and `end()` makes
      // that refusal sticky against the clock tap below, which forwards
      // straight to `loop.setPaused`.
      //
      // **`erase.retire()` is the second half, and it is here because the scrim
      // cannot reach it.** The shutdown screen is painted on the canvas; the
      // erase control is native `MainButton` chrome or a `position: fixed` DOM
      // pill, both outside anything `drawFrame` can dim. Left alone, a dead
      // board reading TAP TO PLAY AGAIN ships with a full-width bright button
      // under it offering ERASE ROADS.
      //
      // The forward reference is the same shape as `loop`'s own above and safe
      // for the same reason: this closure only ever runs from inside `advance`,
      // which cannot happen before `createGame` returns.
      onGameOver: () => {
        loop.end()
        erase.retire()
      },
      // §5.10's weekly offer stopping the board — M1f Task 7.
      //
      // **`setPaused`, not `end()`**: this pause is temporary and the player
      // is expected out of it. `end()` is sticky by design and would freeze
      // the run permanently at the first week boundary.
      //
      // **Fired on the CONDITION rather than the edge** (`frame.ts`'s
      // `onOfferRaised`), so this runs on every tick an offer is up.
      // `setPaused(true)` early-returns when it is already true, so the repeat
      // costs a comparison — and it buys the property that the HUD-clock tap
      // cannot leave a modal standing over a live board: a resume runs one
      // zero-tick frame (the clock reference resets), then one frame that
      // drains a tick, and that tick re-arms this.
      //
      // **Between this task and Task 8 that is a board with no way out**, at
      // 2:21 on the default layout — disclosed in the commit message and
      // interlocked by `test/offerInterlock.test.ts`, which Task 8 deletes.
      onOfferRaised: () => {
        loop.setPaused(true)
      },
    }),
    queue,
  )

  // **A game whose state is ALREADY terminal at boot must end its loop here,
  // because `onGameOver` fires on an EDGE and there is no edge to fire on.**
  //
  // `advance` reads `wasOver` before the step, deliberately — that is what stops
  // it re-announcing 30 times a second on a frozen buffer. The cost is that a
  // state which was terminal before the first `advance` never announces at all,
  // so **without this line the board is open and the player draws roads that
  // never appear, spends no tiles and gets no message.** That is exactly the
  // failure `end()`'s own doc comment exists to prevent, reached through a
  // different door.
  //
  // ---------------------------------------------------------------------------
  // **THIS LINE IS LOAD-BEARING, AND IT ARMS TWO GUARDS RATHER THAN ONE — M1e's
  // closing sweep measured it after a review argued the opposite.**
  // ---------------------------------------------------------------------------
  //
  // The old wording said `pointer.ts` refuses board input *"while paused and by
  // nothing else"*. That absolute is **false since M1e Task 9** — `down()`'s
  // FIRST statement is `if (host.gameOver()) { host.restart() }` — and a review
  // reasonably concluded from its falsity that the argument above had died with
  // it. **It has not, and the reason is the wiring:** `gameOver` is
  // `() => loop.over`, and `over` is set by `end()` and by nothing else. So
  // `end()` is the single switch that arms BOTH refusals, and removing it
  // disarms both at once.
  //
  // Measured, by deleting this line and booting a rig whose warm start already
  // killed it:
  //
  // ```
  //   with    loop.over=true   paused=true    down -> RESTART_REQUESTED (9)
  //                                           restarts 1   queued 0
  //   without loop.over=false  paused=false   down -> DRAG_START (2)
  //                                           move -> DRAW (3)
  //                                           restarts 0   QUEUED 2
  // ```
  //
  // Two road actions reached the sim on a dead board — the failure named above,
  // reproduced end to end. And the second consequence is worse than the first:
  // with the line gone the player has **no way out**, because Task 9's restart
  // is reached through the same `gameOver()` that this line is what makes true.
  //
  // **Unreachable from the two shipped layouts today** — their warm starts are
  // 1,200 and 258 ticks against deaths at 6,703 and 5,580, and `layouts.test.ts`
  // drives EVERY registered layout's own warm start and asserts it survives it,
  // rather than leaving the property to these two happening to be short. It
  // stops being unreachable the moment **M3's restore** hands `createGame` a
  // saved game-over state, which is a path M3 has to decide about anyway.
  //
  // One line, above the pointer, so the pointer is constructed against a loop
  // that already knows. Its detector is `integration.test.ts`'s *"a game whose
  // state is ALREADY over at boot ends its loop too"*, which boots a rig with a
  // 6,703-tick warm start.
  if (isGameOver(state)) loop.end()

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
    // The loop, not `sim`: `pointer.ts` is in `game` and must not grow a `sim`
    // import for one boolean, and `loop.over` is sticky and already the
    // authority `end()` writes.
    gameOver: () => loop.over,
    // **The way out of a terminal state, and the reason a reload is the right
    // one today.** A seamless in-place restart needs a `resetState` in `sim`
    // that M3 owns; a reload re-runs `createGame` from module scope, which is
    // the one path in this codebase known to produce a correct boot and is
    // byte-identical to a cold start by construction rather than by argument.
    restart: deps.restart ?? ((): void => {
      location.reload()
    }),
  })

  const erase = createEraseControl({
    host: pointer,
    createFallback: deps.createFallback,
    preferFallback: deps.preferFallback,
  })

  // The already-terminal-at-boot path's half of the same thing. `loop.end()`
  // ran above, before this control existed, and `onGameOver` fires on an EDGE
  // so it will never fire for this game — so the retire has to be reached from
  // the state rather than from the event. Same reasoning as the `loop.end()`
  // line itself, and unreachable from the two shipped layouts for the same
  // reason: it is M3's restore that makes it live.
  if (loop.over) erase.retire()

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
    layoutId: layout.id,
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
// The production factories — the only `document` references in `game`
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

/**
 * Creates the boot-failure surface **and attaches it to the document**, in
 * `createFallbackButton`'s idiom and for the same reason: the two DOM calls are
 * the part that cannot run under vitest, so they are the only part that lives
 * outside a structural interface.
 */
export function createBootFailureSurface(): HTMLElement {
  const panel = document.createElement('div')
  document.body.appendChild(panel)
  return panel
}

// ---------------------------------------------------------------------------
// The boot-failure surface — a phone has no console and no address bar
// ---------------------------------------------------------------------------

/**
 * **Why a DOM surface exists at all, rather than a thrown error and a log.**
 *
 * `layoutFor` throws by name on an unknown layout id, deliberately — a silent
 * fallback to the default board is indistinguishable from "the link did
 * nothing", which is the exact report the demo layout exists to answer, and
 * which now applies to `?startapp=cty` reaching the demo instead. That throw
 * propagates out of `createGame` -> `startGame` -> **this module's own
 * evaluation**, and the consequence is much larger than the game not starting:
 * nothing below the entry point runs, so there is no canvas sizing, no pointer
 * wiring, no erase control, no visibility handler and no error surface. A blank
 * page.
 *
 * **It is reachable by a link any third party can send.** `layoutToken` reads
 * `tgWebAppStartParam` out of `location.hash`, which is where Telegram writes
 * every launch parameter, so `https://<app>/#tgWebAppStartParam=x` is one line
 * of text that produces an unrecoverable black screen — and inside a Telegram
 * webview there is no console to read and no address bar to correct the URL
 * with.
 *
 * So the throw stays exactly as loud as it was and the CALL SITE catches it.
 * What the player gets is the failure written on the screen in words: what
 * broke, which token the link asked for, and which ids exist.
 */
export interface BootFailureElement {
  textContent: string | null
  setAttribute(name: string, value: string): void
}

/**
 * Creates the surface element and attaches it. `null` means "this environment
 * has no DOM", which is a real answer rather than an error — the same contract
 * as `FallbackElementFactory`.
 */
export type BootFailureElementFactory = () => BootFailureElement | null

/** The surface's element id, so a test and a human can both name it. */
export const BOOT_FAILURE_ELEMENT_ID = 'laneways-boot-error'

/**
 * The surface's inline style. Six properties are load-bearing and the rest is
 * padding:
 *
 *   - **`position:fixed;inset:0`** with a `z-index` at the maximum, because the
 *     canvas is already in the document and a message underneath it is a
 *     message nobody sees.
 *   - **`background` and `color` INVERT the page.** `index.html` paints the body
 *     `#d9d3c7` with `#2e2b28` text; this is the same two colours the other way
 *     round, so the panel cannot be mistaken for part of the board and the text
 *     cannot be mistaken for the background — 11.5:1 against WCAG's 4.5:1.
 *   - **16px**, which is the smallest size iOS does not offer to zoom, over a
 *     1.5 line height.
 *   - **`white-space:pre-wrap`**, because `bootFailureText` is four short
 *     paragraphs and without it they collapse into one unreadable run.
 *   - **`overflow:auto` plus `overflow-wrap:break-word`**, because the token
 *     came off a URL and can be 512 characters with no space in it. Without the
 *     wrap it pushes the panel sideways and the message off the screen.
 *   - **the safe-area insets**, since `index.html` ships `viewport-fit=cover`:
 *     without them the first line sits under the notch on the devices this
 *     failure is most likely to be seen on.
 */
export const BOOT_FAILURE_STYLE =
  'position:fixed;inset:0;z-index:2147483647;box-sizing:border-box;margin:0;' +
  'padding:calc(24px + env(safe-area-inset-top)) calc(20px + env(safe-area-inset-right)) ' +
  'calc(24px + env(safe-area-inset-bottom)) calc(20px + env(safe-area-inset-left));' +
  'overflow:auto;background:#2e2b28;color:#f6f2ea;' +
  'font:16px/1.5 -apple-system,system-ui,Roboto,sans-serif;' +
  'white-space:pre-wrap;overflow-wrap:break-word'

/**
 * What the surface says. A pure function of the failure and the token, so it
 * has a detector that does not need a DOM.
 *
 * **Three things, in the order a reader needs them**: that the app failed, what
 * the link asked for, and what it could have asked for instead. The thrown
 * message goes last because `layoutFor`'s is three sentences long and the two
 * facts above it are what a person can act on.
 *
 * `LAYOUT_IDS` is read from the registry rather than written out, for the reason
 * `layouts.ts` derives it there: an error message listing the layouts is exactly
 * the copy of the list nobody remembers to update.
 */
export function bootFailureText(error: unknown, token: string): string {
  // Not `(error as Error).message`: a `throw 'string'` is legal and reading
  // `.message` off it yields `undefined`, which would print the word undefined
  // where the reason belongs.
  const reason = error instanceof Error ? error.message : String(error)
  return (
    'Laneways could not start.\n\n' +
    `The link asked for the layout: ${token === '' ? '(none)' : token}\n` +
    `Layouts that exist: ${LAYOUT_IDS.join(', ')}\n\n` +
    'Open the app again with one of those ids after ?startapp=, or with no ' +
    '?startapp= at all for the default board.\n\n' +
    reason
  )
}

/**
 * Writes the failure onto the screen. Returns whether a surface was rendered —
 * `false` means the factory reported no DOM, which is the only way this can
 * decline.
 */
export function reportBootFailure(
  create: BootFailureElementFactory,
  error: unknown,
  token: string,
): boolean {
  const surface = create()
  if (surface === null) return false
  surface.setAttribute('id', BOOT_FAILURE_ELEMENT_ID)
  surface.setAttribute('style', BOOT_FAILURE_STYLE)
  // `textContent`, never `innerHTML`: the token comes off a URL a third party
  // can send, and it is being printed back onto the page.
  surface.textContent = bootFailureText(error, token)
  return true
}

/**
 * Starts the game, or puts the reason on the screen. Returns `null` where it
 * could not start.
 *
 * **The try/catch is a function rather than four lines at the call site, so
 * that it has a detector.** The call site is `if (shouldAutoStart())` at module
 * scope, which vitest's Node environment never reaches — the same reason
 * `wireGame` and `launchOptions` were extracted, both of which measured 0
 * detectors while they were inline.
 *
 * **The token is a thunk, not a string.** Reading it eagerly at the call site
 * would put a `location` read back outside the guard, and the whole point of
 * this function is that nothing on the boot path can throw past it.
 *
 * **It does not re-throw, and that is a decision.** Re-throwing would leave the
 * module's evaluation in exactly the failed state this exists to end, so any
 * line a later task adds below the guard would silently not run — and the
 * player has already been told, in words, on the screen. `console.error` keeps
 * the stack on the developer channel, which is the half the DOM surface cannot
 * carry.
 */
export function startOrReport(
  start: () => Game,
  create: BootFailureElementFactory,
  token: () => string,
): Game | null {
  try {
    return start()
  } catch (error) {
    console.error(error)
    try {
      reportBootFailure(create, error, token())
    } catch (secondary) {
      // The surface itself failed. Nothing is left but the log above, and
      // throwing from here would reinstate the blank page this file is about.
      console.error(secondary)
    }
    return null
  }
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
 * Telegram's launch parameters, parsed out of `location.hash`.
 *
 * **The fragment, never the query, and this is a fact about the SDK this build
 * loads rather than a preference.** `index.html` ships
 * `https://telegram.org/js/telegram-web-app.js`; that file reads
 * `location.hash` on its seventh line, hands it to `urlParseHashParams`, and
 * never mentions `location.search` anywhere. Every launch parameter —
 * `tgWebAppData`, `tgWebAppVersion`, `tgWebAppPlatform`, `tgWebAppStartParam`
 * — arrives there. The two are disjoint: Telegram only ever APPENDS a
 * fragment, so a query string baked into a Web App URL survives, and a
 * fragment parameter is invisible to `prefersFallback` above.
 *
 * The `_path`-before-`?` strip mirrors the SDK's own `urlParseHashParams`: a
 * fragment may be `#_path=%2F%3Fa%3Db&tgWebAppData=...` or plain
 * `#tgWebAppData=...`, so everything before the first `?` is dropped when there
 * is one.
 *
 * A parameter rather than a read of `location`, in the same idiom
 * `prefersFallback` already uses, so both branches have a detector.
 */
export function hashParams(hash: string): URLSearchParams {
  const body = hash.replace(/^#/, '')
  const query = body.indexOf('?')
  return new URLSearchParams(query >= 0 ? body.slice(query + 1) : body)
}

/**
 * Telegram's own `startapp` charset: `[A-Za-z0-9_-]`, at most 512 characters.
 *
 * A value outside it did not come from a Telegram link, so it is refused rather
 * than passed to a layout lookup — which keeps a hostile or corrupted fragment
 * from reaching `layoutFor`'s error path with arbitrary text in it, and keeps
 * the prototype-key question (`layouts.ts`) to one guard instead of two.
 */
const LAYOUT_TOKEN = /^[\w-]{1,512}$/

/**
 * Which layout this launch asked for, or `''` for "whatever the default is".
 *
 * **Three sources, one per reachable launch path, and all three are needed.**
 *
 * ```
 * tgWebAppStartParam (hash)   t.me/<bot>/<app>?startapp=demo — inside Telegram,
 *                             readable with no SDK at all, so it still works if
 *                             the SDK script failed to load (silent on iOS)
 * initDataUnsafe.start_param  the SAME value, SDK-parsed out of the signed
 *                             payload — the hedge for a client that signs it in
 *                             without mirroring it into the fragment
 * ?layout= (query)            the raw https URL in mobile Safari, and the only
 *                             one that works under `pnpm dev`
 * ```
 *
 * **A phone cannot type any of them, and that is the whole reason the first two
 * exist.** A Telegram webview has no address bar. `?fallback=1` — this
 * milestone's documented recovery hatch for "MainButton reported but never
 * rendered" — is therefore unreachable inside Telegram today unless somebody
 * edits the BotFather URL by hand. A `startapp` link is a message the player
 * sends themselves and taps, one line per layout, and **`?startapp=fallback`
 * now revives that hatch** — M1e Task 12, wired in `launchOptions` below, which
 * is also where the reason it costs two lines rather than one is written.
 *
 * **`''` means the default and an unknown-but-well-formed token means a
 * THROW**, and the difference is deliberate: a value outside the charset is
 * noise, but `demoo` is a person who meant something. `layoutFor` owns that
 * distinction; this function only decides whether a token was supplied at all.
 */
export function layoutToken(hash: string, search: string, fromInitData: string | null): string {
  const raw =
    hashParams(hash).get('tgWebAppStartParam') ??
    fromInitData ??
    new URLSearchParams(search).get('layout') ??
    ''
  return LAYOUT_TOKEN.test(raw) ? raw : ''
}

/**
 * The `startapp` value that means *"the DOM erase pill, not the MainButton"*.
 *
 * **This revives a hatch that was documented and unreachable.** `?fallback=1`
 * is this project's recovery path for *"a client reports a `MainButton` and
 * never renders one"*, and without it the player has no way to erase and no way
 * to say so. It is a QUERY parameter, and a Telegram webview has no address bar
 * — the SDK reads `location.hash` and never `location.search` — so on a phone
 * the hatch could only be reached by somebody editing the BotFather URL by
 * hand. `layoutToken` already reads `tgWebAppStartParam` out of the fragment,
 * which is a link the player can send themselves and tap
 * (`t.me/<bot>/<app>?startapp=fallback`), so the hatch costs the two lines in
 * `launchOptions` below.
 *
 * It deliberately shares the layout token's namespace rather than getting a
 * parameter of its own: Telegram gives a Mini App exactly one `startapp`
 * string, so `fallback` and a layout id cannot both be asked for in one link.
 * That is a real limitation and it is the right trade — the hatch exists for a
 * board that is already open and broken, and the board it opens is the default.
 *
 * **`layouts.ts` must never define a layout with this id.** `layoutToken`
 * returns it, `launchOptions` intercepts it before `layoutFor` sees it, and a
 * layout by that name would become unreachable with no error anywhere.
 * `integration.test.ts` asserts `LAYOUT_IDS` does not contain it.
 */
export const FALLBACK_TOKEN = 'fallback'

/** The two `location` members the launch options are derived from. */
export interface LaunchUrl {
  readonly hash: string
  readonly search: string
}

/** What a launch URL plus Telegram's `start_param` decide about a run. */
export interface LaunchOptions {
  readonly preferFallback: boolean
  readonly layoutId: string
}

/**
 * Everything `startGame` reads off the URL, in one function, **so that it has a
 * detector**.
 *
 * `startGame` touches `document` and `location` and therefore cannot run under
 * vitest's Node environment at all — which is exactly the shape `wireGame` was
 * extracted for, after deleting a call from `startGame` scored 0 detectors
 * across the whole suite. The same measurement was taken here: with the two
 * properties written inline, removing the `layoutId` line from `startGame`
 * scored **0 detectors**, so the one line wiring the entire layout mechanism to
 * production had nothing watching it.
 *
 * Both properties travel together on purpose. They read the same two strings,
 * they are both "what did the link ask for", and a future third — `?startapp=`
 * reviving the `fallback` hatch, which §1 of this file's research showed is
 * unreachable inside Telegram today — belongs here rather than as a fourth
 * argument at the call site.
 *
 * Takes the URL as a structural parameter rather than reading `location`, in
 * the idiom `prefersFallback` and `layoutToken` already use.
 */
export function launchOptions(url: LaunchUrl, startParamValue: string | null): LaunchOptions {
  const token = layoutToken(url.hash, url.search, startParamValue)
  return {
    preferFallback: prefersFallback(url.search) || token === FALLBACK_TOKEN,
    // **Not one line, two — and the second is what makes the hatch a hatch
    // rather than a boot failure.** `fallback` is not a layout id, so leaving
    // it in `layoutId` sends it to `layoutFor`, which throws by design ("the
    // layouts that exist are city, demo") and puts the boot-failure panel on
    // the screen. A recovery hatch that bricks the boot is worse than no hatch:
    // the player who reaches for it is already looking at a game they cannot
    // erase in, and they would end up looking at a stack trace instead.
    // `integration.test.ts` asserts BOTH halves, because a test that only
    // checked the flag would pass on exactly that build.
    layoutId: token === FALLBACK_TOKEN ? '' : token,
  }
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
    ...launchOptions(location, startParam()),
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

if (shouldAutoStart()) {
  startOrReport(startGame, createBootFailureSurface, () =>
    layoutToken(location.hash, location.search, startParam()),
  )
}

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
export type _RealElementIsABootFailureElement = Assert<
  HTMLElement extends BootFailureElement ? true : false
>
export type _RealPointerEventIsPointerEventLike = Assert<
  PointerEvent extends PointerEventLike ? true : false
>
