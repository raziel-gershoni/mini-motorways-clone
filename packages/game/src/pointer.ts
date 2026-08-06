import { HitRegion, createGridHit, createHudRects, hudRects, screenToGrid } from '@laneways/render'
import type { Camera, Rect } from '@laneways/render'
import type { TickActionKind } from '@laneways/sim'
import type { InputQueue } from './inputs'

/**
 * Pointer events -> board cells -> pooled `TickAction`s. Plan Task 7.
 *
 * ---------------------------------------------------------------------------
 * THE TRANSFORM IS NOT REIMPLEMENTED HERE, AND THAT IS ENFORCED
 * ---------------------------------------------------------------------------
 *
 * Every screen-to-board conversion in this file goes through `render`'s
 * `screenToGrid`, which plan Decision 5 makes the exact inverse of
 * `gridToScreen` and which Task 3 fuzzed across 20,301 viewports. **There is no
 * arithmetic on `tileSize`, `originX`, `originY`, `x0` or `y0` anywhere below**
 * — `test/pointer.test.ts` reads this file off disk and asserts that, in the
 * idiom `sim/test/loop.test.ts` already uses to pin the goldens, because a
 * second copy of a transform is exactly the shape that forced a cross-package
 * equality test in Task 4.
 *
 * `screenToGrid` **classifies as well as inverts**: a point in the letterbox or
 * the HUD band comes back as `LEFT`/`RIGHT`/`ABOVE`/`BELOW`/`HUD` rather than
 * clamped into the grid. That classification is the grid-bounds guard here —
 * this file never tests a cell index against the board.
 *
 * The one piece of shared arithmetic this file does repeat is the two
 * subtractions that turn a client point into a canvas-relative CSS point, and
 * it repeats them only for the HUD rect test, which `screenToGrid` cannot do
 * (it knows the band, not the three rects inside it). It is two subtractions,
 * not an inverse, and `test/pointer.test.ts` pins the agreement between the two
 * at the band boundary rather than trusting it.
 *
 * ---------------------------------------------------------------------------
 * THE HIT-TEST ORDER IS A DECISION: HUD, THEN THE GRID RECT, THEN NOTHING
 * ---------------------------------------------------------------------------
 *
 * The HUD is drawn on the same canvas, and without an ordering a tap on pause
 * also lays a road. `fitCamera` subtracts `HUD_BAND_CSS` before fitting, so on
 * every real viewport the two regions do not overlap and the ordering is inert
 * — but the *reason* they do not overlap lives in `fitCamera`, and a change
 * there must not silently make the board eat pause taps.
 *
 * **Where the ordering actually lives, stated precisely so nobody mistakes the
 * two `if`s below for it.** `screenToGrid` returns ONE region code, so `HUD`
 * and `GRID` are mutually exclusive by the time this file sees them and
 * swapping the two branches below is a CHECKED 0-detector no-op. The real
 * ordering is `screenToGrid`'s own: it tests the HUD band *before* the
 * grid-bottom check, so on a camera where the band overlaps the grid rect the
 * overlap classifies as HUD. `test/pointer.test.ts` asserts that with a
 * hand-built overlapping camera — a cross-package assertion, placed in `game`
 * because `game` is the only package that sees both sides.
 *
 * ---------------------------------------------------------------------------
 * ERASE IS A MODE TOGGLE. NEVER A TAP, NEVER A LONG-PRESS
 * ---------------------------------------------------------------------------
 *
 * Spec §7.3, and the most important mobile lesson available: the original ships
 * a draw-mode toggle specifically because it is otherwise easy to delete roads
 * while trying to move the camera. So the mode is a flag set from outside
 * (`setEraseMode`/`toggleEraseMode`) and no gesture in this file can enter or
 * leave it.
 *
 * **The affordance does not exist yet, and that is a gap in the plan rather
 * than an oversight here.** `hudRects` lays out exactly three elements — clock,
 * score, tiles — and none of them is a mode toggle, so in M2 as planned a
 * player has no way to reach erase mode at all. Adding a fourth canvas rect
 * would move Task 5's "the three opaque fills tile the canvas" arithmetic, so
 * the cheap fix belongs to Task 8/9: a DOM button in `index.html`, outside the
 * canvas (`touch-action: none` is on the canvas only), wired to
 * `toggleEraseMode`. Recorded at the API rather than discovered on a phone.
 *
 * ---------------------------------------------------------------------------
 * THE DRAG WALKS CELLS, NOT SAMPLES
 * ---------------------------------------------------------------------------
 *
 * `canPlaceRoad` returns `not-adjacent` whenever `dirBetween(a, b, w, h) === -1`
 * — any pair more than one cell apart on either axis — and `step` ignores the
 * return value. At 27-29 CSS px tiles a finger at ordinary speed crosses several
 * tiles between `pointermove` samples, so emitting one action per sample draws a
 * road with holes that appears only when the player draws fast: the core
 * mechanic degrading exactly when it matters, silently.
 *
 * So a move emits **one action per cell entered**, along an 8-connected walk
 * that steps by `sign(dx)`, `sign(dy)` toward the target until it arrives. Every
 * emitted pair is 8-adjacent by construction, the walk is exactly
 * `max(|dx|, |dy|)` cells long (the Chebyshev distance), and it stays inside the
 * bounding box of its two endpoints — which, since both endpoints are inside the
 * revealed rect and a rect is convex, keeps every walked cell inside it too.
 *
 * ---------------------------------------------------------------------------
 * PLATFORM BEHAVIOURS
 * ---------------------------------------------------------------------------
 *
 * - **`pointercancel` ends the drag.** Telegram's swipe, an incoming call or a
 *   system gesture fires cancel rather than up, and a state machine with no
 *   cancel branch latches: it keeps laying road from an abandoned cell on the
 *   next `pointermove`. `cancel` and `up` are behaviourally identical in M2 (a
 *   CHECKED equivalence — replacing one with the other changes nothing) and are
 *   kept as two entry points because `main.ts` wires them to two different DOM
 *   events, and because a later milestone may want cancel to undo the stroke.
 *   `main.ts` should also wire `lostpointercapture` to `cancel`.
 * - **One pointer owns the drag.** The first `pointerdown` takes it and every
 *   other `pointerId` is ignored until it ends — including on the HUD, so a
 *   second finger cannot pause mid-stroke. Pan/zoom is deferred to M2b, and a
 *   naive per-pointer handler opens a second concurrent drag.
 * - **`touch-action: none` and pointer capture live on the canvas** (Task 8 owns
 *   the CSS; `DRAG_START` is the signal for `setPointerCapture`). On a Telegram
 *   client below 7.7 `disableVerticalSwipes()` is a silent no-op and
 *   swipe-to-close stays live, so a downward drawing drag can dismiss the Mini
 *   App mid-stroke. Spec §8.3 forbids the legacy workarounds (fixed body,
 *   blanket `preventDefault` on `touchmove`), so on a 7.6 client the canvas
 *   `touch-action` is the whole of the mitigation. Stated, not left as a
 *   surprise.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE ALLOCATES
 * ---------------------------------------------------------------------------
 *
 * Pointer events arrive asynchronously and their actions reach `step` through
 * Decision 9's pool. `test/allocation.test.ts` profiles 3,000 frames with a live
 * drag through these handlers — ~9,000 enqueued actions — and holds this file
 * and `inputs.ts` to the same budget every other `game/src` file gets.
 *
 * The `GridHit` and the `HudRects` are allocated once, at construction, and
 * rewritten in place. That one IS load-bearing: allocating a `GridHit` per event
 * is measurable and the harness catches it.
 *
 * **The `Int32Array` for the drag's three mutable numbers is NOT, and saying so
 * is the point.** It reads like `loop.ts`'s `Float64Array`, which exists because
 * a mutable double in a closure context slot boxes a `HeapNumber` on every
 * assignment — measured at ~65 B/frame there. Here the values are `pointerId`,
 * `gx` and `gy`, and all three are **Smis**: `PointerEvent.pointerId` is a
 * WebIDL `long`, i.e. int32 by definition, and a board coordinate is under 40.
 * Measured over 500,000 assignments per shape: `Int32Array` 0.000 B/call, a
 * plain object 0.000, closure `let`s 0.004 — and 32.0 for both non-typed shapes
 * once the value leaves Smi range, which a `long` cannot. So the typed array is
 * chosen for the int32 domain it states and for consistency with `loop.ts` and
 * `sim/state.ts`'s slot idiom, **not** because it saves an allocation. Swapping
 * it for closure variables is an equivalent mutant, deliberately unpinned; do
 * not add a test that pretends otherwise.
 */

