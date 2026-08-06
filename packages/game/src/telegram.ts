/**
 * The Telegram Mini App surface: spec §8.2's boot sequence, spec §8.3's two
 * inset systems, the stable-viewport subscription, and the `MainButton` handle
 * the erase control rides on.
 *
 * **Lifted from `spike/src/telegram.ts`, which is not modified.** Three things
 * changed in the lift and each is a decision rather than a tidy-up:
 *
 *  - `cloudStorage()` and its `import type { CloudLike } from './cloudProbe'`
 *    are **dropped**. M2 persists nothing; M3 owns it. Keeping them would drag
 *    `cloudProbe.ts` — a whole M0 probe harness — into `packages/game` for a
 *    function with no caller.
 *  - A `safeAreaInset` reader is **added**. Spec §8.3 requires **both** inset
 *    systems and the spike exposed only `contentSafeAreaInset.top`, so on a
 *    device where the two disagree the spike's number is the smaller one and the
 *    board draws under the notch. `render/types.ts` already documents the
 *    contract this file now meets: `topInset` is the **max** of the two tops,
 *    `bottomInset` is `safeAreaInset.bottom`.
 *  - `onViewportChanged` and `mainButton` are **added**, for `shell.ts` and
 *    `eraseControl.ts` respectively.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE THROWS, AND NOTHING HERE ASSUMES TELEGRAM IS PRESENT
 * ---------------------------------------------------------------------------
 *
 * Every function tolerates `globalThis.Telegram` being undefined, because that
 * is the ordinary case in development and in any browser. `call()` swallows
 * exceptions too: old and partial clients throw on methods they advertise, and a
 * boot sequence that dies half way through leaves the app expanded but not
 * fullscreen, with no error anyone will see.
 *
 * **The cost of that tolerance is stated rather than discovered**: with no SDK
 * loaded the entire boot sequence no-ops **silently**, the game still renders,
 * and it looks like it works. `index.html`'s SDK script tag is the only thing
 * standing between that and production, which is why `test/telegram.test.ts`
 * asserts the shipped HTML as text — every test in it stubs the very object
 * production would be missing.
 *
 * ---------------------------------------------------------------------------
 * `atLeast` IS THE EXPORTED HELPER; `isVersionAtLeast` IS NOT REACHABLE
 * ---------------------------------------------------------------------------
 *
 * `isVersionAtLeast` is read only inside `webApp()` below. A test that stubs an
 * importable symbol instead of `globalThis.Telegram.WebApp.isVersionAtLeast`
 * passes and proves nothing. And because `atLeast` returns `false` when the
 * method is absent, one "old client" fixture suppresses **everything past
 * `expand()`** at once — so each gate needs its own reported version, which is
 * how `test/telegram.test.ts` is built.
 */

interface SafeAreaInset {
  top?: number
  bottom?: number
  left?: number
  right?: number
}

/**
 * The slice of Telegram's `MainButton` the erase control uses, and nothing more.
 *
 * Every member is optional because this is a **claim about a remote client**,
 * not a local interface: a WebView may expose the object and not one of its
 * methods. `mainButton()` re-checks the shape at runtime for exactly that
 * reason — see there.
 */
export interface MainButtonLike {
  setText?: (text: string) => void
  setParams?: (params: {
    text?: string
    color?: string
    text_color?: string
    is_active?: boolean
    is_visible?: boolean
  }) => void
  onClick?: (handler: () => void) => void
  offClick?: (handler: () => void) => void
  show?: () => void
  hide?: () => void
}

/** The `viewportChanged` payload. `isStateStable` is false during a transition. */
interface ViewportChangedEvent {
  isStateStable?: boolean
}

interface WebAppLike {
  ready?: () => void
  expand?: () => void
  disableVerticalSwipes?: () => void
  requestFullscreen?: () => void
  lockOrientation?: () => void
  isVersionAtLeast?: (v: string) => boolean
  onEvent?: (event: string, handler: (payload?: ViewportChangedEvent) => void) => void
  viewportStableHeight?: number
  platform?: string
  version?: string
  contentSafeAreaInset?: SafeAreaInset
  safeAreaInset?: SafeAreaInset
  MainButton?: MainButtonLike
}

function webApp(): WebAppLike | null {
  const g = globalThis as Record<string, unknown>
  const t = g.Telegram as { WebApp?: WebAppLike } | undefined
  return t?.WebApp ?? null
}

/** Never throws. Returns false on old clients that lack the method. */
export function atLeast(version: string): boolean {
  const w = webApp()
  if (!w?.isVersionAtLeast) return false
  try {
    return w.isVersionAtLeast(version) === true
  } catch {
    return false
  }
}

/**
 * The four boot methods, by name. A union rather than `keyof WebAppLike` so a
 * caller cannot ask `call()` to invoke `viewportStableHeight`.
 */
type BootMethod = 'ready' | 'expand' | 'disableVerticalSwipes' | 'requestFullscreen' | 'lockOrientation'

function call(name: BootMethod, minVersion?: string): void {
  const w = webApp()
  if (!w) return
  if (minVersion && !atLeast(minVersion)) return
  const fn = w[name]
  if (typeof fn !== 'function') return
  try {
    fn.call(w)
  } catch {
    // Old or partial clients throw on unsupported methods. Never fatal.
  }
}

export function platformName(): string {
  return webApp()?.platform ?? 'browser'
}

export function clientVersion(): string {
  return webApp()?.version ?? 'none'
}

