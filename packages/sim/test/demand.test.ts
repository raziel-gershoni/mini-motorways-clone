import { describe, it, expect } from 'vitest'
import {
  parseMap,
  demoCity,
  firstCity,
  PIN_PERIOD_TICKS,
  FIRST_PIN_DELAY_TICKS,
  PIN_CAP_SQUARE_HARD,
  PIN_CAP_CIRCLE_HARD,
  TICKS_PER_WEEK,
  DAYS_PER_WEEK,
  DENOM,
  SPAWN_SCALE_BASE,
  SPAWN_SCALE_PER_WEEK,
  SPAWN_SCALE_MAX,
  type MapData,
} from '@laneways/shared'
import {
  createState,
  snapshot,
  restore,
  H_TICK,
  H_WEEK,
  H_DEST_COUNT,
  H_PINS_DROPPED,
  type GameState,
} from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFieldInputRanges } from '../src/regions'
import { createScratch, type Scratch } from '../src/scratch'
import { placeDestination, ORIENTATION_S, DEST_KIND_SQUARE, DEST_KIND_CIRCLE } from '../src/buildings'
import { computeSlotCounts, advanceAccumulators, runDemand, spawnScale, pinPeriodForWeek } from '../src/demand'

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

/**
 * Sets `H_TICK` to exactly `tickValue`, forces `scratch.slotCounts[colour]`
 * to `PIN_PERIOD_TICKS` (every other colour to 0) and calls
 * `advanceAccumulators` directly — bypassing `computeSlotCounts` entirely,
 * the same doctored-parameter technique the carry-vs-reset test already
 * uses. This fires colour `colour` exactly once, AT a precisely chosen
 * tick, regardless of what real destinations of that colour would
 * naturally have accumulated by then.
 *
 * Needed for the eligibility-gate witnesses below because NATURAL
 * accumulation cannot isolate them: with real accrual, a colour with any
 * eligible destination reaches threshold only after hundreds of ticks
 * (>= ceil(518/36) = 15 at the largest slot count any shipped map can
 * reach — see `SHIPPED_MAX_SLOT_COUNT`), by which time
 * an "ineligible" witness destination (delay 120 ticks) may have become
 * legitimately eligible anyway, destroying the fixture's premise. Forcing
 * the fire at `tickValue = 1` (or another precisely chosen value) keeps
 * the witness destination provably still within its own delay window at
 * the moment resolution/advance/overflow actually runs.
 */
function forceFireAtTick(state: GameState, scratch: Scratch, tickValue: number, colour: number): void {
  state.header[H_TICK] = tickValue
  for (let c = 0; c < scratch.slotCounts.length; c++) scratch.slotCounts[c] = 0
  scratch.slotCounts[colour] = PIN_PERIOD_TICKS
  advanceAccumulators(state, scratch)
}

/**
 * The largest per-colour slot count any map this repo SHIPS can produce — a
 * circle carries two rotation slots and every destination could be one.
 *
 * **Derived from the maps rather than written as 32, because 32 is wrong.**
 * `demoCity` is `maxDestinations` 18 and its own comment says "six rows of
 * three, all circles, so 36 rotation slots", so `2 * maxDestinations` is 36;
 * the 32 that `demand.ts` and this file carried for three milestones was
 * `firstCity`'s 16 mistaken for a repo-wide ceiling. No conclusion ever
 * depended on it — 87 is under 466 as comfortably as 83 is — but **a
 * derivation is only checkable if the test can recompute it**, and one pinned
 * to a literal it cannot re-derive is exactly how the `while`-drain
 * equivalence label below could have outlived its own premise.
 */
const SHIPPED_MAX_SLOT_COUNT = 2 * Math.max(demoCity().maxDestinations, firstCity().maxDestinations)

/**
 * A rig whose colour-0 `slotCount` is exactly 2, built from two REAL eligible
 * squares and `computeSlotCounts` rather than by doctoring `scratch` — so the
 * week-boundary test below drives the accumulator with the same `slotCounts`
 * the production path produces, and its hand-computed carry is arithmetic
 * about the shipped code rather than about a hand-written array.
 */
function accumulatorRig(): { state: GameState; scratch: Scratch } {
  const { map, world } = fixture('accumulator-rig')
  const { state, scratch } = rig(map, world)
  placeEligibleNow(state, world, 0, 0, 0, DEST_KIND_SQUARE)
  placeEligibleNow(state, world, 5, 0, 0, DEST_KIND_SQUARE)
  state.header[H_TICK] = 1
  computeSlotCounts(state, scratch)
  expect(scratch.slotCounts[0], 'the rig must genuinely have slotCount(0) = 2').toBe(2)
  return { state, scratch }
}

/**
 * Every fire the demand module has produced, wherever the pin landed: pins
 * standing on destinations plus pins dropped. Counting only `destPins` would
 * read a capped board as a board that never fired.
 */
function sumPins(state: GameState): number {
  let sum = state.header[H_PINS_DROPPED] as number
  for (let d = 0; d < (state.header[H_DEST_COUNT] as number); d++) sum += state.destPins[d] as number
  return sum
}

