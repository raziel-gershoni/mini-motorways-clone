import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * **Verify the artefact, not the command's exit message.**
 *
 * `wrangler deploy` can print `Success! Uploaded N files` while the deployment
 * never activates and the previous asset hash keeps being served — the upload
 * and the activation are two different things, and a grep over the command's
 * own output hides the missing "Deployed ... triggers" line. So this fetches the
 * live URL through the same path a client would and asserts that **this build**
 * is what came back.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TOKEN HAS TO BE UNIQUE BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 *
 * Grepping for "a string from this build" is not a check: a string that also
 * existed in the *previous* build passes on a stale asset, which is the exact
 * failure being guarded against. Vite content-hashes the asset filenames, and a
 * content hash is not a fix either — rebuilding unchanged sources produces the
 * same hash. `vite.config.ts` therefore mints a timestamp-plus-random id per
 * build and writes it to `.build-id`, and this reads that file rather than being
 * handed a string on a command line where a shell could quietly substitute an
 * empty one.
 *
 * ---------------------------------------------------------------------------
 * TWO FETCHES, AND NEITHER ALONE IS ENOUGH
 * ---------------------------------------------------------------------------
 *
 *   1. `GET /` must contain `<meta name="laneways-build" content="<id>">`.
 *      Proves the document is fresh.
 *   2. The **module script `/` names** must contain the same id. Proves the
 *      asset chain is fresh — a fresh `index.html` pointing at a stale hashed
 *      bundle is the failure mode, and check 1 cannot see it.
 *
 * A fresh asset that nothing links to is invisible to a player, and a fresh
 * document naming a dead asset is a blank board. Both, in that order.
 */

const PACKAGE_ROOT = new URL('../', import.meta.url)
const BUILD_ID_FILE = new URL('.build-id', PACKAGE_ROOT)

/** Deployment propagation is not instant; this is a bounded wait, not a hope. */
const ATTEMPTS = 10
const RETRY_MS = 3000

function fail(message) {
  process.stderr.write(`\nverify-deploy: ${message}\n`)
  process.exit(1)
}

async function fetchFresh(url) {
  // `cache: 'no-store'` plus the header, because the point is to observe what an
  // edge is serving right now and not what this process fetched a minute ago.
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  })
  if (!response.ok) {
    return { ok: false, status: response.status, body: '', url }
  }
  return { ok: true, status: response.status, body: await response.text(), url }
}

async function main() {
  const base = (process.argv[2] ?? process.env.LANEWAYS_URL ?? '').replace(/\/+$/, '')
  if (base === '') {
    fail('no URL given. Usage: node scripts/verify-deploy.js https://laneways.<subdomain>.workers.dev')
  }

  let buildId
  try {
    buildId = readFileSync(fileURLToPath(BUILD_ID_FILE), 'utf8').trim()
  } catch {
    fail(`no ${fileURLToPath(BUILD_ID_FILE)} — run \`pnpm build\` first; the id is minted by vite.config.ts`)
  }
  if (buildId === '') fail('.build-id is empty, so the grep below would match everything')

  process.stdout.write(`verify-deploy: expecting build id ${buildId}\n`)

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const index = await fetchFresh(`${base}/`)
    if (!index.ok) {
      process.stdout.write(`  attempt ${attempt}: GET / -> ${index.status}\n`)
    } else if (!index.body.includes(buildId)) {
      const served = /name="laneways-build" content="([^"]*)"/.exec(index.body)?.[1] ?? '(no meta tag)'
      process.stdout.write(`  attempt ${attempt}: / is serving ${served}, not ${buildId}\n`)
    } else {
      // The document is fresh. Now follow the module script it actually names —
      // this is the half that catches an upload that never activated.
      const src = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(index.body)?.[1]
      if (src === undefined) {
        fail('the served / has no <script type="module" src="..."> — nothing would ever load')
      }
      const bundleUrl = src.startsWith('http') ? src : `${base}${src.startsWith('/') ? '' : '/'}${src}`
      const bundle = await fetchFresh(bundleUrl)
      if (!bundle.ok) fail(`the served / names ${bundleUrl}, which returned ${bundle.status}`)
      if (!bundle.body.includes(buildId)) {
        fail(
          `/ is fresh but the bundle it names is STALE: ${bundleUrl} does not contain ${buildId}. ` +
            'This is the "Success! Uploaded N files" failure — the upload succeeded and the ' +
            'deployment did not activate.',
        )
      }
      process.stdout.write(
        `verify-deploy: OK\n  /        contains ${buildId}\n  ${bundleUrl}\n           contains ${buildId} (${bundle.body.length} bytes)\n`,
      )
      return
    }
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
  }

  fail(`after ${ATTEMPTS} attempts the live / never contained ${buildId} — the deployment did not activate`)
}

await main()
