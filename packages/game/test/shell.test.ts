import { describe, it, expect, afterEach } from 'vitest'
import { REVEALED_X0, REVEALED_Y0, REVEALED_W, REVEALED_H } from '@laneways/shared'
import { PALETTE, buildAtlases, drawFrame, fitCamera } from '@laneways/render'
import type { DrawContext, RenderFrame, RevealedRect, ViewportMetrics } from '@laneways/render'
import {
  SETTLE_FRAMES,
  SizingOutcome,
  bootShell,
  measureViewport,
  rafSettle,
  type SizableCanvas,
  type ScalableContext,
  type Shell,
} from '../src/shell'

/**
 * Plan Task 8: two-pass sizing, and an atlas rebuild driven by the tile's
 * **device** size changing rather than by a resize event.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO PASSES, AND WHY THE SECOND IS MEASURED BEHAVIOUR
 * ---------------------------------------------------------------------------
 *
 * `spike/src/main.ts` sets a placeholder height at module eval and re-reads
 * `contentSafeAreaTop()` only after three `requestAnimationFrame`s, with a
 * comment saying why: at that point `requestFullscreen()` had only just been
 * called and **the client had not yet published the real inset**. So the first
 * pass is a guess by construction, not a precaution.
 *
 * ---------------------------------------------------------------------------
 * THE REBUILD GUARD IS A COUNT, NOT IDEMPOTENCE
 * ---------------------------------------------------------------------------
 *
 * "Rebuilding at the same size is idempotent" is not a guard — **a storm is
 * idempotent too**, and 256 tiles at 58 device px is a 928x928 rasterisation
 * per event. Every assertion below about not rebuilding is therefore a count.
 */

const REVEAL: RevealedRect = {
  x0: REVEALED_X0,
  y0: REVEALED_Y0,
  cols: REVEALED_W,
  rows: REVEALED_H,
}

// ---------------------------------------------------------------------------
// Recorders. One shared log, so ORDER across the Telegram calls and the canvas
// writes is observable rather than two separate stories.
// ---------------------------------------------------------------------------

interface CanvasRecorder extends SizableCanvas {
  readonly rectCalls: () => number
}

function recordingCanvas(log: string[], left = 0, top = 0): CanvasRecorder {
  let w = 0
  let h = 0
  let rects = 0
  const style = { width: '', height: '' }
  return {
    get width(): number {
      return w
    },
    set width(next: number) {
      w = next
      log.push(`canvas.width=${next}`)
    },
    get height(): number {
      return h
    },
    set height(next: number) {
      h = next
      log.push(`canvas.height=${next}`)
    },
    style,
    getBoundingClientRect(): { left: number; top: number } {
      rects++
      return { left, top }
    },
    rectCalls: () => rects,
  }
}

function recordingContext(log: string[]): ScalableContext {
  return {
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
      log.push(`setTransform(${a},${b},${c},${d},${e},${f})`)
    },
  }
}

interface TelegramStub {
  readonly emit: (isStateStable: boolean | undefined) => void
}

function installTelegram(log: string[], version = '8.0'): TelegramStub {
  const handlers: Array<(payload?: { isStateStable?: boolean }) => void> = []
  const webApp: Record<string, unknown> = {
    version,
    isVersionAtLeast: (want: string): boolean => {
      const a = version.split('.').map(Number)
      const b = want.split('.').map(Number)
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? 0
        const y = b[i] ?? 0
        if (x !== y) return x > y
      }
      return true
    },
    onEvent: (event: string, handler: (payload?: { isStateStable?: boolean }) => void): void => {
      log.push(`onEvent:${event}`)
      handlers.push(handler)
    },
  }
  for (const name of ['ready', 'expand', 'disableVerticalSwipes', 'requestFullscreen', 'lockOrientation']) {
    webApp[name] = (): void => {
      log.push(name)
    }
  }
  ;(globalThis as Record<string, unknown>).Telegram = { WebApp: webApp }
  return {
    emit(isStateStable): void {
      for (const handler of handlers) handler({ isStateStable })
    },
  }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Telegram
  delete (globalThis as Record<string, unknown>).innerWidth
  delete (globalThis as Record<string, unknown>).innerHeight
  delete (globalThis as Record<string, unknown>).devicePixelRatio
  delete (globalThis as Record<string, unknown>).requestAnimationFrame
})

