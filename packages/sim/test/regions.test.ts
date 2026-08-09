import { describe, it, expect } from 'vitest'
import { firstCity, CARS_PER_HOUSE } from '@laneways/shared'
import { computeLayout, type LayoutEntry } from '../src/layout'
import {
  regionsFor,
  FIELD_INPUT_REGIONS,
  FIELD_IRRELEVANT_REGIONS,
  isFieldInputRegion,
  isFieldIrrelevantRegion,
  createFieldInputRanges,
} from '../src/regions'
import { createState, type GameState } from '../src/state'
import { createWorld } from '../src/world'
import { hashFieldInputRegions } from '../src/flowfield'
import { createFlowFields, createScratch, CT_REBUILDS } from '../src/scratch'
import { step } from '../src/step'

/**
 * `regions.ts` declares the whole M1c buffer shape and the FIELD_INPUT /
 * FIELD_IRRELEVANT partition over it. This file proves three properties the
 * plan calls out explicitly:
 *
 *   - The partition is exhaustive and non-overlapping over the REAL region
 *     list, compared as sets (a harmless reorder of either array must not
 *     fail this).
 *   - The staleness hash is driven FROM the layout table, not from a
 *     hand-written sequence that classification and hashing could silently
 *     diverge from — proven by poking one byte in every single region and
 *     checking the hash moves iff that region is FIELD_INPUT.
 *   - The layout has zero padding for `firstCity`'s real sizes.
 */

const MAP = firstCity()

describe('regionsFor', () => {
  it('is exported — the union assertion below could not compile against a module-private function (fix-list #5)', () => {
    expect(typeof regionsFor).toBe('function')
  })

  it('has zero padding for firstCity (960 cells): totalBytes === sum(len * BYTES_PER_ELEMENT)', () => {
    const regions = regionsFor(MAP)
    const declaredBytes = regions.reduce((sum, r) => sum + r.len * r.ctor.BYTES_PER_ELEMENT, 0)
    const { totalBytes } = computeLayout(regions)
    expect(totalBytes).toBe(declaredBytes)
  })

  it('totals exactly 13,828 bytes for firstCity, per the plan\'s region table', () => {
    // M1c: 7,908 B over 22 regions. M1d Task 2 appended two `Int16` regions to
    // the end of the `Int16` tier — `occupancy` (2 x 960 cells = 1,920
    // elements, 3,840 B) and `carBlockedTicks` (maxCars = 80, 160 B) — for
    // 7,908 + 4,000 = 11,908. **M1d Task 5 appends the last two**, both `Uint8`
    // and both one per cell, to the end of the `Uint8` tier: `ghostMask` (960
    // B) and `ghostCommitted` (960 B), for 11,908 + 1,920 = **13,828** —
    // exactly the figure the plan's "Why exactly two re-blesses are true" table
    // predicts, and the milestone's final buffer size. No task after this one
    // changes it: Tasks 6 and 7 bless NEW goldens, which they could not do if
    // the shape were still moving.
    const { totalBytes } = computeLayout(regionsFor(MAP))
    expect(totalBytes).toBe(13828)
  })

  it('the two M1d Task 5 ghost regions have the exact element counts and byte sizes the plan predicts', () => {
    // Spelled out separately from the total for the same reason the Task 2 pair
    // is: a total is satisfied by any two regions summing to 1,920 B, including
    // one region of 1,920 cells (a per-LANE ghost, which the renderer could not
    // use) or a `Uint16` count (which would double the cost of a counter whose
    // whole point is that it fits in a byte).
    const byName = new Map(regionsFor(MAP).map((r) => [r.name, r]))
    const mask = byName.get('ghostMask')!
    const committed = byName.get('ghostCommitted')!
    expect(mask.ctor).toBe(Uint8Array)
    expect(mask.len).toBe(MAP.w * MAP.h)
    expect(mask.len * mask.ctor.BYTES_PER_ELEMENT).toBe(960)
    expect(committed.ctor).toBe(Uint8Array)
    expect(committed.len).toBe(MAP.w * MAP.h)
    expect(committed.len * committed.ctor.BYTES_PER_ELEMENT).toBe(960)
  })

  it('the two M1d Task 2 regions have the exact element counts and byte sizes the plan predicts', () => {
    // Spelled out separately from the total, because a total is satisfied by
    // any two regions that happen to sum to 4,000 B — including one of the
    // wrong element type or the wrong length, which is exactly what "Int16 vs
    // Uint8 for carBlockedTicks" and "one slot per cell vs two" both look like.
    const byName = new Map(regionsFor(MAP).map((r) => [r.name, r]))
    const occupancy = byName.get('occupancy')!
    const blocked = byName.get('carBlockedTicks')!
    expect(occupancy.ctor).toBe(Int16Array)
    expect(occupancy.len).toBe(2 * MAP.w * MAP.h)
    expect(occupancy.len * occupancy.ctor.BYTES_PER_ELEMENT).toBe(3840)
    expect(blocked.ctor).toBe(Int16Array)
    expect(blocked.len).toBe(CARS_PER_HOUSE * MAP.maxHouses)
    expect(blocked.len * blocked.ctor.BYTES_PER_ELEMENT).toBe(160)
  })

  it('declares exactly the 26 named regions the plan lists, no more and no fewer', () => {
    const names = regionsFor(MAP).map((r) => r.name)
    expect(names).toEqual([
      'rng',
      'mapIdentity',
      'header',
      'pinAccum',
      'rotationCursor',
      'houseCell',
      'destCell',
      'destSpawnTick',
      'carHome',
      'carCell',
      'carProgress',
      'carTargetDest',
      'carRouteLen',
      'carRouteCursor',
      'occupancy',
      'carBlockedTicks',
      'roads',
      'cleared',
      'houseColour',
      'destMeta',
      'destPins',
      'destReserved',
      'carPhase',
      'carRoute',
      'ghostMask',
      'ghostCommitted',
    ])
  })
})

