import { MAIN_BUTTON_MIN_VERSION, atLeast, isTelegram, mainButton } from './telegram'
import type { PointerInput } from './pointer'

/**
 * The erase control — plan Task 8's inherited Critical, and the single thing
 * that makes M2 playable rather than merely visible.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Task 7 implemented `toggleEraseMode` correctly and made erase an orthogonal
 * mode flag that **no gesture can reach** — which is right, because spec §7.3
 * forbids erase-on-tap and erase-on-long-press, and the original ships a
 * draw-mode toggle for exactly that reason. But `hudRects` lays out exactly
 * three elements (clock, score, tiles), none of them a toggle, and spec §8.3
 * bars any interactive element from the top band. So up to this file the shipped
 * build could draw roads and never remove one.
 *
 * ---------------------------------------------------------------------------
 * WHY `MainButton` AND NOT A FOURTH HUD RECT OR A DOM STRIP
 * ---------------------------------------------------------------------------
 *
 * - **Not a fourth canvas rect.** That moves Task 5's "the three opaque fills
 *   tile the canvas" arithmetic, which is asserted in *device* space and was the
 *   source of a real ghosting seam at DPR 1.5.
 * - **Not a DOM strip below the canvas.** `fitCamera` leaves **49 CSS px** of
 *   free strip on a 390x844 viewport and **40** on the M0 reference device, both
 *   below a 44 px touch target. "Outside the canvas" is not a location on a
 *   phone.
 * - **`MainButton` is native chrome**: it reserves its own space, so it costs no
 *   canvas geometry at all; it is thumb-reachable by construction; and it
 *   renders its own label and colour, which is what solves the real hazard here.
 *   **An erase mode you cannot see you are in is worse than no erase mode**,
 *   because roads vanish under a drag the player thinks is drawing.
 *
 * ---------------------------------------------------------------------------
 * THE FALLBACK IS FOR DEVELOPMENT, AND IT IS BOUNDED
 * ---------------------------------------------------------------------------
 *
 * Outside Telegram — `pnpm dev` in a browser — there is no `MainButton` at all,
 * and a game with no erase control is not testable by the person building it. So
 * a plain DOM pill is created instead, and the same path serves a client below
 * the gate.
 *
 * It lands over the HUD band, which is unavoidable on a phone-sized viewport,
 * and it is placed so that what it lands on is the **tiles** readout — inert in
 * M2 — and never the **clock**, which is the pause control. That is derived
 * rather than eyeballed, and `test/eraseControl.test.ts` checks the derivation
 * across every viewport width from 240 to 600 CSS px.
 *
 * The element itself is **injected**, in plan Decision 8's idiom (the same
 * reason `buildAtlas` takes a surface factory): this workspace has no jsdom, so
 * an uninjected builder would be untestable here rather than merely awkward. The
 * production factory is three lines and lives in `main.ts` (Task 9), because
 * that is the only place a `document` reference belongs:
 *
 * ```ts
 * const createFallback: FallbackElementFactory = () => {
 *   const button = document.createElement('button')
 *   document.body.appendChild(button)
 *   return button
 * }
 * ```
 *
 * `_RealButtonIsAFallbackElement` at the bottom of this file is the compile-time
 * pin that the snippet type-checks.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE RUNS PER FRAME, AND IT IS STILL IN THE ALLOCATION HARNESS
 * ---------------------------------------------------------------------------
 *
 * A press is an event, not a frame. But every label and every style string in
 * this file is a **preallocated constant** rather than a template built per
 * render, and `test/allocation.test.ts` drives a press once per stroke inside the
 * profiled window so that claim is measured rather than asserted. The obvious
 * wrong version — `` `ERASE (${count})` `` or a style string composed per
 * render — shows up there.
 */

/**
 * Which surface the control bound to, **and when it could not, why**.
 *
 * Four ways to decline is past the point where one `null` is honest: the
 * catalogue's rule is that a function with more than two ways to refuse puts the
 * reason in its signature, and `PointerOutcome`'s eight-valued enum is the house
 * pattern for it. Here the distinction is operational — "no Telegram" is a
 * developer running `pnpm dev`, "below the gate" is a real user on an ancient
 * client, and "no MainButton" on a client that clears the gate is a WebView bug
 * worth reporting — and it is what lets the negative assertions in
 * `test/eraseControl.test.ts` name the mechanism that refused rather than
 * observing that *something* did.
 *
 * Every code is **non-zero**, in `HitRegion`'s and `PointerOutcome`'s idiom, so
 * `if (control.surface)` cannot read one of them as false.
 */
