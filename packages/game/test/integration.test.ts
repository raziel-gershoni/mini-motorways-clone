import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CARS_PER_HOUSE,
  COST_UNIT_SCALE,
  DIAG_COST,
  FIRST_PIN_DELAY_TICKS,
  DENOM,
  OVERCROWD_FAIL_MILLITICKS,
  PIN_CAP_CIRCLE_HARD,
  PIN_PERIOD_TICKS,
  WEEKLY_TILE_GRANT,
} from '@laneways/shared'
import {
  H_DEST_COUNT,
  H_HOUSE_COUNT,
  CARD_JUNCTION_UPGRADE,
  H_INV_UPGRADES,
  H_OFFER_A,
  H_OFFER_B,
  H_OFFER_WEEK,
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
  failedDestination,
  isGameOver,
  occupantOf,
  offerPending,
  offerSlot,
  packRouteStep,
  assertOccupancyComplete,
  assertOccupancySound,
  hashState,
  roadMask,
  tilesLeft,
  weekOfTick,
  H_FAILED_DEST,
  H_ROUTES_REFUSED,
  type TickAction,
} from '@laneways/sim'
import {
  CARD_GRANT_ITEM,
  CARD_GRANT_ROAD_TILES,
  MAX_BLOCKED_TICKS,
  TICKS_PER_SECOND,
  TICKS_PER_WEEK,
  UPGRADES_PER_CARD,
} from '@laneways/shared'
import {
  PALETTE,
  createOfferRects,
  offerRects,
  type AtlasContext,
  type AtlasSurface,
  type Rect,
} from '@laneways/render'
import {
  buildJamRig,
  jamGhostCells,
  jamQueueLength,
  JAM_W,
  JAM_X,
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
import { CITY_LAYOUT_ID, DEMO_LAYOUT_ID, DEFAULT_LAYOUT_ID, LAYOUT_IDS } from '../src/layouts'
import { CITY_DEATH_TICK, DEMO_DEATH_TICK } from './deathTicks'
import { takeCardPolicy } from './cardPolicy'
import {
  armCarpark,
  armGreedyActions,
  armPathActions,
  firesSoFar,
  CITY_OPENING,
  D2_LINK,
  GREEDY_PERIOD_TICKS,
  type CityArm,
} from './cityArms'
import { longestQueue } from '../src/queueProbe'
import {
  censusCellTable,
  censusPrev,
  countJunctionConflicts,
  CENSUS_CO_PRESENCE,
  CENSUS_RULE_VISIBLE,
} from './junctionCensus'
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
  /**
   * One frame, `ms` later, **with the card policy switched off** — M1f Task 7.
   *
   * The cases that are ABOUT the offer pause have to be able to sit inside it:
   * `advance` and `oneTick` resolve an offer the moment one is up, which is
   * exactly what every other case in this file needs and exactly what a test of
   * the pause must not have. Returns the tick count, like `advance`.
   */
  readonly advanceRaw: (ms: number) => number
  /**
   * How many weekly card offers this rig has resolved — M1f Task 7.
   *
   * **The policy lives inside the rig's two frame helpers rather than at each
   * of the nine drive loops in this file**, because a per-loop policy is a
   * policy somebody forgets: measured before it existed, the offer pause put
   * **11 genuine reds** into this file and `demoAllocation.test.ts` and skipped
   * four more cases behind a failed `beforeAll`. It is a no-op on every case
   * that stops inside week 0, which is most of them. See `cardPolicy.ts`.
   */
  readonly cardsTaken: number
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
  let cardsTaken = 0
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
    get cardsTaken(): number {
      return cardsTaken
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
      //
      // **Except on the frame after a resume, which runs ZERO ticks whatever
      // the delta is** — `setPaused(false)` sets `resetClock`, so the next
      // frame assigns `lastTime = now` and `rawDt` is 0. Every caller in this
      // file either loops until the tick lands (`driveArm`, the death loops) or
      // stops inside week 0, where the policy below never fires.
      now += TICK_MS + alpha * TICK_MS - game.loop.accumulator
      ctx.log = []
      // BEFORE the frame, so the action is enqueued and consumed inside one
      // call and `driveArm`'s "the queue was drained" check still holds.
      if (takeCardPolicy(game, 0)) cardsTaken++
      game.frame(now)
    },
    advance: (ms) => {
      now += ms
      ctx.log = []
      if (takeCardPolicy(game, 0)) cardsTaken++
      game.frame(now)
      return game.loop.ticksLastFrame
    },
    advanceRaw: (ms) => {
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

// --- M1e Task 12's erase/re-place sweep, on the same fixture ---------------

/**
 * 25,200 = 700 x 36. The brief's floor is 25,000 and the period is 700; a
 * horizon that is not a whole number of periods would end mid-cycle, leaving
 * the last erase unrefunded and the ledger's final value dependent on where the
 * horizon happened to stop.
 */
const ERASE_RUN_TICKS = 25200
const ERASE_PERIOD_TICKS = 700
/**
 * How long the corridor stays broken. 60 ticks = 2 s, which is long enough for
 * every committed car to cross off the ghosted cells and the refund to land,
 * and short enough that the destination's meter — which climbs at 1,000
 * milliticks a tick while nothing arrives — gains only ~60,000 against a
 * threshold of 2,640,000.
 */
const ERASE_HOLD_TICKS = 60

/**
 * The last tick on which `assertOccupancyComplete` can be asserted here.
 *
 * **Measured, and the measurement is the point of the constant.** Completeness'
 * exception set has exactly one live member on this fixture — a car displaced
 * by the anti-deadlock valve stays unnamed by its cell's slots until IT crosses
 * again — and the natural reading of "skip the ticks where the valve fired" is
 * far too narrow: swept over the whole 25,200, the assertion throws on **22,980
 * of them**, and the longest gap between a firing and the tick the assertion
 * recovers on is **1,006 ticks**. The valve fires 1,417 ticks in and this
 * fixture never really gets a quiet stretch again.
 *
 * What is clean is everything **before the first firing**: fails before the
 * first valve tick are **0 of 1,417**. So completeness is asserted over exactly
 * that prefix, which is what `blocking.ts` says out loud — *"this half is
 * asserted only on fixtures where the valve has not fired"* — applied to a
 * prefix of a run rather than to a whole fixture.
 *
 * **The prefix is not a formality: it contains two complete erase/re-place
 * cycles and the third's erase** (ticks 2, 702 and 1,402), so the ghost path is
 * inside the window rather than beyond it. That is the whole reason this
 * constant is 1,417 and not, say, 500.
 */
const ERASE_FIRST_VALVE_TICK = 1419
const ERASE_COMPLETE_UNTIL = ERASE_FIRST_VALVE_TICK - 1

/**
 * The five-cell stroke, in the middle of the starved corridor: column 8, rows
 * 8..12. A drag samples adjacent pairs, so a stroke over N cells takes both
 * bits off only the N - 2 in the middle — three cells here, which is what
 * `peakGhostCells` asserts.
 */
const ERASE_STROKE: readonly TickAction[] = Object.freeze(
  [8, 9, 10, 11].map((y) =>
    Object.freeze({ kind: 'erase' as const, a: y * JAM_W + JAM_X, b: (y + 1) * JAM_W + JAM_X }),
  ),
)
const REPLACE_STROKE: readonly TickAction[] = Object.freeze(
  ERASE_STROKE.map((a) => Object.freeze({ kind: 'place' as const, a: a.a, b: a.b })),
)

/** Road cells the starved rig builds before tick 1: the corridor, y = 4..16. */
const INITIAL_ROAD_CELLS = 13

function eraseRunRoadCells(state: Game['state'], world: Game['world']): number {
  let n = 0
  for (let c = 0; c < world.cells; c++) if ((state.roads[c] as number) !== 0) n++
  return n
}

function eraseRunGhostCells(state: Game['state']): number {
  let n = 0
  for (let c = 0; c < state.ghostMask.length; c++) if ((state.ghostMask[c] as number) !== 0) n++
  return n
}

/** `tiles + roadCells + ghostCells` — the quantity M1d's review found constant. */
function ledgerOf(state: Game['state'], world: Game['world']): number {
  return tilesLeft(state) + eraseRunRoadCells(state, world) + eraseRunGhostCells(state)
}

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

  // -------------------------------------------------------------------------
  // M1e TASK 12 — THE SAME FIXTURE, LONGER, AND NOW IT ERASES
  // -------------------------------------------------------------------------
  //
  // Carried forward from the whole-milestone review: *"The shipped long-run
  // test never erases a road, so the ghost path has no long-horizon coverage in
  // the suite — the 25,000-tick evidence lives in a review, not in a test. A
  // finding whose only carrier is a report is the shape this project keeps
  // getting bitten by."*
  //
  // **A SECOND case rather than an extension of the one above, and the reason
  // is a measurement, not tidiness.** The case above ends in five figures —
  // `valves` 98, `minCompletions` 2, `maxReserved` 24, `maxBlocked` at the
  // threshold, `destPins[0]` 85 — that exist to prove *"this fixture is the one
  // M1d's numbers were derived on and not a new board wearing its name"*.
  // Lengthening its horizon and breaking its corridor 36 times moves every one
  // of them, so folding would have deleted the anchor to add the coverage. This
  // case is a strict superset in both horizon and invariants; the one above is
  // the anchor. Together they cost ~2.4 s.
  it('holds the tile ledger, the meter bound and both occupancy halves across 25,200 ticks of erase and re-place', () => {
    const rig = buildJamRig('erase-run', JAM_STARVED_FIRST_HOUSE_Y, JAM_STARVED_HOUSE_COUNT)
    expect(rig.state.header[H_TICK], 'the rig arrives one tick in').toBe(1)

    // The ledger's constant term, read off the fixture at tick 1 rather than
    // written as a literal — `parseMap('jam-rig', …, 9999, …)` is where 9,999
    // comes from, and a fixture that changed its starting tiles should move this
    // number rather than fail against a copy of it.
    const LEDGER_TOTAL = ledgerOf(rig.state, rig.world)
    expect(LEDGER_TOTAL, "9,999 starting tiles, and the corridor's cells are already paid for").toBe(
      9999,
    )
    expect(weekOfTick(rig.state.header[H_TICK] as number), 'no grant has landed yet').toBe(0)

    let valves = 0
    let peakMeter = 0
    let ghostTicks = 0
    let peakGhostCells = 0
    let erases = 0
    let replaces = 0
    let completeChecked = 0
    let completeTicks = 0
    let lastValveTick = -1
    let firstValveTick = -1
    let refunded = 0

    for (let t = 0; t < ERASE_RUN_TICKS; t++) {
      const tick = t + 2 // the rig arrives at tick 1, so drive `t` lands on `t + 2`
      const phase = t % ERASE_PERIOD_TICKS
      let actions: readonly TickAction[] | undefined
      if (phase === 0) {
        actions = ERASE_STROKE
        erases++
      } else if (phase === ERASE_HOLD_TICKS) {
        actions = REPLACE_STROKE
        replaces++
      }
      const obs = rig.drive(1, actions)
      valves += obs.valves
      if (obs.valves > 0) {
        lastValveTick = tick
        if (firstValveTick < 0) firstValveTick = tick
      }

      // ---------------------------------------------------------------------
      // **The refund ledger is BUDGET-EXACT, and from M1e it is a conservation
      // law WITH A SOURCE TERM.** The whole-milestone review measured
      // `tiles + roadCells + ghostCells` constant at 9,999 across 25,000 ticks;
      // Task 2's `runWeekBoundary` now injects WEEKLY_TILE_GRANT at each
      // boundary, so the identity gains a term rather than a tolerance.
      //
      // Written as an explicit term and NOT as a loosened range, because the
      // point of the invariant is that place/erase/refund CONSERVE — a range
      // wide enough to absorb a grant is wide enough to absorb a leaking
      // refund. `grantsSoFar` comes from the clock, never from a counter the
      // grant itself writes, or the assertion would be checking the grant
      // against itself.
      // ---------------------------------------------------------------------
      const grantsSoFar = weekOfTick(rig.state.header[H_TICK] as number)
      expect(ledgerOf(rig.state, rig.world)).toBe(LEDGER_TOTAL + WEEKLY_TILE_GRANT * grantsSoFar)

      assertOccupancySound(rig.state, rig.world)

      // **Completeness only where the valve cannot have left a gap.** Its
      // exception set is real — a car displaced by the valve stays unnamed
      // until it crosses again — so asserting it unconditionally would be
      // asserting something known false. See ERASE_COMPLETE_UNTIL: the window
      // is the prefix before the first firing, it is 1,417 ticks long, and it
      // contains two whole erase/re-place cycles.
      if (tick <= ERASE_COMPLETE_UNTIL) {
        if (lastValveTick >= 0) {
          throw new Error(
            `the valve fired on tick ${lastValveTick}, inside the window completeness is asserted over`,
          )
        }
        completeChecked += assertOccupancyComplete(rig.state, rig.world)
        completeTicks++
      }

      let outbound = 0
      for (let c = 0; c < rig.state.carPhase.length; c++) {
        if ((rig.state.carPhase[c] as number) === PHASE_OUTBOUND) outbound++
        const blocked = rig.state.carBlockedTicks[c] as number
        if (blocked < 0) throw new Error(`carBlockedTicks[${c}] wrapped to ${blocked} on tick ${tick}`)
      }
      let reserved = 0
      for (let d = 0; d < rig.state.destReserved.length; d++) {
        const r = rig.state.destReserved[d] as number
        if (r > 255 || r < 0) throw new Error(`destReserved[${d}] is ${r} on tick ${tick}`)
        reserved += r
      }
      expect(reserved, `sum(destReserved) !== count(PHASE_OUTBOUND) on tick ${tick}`).toBe(outbound)

      const destCount = rig.state.header[H_DEST_COUNT] as number
      for (let d = 0; d < destCount; d++) {
        const m = rig.state.destOvercrowd[d] as number
        // **[0, FAIL + DENOM - 1], not [0, FAIL].** `runOvercrowd` adds the ramp
        // BEFORE the fail test, so the stored value can overshoot the threshold
        // by up to `DENOM - 1` = 999, and `step`'s freeze then preserves the
        // overshoot forever. A bound of FAIL would be a bound the shipped code
        // is allowed to break.
        if (m < 0 || m > OVERCROWD_FAIL_MILLITICKS + DENOM - 1) {
          throw new Error(`destOvercrowd[${d}] is ${m} on tick ${tick}, outside [0, 2640999]`)
        }
        if (m > peakMeter) peakMeter = m
      }

      const ghosts = jamGhostCells(rig)
      if (ghosts > 0) ghostTicks++
      if (ghosts > peakGhostCells) peakGhostCells = ghosts
    }

    // ---------------------------------------------------------------------
    // **THE GUARD THAT DECIDES WHETHER THIS TEST IS MEASURING ANYTHING.**
    // Every invariant above is a SAFETY property and a frozen buffer satisfies
    // all of them: the ledger stops moving, occupancy stays sound, the
    // reservation sum keeps matching, no counter wraps and the meter stops
    // climbing. If this fires, the FIXTURE is what changes, not the assertion.
    // ---------------------------------------------------------------------
    expect(isGameOver(rig.state), 'a 25,000-tick invariant sweep over a FROZEN buffer proves nothing').toBe(
      false,
    )
    expect(rig.state.header[H_TICK]).toBe(ERASE_RUN_TICKS + 1)

    // The cycle really ran, and it really ghosted. Without these the whole case
    // is the sweep above with a longer horizon and two unused constants.
    expect(erases, '25,200 / 700').toBe(36)
    expect(replaces).toBe(36)
    expect(peakGhostCells, 'a five-cell stroke takes both bits off the middle three').toBe(3)
    expect(ghostTicks, 'ticks with at least one ghosted cell').toBeGreaterThan(0)
    // The refund is what makes the ledger interesting: a stroke that never
    // ghosted would be refunded on the spot and the identity would hold for a
    // duller reason.
    expect(rig.state.header[H_TILES] as number).toBeGreaterThan(0)
    refunded = (rig.state.header[H_TILES] as number) - (9999 - INITIAL_ROAD_CELLS)
    expect(refunded, 'tiles back in the budget, from the grants and the refunds together').toBeGreaterThan(0)

    // Completeness ran, over the measured prefix, and the prefix is pinned at
    // both ends: the valve must NOT have fired inside it (asserted in the loop)
    // and it must fire on exactly the tick the constant names, or the window is
    // shorter or longer than the thing it was measured against.
    expect(completeTicks, 'ticks on which completeness was asserted').toBe(ERASE_COMPLETE_UNTIL - 1)
    expect(completeChecked, 'cars ranged over — not vacuous').toBeGreaterThan(0)
    expect(lastValveTick, 'the first valve firing, which is what closes the window').toBeGreaterThan(0)
    expect(firstValveTick, 'and it is where the sweep measured it').toBe(ERASE_FIRST_VALVE_TICK)

    // The meter never came close, so the horizon is not at risk of the freeze
    // the guard above refuses.
    expect(peakMeter).toBeGreaterThan(0)
    expect(peakMeter).toBeLessThan(OVERCROWD_FAIL_MILLITICKS / 10)

    // The valve still fires on this fixture — it is the only place in the repo
    // where it fires through `runMovement`, and breaking the corridor 36 times
    // must not have quietly turned that off.
    expect(valves, 'the valve never fired, so this is not the bad network it claims to be').toBeGreaterThan(
      0,
    )

    // Two identical runs agree, byte for byte, over a run that erases.
    const second = buildJamRig('erase-run', JAM_STARVED_FIRST_HOUSE_Y, JAM_STARVED_HOUSE_COUNT)
    for (let t = 0; t < ERASE_RUN_TICKS; t++) {
      const phase = t % ERASE_PERIOD_TICKS
      second.drive(
        1,
        phase === 0 ? ERASE_STROKE : phase === ERASE_HOLD_TICKS ? REPLACE_STROKE : undefined,
      )
    }
    expect(hashState(second.state)).toBe(hashState(rig.state))
    const untouched = buildJamRig('erase-run', JAM_STARVED_FIRST_HOUSE_Y, JAM_STARVED_HOUSE_COUNT)
    expect(hashState(rig.state)).not.toBe(hashState(untouched.state))
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
  it('opens the STARTING CITY when the launch names nothing — no token, no demo', () => {
    // **The end-to-end half of the default, through the real `createGame`.**
    // `layouts.test.ts` pins the constant; this is the only place that runs a
    // whole boot with `layoutId` absent, which is what every plain load and
    // every Telegram open with no `startapp` does.
    //
    // `layoutId: undefined` is written out rather than omitted so the rig's
    // `in` check sees it. It now lands on the same board the omitted form does
    // — M1e Task 10 gave the default back to the city — so this case is about
    // the RESOLUTION being explicit rather than about a different board, and
    // the discriminating half is the `not.toBe` pair at the foot.
    const rig = buildRig({ layoutId: undefined })
    expect(rig.game.layoutId).toBe(DEFAULT_LAYOUT_ID)
    expect(rig.game.layoutId).toBe('city')
    expect(rig.game.world.map.id).toBe('firstCity')
    expect(rig.game.warmStartTicks).toBe(WARM_START_TICKS)
    expect(rig.game.state.header[H_TICK] as number).toBe(WARM_START_TICKS)
    // Three seeded houses and three seeded destinations, and the warm start is
    // 258 ticks — far short of the spawner's first house at tick 300 — so the
    // board a player's first frame shows is exactly `seedStartingCity`'s.
    expect(rig.game.state.header[H_HOUSE_COUNT] as number).toBe(3)
    expect(rig.game.state.header[H_DEST_COUNT] as number).toBe(3)
    expect(rig.game.state.carPhase.length).toBe(80)
    // **And the board it is NOT.** Each of the four above is satisfied by the
    // city entry alone, so none of them would notice the demo coming back if a
    // future edit gave the two entries the same map. The demo's own numbers are
    // the discriminator, and they are asserted as absences here and as
    // presences in the case below.
    expect(rig.game.world.map.id).not.toBe('demoCity')
    expect(rig.game.warmStartTicks).not.toBe(DEMO_WARM_START_TICKS)
  })

  it('opens the starting city on layoutId "city" — still reachable, still today’s board', () => {
    // The board the default points at again. Naming it explicitly is a
    // separate claim from getting it by default, and the two are asserted
    // separately: same map, same warm start, same three houses and six cars.
    // `startingCity.test.ts` holds its seed golden; this holds the assembled
    // boot.
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
    // not work", which is the report this whole task exists to answer — and
    // with the default back on the city that is once again the literal
    // incident, not an inverted restatement of it.
    expect(() => buildRig({ layoutId: 'demoo' })).toThrow(/unknown layout "demoo"/)
  })

  it('treats an empty layoutId as absent, so a half-copied link still boots', () => {
    // `?layout=` and `#tgWebAppStartParam=` both parse to `''`. It must land on
    // the default rather than on `layoutFor('')`'s throw — and on the SAME
    // board as no token at all, which is the half a bare `.toBe('city')` would
    // not say.
    expect(buildRig({ layoutId: '' }).game.layoutId).toBe(DEFAULT_LAYOUT_ID)
    expect(buildRig({ layoutId: '' }).game.layoutId).toBe('city')
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
  it('freezes at 3 min 42 s and draws a bit-identical frame forever after', () => {
    // **Pinned to `demo` by name at M1e Task 10, and the pin is the point.**
    // This case used to pass `layoutId: undefined` and assert
    // `DEMO_DEATH_TICK`, on the reasoning that the default WAS the demo — two
    // claims in one rig. Task 10 flipped the default to the city, and the two
    // came apart: the city with no input has no road, so no car ever moves and
    // the still-image claim below would be satisfied by a board that was
    // already a still image. So this block keeps measuring the demo board and
    // `the board a plain load opens stops dead` below measures the default.
    const rig = buildRig({ layoutId: DEMO_LAYOUT_ID })
    expect(rig.game.layoutId, 'this block is about the demo board by name').toBe(DEMO_LAYOUT_ID)

    let frames = 0
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
    }

    // It ended, on the measured tick, unprompted and with no input of any kind.
    expect(isGameOver(rig.game.state), 'the default board must end a run on its own').toBe(true)
    expect(rig.game.state.header[H_TICK]).toBe(DEMO_DEATH_TICK)
    // 6,660 / 30 = 222.0 s. **Moved twice inside M1f: 223 s -> 191.9 s (Task 2's
    // wide rule) -> 222.0 s (Task 3's crossing-only rule).** The wide rule cost
    // this board 946 ticks; narrowing it to crossing axes gives 903 of them
    // back, leaving it 43 ticks (1.4 s) short of pre-M1f. See `DEMO_DEATH_TICK`.
    expect(Math.round(DEMO_DEATH_TICK / 30), 'which is 222 s — 3 min 42 s at 30 Hz').toBe(222)
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
    // `loop.end()` shuts the grid, and this is its end-to-end consequence rather
    // than a restatement of it: a real `pointerdown` on a real board cell,
    // through the real pointer machine, after a real shutdown — refused for the
    // RIGHT reason, named by the outcome code rather than inferred from an empty
    // queue.
    //
    // **This comment said "refuses board input while paused and by nothing
    // else" until M1e's closing sweep, and the test three lines down had been
    // contradicting it since Task 9.** `down()`'s first statement is the
    // `gameOver` arm, so the outcome here is `RESTART_REQUESTED` (9) and
    // `REFUSED_PAUSED` (7) is unreachable from a dead board — which is exactly
    // what the assertion below has been checking. Both arms hang off `end()`
    // (`gameOver` is `loop.over`), so the sentence's conclusion survives its
    // premise; see `loop.ts`'s `end` for which half stickiness still owns.
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

  it('draws the shutdown screen the player actually reads, on the demo board', () => {
    // **Task 9's acceptance criterion, end to end, with no input of any kind.**
    // Every prior task in this milestone could honestly answer "a human sees
    // nothing"; this is the case that made that false. It is the WENT UNSERVED
    // arm; the default board's own case below is the roadless one.
    const rig = buildRig({ layoutId: DEMO_LAYOUT_ID })
    expect(rig.game.layoutId).toBe(DEMO_LAYOUT_ID)
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
    // **The exact four lines, in order, and the first one is the review's
    // headline.** "OVERCROWDED" described too much traffic; measured, this
    // destination has ZERO draining frames — it is never served at all — so the
    // word sent the player to draw FEWER roads. The demo board's D2 is on the
    // road network and still receives nothing, which is why the first line here
    // is the WENT UNSERVED arm rather than the roadless one.
    const carpark = rig.game.builder.frame.destCarpark[failed] as number
    expect(rig.game.state.roads[carpark] as number, 'D2 IS on the network').toBeGreaterThan(0)
    expect(said).toEqual([
      `DESTINATION ${failed} WENT UNSERVED`,
      'CONNECT EVERY DESTINATION WITH A ROAD',
      `${rig.game.state.header[H_SCORE] as number} TRIPS`,
      'TAP TO PLAY AGAIN',
    ])
    // The word that must never come back, on the whole phase.
    for (const line of said) expect(line).not.toContain('CROWD')

    // 3. And the ring is still there under the scrim, around the destination
    //    that did it — which is what makes "which one" a thing the player can
    //    SEE rather than a number they have to count buildings for.
    const rings = rig.ctx.log.filter((c): c is ArcCommand => c.op === 'arc')
    expect(rings.length, 'at least the failed destination is ringed').toBeGreaterThan(0)
    // The killer's ring is redrawn OVER the scrim, so "which one" is pointed at
    // rather than inferred from being the biggest arc on a board of eighteen.
    const overScrim = rig.ctx.log
      .slice(scrimIndex + 1)
      .filter((c): c is ArcCommand => c.op === 'arc')
    expect(overScrim.length, 'exactly the killer, redrawn above the dim').toBe(1)
    // §5.8's hidden grace: the killer's meter is at the FAIL threshold, folded
    // against FULL, so its ring is 249/255 — nearly closed and never closed.
    expect(frame.destOvercrowd[failed] as number).toBe(249)
    const widest = Math.max(...rings.map((r) => r.sweep))
    expect(widest).toBeCloseTo((249 / 255) * Math.PI * 2, 6)
    expect(widest, 'the ring is NOT full at the moment it kills you').toBeLessThan(Math.PI * 2)
  })

  it('takes the erase control off the screen, because the scrim cannot reach it', () => {
    // **The most prominent thing on the shutdown screen was a button that does
    // not restart.** (Demo board, by name — see the first case in this block.)
    // The scrim is painted on the CANVAS; the erase control is
    // native `MainButton` chrome or a `position: fixed` DOM pill, both outside
    // anything `drawFrame` can dim. Without `retire()` a player sees a dimmed
    // board reading TAP TO PLAY AGAIN and, under it, an undimmed full-width
    // bright button offering ERASE ROADS.
    //
    // Driven end to end through the real `onGameOver`, because the wiring is
    // the thing at risk — the control's own behaviour has its own file.
    const rig = buildRig({ layoutId: DEMO_LAYOUT_ID, fallback: true })
    expect(rig.game.erase.retired, 'vacuity: live, the control is on screen').toBe(false)
    let frames = 0
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
    }
    expect(rig.game.state.header[H_TICK]).toBe(DEMO_DEATH_TICK)
    expect(rig.game.erase.retired, 'the button outlived the city').toBe(true)
    // Sticky against everything that could re-render it, including the tap that
    // is about to restart the run.
    rig.game.erase.sync()
    rig.game.pointer.down(1, rig.cx(9), rig.cy(20))
    expect(rig.game.erase.retired).toBe(true)
  })

  it('retires it at boot too, when the state was ALREADY over and there is no edge', () => {
    // `onGameOver` fires on an EDGE, so a restored game-over state never fires
    // it — the same hole `createGame`'s own `if (isGameOver(state)) loop.end()`
    // exists to close, and the retire has to be reached from the state for the
    // same reason.
    const dead = buildRig({ layoutId: DEMO_LAYOUT_ID, warmStartTicks: DEMO_DEATH_TICK, fallback: true })
    expect(isGameOver(dead.game.state)).toBe(true)
    expect(dead.game.erase.retired, 'no frame has run, and the button is already gone').toBe(true)
    // Non-vacuous: the same rig one tick short is NOT retired, so this is about
    // the terminal state rather than about the fallback surface.
    const live = buildRig({
      layoutId: DEMO_LAYOUT_ID,
      warmStartTicks: DEMO_DEATH_TICK - 1,
      fallback: true,
    })
    expect(isGameOver(live.game.state)).toBe(false)
    expect(live.game.erase.retired).toBe(false)
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
    const rig = buildRig({ layoutId: DEMO_LAYOUT_ID })
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
    const a = buildRig({ layoutId: DEMO_LAYOUT_ID })
    const b = buildRig({ layoutId: DEMO_LAYOUT_ID })
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
    expect(hashState(a.game.state)).not.toBe(hashState(buildRig({ layoutId: DEMO_LAYOUT_ID }).game.state))
  })

  it('the ring fills long before the city dies, so the warning arrives in time to act', () => {
    // **The other half of the acceptance criterion, and the one that decides
    // whether the ring is a WARNING or an epitaph.** A ring that appears at
    // 3:40 on a board that dies at 3:43 tells the player nothing they can use.
    //
    // Measured rather than asserted loosely: the tick the first ring is drawn,
    // and the fraction of the run that has a ring on screen.
    const rig = buildRig({ layoutId: DEMO_LAYOUT_ID })
    let firstRingTick = -1
    let firstLegibleTick = -1
    let ringFrames = 0
    let frames = 0
    // **The drain count, which is what the ring's own doc comment used to claim
    // a player could read.** A meter that ever falls means the destination was
    // relieved; one that never falls means it was never served.
    const prevMeter = new Uint8Array(rig.game.state.destCell.length)
    const drainFrames = new Int32Array(rig.game.state.destCell.length)
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
      const frame = rig.game.builder.frame
      for (let d = 0; d < frame.destCount; d++) {
        const m = frame.destOvercrowd[d] as number
        if (m < (prevMeter[d] as number)) drainFrames[d] = (drainFrames[d] as number) + 1
        prevMeter[d] = m
      }
      const drawn = rig.ctx.log.some((c) => c.op === 'arc')
      if (drawn) {
        ringFrames++
        if (firstRingTick < 0) firstRingTick = rig.game.state.header[H_TICK] as number
      }
      // A ring at 1/255 is 1.4 degrees of arc — about a pixel. The tick that
      // matters is the one a person can SEE, taken at a tenth of a turn.
      if (firstLegibleTick < 0 && [...frame.destOvercrowd].some((m) => m >= 26)) {
        firstLegibleTick = rig.game.state.header[H_TICK] as number
      }
    }
    expect(isGameOver(rig.game.state)).toBe(true)
    // **Measured on the shipped demo board, and these reproduce exactly** — the
    // sim is deterministic and this rig's frame cadence is fixed, so none of
    // these is a statistical figure:
    //
    // ```
    //                       M1e Task 9        T2 (wide)          T3 (ships)
    //   first ring       tick 3,492  1:56   tick 2,456  1:21.9  tick 3,449  1:55
    //   first LEGIBLE    tick 4,222  2:21   tick 3,186  1:46.2  tick 4,179  2:19.3
    //   death            tick 6,703  3:43   tick 5,757  3:11.9  tick 6,660  3:42
    //   usable warning   2,481 ticks 1:23   2,571 ticks 1:25.7  2,481 ticks 1:22.7
    //   ring on screen   3,212/5,504 58.4 % 3,303/4,559 72.4 %  3,212/5,461 58.8 %
    // ```
    //
    // **Every row moved at M1f Task 2 and the criterion got BETTER; at Task 3
    // every row moved back and it stayed better than the bound.** The wide rule
    // starved this board sooner so the meters started sooner, and the death tick
    // moved less than the warning did. Narrowing the rule to crossing axes
    // returns the usable warning to **exactly 2,481 ticks** and the ring-frame
    // count to **exactly 3,212** — both to the digit, on a run 43 ticks shorter
    // than M1e's, which is a stronger statement about the ring than either
    // reading alone: the warning is a property of the overcrowd ramp and not of
    // the junction rule. The bounds below are unchanged through both moves; they
    // were already looser than the measurement, which is what let them absorb a
    // 946-tick move and then its reversal without being re-fitted.
    //
    // **The warning is measured from the LEGIBLE ring, not the first pixel of
    // one.** A 1.4-degree arc is about one pixel at a 29 px tile; quoting 1:56
    // as the moment the player is warned overstates it by 25 seconds.
    //
    // The bounds below are looser than the measurements on purpose: what has to
    // hold is "the warning arrives with time to act", not "at tick 3,492", and
    // pinning the tick would turn every spawn-tuning change into a failure that
    // says nothing about the ring.
    expect(firstRingTick, 'a ring must appear at all').toBeGreaterThan(0)
    expect(firstLegibleTick, 'a ring must become legible at all').toBeGreaterThan(firstRingTick)
    expect(
      DEMO_DEATH_TICK - firstLegibleTick,
      'a LEGIBLE warning must arrive at least a minute before the end',
    ).toBeGreaterThan(30 * 60)
    expect(
      ringFrames / frames,
      'a ring is on screen for most of the run, not only at the end',
    ).toBeGreaterThan(0.5)

    // ---------------------------------------------------------------------
    // **What the ring actually shows, measured — and it is NOT "fills when
    // congested, drains when served".**
    // ---------------------------------------------------------------------
    // §5.8's meter unwinds at 2,000 milli-ticks a tick while a destination is
    // under capacity, so in principle a served destination's ring falls again.
    // On the boards that ship, a player never sees that: the destination that
    // ends the run has ZERO draining frames on the demo board and on the
    // starting city, and the only demo ring that drains at all peaks at 19/255
    // — 27 degrees of arc — in the last 25 s of a 223 s run.
    //
    // **Task 2's wide rule moved this from an exact zero to one frame in 4,559
    // and the assertion became a RATE; Task 3 puts the exact zero back, and the
    // rate is kept anyway.** Under the wide rule D2 was served exactly once in
    // the whole run, so the literal zero was false while the CLAIM — that a
    // player cannot read this ring as "fills when congested, drains when
    // served" — was not; the rate (1 in 4,559 = 0.022 %) is what made the claim
    // testable without pinning a tick. Under the shipped rule the killer drains
    // on 0 of 5,461 frames again. **The rate bound stays because it is the
    // stronger of the two and it survived a rule change that the literal did
    // not**, and the literal is asserted beside it so the return to zero is on
    // the record rather than absorbed.
    //
    // So the honest reading of a ring on a shipped board is "this destination
    // is not being served and it will end the run", which is a stronger signal
    // than the two-state one, and it is the claim the source now makes.
    const failed = failedDestination(rig.game.state)
    expect(failed).toBeGreaterThanOrEqual(0)
    expect(
      (drainFrames[failed] as number) / frames,
      'the killer’s meter fell often enough to read — the "fills and drains" reading is back',
    ).toBeLessThan(0.001)
    expect(drainFrames[failed], 'and it is an exact zero again — 1 frame under the wide rule').toBe(0)
    // And the discrimination the rate bound needs: SOME destination does drain,
    // and it is NOT the killer, so the zero above is a fact about the killer
    // rather than about the instrument. **The bound was `> 10` against a
    // measured 14 pre-M1f and under the wide rule; the shipped rule measures 3,
    // so the discriminator is re-derived as "a different destination, and the
    // count pinned" rather than left at a threshold the board no longer
    // clears.** 3 frames is a tenth of a second — legible only to the counter,
    // which is the point: nothing on this board reads as "served".
    const bestServed = [...drainFrames].indexOf(Math.max(...drainFrames))
    expect(bestServed, 'the draining destination is not the one that ends the run').not.toBe(failed)
    expect(Math.max(...drainFrames), 'and it drains for 3 frames — 14 pre-M1f and under the wide rule').toBe(3)
    // Non-vacuous on the instrument: it CAN count a drain, and does, on the one
    // destination that gets any relief at all.
    const totalDrains = [...drainFrames].reduce((a, b) => a + b, 0)
    expect(totalDrains, 'no destination ever drained — the counter is not working').toBeGreaterThan(0)
    // Vacuity: the very first frames have NO ring, so this is measuring the
    // meter rather than a ring that is always drawn.
    const fresh = buildRig({ layoutId: DEMO_LAYOUT_ID })
    fresh.advance(TICK_MS)
    expect(fresh.ctx.log.some((c) => c.op === 'arc')).toBe(false)
  })

  it('a game whose state is ALREADY over at boot ends its loop too', () => {
    // **`onGameOver` fires on an EDGE, and a state that was terminal before the
    // first `advance` has no edge to fire on.** Without `createGame`'s own
    // `if (isGameOver(state)) loop.end()` neither `loop.paused` nor `loop.over`
    // is ever set, so the player draws roads that never appear, spends no tiles
    // and gets no message. The same failure `end()` exists to prevent, through
    // a different door.
    //
    // **Both of `down()`'s refusals hang off that one line, which M1e's closing
    // sweep measured by deleting it.** `pointer.ts` refuses board input while
    // paused, and since Task 9 it intercepts `gameOver` FIRST — but `gameOver`
    // is `loop.over`, and `over` is set by `end()` and by nothing else. With
    // the line gone: `over` false, `paused` false, `down` returns `DRAG_START`,
    // `move` returns `DRAW`, and **two road actions reach the queue** on a dead
    // board, with no restart offered. This comment named only the `paused` arm
    // until the sweep; the conclusion was right and the mechanism was half
    // stated, which is the shape that let a review read the whole argument as
    // dead.
    //
    // Unreachable from the shipped layouts — `layouts.test.ts` drives every
    // registered layout's own warm start and asserts it survives it — and it
    // stops being unreachable the moment M3's restore hands `createGame` a
    // saved game-over state. Constructed here by the shortest honest route: a
    // warm start long enough to kill the board it runs on.
    //
    // `DEMO_DEATH_TICK` is the demo board's death tick — 5,757 as of M1f Task 2 —
    // so a warm start of exactly that many ticks boots a game that has already lost.
    // Read from the constant and never spelled, so the day it moves again this
    // rig moves with it instead of booting a live board and asserting on a corpse.
    const dead = buildRig({ layoutId: DEMO_LAYOUT_ID, warmStartTicks: DEMO_DEATH_TICK })
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

// ---------------------------------------------------------------------------
// The board a plain load opens — M1e Task 10's flip, seen from the phone
// ---------------------------------------------------------------------------

/**
 * **The flip's player-visible consequence, and it is not the tick.**
 *
 * `DEFAULT_LAYOUT_ID` moved from `demo` to `city`, so a plain load now dies at
 * **5,580** (3 min 06 s) instead of 6,703 (3 min 43 s). That much is
 * bookkeeping. What actually changes on the screen is the FIRST LINE of the
 * shutdown copy, because Task 9 keyed it on whether any road reaches the dying
 * destination's carpark:
 *
 * | board a plain load opens | dies | killer | its carpark | first line |
 * |---|---|---|---|---|
 * | demo (M1d - M1e Task 9) | 6,703 | D2, corridor C | ON the network, joined to its own colour | `DESTINATION 2 WENT UNSERVED` |
 * | city (M1e Task 10 on)   | 5,580 | D2, colour-1 circle | BARE | `NOTHING CAN REACH DESTINATION 2` |
 *
 * **The wording changed at M1f and the arms did not.** The line used to read
 * `NO ROAD REACHES DESTINATION n` and was decided by `roads[carpark] !== 0`,
 * which a single tile on the bay satisfies — so a player who started the stroke
 * was told the road had arrived. The predicate is now "a house of this
 * destination's colour is in the same road component as its bay", and the
 * sentence says what the predicate means. Both boards still produce the arm
 * they always did: the demo's D2 is joined to its own colour and reads
 * `WENT UNSERVED`; the city's D2 is bare and reads `NOTHING CAN REACH`.
 *
 * Task 9's own comment says both arms are reachable on the shipped boards; this
 * is the case that says which arm the DEFAULT produces, and it is the one that
 * would have to change if the copy did. It is a better default than the demo's
 * on exactly this axis: the roadless line names a remedy the player can act on
 * in four `place` actions, and `startingCity.test.ts` proves those four remove
 * this death entirely.
 */
describe('the board a plain load opens stops dead, and says the unreachable thing', () => {
  it('dies unprompted at 3 min 06 s and blames a destination NOTHING CAN REACH', () => {
    // `layoutId: undefined` reaches `createGame` with the property genuinely
    // absent — see `buildRig`'s note — so this is what a player who taps the
    // bot link with no parameters gets.
    const rig = buildRig({ layoutId: undefined })
    expect(rig.game.layoutId, 'this must be whatever a plain launch opens').toBe(DEFAULT_LAYOUT_ID)
    expect(rig.game.layoutId, 'and Task 10 made that the city').toBe(CITY_LAYOUT_ID)

    let frames = 0
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
    }
    expect(isGameOver(rig.game.state), 'the default board must end a run on its own').toBe(true)
    expect(rig.game.state.header[H_TICK]).toBe(CITY_DEATH_TICK)
    expect(Math.round(CITY_DEATH_TICK / 30), 'which is 186 s — 3 min 06 s at 30 Hz').toBe(186)
    // Strictly EARLIER than the board this replaced, so the two death ticks
    // cannot be confused for each other and a copy-paste of the old constant
    // fails rather than passing by luck.
    expect(CITY_DEATH_TICK).toBeLessThan(DEMO_DEATH_TICK)
    expect(rig.game.loop.over).toBe(true)
    expect(rig.game.loop.paused).toBe(true)

    rig.ctx.log = []
    rig.advance(TICK_MS)
    const frame = rig.game.builder.frame
    expect(frame.gameOver).toBe(true)
    const failed = frame.failedDest
    expect(failed, 'the seeded colour-1 circle, D2').toBe(2)

    // **The discriminator between the two arms, asserted before the copy** —
    // otherwise "the line says NO ROAD" is a claim about a string rather than
    // about the board. D2's carpark is (17, 14) and no input laid anything.
    const carpark = frame.destCarpark[failed] as number
    expect(carpark, 'D2 opens EAST, so its carpark is (17, 14)').toBe(14 * 24 + 17)
    expect(rig.game.state.roads[carpark] as number, 'not a tile of road on it').toBe(0)
    expect(frame.destReachable[failed] as number, 'and so nothing can reach it').toBe(0)

    const scrimIndex = rig.ctx.log.findIndex(
      (c) => c.op === 'fill' && c.style === PALETTE.scrim,
    )
    expect(scrimIndex, 'the board must go dark').toBeGreaterThanOrEqual(0)
    const said = rig.ctx.log
      .slice(scrimIndex + 1)
      .filter((c): c is TextCommand => c.op === 'text')
      .map((c) => c.text)
    expect(said).toEqual([
      `NOTHING CAN REACH DESTINATION ${failed}`,
      'CONNECT EVERY DESTINATION WITH A ROAD',
      `${rig.game.state.header[H_SCORE] as number} TRIPS`,
      'TAP TO PLAY AGAIN',
    ])
    // ...and the OTHER arm is not what this board produces. Asserted as an
    // absence because the two strings share every word but two, and a
    // `toContain` over the line would be satisfied by either.
    for (const line of said) expect(line).not.toContain('WENT UNSERVED')
    for (const line of said) expect(line).not.toContain('CROWD')
    // With no road there is no trip, so the count is honestly zero — and that
    // is the line a player reads under the blame.
    expect(rig.game.state.header[H_SCORE] as number).toBe(0)
  })

  it('rings the destination that did it, long enough before the end to act on', () => {
    // The same claim Task 9 measured on the demo board, re-measured on the
    // board that now ships. D2 reaches its trigger cap of 8 on tick 2,191 and
    // the run ends at 5,580, so a ring is up for most of the run.
    //
    // **The usable warning is 2,481 ticks — 1 min 23 s — and it is the SAME
    // number the demo board gives.** That is a derivation, not a coincidence
    // and not a copied literal: on both boards the killer is never served, so
    // its meter only ever climbs, and the interval between "the ring reaches
    // 26/255" and "the meter completes" is a pure function of §5.8's ramp. The
    // bound below is therefore the demo case's bound, unchanged, and it is
    // looser than the measurement on purpose — what has to hold is "the warning
    // arrives with time to act", not "at tick 3,099".
    const rig = buildRig({ layoutId: undefined })
    let firstRingTick = -1
    let firstLegibleTick = -1
    let ringFrames = 0
    let frames = 0
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
      if (rig.ctx.log.some((c) => c.op === 'arc')) {
        ringFrames++
        if (firstRingTick < 0) firstRingTick = rig.game.state.header[H_TICK] as number
      }
      if (
        firstLegibleTick < 0 &&
        [...rig.game.builder.frame.destOvercrowd].some((m) => m >= 26)
      ) {
        firstLegibleTick = rig.game.state.header[H_TICK] as number
      }
    }
    expect(isGameOver(rig.game.state)).toBe(true)
    expect(firstRingTick, 'a ring must appear at all').toBeGreaterThan(0)
    expect(firstLegibleTick, 'a ring must become legible at all').toBeGreaterThan(firstRingTick)
    expect(
      CITY_DEATH_TICK - firstLegibleTick,
      'a LEGIBLE warning must arrive at least a minute before the end',
    ).toBeGreaterThan(30 * 60)
    expect(
      ringFrames / frames,
      'a ring is on screen for most of the run, not only at the end',
    ).toBeGreaterThan(0.5)
    // Vacuity, exactly as the demo case takes it: the first frames have NO
    // ring, so this is measuring a meter rather than an arc that is always
    // drawn.
    const fresh = buildRig({ layoutId: undefined })
    fresh.advance(TICK_MS)
    expect(fresh.ctx.log.some((c) => c.op === 'arc')).toBe(false)
  })

  it('takes the erase control off the screen and lets a tap start a new run', () => {
    // The two things a player can still do at a shutdown, on the board they
    // actually get. Both are Task 9's; this is the case that says they are
    // reached on the DEFAULT rather than only behind `?layout=demo`.
    const rig = buildRig({ layoutId: undefined, fallback: true })
    expect(rig.game.erase.retired, 'vacuity: live, the control is on screen').toBe(false)
    let frames = 0
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
    }
    expect(rig.game.state.header[H_TICK]).toBe(CITY_DEATH_TICK)
    expect(rig.game.erase.retired, 'the button outlived the city').toBe(true)
    expect(rig.game.pointer.down(1, rig.cx(9), rig.cy(20))).toBe(PointerOutcome.RESTART_REQUESTED)
    expect(rig.restarts, 'one tap, one new run').toBe(1)
    expect(rig.game.queue.inputs.actions.length, 'and nothing reached the queue').toBe(0)
  })
})

/**
 * M1f — THE RED BAY MEANS "NOTHING CAN REACH THIS", NOT "A ROAD BIT IS HERE"
 * ---------------------------------------------------------------------------
 *
 * **This block is a user's bug report, transcribed.** M1e Task 9 painted a
 * destination's bay in the alarm colour when its carpark carried no road bit,
 * and documented at the call site that the predicate is *necessary and not
 * sufficient*. It shipped, and the first person to play it broke it inside a
 * minute:
 *
 * > *"the red dot turns black when i start drawing a road from it and when i
 * > remove it turns red again, no matter how many dots are on the parking lot."*
 *
 * One road tile on the bay, connected to nothing, and the game says the
 * destination is fine. It is not: `assembleSources` (dispatch.ts) seeds a
 * colour's flow field from carparks, `dispatch` reads `dist[houseCell]`, and a
 * house that is not in the same road component as the bay has `dist = INF`
 * forever. The stub buys **zero** arrivals — asserted below, not asserted
 * about.
 *
 * The observable is the recorded `fillRect` in `PALETTE.overcrowd`, which is
 * the bay and nothing else in the whole draw path (`canvas.ts` uses that colour
 * for one fill and one stroke; the stroke is the overcrowd ring and is recorded
 * as an `arc`). Read off the draw log rather than off `RenderFrame`, so a fold
 * that computes the right byte and a renderer that ignores it still fails here.
 */
describe('the red bay says nothing can REACH the destination, not that a road bit is on it', () => {
  const CITY_W = 24
  /** D2 opens EAST, so its bay is (17, 14). Pinned by the case below, not assumed. */
  const D2_BAY = 14 * CITY_W + 17
  /** (17, 15) — the second cell of the stroke a player starts at the bay. */
  const D2_BELOW = 15 * CITY_W + 17
  /** The S bit: DIRS is N-clockwise, so index 4, `1 << 4`. */
  const ROAD_S = 16

  const redBays = (rig: Rig): number =>
    rig.ctx.log.filter((c) => c.op === 'fill' && c.style === PALETTE.overcrowd).length

  it('does NOT turn the bay grey for a single road tile that reaches nothing', () => {
    const rig = buildRig({ layoutId: undefined })
    rig.oneTick(0.5)
    const state = rig.game.state
    expect(state.header[H_DEST_COUNT] as number, 'the city seeds three destinations').toBe(3)
    expect(rig.game.builder.frame.destCarpark[2] as number, 'D2 opens EAST').toBe(D2_BAY)
    expect(state.roads[D2_BAY] as number, 'and no input has laid anything on it').toBe(0)
    expect(redBays(rig), 'every seeded bay is bare, so every one of the three is red').toBe(3)

    // *"i start drawing a road from it"* — one `place`, the bay and the cell
    // below it, through the queue `pointer.ts` writes to.
    rig.game.queue.enqueue('place', D2_BAY, D2_BELOW)
    rig.oneTick(0.5)
    expect(state.roads[D2_BAY] as number, 'the stub really did land on the bay').toBe(ROAD_S)
    expect(
      redBays(rig),
      'a stub that reaches no house of D2’s colour must leave the bay RED',
    ).toBe(3)

    // *"and when i remove it turns red again"* — the second half of the report
    // is about a signal that flips, so the erase is driven too. It must be a
    // no-op on the colour, because the stub never changed anything.
    rig.game.queue.enqueue('erase', D2_BAY, D2_BELOW)
    rig.oneTick(0.5)
    expect(state.roads[D2_BAY] as number, 'the stub is gone').toBe(0)
    expect(redBays(rig), 'and the bay was red the whole time').toBe(3)
  })

  it('turns the bay grey for a road that actually reaches a house of its own colour', () => {
    // The non-vacuity half, and the reason the case above is not satisfied by
    // "the bay is always red". `D2_LINK` is the five-cell column from D2's bay
    // to its own colour-1 house at (17, 18) — the stroke the shutdown screen is
    // asking the player for.
    const rig = buildRig({ layoutId: undefined })
    rig.oneTick(0.5)
    expect(redBays(rig)).toBe(3)
    for (let i = 0; i + 1 < D2_LINK.length; i++) {
      rig.game.queue.enqueue('place', D2_LINK[i] as number, D2_LINK[i + 1] as number)
    }
    rig.oneTick(0.5)
    expect(rig.game.state.roads[D2_BAY] as number, 'the link starts at the bay').not.toBe(0)
    expect(redBays(rig), 'D2 is connected now, so only D0 and D1 stay red').toBe(2)
  })

  it('is not a promise about pins: the stub buys zero arrivals and the run still ends on D2', () => {
    // The second clause of the report — *"no matter how many dots are on the
    // parking lot"* — is a different expectation, and this is the case that
    // says the colour is right to ignore it. Pins are demand; the bay is
    // reachability. What makes the RED honest is that the stub changes nothing
    // the sim does: same killer, same death tick, zero score.
    const rig = buildRig({ layoutId: undefined })
    rig.oneTick(0.5)
    rig.game.queue.enqueue('place', D2_BAY, D2_BELOW)
    rig.oneTick(0.5)
    expect(rig.game.state.roads[D2_BAY] as number).toBe(ROAD_S)
    let frames = 0
    while (!isGameOver(rig.game.state) && frames < 20000) {
      rig.advance(TICK_MS)
      frames++
    }
    expect(isGameOver(rig.game.state), 'the stubbed board still dies').toBe(true)
    expect(rig.game.state.header[H_TICK] as number, 'on the very same tick').toBe(CITY_DEATH_TICK)
    expect(failedDestination(rig.game.state), 'killed by the destination the stub touched').toBe(2)
    expect(rig.game.state.header[H_SCORE] as number, 'and it never took a single trip').toBe(0)
    expect(redBays(rig), 'the bay it lied about is red on the frame the run ends').toBeGreaterThan(0)
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
    expect(result?.layoutId).toBe('city')
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

// ---------------------------------------------------------------------------
// M1f TASK 7 — THE WEEK BOUNDARY STOPS THE BOARD
// ---------------------------------------------------------------------------

/**
 * §5.10's weekly offer, reaching the shell — and **the first change in this
 * milestone a player cannot miss.**
 *
 * Six tasks in a row have shipped "a human sees nothing". This one stops the
 * board, on the board a plain load opens, at a time this block asserts rather
 * than asserts around. Everything here is driven through `advanceRaw`, which is
 * `advance` with the card policy switched off: the policy is what keeps the
 * other nine drive loops in this file alive, and a test OF the pause must be
 * able to sit inside it.
 */
/**
 * One frame that advances EXACTLY one tick, **with the card policy off**.
 *
 * `buildRig`'s `oneTick` without the policy: the delta is self-correcting
 * against the live accumulator, so it cannot drift into the zero-tick /
 * two-tick alternation that `now += TICK_MS` produces (`driveArm`'s own note
 * measures it). **After a resume it still runs zero ticks** — `resetClock`
 * forces `rawDt` to 0 whatever the delta says — which is the property the
 * two-frame cases below are about.
 */
function rawTick(rig: Rig): number {
  return rig.advanceRaw(TICK_MS + 0.5 * TICK_MS - rig.game.loop.accumulator)
}

describe('the weekly card offer stops the board', () => {
  it('stops the board a plain load opens at 2:21.4 on a stopwatch, with no card and no way past it', () => {
    const rig = buildRig({ layoutId: undefined })
    expect(rig.game.layoutId, 'the board a plain load opens').toBe(DEFAULT_LAYOUT_ID)
    expect(rig.game.warmStartTicks, "the city's own warm start").toBe(WARM_START_TICKS)

    // 60 Hz frames — a real display, and the cadence that makes the claim below
    // exact: at 16.7 ms every frame runs 0 or 1 ticks, never 2, so the pause
    // lands ON the boundary tick and not up to 6 past it. `loop.test.ts`'s
    // *"a pause raised from INSIDE advance"* owns the other end of that range.
    let frames = 0
    while (!rig.game.loop.paused && frames < 20000) {
      rig.advanceRaw(16.7)
      frames++
    }

    expect(rig.game.loop.paused, 'the board stopped, unprompted').toBe(true)
    expect(rig.game.state.header[H_TICK], 'on the week-1 boundary tick itself').toBe(TICKS_PER_WEEK)
    expect(offerPending(rig.game.state), 'because the sim raised an offer').toBe(true)

    // **The stopwatch reading, in §14's units — `(tick - warmStart) / 30`.**
    // (4500 - 258) / 30 = 141.4 s = 2 min 21.4 s. The raw tick counter says
    // 150.0 s; the two are different counters and this says which is which.
    expect((TICKS_PER_WEEK - WARM_START_TICKS) / TICKS_PER_SECOND).toBeCloseTo(141.4, 1)
    expect(Math.floor(141.4 / 60), 'minutes').toBe(2)
    expect(TICKS_PER_WEEK / TICKS_PER_SECOND, 'and the raw-counter reading, which is NOT it').toBe(150)

    // What a person sees, in the three things the frame carries. The HUD clock
    // stops at week 1 day 0 and the pause bars go up beside it (`canvas.ts`
    // draws them on `frame.paused && !frame.gameOver`).
    const frame = rig.game.builder.frame
    expect(frame.paused, 'the pause bars are drawn').toBe(true)
    expect(frame.gameOver, 'and they are not the shutdown scrim').toBe(false)
    expect([frame.week, frame.day], 'the clock stops here').toEqual([1, 0])
    expect(frame.offerPending, 'and Task 8 has three fields to draw a modal from').toBe(true)

    // **And the HUD clock is not a way past it.** The pause fires on the
    // CONDITION, so a tap buys exactly one tick and the next drained tick
    // re-arms it. Until M1f Task 8 that left the board with no way out at all,
    // interlocked by a deliberately red `offerInterlock.test.ts`; the way out
    // now is the modal, and the case below drives it from a screen coordinate.
    const tapClock = (): void => {
      rig.game.loop.setPaused(false)
      // Two frames, and `rawTick` rather than 16.7 ms: the first frame after
      // any resume runs zero ticks whatever its length, and at 60 Hz the
      // second one only drains if the frozen accumulator happened to be over
      // half a tick. One tick per tap is the honest count.
      rawTick(rig)
      rawTick(rig)
    }
    const before = rig.game.state.header[H_TICK] as number
    for (let taps = 0; taps < 5; taps++) tapClock()
    expect(
      (rig.game.state.header[H_TICK] as number) - before,
      'five taps, five ticks — 4,500 to a week, so this is not an escape',
    ).toBe(5)
    expect(rig.game.loop.paused, 'and it is stopped again after every one').toBe(true)
  })

  it('re-pauses when anything resumes with an offer still up — and it takes TWO frames', () => {
    // **The condition, not the edge, and the two-frame count is `loop.ts`
    // rather than a tolerance.** `setPaused(false)` sets `resetClock`, so the
    // next `frame(now)` assigns `lastTime = now` before computing `rawDt`:
    // `rawDt` is 0, the accumulator is untouched, and that frame runs ZERO
    // ticks. `advance` is never called, so nothing can re-raise the pause. The
    // SECOND frame is the first one that can drain, and it re-arms.
    //
    // An EDGE-fired callback leaves the board running here for the rest of the
    // week with a modal over it. That is mutant 1 of this task's table and this
    // is its end-to-end detector.
    const rig = buildRig({ layoutId: undefined, warmStartTicks: TICKS_PER_WEEK - 1 })
    expect(rig.game.state.header[H_TICK]).toBe(TICKS_PER_WEEK - 1)
    expect(offerPending(rig.game.state), 'still week 0 — no offer yet').toBe(false)

    rig.advanceRaw(16.7) // the clock reference: zero ticks, by construction
    while (!rig.game.loop.paused) rig.advanceRaw(16.7)
    expect(rig.game.state.header[H_TICK]).toBe(TICKS_PER_WEEK)

    rig.game.loop.setPaused(false)
    expect(rawTick(rig), 'the first frame after ANY resume runs no ticks').toBe(0)
    expect(rig.game.loop.paused, 'so nothing could have re-armed it yet').toBe(false)
    expect(rawTick(rig), 'the second frame is the first that can drain').toBe(1)
    expect(rig.game.loop.paused, 'and the condition re-armed on it').toBe(true)
  })

  it('does not pause ten ticks short of the boundary, and the offer is not up either', () => {
    const rig = buildRig({ layoutId: undefined, warmStartTicks: TICKS_PER_WEEK - 11 })
    for (let f = 0; f < 21; f++) rig.advanceRaw(16.7)
    expect(rig.game.state.header[H_TICK], 'ten ticks short').toBe(TICKS_PER_WEEK - 1)
    expect(offerPending(rig.game.state)).toBe(false)
    expect(rig.game.loop.paused).toBe(false)
    expect(rig.game.builder.frame.offerPending).toBe(false)
    expect(rig.game.builder.frame.offerA).toBe(0)
  })

  it('carries the offer onto the render frame, and stops carrying it the tick it is taken', () => {
    const rig = buildRig({ layoutId: undefined, warmStartTicks: TICKS_PER_WEEK - 1 })
    rig.advanceRaw(16.7)
    while (!rig.game.loop.paused) rig.advanceRaw(16.7)

    const frame = rig.game.builder.frame
    // Against the header, which is where the cards actually are — and both
    // slots are real, distinct, implemented cards.
    expect(frame.offerA).toBe(rig.game.state.header[H_OFFER_A])
    expect(frame.offerB).toBe(rig.game.state.header[H_OFFER_B])
    expect(new Set([frame.offerA, frame.offerB]).size, 'two DIFFERENT cards').toBe(2)
    expect([1, 7], 'and both are in CARD_IMPLEMENTED_MASK').toContain(frame.offerA)
    expect([1, 7]).toContain(frame.offerB)
    expect(frame.offerA).toBe(offerSlot(rig.game.state, 0))

    // Take slot A through the queue, exactly as the policy and Task 8's pointer
    // will, and let the two frames a resume costs run.
    const tilesBefore = tilesLeft(rig.game.state)
    const taken = frame.offerA
    expect(takeCardPolicy(rig.game, 0), 'the policy fires while the modal is up').toBe(true)
    expect(rawTick(rig), 'the resume frame drains nothing').toBe(0)
    expect(rawTick(rig), 'and the next one applies the choice').toBe(1)

    expect(rig.game.loop.paused, 'the board runs again').toBe(false)
    expect(rig.game.state.header[H_OFFER_WEEK], 'the week is resolved').toBe(1)
    // §5.10's grants, hand-carried: ROAD TILES (1) pays 30 tiles and 0 items,
    // JUNCTION UPGRADE (7) pays 20 tiles and 2 items.
    expect(tilesLeft(rig.game.state) - tilesBefore).toBe(taken === 1 ? 30 : 20)
    expect(rig.game.state.header[H_INV_UPGRADES]).toBe(taken === 1 ? 0 : 2)

    // **And the frame stops reporting an offer, while the HEADER still holds
    // the cards.** `applyChooseCard` never clears the slots, so a `buildFrame`
    // reading them directly would draw this week's modal over every remaining
    // frame of the run.
    expect(frame.offerPending).toBe(false)
    expect(frame.offerA, 'reads as no offer').toBe(0)
    expect(frame.offerB).toBe(0)
    expect(rig.game.state.header[H_OFFER_A], 'while the header still holds the raw card').toBe(taken)
    expect(rig.game.state.header[H_OFFER_A]).not.toBe(0)

    // ...and it does not come back until the NEXT boundary.
    for (let f = 0; f < 40; f++) rawTick(rig)
    expect(rig.game.loop.paused).toBe(false)
    expect(rig.game.builder.frame.offerPending).toBe(false)
  })

  it('takes a card from a TAP at the drawn rect, and the board runs on with the tiles', () => {
    // ---------------------------------------------------------------------
    // **THE MILESTONE'S ACCEPTANCE CRITERION, DRIVEN END TO END — M1f Task 8.**
    // ---------------------------------------------------------------------
    //
    // *At 2:21 on the board a plain load opens, the board dims and two cards
    // appear. The player taps one. The modal goes, the board runs again, and
    // the tile counter in the HUD is 20 or 30 higher than it was.*
    //
    // **This is the first test in the repo that exercises a player decision
    // from a screen coordinate to a header slot**, and it is the one that would
    // catch a rect/draw mismatch that both packages' own tests miss: `render`
    // asserts the faces are drawn at `offerRects`, `game` asserts the hit test
    // reads `offerRects`, and only a rig with a real camera, a real pointer and
    // a real sim can say the two are the same rectangle on the same screen.
    //
    // Deliberately the DEFAULT layout at its own warm start — no `layoutId`, no
    // `warmStartTicks` — because the criterion is about the board that boots,
    // not about a fixture built to reach the boundary quickly.
    const rig = buildRig({ layoutId: undefined })
    expect(rig.game.layoutId).toBe(DEFAULT_LAYOUT_ID)

    let frames = 0
    while (!rig.game.loop.paused && frames < 20000) {
      rig.advanceRaw(16.7)
      frames++
    }
    expect(rig.game.loop.paused, 'the board stopped at the boundary').toBe(true)
    expect(rig.game.state.header[H_TICK]).toBe(TICKS_PER_WEEK)
    expect(offerPending(rig.game.state)).toBe(true)

    // **The stopwatch reading a person would take**, in §14's units: the frame
    // count is the wall clock, because every one of them was 16.7 ms.
    expect((frames * 16.7) / 1000, 'a shade over 2:21 of real time').toBeCloseTo(141.7, 0)

    const frame = rig.game.builder.frame
    expect(frame.offerPending, 'and the modal has something to draw').toBe(true)
    expect(new Set([frame.offerA, frame.offerB]).size, 'two DIFFERENT cards').toBe(2)

    // The card the player is aiming at: whichever slot holds the junction
    // upgrade, so the assertions below are about a specific card rather than
    // about a slot the draw happens to have filled. Both slots are exercised
    // across the file — `takeCardPolicy` always takes slot A.
    const upgradeInB = frame.offerB === CARD_JUNCTION_UPGRADE
    expect(upgradeInB || frame.offerA === CARD_JUNCTION_UPGRADE, 'the pool offers it').toBe(true)
    const rects = offerRects(rig.game.shell.camera, createOfferRects())
    const target: Rect = upgradeInB ? rects.cardB : rects.cardA

    // The frame the player is looking at reads exactly what the modal draws:
    // §5.10's grants, hand-carried as literals rather than computed from the
    // functions under test.
    expect(upgradeInB ? frame.offerGrantB : frame.offerGrantA, '20 tiles').toBe(CARD_GRANT_ITEM)
    expect(upgradeInB ? frame.offerItemsB : frame.offerItemsA, 'and two of them').toBe(
      UPGRADES_PER_CARD,
    )
    expect(CARD_GRANT_ITEM).toBe(20)
    expect(UPGRADES_PER_CARD).toBe(2)

    const tilesBefore = tilesLeft(rig.game.state)
    expect(rig.game.state.header[H_INV_UPGRADES], 'nothing held yet').toBe(0)

    // **The tap. A client point, at the centre of the rect the renderer filled
    // with `PALETTE.cardFace` on the frame above.**
    const clientX = CANVAS_LEFT + target.x + target.w / 2
    const clientY = CANVAS_TOP + target.y + target.h / 2
    expect(rig.game.pointer.down(1, clientX, clientY)).toBe(PointerOutcome.CARD_CHOSEN)
    expect(rig.game.loop.paused, 'the tap resumed the loop').toBe(false)

    // Two frames: the first after any resume runs zero ticks (`resetClock`), the
    // second drains the tick that applies the choice.
    expect(rawTick(rig), 'the resume frame drains nothing').toBe(0)
    expect(rawTick(rig), 'and the next one applies the choice').toBe(1)

    expect(rig.game.state.header[H_INV_UPGRADES], 'two junction upgrades held').toBe(
      UPGRADES_PER_CARD,
    )
    expect(tilesLeft(rig.game.state) - tilesBefore, 'and the tile counter jumped by 20').toBe(
      CARD_GRANT_ITEM,
    )
    expect(rig.game.state.header[H_OFFER_WEEK], 'the week is resolved').toBe(1)
    expect(rig.game.loop.paused, 'the board is running').toBe(false)
    expect(rig.game.builder.frame.offerPending, 'and the modal is gone').toBe(false)
    expect(rig.game.builder.frame.tilesLeft, 'the HUD shows the new number').toBe(
      tilesLeft(rig.game.state),
    )

    // ...and it keeps running, rather than re-arming on the next drained tick.
    for (let f = 0; f < 40; f++) rawTick(rig)
    expect(rig.game.loop.paused).toBe(false)
    expect(rig.game.state.header[H_TICK]).toBeGreaterThan(TICKS_PER_WEEK)
  })

  it('shows the frozen board under the modal without letting the clock move', () => {
    // **The peek clause of the milestone's acceptance criterion, end to end**
    // (plan Decision 16). Peek is the one part of the modal whose wiring
    // crosses all three packages and is invisible in each: `pointer.ts` owns
    // the flag, `main.ts` hands it to the driver as `() => pointer.peeking`,
    // `buildFrame` folds it, and `canvas.ts` reads it. Only a rig with all four
    // can say the chain is joined.
    const rig = buildRig({ layoutId: undefined, warmStartTicks: TICKS_PER_WEEK - 1 })
    rig.advanceRaw(16.7)
    while (!rig.game.loop.paused) rig.advanceRaw(16.7)
    expect(rig.game.builder.frame.offerPending).toBe(true)
    expect(rig.game.builder.frame.offerPeek, 'the modal opens showing itself').toBe(false)

    const rects = offerRects(rig.game.shell.camera, createOfferRects())
    const tickBefore = rig.game.state.header[H_TICK] as number
    expect(rig.game.pointer.down(1, ...[CANVAS_LEFT + rects.peek.x + rects.peek.w / 2,
      CANVAS_TOP + rects.peek.y + rects.peek.h / 2] as [number, number])).toBe(
      PointerOutcome.PEEK_TOGGLED,
    )
    // **The loop is still paused, and that is the whole rule.** A peek that
    // resumed the sim would be a free unpause with no cost: hold it for the
    // rest of the week and the offer is gone.
    expect(rig.game.loop.paused, 'peek inspects; it does not skip').toBe(true)

    // Frames keep drawing — that is what makes a peek visible at all — and the
    // frame reports the board, not the modal.
    for (let f = 0; f < 30; f++) rawTick(rig)
    const frame = rig.game.builder.frame
    expect(frame.offerPeek, 'the renderer is told to stand aside').toBe(true)
    expect(frame.offerPending, 'while the offer is still up').toBe(true)
    expect(rig.game.state.header[H_TICK], 'and the clock did not move').toBe(tickBefore)
    expect(rig.game.queue.length, 'nothing reached the sim').toBe(0)

    // Any tap returns, and the card is takeable again from the same rect.
    expect(rig.game.pointer.down(2, rig.cx(10), rig.cy(14))).toBe(PointerOutcome.PEEK_TOGGLED)
    expect(rig.game.pointer.peeking, 'the flag is down the moment the tap lands').toBe(false)
    // `builder.frame` is the LAST frame built, so it still says `true` here —
    // asserting it now would be asserting that the tap redraws the screen
    // synchronously, which no input in this codebase does. The next frame is
    // where the renderer finds out.
    expect(rig.game.builder.frame.offerPeek, 'the drawn frame is still last frame’s').toBe(true)
    rawTick(rig)
    expect(rig.game.builder.frame.offerPeek, 'and the next frame agrees').toBe(false)
    expect(
      rig.game.pointer.down(3, CANVAS_LEFT + rects.cardA.x + 4, CANVAS_TOP + rects.cardA.y + 4),
    ).toBe(PointerOutcome.CARD_CHOSEN)
  })

  it('gives the modal the whole screen: the erase control leaves and comes back', () => {
    // **The scrim is canvas paint and the erase control is not** — on Telegram
    // it is the native full-width `MainButton`, outside the webview's content
    // area entirely. Left alone, the largest and brightest thing on a screen
    // asking the player to choose a card is a button reading ERASE ROADS. M1e
    // shipped exactly that under the shutdown screen and it took a user to
    // notice; this is the same defect through a different door.
    const rig = buildRig({ layoutId: undefined, fallback: true, warmStartTicks: TICKS_PER_WEEK - 1 })
    expect(rig.game.erase.surface, 'the DOM pill, since Node has no Telegram').toBe(
      EraseControlSurface.DOM_NO_TELEGRAM,
    )
    expect(rig.game.erase.suspended, 'live at boot').toBe(false)

    rig.advanceRaw(16.7)
    while (!rig.game.loop.paused) rig.advanceRaw(16.7)
    expect(offerPending(rig.game.state)).toBe(true)
    expect(rig.game.builder.frame.offerPending, 'the frame the suspension is driven off').toBe(true)
    expect(rig.game.erase.suspended, 'and the control left the screen with it').toBe(true)

    const rects = offerRects(rig.game.shell.camera, createOfferRects())
    rig.game.pointer.down(1, CANVAS_LEFT + rects.cardA.x + 4, CANVAS_TOP + rects.cardA.y + 4)
    rawTick(rig)
    rawTick(rig)
    expect(rig.game.builder.frame.offerPending).toBe(false)
    expect(rig.game.erase.suspended, 'and it came back when the modal did').toBe(false)
    expect(rig.game.erase.retired, 'without being retired on the way').toBe(false)
  })

  it('declines a DEAD board, so a rig that keeps drawing does not fill a queue nothing drains', () => {
    // **The `over` guard in `takeCardPolicy`, which scored 0 detectors until
    // this case existed.** `step` is a byte-identical no-op past a game over, so
    // `H_OFFER_WEEK` can never catch up and `offerPending` stays TRUE for the
    // rest of the process; `end()` leaves `paused` true and refuses every
    // `setPaused`. A policy guarded only on "a modal would be up" therefore
    // fires on EVERY frame of every dead-board case in this file — and this file
    // has several, deliberately, because the draw path must keep running behind
    // the scrim — enqueueing one `choose-card` per frame into a queue no tick
    // will ever drain and growing the action pool without bound inside the
    // allocation windows.
    const rig = buildRig({ layoutId: DEMO_LAYOUT_ID, warmStartTicks: DEMO_DEATH_TICK })
    expect(isGameOver(rig.game.state), 'dead at boot').toBe(true)
    expect(rig.game.loop.over, 'and the loop knows').toBe(true)
    expect(
      offerPending(rig.game.state),
      'while the offer raised at 4,500 is pending forever — the sim is frozen, so nothing resolves it',
    ).toBe(true)

    const poolBefore = rig.game.queue.poolSize
    for (let f = 0; f < 40; f++) rig.advance(16.7)
    expect(rig.cardsTaken, 'the policy declined every one of the forty').toBe(0)
    expect(rig.game.queue.length, 'and enqueued nothing').toBe(0)
    expect(rig.game.queue.poolSize, 'so the action pool did not grow').toBe(poolBefore)
  })

  it('freezes the demo board mid-traffic, with the cars a measured 0.09-0.22 cells short of the sim', () => {
    // **The city is the wrong board for this claim and the demo is the right
    // one.** With no input the starting city has no road, so no car ever
    // leaves its house — `maxInFlight` is 0 on its no-input arm — and "the cars
    // freeze" would be satisfied by a board on which nothing was moving. The
    // demo board seeds 71 road cells and carries 15+ cars in flight.
    const rig = buildRig({ layoutId: DEMO_LAYOUT_ID, warmStartTicks: TICKS_PER_WEEK - 1 })
    rig.advanceRaw(16.7)
    while (!rig.game.loop.paused) rig.advanceRaw(16.7)
    expect(rig.game.state.header[H_TICK]).toBe(TICKS_PER_WEEK)

    const frame = rig.game.builder.frame
    const snaps = rig.game.builder.snapshots
    expect(frame.carCount, 'cars on the board').toBeGreaterThanOrEqual(15)

    // The picture is a still one: frames of different lengths, so a residual
    // accumulator or a live alpha would show as movement.
    const drawn = (): string => Array.from(frame.carXY.slice(0, frame.carCount * 2)).join(',')
    const still = drawn()
    for (let k = 0; k < 30; k++) rig.advanceRaw(20 + (k % 7) * 5)
    expect(drawn(), 'the board is a still image while the offer is up').toBe(still)
    expect(rig.game.loop.ticksLastFrame, 'and no tick ran').toBe(0)

    // ---------------------------------------------------------------------
    // **THE CARS DO NOT SETTLE, AND M1f IS WHAT GIVES THAT AN AUDIENCE.**
    // ---------------------------------------------------------------------
    //
    // The drawn position chases the sim position inside the drain; pausing
    // stops the drain, so the chase stops wherever it was. Until this task the
    // only pauses were a HUD-clock tap and the terminal freeze; from this task
    // the weekly modal holds one for as long as the player takes to choose,
    // four times a run. Measured here and bounded by the same derivation
    // `resolve.ts` carries: `MAX_DRAW_LAG_CELLS + MAX_SIM_CELLS_PER_TICK`.
    let worst = 0
    let n = 0
    for (let i = 0; i < snaps.slots; i++) {
      if ((snaps.currLive[i] as number) === 0) continue
      worst = Math.max(
        worst,
        Math.hypot(
          (frame.carXY[n * 2] as number) - (snaps.currXY[i * 2] as number),
          (frame.carXY[n * 2 + 1] as number) - (snaps.currXY[i * 2 + 1] as number),
        ),
      )
      n++
    }
    expect(worst, 'the drawn cars did NOT converge onto the sim positions').toBeGreaterThan(0)
    expect(worst, 'one lag plus one tick of travel, which is the bound that holds').toBeLessThan(
      MAX_DRAW_LAG_CELLS + MAX_SIM_CELLS_PER_TICK,
    )
    // The property that makes it acceptable rather than merely bounded: a
    // cell's half-width is 0.5, so every frozen car is still drawn on its own
    // road rather than beside it. Task 12's device session is the instrument
    // for whether it reads as a stop or as a stutter.
    expect(worst, 'a frozen car is still on the road').toBeLessThan(0.5)
  })
})

// ---------------------------------------------------------------------------
// M1e TASK 12 — THE RUN CAN BE LOST END TO END, ON THE PRODUCTION BOOT PATH
// ---------------------------------------------------------------------------

/**
 * Task 10's three arms, driven through `createGame` and its `InputQueue`
 * instead of by hand.
 *
 * **Why this is not a second copy of `startingCity.test.ts`'s gate.** That
 * file's `driveGate` calls `layoutFor`, seeds, warm-starts and then calls
 * `step` itself. This one boots the object `startGame` builds, pushes every
 * road through `game.queue.enqueue` — the method `pointer.ts` calls and the
 * only way a finger reaches the sim — and advances by handing the frame loop a
 * timestamp. **Two independent drivers agreeing on a death tick, a killer and a
 * per-week series is evidence; one driver run twice is not.** The POLICY is
 * shared (`cityArms.ts`) precisely so that the only thing that can differ is
 * the driver.
 *
 * The arms are also asserted as FIGURES with a stated tolerance rather than as
 * inequalities. The first draft of this block's gate was *"survives strictly
 * longer and scores strictly more"*, which is not a gate: `8,660 > 5,579` and
 * `70 > 0` satisfy it, i.e. a build that is unwinnable after four minutes
 * passes. Every number below is exact, and the two that are not — the delivery
 * fractions — carry an explicit epsilon.
 */
interface ArmWeek {
  readonly week: number
  readonly dests: number
  readonly houses: number
  readonly trips: number
  readonly fires: number
  readonly maxInFlight: number
  readonly longestQueue: number
  readonly refusals: number
  readonly blockedTicks: number
  readonly peakDestPins: number
  readonly peakOvercrowd: number
  readonly tilesLeft: number
  /** Cards resolved so far, cumulative — M1f Task 7. */
  readonly cardsTaken: number
  /** `H_INV_UPGRADES` at the close of this week, cumulative. */
  readonly upgradesHeld: number
}

interface ArmRun {
  readonly weeks: readonly ArmWeek[]
  readonly deathTick: number
  readonly deathWeek: number
  readonly failedDest: number
  readonly failedDestConnected: boolean
  readonly trips: number
  readonly fires: number
  readonly maxInFlight: number
  readonly maxBlockedTicks: number
  readonly valveFirings: number
  readonly unaffordable: number
  /** Tiles actually spent by the opening, read off `H_TILES` across the one tick it lands on. */
  readonly openingSpend: number
  /** `CENSUS_CO_PRESENCE` events over the whole arm — see `junctionCensus.ts`. */
  readonly conflicts: number
  /** The tick of the first one, or -1. */
  readonly firstConflictTick: number
  /** `[cell, count]`, count descending. */
  readonly conflictCells: readonly (readonly [number, number])[]
  /** `CENSUS_RULE_VISIBLE` events over the whole arm — the pair the milestone is dated from. */
  readonly ruleEvents: number
  /** The tick of the first one, or -1. */
  readonly firstRuleEventTick: number
  /** `[cell, count]`, count descending. */
  readonly ruleEventCells: readonly (readonly [number, number])[]
  /**
   * How many weekly card offers this arm resolved — M1f Task 7. One per week
   * boundary it crossed, taken from slot A. **A policy that never fires is a
   * policy that is not being tested**, so every arm asserts this is non-zero.
   */
  readonly cardsTaken: number
  /**
   * `H_INV_UPGRADES` at the end of the run: `UPGRADES_PER_CARD` (2) per
   * JUNCTION UPGRADE card taken, and nothing else writes it in M1f.
   *
   * **This is what makes the moved tile ledger a derivation rather than a
   * paste.** Slot A's card is a draw, so the split between the two implemented
   * cards is not knowable in advance — but the two counters together pin it:
   * `upgradeCards = upgradesHeld / 2`, `tileCards = cardsTaken - upgradeCards`,
   * and the extra tiles are `20 * upgradeCards + 30 * tileCards` off §5.10's
   * table. Each arm below checks its own ledger against that identity.
   */
  readonly upgradesHeld: number
}

/** Twelve weeks, which is 54,000 ticks — long enough for every arm to end. */
const ARM_WEEKS = 12

/**
 * Drives one arm to its death or to `ARM_WEEKS`, whichever comes first.
 *
 * `layoutId: undefined` reaches `createGame` with the property genuinely
 * absent, so this is the board a player who taps the bot link with no
 * parameters opens — not `city` named explicitly. `buildRig`'s own note
 * explains why `in` rather than `??` is what makes that expressible.
 */
function driveArm(arm: CityArm): ArmRun {
  const rig = buildRig({ layoutId: undefined })
  const { state, world } = rig.game
  const startTick = state.header[H_TICK] as number
  const endTick = startTick + ARM_WEEKS * TICKS_PER_WEEK
  const tally = { unaffordable: 0 }
  const weeks: ArmWeek[] = []

  const openingActions: TickAction[] = []
  for (const stroke of CITY_OPENING) openingActions.push(...armPathActions(stroke))

  let deathTick = -1
  let maxInFlight = 0
  let maxBlockedTicks = 0
  let valveFirings = 0
  let openingSpend = 0

  // **Both censuses, two `prev` buffers and two tallies, one pass each per
  // tick.** They share nothing but the run, which is the point: the two counts
  // are guaranteed to be about the same drive, and neither can be quietly
  // measured on a different one. `censusPrev` fills with `FREE` rather than
  // leaving the buffer zeroed — 0 is a valid car index, and a zeroed buffer
  // fabricates a swap on the first tick any junction holds a non-zero car.
  const coPrev = censusPrev(world)
  const rulePrev = censusPrev(world)
  const coTally = new Int32Array(world.cells)
  const ruleTally = new Int32Array(world.cells)
  let conflicts = 0
  let ruleEvents = 0
  let firstConflictTick = -1
  let firstRuleEventTick = -1

  let week = weekOfTick(startTick)
  let weekTrips = state.header[H_SCORE] as number
  let weekFires = firesSoFar(state)
  let weekRefusals = state.header[H_ROUTES_REFUSED] as number
  let wkInFlight = 0
  let wkQueue = 0
  let wkBlocked = 0
  let wkPins = 0
  let wkOvercrowd = 0

  const closeWeek = (): void => {
    const trips = (state.header[H_SCORE] as number) - weekTrips
    weeks.push({
      week,
      dests: state.header[H_DEST_COUNT] as number,
      houses: state.header[H_HOUSE_COUNT] as number,
      trips,
      fires: firesSoFar(state) - weekFires,
      maxInFlight: wkInFlight,
      longestQueue: wkQueue,
      refusals: (state.header[H_ROUTES_REFUSED] as number) - weekRefusals,
      blockedTicks: wkBlocked,
      peakDestPins: wkPins,
      peakOvercrowd: wkOvercrowd,
      tilesLeft: tilesLeft(state),
      cardsTaken: rig.cardsTaken,
      upgradesHeld: state.header[H_INV_UPGRADES] as number,
    })
    weekTrips = state.header[H_SCORE] as number
    weekFires = firesSoFar(state)
    weekRefusals = state.header[H_ROUTES_REFUSED] as number
    wkInFlight = 0
    wkQueue = 0
    wkBlocked = 0
    wkPins = 0
    wkOvercrowd = 0
  }

  /**
   * Runs frames until exactly one tick has passed.
   *
   * **A frame is not a tick, and this rig must not pretend otherwise.** Three
   * things were measured getting here, none of them obvious from the loop's
   * source:
   *
   *   - `advance(TICK_MS)` runs **zero** ticks on some frames. `TICK_MS` is
   *     `1000 / 30` and `now2 - now1` after `now += TICK_MS` loses the last
   *     bits, so `rawDt` lands a float ulp under `TICK_MS`. The first frame this
   *     rig drove — tick 259 — ran zero.
   *   - And then it runs **two**, because the shortfall carries in the
   *     accumulator until one frame clears `2 * TICK_MS`.
   *   - `oneTick(alpha)` subtracts the accumulator before adding, so it is
   *     self-correcting. `alpha = 0.5` leaves half a tick of headroom in the
   *     accumulator every frame, which is ~16.7 ms against a float error of
   *     ~1e-13. `alpha = 0` leaves none and reproduces the zero-tick frame.
   *
   * The death loops elsewhere in this file absorb all of that silently, because
   * they count frames and assert a tick. An arm that injects the opening on a
   * NAMED tick cannot: the stroke would land somewhere other than where Task 10
   * put it, and every figure below would be a different experiment reported
   * under the old numbers. So the guard is exact and it is inside the loop.
   *
   * A burst would be safe even if one happened — `loop.ts` clears the queue
   * after the FIRST tick of a drain, so an action reaches exactly one tick
   * either way — but the per-tick SAMPLING below would skip the rest of it,
   * which is why this refuses rather than tolerates.
   */
  const oneTick = (): void => {
    const before = state.header[H_TICK] as number
    let frames = 0
    while ((state.header[H_TICK] as number) === before) {
      rig.oneTick(0.5)
      frames++
      if (frames > 4) throw new Error(`driveArm: ${frames} frames ran no tick at all after ${before}`)
    }
    if ((state.header[H_TICK] as number) !== before + 1) {
      throw new Error(`driveArm: one frame ran ${(state.header[H_TICK] as number) - before} ticks`)
    }
  }

  for (let tick = startTick + 1; tick <= endTick; tick++) {
    let actions: readonly TickAction[] | undefined
    if (arm !== 'no-input' && tick === startTick + 1) actions = openingActions
    else if (arm === 'greedy' && tick % GREEDY_PERIOD_TICKS === 0) {
      actions = armGreedyActions(state, world, tally)
    }
    const tilesBefore = tilesLeft(state)
    if (actions !== undefined) {
      for (const a of actions) rig.game.queue.enqueue(a.kind, a.a, a.b)
    }
    oneTick()
    if ((state.header[H_TICK] as number) !== tick) {
      throw new Error(`driveArm: expected tick ${tick}, state says ${state.header[H_TICK]}`)
    }
    if (rig.game.queue.length !== 0) throw new Error(`driveArm: the queue was not drained on ${tick}`)
    if (tick === startTick + 1 && arm !== 'no-input') openingSpend = tilesBefore - tilesLeft(state)

    if (isGameOver(state)) {
      deathTick = state.header[H_TICK] as number
      closeWeek()
      break
    }

    let inFlight = 0
    let blocked = false
    for (let c = 0; c < state.carPhase.length; c++) {
      const phase = state.carPhase[c] as number
      if (phase === PHASE_OUTBOUND || phase === PHASE_RETURNING) inFlight++
      const bt = state.carBlockedTicks[c] as number
      if (bt > 0) blocked = true
      if (bt > maxBlockedTicks) maxBlockedTicks = bt
      if (bt >= MAX_BLOCKED_TICKS) valveFirings++
    }
    if (inFlight > wkInFlight) wkInFlight = inFlight
    if (inFlight > maxInFlight) maxInFlight = inFlight
    if (blocked) wkBlocked++

    const co = countJunctionConflicts(state, world, coPrev, CENSUS_CO_PRESENCE, coTally)
    if (co > 0 && firstConflictTick < 0) firstConflictTick = tick
    conflicts += co
    const rule = countJunctionConflicts(state, world, rulePrev, CENSUS_RULE_VISIBLE, ruleTally)
    if (rule > 0 && firstRuleEventTick < 0) firstRuleEventTick = tick
    ruleEvents += rule
    // Sampled, not run every tick: `longestQueue` allocates a `Map` and a `Set`
    // per call. Every tenth tick is the same cadence Task 10's driver used, so
    // the two figures are comparable.
    if (tick % 10 === 0) {
      const q = longestQueue(state, world)
      if (q > wkQueue) wkQueue = q
    }

    const destCount = state.header[H_DEST_COUNT] as number
    for (let d = 0; d < destCount; d++) {
      const pins = state.destPins[d] as number
      if (pins > wkPins) wkPins = pins
      const m = state.destOvercrowd[d] as number
      if (m > wkOvercrowd) wkOvercrowd = m
    }

    const w = weekOfTick(tick)
    if (w !== week) {
      closeWeek()
      week = w
    }
  }
  if (deathTick < 0) closeWeek()

  const failedDest = state.header[H_FAILED_DEST] as number
  const failedCarpark =
    deathTick > 0 && failedDest >= 0 && failedDest < (state.header[H_DEST_COUNT] as number)
      ? armCarpark(state, world, failedDest)
      : -1
  return {
    weeks,
    deathTick,
    deathWeek: deathTick < 0 ? -1 : weekOfTick(deathTick),
    failedDest,
    failedDestConnected: failedCarpark >= 0 && roadMask(state, failedCarpark) !== 0,
    trips: state.header[H_SCORE] as number,
    fires: firesSoFar(state),
    maxInFlight,
    maxBlockedTicks,
    valveFirings,
    unaffordable: tally.unaffordable,
    openingSpend,
    conflicts,
    firstConflictTick,
    conflictCells: censusCellTable(coTally),
    ruleEvents,
    firstRuleEventTick,
    ruleEventCells: censusCellTable(ruleTally),
    cardsTaken: rig.cardsTaken,
    upgradesHeld: state.header[H_INV_UPGRADES] as number,
  }
}

/**
 * The tiles the CARDS added on top of `WEEKLY_TILE_GRANT`, from the two
 * counters the run recorded — M1f Task 7.
 *
 * **The grants are hand-carried literals off spec §5.10's table, NOT read back
 * through `cardTileGrant`.** M1f Task 6 measured what the alternative costs:
 * every behavioural assertion in `cards.test.ts` computed its expected tile
 * total from the same function the mutation edits, so swapping the two grants
 * was invisible everywhere except that function's own unit test — 1 detector,
 * repaired to 3 by writing the two numbers out. The two `expect`s below are the
 * watcher on the copy, so a retune fails here instead of silently rescaling
 * every arm's ledger.
 */
function armCardTiles(r: ArmRun): number {
  expect(CARD_GRANT_ROAD_TILES, '§5.10: ROAD TILES pays 30').toBe(30)
  expect(CARD_GRANT_ITEM, '§5.10: the item row pays 20').toBe(20)
  expect(UPGRADES_PER_CARD, '§5.10: 2 items for 20 tiles').toBe(2)
  const upgradeCards = r.upgradesHeld / 2
  const tileCards = r.cardsTaken - upgradeCards
  expect(tileCards, 'the two card counts must partition the cards taken').toBeGreaterThanOrEqual(0)
  return upgradeCards * 20 + tileCards * 30
}

/**
 * The per-week `tilesLeft` series **with M1f Task 7's card grants subtracted
 * back out** — i.e. the ledger this arm carried before it had a card policy.
 *
 * **This is the reproduce-before-you-contradict step, and it is the only reason
 * the moved ledger below is a derivation rather than a paste.** The catalogue's
 * rule is that a rig which disagrees with the record is more likely to be wrong
 * than the record is; here the record is `37` and `94`, measured at M1f Task 3,
 * and this function has to give them back before the new figures mean anything.
 * Cards are taken immediately after a boundary, so a card taken at the start of
 * week `w` is fully inside week `w`'s row.
 */
function armLedgerWithoutCards(weeks: readonly ArmWeek[]): number[] {
  return weeks.map((w) => {
    const upgradeCards = w.upgradesHeld / 2
    const tileCards = w.cardsTaken - upgradeCards
    return w.tilesLeft - (upgradeCards * 20 + tileCards * 30)
  })
}

const armRuns = new Map<CityArm, ArmRun>()
function armRun(arm: CityArm): ArmRun {
  const cached = armRuns.get(arm)
  if (cached !== undefined) return cached
  const run = driveArm(arm)
  armRuns.set(arm, run)
  return run
}

describe('the run can be lost end to end, on the board a plain load opens', () => {
  /**
   * **Warms all three memoised arms, so no CASE pays for a drive.**
   *
   * `armRun` memoises at module scope, so before this hook existed the FIRST
   * case in this block silently paid for whichever arms it touched — and after
   * M1f Task 1 added two per-tick census passes over all 960 cells, that bill
   * grew ~6x. The case that paid it here was the one with nothing to do with the
   * census, and it was measured at 71-95% of vitest's 5 s default with one run
   * in nine timing out at 6,337 ms. A red there reads as "the default board
   * stopped passing its gate", which is a diagnosis pointing at the wrong file.
   *
   * **A hook rather than a per-case budget, because ordering is not an
   * interlock.** Budgeting whichever case happens to be first is correct only
   * until someone reorders the block or runs `it.only` on a different one; the
   * hook runs for every case in every order, including under `it.only`. It also
   * puts the whole cost in ONE budgeted place, which lets every case stay on the
   * 5 s default — so a future slowdown INSIDE a case still fails loudly instead
   * of hiding under a generous per-case allowance.
   */
  beforeAll(() => {
    armRun('no-input')
    armRun('opening')
    armRun('greedy')
  }, 120000)

  it('an unplayed city dies at a HAND-DERIVED 5,580 with a score of 0, and D2 is what kills it', () => {
    const r = armRun('no-input')

    // ---------------------------------------------------------------------
    // THE DERIVATION, WHICH IS THE WHOLE CONTENT OF THIS ARM
    // ---------------------------------------------------------------------
    //
    // 5,580 is not read off the run. It is:
    //
    //   D2 is colour 1's lone CIRCLE, so `computeSlotCounts` (demand.ts) gives
    //   colour 1 two rotation slots — a circle carries two, a square one — and
    //   BOTH of them are D2's. Colour 1 therefore fires every
    //   PIN_PERIOD_TICKS / 2 = 259 ticks and every one of those pins lands on
    //   D2, where colour 0's two squares share their colour's two slots and get
    //   one pin per 518 ticks EACH.
    //
    //   The first pin is at tick 378 (`FIRST_PIN_TICK` in startingCity.test.ts:
    //   119 + ceil(518 / 2)). D2's trigger cap is PIN_CAP_CIRCLE_TIMER = 8, so
    //   it stands at cap from its 8th pin: 378 + 7 * 259 = 2,191.
    //
    //   The meter needs 3,390 consecutive at-cap ticks. `overcrowdRampSpeed`
    //   adds floor(20t/30) on the t-th, saturating at DENOM = 1,000 once
    //   `destOverTicks` reaches OVERCROWD_RAMP_FULL_TICKS = 1,500:
    //   sum(floor(2t/3), t = 1..1500) = 750,000, leaving
    //   2,640,000 - 750,000 = 1,890,000 at 1,000 a tick = 1,890 more.
    //   1,500 + 1,890 = 3,390.
    //
    //   The k-th at-cap tick is 2,190 + k, so k = 3,390 lands on **5,580**.
    //
    // **The lower-indexed square D0 would die at 6,330, and saying which of the
    // two dies is what makes this a derivation rather than a recorded number.**
    // D0 reaches its square trigger cap of 6 on tick **2,941**, and the k-th
    // at-cap tick is `2,940 + k`, so `k = 3,390` lands on 6,330 — the same
    // arithmetic as D2's, one destination over. Measured on this tree by
    // recording the first tick `destPins[0] >= PIN_CAP_SQUARE_TIMER`.
    //
    // **This comment said 6,357 until M1e's closing sweep, and 6,357 is the
    // PRE-SPAWNER number.** Its derivation — pins at 378, 896, 1414, 1932, 2450
    // and 2968, first at-cap tick 2,968, `2,967 + 3,390` — is the one that holds
    // when `H_DEST_SPAWN_TIMER` is parked, and `startingCity.test.ts` reproduces
    // it exactly that way. On the live tree Task 5's spawner adds a THIRD
    // colour-0 destination, which changes `slotCount(0)` and moves D0's cap tick
    // from 2,968 to 2,941. Note where the contradiction sat: eight lines below,
    // this same block says *"this run ends with five, not the three it was
    // seeded with"* — the spawner it had already accounted for is the spawner
    // the 6,357 assumed away. `da63dc2` corrected the figure once; the final
    // commit reintroduced it here in a new comment.
    //
    // **The higher cap does not save the circle**: 8 pins at one per 259 ticks
    // arrive sooner than 6 at one per 518, and §5.8's dial is the ratio of the
    // two, not the cap alone. That asymmetry is the one thing M1e discovered
    // about the pin capacities and it is in `constants.ts` and the M1f
    // carry-forward as well as here.
    //
    // **And the derivation is robust to the spawner, which is worth stating
    // because it looks like it should not be.** Task 5 adds destinations to this
    // board even with no input — this run ends with five, not the three it was
    // seeded with — and a new colour-1 destination changes `slotCount(1)`. But
    // **each rotation slot still receives one pin per `period` regardless of how
    // many destinations the colour has**, so D2's own arrival rate is untouched
    // and 5,580 holds. Anything the spawner adds gets its first pin
    // FIRST_PIN_DELAY_TICKS = 120 ticks after spawning and cannot complete a
    // 3,390-tick meter before roughly tick 8,300, which is well after D2.
    expect(r.deathTick, 'derived above, not recorded from the run').toBe(5580)
    expect(r.deathTick, 'and the number three other files already carry').toBe(CITY_DEATH_TICK)
    expect(2190 + 3390, 'the k-th at-cap tick, with k = 3,390').toBe(5580)
    expect(378 + 7 * (PIN_PERIOD_TICKS / 2), "D2's 8th pin, at one per 259 ticks").toBe(2191)

    // **D2 SPECIFICALLY.** "A destination that was never connected" is every
    // destination on a board with no roads, so it is an assertion about
    // nothing; the claim that has content is which one of the five reaches its
    // meter first, and it is index 2.
    expect(r.failedDest, "colour 1's lone circle, not the lower-indexed square").toBe(2)
    expect(r.failedDestConnected, 'nothing is connected on a board nobody drew on').toBe(false)

    expect(r.trips, 'nothing can move, so nothing scores').toBe(0)
    expect(r.maxInFlight, 'and no car ever leaves its house').toBe(0)
    // The spawner is live on this arm and the run is still lost — growth in the
    // entity count is not growth in the behaviour anyone wanted.
    expect(r.weeks.at(-1)?.dests).toBe(5)
    expect(r.weeks.at(-1)?.houses).toBe(10)
    // -------------------------------------------------------------------
    // THE TILE LEDGER, AND THE ONE FIGURE M1f TASK 7 MOVED ON THIS ARM
    // -------------------------------------------------------------------
    //
    // The weekly grant landed exactly once inside 5,580 ticks: 30 + 30 = 60 at
    // the week-1 boundary, and week 0's row is closed ON that boundary tick,
    // before the card can be taken. **Unmoved.**
    expect(r.weeks[0]?.tilesLeft).toBe(60)
    // **Week 1's row MOVED, 60 -> 80, and this is the whole behavioural
    // footprint of the card policy on a board nobody plays.** The rig takes
    // slot A's card the moment the offer pauses the loop, one tick after the
    // boundary; slot A drew the JUNCTION UPGRADE, which pays 20 tiles and 2
    // items. Nothing spends either, so the run is otherwise byte-for-byte the
    // arm Task 3 measured — the death tick, the killer, the score, the peak
    // pins and the population above are all unmoved, and they are the
    // assertions that say so.
    expect(r.cardsTaken, 'one week boundary crossed, one offer resolved').toBe(1)
    expect(r.upgradesHeld, 'slot A drew the junction upgrade: UPGRADES_PER_CARD items').toBe(2)
    expect(armCardTiles(r), 'so the cards added 20 tiles and no more').toBe(20)
    expect(r.weeks[1]?.tilesLeft).toBe(80)
    // Reproduced against the figure this arm carried BEFORE the card policy.
    expect(armLedgerWithoutCards(r.weeks), 'the pre-Task-7 ledger, recovered').toEqual([60, 60])
    expect(WEEKLY_TILE_GRANT, 'and the grant those 60s are two of').toBe(30)
    // The killer runs past the CIRCLE's hard cap, which is the roadless
    // signature: nothing consumes a pin, so the count only climbs.
    expect(r.weeks[1]?.peakDestPins).toBe(PIN_CAP_CIRCLE_HARD)
  })

  it('the 20-tile opening reaches 8,661 and every per-week figure it was measured at', () => {
    const r = armRun('opening')

    // **The opening was ACCEPTED, asserted rather than assumed.** A stroke
    // refused for budget would silently turn this arm into a second copy of
    // `no-input`, and every figure below would still look like a measurement.
    expect(r.openingSpend, 'D2_LINK 5 tiles + CORRIDOR 15').toBe(20)

    expect(r.deathTick, "Task 10's opening arm").toBe(8661)
    expect(r.failedDest, 'D3 — a different destination from the one the empty board loses to').toBe(3)
    expect(r.failedDestConnected, 'and its carpark is still bare').toBe(false)
    expect(r.trips, "Task 10's figure").toBe(71)
    expect(r.deathWeek).toBe(1)

    // The per-week series, exact. Task 10 recorded this arm's death tick, its
    // killer and its trip count and gated on its two delivery fractions; the
    // six per-week series below are measured HERE for the first time, on the
    // production boot, and are stated as figures rather than as bounds for the
    // reason the block header gives.
    expect(r.weeks.map((w) => w.maxInFlight), 'cars in motion').toEqual([2, 2])
    expect(r.weeks.map((w) => w.longestQueue), 'nobody ever waits behind anybody').toEqual([1, 1])
    expect(r.weeks.map((w) => w.refusals), 'H_ROUTES_REFUSED, per week').toEqual([0, 0])
    expect(r.weeks.map((w) => w.blockedTicks), 'ticks with a blocked car').toEqual([0, 0])
    expect(r.weeks.map((w) => w.peakDestPins), 'peak destPins over ALL destinations').toEqual([4, 10])
    // The last sample before the freeze, so it is one ramp step under the
    // threshold rather than at it — the death tick itself is never sampled,
    // because the loop breaks on `isGameOver` before the sampling block.
    expect(r.weeks.map((w) => w.peakOvercrowd), 'peak destOvercrowd').toEqual([0, 2639000])
    expect(r.weeks[1]?.peakOvercrowd).toBeLessThan(OVERCROWD_FAIL_MILLITICKS)

    // Task 10's Gate B numbers, on the other driver. An epsilon rather than an
    // exact float compare, and the two ratios are stated as their own fractions
    // so a change in either term is visible in the failure.
    expect(r.weeks[0]?.trips).toBe(32)
    expect(r.weeks[0]?.fires).toBe(38)
    expect(r.weeks[1]?.trips).toBe(39)
    expect(r.weeks[1]?.fires).toBe(55)
    expect(32 / 38).toBeCloseTo(0.842, 3)
    expect(39 / 55).toBeCloseTo(0.709, 3)

    // **M1f Task 7: this arm crosses one boundary and takes one card, and NOT
    // ONE FIGURE ABOVE MOVED.** The opening is a fixed 20-tile stroke laid on
    // the first tick, so the arm has nothing to spend a bonus on — the extra
    // tiles sit in the ledger, which this arm does not assert, and the two
    // items sit in `H_INV_UPGRADES`, which nothing in M1f places. Task 8 owns
    // the modal; Task 9 owns spending the upgrade.
    expect(r.cardsTaken, 'one boundary at 4,500 inside 8,661 ticks').toBe(1)
    expect(r.upgradesHeld + armCardTiles(r), 'a card WAS taken, and it granted something').toBeGreaterThan(0)

    // Degeneracy guards. Both are satisfied by construction above and are here
    // because the failure they catch — an arm that stops driving — is exactly
    // the one every figure in this case would survive.
    expect(r.trips).toBeGreaterThan(0)
    expect(r.maxInFlight).toBeGreaterThan(0)
  })

  /**
   * **30 s, and the extra budget is the census rather than the drive.** The
   * greedy arm is 31,456 ticks and used to finish inside vitest's 5 s default;
   * M1f Task 1 added two per-tick passes over all 960 cells, which is ~5.5 s of
   * typed-array walking on top. Both hoists that were available have been taken
   * (`state`'s views out of the loop, a bare-ground short-circuit before
   * `roadDegree`'s popcount) — see `junctionCensus.ts`. `armRun` memoises, so
   * only the first case to ask for this arm pays it.
   */
  it('the greedy arm survives to week 4 and dies on a destination it HAD connected', () => {
    const r = armRun('greedy')

    // **17:29 is the UN-SUBTRACTED clock and this comment used to imply
    // otherwise.** `31456 / 30` = 1,048.5 s = 17:28.5, which rounds to the
    // 17:29 the carry-forward's §12 quotes. But §14 defines every time in this
    // repo as `(tick - warmStart) / 30`, and the city's warm start is 258
    // ticks: **(31456 - 258) / 30 = 1,039.9 s = 17:19.9**. A player holding a
    // stopwatch sees 17:19.9; only a reader of the tick counter sees 17:29.
    // Both numbers are defensible and they are different counters, so the
    // sentence says which is which — see the catalogue's "a unit change inside
    // one sentence".
    // ---------------------------------------------------------------------
    // **EVERY FIGURE IN THIS BLOCK MOVED AT M1f TASK 2, ON PURPOSE, AND THE
    // MOVE IS THE SIZE OF THE BUG THAT WAS FIXED. TASK 3 MOVED THEM AGAIN, BY
    // NARROWING THE RULE, AND BOTH COLUMNS ARE KEPT.**
    // ---------------------------------------------------------------------
    //
    // `MAX_BLOCKED_TICKS` is the datamined ceiling on the wait at an
    // intersection and this project shipped it without the wait: `canEnter`
    // read the entrant's own lane only, so an eastbound car and a northbound
    // car crossed inside one cell and nothing stopped them. Task 2 made a cell
    // of `roadDegree >= INTERSECTION_DEGREE` admit one car at a time. Task 3's
    // triage measured that against a narrower reading of §5.5 — *collide*, not
    // *co-occupy* — and shipped the narrower one:
    //
    // ```
    //                            pre-M1f    T2 (wide)   T3 (crossing, ships)
    //   death tick               31,456      21,704      21,783   -30.8 %
    //   on a stopwatch           17:19.9     11:54.9     11:57.5
    //   completed trips             747         344         368   -50.7 %
    //   delivery fraction         0.975       0.837       0.891
    //   blocked car-ticks         2,120      45,986      29,267   x13.8
    //   ticks with a blocked car   6.2 %      26.2 %      22.3 %
    //   worst carBlockedTicks        32       1,350       1,350   saturated
    //   valve firings                 0          15           5
    //   max cars in flight           11          12          11
    //   H_ROUTES_REFUSED              0           0           0   unmoved
    // ```
    //
    // **The whole narrowing is 43 admitted crossings over 21,525 ticks** —
    // entries into a junction whose other lane was occupied on a non-crossing
    // axis, which the wide rule refused — and they are worth 16,719 blocked
    // car-ticks and 24 trips, because each one is a queue that did not form.
    // Task 9's junction upgrade is what gives the rest back: measured at Task 3
    // on this arm, exempting the three cells that carry the jam reaches 759
    // trips, and exempting all five the rule ever fires on reproduces the
    // pre-M1f board to the digit — 747 / 2,120 / 31,456.
    //
    // **The board is bit-identical to the previous commit until tick 12,780 —
    // 6:57.4 on a stopwatch — and that is MEASURED, not derived from the
    // census.** A per-tick fingerprint of `carCell`, `carProgress` and `H_SCORE`
    // over this arm, run against the parent commit's `sim/src`, first differs at
    // 12,780. **The rule-visible census fires 2,573 ticks (85.8 s) EARLIER, at
    // 10,207**, and the two are different quantities: the census counts a
    // same-tick swap across a junction, and a swap whose LEAVER has the lower
    // car index is one this rule permits — `runMovement` ascends, so the leaver
    // releases the cell before the entrant asks for it. The census is therefore
    // an over-approximation of divergence and the earlier figure is the safe
    // bound. Anything quoting 12,780 as "the tick the census fires" is wrong;
    // anything quoting 10,207 as "the tick the board diverges" is also wrong.
    expect(r.deathTick, 'M1f Task 3, crossing-only — tick 21,783: 12:06.1 raw, 11:57.5 on a stopwatch').toBe(21783)
    expect(Math.round(((21783 - 258) / 30) * 10) / 10, 'the stopwatch figure').toBe(717.5)
    expect(r.deathWeek, 'week 4 of 12, down from week 6; the window is still not what ends it').toBe(4)
    expect(r.weeks.length, 'five weeks, 0 through 4 — two fewer than pre-M1f').toBe(5)
    expect(r.failedDest, 'and the pre-M1f killer is back — D6, where the wide rule died on D5').toBe(6)

    // ---------------------------------------------------------------------
    // THE BINDING CONSTRAINT, AND IT IS THE ONE TASK 10 NAMED
    // ---------------------------------------------------------------------
    //
    // The run does not end because the network cannot carry the load. It ends
    // on a destination whose carpark is ON the road network, with
    // `H_ROUTES_REFUSED` at zero for the whole run and 97.5 % of every pin
    // demand fired delivered. That is `dispatch.ts`'s Decision 4 cost —
    // `advanceAccumulators` distributes pins EVENLY across a colour's rotation
    // slots while `assembleSources` routes cars to the NEAREST unfilled pin —
    // and not a throughput failure. A gate demanding a collapsing delivery
    // fraction under greedy play would be demanding the wrong failure mode;
    // the collapse belongs to the FIXED-network arm above, which is where
    // Task 10 gated it.
    expect(r.failedDestConnected, 'the killer was connected, and still starved').toBe(true)
    expect(r.weeks.map((w) => w.refusals), 'not one route refused, in any week').toEqual([0, 0, 0, 0, 0])
    expect(r.trips).toBe(368)
    expect(r.fires).toBe(413)

    // ---------------------------------------------------------------------
    // WHAT M1f TASK 4'S EIGHT RE-BLESSED GOLDENS BORROW THEIR MEANING FROM
    // ---------------------------------------------------------------------
    //
    // **The three assertions below already existed and already passed — this
    // block adds no coverage, it adds an ANCHOR, and saying which is the point.**
    //
    // Task 4 moved eight whole-buffer digests for PURE LAYOUT. A layout re-bless
    // carries no behavioural claim of its own, so it is a blank cheque unless it
    // borrows one: a genuine regression landing in the same commit is absorbed
    // by the new literals with no trace anywhere. What Task 4 borrowed is this
    // arm, unchanged from what Task 3 left it at — death tick 21,783, 368 trips,
    // `H_ROUTES_REFUSED` 0 in every week — plus the splice proof at each of the
    // nine digest sites, which says no pre-existing byte changed VALUE, and
    // `assertM1fShapeIsPureLayout`, which says every inserted byte is still zero.
    //
    // **This comment predicted that these three would be re-based at M1f Task 7,
    // when frame-driven arms acquire a card policy. THEY WERE NOT, and Task 7
    // measured it rather than assuming either way.** The card pays 20 or 30 tiles
    // on top of `WEEKLY_TILE_GRANT`, so the arm's tile LEDGER moved — see the
    // block below — but `armGreedyActions` reads the budget in exactly one place
    // and `r.unaffordable` is 0 across all 21,783 ticks, so tiles it never needed
    // change nothing it does. The death tick, the trips and the refusals are
    // unmoved, so **Task 4's warrant still holds and does not need re-issuing.**
    // What is permanent is that a shape task must point at something behavioural
    // that did NOT move.
    expect(r.deathTick, 'the anchor M1f Task 4 re-blessed eight goldens against').toBe(21783)
    expect(r.trips, 'unchanged from Task 3').toBe(368)
    expect(
      r.weeks.reduce((n, w) => n + w.refusals, 0),
      'H_ROUTES_REFUSED across the whole run, unchanged from Task 3',
    ).toBe(0)
    // **The delivery fraction DOES fall now, and this is the sentence that
    // changed rather than the number.** Pre-M1f this arm delivered 97.5 % of
    // everything demand fired and died distributionally; under Task 2's wide
    // rule 83.7 % and under Task 3's 89.1 %, so part of the failure IS a
    // throughput collapse. `H_ROUTES_REFUSED` is still 0 in every week —
    // routing never refuses a car — so what changed is entirely at the
    // crossing. **0.891 clears the `< 0.9` bound by 0.009 and that is stated
    // rather than absorbed**: the bound is what says the milestone still owes
    // Task 9 a restoration, and one more percentage point of relief from any
    // source turns it red. That is the correct polarity — it is an allowance
    // for a known regression and it must fail when the regression is fixed.
    expect(r.trips / r.fires, 'the delivery fraction still falls').toBeCloseTo(0.891, 3)
    expect(r.trips / r.fires, 'M1f INTERIM — pre-M1f this was >= 0.9 and Task 9 must restore it').toBeLessThan(0.9)
    expect(r.trips / r.fires, 'but it has not collapsed').toBeGreaterThan(0.8)
    expect(r.trips / r.fires).toBeLessThan(1)

    // Task 10's per-week series, reproduced by the other driver, exactly.
    // **Weeks 0 to 2 are BYTE-IDENTICAL to pre-M1f and weeks 3 and 4 are not**,
    // which is the per-week form of the 12,780 divergence above: 12,780 is
    // inside week 2 (4,500-tick weeks, so week 2 is 9,000..13,499), and week 2's
    // 99 blocked ticks all land before it. That is the strongest single check
    // that this rule changes nothing early — three whole weeks of six series
    // reproduce with no re-blessing at all, and they reproduce under BOTH M1f
    // rules, because both leave the first 12,780 ticks alone.
    expect(r.weeks.map((w) => w.blockedTicks)).toEqual([0, 0, 99, 1647, 3051])
    // **A POST-REPAIR figure, and the repair has now happened twice.**
    // `carAheadOf` read one lane until Task 2 and would have reported "nothing
    // ahead" for a car `canEnter` was refusing across a junction; Task 3
    // narrowed WHEN the other lane blocks, and the probe had to follow or it
    // would over-report by exactly the crossings the rule now admits. Both
    // repairs are pinned by the probe/`canEnter` iff property, which is what
    // caught the second one — see `queueProbe.ts`.
    expect(r.weeks.map((w) => w.longestQueue)).toEqual([1, 1, 2, 8, 6])
    expect(r.weeks.map((w) => w.peakDestPins), "Gate C's 1 -> 5 -> 10 gradient").toEqual([
      1, 1, 1, 5, 10,
    ])
    expect(r.maxInFlight, "Gate A's peak cars in motion — 11 pre-M1f, 12 under the wide rule").toBe(11)
    expect(r.weeks.map((w) => w.dests)).toEqual([5, 6, 8, 10, 10])
    expect(r.weeks.map((w) => w.houses)).toEqual([8, 13, 17, 21, 21])
    // ---------------------------------------------------------------------
    // **THE TILE LEDGER — THE ONLY THING M1f TASK 7 MOVED ON THIS ARM, AND THE
    // PREDICTION THAT SAID SO BEFORE IT WAS RUN.**
    // ---------------------------------------------------------------------
    //
    // Task 7 gives every frame-driven rig a card policy, so this arm now
    // receives `CARD_GRANT_ITEM` (20) or `CARD_GRANT_ROAD_TILES` (30) on top of
    // `WEEKLY_TILE_GRANT` at each of the four boundaries it crosses. The task
    // brief predicted that this re-bases *"the death tick, the trips, the tile
    // ledger, the week rows"* and all six census figures, on the reasoning that
    // more tiles build more road sooner.
    //
    // **It does not, and the refutation was derivable from the line below
    // before the run.** `armGreedyActions` reads the budget in exactly ONE
    // place — `if (found.cost > tilesLeft(state)) { tally.unaffordable++;
    // continue }` — and `r.unaffordable` is **0** across all 21,783 ticks, with
    // a floor of 37 tiles in hand. The connector was never once refused for
    // money, so money it did not need changes nothing it does: same strokes,
    // same order, same ticks. Every behavioural figure in this case is
    // therefore UNMOVED, and the assertions above are the evidence rather than
    // the claim.
    //
    // The floor and the ceiling below ARE moved, and both are re-derived:
    // `armLedgerWithoutCards` subtracts the grants back out and must give the
    // pre-Task-7 pair `37` / `94` — reproduce before you contradict.
    expect(r.unaffordable, 'the greedy policy never once could not afford its next connection').toBe(0)
    expect(r.cardsTaken, 'four boundaries inside 21,783 ticks: 4,500 / 9,000 / 13,500 / 18,000').toBe(4)
    const preCards = armLedgerWithoutCards(r.weeks)
    expect(Math.min(...preCards), 'the pre-Task-7 floor, recovered exactly').toBe(37)
    expect(Math.max(...preCards), 'and the pre-Task-7 ceiling').toBe(94)
    expect(preCards, 'week by week, so the recovery is visible and not just its extremes').toEqual([
      37, 50, 74, 94, 94,
    ])
    // ...and the ledger the arm now carries. Every row differs from the row
    // above it by that week's cumulative card grant and by nothing else.
    // ...and the ledger the arm now carries. Row by row the difference is
    // `0 / 20 / 40 / 60 / 90` — three JUNCTION UPGRADE cards at 20 in weeks 1,
    // 2 and 3 and a ROAD TILES card at 30 in week 4 — which is `armCardTiles`
    // below, and nothing else moved with it.
    expect(r.weeks.map((w) => w.tilesLeft), 'the post-Task-7 ledger').toEqual([37, 70, 114, 154, 184])
    expect(r.upgradesHeld, 'three upgrade cards at UPGRADES_PER_CARD items each').toBe(6)
    expect(armCardTiles(r), '3 x 20 + 1 x 30').toBe(90)
    expect(
      r.weeks.map((w, i) => (w.tilesLeft - (preCards[i] as number))),
      'the cumulative card grant, week by week — the whole difference between the two ledgers',
    ).toEqual([0, 20, 40, 60, 90])

    // ---------------------------------------------------------------------
    // THE FIRST HONEST COUNT OF THE ANTI-DEADLOCK VALVE ON A PLAYED BOARD
    // ---------------------------------------------------------------------
    //
    // `constants.ts`'s MAX_BLOCKED_TICKS block records the valve on the two
    // shipped boards with NO input, where `city` scores zero refusals for the
    // dull reason that no road exists. This is the other arm: 21,704 ticks of
    // competent play, cars genuinely standing behind each other from week 2.
    //
    // **Pre-M1f the worst wait any car ever took was 32 ticks, 1.07 s, a factor
    // of 42 below the threshold, and the valve could not fire at all. Under
    // junction exclusion the counter SATURATES and the valve fires — 15 times
    // under Task 2's wide rule and 5 under Task 3's.** M1d's headline feature
    // stopped being demo-only at Task 2 and stays that way here: this is the
    // firing of the anti-deadlock valve on the board that ships, outside a
    // purpose-built fixture, and it is the direct consequence of the head-on
    // property being lost at junctions. **Task 3 gives it back for the STRAIGHT
    // swap and not for the turning one, which is why the count falls to 5
    // rather than to 0** — two cars swapping across an edge with a junction at
    // each end resolve in one tick when both entered on the shared axis, and
    // still deadlock when either entered on another. `blocking.test.ts`'s
    // *"breaks the 2-cycle"* is that fixture; Task 9's upgrade is the relief.
    expect(r.maxBlockedTicks, 'the worst wait, in ticks — SATURATED').toBe(MAX_BLOCKED_TICKS)
    expect(r.maxBlockedTicks, 'and that is the constant, not a coincidence').toBe(1350)
    expect(r.valveFirings, 'the valve fires on the board that ships — 15 under the wide rule').toBe(5)

    // ---------------------------------------------------------------------
    // THE JUNCTION CENSUS, BOTH POLICIES, AND ONE FIGURE THAT DID NOT
    // REPRODUCE
    // ---------------------------------------------------------------------
    //
    // BOTH censuses, measured on the SAME run as every other figure in this
    // block. Their vacuity guard is their neighbours: `r.deathTick`, `r.trips`
    // and the seven week rows are pinned above, so this adds no second copy of
    // them.
    //
    // **THESE FIGURES ARE NOW POST-RULE AND THEY ARE NOT THE ONES TASK 1
    // MEASURED, because a census is measured ON A RUN and this task changed the
    // run.** Task 1's figures — 232 / 15,001 / six cells for co-presence,
    // 538 / 10,207 / six for rule-visible — describe the pre-M1f board, are
    // correct for it, and are what the rest of the milestone dates from. What
    // this block asserts is what the SAME two instruments say about the board
    // Task 2 ships. Nothing about the census module changed.
    //
    // **Co-presence falls a long way and does not disappear, and both halves
    // are the rule working.** Co-presence is *two different cars in the two
    // lanes of one junction cell at the end of a tick*. Task 2's wide rule
    // forbids that outright and took 232 to **11**, all of them valve
    // displacements. Task 3's rule permits it whenever the two cars entered on
    // the SAME axis — which is the whole content of the narrowing — so 42 is
    // the expected shape: 11-ish valve displacements plus the same-axis pairs
    // the wide rule was refusing. A count at or below the wide rule's 11 would
    // mean the narrowing had not landed.
    expect(r.conflicts, 'co-presence conflicts — 232 pre-M1f, 11 under the wide rule').toBe(42)
    expect(r.firstConflictTick, 'the first one, 2,657 ticks later than pre-M1f').toBe(15001)
    expect(
      r.firstConflictTick,
      'and UNMOVED from pre-M1f: the pair at 15,001 is a same-axis one, which this rule admits',
    ).toBe(15001)
    expect(r.conflictCells.length, 'four cells, down from six').toBe(4)
    expect(r.conflictCells).toEqual([
      [468, 21], // (12,19)
      [537, 12], // (9,22)
      [560, 8], //  (8,23)
      [512, 1], //  (8,21)
    ])

    // **Rule-visible does NOT disappear, and the reason is the fairness rule.**
    // Its `swapped` disjunct counts a cell holding car `a` at the end of tick
    // `t-1` and a different car `b` at the end of `t`. That is still reachable
    // whenever the LEAVER has the lower car index: `runMovement` ascends, `a`
    // releases the cell, and `b` then finds both lanes free. So the census stays
    // non-zero where co-presence collapses — 538 becomes **44** under the wide
    // rule and **133** under this one, not 0 — and the fall is mostly the run
    // being 31 % shorter and the board carrying far fewer completed crossings,
    // not the predicate going blind.
    //
    // **`firstRuleEventTick` is UNMOVED at 10,207, and that is the load-bearing
    // one.** It is unmoved precisely because the event at 10,207 is one of those
    // lower-index-leaver swaps: the rule permits it, so the state at the end of
    // that tick is byte-identical to the previous commit's. The first tick on
    // which any byte differs is **12,780** — measured by fingerprint, see the
    // block header. The census is an over-approximation of divergence by
    // 2,573 ticks (85.8 s), and both numbers are right about different things.
    expect(r.ruleEvents, 'rule-visible events — 538 pre-M1f, 44 under the wide rule').toBe(133)
    expect(
      r.firstRuleEventTick,
      'UNMOVED at 10,207 (5:31.6): the rule permits that swap, so the board is still bit-identical there',
    ).toBe(10207)
    expect(r.ruleEventCells.length, 'five cells, down from six').toBe(5)
    expect(r.ruleEventCells).toEqual([
      [468, 59], // (12,19)
      [537, 32], // (9,22)
      [560, 22], // (8,23)
      [422, 18], // (14,17)
      [512, 2], //  (8,21)
    ])

    // The superset, asserted rather than left to a comment, because it is the
    // half that no re-measurement can move: the rule-visible branch contains the
    // co-presence predicate verbatim as one of its disjuncts, so every
    // co-presence event is a rule-visible event at the same cell on the same
    // tick. It held pre-M1f at six cells against six and it holds here at four
    // against five, which is the stronger test of the two — the sets are now
    // different sizes, so a mutant that swapped the two tallies would show.
    for (const [cell] of r.conflictCells) {
      expect(
        r.ruleEventCells.some(([c]) => c === cell),
        `co-presence cell ${cell} is missing from the rule-visible table, which is impossible`,
      ).toBe(true)
    }
    expect(r.ruleEvents, 'rule-visible strictly contains co-presence').toBeGreaterThan(r.conflicts)

    // The relationship between the two. The DIRECTION is what matters and it
    // survives every rule this milestone has tried — the rule-visible policy
    // diverges earlier than co-presence sees it — while the gap goes 159.8 s
    // pre-M1f, 248.4 s under the wide rule (which delayed the valve firings
    // co-presence was reduced to counting) and **159.8 s again here**, because
    // both endpoints are back where they were: 10,207 and 15,001, to the tick.
    expect(r.firstRuleEventTick, 'the rule diverges EARLIER than co-presence, not later')
      .toBeLessThan(r.firstConflictTick)
    expect((r.firstConflictTick - r.firstRuleEventTick) / TICKS_PER_SECOND).toBeCloseTo(159.8, 1)
  })

  it('is not vacuous: the three arms are three different runs, not one run reported thrice', () => {
    const none = armRun('no-input')
    const opening = armRun('opening')
    const greedy = armRun('greedy')
    // Every pair differs in the death tick, the killer AND the trip count, so
    // no two of them can be the same drive with a different label.
    const ticks = [none.deathTick, opening.deathTick, greedy.deathTick]
    expect(new Set(ticks).size).toBe(3)
    expect(new Set([none.failedDest, opening.failedDest, greedy.failedDest]).size).toBe(3)
    expect(new Set([none.trips, opening.trips, greedy.trips]).size).toBe(3)
    // And the ordering the flip is FOR: doing nothing is worst, twenty tiles
    // buys three and a half minutes, keeping up buys fourteen more.
    expect(none.deathTick).toBeLessThan(opening.deathTick)
    expect(opening.deathTick).toBeLessThan(greedy.deathTick)
  })
})