/** The M0 reference device, which Task 9 deploys to. 29 CSS px tiles. */
const M0_DEVICE: ViewportMetrics = {
  cssW: 406,
  cssH: 870,
  topInset: 46,
  bottomInset: 34,
  rawDpr: 3,
  performanceClass: null,
}

interface Rig {
  readonly shell: Shell
  readonly log: string[]
  readonly canvas: CanvasRecorder
  readonly builds: number[]
  readonly setView: (view: ViewportMetrics) => void
  readonly settle: () => void
  readonly telegram: TelegramStub
}

interface RigOptions {
  readonly first: ViewportMetrics
  /** What the SECOND (post-settle) measurement reports. Defaults to `first`. */
  readonly second?: ViewportMetrics
  readonly version?: string
  readonly withoutTelegram?: boolean
}

function buildRig(options: RigOptions): Rig {
  const log: string[] = []
  const telegram = options.withoutTelegram
    ? { emit: (): void => undefined }
    : installTelegram(log, options.version)
  const canvas = recordingCanvas(log, 11, 7)
  const context = recordingContext(log)
  const builds: number[] = []
  let view = options.first
  let settleRun: (() => void) | null = null

  const shell = bootShell({
    canvas,
    context,
    reveal: REVEAL,
    measure: () => view,
    rebuildAtlas: (tileDevicePx: number) => {
      builds.push(tileDevicePx)
      log.push(`rebuildAtlas(${tileDevicePx})`)
    },
    settle: (run) => {
      settleRun = run
    },
  })

  if (options.second !== undefined) view = options.second

  return {
    shell,
    log,
    canvas,
    builds,
    telegram,
    setView(next): void {
      view = next
    },
    settle(): void {
      if (settleRun === null) throw new Error('the shell never scheduled a settle pass')
      settleRun()
    },
  }
}

// ---------------------------------------------------------------------------

describe('measureViewport(): what the production measurement actually reads', () => {
  it('reads BOTH inset systems, not only contentSafeAreaInset', () => {
    installTelegram([])
    const webApp = (globalThis as unknown as { Telegram: { WebApp: Record<string, unknown> } }).Telegram.WebApp
    webApp.contentSafeAreaInset = { top: 12 }
    webApp.safeAreaInset = { top: 59, bottom: 34 }
    webApp.viewportStableHeight = 812
    ;(globalThis as Record<string, unknown>).innerWidth = 390
    ;(globalThis as Record<string, unknown>).devicePixelRatio = 3

    const view = measureViewport()
    // 59 rather than 12: reading only the content inset loses 47 CSS px here.
    expect(view.topInset).toBe(59)
    expect(view.bottomInset).toBe(34)
    expect(view.cssW).toBe(390)
    // The STABLE height, not innerHeight — innerHeight is the transient one.
    expect(view.cssH).toBe(812)
    expect(view.rawDpr).toBe(3)
  })

  it('prefers the content inset when it is the larger — the fullscreen iPhone case', () => {
    installTelegram([])
    const webApp = (globalThis as unknown as { Telegram: { WebApp: Record<string, unknown> } }).Telegram.WebApp
    webApp.contentSafeAreaInset = { top: 46 }
    webApp.safeAreaInset = { top: 12, bottom: 34 }
    expect(measureViewport().topInset).toBe(46)
  })

  it('falls back to a DPR of 1 rather than 0 or undefined', () => {
    installTelegram([])
    ;(globalThis as Record<string, unknown>).devicePixelRatio = 0
    expect(measureViewport().rawDpr).toBe(1)
    delete (globalThis as Record<string, unknown>).devicePixelRatio
    expect(measureViewport().rawDpr).toBe(1)
  })
})

