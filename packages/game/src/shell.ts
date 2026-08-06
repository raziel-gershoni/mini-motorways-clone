import { fitCamera } from '@laneways/render'
import type { Camera, RevealedRect, ViewportMetrics } from '@laneways/render'
import { devicePerformanceClass } from './deviceInfo'
import { boot, bottomInset, onViewportChanged, stableHeight, topInset } from './telegram'

/**
 * The shell: boot, measure, size the canvas, and decide when the atlas has to be
 * rebuilt. Plan Task 8.
 *
 * ---------------------------------------------------------------------------
 * SIZING IS TWO PASSES, AND THE SECOND IS MEASURED BEHAVIOUR
 * ---------------------------------------------------------------------------
 *
 * `boot()` ends with `requestFullscreen()`, and **the client has not published
 * the real safe-area inset by the time it returns**. `spike/src/main.ts` sets a
 * placeholder height at module eval and re-reads `contentSafeAreaTop()` only
 * after three `requestAnimationFrame`s, with a comment saying exactly that. So
 * the first pass here is a **guess by construction**, not a precaution: size
 * provisionally so there is something on screen, then re-measure after the
 * transition settles, then keep measuring on **stable** viewport events.
 *
 * Never per frame, never on a raw `resize` event, and never against
 * `viewportHeight` (the transient one) — spec §8.3 and plan Decision 5.
 * `getBoundingClientRect` allocates a `DOMRect` per call, which is why the
 * canvas offset `pointer.ts` reads per event is cached here and refreshed only
 * when a resize is actually applied.
 *
 * ---------------------------------------------------------------------------
 * THE REBUILD IS DRIVEN BY THE TILE'S **DEVICE** SIZE, AND THE GUARD IS A COUNT
 * ---------------------------------------------------------------------------
 *
 * `buildAtlas` rasterises 256 tiles onto one surface — 928x928 device px at M2's
 * regime. Driving that off "a viewport event happened" is a rebuild storm on
 * every rotation and every keyboard, and **"rebuilding at the same size is
 * idempotent" is not the guard**: a storm is idempotent too. So the trigger is
 * `floor(tileSize * dpr)` **changing**, and `rebuilds` is a public count so the
 * tests assert a number rather than a property.
 *
 * `floor`, matching `atlas.ts`'s documented contract, because plan Decision 6's
 * LOW-class cap of 1.5 makes `29 * 1.5 = 43.5` and `buildAtlas` throws on a
 * fractional tile.
 *
 * Keying on the DEVICE size rather than the CSS one is load-bearing: a
 * `performanceClass` that resolves late, or a client that changes DPR on a
 * display change, moves the device tile from 58 to 43 with the CSS tile
 * unchanged at 29 — and every blit would then read the wrong source rect.
 *
 * ---------------------------------------------------------------------------
 * THE CANVAS CONTRACT: `round(cssW * dpr) x round(cssH * dpr)`
 * ---------------------------------------------------------------------------
 *
 * The same rounding Task 5 snaps its three band edges with. `canvas.ts` says so
 * at the top of `drawFrame`: *"Task 8 MUST size the canvas with the same
 * rounding, or the last device row/column is outside every band"* — and outside
 * every band means holding the previous frame forever, because Decision 4
 * removed the `clearRect`.
 *
 * **And the transform is re-applied after every resize, not once at boot.**
 * Assigning `canvas.width` resets the 2D context state, transform included. A
 * scale applied once and then lost on the first rotation draws the whole board
 * into the top-left quarter of the canvas at DPR 2 — a defect that only appears
 * after an orientation change, which no boot-time check would see.
 */

/**
 * What one measurement did, **and when it declined, why**.
 *
 * Five outcomes is well past the point where a `boolean` or a bare `void` is
 * honest — the catalogue's rule, and `PointerOutcome`'s eight-valued enum is the
 * house pattern for it. The distinction is what lets `test/shell.test.ts` assert
 * that a rebuild did not happen *for the stated reason* rather than that
 * something, somewhere, stopped it.
 *
 * Every code is **non-zero**, in `HitRegion`'s idiom.
 */
export const SizingOutcome = Object.freeze({
  /** Measured, applied, and the tile's device size moved — the atlas was rebuilt. */
  REBUILT: 1,
  /** Measured and applied; the tile's device size did not move, so no rebuild. */
  RESIZED: 2,
  /** Measured; nothing changed, so the canvas was not touched at all. */
  UNCHANGED: 3,
  /** A `viewportChanged` with `isStateStable !== true`. Not measured. */
  SKIPPED_UNSTABLE: 4,
  /** Measured a viewport `fitCamera` had to clamp. The last good camera is kept. */
  SKIPPED_DEGENERATE: 5,
} as const)

