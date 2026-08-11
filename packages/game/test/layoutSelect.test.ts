import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FALLBACK_TOKEN, hashParams, launchOptions, layoutToken, prefersFallback } from '../src/main'
import { DEFAULT_LAYOUT_ID, LAYOUT_IDS, layoutFor } from '../src/layouts'
import { startParam } from '../src/telegram'

/**
 * **How a player picks a layout, and why it takes three sources.**
 *
 * A Telegram webview has no address bar, so nothing can be typed into the URL.
 * `prefersFallback` reads `location.search`, which inside Telegram is `''`
 * unless a query was baked into the BotFather Web App URL by hand — so the
 * documented `?fallback=1` recovery hatch is, today, unreachable on a phone.
 * The mechanism here is the one that is not: a `t.me/<bot>/<app>?startapp=demo`
 * link, which the player sends themselves in Saved Messages and taps.
 *
 * **What a token is FOR changed when the default did.** It used to be the only
 * way to reach the demo board; the demo is the default now, so the token's
 * everyday job is the other direction — `?startapp=city` for the shipped
 * starting city. Nothing in this file cares: it resolves a token to a string
 * and `layouts.ts` resolves the string to a board.
 *
 * Telegram delivers that value BOTH as a raw `tgWebAppStartParam` launch
 * parameter in `location.hash` and as `start_param` inside the signed
 * `tgWebAppData` the SDK parses. Reading one and not the other is a silent
 * "the link did nothing" on any client that publishes only the other, so both
 * are read, plus `?layout=` for a plain browser and `pnpm dev`.
 */

function setWebApp(webApp: unknown): void {
  ;(globalThis as Record<string, unknown>).Telegram = { WebApp: webApp }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Telegram
})

// ---------------------------------------------------------------------------
// hashParams — the fragment, which is where Telegram actually writes
// ---------------------------------------------------------------------------

describe('hashParams', () => {
  it('parses a plain fragment', () => {
    expect(hashParams('#tgWebAppStartParam=demo').get('tgWebAppStartParam')).toBe('demo')
    // With or without the leading '#': `location.hash` includes it, a test or a
    // caller passing the body alone must not silently get a key named '#a'.
    expect(hashParams('tgWebAppStartParam=demo').get('tgWebAppStartParam')).toBe('demo')
  })

  it('parses the SDK’s path-prefixed shape, dropping everything before the "?"', () => {
    // `urlParseHashParams` splits the fragment at its FIRST "?", treats the
    // prefix as `_path` and parses only the remainder — so a Web App URL that
    // already carries a path produces `#somepath?tgWebAppData=...`.
    //
    // The fixture puts a DECOY in the prefix, which is what makes the strip
    // observable at all: without it the first `tgWebAppStartParam` wins and the
    // answer is 'wrong'.
    const hash = '#tgWebAppStartParam=wrong?tgWebAppStartParam=demo'
    expect(hashParams(hash).get('tgWebAppStartParam')).toBe('demo')
    // ...and a real-shaped prefix is dropped entirely rather than parsed.
    expect(hashParams('#%2Fapp?tgWebAppStartParam=demo').get('tgWebAppStartParam')).toBe('demo')
  })

  it('finds nothing in an empty or query-only fragment', () => {
    expect(hashParams('').get('tgWebAppStartParam')).toBe(null)
    expect(hashParams('#').get('tgWebAppStartParam')).toBe(null)
    expect(hashParams('#tgWebAppData=x&tgWebAppVersion=8.0').get('tgWebAppStartParam')).toBe(null)
  })

  it('is disjoint from the query string, in both directions', () => {
    // The claim the whole mechanism rests on. Telegram only ever APPENDS a
    // fragment, so a query baked into the Web App URL survives every launch —
    // and a fragment parameter is invisible to the query reader.
    expect(hashParams('#layout=demo').get('layout')).toBe('demo')
    expect(prefersFallback('#fallback=1')).toBe(false)
    // A launch parameter Telegram wrote into the fragment is invisible to the
    // query reader, which is exactly why `?fallback=1` cannot be reached from
    // inside a Telegram webview and `?startapp=` had to exist.
    expect(new URLSearchParams('#tgWebAppStartParam=demo').get('tgWebAppStartParam')).toBe(null)
    expect(layoutToken('#tgWebAppStartParam=demo', '', null)).toBe('demo')
  })
})

