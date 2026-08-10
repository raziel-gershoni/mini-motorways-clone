import { describe, it, expect } from 'vitest'
import {
  packRouteStep,
  PHASE_IDLE,
  PHASE_NONE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  type GameState,
} from '@laneways/sim'
import { longestQueue } from '../src/queueProbe'
import { buildJamRig, JAM_W, JAM_X } from './jamFixture'

/**
 * `longestQueue` is an INSTRUMENT, and an instrument needs its own tests.
 *
 * It was added for the demo layout, where its only readers are inequality
 * thresholds — `longestQueue >= 4` over 3,000 ticks. Those are loose by design
 * (a threshold set inside the noise band is a flaky test), which makes them
 * blind: two mutations of the probe, dropping the return leg's direction
 * reversal and counting parked cars, were measured at **0 detectors** across
 * the whole suite. Every case below exists to kill one of those.
 *
 * The fixture is `jamFixture`'s corridor — a 16 x 20 board with a single road
 * column at `x` = 8 — with its cars overwritten by hand. That is deliberate:
 * driving a real board to a chosen queue state is a search, and a search that
 * finds one blesses whatever the probe happened to say.
 */

const cellAt = (y: number): number => y * JAM_W + JAM_X

/** Silences every car, so each case starts from "nothing is in flight". */
function parkEveryone(state: GameState): void {
  for (let c = 0; c < state.carPhase.length; c++) {
    state.carPhase[c] = PHASE_NONE
    state.carRouteLen[c] = 0
    state.carRouteCursor[c] = 0
  }
}

/**
 * Puts car `i` on `(8, y)` with a straight `len`-step route in direction `dir`,
 * at `cursor`, in `phase`. Direction 0 is north and 4 is south (`DX`/`DY`).
 */
function placeCar(
  state: GameState,
  i: number,
  y: number,
  phase: number,
  dir: number,
  len: number,
  cursor: number,
): void {
  state.carCell[i] = cellAt(y)
  state.carPhase[i] = phase
  state.carRouteLen[i] = len
  state.carRouteCursor[i] = cursor
  for (let k = 0; k < len; k++) packRouteStep(state, i, k, dir)
}

function rig() {
  const r = buildJamRig('queue-probe')
  parkEveryone(r.state)
  return r
}