/**
 * The viewport height Decision 5 fits against — the **stable** one, which
 * excludes the transient height Telegram reports mid-transition.
 *
 * `> 0` rather than `!= null`: a client mid-transition reports 0, and a 0-height
 * fit produces `fitCamera`'s clamped 1 px tile.
 */
export function stableHeight(): number {
  const h = webApp()?.viewportStableHeight
  return typeof h === 'number' && h > 0 ? h : globalThis.innerHeight
}

/** `contentSafeAreaInset.top` — Telegram's own chrome. 0 when unpublished. */
export function contentSafeAreaTop(): number {
  return webApp()?.contentSafeAreaInset?.top ?? 0
}

/** `safeAreaInset.top` — the device's notch. 0 when unpublished. */
export function safeAreaTop(): number {
  return webApp()?.safeAreaInset?.top ?? 0
}

/** `safeAreaInset.bottom` — the home indicator. 0 when unpublished. */
export function safeAreaBottom(): number {
  return webApp()?.safeAreaInset?.bottom ?? 0
}

/**
 * The top inset `fitCamera` subtracts: **the max of both systems**, per spec
 * §8.3 and `render/types.ts`'s documented contract.
 *
 * They measure different things and neither contains the other. `safeAreaInset`
 * is the device's own (the notch, the dynamic island); `contentSafeAreaInset` is
 * Telegram's chrome (the header, and in fullscreen the floating close button).
 * On a fullscreen iPhone the content inset is the larger; on a client below 8.0
 * that publishes no content inset at all it is 0 and the device inset is the only
 * one left. Taking either one alone draws the board under something on some
 * device, silently, and only on hardware.
 */
export function topInset(): number {
  const content = contentSafeAreaTop()
  const device = safeAreaTop()
  return content > device ? content : device
}

/**
 * The bottom inset: `safeAreaInset.bottom`, the home indicator.
 *
 * Not a max, and that asymmetry is `render/types.ts`'s contract rather than an
 * oversight: Telegram publishes no bottom content inset — its chrome is at the
 * top — so `contentSafeAreaInset.bottom` is 0 on every client, and a `max` here
 * would read as though there were a second source when there is not.
 */
export function bottomInset(): number {
  return safeAreaBottom()
}

/**
 * Subscribes to `viewportChanged`. Returns whether it actually subscribed, so a
 * caller can tell "no events will ever arrive" from "none have yet".
 *
 * The handler is given `isStateStable` as a plain boolean, defaulting to
 * **false** when the field is missing: an unknown state is a transient state,
 * and the expensive path (re-measure, possibly rebuild the atlas) must not run
 * on a payload shape we do not recognise. See `shell.ts` for what stability
 * buys.
 */
export function onViewportChanged(handler: (isStateStable: boolean) => void): boolean {
  const w = webApp()
  if (typeof w?.onEvent !== 'function') return false
  try {
    w.onEvent('viewportChanged', (payload) => {
      handler(payload?.isStateStable === true)
    })
  } catch {
    return false
  }
  return true
}

/**
 * The Bot API version `MainButton` first appeared in: the Mini Apps baseline.
 *
 * **A 6.0 gate is not decoration even though every real client clears it**, and
 * the reason is `atLeast`'s own contract: it returns `false` when there is no
 * API at all. So this single expression covers the case that actually happens —
 * running in a plain browser during development — as well as the theoretical
 * pre-6.0 client, and it does it through the same helper every other Telegram
 * surface in this file is gated by.
 */
export const MAIN_BUTTON_MIN_VERSION = '6.0'

/**
 * Telegram's `MainButton`, or `null` when this client cannot give us one.
 *
 * **Version-gated and then shape-re-checked**, which is the spike's own idiom
 * for `cloudStorage()`: the version gate says the client *claims* the feature,
 * not that this particular WebView actually exposes the methods. A partial
 * object is worse than an absent one here — the erase control would bind to a
 * button that never renders and the player would have no way to remove a road,
 * which is the exact failure the control exists to prevent.
 *
 * All four of `setText`, `setParams`, `onClick` and `show` are required, because
 * `eraseControl.ts` calls all four and a missing one is a `TypeError` at the
 * first press rather than at boot.
 */
export function mainButton(): MainButtonLike | null {
  if (!atLeast(MAIN_BUTTON_MIN_VERSION)) return null
  const mb = webApp()?.MainButton
  if (!mb) return null
  return typeof mb.setText === 'function' &&
    typeof mb.setParams === 'function' &&
    typeof mb.onClick === 'function' &&
    typeof mb.show === 'function'
    ? mb
    : null
}

/**
 * Spec §8.2's exact boot order. Safe to call outside Telegram.
 *
 * ```
 * ready() -> expand() -> disableVerticalSwipes() (7.7+) -> requestFullscreen()
 *   + lockOrientation() (8.0+) -> only then size the canvas
 * ```
 *
 * **`ready` and `expand` pass no `minVersion`, and that is correct rather than
 * an omission**: both are Bot API 6.0 baseline, which is the floor for a Mini
 * App existing at all. The claim this file makes is "every call that *needs* a
 * gate is gated", and there are exactly two such gates.
 *
 * **Callers MUST NOT size any canvas before this returns** — `requestFullscreen`
 * changes the viewport, and a fit taken before it is a fit of the pre-fullscreen
 * rectangle. It is not sufficient either: the client has not published the real
 * inset by the time this returns, which is why `shell.ts` measures twice.
 */
export function boot(): void {
  call('ready')
  call('expand')
  call('disableVerticalSwipes', '7.7')
  if (atLeast('8.0')) {
    call('requestFullscreen')
    call('lockOrientation')
  }
}
