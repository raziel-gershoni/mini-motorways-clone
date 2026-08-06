import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MAIN_BUTTON_MIN_VERSION,
  atLeast,
  boot,
  bottomInset,
  clientVersion,
  contentSafeAreaTop,
  mainButton,
  onViewportChanged,
  platformName,
  safeAreaBottom,
  safeAreaTop,
  stableHeight,
  topInset,
  type MainButtonLike,
} from '../src/telegram'
import { performanceClass } from '../src/deviceInfo'

/**
 * Plan Task 8: the boot sequence, its two version gates, both inset systems, the
 * `viewportChanged` subscription, the `MainButton` handle the erase control
 * rides on — and the shipped `index.html`, which is where every one of them
 * silently stops working if one line goes missing.
 *
 * ---------------------------------------------------------------------------
 * THE STUB GOES ON `globalThis.Telegram.WebApp`, AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * `atLeast()` is the exported helper; `isVersionAtLeast` is reachable only
 * inside `telegram.ts`'s private `webApp()` wrapper. So a stub must install
 * `globalThis.Telegram.WebApp.isVersionAtLeast` — stubbing an importable symbol
 * would produce a test that passes and proves nothing, because the code under
 * test never reads it.
 *
 * ---------------------------------------------------------------------------
 * EACH GATE NEEDS ITS OWN REPORTED VERSION
 * ---------------------------------------------------------------------------
 *
 * `atLeast` returns `false` whenever `isVersionAtLeast` is absent, so a single
 * "old client" fixture suppresses **everything past `expand()` at once** and
 * cannot tell the 7.7 gate from the 8.0 gate. Every gate fixture below therefore
 * reports a real version through a real `isVersionAtLeast`, and the two gates
 * are separated by fixtures that straddle exactly one of them (7.6/7.7 and
 * 7.9/8.0).
 */

// ---------------------------------------------------------------------------
// The recording stub
// ---------------------------------------------------------------------------

interface ViewportEvent {
  readonly isStateStable?: boolean
}

interface StubOptions {
  /** What `isVersionAtLeast` compares against. `null` omits the method entirely. */
  readonly version: string | null
  readonly platform?: string
  readonly viewportStableHeight?: number
  readonly contentSafeAreaInset?: { top?: number; bottom?: number }
  readonly safeAreaInset?: { top?: number; bottom?: number }
  /** Methods that throw when called, to exercise `call()`'s swallow. */
  readonly throwing?: readonly string[]
  /** Omit these methods from the stub, so `typeof fn !== 'function'` is exercised. */
  readonly missing?: readonly string[]
  readonly mainButton?: Partial<MainButtonLike> | null
  readonly withoutOnEvent?: boolean
}

interface Stub {
  /** Every boot call, in the order it was made. */
  readonly log: string[]
  /** Fires a `viewportChanged` at every subscribed handler. */
  readonly emitViewport: (event: ViewportEvent | undefined) => void
  readonly mainButton: MainButtonRecorder | null
}

interface MainButtonRecorder extends MainButtonLike {
  readonly calls: string[]
  readonly handlers: Array<() => void>
}

