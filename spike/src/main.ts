import { boot, stableHeight, contentSafeAreaTop } from './telegram'
import { collectDeviceInfo } from './deviceInfo'
import { show, status, submit } from './report'
import { runBenchSuite } from './bench'
import { probeFlowFields } from './flowfield'
import { runProbe } from './storageProbe'

boot()

const app = document.getElementById('app')
if (app) app.textContent = ''

const device = collectDeviceInfo()
show('device', device)

const storage = runProbe(window.localStorage, Date.now())
show('storage', storage)
void submit({ kind: 'storage', device, storage })

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
    const flow = probeFlowFields(200)
    show('flowfield (ms per 5-colour full rebuild)', flow)
    const ok = await submit({ kind: 'bench', device, results, flow })
    show('submit', ok ? 'sent' : 'FAILED — screenshot the bench block above')
  } catch (err) {
    show('bench ERROR', String(err))
  }
})()