describe('rafSettle(): three frames, which is what the spike measured', () => {
  it('runs the body after exactly SETTLE_FRAMES frames, and not before', () => {
    const pending: Array<() => void> = []
    ;(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: () => void): number => {
      pending.push(cb)
      return pending.length
    }
    let ran = 0
    rafSettle(() => {
      ran++
    })
    // **The bound is the literal 3, not `SETTLE_FRAMES`, and that one word is
    // the difference between a behavioural detector and a pinned constant.**
    // Driving `SETTLE_FRAMES` frames passes for ANY value of it, so the only
    // thing that could catch `3 -> 2` was the pin below — which is a fact about
    // the constant, not about the code. With the literal here, `SETTLE_FRAMES =
    // 2` fails with "ran after only 2 frames".
    //
    // The pin stays as well: it says the shipped value is the spike's, which is
    // the part that has provenance.
    expect(SETTLE_FRAMES).toBe(3)
    for (let i = 0; i < 3; i++) {
      expect(ran, `ran after only ${i} frames`).toBe(0)
      const next = pending.shift()
      expect(next, `no frame ${i} was requested`).toBeDefined()
      next?.()
    }
    expect(ran).toBe(1)
    expect(pending.length).toBe(0)
  })

  it('runs the body immediately when there is no requestAnimationFrame at all', () => {
    let ran = 0
    rafSettle(() => {
      ran++
    })
    expect(ran).toBe(1)
  })
})

describe('the boot order: sizing happens AFTER the last Telegram call', () => {
  it('records ready, expand, the two gated calls, and only then touches the canvas', () => {
    const rig = buildRig({ first: M0_DEVICE })
    const sized = rig.log.findIndex((entry) => entry.startsWith('canvas.width='))
    expect(sized).toBeGreaterThan(-1)
    expect(rig.log.indexOf('ready')).toBeLessThan(sized)
    expect(rig.log.indexOf('expand')).toBeLessThan(sized)
    expect(rig.log.indexOf('disableVerticalSwipes')).toBeLessThan(sized)
    expect(rig.log.indexOf('requestFullscreen')).toBeLessThan(sized)
    expect(rig.log.indexOf('lockOrientation')).toBeLessThan(sized)
    // Vacuity: the sizing must be the FIRST canvas write, so "after the last
    // boot call" is not satisfied by a second pass that happened to come later.
    expect(rig.log.slice(0, sized).some((entry) => entry.startsWith('canvas.'))).toBe(false)
  })

  it('subscribes to viewportChanged, and says whether it managed to', () => {
    const rig = buildRig({ first: M0_DEVICE })
    expect(rig.log).toContain('onEvent:viewportChanged')
    expect(rig.shell.subscribed).toBe(true)
  })

  it('boots and sizes with no Telegram object at all', () => {
    const rig = buildRig({ first: M0_DEVICE, withoutTelegram: true })
    expect(rig.shell.subscribed).toBe(false)
    expect(rig.canvas.width).toBe(406 * 2)
    expect(rig.builds.length).toBe(1)
  })
})

