import { describe, it, expect } from 'vitest'
import { CHECKOUT_ROOT, repoRelative } from './allocationPaths'

/**
 * The regression test for Task 7 review's Critical, and it exists as its own
 * file for one reason: **it must not depend on where the suite is run from.**
 *
 * `allocation.test.ts` used to turn a profiler stack frame's absolute path into
 * a repo-relative one by matching `lastIndexOf('/mini-motorways-clone/')`. In a
 * git worktree — which is where every review on this project runs — the
 * checkout is at `<repo>/.claude/worktrees/<name>/`, the LAST occurrence of the
 * repo name is the outer directory, and every file resolved to
 * `.claude/worktrees/<name>/packages/game/src/loop.ts`. That matches no scope,
 * so `offenders` and `dirtyFiles` returned `[]` unconditionally: the harness was
 * inert and silently green for every reviewer, and three real regressions scored
 * zero detectors there.
 *
 * The assertions below feed `repoRelative` **synthetic** roots and paths, so
 * they fail in the main checkout as readily as in a worktree. Running the
 * harness itself in a worktree is still required — it is what caught this — but
 * a guard that can only fail in one environment is the shape being fixed.
 */
describe('the harness resolves repo-relative paths wherever the checkout lives', () => {
  const PLAIN = '/Users/dev/mini-motorways-clone/'
  const WORKTREE = '/Users/dev/mini-motorways-clone/.claude/worktrees/review-7/'
  const RENAMED = '/build/ci/checkout-42/'

  it('strips a plain checkout root', () => {
    expect(repoRelative(`${PLAIN}packages/game/src/loop.ts`, PLAIN)).toBe('packages/game/src/loop.ts')
  })

  it('strips a WORKTREE root — the case that returned [] unconditionally', () => {
    // The old `lastIndexOf('/mini-motorways-clone/')` yields
    // `.claude/worktrees/review-7/packages/game/src/loop.ts` here, which starts
    // with `.claude` and matches neither `packages/game/src/` nor
    // `packages/game/`.
    const abs = `${WORKTREE}packages/game/src/loop.ts`
    expect(repoRelative(abs, WORKTREE)).toBe('packages/game/src/loop.ts')
    // and the shape of the old bug, spelled out so nobody reintroduces it:
    const marker = '/mini-motorways-clone/'
    const old = abs.slice(abs.lastIndexOf(marker) + marker.length)
    expect(old).toBe('.claude/worktrees/review-7/packages/game/src/loop.ts')
    expect(old.startsWith('packages/game/')).toBe(false)
  })

  it('does not depend on the repository being called anything in particular', () => {
    expect(repoRelative(`${RENAMED}packages/game/src/inputs.ts`, RENAMED)).toBe(
      'packages/game/src/inputs.ts',
    )
  })

  it('accepts a file:// URL as well as a bare path', () => {
    expect(repoRelative(`file://${PLAIN}packages/game/src/pointer.ts`, PLAIN)).toBe(
      'packages/game/src/pointer.ts',
    )
  })

  it('leaves a path outside the checkout alone rather than mangling it', () => {
    // `node:inspector`, `node_modules`, and anything else the profiler reports.
    expect(repoRelative('node:inspector', PLAIN)).toBe('node:inspector')
    expect(repoRelative('/elsewhere/vite/dist/client.mjs', PLAIN)).toBe(
      '/elsewhere/vite/dist/client.mjs',
    )
  })

  it('derives a real CHECKOUT_ROOT that this very file sits under', () => {
    // Vacuity: an empty root would make every strip above a no-op that still
    // passes, and would make the live harness match everything.
    expect(CHECKOUT_ROOT.length).toBeGreaterThan(1)
    expect(CHECKOUT_ROOT.endsWith('/')).toBe(true)
    expect(repoRelative(`${CHECKOUT_ROOT}packages/game/test/allocation.test.ts`)).toBe(
      'packages/game/test/allocation.test.ts',
    )
  })
})
