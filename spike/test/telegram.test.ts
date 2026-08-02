import { describe, it, expect, afterEach } from 'vitest'
import { atLeast, platformName, stableHeight, contentSafeAreaTop } from '../src/telegram'

function install(webApp: unknown): void {
  ;(globalThis as Record<string, unknown>).Telegram = { WebApp: webApp }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Telegram
})

describe('telegram adapter', () => {
  it('reports browser platform when Telegram is absent', () => {
    expect(platformName()).toBe('browser')
  })

  it('returns false from atLeast when Telegram is absent', () => {
    expect(atLeast('8.0')).toBe(false)
  })

  it('delegates atLeast to the client when present', () => {
    install({ isVersionAtLeast: (v: string) => v === '7.7' })
    expect(atLeast('7.7')).toBe(true)
    expect(atLeast('8.0')).toBe(false)
  })

  it('returns false from atLeast when the client throws', () => {
    install({ isVersionAtLeast: () => { throw new Error('old client') } })
    expect(atLeast('8.0')).toBe(false)
  })

  it('prefers viewportStableHeight over innerHeight', () => {
    install({ viewportStableHeight: 640 })
    expect(stableHeight()).toBe(640)
  })

  it('falls back to innerHeight when stable height is missing or zero', () => {
    install({ viewportStableHeight: 0 })
    expect(stableHeight()).toBe(globalThis.innerHeight)
  })

  it('reads the content safe area top inset', () => {
    install({ contentSafeAreaInset: { top: 46 } })
    expect(contentSafeAreaTop()).toBe(46)
  })

  it('returns zero content safe area when absent', () => {
    expect(contentSafeAreaTop()).toBe(0)
  })
})
