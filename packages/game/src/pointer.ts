import {
  HitRegion,
  createGridHit,
  createHudRects,
  createOfferRects,
  hudRects,
  offerRects,
  screenToGrid,
} from '@laneways/render'
import type { Camera, Rect } from '@laneways/render'
import { OFFER_SLOT_A, OFFER_SLOT_B } from '@laneways/sim'
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
 * player has no way to reach erase mode at all. A fourth canvas rect would move
 * Task 5's "the three opaque fills tile the canvas" arithmetic, which is
 * asserted, so the surface belongs to Task 8.
 *
 * **It must be Telegram's `MainButton`, not a DOM button, and the arithmetic
 * says so.** `fitCamera` leaves **49 CSS px** of free strip on PHONE_390 and
 * **40** on the M0 reference device, both below a 44 px touch target — "outside
 * the canvas" is not a location on a phone. `MainButton` is native chrome: it
 * reserves its own space so it costs no canvas geometry, it is thumb-reachable
 * by construction, and it renders its own label and colour, which solves the
 * real hazard here — an erase mode you cannot see you are in. Task 8 owns the
 * wiring and must version-gate it like every other Telegram surface, with a
 * plain DOM fallback for development outside Telegram and for clients below the
 * gate.
 *
 * **The contract this module owes it** is three members and one guarantee:
 * `setEraseMode(boolean)` and `toggleEraseMode(): boolean` to drive it,
 * `eraseMode` to render its label and colour from, and — because `MainButton`
 * is native chrome that a second finger CAN reach mid-stroke, unlike the
 * canvas — the guarantee below.
 *
 * ---------------------------------------------------------------------------
 * A STROKE'S MODE IS LATCHED AT `pointerdown`
 * ---------------------------------------------------------------------------
 *
 * An earlier comment here claimed mid-stroke toggling was unreachable because
 * the toggle lived outside the canvas and pointer capture held the stroke. That
 * was true of a DOM button and is **false of `MainButton`**, which sits outside
 * the webview's content area entirely. So rather than leave the claim
 * contradicted by the control that ships:
 *
 *   - `move` uses `strokeErase`, latched from `erase` at `pointerdown`. A mode
 *     change during a stroke never splits it into half road and half erasure.
 *   - `setEraseMode`/`toggleEraseMode` still take effect immediately as the
 *     *pending* mode, so the button's own label stays truthful the instant it
 *     is pressed, and the new mode applies to the next stroke.
 *
 * Refusing the toggle outright would have been the other option and is worse:
 * the button would show one state while the module held another.
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
 * rewritten in place. **Only the `GridHit` half of that is pinned, and the other
 * half is unpinnable rather than merely untested** — a distinction worth the
 * sentence, because claiming both would be claiming coverage that does not
 * exist. Allocating a `GridHit` per event is caught by the harness (3/3 runs).
 * Allocating a `HudRects` per event is **not**, at 0.00 B/frame across 3/3 runs
 * of a driver that taps the HUD three times per stroke: `rects` is written by
 * `hudRects` and read by `inRect` entirely inside `down`, both of which inline,
 * so it never escapes and TurboFan scalar-replaces it — the exact trap
 * `test/allocation.test.ts`'s own module comment names. The construction-time
 * `createHudRects()` is therefore kept on the same principle as the `GridHit`
 * (and because a future caller that DID let it escape would allocate), not
 * because a test would notice its removal.
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
  /** A tap while the run is over; a new run was requested (§5.8, M1e Task 9). */
  RESTART_REQUESTED: 9,
  /** A card was taken off §5.10's offer modal; a `choose-card` is queued (M1f Task 8). */
  CARD_CHOSEN: 10,
  /** The peek control was used, in either direction. See `PointerInput.peeking`. */
  PEEK_TOGGLED: 11,
  /**
   * A tap the offer modal consumed and did nothing with — a miss, the HUD
   * clock, the board.
   *
   * **A code of its own rather than `REFUSED_PAUSED`, and the distinction is
   * load-bearing rather than tidy.** The modal always pauses, so both are true
   * at once in production; one code would make "the modal refused it"
   * unassertable and the branch ordering below unobservable, which is the
   * catalogue's most-repeated failure — a negative assertion satisfied by the
   * wrong mechanism.
   */
  REFUSED_OFFER_MODAL: 12,
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
  /**
   * True once the run has ended (§5.8). Read from the LOOP rather than from
   * `sim`, because `pointer` is in `game` and must not grow a `sim` import for
   * one boolean — and because the loop is already the authority on `paused`
   * for exactly the same reason.
   */
  readonly gameOver: () => boolean
  /**
   * Starts a new run. Injected, and `main.ts` passes
   * `() => { location.reload() }`.
   *
   * A seamless in-place restart needs a `resetState` in `sim` that M3 owns; a
   * reload is the one path in this codebase known to produce a correct boot,
   * and it is byte-identical to a cold start by construction rather than by
   * argument. It is a dependency rather than a direct `location.reload()` call
   * so that this branch has a Node-side detector — the same reason
   * `createFallbackButton` and `createBootFailureSurface` are injected.
   */
  readonly restart: () => void
  /**
   * Is §5.10's weekly card offer waiting to be taken? — M1f Task 8.
   *
   * **Read from `sim` through `main.ts`, not from the loop and not from a copy
   * here.** `main.ts` supplies `() => offerPending(state)`; `pointer.ts` must
   * not grow a `GameState` import for a boolean, for the same reason
   * `gameOver` above reads the loop instead of the sim.
   *
   * **It is not the same question as `paused()`.** The modal pauses, so both
   * hold together in production — but a HUD-clock tap pauses too, and a modal
   * branch keyed on `paused` would swallow every tap of an ordinary pause.
   */
  readonly offerPending: () => boolean
  /**
   * The card id in slot A, as the CLIENT currently sees it — `main.ts` supplies
   * `() => offerSlot(state, OFFER_SLOT_A)`, which is the same guard
   * `buildFrame` folds the modal's own face from.
   *
   * **This is the echo, and it must never be re-derived.** `applyChooseCard`
   * throws when the id the client sends disagrees with the id the simulation
   * offered, and that throw is the replay-divergence detector a verified
   * leaderboard rests on. So the tap sends back what this client was SHOWN.
   */
  readonly offerA: () => number
  /** The card id in slot B. See `offerA`. */
  readonly offerB: () => number
}

