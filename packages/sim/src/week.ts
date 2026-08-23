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
 * inert because **no `TickAction` reads `H_TICK`**, and M1e Task 2 did not
 * change that. What it did was put a clock reader BETWEEN the advance and the
 * input loop, which ends the inertness of that pair for a different and better
 * reason: the two phases now have something observable between them.
 *
 * **M1f Task 6 ended the no-`TickAction`-reads-the-clock condition itself, and
 * this sentence used to assert it.** It read *"`TickActionKind` is still
 * `'place' | 'erase'`"*; the union is `'place' | 'erase' | 'choose-card'` and
 * `applyChooseCard` reads `H_WEEK`. Nothing about THIS function changes — the
 * grant still takes no week argument and still reads only `H_TICK` — but the
 * clause is corrected rather than left standing, because a comment that states
 * the opposite of the code is this project's dominant recorded defect.
 *
 * **This function is one of TWO source terms in the tile ledger, and it was the
 * only one until M1f Task 6.** `tilesLeft + roadCells + ghostCells` was an exact
 * conservation law across 25,000 ticks at the close of M1d; from M1e Task 2 it
 * is conserved BETWEEN boundaries and stepped by `WEEKLY_TILE_GRANT` at each
 * one; and from M1f Task 6 `applyChooseCard` steps it again, by
 * `CARD_GRANT_ROAD_TILES` or `CARD_GRANT_ITEM`, on whichever tick carries the
 * `choose-card` action. **No fixture in the repo enqueues one yet** — Task 8 is
 * what makes the action reachable — so `integration.test.ts`'s ledger sweep is
 * unaffected today and will need the second term the day a rig takes a card. The long-run assertion must carry the term
 * explicitly rather than loosening to a range — the point of the invariant is
 * that the refund path conserves, and a range hides a leaking refund.
 *
 * **Nothing here allocates — two reads, one comparison, one write — and that is
 * an argument, not a measurement. The distinction matters because the harness
 * structurally CANNOT check the half that does the work.** `packages/game`'s
 * allocation harness is live on this file: an escaping object at the top of
 * `runWeekBoundary` turns it red at 41.30 B/frame, which is the first time in
 * four attempts on this project that the harness's SCOPE followed new code
 * rather than staying where it was. But the same object inside the grant branch
 * leaves the suite green, and by construction rather than by accident: the rigs
 * drive 4,200-10,500 frames against a 4,500-tick week, so the branch fires a
 * handful of times, ~3.3 B/frame, under the 4 B sampling floor no matter how
 * badly it behaves. The gate is what hides it.
 *
 * **Carry this forward: Tasks 5 and 7 add week-gated work of the same shape**
 * (the spawn cadences, the colour unlocks), and it will be equally unmeasurable
 * for the same reason. Anything allocating inside a week-gated branch needs a
 * rig that drives enough weeks to clear the floor, or an explicit note that no
 * instrument covers it. A green harness is a claim about the inputs it was
 * given.
 */
export function runWeekBoundary(state: GameState): void {
  if (!isWeekBoundary(state.header[H_TICK] as number)) return
  state.header[H_TILES] = (state.header[H_TILES] as number) + WEEKLY_TILE_GRANT
}