describe('the sizing contract: round(css x dpr), and the transform after it', () => {
  it('sizes the backing store with round(), which floor() gets wrong at DPR 1.5', () => {
    // 413 x 1.5 = 619.5 and 871 x 1.5 = 1306.5: both land on a half device
    // pixel, so round and floor differ. Task 5 snaps its band edges with
    // `Math.round(css * dpr)` and the last device row is outside every band if
    // this disagrees.
    const rig = buildRig({
      first: { cssW: 413, cssH: 871, topInset: 24, bottomInset: 24, rawDpr: 1.5, performanceClass: 'LOW' },
    })
    expect(rig.canvas.width).toBe(620)
    expect(rig.canvas.height).toBe(1307)
    expect(rig.canvas.style.width).toBe('413px')
    expect(rig.canvas.style.height).toBe('871px')
  })

  it('applies the DPR cap through fitCamera rather than the raw ratio', () => {
    const rig = buildRig({ first: M0_DEVICE })
    // rawDpr 3, capped to 2.
    expect(rig.shell.camera.dpr).toBe(2)
    expect(rig.canvas.width).toBe(812)
  })

  /**
   * **Setting `canvas.width` resets the 2D context state, including the
   * transform.** So the scale must be re-applied after every resize, not once at
   * boot — otherwise every drawing after the first rotation is at DPR 1, on a
   * backing store sized for DPR 2, and the whole board renders in the top-left
   * quarter.
   */
  it('applies setTransform AFTER the width and height writes, on every resize', () => {
    const rig = buildRig({ first: M0_DEVICE })
    rig.setView({ ...M0_DEVICE, cssH: 800 })
    rig.shell.resize()
    const transforms: number[] = []
    const widths: number[] = []
    rig.log.forEach((entry, i) => {
      if (entry.startsWith('setTransform')) transforms.push(i)
      if (entry.startsWith('canvas.width=')) widths.push(i)
    })
    expect(widths.length).toBe(2)
    expect(transforms.length).toBe(2)
    for (let i = 0; i < 2; i++) expect(transforms[i] as number).toBeGreaterThan(widths[i] as number)
  })

  it('sets the transform to the CAPPED dpr on both axes and no translation', () => {
    const rig = buildRig({ first: M0_DEVICE })
    expect(rig.log).toContain('setTransform(2,0,0,2,0,0)')
  })

  it('caches the canvas offset for the pointer, measuring it once per applied resize', () => {
    const rig = buildRig({ first: M0_DEVICE })
    expect(rig.shell.canvasLeft).toBe(11)
    expect(rig.shell.canvasTop).toBe(7)
    const before = rig.canvas.rectCalls()
    // Reading the getters must not measure again: getBoundingClientRect
    // allocates a DOMRect, and `pointer.ts` reads these per event.
    for (let i = 0; i < 20; i++) {
      void rig.shell.canvasLeft
      void rig.shell.canvasTop
    }
    expect(rig.canvas.rectCalls()).toBe(before)
  })
})