/**
 * What a handler did. Every code is **non-zero**, in `HitRegion`'s idiom, so a
 * caller writing `if (outcome)` cannot accidentally treat one outcome as false.
 *
 * The refusals are separate codes rather than one `IGNORED` because the
 * negative assertions in `test/pointer.test.ts` need to distinguish them: "no
 * action was queued" is satisfied by a tap that missed, by a paused game, by a
 * second pointer and by a drag that already ended, and a test that cannot tell
 * those apart proves that *something* stopped the action rather than that the
 * guard under test did.
 *
 * `main.ts` consumes exactly two of them: `DRAG_START` (call
 * `setPointerCapture`) and `DRAG_END` (call `releasePointerCapture`).
 */
export const PointerOutcome = Object.freeze({
  /** Nothing under the point, or the event was not ours. */
  IGNORED: 1,
  /** A drag started. `main.ts` calls `setPointerCapture` on this. */
  DRAG_START: 2,
  /** One or more road actions were queued. */
  DRAW: 3,
  /** The drag ended, by `up` or by `cancel`. */
  DRAG_END: 4,
  /** The HUD clock was tapped; pause toggled. */
  PAUSE_TOGGLED: 5,
  /** The HUD band was tapped somewhere that is not interactive in M2. */
  HUD_INERT: 6,
  /** A board event refused because the game is paused (plan's deferred table). */
  REFUSED_PAUSED: 7,
  /** A `pointerdown` refused because another pointer already owns the drag. */
  REFUSED_SECOND_POINTER: 8,
} as const)

