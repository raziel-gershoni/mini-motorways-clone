import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CARS_PER_HOUSE,
  COST_UNIT_SCALE,
  DIAG_COST,
  FIRST_PIN_DELAY_TICKS,
  OVERCROWD_FAIL_MILLITICKS,
  PIN_PERIOD_TICKS,
} from '@laneways/shared'
import {
  H_DEST_COUNT,
  H_HOUSE_COUNT,
  H_SCORE,
  H_TICK,
  H_TILES,
  LANE_OF_DIR,
  PHASE_IDLE,
  PHASE_NONE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  EnterOutcome,
  canEnter,
  claimCell,
  isGameOver,
  occupantOf,
  packRouteStep,
  assertOccupancySound,
  hashState,
  roadMask,
} from '@laneways/sim'
import { MAX_BLOCKED_TICKS } from '@laneways/shared'
import { PALETTE, type AtlasContext, type AtlasSurface } from '@laneways/render'
import {
  buildJamRig,
  jamGhostCells,
  jamQueueLength,
  JAM_CARPARK_CAPACITY_TRIPS,
  JAM_FIRST_HOUSE_Y,
  JAM_STARVED_FIRST_HOUSE_Y,
  JAM_STARVED_HOUSE_COUNT,
  JAM_TICKS,
  JAM_UNBLOCKED_TRIPS,
} from './jamFixture'
import { TICK_MS } from '../src/loop'
import { MAX_DRAW_LAG_CELLS, MAX_SIM_CELLS_PER_TICK } from '../src/resolve'
import { PointerOutcome } from '../src/pointer'
import { EraseControlSurface } from '../src/eraseControl'
import { SizingOutcome } from '../src/shell'
import { DEMO_WARM_START_TICKS } from '../src/demoLayout'
import { CITY_LAYOUT_ID, DEFAULT_LAYOUT_ID, LAYOUT_IDS } from '../src/layouts'
import { DEMO_DEATH_TICK } from './deathTicks'
import {
  BOOT_FAILURE_ELEMENT_ID,
  BOOT_FAILURE_STYLE,
  CANVAS_ELEMENT_ID,
  RUN_SEED,
  SEED_FIRST_PIN_TICK,
  WARM_START_TICKS,
  attachPointerEvents,
  attachVisibility,
  attachViewport,
  bootFailureText,
  reportBootFailure,
  startOrReport,
  wireGame,
  createGame,
  prefersFallback,
  shouldAutoStart,
  type BootFailureElement,
  type Game,
  type PointerEventLike,
  type PointerEventTarget,
} from '../src/main'

/**
 * The end-to-end test — plan Task 9.
 *
 * **It drives the real loop.** `createGame` is the same function `startGame`
 * calls on a phone; the only things replaced are the four injected edges plan
 * Decision 8 exists to make replaceable — the canvas, the 2D context, the atlas
 * surface factory and the viewport measurement — plus the clock, which is a
 * parameter of `loop.frame` by design ("production passes
 * `requestAnimationFrame`'s own timestamp, so there is no second clock
 * anywhere"). Synthetic pointer events go in through the same
 * `createPointerInput` handlers `attachPointerEvents` wires, and every assertion
 * about what the player sees is read off the **recorded draw calls**, not off
 * `RenderFrame` and not off `GameState`.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS SHAPED AS A RECORD PLUS A PREDICATE
 * ---------------------------------------------------------------------------
 *
 * The plan's own warning is that this test degenerates into a smoke test the way
 * M1b's golden nearly did: an end-to-end run is expensive to set up, so the
 * temptation is one `expect(score).toBeGreaterThan(0)` at the end and a green
 * tick that means almost nothing. So the trip is recorded once into `TripRecord`
 * and every guard is a **pure predicate over that record**, collected in
 * `guardFailures`. That buys the thing a hand-written chain of `expect`s cannot:
 * `it('every guard can fail')` runs the SAME predicate over a deliberately
 * degenerate record — a frozen renderer, no roads, no score — and asserts each
 * guard names its own failure. A guard with no proof that it can fail is
 * indistinguishable from a comment.
 *
 * The three assertions that need their own driving — the hand-computed absolute
 * position, the two frames between one pair of ticks, and the atlas rebuild —
 * are separate tests, each with its own negative control.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK IS DRIVEN TO AN EXACT ALPHA, AND THAT IS NOT A CONVENIENCE
 * ---------------------------------------------------------------------------
 *
 * `oneTick(alpha)` below chooses each frame's duration from the loop's live
 * accumulator so the frame runs **exactly one tick and leaves exactly that
 * alpha**. Feeding a constant `TICK_MS` per frame does not: `1000 / 30` rounds
 * above exact, so repeated addition drifts by an ulp and the tick count flips
 * between 0 and 1 from one frame to the next. A test that cannot name the tick
 * and the alpha of the frame it is looking at cannot assert an absolute drawn
 * position, and an absolute drawn position is the only assertion in this file
 * that a uniform one-tick offset cannot satisfy.
 */

// ---------------------------------------------------------------------------
// The injected edges
// ---------------------------------------------------------------------------

/**
 * The M0 reference device, as `measureViewport` would report it. `rawDpr` is 3
 * and the camera's `dpr` must come back 2 — Decision 6's universal cap, applied
 * inside `fitCamera`, so no caller can forget it.
 */
const M0_VIEW = {
  cssW: 406,
  cssH: 870,
  topInset: 46,
  bottomInset: 34,
  rawDpr: 3,
  performanceClass: null,
} as const

/**
 * A viewport that changes the TILE size, for the atlas-rebuild case.
 * `floor(min(320 / 14, 718 / 22)) = floor(min(22.857, 32.6)) = 22`, so the
 * device tile moves 58 -> 44 and the atlas must be rebuilt.
 */
const NARROW_VIEW = { ...M0_VIEW, cssW: 320 } as const

/** A non-zero canvas offset, so a dropped `rect.left`/`rect.top` moves every tap. */
const CANVAS_LEFT = 11
const CANVAS_TOP = 7

interface FillCommand {
  readonly op: 'fill'
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly style: string
}
interface BlitCommand {
  readonly op: 'blit'
  readonly sx: number
  readonly sy: number
  readonly sw: number
  readonly sh: number
  readonly dx: number
  readonly dy: number
  readonly dw: number
  readonly dh: number
}
interface TextCommand {
  readonly op: 'text'
  readonly text: string
}
/** M1e Task 9's overcrowd ring, recorded with its sweep rather than its endpoints. */
interface ArcCommand {
  readonly op: 'arc'
  readonly x: number
  readonly y: number
  readonly radius: number
  readonly sweep: number
}
type Command = FillCommand | BlitCommand | TextCommand | ArcCommand

/**
 * The 2D context, recording. It satisfies `GameContext` structurally — the
 * shell's `setTransform` and the draw path's fills, text and blits — which is
 * the whole of plan Decision 8: production passes a canvas and this passes a
 * recorder, with no branch between them.
 */
class RecordingContext {
  fillStyle: string | CanvasGradient | CanvasPattern = ''
  strokeStyle: string | CanvasGradient | CanvasPattern = ''
  lineWidth = 0
  font = ''
  textAlign: CanvasTextAlign = 'start'
  textBaseline: CanvasTextBaseline = 'alphabetic'
  log: Command[] = []
  transforms = 0

  setTransform(): void {
    this.transforms++
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.log.push({ op: 'fill', x, y, w, h, style: String(this.fillStyle) })
  }
  fillText(text: string): void {
    this.log.push({ op: 'text', text })
  }
  beginPath(): void {}
  /** M1e Task 9's overcrowd ring. Recorded, so end-to-end cases can count rings. */
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.log.push({ op: 'arc', x, y, radius, sweep: endAngle - startAngle })
  }
  stroke(): void {}
  drawImage(
    _image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    this.log.push({ op: 'blit', sx, sy, sw, sh, dx, dy, dw, dh })
  }
}

/**
 * An atlas surface whose context does nothing. The atlas's own content is Task
 * 4's subject and is pinned there against a recording surface; what this file
 * needs from `buildAtlas` is a real `Atlas` handle carrying the real
 * `tileDevicePx`, which is what the blit source rects are read from.
 */
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

interface Rig {
  readonly game: Game
  readonly ctx: RecordingContext
  /**
   * How many times the game asked for a new run (M1e Task 9).
   *
   * **Every rig injects `deps.restart`, and it has to.** The production default
   * is `() => { location.reload() }` and there is no `location` in Node, so a
   * case that reaches a shutdown tap without one dies with
   * `ReferenceError: location is not defined` — which is the right failure for
   * a test that meant to exercise the restart, and a useless one for the twenty
   * cases that only meant to boot a board.
   */
  readonly restarts: number
  /** Client CSS x of the centre of board column `gx`. */
  readonly cx: (gx: number) => number
  readonly cy: (gy: number) => number
  /** Runs one frame that advances EXACTLY one tick and ends at exactly `alpha`. */
  readonly oneTick: (alpha: number) => void
  /** Runs one frame `ms` later, whatever that turns out to be. Returns the tick count. */
  readonly advance: (ms: number) => number
  /** Swaps the viewport the shell will measure next. */
  readonly setView: (view: (typeof M0_VIEW) | (typeof NARROW_VIEW)) => void
  readonly viewportChanged: (stable: boolean) => void
}

/**
 * Builds the real game on the shipped starting city, unless a case names
 * another board.
 *
 * **The rig pins `city`; it does NOT inherit `DEFAULT_LAYOUT_ID`, and that is
 * the point of the line rather than a detail of it.** Every case in this file
 * except the three below was written against the starting city and reads its
 * numbers off it: six live cars, the road cost of column 8, tick 383, the
 * 258-tick warm start re-derived from `SEED_FIRST_PIN_TICK`. The default board
 * is now the demo (24 cars, 18 destinations, a 1,200-tick warm start), so a rig
 * that took whatever the default happened to be would silently re-point all of
 * them at a board none of their arithmetic describes — measured: **17 of this
 * file's cases go red on that one word**, which is a diffuse failure that says
 * nothing about the thing that actually changed.
 *
 * **`in`, not `??` or a default parameter.** The three cases that are *about*
 * the default have to reach `createGame` with `layoutId` genuinely absent, and
 * they say so by passing `layoutId: undefined` explicitly. `??` cannot tell
 * that apart from omitting the property, so it would quietly convert those
 * three into city cases and leave the default with no end-to-end detector at
 * all.
 */
function buildRig(
  options: {
    warmStartTicks?: number
    fallback?: boolean
    preferFallback?: boolean
    layoutId?: string
    seed?: string
  } = {},
): Rig {
  const ctx = new RecordingContext()
  let view: (typeof M0_VIEW) | (typeof NARROW_VIEW) = M0_VIEW
  let restarts = 0
  const game = createGame({
    restart: () => {
      restarts++
    },
    canvas: {
      width: 0,
      height: 0,
      style: { width: '', height: '' },
      getBoundingClientRect: () => ({ left: CANVAS_LEFT, top: CANVAS_TOP }),
    },
    context: ctx,
    createSurface: stubSurface,
    createFallback:
      options.fallback === true
        ? () => ({
            textContent: null,
            setAttribute: () => undefined,
            addEventListener: () => undefined,
          })
        : () => null,
    measure: () => view,
    // Inline, so the second pass happens before the first frame rather than
    // never: in Node there is no `requestAnimationFrame` to defer it to.
    settle: (run) => {
      run()
    },
    warmStartTicks: options.warmStartTicks,
    preferFallback: options.preferFallback,
    // See the note above: `city` unless the case names a board, and `in` so a
    // case can still name "no board at all".
    layoutId: 'layoutId' in options ? options.layoutId : CITY_LAYOUT_ID,
    seed: options.seed,
  })

  const camera = (): ReturnType<typeof game.shell.resize> extends never ? never : Game['shell']['camera'] =>
    game.shell.camera

  let now = 1000
  return {
    game,
    ctx,
    get restarts(): number {
      return restarts
    },
    cx: (gx) => {
      const c = camera()
      return CANVAS_LEFT + c.originX + (gx - c.x0) * c.tileSize + c.tileSize / 2
    },
    cy: (gy) => {
      const c = camera()
      return CANVAS_TOP + c.originY + (gy - c.y0) * c.tileSize + c.tileSize / 2
    },
    oneTick: (alpha) => {
      // `accumulator` is in [0, TICK_MS), so this delta puts `accumulator + dt`
      // in [TICK_MS, 2 * TICK_MS): exactly one tick, remainder `alpha * TICK_MS`.
      now += TICK_MS + alpha * TICK_MS - game.loop.accumulator
      ctx.log = []
      game.frame(now)
    },
    advance: (ms) => {
      now += ms
      ctx.log = []
      game.frame(now)
      return game.loop.ticksLastFrame
    },
    setView: (next) => {
      view = next
    },
    viewportChanged: (stable) => {
      game.shell.viewportChanged(stable)
    },
  }
}

// ---------------------------------------------------------------------------
// Reading the recording back
// ---------------------------------------------------------------------------

/**
 * The drawn car sprites of one frame, in draw order.
 *
 * **Classified by size AND colour, and both halves are load-bearing.** A car is
 * `CAR_SIZE_FRACTION` = 1/2 of a tile — and so is a tree (`TREE_SIZE_FRACTION`)
 * and so is a carpark bay (`CARPARK_INSET/SIZE_FRACTION`). The first draft of
 * this classifier used size alone and picked up the tree at board cell (6, 9),
 * which is inside the revealed rect, on every frame. Colour separates all three:
 * a car is painted a **group** colour, a tree `palette.tree` and a bay
 * `palette.roadEdge`. Houses and destination footprints are group-coloured too
 * and are 2/3 and 2-or-3 whole tiles, so size separates those.
 */
function drawnCars(log: readonly Command[], tileSize: number): FillCommand[] {
  const size = tileSize / 2
  const groups = PALETTE.groups as readonly string[]
  return log.filter(
    (c): c is FillCommand =>
      c.op === 'fill' && c.w === size && c.h === size && groups.includes(c.style),
  )
}

function blits(log: readonly Command[]): BlitCommand[] {
  return log.filter((c): c is BlitCommand => c.op === 'blit')
}

// ---------------------------------------------------------------------------
// The trip, and the constants it is derived from
// ---------------------------------------------------------------------------

/**
 * The road the player draws: `(8, 13) -> (7, 12) -> (7, 11) -> (8, 10)`, which is
 * Task 2's own `TRIP_PATH` — house 1's cell to destination 0's carpark, NW then
 * N then NE. Deliberately not a straight line: it turns twice and two of its
 * three steps are diagonal, so nothing here is degenerate under "everything is
 * orthogonal" or "no route ever turns".
 */
const PATH: readonly (readonly [number, number])[] = [
  [8, 13],
  [7, 12],
  [7, 11],
  [8, 10],
]

/**
 * What the drag costs, hand-derived from `canPlaceRoad`'s
 * `cost = (maskA === 0) + (maskB === 0)`:
 *
 * ```
 * (8,13)->(7,12)   both ends bare          2
 * (7,12)->(7,11)   a is now set, b bare    1
 * (7,11)->(8,10)   a is now set, b bare    1
 * ```
 */
const EXPECTED_TILE_COST = 4
/** Four cells carry a non-zero mask afterwards — the four cells of `PATH`. */
const EXPECTED_ROAD_CELLS = 4

/** The car slot house 1 dispatches: house index 1, `CARS_PER_HOUSE` = 2, so slot 2. */
const TRIP_CAR_SLOT = 2
/**
 * Every car slot Task 2's seed creates is live from tick 0 — 3 houses x 2 cars.
 *
 * **This is no longer the fleet size for the whole of a run, and M1e Task 5 is
 * where it stopped being one.** The spawn phase places houses inside `step`,
 * and each one creates `CARS_PER_HOUSE` more cars, so any assertion below that
 * runs past tick 300 has to say WHICH tick's fleet it means. Every such site
 * now compares the drawn count against `liveCarSlots(state)` — the sim's own
 * answer, from an independent mechanism (`carPhase`, versus the renderer's
 * `snapshots.currLive`) — and pins the measured absolute beside it.
 */
const LIVE_CAR_SLOTS = 6

/** How many car slots the SIM calls live. The renderer's answer comes from `snapshots.currLive`. */
function liveCarSlots(state: Game['state']): number {
  let n = 0
  for (let i = 0; i < state.carPhase.length; i++) if ((state.carPhase[i] as number) !== PHASE_NONE) n++
  return n
}

/** The absolute tick the trip car is dispatched on. See `SEED_FIRST_PIN_TICK`. */
const DISPATCH_TICK = SEED_FIRST_PIN_TICK
/** The absolute tick `H_SCORE` reaches 1. Task 2's own `FIRST_SCORE_TICK`. */
const SCORE_TICK = 435