/** Semver-ish compare, exactly what a real client's `isVersionAtLeast` does. */
function versionAtLeast(have: string, want: string): boolean {
  const a = have.split('.').map(Number)
  const b = want.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

function installStub(options: StubOptions): Stub {
  const log: string[] = []
  const missing = new Set(options.missing ?? [])
  const throwing = new Set(options.throwing ?? [])
  const handlers: Array<(event?: ViewportEvent) => void> = []

  const record = (name: string) => (): void => {
    log.push(name)
    if (throwing.has(name)) throw new Error(`stub: ${name} is unsupported on this client`)
  }

  const webApp: Record<string, unknown> = {}
  for (const name of ['ready', 'expand', 'disableVerticalSwipes', 'requestFullscreen', 'lockOrientation']) {
    if (!missing.has(name)) webApp[name] = record(name)
  }
  if (options.version !== null) {
    const reported = options.version
    webApp.version = reported
    webApp.isVersionAtLeast = (want: string): boolean => versionAtLeast(reported, want)
  }
  if (options.platform !== undefined) webApp.platform = options.platform
  if (options.viewportStableHeight !== undefined) {
    webApp.viewportStableHeight = options.viewportStableHeight
  }
  if (options.contentSafeAreaInset !== undefined) {
    webApp.contentSafeAreaInset = options.contentSafeAreaInset
  }
  if (options.safeAreaInset !== undefined) webApp.safeAreaInset = options.safeAreaInset
  if (!options.withoutOnEvent) {
    webApp.onEvent = (event: string, handler: (payload?: ViewportEvent) => void): void => {
      log.push(`onEvent:${event}`)
      handlers.push(handler)
    }
  }

  let recorder: MainButtonRecorder | null = null
  if (options.mainButton !== null && options.mainButton !== undefined) {
    const calls: string[] = []
    const pressHandlers: Array<() => void> = []
    const base: Record<string, unknown> = {
      calls,
      handlers: pressHandlers,
      setText: (text: string) => calls.push(`setText:${text}`),
      setParams: (params: Record<string, unknown>) => calls.push(`setParams:${JSON.stringify(params)}`),
      onClick: (handler: () => void) => {
        calls.push('onClick')
        pressHandlers.push(handler)
      },
      show: () => calls.push('show'),
      hide: () => calls.push('hide'),
    }
    for (const [key, value] of Object.entries(options.mainButton)) base[key] = value
    for (const [key, value] of Object.entries(options.mainButton)) {
      if (value === undefined) delete base[key]
    }
    recorder = base as unknown as MainButtonRecorder
    webApp.MainButton = recorder
  }

  ;(globalThis as Record<string, unknown>).Telegram = { WebApp: webApp }

  return {
    log,
    emitViewport(event): void {
      for (const handler of handlers) handler(event)
    },
    mainButton: recorder,
  }
}

function uninstallStub(): void {
  delete (globalThis as Record<string, unknown>).Telegram
}

afterEach(() => {
  uninstallStub()
  delete (globalThis as Record<string, unknown>).innerHeight
})

/** The full sequence, on a client new enough for every call. */
const FULL_BOOT = ['ready', 'expand', 'disableVerticalSwipes', 'requestFullscreen', 'lockOrientation']

// ---------------------------------------------------------------------------

describe('boot(): the exact order spec §8.2 fixes', () => {
  it('calls ready, expand, disableVerticalSwipes, requestFullscreen, lockOrientation in that order', () => {
    const stub = installStub({ version: '8.0' })
    boot()
    expect(stub.log).toEqual(FULL_BOOT)
    // Vacuity: five calls, not "at least the ones we looked for".
    expect(stub.log.length).toBe(5)
  })

  it('calls ready before expand, and both before anything gated — order, not membership', () => {
    const stub = installStub({ version: '8.0' })
    boot()
    expect(stub.log.indexOf('ready')).toBe(0)
    expect(stub.log.indexOf('expand')).toBe(1)
    expect(stub.log.indexOf('expand')).toBeLessThan(stub.log.indexOf('disableVerticalSwipes'))
    expect(stub.log.indexOf('disableVerticalSwipes')).toBeLessThan(stub.log.indexOf('requestFullscreen'))
    expect(stub.log.indexOf('requestFullscreen')).toBeLessThan(stub.log.indexOf('lockOrientation'))
  })

  /**
   * `ready` and `expand` are Bot API 6.0 baseline and pass no `minVersion`, so
   * they must survive a client so old that every gate below them closes. This is
   * the positive half of "two of the four calls have no version gate, correctly".
   */
  it('still calls ready and expand on a client that reports 6.0', () => {
    const stub = installStub({ version: '6.0' })
    boot()
    expect(stub.log).toEqual(['ready', 'expand'])
  })
})

describe('the 7.7 gate: disableVerticalSwipes', () => {
  it('is called on a client reporting 7.7', () => {
    const stub = installStub({ version: '7.7' })
    boot()
    expect(stub.log).toContain('disableVerticalSwipes')
  })

  it('is NOT called on a client reporting 7.6, which still gets ready and expand', () => {
    const stub = installStub({ version: '7.6' })
    boot()
    expect(stub.log).not.toContain('disableVerticalSwipes')
    // The negative control: the stub is live and recording, so "not called" is
    // about the gate rather than about a stub that records nothing.
    expect(stub.log).toEqual(['ready', 'expand'])
  })
})

describe('the 8.0 gate: requestFullscreen and lockOrientation', () => {
  it('calls both on a client reporting 8.0', () => {
    const stub = installStub({ version: '8.0' })
    boot()
    expect(stub.log).toContain('requestFullscreen')
    expect(stub.log).toContain('lockOrientation')
  })

  /**
   * 7.9 is the fixture that separates the two gates. A single "old client"
   * fixture would suppress the 7.7 call as well and could not tell which gate
   * was doing the work — so this asserts `disableVerticalSwipes` IS called here.
   */
  it('calls neither on a client reporting 7.9, which still gets the 7.7 call', () => {
    const stub = installStub({ version: '7.9' })
    boot()
    expect(stub.log).not.toContain('requestFullscreen')
    expect(stub.log).not.toContain('lockOrientation')
    expect(stub.log).toEqual(['ready', 'expand', 'disableVerticalSwipes'])
  })
})

describe('boot() outside Telegram', () => {
  it('completes without throwing and calls nothing, with no Telegram object at all', () => {
    uninstallStub()
    expect(() => {
      boot()
    }).not.toThrow()
    expect(atLeast('6.0')).toBe(false)
    expect(platformName()).toBe('browser')
    expect(clientVersion()).toBe('none')
  })

  /**
   * The negative control the catalogue requires: "nothing was called" is
   * satisfied by a stub that never records, so the same assertion shape must be
   * shown to record when the object IS there.
   */
  it('the same log records five calls once the object exists — the negative control', () => {
    const stub = installStub({ version: '8.0' })
    boot()
    expect(stub.log.length).toBe(5)
  })

  it('survives a client whose methods throw, and keeps going to the end of the sequence', () => {
    const stub = installStub({ version: '8.0', throwing: ['expand', 'requestFullscreen'] })
    expect(() => {
      boot()
    }).not.toThrow()
    expect(stub.log).toEqual(FULL_BOOT)
  })

  it('skips a method the client does not expose, without skipping the rest', () => {
    const stub = installStub({ version: '8.0', missing: ['disableVerticalSwipes'] })
    boot()
    expect(stub.log).toEqual(['ready', 'expand', 'requestFullscreen', 'lockOrientation'])
  })
})

describe('atLeast()', () => {
  it('is false when isVersionAtLeast is absent — which is what suppresses every gate at once', () => {
    installStub({ version: null })
    expect(atLeast('6.0')).toBe(false)
    expect(atLeast('7.7')).toBe(false)
  })

  it('is false when isVersionAtLeast throws', () => {
    installStub({ version: '8.0' })
    const webApp = (globalThis as unknown as { Telegram: { WebApp: Record<string, unknown> } }).Telegram.WebApp
    webApp.isVersionAtLeast = (): boolean => {
      throw new Error('partial client')
    }
    expect(atLeast('7.7')).toBe(false)
  })

  it('is false when isVersionAtLeast returns a truthy non-true value', () => {
    installStub({ version: '8.0' })
    const webApp = (globalThis as unknown as { Telegram: { WebApp: Record<string, unknown> } }).Telegram.WebApp
    webApp.isVersionAtLeast = (): unknown => 1
    expect(atLeast('7.7')).toBe(false)
  })

  it('compares versions rather than matching them', () => {
    installStub({ version: '8.0' })
    expect(atLeast('7.7')).toBe(true)
    expect(atLeast('8.0')).toBe(true)
    expect(atLeast('8.1')).toBe(false)
  })
})

describe('both inset systems — spec §8.3 requires both, the spike exposed one', () => {
  it('topInset is the MAX of contentSafeAreaInset.top and safeAreaInset.top, both directions', () => {
    installStub({ version: '8.0', contentSafeAreaInset: { top: 46 }, safeAreaInset: { top: 12 } })
    expect(topInset()).toBe(46)
    uninstallStub()
    installStub({ version: '8.0', contentSafeAreaInset: { top: 12 }, safeAreaInset: { top: 59 } })
    expect(topInset()).toBe(59)
  })

  it('reads each inset on its own, so the max cannot be mistaken for one of them', () => {
    installStub({ version: '8.0', contentSafeAreaInset: { top: 46 }, safeAreaInset: { top: 12, bottom: 34 } })
    expect(contentSafeAreaTop()).toBe(46)
    expect(safeAreaTop()).toBe(12)
    expect(safeAreaBottom()).toBe(34)
  })

  it('bottomInset is safeAreaInset.bottom', () => {
    installStub({ version: '8.0', safeAreaInset: { bottom: 34 } })
    expect(bottomInset()).toBe(34)
  })

  it('is 0 for every inset when the client publishes none', () => {
    installStub({ version: '8.0' })
    expect(topInset()).toBe(0)
    expect(bottomInset()).toBe(0)
    expect(contentSafeAreaTop()).toBe(0)
    expect(safeAreaTop()).toBe(0)
    expect(safeAreaBottom()).toBe(0)
  })

  it('is 0 for every inset outside Telegram', () => {
    uninstallStub()
    expect(topInset()).toBe(0)
    expect(bottomInset()).toBe(0)
  })
})

describe('stableHeight()', () => {
  it('prefers viewportStableHeight', () => {
    installStub({ version: '8.0', viewportStableHeight: 812 })
    ;(globalThis as Record<string, unknown>).innerHeight = 999
    expect(stableHeight()).toBe(812)
  })

  it('falls back to innerHeight when the client reports 0 — a mid-transition reading', () => {
    installStub({ version: '8.0', viewportStableHeight: 0 })
    ;(globalThis as Record<string, unknown>).innerHeight = 844
    expect(stableHeight()).toBe(844)
  })

  it('falls back to innerHeight outside Telegram', () => {
    uninstallStub()
    ;(globalThis as Record<string, unknown>).innerHeight = 700
    expect(stableHeight()).toBe(700)
  })
})

describe('onViewportChanged()', () => {
  it('subscribes to the viewportChanged event and reports that it did', () => {
    const stub = installStub({ version: '8.0' })
    const seen: boolean[] = []
    expect(
      onViewportChanged((stable) => {
        seen.push(stable)
      }),
    ).toBe(true)
    expect(stub.log).toContain('onEvent:viewportChanged')
    stub.emitViewport({ isStateStable: true })
    stub.emitViewport({ isStateStable: false })
    expect(seen).toEqual([true, false])
  })

  it('reports a payload with no isStateStable field as NOT stable', () => {
    const stub = installStub({ version: '8.0' })
    const seen: boolean[] = []
    onViewportChanged((stable) => {
      seen.push(stable)
    })
    stub.emitViewport({})
    stub.emitViewport(undefined)
    expect(seen).toEqual([false, false])
  })

  it('returns false and subscribes nothing when there is no onEvent', () => {
    installStub({ version: '8.0', withoutOnEvent: true })
    expect(onViewportChanged(() => undefined)).toBe(false)
  })

  it('returns false outside Telegram', () => {
    uninstallStub()
    expect(onViewportChanged(() => undefined)).toBe(false)
  })
})

describe('mainButton(): version-gated, then shape-rechecked', () => {
  it('returns the handle on a client at the gate with a complete MainButton', () => {
    installStub({ version: MAIN_BUTTON_MIN_VERSION, mainButton: {} })
    expect(mainButton()).not.toBeNull()
  })

  it('returns null outside Telegram — the development fallback case', () => {
    uninstallStub()
    expect(mainButton()).toBeNull()
  })

  /**
   * Its own reported version, straddling only this gate: the MainButton object
   * is present and complete, and the gate alone is what refuses it. Without this
   * fixture, deleting the gate would be invisible.
   */
  it('returns null below the gate even though the MainButton object is present and complete', () => {
    const stub = installStub({ version: '5.9', mainButton: {} })
    expect(stub.mainButton).not.toBeNull()
    expect(mainButton()).toBeNull()
  })

  it('returns null when the client claims the version but exposes no MainButton', () => {
    installStub({ version: '8.0', mainButton: null })
    expect(mainButton()).toBeNull()
  })

  it('returns null when MainButton is there but incomplete — the shape re-check', () => {
    installStub({ version: '8.0', mainButton: { setText: undefined } })
    expect(mainButton()).toBeNull()
    uninstallStub()
    installStub({ version: '8.0', mainButton: { onClick: undefined } })
    expect(mainButton()).toBeNull()
    uninstallStub()
    installStub({ version: '8.0', mainButton: { show: undefined } })
    expect(mainButton()).toBeNull()
    uninstallStub()
    installStub({ version: '8.0', mainButton: { setParams: undefined } })
    expect(mainButton()).toBeNull()
  })
})

describe('performanceClass(), lifted from the M0 spike', () => {
  it('reads the Telegram-Android token', () => {
    expect(performanceClass('Mozilla/5.0 ... Telegram-Android/11.2.0 (Samsung SM-A125F; ... ; AVERAGE)')).toBe('AVERAGE')
    expect(performanceClass('... ; LOW)')).toBe('LOW')
    expect(performanceClass('... ; HIGH)')).toBe('HIGH')
  })

  it('is null on a user agent with no token — every iOS device', () => {
    expect(performanceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)')).toBeNull()
  })

  it('does not match a token embedded in a longer word', () => {
    expect(performanceClass('SLOWLY')).toBeNull()
    expect(performanceClass('HIGHER')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The shipped index.html
// ---------------------------------------------------------------------------

/**
 * **The one file in this milestone whose absence is completely silent.**
 *
 * Without `telegram-web-app.js`, `globalThis.Telegram` is undefined, `atLeast()`
 * returns false, `call()` early-returns and **the entire boot sequence no-ops
 * with no error** — the game still renders, so it looks like it works, and every
 * test above stubs the very object production would be missing. So the shipped
 * file is asserted as text, in the idiom `sim/test/loop.test.ts` already uses to
 * pin the goldens.
 */
describe('index.html — the shell nothing else can check', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

  it('is a non-trivial file, so every assertion below is not vacuously true of an empty one', () => {
    expect(html.length).toBeGreaterThan(800)
  })

  it('loads the Telegram SDK, without which the whole boot sequence silently no-ops', () => {
    expect(html).toContain('https://telegram.org/js/telegram-web-app.js')
    // Before the module that boots, or `globalThis.Telegram` is undefined when
    // `boot()` runs. Ordinary `<script>` is synchronous; the app is `type=module`
    // and therefore deferred, so source order is the guarantee.
    expect(html.indexOf('telegram-web-app.js')).toBeLessThan(html.indexOf('type="module"'))
    expect(html).not.toContain('telegram-web-app.js" async')
    expect(html).not.toContain('telegram-web-app.js" defer')
  })

  it('carries the viewport meta, including viewport-fit=cover for the safe-area insets', () => {
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />',
    )
  })

  it('sets touch-action: none ON THE CANVAS, and not on the body', () => {
    // **Scoped, and the scope is the assertion.** `touch-action: none` on
    // `body` is the legacy workaround spec §8.3 explicitly forbids — it is the
    // approach reported broken and it kills legitimate scrolling everywhere
    // else on the page. An unscoped `toMatch` passes for that mutation, which
    // is why the rule blocks are parsed rather than the file searched.
    const canvasRule = /canvas\s*\{([^}]*)\}/.exec(html)?.[1]
    expect(canvasRule, 'there is no canvas rule at all').toBeDefined()
    expect(canvasRule).toMatch(/touch-action:\s*none/)

    const bodyRule = /html,\s*\n?\s*body\s*\{([^}]*)\}/.exec(html)?.[1]
    expect(bodyRule, 'there is no html/body rule at all').toBeDefined()
    expect(bodyRule).not.toMatch(/touch-action/)
  })

  it('sets overscroll-behavior: contain (spec §8.3)', () => {
    expect(html).toMatch(/overscroll-behavior:\s*contain/)
  })

  it('sizes off --tg-viewport-stable-height, because 100vh is unreliable in the webview', () => {
    expect(html).toContain('var(--tg-viewport-stable-height, 100vh)')
  })

  it('paints the background in the palette colour, so the letterbox is not white', () => {
    expect(html).toContain('#d9d3c7')
  })

  it('carries no cross-origin asset but the Telegram SDK (spec §8.5)', () => {
    const external = [...html.matchAll(/(?:src|href)="(https?:)?\/\/([^"]+)"/g)].map((m) => m[2] ?? '')
    expect(external).toEqual(['telegram.org/js/telegram-web-app.js'])
  })

  it('has the canvas the shell sizes and exactly one root-absolute entry module', () => {
    expect(html).toContain('id="board"')
    const modules = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map((m) => m[1] as string)
    expect(modules).toEqual(['/src/main.ts'])
    // Root-absolute, not relative: a relative specifier resolves against the
    // request path, so a Mini App opened at anything but `/` 404s its whole
    // bundle — and spec §8.5 says iOS reports that as a blank screen.
    expect(modules[0]?.startsWith('/')).toBe(true)
  })

  /**
   * **The half of the entry-point check that is not self-referential, stated
   * with its own vacuity.** Asserting the literal `/src/main.ts` above pins the
   * agreed name and nothing more — nothing checks the file will exist, because
   * at Task 8 it does not. This closes the other direction: the moment Task 9
   * creates an entry module, the shell must point at THAT file. A Task 9 that
   * names it `index.ts`, or moves it, turns this red instead of shipping a
   * blank screen.
   */
  it('points at the entry module Task 9 actually creates, once one exists', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
    const entries = readdirSync(srcDir).filter((f) => /^main.*\.tsx?$/.test(f))
    if (entries.length === 0) {
      // Vacuous today, deliberately and visibly: `src/main.ts` is Task 9's file.
      expect(readdirSync(srcDir).length, 'src/ is empty, so this test proves nothing').toBeGreaterThan(0)
      return
    }
    const referenced = /<script type="module" src="\/src\/([^"]+)"/.exec(html)?.[1]
    expect(entries, `index.html points at ${String(referenced)}`).toContain(referenced)
  })
})
