import { describe, it, expect } from 'vitest'
import {
  DPR_CAP_DEFAULT,
  DPR_CAP_LOW,
  HUD_BAND_CSS,
  createGridHit,
  createHudRects,
  createPoint,
  effectiveDpr,
  fitCamera,
  gridToScreen,
  gridToScreenX,
  gridToScreenY,
  hudRects,
  screenToGrid,
} from '../src/camera'
import { HitRegion, type Camera, type RevealedRect, type ViewportMetrics } from '../src/types'

/**
 * The camera is plan Decision 5's arithmetic, and the plan calls it "the bug
 * factory". Every expected number below is HAND-COMPUTED and written as a
 * literal — never recomputed from `fitCamera`, `gridToScreen` or any other
 * expression in `src/camera.ts`. An assertion checked against the expression
 * that produced the thing under test is the catalogue's "assertion checked
 * against the formula that produced it" shape, and on a pure-arithmetic module
 * it would pass under every mutation in the brief.
 *
 * The three fixtures are chosen so no single one can hide a variable:
 *
 *   - M0_DEVICE  — the measured device (406x870 CSS, insets 46/34, DPR 3).
 *                  WIDTH binds. originX is 0 here, which is exactly why it is
 *                  NOT the fixture used for the transforms.
 *   - PHONE_390  — 390x844, DPR 2.625 on a `LOW` client. WIDTH binds, and the
 *                  tile lands on 27 CSS px: one below spec 5.1's floor, taken
 *                  deliberately (see the test that records it). This is the
 *                  transform fixture: non-square viewport, originX (6) !=
 *                  originY (95), effective DPR neither 1 nor 2 (1.5), and the
 *                  canvas is offset from the viewport origin by a non-zero,
 *                  non-equal (40, 23).
 *   - SHORT_WIDE — 800x600. HEIGHT binds. The `min`'s other arm, and the ONLY
 *                  fixture that can see "forget to subtract the HUD band":
 *                  on the M0 device width binds either way and the tile stays
 *                  29 (870 - 46 - 34 = 790, 790/22 = 35 > 29).
 *
 * REVEALED_RECT uses the real constants (5, 9, 14, 22) as literals rather than
 * importing them: `render` imports nothing from `shared` (spec 4), which is
 * enforced by `test/boundary.test.ts`. The copy is deliberate and `game` is
 * where the two meet.
 */

const REVEALED_RECT: RevealedRect = { x0: 5, y0: 9, cols: 14, rows: 22 }

const M0_DEVICE: ViewportMetrics = {
  cssW: 406,
  cssH: 870,
  topInset: 46,
  bottomInset: 34,
  rawDpr: 3,
  performanceClass: null,
}

const PHONE_390: ViewportMetrics = {
  cssW: 390,
  cssH: 844,
  topInset: 47,
  bottomInset: 34,
  rawDpr: 2.625,
  performanceClass: 'LOW',
}

const SHORT_WIDE: ViewportMetrics = {
  cssW: 800,
  cssH: 600,
  topInset: 20,
  bottomInset: 10,
  rawDpr: 1,
  performanceClass: null,
}

/**
 * The transform fixture, spelled out as literals so every coordinate below can
 * be read against it without running `fitCamera`:
 *   tileSize 27, originX 6, originY 95, x0 5, y0 9, cols 14, rows 22, dpr 1.5
 *   grid rect: x in [6, 384) CSS, y in [95, 689) CSS
 *   HUD band:  y in [738, 810) CSS
 * The canvas itself sits at (40, 23) in client coordinates.
 */
const CANVAS_LEFT = 40
const CANVAS_TOP = 23

function phone390Camera(): Camera {
  return fitCamera(PHONE_390, REVEALED_RECT)
}

// ---------------------------------------------------------------------------
// effectiveDpr
// ---------------------------------------------------------------------------