/**
 * The frame this file asserts an ABSOLUTE drawn position on, and every term of
 * its derivation.
 *
 * The car is seven ticks into its first edge — NW out of house 1 at (8, 13),
 * `edgeCost(NW) = DIAG_COST = 14`, threshold `14 * COST_UNIT_SCALE = 3500` — and
 * has crossed nothing, so both snapshots resolve on the same edge:
 *
 * ```
 * tick 384 (prev)   carProgress = 7 x 330 = 2310   f = 2310/3500 = 0.66
 * tick 385 (curr)   carProgress = 8 x 330 = 2640   f = 2640/3500 = 0.7542857142...
 * DX[NW], DY[NW] = (-1, -1)
 * prev = (8 - 0.66, 13 - 0.66)                     curr = (8 - 0.7542857142, 13 - ...)
 * alpha = 0.5  ->  (7.2928571428..., 12.2928571428...)
 * ```
 *
 * and the camera turns that into CSS px, `originX = 0`, `originY = 86`,
 * `tileSize = 29`, `x0 = 5`, `y0 = 9`, a sprite half a tile wide centred on the
 * position:
 *
 * ```
 * x = 0  + (7.2928571428 - 5) x 29 + 29/2 - 29/4 =  66.4928571428 + 7.25 =  73.7428571428
 * y = 86 + (12.2928571428 - 9) x 29 + 29/2 - 29/4 = 95.4928571428 + 7.25 + 86 = 188.7428571428
 * ```
 *
 * **This is the only assertion in the file that a uniform one-tick offset cannot
 * satisfy**, which is exactly what "draw before stepping" produces: the same
 * frame would then draw the tick-384 lerp, at x = 76.4771, 2.73 CSS px away.
 *
 * ---------------------------------------------------------------------------
 * WHY 385 AND NOT 383, WHICH IS WHERE THIS SAT UNTIL THE LAUNCH SMOOTHING
 * ---------------------------------------------------------------------------
 *
 * `buildFrame` draws `drawCar`, not `lerpCar`: a car that has just left a
 * standstill is drawn behind the sim position by a bounded, decaying amount
 * while its drawn speed ramps (`resolve.ts`). This car is dispatched on tick
 * 378, so at tick 383 it is mid-ramp and drawn 0.56 CSS px short of the exact
 * position — a real, intended difference, and asserting the exact figure there
 * would be asserting that the smoothing does not exist.
 *
 * Tick 385 is the first frame after the chase has caught up, and the assertion
 * is therefore STRONGER than it was: it pins the hand-derived sim arithmetic
 * exactly as before AND pins that the drawn position converges back onto it,
 * bit for bit, on the board that ships. If the chase's tuning changes, this
 * fails — which is the correct outcome for a constant whose whole content is
 * "the two agree here".
 */
const ABS_TICK = 385
const ABS_ALPHA = 0.5
const ABS_PROGRESS_PREV = 2310
const ABS_PROGRESS_CURR = 2640
const ABS_X = 73.74285714285715
const ABS_Y = 188.74285714285713

interface FrameSample {
  readonly tick: number
  readonly phase: number
  readonly alpha: number
  /** The trip car's drawn top-left corner, in CSS px. */
  readonly x: number
  readonly y: number
  /** The same position back in grid-cell units, for the between-two-cells guard. */
  readonly gx: number
  readonly gy: number
  readonly cars: number
  /** The SIM's live-slot count on the same frame — the independent half of the pair. */
  readonly liveSlots: number
}

interface TripRecord {
  readonly frames: readonly FrameSample[]
  readonly roadCells: number
  readonly tilesBefore: number
  readonly tilesAfter: number
  readonly scoreBefore: number
  readonly scoreAfter: number
  readonly dispatchTick: number
  readonly scoreTick: number
  readonly blitCells: readonly (readonly [number, number])[]
}

/**
 * Drives the whole trip once: draw the road with a synthetic drag, then run one
 * tick per frame at `alpha = 0.5` until the score moves, recording every frame.
 */
function runTrip(rig: Rig): TripRecord {
  const { game, ctx } = rig
  const camera = game.shell.camera
  const state = game.state

  // Frame 1 before any input, so `lastTime` is initialised (Decision 1b) and the
  // recorder has seen a complete frame of the untouched board.
  rig.advance(0)

  const tilesBefore = state.header[H_TILES] as number
  const scoreBefore = state.header[H_SCORE] as number

  // The drag: one `pointerdown` and one `pointermove` per cell of PATH. Every
  // consecutive pair is 8-adjacent, so `pointer.ts`'s walk emits exactly one
  // action per step and nothing is interpolated.
  const first = PATH[0] as readonly [number, number]
  expect(game.pointer.down(1, rig.cx(first[0]), rig.cy(first[1]))).toBe(PointerOutcome.DRAG_START)
  for (let i = 1; i < PATH.length; i++) {
    const cell = PATH[i] as readonly [number, number]
    expect(game.pointer.move(1, rig.cx(cell[0]), rig.cy(cell[1]))).toBe(PointerOutcome.DRAW)
  }
  expect(game.pointer.up(1)).toBe(PointerOutcome.DRAG_END)

  const frames: FrameSample[] = []
  let dispatchTick = -1
  let scoreTick = -1
  let blitCells: (readonly [number, number])[] = []

  for (let i = 0; i < 400 && scoreTick < 0; i++) {
    rig.oneTick(ABS_ALPHA)
    const tick = state.header[H_TICK] as number
    const phase = state.carPhase[TRIP_CAR_SLOT] as number
    if (dispatchTick < 0 && phase === PHASE_OUTBOUND) dispatchTick = tick
    if (scoreTick < 0 && (state.header[H_SCORE] as number) > scoreBefore) scoreTick = tick

    const cars = drawnCars(ctx.log, camera.tileSize)
    const car = cars[TRIP_CAR_SLOT]
    if (car !== undefined) {
      // Back out of CSS px into grid units — the exact inverse of
      // `originX + (gx - x0) * tile + tile/2 - tile/4`, so **minus** a quarter
      // tile, not plus. Written the wrong way round first, and the round-trip
      // assertion below is what caught it: every position came back offset by
      // exactly half a cell, which made `isStrictlyBetween` true for a PARKED
      // car and guard 3 satisfiable by a completely frozen board.
      const gx = (car.x - camera.tileSize / 4 - camera.originX) / camera.tileSize + camera.x0
      const gy = (car.y - camera.tileSize / 4 - camera.originY) / camera.tileSize + camera.y0
      frames.push({
        tick,
        phase,
        alpha: game.loop.alpha,
        x: car.x,
        y: car.y,
        gx,
        gy,
        cars: cars.length,
        liveSlots: liveCarSlots(state),
      })
    }
    if (i === 0) blitCells = blits(ctx.log).map((b) => screenToCell(b.dx, b.dy, camera))
  }

  let roadCells = 0
  for (let c = 0; c < game.world.cells; c++) if ((state.roads[c] as number) !== 0) roadCells++

  return {
    frames,
    roadCells,
    tilesBefore,
    tilesAfter: state.header[H_TILES] as number,
    scoreBefore,
    scoreAfter: state.header[H_SCORE] as number,
    dispatchTick,
    scoreTick,
    blitCells,
  }
}

/** A blit's destination corner back to the board cell it came from. */
function screenToCell(dx: number, dy: number, camera: Game['shell']['camera']): readonly [number, number] {
  return [
    camera.x0 + (dx - camera.originX) / camera.tileSize,
    camera.y0 + (dy - camera.originY) / camera.tileSize,
  ]
}

// ---------------------------------------------------------------------------
// The guards, as one predicate so they can be shown to fail
// ---------------------------------------------------------------------------

/** How many distinct drawn car positions a real trip must produce. */
const MIN_DISTINCT_POSITIONS = 10
/** How many frames must land on each leg, so the leg classification is not vacuous. */
const MIN_FRAMES_PER_LEG = 10

/**
 * Every anti-degeneracy guard, as a list of failures.
 *
 * Returning names rather than throwing is what lets `it('every guard can fail')`
 * assert that each one fires on a degenerate record. The catalogue's rule about
 * fixtures — something on each side of every guard, and an assertion that reads
 * both sides — is met by construction here: the real record must produce the
 * empty list and the frozen record must produce all of them.
 */
function guardFailures(trip: TripRecord): string[] {
  const failures: string[] = []

  // 1. A road was actually placed, and it cost what the walk says it costs.
  if (trip.roadCells <= 0) failures.push('no roads placed')
  if (trip.tilesBefore - trip.tilesAfter !== EXPECTED_TILE_COST) {
    failures.push(`H_TILES fell by ${trip.tilesBefore - trip.tilesAfter}, not ${EXPECTED_TILE_COST}`)
  }

  // 2. The score strictly increased.
  if (trip.scoreAfter <= trip.scoreBefore) failures.push('score did not increase')

  // 3. A car was drawn strictly between two cells — on BOTH axes, which only a
  //    diagonal edge produces, so an implementation that snapped to cell centres
  //    (or interpolated on one axis only) cannot satisfy it.
  const between = trip.frames.some((f) => isStrictlyBetween(f.gx) && isStrictlyBetween(f.gy))
  if (!between) failures.push('no car drawn strictly between two cells on both axes')

  // 4. The drawn position moved, on at least this many distinct frames.
  const distinct = new Set(trip.frames.map((f) => `${f.x},${f.y}`))
  if (distinct.size < MIN_DISTINCT_POSITIONS) {
    failures.push(`only ${distinct.size} distinct drawn positions, need ${MIN_DISTINCT_POSITIONS}`)
  }

  // 5. Monotone advance ALONG THE ROUTE. Every outbound edge of this route runs
  //    north (NW, N, NE), so the drawn `y` strictly decreases on the outbound leg
  //    and strictly increases on the return one. Stated per leg rather than
  //    globally because `x` is not monotone at all — the route turns twice.
  const out = trip.frames.filter((f) => f.phase === PHASE_OUTBOUND)
  const back = trip.frames.filter((f) => f.phase === PHASE_RETURNING)
  if (out.length < MIN_FRAMES_PER_LEG) failures.push(`only ${out.length} outbound frames`)
  if (back.length < MIN_FRAMES_PER_LEG) failures.push(`only ${back.length} returning frames`)
  for (let i = 1; i < out.length; i++) {
    if (!((out[i] as FrameSample).y < (out[i - 1] as FrameSample).y)) {
      failures.push(`outbound frame ${i} did not advance north`)
      break
    }
  }
  for (let i = 1; i < back.length; i++) {
    if (!((back[i] as FrameSample).y > (back[i - 1] as FrameSample).y)) {
      failures.push(`returning frame ${i} did not advance south`)
      break
    }
  }

  return failures
}

/** Strictly inside a cell-to-cell span: not on a cell centre, on either side. */
function isStrictlyBetween(g: number): boolean {
  const frac = g - Math.floor(g)
  return frac > 1e-6 && frac < 1 - 1e-6
}

/**
 * A record that is degenerate in every way the guards exist to catch: a frozen
 * renderer drawing one parked car forever, no road, no score.
 *
 * It is built rather than produced by a mutation because the point is to prove
 * the PREDICATE discriminates, and a predicate that cannot separate this from a
 * real trip is a comment. Every field is the "smoke test" value.
 */
function degenerateRecord(): TripRecord {
  const frames: FrameSample[] = []
  for (let i = 0; i < 60; i++) {
    frames.push({
      tick: 300 + i,
      phase: PHASE_OUTBOUND,
      alpha: 0,
      x: 94.25,
      y: 209.25,
      gx: 8,
      gy: 13,
      cars: LIVE_CAR_SLOTS,
      liveSlots: LIVE_CAR_SLOTS,
    })
  }
  return {
    frames,
    roadCells: 0,
    tilesBefore: 30,
    tilesAfter: 30,
    scoreBefore: 0,
    scoreAfter: 0,
    dispatchTick: -1,
    scoreTick: -1,
    blitCells: [],
  }
}

// ---------------------------------------------------------------------------

describe('the assembly boots', () => {
  it('builds a camera, an atlas, a seeded city and six live cars before the first frame', () => {
    const rig = buildRig()
    const { game } = rig
    const camera = game.shell.camera

    // Decision 5's fit and Decision 6's cap, on the M0 device, through the real
    // shell: `rawDpr` 3 in, `dpr` 2 out.
    expect([camera.tileSize, camera.originX, camera.originY, camera.dpr]).toEqual([29, 0, 86, 2])
    expect(game.atlases.road.tileDevicePx).toBe(58)
    expect(game.atlases.ghost.tileDevicePx).toBe(58)
    expect(game.shell.rebuilds).toBe(1)

    // The seed. Without it the build renders terrain and roads and nothing else.
    expect(game.state.header[H_HOUSE_COUNT] as number).toBe(3)
    expect(game.state.header[H_DEST_COUNT] as number).toBe(3)
    let live = 0
    for (let i = 0; i < game.state.carPhase.length; i++) {
      if ((game.state.carPhase[i] as number) !== PHASE_NONE) live++
    }
    expect(live).toBe(LIVE_CAR_SLOTS)

    // The canvas was sized in DEVICE px with the same rounding `drawFrame` snaps
    // its band edges with, and the transform was applied after the assignment.
    expect([rig.game.shell.canvasLeft, rig.game.shell.canvasTop]).toEqual([CANVAS_LEFT, CANVAS_TOP])
    expect(rig.ctx.transforms).toBeGreaterThan(0)
  })

  it('draws a complete frame: five matte fills, the buildings, six cars and three HUD labels', () => {
    const rig = buildRig()
    rig.advance(0)
    const log = rig.ctx.log
    const camera = rig.game.shell.camera

    // The matte, by colour: `background` and `land` are the only two entries no
    // content path can produce (`drawTerrain` skips LAND cells).
    const matte = log.filter(
      (c): c is FillCommand =>
        c.op === 'fill' && (c.style === PALETTE.background || c.style === PALETTE.land),
    )
    expect(matte.length).toBe(5)
    expect(matte.map((f) => f.style)).toEqual([
      PALETTE.background,
      PALETTE.background,
      PALETTE.background,
      PALETTE.land,
      PALETTE.background,
    ])
    // The playfield is exactly the grid rect — Task 9's letterbox affordance, on
    // the real camera rather than on a hand-built one.
    expect([matte[3]?.x, matte[3]?.y, matte[3]?.w, matte[3]?.h]).toEqual([
      camera.originX,
      camera.originY,
      camera.cols * camera.tileSize,
      camera.rows * camera.tileSize,
    ])

    expect(drawnCars(log, camera.tileSize).length).toBe(LIVE_CAR_SLOTS)
    // Three destination footprints, three houses. A footprint is 3x2 or 2x3
    // whole tiles; a house is 2/3 of one.
    const groups = PALETTE.groups as readonly string[]
    const houses = log.filter(
      (c): c is FillCommand =>
        c.op === 'fill' && groups.includes(c.style) && Math.abs(c.w - (camera.tileSize * 2) / 3) < 1e-9,
    )
    expect(houses.length).toBe(3)
    const labels = log.filter((c): c is TextCommand => c.op === 'text')
    expect(labels.map((t) => t.text)).toEqual(['W0 D0', '0 TRIPS', '30 TILES'])

    // No road has been drawn yet, so no blit — which is what makes the four
    // blits after the drag evidence of the drag and not of the board.
    expect(blits(log).length).toBe(0)
  })

  it('honours ?fallback=1 even where a MainButton exists — Task 8’s F5 escape hatch', () => {
    // `mainButton()` is the only Telegram surface in this build that has never
    // run on a phone, and it is the one that closes this milestone's Critical:
    // if a client reports a MainButton and then does not RENDER it — Telegram's
    // own fullscreen, which `boot()` requests on every 8.0+ client, is the
    // obvious candidate — the fallback is never created and there is no rebind,
    // so erase is unreachable on the NEWEST clients. This is the way back.
    const telegram = (globalThis as Record<string, unknown>).Telegram
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
    try {
      // Vacuity: the SAME client, without the flag, must bind the native button
      // — otherwise this proves the stub is broken rather than that the flag works.
      const native = buildRig({ fallback: true })
      expect(native.game.erase.surface).toBe(EraseControlSurface.MAIN_BUTTON)

      const forced = buildRig({ fallback: true, preferFallback: true })
      expect(forced.game.erase.surface).toBe(EraseControlSurface.DOM_PREFERRED)
      // ...and it still drives the mode, which is the whole point of the hatch.
      expect(forced.game.pointer.eraseMode).toBe(false)
      expect(forced.game.erase.press()).toBe(true)
      expect(forced.game.pointer.eraseMode).toBe(true)
    } finally {
      if (telegram === undefined) delete (globalThis as Record<string, unknown>).Telegram
      else (globalThis as Record<string, unknown>).Telegram = telegram
    }
  })

  it('reads the hatch from the query string, both ways', () => {
    expect(prefersFallback('?fallback=1')).toBe(true)
    expect(prefersFallback('?a=b&fallback=1&c=d')).toBe(true)
    // Not truthy-coerced: `?fallback=0` and a bare `?fallback` must NOT force it,
    // or a Telegram-appended parameter could disable the shipping control.
    expect(prefersFallback('?fallback=0')).toBe(false)
    expect(prefersFallback('?fallback')).toBe(false)
    expect(prefersFallback('')).toBe(false)
    expect(prefersFallback('?tgWebAppData=x')).toBe(false)
  })

  it('binds the erase control, and the mode reaches the pointer machine', () => {
    // The milestone's inherited Critical: `hudRects` has three elements and none
    // is a toggle, so without this the shipped build draws roads and never
    // removes one. In Node there is no MainButton and no DOM, so the shipped
    // path here is the injected fallback.
    const rig = buildRig({ fallback: true })
    expect(rig.game.erase.surface).toBe(EraseControlSurface.DOM_NO_TELEGRAM)
    expect(rig.game.pointer.eraseMode).toBe(false)
    expect(rig.game.erase.press()).toBe(true)
    expect(rig.game.pointer.eraseMode).toBe(true)

    // ...and with no fallback element at all it still toggles, rather than the
    // constructor throwing and taking boot with it.
    const bare = buildRig()
    expect(bare.game.erase.surface).toBe(EraseControlSurface.NONE)
    expect(bare.game.erase.press()).toBe(true)
    expect(bare.game.pointer.eraseMode).toBe(true)
  })
})