describe('the weekly demand ramp (spec §5.3)', () => {
  it('is the spec ramp at DENOM, one-based in the spec and zero-based in H_WEEK', () => {
    // §5.3: spawnScale(w) = 1.0 + 0.11 * (w - 1), capped at 3.0, with w
    // ONE-based. `H_WEEK` is zero-based, so w = H_WEEK + 1 and the +0.11 term
    // multiplies H_WEEK directly. Off-by-one here scales week 0 to 1.11x and
    // every measured figure in the repo inherits it.
    expect(spawnScale(0)).toBe(SPAWN_SCALE_BASE)
    expect(spawnScale(1)).toBe(1110)
    expect(spawnScale(5)).toBe(1550)
    expect(spawnScale(18)).toBe(2980)
    expect(spawnScale(19), 'the cap first binds here, not at 18').toBe(SPAWN_SCALE_MAX)
    expect(spawnScale(200)).toBe(SPAWN_SCALE_MAX)
    // The three constants are the spec's three numbers at DENOM, asserted here
    // rather than only inside the table above, so a change to one of them
    // fails in a place that names it.
    expect(SPAWN_SCALE_BASE).toBe(DENOM)
    expect(SPAWN_SCALE_PER_WEEK).toBe(110)
    expect(SPAWN_SCALE_MAX).toBe(3 * DENOM)
  })

  it('the cap is never reached EXACTLY, which is what makes `>` and `>=` an equivalent mutant', () => {
    // **The pin under `spawnScale`'s labelled equivalent mutant (M1e Task 11).**
    // `s > SPAWN_SCALE_MAX` and `s >= SPAWN_SCALE_MAX` can only differ on a week
    // where `s` lands exactly on the cap, and `s = BASE + PER_WEEK * w` does
    // that iff `PER_WEEK` divides `(MAX - BASE)`. It does not — 2000 / 110 is
    // 18.18… — so no integer week produces equality and the two spellings are
    // indistinguishable by any observer.
    //
    // Asserted as the DIVISIBILITY rather than as "week 18 is 2,980 and week 19
    // is 3,090", because the label is a claim about every week and a two-week
    // spot check is a claim about two. This is the assertion `demand.ts`'s label
    // cites; without it the label vouches for a mutant on a reading.
    expect((SPAWN_SCALE_MAX - SPAWN_SCALE_BASE) % SPAWN_SCALE_PER_WEEK).not.toBe(0)
    // And non-vacuously: the ramp must actually pass through the cap, or "never
    // exactly equal" would be satisfied by a ramp that never gets there at all.
    expect(SPAWN_SCALE_BASE).toBeLessThan(SPAWN_SCALE_MAX)
    // The straddle, read off `spawnScale` itself rather than recomputed: the
    // last uncapped week is strictly under and the first capped week's UNCAPPED
    // value is strictly over, so the cap is crossed and never landed on.
    const lastUncapped = SPAWN_SCALE_BASE + SPAWN_SCALE_PER_WEEK * 18
    const firstOver = SPAWN_SCALE_BASE + SPAWN_SCALE_PER_WEEK * 19
    expect(lastUncapped).toBeLessThan(SPAWN_SCALE_MAX)
    expect(firstOver).toBeGreaterThan(SPAWN_SCALE_MAX)
    expect(spawnScale(18)).toBe(lastUncapped)
    expect(spawnScale(19)).toBe(SPAWN_SCALE_MAX)
  })

  it('week 0 leaves the pin period EXACTLY at PIN_PERIOD_TICKS', () => {
    // This is what makes the ramp golden-neutral: an implementation that
    // scaled the ACCUMULATOR instead — multiplying every stored `pinAccum` by
    // 1,000 — would move three goldens for no gameplay reason, and scaling the
    // threshold moves none.
    //
    // **The reason is NOT "every golden runs inside week 0", which is false and
    // was written here anyway.** `determinism.test.ts`'s fixture runs
    // `TICKS_PER_WEEK * 3 - 1` = 13,499 ticks, ends in **week 2**, and that
    // file's own comment says it crosses the boundaries at 4,500 and 9,000 to
    // take two tile grants. The demand golden in `loop.test.ts` runs into week 1
    // by design. Both are immune for a different and much narrower reason:
    // **neither has a destination whose colour accumulates** — 13,499 has no
    // destinations at all, so every `slotCount` is 0, `pinAccum` never advances
    // and no period can matter; and the demand golden was blessed under this
    // ramp rather than before it.
    //
    // The distinction is load-bearing for the next person: a long-window golden
    // WITH destinations gets no immunity from this test, and adding one on the
    // strength of the old sentence would produce a fixture that quietly
    // re-measures itself at every week boundary.
    expect(pinPeriodForWeek(0)).toBe(PIN_PERIOD_TICKS)
    expect(pinPeriodForWeek(1)).toBe(466)
    expect(pinPeriodForWeek(19)).toBe(172)
  })

  it('shortens the period monotonically and then holds it flat at the cap', () => {
    // The table above is six points; this is the shape between and past them.
    // A `spawnScale` that returned the base unconditionally satisfies neither,
    // but a `spawnScale` that ramped the WRONG WAY (period growing with the
    // week) satisfies the two-point week-0/week-1 pair only by its endpoints.
    for (let w = 1; w <= 19; w++) {
      expect(pinPeriodForWeek(w), `week ${w} must be strictly shorter than week ${w - 1}`).toBeLessThan(
        pinPeriodForWeek(w - 1) as number,
      )
    }
    for (let w = 20; w <= 40; w++) {
      expect(pinPeriodForWeek(w), `week ${w} is past the cap and must not move`).toBe(pinPeriodForWeek(19))
    }
    // The whole ramp is a 3x shortening and no more — 518 -> 172 is 3.011x
    // rather than exactly 3 because 518000/3000 truncates. Stated so that
    // "demand triples" is read as the period shrinking, not as three times the
    // cars: see `spawnScale`'s own doc comment.
    expect(PIN_PERIOD_TICKS / (pinPeriodForWeek(19) as number)).toBeGreaterThan(3)
    expect(PIN_PERIOD_TICKS / (pinPeriodForWeek(19) as number)).toBeLessThan(3.02)
  })

  it('fires exactly ONCE on a week boundary and leaves no backlog behind it', () => {
    // The one-fire invariant SURVIVES the ramp, and the first draft of this
    // plan weakened it when it should have extended it. That draft asserted
    // `fires <= 3` from `floor((maxPeriod - 1) / minPeriod)` = floor(517/172) —
    // which pairs week 0's period with week 19's, and `H_WEEK` cannot cross 19
    // boundaries in one tick.
    //
    // The real bound is over ADJACENT weeks. The largest adjacent drop is
    // 0 -> 1: 518 - 466 = 52, and every later drop is smaller. Carrying in at
    // most `P_w - 1` = 517 plus `slotCount <= 36` gives 553; one fire leaves
    // 553 - 466 = 87, far under 466. **So the bound is ONE, the same as every
    // other tick, and there is no backlog to drain.**
    //
    // Consequence, recorded rather than papered over: the `while`-drain mutant
    // this test was originally written to catch is an EQUIVALENT MUTANT — a
    // `while` that can never iterate twice is a `for`. `fires <= 3` is
    // satisfied by every implementation including that mutant, which is a test
    // that cannot fail wearing a bound's clothes.
    const { state, scratch } = accumulatorRig() // slotCount(0) = 2
    state.header[H_WEEK] = 0
    state.pinAccum[0] = (pinPeriodForWeek(0) as number) - 1 // 517, maximal carry-in
    state.header[H_WEEK] = 1
    const fires: number[] = []
    for (let i = 0; i < 4; i++) {
      const before = sumPins(state)
      advanceAccumulators(state, scratch)
      fires.push(sumPins(state) - before)
    }
    expect(fires[0], 'the boundary tick fires once').toBe(1)
    expect(fires.slice(1), 'and there is nothing queued behind it').toEqual([0, 0, 0])
    // Vacuity: the carry must genuinely have survived the period change, or
    // this is a test about an accumulator that was reset.
    expect(state.pinAccum[0], 'the remainder carried').toBe(517 + 2 - 466 + 2 + 2 + 2)
  })

  it('the one-fire bound has real headroom over every shipped map, and this is where it ends', () => {
    // **"36 is comfortably under 466" is a reassurance, not a bound, and the
    // difference matters because `demand.ts` labels the `while`-drain spelling
    // of the fire branch an EQUIVALENT MUTANT.** That label is a licence: it
    // tells a future reader that a `while` there can never iterate twice. It
    // stops being true at some slot count, and nothing computed where. This
    // test computes it, so a map that crosses the line fails HERE rather than
    // silently converting a documented equivalence into a live defect that
    // mutation testing will keep reporting as equivalent.
    //
    // Two clauses, and the binding one is NOT the obvious one:
    //
    //   within a week — `acc < P_w` before the tick, so after one fire
    //     `acc < slotCount`; a second fire needs `slotCount >= P_w`.
    //     Safe while `slotCount < min P_w`.
    //   at a week change — carry-in is at most `P_{w-1} - 1`, plus `slotCount`,
    //     less one fire of `P_w`; a second fire needs that residue `>= P_w`.
    //     Safe while `slotCount < min (2*P_w - P_{w-1} + 1)`.
    //
    // Computed from `pinPeriodForWeek` itself over the whole ramp and well
    // past its cap, so this is an oracle over the production function's
    // outputs rather than a second copy of it.
    const WEEKS = 200
    let tickClause = Infinity
    let edgeClause = Infinity
    let edgeWeek = -1
    for (let w = 0; w <= WEEKS; w++) {
      const p = pinPeriodForWeek(w) as number
      if (p < tickClause) tickClause = p
      if (w > 0) {
        const e = 2 * p - (pinPeriodForWeek(w - 1) as number) + 1
        if (e < edgeClause) {
          edgeClause = e
          edgeWeek = w
        }
      }
    }
    expect(tickClause, 'the within-a-week clause is the ramp`s shortest period').toBe(172)
    expect(edgeClause).toBe(167)
    expect(edgeClause, 'the BOUNDARY clause binds first — the obvious one does not').toBeLessThan(
      tickClause,
    )
    // **Not at the 0 -> 1 drop, and not at the cap either — I predicted 19 and
    // this assertion caught it.** The 0 -> 1 boundary has the largest absolute
    // drop (52) but also the largest `P_w` to absorb it; the tightest ratio is
    // the LAST drop before the cap, 180 -> 173 at the 17 -> 18 boundary, where
    // `2*173 - 180 + 1` = 167. Week 19 drops only 173 -> 172 and gives 172.
    expect(edgeWeek, 'the last drop before the cap is the tight one').toBe(18)
    expect(pinPeriodForWeek(17)).toBe(180)
    expect(pinPeriodForWeek(18)).toBe(173)
    expect(2 * 173 - 180 + 1).toBe(edgeClause)

    // The largest slot count the invariant survives, and the map size it
    // corresponds to. Strict inequalities against an independently computed
    // bound, not a restatement of the same number.
    const largestSafeSlotCount = Math.min(tickClause, edgeClause) - 1
    expect(largestSafeSlotCount).toBe(166)

    // **ORDER IS LOAD-BEARING HERE, and the first version of this test got it
    // wrong.** The identity pins below (`SHIPPED_MAX_SLOT_COUNT` is 36,
    // `demoCity` is 18) fire for ANY change to a map's `maxDestinations` —
    // including a perfectly safe growth to 20. Written above the bound check
    // they MASK it: a map raised to 84, which genuinely breaks the one-fire
    // invariant, failed on "expected 168 to be 36" and the bound assertion
    // never ran. Measured, by making that exact edit. So the bound goes first
    // and the pins go last, and the two now say different things — "the
    // invariant is broken" versus "a map grew, update the recorded figure".
    expect(
      SHIPPED_MAX_SLOT_COUNT,
      'a shipped map now exceeds the one-fire bound: `demand.ts` calls the `while`-drain ' +
        'spelling of the fire branch an EQUIVALENT MUTANT, and that label is no longer true',
    ).toBeLessThan(largestSafeSlotCount)
    // 4.6x of headroom today. Stated as a ratio so a map that eats most of it
    // is visible here even while still technically safe.
    expect(largestSafeSlotCount / SHIPPED_MAX_SLOT_COUNT).toBeGreaterThan(4)

    // The identity pins. A failure HERE and not above means a map changed size
    // safely, and the figures in `demand.ts`'s module comment need updating.
    expect(SHIPPED_MAX_SLOT_COUNT).toBe(36)
    // In map terms: `maxDestinations` may reach 83, all circles, against 18
    // today. This is the line the `while`-equivalence label is good up to.
    expect(Math.floor(largestSafeSlotCount / 2)).toBe(83)
    expect(demoCity().maxDestinations).toBe(18)
    expect(firstCity().maxDestinations).toBe(16)
    // Vacuity: the bound is genuinely reachable arithmetic, not Infinity left
    // over from an unentered loop.
    expect(Number.isFinite(largestSafeSlotCount)).toBe(true)
  })

  it('carries the remainder ACROSS a period change, at a slot count that divides neither period', () => {
    // **The demand golden in `loop.test.ts` cannot see this, and this test is
    // why that is acceptable.** That fixture has one square, so its
    // `slotCount` is 1 and the accumulator lands EXACTLY on 518 and exactly on
    // 466 — `acc -= period` and `acc = 0` are the same write there, and
    // mutating one into the other leaves the golden green (measured: 0
    // detectors in `loop.test.ts`). A golden is not a substitute for a fixture
    // built to separate two models.
    //
    // 3 divides neither 518 (2 * 7 * 37) nor 466 (2 * 233), so the residue is
    // non-zero at every fire and the models separate:
    //
    //   week 0, period 518, slotCount 3:
    //     fire 1, tick 173: acc 519 -> 1
    //     fire 2, tick 346: acc 1 + 519 = 520 -> 2
    //   the period changes to 466, carrying acc = 2:
    //     fire 3, tick 501: acc 2 + 465 = 467 -> 1
    //
    // A reset-to-0 accumulator fires its third at 346 + ceil(466/3) = 502 with
    // acc 0. Both the TICK and the RESIDUE discriminate, and the discriminating
    // fire is on the far side of a period change — the case the ramp adds and
    // the pre-existing carry test (which never changes week) cannot reach.
    const SLOTS = 3
    expect(PIN_PERIOD_TICKS % SLOTS, 'week 0 must not divide evenly, or this test is blind').not.toBe(0)
    expect((pinPeriodForWeek(1) as number) % SLOTS, 'nor week 1').not.toBe(0)

    const { map, world } = fixture('carry-across-a-period-change')
    const { state, scratch } = rig(map, world)
    placeEligibleNow(state, world, 0, 0, 0, DEST_KIND_SQUARE)
    const CHANGE_TICK = 347 // one tick after fire 2, so the carry must survive it
    const WINDOW = 520
    const fires: number[] = []
    let prev = 0
    state.header[H_WEEK] = 0
    for (let n = 1; n <= WINDOW; n++) {
      state.header[H_TICK] = n
      if (n === CHANGE_TICK) state.header[H_WEEK] = 1
      for (let c = 0; c < scratch.slotCounts.length; c++) scratch.slotCounts[c] = 0
      scratch.slotCounts[0] = SLOTS
      advanceAccumulators(state, scratch)
      const total = sumPins(state)
      if (total !== prev) {
        fires.push(n)
        prev = total
      }
    }

    expect(fires).toEqual([173, 346, 501])
    // The reset model's third fire, computed independently of the run.
    const resetThird = 346 + Math.ceil((pinPeriodForWeek(1) as number) / SLOTS)
    expect(resetThird).toBe(502)
    expect(fires[2], 'the carry moves the post-boundary fire one tick earlier').not.toBe(resetThird)
    // ...and the residue after it is 1, not 0 — the second discriminator, and
    // the one a run that happened to fire on the right tick would still fail.
    expect(state.pinAccum[0]).toBe(1 + SLOTS * (WINDOW - 501))
    expect(state.pinAccum[0]).toBe(58)
    // Vacuity: the period genuinely changed inside the window, and the third
    // fire is genuinely on the far side of it.
    expect(state.header[H_WEEK]).toBe(1)
    expect(fires[2]).toBeGreaterThan(CHANGE_TICK)
    expect(fires[1]).toBeLessThan(CHANGE_TICK)
  })

  it('the largest ADJACENT period drop is 0 -> 1, which is what makes the bound one', () => {
    // The derivation the module comment and the boundary test both rest on,
    // asserted rather than asserted-about: if some later adjacent pair dropped
    // by more than 52, the residue argument would have to be redone at that
    // pair instead. The slot-count ceiling is `2 * maxDestinations` over the
    // maps this repo ships, which is 36 (`demoCity`, 18 destinations) and not
    // the 32 this comment used to claim — see `SHIPPED_MAX_SLOT_COUNT`.
    let worstDrop = 0
    let worstWeek = -1
    for (let w = 1; w <= 40; w++) {
      const drop = (pinPeriodForWeek(w - 1) as number) - (pinPeriodForWeek(w) as number)
      if (drop > worstDrop) {
        worstDrop = drop
        worstWeek = w
      }
    }
    expect(worstWeek).toBe(1)
    expect(worstDrop).toBe(PIN_PERIOD_TICKS - 466)
    expect(worstDrop).toBe(52)
    // Maximal carry-in plus the maximal per-tick increment, less one fire, is
    // strictly under the smallest threshold that carry can meet.
    expect(SHIPPED_MAX_SLOT_COUNT, 'demoCity is 18 destinations, all circles').toBe(36)
    const residue = (PIN_PERIOD_TICKS - 1) + SHIPPED_MAX_SLOT_COUNT - (pinPeriodForWeek(1) as number)
    expect(residue).toBe(87)
    expect(residue).toBeLessThan(pinPeriodForWeek(1) as number)
    // And the same statement for every later boundary, since a smaller drop
    // makes the residue smaller: this is the "the bound stays one" claim over
    // the whole ramp rather than at its worst point only.
    for (let w = 1; w <= 40; w++) {
      const carriedIn = (pinPeriodForWeek(w - 1) as number) - 1 + SHIPPED_MAX_SLOT_COUNT
      expect(carriedIn - (pinPeriodForWeek(w) as number), `week ${w}`).toBeLessThan(
        pinPeriodForWeek(w) as number,
      )
    }
  })
})

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

