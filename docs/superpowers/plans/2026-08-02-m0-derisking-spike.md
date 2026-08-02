# M0 De-Risking Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the two questions that would invalidate the Laneways architecture if guessed wrong — can a low-end Android WebView render our frame budget, and does `localStorage` survive across Telegram sessions on iOS — by measuring both on real hardware.

**Architecture:** A single throwaway Vite + TypeScript page deployed as a Cloudflare Worker with static assets, launched as a Telegram Mini App. It runs three probes (render benchmark, flow-field CPU probe, storage persistence probe), displays results on screen, and POSTs them to a Worker endpoint that logs to `wrangler tail`. All pure logic is unit-tested; the device measurements themselves are manual runs on real phones.

**Tech Stack:** TypeScript, Vite 8, Vitest, Canvas2D (no engine), Cloudflare Workers + Static Assets, Telegram Mini Apps SDK.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md`. Read §6, §8, §9, §10 before starting.
- **All spike code lives under `spike/`.** Nothing in `spike/` is ever imported by production code. It is a separate pnpm project with its own `package.json`.
- **Canvas2D only. Zero rendering dependencies.** No Pixi, Phaser, Excalibur, or Kontra — measuring Canvas2D is the entire point.
- **No cross-origin assets except the Telegram SDK.** `https://telegram.org/js/telegram-web-app.js` must be loaded from Telegram and is the sole permitted exception. Every font, image, and script otherwise is self-hosted. iOS fails *silently* on cross-origin asset errors.
- **`index.html` is served `Cache-Control: no-store, must-revalidate`.** Telegram Desktop caches Mini App bundles where its own cache-clear does not reach.
- **Every `Telegram.WebApp.*` call is version-gated** with `isVersionAtLeast()` and wrapped so it is a no-op when absent. The user's client version, not our deploy, determines availability.
- **Telegram boot order is exact:** `ready()` → `expand()` → `disableVerticalSwipes()` → (8.0+) `requestFullscreen()` + `lockOrientation()` → only then size the canvas.
- **Size against `viewportStableHeight`, never `viewportHeight`.** Plain `100vh` is unreliable inside the webview.
- **HTTPS with a CA-trusted certificate.** Self-signed certs fail on Telegram mobile — no `mkcert`, no `@vitejs/plugin-basic-ssl`. Use `cloudflared tunnel` or a deployed preview Worker.
- Node 26 and pnpm 10 are installed. Run all commands from `spike/` unless stated otherwise.
- Tests are pure — no canvas, no DOM, no network. Anything requiring a real canvas is verified visually on device, not in Vitest.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## File Structure

| File | Responsibility |
|---|---|
| `spike/package.json` | Spike project manifest and scripts |
| `spike/tsconfig.json` | TypeScript config for browser + worker sources |
| `spike/vite.config.ts` | Build config; outputs to `spike/dist` |
| `spike/wrangler.jsonc` | Worker config; serves `dist` as assets |
| `spike/index.html` | Single page; loads Telegram SDK and `src/main.ts` |
| `spike/public/_headers` | `no-store` on `index.html` |
| `spike/worker/index.ts` | Serves assets; `POST /api/result` logs to `wrangler tail` |
| `spike/src/telegram.ts` | Minimal version-gated Telegram adapter + boot sequence |
| `spike/src/deviceInfo.ts` | Platform, DPR, viewport, Android `performanceClass` parsing |
| `spike/src/stats.ts` | Frame-time sample collection and percentiles |
| `spike/src/scene.ts` | Seeded RNG and deterministic moving-sprite scene |
| `spike/src/roadAtlas.ts` | 8-direction bitmask geometry + 256-config atlas builder |
| `spike/src/flowfield.ts` | Dial's-bucket Dijkstra flow field over a grid |
| `spike/src/bench.ts` | Render benchmark driver: config sweep, warmup, measurement |
| `spike/src/storageProbe.ts` | Cross-session `localStorage` persistence probe |
| `spike/src/report.ts` | On-screen results rendering + POST to `/api/result` |
| `spike/src/main.ts` | Entry point; boots Telegram, runs probes, reports |
| `spike/test/*.test.ts` | Vitest unit tests, one per pure module |
| `docs/research/2026-08-02-m0-spike-findings.md` | Final deliverable: measurements and the decisions they force |

The split is by responsibility, not layer: `stats`, `scene`, `roadAtlas`, `flowfield`, and `storageProbe` are pure and independently testable; `telegram`, `bench`, `report`, and `main` touch the browser and are verified on device.

---

## Task 1: Scaffold, Telegram shell, and deploy pipeline

Proves end-to-end reachability before any measurement code exists. Includes the human BotFather steps.

**Files:**
- Create: `spike/package.json`, `spike/tsconfig.json`, `spike/vite.config.ts`, `spike/wrangler.jsonc`, `spike/index.html`, `spike/public/_headers`, `spike/worker/index.ts`, `spike/src/telegram.ts`, `spike/src/main.ts`
- Create: `spike/test/telegram.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `boot(): void` — runs the exact Telegram boot sequence, safe outside Telegram
  - `atLeast(version: string): boolean`
  - `stableHeight(): number` — `viewportStableHeight`, falling back to `window.innerHeight`
  - `platformName(): string` — `tgWebAppPlatform` or `'browser'`
  - `contentSafeAreaTop(): number` — pixels of dead space to reserve at the top

- [ ] **Step 1: Create the project and install dependencies**

```bash
mkdir -p spike/src spike/test spike/worker spike/public
cd spike
pnpm init
pnpm add -D typescript vite@^8.2.0 vitest wrangler
pnpm exec tsc --version && pnpm exec vite --version && pnpm exec wrangler --version
```

Record the resolved versions — Vite must be 8.2.x or newer.

- [ ] **Step 2: Write the config files**

`spike/package.json` — replace the generated `scripts` block with:

```json
{
  "name": "laneways-spike",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "deploy": "vite build && wrangler deploy",
    "tail": "wrangler tail --format pretty"
  }
}
```

`spike/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "worker", "vite.config.ts"]
}
```

`spike/vite.config.ts`:

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
})
```

`spike/wrangler.jsonc`:

```jsonc
{
  "name": "laneways-spike",
  "main": "worker/index.ts",
  "compatibility_date": "2026-08-02",
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS"
  },
  "observability": {
    "enabled": true
  }
}
```

`spike/public/_headers`:

```
/index.html
  Cache-Control: no-store, must-revalidate
```

`spike/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />
    <title>Laneways M0</title>
    <script src="https://telegram.org/js/telegram-web-app.js?63"></script>
    <style>
      :root { color-scheme: light dark; }
      html, body {
        margin: 0;
        padding: 0;
        height: var(--tg-viewport-stable-height, 100vh);
        overflow: hidden;
        background: #14161a;
        color: #e8eaed;
        font: 13px/1.45 -apple-system, system-ui, Roboto, sans-serif;
        font-variant-numeric: tabular-nums;
      }
      #app { padding: 12px; height: 100%; overflow-y: auto; overscroll-behavior: contain; }
      canvas { display: block; touch-action: none; }
      pre { white-space: pre-wrap; word-break: break-all; font-size: 11px; }
    </style>
  </head>
  <body>
    <div id="app">booting…</div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Write the failing test for the Telegram adapter**

`spike/test/telegram.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/telegram`.

- [ ] **Step 5: Implement the Telegram adapter**

`spike/src/telegram.ts`:

```ts
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test`
Expected: PASS, 8 tests.

- [ ] **Step 7: Write the Worker and entry point**

`spike/worker/index.ts`:

```ts
interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/api/result' && req.method === 'POST') {
      const body = await req.text()
      // Surfaces in `pnpm tail` while a phone runs the spike.
      console.log('M0-RESULT', body)
      return new Response('ok', {
        status: 200,
        headers: { 'cache-control': 'no-store' },
      })
    }
    return env.ASSETS.fetch(req)
  },
}
```

`spike/src/main.ts` (placeholder for this task; later tasks replace the body):

```ts
import { boot, platformName, clientVersion, stableHeight, contentSafeAreaTop } from './telegram'