// ---------------------------------------------------------------------------
// startParam — the SDK-parsed half of the same value
// ---------------------------------------------------------------------------

describe('startParam', () => {
  it('is null with no Telegram at all — a browser must not crash on the read', () => {
    expect(startParam()).toBe(null)
  })

  it('is null when the client publishes no initDataUnsafe, and when it publishes no start_param', () => {
    setWebApp({})
    expect(startParam()).toBe(null)
    setWebApp({ initDataUnsafe: {} })
    expect(startParam()).toBe(null)
  })

  it('reads the string a ?startapp= link carried', () => {
    setWebApp({ initDataUnsafe: { start_param: 'demo' } })
    expect(startParam()).toBe('demo')
  })

  it('refuses a non-string rather than handing a number to a lookup', () => {
    // `initDataUnsafe` is whatever the client parsed out of a query string, and
    // this is a claim about a remote client, not a local interface.
    setWebApp({ initDataUnsafe: { start_param: 7 } })
    expect(startParam()).toBe(null)
    setWebApp({ initDataUnsafe: { start_param: { toString: () => 'demo' } } })
    expect(startParam()).toBe(null)
    setWebApp({ initDataUnsafe: { start_param: null } })
    expect(startParam()).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// layoutToken — the three sources, their precedence, and the charset
// ---------------------------------------------------------------------------

describe('layoutToken', () => {
  it('is empty for a launch that names nothing — the DEFAULT board', () => {
    // The most important case in the file: this is every player's launch.
    //
    // **It says `''`, not which board that is, and the distinction is the
    // point.** This function's job ends at "was a token supplied"; which entry
    // `''` reaches is `DEFAULT_LAYOUT_ID`'s, and it has now moved twice — city
    // to demo at M1d, demo back to city at M1e Task 10 — without one line here
    // changing either time. `layouts.test.ts` owns that answer, and duplicating
    // it here would be a second place to update and a first place to forget.
    expect(layoutToken('', '', null)).toBe('')
    expect(layoutToken('#tgWebAppData=x&tgWebAppVersion=8.0', '', null)).toBe('')
    expect(layoutToken('', '?fallback=1', null)).toBe('')
  })

  it('reads the hash launch parameter — the in-Telegram path', () => {
    expect(layoutToken('#tgWebAppStartParam=demo&tgWebAppVersion=8.0', '', null)).toBe('demo')
  })

  it('reads the SDK-parsed start_param when the hash does not carry it', () => {
    // The hedge. A client that signs the value into `tgWebAppData` without
    // mirroring it into the fragment would otherwise boot the default board
    // and the link would look broken.
    expect(layoutToken('#tgWebAppData=x', '', 'demo')).toBe('demo')
  })

  it('reads ?layout= — the browser and `pnpm dev` path', () => {
    expect(layoutToken('', '?layout=demo', null)).toBe('demo')
    expect(layoutToken('', '?fallback=1&layout=demo', null)).toBe('demo')
  })

  it('prefers the hash, then initData, then the query — in that order', () => {
    // Three sources need a stated precedence or the answer depends on which
    // client you are on. The hash wins because it is the one that needs no SDK.
    expect(layoutToken('#tgWebAppStartParam=hash', '?layout=query', 'initdata')).toBe('hash')
    expect(layoutToken('', '?layout=query', 'initdata')).toBe('initdata')
    expect(layoutToken('#tgWebAppData=x', '?layout=query', null)).toBe('query')
  })

  it('refuses a value outside Telegram’s startapp charset', () => {
    // **`/^[\w-]{1,512}$/` — the regex `main.ts` actually holds, and this
    // comment said `{0,512}` until the review caught it.** The `{0,` form is
    // not a typo either: it is what Telegram documents for `startapp` and what
    // this repo's own research dossier quotes, so it is exactly the string a
    // reader would copy. `main.ts` narrows the minimum to 1 because an empty
    // parameter is an absent token, which is the next test.
    //
    // **The correction comes with a derivation, because the obvious reading of
    // the discrepancy is wrong.** `{0,512}` looks like it would invert that
    // next test by accepting `''`. It would not: it is a **provably equivalent
    // mutant** of `layoutToken`, because the only string the two bounds
    // disagree about is `''`, and `''` is both the value the `??` chain falls
    // back to *and* the value the charset test's else branch returns.
    // `LAYOUT_TOKEN.test('') ? '' : ''` is `''` either way, and `LAYOUT_TOKEN`
    // has no other reader.
    //
    // So `{1,512}` is kept because it says what the code means, **not** because
    // a test can tell. Measured: the swap scores 0 detectors across the whole
    // suite. Do not manufacture one — the catalogue's rule for an equivalent
    // mutant is to label it, so nobody reads its survival as a coverage hole.
    expect(layoutToken('', '?layout=demo city', null)).toBe('')
    expect(layoutToken('', '?layout=../../etc', null)).toBe('')
    expect(layoutToken('', '?layout=' + encodeURIComponent('a'.repeat(513)), null)).toBe('')
    // ...and the boundary in the other direction: 512 is legal.
    expect(layoutToken('', '?layout=' + 'a'.repeat(512), null)).toBe('a'.repeat(512))
  })

  it('treats an EMPTY parameter as "no token", not as a layout named ""', () => {
    // `?layout=` and `#tgWebAppStartParam=` both parse to `''`, which the
    // charset test rejects — so they land on the default rather than on
    // `layoutFor('')`'s throw. A player who taps a half-copied link gets the
    // default board, which is the right answer for an absent value.
    expect(layoutToken('#tgWebAppStartParam=', '', null)).toBe('')
    expect(layoutToken('', '?layout=', null)).toBe('')
    expect(layoutToken('', '', '')).toBe('')
  })

  it('passes a well-formed but unknown token THROUGH, so layoutFor can refuse it loudly', () => {
    // The vacuity case the whole mechanism turns on. If this function
    // normalised `demoo` to `''`, a mistyped link would silently boot the
    // DEFAULT board and look exactly like the bug the demo layout exists to
    // fix — today that means `?startapp=cty` opening the demo while the reader
    // believes they asked for the starting city.
    expect(layoutToken('', '?layout=demoo', null)).toBe('demoo')
    expect(layoutToken('#tgWebAppStartParam=nonsense', '', null)).toBe('nonsense')
  })

  it('does not confuse `fallback` with `layout` in either direction', () => {
    expect(layoutToken('', '?fallback=demo', null)).toBe('')
    expect(prefersFallback('?layout=1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// launchOptions — the composition, and the one line that wires it to production
// ---------------------------------------------------------------------------

describe('launchOptions', () => {
  it('reads both properties off one URL', () => {
    expect(launchOptions({ hash: '', search: '' }, null)).toEqual({
      preferFallback: false,
      layoutId: '',
    })
    expect(
      launchOptions({ hash: '#tgWebAppStartParam=demo', search: '?fallback=1' }, null),
    ).toEqual({ preferFallback: true, layoutId: 'demo' })
    expect(launchOptions({ hash: '', search: '' }, 'demo')).toEqual({
      preferFallback: false,
      layoutId: 'demo',
    })
  })

  it('keeps the two independent — neither source leaks into the other', () => {
    // `?layout=1` must not force the fallback and `?fallback=demo` must not
    // name a layout; both were checked as separate readers above, and this is
    // the check that the composition did not cross them.
    expect(launchOptions({ hash: '', search: '?layout=1' }, null).preferFallback).toBe(false)
    expect(launchOptions({ hash: '', search: '?fallback=1' }, null).layoutId).toBe('')
  })

  it('?startapp=fallback reaches the flag AND does not reach layoutFor — M1e Task 12', () => {
    // **The recovery hatch, revived.** `?fallback=1` is a QUERY parameter and a
    // Telegram webview has no address bar, so on a phone the hatch was
    // unreachable unless somebody edited the BotFather URL by hand. The
    // fragment is reachable — a `t.me/<bot>/<app>?startapp=fallback` link is a
    // message the player sends themselves and taps.
    expect(launchOptions({ hash: '#tgWebAppStartParam=fallback', search: '' }, null)).toEqual({
      preferFallback: true,
      layoutId: '',
    })
    // The SDK-parsed source too, since a client may sign `start_param` into the
    // payload without mirroring it into the fragment.
    expect(launchOptions({ hash: '', search: '' }, FALLBACK_TOKEN)).toEqual({
      preferFallback: true,
      layoutId: '',
    })
    // And `?layout=fallback`, which is the only one that works under `pnpm dev`.
    expect(launchOptions({ hash: '', search: '?layout=fallback' }, null)).toEqual({
      preferFallback: true,
      layoutId: '',
    })

    // ---------------------------------------------------------------------
    // **THE SECOND HALF, WHICH IS WHAT MAKES IT A HATCH AND NOT A BRICK.**
    // `fallback` is not a layout id. Left in `layoutId` it reaches `layoutFor`,
    // which throws by design and puts the boot-failure panel on the screen —
    // so a player already unable to erase would get a stack trace instead of a
    // pill. A test that only checked `preferFallback` would pass on exactly
    // that build, which is why this assertion is here and why the wiring is
    // two lines rather than the one the brief costed it at.
    // ---------------------------------------------------------------------
    expect(LAYOUT_IDS, 'if this ever becomes a layout id the hatch silently eats it').not.toContain(
      FALLBACK_TOKEN,
    )
    expect(() => layoutFor(FALLBACK_TOKEN), 'which is exactly what the intercept prevents').toThrow()
    expect(() =>
      layoutFor(launchOptions({ hash: '#tgWebAppStartParam=fallback', search: '' }, null).layoutId),
    ).not.toThrow()

    // The hatch does not change the board: it opens whatever a plain link
    // opens. Telegram gives a Mini App one `startapp` string, so a link cannot
    // ask for both — stated in `main.ts` as the trade it is.
    expect(
      layoutFor(launchOptions({ hash: '#tgWebAppStartParam=fallback', search: '' }, null).layoutId).id,
    ).toBe(DEFAULT_LAYOUT_ID)
  })

  it('is actually SPREAD into startGame’s createGame call — the source says so', () => {
    // **A source scan, and it is not decoration: nothing else in the repo can
    // see this line.** `startGame` reads `document` and `location`, so it never
    // executes under vitest; deleting the layout wiring from it was measured at
    // 0 detectors across the whole 1,550-test suite. Extracting `launchOptions`
    // gave the LOGIC a detector (every test above) and left the CALL with none,
    // which is the catalogue's "a driver that never enters a branch makes that
    // branch indistinguishable from dead code" pointed at the production entry
    // point. A scan is the only instrument left, so it is used, and labelled.
    const source = readFileSync(
      fileURLToPath(new URL('../src/main.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('...launchOptions(location, startParam())')
    // Non-vacuity for the scan itself: the string it looks for must not also
    // appear in the definition it is trying to distinguish from the call site.
    expect(source.split('...launchOptions(location, startParam())').length - 1).toBe(1)
  })
})
