import { boot } from './telegram'
import { collectDeviceInfo } from './deviceInfo'
import { show, submit } from './report'

boot()

const app = document.getElementById('app')
if (app) app.textContent = ''

const device = collectDeviceInfo()
show('device', device)
void submit({ kind: 'device', device })