boot()

const app = document.getElementById('app')
if (app) {
  app.textContent = JSON.stringify(
    {
      platform: platformName(),
      version: clientVersion(),
      stableHeight: stableHeight(),
      contentSafeAreaTop: contentSafeAreaTop(),
      dpr: window.devicePixelRatio,
      ua: navigator.userAgent,
    },
    null,
    2,
  )
}
```

- [ ] **Step 8: Typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: no errors; `spike/dist/index.html` and a hashed JS asset exist.

- [ ] **Step 9: HUMAN — create the Telegram bot and Mini App**

These are interactive and cannot be automated.

1. In Telegram, message `@BotFather` → `/newbot` → follow prompts. Save the bot token somewhere safe; it is **not** needed for M0 (no auth yet) but is needed from M3.
2. `/newapp` → select the bot → provide a title, short description, a 640×360 image, and the short name `m0`.
3. When asked for the Web App URL, enter the Worker URL from Step 10. You will need to run Step 10 first and then return here — `/newapp` can be re-run, or the URL edited via `/myapps`.

- [ ] **Step 10: HUMAN — authenticate wrangler, then deploy**

```bash
pnpm exec wrangler login    # opens a browser; one time
pnpm deploy
```

Note the printed `https://laneways-spike.<subdomain>.workers.dev` URL and give it to BotFather in Step 9.

- [ ] **Step 11: Verify end to end on a phone**

Open `t.me/<your-bot>/m0` on an Android phone and on an iPhone. Expected: a JSON blob showing a non-`browser` platform, a client version, a plausible stable height, and the full user-agent string.

**Capture the raw `ua` value from the Android device verbatim** — Task 2's parser is written against a guess and must be corrected against reality.

Also confirm: the page opens full-height without a visible reflow, and vertical swiping inside the page does not dismiss the app.

- [ ] **Step 12: Commit**

```bash
cd .. && git add spike docs && git commit -m "spike(m0): scaffold, telegram shell, and cloudflare deploy pipeline"
```

---

## Task 2: Device info and result reporting

**Files:**
- Create: `spike/src/deviceInfo.ts`, `spike/src/report.ts`
- Create: `spike/test/deviceInfo.test.ts`
- Modify: `spike/src/main.ts`

**Interfaces:**
- Consumes: `platformName()`, `clientVersion()`, `stableHeight()`, `contentSafeAreaTop()` from `src/telegram.ts`
- Produces:
  - `performanceClass(ua: string): 'LOW' | 'AVERAGE' | 'HIGH' | null`
  - `collectDeviceInfo(): DeviceInfo`
  - `interface DeviceInfo { platform: string; clientVersion: string; performanceClass: 'LOW'|'AVERAGE'|'HIGH'|null; dpr: number; viewportW: number; viewportH: number; contentSafeAreaTop: number; hardwareConcurrency: number; ua: string }`
  - `show(title: string, data: unknown): void` — appends a titled JSON block to the page
  - `submit(payload: unknown): Promise<boolean>` — POSTs to `/api/result`, never throws

- [ ] **Step 1: Write the failing test**

`spike/test/deviceInfo.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test deviceInfo`
Expected: FAIL — cannot resolve `../src/deviceInfo`.

- [ ] **Step 3: Implement device info**

`spike/src/deviceInfo.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test deviceInfo`
Expected: PASS, 6 tests.

- [ ] **Step 5: Implement reporting**

`spike/src/report.ts`:

```ts
export function show(title: string, data: unknown): void {
  const app = document.getElementById('app')
  if (!app) return
  const h = document.createElement('div')
  h.textContent = title
  h.style.cssText = 'margin:12px 0 4px;font-weight:600;color:#8ab4f8'
  const pre = document.createElement('pre')
  pre.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  app.append(h, pre)
}

export function status(text: string): void {
  const app = document.getElementById('app')
  if (app && app.textContent === 'booting…') app.textContent = ''
  show('status', text)
}

/** Never throws. Returns whether the POST succeeded. */
export async function submit(payload: unknown): Promise<boolean> {
  try {
    const res = await fetch('/api/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return res.ok
  } catch {
    return false
  }
}
```

- [ ] **Step 6: Wire it into main and verify on device**

Replace `spike/src/main.ts` with:

```ts
import { boot } from './telegram'
import { collectDeviceInfo } from './deviceInfo'
import { show, submit } from './report'

boot()

const app = document.getElementById('app')
if (app) app.textContent = ''

const device = collectDeviceInfo()
show('device', device)
void submit({ kind: 'device', device })
```

Run `pnpm deploy`, then in a second terminal `pnpm tail`, then open the Mini App on Android.
Expected: `M0-RESULT {"kind":"device",...}` appears in the tail output within a second or two.

**If `performanceClass` is `null` on the Android device**, correct the regex against the captured UA and re-run the test suite before continuing.

- [ ] **Step 7: Commit**

```bash
cd .. && git add spike && git commit -m "spike(m0): device info collection and result reporting"
```

---

## Task 3: Frame-time statistics

**Files:**
- Create: `spike/src/stats.ts`
- Create: `spike/test/stats.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Stats { count: number; mean: number; p50: number; p95: number; p99: number; max: number }`
  - `percentiles(samples: readonly number[]): Stats`
  - `class Sampler { constructor(capacity: number); push(v: number): void; get length(): number; stats(): Stats; reset(): void }`

Averages hide jank, which is exactly what we are hunting. Everything downstream reports percentiles.

- [ ] **Step 1: Write the failing test**

`spike/test/stats.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { percentiles, Sampler } from '../src/stats'

const ONE_TO_100 = Array.from({ length: 100 }, (_, i) => i + 1)

describe('percentiles', () => {
  it('throws on an empty sample set', () => {
    expect(() => percentiles([])).toThrow()
  })

  it('handles a single sample', () => {
    const s = percentiles([7])
    expect(s).toEqual({ count: 1, mean: 7, p50: 7, p95: 7, p99: 7, max: 7 })
  })

  it('computes nearest-rank percentiles over 1..100', () => {
    const s = percentiles(ONE_TO_100)
    expect(s.count).toBe(100)
    expect(s.mean).toBeCloseTo(50.5, 10)
    expect(s.p50).toBe(51)
    expect(s.p95).toBe(96)
    expect(s.p99).toBe(100)
    expect(s.max).toBe(100)
  })

  it('is order independent', () => {
    const shuffled = [...ONE_TO_100].reverse()
    expect(percentiles(shuffled)).toEqual(percentiles(ONE_TO_100))
  })

  it('sorts numerically, not lexicographically', () => {
    // Array.prototype.sort would order these as 10, 2, 9.
    const s = percentiles([9, 10, 2])
    expect(s.max).toBe(10)
    expect(s.p50).toBe(9)
  })

  it('does not mutate the input', () => {
    const input = [3, 1, 2]
    percentiles(input)
    expect(input).toEqual([3, 1, 2])
  })
})

describe('Sampler', () => {
  it('starts empty and rejects stats with no samples', () => {
    const s = new Sampler(4)
    expect(s.length).toBe(0)
    expect(() => s.stats()).toThrow()
  })

  it('accumulates up to capacity and then stops growing', () => {
    const s = new Sampler(3)
    s.push(1); s.push(2); s.push(3); s.push(4)
    expect(s.length).toBe(3)
    expect(s.stats().max).toBe(3)
  })

  it('reset clears accumulated samples', () => {
    const s = new Sampler(4)
    s.push(1)
    s.reset()
    expect(s.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test stats`
