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
