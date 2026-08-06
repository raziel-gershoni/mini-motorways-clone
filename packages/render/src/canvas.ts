import { atlasSourceX, atlasSourceY, type Atlas, type AtlasSurface } from './atlas'
import { createHudRects, gridToScreenX, gridToScreenY, hudRects } from './camera'
import { TerrainClass } from './types'
import type { Camera, HudRects, Palette, Rect, RenderFrame } from './types'

/**
 * `drawFrame` — the whole per-frame draw path, and the only function in this
 * package that runs 60 or 120 times a second.
 *
 * **It reads `frame` and nothing else.** No globals, no `sim`, no `shared`, no
 * clock, no `devicePixelRatio`. Every function that lives in `sim` —
 * `routeStep`, `carparkCell`, `weekOfTick`, the terrain fold — was called in
 * `game` before the frame was handed over (plan Decision 3), which is what makes
 * this file testable with hand-built arrays and no simulation at all.
 *
 * **There is no notion of interpolation alpha anywhere in `render`.** A car's
 * position arrives as two floats in grid-cell units, already resolved and
 * already lerped; drawing it is one multiply.
 *
 * ## Three rules this file exists to keep
 *
 * **1. No `clearRect`, ever** (plan Decision 4). Three opaque fills cover the
 * canvas exactly once — the top band, the grid land band, the HUD band — and
 * everything else draws on top. A `clearRect` plus a land fill covers it twice;
 * at M2's regime on the M0 device that is a wasted full-canvas pass of
 * **1,412,880 device px, ~0.141 ms — more than the entire road layer costs**.
 * The rule this creates is unforgiving: *every* pixel of the canvas must be
 * covered by one of those three fills each frame, or the previous frame ghosts.
 * `DrawContext` below deliberately does not declare `clearRect`, so reaching for
 * it is a type error as well as a test failure.
 *
 * **2. Nothing allocates here.** No array literal, no object literal, no closure,
 * no string concatenation. The two places that would have — `hudRects`'s output
 * and the HUD's four formatted numbers — are a module-level scratch object and a
 * value-keyed text cache respectively. There is no allocation profiler in this
 * toolchain and this file does not pretend otherwise: a Task 3 reviewer
 * reinstated an allocation and watched all 82 tests pass. Review is the only
 * check, so the rule is written where the code is.
 *
 * **3. The draw order is load-bearing, not cosmetic.** Buildings draw above
 * roads because a road is legal on a house cell and on a carpark cell and would
 * otherwise cover them; cars draw above buildings because a car drives *onto*
 * the carpark. The order is asserted in `test/canvas.test.ts` as a chain of
 * strict inequalities over the recorded log, which is the only form that
 * survives an art change.
 *
 * ## The inherited hazard, stated at the signature
 *
 * `drawFrame(ctx, frame, atlas, palette)` reads as though `palette` governed
 * every colour on screen. It does not govern the roads: **the atlas bakes its
 * stroke colour in at build time and a blit cannot re-tint its source**, so a
 * palette change without an atlas rebuild leaves every road in the previous
 * theme while everything else follows — a failure that reads as a rendering bug
 * rather than a caching one. Task 4 put the baked palette on `Atlas` so the
 * mismatch is *detectable*; `assertAtlasPalette` below is what makes it *loud*.
 */

/**
 * What `drawImage` accepts. The union is not decoration: a real
 * `CanvasRenderingContext2D.drawImage` takes `CanvasImageSource`, and
 * `AtlasSurface` is not assignable to that type in either direction, so a
 * parameter typed as `AtlasSurface` alone makes `CanvasRenderingContext2D`
 * fail to satisfy `DrawContext` even with method syntax. Verified by running
 * `tsc` on both forms — see `_RealContextIsADrawContext` at the bottom of this
 * file, and the report's §9 note that Task 4's guidance here was wrong.
 */
export type DrawImageSource = AtlasSurface | CanvasImageSource