Expected: FAIL — cannot resolve `../src/stats`.

- [ ] **Step 3: Implement**

`spike/src/stats.ts`:

```ts
export interface Stats {
  count: number
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
}

/**
 * Nearest-rank percentiles. Uses Float64Array.sort, which is numeric —
 * Array.prototype.sort defaults to lexicographic and would be wrong here.
 */
export function percentiles(samples: readonly number[]): Stats {
  if (samples.length === 0) throw new Error('percentiles: no samples')
  const sorted = Float64Array.from(samples)
  sorted.sort()
  const n = sorted.length
  const at = (q: number): number => sorted[Math.min(n - 1, Math.floor(q * n))] as number
  let sum = 0
  for (let i = 0; i < n; i++) sum += sorted[i] as number
  return {
    count: n,
    mean: sum / n,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[n - 1] as number,
  }
}

/** Fixed-capacity sample buffer. Allocates once; never grows during measurement. */
export class Sampler {
  private readonly buf: Float64Array
  private n = 0

  constructor(capacity: number) {
    this.buf = new Float64Array(capacity)
  }

  push(v: number): void {
    if (this.n < this.buf.length) this.buf[this.n++] = v
  }

  get length(): number {
    return this.n
  }

  reset(): void {
    this.n = 0
  }

  stats(): Stats {
    return percentiles(Array.from(this.buf.subarray(0, this.n)))
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test stats`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cd .. && git add spike && git commit -m "spike(m0): frame-time percentile statistics"
```

---

## Task 4: Deterministic scene and road atlas geometry

**Files:**
- Create: `spike/src/scene.ts`, `spike/src/roadAtlas.ts`
- Create: `spike/test/scene.test.ts`, `spike/test/roadAtlas.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `mulberry32(seed: number): () => number`
  - `interface Sprite { x: number; y: number; vx: number; vy: number; group: number }`
  - `makeScene(count: number, w: number, h: number, seed: number): Sprite[]`
  - `advance(sprites: Sprite[], dt: number, w: number, h: number): void`
  - `DIRS: readonly (readonly [number, number])[]` — 8 unit vectors, index 0 = N, clockwise
  - `dirsOf(mask: number): readonly (readonly [number, number])[]`
  - `randomRoadMasks(cells: number, seed: number): Uint8Array`
  - `buildRoadAtlas(tilePx: number, dpr: number, road: string): HTMLCanvasElement[]` — 256 entries, index = bitmask

The sprite count sweep must be reproducible across devices, so the scene is seeded rather than random.

- [ ] **Step 1: Write the failing tests**

`spike/test/scene.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mulberry32, makeScene, advance } from '../src/scene'

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('differs across seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })

  it('stays within [0, 1)', () => {
    const r = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('makeScene', () => {
  it('produces the requested number of sprites', () => {
    expect(makeScene(400, 300, 600, 1)).toHaveLength(400)
  })

  it('is reproducible for a given seed', () => {
    expect(makeScene(10, 300, 600, 99)).toEqual(makeScene(10, 300, 600, 99))
  })

  it('places every sprite inside the bounds', () => {
    for (const s of makeScene(200, 300, 600, 5)) {
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(300)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThanOrEqual(600)
      expect(s.group).toBeGreaterThanOrEqual(0)
      expect(s.group).toBeLessThan(5)
    }
  })
})

describe('advance', () => {
  it('moves a sprite by velocity times dt', () => {
    const s = [{ x: 10, y: 10, vx: 100, vy: 0, group: 0 }]
    advance(s, 0.1, 300, 600)
    expect(s[0]!.x).toBeCloseTo(20, 10)
  })

  it('reflects off the left wall and keeps the sprite in bounds', () => {
    const s = [{ x: 1, y: 10, vx: -100, vy: 0, group: 0 }]
    advance(s, 0.1, 300, 600)
    expect(s[0]!.x).toBe(0)
    expect(s[0]!.vx).toBe(100)
  })

  it('reflects off the bottom wall', () => {
    const s = [{ x: 10, y: 599, vx: 0, vy: 100, group: 0 }]
    advance(s, 0.1, 300, 600)
    expect(s[0]!.y).toBe(600)
    expect(s[0]!.vy).toBe(-100)
  })

  it('keeps all sprites in bounds over many steps', () => {
    const s = makeScene(100, 300, 600, 3)
    for (let i = 0; i < 500; i++) advance(s, 1 / 60, 300, 600)
    for (const sp of s) {
      expect(sp.x).toBeGreaterThanOrEqual(0)
      expect(sp.x).toBeLessThanOrEqual(300)
      expect(sp.y).toBeGreaterThanOrEqual(0)
      expect(sp.y).toBeLessThanOrEqual(600)
    }
  })
})
```

`spike/test/roadAtlas.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DIRS, dirsOf, randomRoadMasks } from '../src/roadAtlas'

describe('DIRS', () => {
  it('has 8 unit directions starting at north, going clockwise', () => {
    expect(DIRS).toHaveLength(8)
    expect(DIRS[0]).toEqual([0, -1])
    expect(DIRS[2]).toEqual([1, 0])
    expect(DIRS[4]).toEqual([0, 1])
    expect(DIRS[6]).toEqual([-1, 0])
  })

  it('contains only unit components', () => {
    for (const [dx, dy] of DIRS) {
      expect(Math.abs(dx)).toBeLessThanOrEqual(1)
      expect(Math.abs(dy)).toBeLessThanOrEqual(1)
      expect(dx === 0 && dy === 0).toBe(false)
    }
  })
})

describe('dirsOf', () => {
  it('returns nothing for an empty mask', () => {
    expect(dirsOf(0)).toHaveLength(0)
  })

  it('returns all 8 for a full mask', () => {
    expect(dirsOf(0xff)).toHaveLength(8)
  })

  it('returns north only for bit 0', () => {
    expect(dirsOf(0b0000_0001)).toEqual([[0, -1]])
  })

  it('returns east and west for a straight horizontal tile', () => {
    expect(dirsOf(0b0100_0100)).toEqual([[1, 0], [-1, 0]])
  })

  it('has popcount(mask) entries for every one of the 256 masks', () => {
    for (let m = 0; m < 256; m++) {
      let bits = 0
      for (let b = 0; b < 8; b++) if (m & (1 << b)) bits++
      expect(dirsOf(m)).toHaveLength(bits)
    }
  })
})

describe('randomRoadMasks', () => {
  it('returns one byte per cell', () => {
    expect(randomRoadMasks(960, 1)).toHaveLength(960)
  })

  it('is reproducible for a given seed', () => {
    expect(Array.from(randomRoadMasks(50, 4))).toEqual(Array.from(randomRoadMasks(50, 4)))
  })

  it('produces at least some non-empty tiles', () => {
    const masks = randomRoadMasks(500, 8)
    expect(masks.some((m) => m !== 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test scene roadAtlas`