/** A `PointerOutcome` value, derived from the const rather than hand-written. */
export type PointerOutcomeCode = (typeof PointerOutcome)[keyof typeof PointerOutcome]

/**
 * Everything the pointer handlers read from the rest of the game. Held by
 * reference; nothing is copied per event.
 */
export interface PointerHost {
  /**
   * The current camera. A function rather than a value because `fitCamera` is
   * re-run on a stable viewport change (Decision 5) and the hit-test must pick
   * the new one up without the handlers being rebuilt. Same idiom as
   * `FrameDriverDeps.camera`.
   */
  readonly camera: () => Camera
  /**
   * The canvas's `getBoundingClientRect().left`, **measured once and cached**.
   * A function for the same reason as `camera`: it changes on a viewport event
   * and the call allocates a `DOMRect`, so it must never happen per event.
   */
  readonly canvasLeft: () => number
  /** The canvas's cached `getBoundingClientRect().top`. */
  readonly canvasTop: () => number
  /** Board width, for `index = y * gridW + x`. Fixed for the life of a run. */
  readonly gridW: number
  /** Where board actions go — Decision 9's pool. */
  readonly queue: InputQueue
  /**
   * The loop's pause flag. **The loop owns it, not this module**: resuming has
   * to reset the loop's clock reference (Decision 1b), so a second copy of the
   * flag here would let the two disagree.
   */
  readonly paused: () => boolean
  readonly setPaused: (paused: boolean) => void
}

