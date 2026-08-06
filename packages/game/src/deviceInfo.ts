import type { PerformanceClass } from '@laneways/render'

/**
 * The one piece of `spike/src/deviceInfo.ts` M2 has a consumer for: the
 * Telegram-Android performance class, which is plan Decision 6's input to the
 * DPR cap (`min(rawDpr, LOW ? 1.5 : 2)`).
 *
 * **What the lift drops, and why, so nobody reads this as a partial copy.**
 * `collectDeviceInfo()` and `timerGranularityMs()` stay in the spike. The first
 * builds an M0 telemetry record whose only consumer was `report.ts`'s `submit()`
 * — a Worker endpoint that does not exist in this workspace. The second
 * **busy-waits up to 20 ms** measuring `performance.now()`'s clamp, which was
 * worth it to make M0's sub-millisecond bench numbers interpretable and is 20 ms
 * of dead boot time here, for a field nothing reads. Both are recoverable from
 * the spike if a later milestone wants telemetry.
 */

/**
 * Telegram-Android's device class. `null` on iOS and desktop, where no
 * equivalent is published.
 *
 * A structural alias of `render`'s `PerformanceClass` rather than a second
 * literal union — `render/types.ts` says the two "meet in `game`, where a
 * mismatch is a compile error rather than a silent divergence", and this is
 * where that promise is kept. `game` may import `render`; `render` may not
 * import anything.
 */
export type PerfClass = PerformanceClass

/**
 * Telegram-Android appends device capability info to the user agent, ending in a
 * performance class token. The exact format is not documented; this parser is
 * deliberately loose, and the raw UA is what any caller should log.
 *
 * The guards on either side are what stop `HIGHER` and `SLOWLY` matching.
 */
export function performanceClass(ua: string): PerfClass | null {
  const m = /(?:^|[^A-Z])(LOW|AVERAGE|HIGH)(?![A-Z])/.exec(ua)
  return m ? (m[1] as PerfClass) : null
}

/**
 * This device's performance class, read from the live user agent.
 *
 * `navigator` is guarded because `game` is unit-tested in Node, where it exists
 * but has reported a Node-shaped UA since v21 — and because a WebView with no
 * `navigator` should cap at the universal 2 rather than throw during boot.
 */
export function devicePerformanceClass(): PerfClass | null {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator
  const ua = nav?.userAgent
  return typeof ua === 'string' ? performanceClass(ua) : null
}