describe('two passes, and the rebuild driven by the tile device size', () => {
  it('builds the atlas once at boot, at floor(tileSize * dpr)', () => {
    const rig = buildRig({ first: M0_DEVICE })
    expect(rig.shell.camera.tileSize).toBe(29)
    expect(rig.builds).toEqual([58])
    expect(rig.shell.tileDevicePx).toBe(58)
  })

  it('floors the product, because the LOW cap of 1.5 makes 29 x 1.5 = 43.5', () => {
    const rig = buildRig({
      first: { cssW: 406, cssH: 870, topInset: 46, bottomInset: 34, rawDpr: 3, performanceClass: 'LOW' },
    })
    expect(rig.shell.camera.tileSize).toBe(29)
    expect(rig.shell.camera.dpr).toBe(1.5)
    expect(rig.builds).toEqual([43])
  })

  it('a second measurement that DIFFERS rebuilds the atlas exactly once', () => {
    // Pass 1 is taken before the client published the real inset, so it reads
    // 0/0 and fits 152 CSS px of chrome as playfield. The viewport is
    // deliberately HEIGHT-bound (406/14 = 29 would otherwise win on both
    // passes and the fixture would agree with itself — which is exactly what
    // the first version of this test did).
    const short = { cssW: 406, cssH: 700, topInset: 0, bottomInset: 0, rawDpr: 3, performanceClass: null } as const
    const rig = buildRig({
      first: short,
      second: { ...short, topInset: 46, bottomInset: 34 },
    })
    // 700 - 72 = 628 available, 628 / 22 = 28.5 -> a 28 px tile, 56 device px.
    expect(rig.shell.camera.tileSize).toBe(28)
    expect(rig.builds).toEqual([56])
    const before = rig.shell.rebuilds
    rig.settle()
    expect(rig.shell.rebuilds - before).toBe(1)
    // 700 - 46 - 72 - 34 = 548 available, 548 / 22 = 24.9 -> 24, 48 device px.
    expect(rig.shell.camera.tileSize).toBe(24)
    expect(rig.builds).toEqual([56, 48])
  })

  /**
   * **The vacuity guard.** Without it, "always rebuild" passes the bullet above.
   */
  it('a second measurement that AGREES rebuilds the atlas zero times', () => {
    const rig = buildRig({ first: M0_DEVICE })
    const before = rig.shell.rebuilds
    rig.settle()
    expect(rig.shell.rebuilds - before).toBe(0)
    expect(rig.shell.measures).toBe(2)
  })

  it('the second pass measures even when it changes nothing — the guess is re-checked', () => {
    const rig = buildRig({ first: M0_DEVICE })
    expect(rig.shell.measures).toBe(1)
    rig.settle()
    expect(rig.shell.measures).toBe(2)
  })

  it('ten stable events at the same height rebuild zero times and rewrite nothing', () => {
    const rig = buildRig({ first: M0_DEVICE })
    rig.settle()
    const rebuilds = rig.shell.rebuilds
    const logLength = rig.log.length
    for (let i = 0; i < 10; i++) expect(rig.shell.viewportChanged(true)).toBe(SizingOutcome.UNCHANGED)
    expect(rig.shell.rebuilds - rebuilds).toBe(0)
    // Not merely "no rebuild": an unchanged viewport must not touch the canvas
    // at all. Writing `canvas.width` clears the backing store, and with no
    // clearRect anywhere that is a full-canvas cost per event.
    expect(rig.log.length).toBe(logLength)
    expect(rig.shell.measures).toBe(12)
  })

  it('one event that changes the tile size rebuilds exactly once, and reports REBUILT', () => {
    const rig = buildRig({ first: M0_DEVICE })
    rig.settle()
    const before = rig.shell.rebuilds
    // A keyboard opening: 200 CSS px less height. 670 - 46 - 72 - 34 = 518
    // available, 518 / 22 = 23.5 -> a 23 px tile, against 406 / 14 = 29.
    rig.setView({ ...M0_DEVICE, cssH: 670 })
    expect(rig.shell.viewportChanged(true)).toBe(SizingOutcome.REBUILT)
    expect(rig.shell.rebuilds - before).toBe(1)
    expect(rig.shell.camera.tileSize).toBe(23)
    expect(rig.builds.at(-1)).toBe(46)
  })

  /**
   * **The discriminating case for "driven by the tile size, not by the event".**
   * The canvas is resized and the atlas is not, because the tile's device size
   * did not move. An implementation that rebuilds on every resize passes every
   * other assertion in this file.
   */
  it('a resize that leaves the tile device size alone resizes without rebuilding', () => {
    const rig = buildRig({ first: M0_DEVICE })
    rig.settle()
    const before = rig.shell.rebuilds
    // 870 -> 869: availableH 718 -> 717, and floor(717/22) is still 29.
    rig.setView({ ...M0_DEVICE, cssH: 869 })
    expect(rig.shell.viewportChanged(true)).toBe(SizingOutcome.RESIZED)
    expect(rig.shell.rebuilds - before).toBe(0)
    expect(rig.shell.camera.tileSize).toBe(29)
    expect(rig.canvas.height).toBe(1738)
  })

  it('rebuilds when only the DPR changes, at the same CSS tile size', () => {
    const rig = buildRig({ first: M0_DEVICE })
    rig.settle()
    const before = rig.shell.rebuilds
    // Same geometry, a LOW-class Android: the CSS tile stays 29 and the device
    // tile goes 58 -> 43. A rebuild keyed on `tileSize` alone misses this.
    rig.setView({ ...M0_DEVICE, performanceClass: 'LOW' })
    expect(rig.shell.viewportChanged(true)).toBe(SizingOutcome.REBUILT)
    expect(rig.shell.rebuilds - before).toBe(1)
    expect(rig.shell.camera.tileSize).toBe(29)
    expect(rig.builds.at(-1)).toBe(43)
  })
})

