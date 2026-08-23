import { HitRegion } from './types'
import type {
  Camera,
  GridHit,
  HudRects,
  OfferRects,
  PerformanceClass,
  Point,
  Rect,
  RevealedRect,
  ViewportMetrics,
} from './types'

/**
 * The camera: plan Decision 5's fit, both directions of its transform, the HUD
 * band layout, and plan Decision 6's DPR cap.
 *
 * **One module owns both directions.** `screenToGrid` is the exact inverse of
 * `gridToScreen`, they live in this file, and `game/pointer.ts` imports the
 * inverse rather than writing a second one. `game` already depends on `render`,
 * so this inverts no dependency.
 *
 * **Everything here is CSS pixels, and `screenToGrid` contains no DPR term.**
 * Pointer events deliver CSS px in `clientX`/`clientY`, the tile size is an
 * integer CSS px, and the canvas backing store is scaled once with
 * `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` so all drawing is in CSS units too.
 * A DPR divide anywhere in `screenToGrid` is a real bug on every phone with a
 * ratio other than 1.
 *
 * **Nothing here allocates**, because `gridToScreen`, `screenToGrid` and
 * `hudRects` are called from the frame loop and from pointer handlers. Each
 * takes a caller-owned output object and returns it; there is no default, so a
 * caller cannot accidentally allocate one per call.
 */

/**
 * The HUD band's height in CSS px, **subtracted from the available height
 * before the fit**. That subtraction is what makes the HUD non-overlapping by
 * construction rather than by hoping the letterbox is big enough. The art pass
 * may change the number; it may not change the rule.
 */
export const HUD_BAND_CSS = 72

/** Inset from the HUD band's edges to its content, CSS px. */
export const HUD_PAD_CSS = 8

/** Gap between two adjacent HUD elements, CSS px. */
export const HUD_GAP_CSS = 8

/**
 * The universal device-pixel-ratio cap. M0 §7's decision table has exactly one
 * row marked **Adopt now** and this is it: *"the lever is DPR, not sprite
 * count"*. On the one device M0 measured (DPR 3) the cap removes 55% of every
 * fill and blit, and takes the atlas from 7.75 MiB to 3.44 MiB at a 29 px tile.
 */
export const DPR_CAP_DEFAULT = 2

/**
 * The cap on a Telegram-Android client reporting `performanceClass === 'LOW'`.
 * M0: ~5 ms vs ~8.5 ms at 400 sprites, "the difference between clearing and
 * blowing the budget. Zero bytes, largest single lever available."
 *
 * **The cost, stated rather than discovered** (plan Decision 6): at DPR 2 a 29
 * px tile is 58 device px, an integer, so blits land on exact device pixels. At
 * 1.5 a 29 px tile is 43.5 and a 27 px tile is 40.5, so the atlas is built at
 * `floor(tileSize * dpr)` and blitted into a `tileSize` CSS-px destination rect
 * — a resample, slightly soft, on exactly the class of device that needs the
 * pixels back. That is the accepted trade.
 *
 * Untested on hardware and will stay so until someone runs the deploy on a
 * `LOW` Android: `performanceClass` is Android-only and reads `null` on every
 * iOS device. M0 could not obtain one either. The universal cap above is the
 * part doing most of the work — M0's own note is that `LOW` means Exynos 850
 * tier, a much narrower population than "cheap phone".
 */
export const DPR_CAP_LOW = 1.5

/**
 * Plan Decision 6, in one line: `min(rawDpr, LOW ? 1.5 : 2)`.
 *
 * A ceiling, never an assignment — a device already below the cap keeps its own
 * ratio, which is what separates this from `dpr = cap` and from `max`.
 */
export function effectiveDpr(rawDpr: number, performanceClass: PerformanceClass | null): number {
  return Math.min(rawDpr, performanceClass === 'LOW' ? DPR_CAP_LOW : DPR_CAP_DEFAULT)
}

