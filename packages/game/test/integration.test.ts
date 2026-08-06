import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  COST_UNIT_SCALE,
  DIAG_COST,
  FIRST_PIN_DELAY_TICKS,
  PIN_PERIOD_TICKS,
} from '@laneways/shared'
import {
  H_DEST_COUNT,
  H_HOUSE_COUNT,
  H_SCORE,
  H_TICK,
  H_TILES,
  PHASE_NONE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
} from '@laneways/sim'
import { PALETTE, type AtlasContext, type AtlasSurface } from '@laneways/render'
import { TICK_MS } from '../src/loop'
import { PointerOutcome } from '../src/pointer'
import { EraseControlSurface } from '../src/eraseControl'
import {
  CANVAS_ELEMENT_ID,
  SEED_FIRST_PIN_TICK,
  WARM_START_TICKS,
  attachPointerEvents,
  attachVisibility,
  createGame,
  shouldAutoStart,
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
type Command = FillCommand | BlitCommand | TextCommand

/**
 * The 2D context, recording. It satisfies `GameContext` structurally — the
 * shell's `setTransform` and the draw path's fills, text and blits — which is
 * the whole of plan Decision 8: production passes a canvas and this passes a
 * recorder, with no branch between them.
 */
class RecordingContext {
  fillStyle: string | CanvasGradient | CanvasPattern = ''
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

function buildRig(options: { warmStartTicks?: number; fallback?: boolean } = {}): Rig {
  const ctx = new RecordingContext()
  let view: (typeof M0_VIEW) | (typeof NARROW_VIEW) = M0_VIEW
  const game = createGame({
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
  })

  const camera = (): ReturnType<typeof game.shell.resize> extends never ? never : Game['shell']['camera'] =>
    game.shell.camera

  let now = 1000
  return {
    game,
    ctx,
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
/** Every car slot Task 2's seed creates is live from tick 0 — 3 houses x 2 cars. */
const LIVE_CAR_SLOTS = 6

/** The absolute tick the trip car is dispatched on. See `SEED_FIRST_PIN_TICK`. */
const DISPATCH_TICK = SEED_FIRST_PIN_TICK
/** The absolute tick `H_SCORE` reaches 1. Task 2's own `FIRST_SCORE_TICK`. */
const SCORE_TICK = 435

/**
 * The frame this file asserts an ABSOLUTE drawn position on, and every term of
 * its derivation.
 *
 * The car is five ticks into its first edge — NW out of house 1 at (8, 13),
 * `edgeCost(NW) = DIAG_COST = 14`, threshold `14 * COST_UNIT_SCALE = 3500` — and
 * has crossed nothing, so both snapshots resolve on the same edge:
 *
 * ```
 * tick 382 (prev)   carProgress = 5 x 330 = 1650   f = 1650/3500 = 0.4714285714...
 * tick 383 (curr)   carProgress = 6 x 330 = 1980   f = 1980/3500 = 0.5657142857...
 * DX[NW], DY[NW] = (-1, -1)
 * prev = (8 - 0.4714285714, 13 - 0.4714285714)     curr = (8 - 0.5657142857, 13 - ...)
 * alpha = 0.5  ->  (7.4814285714..., 12.4814285714...)
 * ```
 *
 * and the camera turns that into CSS px, `originX = 0`, `originY = 86`,
 * `tileSize = 29`, `x0 = 5`, `y0 = 9`, a sprite half a tile wide centred on the
 * position:
 *
 * ```
 * x = 0  + (7.4814285714 - 5) x 29 + 29/2 - 29/4 =  71.9614285714 + 7.25 =  79.2114285714
 * y = 86 + (12.4814285714 - 9) x 29 + 29/2 - 29/4 = 100.9614285714 + 7.25 + 86 = 194.2114285714
 * ```
 *
 * **This is the only assertion in the file that a uniform one-tick offset cannot
 * satisfy**, which is exactly what "draw before stepping" produces: the same
 * frame would then draw the tick-382 lerp, at x = 81.9457, 2.73 CSS px away.
 */
const ABS_TICK = 383
const ABS_ALPHA = 0.5
const ABS_PROGRESS_PREV = 1650
const ABS_PROGRESS_CURR = 1980
const ABS_X = 79.21142857142857
const ABS_Y = 194.21142857142857

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
      frames.push({ tick, phase, alpha: game.loop.alpha, x: car.x, y: car.y, gx, gy, cars: cars.length })
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
    expect(game.atlas.tileDevicePx).toBe(58)
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
    for (const f of trip.frames) expect(f.cars).toBe(LIVE_CAR_SLOTS)
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

  it('draws the car at a HAND-COMPUTED absolute position on tick 383 at alpha 0.5', () => {
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
    expect(drawnCars(rig.ctx.log, rig.game.shell.camera.tileSize).length).toBe(LIVE_CAR_SLOTS)
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
    expect(rig.game.atlas.tileDevicePx).toBe(44)

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
