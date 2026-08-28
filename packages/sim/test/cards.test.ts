import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CARD_GRANT_ITEM,
  CARD_GRANT_ROAD_TILES,
  PIN_CAP_SQUARE_TIMER,
  TICKS_PER_WEEK,
  UPGRADES_PER_CARD,
  WEEKLY_TILE_GRANT,
  demoCity,
  firstCity,
  parseMap,
  type MapData,
} from '@laneways/shared'
import {
  CARD_BRIDGE,
  CARD_COUNT,
  CARD_IMPLEMENTED_MASK,
  CARD_JUNCTION_UPGRADE,
  CARD_MOTORWAY,
  CARD_NONE,
  CARD_ROAD_TILES,
  CARD_ROUNDABOUT,
  CARD_TRAFFIC_LIGHTS,
  CARD_TUNNEL,
  OFFER_SLOT_A,
  OFFER_SLOT_B,
  applyChooseCard,
  canDrawOfferPair,
  capabilityMask,
  cardItemGrant,
  cardTileGrant,
  drawOfferPair,
  nthSetBit,
  offerSeedFor,
  pickFromPool,
  poolFor,
  popCountCards,
  runOfferFromPool,
  tryDrawOfferPair,
} from '../src/cards'
import { mixWord } from '../src/rng'
import {
  createState,
  hashState,
  isGameOver,
  offerPending,
  restore,
  snapshot,
  H_EPOCH,
  H_INV_UPGRADES,
  H_OFFER_A,
  H_OFFER_B,
  H_OFFER_WEEK,
  H_TICK,
  H_TILES,
  H_WEEK,
  type GameState,
} from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFlowFields, createScratch, type FlowField, type Scratch } from '../src/scratch'
import { createFieldInputRanges } from '../src/regions'
import { step, type TickInputs } from '../src/step'
import { placeDestination, placeHouse, DEST_KIND_SQUARE, ORIENTATION_S } from '../src/buildings'
import { placeRoad, roadMask } from '../src/roads'
import { DEMAND_PIN_MAP, GOLDEN_MAP, allLandRows } from './mapFixtures'

const NO_INPUT: TickInputs = { actions: [] }

/**
 * A CALL to `drawOfferPair`, as opposed to a mention of the name. The lookbehind
 * is what makes it miss `tryDrawOfferPair(`; the `\\s*` is what makes it see a
 * call written with a space before the paren. Non-global on purpose — a `/g`
 * regex carries `lastIndex` between `.test()` calls and would alternate
 * true/false across the file loop below.
 */
