import { boot, stableHeight, contentSafeAreaTop } from './telegram'
import { collectDeviceInfo } from './deviceInfo'
import { show, status, submit } from './report'
import { runProbe, checkFreshContext, type KVLike } from './storageProbe'
import { probeFlowFields } from './flowfield'
import { runBenchSuite } from './bench'

boot()

const app = document.getElementById('app')
if (app) app.textContent = ''

// Appended before any output so it is never pushed below the fold. The top band
// is dead space: Telegram's header stays drag-to-dismiss and its close button
// floats over the top-right in fullscreen, so no content of ours may live there
// — hence the top margin. Both margin and height are re-set later, after the
// fullscreen transition has settled.
let top = Math.max(contentSafeAreaTop(), 8)
const canvas = document.createElement('canvas')
canvas.style.cssText = `width:100%;height:1px;margin-top:${top}px;border-radius:8px`
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
  // Let the fullscreen transition settle before doing anything timed: CPU
  // contention with an animating transition inflates the flow-field numbers in
  // the pessimistic direction, and the flow number is the input to the 30 Hz vs
  // 60 Hz decision. A pre-fullscreen viewport would also undersize the canvas.
  await nextFrame()
  await nextFrame()
  await nextFrame()

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
    // Re-read the inset now the transition has settled. At module-eval time
    // requestFullscreen() had only just been called and the client had not yet
    // published the real inset, so the initial margin was a best guess.
    top = Math.max(contentSafeAreaTop(), 8)
    canvas.style.marginTop = `${top}px`

    // Full available height, not a fraction. Draw cost scales with canvas area,
    // and the findings compare draw time against a full-screen frame budget.
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
