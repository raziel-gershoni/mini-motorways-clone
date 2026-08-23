import { describe, it, expect } from 'vitest'
import { firstCity } from '@laneways/shared'
import {
  CARD_BRIDGE,
  CARD_COUNT,
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
  popCountCards,
} from '../src/cards'
import { mixWord } from '../src/rng'
import { createState } from '../src/state'

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
    const s = createState('laneways-m2', firstCity())
    expect(Number.isInteger(offerSeedFor(s, 0))).toBe(true)
    expect(offerSeedFor(s, 0)).toBeGreaterThanOrEqual(0)
    expect(offerSeedFor(s, 0)).toBeLessThanOrEqual(0xffffffff)
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
