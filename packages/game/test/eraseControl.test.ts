import { describe, it, expect, afterEach } from 'vitest'
import { fitCamera, createHudRects, hudRects, HUD_PAD_CSS } from '@laneways/render'
import {
  ERASE_OFF_BG,
  ERASE_OFF_FG,
  ERASE_ON_BG,
  ERASE_ON_FG,
  FALLBACK_LABEL_OFF,
  FALLBACK_LABEL_ON,
  FALLBACK_MAX_WIDTH_CSS,
  FALLBACK_RIGHT_CSS,
  EraseControlSurface,
  MAIN_BUTTON_LABEL_OFF,
  MAIN_BUTTON_LABEL_ON,
  createEraseControl,
  type FallbackElement,
} from '../src/eraseControl'
import { createPointerInput } from '../src/pointer'
import { createInputQueue } from '../src/inputs'
import { REVEALED_X0, REVEALED_Y0, REVEALED_W, REVEALED_H } from '@laneways/shared'

/**
 * Plan Task 8's inherited Critical, and the reason M2 is playable at all.
 *
 * Task 7 implemented `toggleEraseMode` correctly and made erase an orthogonal
 * mode flag **no gesture can reach** — which is right, because spec §7.3 forbids
 * erase-on-tap and erase-on-long-press. But `hudRects` lays out exactly three
 * elements, none of them a toggle, and §8.3 bars the top band. So without this
 * file's subject the shipped build can draw roads and never remove one.
 *
 * The surface is Telegram's `MainButton`: native chrome, so it reserves its own
 * space and costs no canvas geometry, it is thumb-reachable by construction, and
 * it renders its own label and colour — which is what solves the real hazard,
 * an erase mode you cannot SEE you are in. `fitCamera` leaves 49 CSS px of free
 * strip on a 390x844 viewport and 40 on the M0 device, both below a 44 px touch
 * target, so "a DOM button outside the canvas" is not a location on a phone.
 */

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface MainButtonRecorder {
  readonly calls: string[]
  readonly press: () => void
}

function installTelegram(version: string | null, complete = true): MainButtonRecorder {
  const calls: string[] = []
  let handler: (() => void) | null = null
  const mb: Record<string, unknown> = {
    setText: (text: string) => calls.push(`setText:${text}`),
    setParams: (p: Record<string, unknown>) => calls.push(`setParams:${JSON.stringify(p)}`),
    onClick: (h: () => void) => {
      calls.push('onClick')
      handler = h
    },
    show: () => calls.push('show'),
  }
  if (!complete) delete mb.show
  const webApp: Record<string, unknown> = { MainButton: mb }
  if (version !== null) {
    webApp.version = version
    webApp.isVersionAtLeast = (want: string): boolean => {
      const a = version.split('.').map(Number)
      const b = want.split('.').map(Number)
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? 0
        const y = b[i] ?? 0
        if (x !== y) return x > y
      }
      return true
    }
  }
  ;(globalThis as Record<string, unknown>).Telegram = { WebApp: webApp }
  return {
    calls,
    press(): void {
      if (handler === null) throw new Error('no onClick handler was registered')
      handler()
    },
  }
}

interface FallbackRecorder extends FallbackElement {
  readonly calls: string[]
  readonly press: () => void
}

function fallbackRecorder(): FallbackRecorder {
  const calls: string[] = []
  let handler: (() => void) | null = null
  return {
    calls,
    textContent: null,
    setAttribute(name: string, value: string): void {
      calls.push(`${name}=${value}`)
    },
    addEventListener(_type: 'click', h: () => void): void {
      calls.push('click')
      handler = h
    },
    press(): void {
      if (handler === null) throw new Error('no click handler was registered')
      handler()
    },
  }
}

/**
 * A factory that declines. `createFallback` is REQUIRED — omitting it used to
 * compile and produce a build with no way to reach erase mode at all — so the
 * MainButton fixtures below have to say explicitly that they want no fallback,
 * which is the point: it is now a decision rather than an omission.
 */
const NO_FALLBACK = (): null => null