describe('effectiveDpr — plan Decision 6, M0 section 7\'s only "Adopt now" row', () => {
  it('caps a DPR 3 iPhone at 2', () => {
    expect(effectiveDpr(3, null)).toBe(2)
  })

  it('caps a DPR 3 device at 1.5 when the client reports performanceClass LOW', () => {
    expect(effectiveDpr(3, 'LOW')).toBe(1.5)
  })

  it('leaves a raw ratio already below the universal cap alone', () => {
    expect(effectiveDpr(1, null)).toBe(1)
  })

  it("caps M0's own 1080p LOW-Android figure of 2.625 at 1.5", () => {
    expect(effectiveDpr(2.625, 'LOW')).toBe(1.5)
  })

  it('leaves a raw ratio already below the LOW cap alone — the cap is a ceiling, not an assignment', () => {
    // The case that separates `min(raw, cap)` from `cap`, and from
    // `max(raw, cap)`: both of those return 1.5 here.
    expect(effectiveDpr(1.25, 'LOW')).toBe(1.25)
  })

  it('applies the universal cap, not the LOW cap, to AVERAGE and HIGH', () => {
    // M0: LOW means Exynos-850 tier, a much narrower population than "cheap
    // phone". A `performanceClass !== null` test would pass while degrading
    // every Android; these two literals are what make the gate specific to LOW.
    expect(effectiveDpr(3, 'AVERAGE')).toBe(2)
    expect(effectiveDpr(3, 'HIGH')).toBe(2)
  })

  it('publishes the two caps as the literals M0 adopted', () => {
    expect(DPR_CAP_DEFAULT).toBe(2)
    expect(DPR_CAP_LOW).toBe(1.5)
  })
})

// ---------------------------------------------------------------------------
// fitCamera
// ---------------------------------------------------------------------------