export const EraseControlSurface = Object.freeze({
  /** Telegram's native `MainButton`. The shipping path. */
  MAIN_BUTTON: 1,
  /** No `Telegram` object at all — a plain browser. The development path. */
  DOM_NO_TELEGRAM: 2,
  /** A Telegram client that reports below `MAIN_BUTTON_MIN_VERSION`. */
  DOM_BELOW_GATE: 3,
  /** The client clears the gate but exposes no usable `MainButton`. */
  DOM_NO_MAIN_BUTTON: 4,
  /** No native button and no fallback element either. The mode still toggles. */
  NONE: 5,
  /** The caller asked for the fallback even though a `MainButton` was available. */
  DOM_PREFERRED: 6,
} as const)

/** An `EraseControlSurface` value, derived from the const rather than written out. */
export type EraseControlSurfaceCode =
  (typeof EraseControlSurface)[keyof typeof EraseControlSurface]

// --- the two states, as constants ------------------------------------------
//
// **Deliberately NOT entries in `render`'s `Palette`.** Telegram rasterises the
// MainButton itself, outside the webview's content area — it is chrome, not
// canvas paint, and `drawFrame` will never read these. A `Palette` field would
// imply the opposite and would put two colours nothing draws with into an
// interface two packages import. The art pass owns the values; it does not own
// the rule that the two states differ in BOTH label and colour.

/** Draw mode. The board's road colour, so the button reads as part of the game. */
export const ERASE_OFF_BG = '#4a4a52'
export const ERASE_OFF_FG = '#f2ece1'
/** Erase mode. Loud, and the one thing on screen that says the next drag deletes. */
export const ERASE_ON_BG = '#953328'
export const ERASE_ON_FG = '#ffffff'

/**
 * The native button's labels. It is a full-width bar, so it has room to say what
 * a press will do rather than only what mode is current — which is the half of
 * "visible state" a colour alone cannot carry for a player who has just opened
 * the app.
 */
export const MAIN_BUTTON_LABEL_OFF = 'ERASE ROADS'
export const MAIN_BUTTON_LABEL_ON = 'ERASING - TAP TO DRAW'

/**
 * The fallback pill's labels: **shorter, and that is load-bearing rather than
 * cosmetic.** The pill is capped at `FALLBACK_MAX_WIDTH_CSS`, and that cap is
 * what the "never covers the clock" derivation rests on, so a label that would
 * overflow it either ellipsises (an unreadable control) or breaks the bound.
 */
export const FALLBACK_LABEL_OFF = 'ERASE'
export const FALLBACK_LABEL_ON = 'ERASING'

/** The pill's inset from the right edge, CSS px. */
export const FALLBACK_RIGHT_CSS = 8

/**
 * The pill's width cap, CSS px — the term in the derivation below.
 *
 * The clock rect's right edge is `HUD_PAD_CSS + floor((cssW - 2*HUD_PAD_CSS -
 * 2*HUD_GAP_CSS) / 3)`, i.e. about `cssW / 3 + 8`. The pill's left edge is at
 * worst `cssW - FALLBACK_RIGHT_CSS - FALLBACK_MAX_WIDTH_CSS`. The two separate
 * while `(2/3) * cssW > FALLBACK_MAX_WIDTH_CSS + FALLBACK_RIGHT_CSS + 8`, which
 * at 140 is **cssW > ~235** — below every viewport `fitCamera` is documented
 * for, the narrowest of which is 320. Also above 44, so it is a real touch
 * target.
 */
export const FALLBACK_MAX_WIDTH_CSS = 140

/**
 * The pill's style, one preallocated string per state.
 *
 * `env(safe-area-inset-bottom)` is why `index.html` carries
 * `viewport-fit=cover`: without it the pill sits under the home indicator on
 * every notched iPhone.
 */
