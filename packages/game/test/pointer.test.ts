import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  GRID_W,
  REVEALED_H,
  REVEALED_W,
  REVEALED_X0,
  REVEALED_Y0,
  firstCity,
} from '@laneways/shared'
import {
  HitRegion,
  createGridHit,
  createHudRects,
  createOfferRects,
  fitCamera,
  gridToScreenX,
  gridToScreenY,
  hudRects,
  offerRects,
  screenToGrid,
  type Camera,
  type Rect,
} from '@laneways/render'
import {
  CARD_JUNCTION_UPGRADE,
  CARD_ROAD_TILES,
  OFFER_SLOT_A,
  OFFER_SLOT_B,
  createState,
  createWorld,
  dirBetween,
  placeRoad,
} from '@laneways/sim'
import { createInputQueue, type InputQueue } from '../src/inputs'
import { PointerOutcome, createPointerInput, type PointerHost, type PointerInput } from '../src/pointer'

/**
 * ---------------------------------------------------------------------------
 * THE FIXTURE, AND WHY IT IS THIS ONE
 * ---------------------------------------------------------------------------
 *
 * Every requirement in the brief's vacuity self-check is met by construction
 * AND asserted below, so an edit that flattens one turns a test red rather than
 * silently disarming the battery:
 *
 *   - non-square viewport             390 x 844
 *   - letterboxed on BOTH axes        originX 6, originY 95, both non-zero
 *   - originX != originY              6 != 95
 *   - offset from the viewport origin canvas rect at (40, 23), and 40 != 23
 *   - DPR neither 1 nor 2             2.625 capped to 1.5 on a LOW client
 *   - ODD tile size                   27, so a tile centre sits at a .5
 *                                     fraction and `round`-instead-of-`floor`
 *                                     lands on the wrong tile on BOTH axes
 *   - reveal origin components differ x0 5 != y0 9, and neither is 0
 *
 * It is deliberately the same PHONE_390 fixture `render/test/camera.test.ts`
 * uses, because this task's whole claim is that it reuses that transform.
 *
 * ---------------------------------------------------------------------------
 * EVERY EXPECTED NUMBER BELOW IS HAND-COMPUTED
 * ---------------------------------------------------------------------------
 *
 *   availableH = 844 - 47 - 72 - 34 = 691
 *   tileSize   = floor(min(390/14, 691/22)) = floor(min(27.857, 31.409)) = 27
 *   grid px    = 14*27 = 378, 22*27 = 594
 *   originX    = floor((390 - 378)/2) = 6
 *   originY    = 47 + floor((691 - 594)/2) = 47 + 48 = 95
 *   grid rect  = cssX in [6, 384), cssY in [95, 689)
 *   hudTop     = max(95 + 594, 844 - 34 - 72) = max(689, 738) = 738
 *   HUD band   = cssY in [738, 810)
 *   hudRects   = y 746, h 56; w = floor((390 - 16 - 16)/3) = 119; stride 127
 *                clock cssX in [8, 127), score [135, 254), tiles [262, 381)
 *
 * `centreOf` composes `gridToScreenX`/`gridToScreenY` — the FORWARD transform —
 * for the bulk sweeps. That is a cross-check against the other direction, not a
 * reimplementation of the inverse; every individual coordinate that carries a
 * claim is written as a literal alongside it.
 */

const CANVAS_LEFT = 40
const CANVAS_TOP = 23

const TILE = 27
const ORIGIN_X = 6
const ORIGIN_Y = 95
const GRID_RIGHT = 384 // 6 + 14*27
const GRID_BOTTOM = 689 // 95 + 22*27
const HUD_TOP = 738

/**
 * The M0 reference device — the one the whole milestone's pixel budget is
 * computed against, and the one Task 9 deploys to. It is driven behaviourally
 * below rather than only asserted about, because **its `originX` is 0**: the
 * horizontal letterbox vanishes, so a dropped `originX` term is invisible on it
 * and a fixture that only ever uses PHONE_390 never checks that the module works
 * where the letterbox is absent. The two together cover both.
 *
 *   availableH = 870 - 46 - 72 - 34            = 718
 *   tileSize   = floor(min(406/14, 718/22))
 *              = floor(min(29, 32.63))         = 29
 *   grid px    = 14*29 = 406  and  22*29 = 638
 *   originX    = floor((406 - 406)/2)          = 0     <- no left letterbox
 *   originY    = 46 + floor((718 - 638)/2)     = 86
 *   grid rect  = cssX in [0, 406), cssY in [86, 724)
 *   hudTop     = max(86 + 638, 870 - 34 - 72) = max(724, 764) = 764
 */
function m0Device(): Camera {
  return fitCamera(
    { cssW: 406, cssH: 870, topInset: 46, bottomInset: 34, rawDpr: 3, performanceClass: null },
    { x0: REVEALED_X0, y0: REVEALED_Y0, cols: REVEALED_W, rows: REVEALED_H },
  )
}

function phone390(): Camera {
  return fitCamera(
    { cssW: 390, cssH: 844, topInset: 47, bottomInset: 34, rawDpr: 2.625, performanceClass: 'LOW' },
    { x0: REVEALED_X0, y0: REVEALED_Y0, cols: REVEALED_W, rows: REVEALED_H },
  )
}

// --- client points, all hand-computed against the block above ----------------

/** Tile (8, 14): cssX in [87, 114), cssY in [230, 257); centre (100.5, 243.5). */
const T8_14_X = 140.5 // 6 + (8-5)*27 + 13.5 + 40
const T8_14_Y = 266.5 // 95 + (14-9)*27 + 13.5 + 23
/** Tile (9, 14) centre: css (127.5, 243.5). */
const T9_14_X = 167.5
const T9_14_Y = 266.5
/** Tile (9, 15) centre: css (127.5, 270.5). */
const T9_15_X = 167.5
const T9_15_Y = 293.5
/** Tile (11, 15) centre: css (181.5, 270.5). */
const T11_15_X = 221.5
const T11_15_Y = 293.5
/** Tile (9, 18) centre: css (127.5, 351.5). */
const T9_18_X = 167.5
const T9_18_Y = 374.5
/** Tile (14, 20) centre: css (262.5, 405.5) — far from every other marker. */
const T14_20_X = 302.5
const T14_20_Y = 428.5

/** `index = y * w + x`, w = 24. */
const CELL_8_14 = 344
const CELL_9_14 = 345
const CELL_9_15 = 369
const CELL_10_15 = 370
const CELL_11_15 = 371
const CELL_10_16 = 394
const CELL_9_17 = 417
const CELL_9_18 = 441
const CELL_14_20 = 494

/** HUD clock rect: cssX in [8, 127), cssY in [746, 802). Centre css (67.5, 774). */
const CLOCK_X = 107.5
const CLOCK_Y = 797

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

interface Rig {
  readonly input: PointerInput
  readonly queue: InputQueue
  readonly host: PointerHost
  readonly setPausedCalls: readonly boolean[]
  readonly paused: boolean
  /** Pauses from outside the pointer. NOT a path that exists: `main.ts` has no Telegram `deactivated` handler and never has (M1e Task 11 checked). This models `Game.setPaused`, which `main.ts` exports and nothing in `packages/` calls — the rule is "no board input while paused", so the host must be able to pause from anywhere. */
  readonly forcePaused: (next: boolean) => void
  /** How many times the host was asked for a new run (M1e Task 9). */
  readonly restarts: number
  /**
   * Ends the run the way `main.ts` does. **It pauses too, and that is not
   * convenience** — `Loop.end()` sets `paused = true`, so `gameOver` without
   * `paused` is a state production cannot be in, and a fixture that produced it
   * would let a guard pass here and fail on a phone.
   */
  readonly endRun: () => void
  /** Raises §5.10's offer and pauses, the way `main.ts` does. See the implementation. */
  readonly raiseOffer: (a?: number, b?: number) => void
  /** Clears it, the way the tick that applies `choose-card` does. */
  readonly resolveOffer: () => void
}

function rig(camera: Camera = phone390()): Rig {
  const queue = createInputQueue()
  let paused = false
  let over = false
  let restarts = 0
  let pending = false
  let cardA = 0
  let cardB = 0
  const setPausedCalls: boolean[] = []
  const host: PointerHost = {
    camera: () => camera,
    canvasLeft: () => CANVAS_LEFT,
    canvasTop: () => CANVAS_TOP,
    gridW: GRID_W,
    queue,
    paused: () => paused,
    setPaused: (next: boolean) => {
      setPausedCalls.push(next)
      paused = next
    },
    gameOver: () => over,
    restart: () => {
      restarts++
    },
    // The three §5.10 reads, as functions for `camera`'s reason: `main.ts`
    // supplies them off live sim state, so a value snapshotted at construction
    // would freeze the modal shut for the whole run.
    offerPending: () => pending,
    offerA: () => cardA,
    offerB: () => cardB,
  }
  const input = createPointerInput(host)
  return {
    input,
    queue,
    host,
    setPausedCalls,
    get paused(): boolean {
      return paused
    },
    forcePaused: (next: boolean) => {
      paused = next
    },
    get restarts(): number {
      return restarts
    },
    endRun: () => {
      over = true
      paused = true
    },
    /**
     * Raises §5.10's offer the way `main.ts` does — **and pauses, which is not
     * convenience.** `frame.ts`'s `onOfferRaised` fires on every tick the offer
     * holds and `main.ts` answers it with `loop.setPaused(true)`, so
     * `offerPending && !paused` is a state production is never in for longer
     * than the frame that raises it, and a fixture that produced it would let a
     * guard pass here and fail on a phone. Exactly the reasoning `endRun` above
     * already carries for game over.
     */
    raiseOffer: (a = CARD_ROAD_TILES, b = CARD_JUNCTION_UPGRADE) => {
      pending = true
      cardA = a
      cardB = b
      paused = true
    },
    resolveOffer: () => {
      pending = false
    },
  }
}

/** The client CSS point at the exact centre of a canvas-relative rect. */
function centreOf(rect: Rect): readonly [number, number] {
  return [CANVAS_LEFT + rect.x + rect.w / 2, CANVAS_TOP + rect.y + rect.h / 2] as const
}

/** The modal's three rects on the fixture camera. */
function modal(r: Rig): ReturnType<typeof offerRects> {
  return offerRects(r.host.camera(), createOfferRects())
}

/** The client CSS point at the exact centre of board cell (gx, gy). */
function centreX(camera: Camera, gx: number): number {
  return gridToScreenX(camera, gx) + camera.tileSize / 2 + CANVAS_LEFT
}
function centreY(camera: Camera, gy: number): number {
  return gridToScreenY(camera, gy) + camera.tileSize / 2 + CANVAS_TOP
}