/** The pointer state machine. One per run; `main.ts` wires the DOM events to it. */
export interface PointerInput {
  readonly down: (pointerId: number, clientX: number, clientY: number) => PointerOutcomeCode
  readonly move: (pointerId: number, clientX: number, clientY: number) => PointerOutcomeCode
  readonly up: (pointerId: number) => PointerOutcomeCode
  /** `pointercancel`, and `lostpointercapture`. See the module comment. */
  readonly cancel: (pointerId: number) => PointerOutcomeCode
  /**
   * Erase mode — a MODE, set from outside. No gesture in this file changes it.
   * Takes effect immediately as the PENDING mode; a stroke already in progress
   * finishes in the mode it started in. See the module comment.
   */
  readonly setEraseMode: (erase: boolean) => void
  /** Flips the pending mode and returns the new value, for `MainButton` to render. */
  readonly toggleEraseMode: () => boolean
  /** The pending mode — what `MainButton`'s label and colour should show. */
  readonly eraseMode: boolean
  /**
   * The mode the stroke in progress is committing, latched at `pointerdown`.
   * Equal to `eraseMode` whenever no stroke is in progress. Exposed so the
   * latch is observable rather than an internal detail nothing can check.
   */
  readonly strokeEraseMode: boolean
  /**
   * Is the player holding §5.10's modal out of the way to look at the frozen
   * board underneath? (spec §5.10's peek, plan Decision 16.)
   *
   * **Peek is UI and not simulation**, so it lives here beside `eraseMode`
   * rather than in the state buffer: a cosmetic toggle in `GameState` would be
   * a replay input. `main.ts` hands this to the frame driver as
   * `peeking: () => pointer.peeking` and `buildFrame` folds it into
   * `RenderFrame.offerPeek`.
   *
   * **Reading it is also the poll that ends it** — see the getter.
   */
  readonly peeking: boolean
  /** True while a pointer owns the drag. */
  readonly dragging: boolean
  /** The owning `pointerId`, or -1 when no drag is active. */
  readonly activePointerId: number
  /** The cell the drag is currently standing on, or -1 when no drag is active. */
  readonly lastCell: number
  /**
   * Ends any drag in progress, unconditionally. The out-of-band recovery path,
   * and it has exactly ONE production caller: `attachVisibility` (`main.ts`)
   * calls it on a `visibilitychange` to hidden, where the webview may never
   * deliver the `pointerup`. **There is no Telegram `deactivated` handler
   * anywhere in `packages/`** — this comment named one for two milestones, and
   * `deactivated` now appears only in prose. Returns `DRAG_END` if a drag was
   * ended, `IGNORED` otherwise, and is idempotent.
   */
  readonly abort: () => PointerOutcomeCode
}