function fallbackStyle(background: string, colour: string): string {
  return (
    'position:fixed;' +
    `right:${FALLBACK_RIGHT_CSS}px;` +
    `bottom:calc(${FALLBACK_RIGHT_CSS}px + env(safe-area-inset-bottom, 0px));` +
    `max-width:${FALLBACK_MAX_WIDTH_CSS}px;min-width:44px;min-height:44px;` +
    'padding:0 16px;border:0;border-radius:22px;z-index:10;' +
    'font:600 13px system-ui,-apple-system,sans-serif;letter-spacing:0.04em;' +
    'white-space:nowrap;overflow:hidden;touch-action:manipulation;cursor:pointer;' +
    `background:${background};color:${colour}`
  )
}

const FALLBACK_STYLE_OFF = fallbackStyle(ERASE_OFF_BG, ERASE_OFF_FG)
const FALLBACK_STYLE_ON = fallbackStyle(ERASE_ON_BG, ERASE_ON_FG)
/**
 * The retired pill (M1e Task 9). `display:none` rather than `visibility:hidden`
 * or an alpha: the element is `position: fixed` over the canvas, and anything
 * short of removing it from layout leaves a dead target a thumb can still find
 * on the shutdown screen.
 */
const FALLBACK_STYLE_HIDDEN = 'display:none'

/**
 * `MainButton.setParams`'s two argument objects, **preallocated**.
 *
 * A press is not a frame, so this is not the frame-loop rule — but the harness
 * profiles a press twice per stroke inside the profiled window, and an object
 * literal built per render measured above the sampling floor there. Two frozen
 * constants cost nothing and make the measured claim a real one instead of a
 * budget written to fit. `setParams` reads its argument synchronously, so
 * handing the same object twice is safe.
 */
const MAIN_BUTTON_PARAMS_OFF = Object.freeze({
  color: ERASE_OFF_BG,
  text_color: ERASE_OFF_FG,
  is_active: true,
  is_visible: true,
})
const MAIN_BUTTON_PARAMS_ON = Object.freeze({
  color: ERASE_ON_BG,
  text_color: ERASE_ON_FG,
  is_active: true,
  is_visible: true,
})

/**
 * The slice of `HTMLButtonElement` the fallback uses, and nothing more. A real
 * button satisfies it structurally — pinned at the bottom of this file.
 */
export interface FallbackElement {
  textContent: string | null
  setAttribute(name: string, value: string): void
  addEventListener(type: 'click', handler: () => void): void
}

/**
 * Creates the fallback element **and attaches it to the document**. Returning
 * `null` means "this environment has no DOM", which is a real answer rather than
 * an error: the control still toggles the mode, and `surface` says `NONE`.
 */
export type FallbackElementFactory = () => FallbackElement | null

/**
 * What the control drives. Exactly the two members `PointerInput` exposes for
 * it, so the control cannot reach into the drag state machine — and structural,
 * so a test can drive it with four lines instead of a whole pointer rig.
 */
export interface EraseControlHost {
  /** The PENDING mode — what the button's label and colour must show. */
  readonly eraseMode: boolean
  /** Flips the pending mode and returns the new value. */
  readonly toggleEraseMode: () => boolean
}

export interface EraseControlDeps {
  readonly host: EraseControlHost
  /**
   * **Required, and that is this milestone's Critical held shut by the type
   * system rather than by anyone remembering.**
   *
   * It was optional in the first version, which meant `createEraseControl({
   * host })` compiled, ran, reported `NONE`, and produced a build where **the
   * player can draw roads and never remove one** — the exact defect this file
   * exists to close, reopened by one omitted property in `main.ts`, a file this
   * task does not write. No compile error, no test failure, silent green.
   *
   * `NONE` is defensible as a **runtime** outcome: the factory may still return
   * `null`, and in Node it always does. It is not defensible as a **static**
   * one. Making this required costs a caller nothing and converts a silent
   * reopening into a compile error.
   */
  readonly createFallback: FallbackElementFactory
  /**
   * Bind the DOM fallback even on a client that offers a `MainButton`.
   *
   * **The escape hatch for Task 8's F5, and it exists because that finding has
   * no test behind it and cannot get one here.** `grep -rn "MainButton"
   * spike/src/` returns nothing: every other Telegram surface in `telegram.ts`
   * is a lift from code that ran on the M0 reference device, and `mainButton()`
   * is the one that has never been on a phone — while being the single control
   * that closes this milestone's Critical. Worse, the failure mode has no
   * recovery: when `mainButton()` returns non-null the fallback is never
   * created, and there is no way to rebind afterwards, so a client that passes
   * the shape check and then does not RENDER the button (Telegram's own
   * fullscreen, which `boot()` requests on every 8.0+ client, is the obvious
   * candidate) leaves erase unreachable on the **newest** clients.
   *
   * `main.ts` drives this from a `?fallback=1` query parameter, so the answer to
   * "the button is not there" is a URL rather than a redeploy. Optional, and
   * that is safe in a way `createFallback` was not: the default is the shipping
   * path, and omitting it degrades to today's behaviour rather than to `NONE`.
   */
  readonly preferFallback?: boolean
}

