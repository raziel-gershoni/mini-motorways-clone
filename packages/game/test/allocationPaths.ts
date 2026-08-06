import { fileURLToPath } from 'node:url'

/**
 * The checkout root, derived from **this file's own location** rather than from
 * a hard-coded repository name — and that distinction was a Critical.
 *
 * The first version matched `lastIndexOf('/mini-motorways-clone/')` and then
 * filtered by the `packages/game/` prefix. In a git worktree the checkout lives
 * at `<repo>/.claude/worktrees/<name>/`, so the LAST occurrence of the repo name
 * is the outer directory and every path resolved to
 * `.claude/worktrees/<name>/packages/game/src/loop.ts` — which starts with
 * `.claude`, matches no scope, and made `offenders` and `dirtyFiles` return `[]`
 * **unconditionally**. Every review on this project runs in a worktree, so for
 * every reviewer the harness was inert and silently green, and three real
 * regressions — including the 152 B/tick `clear()` defect it had just been
 * celebrated for catching — scored zero detectors there.
 *
 * `import.meta.url` is `<root>/packages/game/test/allocationPaths.ts`, so
 * `../../../` is the checkout root wherever the checkout happens to be. The
 * profiler reports a bare absolute path (`/Users/.../packages/game/src/loop.ts`)
 * while `import.meta.url` is a `file://` URL, hence `fileURLToPath`; the
 * `file://` branch in `repoRelative` is defensive against a future Node
 * changing that.
 *
 * `test/allocationPaths.test.ts` pins these with synthetic paths, including a
 * worktree-shaped one, so the repair is checked **without** depending on where
 * the suite is run from.
 */
export const CHECKOUT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** An absolute path or `file://` URL -> a path relative to the checkout root. */
export function repoRelative(url: string, root: string = CHECKOUT_ROOT): string {
  const path = url.startsWith('file://') ? fileURLToPath(url) : url
  return path.startsWith(root) ? path.slice(root.length) : path
}

