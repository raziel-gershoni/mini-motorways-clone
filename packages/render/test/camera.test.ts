import { describe, it, expect } from 'vitest'
import {
  CHIP_MIN_CSS,
  DPR_CAP_DEFAULT,
  DPR_CAP_LOW,
  HUD_BAND_CSS,
  HUD_GAP_CSS,
  HUD_PAD_CSS,
  OFFER_CARD_MAX_H_CSS,
  OFFER_GAP_CSS,
  OFFER_MARGIN_CSS,
  OFFER_PEEK_H_CSS,
  OFFER_PEEK_W_CSS,
  OFFER_TITLE_H_CSS,
  createGridHit,
  createHudRects,
  createOfferRects,
  createPoint,
  effectiveDpr,
  fitCamera,
  gridToScreen,
  gridToScreenX,
  gridToScreenY,
  hudRects,
  offerRects,
  screenToGrid,
} from '../src/camera'
import {
  HitRegion,
  type Camera,
  type GridHit,
  type HudRects,
  type OfferRects,
  type Rect,
  type RevealedRect,
  type ViewportMetrics,
} from '../src/types'

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

  it('keeps the HUD band below the grid rect even on the degenerate viewport', () => {
    // Review finding M3. `tileSize` clamping to 1 is the ONE case in which the
    // plain `cssH - bottomInset - HUD_BAND_CSS` puts the band ABOVE the grid
    // rect: at 0x0 it gives hudTop -106 against a grid rect at y in [-41, -19).
    // And because screenToGrid tests the HUD band before the grid-bottom check,
    // seven of the grid rect's 22 rows then classify as HUD — measured, not
    // hypothesised. "A hidden webview receives no taps" is a platform
    // assumption; the Math.max in fitCamera makes it an invariant instead.
    //
    // Asserting only `tileSize === 1` above was not enough: the clamp prevented
    // the division by zero and left the layout incoherent.
    const cam = fitCamera({ ...M0_DEVICE, cssH: 0, cssW: 0 }, REVEALED_RECT)
    expect(cam.originY + cam.rows * cam.tileSize).toBeLessThanOrEqual(cam.hudTop)

    // And no point anywhere on that canvas classifies as both a grid cell and
    // the HUD band, which is what the invariant is protecting.
    const hit = createGridHit()
    for (let y = cam.originY; y < cam.originY + cam.rows * cam.tileSize; y++) {
      screenToGrid(cam, cam.originX, y, 0, 0, hit)
      expect(hit.region, `CSS y ${y} is inside the grid rows but classified HUD`).not.toBe(
        HitRegion.HUD,
      )
    }
  })

  it('leaves the HUD band exactly where the plain formula puts it on every real viewport', () => {
    // The other half of the Math.max above: it must be INERT wherever the fit
    // was not clamped, or it would silently move the band on a real device.
    for (const view of [M0_DEVICE, PHONE_390, SHORT_WIDE]) {
      const cam = fitCamera(view, REVEALED_RECT)
      expect(cam.hudTop).toBe(view.cssH - view.bottomInset - HUD_BAND_CSS)
    }
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

  /**
   * Queries a MISS through a `GridHit` that already holds a successful hit on
   * tile (8, 14), which is how `game/pointer.ts` will use it: one `GridHit`
   * reused across every pointer event, so the stale cell a miss path could
   * leave behind is exactly the last successfully tapped one.
   *
   * Every miss test below goes through this. Review finding R2: an earlier
   * version seeded only the ABOVE test and gave the other four a fresh
   * `createGridHit()`, whose `gx`/`gy` are ALREADY -1 — so moving the reset
   * into the ABOVE branch alone left all 82 tests green. A fresh output object
   * cannot observe a reset; only a dirty one can.
   */
  function missAfterAHit(cam: Camera, clientX: number, clientY: number): GridHit {
    const out = createGridHit()
    screenToGrid(cam, 140.5, 266.5, CANVAS_LEFT, CANVAS_TOP, out)
    expect([out.region, out.gx, out.gy], 'the seeding hit itself failed').toEqual([
      HitRegion.GRID,
      8,
      14,
    ])
    return screenToGrid(cam, clientX, clientY, CANVAS_LEFT, CANVAS_TOP, out)
  }

  it('reports a point above the grid rect as ABOVE, not as a cell', () => {
    // CSS y 94, one px above originY 95 -> client y 117
    const hit = missAfterAHit(phone390Camera(), 140.5, 117)
    expect(hit.region).toBe(HitRegion.ABOVE)
    expect([hit.gx, hit.gy]).toEqual([-1, -1])
  })

  it('reports a point below the grid rect but above the HUD band as BELOW', () => {
    // grid bottom CSS 689, HUD top CSS 738. CSS y 700 -> client 723.
    const hit = missAfterAHit(phone390Camera(), 140.5, 723)
    expect(hit.region).toBe(HitRegion.BELOW)
    expect([hit.gx, hit.gy]).toEqual([-1, -1])
  })

  it('reports a point inside the HUD band as HUD, distinguishably from BELOW', () => {
    // CSS y 750 (inside [738, 810)) -> client 773
    const hit = missAfterAHit(phone390Camera(), 140.5, 773)
    expect(hit.region).toBe(HitRegion.HUD)
    expect(hit.region).not.toBe(HitRegion.BELOW)
    expect([hit.gx, hit.gy]).toEqual([-1, -1])
  })

  it('reports the bottom inset, below the HUD band, as BELOW rather than HUD', () => {
    // CSS y 820 (past the band's bottom edge at 810) -> client 843. The band
    // is where the HUD is DRAWN and tapped; the inset below it is the home
    // indicator's, and a tap there must not toggle pause.
    const hit = missAfterAHit(phone390Camera(), 140.5, 843)
    expect(hit.region).toBe(HitRegion.BELOW)
    expect([hit.gx, hit.gy]).toEqual([-1, -1])
  })

  it('reports points left and right of the letterboxed grid rect distinguishably', () => {
    // grid rect x in [6, 384) CSS. CSS x 5 -> client 45; CSS x 384 -> client 424.
    const cam = phone390Camera()
    const left = missAfterAHit(cam, 45, 266.5)
    expect(left.region).toBe(HitRegion.LEFT)
    expect([left.gx, left.gy]).toEqual([-1, -1])

    const right = missAfterAHit(cam, 424, 266.5)
    expect(right.region).toBe(HitRegion.RIGHT)
    expect([right.gx, right.gy]).toEqual([-1, -1])
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
    // hand-computed literals above are what actually pin the transform. THE
    // BRIEF'S REASON FOR THAT IS CORRECT AND THIS COMMENT PREVIOUSLY CLAIMED
    // OTHERWISE. The retraction is left in rather than edited away, because a
    // later reader who trusts a too-strong claim here would over-trust the
    // round trip.
    //
    // What was first reported: three "consistent" errors were built — drop x0
    // in `gridToScreenX` AND `screenToGrid`, drop originY in both directions,
    // transpose x/y in both — and all three FAILED this test (regions RIGHT,
    // ABOVE, and a mismatch), so the brief's "survives any consistently applied
    // error" was called falsified.
    //
    // Why that was wrong: `screenToGrid` uses `originX`/`originY`/`cols`/`rows`
    // TWICE — once to classify the point against the grid rect, once to invert
    // — and those three mutations touched only the inverting use. The
    // classifier still anchored the true rect, so the far cells fell outside it
    // and the pair stopped agreeing. That is an error applied to HALF the uses,
    // not a consistent one.
    //
    // Verified here: mutating the classifier's bounds to match — drop originY
    // from `gridToScreenY`, from `screenToGrid`'s gy, AND from both originY
    // bounds tests — leaves this test PASSING (1 passed, 81 skipped, run
    // filtered onto this test alone). Same for the originX/LEFT/RIGHT version.
    // The brief's mathematical claim holds exactly as stated.
    //
    // What survives as a real, narrower observation: because `screenToGrid`
    // classifies as well as inverts, the REALISTIC single-site mutations do not
    // achieve full consistency and are caught here. That is a reason this test
    // is a slightly better tripwire than a bare inverse would be — it is not a
    // reason to rely on it. The full suite kills the genuinely consistent
    // version with 11 detectors, all of them the hand-computed literals above,
    // which is precisely the defence the brief prescribed.
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

describe('hudRects — four elements, all inside the HUD band and below the grid rect', () => {
  // ---------------------------------------------------------------------
  // **RE-DERIVED, NOT NUDGED, FOR THE FOURTH COLUMN — M1f Task 10.**
  // ---------------------------------------------------------------------
  //
  // §7.2's inventory chip arrived with its first chip and it is TAPPABLE, so
  // §8.3 — *"The top band is dead space ... No interactive element, score, or
  // pause button may live there"* — puts it in the bottom band beside the other
  // three. The task brief preferred the top band and offered a measurement to
  // decide it; the measurement refuses it too. `camera.originY` — the top band's
  // whole height — is **86** on M0_DEVICE, **95** on PHONE_390 and **27** on
  // SHORT_WIDE, against a floor of `CHIP_MIN_CSS + 2 * HUD_PAD_CSS` = 44 + 16 =
  // **60**; and the two degenerate clamps below give **-47** (0x0) and **0**
  // (320x160), where a top-band rect would be off the canvas entirely. Asserted
  // just below rather than left in this comment.
  //
  // Every coordinate in the two cases below is recomputed from the fit by hand
  // at four columns. The old three-column figures — 119 / 135 / 262 at
  // PHONE_390 and 124 / 140 / 272 at M0_DEVICE — are quoted here only so it is
  // visible that they were re-derived rather than patched until green.
  it('measures the top band the chip did NOT go in, at every viewport including the clamps', () => {
    // The fork's own arithmetic, asserted. `CHIP_MIN_CSS` is a touch target
    // (44), not a look, and it is the same figure `OFFER_PEEK_H_CSS` is.
    const floor = CHIP_MIN_CSS + 2 * HUD_PAD_CSS
    expect(floor, '44 px of chip plus the band padding either side').toBe(60)
    expect(fitCamera(M0_DEVICE, REVEALED_RECT).originY).toBe(86)
    expect(fitCamera(PHONE_390, REVEALED_RECT).originY).toBe(95)
    expect(fitCamera(SHORT_WIDE, REVEALED_RECT).originY).toBe(27)
    // The binding one, and the reason the fork resolves without §8.3 being
    // consulted: HEIGHT binds on SHORT_WIDE, so the top band is 27 CSS px.
    expect(fitCamera(SHORT_WIDE, REVEALED_RECT).originY).toBeLessThan(floor)
    // And the clamps, where the band has no pixels at all or is off-canvas.
    expect(fitCamera(DEGENERATE, REVEALED_RECT).originY).toBe(-47)
    expect(
      fitCamera(
        { cssW: 320, cssH: 160, topInset: 0, bottomInset: 0, rawDpr: 1, performanceClass: null },
        REVEALED_RECT,
      ).originY,
    ).toBe(0)
  })

  it('lays out the four rects at hand-computed coordinates on the 390 px fixture', () => {
    // cssW 390, hudTop 738, hudHeight 72, pad 8, gap 8, HUD_COLUMNS 4
    // usable width 390 - 16 = 374; three gaps = 24
    // colW = floor((374 - 24)/4) = floor(87.5) = 87;  stride = 87 + 8 = 95
    // y = 738 + 8 = 746; h = 72 - 16 = 56
    // clock x 8; score x 103; tiles x 198; upgrades x 293, right edge 380 <= 382
    const r = hudRects(phone390Camera(), createHudRects())
    expect([r.clock.x, r.clock.y, r.clock.w, r.clock.h]).toEqual([8, 746, 87, 56])
    expect([r.score.x, r.score.y, r.score.w, r.score.h]).toEqual([103, 746, 87, 56])
    expect([r.tiles.x, r.tiles.y, r.tiles.w, r.tiles.h]).toEqual([198, 746, 87, 56])
    expect([r.upgrades.x, r.upgrades.y, r.upgrades.w, r.upgrades.h]).toEqual([293, 746, 87, 56])
    // The chip is a touch target before it is a layout, so the column has to be
    // able to hold one. This is the assertion `CHIP_MIN_CSS` exists for.
    expect(r.upgrades.w, 'the chip column is at least a touch target wide').toBeGreaterThanOrEqual(
      CHIP_MIN_CSS,
    )
    expect(r.upgrades.h).toBeGreaterThanOrEqual(CHIP_MIN_CSS)
  })

  it('lays them out against the M0 device\'s wider band too', () => {
    // cssW 406, hudTop 764: usable 390; three gaps 24
    // colW = floor((390 - 24)/4) = floor(91.5) = 91; stride 99
    // y = 772; h = 56; x = 8, 107, 206, 305, right edge 396 <= 398
    const r = hudRects(fitCamera(M0_DEVICE, REVEALED_RECT), createHudRects())
    expect([r.clock.x, r.clock.y, r.clock.w, r.clock.h]).toEqual([8, 772, 91, 56])
    expect(r.score.x).toBe(107)
    expect(r.tiles.x).toBe(206)
    expect(r.upgrades.x).toBe(305)
    expect(r.upgrades.x + r.upgrades.w, 'the last column clears the right padding').toBeLessThanOrEqual(
      406 - HUD_PAD_CSS,
    )
  })

  it('never reports a NEGATIVE width, on the viewports fitCamera deliberately survives', () => {
    // **The degenerate clamps, which this function did not carry before the
    // fourth column and which are not about the fourth column.** `(20 - 16 -
    // 16) / 3` is -4 at three columns and `(20 - 16 - 24) / 4` is -5 at four:
    // the expression has always gone negative on a viewport with no pixels, and
    // a negative-width rect is the one thing `offerRects` clamps for. `inRect`
    // answers false against one either way, so nothing was ever mis-hit — but
    // the fourth column is not the place to inherit an unclamped expression
    // silently.
    for (const view of [
      DEGENERATE,
      { cssW: 20, cssH: 600, topInset: 0, bottomInset: 0, rawDpr: 1, performanceClass: null },
      { cssW: 320, cssH: 160, topInset: 0, bottomInset: 0, rawDpr: 1, performanceClass: null },
    ] as const) {
      const r = hudRects(fitCamera(view, REVEALED_RECT), createHudRects())
      for (const [name, rect] of fourRects(r)) {
        expect(rect.w, `${name} has a negative width at ${view.cssW}x${view.cssH}`).toBeGreaterThanOrEqual(0)
      }
    }
    // Non-vacuous: the 20 px viewport really is the one that would have gone
    // negative, so the clamp is doing work rather than agreeing with the
    // formula.
    const narrow = fitCamera(
      { cssW: 20, cssH: 600, topInset: 0, bottomInset: 0, rawDpr: 1, performanceClass: null },
      REVEALED_RECT,
    )
    expect(
      Math.floor((narrow.cssW - 2 * HUD_PAD_CSS - 3 * HUD_GAP_CSS) / 4),
      'the unclamped expression is negative here',
    ).toBeLessThan(0)
    expect(hudRects(narrow, createHudRects()).clock.w).toBe(0)
  })

  it('keeps every rect entirely inside the HUD band and entirely below the grid rect', () => {
    for (const view of [M0_DEVICE, PHONE_390, SHORT_WIDE]) {
      const cam = fitCamera(view, REVEALED_RECT)
      const r = hudRects(cam, createHudRects())
      const gridBottom = cam.originY + cam.rows * cam.tileSize
      for (const [name, rect] of fourRects(r)) {
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

  it('never overlaps its own four rects', () => {
    const r = hudRects(phone390Camera(), createHudRects())
    expect(r.clock.x + r.clock.w).toBeLessThanOrEqual(r.score.x)
    expect(r.score.x + r.score.w).toBeLessThanOrEqual(r.tiles.x)
    expect(r.tiles.x + r.tiles.w).toBeLessThanOrEqual(r.upgrades.x)
  })

  it('never overlaps the OFFER modal\'s rects either, at any viewport', () => {
    // The chip is tappable and so are the modal's three rects, and `pointer.ts`
    // answers the modal FIRST — so an overlap would be a chip the player can see
    // and cannot press while a card is up. That ordering is asserted in
    // `pointer.test.ts`; this is the geometric half, and it holds because
    // `offerRects` lives in the BOARD's band `[originY, hudTop)` and every HUD
    // rect starts at `hudTop + HUD_PAD_CSS`.
    for (const view of [M0_DEVICE, PHONE_390, SHORT_WIDE]) {
      const cam = fitCamera(view, REVEALED_RECT)
      const hud = hudRects(cam, createHudRects())
      const offer = offerRects(cam, createOfferRects())
      for (const [hudName, hudRect] of fourRects(hud)) {
        for (const [offerName, offerRect] of threeRects(offer)) {
          expect(overlaps(hudRect, offerRect), `${hudName} overlaps ${offerName}`).toBe(false)
        }
      }
    }
  })

  it('puts every rect in the HUD region as screenToGrid classifies it', () => {
    // The two functions must agree, because `pointer.ts` hit-tests hudRects
    // first and falls through to screenToGrid: a rect the transform calls
    // BELOW would be a HUD element the board also answers for.
    const cam = phone390Camera()
    const r = hudRects(cam, createHudRects())
    const hit = createGridHit()
    for (const rect of [r.clock, r.score, r.tiles, r.upgrades]) {
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

// ---------------------------------------------------------------------------
// offerRects — §5.10's modal, M1f Task 8
// ---------------------------------------------------------------------------

/**
 * The four HUD rects, as a list with names, so every loop reports WHICH one
 * failed rather than that something did — M1f Task 10 added the fourth.
 */
function fourRects(r: HudRects): readonly (readonly [string, Rect])[] {
  return [
    ['clock', r.clock],
    ['score', r.score],
    ['tiles', r.tiles],
    ['upgrades', r.upgrades],
  ] as const
}

/**
 * The three rects, as a list with names, so every loop below reports WHICH one
 * failed rather than that something did.
 */
function threeRects(r: OfferRects): readonly (readonly [string, Rect])[] {
  return [
    ['cardA', r.cardA],
    ['cardB', r.cardB],
    ['peek', r.peek],
  ] as const
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) > 0 &&
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) > 0
  )
}

/**
 * The viewport `fitCamera` clamps for — a hidden webview, or a measurement taken
 * mid-rotation. Not hypothetical: `fitCamera` has a documented `Math.max(1, …)`
 * on the tile for exactly this input, and the plain formula puts `originY` at
 * **-47** and `hudTop` at **-25**, both off the canvas entirely.
 */
const DEGENERATE: ViewportMetrics = {
  cssW: 0,
  cssH: 0,
  topInset: 0,
  bottomInset: 0,
  rawDpr: 1,
  performanceClass: null,
}

describe('offerRects — two cards and a way out, laid out inside the board band', () => {
  it('lays the three rects out at hand-computed coordinates on the 390 px fixture', () => {
    // Every number is written as a literal, computed by hand from the fixture
    // and never from the expression under test:
    //
    //   top    = originY 95      bottom = hudTop 738      innerH = 643
    //   left   = 16              innerW = 390 - 32 = 358
    //   titleH = 28   peekH = 44   gap = 12   cardMaxH = 200
    //   fitH   = floor((643 - 28 - 44 - 36) / 2) = 267  ->  capped to 200
    //   blockH = 28 + 44 + 2*200 + 36 = 508
    //   blockTop = 95 + floor((643 - 508) / 2) = 95 + 67 = 162
    //   cardA y = 162 + 28 + 12 = 202     cardB y = 202 + 200 + 12 = 414
    //   peek  y = 414 + 200 + 12 = 626    peek x = 16 + floor((358-132)/2) = 129
    const r = offerRects(phone390Camera(), createOfferRects())
    expect([r.cardA.x, r.cardA.y, r.cardA.w, r.cardA.h]).toEqual([16, 202, 358, 200])
    expect([r.cardB.x, r.cardB.y, r.cardB.w, r.cardB.h]).toEqual([16, 414, 358, 200])
    expect([r.peek.x, r.peek.y, r.peek.w, r.peek.h]).toEqual([129, 626, 132, 44])
  })

  it('leaves a strip of the frozen board above and below the modal, on both phones', () => {
    // **The cap's whole purpose, as a measurement rather than as a comment.**
    // Uncapped, the two cards fill the band and the player sees no board at
    // all — which reads as a different screen rather than as a stopped game,
    // and which would leave `REFUSED_OFFER_MODAL` with no reachable fixture
    // because every board pixel would be under a card.
    for (const [view, above, below] of [
      [PHONE_390, 67, 68],
      [M0_DEVICE, 85, 85],
    ] as const) {
      const cam = fitCamera(view, REVEALED_RECT)
      const r = offerRects(cam, createOfferRects())
      // The title sits one gap above card A, so the visible board above the
      // modal runs from the band's top to the title's own top edge.
      expect(r.cardA.y - OFFER_GAP_CSS - OFFER_TITLE_H_CSS - cam.originY).toBe(above)
      expect(cam.hudTop - (r.peek.y + r.peek.h)).toBe(below)
      expect(r.cardA.h, 'and the cap is what bought it').toBe(OFFER_CARD_MAX_H_CSS)
    }
  })

  it('lays them out against the M0 device too, so nothing is a property of one viewport', () => {
    //   top 86, bottom 764, innerH 678, innerW 406 - 32 = 374
    //   fitH = floor((678 - 28 - 44 - 36) / 2) = 285  ->  capped to 200
    //   blockTop = 86 + floor((678 - 508) / 2) = 86 + 85 = 171
    //   cardA y = 171 + 40 = 211    cardB y = 211 + 212 = 423
    //   peek  y = 423 + 212 = 635   peek x = 16 + floor((374-132)/2) = 137
    const r = offerRects(fitCamera(M0_DEVICE, REVEALED_RECT), createOfferRects())
    expect([r.cardA.x, r.cardA.y, r.cardA.w, r.cardA.h]).toEqual([16, 211, 374, 200])
    expect([r.cardB.y, r.cardB.h]).toEqual([423, 200])
    expect([r.peek.x, r.peek.y, r.peek.w, r.peek.h]).toEqual([137, 635, 132, 44])
  })

  it('keeps every rect inside the canvas and out of the HUD band, at three viewports', () => {
    // SHORT_WIDE is in the list because HEIGHT binds there — it is the only
    // fixture that can see a layout derived from the width alone.
    for (const view of [M0_DEVICE, PHONE_390, SHORT_WIDE]) {
      const cam = fitCamera(view, REVEALED_RECT)
      const r = offerRects(cam, createOfferRects())
      for (const [name, rect] of threeRects(r)) {
        expect(rect.x, `${name} starts left of the canvas`).toBeGreaterThanOrEqual(0)
        expect(rect.y, `${name} starts above the canvas`).toBeGreaterThanOrEqual(0)
        expect(rect.x + rect.w, `${name} runs past the canvas`).toBeLessThanOrEqual(cam.cssW)
        expect(rect.y + rect.h, `${name} runs past the canvas`).toBeLessThanOrEqual(cam.cssH)
        expect(rect.y, `${name} is above the safe-area top`).toBeGreaterThanOrEqual(cam.originY)
        expect(rect.y + rect.h, `${name} runs into the HUD band`).toBeLessThanOrEqual(cam.hudTop)
        // **The non-vacuity half.** Every bound above is satisfied by a rect of
        // zero area, and zero-area rects also "never overlap" — so without this
        // the whole describe would pass on a function that wrote nothing.
        expect(rect.w, `${name} is empty`).toBeGreaterThan(0)
        expect(rect.h, `${name} is empty`).toBeGreaterThan(0)
      }
    }
  })

  it('never overlaps its own three rects, and the peek control overlaps neither card', () => {
    for (const view of [M0_DEVICE, PHONE_390, SHORT_WIDE]) {
      const r = offerRects(fitCamera(view, REVEALED_RECT), createOfferRects())
      expect(overlaps(r.cardA, r.cardB), 'the two cards overlap').toBe(false)
      expect(overlaps(r.cardA, r.peek), 'peek is under card A').toBe(false)
      expect(overlaps(r.cardB, r.peek), 'peek is under card B').toBe(false)
      // Ordered top to bottom, which is what makes "the second card" a thing a
      // player can point at rather than a slot index.
      expect(r.cardA.y + r.cardA.h).toBeLessThanOrEqual(r.cardB.y)
      expect(r.cardB.y + r.cardB.h).toBeLessThanOrEqual(r.peek.y)
      // Non-vacuous on `overlaps` itself: it must report true for something.
      expect(overlaps(r.cardA, { x: r.cardA.x, y: r.cardA.y, w: 4, h: 4 })).toBe(true)
    }
  })

  it('never covers the HUD clock, which is a pause control the modal refuses', () => {
    // The scrim DOES cover it — deliberately, so it cannot read as live — but
    // the tappable rects must not, or a player aiming at a card lands on a
    // control `pointer.ts` answers with REFUSED_OFFER_MODAL.
    for (const view of [M0_DEVICE, PHONE_390, SHORT_WIDE]) {
      const cam = fitCamera(view, REVEALED_RECT)
      const r = offerRects(cam, createOfferRects())
      const hud = hudRects(cam, createHudRects())
      for (const [name, rect] of threeRects(r)) {
        for (const el of ['clock', 'score', 'tiles'] as const) {
          expect(overlaps(rect, hud[el]), `${name} covers the ${el}`).toBe(false)
        }
      }
    }
  })

  it('collapses to zero area on the viewport fitCamera clamps for, rather than going off-canvas', () => {
    // **Stated as an outcome rather than left to pass as "nothing overlaps".**
    // On this viewport the plain formula puts the board band at
    // `[-47, -25)` — entirely off the canvas — so an unclamped layout would
    // hand `pointer.ts` three touch targets at negative coordinates and
    // `canvas.ts` three negative-height fills.
    const cam = fitCamera(DEGENERATE, REVEALED_RECT)
    expect(cam.originY, 'the unclamped band really is off-canvas').toBe(-47)
    expect(cam.hudTop).toBe(-25)
    const r = offerRects(cam, createOfferRects())
    for (const [name, rect] of threeRects(r)) {
      expect([rect.x, rect.y, rect.w, rect.h], `${name} left the canvas`).toEqual([0, 0, 0, 0])
    }
  })

  it('keeps the way OUT when the space runs out before the cards do', () => {
    // A viewport with a real but tiny board band. The cards lose their height
    // first and the peek control keeps the strip, because a modal a player
    // cannot dismiss and cannot see past is the state M1f Task 7 shipped on
    // purpose and interlocked against.
    const tight = fitCamera(
      { cssW: 320, cssH: 160, topInset: 0, bottomInset: 0, rawDpr: 1, performanceClass: null },
      REVEALED_RECT,
    )
    const r = offerRects(tight, createOfferRects())
    const band = Math.max(0, Math.min(tight.hudTop, tight.cssH) - Math.max(0, tight.originY))
    expect(band, 'the band is real but tiny').toBeGreaterThan(0)
    expect(band).toBeLessThan(OFFER_TITLE_H_CSS + OFFER_PEEK_H_CSS + 3 * OFFER_GAP_CSS)
    expect(r.peek.h, 'the way out survives').toBeGreaterThan(0)
    expect(r.cardA.h, 'the cards do not').toBe(0)
    expect(r.cardB.h).toBe(0)
    for (const [name, rect] of threeRects(r)) {
      expect(rect.y, `${name} left the canvas`).toBeGreaterThanOrEqual(0)
      expect(rect.y + rect.h, `${name} left the canvas`).toBeLessThanOrEqual(tight.cssH)
    }
  })

  it('never lets the side margin swallow the canvas on a viewport narrower than it', () => {
    // `left` is clamped to half the width, so a 20 px canvas gets a 10 px
    // margin and a zero-width card rather than a card of width -12.
    const narrow = fitCamera(
      { cssW: 20, cssH: 600, topInset: 0, bottomInset: 0, rawDpr: 1, performanceClass: null },
      REVEALED_RECT,
    )
    const r = offerRects(narrow, createOfferRects())
    for (const [name, rect] of threeRects(r)) {
      expect(rect.w, `${name} has a negative width`).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.w, `${name} runs past the canvas`).toBeLessThanOrEqual(narrow.cssW)
    }
    expect(OFFER_MARGIN_CSS * 2, 'and the fixture really is narrower than two margins').toBeGreaterThan(
      narrow.cssW,
    )
  })

  it('sizes the peek control as a real touch target wherever there is room for one', () => {
    for (const view of [M0_DEVICE, PHONE_390, SHORT_WIDE]) {
      const r = offerRects(fitCamera(view, REVEALED_RECT), createOfferRects())
      expect(r.peek.w).toBe(OFFER_PEEK_W_CSS)
      expect(r.peek.h).toBe(OFFER_PEEK_H_CSS)
      expect(r.peek.h, '44 CSS px is the floor, not a look').toBeGreaterThanOrEqual(44)
    }
  })

  it('lets the derived height win where it is SMALLER than the cap, so the cap is a ceiling', () => {
    // SHORT_WIDE's band is 491 CSS px, which gives 191 per card — under the
    // 200 cap. A `cardH = OFFER_CARD_MAX_H_CSS` assignment rather than a `min`
    // would push the block past the band here and clip the peek control.
    const cam = fitCamera(SHORT_WIDE, REVEALED_RECT)
    const r = offerRects(cam, createOfferRects())
    expect(r.cardA.h).toBe(191)
    expect(r.cardA.h).toBeLessThan(OFFER_CARD_MAX_H_CSS)
    expect(r.peek.y + r.peek.h).toBeLessThanOrEqual(cam.hudTop)
  })

  it("writes into the caller's object and returns it, allocating nothing", () => {
    const out = createOfferRects()
    const cardA = out.cardA
    const returned = offerRects(phone390Camera(), out)
    expect(returned).toBe(out)
    expect(returned.cardA).toBe(cardA) // the nested rects are reused, not replaced
    // ...and calling it twice with a different camera rewrites the SAME objects
    // rather than leaving the first camera's numbers behind.
    offerRects(fitCamera(M0_DEVICE, REVEALED_RECT), out)
    expect(out.cardA).toBe(cardA)
    expect(out.cardA.w).toBe(374)
  })
})