const CALLS_DRAW = /(?<![A-Za-z])drawOfferPair\s*\(/

/**
 * One `choose-card` action for a tick. `b` is the card id the CLIENT believes
 * the slot holds — an ECHO, and the thing `applyChooseCard` compares against.
 */
function chooseCard(slot: number, cardId: number): TickInputs {
  return { actions: [{ kind: 'choose-card', a: slot, b: cardId }] }
}

/**
 * A 4x4 all-land board, on `step.test.ts`'s recipe and for its reason: the
 * clipped spawn zone is empty on a 4-wide board, so nothing spawns, no car ever
 * exists, and the only things that move across a week boundary are the tile
 * grant and — from this task — the two offer slots.
 */
const CARDS_MAP = parseMap('cards-test-map', ['....', '....', '....', '....'], 20, 8, 4, 2)
const CARDS_WORLD = createWorld(CARDS_MAP)

interface Rig {
  readonly s: GameState
  readonly world: WorldData
  readonly fields: readonly FlowField[]
  readonly scratch: Scratch
}

function bootCity(id: string): Rig {
  return {
    s: createState(id, CARDS_MAP),
    world: CARDS_WORLD,
    fields: createFlowFields(CARDS_MAP.groupCount, CARDS_WORLD.cells),
    scratch: createScratch(
      CARDS_WORLD.cells,
      CARDS_MAP.groupCount,
      CARDS_MAP.maxDestinations,
      createFieldInputRanges(CARDS_MAP),
    ),
  }
}

/** Steps until `H_TICK` is exactly `tick`. Throws rather than overshooting in silence. */
function driveTo(rig: Rig, tick: number): void {
  const from = rig.s.header[H_TICK] as number
  if (tick < from) throw new Error(`driveTo: already past tick ${tick} (at ${from})`)
  for (let t = from; t < tick; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
  if ((rig.s.header[H_TICK] as number) !== tick) {
    throw new Error(`driveTo: landed on ${rig.s.header[H_TICK]}, not ${tick}`)
  }
}

/**
 * A run that has already ended: one square destination pinned at its trigger cap
 * on a board with no house, so nothing ever arrives and §5.8 shuts the city down
 * — `step.test.ts`'s `shutdownRig`, which measures the end at tick 3,390, before
 * the first week boundary. That ordering is load-bearing here: the freeze must be
 * in place BEFORE the tick that would otherwise raise the first offer.
 */
function bootTerminal(id: string): Rig {
  const rig = bootCity(id)
  expect(placeDestination(rig.s, rig.world, 0, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  rig.s.destPins[0] = PIN_CAP_SQUARE_TIMER
  for (let i = 0; i < TICKS_PER_WEEK; i++) {
    step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    if (isGameOver(rig.s)) break
  }
  expect(isGameOver(rig.s), 'the terminal rig never reached game over').toBe(true)
  expect(rig.s.header[H_TICK], 'and it must end BEFORE the first offer would be raised').toBeLessThan(
    TICKS_PER_WEEK,
  )
  return rig
}

describe('the card ids', () => {
  it('are a contiguous domain with CARD_COUNT one past the highest', () => {
    // `CARD_COUNT` sizes the pool bitmask and the exhaustive mask loop below.
    // Derived here rather than at module scope, because a module-scope constant
    // computed from imported values is the M1f Task 1 defect (`roads.ts ->
    // dispatch.ts -> scratch.ts -> roads.ts` returned `undefined` and a hoisted
    // mask evaluated to 0). Here it is a test, so it cannot poison production.
    const ids = [
      CARD_NONE,
      CARD_ROAD_TILES,
      CARD_BRIDGE,
      CARD_TUNNEL,
      CARD_ROUNDABOUT,
      CARD_TRAFFIC_LIGHTS,
      CARD_MOTORWAY,
      CARD_JUNCTION_UPGRADE,
    ]
    expect(ids, 'the six spec 5.10 rows, CARD_NONE, and M1f’s own item').toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ])
    expect(CARD_COUNT, 'one past the highest id').toBe(Math.max(...ids) + 1)
    expect(new Set(ids).size, 'no two cards share an id').toBe(ids.length)
  })

  it('keeps CARD_NONE at 0, which state.ts depends on without importing it', () => {
    // `offerSlot` (state.ts) returns the literal `0` for "no offer" rather than
    // importing `CARD_NONE`, to keep `state.ts` free of a runtime edge into this
    // module — `state.ts` is imported by nearly every file in the package and
    // this package has a real import cycle already. This assertion is what stops
    // the two drifting, and it lives here beside the declaration.
    expect(CARD_NONE).toBe(0)
    // And the same for the two slot indices, which `offerSlot` also spells as
    // literals in its `slot === 0` / `slot === 1` branches.
    expect(OFFER_SLOT_A).toBe(0)
    expect(OFFER_SLOT_B).toBe(1)
  })

  it('gives CARD_JUNCTION_UPGRADE a NEW id rather than renaming the traffic light', () => {
    // Spec 5.10's table is a documented domain of six items and the light is one
    // of them; renaming its id would delete a row from that domain to record a
    // scope change. The light keeps 5 and carries Decision 14's measurement; the
    // upgrade is M1f's own substitution and gets 7.
    expect(CARD_TRAFFIC_LIGHTS).toBe(5)
    expect(CARD_JUNCTION_UPGRADE).toBe(7)
    expect(CARD_JUNCTION_UPGRADE).not.toBe(CARD_TRAFFIC_LIGHTS)
  })
})

describe('the offer draw is a pure function of the seed word and the week', () => {
  it('does not touch rng[0]', () => {
    const s = createState('laneways-m2', firstCity())
    const before = s.rng[0] as number
    offerSeedFor(s, 1)
    offerSeedFor(s, 2)
    expect(s.rng[0]).toBe(before)
  })

  it('gives a different word for each week, and the same word for the same week', () => {
    const s = createState('laneways-m2', firstCity())
    const w1 = offerSeedFor(s, 1)
    expect(offerSeedFor(s, 1), 'idempotent').toBe(w1)
    const seen = new Set<number>()
    for (let w = 1; w <= 40; w++) seen.add(offerSeedFor(s, w))
    expect(seen.size, '40 weeks, 40 distinct words').toBe(40)
  })

  it('the week-to-week DELTA depends on the seed, which is what pins mixWord', () => {
    // **This replaces an avalanche test that could not see its own target
    // mutant, and the measurement is why.** The brief specified "adjacent weeks
    // differ in at least a third of their bits, `toBeGreaterThan(10)`",
    // presented as the detector for replacing `mixWord(...)` with the bare xor.
    // Measured over four seeds x 40 week-pairs (n = 160): the real function
    // scores min 10 / mean 15.97 and the BARE XOR min 13 / mean 16.80.
    // **The mean is quoted with its enumeration because an earlier version of
    // this comment said "four seeds" while quoting 15.85 — which is the ONE-seed
    // figure. Two quantities under one description, and the load-bearing halves
    // (both minima) are 10 and 13 on either enumeration.** The
    // mutant avalanches BETTER, and the specified bound fails on the real
    // function at weeks 2 and 3 (exactly 10 bits). A Hamming distance cannot
    // separate them at all.
    //
    // What does separate them is structural rather than statistical. Without the
    // mix, `offerSeedFor(s, w) = rng[0] ^ K_w`, so
    // `offerSeedFor(s, w) ^ offerSeedFor(s, w + 1) = K_w ^ K_{w+1}` — the seed
    // CANCELS, and every seed in the game produces the identical week-to-week
    // delta sequence. Measured: 1 distinct delta row across four seeds under the
    // xor, 4 distinct rows under `mixWord`.
    const seeds = ['laneways-m2', 'some-other-seed', 'x', 'zzz']
    const rows = new Set<string>()
    for (const seed of seeds) {
      const s = createState(seed, firstCity())
      const row: number[] = []
      for (let w = 1; w <= 6; w++) row.push((offerSeedFor(s, w) ^ offerSeedFor(s, w + 1)) >>> 0)
      rows.add(row.join(','))
    }
    expect(rows.size, 'the seed must not cancel out of the week-to-week delta').toBe(seeds.length)
  })

  it('spreads adjacent weeks widely, as a sanity check that does NOT pin mixWord', () => {
    // Labelled inert for the mutant above, per the catalogue's rule about tests
    // that pin a property nothing depends on: the bare xor passes this too, at
    // min 13 against this function's measured min of 10. It is kept because a
    // future change to the golden-ratio constant COULD collapse the spread, and
    // the bound is set from the measurement (min 10 over four seeds x 40 pairs)
    // rather than sketched.
    const s = createState('laneways-m2', firstCity())
    for (let w = 1; w <= 20; w++) {
      let bits = 0
      let x = (offerSeedFor(s, w) ^ offerSeedFor(s, w + 1)) >>> 0
      while (x !== 0) {
        bits += x & 1
        x >>>= 1
      }
      expect(bits, `weeks ${w} and ${w + 1} differ in ${bits} bits`).toBeGreaterThan(4)
    }
  })

  it('gives a different word for a different seed at the same week', () => {
    const a = createState('laneways-m2', firstCity())
    const b = createState('some-other-seed', firstCity())
    expect(offerSeedFor(a, 1)).not.toBe(offerSeedFor(b, 1))
  })

  it('is week 0 - safe, so the function is total even though week 0 has no offer', () => {
    // The `+ 1` exists so week 0 is not the identity case. Nothing calls this at
    // week 0 (`offerPending` excludes it), so there is no behavioural detector
    // for the `+ 1` — this is the totality check, labelled as such so nobody
    // reads it as coverage for the offset.
    //
    // **The RANGE moved at M1f Task 5 and the reason is allocation, not
    // arithmetic**: an unsigned return is above Smi range for half its values
    // and boxes a HeapNumber on every call, which cost nothing until phase 4
    // made this a per-tick path. The bound is now int32 rather than uint32; the
    // bits are the same and the test below proves it.
    const s = createState('laneways-m2', firstCity())
    for (const week of [0, 1, 2, 40]) {
      const w = offerSeedFor(s, week)
      expect(Number.isInteger(w), `week ${week}`).toBe(true)
      expect(w, `week ${week} must be a Smi, not a boxed uint32`).toBeGreaterThanOrEqual(-0x80000000)
      expect(w).toBeLessThanOrEqual(0x7fffffff)
    }
  })

  it('the `| 0` reinterprets the SAME 32 bits, so no draw and no golden can move with it', () => {
    // **The re-bless discipline applied to a representation change.** Task 5
    // narrowed this function's return from unsigned to signed to stop it
    // allocating; that is only safe because the bit pattern is untouched and the
    // one consumer re-widens it. Both halves are asserted rather than argued:
    // the word round-trips through `>>> 0` to the unsigned value the previous
    // body produced, and the PAIR `drawOfferPair` yields is identical from
    // either representation.
    const s = createState('laneways-m2', firstCity())
    const out = new Int32Array(2)
    const alsoOut = new Int32Array(2)
    for (let week = 1; week <= 12; week++) {
      const signed = offerSeedFor(s, week)
      const unsigned =
        mixWord(((s.rng[0] as number) ^ Math.imul(week + 1, 0x9e3779b1)) >>> 0)
      expect(signed >>> 0, `week ${week}`).toBe(unsigned)
      drawOfferPair(CARD_IMPLEMENTED_MASK, signed, out)
      drawOfferPair(CARD_IMPLEMENTED_MASK, unsigned, alsoOut)
      expect([out[0], out[1]], `week ${week}`).toEqual([alsoOut[0], alsoOut[1]])
    }
    // Vacuity: the two representations must actually DIFFER somewhere in the
    // range walked above, or this test compares a number with itself twelve
    // times. Half of all words are negative once signed.
    let negatives = 0
    for (let week = 1; week <= 12; week++) if (offerSeedFor(s, week) < 0) negatives++
    expect(negatives, 'no week produced a high-bit word, so the round trip proved nothing').toBeGreaterThan(0)
  })
})

describe('nthSetBit and popCountCards', () => {
  it('agrees with a brute-force scan on every mask a CARD_COUNT-bit pool can hold', () => {
    let checked = 0
    for (let mask = 0; mask < 1 << CARD_COUNT; mask++) {
      const bits: number[] = []
      for (let b = 0; b < CARD_COUNT; b++) if ((mask & (1 << b)) !== 0) bits.push(b)
      expect(popCountCards(mask), `popcount of ${mask}`).toBe(bits.length)
      for (let k = 0; k < bits.length; k++) {
        expect(nthSetBit(mask, k), `bit ${k} of ${mask}`).toBe(bits[k])
        checked++
      }
    }
    // The enumeration asserted EXACTLY, not with a floor. `spawn.ts` shipped a
    // comment claiming 430,122 cases over a sweep of 46,284 guarded by
    // `checked > 20000`; a size guard loose enough to survive a 78% narrowing is
    // not protecting the claim above it. Sum over 256 masks of their popcount is
    // 8 * 2^7 = 1,024.
    expect(1 << CARD_COUNT, 'the mask domain is 256 wide, not 128').toBe(256)
    expect(checked, 'sum of popcounts over all 256 masks').toBe(1024)
  })

  it('throws rather than returning a plausible index when k is past the end', () => {
    expect(() => nthSetBit(0b0110, 2)).toThrow(/only 2 set bits/)
    expect(() => nthSetBit(0, 0)).toThrow(/only 0 set bits/)
  })

  it('throws on an OUT-OF-CONTRACT k — negative or fractional — where seen === k and seen >= k part company', () => {
    // **Added from a mutation result, and the enumeration is why it is here.**
    // `seen === k` -> `seen >= k` scored 0 detectors over the whole suite. It is
    // not equivalent, though: swept over all 256 masks and INTEGER k in [-8, 12),
    // the two disagree on **2,040 cases, every one of them at k < 0, and on ZERO
    // cases at integer k >= 0**.
    //
    // **The word INTEGER is a correction.** This test was first named "the only
    // place ... differ" about negative k, and its own third assertion below
    // refutes that: at a FRACTIONAL k the two also part company (722 of 1,024
    // fractional cases), because `seen === 1.5` is never true and falls through
    // to the throw while `seen >= 1.5` returns bit 2. A test name contradicted
    // by its own body is the same defect class as a comment that overstates its
    // case — it reads as verified. The domain is out-of-contract k, of which
    // negative and fractional are the two kinds.
    //
    // `drawOfferPair` produces neither, and the exhaustive agreement test above
    // only walks integer [0, popcount), so the difference sat entirely outside
    // every fixture.
    //
    // It is worth closing rather than recording, because of what the mutant
    // RETURNS: `nthSetBit(mask, -1)` under `seen >= k` hands back the first set
    // bit — a perfectly plausible card id — where the contract is a throw. That
    // is the catalogue's `Int32Array` pointer-id shape: an out-of-contract input
    // must not be able to return a believable answer, however unreachable it
    // looks from today's callers.
    expect(() => nthSetBit(0b0110, -1)).toThrow(/asked for set bit -1/)
    expect(() => nthSetBit(0xff, -3)).toThrow(/asked for set bit -3/)
    // And a non-integer, which is the OTHER out-of-contract kind and the one
    // this test used to deny existed: `seen === 1.5` is never true, so the loop
    // falls through to the throw, where `seen >= 1.5` would return bit 2.
    expect(() => nthSetBit(0b0110, 1.5)).toThrow(/asked for set bit 1.5/)
  })
})

describe('canDrawOfferPair', () => {
  it('is the SAME predicate drawOfferPair throws on, not a second copy of it', () => {
    // The catalogue's "when the same wrong constant can reach both, extract the
    // predicate rather than restating it". `runOffer` (M1f Task 5) must not
    // reach `drawOfferPair`'s throw, and the only way to guarantee that without
    // a second, drifting copy of "at least two" is for both to read this.
    // Swept over the whole mask domain, so agreement is a property rather than
    // three examples.
    const out = new Int32Array(2)
    let refused = 0
    let drawn = 0
    for (let pool = 0; pool < 1 << CARD_COUNT; pool++) {
      let threw = false
      try {
        drawOfferPair(pool, 12345, out)
      } catch {
        threw = true
      }
      expect(canDrawOfferPair(pool), `pool ${pool}`).toBe(!threw)
      if (threw) refused++
      else drawn++
    }
    // Vacuity: both arms must be populated, or the sweep proves one branch only.
    // 9 of the 256 masks hold fewer than two cards: the empty mask and the 8
    // singletons.
    expect(refused, 'the empty mask and the 8 singletons').toBe(9)
    expect(drawn).toBe(256 - 9)
  })
})

/**
 * The six pairs `drawOfferPair` returns for seeds 0..5 on the three-card pool
 * `{CARD_ROAD_TILES, CARD_TUNNEL, CARD_JUNCTION_UPGRADE}`. Captured from the
 * real function at M1f Task 5 and pinned because the `mixWord` between the two
 * picks is invisible on every OTHER fixture in this repo — see the test that
 * reads it.
 */
const THREE_CARD_SEEDS: readonly number[] = [0, 1, 16, 17, 18, 19]
const PAIRS_ON_A_THREE_CARD_POOL: readonly [number, number][] = [
  [1, 3],
  [3, 7],
  [3, 7],
  [7, 1],
  [1, 7],
  [3, 7],
]

describe('drawOfferPair', () => {
  const out = new Int32Array(2)

  it('draws two DISTINCT cards from the pool', () => {
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE) | (1 << CARD_BRIDGE)
    for (let seed = 0; seed < 500; seed++) {
      drawOfferPair(pool, seed, out)
      expect(out[0], `seed ${seed}`).not.toBe(out[1])
      expect((pool & (1 << (out[0] as number))) !== 0, `seed ${seed} slot A in pool`).toBe(true)
      expect((pool & (1 << (out[1] as number))) !== 0, `seed ${seed} slot B in pool`).toBe(true)
    }
  })

  it('reaches both orders on a two-card pool, which is the shipped case', () => {
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE)
    let aFirst = 0
    for (let seed = 0; seed < 200; seed++) {
      drawOfferPair(pool, seed, out)
      if (out[0] === CARD_ROAD_TILES) aFirst++
    }
    // The only randomness the shipped pool has is the ORDER, and without it a
    // player learns "slot A is always tiles" in two weeks. A hard bound rather
    // than a proportion: 200 draws that all come out the same way is the defect.
    expect(aFirst, 'both orders occur').toBeGreaterThan(20)
    expect(aFirst, 'both orders occur').toBeLessThan(180)
  })

  it('covers every card of a four-card pool across enough draws', () => {
    const pool =
      (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE) | (1 << CARD_BRIDGE) | (1 << CARD_TUNNEL)
    const seen = new Set<number>()
    for (let seed = 0; seed < 400; seed++) {
      drawOfferPair(pool, seed, out)
      seen.add(out[0] as number)
      seen.add(out[1] as number)
    }
    expect(seen.size, 'the rejection path reaches every card, not just the low bits').toBe(4)
  })

  it('pins one (pool, seed) -> PAIR on a THREE-card pool, which is the smallest fixture the re-mix moves', () => {
    // **The line this exists for is the `mixWord` between the two picks, and the
    // comment above it claimed until M1f Task 5 that "no test CAN distinguish
    // the two". That was false and this is the test that ends it.** Measured
    // over 20,000 seeds, comparing the pair with the re-mix against the pair
    // without:
    //
    //     n = 2 (the shipped pool)        0 / 20,000 seeds differ
    //     n = 3                       9,954 / 20,000 differ
    //     n = 4                      13,320 / 20,000 differ
    //     n = 6                      15,896 / 20,000 differ
    //
    // At n = 2 slot B has one candidate and `v % 1` is 0 whatever the word, so
    // the second pick cannot see its input — which is why every other test in
    // this file, every golden, and `poolFor` itself are all blind to the line.
    // THREE cards is the smallest pool that is not.
    //
    // Values captured from the real function, and the seeds are chosen so the
    // pin is not vacuous: each of these differs from the no-re-mix answer, which
    // the sibling assertion below states as a property rather than a hope.
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_TUNNEL) | (1 << CARD_JUNCTION_UPGRADE)
    expect(popCountCards(pool), 'three cards, or this pins the wrong thing').toBe(3)
    const pairs: [number, number][] = []
    for (const seed of THREE_CARD_SEEDS) {
      drawOfferPair(pool, seed, out)
      pairs.push([out[0] as number, out[1] as number])
    }
    expect(pairs).toEqual(PAIRS_ON_A_THREE_CARD_POOL)
    // **Vacuity, and it is the whole point of the fixture: the SEEDS are chosen,
    // not the first six integers.** Seeds 0..15 on this pool all happen to give
    // the same answer with and without the re-mix, so a pin over 0..5 would sit
    // in exactly the blind spot it exists to close — measured, it scored `moved`
    // = 0 on the first attempt. 16, 17 and 18 are the first three that move.
    // Computed here from the same primitives rather than hard-coded, so it stays
    // honest if `mixWord` ever changes.
    let moved = 0
    for (let k = 0; k < THREE_CARD_SEEDS.length; k++) {
      const seed = THREE_CARD_SEEDS[k] as number
      const n = popCountCards(pool)
      const a = pickFromPool(pool, n, seed)
      const withoutRemix = pickFromPool(pool & ~(1 << a), n - 1, seed)
      if (withoutRemix !== (pairs[k] as [number, number])[1]) moved++
    }
    expect(moved, 'none of the chosen seeds can see the re-mix, so this pin is inert').toBe(3)
  })

  it('is deterministic: the same seed and pool give the same pair', () => {
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_TRAFFIC_LIGHTS) | (1 << CARD_BRIDGE)
    drawOfferPair(pool, 987654, out)
    const first = [out[0], out[1]]
    drawOfferPair(pool, 987654, out)
    expect([out[0], out[1]]).toEqual(first)
  })

  it('THROWS on a pool with fewer than two cards — and this throw must be unreachable from runOffer', () => {
    // Kept as a throw because reaching it means `runOffer`'s guard is gone, which
    // is a programming error and a plausible fallback would hide it. What must
    // never happen is `step` reaching it: see `canDrawOfferPair` above, which is
    // the guard `runOffer` (M1f Task 5) is required to call, and
    // `capabilityMask`'s map-only inputs (M1f Task 11, landed). The previous draft had
    // this throw with no guard in front of it, and on the state golden's 4x4 map
    // it fired at tick 4,500 of a 13,499-tick fixture, AFTER `step` had written
    // `H_EPOCH` — poisoning the buffer permanently.
    expect(() => drawOfferPair(1 << CARD_ROAD_TILES, 1, out)).toThrow(/needs at least two/)
    expect(() => drawOfferPair(0, 1, out)).toThrow(/needs at least two/)
  })

  it('writes through the CALLER’S array and returns nothing', () => {
    // **What this does and does not establish, stated because the previous
    // draft's version of it — `expect(drawOfferPair(...)).toBeUndefined()` —
    // established nothing at all.** A `void` function returns `undefined`
    // whatever it allocates, so that assertion is satisfied by an
    // implementation that builds a candidate array on every call. What CAN be
    // pinned here is the signature property that makes allocation-freedom
    // possible: the result lands in the caller's own buffer, so no array is
    // created to carry it. The per-tick byte figure is the allocation harness's
    // job and not this file's.
    const mine = new Int32Array(2)
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE)
    const r = drawOfferPair(pool, 1, mine)
    expect(r).toBeUndefined()
    expect(mine[0]).not.toBe(0)
    expect(mine[1]).not.toBe(0)
    // Same array object on a second call — nothing was swapped in behind it.
    const before = mine
    drawOfferPair(pool, 2, mine)
    expect(mine).toBe(before)
  })
})

