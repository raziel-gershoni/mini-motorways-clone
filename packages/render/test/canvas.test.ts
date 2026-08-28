import { describe, it, expect, vi } from 'vitest'
import * as cameraModule from '../src/camera'
import {
  AtlasVariant,
  buildAtlas,
  buildAtlases,
  type Atlas,
  type Atlases,
  type AtlasContext,
  type AtlasSurface,
  type AtlasVariantCode,
} from '../src/atlas'
import {
  CARD_LABELS,
  CARD_LABEL_COUNT,
  CAR_SIZE_FRACTION,
  CHIP_ICON_CSS,
  DEST_ORIENTATION_N,
  DEST_ORIENTATION_S,
  HUD_FONT,
  OFFER_TITLE_TEXT,
  PAUSE_BAR_FRACTION,
  PEEK_RETURN_TEXT,
  PEEK_TEXT,
  MAX_DRAWN_PINS,
  RESTART_TEXT,
  RING_MIN_SWEEP,
  RING_RADIUS_FRACTION,
  RING_WIDTH_FRACTION,
  SHUTDOWN_RING_WIDTH_SCALE,
  SHUTDOWN_TEXT_INSET_CSS,
  UPGRADE_INSET_FRACTION,
  UPGRADE_SIZE_FRACTION,
  destFootprintH,
  destFootprintW,
  drawFrame,
  ringWidth,
  type DrawContext,
  type DrawImageSource,
} from '../src/canvas'
import { createHudRects, createOfferRects, fitCamera, hudRects, offerRects } from '../src/camera'
import { PALETTE } from '../src/palette'
import { TerrainClass } from '../src/types'
import type { Camera, Palette, Rect, RenderFrame } from '../src/types'

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
  /**
   * The recorded fourth argument, and the reason "does the label fit its rect"
   * is answerable here at all. The canvas spec condenses a run to at most
   * `maxWidth`, so with `textAlign = 'center'` the text occupies exactly
   * `[x - maxWidth/2, x + maxWidth/2]` — containment by construction, over a
   * recorded number, with no font engine anywhere near it.
   */
  readonly maxWidth: number
}

interface ClearRectCommand {
  readonly op: 'clearRect'
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * The overcrowd ring (M1e Task 9). **The stroke state is captured on the `arc`
 * rather than on the `stroke`**, so a colour or a width assertion can name the
 * ring it belongs to; `arc` is the only command in this file that carries
 * geometry AND stroke state, which is what makes "the ring is at the right
 * destination, in the right colour, at the right sweep" one record.
 */
interface ArcCommand {
  readonly op: 'arc'
  readonly strokeStyle: string
  readonly lineWidth: number
  readonly x: number
  readonly y: number
  readonly radius: number
  readonly startAngle: number
  readonly endAngle: number
}

interface PathCommand {
  readonly op: 'beginPath' | 'stroke'
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
  | ArcCommand
  | PathCommand

class RecordingContext implements DrawContext {
  readonly log: Command[] = []

  #fillStyle: string | CanvasGradient | CanvasPattern = '#000000'
  #strokeStyle: string | CanvasGradient | CanvasPattern = '#000000'
  #lineWidth = 1
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

  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this.#strokeStyle
  }
  set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
    this.#strokeStyle = value
    this.log.push({ op: 'set', prop: 'strokeStyle', value: String(value) })
  }