describe('a full trip, drawn: road in, car out, score up', () => {
  const trip = runTrip(buildRig())

  it('draws a road through exactly the cells the pointer walked', () => {
    // The blits are read off the recording and mapped back through the camera,
    // so this is what a player would SEE, not what `state.roads` holds.
    expect(trip.blitCells.length).toBe(EXPECTED_ROAD_CELLS)
    expect([...trip.blitCells].sort()).toEqual([...PATH].sort())
    expect(trip.roadCells).toBe(EXPECTED_ROAD_CELLS)
  })

  it('dispatches a car and scores, on the ticks the seed’s own arithmetic predicts', () => {
    expect(trip.dispatchTick).toBe(DISPATCH_TICK)
    expect(trip.scoreTick).toBe(SCORE_TICK)
    expect(trip.scoreAfter).toBe(trip.scoreBefore + 1)
    // Re-derived rather than asserted: the first pin cannot fire before the
    // delay, plus the colour accumulator reaching its period at 2 slots a tick.
    expect(DISPATCH_TICK).toBe(FIRST_PIN_DELAY_TICKS - 1 + Math.ceil(PIN_PERIOD_TICKS / 2))
    // ...and the trip is 2 x (NW + N + NE) = 2 x (14 + 10 + 14) cost units.
    expect(SCORE_TICK - DISPATCH_TICK + 1).toBe(
      Math.ceil((2 * (DIAG_COST + 10 + DIAG_COST) * COST_UNIT_SCALE) / 330),
    )
  })

  it('passes every anti-degeneracy guard', () => {
    expect(guardFailures(trip)).toEqual([])
  })

  it('is not vacuous: EVERY guard fires on a frozen, road-free, score-free record', () => {
    // The proof that each guard above can fail. Without it, `toEqual([])` is
    // satisfied by a predicate that returns `[]` unconditionally — which is
    // exactly the shape an end-to-end test degenerates into.
    const failures = guardFailures(degenerateRecord())
    expect(failures).toEqual([
      'no roads placed',
      'H_TILES fell by 0, not 4',
      'score did not increase',
      'no car drawn strictly between two cells on both axes',
      'only 1 distinct drawn positions, need 10',
      'only 0 returning frames',
      'outbound frame 1 did not advance north',
    ])
  })

  it('is not vacuous: the guards discriminate ONE degeneracy at a time', () => {
    // The compound record above proves the predicate is not constant; it does
    // not prove each guard is independently live, because one failure could be
    // carrying the rest. So each guard is perturbed on its own, from the REAL
    // record, and must be the only thing that fires.
    const frozen = { ...trip, frames: trip.frames.map((f) => ({ ...f, x: 94.25, y: 209.25, gx: 8, gy: 13 })) }
    expect(guardFailures(frozen)).toEqual([
      'no car drawn strictly between two cells on both axes',
      `only 1 distinct drawn positions, need ${MIN_DISTINCT_POSITIONS}`,
      'outbound frame 1 did not advance north',
      'returning frame 1 did not advance south',
    ])
    expect(guardFailures({ ...trip, roadCells: 0 })).toEqual(['no roads placed'])
    expect(guardFailures({ ...trip, tilesAfter: trip.tilesBefore })).toEqual([
      `H_TILES fell by 0, not ${EXPECTED_TILE_COST}`,
    ])
    expect(guardFailures({ ...trip, scoreAfter: trip.scoreBefore })).toEqual([
      'score did not increase',
    ])
    // A one-tick REVERSAL on the outbound leg — the smallest thing the
    // monotonicity guard exists to catch, and invisible to every other guard.
    // The frame is located by phase rather than by ordinal: the first 119 frames
    // of the record are the car sitting IDLE waiting for its pin, so perturbing
    // `frames[20]` fires nothing at all and the assertion would have passed on
    // an empty failure list.
    const outboundAt = trip.frames
      .map((f, i) => (f.phase === PHASE_OUTBOUND ? i : -1))
      .filter((i) => i >= 0)
    expect(outboundAt.length).toBeGreaterThan(12)
    const jittered = trip.frames.map((f, i) =>
      i === (outboundAt[11] as number) ? { ...f, y: f.y + 5 } : f,
    )
    expect(guardFailures({ ...trip, frames: jittered })).toEqual([
      'outbound frame 11 did not advance north',
    ])
  })

  it('is not vacuous: the real record has both legs, and the car is drawn on every frame', () => {
    // Guards 3 and 5 are about the trip car specifically. If `drawnCars` picked
    // the wrong sprite — the first draft picked a TREE, which is also half a
    // tile — every frame would carry a constant position and guard 5 would be
    // asserting the monotonicity of nothing.
    // One frame per tick from the warm start's end to the scoring tick.
    expect(trip.frames.length).toBe(SCORE_TICK - WARM_START_TICKS)
    expect(trip.frames.length).toBe(177)
    // **Re-derived at M1e Task 5: the fleet GROWS inside this record, so one
    // constant cannot describe it any more.** A colour-0 house spawns at tick
    // 360 (this is `RUN_SEED`, and the fleet reaches 8 before the trip scores
    // at 435), which is exactly the behaviour Task 5 shipped. Three assertions
    // replace the one that used to compare against `LIVE_CAR_SLOTS`, and
    // together they are stronger than it was:
    //
    //   - the DRAWN count equals the SIM's live-slot count on every frame —
    //     two independent mechanisms (`snapshots.currLive` versus `carPhase`)
    //     agreeing, which the old constant could not check at all;
    //   - it never falls, which is the property `resolve.ts`'s slot-reuse
    //     argument rests on;
    //   - and the two endpoints are pinned, so a fleet that stopped growing —
    //     or one that ran away — fails here with a number in the message.
    for (const f of trip.frames) {
      expect(f.cars, `tick ${f.tick}: drawn ${f.cars} against sim ${f.liveSlots}`).toBe(f.liveSlots)
    }
    for (let i = 1; i < trip.frames.length; i++) {
      const prev = trip.frames[i - 1] as FrameSample
      const cur = trip.frames[i] as FrameSample
      expect(cur.cars, `the fleet shrank at tick ${cur.tick}`).toBeGreaterThanOrEqual(prev.cars)
    }
    expect((trip.frames[0] as FrameSample).cars, "the seed's own fleet").toBe(LIVE_CAR_SLOTS)
    const grewAt = trip.frames
      .filter((f, i) => i > 0 && f.cars > (trip.frames[i - 1] as FrameSample).cars)
      .map((f) => `${f.tick}:${f.cars}`)
    // Measured on `RUN_SEED`: a colour-0 house at tick 360 and a colour-1 house
    // at 420, each adding `CARS_PER_HOUSE` cars. Both are inside the trip
    // record, so this is the one place in the file that watches the spawner
    // through the DRAW path rather than through state.
    expect(grewAt, 'the ticks the fleet grew on, and to what').toEqual(['360:8', '420:10'])
    expect((trip.frames[trip.frames.length - 1] as FrameSample).cars).toBe(
      LIVE_CAR_SLOTS + 2 * CARS_PER_HOUSE,
    )
    expect(trip.frames.filter((f) => f.phase === PHASE_OUTBOUND).length).toBeGreaterThan(20)
    expect(trip.frames.filter((f) => f.phase === PHASE_RETURNING).length).toBeGreaterThan(20)
    // The car ends where it started — a round trip, not a one-way drive. Within
    // one tick's motion rather than exactly: the scoring frame renders at
    // `alpha = 0.5` between the last RETURNING tick and the IDLE one that
    // completes the trip, and plan Decision 2 bounds that step at
    // `330 * sqrt(2) / 3500 = 0.13334` cells (the diagonal supremum, attained).
    const first = trip.frames[0] as FrameSample
    const last = trip.frames[trip.frames.length - 1] as FrameSample
    expect([first.gx, first.gy], 'the car does not start parked at its house').toEqual([8, 13])
    const drift = Math.hypot(last.gx - first.gx, last.gy - first.gy)
    expect(drift, `ended ${drift} cells from home`).toBeLessThan(0.13334)
    expect(drift, 'exactly home would mean the trip-end step was zero').toBeGreaterThan(0)
  })

  it('draws the car at a HAND-COMPUTED absolute position on tick 385 at alpha 0.5', () => {
    // The one assertion a uniform one-tick offset cannot satisfy. See ABS_TICK
    // for the full derivation: prev and curr both resolve on the NW edge out of
    // (8, 13) at progress 1650 and 1980 against a 3500 threshold.
    const sample = trip.frames.find((f) => f.tick === ABS_TICK)
    expect(sample, `no frame at tick ${ABS_TICK}`).toBeDefined()
    expect(sample?.alpha).toBeCloseTo(ABS_ALPHA, 12)
    expect(sample?.x).toBeCloseTo(ABS_X, 4)
    expect(sample?.y).toBeCloseTo(ABS_Y, 4)

    // The derivation, recomputed here from the sim's own constants rather than
    // copied from the literal above — so the literal and the reasoning cannot
    // drift together.
    const threshold = DIAG_COST * COST_UNIT_SCALE
    expect(threshold).toBe(3500)
    const prevG = 8 - ABS_PROGRESS_PREV / threshold
    const currG = 8 - ABS_PROGRESS_CURR / threshold
    const lerped = prevG + (currG - prevG) * ABS_ALPHA
    const camera = buildRig().game.shell.camera
    expect(camera.originX + (lerped - camera.x0) * camera.tileSize + camera.tileSize / 4).toBeCloseTo(
      ABS_X,
      9,
    )
    // And the value a "draw before stepping" renderer would have produced on the
    // same frame, so the 4-decimal tolerance is visibly nowhere near it.
    const offBySelfOneTick =
      camera.originX +
      (8 - (ABS_PROGRESS_PREV - 330 / 2) / threshold - camera.x0) * camera.tileSize +
      camera.tileSize / 4
    expect(Math.abs(offBySelfOneTick - ABS_X)).toBeGreaterThan(2.7)
  })
})

describe('interpolation is real: two frames between the same pair of ticks', () => {
  it('draws the car at three different positions without stepping the sim', () => {
    // **The only guard that kills `alpha = 0`** (Task 6 states why): with
    // progress-resolved positions a car is strictly between two cells on roughly
    // seven ticks in eight regardless of alpha, so "between two cells" and ">= 10
    // distinct positions" both survive that mutation. This does not.
    const rig = buildRig()
    const camera = rig.game.shell.camera
    runTripSetup(rig)

    // Land on a tick where the car is mid-edge, with the accumulator near zero.
    while ((rig.game.state.header[H_TICK] as number) < ABS_TICK) rig.oneTick(1e-9)
    expect(rig.game.state.carPhase[TRIP_CAR_SLOT] as number).toBe(PHASE_OUTBOUND)

    const seen: string[] = []
    for (const step of [0, 1, 2]) {
      // A third of a tick each: no tick can run, so all three frames sit between
      // the same pair of sim states.
      const ticks = rig.advance(step === 0 ? 0 : TICK_MS / 3)
      expect(ticks, 'a tick ran — the three frames are not between one pair').toBe(0)
      const car = drawnCars(rig.ctx.log, camera.tileSize)[TRIP_CAR_SLOT]
      expect(car).toBeDefined()
      seen.push(`${car?.x},${car?.y}`)
    }
    expect(rig.game.state.header[H_TICK] as number).toBe(ABS_TICK)
    expect(new Set(seen).size, `alpha is being ignored: ${seen.join(' ')}`).toBe(3)
  })
})

describe('a 2,000 ms stall', () => {
  it('runs exactly 7 ticks from a fresh accumulator, and the run continues correctly', () => {
    // Decision 1: `MAX_FRAME_DT_MS` does not eliminate catch-up, it BOUNDS it —
    // 250 / TICK_MS = 7.4999..., so seven whole ticks and a 16.667 ms residual.
    const rig = buildRig()
    runTripSetup(rig)
    rig.oneTick(1e-9)
    const before = rig.game.state.header[H_TICK] as number
    expect(rig.game.loop.accumulator).toBeLessThan(1e-6)

    expect(rig.advance(2000)).toBe(7)
    expect((rig.game.state.header[H_TICK] as number) - before).toBe(7)
    // 250 - 7 x TICK_MS = 16.6666..., i.e. exactly half a tick left over.
    expect(rig.game.loop.alpha).toBeCloseTo(0.5, 8)

    // "Continues correctly": the trip still completes, on the tick it would have
    // reached anyway — the stall consumed wall-clock time, not simulation.
    let scoreTick = -1
    for (let i = 0; i < 400 && scoreTick < 0; i++) {
      rig.oneTick(0.5)
      if ((rig.game.state.header[H_SCORE] as number) > 0) scoreTick = rig.game.state.header[H_TICK] as number
    }
    expect(scoreTick).toBe(SCORE_TICK)
    // The drawn fleet against the sim's own count, not against a constant — see
    // `LIVE_CAR_SLOTS`. This case runs further than the trip record does (the
    // 2,000 ms stall costs no simulation, but `runTripSetup` plus the drain
    // leaves it past two house spawns), so the absolute is 10 rather than 8.
    expect(drawnCars(rig.ctx.log, rig.game.shell.camera.tileSize).length).toBe(
      liveCarSlots(rig.game.state),
    )
    expect(liveCarSlots(rig.game.state), 'two houses spawned before the score').toBe(
      LIVE_CAR_SLOTS + 2 * CARS_PER_HOUSE,
    )
  })

  it('is not vacuous: a 2,000 ms PAUSE resumes with no burst at all', () => {
    // The pair is what makes 7 discriminating. Freezing the accumulator without
    // resetting the clock reference passes the stall case and fails this one:
    // the first unpaused frame would see `rawDt` = the pause duration and drain
    // the same seven ticks.
    const rig = buildRig()
    rig.advance(0)
    rig.game.loop.setPaused(true)
    rig.advance(2000)
    rig.game.loop.setPaused(false)
    expect(rig.advance(16)).toBe(0)
    expect(rig.advance(17)).toBeLessThanOrEqual(1)
  })
})

describe('a viewport change that alters the tile size', () => {
  it('rebuilds the atlas exactly once and the NEXT frame blits at the new tile size', () => {
    const rig = buildRig()
    runTripSetup(rig)
    rig.oneTick(0.5)

    // Before: 29 CSS px tiles at DPR 2, so a 58 device px source rect.
    const before = blits(rig.ctx.log)
    expect(before.length).toBe(EXPECTED_ROAD_CELLS)
    expect([before[0]?.sw, before[0]?.dw]).toEqual([58, 29])
    expect(rig.game.shell.rebuilds).toBe(1)

    rig.setView(NARROW_VIEW)
    rig.viewportChanged(true)
    expect(rig.game.shell.rebuilds).toBe(2)
    expect(rig.game.shell.camera.tileSize).toBe(22)
    expect(rig.game.atlases.road.tileDevicePx).toBe(44)
    expect(rig.game.atlases.ghost.tileDevicePx).toBe(44)

    rig.oneTick(0.5)
    const after = blits(rig.ctx.log)
    expect(after.length).toBe(EXPECTED_ROAD_CELLS)
    expect([after[0]?.sw, after[0]?.sh, after[0]?.dw, after[0]?.dh]).toEqual([44, 44, 22, 22])
  })

  it('is not vacuous: a viewport change that does NOT alter the tile size rebuilds nothing', () => {
    // Without this, "always rebuild" passes the bullet above — and a rebuild
    // storm is 256 tiles re-rasterised per event. Asserted as a COUNT, because
    // "rebuilding at the same size is idempotent" is true of a storm too.
    const rig = buildRig()
    rig.advance(0)
    expect(rig.game.shell.rebuilds).toBe(1)
    for (let i = 0; i < 10; i++) rig.viewportChanged(true)
    expect(rig.game.shell.rebuilds).toBe(1)
    // ...and an UNSTABLE event on a viewport that would change the tile size is
    // not measured at all.
    rig.setView(NARROW_VIEW)
    rig.viewportChanged(false)
    expect(rig.game.shell.rebuilds).toBe(1)
    expect(rig.game.shell.camera.tileSize).toBe(29)
  })
})

describe('the warm start', () => {
  it('re-derives SEED_FIRST_PIN_TICK by measuring the real seeded city', () => {
    // The literal `main.ts` rests on, measured rather than trusted: a city whose
    // first pin moved — a different destination kind, a different colour, a
    // changed PIN_PERIOD_TICKS — makes the warm start the wrong length, and this
    // is the only thing that would say so.
    const cold = buildRig({ warmStartTicks: 0 })
    expect(cold.game.state.header[H_TICK] as number).toBe(0)
    let firstPin = -1
    for (let i = 0; i < 600 && firstPin < 0; i++) {
      cold.oneTick(0.5)
      let pins = 0
      for (let d = 0; d < (cold.game.state.header[H_DEST_COUNT] as number); d++) {
        pins += cold.game.state.destPins[d] as number
      }
      if (pins > 0) firstPin = cold.game.state.header[H_TICK] as number
    }
    expect(firstPin).toBe(SEED_FIRST_PIN_TICK)
    expect(WARM_START_TICKS).toBe(SEED_FIRST_PIN_TICK - FIRST_PIN_DELAY_TICKS)
    expect(WARM_START_TICKS).toBe(258)
  })

  it('leaves the board visibly identical to tick 0, and the first pin 120 ticks away', () => {
    // The whole justification: the warm start removes the ACCUMULATOR ramp and
    // keeps the designed first-pin delay. If it changed anything a player can
    // see, it would be a cheat rather than a wait removed.
    const cold = buildRig({ warmStartTicks: 0 })
    const warm = buildRig()
    cold.advance(0)
    warm.advance(0)
    expect(warm.game.state.header[H_TICK] as number).toBe(WARM_START_TICKS)
    expect(cold.ctx.log).toEqual(warm.ctx.log)

    // ...and 120 ticks later — 4.00 s at 30 Hz — the first pin appears.
    let pinTick = -1
    for (let i = 0; i < 200 && pinTick < 0; i++) {
      warm.oneTick(0.5)
      let pins = 0
      for (let d = 0; d < (warm.game.state.header[H_DEST_COUNT] as number); d++) {
        pins += warm.game.state.destPins[d] as number
      }
      if (pins > 0) pinTick = warm.game.state.header[H_TICK] as number
    }
    expect(pinTick - WARM_START_TICKS).toBe(FIRST_PIN_DELAY_TICKS)
    expect(FIRST_PIN_DELAY_TICKS / 30).toBe(4)
  })

  it('is not vacuous: the cold board really does take 12.6 s, and the drawn frames differ later', () => {
    // Without the first half this file could not tell "the warm start works"
    // from "there was never a wait". Without the second, `toEqual` above could
    // be comparing two recordings that are equal for every tick.
    expect(SEED_FIRST_PIN_TICK / 30).toBeCloseTo(12.6, 1)
    const cold = buildRig({ warmStartTicks: 0 })
    const warm = buildRig()
    for (let i = 0; i < 130; i++) {
      cold.oneTick(0.5)
      warm.oneTick(0.5)
    }
    expect(warm.ctx.log).not.toEqual(cold.ctx.log)
  })
})