/**
 * The slice of `CanvasRenderingContext2D` the draw path uses, and nothing more.
 * A real 2D context satisfies it structurally, which is what lets tests pass a
 * recorder and production pass a canvas with no branch between them (plan
 * Decision 8).
 *
 * **`clearRect` is deliberately absent** — see rule 1 above. The test recorder
 * implements it anyway, so the mutation that calls it still executes and dies on
 * an assertion rather than on a missing method, which a mutation battery must
 * never confuse.
 *
 * `drawImage` is declared with **method syntax**, not as a property holding an
 * arrow type: TypeScript method parameters are bivariant and property ones are
 * contravariant under `strictFunctionTypes`, and only the bivariant form lets a
 * real context satisfy this interface.
 */
export interface DrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  fillRect(x: number, y: number, w: number, h: number): void
  /**
   * `maxWidth` is **required here though the DOM makes it optional**, so that a
   * caller cannot draw an unconstrained label by omission. See `fillCentred`:
   * it is what turns "the text fits its HUD rect" from a device-dependent risk
   * into a construction guarantee. A real `CanvasRenderingContext2D` satisfies
   * both forms — pinned below.
   */
  fillText(text: string, x: number, y: number, maxWidth: number): void
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
  ): void
}

// --- the art constants, all fractions of the tile ---------------------------
//
// Fractions rather than pixels, because the tile is 27, 29 or 30 CSS px
// depending on the viewport (Task 3) and every sprite has to follow it. The art
// pass owns the numbers; it does not own the rule that they are relative.

/** A tree is drawn INSET, so the land band shows around it — it is not a terrain tile. */
export const TREE_INSET_FRACTION = 0.25
export const TREE_SIZE_FRACTION = 0.5
export const HOUSE_INSET_FRACTION = 1 / 6
export const HOUSE_SIZE_FRACTION = 2 / 3
export const CARPARK_INSET_FRACTION = 0.25
export const CARPARK_SIZE_FRACTION = 0.5
/** A car is half a tile, centred on its resolved position. */
export const CAR_SIZE_FRACTION = 0.5
export const PIN_SIZE_FRACTION = 1 / 6
export const PIN_STRIDE_FRACTION = 1 / 3

/**
 * The most waiting customers a destination draws pins for.
 *
 * Six pins at a `1/3`-tile stride starting `1/6` of a tile in ends exactly two
 * tiles along, which is the narrow footprint's full width. The sim's pin count
 * has no upper bound, so without the cap a busy destination draws a row of pins
 * across the whole board.
 */
export const MAX_DRAWN_PINS = 6

/** A pause bar's width, as a fraction of the clock rect's height. */
export const PAUSE_BAR_FRACTION = 1 / 8

/**
 * How many bar-widths of the clock rect the pause indicator reserves before the
 * clock text starts. Four is the bars themselves (`[1·barW, 4·barW]`); the fifth
 * is the gap between the indicator and the text.
 */
export const PAUSE_GUTTER_BARS = 5

/**
 * A preallocated font string. Fixed at 20 CSS px rather than derived from the
 * tile size, because a computed font string (`\`${size}px …\``) is an allocation
 * in the frame loop and the HUD band is a fixed 72 CSS px on every viewport M2
 * targets.
 */
export const HUD_FONT = '600 20px system-ui, -apple-system, sans-serif'

/**
 * `sim/buildings.ts`'s orientation numbering, N and S only — the two values that
 * select the 2x3 footprint box rather than the 3x2 one.
 *
 * **A deliberate second copy**, for the same reason `ROAD_DIR_DX` is one: spec
 * §4 forbids `render` importing `sim`, and `test/boundary.test.ts` enforces it.
 * Unlike a copied constant with no reader, this one has a watcher in the one
 * package allowed to see both sides: **`packages/game/test/renderFootprint.test.ts`**
 * compares `destFootprintW`/`destFootprintH` against `sim`'s own exported
 * `isFootprintCell`, cell by cell, for all four orientations.
 * (`renderDirections.test.ts` is the *direction table*'s watcher and says
 * nothing about footprints — a reader sent there concludes this copy is
 * unwatched.)
 */
export const DEST_ORIENTATION_N = 0
export const DEST_ORIENTATION_S = 2

/** Footprint width in cells: 2 for N/S, 3 for E/W. See `DEST_ORIENTATION_N`. */
export function destFootprintW(orientation: number): number {
  return orientation === DEST_ORIENTATION_N || orientation === DEST_ORIENTATION_S ? 2 : 3
}