/**
 * Fits the **revealed rect** — not the full grid — into the viewport, with the
 * safe-area insets and the HUD band subtracted first (plan Decision 5):
 *
 * ```
 * availableW = cssW
 * availableH = cssH - topInset - HUD_BAND_CSS - bottomInset
 * tileSize   = floor(min(availableW / cols, availableH / rows))     // integer CSS px
 * ```
 *
 * The grid rect is centred horizontally in the canvas and centred vertically in
 * what is left between the top inset and the HUD band. The leftover is
 * background.
 *
 * **Both origins are floored to integers.** `tileSize` is already an integer
 * CSS px, so an integral origin keeps every tile boundary integral, and at the
 * universal DPR cap of 2 every device-pixel boundary integral too. A fractional
 * origin would resample the whole board for a half-pixel of centring.
 *
 * On the M0 device (406x870, insets 46/34) this gives **29 CSS px tiles**, a
 * 406x638 grid rect at (0, 86). **On a 390 CSS px viewport it gives 27 — one
 * below spec §5.1's 28 px floor**, and the plan takes that deliberately rather
 * than clamping to 28 and letting the outer columns overflow a viewport with no
 * pan to reach them (14 * 28 = 392 > 390). §5.1's floor governs the zoom-out
 * control M2b ships; recording the 1 px shortfall is the honest reading.
 *
 * `tileSize` is clamped to at least 1. A transiently zero-height viewport — a
 * hidden webview, a measurement taken mid-rotation — would otherwise yield 0 or
 * a negative tile and make every later `screenToGrid` a division by zero.
 * Clamped rather than thrown, because throwing inside a viewport handler kills
 * the game over a transient.
 *
 * This is the one function in the module that allocates, and it is allowed to:
 * it runs at boot, after the fullscreen settle, and on a *stable*
 * `viewportChanged` — never per frame (spec §8.3, plan Decision 5).
 */
export function fitCamera(view: ViewportMetrics, reveal: RevealedRect): Camera {
  const availableW = view.cssW
  const availableH = view.cssH - view.topInset - HUD_BAND_CSS - view.bottomInset

  const tileSize = Math.max(
    1,
    Math.floor(Math.min(availableW / reveal.cols, availableH / reveal.rows)),
  )

  const gridWidth = reveal.cols * tileSize
  const gridHeight = reveal.rows * tileSize
  const originY = view.topInset + Math.floor((availableH - gridHeight) / 2)

  return {
    tileSize,
    originX: Math.floor((view.cssW - gridWidth) / 2),
    originY,
    x0: reveal.x0,
    y0: reveal.y0,
    cols: reveal.cols,
    rows: reveal.rows,
    dpr: effectiveDpr(view.rawDpr, view.performanceClass),
    cssW: view.cssW,
    cssH: view.cssH,
    // `Math.max` is INERT on every viewport that fits: `hudTop` is
    // `topInset + availableH` and `originY + gridHeight` is at most
    // `topInset + availableH/2 + gridHeight/2 <= topInset + availableH`, so the
    // band already clears the grid rect whenever `tileSize` was not clamped.
    // The clamp above is the one case that breaks it — on a transiently
    // zero-sized viewport the plain formula puts `hudTop` ABOVE the grid rect,
    // and because `screenToGrid` tests the HUD band before the grid-bottom
    // check, grid rows would classify as HUD. Making the invariant hold by
    // construction is one expression; relying on "a hidden webview receives no
    // taps" is a platform assumption.
    //
    // **It is load-bearing for a second consumer that did not exist when this
    // was written: Task 5's band tiling.** `drawFrame` fills `[originY, hudTop)`
    // as one opaque band, so `hudTop < originY` on a clamped viewport is a
    // negative-height fill and the three bands stop partitioning the canvas.
    // `canvas.ts` clamps its own edges too, but this `max` is what keeps the
    // ordering true at the source. Two callers, one expression.
    hudTop: Math.max(originY + gridHeight, view.cssH - view.bottomInset - HUD_BAND_CSS),
    hudHeight: HUD_BAND_CSS,
  }
}

/**
 * Board column -> CSS px of that column's **left edge**, relative to the canvas.
 *
 * `gx` may be fractional: a car between two cells is resolved to grid-cell
 * units by `game` before the frame is handed over, and drawing it is this same
 * multiply. There is no notion of interpolation alpha anywhere in `render`.
 */
export function gridToScreenX(camera: Camera, gx: number): number {
  return camera.originX + (gx - camera.x0) * camera.tileSize
}

/** Board row -> CSS px of that row's **top edge**, relative to the canvas. */
export function gridToScreenY(camera: Camera, gy: number): number {
  return camera.originY + (gy - camera.y0) * camera.tileSize
}

/**
 * Board cell -> the CSS px of its top-left corner, written into `out`.
 *
 * `out` is required rather than defaulted so this cannot allocate inside the
 * frame loop. The scalar pair above is the form the draw loop actually calls.
 */
export function gridToScreen(camera: Camera, gx: number, gy: number, out: Point): Point {
  out.x = gridToScreenX(camera, gx)
  out.y = gridToScreenY(camera, gy)
  return out
}

/** A `Point` for `gridToScreen` to write into. Allocate once, outside the loop. */
export function createPoint(): Point {
  return { x: 0, y: 0 }
}

/** A `GridHit` for `screenToGrid` to write into. Allocate once, outside the loop. */
export function createGridHit(): GridHit {
  return { region: HitRegion.ABOVE, gx: -1, gy: -1 }
}

