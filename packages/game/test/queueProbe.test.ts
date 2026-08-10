import { describe, it, expect } from 'vitest'
import {
  packRouteStep,
  canEnter,
  claimCell,
  occupantOf,
  stepCell,
  EnterOutcome,
  FREE,
  LANE_OF_DIR,
  PHASE_IDLE,
  PHASE_NONE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  type GameState,
} from '@laneways/sim'
import { NO_CROSSING, carAheadOf, longestQueue, travelDir } from '../src/queueProbe'
import { buildJamRig, JAM_W, JAM_X } from './jamFixture'

/**
 * `longestQueue` is an INSTRUMENT, and an instrument needs its own tests.
 *
 * It was added for the demo layout, where its only readers are inequality
 * thresholds — `longestQueue >= 4` over 3,000 ticks. Those are loose by design
 * (a threshold set inside the noise band is a flaky test), which makes them
 * blind: three mutations of the probe — dropping the return leg's direction
 * reversal, counting parked cars, and **keying occupancy by the cell alone** —
 * were each measured at **0 detectors** across the whole suite. Every case
 * below exists to kill one of those.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE CLAIMS OCCUPANCY SLOTS, BECAUSE THE PROBE READS THEM
 * ---------------------------------------------------------------------------
 *
 * The first version of this probe rebuilt its own `Map<cell, car>` from
 * `carCell`, which is one car per cell — in a milestone whose entire premise is
 * that a cell carries **two lanes**. It is now a read of `state.occupancy`, the
 * same slot `canEnter` consults, so a fixture has to say which slot each car
 * holds and not merely where it stands. `placeCar` therefore calls the sim's own
 * `claimCell`, exactly as a crossing does.
 *
 * **The lane a car occupies is the direction it ENTERED by, which is not
 * necessarily the direction it is now facing** — they differ at every turn and
 * at every outbound->return flip. `entryDir` is that parameter, and the two
 * cases where it differs from the travel direction are the two tests that a
 * lane-aware-but-still-reconstructed probe fails.
 *
 * The fixture is `jamFixture`'s corridor — a 16 x 20 board with a single road
 * column at `x` = 8 — with its cars overwritten by hand. That is deliberate:
 * driving a real board to a chosen queue state is a search, and a search that
 * finds one blesses whatever the probe happened to say. The last case in the
 * file is the complement: the real corridor, driven, checked against `canEnter`
 * rather than against a hand-written number.
 */

/** North, south, east and west, as `roads.ts` numbers them. */
const N = 0
const E = 2
const S = 4
const W = 6

const cellAt = (y: number): number => y * JAM_W + JAM_X
const cellXY = (x: number, y: number): number => y * JAM_W + x

/**
 * Silences every car and empties every occupancy slot, so each case starts from
 * "nothing is in flight and nobody holds anything".
 *
 * Clearing occupancy is load-bearing now that the probe reads it: a slot left
 * over from the rig's own construction would chain cars a case never placed.
 */
function parkEveryone(state: GameState): void {
  for (let c = 0; c < state.carPhase.length; c++) {
    state.carPhase[c] = PHASE_NONE
    state.carRouteLen[c] = 0
    state.carRouteCursor[c] = 0
  }
  state.occupancy.fill(FREE)
}

/**
 * Puts car `i` on `(8, y)` with a straight `len`-step route in direction `dir`,
 * at `cursor`, in `phase`, **and claims the slot it would hold having crossed
 * into that cell heading `entryDir`**.
 *
 * `dir` is the direction of the ROUTE's steps, so an outbound car travels `dir`
 * and a returning one travels its opposite. `entryDir` defaults to the direction
 * of travel — the ordinary case, a car part-way along a straight run — and is
 * passed explicitly by the two cases where a car faces one way and occupies the
 * lane of another.
 */