/** The pointer state machine. One per run; `main.ts` wires the DOM events to it. */
export interface PointerInput {
  readonly down: (pointerId: number, clientX: number, clientY: number) => PointerOutcomeCode
  readonly move: (pointerId: number, clientX: number, clientY: number) => PointerOutcomeCode
  readonly up: (pointerId: number) => PointerOutcomeCode
  /** `pointercancel`, and `lostpointercapture`. See the module comment. */
  readonly cancel: (pointerId: number) => PointerOutcomeCode
  /** Erase mode — a MODE, set from outside. No gesture in this file changes it. */
  readonly setEraseMode: (erase: boolean) => void
  /** Flips the mode and returns the new value, for a UI toggle to render. */
  readonly toggleEraseMode: () => boolean
  readonly eraseMode: boolean
  /** True while a pointer owns the drag. */
  readonly dragging: boolean
  /** The owning `pointerId`, or -1 when no drag is active. */
  readonly activePointerId: number
  /** The cell the drag is currently standing on, or -1 when no drag is active. */
  readonly lastCell: number
}

/**
 * The drag's three mutable numbers, in an `Int32Array` rather than closure
 * `let`s — see the module comment's allocation note. Named slot indices into a
 * typed array is this codebase's own idiom for exactly this trade (`H_TICK`,
 * `H_SCORE`, ... in `sim/state.ts`; `L_ACCUMULATOR` in `loop.ts`).
 */
const D_POINTER_ID = 0
const D_LAST_GX = 1
const D_LAST_GY = 2
const DRAG_SLOT_COUNT = 3

/** No pointer owns the drag. Distinct from every real `pointerId`, which is >= 0. */
const NO_POINTER = -1

function inRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
}