describe('the eligibility gate at the ROTATION\'s three other call sites (I2 review finding)', () => {
  // `isEligibleOfColour` is `colour-match AND eligible`. The block above
  // tests the gate only through `computeSlotCounts`'s DIRECT `isEligible`
  // call — it says nothing about whether an ineligible same-colour
  // destination can still become "current" (`resolveCurrent`), get folded
  // into the rotation's "next" pointer (`advanceCursor`), or receive an
  // overflow pin. All three are `isEligibleOfColour` call sites the module
  // comment claims are gated and none had a witness where dropping the
  // eligibility half (while keeping the colour half) changes the outcome —
  // every existing fixture uses `placeEligibleNow`, so every same-colour
  // destination in every other test IS actually eligible by the time it
  // matters, and colour-only matching agrees with colour-and-eligibility
  // matching whenever eligibility happens to be true anyway.
  //
  // Non-redundancy: all four witnesses below were checked against the
  // committed (pre-fix) source and confirmed to survive — 381/381 passed
  // for each of dropping eligibility in `advanceCursor`, in the overflow
  // walk, in `resolveCurrent`, and for shifting `fireColour`'s `tick`
  // parameter by one — before these tests existed. They cannot be
  // redundant with tests that did not kill the thing they are added to kill.

  it('advanceCursor skips an ineligible same-colour destination when picking "next"', () => {
    const { map, world } = fixture('elig-advance-cursor')
    const { state, scratch } = rig(map, world)
    const dA = placeEligibleNow(state, world, 0, 0, 0, DEST_KIND_SQUARE) // index 0, eligible now
    const dHeld = state.header[H_DEST_COUNT] as number // index 1
    expect(placeDestination(state, world, cellFor(5, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    state.destSpawnTick[dHeld] = 0 // NOT backdated: eligible only once tick >= 120
    const dC = placeEligibleNow(state, world, 10, 0, 0, DEST_KIND_SQUARE) // index 2, eligible now
    expect([dA, dHeld, dC]).toEqual([0, 1, 2])

    // Force the bootstrap fire at tick 1 — long before dHeld's tick-120
    // threshold, so it is provably still ineligible when advanceCursor's
    // search runs. resolveCurrent finds dA immediately (step 0, genuinely
    // eligible); dA is a square, so advanceCursor searches forward from
    // index 0 for the next eligible colour-0 destination.
    forceFireAtTick(state, scratch, 1, 0)
    expect(state.destPins[dA]).toBe(1) // the fire landed where expected
    expect((state.header[H_TICK] as number) - (state.destSpawnTick[dHeld] as number)).toBeLessThan(FIRST_PIN_DELAY_TICKS)

    // Correct: skip dHeld (ineligible), land on dC. A colour-only search
    // (eligibility half dropped) would stop at dHeld instead.
    expect(state.rotationCursor[0]).toBe(dC * 2)
    expect(state.rotationCursor[0]).not.toBe(dHeld * 2)
  })

  it('the overflow walk skips an ineligible same-colour destination and drops the pin rather than deliver to it', () => {
    const { map, world } = fixture('elig-overflow-walk')
    const { state, scratch } = rig(map, world)
    const dA = placeEligibleNow(state, world, 0, 0, 0, DEST_KIND_SQUARE) // index 0, eligible, will be capped
    const dHeld = state.header[H_DEST_COUNT] as number // index 1
    expect(placeDestination(state, world, cellFor(5, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    state.destSpawnTick[dHeld] = 0 // held ineligible, but has PLENTY of room
    state.destPins[dA] = PIN_CAP_SQUARE_HARD // pre-cap the only OTHER-than-dHeld colour-0 destination

    const droppedBefore = state.header[H_PINS_DROPPED] as number
    // Force the fire at tick 1: resolveCurrent finds dA (eligible, capped)
    // as chosen; the overflow walk's only candidate is dHeld, which is
    // NOT eligible yet.
    forceFireAtTick(state, scratch, 1, 0)
    expect((state.header[H_TICK] as number) - (state.destSpawnTick[dHeld] as number)).toBeLessThan(FIRST_PIN_DELAY_TICKS)

    // Correct: dHeld is skipped by the walk (still ineligible) -> no
    // candidate -> drop. Colour-only matching would hand it the pin.
    expect(state.destPins[dHeld], 'ineligible destination must not receive an overflow pin').toBe(0)
    expect(state.header[H_PINS_DROPPED]).toBe(droppedBefore + 1)
  })

  it('resolveCurrent skips an ineligible same-colour destination even when it is the LOWEST index (cannot become "current")', () => {
    const { map, world } = fixture('elig-resolve-current')
    const { state, scratch } = rig(map, world)
    const dLow = state.header[H_DEST_COUNT] as number // index 0 — lowest index, held ineligible
    expect(placeDestination(state, world, cellFor(0, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    state.destSpawnTick[dLow] = 0
    const dHigh = placeEligibleNow(state, world, 5, 0, 0, DEST_KIND_SQUARE) // index 1, eligible now
    expect([dLow, dHigh]).toEqual([0, 1])

    // Bootstrap cursor is 0, which decodes to dLow — exactly the case
    // `resolveCurrent`'s search exists for. Force the fire at tick 1,
    // before dLow's delay elapses.
    forceFireAtTick(state, scratch, 1, 0)
    expect((state.header[H_TICK] as number) - (state.destSpawnTick[dLow] as number)).toBeLessThan(FIRST_PIN_DELAY_TICKS)

    // Correct: resolveCurrent's step-0 check on dLow fails eligibility,
    // so it searches on and finds dHigh. Colour-only matching would stop
    // at step 0 and wrongly deliver to dLow.
    expect(state.destPins[dHigh], 'the only genuinely eligible destination receives the pin').toBe(1)
    expect(state.destPins[dLow], 'the lowest-index destination is ineligible and must not fire').toBe(0)
  })

  it('the tick used to evaluate eligibility inside one fire is exactly H_TICK, not H_TICK + 1 — a one-tick shift flips a destination sitting exactly on its own boundary', () => {
    const { map, world } = fixture('elig-tick-boundary')
    const { state, scratch } = rig(map, world)
    // Force the fire at STATE tick 1. Choose dBoundary's spawn tick so it
    // is ineligible AT tick 1 (1 - spawn = 119 < 120) but would be
    // eligible AT tick 2 (2 - spawn = 120 >= 120) — the exact boundary a
    // `tick + 1` bug would cross. dFallback is unconditionally eligible,
    // so clean code has somewhere correct to land instead of throwing.
    const dBoundary = state.header[H_DEST_COUNT] as number // index 0
    expect(placeDestination(state, world, cellFor(0, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    state.destSpawnTick[dBoundary] = 1 - (FIRST_PIN_DELAY_TICKS - 1)
    const dFallback = placeEligibleNow(state, world, 5, 0, 0, DEST_KIND_SQUARE) // index 1

    // Vacuity: the boundary is genuinely where the arithmetic says.
    expect(1 - (state.destSpawnTick[dBoundary] as number)).toBe(FIRST_PIN_DELAY_TICKS - 1)
    expect(2 - (state.destSpawnTick[dBoundary] as number)).toBe(FIRST_PIN_DELAY_TICKS)

    forceFireAtTick(state, scratch, 1, 0)

    // Correct: dBoundary is ineligible AT tick 1, so the fire lands on
    // dFallback. A `tick + 1` bug evaluates eligibility as if it were
    // tick 2, where dBoundary looks eligible, and lands on it instead.
    expect(state.destPins[dFallback], 'eligibility must be evaluated at H_TICK, not H_TICK + 1').toBe(1)
    expect(state.destPins[dBoundary]).toBe(0)
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

  it('redirects to the NEXT distinct, eligible, uncapped same-colour destination (not merely "the only one with room"), and advances the cursor past the ORIGINALLY CHOSEN slot', () => {
    // C1 fix (review finding): the previous version of this fixture capped
    // BOTH d2 (chosen) and d3, leaving exactly one uncapped same-colour
    // destination (d1). With only one candidate, every walk order that
    // visits all destinations reaches it — "start the overflow search at
    // index 0" (`d = step % destCount` instead of `d = (destIndex + step) %
    // destCount`) gives the SAME answer as the correct forward-from-chosen
    // walk, so the fixture met the brief's three literal conditions
    // (>= 3 same-colour destinations, capped one not at index 0, cursor not
    // at 0) while being unable to distinguish the two. This version caps
    // ONLY d2 (the chosen one), leaving TWO uncapped same-colour candidates
    // — d1 and d3 — straddling it, so the two walk orders diverge:
    //   correct (start at destIndex+1=3, wrap):  3 (d3, room) -> STOP, d3.
    //   mutant  (start at absolute index 1):      1 (d1, room) -> STOP, d1.
    // Verified live, not merely reasoned about: re-running the exact
    // mutation (`d = step % destCount`) against this fixture below fails
    // this test's `d3`/`d1` assertions (see the mutation table in the
    // task report).
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

    // Cap ONLY d2 (the chosen destination). d1 keeps its bootstrap pin (1,
    // well under cap) and d3 is left at 0 — BOTH have room, on opposite
    // sides of the chosen slot in destination-index order.
    state.destPins[d2] = PIN_CAP_SQUARE_HARD
    // Vacuity: genuinely full, not merely "close to" full; and d1/d3
    // genuinely still have room (the witness requires >= 2 candidates).
    expect(state.destPins[d2]).toBe(PIN_CAP_SQUARE_HARD)
    expect(state.destPins[d1]).toBeLessThan(PIN_CAP_SQUARE_HARD)
    expect(state.destPins[d3]).toBeLessThan(PIN_CAP_SQUARE_HARD)

    const droppedBefore = state.header[H_PINS_DROPPED] as number
    // Advance the accumulator by exactly one more fire's worth for colour 0.
    for (let i = 0; i < 1200 && (state.rotationCursor[0] as number) === cursorBeforeOverflow; i++) tick(state, scratch)

    // The overflow walk from chosen=d2 (index 2), forward: step1 -> d3
    // (index 3, colour 0, room) -> STOP. d3 is the recipient, not d1 —
    // this is what "NEXT distinct" means, as opposed to "any distinct
    // destination with room somewhere on the map."
    expect(state.destPins[d3], 'overflow recipient: d3, the NEXT distinct uncapped same-colour destination').toBe(1)
    expect(state.destPins[d1], 'd1 has room too, but is NOT next from the chosen slot — must be unchanged').toBe(1)
    expect(state.destPins[d2], 'd2 (the capped, chosen destination) is unchanged — it did NOT receive an extra pin').toBe(
      PIN_CAP_SQUARE_HARD,
    )
    expect(state.header[H_PINS_DROPPED], 'no drop: d3 had room').toBe(droppedBefore)

    // The cursor advances past the ORIGINALLY CHOSEN slot (d2), never past
    // the overflow recipient (d3). advance(chosen=d2,square) searches for
    // the next colour-0 destination after index 2: d3 (colour 0, eligible —
    // eligibility does not care about cap) -> cursor = 3*2 = 6. This
    // happens to be the same formula as "advance past the recipient" would
    // give here (recipient IS d3), so the recipient-vs-chosen distinction
    // is covered by the SECOND overflow test below instead, where the
    // recipient and the chosen destination are provably different indices.
    expect(state.rotationCursor[0]).toBe(d3 * 2)
    expect(state.rotationCursor[0]).not.toBe(cursorBeforeOverflow)
  })

  it('finds the sole remaining candidate after walking past BOTH a capped same-colour destination and a wrong-colour one — not redundant with the all-capped/drop test, which cannot distinguish an early-truncated walk from a correct one', () => {
    // Cap d2 (chosen) AND d3, leaving ONLY d1 with room: the walk must
    // pass over d3 (capped, same colour) and d0 (colour 1, wrong colour)
    // before reaching d1 — three loop iterations (step 1, 2, 3), not one.
    //
    // Non-redundancy, checked rather than assumed: the all-capped/drop test
    // below walks this EXACT same path (d3, then d0, then d1) but with d1
    // ALSO capped, so its outcome (drop) is identical whether the loop's
    // third iteration (d1) runs or not — an off-by-one that truncates the
    // walk one iteration early (`step < destCount - 1` instead of `step <
    // destCount`) still drops, and the all-capped test cannot see the
    // difference. HERE d1 has room, so the same truncation would wrongly
    // drop a pin that should have been delivered — this fixture is the one
    // that can tell "walked the full distance" from "gave up one step
    // early", which the all-capped test structurally cannot.
    const { state, scratch, d1, d2, d3 } = buildOverflowRig()
    for (let i = 0; i < 1200 && (state.destPins[d1] as number) === 0; i++) tick(state, scratch)
    const cursorBeforeOverflow = state.rotationCursor[0] as number
    state.destPins[d2] = PIN_CAP_SQUARE_HARD
    state.destPins[d3] = PIN_CAP_SQUARE_HARD
    expect(state.destPins[d1]).toBeLessThan(PIN_CAP_SQUARE_HARD) // the only candidate with room

    const droppedBefore = state.header[H_PINS_DROPPED] as number
    for (let i = 0; i < 1200 && (state.rotationCursor[0] as number) === cursorBeforeOverflow; i++) tick(state, scratch)

    expect(state.destPins[d1], 'walked past capped d3 and wrong-colour d0 to reach d1').toBe(2)
    expect(state.destPins[d2]).toBe(PIN_CAP_SQUARE_HARD)
    expect(state.destPins[d3]).toBe(PIN_CAP_SQUARE_HARD)
    expect(state.header[H_PINS_DROPPED]).toBe(droppedBefore)
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
  it('holds even at the largest slot count any shipped map can reach (36), forced directly via scratch', () => {
    const { map, world } = fixture('one-per-tick', 40, 16, 5)
    const { state, scratch } = rig(map, world)
    const d = placeEligibleNow(state, world, 0, 0, 0, DEST_KIND_SQUARE)

    let prevTotal = 0
    for (let i = 0; i < 50; i++) {
      state.header[H_TICK] = (state.header[H_TICK] as number) + 1
      // Bypass computeSlotCounts: force the largest realistic slotCount
      // (`SHIPPED_MAX_SLOT_COUNT` = 2 * demoCity's 18 = 36) directly, without
      // needing 18 real circle destinations. **This read 32 until M1e Task 6's
      // review** — `firstCity`'s ceiling, on a repo that also ships a bigger
      // map — so the "maximum possible" in this test's name was 4 slots short
      // of the real one.
      scratch.slotCounts[0] = SHIPPED_MAX_SLOT_COUNT
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

describe('an out-of-range destination colour fails loudly, not silently (M1c Task 4 review, ruling 2)', () => {
  it('computeSlotCounts throws for a colour past the map’s group count', () => {
    // `slotCounts` is an `Int32Array(groupCount)`, and an out-of-range
    // typed-array write is a SILENT no-op — so before this guard a
    // destination whose packed colour exceeded `groupCount` contributed no
    // demand, never took its turn in the rotation and never requested a car,
    // with no error and nothing to point at.
    //
    // `placeDestination` now rejects such a colour at the boundary
    // (buildings.ts), so this guard is reachable only from a hand-written
    // `destMeta` byte — which is what it is defence-in-depth against, and the
    // same standing as the mirror guard in `assembleSources` (dispatch.ts).
    const { map, world } = fixture('slotcount-colour-range')
    const { state, scratch } = rig(map, world)
    expect(map.groupCount).toBe(5)
    const d = placeEligibleNow(state, world, 0, 0, 0, DEST_KIND_SQUARE)
    state.destMeta[d] = ((state.destMeta[d] as number) & ~0x7) | 6

    expect(() => computeSlotCounts(state, scratch)).toThrow(/colour 6/)
  })

  it('counts the boundary colour itself, so the guard is not rejecting everything', () => {
    const { map, world } = fixture('slotcount-colour-boundary')
    const { state, scratch } = rig(map, world)
    placeEligibleNow(state, world, 0, 0, 4, DEST_KIND_SQUARE)
    state.header[H_TICK] = 1

    computeSlotCounts(state, scratch)
    expect(scratch.slotCounts[4]).toBe(1)
  })
})