/**
 * The exact inverse of `gridToScreen`: a CSS-pixel **client** point (what
 * `PointerEvent.clientX`/`clientY` deliver) -> the board cell under it, written
 * into `out`.
 *
 * `canvasLeft`/`canvasTop` are the canvas's own `getBoundingClientRect()`
 * offset, measured once and cached — the call allocates a `DOMRect`, so it must
 * not happen per event. Dropping it is a real bug on every letterboxed or
 * offset canvas, which is why it is a parameter here rather than an assumption.
 *
 * **No DPR term appears anywhere in this function**, deliberately. See the
 * module comment.
 *
 * When the point is not a grid cell, `out.gx`/`out.gy` are set to -1 and
 * `out.region` says which way it missed. The classification order is: above the
 * grid rect first, then the HUD band, then anything else below the grid rect,
 * then left/right of the letterboxed rect. The HUD band is tested before the
 * general "below" case because it is a strict subset of it.
 */
export function screenToGrid(
  camera: Camera,
  clientX: number,
  clientY: number,
  canvasLeft: number,
  canvasTop: number,
  out: GridHit,
): GridHit {
  const cssX = clientX - canvasLeft
  const cssY = clientY - canvasTop

  out.gx = -1
  out.gy = -1

  if (cssY < camera.originY) {
    out.region = HitRegion.ABOVE
    return out
  }
  if (cssY >= camera.hudTop && cssY < camera.hudTop + camera.hudHeight) {
    out.region = HitRegion.HUD
    return out
  }
  if (cssY >= camera.originY + camera.rows * camera.tileSize) {
    out.region = HitRegion.BELOW
    return out
  }
  if (cssX < camera.originX) {
    out.region = HitRegion.LEFT
    return out
  }
  if (cssX >= camera.originX + camera.cols * camera.tileSize) {
    out.region = HitRegion.RIGHT
    return out
  }

  out.region = HitRegion.GRID
  out.gx = camera.x0 + Math.floor((cssX - camera.originX) / camera.tileSize)
  out.gy = camera.y0 + Math.floor((cssY - camera.originY) / camera.tileSize)
  return out
}

/** A `HudRects` for `hudRects` to write into. Allocate once, outside the loop. */
export function createHudRects(): HudRects {
  return {
    clock: { x: 0, y: 0, w: 0, h: 0 },
    score: { x: 0, y: 0, w: 0, h: 0 },
    tiles: { x: 0, y: 0, w: 0, h: 0 },
  }
}

/**
 * Lays spec §7.2's three HUD elements across the HUD band as three equal
 * columns, written into `out`'s existing rects — the nested `Rect`s are reused,
 * never replaced, so this allocates nothing.
 *
 * All three sit in the **bottom** band, thumb-reachable, and the top band gets
 * nothing at all: §7.2 puts the clock at the top and §8.3 forbids any
 * interactive element there, and M2 resolves that toward §8.3 because it is a
 * platform fact and §7.2 is a preference.
 *
 * Every rect is inside the band by construction, and the band is below the grid
 * rect by construction — `fitCamera` subtracted `HUD_BAND_CSS` before fitting.
 * That the two never overlap is therefore a property of the fit, not of this
 * function, which is why `pointer.ts` still asserts its hit-test ordering
 * (Task 7): a change to `fitCamera` must not silently make the board eat pause
 * taps.
 */
export function hudRects(camera: Camera, out: HudRects): HudRects {
  const y = camera.hudTop + HUD_PAD_CSS
  const h = camera.hudHeight - 2 * HUD_PAD_CSS
  const w = Math.floor((camera.cssW - 2 * HUD_PAD_CSS - 2 * HUD_GAP_CSS) / 3)
  const stride = w + HUD_GAP_CSS

  // Written out rather than looped over `[out.clock, out.score, out.tiles]`:
  // that array literal is itself an allocation, once per call, in a function
  // whose whole point is not to allocate.
  //
  // This comment used to end "caught by review of this file, not by a test —
  // there is no allocation profiler in this toolchain". That claim was false
  // and has now been refuted twice; `packages/game/test/allocation.test.ts`
  // profiles this call under a live drag through `pointer.ts` and holds it to
  // the same budget as everything else.
  setRect(out.clock, HUD_PAD_CSS, y, w, h)
  setRect(out.score, HUD_PAD_CSS + stride, y, w, h)
  setRect(out.tiles, HUD_PAD_CSS + 2 * stride, y, w, h)
  return out
}

function setRect(rect: Rect, x: number, y: number, w: number, h: number): void {
  rect.x = x
  rect.y = y
  rect.w = w
  rect.h = h
}

// ---------------------------------------------------------------------------
// §5.10's offer modal — M1f Task 8
// ---------------------------------------------------------------------------

/** The modal's inset from the left and right canvas edges, CSS px. */
export const OFFER_MARGIN_CSS = 16

/** Vertical gap between the modal's stacked pieces, CSS px. */
export const OFFER_GAP_CSS = 12