describe('fitCamera — the revealed rect, insets and HUD band subtracted first', () => {
  it('fits the M0 device to 29 CSS px tiles, width binding', () => {
    // availableW = 406
    // availableH = 870 - 46 - 72 - 34 = 718
    // min(406/14, 718/22) = min(29.0, 32.6363...) = 29.0 -> floor 29
    // grid rect 14*29 = 406 wide, 22*29 = 638 tall
    // originX = floor((406 - 406)/2) = 0
    // originY = 46 + floor((718 - 638)/2) = 46 + 40 = 86
    // hudTop  = 870 - 34 - 72 = 764
    const cam = fitCamera(M0_DEVICE, REVEALED_RECT)
    expect(cam.tileSize).toBe(29)
    expect(cam.originX).toBe(0)
    expect(cam.originY).toBe(86)
    expect(cam.cols).toBe(14)
    expect(cam.rows).toBe(22)
    expect(cam.x0).toBe(5)
    expect(cam.y0).toBe(9)
    expect(cam.dpr).toBe(2)
    expect(cam.cssW).toBe(406)
    expect(cam.cssH).toBe(870)
    expect(cam.hudTop).toBe(764)
    expect(cam.hudHeight).toBe(72)
  })

  it('gives the M0 device a 406 x 638 CSS grid rect that clears the HUD band', () => {
    const cam = fitCamera(M0_DEVICE, REVEALED_RECT)
    expect(cam.cols * cam.tileSize).toBe(406)
    expect(cam.rows * cam.tileSize).toBe(638)
    // grid bottom 86 + 638 = 724, HUD top 764: 40 CSS px of letterbox between.
    expect(cam.originY + cam.rows * cam.tileSize).toBe(724)
    expect(cam.originY + cam.rows * cam.tileSize).toBeLessThanOrEqual(cam.hudTop)
  })

  it('fits a 390 x 844 phone to 27 CSS px tiles — ONE BELOW spec 5.1\'s 28 px floor, taken deliberately', () => {
    // availableW = 390
    // availableH = 844 - 47 - 72 - 34 = 691
    // min(390/14, 691/22) = min(27.857..., 31.409...) = 27.857... -> floor 27
    // grid rect 14*27 = 378 wide, 22*27 = 594 tall
    // originX = floor((390 - 378)/2) = 6
    // originY = 47 + floor((691 - 594)/2) = 47 + 48 = 95
    // hudTop  = 844 - 34 - 72 = 738
    //
    // Recorded, not a bug to fix (plan Decision 5): clamping to 28 would need
    // 14*28 = 392 CSS px of width on a 390 px viewport, so the outer columns
    // would overflow with no pan to reach them. Spec 5.1's floor governs the
    // zoom-out control M2b ships; M2's camera is fixed.
    const cam = fitCamera(PHONE_390, REVEALED_RECT)
    expect(cam.tileSize).toBe(27)
    expect(cam.tileSize).toBeLessThan(28)
    expect(cam.cols * cam.tileSize).toBe(378)
    expect(14 * 28).toBeGreaterThan(390) // the overflow that clamping would cause
    expect(cam.originX).toBe(6)
    expect(cam.originY).toBe(95)
    expect(cam.hudTop).toBe(738)
    expect(cam.dpr).toBe(1.5)
  })

  it('leaves tileSize x dpr non-integral on a LOW device, which is the accepted resample', () => {
    // Plan Decision 6, stated rather than discovered: at DPR 2 a 29 px tile is
    // 58 device px and blits land on exact device pixels; at 1.5 a 27 px tile
    // is 40.5, so the atlas is built at floor(tileSize * dpr) and blitted into
    // a tileSize CSS-px destination rect — slightly soft, on the class of
    // device that needs the pixels back.
    const cam = phone390Camera()
    expect(cam.tileSize * cam.dpr).toBe(40.5)
    expect(Number.isInteger(cam.tileSize * cam.dpr)).toBe(false)
    // The universal-cap case, for contrast: 29 * 2 = 58, exact.
    const m0 = fitCamera(M0_DEVICE, REVEALED_RECT)
    expect(Number.isInteger(m0.tileSize * m0.dpr)).toBe(true)
  })

  it('fits a short wide viewport to 22 CSS px tiles, HEIGHT binding', () => {
    // availableW = 800
    // availableH = 600 - 20 - 72 - 10 = 498
    // min(800/14, 498/22) = min(57.14..., 22.6363...) = 22.6363... -> floor 22
    // grid rect 14*22 = 308 wide, 22*22 = 484 tall
    // originX = floor((800 - 308)/2) = 246
    // originY = 20 + floor((498 - 484)/2) = 20 + 7 = 27
    // hudTop  = 600 - 10 - 72 = 518
    //
    // This is the only fixture that can see "forget to subtract the HUD band":
    // without it availableH = 570, 570/22 = 25.909... -> 25, not 22. On the M0
    // device the same mutation leaves the tile at 29 because width binds there.
    const cam = fitCamera(SHORT_WIDE, REVEALED_RECT)
    expect(cam.tileSize).toBe(22)
    expect(cam.originX).toBe(246)
    expect(cam.originY).toBe(27)
    expect(cam.hudTop).toBe(518)
    expect(cam.dpr).toBe(1)
    // Height really is the binding arm here: the width arm would have allowed 57.
    expect(Math.floor(800 / 14)).toBe(57)
  })

  it('rounds the tile DOWN, never to nearest — 27.857 is 27, and 22.636 is 22', () => {
    // Rounding to nearest gives 28 on the 390 phone (overflowing the viewport
    // by 2 CSS px with no pan to reach the lost columns) and 23 on the short
    // wide one (overflowing the available height by 22).
    expect(fitCamera(PHONE_390, REVEALED_RECT).tileSize).toBe(27)
    expect(fitCamera(SHORT_WIDE, REVEALED_RECT).tileSize).toBe(22)
  })

  it('keeps the whole grid rect inside the canvas and above the HUD band, on all three fixtures', () => {
    for (const view of [M0_DEVICE, PHONE_390, SHORT_WIDE]) {
      const cam = fitCamera(view, REVEALED_RECT)
      expect(cam.originX).toBeGreaterThanOrEqual(0)
      expect(cam.originY).toBeGreaterThanOrEqual(view.topInset)
      expect(cam.originX + cam.cols * cam.tileSize).toBeLessThanOrEqual(view.cssW)
      expect(cam.originY + cam.rows * cam.tileSize).toBeLessThanOrEqual(cam.hudTop)
    }
  })

  it('carries the revealed rect through unchanged rather than assuming a full-grid fit', () => {
    // A camera fitting the full 24x40 grid gives floor(min(406/24, 870/40)) =
    // 16 CSS px — 57% of spec 5.1's floor, and unreachable on any phone
    // (24 * 28 = 672 CSS px against 390-430 available). Decision 5 fits the
    // revealed rect instead, and this asserts the rect is the one supplied.
    const cam = fitCamera(M0_DEVICE, { x0: 3, y0: 7, cols: 10, rows: 12 })
    expect(cam.x0).toBe(3)
    expect(cam.y0).toBe(7)
    expect(cam.cols).toBe(10)
    expect(cam.rows).toBe(12)
    // 406/10 = 40.6, 718/12 = 59.83 -> 40
    expect(cam.tileSize).toBe(40)
  })

  it('floors BOTH origins to integers when the leftover is odd', () => {
    // Found by mutation, not by design: on all three fixtures above the
    // horizontal leftover is even (0, 12 and 492), so `Math.floor` on originX
    // was a 0-detector no-op and dropping it left all 81 tests green — while
    // dropping the same floor on originY was caught, because the 390 phone's
    // vertical leftover (97) is odd. One fixture per axis is not enough; the
    // fixture has to make the rounding VISIBLE on that axis.
    //
    // 391 CSS px wide: floor(391/14) = 27, grid 378, leftover 13, so the
    // untruncated centre would be 6.5. A fractional origin resamples every
    // tile on the board for half a pixel of centring, and at the LOW cap of
    // 1.5 it lands blits on thirds of a device pixel.
    const cam = fitCamera({ ...PHONE_390, cssW: 391 }, REVEALED_RECT)
    expect(cam.tileSize).toBe(27)
    expect(cam.originX).toBe(6)
    // 844 - 47 - 72 - 34 = 691; 691 - 594 = 97; 47 + floor(48.5) = 95
    expect(cam.originY).toBe(95)
    expect(Number.isInteger(cam.originX)).toBe(true)
    expect(Number.isInteger(cam.originY)).toBe(true)
  })

  it('never yields a tile below 1 CSS px, so screenToGrid cannot divide by zero', () => {
    // A transiently zero-height viewport (a hidden webview, a mid-rotation
    // measurement) would otherwise produce tileSize 0 and make every
    // screenToGrid a division by zero. Clamped rather than thrown: throwing
    // inside a viewport handler would kill the game over a transient.
    const cam = fitCamera({ ...M0_DEVICE, cssH: 0, cssW: 0 }, REVEALED_RECT)
    expect(cam.tileSize).toBe(1)
  })

  it('publishes the HUD band height as the literal the fit subtracts', () => {
    expect(HUD_BAND_CSS).toBe(72)
  })
})

