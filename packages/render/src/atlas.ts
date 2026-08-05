import { PALETTE } from './palette'
import type { Palette } from './types'

/**
 * The 256-entry road tile atlas: one tile per 8-bit neighbour mask, rendered
 * once at boot onto a single **16x16 grid** surface and blitted per road cell
 * per frame (plan Decision 4).
 *
 * **Why an atlas at all, when M2 does not bake the road layer.** The two are
 * not the same trade and the plan struck the bake out with its own arithmetic:
 * baking composites 3.2x the pixels to draw the same roads, crossover is at 85%
 * road density against a measured 45%, and the core mechanic *is* drawing
 * roads, so every frame of a drag would pay re-render + offscreen clear + blit
 * — 4.8x the per-frame path. The atlas is the opposite: it is rasterised once,
 * at boot and on a tile-size change, and it is what makes the per-frame path
 * one `drawImage` per road cell (139 calls, ~0.069 ms at M2's regime) instead
 * of a path-stroke per cell.
 *
 * **Why 16x16 and not a 1x256 strip.** At M2's 58 device px tile a strip is
 * 14,848 px wide, past every documented WebKit canvas dimension limit (4,096 on
 * older iOS, 8,192-16,384 on current). Past the limit the backing store is
 * silently blank or downscaled — spec §8.5's "iOS fails silently" class,
 * invisible to every Node-side test and first visible as a black board after a
 * deploy. The same tile on a 16x16 grid is 928x928. `assertAtlasDimension`
 * below turns the remaining silent-failure window into a loud one, in the same
 * idiom as `sim`'s `assertSingleCrossing` and `assertDispatchProgress`.
 *
 * **Canvas access is injected** (plan Decision 8). `buildAtlas` takes a surface
 * factory: production passes a real canvas, tests pass a recording surface
 * whose 2D context appends every path command and every state assignment to an
 * array. This workspace has no jsdom, no `canvas` module and no vitest DOM
 * config — `typeof OffscreenCanvas` is `undefined` in its Node — so an
 * uninjected builder would be untestable here, not merely awkward. The
 * production factory is three lines and lives in `game` (Task 9), because it is
 * the only place a `document` reference belongs:
 *
 * ```ts
 * const createSurface: AtlasSurfaceFactory = (w, h) => {
 *   const canvas = document.createElement('canvas')
 *   canvas.width = w
 *   canvas.height = h
 *   return canvas
 * }
 * ```
 *
 * `_RealCanvasIsAnAtlasSurface` at the bottom of this file is the compile-time
 * pin that the snippet above type-checks.
 *
 * **What a recorder cannot see, so nobody records it as covered:** whether a
 * browser rasterises these segments the way we expect. That is a browser
 * property; Task 9's deploy is its only check.
 *
 * **Nothing here runs inside the frame loop.** `buildAtlas` allocates — a
 * surface, a context, one small object — and it is allowed to: it runs at boot
 * and on a tile-size change (plan Decision 5's rebuild rule), never per frame.
 * `atlasSourceX`/`atlasSourceY` DO run per road cell per frame and allocate
 * nothing: two arithmetic ops on numbers, no object, no array, no closure.
 */

/**
 * Tiles per axis. 16 x 16 = 256 = every value of an 8-bit mask, which is why
 * the grid is square and why no mask can fall outside it.
 */
export const ATLAS_COLS = 16

/** One tile per value of `state.roads[cell]`, which is a `Uint8Array` entry. */
export const ATLAS_MASK_COUNT = 256

/**
 * The dimension past which a WebKit canvas backing store is silently blank or
 * downscaled — the smallest documented limit (older iOS), taken rather than the
 * larger current ones because the failure is silent and device-only.
 */
export const MAX_ATLAS_DIMENSION_PX = 4096

/**
 * Stroke width as a fraction of the tile, inside spec §6's 55-65% band.
 *
 * Kept as a fraction and multiplied per build rather than rounded to a device
 * pixel: a road is a blit of a pre-rendered tile, so a fractional stroke width
 * costs nothing at draw time, and rounding would make the width a step function
 * of the tile size that is constant across the sizes M2 actually uses.
 */
export const ROAD_STROKE_FRACTION = 0.6

/** 8 directions, index 0 = N, clockwise. */
export const ROAD_DIR_COUNT = 8

