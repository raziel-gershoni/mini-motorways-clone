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

export function safeAreaTop(): number {
  return webApp()?.safeAreaInset?.top ?? 0
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