describe('FIELD_INPUT / FIELD_IRRELEVANT partition', () => {
  it('is exhaustive and non-overlapping over regionsFor(firstCity()), compared as SETS', () => {
    // Sets, not arrays: a harmless reorder of either partition array (or of
    // regionsFor's declaration order) must not fail this — only a genuine
    // classification gap or overlap should.
    const declaredNames = new Set(regionsFor(MAP).map((r) => r.name))
    const inputNames = new Set<string>(FIELD_INPUT_REGIONS)
    const irrelevantNames = new Set<string>(FIELD_IRRELEVANT_REGIONS)

    for (const n of inputNames) {
      expect(irrelevantNames.has(n), `"${n}" is classified in BOTH partitions`).toBe(false)
    }

    const union = new Set<string>([...inputNames, ...irrelevantNames])
    expect(union).toEqual(declaredNames)
  })

  it('every classified name is a real declared region — a stale entry in either partition array would otherwise hide silently', () => {
    const declaredNames = new Set(regionsFor(MAP).map((r) => r.name))
    for (const n of FIELD_INPUT_REGIONS) {
      expect(declaredNames.has(n), `"${n}" (FIELD_INPUT) is not a declared region`).toBe(true)
    }
    for (const n of FIELD_IRRELEVANT_REGIONS) {
      expect(declaredNames.has(n), `"${n}" (FIELD_IRRELEVANT) is not a declared region`).toBe(true)
    }
  })

  it('isFieldInputRegion / isFieldIrrelevantRegion agree with the arrays they scan, and reject an unknown name', () => {
    for (const n of FIELD_INPUT_REGIONS) {
      expect(isFieldInputRegion(n)).toBe(true)
      expect(isFieldIrrelevantRegion(n)).toBe(false)
    }
    for (const n of FIELD_IRRELEVANT_REGIONS) {
      expect(isFieldIrrelevantRegion(n)).toBe(true)
      expect(isFieldInputRegion(n)).toBe(false)
    }
    expect(isFieldInputRegion('not-a-real-region')).toBe(false)
    expect(isFieldIrrelevantRegion('not-a-real-region')).toBe(false)
  })

  it('FIELD_INPUT_REGIONS is exactly {mapIdentity, destCell, roads, destMeta, destPins} — the plan\'s stated defence-in-depth set', () => {
    expect(new Set<string>(FIELD_INPUT_REGIONS)).toEqual(
      new Set(['mapIdentity', 'destCell', 'roads', 'destMeta', 'destPins']),
    )
  })

  it('both M1d Task 5 ghost regions are FIELD_IRRELEVANT, by name', () => {
    // The exact-set pin above fires if either is misclassified, but with a
    // message about a set. This one names the region and the reason, so a
    // failure points at Decision 4: the ghost's whole effect on routing is
    // already carried by `roads`, which is already FIELD_INPUT — `eraseRoad`
    // MOVES the bit rather than duplicating it, so `dist[ghostCell]` is INF
    // from the erase tick and hashing `ghostMask` would rebuild every colour a
    // second time for a change the `roads` hash has already seen.
    // `ghostCommitted` is worse again: it moves on car CROSSINGS.
    expect(isFieldIrrelevantRegion('ghostMask')).toBe(true)
    expect(isFieldInputRegion('ghostMask')).toBe(false)
    expect(isFieldIrrelevantRegion('ghostCommitted')).toBe(true)
    expect(isFieldInputRegion('ghostCommitted')).toBe(false)
  })

  it('both M1d Task 2 regions are FIELD_IRRELEVANT, by name', () => {
    // The exact-set pin above already fires if either is misclassified, but it
    // fires with a message about a set. This one names the region and the
    // reason, so a failure points at Decision 4 rather than at a diff of two
    // sets: occupancy changes on any tick any car crosses a cell, and
    // classifying it FIELD_INPUT costs five whole-board Dijkstras per tick
    // (5.7-9.6 ms) for byte-identical output. The behavioural half of that
    // claim — CT_REBUILDS staying put on a tick where a car crosses — is
    // asserted in `blocking.test.ts`, which is where the car fixture lives.
    expect(isFieldIrrelevantRegion('occupancy')).toBe(true)
    expect(isFieldInputRegion('occupancy')).toBe(false)
    expect(isFieldIrrelevantRegion('carBlockedTicks')).toBe(true)
    expect(isFieldInputRegion('carBlockedTicks')).toBe(false)
  })
})

