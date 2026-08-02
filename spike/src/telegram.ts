import type { CloudLike } from './cloudProbe'

interface SafeAreaInset { top?: number; bottom?: number; left?: number; right?: number }

interface WebAppLike {
  ready?: () => void
  expand?: () => void
  disableVerticalSwipes?: () => void
  requestFullscreen?: () => void
  lockOrientation?: () => void
  isVersionAtLeast?: (v: string) => boolean
  viewportStableHeight?: number
  platform?: string
  version?: string
  contentSafeAreaInset?: SafeAreaInset
  safeAreaInset?: SafeAreaInset
  CloudStorage?: CloudLike
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

function call(name: keyof WebAppLike, minVersion?: string): void {
  const w = webApp()
  if (!w) return
  if (minVersion && !atLeast(minVersion)) return
  const fn = w[name]
  if (typeof fn !== 'function') return
  try {
    ;(fn as () => void).call(w)
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

export function stableHeight(): number {
  const h = webApp()?.viewportStableHeight
  return typeof h === 'number' && h > 0 ? h : globalThis.innerHeight
}

export function contentSafeAreaTop(): number {
  return webApp()?.contentSafeAreaInset?.top ?? 0
}

/**
 * CloudStorage, or null when unsupported. Requires Bot API 6.9+.
 * The shape is re-checked at runtime: the version gate says the client claims
 * the feature, not that this particular WebView actually exposes both methods.
 */
export function cloudStorage(): CloudLike | null {
  if (!atLeast('6.9')) return null
  const cs = webApp()?.CloudStorage
  return cs && typeof cs.getItem === 'function' && typeof cs.setItem === 'function' ? cs : null
}

/**
 * Exact boot order from the spec. Safe to call outside Telegram.
 * Callers MUST NOT size any canvas before this returns.
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
