import { describe, it, expect, afterEach } from 'vitest'
import { atLeast, platformName, stableHeight, contentSafeAreaTop, boot } from '../src/telegram'

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

describe('boot', () => {
  function spyWebApp(version: string): string[] {
    const calls: string[] = []
    const rec = (name: string) => () => { calls.push(name) }
    install({
      isVersionAtLeast: (v: string) => parseFloat(v) <= parseFloat(version),
      ready: rec('ready'),
      expand: rec('expand'),
      disableVerticalSwipes: rec('disableVerticalSwipes'),
      requestFullscreen: rec('requestFullscreen'),
      lockOrientation: rec('lockOrientation'),
    })
    return calls
  }

  it('calls ready, expand, swipes, fullscreen, lock in exact order on a modern client', () => {
    const calls = spyWebApp('8.0')
    boot()
    expect(calls).toEqual(['ready', 'expand', 'disableVerticalSwipes', 'requestFullscreen', 'lockOrientation'])
  })

  it('gates disableVerticalSwipes behind 7.7', () => {
    const calls = spyWebApp('7.6')
    boot()
    expect(calls).toEqual(['ready', 'expand'])
  })

  it('skips fullscreen and orientation lock below 8.0', () => {
    const calls = spyWebApp('7.7')
    boot()
    expect(calls).toEqual(['ready', 'expand', 'disableVerticalSwipes'])
  })

  it('continues booting when a lifecycle method throws', () => {
    const calls: string[] = []
    install({
      isVersionAtLeast: () => true,
      ready: () => { calls.push('ready') },
      expand: () => { throw new Error('unsupported on this client') },
      disableVerticalSwipes: () => { calls.push('disableVerticalSwipes') },
      requestFullscreen: () => { calls.push('requestFullscreen') },
      lockOrientation: () => { calls.push('lockOrientation') },
    })
    expect(() => boot()).not.toThrow()
    expect(calls).toEqual(['ready', 'disableVerticalSwipes', 'requestFullscreen', 'lockOrientation'])
  })

  it('is a no-op outside Telegram', () => {
    expect(() => boot()).not.toThrow()
  })
})