/** A minimal host: the two members `PointerInput` exposes for this control. */
function fakeHost(): { eraseMode: boolean; toggleEraseMode: () => boolean } {
  let erase = false
  return {
    get eraseMode(): boolean {
      return erase
    },
    toggleEraseMode(): boolean {
      erase = !erase
      return erase
    },
  }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Telegram
})

// ---------------------------------------------------------------------------

describe('the erase control picks a surface, and says which and why', () => {
  it('uses the MainButton on a client at the gate', () => {
    installTelegram('8.0')
    const control = createEraseControl({ host: fakeHost(), createFallback: NO_FALLBACK })
    expect(control.surface).toBe(EraseControlSurface.MAIN_BUTTON)
  })

  it('falls back to the DOM outside Telegram — the development case', () => {
    const el = fallbackRecorder()
    const control = createEraseControl({ host: fakeHost(), createFallback: () => el })
    expect(control.surface).toBe(EraseControlSurface.DOM_NO_TELEGRAM)
  })

  /**
   * Its own reported version, straddling only the MainButton gate: the object is
   * present and complete and the gate alone refuses it. Deleting the gate would
   * otherwise be invisible, because every other fallback case has the button
   * missing too.
   */
  it('falls back to the DOM below the gate, with a complete MainButton present', () => {
    installTelegram('5.9')
    const el = fallbackRecorder()
    const control = createEraseControl({ host: fakeHost(), createFallback: () => el })
    expect(control.surface).toBe(EraseControlSurface.DOM_BELOW_GATE)
  })

  it('falls back to the DOM when the client clears the gate but the button is incomplete', () => {
    installTelegram('8.0', false)
    const el = fallbackRecorder()
    const control = createEraseControl({ host: fakeHost(), createFallback: () => el })
    expect(control.surface).toBe(EraseControlSurface.DOM_NO_MAIN_BUTTON)
  })

  it('reports NONE when there is no MainButton and no fallback factory either', () => {
    const control = createEraseControl({ host: fakeHost(), createFallback: NO_FALLBACK })
    expect(control.surface).toBe(EraseControlSurface.NONE)
  })

  it('reports NONE when the fallback factory itself declines', () => {
    const control = createEraseControl({ host: fakeHost(), createFallback: () => null })
    expect(control.surface).toBe(EraseControlSurface.NONE)
  })

  /**
   * The doc comment says "never throws, on any client", and an injected factory
   * is somebody else's code. An exception escaping this constructor takes down
   * boot for a control that is allowed to be absent, so a throwing factory is
   * treated exactly as a declining one.
   */
  it('treats a factory that THROWS as one that declined, rather than propagating', () => {
    let control: ReturnType<typeof createEraseControl> | null = null
    expect(() => {
      control = createEraseControl({
        host: fakeHost(),
        createFallback: () => {
          throw new Error('no document in this environment')
        },
      })
    }).not.toThrow()
    expect(control).not.toBeNull()
    expect((control as unknown as { surface: number }).surface).toBe(EraseControlSurface.NONE)
  })

  it('gives every refusal its own code, so a negative assertion names the reason', () => {
    const codes = Object.values(EraseControlSurface)
    expect(new Set(codes).size).toBe(codes.length)
    // Non-zero in `HitRegion`/`PointerOutcome`'s idiom: `if (surface)` must not
    // reject one of them.
    for (const code of codes) expect(code).toBeGreaterThan(0)
  })
})