describe('longestQueue', () => {
  it('is 0 when nothing is in flight', () => {
    const r = rig()
    expect(longestQueue(r.state, r.world)).toBe(0)
  })

  it('IGNORES parked cars, however many are stacked on a road', () => {
    // The discriminator for "count every car, not only the driving ones". Three
    // idle cars sitting on consecutive corridor cells are not a queue — they are
    // houses. Without the phase filter this reads 1 rather than 0, because
    // `carAt` is populated and every chain is at least the car itself.
    const r = rig()
    r.state.carPhase[0] = PHASE_IDLE
    r.state.carCell[0] = cellAt(8)
    r.state.carPhase[1] = PHASE_IDLE
    r.state.carCell[1] = cellAt(9)
    expect(longestQueue(r.state, r.world)).toBe(0)
  })

  it('counts a chain of OUTBOUND cars, each standing on the next one’s cell', () => {
    // North is direction 0, so a car at y = 10 steps to y = 9. Three cars on
    // 10, 9, 8 are a queue of three; the car at 8 has nobody ahead.
    const r = rig()
    placeCar(r.state, 0, 10, PHASE_OUTBOUND, 0, 6, 0)
    placeCar(r.state, 1, 9, PHASE_OUTBOUND, 0, 5, 0)
    placeCar(r.state, 2, 8, PHASE_OUTBOUND, 0, 4, 0)
    expect(longestQueue(r.state, r.world)).toBe(3)
  })

  it('does not chain cars that are merely NEAR each other', () => {
    // Non-vacuity for the case above: three cars on the same three cells, but
    // the middle one facing away, is not a chain of three. Without this, a probe
    // that ignored direction entirely and just counted adjacent cars would pass.
    const r = rig()
    placeCar(r.state, 0, 10, PHASE_OUTBOUND, 0, 6, 0)
    placeCar(r.state, 1, 9, PHASE_OUTBOUND, 4, 5, 0) // heading south, back at 10
    placeCar(r.state, 2, 8, PHASE_OUTBOUND, 0, 4, 0)
    // 0 -> 1 (0 steps north onto 9) and 1 -> 0 (1 steps south onto 10): a
    // 2-cycle, which the visited set stops at length 2. Car 2 stands alone.
    expect(longestQueue(r.state, r.world)).toBe(2)
  })

  it('reverses the RETURN leg’s direction — the case a straight read gets backwards', () => {
    // A returning car retraces `OPPOSITE[route[cursor - 1]]`. With a route of
    // all-north steps, a returning car at y = 8 is heading SOUTH to y = 9.
    //
    // **The fixture has to be ASYMMETRIC, and the obvious one is not.** Two
    // returning cars on adjacent cells give a chain of 2 either way — the
    // mutation only swaps which is behind which. So a THIRD car sits north of
    // the pair, heading away: the correct read chains B -> C southward and
    // leaves A alone (longest 2), while reading the un-reversed direction
    // chains C -> B -> A northward (longest 3).
    const r = rig()
    placeCar(r.state, 0, 7, PHASE_OUTBOUND, 0, 6, 0) // A, heading north to y = 6
    placeCar(r.state, 1, 8, PHASE_RETURNING, 0, 6, 3) // B, heading south to y = 9
    placeCar(r.state, 2, 9, PHASE_RETURNING, 0, 6, 2) // C, heading south to y = 10
    expect(longestQueue(r.state, r.world)).toBe(2)
    // The cells both readings look at are occupied and empty respectively, so
    // the case fails for the right reason rather than by coincidence.
    let atSix = 0
    let atTen = 0
    for (let c = 0; c < r.state.carPhase.length; c++) {
      if ((r.state.carPhase[c] as number) === PHASE_NONE) continue
      if ((r.state.carCell[c] as number) === cellAt(6)) atSix++
      if ((r.state.carCell[c] as number) === cellAt(10)) atTen++
    }
    expect(atSix).toBe(0)
    expect(atTen).toBe(0)
  })

  it('does not chain a car whose route is exhausted', () => {
    // An outbound car at `cursor === routeLen` has arrived and is waiting for
    // `runArrivals`; it has no next cell, so it cannot be counted as queueing
    // behind whatever is in front of it.
    //
    // **The third car is what makes the guard observable**: with only two, a
    // mutant that clamps the cursor to `len - 1` reads the same empty cell and
    // the answer is unchanged. With a car standing on that cell, the clamped
    // read chains all three.
    const r = rig()
    placeCar(r.state, 0, 10, PHASE_OUTBOUND, 0, 6, 0)
    placeCar(r.state, 1, 9, PHASE_OUTBOUND, 0, 5, 5) // exhausted, would step to y = 8
    placeCar(r.state, 2, 8, PHASE_OUTBOUND, 0, 4, 0)
    expect(longestQueue(r.state, r.world)).toBe(2)
  })

  it('does not chain a RETURNING car that has finished its route', () => {
    // The mirror of the exhausted-outbound case, and it needs its own fixture
    // for the same reason: a returning car at `cursor === 0` is home and
    // waiting for `runArrivals`. A mutant that clamps to `routeStep(0)` reads a
    // real direction, so the guard is only observable when the cell that read
    // lands on is occupied.
    //
    // Route is all-north, so the clamped read reverses to SOUTH — car 0 at
    // y = 9 would chain onto car 1 at y = 10.
    const r = rig()
    placeCar(r.state, 0, 9, PHASE_RETURNING, 0, 6, 0) // home, cursor 0
    placeCar(r.state, 1, 10, PHASE_RETURNING, 0, 6, 2) // heading south to y = 11
    expect(longestQueue(r.state, r.world)).toBe(1)
  })

  it('stops at the board edge instead of WRAPPING into the previous row', () => {
    // The bounds check, and the fixture is the row seam rather than the top
    // edge — because at the top edge the wrapped index is negative and the
    // `Map` lookup misses either way, so the guard has no observer there.
    //
    // A car on column 0 heading WEST computes `nx = -1`, and `ny * w + nx` is
    // the LAST cell of the previous row: a real cell, with a real car on it.
    // Without the check the two chain, which is the "row-seam self-blindness"
    // this codebase guards against in `dirBetween` and `carparkCell` for
    // exactly the same reason.
    const r = rig()
    const w = r.world.w
    r.state.carCell[0] = 5 * w + 0
    r.state.carPhase[0] = PHASE_OUTBOUND
    r.state.carRouteLen[0] = 4
    r.state.carRouteCursor[0] = 0
    packRouteStep(r.state, 0, 0, 6) // west
    r.state.carCell[1] = 4 * w + (w - 1)
    r.state.carPhase[1] = PHASE_OUTBOUND
    r.state.carRouteLen[1] = 4
    r.state.carRouteCursor[1] = 0
    packRouteStep(r.state, 1, 0, 0)
    expect(4 * w + (w - 1)).toBe(5 * w - 1) // the cell a wrap would land on
    expect(longestQueue(r.state, r.world)).toBe(1)
  })

  it('terminates on a 3-cycle rather than walking forever', () => {
    // The visited set. A cycle of length >= 3 is precisely the deadlock
    // `MAX_BLOCKED_TICKS` exists for, and it is reachable in production; without
    // the set this walk does not terminate.
    //
    // **Its mutant HANGS rather than failing an assertion**, which is not a
    // clean kill and is recorded as such: the value below is the observer, and
    // a hung suite is the signal that the set was removed.
    const r = rig()
    // Three cars in a ring on cells 8, 9, 10: 8 -> 9 -> 10 -> 8 is impossible
    // with straight routes, so the ring is built from the cursor instead — car 2
    // at y = 10 heading north to 9, car 1 at 9 heading north to 8, car 0 at 8
    // heading south to 9. That is a 2-cycle between 0 and 1 with 2 feeding it.
    placeCar(r.state, 0, 8, PHASE_OUTBOUND, 4, 6, 0)
    placeCar(r.state, 1, 9, PHASE_OUTBOUND, 0, 6, 0)
    placeCar(r.state, 2, 10, PHASE_OUTBOUND, 0, 6, 0)
    expect(longestQueue(r.state, r.world)).toBe(3)
  })
})