export interface EraseControl {
  /** Which surface bound, and if none, why. */
  readonly surface: EraseControlSurfaceCode
  /** The mode as last rendered. */
  readonly erase: boolean
  /** What the control is displaying right now — the visible half of the state. */
  readonly label: string
  /**
   * Toggles the mode and re-renders. The surface's own handler calls this; it is
   * public so `main.ts` can bind a keyboard shortcut and so a test can drive the
   * control without a surface.
   */
  readonly press: () => boolean
  /**
   * Re-renders from the host's current mode without changing it. For the case
   * where something other than a press moved the mode — `main.ts` restoring a
   * saved mode, or M3's hard pause forcing draw mode back on.
   */
  readonly sync: () => void
  /** How many times the surface has been written. A count, so "it re-rendered" is checkable. */
  readonly renders: number
  /**
   * Takes the control off the screen for good — §5.8's shutdown, M1e Task 9.
   *
   * **The scrim is drawn on the CANVAS and this control is not.** On Telegram it
   * is the native full-width `MainButton`, which sits outside the webview's
   * content area entirely; the DOM fallback is a `position: fixed` pill above
   * it. Nothing the renderer does can dim either. So without this, a player
   * whose city has just shut down sees a dimmed board reading TAP TO PLAY AGAIN
   * with an undimmed, full-width, brightly coloured button under it offering to
   * ERASE ROADS — an affordance for an action that no longer exists, in front of
   * one that does. The pause bars come down on a shutdown frame for exactly this
   * reason; this is the larger half of the same lesson.
   *
   * Idempotent, and **sticky**: `sync()` and `press()` cannot bring it back,
   * because the run cannot come back either. A new run is a fresh `createGame`.
   */
  readonly retire: () => void
  /** True once `retire()` has been called. */
  readonly retired: boolean
}

/**
 * Binds the erase mode to a control the player can actually reach.
 *
 * Never throws, on any client: a missing surface degrades to `NONE` and the mode
 * still toggles through `press()`, because a control that cannot render is not a
 * reason to break the game.
 */
/** See the call site: a factory that throws is treated as one that declined. */
function safeCreate(factory: FallbackElementFactory): FallbackElement | null {
  try {
    return factory() ?? null
  } catch {
    return null
  }
}