describe('the staleness hash is driven from the layout table, not a hand-written sequence', () => {
  // Parameterised over every single declared region: for each one, poke one
  // byte and check `hashFieldInputRegions` moves iff that region is
  // FIELD_INPUT. This is the test that catches "classified FIELD_INPUT but
  // forgotten in the hash" (unreachable here BY CONSTRUCTION, since
  // `createFieldInputRanges` derives its ranges from `isFieldInputRegion`
  // directly — but this test is what would catch a regression back to a
  // hand-written `hashBytes(s.roads)`, `hashBytes(s.destPins)`, ... sequence
  // that silently omitted one).
  const world = createWorld(MAP)
  const ranges = createFieldInputRanges(MAP)
  const { entries } = computeLayout(regionsFor(MAP))

  function freshState(): GameState {
    return createState('regions-poke-seed', MAP)
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as LayoutEntry
    const isInput = isFieldInputRegion(e.name)
    const byteLength = e.len * e.ctor.BYTES_PER_ELEMENT

    // Three positions, not one (review Minor 1): poking only `e.offset`
    // proved nothing about the REST of a region's bytes — a hash that only
    // ever inspected each region's first byte (mutation A in the review)
    // left every one of these tests green when there was only a single
    // poke position per region. First, middle and last byte together prove
    // the whole declared byte range participates, not just its first word.
    const pokeOffsets = Array.from(
      new Set([e.offset, e.offset + ((byteLength - 1) >> 1), e.offset + byteLength - 1]),
    )

    it(`${e.name} (${isInput ? 'FIELD_INPUT' : 'FIELD_IRRELEVANT'}, ${byteLength} B): a poked byte at the first/middle/last position ${isInput ? 'moves' : 'does not move'} hashFieldInputRegions`, () => {
      expect(byteLength, `${e.name} has no bytes to poke`).toBeGreaterThan(0)

      for (const pokeOffset of pokeOffsets) {
        const s = freshState() // fresh per position: no cross-contamination between pokes
        const bytes = new Uint8Array(s.buffer)
        const before = hashFieldInputRegions(s, ranges)

        const beforeByte = bytes[pokeOffset] as number
        bytes[pokeOffset] = (beforeByte + 1) & 0xff

        // Vacuity self-check (fix-list #30): the poked byte must have
        // genuinely moved before asserting anything about its effect on the
        // hash — an aliased or out-of-range write would otherwise make
        // either branch below pass for the wrong reason.
        expect(bytes[pokeOffset], `${e.name}@${pokeOffset}: the poked byte did not actually change`).not.toBe(
          beforeByte,
        )

        const after = hashFieldInputRegions(s, ranges)
        if (isInput) {
          expect(after, `${e.name}@${pokeOffset} is FIELD_INPUT but the hash did not move`).not.toBe(before)
        } else {
          expect(after, `${e.name}@${pokeOffset} is FIELD_IRRELEVANT but the hash moved anyway`).toBe(before)
        }
      }
    })
  }

  it('world.cells sanity: every entry above actually belongs to the region list this test enumerates', () => {
    expect(entries.length).toBe(regionsFor(MAP).length)
    expect(world.cells).toBe(MAP.w * MAP.h)
  })
})