/** A `SizingOutcome` value, derived from the const rather than written out. */
export type SizingOutcomeCode = (typeof SizingOutcome)[keyof typeof SizingOutcome]

/**
 * The slice of `HTMLCanvasElement` the shell writes. A real canvas satisfies it
 * structurally — pinned at the bottom of this file.
 */
export interface SizableCanvas {
  /** The backing store width in DEVICE px. Assigning it resets the 2D context. */
  width: number
  height: number
  /** The CSS box. Strings, because these are CSS declarations. */
  readonly style: { width: string; height: string }
  getBoundingClientRect(): { left: number; top: number }
}

/** The slice of `CanvasRenderingContext2D` the shell writes: the DPR scale. */
export interface ScalableContext {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
}

/**
 * How many animation frames to wait before the second measurement.
 *
 * Three is the spike's number, arrived at empirically on real hardware: at that
 * point `requestFullscreen()` had been called long enough ago for the client to
 * have published the real inset. It is a timing heuristic and it is honest to
 * call it one — the strictly better mechanism is Bot API 8.0's
 * `contentSafeAreaChanged` event, which M2b should take once there is a device
 * to check it on. The `viewportChanged` subscription below already covers the
 * case where the inset arrives even later.
 */
export const SETTLE_FRAMES = 3

/** Runs `body` after `SETTLE_FRAMES` animation frames. See `SETTLE_FRAMES`. */
export function rafSettle(body: () => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame
  if (typeof raf !== 'function') {
    // No rAF at all — Node, or a webview that has not started painting. Running
    // the body now is strictly better than never running it: the worst case is
    // a second measurement identical to the first, which costs nothing.
    body()
    return
  }
  let left = SETTLE_FRAMES
  const tick = (): void => {
    left--
    if (left <= 0) body()
    else raf(tick)
  }
  raf(tick)
}

/**
 * The production measurement.
 *
 * **Both inset systems, per spec §8.3** — `topInset()` is the max of
 * `contentSafeAreaInset.top` and `safeAreaInset.top`; see `telegram.ts` for why
 * neither contains the other.
 *
 * `stableHeight()` rather than `innerHeight`, because `innerHeight` is the
 * transient height during a Telegram transition and fitting against it produces
 * a camera that is wrong for exactly as long as anyone is looking at it.
 *
 * The `rawDpr` fallback is 1 rather than 0: a DPR of 0 makes the backing store
 * 0x0, which is a silently invisible game.
 */
export function measureViewport(): ViewportMetrics {
  const w = (globalThis as { innerWidth?: number }).innerWidth
  const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio
  return {
    cssW: typeof w === 'number' && w > 0 ? w : 0,
    cssH: stableHeight(),
    topInset: topInset(),
    bottomInset: bottomInset(),
    rawDpr: typeof dpr === 'number' && dpr > 0 ? dpr : 1,
    performanceClass: devicePerformanceClass(),
  }
}

export interface ShellDeps {
  readonly canvas: SizableCanvas
  readonly context: ScalableContext
  /** The revealed rect to fit. M2 freezes it in `shared`; M1d makes it dynamic. */
  readonly reveal: RevealedRect
  /** Injected so the whole shell is testable with no DOM. Production: `measureViewport`. */
  readonly measure: () => ViewportMetrics
  /** Called at boot and whenever `floor(tileSize * dpr)` changes, and never otherwise. */
  readonly rebuildAtlas: (tileDevicePx: number) => void
  /** Schedules the second pass. Production: `rafSettle`. */
  readonly settle: (run: () => void) => void
}

export interface Shell {
  /** The live camera. `main.ts` hands `() => shell.camera` to the frame driver and the pointer. */
  readonly camera: Camera
  /** Device px per tile the atlas is currently built for. */
  readonly tileDevicePx: number
  /** How many times `rebuildAtlas` has been called, boot included. A count, not a flag. */
  readonly rebuilds: number
  /** How many measurements have been taken. */
  readonly measures: number
  /** The canvas's cached `getBoundingClientRect().left`, for `pointer.ts`. */
  readonly canvasLeft: number
  readonly canvasTop: number
  /** Whether the `viewportChanged` subscription was actually installed. */
  readonly subscribed: boolean
  /** Measure and apply now. The second pass and every viewport event go through it. */
  readonly resize: () => SizingOutcomeCode
  /**
   * A `viewportChanged` event. Exposed so `main.ts` can route another source at
   * it (an orientation change, M2b's zoom control) and so a test can drive both
   * branches without the Telegram stub.
   */
  readonly viewportChanged: (isStateStable: boolean) => SizingOutcomeCode
}