/** Footprint height in cells: 3 for N/S, 2 for E/W. See `DEST_ORIENTATION_N`. */
export function destFootprintH(orientation: number): number {
  return orientation === DEST_ORIENTATION_N || orientation === DEST_ORIENTATION_S ? 3 : 2
}

// --- module-level scratch, allocated once at load ---------------------------

/**
 * `hudRects` writes into a caller-owned object and returns it, precisely so the
 * frame loop does not allocate one per frame (Task 3). This is that object.
 *
 * Module-level mutable state is legal in `render` and `game` by design — the
 * `determinism/no-module-mutable-state` rule applies to `sim` and `shared` only
 * (plan Task 1), because both the atlas cache Decision 4 requires and the action
 * pool Decision 9 requires are module-level state.
 */
const HUD_SCRATCH: HudRects = createHudRects()

/**
 * The HUD's formatted numbers, memoised on the values that produced them.
 *
 * `'W' + week` allocates a string, and the HUD formats four numbers per frame —
 * 240 allocations a second at 60 Hz, in the one loop the zero-allocation rule
 * exists for. Memoising makes that "on change" instead: the score moves a few
 * times a minute, the day every 643 ticks, the tile count only when the player
 * draws.
 *
 * **What is and is not testable about this, said plainly.** The saving is not
 * observable — JavaScript strings are values, so two equal strings are
 * indistinguishable no matter how many were allocated, and this toolchain has no
 * allocation profiler. The *staleness* is observable, and it is the failure mode
 * that matters: a cache that never invalidates draws last week's score forever.
 * `test/canvas.test.ts` changes every value between two frames and asserts the
 * text follows, then changes them back.
 */
let cachedWeek = -1
let cachedDay = -1
let cachedClockText = ''
let cachedScore = -1
let cachedScoreText = ''
let cachedTiles = -1
let cachedTilesText = ''

function clockText(week: number, day: number): string {
  if (week !== cachedWeek || day !== cachedDay) {
    cachedWeek = week
    cachedDay = day
    cachedClockText = `W${week} D${day}`
  }
  return cachedClockText
}

function scoreText(score: number): string {
  if (score !== cachedScore) {
    cachedScore = score
    cachedScoreText = `${score} TRIPS`
  }
  return cachedScoreText
}

function tilesText(tilesLeft: number): string {
  if (tilesLeft !== cachedTiles) {
    cachedTiles = tilesLeft
    cachedTilesText = `${tilesLeft} TILES`
  }
  return cachedTilesText
}

// ---------------------------------------------------------------------------

