import { platformName, clientVersion, stableHeight, contentSafeAreaTop } from './telegram'

export type PerfClass = 'LOW' | 'AVERAGE' | 'HIGH'

export interface DeviceInfo {
  platform: string
  clientVersion: string
  performanceClass: PerfClass | null
  dpr: number
  viewportW: number
  viewportH: number
  contentSafeAreaTop: number
  hardwareConcurrency: number
  timerGranularityMs: number
  ua: string
}

/**
 * Smallest observable non-zero gap between two performance.now() readings.
 * WebKit clamps this far more coarsely than V8 (commonly 1 ms), which silently
 * turns any sub-millisecond measurement into quantization noise. Recording it
 * is what makes every other timing number in the run interpretable after the
 * fact. Bounded to ~20 ms of wall clock so it cannot stall the boot.
 */
export function timerGranularityMs(): number {
  const deadline = performance.now() + 20
  let min = Infinity
  let taken = 0
  while (taken < 50 && performance.now() < deadline) {
    const a = performance.now()
    let b = performance.now()
    while (b === a && performance.now() < deadline) b = performance.now()
    const d = b - a
    if (d > 0 && d < min) min = d
    taken++
  }
  return Number.isFinite(min) ? min : -1
}

/**
 * Telegram-Android appends device capability info to the user agent, ending in a
 * performance class token. The exact format is not documented; this parser is
 * deliberately loose and MUST be checked against a real device UA captured in
 * Task 1 Step 11. `ua` is always reported raw so a wrong guess is recoverable.
 */
export function performanceClass(ua: string): PerfClass | null {
  const m = /(?:^|[^A-Z])(LOW|AVERAGE|HIGH)(?![A-Z])/.exec(ua)
  return m ? (m[1] as PerfClass) : null
}

export function collectDeviceInfo(): DeviceInfo {
  const ua = navigator.userAgent
  return {
    platform: platformName(),
    clientVersion: clientVersion(),
    performanceClass: performanceClass(ua),
    dpr: window.devicePixelRatio,
    viewportW: window.innerWidth,
    viewportH: stableHeight(),
    contentSafeAreaTop: contentSafeAreaTop(),
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
    timerGranularityMs: timerGranularityMs(),
    ua,
  }
}