Expected: FAIL — cannot resolve `../src/scene` and `../src/roadAtlas`.

- [ ] **Step 3: Implement the scene**

`spike/src/scene.ts`:

```ts
export interface Sprite {
  x: number
  y: number
  vx: number
  vy: number
  group: number
}

export const GROUP_COUNT = 5

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    let t = (s += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeScene(count: number, w: number, h: number, seed: number): Sprite[] {
  const rnd = mulberry32(seed)
  const out: Sprite[] = new Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = {
      x: rnd() * w,
      y: rnd() * h,
      vx: (rnd() - 0.5) * 120,
      vy: (rnd() - 0.5) * 120,
      group: Math.floor(rnd() * GROUP_COUNT),
    }
  }
  return out
}

export function advance(sprites: Sprite[], dt: number, w: number, h: number): void {
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i] as Sprite
    s.x += s.vx * dt
    s.y += s.vy * dt
    if (s.x < 0) { s.x = 0; s.vx = -s.vx }
    else if (s.x > w) { s.x = w; s.vx = -s.vx }
    if (s.y < 0) { s.y = 0; s.vy = -s.vy }
    else if (s.y > h) { s.y = h; s.vy = -s.vy }
  }
}
```

- [ ] **Step 4: Implement the road atlas**

`spike/src/roadAtlas.ts`:

```ts
import { mulberry32 } from './scene'

/** 8 directions, index 0 = N, clockwise. Bit i of a tile mask means "road toward DIRS[i]". */
export const DIRS = [
  [0, -1],  // 0 N
  [1, -1],  // 1 NE
  [1, 0],   // 2 E
  [1, 1],   // 3 SE
  [0, 1],   // 4 S
  [-1, 1],  // 5 SW
  [-1, 0],  // 6 W
  [-1, -1], // 7 NW
] as const

export function dirsOf(mask: number): readonly (readonly [number, number])[] {
  const out: (readonly [number, number])[] = []
  for (let i = 0; i < 8; i++) if (mask & (1 << i)) out.push(DIRS[i] as readonly [number, number])
  return out
}

/** Plausible-looking road coverage for the benchmark. Not a real city. */
export function randomRoadMasks(cells: number, seed: number): Uint8Array {
  const rnd = mulberry32(seed)
  const out = new Uint8Array(cells)
  for (let i = 0; i < cells; i++) {
    // ~45% of cells carry road; those that do get 2-3 directions.
    if (rnd() < 0.45) {
      let m = 0
      const n = 2 + (rnd() < 0.4 ? 1 : 0)
      for (let k = 0; k < n; k++) m |= 1 << Math.floor(rnd() * 8)
      out[i] = m
    }
  }
  return out
}

/**
 * Pre-renders all 256 direction configurations once, at device pixel ratio.
 * This is the whole point: per-frame road drawing becomes drawImage, and the
 * joins are correct by construction rather than by stroke luck.
 */
export function buildRoadAtlas(tilePx: number, dpr: number, road: string): HTMLCanvasElement[] {
  const px = Math.round(tilePx * dpr)
  const atlas: HTMLCanvasElement[] = new Array(256)
  for (let mask = 0; mask < 256; mask++) {
    const c = document.createElement('canvas')
    c.width = px
    c.height = px
    const g = c.getContext('2d')
    if (g) {
      g.scale(dpr, dpr)
      g.strokeStyle = road
      g.lineWidth = tilePx * 0.6
      g.lineCap = 'round'
      g.lineJoin = 'round'
      const half = tilePx / 2
      const dirs = dirsOf(mask)
      if (dirs.length > 0) {
        g.beginPath()
        for (const [dx, dy] of dirs) {
          g.moveTo(half, half)
          g.lineTo(half + dx * half, half + dy * half)
        }
        g.stroke()
      }
    }
    atlas[mask] = c
  }
  return atlas
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test scene roadAtlas`
Expected: PASS, 20 tests.

- [ ] **Step 6: Commit**

```bash
cd .. && git add spike && git commit -m "spike(m0): deterministic sprite scene and 256-config road atlas"
```

---

## Task 5: Render benchmark

**Files:**
- Create: `spike/src/bench.ts`
- Modify: `spike/src/main.ts`

**Interfaces:**
- Consumes: `Sampler` and `Stats` from `src/stats.ts`; `makeScene`, `advance`, `Sprite` from `src/scene.ts`; `buildRoadAtlas`, `randomRoadMasks` from `src/roadAtlas.ts`; `show`, `submit` from `src/report.ts`
- Produces:
  - `interface BenchConfig { sprites: number; baked: boolean }`
  - `interface BenchResult { sprites: number; baked: boolean; dpr: number; cssW: number; cssH: number; tilePx: number; frame: Stats; draw: Stats }`
  - `runBenchSuite(canvas: HTMLCanvasElement, onProgress: (msg: string) => void): Promise<BenchResult[]>`

The sweep is 100 / 200 / 400 / 800 sprites × baked / unbaked road layer. 800 is included deliberately to find the knee, not because we need it.

**Why both baked and unbaked:** the spec claims baking the road network to an offscreen canvas drops per-frame draws from ~1,500 to ~300. If that claim is wrong on real hardware, the renderer design changes. Measure it, do not assume it.

- [ ] **Step 1: Implement the benchmark**

There is no unit test for this task — it is a measurement harness whose only correctness criterion is that it produces numbers on a device. Its pure dependencies (`stats`, `scene`, `roadAtlas`) are already covered by Tasks 3 and 4.

`spike/src/bench.ts`:

```ts
import { Sampler, type Stats } from './stats'
import { makeScene, advance, type Sprite } from './scene'
import { buildRoadAtlas, randomRoadMasks } from './roadAtlas'

export interface BenchConfig {
  sprites: number
  baked: boolean
}

export interface BenchResult {
  sprites: number
  baked: boolean
  dpr: number
  cssW: number
  cssH: number
  tilePx: number
  frame: Stats
  draw: Stats
}

const CONFIGS: readonly BenchConfig[] = [
  { sprites: 100, baked: true },
  { sprites: 200, baked: true },
  { sprites: 400, baked: true },
  { sprites: 800, baked: true },
  { sprites: 400, baked: false },
]

const GRID_W = 24
const GRID_H = 40
const WARMUP_FRAMES = 30
const MEASURE_FRAMES = 180
const SPRITE_COLORS = ['#f2b544', '#e5544f', '#54b8e5', '#4a6fa8', '#5cc47f']

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

export async function runBenchSuite(
  canvas: HTMLCanvasElement,
  onProgress: (msg: string) => void,
): Promise<BenchResult[]> {
  // Let layout settle before reading clientWidth/Height. Reading them on the
  // same frame the canvas was appended can yield 0 and silently benchmark a
  // zero-area surface, which looks like excellent performance.
  await nextFrame()

  const dpr = window.devicePixelRatio || 1
  const cssW = canvas.clientWidth
  const cssH = canvas.clientHeight
  if (cssW < 1 || cssH < 1) throw new Error(`bench: canvas has no area (${cssW}x${cssH})`)
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)

  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('bench: no 2d context')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const tilePx = Math.floor(Math.min(cssW / GRID_W, cssH / GRID_H))
  const masks = randomRoadMasks(GRID_W * GRID_H, 1234)
  const atlas = buildRoadAtlas(tilePx, dpr, '#f4f2ee')

  // The baked layer: the whole road network drawn once into an offscreen canvas.
  const baked = document.createElement('canvas')
  baked.width = canvas.width
  baked.height = canvas.height
  const bctx = baked.getContext('2d')
  if (bctx) {
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawRoads(bctx, atlas, masks, tilePx)
  }

  const results: BenchResult[] = []

  for (const cfg of CONFIGS) {
    onProgress(`bench ${cfg.sprites} sprites, roads ${cfg.baked ? 'baked' : 'per-frame'}…`)
    const sprites = makeScene(cfg.sprites, cssW, cssH, 2024)
    const frame = new Sampler(MEASURE_FRAMES)
    const draw = new Sampler(MEASURE_FRAMES)

    let prev = await nextFrame()
    for (let i = 0; i < WARMUP_FRAMES + MEASURE_FRAMES; i++) {
      const now = await nextFrame()
      const dt = Math.min(0.25, (now - prev) / 1000)
      prev = now

      advance(sprites, dt, cssW, cssH)

      const t0 = performance.now()
      ctx.fillStyle = '#e9e4dc'
      ctx.fillRect(0, 0, cssW, cssH)
      if (cfg.baked) {
        ctx.drawImage(baked, 0, 0, cssW, cssH)
      } else {
        drawRoads(ctx, atlas, masks, tilePx)
      }
      drawSprites(ctx, sprites, tilePx)
      const t1 = performance.now()

      if (i >= WARMUP_FRAMES) {
        draw.push(t1 - t0)
        frame.push(dt * 1000)
      }
    }

    results.push({
      sprites: cfg.sprites,
      baked: cfg.baked,
      dpr,
      cssW,
      cssH,
      tilePx,
      frame: frame.stats(),
      draw: draw.stats(),
    })
  }

  return results
}

function drawRoads(
  ctx: CanvasRenderingContext2D,
  atlas: readonly HTMLCanvasElement[],
  masks: Uint8Array,
  tilePx: number,
): void {
  for (let i = 0; i < masks.length; i++) {
    const m = masks[i] as number
    if (m === 0) continue
    const x = (i % GRID_W) * tilePx
    const y = ((i / GRID_W) | 0) * tilePx
    ctx.drawImage(atlas[m] as HTMLCanvasElement, x, y, tilePx, tilePx)
  }
}

function drawSprites(ctx: CanvasRenderingContext2D, sprites: readonly Sprite[], tilePx: number): void {
  const r = Math.max(3, tilePx * 0.3)
  // One composited shadow layer would go here in production; the spike draws
  // sprites only, so the measured cost is a lower bound on the real renderer.
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i] as Sprite
    ctx.fillStyle = SPRITE_COLORS[s.group] as string
    ctx.beginPath()
    ctx.roundRect(s.x - r, s.y - r, r * 2, r * 2, r * 0.35)
    ctx.fill()
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

If `roundRect` is flagged as missing, the `lib` target is too old — confirm `tsconfig.json` lists `"DOM"` and TypeScript is 5.9+.

- [ ] **Step 3: Wire the benchmark into main**

Replace `spike/src/main.ts` with:

```ts
import { boot, stableHeight, contentSafeAreaTop } from './telegram'
import { collectDeviceInfo } from './deviceInfo'
import { show, status, submit } from './report'
import { runBenchSuite } from './bench'

boot()

const app = document.getElementById('app')
if (app) app.textContent = ''

const device = collectDeviceInfo()
show('device', device)

const canvas = document.createElement('canvas')
// Reserve the top band: Telegram's header stays drag-to-dismiss and its close
// button floats over the top-right in fullscreen. No content may live there.
const top = Math.max(contentSafeAreaTop(), 8)
canvas.style.cssText = `width:100%;height:${Math.round(stableHeight() * 0.55)}px;margin-top:${top}px;border-radius:8px`
document.getElementById('app')?.append(canvas)

void (async () => {
  try {
    const results = await runBenchSuite(canvas, status)
    show('bench', results)
    const ok = await submit({ kind: 'bench', device, results })
    show('submit', ok ? 'sent' : 'FAILED — screenshot the bench block above')
  } catch (err) {
    show('bench ERROR', String(err))
  }
})()
```

- [ ] **Step 4: Verify locally, then on device**

```bash
pnpm dev        # open in a desktop browser first — catches errors fast
pnpm deploy
pnpm tail       # second terminal
```

Open the Mini App on the Android device and on the iPhone. Expected: five result blocks, each with `frame` and `draw` percentiles, and `submit: sent`.

Sanity checks before trusting the numbers:
- `dpr` is greater than 1 on a real phone. If it reads 1, the canvas is not being sized at device resolution and every number is optimistic.
- `draw.p50` for the baked configs is meaningfully lower than for the unbaked 400-sprite config. If not, the baking claim in the spec is wrong and that is itself a finding.
- `frame.p50` near 16.7 ms means the loop is vsync-bound and has headroom; well above it means we are the bottleneck.

- [ ] **Step 5: Commit**

```bash
cd .. && git add spike && git commit -m "spike(m0): canvas2d render benchmark with baked-layer comparison"
```

---

## Task 6: Flow-field CPU probe

**Files:**
- Create: `spike/src/flowfield.ts`
- Create: `spike/test/flowfield.test.ts`
- Modify: `spike/src/main.ts`

**Interfaces:**
- Consumes: `Sampler`, `Stats` from `src/stats.ts`
- Produces:
  - `ORTHO_COST = 10`, `DIAG_COST = 14`, `INF = 0x7fffffff`
  - `interface FlowField { dist: Int32Array; dir: Int8Array }`
  - `interface FlowScratch { bucketHead: Int32Array; entryCell: Int32Array; entryNext: Int32Array }`
  - `createFlowField(cells: number): FlowField`
  - `createFlowScratch(cells: number): FlowScratch`
  - `computeFlowField(w: number, h: number, passable: Uint8Array, sources: readonly number[], out: FlowField, scratch: FlowScratch): void`
  - `probeFlowFields(iterations: number): Stats`

The spec's tick-rate decision rests on this. Desktop measured ~30 µs per field; five colours at 30 Hz is negligible there. On a low-end Android WebView it could be 10–20× slower, and that is the difference between 30 Hz and 60 Hz being viable.

**Implementation note that matters:** the bucket queue uses an **entry pool**, not a per-cell `next` pointer. A cell's distance can improve while it is still linked into a higher bucket; overwriting a per-cell pointer would corrupt that bucket's list. Allocating a fresh entry per insertion and skipping stale entries on drain avoids this. Capacity is `cells * 9` — at most 8 relaxations per cell plus one source insertion.

- [ ] **Step 1: Write the failing test**

`spike/test/flowfield.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  ORTHO_COST, DIAG_COST, INF,
  createFlowField, createFlowScratch, computeFlowField,
} from '../src/flowfield'

function run(w: number, h: number, blocked: readonly number[], sources: readonly number[]) {
  const cells = w * h
  const passable = new Uint8Array(cells).fill(1)
  for (const b of blocked) passable[b] = 0
  const field = createFlowField(cells)
  const scratch = createFlowScratch(cells)
  computeFlowField(w, h, passable, sources, field, scratch)
  return field
}