/**
 * `fitCamera` clamps `tileSize` to at least 1 rather than throwing, precisely so
 * a transiently zero-height viewport does not kill the game. A tile of exactly 1
 * CSS px is therefore that clamp's **signature**: no real viewport produces it
 * (the M0 device gives 29, a 320 px phone gives 22).
 *
 * Reading the clamp is deliberate, and the alternative was worse: re-deriving
 * `availableH = cssH - topInset - HUD_BAND_CSS - bottomInset` here would put a
 * second copy of the fit arithmetic in `game`, which is the exact thing
 * `pointer.ts`'s module comment forbids and `screenToGrid` exists to prevent.
 */
const DEGENERATE_TILE_CSS = 1

export function bootShell(deps: ShellDeps): Shell {
  // Spec §8.2, and nothing may size a canvas before it returns.
  boot()

  let camera: Camera = fitCamera(deps.measure(), deps.reveal)
  let tileDevicePx = -1
  let rebuilds = 0
  let measures = 1
  let canvasLeft = 0
  let canvasTop = 0

  function applySize(): void {
    const dpr = camera.dpr
    // The same rounding Task 5 snaps the three band edges with. See the module
    // comment; `canvas.ts` names this file in its own.
    deps.canvas.width = Math.round(camera.cssW * dpr)
    deps.canvas.height = Math.round(camera.cssH * dpr)
    deps.canvas.style.width = `${camera.cssW}px`
    deps.canvas.style.height = `${camera.cssH}px`
    // AFTER the two assignments above, every time: they reset the context.
    deps.context.setTransform(dpr, 0, 0, dpr, 0, 0)
    const rect = deps.canvas.getBoundingClientRect()
    canvasLeft = rect.left
    canvasTop = rect.top
  }

  function syncAtlas(): boolean {
    const next = Math.floor(camera.tileSize * camera.dpr)
    if (next === tileDevicePx) return false
    tileDevicePx = next
    rebuilds++
    deps.rebuildAtlas(next)
    return true
  }

  function sameGeometry(a: Camera, b: Camera): boolean {
    return (
      a.cssW === b.cssW &&
      a.cssH === b.cssH &&
      a.dpr === b.dpr &&
      a.tileSize === b.tileSize &&
      a.originX === b.originX &&
      a.originY === b.originY &&
      a.hudTop === b.hudTop
    )
  }

  // The first fit is applied unconditionally, degenerate or not: there has to be
  // a camera before anything can draw, and refusing here would leave `camera`
  // undefined for every consumer. Every LATER measurement is guarded — see
  // `DEGENERATE_TILE_CSS`.
  applySize()
  syncAtlas()

  function resize(): SizingOutcomeCode {
    measures++
    const next = fitCamera(deps.measure(), deps.reveal)
    if (next.tileSize <= DEGENERATE_TILE_CSS) return SizingOutcome.SKIPPED_DEGENERATE
    if (sameGeometry(next, camera)) {
      // Not merely "no rebuild": the canvas is not touched at all. Assigning
      // `canvas.width` clears the whole backing store, and with no `clearRect`
      // anywhere in the draw path that is a full-canvas cost for an event that
      // changed nothing.
      camera = next
      return SizingOutcome.UNCHANGED
    }
    camera = next
    applySize()
    return syncAtlas() ? SizingOutcome.REBUILT : SizingOutcome.RESIZED
  }

  function viewportChanged(isStateStable: boolean): SizingOutcomeCode {
    // An unstable event is a transition frame, not a measurement. Measuring here
    // fits against a mid-animation rectangle and — because the tile size moves
    // with it — rebuilds the atlas once per frame of the animation.
    if (!isStateStable) return SizingOutcome.SKIPPED_UNSTABLE
    return resize()
  }

  // Pass 2. See the module comment: the first pass is a guess by construction.
  deps.settle(() => {
    resize()
  })

  const subscribed = onViewportChanged(viewportChanged)

  return {
    resize,
    viewportChanged,
    subscribed,
    get camera(): Camera {
      return camera
    },
    get tileDevicePx(): number {
      return tileDevicePx
    },
    get rebuilds(): number {
      return rebuilds
    },
    get measures(): number {
      return measures
    },
    get canvasLeft(): number {
      return canvasLeft
    },
    get canvasTop(): number {
      return canvasTop
    },
  }
}

/**
 * Compile-time pins for the production wiring in `main.ts` (Task 9), in the
 * idiom `atlas.ts` uses for its surface factory: a real canvas is a
 * `SizableCanvas` and a real 2D context is a `ScalableContext`.
 *
 * The `Assert<T extends true>` wrapper is load-bearing — `type X = A extends B ?
 * true : never` pins nothing, because `never` is a perfectly good type.
 */
type Assert<T extends true> = T
export type _RealCanvasIsSizable = Assert<HTMLCanvasElement extends SizableCanvas ? true : false>
export type _RealContextIsScalable = Assert<
  CanvasRenderingContext2D extends ScalableContext ? true : false
>
