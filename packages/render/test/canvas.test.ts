import { describe, it, expect } from 'vitest'
import { buildAtlas, type Atlas, type AtlasContext, type AtlasSurface } from '../src/atlas'
import {
  CAR_SIZE_FRACTION,
  DEST_ORIENTATION_N,
  DEST_ORIENTATION_S,
  HUD_FONT,
  MAX_DRAWN_PINS,
  destFootprintH,
  destFootprintW,
  drawFrame,
  type DrawContext,
  type DrawImageSource,
} from '../src/canvas'
import { createHudRects, fitCamera, hudRects } from '../src/camera'
import { PALETTE } from '../src/palette'
import { TerrainClass } from '../src/types'
import type { Camera, Palette, RenderFrame } from '../src/types'

/**
 * Task 5's test vocabulary is **recorded drawing state, not pixels** — the same
 * abstraction Task 4 established, for the same reason: this workspace has no
 * jsdom, no `canvas` module and no vitest DOM config, so `drawFrame` is
 * exercised through an injected recording context (plan Decision 8).
 *
 * **What that vocabulary can see is larger than it first looks, and Task 4's
 * review is the standing warning against assuming otherwise.** Its first report
 * filed the round cap's footprint under "browser property, only the deploy can
 * check it"; the footprint is `lineWidth / 2` by the canvas spec, and a real
 * Critical was sitting under the excuse. So every "cannot observe" claim in this
 * task's report is a derivation, not an intuition — see report §8.
 *
 * Three things this file records that a naive stub would not:
 *
 * 1. **State assignments, through real accessors**, so "the land band was filled
 *    in the land colour" is an assertion about an assignment the code made and
 *    not about a field's final value.
 * 2. **The effective `fillStyle` at the moment of every paint**, which is what
 *    lets a colour assertion name a rect rather than an index.
 * 3. **`clearRect`** — which `DrawContext` deliberately does NOT declare. The
 *    recorder implements it anyway, so the "issue a `clearRect`" mutation
 *    (plan Decision 4's free-looking, full-canvas-pass-costing hygiene) actually
 *    RUNS and dies on an assertion, instead of dying as a `TypeError` that reads
 *    exactly like a kill and is not one.
 */

// ---------------------------------------------------------------------------
// The recording context
// ---------------------------------------------------------------------------

interface FillRectCommand {
  readonly op: 'fillRect'
  readonly fillStyle: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

interface DrawImageCommand {
  readonly op: 'drawImage'
  readonly image: DrawImageSource
  readonly sx: number
  readonly sy: number
  readonly sw: number
  readonly sh: number
  readonly dx: number
  readonly dy: number
  readonly dw: number
  readonly dh: number
}

interface FillTextCommand {
  readonly op: 'fillText'
  readonly fillStyle: string
  readonly font: string
  readonly textAlign: string
  readonly textBaseline: string
  readonly text: string
  readonly x: number
  readonly y: number
}

interface ClearRectCommand {
  readonly op: 'clearRect'
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

interface SetCommand {
  readonly op: 'set'
  readonly prop: string
  readonly value: string
}

type Command =
  | SetCommand
  | FillRectCommand
  | DrawImageCommand
  | FillTextCommand
  | ClearRectCommand

class RecordingContext implements DrawContext {
  readonly log: Command[] = []

  #fillStyle: string | CanvasGradient | CanvasPattern = '#000000'
  #font = '10px sans-serif'
  #textAlign: CanvasTextAlign = 'start'
  #textBaseline: CanvasTextBaseline = 'alphabetic'

  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this.#fillStyle
  }
  set fillStyle(value: string | CanvasGradient | CanvasPattern) {
    this.#fillStyle = value
    this.log.push({ op: 'set', prop: 'fillStyle', value: String(value) })
  }

  get font(): string {
    return this.#font
  }
  set font(value: string) {
    this.#font = value
    this.log.push({ op: 'set', prop: 'font', value })
  }

  get textAlign(): CanvasTextAlign {
    return this.#textAlign
  }
  set textAlign(value: CanvasTextAlign) {
    this.#textAlign = value
    this.log.push({ op: 'set', prop: 'textAlign', value })
  }

