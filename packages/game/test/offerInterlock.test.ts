import { describe, it, expect } from 'vitest'
import { PointerOutcome } from '../src/pointer'

/**
 * **A DELIBERATELY FAILING TEST. TASK 8 DELETES THIS FILE AS ITS FIRST ACT.**
 *
 * M1f Task 7 pauses the loop whenever `offerPending(state)` holds and ships no
 * modal, so between this commit and the next the default board **freezes at
 * 2:21** — `(TICKS_PER_WEEK - WARM_START_TICKS) / TICKS_PER_SECOND` =
 * `(4500 - 258) / 30` = 141.4 s on the city, which is what a plain load opens.
 * The cars stop mid-road, two pause bars appear beside the clock, and nothing
 * says why. Tapping the clock buys **exactly one tick** and then the condition
 * re-arms, so it is not even a way out; board input is refused while paused.
 * Indistinguishable from a crash, to a player.
 *
 * Correct sequencing, disclosed in the commit message, and **nothing else in
 * the tree would prevent a deploy landing here** — this project shipped that
 * exact intermediate state once already (M1e Task 8) and the mitigation that
 * worked was a red test rather than a promise.
 *
 * ---------------------------------------------------------------------------
 * THE KEY IS STRUCTURAL, NOT A GUESS ABOUT THE NEXT TASK'S SHAPE
 * ---------------------------------------------------------------------------
 *
 * `render` imports nothing from `sim`, so a modal cannot be drawn without new
 * fields on `RenderFrame` **and** a hit-test the pointer can reach. This asserts
 * the pointer can produce `PointerOutcome.CARD_CHOSEN`, which no cosmetic change
 * can satisfy: the outcome does not exist until Task 8 declares it, and it
 * cannot be produced without the rects, the arbitration and the enqueue.
 *
 * **Why the outcome and not the frame fields.** Task 7 itself lands
 * `RenderFrame.offerPending`/`offerA`/`offerB`, so an interlock keyed on those
 * would be green the moment this commit landed and would have interlocked
 * nothing. The pointer outcome is the half Task 7 must NOT have and Task 8 must.
 *
 * Its worst failure mode is that Task 8 deletes a file it was going to delete
 * anyway.
 */
describe('THE OFFER INTERLOCK — red on purpose until M1f Task 8', () => {
  it('FAILS UNTIL TASK 8: a tap can choose a card', () => {
    expect(
      Object.keys(PointerOutcome),
      'the offer modal is unreachable — the board freezes at 2:21 with no way out. See this file for why it exists.',
    ).toContain('CARD_CHOSEN')
  })

  it('and this is the state it is interlocking: Task 7 pauses, and nothing draws or taps', () => {
    // **The vacuity guard for the assertion above**, so a green interlock can
    // only mean the outcome landed and not that this file stopped being about
    // anything. Every OTHER code the state machine can return still exists — if
    // Task 8 renamed the enum or this import went stale, the `toContain` above
    // would be a 0-detector reading as an interlock.
    expect(Object.keys(PointerOutcome).length).toBeGreaterThanOrEqual(9)
    expect(Object.keys(PointerOutcome)).toContain('PAUSE_TOGGLED')
    expect(Object.keys(PointerOutcome)).toContain('REFUSED_PAUSED')
  })
})