/**
 * The direction table, bit *i* = direction *i*, verified against
 * `packages/sim/src/roads.ts:92-95`: N=0, NE=1, E=2, SE=3, S=4, SW=5, W=6,
 * NW=7. So 85 (`0b01010101`) is the four orthogonals, 170 the four diagonals,
 * 255 all eight, and 5 is N+E — an elbow.
 *
 * **A deliberate second copy, for the same reason `TerrainClass` is one:**
 * spec §4 forbids `render` importing `sim`, and `test/boundary.test.ts`
 * enforces it. Unlike `TerrainClass`, whose fold has a `game`-side test, this
 * copy would have had no watcher at all — a transposed table draws every
 * diagonal road backwards and nothing in Node would notice. So
 * `packages/game/test/renderDirections.test.ts` pins it against `sim`'s own
 * `DX`/`DY`: `game` imports both packages, which is where the two can meet.
 */
export const ROAD_DIR_DX = Object.freeze([0, 1, 1, 1, 0, -1, -1, -1] as const)

/** The y half of `ROAD_DIR_DX`'s table; see there. */
export const ROAD_DIR_DY = Object.freeze([-1, -1, 0, 1, 1, 1, 0, -1] as const)

/**
 * The slice of `CanvasRenderingContext2D` the atlas builder uses, and nothing
 * more. A real 2D context satisfies it structurally, which is what lets tests
 * pass a recorder and production pass a canvas with no branch between them.
 *
 * `strokeStyle` is typed as the full DOM union rather than `string` because a
 * narrower property type would stop `CanvasRenderingContext2D` being assignable
 * to this interface at all.
 */
