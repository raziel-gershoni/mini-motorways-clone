import { describe, it, expect } from 'vitest'
import {
  parseMap,
  PIN_PERIOD_TICKS,
  FIRST_PIN_DELAY_TICKS,
  PIN_CAP_SQUARE_HARD,
  PIN_CAP_CIRCLE_HARD,
  TICKS_PER_WEEK,
  DAYS_PER_WEEK,
  type MapData,
} from '@laneways/shared'
import { createState, snapshot, restore, H_TICK, H_DEST_COUNT, H_PINS_DROPPED, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFieldInputRanges } from '../src/regions'
import { createScratch, type Scratch } from '../src/scratch'
import { placeDestination, ORIENTATION_S, DEST_KIND_SQUARE, DEST_KIND_CIRCLE } from '../src/buildings'
import { computeSlotCounts, advanceAccumulators, runDemand } from '../src/demand'

/**
 * All-land grid, generated rather than hand-typed (this is a test file, not
 * `sim/src` or `shared/src` — `determinism/no-module-mutable-state` only
 * binds those two source trees, per `eslint.config.js`'s own `files` list —
 * so a plain function building rows at call time is fine here, unlike in
 * `buildings.ts` itself).
 */
function allLandRows(w: number, h: number): string[] {
  const row = '.'.repeat(w)
  return Array.from({ length: h }, () => row)
}

const W = 20
const H = 6

function fixture(id: string, maxHouses = 40, maxDestinations = 16, groupCount = 5): { map: MapData; world: WorldData } {
  const map = parseMap(id, allLandRows(W, H), 50, maxHouses, maxDestinations, groupCount)
  const world = createWorld(map)
  return { map, world }
}

function rig(map: MapData, world: WorldData): { state: GameState; scratch: Scratch } {
  const state = createState('s', map)
  const scratch = createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map))
  return { state, scratch }
}

/** Cell index for the W-wide fixture grid. */
function cellFor(x: number, y: number): number {
  return y * W + x
}

/**
 * Places a destination and immediately backdates its `destSpawnTick` far
 * enough into the past that it is eligible from `state.header[H_TICK] + 1`
 * onward, unconditionally. A raw white-box field write, same convention as
 * `buildings.test.ts`'s `state.header[H_TICK] = 777`: it isolates "the
 * accumulator/rotation" from "the 4s delay", which has its own dedicated
 * tests below.
 */
function placeEligibleNow(
  state: GameState,
  world: WorldData,
  x: number,
  y: number,
  colour: number,
  kind: number,
): number {
  const d = state.header[H_DEST_COUNT] as number
  expect(placeDestination(state, world, cellFor(x, y), ORIENTATION_S, colour, kind)).toBe(true)
  state.destSpawnTick[d] = -1_000_000
  return d
}

/** Advances the tick by one and runs demand once — the shape Task 6's `step` will call. */
function tick(state: GameState, scratch: Scratch): void {
  state.header[H_TICK] = (state.header[H_TICK] as number) + 1
  runDemand(state, scratch)
}

function tickN(state: GameState, scratch: Scratch, n: number): void {
  for (let i = 0; i < n; i++) tick(state, scratch)
}

describe('constants: PIN_PERIOD_TICKS and FIRST_PIN_DELAY_TICKS', () => {
  it('PIN_PERIOD_TICKS is 518, derived through the week (never through TICKS_PER_DAY = 0)', () => {
    // 4500 / 8.68 = 518.4..., truncated down to 518 (fix-list #18; decision 1).
    expect(TICKS_PER_WEEK).toBe(4500)
    expect(PIN_PERIOD_TICKS).toBe(518)
  })

  it('FIRST_PIN_DELAY_TICKS is 120 (4 seconds at 30 ticks/second)', () => {
    expect(FIRST_PIN_DELAY_TICKS).toBe(120)
  })
})

