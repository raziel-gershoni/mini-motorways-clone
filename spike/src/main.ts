import { boot, stableHeight, contentSafeAreaTop } from './telegram'
import { collectDeviceInfo } from './deviceInfo'
import { show, status, submit } from './report'
import { runProbe, checkFreshContext, type KVLike } from './storageProbe'
import { probeFlowFields } from './flowfield'
import { runBenchSuite } from './bench'

boot()

const app = document.getElementById('app')
if (app) app.textContent = ''

// Appended before any output so it is never pushed below the fold. Height is
// set later, after the fullscreen transition has settled.
const canvas = document.createElement('canvas')
canvas.style.cssText = 'width:100%;height:1px;border-radius:8px'
app?.append(canvas)

const device = collectDeviceInfo()
show('device', device)

// --- storage probe: first, and independent of everything after it ---
let store: KVLike | null = null
try {
  store = window.localStorage
} catch {
  store = null
}
let sessionStore: KVLike | null = null
try {
  sessionStore = window.sessionStorage
} catch {
  sessionStore = null
}
const freshContext = checkFreshContext(sessionStore)
const storage = store
  ? { ...runProbe(store, Date.now()), freshContext }
  : { unavailable: true as const, freshContext }
show('storage', storage)
void submit({ kind: 'storage', device, storage }).then((ok) =>
  show('storage submit', ok ? 'sent' : 'FAILED — screenshot the storage block above'),
)

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

void (async () => {
  // --- flow-field probe: pure CPU, must not depend on the bench succeeding ---
  try {
    const flow = probeFlowFields(40)
    show('flowfield (ms per 5-colour rebuild)', flow)
    void submit({ kind: 'flow', device, flow })
  } catch (err) {
    show('flowfield ERROR', String(err))
    void submit({ kind: 'flow-error', device, error: String(err) })
  }

  // --- render benchmark ---
  try {
    // Let the fullscreen transition settle before reading the viewport: sizing
    // against a pre-fullscreen height would make every draw number optimistic
    // with no error raised.
    await nextFrame()
    await nextFrame()
    await nextFrame()

    // Full available height, not a fraction. Draw cost scales with canvas area,
    // and the findings compare draw time against a full-screen frame budget.
    const top = Math.max(contentSafeAreaTop(), 8)
    canvas.style.height = `${Math.max(1, stableHeight() - top - 16)}px`

    const results = await runBenchSuite(canvas, status)
    show('bench', results)
    const ok = await submit({ kind: 'bench', device, results })
    show('bench submit', ok ? 'sent' : 'FAILED — screenshot the bench block above')
  } catch (err) {
    show('bench ERROR', String(err))
    // Submitted, not just shown: nobody is watching this screen, and "the bench
    // died" is itself a result worth having in the table.
    void submit({ kind: 'bench-error', device, error: String(err) })
  }
})()
