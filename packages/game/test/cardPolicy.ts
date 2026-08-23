import { offerPending, offerSlot, type GameState } from '@laneways/sim'
import type { InputQueue } from '../src/inputs'
import type { Loop } from '../src/loop'

/**
 * **The card policy every FRAME-DRIVEN rig needs, as one function, because four
 * rigs need it and two copies of a policy drift** — M1f Task 7.
 *
 * From this task on, the production loop pauses whenever `offerPending(state)`
 * holds (`frame.ts`'s `onOfferRaised` -> `main.ts`'s `loop.setPaused(true)`),
 * and `loop.ts` gates its whole drain on `if (!paused)`. So a headless rig that
 * drives `game.frame` past tick 4,500 and never resolves the offer **stops
 * dead**. Measured on this tree before the policy existed: **11 genuine reds
 * across two files** — `integration.test.ts`'s six death loops and its three
 * memoised arms (whose `beforeAll` failure then skipped four more cases), and
 * `demoAllocation.test.ts`, which would otherwise have profiled a FROZEN board
 * for the last of its three windows while its allocation numbers still looked
 * fine. That is the catalogue's *"an instrument that reports clean while
 * measuring nothing"*, and the only reason it went red instead is that the file
 * already carries a liveness guard on `H_TICK`.
 *
 * **A rig that drives `step` directly needs NONE of this**, because `sim` has no
 * notion of pause and never will (plan Decision 11). That is why `deathTicks.ts`'s
 * two measurements, `cityArms.ts`'s hand driver in `startingCity.test.ts`,
 * `junctionArms.ts`, `jamFixture.ts` and `allocation.test.ts`'s tick rigs are
 * still measurements of a genuinely no-input board: their offers are raised and
 * silently replaced every week, `H_OFFER_WEEK` stays 0, and `H_TILES` grows by
 * `WEEKLY_TILE_GRANT` alone.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND-ORDER EFFECT, NAMED SO IT IS NOT DISCOVERED
 * ---------------------------------------------------------------------------
 *
 * Taking a card pays `CARD_GRANT_ROAD_TILES` (30) or `CARD_GRANT_ITEM` (20) ON
 * TOP of `WEEKLY_TILE_GRANT` (30). So a frame-driven "no-input" arm is no longer
 * strictly no-input: it receives 50-60 tiles a week instead of 30, and it holds
 * junction upgrades it never places.
 *
 * **What that does NOT change, measured rather than assumed: which roads the
 * greedy arm builds.** `armGreedyActions` reads the tile budget in exactly one
 * place — `if (found.cost > tilesLeft(state))` — and `integration.test.ts`
 * asserts `r.unaffordable` is **0** for the whole 21,783-tick greedy run, with a
 * per-week `tilesLeft` floor of 37. The connector is not tile-bound at any point
 * on any arm, so extra tiles are a bigger number in a ledger nothing reads back.
 * Every behavioural figure the arms pin — death tick, killer, trips, fires, the
 * week rows, the junction census — is therefore predicted to be UNMOVED, and
 * only the tile ledger moves. See this task's report for the measurement.
 *
 * ---------------------------------------------------------------------------
 * WHY IT COSTS A FRAME, AND WHY THAT IS THE HONEST SHAPE
 * ---------------------------------------------------------------------------
 *
 * `setPaused(false)` sets `resetClock`, so the NEXT `frame(now)` assigns
 * `L_LAST_TIME = now` before computing `rawDt`, `rawDt` is 0, and that frame
 * runs **zero ticks**. A rig therefore loses one frame's worth of wall clock per
 * week boundary it crosses — about half a tick — and a rig that pins an exact
 * end tick re-derives it. Compensating by winding `now` forward would be a
 * second clock in the harness, which is the thing plan Decision 1 exists to
 * forbid.
 *
 * **Slot A rather than "whichever card is X"**: the pool's only randomness is
 * the ORDER, so a slot-keyed policy exercises both cards across a run, while a
 * card-keyed one would silently become a constant if the draw were ever fixed.
 */
export interface FrameRig {
  readonly state: GameState
  readonly queue: InputQueue
  readonly loop: Pick<Loop, 'over' | 'paused' | 'setPaused'>
}

/**
 * Takes slot `slot`'s card if a modal would be up, and lets the loop run again.
 * **Call it BEFORE the frame, not after** — see below. Returns whether it fired,
 * so a caller can assert it did: *a policy that never runs is a policy that is
 * not being tested.*
 *
 * **Three guards, and each one closes a failure this rig hit.**
 *
 *  1. **`over`.** `step` is a byte-identical no-op past a game over, so
 *     `H_OFFER_WEEK` can never catch up and `offerPending` stays TRUE forever on
 *     a dead board. Without this guard every rig that keeps drawing frames after
 *     the shutdown — and `integration.test.ts` has several, deliberately,
 *     because the draw path must keep running behind the scrim — would enqueue
 *     one `choose-card` per frame into a queue no tick will ever drain, growing
 *     the action pool without bound inside the allocation windows. It is also
 *     what a player can do: the run is over, there is nothing to choose.
 *  2. **`paused`.** This is what makes the policy fire ONCE per offer rather
 *     than once per frame. Between the resume and the tick that resolves the
 *     week there are two frames (the first after any resume runs zero ticks —
 *     `resetClock`), and `offerPending` is still true on both. An
 *     `offerPending`-only policy enqueues a duplicate `choose-card` on each of
 *     them; `applyChooseCard` no-ops the duplicates, so it is invisible in
 *     behaviour and visible only as a queue that is never empty and a card
 *     counter that over-reports. It is also the honest model: a player taps a
 *     modal, and the modal is up exactly while the loop is paused for it.
 *  3. **`offerPending`.** The loop can be paused for something else entirely —
 *     `pointer.ts`'s HUD-clock tap is in this same file's tests — and a policy
 *     that resumed THAT would be quietly editing the case it runs inside.
 *
 * **Before the frame rather than after it**, so that a rig's own "the queue was
 * drained" invariant still holds at the point it is checked: the action is
 * enqueued and consumed inside the same `oneTick`/`advance` call rather than
 * left standing across it. `driveArm` asserts exactly that after every tick.
 */
export function takeCardPolicy(rig: FrameRig, slot: 0 | 1): boolean {
  if (rig.loop.over) return false
  if (!rig.loop.paused) return false
  if (!offerPending(rig.state)) return false
  // The card id the rig believes it is taking, read through `sim`'s own guard.
  // `applyChooseCard` echoes it back and THROWS on a mismatch, which is the
  // replay-divergence detector M1f Task 6 built — so a rig that fabricated an
  // id here would poison `H_EPOCH` and stop the run rather than quietly take
  // the wrong card.
  rig.queue.enqueue('choose-card', slot, offerSlot(rig.state, slot))
  rig.loop.setPaused(false)
  return true
}