  get lineWidth(): number {
    return this.#lineWidth
  }
  set lineWidth(value: number) {
    this.#lineWidth = value
    this.log.push({ op: 'set', prop: 'lineWidth', value: String(value) })
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

  fillText(text: string, x: number, y: number, maxWidth: number): void {
    this.log.push({
      op: 'fillText',
      fillStyle: String(this.#fillStyle),
      font: this.#font,
      textAlign: this.#textAlign,
      textBaseline: this.#textBaseline,
      text,
      x,
      y,
      maxWidth,
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

  beginPath(): void {
    this.log.push({ op: 'beginPath' })
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.log.push({
      op: 'arc',
      strokeStyle: String(this.#strokeStyle),
      lineWidth: this.#lineWidth,
      x,
      y,
      radius,
      startAngle,
      endAngle,
    })
  }

  stroke(): void {
    this.log.push({ op: 'stroke' })
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
  globalAlpha: 1,
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

/**
 * Both layers, through the real builders. A PAIR everywhere, because `drawFrame`
 * takes a pair and a test that assembled one by hand would be free to assemble a
 * mismatched one and never notice.
 */
function atlasesAt(tileDevicePx: number, palette: Palette = PALETTE): Atlases {
  return buildAtlases((w, h) => new SilentSurface(w, h), tileDevicePx, palette)
}

/** One layer on its own, for the `assertAtlases` cases that need a mismatched pair. */
function oneAtlasAt(
  tileDevicePx: number,
  palette: Palette = PALETTE,
  variant: AtlasVariantCode = AtlasVariant.ROAD,
): Atlas {
  return buildAtlas((w, h) => new SilentSurface(w, h), tileDevicePx, palette, variant)
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
    ghosts: new Uint8Array(cells),
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
    destOvercrowd: new Uint8Array(0),
    destReachable: new Uint8Array(0),
    carCount: 1,
    carXY,
    carColour: new Uint8Array([3]),
    week: 1,
    day: 0,
    score: 0,
    tilesLeft: 40,
    paused,
    // **Explicit, never absent.** A trial scrim phase gated on `frame.gameOver`
    // left the whole render suite green because these two fixtures never set
    // the flag and `undefined` is falsy — the phase simply never ran. See the
    // shutdown describe at the bottom of this file.
    gameOver: false,
    failedDest: -1,
    // **The three offer fields, explicit and false/zero for the same reason
    // `gameOver` above is** — M1f Task 7 put them on the frame and M1f Task 8
    // draws the modal off them. A fixture that left them absent would make
    // every "the modal is not drawn" assertion pass on `undefined` rather than
    // on a decision.
    offerPending: false,
    offerA: 0,
    offerB: 0,
    // The five M1f Task 8 fields, explicit for the same reason. `offerPeek` in
    // particular gates a phase inside a phase: a fixture that left it absent
    // would make the peek arm unreachable while every assertion still passed.
    offerGrantA: 0,
    offerGrantB: 0,
    offerItemsA: 0,
    offerItemsB: 0,
    offerPeek: false,
    // The four M1f Task 10 fields, explicit for the same reason again — and
    // `upgradeCount` in particular gates a whole PHASE, so a fixture that left
    // it absent would make the marker pass unreachable while every "no marker is
    // drawn" assertion still passed on `undefined`. That is the exact failure
    // the `gameOver` note above records.
    upgradeAt: new Uint8Array(cells),
    upgradeCount: 0,
    invUpgrades: 0,
    upgradeMode: false,
  }
}

/**
 * An otherwise-empty frame on an arbitrary camera — for the tests that are about
 * the three band fills and nothing else, where board content would only add
 * noise to the classifier.
 */
function frameOn(camera: Camera, boardW: number, boardH: number): RenderFrame {
  const cells = boardW * boardH
  return {
    ...frameA(),
    camera,
    gridW: boardW,
    roads: new Uint8Array(cells),
    ghosts: new Uint8Array(cells),
    terrainClass: new Uint8Array(cells),
    carCount: 0,
    carXY: new Float32Array(2),
    carColour: new Uint8Array(1),
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
 *   2    .       TREE       .       road17   DEST    DEST    DEST     .
 *   3   road*    road1     ghost64   .      ghost8   .      MOUNTAIN  .
 *   4    .       house      WATER   road+car  .      car     house    .
 *   5    .        .         .       .        .       .       .      TREE*
 * ```
 *
 * **The two ghost cells are a real erase, not a sprinkling of bytes** (M1d Task
 * 8). `ghost64` at (2, 3) is mask 64 = W, which is exactly what
 * `eraseRoad((1,3), (2,3))` leaves behind: (1, 3) loses its E bit and keeps N so
 * it refunds nothing and stays a live road, while (2, 3) loses its only bit and
 * its refund is deferred. That pair is also the "a live road ADJACENT to a ghost
 * is unaffected" case, on the two cells that shared the erased segment — the
 * tightest form of it. `ghost8` at (4, 3) is a single DIAGONAL bit (SE), so
 * "the ghost is derived from `ghostMask`" has a case where the mask's geometry
 * is visible. Neither cell carries a live road, and in `sim` neither could:
 * `roads[c]` and `ghosts[c]` are never both non-zero.
 *
 * `*` is outside the revealed rect `x in [1, 7), y in [1, 5)`. The two starred
 * road cells and both starred terrain cells carry NON-ZERO values, because "an
 * empty mask" is the other thing that could prevent a blit and the fixture must
 * not let it be what makes the culling assertion pass.
 *
 * **Both board loops have drawable content on all four of their bounds, and that
 * is review finding I1 rather than decoration.** The original layout clustered
 * every terrain cell and every road in the rect's top-left corner, so `xEnd` and
 * `yEnd` could each be *shrunk* with the whole suite green: every bounds
 * assertion in the file asked "is anything drawn OUTSIDE the rect" and none
 * asked "is everything INSIDE it drawn". On the real camera that mutant drops
 * board rows 23-30 and wraps columns 24-26 into the following row. So:
 *
 * | bound | terrain detector | road detector |
 * |---|---|---|
 * | `x = x0` (1)          | TREE (1, 2)      | mask 1 at (1, 3)  |
 * | `y = y0` (1)          | WATER (2, 1)     | mask 16 at (3, 1) |
 * | `x = x0 + cols - 1` (6) | MOUNTAIN (6, 3) | mask 2 at (6, 4)  |
 * | `y = y0 + rows - 1` (4) | WATER (2, 4)    | mask 4 at (3, 4)  |
 *
 * Two of those road cells are deliberately on cells a road is legal on and that
 * something else also occupies — the carpark at (3, 1) is the driveway case, and
 * (6, 4) is a house cell, which is the whole reason houses draw above roads.
 *
 * The dead house / destination / car slots all sit at cell `(1, 1)` — **inside**
 * the rect and non-zero — because the sim's real dead value is cell 0, which is
 * outside every M2 camera, so a fixture parking dead slots there is proved
 * correct by the bounds check and never exercises the liveness prefix at all.
 */
function frameB(paused = false): RenderFrame {
  const roads = new Uint8Array(B_CELLS)
  roads[1 * B_W + 3] = 16 // (3, 1), S    — the rect's first ROW, on the carpark
  roads[2 * B_W + 3] = 17 // (3, 2), N|S
  roads[3 * B_W + 1] = 1 //  (1, 3), N    — the rect's first COLUMN
  roads[4 * B_W + 3] = 4 //  (3, 4), E    — the rect's last ROW, under a car
  roads[4 * B_W + 6] = 2 //  (6, 4), NE   — the rect's last COLUMN, on a house
  // The one-cell RING outside the rect, one per bound. Four cells outside on a
  // diagonal (the first version's (0, 0) and (7, 5)) are unreachable by any
  // single one-cell over-extension, so all four of those mutants survived; a
  // cell must sit directly past each bound to have a detector.
  roads[3 * B_W + 0] = 5 //  (0, 3), N|E  — one column BEFORE x0
  roads[3 * B_W + 7] = 3 //  (7, 3), N|NE — one column PAST x0 + cols
  roads[0 * B_W + 3] = 6 //  (3, 0), NE|E — one row BEFORE y0
  roads[5 * B_W + 3] = 9 //  (3, 5), N|SE — one row PAST y0 + rows

  // The ghost layer. See the table above: (2, 3) is the far end of the segment
  // erased off (1, 3), and (4, 3) is a lone diagonal. Bounds coverage for this
  // layer lives in `ghostBoundsFrame`, not here.
  const ghosts = new Uint8Array(B_CELLS)
  ghosts[3 * B_W + 2] = 64 // (2, 3), W  — points back at the live road on (1, 3)
  ghosts[3 * B_W + 4] = 8 //  (4, 3), SE — a diagonal, so the mask's geometry shows

  const terrainClass = new Uint8Array(B_CELLS)
  terrainClass[1 * B_W + 2] = TerrainClass.WATER // (2, 1) — the rect's first row
  terrainClass[2 * B_W + 1] = TerrainClass.TREE // (1, 2) — its first column
  terrainClass[3 * B_W + 6] = TerrainClass.MOUNTAIN // (6, 3) — its last column
  terrainClass[4 * B_W + 2] = TerrainClass.WATER // (2, 4) — its last row
  // The same one-cell ring for terrain, one cell directly past each bound.
  terrainClass[2 * B_W + 0] = TerrainClass.WATER // (0, 2) — one column BEFORE x0
  terrainClass[2 * B_W + 7] = TerrainClass.WATER // (7, 2) — one column PAST x0 + cols
  terrainClass[0 * B_W + 2] = TerrainClass.TREE // (2, 0) — one row BEFORE y0
  terrainClass[5 * B_W + 2] = TerrainClass.TREE // (2, 5) — one row PAST y0 + rows

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
  // Both meters at zero, so the whole-log literal below stays a LIVE frame with
  // no ring in it. `frameWithOvercrowd` is what gives this fixture a ring.
  const destOvercrowd = new Uint8Array([0, 0])
  // The reachability fold (M1f), one byte per slot. Slot 0 is REACHABLE and
  // slot 1 is not, which is the pair the bay-colour cases split on — and it is
  // set independently of `roads` on purpose: `render` no longer derives this,
  // `game` folds it, and a fixture that recomputed it from the road bits would
  // be a second implementation of the thing the boundary exists to move.
  const destReachable = new Uint8Array([1, 0])

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
    ghosts,
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
    destOvercrowd,
    destReachable,
    carCount: 2,
    carXY,
    carColour,
    week: 3,
    day: 5,
    score: 12,
    tilesLeft: 17,
    paused,
    gameOver: false,
    failedDest: -1,
    // **The three offer fields, explicit and false/zero for the same reason
    // `gameOver` above is** — M1f Task 7 put them on the frame and M1f Task 8
    // draws the modal off them. A fixture that left them absent would make
    // every "the modal is not drawn" assertion pass on `undefined` rather than
    // on a decision.
    offerPending: false,
    offerA: 0,
    offerB: 0,
    // The five M1f Task 8 fields, explicit for the same reason. `offerPeek` in
    // particular gates a phase inside a phase: a fixture that left it absent
    // would make the peek arm unreachable while every assertion still passed.
    offerGrantA: 0,
    offerGrantB: 0,
    offerItemsA: 0,
    offerItemsB: 0,
    offerPeek: false,
    // See `frameA`. `upgradeAt` is all-zero here on purpose: the whole-log
    // literal below is written against a board with no upgrade on it, and the
    // marker cases build their own flags.
    upgradeAt: new Uint8Array(B_CELLS),
    upgradeCount: 0,
    invUpgrades: 0,
    upgradeMode: false,
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

/**
 * Fixture B's camera and an otherwise **empty** board carrying nothing but
 * ghosts: one on each of the four bounds of the revealed rect, and one cell past
 * each of the four bounds.
 *
 * **Both directions of every bound, which is the finding that cost M2 seven
 * 0-detector mutants and then seven more.** The first half — content ON each far
 * bound — is what makes shrinking `xEnd` or `yEnd` fail; a fixture whose content
 * sits in the rect's top-left corner passes a shrunk loop with everything green.
 * The second half — a marker one cell PAST each bound — is what makes extending
 * one fail, and each marker is past **exactly one** bound: a marker in a diagonal
 * corner is past two at once, so no single one-cell over-extension reaches it and
 * the mutant survives. The companion `it()` below asserts both of those
 * properties of the fixture rather than trusting this comment.
 *
 * The rest of the board is emptied so that "the ghost layer" is the only thing
 * these tests can be reading. Fixture B's own two ghosts stay where they are;
 * they are about geometry and adjacency, not about bounds.
 *
 * ```
 *  y\x   0        1        2        3        4        5        6        7
 *   0    .        .        .        .      G past y0  .        .        .
 *   1    .        .      G on y0    .        .        .        .      G past x1
 *   2    .      G on x0    .        .        .        .        .        .
 *   3  G past x0  .        .        .        .        .      G on x1    .
 *   4    .        .        .      G on y1    .        .        .        .
 *   5    .        .      G past y1  .        .        .        .        .
 * ```
 */
function ghostBoundsFrame(): RenderFrame {
  const ghosts = new Uint8Array(B_CELLS)
  // Inside, one on each of the four bounds. Four DISTINCT masks, so a lookup
  // that ignored the mask and blitted a constant tile is visible here too.
  ghosts[2 * B_W + 1] = 1 //   (1, 2) — x = x0,            mask 1  N
  ghosts[1 * B_W + 2] = 4 //   (2, 1) — y = y0,            mask 4  E
  ghosts[3 * B_W + 6] = 16 //  (6, 3) — x = x0 + cols - 1, mask 16 S
  ghosts[4 * B_W + 3] = 64 //  (3, 4) — y = y0 + rows - 1, mask 64 W
  // Outside, one cell past exactly one bound each.
  ghosts[3 * B_W + 0] = 2 //   (0, 3) — one column BEFORE x0
  ghosts[1 * B_W + 7] = 8 //   (7, 1) — one column PAST x0 + cols
  ghosts[0 * B_W + 4] = 32 //  (4, 0) — one row BEFORE y0
  ghosts[5 * B_W + 2] = 128 // (2, 5) — one row PAST y0 + rows

  return {
    ...frameB(),
    roads: new Uint8Array(B_CELLS),
    terrainClass: new Uint8Array(B_CELLS),
    ghosts,
    houseCount: 0,
    destCount: 0,
    carCount: 0,
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

function draw(frame: RenderFrame, atlases: Atlases, palette: Palette = PALETTE): Command[] {
  const ctx = new RecordingContext()
  drawFrame(ctx, frame, atlases, palette)
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
 * How many opaque fills partition the canvas. **Five since Task 9**, and the
 * count is derived rather than chosen: the complement of an interior rectangle
 * inside a rectangle needs four rectangles, so painting the playfield as its own
 * rect is 1 + 4. Two of the four (the vertical gap below the grid rect and the
 * HUD band) are merged into one fill because both are `palette.background`.
 */
const FILL_COUNT = 5

/**
 * The opaque matte fills that partition the canvas, in issue order.
 *
 * **Classified by fill STYLE, not by geometry, and that is a change Task 9
 * forced.** The three-band form could be classified by `x === 0 && w === cssW`;
 * the two letterbox columns are 2 CSS px wide on fixture B and 0 on the M0
 * device, so no width test separates them from content.
 *
 * `background` and `land` are the only two palette entries the matte uses and
 * the only two no content path can ever produce: `drawTerrain` *skips* every
 * LAND cell precisely because the playfield fill has already covered it, water /
 * mountain / tree / roadEdge / uiText / groups are the rest of the palette, and
 * `groupColour`'s out-of-range fallback is `uiText`. So the partition is exact
 * in both directions, and every caller asserts the count is `FILL_COUNT`, which
 * is what keeps the filter non-vacuous.
 */
function isMatte(p: Painted): boolean {
  return (
    p.command.op === 'fillRect' &&
    (p.command.fillStyle === PALETTE.background || p.command.fillStyle === PALETTE.land)
  )
}

function bands(log: readonly Command[]): Painted[] {
  return painted(log).filter(isMatte)
}

/** Everything painted that is NOT one of the matte fills. */
function content(log: readonly Command[]): Painted[] {
  const all = painted(log)
  const rest = all.filter((p) => !isMatte(p))
  expect(all.length - rest.length, `exactly ${FILL_COUNT} matte fills`).toBe(FILL_COUNT)
  return rest
}

/** A rectangle in whole DEVICE pixels, half-open on the right and bottom. */
interface DeviceRect {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/**
 * A matte fill's rect in device px, **asserting on the way that every edge is
 * already whole there**.
 *
 * That assertion is the Task 5 ghosting fix, generalised to four edges instead
 * of two: `fitCamera` works in integer CSS px and `DPR_CAP_LOW` is 1.5, so an
 * odd CSS edge lands on a half device pixel and the device row underneath gets
 * two source-over passes at alpha 0.5 instead of one opaque pass — it keeps 25%
 * of the previous frame. CSS-space tiling cannot see it.
 */
function deviceRect(p: Painted, dpr: number): DeviceRect {
  const edges = [p.x, p.y, p.x + p.w, p.y + p.h]
  for (const edge of edges) {
    const device = edge * dpr
    expect(
      Math.abs(device - Math.round(device)),
      `CSS ${edge} is device ${device}, a half pixel`,
    ).toBeLessThan(1e-9)
  }
  return {
    x0: Math.round(p.x * dpr),
    y0: Math.round(p.y * dpr),
    x1: Math.round((p.x + p.w) * dpr),
    y1: Math.round((p.y + p.h) * dpr),
  }
}

function deviceArea(r: DeviceRect): number {
  return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0)
}

function overlapArea(a: DeviceRect, b: DeviceRect): number {
  return (
    Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
    Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
  )
}

/**
 * The whole tiling proof, in **device** space, for any arrangement of fills.
 *
 * Three properties together are what "covered exactly once" means, and no two of
 * them imply the third: every fill is on-canvas, no two overlap, and the areas
 * sum to the backing store. The old cursor walk could only express a vertical
 * strip and would have accepted a run of negative-height fills; this cannot.
 *
 * Returns the total device area, which is Decision 4's own budget figure.
 */
function assertExactTiling(strip: readonly Painted[], camera: Camera): number {
  const dpr = camera.dpr
  const width = Math.round(camera.cssW * dpr)
  const height = Math.round(camera.cssH * dpr)
  expect(strip.length, `${FILL_COUNT} matte fills`).toBe(FILL_COUNT)

  const rects = strip.map((p) => deviceRect(p, dpr))
  let area = 0
  for (const r of rects) {
    expect(r.x0, 'a fill starts left of the canvas').toBeGreaterThanOrEqual(0)
    expect(r.y0, 'a fill starts above the canvas').toBeGreaterThanOrEqual(0)
    expect(r.x1, 'a fill runs past the canvas width').toBeLessThanOrEqual(width)
    expect(r.y1, 'a fill runs past the canvas height').toBeLessThanOrEqual(height)
    expect(r.x1 - r.x0, 'a negative-width fill').toBeGreaterThanOrEqual(0)
    expect(r.y1 - r.y0, 'a negative-height fill').toBeGreaterThanOrEqual(0)
    area += deviceArea(r)
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(
        overlapArea(rects[i] as DeviceRect, rects[j] as DeviceRect),
        `fills ${i} and ${j} overlap`,
      ).toBe(0)
    }
  }
  // With every fill on-canvas and no two overlapping, an area equal to the
  // backing store is exactly "no gap".
  expect(area, 'a gap: the fills do not cover the whole backing store').toBe(width * height)
  return area
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

/**
 * The blits that came from one layer's surface.
 *
 * **Source identity, not geometry**, and that is what makes every ghost
 * assertion in this file able to fail for the right reason: the two atlases have
 * the same size, the same grid and the same tile rects, so a ghost blit and a
 * road blit of the same mask on the same cell are identical in every recorded
 * number. The surface object is the only thing that separates them, which is
 * also exactly what a mutation drawing ghosts from the ROAD atlas would change.
 */
function layerBlits(log: readonly Command[], atlas: Atlas): DrawImageCommand[] {
  return blits(log).filter((c) => c.image === atlas.surface)
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
function blit(atlas: Atlas, sx: number, sy: number, dx: number, dy: number): DrawImageCommand {
  const source = atlas.tileDevicePx
  return { op: 'drawImage', image: atlas.surface, sx, sy, sw: source, sh: source, dx, dy, dw: B_TILE, dh: B_TILE }
}
function text(value: string, x: number, y: number, maxWidth: number): FillTextCommand {
  return {
    op: 'fillText',
    fillStyle: UI_TEXT,
    font: HUD_FONT,
    textAlign: 'center',
    textBaseline: 'middle',
    text: value,
    x,
    y,
    maxWidth,
  }
}

const BACKGROUND = PALETTE.background
const LAND = PALETTE.land
const WATER = PALETTE.water
const MOUNTAIN = PALETTE.mountain
const TREE = PALETTE.tree
const ROAD_EDGE = PALETTE.roadEdge
/**
 * The carpark bay's OTHER colour — the one it takes when no road reaches it —
 * and the ring's stroke. `fillsStyled` filters `fillRect` only, so a ring on the
 * same frame cannot be mistaken for a bay by anything in this file.
 */
const OVERCROWD = PALETTE.overcrowd
const UI_TEXT = PALETTE.uiText
/** §5.6's junction-upgrade marker on the board — M1f Task 10. */
const UPGRADE = PALETTE.upgrade
/** The inventory chip's icon when the player holds none. See `chipEmpty`. */
const CHIP_EMPTY = PALETTE.chipEmpty
const GROUP = PALETTE.groups

// ---------------------------------------------------------------------------

describe('drawFrame: the entire recorded frame, hand-written', () => {
  it('records exactly this command sequence, in this order, with these coordinates', () => {
    // The strongest single assertion in this file: every command, every
    // coordinate and every colour of a complete frame, hand-computed from
    // fixture B's camera. It pins the draw order the plan calls load-bearing
    // (top band -> land -> terrain -> ghosts -> roads -> UPGRADES -> destinations
    // -> houses -> cars -> HUD band -> HUD content) together with the geometry of every
    // element, so a reordering and a mis-transform are the same failure to write
    // down.
    const atlases = atlasesAt(B_TILE_DEVICE)
    const log = draw(frameB(), atlases)

    expect(log).toEqual([
      // 1. the background matte, in three pieces: the top band down to the grid
      //    rect, then a letterbox column on each side of it. `originX` is 2 on
      //    this fixture, so both columns have real width and a dropped one is
      //    visible here rather than only on a 390 px phone.
      set('fillStyle', BACKGROUND),
      fill(BACKGROUND, 0, 0, 400, 192),
      fill(BACKGROUND, 0, 192, 2, 264),
      fill(BACKGROUND, 398, 192, 2, 264),
      // 2. the playfield: EXACTLY the grid rect (2, 192)-(398, 456), and the
      //    only land on the canvas. 6 cols x 66 = 396 wide, 4 rows x 66 = 264 high.
      set('fillStyle', LAND),
      fill(LAND, 2, 192, 396, 264),
      // 3. non-land terrain, row-major over the revealed rect only, and with a
      //    cell on each of the four bounds (review I1)
      set('fillStyle', WATER),
      fill(WATER, 68, 192, 66, 66), // (2, 1) — a whole cell, the first row
      set('fillStyle', TREE),
      fill(TREE, 18.5, 274.5, 33, 33), // (1, 2) — inset, land shows around it
      set('fillStyle', MOUNTAIN),
      fill(MOUNTAIN, 332, 324, 66, 66), // (6, 3) — the last column
      set('fillStyle', WATER),
      fill(WATER, 68, 390, 66, 66), // (2, 4) — the last row
      // 4. ghosts, row-major, from the GHOST atlas's surface — the same tile
      //    arithmetic and the same rect, a different surface. Both are on row 3,
      //    so `x` ascending is the only thing ordering them.
      blit(atlases.ghost, 0, 528, 68, 324), //    (2, 3) mask 64 -> tile (0, 4)
      blit(atlases.ghost, 1056, 0, 200, 324), //  (4, 3) mask 8  -> tile (8, 0)
      // 5. roads, row-major, one blit each from that mask's own atlas tile.
      //    AFTER the ghosts: the two layers are disjoint per cell, so this order
      //    paints nothing twice — it is fixed so the live layer wins if that
      //    ever stops being true.
      blit(atlases.road, 0, 132, 134, 192), //   (3, 1) mask 16 -> tile (0, 1)
      blit(atlases.road, 132, 132, 134, 258), // (3, 2) mask 17 -> tile (1, 1)
      blit(atlases.road, 132, 0, 2, 324), //     (1, 3) mask 1  -> tile (1, 0)
      blit(atlases.road, 528, 0, 134, 390), //   (3, 4) mask 4  -> tile (4, 0)
      blit(atlases.road, 264, 0, 332, 390), //   (6, 4) mask 2  -> tile (2, 0)
      // 6. junction upgrades — M1f Task 10 — and this fixture places NONE, so
      //    the pass issues nothing at all: not a `fillStyle` write, not a
      //    `fillRect`, not an iteration. `frame.upgradeCount` is 0 and the phase
      //    early-returns on it. Its absence from this literal is the assertion.
      // 7. the destination: a 3x2 footprint, its carpark, then its waiting pins
      set('fillStyle', GROUP[4] as string),
      fill(GROUP[4] as string, 200, 192, 198, 132),
      set('fillStyle', ROAD_EDGE),
      fill(ROAD_EDGE, 150.5, 208.5, 33, 33),
      set('fillStyle', UI_TEXT),
      fill(UI_TEXT, 211, 203, 11, 11),
      fill(UI_TEXT, 233, 203, 11, 11),
      fill(UI_TEXT, 255, 203, 11, 11),
      // 8. houses, above roads because a road is legal on a house cell
      set('fillStyle', GROUP[2] as string),
      fill(GROUP[2] as string, 13, 401, 44, 44),
      set('fillStyle', GROUP[5] as string),
      fill(GROUP[5] as string, 343, 401, 44, 44),
      // 9. cars, above buildings because a car drives onto the carpark
      set('fillStyle', GROUP[1] as string),
      fill(GROUP[1] as string, 150.5, 406.5, 33, 33),
      set('fillStyle', GROUP[3] as string),
      fill(GROUP[3] as string, 315.5, 340.5, 33, 33),
      // 10. the bottom band: from the grid rect's bottom edge (456) down to the
      //    canvas bottom — the vertical gap, the HUD band and the safe-area
      //    inset in one fill, and issued after the cars so nothing spilling out
      //    of the playfield survives into the HUD.
      set('fillStyle', BACKGROUND),
      fill(BACKGROUND, 0, 456, 400, 244),
      // 11. HUD content, and §7.2's inventory chip FIRST — M1f Task 10. The
      //     chip is one `fillRect` in all three of its states and only the
      //     colour moves; this fixture holds none, so it is `chipEmpty` and its
      //     badge is suppressed, which is why the text run below has three
      //     entries for four columns.
      //     Column x = 8 + 3 * (90 + 8) = 302; icon x = 302 + 12 = 314;
      //     y = 616 + (56 - 20)/2 = 634.
      set('fillStyle', CHIP_EMPTY),
      fill(CHIP_EMPTY, 314, 634, 20, 20),
      set('font', HUD_FONT),
      set('textAlign', 'center'),
      set('textBaseline', 'middle'),
      set('fillStyle', UI_TEXT),
      // Every label carries `maxWidth = rect.w`, which is what makes "it fits"
      // a construction guarantee rather than a device-dependent hope.
      // **The three x's and the maxWidth moved at M1f Task 10**, when the band
      // went from three equal columns to four: 69/199/329 at 122 -> 53/151/249
      // at 90. Re-derived in `camera.test.ts`, not nudged.
      text('W3 D5', 53, 644, 90),
      text('12 TRIPS', 151, 644, 90),
      text('17 TILES', 249, 644, 90),
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

describe('the OTHER direction: is everything inside the rect drawn? (review I1)', () => {
  /**
   * Every bounds assertion in the first version of this file asked one
   * question — *does the renderer draw cells it should not?* — and the liveness
   * work asked the same question again, because suppressing draws is what it is
   * about. Nobody asked whether the renderer draws **enough**, so `drawTerrain`'s
   * `xEnd` and `yEnd` and `drawRoads`' `yEnd` could each be shrunk with all 178
   * tests green. On the real camera that drops board rows 23-30 and wraps
   * columns 24-26 into the next row.
   *
   * The fix is a fixture with drawable content on each of the four bounds
   * (see `frameB`) and **exact counts** here — a count is the assertion that
   * looks in both directions at once.
   */

  it('draws every non-LAND cell in the rect, including one on each of its four bounds', () => {
    const log = draw(frameB(), atlasesAt(B_TILE_DEVICE))
    // Four in the rect, two more outside it that must NOT appear.
    expect(fillsStyled(log, WATER)).toEqual([
      fill(WATER, bx(2), by(1), 66, 66), // y = y0, the first row
      fill(WATER, bx(2), by(4), 66, 66), // y = y0 + rows - 1, the last row
    ])
    expect(fillsStyled(log, TREE)).toEqual([fill(TREE, bx(1) + 16.5, by(2) + 16.5, 33, 33)]) // x = x0
    expect(fillsStyled(log, MOUNTAIN)).toEqual([fill(MOUNTAIN, bx(6), by(3), 66, 66)]) // x = x0 + cols - 1
  })

  it('blits every road cell in the rect, including one on each of its four bounds', () => {
    const atlases = atlasesAt(B_TILE_DEVICE)
    // Filtered to the ROAD surface: the ghost layer blits from the same rects
    // with the same arithmetic, so an unfiltered count would conflate the two
    // and this test would stop being about roads at all.
    const all = layerBlits(draw(frameB(), atlases), atlases.road)
    expect(all.length).toBe(5)
    expect(all.map((b) => [b.dx, b.dy])).toEqual([
      [bx(3), by(1)], // y = y0
      [bx(3), by(2)],
      [bx(1), by(3)], // x = x0
      [bx(3), by(4)], // y = y0 + rows - 1
      [bx(6), by(4)], // x = x0 + cols - 1
    ])
  })

  it('is not vacuous: the fixture really does put content on all four bounds of both loops', () => {
    // Without this the two tests above are satisfied by a fixture whose content
    // is anywhere at all — which is exactly the fixture that shipped.
    const frame = frameB()
    const c = frame.camera
    const xs = { first: c.x0, last: c.x0 + c.cols - 1 }
    const ys = { first: c.y0, last: c.y0 + c.rows - 1 }
    expect([xs.first, xs.last, ys.first, ys.last]).toEqual([1, 6, 1, 4])

    const terrainAt = (x: number, y: number): number => frame.terrainClass[y * frame.gridW + x] as number
    const roadAt = (x: number, y: number): number => frame.roads[y * frame.gridW + x] as number
    expect(terrainAt(1, 2), 'no terrain on the first column').not.toBe(TerrainClass.LAND)
    expect(terrainAt(6, 3), 'no terrain on the last column').not.toBe(TerrainClass.LAND)
    expect(terrainAt(2, 1), 'no terrain on the first row').not.toBe(TerrainClass.LAND)
    expect(terrainAt(2, 4), 'no terrain on the last row').not.toBe(TerrainClass.LAND)
    expect(roadAt(1, 3), 'no road on the first column').toBeGreaterThan(0)
    expect(roadAt(6, 4), 'no road on the last column').toBeGreaterThan(0)
    expect(roadAt(3, 1), 'no road on the first row').toBeGreaterThan(0)
    expect(roadAt(3, 4), 'no road on the last row').toBeGreaterThan(0)
  })
})

describe('the draw order the plan calls load-bearing', () => {
  it('draws bands, terrain, roads, destinations, houses, cars, HUD band and HUD content in that order', () => {
    // Each index is located by a hand-written rect, so this reads the recording
    // and never the implementation. Stated as a chain of strict inequalities
    // because that is exactly what "buildings above roads, cars above
    // buildings" means for a painter's-algorithm renderer.
    const atlas = atlasesAt(B_TILE_DEVICE)
    const log = draw(frameB(), atlas)

    const topBand = indexOfRect(log, 0, 0, 400, 192)
    const leftBox = indexOfRect(log, 0, 192, 2, 264)
    const rightBox = indexOfRect(log, 398, 192, 2, 264)
    const landBand = indexOfRect(log, 2, 192, 396, 264)
    const terrain = indexOfRect(log, 68, 192, 66, 66) // the water cell
    const road = indexOfRect(log, 134, 258, 66, 66) // the blit
    const dest = indexOfRect(log, 200, 192, 198, 132) // the footprint
    const carpark = indexOfRect(log, 150.5, 208.5, 33, 33)
    const house = indexOfRect(log, 13, 401, 44, 44)
    const car = indexOfRect(log, 150.5, 406.5, 33, 33)
    const hudBand = indexOfRect(log, 0, 456, 400, 244)
    const hudText = log.findIndex((c) => c.op === 'fillText')

    expect(topBand).toBeLessThan(leftBox)
    expect(leftBox).toBeLessThan(rightBox)
    expect(rightBox).toBeLessThan(landBand)
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

describe('no clearRect, and five opaque fills that tile the canvas exactly', () => {
  it('issues no clearRect anywhere', () => {
    // Plan Decision 4: a clearRect plus a land fill covers the canvas twice. At
    // M2's regime on the M0 device that is a wasted full-canvas pass —
    // 1,412,880 device px, ~0.141 ms, more than the entire road layer costs.
    // The mutation is FREE to write and looks like defensive hygiene, which is
    // exactly why it needs an assertion rather than a comment.
    const log = draw(frameB(), atlasesAt(B_TILE_DEVICE))
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

  it('tiles the canvas with exactly five fills: no gap, no overlap, asserted against the camera', () => {
    const camera = cameraB()
    const strip = bands(draw(frameB(), atlasesAt(B_TILE_DEVICE)))

    assertExactTiling(strip, camera)

    // Every cut line is the camera's own, not a free parameter: the grid rect's
    // four edges. `originX = 2` and `originY = 192` differ, and neither equals
    // the far edge, so a swapped axis and a dropped origin both move a literal.
    const gridRight = camera.originX + camera.cols * camera.tileSize
    const gridBottom = camera.originY + camera.rows * camera.tileSize
    expect(strip.map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [0, 0, camera.cssW, camera.originY],
      [0, camera.originY, camera.originX, gridBottom - camera.originY],
      [gridRight, camera.originY, camera.cssW - gridRight, gridBottom - camera.originY],
      [camera.originX, camera.originY, gridRight - camera.originX, gridBottom - camera.originY],
      [0, gridBottom, camera.cssW, camera.cssH - gridBottom],
    ])
    // Hand-written, so the camera fields above cannot all drift together.
    expect(strip.map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [0, 0, 400, 192],
      [0, 192, 2, 264],
      [398, 192, 2, 264],
      [2, 192, 396, 264],
      [0, 456, 400, 244],
    ])
  })

  it('paints the playfield in LAND and everything outside it in BACKGROUND — the affordance itself', () => {
    // Task 9's defect: the middle fill used to span the full canvas width, so
    // land ran to the screen edge and nothing on screen told a player that a tap
    // beside or below the board does nothing. `palette.background`'s own doc has
    // always said it is "the letterbox outside the grid rect"; until this fill
    // structure existed, no pixel was ever painted in it outside the two bands.
    const camera = cameraB()
    const strip = bands(draw(frameB(), atlasesAt(B_TILE_DEVICE)))
    const styles = strip.map((b) => (b.command.op === 'fillRect' ? b.command.fillStyle : ''))
    expect(styles).toEqual([BACKGROUND, BACKGROUND, BACKGROUND, LAND, BACKGROUND])

    // Exactly one fill is land, and its rect IS the grid rect.
    const land = strip.filter((_, i) => styles[i] === LAND)
    expect(land.length).toBe(1)
    expect([land[0]?.x, land[0]?.y, land[0]?.w, land[0]?.h]).toEqual([
      camera.originX,
      camera.originY,
      camera.cols * camera.tileSize,
      camera.rows * camera.tileSize,
    ])

    // "Opaque" is the property the whole no-clearRect design rests on: a
    // translucent fill would composite the previous frame instead of replacing
    // it. Every palette entry is a preallocated #rrggbb literal with no alpha.
    for (const style of styles) expect(style).toMatch(/^#[0-9a-f]{6}$/)
    // And the two colours differ, or "its own colour" is not a distinction at all.
    expect(BACKGROUND).not.toBe(LAND)
  })

  it('leaves NOTHING land-coloured in the letterbox or below the grid rect', () => {
    // The other direction of the bullet above, and the one a reader would
    // otherwise have to take on trust: no matte fill paints land at a CSS point
    // that is not a board cell. Four probes, one past each edge of the grid
    // rect and each exactly one CSS px outside it, so a fill one pixel too big
    // is caught and a fill one pixel too small is caught by the tiling proof.
    const camera = cameraB()
    const strip = bands(draw(frameB(), atlasesAt(B_TILE_DEVICE)))
    const gridRight = camera.originX + camera.cols * camera.tileSize
    const gridBottom = camera.originY + camera.rows * camera.tileSize
    const probes: readonly (readonly [number, number, string])[] = [
      [camera.originX - 1, camera.originY + 1, 'left letterbox'],
      [gridRight, camera.originY + 1, 'right letterbox'],
      [camera.originX + 1, camera.originY - 1, 'above the grid rect'],
      [camera.originX + 1, gridBottom, 'below the grid rect'],
    ]
    for (const [px, py, where] of probes) {
      const hit = covering(strip, px, py)
      expect(hit.length, `${where} (${px}, ${py}) is covered by ${hit.length} fills, not 1`).toBe(1)
      const style = hit[0]?.command.op === 'fillRect' ? hit[0].command.fillStyle : ''
      expect(style, `${where} is painted land`).toBe(BACKGROUND)
    }
    // ...and the mirror probes, one CSS px INSIDE each edge, are land — without
    // these the four above pass on a renderer that paints the whole canvas
    // background and never draws a playfield at all.
    const inside: readonly (readonly [number, number, string])[] = [
      [camera.originX, camera.originY, 'the rect’s top-left cell'],
      [gridRight - 1, camera.originY, 'the rect’s top-right cell'],
      [camera.originX, gridBottom - 1, 'the rect’s bottom-left cell'],
      [gridRight - 1, gridBottom - 1, 'the rect’s bottom-right cell'],
    ]
    for (const [px, py, where] of inside) {
      const hit = covering(strip, px, py)
      expect(hit.length, `${where} (${px}, ${py}) is covered by ${hit.length} fills, not 1`).toBe(1)
      const style = hit[0]?.command.op === 'fillRect' ? hit[0].command.fillStyle : ''
      expect(style, `${where} is not painted land`).toBe(LAND)
    }
  })

  it('covers the M0 device’s whole backing store — plan Decision 4’s own 1,412,880 device px, RECOMPUTED', () => {
    // Plan Decision 4 charges the matte at exactly one full-canvas fill:
    // 406 x 870 CSS at the DPR-2 cap is 812 x 1740 = 1,412,880 device px.
    //
    // **Task 9 split the matte from three fills into five and the figure did not
    // move, which is the whole point of recomputing it rather than assuming it:
    // a partition of the same canvas into more rectangles paints the same
    // pixels.** What changed is the CALL count, 3 -> 5, and under M0's own cost
    // model (calls x 0.16 us + pixels / 10 Gpx/s) that is
    // 0.1418 ms -> 0.1421 ms, a 0.23% increase on the pass.
    const camera = cameraA()
    const strip = bands(draw(frameA(), atlasesAt(58)))

    const deviceArea = assertExactTiling(strip, camera)
    expect(camera.dpr).toBe(2)
    expect(deviceArea).toBe(1_412_880)
    expect(deviceArea).toBe(812 * 1740)
    expect(deviceArea).toBe(406 * 870 * 2 * 2)

    // On the M0 device `originX` is 0 — 406 = 14 x 29 exactly — so both
    // letterbox columns are ZERO WIDTH and the whole visible change is at the
    // grid rect's bottom edge. Recorded rather than left as a surprise: the
    // fixture that exercises the columns is B, and it has to be.
    expect(camera.originX).toBe(0)
    expect(strip.map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [0, 0, 406, A_ORIGIN_Y],
      [0, A_ORIGIN_Y, 0, 638],
      [406, A_ORIGIN_Y, 0, 638],
      [0, A_ORIGIN_Y, 406, 638],
      [0, A_ORIGIN_Y + 638, 406, 870 - A_ORIGIN_Y - 638],
    ])
    expect(strip.map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [0, 0, 406, 86],
      [0, 86, 0, 638],
      [406, 86, 0, 638],
      [0, 86, 406, 638],
      [0, 724, 406, 146],
    ])

    // The bottom fill covers three things at once: the 40 CSS px gap between the
    // grid rect and the HUD band — the strip a finger can land in, and the one
    // this task's colour change is actually about — plus the 72 px band and the
    // 34 px home-indicator inset. 40 + 72 + 34 = 146.
    expect(A_HUD_TOP - (A_ORIGIN_Y + 638)).toBe(40)
    expect(strip[4]?.h).toBe(40 + camera.hudHeight + 34)
  })
})

describe('the bands tile the DEVICE grid too, which the DPR-1.5 cap breaks (review I2)', () => {
  /**
   * `fitCamera` works in integer CSS px and `DPR_CAP_LOW` is 1.5, so an odd CSS
   * edge lands on a half device pixel. Two fills sharing a half-pixel edge give
   * that device row two source-over passes at alpha 0.5 instead of one opaque
   * pass — it keeps 25% of the previous frame, which is precisely the ghosting
   * plan Decision 4's "every pixel of the canvas must be covered" forbids, on
   * exactly the class of device the DPR cap exists for.
   *
   * CSS-space tiling cannot see this: the review's 18-viewport sweep found gap
   * 0.0000 and overlap 0.0000 everywhere while this seam was live. The device
   * grid is the frame the invariant is actually about.
   */

  const cameraC = (): Camera =>
    fitCamera(
      { cssW: 412, cssH: 915, topInset: 24, bottomInset: 24, rawDpr: 2.625, performanceClass: 'LOW' },
      { x0: 5, y0: 9, cols: 14, rows: 22 },
    )

  /**
   * A second LOW device where **all four** snapped values are odd, and therefore
   * all four are fractional in device space.
   *
   * The sweep needed it: on `cameraC` the grid top (102) and the canvas width
   * (412) are both even, so `102 × 1.5 = 153` and `412 × 1.5 = 618` are already
   * whole and *not snapping them* passed every test. One fixture per device
   * shape is not enough when the property is a parity — the catalogue's "a
   * fixture that cannot distinguish the variables", arriving through the
   * arithmetic rather than through the geometry.
   *
   * ```
   * availableH = 915 − 25 − 72 − 24 = 794 ... tile = floor(min(411/14, 794/22)) = 29
   * originY = 25 + floor((794 − 638)/2) = 103   hudTop = 915 − 24 − 72 = 819
   * 411 × 1.5 = 616.5   103 × 1.5 = 154.5   819 × 1.5 = 1228.5   915 × 1.5 = 1372.5
   * ```
   */
  const cameraD = (): Camera =>
    fitCamera(
      { cssW: 411, cssH: 915, topInset: 25, bottomInset: 24, rawDpr: 3, performanceClass: 'LOW' },
      { x0: 5, y0: 9, cols: 14, rows: 22 },
    )

  it('is not vacuous: the second LOW fixture has all four edges on half device pixels', () => {
    const camera = cameraD()
    expect(camera.dpr).toBe(1.5)
    expect([camera.cssW, camera.originY, camera.hudTop, camera.cssH]).toEqual([411, 103, 819, 915])
    for (const value of [camera.cssW, camera.originY, camera.hudTop, camera.cssH]) {
      expect(value * 1.5 - Math.floor(value * 1.5), `${value} is already integral at 1.5`).toBe(0.5)
    }
  })

  it('snaps ALL SIX cut lines, not only the two that happen to be odd on one device', () => {
    const camera = cameraD()
    const strip = bands(draw(frameOn(camera, 24, 40), atlasesAt(43)))
    const dev = (v: number): number => Math.round(v * camera.dpr)

    // `assertExactTiling` checks every edge of every fill is whole in device
    // space, which is six distinct cut lines now rather than four: canvas
    // right/bottom, grid top/bottom, grid left/right.
    assertExactTiling(strip, camera)

    // Hand-computed at DPR 1.5, all six: 411 x 1.5 = 616.5 -> 617;
    // 915 x 1.5 = 1372.5 -> 1373; originY 103 x 1.5 = 154.5 -> 155;
    // gridBottom (103 + 22 x 29 = 741) x 1.5 = 1111.5 -> 1112;
    // originX floor((411 - 406)/2) = 2, 2 x 1.5 = 3 (already whole);
    // gridRight 408 x 1.5 = 612 (already whole).
    expect([camera.originX, camera.originY, camera.tileSize]).toEqual([2, 103, 29])
    expect(dev(camera.cssW)).toBe(617)
    expect(dev(camera.cssH)).toBe(1373)
    expect(strip.map((b) => dev(b.y))).toEqual([0, 155, 155, 155, 1112])
    expect(strip.map((b) => dev(b.x))).toEqual([0, 0, 612, 3, 0])
  })

  it('is the viewport that proves it: a Pixel at LOW puts hudTop on a half device pixel', () => {
    // Integer CSS in, fractional device out — no fixture trickery.
    const camera = cameraC()
    expect(camera.dpr).toBe(1.5)
    expect([camera.originY, camera.hudTop, camera.cssH]).toEqual([102, 819, 915])
    expect(819 * 1.5).toBe(1228.5) // the seam, before the fix
    expect(915 * 1.5).toBe(1372.5)
  })

  it('lands every fill edge on a whole device pixel there', () => {
    const camera = cameraC()
    // `deviceRect`, called for every fill inside `assertExactTiling`, is the
    // half-pixel assertion; this test exists so its failure names this viewport.
    assertExactTiling(bands(draw(frameOn(camera, 24, 40), atlasesAt(43))), camera)
  })

  it('tiles the backing store exactly in DEVICE pixels: 618 x 1373, no gap, no overlap', () => {
    const camera = cameraC()
    const strip = bands(draw(frameOn(camera, 24, 40), atlasesAt(43)))
    const dev = (v: number): number => Math.round(v * camera.dpr)

    // The backing store Task 8 must allocate, hand-computed:
    //   round(412 x 1.5) = 618,  round(915 x 1.5) = 1373
    const width = dev(camera.cssW)
    const height = dev(camera.cssH)
    expect([width, height]).toEqual([618, 1373])
    expect(assertExactTiling(strip, camera)).toBe(width * height)

    // The device rows the seam used to split: 153 (clean either way) and the
    // grid rect's bottom, 102 + 22 x 29 = 740, 740 x 1.5 = 1110.
    expect(strip.map((b) => dev(b.y))).toEqual([0, 153, 153, 153, 1110])
  })

  it('still tiles exactly in CSS space at DPR 2, where the snapping is the identity', () => {
    // The fix must not perturb the integral case: at the universal cap of 2 with
    // an integer CSS camera, round(v * 2) / 2 === v, so every literal in this
    // file is unchanged by it.
    expect(bands(draw(frameA(), atlasesAt(58))).map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [0, 0, 406, 86],
      [0, 86, 0, 638],
      [406, 86, 0, 638],
      [0, 86, 406, 638],
      [0, 724, 406, 146],
    ])
    expect(bands(draw(frameB(), atlasesAt(B_TILE_DEVICE))).map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [0, 0, 400, 192],
      [0, 192, 2, 264],
      [398, 192, 2, 264],
      [2, 192, 396, 264],
      [0, 456, 400, 244],
    ])
  })

  it('keeps all five fills on-canvas and non-overlapping on a degenerate viewport (review M2)', () => {
    // `fitCamera` clamps `tileSize` to 1 on a transiently zero-sized viewport —
    // a hidden webview, a measurement mid-rotation — and the plain formula then
    // gives `originY = -41` and a negative-height fill. The canvas normalises
    // it, so this was never a coverage hole, but the shipped tiling walk PASSED
    // on it with `cursor` running negative, which means the test was one
    // assertion away from accepting a geometry it never saw.
    //
    // Task 9 adds the horizontal half of the same hazard, and it is NOT the same
    // fixture: `cssH = 0` alone leaves `originX` positive. `cssW = 0` is what
    // drives `originX` negative — floor((0 - 6)/2) = -3 at a clamped tile of 1 —
    // and without the `gridLeft`/`gridRight` clamps that is a negative-width
    // letterbox fill and a playfield running off the left of the canvas.
    for (const [cssW, cssH] of [
      [40, 0],
      [0, 40],
      [0, 0],
    ] as const) {
      const camera = fitCamera(
        { cssW, cssH, topInset: 0, bottomInset: 0, rawDpr: 2, performanceClass: null },
        { x0: 1, y0: 1, cols: 6, rows: 4 },
      )
      expect(camera.tileSize, `${cssW}x${cssH}`).toBe(1)
      const strip = bands(draw(frameOn(camera, B_W, B_H), atlasesAt(2)))
      expect(assertExactTiling(strip, camera), `${cssW}x${cssH}`).toBe(
        Math.round(camera.cssW * camera.dpr) * Math.round(camera.cssH * camera.dpr),
      )
    }
  })

  it('is not vacuous: the degenerate viewports really do drive an origin negative on each axis', () => {
    // Without this the loop above passes on three viewports that never reach the
    // clamps at all, which is the fixture-too-permissive shape.
    const tall = fitCamera(
      { cssW: 40, cssH: 0, topInset: 0, bottomInset: 0, rawDpr: 2, performanceClass: null },
      { x0: 1, y0: 1, cols: 6, rows: 4 },
    )
    expect(tall.originY, 'cssH = 0 must drive originY negative').toBeLessThan(0)
    expect(tall.originX, 'cssH = 0 leaves originX positive — it cannot test the columns').toBeGreaterThanOrEqual(0)

    const narrow = fitCamera(
      { cssW: 0, cssH: 40, topInset: 0, bottomInset: 0, rawDpr: 2, performanceClass: null },
      { x0: 1, y0: 1, cols: 6, rows: 4 },
    )
    expect(narrow.originX, 'cssW = 0 must drive originX negative').toBeLessThan(0)
    expect(narrow.originX + narrow.cols * narrow.tileSize, 'and gridRight past the canvas').toBeGreaterThan(0)
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
    const paints = content(draw(frameA(), atlasesAt(58)))
    // **Two, not one, since M1f Task 10**: the car, and §7.2's inventory chip,
    // which is drawn on EVERY frame — greyed, with its badge suppressed, on this
    // fixture, which holds none. It is HUD furniture in the bottom band, 618 CSS
    // px below the car, and it is named here rather than filtered out so that
    // "the board drew exactly one thing" stays an exact claim.
    expect(paints.length).toBe(2)
    expect(paints[0]?.command).toEqual({
      op: 'fillRect',
      fillStyle: GROUP[3] as string,
      x: 108.75,
      y: 303.5,
      w: 14.5,
      h: 14.5,
    })
    // The chip: `CHIP_ICON_INSET_CSS` from its column's left edge, centred in
    // the band's 56 px of content height, in `chipEmpty` because none is held.
    // Column x at fixture A: 8 + 3 * (91 + 8) = 305; y = 772 + (56 - 20)/2 = 790.
    expect(paints[1]?.command).toEqual({
      op: 'fillRect',
      fillStyle: PALETTE.chipEmpty,
      x: 305 + 12,
      y: 790,
      w: 20,
      h: 20,
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
    const paints = content(draw(frame, atlasesAt(B_TILE_DEVICE)))
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
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
    expect(groupFills(log, 33, 33).length).toBe(2)
  })

  it('draws exactly houseCount houses and destCount destinations', () => {
    const frame = frameB()
    expect(frame.houseCount).toBeLessThan(frame.houseCell.length)
    expect(frame.destCount).toBeLessThan(frame.destCell.length)
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
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
    const paints = content(draw(frame, atlasesAt(B_TILE_DEVICE)))
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
    const paints = content(draw(frame, atlasesAt(B_TILE_DEVICE)))
    const centre = covering(paints, bx(1) + 33, by(2) + 33)
    expect(centre).toEqual([])

    // The other half of the claim: that point IS covered, by the playfield fill
    // — index 3 of the matte since Task 9 (top band, two letterbox columns,
    // playfield, bottom band).
    const landBand = bands(draw(frame, atlasesAt(B_TILE_DEVICE)))[3]
    expect(landBand?.command.op === 'fillRect' ? landBand.command.fillStyle : '').toBe(LAND)
    expect(covering(landBand === undefined ? [] : [landBand], bx(1) + 33, by(2) + 33).length).toBe(1)
  })

  it('draws a tree on the same cell when the class is TREE, inset so land shows around it', () => {
    const frame = frameB() // (1, 2) is TREE
    const paints = content(draw(frame, atlasesAt(B_TILE_DEVICE)))
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
    const log = draw(frameB(), atlasesAt(B_TILE_DEVICE))
    expect(fillsStyled(log, WATER)).toEqual([
      fill(WATER, 68, 192, 66, 66),
      fill(WATER, 68, 390, 66, 66),
    ])
    expect(fillsStyled(log, MOUNTAIN)).toEqual([fill(MOUNTAIN, 332, 324, 66, 66)])
  })

  it('draws nothing for a terrain class it does not recognise', () => {
    // `terrainClass` is a Uint8Array, so a value outside `TerrainClass` is
    // representable even though `game`'s fold produces only 0-3. The claim in
    // `drawTerrain`'s comment — an unrecognised class paints nothing rather than
    // falling through to a colour — is asserted here, because a comment that
    // states a behaviour with no test behind it reads exactly like coverage.
    const frame = frameB()
    frame.terrainClass[1 * B_W + 2] = 9 // the water cell
    const paints = content(draw(frame, atlasesAt(B_TILE_DEVICE)))
    expect(covering(paints, bx(2) + 33, by(1) + 33)).toEqual([])
  })

  it('indexes terrainClass at y * gridW + x, where gridW is the BOARD width', () => {
    // gridW is 8 and the camera's cols is 6, so a stride taken from the camera
    // reads a different cell. The three terrain cells are at three distinct
    // (x, y) pairs with x != y, so a transposed index moves all three.
    const frame = frameB()
    expect(frame.gridW).toBe(8)
    expect(frame.camera.cols).toBe(6)
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
    expect(fillsStyled(log, WATER)[0]).toEqual(fill(WATER, bx(2), by(1), 66, 66))
    expect(fillsStyled(log, MOUNTAIN)[0]).toEqual(fill(MOUNTAIN, bx(6), by(3), 66, 66))
  })
})

describe('roads: one blit per road cell, from that mask’s own atlas tile', () => {
  it('blits mask 17 from tile (1, 1), source in device px and destination in CSS px', () => {
    const atlases = atlasesAt(B_TILE_DEVICE)
    const road = atlases.road
    const seventeen = layerBlits(draw(frameB(), atlases), road).find(
      (b) => b.dx === 134 && b.dy === 258,
    )
    expect(seventeen).toEqual(blit(road, 132, 132, 134, 258))
    // The source rect is the atlas's tile size and the destination rect the
    // camera's — at the DPR-2 cap they differ by exactly the ratio, and
    // swapping them is a road drawn at half or double size.
    expect(seventeen?.sw).toBe(road.tileDevicePx)
    expect(seventeen?.dw).toBe(B_TILE)
    expect(road.tileDevicePx).not.toBe(B_TILE)
  })

  it('never blits mask 0 — it is the blank tile, and 0 means "no road"', () => {
    const frame = frameB()
    frame.roads.fill(0)
    const atlases = atlasesAt(B_TILE_DEVICE)
    expect(layerBlits(draw(frame, atlases), atlases.road)).toEqual([])
    // ...and the same for the ghost layer, from its own array: the two share one
    // loop, so `mask === 0` skipped for roads and not for ghosts is not
    // constructible — but the ghost half needs its own observer anyway, because
    // "blit tile 0 for every empty cell" is 960 blits a frame and a black board.
    frame.ghosts.fill(0)
    expect(layerBlits(draw(frame, atlases), atlases.ghost)).toEqual([])
  })

  it('reads a DIFFERENT source tile for each of the five masks, so the lookup is not a constant', () => {
    // With one road cell the tile is (1, 1) and `sx === sy`, so a transposed
    // lookup is invisible — which is why the fixture's five masks are 16, 17, 1,
    // 4 and 2: five distinct tiles, three of them off the diagonal.
    const atlases = atlasesAt(B_TILE_DEVICE)
    const all = layerBlits(draw(frameB(), atlases), atlases.road)
    expect(all.map((b) => [b.sx, b.sy])).toEqual([
      [0, 132], // mask 16 -> tile (0, 1)
      [132, 132], // mask 17 -> tile (1, 1)
      [132, 0], // mask 1  -> tile (1, 0)
      [528, 0], // mask 4  -> tile (4, 0)
      [264, 0], // mask 2  -> tile (2, 0)
    ])
    expect(new Set(all.map((b) => `${b.sx},${b.sy}`)).size).toBe(5)
  })
})

describe('culling: only cells inside the revealed rect are drawn', () => {
  it('issues exactly five blits, though a NON-ZERO mask sits past every bound', () => {
    // "What else could prevent the blit": an empty mask. So all four out-of-rect
    // road cells carry non-zero masks and so do the five inside — the count is
    // what separates "culled" from "there was nothing there".
    //
    // **One cell past each bound, not two in the diagonal corners.** The first
    // version put its out-of-rect roads at (0, 3) and nowhere else, so
    // extending the loop by one column to the right, or one row either way,
    // reached nothing and three over-iteration mutants survived the suite.
    const frame = frameB()
    const outside = [
      [0, 3],
      [7, 3],
      [3, 0],
      [3, 5],
    ] as const
    for (const [x, y] of outside) {
      expect(frame.roads[y * B_W + x] as number, `(${x}, ${y}) must carry a mask`).toBeGreaterThan(0)
    }
    expect(frame.roads[2 * B_W + 3] as number).toBe(17)
    const atlases = atlasesAt(B_TILE_DEVICE)
    expect(layerBlits(draw(frame, atlases), atlases.road).length).toBe(5)
  })

  it('fills no terrain outside the rect, though a non-LAND cell sits past every bound', () => {
    const frame = frameB()
    const outside = [
      [0, 2],
      [7, 2],
      [2, 0],
      [2, 5],
    ] as const
    for (const [x, y] of outside) {
      expect(
        frame.terrainClass[y * B_W + x] as number,
        `(${x}, ${y}) must be non-LAND`,
      ).not.toBe(TerrainClass.LAND)
    }
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
    expect(fillsStyled(log, WATER).length).toBe(2) // the two in-rect ones only
    expect(fillsStyled(log, TREE).length).toBe(1)
  })

  it('is not vacuous: every out-of-rect marker is one cell past exactly one bound', () => {
    // The property that separates this fixture from the one that let four
    // over-iteration mutants live: a marker in a diagonal corner is past TWO
    // bounds at once and is therefore unreachable by any single one-cell
    // extension, which is why it detects none of them.
    const frame = frameB()
    const c = frame.camera
    const markers = [
      [0, 2],
      [7, 2],
      [2, 0],
      [2, 5],
      [0, 3],
      [7, 3],
      [3, 0],
      [3, 5],
    ] as const
    for (const [x, y] of markers) {
      const past = [
        x < c.x0,
        x >= c.x0 + c.cols,
        y < c.y0,
        y >= c.y0 + c.rows,
      ].filter(Boolean).length
      expect(past, `(${x}, ${y}) is outside on ${past} bounds, not 1`).toBe(1)
      // ...and exactly one cell past it, so a one-cell extension reaches it.
      expect(Math.max(c.x0 - x, x - (c.x0 + c.cols - 1), c.y0 - y, y - (c.y0 + c.rows - 1))).toBe(1)
    }
  })

  it('CLIPS a car overhanging the rect’s bottom edge, and lets one overhanging a side edge stand', () => {
    // Review M6 established that a car is centred on its resolved position, so
    // one near the rect's far row or column overhangs the grid rect. It is NOT
    // culled — `insideRevealed` is half-open — and what happens to the overhang
    // is decided entirely by the DRAW ORDER of the matte fill on that side.
    //
    // **Task 9 made the two sides differ, deliberately, and this pins it as a
    // rule rather than leaving it an accident.** The bottom fill is phase 8,
    // after the cars, because it is the only thing keeping a sprite out of the
    // HUD band — so the bottom overhang is now clipped at the playfield edge,
    // which is what makes the playfield read as a hard rectangle. The two
    // letterbox columns are phase 1, before the cars, so a side overhang stands.
    const camera = cameraB()
    const gridBottom = by(camera.y0 + camera.rows - 1) + B_TILE
    const gridRight = bx(camera.x0 + camera.cols - 1) + B_TILE
    expect([gridBottom, gridRight]).toEqual([456, 398])

    // --- the bottom edge: drawn, then painted over ---
    // 4.75 is inside the rect (`gy < y0 + rows` = 5) and dyadic, so exact in a
    // Float32Array. Centre y = 390 + 0.75 x 66 + 33 = 472.5; the sprite spans
    // [456, 489], entirely below the grid rect.
    const below = frameB()
    below.carXY[1] = 4.75
    const belowLog = draw(below, atlasesAt(B_TILE_DEVICE))
    const belowCar = content(belowLog).find((p) => p.w === 33 && p.h === 33 && p.y === 456)
    expect(belowCar, 'the car at the rect’s last row').toBeDefined()
    expect((belowCar?.y ?? 0) + (belowCar?.h ?? 0), 'the car spills past the grid rect').toBe(489)

    const bottomFill = bands(belowLog)[4]
    expect(bottomFill?.y, 'the bottom fill must start at the grid rect, not at hudTop').toBe(gridBottom)
    expect(bottomFill?.index ?? -1, 'the bottom fill must be issued AFTER the cars').toBeGreaterThan(
      belowCar?.index ?? 0,
    )
    // ...and it really does cover the overhang, both ends of it.
    expect(covering(bands(belowLog), 200, 456).length).toBe(1)
    expect(covering(bands(belowLog), 200, 488).length).toBe(1)

    // --- a side edge: drawn, and NOT painted over ---
    // 6.75 is inside the rect (`gx < x0 + cols` = 7). Centre x = 2 + 5.75 x 66
    // + 33 = 414.5; the sprite spans [398, 431], starting exactly at gridRight.
    const beside = frameB()
    beside.carXY[0] = 6.75
    beside.carXY[1] = 3
    const besideLog = draw(beside, atlasesAt(B_TILE_DEVICE))
    const besideCar = content(besideLog).find((p) => p.w === 33 && p.h === 33 && p.x === 398)
    expect(besideCar, 'the car at the rect’s last column').toBeDefined()
    const rightBox = bands(besideLog)[2]
    expect(rightBox?.x, 'the right letterbox column').toBe(gridRight)
    expect(rightBox?.index ?? 0, 'the letterbox must be issued BEFORE the cars').toBeLessThan(
      besideCar?.index ?? 0,
    )
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
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
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
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
    expect(painted(log).filter((p) => p.w === 132 && p.h === 198).length).toBe(1)
    expect(painted(log).filter((p) => p.w === 198 && p.h === 132).length).toBe(0)
  })

  it('draws the carpark cell the frame names, not one it computes', () => {
    const frame = frameB()
    frame.destCarpark[0] = 3 * B_W + 5 // move it to (5, 3)
    // ...and a road bit UNDER it, so the bay keeps the reachable colour and this
    // test stays about the CELL. Without it the bay moves to a cell with no road
    // and turns red, which is a different rule's business (see the two
    // "paints the bay in the alarm colour" tests below).
    frame.roads[3 * B_W + 5] = 1
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
    expect(fillsStyled(log, ROAD_EDGE)).toEqual([
      fill(ROAD_EDGE, bx(5) + 16.5, by(3) + 16.5, 33, 33),
    ])
  })

  it('paints the bay in the alarm colour when NO ROAD reaches it, and grey when one does', () => {
    // **The whole point of the signal, on one fixture with a destination on each
    // side of the predicate.** A destination whose carpark carries no road takes
    // zero arrivals, so it is doomed from the frame it appears — and until this
    // line it was pixel-identical to a healthy one until its ring painted, which
    // on the shipped board is 95-107 s later.
    //
    // Fixture B's dest 0 sits on road mask 16 at (3, 1); dest 1's bay at (4, 1)
    // is bare. Two live destinations, so "colours the bay" and "colours the
    // RIGHT bay" are separable — a fixture with one of each is the only kind
    // that can tell a working split from a constant.
    const frame = { ...frameB(), destCount: 2 }
    expect(frame.roads[frame.destCarpark[0] as number], 'dest 0 IS reachable').toBe(16)
    expect(frame.roads[frame.destCarpark[1] as number], 'dest 1 is NOT').toBe(0)
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
    expect(fillsStyled(log, ROAD_EDGE)).toEqual([fill(ROAD_EDGE, bx(3) + 16.5, by(1) + 16.5, 33, 33)])
    expect(fillsStyled(log, OVERCROWD)).toEqual([fill(OVERCROWD, bx(4) + 16.5, by(1) + 16.5, 33, 33)])
  })

  it('follows destReachable and not the index — connecting a bare bay turns it grey', () => {
    // The arm has to track the fold's byte rather than the destination number,
    // or a player who draws the road the shutdown screen asked for gets no
    // acknowledgement. Same fixture, same indices, one byte different.
    //
    // **The byte, and NOT `roads`.** Until M1f this case pushed a road bit onto
    // the bare bay and expected grey — which is precisely the bug a player
    // reported in the shipped build, written down here as a requirement. One
    // tile on a bay reaches nothing; `game` decides what a road amounts to and
    // `render` is not allowed to guess.
    const connected = { ...frameB(), destCount: 2, destReachable: new Uint8Array([1, 1]) }
    const log = draw(connected, atlasesAt(B_TILE_DEVICE))
    expect(fillsStyled(log, OVERCROWD), 'nothing is unreachable now').toEqual([])
    expect(fillsStyled(log, ROAD_EDGE).length, 'both bays are grey').toBe(2)
    // ...and back, so this is a predicate and not a latch: the unconnected
    // fixture still reds exactly one.
    expect(fillsStyled(draw({ ...frameB(), destCount: 2 }, atlasesAt(B_TILE_DEVICE)), OVERCROWD).length).toBe(1)
  })

  it('ignores the road bit entirely — a paved bay that reaches nothing stays RED', () => {
    // **The user's report, at the renderer's own boundary.** A road bit on the
    // bay with `destReachable[1] = 0` is exactly the stub case: the fold says
    // nothing can get there and the colour must say so, however much road is
    // sitting on the cell. This is the mutation guard for "someone puts the
    // `roads` test back", and it is a different case from the one above —
    // there the byte changed, here it deliberately does not.
    const stubbed = { ...frameB(), destCount: 2, roads: new Uint8Array(frameB().roads) }
    stubbed.roads[stubbed.destCarpark[1] as number] = 4
    expect(stubbed.destReachable[1] as number, 'the fold still says no').toBe(0)
    const log = draw(stubbed, atlasesAt(B_TILE_DEVICE))
    expect(fillsStyled(log, OVERCROWD).length, 'the bay is still red').toBe(1)
    expect(fillsStyled(log, ROAD_EDGE).length, 'and only the reachable one is grey').toBe(1)
  })

  it('says the same thing as the shutdown sentence, because it is the same predicate', () => {
    // **The failure this guards is a disagreement, not a wrong colour.** The bay
    // and `failedText`'s split are one function (`destinationIsUnreachable`);
    // restating the predicate at the second site would let a red bay sit under
    // "DESTINATION 1 WENT UNSERVED", which reads as the game lying. Both arms,
    // both observables, one frame each. The M1f bug is the argument for sharing
    // made in the other direction: because there was one predicate, one fix
    // corrected the colour and the sentence together.
    const bare = { ...gameOverFrame({ failedDest: 1, destCount: 2 }) }
    const bareLog = drawWith(bare)
    expect(fillsStyled(bareLog, OVERCROWD).length, 'a red bay').toBe(1)
    expect(shutdownTexts(bareLog)).toContain('NOTHING CAN REACH DESTINATION 1')

    const connected = {
      ...gameOverFrame({ failedDest: 1, destCount: 2 }),
      destReachable: new Uint8Array([1, 1]),
    }
    const connectedLog = drawWith(connected)
    expect(fillsStyled(connectedLog, OVERCROWD), 'no red bay').toEqual([])
    expect(shutdownTexts(connectedLog)).toContain('DESTINATION 1 WENT UNSERVED')
  })

  it('draws no carpark OUTSIDE the revealed rect, even when its building is inside', () => {
    // A hole the mutation battery found: every other fixture puts the carpark
    // next to a building that is itself inside, so dropping the carpark's own
    // bounds check survived the whole suite. A carpark is a separate cell from
    // its footprint — for an E/W destination it is three cells along — so at the
    // rect's edge the building is drawn and its bay is not.
    const frame = frameB()
    frame.destCarpark[0] = 1 * B_W + 7 // (7, 1): on the board, outside the rect
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
    expect(fillsStyled(log, ROAD_EDGE)).toEqual([])
    // **Both colours, or the assertion above stopped meaning "no bay".** (7, 1)
    // carries no road, so a bay drawn here would come out in the ALARM colour
    // and a ROAD_EDGE-only assertion would pass while the bay was on screen.
    expect(fillsStyled(log, OVERCROWD), 'a red bay is still a bay').toEqual([])
    // Non-vacuity: the building it belongs to IS still drawn.
    expect(groupFills(log, 198, 132).length).toBe(1)
  })

  it('draws no carpark when the frame reports -1', () => {
    // `carparkCell` returns -1 for a destination whose carpark would fall off
    // the grid. Placement never stores one, but the value is representable and
    // -1 would otherwise be drawn as a cell at the far top-left.
    const frame = frameB()
    frame.destCarpark[0] = -1
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
    expect(fillsStyled(log, ROAD_EDGE)).toEqual([])
    // A -1 carpark IS roadless by `carparkIsRoadless`, so the alarm colour is
    // the arm it would take if the `>= 0` guard were dropped. Assert both.
    expect(fillsStyled(log, OVERCROWD), 'a red bay is still a bay').toEqual([])
  })

  it('draws one pin per waiting customer, capped, and none at zero', () => {
    const frame = frameB()
    frame.destPins[0] = 0
    expect(fillsStyled(draw(frame, atlasesAt(B_TILE_DEVICE)), UI_TEXT).length).toBe(0)

    frame.destPins[0] = 2
    expect(fillsStyled(draw(frame, atlasesAt(B_TILE_DEVICE)), UI_TEXT).length).toBe(2)

    // The cap exists because a destination's pin count is unbounded in the sim
    // while its footprint is 2 cells wide; without it the row runs off the
    // building and across the board.
    frame.destPins[0] = 40
    const capped = fillsStyled(draw(frame, atlasesAt(B_TILE_DEVICE)), UI_TEXT)
    expect(capped.length).toBe(MAX_DRAWN_PINS)
    expect(MAX_DRAWN_PINS).toBe(6)
    const last = capped[capped.length - 1]
    expect((last?.x ?? 0) + (last?.w ?? 0)).toBeLessThanOrEqual(bx(4) + 2 * B_TILE)
  })
})

describe('the HUD', () => {
  it('renders week, day, score and tilesLeft centred in hudRects’ first three rectangles', () => {
    const camera = cameraB()
    const rects = hudRects(camera, createHudRects())
    const drawn = texts(draw(frameB(), atlasesAt(B_TILE_DEVICE)))

    expect(drawn.map((t) => t.text)).toEqual(['W3 D5', '12 TRIPS', '17 TILES'])
    expect(drawn.map((t) => [t.x, t.y])).toEqual([
      [rects.clock.x + rects.clock.w / 2, rects.clock.y + rects.clock.h / 2],
      [rects.score.x + rects.score.w / 2, rects.score.y + rects.score.h / 2],
      [rects.tiles.x + rects.tiles.w / 2, rects.tiles.y + rects.tiles.h / 2],
    ])
    // Hand-written as well, so this is not an assertion against the same
    // expression twice. **RE-DERIVED at four columns — M1f Task 10** (the
    // three-column figures were 122 / 130 / 69 / 199 / 329):
    // w = floor((400 - 16 - 3*8)/4) = floor(90) = 90, stride = 98,
    // y = 608 + 8 + (72 - 16)/2 = 644, x = 8+45, 106+45, 204+45.
    expect(drawn.map((t) => [t.x, t.y])).toEqual([
      [53, 644],
      [151, 644],
      [249, 644],
    ])
    // The fourth column holds the inventory chip and draws NO text here: the
    // fixture holds no upgrades, so §7.2's badge is suppressed. That is the
    // suppression case's neighbour and is why this list has three entries and
    // not four.
    expect(drawn.length, 'the badge is suppressed at zero held').toBe(3)
    for (const t of drawn) {
      expect(t.textAlign).toBe('center')
      expect(t.textBaseline).toBe('middle')
      expect(t.font).toBe(HUD_FONT)
      expect(t.fillStyle).toBe(UI_TEXT)
      expect(t.y).toBeGreaterThan(B_HUD_TOP)
      expect(t.y).toBeLessThan(B_CSS_H)
    }
  })

  it('constrains every label with maxWidth, so "it fits its rect" is a construction guarantee', () => {
    // Review I4, and a claim this task's first report got wrong. The rendered
    // advance width of '12 TRIPS' at 600 20px system-ui is genuinely not
    // observable here — no font engine, and `system-ui` resolves to a different
    // face on iOS than on Android. But the FIT does not need to be measured:
    // the canvas spec condenses a run to at most `maxWidth`, so with
    // `textAlign = 'center'` the text occupies exactly
    // `[x - maxWidth/2, x + maxWidth/2]`. Passing `maxWidth = rect.w` makes
    // overflow impossible, and the argument is recorded.
    const rects = hudRects(cameraB(), createHudRects())
    const drawn = texts(draw(frameB(), atlasesAt(B_TILE_DEVICE)))
    const expected = [rects.clock, rects.score, rects.tiles]

    for (const [i, t] of drawn.entries()) {
      const rect = expected[i] as Rect
      expect(t.maxWidth, `label ${i} is unconstrained`).toBe(rect.w)
      expect(t.x - t.maxWidth / 2).toBeGreaterThanOrEqual(rect.x)
      expect(t.x + t.maxWidth / 2).toBeLessThanOrEqual(rect.x + rect.w)
    }
    expect(drawn.map((t) => t.maxWidth)).toEqual([90, 90, 90])
  })

  it('still fits at the NARROWEST viewport fitCamera accepts — 70 CSS px, not 96', () => {
    // The first report wrote its overflow risk against 122 CSS px, which is
    // fixture B's rect and not the worst case. `hudRects` gives
    // `floor((cssW - 2*8 - 3*8) / 4)`: 91 on the M0 device, 87 at 390, 83 at 375
    // and **70 at 320** — a viewport `fitCamera` fits without complaint. And the
    // labels are unbounded: `score` and `week` have no ceiling in the sim, so
    // overflow is a certainty at some value rather than a device risk. The
    // `maxWidth` guarantee is what makes that a legible condense instead of a
    // collision with the neighbouring element.
    //
    // **The figures fell by a whole column at M1f Task 10** — the band went from
    // three equal columns to four when §7.2's inventory chip arrived — and this
    // case is the one that says what that cost: 96 -> 70 CSS px at the narrowest
    // viewport in the suite. The cost is a more-condensed label and never an
    // overflowing one, which is exactly what `maxWidth` buys and why the fourth
    // column was affordable at all.
    const camera = fitCamera(
      { cssW: 320, cssH: 568, topInset: 20, bottomInset: 0, rawDpr: 2, performanceClass: null },
      { x0: 5, y0: 9, cols: 14, rows: 22 },
    )
    const rects = hudRects(camera, createHudRects())
    expect(rects.clock.w).toBe(70)
    expect(Math.floor((320 - 16 - 24) / 4)).toBe(70) // the arithmetic, independently

    const frame: RenderFrame = { ...frameOn(camera, 24, 40), score: 999_999, week: 1234, day: 6 }
    const drawn = texts(draw(frame, atlasesAt(camera.tileSize * camera.dpr)))
    expect(drawn.map((t) => t.text)).toEqual(['W1234 D6', '999999 TRIPS', '40 TILES'])
    for (const t of drawn) expect(t.maxWidth).toBe(70)
    // Containment holds for a label of any length, which is the point.
    expect(drawn[1]?.x ?? 0).toBe(rects.score.x + 35)
  })

  it('re-formats the text when a value changes, so the per-frame cache cannot go stale', () => {
    // The HUD's four numbers are formatted into strings, and a string built per
    // frame is an allocation in the frame loop. They are therefore memoised on
    // the values that produced them — which is a cache, and a cache that never
    // invalidates draws last week's score forever. That staleness IS observable
    // here; the allocation saving is not, and the report says so rather than
    // claiming a test for it.
    const atlas = atlasesAt(B_TILE_DEVICE)
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
    const atlas = atlasesAt(B_TILE_DEVICE)
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

  it('reserves the pause bars’ gutter, so the clock text cannot be drawn through them', () => {
    // Review M4: the bars occupy CSS [15, 22] and [29, 36] while `fillCentred`
    // was centring the clock text on the WHOLE rect — so a clock string wider
    // than a bit over half the rect runs straight through the second bar. That
    // is layout arithmetic, true whatever the glyph widths are, and it is why
    // this assertion is over coordinates and not over metrics.
    //
    // **RE-DERIVED at four columns — M1f Task 10.** The rect is 90 CSS px wide
    // here rather than 122, so the running figures go 69 / 122 -> 53 / 90 and
    // the paused ones 86.5 / 87 -> 70.5 / 55. **The left edge does NOT move**,
    // and that is the part worth seeing: it is `clock.x + gutter` = 43 at any
    // column width, because the gutter is derived from the band's HEIGHT
    // (`clock.h / 8`) and the band's height did not change. The guarantee below
    // is therefore about the same pixels it was about before.
    const atlas = atlasesAt(B_TILE_DEVICE)
    const clock = hudRects(cameraB(), createHudRects()).clock
    const barW = clock.h / 8 // 7
    const gutter = 5 * barW // 35: four bar-widths of indicator, one of gap

    const runningClock = texts(draw(frameB(false), atlas))[0]
    const pausedClock = texts(draw(frameB(true), atlas))[0]

    // Unpaused: the full rect, centred. Paused: the rect minus the gutter.
    expect([runningClock?.x, runningClock?.maxWidth]).toEqual([53, 90])
    expect([pausedClock?.x, pausedClock?.maxWidth]).toEqual([clock.x + gutter + (90 - gutter) / 2, 55])
    expect([pausedClock?.x, pausedClock?.maxWidth]).toEqual([70.5, 55])

    // The guarantee: the text's own span cannot reach the second bar's right edge.
    const left = (pausedClock?.x ?? 0) - (pausedClock?.maxWidth ?? 0) / 2
    expect(left).toBeGreaterThanOrEqual(clock.x + 4 * barW)
    expect(left).toBe(43)
  })
})

// ---------------------------------------------------------------------------
// Phase 6 and §7.2's chip: §5.6's junction upgrade — M1f Task 10
// ---------------------------------------------------------------------------

/** A `upgradeAt` view over fixture B's board with a flag set at each cell. */
function flagsAt(cells: readonly number[]): Uint8Array {
  const flags = new Uint8Array(B_CELLS)
  for (const c of cells) flags[c] = 1
  return flags
}

/**
 * A fixture-B frame with the four M1f Task 10 fields overridden.
 *
 * `upgradeCount` defaults to `cells.length` rather than being passed
 * separately, because the two disagreeing is a state `sim` cannot produce —
 * `applyPlaceUpgrade` moves the flag and the counter together and
 * `upgrades.test.ts` asserts the identity in both directions. The one case that
 * DOES pass them apart is the vacuity check below, which is about the renderer's
 * gate and not about the sim.
 */
function upgradeFrame(
  cells: readonly number[],
  over: { invUpgrades?: number; upgradeMode?: boolean; upgradeCount?: number } = {},
): RenderFrame {
  return {
    ...frameB(),
    upgradeAt: flagsAt(cells),
    upgradeCount: over.upgradeCount ?? cells.length,
    invUpgrades: over.invUpgrades ?? 0,
    upgradeMode: over.upgradeMode ?? false,
  }
}

/** Every marker fill, as the board cell it sits on. Reads only the recording. */
function markerCells(log: readonly Command[]): number[] {
  const size = B_TILE * UPGRADE_SIZE_FRACTION
  const inset = B_TILE * UPGRADE_INSET_FRACTION
  return log
    .filter((c): c is FillRectCommand => c.op === 'fillRect' && c.fillStyle === UPGRADE)
    .map((c) => {
      // The exact inverse of the draw, so a marker drawn at the wrong offset
      // fails the size check below rather than decoding to a plausible cell.
      expect([c.w, c.h], 'a marker is 1/3 of a tile square').toEqual([size, size])
      const gx = (c.x - inset - B_ORIGIN_X) / B_TILE + 1
      const gy = (c.y - inset - B_ORIGIN_Y) / B_TILE + 1
      expect(Number.isInteger(gx) && Number.isInteger(gy), 'a marker off the cell grid').toBe(true)
      return gy * B_W + gx
    })
}

/** The chip icon's fill command — exactly one per frame, in any of its states. */
function chipIcon(log: readonly Command[]): FillRectCommand {
  const rect = hudRects(cameraB(), createHudRects()).upgrades
  const hits = log.filter(
    (c): c is FillRectCommand =>
      c.op === 'fillRect' && c.w === CHIP_ICON_CSS && c.h === CHIP_ICON_CSS && c.x >= rect.x,
  )
  expect(hits.length, 'exactly one chip icon per frame').toBe(1)
  return hits[0] as FillRectCommand
}

describe('phase 6: the junction-upgrade marker', () => {
  const atlas = atlasesAt(B_TILE_DEVICE)

  it('draws a marker on every upgraded cell and on no other', () => {
    // (2, 2) = 18 and (5, 3) = 29, both strictly inside the revealed rect and
    // on different rows AND different columns, so a transposed index lands
    // nowhere.
    expect(markerCells(draw(upgradeFrame([18, 29]), atlas))).toEqual([18, 29])
  })

  it('draws nothing at all when no upgrade is placed', () => {
    const log = draw(upgradeFrame([]), atlas)
    expect(markerCells(log)).toEqual([])
    // Stronger than "no marker": the phase issues no `fillStyle` write either,
    // which is what `upgradeCount`'s early return buys on every frame of every
    // run before the player places their first one.
    expect(log.some((c) => c.op === 'set' && c.value === UPGRADE)).toBe(false)
  })

  it('is gated on the COUNT, so the pass cannot run on a board that has none', () => {
    // The vacuity half, and it is the one the brief's `upgradeCount` field exists
    // for: with the count at 0 the flags are never read at all. A renderer that
    // ignored the count and iterated anyway would draw these two markers.
    expect(markerCells(draw(upgradeFrame([18, 29], { upgradeCount: 0 }), atlas))).toEqual([])
    // ...and the same flags with a non-zero count DO draw, so the case above
    // fails for the gate rather than for the flags.
    expect(markerCells(draw(upgradeFrame([18, 29], { upgradeCount: 2 }), atlas))).toEqual([18, 29])
  })

  it('culls to the revealed rect, exactly as terrain and roads do', () => {
    // (0, 0) = 0 and (7, 5) = 47 are outside `x in [1, 7), y in [1, 5)`. Both
    // carry a flag, and the count is 3, so nothing here passes because the pass
    // did not run.
    expect(markerCells(draw(upgradeFrame([0, 18, 47], { upgradeCount: 3 }), atlas))).toEqual([18])
  })

  it('draws the marker UNDER the buildings and OVER the road mask', () => {
    // Ordering is the one thing a static glyph can still get wrong: under the
    // road mask the marker is hidden by the very cell it names, and over a
    // destination it covers the thing the player is routing to.
    //
    // (3, 2) = 19 carries road mask 17, so the marker and a road blit are on the
    // SAME cell — which is what makes "over the road mask" a claim about pixels
    // rather than about two disjoint regions.
    const log = draw(upgradeFrame([19]), atlas)
    const lastRoadBlit = log.reduce(
      (n, c, i) => (c.op === 'drawImage' && c.image === atlas.road.surface ? i : n),
      -1,
    )
    const marker = log.findIndex((c) => c.op === 'fillRect' && c.fillStyle === UPGRADE)
    const destination = log.findIndex(
      (c) => c.op === 'fillRect' && c.w === 198 && c.h === 132,
    )
    expect(lastRoadBlit, 'no road blit was recorded').toBeGreaterThan(-1)
    expect(destination, 'no destination footprint was recorded').toBeGreaterThan(-1)
    expect(lastRoadBlit).toBeLessThan(marker)
    expect(marker).toBeLessThan(destination)
  })

  it('sits well inside its tile, so the road mask stays legible under it', () => {
    const cmd = draw(upgradeFrame([19]), atlas).find(
      (c): c is FillRectCommand => c.op === 'fillRect' && c.fillStyle === UPGRADE,
    ) as FillRectCommand
    // A third of the tile, centred: 22 px of marker with 22 px of road showing
    // on each side at fixture B's 66 px tile.
    expect([cmd.w, cmd.h]).toEqual([22, 22])
    expect(cmd.x - bx(3)).toBe(22)
    expect(cmd.y - by(2)).toBe(22)
    expect(UPGRADE_INSET_FRACTION + UPGRADE_SIZE_FRACTION).toBeLessThan(1)
    expect(2 * UPGRADE_INSET_FRACTION + UPGRADE_SIZE_FRACTION, 'centred').toBeCloseTo(1, 12)
  })

  it('is drawn from the FLAGS and not from the roads, so an erased junction keeps its mark', () => {
    // **The state `sim` deliberately allows and the reason this is a pass of its
    // own.** `upgrades.ts` never clears `upgradeAt` — a mechanism that silently
    // stops working is this project's worst defect shape — so a player who
    // erases the junction still owns an upgrade there, cannot get it back, and
    // this mark is the only thing on screen that says which cell to redraw it
    // on. (1, 4) = 33 carries no road bit at all on this fixture.
    expect(frameB().roads[33]).toBe(0)
    expect(markerCells(draw(upgradeFrame([33]), atlas))).toEqual([33])
  })

  it('is not one of the six colour-group colours, nor the alarm colour', () => {
    // A mark in a group colour reads as a building or a car belonging to that
    // group; a mark in `overcrowd` reads as the one alarm this game has.
    expect(PALETTE.groups).not.toContain(UPGRADE)
    expect(UPGRADE).not.toBe(OVERCROWD)
    expect(UPGRADE).not.toBe(PALETTE.cardAccent)
  })
})

describe("§7.2's inventory chip", () => {
  const atlas = atlasesAt(B_TILE_DEVICE)

  it('draws a numeric badge when upgrades are held', () => {
    const drawn = texts(draw(upgradeFrame([], { invUpgrades: 2 }), atlas)).map((t) => t.text)
    expect(drawn).toContain('2')
    expect(drawn, 'the badge is the fourth label, after the three readouts').toEqual([
      'W3 D5',
      '12 TRIPS',
      '17 TILES',
      '2',
    ])
  })

  it('SUPPRESSES the badge and greys the icon at zero held, per §7.2', () => {
    // §7.2: "Icon plus count; greyed with badge suppressed at zero."
    const log = draw(upgradeFrame([], { invUpgrades: 0 }), atlas)
    expect(texts(log).map((t) => t.text)).not.toContain('0')
    expect(chipIcon(log).fillStyle).toBe(CHIP_EMPTY)
  })

  it('draws the icon in the ACCENT colour while the mode is ARMED, and dark when it is not', () => {
    // The mode must be visible, or a player who armed it by accident has no way
    // to know why their next tap did not draw a road.
    const armed = draw(upgradeFrame([], { invUpgrades: 1, upgradeMode: true }), atlas)
    const idle = draw(upgradeFrame([], { invUpgrades: 1, upgradeMode: false }), atlas)
    expect(chipIcon(armed).fillStyle).toBe(PALETTE.cardAccent)
    expect(chipIcon(idle).fillStyle).not.toBe(PALETTE.cardAccent)
    expect(chipIcon(idle).fillStyle).toBe(UI_TEXT)
    // ...and the geometry does not move with the state: only the colour does,
    // so the chip cannot be read as changing size or place.
    expect([chipIcon(armed).x, chipIcon(armed).y]).toEqual([chipIcon(idle).x, chipIcon(idle).y])
  })

  it('greys ahead of arming: zero held wins even if the mode is somehow armed', () => {
    // `pointer.ts` refuses to arm at zero held, so this pair is unreachable
    // through the DOM today — and the frame is a plain struct that a restore or
    // a future caller can hand over in any combination. Greyed is the honest
    // answer: the count is what the player can spend.
    const log = draw(upgradeFrame([], { invUpgrades: 0, upgradeMode: true }), atlas)
    expect(chipIcon(log).fillStyle).toBe(CHIP_EMPTY)
    expect(texts(log).map((t) => t.text)).not.toContain('0')
  })

  it('re-formats the badge when the held count changes, so its cache cannot go stale', () => {
    // The seventh single-slot memo in `canvas.ts`, held to the same standard as
    // the other six. **The brief's own assertion for this — `badgeText(2)` is
    // `badgeText(2)` — cannot fail**: strings are primitives and `toBe` is
    // `Object.is`, so it is true whether one string was allocated or a thousand.
    // Staleness is the observable half; the byte count is `packages/game`'s.
    expect(texts(draw(upgradeFrame([], { invUpgrades: 2 }), atlas)).map((t) => t.text)).toContain('2')
    expect(texts(draw(upgradeFrame([], { invUpgrades: 7 }), atlas)).map((t) => t.text)).toContain('7')
    // And back, so the cache is keyed on the value rather than on a dirty flag
    // that only ever fires once.
    expect(texts(draw(upgradeFrame([], { invUpgrades: 2 }), atlas)).map((t) => t.text)).toContain('2')
  })

  it('keeps the icon and the badge inside the chip rect, at every viewport in this file', () => {
    for (const [name, camera] of [
      ['fixture A', cameraA()],
      ['fixture B', cameraB()],
      [
        'the narrowest fitCamera accepts',
        fitCamera(
          { cssW: 320, cssH: 568, topInset: 20, bottomInset: 0, rawDpr: 2, performanceClass: null },
          { x0: 5, y0: 9, cols: 14, rows: 22 },
        ),
      ],
    ] as const) {
      const rect = hudRects(camera, createHudRects()).upgrades
      const frame: RenderFrame = {
        ...frameOn(camera, 24, 40),
        invUpgrades: 12,
      }
      const log = draw(frame, atlasesAt(camera.tileSize * camera.dpr))
      const icon = log.filter(
        (c): c is FillRectCommand =>
          c.op === 'fillRect' && c.w === CHIP_ICON_CSS && c.h === CHIP_ICON_CSS && c.x >= rect.x,
      )[0] as FillRectCommand
      expect(icon.x, `${name}: the icon starts left of its column`).toBeGreaterThanOrEqual(rect.x)
      expect(icon.x + icon.w, `${name}: the icon runs past its column`).toBeLessThanOrEqual(
        rect.x + rect.w,
      )
      expect(icon.y, `${name}: the icon starts above its column`).toBeGreaterThanOrEqual(rect.y)
      expect(icon.y + icon.h).toBeLessThanOrEqual(rect.y + rect.h)
      const badge = texts(log).find((t) => t.text === '12') as FillTextCommand
      expect(badge.x - badge.maxWidth / 2, `${name}: the badge overlaps the icon`).toBeGreaterThanOrEqual(
        icon.x + icon.w,
      )
      expect(badge.x + badge.maxWidth / 2).toBeLessThanOrEqual(rect.x + rect.w)
    }
  })
})

describe('allocation inside the frame loop, as far as this toolchain can see it', () => {
  /**
   * Review I3. The first report filed three allocation mutations as having "no
   * possible observer", and two of the three were observable — the third time on
   * this milestone that a "cannot observe" claim was half wrong. The honest
   * split is below, and the part that *can* be automated now is.
   *
   * `render`'s four allocating factories are named exports that the draw path
   * imports, and vitest can spy on ESM named exports. That turns "review is the
   * only check" from a fact into a choice for every allocation with an
   * importable identity — which is exactly the class Task 3 built the
   * caller-owned-`out` protocol to prevent.
   */

  it('calls none of render’s allocating factories during a frame', () => {
    // The frame and the atlas are built BEFORE the spies go up: `frameB` calls
    // `fitCamera` itself, and boot-time allocation is exactly what these
    // factories are for. The spies watch the frame loop and nothing else.
    const frame = frameB()
    const atlas = atlasesAt(B_TILE_DEVICE)
    const spies = [
      vi.spyOn(cameraModule, 'createHudRects'),
      vi.spyOn(cameraModule, 'createPoint'),
      vi.spyOn(cameraModule, 'createGridHit'),
      vi.spyOn(cameraModule, 'fitCamera'),
    ]
    try {
      for (let i = 0; i < 3; i++) drawFrame(new RecordingContext(), frame, atlas, PALETTE)
      for (const spy of spies) expect(spy, `${spy.getMockName()} was called`).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('is not vacuous: the same spies DO fire when those factories are called', () => {
    // A negative assertion over a spy is worthless if the spy cannot see the
    // call at all — and ESM namespace objects are not always spy-able, so this
    // is a property of the toolchain that has to be demonstrated rather than
    // assumed.
    const spy = vi.spyOn(cameraModule, 'createHudRects')
    try {
      cameraModule.createHudRects()
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('ghost roads: a second layer, from the ghost atlas, keyed by ghostMask', () => {
  /**
   * M1d Task 8. Spec §5.11: a road whose refund is deferred renders as a
   * thinner, lower-opacity ghost. The **stroke** properties are asserted in
   * `test/atlas.test.ts`, against the recorded atlas build, as two independent
   * `it()`s — they cannot be asserted here, because a blit records a source rect
   * and never a width or an alpha, and pretending otherwise would be exactly the
   * "cannot observe" mislabelling that hid a real Critical in Task 4.
   *
   * What IS observable here, and is the whole of this file's share of the
   * feature: *which* surface each blit reads, *which* tile of it, *where* it
   * lands, and *whether* the layer is culled to the revealed rect.
   */

  it('blits every ghost cell from the GHOST surface, at that mask’s own tile', () => {
    const atlases = atlasesAt(B_TILE_DEVICE)
    const ghosts = layerBlits(draw(frameB(), atlases), atlases.ghost)
    expect(ghosts).toEqual([
      blit(atlases.ghost, 0, 528, bx(2), by(3)), //   (2, 3) mask 64 -> tile (0, 4)
      blit(atlases.ghost, 1056, 0, bx(4), by(3)), //  (4, 3) mask 8  -> tile (8, 0)
    ])
    // The surface really is the other one. Without this the assertion above is
    // satisfied by a ghost pass that blits the ROAD atlas, which is a ghost
    // drawn as a solid road — the feature's whole point, silently absent.
    expect(atlases.ghost.surface).not.toBe(atlases.road.surface)
    for (const g of ghosts) expect(g.image).not.toBe(atlases.road.surface)
  })

  it('derives the tile from ghostMask, so a ghosted DIAGONAL segment draws diagonally', () => {
    // Two things at once, and both are needed. (a) The source tile follows the
    // mask — change the byte and the blit moves, so a boolean "this cell is a
    // ghost" driving a constant tile is dead here. (b) The tile it lands on is
    // one whose recorded SPOKES are diagonal, which is what "draws diagonally"
    // means when the drawing is a blit.
    const atlases = atlasesAt(B_TILE_DEVICE)
    const frame = frameB()
    const diagonal = layerBlits(draw(frame, atlases), atlases.ghost).find((b) => b.dx === bx(4))
    expect([diagonal?.sx, diagonal?.sy]).toEqual([1056, 0]) // mask 8 -> tile (8, 0)

    frame.ghosts[3 * B_W + 4] = 128 // NW, tile (0, 8)
    const moved = layerBlits(draw(frame, atlases), atlases.ghost).find((b) => b.dx === bx(4))
    expect([moved?.sx, moved?.sy]).toEqual([0, 1056])
    expect([moved?.sx, moved?.sy]).not.toEqual([diagonal?.sx, diagonal?.sy])

    // And the geometry on those tiles really is diagonal — read off a REAL
    // ghost build, not asserted about the mask numbering. Masks 8 (SE) and 128
    // (NW) each run centre-to-corner, so both coordinates move.
    const rec: { x1: number; y1: number; x2: number; y2: number }[] = []
    const recording: AtlasContext = {
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
      moveTo: (x, y) => {
        rec.push({ x1: x, y1: y, x2: Number.NaN, y2: Number.NaN })
      },
      lineTo: (x, y) => {
        const last = rec[rec.length - 1]
        if (last !== undefined) {
          rec[rec.length - 1] = { x1: last.x1, y1: last.y1, x2: x, y2: y }
        }
      },
      stroke: () => undefined,
    }
    buildAtlas(
      (w, h) => ({ width: w, height: h, getContext: () => recording }),
      16,
      PALETTE,
      AtlasVariant.GHOST,
    )
    // Tile (8, 0) is x in [128, 144), centre (136, 8); SE runs to (144, 16).
    const se = rec.find((s) => s.x1 === 136 && s.y1 === 8)
    expect(se).toEqual({ x1: 136, y1: 8, x2: 144, y2: 16 })
    expect(se?.x2 !== se?.x1 && se?.y2 !== se?.y1, 'not a diagonal').toBe(true)
  })

  it('leaves an adjacent LIVE road untouched — the other end of the erased segment', () => {
    // (1, 3) carries mask 1 and (2, 3) is its ghost: exactly what
    // `eraseRoad((1,3), (2,3))` produces. The live cell must still blit from the
    // ROAD atlas, at its own tile, unmoved and unfaded — "the ghost layer" must
    // not be "the road layer, redrawn".
    const atlases = atlasesAt(B_TILE_DEVICE)
    const log = draw(frameB(), atlases)
    const live = layerBlits(log, atlases.road).filter((b) => b.dx === bx(1) && b.dy === by(3))
    expect(live).toEqual([blit(atlases.road, 132, 0, bx(1), by(3))]) // mask 1 -> tile (1, 0)
    // ...and exactly one blit lands there, so the ghost pass did not also paint
    // the live cell.
    expect(blits(log).filter((b) => b.dx === bx(1) && b.dy === by(3)).length).toBe(1)
    // Non-vacuous: the two cells really are neighbours and really do differ.
    expect(frameB().roads[3 * B_W + 1] as number).toBe(1)
    expect(frameB().ghosts[3 * B_W + 2] as number).toBe(64)
    expect(frameB().roads[3 * B_W + 2] as number).toBe(0)
  })

  it('draws the ghost layer BEFORE the live road layer', () => {
    // The two are disjoint per cell, so this pins a chosen safety margin rather
    // than a visible behaviour — said out loud at the site in `canvas.ts` and
    // repeated here, so nobody reads the assertion as coverage of a pixel.
    const atlases = atlasesAt(B_TILE_DEVICE)
    const log = draw(frameB(), atlases)
    const ghostCommands = layerBlits(log, atlases.ghost)
    const roadCommands = layerBlits(log, atlases.road)
    expect([ghostCommands.length, roadCommands.length]).toEqual([2, 5])
    const lastGhost = log.indexOf(ghostCommands[1] as Command)
    const firstRoad = log.indexOf(roadCommands[0] as Command)
    expect(lastGhost).toBeGreaterThanOrEqual(0)
    expect(firstRoad).toBeGreaterThan(lastGhost)
    // ...and both are after the terrain and before the destinations, so the new
    // phase sits where the phase list says it does.
    expect(indexOfRect(log, 68, 192, 66, 66)).toBeLessThan(lastGhost) // the water cell
    expect(firstRoad).toBeLessThan(indexOfRect(log, 200, 192, 198, 132)) // the footprint
  })

  it('draws every ghost cell INSIDE the rect, including one on each of its four bounds', () => {
    // The under-approximation half. Shrink either far bound of the shared mask
    // loop and one of these four disappears.
    const atlases = atlasesAt(B_TILE_DEVICE)
    const drawn = layerBlits(draw(ghostBoundsFrame(), atlases), atlases.ghost)
    expect(drawn.map((b) => [b.dx, b.dy])).toEqual([
      [bx(2), by(1)], // y = y0
      [bx(1), by(2)], // x = x0
      [bx(6), by(3)], // x = x0 + cols - 1
      [bx(3), by(4)], // y = y0 + rows - 1
    ])
    // A count as well as a list: the list alone is satisfied by a loop that also
    // drew the four outside, since `toEqual` on a mapped array would catch it —
    // but stating the count makes the over-approximation half readable as its
    // own claim rather than as a side effect of ordering.
    expect(drawn.length).toBe(4)
  })

  it('draws NO ghost outside the rect, though a non-zero mask sits past every bound', () => {
    // The over-approximation half. "What else could prevent the blit" is an
    // empty mask, so all four outside cells carry one — the count is what
    // separates "culled" from "there was nothing there".
    const frame = ghostBoundsFrame()
    const atlases = atlasesAt(B_TILE_DEVICE)
    const drawn = layerBlits(draw(frame, atlases), atlases.ghost)
    const cam = frame.camera
    for (const b of drawn) {
      const gx = (b.dx - B_ORIGIN_X) / B_TILE + cam.x0
      const gy = (b.dy - B_ORIGIN_Y) / B_TILE + cam.y0
      expect(gx >= cam.x0 && gx < cam.x0 + cam.cols, `ghost at column ${gx}`).toBe(true)
      expect(gy >= cam.y0 && gy < cam.y0 + cam.rows, `ghost at row ${gy}`).toBe(true)
    }
    expect(drawn.length).toBe(4)
  })

  it('is not vacuous: the ghost fixture has a cell ON each bound and one PAST exactly one bound', () => {
    // Both halves of the bounds fixture, asserted rather than commented. A
    // fixture whose in-rect ghosts avoid the far bounds cannot see a shrunk
    // loop; a fixture whose out-of-rect ghosts sit in diagonal corners cannot
    // see an extended one, because a corner is past two bounds at once.
    const frame = ghostBoundsFrame()
    const c = frame.camera
    expect([c.x0, c.y0, c.cols, c.rows]).toEqual([1, 1, 6, 4])
    const at = (x: number, y: number): number => frame.ghosts[y * frame.gridW + x] as number

    const onBounds = [
      [1, 2, 'x = x0'],
      [2, 1, 'y = y0'],
      [6, 3, 'x = x0 + cols - 1'],
      [3, 4, 'y = y0 + rows - 1'],
    ] as const
    for (const [x, y, why] of onBounds) {
      expect(at(x, y), `no ghost on ${why}`).toBeGreaterThan(0)
      expect(x >= c.x0 && x < c.x0 + c.cols && y >= c.y0 && y < c.y0 + c.rows).toBe(true)
    }

    const outside = [
      [0, 3],
      [7, 1],
      [4, 0],
      [2, 5],
    ] as const
    for (const [x, y] of outside) {
      expect(at(x, y), `(${x}, ${y}) must carry a mask`).toBeGreaterThan(0)
      const past = [
        x < c.x0,
        x >= c.x0 + c.cols,
        y < c.y0,
        y >= c.y0 + c.rows,
      ].filter(Boolean).length
      expect(past, `(${x}, ${y}) is past ${past} bounds, not exactly 1`).toBe(1)
      // Exactly ONE cell past, not two: a marker two cells out survives a
      // one-cell over-extension just as a corner does.
      const overshoot =
        x < c.x0
          ? c.x0 - x
          : x >= c.x0 + c.cols
            ? x - (c.x0 + c.cols) + 1
            : y < c.y0
              ? c.y0 - y
              : y - (c.y0 + c.rows) + 1
      expect(overshoot, `(${x}, ${y}) is ${overshoot} cells past its bound`).toBe(1)
    }
    // And the four bound cells are NOT all in one corner, which is the shape
    // that made the original road fixture blind in the first place.
    expect(new Set(onBounds.map(([x]) => x)).size).toBeGreaterThan(1)
    expect(new Set(onBounds.map(([, y]) => y)).size).toBeGreaterThan(1)
  })

  it('skips mask 0, so an empty ghost layer costs no blits at all', () => {
    // The common case by far: no erase is pending, `ghostMask` is 960 zero
    // bytes, and the ghost pass must add nothing to the frame. Without this, a
    // pass that blitted tile 0 per cell would draw 336 invisible tiles a frame
    // inside the revealed rect and only a profiler would notice.
    const frame = frameB()
    frame.ghosts.fill(0)
    const atlases = atlasesAt(B_TILE_DEVICE)
    const log = draw(frame, atlases)
    expect(layerBlits(log, atlases.ghost)).toEqual([])
    // The road layer is untouched by an empty ghost layer.
    expect(layerBlits(log, atlases.road).length).toBe(5)
  })

  it('indexes ghosts at y * gridW + x, where gridW is the BOARD width', () => {
    // `gridW` (8) differs from `cols` (6) on this fixture, so reading with the
    // camera's stride lands on a different cell — and the same byte read at a
    // different stride is a ghost drawn in the wrong place, not an absent one.
    const frame = frameB()
    frame.ghosts.fill(0)
    frame.ghosts[3 * frame.gridW + 5] = 4 // (5, 3)
    const atlases = atlasesAt(B_TILE_DEVICE)
    const drawn = layerBlits(draw(frame, atlases), atlases.ghost)
    expect(drawn.map((b) => [b.dx, b.dy])).toEqual([[bx(5), by(3)]])
    expect(frame.gridW).not.toBe(frame.camera.cols)
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
    const stale = atlasesAt(B_TILE_DEVICE, { ...PALETTE, road: '#ff00ff' })
    expect(() => draw(frameB(), stale, PALETTE)).toThrow(/baked with a different palette/)
    expect(() => draw(frameB(), stale, PALETTE)).toThrow(/rebuild/)
  })

  it('does not throw when the two agree', () => {
    // The negative control: without it, a guard that throws unconditionally
    // passes the assertion above.
    expect(() => draw(frameB(), atlasesAt(B_TILE_DEVICE), PALETTE)).not.toThrow()
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
    expect(() => draw(frameB(), atlasesAt(B_TILE_DEVICE), twin)).toThrow(/baked with a different/)
  })

  it('checks the GHOST atlas too, and names which one is stale', () => {
    // **M1d Task 8 doubled this hazard and a guard on half of it reports clean
    // for the other half.** The ghost atlas bakes `palette.road` exactly as the
    // road atlas does — the fade is `globalAlpha`, not a second colour — so a
    // rebuild that refreshes one and not the other ships a board whose GHOSTS
    // are in last week's theme, with every road correct. That is strictly harder
    // to notice than the original, and without this test `assertAtlases` could
    // check `atlases.road` alone and pass everything above.
    const stale = { ...PALETTE, road: '#ff00ff' }
    const half = {
      road: oneAtlasAt(B_TILE_DEVICE, PALETTE, AtlasVariant.ROAD),
      ghost: oneAtlasAt(B_TILE_DEVICE, stale, AtlasVariant.GHOST),
    }
    expect(() => draw(frameB(), half, PALETTE)).toThrow(/ghost atlas was baked with a different/)
    // The mirror, so "names which one" is a claim about both arms rather than
    // about the one that happened to be written.
    const otherHalf = {
      road: oneAtlasAt(B_TILE_DEVICE, stale, AtlasVariant.ROAD),
      ghost: oneAtlasAt(B_TILE_DEVICE, PALETTE, AtlasVariant.GHOST),
    }
    expect(() => draw(frameB(), otherHalf, PALETTE)).toThrow(
      /road atlas was baked with a different/,
    )
  })

  it('throws when the two atlases are the wrong way round', () => {
    // Nothing else can see this: the pair have the same size, grid, tile count
    // and palette, so a swap type-checks, builds and draws — every live road as
    // a thin faded ghost and every ghost as a solid road, which reads as an art
    // regression rather than as a wiring error. `buildAtlases` cannot produce
    // the pair; a hand-assembled one can, and `main.ts` assembles by calling it.
    const road = oneAtlasAt(B_TILE_DEVICE, PALETTE, AtlasVariant.ROAD)
    const ghost = oneAtlasAt(B_TILE_DEVICE, PALETTE, AtlasVariant.GHOST)
    expect(() => draw(frameB(), { road: ghost, ghost: road }, PALETTE)).toThrow(
      /the wrong way round/,
    )
    // Negative control: the same two objects, correctly ordered, draw fine.
    expect(() => draw(frameB(), { road, ghost }, PALETTE)).not.toThrow()
  })

  it('throws when only one of the two was rebuilt for a new tile size', () => {
    // The palette hazard's twin. Both surfaces are rasterised at a fixed tile
    // size and the shell rebuilds on every tile-size change; rebuild one alone
    // and the ghost layer is resampled from a stale surface for the rest of the
    // session, with no symptom that points at its cause.
    const road = oneAtlasAt(B_TILE_DEVICE, PALETTE, AtlasVariant.ROAD)
    const ghost = oneAtlasAt(B_TILE_DEVICE / 2, PALETTE, AtlasVariant.GHOST)
    expect(() => draw(frameB(), { road, ghost }, PALETTE)).toThrow(/rebuilt without the other/)
    expect(road.tileDevicePx).not.toBe(ghost.tileDevicePx)
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
    const log = draw(frame, atlasesAt(B_TILE_DEVICE))
    const house = painted(log).find((p) => p.w === 44 && p.h === 44)
    const style = house?.command.op === 'fillRect' ? house.command.fillStyle : ''
    expect(style).toMatch(/^#[0-9a-f]{6}$/)
    expect(style).not.toBe('undefined')
  })
})

// ---------------------------------------------------------------------------
// The overcrowd ring and the shutdown screen — M1e Task 9
// ---------------------------------------------------------------------------

/**
 * **Read this before writing a test in this section.**
 *
 * A trial implementation of the scrim as a new final phase, gated on
 * `frame.gameOver`, was added to `canvas.ts` and the entire render suite stayed
 * GREEN — because `frameA()` and `frameB()` never set `gameOver`, so it read
 * `undefined`, so the phase never ran. **A new conditional draw phase is
 * unconstrained by every test this file had.** That is the catalogue's "a
 * fixture too permissive to exercise its own guard", and it is why every
 * fixture below sets `gameOver` explicitly on both sides and why the live-frame
 * negative at the bottom is not decoration.
 */

/** Every atlas pair in this section is the same one; the ring and the scrim blit nothing. */
function drawWith(frame: RenderFrame): Command[] {
  return draw(frame, atlasesAt(B_TILE_DEVICE))
}

/**
 * Fixture B with **two live destinations, both inside the rect, on different
 * rows and in different columns**, carrying the given meters.
 *
 * Both anchors matter. Two destinations is what separates "draws a ring" from
 * "draws it for the right one"; different rows AND different columns is what
 * stops a centre assertion passing on a transposed or a constant index — the
 * first draft put both on row 1, where `expectedCentreY` is the same number for
 * either and half the assertion carried nothing.
 *
 * ```
 *  dest 0   anchor (4, 1), orientation W -> 3x2 box (4..6, 1..2)
 *  dest 1   anchor (1, 3), orientation E -> 3x2 box (1..3, 3..4)
 * ```
 *
 * Both carparks are -1 so no bay is painted; the bay is `drawDestinations`'
 * other 33x33 fill and this section's classifiers do not need to tell them
 * apart.
 */
function frameWithOvercrowd(
  meters: readonly number[],
  options: { gameOver?: boolean; failedDest?: number } = {},
): RenderFrame {
  const base = frameB()
  return {
    ...base,
    destCount: 2,
    destCell: new Int32Array([1 * B_W + 4, 3 * B_W + 1]),
    destColour: new Uint8Array([4, 1]),
    destKind: new Uint8Array([0, 1]),
    destOrientation: new Uint8Array([3, 1]),
    destPins: new Uint8Array([0, 0]),
    destCarpark: new Int32Array([-1, -1]),
    destOvercrowd: new Uint8Array(meters),
    gameOver: options.gameOver ?? false,
    failedDest: options.failedDest ?? -1,
  }
}

/**
 * The two ring centres, **hand-computed from fixture B's camera** rather than
 * derived by the same arithmetic the renderer uses.
 *
 * ```
 * dest 0  px = 2 + (4-1)*66 = 200   cx = 200 + 3*66/2 = 299
 *         py = 192                  cy = 192 + 2*66/2 = 258
 * dest 1  px = 2                    cx = 2   + 3*66/2 = 101
 *         py = 192 + (3-1)*66 = 324 cy = 324 + 2*66/2 = 390
 * ```
 */
const RING_CENTRE: readonly (readonly [number, number])[] = [
  [299, 258],
  [101, 390],
]
function expectedCentreX(d: number): number {
  return (RING_CENTRE[d] as readonly [number, number])[0]
}
function expectedCentreY(d: number): number {
  return (RING_CENTRE[d] as readonly [number, number])[1]
}

/**
 * `max(footprintW, footprintH) * tile * RING_RADIUS_FRACTION` = `3 * 66 * 0.62`.
 *
 * **The radius is the same for both orientations and that is geometry, not an
 * accident to be tested away**: every destination footprint is a 2x3 or a 3x2
 * box, so `max(w, h)` is 3 either way and the two boxes share a diagonal. A
 * fixture cannot separate "derived from the footprint" from "three tiles" here,
 * and adding one that pretended to would be the catalogue's "a test that pins a
 * property nothing depends on".
 */
const RING_RADIUS = 122.76

function arcs(log: readonly Command[]): ArcCommand[] {
  return log.filter((c): c is ArcCommand => c.op === 'arc')
}

/**
 * The one ring on the frame, **asserting the count before indexing**.
 *
 * `arcs(log)[0] as ArcCommand` reads fine and dies as
 * `TypeError: Cannot read properties of undefined (reading 'startAngle')` the
 * moment a mutation stops drawing the ring — measured, on the "index the meter
 * by 0" mutant. A crash count reads exactly like a kill count, and a crash
 * message says nothing about the behaviour, so the count is asserted first and
 * the red names the rule.
 */
function onlyArc(log: readonly Command[]): ArcCommand {
  const found = arcs(log)
  expect(found.length, 'expected exactly one ring on this frame').toBe(1)
  return found[0] as ArcCommand
}

/**
 * One live destination anchored at `(gx, gy)` with a part-filled meter, and
 * nothing else on the board. Returns how many rings were drawn.
 */
function ringsDrawnFor(gx: number, gy: number): number {
  const frame: RenderFrame = {
    ...frameB(),
    roads: new Uint8Array(B_CELLS),
    ghosts: new Uint8Array(B_CELLS),
    terrainClass: new Uint8Array(B_CELLS),
    houseCount: 0,
    carCount: 0,
    destCount: 1,
    destCell: new Int32Array([gy * B_W + gx]),
    destColour: new Uint8Array([4]),
    destKind: new Uint8Array([0]),
    destOrientation: new Uint8Array([3]),
    destPins: new Uint8Array([0]),
    destCarpark: new Int32Array([-1]),
    destOvercrowd: new Uint8Array([200]),
  }
  return arcs(drawWith(frame)).length
}

/**
 * One marker ON each of the rect's four bounds and one marker **one cell past
 * exactly one bound** each.
 *
 * The two halves catch opposite mutations and neither is optional: the `inside`
 * half fails when a loop bound is SHRUNK, the `outside` half when one is
 * EXTENDED. A marker in a diagonal corner is past two bounds at once, so no
 * single one-cell over-extension reaches it — that placement produced seven
 * 0-detector mutants on M2 Task 5 and the vacuity test below asserts it is not
 * repeated.
 */
const RING_BOUND_MARKERS: readonly {
  readonly bound: string
  readonly inside: readonly [number, number]
  readonly outside: readonly [number, number]
}[] = [
  { bound: 'x = x0', inside: [1, 2], outside: [0, 2] },
  { bound: 'y = y0', inside: [2, 1], outside: [2, 0] },
  { bound: 'x = x0 + cols - 1', inside: [6, 3], outside: [7, 3] },
  { bound: 'y = y0 + rows - 1', inside: [3, 4], outside: [3, 5] },
]

/** Fixture B, in game over, with the knobs each shutdown assertion varies. */
function gameOverFrame(
  options: { score?: number; failedDest?: number; camera?: Camera; destCount?: number } = {},
): RenderFrame {
  const base = frameB()
  return {
    ...base,
    camera: options.camera ?? base.camera,
    score: options.score ?? base.score,
    // **`destCount` is a knob because the roadless split is guarded on the LIVE
    // prefix.** Fixture B has one live destination, so `failedDest: 1` names a
    // dead slot and takes the fail-closed arm whatever the road under it says —
    // which is correct behaviour and useless for exercising the split. The two
    // tests that cross the arms open the prefix to 2; every other case leaves it
    // alone so the liveness rule keeps its teeth here too.
    destCount: options.destCount ?? base.destCount,
    gameOver: true,
    failedDest: options.failedDest ?? 0,
  }
}

/** The same fixture, explicitly LIVE. `undefined` is falsy; this is not. */
function liveFrame(): RenderFrame {
  return { ...frameB(), gameOver: false }
}

/**
 * The scrim fill, **asserting it exists before the caller reads a coordinate**.
 * The `as FillRectCommand` form died as `TypeError: Cannot read properties of
 * undefined (reading 'y')` under the "draw the text but not the scrim" mutant —
 * a kill that names nothing. This one fails with the rule.
 */
function scrimFill(log: readonly Command[]): FillRectCommand {
  const found = log.find(
    (c): c is FillRectCommand => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim,
  )
  expect(found, 'no scrim was drawn at all — the shutdown phase did not run').toBeDefined()
  return found as FillRectCommand
}

/** The four corner cells of the revealed rect, in board coordinates. */
function fourBoardCorners(camera: Camera): readonly (readonly [number, number])[] {
  const x1 = camera.x0 + camera.cols - 1
  const y1 = camera.y0 + camera.rows - 1
  return [
    [camera.x0, camera.y0],
    [x1, camera.y0],
    [camera.x0, y1],
    [x1, y1],
  ]
}

/** Does `rect` cover the whole CSS box of board cell `(gx, gy)`? Fixture B only. */
function rectCoversGridCell(rect: FillRectCommand, gx: number, gy: number): boolean {
  return (
    rect.x <= bx(gx) &&
    rect.x + rect.w >= bx(gx) + B_TILE &&
    rect.y <= by(gy) &&
    rect.y + rect.h >= by(gy) + B_TILE
  )
}

function rectsOverlap(a: FillRectCommand, b: Rect): boolean {
  return (
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) > 0 &&
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) > 0
  )
}

/** Every text drawn AFTER the scrim, i.e. by the shutdown phase and nothing else. */
function shutdownTexts(log: readonly Command[]): string[] {
  const scrimIndex = log.findIndex((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)
  expect(scrimIndex, 'no scrim was drawn at all').toBeGreaterThan(-1)
  return log
    .slice(scrimIndex + 1)
    .filter((c): c is FillTextCommand => c.op === 'fillText')
    .map((c) => c.text)
}

describe('the overcrowd ring', () => {
  it('draws a ring only for a destination whose meter is non-zero, sized from the value', () => {
    // Two destinations, one at 0 and one part-filled, so "draws a ring" and
    // "draws it for the right one" are separable. A single-destination fixture
    // cannot tell them apart.
    const arc = onlyArc(drawWith(frameWithOvercrowd([0, 128])))
    expect(arc.endAngle - arc.startAngle).toBeCloseTo((128 / 255) * Math.PI * 2, 5)
  })

  it('draws the ring at the destination it belongs to, not at index 0', () => {
    // The bug this catches is indexing the ring by draw order rather than by
    // destination index — which is what a second loop over "the destinations
    // that drew" would produce.
    const arc = onlyArc(drawWith(frameWithOvercrowd([0, 200])))
    expect(arc.x).toBeCloseTo(expectedCentreX(1), 5)
    expect(arc.y).toBeCloseTo(expectedCentreY(1), 5)
    // ...and the other way round, so neither centre is a constant that happens
    // to match one of them.
    const other = onlyArc(drawWith(frameWithOvercrowd([200, 0])))
    expect(other.x).toBeCloseTo(expectedCentreX(0), 5)
    expect(other.y).toBeCloseTo(expectedCentreY(0), 5)
  })

  it('sweeps proportionally to the meter, from 12 o’clock, and closes only at 255', () => {
    // Three values rather than one: a sweep that ignored the meter, one that
    // used a fixed fraction, and one that inverted it are all separable here.
    //
    // The low value is `RING_MIN_SWEEP + 1` rather than 1, because below the
    // floor the sweep is deliberately NOT proportional — that rule and its own
    // non-vacuity live in the next test. Nine is one unit above the floor, so a
    // mutation that widened the floor by one is caught here as well.
    for (const [meter, turns] of [
      [RING_MIN_SWEEP + 1, (RING_MIN_SWEEP + 1) / 255],
      [64, 64 / 255],
      [255, 1],
    ] as const) {
      const arc = onlyArc(drawWith(frameWithOvercrowd([0, meter])))
      expect(arc.startAngle, `meter ${meter} starts at 12 o'clock`).toBeCloseTo(-Math.PI / 2, 9)
      expect(arc.endAngle - arc.startAngle, `meter ${meter}`).toBeCloseTo(turns * Math.PI * 2, 9)
    }
  })

  it('strokes it in the alarm colour, at a width derived from the tile, around the footprint', () => {
    const arc = onlyArc(drawWith(frameWithOvercrowd([0, 128])))
    expect(arc.strokeStyle).toBe(PALETTE.overcrowd)
    // 66 CSS px tile -> round(10.56) = 11. A hairline ring on a 29 px tile is
    // invisible on a phone and a fixed pixel width does not follow the three
    // tile sizes M2 fits; the ROUNDING is the measured allocation fix
    // documented at `RING_WIDTH_FRACTION`.
    expect(arc.lineWidth).toBe(11)
    expect(Number.isInteger(arc.lineWidth), 'a fractional width boxes on every store').toBe(true)
    // Outside the 3x2 footprint's half-diagonal (1.803 tiles), so the ring
    // encircles the building rather than cutting through its corners.
    expect(arc.radius).toBeCloseTo(RING_RADIUS, 5)
    expect(arc.radius).toBeGreaterThan(Math.hypot(1.5, 1) * B_TILE)
  })

  it('opens a path for the ring and strokes it — an arc alone paints nothing', () => {
    // `arc` appends to the current path. Without `beginPath` every ring on a
    // frame joins the previous one; without `stroke` none of them is painted at
    // all, and every geometry assertion above would still pass.
    const log = drawWith(frameWithOvercrowd([100, 200]))
    const shape = log.filter((c) => c.op === 'beginPath' || c.op === 'arc' || c.op === 'stroke')
    expect(shape.map((c) => c.op)).toEqual([
      'beginPath',
      'arc',
      'stroke',
      'beginPath',
      'arc',
      'stroke',
    ])
  })

  it('respects the revealed rect in BOTH directions', () => {
    for (const marker of RING_BOUND_MARKERS) {
      const [ix, iy] = marker.inside
      const [ox, oy] = marker.outside
      expect(ringsDrawnFor(ox, oy), `past ${marker.bound}`).toBe(0)
      expect(ringsDrawnFor(ix, iy), `the far edge of ${marker.bound} must still draw`).toBe(1)
    }
  })

  it('is not vacuous: every marker is one cell past EXACTLY one bound', () => {
    const camera = cameraB()
    const inside = (x: number, y: number): boolean =>
      x >= camera.x0 && x < camera.x0 + camera.cols && y >= camera.y0 && y < camera.y0 + camera.rows
    for (const marker of RING_BOUND_MARKERS) {
      const [ix, iy] = marker.inside
      const [ox, oy] = marker.outside
      expect(inside(ix, iy), `${marker.bound}: the inside marker is not inside`).toBe(true)
      expect(inside(ox, oy), `${marker.bound}: the outside marker is not outside`).toBe(false)
      // Past exactly one bound: the outside marker differs from the inside one
      // on exactly one axis, by exactly one cell.
      expect(Math.abs(ox - ix) + Math.abs(oy - iy), `${marker.bound}: not one cell`).toBe(1)
    }
    // ...and the four inside markers really do sit on four DIFFERENT bounds, so
    // this is four detectors rather than one repeated.
    expect(new Set(RING_BOUND_MARKERS.map((m) => m.bound)).size).toBe(4)
  })

  it('keeps the stroke width a whole CSS pixel on every tile size, and never zero', () => {
    // Two properties, both measured rather than asserted from the formula.
    //
    // INTEGER: on a plain-object context — every test double in this repo, and
    // the only shape the allocation harness profiles — `lineWidth` starts as
    // the Smi 0, so a fractional store transitions the field to Double and
    // boxes a HeapNumber on every ring. That measured 17-37 B/frame against a
    // 4 B floor.
    //
    // NEVER ZERO: `fitCamera` clamps the tile at 1 for a degenerate viewport,
    // where `round(1 * 0.16)` is 0 — and `lineWidth = 0` paints NOTHING on a
    // real canvas, which is a ring that vanishes rather than one that is thin.
    for (const tile of [1, 3, 4, 27, 29, 30, 66]) {
      const width = ringWidth(tile)
      expect(Number.isInteger(width), `tile ${tile}`).toBe(true)
      expect(width, `tile ${tile} paints nothing`).toBeGreaterThanOrEqual(1)
    }
    // Non-vacuous on the floor: the unfloored value really IS 0 at the tile
    // sizes the clamp exists for, so the clamp is doing work.
    expect(Math.round(1 * RING_WIDTH_FRACTION)).toBe(0)
    expect(ringWidth(1)).toBe(1)
    // ...and it is not a constant: the three tile sizes M2 actually fits give
    // real widths, and the largest gives a different one from the smallest.
    expect([ringWidth(27), ringWidth(29), ringWidth(30)]).toEqual([4, 5, 5])
    expect(ringWidth(66)).toBe(11)
  })

  it('draws no ring for a meter of zero, on a fixture where a ring is otherwise drawn', () => {
    // The negative on its own fixture. `frameB` has both meters at zero and
    // two live destinations would be drawn either way.
    expect(arcs(drawWith(frameWithOvercrowd([0, 0]))).length).toBe(0)
    expect(arcs(drawWith(frameWithOvercrowd([0, 1]))).length, 'and 1 is enough').toBe(1)
  })

  it('floors the SWEEP at RING_MIN_SWEEP without gating on it — 1 draws, and draws legibly', () => {
    // **The floor and the gate are different rules and the fixture separates
    // them.** Deleting the floor leaves every meter in [1, 8] painting an arc a
    // third of its own stroke width — a dot. Turning the floor INTO a gate
    // (`meter > RING_MIN_SWEEP` at the call site) leaves those meters painting
    // nothing at all, which is the defect the floor exists to fix, one step
    // worse. Both are caught below and by different assertions.
    const floorTurn = RING_MIN_SWEEP / 255
    for (const meter of [1, 4, RING_MIN_SWEEP]) {
      const arc = onlyArc(drawWith(frameWithOvercrowd([0, meter])))
      expect(arc.endAngle - arc.startAngle, `meter ${meter} draws the floor`).toBeCloseTo(
        floorTurn * Math.PI * 2,
        9,
      )
    }
    // ...and it is a FLOOR rather than a clamp: one unit above it is
    // proportional again, so `sweep = RING_MIN_SWEEP` outright is separable.
    const above = onlyArc(drawWith(frameWithOvercrowd([0, RING_MIN_SWEEP + 1])))
    expect(above.endAngle - above.startAngle).toBeCloseTo(((RING_MIN_SWEEP + 1) / 255) * Math.PI * 2, 9)
    // The gate is untouched: zero still draws nothing, on the same fixture.
    expect(arcs(drawWith(frameWithOvercrowd([0, 0]))).length, 'the gate still gates').toBe(0)
  })

  it('is not vacuous: the unfloored first byte really is a dot, and the floored one is a mark', () => {
    // **The floor is a legibility claim, so it is asserted in CSS pixels of
    // painted arc rather than in meter units.** `arcLen = radius * sweep`, and
    // the thing it has to beat is the ring's own stroke width — an arc shorter
    // than its pen is a round cap and nothing else.
    //
    // Measured across the three tile sizes `fitCamera` produces. `ringWidth` and
    // `RING_RADIUS_FRACTION` are read from the source; the arc lengths are not.
    for (const [tile, unflooredPx, flooredPx] of [
      [27, 1.24, 9.9],
      [29, 1.33, 10.63],
      [30, 1.37, 11.0],
    ] as const) {
      const radius = 3 * tile * RING_RADIUS_FRACTION
      const stroke = ringWidth(tile)
      const unfloored = radius * (1 / 255) * Math.PI * 2
      const floored = radius * (RING_MIN_SWEEP / 255) * Math.PI * 2
      expect(unfloored, `tile ${tile} unfloored`).toBeCloseTo(unflooredPx, 2)
      expect(floored, `tile ${tile} floored`).toBeCloseTo(flooredPx, 2)
      // The two sides of the legibility line, and neither is close to it.
      expect(unfloored, `tile ${tile}: the first byte was shorter than its pen`).toBeLessThan(stroke / 2)
      expect(floored, `tile ${tile}: the floor must clear twice the pen`).toBeGreaterThan(2 * stroke)
    }
  })
})

describe('the shutdown screen', () => {
  it('draws the scrim over the whole board and never into the HUD band', () => {
    // **Unit: CSS px, snapped by `deviceEdge`** — `Math.round(cssValue * dpr) /
    // dpr`, which divides back into CSS — which is what every other geometry
    // assertion in this file is in.
    //
    // **`hudTop` is the top edge of the BOTTOM band.** `camera.ts` computes it
    // as `max(originY + gridHeight, cssH - bottomInset - HUD_BAND_CSS)`, so the
    // board is `[originY, hudTop)` and the HUD is BELOW it. A rect starting at
    // `hudTop + hudHeight` covers zero board pixels.
    const camera = cameraB()
    const scrim = scrimFill(drawWith(gameOverFrame({ camera })))
    const gridBottom = camera.originY + camera.rows * camera.tileSize
    expect(scrim.y, 'the scrim starts at or above the board top').toBeLessThanOrEqual(camera.originY)
    expect(scrim.y + scrim.h, 'the scrim covers the board bottom').toBeGreaterThanOrEqual(gridBottom)
    expect(scrim.y + scrim.h, 'the scrim must not run into the HUD band').toBeLessThanOrEqual(
      camera.hudTop,
    )
    // Non-vacuous: on this camera the three bounds are genuinely different
    // numbers, so a rect satisfying all three is not satisfying one of them
    // three times.
    expect(camera.originY).toBe(B_ORIGIN_Y)
    expect(gridBottom).toBe(456)
    expect(camera.hudTop).toBe(B_HUD_TOP)
  })

  it('scrims every board corner and no HUD rect', () => {
    // The rect assertion above is satisfiable by a rect of the right EXTENT in
    // the wrong place on x. Point probes close that, and they are the idiom
    // this file already uses for the playfield fill.
    const camera = cameraB()
    const scrim = scrimFill(drawWith(gameOverFrame({ camera })))
    for (const [gx, gy] of fourBoardCorners(camera)) {
      expect(rectCoversGridCell(scrim, gx, gy), `corner ${gx},${gy}`).toBe(true)
    }
    const rects = hudRects(camera, createHudRects())
    for (const name of ['clock', 'score', 'tiles'] as const) {
      expect(rectsOverlap(scrim, rects[name]), `${name} must stay legible`).toBe(false)
    }
    // Non-vacuous on `rectsOverlap` itself: it MUST report true for something,
    // or "no HUD rect overlaps" is a predicate that never fires.
    expect(rectsOverlap(scrim, { x: 0, y: 0, w: 10, h: 10 })).toBe(true)
  })

  it('names the score on the SHUTDOWN screen, not merely somewhere on the frame', () => {
    // `drawHud` is the last statement before this phase and draws
    // `scoreText(frame.score)` = "47 TRIPS" UNCONDITIONALLY. So
    // `expect(texts).toContain('47 TRIPS')` over the whole frame is a
    // 0-DETECTOR: measured, it passes on a game-over frame whose shutdown phase
    // draws nothing at all, and it passes identically on a live frame. The
    // scrim is the phase boundary, so slice after it.
    const log = drawWith(gameOverFrame({ score: 47 }))
    expect(shutdownTexts(log)).toContain('47 TRIPS')
    // Vacuity, and the half that makes the slice mean something: the HUD's own
    // copy is always at a LOWER index, so there must be exactly two.
    expect(log.filter((c) => c.op === 'fillText' && c.text === '47 TRIPS').length).toBe(2)
  })

  it('names the destination that shut the city down, as a whole line', () => {
    // Fixture B's destination 0 reads `destReachable[0] = 1` — a car CAN get
    // there — so this is the CONNECTED-BUT-NOT-SERVED-ENOUGH arm.
    expect(shutdownTexts(drawWith(gameOverFrame({ failedDest: 0 })))).toContain(
      'DESTINATION 0 WENT UNSERVED',
    )
    // The index is what varies, so vary it — a fixture on one value cannot tell
    // the label apart from a constant string, and the memo makes a stale cache
    // the likeliest way to get one. Destination 1 reads `destReachable[1] = 0`,
    // so this also crosses to the other arm.
    expect(shutdownTexts(drawWith(gameOverFrame({ failedDest: 1, destCount: 2 })))).toContain(
      'NOTHING CAN REACH DESTINATION 1',
    )
  })

  it('never says OVERCROWDED, because the destination that dies receives too FEW cars', () => {
    // **The word this screen must not use.** "Overcrowded" describes too much
    // traffic; measured on both shipped boards the destination that ends the
    // run has ZERO draining frames — it is never served at all — so a player
    // who reads it draws fewer roads, which is the opposite of the fix. The
    // assertion is on the whole shutdown phase rather than on one line, so a
    // future fourth line cannot quietly reintroduce it.
    for (const d of [0, 1]) {
      for (const line of shutdownTexts(drawWith(gameOverFrame({ failedDest: d, destCount: 2 })))) {
        expect(line, `"${line}" tells the player the roads were too busy`).not.toContain('CROWD')
      }
    }
  })

  it('splits the line on whether anything can REACH the destination, both arms on one fixture', () => {
    // The two arms want different remedies — "connect it" against "serve it
    // faster" — so the fixture puts one destination on each side of the
    // predicate and flips only the index between the two draws. Both arms are
    // reachable on the boards that ship: every starting-city carpark is bare,
    // and the demo board's killer is on the network and still receives nothing.
    const frame = frameB()
    expect(frame.destReachable[0] as number, 'dest 0 IS reachable').toBe(1)
    expect(frame.destReachable[1] as number, 'dest 1 is NOT').toBe(0)
    expect(shutdownTexts(drawWith(gameOverFrame({ failedDest: 0, destCount: 2 })))).toContain(
      'DESTINATION 0 WENT UNSERVED',
    )
    expect(shutdownTexts(drawWith(gameOverFrame({ failedDest: 1, destCount: 2 })))).toContain(
      'NOTHING CAN REACH DESTINATION 1',
    )
    // ...and the arm follows the FOLD, not the index: set dest 1's byte and the
    // same index crosses over.
    const connected = {
      ...gameOverFrame({ failedDest: 1, destCount: 2 }),
      destReachable: new Uint8Array([1, 1]),
    }
    expect(shutdownTexts(drawWith(connected))).toContain('DESTINATION 1 WENT UNSERVED')
  })

  it('says a road bit is not a connection: a paved but unreachable bay still gets the REACH line', () => {
    // **The user's report, at the sentence rather than at the colour.** Until
    // M1f this arm was `roads[carpark] === 0`, so one tile laid on the bay
    // flipped the shutdown screen from "connect it" to "serve it faster" while
    // the destination still took zero cars — the exact opposite of the advice
    // the player needed. The road bit is present here and the fold says no.
    const stubbed = gameOverFrame({ failedDest: 1, destCount: 2 })
    stubbed.roads[stubbed.destCarpark[1] as number] = 4
    expect(stubbed.destReachable[1] as number).toBe(0)
    expect(shutdownTexts(drawWith(stubbed))).toContain('NOTHING CAN REACH DESTINATION 1')
  })

  it('ignores a LIVE-looking byte in a dead slot — the index guard, with teeth', () => {
    // The fail-closed index guard needs a fixture where the two answers differ,
    // and `destReachable[9]` being `undefined` is not one: `undefined !== 1` is
    // already true, so an out-of-range read agrees with the guard by accident.
    // The board that separates them is a slot the fold has not rewritten this
    // frame — `destReachable` is preallocated for every slot and only
    // `[0, destCount)` is folded, so a dead slot holds whatever a longer prefix
    // last left in it. Here index 1 holds a stale 1 while `destCount` is 1.
    const stale = {
      ...gameOverFrame({ failedDest: 1 }),
      destReachable: new Uint8Array([1, 1]),
    }
    expect(stale.destCount, 'index 1 is outside the live prefix').toBe(1)
    expect(shutdownTexts(drawWith(stale))).toContain('NOTHING CAN REACH DESTINATION 1')
  })

  it('treats any byte that is not 1 as unreachable, so an unwritten slot reads RED', () => {
    // `!== 1` rather than `=== 0`: a `destReachable` byte the fold never wrote
    // must take the arm that overstates the problem, not the one that hides it.
    // Only a value outside {0, 1} can tell the two spellings apart, and the
    // frame type cannot forbid one — `Uint8Array` carries 0..255.
    const odd = {
      ...gameOverFrame({ failedDest: 1, destCount: 2 }),
      destReachable: new Uint8Array([1, 2]),
    }
    expect(fillsStyled(drawWith(odd), OVERCROWD).length, 'byte 2 is not a promise').toBe(1)
    expect(shutdownTexts(drawWith(odd))).toContain('NOTHING CAN REACH DESTINATION 1')
  })

  it('takes the unreachable arm for an index outside the LIVE prefix, failing closed', () => {
    // `failedDest` is -1 on a live frame and bounded above only by `destCount`.
    // The guard is what makes the answer a decision rather than an accident of
    // the sentinel: `destReachable[-1]` and `destReachable[9]` are both
    // `undefined`, which is `!== 1` and happens to agree today — so the case
    // that gives the guard teeth is the LIVE one below it, and the two are
    // asserted together on purpose.
    for (const failedDest of [-1, 1, 9]) {
      expect(
        shutdownTexts(drawWith(gameOverFrame({ failedDest }))),
        `failedDest ${failedDest} on a one-destination frame`,
      ).toContain(`NOTHING CAN REACH DESTINATION ${failedDest}`)
    }
    // Non-vacuous: index 1 crosses to the other arm the moment it is LIVE and
    // reachable, so the guard is about the prefix and not about the number 1.
    const live = {
      ...gameOverFrame({ failedDest: 1, destCount: 2 }),
      destReachable: new Uint8Array([1, 1]),
    }
    expect(shutdownTexts(drawWith(live))).toContain('DESTINATION 1 WENT UNSERVED')
  })

  it('says the verb of the game, which the failure state contained no word of', () => {
    // Before this line the shutdown screen named a building and a number and
    // left the remedy to be inferred. `startingCity.ts` measures what inference
    // produces: the road a player is most drawn to on the shipped city buys
    // zero ticks.
    const said = shutdownTexts(drawWith(gameOverFrame({ failedDest: 0 })))
    expect(said).toContain('CONNECT EVERY DESTINATION WITH A ROAD')
    // The property, not the sentence: the screen must contain the verb at all.
    expect(said.some((l) => l.includes('ROAD')), 'no line mentions a road').toBe(true)
  })

  it('tells the player how to start again', () => {
    expect(shutdownTexts(drawWith(gameOverFrame({})))).toContain('TAP TO PLAY AGAIN')
  })

  it('constrains every shutdown line with maxWidth, so none can leave the canvas', () => {
    // The same construction guarantee `fillCentred` gives the HUD, and it
    // matters more here: "DESTINATION 12 OVERCROWDED" is 26 characters and the
    // narrowest viewport `fitCamera` accepts is 320 CSS px.
    const camera = cameraB()
    const log = drawWith(gameOverFrame({ camera, failedDest: 12 }))
    const index = log.findIndex((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)
    const lines = log.slice(index + 1).filter((c): c is FillTextCommand => c.op === 'fillText')
    expect(lines.length, 'four lines: what died, what to do, the score, the way out').toBe(4)
    for (const line of lines) {
      expect(line.maxWidth, `"${line.text}" is unconstrained`).toBeGreaterThan(0)
      // **Against the INSET, not against zero, and that is what gives the inset
      // a detector.** Measured: with the bound at 0, dropping
      // `SHUTDOWN_TEXT_INSET_CSS` entirely still passes — a full-canvas-width
      // `maxWidth` centred on the canvas fits the canvas exactly. The margin is
      // the thing that has to hold on a phone with a notch, so it is the thing
      // asserted.
      expect(line.x - line.maxWidth / 2, `"${line.text}" runs off the left`).toBeGreaterThanOrEqual(
        SHUTDOWN_TEXT_INSET_CSS,
      )
      expect(line.x + line.maxWidth / 2, `"${line.text}" runs off the right`).toBeLessThanOrEqual(
        camera.cssW - SHUTDOWN_TEXT_INSET_CSS,
      )
      expect(line.textAlign, 'maxWidth only bounds a CENTRED run').toBe('center')
    }
    expect(SHUTDOWN_TEXT_INSET_CSS, 'a zero inset would make the two bounds above vacuous').toBeGreaterThan(0)
    // Four distinct baselines, so the lines do not stack on one another.
    expect(new Set(lines.map((l) => l.y)).size).toBe(4)
  })

  it('draws the shutdown text ON the scrim, in a colour that is not the scrim', () => {
    const lines = drawWith(gameOverFrame({}))
      .filter((c): c is FillTextCommand => c.op === 'fillText')
      .slice(-4)
    for (const line of lines) {
      expect(line.fillStyle, `"${line.text}" is invisible on its own scrim`).not.toBe(PALETTE.scrim)
      expect(line.fillStyle).toBe(PALETTE.land)
    }
  })

  it('draws the shutdown AFTER the HUD, so nothing the HUD draws can cover it', () => {
    const log = drawWith(gameOverFrame({}))
    const scrimIndex = log.findIndex((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)
    const lastHudText = log.map((c) => c.op).lastIndexOf('fillText')
    expect(scrimIndex).toBeGreaterThan(-1)
    expect(lastHudText, 'the last text on the frame belongs to the shutdown').toBeGreaterThan(
      scrimIndex,
    )
    // ...and the HUD really did draw first, so this is an ORDER assertion and
    // not "the HUD was skipped".
    expect(log.slice(0, scrimIndex).filter((c) => c.op === 'fillText').length).toBe(3)
  })

  it('draws the killer’s ring TWICE — once under the scrim and again over it, thicker', () => {
    // **The screen has to answer WHICH destination, and pointing at it is
    // stronger than naming it.** Under the scrim alone the ring is dimmed with
    // everything else, so "which one" was inferable only from being the biggest
    // arc on a board of eighteen buildings. Over it, the sentence and the thing
    // it names are the two bright objects on the screen.
    const log = drawWith(frameWithOvercrowd([0, 249], { gameOver: true, failedDest: 1 }))
    const scrimIndex = log.findIndex((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)
    const found = arcs(log)
    expect(found.length, 'the board pass plus the shutdown pass').toBe(2)

    const under = found[0] as ArcCommand
    const over = found[1] as ArcCommand
    expect(log.findIndex((c) => c.op === 'arc'), 'the board ring is under').toBeLessThan(scrimIndex)
    expect(log.map((c) => c.op).lastIndexOf('arc'), 'the shutdown ring is over').toBeGreaterThan(
      scrimIndex,
    )

    // Same destination, same geometry, twice the stroke — so a mutation that
    // redrew the WRONG ring, or the same one at the same weight, is separable.
    for (const arc of [under, over]) {
      expect(arc.x).toBeCloseTo(expectedCentreX(1), 5)
      expect(arc.y).toBeCloseTo(expectedCentreY(1), 5)
      expect(arc.endAngle - arc.startAngle).toBeCloseTo((249 / 255) * Math.PI * 2, 9)
    }
    expect(over.lineWidth).toBe(under.lineWidth * SHUTDOWN_RING_WIDTH_SCALE)
    expect(SHUTDOWN_RING_WIDTH_SCALE, 'a scale of 1 draws the same ring twice').toBeGreaterThan(1)
  })

  it('draws the shutdown ring for the FAILED destination, not for whichever is biggest', () => {
    // Two rings on the board, and the failed one is the SMALLER — so "the
    // shutdown pass redraws the largest arc" and "it redraws `failedDest`" are
    // separable, which they are not on a real board where the killer is at 249.
    const log = drawWith(frameWithOvercrowd([60, 200], { gameOver: true, failedDest: 0 }))
    const scrimIndex = log.findIndex((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)
    const over = arcs(log.slice(scrimIndex + 1))
    expect(over.length).toBe(1)
    const arc = over[0] as ArcCommand
    expect(arc.x).toBeCloseTo(expectedCentreX(0), 5)
    expect(arc.endAngle - arc.startAngle).toBeCloseTo((60 / 255) * Math.PI * 2, 9)
  })

  it('redraws nothing over the scrim when failedDest names no live destination', () => {
    // -1 is representable on the frame and `destCount` bounds the other end;
    // neither may index a typed array out of range and stroke a NaN arc.
    for (const failedDest of [-1, 2, 99]) {
      const log = drawWith(frameWithOvercrowd([0, 200], { gameOver: true, failedDest }))
      const scrimIndex = log.findIndex((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)
      expect(arcs(log.slice(scrimIndex + 1)).length, `failedDest ${failedDest}`).toBe(0)
      // ...and the board pass still drew its own, so this is not "nothing drew".
      expect(arcs(log).length).toBe(1)
    }
  })

  it('draws nothing of the shutdown when the run is live', () => {
    // Explicit `gameOver: false`, not an absent field. A trial scrim phase left
    // the whole render suite green precisely because the two base fixtures
    // never set the flag and `undefined` is falsy.
    const log = drawWith(liveFrame())
    expect(liveFrame().gameOver, 'the fixture must SAY false, not omit it').toBe(false)
    expect(log.some((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.scrim)).toBe(false)
    expect(log.filter((c) => c.op === 'fillText').length, 'the HUD three and no more').toBe(3)
    expect(log.some((c) => c.op === 'arc')).toBe(false)
  })

  it('keeps the five-fill tiling on a LIVE frame and adds exactly one on a dead one', () => {
    // The scrim is a sixth fill and it is deliberately NOT part of Decision 4's
    // partition — it is a translucent pass over an already-covered canvas. So
    // the partition assertion has to stay true while the run is live, and the
    // scrim has to be the only thing added when it is not.
    const live = drawWith(liveFrame()).filter((c) => c.op === 'fillRect').length
    const dead = drawWith(gameOverFrame({})).filter((c) => c.op === 'fillRect').length
    expect(dead - live, 'exactly one extra fillRect: the scrim').toBe(1)
    assertExactTiling(bands(drawWith(liveFrame())), cameraB())
  })

  it('hides the pause bars on a shutdown frame, because the clock no longer resumes anything', () => {
    // `loop.end()` sets `paused`, so a game-over frame arrives with
    // `paused: true` — and pause bars promise "tap the clock to resume" while
    // the clock now starts a NEW RUN and throws this city away. A glyph
    // offering resume in front of a destructive action is the affordance defect
    // this whole task exists to remove, not one to add.
    const camera = cameraB()
    const barW = (hudRects(camera, createHudRects()).clock.h * PAUSE_BAR_FRACTION)
    const barCount = (log: readonly Command[]): number =>
      log.filter((c) => c.op === 'fillRect' && c.fillStyle === PALETTE.uiText && c.w === barW).length

    const paused = { ...frameB(true), gameOver: false }
    expect(barCount(drawWith(paused)), 'vacuity: a paused LIVE frame draws two bars').toBe(2)
    const dead = { ...frameB(true), gameOver: true, failedDest: 0 }
    expect(dead.paused, 'vacuity: the dead frame really is paused too').toBe(true)
    expect(barCount(drawWith(dead))).toBe(0)
  })
})

describe('failedText: the fourth single-slot cache in this file', () => {
  it('re-formats when the index changes, so the cache cannot go stale', () => {
    // Staleness is the failure mode that matters: a cache that never
    // invalidates names last run's destination forever.
    //
    // **What this does NOT pin is the -2 sentinel, and saying so is the point.**
    // The sentinel would only matter on a FIRST call of `failedText(-1)`, and
    // `drawShutdown` is gated on `frame.gameOver` while `failedDest` is -1 only
    // when the run is live — so that call is unreachable through the frame.
    // Measured: swapping the sentinel to -1 scores 0 detectors across the whole
    // suite. The -1 case below is here because it is the widest key the memo
    // can be asked for, not because it reaches the sentinel; the module cache
    // has already been written by the tests above it, which is exactly why it
    // cannot.
    drawWith(gameOverFrame({ failedDest: 4 }))
    expect(shutdownTexts(drawWith(gameOverFrame({ failedDest: -1 })))).toContain(
      'NOTHING CAN REACH DESTINATION -1',
    )
    expect(shutdownTexts(drawWith(gameOverFrame({ failedDest: 0 })))).toContain(
      'DESTINATION 0 WENT UNSERVED',
    )
    expect(shutdownTexts(drawWith(gameOverFrame({ failedDest: 5 })))).toContain(
      'NOTHING CAN REACH DESTINATION 5',
    )
    // ...and back, so the cache is keyed rather than one-shot.
    expect(shutdownTexts(drawWith(gameOverFrame({ failedDest: 0 })))).toContain(
      'DESTINATION 0 WENT UNSERVED',
    )
  })

  it('is keyed on the ARM as well as the index, so the pair cannot go half-stale', () => {
    // The `unreachable` arm can flip for a fixed index, and a cache keyed on
    // the index alone would keep the old sentence forever. Same index, twice,
    // with only the fold's byte changing.
    const bare = gameOverFrame({ failedDest: 1, destCount: 2 })
    expect(shutdownTexts(drawWith(bare))).toContain('NOTHING CAN REACH DESTINATION 1')
    const connected = {
      ...gameOverFrame({ failedDest: 1, destCount: 2 }),
      destReachable: new Uint8Array([1, 1]),
    }
    expect(shutdownTexts(drawWith(connected))).toContain('DESTINATION 1 WENT UNSERVED')
    // ...and back again, so it is a cache rather than a one-way latch.
    expect(shutdownTexts(drawWith(gameOverFrame({ failedDest: 1, destCount: 2 })))).toContain(
      'NOTHING CAN REACH DESTINATION 1',
    )
  })
})

// ---------------------------------------------------------------------------
// Phase 12: §5.10's offer modal — M1f Task 8
// ---------------------------------------------------------------------------

/**
 * Fixture B with an offer up. **Every field is a knob**, because the whole point
 * of this phase is that the numbers on screen come from the frame rather than
 * from literals in `canvas.ts`, and a fixture that could not vary them could not
 * tell the two apart.
 *
 * The two card ids are **bare integer literals with a comment naming the sim
 * constant each stands for**, because `packages/render/package.json` declares no
 * dependencies at all: `import { CARD_ROAD_TILES } from '@laneways/sim'` does
 * not resolve here and never will (spec §4, `test/boundary.test.ts`). Their
 * agreement with `cards.ts` is pinned in `packages/game/test/frame.test.ts`,
 * which is the only package that can see both.
 */
const ROAD_TILES = 1 //       CARD_ROAD_TILES, pinned in game/test/frame.test.ts
const JUNCTION_UPGRADE = 7 // CARD_JUNCTION_UPGRADE, same pin

function offerFrame(
  options: {
    offerPending?: boolean
    offerA?: number
    offerB?: number
    offerGrantA?: number
    offerGrantB?: number
    offerItemsA?: number
    offerItemsB?: number
    offerPeek?: boolean
    gameOver?: boolean
    camera?: Camera
  } = {},
): RenderFrame {
  const base = frameB()
  return {
    ...base,
    camera: options.camera ?? base.camera,
    gameOver: options.gameOver ?? false,
    offerPending: options.offerPending ?? true,
    offerA: options.offerA ?? ROAD_TILES,
    offerB: options.offerB ?? JUNCTION_UPGRADE,
    offerGrantA: options.offerGrantA ?? 30,
    offerGrantB: options.offerGrantB ?? 20,
    offerItemsA: options.offerItemsA ?? 0,
    offerItemsB: options.offerItemsB ?? 2,
    offerPeek: options.offerPeek ?? false,
  }
}

/** Every string this frame drew, in draw order. */
function textsOf(log: readonly Command[]): string[] {
  return log.filter((c): c is FillTextCommand => c.op === 'fillText').map((c) => c.text)
}

/** The HUD's own score line on a frame that drew no modal — fixture B's, whatever it is. */
function scoreLine(log: readonly Command[]): string {
  const found = textsOf(log).find((t) => t.endsWith(' TRIPS'))
  expect(found, 'the HUD drew no score at all').toBeDefined()
  return found as string
}

/** How many atlas tiles this frame blitted — the board layers, in one number. */
function blitCount(log: readonly Command[]): number {
  return log.filter((c) => c.op === 'drawImage').length
}

/** Every fill in a given colour, as plain rects, in issue order. */
function fillsIn(log: readonly Command[], style: string): Rect[] {
  return log
    .filter((c): c is FillRectCommand => c.op === 'fillRect' && c.fillStyle === style)
    .map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }))
}

describe('phase 12: the offer modal', () => {
  it('draws NOTHING when no offer is pending', () => {
    // The gate, on the fixture that sets every OTHER offer field to a live
    // value — so this cannot pass because the cards happen to be blank.
    const log = drawWith(offerFrame({ offerPending: false }))
    const texts = textsOf(log)
    expect(texts).not.toContain('ROAD TILES')
    expect(texts).not.toContain(OFFER_TITLE_TEXT)
    expect(texts).not.toContain(PEEK_TEXT)
    expect(fillsIn(log, PALETTE.cardFace), 'no card face either').toEqual([])
    expect(fillsIn(log, PALETTE.scrim), 'and the board is not dimmed').toEqual([])
  })

  it('covers the whole canvas, not just the board, so the HUD cannot read as live', () => {
    // **The opposite choice from the shutdown scrim, deliberately.** That one
    // stops at the grid rect's bottom edge so the HUD keeps its contrast,
    // because the score is part of what it is telling the player. Here the HUD
    // clock is a PAUSE TOGGLE and §5.10's modal has no skip, so a legible pause
    // control under it is an invitation to press the one thing that looks like
    // a way out and is not.
    const log = drawWith(offerFrame())
    expect(fillsIn(log, PALETTE.scrim)).toEqual([{ x: 0, y: 0, w: B_CSS_W, h: B_CSS_H }])
    // Non-vacuous on the difference: the HUD band really is inside that rect
    // and really is outside the shutdown scrim's.
    const hud = hudRects(cameraB(), createHudRects())
    expect(hud.clock.y + hud.clock.h).toBeLessThanOrEqual(B_CSS_H)
    expect(hud.clock.y, 'the clock is below the board, where the shutdown scrim stops').toBeGreaterThan(
      B_ORIGIN_Y + 4 * B_TILE,
    )
  })

  it('draws both card names and both grant lines, with the numbers coming from the FRAME', () => {
    const texts = textsOf(drawWith(offerFrame()))
    expect(texts).toContain('ROAD TILES')
    expect(texts).toContain('30 TILES')
    expect(texts).toContain('JUNCTION UPGRADE')
    expect(texts).toContain('20 TILES')
    expect(texts).toContain('x2')
    expect(texts, 'and the one line that says what to do about them').toContain(OFFER_TITLE_TEXT)
  })

  it('follows the frame when the grants change, which a string literal could not', () => {
    // **Review finding I6's sharp half.** If `'30 TILES'` were a literal in
    // `canvas.ts`, changing `CARD_GRANT_ROAD_TILES` to 40 would leave every
    // test in both packages green while the modal told the player 30.
    const texts = textsOf(drawWith(offerFrame({ offerGrantA: 40, offerGrantB: 55 })))
    expect(texts).toContain('40 TILES')
    expect(texts).toContain('55 TILES')
    expect(texts).not.toContain('30 TILES')
    expect(texts).not.toContain('20 TILES')
  })

  it('keeps the two grant memos apart, so the second card does not print the first card’s number', () => {
    // **A single shared memo slot would MISS on every call** — the two grants
    // differ on the shipped pair — and would still produce the right strings,
    // so no assertion above can see it. What a shared slot CANNOT survive is
    // this: draw a frame, then draw a second frame that changes only slot B,
    // and check slot A's line is still A's. With one slot, the cache is
    // rebuilt each time and the output is still correct; with one slot keyed
    // per CARD, it is not. The real failure a shared slot would produce is a
    // per-frame re-format, which no recorded text can distinguish — so this
    // test pins the observable half and the module comment owns the rest.
    const first = textsOf(drawWith(offerFrame()))
    expect(first).toContain('30 TILES')
    expect(first).toContain('20 TILES')
    const second = textsOf(drawWith(offerFrame({ offerGrantB: 20 })))
    expect(second.filter((t) => t === '30 TILES').length, 'A still reads 30').toBe(1)
    expect(second.filter((t) => t === '20 TILES').length, 'and B still reads 20').toBe(1)
  })

  it('draws the item badge only when the card grants items, so a tiles card shows no x0', () => {
    const texts = textsOf(drawWith(offerFrame({ offerItemsA: 0, offerItemsB: 2 })))
    expect(texts.filter((t) => t.startsWith('x')), 'exactly one badge, B’s').toEqual(['x2'])
    // ...and it follows the number rather than the slot.
    expect(textsOf(drawWith(offerFrame({ offerItemsA: 3, offerItemsB: 0 })))).toContain('x3')
    expect(textsOf(drawWith(offerFrame({ offerItemsA: 3, offerItemsB: 0 })))).not.toContain('x0')
  })

  it('draws the two faces at exactly the rects offerRects reports, so the hit test cannot drift', () => {
    // `game/pointer.ts` hit-tests the SAME function. If the draw used its own
    // arithmetic the player would tap a card and miss, or miss a card and tap
    // it — the class of bug neither package's own tests can see.
    const rects = offerRects(cameraB(), createOfferRects())
    const faces = fillsIn(drawWith(offerFrame()), PALETTE.cardFace)
    expect(faces).toEqual([
      { x: rects.cardA.x, y: rects.cardA.y, w: rects.cardA.w, h: rects.cardA.h },
      { x: rects.cardB.x, y: rects.cardB.y, w: rects.cardB.w, h: rects.cardB.h },
    ])
    // Non-vacuous: the two rects are genuinely different and genuinely non-empty
    // on this camera, so `toEqual` on the pair is not two copies of one number.
    expect(rects.cardA.y).not.toBe(rects.cardB.y)
    expect(rects.cardA.h).toBeGreaterThan(0)
  })

  it('puts the peek control on its own rect, in both states, with only the label changing', () => {
    const rects = offerRects(cameraB(), createOfferRects())
    const expected = { x: rects.peek.x, y: rects.peek.y, w: rects.peek.w, h: rects.peek.h }
    expect(fillsIn(drawWith(offerFrame()), PALETTE.cardAccent)).toEqual([expected])
    expect(fillsIn(drawWith(offerFrame({ offerPeek: true })), PALETTE.cardAccent)).toEqual([expected])
  })

  it('suppresses the chrome and keeps the scrim off while peeking', () => {
    // Plan Decision 16: peek shows the FROZEN BOARD, so a dimmed peek would be
    // a peek at nothing. The loop stays paused — that is `pointer.ts`'s half,
    // and `pointer.test.ts` owns it.
    const log = drawWith(offerFrame({ offerPeek: true }))
    const texts = textsOf(log)
    expect(texts).not.toContain('ROAD TILES')
    expect(texts).not.toContain('JUNCTION UPGRADE')
    expect(texts).not.toContain(OFFER_TITLE_TEXT)
    expect(fillsIn(log, PALETTE.scrim), 'the board is visible').toEqual([])
    expect(fillsIn(log, PALETTE.cardFace), 'and no card is in the way').toEqual([])
    expect(texts, 'and the way back is still on screen').toContain(PEEK_RETURN_TEXT)
    expect(texts, 'which is not the same label as the way IN').not.toContain(PEEK_TEXT)
  })

  it('draws the board underneath while peeking — the whole point of the control', () => {
    // A peek that suppressed the board as well as the chrome would be a blank
    // screen with one button on it. The board layers are phases 1-10 and run
    // whatever this phase does; asserted rather than assumed, because "the
    // modal draws nothing" and "the frame draws nothing" are the same log.
    const peeking = drawWith(offerFrame({ offerPeek: true }))
    const plain = drawWith(offerFrame({ offerPending: false }))
    expect(blitCount(peeking), 'the road layer still blitted').toBe(blitCount(plain))
    expect(textsOf(peeking), 'and the HUD is still readable').toContain(scoreLine(plain))
  })

  it('is not drawn at all on a DEAD board, because the tap there restarts the run', () => {
    // **A reachable state, and the first draft of this file said it was not.**
    // The argument was that `step` freezes past the failure so no boundary can
    // be crossed on a dead board. True, and pointing the wrong way: the
    // boundary is crossed BEFORE the death with the offer unresolved, and then
    // the death freezes `offerPending` true forever, because `H_OFFER_WEEK` can
    // never catch up on a state that does not advance.
    // `game/test/drawAllocation.test.ts`'s already-dead rig is exactly that
    // board, and it is what caught this — as two scrims a frame.
    //
    // The shutdown wins because `game/pointer.ts` puts its game-over branch
    // ABOVE its modal branch: a tap on that screen restarts the run, so a modal
    // over it would be asking a question the next tap does not answer. Draw
    // order and tap order have to agree.
    const log = drawWith(offerFrame({ gameOver: true }))
    const texts = textsOf(log)
    expect(fillsIn(log, PALETTE.scrim).length, 'one scrim, the shutdown’s').toBe(1)
    expect(fillsIn(log, PALETTE.cardFace), 'and no card').toEqual([])
    expect(texts).not.toContain('ROAD TILES')
    expect(texts).not.toContain(OFFER_TITLE_TEXT)
    expect(texts).not.toContain(PEEK_TEXT)
    // Non-vacuous on both halves: the shutdown really drew, and the same frame
    // without `gameOver` really does draw the modal.
    expect(texts, 'the screen the player actually gets').toContain(RESTART_TEXT)
    expect(textsOf(drawWith(offerFrame({ gameOver: false })))).toContain('ROAD TILES')
  })

  it('is not drawn while peeking on a dead board either, so peek cannot outlive the run', () => {
    const log = drawWith(offerFrame({ gameOver: true, offerPeek: true }))
    expect(textsOf(log)).not.toContain(PEEK_RETURN_TEXT)
    expect(fillsIn(log, PALETTE.cardAccent)).toEqual([])
    expect(textsOf(log)).toContain(RESTART_TEXT)
  })

  it('has one label per card id, so an eighth card fails here rather than drawing undefined', () => {
    // 8 is `CARD_COUNT`, pinned against this number in game/test/frame.test.ts.
    // Bare literal because this package cannot import it.
    expect(CARD_LABEL_COUNT).toBe(8)
    expect(CARD_LABELS[0], 'id 0 is CARD_NONE and is never drawn').toBe('')
  })

  it('draws an empty card rather than the word undefined for an id it has no label for', () => {
    // The fallback is not decoration: `fillStyle = undefined` is silently
    // ignored by a real context, and `fillText(undefined)` paints the literal
    // string "undefined" across a card. An id past the table means the two
    // packages have already disagreed; `render` cannot detect that and can
    // decline to print the JavaScript for it.
    const texts = textsOf(drawWith(offerFrame({ offerA: 99 })))
    expect(texts).not.toContain('undefined')
    expect(texts, 'B is unaffected').toContain('JUNCTION UPGRADE')
  })

  it('condenses every run inside its own rect rather than letting it leave the card', () => {
    // The same construction guarantee `fillCentred` gives the HUD: with
    // `textAlign = 'center'` the canvas spec puts the run in
    // `[cx - maxWidth/2, cx + maxWidth/2]`, so containment is recorded rather
    // than measured — there is no font engine anywhere in this workspace.
    const rects = offerRects(cameraB(), createOfferRects())
    const runs = drawWith(offerFrame()).filter((c): c is FillTextCommand => c.op === 'fillText')
    for (const run of runs) {
      expect(run.maxWidth, `"${run.text}" has no maxWidth`).toBeGreaterThan(0)
    }
    const onCardA = runs.filter((c) => c.text === 'ROAD TILES' || c.text === '30 TILES')
    expect(onCardA.length).toBe(2)
    for (const run of onCardA) {
      expect(run.x - run.maxWidth / 2).toBeGreaterThanOrEqual(rects.cardA.x)
      expect(run.x + run.maxWidth / 2).toBeLessThanOrEqual(rects.cardA.x + rects.cardA.w)
      expect(run.y).toBeGreaterThan(rects.cardA.y)
      expect(run.y).toBeLessThan(rects.cardA.y + rects.cardA.h)
    }
  })
})