/**
 * Draws one frame. Nine phases, in this order, and the order is load-bearing:
 *
 * ```
 * 1 top band fill      2 grid land fill    3 non-land terrain
 * 4 roads              5 destinations      6 houses
 * 7 cars               8 HUD band fill     9 HUD content
 * ```
 *
 * **The three fills are three full-width horizontal bands, and that is forced
 * rather than chosen.** Plan Decision 4 requires the three to cover the canvas
 * *exactly once* — its own frame model charges them at 1,412,880 device px,
 * which is the M0 device's entire backing store — and three rectangles can
 * partition a rectangle only as three bands. The consequence, stated rather than
 * discovered: the horizontal letterbox beside the grid rect (6 CSS px a side on
 * a 390 px viewport, 0 on the M0 device) and the vertical gap between the grid
 * rect and the HUD band are painted in the **land** colour rather than the
 * background one. Task 3's "the leftover is background" describes the fit, not
 * the fill; making it literally true costs either five fills or an overlap, and
 * an overlap is the thing Decision 4 struck out.
 *
 * **The band edges are snapped to whole device pixels, and that is a fix for a
 * real ghosting seam rather than tidiness.** `fitCamera` works in integer CSS
 * px, but `DPR_CAP_LOW` is **1.5**, so an odd CSS edge lands on a *half* device
 * pixel. `Pixel 412x915, insets 24/24, LOW` — integer inputs, a real device
 * shape — gives `hudTop = 819` and `819 x 1.5 = 1228.5`. The device row at
 * 1228 is then covered by two source-over passes at alpha 0.5 rather than one
 * opaque pass, so it keeps **25% of the previous frame**: exactly the ghosting
 * Decision 4's "every pixel of the canvas must be covered" exists to prevent,
 * on the class of device the DPR cap was written for. `deviceEdge` below rounds
 * each cut to a whole device pixel before dividing back into CSS.
 *
 * Only the three OPAQUE BAND EDGES are snapped. Cell boundaries are not: at a
 * 29 px tile and DPR 1.5 a cell is 43.5 device px, and that resample is Task
 * 3's stated, accepted trade. It is a softness, not a coverage hole — the bands
 * underneath are opaque and complete.
 *
 * Everything on the board is culled to the revealed rect: terrain and roads by
 * iterating it, buildings and cars by testing their anchor cell against it. A
 * building whose anchor is outside is not drawn at all, even if its footprint
 * would reach inside — correct for M2, where the rect is frozen and Task 2's
 * seed places every building well within it, and the thing M1d must revisit when
 * the rect becomes dynamic (the fix then is a `clip` around phases 3-7, which
 * would also stop a partially-visible building painting into the HUD band).
 *
 * **Cars are culled by their own position and not by anything the buildings do,
 * and a car in the rect's last column or row paints up to `tileSize / 4` CSS px
 * into the letterbox.** That is correct — the letterbox is part of band 2, and
 * the sprite is centred on a position the sim genuinely put at the edge — and
 * the reason it never reaches the HUD is the **draw order**: the HUD band is
 * phase 8 and cars are phase 7, so the band paints over anything that spilled.
 * Not anchor culling, which is the buildings' protection and not the cars'.
 */
export function drawFrame(
  ctx: DrawContext,
  frame: RenderFrame,
  atlas: Atlas,
  palette: Palette,
): void {
  assertAtlasPalette(atlas, palette)

  const camera = frame.camera
  const dpr = camera.dpr
  // The canvas's own extent in CSS px, as the backing store will actually be
  // sized: `round(css * dpr)` device px. Task 8 MUST size the canvas with the
  // same rounding, or the last device row/column is outside every band.
  const right = deviceEdge(camera.cssW, dpr)
  const bottom = deviceEdge(camera.cssH, dpr)
  // Clamped into `[0, bottom]` and kept monotone, so the three bands tile the
  // ON-CANVAS area for every viewport including the degenerate ones `fitCamera`
  // clamps for: at `cssH = 0` the plain formula gives `originY = -41` and a
  // negative-height fill, which the canvas normalises but which is a wasted
  // call and a geometry no test should have to reason about.
  const gridTop = clamp(deviceEdge(camera.originY, dpr), 0, bottom)
  const bandTop = clamp(deviceEdge(camera.hudTop, dpr), gridTop, bottom)

  // 1. The top band: the canvas top down to the grid rect's top edge.
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, right, gridTop)

  // 2. The grid land band: down to the HUD band's top edge.
  ctx.fillStyle = palette.land
  ctx.fillRect(0, gridTop, right, bandTop - gridTop)

  drawTerrain(ctx, frame, palette)
  drawRoads(ctx, frame, atlas)
  drawDestinations(ctx, frame, palette)
  drawHouses(ctx, frame, palette)
  drawCars(ctx, frame, palette)

  // 8. The HUD band: down to the canvas BOTTOM, not merely to the band's own
  // height. The bottom safe-area inset lives under the band, and a fill that
  // stops at `hudTop + hudHeight` leaves it holding the previous frame forever
  // — there is no clearRect coming to fix it.
  ctx.fillStyle = palette.background
  ctx.fillRect(0, bandTop, right, bottom - bandTop)

  drawHud(ctx, frame, palette)
}

/**
 * A CSS coordinate moved to the nearest whole **device** pixel and expressed
 * back in CSS px. The identity on any edge that is already integral in device
 * space, which is every edge at the universal DPR-2 cap with an integer CSS
 * camera — so this changes nothing on the M0 device and everything at 1.5.
 */