export interface AtlasContext {
  lineWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  strokeStyle: string | CanvasGradient | CanvasPattern
  save(): void
  restore(): void
  beginPath(): void
  rect(x: number, y: number, w: number, h: number): void
  clip(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
}

/**
 * The slice of `HTMLCanvasElement` the atlas needs: a size and a 2D context.
 *
 * `width`/`height` are read back after construction, not merely written —
 * `assertSurfaceSize` below is what turns "the platform gave me a smaller
 * canvas than I asked for" from a black board into an exception.
 */
export interface AtlasSurface {
  width: number
  height: number
  getContext(contextId: '2d'): AtlasContext | null
}

/**
 * Creates a drawing surface of exactly `widthPx` x `heightPx`.
 *
 * The dimensions are parameters rather than something the caller sets
 * afterwards so that `new OffscreenCanvas(w, h)` — which takes them at
 * construction — is as usable here as a canvas element.
 */
export type AtlasSurfaceFactory = (widthPx: number, heightPx: number) => AtlasSurface

/**
 * A built atlas. `drawFrame` (Task 5) blits from it; `game`'s viewport handler
 * (Task 8) compares `tileDevicePx` against the freshly measured tile size and
 * rebuilds only when they differ — which is why that field is public.
 */
export interface Atlas {
  /** The surface to blit from. In production an `HTMLCanvasElement`. */
  readonly surface: AtlasSurface
  /** Device px per tile, and the source width and height of every blit. */
  readonly tileDevicePx: number
  /** Tiles per axis; always `ATLAS_COLS`. */
  readonly cols: number
  readonly widthPx: number
  readonly heightPx: number
  /**
   * The stroke width actually used, in device px — `ROAD_STROKE_FRACTION *
   * tileDevicePx`.
   *
   * Public because it is half of the arithmetic that says how far a round cap
   * reaches past a spoke's endpoint (`strokeWidthPx / 2`), which is the
   * quantity `assertTileClip`'s whole existence rests on, and because a caller
   * drawing anything that must line up with a road — a carpark stub, a bridge —
   * needs the same number rather than a second copy of the fraction.
   */
  readonly strokeWidthPx: number
  /**
   * The palette this atlas was **baked with**, carried so a caller can tell a
   * stale atlas from a current one.
   *
   * `drawFrame(ctx, frame, atlas, palette)` takes a palette of its own and
   * cannot re-tint a blit, so the two can silently disagree: the roads keep the
   * colour they were rasterised with while everything else changes. Task 5
   * compares `atlas.palette` against the palette it was handed and rebuilds (or
   * throws) rather than drawing a board in two themes. Identity comparison is
   * enough — `PALETTE` is frozen and preallocated, and a palette that is a
   * different object is a different palette by construction.
   */
  readonly palette: Palette
}

/**
 * Thrown when the surface would exceed `MAX_ATLAS_DIMENSION_PX`. Named, and
 * carrying both the requested dimension and the limit, so a test can tell this
 * throw from any other one — the brief's "assert the error message names the
 * dimension, so a different throw is not mistaken for this one".
 */
function assertAtlasDimension(sizePx: number, tileDevicePx: number): void {
  if (sizePx > MAX_ATLAS_DIMENSION_PX) {
    throw new Error(
      `atlas: a tile of ${tileDevicePx} px needs a ${sizePx} x ${sizePx} px surface, past the ` +
        `${MAX_ATLAS_DIMENSION_PX} px canvas dimension limit — WebKit gives back a silently ` +
        'blank or downscaled backing store there, which no Node-side test can see',
    )
  }
}

/**
 * The tile size must be a whole number of device pixels, at least 1.
 *
 * Not defensive decoration: `game` builds at `floor(tileSize * dpr)` precisely
 * because the DPR-1.5 cap makes `29 * 1.5 = 43.5` (plan Decision 6), and a
 * caller that forgets the floor lands every tile of the atlas on a half-pixel
 * boundary — a soft, seam-y board that looks like an art problem. Zero is the
 * worse one: a transiently zero-sized viewport yields a 0x0 surface, 256
 * degenerate tiles and an invisible road layer, forever, silently.
 */
function assertTileSize(tileDevicePx: number): void {
  if (!Number.isInteger(tileDevicePx) || tileDevicePx < 1) {
    throw new Error(
      `atlas: tileDevicePx must be a whole number of device pixels >= 1, got ${tileDevicePx} — ` +
        'game builds at floor(tileSize * dpr) exactly because the LOW-class DPR cap of 1.5 ' +
        'makes that product fractional',
    )
  }
}

/** The factory's surface must be the size it was asked for; see `AtlasSurface`. */
function assertSurfaceSize(surface: AtlasSurface, sizePx: number): void {
  if (surface.width !== sizePx || surface.height !== sizePx) {
    throw new Error(
      `atlas: the surface factory returned ${surface.width} x ${surface.height} px for a ` +
        `request of ${sizePx} x ${sizePx} px — every blit would read the wrong tile`,
    )
  }
}

/**
 * Renders all 256 tiles onto one surface and returns the handle to blit from.
 *
 * Each tile is the set of spokes its mask names: for every set bit *d*, one
 * stroked segment from the tile's centre to the tile edge in direction *d* —
 * the edge midpoint for an orthogonal, the corner for a diagonal, which is
 * where the neighbouring tile's own spoke meets it. Round caps and joins
 * (spec §6) round the centre blob and the spoke ends.
 *
 * **Every tile is clipped to its own rect, and that is not hygiene — without it
 * this atlas is wrong on 248 of its 256 tiles.** The grid has no gutter, every
 * spoke runs to the tile edge, and a round cap is a half-disc of radius
 * `strokeWidthPx / 2` = `0.3 * tileDevicePx` centred ON that endpoint. So
 * `0.3 * tileDevicePx` of every spoke's ink lands in the neighbouring tile's
 * rect — which is exactly the rect `drawFrame` blits. Mask 4 (E) puts a stub
 * inside mask 5's rect; blit mask 1, a dead end, and you get the left edge of
 * mask 2's tile with it. Measured on the recorded command stream: mean 14% of a
 * tile's area foreign, worst 37%. A dead end renders as a through-road and an
 * elbow renders as a crossing.
 *
 * The cap stays round — it is what rounds the junction blob at the tile centre,
 * where the start caps of every spoke overlap — and the clip is what keeps its
 * far end out of the neighbour. Nothing is lost at the tile edge, because a
 * mask bit means the neighbour has the OPPOSITE bit set (`placeRoad` writes
 * both ends), so every spoke that reaches an edge meets the neighbouring
 * tile's own spoke there. There are no stubs into empty space to round off.
 *
 * **The consequence, stated rather than discovered:** a diagonal road's band is
 * 0.6 tiles wide and crosses a shared CORNER, so clipping removes the parts
 * that would fall in the two orthogonal neighbours and the band narrows toward
 * that corner. Correct — those neighbours may be plain grass — and inherent to
 * any cell-sized-tile atlas, not to this clip. It is a visual property of the
 * art, it is bounded by `0.3 * tileDevicePx` on each side, and the art pass
 * owns it. The alternative on offer was contaminating every blit.
 *
 * Mask 0 draws nothing, and that is correct rather than a gap: `state.roads`
 * uses 0 for "no road", so tile 0 is never blitted by a correct `drawFrame`.
 * It exists so the mask indexes the grid directly.
 *
 * The stroke state is set **once**, before the mask loop: it never varies per
 * tile, and 1,024 redundant property assignments on a real context are 1,024
 * chances to invalidate its state cache at boot. `save`/`restore` around each
 * tile restores exactly that state, so it never needs re-setting.
 *
 * `palette` defaults to `PALETTE` and is a parameter so the colour is not a
 * hidden global. **The colour is baked at build time** — `drawFrame(ctx, frame,
 * atlas, palette)` blits, and a blit cannot re-tint — so changing the road
 * colour means rebuilding the atlas. `Atlas.palette` carries the one it was
 * baked with so a caller can detect the mismatch. There is no palette switch in
 * M2.
 */
export function buildAtlas(
  createSurface: AtlasSurfaceFactory,
  tileDevicePx: number,
  palette: Palette = PALETTE,
): Atlas {
  assertTileSize(tileDevicePx)

  const sizePx = ATLAS_COLS * tileDevicePx
  assertAtlasDimension(sizePx, tileDevicePx)

  const surface = createSurface(sizePx, sizePx)
  assertSurfaceSize(surface, sizePx)

  const ctx = surface.getContext('2d')
  if (ctx === null) {
    throw new Error(
      'atlas: the surface returned no 2D context — on iOS this is how the platform reports ' +
        'having run out of canvas memory, and every road tile would be missing',
    )
  }

  const strokeWidthPx = ROAD_STROKE_FRACTION * tileDevicePx
  ctx.strokeStyle = palette.road
  ctx.lineWidth = strokeWidthPx
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const half = tileDevicePx / 2
  for (let mask = 0; mask < ATLAS_MASK_COUNT; mask++) {
    const originX = (mask % ATLAS_COLS) * tileDevicePx
    const originY = Math.floor(mask / ATLAS_COLS) * tileDevicePx
    const cx = originX + half
    const cy = originY + half

    // `save`/`rect`/`clip`/`restore` are issued for EVERY mask, including 0,
    // and so are `beginPath` and `stroke`. A stroke of an empty path is a
    // no-op on a real context, and the uniformity is what lets a recording
    // test read the log as 256 tile groups without knowing anything about
    // which masks are empty.
    ctx.save()
    ctx.beginPath()
    ctx.rect(originX, originY, tileDevicePx, tileDevicePx)
    ctx.clip()

    ctx.beginPath()
    for (let dir = 0; dir < ROAD_DIR_COUNT; dir++) {
      if ((mask & (1 << dir)) === 0) continue
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + (ROAD_DIR_DX[dir] as number) * half, cy + (ROAD_DIR_DY[dir] as number) * half)
    }
    ctx.stroke()
    ctx.restore()
  }