export function createPointerInput(host: PointerHost): PointerInput {
  const slots = new Int32Array(DRAG_SLOT_COUNT)
  slots[D_POINTER_ID] = NO_POINTER

  // Allocated once. `screenToGrid` and `hudRects` both take a caller-owned
  // output and return it, precisely so a per-event caller cannot allocate.
  const hit = createGridHit()
  const rects = createHudRects()

  // Booleans are singletons and never box, so these stay as closure variables.
  let dragging = false
  let erase = false

  function endDrag(pointerId: number): PointerOutcomeCode {
    if (!dragging || pointerId !== (slots[D_POINTER_ID] as number)) return PointerOutcome.IGNORED
    dragging = false
    slots[D_POINTER_ID] = NO_POINTER
    return PointerOutcome.DRAG_END
  }

  function down(pointerId: number, clientX: number, clientY: number): PointerOutcomeCode {
    // The single-pointer rule, ahead of everything: while a drag is live, a
    // second finger cannot start a second drag AND cannot reach the HUD.
    if (dragging) return PointerOutcome.REFUSED_SECOND_POINTER

    const camera = host.camera()
    const left = host.canvasLeft()
    const top = host.canvasTop()
    screenToGrid(camera, clientX, clientY, left, top, hit)

    // --- 1. the HUD ---
    if (hit.region === HitRegion.HUD) {
      hudRects(camera, rects)
      const cssX = clientX - left
      const cssY = clientY - top
      if (inRect(rects.clock, cssX, cssY)) {
        host.setPaused(!host.paused())
        return PointerOutcome.PAUSE_TOGGLED
      }
      // The score and tiles readouts, and the band's own padding. Consumed, so
      // the board never sees them, and inert: there is nothing to spend or
      // choose until M1e.
      return PointerOutcome.HUD_INERT
    }

    // --- 2. the grid rect ---
    if (hit.region === HitRegion.GRID) {
      // Drawing while paused is deferred to M2b: roads live in sim state, which
      // pause freezes, so the player would draw twenty segments and see
      // nothing. M2 therefore REJECTS board input while paused, as a rule
      // rather than an accident.
      if (host.paused()) return PointerOutcome.REFUSED_PAUSED
      dragging = true
      slots[D_POINTER_ID] = pointerId
      slots[D_LAST_GX] = hit.gx
      slots[D_LAST_GY] = hit.gy
      // No action: one cell is not a segment. `placeRoad` takes a PAIR, so the
      // first action is emitted when the drag enters its second cell.
      return PointerOutcome.DRAG_START
    }

    // --- 3. nothing ---
    // The letterbox and the top band. Spec §8.3 forbids any interactive element
    // in the top band, so `ABOVE` is dropped rather than routed anywhere.
    return PointerOutcome.IGNORED
  }

  function move(pointerId: number, clientX: number, clientY: number): PointerOutcomeCode {
    if (!dragging || pointerId !== (slots[D_POINTER_ID] as number)) return PointerOutcome.IGNORED
    // Unreachable through the DOM today — pause can only be toggled by a
    // `pointerdown` on the clock, and the single-pointer rule refuses that
    // while a drag is live, so no drag can survive into a paused state. Kept
    // because `setPaused` is also callable from `main.ts` (a Telegram
    // `deactivated` event, M3's hard pause) and because the rule is "no board
    // input while paused", not "no board taps while paused".
    if (host.paused()) return PointerOutcome.REFUSED_PAUSED

    const camera = host.camera()
    screenToGrid(camera, clientX, clientY, host.canvasLeft(), host.canvasTop(), hit)
    // The grid-bounds guard, and the whole of it: a sample that left the grid
    // rect is dropped and the drag keeps its cell, so re-entering emits an
    // 8-connected walk from where the finger left rather than a jump.
    if (hit.region !== HitRegion.GRID) return PointerOutcome.IGNORED

    const targetX = hit.gx
    const targetY = hit.gy
    let gx = slots[D_LAST_GX] as number
    let gy = slots[D_LAST_GY] as number
    // Still on the same cell: a `pointermove` fires per pixel of travel, and at
    // 27 CSS px tiles most of them land on the cell the drag is already on.
    if (gx === targetX && gy === targetY) return PointerOutcome.IGNORED

    // Read once per move rather than once per drag: `main.ts`'s toggle lives
    // outside the canvas and pointer capture means it cannot be pressed
    // mid-stroke, so the two are equivalent today. Per-move is the form that
    // stays correct if a future UI makes it reachable.
    const kind: TickActionKind = erase ? 'erase' : 'place'
    const w = host.gridW
    const queue = host.queue

    // The 8-connected walk. `Math.sign` gives -1, 0 or +1 per axis, so each
    // step moves at most one cell on each axis and the loop runs exactly
    // `max(|dx|, |dy|)` times.
    while (gx !== targetX || gy !== targetY) {
      const from = gy * w + gx
      gx += Math.sign(targetX - gx)
      gy += Math.sign(targetY - gy)
      queue.enqueue(kind, from, gy * w + gx)
    }
    slots[D_LAST_GX] = gx
    slots[D_LAST_GY] = gy
    return PointerOutcome.DRAW
  }

  return {
    down,
    move,
    up: endDrag,
    // Its own entry point, not an alias of `up`: dropping the cancel branch is
    // a real defect (the drag latches and lays road from an abandoned cell on
    // the next move) and a mutation target needs somewhere to land.
    cancel(pointerId: number): PointerOutcomeCode {
      return endDrag(pointerId)
    },

    setEraseMode(next: boolean): void {
      erase = next
    },
    toggleEraseMode(): boolean {
      erase = !erase
      return erase
    },
    get eraseMode(): boolean {
      return erase
    },
    get dragging(): boolean {
      return dragging
    },
    get activePointerId(): number {
      return slots[D_POINTER_ID] as number
    },
    get lastCell(): number {
      if (!dragging) return -1
      return (slots[D_LAST_GY] as number) * host.gridW + (slots[D_LAST_GX] as number)
    },
  }
}
