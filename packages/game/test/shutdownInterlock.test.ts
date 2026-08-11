import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RenderFrame } from '@laneways/render'
import { DEMO_DEATH_TICK } from './deathTicks'

/**
 * # THE SHUTDOWN INTERLOCK — DELETE THIS WHOLE FILE AS TASK 9'S FIRST ACT
 *
 * ---------------------------------------------------------------------------
 * WHY A TEST THAT EXISTS TO FAIL LATER
 * ---------------------------------------------------------------------------
 *
 * As of M1e Task 8 the default board **ends its own run at tick 6,703 — 3
 * minutes 43 seconds — with no player error possible**, and nothing draws
 * anything about it. What a player gets is the board stopping dead: cars frozen,
 * the clock stuck, taps doing nothing, and **no way back except closing the
 * app**. That is indistinguishable from a crash, and this build is therefore
 * strictly worse than the one before it.
 *
 * Task 8's report says "Task 9 is the next commit". **That is a promise, not a
 * mechanism**, and this repo's own catalogue is explicit that a handoff item
 * with no code artefact is the one that evaporates — *"'handed to whoever owns
 * X' is a drop when nobody owns X"*, and this milestone has already lost two
 * items exactly that way. Between Task 8 and Task 9 there is no failing test, no
 * build gate and no marker standing between this tree and a deploy that ships a
 * crash-shaped board to a phone.
 *
 * So: **an interlock.** One test, which fails while the shutdown UI is absent
 * and which Task 9 deletes when it lands. It costs Task 9 one `rm`. It costs a
 * premature deploy a red suite, which is the entire point.
 *
 * ---------------------------------------------------------------------------
 * HOW IT DECIDES THE UI IS ABSENT — READ THIS BEFORE "FIXING" IT
 * ---------------------------------------------------------------------------
 *
 * It asks `RenderFrame` whether it can express a shutdown at all. `render`
 * imports nothing from `sim` (spec §4), so the only way a shutdown screen can
 * ever be drawn is for `game` to fold the state into a field on the frame —
 * exactly as `paused` already is. **Today there is no such field**, which is a
 * structural fact rather than a guess about how Task 9 will be written: whatever
 * shape it takes, it cannot draw a ring or a scrim without one.
 *
 * That is deliberately a WEAK predicate, and weak in the safe direction. It
 * cannot be satisfied by accident, and it cannot be satisfied by anything short
 * of `render` genuinely being told the run is over. If Task 9 names the field
 * something this list does not anticipate, the test fails, Task 9 deletes the
 * file, and the interlock has done its job. **The failure mode is "Task 9 must
 * delete a file it was already going to delete", not "Task 9 is blocked".**
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is **not** a test of the shutdown screen, and it must not grow into one.
 * Task 9 owns the ring, the scrim, the score line and the restart tap, and it
 * owns their tests. Nothing here should be salvaged into that work; the correct
 * disposal is `git rm`.
 *
 * It is also **not** a claim that Task 8 is incomplete. Task 8's own acceptance
 * was the state and the loop's response to it, and both landed and are tested.
 * This guards the *gap between two commits*, which is a property of the
 * schedule rather than of either commit's code.
 */

/** Every field `RenderFrame` carries today. `paused` is the precedent a shutdown flag would follow. */
type FrameKeys = keyof RenderFrame

/**
 * Names that would mean `render` has been told the run is over. Deliberately
 * generous — a hit on ANY of them retires the interlock.
 */
const SHUTDOWN_FIELD_CANDIDATES: readonly string[] = Object.freeze([
  'gameOver',
  'over',
  'shutdown',
  'failed',
  'failedDest',
  'failedDestination',
  'overcrowd',
  'destOvercrowd',
])

describe('the shutdown interlock — Task 9 deletes this file', () => {
  it('fails while nothing can DRAW the shutdown, so the gap cannot be deployed through', () => {
    // A type-level read would be erased at run time, so the check is on the
    // source of `render`'s own interface. `RenderFrame` is the boundary: if the
    // renderer cannot be told, it cannot draw.
    const typesPath = fileURLToPath(new URL('../../render/src/types.ts', import.meta.url))
    const types = readFileSync(typesPath, 'utf8')
    const frameBlock = types.slice(types.indexOf('interface RenderFrame'))
    const declared = SHUTDOWN_FIELD_CANDIDATES.filter((name) =>
      new RegExp(`readonly\\s+${name}\\s*[?:]`).test(frameBlock),
    )

    expect(
      declared,
      'RenderFrame can now express a shutdown, so Task 9 has landed — DELETE ' +
        'packages/game/test/shutdownInterlock.test.ts, it has done its job',
    ).toEqual([])

    // Having established the UI is absent, state the consequence as the failure
    // rather than leaving it in a comment. This is the line a person reads when
    // the suite goes red.
    expect(
      false,
      `the default board ends its own run at tick ${DEMO_DEATH_TICK} (3 min 43 s) and NOTHING ` +
        'draws it: the player sees the board stop dead, taps do nothing, and there is no way ' +
        'back except closing the app — indistinguishable from a crash. Task 9 owns the ring, ' +
        'the shutdown screen and the restart tap, and deletes this file as its first act. ' +
        'DO NOT DEPLOY THIS TREE.',
    ).toBe(true)
  })

  it('is not vacuous: the predicate can be satisfied, and `paused` is the precedent', () => {
    // The interlock is worth nothing if its condition could never be met — a
    // guard that can only fail is the mirror of one that can only pass. So:
    // `paused` IS declared on `RenderFrame`, by exactly the pattern the check
    // above looks for, which proves the regex finds a real field when there is
    // one to find.
    const typesPath = fileURLToPath(new URL('../../render/src/types.ts', import.meta.url))
    const frameBlock = readFileSync(typesPath, 'utf8')
    const block = frameBlock.slice(frameBlock.indexOf('interface RenderFrame'))
    expect(/readonly\s+paused\s*[?:]/.test(block), 'the detector cannot see a field it should').toBe(
      true,
    )
    // ...and `paused` is not itself on the candidate list, or the interlock
    // would have retired the moment it was written.
    expect(SHUTDOWN_FIELD_CANDIDATES).not.toContain('paused')
    // Type-level: `paused` really is a `RenderFrame` key, so the source scan and
    // the type agree rather than the scan reading a comment.
    const pausedKey: FrameKeys = 'paused'
    expect(pausedKey).toBe('paused')
  })
})