  return {
    surface,
    tileDevicePx,
    cols: ATLAS_COLS,
    widthPx: sizePx,
    heightPx: sizePx,
    strokeWidthPx,
    palette,
  }
}

/**
 * Source x of `mask`'s tile, in device px — the `sx` of Task 5's `drawImage`.
 *
 * Called once per drawn road cell per frame and **allocates nothing**. `mask`
 * is unvalidated on purpose: it comes from a `Uint8Array`, so it is already in
 * `[0, 255]` by construction, and a per-cell range check in the frame loop
 * would be paying for an impossibility.
 */
export function atlasSourceX(atlas: Atlas, mask: number): number {
  return (mask % ATLAS_COLS) * atlas.tileDevicePx
}

/** Source y of `mask`'s tile, in device px. See `atlasSourceX`. */
export function atlasSourceY(atlas: Atlas, mask: number): number {
  return Math.floor(mask / ATLAS_COLS) * atlas.tileDevicePx
}

/**
 * Compile-time pin for the production factory in this file's module comment: a
 * real `HTMLCanvasElement` satisfies `AtlasSurface`, and a real
 * `CanvasRenderingContext2D` satisfies `AtlasContext`.
 *
 * Without it, the injected-factory design is only proved against the test's own
 * recorder, and the first time anyone learns that a canvas does not fit the
 * interface is in `game` — or, if a cast papered over it there, on a device.
 *
 * **The `Assert<T extends true>` wrapper is load-bearing.** The obvious form,
 * `type X = HTMLCanvasElement extends AtlasSurface ? true : never`, pins
 * nothing: `never` is a perfectly good type and `tsc` is silent. The constraint
 * is what turns the `false` branch into an error, and it was verified by
 * breaking it — adding a member to `AtlasContext` that a real context does not
 * have fails `pnpm typecheck` here with TS2344.
 */
type Assert<T extends true> = T
export type _RealCanvasIsAnAtlasSurface = Assert<
  HTMLCanvasElement extends AtlasSurface ? true : false
>
export type _RealContextIsAnAtlasContext = Assert<
  CanvasRenderingContext2D extends AtlasContext ? true : false
>