// ---------------------------------------------------------------------------
// gridToScreen
// ---------------------------------------------------------------------------

describe('gridToScreen — board cell to CSS px, on the 27 px / origin (6, 95) fixture', () => {
  it('maps the revealed rect\'s first cell (x0, y0) = (5, 9) to the grid rect\'s top-left corner', () => {
    const cam = phone390Camera()
    const p = gridToScreen(cam, 5, 9, { x: 0, y: 0 })
    expect(p.x).toBe(6)
    expect(p.y).toBe(95)
  })

  it('maps the revealed rect\'s last cell (18, 30) to (357, 662)', () => {
    // x: 6 + (18 - 5) * 27 = 6 + 351 = 357
    // y: 95 + (30 - 9) * 27 = 95 + 567 = 662
    const cam = phone390Camera()
    const p = gridToScreen(cam, 18, 30, { x: 0, y: 0 })
    expect(p.x).toBe(357)
    expect(p.y).toBe(662)
  })

  it('maps an interior cell (8, 14) to (87, 230)', () => {
    // x: 6 + (8 - 5) * 27 = 6 + 81 = 87
    // y: 95 + (14 - 9) * 27 = 95 + 135 = 230
    // Asymmetric on purpose: a transposed axis would give (6 + 5*27, 95 + 3*27)
    // = (141, 176), and dropping x0/y0 would give (222, 473).
    const cam = phone390Camera()
    const p = gridToScreen(cam, 8, 14, { x: 0, y: 0 })
    expect(p.x).toBe(87)
    expect(p.y).toBe(230)
  })

  it('maps a FRACTIONAL grid position, which is how a car between cells is drawn', () => {
    // (x0 + 3.5, y0 + 7.25) = (8.5, 16.25)
    // x: 6 + 3.5 * 27 = 6 + 94.5 = 100.5
    // y: 95 + 7.25 * 27 = 95 + 195.75 = 290.75
    const cam = phone390Camera()
    const p = gridToScreen(cam, 8.5, 16.25, { x: 0, y: 0 })
    expect(p.x).toBe(100.5)
    expect(p.y).toBe(290.75)
  })

  it('exposes the same transform as two scalar functions, which is what the frame loop calls', () => {
    // `gridToScreen` needs a caller-provided `out` precisely so it cannot
    // allocate; the scalar pair is the form the draw loop actually uses.
    const cam = phone390Camera()
    expect(gridToScreenX(cam, 8)).toBe(87)
    expect(gridToScreenY(cam, 14)).toBe(230)
    expect(gridToScreenX(cam, 8.5)).toBe(100.5)
    expect(gridToScreenY(cam, 16.25)).toBe(290.75)
  })

  it('writes into the caller\'s object and returns it, allocating nothing', () => {
    // `createPoint` is the factory a caller uses once, outside the loop; the
    // `out` parameter has no default precisely so a per-call allocation is not
    // reachable by omission.
    const cam = phone390Camera()
    const out = createPoint()
    expect([out.x, out.y]).toEqual([0, 0])
    const returned = gridToScreen(cam, 8, 14, out)
    expect(returned).toBe(out)
    expect(out.x).toBe(87)
  })
})