function placeCar(
  state: GameState,
  i: number,
  y: number,
  phase: number,
  dir: number,
  len: number,
  cursor: number,
  entryDir?: number,
): void {
  state.carCell[i] = cellAt(y)
  state.carPhase[i] = phase
  state.carRouteLen[i] = len
  state.carRouteCursor[i] = cursor
  for (let k = 0; k < len; k++) packRouteStep(state, i, k, dir)
  const travel = phase === PHASE_OUTBOUND ? dir : (dir + 4) % 8
  claimCell(state, i, cellAt(y), entryDir ?? travel)
}

function rig() {
  const r = buildJamRig('queue-probe')
  parkEveryone(r.state)
  return r
}

describe('travelDir', () => {
  it('reads the route forwards outbound and BACKWARDS returning', () => {
    const r = rig()
    placeCar(r.state, 0, 10, PHASE_OUTBOUND, N, 6, 1)
    expect(travelDir(r.state, 0)).toBe(N)
    // The return leg retraces the committed route, so an all-north route is
    // driven south on the way home.
    placeCar(r.state, 1, 10, PHASE_RETURNING, N, 6, 3)
    expect(travelDir(r.state, 1)).toBe(S)
  })

  it('answers NO_CROSSING for the three cars that have no next cell', () => {
    // Each is a real state, not a defensive default: parked, arrived, home.
    const r = rig()
    placeCar(r.state, 0, 10, PHASE_IDLE, N, 6, 0)
    expect(travelDir(r.state, 0)).toBe(NO_CROSSING)
    placeCar(r.state, 1, 10, PHASE_OUTBOUND, N, 5, 5)
    expect(travelDir(r.state, 1)).toBe(NO_CROSSING)
    placeCar(r.state, 2, 10, PHASE_RETURNING, N, 6, 0)
    expect(travelDir(r.state, 2)).toBe(NO_CROSSING)
  })
})

