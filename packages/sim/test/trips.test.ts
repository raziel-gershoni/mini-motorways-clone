import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  parseMap,
  CARS_PER_HOUSE,
  FIRST_PIN_DELAY_TICKS,
  PIN_CAP_SQUARE_TIMER,
  type MapData,
} from '@laneways/shared'
import { createState, H_SCORE, H_DEST_COUNT, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { packRouteStep, ROUTE_BYTES } from '../src/dispatch'
import {
  placeDestination,
  placeHouse,
  DEST_KIND_SQUARE,
  ORIENTATION_E,
  PHASE_IDLE,
  PHASE_NONE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
} from '../src/buildings'
import { runArrivals, assertArrivalHonoured } from '../src/trips'
import { isOverCapacity } from '../src/overcrowd'
import { spawnZoneCells } from '../src/spawn'
import { step, type TickInputs } from '../src/step'
import { createScratch, createFlowFields, type Scratch, type FlowField } from '../src/scratch'
import { createFieldInputRanges } from '../src/regions'
import { tilesLeft, ghostMaskOf, ghostCommittedOf } from '../src/roads'
import { claimCell, occupantOf, FREE } from '../src/blocking'

const NO_INPUT: TickInputs = Object.freeze({ actions: Object.freeze([]) })

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

describe('arrivals cannot re-path and cannot search for a house, by signature', () => {
  /**
   * `trips.ts`'s module header calls its signature "the primary defence,
   * exactly as it is in `cars.ts`" — and the first version of this file did not
   * back that claim with anything, while `cars.test.ts:642-654` backs the
   * identical claim about `runMovement` with two live tests. Adding a `fields`
   * parameter and wiring `step` to pass it passed the whole suite.
   *
   * **The shape of that gap is worth naming, because it is not the ordinary
   * "comment overstates its case".** The unverified claim was used as the
   * REASON not to run two plan-named mutations ("read a field in arrivals",
   * "return to the nearest house") as executable mutants — the argument being
   * that they are not constructible against a module with neither a field nor a
   * geometry in scope. That argument is sound, but only while the structure
   * holds, and nothing held it. An overstated comment that merely decorates
   * code is cheap; one that discharges a testing obligation silently REMOVES
   * coverage rather than merely failing to add it. Cite a structural defence as
   * grounds for skipping a mutation only after pinning the structure.
   */
  it('takes state and nothing else — no world, no fields, no scratch', () => {
    expect(runArrivals.length).toBe(1)
  })

  it('imports neither the flow field, the scratch module nor the world, and looks up no house but its own', () => {
    // A source assertion, in the idiom `determinism.test.ts` and
    // `cars.test.ts` already use: the arity pin above can be defeated by
    // reaching for a module-level import, and this cannot. Matching on the
    // import specifier rather than a bare word keeps it immune to this file's
    // own prose and to `trips.ts`'s own comments.
    const source = readFileSync(fileURLToPath(new URL('../src/trips.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/from '\.\/flowfield'/)
    expect(source).not.toMatch(/from '\.\/scratch'/)
    expect(source).not.toMatch(/from '\.\/world'/)
    expect(source).not.toMatch(/\bfield\w*\s*\.\s*dir\b/)
    // The return leg has no house search at all: `houseCell` may be indexed by
    // `carHome[i]` and by nothing else. This is what makes "return to the
    // nearest house" unconstructible here rather than merely untested — the
    // claim the report leans on.
    //
    // Phrased as "every `houseCell[` in this file is indexed by `carHome`"
    // rather than as an exact-string match, deliberately: the exact-string
    // form fires on this module's own PROSE (its header names
    // `houseCell[carHome]` when explaining the rule), which is the
    // self-referential fragility `cars.test.ts` documents avoiding. A
    // comment that mentions `carHome` is harmless; a line of code that
    // indexes `houseCell` by anything else is exactly the mutation.
    const houseReads = source.match(/houseCell\s*\[[^\]]*/g) ?? []
    expect(houseReads.length).toBeGreaterThan(0) // vacuity: the scan found something to check
    for (let i = 0; i < houseReads.length; i++) {
      expect(houseReads[i], 'houseCell must only ever be indexed by carHome').toMatch(/carHome/)
    }
    // Vacuity: the scan is looking at the right file, and at code rather than
    // at an empty string.
    expect(source).toMatch(/export function runArrivals/)
  })
})

describe('assertArrivalHonoured, called directly', () => {
  /**
   * The doc comment says `@internal Exported for testing only; runArrivals is
   * the real call site`, and cites four precedents — every one of which IS
   * directly imported by its own test file. This is the direct test that makes
   * the sentence true. Without it the export claimed a call site that did not
   * exist, and the parameterisation the four precedents exist to justify (make
   * an unreachable throw reachable from a test, rather than leaving it as the
   * one branch nothing executes) bought nothing.
   *
   * Both arms are also exercised through `runArrivals` below, off the reachable
   * manifold. That is deliberate duplication, not redundancy: this describes
   * the guard, those describe the phase.
   */
  it('passes through the only combination the manifold permits', () => {
    expect(() => assertArrivalHonoured(1, 1, 0, 0)).not.toThrow()
    expect(() => assertArrivalHonoured(10, 3, 5, 7)).not.toThrow()
  })

  it('names destPins, the destination and the car when there is no pin to consume', () => {
    expect(() => assertArrivalHonoured(0, 1, 5, 7)).toThrow(/destPins/)
    expect(() => assertArrivalHonoured(0, 1, 5, 7)).toThrow(/car 7/)
    expect(() => assertArrivalHonoured(0, 1, 5, 7)).toThrow(/destination 5/)
  })

  it('names destReserved when there is no reservation to release, and says why that matters', () => {
    // The message has to name the Uint8 wrap, because "reserved is 0" reads as
    // harmless and "decrementing would store 255" does not.
    expect(() => assertArrivalHonoured(1, 0, 5, 7)).toThrow(/destReserved/)
    expect(() => assertArrivalHonoured(1, 0, 5, 7)).toThrow(/255/)
  })

  it('checks the pin arm first, so a state that breaks both is reported as the pin failure', () => {
    // Not cosmetic: `destPins === 0` is the invariant break the plan names, and
    // a doubly-broken state must not be diagnosed as the sibling symptom.
    expect(() => assertArrivalHonoured(0, 0, 5, 7)).toThrow(/destPins/)
  })
})

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

describe('the cursor comparisons are >= and <=, not === (the fail-closed guards)', () => {
  /**
   * `runArrivals`' two cursor tests are `>=` and `<=` rather than `===`, and
   * `trips.ts` justifies that with a concrete behaviour: off the manifold,
   * `===` reads a cursor that HAD overshot as "still driving" and strands the
   * car outbound forever, holding its reservation and blocking its destination.
   *
   * **Nothing observed that.** Both `>=` → `===` and `<= 0` → `=== 0` were
   * 0-detector across the whole suite. The under-shoot side was covered twice
   * ("a car mid-route is left exactly as it was"); the over-shoot side, which is
   * the side the guards exist for, not at all — so the comment named a failure
   * mode and cited an analogy to `dispatch.ts`'s pinned `destPins -
   * destReserved <= 0` **as if the analogy transferred the coverage with it.**
   *
   * These two are the observers. They are mutated separately, because they are
   * symmetric halves and a compound kill would say nothing about either.
   *
   * Off-manifold by construction: `advanceCar` stops at exactly the bound, so a
   * cursor can only pass it through corruption or a hand-written slot.
   */
  it('collects an OUTBOUND car whose cursor has OVERSHOT routeLen', () => {
    const r = rig('overshoot')
    expect(placeHouse(r.state, r.world, 10, 0)).toBe(true)
    r.state.destPins[0] = 1
    r.state.destReserved[0] = 1
    outboundExhausted(r.state, 0, 0, [E, E], 12, 900)
    r.state.carRouteCursor[0] = 3 // OVERSHOT: routeLen is 2

    // Vacuity, per the negative-assertion rule: nothing ELSE in this fixture
    // can produce the observation. The car is OUTBOUND, so the RETURNING arm
    // cannot fire; and 3 !== 2, so an `===` test is false — the `>=` is the
    // only thing that can collect it.
    expect(r.state.carRouteCursor[0]).toBeGreaterThan(r.state.carRouteLen[0] as number)
    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)

    runArrivals(r.state)

    expect(r.state.carPhase[0]).toBe(PHASE_RETURNING)
    expect(r.state.destPins[0]).toBe(0)
    expect(r.state.destReserved[0]).toBe(0) // the reservation is released, not stranded
  })

  it('completes a RETURNING car whose cursor has UNDERSHOT 0', () => {
    const r = rig('undershoot')
    expect(placeHouse(r.state, r.world, 10, 0)).toBe(true)
    expect(placeHouse(r.state, r.world, 20, 0)).toBe(true)
    returnExhausted(r.state, 2, 0, [E, E], 12, 900)
    r.state.carRouteCursor[2] = -1 // UNDERSHOT

    // Vacuity: the car is RETURNING, so the OUTBOUND arm cannot fire, and
    // -1 !== 0, so an `=== 0` test is false.
    expect(r.state.carRouteCursor[2]).toBeLessThan(0)
    expect(r.state.carPhase[2]).toBe(PHASE_RETURNING)

    runArrivals(r.state)

    expect(r.state.carPhase[2]).toBe(PHASE_IDLE)
    expect(r.state.header[H_SCORE]).toBe(1)
    expect(r.state.carCell[2]).toBe(20) // its OWN house, not house 0's
    expect(r.state.carRouteCursor[2]).toBe(0) // the corrupt cursor is normalised, not preserved
    expect(r.state.carProgress[2]).toBe(0)
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

// ---------------------------------------------------------------------------
// M1d Task 5 — trip end is a ghost departure
// ---------------------------------------------------------------------------

describe('a trip ending on a ghost cell decrements it (M1d Task 5)', () => {
  const HOUSE = 20 // (4,2) on the 8x6 board
  const GHOST_BIT = 1 << 2 // 1 << E

  /**
   * A RETURNING car whose retrace is over: cursor 0, standing on its house
   * cell, holding that cell's claim from its last crossing. That is exactly the
   * state `runArrivals` collects, and it is the state the plan's lifecycle event
   * 4 is about.
   */
  function homeCar(state: GameState, i: number, cell: number): void {
    state.carPhase[i] = PHASE_RETURNING
    state.carCell[i] = cell
    state.carHome[i] = 0
    state.houseCell[0] = cell
    state.carRouteLen[i] = 4
    state.carRouteCursor[i] = 0
    for (let k = 0; k < 4; k++) packRouteStep(state, i, k, 2)
    claimCell(state, i, cell, 2)
  }

  it('pays the deferred refund when the LAST committed car s trip ends on the cell', () => {
    // **Without this the tile is confiscated for the rest of the run** — the
    // mirror of a double refund, and just as silent. It is not exotic: a house
    // cell carries a road like any other (roads.ts keeps house and carpark cells
    // placeable), so this is every trip whose own front door gets erased.
    const { state } = rig('ghost-trip-end')
    homeCar(state, 0, HOUSE)
    state.ghostMask[HOUSE] = GHOST_BIT
    state.ghostCommitted[HOUSE] = 1
    const tiles = tilesLeft(state)

    runArrivals(state)

    expect(state.carPhase[0], 'vacuity: the trip really did end').toBe(PHASE_IDLE)
    expect(tilesLeft(state)).toBe(tiles + 1)
    expect(ghostMaskOf(state, HOUSE)).toBe(0)
    expect(ghostCommittedOf(state, HOUSE)).toBe(0)
    // The occupancy release still happens too — the two ledgers are separate
    // events over the same departure, and losing either is a different bug.
    expect(occupantOf(state, HOUSE, 0)).toBe(FREE)
    expect(occupantOf(state, HOUSE, 1)).toBe(FREE)
  })

  it('decrements without refunding when another committed car is still to clear', () => {
    // Split from the test above so "refund on the first trip end" and "never
    // decrement" are different failures.
    const { state } = rig('ghost-trip-end-partial')
    homeCar(state, 0, HOUSE)
    state.ghostMask[HOUSE] = GHOST_BIT
    state.ghostCommitted[HOUSE] = 2
    const tiles = tilesLeft(state)
    runArrivals(state)
    expect(ghostCommittedOf(state, HOUSE)).toBe(1)
    expect(ghostMaskOf(state, HOUSE)).toBe(GHOST_BIT)
    expect(tilesLeft(state)).toBe(tiles)
  })

  it('a car ARRIVING at its destination is not a departure and must not decrement', () => {
    // `arriveAtDestination` flips the phase in place on the carpark cell: the
    // car does not move, so it has not cleared anything. This is the same ruling
    // `blocking.ts`'s lifecycle event 5 makes for the occupancy release, carried
    // across to the ghost ledger — the sibling case the catalogue says gets
    // missed.
    const { state } = rig('ghost-arrival-not-departure')
    const CARPARK = 21
    state.carPhase[0] = PHASE_OUTBOUND
    state.carCell[0] = CARPARK
    state.carRouteLen[0] = 4
    state.carRouteCursor[0] = 4
    state.carTargetDest[0] = 0
    state.destPins[0] = 1
    state.destReserved[0] = 1
    state.header[H_DEST_COUNT] = 1
    state.ghostMask[CARPARK] = GHOST_BIT
    state.ghostCommitted[CARPARK] = 1
    const tiles = tilesLeft(state)

    runArrivals(state)

    expect(state.carPhase[0], 'vacuity: it really did arrive').toBe(PHASE_RETURNING)
    expect(ghostCommittedOf(state, CARPARK), 'the car is still standing on it').toBe(1)
    expect(tilesLeft(state)).toBe(tiles)
  })
})

// ---------------------------------------------------------------------------
// §5.8's arrival knockback — M1e Task 7
// ---------------------------------------------------------------------------

/**
 * The knockback lives here rather than in phase 10 because it is an EVENT — one
 * car arriving — while phase 10 is a per-tick integration. These are the tests
 * for the WIRING; the arithmetic is `overcrowd.test.ts`'s.
 */
describe('the arrival knockback, wired into arrival', () => {
  it('knocks 10 % off the arriving destination’s meter, and nothing else’s', () => {
    const { state } = rig('knockback-wiring')
    expect(placeHouse(state, rig('unused').world, 10, 0)).toBe(true)
    state.header[H_DEST_COUNT] = 2
    state.destPins[0] = 3
    state.destReserved[0] = 2
    state.destOvercrowd[0] = 500000
    state.destOvercrowd[1] = 500000
    outboundExhausted(state, 0, 0, [E, E], 12, 1400)

    runArrivals(state)

    expect(state.carPhase[0], 'vacuity: the arrival really happened').toBe(PHASE_RETURNING)
    expect(state.destOvercrowd[0]).toBe(450000)
    expect(state.destOvercrowd[1], 'a different destination is untouched').toBe(500000)
  })

  it('compounds: two cars arriving at one destination on one tick knock back twice', () => {
    // The knockback is inside `arriveAtDestination`, so it is per ARRIVAL and
    // not per tick. A mutant that hoisted it to `runArrivals` and applied it
    // once would pass the single-arrival test above.
    const { state } = rig('knockback-compound')
    state.header[H_DEST_COUNT] = 1
    state.destPins[0] = 4
    state.destReserved[0] = 2
    state.destOvercrowd[0] = 500000
    outboundExhausted(state, 0, 0, [E, E], 12, 1400)
    outboundExhausted(state, 1, 0, [E, E], 12, 1400)

    runArrivals(state)

    expect(state.carPhase[0]).toBe(PHASE_RETURNING)
    expect(state.carPhase[1], 'vacuity: BOTH cars arrived').toBe(PHASE_RETURNING)
    // 500,000 -> 450,000 -> 405,000. Once would leave 450,000.
    expect(state.destOvercrowd[0]).toBe(405000)
  })

  it('does not touch the meter when no car arrives', () => {
    // The negative half, with the other mechanism that produces the same
    // observation disabled: this car is RETURNING with an exhausted cursor, so
    // it is collected by the other branch and `arriveAtDestination` is never
    // reached — the meter is unchanged because THIS event did not happen, not
    // because nothing happened.
    const { state } = rig('knockback-none')
    state.header[H_DEST_COUNT] = 1
    state.destOvercrowd[0] = 500000
    returnExhausted(state, 0, 0, [E, E], 12, 1400)

    runArrivals(state)

    expect(state.carPhase[0], 'vacuity: the trip really did END').toBe(PHASE_IDLE)
    expect(state.destOvercrowd[0]).toBe(500000)
  })
})

// ---------------------------------------------------------------------------
// Phase 9 before phase 10 — M1e Task 7
// ---------------------------------------------------------------------------

/** The brink destination's index. One destination on the board, so it is 0. */
const D_BRINK = 0

/**
 * A whole `step` on a board where a car arrives on the exact tick the
 * destination would otherwise be AT its timer capacity.
 *
 * **This is the only fixture in the repo that can tell phases 9 and 10 apart**,
 * and every other mechanism that could produce `destOverTicks === 0` is
 * disabled by construction rather than by luck:
 *
 *   - the board is 8 x 6, so `REVEALED_Y0` = 9 clips the spawn zone to nothing
 *     and phase 4 is structurally absent — no spawn can add a pin;
 *   - the destination is placed on tick 0 and the step runs tick 1, which is
 *     inside `FIRST_PIN_DELAY_TICKS`, so `computeSlotCounts` returns 0 and
 *     phase 5 cannot fire either;
 *   - there are no roads, so phase 7 can commit nothing and phase 8 moves
 *     nobody.
 *
 * So the ONLY thing that moves `destPins` on this tick is the arrival, which is
 * what makes `destOverTicks` a clean read on the phase order.
 */
function arrivalOnTheBrinkRig(): {
  state: GameState
  world: WorldData
  fields: readonly FlowField[]
  scratch: Scratch
} {
  const { map, world } = fixture('brink')
  const state = createState('brink', map)
  const scratch = createScratch(
    world.cells,
    map.groupCount,
    map.maxDestinations,
    createFieldInputRanges(map),
  )
  const fields = createFlowFields(map.groupCount, world.cells)
  // Origin (2, 1) opening EAST: footprint (2..4, 1..2), carpark (5, 1) = cell 13.
  expect(placeDestination(state, world, 1 * W + 2, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
  expect(placeHouse(state, world, 4 * W + 1, 0)).toBe(true)
  state.destPins[D_BRINK] = PIN_CAP_SQUARE_TIMER
  state.destReserved[D_BRINK] = 1
  outboundExhausted(state, 0, D_BRINK, [E, E], 1 * W + 5, 1400)
  return { state, world, fields, scratch }
}

describe('the tick order: arrivals before the overcrowd meter', () => {
  it('integrates the meter AFTER arrivals, so a serviced destination is not charged for the tick it cleared', () => {
    // The detector for transposing phases 9 and 10. The fixture is built so a
    // car arrives on the exact tick the destination would otherwise be at
    // capacity: with arrivals first the pin count drops below the trigger and
    // `destOverTicks` stays 0; with overcrowd first it charges a tick the
    // player had already earned back.
    const r = arrivalOnTheBrinkRig()
    // The premise, asserted rather than assumed: the destination really is ON
    // the brink going in, so 0 afterwards is the arrival's doing.
    expect(r.state.destPins[D_BRINK]).toBe(PIN_CAP_SQUARE_TIMER)
    expect(isOverCapacity(r.state, D_BRINK), 'it is over capacity BEFORE the tick').toBe(true)

    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)

    expect(r.state.destPins[D_BRINK], 'vacuity: the arrival must have happened').toBe(
      PIN_CAP_SQUARE_TIMER - 1,
    )
    expect(r.state.destOverTicks[D_BRINK]).toBe(0)
    expect(r.state.destOvercrowd[D_BRINK], 'and nothing accrued').toBe(0)
    expect(isOverCapacity(r.state, D_BRINK), 'and it is under capacity coming out').toBe(false)
  })

  it('is not vacuous: with no arrival, the SAME board charges the tick', () => {
    // Without this the test above is satisfied by a `runOvercrowd` that never
    // runs at all — which is exactly what "delete the call from `step`" looks
    // like. Same rig, same tick, one car put back in its garage.
    const r = arrivalOnTheBrinkRig()
    r.state.carPhase[0] = PHASE_IDLE
    r.state.destReserved[D_BRINK] = 0

    step(r.state, r.world, r.fields, r.scratch, NO_INPUT)

    expect(r.state.destPins[D_BRINK], 'nobody arrived').toBe(PIN_CAP_SQUARE_TIMER)
    expect(r.state.destOverTicks[D_BRINK], 'so the tick IS charged').toBe(1)
    expect(r.state.destOvercrowd[D_BRINK]).toBe(0) // floor(2*1/3) = 0
  })

  it('is not vacuous: nothing but the arrival can move destPins on this tick', () => {
    // The three disabling conditions the rig's comment claims, asserted. A
    // fixture that quietly gained a spawn zone or an eligible destination would
    // make both tests above pass for the wrong reason.
    const r = arrivalOnTheBrinkRig()
    expect(spawnZoneCells(r.world), 'an 8 x 6 board clips the revealed rect to nothing').toBe(0)
    expect(r.state.destSpawnTick[D_BRINK]).toBe(0)
    expect(1 - (r.state.destSpawnTick[D_BRINK] as number)).toBeLessThan(FIRST_PIN_DELAY_TICKS)
    expect(tilesLeft(r.state), 'and no road was ever laid').toBe(99)
  })
})