describe('eligibility gate: >=, not >, and independent per-destination delays', () => {
  it('a destination counts in slotCount exactly on the tick its delay elapses, not one tick early or late', () => {
    const { map, world } = fixture('elig-boundary')
    const { state, scratch } = rig(map, world)

    // destA spawns at tick 10; destB (SAME colour) spawns at tick 50 — a
    // later, independent spawn, per the brief's "two same-colour
    // destinations placed at different ticks each get their own delay".
    state.header[H_TICK] = 10
    expect(placeDestination(state, world, cellFor(0, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    state.header[H_TICK] = 50
    expect(placeDestination(state, world, cellFor(5, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)

    // destA eligible at tick 10 + 120 = 130. destB eligible at 50 + 120 = 170.
    state.header[H_TICK] = 129
    computeSlotCounts(state, scratch)
    expect(scratch.slotCounts[0], 'tick 129: destA not yet eligible (129-10=119 < 120)').toBe(0)

    state.header[H_TICK] = 130
    computeSlotCounts(state, scratch)
    expect(scratch.slotCounts[0], 'tick 130: destA eligible exactly on the boundary (130-10=120 >= 120)').toBe(1)

    state.header[H_TICK] = 169
    computeSlotCounts(state, scratch)
    expect(scratch.slotCounts[0], 'tick 169: destA still counts alone; destB not yet (169-50=119 < 120)').toBe(1)

    state.header[H_TICK] = 170
    computeSlotCounts(state, scratch)
    expect(scratch.slotCounts[0], 'tick 170: destB now also eligible (170-50=120 >= 120) — own, independent delay').toBe(2)
  })

  it('vacuity: an ineligible destination is genuinely present (H_DEST_COUNT reflects it) while excluded from slotCount', () => {
    const { map, world } = fixture('elig-vacuity')
    const { state, scratch } = rig(map, world)
    state.header[H_TICK] = 0
    expect(placeDestination(state, world, cellFor(0, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(state.header[H_DEST_COUNT]).toBe(1) // genuinely placed, not silently rejected
    computeSlotCounts(state, scratch)
    expect(scratch.slotCounts[0]).toBe(0) // but excluded: tick(0) - spawn(0) = 0 < 120
  })
})

describe('the rate: an exact hand-computed pin count over a window spanning >= 2 full periods', () => {
  it('a lone square destination delivers exactly 8 pins over one in-game week (7 days = 4500 ticks)', () => {
    // Hand computation, shown: window = 1 week = TICKS_PER_WEEK ticks (a
    // WHOLE number of weeks — chosen specifically so "K in-game days" routes
    // through TICKS_PER_WEEK, never through the deliberately-0
    // TICKS_PER_DAY). slotCount = 1 (one square, no other same-colour
    // destination). predicted = floor(1 * 4500 / 518) = floor(8.6872...) = 8.
    // 4500 / 518 = 8.6873 periods elapse — comfortably >= 2.
    const K_DAYS = DAYS_PER_WEEK // 7: exactly one week, a whole number of weeks by construction
    const WINDOW_TICKS = (K_DAYS / DAYS_PER_WEEK) * TICKS_PER_WEEK
    expect(WINDOW_TICKS).toBe(4500)
    const predicted = Math.trunc(WINDOW_TICKS / PIN_PERIOD_TICKS)
    expect(predicted).toBe(8)
    // Vacuity: predicted > 0, and the window spans >= 2 full periods.
    expect(predicted).toBeGreaterThan(0)
    expect(WINDOW_TICKS / PIN_PERIOD_TICKS).toBeGreaterThanOrEqual(2)
    // Vacuity: predicted stays under the hard cap, so this measures the
    // RATE, not the cap (a separate, dedicated set of tests below).
    expect(predicted).toBeLessThan(PIN_CAP_SQUARE_HARD)

    const { map, world } = fixture('rate-lone-square')
    const { state, scratch } = rig(map, world)
    const d = placeEligibleNow(state, world, 0, 0, 0, DEST_KIND_SQUARE)
    tickN(state, scratch, WINDOW_TICKS)

    expect(state.destPins[d]).toBe(8)
    expect(state.header[H_PINS_DROPPED]).toBe(0) // vacuity: nothing dropped, so this really is the delivered count
  })
})

describe('adding a second destination does not halve the first one\'s rate', () => {
  it('destA receives ~the same count over the same window whether alone or with a same-colour destB', () => {
    const WINDOW_TICKS = TICKS_PER_WEEK // 4500, reused from the rate test above

    // Scenario A: destA alone. Hand-computed above: exactly 8.
    const { map: mapA, world: worldA } = fixture('halve-alone')
    const rigA = rig(mapA, worldA)
    const destA = placeEligibleNow(rigA.state, worldA, 0, 0, 0, DEST_KIND_SQUARE)
    tickN(rigA.state, rigA.scratch, WINDOW_TICKS)
    expect(rigA.state.destPins[destA]).toBe(8)

    // Scenario B: destA + destB, same colour, both eligible for the WHOLE
    // window. slotCount = 2 throughout, evenly dividing PIN_PERIOD_TICKS's
    // parity (518 is even), so fires land at exact multiples of 259 ticks
    // with zero remainder — total fires over 4500 ticks =
    // floor(2*4500/518) = floor(9000/518) = 17, alternating A,B,A,B,...
    // starting with A (the lower cell index / lower destination index is
    // resolved first on the cold-start cursor): A gets ceil(17/2) = 9,
    // B gets floor(17/2) = 8. If demand DILUTED per destination, adding
    // destB would have HALVED destA's rate (8 -> ~4); it does not.
    const { map: mapB, world: worldB } = fixture('halve-together')
    const rigB = rig(mapB, worldB)
    const destA2 = placeEligibleNow(rigB.state, worldB, 0, 0, 0, DEST_KIND_SQUARE)
    const destB2 = placeEligibleNow(rigB.state, worldB, 5, 0, 0, DEST_KIND_SQUARE)
    tickN(rigB.state, rigB.scratch, WINDOW_TICKS)

    expect(rigB.state.destPins[destA2], 'destA with a same-colour destB present').toBe(9)
    expect(rigB.state.destPins[destB2]).toBe(8)
    // The property under test, stated as a direct comparison: NOT halved.
    expect(rigB.state.destPins[destA2]).toBeGreaterThanOrEqual(rigA.state.destPins[destA] as number)
    expect(rigB.state.destPins[destA2]).not.toBe(Math.trunc((rigA.state.destPins[destA] as number) / 2))
  })
})

describe('rotation: exact firing sequence, cursor values, wrap, burstiness', () => {
  /**
   * dest0 is a DECOY of a DIFFERENT colour at global index 0 — this is what
   * makes the colour-under-test's own destinations start at index >= 1,
   * exercising `resolveCurrent`'s bootstrap search (see its own doc
   * comment) rather than trivially resolving cursor 0 -> destIndex 0.
   *
   * dest1 (index 1) is a CIRCLE of colour 0; dest2 (index 2) is a SQUARE of
   * colour 0. slotCount(0) = 2 (circle) + 1 (square) = 3.
   */
  function buildRotationRig() {
    const { map, world } = fixture('rotation-sequence')
    const { state, scratch } = rig(map, world)
    placeEligibleNow(state, world, 0, 0, 1, DEST_KIND_SQUARE) // dest0: decoy, colour 1
    const circle = placeEligibleNow(state, world, 5, 0, 0, DEST_KIND_CIRCLE) // dest1: colour 0
    const square = placeEligibleNow(state, world, 10, 0, 0, DEST_KIND_SQUARE) // dest2: colour 0
    expect(circle).toBe(1)
    expect(square).toBe(2)
    return { state, scratch, circle, square }
  }

  it('fires [circle, circle, square] repeating, with the exact cursor value recorded after each firing', () => {
    const { state, scratch, circle, square } = buildRotationRig()

    // Record (recipient, cursorAfter) every time ANY destPins changes, for
    // up to 2 full rotations (6 firings). A per-rotation COUNT could not
    // distinguish [circle,circle,square] from [circle,square,circle]; this
    // records the SEQUENCE, plus the cursor after each firing, per the
    // brief's exact requirement.
    const events: Array<{ recipient: number; cursorAfter: number }> = []
    let prevCircle = state.destPins[circle] as number
    let prevSquare = state.destPins[square] as number
    // slotCount = 3; first fire lands once acc crosses 518, i.e. within
    // ceil(518/3) = 173 ticks. Run comfortably past 2 full rotations
    // (6 firings) without approaching either hard cap (circle 14, square
    // 10) — see the vacuity check below.
    for (let i = 0; i < 1200 && events.length < 6; i++) {
      tick(state, scratch)
      const c = state.destPins[circle] as number
      const s = state.destPins[square] as number
      if (c !== prevCircle) {
        events.push({ recipient: circle, cursorAfter: state.rotationCursor[0] as number })
        prevCircle = c
      } else if (s !== prevSquare) {
        events.push({ recipient: square, cursorAfter: state.rotationCursor[0] as number })
        prevSquare = s
      }
    }

    // Vacuity: pins delivered > 0, and we genuinely captured 6 firings.
    expect(events.length).toBe(6)
    // Vacuity: no destination was at cap during this measurement, so
    // rotation and overflow are not conflated.
    expect(state.destPins[circle]).toBeLessThan(PIN_CAP_CIRCLE_HARD)
    expect(state.destPins[square]).toBeLessThan(PIN_CAP_SQUARE_HARD)

    // The exact sequence: circle, circle, square, repeating. Cursor packs
    // destIndex*2+subSlot; circle is index 1, square is index 2.
    //   fire1: chosen (1,0) circle-slot0 -> advance -> (1,1) -> cursor 3
    //   fire2: chosen (1,1) circle-slot1 -> advance -> next colour-0 dest
    //          after index1 is index2 -> (2,0) -> cursor 4
    //   fire3: chosen (2,0) square       -> advance -> wraps past index0
    //          (wrong colour, skipped) back to index1 -> (1,0) -> cursor 3
    const expectedRecipients = [circle, circle, square, circle, circle, square]
    const expectedCursors = [3, 4, 2, 3, 4, 2]
    expect(events.map((e) => e.recipient)).toEqual(expectedRecipients)
    expect(events.map((e) => e.cursorAfter)).toEqual(expectedCursors)

    // The cursor genuinely wrapped: fire3's cursor (2) is LOWER than the
    // immediately preceding cursor (4) — proof of an actual wrap, not a
    // monotonically increasing counter.
    expect(events[2]?.cursorAfter).toBeLessThan(events[1]?.cursorAfter as number)
  })
})

describe('overflow: capacity, the distinct-destination walk, skipping other colours, and drops', () => {
  /**
   * Fixture per the brief's own requirement ("the obvious fixture proves
   * nothing"): >= 3 same-colour destinations (dest1, dest2, dest3, colour
   * 0), the one that ends up capped-and-chosen is NOT at global index 0
   * (dest0 is a decoy of colour 1 at index 0), and by the time the
   * overflow-triggering fire happens the cursor is NOT 0 either (it has
   * already advanced once, naturally, via a prior real firing).
   */
  function buildOverflowRig() {
    const { map, world } = fixture('overflow-fixture')
    const { state, scratch } = rig(map, world)
    placeEligibleNow(state, world, 0, 0, 1, DEST_KIND_SQUARE) // dest0: decoy, colour 1, index 0
    const d1 = placeEligibleNow(state, world, 5, 0, 0, DEST_KIND_SQUARE) // dest1: colour 0, index 1
    const d2 = placeEligibleNow(state, world, 10, 0, 0, DEST_KIND_SQUARE) // dest2: colour 0, index 2
    const d3 = placeEligibleNow(state, world, 15, 0, 0, DEST_KIND_SQUARE) // dest3: colour 0, index 3
    expect(d1).toBe(1)
    expect(d2).toBe(2)
    expect(d3).toBe(3)
    return { state, scratch, d1, d2, d3 }
  }

  it('redirects to the next distinct, eligible, uncapped same-colour destination, skipping a capped one and other colours, and advances the cursor past the ORIGINALLY CHOSEN slot', () => {
    const { state, scratch, d1, d2, d3 } = buildOverflowRig()

    // Fire once naturally (bootstrap): resolves to d1 (lowest colour-0
    // index), delivers there, advances the cursor to d2. This is what
    // makes the cursor non-zero BEFORE the overflow-triggering fire below,
    // per the fixture requirement, achieved without a raw write.
    for (let i = 0; i < 1200 && (state.destPins[d1] as number) === 0; i++) tick(state, scratch)
    expect(state.destPins[d1]).toBe(1)
    const cursorBeforeOverflow = state.rotationCursor[0] as number
    expect(cursorBeforeOverflow, 'fixture requirement: cursor must not be 0 before the overflow fire').not.toBe(0)
    expect(cursorBeforeOverflow).toBe(d2 * 2) // cursor now names d2 (index 2) — the capped-one-not-at-0 target below

    // Pre-cap d2 (the one the cursor now points at — the CHOSEN destination
    // for the next fire) AND d3, so the overflow walk must pass over a
    // second capped destination before finding room. Both writes are
    // direct field pokes: legitimate white-box setup, same convention as
    // `buildings.test.ts`'s capacity fixtures.
    state.destPins[d2] = PIN_CAP_SQUARE_HARD
    state.destPins[d3] = PIN_CAP_SQUARE_HARD
    // Vacuity: genuinely full, not merely "close to" full.
    expect(state.destPins[d2]).toBe(PIN_CAP_SQUARE_HARD)
    expect(state.destPins[d3]).toBe(PIN_CAP_SQUARE_HARD)

    const droppedBefore = state.header[H_PINS_DROPPED] as number
    // Advance the accumulator by exactly one more fire's worth for colour 0.
    for (let i = 0; i < 1200 && (state.rotationCursor[0] as number) === cursorBeforeOverflow; i++) tick(state, scratch)

    // The overflow walk from chosen=d2 (index 2): step1 -> d3 (index 3,
    // colour 0, CAPPED, skip) -> step2 -> d0 (index 0, colour 1, WRONG
    // COLOUR, skip) -> step3 -> d1 (index 1, colour 0, room) -> recipient.
    expect(state.destPins[d1], 'overflow recipient: d1, the next distinct uncapped same-colour destination').toBe(2)
    expect(state.destPins[d2], 'd2 (the capped, chosen destination) is unchanged — it did NOT receive an extra pin').toBe(
      PIN_CAP_SQUARE_HARD,
    )
    expect(state.destPins[d3], 'd3 (capped, and correctly skipped by the walk) is unchanged').toBe(PIN_CAP_SQUARE_HARD)
    expect(state.header[H_PINS_DROPPED], 'no drop: d1 had room').toBe(droppedBefore)

    // The cursor advances past the ORIGINALLY CHOSEN slot (d2), never past
    // the overflow recipient (d1). advance(chosen=d2,square) searches for
    // the next colour-0 destination after index 2: d3 (colour 0, eligible —
    // eligibility does not care about cap) -> cursor = 3*2 = 6.
    // The REJECTED alternative (advance past the recipient, d1) would give
    // advance(d1,square) = next colour-0 dest after index1 = d2 -> cursor
    // = 2*2 = 4, i.e. UNCHANGED from `cursorBeforeOverflow`. The two are
    // observably different, which is what makes this assertion able to
    // kill that specific mutation.
    expect(state.rotationCursor[0]).toBe(d3 * 2)
    expect(state.rotationCursor[0]).not.toBe(cursorBeforeOverflow)
  })

  it('drops the pin and increments H_PINS_DROPPED once every same-colour destination is capped, and the walk terminates rather than hanging', () => {
    const { state, scratch, d1, d2, d3 } = buildOverflowRig()
    // Cap all three directly.
    state.destPins[d1] = PIN_CAP_SQUARE_HARD
    state.destPins[d2] = PIN_CAP_SQUARE_HARD
    state.destPins[d3] = PIN_CAP_SQUARE_HARD

    const droppedBefore = state.header[H_PINS_DROPPED] as number
    const cursorBefore = state.rotationCursor[0] as number
    // Drive exactly one fire for colour 0 (bounded iteration count proves
    // the walk terminates rather than hanging).
    for (let i = 0; i < 1200 && (state.header[H_PINS_DROPPED] as number) === droppedBefore; i++) tick(state, scratch)

    expect(state.header[H_PINS_DROPPED]).toBe(droppedBefore + 1)
    expect(state.destPins[d1]).toBe(PIN_CAP_SQUARE_HARD)
    expect(state.destPins[d2]).toBe(PIN_CAP_SQUARE_HARD)
    expect(state.destPins[d3]).toBe(PIN_CAP_SQUARE_HARD)
    // The cursor still advances even on a drop (it is not stuck).
    expect(state.rotationCursor[0]).not.toBe(cursorBefore)
  })
})

describe('at most one pin per colour per tick', () => {
  it('holds even at the maximum possible slotCount (32), forced directly via scratch', () => {
    const { map, world } = fixture('one-per-tick', 40, 16, 5)
    const { state, scratch } = rig(map, world)
    const d = placeEligibleNow(state, world, 0, 0, 0, DEST_KIND_SQUARE)

    let prevTotal = 0
    for (let i = 0; i < 50; i++) {
      state.header[H_TICK] = (state.header[H_TICK] as number) + 1
      // Bypass computeSlotCounts: force the maximum realistic slotCount
      // (2 * maxDestinations = 32) directly, per demand.ts's own stated
      // bound, without needing 16 real circle destinations.
      scratch.slotCounts[0] = 32
      for (let c = 1; c < scratch.slotCounts.length; c++) scratch.slotCounts[c] = 0
      advanceAccumulators(state, scratch)
      const total = (state.destPins[d] as number) + (state.header[H_PINS_DROPPED] as number)
      expect(total - prevTotal, `tick ${i}: at most one pin for colour 0`).toBeLessThanOrEqual(1)
      prevTotal = total
    }
    // Vacuity: this scenario actually produced multiple firings (otherwise
    // "at most 1" would be vacuously true because nothing ever fired).
    expect(prevTotal).toBeGreaterThan(1)
  })
})

describe('the drift-free carry: acc -= PIN_PERIOD_TICKS, not acc = 0', () => {
  it('delivers the exact carry-based count over a window chosen to make the reset-vs-carry difference observable', () => {
    // Independent closed-form oracle (not read back from the
    // implementation): a "carry" accumulator's fire count after N ticks at
    // constant slotCount s is floor(s*N / PIN_PERIOD_TICKS) — a standard
    // property of an additive accumulator that always subtracts exactly the
    // threshold on crossing. A "reset to 0" accumulator instead fires at a
    // FIXED interval of R = ceil(PIN_PERIOD_TICKS / s) ticks forever, so its
    // count after N ticks is floor(N / R).
    //
    // s = 5, PIN_PERIOD_TICKS = 518: R = ceil(518/5) = 104. The two formulas
    // first diverge (carry > reset) at the smallest k with 2k >= 518, i.e.
    // k = 259, at N = R*k = 104*259 = 26936:
    //   reset: floor(26936/104) = 259
    //   carry: floor(5*26936/518) = floor(134680/518) = 260  (518*260 = 134680 exactly)
    const s = 5
    const R = Math.ceil(PIN_PERIOD_TICKS / s)
    expect(R).toBe(104)
    const k = 259
    const N = R * k
    expect(N).toBe(26936)
    const carryPredicted = Math.trunc((s * N) / PIN_PERIOD_TICKS)
    const resetPredicted = Math.trunc(N / R)
    expect(carryPredicted).toBe(260)
    expect(resetPredicted).toBe(259)
    expect(carryPredicted).not.toBe(resetPredicted) // the window genuinely distinguishes the two models

    const { map, world } = fixture('carry-vs-reset', 40, 16, 5)
    const { state, scratch } = rig(map, world)
    const d = placeEligibleNow(state, world, 0, 0, 0, DEST_KIND_SQUARE)

    for (let i = 0; i < N; i++) {
      state.header[H_TICK] = (state.header[H_TICK] as number) + 1
      scratch.slotCounts[0] = s
      for (let c = 1; c < scratch.slotCounts.length; c++) scratch.slotCounts[c] = 0
      advanceAccumulators(state, scratch)
    }

    const totalFires = (state.destPins[d] as number) + (state.header[H_PINS_DROPPED] as number)
    expect(totalFires).toBe(carryPredicted)
    expect(totalFires).not.toBe(resetPredicted)
  })
})

describe('rotation stability across a snapshot/restore', () => {
  it('continuing after a restore fires the same sequence as continuing without one', () => {
    const { map, world } = fixture('stability-snapshot')
    const { state, scratch } = rig(map, world)
    const decoy = placeEligibleNow(state, world, 0, 0, 1, DEST_KIND_SQUARE)
    const circle = placeEligibleNow(state, world, 5, 0, 0, DEST_KIND_CIRCLE)
    const square = placeEligibleNow(state, world, 10, 0, 0, DEST_KIND_SQUARE)
    void decoy

    // Run to a non-trivial, mid-rotation point (cursor not 0, at least one
    // firing already happened) before taking the snapshot.
    tickN(state, scratch, 250)
    expect(state.rotationCursor[0]).not.toBe(0)
    const cursorAtSnapshot = state.rotationCursor[0]
    const accAtSnapshot = state.pinAccum[0]

    const buf = snapshot(state)
    const restored = restore(buf, world)
    const scratch2 = createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map))

    expect(restored.rotationCursor[0]).toBe(cursorAtSnapshot)
    expect(restored.pinAccum[0]).toBe(accAtSnapshot)

    // Continue BOTH for the same number of further ticks and compare.
    tickN(state, scratch, 600)
    tickN(restored, scratch2, 600)

    expect(restored.destPins[circle]).toBe(state.destPins[circle])
    expect(restored.destPins[square]).toBe(state.destPins[square])
    expect(restored.rotationCursor[0]).toBe(state.rotationCursor[0])
    expect(restored.pinAccum[0]).toBe(state.pinAccum[0])
    expect(restored.header[H_PINS_DROPPED]).toBe(state.header[H_PINS_DROPPED])

    // Vacuity: something actually happened in those 600 ticks (otherwise
    // matching zeros would prove nothing).
    expect(state.destPins[circle] as number).toBeGreaterThan(0)
  })
})

describe('rotation stability across a destination placement', () => {
  it('an existing destination keeps its own regular turn, and a newly placed same-colour destination joins on the very next opportunity', () => {
    const { map, world } = fixture('stability-placement')
    const { state, scratch } = rig(map, world)
    const destA = placeEligibleNow(state, world, 0, 0, 0, DEST_KIND_SQUARE) // the ONLY destination initially

    // Fire once: a lone square self-loops (cursor returns to itself).
    for (let i = 0; i < 1200 && (state.destPins[destA] as number) === 0; i++) tick(state, scratch)
    expect(state.destPins[destA]).toBe(1)
    expect(state.rotationCursor[0]).toBe(destA * 2) // self-loop: cursor still names destA

    // Now place a SECOND same-colour destination mid-rotation.
    const destB = placeEligibleNow(state, world, 5, 0, 0, DEST_KIND_SQUARE)
    expect(destB).toBe(1)

    // The very next fire still resolves to destA (the cursor was already
    // valid and pointing at it — insertion does not disturb an EXISTING
    // slot's own turn), but its ADVANCE now sees destB and picks it up.
    for (let i = 0; i < 1200 && (state.destPins[destA] as number) === 1; i++) tick(state, scratch)
    expect(state.destPins[destA]).toBe(2)
    expect(state.rotationCursor[0]).toBe(destB * 2) // advance picked up the newly placed destination

    // And the fire after THAT goes to destB — it is now a first-class
    // member of the rotation, not skipped and not double-counted.
    for (let i = 0; i < 1200 && (state.destPins[destB] as number) === 0; i++) tick(state, scratch)
    expect(state.destPins[destB]).toBe(1)
    expect(state.destPins[destA]).toBe(2) // unchanged — destA was not re-fired out of turn
  })
})

describe('vacuity self-checks, summarised as their own assertions', () => {
  it('the rotation-sequence fixture delivered > 0 pins and the cursor genuinely wrapped (both already asserted above, restated as an explicit checklist item)', () => {
    const { state, scratch, circle, square } = (() => {
      const { map, world } = fixture('vacuity-summary')
      const r = rig(map, world)
      placeEligibleNow(r.state, world, 0, 0, 1, DEST_KIND_SQUARE)
      const c = placeEligibleNow(r.state, world, 5, 0, 0, DEST_KIND_CIRCLE)
      const s = placeEligibleNow(r.state, world, 10, 0, 0, DEST_KIND_SQUARE)
      return { ...r, circle: c, square: s }
    })()
    tickN(state, scratch, 700)
    const delivered = (state.destPins[circle] as number) + (state.destPins[square] as number)
    expect(delivered).toBeGreaterThan(0)
    expect(state.rotationCursor[0]).not.toBe(0)
  })
})