function deviceEdge(cssValue: number, dpr: number): number {
  return Math.round(cssValue * dpr) / dpr
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

/**
 * Phase 3. Only non-LAND cells paint: the land band has already covered every
 * cell in the land colour, and painting it a second time per cell is exactly the
 * double coverage Decision 4 removed the `clearRect` to avoid.
 *
 * Water and mountain fill the whole cell — they are terrain. A tree is drawn
 * INSET, so the land shows around it: a tree is a thing standing on land, and a
 * cell-filling green square reads as a different terrain type.
 *
 * An unrecognised class draws nothing, rather than falling through to a colour.
 * The alternative — a default arm — turns a `game`-side fold bug into a board
 * painted in the wrong terrain with nothing to notice.
 */
function drawTerrain(ctx: DrawContext, frame: RenderFrame, palette: Palette): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const treeInset = tile * TREE_INSET_FRACTION
  const treeSize = tile * TREE_SIZE_FRACTION
  const yEnd = camera.y0 + camera.rows
  const xEnd = camera.x0 + camera.cols

  for (let y = camera.y0; y < yEnd; y++) {
    const rowBase = y * frame.gridW
    const py = gridToScreenY(camera, y)
    for (let x = camera.x0; x < xEnd; x++) {
      const terrain = frame.terrainClass[rowBase + x] as number
      if (terrain === TerrainClass.LAND) continue
      const px = gridToScreenX(camera, x)
      if (terrain === TerrainClass.WATER) {
        ctx.fillStyle = palette.water
        ctx.fillRect(px, py, tile, tile)
      } else if (terrain === TerrainClass.MOUNTAIN) {
        ctx.fillStyle = palette.mountain
        ctx.fillRect(px, py, tile, tile)
      } else if (terrain === TerrainClass.TREE) {
        ctx.fillStyle = palette.tree
        ctx.fillRect(px + treeInset, py + treeInset, treeSize, treeSize)
      }
    }
  }
}

/**
 * Phase 4. One `drawImage` per road cell, from that mask's own tile of the
 * 256-entry atlas — the whole reason the atlas exists (plan Decision 4: 139
 * blits, ~0.069 ms at M2's regime, against a path-stroke per cell).
 *
 * The source rect is in **device** px (`atlas.tileDevicePx`) and the destination
 * rect in **CSS** px (`camera.tileSize`); at the DPR-2 cap the two differ by
 * exactly the ratio, and swapping them draws every road at half or double size.
 *
 * Mask 0 is never blitted. `state.roads` uses 0 for "no road", and tile 0 is a
 * blank that exists only so the mask indexes the atlas grid directly.
 */
function drawRoads(ctx: DrawContext, frame: RenderFrame, atlas: Atlas): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const source = atlas.tileDevicePx
  const yEnd = camera.y0 + camera.rows
  const xEnd = camera.x0 + camera.cols

  for (let y = camera.y0; y < yEnd; y++) {
    const rowBase = y * frame.gridW
    const py = gridToScreenY(camera, y)
    for (let x = camera.x0; x < xEnd; x++) {
      const mask = frame.roads[rowBase + x] as number
      if (mask === 0) continue
      ctx.drawImage(
        atlas.surface,
        atlasSourceX(atlas, mask),
        atlasSourceY(atlas, mask),
        source,
        source,
        gridToScreenX(camera, x),
        py,
        tile,
        tile,
      )
    }
  }
}

/**
 * Phase 5, above the roads: a road is legal on a carpark cell (it is the
 * driveway), so drawing the building first would leave the road on top of it.
 *
 * The footprint box is derived from the orientation — the second copy of
 * `sim`'s geometry documented at `DEST_ORIENTATION_N`. The carpark cell is NOT
 * derived: `game` computed it with `sim`'s own `carparkCell` and put it in the
 * frame, so there is one fewer convention to copy. `-1` means the carpark fell
 * off the grid, which stored placements never produce but the value is
 * representable, and drawing it would put a bay at the board's top-left corner.
 */