/** The queued batch, read off the very object `step` will iterate. */
function queued(queue: InputQueue): { kind: string; a: number; b: number }[] {
  return queue.inputs.actions.map((x) => ({ kind: x.kind, a: x.a, b: x.b }))
}

/** Every action's endpoints, decoded to board coordinates. */
function chebyshev(a: number, b: number): number {
  const dx = (b % GRID_W) - (a % GRID_W)
  const dy = Math.floor(b / GRID_W) - Math.floor(a / GRID_W)
  return Math.max(Math.abs(dx), Math.abs(dy))
}

// ---------------------------------------------------------------------------
// The fixture's own vacuity self-checks — the brief's list, asserted
// ---------------------------------------------------------------------------

describe('the fixture cannot hide a variable', () => {
  it('is non-square, letterboxed on both axes, with originX != originY', () => {
    const camera = phone390()
    expect(camera.cssW).not.toBe(camera.cssH)
    expect(camera.originX).toBe(ORIGIN_X)
    expect(camera.originY).toBe(ORIGIN_Y)
    expect(camera.originX).toBeGreaterThan(0)
    expect(camera.originY).toBeGreaterThan(0)
    expect(camera.originX).not.toBe(camera.originY)
  })

  it('is offset from the viewport origin by two different non-zero amounts', () => {
    expect(CANVAS_LEFT).toBeGreaterThan(0)
    expect(CANVAS_TOP).toBeGreaterThan(0)
    expect(CANVAS_LEFT).not.toBe(CANVAS_TOP)
  })

  it('has an ODD tile size and a DPR that is neither 1 nor 2', () => {
    const camera = phone390()
    expect(camera.tileSize).toBe(TILE)
    expect(camera.tileSize % 2).toBe(1)
    expect(camera.dpr).toBe(1.5)
  })

  it('has a reveal origin whose two components differ and are both non-zero', () => {
    const camera = phone390()
    expect(camera.x0).toBe(5)
    expect(camera.y0).toBe(9)
    expect(camera.x0).not.toBe(camera.y0)
    expect(camera.x0).toBeGreaterThan(0)
    expect(camera.y0).toBeGreaterThan(0)
  })

  it('has a revealed rect that is not square either — cols != rows', () => {
    // A 14x22 rect: without this, `cols` and `rows` could be swapped in the
    // bounds arithmetic and every fixture point would still classify the same.
    // The viewport being non-square does not imply the RECT is.
    const camera = phone390()
    expect(camera.cols).toBe(14)
    expect(camera.rows).toBe(22)
    expect(camera.cols).not.toBe(camera.rows)
  })

  it('puts the HUD band strictly below the grid rect — this task’s premise, from fitCamera', () => {
    const camera = phone390()
    expect(camera.hudTop).toBe(HUD_TOP)
    expect(camera.hudTop).toBeGreaterThanOrEqual(camera.originY + camera.rows * camera.tileSize)
  })

  it('lays the HUD clock rect out at the hand-computed literals every marker below uses', () => {
    const rects = hudRects(phone390(), createHudRects())
    expect(rects.clock).toEqual({ x: 8, y: 746, w: 119, h: 56 })
    expect(rects.score).toEqual({ x: 135, y: 746, w: 119, h: 56 })
    expect(rects.tiles).toEqual({ x: 262, y: 746, w: 119, h: 56 })
  })

  it('places a marker one CSS px past exactly ONE bound, never a diagonal corner', () => {
    // The catalogue's Task 5 lesson: a marker in a corner is past two bounds at
    // once, so extending either one reaches nothing. Every "just outside"
    // marker in this file is asserted to be inside the OTHER axis's range.
    const camera = phone390()
    // above the grid rect, x inside it
    expect(T8_14_X - CANVAS_LEFT).toBeGreaterThanOrEqual(camera.originX)
    expect(T8_14_X - CANVAS_LEFT).toBeLessThan(GRID_RIGHT)
    // left of the grid rect, y inside it
    expect(T8_14_Y - CANVAS_TOP).toBeGreaterThanOrEqual(camera.originY)
    expect(T8_14_Y - CANVAS_TOP).toBeLessThan(GRID_BOTTOM)
    // the clock markers' shared centre line is inside the clock rect on the
    // other axis
    expect(CLOCK_X - CANVAS_LEFT).toBe(67.5)
    expect(CLOCK_Y - CANVAS_TOP).toBe(774)
  })
})

// ---------------------------------------------------------------------------
// A tap on the board
// ---------------------------------------------------------------------------

describe('a tap on the board', () => {
  it('maps a hand-computed client point inside tile (8, 14) to exactly that tile', () => {
    const r = rig()
    expect(r.input.down(1, T8_14_X, T8_14_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.dragging).toBe(true)
    expect(r.input.activePointerId).toBe(1)
    expect(r.input.lastCell).toBe(CELL_8_14)
  })

  it('subtracts the canvas offset — the same client point on an unoffset canvas is a DIFFERENT cell', () => {
    // The `rect.left`/`rect.top` mutation, both halves, one axis at a time.
    const camera = phone390()
    const hit = createGridHit()
    screenToGrid(camera, T8_14_X, T8_14_Y, 0, CANVAS_TOP, hit)
    expect(hit.gx).toBe(9) // 5 + floor((140.5 - 6)/27) = 5 + 4
    screenToGrid(camera, T8_14_X, T8_14_Y, CANVAS_LEFT, 0, hit)
    expect(hit.gy).toBe(15) // 9 + floor((266.5 - 95)/27) = 9 + 6
  })

  it('FLOORS the tile index — the centre of a 27 px tile sits at a .5 fraction on both axes', () => {
    // (100.5 - 6)/27 = 3.5 and (243.5 - 95)/27 = 5.5, so `round` lands on
    // (9, 15) rather than (8, 14) — on BOTH axes, from one marker.
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.lastCell).toBe(CELL_8_14)
    expect(r.input.lastCell).not.toBe(CELL_9_15)
  })

  it('indexes as y*w + x, not x*w + y', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.lastCell).toBe(14 * GRID_W + 8)
    expect(r.input.lastCell).not.toBe(8 * GRID_W + 14)
  })

  it('starts the drag but queues nothing — one cell is not a segment', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.queue.length).toBe(0)
  })

  it('maps the grid rect’s own corners to the first and last revealed cells', () => {
    const first = rig()
    // css (6, 95) -> the top-left pixel of the grid rect
    expect(first.input.down(1, ORIGIN_X + CANVAS_LEFT, ORIGIN_Y + CANVAS_TOP)).toBe(
      PointerOutcome.DRAG_START,
    )
    expect(first.input.lastCell).toBe(9 * GRID_W + 5) // (5, 9) = 221

    const last = rig()
    // css (383, 688) -> the bottom-right pixel, one inside each far bound
    expect(last.input.down(1, GRID_RIGHT - 1 + CANVAS_LEFT, GRID_BOTTOM - 1 + CANVAS_TOP)).toBe(
      PointerOutcome.DRAG_START,
    )
    expect(last.input.lastCell).toBe(30 * GRID_W + 18) // (18, 30) = 738
  })

  it('agrees with the forward transform on every one of the 308 revealed cells', () => {
    const camera = phone390()
    let checked = 0
    for (let gy = REVEALED_Y0; gy < REVEALED_Y0 + REVEALED_H; gy++) {
      for (let gx = REVEALED_X0; gx < REVEALED_X0 + REVEALED_W; gx++) {
        const r = rig(camera)
        expect(r.input.down(1, centreX(camera, gx), centreY(camera, gy))).toBe(
          PointerOutcome.DRAG_START,
        )
        expect(r.input.lastCell).toBe(gy * GRID_W + gx)
        checked++
      }
    }
    expect(checked, 'the sweep covered no cells').toBe(REVEALED_W * REVEALED_H)
    expect(checked).toBe(308)
  })
})

