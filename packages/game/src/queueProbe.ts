import { DX, DY, PHASE_OUTBOUND, PHASE_RETURNING, routeStep, type GameState, type WorldData } from '@laneways/sim'

/**
 * **A queue length read off production state, with no queue structure
 * anywhere in `sim`** — there is none; queueing emerges from per-(cell, lane)
 * occupancy alone.
 *
 * This is `packages/game/test/jamFixture.ts`'s `jamQueueLength`, moved into
 * `src` so that the demo layout's tests and any future debug HUD can share one
 * implementation. It lives here rather than being imported from `test/`
 * because a `src` module may not import a test fixture — the dependency would
 * point the wrong way and would not survive a build.
 *
 * **The "car in front of me" relation is FUNCTIONAL.** A car has exactly one
 * next cell — the next step of its own committed route — so it has at most one
 * car ahead, which is why this is a forward walk rather than a tree search.
 *
 * **The visited set is not decoration.** A cycle of length >= 3 is precisely
 * the deadlock `MAX_BLOCKED_TICKS` exists for, and without the set this walk
 * would not terminate on one. A 2-cycle cannot occur: opposite directions land
 * in different lanes (`LANE_OF_DIR`), so two cars cannot each be waiting for
 * the other's cell in the same lane.
 *
 * **It allocates** — two `Map`s and a `Set` per call — so it must never be
 * called from inside a tick or a frame. Both callers today are test rigs, and
 * both call it outside a profiled window. A debug HUD wanting this figure has
 * to either amortise it or accept the allocation with the profiler gated off;
 * `packages/game/test/allocation.test.ts` is what will say so.
 */
export function longestQueue(state: GameState, world: WorldData): number {
  const carAt = new Map<number, number>()
  const carCount = state.carPhase.length
  for (let c = 0; c < carCount; c++) {
    const phase = state.carPhase[c] as number
    if (phase === PHASE_OUTBOUND || phase === PHASE_RETURNING) {
      carAt.set(state.carCell[c] as number, c)
    }
  }

  const ahead = new Map<number, number>()
  for (let c = 0; c < carCount; c++) {
    const phase = state.carPhase[c] as number
    if (phase !== PHASE_OUTBOUND && phase !== PHASE_RETURNING) continue
    const cur = state.carCell[c] as number
    const cursor = state.carRouteCursor[c] as number
    const len = state.carRouteLen[c] as number
    let dir: number
    if (phase === PHASE_OUTBOUND) {
      if (cursor >= len) continue
      dir = routeStep(state, c, cursor)
    } else {
      // The return leg retraces step `cursor - 1` backwards. `+ 4 % 8` is
      // `OPPOSITE`, spelled out rather than imported so this module depends on
      // nothing that could change meaning under it.
      if (cursor <= 0) continue
      dir = (routeStep(state, c, cursor - 1) + 4) % 8
    }
    const nx = (cur % world.w) + (DX[dir] as number)
    const ny = ((cur / world.w) | 0) + (DY[dir] as number)
    if (nx < 0 || nx >= world.w || ny < 0 || ny >= world.h) continue
    const front = carAt.get(ny * world.w + nx)
    if (front !== undefined) ahead.set(c, front)
  }

  let longest = 0
  for (const c of carAt.values()) {
    const seen = new Set<number>([c])
    let cur = c
    let len = 1
    for (;;) {
      const next = ahead.get(cur)
      if (next === undefined || seen.has(next)) break
      seen.add(next)
      cur = next
      len++
    }
    if (len > longest) longest = len
  }
  return longest
}