/**
 * The drag's three mutable numbers. Named slot indices into a typed array is
 * this codebase's own idiom (`H_TICK`, `H_SCORE`, ... in `sim/state.ts`;
 * `L_ACCUMULATOR` in `loop.ts`), and like those it never boxes.
 *
 * **`Float64Array`, not `Int32Array`, and that is a bug fix rather than a
 * preference.** An `Int32Array` COERCES on write: `slots[0] = 2 ** 31` stores
 * -2147483648, so a `pointerdown` carrying an id at or past 2^31 started a drag
 * that **no `move`, `up` or `cancel` could ever match** — the comparison in
 * `endDrag` and `move` fails forever, `dragging` stays true, and the
 * single-pointer rule then refuses every subsequent `pointerdown`. Input died
 * for the rest of the session, from one event.
 *
 * `PointerEvent.pointerId` is a WebIDL `long`, so a conforming browser cannot
 * produce that id — which is exactly why the first version reasoned it away
 * instead of testing it. A renderer must never be the thing that bricks the
 * game on an out-of-contract input, and a `Float64Array` is exact for every
 * value a `double` can hold, allocates nothing (measured 0.000 B/call over
 * 500,000 assignments), and removes the coercion entirely. The recovery path in
 * `down` below is the second half of the fix: even a latched drag now clears.
 */
const D_POINTER_ID = 0
const D_LAST_GX = 1
const D_LAST_GY = 2
const DRAG_SLOT_COUNT = 3

/**
 * No pointer owns the drag. Never compared against a real id without `dragging`
 * being checked first, so an exotic client that really did send `pointerId = -1`
 * would still work — `dragging` is the authority, this is a tidy-up value.
 */
const NO_POINTER = -1

function inRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
}