describe('the M0 reference device, where there is no horizontal letterbox', () => {
  it('fits to the hand-computed 29 px tile at originX 0', () => {
    const camera = m0Device()
    expect(camera.tileSize).toBe(29)
    expect(camera.originX).toBe(0)
    expect(camera.originY).toBe(86)
    expect(camera.hudTop).toBe(764)
    // and the parities differ from PHONE_390's in every term that matters:
    // 29 vs 27 (both odd), origin 0/86 (both even) vs 6/95 (even/odd).
    expect(camera.tileSize % 2).toBe(1)
    expect(camera.originY % 2).toBe(0)
  })

  it('maps a hand-computed client point inside tile (8, 14) to that tile', () => {
    // cssX in [0 + 3*29, +29) = [87, 116), centre 101.5 -> client 141.5
    // cssY in [86 + 5*29, +29) = [231, 260), centre 245.5 -> client 268.5
    const r = rig(m0Device())
    expect(r.input.down(1, 101.5 + CANVAS_LEFT, 245.5 + CANVAS_TOP)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.lastCell).toBe(CELL_8_14)
  })

  it('has no left letterbox at all — cssX 0 is already the board', () => {
    // The property PHONE_390 cannot check: with originX 0 the LEFT region is
    // empty, and the first column starts at the canvas edge.
    const camera = m0Device()
    const hit = createGridHit()
    screenToGrid(camera, CANVAS_LEFT, 245.5 + CANVAS_TOP, CANVAS_LEFT, CANVAS_TOP, hit)
    expect(hit.region).toBe(HitRegion.GRID)
    expect(hit.gx).toBe(REVEALED_X0)
    const r = rig(camera)
    expect(r.input.down(1, CANVAS_LEFT, 245.5 + CANVAS_TOP)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.lastCell).toBe(14 * GRID_W + 5)
  })

  it('drags and walks on it exactly as on the letterboxed fixture', () => {
    // (8,14) -> (11,15): the same (+3, +1) jump, different camera. A transform
    // that only works when originX != 0 fails here.
    const camera = m0Device()
    const r = rig(camera)
    r.input.down(1, 101.5 + CANVAS_LEFT, 245.5 + CANVAS_TOP)
    // (11,15) centre: cssX = 0 + 6*29 + 14.5 = 188.5, cssY = 86 + 6*29 + 14.5 = 274.5
    expect(r.input.move(1, 188.5 + CANVAS_LEFT, 274.5 + CANVAS_TOP)).toBe(PointerOutcome.DRAW)
    expect(queued(r.queue)).toEqual([
      { kind: 'place', a: CELL_8_14, b: CELL_9_15 },
      { kind: 'place', a: CELL_9_15, b: CELL_10_15 },
      { kind: 'place', a: CELL_10_15, b: CELL_11_15 },
    ])
  })

  it('pauses on its own clock rect, which is a different rectangle from PHONE_390’s', () => {
    // w = floor((406 - 16 - 16)/3) = 124, so clock cssX in [8, 132), y in [772, 828).
    // Centre (70, 800). On PHONE_390 the clock is [8, 127) x [746, 802) — the y
    // ranges do not even overlap, so this cannot pass by reusing that fixture.
    const camera = m0Device()
    const rects = hudRects(camera, createHudRects())
    expect(rects.clock).toEqual({ x: 8, y: 772, w: 124, h: 56 })
    const r = rig(camera)
    expect(r.input.down(1, 70 + CANVAS_LEFT, 800 + CANVAS_TOP)).toBe(PointerOutcome.PAUSE_TOGGLED)
    expect(r.paused).toBe(true)
    expect(r.queue.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Taps that are not the board
// ---------------------------------------------------------------------------

describe('a tap outside the grid rect', () => {
  /** Each marker is one CSS px past exactly ONE bound, inside the other axis. */
  const cases: readonly [string, number, number][] = [
    ['one px above the grid rect', T8_14_X, ORIGIN_Y - 1 + CANVAS_TOP],
    ['one px left of it', ORIGIN_X - 1 + CANVAS_LEFT, T8_14_Y],
    ['exactly at its right edge', GRID_RIGHT + CANVAS_LEFT, T8_14_Y],
    ['exactly at its bottom edge, above the HUD band', T8_14_X, GRID_BOTTOM + CANVAS_TOP],
    ['in the bottom safe-area inset, below the HUD band', T8_14_X, 810 + CANVAS_TOP],
  ]

  for (const [name, x, y] of cases) {
    it(`${name} produces no action and starts no drag`, () => {
      const r = rig()
      expect(r.input.down(1, x, y)).toBe(PointerOutcome.IGNORED)
      expect(r.input.dragging).toBe(false)
      expect(r.input.lastCell).toBe(-1)
      expect(r.queue.length).toBe(0)
      expect(r.setPausedCalls).toEqual([])
    })
  }

  it('gives the top band NOTHING, even directly above an interactive HUD rect', () => {
    // Spec §8.3 bars any interactive element from the top band, and §7.2's
    // preference for a clock up there is what M2 resolved against. This uses
    // the clock rect's own x, so a tap that is only "not the board" would still
    // be caught by the parametrised cases above — what this adds is that
    // routing ABOVE anywhere near the HUD cannot reach the pause control.
    const r = rig()
    expect(r.input.down(1, CLOCK_X, ORIGIN_Y - 1 + CANVAS_TOP)).toBe(PointerOutcome.IGNORED)
    expect(r.paused).toBe(false)
    expect(r.setPausedCalls).toEqual([])
    expect(r.input.dragging).toBe(false)
    // discriminator: the same x IS the pause control down in the band
    const p = rig()
    expect(p.input.down(1, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.PAUSE_TOGGLED)
  })

  it('is not merely refusing everything — the SAME y one px lower IS the board', () => {
    // Vacuity for the "above" marker: the bound is real and one-sided.
    const r = rig()
    expect(r.input.down(1, T8_14_X, ORIGIN_Y + CANVAS_TOP)).toBe(PointerOutcome.DRAG_START)
  })

  it('is not merely refusing everything — the SAME x one px right IS the board', () => {
    const r = rig()
    expect(r.input.down(1, ORIGIN_X + CANVAS_LEFT, T8_14_Y)).toBe(PointerOutcome.DRAG_START)
  })
})

// ---------------------------------------------------------------------------
// The HUD, and the hit-test ORDER
// ---------------------------------------------------------------------------

describe('the HUD', () => {
  it('toggles pause on a tap in the clock rect, and queues no board action', () => {
    const r = rig()
    expect(r.input.down(1, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.PAUSE_TOGGLED)
    expect(r.paused).toBe(true)
    expect(r.setPausedCalls).toEqual([true])
    expect(r.queue.length).toBe(0)
    expect(r.input.dragging).toBe(false)
  })

  it('toggles it back on a second tap', () => {
    const r = rig()
    r.input.down(1, CLOCK_X, CLOCK_Y)
    r.input.up(1)
    expect(r.input.down(2, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.PAUSE_TOGGLED)
    expect(r.paused).toBe(false)
    expect(r.setPausedCalls).toEqual([true, false])
  })

  it('does nothing on the score and tiles readouts — they are inert in M2', () => {
    for (const x of [234.5, 361.5]) {
      const r = rig()
      expect(r.input.down(1, x, CLOCK_Y)).toBe(PointerOutcome.HUD_INERT)
      expect(r.paused).toBe(false)
      expect(r.setPausedCalls).toEqual([])
      expect(r.queue.length).toBe(0)
    }
  })

  /**
   * The clock rect's four bounds, each probed one CSS px inside and one CSS px
   * outside, with the other axis held at the rect's centre line. Every
   * "outside" marker is still inside the HUD BAND, so what it tests is the
   * rect, not the band — and it is past exactly one bound.
   */
  const edges: readonly [string, number, number, number][] = [
    // name, clientX, clientY, expected outcome
    ['inside the left edge', 8 + CANVAS_LEFT, CLOCK_Y, PointerOutcome.PAUSE_TOGGLED],
    ['one px outside the left edge', 7 + CANVAS_LEFT, CLOCK_Y, PointerOutcome.HUD_INERT],
    ['inside the right edge', 126 + CANVAS_LEFT, CLOCK_Y, PointerOutcome.PAUSE_TOGGLED],
    ['at the right edge', 127 + CANVAS_LEFT, CLOCK_Y, PointerOutcome.HUD_INERT],
    ['inside the top edge', CLOCK_X, 746 + CANVAS_TOP, PointerOutcome.PAUSE_TOGGLED],
    ['one px outside the top edge', CLOCK_X, 745 + CANVAS_TOP, PointerOutcome.HUD_INERT],
    ['inside the bottom edge', CLOCK_X, 801 + CANVAS_TOP, PointerOutcome.PAUSE_TOGGLED],
    ['at the bottom edge', CLOCK_X, 802 + CANVAS_TOP, PointerOutcome.HUD_INERT],
  ]

  for (const [name, x, y, expected] of edges) {
    it(`classifies a tap ${name} of the clock rect`, () => {
      const r = rig()
      expect(r.input.down(1, x, y)).toBe(expected)
    })
  }

  it('subtracts the canvas offset for the RECT test too, on both axes', () => {
    // Two markers chosen because dropping the offset flips each one, which the
    // clock's centre does not: at client (47, 797) an unsubtracted cssX of 47
    // lands inside the clock rect [8, 127) and would pause; at client
    // (107.5, 824) an unsubtracted cssY of 824 is past the rect's 802 and would
    // NOT pause.
    const a = rig()
    expect(a.input.down(1, 7 + CANVAS_LEFT, CLOCK_Y)).toBe(PointerOutcome.HUD_INERT)
    expect(a.paused).toBe(false)

    const b = rig()
    expect(b.input.down(1, CLOCK_X, 801 + CANVAS_TOP)).toBe(PointerOutcome.PAUSE_TOGGLED)
    expect(b.paused).toBe(true)
  })

  it('routes on screenToGrid’s band classification, which flips at exactly cssY 738', () => {
    const camera = phone390()
    const hit = createGridHit()
    const below = rig()
    const band = rig()

    screenToGrid(camera, CLOCK_X, HUD_TOP - 1 + CANVAS_TOP, CANVAS_LEFT, CANVAS_TOP, hit)
    expect(hit.region).toBe(HitRegion.BELOW)
    expect(below.input.down(1, CLOCK_X, HUD_TOP - 1 + CANVAS_TOP)).toBe(PointerOutcome.IGNORED)

    screenToGrid(camera, CLOCK_X, HUD_TOP + CANVAS_TOP, CANVAS_LEFT, CANVAS_TOP, hit)
    expect(hit.region).toBe(HitRegion.HUD)
    expect(band.input.down(1, CLOCK_X, HUD_TOP + CANVAS_TOP)).toBe(PointerOutcome.HUD_INERT)
  })
})

describe('the hit-test order: HUD first, then the grid rect, then nothing', () => {
  /**
   * The ordering is asserted here even though `fitCamera` makes the two regions
   * disjoint, because the REASON they are disjoint lives in `fitCamera` and a
   * change there must not silently make the board eat pause taps.
   *
   * **Where the ordering really lives.** `screenToGrid` returns one region
   * code, so by the time `pointer.ts` sees it `HUD` and `GRID` are mutually
   * exclusive and swapping the two branches there is a CHECKED 0-detector
   * no-op. The order that can actually change behaviour is `screenToGrid`'s
   * own: it tests the HUD band BEFORE the grid-bottom check. This test builds a
   * camera where the two overlap and pins that — a cross-package assertion,
   * placed in `game` because `game` is the only package that sees both.
   */
  const OVERLAPPING: Camera = {
    tileSize: 27,
    originX: 6,
    originY: 95,
    x0: 5,
    y0: 9,
    cols: 14,
    rows: 22,
    dpr: 1.5,
    cssW: 390,
    cssH: 844,
    // 400 is INSIDE the grid rect's [95, 689): the band and the board overlap.
    hudTop: 400,
    hudHeight: 72,
  }

  it('has a fixture whose two regions genuinely overlap', () => {
    expect(OVERLAPPING.hudTop).toBeLessThan(OVERLAPPING.originY + OVERLAPPING.rows * OVERLAPPING.tileSize)
    const rects = hudRects(OVERLAPPING, createHudRects())
    expect(rects.clock).toEqual({ x: 8, y: 408, w: 119, h: 56 })
  })

  it('gives a point in the overlap to the HUD, and lays no road', () => {
    const r = rig(OVERLAPPING)
    // css (67.5, 430): inside the clock rect [8,127)x[408,464) AND inside the
    // grid rect, where it would be board cell (7, 21) = 511.
    expect(r.input.down(1, 67.5 + CANVAS_LEFT, 430 + CANVAS_TOP)).toBe(PointerOutcome.PAUSE_TOGGLED)
    expect(r.paused).toBe(true)
    expect(r.input.dragging).toBe(false)
    expect(r.queue.length).toBe(0)
  })

  it('is not vacuous: the same camera DOES resolve that point to a board cell', () => {
    // Without the ordering, the tap above lays a road at (7, 21).
    const hit = createGridHit()
    const noBand: Camera = { ...OVERLAPPING, hudTop: 689 }
    screenToGrid(noBand, 67.5 + CANVAS_LEFT, 430 + CANVAS_TOP, CANVAS_LEFT, CANVAS_TOP, hit)
    expect(hit.region).toBe(HitRegion.GRID)
    expect(hit.gy * GRID_W + hit.gx).toBe(21 * GRID_W + 7)
  })
})

// ---------------------------------------------------------------------------
// The drag
// ---------------------------------------------------------------------------

describe('a drag across adjacent tiles', () => {
  it('emits one place action per cell entered, in order, with the right endpoints', () => {
    // (8,14) -> (9,14) -> (9,15): east, then south. The direction CHANGES, so a
    // transposed axis cannot pass.
    const r = rig()
    expect(r.input.down(1, T8_14_X, T8_14_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.move(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAW)
    expect(r.input.move(1, T9_15_X, T9_15_Y)).toBe(PointerOutcome.DRAW)
    expect(queued(r.queue)).toEqual([
      { kind: 'place', a: CELL_8_14, b: CELL_9_14 },
      { kind: 'place', a: CELL_9_14, b: CELL_9_15 },
    ])
    expect(r.input.lastCell).toBe(CELL_9_15)
  })

  it('changes direction at least once, which is what makes the axes separable', () => {
    // The brief's vacuity self-check, asserted of the fixture rather than
    // trusted: the first step is horizontal, the second vertical.
    expect(chebyshev(CELL_8_14, CELL_9_14)).toBe(1)
    expect(CELL_9_14 - CELL_8_14).toBe(1) // +x
    expect(CELL_9_15 - CELL_9_14).toBe(GRID_W) // +y
  })

  it('emits nothing for a move that stays inside the tile it is already on', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.move(1, T9_15_X, T9_15_Y)
    expect(r.queue.length).toBe(1)
    // 5 CSS px further into the same tile: css (132.5, 275.5), still (9, 15).
    expect(r.input.move(1, T9_15_X + 5, T9_15_Y + 5)).toBe(PointerOutcome.IGNORED)
    expect(r.queue.length).toBe(1)
    expect(r.input.lastCell).toBe(CELL_9_15)
  })

  it('emits nothing for a move that leaves the grid rect, and keeps the drag on its cell', () => {
    // The grid-bounds guard. Without it the walk runs toward (-1, -1).
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.move(1, ORIGIN_X - 1 + CANVAS_LEFT, T8_14_Y)).toBe(PointerOutcome.IGNORED)
    expect(r.queue.length).toBe(0)
    expect(r.input.lastCell).toBe(CELL_8_14)
    // and the drag is still live: re-entering emits a walk from where it left
    expect(r.input.move(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAW)
    expect(queued(r.queue)).toEqual([{ kind: 'place', a: CELL_8_14, b: CELL_9_14 }])
  })
})

describe('a fast drag that skips tiles', () => {
  it('walks an 8-connected chain for a (+3, +1) jump — three actions, not one', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.move(1, T11_15_X, T11_15_Y)).toBe(PointerOutcome.DRAW)
    expect(queued(r.queue)).toEqual([
      { kind: 'place', a: CELL_8_14, b: CELL_9_15 }, // diagonal SE
      { kind: 'place', a: CELL_9_15, b: CELL_10_15 }, // east
      { kind: 'place', a: CELL_10_15, b: CELL_11_15 }, // east
    ])
    expect(r.input.lastCell).toBe(CELL_11_15)
  })

  it('walks a (-2, +3) jump too — mixed signs, so a sign error cannot hide', () => {
    const r = rig()
    r.input.down(1, T11_15_X, T11_15_Y)
    expect(r.input.move(1, T9_18_X, T9_18_Y)).toBe(PointerOutcome.DRAW)
    expect(queued(r.queue)).toEqual([
      { kind: 'place', a: CELL_11_15, b: CELL_10_16 }, // diagonal SW
      { kind: 'place', a: CELL_10_16, b: CELL_9_17 }, // diagonal SW
      { kind: 'place', a: CELL_9_17, b: CELL_9_18 }, // south
    ])
  })

  /**
   * The same three structural assertions the (+3, +1) jump gets, carried to
   * the NEGATIVE-going jump rather than left at the instance where they were
   * written. The catalogue's "a lesson gets applied where it was learned and
   * not carried to its sibling": a walk that steps +1 unconditionally produces
   * the correct chain for (+3, +1) and a wrong one only here, so without this
   * the whole sign of the step rests on one equality assertion.
   */
  it('emits a contiguous 8-adjacent chain of Chebyshev length for the negative jump too', () => {
    const r = rig()
    r.input.down(1, T11_15_X, T11_15_Y)
    r.input.move(1, T9_18_X, T9_18_Y)
    const actions = queued(r.queue)
    expect(actions.length).toBe(chebyshev(CELL_11_15, CELL_9_18))
    expect(actions.length).toBe(3)
    expect(actions[0]?.a).toBe(CELL_11_15)
    for (let i = 1; i < actions.length; i++) expect(actions[i]?.a).toBe(actions[i - 1]?.b)
    expect(actions[actions.length - 1]?.b).toBe(CELL_9_18)
    for (const action of actions) {
      const dx = (action.b % GRID_W) - (action.a % GRID_W)
      const dy = Math.floor(action.b / GRID_W) - Math.floor(action.a / GRID_W)
      expect(Math.abs(dx)).toBeLessThanOrEqual(1)
      expect(Math.abs(dy)).toBeLessThanOrEqual(1)
      expect(dx === 0 && dy === 0).toBe(false)
      expect(dirBetween(action.a, action.b, GRID_W, 40)).not.toBe(-1)
    }
    // and the walk actually went backwards on x and forwards on y, which is
    // the property the fixture exists for.
    expect((CELL_9_18 % GRID_W) - (CELL_11_15 % GRID_W)).toBeLessThan(0)
    expect(Math.floor(CELL_9_18 / GRID_W) - Math.floor(CELL_11_15 / GRID_W)).toBeGreaterThan(0)
  })

  it('has a jump that is neither purely orthogonal nor purely diagonal', () => {
    // The brief's vacuity condition. (+3, +1): |dx| != |dy| and neither is 0,
    // so an axis-swapped walk and a diagonal-only walk both produce a different
    // chain. Asserted of the fixture, not assumed.
    for (const [a, b, dx, dy] of [
      [CELL_8_14, CELL_11_15, 3, 1],
      [CELL_11_15, CELL_9_18, -2, 3],
    ] as const) {
      expect((b % GRID_W) - (a % GRID_W)).toBe(dx)
      expect(Math.floor(b / GRID_W) - Math.floor(a / GRID_W)).toBe(dy)
      expect(Math.abs(dx)).not.toBe(Math.abs(dy)) // not purely diagonal
      expect(dx * dy).not.toBe(0) // not purely orthogonal
    }
  })

  it('emits exactly the Chebyshev distance in actions, and every pair is 8-adjacent', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.move(1, T11_15_X, T11_15_Y)
    const actions = queued(r.queue)
    expect(actions.length).toBe(chebyshev(CELL_8_14, CELL_11_15))
    expect(actions.length).toBe(3)
    for (const action of actions) {
      const dx = (action.b % GRID_W) - (action.a % GRID_W)
      const dy = Math.floor(action.b / GRID_W) - Math.floor(action.a / GRID_W)
      expect(Math.abs(dx)).toBeLessThanOrEqual(1)
      expect(Math.abs(dy)).toBeLessThanOrEqual(1)
      expect(dx === 0 && dy === 0).toBe(false)
    }
  })

  it('forms a contiguous chain from the previous cell to the new one', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.move(1, T11_15_X, T11_15_Y)
    const actions = queued(r.queue)
    expect(actions[0]?.a).toBe(CELL_8_14)
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i]?.a).toBe(actions[i - 1]?.b)
    }
    expect(actions[actions.length - 1]?.b).toBe(CELL_11_15)
  })

  it('emits pairs the sim will actually accept — dirBetween is never -1', () => {
    // The reason the walk exists: `canPlaceRoad` returns `not-adjacent`
    // whenever `dirBetween === -1`, and `step` ignores the return value, so a
    // skipped pair is dropped SILENTLY.
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.move(1, T11_15_X, T11_15_Y)
    r.input.move(1, T9_18_X, T9_18_Y)
    const actions = queued(r.queue)
    expect(actions.length).toBe(6)
    for (const action of actions) {
      expect(dirBetween(action.a, action.b, GRID_W, 40)).not.toBe(-1)
    }
  })

  it('lays a road with NO HOLES through the real sim, where one action per sample lays nothing', () => {
    // The end-to-end form of the same claim, on land cells: firstCity row 20 is
    // '.....T......~...........' (column 6 is land) and row 21 is
    // '............~....T......' (columns 7-9 are land).
    const map = firstCity()
    const world = createWorld(map)
    const camera = phone390()
    const r = rig(camera)

    r.input.down(1, centreX(camera, 6), centreY(camera, 20))
    r.input.move(1, centreX(camera, 9), centreY(camera, 21))
    const actions = queued(r.queue)
    expect(actions.map((a) => [a.a, a.b])).toEqual([
      [486, 511],
      [511, 512],
      [512, 513],
    ])

    const walked = createState('pointer-walk', map)
    for (const action of actions) expect(placeRoad(walked, world, action.a, action.b)).toBe(true)
    for (const cell of [486, 511, 512, 513]) {
      expect(walked.roads[cell], `cell ${cell} has no road`).not.toBe(0)
    }

    // The contrast, and the whole point: one action per SAMPLE is the pair
    // (486, 513), which `placeRoad` refuses silently.
    const sampled = createState('pointer-sample', map)
    expect(placeRoad(sampled, world, 486, 513)).toBe(false)
    for (const cell of [486, 511, 512, 513]) {
      expect(sampled.roads[cell]).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Erase mode
// ---------------------------------------------------------------------------

describe('erase is a MODE, never a tap and never a long-press', () => {
  it('starts in draw mode', () => {
    expect(rig().input.eraseMode).toBe(false)
  })

  it('emits erase actions and never place while the mode is on', () => {
    const r = rig()
    r.input.setEraseMode(true)
    expect(r.input.eraseMode).toBe(true)
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.move(1, T9_14_X, T9_14_Y)
    r.input.move(1, T9_15_X, T9_15_Y)
    expect(queued(r.queue)).toEqual([
      { kind: 'erase', a: CELL_8_14, b: CELL_9_14 },
      { kind: 'erase', a: CELL_9_14, b: CELL_9_15 },
    ])
    expect(queued(r.queue).some((a) => a.kind === 'place')).toBe(false)
  })

  it('emits erase for every cell of a skipping drag too, not just the first', () => {
    const r = rig()
    r.input.setEraseMode(true)
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.move(1, T11_15_X, T11_15_Y)
    const kinds = queued(r.queue).map((a) => a.kind)
    expect(kinds).toEqual(['erase', 'erase', 'erase'])
  })

  it('emits place again once the mode is toggled back', () => {
    const r = rig()
    expect(r.input.toggleEraseMode()).toBe(true)
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.move(1, T9_14_X, T9_14_Y)
    r.input.up(1)
    expect(r.input.toggleEraseMode()).toBe(false)
    r.input.down(1, T9_14_X, T9_14_Y)
    r.input.move(1, T9_15_X, T9_15_Y)
    expect(queued(r.queue)).toEqual([
      { kind: 'erase', a: CELL_8_14, b: CELL_9_14 },
      { kind: 'place', a: CELL_9_14, b: CELL_9_15 },
    ])
  })

  it('latches the stroke’s mode at pointerdown — MainButton is reachable mid-stroke', () => {
    // `MainButton` is native chrome outside the webview's content area, so
    // unlike a DOM button a second finger CAN press it during a stroke. A
    // stroke must not end up half road and half erasure.
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.move(1, T9_14_X, T9_14_Y)
    expect(r.input.toggleEraseMode()).toBe(true)
    // the pending mode changed immediately, so the button's label stays honest
    expect(r.input.eraseMode).toBe(true)
    // ...and the stroke in progress did not
    expect(r.input.strokeEraseMode).toBe(false)
    r.input.move(1, T9_15_X, T9_15_Y)
    expect(queued(r.queue).map((a) => a.kind)).toEqual(['place', 'place'])
  })

  it('applies the new mode to the NEXT stroke', () => {
    // The other half: latching must not mean the toggle is ignored.
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.move(1, T9_14_X, T9_14_Y)
    r.input.toggleEraseMode()
    r.input.up(1)
    expect(r.input.strokeEraseMode).toBe(true)
    r.input.down(2, T9_14_X, T9_14_Y)
    r.input.move(2, T9_15_X, T9_15_Y)
    expect(queued(r.queue).map((a) => a.kind)).toEqual(['place', 'erase'])
  })

  it('is not entered or left by any gesture in this module', () => {
    // Spec §7.3's whole point: no tap and no long-press changes the mode, so a
    // player trying to move the camera cannot delete a road by accident.
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.move(1, T9_14_X, T9_14_Y)
    r.input.up(1)
    expect(r.input.eraseMode).toBe(false)
    // including a tap that lands on the HUD, and one that lands nowhere
    r.input.down(1, CLOCK_X, CLOCK_Y)
    r.input.down(1, T8_14_X, ORIGIN_Y - 1 + CANVAS_TOP)
    expect(r.input.eraseMode).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// pointercancel
// ---------------------------------------------------------------------------

describe('pointercancel ends the drag', () => {
  it('stops a cancelled drag from laying road at a distant tile', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.cancel(1)).toBe(PointerOutcome.DRAG_END)
    expect(r.input.dragging).toBe(false)
    expect(r.input.move(1, T14_20_X, T14_20_Y)).toBe(PointerOutcome.IGNORED)
    expect(r.queue.length).toBe(0)
  })

  it('is not passing because the pointer was up — the same move DOES draw after a down', () => {
    // What else could prevent the action: no drag was ever started. So both
    // halves are asserted, on the SAME move.
    const never = rig()
    expect(never.input.move(1, T14_20_X, T14_20_Y)).toBe(PointerOutcome.IGNORED)
    expect(never.queue.length).toBe(0)

    const live = rig()
    live.input.down(1, T8_14_X, T8_14_Y)
    expect(live.input.move(1, T14_20_X, T14_20_Y)).toBe(PointerOutcome.DRAW)
    expect(live.queue.length).toBe(chebyshev(CELL_8_14, CELL_14_20))
    expect(live.queue.length).toBe(6)
    expect(queued(live.queue)[5]?.b).toBe(CELL_14_20)
  })

  it('does not latch: the next tap starts a fresh drag from its own cell', () => {
    // The failure mode a missing cancel branch produces is not "no road" but
    // "road from the ABANDONED cell", which only a second stroke can see.
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.cancel(1)
    expect(r.input.down(2, T11_15_X, T11_15_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.lastCell).toBe(CELL_11_15)
    r.input.move(2, T9_18_X, T9_18_Y)
    expect(queued(r.queue)[0]?.a).toBe(CELL_11_15)
  })

  it('ignores a cancel for a pointer that does not own the drag', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.cancel(2)).toBe(PointerOutcome.IGNORED)
    expect(r.input.dragging).toBe(true)
    expect(r.input.move(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAW)
  })

  it('ignores a cancel when no drag is active', () => {
    expect(rig().input.cancel(1)).toBe(PointerOutcome.IGNORED)
  })

  it('behaves exactly as up does in M2 — a CHECKED equivalence, recorded not assumed', () => {
    const viaUp = rig()
    viaUp.input.down(1, T8_14_X, T8_14_Y)
    viaUp.input.up(1)
    const viaCancel = rig()
    viaCancel.input.down(1, T8_14_X, T8_14_Y)
    viaCancel.input.cancel(1)
    expect(viaUp.input.dragging).toBe(viaCancel.input.dragging)
    expect(viaUp.input.activePointerId).toBe(viaCancel.input.activePointerId)
    expect(viaUp.queue.length).toBe(viaCancel.queue.length)
  })
})

// ---------------------------------------------------------------------------
// The latch, and its recovery
// ---------------------------------------------------------------------------

describe('a pointerId that does not fit an int32', () => {
  /**
   * The bug this fixture exists for: the drag slots were an `Int32Array`, which
   * COERCES on write, so `down(2**31)` stored -2147483648 and no later event
   * could match. `dragging` stayed true forever and the single-pointer rule then
   * refused every subsequent `pointerdown` — **input died for the rest of the
   * session, from one event.**
   *
   * A conforming browser cannot send this: `PointerEvent.pointerId` is a WebIDL
   * `long`. That is precisely why it was reasoned away instead of tested, and
   * why the test is here now — a renderer must never be the thing that bricks
   * the game on an out-of-contract input.
   */
  const HUGE = 2 ** 31
  const HUGER = 2 ** 40 + 3

  for (const id of [HUGE, HUGER, -7, 0]) {
    it(`round-trips a drag owned by pointerId ${id}`, () => {
      const r = rig()
      expect(r.input.down(id, T8_14_X, T8_14_Y)).toBe(PointerOutcome.DRAG_START)
      expect(r.input.activePointerId).toBe(id)
      expect(r.input.move(id, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAW)
      expect(queued(r.queue)).toEqual([{ kind: 'place', a: CELL_8_14, b: CELL_9_14 }])
      expect(r.input.up(id)).toBe(PointerOutcome.DRAG_END)
      expect(r.input.dragging).toBe(false)
    })
  }

  it('does not confuse two ids that an int32 would collapse together', () => {
    // -2147483648 is what `Int32Array` turned 2**31 into. The two must stay
    // distinct owners, or the coercion bug is back in a different shape.
    const r = rig()
    r.input.down(HUGE, T8_14_X, T8_14_Y)
    expect(r.input.move(-2147483648, T9_14_X, T9_14_Y)).toBe(PointerOutcome.IGNORED)
    expect(r.queue.length).toBe(0)
    expect(r.input.up(-2147483648)).toBe(PointerOutcome.IGNORED)
    expect(r.input.dragging).toBe(true)
  })

  it('does not brick the session — a later ordinary drag still works', () => {
    // The end-to-end form: the failure mode was never "this one drag broke", it
    // was "everything after it broke".
    const r = rig()
    r.input.down(HUGE, T8_14_X, T8_14_Y)
    r.input.up(HUGE)
    expect(r.input.down(1, T11_15_X, T11_15_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.move(1, T9_18_X, T9_18_Y)).toBe(PointerOutcome.DRAW)
    expect(r.queue.length).toBe(3)
  })
})

describe('a drag whose end event was lost has a recovery path', () => {
  it('lets the OWNING pointer’s next down end the stale drag and start a fresh one', () => {
    // A conforming browser cannot deliver two `pointerdown`s for the same active
    // pointerId, so one means the up/cancel was lost — a backgrounded webview, a
    // dropped Telegram event. Before this, the drag latched and the
    // single-pointer rule refused even its owner: the only recovery was
    // reloading the Mini App.
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.down(1, T11_15_X, T11_15_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.dragging).toBe(true)
    expect(r.input.activePointerId).toBe(1)
    // and it restarts AT THE NEW CELL, not from the abandoned one
    expect(r.input.lastCell).toBe(CELL_11_15)
    expect(r.queue.length).toBe(0)
    r.input.move(1, T9_18_X, T9_18_Y)
    expect(queued(r.queue)[0]?.a).toBe(CELL_11_15)
  })

  it('still refuses a DIFFERENT pointer, so the recovery is not a hole in the rule', () => {
    // Discriminator: the recovery must key on the owning id, or it is just the
    // single-pointer rule deleted.
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.down(2, T11_15_X, T11_15_Y)).toBe(PointerOutcome.REFUSED_SECOND_POINTER)
    expect(r.input.activePointerId).toBe(1)
    expect(r.input.lastCell).toBe(CELL_8_14)
  })

  it('abort() ends a drag out of band, and is idempotent', () => {
    // `main.ts` calls this on a `visibilitychange` to hidden (`attachVisibility`),
    // where the webview may never deliver the pointerup. **That is its only
    // production caller** — this comment also named a Telegram `deactivated`
    // event for two milestones and there has never been a handler for one.
    const r = rig()
    expect(r.input.abort()).toBe(PointerOutcome.IGNORED)
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.abort()).toBe(PointerOutcome.DRAG_END)
    expect(r.input.dragging).toBe(false)
    expect(r.input.abort()).toBe(PointerOutcome.IGNORED)
    // and it does not latch: a distant move after the abort draws nothing
    expect(r.input.move(1, T14_20_X, T14_20_Y)).toBe(PointerOutcome.IGNORED)
    expect(r.queue.length).toBe(0)
  })

  it('reports activePointerId as -1 when idle rather than a stale owner', () => {
    const r = rig()
    expect(r.input.activePointerId).toBe(-1)
    r.input.down(9, T8_14_X, T8_14_Y)
    expect(r.input.activePointerId).toBe(9)
    r.input.cancel(9)
    expect(r.input.activePointerId).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// The single-pointer rule
// ---------------------------------------------------------------------------

describe('one pointer owns the drag', () => {
  it('refuses a second pointerdown and leaves the first drag untouched', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.down(2, T11_15_X, T11_15_Y)).toBe(PointerOutcome.REFUSED_SECOND_POINTER)
    expect(r.input.activePointerId).toBe(1)
    expect(r.input.lastCell).toBe(CELL_8_14)
    expect(r.queue.length).toBe(0)
  })

  it('ignores the second pointer’s moves', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.down(2, T11_15_X, T11_15_Y)
    expect(r.input.move(2, T9_18_X, T9_18_Y)).toBe(PointerOutcome.IGNORED)
    expect(r.queue.length).toBe(0)
    expect(r.input.lastCell).toBe(CELL_8_14)
  })

  it('leaves the first drag working after the second pointer is released', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.down(2, T11_15_X, T11_15_Y)
    expect(r.input.up(2)).toBe(PointerOutcome.IGNORED)
    expect(r.input.dragging).toBe(true)
    expect(r.input.activePointerId).toBe(1)
    expect(r.input.move(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAW)
    expect(queued(r.queue)).toEqual([{ kind: 'place', a: CELL_8_14, b: CELL_9_14 }])
  })

  it('refuses a second pointer on the HUD too, so a second finger cannot pause mid-stroke', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    expect(r.input.down(2, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.REFUSED_SECOND_POINTER)
    expect(r.paused).toBe(false)
    expect(r.setPausedCalls).toEqual([])
  })

  it('hands ownership to the next pointer once the first ends', () => {
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.input.up(1)
    expect(r.input.activePointerId).toBe(-1)
    expect(r.input.down(7, T11_15_X, T11_15_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.activePointerId).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

describe('board input while paused', () => {
  it('produces no action, and the SAME sequence unpaused does', () => {
    // The negative assertion's discriminator: the only difference between the
    // two halves is the pause flag.
    const paused = rig()
    paused.input.down(1, CLOCK_X, CLOCK_Y)
    expect(paused.paused).toBe(true)
    expect(paused.input.down(2, T8_14_X, T8_14_Y)).toBe(PointerOutcome.REFUSED_PAUSED)
    expect(paused.input.dragging).toBe(false)
    expect(paused.input.move(2, T9_14_X, T9_14_Y)).toBe(PointerOutcome.IGNORED)
    expect(paused.queue.length).toBe(0)

    const running = rig()
    expect(running.input.down(2, T8_14_X, T8_14_Y)).toBe(PointerOutcome.DRAG_START)
    expect(running.input.move(2, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAW)
    expect(running.queue.length).toBe(1)
  })

  it('resumes accepting board input after the clock is tapped again', () => {
    const r = rig()
    r.input.down(1, CLOCK_X, CLOCK_Y)
    r.input.up(1)
    r.input.down(2, CLOCK_X, CLOCK_Y)
    r.input.up(2)
    expect(r.paused).toBe(false)
    expect(r.input.down(3, T8_14_X, T8_14_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.move(3, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAW)
    expect(queued(r.queue)).toEqual([{ kind: 'place', a: CELL_8_14, b: CELL_9_14 }])
  })

  it('refuses a move on a drag that was live when something else paused the game', () => {
    // The host can pause from outside the pointer — `Game.setPaused`, which
    // `main.ts` exports, plus M3's hard pause when it lands — and that is the
    // only way a live drag can meet a paused game, since the single-pointer
    // rule blocks the clock while dragging. **Not a Telegram `deactivated`
    // event**, which this comment named for two milestones and which has never
    // had a handler anywhere in `packages/`; the guard is kept for the rule, not
    // for an enumerated caller (`pointer.ts`'s `move` says why).
    const r = rig()
    r.input.down(1, T8_14_X, T8_14_Y)
    r.forcePaused(true)
    expect(r.input.move(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.REFUSED_PAUSED)
    expect(r.queue.length).toBe(0)
    r.forcePaused(false)
    expect(r.input.move(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAW)
    expect(r.queue.length).toBe(1)
  })

  it('still lets the clock be tapped while paused — pause is always available', () => {
    const r = rig()
    r.forcePaused(true)
    expect(r.input.down(1, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.PAUSE_TOGGLED)
    expect(r.paused).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The transform is reused, not reimplemented
// ---------------------------------------------------------------------------

/**
 * **What the scan catches, stated narrowly, because it was oversold.**
 *
 * Task 7's review verified three evasions that pass all four scan assertions
 * and all of the behavioural tests: a helper in a sibling file, computed
 * property keys (`camera['tile' + 'Size']`), and re-deriving the HUD layout from
 * `cssW`/`hudTop`/`hudHeight`, which were not on the forbidden list. Two are
 * closed below — the forbidden list now includes the camera's canvas and band
 * fields, and the relative-import set is pinned so a sibling helper cannot
 * appear without the scan seeing it. Computed keys are not closed and cannot be
 * by a name scan.
 *
 * So: **the scan's unique catch is one narrow shape** — a plainly-written second
 * inverse appearing in this file — and it is worth exactly that. It does not
 * catch a *buggy* second inverse; the behavioural probes do, and they are the
 * real guard. The 308-cell sweep, the six-region agreement probe and the HUD
 * band sweep all compare the module's answers against `render`'s own functions
 * on the same inputs, so any second implementation that disagrees anywhere in
 * the revealed rect or the HUD band fails regardless of how it was written.
 */
describe('pointer.ts reuses render’s inverse rather than writing a second one', () => {
  const src = readFileSync(new URL('../src/pointer.ts', import.meta.url), 'utf8')
  /** Comments stripped, so prose naming a field is not mistaken for arithmetic on it. */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('has a non-trivial file to scan, and a non-trivial one left after stripping comments', () => {
    // Vacuity, both halves: an empty file, or a strip that ate the code,
    // satisfies every "does not contain" assertion below.
    expect(src.length).toBeGreaterThan(4000)
    expect(code.length).toBeGreaterThan(1500)
    expect(code).toContain('export function createPointerInput')
  })

  it('calls screenToGrid, in both handlers', () => {
    expect(code).toContain('screenToGrid(')
    expect(code.match(/screenToGrid\(/g)?.length).toBe(2)
  })

  it('does no arithmetic on any camera field the inverse owns', () => {
    // `cssW`, `cssH`, `hudTop` and `hudHeight` are on the list because the
    // review demonstrated the third evasion with them: they are enough to
    // re-derive `hudRects`' three columns without touching a single field the
    // original list named.
    const owned = [
      'tileSize',
      'originX',
      'originY',
      'x0',
      'y0',
      'cols',
      'rows',
      'cssW',
      'cssH',
      'hudTop',
      'hudHeight',
    ]
    for (const field of owned) {
      expect(code, `pointer.ts touches camera.${field} — a second inverse is forming`).not.toMatch(
        new RegExp(`\\b${field}\\b`),
      )
    }
    // Vacuity: the list must be able to fire at all. `camera.tileSize` is what
    // a second inverse would reach for first.
    expect(`const t = camera.tileSize`).toMatch(new RegExp(`\\b${owned[0] as string}\\b`))
  })

  it('imports no sibling module that could hold the arithmetic instead', () => {
    // The first evasion the review verified: move the transform into a new
    // `game/src` file and call it. A helper has to be imported, so pinning the
    // relative-import set is what sees it — the scan above never would.
    const relative = [...code.matchAll(/from '(\.[^']*)'/g)].map((m) => m[1])
    expect(relative).toEqual(['./inputs'])
    const packages = [...code.matchAll(/from '(@laneways\/[^']*)'/g)].map((m) => m[1])
    expect([...new Set(packages)].sort()).toEqual(['@laneways/render', '@laneways/sim'])
  })

  it('does not reach for the forward transform either', () => {
    expect(code).not.toContain('gridToScreen')
  })

  it('is the same transform render’s own tests pin — one inverse, one owner', () => {
    // Belt and braces: the module's cell answer is exactly `screenToGrid`'s,
    // composed with `y*w + x`, for a point in every one of the six regions.
    const camera = phone390()
    const hit = createGridHit()
    const probes: readonly [number, number][] = [
      [T8_14_X, T8_14_Y],
      [T11_15_X, T11_15_Y],
      [ORIGIN_X - 1 + CANVAS_LEFT, T8_14_Y],
      [GRID_RIGHT + CANVAS_LEFT, T8_14_Y],
      [T8_14_X, ORIGIN_Y - 1 + CANVAS_TOP],
      [T8_14_X, GRID_BOTTOM + CANVAS_TOP],
      [CLOCK_X, CLOCK_Y],
    ]
    const seen = new Set<number>()
    for (const [x, y] of probes) {
      screenToGrid(camera, x, y, CANVAS_LEFT, CANVAS_TOP, hit)
      seen.add(hit.region)
      const r = rig(camera)
      const outcome = r.input.down(1, x, y)
      if (hit.region === HitRegion.GRID) {
        expect(outcome).toBe(PointerOutcome.DRAG_START)
        expect(r.input.lastCell).toBe(hit.gy * GRID_W + hit.gx)
      } else if (hit.region === HitRegion.HUD) {
        expect(outcome).toBe(PointerOutcome.PAUSE_TOGGLED)
      } else {
        expect(outcome).toBe(PointerOutcome.IGNORED)
        expect(r.input.lastCell).toBe(-1)
      }
    }
    // Vacuity: the probe set must actually reach more than one region.
    expect(seen.size).toBeGreaterThanOrEqual(5)
  })

  it('agrees with render’s own hudRects across the whole HUD band, not just the clock', () => {
    // The behavioural half of the third evasion: a second HUD layout derived
    // from `cssW`/`hudTop`/`hudHeight` passes the scan, and disagreeing with
    // `hudRects` anywhere in the band fails here. Swept at 3 px, which is finer
    // than the 8 px padding and the 8 px gaps.
    const camera = phone390()
    const rects = hudRects(camera, createHudRects())
    let inClock = 0
    let outside = 0
    for (let cssY = HUD_TOP; cssY < HUD_TOP + 72; cssY += 3) {
      for (let cssX = 0; cssX < 390; cssX += 3) {
        const r = rig(camera)
        const outcome = r.input.down(1, cssX + CANVAS_LEFT, cssY + CANVAS_TOP)
        const expectedClock =
          cssX >= rects.clock.x &&
          cssX < rects.clock.x + rects.clock.w &&
          cssY >= rects.clock.y &&
          cssY < rects.clock.y + rects.clock.h
        expect(outcome, `(${cssX}, ${cssY})`).toBe(
          expectedClock ? PointerOutcome.PAUSE_TOGGLED : PointerOutcome.HUD_INERT,
        )
        if (expectedClock) inClock++
        else outside++
      }
    }
    // Vacuity: the sweep must land on both sides of every edge of the rect.
    expect(inClock).toBeGreaterThan(100)
    expect(outside).toBeGreaterThan(100)
  })
})

// ---------------------------------------------------------------------------
// Housekeeping the rest of the milestone depends on
// ---------------------------------------------------------------------------

describe('the outcome codes', () => {
  it('are all distinct and all non-zero, so `if (outcome)` cannot misread one', () => {
    const values = Object.values(PointerOutcome)
    expect(new Set(values).size).toBe(values.length)
    for (const v of values) expect(v).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Game over is terminal at the input boundary — M1e Task 9
// ---------------------------------------------------------------------------

describe('once the city has shut down', () => {
  it('a tap anywhere starts a new run', () => {
    const r = rig()
    r.endRun()
    expect(r.input.down(1, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.RESTART_REQUESTED)
    expect(r.input.down(2, T9_14_X, T9_14_Y)).toBe(PointerOutcome.RESTART_REQUESTED)
    // The letterbox too — every region, not merely the two interactive ones.
    expect(r.input.down(3, 1 + CANVAS_LEFT, ORIGIN_Y + 10 + CANVAS_TOP)).toBe(
      PointerOutcome.RESTART_REQUESTED,
    )
    expect(r.restarts).toBe(3)
    // The negative that matters: the clock tap must not ALSO have toggled
    // pause. Before this guard a clock tap un-paused a dead sim, the pause bars
    // vanished, `HitRegion.GRID` re-opened — it is refused *while paused* and by
    // nothing else — and the player drew roads that never appeared, spent no
    // tiles and got no message.
    expect(r.setPausedCalls, 'the clock toggle must be unreachable').toEqual([])
    expect(queued(r.queue), 'and no road may be queued').toEqual([])
  })

  it('is inert before the run is over — pause still toggles and the board still draws', () => {
    // The other side of the guard. Without this the early return is
    // indistinguishable from `down()` returning RESTART_REQUESTED always.
    const r = rig()
    expect(r.input.down(1, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.PAUSE_TOGGLED)
    expect(r.restarts).toBe(0)
    const b = rig()
    expect(b.input.down(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAG_START)
    expect(b.restarts).toBe(0)
  })

  it('outranks the single-pointer rule, so a second finger can still restart', () => {
    // **The guard is the FIRST statement of `down()`, above the `dragging`
    // block, and this is why.** A city can die mid-stroke: the run ends inside
    // `advance`, the drag is still live and still owned by finger 1. With the
    // guard placed after the single-pointer rule, finger 2's tap comes back
    // REFUSED_SECOND_POINTER and the player is left tapping a frozen board with
    // "TAP TO PLAY AGAIN" written across it.
    const r = rig()
    expect(r.input.down(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.dragging).toBe(true)
    r.endRun()
    expect(r.input.down(2, T11_15_X, T11_15_Y)).toBe(PointerOutcome.RESTART_REQUESTED)
    expect(r.restarts).toBe(1)
    // Vacuity: while the run is LIVE the same second finger is refused, so this
    // test is about the shutdown and not about a rule that never applied.
    const live = rig()
    expect(live.input.down(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAG_START)
    expect(live.input.down(2, T11_15_X, T11_15_Y)).toBe(PointerOutcome.REFUSED_SECOND_POINTER)
  })

  it('needs no second guard in `move`, because the shutdown pauses and pause already refuses', () => {
    // **Why there is ONE guard and not three**, recorded so nobody adds the
    // other two on the strength of this file having no test for them.
    // `Loop.end()` sets `paused`, and `move` refuses every board sample while
    // paused. A `gameOver` guard in `move` would be a second INDEPENDENTLY
    // SUFFICIENT structure, which by this repo's own catalogue leaves neither
    // half with a detector — the shape to write down rather than to cover.
    //
    // The outcome code is what makes this assertable at all: "nothing was
    // queued" is satisfied by six different causes and REFUSED_PAUSED names the
    // one that actually fired.
    const r = rig()
    expect(r.input.down(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAG_START)
    r.endRun()
    expect(r.input.move(1, T11_15_X, T11_15_Y)).toBe(PointerOutcome.REFUSED_PAUSED)
    expect(queued(r.queue)).toEqual([])
    // And the drag can still be ended, so nothing latches: `up` is the one
    // handler that must keep working on a dead board, or a restart-by-reload
    // would be the only way to clear a captured pointer.
    expect(r.input.up(1)).toBe(PointerOutcome.DRAG_END)
    expect(r.input.dragging).toBe(false)
  })

  it('asks for exactly one new run per tap, not one per frame', () => {
    // `restart` reloads the page in production. A guard that called it from a
    // getter, or twice per event, would reload mid-reload.
    const r = rig()
    r.endRun()
    r.input.down(1, CLOCK_X, CLOCK_Y)
    expect(r.restarts).toBe(1)
    // Reading the machine's state must not ask for another one.
    expect(r.input.dragging).toBe(false)
    expect(r.input.lastCell).toBe(-1)
    expect(r.input.eraseMode).toBe(false)
    expect(r.restarts).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// §5.10's offer modal owns every tap while it is up — M1f Task 8
// ---------------------------------------------------------------------------

/**
 * A board point ABOVE the modal, hand-computed against the fixture: css
 * (100.5, 130), which is board cell (8, 10).
 *
 * ```
 * cardA.y = 202, the title strip is [162, 190) and its gap [190, 202)
 * board band starts at originY 95, so [95, 162) is bare board
 * gx = 5 + floor((100.5 - 6) / 27) = 5 + 3 = 8
 * gy = 9 + floor((130 - 95) / 27)  = 9 + 1 = 10
 * ```
 *
 * **This point exists because of `OFFER_CARD_MAX_H_CSS`**, and without the cap
 * there would be no board pixel outside a card on this viewport at all — the
 * whole `REFUSED_OFFER_MODAL` branch would be unreachable from a real camera.
 */
const BOARD_ABOVE_MODAL_X = 140.5
const BOARD_ABOVE_MODAL_Y = 153
const CELL_8_10 = 10 * GRID_W + 8

/** The 12 CSS px gap BETWEEN the two cards: css (200, 408). Inside the modal, on neither card. */
const BETWEEN_CARDS_X = 240
const BETWEEN_CARDS_Y = 431

describe('the fixture can tell the modal’s regions apart', () => {
  it('puts the "above the modal" probe on the board and outside every offer rect', () => {
    // Without this the whole describe below could be asserting about a point
    // that is in the letterbox, or one that is quietly on card A.
    const r = rig()
    const hit = createGridHit()
    screenToGrid(r.host.camera(), BOARD_ABOVE_MODAL_X, BOARD_ABOVE_MODAL_Y, CANVAS_LEFT, CANVAS_TOP, hit)
    expect(hit.region, 'the probe is not on the board').toBe(HitRegion.GRID)
    expect(hit.gy * GRID_W + hit.gx).toBe(CELL_8_10)
    const rects = modal(r)
    const cssX = BOARD_ABOVE_MODAL_X - CANVAS_LEFT
    const cssY = BOARD_ABOVE_MODAL_Y - CANVAS_TOP
    for (const [name, rect] of [
      ['cardA', rects.cardA],
      ['cardB', rects.cardB],
      ['peek', rects.peek],
    ] as const) {
      const inside =
        cssX >= rect.x && cssX < rect.x + rect.w && cssY >= rect.y && cssY < rect.y + rect.h
      expect(inside, `the probe is on ${name}`).toBe(false)
    }
  })

  it('puts the "between the cards" probe inside the modal and on neither card', () => {
    const r = rig()
    const rects = modal(r)
    const cssY = BETWEEN_CARDS_Y - CANVAS_TOP
    expect(cssY, 'below card A').toBeGreaterThanOrEqual(rects.cardA.y + rects.cardA.h)
    expect(cssY, 'above card B').toBeLessThan(rects.cardB.y)
    const cssX = BETWEEN_CARDS_X - CANVAS_LEFT
    expect(cssX, 'and horizontally within the modal’s column').toBeGreaterThanOrEqual(rects.cardA.x)
  })

  it('puts the two card centres on DIFFERENT points, so a swapped rect is visible', () => {
    const rects = modal(rig())
    expect(centreOf(rects.cardA)).not.toEqual(centreOf(rects.cardB))
    expect(centreOf(rects.cardA)[1]).toBeLessThan(centreOf(rects.cardB)[1])
  })
})

describe('the offer modal owns every tap while it is up', () => {
  it('queues a choose-card with the SLOT and the card id it believes it is taking', () => {
    const r = rig()
    r.raiseOffer()
    expect(r.input.down(1, ...centreOf(modal(r).cardB))).toBe(PointerOutcome.CARD_CHOSEN)
    expect(queued(r.queue)).toEqual([
      { kind: 'choose-card', a: OFFER_SLOT_B, b: CARD_JUNCTION_UPGRADE },
    ])
  })

  it('takes slot A from card A, so the two are not the same branch', () => {
    // Two cases rather than one, because a single-card fixture cannot tell
    // "reads the rect it was tapped on" from "always takes slot A".
    const r = rig()
    r.raiseOffer()
    expect(r.input.down(1, ...centreOf(modal(r).cardA))).toBe(PointerOutcome.CARD_CHOSEN)
    expect(queued(r.queue)).toEqual([{ kind: 'choose-card', a: OFFER_SLOT_A, b: CARD_ROAD_TILES }])
  })

  it('echoes the id the HOST reports, never a card id of its own', () => {
    // **This is the mutant `applyChooseCard`'s echo throw exists for.** The
    // second argument is the card THIS CLIENT believes the slot holds, read
    // from the same frame the player tapped; `sim` throws if it disagrees, and
    // that throw is the replay-divergence detector. A pointer that re-derived
    // the id — or read the wrong slot's — would make an honest client produce a
    // log that fails verification.
    const r = rig()
    r.raiseOffer(CARD_JUNCTION_UPGRADE, CARD_ROAD_TILES) // deliberately the other way round
    r.input.down(1, ...centreOf(modal(r).cardA))
    expect(queued(r.queue)).toEqual([
      { kind: 'choose-card', a: OFFER_SLOT_A, b: CARD_JUNCTION_UPGRADE },
    ])
  })

  it('resumes the loop on the choice, because the tick that resolves the offer cannot run while paused', () => {
    const r = rig()
    r.raiseOffer()
    expect(r.setPausedCalls, 'the fixture paused, as `main.ts` does').toEqual([])
    r.input.down(1, ...centreOf(modal(r).cardA))
    expect(r.setPausedCalls).toEqual([false])
    expect(r.paused).toBe(false)
  })

  it('refuses a tap that misses both cards, and names the guard that refused it', () => {
    const r = rig()
    r.raiseOffer()
    expect(r.input.down(1, BETWEEN_CARDS_X, BETWEEN_CARDS_Y)).toBe(PointerOutcome.REFUSED_OFFER_MODAL)
    expect(queued(r.queue)).toEqual([])
    expect(r.setPausedCalls, 'and the board did not restart').toEqual([])
  })

  it('refuses a HUD-CLOCK tap while the modal is up — a pause toggle would resume a dead board', () => {
    // **The reason the arbitration is ONE branch above everything rather than a
    // guard per path.** The clock is a pause TOGGLE: with the modal's own guard
    // missing it would clear `paused` from outside this decision entirely, and
    // the board would run behind a modal until the next drained tick re-armed
    // it. §5.10 gives this modal no skip.
    const r = rig()
    r.raiseOffer()
    expect(r.input.down(1, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.REFUSED_OFFER_MODAL)
    expect(r.setPausedCalls, 'and the clock did not toggle').toEqual([])
    expect(r.paused).toBe(true)
  })

  it('refuses a GRID tap while the modal is up', () => {
    const r = rig()
    r.raiseOffer()
    expect(r.input.down(1, BOARD_ABOVE_MODAL_X, BOARD_ABOVE_MODAL_Y)).toBe(
      PointerOutcome.REFUSED_OFFER_MODAL,
    )
    expect(r.input.dragging, 'and no drag started').toBe(false)
    expect(queued(r.queue)).toEqual([])
  })

  it('names the OFFER as the refuser, not the pause, so the two guards are distinguishable', () => {
    // A board tap while merely paused is REFUSED_PAUSED and while a modal is up
    // is REFUSED_OFFER_MODAL. Both are true at once in production — the modal
    // pauses — so a single code would make "the modal refused it" unassertable
    // and the ordering below unobservable.
    const r = rig()
    r.forcePaused(true)
    expect(r.input.down(1, BOARD_ABOVE_MODAL_X, BOARD_ABOVE_MODAL_Y)).toBe(PointerOutcome.REFUSED_PAUSED)
    r.raiseOffer()
    expect(r.input.down(2, BOARD_ABOVE_MODAL_X, BOARD_ABOVE_MODAL_Y)).toBe(
      PointerOutcome.REFUSED_OFFER_MODAL,
    )
  })

  it('answers the next tap of a stroke that was mid-drag when the boundary arrived', () => {
    // **The case the ordering exists for, as a fixture rather than as a
    // comment.** The modal branch is ABOVE the `dragging` block, so a modal
    // raised mid-stroke does not answer REFUSED_SECOND_POINTER in front of a
    // screen asking for a choice — which would leave the player unable to take
    // either card until they lifted a finger the game never told them was
    // still down.
    const r = rig()
    expect(r.input.down(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.dragging).toBe(true)
    r.raiseOffer()
    expect(r.input.down(2, ...centreOf(modal(r).cardA))).toBe(PointerOutcome.CARD_CHOSEN)
    expect(queued(r.queue)).toEqual([{ kind: 'choose-card', a: OFFER_SLOT_A, b: CARD_ROAD_TILES }])
  })

  it('is BELOW the game-over branch, so a city that dies mid-modal still restarts', () => {
    // Unreachable in production — `step` freezes past the failure, so no week
    // boundary can be crossed on a dead board — and ordered anyway, because the
    // two screens both want the same tap and only one of them has a way out.
    const r = rig()
    r.raiseOffer()
    r.endRun()
    expect(r.input.down(1, ...centreOf(modal(r).cardA))).toBe(PointerOutcome.RESTART_REQUESTED)
    expect(r.restarts).toBe(1)
    expect(queued(r.queue), 'and no card was taken off a dead board').toEqual([])
  })

  it('leaves every existing path alone when no offer is pending', () => {
    // The gate, on the fixture that has cards loaded — so this cannot pass
    // because the rig forgot to set them.
    const r = rig()
    r.raiseOffer()
    r.resolveOffer()
    r.forcePaused(false)
    expect(r.input.down(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.down(2, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.REFUSED_SECOND_POINTER)
    r.input.up(1)
    expect(r.input.down(3, CLOCK_X, CLOCK_Y)).toBe(PointerOutcome.PAUSE_TOGGLED)
  })

  it('stops owning taps the moment the offer resolves, even while still paused', () => {
    // The window between the tap and the tick that applies it: the loop has
    // been resumed, one zero-tick frame runs, then the tick lands. A second tap
    // in that window is still the modal's — `offerPending` is the whole gate —
    // and `sim` no-ops the duplicate against `H_OFFER_WEEK === H_WEEK`.
    const r = rig()
    r.raiseOffer()
    r.input.down(1, ...centreOf(modal(r).cardA))
    expect(r.input.down(2, ...centreOf(modal(r).cardB)), 'still the modal’s').toBe(
      PointerOutcome.CARD_CHOSEN,
    )
    expect(queued(r.queue).length, 'two actions, and sim absorbs the second').toBe(2)
    r.resolveOffer()
    expect(r.input.down(3, BOARD_ABOVE_MODAL_X, BOARD_ABOVE_MODAL_Y)).toBe(PointerOutcome.DRAG_START)
  })
})

describe('peek: it hides the modal, and it does not skip the week', () => {
  it('toggles peek, and a tap ANYWHERE returns from it', () => {
    const r = rig()
    r.raiseOffer()
    expect(r.input.peeking, 'the modal opens showing itself').toBe(false)
    expect(r.input.down(1, ...centreOf(modal(r).peek))).toBe(PointerOutcome.PEEK_TOGGLED)
    expect(r.input.peeking).toBe(true)
    // Anywhere: a board point, not the peek rect. The way back must not require
    // finding the control again on a screen that is no longer showing it.
    expect(r.input.down(2, BOARD_ABOVE_MODAL_X, BOARD_ABOVE_MODAL_Y)).toBe(PointerOutcome.PEEK_TOGGLED)
    expect(r.input.peeking).toBe(false)
    expect(queued(r.queue), 'and nothing reached the sim either way').toEqual([])
  })

  it('does NOT resume the loop while peeking — peek inspects, it does not skip', () => {
    // Plan Decision 16. A peek that resumed the sim would be a free unpause
    // with no cost, which is the one thing a modal with no timer and no skip
    // must not offer: hold peek for the rest of the week and the offer is
    // gone.
    const r = rig()
    r.raiseOffer()
    r.input.down(1, ...centreOf(modal(r).peek))
    expect(r.setPausedCalls).toEqual([])
    expect(r.paused).toBe(true)
    r.input.down(2, BOARD_ABOVE_MODAL_X, BOARD_ABOVE_MODAL_Y)
    expect(r.setPausedCalls, 'and returning does not resume it either').toEqual([])
    expect(r.paused).toBe(true)
  })

  it('cannot take a card while peeking — the cards are not on screen to be tapped', () => {
    // The return is the FIRST thing the modal branch does, above the rect
    // tests, so a tap that happens to land where card B was drawn returns
    // rather than spending the week on a card the player could not see.
    const r = rig()
    r.raiseOffer()
    r.input.down(1, ...centreOf(modal(r).peek))
    expect(r.input.down(2, ...centreOf(modal(r).cardB))).toBe(PointerOutcome.PEEK_TOGGLED)
    expect(queued(r.queue)).toEqual([])
    expect(r.input.peeking).toBe(false)
    // ...and now that the modal is back, the same point takes the card.
    expect(r.input.down(3, ...centreOf(modal(r).cardB))).toBe(PointerOutcome.CARD_CHOSEN)
  })

  it('clears peek when the offer resolves, so the next modal opens showing itself', () => {
    // Peek is a property of THIS modal, not of the session. Left latched, the
    // next week's offer would open invisible over a frozen board — the state
    // M1f Task 7 shipped on purpose and interlocked against, reached by a
    // control the player used correctly a week earlier.
    const r = rig()
    r.raiseOffer()
    r.input.down(1, ...centreOf(modal(r).peek))
    expect(r.input.peeking).toBe(true)
    r.resolveOffer()
    r.forcePaused(false)
    // **Reading it is the poll**, and `main.ts` does this once per frame — the
    // frame driver folds `pointer.peeking` into `RenderFrame.offerPeek` on
    // every draw, and there are 4,500 ticks between one week boundary and the
    // next. This module never sees the offer resolve; the tick does.
    expect(r.input.peeking, 'the flag came down with the modal').toBe(false)

    // ...and the next week's modal opens SHOWING ITSELF, which is the failure
    // this clears for: a latched peek would put the player in front of a frozen
    // board with one TAP TO RETURN on it and no sign a choice was waiting.
    r.raiseOffer()
    expect(r.input.peeking).toBe(false)
    expect(r.input.down(2, ...centreOf(modal(r).cardA)), 'and the first tap takes a card').toBe(
      PointerOutcome.CARD_CHOSEN,
    )
  })

  it('is not reachable at all when no offer is pending', () => {
    const r = rig()
    expect(r.input.down(1, ...centreOf(modal(r).peek))).not.toBe(PointerOutcome.PEEK_TOGGLED)
    expect(r.input.peeking).toBe(false)
  })

  it('refuses the drag that was in progress when the boundary arrived, and queues nothing', () => {
    // **`move`'s `paused` guard is LIVE, and this is the fixture that says so.**
    // `pointer.ts` claimed for two milestones that a drag could not survive
    // into a paused state, on the argument that pause is only reachable from a
    // clock tap and the single-pointer rule refuses that mid-drag. M1f Task 7
    // made it false: the boundary arrives from inside a TICK, `onOfferRaised`
    // fires, `main.ts` pauses, and no tap happened at all.
    //
    // Without the guard those samples enqueue `place` actions that no tick
    // drains — the loop is paused — and they all land in a burst on the tick
    // after the player answers the modal.
    const r = rig()
    expect(r.input.down(1, T9_14_X, T9_14_Y)).toBe(PointerOutcome.DRAG_START)
    expect(r.input.dragging).toBe(true)
    // Exactly what `main.ts` does from `onOfferRaised`: no tap, no `down`.
    r.raiseOffer()
    expect(r.input.move(1, T11_15_X, T11_15_Y)).toBe(PointerOutcome.REFUSED_PAUSED)
    expect(queued(r.queue), 'road was drawn onto a frozen board').toEqual([])
    expect(r.input.dragging, 'and the stroke is still the owner’s to end').toBe(true)
    // `up` stays live on a paused board, so nothing latches.
    expect(r.input.up(1)).toBe(PointerOutcome.DRAG_END)
    // Non-vacuous: the SAME two samples on the same rig draw road when the
    // offer is not up, so this is the guard refusing and not the fixture
    // failing to move.
    const live = rig()
    live.input.down(1, T9_14_X, T9_14_Y)
    expect(live.input.move(1, T11_15_X, T11_15_Y)).toBe(PointerOutcome.DRAW)
    expect(queued(live.queue).length).toBeGreaterThan(0)
  })

  it('is BELOW game over too: a dead board offers a restart, not a peek', () => {
    const r = rig()
    r.raiseOffer()
    r.endRun()
    expect(r.input.down(1, ...centreOf(modal(r).peek))).toBe(PointerOutcome.RESTART_REQUESTED)
    expect(r.input.peeking).toBe(false)
  })
})