describe('pickFromPool', () => {
  it('returns a card that is actually in the pool, for every mask and every word', () => {
    // A property over the whole mask domain rather than a handful of examples:
    // `nthSetBit(pool, v % n)` is only correct while `n` really is the pool's
    // popcount, and an off-by-one there returns a plausible card id.
    for (let pool = 1; pool < 1 << CARD_COUNT; pool++) {
      const n = popCountCards(pool)
      for (const word of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 123456789]) {
        const card = pickFromPool(pool, n, word)
        expect((pool & (1 << card)) !== 0, `pool ${pool} word ${word} gave ${card}`).toBe(true)
      }
    }
  })

  it('TERMINATES: every value the rejection loop can start from escapes it', () => {
    // **The brief justified this loop with "`mixWord` is a bijection on 32 bits".
    // That is an unproven claim about the arithmetic, and it is the one that
    // matters** — `randomBelow`'s identical-looking loop is safe for a reason
    // this one does not share: `nextRandom` ADVANCES a counter by 0x6d2b79f5, so
    // it walks the full 2^32 period and cannot cycle, whereas re-mixing a word
    // with a stateless function can in principle land back where it started. An
    // infinite loop inside `step` is worse than the throw this task exists to
    // remove.
    //
    // It does not need a bound, because the hazard's domain is FINITE AND TINY
    // and can simply be enumerated: the loop is entered only for `v >= limit`,
    // and there are exactly `2^32 % n` such values for each `n`. Summed over
    // every `n` this module can produce (1..CARD_COUNT), that is ten starting
    // points in total. Each is walked here and asserted to escape.
    let starts = 0
    for (let n = 1; n <= CARD_COUNT; n++) {
      const limit = 0x100000000 - (0x100000000 % n)
      for (let v = limit; v < 0x100000000; v++) {
        starts++
        let x = v
        let steps = 0
        while (x >= limit) {
          x = mixWord(x)
          steps++
          expect(steps, `n=${n} start=${v} did not escape`).toBeLessThan(1000)
        }
      }
    }
    // Vacuity: if this enumeration were empty the loop above would prove
    // nothing. 2^32 % n for n = 1..8 is 0,0,1,0,1,4,4,0 — ten in total.
    expect(starts, 'the whole reachable hazard domain, enumerated').toBe(10)
  })

  it('handles the single-card pool drawOfferPair hands it for slot B', () => {
    // `drawOfferPair` calls `pickFromPool(rest, n - 1, word)`, and on the
    // SHIPPED two-card pool that is `n - 1 === 1`. `2^32 % 1` is 0, so there is
    // no rejection and `v % 1` is 0 — the one remaining card, whatever the word.
    for (const card of [CARD_ROAD_TILES, CARD_JUNCTION_UPGRADE, CARD_MOTORWAY]) {
      for (const word of [0, 1, 0xffffffff, 42]) {
        expect(pickFromPool(1 << card, 1, word)).toBe(card)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// M1f Task 5 — the pool, the welded guard, and phase 4
// ---------------------------------------------------------------------------

describe('CARD_IMPLEMENTED_MASK and poolFor', () => {
  it('names exactly the two cards M1f can place, and is NOT zero', () => {
    // **Non-zero is asserted first, and it is not padding.** M1f Task 1 shipped a
    // module-scope mask computed from an imported value inside a real import
    // cycle (`roads.ts -> dispatch.ts -> scratch.ts -> roads.ts`); the imported
    // value was `undefined`, the mask evaluated to 0, and it survived only by
    // luck of polarity. This mask is built from two literals declared in this
    // same module, twelve lines above it — but "it cannot happen here" is what
    // the other one's author would have said, so it is checked rather than
    // reasoned about.
    expect(CARD_IMPLEMENTED_MASK, 'a zero pool offers nothing, silently').not.toBe(0)
    expect(CARD_IMPLEMENTED_MASK).toBe((1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE))
    expect(popCountCards(CARD_IMPLEMENTED_MASK), 'exactly two, so an offer is always drawable').toBe(2)
    // And the five ids M1f does NOT implement are excluded by this mask rather
    // than by their absence from the domain — which is the whole reason the
    // domain declares them.
    for (const card of [CARD_BRIDGE, CARD_TUNNEL, CARD_ROUNDABOUT, CARD_TRAFFIC_LIGHTS, CARD_MOTORWAY]) {
      expect((CARD_IMPLEMENTED_MASK & (1 << card)) !== 0, `card ${card} must not be offerable`).toBe(false)
    }
  })

  it('poolFor stays inside the card domain and can always be drawn from, on every shipped map', () => {
    // Task 11 gave `poolFor` its capability half and the signature did NOT
    // change — the one place a redefinition could go unnoticed — so what must
    // hold in both versions stays asserted here, away from the Task 11 block
    // below: the result is a `CARD_COUNT`-bit mask (so `nthSetBit` is total on
    // it) and it holds at least two cards (so `runOffer` never degrades on a
    // shipped board). Both are properties of the contract, not of today's body.
    // The wider guard, over every FIXTURE map rather than the two shipped ones,
    // is in the Task 11 block.
    for (const map of [firstCity(), CARDS_MAP]) {
      const pool = poolFor(createWorld(map))
      expect(pool, `pool ${pool} is inside the CARD_COUNT-bit domain`).toBeGreaterThanOrEqual(0)
      expect(pool).toBeLessThan(1 << CARD_COUNT)
      expect(canDrawOfferPair(pool), `${map.id} can offer a pair`).toBe(true)
      expect((pool & 1) === 0, 'bit 0 is CARD_NONE and must never be set').toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// M1f Task 11 — the pool's OTHER filter: what the MAP can seat
// ---------------------------------------------------------------------------

/**
 * **The four terrain configurations the filter can distinguish, as maps.**
 *
 * `capabilityMask` reads two terrain codes and nothing else, so these four
 * boards are its whole input domain: neither code, water only, mountain only,
 * both. `firstCity` and `demoCity` supply two of the four for free — which is
 * the catalogue's *"measure which cases the shipped configuration can actually
 * produce"* satisfied by the game rather than by a fixture — and the other two
 * exist because **a fixture carrying both codes cannot tell the water arm from
 * the mountain arm**, exactly as a square map cannot tell `w` from `h`.
 */
const BARREN_ROWS = allLandRows(6, 5)
/** All land, no water, no mountain, no tree: both conditional bits false at once. */
function barren(): MapData {
  return parseMap('barren', BARREN_ROWS, 30, 8, 4, 2)
}
/** Water and no mountain: the bridge arm alone. Rows 1 and 3 are river. */
const STRIPED_ROWS = Object.freeze(['......', '~~~~~~', '......', '~~~~~~', '......'] as const)
/** Mountain and no water: the tunnel arm alone. The mirror of `striped`. */
const RIDGED_ROWS = Object.freeze(['......', '^^^^^^', '......', '^^^^^^', '......'] as const)
/** Trees and land only. `TERRAIN.TREE` is code 3 and `MOUNTAIN` is 2 — adjacent, and a `>=` reads both. */
const WOODED_ROWS = Object.freeze(['TTTTTT', 'TTTTTT', 'TTTTTT'] as const)
/**
 * The **last cell** of the board is the only water on it, and the only mountain
 * on its sibling. Nothing else here reaches `c === world.cells - 1`: every other
 * fixture's terrain sits early, so a scan that stopped one cell short would be
 * invisible to all of them.
 */
const LAST_CELL_WATER_ROWS = Object.freeze(['......', '......', '.....~'] as const)
const LAST_CELL_MOUNTAIN_ROWS = Object.freeze(['......', '......', '.....^'] as const)

function fixtureMap(id: string, rows: readonly string[]): MapData {
  return parseMap(id, rows, 30, 8, 4, 2)
}

/** Every bit `capabilityMask` can set, and the two it sets conditionally. */
const EVERY_CARD = ((1 << CARD_COUNT) - 1) & ~(1 << CARD_NONE)
const BRIDGE_BIT = 1 << CARD_BRIDGE
const TUNNEL_BIT = 1 << CARD_TUNNEL


/**
 * **Every map any test in this repo drives `step` past a week boundary on, plus
 * every board this file uses to separate the filter's arms.**
 *
 * The previous draft's non-emptiness guard iterated the two SHIPPED maps —
 * neither of which any test drives past tick 4,500 — while the board that
 * actually broke was `determinism.test.ts`'s 4x4 `GOLDEN_MAP`. **Enumerate the
 * fixtures, not the products.**
 *
 * Two entries are terrain-identical and both are kept deliberately:
 * `DEMAND_PIN_MAP` IS `allLandRows(20, 9)` under `makeRig`'s parameters, so the
 * pair cannot distinguish anything `capabilityMask` computes. The first names
 * the golden; the second names the shape eight other test files build by hand.
 * If they ever disagree, `loop.test.ts` has been re-pointed at a different board.
 *
 * `CARDS_MAP` is in the list because THIS file drives it to week 6.
 */
const ALL_FIXTURE_MAPS: readonly [string, MapData][] = [
  ['firstCity', firstCity()],
  ['demoCity', demoCity()],
  ['GOLDEN_MAP (determinism.test.ts, 13,499 ticks)', GOLDEN_MAP],
  ['DEMAND_PIN_MAP (loop.test.ts, 5,250 ticks)', DEMAND_PIN_MAP],
  ['allLandRows(20, 9)', parseMap('all-land-20x9', allLandRows(20, 9), 30, 8, 4, 2)],
  ['CARDS_MAP (this file, week 6)', CARDS_MAP],
  ['striped', fixtureMap('striped', STRIPED_ROWS)],
  ['ridged', fixtureMap('ridged', RIDGED_ROWS)],
  ['wooded', fixtureMap('wooded', WOODED_ROWS)],
  ['last-cell-water', fixtureMap('last-cell-water', LAST_CELL_WATER_ROWS)],
  ['last-cell-mountain', fixtureMap('last-cell-mountain', LAST_CELL_MOUNTAIN_ROWS)],
  ['barren', barren()],
]

describe('capabilityMask — spec §5.10, "the pool is filtered by map capability"', () => {
  it('firstCity has water and mountain, so bridge and tunnel are capable there', () => {
    const m = capabilityMask(createWorld(firstCity()))
    expect((m & BRIDGE_BIT) !== 0, 'the river at column 12').toBe(true)
    expect((m & TUNNEL_BIT) !== 0, 'the mountain at rows 5-7').toBe(true)
    // The exact value, not only the two bits: on a board carrying both codes
    // every card in the domain is capable, so the mask is the whole domain.
    expect(m, 'every card id except CARD_NONE').toBe(EVERY_CARD)
  })

  it('demoCity has NEITHER, so both are excluded there', () => {
    // **Both arms of this filter are reachable on the two boards that ship.**
    // `demoCity` is 24x40 of land and trees with no `~` and no `^` anywhere —
    // grep it — so it is a real map, not a fixture, on which the capability
    // half of the pool actually removes something.
    const m = capabilityMask(createWorld(demoCity()))
    expect((m & BRIDGE_BIT) !== 0).toBe(false)
    expect((m & TUNNEL_BIT) !== 0).toBe(false)
    expect(m, 'the whole domain less the two conditional cards').toBe(
      EVERY_CARD & ~(BRIDGE_BIT | TUNNEL_BIT),
    )
  })

  it('the two arms are INDEPENDENT: water alone grants only the bridge, mountain alone only the tunnel', () => {
    // **The fixture pair that separates the arms, and the reason it exists is in
    // Step 5's own table**: on a board carrying both codes, swapping the water
    // and mountain tests is invisible. `firstCity` cannot see that mutation and
    // `demoCity` cannot see it; these two are the only fixtures here that can.
    // Same shape as the square map that hid a `w`/`h` swap.
    const water = capabilityMask(createWorld(fixtureMap('striped', STRIPED_ROWS)))
    expect((water & BRIDGE_BIT) !== 0, 'a river is bridgeable').toBe(true)
    expect((water & TUNNEL_BIT) !== 0, 'no mountain, so no tunnel').toBe(false)

    const mountain = capabilityMask(createWorld(fixtureMap('ridged', RIDGED_ROWS)))
    expect((mountain & TUNNEL_BIT) !== 0, 'a ridge is tunnellable').toBe(true)
    expect((mountain & BRIDGE_BIT) !== 0, 'no water, so no bridge').toBe(false)
  })

  it('a tree is neither water nor mountain, though its code sits next to one', () => {
    // `TERRAIN` is `{ LAND: 0, WATER: 1, MOUNTAIN: 2, TREE: 3 }`. A `>=` where an
    // `===` belongs reads TREE as MOUNTAIN and this is the only fixture that
    // says so — `demoCity` has trees but is 24x40, so it is the slow way to ask.
    const m = capabilityMask(createWorld(fixtureMap('wooded', WOODED_ROWS)))
    expect((m & BRIDGE_BIT) !== 0).toBe(false)
    expect((m & TUNNEL_BIT) !== 0).toBe(false)
  })

  it('sees terrain in the LAST cell of the board, so the scan is not one cell short', () => {
    // **Nothing else in this file could catch an off-by-one on the loop bound or
    // a break placed one line too high**: `firstCity`'s water is at cell 12 of
    // 960 and its mountain at 123, `GOLDEN_MAP`'s are at cells 5 and 6 of 16, and
    // every fixture above puts its terrain in the first rows. Here the ONLY
    // non-land cell is `world.cells - 1`.
    const w = createWorld(fixtureMap('last-cell-water', LAST_CELL_WATER_ROWS))
    expect(w.terrain[w.cells - 1], 'vacuity: the fixture really is water in its final cell').toBe(1)
    expect(w.terrain.indexOf(1), 'and nowhere else').toBe(w.cells - 1)
    expect((capabilityMask(w) & BRIDGE_BIT) !== 0).toBe(true)

    const m = createWorld(fixtureMap('last-cell-mountain', LAST_CELL_MOUNTAIN_ROWS))
    expect(m.terrain[m.cells - 1], 'vacuity: mountain in its final cell').toBe(2)
    expect(m.terrain.indexOf(2), 'and nowhere else').toBe(m.cells - 1)
    expect((capabilityMask(m) & TUNNEL_BIT) !== 0).toBe(true)
  })

  it('road tiles, lights, motorways, roundabouts and the JUNCTION UPGRADE are capable EVERYWHERE', () => {
    // Dossier line 227: "roundabouts/lights/motorways everywhere". This is the
    // row the previous design got wrong by making an item's capability depend on
    // the BOARD rather than on the MAP — it asked whether the current board had
    // room for a 3x3 roundabout, and on the 4x4 golden fixture the answer was no,
    // the pool fell to one card, and `drawOfferPair` threw inside `step` after
    // `H_EPOCH` had been written. `CARD_JUNCTION_UPGRADE` joins that row: it
    // needs nothing from the terrain, and it is the card that keeps the shipped
    // pool at two.
    const everywhere = [
      CARD_ROAD_TILES,
      CARD_TRAFFIC_LIGHTS,
      CARD_MOTORWAY,
      CARD_ROUNDABOUT,
      CARD_JUNCTION_UPGRADE,
    ]
    const boards: readonly [string, MapData][] = [
      ['firstCity', firstCity()],
      ['demoCity', demoCity()],
      ['barren', barren()],
      ['striped', fixtureMap('striped', STRIPED_ROWS)],
      ['ridged', fixtureMap('ridged', RIDGED_ROWS)],
      ['GOLDEN_MAP', GOLDEN_MAP],
      ['DEMAND_PIN_MAP', DEMAND_PIN_MAP],
    ]
    for (const [name, map] of boards) {
      const m = capabilityMask(createWorld(map))
      for (const id of everywhere) {
        expect((m & (1 << id)) !== 0, `${name}: card ${id}`).toBe(true)
      }
    }
    // And the set is DERIVED, not re-listed: the unconditional cards are the
    // whole domain less the two that name a terrain code. M1f Task 6's brief
    // enumerated five of six unofferable ids and dropped one; the repair there
    // was to take the complement, and this is the same repair applied before the
    // mistake. If M1g adds a card id, it lands in `everywhere` automatically and
    // this assertion is what says so.
    expect(new Set(everywhere)).toEqual(
      new Set(
        Array.from({ length: CARD_COUNT }, (_, id) => id).filter(
          (id) => id !== CARD_NONE && id !== CARD_BRIDGE && id !== CARD_TUNNEL,
        ),
      ),
    )
  })

  it('covering the board in roads and a house changes nothing — and that is the SIGNATURE, not luck', () => {
    // **Labelled inert, deliberately, because it cannot fail today and a reader
    // must not count it as coverage.** `capabilityMask` takes `WorldData`, which
    // `createWorld` fills once from `map.terrain` and which nothing in `sim/src`
    // ever writes — roads live in `state.roads`, cleared trees in `state.cleared`.
    // So state-independence here is a property of the TYPE, and the day someone
    // widens this signature to take `GameState` the compiler, not this test, is
    // what stops them.
    //
    // It is kept because it is the executable form of the correction this task
    // exists to carry: the first design asked what the CURRENT BOARD had room
    // for. Its vacuity guard is the assertion that the board really did change.
    const rig = bootCity('capability-state-blind')
    const at0 = capabilityMask(rig.world)
    expect(placeHouse(rig.s, rig.world, 15, 0), 'a building on the board').toBe(true)
    // A row-major chain over cells 0..14: 14 edges, 15 newly-occupied cells,
    // inside `CARDS_MAP`'s 20 starting tiles.
    const chain = [
      [0, 1], [1, 2], [2, 3], [3, 7], [7, 6], [6, 5], [5, 4],
      [4, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14],
    ] as const
    let laid = 0
    for (const [a, b] of chain) if (placeRoad(rig.s, rig.world, a, b)) laid++
    expect(laid, 'vacuity: the state really moved under the assertion').toBeGreaterThan(10)
    expect(roadMask(rig.s, 0), 'and cell 0 really carries road').not.toBe(0)
    expect(capabilityMask(rig.world), 'capability is a property of the map').toBe(at0)
  })

  it('every card the sim OFFERS across six weeks is one M1f can place', () => {
    // **The behavioural half, and the one with teeth.** The two tests above are
    // structurally guaranteed; this one drives `step` across six week boundaries,
    // takes the offered card each time, and checks the pair against
    // `CARD_IMPLEMENTED_MASK` — a constant, not against `poolFor`, so it is not
    // the formula checking itself. A `poolFor` that forgot to AND in the
    // implemented mask offers a bridge here.
    const rig = bootCity('capability-six-weeks')
    const at0 = capabilityMask(rig.world)
    let offers = 0
    for (let w = 1; w <= 6; w++) {
      driveTo(rig, TICKS_PER_WEEK * w)
      expect(offerPending(rig.s), `week ${w}: an offer was raised`).toBe(true)
      const a = rig.s.header[H_OFFER_A] as number
      const b = rig.s.header[H_OFFER_B] as number
      for (const card of [a, b]) {
        expect((CARD_IMPLEMENTED_MASK & (1 << card)) !== 0, `week ${w}: card ${card}`).toBe(true)
      }
      offers += 2
      // Take one, so the run crosses the boundaries with weeks RESOLVED rather
      // than with six unresolved offers stacked behind one another.
      step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, a))
      expect(offerPending(rig.s), `week ${w}: and the choice landed`).toBe(false)
      expect(capabilityMask(rig.world), `week ${w}`).toBe(at0)
    }
    expect(offers, 'six weeks, two slots each').toBe(12)
  })
})

describe('poolFor is the two filters, with two reasons', () => {
  it('is the capability mask AND the implemented mask, on every map here', () => {
    for (const [name, map] of ALL_FIXTURE_MAPS) {
      const w = createWorld(map)
      expect(poolFor(w), name).toBe(capabilityMask(w) & CARD_IMPLEMENTED_MASK)
    }
  })

  it('excludes the five cards with no placement mechanism even where the map is capable', () => {
    const m = poolFor(createWorld(firstCity()))
    // firstCity is capable of all seven — asserted above — so every exclusion
    // below is the IMPLEMENTED half doing the work and not the map's.
    expect(capabilityMask(createWorld(firstCity())), 'vacuity: the map permits all seven').toBe(
      EVERY_CARD,
    )
    for (const id of [CARD_BRIDGE, CARD_TUNNEL, CARD_ROUNDABOUT, CARD_MOTORWAY, CARD_TRAFFIC_LIGHTS]) {
      expect((m & (1 << id)) !== 0, `card ${id} is offerable with nothing to place`).toBe(false)
    }
  })

  it('ALWAYS leaves at least two cards on EVERY map any test drives past a week boundary', () => {
    // **The guard the previous draft got wrong, and the one that would have
    // caught its Critical.** Its version iterated the two SHIPPED maps — neither
    // of which is a fixture that drives `step` past tick 4,500 — while the map
    // that actually broke is `determinism.test.ts`'s 4x4 `GOLDEN_MAP`, at tick
    // 4,500 of a 13,499-tick run, after `H_EPOCH` was written. Enumerate the
    // fixtures, not the products. `GOLDEN_MAP` and `DEMAND_PIN_MAP` are
    // importable from `./mapFixtures` for exactly this list.
    for (const [name, map] of ALL_FIXTURE_MAPS) {
      const pool = poolFor(createWorld(map))
      expect(popCountCards(pool), `${name} cannot offer a pair`).toBeGreaterThanOrEqual(2)
      expect(canDrawOfferPair(pool), `${name}`).toBe(true)
      expect(pool, `${name}: bit 0 is CARD_NONE`).toBe(pool & ~1)
      expect(pool, `${name} is inside the CARD_COUNT-bit domain`).toBeLessThan(1 << CARD_COUNT)
    }
  })

  it('and every card it admits has a tile grant and an item grant', () => {
    const m = poolFor(createWorld(firstCity()))
    let admitted = 0
    for (let id = 0; id < CARD_COUNT; id++) {
      if ((m & (1 << id)) !== 0) {
        admitted++
        expect(() => cardTileGrant(id)).not.toThrow()
        expect(() => cardItemGrant(id)).not.toThrow()
      }
    }
    expect(admitted, 'vacuity: the loop body ran').toBe(2)
  })

  it('TODAY the capability half narrows NOTHING, and this is the tripwire for the day it does', () => {
    // **The honest statement of what this task buys, in an assertion rather than
    // in prose.** Both cards `CARD_IMPLEMENTED_MASK` admits are capable on every
    // map, so `capabilityMask(w) & CARD_IMPLEMENTED_MASK === CARD_IMPLEMENTED_MASK`
    // everywhere and no golden, no offer and nothing a player sees moves. The
    // capability half's only shipped detectors are the bridge and tunnel arms on
    // `demoCity`, which are about cards M1f cannot offer at all.
    //
    // What it buys instead: a map with no water can never offer a bridge, and
    // M1g's change is a bit DELETED from `CARD_IMPLEMENTED_MASK` rather than a
    // re-derivation. **The day M1g deletes the bridge bit, this test is what goes
    // red first**, on `demoCity` and on every all-land fixture below — and it is
    // the notice that the goldens built on those maps are about to move.
    for (const [name, map] of ALL_FIXTURE_MAPS) {
      expect(poolFor(createWorld(map)), `${name}`).toBe(CARD_IMPLEMENTED_MASK)
    }
  })
})

describe('tryDrawOfferPair — the guard and the draw are ONE call', () => {
  it('never throws, on any mask a pool can be', () => {
    // **This is the structural half of "runOffer must not reach the throw".**
    // `canDrawOfferPair` shares the predicate, but nothing forced `runOffer` to
    // call it — a guard and a draw written as two statements can drift, and the
    // way they drift is the worst one available: a subtly weaker guard, a throw
    // inside `step` after `H_EPOCH` is written, and a buffer `restore` then
    // refuses. Welded into one call there is no second threshold to weaken.
    const out = new Int32Array(2)
    for (let pool = 0; pool < 1 << CARD_COUNT; pool++) {
      expect(() => tryDrawOfferPair(pool, 0x9e3779b1, out), `pool ${pool}`).not.toThrow()
    }
  })

  it('agrees with canDrawOfferPair over the whole domain, and draws what drawOfferPair draws', () => {
    const mine = new Int32Array(2)
    const theirs = new Int32Array(2)
    let drawn = 0
    let refused = 0
    for (let pool = 0; pool < 1 << CARD_COUNT; pool++) {
      const ok = tryDrawOfferPair(pool, 12345, mine)
      expect(ok, `pool ${pool}`).toBe(canDrawOfferPair(pool))
      if (ok) {
        drawOfferPair(pool, 12345, theirs)
        expect([mine[0], mine[1]], `pool ${pool}`).toEqual([theirs[0], theirs[1]])
        drawn++
      } else {
        refused++
      }
    }
    // Vacuity, in both arms: the empty mask and the eight singletons refuse.
    expect(refused).toBe(9)
    expect(drawn).toBe(256 - 9)
  })

  it('FAILS CLOSED: a refused draw leaves CARD_NONE in both slots, not the previous pair', () => {
    // The boolean is what `runOffer` branches on, and a caller that ignored it
    // would publish whatever was in the buffer — which, on the second week of a
    // degraded run, is last week's real cards. So the refusal path overwrites.
    // This does NOT make ignoring the boolean safe (the week would stay pending
    // and the shell would wait on a modal with nothing in it); it makes the
    // unsafe path produce the safe VALUE, which is one failure instead of two.
    const out = new Int32Array(2)
    expect(tryDrawOfferPair(CARD_IMPLEMENTED_MASK, 7, out)).toBe(true)
    expect(out[0], 'vacuity: the slots really held a card before the refusal').not.toBe(CARD_NONE)
    expect(tryDrawOfferPair(1 << CARD_ROAD_TILES, 7, out)).toBe(false)
    expect([out[0], out[1]]).toEqual([CARD_NONE, CARD_NONE])
  })
})

describe('runOfferFromPool degrades on EVERY short pool, not on one stubbed example', () => {
  it('resolves the week and raises nothing, for all nine pools that cannot offer a pair', () => {
    // **This is review Critical 2, closed in the sim rather than argued away,
    // and closed over the whole domain rather than over one fixture.** The
    // previous design called `drawOfferPair` unconditionally, so a short pool
    // threw INSIDE `step`, AFTER `H_EPOCH` had been written — poisoning the
    // buffer permanently, on a golden fixture, at tick 4,500 of 13,499.
    //
    // `runOffer` is `runOfferFromPool(state, poolFor(world), scratch)`, so
    // sweeping every mask `poolFor` could ever return is a stronger statement
    // than a single short-pool world: it says the throw is unreachable for ANY
    // pool, including the ones no map's capability mask produces today and M1g's
    // narrowing of `CARD_IMPLEMENTED_MASK` might.
    //
    // ONE rig, driven once and reset between pools: `runOfferFromPool` writes
    // only the three offer slots, so restoring those three restores everything
    // it can see. Nine independent 4,500-tick drives would measure the same
    // thing nine times and cost nine times the budget.
    const rig = bootCity('short-pool')
    driveTo(rig, TICKS_PER_WEEK)
    let short = 0
    for (let pool = 0; pool < 1 << CARD_COUNT; pool++) {
      if (canDrawOfferPair(pool)) continue
      short++
      // Reset what phase 4 already did with the REAL pool, so this drives the
      // degenerate branch from a clean week-1 offer state.
      rig.s.header[H_OFFER_A] = CARD_NONE
      rig.s.header[H_OFFER_B] = CARD_NONE
      rig.s.header[H_OFFER_WEEK] = 0
      expect(offerPending(rig.s), 'vacuity: an offer really is pending before the call').toBe(true)
      expect(() => runOfferFromPool(rig.s, pool, rig.scratch), `pool ${pool}`).not.toThrow()
      expect(rig.s.header[H_OFFER_A], `pool ${pool}: no card was offered`).toBe(CARD_NONE)
      expect(rig.s.header[H_OFFER_B], `pool ${pool}`).toBe(CARD_NONE)
      expect(
        rig.s.header[H_OFFER_WEEK],
        `pool ${pool}: the week is resolved, not skipped-and-retried`,
      ).toBe(1)
      // **The assertion that separates "does not throw" from "does not hang the
      // shell", and they are different failures.** Returning without writing
      // `H_OFFER_WEEK` also does not throw, and leaves `game`'s frame driver
      // pausing behind a modal with nothing to show, forever.
      expect(offerPending(rig.s), `pool ${pool}: nothing is left pending`).toBe(false)
    }
    expect(short, 'the empty mask and the eight singletons').toBe(9)
  })

  it('NOTHING in cards.ts reaches drawOfferPair except tryDrawOfferPair itself', () => {
    // A source scan, on the precedent of `step.test.ts`'s tick-order tripwire
    // and `loop.test.ts`'s cross-file golden scan: the property is "this call
    // site cannot be written a second way", which has nothing to observe at run
    // time. The lookbehind is what makes it see `drawOfferPair(` and not the
    // `drawOfferPair(` inside `tryDrawOfferPair(`.
    //
    // **This scan's RANGE was narrower than its name, and M1f Task 11 is what
    // made that matter.** It sliced from `export function runOfferFromPool` to
    // EOF, so a call written ABOVE that point was invisible — including inside
    // `poolFor`, which is one line above it and which Task 11 rewrote. The
    // catalogue's shape: a guard whose coverage is a strict subset of what its
    // name claims, whose blind spot is exactly where the next edit lands.
    //
    // The range is now the WHOLE FILE with `tryDrawOfferPair`'s own declaration
    // cut out, plus `drawOfferPair`'s declaration line renamed — so the two
    // legitimate occurrences are removed by construction and everything else,
    // in any order the file is ever reorganised into, is scanned.
    const src = readFileSync(new URL('../src/cards.ts', import.meta.url), 'utf8')
    expect(src.length, 'cards.ts read back empty').toBeGreaterThan(4000)
    const start = src.indexOf('export function tryDrawOfferPair')
    expect(start, 'tryDrawOfferPair is no longer declared in cards.ts').toBeGreaterThan(0)
    const end = src.indexOf('\n}\n', start)
    expect(end, 'tryDrawOfferPair has no column-0 closing brace').toBeGreaterThan(start)
    const sanctioned = src.slice(start, end + 3)
    const rest =
      src.slice(0, start) +
      src.slice(end + 3).replace('export function drawOfferPair(', 'export function THE_DECLARATION(')
    // Vacuity, both halves: the one sanctioned call really is inside the slice
    // that was cut out, and the cut really removed it from what is scanned.
    expect(sanctioned, 'the welded call is not where this scan thinks it is').toMatch(CALLS_DRAW)
    expect(rest.length + sanctioned.length, 'the two halves partition the file').toBe(
      src.length + 'THE_DECLARATION'.length - 'drawOfferPair'.length,
    )
    expect(
      rest,
      'something in cards.ts now calls drawOfferPair directly — that throw is unguarded inside ' +
        'step, after H_EPOCH is written, and poisons the buffer permanently. Call tryDrawOfferPair.',
    ).not.toMatch(CALLS_DRAW)
  })

  it('and NOTHING in the rest of sim/src reaches it at all — the scan the old one could not do', () => {
    // **`cards.ts` was the only file the weld was ever checked in, and it is not
    // the only file that can import `drawOfferPair`.** `step.ts` calls `runOffer`
    // on every tick; any module in this package could import the raw draw and
    // reach the throw from inside `step` by a route the in-file scan cannot see.
    // Verified satisfiable on the shipped tree before being written.
    //
    // The exclusion is proved non-vacuous rather than assumed, on
    // `determinism.test.ts`'s `fields[` precedent: the excluded set is asserted
    // to be exactly `cards.ts`, and `cards.ts` is asserted to CONTAIN a hit.
    const dir = fileURLToPath(new URL('../src', import.meta.url))
    const files = readdirSync(dir)
      .filter((n) => n.endsWith('.ts'))
      .sort()
    expect(files.length, 'the src listing came back empty').toBeGreaterThan(15)
    expect(files.includes('cards.ts')).toBe(true)
    const others = files.filter((n) => n !== 'cards.ts')
    expect(files.length - others.length, 'exactly one file is excluded').toBe(1)
    // Non-vacuity: the pattern does fire on the one file that legitimately holds it.
    expect(readFileSync(join(dir, 'cards.ts'), 'utf8')).toMatch(CALLS_DRAW)
    const hits = others.filter((n) => CALLS_DRAW.test(readFileSync(join(dir, n), 'utf8')))
    expect(hits, `these files call drawOfferPair directly: ${hits.join(', ')}`).toEqual([])
  })

  it('the drawOfferPair scan fires on a real call and leaves its counter-examples alone', () => {
    // A scan matches comments, not just code, and this one is checked against the
    // prose forms `cards.ts` and `scratch.ts` actually use rather than assumed
    // immune. The module backticks the name everywhere, which is what keeps it
    // clear; a future author writing `drawOfferPair (cards.ts)` without them
    // WOULD trip this, and the fix is the backticks.
    for (const hit of ['  drawOfferPair(pool, seed, out)', 'export function drawOfferPair(p', 'x = drawOfferPair  (a)']) {
      expect(hit, `not caught: ${hit}`).toMatch(CALLS_DRAW)
    }
    for (const miss of [
      '  tryDrawOfferPair(pool, seed, out)',
      '// Caller-owned output for `drawOfferPair` (cards.ts), length 2.',
      " * Allocates nothing: `out` is caller-owned, exactly as `drawOfferPair`'s is.",
      ' * the whole draw with a Smi seed — `tryDrawOfferPair`, `drawOfferPair`,',
    ]) {
      expect(miss, `false positive: ${miss}`).not.toMatch(CALLS_DRAW)
    }
  })
})

describe('runOffer — phase 4', () => {
  it('raises nothing in week 0', () => {
    const rig = bootCity('offer-week-0')
    for (let t = 0; t < 100; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_OFFER_A]).toBe(CARD_NONE)
    expect(rig.s.header[H_OFFER_B]).toBe(CARD_NONE)
    expect(offerPending(rig.s)).toBe(false)
  })

  it('raises an offer on the first tick of week 1 and not before', () => {
    const rig = bootCity('offer-week-1')
    driveTo(rig, TICKS_PER_WEEK - 1)
    expect(rig.s.header[H_OFFER_A], 'still week 0').toBe(CARD_NONE)
    step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_TICK]).toBe(TICKS_PER_WEEK)
    expect(rig.s.header[H_WEEK]).toBe(1)
    expect(offerPending(rig.s)).toBe(true)
    expect(rig.s.header[H_OFFER_A]).not.toBe(CARD_NONE)
    expect(rig.s.header[H_OFFER_B]).not.toBe(rig.s.header[H_OFFER_A])
  })

  it('matches the pair drawOfferPair gives for this seed and week, computed independently', () => {
    const rig = bootCity('offer-independent')
    driveTo(rig, TICKS_PER_WEEK)
    const out = new Int32Array(2)
    drawOfferPair(poolFor(rig.world), offerSeedFor(rig.s, 1), out)
    expect(rig.s.header[H_OFFER_A]).toBe(out[0])
    expect(rig.s.header[H_OFFER_B]).toBe(out[1])
  })

  it('is IDEMPOTENT: re-raising the same week rewrites the same pair', () => {
    // This is what lets ONE flag do both jobs, and it is also what makes the
    // up-to-7 ticks between the boundary and the shell's pause landing harmless.
    //
    // **The property it rests on, asserted rather than assumed: `rng[0]` does
    // not move.** `offerSeedFor` reads the seed word live, so idempotence is a
    // joint property of the draw and of the stream standing still. Nothing in
    // `sim/src` calls `nextRandom` or `randomBelow` at all — `determinism.test.ts`
    // bans it outside `rng.ts`, and `spawnScanStart` reads `rng[0]` WITHOUT
    // advancing for exactly this reason — so the word is written once by
    // `createState` and never again. That is what this assertion pins; without
    // it, a future draw inside the tick would reshuffle the modal under the
    // player's finger and this test would still be green on a fixture that
    // happens not to draw.
    const rig = bootCity('offer-idempotent')
    driveTo(rig, TICKS_PER_WEEK)
    const seed = rig.s.rng[0] as number
    const a = rig.s.header[H_OFFER_A]
    const b = rig.s.header[H_OFFER_B]
    for (let t = 0; t < 50; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.rng[0], 'the tick advanced the rng, so idempotence is not what kept the pair still').toBe(seed)
    expect(rig.s.header[H_OFFER_A]).toBe(a)
    expect(rig.s.header[H_OFFER_B]).toBe(b)
  })

  it('replaces an unresolved offer at the next boundary, and the old card is lost', () => {
    const rig = bootCity('offer-replaces')
    driveTo(rig, TICKS_PER_WEEK)
    const week1 = [rig.s.header[H_OFFER_A], rig.s.header[H_OFFER_B]]
    driveTo(rig, TICKS_PER_WEEK * 2)
    expect(rig.s.header[H_WEEK]).toBe(2)
    expect(offerPending(rig.s), 'still pending, now for week 2').toBe(true)
    const out = new Int32Array(2)
    drawOfferPair(poolFor(rig.world), offerSeedFor(rig.s, 2), out)
    expect([rig.s.header[H_OFFER_A], rig.s.header[H_OFFER_B]]).toEqual([out[0], out[1]])
    expect([rig.s.header[H_OFFER_A], rig.s.header[H_OFFER_B]], 'week 1 is gone').not.toEqual(week1)
  })

  it('raises nothing after game over', () => {
    const rig = bootTerminal('offer-terminal')
    const frozenAt = rig.s.header[H_TICK] as number
    const before = hashState(rig.s)
    for (let t = 0; t < TICKS_PER_WEEK; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(hashState(rig.s), 'step is a byte-identical no-op past the failure').toBe(before)
    expect(rig.s.header[H_TICK], 'not one of those ticks was counted').toBe(frozenAt)
    expect(rig.s.header[H_OFFER_A]).toBe(CARD_NONE)

    // **The CONTROL, and without it this test passes on a phase that never
    // runs.** "Nothing happened" is also what a board below its first boundary
    // looks like. The same board, alive, driven the same number of ticks from the
    // same tick, must raise an offer — so the silence above is the freeze and not
    // the calendar.
    const live = bootCity('offer-terminal-control')
    driveTo(live, frozenAt)
    expect(live.s.header[H_OFFER_A], 'the control is below its first boundary too').toBe(CARD_NONE)
    for (let t = 0; t < TICKS_PER_WEEK; t++) step(live.s, live.world, live.fields, live.scratch, NO_INPUT)
    expect(live.s.header[H_TICK]).toBe(frozenAt + TICKS_PER_WEEK)
    expect(live.s.header[H_OFFER_A], 'the live control DID raise one over the same span').not.toBe(
      CARD_NONE,
    )
  })

  it('runOffer writes H_TILES never, so phases 2 and 4 are disjoint by construction', () => {
    // **`runOffer` never writes it — `cards.ts` now does, and the two are
    // different claims.** M1f Task 6 pays the card's tile bonus inside
    // `applyChooseCard`, which is phase 3; that is precisely what keeps phase 2
    // (the weekly grant) and phase 4 (the offer slots) disjoint, so the title was
    // narrowed from "writes H_TILES never" rather than left to read as a claim
    // about the module. The tick below carries no action, so phase 3 is empty and
    // the only tile movement on it is the boundary's.
    const rig = bootCity('offer-disjoint')
    driveTo(rig, TICKS_PER_WEEK - 1)
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_TILES], 'the boundary granted exactly the weekly tiles').toBe(
      tiles + WEEKLY_TILE_GRANT,
    )
  })
})

// ---------------------------------------------------------------------------
// M1f Task 6 — `choose-card` as an input
// ---------------------------------------------------------------------------

describe('cardTileGrant and cardItemGrant', () => {
  it('pays 30 for road tiles and 20 for an item, per spec 5.10', () => {
    expect(cardTileGrant(CARD_ROAD_TILES)).toBe(30)
    expect(cardTileGrant(CARD_JUNCTION_UPGRADE)).toBe(20)
    // Read back off the shared constants too, so a change in one place cannot
    // leave this file asserting a literal nothing produces any more.
    expect(cardTileGrant(CARD_ROAD_TILES)).toBe(CARD_GRANT_ROAD_TILES)
    expect(cardTileGrant(CARD_JUNCTION_UPGRADE)).toBe(CARD_GRANT_ITEM)
  })

  it('gives two upgrades and zero items for road tiles, per spec 5.10s grant row', () => {
    expect(cardItemGrant(CARD_JUNCTION_UPGRADE)).toBe(2)
    expect(cardItemGrant(CARD_JUNCTION_UPGRADE)).toBe(UPGRADES_PER_CARD)
    expect(cardItemGrant(CARD_ROAD_TILES)).toBe(0)
  })

  it('THROWS for EVERY card outside CARD_IMPLEMENTED_MASK, rather than inventing a grant', () => {
    // **The set is DERIVED from the mask, not hand-listed, and the hand-list
    // this replaces is why.** Task 6's brief enumerated
    // `[CARD_BRIDGE, CARD_TUNNEL, CARD_ROUNDABOUT, CARD_MOTORWAY, CARD_NONE]` —
    // five of the six unofferable ids, silently missing `CARD_TRAFFIC_LIGHTS`,
    // which is the ONE of them this milestone deliberately built, measured and
    // deferred (`cards.ts`, Amendment 2). A hand-list also cannot follow M1g
    // deleting a bit from the mask. Deriving it from `CARD_IMPLEMENTED_MASK`
    // makes the sweep total over the domain by construction.
    const unofferable: number[] = []
    for (let id = 0; id < CARD_COUNT; id++) {
      if ((CARD_IMPLEMENTED_MASK & (1 << id)) === 0) unofferable.push(id)
    }
    // Vacuity, and it names the id the hand-list dropped: an empty or
    // one-element sweep would pass the loop below without saying anything.
    expect(unofferable, 'the six ids no pool can offer, including the deferred light').toEqual([
      CARD_NONE,
      CARD_BRIDGE,
      CARD_TUNNEL,
      CARD_ROUNDABOUT,
      CARD_TRAFFIC_LIGHTS,
      CARD_MOTORWAY,
    ])
    for (const id of unofferable) {
      expect(() => cardTileGrant(id), `card ${id} tile grant`).toThrow(/has no tile grant/)
      expect(() => cardItemGrant(id), `card ${id} item grant`).toThrow(/has no item grant/)
    }
  })
})

describe('applyChooseCard — the echo is the replay-divergence detector', () => {
  it('grants the card tiles, sets H_OFFER_WEEK, and ends the offer', () => {
    const rig = bootCity('choose-grants')
    driveTo(rig, TICKS_PER_WEEK)
    const tiles = rig.s.header[H_TILES] as number
    const card = rig.s.header[H_OFFER_A] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, card))
    expect(rig.s.header[H_TILES]).toBe(tiles + cardTileGrant(card))
    expect(rig.s.header[H_OFFER_WEEK]).toBe(1)
    expect(offerPending(rig.s)).toBe(false)
  })

  it('pays the bonus in PHASE 3 and never at the week boundary, so phases 2 and 4 stay disjoint', () => {
    // The tick that carries the choice is NOT a boundary tick, so the only tile
    // movement on it is the card's. `week.test.ts` owns the other half — that a
    // boundary tick with no choice moves `H_TILES` by exactly the weekly grant.
    const rig = bootCity('choose-phase-3')
    driveTo(rig, TICKS_PER_WEEK + 7)
    const tiles = rig.s.header[H_TILES] as number
    const card = rig.s.header[H_OFFER_A] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, card))
    expect(rig.s.header[H_TICK], 'no boundary on this tick').not.toBe(TICKS_PER_WEEK * 2)
    expect(rig.s.header[H_TILES]).toBe(tiles + cardTileGrant(card))
  })

  it('adds TWO upgrades to the inventory when that is the card, and none otherwise', () => {
    const rig = bootCity('choose-two-upgrades')
    driveTo(rig, TICKS_PER_WEEK)
    const slot = rig.s.header[H_OFFER_A] === CARD_JUNCTION_UPGRADE ? OFFER_SLOT_A : OFFER_SLOT_B
    const card = (slot === OFFER_SLOT_A ? rig.s.header[H_OFFER_A] : rig.s.header[H_OFFER_B]) as number
    expect(card, 'the shipped pool always offers it').toBe(CARD_JUNCTION_UPGRADE)
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(slot, card))
    // 5.10's table: "Traffic Lights | 2 | 20". TWO, not one, and this is the
    // assertion that would catch it being implemented as one.
    expect(rig.s.header[H_INV_UPGRADES]).toBe(UPGRADES_PER_CARD)
    expect(rig.s.header[H_INV_UPGRADES]).toBe(2)
    // **And the tile half as a LITERAL, not as `cardTileGrant(card)`.** Measured:
    // swapping the two grants inside `cardTileGrant` scored ONE detector, the
    // unit test, because every behavioural assertion in this file computed its
    // expectation from the same function it was checking — the catalogue's "an
    // assertion checked against the formula that produced the thing under test".
    // 20 is 5.10's item row, hand-carried from the table to here.
    expect(rig.s.header[H_TILES], 'the item card pays 20, per 5.10s table').toBe(tiles + 20)
  })

  it('adds no upgrades when the road-tiles card is taken', () => {
    const rig = bootCity('choose-no-upgrades')
    driveTo(rig, TICKS_PER_WEEK)
    const slot = rig.s.header[H_OFFER_A] === CARD_ROAD_TILES ? OFFER_SLOT_A : OFFER_SLOT_B
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(slot, CARD_ROAD_TILES))
    expect(rig.s.header[H_INV_UPGRADES]).toBe(0)
    // The other half of the literal pair above: 5.10's Road Tiles row is "30 or
    // 40 (per-map constant)" and this map takes 30. Together the two literals are
    // what makes swapping the grants visible in BEHAVIOUR and not only in the
    // grant table's own unit test.
    expect(rig.s.header[H_TILES], 'the road-tiles card pays 30, per 5.10s table').toBe(tiles + 30)
  })

  it('raises no new offer for the rest of the week', () => {
    const rig = bootCity('choose-rest-of-week')
    driveTo(rig, TICKS_PER_WEEK)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, rig.s.header[H_OFFER_A] as number))
    const after = hashState(rig.s)
    for (let t = 0; t < 100; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_OFFER_WEEK], 'still resolved').toBe(1)
    expect(offerPending(rig.s)).toBe(false)
    expect(hashState(rig.s), 'and the run went on').not.toBe(after)
  })

  it('offers again at the NEXT boundary', () => {
    const rig = bootCity('choose-next-boundary')
    driveTo(rig, TICKS_PER_WEEK)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, rig.s.header[H_OFFER_A] as number))
    driveTo(rig, TICKS_PER_WEEK * 2)
    expect(offerPending(rig.s)).toBe(true)
  })

  it('is a SILENT NO-OP for a second choice in the same batch — a double tap must not brick a run', () => {
    const rig = bootCity('choose-double-tap')
    driveTo(rig, TICKS_PER_WEEK)
    const a = rig.s.header[H_OFFER_A] as number
    const b = rig.s.header[H_OFFER_B] as number
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, {
      actions: [
        { kind: 'choose-card', a: OFFER_SLOT_A, b: a },
        { kind: 'choose-card', a: OFFER_SLOT_B, b: b },
      ],
    })
    expect(rig.s.header[H_TILES], 'only the first was paid').toBe(tiles + cardTileGrant(a))
    expect(rig.s.header[H_INV_UPGRADES], 'and only the first cards items').toBe(cardItemGrant(a))
    expect(rig.s.header[H_EPOCH], 'and nothing threw').toBe(0)
  })

  it('is a SILENT NO-OP for a second tap on the SAME slot, which is what a double tap actually is', () => {
    // The sibling above taps A then B, so the echo would refer to a DIFFERENT
    // card on the second action. A real double tap repeats the same slot and the
    // same card, and there the echo MATCHES — so `offerPending` is the only
    // thing standing between it and a card paid twice. Two tests because the two
    // mutations they catch are different: dropping the pending check dies here
    // on the tile count, and dies above on the tile count too but for the other
    // slot's grant. Same tap, two shapes.
    const rig = bootCity('choose-double-tap-same-slot')
    driveTo(rig, TICKS_PER_WEEK)
    const a = rig.s.header[H_OFFER_A] as number
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, {
      actions: [
        { kind: 'choose-card', a: OFFER_SLOT_A, b: a },
        { kind: 'choose-card', a: OFFER_SLOT_A, b: a },
      ],
    })
    expect(rig.s.header[H_TILES], 'paid exactly once').toBe(tiles + cardTileGrant(a))
    expect(rig.s.header[H_INV_UPGRADES], 'and granted its items exactly once').toBe(cardItemGrant(a))
    expect(rig.s.header[H_EPOCH], 'and nothing threw').toBe(0)
  })

  it('is a SILENT NO-OP in week 0, where no offer exists', () => {
    const rig = bootCity('choose-week-0')
    const before = hashState(rig.s)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, CARD_ROAD_TILES))
    expect(rig.s.header[H_EPOCH]).toBe(0)
    expect(rig.s.header[H_OFFER_WEEK]).toBe(0)
    expect(rig.s.header[H_TILES], 'and nothing was paid').toBe(CARDS_MAP.startingTiles)
    expect(hashState(rig.s), 'the tick still ran').not.toBe(before)
  })

  it('THROWS, naming both cards, when the echo disagrees with the slot', () => {
    const rig = bootCity('choose-echo-mismatch')
    driveTo(rig, TICKS_PER_WEEK)
    const wrong =
      (rig.s.header[H_OFFER_A] as number) === CARD_ROAD_TILES ? CARD_JUNCTION_UPGRADE : CARD_ROAD_TILES
    expect(() =>
      step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, wrong)),
    ).toThrow(/believed slot 0 held card \d+.*this simulation offered \d+.*replay/s)
  })

  it('the echo reads the slot it was GIVEN, not the other one', () => {
    // **The mutant this exists for is `offered` taken from the opposite slot**,
    // which the sibling above cannot see: on a two-card pool the wrong card is
    // exactly the other slot's card, so an echo that reads slot B throws on the
    // mismatch test for the wrong reason and passes it. Here the echo is CORRECT
    // for slot B, so reading slot A instead turns a legal choice into a throw.
    const rig = bootCity('choose-echo-slot-b')
    driveTo(rig, TICKS_PER_WEEK)
    const b = rig.s.header[H_OFFER_B] as number
    const tiles = rig.s.header[H_TILES] as number
    expect(b, 'the two slots hold different cards, or this pins nothing').not.toBe(
      rig.s.header[H_OFFER_A],
    )
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_B, b))
    expect(rig.s.header[H_TILES], 'slot B was taken and slot Bs grant was paid').toBe(
      tiles + cardTileGrant(b),
    )
    expect(rig.s.header[H_OFFER_WEEK]).toBe(1)
  })

  it('THROWS for a slot that is neither 0 nor 1', () => {
    const rig = bootCity('choose-bad-slot')
    driveTo(rig, TICKS_PER_WEEK)
    expect(() => step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(2, CARD_ROAD_TILES))).toThrow(
      /slot 2 is not 0 or 1/,
    )
  })

  it('checks PENDING before the echo, so a repeat within the SAME resolved week is a no-op and not a throw', () => {
    // **And "not a throw" is only half of what has to hold — the other half is
    // "not paid again", which is the assertion the brief's draft of this test
    // did not have.** Once the week is resolved the slots still hold its real
    // cards, so an echo evaluated FIRST would MATCH and pay a second time
    // silently. `.not.toThrow()` alone scores 0 against exactly the mutant this
    // test names in its title.
    const rig = bootCity('choose-stale-same-week')
    driveTo(rig, TICKS_PER_WEEK)
    const week1A = rig.s.header[H_OFFER_A] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, week1A))
    const tiles = rig.s.header[H_TILES] as number
    const upgrades = rig.s.header[H_INV_UPGRADES] as number
    driveTo(rig, TICKS_PER_WEEK + 10)
    expect(() =>
      step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, week1A)),
    ).not.toThrow()
    expect(rig.s.header[H_TILES], 'the stale choice was not paid a second time').toBe(tiles)
    expect(rig.s.header[H_INV_UPGRADES], 'nor granted its items a second time').toBe(upgrades)
  })

  it('a WRONG echo on an already-resolved week is a no-op too, which is the shape that separates the two orders', () => {
    // **Measured, and it corrects this task's brief.** The brief expected
    // "pending below the echo" to die in the stale-choice test — it does not, and
    // the reason is worth writing down: moving the check below the echo but above
    // the writes still refuses to pay twice, and a stale RIGHT echo still matches,
    // so that test cannot tell the two orders apart. Under the mutant it scored 0.
    //
    // The shape that does separate them is a stale WRONG echo: correct code sees
    // `offerPending` false and returns before the comparison exists; with the
    // check below, the comparison runs first and a resolved week THROWS on an
    // action it should have ignored. That is the "a double tap must not brick a
    // run" property in its strongest form — the tap that arrives late AND names
    // the card the player did not take.
    const rig = bootCity('choose-stale-wrong-echo')
    driveTo(rig, TICKS_PER_WEEK)
    const taken = rig.s.header[H_OFFER_A] as number
    const other = rig.s.header[H_OFFER_B] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, taken))
    const tiles = rig.s.header[H_TILES] as number
    const upgrades = rig.s.header[H_INV_UPGRADES] as number
    expect(offerPending(rig.s), 'the week really is resolved going in').toBe(false)
    expect(() =>
      step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, other)),
    ).not.toThrow()
    expect(rig.s.header[H_TILES], 'and nothing was paid for the card it names').toBe(tiles)
    expect(rig.s.header[H_INV_UPGRADES]).toBe(upgrades)
    expect(rig.s.header[H_EPOCH], 'the buffer is not poisoned').toBe(0)
  })

  it('THROWS on the boundary tick itself, because phase 3 runs BEFORE phase 4 raises the pair', () => {
    // **This is the `3 <-> 4` detector Task 5 recorded as an absence, and the
    // assertion is the one the RUN produces rather than the one the brief
    // predicted.** The brief's draft asserted a silent no-op followed by a
    // raised offer, reasoning that "phase 3 found nothing pending for week 1".
    // Derive it instead:
    //
    //   phase 1  tick 4,500, `H_WEEK` 0 -> 1
    //   phase 3  `offerPending` is `week > 0 && H_OFFER_WEEK !== week`
    //            = `1 > 0 && 0 !== 1` = **TRUE**. The week is pending the moment
    //            the clock advances; `H_OFFER_A` is what has not been written yet.
    //            The echo therefore compares the client's card against
    //            `CARD_NONE` and they cannot agree.
    //   -> THROW, before phase 4 ever runs.
    //
    // **That is correct behaviour and not a rough edge.** A client can only echo
    // a card it was shown, and it is shown one by the frame folded AFTER a tick;
    // week 1's pair does not exist until phase 4 of tick 4,500, so no honest log
    // can carry a `choose-card` on that tick. One that does is a divergent or
    // forged log and `unverifiable` is the right answer.
    //
    // **Under `3 <-> 4` — `runOffer` moved in front of the input loop — it does
    // NOT throw**: phase 4 raises week 1's pair first, the echo then matches, and
    // the choice resolves the week. That is the whole detector.
    const rig = bootCity('choose-on-the-boundary')
    driveTo(rig, TICKS_PER_WEEK - 1)
    expect(rig.s.header[H_WEEK], 'still week 0 going in').toBe(0)
    expect(rig.s.header[H_OFFER_A], 'and the slots are empty').toBe(CARD_NONE)
    // The offer for week 1 does not exist yet, so the client cannot have seen it
    // — computed here the way a REPLAY would, from the seed word and the week.
    const out = new Int32Array(2)
    drawOfferPair(poolFor(rig.world), offerSeedFor(rig.s, 1), out)
    expect(out[0], 'week 1 slot A is a real card, or the throw below is for the wrong reason').not.toBe(
      CARD_NONE,
    )
    expect(() =>
      step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, out[0] as number)),
    ).toThrow(/believed slot 0 held card \d+.*this simulation offered 0.*replay/s)
    // And the buffer is poisoned, which is what makes the Worker STOP rather
    // than score: `step` wrote `H_EPOCH` in phase 1 and threw in phase 3.
    expect(rig.s.header[H_EPOCH], 'the throw left the tick unfinished').toBe(TICKS_PER_WEEK)
  })

  it('FAILS CLOSED on a forged echo of CARD_NONE, through the grant table rather than a fourth guard', () => {
    // **The one input that reaches the echo and AGREES with an empty slot.** On
    // the first boundary tick `H_OFFER_A` is `CARD_NONE` and `offerPending` is
    // already true, so `choose-card(0, CARD_NONE)` passes the comparison. It
    // still throws — `cardTileGrant` is total over the OFFERABLE set and
    // `CARD_NONE` is not in it — and the message it throws is the pool-and-table
    // disagreement one, which is what a `CARD_NONE` in a slot the player is
    // choosing from actually IS.
    //
    // **No fourth guard was added for it, deliberately.** A `cardId ===
    // CARD_NONE` test in `applyChooseCard` would be independently sufficient
    // alongside the grant table's throw, and the catalogue's entry on that says
    // neither half could then have a detector. One mechanism, and this test so
    // the behaviour is pinned rather than accidental.
    const rig = bootCity('choose-forged-none')
    driveTo(rig, TICKS_PER_WEEK - 1)
    expect(rig.s.header[H_OFFER_A], 'the slot really is empty').toBe(CARD_NONE)
    expect(() =>
      step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, CARD_NONE)),
    ).toThrow(/card 0 has no tile grant/)
  })

  it('resolves the OLD pair when a choice arrives WITH a later boundary, and burns the new weeks offer', () => {
    // The second half of "phase 4 comes after phase 3", and the one that is a
    // real gameplay path rather than a forgery: week 1's offer is still up at
    // tick 8,999, the player taps, and the action lands on tick 9,000. Phase 3
    // sees `H_OFFER_A` still holding WEEK 1's pair, the echo matches, and the
    // card is paid — then `H_OFFER_WEEK` is 2, so phase 4 raises nothing and
    // week 2's offer never happens.
    //
    // **Recorded as the measured behaviour, not endorsed as a design.** M1f Task
    // 7 pauses the tick while an offer is pending, so the shell cannot cross a
    // boundary with one unresolved and this path is unreachable from the UI.
    // `sim` has no notion of pause and must still be total here.
    const rig = bootCity('choose-across-a-boundary')
    driveTo(rig, TICKS_PER_WEEK)
    const week1 = [rig.s.header[H_OFFER_A] as number, rig.s.header[H_OFFER_B] as number]
    driveTo(rig, TICKS_PER_WEEK * 2 - 1)
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, week1[0] as number))
    expect(rig.s.header[H_WEEK]).toBe(2)
    expect(rig.s.header[H_TILES], 'week 2s grant plus week 1s card').toBe(
      tiles + WEEKLY_TILE_GRANT + cardTileGrant(week1[0] as number),
    )
    expect(rig.s.header[H_OFFER_WEEK], 'week 2 is resolved by week 1s choice').toBe(2)
    expect(offerPending(rig.s)).toBe(false)
    expect(
      [rig.s.header[H_OFFER_A], rig.s.header[H_OFFER_B]],
      'and week 2s pair was never raised over the top of week 1s',
    ).toEqual(week1)
  })

  it('replays BYTE-IDENTICALLY through a snapshot and a restore into a COLD world', () => {
    // **The M3 property, exercised on this task's own bytes.** A `choose-card`
    // writes `H_TILES`, `H_INV_UPGRADES` and `H_OFFER_WEEK`; all three are inside
    // the hashed buffer, and this is the test that says a verifier rebuilding
    // `fields` and `scratch` from nothing reaches the same digest as the browser
    // that produced the log. The log is scripted by tick, exactly as M3's would
    // be, rather than applied by hand.
    const CHOOSE_AT = TICKS_PER_WEEK + 3
    const SNAP_AT = TICKS_PER_WEEK + 1
    const END_AT = TICKS_PER_WEEK * 2 + 50

    const hot = bootCity('choose-replay')
    driveTo(hot, SNAP_AT)
    const saved = snapshot(hot.s)
    // The card the ORIGINAL client saw. A replay reads it out of the log; it does
    // not recompute it, which is exactly why the echo can catch a divergence.
    const logged = hot.s.header[H_OFFER_A] as number
    const logFor = (tick: number): TickInputs => (tick === CHOOSE_AT ? chooseCard(OFFER_SLOT_A, logged) : NO_INPUT)
    for (let t = SNAP_AT; t < END_AT; t++) step(hot.s, hot.world, hot.fields, hot.scratch, logFor(t + 1))
    const expected = hashState(hot.s)
    expect(hot.s.header[H_OFFER_WEEK], 'the logged choice resolved week 1').toBe(1)
    expect(hot.s.header[H_WEEK], 'and the run carried on into week 2').toBe(2)

    // A Worker cold-starts with no fields and no scratch and only the buffer.
    const cold = bootCity('choose-replay-cold')
    const coldState = restore(saved, cold.world)
    for (let t = SNAP_AT; t < END_AT; t++) step(coldState, cold.world, cold.fields, cold.scratch, logFor(t + 1))
    expect(hashState(coldState), 'the cold replay diverged from the hot run').toBe(expected)

    // And a full re-run from tick 0 with the same log reaches it too, so the
    // digest is a property of (seed, map, log) and not of the snapshot.
    const fresh = bootCity('choose-replay')
    for (let t = 0; t < END_AT; t++) step(fresh.s, fresh.world, fresh.fields, fresh.scratch, logFor(t + 1))
    expect(hashState(fresh.s), 'a fresh run of the same log diverged').toBe(expected)
  })

  it('dispatches on the KIND: a choose-card is not fed to placeRoad', () => {
    // **The mutant is `step`'s third arm calling `placeRoad(s, world, a, b)`.**
    // On this 4x4 board `a = OFFER_SLOT_A = 0` and `b = CARD_ROAD_TILES = 1` are
    // two ADJACENT cells, so the mis-dispatch lays a real road and spends real
    // tiles rather than throwing — which is why it needs an assertion about
    // `roads` and not only about `H_TILES`. Nothing else in this file looks at
    // the road bits.
    const rig = bootCity('choose-not-a-road')
    driveTo(rig, TICKS_PER_WEEK)
    const card = rig.s.header[H_OFFER_A] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, card))
    for (let c = 0; c < CARDS_WORLD.cells; c++) {
      expect(rig.s.roads[c], `cell ${c} was paved by a choose-card`).toBe(0)
    }
    expect(rig.s.header[H_OFFER_WEEK], 'and the card was actually taken').toBe(1)
  })
})
