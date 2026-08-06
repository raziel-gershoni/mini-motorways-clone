import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

/**
 * The build — plan Task 9.
 *
 * ---------------------------------------------------------------------------
 * THE BUILD ID IS UNIQUE BY CONSTRUCTION, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * The deploy check this project runs is *verify the artefact, not the command's
 * exit message*: fetch the live URL through the same path a client would and
 * assert that **this build** is what came back. That only works with a token
 * nothing but this build can contain.
 *
 * **A content hash is not that token.** Vite content-hashes the asset filenames
 * already, and a rebuild of unchanged sources produces the *same* hash — so a
 * deploy that silently failed to activate would serve the previous asset, and a
 * check that grepped for "a string from this build" would pass on it. That is
 * precisely the failure being guarded against. So the id is a timestamp plus
 * four random bytes, minted once per `vite build`, and it appears in **two
 * independent places**:
 *
 *   1. a `<meta name="laneways-build">` in `index.html`, which is served
 *      `no-store` (below) and names the hashed asset URLs;
 *   2. the JS bundle itself, through `define` — `main.ts` reads
 *      `__LANEWAYS_BUILD_ID__` and publishes it on `globalThis`, which also
 *      stops the constant being tree-shaken out.
 *
 * `scripts/verify-deploy.js` checks both, in that order, following the script
 * tag from the first to the second. One alone is not enough: a fresh `index.html`
 * pointing at a stale asset hash **is** the M0 incident, and a fresh asset that
 * nothing links to is invisible to a player.
 *
 * The id is also written to `.build-id` at the package root — **outside `dist`**,
 * so it is not itself deployed, and read back by the verify script rather than
 * passed between two shell commands.
 *
 * ---------------------------------------------------------------------------
 * WHY `public/_headers` MATTERS MORE HERE THAN ON AN ORDINARY SITE
 * ---------------------------------------------------------------------------
 *
 * Spec §8.5: Telegram Desktop caches Mini App bundles somewhere its own
 * cache-clear does not reach. Vite content-hashes every asset, so those are safe
 * to cache forever — but `index.html` is the one file whose URL never changes,
 * and a cached copy pins the client to a dead asset hash permanently. `_headers`
 * is copied verbatim out of `public/` into `dist/` and read by Cloudflare's
 * static-asset server.
 */

/** Minted once per build. See the module comment for why it is not a content hash. */
const BUILD_ID = `laneways-${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomBytes(4).toString('hex')}`

/** Where the verify script reads the id from. Outside `dist`, so it is not deployed. */
export const BUILD_ID_FILE = '.build-id'

function buildIdPlugin(): Plugin {
  return {
    name: 'laneways-build-id',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string): string {
        // Injected rather than written into `index.html` by hand: the file is
        // asserted as text by `test/shell.test.ts` and must stay a source file a
        // human edits, not a build output.
        return html.replace(
          '<head>',
          `<head>\n    <meta name="laneways-build" content="${BUILD_ID}" />`,
        )
      },
    },
    closeBundle(): void {
      writeFileSync(new URL(`./${BUILD_ID_FILE}`, import.meta.url), `${BUILD_ID}\n`, 'utf8')
    },
  }
}

export default defineConfig({
  // `packages/game` is the root: `index.html` and `public/` are here, and the
  // workspace dependencies resolve through pnpm's symlinks to their TypeScript
  // sources (`"main": "./src/index.ts"`), which Vite compiles as first-party
  // code rather than as prebundled dependencies.
  plugins: [buildIdPlugin()],
  define: {
    __LANEWAYS_BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The default target is fine for every client the spec targets, and a lower
    // one would be a claim about Safari versions nobody has measured.
    sourcemap: true,
  },
})