describe('the control is reachable and its state is visible', () => {
  it('renders itself at construction, so the button exists before the first press', () => {
    const mb = installTelegram('8.0')
    const control = createEraseControl({ host: fakeHost(), createFallback: NO_FALLBACK })
    expect(mb.calls).toContain('onClick')
    expect(mb.calls).toContain('show')
    expect(mb.calls).toContain(`setText:${MAIN_BUTTON_LABEL_OFF}`)
    expect(control.label).toBe(MAIN_BUTTON_LABEL_OFF)
    expect(control.erase).toBe(false)
  })

  it('a press on the NATIVE button toggles the mode — the whole point of the task', () => {
    const mb = installTelegram('8.0')
    const host = fakeHost()
    const control = createEraseControl({ host, createFallback: NO_FALLBACK })
    expect(host.eraseMode).toBe(false)
    mb.press()
    expect(host.eraseMode).toBe(true)
    expect(control.erase).toBe(true)
    mb.press()
    expect(host.eraseMode).toBe(false)
  })

  it('a press on the DOM fallback toggles the mode too', () => {
    const el = fallbackRecorder()
    const host = fakeHost()
    createEraseControl({ host, createFallback: () => el })
    expect(host.eraseMode).toBe(false)
    el.press()
    expect(host.eraseMode).toBe(true)
    el.press()
    expect(host.eraseMode).toBe(false)
  })

  /**
   * **The state must be visible, and "visible" means the label AND the colour.**
   * An erase mode you cannot see you are in is worse than no erase mode: roads
   * vanish under a drag the player thinks is drawing.
   */
  it('changes both the label and the colour on the native button', () => {
    const mb = installTelegram('8.0')
    const control = createEraseControl({ host: fakeHost(), createFallback: NO_FALLBACK })
    const atBoot = mb.calls.join('\n')
    expect(atBoot).toContain(`setText:${MAIN_BUTTON_LABEL_OFF}`)
    expect(atBoot).toContain(ERASE_OFF_BG)
    expect(atBoot).toContain(ERASE_OFF_FG)

    mb.calls.length = 0
    mb.press()
    const pressed = mb.calls.join('\n')
    expect(pressed).toContain(`setText:${MAIN_BUTTON_LABEL_ON}`)
    expect(pressed).toContain(ERASE_ON_BG)
    expect(pressed).toContain(ERASE_ON_FG)
    expect(control.label).toBe(MAIN_BUTTON_LABEL_ON)

    // **The return trip, and it is the half that was missing.** A colour that
    // latches ON survives every assertion above while the label reverts
    // correctly — which is precisely the failure `eraseControl.ts` names as its
    // reason for calling both `setText` and `setParams`: "a button whose colour
    // says erase while its label says draw is worse than either". The comment
    // stated the hazard and nothing could see it.
    mb.calls.length = 0
    mb.press()
    const reverted = mb.calls.join('\n')
    expect(reverted).toContain(`setText:${MAIN_BUTTON_LABEL_OFF}`)
    expect(reverted).toContain(ERASE_OFF_BG)
    expect(reverted).toContain(ERASE_OFF_FG)
    expect(reverted).not.toContain(ERASE_ON_BG)
    expect(control.label).toBe(MAIN_BUTTON_LABEL_OFF)
  })

  it('changes both the label and the colour on the DOM fallback', () => {
    const el = fallbackRecorder()
    const control = createEraseControl({ host: fakeHost(), createFallback: () => el })
    expect(el.textContent).toBe(FALLBACK_LABEL_OFF)
    expect(el.calls.join('\n')).toContain(ERASE_OFF_BG)
    el.calls.length = 0
    el.press()
    expect(el.textContent).toBe(FALLBACK_LABEL_ON)
    expect(el.calls.join('\n')).toContain(ERASE_ON_BG)
    expect(control.label).toBe(FALLBACK_LABEL_ON)

    // The return trip, for the same reason as the native button above: the
    // first version pressed this surface ONCE, so a pill that latched on
    // `ERASING` and stayed red while the pointer drew roads normally passed the
    // whole suite.
    el.calls.length = 0
    el.press()
    expect(el.textContent).toBe(FALLBACK_LABEL_OFF)
    const back = el.calls.join('\n')
    expect(back).toContain(ERASE_OFF_BG)
    expect(back).toContain(ERASE_OFF_FG)
    expect(back).not.toContain(ERASE_ON_BG)
    expect(control.label).toBe(FALLBACK_LABEL_OFF)
  })

  it('the two states are visually distinct — a control that renders the same twice shows nothing', () => {
    expect(MAIN_BUTTON_LABEL_ON).not.toBe(MAIN_BUTTON_LABEL_OFF)
    expect(FALLBACK_LABEL_ON).not.toBe(FALLBACK_LABEL_OFF)
    expect(ERASE_ON_BG).not.toBe(ERASE_OFF_BG)
    // Telegram takes #RRGGBB and silently ignores anything else, which would
    // leave the button in the previous colour — the exact failure this pair is
    // supposed to prevent.
    for (const colour of [ERASE_ON_BG, ERASE_OFF_BG, ERASE_ON_FG, ERASE_OFF_FG]) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('sync() re-renders from the host without toggling anything', () => {
    const mb = installTelegram('8.0')
    const host = fakeHost()
    const control = createEraseControl({ host, createFallback: NO_FALLBACK })
    host.toggleEraseMode()
    // The host changed underneath the control: the label is now stale.
    expect(control.label).toBe(MAIN_BUTTON_LABEL_OFF)
    mb.calls.length = 0
    control.sync()
    expect(control.label).toBe(MAIN_BUTTON_LABEL_ON)
    expect(host.eraseMode).toBe(true)
    expect(mb.calls.join('\n')).toContain(`setText:${MAIN_BUTTON_LABEL_ON}`)
  })

  it('counts its renders, so "it re-rendered" is a count rather than an impression', () => {
    installTelegram('8.0')
    const control = createEraseControl({ host: fakeHost(), createFallback: NO_FALLBACK })
    expect(control.renders).toBe(1)
    control.press()
    expect(control.renders).toBe(2)
    control.sync()
    expect(control.renders).toBe(3)
  })

  it('still toggles the mode when there is no surface at all, so the game is never wedged', () => {
    const host = fakeHost()
    const control = createEraseControl({ host, createFallback: NO_FALLBACK })
    expect(control.surface).toBe(EraseControlSurface.NONE)
    expect(control.press()).toBe(true)
    expect(host.eraseMode).toBe(true)
  })
})

describe('wired to the real PointerInput', () => {
  const camera = fitCamera(
    { cssW: 390, cssH: 844, topInset: 46, bottomInset: 34, rawDpr: 3, performanceClass: null },
    { x0: REVEALED_X0, y0: REVEALED_Y0, cols: REVEALED_W, rows: REVEALED_H },
  )

  function build(): { pointer: ReturnType<typeof createPointerInput>; queue: ReturnType<typeof createInputQueue> } {
    const queue = createInputQueue()
    let paused = false
    const pointer = createPointerInput({
      camera: () => camera,
      canvasLeft: () => 0,
      canvasTop: () => 0,
      gridW: 24,
      queue,
      paused: () => paused,
      setPaused: (next: boolean) => {
        paused = next
      },
      // M1e Task 9. This file is about the erase MODE, which is unreachable
      // once the run ends, so the run never ends here.
      gameOver: () => false,
      restart: () => {
        throw new Error('the erase-control rig has no shutdown; this call means the guard inverted')
      },
    })
    return { pointer, queue }
  }

  const cellX = (gx: number): number => camera.originX + (gx - camera.x0) * camera.tileSize + camera.tileSize / 2
  const cellY = (gy: number): number => camera.originY + (gy - camera.y0) * camera.tileSize + camera.tileSize / 2

  it('makes erase reachable: a press then a drag queues erase actions and no place actions', () => {
    const mb = installTelegram('8.0')
    const { pointer, queue } = build()
    createEraseControl({ host: pointer, createFallback: NO_FALLBACK })

    mb.press()
    pointer.down(1, cellX(REVEALED_X0 + 2), cellY(REVEALED_Y0 + 2))
    pointer.move(1, cellX(REVEALED_X0 + 4), cellY(REVEALED_Y0 + 2))
    expect(queue.length).toBe(2)
    expect(queue.inputs.actions.map((a) => a.kind)).toEqual(['erase', 'erase'])
  })

  it('negative control: without the press the same drag queues place actions', () => {
    installTelegram('8.0')
    const { pointer, queue } = build()
    createEraseControl({ host: pointer, createFallback: NO_FALLBACK })
    pointer.down(1, cellX(REVEALED_X0 + 2), cellY(REVEALED_Y0 + 2))
    pointer.move(1, cellX(REVEALED_X0 + 4), cellY(REVEALED_Y0 + 2))
    expect(queue.length).toBe(2)
    expect(queue.inputs.actions.map((a) => a.kind)).toEqual(['place', 'place'])
  })

  /**
   * **The guarantee that goes with putting the control on native chrome.**
   * `MainButton` sits outside the webview's content area, so a second finger CAN
   * press it mid-stroke — which a DOM button under pointer capture could not. So
   * the button must change immediately (the player pressed it) while the stroke
   * in progress finishes in the mode it started in (never half road, half
   * erasure).
   */
  it('a press mid-stroke changes the button at once and applies from the NEXT stroke', () => {
    const mb = installTelegram('8.0')
    const { pointer, queue } = build()
    const control = createEraseControl({ host: pointer, createFallback: NO_FALLBACK })

    pointer.down(1, cellX(REVEALED_X0 + 2), cellY(REVEALED_Y0 + 2))
    mb.press()

    // Immediately: the button says erase, and the stroke says draw.
    expect(control.label).toBe(MAIN_BUTTON_LABEL_ON)
    expect(pointer.eraseMode).toBe(true)
    expect(pointer.strokeEraseMode).toBe(false)

    pointer.move(1, cellX(REVEALED_X0 + 4), cellY(REVEALED_Y0 + 2))
    expect(queue.length).toBe(2)
    expect(queue.inputs.actions.map((a) => a.kind)).toEqual(['place', 'place'])

    // The next stroke erases.
    pointer.up(1)
    expect(pointer.strokeEraseMode).toBe(true)
    queue.clear()
    pointer.down(1, cellX(REVEALED_X0 + 2), cellY(REVEALED_Y0 + 4))
    pointer.move(1, cellX(REVEALED_X0 + 4), cellY(REVEALED_Y0 + 4))
    expect(queue.length).toBe(2)
    expect(queue.inputs.actions.map((a) => a.kind)).toEqual(['erase', 'erase'])
  })
})

describe('the DOM fallback does not cover the pause control', () => {
  /**
   * The fallback is a pill in the bottom-right corner, which lands over the HUD
   * band. That is deliberate and it is bounded: the band's three columns are
   * clock, score, tiles, the pill sits over the **tiles** readout — inert in M2
   * — and it must never reach the clock, which is the pause control.
   *
   * Derived rather than eyeballed: the clock's right edge is
   * `HUD_PAD_CSS + floor((cssW - 2*HUD_PAD_CSS - 2*HUD_GAP_CSS) / 3)`, the pill's
   * left edge is at worst `cssW - FALLBACK_RIGHT_CSS - FALLBACK_MAX_WIDTH_CSS`,
   * and the two separate above roughly 235 CSS px — below every viewport
   * `fitCamera` is documented for (320 is the narrowest it names).
   */
  it('never overlaps the clock rect on any viewport from 240 to 600 CSS px', () => {
    const rects = createHudRects()
    for (let cssW = 240; cssW <= 600; cssW++) {
      const camera = fitCamera(
        { cssW, cssH: 844, topInset: 46, bottomInset: 34, rawDpr: 2, performanceClass: null },
        { x0: REVEALED_X0, y0: REVEALED_Y0, cols: REVEALED_W, rows: REVEALED_H },
      )
      hudRects(camera, rects)
      const clockRight = rects.clock.x + rects.clock.w
      const pillLeft = cssW - FALLBACK_RIGHT_CSS - FALLBACK_MAX_WIDTH_CSS
      expect(pillLeft, `the fallback reaches the clock at cssW=${cssW}`).toBeGreaterThan(clockRight)
    }
  })

  it('is at least a 44 px touch target, and inset from the edge', () => {
    expect(FALLBACK_MAX_WIDTH_CSS).toBeGreaterThanOrEqual(44)
    expect(FALLBACK_RIGHT_CSS).toBeGreaterThanOrEqual(HUD_PAD_CSS)
  })
})