export function createPointerInput(host: PointerHost): PointerInput {
  const slots = new Float64Array(DRAG_SLOT_COUNT)
  slots[D_POINTER_ID] = NO_POINTER

  // Allocated once. `screenToGrid`, `hudRects` and `offerRects` all take a
  // caller-owned output and return it, precisely so a per-event caller cannot
  // allocate. `canvas.ts` holds its OWN `OfferRects` scratch — two callers, two
  // objects, one function, which is what stops the drawn faces and the tapped
  // targets drifting apart.
  const hit = createGridHit()
  const rects = createHudRects()
  const offer = createOfferRects()

  // Booleans are singletons and never box, so these stay as closure variables.
  let dragging = false
  /** The mode the NEXT stroke will use. Set from outside; never by a gesture. */
  let erase = false
  /** The mode the CURRENT stroke is using, latched at `pointerdown`. See below. */
  let strokeErase = false
  /**
   * Is §5.10's modal being held out of the way? See `PointerInput.peeking`, and
   * `peekActive` below for why it is never read raw.
   */
  let peek = false

  /**
   * Peek, **cleared by the act of reading it once the modal is gone.**
   *
   * Peek belongs to ONE modal. This module never sees a week resolve — the tick
   * does that, from an action this module queued — so there is no event to clear
   * the latch on, and the read is the only poll available. `main.ts` performs it
   * once per frame (`peeking: () => pointer.peeking`, folded into
   * `RenderFrame.offerPeek`), and there are 4,500 ticks between one week
   * boundary and the next, so the poll is not a hope.
   *
   * **What it prevents is the whole reason for the side effect**: a latched peek
   * would open NEXT week's modal already hidden. The player would be looking at
   * a frozen board with one TAP TO RETURN on it and nothing saying a choice was
   * waiting — which is exactly the state M1f Task 7 shipped on purpose and
   * interlocked against, reached this time by a control they used correctly a
   * week earlier.
   *
   * Both readers go through here — the getter and `down` — so there is one
   * accessor and not a raw latch with a rule about it.
   */
  function peekActive(): boolean {
    if (peek && !host.offerPending()) peek = false
    return peek
  }

  function chooseCard(slot: number, cardId: number): PointerOutcomeCode {
    // **The echo: the card id THIS CLIENT believes the slot holds**, read from
    // the same frame the player tapped. `applyChooseCard` throws on a mismatch
    // and that throw is the replay-divergence detector a verified leaderboard
    // rests on — so this passes on what it saw and never re-derives it.
    host.queue.enqueue('choose-card', slot, cardId)
    // **The resume, and it belongs here rather than in the tick**: the tick
    // that resolves the offer cannot run while the loop is paused, so a choice
    // that did not unpause would queue an action nothing would ever drain and
    // leave the board stopped for good.
    //
    // The one-or-two frame window in which the modal is still drawn after the
    // tap is harmless and is not worth a second flag: the first frame after any
    // resume runs zero ticks (`resetClock`), so `offerPending` is still true
    // when it draws. A second tap in that window enqueues a second
    // `choose-card` and `sim` no-ops it against `H_OFFER_WEEK === H_WEEK` —
    // which is `applyChooseCard`'s first check, written for exactly this.
    host.setPaused(false)
    return PointerOutcome.CARD_CHOSEN
  }

  function endDrag(pointerId: number): PointerOutcomeCode {
    if (!dragging || pointerId !== (slots[D_POINTER_ID] as number)) return PointerOutcome.IGNORED
    dragging = false
    slots[D_POINTER_ID] = NO_POINTER
    return PointerOutcome.DRAG_END
  }

  function down(pointerId: number, clientX: number, clientY: number): PointerOutcomeCode {
    // **§5.8's shutdown is terminal, and this is the only branch that says so.**
    //
    // ONE early return rather than a guard on the clock toggle plus a guard on
    // the grid: two guards can disagree, and the clock guard alone would still
    // leave `Game.setPaused` — exported, and forwarded from `main.ts` — able to
    // resume a dead sim from outside this module. `Loop.end()` closes that door
    // from the other side; this one closes the tap.
    //
    // **A terminal state obliges a recovery path, and the guard is what removes
    // the accidental one.** Before this branch a clock tap un-paused the loop
    // and re-opened `HitRegion.GRID` — refused *while paused* and by nothing
    // else — so the player drew roads that never appeared, spent no tiles and
    // got no message.
    //
    // **First statement, above the `dragging` block, deliberately.** A city can
    // die mid-stroke: the run ends inside `advance` while finger 1 still owns
    // the drag, and with this below the single-pointer rule finger 2's tap
    // would come back REFUSED_SECOND_POINTER in front of a screen reading "TAP
    // TO PLAY AGAIN".
    //
    // `move` needs no companion guard and must not grow one: `Loop.end()` sets
    // `paused`, `move` already refuses every board sample while paused, and a
    // second independently sufficient structure would leave neither half with a
    // detector. `up`/`cancel` stay live so a captured pointer can still be
    // released on a dead board.
    if (host.gameOver()) {
      host.restart()
      return PointerOutcome.RESTART_REQUESTED
    }

    // **§5.10's modal owns every tap while it is up, and it is ONE branch
    // rather than a guard on each of the paths below** — M1f Task 8.
    //
    // Two guards can disagree, and the HUD clock is the case that proves it: it
    // is a pause TOGGLE, so under a modal that offers no skip its own guard
    // going missing would clear `paused` from outside this decision entirely
    // and put the board back under a screen asking a question.
    //
    // **Below the game-over branch**, for the reason that branch is first: a
    // city that died with a modal up must still offer the restart, and only one
    // of the two screens has a way out of itself.
    //
    // **Above the `dragging` block**, so a modal raised mid-stroke does not
    // answer the next tap REFUSED_SECOND_POINTER in front of a screen asking
    // for a choice — which would leave the player unable to take either card
    // until they lifted a finger nothing had told them was still down.
    //
    // `move`, `up` and `cancel` need no companion guard and must not grow one:
    // the loop is paused whenever this holds (`main.ts`'s `onOfferRaised`),
    // `move` already refuses every board sample while paused, and `up`/`cancel`
    // must stay live so a captured pointer can still be released. A second
    // independently sufficient structure would leave neither half with a
    // detector.
    if (host.offerPending()) {
      // **The return from peek is FIRST, above the rect tests**, so a tap that
      // happens to land where a card was drawn returns to the modal instead of
      // spending the week on a card the player could not see.
      if (peekActive()) {
        peek = false
        return PointerOutcome.PEEK_TOGGLED
      }
      offerRects(host.camera(), offer)
      const cssX = clientX - host.canvasLeft()
      const cssY = clientY - host.canvasTop()
      if (inRect(offer.peek, cssX, cssY)) {
        // **No `setPaused` on this path, and that is plan Decision 16 rather
        // than an omission.** A peek that resumed the sim would be a free
        // unpause with no cost: hold it for the rest of the week and the offer
        // is gone. Peek inspects; it does not skip.
        peek = true
        return PointerOutcome.PEEK_TOGGLED
      }
      if (inRect(offer.cardA, cssX, cssY)) return chooseCard(OFFER_SLOT_A, host.offerA())
      if (inRect(offer.cardB, cssX, cssY)) return chooseCard(OFFER_SLOT_B, host.offerB())
      return PointerOutcome.REFUSED_OFFER_MODAL
    }

    if (dragging) {
      // The single-pointer rule: while a drag is live, a second finger cannot
      // start a second drag AND cannot reach the HUD.
      if (pointerId !== (slots[D_POINTER_ID] as number)) {
        return PointerOutcome.REFUSED_SECOND_POINTER
      }
      // **The recovery path.** A conforming browser cannot deliver two
      // `pointerdown`s for the same active `pointerId` without an intervening
      // `pointerup`/`pointercancel`, so receiving one means the end event was
      // LOST — a backgrounded webview, a dropped Telegram event, a capture that
      // went away without firing anything. Before this existed the drag was
      // latched and the rule above refused every future tap, including the
      // owner's, so the only recovery was reloading the Mini App. Ending the
      // stale drag and falling through to start a fresh one at the new cell is
      // what the player is asking for anyway.
      endDrag(pointerId)
    }

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
      // the board never sees them, and inert — but the two halves of that split
      // in M1e and only one is still open. There IS now something to SPEND:
      // §5.10's weekly grant lands `WEEKLY_TILE_GRANT` tiles at every week
      // boundary and the tiles readout is where the player watches it arrive.
      // There is still nothing to CHOOSE — the two-card modal and every item
      // card are M1f's — so tapping a readout still correctly does nothing.
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
      // Latched here, once. See `setEraseMode` for why a stroke does not change
      // mode half way through.
      strokeErase = erase
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
    // **THIS GUARD IS LIVE. Do not delete it — the state it refuses is reached
    // on the production boot path, and this comment claimed the opposite for
    // two milestones.**
    //
    // What it used to say, kept because the correction is the useful part:
    // *"Unreachable through the DOM today — pause can only be toggled by a
    // `pointerdown` on the clock, and the single-pointer rule refuses that
    // while a drag is live, so no drag can survive into a paused state"*, and
    // *"the real caller set of `setPaused` today is exactly two"*.
    //
    // **The reachable path, in the order it happens.** A drag is in progress.
    // A week boundary arrives from INSIDE a tick: `step` raises §5.10's offer,
    // `frame.ts`'s `advance` sees `offerPending` and calls `onOfferRaised`,
    // and `main.ts` answers it with `loop.setPaused(true)` — all while finger 1
    // still owns the drag and without any tap having happened at all. The next
    // `pointermove` lands here with `dragging === true` and `paused === true`.
    // Nothing about that needs a second finger, a hidden webview or M3.
    // Pinned by `test/pointer.test.ts` › *"refuses the drag that was in
    // progress when the boundary arrived"* and, on the real wiring, by
    // `test/integration.test.ts` › *"a week boundary that lands MID-DRAG"*.
    //
    // **The caller set is FOUR, not two** — the HUD clock tap 40 lines above,
    // `Loop.end()` on §5.8's shutdown, `main.ts`'s `onOfferRaised` (M1f Task 7)
    // and `chooseCard`'s `host.setPaused(false)` 160 lines ABOVE THIS COMMENT
    // (M1f Task 8) — plus `Game.setPaused`, which `main.ts` exports and nothing
    // in `packages/` calls.
    //
    // **What deleting it would cost, since "unreachable" invites exactly that.**
    // `down()` refuses to START a drag while the modal is up, but an existing
    // drag keeps receiving `move`. Without this line those samples enqueue
    // `place` actions that no tick drains — the loop is paused — and every one
    // of them lands in a burst on the tick after the player answers the modal:
    // road the player drew on a frozen board they could not see, appearing
    // somewhere else, later. `up`/`cancel` stay live regardless, so the stroke
    // can still be ended.
    //
    // **The rule was always the right justification and still is** — *"no board
    // input while paused", not "no board taps while paused"*: an exported pause
    // is reachable from outside this module by construction, and a guard that
    // depends on enumerating its callers is a guard with a shelf life. The
    // caller list was decoration that happened to be false, and then the
    // unreachability claim became false too.
    //
    // **Why it stayed wrong through the task that falsified it**, recorded
    // because it is the same failure twice: M1f Task 8 added the fourth caller
    // 160 lines above and swept only the files its diff touched, which cannot
    // find a claim written about you in a paragraph you did not edit. Grep for
    // the claim, not the file.
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

    // The STROKE's mode, latched at `pointerdown` — not the live one. See
    // `setEraseMode`.
    const kind: TickActionKind = strokeErase ? 'erase' : 'place'
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

    abort(): PointerOutcomeCode {
      if (!dragging) return PointerOutcome.IGNORED
      return endDrag(slots[D_POINTER_ID] as number)
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
    get strokeEraseMode(): boolean {
      return dragging ? strokeErase : erase
    },
    get peeking(): boolean {
      return peekActive()
    },
    get dragging(): boolean {
      return dragging
    },
    get activePointerId(): number {
      // -1 when idle, so the getter cannot be read as naming a live pointer.
      return dragging ? (slots[D_POINTER_ID] as number) : NO_POINTER
    },
    get lastCell(): number {
      if (!dragging) return -1
      return (slots[D_LAST_GY] as number) * host.gridW + (slots[D_LAST_GX] as number)
    },
  }
}
