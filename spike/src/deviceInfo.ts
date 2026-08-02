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
  ua: string
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
    ua,
  }
}