export function createEraseControl(deps: EraseControlDeps): EraseControl {
  const host = deps.host
  let label = MAIN_BUTTON_LABEL_OFF
  let renders = 0

  const mb = deps.preferFallback === true ? null : mainButton()
  const native = mb !== null

  let element: FallbackElement | null = null
  let surface: EraseControlSurfaceCode
  if (native) {
    surface = EraseControlSurface.MAIN_BUTTON
  } else {
    // **Guarded, because the doc comment on this function says it never throws
    // and an injected factory is somebody else's code.** Production's factory is
    // three DOM lines and will not throw; a future one that queries a container
    // or touches a shadow root might, and an exception escaping a constructor
    // here takes down boot for a control that is allowed to be absent. A
    // throwing factory is treated exactly as a declining one.
    element = safeCreate(deps.createFallback)
    if (element === null) {
      surface = EraseControlSurface.NONE
    } else if (deps.preferFallback === true) {
      surface = EraseControlSurface.DOM_PREFERRED
    } else if (!isTelegram()) {
      surface = EraseControlSurface.DOM_NO_TELEGRAM
    } else if (!atLeast(MAIN_BUTTON_MIN_VERSION)) {
      surface = EraseControlSurface.DOM_BELOW_GATE
    } else {
      surface = EraseControlSurface.DOM_NO_MAIN_BUTTON
    }
  }

  /** Sticky. Set only by `retire()`, never cleared — see `EraseControl.retire`. */
  let retired = false

  function render(erase: boolean): void {
    // The terminal guard, first and unconditional, in `Loop.setPaused`'s idiom:
    // refusing only the presses would leave `sync()` able to re-show a button
    // that must stay gone.
    if (retired) return
    renders++
    if (mb !== null) {
      label = erase ? MAIN_BUTTON_LABEL_ON : MAIN_BUTTON_LABEL_OFF
      // `setText` and `setParams` are both called, and both are in
      // `mainButton()`'s shape re-check for that reason. `setParams` alone
      // would work on a conforming client; on a partial one the text and the
      // colour can be published by different methods, and a button whose colour
      // says erase while its label says draw is worse than either.
      mb.setText?.(label)
      mb.setParams?.(erase ? MAIN_BUTTON_PARAMS_ON : MAIN_BUTTON_PARAMS_OFF)
      mb.show?.()
      return
    }
    if (element !== null) {
      label = erase ? FALLBACK_LABEL_ON : FALLBACK_LABEL_OFF
      element.textContent = label
      element.setAttribute('style', erase ? FALLBACK_STYLE_ON : FALLBACK_STYLE_OFF)
      // Read out as "Erase mode, on/off" rather than as a bare word.
      element.setAttribute('aria-pressed', erase ? 'true' : 'false')
      return
    }
    label = erase ? MAIN_BUTTON_LABEL_ON : MAIN_BUTTON_LABEL_OFF
  }

  function press(): boolean {
    const next = host.toggleEraseMode()
    render(next)
    return next
  }

  if (mb !== null) mb.onClick?.(press)
  else if (element !== null) element.addEventListener('click', press)

  // Rendered at construction, so the button is visible and truthful from boot
  // rather than from the first press.
  render(host.eraseMode)

  return {
    surface,
    press,
    sync(): void {
      render(host.eraseMode)
    },
    retire(): void {
      if (retired) return
      // Set BEFORE the surface calls, so a `hide()` that throws on a partial
      // client still leaves the control refusing every later render rather than
      // half-retired and re-showable.
      retired = true
      // `hide()` and not `setParams({ is_visible: false })`: the params object
      // is preallocated and frozen, and a second pair of them for one call is
      // two more constants to keep in sync with the colours.
      if (mb !== null) mb.hide?.()
      // The fallback is a DOM pill; `display:none` is the only thing that takes
      // a `position: fixed` element out of the player's way completely.
      else if (element !== null) element.setAttribute('style', FALLBACK_STYLE_HIDDEN)
    },
    get retired(): boolean {
      return retired
    },
    get erase(): boolean {
      return host.eraseMode
    },
    get label(): string {
      return label
    },
    get renders(): number {
      return renders
    },
  }
}

/**
 * Compile-time pins.
 *
 * The first keeps `pointer.ts` and this file wired: `PointerInput` is what
 * `main.ts` passes as the host, and if Task 7's contract ever loses `eraseMode`
 * or `toggleEraseMode` this fails here rather than at the call site in `main.ts`.
 * The second pins the production factory in this file's module comment.
 *
 * The `Assert<T extends true>` wrapper is load-bearing for the reason Task 4
 * recorded: `type X = A extends B ? true : never` pins nothing, because `never`
 * is a perfectly good type and `tsc` stays silent.
 */
type Assert<T extends true> = T
export type _PointerInputIsAnEraseControlHost = Assert<
  PointerInput extends EraseControlHost ? true : false
>
/**
 * `createFallback` is REQUIRED, pinned so that relaxing it back to optional is a
 * compile error here rather than a silently reachable `NONE` in `main.ts`. See
 * the property's own comment for what that costs when it is wrong.
 *
 * `undefined extends T` is the test for optionality: on a required property it
 * is false, and on `createFallback?: F` the property type includes `undefined`.
 */
export type _FallbackFactoryIsRequired = Assert<
  undefined extends EraseControlDeps['createFallback'] ? false : true
>
export type _RealButtonIsAFallbackElement = Assert<
  HTMLButtonElement extends FallbackElement ? true : false
>