describe('computeFlowField', () => {
  it('gives distance 0 at the source', () => {
    const f = run(3, 3, [], [4])
    expect(f.dist[4]).toBe(0)
  })

  it('costs 10 orthogonally and 14 diagonally from a centre source', () => {
    const f = run(3, 3, [], [4])
    // 0 1 2
    // 3 4 5
    // 6 7 8
    expect(f.dist[1]).toBe(ORTHO_COST)
    expect(f.dist[3]).toBe(ORTHO_COST)
    expect(f.dist[5]).toBe(ORTHO_COST)
    expect(f.dist[7]).toBe(ORTHO_COST)
    expect(f.dist[0]).toBe(DIAG_COST)
    expect(f.dist[2]).toBe(DIAG_COST)
    expect(f.dist[6]).toBe(DIAG_COST)
    expect(f.dist[8]).toBe(DIAG_COST)
  })

  it('leaves unreachable cells at INF', () => {
    // 1x3 row with the middle blocked: cell 2 is unreachable from cell 0.
    const f = run(3, 1, [1], [0])
    expect(f.dist[0]).toBe(0)
    expect(f.dist[1]).toBe(INF)
    expect(f.dist[2]).toBe(INF)
  })

  it('routes around an obstacle rather than through it', () => {
    // 3x3, block the centre (1,1). Distance from 3=(0,1) to 5=(2,1).
    // Shortest legal route is 3=(0,1) -> 1=(1,0) -> 5=(2,1): two diagonals, 28.
    const f = run(3, 3, [4], [3])
    expect(f.dist[4]).toBe(INF)
    expect(f.dist[5]).toBe(2 * DIAG_COST)
  })

  it('permits corner-cutting past a blocked diagonal neighbour', () => {
    // Documents a deliberate choice: a diagonal step is legal even when the
    // two orthogonal cells flanking it are blocked. Real roads are explicit
    // graph edges, so this never arises in the production sim, but the probe
    // grid would silently measure a different workload if this changed.
    const f = run(3, 3, [1, 3], [0])
    expect(f.dist[4]).toBe(DIAG_COST)
  })

  it('takes the minimum over multiple sources', () => {
    const f = run(5, 1, [], [0, 4])
    expect(f.dist[0]).toBe(0)
    expect(f.dist[1]).toBe(ORTHO_COST)
    expect(f.dist[2]).toBe(2 * ORTHO_COST)
    expect(f.dist[3]).toBe(ORTHO_COST)
    expect(f.dist[4]).toBe(0)
  })

  it('prefers a diagonal over two orthogonals', () => {
    // Straight-line distance from 0 to 8 on a 3x3 is two diagonals = 28,
    // never four orthogonals = 40.
    const f = run(3, 3, [], [0])
    expect(f.dist[8]).toBe(2 * DIAG_COST)
  })

  it('sets dir to -1 at sources and to a valid direction elsewhere', () => {
    const f = run(3, 3, [], [4])
    expect(f.dir[4]).toBe(-1)
    for (const c of [0, 1, 2, 3, 5, 6, 7, 8]) {
      expect(f.dir[c]).toBeGreaterThanOrEqual(0)
      expect(f.dir[c]).toBeLessThan(8)
    }
  })

  it('ignores impassable sources', () => {
    const f = run(3, 1, [0], [0])
    expect(f.dist[0]).toBe(INF)
  })

  it('is reusable — a second run overwrites the first', () => {
    const cells = 9
    const passable = new Uint8Array(cells).fill(1)
    const field = createFlowField(cells)
    const scratch = createFlowScratch(cells)
    computeFlowField(3, 3, passable, [0], field, scratch)
    expect(field.dist[8]).toBe(2 * DIAG_COST)
    computeFlowField(3, 3, passable, [8], field, scratch)
    expect(field.dist[8]).toBe(0)
    expect(field.dist[0]).toBe(2 * DIAG_COST)
  })

  it('handles a full 24x40 grid without overflowing the entry pool', () => {
    const f = run(24, 40, [], [0])
    expect(f.dist[24 * 40 - 1]).toBeLessThan(INF)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test flowfield`
Expected: FAIL — cannot resolve `../src/flowfield`.

- [ ] **Step 3: Implement**

`spike/src/flowfield.ts`:

```ts
import { Sampler, type Stats } from './stats'

export const ORTHO_COST = 10
export const DIAG_COST = 14
export const INF = 0x7fffffff

/** Cyclic bucket count: one more than the largest edge weight. */
const NB = DIAG_COST + 1

const DX = [0, 1, 1, 1, 0, -1, -1, -1] as const
const DY = [-1, -1, 0, 1, 1, 1, 0, -1] as const
/** Index of the direction pointing back the way we came. */
const OPPOSITE = [4, 5, 6, 7, 0, 1, 2, 3] as const

export interface FlowField {
  /** Weighted distance to the nearest source, or INF. */
  dist: Int32Array
  /** Index into DX/DY pointing one step toward a source; -1 at sources and unreachable cells. */
  dir: Int8Array
}

export interface FlowScratch {
  bucketHead: Int32Array
  entryCell: Int32Array
  entryNext: Int32Array
}

export function createFlowField(cells: number): FlowField {
  return { dist: new Int32Array(cells), dir: new Int8Array(cells) }
}

/**
 * Entry pool sized for at most 8 relaxations per cell plus one source insertion.
 * A per-cell `next` pointer would corrupt bucket lists when a cell's distance
 * improves while it is still linked into a higher bucket.
 */
export function createFlowScratch(cells: number): FlowScratch {
  const cap = cells * 9
  return {
    bucketHead: new Int32Array(NB),
    entryCell: new Int32Array(cap),
    entryNext: new Int32Array(cap),
  }
}

export function computeFlowField(
  w: number,
  h: number,
  passable: Uint8Array,
  sources: readonly number[],
  out: FlowField,
  scratch: FlowScratch,
): void {
  const n = w * h
  const { dist, dir } = out
  const { bucketHead, entryCell, entryNext } = scratch

  dist.fill(INF)
  dir.fill(-1)
  bucketHead.fill(-1)

  let top = 0
  let pending = 0

  const push = (cell: number, d: number): void => {
    const b = d % NB
    entryCell[top] = cell
    entryNext[top] = bucketHead[b] as number
    bucketHead[b] = top
    top++
    pending++
  }

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i] as number
    if (s < 0 || s >= n || passable[s] === 0 || dist[s] === 0) continue
    dist[s] = 0
    push(s, 0)
  }

  for (let d = 0; pending > 0; d++) {
    const b = d % NB
    let e = bucketHead[b] as number
    bucketHead[b] = -1
    while (e !== -1) {
      const cur = entryCell[e] as number
      e = entryNext[e] as number
      pending--
      if (dist[cur] !== d) continue // stale entry from a later improvement

      const cx = cur % w
      const cy = (cur / w) | 0
      for (let k = 0; k < 8; k++) {
        const nx = cx + (DX[k] as number)
        const ny = cy + (DY[k] as number)
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const ni = ny * w + nx
        if (passable[ni] === 0) continue
        const nd = d + (DX[k] !== 0 && DY[k] !== 0 ? DIAG_COST : ORTHO_COST)
        if (nd < (dist[ni] as number)) {
          dist[ni] = nd
          dir[ni] = OPPOSITE[k] as number
          push(ni, nd)
        }
      }
    }
  }
}

/**
 * Measures a realistic per-tick pathfinding load: five colour fields over a
 * 24x40 grid, exactly as the production sim would rebuild them on a dirty tick.
 * Returns per-full-rebuild timings in milliseconds.
 */
export function probeFlowFields(iterations: number): Stats {
  const W = 24
  const H = 40
  const cells = W * H
  const COLOURS = 5

  const passable = new Uint8Array(cells).fill(1)
  // Scatter some impassable terrain so the search is not trivially uniform.
  for (let i = 0; i < cells; i += 17) passable[i] = 0

  const fields = Array.from({ length: COLOURS }, () => createFlowField(cells))
  const scratch = createFlowScratch(cells)
  const sources: number[][] = Array.from({ length: COLOURS }, (_, c) =>
    [3 + c * 7, cells - 40 - c * 11, (cells >> 1) + c * 5].filter((s) => passable[s] === 1),
  )

  const sampler = new Sampler(iterations)
  for (let it = 0; it < iterations; it++) {
    const t0 = performance.now()
    for (let c = 0; c < COLOURS; c++) {
      computeFlowField(W, H, passable, sources[c] as number[], fields[c] as FlowField, scratch)
    }
    sampler.push(performance.now() - t0)
  }
  return sampler.stats()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test flowfield`
Expected: PASS, 10 tests.

If the "routes around an obstacle" case fails, recompute the expected value by hand before changing the implementation — the assertion encodes real shortest-path arithmetic and is the most likely place for a wrong expectation rather than a wrong algorithm.

- [ ] **Step 5: Add the probe to main**

In `spike/src/main.ts`, add the import:

```ts
import { probeFlowFields } from './flowfield'
```

and inside the async IIFE, immediately before `show('bench', results)`:

```ts
    const flow = probeFlowFields(200)
    show('flowfield (ms per 5-colour full rebuild)', flow)
```

Then change the submit call to include it:

```ts
    const ok = await submit({ kind: 'bench', device, results, flow })
```

- [ ] **Step 6: Deploy and measure on device**

```bash
pnpm deploy && pnpm tail
```

Interpretation, at a 30 Hz tick (33.3 ms budget) and a 60 Hz tick (16.7 ms):
- `p99 < 1 ms` — pathfinding is free at either rate. Tick rate is decided by rendering alone.
- `p99` between 1 and 3 ms — fine at 30 Hz, tight at 60 Hz.
- `p99 > 5 ms` — 30 Hz only, and coalescing dirty rebuilds becomes mandatory rather than an optimisation.

- [ ] **Step 7: Commit**

```bash
cd .. && git add spike && git commit -m "spike(m0): dial's-bucket dijkstra flow field and cpu probe"
```

---

## Task 7: Storage persistence probe

**Files:**
- Create: `spike/src/storageProbe.ts`
- Create: `spike/test/storageProbe.test.ts`
- Modify: `spike/src/main.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `PROBE_KEY = 'laneways.m0.probe'`
  - `PAYLOAD_BYTES = 4096`
  - `interface KVLike { getItem(k: string): string | null; setItem(k: string, v: string): void }`
  - `interface ProbeResult { launches: number; survived: boolean; payloadIntact: boolean; writeFailed: boolean; ageMs: number; firstSeenMs: number }`
  - `makePayload(bytes: number): string`
  - `runProbe(store: KVLike, nowMs: number): ProbeResult`

This is the highest-value measurement in M0. If `localStorage` does not survive across Telegram sessions on iOS, the entire tier-1 crash-safety design in spec §9 has to change.

The payload is 4096 bytes so the probe also exercises a realistic write size rather than a trivial one.

- [ ] **Step 1: Write the failing test**

`spike/test/storageProbe.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runProbe, makePayload, PROBE_KEY, PAYLOAD_BYTES, type KVLike } from '../src/storageProbe'

class MemStore implements KVLike {
  readonly map = new Map<string, string>()
  failWrites = false
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.map.set(k, v)
  }
}

describe('makePayload', () => {
  it('produces exactly the requested byte count', () => {
    expect(makePayload(4096)).toHaveLength(4096)
  })

  it('is deterministic', () => {
    expect(makePayload(64)).toBe(makePayload(64))
  })

  it('is not a single repeated character, so truncation is detectable', () => {
    const p = makePayload(256)
    expect(new Set(p).size).toBeGreaterThan(1)
  })
})

describe('runProbe', () => {
  it('reports a first launch when storage is empty', () => {
    const s = new MemStore()
    const r = runProbe(s, 1000)
    expect(r.survived).toBe(false)
    expect(r.launches).toBe(1)
    expect(r.ageMs).toBe(0)
    expect(r.writeFailed).toBe(false)
    expect(r.payloadIntact).toBe(true)
  })

  it('writes the record on the first launch', () => {
    const s = new MemStore()
    runProbe(s, 1000)
    expect(s.getItem(PROBE_KEY)).not.toBeNull()
  })

  it('reports survival and an incremented launch count on the second launch', () => {
    const s = new MemStore()
    runProbe(s, 1000)
    const r = runProbe(s, 61000)
    expect(r.survived).toBe(true)
    expect(r.launches).toBe(2)
    expect(r.ageMs).toBe(60000)
    expect(r.payloadIntact).toBe(true)
  })

  it('keeps counting across many launches', () => {
    const s = new MemStore()
    for (let i = 0; i < 4; i++) runProbe(s, 1000 + i)
    expect(runProbe(s, 2000).launches).toBe(5)
  })

  it('detects a corrupted payload', () => {
    const s = new MemStore()
    runProbe(s, 1000)
    const rec = JSON.parse(s.getItem(PROBE_KEY) as string)
    rec.payload = 'truncated'
    s.map.set(PROBE_KEY, JSON.stringify(rec))
    const r = runProbe(s, 2000)
    expect(r.survived).toBe(true)
    expect(r.payloadIntact).toBe(false)
  })

  it('treats unparseable stored data as a first launch', () => {
    const s = new MemStore()
    s.map.set(PROBE_KEY, 'not json {{{')
    const r = runProbe(s, 1000)
    expect(r.survived).toBe(false)
    expect(r.launches).toBe(1)
  })

  it('reports writeFailed instead of throwing when the store rejects writes', () => {
    const s = new MemStore()
    s.failWrites = true
    const r = runProbe(s, 1000)
    expect(r.writeFailed).toBe(true)
    expect(r.survived).toBe(false)
  })

  it('stores a payload of PAYLOAD_BYTES length', () => {
    const s = new MemStore()
    runProbe(s, 1000)
    const rec = JSON.parse(s.getItem(PROBE_KEY) as string)
    expect(rec.payload).toHaveLength(PAYLOAD_BYTES)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test storageProbe`
Expected: FAIL — cannot resolve `../src/storageProbe`.

- [ ] **Step 3: Implement**

`spike/src/storageProbe.ts`:

```ts
export const PROBE_KEY = 'laneways.m0.probe'
export const PAYLOAD_BYTES = 4096

export interface KVLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ProbeResult {
  launches: number
  survived: boolean
  payloadIntact: boolean
  writeFailed: boolean
  ageMs: number
  firstSeenMs: number
}

interface Record_ {
  firstSeenMs: number
  launches: number
  payload: string
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Deterministic, non-uniform, so truncation or corruption is detectable. */
export function makePayload(bytes: number): string {
  let out = ''
  for (let i = 0; i < bytes; i++) {
    out += ALPHABET[(i * 7 + (i >> 5)) % ALPHABET.length]
  }
  return out
}

function parse(raw: string | null): Record_ | null {
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as Partial<Record_>
    if (typeof v.firstSeenMs !== 'number' || typeof v.launches !== 'number' || typeof v.payload !== 'string') {
      return null
    }
    return { firstSeenMs: v.firstSeenMs, launches: v.launches, payload: v.payload }
  } catch {
    return null
  }
}

/**
 * Call once per launch. Returns whether a prior launch's data survived.
 * Never throws — a storage backend that rejects writes reports writeFailed.
 */
export function runProbe(store: KVLike, nowMs: number): ProbeResult {
  const expected = makePayload(PAYLOAD_BYTES)
  const prior = parse(store.getItem(PROBE_KEY))

  const survived = prior !== null
  const payloadIntact = prior === null ? true : prior.payload === expected
  const launches = prior === null ? 1 : prior.launches + 1
  const firstSeenMs = prior === null ? nowMs : prior.firstSeenMs

  let writeFailed = false
  try {
    store.setItem(PROBE_KEY, JSON.stringify({ firstSeenMs, launches, payload: expected }))
  } catch {
    writeFailed = true
  }

  return {
    launches,
    survived,
    payloadIntact,
    writeFailed,
    ageMs: nowMs - firstSeenMs,
    firstSeenMs,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test storageProbe`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass across all five test files; no type errors.

- [ ] **Step 6: Wire into main, ahead of the benchmark**

The probe must run before the benchmark so a crash in the bench does not cost us the storage reading. In `spike/src/main.ts`, add:

```ts
import { runProbe } from './storageProbe'
```

and immediately after `show('device', device)`:

```ts
const storage = runProbe(window.localStorage, Date.now())
show('storage', storage)
void submit({ kind: 'storage', device, storage })
```

- [ ] **Step 7: Commit**

```bash
cd .. && git add spike && git commit -m "spike(m0): cross-session localstorage persistence probe"
```

---

## Task 8: Device runs and findings

The measurement itself. No code — this is the task that produces M0's actual deliverable.

**Files:**
- Create: `docs/research/2026-08-02-m0-spike-findings.md`
- Modify: `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md` (§13 Open risks, and §3 decisions 10 and 12 if the measurements contradict them)

- [ ] **Step 1: Deploy the final spike**

```bash
cd spike && pnpm test && pnpm typecheck && pnpm deploy
```

- [ ] **Step 2: Run the Android sequence**

With `pnpm tail` running in a second terminal, on the low-end Android device:

1. Open `t.me/<bot>/m0`. Record the full output.
2. Confirm `performanceClass` is non-null. If null, capture the raw `ua` and fix the parser (Task 2 Step 3), then redeploy and repeat.
3. Fully close the Mini App (swipe it away, do not just background it). Reopen. Confirm `storage.launches` incremented and `survived` is true.
4. Force-stop Telegram from Android settings. Reopen the Mini App. Record `storage`.

- [ ] **Step 3: Run the iOS sequence — the one that matters**

On the iPhone:

1. Open `t.me/<bot>/m0`. Record output. Expect `survived: false`, `launches: 1`.
2. Close the Mini App via its close button. Reopen. Record `storage.launches` and `survived`.
3. Swipe Telegram out of the iOS app switcher entirely. Reopen Telegram, reopen the Mini App. **Record `storage.launches`, `survived`, and `payloadIntact`.**
4. Wait at least an hour with Telegram closed, then repeat. Some eviction is time-based rather than lifecycle-based.

**This is the reading the whole tier-1 design depends on.** If `survived` is false at step 3 or 4, `localStorage` is being evicted and spec §9 must change: IndexedDB becomes the primary store with `localStorage` used only for the synchronous teardown write, and the save cadence tightens.

- [ ] **Step 4: Write the findings document**

Create `docs/research/2026-08-02-m0-spike-findings.md` with these sections, filled from the recorded output:

1. **Devices tested** — exact model, OS version, Telegram client version, reported `performanceClass`, DPR, viewport, for each device.
2. **Render benchmark** — a table of the five configs × `frame` and `draw` percentiles per device. State the 8 ms drawing budget explicitly and mark each config pass or fail against it.
3. **Baked-layer verdict** — the measured difference between baked and per-frame roads at 400 sprites. Confirm or refute the spec's claim.
4. **Flow-field probe** — p50/p95/p99 per device for a five-colour full rebuild, against the 30 Hz and 60 Hz budgets.
5. **Storage persistence** — the full sequence for each device, with an explicit yes/no on iOS survival across a force-quit.
6. **Decisions forced** — for each of these, the answer and the evidence:
   - Canvas2D confirmed, or escalate to Pixi/WebGL
   - Sim tick 30 Hz or 60 Hz
   - Maximum viable simultaneous car count
   - Tier-1 storage: `localStorage` or IndexedDB
   - Whether `performanceClass`-based degradation is needed, and at what threshold
7. **Surprises** — anything that contradicts the spec or the research dossier. This section is why the spike exists.

- [ ] **Step 5: Update the spec**

For each risk in spec §13 that M0 resolved, replace the mitigation text with the measured answer and a link to the findings document. If a measurement contradicts decision 10 (30 Hz) or decision 12 (Canvas2D) in §3, change the decision and note the evidence — the spec is the design of record and must not disagree with what we measured.

- [ ] **Step 6: Commit and push**

```bash
cd .. && git add docs && git commit -m "docs: M0 spike findings and resulting spec updates"
git push
```

- [ ] **Step 7: Decide the fate of `spike/`**

The spike has served its purpose. Recommended: keep it in the repo under `spike/` with a `README.md` stating it is throwaway and not imported by production code. `flowfield.ts` and `stats.ts` are close to production quality and M1 may lift them — copy, do not import.

---

## Self-Review

**Spec coverage.** M0's scope in spec §12 is two questions: renderer viability on low-end Android, and `localStorage` persistence on iOS. Task 5 answers the first, Task 7 answers the second, Task 6 covers the tick-rate half of "decides renderer and tick rate", and Task 8 converts all three into decisions and spec amendments. Tasks 1–4 are the infrastructure those three require. The Telegram constraints from spec §8 that M0 can exercise — boot order, `viewportStableHeight`, version gating, dead top band, `no-store` on `index.html`, no cross-origin assets — are all in Task 1 and the Global Constraints. Deliberately **not** covered, because they belong to later milestones: `initData` auth (M3), CloudStorage tier 2 (M3), D1 and replay verification (M4). Task 1 Step 9 notes the bot token is captured now but unused until M3.

**Placeholder scan.** No TBDs. Every code step contains complete, runnable code. The one deliberate unknown — the exact Telegram-Android user-agent format — is handled explicitly rather than hand-waved: a defensive parser, the raw UA always reported, and a named correction step in Task 2 Step 6 and Task 8 Step 2.

**Type consistency.** Verified across tasks: `Stats` (Task 3) is consumed by `BenchResult` (Task 5) and `probeFlowFields` (Task 6); `Sampler` is used in Tasks 5 and 6 with the constructor signature defined in Task 3; `mulberry32` (Task 4, `scene.ts`) is imported by `roadAtlas.ts` in the same task; `Sprite` is produced by `makeScene` and consumed by `advance` and `drawSprites`; `show`/`submit`/`status` (Task 2) are used with matching signatures in Tasks 5, 6, and 7; `FlowField` and `FlowScratch` are created and consumed consistently within Task 6. `main.ts` is written once in Task 1 and amended in Tasks 2, 5, 6, and 7 — each amendment states its insertion point relative to existing lines.

**One risk worth naming:** Tasks 5 and 6 both modify `main.ts`, and Task 7 inserts ahead of both. An implementer working tasks out of order will hit conflicts. Work them in order.
