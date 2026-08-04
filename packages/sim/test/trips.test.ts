import { describe, it, expect } from 'vitest'
import { parseMap, CARS_PER_HOUSE, type MapData } from '@laneways/shared'
import { createState, H_SCORE, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { packRouteStep, ROUTE_BYTES } from '../src/dispatch'
import {
  placeHouse,
  PHASE_IDLE,
  PHASE_NONE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
} from '../src/buildings'
import { runArrivals } from '../src/trips'

/**
 * Unit coverage for phase 7 — arrival, pin consumption, reservation release,
 * scoring, and the trip-end slot reset. The end-to-end wiring lives in
 * `loop.test.ts`; everything here drives `runArrivals` DIRECTLY, never through
 * `step`, for the reason the plan gives for the arrival-order construction: an
 * arrival assert that throws part-way through the loop would otherwise leave
 * `H_EPOCH` non-zero and poison the buffer, and the state under inspection
 * would be unreadable through `restore`.
 *
 * **Several fixtures here are deliberately OFF the reachable manifold** and say
 * so at each site. `runArrivals` is the phase that owns two proved invariants
 * (`destReserved <= destPins`, and `routeLen >= 1` for any committed route), so
 * the only way to observe what it does when one of them breaks — which is what
 * pins the iteration order and the anti-double-act rule — is to hand-write the
 * broken state. That is the idiom the plan already mandates for the corrupted
 * `dir` cycle.
 */

const W = 8
const H = 6

function allLandRows(w: number, h: number): string[] {
  const row = '.'.repeat(w)
  return Array.from({ length: h }, () => row)
}

function fixture(id: string): { map: MapData; world: WorldData } {
  const map = parseMap(id, allLandRows(W, H), 99, 40, 16, 5)
  return { map, world: createWorld(map) }
}

function rig(id: string): { state: GameState; world: WorldData } {
  const { map, world } = fixture(id)
  return { state: createState('trips', map), world }
}

/** Every byte of car `i`'s `ROUTE_BYTES` slice. */
function routeBytesOf(state: GameState, i: number): number[] {
  const out: number[] = []
  for (let b = 0; b < ROUTE_BYTES; b++) out.push(state.carRoute[i * ROUTE_BYTES + b] as number)
  return out
}

/**
 * The WHOLE of car `i`'s slot, as one comparable value — every per-car region
 * this milestone declares. Compared as a slot rather than field by field
 * because the plan's trip-end rule is a statement about the car's BYTES: after
 * a completed trip the slot must be byte-identical to a freshly created car's,
 * which is what makes "leave `carTargetDest` set" and "skip the route zeroing"
 * observable at all.
 */
function slotOf(state: GameState, i: number): Record<string, unknown> {
  return {
    carHome: state.carHome[i] as number,
    carCell: state.carCell[i] as number,
    carProgress: state.carProgress[i] as number,
    carTargetDest: state.carTargetDest[i] as number,
    carRouteLen: state.carRouteLen[i] as number,
    carRouteCursor: state.carRouteCursor[i] as number,
    carPhase: state.carPhase[i] as number,
    carRoute: routeBytesOf(state, i),
  }
}

/** DIRS indices (roads.ts): 2 = E, 6 = W. */
const E = 2
const W_DIR = 6

/**
 * Puts car `i` in the state dispatch would leave it in immediately AFTER its
 * outbound route ran out: `PHASE_OUTBOUND`, `cursor === routeLen`, a real
 * committed route, a target destination, and carried progress.
 *
 * `progress` is non-zero on purpose. The carry has to survive the
 * outbound -> return flip (decision 3), and a fixture that flipped from zero
 * progress could not tell "carried" from "reset".
 */
function outboundExhausted(
  state: GameState,
  i: number,
  dest: number,
  route: readonly number[],
  cell: number,
  progress: number,
): void {
  for (let s = 0; s < route.length; s++) packRouteStep(state, i, s, route[s] as number)
  state.carCell[i] = cell
  state.carRouteLen[i] = route.length
  state.carRouteCursor[i] = route.length
  state.carProgress[i] = progress
  state.carTargetDest[i] = dest
  state.carPhase[i] = PHASE_OUTBOUND
}

/** Puts car `i` in the state movement leaves it in when its RETURN route runs out: cursor back at 0. */
function returnExhausted(
  state: GameState,
  i: number,
  dest: number,
  route: readonly number[],
  cell: number,
  progress: number,
): void {
  for (let s = 0; s < route.length; s++) packRouteStep(state, i, s, route[s] as number)
  state.carCell[i] = cell
  state.carRouteLen[i] = route.length
  state.carRouteCursor[i] = 0
  state.carProgress[i] = progress
  state.carTargetDest[i] = dest
  state.carPhase[i] = PHASE_RETURNING
}

describe('arrival at the destination', () => {
  /** One house (cars 0 and 1), one notional destination index 0 holding pins. */
  function arrivalRig(pins: number, reserved: number): { state: GameState; world: WorldData } {
    const r = rig('arrival')
    expect(placeHouse(r.state, r.world, 10, 0)).toBe(true)
    r.state.destPins[0] = pins
    r.state.destReserved[0] = reserved
    return r
  }

  it('consumes exactly one pin, releases exactly one reservation, and flips to RETURNING', () => {
    const { state } = arrivalRig(3, 2)
    outboundExhausted(state, 0, 0, [E, E], 12, 1400)

    runArrivals(state)

    expect(state.destPins[0]).toBe(2) // exactly one, not two and not zero
    expect(state.destReserved[0]).toBe(1)
    expect(state.carPhase[0]).toBe(PHASE_RETURNING)
  })

  it('leaves the cursor at routeLen so the return leg retraces the whole route', () => {
    const { state } = arrivalRig(1, 1)
    outboundExhausted(state, 0, 0, [E, E, E], 13, 900)

    runArrivals(state)

    expect(state.carRouteCursor[0]).toBe(3)
    expect(state.carRouteLen[0]).toBe(3)
  })

  it('carries progress across the outbound -> return flip rather than resetting it', () => {
    const { state } = arrivalRig(1, 1)
    outboundExhausted(state, 0, 0, [E, E], 12, 1400)

    runArrivals(state)

    // Vacuity: 1400 is genuinely non-zero, so "reset to 0" is distinguishable.
    expect(state.carProgress[0]).toBe(1400)
  })

  it('does NOT credit the score on pickup — the score moves on return home, not here', () => {
    const { state } = arrivalRig(1, 1)
    outboundExhausted(state, 0, 0, [E, E], 12, 1400)
    expect(state.header[H_SCORE]).toBe(0)

    runArrivals(state)

    expect(state.header[H_SCORE]).toBe(0)
    // Vacuity: the arrival genuinely happened, so a score of 0 is the rule
    // rather than the arrival simply not firing.
    expect(state.destPins[0]).toBe(0)
    expect(state.carPhase[0]).toBe(PHASE_RETURNING)
  })

  it('leaves the route bytes and the target destination alone — only trip END clears them', () => {
    const { state } = arrivalRig(1, 1)
    outboundExhausted(state, 0, 0, [E, W_DIR, E], 13, 900)
    const before = routeBytesOf(state, 0)

    runArrivals(state)

    expect(routeBytesOf(state, 0)).toEqual(before)
    expect(state.carTargetDest[0]).toBe(0)
    // Vacuity: the route bytes are genuinely non-zero, so "equal to before" is
    // not two empty arrays agreeing.
    expect(before.some((b) => b !== 0)).toBe(true)
  })

  it('each of two cars arriving in one call consumes its own pin', () => {
    const { state } = arrivalRig(2, 2)
    outboundExhausted(state, 0, 0, [E], 11, 100)
    outboundExhausted(state, 1, 0, [E], 11, 100)

    runArrivals(state)

    expect(state.destPins[0]).toBe(0)
    expect(state.destReserved[0]).toBe(0)
    expect(state.carPhase[0]).toBe(PHASE_RETURNING)
    expect(state.carPhase[1]).toBe(PHASE_RETURNING)
  })

  it('throws a named error when the destination holds no pin (a proved invariant, not a branch)', () => {
    // OFF-MANIFOLD. Decision 4 proves `destReserved <= destPins`: dispatch
    // increments `destReserved` only when `destPins - destReserved > 0`, and
    // arrivals decrement both together. A car arriving at an empty destination
    // therefore cannot happen in M1c, and this is a loud failure of that
    // invariant rather than a case with a behaviour.
    const { state } = arrivalRig(0, 1)
    outboundExhausted(state, 0, 0, [E], 11, 100)

    expect(() => runArrivals(state)).toThrow(/destPins/)
  })

  it('throws a named error when the destination holds no reservation to release', () => {
    // OFF-MANIFOLD, same proved invariant read the other way. Without this the
    // `destReserved` decrement would wrap a `Uint8Array` slot from 0 to 255 —
    // silently granting a destination 255 phantom reservations, which
    // permanently excludes it from dispatch with nothing to point at. See the
    // report: the plan names only the `destPins` assert; this is the sibling
    // it does not name, and it gets its own test rather than shipping as an
    // unobserved guard.
    const { state } = arrivalRig(1, 0)
    outboundExhausted(state, 0, 0, [E], 11, 100)

    expect(() => runArrivals(state)).toThrow(/destReserved/)
  })
})

describe('trip completion at home', () => {
  /**
   * TWO houses at different cells, the car's own home at the HIGHER index and
   * NOT the lower-indexed one — so "free the car at house 0", "free it at the
   * first house" and "free it at the nearest house" all land on a different
   * cell than `carHome`'s.
   */
  function homeRig(): { state: GameState; world: WorldData } {
    const r = rig('home')
    expect(placeHouse(r.state, r.world, 10, 0)).toBe(true) // house 0 -> cars 0, 1
    expect(placeHouse(r.state, r.world, 20, 0)).toBe(true) // house 1 -> cars 2, 3
    r.state.destPins[0] = 0
    r.state.destReserved[0] = 0
    return r
  }

  it('credits the score by exactly one and parks the car at its OWN house cell', () => {
    const { state } = homeRig()
    // Car 2 belongs to house 1 (cell 20). It is standing on house 0's cell
    // when the trip ends, so "leave carCell where it is" is distinguishable
    // from "write houseCell[carHome]", and so is "write houseCell[0]".
    returnExhausted(state, 2, 0, [E, E], 10, 1400)
    expect(state.carHome[2]).toBe(1)

    runArrivals(state)

    expect(state.header[H_SCORE]).toBe(1)
    expect(state.carCell[2]).toBe(20)
    expect(state.carCell[2]).not.toBe(10)
  })

  it('leaves the car slot byte-identical to a freshly created car of the same house', () => {
    const { state } = homeRig()
    returnExhausted(state, 2, 0, [E, W_DIR, E], 20, 1400)
    // Car 3 is house 1's other car and has never been dispatched: it IS the
    // freshly created slot, with the same `carHome`, taken from the same
    // fixture rather than described by a literal.
    const fresh = slotOf(state, 3)
    expect(fresh['carPhase']).toBe(PHASE_IDLE) // vacuity: car 3 is genuinely a live, fresh car

    runArrivals(state)

    expect(slotOf(state, 2)).toEqual(fresh)
  })

  it('zeroes the WHOLE ROUTE_BYTES slice, not just the prefix the route used', () => {
    const { state } = homeRig()
    // Every byte of the slice dirtied first, with a route of only 2 steps: a
    // prefix-only clear leaves ROUTE_BYTES - 1 bytes at 0xff.
    for (let b = 0; b < ROUTE_BYTES; b++) state.carRoute[2 * ROUTE_BYTES + b] = 0xff
    returnExhausted(state, 2, 0, [E, E], 20, 0) // overwrites byte 0 only: two steps, two nibbles
    // Vacuity: bytes 1..ROUTE_BYTES-1 are genuinely dirty, so a prefix-only
    // clear (the mutation this test exists for) leaves observable garbage.
    expect(routeBytesOf(state, 2).slice(1).every((b) => b === 0xff)).toBe(true)

    runArrivals(state)

    expect(routeBytesOf(state, 2)).toEqual(new Array(ROUTE_BYTES).fill(0))
    // And it did not run over into car 3's slice.
    expect(state.carRoute[3 * ROUTE_BYTES]).toBe(0)
  })

  it('clears carTargetDest back to -1, never to 0 (which is a real destination index)', () => {
    const { state } = homeRig()
    returnExhausted(state, 2, 0, [E], 20, 0)

    runArrivals(state)

    expect(state.carTargetDest[2]).toBe(-1)
  })

  it('resets carProgress to 0 at trip end', () => {
    const { state } = homeRig()
    returnExhausted(state, 2, 0, [E], 20, 1400)

    runArrivals(state)

    expect(state.carProgress[2]).toBe(0)
  })

  it('consumes no pin and releases no reservation at trip end — that happened at the destination', () => {
    const { state } = homeRig()
    state.destPins[0] = 4
    state.destReserved[0] = 2
    returnExhausted(state, 2, 0, [E], 20, 0)

    runArrivals(state)

    expect(state.destPins[0]).toBe(4)
    expect(state.destReserved[0]).toBe(2)
  })
})

describe('cars runArrivals must not touch', () => {
  function midRig(): { state: GameState; world: WorldData } {
    const r = rig('mid')
    expect(placeHouse(r.state, r.world, 10, 0)).toBe(true)
    r.state.destPins[0] = 5
    r.state.destReserved[0] = 5
    return r
  }

  it('an OUTBOUND car whose cursor has not reached routeLen is left exactly as it was', () => {
    const { state } = midRig()
    outboundExhausted(state, 0, 0, [E, E, E], 13, 900)
    state.carRouteCursor[0] = 2 // mid-route, one step short
    const before = slotOf(state, 0)

    runArrivals(state)

    expect(slotOf(state, 0)).toEqual(before)
    expect(state.destPins[0]).toBe(5)
    expect(state.header[H_SCORE]).toBe(0)
  })

  it('a RETURNING car whose cursor has not reached 0 is left exactly as it was', () => {
    const { state } = midRig()
    returnExhausted(state, 0, 0, [E, E, E], 13, 900)
    state.carRouteCursor[0] = 1 // one step from home
    const before = slotOf(state, 0)

    runArrivals(state)

    expect(slotOf(state, 0)).toEqual(before)
    expect(state.header[H_SCORE]).toBe(0)
  })

  /**
   * The negative assertion below needs its own note, per the standing rule
   * that "X does not happen" is only meaningful once everything ELSE that
   * would produce the same observation is disabled.
   *
   * A fresh `PHASE_IDLE` car has `carRouteCursor === 0` and `carRouteLen === 0`
   * — so `cursor >= routeLen` is TRUE for it, and `cursor <= 0` is TRUE for it
   * as well. Neither of the two cursor tests can prevent an idle car being
   * collected: the phase byte is the ONLY thing that does. That is what makes
   * this test able to see "drop the phase test" rather than merely agree with
   * it, and it is why the destination is stocked with pins (so a spurious
   * arrival would find one) and the score is asserted (so a spurious
   * completion would show).
   */
  it('an IDLE car is not collected, even though both cursor tests are satisfied for it', () => {
    const { state } = midRig()
    const before = slotOf(state, 0)
    expect(before['carPhase']).toBe(PHASE_IDLE)
    expect(before['carRouteCursor']).toBe(0)
    expect(before['carRouteLen']).toBe(0)

    runArrivals(state)

    expect(slotOf(state, 0)).toEqual(before)
    expect(state.header[H_SCORE]).toBe(0)
    expect(state.destPins[0]).toBe(5)
    expect(state.destReserved[0]).toBe(5)
  })

  it('a PHASE_NONE slot past the live car prefix is not collected either', () => {
    const { state } = midRig()
    const ghost = CARS_PER_HOUSE * 3 // no house owns it; every byte is 0
    expect(state.carPhase[ghost]).toBe(PHASE_NONE)
    const before = slotOf(state, ghost)

    runArrivals(state)

    expect(slotOf(state, ghost)).toEqual(before)
    expect(state.header[H_SCORE]).toBe(0)
  })
})

describe('the anti-double-act invariant, and iteration order', () => {
  it('makes at most one phase transition per car per call, even for a zero-length route', () => {
    // OFF-MANIFOLD: dispatch refuses a zero-length route precisely so a car
    // cannot complete a trip without moving, so `routeLen === 0` with
    // `PHASE_OUTBOUND` is not reachable through `runDispatch`. It is the only
    // state in which the OUTBOUND -> RETURNING flip leaves `cursor === 0`, and
    // therefore the only one in which an implementation that RE-READS the
    // phase byte after writing it would collect the same car twice in one
    // call. The plan argues the double act is unreachable in arrivals; this
    // is the witness that the argument does not have to be trusted.
    const r = rig('double-act')
    expect(placeHouse(r.state, r.world, 10, 0)).toBe(true)
    r.state.destPins[0] = 1
    r.state.destReserved[0] = 1
    r.state.carTargetDest[0] = 0
    r.state.carRouteLen[0] = 0
    r.state.carRouteCursor[0] = 0
    r.state.carPhase[0] = PHASE_OUTBOUND

    runArrivals(r.state)

    expect(r.state.carPhase[0]).toBe(PHASE_RETURNING)
    expect(r.state.header[H_SCORE]).toBe(0)
    expect(r.state.destPins[0]).toBe(0)
  })

  it('iterates cars in ascending index — witnessed off the reachable manifold', () => {
    // OFF-MANIFOLD, and it has to be: every write the arrivals phase makes is
    // either per-car or a commutative counter, so on the reachable manifold
    // ascending and descending produce byte-identical states and a bullet
    // asserting the order would be vacuous. The construction the plan
    // prescribes breaks the one invariant that makes the order invisible —
    // `destReserved <= destPins` — so that the named arrival assert throws
    // PART-WAY through the loop and the phase bytes record how far it got.
    //
    // Driven through `runArrivals` directly, never through `step`: a throw
    // inside `step` would leave `H_EPOCH` non-zero and poison the buffer.
    const r = rig('ascending')
    expect(placeHouse(r.state, r.world, 10, 0)).toBe(true)
    const i = 0
    const j = 1
    r.state.destPins[0] = 1
    r.state.destReserved[0] = 2 // one more than there are pins: the broken invariant
    outboundExhausted(r.state, i, 0, [E], 11, 0)
    outboundExhausted(r.state, j, 0, [E], 11, 0)

    expect(() => runArrivals(r.state)).toThrow(/destPins/)

    // Ascending reached `i` first: `i` consumed the only pin and flipped,
    // `j` found none and threw. Descending would show the exact mirror.
    expect(r.state.carPhase[i]).toBe(PHASE_RETURNING)
    expect(r.state.carPhase[j]).toBe(PHASE_OUTBOUND)
  })
})