// ---------------------------------------------------------------------------
// screenToGrid
// ---------------------------------------------------------------------------

describe('screenToGrid — CSS client px to board cell, canvas offset (40, 23)', () => {
  it('maps the exact centre of tile (8, 14) to that tile', () => {
    // tile (8,14) covers CSS x in [87, 114), y in [230, 257)
    // centre CSS (100.5, 243.5) -> client (140.5, 266.5)
    // The centre is chosen because (100.5 - 6)/27 = 3.5 exactly: rounding to
    // nearest instead of flooring gives column 4, i.e. cell (9, 14).
    const cam = phone390Camera()
    const hit = screenToGrid(cam, 140.5, 266.5, CANVAS_LEFT, CANVAS_TOP, createGridHit())
    expect(hit.region).toBe(HitRegion.GRID)
    expect(hit.gx).toBe(8)
    expect(hit.gy).toBe(14)
  })

  it('maps a point one CSS px inside each of that tile\'s four edges to the same tile', () => {
    const cam = phone390Camera()
    const out = createGridHit()
    // left edge   CSS x 87 -> 88   -> client 128
    // right edge  CSS x 114 -> 113 -> client 153
    // top edge    CSS y 230 -> 231 -> client 254
    // bottom edge CSS y 257 -> 256 -> client 279
    for (const [cx, cy, label] of [
      [128, 266.5, 'one px inside the left edge'],
      [153, 266.5, 'one px inside the right edge'],
      [140.5, 254, 'one px inside the top edge'],
      [140.5, 279, 'one px inside the bottom edge'],
    ] as const) {
      screenToGrid(cam, cx, cy, CANVAS_LEFT, CANVAS_TOP, out)
      expect(out.region, label).toBe(HitRegion.GRID)
      expect([out.gx, out.gy], label).toEqual([8, 14])
    }
  })

  it('maps a point one CSS px OUTSIDE each of those edges to the neighbouring tile', () => {
    // Without this, "inside the edges" is satisfied by a transform that maps
    // half the board onto one tile.
    const cam = phone390Camera()
    const out = createGridHit()
    for (const [cx, cy, gx, gy, label] of [
      [126, 266.5, 7, 14, 'one px left of the left edge'],
      [154, 266.5, 9, 14, 'on the right edge, which belongs to the next tile'],
      [140.5, 252, 8, 13, 'one px above the top edge'],
      [140.5, 280, 8, 15, 'on the bottom edge, which belongs to the next tile'],
    ] as const) {
      screenToGrid(cam, cx, cy, CANVAS_LEFT, CANVAS_TOP, out)
      expect(out.region, label).toBe(HitRegion.GRID)
      expect([out.gx, out.gy], label).toEqual([gx, gy])
    }
  })

  it('maps the grid rect\'s own corners to the first and last revealed cells', () => {
    // top-left CSS (6, 95) -> client (46, 118) -> (5, 9)
    // bottom-right-most CSS px (383, 688) -> client (423, 711) -> (18, 30)
    const cam = phone390Camera()
    const a = screenToGrid(cam, 46, 118, CANVAS_LEFT, CANVAS_TOP, createGridHit())
    expect([a.region, a.gx, a.gy]).toEqual([HitRegion.GRID, 5, 9])
    const b = screenToGrid(cam, 423, 711, CANVAS_LEFT, CANVAS_TOP, createGridHit())
    expect([b.region, b.gx, b.gy]).toEqual([HitRegion.GRID, 18, 30])
  })

  it('subtracts the canvas offset — the same client point on an unoffset canvas is a DIFFERENT cell', () => {
    // The offset (40, 23) is larger than one tile on x and most of one on y,
    // so dropping either changes the answer at the tile centre rather than
    // only at a boundary. Dropping rect.left: (140.5 - 6)/27 = 4.98 -> col 4,
    // cell (9, 14). Dropping rect.top: (266.5 - 95)/27 = 6.35 -> row 6, (8, 15).
    const cam = phone390Camera()
    const offset = screenToGrid(cam, 140.5, 266.5, CANVAS_LEFT, CANVAS_TOP, createGridHit())
    const unoffset = screenToGrid(cam, 140.5, 266.5, 0, 0, createGridHit())
    expect([offset.gx, offset.gy]).toEqual([8, 14])
    expect([unoffset.gx, unoffset.gy]).toEqual([9, 15])
  })

  it('reports a point above the grid rect as ABOVE, not as a cell', () => {
    // CSS y 94, one px above originY 95 -> client y 117
    //
    // The `out` object is DELIBERATELY reused after a successful grid hit. A
    // fresh `createGridHit()` already carries gx = gy = -1, so a miss path that
    // forgot to clear them would pass — and the caller's object is reused
    // across every pointer event, so the stale cell it would leave behind is
    // exactly the one the last successful tap returned.
    const cam = phone390Camera()
    const out = createGridHit()
    screenToGrid(cam, 140.5, 266.5, CANVAS_LEFT, CANVAS_TOP, out)
    expect([out.region, out.gx, out.gy]).toEqual([HitRegion.GRID, 8, 14])

    const hit = screenToGrid(cam, 140.5, 117, CANVAS_LEFT, CANVAS_TOP, out)
    expect(hit.region).toBe(HitRegion.ABOVE)
    expect(hit.gx).toBe(-1)
    expect(hit.gy).toBe(-1)
  })

  it('reports a point below the grid rect but above the HUD band as BELOW', () => {
    // grid bottom CSS 689, HUD top CSS 738. CSS y 700 -> client 723.
    const cam = phone390Camera()
    const hit = screenToGrid(cam, 140.5, 723, CANVAS_LEFT, CANVAS_TOP, createGridHit())
    expect(hit.region).toBe(HitRegion.BELOW)
  })

  it('reports a point inside the HUD band as HUD, distinguishably from BELOW', () => {
    // CSS y 750 (inside [738, 810)) -> client 773
    const cam = phone390Camera()
    const hit = screenToGrid(cam, 140.5, 773, CANVAS_LEFT, CANVAS_TOP, createGridHit())
    expect(hit.region).toBe(HitRegion.HUD)
    expect(hit.region).not.toBe(HitRegion.BELOW)
  })

  it('reports the bottom inset, below the HUD band, as BELOW rather than HUD', () => {
    // CSS y 820 (past the band's bottom edge at 810) -> client 843. The band
    // is where the HUD is DRAWN and tapped; the inset below it is the home
    // indicator's, and a tap there must not toggle pause.
    const cam = phone390Camera()
    const hit = screenToGrid(cam, 140.5, 843, CANVAS_LEFT, CANVAS_TOP, createGridHit())
    expect(hit.region).toBe(HitRegion.BELOW)
  })

  it('reports points left and right of the letterboxed grid rect distinguishably', () => {
    // grid rect x in [6, 384) CSS. CSS x 5 -> client 45; CSS x 384 -> client 424.
    const cam = phone390Camera()
    const left = screenToGrid(cam, 45, 266.5, CANVAS_LEFT, CANVAS_TOP, createGridHit())
    const right = screenToGrid(cam, 424, 266.5, CANVAS_LEFT, CANVAS_TOP, createGridHit())
    expect(left.region).toBe(HitRegion.LEFT)
    expect(right.region).toBe(HitRegion.RIGHT)
  })

  it('writes into the caller\'s object and returns it, allocating nothing', () => {
    const cam = phone390Camera()
    const out = createGridHit()
    const returned = screenToGrid(cam, 140.5, 266.5, CANVAS_LEFT, CANVAS_TOP, out)
    expect(returned).toBe(out)
    expect(out.gx).toBe(8)
  })

  it('round-trips every cell in the revealed rect through the tile centre', () => {
    // Kept as a cheap extra and NOT RELIED ON as the primary constraint — the
    // hand-computed literals above are what actually pin the transform.
    //
    // The brief's stated REASON for distrusting it is measurably wrong on this
    // implementation, and the correction is worth recording rather than
    // quietly benefiting from. The brief says the round trip "is self-inverse
    // and survives any error applied consistently to a shared transform — a
    // swapped axis, a dropped origin, a dropped x0". All three were built and
    // run here, and all three FAILED this test:
    //
    //   drop x0 in gridToScreenX AND screenToGrid  -> caught (region RIGHT)
    //   drop originY in both directions            -> caught (region ABOVE)
    //   transpose x/y in both directions           -> caught
    //
    // The inverse property really does survive them — the arithmetic still
    // round-trips — but `screenToGrid` does not only invert: it also
    // CLASSIFIES the point against the grid rect, and that classification is
    // built from the unmutated `originX`/`cols`/`rows`. A consistent offset
    // error pushes the far cells outside the rect the classifier still
    // believes in, so the pair stops agreeing. Recorded because the honest
    // reading is "this test is stronger than the brief credits, for a reason
    // the brief did not model", not "the brief was right and we got lucky".
    const cam = phone390Camera()
    const p = { x: 0, y: 0 }
    const hit = createGridHit()
    let checked = 0
    for (let gy = cam.y0; gy < cam.y0 + cam.rows; gy++) {
      for (let gx = cam.x0; gx < cam.x0 + cam.cols; gx++) {
        gridToScreen(cam, gx, gy, p)
        const centreX = p.x + cam.tileSize / 2
        const centreY = p.y + cam.tileSize / 2
        screenToGrid(cam, centreX + CANVAS_LEFT, centreY + CANVAS_TOP, CANVAS_LEFT, CANVAS_TOP, hit)
        expect([hit.region, hit.gx, hit.gy]).toEqual([HitRegion.GRID, gx, gy])
        checked++
      }
    }
    expect(checked).toBe(14 * 22) // vacuity: the loop actually ran over 308 cells
  })
})

