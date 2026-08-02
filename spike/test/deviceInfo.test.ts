import { describe, it, expect } from 'vitest'
import { performanceClass } from '../src/deviceInfo'

const TELEGRAM_ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 11; Redmi Note 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/119.0.0.0 Mobile Safari/537.36 Telegram-Android/11.2.3 (Xiaomi Redmi Note 8; Android 11; SDK 30; AVERAGE)'

const PLAIN_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Mobile Safari/537.36'

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

describe('performanceClass', () => {
  it('extracts AVERAGE from a Telegram-Android user agent', () => {
    expect(performanceClass(TELEGRAM_ANDROID_UA)).toBe('AVERAGE')
  })

  it('extracts LOW', () => {
    expect(performanceClass(TELEGRAM_ANDROID_UA.replace('AVERAGE', 'LOW'))).toBe('LOW')
  })

  it('extracts HIGH', () => {
    expect(performanceClass(TELEGRAM_ANDROID_UA.replace('AVERAGE', 'HIGH'))).toBe('HIGH')
  })

  it('returns null for a plain Chrome user agent', () => {
    expect(performanceClass(PLAIN_CHROME_UA)).toBeNull()
  })

  it('returns null on iOS, which exposes no performance class', () => {
    expect(performanceClass(IOS_UA)).toBeNull()
  })

  it('does not match the words inside unrelated tokens', () => {
    expect(performanceClass('Mozilla/5.0 SLOWPOKE/1.0 HIGHLANDER/2')).toBeNull()
  })
})