function drawDestinations(ctx: DrawContext, frame: RenderFrame, palette: Palette): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const carparkInset = tile * CARPARK_INSET_FRACTION
  const carparkSize = tile * CARPARK_SIZE_FRACTION
  const pinSize = tile * PIN_SIZE_FRACTION
  const pinStride = tile * PIN_STRIDE_FRACTION

  for (let d = 0; d < frame.destCount; d++) {
    const cell = frame.destCell[d] as number
    const ax = cell % frame.gridW
    const ay = Math.floor(cell / frame.gridW)
    if (!insideRevealed(camera, ax, ay)) continue

    const orientation = frame.destOrientation[d] as number
    const px = gridToScreenX(camera, ax)
    const py = gridToScreenY(camera, ay)
    ctx.fillStyle = groupColour(palette, frame.destColour[d] as number)
    ctx.fillRect(px, py, destFootprintW(orientation) * tile, destFootprintH(orientation) * tile)

    // **The `>= 0` test is SUBSUMED by the `insideRevealed` below it, and this
    // comment is why neither may be deleted on the strength of its own
    // survival.** `carparkCell` returns -1 when the bay would fall off the grid;
    // `-1 % w` is `-1` and `floor(-1 / w)` is `-1` in JavaScript, so a -1
    // carpark decomposes to (-1, -1), which `insideRevealed` rejects for **any
    // `x0 >= 0`** — not merely for M2's frozen `x0 = 5`, so the equivalence
    // survives M1d making the rect dynamic all the way down to column 0.
    // Deleting this line **outright** (`if (true)`) therefore passes the whole
    // suite, which is stronger evidence of equivalence than widening it to
    // `>= -1` and is the form to reach for when re-checking. It stays because
    // the two guards mean different things — one rejects a sentinel, the other
    // clips to the camera — and the compound edit that removes both IS caught.
    const carpark = frame.destCarpark[d] as number
    if (carpark >= 0) {
      const cx = carpark % frame.gridW
      const cy = Math.floor(carpark / frame.gridW)
      if (insideRevealed(camera, cx, cy)) {
        ctx.fillStyle = palette.roadEdge
        ctx.fillRect(
          gridToScreenX(camera, cx) + carparkInset,
          gridToScreenY(camera, cy) + carparkInset,
          carparkSize,
          carparkSize,
        )
      }
    }

    const pins = frame.destPins[d] as number
    if (pins > 0) {
      const drawn = pins < MAX_DRAWN_PINS ? pins : MAX_DRAWN_PINS
      ctx.fillStyle = palette.uiText
      for (let p = 0; p < drawn; p++) {
        ctx.fillRect(px + pinSize + p * pinStride, py + pinSize, pinSize, pinSize)
      }
    }
  }
}

/**
 * Phase 6, above the roads for the same reason as phase 5: `placeRoad` allows a
 * road on a house cell.
 *
 * Reads `[0, houseCount)` and nothing beyond it. That prefix is the whole
 * liveness contract (plan Decision 3): a fresh `GameState` writes no `-1`
 * sentinel, so an unused slot holds cell 0 — a real, in-bounds cell — and the
 * count is the only thing separating a house from a phantom.
 */
function drawHouses(ctx: DrawContext, frame: RenderFrame, palette: Palette): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const inset = tile * HOUSE_INSET_FRACTION
  const size = tile * HOUSE_SIZE_FRACTION

  for (let h = 0; h < frame.houseCount; h++) {
    const cell = frame.houseCell[h] as number
    const x = cell % frame.gridW
    const y = Math.floor(cell / frame.gridW)
    if (!insideRevealed(camera, x, y)) continue
    ctx.fillStyle = groupColour(palette, frame.houseColour[h] as number)
    ctx.fillRect(
      gridToScreenX(camera, x) + inset,
      gridToScreenY(camera, y) + inset,
      size,
      size,
    )
  }
}

/**
 * Phase 7, above the buildings: a car drives onto the carpark, and a car parked
 * under its destination is a car the player cannot see.
 *
 * **`carXY` is in cell-CENTRE units and this is the one place the two coordinate
 * conventions in this milestone meet.** `gridToScreen` maps a cell to its
 * top-left corner; `game`'s resolver maps a car to `(cx, cy)` when it is parked
 * on cell `(cx, cy)` and to `(cx + 0.5, cy)` half way along an eastward edge
 * (plan Decision 2). So an integer grid coordinate names a cell's centre, and
 * the CSS centre is `gridToScreen(gx, gy) + tileSize / 2`. Dropping the half-tile
 * shifts every car up and left by half a cell — visible, and easy to mistake for
 * an art offset.
 *
 * `carXY` is dense: `game` packs `carCount` live cars at the front, because cars
 * have no index-based count in the sim at all and `PHASE_NONE` is their only
 * liveness marker.
 */
