import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  PIN_CAP_SQUARE_TIMER,
  TICKS_PER_WEEK,
  WEEKLY_TILE_GRANT,
  firstCity,
  parseMap,
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
  canDrawOfferPair,
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
import { placeDestination, DEST_KIND_SQUARE, ORIENTATION_S } from '../src/buildings'

const NO_INPUT: TickInputs = { actions: [] }

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
    // Measured over four seeds x 40 week-pairs: the real function scores
    // min 10 / mean 15.85 and the BARE XOR scores min 13 / mean 16.80 — the
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

  it('throws on a NEGATIVE k too, which is the only place seen === k and seen >= k differ', () => {
    // **Added from a mutation result, and the enumeration is why it is here.**
    // `seen === k` -> `seen >= k` scored 0 detectors over the whole 1,995-test
    // suite. It is not equivalent, though: swept over all 256 masks and k in
    // [-8, 12), the two disagree on **2,040 cases, every one of them at k < 0,
    // and on ZERO cases at k >= 0**. `drawOfferPair` never produces a negative
    // k and the exhaustive agreement test above only walks [0, popcount), so
    // the difference sat entirely outside every fixture.
    //
    // It is worth closing rather than recording, because of what the mutant
    // RETURNS: `nthSetBit(mask, -1)` under `seen >= k` hands back the first set
    // bit — a perfectly plausible card id — where the contract is a throw. That
    // is the catalogue's `Int32Array` pointer-id shape: an out-of-contract input
    // must not be able to return a believable answer, however unreachable it
    // looks from today's callers.
    expect(() => nthSetBit(0b0110, -1)).toThrow(/asked for set bit -1/)
    expect(() => nthSetBit(0xff, -3)).toThrow(/asked for set bit -3/)
    // And a non-integer, for the same reason: `seen === 1.5` is never true, so
    // the loop falls through to the throw, which is the right answer — pinned
    // so a future `>=` rewrite cannot quietly return bit 1.
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
    // `capabilityMask`'s map-only inputs (M1f Task 11). The previous draft had
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
    // Task 11 gives `poolFor` its capability half and the signature does not
    // change. What must hold in BOTH versions is asserted here rather than in
    // Task 11: the result is a `CARD_COUNT`-bit mask (so `nthSetBit` is total on
    // it) and it holds at least two cards (so `runOffer` never degrades on a
    // shipped board). Both are properties of the contract, not of today's body.
    for (const map of [firstCity(), CARDS_MAP]) {
      const pool = poolFor(createWorld(map))
      expect(pool, `pool ${pool} is inside the CARD_COUNT-bit domain`).toBeGreaterThanOrEqual(0)
      expect(pool).toBeLessThan(1 << CARD_COUNT)
      expect(canDrawOfferPair(pool), `${map.id} can offer a pair`).toBe(true)
      expect((pool & 1) === 0, 'bit 0 is CARD_NONE and must never be set').toBe(true)
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
    // pool, including the ones Task 11's capability filter has not been written
    // yet to produce.
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

  it('runOffer cannot reach drawOfferPair except through the welded guard', () => {
    // A source scan, on the precedent of `step.test.ts`'s tick-order tripwire
    // and `loop.test.ts`'s cross-file golden scan: the property is "this call
    // site cannot be written a second way", which has nothing to observe at run
    // time. The lookbehind is what makes it see `drawOfferPair(` and not the
    // `drawOfferPair(` inside `tryDrawOfferPair(`.
    const src = readFileSync(new URL('../src/cards.ts', import.meta.url), 'utf8')
    expect(src.length, 'cards.ts read back empty').toBeGreaterThan(4000)
    const body = src.slice(src.indexOf('export function runOfferFromPool'))
    expect(body.length, 'runOfferFromPool is no longer the last declaration in cards.ts').toBeGreaterThan(200)
    expect(
      body,
      'runOffer now calls drawOfferPair directly — that throw is unguarded inside step, after ' +
        'H_EPOCH is written, and poisons the buffer permanently. Call tryDrawOfferPair.',
    ).not.toMatch(/(?<![A-Za-z])drawOfferPair\(/)
    // Self-check: the pattern must actually match the thing it is banning, or
    // the guard is a regex that can never fire.
    expect('  drawOfferPair(pool, seed, out)').toMatch(/(?<![A-Za-z])drawOfferPair\(/)
    expect('  tryDrawOfferPair(pool, seed, out)').not.toMatch(/(?<![A-Za-z])drawOfferPair\(/)
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

  it('writes H_TILES never, so phases 2 and 4 are disjoint by construction', () => {
    const rig = bootCity('offer-disjoint')
    driveTo(rig, TICKS_PER_WEEK - 1)
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_TILES], 'the boundary granted exactly the weekly tiles').toBe(
      tiles + WEEKLY_TILE_GRANT,
    )
  })
})