/**
 * **The one place Task 5 and Task 8 have to agree, and neither package can see
 * the other.**
 *
 * `canvas.ts` says it at the top of `drawFrame`: *"Task 8 MUST size the canvas
 * with the same rounding, or the last device row/column is outside every band"*
 * — and outside every band means holding the previous frame forever, because
 * Decision 4 removed the `clearRect`. Up to here that was a comment in one
 * package and an implementation in another. This is the assertion.
 *
 * `game` is the only package that imports both, which is where this test has to
 * live — the same reason `renderDirections.test.ts` and
 * `renderFootprint.test.ts` live here.
 */
describe('the five matte fills tile the backing store the shell actually created', () => {
  interface Fill {
    x: number
    y: number
    w: number
    h: number
    style: string
  }

  function emptyFrame(camera: ReturnType<typeof fitCamera>): RenderFrame {
    return {
      camera,
      gridW: 24,
      roads: new Uint8Array(24 * 40),
      ghosts: new Uint8Array(24 * 40),
      terrainClass: new Uint8Array(24 * 40),
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
      carCount: 0,
      carXY: new Float32Array(0),
      carColour: new Uint8Array(0),
      week: 1,
      day: 1,
      score: 0,
      tilesLeft: 0,
      paused: false,
      // **`false`, and it is load-bearing here rather than boilerplate.** The
      // scrim is a sixth fill, so a game-over frame would break the exact
      // five-fill tiling this whole describe asserts — and the tiling assertion
      // is what would have caught it silently going to six.
      gameOver: false,
      failedDest: -1,
      // **No offer, for the same reason as `gameOver` above.** M1f Task 8's
      // modal is another fill on top of these five, so a fixture that left
      // these absent would assert the five-fill tiling against `undefined`
      // rather than against a decision.
      offerPending: false,
      offerA: 0,
      offerB: 0,
      offerGrantA: 0,
      offerGrantB: 0,
      offerItemsA: 0,
      offerItemsB: 0,
      offerPeek: false,
      // The four M1f Task 10 fields. This file is about the shell's band fills,
      // which the marker pass and the chip sit above and inside respectively —
      // both explicit and empty so nothing here draws either.
      upgradeAt: new Uint8Array(24 * 40),
      upgradeCount: 0,
      invUpgrades: 0,
      upgradeMode: false,
    }
  }

  function bandsFor(view: ViewportMetrics): { fills: Fill[]; canvas: CanvasRecorder } {
    const rig = buildRig({ first: view })
    const fills: Fill[] = []
    const ctx: DrawContext = {
      fillStyle: '',
      // M1e Task 9's five. This rig is about the band FILLS, and the frame it
      // draws is live, so no arc is ever issued through them.
      strokeStyle: '',
      lineWidth: 0,
      beginPath: () => undefined,
      arc: () => undefined,
      stroke: () => undefined,
      font: '',
      textAlign: 'center',
      textBaseline: 'middle',
      fillRect: (x, y, w, h) => {
        fills.push({ x, y, w, h, style: String(ctx.fillStyle) })
      },
      fillText: () => undefined,
      drawImage: () => undefined,
    }
    const atlases = buildAtlases(
      (w, h) => ({
        width: w,
        height: h,
        getContext: () => ({
          lineWidth: 0,
          lineCap: 'round' as const,
          lineJoin: 'round' as const,
          globalAlpha: 1,
          strokeStyle: '',
          save: () => undefined,
          restore: () => undefined,
          beginPath: () => undefined,
          rect: () => undefined,
          clip: () => undefined,
          moveTo: () => undefined,
          lineTo: () => undefined,
          stroke: () => undefined,
        }),
      }),
      rig.shell.tileDevicePx,
      PALETTE,
    )
    drawFrame(ctx, emptyFrame(rig.shell.camera), atlases, PALETTE)
    return { fills, canvas: rig.canvas }
  }

  /**
   * `413 x 871 at DPR 1.5` — integer CSS inputs, a real device shape, and the
   * exact case that produced Task 5's ghosting seam: `819 x 1.5 = 1228.5`.
   */
  const CASES: ReadonlyArray<readonly [string, ViewportMetrics]> = [
    ['the M0 device at DPR 2', M0_DEVICE],
    ['a LOW-class Pixel at DPR 1.5', { cssW: 413, cssH: 871, topInset: 24, bottomInset: 24, rawDpr: 1.5, performanceClass: 'LOW' }],
    ['a 390 px phone', { cssW: 390, cssH: 844, topInset: 47, bottomInset: 34, rawDpr: 3, performanceClass: null }],
  ]

  for (const [name, view] of CASES) {
    it(`covers every device pixel exactly once on ${name}`, () => {
      const { fills: all, canvas } = bandsFor(view)
      // An empty board: all terrain LAND, no roads, no buildings, no cars, not
      // paused. So the only BOARD fills are the five matte fills — the top band,
      // a letterbox column each side of the playfield, the playfield, and the
      // bottom band.
      //
      // **Classified by fill STYLE and not by count, since M1f Task 10**, which
      // added §7.2's inventory chip: the chip is one `fillRect` in the HUD band
      // on every frame, so the raw count is six. `background` and `land` are the
      // only two entries the matte uses and the only two no content path can
      // produce, so this filter is exact in both directions — the same
      // classifier `canvas.test.ts`'s `isMatte` uses, and for the reason it
      // gives: the letterbox columns are 2 CSS px wide here and 0 on the M0
      // device, so no geometric test separates them from content.
      const fills = all.filter((f) => f.style === PALETTE.background || f.style === PALETTE.land)
      expect(fills.length, 'five matte fills').toBe(5)
      expect(all.length - fills.length, "one non-matte fill: §7.2's chip icon").toBe(1)
      expect(
        all.find((f) => f.style === PALETTE.chipEmpty),
        'and it is the chip, greyed because the fixture holds none',
      ).toBeDefined()
      const dpr = view.performanceClass === 'LOW' ? Math.min(view.rawDpr, 1.5) : Math.min(view.rawDpr, 2)

      // **A partition proof, not a strip walk.** Since Task 9 the fills are not
      // a vertical strip, so the cursor form cannot express them — and it could
      // never express "no overlap" either, only "each starts where the last
      // ended". Three properties, none implied by the other two: every fill is
      // on the backing store, no two overlap, and the areas sum to it.
      const rects = fills.map((f) => {
        for (const edge of [f.x, f.y, f.x + f.w, f.y + f.h]) {
          const device = edge * dpr
          expect(
            Math.abs(device - Math.round(device)),
            `CSS ${edge} is device ${device}, a half pixel — Task 5's ghosting seam`,
          ).toBeLessThan(1e-9)
        }
        return {
          x0: Math.round(f.x * dpr),
          y0: Math.round(f.y * dpr),
          x1: Math.round((f.x + f.w) * dpr),
          y1: Math.round((f.y + f.h) * dpr),
        }
      })
      let area = 0
      for (const r of rects) {
        expect(r.x0).toBeGreaterThanOrEqual(0)
        expect(r.y0).toBeGreaterThanOrEqual(0)
        expect(r.x1, 'a fill runs past the backing store').toBeLessThanOrEqual(canvas.width)
        expect(r.y1, 'a fill runs past the backing store').toBeLessThanOrEqual(canvas.height)
        area += Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0)
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i] as { x0: number; y0: number; x1: number; y1: number }
          const b = rects[j] as { x0: number; y0: number; x1: number; y1: number }
          const overlap =
            Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
            Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
          expect(overlap, `fills ${i} and ${j} overlap — a doubly-covered device row`).toBe(0)
        }
      }
      // Exactly the backing store the SHELL created, which is the whole point of
      // this file owning the assertion: `round(cssW * dpr) x round(cssH * dpr)`.
      expect(area, 'a gap — device pixels holding the previous frame forever').toBe(
        canvas.width * canvas.height,
      )
    })
  }

  it('would fail if the shell floored instead of rounding — the mutation is representable', () => {
    // Not a mutation of the shipped code: an arithmetic statement that the two
    // roundings genuinely differ on this viewport, so the assertions above are
    // discriminating rather than trivially true at every DPR.
    expect(Math.round(413 * 1.5)).toBe(620)
    expect(Math.floor(413 * 1.5)).toBe(619)
    expect(Math.round(871 * 1.5)).toBe(1307)
    expect(Math.floor(871 * 1.5)).toBe(1306)
  })
})