// ---------------------------------------------------------------------------
// hudRects
// ---------------------------------------------------------------------------

describe('hudRects — three elements, all inside the HUD band and below the grid rect', () => {
  it('lays out the three rects at hand-computed coordinates on the 390 px fixture', () => {
    // cssW 390, hudTop 738, hudHeight 72, pad 8, gap 8
    // usable width 390 - 16 = 374; colW = floor((374 - 16)/3) = floor(119.33) = 119
    // y = 738 + 8 = 746; h = 72 - 16 = 56
    // clock x 8; score x 8 + 119 + 8 = 135; tiles x 135 + 119 + 8 = 262
    const r = hudRects(phone390Camera(), createHudRects())
    expect([r.clock.x, r.clock.y, r.clock.w, r.clock.h]).toEqual([8, 746, 119, 56])
    expect([r.score.x, r.score.y, r.score.w, r.score.h]).toEqual([135, 746, 119, 56])
    expect([r.tiles.x, r.tiles.y, r.tiles.w, r.tiles.h]).toEqual([262, 746, 119, 56])
  })

  it('lays them out against the M0 device\'s wider band too', () => {
    // cssW 406, hudTop 764: usable 390; colW = floor((390 - 16)/3) = 124
    // y = 772; h = 56; x = 8, 140, 272
    const r = hudRects(fitCamera(M0_DEVICE, REVEALED_RECT), createHudRects())
    expect([r.clock.x, r.clock.y, r.clock.w, r.clock.h]).toEqual([8, 772, 124, 56])
    expect(r.score.x).toBe(140)
    expect(r.tiles.x).toBe(272)
  })

  it('keeps every rect entirely inside the HUD band and entirely below the grid rect', () => {
    for (const view of [M0_DEVICE, PHONE_390, SHORT_WIDE]) {
      const cam = fitCamera(view, REVEALED_RECT)
      const r = hudRects(cam, createHudRects())
      const gridBottom = cam.originY + cam.rows * cam.tileSize
      for (const [name, rect] of [
        ['clock', r.clock],
        ['score', r.score],
        ['tiles', r.tiles],
      ] as const) {
        expect(rect.y, `${name} starts above the HUD band`).toBeGreaterThanOrEqual(cam.hudTop)
        expect(rect.y + rect.h, `${name} runs past the HUD band`).toBeLessThanOrEqual(
          cam.hudTop + cam.hudHeight,
        )
        expect(rect.x, `${name} starts left of the canvas`).toBeGreaterThanOrEqual(0)
        expect(rect.x + rect.w, `${name} runs past the canvas`).toBeLessThanOrEqual(cam.cssW)
        expect(rect.y, `${name} overlaps the grid rect`).toBeGreaterThanOrEqual(gridBottom)
        expect(rect.w, `${name} is empty`).toBeGreaterThan(0)
        expect(rect.h, `${name} is empty`).toBeGreaterThan(0)
      }
    }
  })

  it('never overlaps its own three rects', () => {
    const r = hudRects(phone390Camera(), createHudRects())
    expect(r.clock.x + r.clock.w).toBeLessThanOrEqual(r.score.x)
    expect(r.score.x + r.score.w).toBeLessThanOrEqual(r.tiles.x)
  })

  it('puts every rect in the HUD region as screenToGrid classifies it', () => {
    // The two functions must agree, because `pointer.ts` hit-tests hudRects
    // first and falls through to screenToGrid: a rect the transform calls
    // BELOW would be a HUD element the board also answers for.
    const cam = phone390Camera()
    const r = hudRects(cam, createHudRects())
    const hit = createGridHit()
    for (const rect of [r.clock, r.score, r.tiles]) {
      for (const [px, py] of [
        [rect.x, rect.y],
        [rect.x + rect.w - 1, rect.y + rect.h - 1],
      ] as const) {
        screenToGrid(cam, px + CANVAS_LEFT, py + CANVAS_TOP, CANVAS_LEFT, CANVAS_TOP, hit)
        expect(hit.region).toBe(HitRegion.HUD)
      }
    }
  })

  it('writes into the caller\'s object and returns it, allocating nothing', () => {
    const cam = phone390Camera()
    const out = createHudRects()
    const clock = out.clock
    const returned = hudRects(cam, out)
    expect(returned).toBe(out)
    expect(returned.clock).toBe(clock) // the nested rects are reused, not replaced
  })
})
