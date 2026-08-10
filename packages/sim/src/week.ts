import { WEEKLY_TILE_GRANT } from '@laneways/shared'
import type { GameState } from './state'
import { H_TICK, H_TILES } from './state'
import { isWeekBoundary } from './clock'

/**
 * Phase 2 of the tick order: the weekly grant (spec §5.10).
 *
 * **Position, and why it is not decoration.** It reads `H_TICK`, so it must
 * follow phase 1's advance — swapping 1 and 2 grants against the previous
 * tick's week and moves every grant one tick early. And it must PRECEDE phase
 * 3, so an action queued on the boundary tick can spend the tiles it just
 * received; the alternative makes the boundary tick the one tick of the week a
 * player's road is refused for budget, which is unexplainable at the screen.
 *
 * This is the first phase in the game to read the clock. `step.ts`'s comment
 * records why that matters: the two inherited 0-detector transpositions were
 * inert because **no `TickAction` reads `H_TICK`**, and this phase does not
 * change that — `TickActionKind` is still `'place' | 'erase'`. What it does is
 * put a clock reader BETWEEN the advance and the input loop, which ends the
 * inertness of that pair for a different and better reason: the two phases now
 * have something observable between them.
 *
 * **This function is also the source term in the tile ledger.** `tilesLeft +
 * roadCells + ghostCells` was an exact conservation law across 25,000 ticks at
 * the close of M1d; from here it is conserved BETWEEN boundaries and stepped by
 * `WEEKLY_TILE_GRANT` at each one. The long-run assertion must carry the term
 * explicitly rather than loosening to a range — the point of the invariant is
 * that the refund path conserves, and a range hides a leaking refund.
 *
 * Nothing here allocates: two reads, one comparison, one write.
 */
export function runWeekBoundary(state: GameState): void {
  if (!isWeekBoundary(state.header[H_TICK] as number)) return
  state.header[H_TILES] = (state.header[H_TILES] as number) + WEEKLY_TILE_GRANT
}