describe('the DOM edge', () => {
  interface StubTarget extends PointerEventTarget {
    fire: (type: string, event: PointerEventLike) => void
    readonly captured: number[]
    readonly released: number[]
  }

  function stubTarget(): StubTarget {
    const handlers = new Map<string, (event: PointerEventLike) => void>()
    const captured: number[] = []
    const released: number[] = []
    return {
      addEventListener: (type, handler) => {
        handlers.set(type, handler)
      },
      setPointerCapture: (id) => {
        captured.push(id)
      },
      releasePointerCapture: (id) => {
        released.push(id)
        // A real target throws here once the capture is already gone, which is
        // exactly what `lostpointercapture` means.
        if (released.filter((r) => r === id).length > 1) throw new Error('InvalidPointerId')
      },
      fire: (type, event) => {
        const handler = handlers.get(type)
        if (handler === undefined) throw new Error(`nothing wired to "${type}"`)
        handler(event)
      },
      captured,
      released,
    }
  }

  const at = (rig: Rig, gx: number, gy: number, pointerId = 1): PointerEventLike => ({
    pointerId,
    clientX: rig.cx(gx),
    clientY: rig.cy(gy),
  })

  it('wires all five pointer events, and capture to the two outcomes that ask for it', () => {
    const rig = buildRig()
    const target = stubTarget()
    attachPointerEvents(target, rig.game.pointer)
    rig.advance(0)

    target.fire('pointerdown', at(rig, 8, 13))
    expect(target.captured).toEqual([1])
    expect(rig.game.pointer.dragging).toBe(true)

    target.fire('pointermove', at(rig, 7, 12))
    expect(rig.game.queue.length).toBe(1)

    target.fire('pointerup', at(rig, 7, 12))
    expect(target.released).toEqual([1])
    expect(rig.game.pointer.dragging).toBe(false)

    // `pointercancel` is its own entry point, and dropping it latches the drag.
    target.fire('pointerdown', at(rig, 8, 13, 2))
    target.fire('pointercancel', at(rig, 8, 13, 2))
    expect(rig.game.pointer.dragging).toBe(false)
    expect(target.released).toEqual([1, 2])

    // `lostpointercapture` ends the drag AND must not throw: the browser has
    // already dropped the capture, so releasing again raises InvalidPointerId.
    target.fire('pointerdown', at(rig, 8, 13, 2))
    expect(() => {
      target.fire('lostpointercapture', at(rig, 8, 13, 2))
    }).not.toThrow()
    expect(rig.game.pointer.dragging).toBe(false)
  })

  it('is not vacuous: a tap that starts no drag captures nothing', () => {
    // Otherwise "capture on DRAG_START" is satisfied by capturing on every
    // pointerdown, which steals every subsequent event from the page.
    const rig = buildRig()
    const target = stubTarget()
    attachPointerEvents(target, rig.game.pointer)
    rig.advance(0)
    // The top band: spec §8.3 forbids anything interactive there, so `down`
    // returns IGNORED.
    target.fire('pointerdown', { pointerId: 9, clientX: CANVAS_LEFT + 100, clientY: CANVAS_TOP + 1 })
    expect(target.captured).toEqual([])
    expect(rig.game.pointer.dragging).toBe(false)
  })

  it('aborts a drag when the webview is hidden, and leaves it alone when it is not', () => {
    const rig = buildRig()
    let state = 'visible'
    let handler: (() => void) | null = null
    const doc = {
      get visibilityState(): string {
        return state
      },
      addEventListener: (_type: 'visibilitychange', h: () => void) => {
        handler = h
      },
    }
    attachVisibility(doc, rig.game.pointer)
    rig.advance(0)
    rig.game.pointer.down(1, rig.cx(8), rig.cy(13))
    expect(rig.game.pointer.dragging).toBe(true)

    // A `visibilitychange` to VISIBLE must not end the stroke.
    ;(handler as unknown as () => void)()
    expect(rig.game.pointer.dragging).toBe(true)

    state = 'hidden'
    ;(handler as unknown as () => void)()
    expect(rig.game.pointer.dragging).toBe(false)
  })

  it('wireGame binds all three sources and reschedules itself every frame', () => {
    // `startGame` reads `document` and cannot run in Node, so before `wireGame`
    // existed every call it made was untestable by construction — deleting the
    // `attachVisibility` line scored 0 detectors across the whole suite. This is
    // the production entry's wiring, driven with stubs.
    const rig = buildRig()
    const target = stubTarget()
    let visibility = 'visible'
    let visHandler: (() => void) | null = null
    const doc = {
      get visibilityState(): string {
        return visibility
      },
      addEventListener: (_type: 'visibilitychange', handler: () => void) => {
        visHandler = handler
      },
    }
    const scheduled: ((now: number) => void)[] = []
    const viewportHandlers = new Map<string, () => void>()
    wireGame(
      rig.game,
      target,
      doc,
      (callback) => scheduled.push(callback),
      { addEventListener: (type, handler) => viewportHandlers.set(type, handler) },
      (run) => {
        run()
      },
    )

    // 1. the frame loop is running, and it reschedules — a `raf` called once and
    //    never again is a game that draws one frame and freezes.
    expect(scheduled.length).toBe(1)
    const before = rig.game.state.header[H_TICK] as number
    ;(scheduled[0] as (now: number) => void)(9_000_000)
    expect(scheduled.length).toBe(2)
    // ...and the timestamp it was handed is the loop's clock, so a run that
    // resumed from a stale reference cannot burst.
    expect(rig.game.loop.ticksLastFrame).toBe(0)
    expect(rig.game.state.header[H_TICK] as number).toBe(before)
    ;(scheduled[1] as (now: number) => void)(9_000_100)
    expect(rig.game.loop.ticksLastFrame).toBe(2) // Decision 1's table: 100 ms is 2 ticks

    // 2. the pointer events reach the state machine.
    target.fire('pointerdown', at(rig, 8, 13))
    expect(rig.game.pointer.dragging).toBe(true)
    expect(target.captured).toEqual([1])

    // 3. the visibility handler is bound, and only "hidden" aborts.
    expect(visHandler, 'visibilitychange was never wired').not.toBeNull()
    ;(visHandler as unknown as () => void)()
    expect(rig.game.pointer.dragging, 'a visible event ended the stroke').toBe(true)
    visibility = 'hidden'
    ;(visHandler as unknown as () => void)()
    expect(rig.game.pointer.dragging).toBe(false)

    // 4. the viewport sources. There is no Telegram in Node, so `bootShell`
    //    could not subscribe — `attachViewport` reads that and wires `resize`
    //    as well, which is the case that was silently unwired before.
    expect(rig.game.shell.subscribed).toBe(false)
    expect([...viewportHandlers.keys()].sort()).toEqual(['orientationchange', 'resize'])
  })

  it('attachViewport reads shell.subscribed, and wires resize only when it is false', () => {
    // `Shell.subscribed` was a diagnostic no caller read. On a client with no
    // Telegram object — `pnpm dev`, or an iOS client where the SDK script failed
    // to load, which spec §8.5 says happens silently — nothing was subscribed to
    // any viewport event, so the canvas never resized for the life of the
    // session. Both branches, because wiring `resize` unconditionally is a spec
    // §8.3 violation on a real client (it fires through a keyboard animation
    // against the transient height) and wiring it never is the gap.
    for (const subscribed of [true, false]) {
      const seen: string[] = []
      let measured = 0
      const wired = attachViewport(
        { addEventListener: (type) => seen.push(type) },
        {
          subscribed,
          viewportChanged: () => {
            measured++
            return SizingOutcome.UNCHANGED
          },
        },
        (run) => {
          run()
        },
      )
      expect(wired, `subscribed=${subscribed}`).toEqual(
        subscribed ? ['orientationchange'] : ['orientationchange', 'resize'],
      )
      expect(seen).toEqual(wired)
      expect(measured, 'wiring must not measure').toBe(0)
    }
  })

  it('routes an orientation change to the shell, through the settle', () => {
    // Plan Decision 5 lists orientation change as a measurement trigger beside
    // boot, the settle and stable `viewportChanged`. It fires BEFORE the new
    // metrics are published, so it goes through `settle` — deferred, then
    // measured, and reported as a STABLE event because a rotation is not a
    // transition frame.
    const rig = buildRig()
    rig.advance(0)
    expect(rig.game.shell.rebuilds).toBe(1)

    let handler: (() => void) | null = null
    const deferred: (() => void)[] = []
    attachViewport(
      { addEventListener: (type, h) => {
        if (type === 'orientationchange') handler = h
      } },
      rig.game.shell,
      (run) => deferred.push(run),
    )
    expect(handler, 'orientationchange was never wired').not.toBeNull()

    // A rotation that changes the tile size, 406 -> 320 CSS px wide.
    rig.setView(NARROW_VIEW)
    ;(handler as unknown as () => void)()
    // Deferred, not measured inline — reading the viewport now would fit against
    // the pre-rotation rectangle.
    expect(deferred.length).toBe(1)
    expect(rig.game.shell.camera.tileSize, 'measured before the settle').toBe(29)
    ;(deferred[0] as () => void)()
    expect(rig.game.shell.camera.tileSize).toBe(22)
    expect(rig.game.shell.rebuilds).toBe(2)
    expect(rig.game.atlases.road.tileDevicePx).toBe(44)
    expect(rig.game.atlases.ghost.tileDevicePx).toBe(44)
  })

  it('auto-starts only where a document exists', () => {
    // Importing this file must be inert under vitest's Node environment, and a
    // future switch to a DOM environment must not silently boot a game inside
    // every test file. Both directions, because one of them is what is true here.
    expect(shouldAutoStart({})).toBe(false)
    expect(shouldAutoStart({ document: {} })).toBe(true)
    expect(shouldAutoStart(globalThis)).toBe(false)
  })

  it('names the canvas index.html actually ships', () => {
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')
    expect(html.length).toBeGreaterThan(500)
    expect(html).toContain(`id="${CANVAS_ELEMENT_ID}"`)
  })
})

// ---------------------------------------------------------------------------

/** Frame 1, then the drag. Shared by every test that needs a road on the board. */
function runTripSetup(rig: Rig): void {
  rig.advance(0)
  const first = PATH[0] as readonly [number, number]
  rig.game.pointer.down(1, rig.cx(first[0]), rig.cy(first[1]))
  for (let i = 1; i < PATH.length; i++) {
    const cell = PATH[i] as readonly [number, number]
    rig.game.pointer.move(1, rig.cx(cell[0]), rig.cy(cell[1]))
  }
  rig.game.pointer.up(1)
}

// ---------------------------------------------------------------------------
// A queued car, drawn — M1d Task 3
// ---------------------------------------------------------------------------

/**
 * **The assembly-level consequence of Decision 5's held progress: a blocked car
 * is not drawn on top of the car it is waiting for.**
 *
 * `resolve.test.ts` proves the resolver keeps `f < 1`; this proves the whole
 * pipeline does — sim, resolver, snapshots, lerp, `buildFrame`, `draw` — by
 * reading the two car sprites back out of the recorded canvas commands. It is
 * the only place in the suite where "the sim writes `carProgress = threshold`
 * while blocked" shows up as what it actually is on screen: two cars painted at
 * the same pixel.
 *
 * ---------------------------------------------------------------------------
 * EVERY TICK AND EVERY COORDINATE, HAND-COMPUTED
 * ---------------------------------------------------------------------------
 *
 * The seeded trip is this file's own: dispatch on `SEED_FIRST_PIN_TICK` = 378,
 * route NW / N / NE out of house 1 at (8, 13), scoring on 435. Thresholds are
 * 3,500 (diagonal) and 2,500 (orthogonal) against 330 a tick, and the carry
 * crosses cells, so:
 *
 * ```
 *   crossing 1  NW  ceil(3500/330)      = 11 ticks  -> tick 388, carry  130
 *   crossing 2  N   ceil((2500-130)/330)=  8 ticks  -> tick 396, carry  270
 *   crossing 3  NE  ceil((3500-270)/330)= 10 ticks  -> tick 406, carry   70
 * ```
 *
 * So the car sits on **(7, 11) from tick 396 to tick 406**, heading NE toward
 * the carpark at (8, 10). On tick **405** its progress is `270 + 9 x 330 =
 * 3,240` — one tick short. A blocker is inserted on (8, 10) at that moment, in
 * lane `LANE_OF_DIR[NE] = 0`, and from tick **406** the car is refused and
 * holds 3,240 forever after.
 *
 * `f = 3240 / 3500 = 0.9257142857...`, and `(DX, DY)` for NE is `(1, -1)`, so
 * the blocked car resolves at **(7.9257142857, 10.0742857142)** — inside its own
 * cell by 0.0743 of a cell in each axis, and the blocker is at (8, 10) exactly.
 * Under `carProgress = threshold` the blocked car resolves at (8, 10) too: the
 * same point, to the float.
 */
const BLOCK_INSERT_TICK = 405
const BLOCK_FIRST_REFUSED_TICK = 406
const BLOCK_HELD_PROGRESS = 3240
const BLOCK_F = 3240 / 3500
const BLOCKED_CELL = [7, 11] as const
const BLOCKER_CELL = [8, 10] as const
const NE_DIR = 1
/** A spare live car slot: house 0's first car, idle at tick 0 and never dispatched by this seed. */
const BLOCKER_SLOT = 0