describe('createFieldInputRanges', () => {
  it('covers exactly the FIELD_INPUT regions by count and by total bytes', () => {
    const { entries } = computeLayout(regionsFor(MAP))
    const inputEntries = entries.filter((e) => isFieldInputRegion(e.name))
    const ranges = createFieldInputRanges(MAP)

    expect(ranges.length).toBe(inputEntries.length * 2) // one (offset, length) pair per input region
    expect(inputEntries.length).toBe(FIELD_INPUT_REGIONS.length)

    let totalFromRanges = 0
    for (let i = 1; i < ranges.length; i += 2) totalFromRanges += ranges[i] as number
    const totalFromEntries = inputEntries.reduce((sum, e) => sum + e.len * e.ctor.BYTES_PER_ELEMENT, 0)
    expect(totalFromRanges).toBe(totalFromEntries)
    expect(totalFromRanges).toBeGreaterThan(0) // vacuity: the input set is not empty
  })

  it('emits (offset, length) pairs matching each FIELD_INPUT region\'s real layout offset and byte length, in declaration order', () => {
    const { entries } = computeLayout(regionsFor(MAP))
    const inputEntries = entries.filter((e) => isFieldInputRegion(e.name))
    const ranges = createFieldInputRanges(MAP)
    for (let i = 0; i < inputEntries.length; i++) {
      const e = inputEntries[i] as LayoutEntry
      expect(ranges[i * 2], `${e.name} offset`).toBe(e.offset)
      expect(ranges[i * 2 + 1], `${e.name} length`).toBe(e.len * e.ctor.BYTES_PER_ELEMENT)
    }
  })

  it('is an Int32Array', () => {
    expect(createFieldInputRanges(MAP)).toBeInstanceOf(Int32Array)
  })
})

describe('fieldInputRanges is built once, not recomputed per tick', () => {
  it('the same Scratch.fieldInputRanges reference survives many step() calls unchanged', () => {
    // A partial proxy for "nothing allocates inside a tick": it fails if
    // `scratch.fieldInputRanges` is ever REASSIGNED to a freshly-built
    // array, which is the shape a naive "just recompute it every tick"
    // mistake would take at the call site that owns `scratch`. It does NOT
    // by itself prove `syncFields`/`fieldFor` actually CONSULT that table —
    // see the next test, added on review (Important 1), for that.
    const world = createWorld(MAP)
    const state = createState('ranges-identity-seed', MAP)
    const fields = createFlowFields(MAP.groupCount, world.cells)
    const ranges = createFieldInputRanges(MAP)
    const scratch = createScratch(world.cells, MAP.groupCount, MAP.maxDestinations, ranges)
    for (let i = 0; i < 50; i++) step(state, world, fields, scratch, { actions: [] })
    expect(scratch.fieldInputRanges).toBe(ranges)
  })

  it('a doctored ranges table (missing "roads") is what syncFields actually consults — proves the table is read, not merely held', () => {
    // Review Important 1: the prior disclosed gap ("recomputing
    // createFieldInputRanges per call is byte-identical, so this needs an
    // allocation harness to test") was wrong about WHY it passes. The
    // observable difference between "consult scratch.fieldInputRanges" and
    // "silently recompute the real table every call" is not the allocation
    // — it is WHICH table gets consulted. Hand `createScratch` a table that
    // covers only `mapIdentity` (deliberately omitting `roads`), place a
    // road, and the coalescing test becomes directly falsifiable: against
    // real code CT_REBUILDS must NOT move (roads isn't in the doctored
    // table, so a road edit is invisible to the field-input hash); against
    // a mutation that recomputes the real, full table instead, `roads`
    // WOULD be seen and CT_REBUILDS moves.
    const world = createWorld(MAP)
    const state = createState('doctored-ranges-seed', MAP)
    const fields = createFlowFields(MAP.groupCount, world.cells)
    const mapIdentityEntry = computeLayout(regionsFor(MAP)).entries.find((e) => e.name === 'mapIdentity')!
    const doctored = Int32Array.from([
      mapIdentityEntry.offset,
      mapIdentityEntry.len * mapIdentityEntry.ctor.BYTES_PER_ELEMENT,
    ]) // mapIdentity only; roads deliberately absent
    const scratch = createScratch(world.cells, MAP.groupCount, MAP.maxDestinations, doctored)

    step(state, world, fields, scratch, { actions: [] }) // first tick: every stamp is 0, everything rebuilds
    const afterFirst = scratch.counters[CT_REBUILDS] as number
    expect(afterFirst).toBeGreaterThan(0) // vacuity: the first tick genuinely rebuilt something

    step(state, world, fields, scratch, { actions: [{ kind: 'place', a: 0, b: 1 }] })
    expect(state.roads[0]).not.toBe(0) // vacuity: the road really was placed
    expect(scratch.counters[CT_REBUILDS]).toBe(afterFirst) // roads isn't in the doctored table: invisible to the hash
  })
})