function drawCars(ctx: DrawContext, frame: RenderFrame, palette: Palette): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const size = tile * CAR_SIZE_FRACTION
  const half = size / 2
  const centre = tile / 2

  for (let c = 0; c < frame.carCount; c++) {
    const gx = frame.carXY[c * 2] as number
    const gy = frame.carXY[c * 2 + 1] as number
    if (!insideRevealed(camera, gx, gy)) continue
    ctx.fillStyle = groupColour(palette, frame.carColour[c] as number)
    ctx.fillRect(
      gridToScreenX(camera, gx) + centre - half,
      gridToScreenY(camera, gy) + centre - half,
      size,
      size,
    )
  }
}

/**
 * Phase 9. Spec §7.2's three persistent elements, laid out by `hudRects` and
 * drawn centred in its rectangles.
 *
 * All three are in the **bottom** band: §7.2 puts the clock at the top and §8.3
 * forbids any interactive element in the top band, and M2 resolves that toward
 * §8.3 because it is a platform fact and §7.2 is a preference.
 *
 * The pause indicator is two bars at the left of the clock rect, drawn only when
 * the frame is paused — the clock doubles as the pause control (§7.2), so its
 * own rect is where its state belongs.
 *
 * **When the bars are up, the clock text is centred in what is LEFT of the rect,
 * not in the whole rect.** The bars occupy `[x + barW, x + 4·barW]`; centring
 * the text on the full rect puts a long clock string straight through them.
 * That is a layout fact, true whatever the glyph widths are, and it is cheaper
 * to reserve the gutter than to discover the collision on a device.
 */
function drawHud(ctx: DrawContext, frame: RenderFrame, palette: Palette): void {
  const rects = hudRects(frame.camera, HUD_SCRATCH)
  const clock = rects.clock
  const barW = clock.h * PAUSE_BAR_FRACTION
  const gutter = frame.paused ? PAUSE_GUTTER_BARS * barW : 0

  if (frame.paused) {
    const barH = clock.h / 2
    const barY = clock.y + clock.h / 4
    ctx.fillStyle = palette.uiText
    ctx.fillRect(clock.x + barW, barY, barW, barH)
    ctx.fillRect(clock.x + 3 * barW, barY, barW, barH)
  }

  ctx.font = HUD_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = palette.uiText
  fillCentred(ctx, clockText(frame.week, frame.day), clock, gutter)
  fillCentred(ctx, scoreText(frame.score), rects.score, 0)
  fillCentred(ctx, tilesText(frame.tilesLeft), rects.tiles, 0)
}

/**
 * Draws `text` centred in `rect` minus a left `gutter`, **constrained by
 * `maxWidth` so that it cannot leave the rect**.
 *
 * `fillText`'s fourth argument is the whole point of this function, and it
 * closes a claim the first version of this task got wrong. The rendered advance
 * width of a string at `600 20px system-ui` genuinely is not observable here —
 * there is no font engine in this workspace and `system-ui` resolves to
 * different faces on iOS and Android. But **"the label fits its rect" does not
 * need to be measured, it can be made true by construction**: the canvas 2D spec
 * condenses the run to at most `maxWidth`, and with `textAlign = 'center'` the
 * text then occupies exactly `[cx - maxWidth/2, cx + maxWidth/2]`, which is the
 * rect. The argument is recorded, so the guarantee is asserted rather than
 * hoped for, at zero runtime cost and zero allocation.
 *
 * This matters more than it looks. `hudRects` gives `floor((cssW - 32) / 3)`:
 * 124 CSS px on the M0 device, 119 at 390, and **96 at a 320 px viewport**,
 * which `fitCamera` accepts. And the labels are unbounded — `score` and `week`
 * have no ceiling in the sim, so `'N TRIPS'` grows without limit and overflow is
 * a certainty at some value rather than a device-dependent risk. Condensing is a
 * legible failure; overlapping the neighbouring element is not.
 */