describe('an unstable viewport event is not a measurement', () => {
  it('does not measure, does not resize and does not rebuild', () => {
    const rig = buildRig({ first: M0_DEVICE })
    rig.settle()
    const measures = rig.shell.measures
    const rebuilds = rig.shell.rebuilds
    rig.setView({ ...M0_DEVICE, cssH: 400 })
    expect(rig.shell.viewportChanged(false)).toBe(SizingOutcome.SKIPPED_UNSTABLE)
    expect(rig.shell.measures).toBe(measures)
    expect(rig.shell.rebuilds).toBe(rebuilds)
    expect(rig.shell.camera.cssH).toBe(870)
  })

  /**
   * The negative control: the same event with the same changed viewport DOES
   * re-measure when it is stable, so "nothing happened" above is about the
   * stability flag rather than about a rig that cannot observe anything.
   */
  it('the same event with isStateStable true does everything', () => {
    const rig = buildRig({ first: M0_DEVICE })
    rig.settle()
    rig.setView({ ...M0_DEVICE, cssH: 400 })
    expect(rig.shell.viewportChanged(true)).toBe(SizingOutcome.REBUILT)
    expect(rig.shell.camera.cssH).toBe(400)
  })

  it('routes a real Telegram viewportChanged through the same path, both ways', () => {
    const rig = buildRig({ first: M0_DEVICE })
    rig.settle()
    const measures = rig.shell.measures
    rig.setView({ ...M0_DEVICE, cssH: 400 })
    rig.telegram.emit(false)
    expect(rig.shell.measures).toBe(measures)
    rig.telegram.emit(true)
    expect(rig.shell.measures).toBe(measures + 1)
    expect(rig.shell.camera.cssH).toBe(400)
  })

  it('treats a payload with no isStateStable field as unstable', () => {
    const rig = buildRig({ first: M0_DEVICE })
    rig.settle()
    const measures = rig.shell.measures
    rig.setView({ ...M0_DEVICE, cssH: 400 })
    rig.telegram.emit(undefined)
    expect(rig.shell.measures).toBe(measures)
  })
})