/**
 * The strip reserved above the two cards for the modal's one instruction line,
 * CSS px. It is not a `Rect` because nothing taps it — `offerRects` reserves the
 * space and `canvas.ts` draws the line one gap above `cardA`.
 */
export const OFFER_TITLE_H_CSS = 28

/**
 * The peek control's size, CSS px. **44 is a touch target and not a look** — the
 * same figure `eraseControl.ts`'s fallback pill is built to, and the reason a
 * DOM strip below the canvas was rejected there (`fitCamera` leaves 40-49 px of
 * free strip, which is not a location on a phone).
 */
export const OFFER_PEEK_W_CSS = 132
export const OFFER_PEEK_H_CSS = 44

/** An `OfferRects` for `offerRects` to write into. Allocate once, outside the loop. */
export function createOfferRects(): OfferRects {
  return {
    cardA: { x: 0, y: 0, w: 0, h: 0 },
    cardB: { x: 0, y: 0, w: 0, h: 0 },
    peek: { x: 0, y: 0, w: 0, h: 0 },
  }
}

function clampTo(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

/**
 * Lays §5.10's offer modal out: **two full-width cards stacked vertically with
 * the peek control under them**, written into `out`'s existing rects — the
 * nested `Rect`s are reused, never replaced, so this allocates nothing.
 *
 * **The modal occupies the BOARD's band, `[originY, hudTop)`, and not the whole
 * canvas — while the scrim behind it covers the whole canvas.** The two are
 * deliberately different, and the difference is the point:
 *
 * - The **scrim** runs edge to edge because the HUD clock is a pause TOGGLE, and
 *   a legible pause control under a modal that forbids skipping is an invitation
 *   to press something that does nothing. (`drawShutdown` makes the opposite
 *   choice for the opposite reason: its screen wants the HUD readable, because
 *   the score is part of what it is telling you.)
 * - The **rects** stay off the HUD band and off the top safe-area inset, because
 *   a tappable card under the notch or overlapping the clock is a target the
 *   player cannot reliably hit. `originY` already carries the top inset and
 *   `hudTop` already carries the bottom one, so no inset arithmetic is repeated
 *   here.
 *
 * **Every edge is clamped into `[0, cssW] x [0, cssH]` and the vertical run is
 * kept monotone**, for the same reason `canvas.ts` clamps its band fills: on the
 * degenerate viewports `fitCamera` deliberately survives (a hidden webview, a
 * measurement mid-rotation) the plain formula puts `originY` at -47 and `hudTop`
 * at -25, both off the canvas. Clamped, every rect collapses to zero area at the
 * origin — no negative-height fill, no off-canvas touch target, and the modal
 * simply has nowhere to be, which is the honest answer for a viewport with no
 * pixels. `camera.test.ts` asserts that outcome explicitly rather than letting
 * it pass as a vacuous "nothing overlaps".
 *
 * The peek control keeps the whole strip when the space runs out before the
 * cards do: the way OUT of a modal is the last thing to be given up.
 */
export function offerRects(camera: Camera, out: OfferRects): OfferRects {
  const top = clampTo(camera.originY, 0, camera.cssH)
  const bottom = clampTo(camera.hudTop, top, camera.cssH)
  const innerH = bottom - top

  const left = clampTo(OFFER_MARGIN_CSS, 0, camera.cssW / 2)
  const innerW = camera.cssW - 2 * left

  const titleH = OFFER_TITLE_H_CSS < innerH ? OFFER_TITLE_H_CSS : innerH
  const peekH = OFFER_PEEK_H_CSS < innerH ? OFFER_PEEK_H_CSS : innerH
  const peekW = OFFER_PEEK_W_CSS < innerW ? OFFER_PEEK_W_CSS : innerW
  // Three gaps: title-to-A, A-to-B, B-to-peek. `Math.max` rather than a clamp
  // because a viewport too short for the chrome gives a negative numerator, and
  // `floor(-32 / 2)` is -16 — a negative height, which is the one thing a rect
  // in this file must never carry.
  const cardH = Math.floor(Math.max(0, innerH - titleH - peekH - 3 * OFFER_GAP_CSS) / 2)

  const aY = clampTo(top + titleH + OFFER_GAP_CSS, top, bottom)
  const bY = clampTo(aY + cardH + OFFER_GAP_CSS, top, bottom)
  const pY = clampTo(bottom - peekH, top, bottom)

  setRect(out.cardA, left, aY, innerW, clampTo(cardH, 0, bottom - aY))
  setRect(out.cardB, left, bY, innerW, clampTo(cardH, 0, bottom - bY))
  setRect(out.peek, left + Math.floor((innerW - peekW) / 2), pY, peekW, clampTo(peekH, 0, bottom - pY))
  return out
}
