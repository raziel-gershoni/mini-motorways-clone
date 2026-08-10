import {
  atlasSourceX,
  atlasSourceY,
  AtlasVariant,
  type Atlas,
  type Atlases,
  type AtlasSurface,
} from './atlas'
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
 * **1. No `clearRect`, ever** (plan Decision 4). **Five** opaque fills cover the
 * canvas exactly once — the top band, the two letterbox columns, the playfield,
 * and the bottom band — and everything else draws on top. A `clearRect` plus a
 * land fill covers it twice; at M2's regime on the M0 device that is a wasted
 * full-canvas pass of **1,412,880 device px, ~0.141 ms — more than the entire
 * road layer costs**. The rule this creates is unforgiving: *every* pixel of the
 * canvas must be covered by one of those five fills each frame, or the previous
 * frame ghosts. `DrawContext` below deliberately does not declare `clearRect`,
 * so reaching for it is a type error as well as a test failure.
 *
 * **Five, not three — Task 9, and the pixel budget was RECOMPUTED rather than
 * assumed.** The three-band form painted the letterbox in the **land** colour,
 * so land ran to the screen edge and nothing on screen distinguished a tap on
 * the rect's first column from a tap in the letterbox, which does nothing. On a
 * phone that reads as an unresponsive game — an input-affordance defect, not a
 * styling one. The playfield is now exactly the grid rect and everything outside
 * it is `palette.background`, which is what that palette entry has always
 * claimed to be (`palette.ts`: *"The letterbox outside the grid rect, and the top
 * band"*). **A partition of the same canvas into more rectangles paints the same
 * pixels**: the M0 device is still 812 x 1740 = 1,412,880 device px covered
 * exactly once, and the whole cost of the change is **two extra `fillRect`
 * calls** — 5 x 0.16 us + 1,412,880 / 10 Gpx/s = 0.1421 ms against 0.1418 ms, a
 * 0.23% increase on a pass the plan already charges at 0.141 ms. Both figures are
 * recomputed from the recording in `test/canvas.test.ts` rather than carried over.
 *
 * On the M0 device `originX` is 0 (406 = 14 x 29 exactly), so the two letterbox
 * columns are zero-width there and the change is visible only at the grid rect's
 * **bottom** edge — 40 CSS px on the M0 device, 49 on a 390 x 844 one, which is
 * the strip a finger can actually land in. The zero-area fills are still issued,
 * so the fill count does not vary with the viewport and the tiling assertion
 * stays uniform; a `fillRect` of zero width paints nothing on a real context.
 *
 * **2. Nothing allocates here.** No array literal, no object literal, no closure,
 * no string concatenation. The two places that would have — `hudRects`'s output
 * and the HUD's four formatted numbers — are a module-level scratch object and a
 * value-keyed text cache respectively. There IS an allocation profiler —
 * `packages/game/test/allocation.test.ts`, built in Task 6 and pointed at the
 * input path in Task 7 — and this file's draw path runs under it whenever
 * `game` supplies the context; what it cannot see is a `render`-only call with
 * no `game` caller.
 *
 * **This paragraph used to end "Review is the only check", four lines below the
 * sentence saying a profiler exists.** That is the fourth copy of the same
 * refuted claim found on this milestone, in three rounds of fixing it, and two
 * of them were in this one doc comment. What is true is narrower and is now
 * stated as such: a Task 3 reviewer reinstated an allocation here and watched
 * all 82 tests pass, which was a fact about the coverage of the day rather than
 * about the toolchain. Today the harness reaches this file through a `game`-side
 * caller; Task 9's integration is what supplies one, and until then review is
 * the only check **of this file specifically** — not of the rule.
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
 * `drawFrame(ctx, frame, atlases, palette)` reads as though `palette` governed
 * every colour on screen. It does not govern the roads: **the atlas bakes its
 * stroke colour in at build time and a blit cannot re-tint its source**, so a
 * palette change without an atlas rebuild leaves every road in the previous
 * theme while everything else follows — a failure that reads as a rendering bug
 * rather than a caching one. Task 4 put the baked palette on `Atlas` so the
 * mismatch is *detectable*; `assertAtlases` below is what makes it *loud*.
 *
 * **M1d Task 8 doubled that hazard rather than adding a different one.** The
 * ghost layer is a second baked surface with the same property — it strokes
 * `palette.road` too, faded by a bake-time `globalAlpha` — so a rebuild that
 * refreshes one surface and not the other ships a board whose ghosts are in last
 * week's theme. `Atlases` keeps the pair together, `buildAtlases` is the
 * constructor that cannot mismatch them, and `assertAtlases` checks BOTH
 * palettes: a guard on half the hazard is the failure mode this whole paragraph
 * exists to record.
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
 * **What is and is not testable about this, said plainly — and this paragraph
 * used to end "this toolchain has no allocation profiler", which is false and
 * contradicted the top of this very file.** There is one:
 * `packages/game/test/allocation.test.ts`, built in Task 6 and pointed at the
 * input path in Task 7. What is genuinely unobservable is narrower and it is a
 * property of *strings*, not of the toolchain: two equal strings are
 * indistinguishable no matter how many were allocated, so no assertion on the
 * recorded text can tell a memoised cache from a re-formatted one. The profiler
 * WOULD see it — as bytes charged to this file — but only through a `game`-side
 * caller that actually calls `drawFrame`, which the harness's no-op `draw` is
 * not. Task 9's integration is where that closes.
 *
 * The *staleness* is observable here and now, and it is the failure mode that
 * matters: a cache that never invalidates draws last week's score forever.
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
 * Draws one frame. Ten phases, in this order, and the order is load-bearing:
 *
 * ```
 * 1 top band + letterbox fills    2 playfield fill    3 non-land terrain
 * 4 ghost roads                   5 live roads        6 destinations
 * 7 houses                        8 cars              9 bottom band fill
 * 10 HUD content
 * ```
 *
 * **Phases 4 and 5 cannot paint the same cell, and the order between them is
 * fixed anyway.** `sim` only ghosts a cell whose live mask reached 0, and
 * `placeRoad` pays the pending refund and clears the ghost, so
 * `roads[c] !== 0 && ghosts[c] !== 0` is unreachable — which means swapping
 * these two calls changes no pixel today and is an equivalent mutant *on the
 * pixels*. It is written ghost-first regardless, so that the LIVE layer wins if
 * that invariant is ever broken: a road that exists must not be hidden under the
 * memory of one that does not. Recorded rather than left as apparent coverage —
 * the command ORDER is asserted in `test/canvas.test.ts` and that assertion is
 * pinning a chosen safety margin, not a visible behaviour.
 *
 * **The five fills partition the canvas, and the count is forced rather than
 * chosen.** Plan Decision 4 requires them to cover the canvas *exactly once* —
 * its own frame model charges that at 1,412,880 device px, the M0 device's whole
 * backing store — and the complement of an interior rectangle inside a rectangle
 * needs **four** rectangles, so painting the playfield as its own rect is five
 * fills, not the "fourth fill" Task 9's brief names. The four background pieces
 * would be five if the vertical gap below the grid rect and the HUD band were
 * kept apart, and they are not: both are `palette.background`, so one fill from
 * the grid rect's bottom edge to the canvas bottom covers the gap, the HUD band
 * and the bottom safe-area inset together.
 *
 * **The bottom fill stays after the cars, which is where the old HUD band fill
 * was, and that is load-bearing.** It is the only thing stopping a sprite that
 * overhangs the grid rect from painting into the HUD band and staying there
 * forever — there is no `clearRect` coming. The consequence is new and
 * deliberate: a car driving off the rect's **bottom** edge is now clipped at that
 * edge (up to 3/4 of a tile of overhang) instead of trailing across the gap, so
 * the playfield reads as a hard rectangle. The two letterbox columns are painted
 * *before* the content, so a car at the left or right edge still straddles it —
 * asymmetric, inherited rather than introduced, and 0 CSS px wide on the M0
 * device anyway. This also implements half of what the note below says M1d must
 * do when the revealed rect becomes dynamic.
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
 * the rect becomes dynamic (the fix then is a `clip` around phases 3-8, which
 * would also stop a partially-visible building painting into the HUD band).
 *
 * **Cars are culled by their own position and not by anything the buildings do,
 * and a car near the rect's last column or row overhangs it by up to
 * `3 * tileSize / 4` CSS px.** That is correct — the sprite is centred on a
 * position the sim genuinely put at the edge — and the reason it never reaches
 * the HUD is the **draw order**: the bottom band is phase 9 and cars are phase
 * 8, so it paints over anything that spilled below the grid rect. Not anchor
 * culling, which is the buildings' protection and not the cars'. Sideways the
 * overhang survives, because the two letterbox columns are phase 1.
 */
export function drawFrame(
  ctx: DrawContext,
  frame: RenderFrame,
  atlases: Atlases,
  palette: Palette,
): void {
  assertAtlases(atlases, palette)

  const camera = frame.camera
  const dpr = camera.dpr
  // The canvas's own extent in CSS px, as the backing store will actually be
  // sized: `round(css * dpr)` device px. Task 8 MUST size the canvas with the
  // same rounding, or the last device row/column is outside every band.
  const right = deviceEdge(camera.cssW, dpr)
  const bottom = deviceEdge(camera.cssH, dpr)
  // Clamped and kept monotone, so the five fills tile the ON-CANVAS area for
  // every viewport including the degenerate ones `fitCamera` clamps for: at
  // `cssH = 0` the plain formula gives `originY = -41` and a negative-height
  // fill, which the canvas normalises but which is a wasted call and a geometry
  // no test should have to reason about. At `cssW = 0` the same happens
  // horizontally — `originX = -7` at a clamped tile of 1 — and the two letterbox
  // clamps collapse the playfield to zero width rather than to a negative one.
  const gridTop = clamp(deviceEdge(camera.originY, dpr), 0, bottom)
  const gridBottom = clamp(
    deviceEdge(camera.originY + camera.rows * camera.tileSize, dpr),
    gridTop,
    bottom,
  )
  const gridLeft = clamp(deviceEdge(camera.originX, dpr), 0, right)
  const gridRight = clamp(
    deviceEdge(camera.originX + camera.cols * camera.tileSize, dpr),
    gridLeft,
    right,
  )

  // 1. The background matte, in three pieces: the top band down to the grid
  //    rect, then the letterbox column on each side of it. The fourth piece is
  //    phase 9, because it has to paint over the cars.
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, right, gridTop)
  ctx.fillRect(0, gridTop, gridLeft, gridBottom - gridTop)
  ctx.fillRect(gridRight, gridTop, right - gridRight, gridBottom - gridTop)

  // 2. The playfield: exactly the grid rect, and the only land on the canvas.
  //    `drawTerrain` relies on this having covered every LAND cell already.
  ctx.fillStyle = palette.land
  ctx.fillRect(gridLeft, gridTop, gridRight - gridLeft, gridBottom - gridTop)

  drawTerrain(ctx, frame, palette)
  // 4 then 5. See the phase list: the two layers are disjoint per cell, and the
  // live one is drawn second so that it wins if they ever stop being.
  drawMaskLayer(ctx, frame, frame.ghosts, atlases.ghost)
  drawMaskLayer(ctx, frame, frame.roads, atlases.road)
  drawDestinations(ctx, frame, palette)
  drawHouses(ctx, frame, palette)
  drawCars(ctx, frame, palette)

  // 9. The bottom band: from the grid rect's bottom edge down to the canvas
  // BOTTOM, not merely to the HUD band's own height. It covers three things at
  // once — the vertical gap between the grid rect and the band, the band, and
  // the bottom safe-area inset under it. A fill that started at `hudTop` would
  // leave the gap painted land (the defect this task closes) and one that
  // stopped at `hudTop + hudHeight` would leave the inset holding the previous
  // frame forever; there is no clearRect coming to fix either.
  ctx.fillStyle = palette.background
  ctx.fillRect(0, gridBottom, right, bottom - gridBottom)

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
 * Phases 4 and 5. One `drawImage` per non-zero cell of `masks`, from that mask's
 * own tile of the 256-entry `atlas` — the whole reason the atlas exists (plan
 * Decision 4: 139 blits, ~0.069 ms at M2's regime, against a path-stroke per
 * cell).
 *
 * **One function, called twice, and that is a deliberate departure from the
 * brief's "one more loop".** The catalogue's most expensive bounds finding is
 * that `drawTerrain`'s and `drawRoads`' `xEnd`/`yEnd` could each be shrunk with
 * 178 tests green — *two* loops, *two* bounds, and the fixture happened to
 * defeat both. A third copy would be a third bound whose only protection is a
 * copied test. Sharing means there is exactly one bound here, and the ghost
 * bounds tests in `test/canvas.test.ts` are a second, independent detector for
 * it rather than the only detector for a second one. What they DO uniquely
 * cover, and what the brief's separate-loop shape would not have made any
 * easier, is that the ghost pass is called with `frame.ghosts` and the GHOST
 * atlas: pass `frame.roads` or `atlases.road` and every ghost assertion fails.
 *
 * The source rect is in **device** px (`atlas.tileDevicePx`) and the destination
 * rect in **CSS** px (`camera.tileSize`); at the DPR-2 cap the two differ by
 * exactly the ratio, and swapping them draws every road at half or double size.
 *
 * Mask 0 is never blitted. `state.roads` and `state.ghostMask` both use 0 for
 * "nothing here", and tile 0 is a blank that exists only so the mask indexes the
 * atlas grid directly.
 */
function drawMaskLayer(
  ctx: DrawContext,
  frame: RenderFrame,
  masks: Uint8Array,
  atlas: Atlas,
): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const source = atlas.tileDevicePx
  const yEnd = camera.y0 + camera.rows
  const xEnd = camera.x0 + camera.cols

  for (let y = camera.y0; y < yEnd; y++) {
    const rowBase = y * frame.gridW
    const py = gridToScreenY(camera, y)
    for (let x = camera.x0; x < xEnd; x++) {
      const mask = masks[rowBase + x] as number
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
 * Phase 6, above both road layers: a road is legal on a carpark cell (it is the
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
 * Phase 7, above the roads for the same reason as phase 6: `placeRoad` allows a
 * road on a house cell.
 *
 * Reads `[0, houseCount)` and nothing beyond it. That prefix is the whole
 * liveness contract (plan Decision 3): no region behind `RenderFrame` carries a
 * `-1` sentinel, so an unused slot holds cell 0 — a real, in-bounds cell — and
 * the count is the only thing separating a house from a phantom. (Narrowed at
 * M1d Task 2: `sim` now has one `-1`-filled region, `occupancy`, and `render`
 * neither receives it nor could.)
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
 * Phase 8, above the buildings: a car drives onto the carpark, and a car parked
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
 * Phase 10. Spec §7.2's three persistent elements, laid out by `hudRects` and
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
 * Both atlases must be current, and each must be the layer it is being used as.
 *
 * Three checks, and each catches something no other one does:
 *
 * - **Palette identity, per surface.** See `assertAtlasPalette`. Checked on the
 *   ghost too, because it bakes `palette.road` exactly as the road atlas does —
 *   a rebuild that refreshes one and not the other is the whole new hazard M1d
 *   Task 8 introduced, and a guard on half of it would report clean for it.
 * - **Variant.** Nothing else can see a swapped pair: the two atlases have the
 *   same size, grid, tile count and palette, so `{ road: ghost, ghost: road }`
 *   type-checks, builds, draws, and renders every live road as a faded hairline.
 *   `buildAtlases` cannot produce that pair — but `Atlases` is a plain
 *   interface, `main.ts` could construct one by hand, and every test in
 *   `render` does.
 * - **Tile size.** The two are rebuilt together by `buildAtlases`; a differing
 *   `tileDevicePx` means somebody rebuilt one of them alone, which is the
 *   palette hazard's twin and the only symptom would be a resampled ghost layer.
 *
 * Four reference comparisons and two number comparisons per frame, allocating
 * only on the failing path.
 */
function assertAtlases(atlases: Atlases, palette: Palette): void {
  assertAtlasPalette(atlases.road, palette, 'road')
  assertAtlasPalette(atlases.ghost, palette, 'ghost')
  if (
    atlases.road.variant !== AtlasVariant.ROAD ||
    atlases.ghost.variant !== AtlasVariant.GHOST
  ) {
    throw new Error(
      'drawFrame: the two atlases are the wrong way round — `atlases.road` must be built with ' +
        'AtlasVariant.ROAD and `atlases.ghost` with AtlasVariant.GHOST. Swapped, every live road ' +
        'draws as a thin faded ghost and every ghost draws as a solid road, which reads as an art ' +
        'regression rather than as a wiring error. Use buildAtlases, which cannot produce this pair',
    )
  }
  if (atlases.road.tileDevicePx !== atlases.ghost.tileDevicePx) {
    throw new Error(
      `drawFrame: the road atlas is built for a ${atlases.road.tileDevicePx} px tile and the ghost ` +
        `atlas for a ${atlases.ghost.tileDevicePx} px one, so one of them was rebuilt without the ` +
        'other. Both are rasterised at a fixed tile size and the shell rebuilds on every tile-size ' +
        'change; rebuild them together with buildAtlases',
    )
  }
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
 * `which` is the literal union `'road' | 'ghost'` and not `string`: the only
 * job this parameter has is to send the reader to the right rebuild, and a
 * mislabelled call — `'ghost'` passed for the road atlas — would produce a
 * confident, precise, wrong message that no test would ever read. A `string`
 * cannot refuse that; the union does, at compile time.
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
function assertAtlasPalette(atlas: Atlas, palette: Palette, which: 'road' | 'ghost'): void {
  if (atlas.palette !== palette) {
    throw new Error(
      `drawFrame: the ${which} atlas was baked with a different palette than this frame is being ` +
        'drawn in. The atlas rasterises its road colour at build time and a blit cannot re-tint ' +
        'its source, so the roads would keep the old theme while everything else changed — ' +
        'rebuild the atlas with the new palette instead of passing it here. If both palettes ' +
        'LOOK identical, the cause is two resolved copies of @laneways/render (a duplicated ' +
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