describe('a degenerate viewport is refused after the first fit', () => {
  it('accepts the first fit unconditionally, because there has to be a camera', () => {
    const rig = buildRig({ first: { ...M0_DEVICE, cssH: 0 } })
    expect(rig.shell.camera.tileSize).toBe(1)
    expect(rig.builds).toEqual([2])
  })

  it('refuses a later degenerate measurement and keeps the last good camera', () => {
    const rig = buildRig({ first: M0_DEVICE })
    rig.settle()
    const rebuilds = rig.shell.rebuilds
    // A hidden webview, or a measurement taken mid-rotation.
    rig.setView({ ...M0_DEVICE, cssH: 0 })
    expect(rig.shell.viewportChanged(true)).toBe(SizingOutcome.SKIPPED_DEGENERATE)
    expect(rig.shell.rebuilds).toBe(rebuilds)
    expect(rig.shell.camera.tileSize).toBe(29)
    expect(rig.shell.camera.cssH).toBe(870)
    // and it recovers when the real viewport comes back.
    rig.setView(M0_DEVICE)
    expect(rig.shell.viewportChanged(true)).toBe(SizingOutcome.UNCHANGED)
  })

  it('gives every refusal its own code', () => {
    const codes = Object.values(SizingOutcome)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toBeGreaterThan(0)
  })
})