describe('longestQueue', () => {
  it('is 0 when nothing is in flight', () => {
    const r = rig()
    expect(longestQueue(r.state, r.world)).toBe(0)
  })

  it('IGNORES parked cars, however many are stacked on a road', () => {
    // The discriminator for "count every car, not only the driving ones". Two
    // idle cars sitting on consecutive corridor cells are not a queue — they are
    // houses. Without the phase filter in the walk this reads 1 rather than 0,
    // because every chain is at least the car itself.
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
    placeCar(r.state, 0, 10, PHASE_OUTBOUND, N, 6, 1)
    placeCar(r.state, 1, 9, PHASE_OUTBOUND, N, 5, 1)
    placeCar(r.state, 2, 8, PHASE_OUTBOUND, N, 4, 1)
    expect(longestQueue(r.state, r.world)).toBe(3)
  })

  it('does NOT chain two cars passing each other in opposite lanes', () => {
    // **The defect this probe was rewritten for.** Two in-flight cars on
    // adjacent cells, each stepping onto the other's cell, travelling opposite
    // ways: `LANE_OF_DIR[N] = 1` and `LANE_OF_DIR[S] = 0`, so neither is in the
    // slot the other is asking about and neither is blocked. The demo layout
    // advertises exactly this as a visible feature — "a car slides through a
    // standing queue in the other direction".
    //
    // A probe keyed by the cell alone answers **2**: it keeps one car per cell,
    // so the southbound car is written into the northbound car's target and
    // read back as the car in front of it.
    const r = rig()
    placeCar(r.state, 0, 10, PHASE_OUTBOUND, N, 6, 1)
    placeCar(r.state, 1, 9, PHASE_OUTBOUND, S, 6, 1)
    // Non-vacuity for the fixture itself: the two cars really are adjacent, each
    // really is stepping onto the other's cell, and the slots really are the two
    // different lanes of those cells. Without this the case is satisfied by a
    // fixture that placed nobody.
    expect(stepCell(cellAt(10), N, r.world.w, r.world.h)).toBe(cellAt(9))
    expect(stepCell(cellAt(9), S, r.world.w, r.world.h)).toBe(cellAt(10))
    expect(occupantOf(r.state, cellAt(9), LANE_OF_DIR[S] as number)).toBe(1)
    expect(occupantOf(r.state, cellAt(9), LANE_OF_DIR[N] as number)).toBe(FREE)
    expect(carAheadOf(r.state, r.world, 0)).toBe(FREE)
    expect(carAheadOf(r.state, r.world, 1)).toBe(FREE)
    expect(longestQueue(r.state, r.world)).toBe(1)
  })

  it('DOES chain onto a car that entered facing the other way — the carpark flip', () => {
    // The mirror of the case above, and the one that kills the obvious repair.
    // Keying the occupant by its own direction of TRAVEL rather than by the
    // direction it ENTERED with looks equivalent and is not: a car that has just
    // flipped to `PHASE_RETURNING` on a carpark faces south while standing in
    // the northbound lane it claimed on the way in, and the car queued behind it
    // is genuinely blocked by it.
    //
    // That variant answers **1** here, and on a starved corridor — where the
    // whole queue stands behind the car that has just flipped — it read a
    // longest queue of 11 against a true 16.
    const r = rig()
    placeCar(r.state, 0, 10, PHASE_OUTBOUND, N, 6, 1)
    // cursor === len: arrived at the top of its route and turned around, so it
    // has crossed zero times on the return leg and still holds the outbound
    // claim. `hasCrossedThisLeg`'s doc comment names exactly this asymmetry.
    placeCar(r.state, 1, 9, PHASE_RETURNING, N, 6, 6, N)
    expect(travelDir(r.state, 1)).toBe(S)
    expect(occupantOf(r.state, cellAt(9), LANE_OF_DIR[N] as number)).toBe(1)
    expect(carAheadOf(r.state, r.world, 0)).toBe(1)
    // ...and it is not a cycle: the flipped car reads the southbound lane of
    // cell 10, which the northbound car is not in.
    expect(carAheadOf(r.state, r.world, 1)).toBe(FREE)
    expect(longestQueue(r.state, r.world)).toBe(2)
  })

  it('reverses the RETURN leg’s direction — the case a straight read gets backwards', () => {
    // A returning car retraces `OPPOSITE[route[cursor - 1]]`. With an all-north
    // route, three returning cars are driving SOUTH, so the chain runs 8 -> 9 ->
    // 10 and not the other way.
    //
    // **The cell-keyed version of this test needed an asymmetric third car**,
    // because reversing the direction of a symmetric pair only swaps which car
    // is behind which and the length is unchanged. The lane key removes that
    // problem rather than working around it: reading the direction backwards
    // also reads the *other lane*, and these three cars are all in the
    // southbound one. The un-reversed mutant answers 1, not 3.
    const r = rig()
    placeCar(r.state, 0, 8, PHASE_RETURNING, N, 6, 3)
    placeCar(r.state, 1, 9, PHASE_RETURNING, N, 6, 3)
    placeCar(r.state, 2, 10, PHASE_RETURNING, N, 6, 3)
    expect(travelDir(r.state, 0)).toBe(S)
    expect(occupantOf(r.state, cellAt(9), LANE_OF_DIR[S] as number)).toBe(1)
    expect(occupantOf(r.state, cellAt(9), LANE_OF_DIR[N] as number)).toBe(FREE)
    expect(longestQueue(r.state, r.world)).toBe(3)
  })

  it('does not chain a car whose route is exhausted', () => {
    // An outbound car at `cursor === routeLen` has arrived and is waiting for
    // `runArrivals`; it has no next cell, so it cannot be counted as queueing
    // behind whatever is in front of it. It is still an OBSTACLE — it holds the
    // slot it crossed in with — which is why the chain below is 2 and not 1.
    //
    // **The third car is what makes the guard observable**: with only two, a
    // mutant that clamps the cursor to `len - 1` reads the same empty cell and
    // the answer is unchanged. With a car standing on that cell, the clamped
    // read chains all three.
    const r = rig()
    placeCar(r.state, 0, 10, PHASE_OUTBOUND, N, 6, 1)
    placeCar(r.state, 1, 9, PHASE_OUTBOUND, N, 5, 5) // exhausted, would step to y = 8
    placeCar(r.state, 2, 8, PHASE_OUTBOUND, N, 4, 1)
    expect(travelDir(r.state, 1)).toBe(NO_CROSSING)
    expect(longestQueue(r.state, r.world)).toBe(2)
  })

  it('does not chain a RETURNING car that has finished its route', () => {
    // The mirror of the exhausted-outbound case, and it needs its own fixture
    // for the same reason: a returning car at `cursor === 0` is home and waiting
    // for `runArrivals`. A mutant that clamps to `routeStep(0)` reads a real
    // direction, so the guard is only observable when the cell that read lands
    // on is occupied — and, now, occupied IN THE LANE that read would ask about.
    const r = rig()
    placeCar(r.state, 0, 9, PHASE_RETURNING, N, 6, 0) // home, cursor 0
    placeCar(r.state, 1, 10, PHASE_RETURNING, N, 6, 3) // heading south to y = 11
    expect(occupantOf(r.state, cellAt(10), LANE_OF_DIR[S] as number)).toBe(1)
    expect(longestQueue(r.state, r.world)).toBe(1)
  })

  it('stops at the board edge instead of WRAPPING into the previous row', () => {
    // The bounds check — `stepCell`'s, since that is the function `advanceCar`
    // uses and this module now calls it rather than repeating the arithmetic.
    // The fixture is the row seam rather than the top edge, because at the top
    // edge the wrapped index is negative and the lookup misses either way, so
    // the guard has no observer there.
    //
    // A car on column 0 heading WEST computes `nx = -1`, and `ny * w + nx` is
    // the LAST cell of the previous row: a real cell, with a real car on it, in
    // the lane a westbound car would read (`LANE_OF_DIR[W] = LANE_OF_DIR[N] = 1`,
    // so the lane cannot save this one).
    const r = rig()
    const w = r.world.w
    r.state.carCell[0] = cellXY(0, 5)
    r.state.carPhase[0] = PHASE_OUTBOUND
    r.state.carRouteLen[0] = 4
    r.state.carRouteCursor[0] = 1
    packRouteStep(r.state, 0, 1, W)
    claimCell(r.state, 0, cellXY(0, 5), W)
    r.state.carCell[1] = cellXY(w - 1, 4)
    r.state.carPhase[1] = PHASE_OUTBOUND
    r.state.carRouteLen[1] = 4
    r.state.carRouteCursor[1] = 1
    packRouteStep(r.state, 1, 1, N)
    claimCell(r.state, 1, cellXY(w - 1, 4), N)
    expect(cellXY(w - 1, 4)).toBe(cellXY(0, 5) - 1) // the cell a wrap would land on
    expect(LANE_OF_DIR[W]).toBe(LANE_OF_DIR[N])
    // **`toBe(FREE)`, not merely "the chain is 1", and the difference is a
    // measured 0-detector.** `stepCell` answers -1 rather than a wrapped cell,
    // so the wrap this test is named for cannot happen at all any more; what
    // `carAheadOf`'s own `next < 0` guard prevents is the out-of-range read
    // behind it, and `state.occupancy[-1]` is `undefined`, which the walk
    // happens to treat as "nobody ahead". So deleting the guard leaves the
    // LENGTH unchanged and only the return value wrong — asserting the value is
    // what gives the guard an observer.
    expect(carAheadOf(r.state, r.world, 0)).toBe(FREE)
    expect(longestQueue(r.state, r.world)).toBe(1)
  })

  it('terminates on a cycle rather than walking forever', () => {
    // **The visited set, and the 2-cycle it exists for is REACHABLE now.** The
    // cell-keyed probe argued that two cars could never each be waiting for the
    // other, because opposite directions land in different lanes. Reading the
    // real slots ends that argument: two cars that have each just turned around
    // on adjacent cells both stand in the lane opposite to the way they now
    // face, so each IS the occupant of the slot the other is asking about.
    //
    // **Its mutant HANGS rather than failing an assertion**, which is not a
    // clean kill and is recorded as such: the value below is the observer, and a
    // hung suite is the signal that the set was removed.
    const r = rig()
    // Car 0 drove north to y = 8 and flipped: faces south, stands in lane 1.
    placeCar(r.state, 0, 8, PHASE_RETURNING, N, 6, 6, N)
    // Car 1 drove south to y = 9 and flipped: faces north, stands in lane 0.
    placeCar(r.state, 1, 9, PHASE_RETURNING, S, 6, 6, S)
    expect(carAheadOf(r.state, r.world, 0)).toBe(1)
    expect(carAheadOf(r.state, r.world, 1)).toBe(0)
    // A third car feeds the cycle from the side — east onto (8, 9), which is
    // `LANE_OF_DIR[E] = 0`, the lane car 1 is standing in. The walk is therefore
    // three long and then meets itself.
    r.state.carCell[2] = cellXY(JAM_X - 1, 9)
    r.state.carPhase[2] = PHASE_OUTBOUND
    r.state.carRouteLen[2] = 4
    r.state.carRouteCursor[2] = 1
    packRouteStep(r.state, 2, 1, E)
    claimCell(r.state, 2, cellXY(JAM_X - 1, 9), E)
    expect(carAheadOf(r.state, r.world, 2)).toBe(1)
    expect(longestQueue(r.state, r.world)).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// The complement: the real corridor, against the sim's own answer
// ---------------------------------------------------------------------------

describe('the probe asks the same question canEnter does', () => {
  it('agrees on every car, on every tick, over 900 ticks of the real corridor', () => {
    // **The claim this module rests on, as a property rather than a figure.**
    // Every case above is a hand-built state, and a hand-built state is only
    // ever evidence about the shape somebody thought to write. This drives the
    // corridor with `step` and asks, for every in-flight car with a next cell,
    // whether the probe's answer and `canEnter`'s agree — where `canEnter` is
    // the production function whose refusal IS what a queue is made of.
    //
    // What it pins is the KEY and the direction derivation: keying by the cell
    // alone disagrees on 11.1 % of the questions here, and keying by the car's
    // own direction of travel on 7.4 %. What it cannot pin is the *meaning* of a
    // lane — both sides read `LANE_OF_DIR` — which is `roads.ts`'s to own.
    const rig = buildJamRig('probe-vs-canenter')
    let asked = 0
    let blocked = 0
    let free = 0
    for (let t = 0; t < 900; t++) {
      rig.drive(1)
      const state = rig.state
      for (let c = 0; c < state.carPhase.length; c++) {
        const dir = travelDir(state, c)
        if (dir === NO_CROSSING) continue
        const next = stepCell(state.carCell[c] as number, dir, rig.world.w, rig.world.h)
        if (next < 0) continue
        const outcome = canEnter(state, rig.world, c, next, dir)
        const simSaysBlocked =
          outcome === EnterOutcome.REFUSED_OCCUPIED || outcome === EnterOutcome.ENTER_VALVE
        const probeSaysBlocked = carAheadOf(state, rig.world, c) !== FREE
        expect(probeSaysBlocked, `tick ${t}, car ${c}: canEnter said ${outcome}`).toBe(
          simSaysBlocked,
        )
        asked++
        if (simSaysBlocked) blocked++
        else free++
      }
    }
    // Non-vacuity, in both directions: a run where nothing was ever asked, or
    // where every answer was the same, would satisfy the loop above and prove
    // nothing. Measured: 14,294 questions, of which about a fifth are refusals.
    expect(asked).toBeGreaterThan(10000)
    expect(blocked).toBeGreaterThan(1000)
    expect(free).toBeGreaterThan(1000)
  })
})