  get textBaseline(): CanvasTextBaseline {
    return this.#textBaseline
  }
  set textBaseline(value: CanvasTextBaseline) {
    this.#textBaseline = value
    this.log.push({ op: 'set', prop: 'textBaseline', value })
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.log.push({ op: 'fillRect', fillStyle: String(this.#fillStyle), x, y, w, h })
  }

  fillText(text: string, x: number, y: number): void {
    this.log.push({
      op: 'fillText',
      fillStyle: String(this.#fillStyle),
      font: this.#font,
      textAlign: this.#textAlign,
      textBaseline: this.#textBaseline,
      text,
      x,
      y,
    })
  }

  drawImage(
    image: DrawImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    this.log.push({ op: 'drawImage', image, sx, sy, sw, sh, dx, dy, dw, dh })
  }

  /**
   * **Not part of `DrawContext`, and that is the point.** Production code that
   * reaches for `clearRect` is a type error; this recorder implements it so the
   * mutation that reaches for it anyway executes and is killed by the assertion
   * below rather than by a `TypeError` on a missing method. A crash count reads
   * exactly like a kill count (the catalogue's most expensive entry), and the
   * fix belongs in the harness, not in the reading of the harness's output.
   */
  clearRect(x: number, y: number, w: number, h: number): void {
    this.log.push({ op: 'clearRect', x, y, w, h })
  }
}

// ---------------------------------------------------------------------------
// A minimal atlas, built through the real builder
// ---------------------------------------------------------------------------

/** The smallest thing `buildAtlas` will accept as a surface; it records nothing. */
class SilentSurface implements AtlasSurface {
  width: number
  height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }
  getContext(): AtlasContext | null {
    return SILENT_CONTEXT
  }
}

const SILENT_CONTEXT: AtlasContext = {
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  strokeStyle: '#000000',
  save: () => undefined,
  restore: () => undefined,
  beginPath: () => undefined,
  rect: () => undefined,
  clip: () => undefined,
  moveTo: () => undefined,
  lineTo: () => undefined,
  stroke: () => undefined,
}

function atlasAt(tileDevicePx: number, palette: Palette = PALETTE): Atlas {
  return buildAtlas((w, h) => new SilentSurface(w, h), tileDevicePx, palette)
}

// ---------------------------------------------------------------------------
// Fixture A: the M0 device, the REAL revealed rect
// ---------------------------------------------------------------------------

/**
 * 406x870 CSS, insets 46/34, raw DPR 3 (capped to 2), the frozen revealed rect
 * `{5, 9, 14, 22}`. Every number below is hand-computed from Task 3's fit and
 * matches its report §2 worked example A:
 *
 * ```
 * availableH = 870 - 46 - 72 - 34 = 718
 * tileSize   = floor(min(406/14, 718/22)) = floor(min(29, 32.63..)) = 29   (WIDTH binds)
 * originX    = floor((406 - 406)/2) = 0        originY = 46 + floor((718 - 638)/2) = 86
 * hudTop     = max(86 + 638, 870 - 34 - 72) = 764        dpr = min(3, 2) = 2
 * ```
 */
const A_BOARD_W = 24
const A_BOARD_H = 40
const A_TILE = 29
const A_ORIGIN_X = 0
const A_ORIGIN_Y = 86
const A_HUD_TOP = 764

function cameraA(): Camera {
  return fitCamera(
    { cssW: 406, cssH: 870, topInset: 46, bottomInset: 34, rawDpr: 3, performanceClass: null },
    { x0: 5, y0: 9, cols: 14, rows: 22 },
  )
}

/**
 * A frame on the real revealed rect carrying **one car at the brief's exact
 * fractional position**, `(x0 + 3.5, y0 + 7.25)` = `(8.5, 16.25)`.
 *
 * Both coordinates are exactly representable in `Float32Array` (8.5 and 16.25
 * are dyadic), so nothing here is a rounding artefact of the storage type —
 * which a position like `8.3` would have been.
 */
function frameA(paused = false): RenderFrame {
  const cells = A_BOARD_W * A_BOARD_H
  const carXY = new Float32Array(2)
  carXY[0] = 8.5
  carXY[1] = 16.25
  return {
    camera: cameraA(),
    gridW: A_BOARD_W,
    roads: new Uint8Array(cells),
    terrainClass: new Uint8Array(cells),
    houseCount: 0,
    houseCell: new Int32Array(0),
    houseColour: new Uint8Array(0),
    destCount: 0,
    destCell: new Int32Array(0),
    destColour: new Uint8Array(0),
    destKind: new Uint8Array(0),
    destOrientation: new Uint8Array(0),
    destPins: new Uint8Array(0),
    destCarpark: new Int32Array(0),
    carCount: 1,
    carXY,
    carColour: new Uint8Array([3]),
    week: 1,
    day: 0,
    score: 0,
    tilesLeft: 40,
    paused,
  }
}

// ---------------------------------------------------------------------------
// Fixture B: a small board whose revealed rect is a STRICT sub-rect
// ---------------------------------------------------------------------------

/**
 * An 8x6 board revealing `{x0: 1, y0: 1, cols: 6, rows: 4}` — the shape Task 3's
 * report §1 prescribes, and it is load-bearing four times over:
 *
 * 1. **The rect is a strict sub-rect**, so "inside the drawn region" has an
 *    outside. Task 3's first liveness fixture revealed the whole board and its
 *    `inside()` could not return false for any cell that exists.
 * 2. **`gridW` (8) differs from `cols` (6)**, so reading `terrainClass` with the
 *    camera's stride instead of the board's lands on a different cell.
 * 3. **The board is not square** (8x6) and `x0 === y0` is avoided nowhere else,
 *    so a transposed index is visible.
 * 4. **`originX` (2) is non-zero and differs from `originY` (192)**, so a
 *    dropped or swapped origin moves every literal.
 *
 * ```
 * availableH = 700 - 40 - 72 - 20 = 568
 * tileSize   = floor(min(400/6, 568/4)) = floor(min(66.67, 142)) = 66   (WIDTH binds)
 * originX    = floor((400 - 396)/2) = 2        originY = 40 + floor((568 - 264)/2) = 192
 * hudTop     = max(192 + 264, 700 - 20 - 72) = 608        dpr = min(2, 2) = 2
 * ```
 */
const B_W = 8
const B_H = 6
const B_CELLS = B_W * B_H
const B_TILE = 66
const B_ORIGIN_X = 2
const B_ORIGIN_Y = 192
const B_HUD_TOP = 608
const B_CSS_W = 400
const B_CSS_H = 700
/** `tileSize * dpr` — what `game` builds the atlas at (plan Decision 6). */
const B_TILE_DEVICE = 132

function cameraB(): Camera {
  return fitCamera(
    { cssW: B_CSS_W, cssH: B_CSS_H, topInset: 40, bottomInset: 20, rawDpr: 2, performanceClass: null },
    { x0: 1, y0: 1, cols: 6, rows: 4 },
  )
}

/** Board cell -> CSS x of its left edge, hand-checked against the literals below. */
function bx(x: number): number {
  return B_ORIGIN_X + (x - 1) * B_TILE
}
function by(y: number): number {
  return B_ORIGIN_Y + (y - 1) * B_TILE
}

/**
 * The minimal frame the whole-log literal is written against. Its contents are
 * chosen so the plan's vacuity self-checks hold by construction and so every
 * culling and liveness rule has something on BOTH sides of it:
 *
 * ```
 *  y\x   0        1         2       3        4       5       6       7
 *   0   WATER*    .         .       .        .       .       .       .
 *   1    .      (dead)     WATER    carpark  DEST    DEST    DEST     .
 *   2    .       TREE       .       road     DEST    DEST    DEST     .
 *   3   road*    MOUNTAIN   .       .        .       .       .        .
 *   4    .       house      .       car      .       car     house    .
 *   5    .        .         .       .        .       .       .      TREE*
 * ```
 *
 * `*` is outside the revealed rect `x in [1, 7), y in [1, 5)`. The two starred
 * road cells and both starred terrain cells carry NON-ZERO values, because "an
 * empty mask" is the other thing that could prevent a blit and the fixture must
 * not let it be what makes the culling assertion pass.
 *
 * The dead house / destination / car slots all sit at cell `(1, 1)` — **inside**
 * the rect and non-zero — because the sim's real dead value is cell 0, which is
 * outside every M2 camera, so a fixture parking dead slots there is proved
 * correct by the bounds check and never exercises the liveness prefix at all.
 */
function frameB(paused = false): RenderFrame {
  const roads = new Uint8Array(B_CELLS)
  roads[2 * B_W + 3] = 17 // (3, 2), N|S — inside, non-zero
  roads[3 * B_W + 0] = 5 // (0, 3), N|E — OUTSIDE, and non-zero on purpose

  const terrainClass = new Uint8Array(B_CELLS)
  terrainClass[1 * B_W + 2] = TerrainClass.WATER // (2, 1)
  terrainClass[2 * B_W + 1] = TerrainClass.TREE // (1, 2)
  terrainClass[3 * B_W + 1] = TerrainClass.MOUNTAIN // (1, 3)
  terrainClass[0] = TerrainClass.WATER // (0, 0) — OUTSIDE
  terrainClass[5 * B_W + 7] = TerrainClass.TREE // (7, 5) — OUTSIDE

  // Two live houses, two dead slots at (1, 1).
  const houseCell = new Int32Array([4 * B_W + 1, 4 * B_W + 6, 1 * B_W + 1, 1 * B_W + 1])
  const houseColour = new Uint8Array([2, 5, 0, 0])

  // One live destination anchored at (4, 1), orientation W -> a 3x2 box with its
  // carpark one cell to the left, at (3, 1). One dead slot at (1, 1), oriented E
  // so that drawing it would cover the very cell the liveness assertion probes.
  const destCell = new Int32Array([1 * B_W + 4, 1 * B_W + 1])
  const destColour = new Uint8Array([4, 1])
  const destKind = new Uint8Array([0, 1])
  const destOrientation = new Uint8Array([3, 1])
  const destPins = new Uint8Array([3, 5])
  const destCarpark = new Int32Array([1 * B_W + 3, 1 * B_W + 4])

  // Two live cars, six dead slots at (1, 1). Every coordinate is dyadic and so
  // exact in a Float32Array.
  const carXY = new Float32Array(16)
  carXY[0] = 3
  carXY[1] = 4
  carXY[2] = 5.5
  carXY[3] = 3
  for (let i = 4; i < 16; i += 2) {
    carXY[i] = 1
    carXY[i + 1] = 1
  }
  const carColour = new Uint8Array([1, 3, 0, 0, 0, 0, 0, 0])

  return {
    camera: cameraB(),
    gridW: B_W,
    roads,
    terrainClass,
    houseCount: 2,
    houseCell,
    houseColour,
    destCount: 1,
    destCell,
    destColour,
    destKind,
    destOrientation,
    destPins,
    destCarpark,
    carCount: 2,
    carXY,
    carColour,
    week: 3,
    day: 5,
    score: 12,
    tilesLeft: 17,
    paused,
  }
}

/**
 * Fixture B with **one live entry past each of the four revealed-rect bounds**.
 *
 * `insideRevealed` is four comparisons and a fixture with a single out-of-rect
 * corner gives two of them no detector: drop `x >= x0` and a cell at (0, 0) is
 * still culled by `y >= y0`, so the mutant lives inside a caught one. Each
 * house below is outside on exactly one bound, which the companion test asserts
 * rather than assumes.
 */
function outOfRectFrame(): RenderFrame {
  const base = frameB()
  const houseCell = new Int32Array([
    4 * B_W + 1, // live, inside
    4 * B_W + 6, // live, inside
    3 * B_W + 7, // (7, 3) — past x0 + cols only
    3 * B_W + 0, // (0, 3) — before x0 only
    0 * B_W + 3, // (3, 0) — before y0 only
    5 * B_W + 3, // (3, 5) — past y0 + rows only
  ])
  const carXY = new Float32Array(base.carXY)
  carXY[4] = 6
  carXY[5] = 5 // a live car past the bottom edge
  const destCell = new Int32Array([...base.destCell])
  destCell[1] = 0 // a live destination anchored outside, at (0, 0)
  return {
    ...base,
    houseCount: 6,
    houseCell,
    houseColour: new Uint8Array([2, 5, 0, 1, 2, 3]),
    destCount: 2,
    destCell,
    carCount: 3,
    carXY,
  }
}

// ---------------------------------------------------------------------------
// Reading the recording back
// ---------------------------------------------------------------------------

interface Painted {
  readonly index: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly command: Command
}

function draw(frame: RenderFrame, atlas: Atlas, palette: Palette = PALETTE): Command[] {
  const ctx = new RecordingContext()
  drawFrame(ctx, frame, atlas, palette)
  return ctx.log
}

/** Every command that puts ink inside a known rectangle: fills and blits. */
function painted(log: readonly Command[]): Painted[] {
  const out: Painted[] = []
  log.forEach((command, index) => {
    if (command.op === 'fillRect') {
      out.push({ index, x: command.x, y: command.y, w: command.w, h: command.h, command })
    } else if (command.op === 'drawImage') {
      out.push({ index, x: command.dx, y: command.dy, w: command.dw, h: command.dh, command })
    }
  })
  return out
}

/**
 * The three full-canvas-width band fills, in issue order.
 *
 * Classified by `x === 0 && w === cssW` and nothing else — no content rect can
 * be that wide (the widest is a 3-tile destination footprint, 198 of 400 CSS
 * px), and the classifier therefore uses the camera rather than any knowledge of
 * `drawFrame`'s structure. Every caller asserts the count is 3, which is what
 * makes it a non-vacuous filter.
 */
function bands(log: readonly Command[], camera: Camera): Painted[] {
  return painted(log).filter((p) => p.x === 0 && p.w === camera.cssW)
}

/** Everything painted that is NOT one of the three bands. */
function content(log: readonly Command[], camera: Camera): Painted[] {
  const all = painted(log)
  const rest = all.filter((p) => !(p.x === 0 && p.w === camera.cssW))
  expect(all.length - rest.length, 'exactly three full-width band fills').toBe(3)
  return rest
}

/** The content paints covering a CSS point, half-open on the right and bottom. */
function covering(paints: readonly Painted[], px: number, py: number): Painted[] {
  return paints.filter((p) => px >= p.x && px < p.x + p.w && py >= p.y && py < p.y + p.h)
}

function fillsStyled(log: readonly Command[], fillStyle: string): FillRectCommand[] {
  return log.filter((c): c is FillRectCommand => c.op === 'fillRect' && c.fillStyle === fillStyle)
}

/**
 * Fills of a given size drawn in one of the six **colour-group** strings.
 *
 * Size alone does not identify an element: at fixture B's 66 px tile a car, a
 * tree and a carpark are all 33x33. The group colours are what separate the
 * things a colour group owns — houses, destinations and cars — from terrain and
 * furniture, and this classifier reads only the recording.
 */
function groupFills(log: readonly Command[], w: number, h: number): FillRectCommand[] {
  const groups = PALETTE.groups as readonly string[]
  return log.filter(
    (c): c is FillRectCommand =>
      c.op === 'fillRect' && c.w === w && c.h === h && groups.includes(c.fillStyle),
  )
}

function blits(log: readonly Command[]): DrawImageCommand[] {
  return log.filter((c): c is DrawImageCommand => c.op === 'drawImage')
}

function texts(log: readonly Command[]): FillTextCommand[] {
  return log.filter((c): c is FillTextCommand => c.op === 'fillText')
}

/** Index of the one command whose recorded rect matches exactly; -1 if none. */
function indexOfRect(log: readonly Command[], x: number, y: number, w: number, h: number): number {
  const hits = painted(log).filter((p) => p.x === x && p.y === y && p.w === w && p.h === h)
  expect(hits.length, `expected exactly one paint at ${x},${y} ${w}x${h}`).toBe(1)
  return hits[0]?.index ?? -1
}

// Literal builders. These construct EXPECTED values only; nothing here computes
// anything the implementation also computes.
function set(prop: string, value: string): SetCommand {
  return { op: 'set', prop, value }
}
function fill(fillStyle: string, x: number, y: number, w: number, h: number): FillRectCommand {
  return { op: 'fillRect', fillStyle, x, y, w, h }
}

const BACKGROUND = PALETTE.background
const LAND = PALETTE.land
const WATER = PALETTE.water
const MOUNTAIN = PALETTE.mountain
const TREE = PALETTE.tree
const ROAD_EDGE = PALETTE.roadEdge
const UI_TEXT = PALETTE.uiText
const GROUP = PALETTE.groups

// ---------------------------------------------------------------------------

describe('drawFrame: the entire recorded frame, hand-written', () => {
  it('records exactly this command sequence, in this order, with these coordinates', () => {
    // The strongest single assertion in this file: every command, every
    // coordinate and every colour of a complete frame, hand-computed from
    // fixture B's camera. It pins the draw order the plan calls load-bearing
    // (top band -> land -> terrain -> roads -> destinations -> houses -> cars
    // -> HUD band -> HUD content) together with the geometry of every element,
    // so a reordering and a mis-transform are the same failure to write down.
    const atlas = atlasAt(B_TILE_DEVICE)
    const log = draw(frameB(), atlas)

    expect(log).toEqual([
      // 1. the top band: canvas top down to the grid rect
      set('fillStyle', BACKGROUND),
      fill(BACKGROUND, 0, 0, 400, 192),
      // 2. the grid land band: down to the HUD band's top edge
      set('fillStyle', LAND),
      fill(LAND, 0, 192, 400, 416),
      // 3. non-land terrain, row-major over the revealed rect only
      set('fillStyle', WATER),
      fill(WATER, 68, 192, 66, 66), // (2, 1) — a whole cell
      set('fillStyle', TREE),
      fill(TREE, 18.5, 274.5, 33, 33), // (1, 2) — inset, land shows around it
      set('fillStyle', MOUNTAIN),
      fill(MOUNTAIN, 2, 324, 66, 66), // (1, 3)
      // 4. roads: one blit, from mask 17's tile at (1, 1) of the 16x16 atlas
      {
        op: 'drawImage',
        image: atlas.surface,
        sx: 132,
        sy: 132,
        sw: 132,
        sh: 132,
        dx: 134,
        dy: 258,
        dw: 66,
        dh: 66,
      },
      // 5. the destination: a 3x2 footprint, its carpark, then its waiting pins
      set('fillStyle', GROUP[4] as string),
      fill(GROUP[4] as string, 200, 192, 198, 132),
      set('fillStyle', ROAD_EDGE),
      fill(ROAD_EDGE, 150.5, 208.5, 33, 33),
      set('fillStyle', UI_TEXT),
      fill(UI_TEXT, 211, 203, 11, 11),
      fill(UI_TEXT, 233, 203, 11, 11),
      fill(UI_TEXT, 255, 203, 11, 11),
      // 6. houses, above roads because a road is legal on a house cell
      set('fillStyle', GROUP[2] as string),
      fill(GROUP[2] as string, 13, 401, 44, 44),
      set('fillStyle', GROUP[5] as string),
      fill(GROUP[5] as string, 343, 401, 44, 44),
      // 7. cars, above buildings because a car drives onto the carpark
      set('fillStyle', GROUP[1] as string),
      fill(GROUP[1] as string, 150.5, 406.5, 33, 33),
      set('fillStyle', GROUP[3] as string),
      fill(GROUP[3] as string, 315.5, 340.5, 33, 33),
      // 8. the HUD band, down to the canvas bottom (the safe-area inset included)
      set('fillStyle', BACKGROUND),
      fill(BACKGROUND, 0, 608, 400, 92),
      // 9. HUD content
      set('font', HUD_FONT),
      set('textAlign', 'center'),
      set('textBaseline', 'middle'),
      set('fillStyle', UI_TEXT),
      {
        op: 'fillText',
        fillStyle: UI_TEXT,
        font: HUD_FONT,
        textAlign: 'center',
        textBaseline: 'middle',
        text: 'W3 D5',
        x: 69,
        y: 644,
      },
      {
        op: 'fillText',
        fillStyle: UI_TEXT,
        font: HUD_FONT,
        textAlign: 'center',
        textBaseline: 'middle',
        text: '12 TRIPS',
        x: 199,
        y: 644,
      },
      {
        op: 'fillText',
        fillStyle: UI_TEXT,
        font: HUD_FONT,
        textAlign: 'center',
        textBaseline: 'middle',
        text: '17 TILES',
        x: 329,
        y: 644,
      },
    ])
  })

  it('is not vacuous: the fixture carries a house, a destination, a car, a non-zero road mask and two terrain classes', () => {
    // The plan's own vacuity self-check for this task. Without every one of
    // these the order assertion above asserts the order of nothing.
    const frame = frameB()
    expect(frame.houseCount).toBeGreaterThan(0)
    expect(frame.destCount).toBeGreaterThan(0)
    expect(frame.carCount).toBeGreaterThan(0)
    expect(frame.roads[2 * B_W + 3] as number).toBeGreaterThan(0)
    expect(frame.roads[3 * B_W + 0] as number).toBeGreaterThan(0)
    const classes = new Set<number>()
    for (const t of frame.terrainClass) classes.add(t)
    expect(classes.size).toBeGreaterThanOrEqual(2)
    expect(classes).toContain(TerrainClass.LAND)
    expect(classes).toContain(TerrainClass.TREE)
  })
})

describe('the draw order the plan calls load-bearing', () => {
  it('draws bands, terrain, roads, destinations, houses, cars, HUD band and HUD content in that order', () => {
    // Each index is located by a hand-written rect, so this reads the recording
    // and never the implementation. Stated as a chain of strict inequalities
    // because that is exactly what "buildings above roads, cars above
    // buildings" means for a painter's-algorithm renderer.
    const atlas = atlasAt(B_TILE_DEVICE)
    const log = draw(frameB(), atlas)

    const topBand = indexOfRect(log, 0, 0, 400, 192)
    const landBand = indexOfRect(log, 0, 192, 400, 416)
    const terrain = indexOfRect(log, 68, 192, 66, 66) // the water cell
    const road = indexOfRect(log, 134, 258, 66, 66) // the blit
    const dest = indexOfRect(log, 200, 192, 198, 132) // the footprint
    const carpark = indexOfRect(log, 150.5, 208.5, 33, 33)
    const house = indexOfRect(log, 13, 401, 44, 44)
    const car = indexOfRect(log, 150.5, 406.5, 33, 33)
    const hudBand = indexOfRect(log, 0, 608, 400, 92)
    const hudText = log.findIndex((c) => c.op === 'fillText')

    expect(topBand).toBeLessThan(landBand)
    expect(landBand).toBeLessThan(terrain)
    expect(terrain).toBeLessThan(road)
    expect(road).toBeLessThan(dest) // a road is legal on a carpark cell
    expect(dest).toBeLessThan(carpark)
    expect(carpark).toBeLessThan(house)
    expect(house).toBeLessThan(car) // a car drives ONTO the carpark
    expect(car).toBeLessThan(hudBand)
    expect(hudBand).toBeLessThan(hudText)
    expect(hudText).toBeGreaterThan(0)
  })
})

describe('no clearRect, and three opaque fills that tile the canvas exactly', () => {
  it('issues no clearRect anywhere', () => {
    // Plan Decision 4: a clearRect plus a land fill covers the canvas twice. At
    // M2's regime on the M0 device that is a wasted full-canvas pass —
    // 1,412,880 device px, ~0.141 ms, more than the entire road layer costs.
    // The mutation is FREE to write and looks like defensive hygiene, which is
    // exactly why it needs an assertion rather than a comment.
    const log = draw(frameB(), atlasAt(B_TILE_DEVICE))
    expect(log.filter((c) => c.op === 'clearRect')).toEqual([])
  })

  it('is not vacuous: the recorder DOES see a clearRect when one is issued', () => {
    // Positive control for the assertion above. Without it, a recorder that
    // silently dropped `clearRect` — or a `DrawContext` the mutation cannot
    // even call — would make "no clearRect was issued" true for the wrong
    // reason, and the mutation would die as a TypeError that reads exactly like
    // a kill.
    const ctx = new RecordingContext()
    ctx.clearRect(1, 2, 3, 4)
    expect(ctx.log).toEqual([{ op: 'clearRect', x: 1, y: 2, w: 3, h: 4 }])
  })

  it('tiles the canvas with exactly three bands: no gap, no overlap, asserted against the camera', () => {
    const camera = cameraB()
    const strip = bands(draw(frameB(), atlasAt(B_TILE_DEVICE)), camera)

    expect(strip.length).toBe(3)
    // Every band spans the full width, and the three heights partition [0, cssH).
    let cursor = 0
    let area = 0
    for (const band of strip) {
      expect(band.x).toBe(0)
      expect(band.w).toBe(camera.cssW)
      expect(band.y, 'a gap or an overlap between two bands').toBe(cursor)
      expect(band.h).toBeGreaterThan(0)
      cursor = band.y + band.h
      area += band.w * band.h
    }
    expect(cursor, 'the last band must reach the canvas bottom').toBe(camera.cssH)
    expect(area).toBe(camera.cssW * camera.cssH)

    // And the two cut lines are the camera's own, not free parameters: the grid
    // rect's top edge and the HUD band's top edge.
    expect(strip.map((b) => b.y)).toEqual([0, camera.originY, camera.hudTop])
    expect(strip.map((b) => b.h)).toEqual([
      camera.originY,
      camera.hudTop - camera.originY,
      camera.cssH - camera.hudTop,
    ])
    // Hand-written, so the camera fields above cannot both drift together.
    expect(strip.map((b) => [b.y, b.h])).toEqual([
      [0, 192],
      [192, 416],
      [608, 92],
    ])
  })

  it('covers the M0 device’s whole backing store — plan Decision 4’s own 1,412,880 device px', () => {
    // The plan's frame model charges exactly one full-canvas fill for the three
    // bands. This is that number, recomputed from the recording: 406 x 870 CSS
    // at the DPR-2 cap is 812 x 1740 device px.
    const camera = cameraA()
    const strip = bands(draw(frameA(), atlasAt(58)), camera)

    expect(strip.length).toBe(3)
    expect(strip.map((b) => [b.y, b.h])).toEqual([
      [0, A_ORIGIN_Y],
      [A_ORIGIN_Y, A_HUD_TOP - A_ORIGIN_Y],
      [A_HUD_TOP, 870 - A_HUD_TOP],
    ])
    expect(strip.map((b) => [b.y, b.h])).toEqual([
      [0, 86],
      [86, 678],
      [764, 106],
    ])

    const cssArea = strip.reduce((sum, b) => sum + b.w * b.h, 0)
    expect(cssArea).toBe(406 * 870)
    expect(camera.dpr).toBe(2)
    expect(cssArea * camera.dpr * camera.dpr).toBe(1_412_880)
    // The bottom band covers the 34 px home-indicator inset as well as the 72 px
    // HUD band — 106, not 72. A band of exactly `hudHeight` leaves the inset
    // holding the previous frame forever, and no clearRect is coming to fix it.
    expect(strip[2]?.h).toBe(camera.hudHeight + 34)
  })

  it('fills all three bands with opaque palette colours', () => {
    // "Opaque" is the property the whole no-clearRect design rests on: a
    // translucent band would composite the previous frame instead of replacing
    // it. Every palette entry is a preallocated #rrggbb literal with no alpha
    // channel, and these three are asserted to be palette entries rather than
    // some other string.
    const strip = bands(draw(frameB(), atlasAt(B_TILE_DEVICE)), cameraB())
    const styles = strip.map((b) => (b.command.op === 'fillRect' ? b.command.fillStyle : ''))
    expect(styles).toEqual([BACKGROUND, LAND, BACKGROUND])
    for (const style of styles) expect(style).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('the transform: a car at a fractional grid position', () => {
  it('draws the brief’s car at (x0 + 3.5, y0 + 7.25) on a hand-computed CSS point', () => {
    // Hand-computed at fixture A (tile 29, origin (0, 86), x0 5, y0 9):
    //   centre x = 0  + (8.5  - 5) * 29 + 29/2 = 101.5 + 14.5 = 116
    //   centre y = 86 + (16.25 - 9) * 29 + 29/2 = 296.25 + 14.5 = 310.75
    //   half side = 0.5 * 29 / 2 = 7.25
    // There is NO notion of interpolation alpha anywhere in `render`: `game`
    // resolved this position before the frame was handed over, and drawing it
    // is one multiply.
    const camera = cameraA()
    const paints = content(draw(frameA(), atlasAt(58)), camera)
    expect(paints.length).toBe(1)
    expect(paints[0]?.command).toEqual({
      op: 'fillRect',
      fillStyle: GROUP[3] as string,
      x: 108.75,
      y: 303.5,
      w: 14.5,
      h: 14.5,
    })
    expect(A_TILE).toBe(29)
    expect(A_ORIGIN_X).toBe(camera.originX)
    expect(A_ORIGIN_Y).toBe(camera.originY)
  })

  it('treats an INTEGER carXY as the centre of that cell, not its corner', () => {
    // The convention `game`'s resolver must match (plan Decision 2: a parked car
    // resolves to "(cx, cy) of carCell", and a car half way along an orthogonal
    // edge to `(cx + 0.5, cy)`). So integer grid units name a cell CENTRE, and
    // the CSS centre is `gridToScreen(cell) + tileSize / 2` — the one place in
    // `render` where the two coordinate conventions meet.
    const frame = frameB()
    const camera = frame.camera
    const paints = content(draw(frame, atlasAt(B_TILE_DEVICE)), camera)
    // Car 0 sits at exactly (3, 4). Its rect must be centred in that cell.
    const car = paints.find((p) => p.w === 33 && p.h === 33 && p.y === 406.5)
    expect(car).toBeDefined()
    expect([car?.x, car?.y, car?.w, car?.h]).toEqual([150.5, 406.5, 33, 33])
    expect((car?.x ?? 0) + (car?.w ?? 0) / 2).toBe(bx(3) + B_TILE / 2)
    expect((car?.y ?? 0) + (car?.h ?? 0) / 2).toBe(by(4) + B_TILE / 2)
    expect(CAR_SIZE_FRACTION * B_TILE).toBe(33)
  })
})

describe('the liveness prefixes: counts, not array lengths', () => {
  it('draws exactly carCount cars from an array sized for eight', () => {
    const frame = frameB()
    expect(frame.carCount * 2).toBeLessThan(frame.carXY.length) // non-vacuity
    const log = draw(frame, atlasAt(B_TILE_DEVICE))
    expect(groupFills(log, 33, 33).length).toBe(2)
  })

  it('draws exactly houseCount houses and destCount destinations', () => {
    const frame = frameB()
    expect(frame.houseCount).toBeLessThan(frame.houseCell.length)
    expect(frame.destCount).toBeLessThan(frame.destCell.length)
    const log = draw(frame, atlasAt(B_TILE_DEVICE))
    expect(groupFills(log, 44, 44).length).toBe(2)
    expect(groupFills(log, 198, 132).length).toBe(1)
  })

  it('paints NOTHING at grid cell (x0, y0), where every dead slot was parked', () => {
    // The dead house, destination and car slots all name cell (1, 1). It is
    // inside the drawn rect and its index is 9, not 0 — so neither the camera's
    // bounds check nor a zero-cell special case can be what makes this pass.
    // Only reading `[0, count)` can.
    const frame = frameB()
    const camera = frame.camera
    const paints = content(draw(frame, atlasAt(B_TILE_DEVICE)), camera)
    const px = bx(camera.x0) + B_TILE / 2
    const py = by(camera.y0) + B_TILE / 2
    expect([px, py]).toEqual([35, 225])
    expect(covering(paints, px, py)).toEqual([])

    // POSITIVE CONTROL for `covering` itself: a negative assertion is worth
    // nothing if the probe cannot find anything anywhere. The centre of the
    // live water cell (2, 1) is painted, by exactly one command.
    expect(covering(paints, bx(2) + 33, by(1) + 33).length).toBe(1)
  })

  it('places every dead slot INSIDE the drawn rect, with a negative control on the test itself', () => {
    // Task 3's report §1, part 2, verbatim in shape: `expect(inside(x)).toBe(true)`
    // passes when `inside` always returns true, so the fixture must first prove
    // it can say false — and the cell it must say false about is 0, the sim's
    // real dead value.
    const frame = frameB()
    const camera = frame.camera
    const inside = (cell: number): boolean => {
      const x = cell % frame.gridW
      const y = Math.floor(cell / frame.gridW)
      return x >= camera.x0 && x < camera.x0 + camera.cols && y >= camera.y0 && y < camera.y0 + camera.rows
    }
    expect(inside(0), 'cell 0 must be OUTSIDE, or this fixture proves nothing').toBe(false)
    expect(inside(5 * B_W + 7)).toBe(false)
    expect(inside(1 * B_W + 1)).toBe(true)

    for (let i = frame.houseCount; i < frame.houseCell.length; i++) {
      expect(frame.houseCell[i] as number).not.toBe(0)
      expect(inside(frame.houseCell[i] as number), `dead house slot ${i}`).toBe(true)
    }
    for (let i = frame.destCount; i < frame.destCell.length; i++) {
      expect(frame.destCell[i] as number).not.toBe(0)
      expect(inside(frame.destCell[i] as number), `dead dest slot ${i}`).toBe(true)
    }
    for (let i = frame.carCount * 2; i < frame.carXY.length; i += 2) {
      const x = frame.carXY[i] as number
      const y = frame.carXY[i + 1] as number
      expect(x === 0 && y === 0, `dead car slot ${i / 2} sits on cell 0`).toBe(false)
      expect(x >= camera.x0 && x < camera.x0 + camera.cols).toBe(true)
      expect(y >= camera.y0 && y < camera.y0 + camera.rows).toBe(true)
    }
  })
})

describe('terrain: the drawing half of the fold', () => {
  it('draws NO per-cell paint for a LAND cell — the land band already covers it', () => {
    // "Draws the land colour" is satisfied by the band, and drawing it a second
    // time per cell is the double-coverage plan Decision 4 exists to remove.
    const frame = frameB()
    frame.terrainClass[2 * B_W + 1] = TerrainClass.LAND // (1, 2) was a tree
    const paints = content(draw(frame, atlasAt(B_TILE_DEVICE)), frame.camera)
    const centre = covering(paints, bx(1) + 33, by(2) + 33)
    expect(centre).toEqual([])

    // The other half of the claim: that point IS covered, by the land band.
    const landBand = bands(draw(frame, atlasAt(B_TILE_DEVICE)), frame.camera)[1]
    expect(landBand?.command.op === 'fillRect' ? landBand.command.fillStyle : '').toBe(LAND)
    expect(covering(landBand === undefined ? [] : [landBand], bx(1) + 33, by(2) + 33).length).toBe(1)
  })

  it('draws a tree on the same cell when the class is TREE, inset so land shows around it', () => {
    const frame = frameB() // (1, 2) is TREE
    const paints = content(draw(frame, atlasAt(B_TILE_DEVICE)), frame.camera)
    const centre = covering(paints, bx(1) + 33, by(2) + 33)
    expect(centre.length).toBe(1)
    expect(centre[0]?.command).toEqual(fill(TREE, 18.5, 274.5, 33, 33))
    // Strictly inside the cell, on all four sides.
    expect(18.5).toBeGreaterThan(bx(1))
    expect(18.5 + 33).toBeLessThan(bx(1) + B_TILE)
    expect(274.5).toBeGreaterThan(by(2))
    expect(274.5 + 33).toBeLessThan(by(2) + B_TILE)
  })

  it('fills the whole cell for water and for mountain', () => {
    const log = draw(frameB(), atlasAt(B_TILE_DEVICE))
    expect(fillsStyled(log, WATER)).toEqual([fill(WATER, 68, 192, 66, 66)])
    expect(fillsStyled(log, MOUNTAIN)).toEqual([fill(MOUNTAIN, 2, 324, 66, 66)])
  })

  it('draws nothing for a terrain class it does not recognise', () => {
    // `terrainClass` is a Uint8Array, so a value outside `TerrainClass` is
    // representable even though `game`'s fold produces only 0-3. The claim in
    // `drawTerrain`'s comment — an unrecognised class paints nothing rather than
    // falling through to a colour — is asserted here, because a comment that
    // states a behaviour with no test behind it reads exactly like coverage.
    const frame = frameB()
    frame.terrainClass[1 * B_W + 2] = 9 // the water cell
    const paints = content(draw(frame, atlasAt(B_TILE_DEVICE)), frame.camera)
    expect(covering(paints, bx(2) + 33, by(1) + 33)).toEqual([])
  })

  it('indexes terrainClass at y * gridW + x, where gridW is the BOARD width', () => {
    // gridW is 8 and the camera's cols is 6, so a stride taken from the camera
    // reads a different cell. The three terrain cells are at three distinct
    // (x, y) pairs with x != y, so a transposed index moves all three.
    const frame = frameB()
    expect(frame.gridW).toBe(8)
    expect(frame.camera.cols).toBe(6)
    const log = draw(frame, atlasAt(B_TILE_DEVICE))
    expect(fillsStyled(log, WATER)[0]).toEqual(fill(WATER, bx(2), by(1), 66, 66))
    expect(fillsStyled(log, MOUNTAIN)[0]).toEqual(fill(MOUNTAIN, bx(1), by(3), 66, 66))
  })
})

describe('roads: one blit per road cell, from that mask’s own atlas tile', () => {
  it('blits mask 17 from tile (1, 1), source in device px and destination in CSS px', () => {
    const atlas = atlasAt(B_TILE_DEVICE)
    const all = blits(draw(frameB(), atlas))
    expect(all.length).toBe(1)
    expect(all[0]).toEqual({
      op: 'drawImage',
      image: atlas.surface,
      sx: 132,
      sy: 132,
      sw: 132,
      sh: 132,
      dx: 134,
      dy: 258,
      dw: 66,
      dh: 66,
    })
    // The source rect is the atlas's tile size and the destination rect the
    // camera's — at the DPR-2 cap they differ by exactly the ratio, and
    // swapping them is a road drawn at half or double size.
    expect(all[0]?.sw).toBe(atlas.tileDevicePx)
    expect(all[0]?.dw).toBe(B_TILE)
    expect(atlas.tileDevicePx).not.toBe(B_TILE)
  })

  it('never blits mask 0 — it is the blank tile, and 0 means "no road"', () => {
    const frame = frameB()
    frame.roads.fill(0)
    expect(blits(draw(frame, atlasAt(B_TILE_DEVICE)))).toEqual([])
  })

  it('blits a second road cell from a DIFFERENT tile, so the lookup is not a constant', () => {
    const frame = frameB()
    frame.roads[3 * B_W + 5] = 1 // (5, 3), mask 1 = N -> tile (1, 0)
    const atlas = atlasAt(B_TILE_DEVICE)
    const all = blits(draw(frame, atlas))
    expect(all.length).toBe(2)
    expect([all[0]?.sx, all[0]?.sy]).toEqual([132, 132]) // mask 17 -> (1, 1)
    expect([all[1]?.sx, all[1]?.sy]).toEqual([132, 0]) // mask 1  -> (1, 0)
  })
})

describe('culling: only cells inside the revealed rect are drawn', () => {
  it('issues exactly one blit, though a NON-ZERO mask sits outside the rect', () => {
    // "What else could prevent the blit": an empty mask. So the out-of-rect cell
    // (0, 3) carries mask 5 and the in-rect cell (3, 2) mask 17 — both non-zero
    // — and the count is what separates "culled" from "there was nothing there".
    const frame = frameB()
    expect(frame.roads[3 * B_W + 0] as number).toBe(5)
    expect(frame.roads[2 * B_W + 3] as number).toBe(17)
    expect(blits(draw(frame, atlasAt(B_TILE_DEVICE))).length).toBe(1)
  })

  it('fills no terrain outside the rect, though two non-LAND cells sit there', () => {
    const frame = frameB()
    expect(frame.terrainClass[0] as number).toBe(TerrainClass.WATER)
    expect(frame.terrainClass[5 * B_W + 7] as number).toBe(TerrainClass.TREE)
    const log = draw(frame, atlasAt(B_TILE_DEVICE))
    expect(fillsStyled(log, WATER).length).toBe(1) // the in-rect one only
    expect(fillsStyled(log, TREE).length).toBe(1)
  })

  it('draws no house, destination or car whose cell is outside the rect', () => {
    // Four extra LIVE houses, **one past each of the four bounds** — the
    // catalogue's "when a mutation touches symmetric code paths, mutate them
    // separately", applied to the fixture rather than to the mutation. A single
    // corner house outside on both axes gives two of the four comparisons no
    // detector at all: drop `x >= x0` and the corner is still culled by
    // `y >= y0`. Plus one live car past the bottom edge and one live
    // destination at (0, 0), so all three loops are shown to cull and not just
    // the house one.
    const frame = outOfRectFrame()
    const log = draw(frame, atlasAt(B_TILE_DEVICE))
    expect(groupFills(log, 44, 44).length).toBe(2)
    expect(groupFills(log, 198, 132).length).toBe(1)
    expect(groupFills(log, 33, 33).length).toBe(2)
  })

  it('is not vacuous: every out-of-rect entry is LIVE and past exactly one bound', () => {
    // Without this the test above is satisfied by a fixture whose extra houses
    // are dead, or whose counts never reached them.
    const frame = outOfRectFrame()
    const camera = frame.camera
    expect(frame.houseCount).toBe(6)
    expect(frame.houseCount).toBeLessThanOrEqual(frame.houseCell.length)
    const outside = [
      [7, 3], // past x0 + cols
      [0, 3], // before x0
      [3, 0], // before y0
      [3, 5], // past y0 + rows
    ] as const
    for (const [x, y] of outside) {
      const past = [
        x >= camera.x0 + camera.cols,
        x < camera.x0,
        y < camera.y0,
        y >= camera.y0 + camera.rows,
      ].filter(Boolean).length
      expect(past, `(${x}, ${y}) must be outside on exactly one bound`).toBe(1)
      expect(frame.houseCell).toContain(y * B_W + x)
    }
  })
})

describe('destinations: the footprint, the carpark and the waiting pins', () => {
  it('sizes the footprint from the orientation — 3x2 for E/W, 2x3 for N/S', () => {
    // A deliberate second copy of `sim/buildings.ts`'s footprint geometry, for
    // the same reason `ROAD_DIR_DX` is one: `render` may not import `sim`. Its
    // watcher lives in `packages/game/test/renderDirections.test.ts`, where both
    // packages can be seen at once, and it compares this against `sim`'s own
    // exported `isFootprintCell` rather than against a re-typed literal.
    expect([destFootprintW(DEST_ORIENTATION_N), destFootprintH(DEST_ORIENTATION_N)]).toEqual([2, 3])
    expect([destFootprintW(DEST_ORIENTATION_S), destFootprintH(DEST_ORIENTATION_S)]).toEqual([2, 3])
    expect([destFootprintW(1), destFootprintH(1)]).toEqual([3, 2]) // E
    expect([destFootprintW(3), destFootprintH(3)]).toEqual([3, 2]) // W

    // And the drawn rect follows it: fixture B's destination is oriented W.
    const frame = frameB()
    frame.destOrientation[0] = DEST_ORIENTATION_N
    const log = draw(frame, atlasAt(B_TILE_DEVICE))
    expect(painted(log).filter((p) => p.w === 132 && p.h === 198).length).toBe(1)
    expect(painted(log).filter((p) => p.w === 198 && p.h === 132).length).toBe(0)
  })

  it('draws the carpark cell the frame names, not one it computes', () => {
    const frame = frameB()
    frame.destCarpark[0] = 3 * B_W + 5 // move it to (5, 3)
    const log = draw(frame, atlasAt(B_TILE_DEVICE))
    expect(fillsStyled(log, ROAD_EDGE)).toEqual([
      fill(ROAD_EDGE, bx(5) + 16.5, by(3) + 16.5, 33, 33),
    ])
  })

  it('draws no carpark OUTSIDE the revealed rect, even when its building is inside', () => {
    // A hole the mutation battery found: every other fixture puts the carpark
    // next to a building that is itself inside, so dropping the carpark's own
    // bounds check survived the whole suite. A carpark is a separate cell from
    // its footprint — for an E/W destination it is three cells along — so at the
    // rect's edge the building is drawn and its bay is not.
    const frame = frameB()
    frame.destCarpark[0] = 1 * B_W + 7 // (7, 1): on the board, outside the rect
    const log = draw(frame, atlasAt(B_TILE_DEVICE))
    expect(fillsStyled(log, ROAD_EDGE)).toEqual([])
    // Non-vacuity: the building it belongs to IS still drawn.
    expect(groupFills(log, 198, 132).length).toBe(1)
  })

  it('draws no carpark when the frame reports -1', () => {
    // `carparkCell` returns -1 for a destination whose carpark would fall off
    // the grid. Placement never stores one, but the value is representable and
    // -1 would otherwise be drawn as a cell at the far top-left.
    const frame = frameB()
    frame.destCarpark[0] = -1
    expect(fillsStyled(draw(frame, atlasAt(B_TILE_DEVICE)), ROAD_EDGE)).toEqual([])
  })

  it('draws one pin per waiting customer, capped, and none at zero', () => {
    const frame = frameB()
    frame.destPins[0] = 0
    expect(fillsStyled(draw(frame, atlasAt(B_TILE_DEVICE)), UI_TEXT).length).toBe(0)

    frame.destPins[0] = 2
    expect(fillsStyled(draw(frame, atlasAt(B_TILE_DEVICE)), UI_TEXT).length).toBe(2)

    // The cap exists because a destination's pin count is unbounded in the sim
    // while its footprint is 2 cells wide; without it the row runs off the
    // building and across the board.
    frame.destPins[0] = 40
    const capped = fillsStyled(draw(frame, atlasAt(B_TILE_DEVICE)), UI_TEXT)
    expect(capped.length).toBe(MAX_DRAWN_PINS)
    expect(MAX_DRAWN_PINS).toBe(6)
    const last = capped[capped.length - 1]
    expect((last?.x ?? 0) + (last?.w ?? 0)).toBeLessThanOrEqual(bx(4) + 2 * B_TILE)
  })
})

describe('the HUD', () => {
  it('renders week, day, score and tilesLeft centred in hudRects’ three rectangles', () => {
    const camera = cameraB()
    const rects = hudRects(camera, createHudRects())
    const drawn = texts(draw(frameB(), atlasAt(B_TILE_DEVICE)))

    expect(drawn.map((t) => t.text)).toEqual(['W3 D5', '12 TRIPS', '17 TILES'])
    expect(drawn.map((t) => [t.x, t.y])).toEqual([
      [rects.clock.x + rects.clock.w / 2, rects.clock.y + rects.clock.h / 2],
      [rects.score.x + rects.score.w / 2, rects.score.y + rects.score.h / 2],
      [rects.tiles.x + rects.tiles.w / 2, rects.tiles.y + rects.tiles.h / 2],
    ])
    // Hand-written as well, so this is not an assertion against the same
    // expression twice: w = floor((400 - 16 - 16)/3) = 122, stride = 130,
    // y = 608 + 8 + (72 - 16)/2 = 644.
    expect(drawn.map((t) => [t.x, t.y])).toEqual([
      [69, 644],
      [199, 644],
      [329, 644],
    ])
    for (const t of drawn) {
      expect(t.textAlign).toBe('center')
      expect(t.textBaseline).toBe('middle')
      expect(t.font).toBe(HUD_FONT)
      expect(t.fillStyle).toBe(UI_TEXT)
      expect(t.y).toBeGreaterThan(B_HUD_TOP)
      expect(t.y).toBeLessThan(B_CSS_H)
    }
  })

  it('re-formats the text when a value changes, so the per-frame cache cannot go stale', () => {
    // The HUD's four numbers are formatted into strings, and a string built per
    // frame is an allocation in the frame loop. They are therefore memoised on
    // the values that produced them — which is a cache, and a cache that never
    // invalidates draws last week's score forever. That staleness IS observable
    // here; the allocation saving is not, and the report says so rather than
    // claiming a test for it.
    const atlas = atlasAt(B_TILE_DEVICE)
    expect(texts(draw(frameB(), atlas)).map((t) => t.text)).toEqual([
      'W3 D5',
      '12 TRIPS',
      '17 TILES',
    ])

    const later: RenderFrame = { ...frameB(), week: 4, day: 0, score: 13, tilesLeft: 16 }
    expect(texts(draw(later, atlas)).map((t) => t.text)).toEqual(['W4 D0', '13 TRIPS', '16 TILES'])

    // And back again, so the cache is keyed on the values and not on a dirty
    // flag that only ever fires once.
    expect(texts(draw(frameB(), atlas)).map((t) => t.text)).toEqual([
      'W3 D5',
      '12 TRIPS',
      '17 TILES',
    ])
  })

  it('draws a pause indicator in the clock rect only when the frame is paused', () => {
    const atlas = atlasAt(B_TILE_DEVICE)
    const running = fillsStyled(draw(frameB(false), atlas), UI_TEXT)
    const paused = fillsStyled(draw(frameB(true), atlas), UI_TEXT)

    // Three pin fills either way; the paused frame adds exactly two bars.
    expect(running.length).toBe(3)
    expect(paused.length).toBe(5)
    const bars = paused.slice(3)
    expect(bars).toEqual([fill(UI_TEXT, 15, 630, 7, 28), fill(UI_TEXT, 29, 630, 7, 28)])

    // Inside the clock rect, which is what makes it a pause control's own state
    // and not a stripe across the board.
    const clock = hudRects(cameraB(), createHudRects()).clock
    for (const bar of bars) {
      expect(bar.x).toBeGreaterThanOrEqual(clock.x)
      expect(bar.x + bar.w).toBeLessThanOrEqual(clock.x + clock.w)
      expect(bar.y).toBeGreaterThanOrEqual(clock.y)
      expect(bar.y + bar.h).toBeLessThanOrEqual(clock.y + clock.h)
    }
  })
})

describe('the baked-palette hazard Task 4 handed forward', () => {
  it('throws when the atlas was baked with a different palette than the frame is drawn in', () => {
    // The atlas bakes its road colour at build time and a blit cannot re-tint,
    // so `drawFrame(ctx, frame, atlas, palette)` reads as though the palette
    // governed the roads and it does not. Left undetected the failure mode is
    // roads in the previous theme with everything else correct — which reads as
    // a rendering bug rather than a caching one, in a milestone where nobody is
    // looking for either.
    const stale = atlasAt(B_TILE_DEVICE, { ...PALETTE, road: '#ff00ff' })
    expect(() => draw(frameB(), stale, PALETTE)).toThrow(/baked with a different palette/)
    expect(() => draw(frameB(), stale, PALETTE)).toThrow(/rebuild/)
  })

  it('does not throw when the two agree', () => {
    // The negative control: without it, a guard that throws unconditionally
    // passes the assertion above.
    expect(() => draw(frameB(), atlasAt(B_TILE_DEVICE), PALETTE)).not.toThrow()
  })

  it('compares by IDENTITY, so a structurally identical copy is still rejected', () => {
    // Deliberate, and stated so it is not read as an oversight. `PALETTE` is
    // frozen and preallocated; a caller holding a different object either
    // rebuilt the theme (in which case the atlas is genuinely stale) or is
    // allocating a palette per frame (which the same Global Constraint
    // forbids). Both want to be loud.
    const twin: Palette = { ...PALETTE, groups: PALETTE.groups }
    expect(twin).toEqual(PALETTE)
    expect(twin).not.toBe(PALETTE)
    expect(() => draw(frameB(), atlasAt(B_TILE_DEVICE), twin)).toThrow(/baked with a different/)
  })
})

describe('colour lookup', () => {
  it('never hands undefined to fillStyle when a colour index is out of range', () => {
    // `packDestMeta` validates colour against the full 3-bit range [0, 7] while
    // a palette carries at most MAX_GROUP_COUNT = 6 groups, so 6 and 7 are
    // representable in sim state and unmapped here. `groups[6]` is `undefined`,
    // and `fillStyle = undefined` paints black on a real context — a colour no
    // palette contains and no test would ever be looking for.
    const frame = frameB()
    frame.houseColour[0] = 7
    const log = draw(frame, atlasAt(B_TILE_DEVICE))
    const house = painted(log).find((p) => p.w === 44 && p.h === 44)
    const style = house?.command.op === 'fillRect' ? house.command.fillStyle : ''
    expect(style).toMatch(/^#[0-9a-f]{6}$/)
    expect(style).not.toBe('undefined')
  })
})