function fillCentred(ctx: DrawContext, text: string, rect: Rect, gutter: number): void {
  const width = rect.w - gutter
  ctx.fillText(text, rect.x + gutter + width / 2, rect.y + rect.h / 2, width)
}

/**
 * Is a board position inside the revealed rect? Takes a position, not a cell
 * index, so cars (fractional) and buildings (integral) share one test.
 *
 * Half-open on the far edges, exactly as `screenToGrid` is: a car at
 * `x0 + cols` is the first column of the next, unrevealed cell.
 */
function insideRevealed(camera: Camera, x: number, y: number): boolean {
  return (
    x >= camera.x0 && x < camera.x0 + camera.cols && y >= camera.y0 && y < camera.y0 + camera.rows
  )
}

/**
 * A colour group's preallocated string, with a fallback that is a colour rather
 * than `undefined`.
 *
 * `packDestMeta` validates colour against the full 3-bit range `[0, 7]` while a
 * palette carries at most `MAX_GROUP_COUNT` = 6 groups, so 6 and 7 are
 * representable in sim state and unmapped here. `fillStyle = undefined` is
 * silently ignored by a real context, which leaves the *previous* element's
 * colour on the brush — a house painted in the last car's colour, with nothing
 * to notice. `uiText` is in no group, so a building drawn in it is visibly wrong
 * rather than plausibly wrong.
 */
function groupColour(palette: Palette, index: number): string {
  return palette.groups[index] ?? palette.uiText
}

/**
 * The atlas and the palette must be the same object, and this is the loud half
 * of plan Task 5's inherited hazard.
 *
 * **Identity, not structural equality**, and that is deliberate: `PALETTE` is
 * frozen and preallocated, so a caller holding a different object either rebuilt
 * the theme — in which case the atlas is genuinely stale — or is allocating a
 * palette per frame, which the same Global Constraint forbids. Both want to be
 * loud.
 *
 * **Why a throw rather than a comment**, which was the option the plan also
 * offered. The failure it prevents is silent, permanent and misattributed: roads
 * in the previous theme, everything else correct, presenting as a rendering bug
 * in a milestone where nobody is looking for a cache. A comment discharges the
 * obligation without checking anything — the catalogue's own entry on
 * overstated comments — and Task 4 put `Atlas.palette` on the type specifically
 * so this check could exist. It costs one reference comparison per frame and
 * allocates only on the failing path.
 *
 * **Why throwing inside the frame loop is acceptable here, when `fitCamera`
 * chose to clamp instead.** `fitCamera`'s degenerate viewport is a transient a
 * rotation produces and the next event resolves; a palette mismatch is a static
 * wiring error that is true on frame 1 and every frame after, so failing fast in
 * development is the only outcome that differs from shipping the bug.
 */
function assertAtlasPalette(atlas: Atlas, palette: Palette): void {
  if (atlas.palette !== palette) {
    throw new Error(
      'drawFrame: the atlas was baked with a different palette than this frame is being drawn ' +
        'in. The atlas rasterises its road colour at build time and a blit cannot re-tint its ' +
        'source, so the roads would keep the old theme while everything else changed — rebuild ' +
        'the atlas with the new palette instead of passing it here. If both palettes LOOK ' +
        'identical, the cause is two resolved copies of @laneways/render (a duplicated ' +
        'dependency, a stale build output on the import path), each with its own frozen PALETTE ' +
        'object — rebuilding the atlas will not help and the module graph is what to fix',
    )
  }
}

/**
 * Compile-time pin: a real `CanvasRenderingContext2D` satisfies `DrawContext`.
 *
 * The `Assert<T extends true>` wrapper is load-bearing for the reason Task 4
 * recorded — `type X = A extends B ? true : never` pins nothing, because `never`
 * is a perfectly good type and `tsc` stays silent. This one has already earned
 * its keep: with `drawImage`'s image parameter typed as `AtlasSurface` alone it
 * fails with `TS2344: Type 'false' does not satisfy the constraint 'true'`,
 * which is how `DrawImageSource` came to be a union.
 */
type Assert<T extends true> = T
export type _RealContextIsADrawContext = Assert<
  CanvasRenderingContext2D extends DrawContext ? true : false
>