describe('a queued car is drawn inside its own cell, not on top of the car it waits for', () => {
  it('holds 3,240 progress from tick 406 and draws 0.074 of a cell short of the blocker', () => {
    const rig = buildRig({ warmStartTicks: WARM_START_TICKS })
    const { game, ctx } = rig
    const state = game.state
    const camera = game.shell.camera
    rig.advance(0)

    // Draw the road, exactly as `runTrip` does.
    const first = PATH[0] as readonly [number, number]
    expect(game.pointer.down(1, rig.cx(first[0]), rig.cy(first[1]))).toBe(PointerOutcome.DRAG_START)
    for (let i = 1; i < PATH.length; i++) {
      const cell = PATH[i] as readonly [number, number]
      expect(game.pointer.move(1, rig.cx(cell[0]), rig.cy(cell[1]))).toBe(PointerOutcome.DRAW)
    }
    expect(game.pointer.up(1)).toBe(PointerOutcome.DRAG_END)

    while ((state.header[H_TICK] as number) < BLOCK_INSERT_TICK) rig.oneTick(ABS_ALPHA)

    // Vacuity, all of it hand-computed above and none of it read back: the car
    // is where the arithmetic says, one tick short of a crossing it is about to
    // be refused.
    const w = game.world.w
    const blockedCell = (BLOCKED_CELL[1] as number) * w + (BLOCKED_CELL[0] as number)
    const blockerCell = (BLOCKER_CELL[1] as number) * w + (BLOCKER_CELL[0] as number)
    expect(state.header[H_TICK]).toBe(BLOCK_INSERT_TICK)
    expect(state.carPhase[TRIP_CAR_SLOT]).toBe(PHASE_OUTBOUND)
    expect(state.carCell[TRIP_CAR_SLOT]).toBe(blockedCell)
    expect(state.carProgress[TRIP_CAR_SLOT]).toBe(BLOCK_HELD_PROGRESS)

    // The blocker: a real in-flight car standing on the carpark cell, holding
    // the lane a north-eastbound car needs. Reservation-free on purpose — the
    // five-tick window below contains no arrival, so nothing reads its target.
    expect(state.carPhase[BLOCKER_SLOT]).toBe(PHASE_IDLE)
    state.carPhase[BLOCKER_SLOT] = PHASE_OUTBOUND
    state.carCell[BLOCKER_SLOT] = blockerCell
    state.carRouteLen[BLOCKER_SLOT] = 4
    state.carRouteCursor[BLOCKER_SLOT] = 0
    state.carProgress[BLOCKER_SLOT] = 0
    for (let k = 0; k < 4; k++) packRouteStep(state, BLOCKER_SLOT, k, 4) // four S steps
    claimCell(state, BLOCKER_SLOT, blockerCell, NE_DIR)
    expect(LANE_OF_DIR[NE_DIR]).toBe(0)
    expect(occupantOf(state, blockerCell, 0)).toBe(BLOCKER_SLOT)
    expect(canEnter(state, game.world, TRIP_CAR_SLOT, blockerCell, NE_DIR)).toBe(
      EnterOutcome.REFUSED_OCCUPIED,
    )

    // Five frames from the first refused tick. The blocker's own progress
    // reaches its threshold on tick 413 (0 + 8 x 330 = 2,640 against 2,500), so
    // it holds the cell across the whole window — asserted, not assumed.
    const samples: { tick: number; gx: number; gy: number; bx: number; by: number }[] = []
    for (let i = 0; i < 5; i++) {
      rig.oneTick(ABS_ALPHA)
      const cars = drawnCars(ctx.log, camera.tileSize)
      // Against the sim's own count rather than a constant — see
      // `LIVE_CAR_SLOTS`. Measured: 8 across this whole five-frame window,
      // because the one house that spawns before it lands at tick 360 and this
      // window opens at 409.
      expect(cars.length).toBe(liveCarSlots(state))
      expect(cars.length, 'one house has spawned by tick 409, and none inside the window').toBe(
        LIVE_CAR_SLOTS + CARS_PER_HOUSE,
      )
      const car = cars[TRIP_CAR_SLOT] as (typeof cars)[number]
      const blocker = cars[BLOCKER_SLOT] as (typeof cars)[number]
      const toGx = (x: number) => (x - camera.tileSize / 4 - camera.originX) / camera.tileSize + camera.x0
      const toGy = (y: number) => (y - camera.tileSize / 4 - camera.originY) / camera.tileSize + camera.y0
      samples.push({
        tick: state.header[H_TICK] as number,
        gx: toGx(car.x),
        gy: toGy(car.y),
        bx: toGx(blocker.x),
        by: toGy(blocker.y),
      })
    }

    expect(samples[0]!.tick).toBe(BLOCK_FIRST_REFUSED_TICK)
    for (const s of samples) {
      // The sim held its progress: bit-identical every tick, so prev and curr
      // resolve to the same point and the lerp cannot move it either.
      expect(state.carProgress[TRIP_CAR_SLOT], `tick ${s.tick}`).toBe(BLOCK_HELD_PROGRESS)
      expect(state.carCell[TRIP_CAR_SLOT], `tick ${s.tick}`).toBe(blockedCell)
      // Drawn strictly inside its own cell, at the hand-computed point.
      expect(s.gx, `tick ${s.tick}`).toBeCloseTo((BLOCKED_CELL[0] as number) + BLOCK_F, 4)
      expect(s.gy, `tick ${s.tick}`).toBeCloseTo((BLOCKED_CELL[1] as number) - BLOCK_F, 4)
      expect(s.gx, `tick ${s.tick}`).toBeLessThan(BLOCKER_CELL[0] as number)
      expect(s.gy, `tick ${s.tick}`).toBeGreaterThan(BLOCKER_CELL[1] as number)
      // The blocker is a REAL driving car, so it drifts southward inside its
      // own cell as its own progress accumulates (route S, `f` rising 0.132 a
      // tick) — it just never crosses, because it needs 8 ticks and the window
      // is 5. Its `gx` is therefore pinned at exactly 8 while its `gy` moves,
      // which makes the x axis the clean separation to assert.
      expect(s.bx, `tick ${s.tick}`).toBeCloseTo(BLOCKER_CELL[0] as number, 4)
      expect(s.by, `tick ${s.tick}`).toBeGreaterThanOrEqual(BLOCKER_CELL[1] as number)
      // **The claim, in one line.** Under `carProgress = threshold` the blocked
      // car's `gx` is exactly 8 and this is false; under "accumulate while
      // blocked" it passes 8 on the first tick and keeps going.
      expect(s.gx, `tick ${s.tick}`).toBeLessThan(s.bx)
    }
    // The blocker really did hold the cell for the whole window: it never
    // crossed, so nothing but the refusal can be what stopped the trip car.
    expect(state.carCell[BLOCKER_SLOT]).toBe(blockerCell)
    expect(state.header[H_SCORE]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The bottleneck jams — M1d Task 9
// ---------------------------------------------------------------------------

/**
 * **The end-to-end jam: throughput collapses against a HAND-COMPUTED unblocked
 * figure, not against a recorded run.**
 *
 * The plan's requirement is that this test show a *jam*, not merely that cars
 * still arrive — and that the comparison be "against the hand-computed unblocked
 * figure named in the same clause, not against a recorded run of a fixture that
 * does not exist". So the two numbers this rests on are both derived from the
 * geometry and the crossing arithmetic, in `jamFixture.ts`'s module comment, and
 * both are module constants here:
 *
 *   - **`JAM_UNBLOCKED_TRIPS = 204`** — what the corridor would deliver in 900
 *     ticks if nothing ever blocked, summed over eight route lengths from
 *     `rel_k = ceil(k * 2500 / 330)`. Deliberately a LOWER bound: the same
 *     fixture with `canEnter`'s occupancy branch neutralised measures **206**, so
 *     204 under-states the unblocked world and `measured < 204` therefore
 *     strictly implies `measured < unblocked`.
 *   - **`JAM_CARPARK_CAPACITY_TRIPS = 112`** — `floor(900 / 8)`, what the
 *     one-lane carpark can physically pass, because every trip must claim
 *     `(carpark, LANE_OF_DIR[N] = 1)` and cannot release it for `rel_1 = 8`
 *     ticks.
 *
 * Measured: **106**. The fixture is not merely slower with blocking on — it is
 * pinned at 95 % of its bottleneck's capacity, 48 % below the unblocked figure.
 *
 * ---------------------------------------------------------------------------
 * SHAPED AS A RECORD PLUS A PREDICATE, FOR THE REASON THE TRIP TEST IS
 * ---------------------------------------------------------------------------
 *
 * Same idiom as `a full trip, drawn` above: the run is recorded once and every
 * anti-degeneracy guard is a pure predicate over that record, so the guards can
 * be run against a record that SHOULD fail them. This project nearly shipped a
 * hash of nothing in M1b, and an "it still jams" test that cannot fail is the
 * same object.
 *
 * **Three of the five guards are proved able to fail by a REAL alternative run
 * rather than by perturbing a field.** `LIGHT` is the same corridor, the same
 * code and the same guards with the load taken off — one house instead of eight
 * — and it genuinely does not jam: 8 refusals against 6,852, a longest blocked
 * run of 8 ticks against 131, a longest queue of 2 against 13, and **57 trips
 * against its own hand-computed unblocked figure of 56**, i.e. it achieves full
 * unblocked throughput and the collapse guard fires on it. A perturbed field
 * proves the predicate reads that field; a second fixture proves the guard
 * discriminates a jammed world from an unjammed one.
 */
interface JamRecord {
  readonly trips: number
  readonly dispatched: number
  readonly crossings: number
  readonly refusals: number
  /** `carBlockedTicks` IS the consecutive-blocked-tick counter — it resets on any granted entry. */
  readonly longestBlockedRun: number
  readonly longestQueue: number
  readonly maxCorridorDegree: number
  readonly ghostCells: number
  /** The hand-computed unblocked figure for THIS fixture's load. */
  readonly unblocked: number
}

const JAM_MIN_BLOCKED_RUN = 10
const JAM_MIN_QUEUE = 3
/** One house at (8, 6): route length 2, `rel_2 = 16`, `P = 32`, so `2 * (1 + floor(867/32)) = 56`. */
const LIGHT_UNBLOCKED_TRIPS = 56

function runJam(rig: ReturnType<typeof buildJamRig>, unblocked: number): JamRecord {
  let trips = 0
  let dispatched = 0
  let crossings = 0
  let refusals = 0
  let longestBlockedRun = 0
  let longestQueue = 0
  for (let t = 0; t < JAM_TICKS; t++) {
    const o = rig.drive(1)
    trips += o.trips
    dispatched += o.dispatched
    crossings += o.crossings
    refusals += o.refusals
    const q = jamQueueLength(rig)
    if (q > longestQueue) longestQueue = q
    for (let c = 0; c < rig.state.carBlockedTicks.length; c++) {
      const b = rig.state.carBlockedTicks[c] as number
      if (b > longestBlockedRun) longestBlockedRun = b
    }
  }
  let maxCorridorDegree = 0
  for (const cell of rig.corridor) {
    const mask = roadMask(rig.state, cell)
    let degree = 0
    for (let bit = 0; bit < 8; bit++) if (mask & (1 << bit)) degree++
    if (degree > maxCorridorDegree) maxCorridorDegree = degree
  }
  return {
    trips,
    dispatched,
    crossings,
    refusals,
    longestBlockedRun,
    longestQueue,
    maxCorridorDegree,
    ghostCells: jamGhostCells(rig),
    unblocked,
  }
}

/**
 * The five anti-degeneracy guards, as one predicate.
 *
 * Four are the plan's; **the fifth is not, and it was added because the first
 * fixture failed it.** A T-shaped funnel of sixteen cars jams so completely that
 * ZERO trips finish in 900 ticks, with a car blocked for 893 consecutive ticks —
 * which satisfies every one of the plan's four guards and is still the wrong
 * demonstration, because Decision 6's claim is that a gridlocked city **grinds
 * rather than stops**. A jam test that passes on a stopped city is measuring the
 * opposite of what shipped.
 */
function jamGuardFailures(r: JamRecord): string[] {
  const out: string[] = []
  if (r.dispatched <= 0) out.push('no car was dispatched')
  if (r.trips <= 0) out.push('no trip completed: the city stopped rather than ground')
  if (r.longestBlockedRun < JAM_MIN_BLOCKED_RUN) {
    out.push(`longest blocked run was ${r.longestBlockedRun}, need ${JAM_MIN_BLOCKED_RUN}`)
  }
  if (r.longestQueue < JAM_MIN_QUEUE) {
    out.push(`longest queue was ${r.longestQueue}, need ${JAM_MIN_QUEUE}`)
  }
  if (r.trips >= r.unblocked) {
    out.push(`${r.trips} trips did not fall below the hand-computed unblocked ${r.unblocked}`)
  }
  return out
}

describe('a bottleneck jams: throughput collapses below the hand-computed unblocked figure', () => {
  const jam = runJam(buildJamRig('jam-integration'), JAM_UNBLOCKED_TRIPS)

  it('completes 106 trips against a hand-computed 204 unblocked, and 112 of carpark capacity', () => {
    // The headline, stated as the two hand-computed figures rather than as a
    // ratio, so a change to either is a visible edit.
    expect(jam.trips).toBe(106)
    expect(jam.trips, 'throughput did not collapse').toBeLessThan(JAM_UNBLOCKED_TRIPS)
    // ...and MEASURABLY below, not by one trip: under three fifths of the
    // unblocked figure. Written as integer arithmetic rather than a ratio so
    // the bound is exact — 106 x 5 = 530 against 204 x 3 = 612. The actual
    // shortfall is 98 trips, 48 %.
    expect(jam.trips * 5).toBeLessThan(JAM_UNBLOCKED_TRIPS * 3)
    expect(JAM_UNBLOCKED_TRIPS - jam.trips).toBe(98)
    // The mechanism, not just the outcome: every trip claims the carpark's
    // northbound lane for at least `rel_1 = 8` ticks, so 900 ticks cannot pass
    // more than `floor(900 / 8)` cars however much demand there is.
    expect(jam.trips).toBeLessThanOrEqual(JAM_CARPARK_CAPACITY_TRIPS)
    expect(JAM_CARPARK_CAPACITY_TRIPS).toBe(Math.floor(JAM_TICKS / 8))
    // And the fixture really is running AT that bound rather than merely under
    // it — which is what makes "the bottleneck is the cause" a measurement
    // rather than a story.
    expect(jam.trips / JAM_CARPARK_CAPACITY_TRIPS).toBeGreaterThan(0.9)
  })

  it('is a straight degree-<=2 corridor, so no lane-speed multiplier is in the arithmetic', () => {
    // The hand computation above uses the plain `speedUnits(1000) = 330` for
    // every crossing. That is only true because no cell of this corridor is an
    // intersection and no step of any route is a turn — asserted, not assumed,
    // because Task 7's multipliers would silently move every figure in the table.
    expect(jam.maxCorridorDegree).toBe(2)
    expect(jam.ghostCells, 'a ghost would add a REFUSED_GHOST the refusal count does not model').toBe(0)
  })

  it('passes every anti-degeneracy jam guard', () => {
    expect(jamGuardFailures(jam)).toEqual([])
    // The figures the guards are about, pinned so a silent drift is visible.
    expect(jam.dispatched).toBe(122)
    expect(jam.refusals).toBe(6852)
    expect(jam.longestBlockedRun).toBe(131)
    // **13, and it was 10 while the probe was lane-blind.** `longestQueue` used
    // to key occupancy by the cell alone, which keeps one car per cell on a
    // board where a cell carries two lanes; on this corridor that both invented
    // chains between cars passing in opposite directions and BROKE real ones,
    // whichever car happened to be written last. Reading `(cell, lane)` — the
    // slot `canEnter` reads — moves this figure and nothing else in the run:
    // trips, dispatches, refusals and the blocked run above are all untouched,
    // because none of them goes through the probe.
    expect(jam.longestQueue).toBe(13)
  })

  it('is not vacuous: the SAME corridor with the load off fires three of the five guards', () => {
    // A real second fixture, not a perturbed field: one house instead of eight,
    // everything else identical. It does not jam, and the guards say so.
    const light = runJam(buildJamRig('jam-light', JAM_FIRST_HOUSE_Y, 1), LIGHT_UNBLOCKED_TRIPS)
    expect(light.trips).toBe(57)
    expect(light.refusals).toBe(8)
    expect(jamGuardFailures(light)).toEqual([
      `longest blocked run was 8, need ${JAM_MIN_BLOCKED_RUN}`,
      `longest queue was 2, need ${JAM_MIN_QUEUE}`,
      `57 trips did not fall below the hand-computed unblocked ${LIGHT_UNBLOCKED_TRIPS}`,
    ])
    // **The light fixture reaching its own unblocked figure is the whole point**:
    // 57 >= 56 says the corridor delivers full unblocked throughput once the
    // contention is removed, so the 106-against-204 collapse is attributable to
    // contention and not to the geometry, the pin supply or the dispatch rate.
    expect(light.trips).toBeGreaterThanOrEqual(LIGHT_UNBLOCKED_TRIPS)
  })

  it('is not vacuous: the two guards the light run cannot fire, fire on a perturbed record', () => {
    // `dispatched > 0` and `trips > 0` hold in both worlds by construction, so
    // the light fixture cannot exercise them. They are perturbed one at a time
    // from the REAL record, so each must be the only thing that fires.
    expect(jamGuardFailures({ ...jam, dispatched: 0 })).toEqual(['no car was dispatched'])
    // Note which guard does NOT fire here, because it is the interesting one:
    // a city that has stopped dead trivially satisfies "throughput fell below
    // the unblocked figure". That is exactly why the stopped-city guard had to
    // be added separately — the collapse guard cannot distinguish a grinding
    // city from a dead one, and the T-funnel fixture that produced 0 trips
    // passed the plan's four guards on the strength of it.
    expect(jamGuardFailures({ ...jam, trips: 0 })).toEqual([
      'no trip completed: the city stopped rather than ground',
    ])
    // The collapse guard, on its own: one trip above the hand-computed figure.
    expect(jamGuardFailures({ ...jam, trips: JAM_UNBLOCKED_TRIPS })).toEqual([
      `204 trips did not fall below the hand-computed unblocked ${JAM_UNBLOCKED_TRIPS}`,
    ])
    expect(jamGuardFailures({ ...jam, longestBlockedRun: JAM_MIN_BLOCKED_RUN - 1 })).toEqual([
      `longest blocked run was 9, need ${JAM_MIN_BLOCKED_RUN}`,
    ])
    expect(jamGuardFailures({ ...jam, longestQueue: JAM_MIN_QUEUE - 1 })).toEqual([
      `longest queue was 2, need ${JAM_MIN_QUEUE}`,
    ])
  })
})

// ---------------------------------------------------------------------------
// The long run — M1d Task 9
// ---------------------------------------------------------------------------

/** The plan's floor is 20,000 ticks. Measured cost of the whole block: ~1.0 s. */
const LONG_RUN_TICKS = 20000

/**
 * **20,000 drives on a deliberately bad network, with every invariant checked on
 * every tick — and two identical runs agreeing on `hashState`.**
 *
 * ---------------------------------------------------------------------------
 * ALL 20,000 OF THEM ARE LIVE, AND KEEPING THEM THAT WAY COST ONE MAP
 * PARAMETER — M1e TASK 8
 * ---------------------------------------------------------------------------
 *
 * §5.8 made a badly-run city fatal, and this fixture is a badly-run city by
 * design — so for one commit it lost, at tick 7,223, and 12,778 of these drives
 * became byte-identical no-ops. **Every invariant this sweep checks is a SAFETY
 * property, and a frozen buffer satisfies all of them trivially**: occupancy
 * stays sound, the reservation sum keeps matching, no counter wraps and no car
 * starves any further. So the sweep would have gone on passing while asserting
 * nothing over nearly two thirds of its horizon.
 *
 * **The cause was never the jam.** `jamFixture` holds `destPins[0]` at 255, so
 * every scheduled colour-0 pin overflows onto the first same-colour destination
 * with room — and since M1e Task 5 those were the three the SPAWNER placed. A
 * spawned destination's carpark is road-free by construction
 * (`canPlaceDestination` rejects a road on any of a candidate's seven cells) on
 * a board where nothing ever lays another road, so it is never a flow-field
 * source, is never dispatched to, and **receives zero arrivals for the whole
 * run**. Its meter is monotone from its first over-capacity tick. That is
 * `firstCity`'s D2 mechanism exactly — *unreachable*, not merely deprioritised —
 * reproduced inside a test fixture by a spawner that is not connectivity-aware.
 * **Destination 0, the real one, was never close**: served roughly every 8.5
 * ticks against a survivability boundary of 90, its meter peaks at **79,962**
 * against a threshold of 2,640,000.
 *
 * **The fix is `buildJamRig`'s `maxDestinations`, 4 -> 1**, which is M1e Task 5
 * Step 12's declined option (b) applied to one parameter rather than two.
 * `maxHouses` stays at 16 deliberately, so the HOUSE spawner still runs and
 * still places one — the fixture keeps live spawner coverage, it only stops
 * being handed destination slots it cannot use.
 *
 * **What it costs, and it is a trade rather than a free win.** The sweep gives
 * up *"the spawner placed 3 provably-inert destinations over a long horizon"*.
 * That is coverage this file's own note below already concedes is held better
 * by `sim/test/spawn.test.ts`'s corridor rig, which wires each new building as
 * it appears and puts 24 spawned cars on the road. What it buys back is
 * **12,778 ticks of live invariant checking** and the exact pre-Task-8 figures:
 * `valves` **98**, `minCompletions` **2**, `maxBlocked` at the threshold,
 * `maxReserved` **24**.
 *
 * **This decision was declined once on a READING and then measured.** The first
 * pass rejected the lever because "changing `buildJamRig`'s map parameters moves
 * every other fixture built on it". Measured, capping only `maxDestinations`
 * breaks **exactly one test** — this one's own death assertions, which simply
 * revert. `queueProbe.test.ts`, `allocation.test.ts` and this file's other jam
 * cases all pass untouched, and nothing outside `packages/game` imports the
 * fixture at all. A blast-radius claim is a measurement, not a reading.
 *
 * The network is deliberately bad in a specific, named way rather than merely
 * busy: `JAM_STARVED_*` puts **twelve** houses on the corridor with the first
 * one hard against the carpark at (8, 5), so its cars are starved by through
 * traffic and `carBlockedTicks` actually saturates. **That is the only place in
 * the repo where the valve fires through `runMovement`** — `blocking.test.ts`
 * reaches `ENTER_VALVE` on a hand-built ring, and every profiled window in
 * `allocation.test.ts` measures zero valve firings. Here it fires **98 times**.
 *
 * What each assertion is for, since four of the five are checked 20,000 times
 * and a reader should not have to infer which failure each would catch:
 *
 *   - **`assertOccupancySound` every tick** — a slot naming a car that is not
 *     standing there. It is the half with no exception set, so it can be
 *     asserted unconditionally; completeness cannot, because the valve fires
 *     here and Decision 6's transient gap is a legitimate consequence of that.
 *   - **`sum(destReserved) === count(PHASE_OUTBOUND)` every tick** — M1c's
 *     reservation invariant, and the observer for "a blocked car consumes its
 *     pin", which the plan records as holding by construction.
 *   - **no counter wraps** — `carBlockedTicks` is `Int16` and saturates at
 *     `MAX_BLOCKED_TICKS`; `destReserved`/`destPins` are `Uint8`. A wrap on the
 *     first is a permanently disarmed valve, on the second a destination
 *     excluded from dispatch forever.
 *   - **no car starves** — every live car completes at least one trip. This is
 *     the assertion the valve exists to make true, and it is measured against
 *     the LIVE cars only: `maxCars` is 32 and twelve houses fill 24 slots, so
 *     the eight `PHASE_NONE` slots would otherwise make "some car never
 *     completed a trip" true by construction. (It did, on the first draft of
 *     this test — `minCompletions` read 0 until the dead slots were excluded.)
 *   - **two runs agree on `hashState`** — the property the whole product rests
 *     on, over a run in which cars block, queue, starve and valve.
 */
describe('20,000 LIVE drives on a deliberately bad network', () => {
  it('starves nobody, wraps nothing, holds both invariants every tick, and replays identically', () => {
    const rig = buildJamRig('long-run', JAM_STARVED_FIRST_HOUSE_Y, JAM_STARVED_HOUSE_COUNT)
    expect(rig.state.header[H_TICK], 'the rig arrives one tick in, which is what 7,223 is offset by').toBe(1)
    const carCount = rig.state.carPhase.length
    const completions = new Int32Array(carCount)
    const prevPhase = new Int32Array(carCount)
    const live: number[] = []
    for (let c = 0; c < carCount; c++) {
      prevPhase[c] = rig.state.carPhase[c] as number
      if (prevPhase[c] !== PHASE_NONE) live.push(c)
    }
    expect(live.length).toBe(JAM_STARVED_HOUSE_COUNT * 2)
    expect(live.length).toBeLessThan(carCount) // ...so the dead-slot exclusion is load-bearing

    let valves = 0
    let maxBlocked = 0
    let maxReserved = 0
    let reservationMismatches = 0
    /**
     * The high-water mark of every destination's overcrowd meter, tracked on
     * every tick rather than read at the end. **This is the precondition the
     * whole horizon rests on**, and reading it only at the end would miss a
     * meter that climbed and unwound — which is exactly the shape a future
     * change to the pin cadence would produce.
     */
    let peakMeter = 0
    for (let t = 0; t < LONG_RUN_TICKS; t++) {
      valves += rig.drive(1).valves
      const destCount = rig.state.header[H_DEST_COUNT] as number
      for (let d = 0; d < destCount; d++) {
        const m = rig.state.destOvercrowd[d] as number
        if (m > peakMeter) peakMeter = m
      }
      // Soundness, unconditionally, on every one of the 20,000 ticks. Throws by
      // name rather than returning, so a failure names the cell and the car.
      assertOccupancySound(rig.state, rig.world)
      let outbound = 0
      for (let c = 0; c < carCount; c++) {
        const phase = rig.state.carPhase[c] as number
        if (phase === PHASE_OUTBOUND) outbound++
        if ((prevPhase[c] as number) === PHASE_RETURNING && phase === PHASE_IDLE) {
          completions[c] = (completions[c] as number) + 1
        }
        prevPhase[c] = phase
        const blocked = rig.state.carBlockedTicks[c] as number
        // A wrap on an Int16 counter shows up as a negative, which is the only
        // way saturation can fail silently.
        if (blocked < 0) throw new Error(`carBlockedTicks[${c}] wrapped to ${blocked} on tick ${t}`)
        if (blocked > maxBlocked) maxBlocked = blocked
      }
      let reserved = 0
      for (let d = 0; d < rig.state.destReserved.length; d++) {
        const r = rig.state.destReserved[d] as number
        reserved += r
        if (r > maxReserved) maxReserved = r
      }
      if (reserved !== outbound) reservationMismatches++
    }

    // ---------------------------------------------------------------------
    // **LIVENESS FIRST, because every figure below is a safety property and a
    // frozen buffer satisfies all of them.** Occupancy stays sound, the
    // reservation sum keeps matching, no counter wraps and no car starves any
    // further — so a sweep that froze at tick 7,223 would report exactly the
    // same greens over 12,778 ticks of nothing. With these lines at the FOOT of
    // the test a shortened horizon fails on `minCompletions` or `valves`,
    // numbers that look like traffic and are really the horizon; here it fails
    // on the meter, which is the cause.
    //
    // The METER rather than only the flag: a meter that climbs and unwinds
    // never sets the flag, and it is the tick before the flag that says the
    // margin has gone.
    // ---------------------------------------------------------------------
    expect(isGameOver(rig.state), 'this sweep must run 20,000 LIVE drives').toBe(false)
    expect(rig.state.header[H_TICK], 'the rig arrives one tick in, so 20,000 drives end at 20,001').toBe(
      LONG_RUN_TICKS + 1,
    )
    // 79,962 measured against a threshold of 2,640,000 — a 33x margin, stated
    // as a figure rather than as an adjective. Destination 0 is over its
    // trigger cap for essentially the whole run and is served far faster than
    // the 90-tick survivability boundary, which is why it never gets close.
    expect(peakMeter, 'a meter got within 10x of the shutdown — the horizon is at risk').toBeLessThan(
      OVERCROWD_FAIL_MILLITICKS / 10,
    )
    expect(peakMeter, 'and it is not vacuously zero: the meter really does run here').toBeGreaterThan(
      0,
    )

    expect(reservationMismatches, 'sum(destReserved) !== count(PHASE_OUTBOUND)').toBe(0)

    // No car starves. Asserted over the live set, and the minimum is reported
    // rather than a bare `every`, so a near-miss is legible.
    let minCompletions = Infinity
    let worst = -1
    for (const c of live) {
      const n = completions[c] as number
      if (n < minCompletions) {
        minCompletions = n
        worst = c
      }
    }
    expect(minCompletions, `car ${worst} completed the fewest trips`).toBeGreaterThan(0)
    expect(minCompletions).toBe(2)

    // No counter wraps. `carBlockedTicks` saturates at exactly the threshold —
    // never above it, which is what makes the width question unaskable at any
    // run length — and both Uint8 counters stay well inside 255.
    expect(maxBlocked).toBe(MAX_BLOCKED_TICKS)
    expect(maxReserved).toBeLessThan(255)
    expect(maxReserved).toBe(24)

    // The valve genuinely fired, so the run exercised the branch it is here for
    // rather than merely surviving 20,000 quiet ticks.
    expect(valves, 'the valve never fired, so this is not the bad network it claims to be').toBe(98)

    // ---------------------------------------------------------------------
    // **THE SPAWNER'S HALF OF THIS FIXTURE, AND WHAT M1e TASK 5 STEP 12 GOT
    // RIGHT AND WRONG ABOUT IT.**
    //
    // Step 12 chose (a) — let this fixture spawn freely — over (b) — cap its
    // `maxHouses`/`maxDestinations` to the built counts — on the argument that
    // (b) "gives up the only long-horizon invariant coverage the spawner will
    // ever get". Two corrections, one per milestone.
    //
    // **The first, from Task 5's own review**: what this sweep covered was
    // placement over a long horizon and nothing downstream of it. Every
    // destination the spawner placed was inert — sourceless, never dispatched
    // to, no spawned car ever moved — so `assertOccupancySound` never saw one.
    // The gap that claim papered over is closed elsewhere, by
    // `sim/test/spawn.test.ts`'s *"drives cars from SPAWNED houses for 20,000
    // ticks with assertOccupancySound on every one"*: a corridor rig that wires
    // each new building as it appears and puts **24 spawned cars** on the road.
    //
    // **The second, from M1e Task 8: "inert" was true of MOVEMENT and false of
    // the overcrowd meter.** §5.8 does not care whether a queue goes unserved
    // by bad luck or by unreachability. A spawned destination's pins accumulate
    // from `destPins[0]`'s overflow, its meter is monotone, and it ended this
    // run at tick 7,223 — costing the sweep 64 % of its live horizon for a
    // property nothing here was measuring. **Nothing in this file is "inert"
    // until it has been re-checked against the phase list as it stands today**,
    // which is the general form of a mistake this paragraph has now made twice.
    //
    // **So (b) is now taken, on ONE parameter.** `maxDestinations` 4 -> 1 stops
    // the destination spawner; `maxHouses` stays 16 against 12 built, so the
    // HOUSE spawner still runs and still places one, and the fixture keeps a
    // live spawner on the tick for the whole 20,000. The trade is the inert
    // placement coverage above, which `spawn.test.ts` holds better, for 12,778
    // ticks of live invariant checking.
    //
    // **And the five M1d figures are back to their exact pre-Task-8 values** —
    // valves 98, minCompletions 2, maxReserved 24, maxBlocked at the threshold,
    // zero reservation mismatches — which is the check that says this fixture
    // is the one those numbers were derived on and not a new board wearing its
    // name.
    // ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // **The spawner is still live on this board — it just has nowhere to put a
    // destination.** `maxDestinations` is 1, so the destination spawner refuses
    // every attempt; `maxHouses` is 16 against 12 built, so the HOUSE spawner
    // still runs and still places one. Keeping that half is why only one map
    // parameter moved rather than two.
    // ---------------------------------------------------------------------
    expect(rig.state.header[H_DEST_COUNT], 'the board is capped at its one built destination').toBe(
      1,
    )
    expect(
      rig.state.header[H_HOUSE_COUNT],
      'but the house spawner is still live and still placed one',
    ).toBeGreaterThan(JAM_STARVED_HOUSE_COUNT)
    expect(rig.state.header[H_HOUSE_COUNT]).toBe(13)
    // The pin poke is doing its job — without it the corridor is not loaded and
    // every figure above is about a quiet board.
    expect(rig.state.destPins[0] as number, 'the corridor is still saturated with demand').toBe(85)

    // Two identical runs agree, byte for byte, over the whole buffer.
    const second = buildJamRig('long-run', JAM_STARVED_FIRST_HOUSE_Y, JAM_STARVED_HOUSE_COUNT)
    second.drive(LONG_RUN_TICKS)
    expect(hashState(second.state)).toBe(hashState(rig.state))
    // **Deliberately NOT pinned to a literal.** The requirement is that two
    // runs agree, and pinning the absolute digest would mint an eighth
    // golden-shaped number that this milestone's "seven goldens, none of which
    // may move" bookkeeping does not account for — a re-bless licence nobody
    // authorised. What the equality needs instead is a guard against comparing
    // two copies of nothing: the digest must differ from a fresh, untouched
    // state of the same shape, or `toBe` would pass on a run that never ran.
    const fresh = buildJamRig('long-run', JAM_STARVED_FIRST_HOUSE_Y, JAM_STARVED_HOUSE_COUNT)
    expect(hashState(rig.state)).not.toBe(hashState(fresh.state))
  })
})

// ---------------------------------------------------------------------------
// The layout switch, through the real boot path
// ---------------------------------------------------------------------------

/**
 * `layouts.test.ts` tests the registry and `layoutSelect.test.ts` tests the
 * token; this is the only place the two meet `createGame` and a real frame.
 *
 * The important half is the NEGATIVE one: a build that can open a second board
 * must not have changed the first, and "the goldens still hold" is a claim
 * about `hashState`, not about the assembled game.
 */
describe('createGame opens the layout it was asked for', () => {
  it('opens the DEMO board when the launch names nothing — no token, no city', () => {
    // **The end-to-end half of the default, through the real `createGame`.**
    // `layouts.test.ts` pins the constant; this is the only place that runs a
    // whole boot with `layoutId` absent, which is what every plain load and
    // every Telegram open with no `startapp` does.
    //
    // `layoutId: undefined` is written out rather than omitted so the rig's
    // `in` check sees it — omitting it means "the city", which is what the
    // other 17 cases in this file want and this one must not get.
    const rig = buildRig({ layoutId: undefined })
    expect(rig.game.layoutId).toBe(DEFAULT_LAYOUT_ID)
    expect(rig.game.layoutId).toBe('demo')
    expect(rig.game.world.map.id).toBe('demoCity')
    expect(rig.game.warmStartTicks).toBe(DEMO_WARM_START_TICKS)
    expect(rig.game.state.header[H_TICK] as number).toBe(DEMO_WARM_START_TICKS)
    expect(rig.game.state.header[H_HOUSE_COUNT] as number).toBe(12)
    expect(rig.game.state.header[H_DEST_COUNT] as number).toBe(18)
    expect(rig.game.state.carPhase.length).toBe(24)
    // **And the board it is NOT.** Each of the four above is satisfied by the
    // demo entry alone, so none of them would notice the city coming back if a
    // future edit gave the two entries the same map. The city's own numbers are
    // the discriminator, and they are asserted as absences here and as
    // presences in the case below.
    expect(rig.game.world.map.id).not.toBe('firstCity')
    expect(rig.game.warmStartTicks).not.toBe(WARM_START_TICKS)
  })

  it('opens the starting city on layoutId "city" — still reachable, still today’s board', () => {
    // The board that used to be the default. It is not deleted and it is not
    // degraded: same map, same warm start, same three houses and six cars, one
    // token away. `startingCity.test.ts` holds its seed golden; this holds the
    // assembled boot.
    const rig = buildRig({ layoutId: CITY_LAYOUT_ID })
    expect(rig.game.layoutId).toBe('city')
    expect(rig.game.world.map.id).toBe('firstCity')
    expect(rig.game.warmStartTicks).toBe(WARM_START_TICKS)
    expect(rig.game.state.header[H_TICK] as number).toBe(WARM_START_TICKS)
    // Three houses, three destinations, six cars — the board the player called
    // "the same demo", unchanged by the default moving off it.
    expect(rig.game.state.header[H_HOUSE_COUNT] as number).toBe(3)
    expect(rig.game.state.header[H_DEST_COUNT] as number).toBe(3)
    // `carPhase` is sized by the MAP (`CARS_PER_HOUSE * maxHouses`), not by the
    // seed: `firstCity` allows 40 houses, so 80 slots of which 6 are live.
    expect(rig.game.state.carPhase.length).toBe(80)
    // ...and it is what the rig hands back with no board named, which is what
    // keeps the other 17 cases in this file measuring the city.
    expect(buildRig().game.layoutId).toBe('city')
  })

  it('opens the demo board on layoutId "demo", already busy on the first frame', () => {
    const rig = buildRig({ layoutId: 'demo' })
    expect(rig.game.layoutId).toBe('demo')
    expect(rig.game.world.map.id).toBe('demoCity')
    expect(rig.game.warmStartTicks).toBe(DEMO_WARM_START_TICKS)
    expect(rig.game.state.header[H_TICK] as number).toBe(DEMO_WARM_START_TICKS)
    expect(rig.game.state.header[H_HOUSE_COUNT] as number).toBe(12)
    expect(rig.game.state.header[H_DEST_COUNT] as number).toBe(18)
    expect(rig.game.state.carPhase.length).toBe(24)

    // The claim the whole task rests on, asserted on the FRAME rather than on
    // the state: the first thing drawn already has most of the fleet moving.
    let inFlight = 0
    for (let c = 0; c < rig.game.state.carPhase.length; c++) {
      const phase = rig.game.state.carPhase[c] as number
      if (phase === PHASE_OUTBOUND || phase === PHASE_RETURNING) inFlight++
    }
    expect(inFlight).toBeGreaterThanOrEqual(15)
    rig.oneTick(0)
    const frame = rig.game.builder.frame
    expect(frame.carCount).toBeGreaterThanOrEqual(15)
    expect(frame.destCount).toBe(18)
  })

  it('draws the demo board — the real draw path, not just the state', () => {
    // The catalogue's "a green harness is a claim about the inputs it was
    // given": every render test in the repo runs on `firstCity`, and a
    // 24-car / 18-destination board is the first thing to exceed both of that
    // map's limits. A throw or a silent truncation here is a shipped blank
    // screen on the demo link.
    const rig = buildRig({ layoutId: 'demo' })
    rig.oneTick(0)
    expect(rig.ctx.log.length).toBeGreaterThan(0)
    // Roads are blitted from the atlas; cars, houses and destinations are
    // filled in their group colour. Both are asserted by name, because the
    // terrain fold alone would leave the log non-empty and every one of these
    // could be missing behind it.
    expect(rig.ctx.log.some((c) => c.op === 'blit'), 'roads blitted').toBe(true)
    const groupFills = new Set(
      rig.ctx.log
        .filter((c): c is Extract<Command, { op: 'fill' }> => c.op === 'fill')
        .map((c) => c.style)
        .filter((style) => (PALETTE.groups as readonly string[]).includes(style)),
    )
    expect(groupFills.size, 'all three colour groups drawn').toBe(3)
  })

  it('seeds the RNG from the LAYOUT’s own seed, not the shipped city’s', () => {
    // `createState` mixes the seed string into `rngState`, which is inside the
    // hashed buffer, so this is observable even though nothing in a warm start
    // draws a random number. Without it, `layout.runSeed` has no detector at
    // all: measured at 0 across the whole suite, because the two layouts differ
    // in map and seeder as well and every other assertion is satisfied by those.
    const own = buildRig({ layoutId: 'demo' })
    const forced = buildRig({ layoutId: 'demo', seed: RUN_SEED })
    expect(own.game.state.header[H_TICK]).toBe(forced.game.state.header[H_TICK])
    expect(hashState(own.game.state)).not.toBe(hashState(forced.game.state))
  })

  it('snapshots the cars AFTER the warm start, not before it', () => {
    // **`main.ts` says this ordering stopped being an equivalence when the demo
    // layout landed, and that sentence needed a detector or it was the
    // catalogue's "overstated comment that discharges an obligation".** Moving
    // `initCarSnapshots` above the warm-start loop was measured at 0 detectors
    // before this test existed.
    //
    // On the shipped city the two orderings really are identical — no road, so
    // no car moves during the ramp. On the demo board 24 cars are dispatched,
    // routed and moving from tick 178 of a 1,200-tick ramp, so a snapshot taken
    // first holds every car at its house and frame 1 lerps the whole fleet
    // across a thousand ticks of motion.
    const rig = buildRig({ layoutId: 'demo' })
    const snap = rig.game.builder.snapshots
    const state = rig.game.state
    const w = rig.game.world.w
    let live = 0
    let awayFromHome = 0
    for (let i = 0; i < snap.slots; i++) {
      if ((snap.currLive[i] as number) === 0) continue
      live++
      const cell = state.carCell[i] as number
      // The snapshot is a fractional grid position; a car mid-crossing is up to
      // one cell from its `carCell`, and no further.
      expect(Math.abs((snap.currXY[i * 2] as number) - (cell % w)), `car ${i} x`).toBeLessThanOrEqual(1)
      expect(
        Math.abs((snap.currXY[i * 2 + 1] as number) - ((cell / w) | 0)),
        `car ${i} y`,
      ).toBeLessThanOrEqual(1)
      // `prev` and `curr` are written from the same state, so frame 1 does not
      // lerp at all.
      expect(snap.prevXY[i * 2]).toBe(snap.currXY[i * 2])
      expect(snap.prevXY[i * 2 + 1]).toBe(snap.currXY[i * 2 + 1])
      if (cell !== (state.houseCell[state.carHome[i] as number] as number)) awayFromHome++
    }
    // Non-vacuity, and it is the whole test: the bound above is satisfied
    // trivially by a car that never left home, which is exactly the state the
    // wrong ordering would snapshot.
    expect(live).toBeGreaterThanOrEqual(20)
    expect(awayFromHome).toBeGreaterThanOrEqual(15)
  })

  it('REFUSES an unknown layoutId at boot rather than opening the default board', () => {
    // A silently-defaulting typo is indistinguishable from "the demo link does
    // not work", which is the report this whole task exists to answer.
    expect(() => buildRig({ layoutId: 'demoo' })).toThrow(/unknown layout "demoo"/)
  })

  it('treats an empty layoutId as absent, so a half-copied link still boots', () => {
    // `?layout=` and `#tgWebAppStartParam=` both parse to `''`. It must land on
    // the default rather than on `layoutFor('')`'s throw — and on the SAME
    // board as no token at all, which is the half a bare `.toBe('demo')` would
    // not say.
    expect(buildRig({ layoutId: '' }).game.layoutId).toBe(DEFAULT_LAYOUT_ID)
    expect(buildRig({ layoutId: '' }).game.layoutId).toBe('demo')
    expect(buildRig({ layoutId: '' }).game.layoutId).toBe(
      buildRig({ layoutId: undefined }).game.layoutId,
    )
  })
})

// ---------------------------------------------------------------------------
// The boot failure surface — the throw above, seen from the phone
// ---------------------------------------------------------------------------

/**
 * **The test above asserts that boot THROWS. This file's other 41 tests then
 * say nothing whatsoever about what a player sees when it does** — and the
 * answer, before this section existed, was a black screen with no way back.
 *
 * `if (shouldAutoStart()) startGame()` sits at module scope, so the throw
 * propagates out of the module's own evaluation: no canvas sizing, no pointer
 * wiring, no erase control, no visibility handler, no message. Reachable by a
 * link a third party can send, because `layoutToken` reads `location.hash` and
 * `https://<app>/#tgWebAppStartParam=x` is a well-formed unknown token. Inside a
 * Telegram webview there is no console and no address bar.
 *
 * So every case below asserts **the surface appears and says something usable**,
 * never merely that the function threw. The one thing that still has no Node-side
 * detector is `createBootFailureSurface`'s two `document` calls, which is the
 * same irreducible gap as `createCanvasSurface` and `createFallbackButton`:
 * there is no `document` here to create anything in.
 */
interface BootSurface extends BootFailureElement {
  readonly attributes: Map<string, string>
}

function bootSurface(): BootSurface {
  const attributes = new Map<string, string>()
  return {
    textContent: null,
    attributes,
    setAttribute(name: string, value: string): void {
      attributes.set(name, value)
    },
  }
}

/**
 * Swallows `console.error` for one call and hands back what it was given.
 *
 * Not decoration: `startOrReport` logging the stack is the developer half of the
 * contract, so the capture is asserted rather than discarded — and without it
 * every run of this file prints a real-looking stack trace into a green suite.
 */
function captureErrors<T>(run: () => T): { result: T; logged: unknown[] } {
  const original = console.error
  const logged: unknown[] = []
  console.error = (...args: unknown[]): void => {
    logged.push(...args)
  }
  try {
    return { result: run(), logged }
  } finally {
    console.error = original
  }
}

// ---------------------------------------------------------------------------
// The board stops dead — what a player actually sees (M1e Task 8)
// ---------------------------------------------------------------------------

/**
 * **The milestone's observability line, driven end to end through the real
 * loop.** Nothing draws a shutdown screen yet — Task 9 owns that — so what a
 * player gets on the default board, unprompted, partway through the fourth
 * minute, is the board *stopping dead*. This test is what says so, on the
 * production path: `createGame` with no layout token, real frames, the real
 * draw path.
 *
 * ---------------------------------------------------------------------------
 * THE DRAWN CARS DO NOT SETTLE ONTO THEIR SIM POSITIONS, AND THE TASK BRIEF
 * SAID THEY WOULD
 * ---------------------------------------------------------------------------
 *
 * The brief's own observability paragraph predicted that "the frozen cars settle
 * onto their exact sim positions rather than stopping mid-stride… the drawn
 * position converges to it monotonically and exactly — measured at three ticks".
 * **Measured on this rig: it does not converge at all.** The reasoning was right
 * about `resolve.ts` and wrong about the loop. `advanceDraw` — the speed-limited
 * chase — is advanced inside `snapshotCurr`, which the driver calls from
 * `afterDrain`, which `loop.frame` only reaches when a drain actually ran. And
 * `onGameOver` calls `loop.end()`, which pauses. So the drain stops on the same
 * frame the sim freezes, the chase is never advanced again, and every car stops
 * wherever the lerp had it.
 *
 * That is the difference between "the rAF loop keeps running" — true, `onFrame`
 * re-arms unconditionally and `render` is still called every frame — and "the
 * loop keeps draining", which is false. Only the second one advances anything.
 *
 * **What is actually true is the half that matters to a player, and it is
 * stronger**: the drawn frame is *bit-identical* from then on, over frames of
 * varying length. There is no jitter, no drift and no slow settle; the picture
 * is a still image. The cars stop a fraction of a cell short of where the sim
 * says they are — **0.0886 cells** driving even 33.4 ms frames and **0.2200**
 * through this rig's cadence, since `alpha` freezes wherever the last frame left
 * it — and nothing on screen is drawn against the sim position, so there is
 * nothing to compare it to. Both are well inside a cell's 0.5 half-width, so
 * every frozen car is still on its own road.
 *
 * **That residual is pre-existing rather than something the freeze introduces**,
 * and it is worth the sentence because `resolve.ts` claims "no car is ever drawn
 * more than 0.2 cells from where the sim says it is". `MAX_DRAW_LAG_CELLS`
 * bounds `drawCurrXY` against `currXY` at a drain boundary; the frame is a lerp
 * between `drawPrevXY` and `drawCurrXY`, so against the CURRENT sim position it
 * can sit further back. Measured on a LIVE demo board over 4,000 frames the
 * worst case is **0.2632 cells**, larger than anything the freeze produces. The
 * freeze makes a transient permanent, at a smaller value — it does not widen
 * the band.
 */
describe('the demo board stops dead, and stays a still image', () => {
  it('freezes at 3 min 43 s and draws a bit-identical frame forever after', () => {
    // `layoutId: undefined` reaches `createGame` with the property genuinely
    // absent — see `buildRig`'s note — so this is what a player who taps the
    // bot link with no parameters gets. If Task 10 flips the default, this test
    // follows it and the tick has to move with it.
    const rig = buildRig({ layoutId: undefined })
    expect(rig.game.layoutId, 'this must be whatever a plain launch opens').toBe(DEFAULT_LAYOUT_ID)

    let frames = 0
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
    }

    // It ended, on the measured tick, unprompted and with no input of any kind.
    expect(isGameOver(rig.game.state), 'the default board must end a run on its own').toBe(true)
    expect(rig.game.state.header[H_TICK]).toBe(DEMO_DEATH_TICK)
    expect(Math.round(DEMO_DEATH_TICK / 30), 'which is 223 s — 3 min 43 s at 30 Hz').toBe(223)
    // The loop followed, and it cannot be talked out of it.
    expect(rig.game.loop.over).toBe(true)
    expect(rig.game.loop.paused).toBe(true)
    rig.game.loop.setPaused(false)
    expect(rig.game.loop.paused, 'a clock tap must not resume a dead sim').toBe(true)

    // The picture, which is the observable. Frames of DIFFERENT lengths, so a
    // residual accumulator or a live `alpha` would show up as movement.
    const drawn = (): string =>
      Array.from(
        rig.game.builder.frame.carXY.slice(0, rig.game.builder.frame.carCount * 2),
      ).join(',')
    rig.advance(TICK_MS)
    const still = drawn()
    rig.ctx.log = []
    for (let k = 0; k < 60; k++) rig.advance(20 + (k % 7) * 5)
    expect(drawn(), 'the board is a still image, not a slow settle').toBe(still)
    expect(rig.game.loop.ticksLastFrame, 'and no tick ran').toBe(0)
    // ...while the draw path is still running, which is what lets Task 9 put a
    // screen on top of it. A frozen board that stopped DRAWING would be a black
    // rectangle, and this is the line that separates the two.
    expect(
      rig.ctx.log.filter((c) => c.op === 'blit').length,
      'rAF is never cancelled — the frame path stays live',
    ).toBeGreaterThan(0)
    expect(rig.game.builder.frame.carCount, 'the cars are still on the board, not removed').toBe(24)
    expect(rig.game.builder.frame.paused, 'and the frame knows it').toBe(true)

    // The cars stopped SHORT of their sim positions rather than settling onto
    // them — see the block comment. Asserted as a measured band rather than as
    // convergence, because convergence is what the brief predicted and it is
    // not what happens.
    const snaps = rig.game.builder.snapshots
    let worst = 0
    let n = 0
    for (let i = 0; i < snaps.slots; i++) {
      if ((snaps.currLive[i] as number) === 0) continue
      worst = Math.max(
        worst,
        Math.hypot(
          (rig.game.builder.frame.carXY[n * 2] as number) - (snaps.currXY[i * 2] as number),
          (rig.game.builder.frame.carXY[n * 2 + 1] as number) - (snaps.currXY[i * 2 + 1] as number),
        ),
      )
      n++
    }
    // **Bounded by a derivation, not by whichever number this cadence happens to
    // produce.** The frame is a lerp between `drawPrevXY` and `drawCurrXY`, and
    // `alpha` freezes at whatever the last frame left — so the residual depends
    // on the frame cadence at the instant of death, and a literal here would be
    // a property of this rig's `advance` rather than of the code. Measured:
    // **0.0886** cells driving even 33.4 ms frames, **0.2200** through this
    // rig's cadence. The bound that holds for both is
    // `MAX_DRAW_LAG_CELLS + MAX_SIM_CELLS_PER_TICK` = 0.3333: `drawCurrXY` is
    // within the lag of the sim position at its own drain, `drawPrevXY` is the
    // previous drain's `drawCurrXY`, and the sim moved at most one tick of
    // travel in between.
    expect(worst, 'the drawn cars did NOT converge onto the sim positions').toBeGreaterThan(0)
    expect(worst, 'and they are bounded by one lag plus one tick of travel').toBeLessThan(
      MAX_DRAW_LAG_CELLS + MAX_SIM_CELLS_PER_TICK,
    )
    // The property that actually matters, and the reason none of this is
    // visible: a cell's half-width is 0.5, so every frozen car is still drawn
    // on its own road rather than beside it.
    expect(worst, 'a frozen car is still on the road').toBeLessThan(0.5)

    // ---------------------------------------------------------------------
    // **And the whole reason `end()` is sticky: the grid is shut.**
    // ---------------------------------------------------------------------
    // `pointer.ts` refuses board input while paused and by nothing else, so a
    // resume would re-open `HitRegion.GRID` on a dead sim and the player would
    // draw roads that never appear, spend no tiles and get no message. This is
    // the end-to-end consequence of `loop.end()` rather than a restatement of
    // it: a real `pointerdown` on a real board cell, through the real pointer
    // machine, after a real shutdown — and it is refused for the RIGHT reason,
    // named by the outcome code rather than inferred from an empty queue.
    // ---------------------------------------------------------------------
    // **The grid is shut, and there is now a way out — M1e Task 9.**
    // ---------------------------------------------------------------------
    // Until this task a tap did nothing at all: the board was frozen, input was
    // refused, no message was drawn, and closing the app was the only exit.
    // Now every tap asks for a new run, named by its own outcome code rather
    // than inferred from an empty queue.
    const before = rig.game.queue.inputs.actions.length
    expect(rig.game.pointer.down(1, rig.cx(9), rig.cy(20))).toBe(
      PointerOutcome.RESTART_REQUESTED,
    )
    expect(rig.restarts, 'one tap, one new run').toBe(1)
    // The drag never started, so the move and the up are the no-ops they should
    // be and nothing reaches the queue on a dead board.
    rig.game.pointer.move(1, rig.cx(9), rig.cy(21))
    rig.game.pointer.up(1)
    expect(rig.game.queue.inputs.actions.length, 'and nothing reached the queue').toBe(before)
    expect(rig.game.pointer.dragging).toBe(false)
  })

  it('draws the shutdown screen the player actually reads, on the board that ships', () => {
    // **The acceptance criterion, end to end, on the default board with no
    // input of any kind.** Every prior task in this milestone could honestly
    // answer "a human sees nothing"; this is the case that makes that false.
    const rig = buildRig({ layoutId: undefined })
    expect(rig.game.layoutId).toBe(DEFAULT_LAYOUT_ID)
    let frames = 0
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
    }
    expect(rig.game.state.header[H_TICK]).toBe(DEMO_DEATH_TICK)

    rig.ctx.log = []
    rig.advance(TICK_MS)
    const frame = rig.game.builder.frame
    expect(frame.gameOver, 'the frame must be able to SAY the run ended').toBe(true)
    const failed = frame.failedDest
    expect(failed, 'and which destination did it').toBeGreaterThanOrEqual(0)

    // 1. The board goes dark: one scrim fill, over the grid rect, not into the
    //    HUD band.
    const camera = rig.game.shell.camera
    const scrims = rig.ctx.log.filter(
      (c): c is FillCommand => c.op === 'fill' && c.style === PALETTE.scrim,
    )
    expect(scrims.length, 'exactly one scrim').toBe(1)
    const scrim = scrims[0] as FillCommand
    expect(scrim.y).toBeLessThanOrEqual(camera.originY)
    expect(scrim.y + scrim.h).toBeGreaterThanOrEqual(camera.originY + camera.rows * camera.tileSize)
    expect(scrim.y + scrim.h, 'the HUD stays legible').toBeLessThanOrEqual(camera.hudTop)

    // 2. It says which destination, how many trips, and how to start again —
    //    read off the commands AFTER the scrim, because `drawHud` prints the
    //    score unconditionally and a whole-frame match is a 0-detector.
    const scrimIndex = rig.ctx.log.findIndex(
      (c) => c.op === 'fill' && c.style === PALETTE.scrim,
    )
    const said = rig.ctx.log
      .slice(scrimIndex + 1)
      .filter((c): c is TextCommand => c.op === 'text')
      .map((c) => c.text)
    expect(said).toEqual([
      `DESTINATION ${failed} OVERCROWDED`,
      `${rig.game.state.header[H_SCORE] as number} TRIPS`,
      'TAP TO PLAY AGAIN',
    ])

    // 3. And the ring is still there under the scrim, around the destination
    //    that did it — which is what makes "which one" a thing the player can
    //    SEE rather than a number they have to count buildings for.
    const rings = rig.ctx.log.filter((c): c is ArcCommand => c.op === 'arc')
    expect(rings.length, 'at least the failed destination is ringed').toBeGreaterThan(0)
    // §5.8's hidden grace: the killer's meter is at the FAIL threshold, folded
    // against FULL, so its ring is 249/255 — nearly closed and never closed.
    expect(frame.destOvercrowd[failed] as number).toBe(249)
    const widest = Math.max(...rings.map((r) => r.sweep))
    expect(widest).toBeCloseTo((249 / 255) * Math.PI * 2, 6)
    expect(widest, 'the ring is NOT full at the moment it kills you').toBeLessThan(Math.PI * 2)
  })

  it('the restart tap mutates not one byte of sim state, so a new run is a COLD BOOT', () => {
    // **The determinism half of Task 9, and the reason `restart` is a reload.**
    //
    // Two claims, and they need different evidence.
    //
    // 1. *The tap changes nothing.* `hashState` over the whole state buffer,
    //    before and after — the same digest the goldens are taken with, so this
    //    covers every region rather than the ones a hand-written list would
    //    remember. A guard that reset a counter, cleared the queue or nudged
    //    the loop would move it.
    // 2. *What replaces the run is a cold boot.* Production's `restart` is
    //    `() => { location.reload() }`, which re-evaluates the module and calls
    //    `createGame` from scratch — so "byte-identical to a cold boot" is true
    //    by CONSTRUCTION rather than by argument, and the thing that has to be
    //    checked is that a cold boot on the same seed is itself deterministic.
    //    That is the second half below, and it is the same property the seed
    //    golden pins, re-taken through the whole `createGame` assembly.
    const rig = buildRig({ layoutId: undefined })
    let frames = 0
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
    }
    expect(isGameOver(rig.game.state)).toBe(true)

    const before = hashState(rig.game.state)
    const tiles = rig.game.state.header[H_TILES] as number
    expect(rig.game.pointer.down(1, rig.cx(9), rig.cy(20))).toBe(PointerOutcome.RESTART_REQUESTED)
    expect(rig.game.pointer.down(2, rig.cx(11), rig.cy(14))).toBe(PointerOutcome.RESTART_REQUESTED)
    rig.game.pointer.move(2, rig.cx(12), rig.cy(14))
    rig.game.pointer.up(2)
    rig.game.pointer.cancel(2)
    rig.advance(TICK_MS)
    expect(hashState(rig.game.state), 'the restart path touched sim state').toBe(before)
    expect(rig.game.state.header[H_TILES], 'and it cost the player no tiles').toBe(tiles)
    expect(rig.restarts).toBe(2)

    // Cold boot, twice, on the same layout and the same seed: identical after
    // the warm start and identical again after a thousand more ticks. This is
    // what the reload produces.
    const a = buildRig({ layoutId: undefined })
    const b = buildRig({ layoutId: undefined })
    expect(hashState(b.game.state), 'two cold boots must agree at frame 0').toBe(
      hashState(a.game.state),
    )
    for (let i = 0; i < 1000; i++) {
      a.advance(TICK_MS)
      b.advance(TICK_MS)
    }
    expect(hashState(b.game.state), 'and after a thousand ticks').toBe(hashState(a.game.state))
    // Non-vacuous: the digest MOVES when the sim runs, so "equal" is not "equal
    // to the same frozen buffer".
    expect(hashState(a.game.state)).not.toBe(hashState(buildRig({ layoutId: undefined }).game.state))
  })

  it('the ring fills long before the city dies, so the warning arrives in time to act', () => {
    // **The other half of the acceptance criterion, and the one that decides
    // whether the ring is a WARNING or an epitaph.** A ring that appears at
    // 3:40 on a board that dies at 3:43 tells the player nothing they can use.
    //
    // Measured rather than asserted loosely: the tick the first ring is drawn,
    // and the fraction of the run that has a ring on screen.
    const rig = buildRig({ layoutId: undefined })
    let firstRingTick = -1
    let ringFrames = 0
    let frames = 0
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
      const drawn = rig.ctx.log.some((c) => c.op === 'arc')
      if (drawn) {
        ringFrames++
        if (firstRingTick < 0) firstRingTick = rig.game.state.header[H_TICK] as number
      }
    }
    expect(isGameOver(rig.game.state)).toBe(true)
    // **Measured on the shipped demo board, and these reproduce exactly** — the
    // sim is deterministic and this rig's frame cadence is fixed, so none of
    // these is a statistical figure:
    //
    // ```
    //   first ring      tick 3,492   1 min 56 s
    //   death           tick 6,703   3 min 43 s
    //   warning         3,211 ticks  1 min 47 s
    //   ring on screen  3,212 of 5,504 frames — 58.4 % of the run
    // ```
    //
    // The bounds below are looser than the measurements on purpose: what has to
    // hold is "the warning arrives with time to act", not "at tick 3,492", and
    // pinning the tick would turn every spawn-tuning change into a failure that
    // says nothing about the ring.
    expect(firstRingTick, 'a ring must appear at all').toBeGreaterThan(0)
    expect(
      DEMO_DEATH_TICK - firstRingTick,
      'the warning must arrive at least a minute before the end',
    ).toBeGreaterThan(30 * 60)
    expect(
      ringFrames / frames,
      'a ring is on screen for most of the run, not only at the end',
    ).toBeGreaterThan(0.5)
    // Vacuity: the very first frames have NO ring, so this is measuring the
    // meter rather than a ring that is always drawn.
    const fresh = buildRig({ layoutId: undefined })
    fresh.advance(TICK_MS)
    expect(fresh.ctx.log.some((c) => c.op === 'arc')).toBe(false)
  })

  it('a game whose state is ALREADY over at boot ends its loop too', () => {
    // **`onGameOver` fires on an EDGE, and a state that was terminal before the
    // first `advance` has no edge to fire on.** Without `createGame`'s own
    // `if (isGameOver(state)) loop.end()`, `loop.paused` stays false — and
    // `pointer.ts` refuses board input while paused and by NOTHING ELSE, so the
    // player draws roads that never appear, spends no tiles and gets no
    // message. The same failure `end()` exists to prevent, through a different
    // door.
    //
    // Unreachable from the shipped layouts — `layouts.test.ts` drives every
    // registered layout's own warm start and asserts it survives it — and it
    // stops being unreachable the moment M3's restore hands `createGame` a
    // saved game-over state. Constructed here by the shortest honest route: a
    // warm start long enough to kill the board it runs on.
    //
    // 6,703 is the demo board's death tick, so a 6,703-tick warm start boots a
    // game that has already lost.
    const dead = buildRig({ layoutId: undefined, warmStartTicks: DEMO_DEATH_TICK })
    expect(isGameOver(dead.game.state), 'vacuity: the warm start really did kill it').toBe(true)
    expect(dead.game.state.header[H_TICK]).toBe(DEMO_DEATH_TICK)

    // The loop knew before the first frame — not after one.
    expect(dead.game.loop.over, 'the loop must be ended at construction').toBe(true)
    expect(dead.game.loop.paused).toBe(true)

    // And the consequence, which is the whole reason the line exists: the grid
    // is shut on the very first interaction, with no frame having run at all —
    // and since M1e Task 9 that same first tap is the way out, so a restored
    // game-over save is recoverable rather than a wall.
    expect(dead.game.pointer.down(1, dead.cx(9), dead.cy(20))).toBe(
      PointerOutcome.RESTART_REQUESTED,
    )
    expect(dead.restarts).toBe(1)
    expect(dead.game.queue.inputs.actions.length).toBe(0)

    // It is still sticky, and it still draws.
    dead.game.loop.setPaused(false)
    expect(dead.game.loop.paused).toBe(true)
    dead.advance(TICK_MS)
    expect(dead.game.loop.ticksLastFrame).toBe(0)
    expect(dead.game.builder.frame.paused).toBe(true)
  })
})

describe('a boot that throws puts the reason on the screen', () => {
  it('renders a surface carrying the failure, the bad token and every layout id', () => {
    // The REAL failure, not a synthetic one: the same `createGame` call the
    // phone makes, with the same unknown id, throwing the same error out of
    // `layoutFor`.
    const made: BootSurface[] = []
    const { result, logged } = captureErrors(() =>
      startOrReport(
        () => buildRig({ layoutId: 'demoo' }).game,
        () => {
          const surface = bootSurface()
          made.push(surface)
          return surface
        },
        () => 'demoo',
      ),
    )

    expect(result, 'a failed boot must not hand back a half-built game').toBe(null)
    expect(made.length, 'no surface was created — this is the blank page').toBe(1)
    const surface = made[0] as BootSurface
    const text = surface.textContent ?? ''

    // 1. That it failed at all, in words a player can read.
    expect(text).toContain('Laneways could not start')
    // 2. The bad token, quoted back. Without it the message is generic and the
    //    player cannot tell which of their two saved links is the broken one.
    //    The whole line, for the reason spelled out in 3: `layoutFor`'s message
    //    also contains the token, so a bare `toContain('demoo')` is satisfied
    //    whether or not this surface names it.
    expect(text).toContain('The link asked for the layout: demoo')
    // 3. Every layout that DOES exist — **asserted as the whole line, and the
    //    per-id form was measured at 0 detectors here.** `layoutFor`'s own
    //    message already ends "the layouts that exist are city, demo", so
    //    `toContain('city')` over this text is satisfied whether or not
    //    `bootFailureText` lists anything at all. The isolated case is the
    //    canvas failure below, whose message names no layout.
    expect(LAYOUT_IDS.length).toBeGreaterThanOrEqual(2)
    expect(text).toContain(`Layouts that exist: ${LAYOUT_IDS.join(', ')}`)
    // 4. The thrown reason itself, last.
    expect(text).toContain('unknown layout "demoo"')
    // ...and the developer channel keeps the stack the DOM surface cannot carry.
    expect(logged.length).toBe(1)
    expect(logged[0]).toBeInstanceOf(Error)

    // The element is identifiable and styled for a phone.
    expect(surface.attributes.get('id')).toBe(BOOT_FAILURE_ELEMENT_ID)
    expect(surface.attributes.get('style')).toBe(BOOT_FAILURE_STYLE)
  })

  it('styles the surface so it is on top, readable, and not the page colour', () => {
    // Every property here is one a person would notice the absence of on a
    // phone, and each is asserted separately so a mutation that drops one is
    // named by the failure rather than lost in a string comparison.
    //
    // The canvas is already in the document, so a message underneath it is a
    // message nobody sees.
    expect(BOOT_FAILURE_STYLE).toContain('position:fixed')
    expect(BOOT_FAILURE_STYLE).toContain('inset:0')
    expect(BOOT_FAILURE_STYLE).toContain('z-index:2147483647')
    // `index.html` paints the body #d9d3c7 with #2e2b28 text. The panel is that
    // pair inverted: the text is not the page's text colour and the panel is not
    // the page's background, so neither can vanish into the other.
    expect(BOOT_FAILURE_STYLE).toContain('background:#2e2b28')
    expect(BOOT_FAILURE_STYLE).toContain('color:#f6f2ea')
    expect(BOOT_FAILURE_STYLE).not.toContain('background:#d9d3c7')
    // 16px is the smallest size iOS does not offer to zoom.
    expect(BOOT_FAILURE_STYLE).toContain('font:16px/1.5')
    // Four paragraphs collapse into one unreadable run without this.
    expect(BOOT_FAILURE_STYLE).toContain('white-space:pre-wrap')
    // A 512-character token off a URL has no space in it, so it needs both a
    // break rule and somewhere to scroll.
    expect(BOOT_FAILURE_STYLE).toContain('overflow-wrap:break-word')
    expect(BOOT_FAILURE_STYLE).toContain('overflow:auto')
    // `index.html` ships `viewport-fit=cover`, so the insets are real and a
    // panel without them starts under the notch.
    expect(BOOT_FAILURE_STYLE).toContain('env(safe-area-inset-top)')
    expect(BOOT_FAILURE_STYLE).toContain('env(safe-area-inset-bottom)')
  })

  it('says "(none)" rather than nothing when the failure carried no token', () => {
    // The other reachable failure: a missing canvas or a refused 2D context,
    // where the launch named no layout at all. An empty string printed after
    // "asked for the layout:" reads as a rendering fault in the error message.
    const text = bootFailureText(new Error('startGame: no <canvas id="board">'), '')
    expect(text).toContain('The link asked for the layout: (none)')
    expect(text).toContain('startGame: no <canvas id="board">')
    expect(text).not.toContain('layout: \n')
    // **The registry list, isolated.** This failure's message names no layout,
    // so unlike the end-to-end case above these assertions can only be
    // satisfied by `bootFailureText`'s own line. Both forms are here on
    // purpose: the per-id loop is what catches a THIRD layout going unlisted,
    // and the whole-line assertion is what catches the line being dropped.
    for (const id of LAYOUT_IDS) expect(text, `layout id ${id}`).toContain(id)
    expect(text).toContain(`Layouts that exist: ${LAYOUT_IDS.join(', ')}`)
  })

  it('prints a non-Error throw rather than the word undefined', () => {
    // `throw 'a string'` is legal JS and `.message` off it is `undefined`.
    expect(bootFailureText('the SDK exploded', 'demo')).toContain('the SDK exploded')
    expect(bootFailureText('the SDK exploded', 'demo')).not.toContain('undefined')
  })

  it('creates NO surface when the game starts, and hands the game back', () => {
    // Non-vacuity for the whole section: a reporter that renders unconditionally
    // would satisfy every assertion above and put an error panel over a working
    // board on every launch.
    const made: BootSurface[] = []
    const { result, logged } = captureErrors(() =>
      // `layoutId: undefined` and the empty token beneath it: this is the
      // launch with nothing in the URL, which is the one every player makes.
      startOrReport(
        () => buildRig({ layoutId: undefined }).game,
        () => {
          const surface = bootSurface()
          made.push(surface)
          return surface
        },
        () => '',
      ),
    )
    expect(made.length).toBe(0)
    expect(logged.length).toBe(0)
    // Nothing named a board, which is what the entry point does on a plain
    // load: a successful boot hands back the DEFAULT layout.
    expect(result?.layoutId).toBe(DEFAULT_LAYOUT_ID)
    expect(result?.layoutId).toBe('demo')
  })

  it('declines quietly where there is no DOM, and survives a reporter that itself throws', () => {
    // Two failures of the failure path. Both must return rather than propagate:
    // an exception escaping here reinstates the blank page this whole section
    // exists to end.
    expect(reportBootFailure(() => null, new Error('boom'), 'demoo')).toBe(false)

    const fromFactory = captureErrors(() =>
      startOrReport(
        () => buildRig({ layoutId: 'demoo' }).game,
        () => {
          throw new Error('the document refused')
        },
        () => 'demoo',
      ),
    )
    expect(fromFactory.result).toBe(null)
    // Both errors reach the log: the boot failure and the reporter's own.
    expect(fromFactory.logged.length).toBe(2)

    const fromToken = captureErrors(() =>
      startOrReport(
        () => buildRig({ layoutId: 'demoo' }).game,
        bootSurface,
        () => {
          throw new Error('location is not readable')
        },
      ),
    )
    expect(fromToken.result).toBe(null)
    expect(fromToken.logged.length).toBe(2)
  })

  it('is actually WIRED at the module-scope entry point — the source says so', () => {
    // **A source scan, and it is the only instrument that reaches this line.**
    // `if (shouldAutoStart()) startGame()` runs at import time in a browser and
    // never under vitest, which is precisely why the bug existed: the whole
    // try/catch could be deleted and every test above would still pass, because
    // they all call `startOrReport` directly. Same shape, and same labelling, as
    // the `...launchOptions(location, startParam())` scan in `layoutSelect.test.ts`.
    const source = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8')
    expect(source).toContain('startOrReport(startGame, createBootFailureSurface, () =>')
    expect(source.split('startOrReport(startGame, createBootFailureSurface, () =>').length - 1).toBe(1)
    // ...and the unguarded form it replaced is gone. Anchored on the whole
    // statement, because `startGame()` alone appears in this file's prose.
    expect(source).not.toContain('if (shouldAutoStart()) startGame()')
  })
})
